import { applyModelContextBudget, contextTokensForConfig } from "../config/context-budget.ts";
import { projectLegacyRuntimeConfig } from "./legacy-projection.ts";

const UNRESOLVED_CODE = "SESSION_MODEL_SELECTION_UNRESOLVED";

type JsonObject = Record<string, unknown>;

type ConfigV2ModelRef = JsonObject & {
  provider?: string;
  model?: string;
  reasoningEffort?: string;
};

type ConfigV2Model = JsonObject & {
  id?: string;
  reasoning?: { efforts?: Array<JsonObject & { id?: unknown }> };
  compat?: JsonObject & { routingOnly?: boolean };
};

type ConfigV2Provider = JsonObject & {
  models?: ConfigV2Model[];
  agents?: JsonObject;
};

type ConfigV2AgentRouting = JsonObject & {
  modelTiers?: Record<string, ConfigV2ModelRef>;
  vision?: JsonObject & { model?: ConfigV2ModelRef | null };
  compat?: JsonObject;
};

type ConfigV2Namespaces = JsonObject & {
  "model-providers"?: { providers?: Record<string, ConfigV2Provider> };
  "default-model"?: { selection?: ConfigV2ModelRef };
  "agent-routing"?: ConfigV2AgentRouting;
};

type ConfigV2Resolved = {
  namespaces?: ConfigV2Namespaces;
  provenance?: JsonObject;
};

type ConfigV2State = {
  enabled?: boolean;
  resolved?: ConfigV2Resolved | null;
  settingsPaths?: unknown;
  revisions?: unknown;
  defaultSelections?: unknown;
  provenance?: unknown;
};

type LabConfig = {
  activeGatewayProfile?: unknown;
  gatewayProfiles?: unknown;
};

type RuntimeConfig = {
  configV2?: ConfigV2State;
  lab?: LabConfig;
  agents?: unknown;
  modelAlias?: unknown;
  reasoningEffort?: unknown;
};

type GatewayProfile = JsonObject & {
  id: string;
  models?: unknown[];
  routingModels?: unknown[];
  agents?: unknown;
  gatewayUrl?: unknown;
  gatewayHealthUrl?: unknown;
  gatewayProtocol?: unknown;
  gatewayApiKey?: unknown;
  gatewayApiKeyDisabled?: unknown;
};

export type RuntimeModelSelection = {
  provider: string;
  model: string;
  reasoningEffort?: string;
};

type UnresolvedSelection = {
  status: "unresolved";
  code: string;
  reason: string;
  model: string;
  selection?: JsonObject | RuntimeModelSelection | Partial<RuntimeModelSelection>;
  candidates?: string[];
};

type ResolvedSelection = {
  status: "resolved";
  source: string;
  selection: RuntimeModelSelection;
  config?: unknown;
};

type LegacySelection = {
  status: "legacy";
  selection: null;
  source: string;
  config?: unknown;
};

export type SessionModelSelectionResolution = UnresolvedSelection | ResolvedSelection | LegacySelection;

type PersistedSelectionOk = {
  ok: true;
  selection: RuntimeModelSelection;
};

type PersistedSelectionFail = {
  ok: false;
  reason: string;
  model: string;
  selection: Partial<RuntimeModelSelection> | null;
};

const EMPTY_OBJECT: JsonObject = {};
const EMPTY_PROVIDERS: Record<string, ConfigV2Provider> = {};
const EMPTY_MODEL_REFS: Record<string, ConfigV2ModelRef> = {};

function asRecord(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : EMPTY_OBJECT;
}

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Resolve persisted session metadata against the currently configured V2
 * providers. This function is deliberately pure so history readers can show
 * an unresolved marker without turning metadata inspection into a resume.
 *
 * @param {Record<string, any>} config
 * @param {Record<string, any>} metadata
 * @returns {Record<string, any>}
 */
