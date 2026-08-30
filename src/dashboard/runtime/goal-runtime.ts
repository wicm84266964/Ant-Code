import fs from "node:fs/promises";
import path from "node:path";
import { createHash, createHmac, randomBytes, type Hash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  createSession,
  persistSessionSnapshot,
  runSessionTurn,
  SessionModelSelectionUnresolvedError,
  type AgentSession
} from "../../core/session.ts";
import {
  GOAL_ABS_MAX_AUTO_CONTINUES,
  GOAL_CONTINUE_KIND,
  GOAL_MIN_AUTO_CONTINUES,
  applyGoalEndedAt,
  bumpGoalRoundCount,
  clearGoalEndedAt,
  resolveGoalMaxAutoContinues,
  buildGoalContinuePrompt,
  disableGoalState,
  enableGoalState,
  resolveGoalPreviousPermissionMode,
  evaluateGoalCompletion,
  goalUnattendedQuestionResult,
  publicGoalSnapshot,
  shouldSkipGoalContinue,
  stripGoalStatusMarkers
} from "../../core/goal.ts";
import {
  applyRuntimeModelSelection,
  currentRuntimeModelSelection,
  patchSessionModelSelectionMetadata,
  resolveSessionModelSelection,
  type SessionModelSelectionResolution,
  type RuntimeModelSelection
} from "../../config-v2/runtime-selection.ts";
import { clearSessionContext, compactSessionContextWithModel, createContextWindow, summarizeContextWindow } from "../../core/context-window.ts";
import { createLabModelGateway } from "../../model-gateway/client.ts";
import { redactGatewayText } from "../../model-gateway/errors.ts";
import { listConfiguredModels, normalizeAgentModelTiers, normalizeReasoningEfforts, resolveModelSelection, type LabModel } from "../../model-gateway/models.ts";
import {
  inferCatalogReasoning,
  normalizeCapabilityEfforts,
  reasoningProbeEffortIds
} from "../../model-gateway/reasoning-capabilities.ts";
import { resolveWorkspaceTrust, trustWorkspace as saveWorkspaceTrust } from "../../permissions/workspace-trust.ts";
import { createSessionStore } from "../../storage/session-store.ts";
import { GATEWAY_PROTOCOLS, NETWORK_MODES, globalConfigPath, loadConfig, localProjectConfigPath, type LabAgentConfig } from "../../config/load-config.ts";
import { cancelBackgroundAgentTasks, listBackgroundAgentTasks } from "../../agents/background-registry.ts";
import { cancelBackgroundTerminalTasks, listBackgroundTerminalTasks } from "../../agents/background-terminal-registry.ts";
import { createAgentTaskStore } from "../../agents/task-store.ts";
import { createAgentTaskGroupStore, summarizeGroupStatus } from "../../agents/task-group-store.ts";
import { cloneWorkflowState } from "../../tools/workflow-tools.ts";
import { mapSessionEventToDashboard, permissionRequestToActivity } from "../events.ts";
import { applyPermissionMode, approvalKeyFor, buildApprovalPreview, normalizePermissionMode, permissionModeSummary, sanitizeSensitiveValue } from "../permissions.ts";
import { collectSessionFiles } from "../files.ts";
import { getAntCodeVersion } from "../../version.ts";
import { mutateJsonConfig } from "../config-store.ts";
import {
  dashboardV2ErrorResult,
  deleteV2Provider,
  deleteV2ProviderModel,
  publicV2ConfigState,
  saveV2DefaultModel,
  saveV2ProviderModel
} from "../model-settings-v2.ts";

import {
  ActiveSessionCapacityError
} from "./types.ts";
import type {
  DashboardActiveSessionState,
  DashboardRequestInput,
  DashboardRuntimeContext
} from "./types.ts";
import {
  activeSessionCapacityResult
} from "./active-map.ts";
import {
  requestTurnInterrupt
} from "./approvals.ts";
import {
  configForDashboardSelection,
  sessionStatusSummary
} from "./session-model.ts";
import {
  resolveDashboardTrust
} from "./trust.ts";
import {
  beginPrompt,
  createQueueItem,
  ensureTurnState,
  normalizeMutationSessionId,
  prepareDashboardSessionForQueuedTurn,
  queueSnapshot,
  requireExactSessionId,
  takeNextQueueItem,
  withKeyedMutation
} from "./turn-queue.ts";
import {
  appendDashboardEvent,
  eventId,
  isPlainObject,
  nonNegativeInteger
} from "./util.ts";


