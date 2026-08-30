import { createHash } from "node:crypto";
import { isV2SettingsDocument } from "./schema.ts";
import { isLegacyGpt56UltraPreset } from "../model-gateway/reasoning-capabilities.ts";

const SETTINGS_VERSION = 2;
const PROVIDERS_NAMESPACE = "model-providers";
const DEFAULT_MODEL_NAMESPACE = "default-model";
const AGENT_ROUTING_NAMESPACE = "agent-routing";

type JsonObject = Record<string, unknown>;

type LegacyCredential = {
  disabled: boolean;
  value: string;
};

type LegacyProfile = {
  id: string;
  displayName: string;
  protocol: string;
  baseURL: string;
  healthURL: string;
  modelAlias: string;
  models: JsonObject[];
  agents: JsonObject;
  credential: LegacyCredential;
};

/**
 * Convert raw V1 global/project documents into V2 settings documents. The
 * importer deliberately never accepts an already-resolved runtime config.
 *
 * @param {{ globalDocument?: Record<string, any>; projectDocument?: Record<string, any> }} input
 */
export function migrateV1Documents(input: { globalDocument?: Record<string, unknown>; projectDocument?: Record<string, unknown> } = {}) {
  const rawGlobal = cloneObject(input.globalDocument);
  const rawProject = cloneObject(input.projectDocument);
  const diagnostics: Array<Record<string, unknown>> = [];
  const credentials: Record<string, string> = {};
  const mapping = { global: {} as Record<string, string>, project: {} as Record<string, string> };

  const globalMigration = migrateRawDocument(rawGlobal, "global", {
    credentials,
    diagnostics,
    mapping: mapping.global,
    inheritedProviders: {}
  });
  const globalProviders = providersFromV2Document(globalMigration.document);
  const projectMigration = migrateRawDocument(rawProject, "project", {
    credentials,
    diagnostics,
    mapping: mapping.project,
    inheritedProviders: globalProviders
  });

  return {
    globalDocument: globalMigration.document,
    projectDocument: projectMigration.document,
    globalRemainder: globalMigration.remainder,
    projectRemainder: projectMigration.remainder,
    credentials,
    mapping,
    diagnostics,
    changed: globalMigration.changed || projectMigration.changed
  };
}

/**
 * @param {Record<string, any>} source
 * @param {"global" | "project"} scope
 * @param {{ credentials: Record<string, string>; diagnostics: any[]; mapping: Record<string, string>; inheritedProviders: Record<string, any> }} context
 */
function migrateRawDocument(source: Record<string, unknown>, scope: "global" | "project", context: { credentials: Record<string, string>; diagnostics: Array<Record<string, unknown>>; mapping: Record<string, string>; inheritedProviders: Record<string, unknown> }) {
  if (isV2SettingsDocument(source)) {
    return { document: source, remainder: {}, changed: false };
  }

  const profiles = legacyProfilesFromDocument(source);
  const providers: Record<string, JsonObject> = {};
  const mappedProfiles = new Map<string, string>();
  for (const profile of profiles) {
    const inherited = scope === "project"
      ? inheritedCloneForProfile(profile, context.inheritedProviders)
      : null;
    if (inherited && !profile.credential.value && !profile.credential.disabled) {
      mappedProfiles.set(profile.id, inherited.id);
      context.mapping[profile.id] = inherited.id;
      context.diagnostics.push({
        code: "PROJECT_PROVIDER_REBASED",
        scope,
        from: profile.id,
        to: inherited.id
      });
      continue;
    }

    let providerId = profile.id;
    const inheritedIdCollision = context.inheritedProviders[providerId];
    if (isPlainObject(inheritedIdCollision) && !sameProviderIdentity(profile, inheritedIdCollision)) {
      providerId = stableProviderId(scope, profile.protocol, profile.baseURL, Object.keys({
        ...context.inheritedProviders,
        ...providers
      } as Record<string, unknown>));
      context.diagnostics.push({
        code: "PROJECT_PROVIDER_ID_RENAMED",
        scope,
        from: profile.id,
        to: providerId
      });
    }
    if (providers[providerId]) {
      throw migrationError(`Duplicate ${scope} provider id: ${providerId}`, "DUPLICATE_PROVIDER_ID");
    }
    mappedProfiles.set(profile.id, providerId);
    context.mapping[profile.id] = providerId;
    const provider = legacyProfileToProvider(profile, providerId, source);
    if (profile.credential.disabled) {
      provider.auth = { mode: "none" };
    } else if (profile.credential.value) {
      const ref = credentialReferenceForProvider(providerId);
      provider.auth = { mode: "credential", ref };
      const existing = context.credentials[ref];
      if (existing && existing !== profile.credential.value) {
        throw migrationError(`Credential reference collision: ${ref}`, "CREDENTIAL_REF_COLLISION");
      }
      context.credentials[ref] = profile.credential.value;
    }
    providers[providerId] = provider;
  }

  const selection = legacySelection(source, profiles, mappedProfiles, context.inheritedProviders);
  const routing = legacyAgentRouting(source, selection, providers, context.inheritedProviders);
  const remainder = stripLegacyModelFields(source);
  const namespaces: JsonObject = {};
  if (Object.keys(providers).length > 0) {
    namespaces[PROVIDERS_NAMESPACE] = { providers };
  }
  if (selection) {
    namespaces[DEFAULT_MODEL_NAMESPACE] = { selection };
  }
  if (routing && (Object.keys(routing.modelTiers ?? {}).length > 0 || routing.vision)) {
    namespaces[AGENT_ROUTING_NAMESPACE] = routing;
  }
  const document = { settingsVersion: SETTINGS_VERSION, namespaces };
  return { document, remainder, changed: true };
}

