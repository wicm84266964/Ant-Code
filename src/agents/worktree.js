import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isInside } from "../permissions/policy-engine.js";

/**
 * @param {{ cwd: string; taskId: string }} options
 */
export function createTaskWorktree(options) {
  const cwd = path.resolve(options.cwd);
  const taskId = safeName(options.taskId);
  const root = path.join(cwd, ".lab-agent", "worktrees");
  const target = path.join(root, taskId);
  if (!isInside(cwd, target)) {
    return { ok: false, error: { code: "WORKTREE_PATH_OUTSIDE_WORKSPACE", message: target } };
  }
  if (!isGitRepository(cwd)) {
    return { ok: false, error: { code: "WORKTREE_REQUIRES_GIT", message: "Worktree isolation requires a git repository." } };
  }
  fs.mkdirSync(root, { recursive: true });
  const result = spawnSync("git", ["worktree", "add", "--detach", target, "HEAD"], {
    cwd,
    encoding: "utf8",
    windowsHide: true
  });
  if (result.status !== 0) {
    return {
      ok: false,
      error: {
        code: "WORKTREE_CREATE_FAILED",
        message: (result.stderr || result.stdout || "git worktree add failed").trim()
      }
    };
  }
  return { ok: true, path: target, relativePath: path.relative(cwd, target).replace(/\\/g, "/") };
}

/**
 * @param {{ cwd: string; taskId: string }} options
 */
export function removeTaskWorktree(options) {
  const cwd = path.resolve(options.cwd);
  const taskId = safeName(options.taskId);
  const target = path.join(cwd, ".lab-agent", "worktrees", taskId);
  if (!isInside(cwd, target)) {
    return { ok: false, error: { code: "WORKTREE_PATH_OUTSIDE_WORKSPACE", message: target } };
  }
  const result = spawnSync("git", ["worktree", "remove", "--force", target], {
    cwd,
    encoding: "utf8",
    windowsHide: true
  });
  if (result.status !== 0) {
    return {
      ok: false,
      error: {
        code: "WORKTREE_REMOVE_FAILED",
        message: (result.stderr || result.stdout || "git worktree remove failed").trim()
      }
    };
  }
  return { ok: true, path: target };
}

function isGitRepository(cwd) {
  const result = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd,
    encoding: "utf8",
    windowsHide: true
  });
  return result.status === 0 && result.stdout.trim() === "true";
}

function safeName(value) {
  const text = String(value ?? "").trim();
  if (!/^[A-Za-z0-9._-]+$/.test(text)) {
    throw new Error(`Invalid task/worktree id: ${text}`);
  }
  return text;
}
