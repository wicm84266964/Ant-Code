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
  SENSITIVE_GATEWAY_QUERY_KEYS
} from "./types.ts";
import type {
  DashboardGatewayProfileRecord,
  DashboardModelConfigEntry,
  ModelConfigNormalized
} from "./types.ts";
import {
  gatewayInferenceUrl
} from "./gateway-probe.ts";
import {
  gatewayProfileOwner
} from "./public-config.ts";
import { applyModelContextBudget } from "../../config/context-budget.ts";
import {
  asRecord,
  clonePlainObject,
  isPlainObject
} from "./util.ts";
export { applyModelContextBudget };
import {
  upsertGatewayProfileForPersistence,
  gatewayProfileForPersistence,
  gatewayProfileCredentialState,
  explicitGatewayApiKeyValue,
  removeDeletedGatewayHosts,
  removeUnusedGatewayHosts,
  gatewayProfileForEndpoint,
  sameGatewayProfileEndpoint,
  canonicalGatewayEndpointUrl,
  normalizeGatewayInferenceUrl,
  isGeneratedGatewayProfileId,
  preferredGatewayProfileId,
  gatewayProfilesFromConfig,
  gatewayProfileFromConfig,
  profileAgentConfig,
  normalizeGatewayProfile,
  profileModelEntry,
  upsertGatewayProfile,
  dedupeGatewayProfiles,
  activeGatewayProfileId,
  gatewayProfileIdFromParts,
  gatewayProfileLabel,
  buildReplacementAgentConfig,
  buildLocalAgentModelTiersConfig,
  modelConfigEntry,
  upsertModelEntry,
  parseConfigUrl,
  publicGatewayUrl,
  urlHost,
  positiveIntegerOrNull
} from "./gateway-profile.ts";


