import { spawn } from "node:child_process";
import path from "node:path";
import { isInside } from "../permissions/policy-engine.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_GIT_OUTPUT_BYTES = 96 * 1024;
const MAX_LOG_COUNT = 100;
const MAX_LIST_COUNT = 200;

/**
 * @param {{ cwd: string; pathspecs?: string[] }} input
 */
export async function gitStatusTool(input) {
  const pathspecs = normalizePathspecs(input.cwd, input.pathspecs ?? []);
  const args = ["status", "--short", "--branch"];
  if (pathspecs.length > 0) {
    args.push("--", ...pathspecs);
  }
  const result = await runGit(input.cwd, args);
  return {
    ...result,
    status: parseStatus(result.stdout)
  };
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
 * @param {{ cwd: string; maxCount?: number; path?: string; author?: string; grep?: string; since?: string }} input
 */
export async function gitLogTool(input) {
  const maxCount = clampInteger(input.maxCount, 20, 1, MAX_LOG_COUNT);
  const args = ["log", `--max-count=${maxCount}`, "--date=iso-strict", "--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%s"];
  if (input.author) {
    args.push(`--author=${safeOptionValue(input.author, "author")}`);
  }
  if (input.grep) {
    args.push(`--grep=${safeOptionValue(input.grep, "grep")}`);
  }
  if (input.since) {
    args.push(`--since=${safeOptionValue(input.since, "since")}`);
  }
  const filePath = normalizeOptionalPathspec(input.cwd, input.path);
  if (filePath) {
    args.push("--", filePath);
  }
  const result = await runGit(input.cwd, args);
  return {
    ...result,
    commits: parseLog(result.stdout)
  };
}

/**
 * @param {{ cwd: string; revision: string; path?: string; stat?: boolean; maxBytes?: number }} input
 */
export async function gitShowTool(input) {
  const revision = normalizeRevision(input.revision);
  const filePath = normalizeOptionalPathspec(input.cwd, input.path);
  const args = ["show", "--no-ext-diff", "--date=iso-strict"];
  if (input.stat) {
    args.push("--stat");
  }
  args.push(filePath ? `${revision}:${filePath}` : revision);
  return runGit(input.cwd, args, { maxBytes: clampInteger(input.maxBytes, MAX_GIT_OUTPUT_BYTES, 1024, MAX_GIT_OUTPUT_BYTES) });
}

/**
 * @param {{ cwd: string; all?: boolean; maxCount?: number }} input
 */
export async function gitBranchListTool(input) {
  const args = ["branch", input.all ? "--all" : "--list", "--format=%(refname:short)\t%(HEAD)\t%(upstream:short)\t%(objectname:short)\t%(subject)"];
  const result = await runGit(input.cwd, args);
  return {
    ...result,
    branches: parseBranchList(result.stdout).slice(0, clampInteger(input.maxCount, MAX_LIST_COUNT, 1, MAX_LIST_COUNT))
  };
}

/**
 * @param {{ cwd: string; maxCount?: number }} input
 */
export async function gitStashListTool(input) {
  const maxCount = clampInteger(input.maxCount, 50, 1, MAX_LIST_COUNT);
  const result = await runGit(input.cwd, ["stash", "list", `--max-count=${maxCount}`]);
  return {
    ...result,
    stashes: result.stdout.split(/\r?\n/).filter(Boolean).map(parseStashLine)
  };
}

/**
 * @param {{ cwd: string; pattern?: string; maxCount?: number }} input
 */
export async function gitTagListTool(input) {
  const args = ["tag", "--list"];
  if (input.pattern) {
    args.push(safePattern(input.pattern));
  }
  const result = await runGit(input.cwd, args);
  return {
    ...result,
    tags: result.stdout.split(/\r?\n/).filter(Boolean).slice(0, clampInteger(input.maxCount, MAX_LIST_COUNT, 1, MAX_LIST_COUNT))
  };
}

/**
 * @param {{ cwd: string; paths?: string[] }} input
 */
export async function gitAddTool(input) {
  const paths = normalizeExplicitPaths(input.cwd, input.paths ?? []);
  if (paths.length === 0) {
    throw new Error("git_add requires at least one explicit path");
  }
  const before = await gitStatusTool({ cwd: input.cwd });
  const result = await runGit(input.cwd, ["add", "--", ...paths]);
  const after = await gitStatusTool({ cwd: input.cwd });
  return {
    ...result,
    paths,
    before: before.status,
    after: after.status
  };
}

/**
 * @param {{ cwd: string; message: string; body?: string }} input
 */
export async function gitCommitTool(input) {
  const message = normalizeCommitMessage(input.message);
  const staged = await runGit(input.cwd, ["diff", "--cached", "--name-only"]);
  const stagedFiles = staged.stdout.split(/\r?\n/).filter(Boolean);
  if (staged.exitCode !== 0) {
    return { ...staged, committed: false, stagedFiles };
  }
  if (stagedFiles.length === 0) {
    return {
      command: "git commit",
      exitCode: 1,
      timedOut: false,
      durationMs: 0,
      stdout: "",
      stderr: "No staged files to commit.",
      stdoutTruncated: false,
      stderrTruncated: false,
      committed: false,
      stagedFiles,
      error: { code: "GIT_NOTHING_STAGED", message: "No staged files to commit." }
    };
  }
  const args = ["commit", "-m", message];
  const body = String(input.body ?? "").trim();
  if (body) {
    args.push("-m", body);
  }
  const result = await runGit(input.cwd, args);
  return {
    ...result,
    committed: result.exitCode === 0,
    stagedFiles
  };
}

/**
 * @param {{ cwd: string; action: string; name: string; startPoint?: string; force?: boolean }} input
 */
export async function gitBranchTool(input) {
  const name = normalizeRefName(input.name);
  const action = String(input.action ?? "");
  if (action === "create") {
    const args = ["branch", name];
    if (input.startPoint) {
      args.push(normalizeRevision(input.startPoint));
    }
    return runGit(input.cwd, args);
  }
  if (action === "switch") {
    return runGit(input.cwd, ["switch", name]);
  }
  if (action === "delete") {
    if (input.force !== true) {
      throw new Error("git_branch delete requires force=true");
    }
    return runGit(input.cwd, ["branch", "-D", name]);
  }
  throw new Error(`Unsupported git_branch action: ${action}`);
}

/**
 * @param {{ cwd: string; action: string; ref?: string; message?: string; includeUntracked?: boolean; paths?: string[] }} input
 */
export async function gitStashTool(input) {
  const action = String(input.action ?? "");
  if (action === "push") {
    const args = ["stash", "push"];
    if (input.includeUntracked) {
      args.push("--include-untracked");
    }
    const message = String(input.message ?? "").trim();
    if (message) {
      args.push("-m", message);
    }
    const paths = normalizePathspecs(input.cwd, input.paths ?? []);
    if (paths.length > 0) {
      args.push("--", ...paths);
    }
    return runGit(input.cwd, args);
  }
  const ref = normalizeStashRef(input.ref ?? "stash@{0}");
  if (action === "apply") {
    return runGit(input.cwd, ["stash", "apply", ref]);
  }
  if (action === "pop") {
    return runGit(input.cwd, ["stash", "pop", ref]);
  }
  if (action === "drop") {
    return runGit(input.cwd, ["stash", "drop", ref]);
  }
  if (action === "show") {
    return runGit(input.cwd, ["stash", "show", "--stat", ref]);
  }
  throw new Error(`Unsupported git_stash action: ${action}`);
}

/**
 * @param {{ cwd: string; action: string; name: string; target?: string; message?: string }} input
 */
export async function gitTagTool(input) {
  const name = normalizeRefName(input.name);
  const action = String(input.action ?? "");
  if (action === "create") {
    const target = input.target ? normalizeRevision(input.target) : "HEAD";
    const message = String(input.message ?? "").trim();
    return message
      ? runGit(input.cwd, ["tag", "-a", name, target, "-m", message])
      : runGit(input.cwd, ["tag", name, target]);
  }
  if (action === "delete") {
    return runGit(input.cwd, ["tag", "-d", name]);
  }
  throw new Error(`Unsupported git_tag action: ${action}`);
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
  return pathspecs.map((item) => normalizeWorkspacePathspec(workspace, item)).filter(Boolean);
}

function normalizeExplicitPaths(cwd, values) {
  const paths = normalizePathspecs(cwd, values);
  for (const item of paths) {
    if (item === "." || item === "./" || item === "*" || item === ":/") {
      throw new Error("git_add requires explicit file or directory paths; broad staging is not allowed");
    }
  }
  return paths;
}

function normalizeOptionalPathspec(cwd, value) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return null;
  }
  return normalizeWorkspacePathspec(path.resolve(cwd), value);
}

