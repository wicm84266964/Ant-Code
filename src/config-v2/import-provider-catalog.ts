import { inferCatalogReasoning, preferPrefixedCatalog } from "../model-gateway/reasoning-capabilities.ts";
import { CONFIG_V2_NAMESPACES, credentialReferenceForProvider } from "./migrate-v1.ts";
import { validateSettingsDocument, type ConfigV2SettingsDocument } from "./schema.ts";

type JsonObject = Record<string, unknown>;

export type ImportedCatalogModel = {
  id: string;
  displayName?: string;
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
    models: models.map((model) => catalogModelRecord(model, input.protocol))
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

function catalogModelRecord(model: ImportedCatalogModel, protocol: string) {
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
  return record;
}

function uniqueModels(models: ImportedCatalogModel[]) {
  const seen = new Set<string>();
  const result: ImportedCatalogModel[] = [];
  for (const model of models) {
    const id = String(model.id ?? "").trim();
    if (!id || seen.has(id.toLowerCase())) continue;
    seen.add(id.toLowerCase());
    result.push({ id, displayName: String(model.displayName ?? id).trim() || id });
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
