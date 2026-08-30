const SECRET_KEY_PATTERN = /api[_-]?key|secret|password|authorization|credential|access[_-]?token|refresh[_-]?token|personal[_-]?access[_-]?token/i;

export type ProviderUsageSummary = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedPromptTokens?: number;
};

export type ProviderUsageAggregate = {
  source?: string;
  reports?: number;
  totals?: Record<string, unknown>;
  last?: Record<string, unknown> | null;
  lastRound?: number;
  lastModel?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedPromptTokens?: number;
  lastPromptTokens?: number;
  lastCompletionTokens?: number;
  lastTotalTokens?: number;
  lastCachedPromptTokens?: number;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Provider-reported usage arrives after a gateway round completes. Keep it
 * separate from local prompt estimates, which are still needed before requests.
 *
 * @param {Record<string, any> | null | undefined} current
 * @param {unknown} rawUsage
 * @param {{ round?: number; model?: string | null }} [details]
 */
export function accumulateProviderUsage(
  current: ProviderUsageAggregate | Record<string, unknown> | null | undefined,
  rawUsage: unknown,
  details: { round?: number; model?: string | null } = {}
): ProviderUsageAggregate {
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
    reports: (finiteNumber(previous.reports) ?? 0) + 1,
    totals,
    last: usage,
    lastRound: finiteNumber(details.round) ?? previous.lastRound,
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
export function normalizeProviderUsageAggregate(value: unknown): ProviderUsageAggregate {
  if (!isPlainObject(value)) {
    return {};
  }
  const totals = isPlainObject(value.totals) ? sanitizeProviderUsage(value.totals) ?? {} : {};
  const last = isPlainObject(value.last) ? sanitizeProviderUsage(value.last) ?? null : null;
  const totalSummary = summarizeProviderUsage(totals);
  const lastSummary = summarizeProviderUsage(last);
  return compactObject({
    source: value.source === "provider-reported" ? "provider-reported" : undefined,
    reports: finiteNumber(value.reports) ?? finiteNumber(value.providerReports),
    totals,
    last,
    lastRound: finiteNumber(value.lastRound),
    lastModel: typeof value.lastModel === "string" ? value.lastModel : undefined,
    promptTokens: finiteNumber(value.promptTokens) ?? totalSummary.promptTokens,
    completionTokens: finiteNumber(value.completionTokens) ?? totalSummary.completionTokens,
    totalTokens: finiteNumber(value.totalTokens) ?? totalSummary.totalTokens,
    cachedPromptTokens: finiteNumber(value.cachedPromptTokens) ?? totalSummary.cachedPromptTokens,
    lastPromptTokens: finiteNumber(value.lastPromptTokens) ?? lastSummary.promptTokens,
    lastCompletionTokens: finiteNumber(value.lastCompletionTokens) ?? lastSummary.completionTokens,
    lastTotalTokens: finiteNumber(value.lastTotalTokens) ?? lastSummary.totalTokens,
    lastCachedPromptTokens: finiteNumber(value.lastCachedPromptTokens) ?? lastSummary.cachedPromptTokens
  });
}

/**
 * @param {unknown} value
 */
export function sanitizeProviderUsage(value: unknown): Record<string, unknown> | null {
  if (!isPlainObject(value)) {
    return null;
  }
  return sanitizeDiagnosticObject(value);
}

/**
 * @param {unknown} value
 */
export function summarizeProviderUsage(value: unknown): ProviderUsageSummary {
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
  const totalTokens = explicitTotal !== undefined
    ? explicitTotal
    : promptTokens !== undefined && completionTokens !== undefined
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
function addNumericUsage(previous: Record<string, unknown> | null | undefined, usage: Record<string, unknown>): Record<string, unknown> {
  const totals: Record<string, unknown> = isPlainObject(previous) ? { ...previous } : {};
  for (const [key, value] of Object.entries(usage)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      const current = totals[key];
      totals[key] = (typeof current === "number" && Number.isFinite(current) ? current : 0) + value;
      continue;
    }
    if (isPlainObject(value)) {
      const current = totals[key];
      totals[key] = addNumericUsage(isPlainObject(current) ? current : {}, value);
      continue;
    }
  }
  return totals;
}

/**
 * @param {Record<string, any>} value
 * @param {string[]} keys
 */
function firstFinite(value: unknown, keys: string[]): number | undefined {
  for (const key of keys) {
    const item = getPath(value, key);
    if (typeof item === "number" && Number.isFinite(item)) {
      return item;
    }
  }
  return undefined;
}

/**
 * @param {Record<string, any>} value
 * @param {string} path
 */
function getPath(value: unknown, path: string): unknown {
  const record = isPlainObject(value) ? value : asRecord(value);
  if (Number.isFinite(record[path])) {
    return record[path];
  }
  let current: unknown = value;
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
function sanitizeDiagnosticValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > 200 ? `${value.slice(0, 197)}...` : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeDiagnosticValue(item));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  return sanitizeDiagnosticObject(value);
}

function sanitizeDiagnosticObject(value: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    sanitized[key] = SECRET_KEY_PATTERN.test(key)
      ? "[redacted]"
      : sanitizeDiagnosticValue(item);
  }
  return sanitized;
}

/**
 * @param {Record<string, any>} value
 */
function compactObject<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => {
    if (item === undefined || item === null) {
      return false;
    }
    if (isPlainObject(item) && Object.keys(item).length === 0) {
      return false;
    }
    return true;
  })) as T;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
