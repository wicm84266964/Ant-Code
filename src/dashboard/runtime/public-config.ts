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

import type {
  ConfigSourceView
} from "./types.ts";
import {
  activeGatewayProfileId,
  gatewayProfileFromConfig,
  gatewayProfileLabel,
  gatewayProfilesFromConfig,
  parseConfigUrl,
  publicGatewayUrl
} from "./model-config.ts";
import {
  resolveReasoningEffortSelection
} from "./session-model.ts";
import {
  dashboardManagedAllowedHosts,
  hasRuntimeEnvValue
} from "./settings.ts";
import {
  isPlainObject
} from "./util.ts";


export function modelOptions(config: LabAgentConfig) {
  const current = String(config.modelAlias ?? "").trim();
  const defaultModel = String(config.defaultModelAlias ?? config.modelAlias ?? "").trim();
  const sources = config.configSources ?? {};
  return listConfiguredModels(config).map((model) => publicModelOption(model, current, defaultModel, sources, {
    source: activeGatewaySource(config, model.id),
    reasoningEffort: model.id === current ? config.reasoningEffort : ""
  }));
}

/** @param {Record<string, any>} model @param {string} currentModelId @param {string} defaultModelId @param {Record<string, any>} sources @param {Record<string, any>} options */


/** @param {Record<string, any>} model @param {string} currentModelId @param {string} defaultModelId @param {Record<string, any>} sources @param {Record<string, any>} options */
export function publicModelOption(model: LabModel, currentModelId: string = "", defaultModelId: string = "", sources: { modelAlias?: unknown; models?: unknown } = {}, options: { reasoningEffort?: unknown; source?: unknown } = {}) {
  const reasoningEfforts = normalizeReasoningEfforts(model.reasoningEfforts);
  const selectedReasoningEffort = resolveReasoningEffortSelection(
    { ...model, reasoningEfforts },
    options.reasoningEffort,
    model.defaultReasoningEffort
  );
  return {
    id: model.id,
    label: model.label,
    description: model.description,
    thinking: model.thinking === true,
    modalities: Array.isArray(model.modalities) && model.modalities.length > 0 ? model.modalities : ["text"],
    contextTokens: typeof model.contextTokens === "number" && Number.isFinite(model.contextTokens) && model.contextTokens > 0
      ? model.contextTokens
      : null,
    source: options.source ?? null,
    reasoningEfforts,
    defaultReasoningEffort: reasoningEfforts.some((effort: { id?: string; default?: boolean }) => effort.id === model.defaultReasoningEffort)
      ? model.defaultReasoningEffort
      : null,
    reasoningEffort: selectedReasoningEffort || null,
    agentModelTiers: normalizeAgentModelTiers(model.agentModelTiers),
    sources: {
      modelAlias: publicConfigSource(sources.modelAlias),
      models: publicConfigSource(sources.models)
    },
    current: model.id === currentModelId,
    default: model.id === defaultModelId
  };
}


export function modelContextTokens(config: LabAgentConfig) {
  const current = String(config?.modelAlias ?? "").trim();
  const model = listConfiguredModels(config).find((item) => item.id === current);
  const tokens = Number(model?.contextTokens);
  return Number.isFinite(tokens) ? tokens : null;
}


export function publicGatewayConfig(config: LabAgentConfig) {
  return {
    gatewayUrl: publicGatewayUrl(config.lab?.gatewayUrl),
    gatewayHealthUrl: publicGatewayUrl(config.lab?.gatewayHealthUrl),
    gatewayProtocol: config.lab?.gatewayProtocol ?? "openai-chat",
    supportedProtocols: [...GATEWAY_PROTOCOLS],
    apiKeyConfigured: Boolean(config.lab?.gatewayApiKey),
    activeProfileId: activeGatewayProfileId(config),
    globalConfigPath: config.globalConfigPath ?? "",
    projectConfigPath: config.projectConfigPath ?? "",
    sources: {
      gatewayUrl: publicConfigSource(config.lab?.sources?.gatewayUrl ?? config.configSources?.lab?.gatewayUrl),
      gatewayHealthUrl: publicConfigSource(config.lab?.sources?.gatewayHealthUrl ?? config.configSources?.lab?.gatewayHealthUrl),
      gatewayProtocol: publicConfigSource(config.lab?.sources?.gatewayProtocol ?? config.configSources?.lab?.gatewayProtocol),
      apiKey: publicConfigSource(config.lab?.sources?.gatewayApiKey ?? config.configSources?.lab?.gatewayApiKey)
    }
  };
}

/** @param {Record<string, any>} config @param {NodeJS.ProcessEnv} env */


