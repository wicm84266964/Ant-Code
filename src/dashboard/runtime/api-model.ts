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

export async function runtimeSwitchModel(ctx: DashboardFactoryState, input: DashboardRequestInput = {}) {
  const locked = ctx.rerunWithSessionConfigLock(input, (lockedInput) => ctx.runtime.switchModel(lockedInput));
  if (locked) return locked;
  const configEnv = await ctx.resolveConfigEnv();
  let config = await loadConfig({ cwd: ctx.cwd, env: configEnv });
  const modelId = String(input.modelId ?? input.model ?? "").trim();
  const sessionId = String(input.sessionId ?? "").trim();
  const state = sessionId ? ctx.active.get(sessionId) : null;
  if (state?.running) {
    return {
      ok: false,
      status: 409,
      error: "任务运行中，结束或中断后再切换模型",
      models: modelOptions(state.session.config),
      agentModelTiers: publicAgentModelTiers(state.session.config),
      visionAgent: publicVisionAgent(state.session.config),
      gatewayConfig: publicGatewayConfig(state.session.config),
      gatewayProfiles: publicGatewayProfiles(state.session.config)
    };
  }
  const archived = sessionId && !state
    ? await readDashboardSessionMetadataExact({
        cwd: ctx.cwd,
        env: ctx.runtimeEnv,
        config,
        sessionId
      })
    : null;
  if (archived && !archived.ok) {
    return archived;
  }
  const archivedResolution = archived?.ok && isConfigV2Enabled(config)
    ? resolveSessionModelSelection(config, archived.metadata)
    : null;
  const clientSelection = dashboardRuntimeSelection(
    ctx.clientModelSelections,
    input.clientId,
    { providerId: ctx.selectedProviderId, modelId: ctx.selectedModelId, reasoningEffort: ctx.selectedReasoningEffort }
  );
  if (isConfigV2Enabled(config)) {
    const currentSelection = state
      ? {
          providerId: activeGatewayProfileId(state.session.config),
          modelId: state.session.model,
          reasoningEffort: state.session.config?.reasoningEffort
        }
      : archivedResolution?.status === "resolved" && archivedResolution.selection
        ? {
            providerId: archivedResolution.selection.provider,
            modelId: archivedResolution.selection.model,
            reasoningEffort: archivedResolution.selection.reasoningEffort ?? null
          }
        : clientSelection;
    config = configForDashboardSelection(config, currentSelection);
  }
  const requestedProfileId = String(
    input.providerId ?? input.profileId ?? input.gatewayProfileId ?? ""
  ).trim();
  if (sessionId && archivedResolution?.status === "unresolved" && !requestedProfileId) {
    return unresolvedSessionModelSelectionResult(archivedResolution, sessionId);
  }
  const profileId = String(
    requestedProfileId
      || (isConfigV2Enabled(config)
        ? activeGatewayProfileId(config) || clientSelection.providerId
        : "")
  ).trim();
  if (profileId && profileId !== activeGatewayProfileId(config)) {
    const profile = gatewayProfilesFromConfig(config).find((item) => item.id === profileId);
    if (!profile) {
      return {
        ok: false,
        status: 404,
        error: "网关配置不存在",
        models: modelOptions(config),
        agentModelTiers: publicAgentModelTiers(config),
        visionAgent: publicVisionAgent(config),
        gatewayConfig: publicGatewayConfig(config),
        gatewayProfiles: publicGatewayProfiles(config)
      };
    }
    if (!parseConfigUrl(profile.gatewayUrl) || !(GATEWAY_PROTOCOLS as readonly string[]).includes(profile.gatewayProtocol)) {
      return {
        ok: false,
        status: 400,
        error: "该网关的 API 地址或协议不完整，请先在设置中修正",
        models: modelOptions(config),
        agentModelTiers: publicAgentModelTiers(config),
        visionAgent: publicVisionAgent(config),
        gatewayConfig: publicGatewayConfig(config),
        gatewayProfiles: publicGatewayProfiles(config)
      };
    }
    if (!Array.isArray(profile.models) || profile.models.length === 0) {
      return {
        ok: false,
        status: 400,
        error: "该网关没有已配置模型，请先在设置中添加模型",
        models: modelOptions(config),
        agentModelTiers: publicAgentModelTiers(config),
        visionAgent: publicVisionAgent(config),
        gatewayConfig: publicGatewayConfig(config),
        gatewayProfiles: publicGatewayProfiles(config)
      };
    }
    if (modelId && !(Array.isArray(profile.models) ? profile.models : []).some((model: { id?: string }) => model.id === modelId)) {
      return {
        ok: false,
        status: 400,
        error: `模型 ${modelId} 不属于所选来源`,
        models: modelOptions(config),
        agentModelTiers: publicAgentModelTiers(config),
        visionAgent: publicVisionAgent(config),
        gatewayConfig: publicGatewayConfig(config),
        gatewayProfiles: publicGatewayProfiles(config)
      };
    }
    if (isConfigV2Enabled(config)) {
      config = configForGatewayProfileSelection(config, profileId);
    } else {
      const localPath = localProjectConfigPath(ctx.cwd);
      let nextLocal = buildGatewayProfileSwitchConfig(await readJsonConfig(localPath), config, profileId);
      const mutation = await mutateDashboardConfig(localPath, async (local) => {
        const latestConfig = await loadConfig({ cwd: ctx.cwd, env: await ctx.resolveConfigEnv() });
        nextLocal = buildGatewayProfileSwitchConfig(local, latestConfig, profileId);
        if (!nextLocal.ok) {
          throw dashboardConfigResultError(nextLocal);
        }
        return nextLocal.config;
      });
      if (!mutation.ok) {
        return mutation;
      }
      config = await loadConfig({ cwd: ctx.cwd, env: await ctx.resolveConfigEnv() });
    }
  }
  const selection = resolveModelSelection(config, modelId);
  if (!selection.ok) {
    return {
      ok: false,
      status: 400,
      error: selection.error.message,
      models: modelOptions(config),
      agentModelTiers: publicAgentModelTiers(config),
      visionAgent: publicVisionAgent(config),
      gatewayConfig: publicGatewayConfig(config),
      gatewayProfiles: publicGatewayProfiles(config)
    };
  }
  const selectedModel = selection.model;
  let refreshed = config;
  if (
    !isConfigV2Enabled(config)
    && input.applyAgentDefaults === true
    && Object.keys(selectedModel.agentModelTiers ?? {}).length > 0
  ) {
    const localPath = localProjectConfigPath(ctx.cwd);
    const mutation = await mutateDashboardConfig(localPath, (local) => (
      buildLocalAgentModelTiersConfig(local, config, selectedModel.agentModelTiers)
    ));
    if (!mutation.ok) {
      return mutation;
    }
    refreshed = await loadConfig({ cwd: ctx.cwd, env: await ctx.resolveConfigEnv() });
  }
  const nextModelId = selectedModel.id;
  const nextReasoningEffort = resolveReasoningEffortSelection(
    selectedModel,
    input.reasoningEffort,
    selectedModel.defaultReasoningEffort
  );
  const nextProviderId = profileId || activeGatewayProfileId(refreshed);
  const modelConfig = configWithModelSelection(refreshed, nextModelId, nextReasoningEffort, {
    explicitReasoningEffort: true
  });
  if (sessionId) {
    const persisted = await persistDashboardSessionModelConfig({
      active: ctx.active,
      sessionMutationLocks: ctx.sessionMutationLocks,
      cwd: ctx.cwd,
      env: ctx.runtimeEnv,
      sessionId,
      config: modelConfig,
      lockHeld: Reflect.get(input, ctx.sessionConfigMutationLock) === sessionId
    });
    if (!persisted.ok) {
      return {
        ...persisted,
        models: modelOptions(modelConfig),
        agentModelTiers: publicAgentModelTiers(modelConfig),
        visionAgent: publicVisionAgent(modelConfig),
        gatewayConfig: publicGatewayConfig(modelConfig),
        gatewayProfiles: publicGatewayProfiles(modelConfig)
      };
    }
    if (persisted.state) appendDashboardEvent(persisted.state, {
      type: "model_switched",
      id: eventId("model"),
      model: selectedModel.id,
      modelInfo: publicModelOption(selectedModel, selectedModel.id),
      sessionStatus: persisted.sessionStatus,
      at: new Date().toISOString()
    });
    return {
      ok: true,
      sessionId,
      sessionStatus: persisted.sessionStatus,
      models: modelOptions(modelConfig),
      agentModelTiers: publicAgentModelTiers(modelConfig),
      visionAgent: publicVisionAgent(modelConfig),
      gatewayConfig: publicGatewayConfig(modelConfig),
      gatewayProfiles: publicGatewayProfiles(modelConfig)
    };
  }
  ctx.selectedModelId = nextModelId;
  ctx.selectedReasoningEffort = nextReasoningEffort;
  ctx.selectedProviderId = nextProviderId;
  rememberDashboardRuntimeSelection(ctx.clientModelSelections, input.clientId, {
    providerId: nextProviderId,
    modelId: nextModelId,
    reasoningEffort: nextReasoningEffort
  });
  return {
    ok: true,
    sessionStatus: sessionStatusFromConfig(modelConfig),
    models: modelOptions(modelConfig),
    agentModelTiers: publicAgentModelTiers(modelConfig),
    visionAgent: publicVisionAgent(modelConfig),
    gatewayConfig: publicGatewayConfig(modelConfig),
    gatewayProfiles: publicGatewayProfiles(modelConfig)
  };
}

