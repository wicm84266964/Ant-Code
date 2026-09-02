function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function positiveIntegerOrNull(value: unknown) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

/**
 * Raise the local compaction budget so it is at least the selected model's
 * advertised window. Switching to a larger model must not stay stuck on an
 * older, smaller local cap.
 */
export function applyModelContextBudget(
  next: Record<string, unknown>,
  local: Record<string, unknown>,
  contextTokens: unknown
) {
  const tokens = Number(contextTokens);
  if (!Number.isFinite(tokens) || tokens <= 0) {
    return next;
  }
  const nextContext: Record<string, unknown> = {
    ...(isPlainObject(local.context) ? local.context : {}),
    ...(isPlainObject(next.context) ? next.context : {})
  };
  nextContext.maxTokens = Math.max(positiveIntegerOrNull(nextContext.maxTokens) ?? 0, tokens);
  nextContext.maxBytes = Math.max(positiveIntegerOrNull(nextContext.maxBytes) ?? 0, tokens * 4);
  nextContext.resumeMaxTokens = Math.max(positiveIntegerOrNull(nextContext.resumeMaxTokens) ?? 0, tokens);
  nextContext.resumeMaxBytes = Math.max(positiveIntegerOrNull(nextContext.resumeMaxBytes) ?? 0, tokens * 4);
  next.context = nextContext;
  return next;
}

export function contextTokensForConfig(config: Record<string, unknown> | null | undefined) {
  const modelAlias = String(config?.modelAlias ?? "").trim();
  const models = Array.isArray(config?.models) ? config.models : [];
  const model = models.find((item) => isPlainObject(item) && String(item.id ?? "").trim() === modelAlias);
  if (!isPlainObject(model)) {
    return null;
  }
  return positiveIntegerOrNull(model.contextTokens ?? model.contextWindow);
}
