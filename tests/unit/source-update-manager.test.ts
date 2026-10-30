import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { SourceUpdateManager } from "../../src/update/manager.ts";
import { Repository } from "../../src/update/repository.ts";
import { StateStore, atomicJson, readJson } from "../../src/update/state-store.ts";
import { fixture, makeJob } from "../helpers/source-update/fixture.ts";
import type { SourceUpdateOptions } from "../../src/update/manager.ts";

async function managerFor(f: Awaited<ReturnType<typeof fixture>>, overrides: Partial<SourceUpdateOptions> = {}) {
  const manager = await SourceUpdateManager.create({ sourceRoot: f.root, projectCwd: f.root,
    host: "127.0.0.1", actualPort: 46328, env: f.env, strictRestartSupported: true,
    getActivity: () => ({ busy: false }), prepareShutdown: async () => { throw new Error("Must not shut down test runner"); }, ...overrides });
  f.own(() => manager.dispose());
  return manager;
}

test("GET snapshot is local-only, cloned and exposes immutable boot, not journal secrets", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const manager = await managerFor(f);
  t.mock.method(Repository.prototype, "git", async () => { assert.fail("GET must not invoke Git/network"); });
  t.mock.method(globalThis, "fetch", async () => { assert.fail("GET must not fetch"); });
  const snapshot = await manager.snapshot();
  snapshot.boot.productVersion = "forged"; snapshot.limitations.length = 0;
  const fresh = await manager.snapshot();
  assert.equal(fresh.boot.productVersion, "0.0.1"); assert.equal(fresh.boot.bootCommit, f.head);
  assert.ok(fresh.limitations.length); assert.equal(fresh.phase, "idle");
  assert.ok(!JSON.stringify(fresh).includes(f.root));
  assert.equal(await readJson(path.join(f.root, ".git/ant-source-update/latest.json")), null);
});

test("GET reports interrupted worker as manual recovery without exposing private journal fields", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const manager = await managerFor(f);
  const { store, journal } = await makeJob(f, f.head, 0);
  journal.workerPid = 2147483647; await store.writeJournal(journal);
  const snapshot = await manager.snapshot();
  assert.equal(snapshot.phase, "manualRecovery");
  assert.equal(snapshot.message, "WORKER_INTERRUPTED_INSPECT_JOURNAL");
  assert.ok(!JSON.stringify(snapshot).includes(journal.nonce));
  assert.ok(!JSON.stringify(snapshot).includes(f.root));
  assert.throws(() => manager.check({ allowDirect: true }), /UPDATE_BUSY/);
  assert.ok(await readJson(path.join(store.root, "update.lock")));
});

test("check returns immediately, rejects duplicate check/start while checking, and GET does not run check", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const manager = await managerFor(f, { getActivity: () => ({ busy: true }) });
  t.mock.method(Repository.prototype, "check", async () => { await gate; return f.plan(f.head); });
  assert.deepEqual(manager.check({ allowDirect: true }), { accepted: true });
  assert.equal((await manager.snapshot()).phase, "checking");
  assert.throws(() => manager.check(), /UPDATE_BUSY/);
  assert.throws(() => manager.start({ planId: randomUUID() }), /UPDATE_BUSY/);
  release(); await manager.settled();
  assert.equal((await manager.snapshot()).phase, "upToDate");
});

test("missing upstream blocks check BEFORE transport and cannot create a worker job", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  await f.git("config", "--unset", "branch.main.remote");
  const manager = await managerFor(f);
  t.mock.method(Repository.prototype, "check", async () => { assert.fail("No upstream: no fetch/ls-remote"); });
  manager.check({ allowDirect: true }); await manager.settled();
  assert.equal((await manager.snapshot()).phase, "blocked");
  assert.throws(() => manager.start({ planId: randomUUID() }), /PLAN_STALE/);
  const store = new StateStore(f.root);
  assert.equal(await store.journal(), null);
  assert.equal(await readJson(path.join(store.root, "update.lock")), null);
});

test("active work allows checking but prevents installation without stopping work", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const plan = f.plan(await f.advance());
  const manager = await managerFor(f, { getActivity: () => ({ busy: true }) });
  t.mock.method(Repository.prototype, "check", async () => plan);
  manager.check({ allowDirect: true }); await manager.settled();
  assert.equal((await manager.snapshot()).phase, "ready");
  manager.start({ planId: plan.id }); await manager.settled();
  assert.equal((await manager.snapshot()).message, "ACTIVE_WORK");
  assert.equal(await new StateStore(f.root).journal(), null);
  assert.equal(await f.git("rev-parse", "HEAD"), f.head);
});

