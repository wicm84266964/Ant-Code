import fs from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile, ensureContainedDirectory, withFileMutationLock } from "../storage/durable-file.js";

const GROUP_VERSION = 1;
const GROUP_LIST_CACHE_MS = 500;
const TERMINAL_STATUSES = new Set(["completed", "failed", "partial", "blocked", "cancelled", "interrupted"]);
const ISSUE_STATUSES = new Set(["failed", "partial", "blocked", "interrupted"]);
const groupListCache = new Map();

/** @param {{ cwd: string; onListScan?: () => void }} options */
export function createAgentTaskGroupStore(options) {
  const root = path.join(options.cwd, ".lab-agent", "task-groups");
  const onListScan = options.onListScan;
  let resolvedRoot = null;
  const groupRoot = () => resolvedRoot ??= ensureContainedDirectory(options.cwd, root);

  return {
    root,
    async createGroup(group) {
      const now = new Date().toISOString();
      const record = normalizeGroup({
        ...group,
        version: GROUP_VERSION,
        createdAt: group.createdAt ?? now,
        updatedAt: now,
        status: group.status ?? "running"
      });
      const directory = await groupRoot();
      await withGroupLock(directory, record.id, async () => {
        await writeGroup(directory, record);
        invalidateGroupListCache(directory);
      });
      return record;
    },
    async ensureGroup(group) {
      const id = safeGroupId(group.id);
      const directory = await groupRoot();
      return withGroupLock(directory, id, async () => {
        const existing = await readGroupFile(path.join(directory, `${id}.json`));
        if (existing.ok) {
          const taskIds = mergeUnique(existing.group.taskIds, group.taskIds);
          const record = normalizeGroup({
            ...existing.group,
            ...group,
            id,
            taskIds,
            status: existing.group.status === "queued" ? "running" : existing.group.status,
            createdAt: existing.group.createdAt,
            updatedAt: new Date().toISOString()
          });
          await writeGroup(directory, record);
          invalidateGroupListCache(directory);
          return { ok: true, group: record };
        }
        if (existing.error?.code !== "AGENT_TASK_GROUP_NOT_FOUND") {
          return existing;
        }
        const now = new Date().toISOString();
        const record = normalizeGroup({
          ...group,
          id,
          version: GROUP_VERSION,
          createdAt: group.createdAt ?? now,
          updatedAt: now,
          status: group.status ?? "running"
        });
        await writeGroup(directory, record);
        invalidateGroupListCache(directory);
        return { ok: true, group: record };
      });
    },
    async updateGroup(groupId, patch) {
      const id = safeGroupId(groupId);
      const directory = await groupRoot();
      return withGroupLock(directory, id, async () => {
        const latest = await readGroupFile(path.join(directory, `${id}.json`));
        if (!latest.ok) {
          return latest;
        }
        const record = normalizeGroup({
          ...latest.group,
          ...patch,
          taskIds: patch.taskIds ? mergeUnique(latest.group.taskIds, patch.taskIds) : latest.group.taskIds,
          metadata: patch.metadata && typeof patch.metadata === "object"
            ? { ...latest.group.metadata, ...patch.metadata }
            : latest.group.metadata,
          updatedAt: new Date().toISOString()
        });
        await writeGroup(directory, record);
        invalidateGroupListCache(directory);
        return { ok: true, group: record };
      });
    },
    async readGroup(groupId) {
      const directory = await groupRoot();
      return readGroupFile(path.join(directory, `${safeGroupId(groupId)}.json`));
    },
    async listGroups(options = {}) {
      const listOptions = /** @type {{ parentSessionId?: string; signal?: AbortSignal }} */ (options);
      const directory = await groupRoot();
      const groups = await loadGroupList(directory, onListScan, listOptions.signal);
      return groups
        .filter((group) => !listOptions.parentSessionId || group.parentSessionId === listOptions.parentSessionId)
        .map(cloneGroup)
        .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
    }
  };
}

export function summarizeGroupStatus(tasks = [], options = {}) {
  const waitFor = String(options.waitFor ?? "all");
  const items = Array.isArray(tasks) ? tasks : [];
  if (items.length === 0) {
    return { status: "running", completed: false, summary: "0 个子任务" };
  }
  const terminal = items.filter((task) => TERMINAL_STATUSES.has(String(task.status)));
  const issue = items.filter((task) => ISSUE_STATUSES.has(String(task.status)));
  const success = terminal.filter((task) => String(task.status) === "completed");
  const completed = waitFor === "any" ? terminal.length > 0 : terminal.length === items.length;
  let status = "running";
  if (completed) {
    status = waitFor === "any"
      ? success.length > 0 ? "completed" : "partial"
      : issue.length > 0 ? "partial" : "completed";
  }
  return {
    status,
    completed,
    summary: `${items.length} 个子任务，完成 ${items.filter((task) => task.status === "completed").length}，问题 ${issue.length}，运行中 ${items.length - terminal.length}`
  };
}

