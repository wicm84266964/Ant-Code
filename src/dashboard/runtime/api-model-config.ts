import type { DashboardFactoryState } from "./factory-state.ts";
import type { DashboardRequestInput, DashboardEventListener, GatewayDiscoveryCatalog } from "./types.ts";
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

export async function runtimeSaveModelConfig(ctx: DashboardFactoryState, input: DashboardRequestInput = {}) {
  const locked = ctx.rerunWithSessionConfigLock(input, (lockedInput) => ctx.runtime.saveModelConfig(lockedInput));
  if (locked) return locked;
  const configEnv = await ctx.resolveConfigEnv();
  let config = await loadConfig({ cwd: ctx.cwd, env: configEnv });
  const discovery = resolveGatewayDiscovery({
    discoveries: ctx.gatewayDiscoveries,
    secret: ctx.gatewayDiscoverySecret,
    now: ctx.gatewayDiscoveryNow(),
    input,
    config
  });
  if (!discovery.ok) return discovery;
  let committedDiscovery = discovery;
  let normalized = normalizeModelConfigInput(input, config, discovery.catalog);
  if (!normalized.ok) {
    return normalized;
  }
  if (isConfigV2Enabled(config)) {
    const sessionId = String(input.sessionId ?? "").trim();
    const state = sessionId ? ctx.active.get(sessionId) : null;
    if (state?.running) {
      return {
        ok: false,
        status: 409,
        error: "任务运行中，结束或中断后再修改模型设置",
        models: modelOptions(state.session.config),
        gatewayConfig: publicGatewayConfig(state.session.config),
        gatewayProfiles: publicGatewayProfiles(state.session.config)
      };
    }
    let saved: { providerId?: unknown; modelId?: unknown; [key: string]: unknown };
    try {
      saved = await saveV2ProviderModel({
        cwd: ctx.cwd,
        env: configEnv,
        scope: input.scope ?? input.saveTarget,
        expectedRevision: input.expectedRevision,
        expectedCredentialsRevision: input.expectedCredentialsRevision ?? input.credentialsRevision,
        prepareInput: async () => {
          const lockedConfig = await loadConfig({ cwd: ctx.cwd, env: await ctx.resolveConfigEnv() });
          const lockedDiscovery = resolveGatewayDiscovery({
            discoveries: ctx.gatewayDiscoveries,
            secret: ctx.gatewayDiscoverySecret,
            now: ctx.gatewayDiscoveryNow(),
            input,
            config: lockedConfig
          });
          if (!lockedDiscovery.ok) throw dashboardConfigResultError(lockedDiscovery);
          const lockedNormalized = normalizeModelConfigInput(input, lockedConfig, lockedDiscovery.catalog);
          if (!lockedNormalized.ok) throw dashboardConfigResultError(lockedNormalized);
          config = lockedConfig;
          committedDiscovery = lockedDiscovery;
          normalized = lockedNormalized;
          return {
            ...lockedNormalized,
            profileId: String(input.providerId ?? input.profileId ?? input.gatewayProfileId ?? "").trim()
          };
        },
        input: {
          ...normalized,
          profileId: String(input.providerId ?? input.profileId ?? input.gatewayProfileId ?? "").trim()
        }
      });
    } catch (error) {
      return dashboardV2ErrorResult(error);
    }
    const refreshed = await loadConfig({ cwd: ctx.cwd, env: await ctx.resolveConfigEnv() });
    const sessionView = sessionId
      ? await refreshDashboardSessionAfterV2Mutation({
          active: ctx.active,
          cwd: ctx.cwd,
          env: ctx.runtimeEnv,
          sessionId,
          config: refreshed
        })
      : null;
    const previousClientSelection = dashboardRuntimeSelection(
      ctx.clientModelSelections,
      input.clientId,
      { providerId: ctx.selectedProviderId, modelId: ctx.selectedModelId, reasoningEffort: ctx.selectedReasoningEffort }
    );
    let modelConfig = sessionView?.config ?? configForDashboardSelection(refreshed, previousClientSelection);
    if (normalized.switchToModel && !sessionId) {
      ctx.selectedProviderId = String(saved.providerId ?? "");
      ctx.selectedModelId = String(saved.modelId ?? "");
      ctx.selectedReasoningEffort = resolveReasoningEffortSelection(
        normalized.model,
        normalized.model.defaultReasoningEffort,
        ""
      );
      rememberDashboardRuntimeSelection(ctx.clientModelSelections, input.clientId, {
        providerId: ctx.selectedProviderId,
        modelId: ctx.selectedModelId,
        reasoningEffort: ctx.selectedReasoningEffort
      });
      modelConfig = configForDashboardSelection(refreshed, {
        providerId: ctx.selectedProviderId,
        modelId: ctx.selectedModelId,
        reasoningEffort: ctx.selectedReasoningEffort
      });
    }
    const activeState = sessionView?.state ?? activeStateForSession(ctx.active, sessionId);
    const activeConfig = activeState?.session.config ?? modelConfig;
    const configV2 = publicV2ConfigState(refreshed);
    consumeGatewayDiscovery(ctx.gatewayDiscoveries, committedDiscovery);
    return {
      ...saved,
      sessionId: sessionId || undefined,
      sessionStatus: sessionView?.sessionStatus
        ?? (activeState ? sessionStatusSummary(activeState.session) : sessionStatusFromConfig(modelConfig)),
      models: modelOptions(activeConfig),
      agentModelTiers: publicAgentModelTiers(activeConfig),
      visionAgent: publicVisionAgent(activeConfig),
      gatewayConfig: publicGatewayConfig(activeConfig),
      gatewayProfiles: publicGatewayProfiles(activeConfig),
      configV2,
      configRevisions: configV2.revisions
    };
  }
  const configPath = modelConfigTargetPath(ctx.cwd, configEnv, normalized.saveTarget);
  if (normalized.saveTarget === "global") {
    const inheritedBeforeSave = await readJsonConfig(configPath);
    const seenProjectPaths = new Set();
    let cleanedProjectConfig = false;
    for (const configuredPath of Array.isArray(config.projectConfigPaths) ? config.projectConfigPaths : []) {
      const configuredProjectPath = String(configuredPath ?? "").trim();
      if (!configuredProjectPath) {
        continue;
      }
      const projectPath = path.resolve(configuredProjectPath);
      const projectPathKey = projectPath.toLowerCase();
      if (projectPathKey === path.resolve(configPath).toLowerCase() || seenProjectPaths.has(projectPathKey)) {
        continue;
      }
      seenProjectPaths.add(projectPathKey);
      const projectBeforeSave = await readJsonConfig(projectPath);
      if (removeRedundantInheritedGatewayShadows(projectBeforeSave, inheritedBeforeSave) !== projectBeforeSave) {
        const cleanup = await mutateDashboardConfig(
          projectPath,
          (local: Record<string, unknown>) => removeRedundantInheritedGatewayShadows(local, inheritedBeforeSave)
        );
        if (!cleanup.ok) {
          return cleanup;
        }
        cleanedProjectConfig = true;
      }
    }
    if (cleanedProjectConfig) {
      config = await loadConfig({ cwd: ctx.cwd, env: await ctx.resolveConfigEnv() });
      const currentDiscovery = validateGatewayDiscoveryEntry({
        entry: discovery.entry,
        secret: ctx.gatewayDiscoverySecret,
        now: ctx.gatewayDiscoveryNow(),
        input,
        config
      });
      if (!currentDiscovery.ok) {
        return currentDiscovery;
      }
      normalized = normalizeModelConfigInput(input, config, discovery.catalog);
      if (!normalized.ok) {
        return normalized;
      }
    }
  }
  const mutation = await mutateDashboardConfig(configPath, async (targetConfig: unknown) => {
    config = await loadConfig({ cwd: ctx.cwd, env: await ctx.resolveConfigEnv() });
    const currentDiscovery = validateGatewayDiscoveryEntry({
      entry: discovery.entry,
      secret: ctx.gatewayDiscoverySecret,
      now: ctx.gatewayDiscoveryNow(),
      input,
      config
    });
    if (!currentDiscovery.ok) {
      throw dashboardConfigResultError(currentDiscovery);
    }
    normalized = normalizeModelConfigInput(input, config, discovery.catalog);
    if (!normalized.ok) {
      throw dashboardConfigResultError(normalized);
    }
    const credentialMigration = validateGatewayCredentialMigration(
      isPlainObject(targetConfig) ? targetConfig : {},
      config,
      normalized
    );
    if (!credentialMigration.ok) {
      throw dashboardConfigResultError(credentialMigration);
    }
    return buildLocalModelConfig(
      isPlainObject(targetConfig) ? targetConfig as LabAgentConfig : config,
      config,
      normalized
    );
  });
  if (!mutation.ok) {
    return mutation;
  }

  const refreshed = await loadConfig({ cwd: ctx.cwd, env: await ctx.resolveConfigEnv() });
  if (normalized.switchToModel) {
    ctx.selectedModelId = normalized.model.id;
    ctx.selectedReasoningEffort = resolveReasoningEffortSelection(
      normalized.model,
      normalized.model.defaultReasoningEffort,
      ""
    );
  } else if (shouldReplaceModelEntries(config, normalized) && !listConfiguredModels(refreshed).some((model) => model.id === ctx.selectedModelId)) {
    ctx.selectedModelId = String(refreshed.modelAlias ?? "").trim();
  }
  const modelConfig = configWithModelSelection(refreshed, ctx.selectedModelId, ctx.selectedReasoningEffort, {
    explicitReasoningEffort: true
  });
  const syncedState = syncIdleSessionConfig(ctx.active, String(input.sessionId ?? ""), modelConfig);
  const state = syncedState ?? activeStateForSession(ctx.active, String(input.sessionId ?? ""));
  const activeConfig = syncedState?.session.config ?? (state?.session.config ? configForStatusLists(state.session.config, modelConfig) : modelConfig);
  consumeGatewayDiscovery(ctx.gatewayDiscoveries, discovery);
  return {
    ok: true,
    configPath,
    configRevision: mutation.revision,
    saveTarget: normalized.saveTarget,
    sessionId: syncedState?.session.id,
    sessionStatus: state ? sessionStatusForConfigUpdate(state.session, modelConfig) : sessionStatusFromConfig(modelConfig),
    models: modelOptions(activeConfig),
    agentModelTiers: publicAgentModelTiers(activeConfig),
    visionAgent: publicVisionAgent(activeConfig),
    gatewayConfig: publicGatewayConfig(activeConfig),
    gatewayProfiles: publicGatewayProfiles(activeConfig)
  };
}

