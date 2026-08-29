import { projectLegacyRuntimeConfig } from "./legacy-projection.js";

const UNRESOLVED_CODE = "SESSION_MODEL_SELECTION_UNRESOLVED";

/**
 * Resolve persisted session metadata against the currently configured V2
 * providers. This function is deliberately pure so history readers can show
 * an unresolved marker without turning metadata inspection into a resume.
 *
 * @param {Record<string, any>} config
 * @param {Record<string, any>} metadata
 * @returns {Record<string, any>}
 */
export function resolveSessionModelSelection(config, metadata = {}) {
  if (config?.configV2?.enabled !== true) {
    return { status: "legacy", selection: null, source: "legacy-config" };
  }

  const providers = configuredProviders(config);
  const persisted = normalizePersistedSelection(metadata.modelSelection);
  if (persisted.ok) {
    return validateSelection(providers, persisted.selection, {
      source: "modelSelection",
      model: persisted.selection.model
    });
  }
  if (metadata.metadataVersion === 2
    || (metadata.modelSelection !== undefined && metadata.modelSelection !== null)) {
    return unresolved(
      persisted.reason,
      persisted.model || cleanIdentifier(metadata.model),
      persisted.selection
    );
  }

  const legacyModel = cleanIdentifier(metadata.model);
  if (!legacyModel) {
    return unresolved("legacy-no-match", "");
  }
  const owners = Object.entries(providers)
    .filter(([, provider]) => selectableModels(provider).some((model) => model.id === legacyModel))
    .map(([provider]) => provider);
  if (owners.length === 0) {
    return unresolved("legacy-no-match", legacyModel);
  }
  if (owners.length !== 1) {
    return {
      ...unresolved("ambiguous", legacyModel),
      candidates: owners.slice().sort()
    };
  }
  return {
    status: "resolved",
    source: "legacy-model",
    selection: { provider: owners[0], model: legacyModel }
  };
}

/**
 * Materialize a detached runtime config for one already-resolved atomic
 * selection. The returned public selection contains identifiers only.
 *
 * @param {Record<string, any>} config
 * @param {Record<string, any>} selection
 * @returns {Record<string, any>}
 */
export function applyRuntimeModelSelection(config, selection) {
  if (config?.configV2?.enabled !== true) {
    return { status: "legacy", config, selection: null, source: "legacy-config" };
  }
  const validated = validateSelection(configuredProviders(config), selection, {
    source: "runtime",
    model: cleanIdentifier(selection?.model)
  });
  if (validated.status !== "resolved") return validated;

  const canonicalProvider = v2Providers(config)[validated.selection.provider];
  const canonicalModel = selectableModels(canonicalProvider).find((item) => (
    item.id === validated.selection.model
  ));
  if (!canonicalModel) {
    const profile = gatewayProfiles(config).find((item) => item.id === validated.selection.provider);
    if (!profile) return unresolved("missing-provider", validated.selection.model, validated.selection);
    return {
      status: "resolved",
      source: validated.source,
      selection: validated.selection,
      config: materializeRuntimeProfileSelection(config, profile, validated.selection)
    };
  }

  const resolved = config.configV2.resolved;
  const scopedSnapshot = {
    settingsVersion: 2,
    namespaces: {
      "model-providers": resolved.namespaces["model-providers"],
      "default-model": { selection: validated.selection },
      ...scopedAgentRoutingNamespace(
        resolved.namespaces["agent-routing"],
        validated.selection.provider
      )
    },
    provenance: resolved.provenance ?? {}
  };
  const projection = projectLegacyRuntimeConfig(scopedSnapshot);
  const runtimeAgents = mergeRuntimeAgentRouting(canonicalProvider?.agents, projection.agents);
  const existingProfiles = gatewayProfiles(config);
  const projectedProfiles = projection.lab.gatewayProfiles.map((/** @type {Record<string, any>} */ profile) => {
    const existing = existingProfiles.find((/** @type {Record<string, any>} */ item) => item.id === profile.id);
    return existing?.gatewayApiKey
      ? { ...profile, gatewayApiKey: existing.gatewayApiKey }
      : profile;
  });
  const activeProfile = projectedProfiles.find((/** @type {Record<string, any>} */ profile) => (
    profile.id === validated.selection.provider
  ));
  const currentLab = config.lab ?? {};
  const nextLab = {
    ...currentLab,
    ...projection.lab,
    gatewayProfiles: projectedProfiles,
    gatewayApiKey: activeProfile?.gatewayApiKey ?? null,
    gatewayApiKeyDisabled: activeProfile?.gatewayApiKeyDisabled === true
  };
  for (const key of [
    "gatewayMaxRetries",
    "gatewayTimeoutMs",
    "gatewayIdleTimeoutMs",
    "gatewayMaxResponseBytes"
  ]) {
    if (currentLab[key] !== undefined) nextLab[key] = currentLab[key];
  }

  return {
    status: "resolved",
    source: validated.source,
    selection: validated.selection,
    config: {
      ...config,
      modelAlias: projection.modelAlias,
      defaultModelAlias: projection.defaultModelAlias,
      reasoningEffort: projection.reasoningEffort,
      models: projection.models,
      routingModels: projection.routingModels,
      agents: replaceRuntimeAgentRouting(config.agents, runtimeAgents),
      lab: nextLab
    }
  };
}

