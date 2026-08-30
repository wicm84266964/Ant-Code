import fs from "node:fs/promises";
import path from "node:path";
import { createHash, createHmac, randomBytes, type Hash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  createSession,
  persistSessionSnapshot,
  runSessionTurn,
  SessionModelSelectionUnresolvedError,
  type AgentSession
} from "../../core/session.ts";
import {
  GOAL_ABS_MAX_AUTO_CONTINUES,
  GOAL_CONTINUE_KIND,
  GOAL_MIN_AUTO_CONTINUES,
  applyGoalEndedAt,
  bumpGoalRoundCount,
  clearGoalEndedAt,
  resolveGoalMaxAutoContinues,
  buildGoalContinuePrompt,
  disableGoalState,
  enableGoalState,
  resolveGoalPreviousPermissionMode,
  evaluateGoalCompletion,
  goalUnattendedQuestionResult,
  publicGoalSnapshot,
  shouldSkipGoalContinue,
  stripGoalStatusMarkers
} from "../../core/goal.ts";
import {
  applyRuntimeModelSelection,
  currentRuntimeModelSelection,
  patchSessionModelSelectionMetadata,
  resolveSessionModelSelection,
  type SessionModelSelectionResolution,
  type RuntimeModelSelection
} from "../../config-v2/runtime-selection.ts";
import { clearSessionContext, compactSessionContextWithModel, createContextWindow, summarizeContextWindow } from "../../core/context-window.ts";
import { createLabModelGateway } from "../../model-gateway/client.ts";
import { redactGatewayText } from "../../model-gateway/errors.ts";
import { listConfiguredModels, normalizeAgentModelTiers, normalizeReasoningEfforts, resolveModelSelection, type LabModel } from "../../model-gateway/models.ts";
import {
  inferCatalogReasoning,
  normalizeCapabilityEfforts,
  reasoningProbeEffortIds
} from "../../model-gateway/reasoning-capabilities.ts";
import { resolveWorkspaceTrust, trustWorkspace as saveWorkspaceTrust } from "../../permissions/workspace-trust.ts";
import { createSessionStore } from "../../storage/session-store.ts";
import { GATEWAY_PROTOCOLS, NETWORK_MODES, globalConfigPath, loadConfig, localProjectConfigPath, type LabAgentConfig } from "../../config/load-config.ts";
import { cancelBackgroundAgentTasks, listBackgroundAgentTasks } from "../../agents/background-registry.ts";
import { cancelBackgroundTerminalTasks, listBackgroundTerminalTasks } from "../../agents/background-terminal-registry.ts";
import { createAgentTaskStore } from "../../agents/task-store.ts";
import { createAgentTaskGroupStore, summarizeGroupStatus } from "../../agents/task-group-store.ts";
import { cloneWorkflowState } from "../../tools/workflow-tools.ts";
import { mapSessionEventToDashboard, permissionRequestToActivity } from "../events.ts";
import { applyPermissionMode, approvalKeyFor, buildApprovalPreview, normalizePermissionMode, permissionModeSummary, sanitizeSensitiveValue } from "../permissions.ts";
import { collectSessionFiles } from "../files.ts";
import { getAntCodeVersion } from "../../version.ts";
import { mutateJsonConfig } from "../config-store.ts";
import {
  dashboardV2ErrorResult,
  deleteV2Provider,
  deleteV2ProviderModel,
  publicV2ConfigState,
  saveV2DefaultModel,
  saveV2ProviderModel
} from "../model-settings-v2.ts";

import {
  DASHBOARD_SETTINGS_FIELDS,
  DASHBOARD_SETTINGS_MANAGED_ENV
} from "./types.ts";
import type {
  CatalogErr,
  CatalogResult,
  DashboardRequestInput,
  DashboardSettingsInputResult,
  GatewayDiscoveryFailure,
  ModelConfigInputResult
} from "./types.ts";
import {
  gatewayInferenceUrl
} from "./gateway-probe.ts";
import {
  gatewayProfilesFromConfig,
  parseConfigUrl,
  positiveIntegerOrNull,
  urlHost
} from "./model-config.ts";
import {
  isPlainObject
} from "./util.ts";


