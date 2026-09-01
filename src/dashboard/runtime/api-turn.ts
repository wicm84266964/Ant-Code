import type { DashboardFactoryState } from "./factory-state.ts";
import type { DashboardRequestInput, DashboardEventListener } from "./types.ts";
import { TERMINAL_TASK_STATUSES } from "./types.ts";
import { loadConfig, type LabAgentConfig, GATEWAY_PROTOCOLS, localProjectConfigPath, globalConfigPath } from "../../config/load-config.ts";
import { persistSessionSnapshot, runSessionTurn, SessionModelSelectionUnresolvedError } from "../../core/session.ts";
import { listConfiguredModels, normalizeReasoningEfforts, resolveModelSelection } from "../../model-gateway/models.ts";
import { createSessionStore } from "../../storage/session-store.ts";
import { collectSessionFiles } from "../files.ts";
import { applyPermissionMode, normalizePermissionMode, permissionModeSummary } from "../permissions.ts";
import { publicV2ConfigState, saveV2DefaultModel, saveV2ProviderModel, deleteV2Provider, deleteV2ProviderModel, dashboardV2ErrorResult } from "../model-settings-v2.ts";
import { mutateJsonConfig } from "../config-store.ts";
import { getAntCodeVersion } from "../../version.ts";
import { resolveWorkspaceTrust, trustWorkspace as saveWorkspaceTrust } from "../../permissions/workspace-trust.ts";
import { GOAL_CONTINUE_KIND, publicGoalSnapshot } from "../../core/goal.ts";
import { currentRuntimeModelSelection, resolveSessionModelSelection } from "../../config-v2/runtime-selection.ts";
import { cancelBackgroundAgentTasks } from "../../agents/background-registry.ts";
import { cancelBackgroundTerminalTasks, listBackgroundTerminalTasks } from "../../agents/background-terminal-registry.ts";
import { createAgentTaskStore } from "../../agents/task-store.ts";
import { createAgentTaskGroupStore, summarizeGroupStatus } from "../../agents/task-group-store.ts";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  reclaimActiveSessions
} from "./active-map.ts";
import {
  cancelPendingInteractions,
  normalizeQuestionAnswer,
  requestTurnInterrupt
} from "./approvals.ts";
import {
  appendBackgroundSubagentSnapshot,
  backgroundSubagentCancelProgress,
  buildBackgroundSubagentSnapshot,
  cancelSessionBackgroundWork,
  cancelWorkspaceBackgroundTerminals,
  loadDashboardGroupSnapshots,
  readDashboardGroupTasks
} from "./background.ts";
import {
  mutateDashboardContext
} from "./context-control.ts";
import {
  boundedGatewayDiscoveryTtl,
  consumeGatewayDiscovery,
  mergeReasoningProbeIntoCatalog,
  probeGatewayConnection,
  probeModelReasoningCapabilities,
  rememberGatewayDiscovery,
  resolveGatewayDiscovery,
  validateGatewayDiscoveryEntry
} from "./gateway-probe.ts";
import {
  applyDashboardGoal,
  persistGoalSnapshot,
  sessionRecordGoalStatus
} from "./goal-runtime.ts";
import {
  cancelAllQueuedTurns,
  dashboardMemoryActivity,
  dashboardRuntimeActivity,
  disposeTurnState,
  lifecycleWaitMs,
  waitForLifecycleOperation,
  waitForLifecyclePromise,
  waitForRuntimeActivity
} from "./lifecycle.ts";
import {
  activeGatewayProfileId,
  buildGatewayProfileDeleteConfig,
  buildGatewayProfileSwitchConfig,
  buildLocalAgentModelTiersConfig,
  buildLocalModelConfig,
  buildOwnedDeleteModelConfig,
  clearDanglingGatewayProfileSelection,
  gatewayProfileDeleteTargets,
  gatewayProfileForEndpoint,
  gatewayProfilesFromConfig,
  gatewayProfilesOwnedByConfig,
  parseConfigUrl,
  removeRedundantInheritedGatewayShadows,
  shouldReplaceModelEntries,
  validateGatewayCredentialMigration
} from "./model-config.ts";
import {
  dashboardActiveSessionPolicy
} from "./policy.ts";
import {
  gatewayProfileModelSource,
  gatewayProfileOwner,
  modelOptions,
  publicAgentModelTiers,
  publicDashboardSettings,
  publicGatewayConfig,
  publicGatewayProfiles,
  publicModelOption,
  publicVisionAgent
} from "./public-config.ts";
import {
  activeStateForSession,
  applySessionConfig,
  configForDashboardSelection,
  configForGatewayProfileSelection,
  configForStatusLists,
  configWithModelSelection,
  dashboardRuntimeSelection,
  defaultReasoningEffortForConfig,
  isConfigV2Enabled,
  persistDashboardSessionModelConfig,
  readDashboardSessionMetadataExact,
  reconcileActiveDashboardSessionsAfterV2Mutation,
  reconcileDashboardRuntimeSelections,
  refreshDashboardSessionAfterV2Mutation,
  rememberDashboardRuntimeSelection,
  resolveReasoningEffortSelection,
  sessionStatusForConfigUpdate,
  sessionStatusFromConfig,
  sessionStatusFromMetadata,
  sessionStatusSummary,
  syncIdleSessionConfig,
  unresolvedSessionModelSelectionResult
} from "./session-model.ts";
import {
  activeDashboardStatus,
  activeReplayCursor,
  activeSessionRecord,
  assistantTranscriptText,
  boundedSessionCwd,
  compareSessionRecords,
  createSnapshotReadState,
  createTranscriptPageResult,
  deleteDashboardSession,
  hasTranscriptCursor,
  mergeActiveTranscriptPage,
  persistedSessionFailure,
  publicBackgroundSnapshot,
  readStoredTranscriptPage,
  transcriptPageReadError
} from "./session-records.ts";
import {
  buildDashboardSettingsConfig,
  dashboardConfigEnv,
  dashboardConfigResultError,
  modelConfigTargetPath,
  mutateDashboardConfig,
  normalizeDashboardSettingsInput,
  normalizeModelConfigInput,
  readJsonConfig
} from "./settings.ts";
import {
  resolveDashboardTrust
} from "./trust.ts";
import {
  appendQueueUpdated,
  buildGuidePrompt,
  createQueueItem,
  isStopGuidance,
  normalizeMutationSessionId,
  previewText,
  publicQueueItem,
  quarantinedSessionResult,
  queueFullResult,
  queueHasCapacity,
  queueSnapshot,
  sessionMutationBusyResult,
  startDashboardTurn,
  withIdempotentTurnRequest,
  withKeyedMutation
} from "./turn-queue.ts";
import {
  appendDashboardEvent,
  clonePlainObject,
  eventId,
  isPlainObject,
  nonNegativeInteger
} from "./util.ts";

