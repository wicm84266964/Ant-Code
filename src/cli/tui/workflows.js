export const MAX_RECENT_FILES = 12;
const IMMEDIATE_TUI_COMMANDS = new Set([
  "queue",
  "guide",
  "background",
  "help",
  "status",
  "permissions",
  "context",
  "usage",
  "cost",
  "thinking"
]);

/**
 * @param {Array<unknown>} items
 * @param {number} index
 */
export function boundedIndex(items, index) {
  const length = Array.isArray(items) ? items.length : 0;
  if (length <= 0) {
    return 0;
  }
  return Math.min(length - 1, Math.max(0, Number.isFinite(index) ? index : 0));
}

/**
 * @param {string[]} recentFiles
 * @param {string} filePath
 * @param {number} limit
 */
export function rememberRecentFile(recentFiles, filePath, limit = MAX_RECENT_FILES) {
  const normalized = String(filePath ?? "").replace(/\\/g, "/").replace(/^@/, "").trim();
  if (!normalized) {
    return Array.isArray(recentFiles) ? recentFiles.slice(0, limit) : [];
  }
  const current = Array.isArray(recentFiles) ? recentFiles : [];
  return [
    normalized,
    ...current.filter((item) => item !== normalized)
  ].slice(0, Math.max(1, limit));
}

/**
 * @param {string[]} prompts
 * @param {number} index
 */
export function removeQueuedPrompt(prompts, index) {
  const current = Array.isArray(prompts) ? prompts : [];
  const selectedIndex = boundedIndex(current, index);
  if (current.length === 0) {
    return { prompts: [], removed: null, index: 0 };
  }
  const next = current.filter((_, itemIndex) => itemIndex !== selectedIndex);
  return {
    prompts: next,
    removed: current[selectedIndex],
    index: boundedIndex(next, selectedIndex)
  };
}

/**
 * @param {string[]} prompts
 * @param {number} index
 */
export function promoteQueuedPrompt(prompts, index) {
  const current = Array.isArray(prompts) ? prompts : [];
  const selectedIndex = boundedIndex(current, index);
  if (current.length === 0) {
    return { prompts: [], promoted: null, index: 0 };
  }
  const selected = current[selectedIndex];
  const rest = current.filter((_, itemIndex) => itemIndex !== selectedIndex);
  return {
    prompts: [selected, ...rest],
    promoted: selected,
    index: 0
  };
}

/**
 * @param {string[]} prompts
 * @param {number} index
 */
export function takeQueuedPrompt(prompts, index) {
  const result = removeQueuedPrompt(prompts, index);
  return {
    prompts: result.prompts,
    prompt: result.removed,
    index: result.index
  };
}

/**
 * @param {string[]} prompts
 * @param {string} prompt
 * @param {number} limit
 */
export function prependQueuedPrompt(prompts, prompt, limit = 20) {
  const value = String(prompt ?? "").trim();
  const current = Array.isArray(prompts) ? prompts : [];
  if (!value) {
    return current.slice(0, limit);
  }
  return [value, ...current].slice(0, Math.max(1, limit));
}

/**
 * @param {string} guidance
 * @param {string} activePrompt
 */
export function buildGuidePrompt(guidance, activePrompt = "") {
  const text = String(guidance ?? "").trim();
  const original = String(activePrompt ?? "").trim();
  const lines = [
    "User guidance for the interrupted active turn:",
    text,
    "",
    "Continue the task using this guidance. If partial work from the interrupted turn is already visible, avoid repeating it unless needed."
  ];
  if (original) {
    lines.push("", "Original active prompt:", original);
  }
  return lines.join("\n");
}

export function isStopGuidance(guidance) {
  const normalized = String(guidance ?? "")
    .trim()
    .toLowerCase()
    .replace(/[。.!！\s]+$/g, "");
  return /^(停止|停下|取消|中止|终止|abort|cancel|stop)(当前(任务|轮次|请求))?$/.test(normalized);
}

/**
 * @param {string} prompt
 */
export function isImmediateTuiCommand(prompt) {
  const match = /^\/([a-z][\w-]*)\b/i.exec(String(prompt ?? "").trim());
  return IMMEDIATE_TUI_COMMANDS.has(match?.[1]?.toLowerCase());
}