/** @param {Record<string, any>} source */
function legacyProfilesFromDocument(source: Record<string, unknown>): LegacyProfile[] {
  const lab = isPlainObject(source.lab) ? source.lab : {};
  const configured = Array.isArray(lab.gatewayProfiles) ? lab.gatewayProfiles : [];
  const profiles: LegacyProfile[] = [];
  for (const rawProfile of configured) {
    const normalized = normalizeLegacyProfile(isPlainObject(rawProfile) ? rawProfile : {}, source);
    if (!normalized) continue;
    if (profiles.some((profile) => profile.id === normalized.id)) {
      throw migrationError(`Duplicate V1 provider id: ${normalized.id}`, "DUPLICATE_PROVIDER_ID");
    }
    profiles.push(normalized);
  }

  const topURL = stringValue(lab.gatewayUrl);
  if (topURL) {
    const topProtocol = stringValue(lab.gatewayProtocol) || "openai-chat";
    const endpoint = canonicalEndpoint(topURL, topProtocol);
    const activeId = stringValue(lab.activeGatewayProfile);
    const match = profiles.find((profile) => profile.id === activeId)
      ?? profiles.find((profile) => canonicalEndpoint(profile.baseURL, profile.protocol) === endpoint);
    const topProfile = normalizeLegacyProfile({
      id: match?.id || activeId || stableProviderId("legacy", topProtocol, topURL),
      label: match?.displayName,
      gatewayUrl: topURL,
      gatewayHealthUrl: lab.gatewayHealthUrl,
      gatewayProtocol: topProtocol,
      gatewayApiKey: lab.gatewayApiKey,
      gatewayApiKeyDisabled: lab.gatewayApiKeyDisabled,
      modelAlias: source.modelAlias,
      models: source.models,
      agents: legacyAgentSnapshot(isPlainObject(source.agents) ? source.agents : {})
    }, source);
    if (topProfile) {
      const index = profiles.findIndex((profile) => profile.id === topProfile.id);
      if (index >= 0) {
        profiles[index] = mergeLegacyProfile(profiles[index], topProfile, source);
      } else {
        profiles.push(topProfile);
      }
    }
  }
  return profiles;
}

