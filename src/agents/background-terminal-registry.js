import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const running = new Map();
const terminal = new Map();
const DEFAULT_REGISTRY_DIR = ".lab-agent/background-terminal/tasks";
const ACTIVE_STATUSES = new Set(["starting", "running"]);

export function registerBackgroundTerminalTask(task) {
  const id = String(task?.taskId ?? "").trim();
  if (!id) {
    return () => {};
  }
  const now = new Date().toISOString();
  const entry = normalizeTask({
    taskId: id,
    parentSessionId: task.parentSessionId ? String(task.parentSessionId) : null,
    title: task.title ? String(task.title) : "Background terminal task",
    command: task.command ? String(task.command) : "",
    cwd: task.cwd ? String(task.cwd) : null,
    pid: Number.isFinite(task.pid) ? task.pid : null,
    launcherPid: Number.isFinite(task.launcherPid) ? task.launcherPid : null,
    stdoutPath: task.stdoutPath ? String(task.stdoutPath) : null,
    stderrPath: task.stderrPath ? String(task.stderrPath) : null,
    exitCode: null,
    signal: null,
    status: task.status ? String(task.status) : "running",
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    cancelledAt: null
  });
  if (ACTIVE_STATUSES.has(entry.status)) {
    running.set(id, entry);
  } else {
    running.delete(id);
  }
  terminal.set(id, entry);
  persistTask(entry);
  return () => {
    running.delete(id);
    const current = terminal.get(id);
    if (current && ACTIVE_STATUSES.has(current.status)) {
      current.status = "completed";
      current.updatedAt = new Date().toISOString();
      current.finishedAt = current.updatedAt;
      persistTask(current);
    }
  };
}

export function updateBackgroundTerminalTask(taskId, patch = {}) {
  const id = String(taskId ?? "").trim();
  const current = terminal.get(id) ?? loadTaskById(id);
  if (!current) {
    return null;
  }
  if (current.status === "cancelled" && patch.status && patch.status !== "cancelled") {
    const { status, ...rest } = patch;
    patch = rest;
  }
  Object.assign(current, patch, { updatedAt: new Date().toISOString() });
  if (!ACTIVE_STATUSES.has(current.status)) {
    running.delete(id);
    current.finishedAt = current.finishedAt ?? current.updatedAt;
  }
  terminal.set(id, current);
  persistTask(current);
  return { ...current };
}

export function listBackgroundTerminalTasks(options = {}) {
  refreshPersistedTasks(options.cwd);
  const parentSessionId = options.parentSessionId ? String(options.parentSessionId) : null;
  const taskId = options.taskId ? String(options.taskId) : null;
  return [...terminal.values()]
    .filter((task) => !parentSessionId || task.parentSessionId === parentSessionId)
    .filter((task) => !taskId || task.taskId === taskId)
    .map((task) => ({ ...task }));
}

export function cancelBackgroundTerminalTasks(options = {}) {
  refreshPersistedTasks(options.cwd);
  const parentSessionId = options.parentSessionId ? String(options.parentSessionId) : null;
  const taskId = options.taskId ? String(options.taskId) : null;
  const tasks = [...terminal.values()]
    .filter((task) => ACTIVE_STATUSES.has(task.status))
    .filter((task) => !parentSessionId || task.parentSessionId === parentSessionId)
    .filter((task) => !taskId || task.taskId === taskId);
  const now = new Date().toISOString();
  for (const task of tasks) {
    if (task.pid) {
      terminateProcessTree(task.pid);
    }
    if (task.launcherPid && task.launcherPid !== task.pid) {
      terminateProcessTree(task.launcherPid);
    }
    task.status = "cancelled";
    task.cancelledAt = now;
    task.finishedAt = now;
    task.updatedAt = now;
    running.delete(task.taskId);
    persistTask(task);
  }
  return tasks.map((task) => ({ ...task }));
}

function refreshPersistedTasks(cwd) {
  const refreshed = new Set();
  for (const task of readPersistedTasks(cwd)) {
    const current = terminal.get(task.taskId);
    const source = current && current.updatedAt >= task.updatedAt ? current : task;
    const next = reconcileTerminalTaskLiveness(source);
    refreshed.add(next.taskId);
    terminal.set(next.taskId, next);
    if (ACTIVE_STATUSES.has(next.status)) {
      running.set(next.taskId, next);
    } else {
      running.delete(next.taskId);
    }
    if (next !== task || (current && next !== current)) {
      persistTask(next);
    }
  }
  for (const task of [...terminal.values()]) {
    if (refreshed.has(task.taskId)) {
      continue;
    }
    const next = reconcileTerminalTaskLiveness(task);
    if (next === task) {
      continue;
    }
    terminal.set(next.taskId, next);
    if (ACTIVE_STATUSES.has(next.status)) {
      running.set(next.taskId, next);
    } else {
      running.delete(next.taskId);
    }
    persistTask(next);
  }
}

