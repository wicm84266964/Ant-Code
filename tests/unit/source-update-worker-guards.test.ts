import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { atomicJson, readJson } from "../../src/update/state-store.ts";
import { runUpdateWorker, waitFor } from "../../src/update/worker.ts";
import { runProcess } from "../../src/update/process.ts";
import { fixture, makeJob, direct, ownChild } from "../helpers/source-update/fixture.ts";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { isAlive } from "../../src/update/state-store.ts";
import type { UpdateJournal } from "../../src/update/contracts.ts";

for (const guard of ["changed tree", "other lease"] as const) {
  test(`worker rechecks ${guard} after old exit, before any dependency/source mutation`, { timeout: 30_000 }, async (t) => {
    const f = await fixture(); t.after(f.cleanup);
    const target = await f.advance();
    await fs.mkdir(path.join(f.root, "node_modules")); await fs.writeFile(path.join(f.root, "node_modules/old-marker"), "old dependencies");
    const { store, journal } = await makeJob(f, target, 0);
    const task = runUpdateWorker(store, journal, direct, f.env, { exitTimeoutMs: 2000, runner: async (file, args, options) => {
      // These guard tests do not install dependencies. All Git validation/export is real.
      if (file === process.execPath && !args.includes("--version")) return { code: 0, stdout: "", stderr: "" };
      assert.ok(!args.some((arg) => ["reset", "clean", "stash"].includes(arg)));
      return runProcess(file, args, options);
    } });
    f.own(() => task);
    await waitFor(async () => (await store.journal(journal.jobId))?.step === "prepared", 10_000);
    if (guard === "changed tree") await f.put("changed.txt", "user data");
    else await store.registerLease(randomUUID());
    await atomicJson(path.join(store.jobDirectory(journal.jobId), "handoff.json"), { nonce: journal.nonce });
    await task;
    const result = await store.journal(journal.jobId);
    assert.equal(result?.phase, "manualRecovery"); assert.equal(result?.step, "oldExited");
    assert.equal(result?.error, guard === "changed tree" ? "DIRTY_WORKTREE" : "OTHER_DASHBOARD_RUNNING");
    assert.equal(await f.git("rev-parse", "HEAD"), f.head);
    assert.equal(await fs.readFile(path.join(f.root, "node_modules/old-marker"), "utf8"), "old dependencies");
    assert.equal(await fs.stat(journal.backup).then(() => true, () => false), false);
    assert.ok(await readJson(path.join(store.root, "update.lock")));
    assert.equal(result?.childPid, undefined);
  });
}

test("candidate load uses isolated HOME/config and no inherited root override or secrets", { timeout: 30_000 }, async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const target = await f.advance();
  const { store, journal } = await makeJob(f, target, process.pid);
  let probed = false;
  await runUpdateWorker(store, journal, direct, { ...f.env, LAB_AGENT_PACKAGE_ROOT: "wrong-root", ANT_CODE_HOME: "wrong-home",
    NODE_SEA_EXECUTABLE: "wrong-executable", ANT_SOURCE_UPDATE_JOB: "wrong-job", PRIVATE_TOKEN: "secret" }, {
    exitTimeoutMs: 10, runner: async (file, args, options) => {
      if (file === process.execPath && args.includes("ci")) return { code: 0, stdout: "", stderr: "" };
      if (args.includes("--version")) {
        probed = true;
        for (const key of ["LAB_AGENT_PACKAGE_ROOT", "ANT_CODE_HOME", "NODE_SEA_EXECUTABLE", "ANT_SOURCE_UPDATE_JOB", "PRIVATE_TOKEN"]) assert.equal(options.env[key], undefined);
        assert.ok(options.env.HOME?.startsWith(store.jobDirectory(journal.jobId)));
        assert.equal(options.env.USERPROFILE, options.env.HOME);
        assert.equal(options.env.LAB_AGENT_CONFIG, path.join(options.env.HOME!, "lab-agent.config.json"));
        assert.equal(options.maxOutput, 4096); assert.equal(options.timeoutMs, 30_000);
      }
      return runProcess(file, args, options);
    }
  });
  assert.ok(probed);
  assert.equal((await store.journal(journal.jobId))?.step, "prepared");
  assert.equal((await store.journal(journal.jobId))?.error, "WAIT_TIMEOUT");
});