export async function runtimeProbeGateway(ctx: DashboardFactoryState, input: DashboardRequestInput = {}) {
  const configEnv = await ctx.resolveConfigEnv();
  const config = await loadConfig({ cwd: ctx.cwd, env: configEnv });
  const result = await probeGatewayConnection(input, config);
  if (!result.ok) return result;
  const discovery = rememberGatewayDiscovery({
    discoveries: ctx.gatewayDiscoveries,
    secret: ctx.gatewayDiscoverySecret,
    ttlMs: ctx.gatewayDiscoveryTtlMs,
    now: ctx.gatewayDiscoveryNow(),
    input,
    config,
    models: result.models
  });
  if (!discovery.ok) return discovery;
  return {
    ...result,
    models: clonePlainObject(discovery.catalog.models),
    discoveryToken: discovery.token,
    discoveryExpiresAt: new Date(discovery.expiresAt).toISOString()
  };
}

export async function runtimeProbeModelCapabilities(ctx: DashboardFactoryState, input: DashboardRequestInput = {}, request: { signal?: AbortSignal } = {}) {
  const configEnv = await ctx.resolveConfigEnv();
  const config = await loadConfig({ cwd: ctx.cwd, env: configEnv });
  /** @type {GatewayDiscoveryCatalog} */
  let catalog: GatewayDiscoveryCatalog = { ids: [], models: [] };
  if (String(input.gatewayDiscoveryToken ?? input.discoveryToken ?? "").trim()) {
    const existing = resolveGatewayDiscovery({
      discoveries: ctx.gatewayDiscoveries,
      secret: ctx.gatewayDiscoverySecret,
      now: ctx.gatewayDiscoveryNow(),
      input,
      config
    });
    if (!existing.ok) return existing;
    catalog = existing.catalog;
  }
  const result = await probeModelReasoningCapabilities(input, config, request.signal);
  if (!result.ok || result.outcome !== "complete") return result;

  const mergedModels = mergeReasoningProbeIntoCatalog(catalog.models, result);
  const discovery = rememberGatewayDiscovery({
    discoveries: ctx.gatewayDiscoveries,
    secret: ctx.gatewayDiscoverySecret,
    ttlMs: ctx.gatewayDiscoveryTtlMs,
    now: ctx.gatewayDiscoveryNow(),
    input,
    config,
    models: mergedModels
  });
  if (!discovery.ok) return discovery;
  const mergedModel = discovery.catalog.models.find((model: { id?: string; reasoningEfforts?: unknown; defaultReasoningEffort?: unknown }) => (
    String(model?.id ?? "").trim().toLowerCase() === String(result.modelId ?? "").trim().toLowerCase()
  ));
  return {
    ...result,
    reasoningEfforts: clonePlainObject(mergedModel?.reasoningEfforts ?? result.reasoningEfforts),
    defaultReasoningEffort: mergedModel?.defaultReasoningEffort ?? null,
    discoveryToken: discovery.token,
    discoveryExpiresAt: new Date(discovery.expiresAt).toISOString()
  };
}

