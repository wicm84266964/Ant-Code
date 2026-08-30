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
import {
  asRecord,
  clonePlainObject,
  isPlainObject
} from "./util.ts";


export function upsertGatewayProfileForPersistence(
  profiles: DashboardGatewayProfileRecord[],
  profile: DashboardGatewayProfileRecord | Record<string, unknown> | null,
  ownerConfig: Record<string, unknown> | LabAgentConfig
) {
  const normalized = normalizeGatewayProfile(profile);
  const existing = normalized
    ? gatewayProfileForEndpoint(profiles, normalized.gatewayProtocol, normalized.gatewayUrl)
    : null;
  const candidate = normalized && existing
    ? { ...normalized, id: preferredGatewayProfileId(existing, normalized) }
    : normalized;
  const persisted = gatewayProfileForPersistence(candidate, ownerConfig);
  const next: Array<DashboardGatewayProfileRecord | Record<string, unknown>> = profiles.filter((item) => (
    item.id !== persisted?.id && !sameGatewayProfileEndpoint(item, persisted)
  ));
  if (persisted) {
    next.push(persisted);
  }
  return next;
}

/** @param {Record<string, any> | null} profile @param {Record<string, any>} ownerConfig */


/** @param {Record<string, any> | null} profile @param {Record<string, any>} ownerConfig */
export function gatewayProfileForPersistence(
  profile: DashboardGatewayProfileRecord | Record<string, unknown> | null,
  ownerConfig: Record<string, unknown> | LabAgentConfig
): Record<string, unknown> | null {
  const normalized = normalizeGatewayProfile(profile);
  if (!normalized) {
    return null;
  }
  const credential = gatewayProfileCredentialState(ownerConfig, normalized.id);
  if (credential.explicit) {
    const persisted: Record<string, unknown> = { ...normalized, gatewayApiKey: credential.value };
    if (credential.disabled) {
      persisted.gatewayApiKeyDisabled = true;
    } else {
      delete persisted.gatewayApiKeyDisabled;
    }
    return persisted;
  }
  const persisted: Record<string, unknown> = { ...normalized };
  delete persisted.gatewayApiKey;
  delete persisted.gatewayApiKeyDisabled;
  return persisted;
}

/** @param {Record<string, any>} config @param {string} profileId */


/** @param {Record<string, any>} config @param {string} profileId */
export function gatewayProfileCredentialState(config: LabAgentConfig | Record<string, unknown>, profileId: string) {
  const lab: Record<string, unknown> = asRecord(config.lab);
  const topId = activeGatewayProfileId(config);
  if (topId === profileId && lab.gatewayApiKeyDisabled === true) {
    return { explicit: true, value: null, disabled: true };
  }
  if (topId === profileId && Object.prototype.hasOwnProperty.call(lab, "gatewayApiKey")) {
    const value = explicitGatewayApiKeyValue(lab.gatewayApiKey);
    if (value) {
      return { explicit: true, value, disabled: false };
    }
  }
  const configured = Array.isArray(lab.gatewayProfiles) ? lab.gatewayProfiles : [];
  for (let index = configured.length - 1; index >= 0; index -= 1) {
    const raw = configured[index];
    const normalized = normalizeGatewayProfile(raw);
    const rawRecord = isPlainObject(raw) ? raw : {};
    if (normalized?.id === profileId && rawRecord.gatewayApiKeyDisabled === true) {
      return { explicit: true, value: null, disabled: true };
    }
    if (normalized?.id === profileId && Object.prototype.hasOwnProperty.call(rawRecord, "gatewayApiKey")) {
      const value = explicitGatewayApiKeyValue(rawRecord.gatewayApiKey);
      if (value) {
        return { explicit: true, value, disabled: false };
      }
    }
  }
  return { explicit: false, value: undefined, disabled: false };
}

/** @param {unknown} value */


/** @param {unknown} value */
export function explicitGatewayApiKeyValue(value: unknown) {
  const key = String(value ?? "").trim();
  return key || null;
}

/**
 * @param {unknown} allowedHosts
 * @param {Record<string, any>} deletedProfile
 * @param {Array<Record<string, any>>} remainingProfiles
 */


/**
 * @param {unknown} allowedHosts
 * @param {Record<string, any>} deletedProfile
 * @param {Array<Record<string, any>>} remainingProfiles
 */
