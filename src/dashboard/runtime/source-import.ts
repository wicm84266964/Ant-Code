import { catalogModelFromProbe, parseContextWindowInput, type ImportProviderCatalogInput } from "../../config-v2/import-provider-catalog.ts";
import { dashboardV2ErrorResult, saveV2AgentRouting, saveV2ImportedSource, saveV2ModelContext, saveV2ProviderAgentModels } from "../model-settings-v2.ts";
import { officialModelSource, officialSourceApiKey, officialSourceStatus } from "../../model-gateway/official-sources.ts";
import { probeGatewayConnection } from "./gateway-probe.ts";
import type { DashboardFactoryState } from "./factory-state.ts";
import type { DashboardRequestInput } from "./types.ts";
import { loadConfig } from "../../config/load-config.ts";
import { gatewayProfileOwner, modelOptions, publicAgentModelTiers, publicGatewayConfig, publicGatewayProfiles, publicVisionAgent } from "./public-config.ts";
import { isConfigV2Enabled, reconcileActiveDashboardSessionsAfterV2Mutation, refreshDashboardSessionAfterV2Mutation, sessionStatusFromConfig } from "./session-model.ts";

export function publicOfficialSources(env: NodeJS.ProcessEnv) {
  return officialSourceStatus(env);
}

export async function runtimeImportModelSource(ctx: DashboardFactoryState, input: DashboardRequestInput = {}) {
  const kind = String(input.kind ?? "").trim();
  const configEnv = await ctx.resolveConfigEnv();
  if (kind === "official") {
    const source = officialModelSource(String(input.id ?? "deepseek-official"));
    if (!source) return { ok: false, status: 404, error: "没有这个官方来源" };
    const apiKey = officialSourceApiKey(source.id, configEnv);
    if (!apiKey) return { ok: false, status: 400, error: `未检测到 ${source.envKey}` };
    const probed = await probeGatewayConnection({
      gatewayUrl: source.gatewayUrl,
      gatewayProtocol: source.protocol,
      gatewayApiKey: apiKey
    }, {});
    const probedModels = probed.ok && Array.isArray(probed.models) ? probed.models : [];
    const models = probedModels.length > 0
      ? probedModels.map((model) => catalogModelFromProbe(model))
      : source.models.map((model) => catalogModelFromProbe(model));
    return persistImportedSource(ctx, input, {
      providerId: source.id,
      displayName: source.label,
      protocol: source.protocol,
      baseURL: source.gatewayUrl,
      authMode: "ambient",
      models,
      activateFirst: input.activateFirst !== false
    });
  }
  const gatewayUrl = String(input.gatewayUrl ?? "").trim();
  const gatewayProtocol = String(input.gatewayProtocol ?? "openai-chat").trim();
  const gatewayApiKey = String(input.gatewayApiKey ?? "").trim();
  if (kind === "refresh") {
    const providerId = String(input.providerId ?? input.profileId ?? "").trim();
    const config = await loadConfig({ cwd: ctx.cwd, env: configEnv });
    const profile = publicGatewayProfiles(config).find((item) => item.id === providerId);
    const loaded = (config.lab?.gatewayProfiles ?? []).find((item) => item.id === providerId);
    if (!profile || !loaded) return { ok: false, status: 404, error: "找不到这个来源" };
    const official = officialModelSource(providerId);
    const apiKey = official
      ? officialSourceApiKey(official.id, configEnv)
      : String(input.gatewayApiKey ?? "").trim() || String(loaded.gatewayApiKey ?? "").trim();
    if (!apiKey) return { ok: false, status: 400, error: "这个来源没有可用密钥" };
    const gatewayUrlForProbe = String(input.gatewayUrl ?? "").trim() || String(loaded.gatewayUrl ?? profile.gatewayUrl);
    const protocolForProbe = String(input.gatewayProtocol ?? "").trim() || String(loaded.gatewayProtocol ?? profile.gatewayProtocol ?? "openai-chat");
    const probed = await probeGatewayConnection({
      gatewayUrl: gatewayUrlForProbe,
      gatewayProtocol: protocolForProbe,
      gatewayApiKey: apiKey
    }, {});
    if (!probed.ok || !Array.isArray(probed.models) || probed.models.length === 0) {
      return probed.ok ? { ok: false, status: 502, error: "没有读到可调用模型" } : probed;
    }
    const scope = refreshProviderScope({
      requested: input.scope ?? input.saveTarget,
      owner: config.configV2?.provenance?.providers?.[providerId]
    });
    const requested = String(input.scope ?? input.saveTarget ?? "global").trim();
    return persistImportedSource(ctx, {
      ...input,
      scope,
      saveTarget: scope,
      expectedRevision: scope === requested ? input.expectedRevision : revisionForScope(config, scope)
    }, {
      providerId,
      displayName: savedRouteDisplayName(input.displayName ?? input.routeName, profile.label, providerId),
      protocol: protocolForProbe,
      baseURL: String(probed.suggestedGatewayUrl ?? gatewayUrlForProbe),
      authMode: official ? "ambient" : "credential",
      apiKey: official ? undefined : String(input.gatewayApiKey ?? "").trim() || undefined,
      models: probed.models.map((model) => catalogModelFromProbe(model)),
      activateFirst: false,
      agentModels: agentModelsFromInput(input)
    });
  }
  if (!gatewayUrl || !gatewayApiKey) {
    return { ok: false, status: 400, error: "第三方来源需要 API 地址和密钥" };
  }
  const probed = await probeGatewayConnection({ gatewayUrl, gatewayProtocol, gatewayApiKey }, {});
  if (!probed.ok || !Array.isArray(probed.models) || probed.models.length === 0) {
    return probed.ok ? { ok: false, status: 502, error: "没有读到可调用模型" } : probed;
  }
  const routeName = String(input.routeName ?? input.displayName ?? "").trim();
  if (!routeName) {
    return { ok: false, status: 400, error: "请填写路线名。同一地址的不同密钥要用不同路线名。" };
  }
  const providerId = providerRouteId(routeName);
  if (!providerId) {
    return { ok: false, status: 400, error: "路线名需要以字母开头，只能包含字母、数字、点、下划线或连字符。" };
  }
  return persistImportedSource(ctx, input, {
    providerId,
    displayName: routeName,
    create: true,
    protocol: gatewayProtocol,
    baseURL: String(probed.suggestedGatewayUrl ?? gatewayUrl),
    authMode: "credential",
    apiKey: gatewayApiKey,
    models: probed.models.map((model) => catalogModelFromProbe(model)),
    activateFirst: input.activateFirst === true,
    agentModels: agentModelsFromInput(input)
  });
}