/** @param {Record<string, any>} raw @param {Record<string, any>} owner */
function normalizeLegacyProfile(raw: Record<string, unknown>, owner: Record<string, unknown>): LegacyProfile | null {
  if (!isPlainObject(raw)) return null;
  const protocol = stringValue(raw.gatewayProtocol) || "openai-chat";
  const baseURL = stringValue(raw.gatewayUrl);
  if (!baseURL) return null;
  const id = stringValue(raw.id) || stableProviderId("legacy", protocol, baseURL);
  const rawModels = Array.isArray(raw.models) ? raw.models : [];
  const models = rawModels
    .map(normalizeLegacyModel)
    .filter((model): model is JsonObject => Boolean(model))
    .map((model) => cleanLegacyGpt56UltraPreset(model, protocol));
  const modelAlias = stringValue(raw.modelAlias) || stringValue(models[0]?.id) || "";
  const credential = legacyCredential(raw, owner, id);
  const endpointName = endpointLabel(baseURL);
  const configuredName = stringValue(raw.label);
  return {
    id,
    displayName: configuredName && configuredName.toLowerCase() !== endpointName.toLowerCase()
      ? configuredName
      : knownProviderName(models) || configuredName || endpointName || id,
    protocol,
    baseURL,
    healthURL: stringValue(raw.gatewayHealthUrl),
    modelAlias,
    models,
    agents: isPlainObject(raw.agents) ? cloneObject(raw.agents) : {},
    credential
  };
}

/** @param {Array<Record<string, any>>} models */
function knownProviderName(models: Array<Record<string, unknown>>) {
  const ids = models.map((model) => stringValue(model.id).toLowerCase());
  if (ids.some((id: string) => id.startsWith("deepseek"))) return "DeepSeek";
  if (ids.some((id: string) => id.startsWith("grok"))) return "Grok";
  if (ids.some((id: string) => id.startsWith("glm"))) return "GLM";
  return "";
}

/** @param {Record<string, any>} base @param {Record<string, any>} top @param {Record<string, any>} owner */
function mergeLegacyProfile(base: LegacyProfile, top: LegacyProfile, owner: Record<string, unknown>): LegacyProfile {
  return {
    ...base,
    ...top,
    displayName: top.displayName || base.displayName,
    healthURL: top.healthURL || base.healthURL,
    models: top.models.length > 0 ? top.models : base.models,
    modelAlias: top.modelAlias || base.modelAlias,
    agents: Object.keys(top.agents).length > 0 ? top.agents : base.agents,
    credential: top.credential.value || top.credential.disabled
      ? top.credential
      : legacyCredential({
          gatewayApiKey: base.credential.value,
          gatewayApiKeyDisabled: base.credential.disabled
        }, owner, base.id)
  };
}

/** @param {unknown} value */
function normalizeLegacyModel(value: unknown) {
  const raw = typeof value === "string" ? { id: value } : value;
  if (!isPlainObject(raw)) return null;
  const id = stringValue(raw.id ?? raw.model);
  if (!id) return null;
  const efforts = Array.isArray(raw.reasoningEfforts)
    ? raw.reasoningEfforts.map((entry) => {
        const effortId = stringValue(isPlainObject(entry) ? entry.id ?? entry.value : entry).toLowerCase();
        if (!effortId) return null;
        return {
          id: effortId,
          ...(isPlainObject(entry) && stringValue(entry.label) ? { label: stringValue(entry.label) } : {}),
          ...(isPlainObject(entry) && stringValue(entry.description) ? { description: stringValue(entry.description) } : {})
        };
      }).filter(Boolean)
    : [];
  const defaultEffort = stringValue(raw.defaultReasoningEffort).toLowerCase();
  return compactObject({
    id,
    displayName: stringValue(raw.label) || id,
    description: stringValue(raw.description) || undefined,
    thinking: raw.thinking === true || efforts.length > 0,
    inputModalities: normalizeModalities(raw.modalities),
    contextWindow: positiveInteger(raw.contextTokens),
    reasoning: efforts.length > 0 ? {
      efforts,
      ...(defaultEffort ? { default: defaultEffort } : {})
    } : undefined,
    reasoningContentMode: stringValue(raw.reasoningContentMode) || undefined,
    openaiExtraBody: isPlainObject(raw.openaiExtraBody) ? cloneObject(raw.openaiExtraBody) : undefined,
    agentModelTiers: isPlainObject(raw.agentModelTiers) ? cloneObject(raw.agentModelTiers) : undefined
  });
}

