import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

export const SCHEDULE_DIR_NAME = "schedules";
export const MIN_INTERVAL_MINUTES = 15;
export const MAX_INTERVAL_MINUTES = 7 * 24 * 60;
export const MIN_ONCE_DELAY_MINUTES = 1;
export const MAX_ONCE_DELAY_MINUTES = 7 * 24 * 60;
export const SCHEDULE_ID_PATTERN = /^sched-[a-f0-9]{16}$/;

export type SchedulePermissionMode = "plan" | "workspace" | "fullAccess";
export type ScheduleRunStatus = "queued" | "completed" | "failed" | "skipped" | "interrupted";

export type ScheduleCadence =
  | { type: "once"; at: string }
  | { type: "daily"; time: string }
  | { type: "weekly"; weekday: number; time: string }
  | { type: "interval"; everyMinutes: number };

export type ScheduleRecord = {
  version: 1;
  id: string;
  title: string;
  prompt: string;
  permissionMode: SchedulePermissionMode;
  sessionId: string;
  enabled: boolean;
  cadence: ScheduleCadence;
  timeZone: string;
  nextRunAt: string;
  lastRunAt: string | null;
  lastStatus: ScheduleRunStatus | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ScheduleDraft = {
  title: string;
  prompt: string;
  permissionMode: SchedulePermissionMode;
  sessionId: string;
  cadence: ScheduleCadence;
  timeZone: string;
  now?: number;
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export function schedulesDir(cwd: string) {
  return path.join(path.resolve(cwd), ".lab-agent", SCHEDULE_DIR_NAME);
}

export function isScheduleId(value: unknown) {
  return SCHEDULE_ID_PATTERN.test(String(value ?? ""));
}

export function normalizeSchedulePermissionMode(value: unknown): SchedulePermissionMode {
  const mode = String(value ?? "").trim();
  if (mode === "fullAccess" || mode === "full-access") return "fullAccess";
  if (mode === "workspace") return "workspace";
  return "plan";
}

export function permissionModeFromPolicy(policy: { fullAccess?: boolean; approvals?: { workspaceWrites?: boolean; workspaceCommands?: boolean } } | null | undefined): SchedulePermissionMode {
  if (policy?.fullAccess) return "fullAccess";
  if (policy?.approvals?.workspaceWrites || policy?.approvals?.workspaceCommands) return "workspace";
  return "plan";
}

export function permissionRank(mode: SchedulePermissionMode) {
  if (mode === "fullAccess") return 2;
  if (mode === "workspace") return 1;
  return 0;
}

export function clampSchedulePermission(requested: unknown, current: SchedulePermissionMode): SchedulePermissionMode {
  const normalized = normalizeSchedulePermissionMode(requested);
  return permissionRank(normalized) > permissionRank(current) ? current : normalized;
}

export function parseScheduleTime(value: unknown) {
  const text = normalizeScheduleText(value).replace(/：/g, ":").replace(/\s+/g, "");
  const match = /^([01]?\d|2[0-3]):([0-5]?\d)$/.exec(text);
  if (!match) return null;
  return `${match[1].padStart(2, "0")}:${match[2].padStart(2, "0")}`;
}

export function parseScheduleInteger(value: unknown) {
  const text = normalizeScheduleText(value).replace(/[。．.，,]/g, "").replace(/\s+/g, "");
  if (!/^\d+$/.test(text)) return null;
  return Number(text);
}

function normalizeScheduleText(value: unknown) {
  return String(value ?? "").trim().replace(/[０-９]/g, (digit) => String("０１２３４５６７８９".indexOf(digit)));
}

export function parseWeekday(value: unknown) {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 6) return value;
  const text = normalizeScheduleText(value).toLowerCase();
  const names: Record<string, number> = {
    sun: 0, sunday: 0, 日: 0, 周日: 0, 星期日: 0,
    mon: 1, monday: 1, 一: 1, 周一: 1, 星期一: 1,
    tue: 2, tuesday: 2, 二: 2, 周二: 2, 星期二: 2,
    wed: 3, wednesday: 3, 三: 3, 周三: 3, 星期三: 3,
    thu: 4, thursday: 4, 四: 4, 周四: 4, 星期四: 4,
    fri: 5, friday: 5, 五: 5, 周五: 5, 星期五: 5,
    sat: 6, saturday: 6, 六: 6, 周六: 6, 星期六: 6
  };
  if (text in names) return names[text];
  if (/^[0-6]$/.test(text)) return Number(text);
  return null;
}

export function parseScheduleCadence(input: Record<string, unknown>): { ok: true; cadence: ScheduleCadence } | { ok: false; error: string } {
  const type = String(input.cadence ?? input.type ?? "").trim().toLowerCase();
  if (type === "daily") {
    const time = parseScheduleTime(input.time);
    if (!time) return { ok: false, error: "每天运行需要 time，格式为 HH:mm" };
    return { ok: true, cadence: { type: "daily", time } };
  }
  if (type === "weekly") {
    const time = parseScheduleTime(input.time);
    const weekday = parseWeekday(input.weekday);
    if (!time || weekday == null) return { ok: false, error: "每周运行需要 weekday 和 time" };
    return { ok: true, cadence: { type: "weekly", weekday, time } };
  }
  if (type === "interval") {
    const everyMinutes = parseScheduleInteger(input.everyMinutes ?? input.minutes);
    if (everyMinutes == null || everyMinutes < MIN_INTERVAL_MINUTES || everyMinutes > MAX_INTERVAL_MINUTES) {
      return { ok: false, error: `间隔需要 ${MIN_INTERVAL_MINUTES} 到 ${MAX_INTERVAL_MINUTES} 之间的整数分钟` };
    }
    return { ok: true, cadence: { type: "interval", everyMinutes } };
  }
  if (type === "once" || type === "one" || type === "oneshot" || type === "一次") {
    return parseOnceCadence(input);
  }
  return { ok: false, error: "cadence 可以是 once、daily、weekly 或 interval" };
}

function parseOnceCadence(input: Record<string, unknown>): { ok: true; cadence: ScheduleCadence } | { ok: false; error: string } {
  const now = typeof input.now === "number" ? input.now : Date.now();
  const timeZone = String(input.timeZone ?? "").trim() || "UTC";
  const delay = parseScheduleInteger(input.delayMinutes ?? input.inMinutes ?? input.afterMinutes);
  if (delay != null) {
    if (delay < MIN_ONCE_DELAY_MINUTES || delay > MAX_ONCE_DELAY_MINUTES) {
      return { ok: false, error: `一次性任务的 delayMinutes 需要在 ${MIN_ONCE_DELAY_MINUTES} 到 ${MAX_ONCE_DELAY_MINUTES} 之间` };
    }
    return { ok: true, cadence: { type: "once", at: new Date(now + delay * 60_000).toISOString() } };
  }
  const at = parseOnceAt(input.at ?? input.runAt, timeZone, now);
  if (!at.ok) return at;
  return { ok: true, cadence: { type: "once", at: at.at } };
}

function parseOnceAt(value: unknown, timeZone: string, now: number): { ok: true; at: string } | { ok: false; error: string } {
  const text = String(value ?? "").trim();
  if (!text) return { ok: false, error: "一次性任务需要 delayMinutes，或一个未来的 at 时间" };
  const local = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(text);
  if (local) {
    const at = zonedWallTimeToUtc(Number(local[1]), Number(local[2]), Number(local[3]), Number(local[4]), Number(local[5]), timeZone).toISOString();
    return validateOnceAt(at, now);
  }
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) return { ok: false, error: "at 需要是可解析的时间，例如 2026-10-17T17:30:00+08:00" };
  return validateOnceAt(new Date(parsed).toISOString(), now);
}