export async function runtimeDeleteModelConfig(ctx: DashboardFactoryState, input: DashboardRequestInput = {}) {
  const locked = ctx.rerunWithSessionConfigLock(input, (lockedInput) => ctx.runtime.deleteModelConfig(lockedInput));
  if (locked) return locked;
  const configEnv = await ctx.resolveConfigEnv();
  const config = await loadConfig({ cwd: ctx.cwd, env: configEnv });
  const modelId = String(input.modelId ?? input.model ?? "").trim();
  if (!modelId) {
    return {
      ok: false,
      status: 400,
      error: "请选择要删除的模型",
      models: modelOptions(config),
      agentModelTiers: publicAgentModelTiers(config),
      visionAgent: publicVisionAgent(config),
      gatewayConfig: publicGatewayConfig(config),
      gatewayProfiles: publicGatewayProfiles(config)
    };
  }
  if (isConfigV2Enabled(config)) {
    const sessionId = String(input.sessionId ?? "").trim();
    const state = sessionId ? ctx.active.get(sessionId) : null;
    if (state?.running) {
      return {
        ok: false,
        status: 409,
        error: "任务运行中，结束或中断后再删除模型",
        models: modelOptions(state.session.config),
        gatewayConfig: publicGatewayConfig(state.session.config),
        gatewayProfiles: publicGatewayProfiles(state.session.config)
      };
    }
    let deleted;
    try {
      deleted = await deleteV2ProviderModel({
        cwd: ctx.cwd,
        env: configEnv,
        scope: input.scope ?? input.saveTarget,
        expectedRevision: input.expectedRevision,
        expectedCredentialsRevision: input.expectedCredentialsRevision ?? input.credentialsRevision,
        providerId: input.providerId ?? input.profileId ?? input.gatewayProfileId,
        modelId
      });
    } catch (error) {
      return dashboardV2ErrorResult(error);
    }
    const refreshed = await loadConfig({ cwd: ctx.cwd, env: await ctx.resolveConfigEnv() });
    const activeViews = reconcileActiveDashboardSessionsAfterV2Mutation(ctx.active, refreshed);
    const sessionView = sessionId
      ? activeViews.get(sessionId) ?? await refreshDashboardSessionAfterV2Mutation({
          active: ctx.active,
          cwd: ctx.cwd,
          env: ctx.runtimeEnv,
          sessionId,
          config: refreshed
        })
      : null;
    const reconciledSelection = reconcileDashboardRuntimeSelections(
      ctx.clientModelSelections,
      refreshed,
      { providerId: ctx.selectedProviderId, modelId: ctx.selectedModelId, reasoningEffort: ctx.selectedReasoningEffort }
    );
    ctx.selectedProviderId = String(reconciledSelection.providerId ?? "");
    ctx.selectedModelId = String(reconciledSelection.modelId ?? "");
    ctx.selectedReasoningEffort = String(reconciledSelection.reasoningEffort ?? "");
    let modelConfig;
    if (sessionId) {
      modelConfig = sessionView?.config ?? refreshed;
    } else {
      const previousSelection = dashboardRuntimeSelection(
        ctx.clientModelSelections,
        input.clientId,
        { providerId: ctx.selectedProviderId, modelId: ctx.selectedModelId, reasoningEffort: ctx.selectedReasoningEffort }
      );
      modelConfig = configForDashboardSelection(refreshed, previousSelection);
      ctx.selectedProviderId = activeGatewayProfileId(modelConfig);
      ctx.selectedModelId = String(modelConfig.modelAlias ?? "").trim();
      ctx.selectedReasoningEffort = String(modelConfig.reasoningEffort ?? "").trim();
      rememberDashboardRuntimeSelection(ctx.clientModelSelections, input.clientId, {
        providerId: ctx.selectedProviderId,
        modelId: ctx.selectedModelId,
        reasoningEffort: ctx.selectedReasoningEffort
      });
    }
    if (sessionView?.state) {
      appendDashboardEvent(sessionView.state, {
        type: "model_deleted",
        id: eventId("model-delete"),
        model: modelId,
        sessionStatus: sessionView.sessionStatus,
        at: new Date().toISOString()
      });
    }
    const activeConfig = modelConfig;
    const configV2 = publicV2ConfigState(refreshed);
    return {
      ...deleted,
      deletedFrom: deleted.scope,
      sessionId: sessionId || undefined,
      sessionStatus: sessionView?.sessionStatus ?? sessionStatusFromConfig(modelConfig),
      models: modelOptions(activeConfig),
      agentModelTiers: publicAgentModelTiers(activeConfig),
      visionAgent: publicVisionAgent(activeConfig),
      gatewayConfig: publicGatewayConfig(activeConfig),
      gatewayProfiles: publicGatewayProfiles(activeConfig),
      configV2,
      configRevisions: configV2.revisions
    };
  }
  const profileId = String(input.profileId ?? input.gatewayProfileId ?? activeGatewayProfileId(config)).trim();
  const profile = gatewayProfilesFromConfig(config).find((item) => item.id === profileId);
  if (!profile || !profile.models.some((model: { id?: string }) => model.id === modelId)) {
    return {
      ok: false,
      status: 404,
      error: "模型配置不存在",
      models: modelOptions(config),
      agentModelTiers: publicAgentModelTiers(config),
      visionAgent: publicVisionAgent(config),
      gatewayConfig: publicGatewayConfig(config),
      gatewayProfiles: publicGatewayProfiles(config)
    };
  }
  const ownerScope = String(gatewayProfileModelSource(config, profile, modelId)?.ownerScope ?? "").trim();
  if (!["project", "global"].includes(ownerScope)) {
    return {
      ok: false,
      status: 409,
      error: "该模型由环境或内置配置提供，无法从 Dashboard 删除",
      models: modelOptions(config),
      agentModelTiers: publicAgentModelTiers(config),
      visionAgent: publicVisionAgent(config),
      gatewayConfig: publicGatewayConfig(config),
      gatewayProfiles: publicGatewayProfiles(config)
    };
  }
  const requestedScope = String(input.saveTarget ?? input.scope ?? "").trim().toLowerCase();
  if (["project", "global"].includes(requestedScope) && requestedScope !== ownerScope) {
    return { ok: false, status: 400, error: "模型删除范围与网关档案来源不一致" };
  }
  const sessionId = String(input.sessionId ?? "").trim();
  const state = sessionId ? ctx.active.get(sessionId) : null;
  if (state?.running) {
    return {
      ok: false,
      status: 409,
      error: "任务运行中，结束或中断后再删除模型",
      models: modelOptions(state.session.config),
      agentModelTiers: publicAgentModelTiers(state.session.config),
      visionAgent: publicVisionAgent(state.session.config),
      gatewayConfig: publicGatewayConfig(state.session.config),
      gatewayProfiles: publicGatewayProfiles(state.session.config)
    };
  }
  const localPath = localProjectConfigPath(ctx.cwd);
  const globalPath = globalConfigPath(configEnv);
  const targetPath = ownerScope === "global" ? globalPath : localPath;
  const global = await readJsonConfig(globalPath);
  const inheritedProfile = ownerScope === "project"
    ? gatewayProfileForEndpoint(
        gatewayProfilesOwnedByConfig(global),
        profile.gatewayProtocol,
        profile.gatewayUrl
      )
    : null;
  const inheritedFallback = Boolean(inheritedProfile);
  let deletion = buildOwnedDeleteModelConfig(
    await readJsonConfig(targetPath),
    config,
    profileId,
    modelId,
    { inheritedFallback, inheritedProfileId: inheritedProfile?.id ? String(inheritedProfile.id) : undefined }
  );
  if (!deletion.ok) {
    return {
      ok: false,
      status: deletion.status ?? 400,
      error: deletion.error,
      models: modelOptions(config),
      agentModelTiers: publicAgentModelTiers(config),
      visionAgent: publicVisionAgent(config),
      gatewayConfig: publicGatewayConfig(config),
      gatewayProfiles: publicGatewayProfiles(config)
    };
  }
  const mutation = await mutateDashboardConfig(targetPath, async (stored: Record<string, unknown>) => {
    const latestConfig = await loadConfig({ cwd: ctx.cwd, env: await ctx.resolveConfigEnv() });
    deletion = buildOwnedDeleteModelConfig(stored, latestConfig, profileId, modelId, {
      inheritedFallback,
      inheritedProfileId: inheritedProfile?.id != null ? String(inheritedProfile.id) : undefined
    });
    if (!deletion.ok) {
      throw dashboardConfigResultError(deletion);
    }
    return deletion.config;
  });
  if (!mutation.ok) {
    return mutation;
  }
  if (ownerScope === "global" && deletion.removedProfile === true
    && path.resolve(localPath).toLowerCase() !== path.resolve(globalPath).toLowerCase()) {
    await mutateDashboardConfig(
      localPath,
      (local: Record<string, unknown>) => clearDanglingGatewayProfileSelection(local, String(deletion.ok ? deletion.ownerProfileId ?? profileId : profileId))
    );
  }
  const refreshed = await loadConfig({ cwd: ctx.cwd, env: await ctx.resolveConfigEnv() });
  const clearedGateway = deletion.clearedGateway === true && !activeGatewayProfileId(refreshed);
  if (ctx.selectedModelId === modelId || !listConfiguredModels(refreshed).some((model) => model.id === ctx.selectedModelId)) {
    ctx.selectedModelId = String(refreshed.modelAlias ?? "").trim();
    ctx.selectedReasoningEffort = defaultReasoningEffortForConfig(refreshed, ctx.selectedModelId);
  }
  if (state) {
    applySessionConfig(state.session, refreshed);
    state.persisted = false;
    appendDashboardEvent(state, {
      type: "model_deleted",
      id: eventId("model-delete"),
      model: modelId,
      sessionStatus: sessionStatusSummary(state.session),
      at: new Date().toISOString()
    });
  }
  const modelConfig = configWithModelSelection(refreshed, ctx.selectedModelId, ctx.selectedReasoningEffort, {
    explicitReasoningEffort: true
  });
  const activeConfig = state?.session.config ?? modelConfig;
  return {
    ok: true,
    deletedModel: modelId,
    deletedFrom: ownerScope,
    clearedGateway,
    restoredInherited: deletion.restoredInherited === true,
    configPath: targetPath,
    configRevision: mutation.revision,
    sessionId: state?.session.id,
    sessionStatus: state ? sessionStatusSummary(state.session) : sessionStatusFromConfig(modelConfig),
    models: modelOptions(activeConfig),
    agentModelTiers: publicAgentModelTiers(activeConfig),
    visionAgent: publicVisionAgent(activeConfig),
    gatewayConfig: publicGatewayConfig(activeConfig),
    gatewayProfiles: publicGatewayProfiles(activeConfig)
  };
}

