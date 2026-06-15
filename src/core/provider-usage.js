const SECRET_KEY_PATTERN = /api[_-]?key|secret|password|authorization|credential|access[_-]?token|refresh[_-]?token|personal[_-]?access[_-]?token/i;

/**
 * Provider-reported usage arrives after a gateway round completes. Keep it
 * separate from local prompt estimates, which are still needed before requests.
 *
 * @param {Record<string, any> | null | undefined} current
 * @param {unknown} rawUsage
 * @param {{ round?: number; model?: string | null }} [details]
 */
export function accumulateProviderUsage(current, rawUsage, details = {}) {
  const usage = sanitizeProviderUsage(rawUsage);
  if (!usage) {
    return normalizeProviderUsageAggregate(current);
  }

  const previous = normalizeProviderUsageAggregate(current);
  const totals = addNumericUsage(previous.totals, usage);
  const totalSummary = summarizeProviderUsage(totals);
  const lastSummary = summarizeProviderUsage(usage);

  return compactObject({
    source: "provider-reported",
    reports: (Number.isFinite(previous.reports) ? previous.reports : 0) + 1,
    totals,
    last: usage,
    lastRound: Number.isFinite(details.round) ? details.round : previous.lastRound,
    lastModel: typeof details.model === "string" ? details.model : previous.lastModel,
    promptTokens: totalSummary.promptTokens,
    completionTokens: totalSummary.completionTokens,
    totalTokens: totalSummary.totalTokens,
    cachedPromptTokens: totalSummary.cachedPromptTokens,
    lastPromptTokens: lastSummary.promptTokens,
    lastCompletionTokens: lastSummary.completionTokens,
    lastTotalTokens: lastSummary.totalTokens,
    lastCachedPromptTokens: lastSummary.cachedPromptTokens
  });
}

/**
 * @param {unknown} value
 */
export function normalizeProviderUsageAggregate(value) {
  if (!isPlainObject(value)) {
    return {};
  }
  const totals = isPlainObject(value.totals) ? sanitizeProviderUsage(value.totals) ?? {} : {};
  const last = isPlainObject(value.last) ? sanitizeProviderUsage(value.last) ?? null : null;
  const totalSummary = summarizeProviderUsage(totals);
  const lastSummary = summarizeProviderUsage(last);
  return compactObject({
    source: value.source === "provider-reported" ? "provider-reported" : undefined,
    reports: Number.isFinite(value.reports) ? value.reports : Number.isFinite(value.providerReports) ? value.providerReports : undefined,
    totals,
    last,
    lastRound: Number.isFinite(value.lastRound) ? value.lastRound : undefined,
    lastModel: typeof value.lastModel === "string" ? value.lastModel : undefined,
    promptTokens: Number.isFinite(value.promptTokens) ? value.promptTokens : totalSummary.promptTokens,
    completionTokens: Number.isFinite(value.completionTokens) ? value.completionTokens : totalSummary.completionTokens,
    totalTokens: Number.isFinite(value.totalTokens) ? value.totalTokens : totalSummary.totalTokens,
    cachedPromptTokens: Number.isFinite(value.cachedPromptTokens) ? value.cachedPromptTokens : totalSummary.cachedPromptTokens,
    lastPromptTokens: Number.isFinite(value.lastPromptTokens) ? value.lastPromptTokens : lastSummary.promptTokens,
    lastCompletionTokens: Number.isFinite(value.lastCompletionTokens) ? value.lastCompletionTokens : lastSummary.completionTokens,
    lastTotalTokens: Number.isFinite(value.lastTotalTokens) ? value.lastTotalTokens : lastSummary.totalTokens,
    lastCachedPromptTokens: Number.isFinite(value.lastCachedPromptTokens) ? value.lastCachedPromptTokens : lastSummary.cachedPromptTokens
  });
}

/**
 * @param {unknown} value
 */
export function sanitizeProviderUsage(value) {
  if (!isPlainObject(value)) {
    return null;
  }
  return sanitizeDiagnosticValue(value);
}

/**
 * @param {unknown} value
 */
export function summarizeProviderUsage(value) {
  if (!isPlainObject(value)) {
    return {};
  }
  const promptTokens = firstFinite(value, [
    "prompt_tokens",
    "input_tokens",
    "promptTokens",
    "inputTokens",
    "input_token_count"
  ]);
  const completionTokens = firstFinite(value, [
    "completion_tokens",
    "output_tokens",
    "completionTokens",
    "outputTokens",
    "output_token_count"
  ]);
  const explicitTotal = firstFinite(value, [
    "total_tokens",
    "totalTokens",
    "total_token_count"
  ]);
  const cachedPromptTokens = firstFinite(value, [
    "cached_tokens",
    "cachedTokens",
    "cache_read_input_tokens",
    "cacheReadInputTokens",
    "cache_read_tokens",
    "cached_input_tokens",
    "cachedInputTokens",
    "cached_content_token_count",
    "prompt_tokens_details.cached_tokens",
    "promptTokensDetails.cachedTokens",
    "input_tokens_details.cached_tokens",
    "inputTokensDetails.cachedTokens"
  ]);
  const totalTokens = Number.isFinite(explicitTotal)
    ? explicitTotal
    : Number.isFinite(promptTokens) && Number.isFinite(completionTokens)
      ? promptTokens + completionTokens
      : undefined;

  return compactObject({
    promptTokens,
    completionTokens,
    totalTokens,
    cachedPromptTokens
  });
}

/**
 * @param {Record<string, any> | null | undefined} previous
 * @param {Record<string, any>} usage
 */
function addNumericUsage(previous, usage) {
  const totals = isPlainObject(previous) ? { ...previous } : {};
  for (const [key, value] of Object.entries(usage)) {
    if (Number.isFinite(value)) {
      totals[key] = (Number.isFinite(totals[key]) ? totals[key] : 0) + value;
      continue;
    }
    if (isPlainObject(value)) {
      totals[key] = addNumericUsage(isPlainObject(totals[key]) ? totals[key] : {}, value);
      continue;
    }
  }
  return totals;
}

/**
 * @param {Record<string, any>} value
 * @param {string[]} keys
 */
function firstFinite(value, keys) {
  for (const key of keys) {
    const item = getPath(value, key);
    if (Number.isFinite(item)) {
      return item;
    }
  }
  return undefined;
}

/**
 * @param {Record<string, any>} value
 * @param {string} path
 */
function getPath(value, path) {
  if (Number.isFinite(value[path])) {
    return value[path];
  }
  let current = value;
  for (const part of String(path).split(".")) {
    if (!isPlainObject(current)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

/**
 * @param {unknown} value
 */
function sanitizeDiagnosticValue(value) {
  if (typeof value === "string") {
    return value.length > 200 ? `${value.slice(0, 197)}...` : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeDiagnosticValue(item));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    SECRET_KEY_PATTERN.test(key)
      ? "[redacted]"
      : sanitizeDiagnosticValue(item)
  ]));
}

/**
 * @param {Record<string, any>} value
 */
function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => {
    if (item === undefined || item === null) {
      return false;
    }
    if (isPlainObject(item) && Object.keys(item).length === 0) {
      return false;
    }
    return true;
  }));
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
