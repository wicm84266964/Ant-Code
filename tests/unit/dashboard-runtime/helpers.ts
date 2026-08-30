import assert from "node:assert/strict";
import nodeFs from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAgentTaskGroupStore } from "../../../src/agents/task-group-store.ts";
import { createAgentTaskStore } from "../../../src/agents/task-store.ts";
import { registerBackgroundTerminalTask } from "../../../src/agents/background-terminal-registry.ts";
import { createFileRepository } from "../../../src/config-v2/file-repository.ts";
import { createCredentialStore } from "../../../src/credentials/store.ts";
import { withConfigMutationLock } from "../../../src/dashboard/config-store.ts";
import { createDashboardRuntime } from "../../../src/dashboard/sessions.ts";
import { createSessionStore } from "../../../src/storage/session-store.ts";


export async function waitForEvent(runtime, sessionId, predicate, timeoutMs = 5000) {
  const existing = runtime.listActiveEvents(sessionId);
  if (existing.some(predicate)) {
    return existing;
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe?.();
      reject(new Error("Timed out waiting for dashboard event"));
    }, timeoutMs);
    let unsubscribe;
    unsubscribe = runtime.subscribe(sessionId, (event) => {
      if (predicate(event)) {
        clearTimeout(timeout);
        unsubscribe?.();
        resolve(runtime.listActiveEvents(sessionId));
      }
    });
  });
}

export async function waitForCondition(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for dashboard condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export function cleanupAbortError() {
  const error = new Error("test-cleanup");
  error.name = "AbortError";
  return error;
}

export function transcriptText(message) {
  if (typeof message?.content === "string") {
    return message.content;
  }
  if (!Array.isArray(message?.content)) {
    return "";
  }
  return message.content.map((item) => item?.text ?? "").join("");
}

export function requestMessageText(message) {
  if (typeof message?.content === "string") {
    return message.content;
  }
  if (!Array.isArray(message?.content)) {
    return "";
  }
  return message.content.map((item) => {
    if (typeof item === "string") {
      return item;
    }
    if (item && typeof item === "object" && "text" in item) {
      return String(item.text ?? "");
    }
    return "";
  }).join("");
}

export function createGateway(text, options = {}) {
  return http.createServer(async (req, res) => {
    for await (const _ of req) {
      // Drain request body.
    }
    if ((Array.isArray(options.thinkingChunks) && options.thinkingChunks.length > 0)
      || (Array.isArray(options.textChunks) && options.textChunks.length > 0)) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ type: "message_start", id: "mock-dashboard-stream", model: "mock-model" })}\n\n`);
      for (const chunk of options.thinkingChunks ?? []) {
        res.write(`data: ${JSON.stringify({ type: "thinking_delta", text: chunk })}\n\n`);
      }
      const textChunks = Array.isArray(options.textChunks) && options.textChunks.length > 0
        ? options.textChunks
        : [text];
      for (const chunk of textChunks) {
        res.write(`data: ${JSON.stringify({ type: "text_delta", text: chunk })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ type: "message_stop", stopReason: "stop" })}\n\n`);
      return res.end();
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "mock-dashboard-response",
      model: "mock-model",
      content: [{ type: "text", text }],
      toolCalls: [],
      stopReason: "stop"
    }));
  });
}

export async function readDashboardRequestJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += Buffer.from(chunk).toString("utf8");
  }
  return body ? JSON.parse(body) : {};
}

export function createRecordingGateway(requests, text) {
  return http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) {
      body += Buffer.from(chunk).toString("utf8");
    }
    requests.push(JSON.parse(body));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: `recording-${requests.length}`,
      model: "mock-model",
      content: [{ type: "text", text }],
      toolCalls: [],
      stopReason: "stop"
    }));
  });
}

export function createHeaderRecordingGateway(requests, text) {
  return http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) {
      body += Buffer.from(chunk).toString("utf8");
    }
    requests.push({
      authorization: req.headers.authorization ?? "",
      body: JSON.parse(body)
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: `header-recording-${requests.length}`,
      model: "new-model",
      content: [{ type: "text", text }],
      toolCalls: [],
      stopReason: "stop"
    }));
  });
}

export function createSequenceGateway(responses) {
  let index = 0;
  return http.createServer(async (req, res) => {
    for await (const _chunk of req) {
      // Drain request body.
    }
    const response = responses[Math.min(index, responses.length - 1)] ?? {};
    index += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: `tool-gateway-${index}`,
      model: "mock-model",
      content: [{ type: "text", text: response.content ?? "" }],
      toolCalls: response.toolCalls ?? [],
      stopReason: response.stopReason ?? "stop"
    }));
  });
}

export function createAuthRecordingGateway(requests, text, validKey) {
  return http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) {
      body += Buffer.from(chunk).toString("utf8");
    }
    requests.push({
      authorization: req.headers.authorization ?? "",
      body: JSON.parse(body)
    });
    if (req.headers.authorization !== `Bearer ${validKey}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({
        error: {
          message: "Invalid API Key",
          type: "invalid_key",
          code: "401"
        }
      }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: `auth-recording-${requests.length}`,
      model: "mock-model",
      content: [{ type: "text", text }],
      toolCalls: [],
      stopReason: "stop"
    }));
  });
}

