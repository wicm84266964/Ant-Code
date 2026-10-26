import { sourceUpdateMaintenanceResult } from "./source-update-maintenance.ts";
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
  normalizeSessionGoal,
  serializeSessionGoal,
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
  isConfigV2Enabled,
  sessionStatusFromMetadata,
  unresolvedSessionModelSelectionResult,
  sessionStatusSummary
} from "./session-model.ts";
import {
  resolveDashboardTrust
} from "./trust.ts";
import {
  beginPrompt,
  createQueueItem,
  ensureTurnState,
  elevateQueueItemForGoal,
  normalizeMutationSessionId,
  prepareDashboardSessionForQueuedTurn,
  queueSnapshot,
  requireExactSessionId,
  revokeGoalQueueElevation,
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
  return publicDashboardGoal(state?.session?.goal, state?.session?.config, state?.session?.usage, state.running);
}

// A stored running marker is not evidence that a turn is alive in this runtime.
export function publicDashboardGoal(
  goal: Parameters<typeof publicGoalSnapshot>[0],
  config?: Parameters<typeof publicGoalSnapshot>[1],
  usage?: unknown,
  running = false
) {
  const snapshot = publicGoalSnapshot(goal, config, usage);
  return !running && snapshot.status === "running" ? { ...snapshot, status: "paused" } : snapshot;
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
  if (["disable", "clear", "pause"].includes(action)) {
    return withKeyedMutation(context.sessionMutationLocks, normalized.sessionId, () =>
      stopDashboardGoal(context, normalized.sessionId, action));
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
      const existing = context.active.get(normalized.sessionId);
      if (existing && isConfigV2Enabled(loadedConfig)) {
        const resolution = resolveSessionModelSelection(loadedConfig, {
          model: existing.session.model,
          modelSelection: existing.session.modelSelection
        });
        if (resolution.status !== "resolved") {
          return unresolvedSessionModelSelectionResult(resolution, normalized.sessionId);
        }
      }
      state = await ensureTurnState(context.active, {
        cwd: context.cwd,
        env: configEnv,
        sessionId: normalized.sessionId,
        // Goal controls stage their permission change until the disk commit.
        preservePermission: true,
        config: currentConfig,
        runTurn: context.runTurn,
        sessionMutationLocks: context.sessionMutationLocks,
        activeCapacityLocks: context.activeCapacityLocks,
        activePolicy: context.activePolicy
      });
    } catch (error) {
      if (error instanceof SessionModelSelectionUnresolvedError) {
        return unresolvedSessionModelSelectionResult(error, normalized.sessionId);
      }
      if (error instanceof ActiveSessionCapacityError) {
        return activeSessionCapacityResult(context.active, context.activePolicy);
      }
      throw error;
    }
    if (state.workAdmissionBlocked?.()) return sourceUpdateMaintenanceResult();
    if (state.session.permissionReadonlyLocked) {
      return { ok: false, status: 400, error: "只读锁定会话不能启用 Goal" };
    }
    const eventCursor = state.eventSequence;
    // Stage controls separately: no live elevation, events, queue insertion or
    // execution can escape a failed commit, even while an old turn settles.
    const controls: Pick<AgentSession, "goal"> & Record<string, unknown> = { ...goalPermissionMetadata(state.session), goal: state.session.goal };
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
        controls.goal = enabledGoal;
      }
      if (!state.running) {
        applyPermissionMode(controls, "fullAccess");
      }
    } else if (action === "resume") {
      const goal = { ...state.session.goal };
      if (!goal?.enabled || !String(goal.text ?? "").trim()) {
        return { ok: false, status: 409, error: "没有可继续的 Goal" };
      }
      if (goal.status !== "paused" && goal.status !== "failed") {
        return { ok: false, status: 409, error: "Goal 当前不可继续" };
      }
      applyPermissionMode(controls, "fullAccess");
      goal.status = "active";
      goal.lastBlockReason = "";
      goal.consecutiveFailures = 0;
      clearGoalEndedAt(goal);
      controls.goal = goal;
    }
    try {
      await persistGoalControlSnapshot(state, context.runtimeEnv, controls);
    } catch {
      return { ok: false, status: 500, code: "GOAL_PERSIST_FAILED", error: "Goal 状态未能保存，请刷新后重试" };
    }
    emitGoalState(state, action === "enable" ? "enabled" : "resumed");
    if (action === "enable") {
      startIdleGoalTurn(state, configEnv ?? process.env, objective);
    } else {
      if (!state.running && !state.disposed && !state.quarantinedTurnId) {
        const item = createGoalContinueItem(state);
        if (item) {
          state.queuedPrompts.push(item);
          const prepared = await prepareDashboardSessionForQueuedTurn(state, configEnv);
          if (prepared) {
            const next = takeNextQueueItem(state);
            if (next) {
              elevateQueueItemForGoal(state, next);
              beginPrompt(state, next, configEnv);
            }
          }
        }
      }
    }
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

