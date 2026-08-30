import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSession, persistSessionSnapshot, runSessionTurn } from "../../src/core/session.ts";
import { createSessionStore } from "../../src/storage/session-store.ts";

export function createRecordingGateway(requests: Array<Record<string, unknown>>) {
  return http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      return;
    }

    const body = await readRequestJson(request);
    requests.push(body);
    response.writeHead(200, { "content-type": "application/json" });
    if (body.messages?.some((message) => String(message.content?.[0]?.text ?? "").includes("context compactor"))) {
      response.end(JSON.stringify({
        id: `mock-compact-${requests.length}`,
        model: body.model,
        content: [{ type: "text", text: "Model compacted summary: first turn and second turn are retained as safe background." }],
        toolCalls: [],
        stopReason: "stop"
      }));
      return;
    }
    response.end(JSON.stringify({
      id: `mock-${requests.length}`,
      model: body.model,
      content: [{ type: "text", text: `assistant ${requests.length}` }],
      toolCalls: [],
      stopReason: "stop"
    }));
  });
}

export function messageText(message = {}) {
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((item) => typeof item === "string" ? item : String(item?.text ?? "")).join("");
  }
  return "";
}

/**
 * @param {Array<Record<string, any>>} requests
 */
export function createToolGateway(requests: Array<Record<string, unknown>>) {
  return http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      return;
    }

    const body = await readRequestJson(request);
    requests.push(body);
    response.writeHead(200, { "content-type": "application/json" });

    if (requests.length === 1) {
      response.end(JSON.stringify({
        id: "mock-tool-call",
        model: body.model,
        content: [],
        toolCalls: [
          {
            id: "read-notes",
            name: "read_file",
            input: { path: "notes.txt", maxBytes: 1024 }
          }
        ],
        stopReason: "tool_calls"
      }));
      return;
    }

    response.end(JSON.stringify({
      id: "mock-final",
      model: body.model,
      content: [{ type: "text", text: "read notes done" }],
      toolCalls: [],
      stopReason: "stop"
    }));
  });
}

/**
 * @param {Array<Record<string, any>>} requests
 */
export function createLargeToolThenFinalGateway(requests: Array<Record<string, unknown>>) {
  return http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      return;
    }

    const body = await readRequestJson(request);
    requests.push(body);
    response.writeHead(200, { "content-type": "application/json" });

    if (requests.length === 1) {
      response.end(JSON.stringify({
        id: "mock-large-tool-call",
        model: body.model,
        content: [],
        toolCalls: [
          {
            id: "read-large",
            name: "read_file",
            input: { path: "large.txt", maxBytes: 24000 }
          }
        ],
        stopReason: "tool_calls"
      }));
      return;
    }

    response.end(JSON.stringify({
      id: "mock-large-final",
      model: body.model,
      content: [{ type: "text", text: "large result consumed" }],
      toolCalls: [],
      stopReason: "stop"
    }));
  });
}

/**
 * @param {Array<Record<string, any>>} requests
 */
export function createMalformedThenHealthyGateway(requests: Array<Record<string, unknown>>) {
  return http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      return;
    }

    const body = await readRequestJson(request);
    requests.push(body);
    response.writeHead(200, { "content-type": "application/json" });

    if (requests.length === 1) {
      response.end(JSON.stringify({
        id: "mock-malformed-final",
        model: body.model,
        content: [{ type: "text", text: "Ver" }],
        thinking: "The verifier found one remaining issue and should now summarize it for the user.",
        toolCalls: [],
        stopReason: "stop"
      }));
      return;
    }

    response.end(JSON.stringify({
      id: "mock-healthy-final",
      model: body.model,
      content: [{ type: "text", text: "复核完成：没有发现新的阻塞问题。" }],
      toolCalls: [],
      stopReason: "stop"
    }));
  });
}

/**
 * @param {Array<Record<string, any>>} requests
 */
