import { randomUUID } from "node:crypto";
import { CONFIG_V2_NAMESPACES, credentialReferenceForProvider } from "./migrate-v1.ts";
import { isV2SettingsDocument } from "./schema.ts";

type JsonObject = Record<string, unknown>;
const EMPTY_OBJECT: JsonObject = {};

type ConfigV2Model = {
  id?: string;
  compat?: { routingOnly?: boolean; reasoningDiscovery?: unknown };
  reasoning?: { default?: unknown; efforts?: unknown };
  agentModelTiers?: unknown;
  [key: string]: unknown;
};

type ConfigV2Provider = JsonObject & {
  models?: ConfigV2Model[];
  agents?: JsonObject;
  auth?: { mode?: unknown; ref?: unknown };
  displayName?: unknown;
  transport?: JsonObject;
  reliability?: JsonObject;
};

type ConfigV2ModelRef = JsonObject & {
  provider?: unknown;
  model?: unknown;
  reasoningEffort?: unknown;
};

type ConfigV2Namespaces = JsonObject & {
  "model-providers"?: { providers?: Record<string, ConfigV2Provider> };
  "default-model"?: { selection?: ConfigV2ModelRef };
  "agent-routing"?: JsonObject;
};

type ConfigV2Document = JsonObject & {
  settingsVersion?: unknown;
  namespaces: ConfigV2Namespaces;
};

type MutationFailure = {
  ok: false;
  status: number;
  code: string;
  error: string;
};

type CanonicalModelIndex = {
  ok: true;
  canonical: (value: unknown) => string;
};

type CatalogIdsResult = MutationFailure | { ok: true; ids: string[] };
type CatalogModelsResult = MutationFailure | { ok: true; ids: string[]; models: JsonObject[] };
type CatalogMetadataResult = MutationFailure | { ok: true; model: JsonObject };
type CatalogReasoningResult = MutationFailure | { ok: true; efforts: JsonObject[]; defaultEffort: string };
type CatalogModalitiesResult = MutationFailure | { ok: true; values: string[] };
type RoutingModelsResult = MutationFailure | { ok: true; models: ConfigV2Model[]; agents: JsonObject };

/**
 * Upsert one provider-owned model without reading or rewriting an effective
 * runtime config. Existing provider identity is stable even when its endpoint
 * changes.
 *
 * @param {Record<string, any>} document
 * @param {Record<string, any>} input normalized Dashboard model input
 */
export function upsertProviderModel(document: Record<string, unknown>, input: Record<string, unknown>) {
  const next = requireV2Document(document);
  const providers = providerDictionary(next);
  const requestedId = stringValue(input.profileId);
  const providerId = requestedId || `provider-${randomUUID()}`;
  const existing = providers[providerId];
  if (requestedId && !existing) {
    return failure(404, "CONFIG_V2_PROVIDER_NOT_FOUND", "模型来源已被删除或不属于该配置范围");
  }

  const existingModels: Array<{ id?: string; [key: string]: unknown }> = Array.isArray(existing?.models)
    ? existing.models.map(cloneValue)
    : [];
  const endpointChanged = providerEndpointChanged(existing, input);
  const explicitlyReplacingModels = input.replaceModels === true;
  const replacingModels = !existing || explicitlyReplacingModels || endpointChanged;
  const catalog = normalizeCatalogModels(input.catalogModelIds, input.catalogModels);
  if (!catalog.ok) return catalog;
  const catalogIds: string[] = catalog.ids;
  const manualAgentModels = normalizeManualAgentModelIds(input.manualAgentModelIds);
  if (!manualAgentModels.ok) return manualAgentModels;

  const existingIndex = createCanonicalModelIndex(existingModels.map((model) => model.id));
  if (!existingIndex.ok) return existingIndex;
  const requestedPreviousId = stringValue(input.previousModelId);
  const previousModelId = requestedPreviousId ? existingIndex.canonical(requestedPreviousId) : "";
  if (requestedPreviousId && !existingModels.some((model) => stringValue(model.id) === previousModelId)) {
    return failure(404, "CONFIG_V2_MODEL_NOT_FOUND", "要修改的模型已被删除，请刷新设置后重试");
  }

  const canonicalEvidence = createCanonicalModelIndex([
    ...(replacingModels ? [] : existingModels.map((model) => model.id)),
    ...catalogIds
  ]);
  if (!canonicalEvidence.ok) return canonicalEvidence;
  const dashboardModel = dashboardModelToV2(input.model);
  dashboardModel.id = canonicalEvidence.canonical(dashboardModel.id);
  if (!dashboardModel.id) {
    return failure(400, "CONFIG_V2_INVALID_MODEL_ID", "请输入有效的模型 ID");
  }
  const collidingModel = existingModels.find((model) => (
    stringValue(model.id).toLowerCase() === dashboardModel.id.toLowerCase()
    && stringValue(model.id) !== previousModelId
    && stringValue(model.id) !== dashboardModel.id
  ));
  if (!replacingModels && collidingModel) return modelIdCaseCollision(dashboardModel.id, collidingModel.id);
  if (!replacingModels && previousModelId && previousModelId !== dashboardModel.id
    && existingModels.some((model) => stringValue(model.id) === dashboardModel.id)) {
    return failure(409, "CONFIG_V2_MODEL_RENAME_CONFLICT", `模型 ${dashboardModel.id} 已存在，不能覆盖重命名`);
  }

  const preservedModel = existingModels.find((model) => (
    stringValue(model.id) === (previousModelId || dashboardModel.id)
  ));
  let nextModel = promoteRoutingOnlyModel(preserveUnmanagedModelFields(dashboardModel, preservedModel));
  nextModel = reconcileReasoningDiscovery({
    nextModel,
    previousModel: preservedModel,
    catalogModel: catalog.models.find((model) => stringValue(model.id) === nextModel.id),
    endpointChanged
  });
  const retainedModels = endpointChanged && !explicitlyReplacingModels
    ? existingModels.filter((model) => (
        (!isPlainObject(model.compat) || model.compat.routingOnly !== true)
        && catalogIds.includes(stringValue(model.id))
        && (stringValue(model.id) === nextModel.id || stringValue(model.id) !== previousModelId)
      )).map((model) => retainCatalogAgentModelTiers(model, catalogIds, canonicalEvidence))
    : [];
  const routingCanonicalEvidence = createCanonicalModelIndex([
    ...(replacingModels ? retainedModels.map((model) => model.id) : existingModels.map((model) => model.id)),
    ...catalogIds,
    ...manualAgentModels.ids,
    nextModel.id
  ]);
  if (!routingCanonicalEvidence.ok) return routingCanonicalEvidence;
  const endpointAgentModelIds = [...new Set([...catalogIds, ...manualAgentModels.ids, stringValue(nextModel.id)])];
  const agentInput = endpointChanged
    ? retainEndpointAgentInput(input, endpointAgentModelIds, routingCanonicalEvidence)
    : input;
  if (endpointChanged) {
    nextModel = retainCatalogAgentModelTiers(nextModel, endpointAgentModelIds as string[], routingCanonicalEvidence);
  }
  let models: ConfigV2Model[] = replacingModels ? retainedModels.map(cloneValue) : existingModels;
  let agents: JsonObject = replacingModels
    ? preservedAgentCompat(existing?.agents)
    : isPlainObject(existing?.agents) ? cloneValue(existing.agents) : EMPTY_OBJECT;

  if (replacingModels) {
    const availableModels = [
      ...models.filter((model) => model.id !== nextModel.id),
      nextModel
    ];
    replaceQualifiedProviderReferences(next, providerId, availableModels, nextModel);
    replaceDefaultProviderSelection(next, providerId, availableModels, nextModel);
  } else if (previousModelId && previousModelId !== nextModel.id) {
    migrateLocalModelReferences(models, previousModelId, stringValue(nextModel.id));
    migrateLocalAgentReferences(agents, previousModelId, stringValue(nextModel.id));
    migrateQualifiedModelReferences(next, providerId, previousModelId, stringValue(nextModel.id));
    migrateDefaultModelReference(next, providerId, previousModelId, stringValue(nextModel.id));
    models = models.filter((model) => stringValue(model.id) !== previousModelId);
  }
  const modelIndex = models.findIndex((model) => stringValue(model.id) === nextModel.id);
  if (modelIndex >= 0) models[modelIndex] = nextModel;
  else models.push(nextModel);

  const requestedCredentialAction = stringValue(input.credentialAction) || "keep";
  const credentialAction = endpointChanged && requestedCredentialAction !== "replace"
    ? "clear"
    : requestedCredentialAction;
  let auth = isPlainObject(existing?.auth) ? cloneValue(existing.auth) : { mode: "ambient" };
  const existingCredentialRef = auth.mode === "credential" ? stringValue(auth.ref) : "";
  const credentialRefCounts = credentialReferenceCounts(next, input.credentialReferences);
  let credentialMutation = null;
  if (credentialAction === "replace") {
    const preferredRef = credentialReferenceForProvider(providerId);
    const ref = (existingCredentialRef || credentialRefCounts.has(preferredRef))
      ? independentCredentialReference(providerId, credentialRefCounts)
      : preferredRef;
    const cleanupRef = existingCredentialRef
      && otherCredentialReferenceCount(credentialRefCounts, existingCredentialRef, existingCredentialRef) === 0
      ? existingCredentialRef
      : "";
    auth = { mode: "credential", ref };
    credentialMutation = compactObject({
      op: "set",
      ref,
      value: stringValue(input.gatewayApiKey),
      cleanupRef: cleanupRef && cleanupRef !== ref ? cleanupRef : undefined
    });
  } else if (credentialAction === "clear") {
    const ref = existingCredentialRef || credentialReferenceForProvider(providerId);
    auth = { mode: "none" };
    const currentProviderOwnsRef = existingCredentialRef === ref;
    if (
      (existingCredentialRef || requestedCredentialAction === "clear")
      && otherCredentialReferenceCount(
        credentialRefCounts,
        ref,
        currentProviderOwnsRef ? existingCredentialRef : ""
      ) === 0
    ) {
      credentialMutation = { op: "clear", ref };
    }
  }

  agents = updateProviderAgents(agents, agentInput, stringValue(nextModel.id));
  const routingModels = ensureProviderRoutingModels({
    document: next,
    providerId,
    models,
    agents,
    canonicalEvidence: routingCanonicalEvidence,
    catalogModels: catalog.models,
    protectedRoutingModelIds: replacingModels ? [] : input.protectedRoutingModelIds
  });
  if (!routingModels.ok) return routingModels;
  ({ models, agents } = routingModels);
  providers[providerId] = compactObject({
    ...(isPlainObject(existing) ? cloneValue(existing) : {}),
    displayName: stringValue(existing?.displayName) || providerDisplayName(stringValue(input.gatewayUrl), providerId),
    transport: compactObject({
      ...(isPlainObject(existing?.transport) ? cloneValue(existing.transport) : {}),
      protocol: stringValue(input.gatewayProtocol) || "openai-chat",
      baseURL: stringValue(input.gatewayUrl),
      healthURL: stringValue(input.gatewayHealthUrl) || undefined
    }),
    auth,
    models,
    agents: Object.keys(agents).length > 0 ? agents : undefined,
    reliability: isPlainObject(existing?.reliability) ? cloneValue(existing.reliability) : undefined
  });
  setProviders(next, providers);

  reconcileDefaultSelectionReasoning(next, providerId, models);
  reconcileQualifiedRoutingReasoning(next, providerId, models);

  if (input.switchToModel === true) {
    setDefaultSelection(next, {
      provider: providerId,
      model: nextModel.id,
      reasoningEffort: stringValue(isPlainObject(nextModel.reasoning) ? nextModel.reasoning.default : undefined) || undefined
    });
    retainQualifiedAgentRoutesForProvider(next, providerId);
  }
  return {
    ok: true,
    document: next,
    providerId,
    modelId: nextModel.id,
    credentialMutation,
    credentialConfigured: credentialAction === "replace"
      ? true
      : credentialAction === "clear" ? false : undefined
  };
}

