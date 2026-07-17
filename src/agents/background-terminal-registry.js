import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { atomicWriteFileSync } from "../storage/durable-file.js";

/** @typedef {Record<string, any>} TerminalTask */
/** @typedef {(pid: number) => Promise<any> | any} ProcessInspector */
/** @type {Map<string, TerminalTask>} */
const running = new Map();
/** @type {Map<string, TerminalTask>} */
const terminal = new Map();
const DEFAULT_REGISTRY_DIR = ".lab-agent/background-terminal/tasks";
const ACTIVE_STATUSES = new Set(["starting", "running", "cancelling"]);
const PROCESS_SNAPSHOT_TIMEOUT_MS = 1_000;
const PROCESS_SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;
const PROCESS_SNAPSHOT_CACHE_MS = 500;
const PROCESS_CANCEL_TIMEOUT_MS = 2_000;
const PROCESS_CANCEL_POLL_MS = 50;
const PROCESS_CANCEL_ESCALATE_MS = 750;
const REGISTRY_SCAN_CACHE_MS = 1_000;
const REGISTRY_SCAN_BATCH_FILES = 64;
const REGISTRY_SCAN_BUDGET_MS = 15;
const REGISTRY_SCAN_MAX_BYTES = 1024 * 1024;
const REGISTRY_RECORD_MAX_BYTES = 128 * 1024;
const REGISTRY_HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const REGISTRY_HISTORY_MAX_PER_ROOT = 200;
const REGISTRY_HISTORY_MAX_IN_MEMORY = 400;
const REGISTRY_ROOT_CACHE_MAX = 64;
const REGISTRY_CANCEL_SCAN_BATCHES = 8;
const REGISTRY_CANCEL_SCAN_BUDGET_MS = 100;
/** @typedef {{ known: boolean; pids: Set<number>; identities: Map<number, string> }} ProcessLivenessSnapshot */
/** @typedef {{ dir: string; records: Map<string, TerminalTask>; entries: string[] | null; cursor: number; seenNames: Set<string>; dirtyNames: Set<string>; lastScanAt: number; lastAccessAt: number }} PersistedRootState */
/** @type {ProcessLivenessSnapshot | null} */
let cachedProcessSnapshot = null;
let cachedProcessSnapshotAt = 0;
/** @type {Promise<void> | null} */
let processSnapshotInFlight = null;
let processSnapshotGeneration = 0;
/** @type {Map<string, Promise<any>>} */
const processIdentityCaptures = new Map();
/** @type {WeakMap<TerminalTask, Promise<TerminalTask>>} */
const terminalCancellations = new WeakMap();
/** @type {Map<string, PersistedRootState>} */
const persistedRootCache = new Map();

