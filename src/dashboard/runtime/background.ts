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
  BACKGROUND_DEAD_HEARTBEAT_MS,
  BACKGROUND_SNAPSHOT_INTERVAL_MS,
  BACKGROUND_STALE_PROGRESS_MS,
  TERMINAL_GROUP_STATUSES,
  TERMINAL_TASK_STATUSES
} from "./types.ts";
import type {
  DashboardActiveSessionState
} from "./types.ts";
import {
  dashboardSessionV2MutationView,
  invalidateRunningDashboardSessionSelection,
  isConfigV2Enabled,
  sessionStatusSummary,
  unresolvedSessionModelSelectionResult
} from "./session-model.ts";
import {
  appendQueueUpdated,
  beginPrompt,
  createWakeQueueItem,
  prepareDashboardSessionForQueuedTurn,
  queueFullResult,
  queueHasCapacity,
  queueSnapshot
} from "./turn-queue.ts";
import {
  appendDashboardEvent,
  eventId,
  isPlainObject
} from "./util.ts";


/** @param {any} state @param {any} [options] */
export async function cancelSessionBackgroundWork(state: DashboardActiveSessionState, options: Record<string, unknown> = {}) {
  const aborted = cancelBackgroundAgentTasks({ parentSessionId: state.session.id });
  if (options.cancelTerminals !== false) {
    await cancelBackgroundTerminalTasks({
      parentSessionId: state.session.id,
      cwd: state.session.cwd,
      workspaceCwd: state.session.cwd
    });
  }
  const abortedIds = new Set(aborted.filter((task) => task.aborted === true).map((task) => task.taskId));
  const taskStore = createAgentTaskStore({ cwd: state.session.cwd });
  const groupStore = createAgentTaskGroupStore({ cwd: state.session.cwd });
  const tasks = await taskStore.listTasks({ parentSessionId: state.session.id });
  const now = new Date().toISOString();
  for (const task of tasks) {
    if (TERMINAL_TASK_STATUSES.has(String(task.status))) {
      continue;
    }
    await taskStore.updateTask(task.id, {
      status: "interrupted",
      cancelRequestedAt: now,
      finishedAt: now,
      heartbeatAt: now,
      progressAt: now,
      latestProgress: backgroundSubagentCancelProgress(abortedIds.has(task.id), "session")
    });
  }
  const groups = await groupStore.listGroups({ parentSessionId: state.session.id });
  for (const group of groups) {
    const groupTasks = await readDashboardGroupTasks(taskStore, group.taskIds);
    const summary = summarizeGroupStatus(groupTasks, { waitFor: group.waitFor });
    await groupStore.updateGroup(group.id, {
      status: summary.completed ? summary.status : group.status,
      summary: summary.summary,
      latestProgress: summary.summary,
      wakePromptConsumedAt: group.wakePromptQueuedAt && !group.wakePromptConsumedAt ? now : group.wakePromptConsumedAt,
      metadata: {
        ...(group.metadata ?? {}),
        cancelledFromDashboardAt: now
      }
    });
  }
  scheduleBackgroundSubagentSnapshot(state);
}

/** @param {string} cwd @param {Record<string, any>} [options] */


/** @param {string} cwd @param {Record<string, any>} [options] */
export async function cancelWorkspaceBackgroundTerminals(cwd: string, options: Record<string, unknown> = {}) {
  return cancelBackgroundTerminalTasks({
    cwd,
    workspaceCwd: cwd,
    refresh: options.memoryOnly !== true,
    persist: options.memoryOnly !== true
  });
}


