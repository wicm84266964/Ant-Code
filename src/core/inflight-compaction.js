const DEFAULT_TOKEN_BYTES = 4;
const DEFAULT_TRIGGER_RATIO = 0.68;
const DEFAULT_KEEP_RECENT_TOOLS = 4;
const DEFAULT_MAX_TOOL_TEXT_CHARS = 1400;
const COMPACTED_MARKER = "[compacted tool result]";

/**
 * Compact older in-flight tool messages in place once an active turn approaches
 * the configured context window. This preserves tool-call structure while
 * replacing bulky raw output with evidence summaries.
 *
 * @param {Array<Record<string, any>>} messages
 * @param {{ maxTokens?: number | null; triggerRatio?: number; keepRecentTools?: number; maxToolTextChars?: number; force?: boolean }} options
 */
export function compactInFlightToolMessages(messages, options = {}) {
  const maxTokens = positiveInteger(options.maxTokens) ?? null;
  const beforeBytes = estimateMessagesBytes(messages);
  const beforeTokens = estimateTokensFromBytes(beforeBytes);
  const triggerRatio = boundedRatio(options.triggerRatio, DEFAULT_TRIGGER_RATIO);
  const triggerTokens = maxTokens ? Math.floor(maxTokens * triggerRatio) : null;
  if (!options.force && triggerTokens && beforeTokens < triggerTokens) {
    return result(false, beforeBytes, beforeBytes, beforeTokens, beforeTokens, 0, triggerTokens);
  }

  const toolIndexes = [];
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index]?.role === "tool") {
      toolIndexes.push(index);
    }
  }

  const keepRecentTools = nonNegativeInteger(options.keepRecentTools) ?? DEFAULT_KEEP_RECENT_TOOLS;
  const compactUntil = Math.max(0, toolIndexes.length - keepRecentTools);
  const maxToolTextChars = positiveInteger(options.maxToolTextChars) ?? DEFAULT_MAX_TOOL_TEXT_CHARS;
  let compactedTools = 0;

  for (let item = 0; item < compactUntil; item += 1) {
    const message = messages[toolIndexes[item]];
    const text = extractText(message.content);
    if (!text || text.includes(COMPACTED_MARKER)) {
      continue;
    }
    if (!triggerTokens && text.length <= maxToolTextChars) {
      continue;
    }
    const summary = summarizeToolText(message.name, text, maxToolTextChars);
    if (summary && summary.length < text.length) {
      message.content = [{ type: "text", text: summary }];
      compactedTools += 1;
    }
  }

  const afterBytes = estimateMessagesBytes(messages);
  const afterTokens = estimateTokensFromBytes(afterBytes);
  return result(compactedTools > 0, beforeBytes, afterBytes, beforeTokens, afterTokens, compactedTools, triggerTokens);
}

/**
 * @param {Array<Record<string, any>>} messages
 */
export function estimateMessagesBytes(messages) {
  return Buffer.byteLength(JSON.stringify(messages ?? []), "utf8");
}

export function estimateTokensFromBytes(bytes) {
  const number = Number(bytes);
  if (!Number.isFinite(number) || number <= 0) {
    return 0;
  }
  return Math.max(1, Math.ceil(number / DEFAULT_TOKEN_BYTES));
}

function summarizeToolText(toolName, text, maxChars) {
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

function result(compacted, beforeBytes, afterBytes, beforeTokens, afterTokens, compactedTools, triggerTokens) {
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

function extractText(content) {
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

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function truncateClean(value, maxChars) {
  const text = cleanInline(value);
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 28)).trimEnd()}\n...[in-flight compacted]`;
}

function cleanInline(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function boundedRatio(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number < 1 ? number : fallback;
}