export async function runtimeStartTurn(ctx: DashboardFactoryState, input: DashboardRequestInput = {}) {
  if (ctx.shuttingDown) {
    return { ok: false, status: 503, code: "DASHBOARD_SHUTTING_DOWN", error: "Dashboard 正在关闭，不能再提交新任务" };
  }
  return withIdempotentTurnRequest(ctx.turnRequests, input, () => startDashboardTurn({
    active: ctx.active,
    sessionMutationLocks: ctx.sessionMutationLocks,
    activeCapacityLocks: ctx.activeCapacityLocks,
    activePolicy: ctx.activePolicy,
    cwd: ctx.cwd,
    runtimeEnv: ctx.runtimeEnv,
    resolveConfigEnv: ctx.resolveConfigEnv,
    processTrusted: ctx.processTrusted,
    runtimeSelection: dashboardRuntimeSelection(
      ctx.clientModelSelections,
      input.clientId,
      { providerId: ctx.selectedProviderId, modelId: ctx.selectedModelId, reasoningEffort: ctx.selectedReasoningEffort }
    ),
    runTurn: ctx.options.runTurn ?? runSessionTurn
  }, input));
}

export async function runtimeApplyGoal(ctx: DashboardFactoryState, input: DashboardRequestInput = {}) {
  return applyDashboardGoal({
    active: ctx.active,
    sessionMutationLocks: ctx.sessionMutationLocks,
    activeCapacityLocks: ctx.activeCapacityLocks,
    activePolicy: ctx.activePolicy,
    cwd: ctx.cwd,
    runtimeEnv: ctx.runtimeEnv,
    resolveConfigEnv: ctx.resolveConfigEnv,
    processTrusted: ctx.processTrusted,
    runtimeSelection: dashboardRuntimeSelection(
      ctx.clientModelSelections,
      input.clientId,
      { providerId: ctx.selectedProviderId, modelId: ctx.selectedModelId, reasoningEffort: ctx.selectedReasoningEffort }
    ),
    runTurn: ctx.options.runTurn ?? runSessionTurn
  }, input);
}

