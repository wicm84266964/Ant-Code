import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseModelList, type LabModel } from "../model-gateway/models.ts";
import { DEFAULT_GATEWAY_MAX_RESPONSE_BYTES } from "../model-gateway/limits.ts";
import { recommendedMcpServers } from "../mcp/recommended.ts";
import { validateHookConfig } from "../hooks/registry.ts";
import { createCredentialStore } from "../credentials/store.ts";
import { createFileRepository } from "../config-v2/file-repository.ts";
import { projectLegacyRuntimeConfig } from "../config-v2/legacy-projection.ts";
import { stripLegacyModelFields } from "../config-v2/migrate-v1.ts";
import {
  credentialsPath,
  globalLegacyConfigPath,
  globalSettingsPath,
  projectLegacyConfigPath,
  projectSettingsPath
} from "../config-v2/paths.ts";
import { resolveSettingsLayers } from "../config-v2/resolver.ts";
import { mergeRuntimeAgentRouting, replaceRuntimeAgentRouting } from "../config-v2/runtime-selection.ts";
import {
  GOAL_ABS_MAX_AUTO_CONTINUES,
  GOAL_MAX_AUTO_CONTINUES,
  GOAL_MIN_AUTO_CONTINUES
} from "../core/goal.ts";
import { EMPTY_JSON, DEFAULT_CONFIG, BUNDLED_CONFIG_PATH, GATEWAY_PROTOCOLS, NETWORK_MODES, type JsonObject, type LabAgentConfig, type ConfigLayerSnapshot, type ConfigSources } from "./defaults.ts";
import { isPlainObject, cloneJsonObject, parseHost, parseHostList, parseBoolean, parseOptionalPositiveInteger } from "./validate.ts";

export function mergeConfig<T>(base: T, overlay: unknown): T {
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  if (!isPlainObject(overlay)) {
    return result as T;
  }
  for (const [key, value] of Object.entries(overlay)) {
    if (isPlainObject(value) && isPlainObject(result[key])) {
      result[key] = mergeConfig(result[key], value);
    } else {
      result[key] = value;
    }
  }
  return result as T;
}

/**
 * @param {Record<string, any>} base
 * @param {Record<string, any>} overlay
 * @param {{ gatewayProfileIdentity?: "endpoint" | "id" }} [options]
 */
export function mergeConfigWithGatewayCredentialScope<T>(base: T, overlay: unknown, options: { gatewayProfileIdentity?: "endpoint" | "id" } = {}): T {
  const next = mergeConfig(base, overlay) as T & { lab?: Record<string, unknown> };
  const overlayRecord = isPlainObject(overlay) ? overlay : EMPTY_JSON;
  const overlayLab = isPlainObject(overlayRecord.lab) ? overlayRecord.lab : EMPTY_JSON;
  const disablesCredential = overlayLab.gatewayApiKeyDisabled === true;
  const overlayHasCredential = Boolean(String(overlayLab.gatewayApiKey ?? "").trim());
  const changesEndpoint = Object.prototype.hasOwnProperty.call(overlayLab, "gatewayUrl")
    || Object.prototype.hasOwnProperty.call(overlayLab, "gatewayProtocol");
  const endpointChanged = changesEndpoint
    && (!hasGatewayEndpoint(base) || !sameGatewayEndpoint(base, next));
  if (!disablesCredential && (overlayHasCredential || endpointChanged) && isPlainObject(next.lab)) {
    delete next.lab.gatewayApiKeyDisabled;
  }
  if (disablesCredential) {
    next.lab = {
      ...(isPlainObject(next.lab) ? next.lab : EMPTY_JSON),
      gatewayApiKey: null,
      gatewayApiKeyDisabled: true
    };
  }
  if (hasGatewayEndpoint(next) && sameGatewayEndpoint(base, next)) {
    if (hasGatewayCredential(base) && !hasGatewayCredential(next) && !disablesCredential) {
      next.lab = {
        ...(isPlainObject(next.lab) ? next.lab : EMPTY_JSON),
        gatewayApiKey: (base as { lab?: { gatewayApiKey?: unknown } }).lab?.gatewayApiKey
      };
    }
    if (Array.isArray((base as { models?: unknown }).models) && Array.isArray(overlayRecord.models)) {
      (next as { models?: unknown }).models = mergeModelEntries(
        (base as { models: Array<string | JsonObject> }).models,
        overlayRecord.models.filter((entry): entry is string | JsonObject => typeof entry === "string" || isPlainObject(entry))
      );
    }
  }
  if (Array.isArray(overlayLab.gatewayProfiles)) {
    next.lab = {
      ...(isPlainObject(next.lab) ? next.lab : EMPTY_JSON),
      gatewayProfiles: mergeGatewayProfileEntries(
        Array.isArray((base as { lab?: { gatewayProfiles?: unknown } }).lab?.gatewayProfiles)
          ? (base as { lab: { gatewayProfiles: JsonObject[] } }).lab.gatewayProfiles.filter(isPlainObject)
          : [],
        overlayLab.gatewayProfiles.filter(isPlainObject),
        { identity: options.gatewayProfileIdentity }
      )
    };
  }
  const declaresCredential = Object.prototype.hasOwnProperty.call(overlayLab, "gatewayApiKey") || disablesCredential;
  if (changesEndpoint
    && hasGatewayCredential(base)
    && !declaresCredential
    && (!hasGatewayEndpoint(base) || !sameGatewayEndpoint(base, next))) {
    next.lab = {
      ...(isPlainObject(next.lab) ? next.lab : EMPTY_JSON),
      gatewayApiKey: null
    };
  }
  return next;
}

/**
 * A higher layer that explicitly selects a profile owns the selector. Legacy
 * top-level model/gateway fields instead own the effective snapshot and must
 * not be replaced by an inherited selector from a lower layer.
 *
 * @param {Record<string, any>} config
 * @param {Record<string, any>} highestLayer
 */
