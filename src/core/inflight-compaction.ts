const DEFAULT_TOKEN_BYTES = 4;
export const DEFAULT_IN_FLIGHT_COMPACT_RATIO = 1;
const DEFAULT_KEEP_RECENT_TOOLS = 4;
const DEFAULT_MAX_TOOL_TEXT_CHARS = 1400;
const DEFAULT_OVERSIZED_RECENT_CHARS = 8000;
export const COMPACTED_TOOL_MARKER = "[compacted tool result]";
export const STALE_TOOL_MARKER = "[stale tool result]";
const COMPACTED_MARKER = COMPACTED_TOOL_MARKER;

/**
 * Compact older in-flight tool messages in place once an active turn approaches
 * the configured context window. This preserves tool-call structure while
 * replacing bulky raw output with evidence summaries.
 *
 * @param {Array<Record<string, any>>} messages
 * @param {{ maxTokens?: number | null; triggerRatio?: number; keepRecentTools?: number; maxToolTextChars?: number; oversizedRecentChars?: number; force?: boolean; pruneStale?: boolean; currentTurnOnly?: boolean }} options
 */
export function compactInFlightToolMessages(messages: Array<Record<string, unknown>>, options: {
  maxTokens?: number | null;
  triggerRatio?: number;
  keepRecentTools?: number;
  maxToolTextChars?: number;
  oversizedRecentChars?: number;
  force?: boolean;
  pruneStale?: boolean;
  currentTurnOnly?: boolean;
} = {}) {
  const maxTokens = positiveInteger(options.maxTokens) ?? null;
  const beforeBytes = estimateMessagesBytes(messages);
  const beforeTokens = estimateTokensFromBytes(beforeBytes);
  const triggerRatio = boundedRatio(options.triggerRatio, DEFAULT_IN_FLIGHT_COMPACT_RATIO);
  const triggerTokens = maxTokens ? Math.floor(maxTokens * triggerRatio) : null;
  const pruneStale = options.pruneStale === true;
  if (!options.force && !pruneStale && triggerTokens && beforeTokens < triggerTokens) {
    return result(false, beforeBytes, beforeBytes, beforeTokens, beforeTokens, 0, triggerTokens);
  }

  const toolIndexes = collectToolIndexes(messages, options.currentTurnOnly === true);
  const keepRecentTools = nonNegativeInteger(options.keepRecentTools) ?? DEFAULT_KEEP_RECENT_TOOLS;
  const compactUntil = Math.max(0, toolIndexes.length - keepRecentTools);
  const maxToolTextChars = positiveInteger(options.maxToolTextChars) ?? DEFAULT_MAX_TOOL_TEXT_CHARS;
  const oversizedRecentChars = positiveInteger(options.oversizedRecentChars) ?? DEFAULT_OVERSIZED_RECENT_CHARS;
  let compactedTools = 0;

  for (let item = 0; item < compactUntil; item += 1) {
    compactedTools += pruneStale && !options.force
      ? stubStaleToolMessage(messages[toolIndexes[item]]) ? 1 : 0
      : compactToolMessage(messages[toolIndexes[item]], maxToolTextChars) ? 1 : 0;
  }

  if (!pruneStale || options.force === true) {
    const oversizedChars = Math.max(maxToolTextChars, oversizedRecentChars);
    while (shouldCompactMore(messages, triggerTokens, options.force === true)) {
      const candidate = largestUncompactedTool(messages, toolIndexes, oversizedChars, triggerTokens);
      if (candidate == null) {
        break;
      }
      if (!compactToolMessage(messages[candidate], maxToolTextChars)) {
        break;
      }
      compactedTools += 1;
    }
  }

  const afterBytes = estimateMessagesBytes(messages);
  const afterTokens = estimateTokensFromBytes(afterBytes);
  return result(compactedTools > 0, beforeBytes, afterBytes, beforeTokens, afterTokens, compactedTools, triggerTokens);
}

