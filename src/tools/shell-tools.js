import { spawn } from "node:child_process";
import { scrubEnvironment } from "./env-scrubber.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

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
