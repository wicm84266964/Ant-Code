import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { startDashboard, prepareDashboardSourceUpdateShutdown, listenOnAvailablePort, createDashboardServer, installDashboardSourceUpdateSignalHandlers } from "../../src/dashboard/server.ts";
import { createDashboardRuntime } from "../../src/dashboard/sessions.ts";
import { emptyRuntimeActivity } from "../../src/dashboard/runtime/lifecycle.ts";
import { createSourceUpdateMaintenance } from "../../src/dashboard/runtime/source-update-maintenance.ts";
import { beginPrompt, createTurnState } from "../../src/dashboard/runtime/turn-queue.ts";
import { tickDashboardSchedules } from "../../src/dashboard/runtime/schedules.ts";
import { createScheduleRecord, readSchedule, scheduleFireDecision, schedulesDir, writeSchedule } from "../../src/schedules/store.ts";
import { registerBackgroundAgentTask } from "../../src/agents/background-registry.ts";
import { registerBackgroundTerminalTask, updateBackgroundTerminalTask } from "../../src/agents/background-terminal-registry.ts";
import { createSession } from "../../src/core/session.ts";
import { Repository, sourceRootFromModule } from "../../src/update/repository.ts";
import { captureBootSnapshot } from "../../src/update/boot.ts";
import { SourceUpdateManager } from "../../src/update/manager.ts";
import { StateStore, readJson } from "../../src/update/state-store.ts";
import { direct, fixture } from "../helpers/source-update/fixture.ts";

const boot = { productVersion: "1.2.3", bootCommit: "b".repeat(40), instanceId: "isolated-boot" };
const idle = () => Promise.resolve(emptyRuntimeActivity());
const fakeManager = () => ({ snapshot: async () => ({ boot, phase: "idle" }), check: () => ({ accepted: true }),
  start: () => ({ accepted: true, jobId: "test-only" }), dispose: async () => {} });

