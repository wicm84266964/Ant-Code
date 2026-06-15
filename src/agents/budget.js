export const DEFAULT_AGENT_BUDGET = Object.freeze({
  maxRounds: null,
  maxToolCalls: null,
  maxDurationMs: 1_800_000,
  maxOutputBytes: 320_000,
  maxToolResultBytes: 16_000,
  maxReadFileBytes: 12_288,
  maxWebFetchBytes: 96_000,
  maxSearchResults: 5,
  maxFileMatches: 30,
  maxConsecutiveFailures: 6,
  maxPermissionDenials: 6
});

const BUILTIN_BUDGETS = Object.freeze({
  "explorer.quick": { maxDurationMs: 600_000, maxOutputBytes: 192_000, maxToolResultBytes: 12_000, maxReadFileBytes: 8_192 },
  "explorer.deep": { maxDurationMs: 1_800_000, maxOutputBytes: 360_000, maxToolResultBytes: 16_000, maxReadFileBytes: 12_288 },
  "readonly-researcher.standard": { maxDurationMs: 1_200_000, maxOutputBytes: 320_000, maxToolResultBytes: 16_000, maxReadFileBytes: 12_288 },
  "web-researcher.standard": { maxDurationMs: 1_200_000, maxOutputBytes: 256_000, maxToolResultBytes: 12_000, maxWebFetchBytes: 80_000, maxPermissionDenials: 6, maxConsecutiveFailures: 6 },
  "planner.standard": { maxDurationMs: 900_000 },
  "junior.quick": { maxDurationMs: 1_200_000 },
  "junior.deep": { maxDurationMs: 2_700_000 },
  "code-worker.quick": { maxDurationMs: 1_200_000 },
  "code-worker.deep": { maxDurationMs: 2_700_000 },
  "verifier.standard": { maxDurationMs: 1_800_000 },
  "reviewer.high": { maxDurationMs: 1_500_000 },
  "browser-verifier.standard": { maxDurationMs: 1_800_000 },
  "visual-verifier.standard": { maxDurationMs: 1_800_000, maxOutputBytes: 220_000, maxToolResultBytes: 12_000 }
});

/**
 * @param {{ config?: Record<string, any>; profile?: Record<string, any>; routeDecision?: Record<string, any>; difficulty?: string; risk?: string }} options
 */
export function resolveAgentBudget(options = {}) {
  const config = options.config ?? {};
  const profile = options.profile ?? {};
  const difficulty = String(options.difficulty ?? options.routeDecision?.difficulty ?? "standard");
  const risk = String(options.risk ?? options.routeDecision?.risk ?? "medium");
  const budgetConfig = config.agents?.budgets ?? {};
  const profileName = String(profile.name ?? options.routeDecision?.profile ?? "agent");
  const aliases = Array.isArray(profile.aliases) ? profile.aliases.map(String) : [];
  const keys = [
    `${profileName}.${difficulty}`,
    `${profileName}.${risk}`,
    ...aliases.flatMap((alias) => [`${alias}.${difficulty}`, `${alias}.${risk}`]),
    profileName,
    ...aliases
  ];

  let budget = {
    ...DEFAULT_AGENT_BUDGET,
    ...normalizeBudget(budgetConfig.defaults),
    ...normalizeBudget(profile.budget),
    ...normalizeBudget(profile)
  };
  for (const key of keys) {
    budget = {
      ...budget,
      ...normalizeBudget(BUILTIN_BUDGETS[key]),
      ...normalizeBudget(budgetConfig[key])
    };
  }
  budget = {
    ...budget,
    ...normalizeBudget(options.routeDecision?.budget)
  };

  if (Number.isInteger(config.agents?.maxRounds) && config.agents.maxRounds > 0) {
    budget.maxRounds = config.agents.maxRounds;
  }

  return normalizeBudget(budget, DEFAULT_AGENT_BUDGET);
}

/**
 * @param {Record<string, any>} config
 * @param {Record<string, any>} routeDecision
 * @param {Record<string, any>} profile
 */
export function resolveAgentModel(config, routeDecision = {}, profile = {}) {
  if (typeof profile.model === "string" && profile.model.trim()) {
    return profile.model.trim();
  }
  const tier = String(routeDecision.modelTier ?? profile.modelTier ?? "default");
  if (isVisionProfile(profile) || tier === "vision") {
    const visionModel = config.agents?.vision?.enabled === false ? "" : String(config.agents?.vision?.model ?? "").trim();
    if (visionModel) {
      return visionModel;
    }
  }
  const model = config.agents?.modelTiers?.[tier];
  return typeof model === "string" && model.trim() ? model.trim() : config.modelAlias;
}

