import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { isInside } from "../permissions/policy-engine.js";
import { normalizeToolPath } from "../permissions/path-utils.js";

const require = createRequire(import.meta.url);
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESULTS = 100;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_CONTEXT_LINES = 20;
const WINDOWS_RESERVED_DEVICE_NAMES = Object.freeze([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9"
]);

export async function rgSearchTool(input) {
  const root = await resolveWorkspacePath(input.cwd, input.path ?? ".");
  const maxResults = positiveInteger(input.maxResults, DEFAULT_MAX_RESULTS);
  const args = [
    "--json",
    "--color", "never",
    "--line-number",
    "--column",
    ...commonRgArgs(input),
    String(input.pattern ?? ""),
    root
  ];
  const result = await runRg(input.cwd, args, input);
  if (!result.ok) {
    return result;
  }
  const parsed = parseJsonSearchOutput(input.cwd, result.stdout, maxResults);
  return {
    command: result.command,
    matches: parsed.matches,
    stats: parsed.stats,
    warning: result.warning,
    partialFailure: result.partialFailure,
    truncated: result.truncated || parsed.truncated,
    timedOut: result.timedOut,
    durationMs: result.durationMs
  };
}

export async function rgFilesTool(input) {
  const root = await resolveWorkspacePath(input.cwd, input.path ?? ".");
  const maxResults = positiveInteger(input.maxResults, DEFAULT_MAX_RESULTS);
  const args = ["--files", "--color", "never", ...fileRgArgs(input), root];
  const result = await runRg(input.cwd, args, input);
  if (!result.ok) {
    return result;
  }
  return lineListResult(input.cwd, result, maxResults, "files");
}

export async function rgFilesWithMatchesTool(input) {
  const root = await resolveWorkspacePath(input.cwd, input.path ?? ".");
  const maxResults = positiveInteger(input.maxResults, DEFAULT_MAX_RESULTS);
  const args = ["--files-with-matches", "--color", "never", ...commonRgArgs(input), String(input.pattern ?? ""), root];
  const result = await runRg(input.cwd, args, input);
  if (!result.ok) {
    return result;
  }
  return lineListResult(input.cwd, result, maxResults, "files");
}

export async function rgCountTool(input) {
  const root = await resolveWorkspacePath(input.cwd, input.path ?? ".");
  const mode = String(input.mode ?? "matches").toLowerCase();
  const args = [mode === "files" ? "--files-with-matches" : "--count-matches", "--color", "never", ...commonRgArgs(input), String(input.pattern ?? ""), root];
  const result = await runRg(input.cwd, args, input);
  if (!result.ok) {
    return result;
  }
  if (mode === "files") {
    const files = result.stdout.split(/\r?\n/).filter(Boolean);
    return {
    command: result.command,
    mode: "files",
    count: files.length,
    warning: result.warning,
    partialFailure: result.partialFailure,
    truncated: result.truncated,
    timedOut: result.timedOut,
    durationMs: result.durationMs
    };
  }
  let count = 0;
  for (const line of result.stdout.split(/\r?\n/)) {
    const text = line.trim();
    if (!text) {
      continue;
    }
    const prefixed = text.match(/:(\d+)$/);
    const value = prefixed ? prefixed[1] : text;
    if (/^\d+$/.test(value)) {
      count += Number.parseInt(value, 10);
    }
  }
  return {
    command: result.command,
    mode: "matches",
    count,
    warning: result.warning,
    partialFailure: result.partialFailure,
    truncated: result.truncated,
    timedOut: result.timedOut,
    durationMs: result.durationMs
  };
}

function commonRgArgs(input) {
  const args = [];
  if (input.ignoreCase === true) args.push("--ignore-case");
  if (input.caseSensitive === true) args.push("--case-sensitive");
  if (input.fixedStrings === true) args.push("--fixed-strings");
  if (input.wordRegexp === true) args.push("--word-regexp");
  if (input.multiline === true) args.push("--multiline");
  if (input.hidden === true) args.push("--hidden");
  if (input.noIgnore === true) args.push("--no-ignore");
  for (const glob of normalizeStringArray(input.glob)) {
    args.push("--glob", glob);
  }
  const before = boundedInteger(input.beforeContext, 0, MAX_CONTEXT_LINES);
  const after = boundedInteger(input.afterContext, 0, MAX_CONTEXT_LINES);
  if (before > 0) args.push("--before-context", String(before));
  if (after > 0) args.push("--after-context", String(after));
  return [...args, ...windowsReservedDeviceGlobArgs()];
}

function fileRgArgs(input) {
  const args = [];
  if (input.hidden === true) args.push("--hidden");
  if (input.noIgnore === true) args.push("--no-ignore");
  for (const glob of normalizeStringArray(input.glob)) {
    args.push("--glob", glob);
  }
  return [...args, ...windowsReservedDeviceGlobArgs()];
}

export function windowsReservedDeviceGlobArgs(platform = process.platform) {
  if (platform !== "win32") {
    return [];
  }
  const args = [];
  for (const name of WINDOWS_RESERVED_DEVICE_NAMES) {
    args.push("--glob", `!${name}`);
    args.push("--glob", `!${name}.*`);
    args.push("--glob", `!**/${name}`);
    args.push("--glob", `!**/${name}.*`);
  }
  return args;
}