export function normalizeDashboardSettingsInput(input: DashboardRequestInput, config: LabAgentConfig, env: NodeJS.ProcessEnv = process.env): DashboardSettingsInputResult {
  const section = String(input.section ?? input.category ?? "").trim().toLowerCase();
  const saveTarget = normalizeModelConfigSaveTarget(input.saveTarget ?? input.scope ?? input.target ?? "project");
  const values = isPlainObject(input.settings) ? input.settings : input;
  if (![
    "transcript",
    "network",
    "agents",
    "reliability"
  ].includes(section)) {
    return { ok: false, status: 400, error: "请选择有效的设置分类" };
  }
  const changedFields = dashboardSettingsChangedFields(input, section, env);

  if (section === "transcript") {
    const enabled = booleanSetting(values.enabled ?? values.transcriptEnabled);
    const rawRetentionDays = values.retentionDays;
    const retentionDays = rawRetentionDays === null
      || String(rawRetentionDays ?? "").trim().toLowerCase() === "forever"
      ? null
      : Number(rawRetentionDays);
    const encryption = String(values.encryption ?? "").trim().toLowerCase();
    if (enabled === null) {
      return { ok: false, status: 400, error: "历史记录开关必须是布尔值" };
    }
    if (retentionDays !== null && (!Number.isInteger(retentionDays) || retentionDays < 0 || retentionDays > 3650)) {
      return { ok: false, status: 400, error: "历史记录保留期限必须是永久或 0 到 3650 天" };
    }
    if (!["off", "optional", "required"].includes(encryption)) {
      return { ok: false, status: 400, error: "请选择有效的历史记录加密模式" };
    }
    if (enabled && retentionDays !== 0 && encryption === "required" && !hasRuntimeEnvValue(env, "LAB_AGENT_TRANSCRIPT_KEY")) {
      return { ok: false, status: 400, error: "强制加密需要先配置 LAB_AGENT_TRANSCRIPT_KEY" };
    }
    const managedError = changedManagedSetting([
      ["LAB_AGENT_TRANSCRIPT_ENABLED", enabled, config.transcript?.enabled !== false, "历史记录开关"],
      ["LAB_AGENT_TRANSCRIPT_RETENTION_DAYS", retentionDays, config.transcript?.retentionDays === undefined ? 30 : config.transcript.retentionDays, "历史记录保留期限"],
      ["LAB_AGENT_TRANSCRIPT_ENCRYPTION", encryption, String(config.transcript?.encryption ?? "off"), "历史记录加密模式"]
    ], env);
    if (managedError) return managedError;
    return { ok: true, section, saveTarget, changedFields, values: { enabled, retentionDays, encryption } };
  }

  if (section === "network") {
    const mode = String(values.mode ?? values.networkMode ?? "").trim().toLowerCase();
    if (!(NETWORK_MODES as readonly string[]).includes(mode)) {
      return { ok: false, status: 400, error: `不支持的网络模式：${mode || "（空）"}` };
    }
    if (config.security?.sensitivity === "high" && !["offline", "lab-only"].includes(mode)) {
      return { ok: false, status: 400, error: "高敏感度项目只能使用离线或实验室网络模式" };
    }
    const normalizedHosts = normalizeDashboardAllowedHosts(values.allowedHosts);
    if (!normalizedHosts.ok) {
      return normalizedHosts;
    }
    const managedHosts = new Set(dashboardManagedAllowedHosts(env));
    const configuredHosts = normalizedHosts.hosts.filter((host) => !managedHosts.has(host));
    const requiredHosts = gatewayHostsForSettings(config).filter((host) => !managedHosts.has(host));
    const allowedHosts = Array.from(new Set([...configuredHosts, ...requiredHosts]));
    const managedError = changedManagedSetting([
      ["LAB_AGENT_NETWORK_MODE", mode, config.networkMode, "网络模式"]
    ], env);
    if (managedError) return managedError;
    return { ok: true, section, saveTarget, changedFields, values: { mode, allowedHosts } };
  }

  if (section === "agents") {
    const maxParallelReadonlyAgentRuns = Number(values.maxParallelReadonlyAgentRuns);
    const backgroundWakeupEnabled = booleanSetting(values.backgroundWakeupEnabled);
    const backgroundByDefault = booleanSetting(values.backgroundByDefault);
    const reviewGateEnabled = booleanSetting(values.reviewGateEnabled);
    const syncModelTiersOnSwitch = booleanSetting(values.syncModelTiersOnSwitch);
    const goalMaxAutoContinues = values.goalMaxAutoContinues === undefined || values.goalMaxAutoContinues === ""
      ? resolveGoalMaxAutoContinues(config)
      : Number(values.goalMaxAutoContinues);
    if (!Number.isInteger(maxParallelReadonlyAgentRuns) || maxParallelReadonlyAgentRuns < 1 || maxParallelReadonlyAgentRuns > 8) {
      return { ok: false, status: 400, error: "只读子智能体并行数必须是 1 到 8 的整数" };
    }
    if ([backgroundWakeupEnabled, backgroundByDefault, reviewGateEnabled, syncModelTiersOnSwitch].includes(null)) {
      return { ok: false, status: 400, error: "子智能体开关必须是布尔值" };
    }
    if (
      !Number.isInteger(goalMaxAutoContinues)
      || goalMaxAutoContinues < GOAL_MIN_AUTO_CONTINUES
      || goalMaxAutoContinues > GOAL_ABS_MAX_AUTO_CONTINUES
    ) {
      return { ok: false, status: 400, error: "Goal 自动续跑上限必须是 1 到 100 的整数" };
    }
    return {
      ok: true,
      section,
      saveTarget,
      changedFields,
      values: {
        maxParallelReadonlyAgentRuns,
        backgroundWakeupEnabled,
        backgroundByDefault,
        reviewGateEnabled,
        syncModelTiersOnSwitch,
        goalMaxAutoContinues
      }
    };
  }

  const maxRetries = Number(values.maxRetries);
  const timeoutMs = Number(values.timeoutMs);
  const idleTimeoutMs = Number(values.idleTimeoutMs);
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 5) {
    return { ok: false, status: 400, error: "网关重试次数必须是 0 到 5 的整数" };
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 900000) {
    return { ok: false, status: 400, error: "网关总超时必须在 1 到 900 秒之间" };
  }
  if (!Number.isInteger(idleTimeoutMs) || idleTimeoutMs < 1000 || idleTimeoutMs > 300000) {
    return { ok: false, status: 400, error: "网关空闲超时必须在 1 到 300 秒之间" };
  }
  const managedError = changedManagedSetting([
    ["LAB_MODEL_GATEWAY_MAX_RETRIES", maxRetries, Number(config.lab?.gatewayMaxRetries), "网关重试次数"],
    ["LAB_MODEL_GATEWAY_TIMEOUT_MS", timeoutMs, Number(config.lab?.gatewayTimeoutMs), "网关总超时"],
    ["LAB_MODEL_GATEWAY_IDLE_TIMEOUT_MS", idleTimeoutMs, Number(config.lab?.gatewayIdleTimeoutMs), "网关空闲超时"]
  ], env);
  if (managedError) return managedError;
  return { ok: true, section, saveTarget, changedFields, values: { maxRetries, timeoutMs, idleTimeoutMs } };
}

