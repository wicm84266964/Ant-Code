const MAX_ITEMS = 100;
const MAX_TEXT_CHARS = 500;
const MAX_FAILURE_CONTEXT_ITEMS = 3;
const MAX_FAILURE_COMMAND_CHARS = 120;
const MAX_FAILURE_OUTPUT_CHARS = 1200;
const VALID_STATUSES = new Set(["pending", "in_progress", "completed", "cancelled"]);

export function createWorkflowState() {
  return {
    todos: [],
    plan: {
      explanation: "",
      steps: []
    },
    changes: [],
    validations: []
  };
}

/**
 * @param {{ workflow: ReturnType<typeof createWorkflowState> }} input
 */
export function todoReadTool(input) {
  return cloneWorkflowState(input.workflow).todos;
}

/**
 * @param {{ workflow: ReturnType<typeof createWorkflowState>; items: Array<Record<string, any>> }} input
 */
export function todoWriteTool(input) {
  input.workflow.todos = normalizeItems(input.items, "todo");
  return {
    todos: cloneWorkflowState(input.workflow).todos
  };
}

/**
 * @param {{ workflow: ReturnType<typeof createWorkflowState>; explanation?: string; steps: Array<Record<string, any>> }} input
 */
export function planUpdateTool(input) {
  input.workflow.plan = {
    explanation: truncateText(input.explanation ?? ""),
    steps: normalizeItems(input.steps, "step")
  };
  return cloneWorkflowState(input.workflow).plan;
}

/**
 * Best-effort local sync for the common case where the assistant gives a
 * final successful answer but forgot to make one last workflow tool call.
 *
 * @param {ReturnType<typeof createWorkflowState>} workflow
 * @param {string} finalText
 */
export function syncWorkflowCompletionOnFinal(workflow, finalText) {
  const text = String(finalText ?? "");
  if (hasIncompleteSignal(text)) {
    return {
      changed: false,
      todosCompleted: 0,
      planStepsCompleted: 0,
      workflow: cloneWorkflowState(workflow)
    };
  }

  const includePending = hasStrongCompletionSignal(text);
  const todos = completeWorkflowItems(workflow.todos, { includePending });
  const steps = completeWorkflowItems(workflow.plan?.steps, { includePending });

  if (todos.completed > 0) {
    workflow.todos = todos.items;
  }
  if (steps.completed > 0) {
    workflow.plan = {
      explanation: workflow.plan?.explanation ?? "",
      steps: steps.items
    };
  }

  return {
    changed: todos.completed + steps.completed > 0,
    todosCompleted: todos.completed,
    planStepsCompleted: steps.completed,
    workflow: cloneWorkflowState(workflow)
  };
}

/**
 * @param {ReturnType<typeof createWorkflowState>} workflow
 * @param {string} text
 */
export function addTodo(workflow, text) {
  const next = normalizeItems([
    ...workflow.todos,
    { content: text, status: "pending" }
  ], "todo");
  workflow.todos = next;
  return cloneWorkflowState(workflow).todos;
}

/**
 * @param {ReturnType<typeof createWorkflowState>} workflow
 * @param {number} number
 * @param {string} status
 */
export function updateTodoStatus(workflow, number, status) {
  if (!VALID_STATUSES.has(status)) {
    return { ok: false, error: { code: "TODO_STATUS_INVALID", message: `Unsupported todo status: ${status}` } };
  }
  const index = number - 1;
  if (!Number.isInteger(number) || index < 0 || index >= workflow.todos.length) {
    return { ok: false, error: { code: "TODO_NOT_FOUND", message: `Todo ${number} was not found` } };
  }
  workflow.todos[index] = { ...workflow.todos[index], status };
  workflow.todos = normalizeItems(workflow.todos, "todo");
  return { ok: true, todos: cloneWorkflowState(workflow).todos };
}

/**
 * @param {ReturnType<typeof createWorkflowState>} workflow
 */
export function clearTodos(workflow) {
  workflow.todos = [];
  return [];
}

/**
 * @param {ReturnType<typeof createWorkflowState>} workflow
 * @param {string[]} titles
 */