async function persistImportedSource(ctx: DashboardFactoryState, input: DashboardRequestInput, imported: ImportProviderCatalogInput) {
  const saved = await saveV2ImportedSource({
    cwd: ctx.cwd,
    env: await ctx.resolveConfigEnv(),
    scope: input.scope ?? input.saveTarget ?? "global",
    expectedRevision: input.expectedRevision,
    expectedCredentialsRevision: input.expectedCredentialsRevision ?? input.credentialsRevision,
    input: imported
  });
  const refreshed = await loadConfig({ cwd: ctx.cwd, env: await ctx.resolveConfigEnv() });
  return {
    ...saved,
    models: modelOptions(refreshed),
    gatewayConfig: publicGatewayConfig(refreshed),
    gatewayProfiles: publicGatewayProfiles(refreshed),
    agentModelTiers: publicAgentModelTiers(refreshed),
    visionAgent: publicVisionAgent(refreshed),
    sessionStatus: sessionStatusFromConfig(refreshed),
    officialSources: officialSourceStatus(await ctx.resolveConfigEnv())
  };
}

export function contextChangeAppliesNextTurn(state: {
  running?: boolean;
  session?: {
    model?: unknown;
    modelSelection?: unknown;
    config?: { lab?: { activeGatewayProfile?: unknown } | null } | null;
  } | null;
} | null | undefined, providerId: string, modelId: string) {
  if (!state?.running || !state.session) return false;
  if (String(state.session.model ?? "").trim() !== modelId) return false;
  const selection = state.session.modelSelection;
  const selectionProvider = selection && typeof selection === "object"
    ? String((selection as { provider?: unknown }).provider ?? "").trim()
    : "";
  const provider = selectionProvider || String(state.session.config?.lab?.activeGatewayProfile ?? "").trim();
  return !provider || provider === providerId;
}