function validateOnceAt(at: string, now: number): { ok: true; at: string } | { ok: false; error: string } {
  const parsed = Date.parse(at);
  if (parsed < now + MIN_ONCE_DELAY_MINUTES * 60_000) {
    return { ok: false, error: "一次性任务至少要在 1 分钟之后" };
  }
  if (parsed > now + MAX_ONCE_DELAY_MINUTES * 60_000) {
    return { ok: false, error: "一次性任务最远只能安排 7 天内" };
  }
  return { ok: true, at: new Date(parsed).toISOString() };
}

export function describeCadence(cadence: ScheduleCadence, timeZone = "UTC") {
  if (cadence.type === "once") return `一次，${formatZonedMinute(cadence.at, timeZone)}`;
  if (cadence.type === "daily") return `每天 ${cadence.time}`;
  if (cadence.type === "weekly") return `每${weekdayLabel(cadence.weekday)} ${cadence.time}`;
  return `每 ${cadence.everyMinutes} 分钟`;
}

export function weekdayLabel(weekday: number) {
  return ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][weekday] ?? "周日";
}

export function permissionLabel(mode: SchedulePermissionMode) {
  if (mode === "fullAccess") return "完全访问";
  if (mode === "workspace") return "工作区权限";
  return "计划确认";
}

export function schedulePromptText(record: Pick<ScheduleRecord, "title" | "prompt">) {
  return [
    `[定时任务：${record.title}]`,
    "这是一次由本机日程触发的普通任务。按下面的提示词完成本轮，不要再创建新的定时任务。",
    "",
    record.prompt
  ].join("\n");
}

export function nextScheduleRunAt(cadence: ScheduleCadence, timeZone: string, now = Date.now()) {
  if (cadence.type === "once") {
    return Date.parse(cadence.at) > now ? cadence.at : new Date(now + 60_000).toISOString();
  }
  if (cadence.type === "interval") {
    return new Date(now + cadence.everyMinutes * 60_000).toISOString();
  }
  const [hour, minute] = cadence.time.split(":").map(Number);
  const start = new Date(now + 60_000);
  for (let offset = 0; offset < 8; offset += 1) {
    const probe = new Date(start.getTime() + offset * 24 * 60 * 60_000);
    const parts = zonedParts(probe, timeZone);
    if (cadence.type === "weekly" && parts.weekday !== cadence.weekday) continue;
    const candidate = zonedWallTimeToUtc(parts.year, parts.month, parts.day, hour, minute, timeZone);
    if (candidate.getTime() > now) return candidate.toISOString();
  }
  return new Date(now + 24 * 60 * 60_000).toISOString();
}