export function setPlanSteps(workflow, titles) {
  workflow.plan = {
    explanation: workflow.plan?.explanation ?? "",
    steps: normalizeItems(titles.map((title) => ({ title, status: "pending" })), "step")
  };
  return cloneWorkflowState(workflow).plan;
}

/**
 * @param {ReturnType<typeof createWorkflowState>} workflow
 */
export function clearPlan(workflow) {
  workflow.plan = { explanation: "", steps: [] };
  return cloneWorkflowState(workflow).plan;
}

/**
 * @param {ReturnType<typeof createWorkflowState>} workflow
 */
export function summarizeWorkflow(workflow) {
  const todos = workflow.todos ?? [];
  const steps = workflow.plan?.steps ?? [];
  const changes = workflow.changes ?? [];
  const validations = workflow.validations ?? [];
  return {
    todos: summarizeStatuses(todos),
    planSteps: summarizeStatuses(steps),
    changes: {
      total: changes.length,
      created: changes.filter((change) => change.created).length,
      edited: changes.filter((change) => change.edited).length,
      diffTruncated: changes.filter((change) => change.diffTruncated).length
    },
    validations: summarizeValidations(validations)
  };
}

/**
 * Build a bounded, redacted context note for the next model turn.
 *
 * This is intentionally more useful than persisted metadata, but still avoids
 * raw todo text, plan text, file paths, and full shell output.
 *
 * @param {ReturnType<typeof createWorkflowState>} workflow
 */
export function formatWorkflowContext(workflow) {
  const summary = summarizeWorkflow(workflow);
  const failures = recentFailedValidations(workflow.validations ?? []);
  const hasWorkflowContext = [
    summary.todos.total,
    summary.planSteps.total,
    summary.changes.total,
    summary.validations.total
  ].some((count) => count > 0);

  if (!hasWorkflowContext) {
    return "";
  }

  const lines = [
    "Ant Code local workflow context (session-local, bounded):",
    `- todos: ${formatStatusSummary(summary.todos)}`,
    `- plan steps: ${formatStatusSummary(summary.planSteps)}`,
    `- file changes: total=${summary.changes.total}, created=${summary.changes.created}, edited=${summary.changes.edited}, diffTruncated=${summary.changes.diffTruncated}`,
    `- validations: total=${summary.validations.total}, passed=${summary.validations.passed}, failed=${summary.validations.failed}, timedOut=${summary.validations.timedOut}`
  ];

  if (failures.length > 0) {
    lines.push("", "Recent failed validations requiring follow-up:");
    failures.forEach((validation, index) => {
      lines.push(...formatValidationFailure(validation, index));
    });
    lines.push("", "Use this context to repair failed validations before reporting completion. Failure excerpts are redacted and may omit paths or secrets; inspect or rerun locally when needed.");
  } else if (summary.validations.failed > 0) {
    lines.push("", "Earlier validation failures exist, but the latest validation state does not expose an active failure excerpt. Re-run relevant checks if the user asks for repair status.");
  }

  return lines.join("\n");
}

/**
 * @param {ReturnType<typeof createWorkflowState>} workflow
 * @param {Record<string, any>} change
 */
export function recordFileChange(workflow, change) {
  const next = {
    id: `change-${(workflow.changes?.length ?? 0) + 1}`,
    toolName: truncateText(String(change.toolName ?? "unknown"), 80),
    path: truncateText(String(change.path ?? ""), 300),
    created: Boolean(change.created),
    edited: Boolean(change.edited),
    diffBytes: Number.isFinite(change.diffBytes) ? change.diffBytes : 0,
    diffTruncated: Boolean(change.diffTruncated),
    recordedAt: new Date().toISOString()
  };

  if (!next.path) {
    return cloneWorkflowState(workflow).changes;
  }
  workflow.changes = [...(workflow.changes ?? []), next].slice(-MAX_ITEMS);
  return cloneWorkflowState(workflow).changes;
}

/**
 * @param {ReturnType<typeof createWorkflowState>} workflow
 * @param {Record<string, any>} validation
 */