export function buildLocalModelConfig(local: LabAgentConfig | Record<string, unknown>, config: LabAgentConfig, normalized: ModelConfigNormalized) {
  const ownedProfiles = gatewayProfilesOwnedByConfig(local);
  const ownedProfile = ownedGatewayProfileForMutation(local, config, normalized);
  const endpointProfile = ownedProfile ?? gatewayProfileForEndpoint(
    ownedProfiles,
    normalized.gatewayProtocol,
    normalized.gatewayUrl
  );
  const targetOwnsEndpoint = Boolean(endpointProfile) || sameGatewayConfig(local, normalized);
  const replaceModels = normalized.replaceModels || !targetOwnsEndpoint;
  const existingModels = Array.isArray(endpointProfile?.models) && endpointProfile.models.length > 0
    ? endpointProfile.models
    : targetOwnsEndpoint ? listConfiguredModels(local) : [];
  const models: DashboardModelConfigEntry[] = replaceModels
    ? [modelConfigEntry(normalized.model)]
    : existingModels.map((model) => modelConfigEntry(model));
  const replacingExistingModel = !replaceModels
    && normalized.previousModelId
    && normalized.previousModelId !== normalized.model.id
    && models.some((model) => model.id === normalized.previousModelId);
  if (replacingExistingModel) {
    const index = models.findIndex((model) => model.id === normalized.previousModelId);
    models.splice(index, 1);
  }
  if (!replaceModels) {
    upsertModelEntry(models, normalized.model);
  }
  const previousModelWasAlias = String(endpointProfile?.modelAlias ?? local.modelAlias ?? "").trim() === normalized.previousModelId;
  const targetProfileId = endpointProfile?.id
    ?? gatewayProfileIdFromParts(normalized.gatewayProtocol, normalized.gatewayUrl);
  const localLab = isPlainObject(local.lab) ? local.lab : {};
  const targetWasActive = String(localLab.activeGatewayProfile ?? "").trim() === targetProfileId
    || sameGatewayConfig(local, normalized);
  const activateTarget = normalized.switchToModel || targetWasActive;
  const lab: Record<string, unknown> = {
    ...localLab,
    gatewayUrl: normalized.gatewayUrl,
    gatewayProtocol: normalized.gatewayProtocol,
    activeGatewayProfile: targetProfileId
  };
  if (normalized.gatewayHealthUrl) {
    lab.gatewayHealthUrl = normalized.gatewayHealthUrl;
  } else {
    lab.gatewayHealthUrl = null;
  }
  if (normalized.credentialAction === "replace") {
    lab.gatewayApiKey = normalized.gatewayApiKey;
    delete lab.gatewayApiKeyDisabled;
  } else if (normalized.credentialAction === "clear") {
    lab.gatewayApiKey = null;
    lab.gatewayApiKeyDisabled = true;
  } else if (!sameGatewayConfig(config, normalized)) {
    const matchingLocalProfile = gatewayProfileForEndpoint(
      gatewayProfilesOwnedByConfig(local),
      normalized.gatewayProtocol,
      normalized.gatewayUrl
    );
    const migration = gatewayCredentialMigration(normalized, local, ownedProfile);
    const previousLocalProfile = migration?.sameOrigin
      ? (ownedProfile ?? gatewayProfileForEndpoint(
          gatewayProfilesOwnedByConfig(local),
          migration.previousGatewayProtocol,
          migration.previousGatewayUrl
        ))
      : null;
    const credentialProfile = matchingLocalProfile ?? previousLocalProfile;
    const credential = credentialProfile
      ? gatewayProfileCredentialState(local, String(credentialProfile.id ?? ""))
      : { explicit: false, value: undefined, disabled: false };
    if (credential.explicit) {
      lab.gatewayApiKey = credential.value;
      if (credential.disabled === true) {
        lab.gatewayApiKeyDisabled = true;
      } else {
        delete lab.gatewayApiKeyDisabled;
      }
    } else {
      delete lab.gatewayApiKey;
      delete lab.gatewayApiKeyDisabled;
    }
  }
  const allowedHosts = Array.from(new Set([
    ...(Array.isArray(local.allowedHosts) ? local.allowedHosts : []),
    urlHost(normalized.gatewayUrl),
    urlHost(normalized.gatewayHealthUrl)
  ].filter(Boolean)));
  const emptyAgents: Record<string, unknown> = {};
  const next: Record<string, unknown> = {
    ...local,
    modelAlias: normalized.switchToModel || previousModelWasAlias
      ? normalized.model.id
      : local.modelAlias ?? endpointProfile?.modelAlias ?? normalized.model.id,
    models,
    allowedHosts,
    lab,
    agents: replaceGatewayAgentRoutes(
      isPlainObject(local.agents) ? local.agents : emptyAgents,
      isPlainObject(endpointProfile?.agents) ? endpointProfile.agents : emptyAgents
    )
  };
  applyModelContextBudget(next, local, normalized.model.contextTokens);
  if (replacingExistingModel) {
    next.agents = replaceModelInAgentConfig(
      {
        ...(isPlainObject(local.agents) ? local.agents : {}),
        ...(isPlainObject(next.agents) ? next.agents : {})
      },
      normalized.previousModelId,
      normalized.model.id
    );
  }
  if (replaceModels) {
    next.agents = buildReplacementAgentConfig(local, normalized);
  }
  if (normalized.applyAgentDefaults) {
    const agents: Record<string, unknown> = isPlainObject(next.agents) ? next.agents : {};
    const modelTiers = normalizeAgentModelTiers(normalized.model.agentModelTiers);
    const existingTiers = isPlainObject(agents.modelTiers) ? agents.modelTiers : {};
    const preservedVisionTier = normalized.visionAgentModelProvided
      ? ""
      : String(existingTiers.vision ?? "").trim();
    if (preservedVisionTier) {
      modelTiers.vision = preservedVisionTier;
    }
    if (Object.keys(modelTiers).length > 0) {
      agents.modelTiers = modelTiers;
    } else {
      delete agents.modelTiers;
    }
    next.agents = agents;
  }
  if (normalized.visionAgentModelProvided) {
    const agents: Record<string, unknown> = isPlainObject(next.agents) ? next.agents : {};
    const modelTiers = normalizeAgentModelTiers(agents.modelTiers);
    if (normalized.visionAgentModel) {
      modelTiers.vision = normalized.visionAgentModel;
    } else {
      delete modelTiers.vision;
    }
    if (Object.keys(modelTiers).length > 0) {
      agents.modelTiers = modelTiers;
    } else {
      delete agents.modelTiers;
    }
    agents.vision = {
      ...(isPlainObject(agents.vision) ? agents.vision : {}),
      enabled: Boolean(normalized.visionAgentModel),
      model: normalized.visionAgentModel || null,
      autoUseWhenMainModelTextOnly: true
    };
    next.agents = agents;
  }
  lab.gatewayProfiles = upsertGatewayProfileEntries(local, normalized, next);
  lab.activeGatewayProfile = targetProfileId;
  if (!activateTarget) {
    const preserved = clonePlainObject(local);
    preserved.allowedHosts = removeUnusedGatewayHosts(
      allowedHosts,
      [localLab.gatewayHealthUrl],
      lab.gatewayProfiles,
      localLab
    );
    preserved.lab = {
      ...localLab,
      gatewayProfiles: lab.gatewayProfiles
    };
    applyModelContextBudget(preserved, local, normalized.model.contextTokens);
    return preserved;
  }
  next.allowedHosts = removeUnusedGatewayHosts(
    next.allowedHosts,
    [localLab.gatewayHealthUrl],
    lab.gatewayProfiles,
    lab
  );
  return next;
}


export function replaceModelInAgentConfig(agents: unknown, previousModelId: unknown, nextModelId: unknown) {
  const next: Record<string, unknown> = isPlainObject(agents) ? clonePlainObject(agents) : {};
  const previous = String(previousModelId ?? "").trim();
  const replacement = String(nextModelId ?? "").trim();
  if (!previous || !replacement || previous === replacement) {
    return next;
  }
  const tiers = normalizeAgentModelTiers(next.modelTiers);
  for (const [tier, model] of Object.entries(tiers)) {
    if (model === previous) {
      tiers[tier] = replacement;
    }
  }
  if (Object.keys(tiers).length > 0) {
    next.modelTiers = tiers;
  } else {
    delete next.modelTiers;
  }
  const vision = asRecord(next.vision);
  if (String(vision.model ?? "").trim() === previous) {
    next.vision = {
      ...vision,
      model: replacement
    };
  }
  return next;
}


export function shouldReplaceModelEntries(config: Record<string, unknown>, normalized: { replaceModels?: unknown; gatewayUrl?: unknown; gatewayProtocol?: unknown }) {
  if (normalized.replaceModels) {
    return true;
  }
  const lab = isPlainObject(config.lab) ? config.lab : null;
  return !sameGatewayProfileEndpoint({
    gatewayUrl: lab?.gatewayUrl,
    gatewayProtocol: lab?.gatewayProtocol
  }, normalized);
}

/** @param {Record<string, any>} config @param {Record<string, any>} normalized */


