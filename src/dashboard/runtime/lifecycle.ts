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
  ActiveSessionMap,
  DEFAULT_LIFECYCLE_WAIT_MS,
  LIFECYCLE_POLL_INTERVAL_MS,
  MAX_LIFECYCLE_WAIT_MS
} from "./types.ts";
import type {
  DashboardActiveSessionState,
  DashboardRuntimeActivity,
  LifecycleProbe,
  RuntimeActivityReader
} from "./types.ts";
import {
  cancelPendingInteractions,
  clearForceSettleTimer
} from "./approvals.ts";
import {
  buildBackgroundSubagentSnapshot,
  loadDashboardGroupSnapshots,
  stopBackgroundSnapshotPolling
} from "./background.ts";
import {
  appendQueueUpdated,
  publicQueueItem
} from "./turn-queue.ts";
import {
  appendDashboardEvent,
  eventId,
  isPlainObject,
  nonNegativeInteger
} from "./util.ts";


/** @param {any} active @param {string} cwd @param {{ signal?: AbortSignal }} [options] */
export async function dashboardRuntimeActivity(active: ActiveSessionMap, cwd: string = process.cwd(), extra: unknown = {}) {
  const options = isPlainObject(extra) ? extra : {};
  const signal = options.signal instanceof AbortSignal ? options.signal : undefined;
  const result = emptyRuntimeActivity();
  const activeSessionIds = new Set();
  const activeStates = [...active.values()];
  const groupSnapshots = await loadDashboardGroupSnapshots(activeStates, { signal });
  for (const state of activeStates) {
    activeSessionIds.add(state.session.id);
    const activity = await dashboardSessionActivity(state, {
      groups: groupSnapshots.get(path.resolve(state.session.cwd)) ?? []
    });
    result.activeTurns += activity.activeTurns;
    result.quarantinedTurns += activity.quarantinedTurns;
    result.queuedTurns += activity.queuedTurns;
    result.backgroundTasks += activity.backgroundTasks;
    result.pendingInteractions += activity.pendingInteractions;
  }
  const workspace = path.resolve(cwd);
  const orphanTerminals = listBackgroundTerminalTasks({ cwd })
    .filter((task) => task.status === "starting" || task.status === "running" || task.status === "cancelling")
    .filter((task) => task.cwd && path.resolve(task.cwd) === workspace)
    .filter((task) => !task.parentSessionId || !activeSessionIds.has(task.parentSessionId));
  result.backgroundTasks += orphanTerminals.length;
  result.sessions = active.size;
  result.total = activityTotal(result);
  return result;
}

/** @param {any} active @param {boolean} [uncertain] */


/** @param {any} active @param {boolean} [uncertain] */
export function dashboardMemoryActivity(active: ActiveSessionMap, uncertain: boolean = false) {
  const result = /** @type {any} */ (emptyRuntimeActivity());
  for (const state of active.values()) {
    result.activeTurns += state.running ? 1 : 0;
    result.quarantinedTurns += state.quarantinedTurnId ? 1 : 0;
    result.queuedTurns += state.queuedPrompts.length;
    result.pendingInteractions += state.pendingApprovals.size + state.pendingQuestions.size;
  }
  result.sessions = active.size;
  result.total = activityTotal(result);
  if (uncertain) {
    result.uncertain = true;
  }
  return result;
}

/** @param {any} state @param {{ groups?: Array<Record<string, any>>; signal?: AbortSignal }} [options] */