/** @param {Record<string, any>} document @param {{ provider: string; model: string; reasoningEffort?: string }} selection */
export function updateDefaultModelSelection(document: Record<string, unknown>, selection: { provider: string; model: string; reasoningEffort?: string }) {
  const next = requireV2Document(document);
  const provider = stringValue(selection.provider);
  const model = stringValue(selection.model);
  if (!provider || !model) return failure(400, "CONFIG_V2_INVALID_SELECTION", "模型选择必须同时包含来源和模型");
  setDefaultSelection(next, compactObject({
    provider,
    model,
    reasoningEffort: stringValue(selection.reasoningEffort).toLowerCase() || undefined
  }));
  retainQualifiedAgentRoutesForProvider(next, provider);
  return { ok: true, document: next };
}

/**
 * @param {Record<string, any>} document
 * @param {string} providerId
 * @param {{ credentialReferences?: unknown }} [options]
 */
export function deleteProvider(document: Record<string, unknown>, providerId: string, options: { credentialReferences?: unknown } = {}) {
  const next = requireV2Document(document);
  const providers = providerDictionary(next);
  const id = stringValue(providerId);
  const provider = providers[id];
  if (!provider) return failure(404, "CONFIG_V2_PROVIDER_NOT_FOUND", "模型来源不存在");
  const credentialRef = provider.auth?.mode === "credential" ? stringValue(provider.auth.ref) : "";
  const credentialRefCounts = credentialReferenceCounts(next, options.credentialReferences);
  delete providers[id];
  setProviders(next, providers);
  const selection = defaultSelection(next);
  if (selection?.provider === id) {
    const replacement = firstProviderSelection(providers);
    if (replacement) setDefaultSelection(next, replacement);
    else delete next.namespaces[CONFIG_V2_NAMESPACES.defaultModel];
  }
  removeProviderFromRouting(next, id);
  retainQualifiedAgentRoutesForProvider(next, stringValue(defaultSelection(next)?.provider));
  return {
    ok: true,
    document: next,
    deletedProvider: id,
    credentialRef: credentialRef && otherCredentialReferenceCount(
      credentialRefCounts,
      credentialRef,
      credentialRef
    ) === 0 ? credentialRef : ""
  };
}

/**
 * @param {Record<string, any>} document
 * @param {string} providerId
 * @param {string} modelId
 * @param {{ protectedRoutingModelIds?: unknown; credentialReferences?: unknown }} [options]
 */
