import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  registerBackgroundTerminalProcess,
  registerBackgroundTerminalTask,
  updateBackgroundTerminalTask
} from "../agents/background-terminal-registry.ts";
import { scrubEnvironment } from "./env-scrubber.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_BACKGROUND_LOG_DIR = ".lab-agent/background-terminal";
const DEFAULT_BACKGROUND_LAUNCH_TIMEOUT_MS = 15_000;
const SHELL_TERMINATION_ESCALATION_MS = 750;
const SHELL_TERMINATION_SETTLE_MS = 2_000;
const MAX_SHELL_OUTPUT_BYTES = 4 * 1024 * 1024;
const SHELL_OUTPUT_TRUNCATION_MARKER = Buffer.from("\n...[shell output truncated; preserving head and tail]...\n", "utf8");

type ScrubResult = ReturnType<typeof scrubEnvironment>;

type BackgroundStartResult = {
  pid?: number | null;
  launcherPid?: number | null;
  cancelled?: boolean;
  registryUpdated?: boolean;
  error?: { code: string; message: string };
};

type BackgroundShellToolInput = {
  cwd: string;
  command: string;
  title?: string;
  taskId?: string;
  logDir?: string;
  env?: NodeJS.ProcessEnv;
  policy?: Record<string, unknown>;
  parentSessionId?: string;
  signal?: AbortSignal;
  onBackgroundTerminalEvent?: (event: Record<string, unknown>) => unknown;
};

type BackgroundLaunchInput = BackgroundShellToolInput & {
  taskId: string;
  terminalInstanceId: string;
  stdoutPath: string;
  stderrPath: string;
  scrubbed: ScrubResult;
  logDir?: string;
};

type ShellCommandResult = {
  command: string;
  exitCode: number | null;
  signal: NodeJS.Signals | string | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  stdoutBytes?: number;
  stderrBytes?: number;
  scrubbedEnv: string[];
  interrupted?: boolean;
  terminationUnconfirmed?: boolean;
  error?: { code: string; message: string };
};

/**
 * @param {{ cwd: string; command: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal; policy?: Record<string, unknown> }} input
 */
export async function powershellTool(input: { cwd: string; command: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal; policy?: Record<string, unknown> }) {
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
 * @param {{ cwd: string; command: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal; policy?: Record<string, unknown> }} input
 */
export async function bashTool(input: { cwd: string; command: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal; policy?: Record<string, unknown> }) {
  const launch = resolveBashInvocation(input.cwd, input.command, { env: input.env });
  return runShellCommand({
    executable: launch.executable,
    args: launch.args,
    cwd: launch.cwd,
    timeoutMs: input.timeoutMs,
    env: input.env,
    signal: input.signal,
    policy: input.policy
  });
}

export function resolveBashInvocation(
  cwd: string,
  command: string,
  options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; executable?: string } = {}
) {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return { executable: "bash", args: ["-lc", command], cwd };
  }
  const env = options.env ?? process.env;
  const executable = options.executable || findWindowsBash(env);
  if (isWslBash(executable)) {
    const wslCwd = toWslPath(cwd);
    return {
      executable,
      args: ["-lc", `cd ${posixShellSingleQuote(wslCwd)} && ${command}`],
      cwd: windowsWslLaunchCwd(env)
    };
  }
  return { executable, args: ["-lc", command], cwd };
}

