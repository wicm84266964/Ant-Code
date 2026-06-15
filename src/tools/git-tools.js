import { spawn } from "node:child_process";
import path from "node:path";
import { isInside } from "../permissions/policy-engine.js";

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * @param {{ cwd: string; pathspecs?: string[] }} input
 */
export async function gitStatusTool(input) {
  const pathspecs = normalizePathspecs(input.cwd, input.pathspecs ?? []);
  const args = ["status", "--short", "--branch"];
  if (pathspecs.length > 0) {
    args.push("--", ...pathspecs);
  }
  return runGit(input.cwd, args);
}

/**
 * @param {{ cwd: string; pathspecs?: string[]; stat?: boolean }} input
 */
export async function gitDiffTool(input) {
  const pathspecs = normalizePathspecs(input.cwd, input.pathspecs ?? []);
  const args = ["diff"];
  if (input.stat) {
    args.push("--stat");
  }
  if (pathspecs.length > 0) {
    args.push("--", ...pathspecs);
  }
  return runGit(input.cwd, args);
}

/**
 * @param {string} cwd
 * @param {string[]} pathspecs
 */
function normalizePathspecs(cwd, pathspecs) {
  if (!Array.isArray(pathspecs)) {
    return [];
  }
  const workspace = path.resolve(cwd);
  return pathspecs.map((item) => {
    const value = String(item ?? "").trim();
    if (!value) {
      return null;
    }
    if (value.startsWith("-")) {
      throw new Error("git pathspecs must not start with '-'");
    }
    const resolved = path.resolve(workspace, value);
    if (!isInside(workspace, resolved)) {
      throw new Error("git pathspec resolves outside the workspace");
    }
    return value;
  }).filter(Boolean);
}

/**
 * @param {string} cwd
 * @param {string[]} args
 */
function runGit(cwd, args) {
  const startedAt = Date.now();

  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd,
      windowsHide: true
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, DEFAULT_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      const buffer = Buffer.from(chunk);
      stdout.push(buffer);
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
        command: `git ${args.join(" ")}`,
        exitCode: null,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        error: {
          code: error && typeof error === "object" && "code" in error ? String(error.code) : "GIT_SPAWN_ERROR",
          message: error instanceof Error ? error.message : String(error)
        }
      });
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      resolve({
        command: `git ${args.join(" ")}`,
        exitCode,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout: Buffer.concat(stdout, stdoutBytes).toString("utf8"),
        stderr: Buffer.concat(stderr, stderrBytes).toString("utf8"),
        stdoutTruncated: false,
        stderrTruncated: false
      });
    });
  });
}