/** @param {Record<string, any>} model @param {string} protocol */
function cleanLegacyGpt56UltraPreset(model: JsonObject, protocol: string) {
  const reasoning = isPlainObject(model.reasoning) ? model.reasoning : null;
  const effortsValue = reasoning?.efforts;
  if (!isLegacyGpt56UltraPreset(model.id, protocol, Array.isArray(effortsValue) ? effortsValue : undefined)) return model;
  const efforts = (Array.isArray(effortsValue) ? effortsValue : []).filter((effort) => isPlainObject(effort) && effort.id !== "ultra");
  const nextReasoning: JsonObject = { ...(reasoning ?? {}), efforts };
  if (nextReasoning.default === "ultra") delete nextReasoning.default;
  return {
    ...model,
    reasoning: nextReasoning
  };
}

/** @param {Record<string, any>} profile @param {string} providerId @param {Record<string, any>} owner */
function legacyProfileToProvider(profile: LegacyProfile, providerId: string, owner: Record<string, unknown>) {
  const lab = isPlainObject(owner.lab) ? owner.lab : {};
  const reliability = compactObject({
    maxRetries: nonNegativeInteger(lab.gatewayMaxRetries),
    timeoutMs: positiveInteger(lab.gatewayTimeoutMs),
    idleTimeoutMs: positiveInteger(lab.gatewayIdleTimeoutMs),
    maxResponseBytes: positiveInteger(lab.gatewayMaxResponseBytes)
  });
  const provider = compactObject({
    displayName: profile.displayName || providerId,
    transport: compactObject({
      protocol: profile.protocol,
      baseURL: profile.baseURL,
      healthURL: profile.healthURL || undefined
    }),
    auth: { mode: "ambient" },
    models: profile.models,
    agents: Object.keys(profile.agents).length > 0 ? cloneObject(profile.agents) : undefined,
    reliability: Object.keys(reliability).length > 0 ? reliability : undefined
  });
  addRoutingOnlyModels(provider);
  return provider;
}

/**
 * V1 allowed subagent/vision routes that were not selectable main models.
 * Register them explicitly so V2 references remain verifiable, then mark them
 * for the compatibility projection and Dashboard to keep out of main-model
 * selectors.
 *
 * @param {Record<string, any>} provider
 */
function addRoutingOnlyModels(provider: JsonObject) {
  const models = Array.isArray(provider.models) ? provider.models : [];
  const declared = new Set(models.map((model) => isPlainObject(model) ? model.id : undefined));
  const routed = new Set<string>();
  for (const model of models) {
    const agentTiers = isPlainObject(model) && isPlainObject(model.agentModelTiers) ? model.agentModelTiers : {};
    for (const modelId of Object.values(agentTiers)) {
      if (stringValue(modelId)) routed.add(stringValue(modelId));
    }
  }
  const agents = isPlainObject(provider.agents) ? provider.agents : {};
  const modelTiers = isPlainObject(agents.modelTiers) ? agents.modelTiers : {};
  for (const modelId of Object.values(modelTiers)) {
    if (stringValue(modelId)) routed.add(stringValue(modelId));
  }
  const vision = isPlainObject(agents.vision) ? agents.vision : {};
  const visionModel = stringValue(vision.model);
  if (visionModel) routed.add(visionModel);
  for (const modelId of routed) {
    if (declared.has(modelId)) continue;
    models.push({
      id: modelId,
      displayName: modelId,
      compat: { routingOnly: true }
    });
    declared.add(modelId);
  }
  provider.models = models;
}

/**
 * @param {Record<string, any>} source
 * @param {Array<Record<string, any>>} profiles
 * @param {Map<string, string>} mappedProfiles
 * @param {Record<string, any>} inheritedProviders
 */