/** @param {Record<string, any>} config @param {Record<string, any>} normalized */
export function sameGatewayConfig(config: Record<string, unknown>, normalized: Record<string, unknown>) {
  const lab = isPlainObject(config.lab) ? config.lab : null;
  return sameGatewayProfileEndpoint({
    gatewayUrl: lab?.gatewayUrl,
    gatewayProtocol: lab?.gatewayProtocol
  }, normalized);
}

/**
 * Resolve an effective profile id back to the profile id owned by the file
 * being edited. Different layers may use different ids for the same endpoint.
 *
 * @param {Record<string, any>} ownerConfig
 * @param {Record<string, any>} effectiveConfig
 * @param {Record<string, any>} normalized
 */


/**
 * Resolve an effective profile id back to the profile id owned by the file
 * being edited. Different layers may use different ids for the same endpoint.
 *
 * @param {Record<string, any>} ownerConfig
 * @param {Record<string, any>} effectiveConfig
 * @param {Record<string, any>} normalized
 */
export function ownedGatewayProfileForMutation(
  ownerConfig: Record<string, unknown> | LabAgentConfig,
  effectiveConfig: Record<string, unknown> | LabAgentConfig,
  normalized: ModelConfigNormalized | Record<string, unknown>
): DashboardGatewayProfileRecord | null {
  const ownedProfiles = gatewayProfilesOwnedByConfig(ownerConfig);
  const profileId = String(normalized.profileId ?? "").trim();
  if (!profileId) {
    return gatewayProfileForEndpoint(ownedProfiles, normalized.gatewayProtocol, normalized.gatewayUrl);
  }
  const direct = ownedProfiles.find((profile) => profile.id === profileId);
  if (direct) return direct;
  const effectiveProfile = gatewayProfilesFromConfig(effectiveConfig)
    .find((profile) => profile.id === profileId);
  if (effectiveProfile) {
    const endpointMatch = gatewayProfileForEndpoint(
      ownedProfiles,
      effectiveProfile.gatewayProtocol,
      effectiveProfile.gatewayUrl
    );
    if (endpointMatch) return endpointMatch;
  }
  if (normalized.previousGatewayUrl) {
    return gatewayProfileForEndpoint(
      ownedProfiles,
      normalized.previousGatewayProtocol,
      normalized.previousGatewayUrl
    );
  }
  return null;
}

/**
 * @param {Record<string, any>} targetConfig
 * @param {Record<string, any>} config
 * @param {Record<string, any>} normalized
 */


/**
 * @param {Record<string, any>} targetConfig
 * @param {Record<string, any>} config
 * @param {Record<string, any>} normalized
 */
export function validateGatewayCredentialMigration(targetConfig: Record<string, unknown>, config: Record<string, unknown>, normalized: ModelConfigNormalized | Record<string, unknown>) {
  const effectiveProfile = normalized.profileId
    ? gatewayProfilesFromConfig(config).find((profile) => profile.id === normalized.profileId)
    : null;
  const ownedProfile = ownedGatewayProfileForMutation(targetConfig, config, normalized);
  if (normalized.profileId) {
    if (effectiveProfile && !ownedProfile) {
      const ownerScope = String(gatewayProfileOwner(config, String(normalized.profileId ?? ""))?.type ?? "").trim();
      return {
        ok: false,
        status: 400,
        error: ownerScope === "project" || ownerScope === "global"
          ? `该网关档案属于${ownerScope === "global" ? "全局" : "项目"}配置，请保存到原配置范围`
          : "该网关档案由环境或其他配置层管理，不能直接覆盖"
      };
    }
  }
  if (normalized.credentialAction !== "keep") {
    return { ok: true };
  }
  const migration = gatewayCredentialMigration(normalized, targetConfig, ownedProfile);
  if (!migration) {
    return { ok: true };
  }
  const effectiveCredential = normalized.profileId
    ? gatewayProfileCredentialState(config, String(effectiveProfile?.id ?? normalized.profileId ?? ""))
    : gatewayCredentialForEndpoint(
        config,
        migration.previousGatewayProtocol,
        migration.previousGatewayUrl
      );
  if (!effectiveCredential.value) {
    return { ok: true };
  }
  if (!migration.sameOrigin) {
    return { ok: true };
  }
  const ownedCredential = normalized.profileId
    ? (ownedProfile
      ? gatewayProfileCredentialState(targetConfig, ownedProfile.id)
      : { explicit: false, value: undefined, disabled: false })
    : gatewayCredentialForEndpoint(
        targetConfig,
        migration.previousGatewayProtocol,
        migration.previousGatewayUrl
      );
  if (!ownedCredential.value) {
    return {
      ok: false,
      status: 400,
      error: "当前 API Key 来自其他配置层。修改请求路径或协议时无法自动复制该密钥，请重新输入 API Key"
    };
  }
  return { ok: true };
}

/**
 * @param {Record<string, any>} normalized
 * @param {Record<string, any>} [ownerConfig]
 * @param {Record<string, any> | null} [resolvedProfile]
 */


/**
 * @param {Record<string, any>} normalized
 * @param {Record<string, any>} [ownerConfig]
 * @param {Record<string, any> | null} [resolvedProfile]
 */
