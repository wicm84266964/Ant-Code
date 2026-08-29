import { persistSessionSnapshot } from "../../core/session.js";
import { applyPermissionMode } from "./format.js";

/**
 * Shift+Tab permission cycle. Goal locks permission until `/goal exit`.
 *
 * @param {Record<string, any>} session
 * @param {string} nextMode
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 */
export async function persistTuiPermissionCycle(session, nextMode, options = {}) {
  if (session.goal?.enabled) {
    const error = new Error("Goal 开启时不能切换权限。请先 /goal exit。");
    error.code = "GOAL_PERMISSION_LOCKED";
    throw error;
  }
  const previousMode = session.permissionMode;
  applyPermissionMode(session, nextMode);
  try {
    await persistSessionSnapshot(session, { env: options.env });
    return true;
  } catch (error) {
    applyPermissionMode(session, previousMode);
    throw error;
  }
}
