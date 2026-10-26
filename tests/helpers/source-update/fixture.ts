import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { isAlive } from "../../../src/update/state-store.ts";
import { fileURLToPath } from "node:url";
import { runProcess, cleanEnvironment } from "../../../src/update/process.ts";
import { OFFICIAL_UPSTREAM } from "../../../src/update/contracts.ts";
import type { UpdateJournal, UpdatePlan } from "../../../src/update/contracts.ts";
import type { Runner } from "../../../src/update/process.ts";
import { StateStore, atomicJson } from "../../../src/update/state-store.ts";

export const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const direct = { mode: "direct", source: "explicit" } as const;
export async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ant source update-"));
  const cleanups: (() => Promise<unknown>)[] = [];
  const own = (cleanup: () => Promise<unknown>) => { cleanups.push(cleanup); };
  const env = cleanEnvironment(process.env);
  // Isolate HOME/global Git/npm config: fixtures must not depend on developer credentials/config.
  const home = path.join(root, "home"); await fs.mkdir(home);
  const repoRoot = path.join(root, "clone"); await fs.mkdir(repoRoot);
  Object.assign(env, { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, GIT_CONFIG_GLOBAL: path.join(home, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" });
  await fs.writeFile(path.join(home, "gitconfig"), "");
  const git = async (...args: string[]) => {
    const result = await runProcess("git", args, { cwd: repoRoot, env });
    if (result.code !== 0) throw new Error(`fixture git ${args[0]} failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  await git("init", "--initial-branch=main");
  await git("config", "user.name", "Update fixture"); await git("config", "user.email", "fixture@example.invalid");
  await git("config", "core.autocrlf", "false");
  await git("remote", "add", "origin", OFFICIAL_UPSTREAM);
  await git("config", "branch.main.remote", "origin"); await git("config", "branch.main.merge", "refs/heads/main");
  const put = async (name: string, value: string) => { await fs.mkdir(path.dirname(path.join(repoRoot, name)), { recursive: true }); await fs.writeFile(path.join(repoRoot, name), value); };
  await put("package.json", JSON.stringify({ name: "@ant-code/cli", version: "0.0.1", type: "module", engines: { node: ">=22.18" } }));
  await put("package-lock.json", JSON.stringify({ name: "@ant-code/cli", version: "0.0.1", lockfileVersion: 3, packages: { "": { name: "@ant-code/cli", version: "0.0.1", engines: { node: ">=22.18" } } } }));
  await put(".gitignore", "node_modules/\nignored/\n*.local\nhome/\n");
  await put("src/cli/index.ts", "import fs from 'node:fs';\nconsole.log('ant-code ' + JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version);\n");
  await put("src/dashboard/public/index.html", "<!doctype html><title>fixture</title>");
  await put("src/dashboard/public/app.js", "// fixture\n");
  const commit = async (message = "fixture") => { await git("add", "--all"); await git("commit", "-m", message); return git("rev-parse", "HEAD"); };
  const head = await commit("base");
  const advance = async (files: Record<string, string> = { "feature.txt": "candidate" }) => {
    for (const [name, value] of Object.entries(files)) await put(name, value);
    const target = await commit("candidate");
    await git("checkout", "-b", `old-${randomUUID()}`, head);
    await git("branch", "-f", "main", head);
    await git("checkout", "main");
    return target;
  };
  const plan = (target: string): UpdatePlan => ({ root: repoRoot, head, target, branch: "main", remote: "origin", mergeRef: "refs/heads/main", upstreamUrl: OFFICIAL_UPSTREAM,
    id: randomUUID(), createdAt: Date.now(), expiresAt: Date.now() + 600_000 });
  // Test transport only: no production trust bypass. All local Git commands execute for real.
  const runner = (target: string): Runner => async (file, args, options) => {
    if (file === "git" && args.includes("fetch")) return { code: 0, stdout: "", stderr: "" };
    if (file === "git" && args[0] === "ls-remote") return { code: 0, stdout: `${target}\trefs/heads/main\n`, stderr: "" };
    return runProcess(file, args, options);
  };
  return { root: repoRoot, parent: root, env, git, put, commit, head, advance, plan, runner, own,
    cleanup: async () => {
      const errors: unknown[] = [];
      for (const cleanup of cleanups.reverse()) { try { await cleanup(); } catch (error) { errors.push(error); } }
      // Preserve evidence if a test-owned process could not be stopped.
      if (errors.length) throw new AggregateError(errors, "Fixture process cleanup failed");
      await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    } };
}
export async function copyUpdateModules(destination: string, all = false) {
  await fs.mkdir(destination, { recursive: true });
  const names = all ? (await fs.readdir(path.join(moduleRoot, "src/update"))).filter((name) => name.endsWith(".ts")) :
    ["contracts.ts", "process.ts", "repository.ts", "state-store.ts", "worker.ts", "worker-entry.ts"];
  for (const name of names) await fs.copyFile(path.join(moduleRoot, "src/update", name), path.join(destination, name));
  await fs.writeFile(path.join(destination, "package.json"), '{"type":"module"}');
}
export async function makeJob(f: Awaited<ReturnType<typeof fixture>>, target: string, oldPid: number): Promise<{ store: StateStore; journal: UpdateJournal }> {
  const store = new StateStore(f.root); await store.initialize();
  const jobId = randomUUID(), job = store.jobDirectory(jobId);
  await store.acquire(jobId); await fs.mkdir(job);
  const journal: UpdateJournal = { schema: 1, jobId, nonce: randomUUID(), phase: "staging", step: "created", sourceRoot: f.root,
    plan: f.plan(target), boot: { bootCommit: f.head, productVersion: "0.0.1", instanceId: randomUUID() }, oldPid, workerPid: 0,
    restart: { node: process.execPath, cli: path.join(f.root, "src/cli/index.ts"), projectCwd: f.root, host: "127.0.0.1", port: 46328 },
    candidate: path.join(job, "candidate"), backup: path.join(job, "previous-node_modules"), updatedAt: Date.now() };
  await store.writeJournal(journal); await atomicJson(path.join(store.root, "latest.json"), { jobId });
  return { store, journal };
}
// Test-only diagnostics: never persist raw stderr or environment values. Keep at
// most 8 KiB even if a faulty child writes indefinitely; redact before reporting.
export function diagnosticText(value: string, secrets: string[] = []) {
  for (const secret of secrets) if (secret) value = value.split(secret).join("[redacted]");
  return value.replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/^.*(?:authorization|bearer|credential|password|secret|token|nonce|gateway|proxy).*$/gim, "[redacted sensitive line]")
    .replace(/https?:\/\/[^\s\"'<>]+/gi, "[redacted URL]")
    .slice(0, 8192);
}
export function captureStderr(child: ChildProcess, secrets: string[] = []) {
  let output = Buffer.alloc(0), truncated = false;
  child.stderr?.on("data", (chunk: Buffer) => {
    const remaining = 8192 - output.length;
    if (chunk.length > remaining) truncated = true;
    if (remaining > 0) output = Buffer.concat([output, chunk.subarray(0, remaining)]);
  });
  return () => diagnosticText(output.toString("utf8"), secrets) + (truncated ? "\n[stderr truncated]" : "");
}
// Observe exit, not close: a Windows detached descendant can retain inherited pipe
// handles after the worker has exited. Never wait for that descendant to close them.
export function ownChild(child: ChildProcess, tree = false) {
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy(); resolve(code);
    });
  });
  return { exited, stop: async () => {
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      if (tree && process.platform === "win32") {
        // Only this still-owned worker PID and its descendants, never /IM node.exe.
        // npm/Git may still be running when an assertion fails during preparation.
        await runProcess("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
          cwd: os.tmpdir(), env: cleanEnvironment(process.env), timeoutMs: 5000
        });
      } else if (tree) {
        try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      } else child.kill("SIGKILL");
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([exited, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Test child did not exit")), 5000); })]); }
    finally { clearTimeout(timer); }
  } };
}
// No PID-based kill for grandchildren: only the fixture CLI knows this private
// file, and it exits itself. Register BEFORE spawning, including assertion failures.
export async function stopFixtureRuntime(store: StateStore, journal: UpdateJournal) {
  await fs.writeFile(path.join(store.jobDirectory(journal.jobId), "stop-fixture"), "stop");
  const current = await store.journal(journal.jobId);
  const end = Date.now() + 5000;
  while (current?.childPid && isAlive(current.childPid)) {
    if (Date.now() > end) throw new Error("Test runtime did not exit; fixture retained for inspection");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
export async function startSnapshotWorker(store: StateStore, journal: UpdateJournal, env: NodeJS.ProcessEnv) {
  const snapshot = path.join(store.jobDirectory(journal.jobId), "worker");
  await copyUpdateModules(snapshot);
  const child = spawn(process.execPath, [path.join(snapshot, "worker-entry.ts"), journal.sourceRoot, journal.jobId], {
    cwd: snapshot, env, detached: true, stdio: ["pipe", "ignore", "pipe"], windowsHide: true, shell: false
  });
  let stderr = ""; child.stderr.on("data", (c) => { stderr += c.toString(); });
  const owned = ownChild(child, true);
  child.stdin.on("error", () => { /* exit/error observed by ownChild */ });
  child.stdin.end(JSON.stringify(direct));
  return { child, ...owned, stderr: () => stderr };
}
