export const DEFAULT_MAIN_TOOL_ROUNDS = null;
export const DEFAULT_SUBAGENT_TOOL_ROUNDS = null;

/**
 * @param {unknown} value
 * @param {number | null} fallback
 */
export function positiveIntegerOr(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * @param {Record<string, any> | null | undefined} config
 */
export function resolveMainToolRounds(config) {
  return config?.limits?.maxToolRounds === null
    ? null
    : positiveIntegerOr(config?.limits?.maxToolRounds, DEFAULT_MAIN_TOOL_ROUNDS);
}

/**
 * @param {Record<string, any> | null | undefined} config
 * @param {number | null | undefined} profileRounds
 */
export function resolveSubagentToolRounds(config, profileRounds = null) {
  return positiveIntegerOr(
    config?.agents?.maxRounds,
    positiveIntegerOr(profileRounds, DEFAULT_SUBAGENT_TOOL_ROUNDS)
  );
}
