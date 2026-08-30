import type { DashboardFactoryState } from "./factory-state.ts";
import type { DashboardRequestInput, DashboardEventListener, DashboardActiveSessionState, LifecycleProbe } from "./types.ts";
import { FORCE_SHUTDOWN_GRACE_MS, LIFECYCLE_STATUS_WAIT_MS } from "./types.ts";
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

export function runtimeSubscribe(ctx: DashboardFactoryState, sessionId: string, send: DashboardEventListener, options: { onDispose?: (reason?: unknown) => void; afterSequence?: unknown } = {}) {
  const state = ctx.active.get(sessionId);
  if (!state) {
    return null;
  }
  state.listeners.add(send);
  if (typeof options.onDispose === "function") {
    state.listenerDisposers.set(send, options.onDispose);
  }
  const afterSequence = nonNegativeInteger(options.afterSequence);
  for (const event of state.events) {
    if (nonNegativeInteger(event.sequence) > afterSequence) {
      send(event);
    }
  }
  return () => {
    state.listeners.delete(send);
    state.listenerDisposers.delete(send);
  };
}

export function runtimeListActiveEvents(ctx: DashboardFactoryState, sessionId: string) {
  return ctx.active.get(sessionId)?.events ?? [];
}

export async function runtimeSessionCwd(ctx: DashboardFactoryState, sessionId: string) {
  const configEnv = await ctx.resolveConfigEnv();
  const id = String(sessionId ?? "").trim();
  if (!id) {
    return { ok: false, status: 400, error: "缺少会话 ID" };
  }
  const activeState = ctx.active.get(id);
  if (activeState?.session?.cwd) {
    return boundedSessionCwd(ctx.cwd, activeState.session.cwd);
  }
  const config = await loadConfig({ cwd: ctx.cwd, env: configEnv });
  const store = createSessionStore({ cwd: ctx.cwd, transcript: config.transcript, env: ctx.runtimeEnv });
  const result = await store.readMetadata(id);
  if (!result.ok) {
    return { ok: false, status: 404, error: "会话不存在" };
  }
  if (String(result.metadata?.id ?? "") !== id) {
    return { ok: false, status: 400, code: "EXACT_SESSION_ID_REQUIRED", error: "文件接口只接受完整会话 ID" };
  }
  return boundedSessionCwd(ctx.cwd, String(result.metadata?.cwd ?? ctx.cwd));
}

export function runtimeResolveApproval(ctx: DashboardFactoryState, approvalId: unknown, action: unknown) {
  for (const state of ctx.active.values()) {
    const pending = state.pendingApprovals.get(String(approvalId ?? ""));
    if (!pending) {
      continue;
    }
    state.pendingApprovals.delete(approvalId);
    const allowed = action === "allow-once" || action === "allow-session";
    if (action === "allow-session") {
      state.sessionApprovals.add(pending.approvalKey);
    }
    appendDashboardEvent(state, {
      type: "approval_resolved",
      id: eventId("approval-resolved"),
      approvalId,
      action,
      allowed,
      at: new Date().toISOString()
    });
    pending.resolve(allowed);
    return { ok: true };
  }
  return { ok: false, status: 404, error: "审批请求不存在或已处理" };
}

export function runtimeResolveQuestion(ctx: DashboardFactoryState, questionId: unknown, answer: unknown = {}) {
  for (const state of ctx.active.values()) {
    const pending = state.pendingQuestions.get(questionId);
    if (!pending) {
      continue;
    }
    state.pendingQuestions.delete(questionId);
    const result = normalizeQuestionAnswer(answer, pending.question);
    appendDashboardEvent(state, {
      type: "question_resolved",
      id: eventId("question-resolved"),
      questionId,
      answer: result.answer,
      selectedChoice: result.selectedChoice,
      selectedChoices: result.selectedChoices,
      cancelled: result.cancelled === true,
      at: new Date().toISOString()
    });
    pending.resolve(result);
    return { ok: true };
  }
  return { ok: false, status: 404, error: "需求核对请求不存在或已处理" };
}

export async function runtimeLifecycleStatus(ctx: DashboardFactoryState) {
  const timeoutMs = Math.min(LIFECYCLE_STATUS_WAIT_MS, lifecycleWaitMs(undefined, ctx.runtimeEnv));
  const probe = await waitForLifecycleOperation(
    (signal: AbortSignal) => ctx.readRuntimeActivity(ctx.active, ctx.cwd, { signal }),
    Date.now() + timeoutMs
  );
  if (!probe.settled || probe.error) {
    return {
      ok: false,
      status: 503,
      code: probe.error ? "LIFECYCLE_STATUS_FAILED" : "LIFECYCLE_STATUS_TIMEOUT",
      error: probe.error ? "Dashboard 活动状态检查失败" : "Dashboard 活动状态检查超时",
      activity: dashboardMemoryActivity(ctx.active, true),
      timeoutMs
    };
  }
  return {
    ok: true,
    activity: probe.value
  };
}

export async function runtimeSweepIdleSessions(ctx: DashboardFactoryState) {
  const evicted = await reclaimActiveSessions(ctx.active, {
    cwd: ctx.cwd,
    env: ctx.runtimeEnv,
    sessionMutationLocks: ctx.sessionMutationLocks,
    policy: ctx.activePolicy,
    ttlOnly: true
  });
  return { ok: true, evicted, activeSessions: ctx.active.size };
}