export function removeDeletedGatewayHosts(allowedHosts: unknown, deletedProfile: Record<string, unknown>, remainingProfiles: Array<Record<string, unknown>>) {
  return removeUnusedGatewayHosts(
    allowedHosts,
    [deletedProfile?.gatewayUrl, deletedProfile?.gatewayHealthUrl],
    remainingProfiles
  );
}

/**
 * @param {unknown} allowedHosts
 * @param {Array<unknown>} removedUrls
 * @param {Array<Record<string, any>>} remainingProfiles
 * @param {Record<string, any>} [activeLab]
 */


/**
 * @param {unknown} allowedHosts
 * @param {Array<unknown>} removedUrls
 * @param {Array<Record<string, any>>} remainingProfiles
 * @param {Record<string, any>} [activeLab]
 */
export function removeUnusedGatewayHosts(allowedHosts: unknown, removedUrls: Array<unknown>, remainingProfiles: unknown, activeLab: Record<string, unknown> = {}) {
  const deletedHosts = new Set(removedUrls.map(urlHost).filter(Boolean));
  const profiles = Array.isArray(remainingProfiles) ? remainingProfiles : [];
  const retainedHosts = new Set([
    ...profiles.flatMap((profile) => [
      urlHost(isPlainObject(profile) ? profile.gatewayUrl : ""),
      urlHost(isPlainObject(profile) ? profile.gatewayHealthUrl : "")
    ]),
    urlHost(activeLab.gatewayUrl),
    urlHost(activeLab.gatewayHealthUrl)
  ].filter(Boolean));
  return (Array.isArray(allowedHosts) ? allowedHosts : [])
    .filter((host) => {
      const value = String(host ?? "");
      return !deletedHosts.has(value) || retainedHosts.has(value);
    });
}

/** @param {Array<Record<string, any>>} profiles @param {string} protocol @param {string} gatewayUrl */


/** @param {Array<Record<string, any>>} profiles @param {string} protocol @param {string} gatewayUrl */
export function gatewayProfileForEndpoint(
  profiles: Array<DashboardGatewayProfileRecord | Record<string, unknown>>,
  protocol: unknown,
  gatewayUrl: unknown
): DashboardGatewayProfileRecord | null {
  const matches = profiles.filter((profile) => sameGatewayProfileEndpoint(profile, { gatewayProtocol: protocol, gatewayUrl }));
  const found = matches.find((profile) => !isGeneratedGatewayProfileId(profile)) ?? matches[0] ?? null;
  return found ? normalizeGatewayProfile(found) : null;
}

/** @param {Record<string, any> | null} left @param {Record<string, any> | null} right */


/** @param {Record<string, any> | null} left @param {Record<string, any> | null} right */
export function sameGatewayProfileEndpoint(
  left: { gatewayProtocol?: unknown; gatewayUrl?: unknown } | null | undefined,
  right: { gatewayProtocol?: unknown; gatewayUrl?: unknown } | null | undefined
) {
  if (!left || !right) {
    return false;
  }
  const leftProtocol = String(left.gatewayProtocol ?? "openai-chat").trim();
  const rightProtocol = String(right.gatewayProtocol ?? "openai-chat").trim();
  return canonicalGatewayEndpointUrl(left.gatewayUrl, leftProtocol)
      === canonicalGatewayEndpointUrl(right.gatewayUrl, rightProtocol)
    && leftProtocol === rightProtocol;
}

/** @param {unknown} value @param {string} [protocol] */


/** @param {unknown} value @param {string} [protocol] */
export function canonicalGatewayEndpointUrl(value: unknown, protocol: string = "") {
  const text = protocol ? normalizeGatewayInferenceUrl(value, protocol) : String(value ?? "").trim();
  if (!text) {
    return "";
  }
  try {
    const url = new URL(text);
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    url.hash = "";
    return url.href;
  } catch {
    return text.replace(/\/+$/, "");
  }
}

/** @param {unknown} value @param {string} protocol */


/** @param {unknown} value @param {string} protocol */
export function normalizeGatewayInferenceUrl(value: unknown, protocol: string) {
  const parsed = parseConfigUrl(String(value ?? "").trim());
  return parsed ? gatewayInferenceUrl(parsed, protocol) : String(value ?? "").trim();
}

/** @param {Record<string, any>} profile */


