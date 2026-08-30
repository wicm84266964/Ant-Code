export const MAX_RECENT_FILES = 12;
const IMMEDIATE_TUI_COMMANDS = new Set([
  "queue",
  "guide",
  "goal",
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
export function boundedIndex(items: Array<unknown>, index: number) {
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
export function rememberRecentFile(recentFiles: string[], filePath: string, limit: number = MAX_RECENT_FILES) {
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
export function removeQueuedPrompt(prompts: string[], index: number) {
  const current = Array.isArray(prompts) ? prompts : [];
  const selectedIndex = boundedIndex(current, index);
  if (current.length === 0) {
    return { prompts: [], removed: null, index: 0 };
  }
  const next = current.filter((_: unknown, itemIndex: unknown) => itemIndex !== selectedIndex);
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
export function promoteQueuedPrompt(prompts: string[], index: number) {
  const current = Array.isArray(prompts) ? prompts : [];
  const selectedIndex = boundedIndex(current, index);
  if (current.length === 0) {
    return { prompts: [], promoted: null, index: 0 };
  }
  const selected = current[selectedIndex];
  const rest = current.filter((_: unknown, itemIndex: unknown) => itemIndex !== selectedIndex);
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
export function takeQueuedPrompt(prompts: string[], index: number) {
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
export function prependQueuedPrompt(prompts: string[], prompt: string, limit: number = 20) {
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
export function buildGuidePrompt(guidance: string, activePrompt: string = "") {
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

export function isStopGuidance(guidance: unknown) {
  const normalized = String(guidance ?? "")
    .trim()
    .toLowerCase()
    .replace(/[。.!！\s]+$/g, "");
  return /^(停止|停下|取消|中止|终止|abort|cancel|stop)(当前(任务|轮次|请求))?$/.test(normalized);
}

/**
 * @param {string} prompt
 */
export function isImmediateTuiCommand(prompt: string) {
  const match = /^\/([a-z][\w-]*)\b/i.exec(String(prompt ?? "").trim());
  const name = match?.[1]?.toLowerCase();
  return name !== undefined && IMMEDIATE_TUI_COMMANDS.has(name);
}

/**
 * Coalesces repeated async polling requests into one active operation and at
 * most one trailing refresh.
 * @param {() => Promise<any>} operation
 */
export function createCoalescedAsyncRunner(operation: () => Promise<unknown>) {
  let disposed = false;
  let rerunRequested = false;
  let inFlight: Promise<unknown> | null = null;

  const run = () => {
    if (disposed) {
      return Promise.resolve(undefined);
    }
    if (inFlight) {
      rerunRequested = true;
      return inFlight;
    }
    const work = Promise.resolve().then(operation);
    const tracked = work.finally(() => {
      if (inFlight !== tracked) {
        return;
      }
      inFlight = null;
      if (rerunRequested && !disposed) {
        rerunRequested = false;
        queueMicrotask(() => {
          void run().catch(() => {});
        });
      }
    });
    inFlight = tracked;
    return tracked;
  };

  return {
    run,
    dispose() {
      disposed = true;
      rerunRequested = false;
    },
    get active() {
      return inFlight !== null;
    }
  };
}

/**
 * @param {{ confirmed?: boolean; backgroundExitPending?: boolean; backgroundCount?: number }} state
 */
export function resolveTuiExitAction(state: { confirmed?: boolean; backgroundExitPending?: boolean; backgroundCount?: number } = {}) {
  if (state.confirmed !== true) {
    return "confirm";
  }
  if (state.backgroundExitPending === true) {
    return "force";
  }
  if (Number(state.backgroundCount ?? 0) > 0) {
    return "cancel-background";
  }
  return "exit";
}
