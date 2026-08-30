export const GOAL_MAX_AUTO_CONTINUES = 12;
export const GOAL_MIN_AUTO_CONTINUES = 1;
export const GOAL_ABS_MAX_AUTO_CONTINUES = 100;
export const GOAL_CONTINUE_KIND = "goal-continue";

export type GoalUsageBaseline = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reports: number;
};

export type GoalEvidence = {
  claimedComplete: boolean;
  evidence: string;
  gaps: string[];
  activeItems: number;
  hasWrites: boolean;
  unresolvedFailures: number;
  validationFresh: boolean | null;
  lifecycleStage: string | null;
};

export type SessionGoal = {
  enabled: boolean;
  status: string;
  text: string;
  previousPermissionMode: string;
  roundCount: number;
  continueCount: number;
  consecutiveFailures: number;
  lastContinueReason: string;
  lastBlockReason: string;
  lastEvidence: GoalEvidence;
  hasWrites: boolean;
  clearedBy: string;
  maxAutoContinues: number;
  startedAt: string;
  endedAt: string;
  usageBaseline: GoalUsageBaseline | null;
};

export type GoalRecap = {
  elapsedMs: number | null;
  continueCount: number;
  roundCount: number;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  line: string;
};

type SizeHolder = {
  size?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sizeOf(value: unknown): unknown {
  if (!value || typeof value !== "object" || !("size" in value)) {
    return undefined;
  }
  return (value as SizeHolder).size;
}

function greaterThanZero(value: unknown): boolean {
  return (value as number) > 0;
}

function nestedMaxAutoContinues(source: unknown): unknown {
  if (!isRecord(source)) {
    return source;
  }
  const agentsGoal = asRecord(asRecord(source.agents).goal);
  const goal = asRecord(source.goal);
  return agentsGoal.maxAutoContinues ?? goal.maxAutoContinues ?? source.maxAutoContinues;
}

/**
 * @param {...unknown} sources
 */
export function resolveGoalMaxAutoContinues(...sources: unknown[]) {
  for (const source of sources) {
    const nested = nestedMaxAutoContinues(source);
    const number = Number(nested);
    if (Number.isInteger(number) && number >= GOAL_MIN_AUTO_CONTINUES && number <= GOAL_ABS_MAX_AUTO_CONTINUES) {
      return number;
    }
  }
  return GOAL_MAX_AUTO_CONTINUES;
}

const ACTIVE_CONTINUE_STATUSES = new Set(["active", "running"]);
const MARKER_LINE = /^(GOAL_STATUS|EVIDENCE|GAPS)\s*:/i;

/**
 * @param {unknown} raw
 * @param {{ hydrateRunningAsPaused?: boolean }} [options]
 */
export function normalizeSessionGoal(raw: unknown, options: { hydrateRunningAsPaused?: boolean } = {}): SessionGoal {
  const source = asRecord(raw);
  const text = String(source.text ?? source.objective ?? "").trim();
  const enabled = source.enabled === true && text.length > 0;
  let status = normalizeGoalStatus(source.status, enabled);
  if (options.hydrateRunningAsPaused !== false && enabled && status === "running") {
    status = "paused";
  }
  const continueCount = nonNegativeInteger(source.continueCount);
  const previousPermissionMode = normalizeStoredPermissionMode(source.previousPermissionMode ?? "plan");
  return {
    enabled,
    status: enabled ? status : "off",
    text: enabled || text ? text : "",
    previousPermissionMode,
    roundCount: nonNegativeInteger(source.roundCount),
    continueCount: Math.min(continueCount, resolveGoalMaxAutoContinues(source.maxAutoContinues) + 8),
    consecutiveFailures: nonNegativeInteger(source.consecutiveFailures),
    lastContinueReason: String(source.lastContinueReason ?? "").trim(),
    lastBlockReason: String(source.lastBlockReason ?? "").trim(),
    lastEvidence: normalizeGoalEvidence(source.lastEvidence),
    hasWrites: source.hasWrites === true,
    clearedBy: String(source.clearedBy ?? "").trim(),
    maxAutoContinues: resolveGoalMaxAutoContinues(source.maxAutoContinues),
    startedAt: optionalIsoTimestamp(source.startedAt),
    endedAt: optionalIsoTimestamp(source.endedAt),
    usageBaseline: normalizeGoalUsageBaseline(source.usageBaseline)
  };
}

/**
 * @param {Record<string, any> | null | undefined} goal
 */
export function serializeSessionGoal(goal: Record<string, unknown> | SessionGoal | null | undefined): SessionGoal {
  return normalizeSessionGoal(goal, { hydrateRunningAsPaused: false });
}

/**
 * @param {Record<string, any> | null | undefined} goal
 * @param {unknown} [config]
 * @param {unknown} [usage]
 */
export function publicGoalSnapshot(goal: Record<string, unknown> | SessionGoal | null | undefined, config?: { agents?: { goal?: { maxAutoContinues?: number } } } | null, usage: unknown = null) {
  const normalized = serializeSessionGoal(goal);
  return {
    enabled: normalized.enabled,
    status: normalized.status,
    text: normalized.text,
    previousPermissionMode: normalized.previousPermissionMode,
    roundCount: normalized.roundCount,
    continueCount: normalized.continueCount,
    maxAutoContinues: resolveGoalMaxAutoContinues(config, normalized.maxAutoContinues),
    lastContinueReason: normalized.lastContinueReason,
    lastBlockReason: normalized.lastBlockReason,
    lastEvidence: normalized.lastEvidence,
    hasWrites: normalized.hasWrites,
    recap: shouldShowGoalRecap(normalized) ? buildGoalRecap(normalized, usage) : null
  };
}

/**
 * @param {Record<string, any> | null | undefined} goal
 */
export function shouldShowGoalRecap(goal: Record<string, unknown> | SessionGoal | null | undefined) {
  const status = String(goal?.status ?? "");
  if (status === "complete" || status === "failed") {
    return true;
  }
  return status === "paused" && String(goal?.lastBlockReason ?? "") === "budget";
}

/**
 * @param {unknown} usage
 */
export function snapshotGoalUsageBaseline(usage: unknown): GoalUsageBaseline {
  const source = asRecord(usage);
  return {
    promptTokens: nonNegativeInteger(source.promptTokens),
    completionTokens: nonNegativeInteger(source.completionTokens),
    totalTokens: nonNegativeInteger(source.totalTokens),
    reports: nonNegativeInteger(source.reports)
  };
}

/**
 * @param {Record<string, any> | null | undefined} goal
 * @param {unknown} [usage]
 * @param {Date} [now]
 */
export function buildGoalRecap(goal: Record<string, unknown> | SessionGoal | null | undefined, usage: unknown, now: Date = new Date()): GoalRecap {
  const normalized = serializeSessionGoal(goal);
  const current = snapshotGoalUsageBaseline(usage);
  const baseline = normalized.usageBaseline;
  const startedMs = Date.parse(normalized.startedAt);
  const endedMs = Date.parse(normalized.endedAt);
  const elapsedMs = Number.isFinite(startedMs)
    ? Math.max(0, (Number.isFinite(endedMs) ? endedMs : now.getTime()) - startedMs)
    : null;
  let promptTokens = null;
  let completionTokens = null;
  let totalTokens = null;
  if (baseline) {
    const promptDelta = Math.max(0, current.promptTokens - baseline.promptTokens);
    const completionDelta = Math.max(0, current.completionTokens - baseline.completionTokens);
    const totalDelta = Math.max(0, current.totalTokens - baseline.totalTokens);
    const reportsDelta = Math.max(0, current.reports - baseline.reports);
    if (reportsDelta > 0 || promptDelta > 0 || completionDelta > 0 || totalDelta > 0) {
      promptTokens = promptDelta;
      completionTokens = completionDelta;
      totalTokens = totalDelta;
    }
  }
  const recap: GoalRecap = {
    elapsedMs,
    continueCount: normalized.continueCount,
    roundCount: normalized.roundCount,
    promptTokens,
    completionTokens,
    totalTokens,
    line: ""
  };
  recap.line = formatGoalRecapLine(recap);
  return recap;
}

/**
 * @param {{
 *   elapsedMs?: number | null,
 *   continueCount?: number,
 *   roundCount?: number,
 *   promptTokens?: number | null,
 *   completionTokens?: number | null
 * } | null | undefined} recap
 */
export function formatGoalRecapLine(recap: {
  elapsedMs?: number | null,
  continueCount?: number,
  roundCount?: number,
  promptTokens?: number | null,
  completionTokens?: number | null
} | null | undefined) {
  if (!recap || typeof recap !== "object") {
    return "";
  }
  const parts: string[] = [];
  if (Number.isFinite(recap.elapsedMs)) {
    parts.push(formatGoalElapsed(recap.elapsedMs));
  }
  parts.push(`${nonNegativeInteger(recap.continueCount)} 次续跑`);
  if (nonNegativeInteger(recap.roundCount) > 0) {
    parts.push(`${nonNegativeInteger(recap.roundCount)} 轮`);
  }
  if (recap.promptTokens != null && recap.completionTokens != null) {
    parts.push(`输入 ${formatGoalTokens(recap.promptTokens)} / 输出 ${formatGoalTokens(recap.completionTokens)}`);
  }
  return parts.join(" · ");
}

/** @param {unknown} value */
export function formatGoalElapsed(value: unknown) {
  const totalSeconds = Math.max(0, Math.floor(Number(value) / 1000) || 0);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
  }
  if (minutes > 0) {
    return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`;
  }
  return `${seconds}s`;
}

/** @param {unknown} value */
export function formatGoalTokens(value: unknown) {
  const amount = Math.max(0, Math.round(Number(value) || 0));
  if (amount < 1000) {
    return String(amount);
  }
  if (amount < 1_000_000) {
    return `${trimGoalCompactNumber(amount / 1000)}k`;
  }
  return `${trimGoalCompactNumber(amount / 1_000_000)}M`;
}

/**
 * @param {Record<string, any> | null | undefined} goal
 * @param {Date} [now]
 */
export function applyGoalEndedAt<T extends { endedAt?: unknown } | null | undefined>(goal: T, now: Date = new Date()): T {
  if (!goal || optionalIsoTimestamp(goal.endedAt)) {
    return goal;
  }
  goal.endedAt = now.toISOString();
  return goal;
}

/**
 * @param {Record<string, any> | null | undefined} goal
 */
export function clearGoalEndedAt<T extends { endedAt?: unknown } | null | undefined>(goal: T): T {
  if (!goal) {
    return goal;
  }
  goal.endedAt = "";
  return goal;
}

/**
 * @param {Record<string, any> | null | undefined} goal
 */
export function bumpGoalRoundCount<T extends { status?: unknown; roundCount?: unknown } | null | undefined>(goal: T): T {
  if (!goal) {
    return goal;
  }
  const status = String(goal.status ?? "");
  if (status === "complete" || status === "failed") {
    return goal;
  }
  goal.roundCount = nonNegativeInteger(goal.roundCount) + 1;
  return goal;
}

/**
 * Previous permission for a Goal enable.
 * Existing sessions use session.permissionMode (ignore a stale client `plan`).
 * A first turn that created the session already as fullAccess uses the client
 * pre-Goal mode when provided, otherwise `plan`.
 *
 * @param {{
 *   alreadyEnabled?: boolean,
 *   storedPrevious?: string,
 *   sessionPermissionMode?: string,
 *   clientPreviousPermissionMode?: string | null,
 *   preferClientForNewSession?: boolean
 * }} input
 */
export function resolveGoalPreviousPermissionMode(input: {
  alreadyEnabled?: boolean,
  storedPrevious?: string,
  sessionPermissionMode?: string,
  clientPreviousPermissionMode?: string | null,
  preferClientForNewSession?: boolean
} = {}) {
  if (input.alreadyEnabled) {
    return normalizeStoredPermissionMode(input.storedPrevious ?? input.sessionPermissionMode ?? "plan");
  }
  if (input.preferClientForNewSession) {
    const client = optionalPermissionMode(input.clientPreviousPermissionMode);
    if (client) {
      return client;
    }
    return "plan";
  }
  return normalizeStoredPermissionMode(input.sessionPermissionMode ?? "plan");
}

/** @param {unknown} value */
function optionalPermissionMode(value: unknown) {
  if (value == null || String(value).trim() === "") {
    return null;
  }
  return normalizeStoredPermissionMode(value);
}

/**
 * @param {{
 *   text?: string,
 *   objective?: string,
 *   previousPermissionMode?: string,
 *   maxAutoContinues?: number,
 *   usage?: unknown,
 *   usageBaseline?: unknown,
 *   startedAt?: string
 * }} [input]
 */
export function enableGoalState(input: {
  text?: string,
  objective?: string,
  previousPermissionMode?: string,
  maxAutoContinues?: number,
  usage?: unknown,
  usageBaseline?: unknown,
  startedAt?: string
} = {}) {
  const text = String(input.text ?? input.objective ?? "").trim();
  if (!text) {
    return null;
  }
  return normalizeSessionGoal({
    enabled: true,
    status: "active",
    text,
    previousPermissionMode: input.previousPermissionMode ?? "plan",
    continueCount: 0,
    roundCount: 0,
    consecutiveFailures: 0,
    hasWrites: false,
    lastEvidence: null,
    lastContinueReason: "",
    lastBlockReason: "",
    clearedBy: "",
    maxAutoContinues: input.maxAutoContinues,
    startedAt: input.startedAt || new Date().toISOString(),
    endedAt: "",
    usageBaseline: input.usageBaseline ?? snapshotGoalUsageBaseline(input.usage)
  }, { hydrateRunningAsPaused: false });
}

/**
 * @param {Record<string, any> | null | undefined} goal
 * @param {{ clearedBy?: string }} [options]
 */
export function disableGoalState(goal: Record<string, unknown> | SessionGoal | null | undefined, options: { clearedBy?: string } = {}) {
  const current = serializeSessionGoal(goal);
  return normalizeSessionGoal({
    ...current,
    enabled: false,
    status: "off",
    clearedBy: options.clearedBy ?? "user",
    lastBlockReason: options.clearedBy ?? current.lastBlockReason
  }, { hydrateRunningAsPaused: false });
}

export type GoalHostContinueState = {
  session?: {
    goal?: SessionGoal | null;
    config?: unknown;
  } | null;
  pendingQuestions?: unknown;
  pendingApprovals?: unknown;
  disposed?: unknown;
  quarantinedTurnId?: unknown;
};

/**
 * @param {Record<string, any>} state
 */
export function shouldSkipGoalContinue(state: GoalHostContinueState | null | undefined) {
  const session = asRecord(state?.session);
  const goal = asRecord(session.goal);
  if (!goal.enabled) return true;
  if (!String(goal.text ?? "").trim()) return true;
  if (!ACTIVE_CONTINUE_STATUSES.has(String(goal.status ?? ""))) return true;
  if (greaterThanZero(sizeOf(state?.pendingQuestions))) return true;
  if (greaterThanZero(sizeOf(state?.pendingApprovals))) return true;
  if (nonNegativeInteger(goal.continueCount) >= resolveGoalMaxAutoContinues(session.config, goal.maxAutoContinues)) return true;
  if (state?.disposed || state?.quarantinedTurnId) return true;
  return false;
}

/**
 * Apply one finished turn to Goal metadata. Does not enqueue the next prompt.
 */
export function applyGoalTurnOutcome(goal: SessionGoal | null | undefined, input: {
  terminalStatus?: string;
  finalOutput?: string;
  liveWorkflow?: unknown;
} = {}) {
  if (!goal?.enabled) {
    return { action: "none", continue: false, recap: false };
  }
  bumpGoalRoundCount(goal);
  const terminalStatus = String(input.terminalStatus ?? "").trim();
  if (terminalStatus === "interrupted") {
    goal.status = "paused";
    goal.lastBlockReason = "user_interrupt";
    return { action: "paused", continue: false, recap: false };
  }
  if (terminalStatus === "blocked" || terminalStatus === "cancelled") {
    goal.status = "paused";
    goal.lastBlockReason = terminalStatus;
    return { action: "paused", continue: false, recap: false };
  }
  if (terminalStatus === "failed") {
    goal.consecutiveFailures = nonNegativeInteger(goal.consecutiveFailures) + 1;
    if (goal.consecutiveFailures >= 3) {
      goal.status = "failed";
      goal.lastBlockReason = "consecutive_failures";
      applyGoalEndedAt(goal);
      return { action: "failed", continue: false, recap: true };
    }
    goal.status = "paused";
    goal.lastBlockReason = "transient_failure";
    return { action: "paused", continue: false, recap: false };
  }
  if (terminalStatus === "completed" || terminalStatus === "") {
    goal.consecutiveFailures = 0;
    const evaluation = evaluateGoalCompletion({
      goal,
      finalOutput: input.finalOutput,
      lastEvidence: goal.lastEvidence,
      liveWorkflow: isRecord(input.liveWorkflow) ? input.liveWorkflow : null
    });
    goal.lastEvidence = evaluation.evidence;
    if (evaluation.complete) {
      goal.status = "complete";
      goal.lastContinueReason = evaluation.reason;
      applyGoalEndedAt(goal);
      return { action: "complete", continue: false, recap: true };
    }
    if (goal.status !== "paused") {
      goal.status = "active";
    }
  }
  return { action: "active", continue: false, recap: false };
}

/**
 * Decide whether the host should start another Goal turn.
 */
export function planGoalHostContinue(state: GoalHostContinueState | null | undefined) {
  const goal = state?.session?.goal;
  if (shouldSkipGoalContinue(state)) {
    if (
      goal?.enabled
      && nonNegativeInteger(goal.continueCount) >= resolveGoalMaxAutoContinues(state?.session?.config, goal.maxAutoContinues)
    ) {
      goal.status = "paused";
      goal.lastBlockReason = "budget";
      applyGoalEndedAt(goal);
      return { action: "budget", continue: false, recap: true };
    }
    return { action: "skip", continue: false, recap: false };
  }
  if (!goal) {
    return { action: "skip", continue: false, recap: false };
  }
  goal.continueCount = nonNegativeInteger(goal.continueCount) + 1;
  goal.status = "running";
  goal.lastContinueReason = "unfinished";
  const prompt = buildGoalContinuePrompt({
    ...goal,
    maxAutoContinues: resolveGoalMaxAutoContinues(state?.session?.config, goal.maxAutoContinues)
  }, {
    lastTurn: "completed",
    hostNotes: goal.lastEvidence?.gaps?.length
      ? goal.lastEvidence.gaps.slice(0, 4)
      : [`remaining todos: ${goal.lastEvidence?.activeItems ?? 0}`]
  });
  return {
    action: "continue",
    continue: true,
    recap: false,
    prompt,
    displayPrompt: `Goal 续跑 · 第 ${goal.continueCount} 轮`
  };
}

/**
 * @param {unknown} content
 */
export function stripGoalStatusFromContent(content: unknown) {
  if (typeof content === "string") {
    return stripGoalStatusMarkers(content);
  }
  if (!Array.isArray(content)) {
    return content;
  }
  return content.map((item) => {
    if (typeof item === "string") {
      return stripGoalStatusMarkers(item);
    }
    if (item && typeof item === "object" && "text" in item) {
      const record = asRecord(item);
      return { ...item, text: stripGoalStatusMarkers(String(record.text ?? "")) };
    }
    return item;
  });
}

/** @param {unknown} text */
export function stripGoalStatusMarkers(text: string) {
  const source = String(text ?? "");
  if (!source) {
    return source;
  }
  const lines = source.split(/\r?\n/);
  const kept: string[] = [];
  let skippingBlock = false;
  for (const line of lines) {
    if (MARKER_LINE.test(line.trim())) {
      skippingBlock = /^GAPS\s*:/i.test(line.trim()) && !line.trim().slice("GAPS:".length).trim();
      continue;
    }
    if (skippingBlock) {
      if (!line.trim() || /^(GOAL_STATUS|EVIDENCE)\s*:/i.test(line.trim())) {
        skippingBlock = false;
        if (!line.trim()) {
          continue;
        }
      } else if (/^\s+/.test(line) || /^-\s+/.test(line.trim())) {
        continue;
      } else {
        skippingBlock = false;
      }
    }
    if (MARKER_LINE.test(line.trim())) {
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

/**
 * @param {string} text
 */
export function parseGoalStatusMarkers(text: string) {
  const source = String(text ?? "");
  let status = "";
  let evidence = "";
  const gaps: string[] = [];
  let inGaps = false;
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^GOAL_STATUS\s*:/i.test(line)) {
      status = line.replace(/^GOAL_STATUS\s*:/i, "").trim().toLowerCase();
      inGaps = false;
      continue;
    }
    if (/^EVIDENCE\s*:/i.test(line)) {
      evidence = line.replace(/^EVIDENCE\s*:/i, "").trim();
      inGaps = false;
      continue;
    }
    if (/^GAPS\s*:/i.test(line)) {
      const rest = line.replace(/^GAPS\s*:/i, "").trim();
      inGaps = true;
      if (rest) gaps.push(rest);
      continue;
    }
    if (inGaps && (line.startsWith("-") || line)) {
      gaps.push(line.replace(/^-\s*/, "").trim());
    } else {
      inGaps = false;
    }
  }
  return {
    status,
    evidence,
    gaps: gaps.filter(Boolean),
    claimedComplete: status === "complete"
  };
}

/**
 * @param {{
 *   goal?: Record<string, any>,
 *   finalOutput?: string,
 *   lastEvidence?: Record<string, any> | null,
 *   liveWorkflow?: Record<string, any> | null
 * }} input
 */
export function evaluateGoalCompletion(input: {
  goal?: Record<string, unknown> | SessionGoal,
  finalOutput?: string,
  lastEvidence?: Record<string, unknown> | GoalEvidence | null,
  liveWorkflow?: Record<string, unknown> | null
} = {}) {
  const goal = serializeSessionGoal(input.goal);
  const parsed = parseGoalStatusMarkers(input.finalOutput ?? "");
  const liveActive = countActiveWorkflowItems(input.liveWorkflow);
  const prior = normalizeGoalEvidence(input.lastEvidence ?? goal.lastEvidence);
  const evidence = {
    claimedComplete: parsed.claimedComplete,
    evidence: truncateText(parsed.evidence, 800),
    gaps: parsed.gaps.slice(0, 12),
    activeItems: liveActive,
    hasWrites: goal.hasWrites === true,
    unresolvedFailures: prior.unresolvedFailures,
    validationFresh: prior.validationFresh,
    lifecycleStage: prior.lifecycleStage
  };
  if (!parsed.claimedComplete) {
    return { complete: false, reason: "not_claimed", evidence };
  }
  if (liveActive > 0) {
    return { complete: false, reason: "pending_work", evidence };
  }
  if (prior.activeItems > 0 && !parsed.evidence) {
    return { complete: false, reason: "stale_todos_without_evidence", evidence };
  }
  if (goal.hasWrites && prior.unresolvedFailures > 0) {
    return { complete: false, reason: "unresolved_failures", evidence };
  }
  if (!parsed.evidence && !goal.hasWrites) {
    return { complete: false, reason: "empty_evidence", evidence };
  }
  return { complete: true, reason: "heuristic_pass", evidence };
}

/**
 * @param {Record<string, any>} goal
 * @param {{ lastTurn?: string, hostNotes?: string[] }} [extras]
 */
export function buildGoalContinuePrompt(goal: Record<string, unknown> | SessionGoal, extras: { lastTurn?: string, hostNotes?: string[] } = {}) {
  const normalized = serializeSessionGoal(goal);
  const nextCount = normalized.continueCount + 1;
  const notes = Array.isArray(extras.hostNotes) ? extras.hostNotes.filter(Boolean) : [];
  return [
    "[Ant Code goal continuation]",
    `goal: ${normalized.text}`,
    "status: in_progress",
    `continueCount: ${nextCount}`,
    `budget: continues=${nextCount}/${resolveGoalMaxAutoContinues(normalized.maxAutoContinues)}`,
    `lastTurn: ${extras.lastTurn ?? "completed"}`,
    "hostNotes:",
    ...(notes.length > 0 ? notes.map((note) => `- ${note}`) : ["- none"]),
    "instruction:",
    "继续推进上述目标。不要重复已完成步骤。",
    "不要仅用文字宣布完成。若你认为已完成，给出可核对证据。",
    "在回复末尾使用下列机器行（对用户不可见）：",
    "GOAL_STATUS: complete|in_progress",
    "EVIDENCE: <可复核证据>",
    "GAPS: <缺口，可空>"
  ].join("\n");
}

export function buildGoalSystemPromptAppendix() {
  return [
    "You are running in Ant Code Goal mode. Work autonomously toward the session goal until it is done.",
    "Do not wait for the user to approve ordinary local tools.",
    "If you need a clarifying question, proceed with the safest assumption; the host skips ask_user.",
    "When you believe the goal is complete, still provide evidence. Append these lines at the end of your final reply:",
    "GOAL_STATUS: complete",
    "EVIDENCE: <files, tests, or commands that prove the claim>",
    "GAPS:",
    "If work remains, use GOAL_STATUS: in_progress and list GAPS."
  ].join("\n");
}

export function goalUnattendedQuestionResult() {
  return {
    answer: "",
    selectedChoice: null,
    selectedChoices: [],
    customAnswer: null,
    cancelled: false,
    skipped: true,
    reason: "goal_unattended",
    workflowReminder: null
  };
}

/** @param {unknown} value */
function normalizeStoredPermissionMode(value: unknown) {
  const mode = String(value ?? "").trim();
  if (mode === "fullAccess" || mode === "full-access" || mode === "完全访问") {
    return "fullAccess";
  }
  if (mode === "workspace" || mode === "workspacePermissions" || mode === "bypassPermissions" || mode === "acceptEdits" || mode === "工作区权限") {
    return "workspace";
  }
  return "plan";
}

/** @param {unknown} value @param {boolean} enabled */
function normalizeGoalStatus(value: unknown, enabled: boolean) {
  const status = String(value ?? "").trim().toLowerCase();
  if (!enabled) {
    return "off";
  }
  if ([
    "active",
    "running",
    "paused",
    "verifying",
    "complete",
    "failed",
    "awaiting_objective",
    "off"
  ].includes(status)) {
    return status;
  }
  return "active";
}

/** @param {unknown} value */
function normalizeGoalEvidence(value: unknown): GoalEvidence {
  const source = asRecord(value);
  return {
    claimedComplete: source.claimedComplete === true,
    evidence: truncateText(source.evidence, 800),
    gaps: Array.isArray(source.gaps) ? source.gaps.map((item: unknown) => String(item)).filter(Boolean).slice(0, 12) : [],
    activeItems: nonNegativeInteger(source.activeItems),
    hasWrites: source.hasWrites === true,
    unresolvedFailures: nonNegativeInteger(source.unresolvedFailures),
    validationFresh: typeof source.validationFresh === "boolean" ? source.validationFresh : null,
    lifecycleStage: source.lifecycleStage == null ? null : String(source.lifecycleStage)
  };
}

/** @param {Record<string, any> | null | undefined} workflow */
function countActiveWorkflowItems(workflow: Record<string, unknown> | null | undefined) {
  const todos = Array.isArray(workflow?.todos) ? workflow.todos : [];
  const plan = asRecord(workflow?.plan);
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  return [...todos, ...steps].filter((item) => {
    const status = String(asRecord(item).status ?? "").toLowerCase();
    return status === "pending" || status === "in_progress";
  }).length;
}

/** @param {unknown} value */
function nonNegativeInteger(value: unknown) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

/** @param {unknown} value */
function optionalIsoTimestamp(value: unknown) {
  const text = String(value ?? "").trim();
  if (!text) {
    return "";
  }
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : "";
}

/** @param {unknown} value */
function normalizeGoalUsageBaseline(value: unknown): GoalUsageBaseline | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return snapshotGoalUsageBaseline(value);
}

/** @param {number} value */
function trimGoalCompactNumber(value: number) {
  const digits = Math.abs(value) >= 100 ? 0 : 1;
  return value.toFixed(digits).replace(/\.0$/, "");
}

/** @param {unknown} value @param {number} max */
function truncateText(value: unknown, max: number) {
  const text = String(value ?? "");
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}