export async function runtimeDeleteGatewayProfile(ctx: DashboardFactoryState, input: DashboardRequestInput = {}) {
  const locked = ctx.rerunWithSessionConfigLock(input, (lockedInput) => ctx.runtime.deleteGatewayProfile(lockedInput));
  if (locked) return locked;
  const configEnv = await ctx.resolveConfigEnv();
  const profileId = String(input.profileId ?? input.id ?? "").trim();
  if (!profileId) {
    return { ok: false, status: 400, error: "请选择要删除的网关" };
  }
  const sessionId = String(input.sessionId ?? "").trim();
  const state = sessionId ? ctx.active.get(sessionId) : null;
  if (state?.running) {
    return {
      ok: false,
      status: 409,
      error: "任务运行中，结束或中断后再删除网关",
      models: modelOptions(state.session.config),
      gatewayConfig: publicGatewayConfig(state.session.config),
      gatewayProfiles: publicGatewayProfiles(state.session.config)
    };
  }
  const config = await loadConfig({ cwd: ctx.cwd, env: configEnv });
  if (isConfigV2Enabled(config)) {
    let deleted;
    try {
      deleted = await deleteV2Provider({
        cwd: ctx.cwd,
        env: configEnv,
        scope: input.scope ?? input.saveTarget,
        expectedRevision: input.expectedRevision,
        expectedCredentialsRevision: input.expectedCredentialsRevision ?? input.credentialsRevision,
        providerId: input.providerId ?? profileId
      });
    } catch (error) {
      return dashboardV2ErrorResult(error);
    }
    const refreshed = await loadConfig({ cwd: ctx.cwd, env: await ctx.resolveConfigEnv() });
    const activeViews = reconcileActiveDashboardSessionsAfterV2Mutation(ctx.active, refreshed);
    const sessionView = sessionId
      ? activeViews.get(sessionId) ?? await refreshDashboardSessionAfterV2Mutation({
          active: ctx.active,
          cwd: ctx.cwd,
          env: ctx.runtimeEnv,
          sessionId,
          config: refreshed
        })
      : null;
    const reconciledSelection = reconcileDashboardRuntimeSelections(
      ctx.clientModelSelections,
      refreshed,
      { providerId: ctx.selectedProviderId, modelId: ctx.selectedModelId, reasoningEffort: ctx.selectedReasoningEffort }
    );
    ctx.selectedProviderId = String(reconciledSelection.providerId ?? "");
    ctx.selectedModelId = String(reconciledSelection.modelId ?? "");
    ctx.selectedReasoningEffort = String(reconciledSelection.reasoningEffort ?? "");
    let modelConfig;
    if (sessionId) {
      modelConfig = sessionView?.config ?? refreshed;
    } else {
      const previousSelection = dashboardRuntimeSelection(
        ctx.clientModelSelections,
        input.clientId,
        { providerId: ctx.selectedProviderId, modelId: ctx.selectedModelId, reasoningEffort: ctx.selectedReasoningEffort }
      );
      modelConfig = configForDashboardSelection(refreshed, previousSelection);
      ctx.selectedProviderId = activeGatewayProfileId(modelConfig);
      ctx.selectedModelId = String(modelConfig.modelAlias ?? "").trim();
      ctx.selectedReasoningEffort = String(modelConfig.reasoningEffort ?? "").trim();
      rememberDashboardRuntimeSelection(ctx.clientModelSelections, input.clientId, {
        providerId: ctx.selectedProviderId,
        modelId: ctx.selectedModelId,
        reasoningEffort: ctx.selectedReasoningEffort
      });
    }
    const activeConfig = modelConfig;
    const configV2 = publicV2ConfigState(refreshed);
    return {
      ...deleted,
      deletedProfile: profileId,
      deletedFrom: deleted.scope,
      deletedFromScopes: [deleted.scope],
      sessionId: sessionId || undefined,
      sessionStatus: sessionView?.sessionStatus ?? sessionStatusFromConfig(modelConfig),
      models: modelOptions(activeConfig),
      agentModelTiers: publicAgentModelTiers(activeConfig),
      visionAgent: publicVisionAgent(activeConfig),
      gatewayConfig: publicGatewayConfig(activeConfig),
      gatewayProfiles: publicGatewayProfiles(activeConfig),
      configV2,
      configRevisions: configV2.revisions
    };
  }
  const localPath = localProjectConfigPath(ctx.cwd);
  const globalPath = globalConfigPath(configEnv);
  const local = await readJsonConfig(localPath);
  const global = await readJsonConfig(globalPath);
  const ownerScope = String(gatewayProfileOwner(config, profileId)?.type ?? "").trim();
  const targets = gatewayProfileDeleteTargets({ local, localPath, global, globalPath, profileId, ownerScope });
  if (targets.length === 0) {
    return { ok: false, status: 409, error: "该网关由外部环境提供，无法从 Dashboard 删除" };
  }
  const wasActive = activeGatewayProfileId(config) === profileId;
  const effectiveProfile = gatewayProfilesFromConfig(config).find((profile) => profile.id === profileId);
  const mutations: Array<{ scope?: string; path?: string; revision?: unknown; config?: unknown }> = [];
  for (const target of targets) {
    const inheritedProfile = target.scope === "project" && effectiveProfile
      ? gatewayProfileForEndpoint(
          gatewayProfilesOwnedByConfig(global),
          effectiveProfile.gatewayProtocol,
          effectiveProfile.gatewayUrl
        )
      : null;
    const inheritedFallback = Boolean(inheritedProfile);
    const deletionOptions = {
      inheritedFallback,
      inheritedProfileId: inheritedProfile?.id ? String(inheritedProfile.id) : undefined
    };
    let deletion = buildGatewayProfileDeleteConfig(target.config, target.config, profileId, deletionOptions);
    if (!deletion.ok) {
      return { ok: false, status: 404, error: deletion.error };
    }
    const mutation = await mutateDashboardConfig(target.path, async (stored: Record<string, unknown>) => {
      deletion = buildGatewayProfileDeleteConfig(stored, stored, profileId, deletionOptions);
      if (!deletion.ok) {
        throw dashboardConfigResultError(deletion);
      }
      return deletion.config;
    });
    if (!mutation.ok) {
      return mutation;
    }
    mutations.push({ ...target, revision: mutation.revision });
  }
  const refreshed = await loadConfig({ cwd: ctx.cwd, env: await ctx.resolveConfigEnv() });
  const clearedGateway = wasActive && !activeGatewayProfileId(refreshed);
  ctx.selectedModelId = clearedGateway ? "" : String(refreshed.modelAlias ?? "").trim();
  if (state) {
    applySessionConfig(state.session, refreshed);
    state.persisted = false;
  }
  return {
    ok: true,
    deletedProfile: profileId,
    deletedFrom: mutations.map((item) => item.scope).join("+"),
    deletedFromScopes: mutations.map((item) => item.scope),
    clearedGateway,
    configPath: mutations[0].path,
    configPaths: mutations.map((item) => item.path),
    configRevision: mutations.at(-1)?.revision,
    sessionId: state?.session.id,
    sessionStatus: state ? sessionStatusSummary(state.session) : sessionStatusFromConfig(refreshed),
    models: modelOptions(state?.session.config ?? refreshed),
    agentModelTiers: publicAgentModelTiers(state?.session.config ?? refreshed),
    visionAgent: publicVisionAgent(state?.session.config ?? refreshed),
    gatewayConfig: publicGatewayConfig(state?.session.config ?? refreshed),
    gatewayProfiles: publicGatewayProfiles(state?.session.config ?? refreshed)
  };
}