export function runtimeInterruptTurn(ctx: DashboardFactoryState, sessionId: string, reason: string = "user") {
  const normalized = normalizeMutationSessionId(sessionId);
  if (!normalized.ok) {
    return normalized;
  }
  if (ctx.sessionMutationLocks.has(normalized.sessionId)) {
    return sessionMutationBusyResult(normalized.sessionId);
  }
  const state = ctx.active.get(normalized.sessionId);
  if (!state) {
    return { ok: false, status: 404, error: "会话不存在" };
  }
  if (!state.running) {
    return { ok: false, status: 409, error: "当前没有正在运行的任务" };
  }
  if (state.quarantinedTurnId) {
    return quarantinedSessionResult(state);
  }
  requestTurnInterrupt(state, reason);
  return {
    ok: true,
    sessionId: state.session.id,
    interrupting: true,
    queue: queueSnapshot(state),
    sessionStatus: sessionStatusSummary(state.session)
  };
}

export function runtimeCancelQueuedTurn(ctx: DashboardFactoryState, input: DashboardRequestInput = {}) {
  const normalized = normalizeMutationSessionId(input.sessionId);
  if (!normalized.ok) {
    return normalized;
  }
  if (ctx.sessionMutationLocks.has(normalized.sessionId)) {
    return sessionMutationBusyResult(normalized.sessionId);
  }
  const state = ctx.active.get(normalized.sessionId);
  if (!state) {
    return { ok: false, status: 404, error: "会话不存在" };
  }
  const queueItemId = String(input.queueItemId ?? "").trim();
  if (!queueItemId) {
    return { ok: false, status: 400, error: "请选择要取消的排队消息" };
  }
  const queueItemIndex = state.queuedPrompts.findIndex((item) => item.id === queueItemId);
  if (queueItemIndex < 0) {
    return { ok: false, status: 404, error: "排队消息不存在或已被处理" };
  }
  const [removed] = state.queuedPrompts.splice(queueItemIndex, 1);
  const publicItem = publicQueueItem(removed);
  appendDashboardEvent(state, {
    type: "queue_item_cancelled",
    id: eventId("queue-cancelled"),
    item: publicItem,
    queue: queueSnapshot(state),
    queueLength: state.queuedPrompts.length,
    running: state.running,
    sessionStatus: sessionStatusSummary(state.session),
    changeStats: { ...state.turnChangeStats },
    at: new Date().toISOString()
  });
  appendQueueUpdated(state);
  return {
    ok: true,
    sessionId: state.session.id,
    item: publicItem,
    queue: queueSnapshot(state),
    queueLength: state.queuedPrompts.length,
    sessionStatus: sessionStatusSummary(state.session)
  };
}