export function deleteProviderModel(document: Record<string, unknown>, providerId: string, modelId: string, options: { protectedRoutingModelIds?: unknown; credentialReferences?: unknown } = {}) {
  const next = requireV2Document(document);
  const providers = providerDictionary(next);
  const id = stringValue(providerId);
  const provider = providers[id];
  if (!provider) return failure(404, "CONFIG_V2_PROVIDER_NOT_FOUND", "模型来源不存在");
  const providerModels: ConfigV2Model[] = Array.isArray(provider.models) ? provider.models : [];
  const modelIndex = createCanonicalModelIndex(providerModels.map((model) => model.id));
  if (!modelIndex.ok) return modelIndex;
  const targetModel = modelIndex.canonical(modelId);
  const models = providerModels
    .filter((model) => stringValue(model.id) !== targetModel)
    .map(cloneValue);
  if (models.length === providerModels.length) {
    return failure(404, "CONFIG_V2_MODEL_NOT_FOUND", "模型配置不存在");
  }
  const selectable = models.filter((model) => model.compat?.routingOnly !== true);
  if (selectable.length === 0) return deleteProvider(next, id, options);
  const fallbackModel = selectable[0];
  const fallback = fallbackModel.id ?? "";
  const agents: JsonObject = isPlainObject(provider.agents) ? cloneValue(provider.agents) : {};
  migrateLocalModelReferences(models, targetModel, fallback);
  migrateLocalAgentReferences(agents, targetModel, fallback, { disableVision: true });
  migrateQualifiedModelReferences(next, id, targetModel, fallback, { disableVision: true });
  migrateDefaultModelReference(next, id, targetModel, fallback);
  const routingModels = ensureProviderRoutingModels({
    document: next,
    providerId: id,
    models,
    agents,
    canonicalEvidence: createCanonicalModelIndex(models.map((model) => model.id)),
    protectedRoutingModelIds: options.protectedRoutingModelIds
  });
  if (!routingModels.ok) return routingModels;
  providers[id] = { ...cloneValue(provider), models: routingModels.models };
  if (Object.keys(routingModels.agents).length > 0) providers[id].agents = routingModels.agents;
  else delete providers[id].agents;
  setProviders(next, providers);
  reconcileDefaultSelectionReasoning(next, id, routingModels.models);
  reconcileQualifiedRoutingReasoning(next, id, routingModels.models);
  return { ok: true, document: next, deletedModel: targetModel, providerId: id };
}

/** @param {Record<string, any>} document */
export function providerDictionary(document: Record<string, unknown>): Record<string, ConfigV2Provider> {
  const namespaces = isPlainObject(document.namespaces) ? document.namespaces : undefined;
  const groupValue = namespaces?.[CONFIG_V2_NAMESPACES.providers];
  const group = isPlainObject(groupValue) ? groupValue : undefined;
  const providersValue = group?.providers;
  const providers = isPlainObject(providersValue) ? providersValue : undefined;
  return providers ? cloneValue(providers) as Record<string, ConfigV2Provider> : {};
}

export function defaultSelection(document: Record<string, unknown>): ConfigV2ModelRef | null {
  const namespaces = isPlainObject(document.namespaces) ? document.namespaces : undefined;
  const groupValue = namespaces?.[CONFIG_V2_NAMESPACES.defaultModel];
  const group = isPlainObject(groupValue) ? groupValue : undefined;
  const selectionValue = group?.selection;
  const selection = isPlainObject(selectionValue) ? selectionValue : null;
  return selection ? cloneValue(selection) as ConfigV2ModelRef : null;
}

function setProviders(document: ConfigV2Document, providers: Record<string, ConfigV2Provider>) {
  document.namespaces[CONFIG_V2_NAMESPACES.providers] = { providers };
}

function setDefaultSelection(document: ConfigV2Document, selection: JsonObject) {
  document.namespaces[CONFIG_V2_NAMESPACES.defaultModel] = { selection: cloneValue(selection) };
}

function retainQualifiedAgentRoutesForProvider(document: ConfigV2Document, providerId: string) {
  const routing = document.namespaces[CONFIG_V2_NAMESPACES.agentRouting];
  if (!isPlainObject(routing)) return;
  const modelTiers = routing.modelTiers;
  if (isPlainObject(modelTiers)) {
    for (const [tier, reference] of Object.entries(modelTiers)) {
      if (!isPlainObject(reference) || reference.provider !== providerId) delete modelTiers[tier];
    }
    if (Object.keys(modelTiers).length === 0) delete routing.modelTiers;
  }
  const vision = isPlainObject(routing.vision) ? routing.vision : undefined;
  const visionModel = vision && isPlainObject(vision.model) ? vision.model : undefined;
  if (visionModel?.provider && visionModel.provider !== providerId) {
    delete routing.vision;
  }
  if (Object.keys(routing).length === 0) delete document.namespaces[CONFIG_V2_NAMESPACES.agentRouting];
}

/** @param {Record<string, any>} model */
function dashboardModelToV2(model: unknown): ConfigV2Model & { id: string } {
  const source = isPlainObject(model) ? model : {};
  const efforts = Array.isArray(source.reasoningEfforts)
    ? source.reasoningEfforts.map((effort) => {
        const entry = isPlainObject(effort) ? effort : { id: effort };
        return compactObject({
          id: stringValue(entry.id ?? effort).toLowerCase(),
          label: stringValue("label" in entry ? entry.label : undefined) || undefined,
          description: stringValue("description" in entry ? entry.description : undefined) || undefined
        });
      }).filter((effort) => Boolean(effort.id))
    : [];
  const defaultEffort = stringValue(source.defaultReasoningEffort).toLowerCase();
  const compat = isPlainObject(source.compat) ? cloneValue(source.compat) : {};
  delete compat.reasoningDiscovery;
  return compactObject({
    id: stringValue(source.id),
    displayName: stringValue(source.label) || stringValue(source.id),
    description: stringValue(source.description) || undefined,
    thinking: source.thinking === true || efforts.length > 0,
    inputModalities: normalizeModalities(source.modalities),
    contextWindow: positiveInteger(source.contextTokens),
    maxOutputTokens: positiveInteger(source.maxOutputTokens),
    reasoning: efforts.length > 0 ? compactObject({
      efforts,
      default: efforts.some((effort) => effort.id === defaultEffort) ? defaultEffort : undefined
    }) : undefined,
    reasoningContentMode: stringValue(source.reasoningContentMode) || undefined,
    openaiExtraBody: isPlainObject(source.openaiExtraBody) ? cloneValue(source.openaiExtraBody) : undefined,
    agentModelTiers: isPlainObject(source.agentModelTiers) ? cloneValue(source.agentModelTiers) : undefined,
    compat: Object.keys(compat).length > 0 ? compat : undefined
  });
}

/** @param {Record<string, any>} nextModel @param {unknown} previousModel */
function preserveUnmanagedModelFields(nextModel: Record<string, unknown>, previousModel: unknown) {
  const next = cloneValue(nextModel);
  if (!isPlainObject(previousModel)) return next;
  const previous = previousModel;
  for (const field of ["description", "maxOutputTokens", "reasoningContentMode", "openaiExtraBody"]) {
    if (!Object.prototype.hasOwnProperty.call(next, field) && Object.prototype.hasOwnProperty.call(previous, field)) {
      next[field] = cloneValue(previous[field]);
    }
  }
  const compat = {
    ...(isPlainObject(previous.compat) ? cloneValue(previous.compat) : {}),
    ...(isPlainObject(next.compat) ? cloneValue(next.compat) : {})
  };
  if (Object.keys(compat).length > 0) next.compat = compat;
  return next;
}

/**
 * Provenance is evidence about an exact model capability declaration. A
 * trusted catalog can replace it; otherwise it survives only a same-endpoint,
 * same-model save whose effort IDs and default are unchanged.
 *
 * @param {{ nextModel: Record<string, any>; previousModel: unknown; catalogModel: unknown; endpointChanged: boolean }} input
 */
