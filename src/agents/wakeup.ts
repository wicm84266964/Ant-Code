import { DEFAULT_AGENT_HANDOFF_MAX_BYTES, utf8Truncate } from "../tools/result.ts";

export const DEFAULT_MAX_WAKE_SUMMARY_BYTES = DEFAULT_AGENT_HANDOFF_MAX_BYTES;
const HANDOFF_TRUNCATION_MARKER = "...[handoff truncated; full report in .lab-agent/tasks/%s.json output]";

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
  const header = [
    "[Ant Code subagent group completed]",
    `groupId: ${group?.id ?? "unknown"}`,
    `parentSessionId: ${group?.parentSessionId ?? "unknown"}`,
    group?.wakeReason ? `wakeReason: ${group.wakeReason}` : null,
    "",
    "以下后台子任务已达到等待条件。每条任务附上完整交接报告；工具轮次仍留在任务记录里，不要去读任务 JSON。"
  ].filter((line) => line !== null).join("\n");
  const footer = [
    "",
    "请：",
    "1. 整合上方交接报告，不要原样粘贴子任务 JSON，也不要重跑已经完成的检索。",
    "2. 更新 todo/plan。",
    "3. 如结果不足，派发更小的后续子任务或说明需要用户确认。",
    "4. 如已满足交付条件，给出最终汇报。"
  ].join("\n");
  const limit = resolveWakeBudget(maxBytes);
  const footerBytes = Buffer.byteLength(footer, "utf8");
  let body = header;
  const list = Array.isArray(tasks) ? tasks : [];
  for (let index = 0; index < list.length; index += 1) {
    const task = asRecord(list[index]);
    const id = String(task.id ?? "unknown");
    const block = formatTaskHandoffBlock(task);
    const next = `${body}\n\n${block}`;
    const used = Buffer.byteLength(`${next}${footer}`, "utf8");
    if (used <= limit) {
      body = next;
      continue;
    }
    const remaining = limit - Buffer.byteLength(body, "utf8") - footerBytes - 2;
    const marker = HANDOFF_TRUNCATION_MARKER.replace("%s", id);
    if (remaining > Buffer.byteLength(marker, "utf8") + 800) {
      const heading = `### ${id} ${String(task.profile ?? "agent")} ${String(task.status ?? "unknown")}\n`;
      const reportBudget = remaining - Buffer.byteLength(heading, "utf8") - Buffer.byteLength(`\n${marker}`, "utf8");
      const report = utf8Truncate(taskHandoffReport(task), Math.max(0, reportBudget));
      body = `${body}\n\n${heading}${report}\n${marker}`;
    } else {
      body = `${body}\n\n### ${id} ${String(task.profile ?? "agent")} ${String(task.status ?? "unknown")}\n${marker}`;
    }
    for (const leftover of list.slice(index + 1)) {
      const leftoverTask = asRecord(leftover);
      const leftoverId = String(leftoverTask.id ?? "unknown");
      body = `${body}\n\n### ${leftoverId} ${String(leftoverTask.profile ?? "agent")} ${String(leftoverTask.status ?? "unknown")}\n${HANDOFF_TRUNCATION_MARKER.replace("%s", leftoverId)}`;
    }
    break;
  }
  return `${body}${footer}`;
}

export function summarizeTaskForWake(task: Record<string, unknown> = {}) {
  return taskHandoffReport(task);
}

function formatTaskHandoffBlock(task: Record<string, unknown>) {
  const id = String(task.id ?? "unknown");
  const profile = String(task.profile ?? "agent");
  const status = String(task.status ?? "unknown");
  return `### ${id} ${profile} ${status}\n${taskHandoffReport(task)}`;
}

function taskHandoffReport(task: Record<string, unknown> = {}) {
  const error = task.error;
  const candidates = [
    task.output,
    task.outputSummary,
    task.latestProgress,
    isRecord(error) ? error.message : undefined
  ];
  const text = candidates.map((item) => String(item ?? "").trim()).find(Boolean) ?? "";
  return text || "无交接报告";
}

function resolveWakeBudget(maxBytes: unknown) {
  if (typeof maxBytes === "number" && Number.isInteger(maxBytes) && maxBytes > 0) {
    return maxBytes;
  }
  return DEFAULT_MAX_WAKE_SUMMARY_BYTES;
}