export function recordValidation(workflow, validation) {
  const exitCode = Number.isFinite(validation.exitCode) ? validation.exitCode : null;
  const timedOut = Boolean(validation.timedOut);
  const hasError = Boolean(validation.error);
  const passed = exitCode === 0 && !timedOut && !hasError;
  const next = {
    id: `validation-${(workflow.validations?.length ?? 0) + 1}`,
    toolName: truncateText(String(validation.toolName ?? "shell"), 80),
    command: truncateText(String(validation.command ?? "")),
    exitCode,
    passed,
    timedOut,
    durationMs: Number.isFinite(validation.durationMs) ? validation.durationMs : null,
    stdoutBytes: Buffer.byteLength(String(validation.stdout ?? ""), "utf8"),
    stderrBytes: Buffer.byteLength(String(validation.stderr ?? ""), "utf8"),
    stdoutTruncated: Boolean(validation.stdoutTruncated),
    stderrTruncated: Boolean(validation.stderrTruncated),
    recordedAt: new Date().toISOString()
  };

  if (!next.command) {
    return cloneWorkflowState(workflow).validations;
  }
  if (!passed) {
    next.failureContext = buildFailureContext(validation);
  }
  workflow.validations = [...(workflow.validations ?? []), next].slice(-MAX_ITEMS);
  return cloneWorkflowState(workflow).validations;
}

/**
 * @param {ReturnType<typeof createWorkflowState>} workflow
 */
export function cloneWorkflowState(workflow) {
  return JSON.parse(JSON.stringify({
    todos: Array.isArray(workflow.todos) ? workflow.todos : [],
    plan: {
      explanation: workflow.plan?.explanation ?? "",
      steps: Array.isArray(workflow.plan?.steps) ? workflow.plan.steps : []
    },
    changes: Array.isArray(workflow.changes) ? workflow.changes : [],
    validations: Array.isArray(workflow.validations) ? workflow.validations : []
  }));
}

/**
 * @param {Array<Record<string, any>>} items
 * @param {string} prefix
 */
function normalizeItems(items, prefix) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items.slice(0, MAX_ITEMS).map((item, index) => {
    const source = normalizeItemSource(item);
    const status = normalizeStatus(inferItemStatus(source));
    const text = truncateText(String(source.content ?? source.text ?? source.title ?? source.task ?? source.description ?? source.label ?? source.name ?? source.value ?? ""));
    return {
      id: typeof source.id === "string" && source.id.trim() ? truncateText(source.id.trim(), 80) : `${prefix}-${index + 1}`,
      content: text,
      status
    };
  }).filter((item) => item.content.length > 0);
}

function normalizeItemSource(item) {
  if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
    return { content: String(item), status: "pending" };
  }
  if (Array.isArray(item)) {
    return { content: item.map((part) => String(part ?? "")).filter(Boolean).join(" "), status: "pending" };
  }
  return item && typeof item === "object" ? item : {};
}

/**
 * @param {Record<string, any>} source
 */
function inferItemStatus(source) {
  const explicit = source.status ?? source.state ?? source.progress;
  if (explicit !== undefined && explicit !== null && String(explicit).trim()) {
    return explicit;
  }
  if (source.completed === true || source.done === true || source.checked === true || source.finished === true) {
    return "completed";
  }
  if (source.active === true || source.current === true || source.running === true || source.started === true) {
    return "in_progress";
  }
  if (source.cancelled === true || source.canceled === true || source.skipped === true) {
    return "cancelled";
  }
  return "pending";
}

/**
 * @param {string} status
 */