export function resolveSessionModelSelection(
  config: RuntimeConfig = {},
  metadata: Record<string, unknown> = {}
): SessionModelSelectionResolution {
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
export function applyRuntimeModelSelection(
  config: RuntimeConfig = {},
  selection: unknown
) {
  const configV2 = config.configV2;
  if (configV2?.enabled !== true) {
    return { status: "legacy" as const, config, selection: null, source: "legacy-config" };
  }
  const validated = validateSelection(configuredProviders(config), selection, {
    source: "runtime",
    model: cleanIdentifier(asRecord(selection).model)
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
      status: "resolved" as const,
      source: validated.source,
      selection: validated.selection,
      config: materializeRuntimeProfileSelection(config, profile, validated.selection)
    };
  }

  const resolved = configV2.resolved as ConfigV2Resolved;
  const namespaces = resolved.namespaces ?? (EMPTY_OBJECT as ConfigV2Namespaces);
  const scopedSnapshot = {
    settingsVersion: 2,
    namespaces: {
      "model-providers": namespaces["model-providers"],
      "default-model": { selection: validated.selection },
      ...scopedAgentRoutingNamespace(
        namespaces["agent-routing"],
        validated.selection.provider
      )
    },
    provenance: resolved.provenance ?? EMPTY_OBJECT
  };
  const projection = projectLegacyRuntimeConfig(scopedSnapshot);
  const runtimeAgents = mergeRuntimeAgentRouting(canonicalProvider?.agents, projection.agents);
  const existingProfiles = gatewayProfiles(config);
  const projectedProfiles: JsonObject[] = projection.lab.gatewayProfiles.map((profile) => {
    const existing = existingProfiles.find((item) => item.id === profile.id);
    return existing?.gatewayApiKey
      ? { ...asRecord(profile), gatewayApiKey: existing.gatewayApiKey }
      : asRecord(profile);
  });
  const activeProfile = projectedProfiles.find((profile) => (
    profile.id === validated.selection.provider
  ));
  const currentLab = asRecord(config.lab);
  const nextLab: JsonObject = {
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

  const nextConfig = {
    ...config,
    modelAlias: projection.modelAlias,
    defaultModelAlias: projection.defaultModelAlias,
    reasoningEffort: projection.reasoningEffort,
    models: projection.models,
    routingModels: projection.routingModels,
    agents: replaceRuntimeAgentRouting(config.agents, runtimeAgents),
    lab: nextLab
  };
  applyModelContextBudget(nextConfig, config, contextTokensForConfig(nextConfig));
  return {
    status: "resolved" as const,
    source: validated.source,
    selection: validated.selection,
    config: nextConfig
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
export function currentRuntimeModelSelection(
  config: RuntimeConfig = {},
  overrides: { model?: unknown; reasoningEffort?: unknown } = {}
) {
  const configV2 = config.configV2;
  if (configV2?.enabled !== true) return null;
  const provider = cleanIdentifier(config.lab?.activeGatewayProfile)
    || cleanIdentifier(
      configV2.resolved?.namespaces?.["default-model"]?.selection?.provider
    );
  const model = cleanIdentifier(overrides.model) || cleanIdentifier(config.modelAlias);
  if (!provider || !model) return null;
  const rawEffort = overrides.reasoningEffort !== undefined
    ? overrides.reasoningEffort
    : config.reasoningEffort;
  const selection: RuntimeModelSelection = {
    provider,
    model
  };
  const effort = cleanIdentifier(rawEffort)?.toLowerCase();
  if (effort) {
    selection.reasoningEffort = effort;
  }
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
export function patchSessionModelSelectionMetadata(metadata: Record<string, unknown>, selection: Record<string, unknown>) {
  const normalized = sanitizeSelection(selection);
  if (!normalized?.provider || !normalized.model) {
    throw Object.assign(new TypeError("modelSelection requires provider and model"), {
      code: "SESSION_MODEL_SELECTION_INVALID"
    });
  }
  return {
    ...(metadata ?? EMPTY_OBJECT),
    metadataVersion: 2,
    model: normalized.model,
    reasoningEffort: normalized.reasoningEffort ?? null,
    modelSelection: normalized
  };
}

/** @param {Record<string, any>} providers @param {Record<string, any>} selection @param {{ source: string; model: string }} details @returns {Record<string, any>} */
function validateSelection(
  providers: Record<string, ConfigV2Provider>,
  selection: unknown,
  details: { source: string; model: string }
): SessionModelSelectionResolution {
  const input = asRecord(selection);
  const providerId = cleanIdentifier(input.provider);
  const modelId = cleanIdentifier(input.model);
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

  const effort = cleanIdentifier(input.reasoningEffort).toLowerCase();
  if (effort) {
    const efforts = Array.isArray(model.reasoning?.efforts)
      ? model.reasoning.efforts.map((item) => cleanIdentifier(item?.id).toLowerCase()).filter(Boolean)
      : [];
    if (!efforts.includes(effort)) {
      return unresolved("missing-reasoning-effort", modelId, sanitizeSelection(selection));
    }
  }
  const resolvedSelection: RuntimeModelSelection = {
    provider: providerId,
    model: modelId
  };
  if (effort) {
    resolvedSelection.reasoningEffort = effort;
  }
  return {
    status: "resolved",
    source: details.source,
    selection: resolvedSelection
  };
}

/** @param {unknown} value @returns {Record<string, any>} */
function normalizePersistedSelection(value: unknown): PersistedSelectionOk | PersistedSelectionFail {
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
  return { ok: true, selection: { provider: selection.provider, model: selection.model, ...("reasoningEffort" in selection && selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}) } };
}

/** @param {unknown} value @returns {Record<string, any> | null} */
function sanitizeSelection(value: unknown): Partial<RuntimeModelSelection> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = asRecord(value);
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
function unresolved(
  reason: string,
  model: string,
  selection: JsonObject | RuntimeModelSelection | Partial<RuntimeModelSelection> | null = null
): UnresolvedSelection {
  return {
    status: "unresolved",
    code: UNRESOLVED_CODE,
    reason,
    model: cleanIdentifier(model),
    ...(selection ? { selection } : {})
  };
}

/** @param {Record<string, any>} config @returns {Record<string, any>} */
function configuredProviders(config: RuntimeConfig): Record<string, ConfigV2Provider> {
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
    for (const model of runtimeProvider.models ?? []) models.set(model.id, model);
    providers[profile.id] = { ...canonical, models: [...models.values()] };
  }
  return providers;
}

/** @param {Record<string, any>} config @returns {Record<string, any>} */
function v2Providers(config: RuntimeConfig): Record<string, ConfigV2Provider> {
  const providers = config?.configV2?.resolved?.namespaces?.["model-providers"]?.providers;
  return providers && typeof providers === "object" && !Array.isArray(providers) ? providers : EMPTY_PROVIDERS;
}

/** @param {Record<string, any>} profile @returns {Record<string, any> | null} */
function providerFromGatewayProfile(profile: GatewayProfile): ConfigV2Provider | null {
  const id = cleanIdentifier(profile?.id);
  if (!id) return null;
  const models = Array.isArray(profile.models)
    ? profile.models.map((model) => {
        const source = asRecord(model);
        const modelId = cleanIdentifier(source.id);
        const efforts = Array.isArray(source.reasoningEfforts)
          ? source.reasoningEfforts
              .map((effort) => {
                const entry = isRecord(effort) ? effort : EMPTY_OBJECT;
                return { id: cleanIdentifier(entry.id ?? effort).toLowerCase() };
              })
              .filter((effort) => effort.id)
          : [];
        return {
          id: modelId,
          ...(source.compat ? { compat: { ...asRecord(source.compat) } } : {}),
          ...(efforts.length > 0
            ? {
                reasoning: {
                  efforts,
                  default: efforts.some((effort) => effort.id === cleanIdentifier(source.defaultReasoningEffort).toLowerCase())
                    ? cleanIdentifier(source.defaultReasoningEffort).toLowerCase()
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
function materializeRuntimeProfileSelection(config: RuntimeConfig, profile: GatewayProfile, selection: RuntimeModelSelection) {
  const models = Array.isArray(profile.models) ? profile.models.map((model) => ({ ...asRecord(model) })) : [];
  const routingModels = Array.isArray(profile.routingModels)
    ? profile.routingModels.map((model) => ({ ...asRecord(model) }))
    : [];
  const profileAgents = profile.agents && typeof profile.agents === "object" && !Array.isArray(profile.agents)
    ? profile.agents
    : EMPTY_OBJECT;
  const nextConfig = {
    ...config,
    modelAlias: selection.model,
    defaultModelAlias: selection.model,
    reasoningEffort: selection.reasoningEffort ?? null,
    models,
    routingModels,
    agents: replaceRuntimeAgentRouting(config.agents, profileAgents),
    lab: {
      ...(config.lab ?? EMPTY_OBJECT),
      activeGatewayProfile: profile.id,
      gatewayUrl: profile.gatewayUrl,
      gatewayHealthUrl: profile.gatewayHealthUrl ?? "",
      gatewayProtocol: profile.gatewayProtocol ?? "openai-chat",
      gatewayApiKey: profile.gatewayApiKeyDisabled === true ? null : profile.gatewayApiKey ?? null,
      gatewayApiKeyDisabled: profile.gatewayApiKeyDisabled === true,
      gatewayProfiles: gatewayProfiles(config)
    }
  };
  applyModelContextBudget(nextConfig, config, contextTokensForConfig(nextConfig));
  return nextConfig;
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
function scopedAgentRoutingNamespace(value: unknown, providerId: string): JsonObject {
  if (!isPlainObject(value)) return {};
  const routing = value as ConfigV2AgentRouting;
  const scoped: JsonObject = {};
  const modelTiers: JsonObject = {};
  for (const [tier, reference] of Object.entries(
    isPlainObject(routing.modelTiers) ? routing.modelTiers : EMPTY_MODEL_REFS
  )) {
    if (cleanIdentifier(asRecord(reference).provider) !== providerId) continue;
    modelTiers[tier] = cloneJsonValue(reference);
  }
  if (Object.keys(modelTiers).length > 0) scoped.modelTiers = modelTiers;

  if (isPlainObject(routing.vision)) {
    const vision = routing.vision;
    const reference = vision.model;
    if (!reference || cleanIdentifier(asRecord(reference).provider) === providerId) {
      scoped.vision = cloneJsonValue(vision);
    }
  }
  if (isPlainObject(routing.compat)) scoped.compat = cloneJsonValue(routing.compat);
  return Object.keys(scoped).length > 0 ? { "agent-routing": scoped } : {};
}

/** @param {unknown} providerAgents @param {unknown} projectedAgents */
export function mergeRuntimeAgentRouting(providerAgents: unknown, projectedAgents: unknown) {
  const base = isPlainObject(providerAgents) ? cloneJsonValue(providerAgents) : {};
  const overlay = isPlainObject(projectedAgents) ? cloneJsonValue(projectedAgents) : {};
  const merged: JsonObject = { ...base, ...overlay };
  for (const key of ["modelTiers", "modelSelections", "vision", "compat"]) {
    if (!isPlainObject(base[key]) && !isPlainObject(overlay[key])) continue;
    merged[key] = {
      ...(isPlainObject(base[key]) ? base[key] : EMPTY_OBJECT),
      ...(isPlainObject(overlay[key]) ? overlay[key] : EMPTY_OBJECT)
    };
  }
  return merged;
}

/** @param {unknown} current @param {unknown} routes */
export function replaceRuntimeAgentRouting(current: unknown, routes: unknown) {
  const next = isPlainObject(current) ? cloneJsonValue(current) : {};
  for (const key of ["modelTiers", "modelSelections", "vision", "compat"]) delete next[key];
  if (!isPlainObject(routes)) return next;
  for (const [key, value] of Object.entries(routes)) next[key] = cloneJsonValue(value);
  return next;
}

/** @param {unknown} value @returns {any} */
function cloneJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** @param {unknown} value @returns {value is Record<string, any>} */
function isPlainObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** @param {Record<string, any>} provider @returns {Array<Record<string, any>>} */
function selectableModels(provider: ConfigV2Provider | undefined): ConfigV2Model[] {
  return Array.isArray(provider?.models)
    ? provider.models.filter((model) => model?.compat?.routingOnly !== true)
    : [];
}

/** @param {Record<string, any>} config @returns {Array<Record<string, any>>} */
function gatewayProfiles(config: RuntimeConfig): GatewayProfile[] {
  return Array.isArray(config?.lab?.gatewayProfiles)
    ? config.lab.gatewayProfiles.map((profile) => ({ ...asRecord(profile) }) as GatewayProfile)
    : [];
}

/** @param {unknown} value */
function cleanIdentifier(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export const SESSION_MODEL_SELECTION_UNRESOLVED = UNRESOLVED_CODE;
