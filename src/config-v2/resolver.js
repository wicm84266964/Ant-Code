import {
  CONFIG_V2_RELIABILITY_DEFAULTS,
  CONFIG_V2_SETTINGS_VERSION,
  deepFreeze,
  validateSettingsDocument
} from "./schema.js";

const LAYER_ORDER = Object.freeze(["base", "global", "project", "environment"]);

export class ConfigV2ResolutionError extends Error {
  /** @param {string} code @param {string} path @param {string} message */
  constructor(code, path, message) {
    super(`${path}: ${message}`);
    this.name = "ConfigV2ResolutionError";
    this.code = code;
    this.path = path;
  }
}

/**
 * Resolve raw V2 settings documents without ever writing a merged value back
 * to a source layer. Provider definitions are atomic entries, default model
 * selections are atomic values, and model-tier references are atomic per tier.
 *
 * A global definition may replace an immutable base provider in full. A
 * project or environment definition may not shadow any lower-scope provider;
 * those scopes must choose a distinct route id. In particular, a global and
 * project provider with the same id always fail loudly.
 *
 * @param {{ base?: unknown; global?: unknown; project?: unknown; environment?: unknown }} [input]
 * @returns {Readonly<Record<string, any>>}
 */
export function resolveSettingsLayers(input = {}) {
  const layers = {
    base: layerDocument(input.base, "base"),
    global: layerDocument(input.global, "global"),
    project: layerDocument(input.project, "project"),
    environment: layerDocument(input.environment, "environment")
  };
  const { providers, sources: providerSources } = resolveProviders(layers);
  const { selection, source: selectionSource } = resolveDefaultSelection(layers);
  const { routing, sources: routingSources } = resolveAgentRouting(
    layers,
    selection?.provider ?? ""
  );

  validateResolvedProviders(providers);
  validateLayerReferences(layers, providerSources, selection?.provider ?? "");
  if (selection) {
    assertResolvedModelReference(selection, providers, "$.namespaces.default-model.selection", {
      allowRoutingOnly: false
    });
    assertReferenceScope(
      selection,
      selectionSource,
      providerSources,
      "$.namespaces.default-model.selection"
    );
  }
  validateResolvedAgentRouting(routing, providers, routingSources, providerSources);

  /** @type {Record<string, any>} */
  const namespaces = {
    "model-providers": { providers }
  };
  if (selection) namespaces["default-model"] = { selection };
  if (Object.keys(routing).length > 0) namespaces["agent-routing"] = routing;

  return deepFreeze({
    settingsVersion: CONFIG_V2_SETTINGS_VERSION,
    namespaces,
    provenance: {
      providers: providerSources,
      defaultModel: selectionSource,
      agentRouting: routingSources
    }
  });
}

/**
 * Validate every raw selection, including values hidden by a higher-precedence
 * selection. Agent routes are optional and transport-bound, so only routes for
 * the resolved active provider are validated; stale routes for prior providers
 * are ignored and later removed by an explicit settings mutation.
 *
 * @param {Record<string, any>} layers
 * @param {Record<string, string>} finalProviderSources
 * @param {string} activeProvider
 */
function validateLayerReferences(layers, finalProviderSources, activeProvider) {
  /** @type {Record<string, any>} */
  const availableProviders = {};
  for (const layerName of LAYER_ORDER) {
    for (const [providerId, provider] of Object.entries(
      layers[layerName].namespaces["model-providers"]?.providers ?? {}
    )) {
      availableProviders[providerId] = materializeProvider(provider);
    }
    const selection = layers[layerName].namespaces["default-model"]?.selection;
    if (selection) {
      assertLayerReference(
        selection,
        layerName,
        availableProviders,
        finalProviderSources,
        `$[${layerName}].namespaces.default-model.selection`,
        false
      );
    }
    const routing = layers[layerName].namespaces["agent-routing"];
    for (const [tier, reference] of Object.entries(routing?.modelTiers ?? {})) {
      if (reference?.provider !== activeProvider) continue;
      assertLayerReference(
        reference,
        layerName,
        availableProviders,
        finalProviderSources,
        `$[${layerName}].namespaces.agent-routing.modelTiers.${tier}`,
        true
      );
    }
    if (routing?.vision?.model) {
      if (routing.vision.model.provider !== activeProvider) continue;
      assertLayerReference(
        routing.vision.model,
        layerName,
        availableProviders,
        finalProviderSources,
        `$[${layerName}].namespaces.agent-routing.vision.model`,
        true
      );
    }
  }
}