export function createOpenAIChatAuthRecordingGateway(requests, text, validKey) {
  return http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) {
      body += Buffer.from(chunk).toString("utf8");
    }
    requests.push({
      url: req.url,
      authorization: req.headers.authorization ?? "",
      body: JSON.parse(body)
    });
    if (req.headers.authorization !== `Bearer ${validKey}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({
        error: {
          message: "Invalid API Key",
          type: "invalid_key",
          code: "401"
        }
      }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: `chat-auth-recording-${requests.length}`,
      model: String(requests.at(-1)?.body?.model ?? "mock-model"),
      choices: [{
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop"
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    }));
  });
}

export function createDelayedGateway(texts, delayMs, options = {}) {
  let calls = 0;
  return http.createServer(async (req, res) => {
    for await (const _ of req) {
      // Drain request body.
    }
    options.onRequest?.(calls + 1);
    const text = texts[Math.min(calls, texts.length - 1)];
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: `delayed-${calls}`,
      model: "mock-model",
      content: [{ type: "text", text }],
      toolCalls: [],
      stopReason: "stop"
    }));
  });
}

export function createFailingGateway() {
  return http.createServer(async (req, res) => {
    for await (const _ of req) {
      // Drain request body.
    }
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "mock gateway failure" }));
  });
}

export function createRepeatedReadGateway() {
  let calls = 0;
  return http.createServer(async (req, res) => {
    for await (const _ of req) {
      // Drain request body.
    }
    calls += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: `dashboard-tool-limit-${calls}`,
      model: "mock-model",
      content: [],
      toolCalls: [{
        id: `dashboard-read-${calls}`,
        name: "read_file",
        input: { path: "notes.txt", maxBytes: 1024 }
      }],
      stopReason: "tool_calls"
    }));
  });
}

export function createHangingStreamGateway() {
  return http.createServer(async (req, res) => {
    for await (const _ of req) {
      // Drain request body.
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ type: "message_start", id: "hanging", model: "mock-model" })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "text_delta", text: "partial draft" })}\n\n`);
  });
}

export function createBackgroundWakeGateway(requests) {
  return http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) {
      raw += Buffer.from(chunk).toString("utf8");
    }
    const body = JSON.parse(raw || "{}");
    requests.push(body);
    res.writeHead(200, { "content-type": "application/json" });

    const sessionId = String(body.metadata?.sessionId ?? body.sessionId ?? "");
    if (sessionId.startsWith("agent-explorer-")) {
      res.end(JSON.stringify({
        id: "dashboard-background-child-final",
        model: "mock-model",
        content: [{ type: "text", text: "dashboard background child done" }],
        toolCalls: [],
        stopReason: "stop"
      }));
      return;
    }

    const parentCalls = requests.filter((item) => !String(item.sessionId ?? "").startsWith("agent-explorer-")).length;
    if (parentCalls === 1) {
      res.end(JSON.stringify({
        id: "dashboard-background-agent-run",
        model: "mock-model",
        content: [],
        toolCalls: [
          {
            id: "delegate-dashboard-background",
            name: "agent_run",
            input: {
              profile: "explorer",
              query: "inspect current workspace in background",
              background: true,
              groupId: "group-dashboard-bg",
              waitForGroup: "all",
              wakeParent: true
            }
          }
        ],
        stopReason: "tool_calls"
      }));
      return;
    }

    const lastMessage = body.messages?.at(-1)?.content ?? "";
    res.end(JSON.stringify({
      id: "dashboard-background-parent-final",
      model: "mock-model",
      content: [{ type: "text", text: /Ant Code subagent group completed/.test(String(lastMessage)) ? "parent consumed wake prompt" : "parent did not receive wake prompt" }],
      toolCalls: [],
      stopReason: "stop"
    }));
  });
}