function reconcileReasoningDiscovery(input: { nextModel: Record<string, unknown>; previousModel: unknown; catalogModel: unknown; endpointChanged: boolean }) {
  const next = cloneValue(input.nextModel);
  const previous = isPlainObject(input.previousModel)
    ? input.previousModel
    : null;
  const catalog = isPlainObject(input.catalogModel)
    ? input.catalogModel
    : null;
  const catalogCompat = catalog && isPlainObject(catalog.compat) ? catalog.compat : undefined;
  const marker = normalizeCatalogReasoningDiscovery(catalogCompat?.reasoningDiscovery);
  const catalogMatches = catalog && sameReasoningDeclaration(next, catalog);

  if (catalogMatches && marker) {
    next.compat = {
      ...(isPlainObject(next.compat) ? next.compat : {}),
      reasoningDiscovery: marker
    };
    return next;
  }

  const mayRetainPrevious = !catalog
    && !input.endpointChanged
    && previous
    && stringValue(previous.id) === stringValue(next.id)
    && sameReasoningDeclaration(previous, next);
  const previousCompat = previous && isPlainObject(previous.compat) ? previous.compat : undefined;
  if (!mayRetainPrevious || !isPlainObject(previousCompat?.reasoningDiscovery)) {
    clearReasoningDiscovery(next);
  }
  return next;
}

/** @param {Record<string, any>} model */
function clearReasoningDiscovery(model: Record<string, unknown>) {
  if (!isPlainObject(model.compat)) return;
  delete model.compat.reasoningDiscovery;
  if (Object.keys(model.compat).length === 0) delete model.compat;
}

/** @param {Record<string, any>} left @param {Record<string, any>} right */
function sameReasoningDeclaration(left: Record<string, unknown>, right: Record<string, unknown>) {
  const leftSignature = reasoningDeclarationSignature(left);
  const rightSignature = reasoningDeclarationSignature(right);
  return leftSignature.defaultEffort === rightSignature.defaultEffort
    && leftSignature.efforts.length === rightSignature.efforts.length
    && leftSignature.efforts.every((effort, index) => effort === rightSignature.efforts[index]);
}

function reasoningDeclarationSignature(model: Record<string, unknown>) {
  const reasoning = isPlainObject(model.reasoning) ? model.reasoning : undefined;
  const efforts = Array.isArray(reasoning?.efforts)
    ? [...new Set(reasoning.efforts.map((effort) => {
        const entry = isPlainObject(effort) ? effort : { id: effort };
        return stringValue(entry.id ?? effort).toLowerCase();
      }).filter(Boolean))].sort()
    : [];
  const requestedDefault = stringValue(reasoning?.default).toLowerCase();
  return {
    efforts,
    defaultEffort: efforts.includes(requestedDefault) ? requestedDefault : ""
  };
}

/** @param {Record<string, any>} model */
function promoteRoutingOnlyModel(model: Record<string, unknown>) {
  if (!isPlainObject(model.compat) || model.compat.routingOnly !== true) return model;
  const next = cloneValue(model);
  const compat = isPlainObject(next.compat) ? next.compat : undefined;
  if (!compat) return next;
  delete compat.routingOnly;
  if (Object.keys(compat).length === 0) delete next.compat;
  else next.compat = compat;
  return next;
}

/**
 * Normalize every provider-local and qualified route against immutable
 * evidence, create placeholders only for referenced IDs, then garbage-collect
 * route-only declarations that no route uses anymore.
 *
 * @param {{
 *   document: Record<string, any>;
 *   providerId: string;
 *   models: Array<Record<string, any>>;
 *   agents: Record<string, any>;
 *   canonicalEvidence: Record<string, any>;
 *   catalogModels?: Array<Record<string, any>>;
 *   protectedRoutingModelIds?: unknown;
 * }} input
 * @returns {Record<string, any>}
 */
function ensureProviderRoutingModels(input: {
  document: ConfigV2Document;
  providerId: string;
  models: ConfigV2Model[];
  agents: JsonObject;
  canonicalEvidence: CanonicalModelIndex | MutationFailure;
  catalogModels?: JsonObject[];
  protectedRoutingModelIds?: unknown;
}): RoutingModelsResult {
  const evidence = input.canonicalEvidence;
  if (!evidence.ok) return evidence;
  const nextModels = input.models.map(cloneValue);
  const nextAgents = cloneValue(input.agents);
  const routedIds = new Set<string>();
  const allIds = new Set(nextModels.map((model) => stringValue(model.id)));
  const catalogById = new Map(
    (Array.isArray(input.catalogModels) ? input.catalogModels : []).map((model) => [stringValue(model.id), model])
  );
  const idsByCaseFold = new Map<string, string>();

  const recordId = (value: unknown): MutationFailure | { ok: true; id: string } => {
    const id = evidence.canonical(value);
    if (!id) return { ok: true, id: "" };
    const folded = id.toLowerCase();
    const previous = idsByCaseFold.get(folded);
    if (previous && previous !== id) return modelIdCaseCollision(previous, id);
    idsByCaseFold.set(folded, id);
    return { ok: true, id };
  };
  for (const model of nextModels) {
    const recorded = recordId(model.id);
    if (!recorded.ok) return recorded;
    if (isPlainObject(model.compat) && model.compat.routingOnly === true && catalogById.has(recorded.id)) {
      Object.assign(model, routingModelDeclaration(recorded.id, catalogById.get(recorded.id), model));
    }
  }

  /** @param {unknown} tiers */
  const normalizeTiers = (tiers: unknown) => {
    if (!isPlainObject(tiers)) return { ok: true as const };
    const tierMap = tiers;
    for (const tier of Object.keys(tierMap)) {
      const recorded = recordId(tierMap[tier]);
      if (!recorded.ok) return recorded;
      if (!recorded.id) {
        delete tierMap[tier];
      } else {
        tierMap[tier] = recorded.id;
        routedIds.add(recorded.id);
      }
    }
    return { ok: true as const };
  };

  for (const model of nextModels) {
    const normalized = normalizeTiers(model.agentModelTiers);
    if (!normalized.ok) return normalized;
  }
  const normalizedAgentTiers = normalizeTiers(nextAgents.modelTiers);
  if (!normalizedAgentTiers.ok) return normalizedAgentTiers;
  if (isPlainObject(nextAgents.vision) && nextAgents.vision.model !== null) {
    const recorded = recordId(nextAgents.vision.model);
    if (!recorded.ok) return recorded;
    nextAgents.vision.model = recorded.id || null;
    if (recorded.id) routedIds.add(recorded.id);
  }

  const routing = input.document.namespaces[CONFIG_V2_NAMESPACES.agentRouting];
  const routingTiers = isPlainObject(routing) && isPlainObject(routing.modelTiers) ? routing.modelTiers : undefined;
  if (routingTiers) {
    for (const reference of Object.values(routingTiers)) {
      if (!isPlainObject(reference) || reference.provider !== input.providerId) continue;
      const recorded = recordId(reference.model);
      if (!recorded.ok) return recorded;
      reference.model = recorded.id;
      if (recorded.id) routedIds.add(recorded.id);
    }
  }
  const routingVision = isPlainObject(routing) && isPlainObject(routing.vision) ? routing.vision : undefined;
  const qualifiedVision = routingVision && isPlainObject(routingVision.model) ? routingVision.model : undefined;
  if (qualifiedVision?.provider === input.providerId) {
    const recorded = recordId(qualifiedVision.model);
    if (!recorded.ok) return recorded;
    qualifiedVision.model = recorded.id;
    if (recorded.id) routedIds.add(recorded.id);
  }

  for (const id of normalizeIdentifierList(input.protectedRoutingModelIds)) {
    if (allIds.has(id)) routedIds.add(id);
  }
  for (const id of routedIds) {
    if (allIds.has(id)) continue;
    nextModels.push(routingModelDeclaration(id, catalogById.get(id)));
    allIds.add(id);
  }
  return {
    ok: true,
    models: nextModels.filter((model) => !isPlainObject(model.compat) || model.compat.routingOnly !== true || routedIds.has(stringValue(model.id))),
    agents: nextAgents
  };
}