function isVisionProfile(profile = {}) {
  if (profile.name === "visual-verifier" || profile.purpose === "visual") {
    return true;
  }
  return Array.isArray(profile.aliases) && profile.aliases.some((alias) => /^(?:vision|vision-verifier|visual-reviewer|screenshot-reviewer)$/i.test(String(alias)));
}

/**
 * @param {ReturnType<typeof resolveAgentBudget>} budget
 */
export function createBudgetTracker(budget) {
  return {
    budget,
    startedAt: Date.now(),
    toolCalls: 0,
    outputBytes: 0,
    consecutiveFailures: 0,
    permissionDenials: 0
  };
}

/**
 * @param {ReturnType<typeof createBudgetTracker>} tracker
 * @param {{ round?: number; pendingToolCalls?: number }} [state]
 */
export function checkBudget(tracker, state = {}) {
  const budget = tracker.budget;
  if (Number.isInteger(budget.maxRounds) && budget.maxRounds > 0 && Number.isInteger(state.round) && state.round >= budget.maxRounds) {
    return exceeded("maxRounds", `已达到子任务模型-工具循环上限 ${budget.maxRounds} 轮。`, budget.maxRounds);
  }
  if (Number.isInteger(budget.maxToolCalls) && budget.maxToolCalls > 0 && tracker.toolCalls + (state.pendingToolCalls ?? 0) > budget.maxToolCalls) {
    return exceeded("maxToolCalls", `继续执行将超过工具调用上限 ${budget.maxToolCalls} 次。`, budget.maxToolCalls);
  }
  if (Date.now() - tracker.startedAt > budget.maxDurationMs) {
    return exceeded("maxDurationMs", `子任务运行时间已超过 ${budget.maxDurationMs}ms。`, budget.maxDurationMs);
  }
  if (tracker.outputBytes > budget.maxOutputBytes) {
    return exceeded("maxOutputBytes", `子任务工具输出已超过 ${budget.maxOutputBytes} bytes。`, budget.maxOutputBytes);
  }
  if (tracker.consecutiveFailures >= budget.maxConsecutiveFailures) {
    return exceeded("maxConsecutiveFailures", `连续工具失败已达到 ${budget.maxConsecutiveFailures} 次。`, budget.maxConsecutiveFailures);
  }
  if (tracker.permissionDenials >= budget.maxPermissionDenials) {
    return exceeded("maxPermissionDenials", `权限拒绝已达到 ${budget.maxPermissionDenials} 次。`, budget.maxPermissionDenials);
  }
  return null;
}

/**
 * @param {ReturnType<typeof createBudgetTracker>} tracker
 * @param {{ ok?: boolean; blocked?: boolean; error?: Record<string, any> }} execution
 * @param {{ content?: string }} serialized
 */
export function recordBudgetToolResult(tracker, execution, serialized = {}) {
  tracker.toolCalls += 1;
  tracker.outputBytes += Buffer.byteLength(String(serialized.content ?? ""), "utf8");
  if (execution?.ok === true) {
    tracker.consecutiveFailures = 0;
  } else {
    tracker.consecutiveFailures += 1;
  }
  if (execution?.blocked === true || execution?.decision?.decision === "deny") {
    tracker.permissionDenials += 1;
  }
  return tracker;
}

function normalizeBudget(value, fallback = {}) {
  const item = value && typeof value === "object" ? value : {};
  const result = { ...fallback };
  for (const key of [
    "maxRounds",
    "maxToolCalls",
    "maxDurationMs",
    "maxOutputBytes",
    "maxToolResultBytes",
    "maxReadFileBytes",
    "maxWebFetchBytes",
    "maxSearchResults",
    "maxFileMatches",
    "maxConsecutiveFailures",
    "maxPermissionDenials"
  ]) {
    const number = Number(item[key]);
    if (Number.isInteger(number) && number > 0) {
      result[key] = number;
    } else if ((key === "maxRounds" || key === "maxToolCalls") && item[key] === null) {
      result[key] = null;
    }
  }
  return result;
}

function exceeded(kind, message, limit) {
  return {
    kind,
    message,
    limit
  };
}
