import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { UpdateError, TERMINAL_PHASES } from "./contracts.ts";
import type { Activity, BootSnapshot, Route, UpdateJournal, UpdatePlan, UpdateSnapshot } from "./contracts.ts";
import { Repository, sourceRootFromModule } from "./repository.ts";
import { captureBootSnapshot } from "./boot.ts";
import { discoverRoute, summarizeRoute } from "./proxy-policy.ts";
import { cleanEnvironment } from "./process.ts";
import { StateStore, atomicJson, isAlive, readJson, releaseIdlePeerDashboards } from "./state-store.ts";
import { waitFor } from "./worker.ts";

export type SourceUpdateOptions = {
  // Trusted embedding code only: derive from its real module, NEVER request/workspace/env data.
  sourceRoot?: string; projectCwd: string; host: string; actualPort: number; env?: NodeJS.ProcessEnv;
  config?: Record<string, unknown>; boot?: BootSnapshot; strictRestartSupported: boolean;
  getActivity: () => Activity | Promise<Activity>;
  // Atomically bar new work/schedules, recheck ALL activity, safely shut runtime down,
  // then await releaseWorker() immediately before closing HTTP and exiting process.
  // Throw before releaseWorker on refusal. Never force-cancel/quarantine work.
  prepareShutdown: (handoff: { jobId: string; releaseWorker: () => Promise<void> }) => Promise<void>;
};
// Capture paths while still in the original startup cwd. Workers/restarts change cwd;
// keep config-v2 and workspace-trust lookup semantics without persisting environment secrets.
function restartEnvironment(input: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...input };
  for (const key of ["LAB_AGENT_CONFIG", "LAB_AGENT_HOME", "USERPROFILE", "HOME", "APPDATA", "XDG_CONFIG_HOME"]) {
    const value = key === "LAB_AGENT_CONFIG" ? env[key]?.trim() : env[key];
    if (value) env[key] = path.resolve(process.cwd(), value);
  }
  return env;
}
const LIMITATIONS = ["The Dashboard performing the update stays open and restarts itself. An idle sibling Dashboard is closed during the update; one with active work still blocks. Other CLI/TUI instances have no lease and must be closed first.",
  "Only standalone official HTTPS source clones; no packages, linked worktrees, submodules, symlinks or custom Git execution configuration.",
  "Failed updates after shutdown require manual journal inspection; no automatic Git rollback."];