/** @param {Record<string, any>} config @param {NodeJS.ProcessEnv} env */
export function publicDashboardSettings(config: LabAgentConfig, env: NodeJS.ProcessEnv = {}) {
  const transcript = config.transcript;
  const orchestration = config.agents.orchestration;
  const backgroundWakeup = config.agents.backgroundWakeup;
  const reviewGate = config.agents.reviewGate;
  const sensitivity = config.security?.sensitivity === "high" ? "high" : "standard";
  const managedAllowedHosts = dashboardManagedAllowedHosts(env);
  return {
    transcript: {
      enabled: transcript.enabled !== false,
      retentionDays: transcript.retentionDays === null
        ? null
        : Number.isFinite(transcript.retentionDays) ? transcript.retentionDays : 30,
      encryption: ["off", "optional", "required"].includes(transcript.encryption) ? transcript.encryption : "off",
      encryptionKeyConfigured: Boolean(String(env.LAB_AGENT_TRANSCRIPT_KEY ?? "").trim())
    },
    network: {
      mode: (NETWORK_MODES as readonly string[]).includes(config.networkMode) ? config.networkMode : "approved-web",
      allowedModes: sensitivity === "high" ? ["offline", "lab-only"] : [...NETWORK_MODES],
      sensitivity,
      allowedHosts: Array.isArray(config.allowedHosts) ? [...config.allowedHosts] : [],
      managedAllowedHosts
    },
    agents: {
      maxParallelReadonlyAgentRuns: Math.min(8, Math.max(1, Number(orchestration.maxParallelReadonlyAgentRuns) || 3)),
      backgroundWakeupEnabled: backgroundWakeup.enabled !== false,
      backgroundByDefault: backgroundWakeup.defaultForModelAgentRun === true,
      reviewGateEnabled: reviewGate.enabled !== false,
      syncModelTiersOnSwitch: config.agents?.syncModelTiersOnSwitch !== false,
      goalMaxAutoContinues: resolveGoalMaxAutoContinues(config)
    },
    reliability: {
      maxRetries: Number(config.lab?.gatewayMaxRetries ?? 5),
      timeoutMs: Number(config.lab?.gatewayTimeoutMs ?? 900000),
      idleTimeoutMs: Number(config.lab?.gatewayIdleTimeoutMs ?? 300000)
    },
    managed: {
      transcriptEnabled: hasRuntimeEnvValue(env, "LAB_AGENT_TRANSCRIPT_ENABLED"),
      transcriptRetentionDays: hasRuntimeEnvValue(env, "LAB_AGENT_TRANSCRIPT_RETENTION_DAYS"),
      transcriptEncryption: hasRuntimeEnvValue(env, "LAB_AGENT_TRANSCRIPT_ENCRYPTION"),
      networkMode: hasRuntimeEnvValue(env, "LAB_AGENT_NETWORK_MODE"),
      gatewayMaxRetries: hasRuntimeEnvValue(env, "LAB_MODEL_GATEWAY_MAX_RETRIES"),
      gatewayTimeoutMs: hasRuntimeEnvValue(env, "LAB_MODEL_GATEWAY_TIMEOUT_MS"),
      gatewayIdleTimeoutMs: hasRuntimeEnvValue(env, "LAB_MODEL_GATEWAY_IDLE_TIMEOUT_MS")
    }
  };
}


export function publicGatewayProfiles(config: LabAgentConfig) {
  const active = activeGatewayProfileId(config);
  return gatewayProfilesFromConfig(config).map((profile) => {
    const owner = gatewayProfileOwner(config, profile.id);
    const ownerScope = String(owner?.type ?? "").trim();
    const profileConfig = {
      models: profile.models,
      modelAlias: profile.modelAlias,
      reasoningEffort: profile.id === active ? config.reasoningEffort : ""
    };
    const models = listConfiguredModels(profileConfig).map((model) => publicModelOption(
      model,
      profile.id === active ? String(config.modelAlias ?? profile.modelAlias ?? "") : profile.modelAlias,
      profile.modelAlias,
      {},
      {
        source: gatewayProfileModelSource(config, profile, model.id),
        reasoningEffort: profile.id === active ? config.reasoningEffort : ""
      }
    ));
    return {
      id: profile.id,
      label: profile.label || profile.id,
      gatewayUrl: publicGatewayUrl(profile.gatewayUrl),
      gatewayHealthUrl: publicGatewayUrl(profile.gatewayHealthUrl),
      gatewayProtocol: profile.gatewayProtocol || "openai-chat",
      apiKeyConfigured: Boolean(profile.gatewayApiKey) || (profile.id === active && Boolean(config.lab?.gatewayApiKey)),
      modelAlias: profile.modelAlias || "",
      modelCount: models.length,
      models,
      agentModelTiers: normalizeAgentModelTiers(profile.agents?.modelTiers),
      visionAgent: publicVisionAgent({ agents: { vision: profile.agents?.vision } }),
      ownerScope,
      saveTarget: ownerScope === "project" || ownerScope === "global" ? ownerScope : "",
      editable: ownerScope === "project" || ownerScope === "global",
      ready: Boolean(parseConfigUrl(profile.gatewayUrl) && (GATEWAY_PROTOCOLS as readonly string[]).includes(profile.gatewayProtocol) && models.length > 0),
      current: profile.id === active
    };
  });
}

