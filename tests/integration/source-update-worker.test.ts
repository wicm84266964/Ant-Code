import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fixture, makeJob, startSnapshotWorker, copyUpdateModules, moduleRoot, ownChild, stopFixtureRuntime } from "../helpers/source-update/fixture.ts";
import { atomicJson, isAlive, readJson } from "../../src/update/state-store.ts";
import { waitFor, runUpdateWorker, restartArguments } from "../../src/update/worker.ts";
import { runProcess } from "../../src/update/process.ts";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function oldRuntime(f: Awaited<ReturnType<typeof fixture>>) {
  const child = spawn(process.execPath, ["-e", "const s=require('node:http').createServer((q,r)=>r.end('old runtime'));s.listen(0,'127.0.0.1',()=>console.log(s.address().port))"], {
    stdio: ["ignore", "pipe", "ignore"], windowsHide: true
  });
  const owned = ownChild(child); f.own(owned.stop);
  const listening = once(child.stdout, "data", { signal: AbortSignal.timeout(5000) });
  await once(child, "spawn");
  const [data] = await listening;
  const port = Number(data.toString().trim()); assert.ok(port > 0);
  return { pid: child.pid!, stop: owned.stop, port, url: `http://127.0.0.1:${port}` };
}
test("detached built-in-only snapshot: npm engine failure leaves old runtime/source/dependencies intact", { timeout: 45_000 }, async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const target = await f.advance({ "package.json": JSON.stringify({ name: "@ant-code/cli", version: "0.0.2", type: "module", engines: { node: ">=999" } }) });
  await fs.mkdir(path.join(f.root, "node_modules")); await fs.writeFile(path.join(f.root, "node_modules", "old-marker"), "old dependencies");
  const old = await oldRuntime(f);
  const { store, journal } = await makeJob(f, target, old.pid);
  f.own(() => stopFixtureRuntime(store, journal));
  const worker = await startSnapshotWorker(store, journal, f.env); f.own(worker.stop);
  assert.equal(await worker.exited, 0, worker.stderr());
  const result = await store.journal(journal.jobId);
  assert.equal(result?.phase, "failed"); assert.equal(result?.error, "CANDIDATE_INSTALL_FAILED");
  assert.ok(isAlive(old.pid)); assert.equal(await (await fetch(old.url)).text(), "old runtime");
  assert.equal(await f.git("rev-parse", "HEAD"), f.head);
  assert.equal(await fs.readFile(path.join(f.root, "node_modules", "old-marker"), "utf8"), "old dependencies");
  assert.equal(await readJson(path.join(store.root, "update.lock")), null);
  assert.equal(await readJson(path.join(store.jobDirectory(journal.jobId), "handoff.json")), null);
});
for (const defect of ["missing import", "transitive syntax"] as const) {
  test(`candidate ${defect} fails real static graph load before handoff; old HTTP/HEAD/modules survive`, { timeout: 45_000 }, async (t) => {
    const f = await fixture(); t.after(f.cleanup);
    const files: Record<string, string> = { "src/cli/index.ts": "import './dependency.ts';\nconsole.log('ant-code 0.0.1');\n" };
    if (defect === "transitive syntax") files["src/cli/dependency.ts"] = "export const broken = ;\n";
    const target = await f.advance(files);
    await fs.mkdir(path.join(f.root, "node_modules")); await fs.writeFile(path.join(f.root, "node_modules/old-marker"), "old dependencies");
    const old = await oldRuntime(f);
    const { store, journal } = await makeJob(f, target, old.pid);
    const worker = await startSnapshotWorker(store, journal, f.env); f.own(worker.stop);
    assert.equal(await worker.exited, 0, worker.stderr());
    const result = await store.journal(journal.jobId);
    assert.equal(result?.phase, "failed"); assert.equal(result?.error, "CANDIDATE_LOAD_FAILED");
    assert.equal(result?.step, "preparing"); assert.equal(result?.childPid, undefined);
    assert.ok(isAlive(old.pid)); assert.equal(await (await fetch(old.url)).text(), "old runtime");
    assert.equal(await f.git("rev-parse", "HEAD"), f.head);
    assert.equal(await fs.readFile(path.join(f.root, "node_modules/old-marker"), "utf8"), "old dependencies");
    assert.equal(await readJson(path.join(store.jobDirectory(journal.jobId), "handoff.json")), null);
    assert.equal(await readJson(path.join(store.root, "update.lock")), null);
  });
}