export function gatewayCredentialMigration(normalized: Record<string, unknown>, ownerConfig: Record<string, unknown> = {}, resolvedProfile: Record<string, unknown> | null = null) {
  const previousProfile = resolvedProfile ?? (normalized.profileId
    ? gatewayProfilesOwnedByConfig(ownerConfig).find((profile) => profile.id === normalized.profileId)
    : null);
  const previousGatewayUrl = String(previousProfile?.gatewayUrl ?? normalized.previousGatewayUrl ?? "").trim();
  const previousGatewayProtocol = String(
    previousProfile?.gatewayProtocol ?? normalized.previousGatewayProtocol ?? "openai-chat"
  ).trim();
  if ((!normalized.profileId && !normalized.previousModelId) || !parseConfigUrl(previousGatewayUrl)) {
    return null;
  }
  const previous = { gatewayUrl: previousGatewayUrl, gatewayProtocol: previousGatewayProtocol };
  if (sameGatewayProfileEndpoint(previous, normalized)) {
    return null;
  }
  return {
    previousGatewayUrl,
    previousGatewayProtocol,
    sameOrigin: gatewayUrlOrigin(previousGatewayUrl) === gatewayUrlOrigin(normalized.gatewayUrl)
  };
}

/** @param {Record<string, any>} config @param {string} gatewayProtocol @param {string} gatewayUrl */


/** @param {Record<string, any>} config @param {string} gatewayProtocol @param {string} gatewayUrl */
export function gatewayCredentialForEndpoint(config: Record<string, unknown>, gatewayProtocol: string, gatewayUrl: string) {
  const profile = gatewayProfileForEndpoint(gatewayProfilesOwnedByConfig(config), gatewayProtocol, gatewayUrl);
  return profile
    ? gatewayProfileCredentialState(config, profile.id)
    : { explicit: false, value: undefined, disabled: false };
}

/** @param {unknown} value */


/** @param {unknown} value */
export function gatewayUrlOrigin(value: unknown) {
  try {
    return new URL(String(value ?? "").trim()).origin;
  } catch {
    return "";
  }
}


export function buildGatewayProfileSwitchConfig(local: LabAgentConfig | Record<string, unknown>, config: Record<string, unknown>, profileId: unknown) {
  const profile = gatewayProfilesFromConfig(config).find((item) => item.id === profileId)
    ?? gatewayProfilesFromConfig(local).find((item) => item.id === profileId);
  if (!profile) {
    return { ok: false, status: 404, error: "网关配置不存在" };
  }
  if (!parseConfigUrl(profile.gatewayUrl) || !(GATEWAY_PROTOCOLS as readonly string[]).includes(profile.gatewayProtocol)) {
    return { ok: false, status: 400, error: "该网关的 API 地址或协议不完整，请先在设置中修正" };
  }
  if (!Array.isArray(profile.models) || profile.models.length === 0) {
    return { ok: false, status: 400, error: "该网关没有已配置模型，请先在设置中添加模型" };
  }
  const next = clonePlainObject(local);
  delete next.modelAlias;
  delete next.models;
  delete next.reasoningEffort;
  const lab = isPlainObject(next.lab) ? next.lab : {};
  const ownedProfiles = gatewayProfilesForPersistence(local);
  for (const key of [
    "gatewayUrl",
    "gatewayHealthUrl",
    "gatewayProtocol",
    "gatewayApiKey",
    "gatewayApiKeyDisabled"
  ]) {
    delete lab[key];
  }
  lab.activeGatewayProfile = profile.id;
  if (ownedProfiles.length > 0) {
    lab.gatewayProfiles = ownedProfiles;
  }
  next.lab = lab;
  if (isPlainObject(next.agents)) {
    delete next.agents.modelTiers;
    delete next.agents.vision;
    if (Object.keys(next.agents).length === 0) {
      delete next.agents;
    }
  }
  return { ok: true, config: next };
}

/**
 * Delete a model from the configuration layer that owns its gateway profile.
 * Effective merged config is used only to determine whether the profile is
 * currently selected; inherited definitions are never copied into the owner.
 *
 * @param {Record<string, any>} ownerConfig
 * @param {Record<string, any>} effectiveConfig
 * @param {string} profileId
 * @param {string} modelId
 * @param {{ inheritedFallback?: boolean; inheritedProfileId?: string }} [options]
 */


/**
 * Delete a model from the configuration layer that owns its gateway profile.
 * Effective merged config is used only to determine whether the profile is
 * currently selected; inherited definitions are never copied into the owner.
 *
 * @param {Record<string, any>} ownerConfig
 * @param {Record<string, any>} effectiveConfig
 * @param {string} profileId
 * @param {string} modelId
 * @param {{ inheritedFallback?: boolean; inheritedProfileId?: string }} [options]
 */