export function createQueueFullBackgroundWakeGateway(requests, firstParentGate, finishParentGate) {
  return http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) {
      raw += Buffer.from(chunk).toString("utf8");
    }
    const body = JSON.parse(raw || "{}");
    requests.push(body);
    const sessionId = String(body.metadata?.sessionId ?? body.sessionId ?? "");
    if (sessionId.startsWith("agent-explorer-")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "dashboard-queue-full-child-final",
        model: "mock-model",
        content: [{ type: "text", text: "queue full child done" }],
        toolCalls: [],
        stopReason: "stop"
      }));
      return;
    }

    const parentCalls = requests.filter((item) => !String(item.sessionId ?? "").startsWith("agent-explorer-")).length;
    if (parentCalls === 1) {
      await firstParentGate;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "dashboard-queue-full-agent-run",
        model: "mock-model",
        content: [],
        toolCalls: [{
          id: "delegate-dashboard-queue-full",
          name: "agent_run",
          input: {
            profile: "explorer",
            query: "finish while parent queue is full",
            background: true,
            groupId: "group-dashboard-queue-full",
            waitForGroup: "all",
            wakeParent: true
          }
        }],
        stopReason: "tool_calls"
      }));
      return;
    }

    await finishParentGate;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "dashboard-queue-full-parent-final",
      model: "mock-model",
      content: [{ type: "text", text: "parent finished without consuming overflow wake" }],
      toolCalls: [],
      stopReason: "stop"
    }));
  });
}

export function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

export function createBackgroundAnyWakeGateway(requests) {
  return http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) {
      raw += Buffer.from(chunk).toString("utf8");
    }
    const body = JSON.parse(raw || "{}");
    requests.push(body);
    res.writeHead(200, { "content-type": "application/json" });

    const sessionId = String(body.metadata?.sessionId ?? body.sessionId ?? "");
    if (sessionId.startsWith("agent-explorer-")) {
      const slow = /slow sibling/.test(JSON.stringify(body.messages ?? []));
      if (slow) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      const text = slow ? "slow sibling done later" : "fast sibling done";
      res.end(JSON.stringify({
        id: `dashboard-background-any-${requests.length}`,
        model: "mock-model",
        content: [{ type: "text", text }],
        toolCalls: [],
        stopReason: "stop"
      }));
      return;
    }

    const parentCalls = requests.filter((item) => !String(item.sessionId ?? "").startsWith("agent-explorer-")).length;
    if (parentCalls === 1) {
      res.end(JSON.stringify({
        id: "dashboard-background-any-agent-run",
        model: "mock-model",
        content: [],
        toolCalls: [
          {
            id: "delegate-dashboard-any-fast",
            name: "agent_run",
            input: {
              profile: "explorer",
              query: "fast sibling",
              background: true,
              groupId: "group-dashboard-any",
              waitForGroup: "any",
              wakeParent: true
            }
          },
          {
            id: "delegate-dashboard-any-slow",
            name: "agent_run",
            input: {
              profile: "explorer",
              query: "slow sibling",
              background: true,
              groupId: "group-dashboard-any",
              waitForGroup: "any",
              wakeParent: true
            }
          }
        ],
        stopReason: "tool_calls"
      }));
      return;
    }

    const lastMessage = body.messages?.at(-1)?.content ?? "";
    res.end(JSON.stringify({
      id: "dashboard-background-any-parent-final",
      model: "mock-model",
      content: [{ type: "text", text: /Ant Code subagent group completed/.test(String(lastMessage)) ? "parent consumed any wake prompt" : "parent missed any wake prompt" }],
      toolCalls: [],
      stopReason: "stop"
    }));
  });
}

