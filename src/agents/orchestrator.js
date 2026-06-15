import crypto from "node:crypto";
import { routeAgentTask } from "./router.js";
import { runSubagent } from "./runner.js";
import { createAgentTaskStore } from "./task-store.js";

const MAX_PARALLEL_READONLY = 3;

/**
 * @param {{
 *   cwd: string;
 *   config?: Record<string, any>;
 *   env?: NodeJS.ProcessEnv;
 *   prompt: string;
 *   parentSessionId?: string | null;
 *   readonly?: boolean;
 *   allowWrite?: boolean;
 *   allowCommand?: boolean;
 *   fullAccess?: boolean;
 *   workflowState?: any;
 *   approvalCallback?: any;
 *   hooksTrusted?: boolean;
 *   signal?: AbortSignal;
 * }} options
 */
export async function orchestrateAgentTasks(options) {
  const route = routeAgentTask({
    cwd: options.cwd,
    config: options.config,
    prompt: options.prompt
  });
  const taskStore = createAgentTaskStore({ cwd: options.cwd });
  const parentTaskId = `orchestrate-${crypto.randomUUID()}`;
  const plannedTasks = route.suggestedTasks ?? [];
  const readonlyTasks = plannedTasks
    .filter((task) => task.parallelSafe && task.mode === "readonly")
    .slice(0, MAX_PARALLEL_READONLY);
  const serialTasks = plannedTasks.filter((task) => !readonlyTasks.includes(task));

  await taskStore.createTask({
    id: parentTaskId,
    parentSessionId: options.parentSessionId ?? null,
    profile: "router",
    title: "子智能体编排",
    prompt: options.prompt,
    status: readonlyTasks.length > 0 ? "running" : "completed",
    mode: "orchestrator",
    startedAt: new Date().toISOString(),
    latestProgress: readonlyTasks.length > 0
      ? `已启动 ${readonlyTasks.length} 个并行只读子任务`
      : "没有可并行的只读子任务；请手动运行建议任务。",
    route,
    metadata: {
      plannedTasks: plannedTasks.length,
      parallelTasks: readonlyTasks.length,
      serialTasks: serialTasks.length
    }
  });

  const results = await Promise.all(readonlyTasks.map((task) => runSubagent({
    cwd: options.cwd,
    config: options.config,
    env: options.env,
    readonly: true,
    allowWrite: false,
    allowCommand: false,
    fullAccess: Boolean(options.fullAccess),
    workflowState: options.workflowState,
    approvalCallback: options.approvalCallback,
    hooksTrusted: options.hooksTrusted,
    signal: options.signal,
    taskStore,
    parentSessionId: options.parentSessionId ?? null,
    parentTaskId,
    profileName: task.profile,
    taskId: `${parentTaskId}-${task.id}`,
    routeDecision: {
      profile: task.profile,
      purpose: task.purpose,
      difficulty: task.difficulty,
      risk: task.risk,
      modelTier: task.modelTier,
      budget: task.budget
    },
    contextPack: {
      task: task.query,
      userIntent: options.prompt,
      constraints: ["并行编排中的只读子任务；不要修改文件。"],
      acceptance: ["返回证据、结论、风险和下一步建议。"]
    },
    query: task.query
  })));

  const failed = results.filter((result) => result.ok !== true);
  await taskStore.updateTask(parentTaskId, {
    status: failed.length > 0 ? "failed" : "completed",
    finishedAt: new Date().toISOString(),
    latestProgress: failed.length > 0
      ? `${failed.length}/${results.length} 个并行子任务失败`
      : `${results.length} 个并行子任务已完成`,
    outputSummary: summarizeOrchestration(results, serialTasks),
    output: JSON.stringify({
      route,
      parallelResults: results.map(summarizeChildResult),
      serialSuggestions: serialTasks
    }, null, 2),
    error: failed.length > 0 ? {
      code: "ORCHESTRATION_CHILD_FAILED",
      message: `${failed.length} child task(s) failed`
    } : null,
    metadata: {
      plannedTasks: plannedTasks.length,
      parallelTasks: readonlyTasks.length,
      serialTasks: serialTasks.length,
      failedTasks: failed.length
    }
  });

  return {
    ok: failed.length === 0,
    parentTaskId,
    route,
    parallelResults: results.map(summarizeChildResult),
    serialSuggestions: serialTasks,
    summary: summarizeOrchestration(results, serialTasks)
  };
}

export function buildTaskTree(tasks = []) {
  const byId = new Map();
  const roots = [];
  for (const task of Array.isArray(tasks) ? tasks : []) {
    byId.set(task.id, {
      ...task,
      children: []
    });
  }
  for (const node of byId.values()) {
    if (node.parentTaskId && byId.has(node.parentTaskId)) {
      byId.get(node.parentTaskId).children.push(node);
    } else {
      roots.push(node);
    }
  }
  roots.sort(compareTaskUpdated);
  for (const node of byId.values()) {
    node.children.sort(compareTaskUpdated);
  }
  return roots;
}

export function formatTaskTree(tasks = []) {
  const roots = buildTaskTree(tasks);
  if (roots.length === 0) {
    return "暂无本地子智能体任务记录。";
  }
  const lines = ["Ant Code 子任务树", ""];
  for (const root of roots.slice(0, 40)) {
    pushTaskNode(lines, root, 0);
  }
  if (roots.length > 40) {
    lines.push(`... 还有 ${roots.length - 40} 个根任务`);
  }
  lines.push("", "使用 /agents task <task-id> 查看完整任务记录；/agents continue <task-id> 续跑阶段暂停任务。");
  return lines.join("\n");
}

function pushTaskNode(lines, task, depth) {
  const indent = "  ".repeat(depth);
  const title = task.title || task.profile || "task";
  const tools = task.toolCalls?.length ? ` tools=${task.toolCalls.length}` : "";
  const progress = task.latestProgress ? ` - ${truncate(task.latestProgress, 90)}` : "";
  lines.push(`${indent}- ${task.id} [${task.status}] ${title} (${task.profile})${tools}${progress}`);
  if (task.prompt) {
    lines.push(`${indent}  ${truncate(task.prompt, 110)}`);
  }
  for (const child of task.children ?? []) {
    pushTaskNode(lines, child, depth + 1);
  }
}

function summarizeOrchestration(results, serialTasks) {
  const lines = [
    `并行子任务：${results.length}，成功：${results.filter((item) => item.ok).length}，失败：${results.filter((item) => !item.ok).length}`,
    `串行建议：${serialTasks.length}`
  ];
  for (const result of results) {
    const status = result.ok ? "ok" : "fail";
    const summary = result.output
      ? result.output.split(/\r?\n/).slice(0, 3).join(" ")
      : result.error?.message ?? "";
    lines.push(`- [${status}] ${result.profile}: ${truncate(summary, 160)}`);
  }
  for (const task of serialTasks) {
    lines.push(`- [next] ${task.profile}: ${task.title}`);
  }
  return lines.join("\n");
}

function summarizeChildResult(result) {
  return {
    ok: result.ok === true,
    profile: result.profile,
    taskId: result.taskId,
    childSessionId: result.childSessionId,
    modelDriven: result.modelDriven === true,
    outputSummary: result.output ? truncate(result.output, 1200) : "",
    error: result.error ?? null,
    tools: result.tools ?? []
  };
}

function compareTaskUpdated(left, right) {
  return String(right.updatedAt ?? right.createdAt ?? "").localeCompare(String(left.updatedAt ?? left.createdAt ?? ""));
}

function truncate(value, max) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3))}...`;
}
