import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { UpdateError } from "./contracts.ts";
import type { Route } from "./contracts.ts";

export type RunOptions = { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number; maxOutput?: number };
export type RunResult = { code: number; stdout: string; stderr: string };
export type Runner = (file: string, args: string[], options: RunOptions) => Promise<RunResult>;
// Never include subprocess output in errors: Git/npm may echo credential-bearing URLs.
export const runProcess: Runner = (file, args, options) => new Promise((resolve, reject) => {
  // A private POSIX process group lets escalation cover descendants, not the worker's group.
  const child = spawn(file, args, { cwd: options.cwd, env: options.env, shell: false, windowsHide: true,
    detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", size = 0, stopped = false, settled = false;
  let grace: ReturnType<typeof setTimeout> | undefined, deadline: ReturnType<typeof setTimeout> | undefined;
  let drain: ReturnType<typeof setTimeout> | undefined;
  let killer: ReturnType<typeof spawn> | undefined;
  const limit = options.maxOutput ?? 8 * 1024 * 1024;
  const live = () => child.pid !== undefined && child.exitCode === null && child.signalCode === null;
  const signal = (value: NodeJS.Signals) => {
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, value);
      else if (live()) child.kill(value);
    } catch { /* Already gone; the final pipe deadline must still run. */ }
  };
  const finish = (code = -1, error?: string) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer); clearTimeout(grace); clearTimeout(deadline); clearTimeout(drain);
    // Never wait for close: a grandchild can hold these handles after the child exits.
    child.stdout.destroy(); child.stderr.destroy();
    if (killer && killer.exitCode === null && killer.signalCode === null) killer.kill("SIGKILL");
    child.unref();
    if (error || stopped) reject(new UpdateError(error ?? "PROCESS_LIMIT"));
    else resolve({ code, stdout, stderr });
  };
  const stop = () => {
    if (stopped || settled) return;
    stopped = true;
    clearTimeout(timer); clearTimeout(drain);
    if (process.platform === "win32" && live()) {
      // Windows has no graceful SIGTERM. Kill the tree BEFORE killing its still-owned
      // root. Never taskkill an exited/recovered PID, a process name, or a scanned PID.
      const system = process.env.SystemRoot ?? "C:\\Windows";
      killer = spawn(path.join(system, "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], {
        env: cleanEnvironment(process.env), shell: false, windowsHide: true, stdio: "ignore"
      });
      killer.once("error", () => { if (!settled) signal("SIGKILL"); });
      // A failed helper cannot clean the tree; fall back only while we still own
      // the live root. Successful helpers may exit before root exit is delivered.
      killer.once("exit", (code) => { if (!settled && code !== 0) signal("SIGKILL"); });
      // Keep taskkill alive for the entire existing 2.5-second cleanup budget.
      // Cutting it off at 2 seconds can interrupt tree enumeration under load,
      // then orphan descendants by killing only the root. The final deadline
      // still bounds both helper and root; do not retry an exited root PID.
      killer.unref();
    } else {
      signal("SIGTERM");
      grace = setTimeout(() => signal("SIGKILL"), 500);
    }
    deadline = setTimeout(() => { signal("SIGKILL"); finish(); }, process.platform === "win32" && killer ? 2500 : 1000);
  };
  const timer = setTimeout(stop, options.timeoutMs ?? 30_000);
  const capture = (kind: "stdout" | "stderr", chunk: Buffer) => {
    if (stopped || settled) return;
    size += chunk.length;
    if (size > limit) { stop(); return; }
    if (kind === "stdout") stdout += chunk.toString("utf8"); else stderr += chunk.toString("utf8");
  };
  child.stdout.on("data", (chunk: Buffer) => capture("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => capture("stderr", chunk));
  child.once("error", () => finish(-1, "PROCESS_START_FAILED"));
  child.once("exit", () => {
    // Allow normal buffered output to drain, but not indefinitely inherited pipes.
    if (!stopped && !settled) drain = setTimeout(stop, 500);
  });
  child.once("close", (code) => {
    // If TERM closed the pipes early, still execute escalation for group descendants.
    if (stopped) return;
    finish(code ?? -1);
  });
});