/** @param {any} state @param {{ groups?: Array<Record<string, any>>; signal?: AbortSignal }} [options] */
export async function dashboardSessionActivity(state: DashboardActiveSessionState, options: { groups?: Array<Record<string, unknown>>; signal?: AbortSignal } = {}) {
  const snapshot = await buildBackgroundSubagentSnapshot(state, options);
  const activeTurns = state.running ? 1 : 0;
  const visibleBackgroundTasks = snapshot.groups.reduce((total, group) => (
    total + Math.max(1, nonNegativeInteger(group.runningCount))
  ), 0);
  const registeredAgents = listBackgroundAgentTasks({ parentSessionId: state.session.id }).length;
  const registeredTerminals = listBackgroundTerminalTasks({ parentSessionId: state.session.id, cwd: state.session.cwd })
    .filter((task) => task.status === "starting" || task.status === "running" || task.status === "cancelling")
    .filter((task) => !task.cwd || path.resolve(task.cwd) === path.resolve(state.session.cwd))
    .length;
  const result = {
    sessions: 1,
    activeTurns,
    quarantinedTurns: state.quarantinedTurnId ? 1 : 0,
    queuedTurns: state.queuedPrompts.length,
    backgroundTasks: Math.max(visibleBackgroundTasks, registeredAgents + registeredTerminals),
    pendingInteractions: state.pendingApprovals.size + state.pendingQuestions.size,
    total: 0
  };
  result.total = activityTotal(result);
  return result;
}


export function emptyRuntimeActivity(): DashboardRuntimeActivity {
  return {
    sessions: 0,
    activeTurns: 0,
    quarantinedTurns: 0,
    queuedTurns: 0,
    backgroundTasks: 0,
    pendingInteractions: 0,
    total: 0
  };
}


export function activityTotal(activity: DashboardRuntimeActivity) {
  return activity.activeTurns + activity.queuedTurns + activity.backgroundTasks + activity.pendingInteractions;
}

/** @param {any} state @param {any} [options] */


export function cancelAllQueuedTurns(state: DashboardActiveSessionState, reason: string) {
  if (state.queuedPrompts.length === 0) {
    return [];
  }
  const removed = state.queuedPrompts.splice(0).map(publicQueueItem);
  appendDashboardEvent(state, {
    type: "queue_cleared",
    id: eventId("queue-cleared"),
    reason,
    items: removed,
    queue: [],
    queueLength: 0,
    running: state.running,
    at: new Date().toISOString()
  });
  appendQueueUpdated(state);
  return removed;
}


export function asRuntimeActivity(value: unknown): DashboardRuntimeActivity {
  if (!isPlainObject(value)) {
    return emptyRuntimeActivity();
  }
  const activity: DashboardRuntimeActivity = {
    sessions: Number(value.sessions) || 0,
    activeTurns: Number(value.activeTurns) || 0,
    quarantinedTurns: Number(value.quarantinedTurns) || 0,
    queuedTurns: Number(value.queuedTurns) || 0,
    backgroundTasks: Number(value.backgroundTasks) || 0,
    pendingInteractions: Number(value.pendingInteractions) || 0,
    total: Number(value.total) || 0
  };
  if (value.uncertain === true) {
    activity.uncertain = true;
  }
  return activity;
}


export async function waitForRuntimeActivity(active: ActiveSessionMap, deadline: number, cwd: string, readActivity: RuntimeActivityReader = dashboardRuntimeActivity) {
  let activity = dashboardMemoryActivity(active, true);
  while (Date.now() < deadline) {
    const probe = await waitForLifecycleOperation((signal) => readActivity(active, cwd, { signal }), deadline);
    if (!probe.settled || probe.error) {
      return { settled: false, activity: dashboardMemoryActivity(active, true), error: probe.error };
    }
    activity = asRuntimeActivity(probe.value);
    if (activity.total <= 0) {
      return { settled: true, activity };
    }
    await waitForLifecycleTick(deadline);
  }
  return { settled: false, activity: dashboardMemoryActivity(active, true) };
}


export async function waitForSessionActivity(state: DashboardActiveSessionState, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let activity = await dashboardSessionActivity(state);
  while (activity.total > 0 && Date.now() < deadline) {
    await waitForLifecycleTick(deadline);
    activity = await dashboardSessionActivity(state);
  }
  return activity;
}


