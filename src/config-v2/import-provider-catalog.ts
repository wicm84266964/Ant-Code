import { inferCatalogReasoning, preferPrefixedCatalog } from "../model-gateway/reasoning-capabilities.ts";
import { CONFIG_V2_NAMESPACES, credentialReferenceForProvider } from "./migrate-v1.ts";
import { validateSettingsDocument, type ConfigV2SettingsDocument } from "./schema.ts";

type JsonObject = Record<string, unknown>;

export type ImportedCatalogModel = {
  id: string;
  displayName?: string;
  contextWindow?: number | null;
};

export type ImportProviderCatalogInput = {
  providerId: string;
  displayName: string;
  create?: boolean;
  protocol: string;
  baseURL: string;
  authMode: "ambient" | "credential";
  apiKey?: string;
  models: ImportedCatalogModel[];
  activateFirst?: boolean;
  agentModels?: {
    cheap?: string;
    defaultModel?: string;
    strong?: string;
    visionModel?: string;
  };
};

export function importProviderCatalog(document: unknown, input: ImportProviderCatalogInput) {
  const current = cloneDocument(document);
  const providerId = slug(input.providerId);
  if (!providerId) {
    return { ok: false as const, status: 400, error: "来源 ID 无效" };
  }
  const models = preferPrefixedCatalog(uniqueModels(input.models));
  if (models.length === 0) {
    return { ok: false as const, status: 400, error: "没有可保存的模型" };
  }
  const providers = providerMap(current);
  if (input.create && isRecord(providers[providerId])) {
    return { ok: false as const, status: 409, error: "路线名已存在，请换一个名字" };
  }
  const existing = isRecord(providers[providerId]) ? providers[providerId] : {};
  const existingAuth = isRecord(existing.auth) ? existing.auth : {};
  const existingRef = existingAuth.mode === "credential" ? String(existingAuth.ref ?? "") : "";
  const auth = input.authMode === "ambient"
    ? { mode: "ambient" }
    : { mode: "credential", ref: existingRef || credentialReferenceForProvider(providerId) };
  const provider: JsonObject = {
    displayName: input.displayName,
    transport: {
      protocol: input.protocol,
      baseURL: input.baseURL
    },
    auth,
    models: models.map((model) => catalogModelRecord(
      model,
      input.protocol,
      existingModelById(existing.models).get(model.id.toLowerCase())
    ))
  };
  if (isRecord(existing.agents)) provider.agents = existing.agents;
  if (isRecord(existing.reliability)) provider.reliability = existing.reliability;
  applyImportedAgentModels(provider, input.agentModels, models.map((model) => model.id));
  providers[providerId] = provider;
  current.namespaces[CONFIG_V2_NAMESPACES.providers] = { providers };
  const selection = defaultSelection(current);
  const shouldActivate = input.activateFirst === true || !selection?.provider || !selection?.model;
  if (shouldActivate) {
    current.namespaces[CONFIG_V2_NAMESPACES.defaultModel] = {
      selection: { provider: providerId, model: models[0].id }
    };
  }
  const validated = validateSettingsDocument(current);
  return {
    ok: true as const,
    document: validated,
    providerId,
    modelId: models[0].id,
    credentialMutation: input.authMode === "credential" && input.apiKey
      ? { op: "set", ref: auth.ref, value: input.apiKey }
      : null
  };
}