export function buildOwnedDeleteModelConfig(ownerConfig: Record<string, unknown>, effectiveConfig: Record<string, unknown>, profileId: string, modelId: string, options: { inheritedFallback?: boolean; inheritedProfileId?: string } = {}): {
  ok: boolean;
  error?: string;
  status?: number;
  config?: Record<string, unknown>;
  ownerProfileId?: string;
  removedProfile?: boolean;
  clearedGateway?: boolean;
  restoredInherited?: boolean;
} {
  const effectiveProfile = gatewayProfilesFromConfig(effectiveConfig).find((item) => item.id === profileId);
  const ownedProfiles = gatewayProfilesOwnedByConfig(ownerConfig);
  const profile = ownedProfiles.find((item) => item.id === profileId && item.models.some((model) => model.id === modelId))
    ?? (effectiveProfile
      ? gatewayProfileForEndpoint(ownedProfiles, effectiveProfile.gatewayProtocol, effectiveProfile.gatewayUrl)
      : null);
  if (!profile || !profile.models.some((model) => model.id === modelId)) {
    return { ok: false, status: 404, error: "模型配置不存在" };
  }
  const ownerProfileId = profile.id;
  if (profile.models.length <= 1) {
    const deletion = buildGatewayProfileDeleteConfig(ownerConfig, ownerConfig, ownerProfileId, {
      inheritedFallback: options.inheritedFallback === true,
      inheritedProfileId: options.inheritedProfileId
    });
    return {
      ...deletion,
      ownerProfileId,
      removedProfile: deletion.ok === true,
      clearedGateway: deletion.clearedGateway === true
        && activeGatewayProfileId(effectiveConfig) === profileId
        && (effectiveProfile?.models.length ?? 0) <= 1
    };
  }

  const remainingModels: DashboardModelConfigEntry[] = profile.models.filter((model) => model.id !== modelId).map((model) => modelConfigEntry(model));
  const fallbackModel = remainingModels[0]?.id || "";
  const modelAlias = profile.modelAlias === modelId
    ? fallbackModel
    : String(profile.modelAlias ?? fallbackModel).trim() || fallbackModel;
  const agents = removeModelFromAgentConfig(profile.agents ?? {}, modelId, remainingModels);
  const updatedProfile = normalizeGatewayProfile({
    ...profile,
    modelAlias,
    models: remainingModels,
    ...(Object.keys(agents).length > 0 ? { agents } : {})
  });
  const next = clonePlainObject(ownerConfig);
  const lab = isPlainObject(next.lab) ? next.lab : {};
  lab.gatewayProfiles = upsertGatewayProfileForPersistence(
    gatewayProfilesForPersistence(ownerConfig),
    updatedProfile,
    ownerConfig
  );
  next.lab = lab;

  if (ownerConfigMirrorsGatewayProfile(ownerConfig, profile)) {
    next.modelAlias = modelAlias;
    next.models = remainingModels;
    next.agents = replaceGatewayAgentRoutes(asRecord(ownerConfig.agents), asRecord(agents));
  }
  return {
    ok: true,
    config: next,
    ownerProfileId,
    removedProfile: false,
    clearedGateway: false
  };
}

/** @param {Record<string, any>} config @param {Record<string, any>} profile */


/** @param {Record<string, any>} config @param {Record<string, any>} profile */
export function ownerConfigMirrorsGatewayProfile(config: Record<string, unknown>, profile: Record<string, unknown>) {
  const lab = asRecord(config.lab);
  const selected = String(lab.activeGatewayProfile ?? "").trim();
  return selected === profile.id || sameGatewayProfileEndpoint({
    gatewayUrl: lab.gatewayUrl,
    gatewayProtocol: lab.gatewayProtocol
  }, profile);
}

/** @param {unknown} current @param {Record<string, any>} routes */


/** @param {unknown} current @param {Record<string, any>} routes */
export function replaceGatewayAgentRoutes(current: Record<string, unknown>, routes: Record<string, unknown>) {
  const next: Record<string, unknown> = isPlainObject(current) ? clonePlainObject(current) : {};
  delete next.modelTiers;
  delete next.vision;
  if (isPlainObject(routes?.modelTiers) && Object.keys(routes.modelTiers).length > 0) {
    next.modelTiers = clonePlainObject(routes.modelTiers);
  }
  if (isPlainObject(routes?.vision)) {
    next.vision = clonePlainObject(routes.vision);
  }
  return next;
}

/** @param {Record<string, any>} local @param {string} profileId */


/** @param {Record<string, any>} local @param {string} profileId */
export function clearDanglingGatewayProfileSelection(local: Record<string, unknown>, profileId: string) {
  if (configOwnsGatewayProfile(local, profileId)
    || String(asRecord(local.lab).activeGatewayProfile ?? "").trim() !== profileId) {
    return local;
  }
  const next = clonePlainObject(local);
  if (isPlainObject(next.lab)) {
    delete next.lab.activeGatewayProfile;
    if (Object.keys(next.lab).length === 0) {
      delete next.lab;
    }
  }
  return next;
}

/**
 * @param {Record<string, any>} local
 * @param {Record<string, any>} config
 * @param {string} profileId
 * @param {{ inheritedFallback?: boolean; inheritedProfileId?: string }} [options]
 */


/**
 * @param {Record<string, any>} local
 * @param {Record<string, any>} config
 * @param {string} profileId
 * @param {{ inheritedFallback?: boolean; inheritedProfileId?: string }} [options]
 */