/** @param {TerminalTask} task */
export function registerBackgroundTerminalTask(task) {
  const id = String(task?.taskId ?? "").trim();
  if (!id) {
    return () => {};
  }
  const existing = terminal.get(id);
  if (existing && ACTIVE_STATUSES.has(existing.status)) {
    const error = new Error(`Background terminal task '${id}' is already active.`);
    Object.assign(error, { code: "BACKGROUND_TERMINAL_TASK_ID_CONFLICT" });
    throw error;
  }
  const now = new Date().toISOString();
  invalidateProcessLivenessSnapshot();
  const entry = normalizeTask({
    taskId: id,
    instanceId: task.instanceId,
    parentSessionId: task.parentSessionId ? String(task.parentSessionId) : null,
    title: task.title ? String(task.title) : "Background terminal task",
    command: task.command ? String(task.command) : "",
    cwd: task.cwd ? String(task.cwd) : null,
    pid: Number.isFinite(task.pid) ? task.pid : null,
    launcherPid: Number.isFinite(task.launcherPid) ? task.launcherPid : null,
    processIdentity: task.processIdentity,
    launcherIdentity: task.launcherIdentity,
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
  Object.defineProperty(entry, "runtimeOwned", {
    value: true,
    configurable: true,
    writable: true,
    enumerable: false
  });
  if (ACTIVE_STATUSES.has(entry.status)) {
    running.set(id, entry);
  } else {
    running.delete(id);
  }
  terminal.set(id, entry);
  persistTask(entry);
  scheduleTaskIdentityCapture(entry, "pid");
  scheduleTaskIdentityCapture(entry, "launcherPid");
  return () => {
    invalidateProcessLivenessSnapshot();
    const current = terminal.get(id);
    if (current !== entry) {
      return;
    }
    if (running.get(id) === entry) {
      running.delete(id);
    }
    if (ACTIVE_STATUSES.has(current.status)) {
      current.status = "completed";
      current.updatedAt = new Date().toISOString();
      current.finishedAt = current.updatedAt;
      persistTask(current);
    }
  };
}

/** @param {any} taskId @param {TerminalTask} [patch] */
export function updateBackgroundTerminalTask(taskId, patch = {}) {
  const id = String(taskId ?? "").trim();
  const current = terminal.get(id) ?? loadTaskById(id);
  if (!current) {
    return null;
  }
  const expectedInstanceId = normalizeInstanceId(patch.instanceId);
  if (expectedInstanceId && current.instanceId !== expectedInstanceId) {
    return null;
  }
  invalidateProcessLivenessSnapshot();
  if (current.status === "cancelled" && patch.status && patch.status !== "cancelled") {
    const { status, ...rest } = patch;
    patch = rest;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "pid")) {
    patch = { ...patch, pid: normalizeProcessId(patch.pid) };
  }
  if (Object.prototype.hasOwnProperty.call(patch, "launcherPid")) {
    patch = { ...patch, launcherPid: normalizeProcessId(patch.launcherPid) };
  }
  Object.assign(current, patch, { updatedAt: new Date().toISOString() });
  if (!ACTIVE_STATUSES.has(current.status)) {
    running.delete(id);
    current.finishedAt = current.finishedAt ?? current.updatedAt;
  }
  terminal.set(id, current);
  persistTask(current);
  scheduleTaskIdentityCapture(current, "pid");
  scheduleTaskIdentityCapture(current, "launcherPid");
  return { ...current };
}

/** @param {Record<string, any>} [options] */
export function listBackgroundTerminalTasks(options = {}) {
  refreshPersistedTasks(options.cwd);
  const parentSessionId = options.parentSessionId ? String(options.parentSessionId) : null;
  const taskId = options.taskId ? String(options.taskId) : null;
  return [...terminal.values()]
    .filter((task) => !parentSessionId || task.parentSessionId === parentSessionId)
    .filter((task) => !taskId || task.taskId === taskId)
    .map((task) => ({ ...task }));
}

/** @param {any} options */
export async function cancelBackgroundTerminalTasks(options = {}) {
  if (options.refresh !== false) {
    if (options.taskId) {
      hydratePersistedTaskById(options.cwd, options.taskId);
      refreshPersistedTasks(options.cwd, {
        skipLiveness: typeof options.inspectProcess === "function"
      });
    } else {
      await refreshPersistedTasksForCancellation(options.cwd, {
        skipLiveness: typeof options.inspectProcess === "function"
      });
    }
  }
  const parentSessionId = options.parentSessionId ? String(options.parentSessionId) : null;
  const taskId = options.taskId ? String(options.taskId) : null;
  const workspaceCwd = options.workspaceCwd ? path.resolve(options.workspaceCwd) : null;
  const tasks = [...terminal.values()]
    .filter((task) => ACTIVE_STATUSES.has(task.status))
    .filter((task) => !parentSessionId || task.parentSessionId === parentSessionId)
    .filter((task) => !taskId || task.taskId === taskId)
    .filter((task) => !workspaceCwd || (task.cwd && path.resolve(task.cwd) === workspaceCwd));
  invalidateProcessLivenessSnapshot();
  const inspectProcess = options.inspectProcess ?? inspectProcessIdentity;
  const terminateProcess = options.terminateProcess ?? terminateVerifiedProcessTree;
  const results = await Promise.all(tasks.map((task) => cancelTerminalTask(task, {
    inspectProcess,
    terminateProcess,
    timeoutMs: boundedCancelTimeout(options.timeoutMs),
    persist: options.persist !== false
  })));
  return results.map((task) => ({ ...task }));
}

/** @param {string | undefined} [cwd] @param {Record<string, any>} [options] */
function refreshPersistedTasks(cwd, options = {}) {
  const persistedTasks = readPersistedTasks(cwd);
  const liveness = options.skipLiveness
    ? null
    : createProcessLivenessSnapshot([...persistedTasks, ...terminal.values()]);
  const refreshed = new Set();
  for (const task of persistedTasks) {
    const current = terminal.get(task.taskId);
    const source = current && current.updatedAt >= task.updatedAt ? current : task;
    const next = options.skipLiveness ? source : reconcileTerminalTaskLiveness(source, liveness);
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
    const next = options.skipLiveness ? task : reconcileTerminalTaskLiveness(task, liveness);
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
  compactTerminalMemory();
}

/**
 * @param {any} task
 * @param {ProcessLivenessSnapshot | null} liveness
 */
function reconcileTerminalTaskLiveness(task, liveness) {
  if (!task || !ACTIVE_STATUSES.has(task.status)) {
    return task;
  }
  if (task.status === "cancelling") {
    return task;
  }
  if (task.status === "starting" && !task.launcherPid) {
    return task.runtimeOwned === true ? task : staleTerminalTask(task, "PROCESS_IDENTITY_UNKNOWN", "Persisted launcher record has no verifiable process identity.");
  }
  const field = task.status === "starting" ? "launcherPid" : "pid";
  const identityField = field === "pid" ? "processIdentity" : "launcherIdentity";
  const livenessStatus = processLivenessStatus(task[field], task[identityField], liveness);
  if (livenessStatus === "alive" || livenessStatus === "unknown") {
    return task;
  }
  if (livenessStatus === "mismatch") {
    return staleTerminalTask(task, "PROCESS_IDENTITY_MISMATCH", "Recorded process id now belongs to a different process instance.");
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

/** @param {TerminalTask} task @param {string} code @param {string} message */
function staleTerminalTask(task, code, message) {
  const now = new Date().toISOString();
  return {
    ...task,
    status: "stale",
    error: message,
    cancelError: code,
    cancellationConfirmed: false,
    finishedAt: task.finishedAt ?? now,
    updatedAt: now
  };
}

/** @param {string | undefined} [cwd] */
function readPersistedTasks(cwd) {
  /** @type {TerminalTask[]} */
  const tasks = [];
  for (const root of persistedTaskRoots(cwd)) {
    const dir = path.join(root, DEFAULT_REGISTRY_DIR);
    tasks.push(...readPersistedTaskRoot(dir));
  }
  trimPersistedRootCache();
  return tasks;
}

/** @param {string | undefined} [cwd] @returns {string[]} */
function persistedTaskRoots(cwd) {
  return [
    ...new Set([
      cwd ? path.resolve(cwd) : null,
      process.cwd()
    ].filter((value) => typeof value === "string"))
  ];
}

/** @param {string | undefined} cwd @param {any} taskId */
function hydratePersistedTaskById(cwd, taskId) {
  const id = String(taskId ?? "").trim();
  if (!id) return;
  for (const root of persistedTaskRoots(cwd)) {
    const file = path.join(root, DEFAULT_REGISTRY_DIR, `${safeFileName(id)}.json`);
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > REGISTRY_RECORD_MAX_BYTES) continue;
      const task = normalizeTask(JSON.parse(fs.readFileSync(file, "utf8")));
      if (task.taskId !== id) continue;
      const current = terminal.get(id);
      if (!current || current.updatedAt < task.updatedAt) {
        terminal.set(id, task);
        if (ACTIVE_STATUSES.has(task.status)) running.set(id, task);
      }
      rememberPersistedTask(file, task);
      return;
    } catch {
      // Try the next configured registry root.
    }
  }
}

/** @param {string | undefined} cwd @param {Record<string, any>} options */
async function refreshPersistedTasksForCancellation(cwd, options) {
  const deadline = Date.now() + REGISTRY_CANCEL_SCAN_BUDGET_MS;
  for (let attempt = 0; attempt < REGISTRY_CANCEL_SCAN_BATCHES; attempt += 1) {
    refreshPersistedTasks(cwd, options);
    const scanComplete = persistedTaskRoots(cwd).every((root) => {
      const state = persistedRootCache.get(path.join(root, DEFAULT_REGISTRY_DIR));
      return !state?.entries;
    });
    if (scanComplete || Date.now() >= deadline) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** @param {string} dir @returns {TerminalTask[]} */
function readPersistedTaskRoot(dir) {
  const now = Date.now();
  const state = persistedRootState(dir);
  state.lastAccessAt = now;
  if (!state.entries && now - state.lastScanAt < REGISTRY_SCAN_CACHE_MS) {
    return [...state.records.values()];
  }
  if (!state.entries) {
    try {
      state.entries = fs.readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => entry.name);
    } catch {
      state.records.clear();
      state.lastScanAt = now;
      return [];
    }
    state.cursor = 0;
    state.seenNames.clear();
    state.dirtyNames.clear();
  }

  const startedAt = Date.now();
  let scanned = 0;
  let scannedBytes = 0;
  while (state.cursor < state.entries.length && scanned < REGISTRY_SCAN_BATCH_FILES) {
    if (scanned > 0 && Date.now() - startedAt >= REGISTRY_SCAN_BUDGET_MS) {
      break;
    }
    const name = state.entries[state.cursor];
    const file = path.join(dir, name);
    state.cursor += 1;
    state.seenNames.add(name);
    scanned += 1;
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > REGISTRY_RECORD_MAX_BYTES) {
        state.records.delete(name);
        continue;
      }
      if (scannedBytes > 0 && scannedBytes + stat.size > REGISTRY_SCAN_MAX_BYTES) {
        state.cursor -= 1;
        state.seenNames.delete(name);
        break;
      }
      scannedBytes += stat.size;
      const task = normalizeTask(JSON.parse(fs.readFileSync(file, "utf8")));
      if (!task.taskId) {
        state.records.delete(name);
        continue;
      }
      if (terminalTaskHistoryExpired(task, now)) {
        state.records.delete(name);
        evictTerminalTaskIfMatch(task);
        prunePersistedTaskFile(file, task);
        continue;
      }
      state.records.set(name, task);
    } catch {
      state.records.delete(name);
      // Ignore corrupt or concurrently replaced task records.
    }
  }

  if (state.cursor >= state.entries.length) {
    for (const [name, task] of state.records) {
      if (!state.seenNames.has(name) && !state.dirtyNames.has(name)) {
        state.records.delete(name);
        evictTerminalTaskIfMatch(task);
      }
    }
    state.entries = null;
    state.cursor = 0;
    state.lastScanAt = Date.now();
    compactPersistedTaskRoot(state);
  }
  return [...state.records.values()];
}

/** @param {string} dir @returns {PersistedRootState} */
function persistedRootState(dir) {
  let state = persistedRootCache.get(dir);
  if (!state) {
    state = {
      dir,
      records: new Map(),
      entries: null,
      cursor: 0,
      seenNames: new Set(),
      dirtyNames: new Set(),
      lastScanAt: 0,
      lastAccessAt: Date.now()
    };
    persistedRootCache.set(dir, state);
  }
  return state;
}

/** @param {PersistedRootState} state */
function compactPersistedTaskRoot(state) {
  const history = [...state.records.entries()]
    .filter(([, task]) => !ACTIVE_STATUSES.has(task.status))
    .sort((left, right) => terminalTaskTimestamp(right[1]) - terminalTaskTimestamp(left[1]));
  for (const [name, task] of history.slice(REGISTRY_HISTORY_MAX_PER_ROOT)) {
    state.records.delete(name);
    evictTerminalTaskIfMatch(task);
    prunePersistedTaskFile(path.join(state.dir, name), task);
  }
}

function compactTerminalMemory() {
  const history = [...terminal.entries()]
    .filter(([, task]) => !ACTIVE_STATUSES.has(task.status))
    .sort((left, right) => terminalTaskTimestamp(right[1]) - terminalTaskTimestamp(left[1]));
  for (const [taskId, task] of history.slice(REGISTRY_HISTORY_MAX_IN_MEMORY)) {
    if (terminal.get(taskId) === task) {
      terminal.delete(taskId);
    }
  }
}

function trimPersistedRootCache() {
  if (persistedRootCache.size <= REGISTRY_ROOT_CACHE_MAX) return;
  const oldest = [...persistedRootCache.values()]
    .filter((state) => !state.entries)
    .sort((left, right) => left.lastAccessAt - right.lastAccessAt);
  for (const state of oldest.slice(0, persistedRootCache.size - REGISTRY_ROOT_CACHE_MAX)) {
    persistedRootCache.delete(state.dir);
  }
}

/** @param {TerminalTask} task @param {number} now */
function terminalTaskHistoryExpired(task, now) {
  return !ACTIVE_STATUSES.has(task.status)
    && now - terminalTaskTimestamp(task) > REGISTRY_HISTORY_RETENTION_MS;
}

/** @param {TerminalTask} task */
function terminalTaskTimestamp(task) {
  const timestamp = Date.parse(task.updatedAt ?? task.finishedAt ?? task.startedAt ?? "");
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}

/** @param {TerminalTask} task */
function evictTerminalTaskIfMatch(task) {
  const current = terminal.get(task.taskId);
  if (
    current
    && !ACTIVE_STATUSES.has(current.status)
    && current.cwd === task.cwd
    && current.updatedAt === task.updatedAt
    && current.instanceId === task.instanceId
  ) {
    terminal.delete(task.taskId);
    running.delete(task.taskId);
  }
}

/** @param {string} file @param {TerminalTask} expected */
function prunePersistedTaskFile(file, expected) {
  void fs.promises.readFile(file, "utf8")
    .then((raw) => normalizeTask(JSON.parse(raw)))
    .then((current) => {
      if (
        ACTIVE_STATUSES.has(current.status)
        || current.taskId !== expected.taskId
        || current.instanceId !== expected.instanceId
        || current.updatedAt !== expected.updatedAt
      ) {
        return;
      }
      return fs.promises.unlink(file);
    })
    .catch(() => {});
}

/** @param {string} taskId */
function loadTaskById(taskId) {
  refreshPersistedTasks();
  return terminal.get(taskId) ?? null;
}

/** @param {TerminalTask} task */
function persistTask(task) {
  if (!task.cwd || !task.taskId) {
    return;
  }
  try {
    const dir = path.join(task.cwd, DEFAULT_REGISTRY_DIR);
    const file = path.join(dir, `${safeFileName(task.taskId)}.json`);
    atomicWriteFileSync(file, `${JSON.stringify(task, null, 2)}\n`);
    rememberPersistedTask(file, task);
  } catch {
    // Persistence is best-effort; in-memory cancellation still works this run.
  }
}

/** @param {string} file @param {TerminalTask} task */
function rememberPersistedTask(file, task) {
  const dir = path.dirname(file);
  const state = persistedRootState(dir);
  const name = path.basename(file);
  state.records.set(name, normalizeTask(task));
  state.lastAccessAt = Date.now();
  if (state.entries) {
    state.dirtyNames.add(name);
  }
}

/** @param {any} task @returns {TerminalTask} */
function normalizeTask(task) {
  return {
    taskId: String(task?.taskId ?? "").trim(),
    instanceId: normalizeInstanceId(task?.instanceId),
    parentSessionId: task?.parentSessionId ? String(task.parentSessionId) : null,
    title: task?.title ? String(task.title) : "Background terminal task",
    command: task?.command ? String(task.command) : "",
    cwd: task?.cwd ? String(task.cwd) : null,
    pid: normalizeProcessId(task?.pid),
    launcherPid: normalizeProcessId(task?.launcherPid),
    processIdentity: normalizeProcessIdentity(task?.processIdentity),
    launcherIdentity: normalizeProcessIdentity(task?.launcherIdentity),
    identityCapturedAt: task?.identityCapturedAt ? String(task.identityCapturedAt) : null,
    stdoutPath: task?.stdoutPath ? String(task.stdoutPath) : null,
    stderrPath: task?.stderrPath ? String(task.stderrPath) : null,
    exitCode: Number.isFinite(task?.exitCode) ? task.exitCode : null,
    signal: task?.signal ? String(task.signal) : null,
    status: task?.status ? String(task.status) : "running",
    startedAt: task?.startedAt ? String(task.startedAt) : new Date().toISOString(),
    updatedAt: task?.updatedAt ? String(task.updatedAt) : new Date().toISOString(),
    finishedAt: task?.finishedAt ? String(task.finishedAt) : null,
    cancelledAt: task?.cancelledAt ? String(task.cancelledAt) : null,
    cancellationConfirmed: task?.cancellationConfirmed === true,
    cancelRequestedAt: task?.cancelRequestedAt ? String(task.cancelRequestedAt) : null,
    cancelFailedAt: task?.cancelFailedAt ? String(task.cancelFailedAt) : null,
    cancelError: task?.cancelError ? String(task.cancelError) : null
  };
}

/** @param {any} value @returns {number | null} */
function normalizeProcessId(value) {
  const pid = Number(value);
  return Number.isSafeInteger(pid) && pid > 1 ? pid : null;
}

/** @param {any} value @returns {string | null} */
function normalizeProcessIdentity(value) {
  const identity = String(value ?? "").trim();
  return identity ? identity.slice(0, 200) : null;
}

/** @param {any} value @returns {string | null} */
function normalizeInstanceId(value) {
  const instanceId = String(value ?? "").trim();
  return instanceId ? instanceId.slice(0, 200) : null;
}

/**
 * @param {number | null | undefined} pid
 * @param {string | null | undefined} expectedIdentity
 * @param {ProcessLivenessSnapshot | null} [liveness]
 */
function processLivenessStatus(pid, expectedIdentity, liveness = null) {
  const normalizedPid = normalizeProcessId(pid);
  if (!normalizedPid) {
    return "dead";
  }
  try {
    if (process.platform === "win32") {
      if (!processExists(normalizedPid)) {
        return "dead";
      }
      if (liveness?.known !== true) {
        return expectedIdentity ? "unknown" : "alive";
      }
      if (!liveness.pids.has(normalizedPid)) {
        return "dead";
      }
      const actualIdentity = liveness.identities.get(normalizedPid) ?? null;
      return expectedIdentity && actualIdentity
        ? actualIdentity === expectedIdentity ? "alive" : "mismatch"
        : expectedIdentity ? "unknown" : "alive";
    }
    process.kill(normalizedPid, 0);
    if (!expectedIdentity) {
      return "alive";
    }
    const actualIdentity = readPosixProcessIdentitySync(normalizedPid);
    return actualIdentity
      ? actualIdentity === expectedIdentity ? "alive" : "mismatch"
      : "unknown";
  } catch {
    return "dead";
  }
}

/**
 * @param {any[]} tasks
 * @returns {ProcessLivenessSnapshot | null}
 */
function createProcessLivenessSnapshot(tasks) {
  if (process.platform !== "win32") {
    return null;
  }
  const needsSnapshot = tasks.some((task) => (
    ACTIVE_STATUSES.has(task?.status) && (task.pid || task.launcherPid)
  ));
  if (!needsSnapshot) {
    return { known: true, pids: new Set(), identities: new Map() };
  }
  if (cachedProcessSnapshot && Date.now() - cachedProcessSnapshotAt <= PROCESS_SNAPSHOT_CACHE_MS) {
    return cachedProcessSnapshot;
  }
  scheduleProcessLivenessSnapshot();
  return { known: false, pids: new Set(), identities: new Map() };
}

function scheduleProcessLivenessSnapshot() {
  if (processSnapshotInFlight) {
    return;
  }
  const generation = processSnapshotGeneration;
  processSnapshotInFlight = collectWindowsProcessLivenessSnapshot()
    .then((snapshot) => {
      if (generation === processSnapshotGeneration) {
        cacheProcessLivenessSnapshot(snapshot);
      }
    })
    .finally(() => {
      processSnapshotInFlight = null;
    });
}

/**
 * @param {{spawnProcess?: typeof spawn, timeoutMs?: number}} [options]
 * @returns {Promise<ProcessLivenessSnapshot>}
 */
function collectWindowsProcessLivenessSnapshot(options = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let bytes = 0;
    /** @type {Buffer[]} */
    const chunks = [];
    /** @type {any} */
    let child;
    try {
      child = (options.spawnProcess ?? spawn)("powershell.exe", [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$ErrorActionPreference='SilentlyContinue'; Get-Process | ForEach-Object { try { '{0}|{1}' -f $_.Id,$_.StartTime.ToUniversalTime().Ticks } catch {} }"
      ], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"]
      });
    } catch {
      resolve({ known: false, pids: new Set(), identities: new Map() });
      return;
    }
    /** @type {ReturnType<typeof setTimeout> | null} */
    let timer = null;
    /** @param {ProcessLivenessSnapshot} snapshot @param {boolean} [terminate] */
    const finish = (snapshot, terminate = false) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      releaseProcessProbe(child, { onData, onError, onClose }, terminate);
      resolve(snapshot);
    };
    /** @param {any} chunk */
    const onData = (chunk) => {
      bytes += chunk.length;
      if (bytes > PROCESS_SNAPSHOT_MAX_BYTES) {
        finish({ known: false, pids: new Set(), identities: new Map() }, true);
        return;
      }
      chunks.push(Buffer.from(chunk));
    };
    const onError = () => finish({ known: false, pids: new Set(), identities: new Map() });
    /** @param {number | null} code */
    const onClose = (code) => {
      if (code !== 0 || bytes > PROCESS_SNAPSHOT_MAX_BYTES) {
        finish({ known: false, pids: new Set(), identities: new Map() });
        return;
      }
      const pids = new Set();
      const identities = new Map();
      for (const line of Buffer.concat(chunks).toString("utf8").split(/\r?\n/)) {
        const match = line.trim().match(/^(\d+)\|(\d+)$/);
        if (match) {
          const pid = Number(match[1]);
          if (normalizeProcessId(pid)) {
            pids.add(pid);
            identities.set(pid, `win:${match[2]}`);
          }
        }
      }
      finish({ known: true, pids, identities });
    };
    timer = setTimeout(() => {
      finish({ known: false, pids: new Set(), identities: new Map() }, true);
    }, probeTimeoutMs(options.timeoutMs));
    timer.unref?.();
    child.stdout?.on("data", onData);
    child.once("error", onError);
    child.once("close", onClose);
  });
}