test("detached snapshot survives source/dependency exchange; waits for old exit and requires exact new ACK", { timeout: 60_000 }, async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  await copyUpdateModules(path.join(f.root, "src/update"), true);
  const cli = await fs.readFile(path.join(moduleRoot, "tests/helpers/source-update/new-runtime.ts"), "utf8");
  await f.put("src/cli/index.ts", cli); await f.commit("fixture runtime source");
  const target = await f.git("rev-parse", "HEAD");
  // Candidate commit exists locally; retain base HEAD until worker FF. No public fetch.
  await f.git("checkout", "-b", "old-base", f.head); await f.git("branch", "-f", "main", f.head); await f.git("checkout", "main");
  await fs.mkdir(path.join(f.root, "node_modules")); await fs.writeFile(path.join(f.root, "node_modules", "old-marker"), "old dependencies");
  const old = await oldRuntime(f);
  const { store, journal } = await makeJob(f, target, old.pid);
  journal.restart.port = old.port; await store.writeJournal(journal);
  f.own(() => stopFixtureRuntime(store, journal));
  const worker = await startSnapshotWorker(store, journal, f.env); f.own(worker.stop);
  await waitFor(async () => (await store.journal(journal.jobId))?.step === "prepared", 25_000);
  assert.ok(isAlive(old.pid)); assert.equal(await f.git("rev-parse", "HEAD"), f.head);
  assert.equal(await fs.readFile(path.join(f.root, "node_modules/old-marker"), "utf8"), "old dependencies");
  // Wrong/non-authorized permit cannot shut down/apply.
  await atomicJson(path.join(store.jobDirectory(journal.jobId), "handoff.json"), { nonce: randomUUID() });
  await sleep(250); assert.equal((await store.journal(journal.jobId))?.step, "prepared");
  await atomicJson(path.join(store.jobDirectory(journal.jobId), "handoff.json"), { nonce: journal.nonce });
  await waitFor(async () => (await store.journal(journal.jobId))?.step === "awaitingExit", 5000);
  assert.equal(await f.git("rev-parse", "HEAD"), f.head);
  await old.stop();
  assert.equal(await worker.exited, 0, worker.stderr());
  const result = await store.journal(journal.jobId);
  const runtime = await readJson<{ pid: number; boot: { bootCommit: string; instanceId: string }; args: string[] }>(path.join(f.root, ".git", "new-runtime.json"));
  assert.equal(result?.phase, "succeeded", JSON.stringify(result)); assert.equal(result?.step, "acknowledged");
  assert.equal(await f.git("rev-parse", "HEAD"), target); assert.equal(runtime?.boot.bootCommit, target);
  assert.notEqual(runtime?.boot.instanceId, journal.boot.instanceId);
  assert.deepEqual(runtime?.args, restartArguments(journal).slice(1));
  assert.equal(await (await fetch(old.url)).text(), "fixture"); // exact original listener, no port increment
  assert.equal(await fs.readFile(path.join(journal.backup, "old-marker"), "utf8"), "old dependencies");
  assert.equal(await readJson(path.join(store.root, "update.lock")), null);
});
test("injected FF failure journals exact step, retains dependencies and lock, never resets source", { timeout: 45_000 }, async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const target = await f.advance();
  const old = await oldRuntime(f);
  await fs.mkdir(path.join(f.root, "node_modules")); await fs.writeFile(path.join(f.root, "node_modules/old-marker"), "backup");
  const { store, journal } = await makeJob(f, target, old.pid);
  await atomicJson(path.join(store.jobDirectory(journal.jobId), "handoff.json"), { nonce: journal.nonce });
  let sawReset = false;
  const task = runUpdateWorker(store, journal, { mode: "direct", source: "explicit" }, f.env, { runner: async (file, args, options) => {
    if (["reset", "clean", "stash"].some((arg) => args.includes(arg))) sawReset = true;
    if (file === "git" && args[0] === "merge") return { code: 1, stdout: "", stderr: "injected failure" };
    return runProcess(file, args, options);
  }, exitTimeoutMs: 5000 });
  f.own(async () => { await old.stop(); await task; });
  await waitFor(async () => (await store.journal(journal.jobId))?.step === "awaitingExit", 25_000);
  await old.stop(); await task;
  assert.equal(sawReset, false);
  const result = await store.journal(journal.jobId);
  assert.equal(result?.phase, "manualRecovery"); assert.equal(result?.step, "fastForwardIntent");
  assert.equal(await f.git("rev-parse", "HEAD"), f.head);
  assert.equal(await fs.readFile(path.join(journal.backup, "old-marker"), "utf8"), "backup");
  assert.ok(await readJson(path.join(store.root, "update.lock")));
});
test("strict restart bind failure cannot ACK success and retains applied SHA/journal (no rollback)", { timeout: 50_000 }, async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  await copyUpdateModules(path.join(f.root, "src/update"), true);
  await f.put("src/cli/index.ts", await fs.readFile(path.join(moduleRoot, "tests/helpers/source-update/new-runtime.ts"), "utf8"));
  const target = await f.commit("fixture runtime source");
  await f.git("checkout", "-b", "base", f.head); await f.git("branch", "-f", "main", f.head); await f.git("checkout", "main");
  const old = await oldRuntime(f);
  const { store, journal } = await makeJob(f, target, old.pid);
  const occupied = http.createServer(); occupied.listen(0, "127.0.0.1"); await once(occupied, "listening");
  t.after(() => new Promise<void>((resolve) => occupied.close(() => resolve())));
  journal.restart.port = (occupied.address() as { port: number }).port; await store.writeJournal(journal);
  await atomicJson(path.join(store.jobDirectory(journal.jobId), "handoff.json"), { nonce: journal.nonce });
  f.own(() => stopFixtureRuntime(store, journal));
  const task = runUpdateWorker(store, journal, { mode: "direct", source: "explicit" }, f.env, { ackTimeoutMs: 1500, exitTimeoutMs: 5000 });
  f.own(async () => { await old.stop(); await task; });
  await waitFor(async () => (await store.journal(journal.jobId))?.step === "awaitingExit", 25_000);
  await old.stop(); await task;
  const result = await store.journal(journal.jobId);
  assert.equal(result?.phase, "manualRecovery"); assert.equal(result?.step, "spawned");
  assert.equal(result?.error, "RESTART_EXITED"); assert.equal(isAlive(result?.childPid!), false);
  assert.equal(await f.git("rev-parse", "HEAD"), target);
  assert.equal(await readJson(path.join(store.jobDirectory(journal.jobId), "ack.json")), null);
});