export function createToolGateway() {
  let calls = 0;
  return http.createServer(async (req, res) => {
    for await (const _ of req) {
      // Drain request body.
    }
    calls += 1;
    res.writeHead(200, { "content-type": "application/json" });
    if (calls === 1) {
      res.end(JSON.stringify({
        id: "tool-request",
        model: "mock-model",
        content: [],
        toolCalls: [
          {
            id: "write-1",
            name: "write_file",
            input: {
              path: "denied.md",
              content: "should not be written"
            }
          }
        ],
        stopReason: "tool_calls"
      }));
      return;
    }
    res.end(JSON.stringify({
      id: "final-after-deny",
      model: "mock-model",
      content: [{ type: "text", text: "write was denied" }],
      toolCalls: [],
      stopReason: "stop"
    }));
  });
}

export function createWriteGateway() {
  let calls = 0;
  return http.createServer(async (req, res) => {
    for await (const _ of req) {
      // Drain request body.
    }
    calls += 1;
    res.writeHead(200, { "content-type": "application/json" });
    if (calls === 1) {
      res.end(JSON.stringify({
        id: "write-request",
        model: "mock-model",
        content: [],
        toolCalls: [
          {
            id: "write-1",
            name: "write_file",
            input: {
              path: "created.md",
              content: "alpha\nbeta"
            }
          }
        ],
        stopReason: "tool_calls"
      }));
      return;
    }
    res.end(JSON.stringify({
      id: "write-final",
      model: "mock-model",
      content: [{ type: "text", text: "write complete" }],
      toolCalls: [],
      stopReason: "stop"
    }));
  });
}

export function createRepeatedEditGateway() {
  let calls = 0;
  return http.createServer(async (req, res) => {
    for await (const _ of req) {
      // Drain request body.
    }
    calls += 1;
    res.writeHead(200, { "content-type": "application/json" });
    if (calls === 1) {
      res.end(JSON.stringify({
        id: "edit-request-1",
        model: "mock-model",
        content: [],
        toolCalls: [
          {
            id: "edit-1",
            name: "edit_file",
            input: {
              path: "notes.md",
              oldText: "beta",
              newText: "delta"
            }
          }
        ],
        stopReason: "tool_calls"
      }));
      return;
    }
    if (calls === 2) {
      res.end(JSON.stringify({
        id: "edit-request-2",
        model: "mock-model",
        content: [],
        toolCalls: [
          {
            id: "edit-2",
            name: "edit_file",
            input: {
              path: "notes.md",
              oldText: "gamma",
              newText: "omega"
            }
          }
        ],
        stopReason: "tool_calls"
      }));
      return;
    }
    res.end(JSON.stringify({
      id: "edit-final",
      model: "mock-model",
      content: [{ type: "text", text: "edits complete" }],
      toolCalls: [],
      stopReason: "stop"
    }));
  });
}

export function createTodoGateway() {
  let calls = 0;
  return http.createServer(async (req, res) => {
    for await (const _ of req) {
      // Drain request body.
    }
    calls += 1;
    res.writeHead(200, { "content-type": "application/json" });
    if (calls === 1) {
      res.end(JSON.stringify({
        id: "todo-request",
        model: "mock-model",
        content: [],
        toolCalls: [
          {
            id: "todo-1",
            name: "todo_write",
            input: {
              items: [
                { content: "确认需求", status: "进行中" },
                { content: "汇总结果", status: "待办" }
              ]
            }
          }
        ],
        stopReason: "tool_calls"
      }));
      return;
    }
    res.end(JSON.stringify({
      id: "todo-final",
      model: "mock-model",
      content: [{ type: "text", text: "全部待办已完成。" }],
      toolCalls: [],
      stopReason: "stop"
    }));
  });
}

export function createHangingGateway() {
  return http.createServer(async (req, res) => {
    for await (const _ of req) {
      // Drain request body, then deliberately never complete the response.
    }
    res.writeHead(200, { "content-type": "application/json" });
  });
}