function legacySelection(source: Record<string, unknown>, profiles: LegacyProfile[], mappedProfiles: Map<string, string>, inheritedProviders: Record<string, unknown>) {
  const lab = isPlainObject(source.lab) ? source.lab : {};
  const selectedLegacyId = stringValue(lab.activeGatewayProfile);
  const selectedProfile = profiles.find((profile) => profile.id === selectedLegacyId)
    ?? profiles.find((profile) => sameProviderEndpoint(profile, {
      protocol: stringValue(lab.gatewayProtocol) || "openai-chat",
      baseURL: stringValue(lab.gatewayUrl)
    }))
    ?? (profiles.length === 1 ? profiles[0] : null)
    ?? null;
  const provider = selectedProfile
    ? mappedProfiles.get(selectedProfile.id) ?? selectedProfile.id
    : selectedLegacyId;
  if (!provider) return null;
  const providerEntry = inheritedProviders[provider];
  const inheritedModels = isPlainObject(providerEntry) && Array.isArray(providerEntry.models) ? providerEntry.models : [];
  const models = selectedProfile?.models ?? inheritedModels;
  const model = stringValue(source.modelAlias)
    || selectedProfile?.modelAlias
    || (isPlainObject(models[0]) ? stringValue(models[0].id) : "")
    || "";
  if (!model) return null;
  const selectedModel = models.find((entry) => isPlainObject(entry) && entry.id === model);
  const explicitlyCleared = Object.prototype.hasOwnProperty.call(source, "reasoningEffort")
    && source.reasoningEffort !== undefined;
  const effort = explicitlyCleared
    ? stringValue(source.reasoningEffort).toLowerCase()
    : stringValue(isPlainObject(selectedModel) && isPlainObject(selectedModel.reasoning) ? selectedModel.reasoning.default : undefined).toLowerCase();
  const selectedReasoning = isPlainObject(selectedModel) && isPlainObject(selectedModel.reasoning) ? selectedModel.reasoning : {};
  const supportedEfforts = new Set((Array.isArray(selectedReasoning.efforts) ? selectedReasoning.efforts : []).map((entry) => isPlainObject(entry) ? entry.id : undefined));
  return compactObject({
    provider,
    model,
    reasoningEffort: supportedEfforts.has(effort) ? effort : undefined
  });
}

/**
 * @param {Record<string, any>} source
 * @param {Record<string, any> | null} selection
 * @param {Record<string, any>} providers
 * @param {Record<string, any>} inheritedProviders
 */
function legacyAgentRouting(source: Record<string, unknown>, selection: Record<string, unknown> | null, providers: Record<string, unknown>, inheritedProviders: Record<string, unknown>) {
  const agents = isPlainObject(source.agents) ? source.agents : {};
  const modelTiers: JsonObject = {};
  const candidateProviders = { ...inheritedProviders, ...providers };
  for (const [tier, model] of Object.entries(isPlainObject(agents.modelTiers) ? agents.modelTiers : {})) {
    const modelId = stringValue(model);
    if (!modelId) continue;
    const provider = providerForModel(candidateProviders, modelId, typeof selection?.provider === "string" ? selection.provider : undefined);
    if (!provider) {
      throw migrationError(`Agent tier ${tier} references ambiguous or missing model ${modelId}`, "AMBIGUOUS_MODEL_REF");
    }
    if (provider !== selection?.provider) continue;
    modelTiers[tier] = { provider, model: modelId };
  }
  const visionModel = stringValue(isPlainObject(agents.vision) ? agents.vision.model : undefined);
  let vision;
  if (visionModel) {
    const provider = providerForModel(candidateProviders, visionModel, typeof selection?.provider === "string" ? selection.provider : undefined);
    if (!provider) {
      throw migrationError(`Vision route references ambiguous or missing model ${visionModel}`, "AMBIGUOUS_MODEL_REF");
    }
    if (provider === selection?.provider) {
      vision = {
        model: { provider, model: visionModel },
        enabled: isPlainObject(agents.vision) ? agents.vision.enabled !== false : true,
        autoUseWhenMainModelTextOnly: isPlainObject(agents.vision) ? agents.vision.autoUseWhenMainModelTextOnly !== false : true
      };
    }
  }
  return compactObject({ modelTiers, vision });
}