export function waitForLifecycleTick(deadline: number) {
  return new Promise<void>((resolve) => {
    const delay = Math.max(1, Math.min(LIFECYCLE_POLL_INTERVAL_MS, deadline - Date.now()));
    setTimeout(resolve, delay);
  });
}

/**
 * @param {Promise<unknown> | null | undefined} promise
 * @param {number} deadline
 * @returns {Promise<boolean>}
 */


/**
 * @param {Promise<unknown> | null | undefined} promise
 * @param {number} deadline
 * @returns {Promise<boolean>}
 */
export async function waitForLifecyclePromise(promise: Promise<unknown> | null | undefined, deadline: number) {
  if (!promise) {
    return true;
  }
  const result = await waitForLifecycleOperation(() => promise, deadline);
  return result.settled;
}

export async function waitForLifecycleOperation<T>(operation: (signal: AbortSignal) => T | Promise<T>, deadline: number): Promise<LifecycleProbe<T>> {
  const remaining = Math.max(0, deadline - Date.now());
  if (remaining <= 0) {
    return { settled: false };
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  const controller = new AbortController();
  const work = Promise.resolve().then(() => operation(controller.signal));
  try {
    return await Promise.race([
      work.then(
        (value): LifecycleProbe<T> => ({ settled: true, value }),
        (error: unknown): LifecycleProbe<T> => ({ settled: true, error })
      ),
      new Promise<LifecycleProbe<T>>((resolve) => {
        timer = setTimeout(() => {
          resolve({ settled: false });
          controller.abort(new Error("Dashboard lifecycle operation timed out"));
        }, remaining);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}


export function lifecycleWaitMs(value: unknown, env: NodeJS.ProcessEnv = process.env) {
  const configured = Number(value ?? env?.ANT_CODE_DASHBOARD_LIFECYCLE_WAIT_MS ?? DEFAULT_LIFECYCLE_WAIT_MS);
  if (!Number.isFinite(configured)) {
    return DEFAULT_LIFECYCLE_WAIT_MS;
  }
  return Math.max(50, Math.min(MAX_LIFECYCLE_WAIT_MS, Math.trunc(configured)));
}


export function disposeTurnState(state: DashboardActiveSessionState, reason: string) {
  if (state.disposed) {
    return;
  }
  clearForceSettleTimer(state);
  stopBackgroundSnapshotPolling(state);
  const canReleaseSessionMemory = !state.controller;
  if (state.controller && !state.controller.signal.aborted) {
    state.controller.abort(reason);
  }
  cancelPendingInteractions(state, reason);
  state.queuedPrompts.length = 0;
  state.currentAttachmentBytes = 0;
  for (const dispose of state.listenerDisposers.values()) {
    try {
      dispose(reason);
    } catch {
      // Listener disposal is best-effort; state references are still removed below.
    }
  }
  state.listenerDisposers.clear();
  state.disposed = true;
  state.controller = null;
  state.running = false;
  state.interrupting = false;
  state.quarantinedTurnId = "";
  state.currentPrompt = "";
  state.currentTurnId = "";
  state.turnEnv = null;
  state.finalOutput = "";
  state.backgroundSnapshotDirty = false;
  state.backgroundSnapshotPromise = null;
  state.events.length = 0;
  state.listeners.clear();
  if (canReleaseSessionMemory) {
    state.session.messages = [];
    state.session.transcriptMessages = [];
    if (state.session.transcriptArchive) {
      state.session.transcriptArchive.pendingMessages = [];
    }
    if (state.session.modelContextArchive) {
      state.session.modelContextArchive.pendingMessages = [];
    }
    const released = state.session as Record<string, unknown>;
    released.workflow = null;
    released.context = null;
    released.contextWindow = null;
    state.session.workspaceDiagnostic = null;
    released.usage = null;
    released.lastProviderUsage = null;
  }
}