/** @param {Record<string, any>} targetConfig @param {Record<string, any>} normalized */


/** @param {Record<string, any>} targetConfig @param {Record<string, any>} normalized */
export function buildDashboardSettingsConfig(targetConfig: Record<string, unknown>, normalized: { section?: unknown; changedFields?: unknown; values?: Record<string, unknown> }) {
  const target = isPlainObject(targetConfig) ? targetConfig : {};
  const values = isPlainObject(normalized.values) ? normalized.values : {};
  const section = String(normalized.section ?? "");
  const changedFields = new Set(Array.isArray(normalized.changedFields)
    ? normalized.changedFields.map(String)
    : DASHBOARD_SETTINGS_FIELDS[section] ?? []);
  if (changedFields.size === 0) {
    return { ...target };
  }
  if (section === "transcript") {
    const transcript: Record<string, unknown> = { ...(isPlainObject(target.transcript) ? target.transcript : {}) };
    if (changedFields.has("enabled")) transcript.enabled = values.enabled;
    if (changedFields.has("retentionDays")) transcript.retentionDays = values.retentionDays;
    if (changedFields.has("encryption")) transcript.encryption = values.encryption;
    return {
      ...target,
      transcript
    };
  }
  if (section === "network") {
    const next: Record<string, unknown> = { ...target };
    if (changedFields.has("mode")) next.networkMode = values.mode;
    if (changedFields.has("allowedHosts")) next.allowedHosts = values.allowedHosts;
    return next;
  }
  if (section === "agents") {
    const agents: Record<string, unknown> = { ...(isPlainObject(target.agents) ? target.agents : {}) };
    if (changedFields.has("syncModelTiersOnSwitch")) {
      agents.syncModelTiersOnSwitch = values.syncModelTiersOnSwitch;
    }
    if (changedFields.has("maxParallelReadonlyAgentRuns")) {
      agents.orchestration = {
        ...(isPlainObject(agents.orchestration) ? agents.orchestration : {}),
        maxParallelReadonlyAgentRuns: values.maxParallelReadonlyAgentRuns
      };
    }
    if (changedFields.has("backgroundWakeupEnabled") || changedFields.has("backgroundByDefault")) {
      const backgroundWakeup: Record<string, unknown> = { ...(isPlainObject(agents.backgroundWakeup) ? agents.backgroundWakeup : {}) };
      if (changedFields.has("backgroundWakeupEnabled")) {
        backgroundWakeup.enabled = values.backgroundWakeupEnabled;
      }
      if (changedFields.has("backgroundByDefault")) {
        backgroundWakeup.defaultForModelAgentRun = values.backgroundByDefault;
      }
      agents.backgroundWakeup = backgroundWakeup;
    }
    if (changedFields.has("reviewGateEnabled")) {
      agents.reviewGate = {
        ...(isPlainObject(agents.reviewGate) ? agents.reviewGate : {}),
        enabled: values.reviewGateEnabled
      };
    }
    if (changedFields.has("goalMaxAutoContinues")) {
      agents.goal = {
        ...(isPlainObject(agents.goal) ? agents.goal : {}),
        maxAutoContinues: values.goalMaxAutoContinues
      };
    }
    return { ...target, agents };
  }
  const lab: Record<string, unknown> = { ...(isPlainObject(target.lab) ? target.lab : {}) };
  if (changedFields.has("maxRetries")) lab.gatewayMaxRetries = values.maxRetries;
  if (changedFields.has("timeoutMs")) lab.gatewayTimeoutMs = values.timeoutMs;
  if (changedFields.has("idleTimeoutMs")) lab.gatewayIdleTimeoutMs = values.idleTimeoutMs;
  return { ...target, lab };
}

/** @param {Record<string, any>} input @param {string} section @param {NodeJS.ProcessEnv} env */


/** @param {Record<string, any>} input @param {string} section @param {NodeJS.ProcessEnv} env */
export function dashboardSettingsChangedFields(input: DashboardRequestInput, section: string, env: NodeJS.ProcessEnv) {
  const fields = section === "transcript" || section === "network" || section === "agents" || section === "reliability"
    ? DASHBOARD_SETTINGS_FIELDS[section]
    : [];
  const requested = Object.prototype.hasOwnProperty.call(input, "changedFields")
    ? Array.isArray(input.changedFields) ? input.changedFields : []
    : fields;
  const managed = section === "transcript" || section === "network" || section === "agents" || section === "reliability"
    ? DASHBOARD_SETTINGS_MANAGED_ENV[section]
    : {};
  const changedFields: string[] = [];
  for (const rawField of requested) {
    const field = dashboardSettingsFieldAlias(section, String(rawField ?? "").trim());
    if (!fields.includes(field) || changedFields.includes(field)) continue;
    if (managed[field] && hasRuntimeEnvValue(env, managed[field])) continue;
    changedFields.push(field);
  }
  return changedFields;
}