for (const unsafe of ["wrong version", "stderr", "nonzero exit", "config write"] as const) {
  test(`candidate --version rejects ${unsafe} without preparing`, { timeout: 30_000 }, async (t) => {
    const f = await fixture(); t.after(f.cleanup);
    const target = await f.advance(); const { store, journal } = await makeJob(f, target, process.pid);
    await runUpdateWorker(store, journal, direct, f.env, { runner: async (file, args, options) => {
      if (file === process.execPath && args.includes("ci")) return { code: 0, stdout: "", stderr: "" };
      if (args.includes("--version")) {
        if (unsafe === "config write") await fs.writeFile(options.env.LAB_AGENT_CONFIG!, "{}");
        return { code: unsafe === "nonzero exit" ? 1 : 0, stdout: unsafe === "wrong version" ? "ant-code 9.9.9\n" : "ant-code 0.0.1\n", stderr: unsafe === "stderr" ? "unexpected" : "" };
      }
      return runProcess(file, args, options);
    } });
    assert.equal((await store.journal(journal.jobId))?.error, "CANDIDATE_LOAD_FAILED");
    assert.equal((await store.journal(journal.jobId))?.step, "preparing");
    assert.equal(await f.git("rev-parse", "HEAD"), f.head);
  });
}

for (const completion of ["dependenciesBackedUp", "dependenciesInstalled"] as const) {
  test(`journal failure after ${completion} rename preserves last durable intent, lock and directory evidence`, { timeout: 30_000 }, async (t) => {
    const f = await fixture(); t.after(f.cleanup);
    const target = await f.advance(); const { store, journal } = await makeJob(f, target, 0);
    await fs.mkdir(path.join(f.root, "node_modules")); await fs.writeFile(path.join(f.root, "node_modules/old-marker"), "old");
    await atomicJson(path.join(store.jobDirectory(journal.jobId), "handoff.json"), { nonce: journal.nonce });
    const realWrite = store.writeJournal.bind(store); let injected = false;
    t.mock.method(store, "writeJournal", async (next: UpdateJournal) => {
      if (!injected && next.step === completion) { injected = true; throw new Error("injected journal failure"); }
      await realWrite(next);
    });
    await runUpdateWorker(store, journal, direct, f.env, { runner: async (file, args, options) => {
      if (file === process.execPath && args.includes("ci")) {
        await fs.mkdir(path.join(journal.candidate, "node_modules"));
        await fs.writeFile(path.join(journal.candidate, "node_modules/new-marker"), "new");
        return { code: 0, stdout: "", stderr: "" };
      }
      return runProcess(file, args, options);
    } });
    assert.ok(injected);
    const result = await store.journal(journal.jobId);
    assert.equal(result?.phase, "manualRecovery"); assert.equal(result?.error, "WORKER_FAILED");
    assert.equal(result?.step, completion === "dependenciesBackedUp" ? "dependenciesBackupIntent" : "dependenciesInstallIntent");
    assert.equal(await fs.readFile(path.join(journal.backup, "old-marker"), "utf8"), "old");
    const newModules = completion === "dependenciesBackedUp" ? path.join(journal.candidate, "node_modules") : path.join(f.root, "node_modules");
    assert.equal(await fs.readFile(path.join(newModules, "new-marker"), "utf8"), "new");
    assert.equal(await fs.stat(path.join(f.root, "node_modules")).then(() => true, () => false), completion === "dependenciesInstalled");
    assert.equal(await f.git("rev-parse", "HEAD"), f.head);
    assert.ok(await readJson(path.join(store.root, "update.lock"))); assert.equal(result?.childPid, undefined);
  });
}

test("test-owned detached process tree cleanup awaits exit and leaves an unrelated Node alive", { timeout: 15_000 }, async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const sentinel = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  const sentinelOwned = ownChild(sentinel); f.own(sentinelOwned.stop); await once(sentinel, "spawn");
  const script = "const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});c.on('spawn',()=>console.log(c.pid));setInterval(()=>{},1000)";
  const tree = spawn(process.execPath, ["-e", script], { cwd: f.root, detached: true, stdio: ["ignore", "pipe", "ignore"] });
  const owned = ownChild(tree, true); f.own(owned.stop);
  const [data] = await once(tree.stdout, "data", { signal: AbortSignal.timeout(5000) });
  const descendant = Number(data.toString().trim()); assert.ok(isAlive(descendant));
  await owned.stop();
  await waitFor(async () => !isAlive(descendant), 3000);
  assert.equal(isAlive(tree.pid!), false); assert.ok(isAlive(sentinel.pid!));
});