export async function runtimeSaveModelContext(ctx: DashboardFactoryState, input: DashboardRequestInput = {}) {
  const providerId = String(input.providerId ?? input.profileId ?? "").trim();
  const modelId = String(input.modelId ?? "").trim();
  if (!providerId || !modelId || /[\r\n\t]/.test(modelId) || modelId.length > 160) {
    return { ok: false, status: 400, error: "请选择要设置上下文的模型" };
  }
  const parsed = parseContextWindowInput(input.contextTokens ?? input.contextWindow);
  if (!parsed.ok) return parsed;
  const sessionId = String(input.sessionId ?? "").trim();
  const configEnv = await ctx.resolveConfigEnv();
  const config = await loadConfig({ cwd: ctx.cwd, env: configEnv });
  if (!isConfigV2Enabled(config)) {
    return { ok: false, status: 400, error: "当前配置还不能按模型保存上下文" };
  }
  const owner = gatewayProfileOwner(config, providerId);
  const ownerType = owner && typeof owner === "object" ? String(owner.type ?? "").trim() : "";
  if (ownerType && ownerType !== "global" && ownerType !== "project") {
    return { ok: false, status: 400, error: "这个来源不能在这里修改上下文" };
  }
  const requested = String(input.scope ?? input.saveTarget ?? "").trim();
  const scope = ownerType === "global" || ownerType === "project"
    ? ownerType
    : refreshProviderScope({ requested, owner: ownerType });
  const clientRevision = String(input.expectedRevision ?? "").trim();
  const expectedRevision = scope === requested && clientRevision
    ? clientRevision
    : revisionForScope(config, scope);
  if (!expectedRevision) {
    return { ok: false, status: 409, error: "配置版本还没读到，请刷新设置后再保存" };
  }
  let saved;
  try {
    saved = await saveV2ModelContext({
      cwd: ctx.cwd,
      env: configEnv,
      scope,
      expectedRevision,
      expectedCredentialsRevision: input.expectedCredentialsRevision ?? input.credentialsRevision,
      providerId,
      modelId,
      contextWindow: parsed.value
    });
  } catch (error) {
    return dashboardV2ErrorResult(error);
  }
  const refreshed = await loadConfig({ cwd: ctx.cwd, env: await ctx.resolveConfigEnv() });
  const appliesNextTurn = contextChangeAppliesNextTurn(sessionId ? ctx.active.get(sessionId) : null, providerId, modelId);
  const activeViews = reconcileActiveDashboardSessionsAfterV2Mutation(ctx.active, refreshed);
  const sessionView = sessionId
    ? activeViews.get(sessionId) ?? await refreshDashboardSessionAfterV2Mutation({
      active: ctx.active,
      cwd: ctx.cwd,
      env: ctx.runtimeEnv,
      sessionId,
      config: refreshed
    })
    : null;
  return {
    ...saved,
    scope,
    contextTokens: parsed.value,
    contextApplies: appliesNextTurn ? "next-turn" : "now",
    models: modelOptions(refreshed),
    gatewayConfig: publicGatewayConfig(refreshed),
    gatewayProfiles: publicGatewayProfiles(refreshed),
    sessionStatus: sessionView?.sessionStatus ?? sessionStatusFromConfig(refreshed)
  };
}