export async function runtimeShutdown(ctx: DashboardFactoryState, input: DashboardRequestInput = {}) {
  if (ctx.shuttingDown) {
    return { ok: false, status: 409, code: "SHUTDOWN_IN_PROGRESS", error: "Dashboard 已在关闭" };
  }
  const forceShutdown = input.force === true;
  const requestedTimeoutMs = lifecycleWaitMs(input.timeoutMs, ctx.runtimeEnv);
  const timeoutMs = forceShutdown
    ? Math.min(requestedTimeoutMs, FORCE_SHUTDOWN_GRACE_MS)
    : requestedTimeoutMs;
  const deadline = Date.now() + timeoutMs;
  ctx.shuttingDown = true;
  let completed = false;
  try {
    const initialProbe: LifecycleProbe = forceShutdown
      ? { settled: false }
      : await waitForLifecycleOperation(
        (signal: AbortSignal) => ctx.readRuntimeActivity(ctx.active, ctx.cwd, { signal }),
        deadline
      );
    const initial = initialProbe.settled && !initialProbe.error
      ? initialProbe.value
      : dashboardMemoryActivity(ctx.active, true);
    if ((!initialProbe.settled || initialProbe.error) && !forceShutdown) {
      return {
        ok: false,
        status: 409,
        code: initialProbe.error ? "SHUTDOWN_ACTIVITY_FAILED" : "SHUTDOWN_ACTIVITY_TIMEOUT",
        error: initialProbe.error ? "关闭前活动状态检查失败" : "关闭前活动状态检查超时",
        activity: initial,
        timeoutMs
      };
    }
    const cancelActive = input.cancel === true || input.cancelActive === true || forceShutdown;
    const cancelBackground = input.cancel === true || input.cancelBackground === true || forceShutdown;
    if (Number(isPlainObject(initial) ? initial.total : 0) > 0 && !cancelActive && !cancelBackground) {
      return {
        ok: false,
        status: 409,
        code: "ACTIVE_WORK_REQUIRES_DECISION",
        error: "仍有活动任务，请明确选择取消并关闭或返回",
        activity: initial
      };
    }
    if (cancelActive) {
      for (const state of ctx.active.values()) {
        cancelAllQueuedTurns(state, "shutdown");
        if (state.running) {
          requestTurnInterrupt(state, "shutdown");
        } else {
          cancelPendingInteractions(state, "shutdown");
        }
      }
    }
    if (cancelBackground) {
      await cancelWorkspaceBackgroundTerminals(ctx.cwd, { memoryOnly: forceShutdown });
      const cancellations = [...ctx.active.values()].map((state: DashboardActiveSessionState) => (
        Promise.resolve().then(() => ctx.cancelBackgroundWork(state, { cancelTerminals: false }))
      ));
      const cancellation = await waitForLifecycleOperation(
        () => Promise.allSettled(cancellations),
        deadline
      );
      if ((!cancellation.settled || cancellation.error) && !forceShutdown) {
        return {
          ok: false,
          status: 409,
          code: cancellation.error ? "SHUTDOWN_BACKGROUND_FAILED" : "SHUTDOWN_BACKGROUND_TIMEOUT",
          error: cancellation.error ? "后台任务清理失败" : "后台任务未在清理时限内结束",
          activity: dashboardMemoryActivity(ctx.active, true),
          timeoutMs
        };
      }
    }
    const activityResult = forceShutdown
      ? { settled: false, activity: dashboardMemoryActivity(ctx.active, true) }
      : await waitForRuntimeActivity(ctx.active, deadline, ctx.cwd, ctx.readRuntimeActivity);
    const settled = activityResult.activity;
    if ((!activityResult.settled || settled.total > 0) && !forceShutdown) {
      return {
        ok: false,
        status: 409,
        code: "SHUTDOWN_TIMEOUT",
        error: "活动任务未在清理时限内结束",
        activity: settled,
        timeoutMs
      };
    }
    const sweepSettled = await waitForLifecyclePromise(ctx.activeSweepPromise, deadline);
    if (!sweepSettled && !forceShutdown) {
      return {
        ok: false,
        status: 409,
        code: "SHUTDOWN_SWEEP_TIMEOUT",
        error: "会话维护任务未在清理时限内结束",
        activity: settled,
        timeoutMs
      };
    }
    clearInterval(ctx.activeSweepTimer);
    for (const state of ctx.active.values()) {
      if (state.session?.goal?.enabled) {
        state.session.goal.status = "paused";
        state.session.goal.lastBlockReason = "dashboard_shutdown";
        await persistGoalSnapshot(state);
      }
      disposeTurnState(state, "shutdown");
    }
    ctx.active.clear();
    ctx.turnRequests.clear();
    completed = true;
    return {
      ok: true,
      forced: forceShutdown || !activityResult.settled || settled.total > 0 || !sweepSettled,
      cancelled: cancelActive || cancelBackground,
      activity: settled,
      initialActivity: initial,
      timeoutMs
    };
  } finally {
    if (!completed) {
      ctx.shuttingDown = false;
    }
  }
}

export function runtimeSessionFiles(ctx: DashboardFactoryState, sessionId: string) {
  const state = ctx.active.get(sessionId);
  if (!state) {
    return [];
  }
  return collectSessionFiles(state.session, state.finalOutput);
}
