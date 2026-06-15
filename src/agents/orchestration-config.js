const DEFAULT_MAX_PARALLEL_READONLY_AGENT_RUNS = 3;

/**
 * @param {Record<string, any> | undefined} config
 */
export function resolveMaxParallelReadonlyAgentRuns(config) {
  const value = Number(config?.agents?.orchestration?.maxParallelReadonlyAgentRuns);
  if (!Number.isInteger(value) || value <= 0) {
    return DEFAULT_MAX_PARALLEL_READONLY_AGENT_RUNS;
  }
  return Math.min(8, value);
}
