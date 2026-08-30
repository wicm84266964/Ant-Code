import { persistSessionSnapshot, type AgentSession } from "../../core/session.ts";
import { applyPermissionMode } from "./format.ts";

/**
 * Shift+Tab permission cycle. Goal locks permission until `/goal exit`.
 *
 * @param {Record<string, any>} session
 * @param {string} nextMode
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 */
export async function persistTuiPermissionCycle(session: AgentSession, nextMode: string, options: { env?: NodeJS.ProcessEnv } = {}) {
  if (session.goal?.enabled) {
    const error = new Error("Goal 开启时不能切换权限。请先 /goal exit。") as Error & { code: string };
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