export async function queueBackgroundWakePrompt(state: DashboardActiveSessionState, event: Record<string, unknown>, env: NodeJS.ProcessEnv | undefined) {
  if (state.disposed || state.quarantinedTurnId) {
    return { ok: false, status: 409, code: "SESSION_UNAVAILABLE" };
  }
  const item = createWakeQueueItem(event, state.currentPermissionMode);
  if (!item) {
    return;
  }
  if (state.running) {
    let config;
    try {
      config = await loadConfig({ cwd: state.session.cwd, env });
    } catch {
      return { ok: false, status: 503, code: "SESSION_CONFIG_RELOAD_FAILED" };
    }
    if (isConfigV2Enabled(config)) {
      const admission = dashboardSessionV2MutationView(state.session, config);
      if (admission.resolution.status !== "resolved") {
        invalidateRunningDashboardSessionSelection(state, admission);
        return unresolvedSessionModelSelectionResult(admission.resolution, state.session.id);
      }
    }
    if (!queueHasCapacity(state)) {
      appendDashboardEvent(state, {
        type: "wakeup_queue_full",
        id: eventId("wakeup-queue-full"),
        code: "QUEUE_FULL",
        groupId: item.groupId,
        queue: queueSnapshot(state),
        queueLength: state.queuedPrompts.length,
        running: true,
        at: new Date().toISOString()
      });
      await appendBackgroundSubagentSnapshot(state);
      return queueFullResult(state);
    }
    state.queuedPrompts.push(item);
    appendDashboardEvent(state, {
      type: "wakeup_queued",
      id: eventId("wakeup"),
      groupId: item.groupId,
      queue: queueSnapshot(state),
      queueLength: state.queuedPrompts.length,
      running: true,
      at: new Date().toISOString()
    });
    appendQueueUpdated(state);
    void markWakePromptConsumed(state, event)
      .finally(() => scheduleBackgroundSubagentSnapshot(state));
    scheduleBackgroundSubagentSnapshot(state);
    return { ok: true, queued: true, item };
  } else {
    if (!await prepareDashboardSessionForQueuedTurn(state, env)) {
      return unresolvedSessionModelSelectionResult(
        isPlainObject(state.session.modelSelectionInvalidation)
          ? state.session.modelSelectionInvalidation
          : { status: "unresolved", reason: "session-config-reload-failed" },
        state.session.id
      );
    }
    if (!beginPrompt(state, item, env)) {
      return unresolvedSessionModelSelectionResult(
        isPlainObject(state.session.modelSelectionInvalidation)
          ? state.session.modelSelectionInvalidation
          : { status: "unresolved", reason: "admission-blocked" },
        state.session.id
      );
    }
    appendDashboardEvent(state, {
      type: "wakeup_queued",
      id: eventId("wakeup"),
      groupId: item.groupId,
      queue: queueSnapshot(state),
      queueLength: state.queuedPrompts.length,
      running: true,
      started: true,
      at: new Date().toISOString()
    });
    void markWakePromptConsumed(state, event)
      .finally(() => scheduleBackgroundSubagentSnapshot(state));
    scheduleBackgroundSubagentSnapshot(state);
    return { ok: true, started: true, item };
  }
}


export async function markWakePromptConsumed(state: DashboardActiveSessionState, event: Record<string, unknown>) {
  const groupId = String(event?.groupId ?? "").trim();
  if (!groupId) {
    return;
  }
  try {
    await createAgentTaskGroupStore({ cwd: state.session.cwd }).updateGroup(groupId, {
      wakePromptConsumedAt: new Date().toISOString()
    });
  } catch {
    // Wakeup continuation must not fail only because the observability marker could not be written.
  }
}


export async function appendBackgroundSubagentSnapshot(state: DashboardActiveSessionState) {
  if (state.disposed) {
    return;
  }
  const snapshot = await buildBackgroundSubagentSnapshot(state);
  if (state.disposed) {
    return;
  }
  if (snapshot.ok === false) {
    return;
  }
  if (!snapshot.hasRecords && snapshot.groups.length === 0) {
    appendDashboardEvent(state, {
      type: "background_subagent_snapshot",
      id: eventId("background-subagents"),
      groups: [],
      totalGroups: 0,
      visibleGroups: 0,
      sessionStatus: sessionStatusSummary(state.session),
      at: new Date().toISOString()
    });
    stopBackgroundSnapshotPolling(state);
    return;
  }
  appendDashboardEvent(state, {
    type: "background_subagent_snapshot",
    id: eventId("background-subagents"),
    groups: snapshot.groups,
    totalGroups: snapshot.totalGroups,
    visibleGroups: snapshot.groups.length,
    sessionStatus: sessionStatusSummary(state.session),
    at: new Date().toISOString()
  });
  updateBackgroundSnapshotPolling(state, snapshot.groups);
}