/** @param {ProcessLivenessSnapshot} snapshot */
function cacheProcessLivenessSnapshot(snapshot) {
  cachedProcessSnapshot = snapshot;
  cachedProcessSnapshotAt = Date.now();
  return snapshot;
}

function invalidateProcessLivenessSnapshot() {
  processSnapshotGeneration += 1;
  cachedProcessSnapshot = null;
  cachedProcessSnapshotAt = 0;
}

/** @param {TerminalTask} task @param {string} pidField */
function scheduleTaskIdentityCapture(task, pidField) {
  const identityField = pidField === "pid" ? "processIdentity" : "launcherIdentity";
  const pid = normalizeProcessId(task?.[pidField]);
  if (task?.runtimeOwned !== true || !pid || task[identityField]) {
    return null;
  }
  const key = `${task.taskId}:${task.instanceId ?? "legacy"}:${pidField}:${pid}`;
  if (processIdentityCaptures.has(key)) {
    return processIdentityCaptures.get(key);
  }
  const capture = inspectProcessIdentity(pid)
    .then((observed) => {
      const current = terminal.get(task.taskId);
      if (
        observed.alive === true
        && observed.identity
        && current === task
        && current[pidField] === pid
        && !current[identityField]
      ) {
        current[identityField] = observed.identity;
        current.identityCapturedAt = new Date().toISOString();
        current.updatedAt = current.identityCapturedAt;
        persistTask(current);
      }
    })
    .catch(() => {})
    .finally(() => {
      if (processIdentityCaptures.get(key) === capture) {
        processIdentityCaptures.delete(key);
      }
    });
  processIdentityCaptures.set(key, capture);
  return capture;
}