function normalizeWorkspacePathspec(workspace, value) {
  const text = String(value ?? "").trim();
  if (!text) {
    return null;
  }
  if (text.startsWith("-")) {
    throw new Error("git pathspecs must not start with '-'");
  }
  const resolved = path.resolve(workspace, text);
  if (!isInside(workspace, resolved)) {
    throw new Error("git pathspec resolves outside the workspace");
  }
  return text.replace(/\\/g, "/");
}

function normalizeRevision(value) {
  const text = String(value ?? "").trim();
  if (!text || text.startsWith("-") || /[\0\r\n]/.test(text)) {
    throw new Error("invalid git revision");
  }
  return text;
}

function normalizeRefName(value) {
  const text = String(value ?? "").trim();
  if (!text || text.startsWith("-") || /[\0\r\n\s~^:?*[\\]/.test(text) || text.includes("..")) {
    throw new Error("invalid git ref name");
  }
  return text;
}

function normalizeStashRef(value) {
  const text = String(value ?? "").trim();
  if (!/^stash@\{\d+\}$/.test(text)) {
    throw new Error("invalid git stash ref");
  }
  return text;
}

function normalizeCommitMessage(value) {
  const text = String(value ?? "").trim();
  if (!text || /[\0\r\n]/.test(text)) {
    throw new Error("git commit message must be a single non-empty line");
  }
  return text;
}

function safeOptionValue(value, name) {
  const text = String(value ?? "").trim();
  if (!text || text.startsWith("-") || /[\0\r\n]/.test(text)) {
    throw new Error(`invalid git ${name} filter`);
  }
  return text;
}

function safePattern(value) {
  const text = String(value ?? "").trim();
  if (!text || text.startsWith("-") || /[\0\r\n]/.test(text)) {
    throw new Error("invalid git tag pattern");
  }
  return text;
}

function clampInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function parseStatus(stdout) {
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  const branchLine = lines.find((line) => line.startsWith("## ")) ?? "";
  const files = lines
    .filter((line) => !line.startsWith("## "))
    .map((line) => ({
      index: line.slice(0, 1),
      worktree: line.slice(1, 2),
      path: line.slice(3),
      raw: line
    }));
  return {
    branch: branchLine.replace(/^##\s*/, "") || null,
    staged: files.filter((file) => file.index !== " " && file.index !== "?"),
    unstaged: files.filter((file) => file.worktree !== " " && file.index !== "?"),
    untracked: files.filter((file) => file.index === "?" && file.worktree === "?"),
    conflicts: files.filter((file) => "ADU".includes(file.index) && "ADU".includes(file.worktree)),
    files
  };
}

function parseLog(stdout) {
  return stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    const [hash, shortHash, authorName, authorEmail, date, subject] = line.split("\u001f");
    return { hash, shortHash, authorName, authorEmail, date, subject };
  });
}