/** @param {Record<string, any>} profile */
export function isGeneratedGatewayProfileId(profile: { id?: unknown; gatewayProtocol?: unknown; gatewayUrl?: unknown }) {
  return String(profile.id ?? "").trim()
    === gatewayProfileIdFromParts(profile.gatewayProtocol, profile.gatewayUrl);
}

/** @param {Record<string, any>} existing @param {Record<string, any>} incoming */


/** @param {Record<string, any>} existing @param {Record<string, any>} incoming */
export function preferredGatewayProfileId(
  existing: { id?: unknown; gatewayProtocol?: unknown; gatewayUrl?: unknown },
  incoming: { id?: unknown; gatewayProtocol?: unknown; gatewayUrl?: unknown }
) {
  return String(
    (isGeneratedGatewayProfileId(existing) && !isGeneratedGatewayProfileId(incoming)
      ? incoming.id
      : existing.id) ?? ""
  );
}


export function gatewayProfilesFromConfig(config: LabAgentConfig | { lab?: { gatewayProfiles?: unknown } }): DashboardGatewayProfileRecord[] {
  const configured = Array.isArray(config?.lab?.gatewayProfiles) ? config.lab.gatewayProfiles : [];
  return dedupeGatewayProfiles(configured.map(normalizeGatewayProfile).filter((profile): profile is DashboardGatewayProfileRecord => Boolean(profile)));
}


export function gatewayProfileFromConfig(config: Record<string, unknown> | LabAgentConfig, overrides: { id?: unknown; [key: string]: unknown } = {}) {
  const lab = asRecord(config.lab);
  const id = String(overrides.id ?? lab.activeGatewayProfile ?? "").trim()
    || gatewayProfileIdFromParts(lab.gatewayProtocol, lab.gatewayUrl);
  return normalizeGatewayProfile({
    id,
    label: gatewayProfileLabel(lab.gatewayUrl, lab.gatewayProtocol),
    gatewayUrl: lab.gatewayUrl ?? "",
    gatewayHealthUrl: lab.gatewayHealthUrl ?? "",
    gatewayProtocol: lab.gatewayProtocol ?? "openai-chat",
    gatewayApiKey: lab.gatewayApiKey ?? "",
    gatewayApiKeyDisabled: lab.gatewayApiKeyDisabled === true,
    modelAlias: config.modelAlias ?? "",
    models: listConfiguredModels(config).map(modelConfigEntry),
    agents: profileAgentConfig(config)
  });
}


export function profileAgentConfig(config: LabAgentConfig | Record<string, unknown>) {
  const agents: {
    modelTiers?: Record<string, string>;
    vision?: { enabled: boolean; model: string | null; autoUseWhenMainModelTextOnly: boolean };
  } = {};
  const currentAgents = asRecord(config.agents);
  const tiers = normalizeAgentModelTiers(currentAgents.modelTiers);
  if (Object.keys(tiers).length > 0) {
    agents.modelTiers = tiers;
  }
  if (currentAgents.vision) {
    const vision = asRecord(currentAgents.vision);
    agents.vision = {
      enabled: vision.enabled !== false,
      model: vision.model == null ? null : String(vision.model),
      autoUseWhenMainModelTextOnly: vision.autoUseWhenMainModelTextOnly !== false
    };
  }
  return agents;
}


export function normalizeGatewayProfile(value: unknown): DashboardGatewayProfileRecord | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const gatewayUrl = String(value.gatewayUrl ?? "").trim();
  const gatewayProtocol = String(value.gatewayProtocol ?? "openai-chat").trim();
  const id = String(value.id ?? "").trim() || gatewayProfileIdFromParts(gatewayProtocol, gatewayUrl);
  if (!id) {
    return null;
  }
  const models = Array.isArray(value.models)
    ? value.models.map((item) => modelConfigEntry(typeof item === "string" ? { id: item } : isPlainObject(item) ? item : { id: "" })).filter((model) => model.id)
    : [];
  return {
    id,
    label: String(value.label ?? "").trim() || gatewayProfileLabel(gatewayUrl, gatewayProtocol),
    gatewayUrl,
    gatewayHealthUrl: String(value.gatewayHealthUrl ?? "").trim(),
    gatewayProtocol,
    gatewayApiKey: String(value.gatewayApiKey ?? "").trim(),
    gatewayApiKeyDisabled: value.gatewayApiKeyDisabled === true,
    modelAlias: String(value.modelAlias ?? "").trim() || models[0]?.id || "",
    models,
    ...(isPlainObject(value.agents) ? { agents: clonePlainObject(value.agents) } : {})
  };
}


