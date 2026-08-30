import {
  buildGoalRecap,
  clearGoalEndedAt,
  disableGoalState,
  enableGoalState,
  goalUnattendedQuestionResult,
  planGoalHostContinue,
  applyGoalTurnOutcome,
  publicGoalSnapshot,
  resolveGoalMaxAutoContinues,
  shouldShowGoalRecap,
  type SessionGoal
} from "../../core/goal.ts";
import { persistSessionSnapshot, type AgentSession } from "../../core/session.ts";
import { applyPermissionMode } from "./format.ts";

export const GOAL_WRITE_TOOLS = new Set(["write_file", "edit_file", "powershell", "bash"]);
const GOAL_CONTROL_VERBS = new Set([
  "pause",
  "resume",
  "exit",
  "clear",
  "off",
  "disable",
  "stop",
  "status",
  "enable"
]);

export function parseTuiGoalCommand(args: string[] | unknown) {
  const parts = Array.isArray(args) ? args.map((item) => String(item ?? "").trim()).filter(Boolean) : [];
  if (parts.length === 0) {
    return { action: "status", objective: "" };
  }
  const verb = parts[0].toLowerCase();
  if (verb === "enable") {
    return { action: "enable", objective: parts.slice(1).join(" ").trim() };
  }
  if (GOAL_CONTROL_VERBS.has(verb) && verb !== "enable") {
    const action = verb === "clear" || verb === "off" || verb === "disable" || verb === "stop" ? "exit" : verb;
    return { action, objective: "" };
  }
  return { action: "enable", objective: parts.join(" ").trim() };
}

export function tuiGoalStatusLabel(status: string) {
  return {
    active: "进行中",
    running: "进行中",
    paused: "已暂停",
    verifying: "核验中",
    complete: "已完成",
    failed: "失败",
    off: "关闭"
  }[String(status ?? "")] ?? String(status ?? "进行中");
}

export function formatTuiGoalFooter(session: AgentSession | { goal?: SessionGoal | null; usage?: unknown; config?: unknown } | null | undefined) {
  const goal = session?.goal;
  if (!goal?.enabled) {
    return null;
  }
  const status = tuiGoalStatusLabel(goal.status);
  if (shouldShowGoalRecap(goal)) {
    const recap = buildGoalRecap(goal, session?.usage);
    return recap.line ? `Goal · ${status} · ${recap.line}` : `Goal · ${status}`;
  }
  const cap = resolveGoalMaxAutoContinues(session?.config, goal.maxAutoContinues);
  const reason = String(goal.lastContinueReason ?? "").trim();
  const progress = `${nonNegativeInteger(goal.continueCount)}/${cap} 次续跑`;
  return reason ? `Goal · ${status} · ${progress} · ${reason}` : `Goal · ${status} · ${progress}`;
}

export function formatTuiGoalStatus(session: AgentSession) {
  const goal = session?.goal;
  if (!goal?.enabled) {
    return [
      "Goal 未开启。",
      "用法：/goal <目标>",
      "也可：/goal pause | resume | exit | status",
      "开启后权限锁定完全访问，回合结束后自动续跑，完成时在状态栏显示一行汇总。"
    ].join("\n");
  }
  const footer = formatTuiGoalFooter(session);
  const text = String(goal.text ?? "").trim();
  return [footer, text ? `目标：${text}` : null].filter(Boolean).join("\n");
}

export function formatTuiGoalRecapEntry(session: AgentSession) {
  const goal = session?.goal;
  if (!shouldShowGoalRecap(goal)) {
    return null;
  }
  const recap = buildGoalRecap(goal, session.usage);
  const status = tuiGoalStatusLabel(goal.status);
  return {
    title: `Goal · ${status}`,
    body: recap.line || status
  };
}