function parseBranchList(stdout) {
  return stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    const [name, head, upstream, objectName, subject] = line.split("\t");
    return { name, current: head === "*", upstream: upstream || null, objectName, subject };
  });
}

function parseStashLine(line) {
  const match = line.match(/^(stash@\{\d+\}):\s*(.*)$/);
  return match ? { ref: match[1], subject: match[2] } : { ref: "", subject: line };
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {{ maxBytes?: number }} [options]
 */
function runGit(cwd, args, options = {}) {
  const startedAt = Date.now();
  const maxBytes = options.maxBytes ?? MAX_GIT_OUTPUT_BYTES;

  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd,
      windowsHide: true
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, DEFAULT_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      const appended = appendBounded(stdout, Buffer.from(chunk), maxBytes);
      stdout = appended.buffer;
      stdoutTruncated ||= appended.truncated;
    });
    child.stderr.on("data", (chunk) => {
      const appended = appendBounded(stderr, Buffer.from(chunk), maxBytes);
      stderr = appended.buffer;
      stderrTruncated ||= appended.truncated;
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
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        stdoutTruncated,
        stderrTruncated
      });
    });
  });
}

function appendBounded(current, chunk, maxBytes) {
  if (current.length >= maxBytes) {
    return { buffer: current, truncated: true };
  }
  const remaining = maxBytes - current.length;
  if (chunk.length <= remaining) {
    return { buffer: Buffer.concat([current, chunk]), truncated: false };
  }
  return { buffer: Buffer.concat([current, chunk.subarray(0, remaining)]), truncated: true };
}