export function buildGatewayProfileDeleteConfig(local: Record<string, unknown>, config: Record<string, unknown>, profileId: string, options: { inheritedFallback?: boolean; inheritedProfileId?: string } = {}): {
  ok: boolean;
  error?: string;
  status?: number;
  config?: Record<string, unknown>;
  clearedGateway?: boolean;
  restoredInherited?: boolean;
} {
  const profiles = gatewayProfilesFromLocalAndConfig(local, config);
  const deletedProfile = profiles.find((profile) => profile.id === profileId);
  if (!deletedProfile) {
    return { ok: false, error: "网关配置不存在" };
  }
  const remaining = gatewayProfilesForPersistence(local, config)
    .filter((profile) => profile.id !== profileId && !sameGatewayProfileEndpoint(profile, deletedProfile));
  const allowedHosts = removeDeletedGatewayHosts(local.allowedHosts, deletedProfile, remaining);
  if (options.inheritedFallback === true) {
    const next = clonePlainObject(local);
    delete next.modelAlias;
    delete next.models;
    delete next.reasoningEffort;
    next.allowedHosts = allowedHosts;
    const lab = isPlainObject(next.lab) ? next.lab : {};
    delete lab.gatewayUrl;
    delete lab.gatewayHealthUrl;
    delete lab.gatewayProtocol;
    delete lab.gatewayApiKey;
    delete lab.gatewayApiKeyDisabled;
    lab.activeGatewayProfile = String(options.inheritedProfileId ?? "").trim() || profileId;
    if (remaining.length > 0) {
      lab.gatewayProfiles = remaining;
    } else {
      delete lab.gatewayProfiles;
    }
    next.lab = lab;
    if (isPlainObject(next.agents)) {
      delete next.agents.modelTiers;
      delete next.agents.vision;
    }
    return { ok: true, clearedGateway: false, restoredInherited: true, config: next };
  }
  if (activeGatewayProfileId(config) !== profileId) {
    return {
      ok: true,
      clearedGateway: false,
      config: {
        ...local,
        allowedHosts,
        lab: {
          ...(isPlainObject(local.lab) ? local.lab : {}),
          gatewayProfiles: remaining
        }
      }
    };
  }
  return {
    ok: true,
    clearedGateway: true,
    config: {
      ...local,
      modelAlias: "",
      models: [],
      allowedHosts,
      agents: clearGatewayAgentModels(local, config),
      lab: {
        ...(isPlainObject(local.lab) ? local.lab : {}),
        gatewayUrl: null,
        gatewayHealthUrl: null,
        gatewayProtocol: "openai-chat",
        gatewayApiKey: null,
        activeGatewayProfile: "",
        gatewayProfiles: remaining
      }
    }
  };
}

/**
 * @param {{ local: Record<string, any>; localPath: string; global: Record<string, any>; globalPath: string; profileId: string; ownerScope?: string }} input
 */


/**
 * @param {{ local: Record<string, any>; localPath: string; global: Record<string, any>; globalPath: string; profileId: string; ownerScope?: string }} input
 */
export function gatewayProfileDeleteTargets({ local, localPath, global, globalPath, profileId, ownerScope = "" }: { local: Record<string, unknown>; localPath: string; global: Record<string, unknown>; globalPath: string; profileId: string; ownerScope?: string }) {
  const targets = [];
  if ((ownerScope === "project" || !ownerScope) && configOwnsGatewayProfile(local, profileId)) {
    targets.push({ scope: "project", path: localPath, config: local });
  }
  if ((ownerScope === "global" || !ownerScope)
    && path.resolve(globalPath).toLowerCase() !== path.resolve(localPath).toLowerCase()
    && configOwnsGatewayProfile(global, profileId)) {
    targets.push({ scope: "global", path: globalPath, config: global });
  }
  return targets;
}


export function configOwnsGatewayProfile(config: Record<string, unknown>, profileId: unknown) {
  return gatewayProfilesOwnedByConfig(config).some((profile) => profile.id === profileId);
}

/** @param {Record<string, any>} local @param {Record<string, any>} config */


/** @param {Record<string, any>} local @param {Record<string, any>} config */
export function clearGatewayAgentModels(local: Record<string, unknown>, config: Record<string, unknown>) {
  const agents: Record<string, unknown> = {
    ...asRecord(config.agents),
    ...asRecord(local.agents)
  };
  delete agents.modelTiers;
  const vision = asRecord(agents.vision);
  agents.vision = {
    ...vision,
    enabled: false,
    model: null,
    autoUseWhenMainModelTextOnly: vision.autoUseWhenMainModelTextOnly !== false
  };
  return agents;
}


export function removeModelFromAgentConfig(
  agents: unknown,
  modelId: unknown,
  remainingModels: Array<{ id?: string; modalities?: unknown[] }> = []
) {
  const next: Record<string, unknown> = isPlainObject(agents) ? clonePlainObject(agents) : {};
  const tiers = normalizeAgentModelTiers(next.modelTiers);
  for (const [tier, model] of Object.entries(tiers)) {
    if (model === modelId) {
      delete tiers[tier];
    }
  }
  if (Object.keys(tiers).length > 0) {
    next.modelTiers = tiers;
  } else {
    delete next.modelTiers;
  }
  const vision = asRecord(next.vision);
  const visionModel = String(vision.model ?? "").trim();
  if (visionModel === modelId) {
    const fallbackVision = remainingModels.find((model) => Array.isArray(model.modalities) && model.modalities.includes("image"))?.id || "";
    next.vision = {
      ...vision,
      enabled: Boolean(fallbackVision),
      model: fallbackVision || null,
      autoUseWhenMainModelTextOnly: vision.autoUseWhenMainModelTextOnly !== false
    };
    if (fallbackVision) {
      next.modelTiers = {
        ...asRecord(next.modelTiers),
        vision: fallbackVision
      };
    }
  }
  return next;
}


export function upsertGatewayProfileEntries(
  local: Record<string, unknown> | LabAgentConfig,
  normalized: ModelConfigNormalized | Record<string, unknown>,
  nextConfig: Record<string, unknown>
) {
  const profiles = gatewayProfilesForPersistence(local);
  const nextLab = isPlainObject(nextConfig.lab) ? nextConfig.lab : null;
  const nextProfile = gatewayProfileFromConfig(nextConfig, {
    id: String(nextLab?.activeGatewayProfile ?? "").trim()
      || String(normalized.profileId ?? "")
      || gatewayProfileIdFromParts(normalized.gatewayProtocol, normalized.gatewayUrl)
  });
  return upsertGatewayProfileForPersistence(profiles, nextProfile, nextConfig);
}