/** @param {string} section @param {string} field */


/** @param {string} section @param {string} field */
export function dashboardSettingsFieldAlias(section: string, field: string) {
  if (section === "transcript" && field === "transcriptEnabled") return "enabled";
  if (section === "network" && field === "networkMode") return "mode";
  return field;
}

/** @param {NodeJS.ProcessEnv} env */


/** @param {NodeJS.ProcessEnv} env */
export function dashboardManagedAllowedHosts(env: NodeJS.ProcessEnv) {
  return normalizeDashboardAllowedHosts([
    ...String(env.LAB_AGENT_ALLOWED_HOSTS ?? "").split(","),
    urlHost(env.LAB_MODEL_GATEWAY_URL),
    urlHost(env.LAB_MODEL_GATEWAY_HEALTH_URL)
  ]).hosts;
}

/** @param {unknown} value */


/** @param {unknown} value */
export function booleanSetting(value: unknown) {
  if (value === true || value === false) return value;
  if (String(value).toLowerCase() === "true") return true;
  if (String(value).toLowerCase() === "false") return false;
  return null;
}

/** @param {Array<[string, unknown, unknown, string]>} entries @param {NodeJS.ProcessEnv} env */


/** @param {Array<[string, unknown, unknown, string]>} entries @param {NodeJS.ProcessEnv} env */
export function changedManagedSetting(entries: Array<[string, unknown, unknown, string]>, env: NodeJS.ProcessEnv): { ok: false; status: number; error: string } | null {
  const changed = entries.find(([key, requested, current]) => hasRuntimeEnvValue(env, key) && requested !== current);
  return changed
    ? { ok: false, status: 409, error: `${changed[3]}由环境变量 ${changed[0]} 管理` }
    : null;
}

/** @param {NodeJS.ProcessEnv} env @param {string} key */


/** @param {NodeJS.ProcessEnv} env @param {string} key */
export function hasRuntimeEnvValue(env: NodeJS.ProcessEnv, key: string) {
  return env?.[key] !== undefined && env?.[key] !== null && String(env[key]).trim() !== "";
}

/** @param {unknown} value */


/** @param {unknown} value */
export function normalizeDashboardAllowedHosts(value: unknown): { ok: true; hosts: string[] } | { ok: false; status: number; error: string; hosts: string[] } {
  const entries = Array.isArray(value)
    ? value
    : String(value ?? "").split(/[,\s]+/);
  const hosts = [];
  const seen = new Set();
  for (const raw of entries) {
    const host = String(raw ?? "").trim().replace(/\.$/, "").toLowerCase();
    if (!host) continue;
    if (!validDashboardHost(host)) {
      return { ok: false, status: 400, error: `无效的允许主机：${host}`, hosts: [] };
    }
    if (!seen.has(host)) {
      seen.add(host);
      hosts.push(host);
    }
  }
  return { ok: true, hosts };
}

/** @param {string} host */


/** @param {string} host */
export function validDashboardHost(host: string) {
  if (!host || /[\s/@]/.test(host) || host.includes("://")) return false;
  try {
    const parsed = new URL(`http://${host}`);
    return parsed.hostname === host && parsed.port === "" && parsed.pathname === "/";
  } catch {
    return false;
  }
}

/** @param {Record<string, any>} config */


/** @param {Record<string, any>} config */
export function gatewayHostsForSettings(config: LabAgentConfig | Record<string, unknown>) {
  const lab = isPlainObject(config.lab) ? config.lab : null;
  const hosts = [];
  for (const value of [
    lab?.gatewayUrl,
    lab?.gatewayHealthUrl,
    ...gatewayProfilesFromConfig(config).flatMap((profile) => [profile.gatewayUrl, profile.gatewayHealthUrl])
  ]) {
    const host = urlHost(value);
    if (host) hosts.push(host.toLowerCase());
  }
  return Array.from(new Set(hosts));
}

/**
 * @param {Record<string, any>} input
 * @param {Record<string, any>} config
 * @param {{ ids?: unknown; models?: unknown }} [catalogEvidence]
 * @returns {Record<string, any>}
 */


/**
 * @param {Record<string, any>} input
 * @param {Record<string, any>} config
 * @param {{ ids?: unknown; models?: unknown }} [catalogEvidence]
 * @returns {Record<string, any>}
 */