function collectToolIndexes(messages: Array<Record<string, unknown>>, currentTurnOnly: boolean): number[] {
  let start = 0;
  if (currentTurnOnly) {
    for (let index = 0; index < messages.length; index += 1) {
      if (messages[index]?.role === "user") {
        start = index + 1;
      }
    }
  }
  const toolIndexes = [];
  for (let index = start; index < messages.length; index += 1) {
    if (messages[index]?.role === "tool") {
      toolIndexes.push(index);
    }
  }
  return toolIndexes;
}

function compactToolMessage(message: Record<string, unknown> | undefined, maxToolTextChars: number) {
  if (!message) {
    return false;
  }
  const text = extractText(message.content);
  if (!text || isReducedToolText(text)) {
    return false;
  }
  const summary = summarizeToolText(message.name, text, maxToolTextChars);
  if (!summary || summary.length >= text.length) {
    return false;
  }
  message.content = [{ type: "text", text: summary }];
  return true;
}

function stubStaleToolMessage(message: Record<string, unknown> | undefined) {
  if (!message) {
    return false;
  }
  const text = extractText(message.content);
  if (!text || isReducedToolText(text)) {
    return false;
  }
  const placeholder = formatStaleToolPlaceholder(message.name, text);
  if (!placeholder || placeholder.length >= text.length) {
    return false;
  }
  message.content = [{ type: "text", text: placeholder }];
  return true;
}

export function isReducedToolText(text: string) {
  return text.includes(COMPACTED_TOOL_MARKER) || text.includes(STALE_TOOL_MARKER);
}

function formatStaleToolPlaceholder(toolName: unknown, text: string) {
  const parsed = parseJson(text);
  const record = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
  const resultValue = record.result && typeof record.result === "object" && !Array.isArray(record.result)
    ? record.result as Record<string, unknown>
    : {};
  const locators = [
    resultValue.path ? `path=${cleanInline(resultValue.path)}` : "",
    resultValue.finalUrl || resultValue.url ? `url=${cleanInline(resultValue.finalUrl ?? resultValue.url)}` : "",
    Number.isFinite(Number(resultValue.bytes)) ? `bytes=${resultValue.bytes}` : "",
    Number.isFinite(Number(resultValue.bytesRead)) ? `bytes=${resultValue.bytesRead}` : ""
  ].filter(Boolean);
  const header = firstViewHeader(text);
  const ok = record.ok === true || /\bok=true\b/.test(header);
  const pathFromHeader = /\bpath=([^\s]+)/.exec(header)?.[1];
  return [
    STALE_TOOL_MARKER,
    `tool=${toolName ?? "unknown"} ok=${ok}`,
    locators.length ? locators.join(" ") : (pathFromHeader ? `path=${pathFromHeader}` : header),
    "需要时再读或再跑同一工具。"
  ].filter(Boolean).join("\n");
}

function firstViewHeader(text: string) {
  const first = String(text ?? "").split(/\r?\n/).find((line) => line.trim());
  return first && first.length <= 240 ? first.trim() : "";
}

function shouldCompactMore(messages: Array<Record<string, unknown>>, triggerTokens: number | null, force: boolean) {
  if (!triggerTokens) {
    return force;
  }
  return estimateTokensFromBytes(estimateMessagesBytes(messages)) >= triggerTokens;
}

function largestUncompactedTool(
  messages: Array<Record<string, unknown>>,
  toolIndexes: number[],
  oversizedChars: number,
  triggerTokens: number | null
) {
  let bestIndex: number | null = null;
  let bestLength = 0;
  for (const index of toolIndexes) {
    const text = extractText(messages[index]?.content);
    if (!text || isReducedToolText(text)) {
      continue;
    }
    if (!triggerTokens && text.length <= oversizedChars) {
      continue;
    }
    if (triggerTokens && text.length <= oversizedChars && estimateTokensFromBytes(estimateMessagesBytes(messages)) < triggerTokens) {
      continue;
    }
    if (text.length > bestLength) {
      bestIndex = index;
      bestLength = text.length;
    }
  }
  return bestIndex;
}

/**
 * @param {Array<Record<string, any>>} messages
 */
