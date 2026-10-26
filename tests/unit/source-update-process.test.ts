import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { runProcess } from "../../src/update/process.ts";
import { fixture, ownChild } from "../helpers/source-update/fixture.ts";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(test: () => Promise<boolean>, timeout = 5000) {
  const end = Date.now() + timeout;
  while (!await test()) { if (Date.now() > end) throw new Error("Test-owned process did not settle"); await sleep(25); }
}
// All fixture children watch a private stop file: failure cleanup does not scan/kill
// PIDs or process names. Preserve the fixture if even cooperative cleanup fails.
async function sandbox() {
  const f = await fixture();
  const pids: number[] = [];
  f.own(async () => {
    await fs.writeFile(path.join(f.parent, "stop-process-fixture"), "stop");
    for (const name of ["parent.pid", "grandchild.pid"]) {
      const pid = await fs.readFile(path.join(f.parent, name), "utf8").then(Number, () => 0);
      if (pid) pids.push(pid);
    }
    await until(async () => pids.every((pid) => !alive(pid)));
  });
  const loop = `
    const fs = require('node:fs'), path = require('node:path');
    const root = process.argv[1];
    process.on('SIGTERM', () => {});
    setInterval(() => { if (fs.existsSync(path.join(root, 'stop-process-fixture'))) process.exit(0); }, 25);
  `;
  const grandchild = `${loop}
    fs.writeFileSync(path.join(root, 'grandchild.pid'), String(process.pid));
    process.stdout.write('grandchild holds stdout'); process.stderr.write('grandchild holds stderr');
  `;
  const script = (exitParent: boolean) => `${loop}
    fs.writeFileSync(path.join(root, 'parent.pid'), String(process.pid));
    require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}, root], {
      stdio: ['ignore', 'inherit', 'inherit'], detached: process.platform === 'win32', windowsHide: true, shell: false
    });
    ${exitParent ? "const ready = setInterval(() => { if (fs.existsSync(path.join(root, 'grandchild.pid'))) process.exit(0); }, 10);" : ""}
  `;
  return { ...f, script, pid: async (name: string) => {
    const file = path.join(f.parent, name);
    await until(async () => fs.stat(file).then(() => true, () => false));
    return Number(await fs.readFile(file, "utf8"));
  } };
}

test("runner drains normal output and hides spawn errors", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const result = await runProcess(process.execPath, ["-e", "console.log('ok'); console.error('error'); process.exitCode=7"], { cwd: f.root, env: f.env });
  assert.equal(result.code, 7); assert.equal(result.stdout.trim(), "ok"); assert.equal(result.stderr.trim(), "error");
  await assert.rejects(runProcess(path.join(f.parent, "missing-secret-command"), [], { cwd: f.root, env: f.env }), { code: "PROCESS_START_FAILED" });
});
test("runner output limit is bounded independently of child close", { timeout: 10_000 }, async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const start = Date.now();
  await assert.rejects(runProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(8192)); setInterval(()=>{},1000)"], {
    cwd: f.root, env: f.env, maxOutput: 1024, timeoutMs: 5000
  }), { code: "PROCESS_LIMIT" });
  assert.ok(Date.now() - start < 4500);
});
test("runner bounds TERM-resistant child and owned descendant tree without killing sentinel", { timeout: 15_000 }, async (t) => {
  const f = await sandbox(); t.after(f.cleanup);
  const sentinel = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", windowsHide: true });
  const owned = ownChild(sentinel); f.own(owned.stop); await once(sentinel, "spawn");
  const start = Date.now();
  const outcome = runProcess(process.execPath, ["-e", f.script(false), f.parent], { cwd: f.root, env: f.env, timeoutMs: 1000 })
    .then(() => "unexpected success", (error: { code: string }) => error.code);
  f.own(async () => { await outcome; });
  const parent = await f.pid("parent.pid"), grandchild = await f.pid("grandchild.pid");
  assert.equal(await outcome, "PROCESS_LIMIT");
  assert.ok(Date.now() - start < 5000, "timeout plus escalation/deadline must be bounded");
  assert.equal(alive(parent), false); assert.equal(alive(grandchild), false, "owned tree must be stopped while root is owned");
  assert.equal(alive(sentinel.pid!), true, "unrelated same-image child remains alive");
});
test("runner has a pipe deadline after parent exit; never taskkills an exited PID", { timeout: 15_000 }, async (t) => {
  const f = await sandbox(); t.after(f.cleanup);
  const start = Date.now();
  const outcome = runProcess(process.execPath, ["-e", f.script(true), f.parent], { cwd: f.root, env: f.env, timeoutMs: 8000 })
    .then(() => "unexpected success", (error: { code: string }) => error.code);
  f.own(async () => { await outcome; });
  const parent = await f.pid("parent.pid"), grandchild = await f.pid("grandchild.pid");
  assert.equal(await outcome, "PROCESS_LIMIT");
  assert.ok(Date.now() - start < 4000, "pipe deadline is independent of inherited handle lifetime");
  assert.equal(alive(parent), false);
  if (process.platform === "win32") {
    // No safe Windows tree ownership remains after root exit. Do not taskkill a
    // potentially reused PID: destroy local pipe endpoints and cooperatively stop
    // ONLY the private test descendant in cleanup instead.
    assert.equal(alive(grandchild), true);
  }
});
