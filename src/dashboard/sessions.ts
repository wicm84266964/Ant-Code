import path from "node:path";
import { randomBytes } from "node:crypto";
import { persistSessionSnapshot, runSessionTurn, SessionModelSelectionUnresolvedError } from "../core/session.ts";
import { GATEWAY_PROTOCOLS, globalConfigPath, loadConfig, localProjectConfigPath, type LabAgentConfig } from "../config/load-config.ts";
import { listConfiguredModels, normalizeReasoningEfforts, resolveModelSelection } from "../model-gateway/models.ts";
import { createSessionStore } from "../storage/session-store.ts";
import { collectSessionFiles } from "./files.ts";
import { applyPermissionMode, normalizePermissionMode, permissionModeSummary } from "./permissions.ts";
import {
  publicV2ConfigState,
  saveV2DefaultModel,
  saveV2ProviderModel,
  deleteV2Provider,
  deleteV2ProviderModel,
  dashboardV2ErrorResult
} from "./model-settings-v2.ts";
import { mutateJsonConfig } from "./config-store.ts";
import { getAntCodeVersion } from "../version.ts";
import { resolveWorkspaceTrust, trustWorkspace as saveWorkspaceTrust } from "../permissions/workspace-trust.ts";
import { GOAL_CONTINUE_KIND, publicGoalSnapshot } from "../core/goal.ts";
import { currentRuntimeModelSelection, resolveSessionModelSelection } from "../config-v2/runtime-selection.ts";
import { cancelBackgroundAgentTasks } from "../agents/background-registry.ts";
import { cancelBackgroundTerminalTasks, listBackgroundTerminalTasks } from "../agents/background-terminal-registry.ts";
import { createAgentTaskStore } from "../agents/task-store.ts";
import { createAgentTaskGroupStore, summarizeGroupStatus } from "../agents/task-group-store.ts";
export { DASHBOARD_ACTIVE_SESSION_DEFAULTS } from "./runtime/types.ts";

import type { DashboardFactoryState, DashboardRuntimeApi } from "./runtime/factory-state.ts";
import { runtimeStatus, runtimeSaveSettingsConfig } from "./runtime/api-settings.ts";
import { runtimeSwitchModel, runtimeSwitchReasoningEffort } from "./runtime/api-model.ts";
import {
  runtimeSaveModelConfig,
  runtimeProbeGateway,
  runtimeProbeModelCapabilities,
  runtimeDeleteModelConfig,
  runtimeDeleteGatewayProfile,
  runtimeSwitchGatewayProfile,
  runtimeSaveDefaultModelSelection
} from "./runtime/api-model-config.ts";
import {
  runtimeTrustStatus,
  runtimeTrustWorkspace,
  runtimeListSessionRecords,
  runtimeReadSession,
  runtimeReadTranscriptPage,
  runtimeDeleteSession
} from "./runtime/api-sessions.ts";
import {
  runtimeStartTurn,
  runtimeApplyGoal,
  runtimeInterruptTurn,
  runtimeCancelQueuedTurn,
  runtimeCancelBackgroundSubagent,
  runtimeCancelBackgroundTerminal,
  runtimeGuideTurn,
  runtimeClearContext,
  runtimeCompactContext
} from "./runtime/api-turn.ts";
import {
  runtimeSubscribe,
  runtimeListActiveEvents,
  runtimeSessionCwd,
  runtimeResolveApproval,
  runtimeResolveQuestion,
  runtimeLifecycleStatus,
  runtimeSweepIdleSessions,
  runtimeShutdown,
  runtimeSessionFiles
} from "./runtime/api-lifecycle.ts";
import {
  ActiveSessionMap,
  DASHBOARD_ACTIVE_SESSION_DEFAULTS,
  FORCE_SHUTDOWN_GRACE_MS,
  LIFECYCLE_STATUS_WAIT_MS,
  MAX_EVENTS,
  RETENTION_MAINTENANCE_INTERVAL_MS,
  TERMINAL_TASK_STATUSES,
  TURN_REQUEST_TTL_MS
} from "./runtime/types.ts";
import type {
  DashboardActiveSessionState,
  DashboardEventListener,
  DashboardRequestInput,
  DashboardRuntimeSelection,
  GatewayDiscoveryCatalog,
  GatewayDiscoveryEntry,
  LifecycleProbe,
  RuntimeActivityReader,
  TurnRequestRecord
} from "./runtime/types.ts";
import {
  reclaimActiveSessions
} from "./runtime/active-map.ts";
import {
  cancelPendingInteractions,
  normalizeQuestionAnswer,
  requestTurnInterrupt
} from "./runtime/approvals.ts";
import {
  appendBackgroundSubagentSnapshot,
  buildBackgroundSubagentSnapshot,
  cancelSessionBackgroundWork,
  cancelWorkspaceBackgroundTerminals,
  loadDashboardGroupSnapshots,
  readDashboardGroupTasks
} from "./runtime/background.ts";
import {
  mutateDashboardContext
} from "./runtime/context-control.ts";
import {
  boundedGatewayDiscoveryTtl,
  consumeGatewayDiscovery,
  mergeReasoningProbeIntoCatalog,
  probeGatewayConnection,
  probeModelReasoningCapabilities,
  rememberGatewayDiscovery,
  resolveGatewayDiscovery,
  validateGatewayDiscoveryEntry
} from "./runtime/gateway-probe.ts";
import {
  applyDashboardGoal,
  persistGoalSnapshot,
  sessionRecordGoalStatus
} from "./runtime/goal-runtime.ts";
import {
  cancelAllQueuedTurns,
  dashboardMemoryActivity,
  dashboardRuntimeActivity,
  disposeTurnState,
  lifecycleWaitMs,
  waitForLifecycleOperation,
  waitForLifecyclePromise,
  waitForRuntimeActivity
} from "./runtime/lifecycle.ts";
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
} from "./runtime/model-config.ts";
import {
  dashboardActiveSessionPolicy
} from "./runtime/policy.ts";
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
} from "./runtime/public-config.ts";
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
} from "./runtime/session-model.ts";
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
} from "./runtime/session-records.ts";
import {
  buildDashboardSettingsConfig,
  dashboardConfigEnv,
  dashboardConfigResultError,
  modelConfigTargetPath,
  mutateDashboardConfig,
  normalizeDashboardSettingsInput,
  normalizeModelConfigInput,
  readJsonConfig
} from "./runtime/settings.ts";
import {
  resolveDashboardTrust
} from "./runtime/trust.ts";
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
} from "./runtime/turn-queue.ts";
import {
  appendDashboardEvent,
  clonePlainObject,
  eventId,
  isPlainObject,
  nonNegativeInteger
} from "./runtime/util.ts";

