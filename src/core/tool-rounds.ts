export const DEFAULT_MAIN_TOOL_ROUNDS = null;
export const DEFAULT_SUBAGENT_TOOL_ROUNDS = null;

/**
 * @param {unknown} value
 * @param {number | null} fallback
 */
export function positiveIntegerOr(value: unknown, fallback: number | null): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

/**
 * @param {Record<string, any> | null | undefined} config
 */
export function resolveMainToolRounds(config: { limits?: { maxToolRounds?: number | null } } | null | undefined): number | null {
  return config?.limits?.maxToolRounds === null
    ? null
    : positiveIntegerOr(config?.limits?.maxToolRounds, DEFAULT_MAIN_TOOL_ROUNDS);
}

/**
 * @param {Record<string, any> | null | undefined} config
 * @param {number | null | undefined} profileRounds
 */
export function resolveSubagentToolRounds(
  config: { agents?: { maxRounds?: unknown } } | null | undefined,
  profileRounds: number | null | undefined = null
) {
  return positiveIntegerOr(
    config?.agents?.maxRounds,
    positiveIntegerOr(profileRounds, DEFAULT_SUBAGENT_TOOL_ROUNDS)
  );
}