export async function runtimeSwitchGatewayProfile(ctx: DashboardFactoryState, input: DashboardRequestInput = {}) {
  const locked = ctx.rerunWithSessionConfigLock(input, (lockedInput) => ctx.runtime.switchGatewayProfile(lockedInput));
  if (locked) return locked;
  const configEnv = await ctx.resolveConfigEnv();
  const profileId = String(input.profileId ?? input.id ?? "").trim();
  if (!profileId) {
    return { ok: false, status: 400, error: "请选择要切换的网关" };
  }
  const sessionId = String(input.sessionId ?? "").trim();
  const state = sessionId ? ctx.active.get(sessionId) : null;
  if (state?.running) {
    return {
      ok: false,
      status: 409,
      error: "任务运行中，结束或中断后再切换网关",
      models: modelOptions(state.session.config),
      agentModelTiers: publicAgentModelTiers(state.session.config),
      visionAgent: publicVisionAgent(state.session.config),
      gatewayConfig: publicGatewayConfig(state.session.config),
      gatewayProfiles: publicGatewayProfiles(state.session.config)
    };
  }
  const config = await loadConfig({ cwd: ctx.cwd, env: configEnv });
  if (isConfigV2Enabled(config)) {
    const profile = gatewayProfilesFromConfig(config).find((item) => item.id === profileId);
    if (!profile) {
      return { ok: false, status: 404, error: "模型来源不存在" };
    }
    const modelId = String(input.modelId ?? profile.modelAlias ?? profile.models?.[0]?.id ?? "").trim();
    return ctx.runtime.switchModel({
      ...input,
      providerId: profileId,
      modelId,
      reasoningEffort: input.reasoningEffort
    });
  }
  const localPath = localProjectConfigPath(ctx.cwd);
  let nextLocal = buildGatewayProfileSwitchConfig(await readJsonConfig(localPath), config, profileId);
  if (!nextLocal.ok) {
    return {
      ok: false,
      status: nextLocal.status ?? 404,
      error: nextLocal.error,
      models: modelOptions(config),
      agentModelTiers: publicAgentModelTiers(config),
      visionAgent: publicVisionAgent(config),
      gatewayConfig: publicGatewayConfig(config),
      gatewayProfiles: publicGatewayProfiles(config)
    };
  }
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
  const refreshed = await loadConfig({ cwd: ctx.cwd, env: await ctx.resolveConfigEnv() });
  ctx.selectedModelId = String(refreshed.modelAlias ?? "").trim();
  ctx.selectedReasoningEffort = defaultReasoningEffortForConfig(refreshed, ctx.selectedModelId);
  if (state) {
    applySessionConfig(state.session, configWithModelSelection(refreshed, ctx.selectedModelId, ctx.selectedReasoningEffort, {
      explicitReasoningEffort: true
    }));
    state.persisted = false;
    appendDashboardEvent(state, {
      type: "gateway_profile_switched",
      id: eventId("gateway-profile"),
      profileId,
      sessionStatus: sessionStatusSummary(state.session),
      at: new Date().toISOString()
    });
  }
  const modelConfig = configWithModelSelection(refreshed, ctx.selectedModelId, ctx.selectedReasoningEffort, {
    explicitReasoningEffort: true
  });
  const activeConfig = state?.session.config ?? modelConfig;
  return {
    ok: true,
    configRevision: mutation.revision,
    sessionId: state?.session.id,
    sessionStatus: state ? sessionStatusSummary(state.session) : sessionStatusFromConfig(modelConfig),
    models: modelOptions(activeConfig),
    agentModelTiers: publicAgentModelTiers(activeConfig),
    visionAgent: publicVisionAgent(activeConfig),
    gatewayConfig: publicGatewayConfig(activeConfig),
    gatewayProfiles: publicGatewayProfiles(activeConfig)
  };
}