export function createScheduleRecord(draft: ScheduleDraft): ScheduleRecord {
  const now = draft.now ?? Date.now();
  const createdAt = new Date(now).toISOString();
  return {
    version: 1,
    id: `sched-${randomBytes(8).toString("hex")}`,
    title: draft.title.trim(),
    prompt: draft.prompt.trim(),
    permissionMode: draft.permissionMode,
    sessionId: draft.sessionId,
    enabled: true,
    cadence: draft.cadence,
    timeZone: draft.timeZone,
    nextRunAt: nextScheduleRunAt(draft.cadence, draft.timeZone, now),
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
    createdAt,
    updatedAt: createdAt
  };
}

export function publicSchedule(record: ScheduleRecord) {
  return {
    id: record.id,
    title: record.title,
    promptPreview: record.prompt.slice(0, 160),
    permissionMode: record.permissionMode,
    permissionLabel: permissionLabel(record.permissionMode),
    sessionId: record.sessionId,
    enabled: record.enabled,
    cadence: record.cadence,
    cadenceLabel: describeCadence(record.cadence, record.timeZone),
    timeZone: record.timeZone,
    nextRunAt: record.nextRunAt,
    lastRunAt: record.lastRunAt,
    lastStatus: record.lastStatus,
    lastError: record.lastError
  };
}

export async function listSchedules(cwd: string) {
  const dir = schedulesDir(cwd);
  const names = await fs.readdir(dir).catch(() => []);
  const records: ScheduleRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const record = await readScheduleFile(path.join(dir, name));
    if (record) records.push(record);
  }
  return records.sort((left, right) => left.nextRunAt.localeCompare(right.nextRunAt));
}

export async function readSchedule(cwd: string, id: string) {
  if (!isScheduleId(id)) return null;
  return readScheduleFile(path.join(schedulesDir(cwd), `${id}.json`));
}

export async function writeSchedule(cwd: string, record: ScheduleRecord) {
  const dir = schedulesDir(cwd);
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, `${record.id}.json`);
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await fs.rename(temporary, target);
  return record;
}

export async function updateSchedule(cwd: string, id: string, patch: Partial<ScheduleRecord>) {
  const current = await readSchedule(cwd, id);
  if (!current) return null;
  const next: ScheduleRecord = {
    ...current,
    ...patch,
    id: current.id,
    version: 1,
    updatedAt: new Date().toISOString()
  };
  await writeSchedule(cwd, next);
  return next;
}

export async function deleteSchedule(cwd: string, id: string) {
  if (!isScheduleId(id)) return false;
  await fs.rm(path.join(schedulesDir(cwd), `${id}.json`), { force: true });
  return true;
}

export function scheduleFireDecision(record: ScheduleRecord, now: number, session: { running: boolean; goalEnabled: boolean; queued: boolean } | null) {
  if (!record.enabled || Date.parse(record.nextRunAt) > now) {
    return { action: "wait" as const };
  }
  const nextRunAt = record.cadence.type === "once"
    ? new Date(now + 60_000).toISOString()
    : nextScheduleRunAt(record.cadence, record.timeZone, now);
  if (session?.goalEnabled) {
    return { action: "skip" as const, nextRunAt, reason: "会话正在 Goal 无人值守，本轮跳过" };
  }
  if (session?.running || session?.queued) {
    return { action: "skip" as const, nextRunAt, reason: "上次任务仍在运行，本轮跳过" };
  }
  return {
    action: "fire" as const,
    nextRunAt: record.cadence.type === "once" ? record.nextRunAt : nextRunAt,
    once: record.cadence.type === "once"
  };
}

function formatZonedMinute(iso: string, timeZone: string) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso;
  const parts = zonedParts(date, timeZone);
  const month = String(parts.month).padStart(2, "0");
  const day = String(parts.day).padStart(2, "0");
  const hour = String(parts.hour).padStart(2, "0");
  const minute = String(parts.minute).padStart(2, "0");
  return `${parts.year}-${month}-${day} ${hour}:${minute}`;
}

function zonedParts(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hourCycle: "h23"
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const weekday = WEEKDAYS.indexOf(parts.weekday as typeof WEEKDAYS[number]);
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: weekday >= 0 ? weekday : 0
  };
}

function timezoneOffsetMs(date: Date, timeZone: string) {
  const parts = zonedParts(date, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - date.getTime();
}

function zonedWallTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string) {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const corrected = new Date(guess.getTime() - timezoneOffsetMs(guess, timeZone));
  const drift = timezoneOffsetMs(corrected, timeZone) - timezoneOffsetMs(guess, timeZone);
  return drift === 0 ? corrected : new Date(corrected.getTime() - drift);
}

async function readScheduleFile(filePath: string) {
  const text = await fs.readFile(filePath, "utf8").catch(() => "");
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as ScheduleRecord;
    if (!parsed || parsed.version !== 1 || !isScheduleId(parsed.id)) return null;
    return parsed;
  } catch {
    return null;
  }
}