function findWindowsBash(env: NodeJS.ProcessEnv) {
  const programFiles = env.ProgramFiles || "C:\\Program Files";
  const localAppData = env.LOCALAPPDATA || "";
  const candidates = [
    env.LAB_AGENT_BASH,
    env.GIT_BASH,
    path.join(programFiles, "Git", "bin", "bash.exe"),
    path.join(programFiles, "Git", "usr", "bin", "bash.exe"),
    localAppData ? path.join(localAppData, "Programs", "Git", "bin", "bash.exe") : ""
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return "bash";
}

function isWslBash(executable: string) {
  const normalized = String(executable ?? "").replace(/\//g, "\\").toLowerCase();
  return normalized.endsWith("\\system32\\bash.exe")
    || normalized.endsWith("\\sysnative\\bash.exe")
    || normalized.includes("\\windowsapps\\");
}

function toWslPath(windowsPath: string) {
  const normalized = String(windowsPath ?? "").replace(/\//g, "\\");
  const match = normalized.match(/^([A-Za-z]):\\(.*)$/);
  if (match) {
    return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, "/")}`;
  }
  if (process.platform !== "win32") {
    return normalized.replace(/\\/g, "/");
  }
  const resolved = path.resolve(windowsPath);
  const resolvedMatch = resolved.replace(/\//g, "\\").match(/^([A-Za-z]):\\(.*)$/);
  if (!resolvedMatch) {
    return resolved.replace(/\\/g, "/");
  }
  return `/mnt/${resolvedMatch[1].toLowerCase()}/${resolvedMatch[2].replace(/\\/g, "/")}`;
}

function windowsWslLaunchCwd(env: NodeJS.ProcessEnv) {
  const systemRoot = env.SystemRoot || env.WINDIR || "C:\\Windows";
  const system32 = path.join(systemRoot, "System32");
  return fs.existsSync(system32) ? system32 : systemRoot;
}

function posixShellSingleQuote(value: string) {
  return `'${String(value ?? "").replace(/'/g, `'\\''`)}'`;
}

/**
 * @param {{ cwd: string; command: string; title?: string; taskId?: string; logDir?: string; env?: NodeJS.ProcessEnv; policy?: Record<string, unknown>; parentSessionId?: string }} input
 */