export type CreateDashboardRuntimeOptions = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  runTurn?: typeof runSessionTurn;
  lifecycleActivity?: (active: ActiveSessionMap, cwd: string, extra?: unknown) => Promise<unknown>;
  cancelBackgroundWork?: (state: DashboardActiveSessionState, options?: Record<string, unknown>) => Promise<unknown>;
  gatewayDiscoveryTtlMs?: number;
  gatewayDiscoveryNow?: () => number;
};


export function createDashboardRuntime(options: CreateDashboardRuntimeOptions) {
  const runtimeEnv = options.env ?? process.env;
  const active = new ActiveSessionMap();
  const sessionMutationLocks = new Map<string, Promise<unknown>>();
  const sessionConfigMutationLock = Symbol("session-config-mutation-lock");
  const activeCapacityLocks = new Map<string, Promise<unknown>>();
  const turnRequests = new Map<string, TurnRequestRecord>();
  const clientModelSelections = new Map<string, DashboardRuntimeSelection>();
  const gatewayDiscoveries = new Map<string, GatewayDiscoveryEntry>();
  const gatewayDiscoverySecret = randomBytes(32);
  const gatewayDiscoveryTtlMs = boundedGatewayDiscoveryTtl(options.gatewayDiscoveryTtlMs);
  const gatewayDiscoveryNow = typeof options.gatewayDiscoveryNow === "function"
    ? options.gatewayDiscoveryNow
    : Date.now;
  const activePolicy = dashboardActiveSessionPolicy(runtimeEnv);
  let processTrusted = false;
  let selectedModelId = "";
  let selectedProviderId = "";
  let selectedReasoningEffort = "";
  let shuttingDown = false;
  let activeSweepPromise: Promise<unknown> | null = null;
  /** @type {any} */
  const readRuntimeActivity: RuntimeActivityReader = (active, cwd, extra) => (
    (options.lifecycleActivity ?? dashboardRuntimeActivity)(active, cwd, extra)
  );
  /** @type {any} */
  const cancelBackgroundWork = options.cancelBackgroundWork ?? cancelSessionBackgroundWork;
  const resolveConfigEnv = () => dashboardConfigEnv(options.cwd, runtimeEnv);
  let retentionMaintenanceTail = Promise.resolve();
  /** @type {Promise<any> | null} */
  let pendingRetentionMaintenance: Promise<unknown> | null = null;
  let lastRetentionMaintenanceAt = 0;
  /**
   * @param {Record<string, any>} config
   * @param {{ force?: boolean }} [maintenanceOptions]
   */
  const maintainSessionRetention = (config: LabAgentConfig, maintenanceOptions: { force?: boolean } = {}) => {
    const force = maintenanceOptions.force === true;
    const requestedAt = Date.now();
    if (!force && pendingRetentionMaintenance) {
      return pendingRetentionMaintenance;
    }
    if (!force && requestedAt - lastRetentionMaintenanceAt < RETENTION_MAINTENANCE_INTERVAL_MS) {
      return Promise.resolve({ ok: true, deleted: [], skipped: "throttled" });
    }
    lastRetentionMaintenanceAt = requestedAt;
    const retentionDays = config.transcript?.retentionDays === null
      ? null
      : Number.isFinite(config.transcript?.retentionDays) ? config.transcript.retentionDays : 30;
    const run = retentionMaintenanceTail.then(async () => {
      try {
        return await withKeyedMutation(activeCapacityLocks, "active-capacity", async () => {
          const store = createSessionStore({ cwd: options.cwd, transcript: config.transcript, env: runtimeEnv });
          const result = await store.cleanupExpiredSessions(retentionDays, {
            excludeSessionIds: [...active.keys()]
          });
          return { ok: true, deleted: result.deleted };
        });
      } catch (error) {
        return {
          ok: false,
          deleted: [],
          error: error instanceof Error ? error.message : String(error)
        };
      }
    });
    retentionMaintenanceTail = run.then(() => undefined, () => undefined);
    const pending = run.finally(() => {
      if (pendingRetentionMaintenance === pending) {
        pendingRetentionMaintenance = null;
      }
    });
    pendingRetentionMaintenance = pending;
    return pending;
  };
  const activeSweepTimer = setInterval(() => {
    if (activeSweepPromise || shuttingDown) {
      return;
    }
    activeSweepPromise = reclaimActiveSessions(active, {
      cwd: options.cwd,
      env: runtimeEnv,
      sessionMutationLocks,
      policy: activePolicy,
      ttlOnly: true
    }).catch(() => {
      // Maintenance retries on the next sweep; runtime requests remain authoritative.
    }).finally(() => {
      activeSweepPromise = null;
    });
  }, activePolicy.sweepIntervalMs);
  activeSweepTimer.unref?.();

  const rerunWithSessionConfigLock = (input: DashboardRequestInput, rerun: (lockedInput: DashboardRequestInput) => Promise<unknown>) => {
    const sessionId = String(input?.sessionId ?? "").trim();
    if (!sessionId || Reflect.get(input, sessionConfigMutationLock) === sessionId) return null;
    const lockedInput = { ...input, sessionId };
    Reflect.set(lockedInput, sessionConfigMutationLock, sessionId);
    return withKeyedMutation(sessionMutationLocks, sessionId, () => rerun(lockedInput));
  };

  const ctx: DashboardFactoryState = {
    cwd: options.cwd,
    options,
    runtimeEnv,
    active,
    sessionMutationLocks,
    sessionConfigMutationLock,
    activeCapacityLocks,
    turnRequests,
    clientModelSelections,
    gatewayDiscoveries,
    gatewayDiscoverySecret,
    gatewayDiscoveryTtlMs,
    gatewayDiscoveryNow,
    activePolicy,
    processTrusted,
    selectedModelId,
    selectedProviderId,
    selectedReasoningEffort,
    shuttingDown,
    activeSweepPromise,
    readRuntimeActivity,
    cancelBackgroundWork,
    resolveConfigEnv,
    maintainSessionRetention,
    rerunWithSessionConfigLock,
    runtime: null as unknown as DashboardRuntimeApi,
    activeSweepTimer
  };
  const runtime = {
    cwd: ctx.cwd,
    env: ctx.runtimeEnv,
    active: ctx.active,
    activePolicy: { ...ctx.activePolicy },
    status: (input: DashboardRequestInput = {}) => runtimeStatus(ctx, input),
    saveSettingsConfig: (input: DashboardRequestInput = {}) => runtimeSaveSettingsConfig(ctx, input),
    switchModel: (input: DashboardRequestInput = {}) => runtimeSwitchModel(ctx, input),
    switchReasoningEffort: (input: DashboardRequestInput = {}) => runtimeSwitchReasoningEffort(ctx, input),
    saveModelConfig: (input: DashboardRequestInput = {}) => runtimeSaveModelConfig(ctx, input),
    probeGateway: (input: DashboardRequestInput = {}) => runtimeProbeGateway(ctx, input),
    probeModelCapabilities: (input: DashboardRequestInput = {}, request: { signal?: AbortSignal } = {}) => runtimeProbeModelCapabilities(ctx, input, request),
    deleteModelConfig: (input: DashboardRequestInput = {}) => runtimeDeleteModelConfig(ctx, input),
    deleteGatewayProfile: (input: DashboardRequestInput = {}) => runtimeDeleteGatewayProfile(ctx, input),
    switchGatewayProfile: (input: DashboardRequestInput = {}) => runtimeSwitchGatewayProfile(ctx, input),
    saveDefaultModelSelection: (input: DashboardRequestInput = {}) => runtimeSaveDefaultModelSelection(ctx, input),
    trustStatus: () => runtimeTrustStatus(ctx),
    trustWorkspace: () => runtimeTrustWorkspace(ctx),
    listSessionRecords: () => runtimeListSessionRecords(ctx),
    readSession: (selector: unknown) => runtimeReadSession(ctx, selector),
    readTranscriptPage: (input: DashboardRequestInput = {}) => runtimeReadTranscriptPage(ctx, input),
    deleteSession: (input: DashboardRequestInput = {}) => runtimeDeleteSession(ctx, input),
    startTurn: (input: DashboardRequestInput = {}) => runtimeStartTurn(ctx, input),
    applyGoal: (input: DashboardRequestInput = {}) => runtimeApplyGoal(ctx, input),
    interruptTurn: (sessionId: string, reason = "user") => runtimeInterruptTurn(ctx, sessionId, reason),
    cancelQueuedTurn: (input: DashboardRequestInput = {}) => runtimeCancelQueuedTurn(ctx, input),
    cancelBackgroundSubagent: (input: DashboardRequestInput = {}) => runtimeCancelBackgroundSubagent(ctx, input),
    cancelBackgroundTerminal: (input: DashboardRequestInput = {}) => runtimeCancelBackgroundTerminal(ctx, input),
    guideTurn: (input: DashboardRequestInput) => runtimeGuideTurn(ctx, input),
    clearContext: (input: DashboardRequestInput = {}) => runtimeClearContext(ctx, input),
    compactContext: (input: DashboardRequestInput = {}) => runtimeCompactContext(ctx, input),
    subscribe: (sessionId: string, send: DashboardEventListener, options: { onDispose?: (reason?: unknown) => void; afterSequence?: unknown } = {}) => runtimeSubscribe(ctx, sessionId, send, options),
    listActiveEvents: (sessionId: string) => runtimeListActiveEvents(ctx, sessionId),
    sessionCwd: (sessionId: string) => runtimeSessionCwd(ctx, sessionId),
    resolveApproval: (approvalId: unknown, action: unknown) => runtimeResolveApproval(ctx, approvalId, action),
    resolveQuestion: (questionId: unknown, answer: unknown = {}) => runtimeResolveQuestion(ctx, questionId, answer),
    lifecycleStatus: () => runtimeLifecycleStatus(ctx),
    sweepIdleSessions: () => runtimeSweepIdleSessions(ctx),
    shutdown: (input: DashboardRequestInput = {}) => runtimeShutdown(ctx, input),
    sessionFiles: (sessionId: string) => runtimeSessionFiles(ctx, sessionId)
  };
  ctx.runtime = runtime;
  Object.defineProperty(ctx, "processTrusted", { get() { return processTrusted; }, set(v) { processTrusted = v; } });
  Object.defineProperty(ctx, "selectedModelId", { get() { return selectedModelId; }, set(v) { selectedModelId = v; } });
  Object.defineProperty(ctx, "selectedProviderId", { get() { return selectedProviderId; }, set(v) { selectedProviderId = v; } });
  Object.defineProperty(ctx, "selectedReasoningEffort", { get() { return selectedReasoningEffort; }, set(v) { selectedReasoningEffort = v; } });
  Object.defineProperty(ctx, "shuttingDown", { get() { return shuttingDown; }, set(v) { shuttingDown = v; } });
  Object.defineProperty(ctx, "activeSweepPromise", { get() { return activeSweepPromise; }, set(v) { activeSweepPromise = v; } });
  return runtime;
}

