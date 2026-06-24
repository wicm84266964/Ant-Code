import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { registerBackgroundTerminalTask, updateBackgroundTerminalTask } from "../agents/background-terminal-registry.js";
import { scrubEnvironment } from "./env-scrubber.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_BACKGROUND_LOG_DIR = ".lab-agent/background-terminal";
const DEFAULT_BACKGROUND_LAUNCH_TIMEOUT_MS = 15_000;

/**
 * @param {{ cwd: string; command: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal; policy?: Record<string, any> }} input
 */
export async function powershellTool(input) {
  const executable = process.platform === "win32" ? "powershell.exe" : "pwsh";
  return runShellCommand({
    executable,
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", input.command],
    cwd: input.cwd,
    timeoutMs: input.timeoutMs,
    env: input.env,
    signal: input.signal,
    policy: input.policy
  });
}

/**
 * @param {{ cwd: string; command: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal; policy?: Record<string, any> }} input
 */
export async function bashTool(input) {
  return runShellCommand({
    executable: "bash",
    args: ["-lc", input.command],
    cwd: input.cwd,
    timeoutMs: input.timeoutMs,
    env: input.env,
    signal: input.signal,
    policy: input.policy
  });
}

/**
 * @param {{ cwd: string; command: string; title?: string; taskId?: string; logDir?: string; env?: NodeJS.ProcessEnv; policy?: Record<string, any>; parentSessionId?: string }} input
 */
export async function backgroundShellTool(input) {
  const taskId = sanitizeTaskId(input.taskId) || `terminal-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const logDir = path.resolve(input.cwd, input.logDir || DEFAULT_BACKGROUND_LOG_DIR);
  await fs.promises.mkdir(logDir, { recursive: true });
  const stdoutPath = path.join(logDir, `${taskId}.stdout.log`);
  const stderrPath = path.join(logDir, `${taskId}.stderr.log`);
  const scrubbed = scrubEnvironment(input.env ?? process.env, { allowSensitive: input.policy?.fullAccess === true });
  registerBackgroundTerminalTask({
    taskId,
    parentSessionId: input.parentSessionId,
    title: input.title,
    command: input.command,
    cwd: input.cwd,
    pid: null,
    stdoutPath,
    stderrPath,
    status: "starting"
  });
  await notifyBackgroundTerminalEvent(input, {
    type: "background_terminal_registered",
    taskId,
    stdoutPath,
    stderrPath,
    command: input.command,
    status: "starting"
  });
  const started = process.platform === "win32"
    ? await startWindowsBackgroundShell({ ...input, taskId, logDir, stdoutPath, stderrPath, scrubbed })
    : startPosixBackgroundShell({ ...input, taskId, stdoutPath, stderrPath, scrubbed });
  if (started.error) {
    updateBackgroundTerminalTask(taskId, {
      status: started.cancelled ? "cancelled" : "failed",
      error: started.error.message,
      launcherPid: started.launcherPid ?? null,
      cancelledAt: started.cancelled ? new Date().toISOString() : null
    });
    return {
      taskId,
      command: input.command,
      exitCode: null,
      started: false,
      launcherPid: started.launcherPid ?? null,
      stdoutPath,
      stderrPath,
      scrubbedEnv: scrubbed.removed,
      error: started.error
    };
  }
  updateBackgroundTerminalTask(taskId, {
    status: "running",
    pid: started.pid,
    launcherPid: started.launcherPid ?? null
  });
  return {
    taskId,
    command: input.command,
    pid: started.pid,
    launcherPid: started.launcherPid ?? null,
    started: true,
    detached: true,
    stdoutPath,
    stderrPath,
    scrubbedEnv: scrubbed.removed
  };
}

async function startWindowsBackgroundShell(input) {
  const workerPath = path.join(input.logDir, `${input.taskId}.worker.ps1`);
  const launcherPath = path.join(input.logDir, `${input.taskId}.launcher.ps1`);
  await fs.promises.writeFile(workerPath, [
    "$ErrorActionPreference = 'Continue'",
    `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`,
    `& {`,
    input.command,
    `} 1>> ${powerShellSingleQuoted(input.stdoutPath)} 2>> ${powerShellSingleQuoted(input.stderrPath)}`,
    ""
  ].join("\r\n"), "utf8");
  await fs.promises.writeFile(launcherPath, [
    "$ErrorActionPreference = 'Stop'",
    `$process = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File', ${powerShellSingleQuoted(workerPath)}) -WorkingDirectory ${powerShellSingleQuoted(input.cwd)} -WindowStyle Hidden -PassThru`,
    "Write-Output $process.Id",
    ""
  ].join("\r\n"), "utf8");
  return new Promise((resolve) => {
    let settled = false;
    let launcherPid = null;
    const launcher = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", launcherPath], {
      cwd: input.cwd,
      env: input.scrubbed.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      input.signal?.removeEventListener?.("abort", onAbort);
      resolve({ launcherPid, ...result });
    };
    const terminateLauncher = () => {
      if (launcher.pid) {
        killWindowsProcessTree(launcher.pid);
      }
      try {
        launcher.kill("SIGTERM");
      } catch {
        // The launcher may already have exited.
      }
    };
    const onAbort = () => {
      terminateLauncher();
      finish({
        cancelled: true,
        error: {
          code: "BACKGROUND_SHELL_INTERRUPTED",
          message: "Background shell launcher was interrupted by the local user."
        }
      });
    };
    const timeout = setTimeout(() => {
      terminateLauncher();
      finish({
        error: {
          code: "BACKGROUND_SHELL_LAUNCH_TIMEOUT",
          message: "Background shell launcher timed out before returning a process id."
        }
      });
    }, DEFAULT_BACKGROUND_LAUNCH_TIMEOUT_MS);
    input.signal?.addEventListener?.("abort", onAbort, { once: true });
    const stdout = [];
    const stderr = [];
    launcher.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    launcher.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    launcher.on("spawn", () => {
      launcherPid = launcher.pid ?? null;
      updateBackgroundTerminalTask(input.taskId, { launcherPid });
      if (input.signal?.aborted) {
        onAbort();
      }
    });
    launcher.on("error", (error) => {
      finish({
        error: {
          code: "BACKGROUND_SHELL_SPAWN_ERROR",
          message: error instanceof Error ? error.message : String(error)
        }
      });
    });
    launcher.on("close", (exitCode) => {
      if (settled) {
        return;
      }
      const pid = Number(Buffer.concat(stdout).toString("utf8").trim().split(/\s+/).find((part) => /^\d+$/.test(part)));
      if (exitCode !== 0 || !Number.isFinite(pid)) {
        finish({
          error: {
            code: "BACKGROUND_SHELL_SPAWN_ERROR",
            message: Buffer.concat(stderr).toString("utf8").trim() || `Background launcher exited ${exitCode}`
          }
        });
        return;
      }
      finish({ pid });
    });
  });
}