export function shouldApplyActiveGatewayProfile(config: Record<string, unknown>, highestLayer: Record<string, unknown>) {
  const configLab = isPlainObject(config.lab) ? config.lab : EMPTY_JSON;
  const profileId = String(configLab.activeGatewayProfile ?? "").trim();
  if (!profileId) {
    return false;
  }
  const layerLab = isPlainObject(highestLayer?.lab) ? highestLayer.lab : EMPTY_JSON;
  if (Object.prototype.hasOwnProperty.call(layerLab, "activeGatewayProfile")) {
    return true;
  }
  const ownsLegacySnapshot = ["modelAlias", "models", "reasoningEffort"]
    .some((key: string) => Object.prototype.hasOwnProperty.call(highestLayer, key))
    || [
      "gatewayUrl",
      "gatewayHealthUrl",
      "gatewayProtocol",
      "gatewayApiKey",
      "gatewayApiKeyDisabled"
    ].some((key: string) => Object.prototype.hasOwnProperty.call(layerLab, key));
  return !ownsLegacySnapshot;
}

/**
 * Resolve the selected profile into the effective runtime fields. Stored
 * profile definitions remain the source of truth; a higher layer may switch
 * profiles by writing only lab.activeGatewayProfile.
 *
 * @param {Record<string, any>} config
 * @param {{ strictProfileId?: boolean; projectedAgentRouting?: unknown; projectedAgentRoutingProviderId?: unknown }} [options]
 */
export function applyActiveGatewayProfileConfig(config: Record<string, unknown>, options: { strictProfileId?: boolean; projectedAgentRouting?: unknown; projectedAgentRoutingProviderId?: unknown } = {}) {
  const lab = isPlainObject(config?.lab) ? config.lab : EMPTY_JSON;
  let profileId = String(lab.activeGatewayProfile ?? "").trim();
  const profiles = Array.isArray(lab.gatewayProfiles) ? lab.gatewayProfiles : [];
  if (!profileId || profiles.length === 0) {
    return config;
  }
  let profile = profiles.find((candidate: unknown) => (
    isPlainObject(candidate) && String(candidate.id ?? "").trim() === profileId
  ));
  if (!profile) {
    if (options.strictProfileId === true) {
      throw new Error(`Configured Config V2 provider is unavailable: ${profileId}`);
    }
    profile = profiles.find((candidate: unknown) => (
      isPlainObject(candidate)
      && sameGatewayProfileEndpoint(candidate, {
        gatewayUrl: lab.gatewayUrl,
        gatewayProtocol: lab.gatewayProtocol
      })
    ));
    if (!profile) {
      return config;
    }
    profileId = String(profile.id ?? "").trim();
  }

  const models = Array.isArray(profile.models) ? cloneJsonObject(profile.models) : [];
  const routingModels = Array.isArray(profile.routingModels) ? cloneJsonObject(profile.routingModels) : [];
  const modelAlias = String(profile.modelAlias ?? "").trim() || modelEntryId(models[0]);
  const nextLab: JsonObject = {
    ...lab,
    gatewayUrl: String(profile.gatewayUrl ?? "").trim() || null,
    gatewayHealthUrl: String(profile.gatewayHealthUrl ?? "").trim() || null,
    gatewayProtocol: String(profile.gatewayProtocol ?? "openai-chat").trim() || "openai-chat",
    activeGatewayProfile: profileId,
    gatewayProfiles: profiles
  };
  if (profile.gatewayApiKeyDisabled === true) {
    nextLab.gatewayApiKey = null;
    nextLab.gatewayApiKeyDisabled = true;
  } else if (String(profile.gatewayApiKey ?? "").trim()) {
    nextLab.gatewayApiKey = profile.gatewayApiKey;
    delete nextLab.gatewayApiKeyDisabled;
  } else {
    nextLab.gatewayApiKey = null;
    delete nextLab.gatewayApiKeyDisabled;
  }

  const endpointChanged = !sameGatewayProfileEndpoint({
    gatewayUrl: lab.gatewayUrl,
    gatewayProtocol: lab.gatewayProtocol
  }, profile);
  const useProjectedRouting = String(options.projectedAgentRoutingProviderId ?? "").trim() === profileId;
  const agents = useProjectedRouting
    ? replaceRuntimeAgentRouting(
        isPlainObject(config.agents) ? config.agents : EMPTY_JSON,
        mergeRuntimeAgentRouting(profile.agents, options.projectedAgentRouting)
      )
    : applyGatewayProfileAgentSelection(isPlainObject(config.agents) ? config.agents : EMPTY_JSON, profile.agents, endpointChanged);
  const gatewayHosts = [
    parseHost(String(nextLab.gatewayUrl ?? "")),
    parseHost(String(nextLab.gatewayHealthUrl ?? ""))
  ].filter(Boolean);
  return {
    ...config,
    modelAlias,
    models,
    routingModels,
    allowedHosts: Array.from(new Set([...(Array.isArray(config.allowedHosts) ? config.allowedHosts : []), ...gatewayHosts])),
    agents,
    lab: nextLab
  };
}

/** @param {unknown} current @param {unknown} selected @param {boolean} endpointChanged */
export function applyGatewayProfileAgentSelection(current: Record<string, unknown>, selected: unknown, endpointChanged: boolean) {
  const agents = isPlainObject(current) ? cloneJsonObject(current) : EMPTY_JSON;
  if (isPlainObject(selected)) {
    if (isPlainObject(selected.modelTiers)) {
      agents.modelTiers = cloneJsonObject(selected.modelTiers);
    } else if (endpointChanged) {
      delete agents.modelTiers;
    }
    if (isPlainObject(selected.vision)) {
      agents.vision = cloneJsonObject(selected.vision);
    } else if (endpointChanged) {
      agents.vision = {
        ...(isPlainObject(agents.vision) ? agents.vision : EMPTY_JSON),
        enabled: false,
        model: null
      };
    }
    return agents;
  }
  if (endpointChanged) {
    delete agents.modelTiers;
    agents.vision = {
      ...(isPlainObject(agents.vision) ? agents.vision : EMPTY_JSON),
      enabled: false,
      model: null
    };
  }
  return agents;
}