export function sessionRecordGoalStatus(record: unknown) {
  const source = isPlainObject(record) ? record : {};
  const goal = isPlainObject(source.goal) ? source.goal : null;
  if (!goal?.enabled) {
    return undefined;
  }
  return goal.status ?? "active";
}

/** @param {Record<string, any>} state */


/** @param {Record<string, any>} state */
export function publicStateGoal(state: DashboardActiveSessionState) {
  return publicGoalSnapshot(state?.session?.goal, state?.session?.config, state?.session?.usage);
}

/** @param {unknown} value */


/** @param {unknown} value */
export function optionalDashboardPermissionMode(value: unknown) {
  if (value == null || String(value).trim() === "") {
    return undefined;
  }
  return normalizePermissionMode(String(value));
}

/** @param {Record<string, any>} context @param {Record<string, any>} input */


/** @param {Record<string, any>} context @param {Record<string, any>} input */
export async function applyDashboardGoal(context: DashboardRuntimeContext, input: DashboardRequestInput) {
  const action = String(input.action ?? "").trim().toLowerCase();
  if (!["enable", "disable", "pause", "resume", "clear"].includes(action)) {
    return { ok: false, status: 400, error: "未知 Goal 操作" };
  }
  const objective = String(input.objective ?? input.text ?? "").trim();
  if (action === "enable" && !objective) {
    return { ok: false, status: 400, error: "请输入目标" };
  }
  const normalized = normalizeMutationSessionId(input.sessionId);
  if (!normalized.ok) {
    return normalized;
  }
  const trustEnv = await context.resolveConfigEnv();
  const trust = await resolveDashboardTrust({ cwd: context.cwd, env: trustEnv, processTrusted: context.processTrusted });
  if (!trust.trusted) {
    return { ok: false, status: 403, error: "请先确认工作区信任", trust };
  }
  return withKeyedMutation(context.sessionMutationLocks, normalized.sessionId, async () => {
    const configEnv = await context.resolveConfigEnv();
    const loadedConfig = await loadConfig({ cwd: context.cwd, env: configEnv });
    const currentConfig = configForDashboardSelection(loadedConfig, context.runtimeSelection);
    const exact = await requireExactSessionId(context.active, {
      cwd: context.cwd,
      env: context.runtimeEnv,
      config: currentConfig,
      sessionId: normalized.sessionId
    });
    if (!exact.ok) {
      return exact;
    }
    let state: DashboardActiveSessionState;
    try {
      state = await ensureTurnState(context.active, {
        cwd: context.cwd,
        env: configEnv,
        sessionId: normalized.sessionId,
        mode: optionalDashboardPermissionMode(input.permissionMode),
        config: currentConfig,
        runTurn: context.runTurn,
        sessionMutationLocks: context.sessionMutationLocks,
        activeCapacityLocks: context.activeCapacityLocks,
        activePolicy: context.activePolicy
      });
    } catch (error) {
      if (error instanceof ActiveSessionCapacityError) {
        return activeSessionCapacityResult(context.active, context.activePolicy);
      }
      throw error;
    }
    if (state.session.permissionReadonlyLocked) {
      return { ok: false, status: 400, error: "只读锁定会话不能启用 Goal" };
    }
    const eventCursor = state.eventSequence;
    if (action === "enable") {
      const previous = resolveGoalPreviousPermissionMode({
        alreadyEnabled: state.session.goal?.enabled === true,
        storedPrevious: state.session.goal?.previousPermissionMode,
        sessionPermissionMode: state.session.permissionMode,
        clientPreviousPermissionMode: input.clientPreviousPermissionMode,
        preferClientForNewSession: false
      });
      const enabledGoal = enableGoalState({
        text: objective,
        previousPermissionMode: previous,
        maxAutoContinues: resolveGoalMaxAutoContinues(state.session.config),
        usage: state.session.usage
      });
      if (enabledGoal) {
        state.session.goal = enabledGoal;
      }
      if (!state.running) {
        applyPermissionMode(state.session, "fullAccess");
      }
      emitGoalState(state, "enabled");
      startIdleGoalTurn(state, configEnv ?? process.env, objective);
    } else if (action === "disable" || action === "clear") {
      const previous = state.session.goal?.previousPermissionMode ?? "plan";
      if (state.running) {
        requestTurnInterrupt(state, "goal-disable");
      }
      dropGoalContinueItems(state);
      state.session.goal = action === "clear"
        ? disableGoalState({ ...state.session.goal, text: "" }, { clearedBy: "user" })
        : disableGoalState(state.session.goal, { clearedBy: "user" });
      if (action === "clear") {
        state.session.goal.text = "";
      }
      applyPermissionMode(state.session, previous);
      emitGoalState(state, action);
    } else if (action === "pause") {
      if (!state.session.goal?.enabled) {
        return { ok: false, status: 409, error: "当前没有启用 Goal" };
      }
      if (state.running) {
        requestTurnInterrupt(state, "goal-pause");
      }
      dropGoalContinueItems(state);
      state.session.goal.status = "paused";
      state.session.goal.lastBlockReason = "user_pause";
      emitGoalState(state, "paused");
    } else if (action === "resume") {
      const goal = state.session.goal;
      if (!goal?.enabled || !String(goal.text ?? "").trim()) {
        return { ok: false, status: 409, error: "没有可继续的 Goal" };
      }
      if (goal.status !== "paused" && goal.status !== "failed") {
        return { ok: false, status: 409, error: "Goal 当前不可继续" };
      }
      applyPermissionMode(state.session, "fullAccess");
      goal.status = "active";
      goal.lastBlockReason = "";
      goal.consecutiveFailures = 0;
      clearGoalEndedAt(goal);
      emitGoalState(state, "resumed");
      if (!state.running && !state.disposed && !state.quarantinedTurnId) {
        const item = createGoalContinueItem(state);
        if (item) {
          state.queuedPrompts.push(item);
          const prepared = await prepareDashboardSessionForQueuedTurn(state, configEnv);
          if (prepared) {
            const next = takeNextQueueItem(state);
            if (next) {
              if (state.session.goal?.enabled) {
                next.permissionMode = "fullAccess";
              }
              beginPrompt(state, next, configEnv);
            }
          }
        }
      }
    }
    await persistGoalSnapshot(state);
    return {
      ok: true,
      sessionId: state.session.id,
      permission: permissionModeSummary(state.session),
      goal: publicStateGoal(state),
      sessionStatus: sessionStatusSummary(state.session),
      running: state.running === true,
      eventCursor,
      queue: queueSnapshot(state)
    };
  });
}

