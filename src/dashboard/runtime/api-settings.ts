import type { DashboardFactoryState } from "./factory-state.ts";
import type { DashboardRequestInput, DashboardEventListener } from "./types.ts";
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

export async function runtimeStatus(ctx: DashboardFactoryState, input: DashboardRequestInput = {}) {
  const configEnv = await ctx.resolveConfigEnv();
  const config = await loadConfig({ cwd: ctx.cwd, env: configEnv });
  await ctx.maintainSessionRetention(config);
  const runtimeSelection = dashboardRuntimeSelection(
    ctx.clientModelSelections,
    input.clientId,
    { providerId: ctx.selectedProviderId, modelId: ctx.selectedModelId, reasoningEffort: ctx.selectedReasoningEffort }
  );
  const modelConfig = configForDashboardSelection(config, runtimeSelection);
  const configV2 = publicV2ConfigState(config);
  return {
    ok: true,
    sessionStatus: sessionStatusFromConfig(modelConfig),
    models: modelOptions(modelConfig),
    agentModelTiers: publicAgentModelTiers(modelConfig),
    visionAgent: publicVisionAgent(modelConfig),
    gatewayConfig: publicGatewayConfig(modelConfig),
    gatewayProfiles: publicGatewayProfiles(modelConfig),
    settings: publicDashboardSettings(modelConfig, ctx.runtimeEnv),
    configV2,
    configRevisions: configV2.revisions
  };
}

export async function runtimeSaveSettingsConfig(ctx: DashboardFactoryState, input: DashboardRequestInput = {}) {
  const locked = ctx.rerunWithSessionConfigLock(input, (lockedInput) => ctx.runtime.saveSettingsConfig(lockedInput));
  if (locked) return locked;
  const configEnv = await ctx.resolveConfigEnv();
  let config = await loadConfig({ cwd: ctx.cwd, env: configEnv });
  const sessionId = String(input.sessionId ?? "").trim();
  const state = sessionId ? ctx.active.get(sessionId) : null;
  if (state?.running) {
    return {
      ok: false,
      status: 409,
      error: "任务运行中，结束或中断后再修改设置",
      settings: publicDashboardSettings(state.session.config, ctx.runtimeEnv)
    };
  }
  let normalized = normalizeDashboardSettingsInput(input, config, ctx.runtimeEnv);
  if (!normalized.ok) {
    return normalized;
  }
  const configPath = modelConfigTargetPath(ctx.cwd, configEnv, normalized.saveTarget);
  const mutation = await mutateDashboardConfig(configPath, async (/** @type {Record<string, any>} */ targetConfig: Record<string, unknown>) => {
    config = await loadConfig({ cwd: ctx.cwd, env: await ctx.resolveConfigEnv() });
    normalized = normalizeDashboardSettingsInput(input, config, ctx.runtimeEnv);
    if (!normalized.ok) {
      throw dashboardConfigResultError(normalized);
    }
    return buildDashboardSettingsConfig(targetConfig, normalized);
  });
  if (!mutation.ok) {
    return mutation;
  }
  const refreshed = await loadConfig({ cwd: ctx.cwd, env: await ctx.resolveConfigEnv() });
  if (normalized.section === "transcript") {
    await ctx.maintainSessionRetention(refreshed, { force: true });
  }
  const sessionView = isConfigV2Enabled(refreshed) && sessionId
    ? await refreshDashboardSessionAfterV2Mutation({
        active: ctx.active,
        cwd: ctx.cwd,
        env: ctx.runtimeEnv,
        sessionId,
        config: refreshed
      })
    : null;
  let sessionConfig: LabAgentConfig;
  let syncedState = null;
  if (isConfigV2Enabled(refreshed)) {
    sessionConfig = sessionView?.config ?? configForDashboardSelection(refreshed, dashboardRuntimeSelection(
      ctx.clientModelSelections,
      input.clientId,
      { providerId: ctx.selectedProviderId, modelId: ctx.selectedModelId, reasoningEffort: ctx.selectedReasoningEffort }
    ));
  } else {
    const currentModel = String(state?.session?.model || ctx.selectedModelId || refreshed.modelAlias || "").trim();
    const sessionDefinesEffort = state != null
      && Object.prototype.hasOwnProperty.call(state.session.config, "reasoningEffort")
      && state.session.config.reasoningEffort !== undefined;
    const currentEffort = sessionDefinesEffort
      ? state.session.config.reasoningEffort
      : ctx.selectedReasoningEffort;
    sessionConfig = configWithModelSelection(refreshed, currentModel, currentEffort, {
      explicitReasoningEffort: sessionDefinesEffort || Boolean(ctx.selectedModelId)
    });
    syncedState = syncIdleSessionConfig(ctx.active, sessionId, sessionConfig);
  }
  const activeState = sessionView?.state ?? syncedState ?? activeStateForSession(ctx.active, sessionId);
  return {
    ok: true,
    configPath,
    configRevision: mutation.revision,
    saveTarget: normalized.saveTarget,
    sessionId: sessionId || undefined,
    sessionStatus: sessionView?.sessionStatus
      ?? (activeState ? sessionStatusSummary(activeState.session) : sessionStatusFromConfig(sessionConfig)),
    settings: publicDashboardSettings(sessionConfig, ctx.runtimeEnv)
  };
}
