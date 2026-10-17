import {
  createScheduleRecord,
  deleteSchedule,
  describeCadence,
  listSchedules,
  nextScheduleRunAt,
  parseScheduleCadence,
  publicSchedule,
  updateSchedule,
  writeSchedule,
  type SchedulePermissionMode
} from "./store.ts";

type AskUser = (input: Record<string, unknown>) => Promise<unknown> | unknown;

export async function scheduleListTool(cwd: string) {
  const schedules = await listSchedules(cwd);
  return {
    ok: true,
    result: {
      schedules: schedules.map(publicSchedule)
    }
  };
}

export async function createConfirmedSchedule(input: Record<string, unknown>, options: {
  cwd: string;
  sessionId?: string;
  timeZone?: string;
  now?: number;
}) {
  const title = String(input.title ?? "").trim();
  const prompt = String(input.prompt ?? "").trim();
  if (!title || title.length > 80) {
    return { ok: false as const, error: "定时任务需要 1 到 80 字的标题" };
  }
  if (!prompt || prompt.length > 4000) {
    return { ok: false as const, error: "定时任务需要一段不超过 4000 字的提示词" };
  }
  const timeZone = safeTimeZone(options.timeZone ?? input.timeZone);
  const cadence = parseScheduleCadence({ ...input, now: options.now, timeZone });
  if (!cadence.ok) return { ok: false as const, error: cadence.error };
  const draft = createScheduleRecord({
    title,
    prompt,
    permissionMode: "fullAccess",
    sessionId: String(options.sessionId ?? "").trim(),
    cadence: cadence.cadence,
    timeZone,
    now: options.now
  });
  await writeSchedule(options.cwd, draft);
  return { ok: true as const, schedule: publicSchedule(draft) };
}

export async function scheduleCreateTool(input: Record<string, unknown>, options: {
  cwd: string;
  sessionId?: string;
  policy?: { fullAccess?: boolean; approvals?: { workspaceWrites?: boolean; workspaceCommands?: boolean } };
  askUser?: AskUser;
  timeZone?: string;
  now?: number;
}) {
  const title = String(input.title ?? "").trim();
  const prompt = String(input.prompt ?? "").trim();
  if (!title || title.length > 80) {
    return { ok: false, error: { code: "SCHEDULE_TITLE_INVALID", message: "定时任务需要 1 到 80 字的标题" } };
  }
  if (!prompt || prompt.length > 4000) {
    return { ok: false, error: { code: "SCHEDULE_PROMPT_INVALID", message: "定时任务需要一段不超过 4000 字的提示词" } };
  }
  if (!options.sessionId) {
    return { ok: false, error: { code: "SCHEDULE_SESSION_REQUIRED", message: "定时任务要绑定当前会话" } };
  }
  if (!options.askUser) {
    return { ok: false, blocked: true, error: { code: "USER_INPUT_UNAVAILABLE", message: "创建定时任务需要用户确认" } };
  }
  const timeZone = safeTimeZone(options.timeZone ?? input.timeZone);
  const cadence = parseScheduleCadence({ ...input, now: options.now, timeZone });
  if (!cadence.ok) {
    return { ok: false, error: { code: "SCHEDULE_CADENCE_INVALID", message: cadence.error } };
  }
  const permissionMode = "fullAccess" as const;
  const draft = createScheduleRecord({
    title,
    prompt,
    permissionMode,
    sessionId: options.sessionId,
    cadence: cadence.cadence,
    timeZone,
    now: options.now
  });
  const answer = await options.askUser({
    header: "自动任务",
    question: [
      "自动任务会用完全访问权限运行，到点不再弹出放权。",
      `确认创建「${draft.title}」？`,
      describeCadence(draft.cadence, timeZone),
      draft.cadence.type === "once"
        ? "到点只发送一次，发完就停。会话正忙时会稍后重试。"
        : "到点会把保存的提示词发回当前会话。上次还在跑就跳过。Dashboard 进程退出后，错过的轮次只在下次启动时补跑一次。"
    ].join("\n"),
    choices: [
      { label: "确认创建", value: "confirm" },
      { label: "取消", value: "cancel" }
    ],
    allowCustom: false
  });
  if (!scheduleConfirmationAccepted(answer)) {
    return {
      ok: false,
      blocked: true,
      error: { code: "SCHEDULE_NOT_CONFIRMED", message: "用户没有确认，定时任务没有创建" }
    };
  }
  await writeSchedule(options.cwd, draft);
  return { ok: true, result: publicSchedule(draft) };
}

export async function pauseSchedule(cwd: string, id: string) {
  return updateSchedule(cwd, id, { enabled: false });
}

export async function resumeSchedule(cwd: string, id: string, now = Date.now()) {
  const current = await updateSchedule(cwd, id, { enabled: true });
  if (!current) return null;
  if (Date.parse(current.nextRunAt) <= now) {
    return updateSchedule(cwd, id, { nextRunAt: nextScheduleRunAt(current.cadence, current.timeZone, now), enabled: true });
  }
  return current;
}

export async function removeSchedule(cwd: string, id: string) {
  return deleteSchedule(cwd, id);
}

function scheduleConfirmationAccepted(answer: unknown) {
  if (!answer || typeof answer !== "object") return false;
  const record = answer as { skipped?: unknown; cancelled?: unknown; selectedChoice?: unknown; answer?: unknown; selectedChoices?: unknown };
  if (record.skipped === true || record.cancelled === true) return false;
  const values = [
    record.selectedChoice,
    record.answer,
    ...(Array.isArray(record.selectedChoices) ? record.selectedChoices : [])
  ].map((value) => String(value ?? "").trim().toLowerCase());
  return values.includes("confirm") || values.includes("确认创建");
}

function safeTimeZone(value: unknown) {
  const requested = String(value ?? "").trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: requested }).format(new Date());
    return requested;
  } catch {
    return "UTC";
  }
}

export type { SchedulePermissionMode };
