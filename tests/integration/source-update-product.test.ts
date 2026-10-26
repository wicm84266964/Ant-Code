import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fixture, makeJob, moduleRoot, ownChild, captureStderr } from "../helpers/source-update/fixture.ts";
import { atomicJson, isAlive } from "../../src/update/state-store.ts";
import { waitFor, runUpdateWorker } from "../../src/update/worker.ts";
import { runProcess } from "../../src/update/process.ts";
import type { BootSnapshot, UpdateSnapshot } from "../../src/update/contracts.ts";

async function bootstrap(url: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 200); await response.text();
  const cookies = response.headers.getSetCookie().map((cookie) => cookie.split(";", 1)[0]);
  const csrf = cookies.find((cookie) => cookie.startsWith("antcode_dashboard_csrf_"))?.split("=")[1];
  assert.ok(csrf);
  return { cookie: cookies.join("; "), "x-antcode-csrf-token": csrf, "content-type": "application/json" };
}
type Status = BootSnapshot & { cwd: string; version: string; configV2: { paths: { global: string }; revisions: unknown }; settings: unknown };
async function status(url: string, headers: Record<string, string>): Promise<Status> {
  const response = await fetch(`${url}/api/status`, { headers, signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200); return response.json();
}

test("test-owned restart stderr diagnostics retain exit code, redact credentials and bound output", { timeout: 10_000 }, async (t) => {
  const child = spawn(process.execPath, ["-e", `
    process.stderr.write('startup failure\\nHTTPS_PROXY=https://user:fixture-password@proxy.invalid\\nAuthorization: Bearer fixture-token\\nhttps://user:fixture-password@example.invalid\\n' + 'x'.repeat(20_000));
    process.exitCode = 23;
  `], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true, shell: false });
  const diagnostic = captureStderr(child), owned = ownChild(child); t.after(owned.stop);
  assert.equal(await owned.exited, 23); assert.equal(child.signalCode, null);
  const text = diagnostic();
  assert.match(text, /startup failure/); assert.match(text, /redacted/); assert.match(text, /stderr truncated/);
  assert.doesNotMatch(text, /fixture-password|fixture-token|proxy\.invalid|example\.invalid/);
  assert.ok(text.length <= 8192 + "\n[stderr truncated]".length);
});

test("trusted restart diagnostics observe exit before ACK without changing manualRecovery", { timeout: 30_000 }, async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const old = spawn(process.execPath, ["-e", ""], { stdio: "ignore", windowsHide: true });
  const oldOwned = ownChild(old); f.own(oldOwned.stop); await oldOwned.exited;
  await f.put("src/cli/index.ts", `
    if (process.argv.includes('--version')) console.log('ant-code 0.0.1');
    else { console.error('fixture startup failed'); process.exitCode = 23; }
  `);
  const target = await f.commit("controlled restart failure");
  await f.git("checkout", "-b", "base", f.head); await f.git("branch", "-f", "main", f.head); await f.git("checkout", "main");
  const { store, journal } = await makeJob(f, target, old.pid!);
  await atomicJson(path.join(store.jobDirectory(journal.jobId), "handoff.json"), { nonce: journal.nonce });
  let diagnostic = () => "", restarted: ReturnType<typeof spawn> | undefined;
  let restartExit: Promise<number | null> | undefined;
  await runUpdateWorker(store, journal, { mode: "direct", source: "explicit" }, f.env, {
    runner: async (file, args, options) => {
      if (file === journal.restart.node && args[1] === "ci") return { code: 0, stdout: "", stderr: "" };
      if (file === "git" && args.some((arg) => arg === "fetch" || arg === "ls-remote")) throw new Error("Unexpected transport");
      return runProcess(file, args, options);
    },
    restartSpawner: (file, args, options) => {
      restarted = spawn(file, args, { ...options, stdio: ["ignore", "ignore", "pipe"] });
      diagnostic = captureStderr(restarted, [journal.nonce]);
      const owned = ownChild(restarted); f.own(owned.stop);
      restartExit = owned.exited;
      return restarted;
    }
  });
  const result = await store.journal(journal.jobId);
  assert.equal(result?.phase, "manualRecovery"); assert.equal(result?.step, "spawned"); assert.equal(result?.error, "RESTART_EXITED");
  // The OS liveness probe may observe exit before Node delivers ChildProcess.exit.
  // Await this owned child's event, not a sleep or a relaxed exit-code assertion.
  assert.ok(restartExit);
  restarted!.ref(); // The worker deliberately unrefs it; this test still awaits its exit.
  let exitDeadline: ReturnType<typeof setTimeout> | undefined;
  try {
    assert.equal(await Promise.race([restartExit, new Promise<never>((_, reject) => {
      exitDeadline = setTimeout(() => reject(new Error("Owned restart exit event did not settle")), 5000);
    })]), 23);
  } finally { clearTimeout(exitDeadline); }
  assert.equal(restarted?.exitCode, 23); assert.equal(restarted?.signalCode, null);
  assert.match(diagnostic(), /fixture startup failed/);
  assert.equal(await fs.stat(path.join(store.jobDirectory(journal.jobId), "ack.json")).then(() => true, () => false), false);
  assert.equal(await f.git("rev-parse", "HEAD"), target);
});