function reconcileTerminalTaskLiveness(task) {
  if (!task || !ACTIVE_STATUSES.has(task.status)) {
    return task;
  }
  if (task.status === "starting" && task.launcherPid && isProcessAlive(task.launcherPid)) {
    return task;
  }
  if (task.status === "starting" && !task.launcherPid) {
    return task;
  }
  if (task.status === "running" && isProcessAlive(task.pid)) {
    return task;
  }
  const now = new Date().toISOString();
  return {
    ...task,
    status: task.status === "starting" ? "failed" : "completed",
    error: task.status === "starting" ? "Background terminal launcher exited before a worker process id was recorded." : task.error,
    finishedAt: task.finishedAt ?? now,
    updatedAt: now
  };
}

function readPersistedTasks(cwd) {
  const roots = [
    ...new Set([
      cwd ? path.resolve(cwd) : null,
      process.cwd()
    ].filter(Boolean))
  ];
  const tasks = [];
  for (const root of roots) {
    const dir = path.join(root, DEFAULT_REGISTRY_DIR);
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, entry.name), "utf8"));
        tasks.push(normalizeTask(parsed));
      } catch {
        // Ignore corrupt task records.
      }
    }
  }
  return tasks;
}

function loadTaskById(taskId) {
  refreshPersistedTasks();
  return terminal.get(taskId) ?? null;
}

function persistTask(task) {
  if (!task.cwd || !task.taskId) {
    return;
  }
  try {
    const dir = path.join(task.cwd, DEFAULT_REGISTRY_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${safeFileName(task.taskId)}.json`);
    fs.writeFileSync(file, `${JSON.stringify(task, null, 2)}\n`, "utf8");
  } catch {
    // Persistence is best-effort; in-memory cancellation still works this run.
  }
}

function normalizeTask(task) {
  return {
    taskId: String(task?.taskId ?? "").trim(),
    parentSessionId: task?.parentSessionId ? String(task.parentSessionId) : null,
    title: task?.title ? String(task.title) : "Background terminal task",
    command: task?.command ? String(task.command) : "",
    cwd: task?.cwd ? String(task.cwd) : null,
    pid: Number.isFinite(task?.pid) ? task.pid : null,
    launcherPid: Number.isFinite(task?.launcherPid) ? task.launcherPid : null,
    stdoutPath: task?.stdoutPath ? String(task.stdoutPath) : null,
    stderrPath: task?.stderrPath ? String(task.stderrPath) : null,
    exitCode: Number.isFinite(task?.exitCode) ? task.exitCode : null,
    signal: task?.signal ? String(task.signal) : null,
    status: task?.status ? String(task.status) : "running",
    startedAt: task?.startedAt ? String(task.startedAt) : new Date().toISOString(),
    updatedAt: task?.updatedAt ? String(task.updatedAt) : new Date().toISOString(),
    finishedAt: task?.finishedAt ? String(task.finishedAt) : null,
    cancelledAt: task?.cancelledAt ? String(task.cancelledAt) : null
  };
}

function isProcessAlive(pid) {
  if (!pid) {
    return false;
  }
  try {
    if (process.platform === "win32") {
      const result = spawnSync("tasklist", ["/fi", `PID eq ${pid}`, "/fo", "csv", "/nh"], {
        windowsHide: true,
        encoding: "utf8"
      });
      return result.status === 0 && String(result.stdout ?? "").includes(String(pid));
    }
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function terminateProcessTree(pid) {
  if (!pid) {
    return;
  }
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
        windowsHide: true,
        stdio: "ignore"
      });
      killer.unref?.();
      return;
    } catch {
      // Fall through to process.kill fallback.
    }
  }
  try {
    if (process.platform === "win32") {
      process.kill(pid, "SIGTERM");
    } else {
      process.kill(-pid, "SIGTERM");
    }
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // The process may already have exited.
    }
  }
}

function safeFileName(value) {
  return String(value)
    .replace(/[^a-zA-Z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100) || "task";
}