/** @param {Record<string, any>} document */
export function stripLegacyModelFields(document: Record<string, unknown>) {
  const next = cloneObject(document);
  delete next.modelAlias;
  delete next.models;
  delete next.reasoningEffort;
  if (isPlainObject(next.lab)) {
    for (const key of [
      "gatewayUrl",
      "gatewayHealthUrl",
      "gatewayProtocol",
      "gatewayApiKey",
      "gatewayApiKeyDisabled",
      "activeGatewayProfile",
      "gatewayProfiles"
    ]) {
      delete next.lab[key];
    }
    if (Object.keys(next.lab).length === 0) delete next.lab;
  }
  if (isPlainObject(next.agents)) {
    delete next.agents.modelTiers;
    if (isPlainObject(next.agents.vision)) {
      delete next.agents.vision.model;
      if (Object.keys(next.agents.vision).length === 0) delete next.agents.vision;
    }
    if (Object.keys(next.agents).length === 0) delete next.agents;
  }
  return next;
}

/** @param {Record<string, any>} profile @param {Record<string, any>} providers */
function inheritedCloneForProfile(profile: LegacyProfile, providers: Record<string, unknown>) {
  for (const [id, provider] of Object.entries(providers)) {
    if (!isPlainObject(provider)) continue;
    if (!sameProviderEndpoint(profile, provider)) continue;
    if (!compatibleProviderModels(profile.models, Array.isArray(provider.models) ? provider.models : [])) continue;
    return { id, ...provider };
  }
  return null;
}