export function profileModelEntry(model: unknown): LabModel {
  const entry = typeof model === "string"
    ? {
      id: model,
      label: model,
      description: "Configured model alias.",
      thinking: /thinking|reason/i.test(model),
      modalities: /vision|visual|image|omni|multimodal/i.test(model) ? ["text", "image"] : ["text"]
    }
    : isPlainObject(model) ? modelConfigEntry(model) : modelConfigEntry({ id: "" });
  return {
    id: String(entry.id ?? ""),
    label: String(entry.label ?? entry.id ?? ""),
    description: String(entry.description ?? ""),
    thinking: entry.thinking === true,
    modalities: Array.isArray(entry.modalities) ? entry.modalities.map(String) : ["text"],
    contextTokens: typeof entry.contextTokens === "number" && Number.isFinite(entry.contextTokens) && entry.contextTokens > 0
      ? entry.contextTokens
      : null,
    reasoningContentMode: entry.reasoningContentMode == null ? null : String(entry.reasoningContentMode),
    reasoningEfforts: Array.isArray(entry.reasoningEfforts) ? entry.reasoningEfforts : [],
    defaultReasoningEffort: entry.defaultReasoningEffort == null ? null : String(entry.defaultReasoningEffort),
    openaiExtraBody: isPlainObject(entry.openaiExtraBody) ? entry.openaiExtraBody : null,
    agentModelTiers: normalizeAgentModelTiers(entry.agentModelTiers)
  };
}


export function upsertGatewayProfile(profiles: unknown[] | unknown, profile: unknown) {
  const next = dedupeGatewayProfiles(profiles);
  const normalized = normalizeGatewayProfile(profile);
  if (!normalized) {
    return next;
  }
  const index = next.findIndex((item) => item.id === normalized.id);
  if (index >= 0) {
    next[index] = normalized;
  } else {
    next.push(normalized);
  }
  return next;
}


export function dedupeGatewayProfiles(profiles: unknown) {
  const byId = new Map<string, DashboardGatewayProfileRecord>();
  const list = Array.isArray(profiles) ? profiles : [];
  for (const profile of list) {
    const normalized = normalizeGatewayProfile(profile);
    if (normalized) {
      byId.set(normalized.id, normalized);
    }
  }
  return Array.from(byId.values());
}


export function activeGatewayProfileId(config: LabAgentConfig | { lab?: { activeGatewayProfile?: string; gatewayProtocol?: string; gatewayUrl?: string } }) {
  const explicit = String(config?.lab?.activeGatewayProfile ?? "").trim();
  if (explicit) {
    return explicit;
  }
  return gatewayProfileIdFromParts(config?.lab?.gatewayProtocol, config?.lab?.gatewayUrl);
}


export function gatewayProfileIdFromParts(protocol: unknown, gatewayUrl: unknown) {
  const normalizedProtocol = String(protocol ?? "openai-chat").trim();
  const normalizedUrl = canonicalGatewayEndpointUrl(gatewayUrl, normalizedProtocol);
  const raw = `${normalizedProtocol}|${normalizedUrl}`;
  if (!String(gatewayUrl ?? "").trim()) {
    return "";
  }
  return `gw-${createHash("sha1").update(raw).digest("hex").slice(0, 12)}`;
}


export function gatewayProfileLabel(gatewayUrl: unknown, protocol: unknown) {
  const host = urlHost(gatewayUrl);
  if (host) {
    return host;
  }
  return String(protocol ?? "openai-chat");
}


export function buildReplacementAgentConfig(local: Record<string, unknown>, normalized: ModelConfigNormalized) {
  const modelTiers: Record<string, string> = {};
  for (const tier of ["cheap", "default", "strong"]) {
    modelTiers[tier] = normalized.model.id;
  }
  const visionModel = String(normalized.visionAgentModel ?? "").trim();
  const modalities = Array.isArray(normalized.model.modalities) ? normalized.model.modalities : [];
  if (visionModel && visionModel === normalized.model.id && modalities.includes("image")) {
    modelTiers.vision = visionModel;
    return {
      ...(isPlainObject(local.agents) ? local.agents : {}),
      modelTiers,
      vision: {
        enabled: true,
        model: visionModel,
        autoUseWhenMainModelTextOnly: true
      }
    };
  }
  return {
    ...(isPlainObject(local.agents) ? local.agents : {}),
    modelTiers,
    vision: {
      enabled: false,
      model: null,
      autoUseWhenMainModelTextOnly: true
    }
  };
}


