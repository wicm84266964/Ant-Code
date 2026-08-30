const DEFAULT_MAX_WAKE_SUMMARY_BYTES = 12000;

type WakeGroup = {
  id?: unknown;
  parentSessionId?: unknown;
  wakeReason?: unknown;
};

type WakePromptOptions = {
  group?: WakeGroup | null;
  tasks?: unknown;
  maxBytes?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function buildSubagentGroupWakePrompt({ group, tasks = [], maxBytes = DEFAULT_MAX_WAKE_SUMMARY_BYTES }: WakePromptOptions = {}) {
  const lines = [
    "[Ant Code subagent group completed]",
    `groupId: ${group?.id ?? "unknown"}`,
    `parentSessionId: ${group?.parentSessionId ?? "unknown"}`,
    group?.wakeReason ? `wakeReason: ${group.wakeReason}` : null,
    "",
    "以下后台子任务已达到等待条件，请作为主控继续处理："
  ].filter((line) => line !== null);

  for (const task of Array.isArray(tasks) ? tasks : []) {
    const item = asRecord(task);
    const summary = summarizeTaskForWake(item);
    lines.push(`- ${item.id} ${item.profile} ${item.status}: ${summary}`);
  }

  lines.push(
    "",
    "请：",
    "1. 整合可用结果，不要原样粘贴子任务 JSON。",
    "2. 更新 todo/plan。",
    "3. 如结果不足，派发更小的后续子任务或说明需要用户确认。",
    "4. 如已满足交付条件，给出最终汇报。"
  );

  return truncateBytes(lines.join("\n"), maxBytes);
}

export function summarizeTaskForWake(task: Record<string, unknown> = {}) {
  const error = task.error;
  const candidates = [
    task.outputSummary,
    task.latestProgress,
    isRecord(error) ? error.message : undefined,
    task.output
  ];
  const text = candidates.map((item) => String(item ?? "").trim()).find(Boolean) ?? "";
  return truncateWhitespace(text, 600) || "无摘要";
}

function truncateWhitespace(value: unknown, max: number) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3))}...`;
}

function truncateBytes(value: unknown, maxBytes: unknown) {
  const text = String(value ?? "");
  const limit = typeof maxBytes === "number" && Number.isInteger(maxBytes) && maxBytes > 0
    ? maxBytes
    : DEFAULT_MAX_WAKE_SUMMARY_BYTES;
  if (Buffer.byteLength(text, "utf8") <= limit) {
    return text;
  }
  let result = "";
  for (const char of text) {
    const next = `${result}${char}`;
    if (Buffer.byteLength(next, "utf8") > limit - 32) {
      break;
    }
    result = next;
  }
  return `${result}\n...[wake prompt truncated]`;
}
