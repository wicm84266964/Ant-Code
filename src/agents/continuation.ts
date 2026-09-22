const MAX_PARTIAL_OUTPUT = 6_000;

/**
 * @param {{ profile: Record<string, any>; query: string; reason: Record<string, any>; budget: Record<string, any>; tools: Array<Record<string, any>>; contextPack?: Record<string, any>; model?: string; mode?: string }} options
 */
type ContinuationTool = {
  ok?: boolean;
  truncated?: boolean;
  name?: string;
  inputSummary?: string;
  [key: string]: unknown;
};

export function createPartialSubagentResult(options: {
  profile: { name?: string; mode?: unknown; [key: string]: unknown };
  query: string;
  reason: { kind?: string; message?: string; [key: string]: unknown };
  budget: Record<string, unknown>;
  tools: ContinuationTool[];
  contextPack?: Record<string, unknown>;
  model?: string;
  mode?: string;
}) {
  const completed = summarizeCompletedTools(options.tools);
  const remaining = [
    "根据 continuationPrompt 继续未完成的调查或实现。",
    "优先避免重复已经完成的工具步骤。",
    options.reason?.kind === "maxOutputBytes"
      ? "继续时先用 grep/glob 缩小范围，再 read_file 小片段，不要重复读取整文件。"
      : null,
    options.reason?.kind === "contextOverflow"
      ? "继续时把剩余工作拆成更小的检索或阅读批次，不要在一次子任务里堆整份大文件。"
      : null,
    options.reason?.kind === "webSearchUnavailable"
      ? "配置可用的 SearXNG/搜索 MCP，或让主智能体改用已有知识和可访问 URL。"
      : null
  ].filter(Boolean);
  const continuationPrompt = [
    `继续这个 ${options.profile.name} 子任务。`,
    "",
    "原始任务：",
    options.query,
    "",
    "预算暂停原因：",
    options.reason.message,
    remaining.length ? `\n继续约束：\n${remaining.map((item) => `- ${item}`).join("\n")}` : "",
    "",
    "已完成摘要：",
    completed.length ? completed.map((item) => `- ${item}`).join("\n") : "- 尚无成功工具结果。",
    "",
    "请从 remaining 工作继续，避免重复已完成步骤，并返回结构化阶段结果。"
  ].join("\n");
  const partial = {
    type: "partial",
    status: "budget-exhausted",
    completed,
    evidence: summarizeEvidence(options.tools),
    remaining,
    recommendedContinuationPrompt: continuationPrompt,
    stateHints: {
      filesInspected: extractToolNames(options.tools, ["read_file", "grep", "glob", "list_files"]),
      commandsRun: extractToolNames(options.tools, ["powershell", "bash"]),
      nextSearches: []
    }
  };
  const output = formatPartialOutput(partial, options.reason);
  return {
    ok: true,
    partial: true,
    status: "partial",
    profile: options.profile.name,
    mode: options.mode ?? options.profile.mode,
    modelDriven: true,
    model: options.model,
    query: options.query,
    output,
    outputTruncated: output.length > MAX_PARTIAL_OUTPUT,
    partialResult: partial,
    continuationPrompt,
    budget: options.budget,
    budgetExceeded: options.reason,
    tools: options.tools
  };
}

