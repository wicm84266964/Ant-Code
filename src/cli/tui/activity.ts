import type { TuiActivity, TuiRuntimeEvent } from "./types.ts";

export function initialActivity(session: { config: { lab?: { gatewayUrl?: string | null } } }): TuiActivity {
  return {
    status: "idle",
    gateway: session.config.lab?.gatewayUrl ? "configured" : "missing",
    lastGateway: "无",
    lastTool: "无",
    lastTurn: "无",
    toolCount: 0,
    blockedTools: 0,
    failedTools: 0,
    approvalCount: 0,
    questionCount: 0,
    assistantBytes: 0,
    streamBytes: 0,
    thinkingBytes: 0,
    eventCount: 0
  };
}

export function updateActivity(current: TuiActivity, event: TuiRuntimeEvent): TuiActivity {
  if (event.type === "turn_start") {
    return {
      ...current,
      status: "工作中",
      lastTurn: `轮次 ${event.turnIndex}`,
      streamBytes: 0,
      thinkingBytes: 0
    };
  }
  if (event.type === "gateway_request_start") {
    return {
      ...current,
      status: "等待模型",
      gateway: "请求中",
      lastGateway: `第 ${event.round} 轮：约 ${formatCompactTokenCount(event.promptTokensEstimate)} tokens`,
      promptTokens: event.promptTokensEstimate,
      promptBytes: event.promptBytesEstimate,
      promptMessageTokens: event.promptMessageTokensEstimate,
      promptToolSchemaTokens: event.promptToolSchemaTokensEstimate,
      promptToolResultTokens: event.promptToolResultTokensEstimate
    };
  }
  if (event.type === "gateway_response") {
    const usage = formatGatewayUsageBrief(event.usage);
    return {
      ...current,
      gateway: "已响应",
      lastGateway: `第 ${event.round} 轮：${event.toolCallCount} 个工具调用${usage ? `，Provider ${usage}` : ""}`
    };
  }
  if (event.type === "gateway_stream_start") {
    return {
      ...current,
      gateway: "流式输出",
      lastGateway: `第 ${event.round} 轮：进行中`
    };
  }
  if (event.type === "assistant_thinking_delta") {
    return {
      ...current,
      status: current.status === "生成回答" ? "生成回答" : "思考中",
      thinkingBytes: current.thinkingBytes + (event.bytes ?? Buffer.byteLength(String(event.text ?? ""), "utf8"))
    };
  }
  if (event.type === "assistant_delta") {
    return {
      ...current,
      status: "生成回答",
      streamBytes: current.streamBytes + (event.bytes ?? Buffer.byteLength(String(event.text ?? ""), "utf8"))
    };
  }
  if (event.type === "tool_call_delta") {
    const label = event.nameDelta || event.id || `tool#${Number(event.index ?? 0) + 1}`;
    return { ...current, status: "准备工具", lastTool: `${label} 生成中` };
  }
  if (event.type === "gateway_stream_stop") {
    return {
      ...current,
      gateway: "流式完成",
      lastGateway: `第 ${event.round} 轮：${event.stopReason ?? "done"}`
    };
  }
  if (event.type === "gateway_retry") {
    return {
      ...current,
      status: "网关重试",
      gateway: "重试中",
      lastGateway: `第 ${event.round ?? "?"} 轮：${event.attempt ?? "?"}/${event.maxAttempts ?? "?"}`
    };
  }
  if (event.type === "tool_start") {
    return { ...current, status: "运行工具", lastTool: `${event.name} 运行中` };
  }
  if (event.type === "tool_finish") {
    return {
      ...current,
      status: event.interrupted ? "工具已中断" : event.ok ? "工具完成" : event.blocked ? "工具被阻止" : "工具失败",
      lastTool: `${event.name} ${event.interrupted ? "interrupted" : event.ok ? "done" : event.blocked ? "blocked" : "failed"}`,
      toolCount: current.toolCount + 1,
      blockedTools: current.blockedTools + (event.blocked ? 1 : 0),
      failedTools: current.failedTools + (!event.ok && !event.blocked && !event.interrupted ? 1 : 0)
    };
  }
  if (event.type === "review_gate") {
    return { ...current, status: "等待复核", lastTool: "review gate" };
  }
  if (event.type === "assistant_final") {
    return { ...current, status: "就绪", assistantBytes: event.outputBytes ?? current.assistantBytes };
  }
  if (event.type === "turn_interrupted") {
    return { ...current, status: "已中断", lastTurn: "已中断" };
  }
  if (event.type === "gateway_error") {
    return {
      ...current,
      status: "网关错误",
      gateway: "错误",
      lastGateway: event.error?.code ?? "GATEWAY_ERROR"
    };
  }
  if (event.type === "gateway_not_configured") {
    return { ...current, status: "网关缺失", gateway: "缺失", lastGateway: "未配置" };
  }
  if (event.type === "turn_complete") {
    return { ...current, status: "就绪", lastTurn: event.status ?? current.lastTurn };
  }
  return current;
}

export function formatCompactTokenCount(value: unknown) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return "?";
  }
  if (number >= 1000000) {
    return `${Math.round(number / 100000) / 10}M`;
  }
  if (number >= 1000) {
    return `${Math.round(number / 100) / 10}k`;
  }
  return String(number);
}

export function formatGatewayUsageBrief(usage: Record<string, unknown> | null | undefined = {}) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    return "";
  }
  const prompt = firstFiniteUsage(usage, ["prompt_tokens", "input_tokens", "promptTokens", "inputTokens"]);
  const completion = firstFiniteUsage(usage, ["completion_tokens", "output_tokens", "completionTokens", "outputTokens"]);
  const total = firstFiniteUsage(usage, ["total_tokens", "totalTokens"]);
  const parts = [
    Number.isFinite(prompt) ? `输入 ${formatCompactTokenCount(prompt)}` : null,
    Number.isFinite(completion) ? `输出 ${formatCompactTokenCount(completion)}` : null,
    Number.isFinite(total) ? `合计 ${formatCompactTokenCount(total)}` : null
  ].filter(Boolean);
  return parts.length > 0 ? `${parts.join(" / ")} tokens` : "";
}

export function firstFiniteUsage(usage: Record<string, unknown>, keys: readonly string[]) {
  for (const key of keys) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

export function agentTaskTitle(status: string) {
  if (status === "queued") {
    return "子任务排队中";
  }
  if (status === "running") {
    return "子任务后台运行中";
  }
  if (status === "completed") {
    return "子任务完成";
  }
  if (status === "partial") {
    return "子任务阶段暂停";
  }
  if (status === "blocked") {
    return "子任务被阻止";
  }
  if (status === "interrupted" || status === "cancelled") {
    return "子任务已中断";
  }
  return "子任务失败";
}

export function agentTaskStatusLabel(status: string) {
  if (status === "queued") {
    return "排队中";
  }
  if (status === "completed") {
    return "已完成";
  }
  if (status === "partial") {
    return "阶段暂停，可继续";
  }
  if (status === "blocked") {
    return "被权限策略阻止";
  }
  if (status === "interrupted") {
    return "已中断";
  }
  if (status === "cancelled") {
    return "已取消";
  }
  if (status === "running") {
    return "运行中";
  }
  return "失败";
}

export function truncatePlainText(value: unknown, max: number = 240) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3))}...`;
}
