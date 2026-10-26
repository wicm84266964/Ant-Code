import { utf8Truncate } from "../tools/result.ts";
import { createAgentTaskGroupStore } from "./task-group-store.ts";
import { DEFAULT_MAX_WAKE_SUMMARY_BYTES } from "./wakeup.ts";

export const WAKE_CONTINUATION_DISPLAY = "子智能体完成，主控自动接续";
export const WAKE_CONTINUATION_PROMPT = [
  "[Ant Code subagent handoff]",
  "后台子任务已达到等待条件。交接报告会在这次模型请求前并入当前会话。",
  "请整合这些报告，不要原样粘贴子任务 JSON，也不要重跑已经完成的检索。"
].join("\n");
export const IDLE_WAKE_COALESCE_MS = 300;

export type WakeHandoff = {
  groupId: string;
  parentSessionId: string;
  cwd: string;
  wakePrompt: string;
  summary: string;
  taskId: string;
  profile: string;
  notedAt: string;
};

type IdleWakeTimer = {
  timer: ReturnType<typeof setTimeout>;
  start: () => void;
};

const batches = new Map<string, WakeHandoff[]>();
const idleTimers = new Map<string, IdleWakeTimer>();

export function noteWakeHandoff(handoff: WakeHandoff) {
  const sessionId = String(handoff.parentSessionId ?? "").trim();
  const groupId = String(handoff.groupId ?? "").trim();
  const wakePrompt = String(handoff.wakePrompt ?? "").trim();
  if (!sessionId || !groupId || !wakePrompt) {
    return false;
  }
  const current = batches.get(sessionId) ?? [];
  if (current.some((item) => item.groupId === groupId)) {
    return false;
  }
  current.push({
    groupId,
    parentSessionId: sessionId,
    cwd: String(handoff.cwd ?? ""),
    wakePrompt,
    summary: String(handoff.summary ?? ""),
    taskId: String(handoff.taskId ?? ""),
    profile: String(handoff.profile ?? ""),
    notedAt: handoff.notedAt || new Date().toISOString()
  });
  batches.set(sessionId, current);
  return true;
}

export function hasPendingWakeHandoffs(sessionId: string) {
  return pendingWakeHandoffCount(sessionId) > 0;
}

export function pendingWakeHandoffCount(sessionId: string) {
  return batches.get(String(sessionId ?? "").trim())?.length ?? 0;
}

export function takeWakeHandoffs(sessionId: string) {
  const id = String(sessionId ?? "").trim();
  const current = batches.get(id) ?? [];
  batches.delete(id);
  return current;
}

export function restoreWakeHandoffs(sessionId: string, handoffs: WakeHandoff[]) {
  const id = String(sessionId ?? "").trim();
  if (!id || handoffs.length === 0) {
    return;
  }
  const current = batches.get(id) ?? [];
  const seen = new Set(current.map((item) => item.groupId));
  const restored = handoffs.filter((item) => item.groupId && !seen.has(item.groupId));
  if (restored.length === 0 && current.length === 0) {
    return;
  }
  batches.set(id, [...restored, ...current]);
}

export function buildBatchedWakePrompt(handoffs: WakeHandoff[], maxBytes: unknown = DEFAULT_MAX_WAKE_SUMMARY_BYTES) {
  const usable = handoffs.filter((item) => item.wakePrompt.trim());
  const limit = resolveBatchBudget(maxBytes);
  if (usable.length === 0) {
    return "";
  }
  if (usable.length === 1) {
    return utf8Truncate(usable[0].wakePrompt, limit);
  }
  const header = [
    "[Ant Code subagent handoff]",
    `parentSessionId: ${usable[0].parentSessionId || "unknown"}`,
    `groups: ${usable.length}`,
    "",
    "以下后台任务组已达到等待条件，并入当前会话一次处理。不要逐条等待新的会话，不要原样粘贴子任务 JSON，也不要重跑已经完成的检索。"
  ].join("\n");
  const footer = [
    "",
    "请：",
    "1. 整合上方全部交接报告。",
    "2. 更新 todo/plan。",
    "3. 如结果不足，派发更小的后续子任务或说明需要用户确认。",
    "4. 如已满足交付条件，给出最终汇报。"
  ].join("\n");
  const sections = usable.map((item) => [
    `--- group ${item.groupId} ---`,
    item.wakePrompt
  ].join("\n"));
  return fitWakeBatch(header, sections, footer, limit);
}

export function wakeHandoffDisplay(handoffs: WakeHandoff[]) {
  const ids = handoffs.map((item) => item.groupId).filter(Boolean);
  return ids.length > 0 ? `${WAKE_CONTINUATION_DISPLAY}（${ids.join(", ")}）` : WAKE_CONTINUATION_DISPLAY;
}

export async function markWakeHandoffsConsumed(cwd: string, groupIds: string[]) {
  const root = String(cwd ?? "").trim();
  const ids = groupIds.map((id) => String(id ?? "").trim()).filter(Boolean);
  if (!root || ids.length === 0) {
    return;
  }
  const store = createAgentTaskGroupStore({ cwd: root });
  const now = new Date().toISOString();
  for (const groupId of ids) {
    try {
      await store.updateGroup(groupId, { wakePromptConsumedAt: now });
    } catch {
      // Delivery must not fail only because the observability marker could not be written.
    }
  }
}

export function scheduleIdleWakeContinuation(sessionId: string, start: () => void, delayMs = IDLE_WAKE_COALESCE_MS) {
  const id = String(sessionId ?? "").trim();
  if (!id || !hasPendingWakeHandoffs(id)) {
    return;
  }
  const existing = idleTimers.get(id);
  if (existing) {
    existing.start = start;
    return;
  }
  const timer = setTimeout(() => {
    const current = idleTimers.get(id);
    idleTimers.delete(id);
    if (!hasPendingWakeHandoffs(id)) {
      return;
    }
    current?.start();
  }, Math.max(0, delayMs));
  idleTimers.set(id, { timer, start });
}

export function cancelIdleWakeContinuation(sessionId: string) {
  const id = String(sessionId ?? "").trim();
  const existing = idleTimers.get(id);
  if (!existing) {
    return;
  }
  clearTimeout(existing.timer);
  idleTimers.delete(id);
}

export function resetWakeHandoffStateForTests() {
  for (const existing of idleTimers.values()) {
    clearTimeout(existing.timer);
  }
  idleTimers.clear();
  batches.clear();
}

function resolveBatchBudget(maxBytes: unknown) {
  if (typeof maxBytes === "number" && Number.isInteger(maxBytes) && maxBytes > 0) {
    return maxBytes;
  }
  return DEFAULT_MAX_WAKE_SUMMARY_BYTES;
}

function fitWakeBatch(header: string, sections: string[], footer: string, limit: number) {
  let body = header;
  for (let index = 0; index < sections.length; index += 1) {
    const next = `${body}\n\n${sections[index]}`;
    if (Buffer.byteLength(`${next}${footer}`, "utf8") <= limit) {
      body = next;
      continue;
    }
    const marker = "\n\n...[handoff batch truncated; remaining reports stay in .lab-agent/tasks]";
    const room = limit - Buffer.byteLength(body, "utf8") - Buffer.byteLength(footer, "utf8") - Buffer.byteLength(marker, "utf8");
    body = room > 200
      ? `${body}\n\n${utf8Truncate(sections[index], room)}${marker}`
      : `${body}${marker}`;
    break;
  }
  const combined = `${body}${footer}`;
  return Buffer.byteLength(combined, "utf8") <= limit ? combined : utf8Truncate(combined, limit);
}