/** @param {string} id @param {unknown} catalogModel @param {unknown} existing */
function routingModelDeclaration(id: string, catalogModel: unknown, existing: unknown = null) {
  const previous = isPlainObject(existing) ? cloneValue(existing) : EMPTY_OBJECT;
  const metadata = isPlainObject(catalogModel) ? cloneValue(catalogModel) : EMPTY_OBJECT;
  const metadataCompat = isPlainObject(metadata.compat) ? metadata.compat : undefined;
  const reasoningDiscovery = normalizeCatalogReasoningDiscovery(metadataCompat?.reasoningDiscovery);
  delete metadata.compat;
  return compactObject({
    ...previous,
    ...metadata,
    id,
    displayName: stringValue(metadata.displayName) || stringValue(previous.displayName) || id,
    compat: {
      ...(isPlainObject(previous.compat) ? previous.compat : {}),
      ...(reasoningDiscovery ? { reasoningDiscovery } : {}),
      routingOnly: true
    }
  });
}

/** @param {unknown} existing @param {Record<string, any>} input @param {string} modelId */
function updateProviderAgents(existing: unknown, input: Record<string, unknown>, modelId: string): JsonObject {
  const agents: JsonObject = isPlainObject(existing) ? cloneValue(existing) : {};
  const inputModel = isPlainObject(input.model) ? input.model : undefined;
  const normalizedPresence = input.agentModelTiersProvided;
  const modelTiersProvided = normalizedPresence === true
    || (normalizedPresence === undefined
      && inputModel
      && Object.prototype.hasOwnProperty.call(inputModel, "agentModelTiers"));
  if (modelTiersProvided && inputModel && isPlainObject(inputModel.agentModelTiers)) {
    if (Object.keys(inputModel.agentModelTiers).length > 0) {
      agents.modelTiers = cloneValue(inputModel.agentModelTiers);
    } else {
      delete agents.modelTiers;
    }
  }
  const currentVision = isPlainObject(agents.vision) ? agents.vision : undefined;
  if (input.visionAgentModelProvided === true) {
    const visionModel = stringValue(input.visionAgentModel);
    agents.vision = {
      ...(currentVision ?? {}),
      enabled: Boolean(visionModel),
      model: visionModel || null,
      autoUseWhenMainModelTextOnly: currentVision?.autoUseWhenMainModelTextOnly !== false
    };
  } else if (Array.isArray(inputModel?.modalities) && inputModel.modalities.includes("image") && !stringValue(currentVision?.model)) {
    agents.vision = { enabled: true, model: modelId, autoUseWhenMainModelTextOnly: true };
  }
  return agents;
}

/** @param {unknown} existing @param {Record<string, any>} input */
function providerEndpointChanged(existing: unknown, input: Record<string, unknown>) {
  if (!isPlainObject(existing)) return false;
  const transport = isPlainObject(existing.transport) ? existing.transport : undefined;
  const currentProtocol = stringValue(transport?.protocol) || "openai-chat";
  const nextProtocol = stringValue(input.gatewayProtocol) || "openai-chat";
  return currentProtocol !== nextProtocol
    || stringValue(transport?.baseURL) !== stringValue(input.gatewayUrl);
}

/**
 * Endpoint replacement may retain catalog-confirmed main models, but their
 * embedded agent routes belong to the old endpoint until the new catalog
 * proves otherwise.
 *
 * @param {Record<string, any>} model
 * @param {string[]} catalogIds
 * @param {Record<string, any>} catalogIndex
 */
function retainCatalogAgentModelTiers(model: Record<string, unknown>, catalogIds: string[], catalogIndex: CanonicalModelIndex): ConfigV2Model {
  const next = cloneValue(model) as ConfigV2Model;
  if (!isPlainObject(next.agentModelTiers)) return next;
  const catalog = new Set(catalogIds);
  const retained: Record<string, string> = {};
  for (const [tier, value] of Object.entries(next.agentModelTiers)) {
    const id = catalogIndex.canonical(value);
    if (catalog.has(id)) retained[tier] = id;
  }
  if (Object.keys(retained).length > 0) next.agentModelTiers = retained;
  else delete next.agentModelTiers;
  return next;
}

/**
 * A changed endpoint cannot inherit unresolved agent IDs from its predecessor.
 * The new catalog and the main model saved in this transaction are the only
 * evidence that a route belongs to the replacement endpoint.
 *
 * @param {Record<string, any>} input
 * @param {string[]} allowedIds
 * @param {Record<string, any>} canonicalIndex
 */
function retainEndpointAgentInput(input: Record<string, unknown>, allowedIds: string[], canonicalIndex: CanonicalModelIndex): JsonObject {
  const next = cloneValue(input);
  if (isPlainObject(next.model)) {
    next.model = retainCatalogAgentModelTiers(next.model, allowedIds, canonicalIndex);
  }
  if (next.visionAgentModelProvided === true) {
    const allowed = new Set(allowedIds);
    const modelId = canonicalIndex.canonical(next.visionAgentModel);
    next.visionAgentModel = allowed.has(modelId) ? modelId : "";
  }
  return next;
}