export async function executeTuiGoalCommand(input: {
  session: AgentSession;
  args: string[];
  env?: NodeJS.ProcessEnv;
  busy?: boolean;
}) {
  const session = input.session;
  const parsed = parseTuiGoalCommand(input.args);
  if (parsed.action === "status") {
    return { ok: true, message: formatTuiGoalStatus(session) };
  }
  if (parsed.action === "enable") {
    if (!parsed.objective) {
      return { ok: false, message: "请输入目标。用法：/goal <目标>" };
    }
    if (session.permissionReadonlyLocked) {
      return { ok: false, message: "只读锁定会话不能启用 Goal。" };
    }
    if (input.busy) {
      return { ok: false, message: "请等当前轮次结束或先中断，再开启 Goal。" };
    }
    if (session.goal?.enabled) {
      return { ok: false, message: "Goal 已开启。请先 /goal exit。" };
    }
    const previous = session.permissionMode ?? "plan";
    const enabledGoal = enableGoalState({
      text: parsed.objective,
      previousPermissionMode: previous,
      maxAutoContinues: resolveGoalMaxAutoContinues(session.config),
      usage: session.usage
    });
    if (!enabledGoal) {
      return { ok: false, message: "请输入目标。用法：/goal <目标>" };
    }
    session.goal = enabledGoal;
    applyPermissionMode(session, "fullAccess");
    session.goal.status = "running";
    await persistTuiGoal(session, input.env);
    return {
      ok: true,
      message: `Goal 已开启，权限锁定完全访问。\n目标：${parsed.objective}`,
      startTurn: parsed.objective,
      permissionMode: "fullAccess"
    };
  }
  if (parsed.action === "pause") {
    if (!session.goal?.enabled) {
      return { ok: false, message: "当前没有启用 Goal。" };
    }
    session.goal.status = "paused";
    session.goal.lastBlockReason = "user_pause";
    await persistTuiGoal(session, input.env);
    return {
      ok: true,
      message: "Goal 已暂停。",
      interrupt: input.busy === true,
      permissionMode: session.permissionMode
    };
  }
  if (parsed.action === "resume") {
    const goal = session.goal;
    if (!goal?.enabled || !String(goal.text ?? "").trim()) {
      return { ok: false, message: "没有可继续的 Goal。" };
    }
    if (goal.status !== "paused" && goal.status !== "failed") {
      return { ok: false, message: "Goal 当前不可继续。" };
    }
    if (input.busy) {
      return { ok: false, message: "当前轮次仍在运行。" };
    }
    applyPermissionMode(session, "fullAccess");
    goal.status = "active";
    goal.lastBlockReason = "";
    goal.consecutiveFailures = 0;
    clearGoalEndedAt(goal);
    const plan = planGoalHostContinue({
      session,
      pendingQuestions: new Set(),
      pendingApprovals: new Set()
    });
    await persistTuiGoal(session, input.env);
    if (!plan.continue) {
      return {
        ok: true,
        message: "Goal 已恢复，但目前不能续跑。",
        permissionMode: "fullAccess"
      };
    }
    return {
      ok: true,
      message: plan.displayPrompt,
      continueTurn: plan,
      permissionMode: "fullAccess"
    };
  }
  if (parsed.action === "exit") {
    const previous = session.goal?.previousPermissionMode ?? "plan";
    session.goal = disableGoalState(session.goal, { clearedBy: "user" });
    applyPermissionMode(session, previous);
    await persistTuiGoal(session, input.env);
    return {
      ok: true,
      message: `已退出 Goal，权限恢复为${previous === "fullAccess" ? "完全访问" : previous === "workspace" ? "工作区权限" : "计划确认"}。`,
      interrupt: input.busy === true,
      permissionMode: previous
    };
  }
  return { ok: false, message: "未知 Goal 操作。" };
}

export async function finishTuiGoalTurn(input: {
  session: AgentSession;
  terminalStatus?: string;
  output?: string;
  env?: NodeJS.ProcessEnv;
  hasQueuedWork?: boolean;
  pendingQuestion?: boolean;
  pendingApproval?: boolean;
}) {
  const session = input.session;
  if (!session?.goal?.enabled) {
    return { continue: false, recap: null };
  }
  applyGoalTurnOutcome(session.goal, {
    terminalStatus: input.terminalStatus,
    finalOutput: input.output,
    liveWorkflow: session.workflow
  });
  let plan: { continue?: boolean; prompt?: string; displayPrompt?: string } = { continue: false };
  if (!input.hasQueuedWork) {
    plan = planGoalHostContinue({
      session,
      pendingQuestions: input.pendingQuestion ? new Set(["q"]) : new Set(),
      pendingApprovals: input.pendingApproval ? new Set(["a"]) : new Set()
    });
  }
  try {
    await persistTuiGoal(session, input.env);
  } catch {
    // Missing or unwritable session files must not take down the TUI.
  }
  const recap = shouldShowGoalRecap(session.goal) ? formatTuiGoalRecapEntry(session) : null;
  return {
    continue: plan.continue === true,
    prompt: plan.prompt,
    displayPrompt: plan.displayPrompt,
    recap,
    snapshot: publicGoalSnapshot(session.goal, session.config, session.usage)
  };
}

export function shouldSkipTuiGoalQuestion(session: AgentSession | { goal?: SessionGoal | null } | null | undefined) {
  const status = String(session?.goal?.status ?? "");
  return session?.goal?.enabled === true && (status === "active" || status === "running");
}

export function tuiGoalQuestionResult() {
  return goalUnattendedQuestionResult();
}

async function persistTuiGoal(session: AgentSession, env?: NodeJS.ProcessEnv) {
  if (!session?.id) {
    return;
  }
  try {
    await persistSessionSnapshot(session, { env, requireExisting: false });
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "SESSION_NOT_FOUND" || code === "SESSION_METADATA_NOT_FOUND") {
      return;
    }
    throw error;
  }
}

function nonNegativeInteger(value: unknown) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}
