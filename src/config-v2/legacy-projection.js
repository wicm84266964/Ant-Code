import { deepFreeze } from "./schema.js";
import {
  inferCatalogReasoning,
  isLegacyGpt56UltraPreset
} from "../model-gateway/reasoning-capabilities.js";

export class ConfigV2LegacyProjectionError extends Error {
  /** @param {string} path @param {string} message */
  constructor(path, message) {
    super(`${path}: ${message}`);
    this.name = "ConfigV2LegacyProjectionError";
    this.code = "CONFIG_V2_LEGACY_PROJECTION_ERROR";
    this.path = path;
  }
}

/**
 * Build a detached, deeply frozen V1-shaped runtime view. This is a one-way
 * compatibility adapter only: it exports no reverse operation and never
 * writes a projected field into a V2 layer.
 *
 * Credential values are intentionally absent. The projection exposes only a
 * credential reference for the runtime credential seam to resolve per call.
 *
 * @param {Readonly<Record<string, any>>} resolved
 * @returns {Readonly<Record<string, any>>}
 */
export function projectLegacyRuntimeConfig(resolved) {
  assertResolvedSnapshot(resolved);
  const providers = resolved.namespaces["model-providers"].providers;
  const selection = resolved.namespaces["default-model"]?.selection ?? null;
  const activeProvider = selection ? providers[selection.provider] : null;
  if (selection && !activeProvider) {
    projectionFailure("$.namespaces.default-model.selection.provider", "selected provider is unavailable");
  }

  const gatewayProfiles = Object.entries(providers).map(([providerId, provider]) => (
    legacyGatewayProfile(providerId, provider, selection)
  ));
  const activeProtocol = activeProvider?.transport?.protocol ?? "";
  const activeModels = activeProvider
    ? selectableModels(activeProvider).map((model) => legacyModel(model, activeProtocol))
    : [];
  const activeRoutingModels = activeProvider
    ? routingModels(activeProvider).map((model) => legacyModel(model, activeProtocol))
    : [];
  const selectedRuntimeModel = activeModels.find((model) => model.id === selection?.model);
  const selectedReasoningEffort = String(selection?.reasoningEffort ?? "").trim().toLowerCase();
  const effectiveReasoningEffort = normalizeRuntimeEffortIds(selectedRuntimeModel?.reasoningEfforts)
    .includes(selectedReasoningEffort)
    ? selectedReasoningEffort
    : null;
  const activeRouting = legacyAgentRouting(
    resolved.namespaces["agent-routing"],
    activeProvider?.agents,
    selection?.provider ?? null
  );
  const reliability = activeProvider?.reliability ?? {};
  const auth = activeProvider?.auth ?? { mode: "none" };
  const projected = {
    modelAlias: selection?.model ?? "",
    defaultModelAlias: selection?.model ?? "",
    reasoningEffort: effectiveReasoningEffort,
    models: activeModels,
    routingModels: activeRoutingModels,
    agents: activeRouting,
    lab: {
      gatewayUrl: activeProvider?.transport?.baseURL ?? null,
      gatewayHealthUrl: activeProvider?.transport?.healthURL ?? null,
      gatewayProtocol: activeProvider?.transport?.protocol ?? "openai-chat",
      gatewayApiKey: null,
      gatewayCredentialMode: auth.mode,
      gatewayCredentialRef: auth.mode === "credential" ? auth.ref : null,
      ...(auth.mode === "none" ? { gatewayApiKeyDisabled: true } : {}),
      gatewayMaxRetries: reliability.maxRetries ?? null,
      gatewayTimeoutMs: reliability.timeoutMs ?? null,
      gatewayIdleTimeoutMs: reliability.idleTimeoutMs ?? null,
      gatewayMaxResponseBytes: reliability.maxResponseBytes ?? null,
      activeGatewayProfile: selection?.provider ?? "",
      gatewayProfiles
    },
    configV2Provenance: cloneJson(resolved.provenance ?? {})
  };
  return deepFreeze(projected);
}

