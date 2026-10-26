// Test-only independent launch chain. Never imported by production or candidate CLI.
// Capture in the original startup cwd, then exercise the real worker/restart path.
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { captureStderr, ownChild } from "./fixture.ts";
import { SourceUpdateManager } from "../../../src/update/manager.ts";
import type { SourceUpdateOptions } from "../../../src/update/manager.ts";
import { StateStore } from "../../../src/update/state-store.ts";
import { runUpdateWorker } from "../../../src/update/worker.ts";
import { runProcess } from "../../../src/update/process.ts";

const [root, jobId, dependencySource] = process.argv.slice(2);
const store = new StateStore(root);
const journal = (await store.journal(jobId))!;
const manager = await SourceUpdateManager.create({ sourceRoot: root, projectCwd: journal.restart.projectCwd,
  host: journal.restart.host, actualPort: journal.restart.port, env: process.env,
  strictRestartSupported: false, getActivity: () => ({ busy: false }), prepareShutdown: async () => { throw new Error("Independent launch only"); } });
// No production test bypass/API: observe the actual manager capture, dispose its
// extra lease, and run the independent launch chain with that captured environment.
const captured = (manager as unknown as { options: SourceUpdateOptions }).options.env!;
await manager.dispose();
let restarted: ChildProcess | undefined, owned: ReturnType<typeof ownChild> | undefined, restartError = () => "";
// The IPC channel is created only by this test's spawn. Retain stderr drainage
// until cleanup, so observing diagnostics cannot close a live product's pipe.
let stopping = false;
const cleanup = new Promise<void>((resolve) => {
  const stop = () => { stopping = true; resolve(); };
  process.once("message", (message) => { if (message === "stop-owned-product") stop(); });
  process.once("disconnect", stop);
});
await runUpdateWorker(store, journal, { mode: "direct", source: "explicit" }, captured, {
  exitTimeoutMs: 45_000, ackTimeoutMs: 45_000,
  restartSpawner: (file, args, options) => {
    if (stopping) throw new Error("Test owner already disconnected");
    restarted = spawn(file, args, { ...options, stdio: ["ignore", "ignore", "pipe"] });
    restartError = captureStderr(restarted, [journal.nonce]); owned = ownChild(restarted);
    return restarted;
  },
  runner: async (file, args, options) => {
    if (file === journal.restart.node && args[1] === "ci") {
      if (path.basename(args[0]) !== "npm-cli.js" || options.cwd !== journal.candidate ||
          args.slice(1).join("|") !== "ci|--ignore-scripts|--no-audit|--no-fund") throw new Error("Unexpected fixture npm scope");
      // Local controlled copy. No npm registry, lifecycle scripts or symlink root.
      await fs.cp(dependencySource, path.join(journal.candidate, "node_modules"), { recursive: true, dereference: true });
      return { code: 0, stdout: "", stderr: "" };
    }
    if (file === "git" && args.some((arg) => arg === "fetch" || arg === "ls-remote")) throw new Error("Unexpected network transport in launch-only test");
    return runProcess(file, args, options);
  }
});
if (journal.phase !== "succeeded") {
  // Bounded drain for already-exited children, never wait on inherited close.
  await new Promise((resolve) => setTimeout(resolve, 100));
}
if (process.connected) await new Promise<void>((resolve, reject) => {
  process.send!({ type: "worker-complete", phase: journal.phase, step: journal.step, error: journal.error,
    code: restarted?.exitCode ?? null, signal: restarted?.signalCode ?? null, stderr: restartError() },
  (error) => error ? reject(error) : resolve());
});
await cleanup;
// Only the ChildProcess returned by this helper's actual spawn is stoppable.
// No journal/scanned PID is ever signalled, and registry/runner parents are untouched.
await owned?.stop();
if (process.connected) process.disconnect();