/** @param {any} state */


/** @param {any} state */
export function scheduleBackgroundSubagentSnapshot(state: DashboardActiveSessionState) {
  if (state.disposed) {
    return null;
  }
  if (state.backgroundSnapshotPromise) {
    state.backgroundSnapshotDirty = true;
    return state.backgroundSnapshotPromise;
  }
  state.backgroundSnapshotDirty = false;
  const promise = appendBackgroundSubagentSnapshot(state)
    .catch(() => {})
    .finally(() => {
      if (state.backgroundSnapshotPromise === promise) {
        state.backgroundSnapshotPromise = null;
        if (state.backgroundSnapshotDirty && !state.disposed) {
          state.backgroundSnapshotDirty = false;
          queueMicrotask(() => scheduleBackgroundSubagentSnapshot(state));
        }
      }
    });
  state.backgroundSnapshotPromise = promise;
  return promise;
}

/** @param {any} state @param {{ groups?: Array<Record<string, any>>; signal?: AbortSignal }} [options] */


/** @param {any} state @param {{ groups?: Array<Record<string, any>>; signal?: AbortSignal }} [options] */
export async function buildBackgroundSubagentSnapshot(state: { session: { id: string; cwd: string } }, options: { groups?: Array<Record<string, unknown>>; signal?: AbortSignal } = {}) {
  try {
    const groupStore = createAgentTaskGroupStore({ cwd: state.session.cwd });
    const taskStore = createAgentTaskStore({ cwd: state.session.cwd });
    const groups = Array.isArray(options.groups)
      ? options.groups.filter((group) => group.parentSessionId === state.session.id)
      : await groupStore.listGroups({ parentSessionId: state.session.id, signal: options.signal });
    const visible = [];
    for (const group of groups) {
      const taskIds = Array.isArray(group.taskIds) ? group.taskIds : [];
      const tasks = await readDashboardGroupTasks(taskStore, taskIds);
      const summary = summarizeGroupStatus(tasks, { waitFor: group.waitFor });
      const runningTasks = tasks.filter((task) => !TERMINAL_TASK_STATUSES.has(String(task.status)));
      const health = backgroundTaskHealth(runningTasks);
      const status = backgroundSnapshotStatus(group, summary, runningTasks, health);
      if (!status) {
        continue;
      }
      visible.push({
        groupId: group.id,
        taskId: runningTasks[0]?.id ?? tasks[0]?.id ?? taskIds[0] ?? null,
        kind: "subagent",
        profile: snapshotGroupProfile(tasks),
        waitFor: group.waitFor,
        wakeParent: group.wakeParent,
        status,
        stale: status === "stale" || status === "lost",
        staleKind: status === "lost" ? "lost" : status === "stale" ? "stale" : null,
        staleReason: backgroundStaleReason(status, health),
        lastProgressAt: health.lastProgressAt,
        heartbeatAt: health.heartbeatAt,
        staleSeconds: typeof health.staleMs === "number" && Number.isFinite(health.staleMs) ? Math.floor(health.staleMs / 1000) : null,
        heartbeatAgeSeconds: typeof health.heartbeatAgeMs === "number" && Number.isFinite(health.heartbeatAgeMs) ? Math.floor(health.heartbeatAgeMs / 1000) : null,
        cancellable: runningTasks.length > 0 || !TERMINAL_GROUP_STATUSES.has(String(group.status)),
        completed: summary.completed === true,
        wakePromptQueued: Boolean(group.wakePromptQueuedAt && !group.wakePromptConsumedAt),
        summary: group.summary || group.latestProgress || summary.summary,
        taskCount: tasks.length || taskIds.length,
        runningCount: runningTasks.length,
        updatedAt: latestSnapshotTimestamp(group, tasks)
      });
    }
    const terminals = listBackgroundTerminalTasks({ parentSessionId: state.session.id, cwd: state.session.cwd })
      .filter((task) => task.status === "running" || task.status === "starting" || task.status === "cancelling")
      .map((task) => ({
        groupId: null,
        taskId: task.taskId,
        kind: "terminal",
        profile: "terminal",
        waitFor: null,
        wakeParent: false,
        status: task.status === "starting" ? "starting" : task.status === "cancelling" ? "cancelling" : "running",
        stale: false,
        staleKind: null,
        staleReason: "",
        lastProgressAt: task.updatedAt,
        heartbeatAt: task.updatedAt,
        staleSeconds: null,
        heartbeatAgeSeconds: null,
        cancellable: true,
        completed: false,
        wakePromptQueued: false,
        summary: [
          task.title,
          task.pid ? `pid=${task.pid}` : null,
          task.stdoutPath ? `stdout=${task.stdoutPath}` : null
        ].filter(Boolean).join(" · "),
        taskCount: 1,
        runningCount: task.status === "running" || task.status === "cancelling" ? 1 : 0,
        updatedAt: task.updatedAt
      }));
    return {
      ok: true,
      hasRecords: groups.length > 0 || terminals.length > 0,
      totalGroups: groups.length + terminals.length,
      groups: [...visible, ...terminals]
    };
  } catch {
    return { ok: false, hasRecords: false, totalGroups: 0, groups: [] };
  }
}

