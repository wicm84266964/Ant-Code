import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  __backgroundTerminalRegistryTestHooks,
  cancelBackgroundTerminalTasks,
  listBackgroundTerminalTasks,
  registerBackgroundTerminalTask,
  updateBackgroundTerminalTask
} from "../../src/agents/background-terminal-registry.js";

test("terminal cancellation never forwards invalid process ids to an inspector or killer", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "terminal-pid-safety-"));
  let inspections = 0;
  let kills = 0;
  for (const [index, pid] of [-1, 0, 1, 1.5, Number.MAX_SAFE_INTEGER + 1].entries()) {
    const taskId = `invalid-pid-${index}-${Date.now()}`;
    registerBackgroundTerminalTask({ taskId, cwd, pid, status: "running" });
    const [result] = await cancelBackgroundTerminalTasks({
      taskId,
      cwd,
      refresh: false,
      inspectProcess: async () => {
        inspections += 1;
        return { alive: true, identity: "unexpected" };
      },
      terminateProcess: async () => {
        kills += 1;
        return { exited: true };
      }
    });
    assert.equal(result.pid, null);
    assert.equal(result.status, "cancelled");
    assert.equal(result.cancellationConfirmed, true);
  }
  assert.equal(inspections, 0);
  assert.equal(kills, 0);
});

test("legacy persisted terminal without creation identity is never killed", async () => {
  const fixture = await persistedTask({ processIdentity: null });
  let kills = 0;
  const [result] = await cancelBackgroundTerminalTasks({
    cwd: fixture.cwd,
    taskId: fixture.taskId,
    inspectProcess: async () => ({ alive: true, identity: "current-process" }),
    terminateProcess: async () => {
      kills += 1;
      return { exited: true };
    }
  });

  assert.equal(kills, 0);
  assert.equal(result.status, "stale");
  assert.equal(result.cancellationConfirmed, false);
  assert.equal(result.cancelError, "PROCESS_IDENTITY_UNKNOWN");
});

test("PID reuse identity mismatch is marked stale without invoking the killer", async () => {
  const fixture = await persistedTask({ processIdentity: "process-old" });
  let kills = 0;
  const [result] = await cancelBackgroundTerminalTasks({
    cwd: fixture.cwd,
    taskId: fixture.taskId,
    inspectProcess: async () => ({ alive: true, identity: "process-reused" }),
    terminateProcess: async () => {
      kills += 1;
      return { exited: true };
    }
  });

  assert.equal(kills, 0);
  assert.equal(result.status, "stale");
  assert.equal(result.cancelError, "PROCESS_IDENTITY_MISMATCH");
});

test("matching creation identity is required before cancellation is confirmed", async () => {
  const fixture = await persistedTask({ processIdentity: "process-same" });
  let kills = 0;
  const [result] = await cancelBackgroundTerminalTasks({
    cwd: fixture.cwd,
    taskId: fixture.taskId,
    inspectProcess: async () => ({ alive: true, identity: "process-same" }),
    terminateProcess: async (target) => {
      kills += 1;
      assert.equal(target.pid, fixture.pid);
      assert.equal(target.identity, "process-same");
      return { exited: true };
    }
  });

  assert.equal(kills, 1);
  assert.equal(result.status, "cancelled");
  assert.equal(result.cancellationConfirmed, true);
  assert.ok(result.cancelledAt);
});

test("terminal remains active when exit cannot be confirmed before the bounded deadline", async () => {
  const fixture = await persistedTask({ processIdentity: "process-hung" });
  const gate = deferred();
  const pending = cancelBackgroundTerminalTasks({
    cwd: fixture.cwd,
    taskId: fixture.taskId,
    inspectProcess: async () => ({ alive: true, identity: "process-hung" }),
    terminateProcess: async () => gate.promise
  });

  await waitFor(() => listBackgroundTerminalTasks({ cwd: fixture.cwd, taskId: fixture.taskId })[0]?.status === "cancelling");
  gate.resolve({ exited: false, error: "still alive" });
  const [result] = await pending;

  assert.equal(result.status, "running");
  assert.equal(result.cancellationConfirmed, false);
  assert.equal(result.cancelError, "still alive");
  assert.ok(result.cancelFailedAt);
  updateBackgroundTerminalTask(fixture.taskId, { status: "cancelled", cancellationConfirmed: true });
});

test("late callbacks from an old terminal instance cannot overwrite a reused task id", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "terminal-instance-safety-"));
  const taskId = `reused-${Date.now()}`;
  const unregisterOld = registerBackgroundTerminalTask({
    taskId,
    instanceId: "old-instance",
    cwd,
    pid: process.pid,
    status: "running"
  });

  assert.throws(
    () => registerBackgroundTerminalTask({ taskId, instanceId: "conflict", cwd, pid: process.pid, status: "running" }),
    (error) => error?.code === "BACKGROUND_TERMINAL_TASK_ID_CONFLICT"
  );
  updateBackgroundTerminalTask(taskId, { instanceId: "old-instance", status: "failed" });
  registerBackgroundTerminalTask({
    taskId,
    instanceId: "new-instance",
    cwd,
    pid: process.pid,
    status: "running"
  });

  assert.equal(updateBackgroundTerminalTask(taskId, {
    instanceId: "old-instance",
    status: "completed",
    exitCode: 0
  }), null);
  unregisterOld();
  const [current] = listBackgroundTerminalTasks({ cwd, taskId });
  assert.equal(current.instanceId, "new-instance");
  assert.equal(current.status, "running");
  updateBackgroundTerminalTask(taskId, {
    instanceId: "new-instance",
    status: "cancelled",
    cancellationConfirmed: true
  });
});