/** @param {string} providerId @param {Record<string, any>} provider @param {Record<string, any> | null} selection */
function legacyGatewayProfile(providerId, provider, selection) {
  const auth = provider.auth ?? { mode: "none" };
  const models = selectableModels(provider);
  const protocol = provider.transport?.protocol ?? "";
  const modelAlias = selection?.provider === providerId
    ? selection.model
    : models[0]?.id ?? "";
  return {
    id: providerId,
    label: provider.displayName,
    gatewayUrl: provider.transport.baseURL,
    gatewayHealthUrl: provider.transport.healthURL ?? "",
    gatewayProtocol: provider.transport.protocol,
    gatewayCredentialMode: auth.mode,
    gatewayCredentialRef: auth.mode === "credential" ? auth.ref : null,
    ...(auth.mode === "none" ? { gatewayApiKeyDisabled: true } : {}),
    modelAlias,
    models: models.map((model) => legacyModel(model, protocol)),
    routingModels: routingModels(provider).map((model) => legacyModel(model, protocol)),
    reliability: cloneJson(provider.reliability ?? {}),
    ...(provider.agents ? { agents: cloneJson(provider.agents) } : {}),
    ...(provider.compat ? { compat: cloneJson(provider.compat) } : {})
  };
}

/** @param {Record<string, any>} provider */
function selectableModels(provider) {
  return /** @type {any[]} */ (provider.models ?? []).filter((model) => model.compat?.routingOnly !== true);
}

/** @param {Record<string, any>} provider */
function routingModels(provider) {
  return /** @type {any[]} */ (provider.models ?? []).filter((model) => model.compat?.routingOnly === true);
}

/** @param {Record<string, any>} model @param {string} protocol */
function legacyModel(model, protocol) {
  const reasoning = runtimeReasoningCapability(model, protocol);
  return {
    id: model.id,
    label: model.displayName ?? model.id,
    ...(model.description !== undefined ? { description: model.description } : {}),
    ...(model.thinking !== undefined || reasoning
      ? { thinking: model.thinking === true || Boolean(reasoning) }
      : {}),
    ...(model.inputModalities !== undefined ? { modalities: cloneJson(model.inputModalities) } : {}),
    ...(model.contextWindow !== undefined ? { contextTokens: model.contextWindow } : {}),
    ...(model.maxOutputTokens !== undefined ? { maxOutputTokens: model.maxOutputTokens } : {}),
    ...(model.reasoningContentMode !== undefined
      ? { reasoningContentMode: model.reasoningContentMode }
      : {}),
    ...(reasoning
      ? {
          reasoningEfforts: cloneJson(reasoning.efforts),
          defaultReasoningEffort: reasoning.default ?? null
        }
      : {}),
    ...(model.openaiExtraBody !== undefined ? { openaiExtraBody: cloneJson(model.openaiExtraBody) } : {}),
    ...(model.agentModelTiers !== undefined ? { agentModelTiers: cloneJson(model.agentModelTiers) } : {}),
    ...(model.compat !== undefined ? { compat: cloneJson(model.compat) } : {})
  };
}

/**
 * Exact, protocol-scoped presets repair incomplete unproven historical
 * declarations at runtime. Confirmed upstream and active-probe declarations
 * remain exact. The persisted V2 document remains untouched.
 *
 * @param {Record<string, any>} model
 * @param {string} protocol
 */
function runtimeReasoningCapability(model, protocol) {
  let storedEfforts = Array.isArray(model.reasoning?.efforts)
    ? cloneJson(model.reasoning.efforts)
    : [];
  const confirmedDiscovery = hasConfirmedReasoningDiscovery(model);
  if (!confirmedDiscovery
    && isLegacyGpt56UltraPreset(model.id, protocol, storedEfforts)) {
    storedEfforts = storedEfforts.filter((effort) => String(effort.id ?? "").toLowerCase() !== "ultra");
  }
  if (confirmedDiscovery) {
    if (storedEfforts.length === 0) return null;
    const requestedDefault = String(model.reasoning?.default ?? "").toLowerCase();
    return {
      efforts: storedEfforts,
      default: storedEfforts.some((effort) => String(effort.id ?? "").toLowerCase() === requestedDefault)
        ? requestedDefault
        : null
    };
  }
  const preset = inferCatalogReasoning({ id: model.id }, { protocol });
  if (preset.reasoningDiscovery.source !== "known-preset") {
    return storedEfforts.length > 0
      ? { efforts: storedEfforts, default: model.reasoning?.default ?? null }
      : null;
  }

  const storedById = new Map(storedEfforts.map((effort) => [String(effort.id ?? "").toLowerCase(), effort]));
  const presetIds = new Set(preset.reasoningEfforts.map((effort) => effort.id));
  const efforts = preset.reasoningEfforts.map((effort) => storedById.get(effort.id) ?? effort);
  for (const effort of storedEfforts) {
    if (!presetIds.has(String(effort.id ?? "").toLowerCase())) efforts.push(effort);
  }
  const requestedDefault = String(model.reasoning?.default ?? "").toLowerCase();
  const defaultEffort = efforts.some((effort) => String(effort.id ?? "").toLowerCase() === requestedDefault)
    ? requestedDefault
    : preset.defaultReasoningEffort;
  return { efforts, default: defaultEffort ?? null };
}