/** @param {Array<Record<string, any>>} left @param {Array<Record<string, any>>} right */
function compatibleProviderModels(left: unknown[], right: unknown[]) {
  const normalize = (models: unknown[]) => models.map((model) => {
    const record = isPlainObject(model) ? model : {};
    const reasoning = isPlainObject(record.reasoning) ? record.reasoning : {};
    return {
      id: record.id,
      thinking: record.thinking === true,
      inputModalities: [...(Array.isArray(record.inputModalities) ? record.inputModalities : ["text"])].sort(),
      contextWindow: record.contextWindow ?? null,
      efforts: (Array.isArray(reasoning.efforts) ? reasoning.efforts : []).map((effort) => isPlainObject(effort) ? effort.id : effort).sort()
    };
  }).sort((a, b) => String(a.id ?? "").localeCompare(String(b.id ?? "")));
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

/** @param {Record<string, any>} left @param {Record<string, any>} right */
function sameProviderIdentity(left: Record<string, unknown>, right: Record<string, unknown>) {
  return sameProviderEndpoint(left, right) && compatibleProviderModels(
    Array.isArray(left.models) ? left.models : [],
    Array.isArray(right.models) ? right.models : []
  );
}

/** @param {Record<string, any>} left @param {Record<string, any>} right */
function sameProviderEndpoint(left: Record<string, unknown>, right: Record<string, unknown>) {
  const leftTransport = isPlainObject(left.transport) ? left.transport : {};
  const rightTransport = isPlainObject(right.transport) ? right.transport : {};
  const leftProtocol = stringValue(left.protocol ?? leftTransport.protocol) || "openai-chat";
  const rightProtocol = stringValue(right.protocol ?? rightTransport.protocol) || "openai-chat";
  const leftURL = stringValue(left.baseURL ?? leftTransport.baseURL);
  const rightURL = stringValue(right.baseURL ?? rightTransport.baseURL);
  return leftProtocol === rightProtocol
    && canonicalEndpoint(leftURL, leftProtocol) === canonicalEndpoint(rightURL, rightProtocol);
}

/** @param {Record<string, any>} providers @param {string} modelId @param {string} preferred */
function providerForModel(providers: Record<string, unknown>, modelId: string, preferred: string = "") {
  const preferredProvider = providers[preferred];
  if (preferred && isPlainObject(preferredProvider) && Array.isArray(preferredProvider.models)
    && preferredProvider.models.some((model) => isPlainObject(model) && model.id === modelId)) {
    return preferred;
  }
  const matches = Object.entries(providers)
    .filter(([, provider]) => isPlainObject(provider) && Array.isArray(provider.models)
      && provider.models.some((model) => isPlainObject(model) && model.id === modelId))
    .map(([id]) => id);
  return matches.length === 1 ? matches[0] : "";
}

/** @param {Record<string, any>} raw @param {Record<string, any>} owner @param {string} id */
function legacyCredential(raw: Record<string, unknown>, owner: Record<string, unknown>, id: string) {
  if (raw.gatewayApiKeyDisabled === true) return { disabled: true, value: "" };
  const direct = stringValue(raw.gatewayApiKey);
  if (direct) return { disabled: false, value: direct };
  const lab = isPlainObject(owner.lab) ? owner.lab : {};
  if (stringValue(lab.activeGatewayProfile) === id) {
    if (lab.gatewayApiKeyDisabled === true) return { disabled: true, value: "" };
    const top = stringValue(lab.gatewayApiKey);
    if (top) return { disabled: false, value: top };
  }
  return { disabled: false, value: "" };
}

/** @param {Record<string, any>} document */
function providersFromV2Document(document: Record<string, unknown>) {
  const namespaces = isPlainObject(document.namespaces) ? document.namespaces : {};
  const providerNamespace = isPlainObject(namespaces[PROVIDERS_NAMESPACE]) ? namespaces[PROVIDERS_NAMESPACE] : {};
  const providers = providerNamespace.providers;
  return isPlainObject(providers) ? cloneObject(providers) : {};
}

/** @param {Record<string, any>} agents */
function legacyAgentSnapshot(agents: Record<string, unknown>) {
  if (!isPlainObject(agents)) return {};
  const snapshot: JsonObject = {};
  if (isPlainObject(agents.modelTiers)) snapshot.modelTiers = cloneObject(agents.modelTiers);
  if (isPlainObject(agents.vision)) snapshot.vision = cloneObject(agents.vision);
  return snapshot;
}

/** @param {unknown} values */
function normalizeModalities(values: unknown) {
  const input = Array.isArray(values) ? values : [];
  const normalized = [...new Set(input.map((value) => stringValue(value).toLowerCase()).filter((value) => ["text", "image"].includes(value)))];
  return normalized.length > 0 ? normalized : ["text"];
}

/** @param {string} scope @param {string} protocol @param {string} url @param {string[]} [usedIds] */
function stableProviderId(scope: string, protocol: string, url: string, usedIds: string[] = []) {
  const digest = createHash("sha256")
    .update(`${scope}\n${protocol}\n${canonicalEndpoint(url, protocol)}`, "utf8")
    .digest("hex");
  const used = new Set(usedIds);
  for (let length = 12; length <= digest.length; length += 4) {
    const candidate = `provider-${digest.slice(0, length)}`;
    if (!used.has(candidate)) return candidate;
  }
  throw migrationError("Unable to allocate a unique provider id", "PROVIDER_ID_COLLISION");
}

/** @param {string} value @param {string} protocol */
function canonicalEndpoint(value: string, protocol: string) {
  const text = stringValue(value);
  if (!text) return "";
  try {
    const url = new URL(text);
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return `${protocol}:${url.href}`;
  } catch {
    return `${protocol}:${text.replace(/\/+$/, "")}`;
  }
}

/** @param {string} value */
function endpointLabel(value: string) {
  try {
    return new URL(value).hostname;
  } catch {
    return "";
  }
}

/** @param {string} message @param {string} code */
function migrationError(message: string, code: string) {
  return Object.assign(new Error(message), { code: `CONFIG_V2_${code}` });
}

/** @param {Record<string, any>} value */
function cloneObject(value: unknown): JsonObject {
  return isPlainObject(value) ? JSON.parse(JSON.stringify(value)) as JsonObject : {};
}

/** @param {Record<string, any>} value */
function compactObject(value: JsonObject) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

/** @param {unknown} value */
function stringValue(value: unknown) {
  return String(value ?? "").trim();
}

/** @param {unknown} value */
function positiveInteger(value: unknown) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

/** @param {unknown} value */
function nonNegativeInteger(value: unknown) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : undefined;
}

/** @param {unknown} value */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export const CONFIG_V2_NAMESPACES = Object.freeze({
  providers: PROVIDERS_NAMESPACE,
  defaultModel: DEFAULT_MODEL_NAMESPACE,
  agentRouting: AGENT_ROUTING_NAMESPACE
});

/** @param {string} providerId */
export function credentialReferenceForProvider(providerId: string) {
  const source = String(providerId ?? "").trim();
  const readable = source
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 72) || "PROVIDER";
  const digest = createHash("sha256").update(source, "utf8").digest("hex").slice(0, 12).toUpperCase();
  return `ANTCODE_GATEWAY_${readable}_${digest}`;
}