/**
 * @param {any[]} states
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<Map<string, Array<Record<string, any>> | null>>}
 */


/**
 * @param {any[]} states
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<Map<string, Array<Record<string, any>> | null>>}
 */
export async function loadDashboardGroupSnapshots(states: Array<{ session: { cwd: string } }>, options: { signal?: AbortSignal } = {}) {
  /** @type {Map<string, Array<Record<string, any>> | null>} */
  const byWorkspace = new Map();
  for (const state of states) {
    const cwd = path.resolve(state.session.cwd);
    if (!byWorkspace.has(cwd)) {
      byWorkspace.set(cwd, null);
    }
  }
  await Promise.all([...byWorkspace.keys()].map(async (cwd: string) => {
    const store = createAgentTaskGroupStore({ cwd });
    const groups = await store.listGroups({ signal: options.signal });
    byWorkspace.set(cwd, groups);
  }));
  return byWorkspace;
}


export async function readDashboardGroupTasks(taskStore: ReturnType<typeof createAgentTaskStore>, taskIds: unknown = []) {
  const tasks = [];
  for (const id of Array.isArray(taskIds) ? taskIds : []) {
    const result = await taskStore.readTask(id);
    if (result.ok) {
      tasks.push(result.task);
    }
  }
  return tasks;
}


export function backgroundSnapshotStatus(
  group: Record<string, unknown>,
  summary: { completed?: boolean; summary?: unknown; [key: string]: unknown },
  runningTasks: unknown[],
  health: { heartbeatLost?: boolean; progressStale?: boolean; staleMs?: number | null; heartbeatAgeMs?: number | null; lastProgressAt?: unknown; heartbeatAt?: unknown } = {}
) {
  if (group.wakePromptQueuedAt && !group.wakePromptConsumedAt) {
    return "waiting";
  }
  if (runningTasks.length > 0) {
    if (health.heartbeatLost) {
      return "lost";
    }
    if (health.progressStale) {
      return "stale";
    }
    return "running";
  }
  if (!TERMINAL_GROUP_STATUSES.has(String(group.status)) && summary.completed !== true) {
    return "running";
  }
  return null;
}