/** @param {TerminalTask} task @param {string} pidField @param {ProcessInspector} inspectProcess */
async function ensureTaskIdentity(task, pidField, inspectProcess) {
  const identityField = pidField === "pid" ? "processIdentity" : "launcherIdentity";
  if (task[identityField]) {
    return task[identityField];
  }
  const pid = normalizeProcessId(task[pidField]);
  if (!pid || task.runtimeOwned !== true) {
    return null;
  }
  const key = `${task.taskId}:${task.instanceId ?? "legacy"}:${pidField}:${pid}`;
  await processIdentityCaptures.get(key);
  if (task[identityField]) {
    return task[identityField];
  }
  const observed = await inspectProcessSafely(inspectProcess, pid);
  if (observed.alive && observed.identity && terminal.get(task.taskId) === task && task[pidField] === pid) {
    task[identityField] = observed.identity;
    task.identityCapturedAt = new Date().toISOString();
    persistTask(task);
    return observed.identity;
  }
  return null;
}

/** @param {TerminalTask} task @param {Record<string, any>} options */
function cancelTerminalTask(task, options) {
  const existing = terminalCancellations.get(task);
  if (existing) {
    return existing;
  }
  const cancellation = performTerminalTaskCancellation(task, options)
    .finally(() => {
      if (terminalCancellations.get(task) === cancellation) {
        terminalCancellations.delete(task);
      }
    });
  terminalCancellations.set(task, cancellation);
  return cancellation;
}