export function createQuestionGateway() {
  let calls = 0;
  return http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) {
      body += Buffer.from(chunk).toString("utf8");
    }
    calls += 1;
    res.writeHead(200, { "content-type": "application/json" });
    if (calls === 1) {
      res.end(JSON.stringify({
        id: "question-request",
        model: "mock-model",
        content: [],
        toolCalls: [
          {
            id: "question-1",
            name: "ask_user",
            input: {
              header: "需求核对",
              question: "输出格式选哪种？",
              choices: [
                { label: "Markdown", value: "md", description: "生成可直接阅读的 Markdown" },
                { label: "PDF", value: "pdf" }
              ],
              multiple: true,
              allowCustom: true,
              confirmLabel: "继续"
            }
          }
        ],
        stopReason: "tool_calls"
      }));
      return;
    }

    const parsed = JSON.parse(body);
    const toolResults = parsed.toolResults ?? [];
    const answerText = JSON.stringify(toolResults);
    const cancelled = toolResults.some((result) => {
      try {
        return JSON.parse(result.content)?.result?.cancelled === true;
      } catch {
        return false;
      }
    });
    res.end(JSON.stringify({
      id: "question-final",
      model: "mock-model",
      content: [{
        type: "text",
        text: cancelled
          ? "已取消需求核对。"
          : `已按 Markdown 继续，并保留图表说明。${answerText.includes("workflowReminder") ? " 已收到 workflow 提醒。" : ""}`
      }],
      toolCalls: [],
      stopReason: "stop"
    }));
  });
}

export function listen(server, host, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}

export function close(server) {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(resolve);
  });
}

export function mockGatewayEnv(server, extra = {}) {
  const address = server.address();
  const env = {
    LAB_MODEL_GATEWAY_URL: `http://127.0.0.1:${address.port}`,
    LAB_MODEL_GATEWAY_PROTOCOL: "lab-agent-gateway",
    LAB_MODEL_GATEWAY_MAX_RETRIES: "0",
    ...extra
  };
  if (!env.USERPROFILE && !env.HOME) {
    const home = nodeFs.mkdtempSync(path.join(os.tmpdir(), "dashboard-runtime-home-"));
    env.HOME = home;
    env.USERPROFILE = home;
  } else {
    env.HOME = env.HOME || env.USERPROFILE;
    env.USERPROFILE = env.USERPROFILE || env.HOME;
  }
  return env;
}

export async function assertGlobalSavePreservesProjectProjection(projectProjection) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-project-projection-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-home-project-projection-"));
  const globalPath = path.join(home, ".ant-code", "lab-agent.config.json");
  const localPath = path.join(cwd, ".lab-agent", "config.json");
  const gatewayUrl = "https://project-projection.gateway.example/v1/responses";
  const profileId = "project-projection-profile";
  const profile = {
    id: profileId,
    gatewayUrl,
    gatewayProtocol: "openai-responses",
    modelAlias: "shared-model",
    models: [
      { id: "shared-model", reasoningEfforts: ["high"] },
      { id: "project-strong" },
      { id: "project-vision", modalities: ["text", "image"] }
    ]
  };
  const global = {
    modelAlias: profile.modelAlias,
    models: profile.models,
    lab: {
      gatewayUrl,
      gatewayProtocol: "openai-responses",
      activeGatewayProfile: profileId,
      gatewayProfiles: [profile]
    }
  };
  const project = {
    ...(projectProjection.agents ? { agents: projectProjection.agents } : {}),
    lab: {
      activeGatewayProfile: profileId,
      gatewayProfiles: [profile],
      ...(projectProjection.lab ?? {})
    }
  };

  await fs.mkdir(path.dirname(globalPath), { recursive: true });
  await fs.writeFile(globalPath, JSON.stringify(global), "utf8");
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, JSON.stringify(project), "utf8");
  const before = await fs.readFile(localPath, "utf8");

  const saved = await createDashboardRuntime({ cwd, env: { USERPROFILE: home } }).saveModelConfig({
    saveTarget: "global",
    gatewayUrl,
    gatewayProtocol: "openai-responses",
    modelId: "shared-model",
    reasoningEfforts: ["high", "max"],
    defaultReasoningEffort: "max",
    switchToModel: false
  });

  assert.equal(saved.ok, true, `${saved.status}: ${saved.error}`);
  assert.equal(await fs.readFile(localPath, "utf8"), before);
  const storedGlobal = JSON.parse(await fs.readFile(globalPath, "utf8"));
  const storedModel = storedGlobal.lab.gatewayProfiles[0].models
    .find((model) => model.id === "shared-model");
  assert.deepEqual(storedModel.reasoningEfforts.map((effort) => effort.id ?? effort), ["high", "max"]);
  assert.equal(storedModel.defaultReasoningEffort, "max");
}