export async function runtimeCancelBackgroundSubagent(ctx: DashboardFactoryState, input: DashboardRequestInput = {}) {
  const sessionId = String(input.sessionId ?? "").trim();
  const state = ctx.active.get(sessionId);
  if (!state) {
    return { ok: false, status: 404, error: "会话不存在" };
  }
  const groupId = String(input.groupId ?? "").trim();
  const taskId = String(input.taskId ?? "").trim();
  if (!groupId && !taskId) {
    return { ok: false, status: 400, error: "请选择要回收的子智能体任务" };
  }
  const groupStore = createAgentTaskGroupStore({ cwd: state.session.cwd });
  const taskStore = createAgentTaskStore({ cwd: state.session.cwd });
  const groupResult = groupId ? await groupStore.readGroup(groupId) : null;
  if (groupId && !groupResult?.ok) {
    return { ok: false, status: 404, error: "子智能体任务组不存在或已结束" };
  }
  if (groupResult?.ok && groupResult.group && groupResult.group.parentSessionId !== state.session.id) {
    return { ok: false, status: 403, code: "BACKGROUND_TASK_OWNERSHIP_MISMATCH", error: "子智能体任务组不属于该会话" };
  }
  if (taskId && groupResult?.ok && groupResult.group && !groupResult.group.taskIds.includes(taskId)) {
    return { ok: false, status: 404, error: "子智能体任务不存在或不属于该任务组" };
  }
  const targetTaskIds = groupResult?.ok && groupResult.group
    ? groupResult.group.taskIds
    : [taskId];
  if (targetTaskIds.length === 0) {
    return { ok: false, status: 404, error: "子智能体任务不存在或不属于该任务组" };
  }
  const targetTasks = [];
  for (const id of targetTaskIds) {
    const read = await taskStore.readTask(id);
    if (!read.ok) {
      return { ok: false, status: 404, error: "子智能体任务不存在" };
    }
    if (
      read.task.parentSessionId !== state.session.id
      || (groupId && read.task.groupId !== groupId)
    ) {
      return { ok: false, status: 403, code: "BACKGROUND_TASK_OWNERSHIP_MISMATCH", error: "子智能体任务不属于该会话或任务组" };
    }
    targetTasks.push(read.task);
  }
  const aborted = cancelBackgroundAgentTasks({
    parentSessionId: state.session.id,
    groupId: groupId || null,
    taskId: groupId ? null : taskId || null
  });
  const abortedTaskIds = new Set(aborted.filter((task) => task.aborted === true).map((task) => task.taskId));
  const cancellableTargets = targetTasks.filter((task) => !TERMINAL_TASK_STATUSES.has(String(task.status)));
  const now = new Date().toISOString();
  const updatedTasks = [];
  for (const task of cancellableTargets) {
    const updated = await taskStore.updateTask(task.id, {
      status: "interrupted",
      cancelRequestedAt: now,
      finishedAt: now,
      heartbeatAt: now,
      progressAt: now,
      latestProgress: backgroundSubagentCancelProgress(abortedTaskIds.has(task.id), "recycle")
    });
    if (updated.ok) {
      updatedTasks.push(updated.task);
    }
  }
  let group = groupResult && groupResult.ok ? groupResult.group : null;
  if (groupId && group) {
    const tasks = await readDashboardGroupTasks(taskStore, group.taskIds);
    const summary = summarizeGroupStatus(tasks, { waitFor: group.waitFor });
    const patch: {
      status: string;
      latestProgress: string;
      summary: string;
      metadata: Record<string, unknown>;
      completedAt?: string;
    } = {
      status: summary.status,
      latestProgress: summary.summary,
      summary: summary.summary,
      metadata: {
        ...(isPlainObject(group.metadata) ? group.metadata : {}),
        cancelledFromDashboardAt: now
      }
    };
    if (summary.completed) {
      patch.completedAt = now;
    }
    const updatedGroup = await groupStore.updateGroup(groupId, patch) as { ok?: unknown; group?: typeof group };
    group = updatedGroup.ok && updatedGroup.group ? updatedGroup.group : group;
  }
  appendDashboardEvent(state, {
    type: "background_subagent_cancelled",
    id: eventId("background-subagent-cancelled"),
    groupId: groupId || null,
    taskId: taskId || null,
    abortedTaskIds: [...abortedTaskIds],
    updatedTaskIds: updatedTasks.map((task) => task.id),
    sessionStatus: sessionStatusSummary(state.session),
    at: now
  });
  await appendBackgroundSubagentSnapshot(state);
  return {
    ok: true,
    sessionId: state.session.id,
    groupId: groupId || group?.id || null,
    taskId: taskId || null,
    abortedTaskIds: [...abortedTaskIds],
    updatedTaskIds: updatedTasks.map((task) => task.id),
    sessionStatus: sessionStatusSummary(state.session)
  };
}

export async function runtimeCancelBackgroundTerminal(ctx: DashboardFactoryState, input: DashboardRequestInput = {}) {
  const sessionId = String(input.sessionId ?? "").trim();
  const state = ctx.active.get(sessionId);
  if (!state) {
    return { ok: false, status: 404, error: "会话不存在" };
  }
  const taskId = String(input.taskId ?? "").trim();
  if (!taskId) {
    return { ok: false, status: 400, error: "请选择要回收的后台终端任务" };
  }
  const owned = listBackgroundTerminalTasks({
    parentSessionId: state.session.id,
    cwd: state.session.cwd,
    taskId
  }).filter((task) => (
    (task.status === "starting" || task.status === "running" || task.status === "cancelling")
    && task.cwd
    && path.resolve(task.cwd) === path.resolve(state.session.cwd)
  ));
  if (owned.length === 0) {
    return {
      ok: false,
      status: 404,
      code: "BACKGROUND_TERMINAL_NOT_ACTIVE",
      error: "后台终端任务不存在、不属于该会话或已结束"
    };
  }
  const cancellationResults = await cancelBackgroundTerminalTasks({
    parentSessionId: state.session.id,
    cwd: state.session.cwd,
    taskId
  });
  const cancelled = cancellationResults.filter((task) => task.status === "cancelled" && task.cancellationConfirmed === true);
  if (cancelled.length === 0) {
    return {
      ok: false,
      status: 409,
      code: "BACKGROUND_TERMINAL_CANCEL_UNCONFIRMED",
      error: cancellationResults[0]?.cancelError || "后台终端任务未确认退出，未标记为已取消"
    };
  }
  appendDashboardEvent(state, {
    type: "background_terminal_cancelled",
    id: eventId("background-terminal-cancelled"),
    taskId,
    cancelledTaskIds: cancelled.map((task) => task.taskId),
    sessionStatus: sessionStatusSummary(state.session),
    at: new Date().toISOString()
  });
  await appendBackgroundSubagentSnapshot(state);
  return {
    ok: true,
    sessionId: state.session.id,
    taskId,
    cancelledTaskIds: cancelled.map((task) => task.taskId),
    sessionStatus: sessionStatusSummary(state.session)
  };
}

