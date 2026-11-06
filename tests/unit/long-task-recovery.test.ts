import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { createSession, runSessionTurn, summarizeToolCalls } from "../../src/core/session.ts";
import { formatToolResultForModel } from "../../src/tools/result-view.ts";
import { appendDashboardEvent } from "../../src/dashboard/runtime/util.ts";
import { runtimeSubscribe } from "../../src/dashboard/runtime/api-lifecycle.ts";
import { askApproval, askQuestion } from "../../src/dashboard/runtime/approvals.ts";
import { createToolGateway, mockGatewayEnv, listen, close, serverUrl } from "./session-helpers.ts";

async function fixture(t) {
  await fs.mkdir(path.resolve(".tmp_validation"), { recursive: true });
  const cwd = await fs.mkdtemp(path.resolve(".tmp_validation/recovery-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  await fs.writeFile(path.join(cwd, "notes.txt"), "checkpoint evidence\n");
  return cwd;
}

test("tool summaries use structured outcomes while keeping legacy JSON compatibility", () => {
  const call = { id: "test", name: "read_file", input: {} };
  const formatted = formatToolResultForModel("read_file", { ok: true, result: { path: "notes.txt", content: "test" } });
  for (const outcome of [
    { ok: true, blocked: false, decision: "allow" },
    { ok: false, blocked: true, decision: "deny" },
    { ok: false, interrupted: true }
  ]) {
    const summary = summarizeToolCalls([call], [{ content: formatted.content, outcome }])[0];
    assert.equal(summary.ok, outcome.ok);
    assert.equal(summary.blocked, outcome.blocked === true);
    assert.equal(summary.interrupted, outcome.interrupted === true);
    assert.equal(summary.decision, outcome.decision ?? null);
  }
  assert.equal(summarizeToolCalls([call], [{ content: '{"ok":true,"decision":{"decision":"allow"}}' }])[0].ok, true);
});

for (const mode of ["interrupt", "complete", "gateway-failure"]) {
  test(`completed tools survive ${mode} without duplicate archived calls`, async (t) => {
    const cwd = await fixture(t);
    const requests = [];
    const server = await listen(createToolGateway(requests), "127.0.0.1");
    t.after(() => close(server));
    const env = { ...mockGatewayEnv(serverUrl(server)), LAB_AGENT_TRANSCRIPT_ENABLED: "true" };
    const session = await createSession({ cwd, mode: "interactive", env });
    const controller = new AbortController();
    let success = false;
    await runSessionTurn(session, {
      prompt: "read notes", env, signal: controller.signal,
      onEvent: event => {
        if (event.type === "tool_finish") {
          success = event.ok === true;
          if (mode === "interrupt") controller.abort("checkpoint-test");
          if (mode === "gateway-failure") {
            server.removeAllListeners("request");
            server.on("request", async (req, res) => {
              for await (const chunk of req) { /* consume request */ }
              res.writeHead(400, { "content-type": "application/json" });
              res.end('{"error":{"code":"TEST_FAILURE","message":"fixture"}}');
            });
          }
        }
      }
    });
    assert.equal(success, true);
    const metadata = JSON.parse(await fs.readFile(path.join(cwd, ".lab-agent", "sessions", `${session.id}.json`), "utf8"));
    assert.equal(metadata.toolCalls.length, 1);
    assert.equal(metadata.toolCalls[0].ok, true);
    assert.equal(metadata.status, mode === "complete" ? "completed" : mode === "interrupt" ? "interrupted" : "gateway_error");
    const archived = [];
    for (const chunk of metadata.transcript.modelArchive.chunks) {
      archived.push(...JSON.parse(await fs.readFile(path.join(cwd, ".lab-agent", "sessions", chunk.file), "utf8")).messages);
    }
    assert.equal(archived.filter(m => m.role === "tool" && m.toolCallId === "read-notes").length, 1);
    assert.equal(archived.flatMap(m => m.toolCalls ?? []).filter(call => call.id === "read-notes").length, 1);
    assert.equal(archived.filter(m => m.role === "user").length, 1);
    assert.equal(session.messages.filter(m => m.role === "tool" && m.toolCallId === "read-notes").length, 1);
    const resumed = await createSession({ cwd, mode: "interactive", env, resume: session.id });
    assert.equal(resumed.messages.filter(m => m.role === "tool" && m.toolCallId === "read-notes").length, 1);
  });
}

for (const storageFailure of [false, true]) {
test(`write checkpoints ${storageFailure ? "stop admission on storage failure" : "complete before the next write starts"}`, async (t) => {
  const cwd = await fixture(t);
  let requestCount = 0;
  const server = await listen(http.createServer(async (req, res) => {
    for await (const chunk of req) { /* consume request */ }
    res.writeHead(200, { "content-type": "application/json" });
    requestCount++;
    res.end(JSON.stringify(requestCount === 1 ? {
      id: "write-request", model: "mock-context", content: [{ type: "text", text: "Writing two fixtures." }], stopReason: "tool_calls",
      toolCalls: ["first", "second"].map(id => ({ id, name: "write_file", input: { path: `${id}.txt`, content: id } }))
    } : {
      id: "finished", model: "mock-context", content: [{ type: "text", text: "finished" }], toolCalls: [], stopReason: "stop"
    }));
  }), "127.0.0.1");
  t.after(() => close(server));
  const env = { ...mockGatewayEnv(serverUrl(server)), LAB_AGENT_TRANSCRIPT_ENABLED: "true" };
  const session = await createSession({ cwd, mode: "interactive", env, allowWrite: true });
  let inspected = false;
  const turn = runSessionTurn(session, {
    prompt: "write the fixtures", env,
    onEvent: async event => {
      if (storageFailure && event.type === "tool_finish" && event.toolCallId === "first") {
        t.mock.method(fs, "rename", async () => { throw Object.assign(new Error("fixture storage failure"), { code: "EIO" }); });
      }
      if (event.type !== "tool_start" || event.toolCallId !== "second") return;
      const metadata = JSON.parse(await fs.readFile(path.join(cwd, ".lab-agent", "sessions", `${session.id}.json`), "utf8"));
      assert.equal(await fs.readFile(path.join(cwd, "first.txt"), "utf8"), "first");
      assert.equal(metadata.status, "running");
      assert.equal(metadata.finishedAt, null);
      assert.deepEqual(metadata.toolCalls.map(call => call.id), ["first"]);
      assert.equal(metadata.toolCalls[0].ok, true);
      inspected = true;
    }
  });
  if (storageFailure) {
    try {
      await assert.rejects(turn, /fixture storage failure/);
    } finally {
      t.mock.restoreAll();
    }
    assert.equal(await fs.readFile(path.join(cwd, "first.txt"), "utf8"), "first");
    await assert.rejects(fs.access(path.join(cwd, "second.txt")), { code: "ENOENT" });
    assert.equal(inspected, false);
    assert.equal(requestCount, 1);
    return;
  }
  await turn;
  assert.equal(inspected, true);
  assert.equal(await fs.readFile(path.join(cwd, "second.txt"), "utf8"), "second");
  const resumed = await createSession({ cwd, mode: "interactive", env, resume: session.id });
  assert.deepEqual(resumed.messages.filter(m => m.role === "tool").map(m => m.toolCallId), ["first", "second"]);
  assert.equal(resumed.messages.filter(m => m.role === "assistant" && JSON.stringify(m.content).includes("Writing two fixtures.")).length, 1);
});
}

test("reconnect restores authoritative state and pending interactions after event eviction", async (t) => {
  const cwd = await fixture(t);
  const session = await createSession({ cwd, mode: "interactive", env: { LAB_AGENT_NETWORK_MODE: "offline" } });
  const state = {
    session, disposed: false, running: true, interrupting: false, quarantinedTurnId: "",
    eventSequence: 0, events: [], listeners: new Set(), listenerDisposers: new Map(),
    sessionApprovals: new Set(), pendingApprovals: new Map(), pendingQuestions: new Map(),
    currentTurnId: "turn-1", queuedPrompts: [], turnChangeStats: {}
  };
  void askApproval(state as any, { toolName: "write_file", input: { path: "notes.txt" }, decision: { reason: "fixture" } });
  void askQuestion(state as any, { question: "fixture question" });
  for (let i = 0; i < 501; i++) appendDashboardEvent(state as any, { type: "assistant_draft", text: "fixture" });
  const received = [];
  const ctx = { active: new Map([[session.id, state]]) };
  const unsubscribe = runtimeSubscribe(ctx as any, session.id, event => received.push(event), { afterSequence: 0 });
  const snapshot = received.at(-1);
  assert.equal(snapshot.type, "session_sync");
  assert.equal(snapshot.replayGap, true);
  assert.equal(snapshot.running, true);
  assert.equal(snapshot.approvals.length, 1);
  assert.equal(snapshot.questions.length, 1);
  assert.equal(state.pendingApprovals.size, 1);
  assert.equal(state.pendingQuestions.size, 1);
  unsubscribe();
  state.running = false;
  state.pendingApprovals.clear();
  state.pendingQuestions.clear();
  const next = [];
  runtimeSubscribe(ctx as any, session.id, event => next.push(event), { afterSequence: state.eventSequence })();
  assert.equal(next.length, 1);
  assert.equal(next[0].running, false);
  assert.deepEqual(next[0].approvals, []);
  assert.deepEqual(next[0].questions, []);
});

test("Responses checkpoints restore paired tool calls without duplication after resume", async (t) => {
  const cwd = await fixture(t);
  const requests = [];
  const server = await listen(http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(requests.length === 1 ? {
      id: "native-tools", model: body.model, status: "completed",
      output: [
        { type: "reasoning", id: "native-reasoning", encrypted_content: "fixture-opaque-state", summary: [] },
        ...["first", "second"].map(id => ({ type: "function_call", id: `native-${id}`, call_id: id, name: "read_file", arguments: '{"path":"notes.txt"}' }))
      ]
    } : {
      id: "native-final", model: body.model, status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "resumed" }] }]
    }));
  }), "127.0.0.1");
  t.after(() => close(server));
  const env = {
    LAB_MODEL_GATEWAY_URL: `${serverUrl(server)}/v1/responses`, LAB_MODEL_GATEWAY_PROTOCOL: "openai-responses",
    LAB_AGENT_MODEL: "mock-responses", LAB_AGENT_NETWORK_MODE: "offline", LAB_AGENT_TRANSCRIPT_ENABLED: "true"
  };
  const session = await createSession({ cwd, mode: "interactive", env });
  const controller = new AbortController();
  await runSessionTurn(session, {
    prompt: "read twice", env, signal: controller.signal,
    onEvent: event => {
      if (event.type === "tool_finish" && event.toolCallId === "second") controller.abort("checkpoint-test");
    }
  });
  const resumed = await createSession({ cwd, mode: "interactive", env, resume: session.id });
  await runSessionTurn(resumed, { prompt: "continue", env });
  assert.equal(requests.length, 2);
  const input = requests[1].input;
  for (const id of ["first", "second"]) {
    assert.equal(input.filter(item => item.type === "function_call" && item.call_id === id).length, 1);
    assert.equal(input.filter(item => item.type === "function_call_output" && item.call_id === id).length, 1);
  }
});