export function saveProviderAgentModels(document: unknown, input: {
  providerId: string;
  cheap: string;
  defaultModel: string;
  strong: string;
  visionModel: string;
}) {
  const current = cloneDocument(document);
  const providers = providerMap(current);
  const provider = providers[input.providerId];
  if (!isRecord(provider)) return { ok: false as const, status: 404, error: "找不到这个来源" };
  const known = new Set((Array.isArray(provider.models) ? provider.models : [])
    .filter(isRecord)
    .map((model) => String(model.id ?? "").trim())
    .filter(Boolean));
  const pick = (value: string) => {
    const id = value.trim();
    if (!id) return "";
    if (!known.has(id)) return null;
    return id;
  };
  const cheap = pick(input.cheap);
  const defaultModel = pick(input.defaultModel);
  const strong = pick(input.strong);
  const visionModel = pick(input.visionModel);
  if (cheap === null || defaultModel === null || strong === null || visionModel === null) {
    return { ok: false as const, status: 400, error: "子智能体只能选择这个来源里的模型" };
  }
  const agents: JsonObject = isRecord(provider.agents) ? { ...provider.agents } : {};
  const tiers: JsonObject = {};
  if (cheap) tiers.cheap = cheap;
  if (defaultModel) tiers.default = defaultModel;
  if (strong) tiers.strong = strong;
  if (Object.keys(tiers).length > 0) agents.modelTiers = tiers;
  else delete agents.modelTiers;
  agents.vision = {
    enabled: Boolean(visionModel),
    model: visionModel || null,
    autoUseWhenMainModelTextOnly: true
  };
  provider.agents = agents;
  providers[input.providerId] = provider;
  current.namespaces[CONFIG_V2_NAMESPACES.providers] = { providers };
  return { ok: true as const, document: validateSettingsDocument(current), providerId: input.providerId };
}

export function saveAgentRouting(document: unknown, input: {
  tiers: Record<string, { provider: string; model: string } | null>;
  visionModel: { provider: string; model: string } | null;
}) {
  const current = cloneDocument(document);
  const previousRouting = current.namespaces[CONFIG_V2_NAMESPACES.agentRouting];
  const previous = isRecord(previousRouting) ? previousRouting : {};
  const modelTiers: JsonObject = {};
  for (const [tier, reference] of Object.entries(input.tiers)) {
    if (!reference?.provider || !reference.model) continue;
    modelTiers[tier] = { provider: reference.provider, model: reference.model };
  }
  const routing: JsonObject = {};
  if (isRecord(previous.compat)) routing.compat = previous.compat;
  if (Object.keys(modelTiers).length > 0) routing.modelTiers = modelTiers;
  routing.vision = {
    enabled: Boolean(input.visionModel),
    model: input.visionModel ? { provider: input.visionModel.provider, model: input.visionModel.model } : null,
    autoUseWhenMainModelTextOnly: true
  };
  current.namespaces[CONFIG_V2_NAMESPACES.agentRouting] = routing;
  return { ok: true as const, document: validateSettingsDocument(current) };
}

function applyImportedAgentModels(provider: JsonObject, agentModels: ImportProviderCatalogInput["agentModels"], modelIds: string[]) {
  if (!agentModels) return;
  const known = new Set(modelIds);
  const pick = (value: unknown) => {
    const id = String(value ?? "").trim();
    return id && known.has(id) ? id : "";
  };
  const cheap = pick(agentModels.cheap);
  const defaultModel = pick(agentModels.defaultModel);
  const strong = pick(agentModels.strong);
  const visionModel = pick(agentModels.visionModel);
  if (!cheap && !defaultModel && !strong && !visionModel) return;
  const agents: JsonObject = isRecord(provider.agents) ? { ...provider.agents } : {};
  const tiers: JsonObject = {};
  if (cheap) tiers.cheap = cheap;
  if (defaultModel) tiers.default = defaultModel;
  if (strong) tiers.strong = strong;
  if (Object.keys(tiers).length > 0) agents.modelTiers = tiers;
  agents.vision = {
    enabled: Boolean(visionModel),
    model: visionModel || null,
    autoUseWhenMainModelTextOnly: true
  };
  provider.agents = agents;
}

function catalogModelRecord(model: ImportedCatalogModel, protocol: string, previous?: JsonObject) {
  const inferred = inferCatalogReasoning({ id: model.id }, { protocol });
  const record: JsonObject = {
    id: model.id,
    displayName: model.displayName || model.id,
    inputModalities: ["text"]
  };
  if (inferred.reasoningEfforts.length > 0) {
    record.thinking = true;
    record.reasoning = {
      efforts: inferred.reasoningEfforts.map((effort) => ({ id: effort.id, label: effort.label })),
      ...(inferred.defaultReasoningEffort ? { default: inferred.defaultReasoningEffort } : {})
    };
  }
  // A saved window stays until the user clears it. A directory length only fills an empty field.
  const contextWindow = positiveContextWindow(previous?.contextWindow) ?? positiveContextWindow(model.contextWindow);
  if (contextWindow) record.contextWindow = contextWindow;
  return record;
}

