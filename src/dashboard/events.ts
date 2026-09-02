const TOOL_LABELS: Readonly<Record<string, string>> = Object.freeze({
  read_file: "读取文件",
  list_files: "列出文件",
  glob: "查找文件",
  grep: "搜索文本",
  git_status: "检查 Git 状态",
  git_diff: "查看 Git 差异",
  write_file: "写入文件",
  edit_file: "编辑文件",
  powershell: "运行 PowerShell",
  bash: "运行 Shell",
  background_shell: "启动后台终端",
  web_fetch: "访问网页",
  web_search: "搜索网页",
  document_intake: "读取文档",
  mcp_call: "调用 MCP 工具",
  mcp_list: "列出 MCP 能力",
  agent_run: "启动子智能体",
  todo_write: "更新任务清单",
  plan_update: "更新计划"
});

const SEVERITY_BY_STATUS: Readonly<Record<string, string>> = Object.freeze({
  running: "info",
  completed: "success",
  blocked: "warning",
  interrupted: "warning",
  failed: "danger",
  waiting: "warning"
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

const BLOCKED_TURN_STATUSES = new Set(["gateway_not_configured", "tool_limit", "vision_unavailable", "context_overflow"]);
const INTERRUPTED_TURN_STATUSES = new Set(["interrupted", "cancelled"]);
const FAILED_BACKGROUND_STATUSES = new Set(["failed", "error", "lost"]);
const BLOCKED_BACKGROUND_STATUSES = new Set(["blocked", "partial"]);
const INTERRUPTED_BACKGROUND_STATUSES = new Set(["interrupted", "cancelled"]);

/**
 * @param {Record<string, any>} event
 */
export function mapSessionEventToDashboard(event: Record<string, unknown>) {
  if (!event || typeof event !== "object") {
    return [];
  }
  const type = String(event.type ?? "");
  if (type === "turn_start") {
    return [activity("turn-start", "开始任务", "正在准备本轮请求", "running", "session", event, { coalesceKey: "turn" })];
  }
  if (type === "gateway_request_start") {
    return [activity("gateway-request", "正在请求模型", roundDetail(event), "running", "gateway", event, { coalesceKey: "gateway" })];
  }
  if (type === "gateway_retry") {
    return [activity("gateway-retry", "网关重试中", gatewayRetryDetail(event), "running", "gateway", event, {
      coalesceKey: "gateway",
      retryAttempt: Number.isFinite(event.attempt) ? event.attempt : null,
      retryMaxAttempts: Number.isFinite(event.maxAttempts) ? event.maxAttempts : null,
      retryDelayMs: Number.isFinite(event.delayMs) ? event.delayMs : null,
      retryStage: event.stage ?? null,
      retryCode: asRecord(event.error).code ?? null
    })];
  }
  if (type === "gateway_stream_start") {
    return [activity("assistant-stream", "正在生成回复", "模型已开始返回内容", "running", "gateway", event, { coalesceKey: "assistant-stream" })];
  }
  if (type === "assistant_thinking_delta") {
    return [activity("assistant-thinking", "正在分析任务", "思考过程已隐藏，仅展示执行状态", "running", "gateway", event, { coalesceKey: "thinking" })];
  }
  if (type === "assistant_delta" || type === "assistant_text_delta") {
    const payload = asRecord(event.payload);
    const text = String(event.text ?? payload.text ?? "");
    if (!text) {
      return [];
    }
    return [{
      type: "assistant_draft",
      id: event.id ?? `${Date.now()}:${Math.random().toString(16).slice(2)}:assistant-draft`,
      round: Number.isFinite(event.round) ? event.round : Number.isFinite(payload.round) ? payload.round : null,
      text,
      bytes: event.bytes ?? payload.bytes ?? Buffer.byteLength(text, "utf8"),
      at: event.at ?? new Date().toISOString()
    }];
  }
  if (type === "tool_calls_requested") {
    const count = Array.isArray(event.toolCalls) ? event.toolCalls.length : 0;
    return [activity("tool-plan", `准备执行 ${count} 个工具`, toolCallNames(event.toolCalls), "running", "tool", event, { coalesceKey: "tool-plan" })];
  }
  if (type === "tool_start") {
    return [activity(`tool-start:${event.toolCallId ?? event.name ?? ""}`, `正在${toolLabel(event.name)}`, toolDetail(event), "running", "tool", event, {
      toolUseId: event.toolCallId ?? null,
      toolName: event.name ?? null,
      profile: event.profile ?? null,
      coalesceKey: event.toolCallId ? `tool:${event.toolCallId}` : `tool:${event.name ?? "unknown"}`
    })];
  }
  if (type === "tool_finish") {
    const status = event.blocked ? "blocked" : event.ok ? "completed" : "failed";
    return [activity(`tool-result:${event.toolCallId ?? event.name ?? ""}`, `${toolLabel(event.name)}${statusLabel(status)}`, toolResultDetail(event), status, "tool", event, {
      toolUseId: event.toolCallId ?? null,
      toolName: event.name ?? null,
      profile: event.profile ?? null,
      taskStatus: event.taskStatus ?? null,
      outputSummary: event.outputSummary ?? null,
      changeStats: normalizeChangeStats(event.changeStats),
      turnChangeStats: normalizeChangeStats(event.turnChangeStats, { allowEmpty: true }),
      coalesceKey: event.toolCallId ? `tool:${event.toolCallId}` : `tool:${event.name ?? "unknown"}`
    })];
  }
  if (type === "workflow_updated") {
    return [activity("workflow-updated", "任务状态已同步", `已完成 ${event.todosCompleted ?? 0} 个待办、${event.planStepsCompleted ?? 0} 个计划步骤`, "completed", "session", event, { coalesceKey: "workflow" })];
  }
  if (type === "subagent_group_started") {
    return [backgroundSubagentActivity(event, {
      title: "子智能体后台运行中",
      status: "running",
      detail: backgroundSubagentStartedDetail(event)
    })];
  }
  if (type === "background_terminal_started") {
    return [activity("background-terminal-started", "终端后台任务运行中", backgroundTerminalStartedDetail(event), "running", "tool", event, {
      backgroundSubagent: true,
      kind: "terminal",
      taskId: typeof event.taskId === "string" ? event.taskId : null,
      cancellable: true,
      coalesceKey: `background-terminal:${event.taskId ?? "unknown"}`
    })];
  }
  if (type === "background_terminal_registered") {
    return [activity("background-terminal-registered", "终端后台任务启动中", backgroundTerminalStartedDetail(event), "starting", "tool", event, {
      backgroundSubagent: true,
      kind: "terminal",
      taskId: typeof event.taskId === "string" ? event.taskId : null,
      cancellable: true,
      coalesceKey: `background-terminal:${event.taskId ?? "unknown"}`
    })];
  }
  if (type === "subagent_group_progress") {
    const status = backgroundProgressStatus(event);
    return [backgroundSubagentActivity(event, {
      title: backgroundProgressTitle(status),
      status,
      detail: String(event.summary ?? ""),
      completed: event.completed === true
    })];
  }
  if (type === "subagent_group_wakeup") {
    return [backgroundSubagentActivity(event, {
      title: "等待子智能体唤醒主控",
      status: "waiting",
      detail: String(event.summary ?? ""),
      completed: true,
      wakePromptQueued: true,
      wakePromptBytes: Buffer.byteLength(String(event.wakePrompt ?? ""), "utf8")
    })];
  }
  if (type === "assistant_final") {
    return [{
      type: "assistant_final",
      text: String(event.text ?? ""),
      bytes: event.outputBytes ?? Buffer.byteLength(String(event.text ?? ""), "utf8")
    }];
  }
  if (type === "turn_complete") {
    const completion = turnCompletionView(event.status);
    return [activity("turn-complete", completion.title, completion.detail, completion.status, "session", event, {
      coalesceKey: "turn",
      terminalStatus: completion.terminalStatus
    })];
  }
  if (type === "gateway_error" || type === "gateway_not_configured") {
    return [activity("gateway-error", "模型请求失败", asRecord(event.error).message ?? "网关未配置或请求失败", "failed", "gateway", event, { coalesceKey: "gateway" })];
  }
  if (type === "turn_interrupted") {
    return [activity("turn-interrupted", "任务已中断", event.reason ?? "用户中断", "interrupted", "session", event)];
  }
  if (type === "context_overflow") {
    return [activity(
      "context-overflow",
      "上下文超出窗口",
      "压缩后仍超过上限，已取消本轮请求，避免网关返回 400",
      "blocked",
      "session",
      event,
      { coalesceKey: "context-compaction" }
    )];
  }
  if (type === "context_compacting") {
    return [activity("context-compacting", "正在压缩上下文", contextCompactionStartDetail(event), "running", "session", event, { coalesceKey: "context-compaction" })];
  }
  if (type === "context_compacted") {
    return [
      activity("context-compacted", "上下文已压缩", contextCompactionDetail(event), "completed", "session", event, { coalesceKey: "context-compaction" }),
      {
        type: "context_boundary",
        id: event.id ?? `${Date.now()}:${Math.random().toString(16).slice(2)}:context-boundary`,
        title: "聊天内容已压缩",
        detail: "以下回复基于压缩后的上下文继续",
        reason: event.reason ?? null,
        beforeMessages: Number.isFinite(event.beforeMessages) ? event.beforeMessages : null,
        afterMessages: Number.isFinite(event.afterMessages) ? event.afterMessages : null,
        beforeTokens: Number.isFinite(event.beforeTokens) ? event.beforeTokens : null,
        afterTokens: Number.isFinite(event.afterTokens) ? event.afterTokens : null,
        summaryBytes: Number.isFinite(event.summaryBytes) ? event.summaryBytes : null,
        strategy: event.strategy ?? null,
        at: event.at ?? new Date().toISOString()
      }
    ];
  }
  return [];
}

function turnCompletionView(value: unknown) {
  const terminalStatus = String(value ?? "completed").trim().toLowerCase() || "completed";
  if (terminalStatus === "completed") {
    return { title: "任务已完成", detail: "状态：completed", status: "completed", terminalStatus };
  }
  if (INTERRUPTED_TURN_STATUSES.has(terminalStatus)) {
    return { title: "任务已中断", detail: `状态：${terminalStatus}`, status: "interrupted", terminalStatus };
  }
  if (BLOCKED_TURN_STATUSES.has(terminalStatus)) {
    return { title: "任务未完成", detail: `状态：${terminalStatus}`, status: "blocked", terminalStatus };
  }
  return { title: "任务执行失败", detail: `状态：${terminalStatus}`, status: "failed", terminalStatus };
}

function backgroundProgressStatus(event: Record<string, unknown>) {
  if (event?.completed !== true) {
    return "running";
  }
  const status = String(event.status ?? "completed").trim().toLowerCase();
  if (FAILED_BACKGROUND_STATUSES.has(status)) {
    return "failed";
  }
  if (BLOCKED_BACKGROUND_STATUSES.has(status)) {
    return "blocked";
  }
  if (INTERRUPTED_BACKGROUND_STATUSES.has(status)) {
    return "interrupted";
  }
  return "completed";
}

function backgroundProgressTitle(status: string) {
  if (status === "running") return "子任务组仍在运行";
  if (status === "completed") return "子任务组已完成";
  if (status === "interrupted") return "子任务组已中断";
  if (status === "blocked") return "子任务组未全部完成";
  return "子任务组执行失败";
}

/**
 * @param {Record<string, any>} request
 */
export function permissionRequestToActivity(request: Record<string, unknown>) {
  return activity("approval-required", "等待权限确认", permissionSummary(request), "waiting", "permission", request);
}

type BackgroundSubagentOptions = {
  title: string;
  status: string;
  detail?: unknown;
  completed?: boolean;
  wakePromptQueued?: boolean;
  wakePromptBytes?: unknown;
};

function activity(id: string, title: unknown, detail: unknown, status: unknown, source: string, raw: unknown, extra: Record<string, unknown> = {}) {
  const rawRecord = asRecord(raw);
  const statusKey = String(status ?? "");
  return {
    type: "activity",
    id: `${Date.now()}:${Math.random().toString(16).slice(2)}:${id}`,
    title,
    detail: String(detail ?? ""),
    status,
    source,
    severity: SEVERITY_BY_STATUS[statusKey] ?? "info",
    at: rawRecord.at ?? new Date().toISOString(),
    rawType: rawRecord.type ?? null,
    collapsed: status !== "running",
    ...extra
  };
}

function backgroundSubagentActivity(event: Record<string, unknown>, options: BackgroundSubagentOptions) {
  const groupId = typeof event.groupId === "string" && event.groupId.trim() ? event.groupId.trim() : null;
  const taskId = typeof event.taskId === "string" && event.taskId.trim() ? event.taskId.trim() : null;
  const profile = typeof event.profile === "string" && event.profile.trim() ? event.profile.trim() : null;
  return activity(`subagent-group:${groupId ?? taskId ?? "unknown"}`, options.title, options.detail, options.status, "subagent", event, {
    backgroundSubagent: true,
    groupId,
    taskId,
    profile,
    waitFor: event.waitFor ?? null,
    wakeParent: typeof event.wakeParent === "boolean" ? event.wakeParent : null,
    completed: options.completed === true,
    summary: typeof event.summary === "string" ? event.summary : "",
    wakePromptQueued: options.wakePromptQueued === true,
    wakePromptBytes: Number.isFinite(options.wakePromptBytes) ? options.wakePromptBytes : null,
    coalesceKey: `subagent-group:${groupId ?? taskId ?? "unknown"}`
  });
}

function roundDetail(event: Record<string, unknown>) {
  const parts = [
    Number.isFinite(event.round) ? `round ${event.round}` : null,
    Number.isFinite(event.messageCount) ? `${event.messageCount} 条消息` : null,
    Number.isFinite(event.toolSchemaCount) ? `${event.toolSchemaCount} 个工具定义` : null
  ].filter(Boolean);
  return parts.join(" · ");
}

function gatewayRetryDetail(event: Record<string, unknown>) {
  const parts = [
    Number.isFinite(event.round) ? `round ${event.round}` : null,
    Number.isFinite(event.attempt) && Number.isFinite(event.maxAttempts) ? `第 ${event.attempt}/${event.maxAttempts} 次` : null,
    asRecord(event.error).code ? String(asRecord(event.error).code) : null,
    event.stage ? `阶段 ${event.stage}` : null,
    Number.isFinite(event.delayMs) ? `${event.delayMs}ms 后重试` : null
  ].filter(Boolean);
  return parts.join(" · ") || "网关响应异常，正在自动重试";
}

function backgroundSubagentStartedDetail(event: Record<string, unknown>) {
  const parts = [
    event.profile ? `profile=${event.profile}` : null,
    event.groupId ? `group=${event.groupId}` : null,
    event.waitFor ? `waitFor=${event.waitFor}` : null,
    event.wakeParent === false ? "完成后仅记录结果" : "完成后自动唤醒主控"
  ].filter(Boolean);
  return parts.join(" · ");
}

function backgroundTerminalStartedDetail(event: Record<string, unknown>) {
  const parts = [
    event.taskId ? `task=${event.taskId}` : null,
    event.pid ? `pid=${event.pid}` : null,
    event.stdoutPath ? `stdout=${event.stdoutPath}` : null
  ].filter(Boolean);
  return parts.join(" · ");
}

function contextCompactionStartDetail(event: Record<string, unknown>) {
  const parts = [
    Number.isFinite(event.beforeTokens) ? `约 ${formatTokenCount(event.beforeTokens)} tokens` : null,
    Number.isFinite(event.maxTokens) ? `阈值 ${formatTokenCount(event.maxTokens)}` : null,
    Number.isFinite(event.beforeMessages) ? `${event.beforeMessages} 条消息` : null
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "正在整理较早聊天内容";
}

function contextCompactionDetail(event: Record<string, unknown>) {
  const messagePart = `整理前 ${event.beforeMessages ?? "-"} 条，整理后 ${event.afterMessages ?? "-"} 条`;
  const tokenPart = Number.isFinite(event.beforeTokens) && Number.isFinite(event.afterTokens)
    ? `tokens ${formatTokenCount(event.beforeTokens)} -> ${formatTokenCount(event.afterTokens)}`
    : null;
  const summaryPart = Number.isFinite(event.summaryBytes) ? `摘要 ${event.summaryBytes} 字节` : null;
  return [messagePart, tokenPart, summaryPart].filter(Boolean).join(" · ");
}

function formatTokenCount(value: unknown) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return "--";
  }
  if (number >= 1000000) {
    return `${trimNumber(number / 1000000)}M`;
  }
  if (number >= 1000) {
    return `${trimNumber(number / 1000)}k`;
  }
  return String(Math.round(number));
}

function trimNumber(value: number) {
  return value >= 10 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
}

function toolCallNames(toolCalls: unknown) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return "";
  }
  return toolCalls.map((call) => toolLabel(asRecord(call).name)).join("、");
}