function startPosixBackgroundShell(input) {
  const stdout = fs.openSync(input.stdoutPath, "a");
  const stderr = fs.openSync(input.stderrPath, "a");
  let child;
  let streamsClosed = false;
  const closeStreams = () => {
    if (streamsClosed) {
      return;
    }
    streamsClosed = true;
    fs.closeSync(stdout);
    fs.closeSync(stderr);
  };
  try {
    child = spawn("bash", ["-lc", input.command], {
      cwd: input.cwd,
      env: input.scrubbed.env,
      detached: true,
      stdio: ["ignore", stdout, stderr]
    });
  } catch (error) {
    closeStreams();
    return {
      error: {
        code: "BACKGROUND_SHELL_SPAWN_ERROR",
        message: error instanceof Error ? error.message : String(error)
      }
    };
  }
  child.unref?.();
  child.on("close", (exitCode, signal) => {
    updateBackgroundTerminalTask(input.taskId, {
      status: exitCode === 0 ? "completed" : "failed",
      exitCode,
      signal
    });
    closeStreams();
  });
  child.on("error", (error) => {
    updateBackgroundTerminalTask(input.taskId, {
      status: "failed",
      error: error instanceof Error ? error.message : String(error)
    });
    closeStreams();
  });
  return { pid: child.pid };
}

async function notifyBackgroundTerminalEvent(input, event) {
  if (typeof input.onBackgroundTerminalEvent !== "function") {
    return;
  }
  await input.onBackgroundTerminalEvent(event);
}

/**
 * @param {{ executable: string; args: string[]; cwd: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal; policy?: Record<string, any> }} input
 */