for (const configKey of ["LAB_AGENT_CONFIG", "LAB_AGENT_HOME", "HOME"] as const) {
  test(`real product CLI/server/ACK/new manager restart preserves relative ${configKey} from another startup cwd`, { timeout: 150_000 }, async (t) => {
    const f = await fixture(); t.after(f.cleanup);
    // Disposable local source clone: copy the actual product, not a substitute CLI.
    await fs.cp(path.join(moduleRoot, "src"), path.join(f.root, "src"), { recursive: true });
    for (const name of ["package.json", "package-lock.json"]) await fs.copyFile(path.join(moduleRoot, name), path.join(f.root, name));
    await f.put(".gitignore", "node_modules/\n.lab-agent/\n");
    const base = await f.commit("real product base");
    await f.put("candidate-marker.txt", "local target only"); const target = await f.commit("local product target");
    await f.git("checkout", "-b", "base", base); await f.git("branch", "-f", "main", base); await f.git("checkout", "main");
    await fs.cp(path.join(moduleRoot, "node_modules"), path.join(f.root, "node_modules"), { recursive: true, dereference: true });
    const startup = path.join(f.parent, "startup"), project = path.join(f.parent, "project");
    await fs.mkdir(startup); await fs.mkdir(project);
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "TEMP", "TMP"]) if (process.env[key]) env[key] = process.env[key];
    const isolatedHome = path.join(f.parent, "isolated-home"); await fs.mkdir(isolatedHome);
    Object.assign(env, { HOME: isolatedHome, USERPROFILE: isolatedHome, XDG_CONFIG_HOME: isolatedHome, APPDATA: isolatedHome, LOCALAPPDATA: isolatedHome });
    let legacy: string;
    if (configKey === "HOME") {
      // Windows spawn supplies the ambient USERPROFILE when omitted. Explicitly
      // empty it so config-v2 really selects HOME, never the developer profile.
      env.USERPROFILE = ""; env.HOME = "relative-home";
      legacy = path.join(startup, "relative-home/.ant-code/lab-agent.config.json");
    } else if (configKey === "LAB_AGENT_HOME") {
      env.LAB_AGENT_HOME = "relative-settings"; legacy = path.join(startup, "relative-settings/lab-agent.config.json");
    } else {
      env.LAB_AGENT_CONFIG = "relative-settings/custom.json"; legacy = path.join(startup, "relative-settings/custom.json");
    }
    // Fail before launching product if OS spawn would fill an ambient home/config.
    assert.ok(Object.hasOwn(env, "USERPROFILE"));
    for (const key of ["HOME", "USERPROFILE", "LAB_AGENT_CONFIG", "LAB_AGENT_HOME"]) {
      if (env[key]) assert.ok(path.resolve(startup, env[key]!).startsWith(f.parent + path.sep));
    }
    await fs.mkdir(path.dirname(legacy), { recursive: true });
    await fs.writeFile(legacy, JSON.stringify({ transcript: { retentionDays: 19 } }));
    const listener = http.createServer(); listener.listen(0, "127.0.0.1"); await once(listener, "listening");
    const port = (listener.address() as { port: number }).port;
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    const url = `http://127.0.0.1:${port}`;
    const old = spawn(process.execPath, [path.join(f.root, "src/cli/index.ts"), "dashboard", "--host", "127.0.0.1", "--port", String(port), "--project", project, "--strict-port", "--no-open"], {
      cwd: startup, env, windowsHide: true, stdio: ["ignore", "ignore", "pipe"]
    });
    const oldOwned = ownChild(old); f.own(oldOwned.stop);
    const oldError = captureStderr(old);
    let oldHeaders!: Awaited<ReturnType<typeof bootstrap>>;
    await waitFor(async () => {
      if (old.exitCode !== null || old.signalCode !== null) assert.fail(`Old product failed (${old.exitCode}/${old.signalCode}): ${oldError()}`);
      try { oldHeaders = await bootstrap(url); return true; } catch { return false; }
    }, 30_000);
    const before = await status(url, oldHeaders);
    assert.equal(before.bootCommit, base); assert.equal(before.cwd, project); assert.equal(before.version, "dashboard.v2");
    const globalSettings = path.join(path.dirname(legacy), "settings.json");
    assert.equal(path.resolve(startup, before.configV2.paths.global), globalSettings);
    const settingsBytes = await fs.readFile(globalSettings, "utf8");
    const { store, journal } = await makeJob(f, target, old.pid!);
    journal.plan.head = base; journal.boot = { productVersion: before.productVersion, bootCommit: before.bootCommit, instanceId: before.instanceId };
    journal.restart.projectCwd = project; journal.restart.port = port; await store.writeJournal(journal);
    // Independent launch-only chain: no upstream fetch or manager.check/start.
    const helper = spawn(process.execPath, [path.join(moduleRoot, "tests/helpers/source-update/product-launch.ts"), f.root, journal.jobId, path.join(moduleRoot, "node_modules")], {
      cwd: startup, env, detached: true, windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"]
    });
    const helperOwned = ownChild(helper, true); f.own(helperOwned.stop);
    const helperError = captureStderr(helper);
    let completion: { type: string; phase: string; step: string; error?: string; code: number | null; signal: string | null; stderr: string } | undefined;
    helper.on("message", (message) => { completion = message as typeof completion; });
    f.own(async () => {
      // IPC reaches only the helper we spawned; it owns the actual child handle.
      if (helper.connected) helper.send("stop-owned-product");
      await waitFor(async () => helper.exitCode !== null || helper.signalCode !== null, 10_000);
      assert.equal(await helperOwned.exited, 0, helperError());
    });
    await waitFor(async () => {
      const current = await store.journal(journal.jobId);
      if (current?.phase === "failed") assert.fail(JSON.stringify({ phase: current.phase, step: current.step, error: current.error, diagnostic: helperError() }));
      return current?.step === "prepared";
    }, 60_000);
    assert.ok(isAlive(old.pid!)); assert.equal((await status(url, oldHeaders)).instanceId, before.instanceId);
    assert.equal(await f.git("rev-parse", "HEAD"), base);
    await atomicJson(path.join(store.jobDirectory(journal.jobId), "handoff.json"), { nonce: journal.nonce });
    const shutdown = await fetch(`${url}/api/shutdown`, { method: "POST", headers: oldHeaders, body: "{}" });
    assert.equal(shutdown.status, 200); await shutdown.text(); assert.equal(await oldOwned.exited, 0);
    await waitFor(async () => {
      if (helper.exitCode !== null || helper.signalCode !== null) assert.fail(`Launch helper exited early: ${helperError()}`);
      return completion?.type === "worker-complete";
    }, 60_000);
    const result = await store.journal(journal.jobId);
    assert.equal(result?.phase, "succeeded", JSON.stringify({ phase: result?.phase, step: result?.step,
      error: result?.error, diagnostic: completion })); assert.equal(result?.step, "acknowledged");
    const newHeaders = await bootstrap(url); const after = await status(url, newHeaders);
    f.own(async () => {
      const identity = await status(url, newHeaders);
      assert.equal(identity.instanceId, after.instanceId); assert.equal(identity.bootCommit, target);
      const response = await fetch(`${url}/api/shutdown`, { method: "POST", headers: newHeaders, body: "{}", signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200); await response.text();
      await waitFor(async () => !isAlive(result.childPid!), 10_000);
    });
    assert.equal(after.bootCommit, target); assert.notEqual(after.instanceId, before.instanceId);
    assert.equal(after.cwd, project); assert.equal(after.version, "dashboard.v2");
    assert.equal(after.configV2.paths.global, globalSettings);
    assert.deepEqual(after.configV2.revisions, before.configV2.revisions); assert.deepEqual(after.settings, before.settings);
    assert.equal(await fs.readFile(globalSettings, "utf8"), settingsBytes);
    const updateResponse = await fetch(`${url}/api/source-update`, { headers: newHeaders });
    assert.equal(updateResponse.status, 200); const update: UpdateSnapshot = await updateResponse.json();
    assert.equal(update.phase, "succeeded"); assert.equal(update.jobId, journal.jobId);
    assert.equal(update.boot.bootCommit, target); assert.equal(update.boot.instanceId, after.instanceId);
    assert.equal(update.strictRestartSupported, true); // real product advertises the accepted strict-restart capability
    assert.equal(result?.acknowledgedBy?.instanceId, after.instanceId);
    assert.equal(await f.git("rev-parse", "HEAD"), target);
    for (const name of ["relative-settings", "relative-home"]) assert.equal(await fs.stat(path.join(project, name)).then(() => true, () => false), false);
  });
}
