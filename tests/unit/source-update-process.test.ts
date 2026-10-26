import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import childProcess, { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
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

// Model Windows termination without real PIDs or OS signals, including on POSIX CI.
// Real-process tests below still verify descendants and the unrelated sentinel.
function windowsRunnerModel(t: TestContext) {
  class Child extends EventEmitter {
    pid = 12345;
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;
    stdout = new PassThrough();
    stderr = new PassThrough();
    signals: NodeJS.Signals[] = [];
    unref() {}
    kill(signal: NodeJS.Signals) { this.signals.push(signal); return true; }
    exit(code: number) { this.exitCode = code; this.emit("exit", code, null); this.emit("close", code, null); }
  }
  const root = new Child(), helper = new Child();
  const calls: { file: string; args: readonly string[] }[] = [];
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  const mocked = t.mock.method(childProcess, "spawn", (file, args) => {
    calls.push({ file, args });
    if (calls.length === 1) return root;
    assert.equal(path.basename(file), "taskkill.exe");
    assert.deepEqual(args, ["/PID", String(root.pid), "/T", "/F"]);
    return helper;
  });
  syncBuiltinESMExports();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
    Object.defineProperty(process, "platform", platform);
    t.mock.timers.reset();
  });
  const outcome = runProcess("fixture-node", [], { cwd: process.cwd(), env: {}, timeoutMs: 100 })
    .then(() => "unexpected success", (error: { code: string }) => error.code);
  return { root, helper, calls, outcome };
}

test("Windows runner does not cut off a tree helper before its existing final deadline", async (t) => {
  const { root, helper, outcome } = windowsRunnerModel(t);
  t.mock.timers.tick(100); // Timeout starts the tree helper.
  t.mock.timers.tick(2000);
  assert.deepEqual(helper.signals, [], "tree enumeration must not be cut off at 2 seconds");
  assert.deepEqual(root.signals, [], "root-only fallback must not orphan the owned tree early");
  // A helper that needs 2.2 seconds still fits the unchanged 2.5-second budget.
  t.mock.timers.tick(200);
  helper.exit(0); root.exit(1);
  t.mock.timers.tick(300);
  assert.equal(await outcome, "PROCESS_LIMIT");
  assert.deepEqual(root.signals, [], "an exited root must never be signalled again");
  assert.deepEqual(helper.signals, []);
});

test("Windows runner bounds a hung tree helper without extending its final deadline", async (t) => {
  const { root, helper, outcome } = windowsRunnerModel(t);
  t.mock.timers.tick(100);
  t.mock.timers.tick(2500);
  assert.equal(await outcome, "PROCESS_LIMIT");
  assert.deepEqual(root.signals, ["SIGKILL"]);
  assert.deepEqual(helper.signals, ["SIGKILL"]);
  assert.equal(root.stdout.destroyed, true);
  assert.equal(root.stderr.destroyed, true);
});

for (const failure of ["error", "nonzero"] as const) {
  test(`Windows runner handles tree helper ${failure} while retaining the pipe deadline`, async (t) => {
    const { root, helper, outcome } = windowsRunnerModel(t);
    t.mock.timers.tick(100);
    if (failure === "error") helper.emit("error", new Error("private helper failure"));
    else helper.exit(1);
    assert.deepEqual(root.signals, ["SIGKILL"]);
    root.exit(1);
    t.mock.timers.tick(2500);
    assert.equal(await outcome, "PROCESS_LIMIT");
    assert.deepEqual(root.signals, ["SIGKILL"], "do not signal the root after its exit");
  });
}

test("Windows runner never creates a tree helper for an already exited root", async (t) => {
  const { root, calls, outcome } = windowsRunnerModel(t);
  root.exitCode = 0;
  root.emit("exit", 0, null); // A descendant still holds the pipes: no close event.
  t.mock.timers.tick(100);
  t.mock.timers.tick(1000);
  assert.equal(await outcome, "PROCESS_LIMIT");
  assert.equal(calls.length, 1);
  assert.deepEqual(root.signals, []);
});

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