function normalizeStatus(status) {
  const normalized = normalizeStatusToken(status);
  const compact = normalized.replace(/_/g, "");
  const completedAliases = [
    "done", "complete", "completed", "finished", "finish", "success", "succeeded", "passed", "pass", "ok",
    "完成", "已完成", "完成了", "已完成了", "完毕", "已完毕", "成功", "已成功", "通过", "已通过", "结束", "已结束", "处理完成", "执行完成"
  ];
  if (completedAliases.includes(normalized) || completedAliases.includes(compact)) {
    return "completed";
  }
  const inProgressAliases = [
    "current", "active", "running", "started", "start", "doing", "working", "wip", "inprogress",
    "进行中", "执行中", "处理中", "正在进行", "正在执行", "正在处理", "开始", "已开始", "工作中", "运行中", "当前", "当前项"
  ];
  if (inProgressAliases.includes(normalized) || inProgressAliases.includes(compact)) {
    return "in_progress";
  }
  const pendingAliases = [
    "todo", "open", "queued", "not_started", "notstarted",
    "待办", "待处理", "未开始", "尚未开始", "待开始", "排队", "队列中", "等待", "未完成"
  ];
  if (pendingAliases.includes(normalized) || pendingAliases.includes(compact)) {
    return "pending";
  }
  const cancelledAliases = [
    "canceled", "cancel", "cancelled", "skipped", "skip",
    "取消", "已取消", "取消了", "跳过", "已跳过"
  ];
  if (cancelledAliases.includes(normalized) || cancelledAliases.includes(compact)) {
    return "cancelled";
  }
  return VALID_STATUSES.has(normalized) ? normalized : "pending";
}

/**
 * @param {string} status
 */
