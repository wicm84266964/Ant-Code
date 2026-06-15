import fs from "node:fs/promises";
import path from "node:path";

const TASK_VERSION = 2;
const TASK_OUTPUT_PREVIEW_CHARS = 32_000;
const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "partial", "blocked", "cancelled", "interrupted"]);

export function createAgentTaskStore(options) {
  const root = path.join(options.cwd, ".lab-agent", "tasks");
  const outputRoot = path.join(options.cwd, ".lab-agent", "task-outputs");

  return {
    root,
    async createTask(task) {
      const now = new Date().toISOString();
      const record = normalizeTask({
        ...task,
        version: TASK_VERSION,
        createdAt: task.createdAt ?? now,
        updatedAt: now,
        status: task.status ?? "queued"
      });
      await writeTask(root, record);
      return record;
    },
    async updateTask(taskId, patch) {
      const current = await this.readTask(taskId);
      if (!current.ok) {
        return current;
      }
      const now = new Date().toISOString();
      const status = patch.status ? normalizeStatus(patch.status) : current.task.status;
      const terminal = TERMINAL_TASK_STATUSES.has(status);
      const record = normalizeTask({
        ...current.task,
        ...patch,
        updatedAt: now,
        progressAt: patch.progressAt ?? (isProgressPatch(patch) ? now : current.task.progressAt),
        heartbeatAt: patch.heartbeatAt ?? (terminal ? now : current.task.heartbeatAt)
      });
      await writeTask(root, record);
      return { ok: true, task: record };
    },
    async writeTaskOutput(taskId, output) {
      const id = safeTaskId(taskId);
      const text = String(output ?? "");
      const bytes = Buffer.byteLength(text, "utf8");
      await fs.mkdir(outputRoot, { recursive: true });
      const filePath = path.join(outputRoot, `${id}.txt`);
      await fs.writeFile(filePath, text, "utf8");
      const relativePath = path.relative(options.cwd, filePath);
      return {
        path: relativePath,
        bytes,
        preview: previewTaskOutput(text),
        truncated: text.length > TASK_OUTPUT_PREVIEW_CHARS
      };
    },
    async readTaskOutput(task) {
      const outputPath = task?.metadata?.outputPath;
      if (!outputPath) {
        return { ok: false, error: { code: "TASK_OUTPUT_PATH_MISSING", message: "Task has no sidecar output path." } };
      }
      try {
        const filePath = path.resolve(options.cwd, outputPath);
        const rootPath = path.resolve(outputRoot);
        if (!filePath.toLowerCase().startsWith(rootPath.toLowerCase() + path.sep)) {
          return { ok: false, error: { code: "TASK_OUTPUT_PATH_OUTSIDE_STORE", message: "Task output path is outside the task output store." } };
        }
        const text = await fs.readFile(filePath, "utf8");
        return { ok: true, path: filePath, output: text };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: "TASK_OUTPUT_READ_FAILED",
            message: error instanceof Error ? error.message : String(error)
          }
        };
      }
    },
    async readTask(taskId) {
      try {
        const filePath = path.join(root, `${safeTaskId(taskId)}.json`);
        const raw = await fs.readFile(filePath, "utf8");
        return { ok: true, path: filePath, task: normalizeTask(JSON.parse(raw)) };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: "AGENT_TASK_NOT_FOUND",
            message: error instanceof Error ? error.message : String(error)
          }
        };
      }
    },
    async listTasks(options = {}) {
      await fs.mkdir(root, { recursive: true });
      const entries = await fs.readdir(root, { withFileTypes: true });
      const tasks = [];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) {
          continue;
        }
        try {
          const raw = await fs.readFile(path.join(root, entry.name), "utf8");
          const task = normalizeTask(JSON.parse(raw));
          if (options.parentSessionId && task.parentSessionId !== options.parentSessionId) {
            continue;
          }
          tasks.push(task);
        } catch {
          // Ignore corrupt task records in list views; direct read still reports errors.
        }
      }
      return tasks.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
    }
  };
}

