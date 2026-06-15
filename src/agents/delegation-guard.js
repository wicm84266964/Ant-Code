import path from "node:path";

const DEFAULT_SOFT_THRESHOLD = 3;
const DEFAULT_STRONG_THRESHOLD = 5;

const BROAD_DIRS = new Set([".", "", "src", "app", "apps", "packages", "lib", "libs", "components", "features", "server", "client"]);
const BROAD_GLOB_PATTERNS = [
  /^\*\*\/\*$/,
  /^\*\*\/\*\.[A-Za-z0-9]+$/,
  /^\*\*\/\*\*$/,
  /^\*\*\/[^/]*\*[^/]*$/,
  /^\*{1,2}\//
];
const BROAD_COMMAND_PATTERNS = [
  /\brg\b/i,
  /\bgrep\s+-R\b/i,
  /\bgit\s+grep\b/i,
  /\bGet-ChildItem\b[\s\S]*-Recurse\b/i,
  /\bdir\s+\/s\b/i,
  /\bfindstr\b[\s\S]*\/s\b/i,
  /\bcurl\b\s+https?:\/\//i,
  /\bwget\b\s+https?:\/\//i,
  /\bInvoke-WebRequest\b/i,
  /\biwr\b\s+https?:\/\//i
];
const RESEARCH_HOST_PATTERNS = [
  /github\.com$/i,
  /raw\.githubusercontent\.com$/i,
  /api\.github\.com$/i,
  /docs?\./i,
  /developer\./i,
  /npmjs\.com$/i,
  /pypi\.org$/i,
  /arxiv\.org$/i,
  /pubmed\.ncbi\.nlm\.nih\.gov$/i,
  /readthedocs\.io$/i
];
const COMPLEX_PROMPT_PATTERN = /全面|整个项目|全仓|排查|审计|重构|对比|架构|安全|性能|长任务|所有文件|多模块|联网|最新|调研|full|entire|audit|refactor|architecture|security|performance|investigate|all files|codebase|research|current|latest/i;

export function createDelegationGuard(options = {}) {
  const config = normalizeDelegationGuardConfig(options.config);
  const state = {
    config,
    sessionId: options.sessionId ?? null,
    cwd: options.cwd ?? process.cwd(),
    prompt: String(options.prompt ?? ""),
    complexPrompt: COMPLEX_PROMPT_PATTERN.test(String(options.prompt ?? "")),
    broadActions: 0,
    networkActions: 0,
    repositoryActions: 0,
    readFiles: new Set(),
    readBytesEstimate: 0,
    grepPatterns: new Set(),
    delegated: false,
    softShown: false,
    strongShown: false,
    observations: []
  };

  return {
    get state() {
      return state;
    },
    observeToolResult(toolName, input = {}, execution = {}) {
      if (!state.config.enabled) {
        return null;
      }
      const observation = classifyToolUse(toolName, input, execution, {
        cwd: state.cwd,
        complexPrompt: state.complexPrompt,
        readFiles: state.readFiles,
        grepPatterns: state.grepPatterns
      });
      if (observation.delegated) {
        state.delegated = true;
        return null;
      }
      if (!observation.broad) {
        return null;
      }
      state.broadActions += observation.weight;
      if (observation.category === "network") {
        state.networkActions += observation.weight;
      } else if (observation.category === "repository") {
        state.repositoryActions += observation.weight;
      }
      if (observation.readPath) {
        state.readFiles.add(observation.readPath);
      }
      if (observation.readBytesEstimate > 0) {
        state.readBytesEstimate += observation.readBytesEstimate;
      }
      if (observation.grepPattern) {
        state.grepPatterns.add(observation.grepPattern);
      }
      state.observations.push({
        toolName,
        category: observation.category,
        reason: observation.reason,
        weight: observation.weight,
        broadActions: state.broadActions
      });
      return buildReminderIfNeeded(state, observation);
    }
  };
}

export function normalizeDelegationGuardConfig(config = {}) {
  const raw = config?.agents?.delegationGuard ?? {};
  const enabled = raw.enabled !== false;
  const mode = raw.mode === "off" || raw.mode === "disabled" ? "off" : "remind";
  const softThreshold = positiveInteger(raw.softThreshold, DEFAULT_SOFT_THRESHOLD);
  const strongThreshold = Math.max(softThreshold + 1, positiveInteger(raw.strongThreshold, DEFAULT_STRONG_THRESHOLD));
  return {
    enabled: enabled && mode !== "off",
    mode,
    softThreshold,
    strongThreshold
  };
}