// Stop controls must not hydrate a session, resolve a model, run hooks, or rewrite
// transcript/model metadata. The runtime lock is already held by the caller.
async function stopDashboardGoal(context: DashboardRuntimeContext, sessionId: string, action: string) {
  const state = context.active.get(sessionId);
  const config = state?.session.config ?? await loadConfig({ cwd: context.cwd, env: await context.resolveConfigEnv() });
  const store = createSessionStore({ cwd: context.cwd, transcript: config.transcript, env: context.runtimeEnv });
  if (!state) {
    const exact = await requireExactSessionId(context.active, {
      cwd: context.cwd, env: context.runtimeEnv, config, sessionId
    });
    if (!exact.ok) return exact;
  }
  const eventCursor = state?.eventSequence;
  try {
    const committed = await store.withSessionMutation(sessionId, async () => {
      const current = await store.readMetadataExact(sessionId, { lockHeld: true });
      if (!current.ok && !(state && !state.persisted && current.error?.code === "SESSION_NOT_FOUND")) {
        return {
          ok: false as const,
          status: current.error?.code === "SESSION_NOT_FOUND" ? 404 : 500,
          code: current.error?.code ?? "GOAL_PERSIST_FAILED",
          error: current.error?.message ?? "无法保存 Goal"
        };
      }
      const metadata = current.ok ? current.metadata : newGoalSessionMetadata(state!.session);
      const target: Record<string, unknown> = state?.session ?? { ...metadata };
      const goal = normalizeSessionGoal(target.goal, { hydrateRunningAsPaused: false });
      if (action === "pause" && !goal.enabled) {
        return { ok: false as const, status: 409, error: "当前没有启用 Goal" };
      }
      const nextGoal = action === "pause"
        ? { ...goal, status: "paused", lastBlockReason: "user_pause" }
        : disableGoalState(goal, { clearedBy: "user" });
      if (action === "clear") nextGoal.text = "";
      target.goal = nextGoal;
      applyPermissionMode(target, goal.previousPermissionMode);
      if (state) {
        dropGoalContinueItems(state);
        if (goal.enabled) revokeGoalQueueElevation(state, goal.previousPermissionMode);
        if (state.running) requestTurnInterrupt(state, action === "pause" ? "goal-pause" : "goal-disable");
        emitGoalState(state, action === "pause" ? "paused" : action);
      }
      const patch: Record<string, unknown> = { ...metadata, goal: serializeSessionGoal(nextGoal) };
      Object.assign(patch, goalPermissionMetadata(target));
      const metadataPath = await store.writeMetadata(patch, { lockHeld: true });
      if (!metadataPath) throw new Error("Goal metadata persistence is disabled");
      return { ok: true as const, metadata: patch };
    });
    if (!committed.ok) return committed;
    if (state) state.persisted = true;
    return {
      ok: true,
      sessionId,
      permission: permissionModeSummary(state?.session ?? committed.metadata),
      goal: state ? publicStateGoal(state) : publicDashboardGoal(committed.metadata.goal as Record<string, unknown>, undefined, committed.metadata.usage),
      sessionStatus: state ? sessionStatusSummary(state.session) : sessionStatusFromMetadata(committed.metadata, config),
      active: Boolean(state),
      running: state?.running === true,
      interrupting: state?.interrupting === true || Boolean(state?.quarantinedTurnId),
      eventCursor,
      queue: state ? queueSnapshot(state) : undefined
    };
  } catch {
    // An interrupt may already have been requested; never claim the disk commit
    // succeeded or that the underlying turn has stopped when it has not.
    return { ok: false, status: 500, code: "GOAL_PERSIST_FAILED", error: "Goal 状态未能保存，请刷新后重试" };
  }
}

// User-facing Goal commits are narrow and fail closed, unlike best-effort
// end-of-turn snapshots. Do not refresh model identity or transcript here.
async function persistGoalControlSnapshot(state: DashboardActiveSessionState, env: NodeJS.ProcessEnv, controls: Pick<AgentSession, "goal"> & Record<string, unknown>) {
  const store = createSessionStore({ cwd: state.session.cwd, transcript: state.session.config.transcript, env });
  await store.withSessionMutation(state.session.id, async () => {
    const current = await store.readMetadataExact(state.session.id, { lockHeld: true });
    if (!current.ok && (state.persisted || current.error?.code !== "SESSION_NOT_FOUND")) {
      throw new Error("Goal metadata is unavailable");
    }
    const metadata = current.ok ? current.metadata : newGoalSessionMetadata(state.session);
    const metadataPath = await store.writeMetadata({
      ...metadata,
      goal: serializeSessionGoal(controls.goal),
      ...goalPermissionMetadata(controls)
    }, { lockHeld: true });
    if (!metadataPath) throw new Error("Goal metadata persistence is disabled");
    // Publish live controls before releasing the shared file lock, so queued
    // turn snapshots refresh the committed controls instead of old values.
    Object.assign(state.session, controls);
  });
  state.persisted = true;
}

function goalPermissionMetadata(target: Record<string, unknown>) {
  return Object.fromEntries(["permissionMode", "fullAccess", "readonly", "allowWrite", "allowCommand"]
    .map((key) => [key, target[key]]));
}

// A live, brand-new session may not have its first metadata file yet. Capture
// its identity verbatim instead of invoking model selection or snapshot hooks.
function newGoalSessionMetadata(session: AgentSession): Record<string, unknown> {
  return {
    id: session.id, cwd: session.cwd, startedAt: session.startedAt,
    title: session.title, mode: session.mode, clientSurface: session.clientSurface,
    model: session.model, modelSelection: session.modelSelection,
    metadataVersion: isConfigV2Enabled(session.config) ? 2 : 1,
    reasoningEffort: session.config.reasoningEffort ?? null,
    usage: session.usage,
    transcript: { messages: session.transcriptMessages, contextMessages: session.messages }
  };
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
  if (wasQuarantined || state.disposed || state.workAdmissionBlocked?.()) {
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
