import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { captureBootSnapshot, acknowledgeSourceUpdate } from "../../src/update/boot.ts";
import { validateRestartAck, restartArguments } from "../../src/update/worker.ts";
import { readJson } from "../../src/update/state-store.ts";
import { fixture, makeJob } from "../helpers/source-update/fixture.ts";

test("boot identity/version is a frozen startup snapshot, not the current source HEAD", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const boot = await captureBootSnapshot(f.root, f.env);
  assert.ok(Object.isFrozen(boot)); assert.equal(boot.bootCommit, f.head);
  await f.put("package.json", JSON.stringify({ name: "@ant-code/cli", version: "0.0.2" }));
  const next = await f.commit("new version");
  assert.equal(boot.productVersion, "0.0.1"); assert.equal(boot.bootCommit, f.head);
  const fresh = await captureBootSnapshot(f.root, f.env);
  assert.equal(fresh.productVersion, "0.0.2"); assert.equal(fresh.bootCommit, next);
  assert.notEqual(fresh.instanceId, boot.instanceId);
});

test("worker ACK validator rejects forged nonce/SHA/instance/PID/host/port and malformed objects", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const { journal } = await makeJob(f, f.head, 0); journal.childPid = process.pid;
  const valid = { nonce: journal.nonce, commit: f.head, instanceId: randomUUID(), pid: process.pid,
    host: journal.restart.host, port: journal.restart.port };
  validateRestartAck(valid, journal);
  for (const value of [null, {}, true, { ...valid, nonce: randomUUID() }, { ...valid, commit: "0".repeat(40) },
    { ...valid, instanceId: journal.boot.instanceId }, { ...valid, instanceId: undefined }, { ...valid, instanceId: 1 },
    { ...valid, pid: 0 }, { ...valid, pid: String(process.pid) }, { ...valid, host: "localhost" },
    { ...valid, port: valid.port + 1 }, { ...valid, port: String(valid.port) }]) {
    assert.throws(() => validateRestartAck(value, journal), /INVALID_RESTART_ACK/);
  }
  delete journal.childPid;
  assert.throws(() => validateRestartAck(valid, journal), /INVALID_RESTART_ACK/);
  for (const restart of [{ ...journal.restart, cli: path.join(f.root, "other.ts") },
    { ...journal.restart, port: 0 }, { ...journal.restart, projectCwd: "relative" }]) {
    assert.throws(() => restartArguments({ ...journal, restart }), /INVALID_RESTART_SPEC/);
  }
});

test("ACK producer fails closed for forged update boots, old service alive, wrong child and changed HEAD", { timeout: 60_000 }, async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const { store, journal } = await makeJob(f, f.head, 0);
  journal.phase = "restarting"; journal.step = "spawned"; journal.workerPid = process.pid; journal.childPid = process.pid;
  const boot = await captureBootSnapshot(f.root, f.env);
  const env = { ...f.env, ANT_SOURCE_UPDATE_JOB: journal.jobId, ANT_SOURCE_UPDATE_ROOT: f.root, ANT_SOURCE_UPDATE_NONCE: journal.nonce };
  const options = { sourceRoot: f.root, boot, host: journal.restart.host, actualPort: journal.restart.port, strictPort: true, env };
  const ackFile = path.join(store.jobDirectory(journal.jobId), "ack.json");
  await store.writeJournal(journal);
  assert.equal(await acknowledgeSourceUpdate({ ...options, env: f.env }), false);
  for (const invalid of [{ ...options, strictPort: false }, { ...options, env: { ...env, ANT_SOURCE_UPDATE_NONCE: randomUUID() } },
    { ...options, env: { ...env, ANT_SOURCE_UPDATE_ROOT: f.parent } }, { ...options, host: "localhost" },
    { ...options, actualPort: options.actualPort + 1 }, { ...options, boot: { ...boot, bootCommit: "0".repeat(40) } },
    { ...options, boot: { ...boot, instanceId: journal.boot.instanceId } }]) {
    await assert.rejects(acknowledgeSourceUpdate(invalid), /INVALID_UPDATE_BOOT/);
    assert.equal(await readJson(ackFile), null);
  }
  for (const patch of [{ oldPid: process.pid }, { workerPid: 0 }, { childPid: 0 }, { phase: "succeeded" as const }, { step: "prepared" as const }]) {
    await store.writeJournal({ ...journal, ...patch });
    await assert.rejects(acknowledgeSourceUpdate(options), /INVALID_UPDATE_BOOT/);
    assert.equal(await readJson(ackFile), null);
  }
  await store.writeJournal(journal);
  await f.put("new-head.txt", "changed after boot"); await f.commit("changed head");
  await assert.rejects(acknowledgeSourceUpdate(options), /INVALID_UPDATE_BOOT/);
  assert.equal(await readJson(ackFile), null);
});

test("same SHA with changed working tree or hidden index cannot ACK; exact clean boot can ACK", { timeout: 45_000 }, async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const { store, journal } = await makeJob(f, f.head, 0);
  journal.phase = "restarting"; journal.step = "spawned"; journal.workerPid = process.pid; journal.childPid = process.pid;
  await store.writeJournal(journal);
  const boot = await captureBootSnapshot(f.root, f.env);
  const options = { sourceRoot: f.root, boot, host: journal.restart.host, actualPort: journal.restart.port, strictPort: true,
    env: { ...f.env, ANT_SOURCE_UPDATE_JOB: journal.jobId, ANT_SOURCE_UPDATE_ROOT: f.root, ANT_SOURCE_UPDATE_NONCE: journal.nonce } };
  const ackFile = path.join(store.jobDirectory(journal.jobId), "ack.json");
  const pkg = await fs.readFile(path.join(f.root, "package.json"), "utf8");
  await f.put("package.json", `${pkg}\n`);
  await assert.rejects(acknowledgeSourceUpdate(options), /DIRTY_WORKTREE/);
  assert.equal(await readJson(ackFile), null); assert.equal(await f.git("rev-parse", "HEAD"), f.head);
  await f.put("package.json", pkg);
  await f.git("update-index", "--assume-unchanged", "package.json");
  await assert.rejects(acknowledgeSourceUpdate(options), /skip-worktree/);
  assert.equal(await readJson(ackFile), null);
  await f.git("update-index", "--no-assume-unchanged", "package.json");
  assert.equal(await acknowledgeSourceUpdate(options), true);
  const ack = await readJson(ackFile); validateRestartAck(ack, journal);
  assert.deepEqual(ack, { nonce: journal.nonce, instanceId: boot.instanceId, commit: f.head, pid: process.pid,
    host: options.host, port: options.actualPort });
});