test("plan is server-owned and single-use; changed tree prevents spawn; strict restart remains gated", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const target = await f.advance(); const plan = f.plan(target);
  // Only network discovery is substituted. Pre-start revalidation is real Git.
  t.mock.method(Repository.prototype, "check", async () => plan);
  const manager = await managerFor(f);
  assert.throws(() => manager.check({ command: "ignored" } as never), /INVALID_CHECK_INPUT/);
  manager.check({ allowDirect: true }); await manager.settled();
  assert.equal((await manager.snapshot()).phase, "ready");
  assert.throws(() => manager.start({ planId: plan.id, target } as never), /INVALID_START_INPUT/);
  assert.throws(() => manager.start({ planId: randomUUID() }), /PLAN_STALE/);
  const publicSnapshot = await manager.snapshot(); publicSnapshot.plan!.id = "client-owned";
  await f.put("changed.txt", "user data");
  assert.equal(manager.start({ planId: plan.id }).accepted, true);
  assert.throws(() => manager.start({ planId: plan.id }), /UPDATE_BUSY/);
  await manager.settled();
  assert.equal((await manager.snapshot()).message, "DIRTY_WORKTREE");
  assert.throws(() => manager.start({ planId: plan.id }), /PLAN_STALE/);
  assert.equal(await new StateStore(f.root).journal(), null);
  assert.equal(await f.git("rev-parse", "HEAD"), f.head);
  assert.equal(await fs.readFile(path.join(f.root, "changed.txt"), "utf8"), "user data");
  await fs.unlink(path.join(f.root, "changed.txt")); await manager.dispose();
  const gated = await managerFor(f, { strictRestartSupported: false });
  gated.check({ allowDirect: true }); await gated.settled();
  assert.throws(() => gated.start({ planId: plan.id }), /STRICT_RESTART_REQUIRED/);
});

test("expired plan cannot start; repeated check replaces the previous plan", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const target = await f.advance(); let plan = f.plan(target);
  t.mock.method(Repository.prototype, "check", async () => plan);
  const manager = await managerFor(f);
  manager.check({ allowDirect: true }); await manager.settled(); const previous = plan;
  plan = { ...f.plan(target), expiresAt: Date.now() - 1 };
  manager.check({ allowDirect: true }); await manager.settled();
  assert.throws(() => manager.start({ planId: previous.id }), /PLAN_STALE/);
  assert.throws(() => manager.start({ planId: plan.id }), /PLAN_STALE/);
  assert.equal(await new StateStore(f.root).journal(), null);
});

test("another live lease does not block checking but blocks installation before spawn", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const target = await f.advance(); const plan = f.plan(target);
  let checks = 0; t.mock.method(Repository.prototype, "check", async () => { checks++; return plan; });
  const manager = await managerFor(f); const store = new StateStore(f.root), other = randomUUID();
  await store.registerLease(other);
  manager.check({ allowDirect: true }); await manager.settled();
  assert.equal((await manager.snapshot()).phase, "ready"); assert.equal(checks, 1);
  await store.removeLease(other);
  manager.check({ allowDirect: true }); await manager.settled(); assert.equal(checks, 2);
  await store.registerLease(other);
  manager.start({ planId: plan.id }); await manager.settled();
  assert.equal((await manager.snapshot()).message, "OTHER_DASHBOARD_RUNNING");
  assert.equal(await store.journal(), null);
});

for (const previousPhase of ["succeeded", "failed"] as const) {
  test(`historical ${previousPhase} journal cannot replace a new blocked check or pre-journal failed job`, async (t) => {
    const f = await fixture(); t.after(f.cleanup);
    const target = await f.advance(); const plan = f.plan(target);
    const { store, journal } = await makeJob(f, target, 0);
    journal.phase = previousPhase; journal.step = "acknowledged"; journal.error = "HISTORICAL_REASON";
    await store.writeJournal(journal); await store.release(journal.jobId);
    let busy = false;
    const manager = await managerFor(f, { getActivity: () => ({ busy }) });
    assert.equal((await manager.snapshot()).jobId, journal.jobId); // initial restore is allowed
    await f.put("changed.txt", "local work");
    busy = true; manager.check({ allowDirect: true }); await manager.settled();
    assert.equal((await manager.snapshot()).phase, "blocked");
    assert.equal((await manager.snapshot()).message, "DIRTY_WORKTREE");
    assert.equal((await manager.snapshot()).jobId, undefined);
    busy = false;
    await fs.unlink(path.join(f.root, "changed.txt"));
    t.mock.method(Repository.prototype, "check", async () => plan);
    manager.check({ allowDirect: true }); await manager.settled();
    await f.put("changed.txt", "new user work");
    const started = manager.start({ planId: plan.id }); await manager.settled();
    const result = await manager.snapshot();
    assert.equal(result.phase, "failed"); assert.equal(result.message, "DIRTY_WORKTREE");
    assert.equal(result.jobId, started.jobId); assert.notEqual(result.jobId, journal.jobId);
    assert.equal(await store.journal(started.jobId), null);
    assert.equal((await store.journal())?.jobId, journal.jobId);
  });
}