export async function backgroundShellTool(input: BackgroundShellToolInput) {
  const taskId = sanitizeTaskId(input.taskId) || `terminal-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const terminalInstanceId = randomUUID();
  const logDir = path.resolve(input.cwd, input.logDir || DEFAULT_BACKGROUND_LOG_DIR);
  await fs.promises.mkdir(logDir, { recursive: true });
  const stdoutPath = path.join(logDir, `${taskId}.stdout.log`);
  const stderrPath = path.join(logDir, `${taskId}.stderr.log`);
  const scrubbed = scrubEnvironment(input.env ?? process.env, { allowSensitive: input.policy?.fullAccess === true });
  try {
    registerBackgroundTerminalTask({
      taskId,
      instanceId: terminalInstanceId,
      parentSessionId: input.parentSessionId,
      title: input.title,
      command: input.command,
      cwd: input.cwd,
      pid: null,
      stdoutPath,
      stderrPath,
      status: "starting"
    });
  } catch (error) {
    return {
      taskId,
      command: input.command,
      exitCode: null,
      started: false,
      stdoutPath,
      stderrPath,
      scrubbedEnv: scrubbed.removed,
      error: {
        code: error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "BACKGROUND_TERMINAL_TASK_ID_CONFLICT",
        message: error instanceof Error ? error.message : String(error)
      }
    };
  }
  await notifyBackgroundTerminalEvent(input, {
    type: "background_terminal_registered",
    taskId,
    stdoutPath,
    stderrPath,
    command: input.command,
    status: "starting"
  });
  const started = process.platform === "win32"
    ? await startWindowsBackgroundShell({ ...input, taskId, terminalInstanceId, logDir, stdoutPath, stderrPath, scrubbed })
    : startPosixBackgroundShell({ ...input, taskId, terminalInstanceId, stdoutPath, stderrPath, scrubbed });
  if (started.error) {
    updateBackgroundTerminalTask(taskId, {
      instanceId: terminalInstanceId,
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
  if (started.registryUpdated !== true) {
    updateBackgroundTerminalTask(taskId, {
      instanceId: terminalInstanceId,
      status: "running",
      pid: started.pid,
      launcherPid: started.launcherPid ?? null
    });
  }
  return {
    taskId,
    command: input.command,
    pid: started.pid,
    launcherPid: started.launcherPid ?? null,
    started: true,
    detached: process.platform !== "win32",
    stdoutPath,
    stderrPath,
    scrubbedEnv: scrubbed.removed
  };
}

async function startWindowsBackgroundShell(input: BackgroundLaunchInput & { logDir: string }): Promise<BackgroundStartResult> {
  const workerPath = path.join(input.logDir, `${input.taskId}.worker.ps1`);
  await fs.promises.writeFile(workerPath, [
    "$ErrorActionPreference = 'Continue'",
    input.command,
    ""
  ].join("\r\n"), "utf8");
  return new Promise((resolve) => {
    let settled = false;
    let stdoutFd = -1;
    let stderrFd = -1;
    let streamsClosed = false;
    const closeStreams = () => {
      if (streamsClosed) {
        return;
      }
      streamsClosed = true;
      if (stdoutFd >= 0) {
        fs.closeSync(stdoutFd);
        stdoutFd = -1;
      }
      if (stderrFd >= 0) {
        fs.closeSync(stderrFd);
        stderrFd = -1;
      }
    };
    try {
      stdoutFd = fs.openSync(input.stdoutPath, "a");
      stderrFd = fs.openSync(input.stderrPath, "a");
    } catch (error) {
      closeStreams();
      resolve({
        launcherPid: null,
        error: {
          code: "BACKGROUND_SHELL_SPAWN_ERROR",
          message: error instanceof Error ? error.message : String(error)
        }
      });
      return;
    }
    let worker: ChildProcess;
    try {
      worker = spawn("powershell.exe", [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        workerPath
      ], {
        cwd: input.cwd,
        env: input.scrubbed.env,
        windowsHide: true,
        detached: false,
        stdio: ["ignore", stdoutFd, stderrFd]
      });
    } catch (error) {
      closeStreams();
      resolve({
        launcherPid: null,
        error: {
          code: "BACKGROUND_SHELL_SPAWN_ERROR",
          message: error instanceof Error ? error.message : String(error)
        }
      });
      return;
    }
    const finish = (result: BackgroundStartResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      input.signal?.removeEventListener?.("abort", onAbort);
      resolve({ launcherPid: null, ...result });
    };
    const terminateWorker = () => {
      if (worker.pid) {
        killWindowsProcessTree(worker.pid);
      }
      try {
        worker.kill("SIGTERM");
      } catch {
        // The worker may already have exited.
      }
    };
    const onAbort = () => {
      terminateWorker();
      finish({
        cancelled: true,
        error: {
          code: "BACKGROUND_SHELL_INTERRUPTED",
          message: "Background shell launcher was interrupted by the local user."
        }
      });
    };
    const timeout = setTimeout(() => {
      terminateWorker();
      finish({
        error: {
          code: "BACKGROUND_SHELL_LAUNCH_TIMEOUT",
          message: "Background shell worker timed out before confirming startup."
        }
      });
    }, DEFAULT_BACKGROUND_LAUNCH_TIMEOUT_MS);
    input.signal?.addEventListener?.("abort", onAbort, { once: true });
    bindBackgroundChildExit(worker, input, closeStreams);
    worker.on("spawn", () => {
      const pid = worker.pid ?? null;
      const updated = updateBackgroundTerminalTask(input.taskId, {
        instanceId: input.terminalInstanceId,
        status: "running",
        pid,
        launcherPid: null
      });
      if (!updated || !registerBackgroundTerminalProcess(input.taskId, input.terminalInstanceId, worker)) {
        terminateWorker();
        finish({
          error: {
            code: "BACKGROUND_SHELL_REGISTRATION_ERROR",
            message: "Background shell worker started but could not be attached to its terminal record."
          }
        });
        return;
      }
      if (input.signal?.aborted) {
        onAbort();
        return;
      }
      finish({ pid, registryUpdated: true });
    });
    worker.on("error", (error: unknown) => {
      finish({
        error: {
          code: "BACKGROUND_SHELL_SPAWN_ERROR",
          message: error instanceof Error ? error.message : String(error)
        }
      });
    });
  });
}

function startPosixBackgroundShell(input: BackgroundLaunchInput): BackgroundStartResult {
  const stdout = fs.openSync(input.stdoutPath, "a");
  const stderr = fs.openSync(input.stderrPath, "a");
  let child: ChildProcess;
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
  bindBackgroundChildExit(child, input, closeStreams);
  return { pid: child.pid };
}

function bindBackgroundChildExit(child: ChildProcess, input: BackgroundLaunchInput, closeStreams?: () => void) {
  child.on("close", (exitCode, signal) => {
    const stoppedExternally = signal === "SIGTERM" || signal === "SIGINT" || signal === "SIGHUP";
    updateBackgroundTerminalTask(input.taskId, {
      instanceId: input.terminalInstanceId,
      status: exitCode === 0 || stoppedExternally ? "completed" : "failed",
      exitCode,
      signal: signal ?? null
    });
    closeStreams?.();
  });
  child.on("error", (error: Error) => {
    updateBackgroundTerminalTask(input.taskId, {
      instanceId: input.terminalInstanceId,
      status: "failed",
      error: error.message
    });
    closeStreams?.();
  });
}

async function notifyBackgroundTerminalEvent(input: BackgroundShellToolInput, event: Record<string, unknown>) {
  if (typeof input.onBackgroundTerminalEvent !== "function") {
    return;
  }
  await input.onBackgroundTerminalEvent(event);
}

/**
 * @param {{ executable: string; args: string[]; cwd: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal; policy?: Record<string, unknown>; spawnProcess?: typeof spawn; terminationSettleMs?: number }} input
 */
export function runShellCommand(input: { executable: string; args: string[]; cwd: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal; policy?: Record<string, unknown>; spawnProcess?: typeof spawn; terminationSettleMs?: number }) {
  const timeoutMs = Math.min(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const terminationSettleMs = Math.max(1, Number(input.terminationSettleMs) || SHELL_TERMINATION_SETTLE_MS);
  const scrubbed = scrubEnvironment(input.env ?? process.env, { allowSensitive: input.policy?.fullAccess === true });
  const startedAt = Date.now();
  const command = input.args.at(-1) ?? "";

  if (input.signal?.aborted) {
    return Promise.resolve(interruptedShellResult(command, scrubbed.removed, startedAt, "Shell command was interrupted before it started."));
  }

  return new Promise<ShellCommandResult>((resolve) => {
    let settled = false;
    const child = (input.spawnProcess ?? spawn)(input.executable, input.args, {
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
    let escalationTimer: ReturnType<typeof setTimeout> | null = null;
    let terminationSettleTimer: ReturnType<typeof setTimeout> | null = null;

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
      if (terminationSettleTimer) {
        clearTimeout(terminationSettleTimer);
        terminationSettleTimer = null;
      }
      input.signal?.removeEventListener?.("abort", onAbort);
    };

    const finish = (result: ShellCommandResult) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    };

    const forceSettleTermination = () => {
      child.stdout?.removeListener?.("data", onStdoutData);
      child.stderr?.removeListener?.("data", onStderrData);
      child.stdout?.destroy?.();
      child.stderr?.destroy?.();
      child.unref?.();
      finish({
        command,
        exitCode: null,
        signal: null,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        stdoutBytes: stdout.bytes,
        stderrBytes: stderr.bytes,
        scrubbedEnv: scrubbed.removed,
        interrupted,
        terminationUnconfirmed: true,
        error: {
          code: interrupted ? "SHELL_INTERRUPTED" : "SHELL_TIMEOUT",
          message: interrupted
            ? "Shell command did not confirm exit after interruption; control was returned after the termination grace period."
            : "Shell command did not confirm exit before the termination grace period expired."
        }
      });
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
    function requestTermination(target: import("node:child_process").ChildProcess, reason: "timeout" | "abort") {
      if (reason === "abort") {
        interrupted = true;
      }
      if (!terminationSettleTimer) {
        terminationSettleTimer = setTimeout(forceSettleTermination, terminationSettleMs);
      }
      const pid = target.pid;
      if (!pid) {
        target.kill("SIGTERM");
        return;
      }
      if (process.platform === "win32") {
        killWindowsProcessTree(pid);
        target.kill("SIGTERM");
      } else {
        try {
          process.kill(-pid, "SIGTERM");
        } catch {
          target.kill("SIGTERM");
        }
      }
      if (!escalationTimer) {
        escalationTimer = setTimeout(() => {
          try {
            if (process.platform === "win32") {
              killWindowsProcessTree(pid);
              target.kill("SIGKILL");
            } else {
              process.kill(-pid, "SIGKILL");
            }
          } catch {
            target.kill("SIGKILL");
          }
        }, Math.min(SHELL_TERMINATION_ESCALATION_MS, terminationSettleMs));
      }
    }

    const onStdoutData = (chunk: Buffer | string) => {
      stdout.append(chunk);
    };

    const onStderrData = (chunk: Buffer | string) => {
      stderr.append(chunk);
    };

    child.stdout.on("data", onStdoutData);
    child.stderr.on("data", onStderrData);

    child.on("spawn", () => {
      if (input.signal?.aborted) {
        onAbort();
      }
    });

    child.on("error", (error: unknown) => {
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

function sanitizeTaskId(value: unknown) {
  return String(value ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/**
 * @param {number} pid
 */
function killWindowsProcessTree(pid: number) {
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
function interruptedShellResult(command: string, scrubbedEnv: string[], startedAt: number, message: string) {
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

/** @param {number} [maxBytes] */
export function createOutputCollector(maxBytes: number = MAX_SHELL_OUTPUT_BYTES) {
  const limit = Math.max(SHELL_OUTPUT_TRUNCATION_MARKER.length + 2, Math.trunc(Number(maxBytes) || MAX_SHELL_OUTPUT_BYTES));
  const retainedLimit = limit - SHELL_OUTPUT_TRUNCATION_MARKER.length;
  const headLimit = Math.floor(retainedLimit / 2);
  const tailLimit = retainedLimit - headLimit;
  let chunks: Buffer[] = [];
  let head: Buffer | null = null;
  let tail: Buffer | null = null;
  let retainedBytes = 0;
  let bytes = 0;
  let truncated = false;

  return {
    get bytes() {
      return bytes;
    },
    get truncated() {
      return truncated;
    },
    append(chunk: Buffer | Uint8Array | string) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (!truncated && retainedBytes + buffer.length <= limit) {
        chunks.push(buffer);
        retainedBytes += buffer.length;
        return;
      }
      if (!truncated) {
        const combined = Buffer.concat([...chunks, buffer], retainedBytes + buffer.length);
        head = Buffer.from(combined.subarray(0, headLimit));
        tail = Buffer.from(combined.subarray(Math.max(headLimit, combined.length - tailLimit)));
        chunks = [];
        retainedBytes = 0;
        truncated = true;
        return;
      }
      const combinedTail = Buffer.concat([tail ?? Buffer.alloc(0), buffer]);
      tail = Buffer.from(combinedTail.subarray(Math.max(0, combinedTail.length - tailLimit)));
    },
    toString() {
      if (!truncated) {
        return Buffer.concat(chunks, retainedBytes).toString("utf8");
      }
      return Buffer.concat([
        head ?? Buffer.alloc(0),
        SHELL_OUTPUT_TRUNCATION_MARKER,
        tail ?? Buffer.alloc(0)
      ]).toString("utf8");
    }
  };
}