/** @param {unknown} value @returns {Record<string, any>} */
function normalizeCatalogModelIds(value: unknown): CatalogIdsResult {
  if (value === undefined || value === null) return { ok: true, ids: [] as string[] };
  if (!Array.isArray(value) || value.length > 2_048) {
    return failure(400, "CONFIG_V2_INVALID_MODEL_CATALOG", "模型目录格式无效，请重新读取模型列表");
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const valueId of value) {
    if (typeof valueId !== "string") {
      return failure(400, "CONFIG_V2_INVALID_MODEL_CATALOG", "模型目录包含无效的模型 ID");
    }
    const id = stringValue(valueId);
    if (!validModelIdentifier(id)) {
      return failure(400, "CONFIG_V2_INVALID_MODEL_CATALOG", "模型目录包含无效的模型 ID");
    }
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  const index = createCanonicalModelIndex(ids);
  return index.ok ? { ok: true, ids } : index;
}

/** @param {unknown} value @returns {Record<string, any>} */
function normalizeManualAgentModelIds(value: unknown): CatalogIdsResult {
  if (value === undefined || value === null) return { ok: true, ids: [] as string[] };
  if (!Array.isArray(value) || value.length > 4) {
    return failure(400, "CONFIG_V2_INVALID_MANUAL_MODEL_IDS", "手工子智能体模型 ID 格式无效");
  }
  const normalized = normalizeCatalogModelIds(value);
  if (normalized.ok) return normalized;
  return failure(
    normalized.status ?? 400,
    normalized.code === "CONFIG_V2_MODEL_ID_CASE_COLLISION"
      ? normalized.code
      : "CONFIG_V2_INVALID_MANUAL_MODEL_IDS",
    normalized.error ?? "手工子智能体模型 ID 无效"
  );
}

/** @param {unknown} idsValue @param {unknown} modelsValue @returns {Record<string, any>} */
function normalizeCatalogModels(idsValue: unknown, modelsValue: unknown): CatalogModelsResult {
  const catalog = normalizeCatalogModelIds(idsValue);
  if (!catalog.ok) return catalog;
  if (modelsValue === undefined || modelsValue === null) return { ...catalog, models: [] };
  if (!Array.isArray(modelsValue) || modelsValue.length > 2_048) {
    return failure(400, "CONFIG_V2_INVALID_MODEL_CATALOG", "模型目录元数据格式无效，请重新读取模型列表");
  }
  const catalogIds = catalog.ids;
  const canonicalByFold = new Map(catalogIds.map((id) => [id.toLowerCase(), id]));
  const seen = new Set<string>();
  const models: JsonObject[] = [];
  for (const value of modelsValue) {
    if (!isPlainObject(value) || typeof value.id !== "string") {
      return failure(400, "CONFIG_V2_INVALID_MODEL_CATALOG", "模型目录元数据包含无效的模型条目");
    }
    const requestedId = stringValue(value.id);
    const id = canonicalByFold.get(requestedId.toLowerCase());
    if (!id || !validModelIdentifier(requestedId)) {
      return failure(400, "CONFIG_V2_INVALID_MODEL_CATALOG", "模型目录元数据引用了未经当前目录确认的模型 ID");
    }
    if (seen.has(id)) continue;
    const normalized = normalizeCatalogModelMetadata(value, id);
    if (!normalized.ok) return normalized;
    seen.add(id);
    models.push(normalized.model);
  }
  return { ...catalog, models };
}

/** @param {Record<string, any>} value @param {string} id @returns {Record<string, any>} */
function normalizeCatalogModelMetadata(value: JsonObject, id: string): CatalogMetadataResult {
  const rawDisplayName = value.label ?? value.displayName ?? id;
  if (typeof rawDisplayName !== "string") {
    return failure(400, "CONFIG_V2_INVALID_MODEL_CATALOG", "模型目录元数据包含无效的模型名称");
  }
  const displayName = rawDisplayName.trim() || id;
  if (displayName.length > 160 || /[\r\n\t\0]/.test(displayName)) {
    return failure(400, "CONFIG_V2_INVALID_MODEL_CATALOG", "模型目录元数据包含无效的模型名称");
  }

  const modalityResult = normalizeCatalogModalities(value.modalities ?? value.inputModalities);
  if (!modalityResult.ok) return modalityResult;
  const contextWindow = value.contextTokens ?? value.contextWindow;
  if (contextWindow !== undefined && contextWindow !== null
    && (typeof contextWindow !== "number" || !Number.isSafeInteger(contextWindow) || contextWindow <= 0)) {
    return failure(400, "CONFIG_V2_INVALID_MODEL_CATALOG", "模型目录元数据包含无效的上下文长度");
  }
  if (value.thinking !== undefined && typeof value.thinking !== "boolean") {
    return failure(400, "CONFIG_V2_INVALID_MODEL_CATALOG", "模型目录元数据包含无效的思考能力标记");
  }
  const reasoning = isPlainObject(value.reasoning) ? value.reasoning : undefined;
  const reasoningResult = normalizeCatalogReasoning(
    value.reasoningEfforts ?? reasoning?.efforts,
    value.defaultReasoningEffort ?? reasoning?.default
  );
  if (!reasoningResult.ok) return reasoningResult;
  const reasoningDiscovery = normalizeCatalogReasoningDiscovery(value.reasoningDiscovery);
  return {
    ok: true,
    model: compactObject({
      id,
      displayName,
      thinking: value.thinking === true || reasoningResult.efforts.length > 0,
      inputModalities: modalityResult.values,
      contextWindow: contextWindow ?? undefined,
      reasoning: reasoningResult.efforts.length > 0 ? compactObject({
        efforts: reasoningResult.efforts,
        default: reasoningResult.defaultEffort || undefined
      }) : undefined,
      compat: reasoningDiscovery ? { reasoningDiscovery } : undefined
    })
  };
}

/** @param {unknown} value */
function normalizeCatalogReasoningDiscovery(value: unknown) {
  if (!isPlainObject(value)) return null;
  const discovery = value;
  const source = boundedDiscoveryField(discovery.source, 64).toLowerCase();
  if (!source || !/^[a-z0-9][a-z0-9_-]*$/.test(source)) return null;
  return {
    source,
    confidence: boundedDiscoveryField(discovery.confidence, 64).toLowerCase() || "unknown",
    path: nullableDiscoveryField(discovery.path, 256),
    presetId: nullableDiscoveryField(discovery.presetId, 160)
  };
}

/** @param {unknown} value @param {number} limit */
function boundedDiscoveryField(value: unknown, limit: number) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return text.length <= limit && !/[\u0000-\u001f\u007f]/.test(text) ? text : "";
}

/** @param {unknown} value @param {number} limit */
function nullableDiscoveryField(value: unknown, limit: number) {
  if (value === undefined || value === null || value === "") return null;
  return boundedDiscoveryField(value, limit) || null;
}

/** @param {unknown} value @returns {Record<string, any>} */
function normalizeCatalogModalities(value: unknown): CatalogModalitiesResult {
  if (value === undefined || value === null) return { ok: true, values: ["text"] };
  if (!Array.isArray(value) || value.length > 16) {
    return failure(400, "CONFIG_V2_INVALID_MODEL_CATALOG", "模型目录元数据包含无效的输入类型");
  }
  const modalities = new Set(["text"]);
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length > 32) {
      return failure(400, "CONFIG_V2_INVALID_MODEL_CATALOG", "模型目录元数据包含无效的输入类型");
    }
    const modality = entry.trim().toLowerCase();
    if (modality === "text") continue;
    if (modality === "image") {
      modalities.add("image");
      continue;
    }
    return failure(400, "CONFIG_V2_INVALID_MODEL_CATALOG", "模型目录元数据包含不支持的输入类型");
  }
  return { ok: true, values: [...modalities] };
}

/** @param {unknown} value @param {unknown} defaultValue @returns {Record<string, any>} */
function normalizeCatalogReasoning(value: unknown, defaultValue: unknown): CatalogReasoningResult {
  if (value === undefined || value === null) return { ok: true, efforts: [], defaultEffort: "" };
  if (!Array.isArray(value) || value.length > 32) {
    return failure(400, "CONFIG_V2_INVALID_MODEL_CATALOG", "模型目录元数据包含无效的思考档位");
  }
  const efforts: JsonObject[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const source = typeof entry === "string" ? { id: entry } : entry;
    if (!isPlainObject(source)) {
      return failure(400, "CONFIG_V2_INVALID_MODEL_CATALOG", "模型目录元数据包含无效的思考档位");
    }
    const effortId = typeof source.id === "string" ? source.id.trim().toLowerCase() : "";
    if (!/^[a-z0-9_-]{1,32}$/.test(effortId)) {
      return failure(400, "CONFIG_V2_INVALID_MODEL_CATALOG", "模型目录元数据包含无效的思考档位");
    }
    if (seen.has(effortId)) continue;
    const rawLabel = source.label ?? effortId;
    const rawDescription = source.description ?? "";
    if (typeof rawLabel !== "string" || rawLabel.length > 80 || /[\r\n\t\0]/.test(rawLabel)
      || typeof rawDescription !== "string" || rawDescription.length > 1_024) {
      return failure(400, "CONFIG_V2_INVALID_MODEL_CATALOG", "模型目录元数据包含无效的思考档位说明");
    }
    seen.add(effortId);
    efforts.push(compactObject({
      id: effortId,
      label: rawLabel.trim() || effortId,
      description: rawDescription || undefined
    }));
  }
  if (defaultValue !== undefined && defaultValue !== null && typeof defaultValue !== "string") {
    return failure(400, "CONFIG_V2_INVALID_MODEL_CATALOG", "模型目录元数据包含无效的默认思考档位");
  }
  const requestedDefault = stringValue(defaultValue).toLowerCase();
  return {
    ok: true,
    efforts,
    defaultEffort: efforts.some((effort) => effort.id === requestedDefault) ? requestedDefault : ""
  };
}