/** @param {Record<string, any>} state @param {string} reason */


/** @param {Record<string, any>} state @param {string} reason */
export function emitGoalState(state: DashboardActiveSessionState, reason: string) {
  appendDashboardEvent(state, {
    type: "goal_state",
    id: eventId("goal-state"),
    reason,
    goal: publicStateGoal(state),
    permission: permissionModeSummary(state.session),
    at: new Date().toISOString()
  });
}

/** @param {Record<string, any>} state */


/** @param {Record<string, any>} state */
export async function persistGoalSnapshot(state: DashboardActiveSessionState) {
  if (!state?.session) {
    return;
  }
  try {
    await persistSessionSnapshot(state.session, { env: state.turnEnv ?? process.env });
    state.persisted = true;
  } catch (error) {
    const code = isPlainObject(error) && typeof error.code === "string" ? error.code : undefined;
    if (code !== "SESSION_NOT_FOUND" && code !== "SESSION_METADATA_NOT_FOUND") {
      appendDashboardEvent(state, {
        type: "error",
        id: eventId("goal-persist"),
        message: error instanceof Error ? error.message : String(error),
        at: new Date().toISOString()
      });
    }
  }
}

/** @param {Record<string, any>} state @param {NodeJS.ProcessEnv} env @param {string} prompt */


/** @param {Record<string, any>} state @param {NodeJS.ProcessEnv} env @param {string} prompt */
export function startIdleGoalTurn(state: DashboardActiveSessionState, env: NodeJS.ProcessEnv, prompt: string) {
  if (state.running || state.disposed || state.quarantinedTurnId) {
    return false;
  }
  const text = String(prompt ?? state.session?.goal?.text ?? "").trim();
  if (!text || !state.session?.goal?.enabled) {
    return false;
  }
  applyPermissionMode(state.session, "fullAccess");
  state.session.goal.status = "running";
  const item = createQueueItem(text, "fullAccess", "prompt");
  return beginPrompt(state, item, env);
}

/** @param {Record<string, any>} state */


/** @param {Record<string, any>} state */
export function dropGoalContinueItems(state: DashboardActiveSessionState) {
  state.queuedPrompts = state.queuedPrompts.filter((item) => item.kind !== GOAL_CONTINUE_KIND);
}

/** @param {Record<string, any>} state */