/** @param {Record<string, any>} reference @param {string} layerName @param {Record<string, any>} availableProviders @param {Record<string, string>} finalProviderSources @param {string} path @param {boolean} allowRoutingOnly */
function assertLayerReference(
  reference,
  layerName,
  availableProviders,
  finalProviderSources,
  path,
  allowRoutingOnly
) {
  assertReferenceScope(reference, layerName, finalProviderSources, path);
  assertResolvedModelReference(reference, availableProviders, path, { allowRoutingOnly });
}

/** @param {unknown} value @param {string} label */
function layerDocument(value, label) {
  if (value === undefined || value === null) {
    return { settingsVersion: CONFIG_V2_SETTINGS_VERSION, namespaces: {} };
  }
  return validateSettingsDocument(value, { label });
}

/** @param {Record<string, any>} layers */
function resolveProviders(layers) {
  /** @type {Record<string, any>} */
  const providers = {};
  /** @type {Record<string, string>} */
  const sources = {};
  for (const layerName of LAYER_ORDER) {
    const candidates = layers[layerName].namespaces["model-providers"]?.providers ?? {};
    for (const [providerId, rawProvider] of Object.entries(candidates)) {
      const previousSource = sources[providerId];
      if (previousSource) {
        const replacesBase = previousSource === "base" && layerName === "global";
        if (!replacesBase) {
          throw new ConfigV2ResolutionError(
            "CONFIG_V2_PROVIDER_SCOPE_CONFLICT",
            `$[${layerName}].namespaces.model-providers.providers.${providerId}`,
            `provider "${providerId}" is already owned by ${previousSource}; define a distinct provider id instead of shadowing it`
          );
        }
      }
      providers[providerId] = materializeProvider(rawProvider);
      sources[providerId] = layerName;
    }
  }
  return { providers, sources };
}

/** @param {Record<string, any>} provider */
function materializeProvider(provider) {
  return {
    ...cloneJson(provider),
    reliability: {
      ...CONFIG_V2_RELIABILITY_DEFAULTS,
      ...(provider.reliability ?? {})
    }
  };
}

/** @param {Record<string, any>} layers */
function resolveDefaultSelection(layers) {
  let selection = null;
  let source = null;
  for (const layerName of LAYER_ORDER) {
    const candidate = layers[layerName].namespaces["default-model"];
    if (!candidate) continue;
    selection = cloneJson(candidate.selection);
    source = layerName;
  }
  return { selection, source };
}

/** @param {Record<string, any>} layers @param {string} activeProvider */
function resolveAgentRouting(layers, activeProvider) {
  /** @type {Record<string, any>} */
  const modelTiers = {};
  /** @type {Record<string, string>} */
  const tierSources = {};
  let vision;
  let visionSource = null;
  let compat;
  let compatSource = null;
  for (const layerName of LAYER_ORDER) {
    const candidate = layers[layerName].namespaces["agent-routing"];
    if (!candidate) continue;
    for (const [tier, reference] of Object.entries(candidate.modelTiers ?? {})) {
      if (reference?.provider !== activeProvider) continue;
      modelTiers[tier] = cloneJson(reference);
      tierSources[tier] = layerName;
    }
    if (hasOwn(candidate, "vision")) {
      const reference = candidate.vision?.model;
      if (!reference || reference.provider === activeProvider) {
        vision = cloneJson(candidate.vision);
        visionSource = layerName;
      }
    }
    if (hasOwn(candidate, "compat")) {
      compat = cloneJson(candidate.compat);
      compatSource = layerName;
    }
  }
  /** @type {Record<string, any>} */
  const routing = {};
  if (Object.keys(modelTiers).length > 0) routing.modelTiers = modelTiers;
  if (vision !== undefined) routing.vision = vision;
  if (compat !== undefined) routing.compat = compat;
  return {
    routing,
    sources: {
      modelTiers: tierSources,
      vision: visionSource,
      compat: compatSource
    }
  };
}