export function normalizeModelConfigInput(input: DashboardRequestInput, config: LabAgentConfig | Record<string, unknown>, catalogEvidence: { ids?: unknown; models?: unknown } = {}): ModelConfigInputResult {
  const rawGatewayUrl = String(input.gatewayUrl ?? "").trim();
  const parsedGatewayUrl = parseConfigUrl(rawGatewayUrl);
  if (!parsedGatewayUrl) {
    return { ok: false, status: 400, error: "请输入有效的网关 URL" };
  }
  const gatewayHealthUrl = String(input.gatewayHealthUrl ?? "").trim();
  if (gatewayHealthUrl && !parseConfigUrl(gatewayHealthUrl)) {
    return { ok: false, status: 400, error: "请输入有效的健康检查 URL，或留空" };
  }
  const lab = isPlainObject(config.lab) ? config.lab : null;
  const gatewayProtocol = String(input.gatewayProtocol ?? lab?.gatewayProtocol ?? "openai-chat").trim();
  if (!(GATEWAY_PROTOCOLS as readonly string[]).includes(gatewayProtocol)) {
    return { ok: false, status: 400, error: `不支持的网关协议：${gatewayProtocol}` };
  }
  const gatewayUrl = gatewayInferenceUrl(parsedGatewayUrl, gatewayProtocol);
  const modelId = String(input.modelId ?? input.id ?? "").trim();
  if (!modelId || /[\r\n\t]/.test(modelId) || modelId.length > 160) {
    return { ok: false, status: 400, error: "请输入有效的模型 ID" };
  }
  const label = String(input.label ?? "").trim();
  const contextTokens = positiveIntegerOrNull(input.contextTokens);
  const modalities = normalizeModelInputModalities(input);
  const agentModelTiersProvided = Object.prototype.hasOwnProperty.call(input, "agentModelTiers")
    || ["agentCheapModel", "agentDefaultModel", "agentStrongModel"].some((field) => (
      Object.prototype.hasOwnProperty.call(input, field)
    ));
  const requestedTiers = isPlainObject(input.agentModelTiers) ? input.agentModelTiers : {};
  const agentModelTiers = normalizeAgentModelTiers({
    cheap: input.agentCheapModel ?? requestedTiers.cheap,
    default: input.agentDefaultModel ?? requestedTiers.default,
    strong: input.agentStrongModel ?? requestedTiers.strong
  });
  const visionAgentModelProvided = Object.prototype.hasOwnProperty.call(input, "visionAgentModel")
    || Object.prototype.hasOwnProperty.call(input, "visionModel");
  const visionAgentModel = String(input.visionAgentModel ?? input.visionModel ?? "").trim();
  const catalog = normalizeCatalogModelInput(catalogEvidence.ids, catalogEvidence.models);
  if (!catalog.ok) return catalog;
  const manualAgentModels = normalizeManualAgentModelIds(input.manualAgentModelIds);
  if (!manualAgentModels.ok) return manualAgentModels;
  const saveTarget = normalizeModelConfigSaveTarget(input.saveTarget ?? input.scope ?? input.target);
  const gatewayApiKey = String(input.gatewayApiKey ?? "").trim();
  const credentialAction = normalizeCredentialAction(input.credentialAction ?? input.apiKeyAction, gatewayApiKey);
  if (credentialAction === "replace" && !gatewayApiKey) {
    return { ok: false, status: 400, error: "请输入新的 API Key，或选择保留现有 Key" };
  }
  const reasoningEfforts = normalizeReasoningEffortInput(input.reasoningEfforts ?? input.supportedReasoningEfforts);
  const requestedDefaultReasoningEffort = String(input.defaultReasoningEffort ?? "").trim().toLowerCase();
  const defaultReasoningEffort = reasoningEfforts.some((effort: { id?: string; default?: boolean }) => effort.id === requestedDefaultReasoningEffort)
    ? requestedDefaultReasoningEffort
    : reasoningEfforts.find((effort: { id?: string; default?: boolean }) => effort.default === true)?.id ?? null;
  const previousGatewayProtocol = String(input.previousGatewayProtocol ?? input.originalGatewayProtocol ?? "openai-chat").trim();
  const parsedPreviousGatewayUrl = parseConfigUrl(String(input.previousGatewayUrl ?? input.originalGatewayUrl ?? "").trim());
  return {
    ok: true,
    saveTarget,
    profileId: String(input.providerId ?? input.profileId ?? input.gatewayProfileId ?? "").trim(),
    gatewayUrl,
    gatewayHealthUrl,
    gatewayProtocol,
    gatewayApiKey,
    credentialAction,
    previousModelId: String(input.previousModelId ?? input.originalModelId ?? "").trim(),
    previousGatewayUrl: parsedPreviousGatewayUrl
      ? gatewayInferenceUrl(parsedPreviousGatewayUrl, previousGatewayProtocol)
      : "",
    previousGatewayProtocol,
    replaceModels: input.replaceModels === true,
    switchToModel: input.switchToModel !== false,
    applyAgentDefaults: input.applyAgentDefaults === true,
    agentModelTiersProvided,
    visionAgentModelProvided,
    visionAgentModel,
    catalogModelIds: catalog.ids,
    catalogModels: catalog.models ?? [],
    manualAgentModelIds: manualAgentModels.ids,
    model: {
      id: modelId,
      label: label || modelId,
      ...(Object.prototype.hasOwnProperty.call(input, "description")
        ? { description: String(input.description ?? "").trim() }
        : {}),
      thinking: input.thinking === true || reasoningEfforts.length > 0,
      reasoningEfforts: reasoningEfforts.map((effort) => ({ id: effort.id, label: effort.label, description: effort.description })),
      defaultReasoningEffort,
      modalities,
      agentModelTiers,
      ...(contextTokens ? { contextTokens } : {})
    }
  };
}

/** @param {unknown} value @returns {Record<string, any>} */