export function createReasoningOnlyLengthThenHealthyGateway(requests: Array<Record<string, unknown>>) {
  return http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      return;
    }

    const body = await readRequestJson(request);
    requests.push(body);
    response.writeHead(200, { "content-type": "application/json" });

    if (requests.length === 1) {
      response.end(JSON.stringify({
        id: "mock-reasoning-only-length",
        model: body.model,
        content: [],
        thinking: "The model spent the whole budget planning without producing visible text.".repeat(80),
        toolCalls: [],
        stopReason: "length",
        usage: {
          completion_tokens: 32768,
          prompt_tokens: 1000,
          total_tokens: 33768,
          completion_tokens_details: {
            reasoning_tokens: 32678
          }
        },
        raw: {
          thinkingBytes: 5200,
          textBytes: 0
        }
      }));
      return;
    }

    response.end(JSON.stringify({
      id: "mock-reasoning-retry-healthy",
      model: body.model,
      content: [{ type: "text", text: "总结完成：已根据当前上下文给出用户可见正文。" }],
      toolCalls: [],
      stopReason: "stop"
    }));
  });
}

export function createAlwaysReasoningOnlyLengthGateway(requests) {
  return http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      return;
    }
    const body = await readRequestJson(request);
    requests.push(body);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: `mock-reasoning-only-length-${requests.length}`,
      model: body.model,
      content: [],
      thinking: "The model spent the whole budget planning without producing visible text.".repeat(80),
      toolCalls: [],
      stopReason: "length",
      raw: { thinkingBytes: 5200, textBytes: 0 }
    }));
  });
}

/**
 * @param {Array<Record<string, any>>} requests
 */
export function createMissingTerminalThenHealthyGateway(requests: Array<Record<string, unknown>>) {
  return http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      return;
    }

    const body = await readRequestJson(request);
    requests.push(body);
    response.writeHead(200, { "content-type": "application/json" });

    if (requests.length === 1) {
      response.end(JSON.stringify(missingTerminalResponse(body.model, "mock-missing-terminal")));
      return;
    }

    response.end(JSON.stringify({
      id: "mock-missing-terminal-recovered",
      model: body.model,
      content: [{ type: "text", text: "恢复完成：已返回完整正文。" }],
      toolCalls: [],
      stopReason: "stop"
    }));
  });
}

/**
 * @param {Array<Record<string, any>>} requests
 */
export function createAlwaysMissingTerminalGateway(requests: Array<Record<string, unknown>>) {
  return http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      return;
    }

    const body = await readRequestJson(request);
    requests.push(body);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(missingTerminalResponse(body.model, `mock-missing-terminal-${requests.length}`)));
  });
}

export function missingTerminalResponse(model, id) {
  return {
    id,
    model,
    content: [],
    thinking: "I need to inspect the current state. I need to see",
    toolCalls: [],
    stopReason: null,
    raw: {
      thinkingBytes: 517,
      textBytes: 0
    }
  };
}

/**
 * @param {Array<Record<string, any>>} requests
 */
export function createRepetitiveThinkingThenHealthyGateway(requests: Array<Record<string, unknown>>) {
  return http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      return;
    }

    const body = await readRequestJson(request);
    requests.push(body);
    response.writeHead(200, { "content-type": "application/json" });

    if (requests.length === 1) {
      const repeated = [
        "Let me now create the entries and edit the files.",
        "Actually, I should inspect the same format one more time before editing."
      ].join("\n");
      response.end(JSON.stringify({
        id: "mock-repetitive-thinking",
        model: body.model,
        content: [],
        thinking: `${repeated}\n`.repeat(80),
        toolCalls: [],
        stopReason: "length",
        raw: {
          thinkingBytes: 9000,
          textBytes: 0
        }
      }));
      return;
    }

    response.end(JSON.stringify({
      id: "mock-repetitive-retry-healthy",
      model: body.model,
      content: [{ type: "text", text: "已跳出重复思考并给出最终正文。" }],
      toolCalls: [],
      stopReason: "stop"
    }));
  });
}