for (const restored of [false, true]) {
  test(`pending historical snapshot cannot overwrite a concurrent check/start (restored=${restored})`, async (t) => {
    const f = await fixture(); t.after(f.cleanup);
    const target = await f.advance(), plan = f.plan(target);
    const { store, journal } = await makeJob(f, target, 0);
    journal.phase = "succeeded"; journal.step = "acknowledged";
    await store.writeJournal(journal); await store.release(journal.jobId);
    const manager = await managerFor(f);
    if (restored) assert.equal((await manager.snapshot()).jobId, journal.jobId);
    const gate = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => { resolve = done; });
      return { promise, resolve };
    };
    const entered = gate(), release = gate();
    const original = StateStore.prototype.journal;
    let delay = true;
    t.mock.method(StateStore.prototype, "journal", async function (this: StateStore, jobId?: string) {
      const result = await original.call(this, jobId);
      if (delay && result?.jobId === journal.jobId) {
        delay = false; entered.resolve(); await release.promise;
      }
      return result;
    });
    t.after(() => release.resolve());
    const pending = manager.snapshot(); await entered.promise;
    t.mock.method(Repository.prototype, "check", async () => plan);
    manager.check({ allowDirect: true }); await manager.settled();
    await f.put("changed.txt", "concurrent local work");
    const started = manager.start({ planId: plan.id }); await manager.settled();
    release.resolve();
    const result = await pending;
    assert.equal(result.phase, "failed");
    assert.equal(result.message, "DIRTY_WORKTREE");
    assert.equal(result.jobId, started.jobId);
    assert.notEqual(result.jobId, journal.jobId);
  });
}

test("manager fixes only supported config/home paths at capture, without mutating caller env or journaling secrets", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const keys = ["LAB_AGENT_CONFIG", "LAB_AGENT_HOME", "HOME", "USERPROFILE", "APPDATA", "XDG_CONFIG_HOME"];
  const env: NodeJS.ProcessEnv = { ...f.env, PRIVATE_TEST_TOKEN: "not-for-journal", ANT_CODE_HOME: "unsupported-relative" };
  for (const key of keys) env[key] = key === "LAB_AGENT_CONFIG" ? "  relative/config.json  " : `relative/${key}`;
  const manager = await managerFor(f, { env });
  // Inspect the capture boundary without exposing an environment accessor in production.
  const captured = (manager as unknown as { options: SourceUpdateOptions }).options.env!;
  for (const key of keys) {
    assert.equal(captured[key], path.resolve(process.cwd(), env[key]!.trim()));
    assert.equal(env[key]?.startsWith("relative/") || env[key]?.startsWith("  relative/"), true);
  }
  assert.equal(captured.ANT_CODE_HOME, "unsupported-relative");
  assert.equal(captured.PRIVATE_TEST_TOKEN, env.PRIVATE_TEST_TOKEN);
  assert.equal(await new StateStore(f.root).journal(), null);
});

test("stale update lock is never stolen; release must match its job; check stays offline", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const manager = await managerFor(f); const store = new StateStore(f.root), jobId = randomUUID();
  await atomicJson(path.join(store.root, "update.lock"), { jobId, pid: 0 });
  await assert.rejects(store.acquire(randomUUID()), { code: "UPDATE_LOCKED" });
  await store.release(randomUUID());
  assert.deepEqual(await readJson(path.join(store.root, "update.lock")), { jobId, pid: 0 });
  t.mock.method(Repository.prototype, "inspect", async () => { assert.fail("Lock blocks before repository/network"); });
  manager.check({ allowDirect: true }); await manager.settled();
  assert.equal((await manager.snapshot()).message, "UPDATE_LOCKED");
  await store.release(jobId); assert.equal(await readJson(path.join(store.root, "update.lock")), null);
});