export function gatewayProfilesFromLocalAndConfig(local: LabAgentConfig | Record<string, unknown>, config: Record<string, unknown>) {
  const profiles = [
    ...gatewayProfilesFromConfig(config),
    ...gatewayProfilesFromConfig(local)
  ];
  return dedupeGatewayProfiles(profiles);
}

/** @param {Record<string, any>} config */


/** @param {Record<string, any>} config */
export function gatewayProfilesOwnedByConfig(config: Record<string, unknown> | LabAgentConfig) {
  const profiles = gatewayProfilesFromConfig(config);
  const lab = isPlainObject(config.lab) ? config.lab : null;
  const gatewayUrl = String(lab?.gatewayUrl ?? "").trim();
  if (!gatewayUrl) {
    return profiles;
  }
  const gatewayProtocol = String(lab?.gatewayProtocol ?? "openai-chat").trim();
  const endpointProfile = gatewayProfileForEndpoint(profiles, gatewayProtocol, gatewayUrl);
  const selectedId = String(lab?.activeGatewayProfile ?? "").trim();
  const profileId = endpointProfile?.id
    ?? (profiles.length === 0 && selectedId ? selectedId : gatewayProfileIdFromParts(gatewayProtocol, gatewayUrl));
  return upsertGatewayProfile(profiles, normalizeGatewayProfile({
    id: profileId,
    gatewayUrl,
    gatewayHealthUrl: lab?.gatewayHealthUrl ?? "",
    gatewayProtocol,
    gatewayApiKey: lab?.gatewayApiKey ?? "",
    gatewayApiKeyDisabled: lab?.gatewayApiKeyDisabled === true,
    modelAlias: config?.modelAlias ?? "",
    models: Array.isArray(config?.models) ? config.models : [],
    agents: profileAgentConfig(config)
  }));
}

/** @param {Record<string, any>} local @param {Record<string, any>} config */


/** @param {Record<string, any>} local @param {Record<string, any>} config */
export function gatewayProfilesForPersistence(local: Record<string, unknown> | LabAgentConfig, config: Record<string, unknown> = {}) {
  void config;
  const byId = new Map();
  for (const profile of gatewayProfilesOwnedByConfig(local)) {
    const persisted = gatewayProfileForPersistence(profile, local);
    if (persisted) {
      byId.set(persisted.id, persisted);
    }
  }
  return Array.from(byId.values());
}

/**
 * Remove only legacy project snapshots that are provably identical to the
 * pre-save inherited profile. Project credentials or model-route differences
 * make the profile an intentional override and keep it untouched.
 *
 * @param {Record<string, any>} local
 * @param {Record<string, any>} inheritedConfig
 */


/**
 * Remove only legacy project snapshots that are provably identical to the
 * pre-save inherited profile. Project credentials or model-route differences
 * make the profile an intentional override and keep it untouched.
 *
 * @param {Record<string, any>} local
 * @param {Record<string, any>} inheritedConfig
 */
export function removeRedundantInheritedGatewayShadows(local: Record<string, unknown>, inheritedConfig: Record<string, unknown>) {
  const localLab = asRecord(local.lab);
  const configured = Array.isArray(localLab.gatewayProfiles)
    ? localLab.gatewayProfiles
    : [];
  if (configured.length === 0) return local;
  const configuredInheritedProfiles = gatewayProfilesFromConfig(inheritedConfig);
  const materializedInheritedProfiles = gatewayProfilesOwnedByConfig(inheritedConfig);
  const retained = [];
  const replacements = new Map();
  const removed = [];
  for (const rawProfile of configured) {
    const profile = normalizeGatewayProfile(rawProfile);
    const inherited = profile
      ? gatewayProfileForEndpoint(configuredInheritedProfiles, profile.gatewayProtocol, profile.gatewayUrl)
        ?? gatewayProfileForEndpoint(materializedInheritedProfiles, profile.gatewayProtocol, profile.gatewayUrl)
      : null;
    if (!profile || !inherited || !isRedundantInheritedGatewayShadow(local, profile, inherited)) {
      retained.push(rawProfile);
      continue;
    }
    replacements.set(profile.id, inherited.id);
    removed.push({ profile, inherited });
  }
  if (removed.length === 0) return local;

  const next: Record<string, unknown> = clonePlainObject(local);
  const lab: Record<string, unknown> = asRecord(next.lab);
  const selectedId = String(lab.activeGatewayProfile ?? "").trim();
  let replacementId = String(replacements.get(selectedId) ?? "").trim();
  if (!replacementId && String(lab.gatewayUrl ?? "").trim()) {
    const activeRemoved = removed.find(({ profile }: { profile: Record<string, unknown> }) => sameGatewayProfileEndpoint(profile, {
      gatewayUrl: lab.gatewayUrl,
      gatewayProtocol: lab.gatewayProtocol
    }));
    replacementId = String(activeRemoved?.inherited?.id ?? "").trim();
  }

  if (retained.length > 0) {
    lab.gatewayProfiles = retained;
  } else {
    delete lab.gatewayProfiles;
  }
  if (replacementId) {
    lab.activeGatewayProfile = replacementId;
    for (const key of [
      "gatewayUrl",
      "gatewayHealthUrl",
      "gatewayProtocol",
      "gatewayApiKey",
      "gatewayApiKeyDisabled"
    ]) {
      delete lab[key];
    }
    delete next.modelAlias;
    delete next.models;
    if (isPlainObject(next.agents)) {
      delete next.agents.modelTiers;
      delete next.agents.vision;
      if (Object.keys(next.agents).length === 0) delete next.agents;
    }
  }
  next.lab = lab;
  return next;
}