/** @param {unknown} value */
export function gatewayProfileAgentSnapshot(value: unknown) {
  if (!isPlainObject(value)) {
    return null;
  }
  const agents: JsonObject = {};
  if (isPlainObject(value.modelTiers)) {
    agents.modelTiers = cloneJsonObject(value.modelTiers);
  }
  if (isPlainObject(value.vision)) {
    agents.vision = cloneJsonObject(value.vision);
  }
  return Object.keys(agents).length > 0 ? agents : null;
}

/**
 * @param {Array<Record<string, any>>} base
 * @param {Array<Record<string, any>>} overlay
 * @param {{ identity?: "endpoint" | "id" }} [options]
 */
export function mergeGatewayProfileEntries(base: Array<Record<string, unknown>>, overlay: Array<Record<string, unknown>>, options: { identity?: "endpoint" | "id" } = {}) {
  if (overlay.length === 0) {
    return [];
  }
  const merged = base.map((profile) => cloneJsonObject(profile));
  for (const rawProfile of overlay) {
    if (!isPlainObject(rawProfile)) {
      continue;
    }
    const profile = cloneJsonObject(rawProfile);
    const id = String(profile.id ?? "").trim();
    const inherited = options.identity === "id"
      ? merged.find((candidate) => id && String(candidate.id ?? "").trim() === id)
      : merged.find((candidate) => sameGatewayProfileEndpoint(candidate, profile));
    if (profile.gatewayApiKeyDisabled === true) {
      profile.gatewayApiKey = null;
    } else if (inherited
      && !String(profile.gatewayApiKey ?? "").trim()
      && String(inherited.gatewayApiKey ?? "").trim()) {
      profile.gatewayApiKey = inherited.gatewayApiKey;
    }
    if (inherited && Array.isArray(inherited.models) && Array.isArray(profile.models)) {
      profile.models = mergeModelEntries(inherited.models, profile.models);
    }
    if (inherited && Array.isArray(inherited.routingModels) && Array.isArray(profile.routingModels)) {
      profile.routingModels = mergeModelEntries(inherited.routingModels, profile.routingModels);
    }
    const retained = merged.filter((candidate) => (
      (options.identity === "id" || !sameGatewayProfileEndpoint(candidate, profile))
      && (!id || String(candidate.id ?? "").trim() !== id)
    ));
    retained.push(profile);
    merged.splice(0, merged.length, ...retained);
  }
  return merged;
}

/**
 * @param {Array<string | Record<string, any>>} base
 * @param {Array<string | Record<string, any>>} overlay
 * @returns {Array<string | Record<string, any>>}
 */
export function mergeModelEntries(base: Array<string | Record<string, unknown>>, overlay: Array<string | Record<string, unknown>>) {
  const merged = [...base];
  /** @type {Map<string, number>} */
  const indexes = new Map();
  for (let index = 0; index < merged.length; index += 1) {
    const id = modelEntryId(merged[index]);
    if (id) {
      indexes.set(id, index);
    }
  }
  for (const model of overlay) {
    const id = modelEntryId(model);
    const index = id ? indexes.get(id) : undefined;
    if (index === undefined) {
      if (id) {
        indexes.set(id, merged.length);
      }
      merged.push(model);
    } else {
      merged[index] = model;
    }
  }
  return merged;
}

/** @param {unknown} model */
export function modelEntryId(model: unknown): string {
  return String(typeof model === "string"
    ? model
    : model && typeof model === "object" && "id" in model
      ? model.id
      : "").trim();
}

/** @param {Record<string, any>} left @param {Record<string, any>} right */
export function sameGatewayProfileEndpoint(left: Record<string, unknown>, right: Record<string, unknown>) {
  if (!String(left?.gatewayUrl ?? "").trim() || !String(right?.gatewayUrl ?? "").trim()) {
    return false;
  }
  return sameGatewayEndpoint(
    { lab: { gatewayUrl: left?.gatewayUrl, gatewayProtocol: left?.gatewayProtocol } },
    { lab: { gatewayUrl: right?.gatewayUrl, gatewayProtocol: right?.gatewayProtocol } }
  );
}

/** @param {Record<string, any>} config */
export function hasGatewayEndpoint(config: unknown) {
  const record = isPlainObject(config) ? config : EMPTY_JSON;
  const lab = isPlainObject(record.lab) ? record.lab : EMPTY_JSON;
  return Boolean(String(lab.gatewayUrl ?? "").trim());
}

/** @param {Record<string, any>} config */
export function hasGatewayCredential(config: unknown) {
  const record = isPlainObject(config) ? config : EMPTY_JSON;
  const lab = isPlainObject(record.lab) ? record.lab : EMPTY_JSON;
  return Boolean(String(lab.gatewayApiKey ?? "").trim());
}