export function cleanEnvironment(input: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...input };
  for (const key of Object.keys(env)) {
    if (/^(git_|npm_config_|https?_proxy$|all_proxy$|no_proxy$|proxy$|node_options$|node_extra_ca_certs$|node_tls_reject_unauthorized$)/i.test(key)) delete env[key];
  }
  // System Git configuration is not part of the source installation contract.
  env.GIT_CONFIG_NOSYSTEM = "1";
  return env;
}

export function routedEnvironment(input: NodeJS.ProcessEnv, route: Route, tool: "git" | "npm"): NodeJS.ProcessEnv {
  const env = cleanEnvironment(input);
  const proxy = route.mode === "proxy" ? route.url : "";
  // Empty NO_PROXY is intentional, including for loopback: this route is authoritative.
  Object.assign(env, { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy,
    http_proxy: proxy, https_proxy: proxy, all_proxy: proxy, NO_PROXY: "", no_proxy: "" });
  if (tool === "git") {
    const config: [string, string][] = [
      ["http.proxy", proxy], ["http.sslVerify", "true"], ["http.followRedirects", "false"],
      ["core.hooksPath", "/dev/null"],
      ["credential.helper", ""], ["credential.interactive", "false"], ["protocol.allow", "never"],
      ["protocol.https.allow", "always"], ["gc.auto", "0"], ["maintenance.auto", "false"],
      ["core.fsmonitor", "false"], ["core.untrackedCache", "false"], ["submodule.recurse", "false"],
      ["fetch.recurseSubmodules", "false"], ["commit.gpgSign", "false"], ["merge.autoStash", "false"],
      ["core.protectNTFS", "true"], ["core.protectHFS", "true"], ["http.proxyAuthMethod", "basic"]
    ];
    env.GIT_CONFIG_COUNT = String(config.length);
    config.forEach(([key, value], index) => { env[`GIT_CONFIG_KEY_${index}`] = key; env[`GIT_CONFIG_VALUE_${index}`] = value; });
    env.GIT_TERMINAL_PROMPT = "0";
    env.GIT_ASKPASS = "";
    env.GIT_LFS_SKIP_SMUDGE = "1";
    env.GIT_NO_REPLACE_OBJECTS = "1";
  } else {
    // npm skips empty env values: false overrides file proxies even for explicit direct.
    // A comma is a nonempty empty bypass list (npm accepts comma-delimited noproxy).
    // The worker supplies private empty user/global config files, never the user's npmrc.
    Object.assign(env, { npm_config_proxy: proxy || "false", npm_config_https_proxy: proxy || "false", npm_config_noproxy: ",",
      npm_config_registry: "https://registry.npmjs.org/", npm_config_replace_registry_host: "never",
      npm_config_strict_ssl: "true", npm_config_ignore_scripts: "true", npm_config_audit: "false",
      npm_config_fund: "false", npm_config_update_notifier: "false", npm_config_engine_strict: "true" });
  }
  return env;
}

export async function findNpmCli(node = process.execPath): Promise<string> {
  // npm.cmd/npm.ps1 are never executed. These are the normal Windows and POSIX installations.
  const base = path.dirname(await fs.realpath(node));
  const candidates = [path.join(base, "node_modules/npm/bin/npm-cli.js"),
    path.resolve(base, "../lib/node_modules/npm/bin/npm-cli.js"),
    path.resolve(base, "../share/nodejs/npm/bin/npm-cli.js")];
  for (const candidate of candidates) {
    if (await fs.stat(candidate).then((s) => s.isFile(), () => false)) return fs.realpath(candidate);
  }
  throw new UpdateError("NPM_CLI_NOT_FOUND", "Install npm alongside Node; npm shell shims are not supported.");
}