export class SourceUpdateManager {
  private options: SourceUpdateOptions;
  private root: string;
  private store: StateStore;
  private boot: BootSnapshot;
  private state: UpdateSnapshot;
  private plan?: UpdatePlan;
  private route?: Route;
  private currentTask: Promise<void> = Promise.resolve();
  private enabled = true;
  private stateEpoch = 0;
  readonly peerToken = randomBytes(32).toString("base64url");
  private constructor(options: SourceUpdateOptions, root: string, boot: BootSnapshot) {
    this.options = { ...options, env: restartEnvironment(options.env ?? process.env) }; this.root = root;
    this.boot = boot; this.store = new StateStore(root);
    this.state = { boot, phase: "idle", limitations: LIMITATIONS, strictRestartSupported: options.strictRestartSupported };
  }
  static async create(options: SourceUpdateOptions) {
    const root = await fs.realpath(options.sourceRoot ?? await sourceRootFromModule());
    const boot = options.boot ?? await captureBootSnapshot(root, options.env);
    const manager = new SourceUpdateManager(options, root, boot);
    try {
      // Do not create .git or state in a packaged/non-standalone installation.
      const git = await fs.lstat(path.join(root, ".git"));
      if (!git.isDirectory() || git.isSymbolicLink()) throw new UpdateError("SOURCE_INSTALL_REQUIRED");
      await manager.store.initialize();
      await manager.store.registerLease(boot.instanceId, {
        host: options.host, port: options.actualPort, peerToken: manager.peerToken
      });
    } catch (error) {
      manager.enabled = false;
      manager.state.phase = "blocked";
      manager.state.message = error instanceof UpdateError ? error.code : "SOURCE_INSTALL_REQUIRED";
    }
    return manager;
  }
  /** Local reads only; safe for GET polling. Never returns paths, proxy credentials or nonce. */
  async snapshot(): Promise<UpdateSnapshot> {
    if (this.enabled) {
      // Recover latest only from the untouched initial state. Once this manager starts
      // a check/job, follow that exact job, never a historical latest.json on failure.
      const epoch = this.stateEpoch, jobId = this.state.jobId;
      const initial = !jobId && this.state.phase === "idle";
      const journal = jobId ? await this.store.journal(jobId) :
        initial ? await this.store.journal() : null;
      // A concurrent POST may replace this job while the local file read is pending.
      // Never apply a completed read from an earlier check/start generation.
      if (journal && epoch === this.stateEpoch && jobId === this.state.jobId &&
          (jobId ? journal.jobId === jobId : initial && this.state.phase === "idle")) {
        const orphaned = !TERMINAL_PHASES.includes(journal.phase) && journal.workerPid > 0 && !isAlive(journal.workerPid);
        this.state.phase = orphaned ? "manualRecovery" : journal.phase;
        this.state.jobId = journal.jobId;
        this.state.message = orphaned ? "WORKER_INTERRUPTED_INSPECT_JOURNAL" : journal.error;
      }
    }
    return structuredClone(this.state);
  }
  private assertAvailable() {
    if (!this.enabled) throw new UpdateError("SOURCE_UPDATE_UNAVAILABLE");
    if (["checking", "staging", "handingOff", "applying", "restarting", "manualRecovery"].includes(this.state.phase)) throw new UpdateError("UPDATE_BUSY");
  }
  private async assertIdle() {
    await releaseIdlePeerDashboards(this.root, this.boot.instanceId);
    if ((await this.options.getActivity()).busy) throw new UpdateError("ACTIVE_WORK", "Finish all active, queued, uncertain, quarantined and pending work before updating.");
  }
  /** Return 202 with this result. check itself runs in the background. */
  check(input: { proxyUrl?: string; allowDirect?: boolean } = {}): { accepted: true } {
    this.assertAvailable();
    if (!input || Object.keys(input).some((key) => !["proxyUrl", "allowDirect"].includes(key)) ||
        (input.proxyUrl !== undefined && typeof input.proxyUrl !== "string") ||
        (input.allowDirect !== undefined && typeof input.allowDirect !== "boolean")) throw new UpdateError("INVALID_CHECK_INPUT");
    this.stateEpoch += 1;
    this.plan = undefined; this.route = undefined;
    delete this.state.plan; delete this.state.route; delete this.state.jobId; delete this.state.message;
    this.state.phase = "checking";
    this.currentTask = (async () => {
      try {
        // Checking does not stop services or change the checked-out source.
        // Activity and peer shutdown are enforced only when installing.
        if (await readJson(path.join(this.store.root, "update.lock"))) throw new UpdateError("UPDATE_LOCKED");
        const repo = new Repository(this.root, this.options.env);
        // Validate repository before proxy discovery or any network operation.
        const identity = await repo.inspect();
        if (this.boot.bootCommit !== identity.head) throw new UpdateError("RUNTIME_SOURCE_CHANGED", "Restart the Dashboard before checking: source HEAD differs from boot commit.");
        const route = await discoverRoute({ root: this.root, env: this.options.env!, config: this.options.config, ...input });
        this.state.route = summarizeRoute(route);
        const plan = await repo.check(route);
        this.plan = plan; this.route = route;
        const { root: _root, upstreamUrl: _url, ...publicPlan } = plan;
        this.state.plan = publicPlan;
        this.state.phase = plan.target === plan.head ? "upToDate" : "ready";
      } catch (error) {
        this.state.phase = "blocked";
        this.state.message = error instanceof UpdateError ? error.code : "CHECK_FAILED";
      }
    })();
    return { accepted: true };
  }
  /** Return 202. The plan is server-owned, expires and can only be consumed once. */
  start(input: { planId: string }): { accepted: true; jobId: string } {
    this.assertAvailable();
    if (!input || Object.keys(input).some((key) => key !== "planId") || typeof input.planId !== "string") throw new UpdateError("INVALID_START_INPUT");
    if (!this.options.strictRestartSupported) throw new UpdateError("STRICT_RESTART_REQUIRED");
    const plan = this.plan, route = this.route;
    if (this.state.phase !== "ready" || !plan || !route || plan.id !== input.planId || Date.now() > plan.expiresAt) throw new UpdateError("PLAN_STALE");
    this.stateEpoch += 1;
    this.plan = undefined; this.route = undefined;
    const jobId = randomUUID();
    this.state.phase = "staging"; this.state.jobId = jobId;
    this.currentTask = this.launch(jobId, plan, route).catch((error) => {
      this.state.phase = "failed"; this.state.message = error instanceof UpdateError ? error.code : "START_FAILED";
    });
    return { accepted: true, jobId };
  }
  private async launch(jobId: string, plan: UpdatePlan, route: Route) {
    await this.assertIdle();
    await new Repository(this.root, this.options.env).revalidate(plan);
    await this.store.acquire(jobId);
    const job = this.store.jobDirectory(jobId);
    let workerPid = 0;
    try {
      await fs.mkdir(job, { mode: 0o700 });
      const snapshot = path.join(job, "worker");
      await fs.mkdir(snapshot, { mode: 0o700 });
      // Explicit closed import graph; no runtime bundler and no imports from node_modules.
      const here = path.dirname(await fs.realpath(fileURLToPath(import.meta.url)));
      for (const file of ["contracts.ts", "process.ts", "repository.ts", "state-store.ts", "worker.ts", "worker-entry.ts"]) {
        await fs.copyFile(path.join(here, file), path.join(snapshot, file), fs.constants.COPYFILE_EXCL);
      }
      await fs.writeFile(path.join(snapshot, "package.json"), '{"type":"module"}', { mode: 0o600 });
      const projectCwd = await fs.realpath(this.options.projectCwd);
      const journal: UpdateJournal = { schema: 1, jobId, nonce: randomUUID(), phase: "staging", step: "created",
        sourceRoot: this.root, plan, boot: this.boot, oldPid: process.pid, workerPid: 0,
        restart: { node: await fs.realpath(process.execPath), cli: path.join(this.root, "src/cli/index.ts"), projectCwd,
          host: this.options.host, port: this.options.actualPort },
        candidate: path.join(job, "candidate"), backup: path.join(job, "previous-node_modules"), updatedAt: Date.now() };
      await this.store.writeJournal(journal);
      await atomicJson(path.join(this.store.root, "latest.json"), { jobId });
      const child = spawn(journal.restart.node, [path.join(snapshot, "worker-entry.ts"), this.root, jobId], {
        cwd: job, env: cleanEnvironment(this.options.env!), detached: true, shell: false, windowsHide: true, stdio: ["pipe", "ignore", "ignore"]
      });
      await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", () => reject(new UpdateError("WORKER_SPAWN_FAILED"))); });
      workerPid = child.pid!;
      child.stdin!.on("error", () => { /* process exit observed through journal/liveness */ });
      child.stdin!.end(JSON.stringify(route)); child.unref();
      await waitFor(async () => {
        const current = await this.store.journal(jobId);
        if (current?.step === "prepared" || (current && TERMINAL_PHASES.includes(current.phase))) return true;
        if (!isAlive(workerPid)) throw new UpdateError("WORKER_INTERRUPTED");
        return false;
      }, 12 * 60_000);
      const ready = await this.store.journal(jobId);
      if (ready?.phase !== "staging" || ready.step !== "prepared") return;
      await this.assertIdle();
      await new Repository(this.root, this.options.env).revalidate(plan);
      let released = false;
      await this.options.prepareShutdown({ jobId, releaseWorker: async () => {
        if (released) throw new UpdateError("HANDOFF_ALREADY_RELEASED");
        await this.assertIdle();
        // The embedding server has now barred new work; recheck source AFTER that gate.
        await new Repository(this.root, this.options.env).revalidate(plan);
        await atomicJson(path.join(job, "handoff.json"), { nonce: ready.nonce });
        released = true;
      } });
      if (!released) throw new UpdateError("HANDOFF_NOT_RELEASED");
    } catch (error) {
      // Never steal a running worker's lock. It will timeout before mutation if old runtime survives.
      if (!workerPid || !isAlive(workerPid)) {
        const journal = await this.store.journal(jobId);
        if (journal) { journal.phase = workerPid ? "manualRecovery" : "failed"; journal.error = error instanceof UpdateError ? error.code : "START_FAILED"; await this.store.writeJournal(journal); }
        if (!workerPid) await this.store.release(jobId);
      }
      throw error;
    }
  }
  /** Diagnostics/tests only; HTTP handlers must not await the background task. */
  async settled() { await this.currentTask; }
  async dispose() { if (this.enabled) await this.store.removeLease(this.boot.instanceId); }
}