/** @param {Record<string, any>} left @param {Record<string, any>} right */
export function sameGatewayEndpoint(left: unknown, right: unknown) {
  const leftRecord = isPlainObject(left) ? left : EMPTY_JSON;
  const rightRecord = isPlainObject(right) ? right : EMPTY_JSON;
  const leftLab = isPlainObject(leftRecord.lab) ? leftRecord.lab : EMPTY_JSON;
  const rightLab = isPlainObject(rightRecord.lab) ? rightRecord.lab : EMPTY_JSON;
  const leftProtocol = String(leftLab.gatewayProtocol ?? "openai-chat").trim();
  const rightProtocol = String(rightLab.gatewayProtocol ?? "openai-chat").trim();
  return canonicalGatewayEndpointUrl(leftLab.gatewayUrl, leftProtocol)
      === canonicalGatewayEndpointUrl(rightLab.gatewayUrl, rightProtocol)
    && leftProtocol === rightProtocol;
}

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
export function normalizeGatewayInferenceUrl(value: unknown, protocol: string) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  try {
    const url = new URL(text);
    const path = url.pathname.replace(/\/+$/, "");
    const suffix = protocol === "openai-responses"
      ? "/responses"
      : protocol === "openai-chat"
        ? "/chat/completions"
        : protocol === "anthropic-messages" ? "/messages" : "";
    const knownRoute = /\/(models|responses|messages|chat\/completions)$/i;
    const knownBase = path === "" || /^\/$/.test(path) || /\/v\d+(?:beta\d*)?$/i.test(path);
    if (suffix && !path.endsWith(suffix) && (knownRoute.test(path) || knownBase)) {
      url.pathname = knownRoute.test(path)
        ? path.replace(knownRoute, suffix)
        : `${path}${suffix}`;
    } else {
      url.pathname = path || "/";
    }
    url.hash = "";
    return url.href;
  } catch {
    return text;
  }
}

/**
 * @param {{
 *   env: NodeJS.ProcessEnv;
 *   project: any;
 *   lab: any;
 *   bundled: any;
 *   profiles?: Array<Record<string, any>>;
 *   environmentConfig?: Record<string, any>;
 *   finalLab?: Record<string, any>;
 * }} options
 */
export function buildConfigSources({ env, project, lab, bundled, profiles = [], environmentConfig = EMPTY_JSON, finalLab = EMPTY_JSON }: {
  env: NodeJS.ProcessEnv;
  project: ConfigLayerSnapshot | null | undefined;
  lab: ConfigLayerSnapshot | null | undefined;
  bundled: ConfigLayerSnapshot | null | undefined;
  profiles?: Array<JsonObject>;
  environmentConfig?: JsonObject;
  finalLab?: JsonObject;
}): ConfigSources {
  const source = {
    modelAlias: configSourceFor("modelAlias", { env, project, lab, bundled }),
    models: configSourceFor("models", { env, project, lab, bundled }),
    lab: {
      gatewayUrl: configSourceFor("lab.gatewayUrl", { env, project, lab, bundled }),
      gatewayHealthUrl: configSourceFor("lab.gatewayHealthUrl", { env, project, lab, bundled }),
      gatewayProtocol: configSourceFor("lab.gatewayProtocol", { env, project, lab, bundled }),
      gatewayApiKey: configSourceFor("lab.gatewayApiKey", { env, project, lab, bundled }),
      gatewayProfiles: gatewayProfileSources({
        profiles,
        env,
        project,
        lab,
        bundled,
        environmentConfig,
        finalLab
      })
    }
  };
  return source;
}

/**
 * Resolve profile ownership from the original configuration layers. Profile
 * contents in the merged config cannot identify whether an inherited entry is
 * owned by the project or the user-global file.
 *
 * @param {{
 *   profiles: Array<Record<string, any>>;
 *   env: NodeJS.ProcessEnv;
 *   project: any;
 *   lab: any;
 *   bundled: any;
 *   environmentConfig: Record<string, any>;
 *   finalLab: Record<string, any>;
 * }} options
 */
export function gatewayProfileSources({ profiles, env, project, lab, bundled, environmentConfig, finalLab }: {
  profiles: Array<JsonObject>;
  env: NodeJS.ProcessEnv;
  project: ConfigLayerSnapshot | null | undefined;
  lab: ConfigLayerSnapshot | null | undefined;
  bundled: ConfigLayerSnapshot | null | undefined;
  environmentConfig: JsonObject;
  finalLab: JsonObject;
}) {
  const environmentControlsProfile = hasNonEmptyEnv(env, "LAB_AGENT_MODEL")
    || hasNonEmptyEnv(env, "LAB_AGENT_MODELS")
    || hasNonEmptyEnv(env, "LAB_MODEL_GATEWAY_URL")
    || hasNonEmptyEnv(env, "LAB_MODEL_GATEWAY_HEALTH_URL")
    || hasNonEmptyEnv(env, "LAB_MODEL_GATEWAY_PROTOCOL")
    || hasNonEmptyEnv(env, "LAB_MODEL_GATEWAY_API_KEY");
  const environmentLab = isPlainObject(environmentConfig.lab) ? environmentConfig.lab : EMPTY_JSON;
  const environmentProfileId = environmentControlsProfile
    ? String(environmentLab.activeGatewayProfile ?? "").trim()
    : "";
  const environmentProfile = environmentProfileId
    ? (Array.isArray(environmentLab.gatewayProfiles)
      ? environmentLab.gatewayProfiles.filter(isPlainObject).find((profile) => (
          String(profile.id ?? "").trim() === environmentProfileId
        )) ?? null
      : null)
    : null;

  return profiles.map((profile) => {
    const id = String(profile?.id ?? "").trim();
    const active = Boolean(id) && id === String(finalLab?.activeGatewayProfile ?? "").trim();
    const modelScopes = gatewayProfileModelScopes({
      profile,
      active,
      project: project?.data,
      environmentProfile,
      global: lab?.data,
      bundled: bundled?.data
    });
    let owner;
    if (layerOwnsGatewayProfile(project?.data, profile, active)) {
      owner = { id, type: "project", label: ".lab-agent/config.json", path: project?.path ?? null };
    } else if (environmentProfile && sameGatewayProfileIdentity(environmentProfile, profile)) {
      owner = { id, type: "environment", label: "模型网关环境变量" };
    } else if (layerOwnsGatewayProfile(lab?.data, profile, active)) {
      owner = { id, type: "global", label: lab?.label ?? "全局配置", path: lab?.path ?? null };
    } else if (layerOwnsGatewayProfile(bundled?.data, profile, active)) {
      owner = { id, type: "bundled", label: "bundled", path: BUNDLED_CONFIG_PATH };
    } else {
      owner = { id, type: "default", label: "default" };
    }
    return { ...owner, modelScopes };
  });
}