function normalizeStatusToken(status) {
  return String(status ?? "pending")
    .trim()
    .toLowerCase()
    .replace(/[✅✔☑✓]/g, "")
    .replace(/[。.!！：:，,；;、]/g, "")
    .replace(/[-\s]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function hasStrongCompletionSignal(text) {
  const value = String(text ?? "");
  return /全部.{0,12}(完成|处理|通过|标记)|所有.{0,12}(完成|处理|通过|标记)|(均|都).{0,8}(完成|通过)|已完成|完成了|done|completed|finished|all\s+(done|complete|completed)/i.test(value);
}

function hasIncompleteSignal(text) {
  const value = String(text ?? "");
  return /未完成|没有完成|尚未完成|无法完成|不能完成|未通过|失败|报错|被阻止|等待用户|需要你确认|剩余.{0,12}(待办|任务|步骤)|blocked|failed|cannot|unable|not\s+complete|incomplete|remaining\s+(tasks|items|steps)/i.test(value);
}

/**
 * @param {Array<Record<string, any>>} items
 * @param {{ includePending?: boolean }} options
 */
function completeWorkflowItems(items, options = {}) {
  if (!Array.isArray(items) || items.length === 0) {
    return { items: [], completed: 0 };
  }

  let completed = 0;
  const next = items.map((item) => {
    const status = normalizeStatus(item?.status);
    const shouldComplete = status === "in_progress" || (options.includePending && status === "pending");
    if (!shouldComplete) {
      return { ...item, status };
    }
    completed += 1;
    return { ...item, status: "completed" };
  });
  return { items: next, completed };
}

/**
 * @param {string} text
 * @param {number} max
 */
function truncateText(text, max = MAX_TEXT_CHARS) {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max);
}

/**
 * @param {Array<Record<string, any>>} items
 */
function summarizeStatuses(items) {
  const summary = {
    total: items.length,
    pending: 0,
    in_progress: 0,
    completed: 0,
    cancelled: 0
  };

  for (const item of items) {
    if (item.status in summary) {
      summary[item.status] += 1;
    }
  }

  return summary;
}

/**
 * @param {Array<Record<string, any>>} validations
 */
function summarizeValidations(validations) {
  const summary = {
    total: validations.length,
    passed: 0,
    failed: 0,
    timedOut: 0
  };

  for (const validation of validations) {
    if (validation.passed) {
      summary.passed += 1;
    } else {
      summary.failed += 1;
    }
    if (validation.timedOut) {
      summary.timedOut += 1;
    }
  }

  return summary;
}

/**
 * @param {Array<Record<string, any>>} validations
 */
function recentFailedValidations(validations) {
  if (!Array.isArray(validations) || validations.length === 0) {
    return [];
  }
  const latestPassedIndex = validations.reduce((latest, validation, index) => (
    validation.passed ? index : latest
  ), -1);
  return validations
    .slice(latestPassedIndex + 1)
    .filter((validation) => validation && validation.passed !== true)
    .slice(-MAX_FAILURE_CONTEXT_ITEMS);
}

/**
 * @param {Record<string, any>} summary
 */
function formatStatusSummary(summary) {
  return `total=${summary.total}, pending=${summary.pending}, in_progress=${summary.in_progress}, completed=${summary.completed}, cancelled=${summary.cancelled}`;
}

/**
 * @param {Record<string, any>} validation
 * @param {number} index
 */
function formatValidationFailure(validation, index) {
  const context = validation.failureContext ?? {};
  const lines = [
    `${index + 1}. id=${validation.id ?? `validation-${index + 1}`}, tool=${validation.toolName ?? "shell"}, commandCategory=${context.commandCategory ?? "shell"}, exit=${validation.exitCode ?? "null"}, timedOut=${Boolean(validation.timedOut)}, durationMs=${validation.durationMs ?? "unknown"}, stdoutBytes=${validation.stdoutBytes ?? 0}, stderrBytes=${validation.stderrBytes ?? 0}`
  ];

  if (context.stderrExcerpt) {
    lines.push("   stderr excerpt:");
    lines.push(indentBlock(context.stderrExcerpt));
  }
  if (context.stdoutExcerpt) {
    lines.push("   stdout excerpt:");
    lines.push(indentBlock(context.stdoutExcerpt));
  }
  if (!context.stderrExcerpt && !context.stdoutExcerpt) {
    lines.push("   output excerpt: unavailable or empty");
  }

  return lines;
}

/**
 * @param {Record<string, any>} validation
 */
function buildFailureContext(validation) {
  return {
    commandCategory: classifyValidationCommand(String(validation.command ?? "")),
    stdoutExcerpt: buildRedactedExcerpt(validation.stdout),
    stderrExcerpt: buildRedactedExcerpt(validation.stderr),
    stdoutTruncated: Boolean(validation.stdoutTruncated),
    stderrTruncated: Boolean(validation.stderrTruncated)
  };
}

/**
 * @param {unknown} value
 */
function buildRedactedExcerpt(value) {
  const redacted = redactValidationText(String(value ?? "")).trim();
  if (!redacted) {
    return "";
  }
  return redacted.length <= MAX_FAILURE_OUTPUT_CHARS
    ? redacted
    : `${redacted.slice(0, MAX_FAILURE_OUTPUT_CHARS)}\n[truncated]`;
}

/**
 * @param {string} command
 */
function classifyValidationCommand(command) {
  const trimmed = redactValidationText(command).trim().slice(0, MAX_FAILURE_COMMAND_CHARS);
  if (/^npm\s+(test|run\s+test)\b/i.test(trimmed)) {
    return "npm-test";
  }
  if (/^node\s+--test\b/i.test(trimmed)) {
    return "node-test";
  }
  if (/^(pytest|python\s+-m\s+pytest)\b/i.test(trimmed)) {
    return "pytest";
  }
  if (/^go\s+test\b/i.test(trimmed)) {
    return "go-test";
  }
  if (/^cargo\s+test\b/i.test(trimmed)) {
    return "cargo-test";
  }
  if (/^(mvn|gradle)\s+test\b/i.test(trimmed)) {
    return "jvm-test";
  }
  if (/^(git|rg|grep|Get-ChildItem|Get-Content|Get-Location)\b/i.test(trimmed)) {
    return "readonly-check";
  }
  return "shell";
}

/**
 * @param {string} value
 */
function redactValidationText(value) {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]")
    .replace(/(^|[\s"'`])(--?(?:api-?key|token|secret|password|credential|authorization)(?:=|\s+))\S+/gi, "$1$2[redacted]")
    .replace(/\b([A-Za-z0-9_.-]*(?:api[-_]?key|token|secret|password|credential|authorization)[A-Za-z0-9_.-]*\s*(?:=|:|\bis\b)\s*)\S+/gi, "$1[redacted]")
    .replace(/([?&](?:api[-_]?key|token|secret|password|credential|authorization)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/\b(?:Write-Error|Write-Output|printf|echo)\b/gi, "[command]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]");
}

/**
 * @param {string} text
 */
function indentBlock(text) {
  return text.split(/\r?\n/).map((line) => `     ${line}`).join("\n");
}