/**
 * Capture the effective Config V2 selection from a live session config.
 * Returns null for legacy configurations or internally inconsistent state.
 *
 * @param {Record<string, any>} config
 * @param {{ model?: unknown; reasoningEffort?: unknown }} [overrides]
 * @returns {Record<string, any> | null}
 */
export function currentRuntimeModelSelection(config, overrides = {}) {
  if (config?.configV2?.enabled !== true) return null;
  const provider = cleanIdentifier(config.lab?.activeGatewayProfile)
    || cleanIdentifier(config.configV2.resolved?.namespaces?.["default-model"]?.selection?.provider);
  const model = cleanIdentifier(overrides.model) || cleanIdentifier(config.modelAlias);
  if (!provider || !model) return null;
  const rawEffort = overrides.reasoningEffort !== undefined
    ? overrides.reasoningEffort
    : config.reasoningEffort;
  const selection = {
    provider,
    model,
    ...(cleanIdentifier(rawEffort)?.toLowerCase()
      ? { reasoningEffort: cleanIdentifier(rawEffort).toLowerCase() }
      : {})
  };
  const validated = validateSelection(configuredProviders(config), selection, {
    source: "runtime",
    model
  });
  return validated.status === "resolved" ? validated.selection : null;
}

/**
 * Return a detached metadata document with one atomic selection patch. This
 * preserves transcript and all unrelated session fields for archived-session
 * updates while keeping legacy display fields synchronized.
 *
 * @param {Record<string, any>} metadata
 * @param {Record<string, any>} selection
 * @returns {Record<string, any>}
 */
export function patchSessionModelSelectionMetadata(metadata, selection) {
  const normalized = sanitizeSelection(selection);
  if (!normalized?.provider || !normalized.model) {
    throw Object.assign(new TypeError("modelSelection requires provider and model"), {
      code: "SESSION_MODEL_SELECTION_INVALID"
    });
  }
  return {
    ...(metadata ?? {}),
    metadataVersion: 2,
    model: normalized.model,
    reasoningEffort: normalized.reasoningEffort ?? null,
    modelSelection: normalized
  };
}

/** @param {Record<string, any>} providers @param {Record<string, any>} selection @param {{ source: string; model: string }} details @returns {Record<string, any>} */
function validateSelection(providers, selection, details) {
  const providerId = cleanIdentifier(selection?.provider);
  const modelId = cleanIdentifier(selection?.model);
  if (!providerId || !providers[providerId]) {
    return unresolved("missing-provider", details.model || modelId, sanitizeSelection(selection));
  }
  if (!modelId) {
    return unresolved("missing-model", details.model, sanitizeSelection(selection));
  }
  const model = selectableModels(providers[providerId]).find((item) => item.id === modelId);
  if (!model) {
    return unresolved("missing-model", modelId, sanitizeSelection(selection));
  }

  const effort = cleanIdentifier(selection?.reasoningEffort).toLowerCase();
  if (effort) {
    const efforts = Array.isArray(model.reasoning?.efforts)
      ? model.reasoning.efforts.map((/** @type {Record<string, any>} */ item) => cleanIdentifier(item?.id).toLowerCase()).filter(Boolean)
      : [];
    if (!efforts.includes(effort)) {
      return unresolved("missing-reasoning-effort", modelId, sanitizeSelection(selection));
    }
  }
  return {
    status: "resolved",
    source: details.source,
    selection: {
      provider: providerId,
      model: modelId,
      ...(effort ? { reasoningEffort: effort } : {})
    }
  };
}