/**
 * @param {{ profile: Record<string, any>; active: boolean; project?: Record<string, any>; environmentProfile?: Record<string, any> | null; global?: Record<string, any>; bundled?: Record<string, any> }} input
 */
export function gatewayProfileModelScopes({ profile, active, project, environmentProfile, global, bundled }: { profile: Record<string, unknown>; active: boolean; project?: Record<string, unknown>; environmentProfile?: Record<string, unknown> | null; global?: Record<string, unknown>; bundled?: Record<string, unknown> }) {
  const scopes: Record<string, string> = {};
  const models = Array.isArray(profile.models) ? profile.models : [];
  for (const model of models) {
    const modelId = modelEntryId(model);
    if (!modelId) continue;
    if (layerOwnsGatewayProfileModel(project, profile, modelId, active)) {
      scopes[modelId] = "project";
    } else if (environmentProfile
      && sameGatewayProfileIdentity(environmentProfile, profile)
      && Array.isArray(environmentProfile.models)
      && environmentProfile.models.some((entry) => modelEntryId(entry) === modelId)) {
      scopes[modelId] = "environment";
    } else if (layerOwnsGatewayProfileModel(global, profile, modelId, active)) {
      scopes[modelId] = "global";
    } else if (layerOwnsGatewayProfileModel(bundled, profile, modelId, active)) {
      scopes[modelId] = "bundled";
    } else {
      scopes[modelId] = "default";
    }
  }
  return scopes;
}

/** @param {Record<string, any> | null | undefined} layer @param {Record<string, any>} profile @param {string} modelId @param {boolean} active */
export function layerOwnsGatewayProfileModel(layer: Record<string, unknown> | null | undefined, profile: Record<string, unknown>, modelId: string, active: boolean) {
  const layerLab = isPlainObject(layer?.lab) ? layer.lab : EMPTY_JSON;
  const declaredProfiles = Array.isArray(layerLab.gatewayProfiles) ? layerLab.gatewayProfiles : [];
  if (declaredProfiles.some((candidate: unknown) => (
    isPlainObject(candidate)
    && sameGatewayProfileIdentity(candidate, profile)
    && Array.isArray(candidate.models)
    && candidate.models.some((entry) => modelEntryId(entry) === modelId)
  ))) {
    return true;
  }
  return active
    && sameGatewayEndpoint(layer ?? EMPTY_JSON, { lab: profile })
    && Array.isArray(layer?.models)
    && layer.models.some((entry) => modelEntryId(entry) === modelId);
}

/** @param {Record<string, any> | null | undefined} layer @param {Record<string, any>} profile @param {boolean} active */
export function layerOwnsGatewayProfile(layer: Record<string, unknown> | null | undefined, profile: Record<string, unknown>, active: boolean) {
  const layerLab = isPlainObject(layer?.lab) ? layer.lab : EMPTY_JSON;
  const declaredProfiles = Array.isArray(layerLab.gatewayProfiles) ? layerLab.gatewayProfiles : [];
  if (declaredProfiles.some((candidate: unknown) => isPlainObject(candidate) && sameGatewayProfileIdentity(candidate, profile))) {
    return true;
  }
  const declaresTopLevelEndpoint = Object.prototype.hasOwnProperty.call(layerLab, "gatewayUrl")
    || Object.prototype.hasOwnProperty.call(layerLab, "gatewayProtocol");
  if (!active || !declaresTopLevelEndpoint) {
    return false;
  }
  if (Object.prototype.hasOwnProperty.call(layerLab, "gatewayUrl")
    && canonicalGatewayEndpointUrl(layerLab.gatewayUrl) !== canonicalGatewayEndpointUrl(profile?.gatewayUrl)) {
    return false;
  }
  if (Object.prototype.hasOwnProperty.call(layerLab, "gatewayProtocol")
    && String(layerLab.gatewayProtocol ?? "openai-chat").trim()
      !== String(profile?.gatewayProtocol ?? "openai-chat").trim()) {
    return false;
  }
  return true;
}

/** @param {Record<string, any>} left @param {Record<string, any>} right */
export function sameGatewayProfileIdentity(left: Record<string, unknown>, right: Record<string, unknown>) {
  const leftId = String(left?.id ?? "").trim();
  const rightId = String(right?.id ?? "").trim();
  return Boolean(leftId && rightId && leftId === rightId) || sameGatewayProfileEndpoint(left, right);
}

/** @param {{ env: NodeJS.ProcessEnv; project: any; lab: any; bundled: any; finalLab: Record<string, any> }} options */
export function activeGatewayCredentialSource({ env, project, lab, bundled, finalLab }: { env: NodeJS.ProcessEnv; project: ConfigLayerSnapshot | null | undefined; lab: ConfigLayerSnapshot | null | undefined; bundled: ConfigLayerSnapshot | null | undefined; finalLab: JsonObject }) {
  const active = { lab: finalLab };
  const projectCredential = explicitLayerGatewayCredential(project?.data, active);
  if (projectCredential) {
    return { type: "project", label: ".lab-agent/config.json", path: project?.path ?? null };
  }
  const projectData = project && isPlainObject(project.data) ? project.data : undefined;
  const projectLab = projectData && isPlainObject(projectData.lab) ? projectData.lab : EMPTY_JSON;
  const projectSelectsActiveEndpoint = (
    Object.prototype.hasOwnProperty.call(projectLab, "gatewayUrl")
    || Object.prototype.hasOwnProperty.call(projectLab, "gatewayProtocol")
  ) && sameGatewayEndpoint(projectData ?? EMPTY_JSON, active);
  if (!String(finalLab?.gatewayApiKey ?? "").trim() && projectSelectsActiveEndpoint) {
    return { type: "project", label: ".lab-agent/config.json", path: project?.path ?? null };
  }
  const environmentEndpoint = hasNonEmptyEnv(env, "LAB_MODEL_GATEWAY_URL")
    ? { lab: { gatewayUrl: env.LAB_MODEL_GATEWAY_URL, gatewayProtocol: env.LAB_MODEL_GATEWAY_PROTOCOL ?? "openai-chat" } }
    : null;
  if (hasNonEmptyEnv(env, "LAB_MODEL_GATEWAY_API_KEY")
    && (!environmentEndpoint || sameGatewayEndpoint(environmentEndpoint, active))
    && String(finalLab?.gatewayApiKey ?? "") === String(env.LAB_MODEL_GATEWAY_API_KEY)) {
    return { type: "environment", label: "LAB_MODEL_GATEWAY_API_KEY", env: "LAB_MODEL_GATEWAY_API_KEY" };
  }
  if (explicitLayerGatewayCredential(lab?.data, active)) {
    return { type: "global", label: lab?.label ?? "全局配置", path: lab?.path ?? null };
  }
  if (explicitLayerGatewayCredential(bundled?.data, active)) {
    return { type: "bundled", label: "bundled", path: BUNDLED_CONFIG_PATH };
  }
  return { type: "default", label: "default" };
}