export function estimateMessagesBytes(messages: Array<Record<string, unknown>>) {
  return Buffer.byteLength(JSON.stringify(messages ?? []), "utf8");
}

export function estimateTokensFromBytes(bytes: unknown) {
  const number = Number(bytes);
  if (!Number.isFinite(number) || number <= 0) {
    return 0;
  }
  return Math.max(1, Math.ceil(number / DEFAULT_TOKEN_BYTES));
}

function summarizeToolText(toolName: unknown, text: string, maxChars: number) {
  const parsed = parseJson(text);
  if (!parsed || typeof parsed !== "object") {
    return [
      COMPACTED_MARKER,
      `tool=${toolName ?? "unknown"}`,
      truncateClean(text, maxChars)
    ].join("\n");
  }

  const ok = parsed.ok === true;
  const resultValue = parsed.result && typeof parsed.result === "object" ? parsed.result : {};
  const error = parsed.error && typeof parsed.error === "object" ? parsed.error : {};
  const lines = [
    COMPACTED_MARKER,
    `tool=${toolName ?? "unknown"} ok=${ok}`
  ];

  if (parsed.blocked === true || parsed.decision) {
    const decision = parsed.decision?.decision ?? parsed.decision?.reason ?? "blocked";
    lines.push(`blocked=true decision=${decision}`);
  }
  if (error.code || error.message) {
    lines.push(`error=${[error.code, error.message].filter(Boolean).join(": ")}`);
  }
  if (resultValue.url || resultValue.finalUrl) {
    lines.push(`url=${resultValue.finalUrl ?? resultValue.url}`);
  }
  if (resultValue.status) {
    lines.push(`status=${resultValue.status}`);
  }
  if (resultValue.provider || resultValue.query) {
    lines.push(`search=${[resultValue.provider, resultValue.query].filter(Boolean).join(" ")}`);
  }
  if (Number.isFinite(resultValue.bytes)) {
    lines.push(`bytes=${resultValue.bytes}${resultValue.truncated ? " truncated=true" : ""}`);
  }

  if (Array.isArray(resultValue.results)) {
    lines.push("results:");
    for (const item of resultValue.results.slice(0, 4)) {
      const title = cleanInline(item?.title ?? "");
      const url = cleanInline(item?.url ?? "");
      const snippet = cleanInline(item?.snippet ?? item?.content ?? "");
      lines.push(`- ${truncateClean(title, 120)}${url ? ` <${url}>` : ""}${snippet ? ` - ${truncateClean(snippet, 220)}` : ""}`);
    }
  }

  if (typeof resultValue.content === "string" && resultValue.content.trim()) {
    lines.push("content excerpt:");
    lines.push(truncateClean(resultValue.content, Math.max(400, maxChars - lines.join("\n").length)));
  } else if (typeof parsed.result === "string" && parsed.result.trim()) {
    lines.push("result excerpt:");
    lines.push(truncateClean(parsed.result, Math.max(400, maxChars - lines.join("\n").length)));
  }

  return truncateClean(lines.filter(Boolean).join("\n"), maxChars);
}

function result(compacted: unknown, beforeBytes: unknown, afterBytes: unknown, beforeTokens: unknown, afterTokens: unknown, compactedTools: unknown, triggerTokens: unknown) {
  return {
    compacted,
    beforeBytes,
    afterBytes,
    beforeTokens,
    afterTokens,
    compactedTools,
    triggerTokens
  };
}

function extractText(content: unknown) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content.map((item) => {
    if (typeof item === "string") {
      return item;
    }
    if (item && typeof item === "object" && typeof item.text === "string") {
      return item.text;
    }
    return "";
  }).filter(Boolean).join("\n");
}

function parseJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function truncateClean(value: unknown, maxChars: number) {
  const text = cleanInline(value);
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 28)).trimEnd()}\n...[in-flight compacted]`;
}

function cleanInline(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function positiveInteger(value: unknown) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function nonNegativeInteger(value: unknown) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function boundedRatio(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number <= 1 ? number : fallback;
}