export async function runtimeSaveProviderAgentModels(ctx: DashboardFactoryState, input: DashboardRequestInput = {}) {
  const saved = await saveV2ProviderAgentModels({
    cwd: ctx.cwd,
    env: await ctx.resolveConfigEnv(),
    scope: input.scope ?? input.saveTarget ?? "global",
    expectedRevision: input.expectedRevision,
    expectedCredentialsRevision: input.expectedCredentialsRevision ?? input.credentialsRevision,
    providerId: String(input.providerId ?? input.profileId ?? ""),
    cheap: String(input.cheap ?? ""),
    defaultModel: String(input.defaultModel ?? input.default ?? ""),
    strong: String(input.strong ?? ""),
    visionModel: String(input.visionModel ?? "")
  });
  const refreshed = await loadConfig({ cwd: ctx.cwd, env: await ctx.resolveConfigEnv() });
  return {
    ...saved,
    gatewayProfiles: publicGatewayProfiles(refreshed),
    agentModelTiers: publicAgentModelTiers(refreshed),
    visionAgent: publicVisionAgent(refreshed)
  };
}

export async function runtimeSaveAgentRouting(ctx: DashboardFactoryState, input: DashboardRequestInput = {}) {
  const saved = await saveV2AgentRouting({
    cwd: ctx.cwd,
    env: await ctx.resolveConfigEnv(),
    scope: input.scope ?? input.saveTarget ?? "global",
    expectedRevision: input.expectedRevision,
    expectedCredentialsRevision: input.expectedCredentialsRevision ?? input.credentialsRevision,
    tiers: routingTiers(input.tiers),
    visionModel: routingRef(input.visionModel)
  });
  const refreshed = await loadConfig({ cwd: ctx.cwd, env: await ctx.resolveConfigEnv() });
  return {
    ...saved,
    agentModelTiers: publicAgentModelTiers(refreshed),
    visionAgent: publicVisionAgent(refreshed),
    gatewayProfiles: publicGatewayProfiles(refreshed)
  };
}

function agentModelsFromInput(input: DashboardRequestInput) {
  return {
    cheap: String(input.agentCheapModel ?? input.cheap ?? ""),
    defaultModel: String(input.agentDefaultModel ?? input.defaultModel ?? ""),
    strong: String(input.agentStrongModel ?? input.strong ?? ""),
    visionModel: String(input.visionAgentModel ?? input.visionModel ?? "")
  };
}

function routingTiers(value: unknown) {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    cheap: routingRef(record.cheap),
    default: routingRef(record.default),
    strong: routingRef(record.strong)
  };
}

function routingRef(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const record = value as { provider?: unknown; model?: unknown };
  const provider = String(record.provider ?? "").trim();
  const model = String(record.model ?? "").trim();
  return provider && model ? { provider, model } : null;
}

export function refreshProviderScope(input: { requested?: unknown; owner?: unknown }) {
  const owner = String(input.owner ?? "").trim();
  if (owner === "global" || owner === "project") return owner;
  return String(input.requested ?? "").trim() === "project" ? "project" : "global";
}

function revisionForScope(config: { configV2?: { revisions?: unknown } }, scope: "global" | "project") {
  const revisions = config.configV2?.revisions;
  if (!revisions || typeof revisions !== "object") return undefined;
  const value = (revisions as Record<string, unknown>)[scope];
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function savedRouteDisplayName(requested: unknown, current: unknown, fallback: unknown) {
  const name = String(requested ?? "").trim();
  if (name) return name;
  const existing = String(current ?? "").trim();
  if (existing) return existing;
  return String(fallback ?? "").trim();
}

function providerRouteId(name: string) {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(slug) ? slug : "";
}

function hostname(value: string) {
  try {
    return new URL(value).hostname.replace(/^api\./, "");
  } catch {
    return "";
  }
}