export function createAlwaysRepetitiveThinkingGateway(requests) {
  return http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      return;
    }
    const body = await readRequestJson(request);
    requests.push(body);
    const repeated = [
      "Let me now create the entries and edit the files.",
      "Actually, I should inspect the same format one more time before editing."
    ].join("\n");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: `mock-repetitive-thinking-${requests.length}`,
      model: body.model,
      content: [],
      thinking: `${repeated}\n`.repeat(80),
      toolCalls: [],
      stopReason: "stop",
      raw: { thinkingBytes: 9000, textBytes: 0 }
    }));
  });
}

/**
 * @param {Array<Record<string, any>>} requests
 */
export function createUsageGateway(requests: Array<Record<string, unknown>>) {
  return http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      return;
    }

    const body = await readRequestJson(request);
    requests.push(body);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "mock-usage-final",
      model: body.model,
      content: [{ type: "text", text: "usage recorded" }],
      toolCalls: [],
      stopReason: "stop",
      usage: {
        prompt_tokens: 123,
        completion_tokens: 45,
        total_tokens: 168,
        prompt_tokens_details: {
          cached_tokens: 100
        }
      }
    }));
  });
}

/**
 * @param {Array<Record<string, any>>} requests
 */
export function createDelegationGuardGateway(requests: Array<Record<string, unknown>>) {
  return http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      return;
    }

    const body = await readRequestJson(request);
    requests.push(body);
    response.writeHead(200, { "content-type": "application/json" });

    if (requests.length === 1) {
      response.end(JSON.stringify({
        id: "mock-guard-tools",
        model: body.model,
        content: [],
        toolCalls: [
          {
            id: "glob-wide",
            name: "glob",
            input: { pattern: "**/*.js", path: "." }
          },
          {
            id: "grep-wide",
            name: "grep",
            input: { pattern: "fullAccess", path: "." }
          }
        ],
        stopReason: "tool_calls"
      }));
      return;
    }

    response.end(JSON.stringify({
      id: "mock-guard-final",
      model: body.model,
      content: [{ type: "text", text: "guard consumed" }],
      toolCalls: [],
      stopReason: "stop"
    }));
  });
}

/**
 * @param {Array<Record<string, any>>} requests
 */
export function createAgentRunGateway(requests: Array<Record<string, unknown>>) {
  return http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      return;
    }

    const body = await readRequestJson(request);
    requests.push(body);
    response.writeHead(200, { "content-type": "application/json" });

    const sessionId = String(body.metadata?.sessionId ?? body.sessionId ?? "");
    if (sessionId.startsWith("agent-explorer-")) {
      response.end(JSON.stringify({
        id: "mock-child-final",
        model: body.model,
        content: [{ type: "text", text: "explorer child done" }],
        toolCalls: [],
        stopReason: "stop"
      }));
      return;
    }

    if (requests.filter((item) => !String(item.sessionId ?? "").startsWith("agent-explorer-")).length === 1) {
      response.end(JSON.stringify({
        id: "mock-agent-run",
        model: body.model,
        content: [],
        toolCalls: [
          {
            id: "delegate-explorer",
            name: "agent_run",
            input: { profile: "explorer", query: "inspect current workspace" }
          }
        ],
        stopReason: "tool_calls"
      }));
      return;
    }

    response.end(JSON.stringify({
      id: "mock-final",
      model: body.model,
      content: [{ type: "text", text: "agent result consumed" }],
      toolCalls: [],
      stopReason: "stop"
    }));
  });
}

/**
 * @param {Array<Record<string, any>>} requests
 */