export function createInterruptedSubagentResult(options: {
  profile: { name?: string; mode?: unknown; [key: string]: unknown };
  query: string;
  reason?: { code?: string; message?: string; [key: string]: unknown };
  tools?: ContinuationTool[];
  draftText?: unknown;
  draftThinkingBytes?: unknown;
  model?: string;
  mode?: string;
  interrupted?: boolean;
}) {
  const interrupted = options.interrupted !== false;
  const completed = summarizeCompletedTools(options.tools ?? []);
  const draftText = String(options.draftText ?? "").trim();
  const thinkingBytes = Number(options.draftThinkingBytes);
  const reason = options.reason && typeof options.reason === "object"
    ? options.reason
    : { code: "AGENT_INTERRUPTED", message: "Subagent was interrupted." };
  const message = String(reason.message ?? "Subagent was interrupted.");
  const continuationPrompt = [
    `继续这个 ${options.profile.name} 子任务。`,
    "",
    "原始任务：",
    options.query,
    "",
    "中断原因：",
    message,
    "",
    "已完成摘要：",
    completed.length ? completed.map((item) => `- ${item}`).join("\n") : "- 尚无成功工具结果。",
    "",
    draftText ? "中断时已有可见草稿，请在此基础上继续，不要从头重做。" : "中断时没有可见正文草稿。",
    "",
    "请从 remaining 工作继续，避免重复已完成步骤，并返回结构化阶段结果。"
  ].join("\n");
  const output = formatInterruptedOutput({
    message,
    completed,
    draftText,
    thinkingBytes: Number.isFinite(thinkingBytes) && thinkingBytes > 0 ? thinkingBytes : 0
  });
  return {
    ok: false,
    interrupted,
    status: interrupted ? "interrupted" : "failed",
    profile: options.profile.name,
    mode: options.mode ?? options.profile.mode,
    modelDriven: true,
    model: options.model,
    query: options.query,
    output,
    outputFull: output,
    outputTruncated: output.length > MAX_PARTIAL_OUTPUT,
    continuationPrompt,
    tools: options.tools ?? [],
    error: {
      code: String(reason.code ?? "AGENT_INTERRUPTED"),
      message
    }
  };
}

function formatInterruptedOutput(options: {
  message: string;
  completed: string[];
  draftText: string;
  thinkingBytes: number;
}) {
  const text = [
    "子智能体已中断",
    "",
    `原因：${options.message}`,
    "",
    "已完成工具：",
    ...(options.completed.length ? options.completed.map((item) => `- ${item}`) : ["- 尚无成功工具结果。"]),
    "",
    options.draftText
      ? `中断草稿（非最终回复）：\n${options.draftText}`
      : options.thinkingBytes > 0
        ? `中断草稿：无可见正文。内部思考已产生 ${options.thinkingBytes} 字节，未作为可见正文保留。`
        : "中断草稿：无可见正文。",
    "",
    "主控稍后读取该任务记录即可捡回上述内容。可用 /agents continue <task-id> 继续。"
  ].join("\n");
  return text.length <= MAX_PARTIAL_OUTPUT ? text : `${text.slice(0, MAX_PARTIAL_OUTPUT)}\n...[interrupted output truncated]`;
}

function summarizeCompletedTools(tools: ContinuationTool[] = []) {
  return tools
    .filter((tool) => tool.ok === true)
    .slice(-12)
    .map((tool) => `${tool.name} 完成${tool.inputSummary ? ` (${tool.inputSummary})` : ""}`);
}

function summarizeEvidence(tools: ContinuationTool[] = []) {
  return tools
    .filter((tool) => tool.ok === true || tool.truncated === true)
    .slice(-12)
    .map((tool) => `${tool.name}: ${tool.ok === true ? "ok" : "truncated"}${tool.inputSummary ? `; ${tool.inputSummary}` : ""}`);
}

function extractToolNames(tools: ContinuationTool[] = [], names: string[] = []) {
  const allowed = new Set(names);
  return tools
    .filter((tool): tool is ContinuationTool & { name: string } => typeof tool.name === "string" && allowed.has(tool.name))
    .slice(-20)
    .map((tool) => tool.name);
}

function formatPartialOutput(
  partial: { completed: string[]; remaining: Array<string | null> },
  reason: { message?: string }
) {
  const text = [
    "子智能体阶段性暂停",
    "",
    `原因：${reason.message}`,
    "",
    "已完成：",
    ...(partial.completed.length ? partial.completed.map((item: string) => `- ${item}`) : ["- 尚无成功工具结果。"]),
    "",
    "剩余：",
    ...partial.remaining.map((item: string | null) => `- ${item}`),
    "",
    "可使用 /agents continue <task-id> 继续此任务。"
  ].join("\n");
  return text.length <= MAX_PARTIAL_OUTPUT ? text : `${text.slice(0, MAX_PARTIAL_OUTPUT)}\n...[partial output truncated]`;
}