/** @param {unknown[]} values @returns {Record<string, any>} */
function createCanonicalModelIndex(values: unknown[]): CanonicalModelIndex | MutationFailure {
  const exact = new Set<string>();
  const byCaseFold = new Map<string, string>();
  for (const value of values) {
    const id = stringValue(value);
    if (!id || exact.has(id)) continue;
    const folded = id.toLowerCase();
    const previous = byCaseFold.get(folded);
    if (previous && previous !== id) return modelIdCaseCollision(previous, id);
    exact.add(id);
    byCaseFold.set(folded, id);
  }
  return {
    ok: true,
    canonical(value: unknown) {
      const id = stringValue(value);
      if (!id || exact.has(id)) return id;
      return byCaseFold.get(id.toLowerCase()) || id;
    }
  };
}

/** @param {unknown} value */
function normalizeIdentifierList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(stringValue).filter(validModelIdentifier))];
}

/** @param {string} id */
function validModelIdentifier(id: string) {
  return Boolean(id) && id.length <= 160 && !/[\r\n\t\0]/.test(id);
}

/** @param {unknown} first @param {unknown} second @returns {Record<string, any>} */
function modelIdCaseCollision(first: unknown, second: unknown) {
  return failure(
    409,
    "CONFIG_V2_MODEL_ID_CASE_COLLISION",
    `模型 ID ${stringValue(first)} 与 ${stringValue(second)} 仅大小写不同，无法安全确定上游 ID`
  );
}

/** @param {unknown} agents */
function preservedAgentCompat(agents: unknown) {
  if (!isPlainObject(agents)) return {};
  return isPlainObject(agents.compat) ? { compat: cloneValue(agents.compat) } : {};
}

/** @param {Array<Record<string, any>>} models @param {string} previous @param {string} replacement */
function migrateLocalModelReferences(models: Array<Record<string, unknown>>, previous: string, replacement: string) {
  for (const model of models) {
    replaceLocalTierReferences(model.agentModelTiers, previous, replacement);
  }
}

/**
 * @param {Record<string, any>} agents
 * @param {string} previous
 * @param {string} replacement
 * @param {{ disableVision?: boolean }} [options]
 */
function migrateLocalAgentReferences(agents: Record<string, unknown>, previous: string, replacement: string, options: { disableVision?: boolean } = {}) {
  replaceLocalTierReferences(agents.modelTiers, previous, replacement, options);
  const vision = isPlainObject(agents.vision) ? agents.vision : undefined;
  if (vision?.model === previous) {
    agents.vision = options.disableVision
      ? { ...vision, enabled: false, model: null }
      : { ...vision, model: replacement };
  }
}

/**
 * @param {unknown} tiers
 * @param {string} previous
 * @param {string} replacement
 * @param {{ disableVision?: boolean }} [options]
 */
function replaceLocalTierReferences(tiers: unknown, previous: string, replacement: string, options: { disableVision?: boolean } = {}) {
  if (!isPlainObject(tiers)) return;
  const tierMap = tiers;
  for (const [tier, model] of Object.entries(tierMap)) {
    if (model !== previous) continue;
    if (options.disableVision && tier === "vision") delete tierMap[tier];
    else tierMap[tier] = replacement;
  }
}

/**
 * @param {Record<string, any>} document
 * @param {string} providerId
 * @param {string} previous
 * @param {string} replacement
 * @param {{ disableVision?: boolean }} [options]
 */
function migrateQualifiedModelReferences(document: ConfigV2Document, providerId: string, previous: string, replacement: string, options: { disableVision?: boolean } = {}) {
  const routing = document.namespaces[CONFIG_V2_NAMESPACES.agentRouting];
  if (!isPlainObject(routing)) return;
  const modelTiers = isPlainObject(routing.modelTiers) ? routing.modelTiers : undefined;
  if (modelTiers) {
    for (const [tier, reference] of Object.entries(modelTiers)) {
      if (!isPlainObject(reference) || reference.provider !== providerId || reference.model !== previous) continue;
      if (options.disableVision && tier === "vision") delete modelTiers[tier];
      else reference.model = replacement;
    }
  }
  const vision = isPlainObject(routing.vision) ? routing.vision : undefined;
  const visionModel = vision && isPlainObject(vision.model) ? vision.model : undefined;
  if (vision && visionModel?.provider === providerId && visionModel.model === previous) {
    routing.vision = options.disableVision
      ? { ...vision, enabled: false, model: null }
      : { ...vision, model: { ...visionModel, model: replacement } };
  }
  cleanupAgentRoutingNamespace(document);
}

/**
 * @param {Record<string, any>} document
 * @param {string} providerId
 * @param {Array<Record<string, any>>} availableModels
 * @param {Record<string, any>} fallbackModel
 */
function replaceQualifiedProviderReferences(document: ConfigV2Document, providerId: string, availableModels: ConfigV2Model[], fallbackModel: ConfigV2Model) {
  const routing = document.namespaces[CONFIG_V2_NAMESPACES.agentRouting];
  if (!isPlainObject(routing)) return;
  const available = new Set(availableModels.map((model) => model.id));
  const modelTiers = isPlainObject(routing.modelTiers) ? routing.modelTiers : undefined;
  if (modelTiers) {
    for (const reference of Object.values(modelTiers)) {
      if (isPlainObject(reference) && reference.provider === providerId && !available.has(stringValue(reference.model))) {
        reference.model = fallbackModel.id;
      }
    }
  }
  const vision = isPlainObject(routing.vision) ? routing.vision : undefined;
  const visionModel = vision && isPlainObject(vision.model) ? vision.model : undefined;
  if (vision && visionModel?.provider === providerId) {
    const selectedVisionModel = availableModels.find((model) => model.id === visionModel.model);
    if (selectedVisionModel) return;
    const modalities = fallbackModel.inputModalities;
    routing.vision = Array.isArray(modalities) && modalities.includes("image")
      ? { ...vision, model: { ...visionModel, model: fallbackModel.id } }
      : { ...vision, enabled: false, model: null };
  }
  cleanupAgentRoutingNamespace(document);
}

/** @param {Record<string, any>} document @param {string} providerId @param {string} previous @param {string} replacement */
function migrateDefaultModelReference(document: ConfigV2Document, providerId: string, previous: string, replacement: string) {
  const group = document.namespaces[CONFIG_V2_NAMESPACES.defaultModel];
  const selection = isPlainObject(group) && isPlainObject(group.selection) ? group.selection : undefined;
  if (selection?.provider === providerId && selection.model === previous) selection.model = replacement;
}

/**
 * @param {Record<string, any>} document
 * @param {string} providerId
 * @param {Array<Record<string, any>>} availableModels
 * @param {Record<string, any>} fallbackModel
 */
function replaceDefaultProviderSelection(document: ConfigV2Document, providerId: string, availableModels: ConfigV2Model[], fallbackModel: ConfigV2Model) {
  const group = document.namespaces[CONFIG_V2_NAMESPACES.defaultModel];
  const selection = isPlainObject(group) && isPlainObject(group.selection) ? group.selection : undefined;
  if (!selection || selection.provider !== providerId) return;
  if (availableModels.some((model) => model.id === selection.model)) return;
  selection.model = fallbackModel.id;
  const reasoning = isPlainObject(fallbackModel.reasoning) ? fallbackModel.reasoning : undefined;
  if (reasoning?.default) selection.reasoningEffort = reasoning.default;
  else delete selection.reasoningEffort;
}