async function temporaryRuntime(activity = idle) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "source-update-lifecycle-"));
  const runtime = createDashboardRuntime({ cwd, env: {}, lifecycleActivity: activity });
  return { cwd, runtime, cleanup: async () => { await runtime.shutdown({}); await fs.rm(cwd, { recursive: true, force: true }); } };
}
async function unusedPort() {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test("strict listen never falls back, normal listen still advances", async () => {
  const blocker = http.createServer();
  await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const port = blocker.address().port;
  const strict = http.createServer(), normal = http.createServer();
  try {
    await assert.rejects(listenOnAvailablePort(strict, { host: "127.0.0.1", port, strictPort: true }), { code: "EADDRINUSE" });
    assert.equal(strict.listening, false);
    const bound = await listenOnAvailablePort(normal, { host: "127.0.0.1", port });
    assert.ok(bound.port > port);
  } finally {
    await Promise.all([blocker, normal].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  }
});

test("startDashboard ACK is after actual listen; source root ignores project and package-root env", async () => {
  const f = await temporaryRuntime();
  const port = await unusedPort();
  let managerOptions;
  let disposed = 0;
  const calls = [];
  const expectedRoot = await sourceRootFromModule();
  const result = await startDashboard({ cwd: f.cwd, project: f.cwd, port, open: false, runtime: f.runtime,
    env: { ANT_SOURCE_UPDATE_STRICT_PORT: "1", LAB_AGENT_PACKAGE_ROOT: f.cwd }, onShutdown: () => {},
    sourceUpdate: {
      captureBoot: async (root) => { assert.equal(root, expectedRoot); calls.push("boot"); return boot; },
      acknowledge: async (input) => {
        // Listener is already occupying the exact port before ACK is attempted.
        const probe = http.createServer();
        await assert.rejects(listenOnAvailablePort(probe, { host: input.host, port: input.actualPort, strictPort: true }), { code: "EADDRINUSE" });
        assert.equal(input.strictPort, true);
        assert.equal(input.actualPort, port);
        assert.equal(input.sourceRoot, expectedRoot);
        assert.equal(input.boot.instanceId, boot.instanceId);
        calls.push("ack"); return false;
      },
      createManager: async (input) => { managerOptions = input; calls.push("manager"); return { ...fakeManager(), dispose: async () => { disposed++; } }; }
    }
  });
  try {
    assert.deepEqual(calls, ["boot", "manager", "ack"]);
    assert.equal(managerOptions.sourceRoot, expectedRoot);
    assert.equal(managerOptions.projectCwd, await fs.realpath(f.cwd));
    assert.notEqual(managerOptions.sourceRoot, managerOptions.projectCwd);
    assert.equal(managerOptions.actualPort, port);
    assert.equal(managerOptions.env, f.runtime.env);
    assert.ok(managerOptions.config);
    assert.equal(managerOptions.strictRestartSupported, true);
  } finally {
    result.server.closeAllConnections();
    await new Promise<void>((resolve) => result.server.close(() => resolve()));
    await result.server.disposeSourceUpdate();
    assert.equal(disposed, 1);
    await f.cleanup();
  }
});

test("update boot invalid ACK fails closed and releases listener", async () => {
  const f = await temporaryRuntime();
  const port = await unusedPort();
  let managers = 0, disposed = 0;
  try {
    await assert.rejects(startDashboard({ cwd: f.cwd, port, open: false, runtime: f.runtime,
      env: { ANT_SOURCE_UPDATE_JOB: "forged", ANT_SOURCE_UPDATE_STRICT_PORT: "1" },
      sourceUpdate: { captureBoot: async () => boot, acknowledge: async () => false,
        createManager: async () => { managers++; return { ...fakeManager(), dispose: async () => { disposed++; } }; } }
    }), { code: "INVALID_UPDATE_BOOT" });
    assert.equal(managers, 1);
    assert.equal(disposed, 1);
    const probe = http.createServer();
    await listenOnAvailablePort(probe, { host: "127.0.0.1", port, strictPort: true });
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  } finally { await f.cleanup(); }
});

test("boot snapshot reads actual module installation version/commit once", async () => {
  const root = await sourceRootFromModule();
  const snapshot = await captureBootSnapshot(root);
  assert.equal(snapshot.productVersion, JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")).version);
  assert.match(snapshot.bootCommit, /^[a-f0-9]{40}$/);
  assert.ok(Object.isFrozen(snapshot));
  assert.notEqual(snapshot.instanceId, (await captureBootSnapshot(root)).instanceId);
});

test("maintenance atomically gates public mutations, turn admission, config writes and scheduler", async () => {
  const f = await temporaryRuntime();
  const restore = f.runtime.beginSourceUpdateMaintenance();
  try {
    for (const result of [
      f.runtime.startTurn({ prompt: "must not start" }), f.runtime.saveSettingsConfig({}),
      f.runtime.applyGoal({}), f.runtime.createSchedule({}), f.runtime.trustWorkspace(),
      f.runtime.resolveApproval("x", "allow-once"), f.runtime.saveModelConfig({})
    ]) assert.equal((await result).code, "SOURCE_UPDATE_MAINTENANCE");
    const tick = await tickDashboardSchedules({ cwd: f.cwd, active: f.runtime.active,
      get shuttingDown() { return f.runtime.sourceUpdateMaintenanceActive(); }, runtime: f.runtime });
    assert.equal(tick.fired, 0);
    assert.deepEqual(await fs.readdir(f.cwd), []);
  } finally { restore(); await f.cleanup(); }
});

test("maintenance during the queued schedule write preserves a one-time schedule for retry", { timeout: 10_000 }, async (t) => {
  const f = await temporaryRuntime();
  const now = Date.parse("2026-10-17T09:00:00.000Z");
  const record = createScheduleRecord({ title: "retry once", prompt: "must not execute", permissionMode: "plan",
    sessionId: "schedule-race", cadence: { type: "once", at: new Date(now).toISOString() }, timeZone: "UTC", now: now - 60_000 });
  await writeSchedule(f.cwd, record);
  const target = path.join(schedulesDir(f.cwd), `${record.id}.json`);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const rename = fs.rename.bind(fs);
  let deferred = false;
  const write = t.mock.method(fs, "rename", async (from, to) => {
    if (to === target && !deferred) {
      deferred = true;
      const queued = JSON.parse(await fs.readFile(from, "utf8"));
      assert.equal(queued.lastStatus, "queued");
      assert.equal(queued.enabled, false);
      entered.resolve();
      await release.promise;
    }
    return rename(from, to);
  });
  const ticking = tickDashboardSchedules({ cwd: f.cwd, active: f.runtime.active,
    get shuttingDown() { return f.runtime.sourceUpdateMaintenanceActive(); }, runtime: f.runtime }, now);
  let restore = () => {};
  try {
    await entered.promise;
    restore = f.runtime.beginSourceUpdateMaintenance();
    release.resolve();
    assert.deepEqual(await ticking, { ok: true, fired: 0, skipped: 0 });
    assert.equal(f.runtime.active.size, 0, "maintenance must not admit a turn");
    const saved = await readSchedule(f.cwd, record.id);
    assert.ok(saved);
    assert.equal(saved.enabled, true);
    assert.equal(saved.lastStatus, "failed");
    assert.match(saved.lastError, /source update/i);
    assert.equal(saved.nextRunAt, new Date(now + 60_000).toISOString());
    restore();
    assert.equal(scheduleFireDecision(saved, now + 60_000, null).action, "fire");
  } finally {
    release.resolve();
    await ticking.catch(() => {});
    write.mock.restore();
    restore();
    await f.cleanup();
  }
});


test("activity refuses quarantine, uncertainty, queued/pending work and orphaned background tasks", async () => {
  let reported = emptyRuntimeActivity();
  const f = await temporaryRuntime(() => Promise.resolve(reported));
  try {
    const initialActivity = await f.runtime.sourceUpdateActivity();
    assert.equal(initialActivity.busy, false, JSON.stringify(initialActivity));
    for (const field of ["quarantinedTurns", "queuedTurns", "activeTurns", "pendingInteractions", "backgroundTasks", "uncertain"]) {
      reported = { ...emptyRuntimeActivity(), [field]: field === "uncertain" ? true : 1 };
      assert.equal((await f.runtime.sourceUpdateActivity()).busy, true, field);
    }
    reported = { total: 0 };
    assert.equal((await f.runtime.sourceUpdateActivity()).busy, true, "incomplete activity is uncertain");
    reported = emptyRuntimeActivity();
    const unregister = registerBackgroundAgentTask({ taskId: "source-update-orphan", controller: new AbortController() });
    assert.equal((await f.runtime.sourceUpdateActivity()).busy, true);
    unregister();
    const unregisterTerminal = registerBackgroundTerminalTask({ taskId: "source-update-terminal", cwd: f.cwd, status: "running", pid: process.pid });
    try {
      assert.equal((await f.runtime.sourceUpdateActivity()).busy, true);
      updateBackgroundTerminalTask("source-update-terminal", { status: "completed", exitCode: 0 });
    } finally { unregisterTerminal(); }
    await fs.mkdir(path.join(f.cwd, ".lab-agent/tasks"), { recursive: true });
    await fs.writeFile(path.join(f.cwd, ".lab-agent/tasks/broken.json"), "{");
    assert.equal((await f.runtime.sourceUpdateActivity()).busy, true, "corrupt records must not disappear like list views");
  } finally { await f.cleanup(); }
});

test("busy prepare refuses without cancelling or shutting down and restores admission", async () => {
  const f = await temporaryRuntime(async () => ({ ...emptyRuntimeActivity(), quarantinedTurns: 1 }));
  let released = false, closed = false;
  try {
    await assert.rejects(prepareDashboardSourceUpdateShutdown(f.runtime,
      { jobId: "prepared-only", releaseWorker: async () => { released = true; } }, () => { closed = true; }), { code: "ACTIVE_WORK" });
    assert.equal(released, false);
    assert.equal(closed, false);
    assert.equal(f.runtime.sourceUpdateMaintenanceActive(), false);
    assert.equal(f.runtime.sourceUpdateShutdownStarted(), false);
  } finally { await f.cleanup(); }
});

test("pending operation admitted before gate is busy, not force-cancelled", async () => {
  const f = await temporaryRuntime();
  const gate = createSourceUpdateMaintenance(f.runtime.active);
  const admitted = Promise.withResolvers<string>();
  const operation = gate.wrap(() => admitted.promise, true);
  const pending = operation();
  const restore = gate.enter();
  try {
    assert.equal(gate.pending, 1);
    assert.equal((await operation()).code, "SOURCE_UPDATE_MAINTENANCE");
    assert.equal(gate.pending, 1, "rejected admissions cannot untrack admitted work");
    admitted.resolve("finished normally");
    assert.equal(await pending, "finished normally");
    assert.equal(gate.pending, 0);
  } finally { admitted.resolve("cleanup"); await pending; restore(); await f.cleanup(); }
});

test("successful prepared handoff safely shuts runtime, then releases worker, then closes HTTP", async () => {
  const f = await temporaryRuntime();
  const order = [];
  try {
    await prepareDashboardSourceUpdateShutdown(f.runtime, { jobId: "worker-prepared", releaseWorker: async () => {
      assert.equal(f.runtime.sourceUpdateMaintenanceActive(), true);
      assert.equal(f.runtime.sourceUpdateShutdownStarted(), true);
      order.push("release");
    } }, () => order.push("close"));
    assert.deepEqual(order, ["release", "close"]);
    assert.equal(f.runtime.sourceUpdateMaintenanceActive(), true);
  } finally { await f.cleanup(); }
});

for (const releaseState of ["idle", "busy", "dirty"]) {
  test(`manager release rechecks real post-shutdown activity and repository: ${releaseState}`, { timeout: 60_000 }, async (t) => {
    const f = await fixture();
    const project = path.join(f.parent, "project");
    await fs.mkdir(project);
    // No lifecycleActivity/getActivity stub: exercise the actual runtime reader,
    // maintenance accounting and shutdown, independently of the source clone.
    const runtime = createDashboardRuntime({ cwd: project, env: {} });
    const target = await f.advance(), plan = f.plan(target);
    const store = new StateStore(f.root);
    const order = [], activityAfterShutdown = [];
    let closed = false, spawned = 0, releaseRevalidations = 0;
    let releaseError;
    let unregister = () => {};
    let workerPrepared = Promise.resolve();
    let manager;
    const revalidate = Repository.prototype.revalidate;
    t.mock.method(Repository.prototype, "revalidate", async function (input) {
      if (runtime.sourceUpdateShutdownStarted()) releaseRevalidations++;
      return revalidate.call(this, input);
    });
    // Replace only network plan discovery and detached worker creation. Official
    // upstream/config/clean-tree/target policy and every revalidate remain real Git.
    t.mock.method(Repository.prototype, "check", async () => plan);
    const spawn = childProcess.spawn;
    const worker = t.mock.method(childProcess, "spawn", function (file, args, options) {
      if (args?.[0] !== path.join(options?.cwd ?? "", "worker", "worker-entry.ts")) return spawn(file, args, options);
      assert.ok(options.cwd.startsWith(store.root + path.sep));
      spawned++;
      const child = new EventEmitter();
      child.pid = process.pid; // Liveness only; no process is created or signalled.
      child.unref = () => {};
      child.stdin = new EventEmitter();
      child.stdin.end = (text) => {
        assert.deepEqual(JSON.parse(text), direct);
        workerPrepared = (async () => {
          const journal = await store.journal();
          assert.ok(journal);
          journal.step = "prepared";
          await store.writeJournal(journal);
        })();
      };
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });
    syncBuiltinESMExports();
    try {
      manager = await SourceUpdateManager.create({ sourceRoot: f.root, projectCwd: project,
        host: "127.0.0.1", actualPort: 46328, env: f.env, strictRestartSupported: true,
        getActivity: async () => {
          const activity = await runtime.sourceUpdateActivity();
          if (runtime.sourceUpdateShutdownStarted()) { activityAfterShutdown.push(activity); order.push("release-activity"); }
          return activity;
        },
        prepareShutdown: (handoff) => prepareDashboardSourceUpdateShutdown(runtime, { ...handoff, releaseWorker: async () => {
          assert.equal(runtime.sourceUpdateShutdownStarted(), true);
          assert.equal(runtime.sourceUpdateMaintenanceActive(), true);
          assert.deepEqual(await runtime.sourceUpdateActivity(), { busy: false, reasons: [] });
          order.push("shutdown-idle");
          if (releaseState === "busy") unregister = registerBackgroundAgentTask({
            taskId: `source-update-release-${handoff.jobId}`, controller: new AbortController() });
          if (releaseState === "dirty") await f.put("late-change.txt", "must prevent handoff");
          try { await handoff.releaseWorker(); } // Actual manager assertIdle + Repository.revalidate.
          catch (error) { releaseError = error; throw error; }
          order.push("released");
        } }, () => { closed = true; order.push("close"); })
      });
      manager.check({ allowDirect: true });
      await manager.settled();
      assert.equal((await manager.snapshot()).phase, "ready");
      const { jobId } = manager.start({ planId: plan.id });
      await manager.settled();
      await workerPrepared;
      assert.equal(spawned, 1);
      assert.equal(runtime.sourceUpdateShutdownStarted(), true);
      assert.equal(runtime.sourceUpdateMaintenanceActive(), true);
      assert.equal(activityAfterShutdown.length, 1, "release must call actual manager assertIdle after real shutdown");
      assert.equal(activityAfterShutdown[0].busy, releaseState === "busy");
      assert.equal(releaseRevalidations, releaseState === "busy" ? 0 : 1);
      const permit = await readJson(path.join(store.jobDirectory(jobId), "handoff.json"));
      const journal = await store.journal(jobId);
      if (releaseState === "idle") {
        assert.equal(releaseError, undefined);
        assert.deepEqual(permit, { nonce: journal.nonce });
        assert.deepEqual(order, ["shutdown-idle", "release-activity", "released", "close"]);
        assert.equal(closed, true);
      } else {
        assert.equal(permit, null);
        assert.equal(closed, false);
        assert.equal(releaseError?.code, releaseState === "busy" ? "ACTIVE_WORK" : "DIRTY_WORKTREE");
        assert.deepEqual(order, ["shutdown-idle", "release-activity"]);
      }
      assert.equal(await f.git("rev-parse", "HEAD"), f.head, "handoff tests must not update any source tree");
      unregister();
      assert.deepEqual(await runtime.sourceUpdateActivity(), { busy: false, reasons: [] });
    } finally {
      unregister();
      worker.mock.restore();
      syncBuiltinESMExports();
      await workerPrepared;
      await manager?.dispose();
      await runtime.shutdown({});
      await f.cleanup();
    }
  });
}

test("release failure after runtime disposal stays gated and never closes old HTTP", async () => {
  const f = await temporaryRuntime();
  let closed = false;
  try {
    await assert.rejects(prepareDashboardSourceUpdateShutdown(f.runtime,
      { jobId: "prepared", releaseWorker: async () => { throw new Error("permit failed"); } }, () => { closed = true; }), /permit failed/);
    assert.equal(closed, false);
    assert.equal(f.runtime.sourceUpdateMaintenanceActive(), true);
    assert.equal(f.runtime.sourceUpdateShutdownStarted(), true);
    assert.equal((await f.runtime.startTurn({ prompt: "no unsafe restore" })).code, "SOURCE_UPDATE_MAINTENANCE");
  } finally { await f.cleanup(); }
});

test("autonomous queue admission is blocked while maintenance is held", async () => {
  const f = await temporaryRuntime();
  try {
    const session = await createSession({ cwd: f.cwd, env: {} });
    const state = createTurnState(session);
    state.workAdmissionBlocked = () => f.runtime.sourceUpdateMaintenanceActive();
    const restore = f.runtime.beginSourceUpdateMaintenance();
    try {
      assert.equal(beginPrompt(state, { id: "queued", prompt: "no", permissionMode: "plan" }, {}), false);
      assert.equal(state.running, false);
    } finally { restore(); }
  } finally { await f.cleanup(); }
});

test("lease disposed once on ordinary server close and error path", async () => {
  for (const error of [false, true]) {
    let disposed = 0;
    const server = createDashboardServer({ cwd: process.cwd(), runtime: {}, boot,
      sourceUpdateManager: { ...fakeManager(), dispose: async () => { disposed++; } } });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    if (error) server.emit("error", new Error("test-only"));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await server.disposeSourceUpdate();
    assert.equal(disposed, 1);
  }
});

for (const stage of ["config", "manager", "ack"]) {
  test(`startup ${stage} failure never leaves a listener or manager lease`, async () => {
    const port = await unusedPort();
    let acks = 0, disposed = 0;
    const shutdowns = [];
    const failure = new Error(`${stage} failed`);
    const runtime = {
      env: {},
      sourceUpdateConfig: async () => { if (stage === "config") throw failure; return {}; },
      shutdown: async (input) => { shutdowns.push(input); return { ok: true }; }
    };
    await assert.rejects(startDashboard({ cwd: process.cwd(), port, strictPort: true, open: false, runtime,
      sourceUpdate: {
        captureBoot: async () => boot,
        createManager: async () => {
          if (stage === "manager") throw failure;
          return { ...fakeManager(), dispose: async () => { disposed++; } };
        },
        acknowledge: async () => { acks++; throw failure; }
      }
    }), failure);
    assert.equal(acks, stage === "ack" ? 1 : 0);
    assert.equal(disposed, stage === "ack" ? 1 : 0);
    assert.deepEqual(shutdowns, [{}], "startup cleanup must not force/cancel runtime work");
    const probe = http.createServer();
    await listenOnAvailablePort(probe, { host: "127.0.0.1", port, strictPort: true });
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  });
}

test("ACK waits for deferred config and manager initialization", async () => {
  const port = await unusedPort();
  const config = Promise.withResolvers<Record<string, unknown>>();
  const manager = Promise.withResolvers<ReturnType<typeof fakeManager>>();
  const configEntered = Promise.withResolvers<void>();
  const managerEntered = Promise.withResolvers<void>();
  let acks = 0;
  const runtime = { env: {}, sourceUpdateConfig: () => { configEntered.resolve(); return config.promise; },
    shutdown: async () => ({ ok: true }) };
  const starting = startDashboard({ cwd: process.cwd(), port, strictPort: true, open: false, runtime,
    sourceUpdate: {
      captureBoot: async () => boot,
      createManager: async (input) => { assert.deepEqual(input.config, { initialized: true }); managerEntered.resolve(); return manager.promise; },
      acknowledge: async () => { acks++; return true; }
    }
  });
  try {
    await configEntered.promise;
    assert.equal(acks, 0);
    config.resolve({ initialized: true });
    await managerEntered.promise;
    assert.equal(acks, 0);
    manager.resolve(fakeManager());
    const result = await starting;
    assert.equal(acks, 1);
    assert.equal(result.server.listening, true);
    await new Promise<void>((resolve) => result.server.close(() => resolve()));
    await result.server.disposeSourceUpdate();
  } finally { config.resolve({ initialized: true }); manager.resolve(fakeManager()); await starting.catch(() => {}); }
});

test("strict startup occupied-port failure skips manager and ACK without forcing shutdown", async () => {
  const blocker = http.createServer();
  await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const shutdowns = [];
  let initialized = 0;
  try {
    await assert.rejects(startDashboard({ cwd: process.cwd(), port: blocker.address().port, strictPort: true, open: false,
      runtime: { env: {}, shutdown: async (input) => { shutdowns.push(input); return { ok: true }; } },
      sourceUpdate: { captureBoot: async () => boot,
        createManager: async () => { initialized++; return fakeManager(); },
        acknowledge: async () => { initialized++; return true; } }
    }), { code: "EADDRINUSE" });
    assert.equal(initialized, 0);
    assert.deepEqual(shutdowns, [{}]);
    assert.equal(blocker.listening, true);
  } finally { await new Promise<void>((resolve) => blocker.close(() => resolve())); }
});

test("normal startup fallback initializes and acknowledges the actual selected port", async () => {
  const blocker = http.createServer();
  await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const port = blocker.address().port;
  const selected = [];
  let result;
  try {
    result = await startDashboard({ cwd: process.cwd(), port, open: false, env: {},
      runtime: { env: {}, sourceUpdateConfig: async () => ({}), shutdown: async () => ({ ok: true }) },
      sourceUpdate: { captureBoot: async () => boot,
        createManager: async (input) => { selected.push(input.actualPort); assert.equal(input.strictRestartSupported, true); return fakeManager(); },
        acknowledge: async (input) => { selected.push(input.actualPort); assert.equal(input.strictPort, false); return false; } }
    });
    assert.ok(result.port > port);
    assert.equal(result.server.address().port, result.port);
    assert.deepEqual(selected, [result.port, result.port]);
  } finally {
    if (result) { await new Promise<void>((resolve) => result.server.close(() => resolve())); await result.server.disposeSourceUpdate(); }
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  }
});

test("maintenance preserves synchronous controls and asynchronous rejection contracts", async () => {
  const f = await temporaryRuntime();
  const restore = f.runtime.beginSourceUpdateMaintenance();
  try {
    for (const result of [f.runtime.resolveApproval("missing", "allow-once"), f.runtime.resolveQuestion("missing"),
      f.runtime.interruptTurn("missing"), f.runtime.cancelQueuedTurn({}), f.runtime.guideTurn({})]) {
      assert.equal(typeof result.then, "undefined");
      assert.equal(result.code, "SOURCE_UPDATE_MAINTENANCE");
    }
    for (const pending of [f.runtime.status({}), f.runtime.saveSettingsConfig({}), f.runtime.createSchedule({})]) {
      assert.equal(typeof pending.then, "function");
      assert.equal((await pending).code, "SOURCE_UPDATE_MAINTENANCE");
    }
    const gate = createSourceUpdateMaintenance(new Map());
    const failure = new Error("admitted failure");
    assert.throws(gate.wrap(() => { throw failure; }), failure);
    assert.equal(gate.pending, 0);
    await assert.rejects(gate.wrap(async () => { throw failure; })(), failure);
    assert.equal(gate.pending, 0);
  } finally { restore(); await f.cleanup(); }
});

for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  test(`Dashboard ${signal} waits for dispose once without touching runtime shutdown`, async () => {
    const target = new EventEmitter();
    const disposed = Promise.withResolvers<void>();
    const exited = Promise.withResolvers<number>();
    const exits = [];
    target.exit = (value) => { exits.push(value); exited.resolve(value); };
    let disposals = 0, shutdowns = 0;
    const server = createDashboardServer({ cwd: process.cwd(), boot,
      runtime: { shutdown: () => { shutdowns++; } },
      sourceUpdateManager: { ...fakeManager(), dispose: async () => { disposals++; await disposed.promise; } } });
    const cleanup = installDashboardSourceUpdateSignalHandlers(server, target);
    try {
      target.emit(signal);
      target.emit(signal === "SIGINT" ? "SIGTERM" : "SIGINT");
      await Promise.resolve();
      assert.equal(disposals, 1);
      assert.equal(shutdowns, 0);
      assert.deepEqual(exits, []);
      disposed.resolve();
      assert.equal(await exited.promise, code);
      assert.deepEqual(exits, [code]);
      assert.equal(target.listenerCount("SIGINT"), 0);
      assert.equal(target.listenerCount("SIGTERM"), 0);
      await server.disposeSourceUpdate();
      assert.equal(disposals, 1);
    } finally { disposed.resolve(); cleanup(); }
  });
}

test("ordinary Dashboard close removes only its signal handlers", async () => {
  const target = new EventEmitter();
  const unrelated = () => {};
  target.on("SIGINT", unrelated);
  const server = createDashboardServer({ cwd: process.cwd(), runtime: {}, boot });
  installDashboardSourceUpdateSignalHandlers(server, target);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  assert.deepEqual(target.listeners("SIGINT"), [unrelated]);
  assert.equal(target.listenerCount("SIGTERM"), 0);
});