export function runtimeGuideTurn(ctx: DashboardFactoryState, input: DashboardRequestInput) {
  const normalized = normalizeMutationSessionId(input.sessionId);
  if (!normalized.ok) {
    return normalized;
  }
  if (ctx.sessionMutationLocks.has(normalized.sessionId)) {
    return sessionMutationBusyResult(normalized.sessionId);
  }
  const state = ctx.active.get(normalized.sessionId);
  if (!state) {
    return { ok: false, status: 404, error: "会话不存在" };
  }
  if (!state.running) {
    return { ok: false, status: 409, error: "当前没有正在运行的任务" };
  }
  if (state.quarantinedTurnId) {
    return quarantinedSessionResult(state);
  }
  const queueItemId = String(input.queueItemId ?? "").trim();
  const queueItemIndex = queueItemId
    ? state.queuedPrompts.findIndex((item) => item.id === queueItemId && item.kind !== "guide")
    : -1;
  const queuedItem = queueItemIndex >= 0 ? state.queuedPrompts[queueItemIndex] : null;
  if (queueItemId && !queuedItem) {
    return { ok: false, status: 404, error: "排队消息不存在或已被处理" };
  }
  const guidance = String(queuedItem?.guidance ?? input.guidance ?? input.prompt ?? "").trim();
  if (!guidance) {
    return { ok: false, status: 400, error: "请输入引导内容" };
  }
  if (!queuedItem && !queueHasCapacity(state)) {
    return queueFullResult(state);
  }
  if (queuedItem) {
    state.queuedPrompts.splice(queueItemIndex, 1);
  }
  if (isStopGuidance(guidance)) {
    requestTurnInterrupt(state, "guide-stop");
    appendDashboardEvent(state, {
      type: "guide_stopped",
      id: eventId("guide-stop"),
      guidance: previewText(guidance),
      queue: queueSnapshot(state),
      at: new Date().toISOString()
    });
    return { ok: true, stopped: true, sessionId: state.session.id, queue: queueSnapshot(state), sessionStatus: sessionStatusSummary(state.session) };
  }

  const mode = normalizePermissionMode(String(input.permissionMode ?? state.currentPermissionMode));
  const item = createQueueItem(buildGuidePrompt(guidance, state.currentPrompt), mode, "guide", guidance);
  state.queuedPrompts.unshift(item);
  appendDashboardEvent(state, {
    type: "guide_queued",
    id: eventId("guide"),
    item: publicQueueItem(item),
    guidance: previewText(guidance),
    queue: queueSnapshot(state),
    queueLength: state.queuedPrompts.length,
    at: new Date().toISOString()
  });
  appendQueueUpdated(state);
  requestTurnInterrupt(state, "guided");
  return {
    ok: true,
    queued: true,
    sessionId: state.session.id,
    queue: queueSnapshot(state),
    queueLength: state.queuedPrompts.length,
    sessionStatus: sessionStatusSummary(state.session)
  };
}

export async function runtimeClearContext(ctx: DashboardFactoryState, input: DashboardRequestInput = {}) {
  return mutateDashboardContext({
    active: ctx.active,
    sessionMutationLocks: ctx.sessionMutationLocks,
    activeCapacityLocks: ctx.activeCapacityLocks,
    activePolicy: ctx.activePolicy,
    cwd: ctx.cwd,
    runtimeEnv: ctx.runtimeEnv,
    resolveConfigEnv: ctx.resolveConfigEnv,
    processTrusted: ctx.processTrusted
  }, input, "clear");
}

export async function runtimeCompactContext(ctx: DashboardFactoryState, input: DashboardRequestInput = {}) {
  return mutateDashboardContext({
    active: ctx.active,
    sessionMutationLocks: ctx.sessionMutationLocks,
    activeCapacityLocks: ctx.activeCapacityLocks,
    activePolicy: ctx.activePolicy,
    cwd: ctx.cwd,
    runtimeEnv: ctx.runtimeEnv,
    resolveConfigEnv: ctx.resolveConfigEnv,
    processTrusted: ctx.processTrusted
  }, input, "compact");
}
