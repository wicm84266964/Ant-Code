import { listSchedules, publicSchedule, scheduleFireDecision, schedulePromptText, updateSchedule } from "../../schedules/store.ts";
import { createConfirmedSchedule, pauseSchedule, removeSchedule, resumeSchedule } from "../../schedules/tools.ts";
import type { DashboardFactoryState } from "./factory-state.ts";
import type { DashboardActiveSessionState } from "./types.ts";

export const SCHEDULE_TICK_MS = 30_000;

export async function tickDashboardSchedules(ctx: Pick<DashboardFactoryState, "cwd" | "active" | "shuttingDown" | "runtime">, now = Date.now()) {
  if (ctx.shuttingDown) return { ok: true, fired: 0, skipped: 0 };
  const records = await listSchedules(ctx.cwd);
  let fired = 0;
  let skipped = 0;
  for (const record of records) {
    const state = ctx.active.get(record.sessionId) as DashboardActiveSessionState | undefined;
    const decision = scheduleFireDecision(record, now, state ? {
      running: state.running === true,
      goalEnabled: Boolean(state.session?.goal?.enabled),
      queued: state.queuedPrompts.some((item) => item.kind === "schedule" && item.scheduleId === record.id)
    } : null);
    if (decision.action === "wait") continue;
    if (decision.action === "skip") {
      skipped += 1;
      await updateSchedule(ctx.cwd, record.id, {
        nextRunAt: decision.nextRunAt,
        lastRunAt: new Date(now).toISOString(),
        lastStatus: "skipped",
        lastError: decision.reason
      });
      continue;
    }
    await updateSchedule(ctx.cwd, record.id, {
      nextRunAt: decision.nextRunAt,
      lastRunAt: new Date(now).toISOString(),
      lastStatus: "queued",
      lastError: null,
      ...(decision.once ? { enabled: false } : {})
    });
    const result = await ctx.runtime.startTurn({
      sessionId: record.sessionId,
      prompt: schedulePromptText(record),
      permissionMode: "fullAccess",
      kind: "schedule",
      scheduleId: record.id,
      scheduleTitle: record.title
    }) as { ok?: boolean; error?: unknown; sessionId?: string };
    if (result?.ok === false) {
      await updateSchedule(ctx.cwd, record.id, {
        lastStatus: "failed",
        lastError: String(result.error ?? "定时任务没有进入队列"),
        ...(decision.once ? { enabled: true, nextRunAt: new Date(now + 60_000).toISOString() } : {})
      });
      continue;
    }
    if (result?.sessionId && result.sessionId !== record.sessionId) {
      await updateSchedule(ctx.cwd, record.id, { sessionId: result.sessionId });
    }
    fired += 1;
  }
  return { ok: true, fired, skipped };
}

export async function createDashboardSchedule(cwd: string, input: { title?: unknown; prompt?: unknown; cadence?: unknown; time?: unknown; weekday?: unknown; delayMinutes?: unknown; everyMinutes?: unknown; sessionId?: unknown }) {
  return createConfirmedSchedule(input, { cwd, sessionId: String(input.sessionId ?? "") });
}

export async function listDashboardSchedules(cwd: string) {
  const schedules = await listSchedules(cwd);
  return { ok: true, schedules: schedules.map(publicSchedule) };
}

export async function pauseDashboardSchedule(cwd: string, id: string) {
  const schedule = await pauseSchedule(cwd, id);
  if (!schedule) return { ok: false, status: 404, error: "找不到这个定时任务" };
  return { ok: true, schedule: publicSchedule(schedule) };
}

export async function resumeDashboardSchedule(cwd: string, id: string) {
  const schedule = await resumeSchedule(cwd, id);
  if (!schedule) return { ok: false, status: 404, error: "找不到这个定时任务" };
  return { ok: true, schedule: publicSchedule(schedule) };
}

export async function deleteDashboardSchedule(cwd: string, id: string) {
  const removed = await removeSchedule(cwd, id);
  if (!removed) return { ok: false, status: 404, error: "找不到这个定时任务" };
  return { ok: true, id };
}

export async function recordScheduleRunResult(cwd: string, scheduleId: string, status: string) {
  const normalized = status === "completed" || status === "interrupted" || status === "skipped"
    ? status
    : "failed";
  await updateSchedule(cwd, scheduleId, {
    lastStatus: normalized,
    lastError: normalized === "completed" ? null : `本轮状态：${status}`
  });
}