export async function runtimeSaveDefaultModelSelection(ctx: DashboardFactoryState, input: DashboardRequestInput = {}) {
  const locked = ctx.rerunWithSessionConfigLock(input, (lockedInput) => ctx.runtime.saveDefaultModelSelection(lockedInput));
  if (locked) return locked;
  const configEnv = await ctx.resolveConfigEnv();
  const config = await loadConfig({ cwd: ctx.cwd, env: configEnv });
  if (!isConfigV2Enabled(config)) {
    return {
      ok: false,
      status: 409,
      code: "CONFIG_V2_REQUIRED",
      error: "默认模型设置需要先完成 Config V2 迁移"
    };
  }
  const sessionId = String(input.sessionId ?? "").trim();
  const state = sessionId ? ctx.active.get(sessionId) : null;
  if (state?.running) {
    return { ok: false, status: 409, error: "任务运行中，结束或中断后再修改默认模型" };
  }
  let saved;
  try {
    saved = await saveV2DefaultModel({
      cwd: ctx.cwd,
      env: configEnv,
      scope: input.scope ?? input.saveTarget,
      expectedRevision: input.expectedRevision,
      providerId: input.providerId ?? input.profileId,
      modelId: input.modelId ?? input.model,
      reasoningEffort: input.reasoningEffort
    });
  } catch (error) {
    return dashboardV2ErrorResult(error);
  }
  const refreshed = await loadConfig({ cwd: ctx.cwd, env: await ctx.resolveConfigEnv() });
  const sessionView = sessionId
    ? await refreshDashboardSessionAfterV2Mutation({
        active: ctx.active,
        cwd: ctx.cwd,
        env: ctx.runtimeEnv,
        sessionId,
        config: refreshed
      })
    : null;
  const modelConfig = sessionView?.config ?? configForDashboardSelection(refreshed, dashboardRuntimeSelection(
      ctx.clientModelSelections,
      input.clientId,
      { providerId: ctx.selectedProviderId, modelId: ctx.selectedModelId, reasoningEffort: ctx.selectedReasoningEffort }
    ));
  const configV2 = publicV2ConfigState(refreshed);
  return {
    ...saved,
    sessionId: sessionId || undefined,
    sessionStatus: sessionView?.sessionStatus ?? sessionStatusFromConfig(modelConfig),
    models: modelOptions(modelConfig),
    gatewayConfig: publicGatewayConfig(modelConfig),
    gatewayProfiles: publicGatewayProfiles(modelConfig),
    configV2,
    configRevisions: configV2.revisions
  };
}