export function createBackgroundAgentRunGateway(requests: Array<Record<string, unknown>>) {
  return http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      return;
    }

    const body = await readRequestJson(request);
    requests.push(body);
    response.writeHead(200, { "content-type": "application/json" });

    const sessionId = String(body.metadata?.sessionId ?? body.sessionId ?? "");
    if (sessionId.startsWith("agent-explorer-")) {
      response.end(JSON.stringify({
        id: "mock-background-child-final",
        model: body.model,
        content: [{ type: "text", text: "background child done" }],
        toolCalls: [],
        stopReason: "stop"
      }));
      return;
    }

    if (requests.filter((item) => !String(item.sessionId ?? "").startsWith("agent-explorer-")).length === 1) {
      response.end(JSON.stringify({
        id: "mock-background-agent-run",
        model: body.model,
        content: [],
        toolCalls: [
          {
            id: "delegate-background-explorer",
            name: "agent_run",
            input: {
              profile: "explorer",
              query: "inspect current workspace in background",
              background: true,
              groupId: "group-session-bg",
              waitForGroup: "all",
              wakeParent: true
            }
          }
        ],
        stopReason: "tool_calls"
      }));
      return;
    }

    response.end(JSON.stringify({
      id: "mock-background-parent-final",
      model: body.model,
      content: [{ type: "text", text: "background dispatched" }],
      toolCalls: [],
      stopReason: "stop"
    }));
  });
}

/**
 * @param {Array<Record<string, any>>} requests
 */
export function createParallelAgentRunGateway(requests: Array<Record<string, unknown>>) {
  return http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      return;
    }

    const body = await readRequestJson(request);
    requests.push(body);
    response.writeHead(200, { "content-type": "application/json" });

    const sessionId = String(body.metadata?.sessionId ?? body.sessionId ?? "");
    if (sessionId.startsWith("agent-explorer-")) {
      setTimeout(() => {
        response.end(JSON.stringify({
          id: `mock-child-final-${sessionId}`,
          model: body.model,
          content: [{ type: "text", text: `child done ${sessionId}` }],
          toolCalls: [],
          stopReason: "stop"
        }));
      }, sessionId.includes("child-b") ? 10 : 50);
      return;
    }

    if (requests.filter((item) => !String(item.sessionId ?? "").startsWith("agent-explorer-")).length === 1) {
      response.end(JSON.stringify({
        id: "mock-agent-run-parallel",
        model: body.model,
        content: [],
        toolCalls: [
          {
            id: "delegate-explorer-a",
            name: "agent_run",
            input: { profile: "explorer", taskId: "child-a", query: "inspect module A" }
          },
          {
            id: "delegate-explorer-b",
            name: "agent_run",
            input: { profile: "explorer", taskId: "child-b", query: "inspect module B" }
          }
        ],
        stopReason: "tool_calls"
      }));
      return;
    }

    response.end(JSON.stringify({
      id: "mock-final",
      model: body.model,
      content: [{ type: "text", text: "parallel agent results consumed" }],
      toolCalls: [],
      stopReason: "stop"
    }));
  });
}

/**
 * @param {Array<Record<string, any>>} requests
 */
export function createDuplicateTaskIdAgentRunGateway(requests: Array<Record<string, unknown>>) {
  return http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      return;
    }

    const body = await readRequestJson(request);
    requests.push(body);
    response.writeHead(200, { "content-type": "application/json" });

    const sessionId = String(body.metadata?.sessionId ?? body.sessionId ?? "");
    if (sessionId.startsWith("agent-explorer-")) {
      response.end(JSON.stringify({
        id: `mock-duplicate-child-final-${sessionId}`,
        model: body.model,
        content: [{ type: "text", text: `child done ${sessionId}` }],
        toolCalls: [],
        stopReason: "stop"
      }));
      return;
    }

    if (requests.filter((item) => !String(item.sessionId ?? "").startsWith("agent-explorer-")).length === 1) {
      response.end(JSON.stringify({
        id: "mock-agent-run-duplicate-task-ids",
        model: body.model,
        content: [],
        toolCalls: [
          {
            id: "delegate-duplicate-a",
            name: "agent_run",
            input: { profile: "explorer", taskId: "child-same", query: "inspect module A" }
          },
          {
            id: "delegate-duplicate-b",
            name: "agent_run",
            input: { profile: "explorer", taskId: "child-same", query: "inspect module B" }
          }
        ],
        stopReason: "tool_calls"
      }));
      return;
    }

    response.end(JSON.stringify({
      id: "mock-final",
      model: body.model,
      content: [{ type: "text", text: "duplicate task ids consumed" }],
      toolCalls: [],
      stopReason: "stop"
    }));
  });
}