/** @param {unknown} value @returns {Record<string, any>} */
export function normalizeManualAgentModelIds(value: unknown): { ok: true; ids: string[] } | { ok: false; status: number; code: string; error: string } {
  if (value === undefined || value === null) return { ok: true, ids: [] };
  if (!Array.isArray(value) || value.length > 4) {
    return { ok: false, status: 400, code: "CONFIG_V2_INVALID_MANUAL_MODEL_IDS", error: "手工子智能体模型 ID 格式无效" };
  }
  const ids = [];
  const exact = new Set();
  const folded = new Map();
  for (const entry of value) {
    if (typeof entry !== "string" || !validCatalogModelId(entry.trim())) {
      return { ok: false, status: 400, code: "CONFIG_V2_INVALID_MANUAL_MODEL_IDS", error: "手工子智能体模型 ID 无效" };
    }
    const id = entry.trim();
    if (exact.has(id)) continue;
    const previous = folded.get(id.toLowerCase());
    if (previous && previous !== id) {
      return {
        ok: false,
        status: 409,
        code: "CONFIG_V2_MODEL_ID_CASE_COLLISION",
        error: `手工模型 ${previous} 与 ${id} 仅大小写不同，无法安全确定模型 ID`
      };
    }
    exact.add(id);
    folded.set(id.toLowerCase(), id);
    ids.push(id);
  }
  return { ok: true, ids };
}

/** @param {unknown} idsValue @param {unknown} modelsValue @returns {Record<string, any>} */


/** @param {unknown} idsValue @param {unknown} modelsValue @returns {Record<string, any>} */
export function normalizeCatalogModelInput(idsValue: unknown, modelsValue: unknown): CatalogResult {
  const catalog = normalizeCatalogModelIdInput(idsValue);
  if (!catalog.ok) return catalog;
  if (modelsValue === undefined || modelsValue === null) {
    return { ...catalog, models: [] };
  }
  if (!Array.isArray(modelsValue) || modelsValue.length > 2_048) {
    return invalidModelCatalog("模型目录元数据格式无效，请重新读取模型列表");
  }

  const canonicalByFold = new Map(catalog.ids.map((id: string) => [id.toLowerCase(), id]));
  const seen = new Set();
  const models = [];
  for (const entry of modelsValue) {
    if (!isPlainObject(entry) || typeof entry.id !== "string") {
      return invalidModelCatalog("模型目录元数据包含无效的模型条目");
    }
    const requestedId = entry.id.trim();
    const id = canonicalByFold.get(requestedId.toLowerCase());
    if (!id || !validCatalogModelId(requestedId)) {
      return invalidModelCatalog("模型目录元数据引用了未经当前目录确认的模型 ID");
    }
    if (seen.has(id)) continue;
    seen.add(id);

    const rawLabel = entry.label ?? entry.displayName ?? id;
    if (typeof rawLabel !== "string") {
      return invalidModelCatalog("模型目录元数据包含无效的模型名称");
    }
    const label = rawLabel.trim() || id;
    if (label.length > 160 || /[\r\n\t\0]/.test(label)) {
      return invalidModelCatalog("模型目录元数据包含无效的模型名称");
    }

    const modalities = normalizeCatalogModalities(entry.modalities ?? entry.inputModalities);
    if (!modalities.ok) return modalities;
    const contextValue = entry.contextTokens ?? entry.contextWindow;
    if (contextValue !== undefined && contextValue !== null
      && (!Number.isSafeInteger(Number(contextValue)) || Number(contextValue) <= 0)) {
      return invalidModelCatalog("模型目录元数据包含无效的上下文长度");
    }
    if (entry.thinking !== undefined && typeof entry.thinking !== "boolean") {
      return invalidModelCatalog("模型目录元数据包含无效的思考能力标记");
    }
    const reasoning = normalizeCatalogReasoning(entry.reasoningEfforts, entry.defaultReasoningEffort);
    if (!reasoning.ok) return reasoning;
    const reasoningDiscovery = normalizeCatalogReasoningDiscovery(entry.reasoningDiscovery);
    models.push({
      id,
      label,
      modalities: modalities.values,
      thinking: entry.thinking === true || reasoning.efforts.length > 0,
      ...(contextValue !== undefined && contextValue !== null ? { contextTokens: contextValue } : {}),
      ...(reasoning.efforts.length > 0 ? { reasoningEfforts: reasoning.efforts } : {}),
      ...(reasoning.defaultEffort ? { defaultReasoningEffort: reasoning.defaultEffort } : {}),
      ...(reasoningDiscovery ? { reasoningDiscovery } : {})
    });
  }
  return { ...catalog, models };
}

/** @param {unknown} value @returns {Record<string, any>} */


/** @param {unknown} value @returns {Record<string, any>} */
export function normalizeCatalogModelIdInput(value: unknown): CatalogResult {
  if (value === undefined || value === null) return { ok: true, ids: [] };
  if (!Array.isArray(value) || value.length > 2_048) {
    return { ok: false, status: 400, code: "CONFIG_V2_INVALID_MODEL_CATALOG", error: "模型目录格式无效，请重新读取模型列表" };
  }
  const ids = [];
  const exact = new Set();
  const folded = new Map();
  for (const entry of value) {
    if (typeof entry !== "string") {
      return { ok: false, status: 400, code: "CONFIG_V2_INVALID_MODEL_CATALOG", error: "模型目录包含无效的模型 ID" };
    }
    const id = entry.trim();
    if (!validCatalogModelId(id)) {
      return { ok: false, status: 400, code: "CONFIG_V2_INVALID_MODEL_CATALOG", error: "模型目录包含无效的模型 ID" };
    }
    if (exact.has(id)) continue;
    const key = id.toLowerCase();
    const previous = folded.get(key);
    if (previous && previous !== id) {
      return {
        ok: false,
        status: 409,
        code: "CONFIG_V2_MODEL_ID_CASE_COLLISION",
        error: `模型目录中的 ${previous} 与 ${id} 仅大小写不同，无法安全确定上游 ID`
      };
    }
    exact.add(id);
    folded.set(key, id);
    ids.push(id);
  }
  return { ok: true, ids };
}

