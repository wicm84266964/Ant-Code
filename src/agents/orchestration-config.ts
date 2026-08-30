const DEFAULT_MAX_PARALLEL_READONLY_AGENT_RUNS = 3;

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/**
 * @param {Record<string, any> | undefined} config
 */
export function resolveMaxParallelReadonlyAgentRuns(config: Record<string, unknown> | undefined) {
  const orchestration = asRecord(asRecord(config?.agents).orchestration);
  const value = Number(orchestration.maxParallelReadonlyAgentRuns);
  if (!Number.isInteger(value) || value <= 0) {
    return DEFAULT_MAX_PARALLEL_READONLY_AGENT_RUNS;
  }
  return Math.min(8, value);
}