/** @param {Record<string, any> | null | undefined} config @param {Record<string, any>} active */
export function explicitLayerGatewayCredential(config: Record<string, unknown> | null | undefined, active: Record<string, unknown>) {
  if (!isPlainObject(config?.lab)) {
    return false;
  }
  const lab = config.lab;
  const topHasEndpoint = Boolean(String(lab.gatewayUrl ?? "").trim());
  const topMatches = !topHasEndpoint || sameGatewayEndpoint(config, active);
  if (topMatches && (lab.gatewayApiKeyDisabled === true || Boolean(String(lab.gatewayApiKey ?? "").trim()))) {
    return true;
  }
  const profiles = Array.isArray(lab.gatewayProfiles) ? lab.gatewayProfiles : [];
  return profiles.some((profile) => (
    isPlainObject(profile)
    && isPlainObject(active.lab) && sameGatewayProfileEndpoint(profile, active.lab)
    && (profile.gatewayApiKeyDisabled === true || Boolean(String(profile.gatewayApiKey ?? "").trim()))
  ));
}

export function configSourceFor(keyPath: string, { env, project, lab, bundled }: { env?: NodeJS.ProcessEnv; project?: ConfigLayerSnapshot | null; lab?: ConfigLayerSnapshot | null; bundled?: ConfigLayerSnapshot | null }) {
  const envKey = envKeyForConfigPath(keyPath);
  if (hasConfigPath(project?.data, keyPath)) {
    return {
      type: "project",
      label: ".lab-agent/config.json",
      path: project?.path ?? null
    };
  }
  if (envKey && env && hasNonEmptyEnv(env, envKey)) {
    return {
      type: "environment",
      label: envKey,
      env: envKey
    };
  }
  if (hasConfigPath(lab?.data, keyPath)) {
    return {
      type: "global",
      label: lab?.label ?? "全局配置",
      path: lab?.path ?? null
    };
  }
  if (hasConfigPath(bundled?.data, keyPath)) {
    return {
      type: "bundled",
      label: "bundled",
      path: BUNDLED_CONFIG_PATH
    };
  }
  return {
    type: "default",
    label: "default"
  };
}

export function envKeyForConfigPath(keyPath: string): string {
  return {
    modelAlias: "LAB_AGENT_MODEL",
    models: "LAB_AGENT_MODELS",
    "lab.gatewayUrl": "LAB_MODEL_GATEWAY_URL",
    "lab.gatewayHealthUrl": "LAB_MODEL_GATEWAY_HEALTH_URL",
    "lab.gatewayProtocol": "LAB_MODEL_GATEWAY_PROTOCOL",
    "lab.gatewayApiKey": "LAB_MODEL_GATEWAY_API_KEY"
  }[keyPath] ?? "";
}

export function hasNonEmptyEnv(env: NodeJS.ProcessEnv, key: string): boolean {
  return env[key] !== undefined && env[key] !== null && String(env[key]).trim() !== "";
}

export function hasConfigPath(config: JsonObject | null | undefined, keyPath: string): boolean {
  if (!config || typeof config !== "object") {
    return false;
  }
  let current: unknown = config;
  for (const segment of keyPath.split(".")) {
    if (!current || typeof current !== "object") {
      return false;
    }
    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
      return false;
    }
    current = (current as JsonObject)[segment];
  }
  return current !== undefined && !(typeof current === "string" && current.trim() === "");
}

/**
 * @param {Record<string, any>} value
 * @param {NodeJS.ProcessEnv} env
 * @param {{ preserveConfiguredModels?: boolean; gatewayProfileIdentity?: "endpoint" | "id" }} [options]
 */
