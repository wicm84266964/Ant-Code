import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { UpdateError } from "./contracts.ts";
import type { Route, UpdateJournal } from "./contracts.ts";
import { Repository } from "./repository.ts";
import { cleanEnvironment, findNpmCli, routedEnvironment, runProcess } from "./process.ts";
import type { Runner } from "./process.ts";
import { StateStore, isAlive, readJson } from "./state-store.ts";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export async function waitFor(test: () => Promise<boolean>, timeout: number, interval = 100) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await test()) return; await sleep(interval); }
  throw new UpdateError("WAIT_TIMEOUT");
}
export function restartArguments(journal: UpdateJournal): string[] {
  const spec = journal.restart;
  if (![spec.node, spec.cli, spec.projectCwd].every((p) => path.isAbsolute(p)) ||
      spec.cli !== path.join(journal.sourceRoot, "src", "cli", "index.ts") ||
      !spec.host || !Number.isInteger(spec.port) || spec.port < 1 || spec.port > 65535) throw new UpdateError("INVALID_RESTART_SPEC");
  return [spec.cli, "dashboard", "--host", spec.host, "--port", String(spec.port), "--project", spec.projectCwd, "--no-open", "--strict-port"];
}
type RestartAck = { nonce: string; instanceId: string; commit: string; pid: number; host: string; port: number };
export function validateRestartAck(value: unknown, journal: UpdateJournal): asserts value is RestartAck {
  const ack = value as Partial<RestartAck> | null;
  if (!ack || typeof ack.instanceId !== "string" || !/^[a-f0-9-]{36}$/i.test(ack.instanceId) ||
      ack.nonce !== journal.nonce || ack.commit !== journal.plan.target || ack.instanceId === journal.boot.instanceId ||
      ack.pid !== journal.childPid || !isAlive(ack.pid!) || ack.host !== journal.restart.host || ack.port !== journal.restart.port) throw new UpdateError("INVALID_RESTART_ACK");
}
export type WorkerDependencies = {
  runner?: Runner; exitTimeoutMs?: number; ackTimeoutMs?: number;
  // Trusted in-process launch harness only. The production entry never supplies
  // this dependency; no request, journal or environment can select a spawner.
  restartSpawner?: (file: string, args: string[], options: SpawnOptions) => ChildProcess;
};
export async function runUpdateWorker(store: StateStore, journal: UpdateJournal, route: Route,
  env: NodeJS.ProcessEnv, dependencies: WorkerDependencies = {}) {
  const repo = new Repository(journal.sourceRoot, env, dependencies.runner);
  const run = dependencies.runner ?? runProcess;
  let crossingHandoff = false;
  const write = async (step: UpdateJournal["step"], phase = journal.phase) => {
    const next = { ...journal, step, phase };
    await store.writeJournal(next);
    Object.assign(journal, next); // failed completion writes retain the last durable intent
  };
  try {
    journal.workerPid = process.pid;
    await write("preparing", "staging");
    await repo.revalidate(journal.plan);
    await repo.exportCandidate(journal.plan, journal.candidate, path.join(store.jobDirectory(journal.jobId), "candidate.index"));
    // Engine validation is performed by npm itself (engine-strict), not a partial semver parser.
    const npm = await findNpmCli(journal.restart.node);
    const npmEnv = routedEnvironment(env, route, "npm");
    npmEnv.npm_config_userconfig = path.join(store.jobDirectory(journal.jobId), "empty.npmrc");
    npmEnv.npm_config_globalconfig = path.join(store.jobDirectory(journal.jobId), "empty-global.npmrc");
    await fs.writeFile(npmEnv.npm_config_userconfig, "", { mode: 0o600, flag: "wx" });
    await fs.writeFile(npmEnv.npm_config_globalconfig, "", { mode: 0o600, flag: "wx" });
    const installed = await run(journal.restart.node, [npm, "ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: journal.candidate, env: npmEnv, timeoutMs: 10 * 60_000
    });
    if (installed.code !== 0) throw new UpdateError("CANDIDATE_INSTALL_FAILED", "Candidate npm ci failed; current source and dependencies are unchanged.");
    // npm may legitimately omit node_modules when the candidate has zero dependencies.
    await fs.mkdir(path.join(journal.candidate, "node_modules"), { recursive: true });
    for (const file of ["src/cli/index.ts", "src/dashboard/public/app.js", "src/dashboard/public/index.html"]) {
      if (!(await fs.stat(path.join(journal.candidate, file))).isFile()) throw new UpdateError("MISSING_CANDIDATE_RESOURCE");
    }
    const syntax = await run(journal.restart.node, ["--check", path.join(journal.candidate, "src/cli/index.ts")], {
      cwd: journal.candidate, env: cleanEnvironment(env)
    });
    if (syntax.code !== 0) throw new UpdateError("CANDIDATE_SYNTAX_FAILED");
    // --check parses only the entrypoint. The real, side-effect-free --version
    // branch must also load the candidate's entire static import graph before handoff.
    // Deliberately do NOT inherit package-root/config overrides, credentials, Node
    // injection or update boot tokens. The private job directory already has owner ACLs.
    const probeHome = await fs.mkdtemp(path.join(store.jobDirectory(journal.jobId), "probe-"));
    try {
      const probeEnv: NodeJS.ProcessEnv = {};
      for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "PATHEXT"]) {
        if (env[key] !== undefined) probeEnv[key] = env[key];
      }
      Object.assign(probeEnv, { HOME: probeHome, USERPROFILE: probeHome, LAB_AGENT_HOME: probeHome,
        LAB_AGENT_CONFIG: path.join(probeHome, "lab-agent.config.json"), XDG_CONFIG_HOME: probeHome,
        APPDATA: probeHome, LOCALAPPDATA: probeHome, TEMP: probeHome, TMP: probeHome });
      const pkg = JSON.parse(await fs.readFile(path.join(journal.candidate, "package.json"), "utf8"));
      if (typeof pkg.version !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.+-]+)?$/.test(pkg.version)) throw new UpdateError("CANDIDATE_LOAD_FAILED");
      const loaded = await run(journal.restart.node, [path.join(journal.candidate, "src/cli/index.ts"), "--version"], {
        cwd: journal.candidate, env: probeEnv, timeoutMs: 30_000, maxOutput: 4096
      });
      if (loaded.code !== 0 || loaded.stdout.replace(/\r\n/g, "\n") !== `ant-code ${pkg.version}\n` ||
          loaded.stderr.trim() || (await fs.readdir(probeHome)).length) throw new UpdateError("CANDIDATE_LOAD_FAILED");
    } finally {
      await fs.rm(probeHome, { recursive: true, force: true });
    }
    await repo.revalidate(journal.plan);
    await write("prepared", "staging");
    const permitFile = path.join(store.jobDirectory(journal.jobId), "handoff.json");
    await waitFor(async () => {
      const permit = await readJson<{ nonce: string }>(permitFile);
      return permit?.nonce === journal.nonce;
    }, dependencies.exitTimeoutMs ?? 120_000);
    await write("awaitingExit", "handingOff");
    await waitFor(async () => !isAlive(journal.oldPid), dependencies.exitTimeoutMs ?? 120_000);
    crossingHandoff = true;
    await write("oldExited", "applying");
    await store.assertOnlyLease(journal.boot.instanceId);
    await repo.revalidate(journal.plan);
    const modules = path.join(journal.sourceRoot, "node_modules");
    journal.hadDependencies = await fs.lstat(modules).then(() => true, () => false);
    await write("dependenciesBackupIntent");
    if (journal.hadDependencies) await fs.rename(modules, journal.backup);
    await write("dependenciesBackedUp");
    await write("dependenciesInstallIntent");
    await fs.rename(path.join(journal.candidate, "node_modules"), modules);
    await write("dependenciesInstalled");
    await write("fastForwardIntent");
    await repo.fastForward(journal.plan);
    await write("fastForwarded");
    const args = restartArguments(journal);
    await write("restartIntent", "restarting");
    const restartEnv = cleanEnvironment(env);
    Object.assign(restartEnv, { ANT_SOURCE_UPDATE_JOB: journal.jobId, ANT_SOURCE_UPDATE_NONCE: journal.nonce,
      ANT_SOURCE_UPDATE_ROOT: journal.sourceRoot, ANT_SOURCE_UPDATE_STRICT_PORT: "1" });
    const child = (dependencies.restartSpawner ?? spawn)(journal.restart.node, args, { cwd: journal.restart.projectCwd, env: restartEnv,
      detached: true, stdio: "ignore", shell: false, windowsHide: true });
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", () => reject(new UpdateError("RESTART_FAILED"))); });
    journal.childPid = child.pid; child.unref();
    await write("spawned");
    await waitFor(async () => {
      if (!isAlive(journal.childPid!)) throw new UpdateError("RESTART_EXITED");
      const ack = await readJson<unknown>(path.join(store.jobDirectory(journal.jobId), "ack.json"));
      if (ack === null) return false;
      validateRestartAck(ack, journal);
      journal.acknowledgedBy = { instanceId: ack.instanceId, commit: ack.commit, pid: ack.pid };
      return true;
    }, dependencies.ackTimeoutMs ?? 90_000);
    await write("acknowledged", "succeeded");
    // Preserve the old dependency tree and candidate for diagnosis; no destructive automatic cleanup/reset.
    await store.release(journal.jobId);
  } catch (error) {
    journal.phase = crossingHandoff ? "manualRecovery" : "failed";
    journal.error = error instanceof UpdateError ? error.code : "WORKER_FAILED";
    await store.writeJournal(journal);
    if (!crossingHandoff) await store.release(journal.jobId);
    // Once the old process has exited, hold the lock and preserve all files. Never reset/rollback HEAD.
  }
}