/** @param {Record<string, any>} config @param {string} profileId */


/** @param {Record<string, any>} config @param {string} profileId */
export function gatewayProfileOwner(config: LabAgentConfig | Record<string, unknown>, profileId: string): ConfigSourceView | Record<string, unknown> | null {
  const configV2 = isPlainObject(config.configV2) ? config.configV2 : null;
  const provenance = configV2 && isPlainObject(configV2.provenance) ? configV2.provenance : null;
  const providers = provenance && isPlainObject(provenance.providers) ? provenance.providers : null;
  const v2Owner = String(providers?.[profileId] ?? "").trim();
  if (v2Owner) {
    return { type: v2Owner, label: v2Owner };
  }
  const configSources = isPlainObject(config.configSources) ? config.configSources : null;
  const labSources = configSources && isPlainObject(configSources.lab) ? configSources.lab : null;
  const sources = labSources?.gatewayProfiles;
  if (Array.isArray(sources)) {
    return sources.find((source) => isPlainObject(source) && String(source.id ?? "").trim() === profileId) ?? null;
  }
  return isPlainObject(sources) && isPlainObject(sources[profileId]) ? sources[profileId] : null;
}

/** @param {Record<string, any>} config @param {string} [modelId] */


/** @param {Record<string, any>} config @param {string} [modelId] */
export function activeGatewaySource(config: Record<string, unknown>, modelId: string = "") {
  const active = activeGatewayProfileId(config);
  const profile = gatewayProfilesFromConfig(config).find((item) => item.id === active)
    ?? gatewayProfileFromConfig(config, { id: active });
  return gatewayProfileModelSource(config, profile, modelId);
}

/** @param {Record<string, any>} config @param {Record<string, any> | null | undefined} profile @param {string} modelId */


/** @param {Record<string, any>} config @param {Record<string, any> | null | undefined} profile @param {string} modelId */
export function gatewayProfileModelSource(config: Record<string, unknown>, profile: Record<string, unknown> | null | undefined, modelId: string) {
  const source = publicGatewaySource(profile);
  if (!source) return null;
  const owner = gatewayProfileOwner(config, String(profile?.id ?? ""));
  const ownerRecord = isPlainObject(owner) ? owner : null;
  const scopes = ownerRecord && isPlainObject(ownerRecord.modelScopes) ? ownerRecord.modelScopes : null;
  const ownerScope = String(scopes?.[modelId] ?? ownerRecord?.type ?? "default").trim();
  return {
    ...source,
    ownerScope,
    saveTarget: ownerScope === "project" || ownerScope === "global" ? ownerScope : "",
    editable: ownerScope === "project" || ownerScope === "global"
  };
}

/** @param {Record<string, any> | null | undefined} profile */


/** @param {Record<string, any> | null | undefined} profile */
export function publicGatewaySource(profile: Record<string, unknown> | null | undefined) {
  if (!profile) return null;
  return {
    id: String(profile.id ?? ""),
    profileId: String(profile.id ?? ""),
    label: String(profile.label ?? "").trim() || gatewayProfileLabel(profile.gatewayUrl, profile.gatewayProtocol),
    protocol: String(profile.gatewayProtocol ?? "openai-chat")
  };
}


export function publicAgentModelTiers(config: LabAgentConfig) {
  return normalizeAgentModelTiers(config.agents?.modelTiers);
}


export function publicVisionAgent(config: { agents?: { vision?: unknown } }) {
  const vision = isPlainObject(config.agents?.vision) ? config.agents.vision : null;
  return {
    enabled: vision?.enabled !== false,
    model: String(vision?.model ?? "").trim(),
    autoUseWhenMainModelTextOnly: vision?.autoUseWhenMainModelTextOnly !== false
  };
}


export function publicConfigSource(source: unknown): ConfigSourceView {
  if (!source || typeof source !== "object") {
    return { type: "default", label: "default" };
  }
  const record = source as Record<string, unknown>;
  return {
    type: String(record.type ?? "default"),
    label: String(record.label ?? record.type ?? "default")
  };
}

/** @param {unknown} value */
