import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { atomicWriteFileSync } from "../storage/durable-file.ts";

export type TerminalTask = {
  taskId: string;
  instanceId: string | null;
  parentSessionId: string | null;
  title: string;
  command: string;
  cwd: string | null;
  pid: number | null;
  launcherPid: number | null;
  processIdentity: string | null;
  launcherIdentity: string | null;
  identityCapturedAt?: string | null;
  stdoutPath: string | null;
  stderrPath: string | null;
  exitCode: number | null;
  signal: string | null;
  status: string;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  cancelledAt: string | null;
  cancellationConfirmed?: boolean;
  cancelRequestedAt?: string | null;
  cancelFailedAt?: string | null;
  cancelError?: string | null;
  runtimeOwned?: boolean;
  error?: unknown;
};

type TerminalTaskInput = Partial<TerminalTask> & {
  taskId?: string;
};

type RuntimeProcess = {
  instanceId: string | null;
  pid: number;
  child: ChildProcess;
};

type ProcessObservation = {
  alive?: boolean;
  identity?: string | null;
};

type ProcessInspector = (pid: number) => Promise<ProcessObservation | unknown> | ProcessObservation | unknown;

type CancelTaskOptions = {
  cwd?: string;
  parentSessionId?: unknown;
  taskId?: unknown;
  workspaceCwd?: unknown;
  refresh?: boolean;
  inspectProcess?: ProcessInspector;
  terminateProcess?: (options: TerminateProcessOptions) => Promise<TerminateProcessResult> | TerminateProcessResult;
  timeoutMs?: unknown;
  persist?: boolean;
  skipLiveness?: boolean;
};

type TerminateProcessOptions = {
  pid: number;
  identity: string;
  pidField?: string;
  runtimeProcess?: RuntimeProcess;
  task?: TerminalTask;
  inspectProcess: ProcessInspector;
  timeoutMs: number;
};

type TerminateProcessResult = {
  exited: boolean;
  error?: string;
};

type ProcessProbeHandlers = {
  onData: (chunk: Buffer | string) => void;
  onError: (error?: Error) => void;
  onClose: (code: number | null, signal?: NodeJS.Signals | null) => void;
};

const EMPTY_TASK_PATCH: TerminalTaskInput = {};
const EMPTY_LIST_OPTIONS: { cwd?: string; parentSessionId?: unknown; taskId?: unknown } = {};
const EMPTY_REFRESH_OPTIONS: { skipLiveness?: boolean } = {};
const EMPTY_SNAPSHOT_OPTIONS: { spawnProcess?: typeof spawn; timeoutMs?: number } = {};

const running = new Map<string, TerminalTask>();
const terminal = new Map<string, TerminalTask>();
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
type ProcessLivenessSnapshot = {
  known: boolean;
  pids: Set<number>;
  identities: Map<number, string>;
};

type PersistedRootState = {
  dir: string;
  records: Map<string, TerminalTask>;
  entries: string[] | null;
  cursor: number;
  seenNames: Set<string>;
  dirtyNames: Set<string>;
  lastScanAt: number;
  lastAccessAt: number;
};

let cachedProcessSnapshot: ProcessLivenessSnapshot | null = null;
let cachedProcessSnapshotAt = 0;
let processSnapshotInFlight: Promise<void> | null = null;
let processSnapshotGeneration = 0;
const processIdentityCaptures = new Map<string, Promise<unknown>>();
const runtimeProcesses = new Map<string, RuntimeProcess>();
const terminalCancellations = new WeakMap<TerminalTask, Promise<TerminalTask>>();
const persistedRootCache = new Map<string, PersistedRootState>();