export function toolLabel(name: unknown) {
  return (typeof name === "string" ? TOOL_LABELS[name] : undefined) ?? String(name ?? "工具");
}

function toolDetail(event: Record<string, unknown>) {
  const keys = Array.isArray(event.inputKeys) && event.inputKeys.length > 0
    ? `输入字段：${event.inputKeys.join(", ")}`
    : "正在本机执行";
  const profile = event.profile ? ` · ${event.profile}` : "";
  return `${keys}${profile}`;
}

function toolResultDetail(event: Record<string, unknown>) {
  const parts = [
    event.blocked ? "已被权限策略阻止" : null,
    event.ok ? "执行成功" : null,
    !event.ok && !event.blocked ? event.errorCode ?? "执行失败" : null,
    Number.isFinite(event.resultBytes) ? `${event.resultBytes} 字节结果` : null,
    event.truncated ? "结果已截断" : null
  ].filter(Boolean);
  return parts.join(" · ");
}

function statusLabel(status: string) {
  if (status === "completed") {
    return "已完成";
  }
  if (status === "blocked") {
    return "被阻止";
  }
  return "失败";
}

function permissionSummary(request: Record<string, unknown>) {
  const toolName = request.toolName ?? "unknown";
  const reason = asRecord(request.decision).reason ?? "需要确认后继续";
  return `${toolLabel(toolName)} · ${reason}`;
}

type ChangeStats = {
  additions: number;
  deletions: number;
  files: number;
  redacted: boolean;
  truncated: boolean;
  approximate: boolean;
  path?: string;
};

function normalizeChangeStats(value: unknown, options: Record<string, unknown> = {}) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const stats = asRecord(value);
  const additions = nonNegativeInteger(stats.additions);
  const deletions = nonNegativeInteger(stats.deletions);
  const files = nonNegativeInteger(stats.files);
  if (!options.allowEmpty && additions === 0 && deletions === 0 && files === 0 && stats.redacted !== true) {
    return null;
  }
  const normalized: ChangeStats = {
    additions,
    deletions,
    files,
    redacted: stats.redacted === true,
    truncated: stats.truncated === true,
    approximate: stats.approximate === true
  };
  if (typeof stats.path === "string" && stats.path.trim()) {
    normalized.path = stats.path;
  }
  return normalized;
}

function nonNegativeInteger(value: unknown) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}
