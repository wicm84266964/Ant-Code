const MAX_PARTIAL_OUTPUT = 6_000;

/**
 * @param {{ profile: Record<string, any>; query: string; reason: Record<string, any>; budget: Record<string, any>; tools: Array<Record<string, any>>; contextPack?: Record<string, any>; model?: string; mode?: string }} options
 */
export function createPartialSubagentResult(options) {
  const completed = summarizeCompletedTools(options.tools);
  const remaining = [
    "根据 continuationPrompt 继续未完成的调查或实现。",
    "优先避免重复已经完成的工具步骤。",
    options.reason?.kind === "maxOutputBytes"
      ? "继续时先用 grep/glob 缩小范围，再 read_file 小片段，不要重复读取整文件。"
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

function summarizeCompletedTools(tools) {
  return tools
    .filter((tool) => tool.ok === true)
    .slice(-12)
    .map((tool) => `${tool.name} 完成${tool.inputSummary ? ` (${tool.inputSummary})` : ""}`);
}

function summarizeEvidence(tools) {
  return tools
    .filter((tool) => tool.ok === true || tool.truncated === true)
    .slice(-12)
    .map((tool) => `${tool.name}: ${tool.ok === true ? "ok" : "truncated"}${tool.inputSummary ? `; ${tool.inputSummary}` : ""}`);
}

function extractToolNames(tools, names) {
  const allowed = new Set(names);
  return tools
    .filter((tool) => allowed.has(tool.name))
    .slice(-20)
    .map((tool) => tool.name);
}

function formatPartialOutput(partial, reason) {
  const text = [
    "子智能体阶段性暂停",
    "",
    `原因：${reason.message}`,
    "",
    "已完成：",
    ...(partial.completed.length ? partial.completed.map((item) => `- ${item}`) : ["- 尚无成功工具结果。"]),
    "",
    "剩余：",
    ...partial.remaining.map((item) => `- ${item}`),
    "",
    "可使用 /agents continue <task-id> 继续此任务。"
  ].join("\n");
  return text.length <= MAX_PARTIAL_OUTPUT ? text : `${text.slice(0, MAX_PARTIAL_OUTPUT)}\n...[partial output truncated]`;
}