/** @param {Record<string, any>} model */
function hasConfirmedReasoningDiscovery(model) {
  const source = String(model.compat?.reasoningDiscovery?.source ?? "").trim().toLowerCase();
  return ["upstream-metadata", "active-probe", "explicit-probe", "probe", "capability-probe"].includes(source);
}

/** @param {unknown} efforts */
function normalizeRuntimeEffortIds(efforts) {
  if (!Array.isArray(efforts)) return [];
  return efforts.map((effort) => String(effort?.id ?? effort ?? "").trim().toLowerCase()).filter(Boolean);
}

/**
 * @param {Record<string, any> | undefined} routing
 * @param {Record<string, any> | undefined} providerAgents
 * @param {string | null} activeProviderId
 */
function legacyAgentRouting(routing, providerAgents, activeProviderId) {
  if (!routing) return cloneJson(providerAgents ?? {});
  /** @type {Record<string, any>} */
  const modelTiers = {};
  /** @type {Record<string, any>} */
  const modelSelections = {};
  for (const [tier, reference] of Object.entries(routing.modelTiers ?? {})) {
    assertLegacyProvider(reference, activeProviderId, `$.namespaces.agent-routing.modelTiers.${tier}`);
    modelTiers[tier] = reference.model;
    modelSelections[tier] = cloneJson(reference);
  }
  /** @type {Record<string, any>} */
  const projected = {
    ...(Object.keys(modelTiers).length > 0 ? { modelTiers, modelSelections } : {})
  };
  if (routing.vision !== undefined) {
    const vision = cloneJson(routing.vision);
    if (routing.vision.model) {
      assertLegacyProvider(routing.vision.model, activeProviderId, "$.namespaces.agent-routing.vision.model");
      vision.selection = cloneJson(routing.vision.model);
      vision.model = routing.vision.model.model;
    }
    projected.vision = vision;
  }
  if (routing.compat !== undefined) projected.compat = cloneJson(routing.compat);
  return projected;
}

/** @param {Record<string, any>} reference @param {string | null} activeProviderId @param {string} path */
function assertLegacyProvider(reference, activeProviderId, path) {
  if (!activeProviderId) projectionFailure(path, "legacy routing needs an active provider");
  if (reference.provider !== activeProviderId) {
    projectionFailure(
      `${path}.provider`,
      `legacy runtime cannot route provider "${reference.provider}" while "${activeProviderId}" is active`
    );
  }
}

/** @param {unknown} resolved */
function assertResolvedSnapshot(resolved) {
  if (!resolved || typeof resolved !== "object") {
    projectionFailure("$", "expected a resolved Config V2 snapshot");
  }
  const snapshot = /** @type {Record<string, any>} */ (resolved);
  if (snapshot.settingsVersion !== 2) {
    projectionFailure("$", "expected a resolved Config V2 snapshot");
  }
  const providers = snapshot.namespaces?.["model-providers"]?.providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
    projectionFailure("$.namespaces.model-providers.providers", "resolved providers are missing");
  }
}

/** @param {string} path @param {string} message @returns {never} */
function projectionFailure(path, message) {
  throw new ConfigV2LegacyProjectionError(path, message);
}

/** @param {unknown} value @returns {any} */
function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}