/** @param {TerminalTask} task @param {Record<string, any>} options */
async function performTerminalTaskCancellation(task, options) {
  const previousStatus = task.status === "starting" ? "starting" : "running";
  const requestedAt = new Date().toISOString();
  task.status = "cancelling";
  task.cancelRequestedAt = requestedAt;
  task.cancellationConfirmed = false;
  task.cancelError = null;
  task.cancelFailedAt = null;
  task.updatedAt = requestedAt;
  running.set(task.taskId, task);
  if (options.persist) persistTask(task);

  /** @type {Array<{pid: number, identity: string, pidField: string}>} */
  const targets = [];
  for (const pidField of ["pid", "launcherPid"]) {
    const pid = normalizeProcessId(task[pidField]);
    if (!pid || targets.some((target) => target.pid === pid)) {
      continue;
    }
    const identity = await ensureTaskIdentity(task, pidField, options.inspectProcess);
    const observed = await inspectProcessSafely(options.inspectProcess, pid);
    if (!observed.alive) {
      continue;
    }
    if (!identity) {
      return markTerminalTaskStale(task, "PROCESS_IDENTITY_UNKNOWN", "Refusing to terminate a process without a recorded creation identity.", options.persist);
    }
    if (!observed.identity) {
      return markTerminalTaskStale(task, "PROCESS_IDENTITY_UNAVAILABLE", "Refusing to terminate a process whose creation identity cannot be verified.", options.persist);
    }
    if (observed.identity !== identity) {
      return markTerminalTaskStale(task, "PROCESS_IDENTITY_MISMATCH", "Recorded process id now belongs to a different process instance.", options.persist);
    }
    targets.push({ pid, identity, pidField });
  }

  if (targets.length === 0) {
    return markTerminalTaskCancelled(task, options.persist);
  }

  const outcomes = await Promise.all(targets.map((target) => options.terminateProcess({
    ...target,
    task,
    inspectProcess: options.inspectProcess,
    timeoutMs: options.timeoutMs
  })));
  const failure = outcomes.find((outcome) => outcome?.exited !== true);
  if (!failure) {
    return markTerminalTaskCancelled(task, options.persist);
  }

  const failedAt = new Date().toISOString();
  task.status = previousStatus;
  task.cancellationConfirmed = false;
  task.cancelFailedAt = failedAt;
  task.cancelError = String(failure?.error ?? "Process exit was not confirmed before the cancellation deadline.");
  task.updatedAt = failedAt;
  running.set(task.taskId, task);
  if (options.persist) persistTask(task);
  return task;
}