/**
 * @param {Array<Record<string, any>>} requests
 * @param {{ toolRounds: number; toolName: string; input: Record<string, any>; finalText: string }} fixture
 */
export function createRepeatedToolGateway(requests: Array<Record<string, unknown>>, fixture: { toolRounds: number; toolName: string; input: Record<string, unknown>; finalText: string }) {
  return http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      return;
    }

    const body = await readRequestJson(request);
    requests.push(body);
    response.writeHead(200, { "content-type": "application/json" });

    if (requests.length <= fixture.toolRounds) {
      response.end(JSON.stringify({
        id: `mock-tool-call-${requests.length}`,
        model: body.model,
        content: [],
        toolCalls: [
          {
            id: `tool-${requests.length}`,
            name: fixture.toolName,
            input: fixture.input
          }
        ],
        stopReason: "tool_calls"
      }));
      return;
    }

    response.end(JSON.stringify({
      id: "mock-final",
      model: body.model,
      content: [{ type: "text", text: fixture.finalText }],
      toolCalls: [],
      stopReason: "stop"
    }));
  });
}

/**
 * @param {Array<Record<string, any>>} requests
 */
export function createTodoSyncGateway(requests: Array<Record<string, unknown>>) {
  return http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      return;
    }

    const body = await readRequestJson(request);
    requests.push(body);
    response.writeHead(200, { "content-type": "application/json" });

    if (requests.length === 1) {
      response.end(JSON.stringify({
        id: "mock-todo-call",
        model: body.model,
        content: [],
        toolCalls: [
          {
            id: "write-todos",
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

    response.end(JSON.stringify({
      id: "mock-final",
      model: body.model,
      content: [{ type: "text", text: "全部待办已完成。" }],
      toolCalls: [],
      stopReason: "stop"
    }));
  });
}

/**
 * @param {Array<Record<string, any>>} requests
 */
export function createOpenAIStreamingGateway(requests: Array<Record<string, unknown>>) {
  return http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      return;
    }

    const body = await readRequestJson(request);
    requests.push(body);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('data: {"id":"chatcmpl-live","model":"mock-openai","choices":[{"delta":{"reasoning_content":"checking "}}]}\n\n');
    response.write('data: {"choices":[{"delta":{"content":"hello "}}]}\n\n');
    response.write('data: {"choices":[{"delta":{"content":"world"},"finish_reason":"stop"}]}\n\n');
    response.end("data: [DONE]\n\n");
  });
}

/**
 * @param {Array<Record<string, any>>} requests
 */
export function createIncompleteOpenAIThenHealthyGateway(requests: Array<Record<string, unknown>>) {
  return http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      return;
    }

    const body = await readRequestJson(request);
    requests.push(body);
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (requests.length === 1) {
      response.end('data: {"id":"chatcmpl-incomplete","model":"mock-openai","choices":[{"delta":{"reasoning_content":"I need to see"}}]}\n\n');
      return;
    }

    response.write('data: {"id":"chatcmpl-recovered","model":"mock-openai","choices":[{"delta":{"content":"stream recovered"},"finish_reason":"stop"}]}\n\n');
    response.end("data: [DONE]\n\n");
  });
}

/**
 * @param {Array<Record<string, any>>} requests
 */
export function createOpenAIDanglingToolCompactionGateway(requests: Array<Record<string, unknown>>) {
  return http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      return;
    }

    const body = await readRequestJson(request);
    requests.push(body);
    if (body.messages?.some((message) => String(message.content ?? "").includes("context compactor"))) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "chatcmpl-compact",
        model: body.model,
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: "Compacted older tool context."
            }
          }
        ]
      }));
      return;
    }

    const danglingTool = findDanglingOpenAIToolMessage(body.messages ?? []);
    if (danglingTool) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({
        error: {
          message: "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'",
          type: "invalid_request_error"
        }
      }));
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "chatcmpl-after-compact",
      model: body.model,
      choices: [
        {
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: "after compaction accepted"
          }
        }
      ]
    }));
  });
}