export function applyEnvDefaultConfig(value: JsonObject, env: NodeJS.ProcessEnv, options: { preserveConfiguredModels?: boolean; gatewayProfileIdentity?: "endpoint" | "id" } = {}): JsonObject {
  const next: JsonObject = { ...value };
  const previousModelAlias = String(value.modelAlias ?? "").trim();
  const previousGateway = { lab: { ...(isPlainObject(value.lab) ? value.lab : EMPTY_JSON) } };
  const envControlsModel = hasNonEmptyEnv(env, "LAB_AGENT_MODEL") || hasNonEmptyEnv(env, "LAB_AGENT_MODELS");
  const envControlsGateway = hasNonEmptyEnv(env, "LAB_MODEL_GATEWAY_URL")
    || hasNonEmptyEnv(env, "LAB_MODEL_GATEWAY_HEALTH_URL")
    || hasNonEmptyEnv(env, "LAB_MODEL_GATEWAY_PROTOCOL")
    || hasNonEmptyEnv(env, "LAB_MODEL_GATEWAY_API_KEY");

  if (env.LAB_AGENT_MODEL) {
    next.modelAlias = env.LAB_AGENT_MODEL;
    if (String(env.LAB_AGENT_MODEL).trim() !== previousModelAlias) {
      next.reasoningEffort = null;
    }
  }

  if (env.LAB_AGENT_MODELS) {
    next.models = parseModelList(env.LAB_AGENT_MODELS);
  } else if (env.LAB_AGENT_MODEL) {
    next.models = envModelList(next.models, env.LAB_AGENT_MODEL, options.preserveConfiguredModels === true);
  }

  const lab: JsonObject = { ...(isPlainObject(next.lab) ? next.lab : EMPTY_JSON) };
  if (env.LAB_MODEL_GATEWAY_URL) {
    lab.gatewayUrl = env.LAB_MODEL_GATEWAY_URL;
  }
  if (env.LAB_MODEL_GATEWAY_HEALTH_URL) {
    lab.gatewayHealthUrl = env.LAB_MODEL_GATEWAY_HEALTH_URL;
  }
  if (env.LAB_MODEL_GATEWAY_PROTOCOL) {
    if (!GATEWAY_PROTOCOLS.includes(env.LAB_MODEL_GATEWAY_PROTOCOL)) {
      throw new Error(`Unsupported LAB_MODEL_GATEWAY_PROTOCOL: ${env.LAB_MODEL_GATEWAY_PROTOCOL}`);
    }
    lab.gatewayProtocol = env.LAB_MODEL_GATEWAY_PROTOCOL;
  }
  if (lab.gatewayUrl) {
    lab.gatewayUrl = normalizeGatewayInferenceUrl(
      lab.gatewayUrl,
      String(lab.gatewayProtocol ?? "openai-chat").trim() || "openai-chat"
    );
  }
  const environmentGatewayChanged = envControlsGateway
    && !sameGatewayEndpoint(previousGateway, { lab });
  if (env.LAB_MODEL_GATEWAY_API_KEY) {
    lab.gatewayApiKey = env.LAB_MODEL_GATEWAY_API_KEY;
    delete lab.gatewayApiKeyDisabled;
  } else if ((env.LAB_MODEL_GATEWAY_URL || env.LAB_MODEL_GATEWAY_PROTOCOL)
    && !sameGatewayEndpoint(previousGateway, { lab })) {
    lab.gatewayApiKey = null;
    delete lab.gatewayApiKeyDisabled;
  }
  if (environmentGatewayChanged) {
    next.routingModels = [];
    next.agents = replaceRuntimeAgentRouting(isPlainObject(next.agents) ? next.agents : EMPTY_JSON, null);
  }
  if (envControlsModel || envControlsGateway) {
    const environmentProfile = envGatewayProfile({
      modelAlias: next.modelAlias,
      models: next.models,
      routingModels: next.routingModels,
      lab,
      agents: next.agents
    });
    const environmentProfiles = /** @type {Array<Record<string, any>>} */ (
      environmentProfile ? [environmentProfile] : []
    );
    if (environmentProfiles.length > 0) {
      lab.gatewayProfiles = mergeGatewayProfileEntries(
        Array.isArray(lab.gatewayProfiles) ? lab.gatewayProfiles : [],
        environmentProfiles,
        { identity: options.gatewayProfileIdentity }
      );
    }
    lab.activeGatewayProfile = environmentProfiles[0]?.id ?? "";
  }
  next.lab = lab;

  const envGatewayHosts = [
    parseHost(env.LAB_MODEL_GATEWAY_URL ?? ""),
    parseHost(env.LAB_MODEL_GATEWAY_HEALTH_URL ?? "")
  ].filter((host): host is string => Boolean(host));
  if (envGatewayHosts.length > 0) {
    next.allowedHosts = Array.from(new Set([
      ...(Array.isArray(next.allowedHosts) ? next.allowedHosts : []),
      ...envGatewayHosts
    ]));
  }

  return next;
}

export function envGatewayProfile(config: Record<string, unknown>) {
  const lab = isPlainObject(config.lab) ? config.lab : EMPTY_JSON;
  const gatewayProtocol = String(lab.gatewayProtocol ?? "openai-chat").trim() || "openai-chat";
  const gatewayUrl = normalizeGatewayInferenceUrl(lab.gatewayUrl, gatewayProtocol);
  if (!gatewayUrl) {
    return null;
  }
  return {
    id: gatewayProfileIdFromParts(gatewayProtocol, gatewayUrl),
    label: parseHost(gatewayUrl) || gatewayUrl,
    gatewayUrl,
    gatewayHealthUrl: String(lab.gatewayHealthUrl ?? "").trim(),
    gatewayProtocol,
    ...(lab.gatewayApiKey ? { gatewayApiKey: lab.gatewayApiKey } : EMPTY_JSON),
    modelAlias: String(config.modelAlias ?? "").trim(),
    models: Array.isArray(config.models) ? config.models : [],
    routingModels: Array.isArray(config.routingModels) ? config.routingModels : [],
    ...(isPlainObject(config.agents) ? { agents: cloneJsonObject(config.agents) } : EMPTY_JSON)
  };
}