function runShellCommand(input) {
  const timeoutMs = Math.min(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const scrubbed = scrubEnvironment(input.env ?? process.env, { allowSensitive: input.policy?.fullAccess === true });
  const startedAt = Date.now();
  const command = input.args.at(-1) ?? "";

  if (input.signal?.aborted) {
    return Promise.resolve(interruptedShellResult(command, scrubbed.removed, startedAt, "Shell command was interrupted before it started."));
  }

  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(input.executable, input.args, {
      cwd: input.cwd,
      env: scrubbed.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32"
    });

    let stdout = createOutputCollector();
    let stderr = createOutputCollector();
    let timedOut = false;
    let interrupted = false;
    let escalationTimer = null;

    const timeout = setTimeout(() => {
      timedOut = true;
      requestTermination(child, "timeout");
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      if (escalationTimer) {
        clearTimeout(escalationTimer);
        escalationTimer = null;
      }
      input.signal?.removeEventListener?.("abort", onAbort);
    };

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    };

    const onAbort = () => {
      interrupted = true;
      requestTermination(child, "abort");
    };

    input.signal?.addEventListener?.("abort", onAbort, { once: true });

    /**
     * @param {import("node:child_process").ChildProcess} target
     * @param {"timeout" | "abort"} reason
     */
    function requestTermination(target, reason) {
      if (reason === "abort") {
        interrupted = true;
      }
      if (!target.pid) {
        target.kill("SIGTERM");
        return;
      }
      if (process.platform === "win32") {
        killWindowsProcessTree(target.pid);
        target.kill("SIGTERM");
        return;
      }
      try {
        process.kill(-target.pid, "SIGTERM");
      } catch {
        target.kill("SIGTERM");
      }
      if (!escalationTimer) {
        escalationTimer = setTimeout(() => {
          try {
            process.kill(-target.pid, "SIGKILL");
          } catch {
            target.kill("SIGKILL");
          }
        }, 750);
      }
    }

    child.stdout.on("data", (chunk) => {
      stdout.append(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr.append(chunk);
    });

    child.on("spawn", () => {
      if (input.signal?.aborted) {
        onAbort();
      }
    });

    child.on("error", (error) => {
      finish({
        command,
        exitCode: null,
        signal: null,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        scrubbedEnv: scrubbed.removed,
        interrupted,
        error: {
          code: interrupted ? "SHELL_INTERRUPTED" : error && typeof error === "object" && "code" in error ? String(error.code) : "SHELL_SPAWN_ERROR",
          message: error instanceof Error ? error.message : String(error)
        }
      });
    });

    child.on("close", (exitCode, signal) => {
      finish({
        command,
        exitCode,
        signal,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        stdoutBytes: stdout.bytes,
        stderrBytes: stderr.bytes,
        scrubbedEnv: scrubbed.removed,
        ...(interrupted ? {
          interrupted: true,
          error: { code: "SHELL_INTERRUPTED", message: "Shell command was interrupted by the local user." }
        } : {})
      });
    });
  });
}

function sanitizeTaskId(value) {
  return String(value ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function powerShellSingleQuoted(value) {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

/**
 * @param {number} pid
 */
function killWindowsProcessTree(pid) {
  try {
    const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
      windowsHide: true,
      stdio: "ignore"
    });
    killer.unref?.();
  } catch {
    // child.kill fallback is attempted by the caller.
  }
}

/**
 * @param {string} command
 * @param {string[]} scrubbedEnv
 * @param {number} startedAt
 * @param {string} message
 */
function interruptedShellResult(command, scrubbedEnv, startedAt, message) {
  return {
    command,
    exitCode: null,
    signal: null,
    timedOut: false,
    durationMs: Date.now() - startedAt,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    scrubbedEnv,
    interrupted: true,
    error: { code: "SHELL_INTERRUPTED", message }
  };
}

/**
 * @param {Buffer} current
 * @param {Buffer} chunk
 */
function createOutputCollector() {
  let chunks = [];
  let bytes = 0;

  return {
    get bytes() {
      return bytes;
    },
    get truncated() {
      return false;
    },
    append(chunk) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      chunks.push(buffer);
    },
    toString() {
      return Buffer.concat(chunks).toString("utf8");
    }
  };
}