export function buildLocalAgentModelTiersConfig(local: Record<string, unknown>, config: Record<string, unknown>, agentModelTiers: unknown) {
  return {
    ...local,
    agents: {
      ...asRecord(local.agents),
      modelTiers: {
        ...asRecord(asRecord(config.agents).modelTiers),
        ...asRecord(asRecord(local.agents).modelTiers),
        ...normalizeAgentModelTiers(agentModelTiers)
      }
    }
  };
}


export function modelConfigEntry(model: LabModel | Record<string, unknown>): DashboardModelConfigEntry {
  const entry: DashboardModelConfigEntry = {
    id: String(model.id ?? ""),
    label: model.label != null ? String(model.label) : undefined,
    description: model.description != null ? String(model.description) : undefined,
    thinking: model.thinking === true,
    modalities: Array.isArray(model.modalities) && model.modalities.length > 0 ? model.modalities.map(String) : ["text"]
  };
  if (typeof model.contextTokens === "number" && Number.isFinite(model.contextTokens) && model.contextTokens > 0) {
    entry.contextTokens = model.contextTokens;
  }
  if (model.reasoningContentMode) {
    entry.reasoningContentMode = model.reasoningContentMode;
  }
  const reasoningEfforts = normalizeReasoningEfforts(model.reasoningEfforts);
  if (reasoningEfforts.length > 0) {
    entry.reasoningEfforts = reasoningEfforts;
  }
  if (reasoningEfforts.some((effort: { id?: string; default?: boolean }) => effort.id === model.defaultReasoningEffort)) {
    entry.defaultReasoningEffort = model.defaultReasoningEffort;
  }
  if (model.openaiExtraBody) {
    entry.openaiExtraBody = model.openaiExtraBody;
  }
  const agentModelTiers = normalizeAgentModelTiers(model.agentModelTiers);
  if (Object.keys(agentModelTiers).length > 0) {
    entry.agentModelTiers = agentModelTiers;
  }
  return entry;
}


export function upsertModelEntry(models: Array<Record<string, unknown>>, model: Record<string, unknown>) {
  const next = modelConfigEntry(model);
  const index = models.findIndex((item) => item.id === next.id);
  if (index >= 0) {
    const merged = { ...models[index], ...next };
    if (typeof model.contextTokens !== "number" || !Number.isFinite(model.contextTokens) || model.contextTokens <= 0) {
      delete merged.contextTokens;
    }
    if (normalizeReasoningEfforts(model.reasoningEfforts).length === 0) {
      delete merged.reasoningEfforts;
      delete merged.defaultReasoningEffort;
    } else if (!normalizeReasoningEfforts(model.reasoningEfforts).some((effort: { id?: string; default?: boolean }) => effort.id === model.defaultReasoningEffort)) {
      delete merged.defaultReasoningEffort;
    }
    if (Object.keys(normalizeAgentModelTiers(model.agentModelTiers)).length === 0) {
      delete merged.agentModelTiers;
    }
    models[index] = merged;
  } else {
    models.push(next);
  }
}


export function parseConfigUrl(value: unknown) {
  if (typeof value !== "string" && !(value instanceof URL)) {
    return null;
  }
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** @param {unknown} value */


/** @param {unknown} value */
export function publicGatewayUrl(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const parsed = parseConfigUrl(raw);
  if (!parsed) {
    return raw.replace(/([?&](?:access_token|api_key|key|token|authorization)=)[^&#]*/gi, "$1[redacted]");
  }
  parsed.username = "";
  parsed.password = "";
  const query = new URLSearchParams();
  for (const [key, queryValue] of parsed.searchParams) {
    query.append(key, SENSITIVE_GATEWAY_QUERY_KEYS.has(key.toLowerCase()) ? "[redacted]" : queryValue);
  }
  parsed.search = query.toString();
  return parsed.href;
}


export function urlHost(value: unknown) {
  return parseConfigUrl(value)?.hostname ?? "";
}


export function positiveIntegerOrNull(value: unknown) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}
