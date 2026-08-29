import { disableGoalState } from "../../core/goal.js";
import { persistSessionSnapshot } from "../../core/session.js";
import { applyPermissionMode } from "./format.js";

/**
 * Shift+Tab permission cycle for TUI: clear Goal on disk immediately.
 *
 * @param {Record<string, any>} session
 * @param {string} nextMode
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 */
export async function persistTuiPermissionCycle(session, nextMode, options = {}) {
  const previousMode = session.permissionMode;
  const previousGoal = session.goal;
  if (session.goal?.enabled) {
    session.goal = disableGoalState(session.goal, { clearedBy: "tui-permission-change" });
  }
  applyPermissionMode(session, nextMode);
  try {
    await persistSessionSnapshot(session, { env: options.env });
    return true;
  } catch (error) {
    session.goal = previousGoal;
    applyPermissionMode(session, previousMode);
    throw error;
  }
}