/** @param {TerminalTask} task */
export function registerBackgroundTerminalTask(task: TerminalTaskInput) {
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
  runtimeProcesses.delete(id);
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

/**
 * Keep the exact process handle for tasks launched by this runtime. Persisted
 * tasks still use creation-identity verification after a process restart.
 *
 * @param {any} taskId
 * @param {any} instanceId
 * @param {import("node:child_process").ChildProcess} child
 */
export function registerBackgroundTerminalProcess(taskId: unknown, instanceId: unknown, child: ChildProcess) {
  const id = String(taskId ?? "").trim();
  const normalizedInstanceId = normalizeInstanceId(instanceId);
  const pid = normalizeProcessId(child?.pid);
  const current = terminal.get(id);
  if (!id || !pid || !current || current.instanceId !== normalizedInstanceId) {
    return false;
  }
  const record = { instanceId: normalizedInstanceId, pid, child };
  runtimeProcesses.set(id, record);
  const release = () => {
    if (runtimeProcesses.get(id) === record) {
      runtimeProcesses.delete(id);
    }
  };
  child.once("close", release);
  child.once("error", release);
  return true;
}

/** @param {any} taskId @param {TerminalTask} [patch] */
export function updateBackgroundTerminalTask(taskId: unknown, patch: TerminalTaskInput = EMPTY_TASK_PATCH) {
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
export function listBackgroundTerminalTasks(options: { cwd?: string; parentSessionId?: unknown; taskId?: unknown } = EMPTY_LIST_OPTIONS) {
  refreshPersistedTasks(options.cwd);
  const parentSessionId = options.parentSessionId ? String(options.parentSessionId) : null;
  const taskId = options.taskId ? String(options.taskId) : null;
  return [...terminal.values()]
    .filter((task) => !parentSessionId || task.parentSessionId === parentSessionId)
    .filter((task) => !taskId || task.taskId === taskId)
    .map((task) => ({ ...task }));
}

/** @param {any} options */
export async function cancelBackgroundTerminalTasks(options: CancelTaskOptions = EMPTY_LIST_OPTIONS) {
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
  const workspaceCwd = typeof options.workspaceCwd === "string" && options.workspaceCwd
    ? path.resolve(options.workspaceCwd)
    : null;
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
function refreshPersistedTasks(cwd?: string, options: { skipLiveness?: boolean } = EMPTY_REFRESH_OPTIONS) {
  const persistedTasks = readPersistedTasks(cwd);
  const liveness = options.skipLiveness
    ? null
    : createProcessLivenessSnapshot([...persistedTasks, ...terminal.values()]);
  const refreshed = new Set<string>();
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
function reconcileTerminalTaskLiveness(task: TerminalTask, liveness: ProcessLivenessSnapshot | null): TerminalTask {
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
  const runtimeProcess = runtimeProcessForTask(task, field);
  const livenessStatus = runtimeProcess
    ? runtimeProcessAlive(runtimeProcess) ? "alive" : "dead"
    : processLivenessStatus(
      field === "pid" ? task.pid : task.launcherPid,
      identityField === "processIdentity" ? task.processIdentity : task.launcherIdentity,
      liveness
    );
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
function staleTerminalTask(task: TerminalTask, code: string, message: string) {
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
function readPersistedTasks(cwd: string | undefined) {
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
function persistedTaskRoots(cwd: string | undefined) {
  return [
    ...new Set([
      cwd ? path.resolve(cwd) : null,
      process.cwd()
    ].filter((value) => typeof value === "string"))
  ];
}

/** @param {string | undefined} cwd @param {any} taskId */
function hydratePersistedTaskById(cwd: string | undefined, taskId: unknown) {
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
async function refreshPersistedTasksForCancellation(cwd: string | undefined, options: { skipLiveness?: boolean }) {
  const deadline = Date.now() + REGISTRY_CANCEL_SCAN_BUDGET_MS;
  for (let attempt = 0; attempt < REGISTRY_CANCEL_SCAN_BATCHES; attempt += 1) {
    refreshPersistedTasks(cwd, options);
    const scanComplete = persistedTaskRoots(cwd).every((root: string) => {
      const state = persistedRootCache.get(path.join(root, DEFAULT_REGISTRY_DIR));
      return !state?.entries;
    });
    if (scanComplete || Date.now() >= deadline) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** @param {string} dir @returns {TerminalTask[]} */
function readPersistedTaskRoot(dir: string) {
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
function persistedRootState(dir: string) {
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
function compactPersistedTaskRoot(state: PersistedRootState) {
  const history = [...state.records.entries()]
    .filter(([, task]) => !ACTIVE_STATUSES.has(task.status))
    .sort((left: [string, TerminalTask], right: [string, TerminalTask]) => terminalTaskTimestamp(right[1]) - terminalTaskTimestamp(left[1]));
  for (const [name, task] of history.slice(REGISTRY_HISTORY_MAX_PER_ROOT)) {
    state.records.delete(name);
    evictTerminalTaskIfMatch(task);
    prunePersistedTaskFile(path.join(state.dir, name), task);
  }
}

function compactTerminalMemory() {
  const history = [...terminal.entries()]
    .filter(([, task]) => !ACTIVE_STATUSES.has(task.status))
    .sort((left: [string, TerminalTask], right: [string, TerminalTask]) => terminalTaskTimestamp(right[1]) - terminalTaskTimestamp(left[1]));
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
    .sort((left: PersistedRootState, right: PersistedRootState) => left.lastAccessAt - right.lastAccessAt);
  for (const state of oldest.slice(0, persistedRootCache.size - REGISTRY_ROOT_CACHE_MAX)) {
    persistedRootCache.delete(state.dir);
  }
}

/** @param {TerminalTask} task @param {number} now */
function terminalTaskHistoryExpired(task: TerminalTask, now: number) {
  return !ACTIVE_STATUSES.has(task.status)
    && now - terminalTaskTimestamp(task) > REGISTRY_HISTORY_RETENTION_MS;
}

/** @param {TerminalTask} task */
function terminalTaskTimestamp(task: TerminalTask) {
  const timestamp = Date.parse(task.updatedAt ?? task.finishedAt ?? task.startedAt ?? "");
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}

/** @param {TerminalTask} task */
function evictTerminalTaskIfMatch(task: TerminalTask) {
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
function prunePersistedTaskFile(file: string, expected: TerminalTask) {
  void fs.promises.readFile(file, "utf8")
    .then((raw) => normalizeTask(JSON.parse(raw) as Record<string, unknown>))
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
function loadTaskById(taskId: string) {
  refreshPersistedTasks(undefined);
  return terminal.get(taskId) ?? null;
}

/** @param {TerminalTask} task */
function persistTask(task: TerminalTask) {
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
function rememberPersistedTask(file: string, task: TerminalTask) {
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
function normalizeTask(task: Record<string, unknown> | TerminalTaskInput): TerminalTask {
  const exitCode = task?.exitCode;
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
    exitCode: typeof exitCode === "number" && Number.isFinite(exitCode) ? exitCode : null,
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
function normalizeProcessId(value: unknown) {
  const pid = Number(value);
  return Number.isSafeInteger(pid) && pid > 1 ? pid : null;
}

/** @param {any} value @returns {string | null} */
function normalizeProcessIdentity(value: unknown) {
  const identity = String(value ?? "").trim();
  return identity ? identity.slice(0, 200) : null;
}

/** @param {any} value @returns {string | null} */
function normalizeInstanceId(value: unknown) {
  const instanceId = String(value ?? "").trim();
  return instanceId ? instanceId.slice(0, 200) : null;
}

/**
 * @param {number | null | undefined} pid
 * @param {string | null | undefined} expectedIdentity
 * @param {ProcessLivenessSnapshot | null} [liveness]
 */
function processLivenessStatus(pid: number | null | undefined, expectedIdentity: string | null | undefined, liveness: ProcessLivenessSnapshot | null = null) {
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
function createProcessLivenessSnapshot(tasks: TerminalTask[]): ProcessLivenessSnapshot | null {
  if (process.platform !== "win32") {
    return null;
  }
  const needsSnapshot = tasks.some((task) => (
    ACTIVE_STATUSES.has(task.status)
    && (task.pid || task.launcherPid)
    && !runtimeProcessForTask(task, task.status === "starting" ? "launcherPid" : "pid")
  ));
  if (!needsSnapshot) {
    return { known: true, pids: new Set<number>(), identities: new Map<number, string>() };
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
function collectWindowsProcessLivenessSnapshot(options: {spawnProcess?: typeof spawn, timeoutMs?: number} = EMPTY_SNAPSHOT_OPTIONS) {
  return new Promise<ProcessLivenessSnapshot>((resolve) => {
    let settled = false;
    let bytes = 0;
    const chunks: Buffer[] = [];
    let child: ChildProcess | undefined;
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
      resolve({ known: false, pids: new Set<number>(), identities: new Map<number, string>() });
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (snapshot: ProcessLivenessSnapshot, terminate: boolean = false) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      releaseProcessProbe(child, { onData, onError, onClose }, terminate);
      resolve(snapshot);
    };
    const onData = (chunk: Buffer | string) => {
      bytes += chunk.length;
      if (bytes > PROCESS_SNAPSHOT_MAX_BYTES) {
        finish({ known: false, pids: new Set<number>(), identities: new Map<number, string>() }, true);
        return;
      }
      chunks.push(Buffer.from(chunk));
    };
    const onError = () => finish({ known: false, pids: new Set<number>(), identities: new Map<number, string>() });
    const onClose = (code: number | null) => {
      if (code !== 0 || bytes > PROCESS_SNAPSHOT_MAX_BYTES) {
        finish({ known: false, pids: new Set<number>(), identities: new Map<number, string>() });
        return;
      }
      const pids = new Set<number>();
      const identities = new Map<number, string>();
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
      finish({ known: false, pids: new Set<number>(), identities: new Map<number, string>() }, true);
    }, probeTimeoutMs(options.timeoutMs));
    timer.unref?.();
    child.stdout?.on("data", onData);
    child.once("error", onError);
    child.once("close", onClose);
  });
}

/** @param {ProcessLivenessSnapshot} snapshot */
function cacheProcessLivenessSnapshot(snapshot: ProcessLivenessSnapshot) {
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
function scheduleTaskIdentityCapture(task: TerminalTask, pidField: "pid" | "launcherPid") {
  const identityField = pidField === "pid" ? "processIdentity" : "launcherIdentity";
  const pid = normalizeProcessId(pidField === "pid" ? task.pid : task.launcherPid);
  const existingIdentity = pidField === "pid" ? task.processIdentity : task.launcherIdentity;
  if (task.runtimeOwned !== true || !pid || existingIdentity) {
    return null;
  }
  const key = `${task.taskId}:${task.instanceId ?? "legacy"}:${pidField}:${pid}`;
  if (processIdentityCaptures.has(key)) {
    return processIdentityCaptures.get(key);
  }
  const capture = inspectProcessIdentity(pid)
    .then((observed) => {
      const current = terminal.get(task.taskId);
      const currentPid = current && (pidField === "pid" ? current.pid : current.launcherPid);
      const currentIdentity = current && (pidField === "pid" ? current.processIdentity : current.launcherIdentity);
      if (
        observed.alive === true
        && observed.identity
        && current === task
        && currentPid === pid
        && !currentIdentity
      ) {
        if (pidField === "pid") {
          current.processIdentity = observed.identity;
        } else {
          current.launcherIdentity = observed.identity;
        }
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
async function ensureTaskIdentity(task: TerminalTask, pidField: "pid" | "launcherPid", inspectProcess: ProcessInspector) {
  const existingIdentity = pidField === "pid" ? task.processIdentity : task.launcherIdentity;
  if (existingIdentity) {
    return existingIdentity;
  }
  const pid = normalizeProcessId(pidField === "pid" ? task.pid : task.launcherPid);
  if (!pid || task.runtimeOwned !== true) {
    return null;
  }
  const key = `${task.taskId}:${task.instanceId ?? "legacy"}:${pidField}:${pid}`;
  await processIdentityCaptures.get(key);
  const capturedIdentity = pidField === "pid" ? task.processIdentity : task.launcherIdentity;
  if (capturedIdentity) {
    return capturedIdentity;
  }
  const observed = await inspectProcessSafely(inspectProcess, pid);
  const currentPid = pidField === "pid" ? task.pid : task.launcherPid;
  if (observed.alive && observed.identity && terminal.get(task.taskId) === task && currentPid === pid) {
    if (pidField === "pid") {
      task.processIdentity = observed.identity;
    } else {
      task.launcherIdentity = observed.identity;
    }
    task.identityCapturedAt = new Date().toISOString();
    persistTask(task);
    return observed.identity;
  }
  return null;
}

/** @param {TerminalTask} task @param {Record<string, any>} options */
function cancelTerminalTask(task: TerminalTask, options: CancelTaskOptions) {
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
async function performTerminalTaskCancellation(task: TerminalTask, options: CancelTaskOptions) {
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

  const targets: Array<{ pid: number; identity: string; pidField: "pid" | "launcherPid"; runtimeProcess?: RuntimeProcess }> = [];
  for (const pidField of ["pid", "launcherPid"] as const) {
    const pid = normalizeProcessId(pidField === "pid" ? task.pid : task.launcherPid);
    if (!pid || targets.some((target) => target.pid === pid)) {
      continue;
    }
    const runtimeProcess = runtimeProcessForTask(task, pidField);
    if (runtimeProcess) {
      if (runtimeProcessAlive(runtimeProcess)) {
        targets.push({
          pid,
          identity: `runtime:${task.instanceId ?? "legacy"}:${pid}`,
          pidField,
          runtimeProcess
        });
      }
      continue;
    }
    const inspectProcess = options.inspectProcess ?? inspectProcessIdentity;
    const identity = await ensureTaskIdentity(task, pidField, inspectProcess);
    const observed = await inspectProcessSafely(inspectProcess, pid);
    if (!observed.alive) {
      continue;
    }
    if (!identity) {
      return markTerminalTaskStale(task, "PROCESS_IDENTITY_UNKNOWN", "Refusing to terminate a process without a recorded creation identity.", options.persist === true);
    }
    if (!observed.identity) {
      return markTerminalTaskStale(task, "PROCESS_IDENTITY_UNAVAILABLE", "Refusing to terminate a process whose creation identity cannot be verified.", options.persist === true);
    }
    if (observed.identity !== identity) {
      return markTerminalTaskStale(task, "PROCESS_IDENTITY_MISMATCH", "Recorded process id now belongs to a different process instance.", options.persist === true);
    }
    targets.push({ pid, identity, pidField });
  }

  if (targets.length === 0) {
    return markTerminalTaskCancelled(task, options.persist === true);
  }

  const terminateProcess = options.terminateProcess ?? terminateVerifiedProcessTree;
  const inspectProcess = options.inspectProcess ?? inspectProcessIdentity;
  const timeoutMs = boundedCancelTimeout(options.timeoutMs);
  const outcomes = await Promise.all(targets.map((target) => terminateProcess({
    ...target,
    task,
    inspectProcess,
    timeoutMs
  })));
  const failure = outcomes.find((outcome) => outcome?.exited !== true);
  if (!failure) {
    return markTerminalTaskCancelled(task, options.persist === true);
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
function markTerminalTaskCancelled(task: TerminalTask, persist: boolean) {
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
function markTerminalTaskStale(task: TerminalTask, code: string, message: string, persist: boolean) {
  const next = staleTerminalTask(task, code, message);
  Object.assign(task, next);
  running.delete(task.taskId);
  terminal.set(task.taskId, task);
  if (persist) persistTask(task);
  return task;
}

/** @param {Record<string, any>} options */
async function terminateVerifiedProcessTree(options: TerminateProcessOptions): Promise<TerminateProcessResult> {
  const pid = normalizeProcessId(options.pid);
  if (!pid || !options.identity) {
    return { exited: false, error: "Process identity is invalid." };
  }
  const timeoutMs = options.timeoutMs;
  if (options.runtimeProcess) {
    if (!runtimeProcessAlive(options.runtimeProcess)) {
      return { exited: true };
    }
    sendProcessTreeSignal(pid, false);
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      await delay(Math.min(PROCESS_CANCEL_POLL_MS, Math.max(1, timeoutMs - (Date.now() - startedAt))));
      if (!runtimeProcessAlive(options.runtimeProcess)) {
        return { exited: true };
      }
    }
    return { exited: false, error: "Process exit was not confirmed before the cancellation deadline." };
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
  while (Date.now() - startedAt < timeoutMs) {
    await delay(Math.min(PROCESS_CANCEL_POLL_MS, Math.max(1, timeoutMs - (Date.now() - startedAt))));
    const observed = await inspectProcessSafely(options.inspectProcess, pid);
    if (!observed.alive || (observed.identity && observed.identity !== options.identity)) {
      return { exited: true };
    }
    if (!escalated && Date.now() - startedAt >= Math.min(PROCESS_CANCEL_ESCALATE_MS, timeoutMs)) {
      sendProcessTreeSignal(pid, true);
      escalated = true;
    }
  }
  return { exited: false, error: "Process exit was not confirmed before the cancellation deadline." };
}

/** @param {any} pid @param {boolean} force */
function sendProcessTreeSignal(pid: unknown, force: boolean) {
  const normalizedPid = normalizeProcessId(pid);
  if (!normalizedPid) {
    return false;
  }
  if (process.platform === "win32") {
    let requested = false;
    try {
      const killer = spawn("taskkill", ["/pid", String(normalizedPid), "/t", "/f"], {
        windowsHide: true,
        stdio: "ignore"
      });
      killer.once("error", () => {});
      killer.unref?.();
      requested = true;
    } catch {
      // Fall through to terminating the already verified root process.
    }
    try {
      process.kill(normalizedPid, force ? "SIGKILL" : "SIGTERM");
      requested = true;
    } catch {
      // The process may already have exited.
    }
    return requested;
  }
  const signal = force ? "SIGKILL" : "SIGTERM";
  try {
    process.kill(-normalizedPid, signal);
    return true;
  } catch {
    try {
      process.kill(normalizedPid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

/** @param {TerminalTask} task @param {string} pidField */
function runtimeProcessForTask(task: TerminalTask, pidField: string): RuntimeProcess | null {
  if (!task || pidField !== "pid") {
    return null;
  }
  const record = runtimeProcesses.get(task.taskId);
  return record
    && record.instanceId === task.instanceId
    && record.pid === normalizeProcessId(task.pid)
    ? record
    : null;
}

/** @param {RuntimeProcess} record */
function runtimeProcessAlive(record: RuntimeProcess) {
  return record.child.exitCode === null
    && record.child.signalCode === null
    && processExists(record.pid);
}

/** @param {any} pid */
async function inspectProcessIdentity(pid: unknown): Promise<{ alive: boolean; identity: string | null }> {
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
async function inspectProcessSafely(inspectProcess: ProcessInspector, pid: number) {
  try {
    const observed = await inspectProcess(pid);
    const record = observed && typeof observed === "object" ? observed as ProcessObservation : {};
    return {
      alive: record.alive === true,
      identity: normalizeProcessIdentity(record.identity)
    };
  } catch {
    return { alive: processExists(pid), identity: null };
  }
}

/** @param {any} pid */
function readPosixProcessIdentitySync(pid: unknown) {
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
function linuxProcessIdentity(stat: unknown) {
  const close = String(stat ?? "").lastIndexOf(")");
  if (close < 0) {
    return null;
  }
  const fields = String(stat).slice(close + 2).trim().split(/\s+/);
  const startTicks = fields[19];
  return /^\d+$/.test(startTicks ?? "") ? `linux:${startTicks}` : null;
}

/** @param {any} pid */
function processExists(pid: unknown) {
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
function collectProcessOutput(executable: string, args: string[], options: {spawnProcess?: typeof spawn, timeoutMs?: number} = EMPTY_SNAPSHOT_OPTIONS) {
  return new Promise<{ ok: boolean; stdout: string }>((resolve) => {
    let settled = false;
    let bytes = 0;
    const chunks: Buffer[] = [];
    let child: ChildProcess | undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (result: {ok: boolean, stdout: string}, terminate: boolean = false) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      releaseProcessProbe(child, { onData, onError, onClose }, terminate);
      resolve(result);
    };
    const onData = (chunk: Buffer | string) => {
      bytes += chunk.length;
      if (bytes > 8 * 1024) {
        finish({ ok: false, stdout: "" }, true);
        return;
      }
      chunks.push(Buffer.from(chunk));
    };
    const onError = () => finish({ ok: false, stdout: "" });
    /** @param {number | null} code */
    const onClose = (code: number | null) => finish({
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
function releaseProcessProbe(child: ChildProcess | undefined, handlers: ProcessProbeHandlers, terminate: boolean) {
  child?.stdout?.removeListener("data", handlers.onData);
  child?.removeListener("error", handlers.onError);
  child?.removeListener("close", handlers.onClose);
  child?.stdout?.destroy();
  if (terminate) {
    child?.once("error", () => {});
    try {
      child?.kill();
    } catch {
      // The probe may already have exited.
    }
  }
  child?.unref();
}

/** @param {any} value */
function probeTimeoutMs(value: unknown) {
  const timeout = Number(value);
  return Number.isFinite(timeout) ? Math.max(1, Math.min(10_000, Math.trunc(timeout))) : PROCESS_SNAPSHOT_TIMEOUT_MS;
}

export const __backgroundTerminalRegistryTestHooks = Object.freeze({
  collectWindowsProcessLivenessSnapshot,
  collectProcessOutput
});

/** @param {any} value */
function boundedCancelTimeout(value: unknown) {
  const timeout = Number(value);
  return Number.isFinite(timeout) ? Math.max(25, Math.min(10_000, Math.trunc(timeout))) : PROCESS_CANCEL_TIMEOUT_MS;
}

/** @param {number} ms */
function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** @param {any} value */
function safeFileName(value: unknown) {
  return String(value)
    .replace(/[^a-zA-Z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100) || "task";
}