export function envModelList(models: unknown, modelAlias: unknown, preserveConfiguredModels: unknown = false) {
  const id = String(modelAlias ?? "").trim();
  if (!id) {
    return Array.isArray(models) ? models : [];
  }
  const configured = Array.isArray(models) ? models : [];
  const matching = configured.filter((model) => String(typeof model === "string" ? model : isPlainObject(model) ? model.id ?? "" : "").trim() === id);
  if (matching.length > 0) {
    return preserveConfiguredModels ? configured : matching;
  }
  const selected = parseModelList(id);
  return preserveConfiguredModels ? [...selected, ...configured] : selected;
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

/**
 * @param {Record<string, any>} value
 * @param {NodeJS.ProcessEnv} env
 */
export function applyRuntimeEnvConfig(value: unknown, env: NodeJS.ProcessEnv) {
  const next: JsonObject = { ...(isPlainObject(value) ? value : EMPTY_JSON) };

  if (env.LAB_AGENT_NETWORK_MODE) {
    if (!NETWORK_MODES.includes(env.LAB_AGENT_NETWORK_MODE)) {
      throw new Error(`Unsupported LAB_AGENT_NETWORK_MODE: ${env.LAB_AGENT_NETWORK_MODE}`);
    }
    next.networkMode = env.LAB_AGENT_NETWORK_MODE;
  }

  const allowedHosts = parseHostList(env.LAB_AGENT_ALLOWED_HOSTS);
  const runtimeGatewayHosts = [
    parseHost(env.LAB_MODEL_GATEWAY_URL ?? ""),
    parseHost(env.LAB_MODEL_GATEWAY_HEALTH_URL ?? "")
  ].filter(isNonEmptyString);
  if (allowedHosts.length > 0 || runtimeGatewayHosts.length > 0) {
    next.allowedHosts = Array.from(new Set([
      ...(Array.isArray(next.allowedHosts) ? next.allowedHosts : []),
      ...allowedHosts,
      ...runtimeGatewayHosts
    ]));
  }

  if (env.LAB_AGENT_TRANSCRIPT_ENABLED) {
    next.transcript = {
      ...(isPlainObject(next.transcript) ? next.transcript : EMPTY_JSON),
      enabled: parseBoolean(env.LAB_AGENT_TRANSCRIPT_ENABLED)
    };
  }

  if (env.LAB_AGENT_TRANSCRIPT_RETENTION_DAYS) {
    const retentionValue = String(env.LAB_AGENT_TRANSCRIPT_RETENTION_DAYS).trim().toLowerCase();
    next.transcript = {
      ...(isPlainObject(next.transcript) ? next.transcript : EMPTY_JSON),
      retentionDays: ["forever", "permanent", "unlimited"].includes(retentionValue)
        ? null
        : Number.parseInt(retentionValue, 10)
    };
  }

  if (env.LAB_AGENT_TRANSCRIPT_ENCRYPTION) {
    const encryption = env.LAB_AGENT_TRANSCRIPT_ENCRYPTION;
    if (!["off", "optional", "required"].includes(encryption)) {
      throw new Error(`Unsupported LAB_AGENT_TRANSCRIPT_ENCRYPTION: ${encryption}`);
    }
    next.transcript = {
      ...(isPlainObject(next.transcript) ? next.transcript : EMPTY_JSON),
      encryption
    };
  }

  if (env.LAB_AGENT_SENSITIVITY) {
    next.security = {
      ...(isPlainObject(next.security) ? next.security : EMPTY_JSON),
      sensitivity: env.LAB_AGENT_SENSITIVITY
    };
  }

  const context = {
    maxMessages: parseOptionalPositiveInteger(env.LAB_AGENT_CONTEXT_MAX_MESSAGES),
    maxBytes: parseOptionalPositiveInteger(env.LAB_AGENT_CONTEXT_MAX_BYTES),
    maxTokens: parseOptionalPositiveInteger(env.LAB_AGENT_CONTEXT_MAX_TOKENS),
    keepRecentMessages: parseOptionalPositiveInteger(env.LAB_AGENT_CONTEXT_KEEP_RECENT_MESSAGES),
    tailTurns: parseOptionalPositiveInteger(env.LAB_AGENT_CONTEXT_TAIL_TURNS),
    preserveRecentTokens: parseOptionalPositiveInteger(env.LAB_AGENT_CONTEXT_PRESERVE_RECENT_TOKENS),
    summaryBytes: parseOptionalPositiveInteger(env.LAB_AGENT_CONTEXT_SUMMARY_BYTES),
    resumeMaxMessages: parseOptionalPositiveInteger(env.LAB_AGENT_CONTEXT_RESUME_MAX_MESSAGES),
    resumeMaxTokens: parseOptionalPositiveInteger(env.LAB_AGENT_CONTEXT_RESUME_MAX_TOKENS),
    resumeMaxBytes: parseOptionalPositiveInteger(env.LAB_AGENT_CONTEXT_RESUME_MAX_BYTES)
  };
  const contextEntries = Object.entries(context).filter(([, value]) => value !== null);
  if (contextEntries.length > 0) {
    next.context = {
      ...(isPlainObject(next.context) ? next.context : EMPTY_JSON),
      ...Object.fromEntries(contextEntries)
    };
  }

  const limits = {
    maxToolRounds: parseOptionalPositiveInteger(env.LAB_AGENT_MAX_TOOL_ROUNDS),
    agentMaxRounds: parseOptionalPositiveInteger(env.LAB_AGENT_AGENT_MAX_ROUNDS)
  };
  const limitEntries = Object.entries(limits).filter(([, value]) => value !== null);
  if (limitEntries.length > 0) {
    next.limits = {
      ...(isPlainObject(next.limits) ? next.limits : EMPTY_JSON),
      ...(limits.maxToolRounds !== null ? { maxToolRounds: limits.maxToolRounds } : EMPTY_JSON)
    };
    next.agents = {
      ...(isPlainObject(next.agents) ? next.agents : EMPTY_JSON),
      ...(limits.agentMaxRounds !== null ? { maxRounds: limits.agentMaxRounds } : EMPTY_JSON)
    };
  }

  return next;
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
export function isNonEmptyString(value: unknown) {
  return typeof value === "string" && value.length > 0;
}

/**
 * @param {Record<string, any>} config
 */
export function applySensitivityPolicy(config: Record<string, unknown>) {
  const security = isPlainObject(config.security) ? config.security : undefined;
  if (security?.sensitivity !== "high") {
    return config;
  }

  return {
    ...config,
    transcript: {
      ...(isPlainObject(config.transcript) ? config.transcript : EMPTY_JSON),
      retentionDays: 0,
      enabled: false
    }
  };
}