export async function runtimeSwitchReasoningEffort(ctx: DashboardFactoryState, input: DashboardRequestInput = {}) {
  const locked = ctx.rerunWithSessionConfigLock(input, (lockedInput) => ctx.runtime.switchReasoningEffort(lockedInput));
  if (locked) return locked;
  const configEnv = await ctx.resolveConfigEnv();
  let config = await loadConfig({ cwd: ctx.cwd, env: configEnv });
  const sessionId = String(input.sessionId ?? "").trim();
  const state = sessionId ? ctx.active.get(sessionId) : null;
  if (state?.running) {
    return { ok: false, status: 409, error: "任务运行中，结束或中断后再调整思考强度" };
  }
  const archived = sessionId && !state
    ? await readDashboardSessionMetadataExact({
        cwd: ctx.cwd,
        env: ctx.runtimeEnv,
        config,
        sessionId
      })
    : null;
  if (archived && !archived.ok) {
    return archived;
  }
  const clientSelection = dashboardRuntimeSelection(
    ctx.clientModelSelections,
    input.clientId,
    { providerId: ctx.selectedProviderId, modelId: ctx.selectedModelId, reasoningEffort: ctx.selectedReasoningEffort }
  );
  let atomicSelection = null;
  if (isConfigV2Enabled(config)) {
    if (state) {
      atomicSelection = currentRuntimeModelSelection(state.session.config, {
        model: state.session.model,
        reasoningEffort: state.session.config?.reasoningEffort
      });
    } else if (archived?.ok) {
      const resolution = resolveSessionModelSelection(config, archived.metadata);
      if (resolution.status !== "resolved") {
        return unresolvedSessionModelSelectionResult(resolution, sessionId);
      }
      atomicSelection = resolution.selection;
    } else {
      const requestedSelection = {
        providerId: input.providerId ?? input.profileId ?? clientSelection.providerId,
        modelId: input.modelId ?? input.model ?? clientSelection.modelId,
        reasoningEffort: clientSelection.reasoningEffort
      };
      const selectedConfig = configForDashboardSelection(config, requestedSelection);
      atomicSelection = currentRuntimeModelSelection(selectedConfig, {
        model: selectedConfig.modelAlias,
        reasoningEffort: selectedConfig.reasoningEffort
      });
    }
    if (!atomicSelection) {
      return unresolvedSessionModelSelectionResult({
        status: "unresolved",
        reason: "invalid-runtime-selection",
        model: state?.session?.model ?? archived?.metadata?.model ?? input.modelId ?? ""
      }, sessionId);
    }
    const requestedProviderId = String(input.providerId ?? input.profileId ?? "").trim();
    const requestedModelId = String(input.modelId ?? input.model ?? "").trim();
    if (
      (requestedProviderId && requestedProviderId !== atomicSelection.provider)
      || (requestedModelId && requestedModelId !== atomicSelection.model)
    ) {
      return {
        ok: false,
        status: 409,
        code: "SESSION_MODEL_SELECTION_CHANGED",
        error: "模型选择已经变化，请刷新后重试",
        sessionId
      };
    }
    config = configForDashboardSelection(config, {
      providerId: atomicSelection.provider,
      modelId: atomicSelection.model,
      reasoningEffort: atomicSelection.reasoningEffort ?? null
    });
  } else {
    config = state?.session?.config ?? configForDashboardSelection(config, clientSelection);
  }
  const modelId = String(atomicSelection?.model || state?.session?.model || clientSelection.modelId || config.modelAlias || "").trim();
  const selection = resolveModelSelection(config, modelId);
  if (!selection.ok) {
    return { ok: false, status: 400, error: selection.error.message };
  }
  const selectedModel = selection.model;
  const requested = String(input.reasoningEffort ?? input.effort ?? "").trim().toLowerCase();
  const clearOverride = !requested || requested === "default";
  const effort = clearOverride ? "" : resolveReasoningEffortSelection(selectedModel, requested, "");
  if (!clearOverride && effort !== requested) {
    return { ok: false, status: 400, error: `模型 ${selectedModel.id} 不支持思考强度 ${requested || "（空）"}` };
  }
  const activeConfig = configWithModelSelection(config, modelId, effort, { explicitReasoningEffort: true });
  if (sessionId) {
    const persisted = await persistDashboardSessionModelConfig({
      active: ctx.active,
      sessionMutationLocks: ctx.sessionMutationLocks,
      cwd: ctx.cwd,
      env: ctx.runtimeEnv,
      sessionId,
      config: activeConfig,
      expectedSelection: atomicSelection,
      lockHeld: Reflect.get(input, ctx.sessionConfigMutationLock) === sessionId
    });
    if (!persisted.ok) return persisted;
    if (persisted.state) appendDashboardEvent(persisted.state, {
      type: "reasoning_effort_switched",
      id: eventId("reasoning-effort"),
      reasoningEffort: effort || null,
      sessionStatus: persisted.sessionStatus,
      at: new Date().toISOString()
    });
    return {
      ok: true,
      sessionId,
      sessionStatus: persisted.sessionStatus,
      models: modelOptions(activeConfig),
      gatewayConfig: publicGatewayConfig(activeConfig),
      gatewayProfiles: publicGatewayProfiles(activeConfig)
    };
  }
  ctx.selectedReasoningEffort = effort;
  ctx.selectedModelId = selectedModel.id;
  ctx.selectedProviderId = activeGatewayProfileId(config);
  rememberDashboardRuntimeSelection(ctx.clientModelSelections, input.clientId, {
    providerId: ctx.selectedProviderId,
    modelId: ctx.selectedModelId,
    reasoningEffort: effort || null
  });
  return {
    ok: true,
    sessionStatus: sessionStatusFromConfig(activeConfig),
    models: modelOptions(activeConfig),
    gatewayConfig: publicGatewayConfig(activeConfig),
    gatewayProfiles: publicGatewayProfiles(activeConfig)
  };
}