function normalizeTask(value = {}) {
  const task = value && typeof value === "object" ? value : {};
  return {
    version: Number.isFinite(task.version) ? task.version : TASK_VERSION,
    id: String(task.id ?? ""),
    parentSessionId: task.parentSessionId ? String(task.parentSessionId) : null,
    parentTaskId: task.parentTaskId ? String(task.parentTaskId) : null,
    groupId: task.groupId ? String(task.groupId) : null,
    childSessionId: task.childSessionId ? String(task.childSessionId) : null,
    profile: String(task.profile ?? "unknown"),
    purpose: task.purpose ? String(task.purpose) : null,
    difficulty: task.difficulty ? String(task.difficulty) : null,
    risk: task.risk ? String(task.risk) : null,
    title: String(task.title ?? ""),
    prompt: String(task.prompt ?? ""),
    contextPack: task.contextPack && typeof task.contextPack === "object" ? task.contextPack : null,
    budget: task.budget && typeof task.budget === "object" ? task.budget : null,
    budgetProgress: task.budgetProgress && typeof task.budgetProgress === "object" ? task.budgetProgress : null,
    budgetExceeded: task.budgetExceeded && typeof task.budgetExceeded === "object" ? task.budgetExceeded : null,
    routeDecision: task.routeDecision && typeof task.routeDecision === "object" ? task.routeDecision : null,
    status: normalizeStatus(task.status),
    mode: task.mode ? String(task.mode) : null,
    model: task.model ? String(task.model) : null,
    modelTier: task.modelTier ? String(task.modelTier) : null,
    createdAt: task.createdAt ?? null,
    startedAt: task.startedAt ?? null,
    finishedAt: task.finishedAt ?? null,
    updatedAt: task.updatedAt ?? task.finishedAt ?? task.startedAt ?? task.createdAt ?? null,
    heartbeatAt: task.heartbeatAt ?? task.startedAt ?? task.updatedAt ?? task.finishedAt ?? task.createdAt ?? null,
    progressAt: task.progressAt ?? task.updatedAt ?? task.startedAt ?? task.finishedAt ?? task.createdAt ?? null,
    latestProgress: String(task.latestProgress ?? ""),
    toolCalls: Array.isArray(task.toolCalls) ? task.toolCalls.map(normalizeToolCall) : [],
    outputSummary: String(task.outputSummary ?? ""),
    output: typeof task.output === "string" ? task.output : "",
    outputContract: task.outputContract && typeof task.outputContract === "object" ? task.outputContract : null,
    continuationPrompt: typeof task.continuationPrompt === "string" ? task.continuationPrompt : null,
    error: task.error && typeof task.error === "object" ? task.error : null,
    cancelRequestedAt: task.cancelRequestedAt ?? null,
    route: task.route && typeof task.route === "object" ? task.route : null,
    metadata: task.metadata && typeof task.metadata === "object" ? task.metadata : {}
  };
}

function isProgressPatch(patch = {}) {
  if (!patch || typeof patch !== "object") {
    return false;
  }
  return Object.prototype.hasOwnProperty.call(patch, "latestProgress")
    || Object.prototype.hasOwnProperty.call(patch, "toolCalls")
    || Object.prototype.hasOwnProperty.call(patch, "budgetProgress")
    || Object.prototype.hasOwnProperty.call(patch, "outputSummary")
    || Object.prototype.hasOwnProperty.call(patch, "output")
    || Object.prototype.hasOwnProperty.call(patch, "status");
}

function normalizeToolCall(value = {}) {
  return {
    name: String(value.name ?? "unknown"),
    inputSummary: value.inputSummary ? String(value.inputSummary) : null,
    ok: value.ok === true,
    blocked: value.blocked === true,
    interrupted: value.interrupted === true,
    errorCode: value.errorCode ?? null,
    decision: value.decision ?? null,
    truncated: value.truncated === true,
    resultBytes: Number.isFinite(value.resultBytes) ? value.resultBytes : null,
    omittedBytes: Number.isFinite(value.omittedBytes) ? value.omittedBytes : null
  };
}

function normalizeStatus(value) {
  const status = String(value ?? "queued");
  return ["queued", "running", "partial", "completed", "failed", "blocked", "cancelled", "interrupted"].includes(status)
    ? status
    : "failed";
}

async function writeTask(root, task) {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, `${safeTaskId(task.id)}.json`), `${JSON.stringify(task, null, 2)}\n`, "utf8");
}

function safeTaskId(value) {
  const text = String(value ?? "").trim();
  if (!/^[A-Za-z0-9._-]+$/.test(text)) {
    throw new Error(`Invalid task id: ${text}`);
  }
  return text;
}

function previewTaskOutput(value) {
  const text = String(value ?? "");
  if (text.length <= TASK_OUTPUT_PREVIEW_CHARS) {
    return text;
  }
  const marker = "\n...[full task output saved to sidecar]...\n";
  const headChars = Math.floor((TASK_OUTPUT_PREVIEW_CHARS - marker.length) / 2);
  const tailChars = TASK_OUTPUT_PREVIEW_CHARS - marker.length - headChars;
  return `${text.slice(0, headChars)}${marker}${text.slice(Math.max(0, text.length - tailChars))}`;
}