/** @param {TerminalTask} task @param {boolean} persist */
function markTerminalTaskCancelled(task, persist) {
  const now = new Date().toISOString();
  task.status = "cancelled";
  task.cancellationConfirmed = true;
  task.cancelledAt = now;
  task.finishedAt = now;
  task.updatedAt = now;
  task.cancelError = null;
  task.cancelFailedAt = null;
  running.delete(task.taskId);
  if (persist) persistTask(task);
  return task;
}

/** @param {TerminalTask} task @param {string} code @param {string} message @param {boolean} persist */
function markTerminalTaskStale(task, code, message, persist) {
  const next = staleTerminalTask(task, code, message);
  Object.assign(task, next);
  running.delete(task.taskId);
  terminal.set(task.taskId, task);
  if (persist) persistTask(task);
  return task;
}

/** @param {Record<string, any>} options */
async function terminateVerifiedProcessTree(options) {
  const pid = normalizeProcessId(options.pid);
  if (!pid || !options.identity) {
    return { exited: false, error: "Process identity is invalid." };
  }
  const before = await inspectProcessSafely(options.inspectProcess, pid);
  if (!before.alive || (before.identity && before.identity !== options.identity)) {
    return { exited: true };
  }
  if (!before.identity) {
    return { exited: false, error: "Process identity could not be verified before termination." };
  }

  sendProcessTreeSignal(pid, false);
  const startedAt = Date.now();
  let escalated = process.platform === "win32";
  while (Date.now() - startedAt < options.timeoutMs) {
    await delay(Math.min(PROCESS_CANCEL_POLL_MS, Math.max(1, options.timeoutMs - (Date.now() - startedAt))));
    const observed = await inspectProcessSafely(options.inspectProcess, pid);
    if (!observed.alive || (observed.identity && observed.identity !== options.identity)) {
      return { exited: true };
    }
    if (!escalated && Date.now() - startedAt >= Math.min(PROCESS_CANCEL_ESCALATE_MS, options.timeoutMs)) {
      sendProcessTreeSignal(pid, true);
      escalated = true;
    }
  }
  return { exited: false, error: "Process exit was not confirmed before the cancellation deadline." };
}