export function classifyToolUse(toolName, input = {}, execution = {}, context = {}) {
  const name = String(toolName ?? "");
  if (name === "agent_run") {
    return { broad: false, delegated: execution?.ok !== false };
  }
  if (name === "web_search") {
    return {
      broad: true,
      category: "network",
      reason: "web_search is broad external research",
      weight: context.complexPrompt ? 2 : 1
    };
  }
  if (name === "web_fetch") {
    return classifyWebFetch(input, context);
  }
  if (name === "list_files") {
    return classifyListFiles(input, context);
  }
  if (name === "glob") {
    return classifyGlob(input, context);
  }
  if (name === "grep") {
    return classifyGrep(input, context);
  }
  if (name === "read_file") {
    return classifyReadFile(input, execution, context);
  }
  if (name === "bash" || name === "powershell") {
    return classifyShell(input, context);
  }
  return { broad: false };
}

export function appendDelegationReminderToExecution(execution, reminder) {
  if (!reminder || !execution || typeof execution !== "object") {
    return execution;
  }
  const existing = execution.result && typeof execution.result === "object" && !Array.isArray(execution.result)
    ? execution.result
    : { value: execution.result };
  return {
    ...execution,
    result: {
      ...existing,
      delegationGuard: {
        level: reminder.level,
        reason: reminder.reason,
        broadActions: reminder.broadActions,
        suggestedProfiles: reminder.suggestedProfiles
      },
      systemReminder: reminder.text
    }
  };
}

function classifyWebFetch(input, context) {
  const url = safeUrl(input.url);
  if (!url) {
    return { broad: false };
  }
  const host = url.hostname.toLowerCase();
  const researchHost = RESEARCH_HOST_PATTERNS.some((pattern) => pattern.test(host));
  if (!context.complexPrompt && !researchHost) {
    return { broad: false };
  }
  return {
    broad: true,
    category: "network",
    reason: researchHost ? `research-like host ${host}` : "web_fetch during complex external task",
    weight: researchHost && context.complexPrompt ? 2 : 1
  };
}

function classifyListFiles(input, context) {
  const target = normalizeRelativePath(input.path ?? ".");
  if (!isBroadDirectory(target)) {
    return { broad: false };
  }
  return {
    broad: true,
    category: "repository",
    reason: `list_files on broad directory ${target || "."}`,
    weight: context.complexPrompt ? 2 : 1
  };
}

function classifyGlob(input, context) {
  const pattern = String(input.pattern ?? "").replace(/\\/g, "/").trim();
  const target = normalizeRelativePath(input.path ?? ".");
  const broadPattern = BROAD_GLOB_PATTERNS.some((regex) => regex.test(pattern));
  if (!broadPattern && !isBroadDirectory(target)) {
    return { broad: false };
  }
  return {
    broad: true,
    category: "repository",
    reason: broadPattern ? `broad glob pattern ${pattern}` : `glob in broad directory ${target || "."}`,
    weight: context.complexPrompt ? 2 : 1
  };
}

function classifyGrep(input, context) {
  const target = normalizeRelativePath(input.path ?? ".");
  const pattern = String(input.pattern ?? "");
  const seenPatterns = context.grepPatterns instanceof Set ? context.grepPatterns : new Set();
  if (!isBroadDirectory(target) && !context.complexPrompt && seenPatterns.size < 2) {
    return { broad: false, grepPattern: pattern };
  }
  return {
    broad: true,
    category: "repository",
    reason: isBroadDirectory(target) ? `grep in broad directory ${target || "."}` : "repeated grep exploration",
    weight: context.complexPrompt ? 2 : 1,
    grepPattern: pattern
  };
}