/**
 * @param {Record<string, any>} local
 * @param {Record<string, any>} profile
 * @param {Record<string, any>} inherited
 */


/**
 * @param {Record<string, any>} local
 * @param {Record<string, any>} profile
 * @param {Record<string, any>} inherited
 */
export function isRedundantInheritedGatewayShadow(local: Record<string, unknown>, profile: Record<string, unknown>, inherited: Record<string, unknown>) {
  const credentialExplicit = gatewayProfileCredentialState(local, String(profile.id ?? "")).explicit;
  const profileSignature = gatewayProfileInheritanceSignature(profile);
  const inheritedSignature = gatewayProfileInheritanceSignature(inherited);
  if (credentialExplicit) return false;
  if (!isDeepStrictEqual(profileSignature, inheritedSignature)) {
    return false;
  }
  const lab = asRecord(local.lab);
  const activeId = String(lab.activeGatewayProfile ?? "").trim();
  const topMatches = activeId === profile.id
    || sameGatewayProfileEndpoint(profile, {
      gatewayUrl: lab.gatewayUrl,
      gatewayProtocol: lab.gatewayProtocol
    });
  if (!topMatches) return true;
  if (Object.prototype.hasOwnProperty.call(lab, "gatewayApiKey")
    || lab.gatewayApiKeyDisabled === true) {
    return false;
  }
  const ownsTopProjection = Object.prototype.hasOwnProperty.call(local, "modelAlias")
    || Object.prototype.hasOwnProperty.call(local, "models")
    || Object.prototype.hasOwnProperty.call(lab, "gatewayUrl")
    || Object.prototype.hasOwnProperty.call(lab, "gatewayHealthUrl")
    || Object.prototype.hasOwnProperty.call(lab, "gatewayProtocol")
    || Object.keys(profileAgentConfig(local)).length > 0;
  if (!ownsTopProjection) return true;
  const topAgents = profileAgentConfig(local);
  const topProfile = normalizeGatewayProfile({
    id: profile.id,
    label: profile.label,
    gatewayUrl: lab.gatewayUrl ?? profile.gatewayUrl,
    gatewayHealthUrl: lab.gatewayHealthUrl ?? profile.gatewayHealthUrl,
    gatewayProtocol: lab.gatewayProtocol ?? profile.gatewayProtocol,
    modelAlias: local.modelAlias ?? profile.modelAlias,
    models: Array.isArray(local.models) ? local.models : profile.models,
    agents: Object.keys(topAgents).length > 0 ? topAgents : profile.agents
  });
  const topSignature = gatewayProfileInheritanceSignature(topProfile, false);
  const inheritedTopSignature = gatewayProfileInheritanceSignature(inherited, false);
  return isDeepStrictEqual(topSignature, inheritedTopSignature);
}

/** @param {Record<string, any> | null} profile @param {boolean} [includeLabel] */


/** @param {Record<string, any> | null} profile @param {boolean} [includeLabel] */
export function gatewayProfileInheritanceSignature(profile: Record<string, unknown> | null, includeLabel: boolean = true) {
  const normalized = normalizeGatewayProfile(profile);
  if (!normalized) return null;
  return {
    ...(includeLabel ? { label: normalized.label } : {}),
    gatewayUrl: canonicalGatewayEndpointUrl(normalized.gatewayUrl, normalized.gatewayProtocol),
    gatewayHealthUrl: canonicalGatewayEndpointUrl(normalized.gatewayHealthUrl),
    gatewayProtocol: normalized.gatewayProtocol,
    modelAlias: normalized.modelAlias,
    models: listConfiguredModels({
      modelAlias: normalized.modelAlias,
      models: normalized.models
    }).map(modelConfigEntry),
    agents: isPlainObject(normalized.agents) ? clonePlainObject(normalized.agents) : {}
  };
}

export {
  upsertGatewayProfileForPersistence,
  gatewayProfileForPersistence,
  gatewayProfileCredentialState,
  explicitGatewayApiKeyValue,
  removeDeletedGatewayHosts,
  removeUnusedGatewayHosts,
  gatewayProfileForEndpoint,
  sameGatewayProfileEndpoint,
  canonicalGatewayEndpointUrl,
  normalizeGatewayInferenceUrl,
  isGeneratedGatewayProfileId,
  preferredGatewayProfileId,
  gatewayProfilesFromConfig,
  gatewayProfileFromConfig,
  profileAgentConfig,
  normalizeGatewayProfile,
  profileModelEntry,
  upsertGatewayProfile,
  dedupeGatewayProfiles,
  activeGatewayProfileId,
  gatewayProfileIdFromParts,
  gatewayProfileLabel,
  buildReplacementAgentConfig,
  buildLocalAgentModelTiersConfig,
  modelConfigEntry,
  upsertModelEntry,
  parseConfigUrl,
  publicGatewayUrl,
  urlHost,
  positiveIntegerOrNull
} from "./gateway-profile.ts";


/**
 * @param {Array<Record<string, any>>} profiles
 * @param {Record<string, any> | null} profile
 * @param {Record<string, any>} ownerConfig
 */


/**
 * @param {Array<Record<string, any>>} profiles
 * @param {Record<string, any> | null} profile
 * @param {Record<string, any>} ownerConfig
 */
