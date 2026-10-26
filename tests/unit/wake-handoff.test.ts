import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSession, runSessionTurn } from "../../src/core/session.ts";
import { createDashboardRuntime } from "../../src/dashboard/sessions.ts";
import {
  buildBatchedWakePrompt,
  noteWakeHandoff,
  pendingWakeHandoffCount,
  resetWakeHandoffStateForTests,
  takeWakeHandoffs,
  type WakeHandoff
} from "../../src/agents/wake-batch.ts";
import { close as closeSessionServer, listen as listenSession, mockGatewayEnv, serverUrl } from "./session-helpers.ts";
import { close as closeDashboardServer, listen as listenDashboard, mockGatewayEnv as mockDashboardEnv } from "./dashboard-runtime/helpers.ts";

function handoff(groupId: string, wakePrompt: string): WakeHandoff {
  return {
    groupId,
    parentSessionId: "session-batch",
    cwd: "C:\\workspace",
    wakePrompt,
    summary: groupId,
    taskId: `task-${groupId}`,
    profile: "explorer",
    notedAt: "2026-10-26T00:00:00.000Z"
  };
}

test("wake handoff batch merges groups once and ignores a duplicate group", () => {
  resetWakeHandoffStateForTests();
  assert.equal(noteWakeHandoff(handoff("alpha", "alpha report unique")), true);
  assert.equal(noteWakeHandoff(handoff("beta", "beta report unique")), true);
  assert.equal(noteWakeHandoff(handoff("alpha", "alpha report again")), false);
  const taken = takeWakeHandoffs("session-batch");
  assert.deepEqual(taken.map((item) => item.groupId), ["alpha", "beta"]);
  const prompt = buildBatchedWakePrompt(taken, 20_000);
  assert.match(prompt, /Ant Code subagent handoff/);
  assert.match(prompt, /alpha report unique/);
  assert.match(prompt, /beta report unique/);
  assert.equal(prompt.includes("alpha report again"), false);
  assert.equal(takeWakeHandoffs("session-batch").length, 0);
  const tight = buildBatchedWakePrompt(taken, 360);
  assert.ok(Buffer.byteLength(tight, "utf8") <= 360);
  assert.equal(tight.includes("beta report unique"), false);
});

