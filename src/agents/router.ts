import { listAgentProfiles, type AgentProfile } from "./profiles.ts";
import { resolveAgentBudget } from "./budget.ts";

const ROUTER_VERSION = 2;
const MAX_SUGGESTED_TASKS = 4;

const ROUTE_PATTERNS = Object.freeze({
  web: [
    /联网|网上|网页|搜索|抓取|最新|资料|外部|官网|引用|来源|新闻/i,
    /\b(web|search|fetch|online|latest|source|citation|internet)\b/i
  ],
  browser: [
    /浏览器|页面|前端|截图|点击|输入|UI|界面|验收|localhost|网页交互/i,
    /\b(browser|playwright|screenshot|frontend|ui|localhost|click|dom)\b/i
  ],
  visual: [
    /视觉|看图|图片|图像|截图|界面截图|视觉复核|视觉回归|布局|重叠|遮挡|裁切|溢出|对齐|间距|可读性|响应式|移动端|桌面端/i,
    /\b(vision|visual|image|screenshot|ocr|layout|responsive|viewport|overlap|clipping|alignment|contrast)\b/i
  ],
  repository: [
    /仓库|代码库|调用链|架构|目录|模块|定位|调查|只读|梳理|大项目/i,
    /\b(repo|repository|codebase|inspect|explore|read[- ]?only|call graph)\b/i
  ],
  planning: [
    /计划|拆解|阶段|方案|路线|todo|stage|规划|设计/i,
    /\b(plan|planning|design|stages?|todo|roadmap)\b/i
  ],
  verification: [
    /验证|测试|验收|回归|失败|报错|复现|检查/i,
    /\b(test|verify|validation|failure|repro|regression|check)\b/i
  ],
  implementation: [
    /实现|修复|重构|修改|编辑|写入|补丁|改代码|写代码/i,
    /\b(implement|fix|refactor|edit|patch|write|change)\b/i
  ],
  review: [
    /严格审查|复核|挑错|风险|遗漏|安全审查|代码审查/i,
    /\b(review|audit|critique|risk|findings)\b/i
  ]
});

const PROFILE_KIND_HINTS: Readonly<Record<string, string>> = Object.freeze({
  "web-researcher": "web",
  "readonly-researcher": "web",
  "browser-verifier": "browser",
  "visual-verifier": "visual",
  explorer: "repository",
  planner: "planning",
  verifier: "verification",
  reviewer: "review",
  junior: "implementation",
  "code-worker": "implementation",
  build: "implementation"
});

type RouteSignals = {
  web: boolean;
  browser: boolean;
  visual: boolean;
  repository: boolean;
  planning: boolean;
  verification: boolean;
  implementation: boolean;
  review: boolean;
  [key: string]: boolean;
};

type SuggestedTask = {
  id: string;
  profile: string;
  mode?: string;
  purpose: string;
  difficulty: string;
  risk: string;
  modelTier: unknown;
  budget: unknown;
  title: string;
  query: unknown;
  parallelSafe: boolean;
  outputContract: unknown;
  skills: unknown;
  mcpServers: unknown[];
};

type ScoredProfile = {
  profile: AgentProfile;
  score: number;
  reasons: string[];
};

type TaskOverrides = {
  purpose?: string;
  difficulty?: string;
  risk?: string;
  modelTier?: string;
};

type AgentRouteResult = ReturnType<typeof routeAgentTask>;
type AgentRouteCandidate = AgentRouteResult["candidates"][number];
const EMPTY_TASK_OVERRIDES: TaskOverrides = {};

/**
 * @param {{ cwd: string; config?: Record<string, any>; prompt: string; maxTasks?: number }} options
 */
