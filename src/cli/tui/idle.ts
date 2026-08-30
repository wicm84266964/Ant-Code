import process from "node:process";
import { DEFAULT_IDLE_SILENT_AFTER_MS, type TuiPendingApproval, type TuiPendingQuestion, type TuiTaskRecord } from "./types.ts";
import { fileMentionState, slashPaletteState } from "./palettes.ts";

export function resolveIdleSilentAfterMs(env: NodeJS.ProcessEnv = process.env) {
  const value = Number(env?.LAB_AGENT_TUI_IDLE_SILENT_MS);
  if (Number.isFinite(value)) {
    return Math.max(0, Math.trunc(value));
  }
  return DEFAULT_IDLE_SILENT_AFTER_MS;
}

export type IdleSilentCurrent = {
  startupConfirmed?: boolean;
  trusted?: boolean;
  busy?: boolean;
  stream?: { active?: boolean } | null;
  pendingApproval?: TuiPendingApproval | null;
  pendingQuestion?: TuiPendingQuestion | null;
  modelPickerOpen?: boolean;
  slashPalette?: ReturnType<typeof slashPaletteState> | null;
  fileMention?: ReturnType<typeof fileMentionState> | null;
  mode?: string;
  taskRecords?: TuiTaskRecord[];
};

export type IdleSilentOptions = {
  timeoutMs?: number;
  now?: number;
  lastActivityAt?: number;
  runningBackgroundCount?: number;
};

export function shouldEnterIdleSilent(current: IdleSilentCurrent = {}, options: IdleSilentOptions = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || 0);
  if (timeoutMs <= 0) {
    return false;
  }
  const now = typeof options.now === "number" && Number.isFinite(options.now) ? options.now : Date.now();
  const lastActivityAt = typeof options.lastActivityAt === "number" && Number.isFinite(options.lastActivityAt)
    ? options.lastActivityAt
    : now;
  if (now - lastActivityAt < timeoutMs) {
    return false;
  }
  if (!current.startupConfirmed || !current.trusted) {
    return false;
  }
  if (current.busy || current.stream?.active) {
    return false;
  }
  if (current.pendingApproval || current.pendingQuestion || current.modelPickerOpen || current.slashPalette || current.fileMention) {
    return false;
  }
  if (current.mode && current.mode !== "input") {
    return false;
  }
  if (Number(options.runningBackgroundCount ?? 0) > 0) {
    return false;
  }
  const hasRunningTask = Array.isArray(current.taskRecords)
    && current.taskRecords.some((task) => task?.status === "running" || task?.status === "queued");
  return !hasRunningTask;
}