test("timed out process probes hard-settle and release child pipes", async () => {
  const snapshotChild = new NeverClosingProbe();
  const startedAt = Date.now();
  const snapshot = await __backgroundTerminalRegistryTestHooks.collectWindowsProcessLivenessSnapshot({
    spawnProcess: () => snapshotChild,
    timeoutMs: 5
  });
  assert.equal(snapshot.known, false);
  assertProbeReleased(snapshotChild);

  const identityChild = new NeverClosingProbe();
  const output = await __backgroundTerminalRegistryTestHooks.collectProcessOutput("never-close", [], {
    spawnProcess: () => identityChild,
    timeoutMs: 5
  });
  assert.deepEqual(output, { ok: false, stdout: "" });
  assertProbeReleased(identityChild);
  assert.ok(Date.now() - startedAt < 1_000);
});

test("persisted terminal history is scanned incrementally and compacted", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "terminal-registry-bounds-"));
  const parentSessionId = `bounded-history-${Date.now()}`;
  const dir = path.join(cwd, ".lab-agent", "background-terminal", "tasks");
  await fs.mkdir(dir, { recursive: true });
  const recent = new Date().toISOString();
  const expired = new Date(Date.now() - 60 * 24 * 60 * 60 * 1_000).toISOString();
  await Promise.all(Array.from({ length: 240 }, (_, index) => fs.writeFile(
    path.join(dir, `history-${String(index).padStart(3, "0")}.json`),
    `${JSON.stringify({
      taskId: `${parentSessionId}-${index}`,
      parentSessionId,
      cwd,
      status: "completed",
      startedAt: index < 10 ? expired : recent,
      updatedAt: index < 10 ? expired : recent,
      finishedAt: index < 10 ? expired : recent
    })}\n`,
    "utf8"
  )));

  const first = listBackgroundTerminalTasks({ cwd, parentSessionId });
  assert.ok(first.length > 0);
  assert.ok(first.length <= 64);
  let tasks = first;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    tasks = listBackgroundTerminalTasks({ cwd, parentSessionId });
    if (tasks.length === 200) break;
  }
  assert.equal(tasks.length, 200);
  assert.equal(tasks.some((task) => Date.parse(task.updatedAt) < Date.now() - 30 * 24 * 60 * 60 * 1_000), false);
});

test("cancellation hydrates a requested task directly beyond the scan batch", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "terminal-registry-direct-cancel-"));
  const dir = path.join(cwd, ".lab-agent", "background-terminal", "tasks");
  await fs.mkdir(dir, { recursive: true });
  const now = new Date().toISOString();
  await Promise.all(Array.from({ length: 90 }, (_, index) => fs.writeFile(
    path.join(dir, `a-history-${String(index).padStart(3, "0")}.json`),
    `${JSON.stringify({
      taskId: `direct-history-${index}`,
      cwd,
      status: "completed",
      startedAt: now,
      updatedAt: now,
      finishedAt: now
    })}\n`,
    "utf8"
  )));
  const taskId = `z-direct-target-${Date.now()}`;
  await fs.writeFile(path.join(dir, `${taskId}.json`), `${JSON.stringify({
    taskId,
    cwd,
    pid: 424_243,
    processIdentity: "direct-target",
    status: "running",
    startedAt: now,
    updatedAt: now
  })}\n`, "utf8");

  let kills = 0;
  const [result] = await cancelBackgroundTerminalTasks({
    cwd,
    taskId,
    inspectProcess: async () => ({ alive: true, identity: "direct-target" }),
    terminateProcess: async () => {
      kills += 1;
      return { exited: true };
    }
  });
  assert.equal(kills, 1);
  assert.equal(result.status, "cancelled");
  assert.equal(result.cancellationConfirmed, true);
});

async function persistedTask(overrides = {}) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "terminal-persisted-safety-"));
  const taskId = `persisted-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const pid = 424_242;
  const dir = path.join(cwd, ".lab-agent", "background-terminal", "tasks");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${taskId}.json`), `${JSON.stringify({
    taskId,
    parentSessionId: "safety-session",
    cwd,
    pid,
    status: "running",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides
  })}\n`, "utf8");
  return { cwd, taskId, pid };
}

function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

class NeverClosingProbe extends EventEmitter {
  constructor() {
    super();
    this.stdout = new PassThrough();
    this.killCalls = 0;
    this.unrefCalls = 0;
  }

  kill() {
    this.killCalls += 1;
    return true;
  }

  unref() {
    this.unrefCalls += 1;
  }
}

function assertProbeReleased(child) {
  assert.equal(child.killCalls, 1);
  assert.equal(child.unrefCalls, 1);
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stdout.listenerCount("data"), 0);
  assert.equal(child.listenerCount("close"), 0);
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition did not become true before timeout");
}