export function routeAgentTask(options: { cwd: string; config?: Record<string, unknown>; prompt: string; maxTasks?: number }) {
  const prompt = String(options.prompt ?? "").trim();
  const profiles = listAgentProfiles(options.config, {
    cwd: options.cwd,
    includeHidden: false
  });
  const signals = classifyPrompt(prompt);
  const scored = profiles
    .map((profile) => scoreProfile(profile, signals, prompt))
    .filter((item) => item.score > 0)
    .sort((left: ScoredProfile, right: ScoredProfile) => right.score - left.score || left.profile.name.localeCompare(right.profile.name));

  const primary = scored[0]?.profile ?? fallbackProfile(profiles, signals);
  const purpose = inferPurpose(signals);
  const difficulty = inferDifficulty(prompt, signals);
  const risk = inferRisk(prompt, signals);
  const modelTier = inferModelTier({ profiles, primary, purpose, difficulty, risk, config: options.config });
  const budget = resolveAgentBudget({
    config: options.config,
    profile: primary,
    routeDecision: {
      profile: primary?.name,
      purpose,
      difficulty,
      risk,
      modelTier
    }
  });
  const secondary = scored
    .map((item) => item.profile)
    .filter((profile) => profile.name !== primary?.name)
    .slice(0, 3);
  const taskCount = Math.min(options.maxTasks ?? MAX_SUGGESTED_TASKS, MAX_SUGGESTED_TASKS);
  const suggestedTasks = buildSuggestedTasks({
    prompt,
    signals,
    primary,
    secondary,
    profiles,
    config: options.config,
    taskCount
  });

  return {
    version: ROUTER_VERSION,
    prompt,
    signals,
    primaryProfile: primary?.name ?? null,
    decision: {
      profile: primary?.name ?? null,
      purpose,
      difficulty,
      risk,
      modelTier,
      budget,
      requiresApproval: risk !== "low" || purpose === "execute" || purpose === "browser" || purpose === "visual",
      reason: routeReason({ primary, purpose, difficulty, risk, modelTier })
    },
    candidates: scored.slice(0, 8).map((item) => ({
      profile: item.profile.name,
      mode: item.profile.mode,
      score: item.score,
      reasons: item.reasons
    })),
    suggestedTasks,
    parallelizable: suggestedTasks.filter((task) => task.parallelSafe).length >= 2,
    reviewRecommended: shouldRecommendReviewer({ prompt, signals, risk, suggestedTasks, config: options.config }),
    riskNotes: routeRiskNotes(suggestedTasks)
  };
}

export function formatAgentRoute(route: unknown) {
  if (!isAgentRouteResult(route)) {
    return "没有可用的子智能体路由结果。";
  }
  const tasks = Array.isArray(route.suggestedTasks) ? route.suggestedTasks : [];
  const candidates = Array.isArray(route.candidates) ? route.candidates : [];
  const budget = route.decision?.budget;
  return [
    "Ant Code 子智能体路由",
    "",
    `主推荐：${route.primaryProfile ?? "无"}`,
    route.decision ? `路由决策：${route.decision.purpose}/${route.decision.difficulty}/${route.decision.risk} model=${route.decision.modelTier}` : null,
    isPlainObject(budget) ? `预算：rounds=${formatBudgetLimit(budget.maxRounds)} tools=${formatBudgetLimit(budget.maxToolCalls)} duration=${budget.maxDurationMs}ms` : null,
    `信号：${Object.entries(route.signals ?? {}).filter(([, value]) => value).map(([key]) => key).join(", ") || "general"}`,
    `可并行：${route.parallelizable ? "是" : "否"}`,
    `建议复核：${route.reviewRecommended ? "是" : "否"}`,
    "",
    "候选",
    ...(candidates.length === 0
      ? ["- 暂无匹配候选。"]
      : candidates.map((item: AgentRouteCandidate) => `- ${item.profile} [score=${item.score}] - ${item.reasons.join("；")}`)),
    "",
    "建议子任务",
    ...(tasks.length === 0
      ? ["- 暂无建议子任务。"]
      : tasks.map((task: SuggestedTask, index: number) => `- ${index + 1}. ${task.profile} [${task.purpose}/${task.difficulty}/${task.risk}] ${task.parallelSafe ? "parallel" : "serial"} - ${task.title}`)),
    "",
    "风险提示",
    ...(route.riskNotes?.length ? route.riskNotes.map((note: string) => `- ${note}`) : ["- 无额外风险。"]),
    "",
    "执行方式",
    "- /agents run <profile> <任务> 可手动执行单个子任务。",
    "- /agents orchestrate <任务> 会按只读优先原则启动可并行的建议子任务。"
  ].filter((item) => item !== null).join("\n");
}

function formatBudgetLimit(value: unknown) {
  return Number.isFinite(value) ? String(value) : "无限制";
}