/** @param {any} pid @param {boolean} force */
function sendProcessTreeSignal(pid, force) {
  if (!normalizeProcessId(pid)) {
    return false;
  }
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
        windowsHide: true,
        stdio: "ignore"
      });
      killer.once("error", () => {});
      killer.unref?.();
      return true;
    } catch {
      return false;
    }
  }
  const signal = force ? "SIGKILL" : "SIGTERM";
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

/** @param {any} pid */
async function inspectProcessIdentity(pid) {
  const normalizedPid = normalizeProcessId(pid);
  if (!normalizedPid) {
    return { alive: false, identity: null };
  }
  if (process.platform === "win32") {
    const result = await collectProcessOutput("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$process = Get-Process -Id ${normalizedPid} -ErrorAction SilentlyContinue; if ($process) { $process.StartTime.ToUniversalTime().Ticks }`
    ]);
    const ticks = result.stdout.trim();
    return /^\d+$/.test(ticks)
      ? { alive: true, identity: `win:${ticks}` }
      : { alive: processExists(normalizedPid), identity: null };
  }
  if (process.platform === "linux") {
    try {
      const stat = await fs.promises.readFile(`/proc/${normalizedPid}/stat`, "utf8");
      const identity = linuxProcessIdentity(stat);
      return identity ? { alive: true, identity } : { alive: processExists(normalizedPid), identity: null };
    } catch {
      return { alive: processExists(normalizedPid), identity: null };
    }
  }
  const result = await collectProcessOutput("ps", ["-o", "lstart=", "-p", String(normalizedPid)]);
  const started = result.stdout.trim().replace(/\s+/g, " ");
  return started
    ? { alive: true, identity: `ps:${started}` }
    : { alive: processExists(normalizedPid), identity: null };
}