/** @param {unknown} value @returns {Record<string, any>} */


/** @param {unknown} value @returns {Record<string, any>} */
export function normalizeCatalogModalities(value: unknown): { ok: true; values: string[] } | CatalogErr {
  if (value === undefined || value === null) return { ok: true, values: ["text"] };
  if (!Array.isArray(value) || value.length > 16) {
    return invalidModelCatalog("模型目录元数据包含无效的输入类型");
  }
  const modalities = new Set(["text"]);
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length > 32) {
      return invalidModelCatalog("模型目录元数据包含无效的输入类型");
    }
    const modality = entry.trim().toLowerCase();
    if (modality === "text") continue;
    if (modality === "image") {
      modalities.add("image");
      continue;
    }
    return invalidModelCatalog("模型目录元数据包含不支持的输入类型");
  }
  return { ok: true, values: [...modalities] };
}

/** @param {unknown} value @param {unknown} defaultValue @returns {Record<string, any>} */


/** @param {unknown} value @param {unknown} defaultValue @returns {Record<string, any>} */
export function normalizeCatalogReasoning(value: unknown, defaultValue: unknown): { ok: true; efforts: Array<{ id: string; label: string; description: string }>; defaultEffort: string } | CatalogErr {
  if (value === undefined || value === null) return { ok: true, efforts: [], defaultEffort: "" };
  if (!Array.isArray(value) || value.length > 32) {
    return invalidModelCatalog("模型目录元数据包含无效的思考档位");
  }
  const efforts = [];
  const seen = new Set();
  for (const entry of value) {
    const source = typeof entry === "string" ? { id: entry } : entry;
    if (!isPlainObject(source)) return invalidModelCatalog("模型目录元数据包含无效的思考档位");
    const id = typeof source.id === "string" ? source.id.trim().toLowerCase() : "";
    if (!/^[a-z0-9_-]{1,32}$/.test(id)) {
      return invalidModelCatalog("模型目录元数据包含无效的思考档位");
    }
    if (seen.has(id)) continue;
    const rawLabel = source.label ?? source.name ?? id;
    const rawDescription = source.description ?? "";
    if (typeof rawLabel !== "string" || rawLabel.length > 80 || /[\r\n\t\0]/.test(rawLabel)
      || typeof rawDescription !== "string" || rawDescription.length > 1_024) {
      return invalidModelCatalog("模型目录元数据包含无效的思考档位说明");
    }
    seen.add(id);
    efforts.push({ id, label: rawLabel.trim() || id, description: rawDescription });
  }
  if (defaultValue !== undefined && defaultValue !== null && typeof defaultValue !== "string") {
    return invalidModelCatalog("模型目录元数据包含无效的默认思考档位");
  }
  const requestedDefault = String(defaultValue ?? "").trim().toLowerCase();
  const normalizedEfforts = collapseDisabledDiscoveryEfforts(efforts, requestedDefault);
  const exactDefault = normalizedEfforts.some((effort: { id?: string; default?: boolean }) => effort.id === requestedDefault)
    ? requestedDefault
    : isDisabledDiscoveryEffort(requestedDefault)
      ? normalizedEfforts.find((effort: { id?: string; default?: boolean }) => isDisabledDiscoveryEffort(effort.id))?.id ?? ""
      : "";
  return {
    ok: true,
    efforts: normalizedEfforts.map((effort) => ({
      id: effort.id,
      label: effort.label ?? effort.id,
      description: effort.description ?? ""
    })),
    defaultEffort: exactDefault || ""
  };
}

/** @param {unknown} value */


/** @param {unknown} value */
export function isDisabledDiscoveryEffort(value: unknown) {
  return ["none", "off"].includes(String(value ?? "").trim().toLowerCase());
}

/** @param {Array<Record<string, any>>} efforts @param {unknown} preferred */


/** @param {Array<Record<string, any>>} efforts @param {unknown} preferred */
export function collapseDisabledDiscoveryEfforts(
  efforts: Array<{ id: string; label?: string; description?: string; default?: boolean }>,
  preferred: unknown = ""
) {
  const preferredId = String(preferred ?? "").trim().toLowerCase();
  const disabledId = isDisabledDiscoveryEffort(preferredId)
    && efforts.some((effort: { id?: string; default?: boolean }) => effort.id === preferredId)
    ? preferredId
    : efforts.find((effort: { id?: string; default?: boolean }) => isDisabledDiscoveryEffort(effort.id))?.id ?? "";
  let keptDisabled = false;
  return efforts.filter((effort: { id?: string; default?: boolean }) => {
    if (!isDisabledDiscoveryEffort(effort.id)) return true;
    if (keptDisabled || effort.id !== disabledId) return false;
    keptDisabled = true;
    return true;
  });
}

/**
 * This function only receives catalog metadata retained behind the opaque,
 * server-validated discovery token. Keep the persisted marker deliberately
 * small so arbitrary upstream metadata cannot become runtime configuration.
 *
 * @param {unknown} value
 */


/**
 * This function only receives catalog metadata retained behind the opaque,
 * server-validated discovery token. Keep the persisted marker deliberately
 * small so arbitrary upstream metadata cannot become runtime configuration.
 *
 * @param {unknown} value
 */