/** @param {Record<string, any>} document @param {string} providerId @param {Array<Record<string, any>>} models */
function reconcileDefaultSelectionReasoning(document: ConfigV2Document, providerId: string, models: ConfigV2Model[]) {
  const group = document.namespaces[CONFIG_V2_NAMESPACES.defaultModel];
  const selection = isPlainObject(group) && isPlainObject(group.selection) ? group.selection : undefined;
  if (!selection || selection.provider !== providerId) return;
  let model = models.find((candidate) => candidate.id === selection.model && candidate.compat?.routingOnly !== true);
  if (!model) {
    model = models.find((candidate) => candidate.compat?.routingOnly !== true);
    if (!model) return;
    selection.model = model.id;
  }
  reconcileReferenceReasoning(selection, model);
}

/** @param {Record<string, any>} document @param {string} providerId @param {Array<Record<string, any>>} models */
function reconcileQualifiedRoutingReasoning(document: ConfigV2Document, providerId: string, models: ConfigV2Model[]) {
  const byId = new Map(models.map((model) => [model.id, model]));
  const routing = document.namespaces[CONFIG_V2_NAMESPACES.agentRouting];
  if (!isPlainObject(routing)) return;
  const modelTiers = isPlainObject(routing.modelTiers) ? routing.modelTiers : {};
  for (const reference of Object.values(modelTiers)) {
    if (isPlainObject(reference) && reference.provider === providerId) {
      reconcileReferenceReasoning(reference, byId.get(stringValue(reference.model)));
    }
  }
  const vision = isPlainObject(routing.vision) && isPlainObject(routing.vision.model) ? routing.vision.model : undefined;
  if (vision?.provider === providerId) reconcileReferenceReasoning(vision, byId.get(stringValue(vision.model)));
}

/** @param {Record<string, any>} reference @param {Record<string, any> | undefined} model */
function reconcileReferenceReasoning(reference: Record<string, unknown>, model: ConfigV2Model | undefined) {
  if (reference.reasoningEffort === undefined) return;
  const reasoning = model && isPlainObject(model.reasoning) ? model.reasoning : undefined;
  const rawEfforts = Array.isArray(reasoning?.efforts) ? reasoning.efforts : [];
  const efforts = new Set(rawEfforts.map((effort) => {
    const entry = isPlainObject(effort) ? effort : { id: effort };
    return entry.id;
  }));
  if (efforts.has(reference.reasoningEffort)) return;
  if (reasoning?.default && efforts.has(reasoning.default)) {
    reference.reasoningEffort = reasoning.default;
  } else {
    delete reference.reasoningEffort;
  }
}

/** @param {Record<string, any>} providers */
function firstProviderSelection(providers: Record<string, ConfigV2Provider>) {
  for (const [provider, entry] of Object.entries(providers)) {
    const models = Array.isArray(entry.models) ? entry.models : [];
    const model = stringValue(models.find((candidate) => (
      candidate.compat?.routingOnly !== true
    ))?.id);
    if (model) return { provider, model };
  }
  return null;
}

/** @param {Record<string, any>} document @param {string} providerId */
function removeProviderFromRouting(document: ConfigV2Document, providerId: string) {
  const routing = document.namespaces[CONFIG_V2_NAMESPACES.agentRouting];
  if (!isPlainObject(routing)) return;
  const modelTiers = isPlainObject(routing.modelTiers) ? routing.modelTiers : undefined;
  if (modelTiers) {
    for (const [tier, ref] of Object.entries(modelTiers)) {
      if (isPlainObject(ref) && ref.provider === providerId) delete modelTiers[tier];
    }
  }
  const vision = isPlainObject(routing.vision) ? routing.vision : undefined;
  const visionModel = vision && isPlainObject(vision.model) ? vision.model : undefined;
  if (visionModel?.provider === providerId) delete routing.vision;
  cleanupAgentRoutingNamespace(document);
}

/** @param {Record<string, any>} document */
function cleanupAgentRoutingNamespace(document: ConfigV2Document) {
  const routing = document.namespaces[CONFIG_V2_NAMESPACES.agentRouting];
  if (!isPlainObject(routing)) return;
  if (isPlainObject(routing.modelTiers) && Object.keys(routing.modelTiers).length === 0) {
    delete routing.modelTiers;
  }
  if (Object.keys(routing).length === 0) {
    delete document.namespaces[CONFIG_V2_NAMESPACES.agentRouting];
  }
}

/**
 * Count references from the caller-provided global/project snapshot. Direct
 * callers fall back to the current document, which still protects providers
 * that share a credential within one scope.
 *
 * @param {Record<string, any>} document
 * @param {unknown} providedReferences
 */
function credentialReferenceCounts(document: Record<string, unknown>, providedReferences: unknown) {
  const namespaces = isPlainObject(document.namespaces) ? document.namespaces : undefined;
  const groupValue = namespaces?.[CONFIG_V2_NAMESPACES.providers];
  const group = isPlainObject(groupValue) ? groupValue : undefined;
  const providersValue = group?.providers;
  const providers = isPlainObject(providersValue) ? providersValue : EMPTY_OBJECT;
  const references = Array.isArray(providedReferences)
    ? providedReferences
    : Object.values(providers)
        .filter((provider): provider is JsonObject => isPlainObject(provider) && isPlainObject(provider.auth) && provider.auth.mode === "credential")
        .map((provider) => isPlainObject(provider.auth) ? provider.auth.ref : undefined);
  const counts = new Map<string, number>();
  for (const value of references) {
    const ref = stringValue(value);
    if (ref) counts.set(ref, (counts.get(ref) ?? 0) + 1);
  }
  return counts;
}

/** @param {Map<string, number>} counts @param {string} ref @param {string} currentProviderRef */
function otherCredentialReferenceCount(counts: Map<string, number>, ref: string, currentProviderRef: string) {
  return Math.max(0, (counts.get(ref) ?? 0) - (currentProviderRef === ref ? 1 : 0));
}

/** @param {string} providerId @param {Map<string, number>} counts */
function independentCredentialReference(providerId: string, counts: Map<string, number>) {
  const base = credentialReferenceForProvider(providerId);
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 16).toUpperCase();
    const candidate = `${base}_${suffix}`;
    if (!counts.has(candidate)) return candidate;
  }
  throw Object.assign(new Error("无法为模型来源分配独立凭据引用"), {
    code: "CONFIG_V2_CREDENTIAL_REF_COLLISION"
  });
}

/** @param {Record<string, any>} document */
function requireV2Document(document: Record<string, unknown>): ConfigV2Document {
  if (!isV2SettingsDocument(document)) {
    throw Object.assign(new Error("Config V2 document required"), { code: "CONFIG_V2_REQUIRED" });
  }
  const next = cloneValue(document) as ConfigV2Document;
  next.namespaces = isPlainObject(next.namespaces) ? next.namespaces as ConfigV2Namespaces : {};
  return next;
}

/** @param {string} url @param {string} fallback */
function providerDisplayName(url: string, fallback: string) {
  try {
    return new URL(url).hostname || fallback;
  } catch {
    return fallback;
  }
}

/** @param {unknown} values */
function normalizeModalities(values: unknown) {
  const result = Array.isArray(values)
    ? [...new Set(values.map((value) => stringValue(value).toLowerCase()).filter((value) => ["text", "image"].includes(value)))]
    : [];
  return result.length > 0 ? result : ["text"];
}

/** @param {number} status @param {string} code @param {string} error */
function failure(status: number, code: string, error: string): MutationFailure {
  return { ok: false, status, code, error };
}

function compactObject<T extends JsonObject>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

/** @param {unknown} value */
function positiveInteger(value: unknown) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

/** @param {unknown} value */
function stringValue(value: unknown) {
  return String(value ?? "").trim();
}

/** @param {unknown} value */
function cloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** @param {unknown} value */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