function classifyReadFile(input, execution, context) {
  const readPath = normalizeRelativePath(input.path ?? "");
  if (!readPath) {
    return { broad: false };
  }
  const readBytesEstimate = estimateReadBytes(execution, input);
  const readFiles = context.readFiles instanceof Set ? context.readFiles : new Set();
  const nextUniqueCount = readFiles.has(readPath) ? readFiles.size : readFiles.size + 1;
  const broadByCount = context.complexPrompt ? nextUniqueCount >= 2 : nextUniqueCount >= 3;
  const broadByBytes = readBytesEstimate >= (context.complexPrompt ? 16_000 : 32_000);
  if (!broadByCount && !broadByBytes) {
    return { broad: false, readPath, readBytesEstimate };
  }
  return {
    broad: true,
    category: "repository",
    reason: broadByBytes ? `large read_file output ${readBytesEstimate} bytes` : `multiple read_file calls (${nextUniqueCount} files)`,
    weight: broadByBytes ? 2 : 1,
    readPath,
    readBytesEstimate
  };
}

function classifyShell(input, context) {
  const command = String(input.command ?? "");
  const matched = BROAD_COMMAND_PATTERNS.find((pattern) => pattern.test(command));
  if (!matched) {
    return { broad: false };
  }
  const category = /https?:\/\//i.test(command) || /\b(curl|wget|Invoke-WebRequest|iwr)\b/i.test(command)
    ? "network"
    : "repository";
  return {
    broad: true,
    category,
    reason: "shell command looks like broad search/fetch",
    weight: context.complexPrompt ? 2 : 1
  };
}

function buildReminderIfNeeded(state, observation) {
  if (state.delegated) {
    return null;
  }
  if (state.broadActions >= state.config.strongThreshold && !state.strongShown) {
    state.strongShown = true;
    return createReminder("strong", state, observation);
  }
  if (state.broadActions >= state.config.softThreshold && !state.softShown) {
    state.softShown = true;
    return createReminder("soft", state, observation);
  }
  return null;
}

function createReminder(level, state, observation) {
  const suggestedProfiles = suggestedProfilesForState(state);
  const title = level === "strong"
    ? "[Ant Code delegation guard - strong]"
    : "[Ant Code delegation guard]";
  const action = level === "strong"
    ? "下一步请优先调用 agent_run，并把任务拆成 bounded slices：profile、scope、expected output、acceptance。"
    : "请把后续大范围探索交给 explorer、web-researcher 或 planner 子智能体；主控只保留少量精确复核和最终汇总。";
  const text = [
    title,
    `你已经连续执行多次广域${state.networkActions >= state.repositoryActions ? "搜索/抓取" : "搜索/读取"}，但本轮尚未调用 agent_run。`,
    action,
    `建议 profiles: ${suggestedProfiles.join(", ")}。触发原因：${observation.reason}。`
  ].join("\n");
  return {
    level,
    text,
    reason: observation.reason,
    broadActions: state.broadActions,
    suggestedProfiles
  };
}

function suggestedProfilesForState(state) {
  const profiles = [];
  if (state.repositoryActions > 0) {
    profiles.push("explorer", "planner");
  }
  if (state.networkActions > 0) {
    profiles.push("web-researcher");
  }
  if (profiles.length === 0) {
    profiles.push("explorer", "planner", "web-researcher");
  }
  return [...new Set(profiles)];
}

function isBroadDirectory(value) {
  const normalized = normalizeRelativePath(value);
  if (BROAD_DIRS.has(normalized)) {
    return true;
  }
  const first = normalized.split("/").filter(Boolean)[0] ?? "";
  return BROAD_DIRS.has(first) && normalized.split("/").filter(Boolean).length <= 1;
}

function normalizeRelativePath(value) {
  const raw = String(value ?? "").trim().replace(/^["']|["']$/g, "");
  if (!raw) {
    return "";
  }
  const normalized = raw.replace(/\\/g, "/").replace(/\/+$/g, "");
  if (path.isAbsolute(normalized)) {
    return path.basename(normalized);
  }
  return normalized.replace(/^\.\//, "");
}

function estimateReadBytes(execution, input) {
  const result = execution?.result;
  if (Number.isFinite(result?.bytesRead)) {
    return result.bytesRead;
  }
  if (typeof result?.content === "string") {
    return Buffer.byteLength(result.content, "utf8");
  }
  if (Number.isFinite(input?.maxBytes)) {
    return input.maxBytes;
  }
  return 0;
}

function safeUrl(value) {
  try {
    return new URL(String(value ?? ""));
  } catch {
    return null;
  }
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