export function catalogModelFromProbe(model: {
  id?: unknown;
  label?: unknown;
  displayName?: unknown;
  contextTokens?: unknown;
  contextWindow?: unknown;
}): ImportedCatalogModel {
  const id = String(model.id ?? "").trim();
  const contextWindow = positiveContextWindow(model.contextTokens ?? model.contextWindow);
  return {
    id,
    displayName: String(model.displayName ?? model.label ?? id).trim() || id,
    ...(contextWindow ? { contextWindow } : {})
  };
}

export function parseContextWindowInput(value: unknown): { ok: true; value: number | null } | { ok: false; status: 400; error: string } {
  if (value === undefined || value === null) return { ok: true, value: null };
  const text = String(value).trim();
  if (!text) return { ok: true, value: null };
  const contextWindow = positiveContextWindow(text);
  if (!contextWindow) return { ok: false, status: 400, error: "上下文请填写正整数，例如 400000" };
  return { ok: true, value: contextWindow };
}

export function positiveContextWindow(value: unknown) {
  const text = typeof value === "string" ? value.trim() : value;
  if (typeof text === "string" && !/^[0-9]+$/.test(text)) return null;
  const number = typeof text === "number" ? text : typeof text === "string" ? Number(text) : Number.NaN;
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

export function saveModelContextWindow(document: unknown, input: {
  providerId: string;
  modelId: string;
  contextWindow: number | null;
}) {
  const current = cloneDocument(document);
  const providers = providerMap(current);
  const provider = providers[input.providerId];
  if (!isRecord(provider)) return { ok: false as const, status: 404, error: "找不到这个来源" };
  const models = Array.isArray(provider.models) ? provider.models.map((model) => isRecord(model) ? { ...model } : model) : [];
  const index = models.findIndex((model) => isRecord(model) && String(model.id ?? "") === input.modelId);
  if (index < 0) return { ok: false as const, status: 404, error: "找不到这个模型" };
  const model = { ...(models[index] as JsonObject) };
  if (input.contextWindow == null) delete model.contextWindow;
  else model.contextWindow = input.contextWindow;
  models[index] = model;
  provider.models = models;
  providers[input.providerId] = provider;
  current.namespaces[CONFIG_V2_NAMESPACES.providers] = { providers };
  return {
    ok: true as const,
    document: validateSettingsDocument(current),
    providerId: input.providerId,
    modelId: input.modelId,
    contextWindow: input.contextWindow
  };
}

function existingModelById(models: unknown) {
  const byId = new Map<string, JsonObject>();
  for (const model of Array.isArray(models) ? models : []) {
    if (!isRecord(model)) continue;
    const id = String(model.id ?? "").trim().toLowerCase();
    if (id) byId.set(id, model);
  }
  return byId;
}

function uniqueModels(models: ImportedCatalogModel[]) {
  const seen = new Set<string>();
  const result: ImportedCatalogModel[] = [];
  for (const model of models) {
    const id = String(model.id ?? "").trim();
    if (!id || seen.has(id.toLowerCase())) continue;
    seen.add(id.toLowerCase());
    const contextWindow = positiveContextWindow(model.contextWindow);
    result.push({
      id,
      displayName: String(model.displayName ?? id).trim() || id,
      ...(contextWindow ? { contextWindow } : {})
    });
  }
  return result;
}

function slug(value: string) {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

function cloneDocument(document: unknown): ConfigV2SettingsDocument {
  if (!isRecord(document) || !isRecord(document.namespaces)) {
    return { settingsVersion: 2, namespaces: {} };
  }
  return JSON.parse(JSON.stringify(document)) as ConfigV2SettingsDocument;
}

function providerMap(document: ConfigV2SettingsDocument) {
  const namespace = document.namespaces[CONFIG_V2_NAMESPACES.providers];
  const providers = isRecord(namespace) && isRecord(namespace.providers) ? namespace.providers : {};
  return providers as Record<string, JsonObject>;
}

function defaultSelection(document: ConfigV2SettingsDocument) {
  const namespace = document.namespaces[CONFIG_V2_NAMESPACES.defaultModel];
  const selection = isRecord(namespace) ? namespace.selection : null;
  return isRecord(selection) ? selection : null;
}

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