/** @param {ProcessInspector} inspectProcess @param {any} pid */
async function inspectProcessSafely(inspectProcess, pid) {
  try {
    const observed = await inspectProcess(pid);
    return {
      alive: observed?.alive === true,
      identity: normalizeProcessIdentity(observed?.identity)
    };
  } catch {
    return { alive: processExists(pid), identity: null };
  }
}

/** @param {any} pid */
function readPosixProcessIdentitySync(pid) {
  if (process.platform !== "linux" || !normalizeProcessId(pid)) {
    return null;
  }
  try {
    return linuxProcessIdentity(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return null;
  }
}

/** @param {any} stat */
function linuxProcessIdentity(stat) {
  const close = String(stat ?? "").lastIndexOf(")");
  if (close < 0) {
    return null;
  }
  const fields = String(stat).slice(close + 2).trim().split(/\s+/);
  const startTicks = fields[19];
  return /^\d+$/.test(startTicks ?? "") ? `linux:${startTicks}` : null;
}

/** @param {any} pid */
function processExists(pid) {
  const normalizedPid = normalizeProcessId(pid);
  if (!normalizedPid) return false;
  try {
    process.kill(normalizedPid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM");
  }
}

/**
 * @param {string} executable
 * @param {string[]} args
 * @param {{spawnProcess?: typeof spawn, timeoutMs?: number}} [options]
 * @returns {Promise<{ok: boolean, stdout: string}>}
 */
function collectProcessOutput(executable, args, options = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let bytes = 0;
    /** @type {Buffer[]} */
    const chunks = [];
    /** @type {any} */
    let child;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let timer = null;
    /** @param {{ok: boolean, stdout: string}} result */
    const finish = (result, terminate = false) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      releaseProcessProbe(child, { onData, onError, onClose }, terminate);
      resolve(result);
    };
    /** @param {any} chunk */
    const onData = (chunk) => {
      bytes += chunk.length;
      if (bytes > 8 * 1024) {
        finish({ ok: false, stdout: "" }, true);
        return;
      }
      chunks.push(Buffer.from(chunk));
    };
    const onError = () => finish({ ok: false, stdout: "" });
    /** @param {number | null} code */
    const onClose = (code) => finish({
      ok: code === 0,
      stdout: code === 0 ? Buffer.concat(chunks).toString("utf8") : ""
    });
    try {
      child = (options.spawnProcess ?? spawn)(executable, args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"]
      });
    } catch {
      return resolve({ ok: false, stdout: "" });
    }
    timer = setTimeout(() => finish({ ok: false, stdout: "" }, true), probeTimeoutMs(options.timeoutMs));
    timer.unref?.();
    child.stdout?.on("data", onData);
    child.once("error", onError);
    child.once("close", onClose);
  });
}

/**
 * @param {any} child
 * @param {{onData: (...args: any[]) => void, onError: (...args: any[]) => void, onClose: (...args: any[]) => void}} handlers
 * @param {boolean} terminate
 */
function releaseProcessProbe(child, handlers, terminate) {
  child?.stdout?.removeListener?.("data", handlers.onData);
  child?.removeListener?.("error", handlers.onError);
  child?.removeListener?.("close", handlers.onClose);
  child?.stdout?.destroy?.();
  if (terminate) {
    child?.once?.("error", () => {});
    try {
      child?.kill?.();
    } catch {
      // The probe may already have exited.
    }
  }
  child?.unref?.();
}

/** @param {any} value */
function probeTimeoutMs(value) {
  const timeout = Number(value);
  return Number.isFinite(timeout) ? Math.max(1, Math.min(10_000, Math.trunc(timeout))) : PROCESS_SNAPSHOT_TIMEOUT_MS;
}

export const __backgroundTerminalRegistryTestHooks = Object.freeze({
  collectWindowsProcessLivenessSnapshot,
  collectProcessOutput
});

/** @param {any} value */
function boundedCancelTimeout(value) {
  const timeout = Number(value);
  return Number.isFinite(timeout) ? Math.max(25, Math.min(10_000, Math.trunc(timeout))) : PROCESS_CANCEL_TIMEOUT_MS;
}

/** @param {number} ms */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @param {any} value */
function safeFileName(value) {
  return String(value)
    .replace(/[^a-zA-Z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100) || "task";
}