export function backgroundTaskHealth(runningTasks: Array<{ progressAt?: unknown; updatedAt?: unknown; startedAt?: unknown; heartbeatAt?: unknown }> = []) {
  if (!Array.isArray(runningTasks) || runningTasks.length === 0) {
    return {
      progressStale: false,
      heartbeatLost: false,
      lastProgressAt: null as string | null,
      heartbeatAt: null as string | null,
      staleMs: null as number | null,
      heartbeatAgeMs: null as number | null
    };
  }
  const now = Date.now();
  const progressTimes = runningTasks
    .map((task) => parseTimestamp(task.progressAt ?? task.updatedAt ?? task.startedAt))
    .filter((value): value is number => Number.isFinite(value));
  const heartbeatTimes = runningTasks
    .map((task) => parseTimestamp(task.heartbeatAt ?? task.updatedAt ?? task.startedAt))
    .filter((value): value is number => Number.isFinite(value));
  const latestProgressMs = progressTimes.length > 0 ? Math.max(...progressTimes) : null;
  const latestHeartbeatMs = heartbeatTimes.length > 0 ? Math.max(...heartbeatTimes) : null;
  const staleMs = latestProgressMs == null ? null : now - latestProgressMs;
  const heartbeatAgeMs = latestHeartbeatMs == null ? null : now - latestHeartbeatMs;
  return {
    progressStale: staleMs != null && staleMs >= BACKGROUND_STALE_PROGRESS_MS,
    heartbeatLost: heartbeatAgeMs == null || heartbeatAgeMs >= BACKGROUND_DEAD_HEARTBEAT_MS,
    lastProgressAt: latestProgressMs == null ? null : new Date(latestProgressMs).toISOString(),
    heartbeatAt: latestHeartbeatMs == null ? null : new Date(latestHeartbeatMs).toISOString(),
    staleMs,
    heartbeatAgeMs
  };
}


export function backgroundStaleReason(status: string, health: unknown = {}) {
  if (status === "lost") {
    return "heartbeat 已超时，后台子智能体可能已经失联";
  }
  if (status === "stale") {
    return "长时间没有新的进展记录，但 heartbeat 仍在更新";
  }
  return "";
}

export function backgroundSubagentCancelProgress(aborted: boolean, source: "recycle" | "session" = "recycle") {
  if (source === "session") {
    return aborted
      ? "Dashboard 已取消会话，后台子任务 controller 已中止。"
      : "Dashboard 已取消会话；未找到当前进程 controller，已将失联后台子任务标记为 interrupted。";
  }
  return aborted
    ? "Dashboard 已请求回收后台子智能体；当前进程 controller 已中止。"
    : "Dashboard 已请求回收后台子智能体；未找到当前进程 controller（疑似失联或已退出未落盘），已将任务标记为 interrupted。";
}


export function snapshotGroupProfile(tasks: Array<{ profile?: unknown }> = []) {
  const profiles = [...new Set(tasks.map((task) => String(task.profile ?? "").trim()).filter(Boolean))];
  if (profiles.length === 1) {
    return profiles[0];
  }
  if (profiles.length > 1) {
    return `${profiles.length} profiles`;
  }
  return null;
}


export function latestSnapshotTimestamp(group: Record<string, unknown>, tasks: Array<{ progressAt?: unknown; heartbeatAt?: unknown; updatedAt?: unknown; finishedAt?: unknown }> = []) {
  return [
    group.updatedAt,
    group.completedAt,
    ...tasks.map((task) => task.progressAt),
    ...tasks.map((task) => task.heartbeatAt),
    ...tasks.map((task) => task.updatedAt),
    ...tasks.map((task) => task.finishedAt)
  ].filter(Boolean).sort().at(-1) ?? new Date().toISOString();
}


export function updateBackgroundSnapshotPolling(state: DashboardActiveSessionState, groups: unknown = []) {
  if (Array.isArray(groups) && groups.length > 0) {
    startBackgroundSnapshotPolling(state);
  } else {
    stopBackgroundSnapshotPolling(state);
  }
}


export function startBackgroundSnapshotPolling(state: DashboardActiveSessionState) {
  if (state.backgroundSnapshotTimer || state.disposed) {
    return;
  }
  state.backgroundSnapshotTimer = setInterval(() => {
    scheduleBackgroundSubagentSnapshot(state);
  }, BACKGROUND_SNAPSHOT_INTERVAL_MS);
  state.backgroundSnapshotTimer.unref?.();
}


export function stopBackgroundSnapshotPolling(state: DashboardActiveSessionState) {
  if (!state.backgroundSnapshotTimer) {
    return;
  }
  clearInterval(state.backgroundSnapshotTimer);
  state.backgroundSnapshotTimer = null;
}


export function parseTimestamp(value: unknown) {
  const time = Date.parse(String(value ?? ""));
  return Number.isFinite(time) ? time : null;
}