export function findDanglingOpenAIToolMessage(messages = []) {
  const pendingToolCallIds = new Set();
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role !== "tool" && pendingToolCallIds.size > 0) {
      return {
        role: "assistant",
        missing_tool_call_ids: Array.from(pendingToolCallIds)
      };
    }
    if (message?.role === "assistant") {
      pendingToolCallIds.clear();
      for (const call of message.tool_calls ?? []) {
        const id = String(call?.id ?? "");
        if (id) {
          pendingToolCallIds.add(id);
        }
      }
      continue;
    }
    if (message?.role === "tool") {
      const id = String(message.tool_call_id ?? "");
      if (!pendingToolCallIds.has(id)) {
        return message;
      }
      pendingToolCallIds.delete(id);
      continue;
    }
    if (message?.role) {
      pendingToolCallIds.clear();
    }
  }
  if (pendingToolCallIds.size > 0) {
    return {
      role: "assistant",
      missing_tool_call_ids: Array.from(pendingToolCallIds)
    };
  }
  return null;
}

/**
 * @param {Array<Record<string, any>>} requests
 */
export function createDeepSeekReasoningToolGateway(requests: Array<Record<string, unknown>>) {
  return http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      return;
    }

    const body = await readRequestJson(request);
    requests.push(body);

    if (requests.length === 1) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"id":"chatcmpl-deepseek-tool","model":"mock-openai","choices":[{"delta":{"reasoning_content":"Need to read notes before answering."}}]}\n\n');
      response.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-read-notes","function":{"name":"read_file","arguments":"{\\"path\\":\\"notes.txt\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n');
      response.end("data: [DONE]\n\n");
      return;
    }

    const assistant = body.messages?.find((message) => message.role === "assistant" && Array.isArray(message.tool_calls));
    if (assistant?.reasoning_content !== "Need to read notes before answering.") {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({
        error: {
          message: "The `reasoning_content` in the thinking mode must be passed back to the API.",
          type: "invalid_request_error"
        }
      }));
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "chatcmpl-deepseek-final",
      model: body.model,
      choices: [
        {
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: "reasoning continuation accepted"
          }
        }
      ]
    }));
  });
}

/**
 * @param {Array<Record<string, any>>} requests
 */
export function createResponsesReasoningToolGateway(requests: Array<Record<string, unknown>>) {
  return http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      return;
    }

    const body = await readRequestJson(request);
    requests.push(body);

    if (requests.length === 1) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "resp-tool-round",
        model: body.model,
        status: "completed",
        output: [
          {
            type: "reasoning",
            id: "rs-tool-round",
            summary: [{ type: "summary_text", text: "Need to read notes." }],
            encrypted_content: "opaque-provider-state"
          },
          {
            type: "function_call",
            id: "fc-read-notes",
            call_id: "call-read-notes",
            name: "read_file",
            arguments: '{"path":"notes.txt"}'
          }
        ]
      }));
      return;
    }

    const reasoning = body.input?.find((item) => item.type === "reasoning");
    const functionCalls = body.input?.filter((item) => item.type === "function_call") ?? [];
    const toolOutput = body.input?.find((item) => item.type === "function_call_output" && item.call_id === "call-read-notes");
    if (reasoning?.encrypted_content !== "opaque-provider-state" || functionCalls.length !== 1 || !toolOutput) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Native reasoning and function items must be replayed." } }));
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "resp-tool-final",
      model: body.model,
      status: "completed",
      output: [{
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "responses reasoning continuation accepted" }]
      }]
    }));
  });
}

/**
 * @param {Array<Record<string, any>>} requests
 */