export function normalizeCatalogReasoningDiscovery(value: unknown) {
  if (!isPlainObject(value)) return null;
  const discovery = /** @type {Record<string, any>} */ (value);
  const source = boundedDiscoveryField(discovery.source, 64).toLowerCase();
  if (!source || !/^[a-z0-9][a-z0-9_-]*$/.test(source)) return null;
  const confidence = boundedDiscoveryField(discovery.confidence, 64).toLowerCase();
  const path = nullableDiscoveryField(discovery.path, 256);
  const presetId = nullableDiscoveryField(discovery.presetId, 160);
  return {
    source,
    confidence: confidence || "unknown",
    path,
    presetId
  };
}

/** @param {unknown} value @param {number} limit */


/** @param {unknown} value @param {number} limit */
export function boundedDiscoveryField(value: unknown, limit: number) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return text.length <= limit && !/[\u0000-\u001f\u007f]/.test(text) ? text : "";
}

/** @param {unknown} value @param {number} limit */


/** @param {unknown} value @param {number} limit */
export function nullableDiscoveryField(value: unknown, limit: number) {
  if (value === undefined || value === null || value === "") return null;
  return boundedDiscoveryField(value, limit) || null;
}

/** @param {string} id */


/** @param {string} id */
export function validCatalogModelId(id: string) {
  return Boolean(id) && id.length <= 160 && !/[\r\n\t\0]/.test(id);
}

/** @param {string} error */


/** @param {string} error */
export function invalidModelCatalog(error: string): CatalogErr {
  return { ok: false, status: 400, code: "CONFIG_V2_INVALID_MODEL_CATALOG", error };
}

/** @param {unknown} value @param {unknown} gatewayApiKey */


/** @param {unknown} value @param {unknown} gatewayApiKey */
export function normalizeCredentialAction(value: unknown, gatewayApiKey: unknown = "") {
  const action = String(value ?? "").trim().toLowerCase();
  if (["keep", "replace", "clear"].includes(action)) return action;
  return gatewayApiKey ? "replace" : "keep";
}

/** @param {unknown} value */


/** @param {unknown} value */
export function normalizeReasoningEffortInput(value: unknown): Array<{ id: string; label?: string; description?: string; default: boolean }> {
  let entries = value;
  if (typeof entries === "string") {
    const text = entries.trim();
    if (!text) return [];
    try {
      entries = JSON.parse(text);
    } catch {
      entries = text.split(/[,\s]+/).filter(Boolean);
    }
  }
  if (!Array.isArray(entries)) return [];
  const normalized = normalizeReasoningEfforts(entries);
  return normalized.map((effort) => ({
    id: String(effort.id ?? ""),
    label: effort.label,
    description: effort.description,
    default: entries.some((entry) => (
      isPlainObject(entry)
      && String(entry.id ?? entry.value ?? "").trim().toLowerCase() === effort.id
      && entry.default === true
    ))
  }));
}


export function normalizeModelConfigSaveTarget(value: unknown) {
  const target = String(value ?? "global").trim().toLowerCase();
  if (target === "global" || target === "user" || target === "default") {
    return "global";
  }
  return "project";
}


export function modelConfigTargetPath(cwd: string, env: NodeJS.ProcessEnv | undefined, saveTarget: unknown = "project") {
  return saveTarget === "global"
    ? globalConfigPath(env)
    : localProjectConfigPath(cwd);
}


export function normalizeModelInputModalities(input: DashboardRequestInput) {
  const modalities = new Set(["text"]);
  const values = Array.isArray(input.modalities)
    ? input.modalities
    : typeof input.modalities === "string" ? input.modalities.split(/[, ]+/) : [];
  for (const value of values) {
    const text = String(value ?? "").trim().toLowerCase();
    if (["image", "images", "vision", "visual", "multimodal", "图片", "视觉"].includes(text)) {
      modalities.add("image");
    }
  }
  if (input.vision === true || input.imageInput === true || input.multimodal === true) {
    modalities.add("image");
  }
  return Array.from(modalities);
}


export async function readJsonConfig(filePath: string) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    const data = JSON.parse(text);
    return isPlainObject(data) ? data : {};
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}


export async function mutateDashboardConfig(
  filePath: string,
  update: (target: Record<string, unknown>, context: { revision: string }) => unknown
) {
  try {
    return { ok: true, ...await mutateJsonConfig(filePath, async (data, context) => {
      const next = await update(data, context);
      if (!isPlainObject(next)) {
        throw new TypeError("Configuration update must return a JSON object");
      }
      return next;
    }) };
  } catch (error) {
    if (isPlainObject(error) && isPlainObject(error.dashboardResult)) {
      return error.dashboardResult;
    }
    const code = isPlainObject(error) ? error.code : undefined;
    if (code === "CONFIG_REVISION_CONFLICT" || code === "CONFIG_LOCK_TIMEOUT") {
      return {
        ok: false,
        status: 409,
        code,
        error: "配置已被其他进程修改，请刷新后重试"
      };
    }
    throw error;
  }
}


export function dashboardConfigResultError(result: Record<string, unknown> | GatewayDiscoveryFailure | ModelConfigInputResult) {
  const message = "error" in result && result.error ? String(result.error) : "配置更新失败";
  const error = new Error(message) as Error & { dashboardResult: unknown };
  error.dashboardResult = result;
  return error;
}


export async function dashboardConfigEnv(cwd: string, env?: NodeJS.ProcessEnv) {
  void cwd;
  return env;
}