function normalizeGroup(value = {}) {
  const group = value && typeof value === "object" ? value : {};
  return {
    version: Number.isFinite(group.version) ? group.version : GROUP_VERSION,
    id: String(group.id ?? ""),
    parentSessionId: group.parentSessionId ? String(group.parentSessionId) : null,
    parentTaskId: group.parentTaskId ? String(group.parentTaskId) : null,
    status: normalizeStatus(group.status),
    waitFor: ["all", "any", "none"].includes(String(group.waitFor)) ? String(group.waitFor) : "all",
    wakeParent: group.wakeParent !== false,
    wakeReason: String(group.wakeReason ?? ""),
    taskIds: Array.isArray(group.taskIds) ? mergeUnique([], group.taskIds) : [],
    createdAt: group.createdAt ?? null,
    updatedAt: group.updatedAt ?? group.createdAt ?? null,
    completedAt: group.completedAt ?? null,
    wakePromptQueuedAt: group.wakePromptQueuedAt ?? null,
    wakePromptConsumedAt: group.wakePromptConsumedAt ?? null,
    wakePrompt: typeof group.wakePrompt === "string" ? group.wakePrompt : "",
    latestProgress: String(group.latestProgress ?? ""),
    summary: String(group.summary ?? ""),
    metadata: group.metadata && typeof group.metadata === "object" ? group.metadata : {}
  };
}

function normalizeStatus(value) {
  const status = String(value ?? "running");
  return ["queued", "running", "completed", "partial", "failed", "blocked", "cancelled", "interrupted"].includes(status)
    ? status
    : "failed";
}

function mergeUnique(left = [], right = []) {
  return [...new Set([...(Array.isArray(left) ? left : []), ...(Array.isArray(right) ? right : [])].map((item) => String(item)).filter(Boolean))];
}

async function writeGroup(root, group) {
  await atomicWriteFile(path.join(root, `${safeGroupId(group.id)}.json`), `${JSON.stringify(group, null, 2)}\n`);
}

async function withGroupLock(root, groupId, fn) {
  return withFileMutationLock(path.join(root, `${safeGroupId(groupId)}.json`), fn);
}

/**
 * @param {string} filePath
 * @returns {Promise<any>}
 */
async function readGroupFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return { ok: true, path: filePath, group: normalizeGroup(JSON.parse(raw)) };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: /** @type {NodeJS.ErrnoException} */ (error)?.code === "ENOENT" ? "AGENT_TASK_GROUP_NOT_FOUND" : "AGENT_TASK_GROUP_READ_ERROR",
        message: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

/**
 * @param {string} root
 * @param {(() => void) | undefined} onScan
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<Array<Record<string, any>>>}
 */
function loadGroupList(root, onScan, signal) {
  const key = path.resolve(root).toLowerCase();
  let cached = groupListCache.get(key);
  if (!cached) {
    cached = { groups: [], loadedAt: 0, inFlight: null, dirty: false };
    groupListCache.set(key, cached);
  }
  if (!cached.dirty && cached.loadedAt > 0 && Date.now() - cached.loadedAt <= GROUP_LIST_CACHE_MS) {
    return waitForGroupList(Promise.resolve(cached.groups), signal);
  }
  if (cached.inFlight) {
    return waitForGroupList(cached.inFlight, signal);
  }
  cached.dirty = false;
  onScan?.();
  const inFlight = scanGroupList(root).then((groups) => {
    if (!cached.dirty) {
      cached.groups = groups;
      cached.loadedAt = Date.now();
    }
    return groups;
  }).finally(() => {
    if (cached.inFlight === inFlight) {
      cached.inFlight = null;
    }
  });
  cached.inFlight = inFlight;
  return waitForGroupList(inFlight, signal);
}

/**
 * Cancel only this caller's wait. The shared scan remains in-flight so a
 * timeout cannot start an overlapping scan on the next request.
 *
 * @param {Promise<Array<Record<string, any>>>} promise
 * @param {AbortSignal | undefined} signal
 */
function waitForGroupList(promise, signal) {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    return Promise.reject(groupListAbortError(signal));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    /** @type {(callback: (value: any) => void, value: any) => void} */
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      callback(value);
    };
    const abort = () => finish(reject, groupListAbortError(signal));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (groups) => finish(resolve, groups),
      (error) => finish(reject, error)
    );
  });
}

/** @param {AbortSignal} signal */
function groupListAbortError(signal) {
  const error = signal.reason instanceof Error ? signal.reason : new Error("Task group scan was cancelled");
  if (!error.name || error.name === "Error") error.name = "AbortError";
  return error;
}

/** @param {string} root */
async function scanGroupList(root) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json"));
  /** @type {Array<Record<string, any>>} */
  const groups = [];
  for (let offset = 0; offset < files.length; offset += 32) {
    const batch = await Promise.all(files.slice(offset, offset + 32).map(async (entry) => {
      try {
        const raw = await fs.readFile(path.join(root, entry.name), "utf8");
        return normalizeGroup(JSON.parse(raw));
      } catch {
        return null;
      }
    }));
    for (const group of batch) {
      if (group) groups.push(group);
    }
  }
  return groups;
}

/** @param {string} root */
function invalidateGroupListCache(root) {
  const cached = groupListCache.get(path.resolve(root).toLowerCase());
  if (cached) {
    cached.dirty = true;
    cached.loadedAt = 0;
  }
}

/**
 * @param {Record<string, any>} group
 * @returns {Record<string, any>}
 */
function cloneGroup(group) {
  return {
    ...group,
    taskIds: Array.isArray(group.taskIds) ? group.taskIds.slice() : [],
    metadata: group.metadata && typeof group.metadata === "object" ? { ...group.metadata } : {}
  };
}

export function safeGroupId(value) {
  const text = String(value ?? "").trim();
  if (!/^[A-Za-z0-9._-]+$/.test(text)) {
    throw new Error(`Invalid task group id: ${text}`);
  }
  return text;
}