export function createLongReasoningToolGateway(requests: Array<Record<string, unknown>>) {
  return http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      return;
    }

    const body = await readRequestJson(request);
    requests.push(body);

    if (requests.length === 1) {
      const reasoning = `VERY_OLD_REASONING_START${"填充".repeat(160_000)}LATEST_REASONING_TAIL`;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({
        id: "chatcmpl-deepseek-long-tool",
        model: "mock-openai",
        choices: [{ delta: { reasoning_content: reasoning } }]
      })}\n\n`);
      response.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-read-notes","function":{"name":"read_file","arguments":"{\\"path\\":\\"notes.txt\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n');
      response.end("data: [DONE]\n\n");
      return;
    }

    const assistant = body.messages?.find((message) => message.role === "assistant" && Array.isArray(message.tool_calls));
    if (!assistant?.reasoning_content?.endsWith("LATEST_REASONING_TAIL") || assistant.reasoning_content.includes("VERY_OLD_REASONING_START")) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({
        error: {
          message: "Expected trimmed latest reasoning tail.",
          type: "invalid_request_error"
        }
      }));
      return;
    }

    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('data: {"id":"chatcmpl-deepseek-final","model":"mock-openai","choices":[{"delta":{"content":"trimmed reasoning accepted"},"finish_reason":"stop"}]}\n\n');
    response.end("data: [DONE]\n\n");
  });
}

export function createReasoningOnlyOpenAIStreamingGateway() {
  return http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      return;
    }

    await readRequestJson(request);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('data: {"id":"chatcmpl-reasoning","model":"mock-openai","choices":[{"delta":{"reasoning_content":"private final text"}}]}\n\n');
    response.write('data: {"choices":[{"delta":{"content":null},"finish_reason":"stop"}]}\n\n');
    response.end("data: [DONE]\n\n");
  });
}

/**
 * @param {Array<Record<string, any>>} requests
 */
export function createSlowOpenAIStreamingGateway(requests: Array<Record<string, unknown>>) {
  return http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      return;
    }

    const body = await readRequestJson(request);
    requests.push(body);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('data: {"id":"chatcmpl-slow","model":"mock-openai","choices":[{"delta":{"role":"assistant","content":"partial "}}]}\n\n');
    const timer = setInterval(() => {
      response.write('data: {"choices":[{"delta":{"content":"more "}}]}\n\n');
    }, 25);
    response.on("close", () => clearInterval(timer));
  });
}

/**
 * @param {Array<Record<string, any>>} requests
 * @param {string} toolName
 * @param {string} command
 */
export function createValidationGateway(requests: Array<Record<string, unknown>>, toolName: string, command: string) {
  return http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      return;
    }

    const body = await readRequestJson(request);
    requests.push(body);
    response.writeHead(200, { "content-type": "application/json" });

    if (requests.length === 1) {
      response.end(JSON.stringify({
        id: "mock-tool-call",
        model: body.model,
        content: [{ type: "text", text: "running validation" }],
        toolCalls: [
          {
            id: "validation-tool",
            name: toolName,
            input: { command, timeoutMs: 10_000 }
          }
        ],
        stopReason: "tool_calls"
      }));
      return;
    }

    response.end(JSON.stringify({
      id: `mock-${requests.length}`,
      model: body.model,
      content: [{ type: "text", text: `assistant ${requests.length}` }],
      toolCalls: [],
      stopReason: "stop"
    }));
  });
}

/**
 * @param {http.IncomingMessage} request
 */
export async function readRequestJson(request: http.IncomingMessage) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * @param {http.Server} server
 * @param {string} host
 */
export function listen(server: http.Server, host: string) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

/**
 * @param {http.Server} server
 */
export function close(server: http.Server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve(undefined));
  });
}

export async function waitFor(predicate, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("Timed out waiting for condition");
}

/**
 * @param {http.Server} server
 */
export function serverUrl(server: http.Server) {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("server did not expose an address");
  }
  return `http://127.0.0.1:${address.port}`;
}

/**
 * @param {string} url
 */
export function mockGatewayEnv(url: string) {
  return {
    LAB_MODEL_GATEWAY_URL: `${url}/v1/chat`,
    LAB_MODEL_GATEWAY_PROTOCOL: "lab-agent-gateway",
    LAB_AGENT_MODEL: "mock-context",
    LAB_AGENT_NETWORK_MODE: "offline",
    LAB_AGENT_TRANSCRIPT_ENABLED: "false"
  };
}

export function mockGatewayEnvWithoutModel(url) {
  const env = mockGatewayEnv(url);
  delete env.LAB_AGENT_MODEL;
  return env;
}