function isAgentRouteResult(value: unknown): value is AgentRouteResult {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function agentRouting(config?: Record<string, unknown>) {
  const agents = isPlainObject(config?.agents) ? config.agents : undefined;
  return isPlainObject(agents?.routing) ? agents.routing : undefined;
}

function classifyPrompt(prompt: string): RouteSignals {
  const value = prompt || "";
  return Object.fromEntries(Object.entries(ROUTE_PATTERNS).map(([kind, patterns]) => [
    kind,
    patterns.some((pattern) => pattern.test(value))
  ])) as RouteSignals;
}

function scoreProfile(profile: AgentProfile, signals: RouteSignals, prompt: string): ScoredProfile {
  const reasons = [];
  let score = 0;
  const kind = PROFILE_KIND_HINTS[profile.name];
  if (kind && signals[kind]) {
    score += 10;
    reasons.push(`命中 ${kind} 场景`);
  }
  if (profile.mode === "readonly" && (signals.repository || signals.web || signals.planning)) {
    score += 2;
    reasons.push("只读任务优先");
  }
  if (profile.mode === "execute" && (signals.browser || signals.visual || signals.verification)) {
    score += 4;
    reasons.push("需要执行/验收能力");
  }
  if (profile.mode === "write-capable" && signals.implementation) {
    score += 4;
    reasons.push("任务可能需要修改代码");
  }
  if (profile.name === "web-researcher" && signals.web) {
    score += 3;
    reasons.push("专用联网研究 profile");
  }
  if (profile.name === "browser-verifier" && signals.browser) {
    score += 3;
    reasons.push("专用浏览器验收 profile");
  }
  if (profile.name === "visual-verifier" && signals.visual) {
    score += 8;
    reasons.push("专用视觉复核 profile");
  }
  if (profile.name === "visual-verifier" && signals.browser && (signals.review || signals.verification)) {
    score += 3;
    reasons.push("前端复核可使用视觉模型");
  }
  if (profile.name === "reviewer" && signals.review) {
    score += 8;
    reasons.push("专用严格复核 profile");
  }
  if (profile.name === "junior" && signals.implementation) {
    score += 6;
    reasons.push("专用执行型 profile");
  }
  for (const hint of profile.triggerHints ?? []) {
    if (hint && prompt.toLowerCase().includes(String(hint).toLowerCase())) {
      score += 3;
      reasons.push(`触发提示：${hint}`);
      break;
    }
  }
  if ((profile.skills ?? []).length > 0 && (signals.web || signals.browser || signals.verification || signals.repository)) {
    score += 1;
    reasons.push("有相关 skill");
  }
  return { profile, score, reasons };
}

function fallbackProfile(profiles: AgentProfile[], signals: RouteSignals) {
  const names = [
    signals.visual ? "visual-verifier" : null,
    signals.browser ? "browser-verifier" : null,
    signals.web ? "web-researcher" : null,
    signals.planning ? "planner" : null,
    signals.verification ? "verifier" : null,
    signals.review ? "reviewer" : null,
    signals.implementation ? "junior" : null,
    signals.implementation ? "code-worker" : null,
    "explorer"
  ].filter((name): name is string => Boolean(name));
  for (const name of names) {
    const profile = profiles.find((item) => item.name === name);
    if (profile) {
      return profile;
    }
  }
  return profiles[0] ?? null;
}

function buildSuggestedTasks({ prompt, signals, primary, secondary, profiles, config, taskCount }: {
  prompt: string;
  signals: RouteSignals;
  primary?: AgentProfile | null;
  secondary: AgentProfile[];
  profiles: AgentProfile[];
  config?: Record<string, unknown>;
  taskCount: number;
}) {
  const tasks: SuggestedTask[] = [];
  const routeDifficulty = inferDifficulty(prompt, signals);
  const routeRisk = inferRisk(prompt, signals);
  const add = (profileName: unknown, title: string, query: unknown, parallelSafe: boolean = true, overrides: TaskOverrides = EMPTY_TASK_OVERRIDES) => {
    const profile = profiles.find((item) => item.name === profileName || (typeof profileName === "string" && item.aliases?.includes(profileName)));
    if (!profile || tasks.some((task) => task.profile === profile.name)) {
      return;
    }
    const purpose = overrides.purpose ?? profile.purpose ?? kindToPurpose(PROFILE_KIND_HINTS[profile.name]);
    const difficulty = overrides.difficulty ?? routeDifficulty;
    const risk = overrides.risk ?? routeRisk;
    const modelTier = overrides.modelTier ?? inferModelTier({ profiles, primary: profile, purpose, difficulty, risk, config });
    const budget = resolveAgentBudget({
      config,
      profile,
      routeDecision: { profile: profile.name, purpose, difficulty, risk, modelTier }
    });
    tasks.push({
      id: `route-${tasks.length + 1}`,
      profile: profile.name,
      mode: profile.mode,
      purpose,
      difficulty,
      risk,
      modelTier,
      budget,
      title,
      query,
      parallelSafe: parallelSafe && profile.mode === "readonly",
      outputContract: profile.outputContract ?? null,
      skills: profile.skills ?? [],
      mcpServers: profile.mcpServers ?? []
    });
  };

  if (signals.web) {
    add("web-researcher", "搜索和抓取外部资料", `围绕用户任务做联网资料收集，给出来源、可信度和关键结论：\n${prompt}`);
  }
  if (signals.browser) {
    add("browser-verifier", "执行浏览器/前端验收", `围绕用户任务做浏览器或前端交互验收，记录步骤和观察：\n${prompt}`, false);
  }
  if (signals.visual) {
    add("visual-verifier", "执行视觉证据复核", `使用视觉模型围绕用户任务复核截图、图片、UI 布局或视觉回归证据；输出可供主智能体直接决策的视觉结论：\n${prompt}`, false, { purpose: "visual", modelTier: "vision" });
  }
  if (signals.repository || signals.implementation || signals.verification) {
    add("explorer", "只读调查相关代码路径", `只读调查当前仓库与用户任务相关的文件、调用链和风险：\n${prompt}`);
  }
  if (shouldSuggestPlannerPackage({ signals, difficulty: routeDifficulty, risk: routeRisk, prompt })) {
    add("planner", "生成复杂任务计划包", `基于父智能体已确认的需求和只读调查结果，生成 requirementsDoc、taskPlanDoc、executionChecklist、traceabilityMap 和 handoffPrompt：\n${prompt}`);
  }
  if (signals.verification) {
    add("verifier", "运行或设计验证步骤", `围绕用户任务运行或设计最小验证步骤，解释失败原因：\n${prompt}`, false, { purpose: "verify" });
  }
  if (signals.review) {
    add("reviewer", "严格复核计划或改动", `只读严格复核用户任务涉及的计划、改动、风险和测试缺口：\n${prompt}`, true, { purpose: "review", risk: "high", modelTier: "strong" });
  }
  if (signals.implementation) {
    add("junior", "执行局部代码修改", `在父会话权限允许后执行局部实现或修复，并报告改动文件。若未提供 writeScope，不要写文件并向主智能体说明需要范围：\n${prompt}`, false, { purpose: "execute" });
  }
  if (shouldRecommendReviewer({ prompt, signals, risk: routeRisk, suggestedTasks: tasks }) && tasks.length < taskCount) {
    add("reviewer", "高风险任务严格复核", `只读复核该任务的风险、遗漏和验收缺口：\n${prompt}`, true, { purpose: "review", risk: "high", modelTier: "strong" });
  }
  if (tasks.length === 0 && primary && !(primary.name === "planner" && !shouldSuggestPlannerPackage({ signals, difficulty: routeDifficulty, risk: routeRisk, prompt }))) {
    add(primary.name, "处理用户任务", prompt, primary.mode === "readonly");
  }
  for (const profile of secondary) {
    if (tasks.length >= taskCount) {
      break;
    }
    add(profile.name, `补充 ${profile.description}`, prompt, profile.mode === "readonly");
  }
  return tasks.slice(0, taskCount);
}

function inferPurpose(signals: RouteSignals) {
  if (signals.visual) return "visual";
  if (signals.review) return "review";
  if (signals.browser) return "browser";
  if (signals.web) return "research";
  if (signals.planning) return "plan";
  if (signals.verification) return "verify";
  if (signals.implementation) return "execute";
  return "explore";
}

function inferDifficulty(prompt: string, signals: RouteSignals) {
  const text = String(prompt ?? "");
  if (/复杂|深度|跨模块|架构|大改|重构|长任务|全面|严格|deep|complex|architecture|large|refactor/i.test(text)) {
    return "deep";
  }
  if (/简单|快速|小改|单文件|quick|simple|tiny|typo/i.test(text)) {
    return "quick";
  }
  if (signals.implementation && (signals.repository || signals.planning || signals.verification)) {
    return "deep";
  }
  return signals.implementation || signals.browser || signals.visual || signals.web ? "standard" : "quick";
}

function inferRisk(prompt: string, signals: RouteSignals) {
  const text = String(prompt ?? "");
  if (/权限|密钥|token|cookie|auth|security|permission|mcp|install|global|发布|release|删除|移动|remove|delete|credential/i.test(text)) {
    return "high";
  }
  if (signals.implementation || signals.browser || signals.visual || signals.verification) {
    return "medium";
  }
  return "low";
}

function shouldSuggestPlannerPackage({ signals, difficulty, risk, prompt }: { signals: RouteSignals; difficulty?: unknown; risk?: unknown; prompt?: string }) {
  if (risk === "high" || difficulty === "deep") {
    return signals.planning || signals.implementation || signals.repository || signals.review || signals.verification;
  }
  const text = String(prompt ?? "");
  if (/超长|多阶段|多个阶段|执行清单|需求清单|计划包|可追溯|phase|phases|stage|stages|checklist|traceability/i.test(text)) {
    return true;
  }
  return false;
}

function inferModelTier({ primary, purpose, difficulty, risk, config }: {
  primary?: AgentProfile | null;
  purpose?: unknown;
  difficulty?: unknown;
  risk?: unknown;
  config?: Record<string, unknown>;
  profiles?: AgentProfile[];
}) {
  if (primary?.modelTier && primary.modelTier !== "default") {
    return primary.modelTier;
  }
  const routing = agentRouting(config);
  if (risk === "high" && routing?.strongForHighRisk !== false) {
    return "strong";
  }
  if (difficulty === "deep") {
    return "strong";
  }
  if ((purpose === "explore" || purpose === "research") && routing?.preferCheapForReadonly !== false) {
    return "cheap";
  }
  if (primary?.modelTier) {
    return primary.modelTier;
  }
  return "default";
}

function kindToPurpose(kind: string | undefined) {
  if (kind === "web") return "research";
  if (kind === "browser") return "browser";
  if (kind === "visual") return "visual";
  if (kind === "planning") return "plan";
  if (kind === "verification") return "verify";
  if (kind === "implementation") return "execute";
  return "explore";
}

function routeReason({ primary, purpose, difficulty, risk, modelTier }: {
  primary?: AgentProfile | null;
  purpose?: unknown;
  difficulty?: unknown;
  risk?: unknown;
  modelTier?: unknown;
}) {
  return [
    primary ? `profile=${primary.name}` : "profile=none",
    `purpose=${purpose}`,
    `difficulty=${difficulty}`,
    `risk=${risk}`,
    `modelTier=${modelTier}`
  ].join("; ");
}

function shouldRecommendReviewer({ prompt, signals, risk, suggestedTasks, config }: {
  prompt?: string;
  signals: RouteSignals;
  risk?: unknown;
  suggestedTasks?: SuggestedTask[];
  config?: Record<string, unknown>;
}) {
  if (agentRouting(config)?.reviewerForHighRisk === false) {
    return false;
  }
  if (risk === "high" || signals.review) {
    return true;
  }
  if (suggestedTasks?.some((task) => task.mode === "write-capable" && task.difficulty === "deep")) {
    return true;
  }
  return /严格|交付|验收通过|最终|release|review/i.test(String(prompt ?? ""));
}

function routeRiskNotes(tasks: SuggestedTask[]) {
  const notes: string[] = [];
  if (tasks.some((task) => task.mode === "write-capable")) {
    notes.push("写入型子任务仍需要父会话权限；不会绕过文件编辑审批。");
  }
  if (tasks.some((task) => task.mode === "execute")) {
    notes.push("执行型子任务可能触发 shell、浏览器或网络审批。");
  }
  if (tasks.some((task) => (task.mcpServers ?? []).length > 0)) {
    notes.push("MCP 调用只会使用 profile 声明的服务器，并受工具风险策略限制。");
  }
  if (tasks.filter((task) => task.parallelSafe).length >= 2) {
    notes.push("多个只读子任务可并行启动，完整日志写入任务记录，主聊天只显示摘要。");
  }
  return notes;
}