/** @param {Record<string, any>} providers */
function validateResolvedProviders(providers) {
  for (const [providerId, provider] of Object.entries(providers)) {
    const modelIds = new Set(/** @type {any[]} */ (provider.models).map((model) => model.id));
    for (const [index, model] of provider.models.entries()) {
      for (const [tier, modelId] of Object.entries(model.agentModelTiers ?? {})) {
        if (!modelIds.has(modelId)) {
          referenceFailure(
            `$.namespaces.model-providers.providers.${providerId}.models[${index}].agentModelTiers.${tier}`,
            `model "${modelId}" is not declared by provider "${providerId}"`
          );
        }
      }
    }
    for (const [tier, modelId] of Object.entries(provider.agents?.modelTiers ?? {})) {
      if (!modelIds.has(modelId)) {
        referenceFailure(
          `$.namespaces.model-providers.providers.${providerId}.agents.modelTiers.${tier}`,
          `model "${modelId}" is not declared by provider "${providerId}"`
        );
      }
    }
    const visionModel = provider.agents?.vision?.model;
    if (visionModel && !modelIds.has(visionModel)) {
      referenceFailure(
        `$.namespaces.model-providers.providers.${providerId}.agents.vision.model`,
        `model "${visionModel}" is not declared by provider "${providerId}"`
      );
    }
  }
}

/**
 * @param {Record<string, any>} routing
 * @param {Record<string, any>} providers
 * @param {Record<string, any>} routingSources
 * @param {Record<string, string>} providerSources
 */
function validateResolvedAgentRouting(routing, providers, routingSources, providerSources) {
  for (const [tier, reference] of Object.entries(routing.modelTiers ?? {})) {
    assertResolvedModelReference(reference, providers, `$.namespaces.agent-routing.modelTiers.${tier}`, {
      allowRoutingOnly: true
    });
    assertReferenceScope(
      reference,
      routingSources.modelTiers?.[tier],
      providerSources,
      `$.namespaces.agent-routing.modelTiers.${tier}`
    );
  }
  const visionModel = routing.vision?.model;
  if (visionModel) {
    assertResolvedModelReference(visionModel, providers, "$.namespaces.agent-routing.vision.model", {
      allowRoutingOnly: true
    });
    assertReferenceScope(
      visionModel,
      routingSources.vision,
      providerSources,
      "$.namespaces.agent-routing.vision.model"
    );
  }
}

/**
 * A lower-precedence document must remain valid without providers introduced
 * only by a higher-precedence scope. In particular, a global default cannot
 * point at a project-owned provider.
 *
 * @param {Record<string, any>} reference
 * @param {string | null | undefined} referenceSource
 * @param {Record<string, string>} providerSources
 * @param {string} path
 */
function assertReferenceScope(reference, referenceSource, providerSources, path) {
  const providerSource = providerSources[reference.provider];
  const referenceRank = LAYER_ORDER.indexOf(/** @type {string} */ (referenceSource));
  const providerRank = LAYER_ORDER.indexOf(/** @type {string} */ (providerSource));
  if (referenceRank >= 0 && providerRank > referenceRank) {
    throw new ConfigV2ResolutionError(
      "CONFIG_V2_REFERENCE_SCOPE_ERROR",
      `${path}.provider`,
      `${referenceSource} settings cannot reference provider "${reference.provider}" owned by ${providerSource}`
    );
  }
}

/**
 * @param {Record<string, any>} reference
 * @param {Record<string, any>} providers
 * @param {string} path
 * @param {{ allowRoutingOnly?: boolean }} [options]
 */
function assertResolvedModelReference(reference, providers, path, options = {}) {
  const provider = providers[reference.provider];
  if (!provider) {
    referenceFailure(`${path}.provider`, `provider "${reference.provider}" is not configured`);
  }
  const model = /** @type {any[]} */ (provider.models).find((candidate) => candidate.id === reference.model);
  if (!model) {
    referenceFailure(
      `${path}.model`,
      `model "${reference.model}" is not declared by provider "${reference.provider}"`
    );
  }
  if (model.compat?.routingOnly === true && options.allowRoutingOnly !== true) {
    referenceFailure(`${path}.model`, `model "${reference.model}" is reserved for agent routing`);
  }
  if (reference.reasoningEffort !== undefined) {
    const efforts = new Set(/** @type {any[]} */ (model.reasoning?.efforts ?? []).map((effort) => effort.id));
    if (!efforts.has(reference.reasoningEffort)) {
      referenceFailure(
        `${path}.reasoningEffort`,
        `model "${reference.model}" does not support reasoning effort "${reference.reasoningEffort}"`
      );
    }
  }
}

/** @param {string} path @param {string} message */
function referenceFailure(path, message) {
  throw new ConfigV2ResolutionError("CONFIG_V2_REFERENCE_ERROR", path, message);
}

/** @param {unknown} value @returns {any} */
function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

/** @param {Record<string, any>} value @param {string} key */
function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}