test("a still-running parent turn receives multiple group handoffs in one later request", async () => {
  resetWakeHandoffStateForTests();
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-wake-batch-"));
  const requests: Array<Record<string, unknown>> = [];
  const server = await listenSession(createHeldParentGateway(requests), "127.0.0.1");
  try {
    const env = mockGatewayEnv(serverUrl(server));
    const session = await createSession({ cwd, mode: "interactive", env });
    const result = await runSessionTurn(session, {
      prompt: "dispatch two background explorers and keep working",
      env
    });
    assert.match(result.output, /both handoffs consumed together/);
    const parent = requests.filter((item) => !String(item.sessionId ?? "").startsWith("agent-"));
    const withBoth = parent.filter((item) => hasBothReports(item));
    const withOne = parent.filter((item) => hasExactlyOneReport(item));
    assert.equal(withBoth.length, 1);
    assert.equal(withOne.length, 0);
    assert.ok(parent.length <= 3);
  } finally {
    resetWakeHandoffStateForTests();
    await closeSessionServer(server);
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("dashboard does not queue one wakeup turn per group while the parent is still running", async () => {
  resetWakeHandoffStateForTests();
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-wake-batch-"));
  const requests: Array<Record<string, unknown>> = [];
  const releaseParent = deferred();
  const server = await listenDashboard(createHeldParentGateway(requests, { holdSecondParent: releaseParent }), "127.0.0.1", 0);
  const runtime = createDashboardRuntime({
    cwd,
    env: mockDashboardEnv(server, { LAB_AGENT_MODEL: "mock-model" })
  });
  await runtime.trustWorkspace();
  try {
    const started = await runtime.startTurn({
      prompt: "dispatch two background explorers and keep working",
      permissionMode: "workspace"
    });
    assert.equal(started.ok, true);
    await waitForDashboardCondition(() => (
      runtime.listActiveEvents(started.sessionId).filter((event) => event.type === "wakeup_attached").length >= 2
    ), 8_000);
    const state = runtime.active.get(started.sessionId);
    assert.equal(state.running, true);
    assert.equal(state.queuedPrompts.some((item) => item.kind === "wakeup"), false);
    const attached = runtime.listActiveEvents(started.sessionId).filter((event) => event.type === "wakeup_attached");
    assert.ok(attached.length >= 2);
    assert.equal(runtime.listActiveEvents(started.sessionId).some((event) => event.type === "wakeup_queued"), false);

    releaseParent.resolve();
    await waitForDashboard(runtime, started.sessionId, (event) => (
      event.type === "assistant_final" && /both handoffs consumed together/.test(String(event.text ?? ""))
    ), 8_000);
    await waitForDashboardCondition(() => runtime.active.get(started.sessionId)?.running === false);
    const parent = requests.filter((item) => !String(item.sessionId ?? "").startsWith("agent-"));
    assert.equal(parent.filter((item) => hasBothReports(item)).length, 1);
    assert.equal(parent.filter((item) => hasExactlyOneReport(item)).length, 0);
    assert.equal(runtime.active.get(started.sessionId).queuedPrompts.some((item) => item.kind === "wakeup"), false);
    const events = runtime.listActiveEvents(started.sessionId);
    assert.equal(events.filter((event) => event.type === "wakeup_queued").length, 0);
  } finally {
    releaseParent.resolve();
    resetWakeHandoffStateForTests();
    await runtime.shutdown({ cancelActive: true, cancelBackground: true, force: true, timeoutMs: 200 });
    await closeDashboardServer(server);
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

function createHeldParentGateway(
  requests: Array<Record<string, unknown>>,
  options: { holdSecondParent?: { promise: Promise<void>; resolve: () => void } } = {}
) {
  let childCount = 0;
  const childrenReady = deferred();
  return http.createServer(async (request, response) => {
    const body = await readJson(request);
    const sessionId = requestSessionId(body);
    body.sessionId = sessionId;
    requests.push(body);
    response.writeHead(200, { "content-type": "application/json" });
    if (sessionId.startsWith("agent-")) {
      const text = /beta evidence slice/.test(JSON.stringify(body.messages ?? []))
        ? "beta report unique"
        : "alpha report unique";
      childCount += 1;
      if (childCount >= 2) {
        childrenReady.resolve();
      }
      response.end(JSON.stringify({
        id: `child-${childCount}`,
        model: body.model,
        content: [{ type: "text", text }],
        toolCalls: [],
        stopReason: "stop"
      }));
      return;
    }

    const parentCalls = requests.filter((item) => !String(item.sessionId ?? "").startsWith("agent-")).length;
    if (parentCalls === 1) {
      response.end(JSON.stringify({
        id: "dispatch-two",
        model: body.model,
        content: [],
        toolCalls: [
          {
            id: "delegate-alpha",
            name: "agent_run",
            input: {
              profile: "explorer",
              query: "alpha evidence slice",
              background: true,
              groupId: "group-alpha",
              taskId: "task-alpha",
              waitForGroup: "all",
              wakeParent: true
            }
          },
          {
            id: "delegate-beta",
            name: "agent_run",
            input: {
              profile: "explorer",
              query: "beta evidence slice",
              background: true,
              groupId: "group-beta",
              taskId: "task-beta",
              waitForGroup: "all",
              wakeParent: true
            }
          }
        ],
        stopReason: "tool_calls"
      }));
      return;
    }

    if (parentCalls === 2 && options.holdSecondParent) {
      await options.holdSecondParent.promise;
    } else if (!hasBothReports(body)) {
      await childrenReady.promise;
      const deadline = Date.now() + 5_000;
      while (pendingWakeHandoffCount(sessionId) < 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    response.end(JSON.stringify({
      id: hasBothReports(body) ? "integrated-final" : "premature-final",
      model: body.model,
      content: [{ type: "text", text: hasBothReports(body) ? "both handoffs consumed together" : "parent tried to finish early" }],
      toolCalls: [],
      stopReason: "stop"
    }));
  });
}

function requestSessionId(body: Record<string, unknown>) {
  const metadata = body.metadata && typeof body.metadata === "object"
    ? body.metadata as { sessionId?: unknown }
    : {};
  return String(metadata.sessionId ?? body.sessionId ?? "");
}

function hasBothReports(body: Record<string, unknown>) {
  const text = JSON.stringify(body.messages ?? []);
  return text.includes("alpha report unique") && text.includes("beta report unique");
}

function hasExactlyOneReport(body: Record<string, unknown>) {
  const text = JSON.stringify(body.messages ?? []);
  const alpha = text.includes("alpha report unique");
  const beta = text.includes("beta report unique");
  return alpha !== beta;
}

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function readJson(request: http.IncomingMessage) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

async function waitForDashboard(runtime: { listActiveEvents: (sessionId: string) => Array<Record<string, unknown>>; subscribe: (sessionId: string, listener: (event: Record<string, unknown>) => void) => () => void }, sessionId: string, predicate: (event: Record<string, unknown>) => boolean, timeoutMs = 5_000) {
  const existing = runtime.listActiveEvents(sessionId);
  if (existing.some(predicate)) {
    return existing;
  }
  return new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error("Timed out waiting for dashboard event"));
    }, timeoutMs);
    const unsubscribe = runtime.subscribe(sessionId, (event) => {
      if (predicate(event)) {
        clearTimeout(timeout);
        unsubscribe();
        resolve(runtime.listActiveEvents(sessionId));
      }
    });
  });
}

async function waitForDashboardCondition(predicate: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for dashboard condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