function parseJsonSearchOutput(cwd, stdout, maxResults) {
  const matches = [];
  const stats = [];
  let truncated = false;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "match" || event.type === "context") {
      if (event.type === "match" && matches.filter((item) => item.type === "match").length >= maxResults) {
        truncated = true;
        continue;
      }
      matches.push({
        type: event.type,
        path: toDisplayPath(cwd, event.data?.path?.text ?? ""),
        line: event.data?.line_number ?? null,
        column: Array.isArray(event.data?.submatches) && event.data.submatches[0] ? event.data.submatches[0].start + 1 : null,
        text: stripLineEnding(event.data?.lines?.text ?? ""),
        submatches: Array.isArray(event.data?.submatches)
          ? event.data.submatches.map((item) => ({ start: item.start + 1, end: item.end + 1, match: item.match?.text ?? "" }))
          : []
      });
    } else if (event.type === "summary") {
      stats.push(event.data?.stats ?? {});
    }
  }
  return { matches, stats: stats[0] ?? {}, truncated };
}

function lineListResult(cwd, result, maxResults, key) {
  const lines = result.stdout.split(/\r?\n/).filter(Boolean).map((item) => toDisplayPath(cwd, item));
  const values = lines.slice(0, maxResults);
  return {
    command: result.command,
    [key]: values,
    warning: result.warning,
    partialFailure: result.partialFailure,
    truncated: result.truncated || lines.length > values.length,
    timedOut: result.timedOut,
    durationMs: result.durationMs
  };
}

async function runRg(cwd, args, input) {
  const executable = await findRgExecutable(input);
  if (!executable) {
    return {
      ok: false,
      error: {
        code: "RG_NOT_FOUND",
        message: "ripgrep executable was not found. Install rg or configure ANT_CODE_RG_PATH."
      }
    };
  }
  const startedAt = Date.now();
  const timeoutMs = positiveInteger(input.timeoutMs, DEFAULT_TIMEOUT_MS);
  const maxOutputBytes = positiveInteger(input.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES);
  return new Promise((resolve) => {
    const child = spawn(executable, args, { cwd, windowsHide: true });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let truncated = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      const buffer = Buffer.from(chunk);
      if (stdoutBytes + buffer.length <= maxOutputBytes) {
        stdout.push(buffer);
      } else {
        truncated = true;
        const remaining = Math.max(0, maxOutputBytes - stdoutBytes);
        if (remaining > 0) stdout.push(buffer.subarray(0, remaining));
      }
      stdoutBytes += buffer.length;
    });
    child.stderr.on("data", (chunk) => {
      const buffer = Buffer.from(chunk);
      stderr.push(buffer);
      stderrBytes += buffer.length;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({
        ok: false,
        command: `rg ${args.join(" ")}`,
        error: {
          code: error && typeof error === "object" && "code" in error ? String(error.code) : "RG_SPAWN_ERROR",
          message: error instanceof Error ? error.message : String(error)
        }
      });
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      const stdoutText = Buffer.concat(stdout).toString("utf8");
      const stderrText = Buffer.concat(stderr, stderrBytes).toString("utf8");
      resolve(formatRgCloseResult({
        command: `rg ${args.join(" ")}`,
        exitCode,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout: stdoutText,
        stderr: stderrText,
        truncated
      }));
    });
  });
}

export function formatRgCloseResult({ command, exitCode, timedOut, durationMs, stdout, stderr, truncated }) {
  if (exitCode !== 0 && exitCode !== 1) {
    if (String(stdout ?? "").trim()) {
      return {
        ok: true,
        command,
        exitCode,
        timedOut,
        durationMs,
        stdout,
        stderr,
        truncated,
        partialFailure: true,
        warning: {
          code: timedOut ? "RG_PARTIAL_TIMEOUT" : "RG_PARTIAL_FAILURE",
          message: stderr || `rg exited with code ${exitCode} after returning partial output`
        }
      };
    }
    return {
      ok: false,
      command,
      exitCode,
      timedOut,
      durationMs,
      stderr,
      error: { code: timedOut ? "RG_TIMEOUT" : "RG_FAILED", message: stderr || `rg exited with code ${exitCode}` }
    };
  }
  return {
    ok: true,
    command,
    exitCode,
    timedOut,
    durationMs,
    stdout,
    stderr,
    truncated
  };
}

async function findRgExecutable(input) {
  const candidates = [
    input.rgPath,
    process.env.ANT_CODE_RG_PATH,
    bundledRgPath(),
    "rg"
  ].filter(Boolean).map(String);
  for (const candidate of candidates) {
    if (candidate === "rg") {
      return candidate;
    }
    const resolved = path.resolve(candidate);
    if (await fs.access(resolved).then(() => true).catch(() => false)) {
      return resolved;
    }
  }
  return null;
}

function bundledRgPath() {
  try {
    return require("@vscode/ripgrep").rgPath;
  } catch {
    return null;
  }
}

async function resolveWorkspacePath(cwd, targetPath) {
  const workspace = path.resolve(cwd);
  const resolved = path.resolve(workspace, normalizeToolPath(targetPath));
  if (!isInside(workspace, resolved)) {
    throw toolError("PATH_OUTSIDE_WORKSPACE", "path resolves outside workspace");
  }
  await fs.access(resolved);
  return resolved;
}

function toDisplayPath(cwd, filePath) {
  const workspace = path.resolve(cwd);
  const resolved = path.resolve(filePath);
  return isInside(workspace, resolved) ? toPosix(path.relative(workspace, resolved) || ".") : toPosix(filePath);
}

function toPosix(value) {
  return String(value).split(path.sep).join("/");
}

function stripLineEnding(value) {
  return String(value).replace(/\r?\n$/, "");
}

function normalizeStringArray(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item ?? "").trim()).filter(Boolean);
  }
  const text = String(value ?? "").trim();
  return text ? [text] : [];
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function boundedInteger(value, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number)) return min;
  return Math.max(min, Math.min(max, number));
}

function toolError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
