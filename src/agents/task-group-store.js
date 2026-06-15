import fs from "node:fs/promises";
import path from "node:path";

const GROUP_VERSION = 1;
const TERMINAL_STATUSES = new Set(["completed", "failed", "partial", "blocked", "cancelled", "interrupted"]);
const ISSUE_STATUSES = new Set(["failed", "partial", "blocked", "interrupted"]);
const groupWriteLocks = new Map();

export function createAgentTaskGroupStore(options) {
  const root = path.join(options.cwd, ".lab-agent", "task-groups");

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
      await writeGroup(root, record);
      return record;
    },
    async ensureGroup(group) {
      const id = safeGroupId(group.id);
      return withGroupLock(root, id, async () => {
        const existing = await this.readGroup(id);
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
          await writeGroup(root, record);
          return { ok: true, group: record };
        }
        return this.createGroup({ ...group, id });
      });
    },
    async updateGroup(groupId, patch) {
      const id = safeGroupId(groupId);
      return withGroupLock(root, id, async () => {
        const latest = await this.readGroup(id);
        if (!latest.ok) {
          return latest;
        }
        const record = normalizeGroup({
          ...latest.group,
          ...patch,
          taskIds: patch.taskIds ? mergeUnique(latest.group.taskIds, patch.taskIds) : latest.group.taskIds,
          updatedAt: new Date().toISOString()
        });
        await writeGroup(root, record);
        return { ok: true, group: record };
      });
    },
    async readGroup(groupId) {
      try {
        const filePath = path.join(root, `${safeGroupId(groupId)}.json`);
        const raw = await fs.readFile(filePath, "utf8");
        return { ok: true, path: filePath, group: normalizeGroup(JSON.parse(raw)) };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: "AGENT_TASK_GROUP_NOT_FOUND",
            message: error instanceof Error ? error.message : String(error)
          }
        };
      }
    },
    async listGroups(options = {}) {
      await fs.mkdir(root, { recursive: true });
      const entries = await fs.readdir(root, { withFileTypes: true });
      const groups = [];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) {
          continue;
        }
        try {
          const raw = await fs.readFile(path.join(root, entry.name), "utf8");
          const group = normalizeGroup(JSON.parse(raw));
          if (options.parentSessionId && group.parentSessionId !== options.parentSessionId) {
            continue;
          }
          groups.push(group);
        } catch {
          // Ignore corrupt group records in list views; direct read still reports errors.
        }
      }
      return groups.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
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
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, `${safeGroupId(group.id)}.json`), `${JSON.stringify(group, null, 2)}\n`, "utf8");
}

async function withGroupLock(root, groupId, fn) {
  const key = `${path.resolve(root).toLowerCase()}::${groupId}`;
  const previous = groupWriteLocks.get(key) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current, () => current);
  groupWriteLocks.set(key, queued);
  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (groupWriteLocks.get(key) === queued) {
      groupWriteLocks.delete(key);
    }
  }
}

export function safeGroupId(value) {
  const text = String(value ?? "").trim();
  if (!/^[A-Za-z0-9._-]+$/.test(text)) {
    throw new Error(`Invalid task group id: ${text}`);
  }
  return text;
}