/** @param {Record<string, any>} state */
export function createGoalContinueItem(state: DashboardActiveSessionState) {
  const goal = state.session?.goal;
  const text = String(goal?.text ?? "").trim();
  if (!text) {
    return null;
  }
  const prompt = buildGoalContinuePrompt({
    ...goal,
    maxAutoContinues: resolveGoalMaxAutoContinues(state.session.config, goal.maxAutoContinues)
  }, {
    lastTurn: state.status || "completed",
    hostNotes: goal.lastEvidence?.gaps?.length
      ? goal.lastEvidence.gaps.slice(0, 4)
      : [`remaining todos: ${goal.lastEvidence?.activeItems ?? 0}`]
  });
  const item = createQueueItem(prompt, "fullAccess", GOAL_CONTINUE_KIND);
  item.title = `Goal 续跑 · 第 ${nonNegativeInteger(goal.continueCount) + 1} 轮`;
  return item;
}

/** @param {Record<string, any>} state @param {{ wasQuarantined?: boolean }} [options] */


/** @param {Record<string, any>} state @param {{ wasQuarantined?: boolean }} [options] */
export function maybeEnqueueGoalContinue(state: DashboardActiveSessionState, options: { wasQuarantined?: boolean } = {}) {
  const wasQuarantined = options.wasQuarantined;
  if (wasQuarantined || state.disposed) {
    return false;
  }
  if (shouldSkipGoalContinue(state)) {
    if (state.session?.goal?.enabled && nonNegativeInteger(state.session.goal.continueCount) >= resolveGoalMaxAutoContinues(state.session.config, state.session.goal.maxAutoContinues)) {
      state.session.goal.status = "paused";
      state.session.goal.lastBlockReason = "budget";
      applyGoalEndedAt(state.session.goal);
      emitGoalState(state, "budget");
    }
    return false;
  }
  if (state.queuedPrompts.some((item) => ["guide", "prompt", "wakeup"].includes(item.kind ?? ""))) {
    dropGoalContinueItems(state);
    return false;
  }
  if (state.queuedPrompts.some((item) => item.kind === GOAL_CONTINUE_KIND)) {
    return false;
  }
  const item = createGoalContinueItem(state);
  if (!item) {
    return false;
  }
  state.session.goal.continueCount = nonNegativeInteger(state.session.goal.continueCount) + 1;
  state.session.goal.status = "running";
  state.session.goal.lastContinueReason = "unfinished";
  state.queuedPrompts.push(item);
  appendDashboardEvent(state, {
    type: "goal_continued",
    id: eventId("goal-continue"),
    reason: state.session.goal.lastContinueReason,
    continueCount: state.session.goal.continueCount,
    goal: publicStateGoal(state),
    queue: queueSnapshot(state),
    at: new Date().toISOString()
  });
  return true;
}

/** @param {Record<string, any>} state */


/** @param {Record<string, any>} state @param {string} terminalStatus */
export function updateGoalAfterTurn(state: DashboardActiveSessionState, terminalStatus: string) {
  const goal = state.session?.goal;
  if (!goal?.enabled) {
    return;
  }
  bumpGoalRoundCount(goal);
  if (terminalStatus === "interrupted") {
    goal.status = "paused";
    goal.lastBlockReason = "user_interrupt";
    dropGoalContinueItems(state);
    emitGoalState(state, "paused");
    return;
  }
  if (["blocked", "cancelled"].includes(terminalStatus)) {
    goal.status = "paused";
    goal.lastBlockReason = terminalStatus;
    emitGoalState(state, "paused");
    return;
  }
  if (terminalStatus === "failed") {
    goal.consecutiveFailures = nonNegativeInteger(goal.consecutiveFailures) + 1;
    if (goal.consecutiveFailures >= 3) {
      goal.status = "failed";
      goal.lastBlockReason = "consecutive_failures";
      applyGoalEndedAt(goal);
      emitGoalState(state, "failed");
    } else {
      goal.status = "paused";
      goal.lastBlockReason = "transient_failure";
      emitGoalState(state, "paused");
    }
    return;
  }
  if (terminalStatus === "completed") {
    goal.consecutiveFailures = 0;
    const evaluation = evaluateGoalCompletion({
      goal,
      finalOutput: state.finalOutput,
      lastEvidence: goal.lastEvidence,
      liveWorkflow: state.session.workflow
    });
    goal.lastEvidence = evaluation.evidence;
    if (evaluation.complete) {
      goal.status = "complete";
      goal.lastContinueReason = evaluation.reason;
      applyGoalEndedAt(goal);
      emitGoalState(state, "complete");
    } else if (goal.status !== "paused") {
      goal.status = "active";
    }
  }
}