/** @param {unknown} value @returns {Record<string, any>} */
function normalizePersistedSelection(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "missing-provider", model: "", selection: null };
  }
  const selection = sanitizeSelection(value);
  if (!selection?.provider) {
    return { ok: false, reason: "missing-provider", model: selection?.model ?? "", selection };
  }
  if (!selection.model) {
    return { ok: false, reason: "missing-model", model: "", selection };
  }
  return { ok: true, selection };
}

/** @param {unknown} value @returns {Record<string, any> | null} */
function sanitizeSelection(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = /** @type {Record<string, any>} */ (value);
  const provider = cleanIdentifier(input.provider);
  const model = cleanIdentifier(input.model);
  const reasoningEffort = cleanIdentifier(input.reasoningEffort).toLowerCase();
  return {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {})
  };
}

/** @param {string} reason @param {string} model @param {Record<string, any> | null} [selection] @returns {Record<string, any>} */
function unresolved(reason, model, selection = null) {
  return {
    status: "unresolved",
    code: UNRESOLVED_CODE,
    reason,
    model: cleanIdentifier(model),
    ...(selection ? { selection } : {})
  };
}

/** @param {Record<string, any>} config @returns {Record<string, any>} */
function configuredProviders(config) {
  const providers = { ...v2Providers(config) };
  for (const profile of gatewayProfiles(config)) {
    const runtimeProvider = providerFromGatewayProfile(profile);
    if (!runtimeProvider) continue;
    const canonical = providers[profile.id];
    if (!canonical) {
      providers[profile.id] = runtimeProvider;
      continue;
    }
    const models = new Map(selectableModels(canonical).map((model) => [model.id, model]));
    for (const model of runtimeProvider.models) models.set(model.id, model);
    providers[profile.id] = { ...canonical, models: [...models.values()] };
  }
  return providers;
}

/** @param {Record<string, any>} config @returns {Record<string, any>} */
function v2Providers(config) {
  const providers = config?.configV2?.resolved?.namespaces?.["model-providers"]?.providers;
  return providers && typeof providers === "object" && !Array.isArray(providers) ? providers : {};
}

/** @param {Record<string, any>} profile @returns {Record<string, any> | null} */
function providerFromGatewayProfile(profile) {
  const id = cleanIdentifier(profile?.id);
  if (!id) return null;
  const models = Array.isArray(profile.models)
    ? profile.models.map((model) => {
        const modelId = cleanIdentifier(model?.id);
        const efforts = Array.isArray(model?.reasoningEfforts)
          ? model.reasoningEfforts
              .map((/** @type {any} */ effort) => ({ id: cleanIdentifier(effort?.id ?? effort).toLowerCase() }))
              .filter((/** @type {{ id: string }} */ effort) => effort.id)
          : [];
        return {
          id: modelId,
          ...(model?.compat ? { compat: { ...model.compat } } : {}),
          ...(efforts.length > 0
            ? {
                reasoning: {
                  efforts,
                  default: efforts.some((/** @type {{ id: string }} */ effort) => effort.id === cleanIdentifier(model?.defaultReasoningEffort).toLowerCase())
                    ? cleanIdentifier(model.defaultReasoningEffort).toLowerCase()
                    : null
                }
              }
            : {})
        };
      }).filter((model) => model.id)
    : [];
  return { models };
}

/** @param {Record<string, any>} config @param {Record<string, any>} profile @param {Record<string, any>} selection */
function materializeRuntimeProfileSelection(config, profile, selection) {
  const models = Array.isArray(profile.models) ? profile.models.map((model) => ({ ...model })) : [];
  const routingModels = Array.isArray(profile.routingModels)
    ? profile.routingModels.map((model) => ({ ...model }))
    : [];
  const profileAgents = profile.agents && typeof profile.agents === "object" && !Array.isArray(profile.agents)
    ? profile.agents
    : {};
  return {
    ...config,
    modelAlias: selection.model,
    defaultModelAlias: selection.model,
    reasoningEffort: selection.reasoningEffort ?? null,
    models,
    routingModels,
    agents: replaceRuntimeAgentRouting(config.agents, profileAgents),
    lab: {
      ...(config.lab ?? {}),
      activeGatewayProfile: profile.id,
      gatewayUrl: profile.gatewayUrl,
      gatewayHealthUrl: profile.gatewayHealthUrl ?? "",
      gatewayProtocol: profile.gatewayProtocol ?? "openai-chat",
      gatewayApiKey: profile.gatewayApiKeyDisabled === true ? null : profile.gatewayApiKey ?? null,
      gatewayApiKeyDisabled: profile.gatewayApiKeyDisabled === true,
      gatewayProfiles: gatewayProfiles(config)
    }
  };
}

