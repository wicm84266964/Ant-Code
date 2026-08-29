export const GOAL_MAX_AUTO_CONTINUES = 12;
export const GOAL_MIN_AUTO_CONTINUES = 1;
export const GOAL_ABS_MAX_AUTO_CONTINUES = 100;
export const GOAL_CONTINUE_KIND = "goal-continue";

/**
 * @param {...unknown} sources
 */
export function resolveGoalMaxAutoContinues(...sources) {
  for (const source of sources) {
    const record = source && typeof source === "object" ? /** @type {Record<string, any>} */ (source) : null;
    const nested = record
      ? record.agents?.goal?.maxAutoContinues ?? record.goal?.maxAutoContinues ?? record.maxAutoContinues
      : source;
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
export function normalizeSessionGoal(raw, options = {}) {
  const source = /** @type {Record<string, any>} */ (raw && typeof raw === "object" ? raw : {});
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
    maxAutoContinues: resolveGoalMaxAutoContinues(source.maxAutoContinues)
  };
}

/**
 * @param {Record<string, any> | null | undefined} goal
 */
export function serializeSessionGoal(goal) {
  return normalizeSessionGoal(goal, { hydrateRunningAsPaused: false });
}

/**
 * @param {Record<string, any> | null | undefined} goal
 * @param {unknown} [config]
 */
export function publicGoalSnapshot(goal, config) {
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
    hasWrites: normalized.hasWrites
  };
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
export function resolveGoalPreviousPermissionMode(input = {}) {
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
function optionalPermissionMode(value) {
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
 *   maxAutoContinues?: number
 * }} [input]
 */
export function enableGoalState(input = {}) {
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
    maxAutoContinues: input.maxAutoContinues
  }, { hydrateRunningAsPaused: false });
}

/**
 * @param {Record<string, any> | null | undefined} goal
 * @param {{ clearedBy?: string }} [options]
 */
export function disableGoalState(goal, options = {}) {
  const current = serializeSessionGoal(goal);
  return normalizeSessionGoal({
    ...current,
    enabled: false,
    status: "off",
    clearedBy: options.clearedBy ?? "user",
    lastBlockReason: options.clearedBy ?? current.lastBlockReason
  }, { hydrateRunningAsPaused: false });
}

/**
 * @param {Record<string, any>} state
 */
export function shouldSkipGoalContinue(state) {
  const goal = state?.session?.goal;
  if (!goal?.enabled) return true;
  if (!String(goal.text ?? "").trim()) return true;
  if (!ACTIVE_CONTINUE_STATUSES.has(goal.status)) return true;
  if (state.pendingQuestions?.size > 0) return true;
  if (state.pendingApprovals?.size > 0) return true;
  if (nonNegativeInteger(goal.continueCount) >= resolveGoalMaxAutoContinues(state.session?.config, goal.maxAutoContinues)) return true;
  if (state.disposed || state.quarantinedTurnId) return true;
  return false;
}

/**
 * @param {unknown} content
 */
export function stripGoalStatusFromContent(content) {
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
      return { ...item, text: stripGoalStatusMarkers(String(item.text ?? "")) };
    }
    return item;
  });
}

/** @param {unknown} text */
export function stripGoalStatusMarkers(text) {
  const source = String(text ?? "");
  if (!source) {
    return source;
  }
  const lines = source.split(/\r?\n/);
  const kept = [];
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
export function parseGoalStatusMarkers(text) {
  const source = String(text ?? "");
  let status = "";
  let evidence = "";
  const gaps = [];
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
export function evaluateGoalCompletion(input = {}) {
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
export function buildGoalContinuePrompt(goal, extras = {}) {
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
function normalizeStoredPermissionMode(value) {
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
function normalizeGoalStatus(value, enabled) {
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
function normalizeGoalEvidence(value) {
  const source = /** @type {Record<string, any>} */ (value && typeof value === "object" ? value : {});
  return {
    claimedComplete: source.claimedComplete === true,
    evidence: truncateText(source.evidence, 800),
    gaps: Array.isArray(source.gaps) ? source.gaps.map((/** @type {unknown} */ item) => String(item)).filter(Boolean).slice(0, 12) : [],
    activeItems: nonNegativeInteger(source.activeItems),
    hasWrites: source.hasWrites === true,
    unresolvedFailures: nonNegativeInteger(source.unresolvedFailures),
    validationFresh: typeof source.validationFresh === "boolean" ? source.validationFresh : null,
    lifecycleStage: source.lifecycleStage == null ? null : String(source.lifecycleStage)
  };
}

/** @param {Record<string, any> | null | undefined} workflow */
function countActiveWorkflowItems(workflow) {
  const todos = Array.isArray(workflow?.todos) ? workflow.todos : [];
  const steps = Array.isArray(workflow?.plan?.steps) ? workflow.plan.steps : [];
  return [...todos, ...steps].filter((/** @type {Record<string, any>} */ item) => {
    const status = String(item?.status ?? "").toLowerCase();
    return status === "pending" || status === "in_progress";
  }).length;
}

/** @param {unknown} value */
function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

/** @param {unknown} value @param {number} max */
function truncateText(value, max) {
  const text = String(value ?? "");
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}