/**
 * Legacy runtime routing can address only the active gateway. Keep qualified
 * overrides for that provider and let its local routes fill the remaining
 * tiers; routes owned by another provider must never leak across a switch.
 *
 * @param {unknown} value
 * @param {string} providerId
 * @returns {Record<string, any>}
 */
function scopedAgentRoutingNamespace(value, providerId) {
  if (!isPlainObject(value)) return {};
  const routing = /** @type {Record<string, any>} */ (value);
  /** @type {Record<string, any>} */
  const scoped = {};
  /** @type {Record<string, any>} */
  const modelTiers = {};
  for (const [tier, reference] of Object.entries(
    isPlainObject(routing.modelTiers) ? routing.modelTiers : {}
  )) {
    if (cleanIdentifier(reference?.provider) !== providerId) continue;
    modelTiers[tier] = cloneJsonValue(reference);
  }
  if (Object.keys(modelTiers).length > 0) scoped.modelTiers = modelTiers;

  if (isPlainObject(routing.vision)) {
    const vision = /** @type {Record<string, any>} */ (routing.vision);
    const reference = vision.model;
    if (!reference || cleanIdentifier(reference.provider) === providerId) {
      scoped.vision = cloneJsonValue(vision);
    }
  }
  if (isPlainObject(routing.compat)) scoped.compat = cloneJsonValue(routing.compat);
  return Object.keys(scoped).length > 0 ? { "agent-routing": scoped } : {};
}

/** @param {unknown} providerAgents @param {unknown} projectedAgents */
export function mergeRuntimeAgentRouting(providerAgents, projectedAgents) {
  const base = isPlainObject(providerAgents) ? cloneJsonValue(providerAgents) : {};
  const overlay = isPlainObject(projectedAgents) ? cloneJsonValue(projectedAgents) : {};
  const merged = { ...base, ...overlay };
  for (const key of ["modelTiers", "modelSelections", "vision", "compat"]) {
    if (!isPlainObject(base[key]) && !isPlainObject(overlay[key])) continue;
    merged[key] = {
      ...(isPlainObject(base[key]) ? base[key] : {}),
      ...(isPlainObject(overlay[key]) ? overlay[key] : {})
    };
  }
  return merged;
}

/** @param {unknown} current @param {unknown} routes */
export function replaceRuntimeAgentRouting(current, routes) {
  const next = isPlainObject(current) ? cloneJsonValue(current) : {};
  for (const key of ["modelTiers", "modelSelections", "vision", "compat"]) delete next[key];
  if (!isPlainObject(routes)) return next;
  for (const [key, value] of Object.entries(routes)) next[key] = cloneJsonValue(value);
  return next;
}

/** @param {unknown} value @returns {any} */
function cloneJsonValue(value) {
  return JSON.parse(JSON.stringify(value));
}

/** @param {unknown} value @returns {value is Record<string, any>} */
function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** @param {Record<string, any>} provider @returns {Array<Record<string, any>>} */
function selectableModels(provider) {
  return Array.isArray(provider?.models)
    ? provider.models.filter((model) => model?.compat?.routingOnly !== true)
    : [];
}

/** @param {Record<string, any>} config @returns {Array<Record<string, any>>} */
function gatewayProfiles(config) {
  return Array.isArray(config?.lab?.gatewayProfiles)
    ? config.lab.gatewayProfiles.map((/** @type {Record<string, any>} */ profile) => ({ ...profile }))
    : [];
}

/** @param {unknown} value */
function cleanIdentifier(value) {
  return typeof value === "string" ? value.trim() : "";
}

export const SESSION_MODEL_SELECTION_UNRESOLVED = UNRESOLVED_CODE;
