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
  GATEWAY_DISCOVERY_TOKEN_TTL_MS,
  INVALID_REASONING_EFFORT_PROBE,
  MAX_GATEWAY_DISCOVERY_TOKENS,
  MODEL_CAPABILITY_PROBE_MAX_RESPONSE_BYTES,
  MODEL_CAPABILITY_PROBE_REQUEST_TIMEOUT_MS,
  MODEL_CAPABILITY_PROBE_TOTAL_TIMEOUT_MS
} from "./types.ts";
import type {
  DashboardRequestInput,
  GatewayDiscoveryCatalog,
  GatewayDiscoveryEntry,
  GatewayDiscoveryFailure,
  GatewayDiscoveryIdentity,
  GatewayDiscoveryReceipt,
  GatewayDiscoverySuccess,
  ReasoningProbeInput,
  ReasoningProbeRequestOptions,
  ReasoningProbeResult
} from "./types.ts";
import {
  gatewayProfileCredentialState,
  gatewayProfileForEndpoint,
  gatewayProfilesFromConfig,
  gatewayUrlOrigin,
  parseConfigUrl,
  positiveIntegerOrNull,
  publicGatewayUrl,
  sameGatewayProfileEndpoint
} from "./model-config.ts";
import {
  isConfigV2Enabled,
  normalizeDashboardClientId
} from "./session-model.ts";
import {
  collapseDisabledDiscoveryEfforts,
  isDisabledDiscoveryEffort,
  normalizeCatalogModelInput,
  normalizeCredentialAction,
  normalizeModelConfigSaveTarget,
  normalizeModelInputModalities
} from "./settings.ts";
import {
  clonePlainObject,
  isPlainObject
} from "./util.ts";


/** @param {unknown} value */
export function boundedGatewayDiscoveryTtl(value?: unknown) {
  const ttl = Number(value);
  return Number.isFinite(ttl) && ttl > 0
    ? Math.min(Math.floor(ttl), GATEWAY_DISCOVERY_TOKEN_TTL_MS)
    : GATEWAY_DISCOVERY_TOKEN_TTL_MS;
}

/**
 * Keep catalog evidence server-side. The browser receives only an opaque,
 * short-lived handle and cannot add IDs or model metadata to the discovery.
 *
 * @param {{
 *   discoveries: Map<string, Record<string, any>>;
 *   secret: Buffer;
 *   ttlMs: number;
 *   now: number;
 *   input: Record<string, any>;
 *   config: Record<string, any>;
 *   models: unknown;
 * }} options
 * @returns {GatewayDiscoveryReceipt | GatewayDiscoveryFailure}
 */


/**
 * Keep catalog evidence server-side. The browser receives only an opaque,
 * short-lived handle and cannot add IDs or model metadata to the discovery.
 *
 * @param {{
 *   discoveries: Map<string, Record<string, any>>;
 *   secret: Buffer;
 *   ttlMs: number;
 *   now: number;
 *   input: Record<string, any>;
 *   config: Record<string, any>;
 *   models: unknown;
 * }} options
 * @returns {GatewayDiscoveryReceipt | GatewayDiscoveryFailure}
 */
export function rememberGatewayDiscovery(options: {
  discoveries: Map<string, GatewayDiscoveryEntry>;
  secret: Buffer;
  ttlMs: number;
  now: number;
  input: DashboardRequestInput;
  config: LabAgentConfig | Record<string, unknown>;
  models: unknown;
}): GatewayDiscoveryReceipt | GatewayDiscoveryFailure {
  const models = Array.isArray(options.models) ? options.models : [];
  const catalog = normalizeCatalogModelInput(
    models.map((model) => String(isPlainObject(model) ? model.id ?? "" : "")).map((id) => id.trim()).filter(Boolean),
    models
  );
  if (!catalog.ok) {
    return {
      ok: false,
      status: 502,
      code: "GATEWAY_DISCOVERY_INVALID_CATALOG",
      error: catalog.error ?? "上游模型目录包含无法安全使用的条目"
    };
  }
  const identity = gatewayDiscoveryRequestIdentity(options.input, options.config, options.secret);
  if (!identity.ok) return identity;
  pruneGatewayDiscoveries(options.discoveries, options.now);
  while (options.discoveries.size >= MAX_GATEWAY_DISCOVERY_TOKENS) {
    const oldest = options.discoveries.keys().next().value;
    if (typeof oldest !== "string") break;
    options.discoveries.delete(oldest);
  }
  const token = randomBytes(32).toString("base64url");
  const expiresAt = options.now + options.ttlMs;
  const storedCatalog: GatewayDiscoveryCatalog = {
    ids: [...catalog.ids],
    models: Array.isArray(catalog.models) ? catalog.models.map((model) => ({ ...model })) : []
  };
  options.discoveries.set(token, {
    expiresAt,
    identity: identity.value,
    catalog: storedCatalog
  });
  return { ok: true, token, expiresAt, catalog: { ids: [...storedCatalog.ids], models: storedCatalog.models.map((model) => ({ ...model })) } };
}

/**
 * @param {{
 *   discoveries: Map<string, Record<string, any>>;
 *   secret: Buffer;
 *   now: number;
 *   input: Record<string, any>;
 *   config: Record<string, any>;
 * }} options
 * @returns {GatewayDiscoveryResolution | GatewayDiscoveryFailure}
 */


/**
 * @param {{
 *   discoveries: Map<string, Record<string, any>>;
 *   secret: Buffer;
 *   now: number;
 *   input: Record<string, any>;
 *   config: Record<string, any>;
 * }} options
 * @returns {GatewayDiscoveryResolution | GatewayDiscoveryFailure}
 */
export function resolveGatewayDiscovery(options: {
  discoveries: Map<string, GatewayDiscoveryEntry>;
  secret: Buffer;
  now: number;
  input: DashboardRequestInput;
  config: LabAgentConfig | Record<string, unknown>;
}): GatewayDiscoverySuccess | GatewayDiscoveryFailure {
  pruneGatewayDiscoveries(options.discoveries, options.now);
  const token = String(
    options.input.gatewayDiscoveryToken ?? options.input.discoveryToken ?? ""
  ).trim();
  if (!token) {
    return { ok: true, token: null, catalog: { ids: [], models: [] }, entry: null };
  }
  if (token.length > 256 || /[\u0000-\u001f\u007f]/.test(token)) {
    return staleGatewayDiscovery();
  }
  const entry = options.discoveries.get(token) ?? null;
  if (!entry) return staleGatewayDiscovery();
  const validation = validateGatewayDiscoveryEntry({
    entry,
    secret: options.secret,
    now: options.now,
    input: options.input,
    config: options.config
  });
  if (!validation.ok) return validation;
  return {
    ok: true,
    token,
    entry,
    catalog: {
      ids: [...entry.catalog.ids],
      models: clonePlainObject(entry.catalog.models)
    }
  };
}

/**
 * Discovery evidence remains retryable across validation and persistence
 * failures. Once a save succeeds, consume the exact in-memory handle so a
 * replay cannot apply the old catalog to another mutation.
 *
 * @param {Map<string, Record<string, any>>} discoveries
 * @param {Record<string, any>} discovery
 */


/**
 * Discovery evidence remains retryable across validation and persistence
 * failures. Once a save succeeds, consume the exact in-memory handle so a
 * replay cannot apply the old catalog to another mutation.
 *
 * @param {Map<string, Record<string, any>>} discoveries
 * @param {Record<string, any>} discovery
 */
export function consumeGatewayDiscovery(discoveries: Map<string, GatewayDiscoveryEntry>, discovery: GatewayDiscoverySuccess | Record<string, unknown>) {
  const token = String(discovery?.token ?? "").trim();
  if (token && discoveries.get(token) === discovery.entry) discoveries.delete(token);
}

/**
 * Convert a complete server-side active probe into exact catalog evidence.
 * When a directory proof is still valid, retain its other model metadata so
 * one capability probe does not discard agent-only routing choices.
 *
 * @param {Array<Record<string, any>>} models
 * @param {Record<string, any>} result
 */


/**
 * Convert a complete server-side active probe into exact catalog evidence.
 * When a directory proof is still valid, retain its other model metadata so
 * one capability probe does not discard agent-only routing choices.
 *
 * @param {Array<Record<string, any>>} models
 * @param {Record<string, any>} result
 */
export function mergeReasoningProbeIntoCatalog(models: Array<Record<string, unknown>>, result: Record<string, unknown>) {
  const modelId = String(result.modelId ?? "").trim();
  const existingModels = Array.isArray(models) ? clonePlainObject(models) : [];
  const index = existingModels.findIndex((model: Record<string, unknown>) => (
    String(model?.id ?? "").trim().toLowerCase() === modelId.toLowerCase()
  ));
  const previous = index >= 0 ? existingModels[index] : null;
  const canonicalId = String(previous?.id ?? modelId).trim() || modelId;
  const probedDefault = String(result.defaultReasoningEffort ?? "").trim().toLowerCase();
  const previousDisabled = normalizeCapabilityEfforts(previous?.reasoningEfforts)
    .find((effort: { id?: string; default?: boolean }) => isDisabledDiscoveryEffort(effort.id))?.id ?? "";
  const reasoningEfforts = collapseDisabledDiscoveryEfforts(
    normalizeCapabilityEfforts(result.reasoningEfforts),
    isDisabledDiscoveryEffort(probedDefault) ? probedDefault : previousDisabled
  );
  const effortIds = new Set(reasoningEfforts.map((effort: { id?: string; default?: boolean }) => effort.id));
  const previousDefault = String(previous?.defaultReasoningEffort ?? "").trim().toLowerCase();
  const defaultReasoningEffort = effortIds.has(previousDefault)
    ? previousDefault
    : effortIds.has(probedDefault) ? probedDefault : null;
  const probed = {
    ...(isPlainObject(previous) ? previous : {}),
    id: canonicalId,
    label: String(previous?.label ?? previous?.displayName ?? canonicalId).trim() || canonicalId,
    thinking: previous?.thinking === true || reasoningEfforts.length > 0,
    reasoningEfforts,
    defaultReasoningEffort,
    reasoningDiscovery: {
      source: "active-probe",
      confidence: "probed",
      path: String(isPlainObject(result.reasoningDiscovery) ? result.reasoningDiscovery.path ?? "" : "").trim() || null,
      presetId: null
    }
  };
  if (index >= 0) existingModels[index] = probed;
  else existingModels.push(probed);
  return existingModels;
}

/**
 * @param {{
 *   entry: Record<string, any> | null;
 *   secret: Buffer;
 *   now: number;
 *   input: Record<string, any>;
 *   config: Record<string, any>;
 * }} options
 * @returns {{ ok: true } | GatewayDiscoveryFailure}
 */


/**
 * @param {{
 *   entry: Record<string, any> | null;
 *   secret: Buffer;
 *   now: number;
 *   input: Record<string, any>;
 *   config: Record<string, any>;
 * }} options
 * @returns {{ ok: true } | GatewayDiscoveryFailure}
 */
export function validateGatewayDiscoveryEntry(options: {
  entry: GatewayDiscoveryEntry | Record<string, unknown> | null;
  secret: Buffer;
  now: number;
  input: DashboardRequestInput;
  config: LabAgentConfig | Record<string, unknown>;
}): { ok: true } | GatewayDiscoveryFailure {
  if (!options.entry) return { ok: true };
  const expiresAt = Number(options.entry.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= options.now) {
    return staleGatewayDiscovery();
  }
  const identity = gatewayDiscoveryRequestIdentity(options.input, options.config, options.secret);
  if (!identity.ok || !isDeepStrictEqual(identity.value, options.entry.identity)) {
    return staleGatewayDiscovery();
  }
  return { ok: true };
}

/** @param {Map<string, Record<string, any>>} discoveries @param {number} now */


/** @param {Map<string, Record<string, any>>} discoveries @param {number} now */
export function pruneGatewayDiscoveries(discoveries: Map<string, GatewayDiscoveryEntry>, now: number) {
  for (const [token, entry] of discoveries) {
    const expiresAt = Number(entry?.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) discoveries.delete(token);
  }
}

/** @returns {GatewayDiscoveryFailure} */


/** @returns {GatewayDiscoveryFailure} */
export function staleGatewayDiscovery(): GatewayDiscoveryFailure {
  return {
    ok: false,
    status: 409,
    code: "GATEWAY_DISCOVERY_STALE",
    error: "模型目录凭证已失效，请重新读取模型列表后保存"
  };
}

/**
 * @param {Record<string, any>} input
 * @param {Record<string, any>} config
 * @param {Buffer} secret
 * @returns {{ ok: true; value: Record<string, any> } | GatewayDiscoveryFailure}
 */


/**
 * @param {Record<string, any>} input
 * @param {Record<string, any>} config
 * @param {Buffer} secret
 * @returns {{ ok: true; value: Record<string, any> } | GatewayDiscoveryFailure}
 */
export function gatewayDiscoveryRequestIdentity(input: DashboardRequestInput, config: LabAgentConfig | Record<string, unknown>, secret: Buffer): GatewayDiscoveryIdentity {
  const lab = isPlainObject(config.lab) ? config.lab : null;
  const protocol = String(input.gatewayProtocol ?? lab?.gatewayProtocol ?? "openai-chat").trim();
  if (!(GATEWAY_PROTOCOLS as readonly string[]).includes(protocol)) {
    return { ok: false, status: 400, error: `不支持的网关协议：${protocol}` };
  }
  const parsed = parseConfigUrl(String(input.gatewayUrl ?? lab?.gatewayUrl ?? "").trim());
  if (!parsed) return { ok: false, status: 400, error: "请输入有效的 API 地址" };
  const credential = probeGatewayCredential(input, config, protocol, parsed.href);
  return {
    ok: true,
    value: {
      gatewayUrl: gatewayInferenceUrl(parsed, protocol),
      protocol,
      profileId: String(input.providerId ?? input.profileId ?? input.gatewayProfileId ?? "").trim(),
      scope: normalizeModelConfigSaveTarget(input.saveTarget ?? input.scope ?? input.target),
      clientId: normalizeDashboardClientId(input.clientId),
      config: gatewayDiscoveryConfigIdentity(config),
      credential: createHmac("sha256", secret)
        .update(credential)
        .digest("base64url")
    }
  };
}

/** @param {Record<string, any>} config */


/** @param {Record<string, any>} config */
export function gatewayDiscoveryConfigIdentity(config: LabAgentConfig | Record<string, unknown>) {
  if (!isConfigV2Enabled(config)) return { version: 1 };
  const configV2 = isPlainObject(config.configV2) ? config.configV2 : null;
  const revisions = configV2 && isPlainObject(configV2.revisions) ? configV2.revisions : null;
  return {
    version: 2,
    global: String(revisions?.global ?? ""),
    project: String(revisions?.project ?? ""),
    credentials: String(revisions?.credentials ?? "")
  };
}

/** @param {Record<string, any>} input @param {Record<string, any>} config */


/** @param {Record<string, any>} input @param {Record<string, any>} config */
export async function probeGatewayConnection(input: DashboardRequestInput, config: LabAgentConfig | Record<string, unknown>) {
  const lab = isPlainObject(config.lab) ? config.lab : null;
  const protocol = String(input.gatewayProtocol ?? lab?.gatewayProtocol ?? "openai-chat").trim();
  if (!(GATEWAY_PROTOCOLS as readonly string[]).includes(protocol)) {
    return { ok: false, status: 400, error: `不支持的网关协议：${protocol}` };
  }
  const rawUrl = String(input.gatewayUrl ?? lab?.gatewayUrl ?? "").trim();
  const parsed = parseConfigUrl(rawUrl);
  if (!parsed) {
    return { ok: false, status: 400, error: "请输入有效的 API 地址" };
  }
  const modelsUrl = gatewayModelsUrl(parsed);
  const suggestedGatewayUrl = gatewayInferenceUrl(parsed, protocol);
  const publicModelsUrl = publicGatewayUrl(modelsUrl);
  const publicSuggestedGatewayUrl = publicGatewayUrl(suggestedGatewayUrl);
  const gatewayApiKey = probeGatewayCredential(input, config, protocol, parsed.href);
  const headers: Record<string, string> = { accept: "application/json" };
  if (gatewayApiKey) {
    if (protocol === "anthropic-messages") {
      headers["x-api-key"] = gatewayApiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else {
      headers.authorization = `Bearer ${gatewayApiKey}`;
    }
  }
  let response;
  try {
    response = await fetch(modelsUrl, {
      method: "GET",
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(20_000)
    });
  } catch (error) {
    return {
      ok: false,
      status: 502,
      error: (error instanceof Error ? error.name : "") === "TimeoutError" ? "读取模型超时" : "无法连接模型来源",
      diagnostic: { stage: "connect", modelsUrl: publicModelsUrl, protocol }
    };
  }
  if (response.status >= 300 && response.status < 400) {
    await cancelProbeResponseBody(response);
    return {
      ok: false,
      status: 502,
      error: "模型目录地址返回重定向，已停止以避免转发凭据",
      diagnostic: { stage: "redirect", httpStatus: response.status, modelsUrl: publicModelsUrl }
    };
  }
  let body;
  try {
    body = await readProbeResponse(response);
  } catch (error) {
    return { ok: false, status: 502, error: error instanceof Error ? error.message : "模型目录响应过大" };
  }
  if (!response.ok) {
    return {
      ok: false,
      status: 502,
      error: response.status === 401 || response.status === 403
        ? "API Key 未通过验证"
        : `模型目录返回 HTTP ${response.status}`,
      diagnostic: { stage: response.status === 401 || response.status === 403 ? "auth" : "models", httpStatus: response.status, modelsUrl: publicModelsUrl }
    };
  }
  const contentType = String(response.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.includes("text/html") || /^\s*</.test(body)) {
    return {
      ok: false,
      status: 502,
      error: "这个地址返回了网页而不是模型目录，请检查 API 路径",
      diagnostic: { stage: "models", contentType: contentType || "text/html", modelsUrl: publicModelsUrl }
    };
  }
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    return {
      ok: false,
      status: 502,
      error: "模型目录不是有效 JSON",
      diagnostic: { stage: "models", contentType, modelsUrl: publicModelsUrl }
    };
  }
  const rawModels = /** @type {unknown[]} */ (
    Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : Array.isArray(json) ? json : []
  );
  const models = rawModels.map((model: unknown) => publicCatalogModel(model, protocol)).filter(Boolean);
  if (models.length === 0) {
    return {
      ok: false,
      status: 502,
      error: "连接成功，但模型目录为空或格式不受支持",
      diagnostic: { stage: "models", contentType, modelsUrl: publicModelsUrl }
    };
  }
  return {
    ok: true,
    protocol,
    modelsUrl: publicModelsUrl,
    suggestedGatewayUrl: publicSuggestedGatewayUrl,
    apiKeyUsed: Boolean(gatewayApiKey),
    models,
    modelCount: models.length,
    diagnostic: { stage: "complete", httpStatus: response.status, contentType }
  };
}

/**
 * @param {Record<string, any>} input
 * @param {Record<string, any>} config
 * @param {AbortSignal | undefined} signal
 */


/**
 * @param {Record<string, any>} input
 * @param {Record<string, any>} config
 * @param {AbortSignal | undefined} signal
 */
export async function probeModelReasoningCapabilities(input: DashboardRequestInput, config: LabAgentConfig | Record<string, unknown>, signal: AbortSignal | undefined): Promise<ReasoningProbeResult> {
  const lab = isPlainObject(config.lab) ? config.lab : null;
  const protocol = String(input.gatewayProtocol ?? lab?.gatewayProtocol ?? "openai-chat").trim();
  if (!["openai-chat", "openai-responses"].includes(protocol)) {
    return { ok: false, status: 400, error: `该协议不支持思考档位检测：${protocol}` };
  }
  const modelId = String(input.modelId ?? input.model ?? "").trim();
  if (!modelId || modelId.length > 160 || /[\r\n\t\0]/.test(modelId)) {
    return { ok: false, status: 400, error: "请输入有效的模型 ID" };
  }
  const rawUrl = String(input.gatewayUrl ?? lab?.gatewayUrl ?? "").trim();
  const parsed = parseConfigUrl(rawUrl);
  if (!parsed) {
    return { ok: false, status: 400, error: "请输入有效的 API 地址" };
  }

  const inferenceUrl = gatewayInferenceUrl(parsed, protocol);
  const publicInferenceUrl = publicGatewayUrl(inferenceUrl);
  const gatewayApiKey = probeGatewayCredential(input, config, protocol, parsed.href);
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json"
  };
  if (gatewayApiKey) headers.authorization = `Bearer ${gatewayApiKey}`;
  const requestOptions = {
    protocol,
    modelId,
    inferenceUrl,
    headers,
    signal,
    deadlineAt: Date.now() + boundedCapabilityProbeTimeout(input.probeTimeoutMs),
    maxResponseBytes: boundedCapabilityProbeResponseBytes(input.probeMaxResponseBytes)
  };

  const negative = await sendReasoningCapabilityProbe(requestOptions, INVALID_REASONING_EFFORT_PROBE);
  const negativeControl = publicReasoningProbeAttempt(INVALID_REASONING_EFFORT_PROBE, negative);
  if (negative.failure) {
    return failedReasoningCapabilityProbe({
      protocol,
      modelId,
      inferenceUrl: publicInferenceUrl,
      apiKeyUsed: Boolean(gatewayApiKey),
      negativeControl,
      failure: negative.failure
    });
  }
  if (negative.ok) {
    return completedReasoningCapabilityProbe({
      protocol,
      modelId,
      inferenceUrl: publicInferenceUrl,
      apiKeyUsed: Boolean(gatewayApiKey),
      outcome: "indeterminate",
      negativeControl,
      efforts: [],
      acceptedEfforts: [],
      reasoningField: null,
      warnings: ["上游接受了非法档位，无法确认它是否读取思考强度字段。"]
    });
  }
  if (!negative.reasoningField) {
    return completedReasoningCapabilityProbe({
      protocol,
      modelId,
      inferenceUrl: publicInferenceUrl,
      apiKeyUsed: Boolean(gatewayApiKey),
      outcome: "indeterminate",
      negativeControl,
      efforts: [],
      acceptedEfforts: [],
      reasoningField: null,
      warnings: ["负控错误没有以结构化字段标明思考强度参数，已停止检测。"]
    });
  }

  const attempts = [];
  const acceptedEfforts = [];
  let outcome = "complete";
  const warnings = [];
  for (const effort of reasoningProbeEffortIds()) {
    const attempt = await sendReasoningCapabilityProbe(requestOptions, effort);
    attempts.push(publicReasoningProbeAttempt(effort, attempt));
    if (attempt.failure) {
      outcome = "partial";
      warnings.push("检测请求未完成，未重试其余档位。", attempt.failure.message);
      break;
    }
    if (attempt.ok) {
      acceptedEfforts.push(effort);
      continue;
    }
    if (!attempt.reasoningField) {
      outcome = "partial";
      warnings.push("某个档位返回了无关错误，未重试其余档位。已确认的结果仍被保留。");
      break;
    }
  }

  return completedReasoningCapabilityProbe({
    protocol,
    modelId,
    inferenceUrl: publicInferenceUrl,
    apiKeyUsed: Boolean(gatewayApiKey),
    outcome,
    negativeControl,
    efforts: attempts,
    acceptedEfforts,
    reasoningField: negative.reasoningField,
    warnings
  });
}


export async function sendReasoningCapabilityProbe(options: ReasoningProbeRequestOptions, effort: string) {
  const remainingMs = options.deadlineAt - Date.now();
  if (remainingMs <= 0) {
    return {
      ok: false,
      httpStatus: null,
      reasoningField: null,
      failure: { kind: "timeout", message: "思考档位检测超过总时限" }
    };
  }
  const timeoutMs = Math.max(1, Math.min(remainingMs, MODEL_CAPABILITY_PROBE_REQUEST_TIMEOUT_MS));
  const abort = createCapabilityProbeAbort(options.signal, timeoutMs);
  let response;
  try {
    response = await fetch(options.inferenceUrl, {
      method: "POST",
      headers: options.headers,
      body: JSON.stringify(reasoningCapabilityProbeBody(options.protocol, options.modelId, effort)),
      redirect: "manual",
      signal: abort.signal
    });
  } catch (error) {
    const cancelled = options.signal?.aborted === true;
    const timedOut = !cancelled && (abort.timedOut
      || error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name));
    abort.cleanup();
    return {
      ok: false,
      httpStatus: null,
      reasoningField: null,
      failure: {
        kind: cancelled ? "cancelled" : timedOut ? "timeout" : "connect",
        message: cancelled ? "思考档位检测已取消" : timedOut ? "思考档位检测超时" : "无法连接模型来源"
      }
    };
  }

  try {
    if (response.ok) {
      await cancelProbeResponseBody(response);
      return { ok: true, httpStatus: response.status, reasoningField: null, failure: null };
    }

    const httpFailure = reasoningProbeHttpFailure(response.status);
    if (httpFailure) {
      await cancelProbeResponseBody(response);
      return {
        ok: false,
        httpStatus: response.status,
        reasoningField: null,
        failure: httpFailure
      };
    }

    let body;
    try {
      body = await readProbeResponse(response, {
        maxBytes: options.maxResponseBytes,
        tooLargeMessage: "思考档位错误响应超过大小限制"
      });
    } catch (error) {
      abort.abort(error);
      await cancelProbeResponseBody(response);
      const cancelled = options.signal?.aborted === true;
      const timedOut = !cancelled && (abort.timedOut
        || error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name));
      const tooLarge = capabilityProbeResponseTooLarge(error);
      return {
        ok: false,
        httpStatus: response.status,
        reasoningField: null,
        failure: cancelled
          ? { kind: "cancelled", message: "思考档位检测已取消" }
          : timedOut
          ? { kind: "timeout", message: "思考档位检测超时" }
          : tooLarge
            ? { kind: "response-too-large", message: "思考档位错误响应超过大小限制" }
            : { kind: "response", message: "读取模型来源响应失败" }
      };
    }
    let json = null;
    try {
      json = JSON.parse(body);
    } catch {
      // A plain-text error is deliberately insufficient evidence to probe further.
    }
    return {
      ok: false,
      httpStatus: response.status,
      reasoningField: structuredReasoningErrorField(json),
      failure: null
    };
  } finally {
    abort.cleanup();
  }
}

/** @param {number} status */


/** @param {number} status */
export function reasoningProbeHttpFailure(status: number) {
  if (status === 401 || status === 403) return { kind: "auth", message: "API Key 未通过验证" };
  if (status === 429) return { kind: "rate-limit", message: "模型来源限制了档位检测请求" };
  if (status >= 500) return { kind: "upstream", message: `模型来源返回 HTTP ${status}` };
  if (status >= 300 && status < 400) return { kind: "redirect", message: "模型地址返回重定向，已停止以避免转发凭据" };
  if (![400, 422].includes(status)) return { kind: "endpoint", message: `模型地址返回 HTTP ${status}` };
  return null;
}

/** @param {string} protocol @param {string} modelId @param {string} effort */


/** @param {string} protocol @param {string} modelId @param {string} effort */
export function reasoningCapabilityProbeBody(protocol: string, modelId: string, effort: string) {
  if (protocol === "openai-responses") {
    return {
      model: modelId,
      input: ".",
      stream: false,
      max_output_tokens: 16,
      reasoning: { effort }
    };
  }
  return {
    model: modelId,
    messages: [{ role: "user", content: "." }],
    stream: false,
    max_tokens: 1,
    reasoning_effort: effort
  };
}

/** @param {unknown} value */


/** @param {unknown} value */
export function structuredReasoningErrorField(value: unknown) {
  if (!isPlainObject(value)) return null;
  const root = /** @type {Record<string, any>} */ (value);
  const queue = /** @type {unknown[]} */ ([root.error, root.errors, root.detail, root.details].filter(Boolean));
  let visited = 0;
  while (queue.length > 0 && visited < 64) {
    const entry = queue.shift();
    visited += 1;
    if (Array.isArray(entry)) {
      queue.push(...entry.slice(0, 32));
      continue;
    }
    if (!isPlainObject(entry)) continue;
    const detail = /** @type {Record<string, any>} */ (entry);
    for (const fieldKey of ["param", "field", "path", "loc", "location"]) {
      const field = normalizedStructuredReasoningField(detail[fieldKey]);
      if (field) return field;
    }
    for (const detailKey of ["error", "errors", "detail", "details", "violation", "violations", "issue", "issues", "invalid_params"]) {
      if (detail[detailKey] !== undefined) queue.push(detail[detailKey]);
    }
  }
  return null;
}

/** @param {unknown} value */


/** @param {unknown} value */
export function normalizedStructuredReasoningField(value: unknown) {
  const raw = Array.isArray(value) ? value.map(String).join(".") : typeof value === "string" ? value : "";
  const normalized = raw.trim().toLowerCase()
    .replace(/^\$?\.?/, "")
    .replace(/\[(?:"|')?([^\]"']+)(?:"|')?\]/g, ".$1")
    .replace(/[\/]+/g, ".")
    .replace(/\.+/g, ".")
    .replace(/^\.|\.$/g, "");
  if (normalized === "reasoning_effort" || normalized.endsWith(".reasoning_effort")) return "reasoning_effort";
  if (normalized === "reasoning.effort" || normalized.endsWith(".reasoning.effort")) return "reasoning.effort";
  return null;
}

/** @param {string} effort @param {Record<string, any>} attempt */


/** @param {string} effort @param {Record<string, any>} attempt */
export function publicReasoningProbeAttempt(effort: string, attempt: { ok?: unknown; httpStatus?: unknown; reasoningField?: unknown; failure?: { kind?: unknown } | unknown }) {
  const failure = isPlainObject(attempt.failure) ? attempt.failure : null;
  return {
    effort,
    status: failure ? "indeterminate" : attempt.ok ? "accepted" : attempt.reasoningField ? "rejected" : "indeterminate",
    httpStatus: Number.isInteger(attempt.httpStatus) ? attempt.httpStatus : null,
    reasoningField: attempt.reasoningField ?? null,
    failure: failure?.kind ?? null
  };
}


export function completedReasoningCapabilityProbe(input: ReasoningProbeInput): ReasoningProbeResult {
  const accepted = normalizeCapabilityEfforts(input.acceptedEfforts);
  const preset = inferCatalogReasoning({ id: input.modelId }, { protocol: input.protocol });
  const presetDefault = preset.reasoningDiscovery.source === "known-preset"
    && accepted.some((effort: { id?: string; default?: boolean }) => effort.id === preset.defaultReasoningEffort)
    ? preset.defaultReasoningEffort
    : null;
  return {
    ok: true,
    protocol: input.protocol != null ? String(input.protocol) : undefined,
    modelId: input.modelId != null ? String(input.modelId) : undefined,
    inferenceUrl: input.inferenceUrl != null ? String(input.inferenceUrl) : undefined,
    apiKeyUsed: input.apiKeyUsed,
    outcome: input.outcome != null ? String(input.outcome) : undefined,
    acceptedEfforts: accepted.map((effort: { id?: string; default?: boolean }) => effort.id),
    reasoningEfforts: accepted,
    defaultReasoningEffort: presetDefault,
    reasoningDiscovery: {
      source: "active-probe",
      confidence: input.outcome === "complete" ? "probed" : input.outcome,
      path: input.reasoningField,
      presetId: null,
      supportsReasoning: accepted.length > 0 ? true : null,
      probeAvailable: true,
      warnings: [...new Set(Array.isArray(input.warnings) ? input.warnings : [])]
    },
    negativeControl: input.negativeControl,
    efforts: input.efforts,
    diagnostic: {
      stage: input.outcome === "complete" ? "complete" : input.outcome,
      requestCount: 1 + (Array.isArray(input.efforts) ? input.efforts.length : 0)
    }
  };
}

/** @param {Record<string, any>} input */


/** @param {Record<string, any>} input */
export function failedReasoningCapabilityProbe(input: ReasoningProbeInput): ReasoningProbeResult {
  return {
    ok: false,
    status: 502,
    error: input.failure?.message,
    protocol: input.protocol != null ? String(input.protocol) : undefined,
    modelId: input.modelId != null ? String(input.modelId) : undefined,
    inferenceUrl: input.inferenceUrl != null ? String(input.inferenceUrl) : undefined,
    apiKeyUsed: input.apiKeyUsed,
    outcome: "failed",
    acceptedEfforts: [],
    reasoningEfforts: [],
    defaultReasoningEffort: null,
    negativeControl: input.negativeControl,
    efforts: [],
    diagnostic: { stage: input.failure?.kind, requestCount: 1 }
  };
}

/** @param {Response} response */


/** @param {Response} response */
export async function cancelProbeResponseBody(response: Response) {
  try {
    await response.body?.cancel();
  } catch {
    // The response status is sufficient; generated content is intentionally discarded.
  }
}

/** @param {AbortSignal | undefined} parentSignal @param {number} timeoutMs */


/** @param {AbortSignal | undefined} parentSignal @param {number} timeoutMs */
export function createCapabilityProbeAbort(parentSignal: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  let timedOut = false;
  const abort = (reason?: unknown) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  const onParentAbort = () => abort(parentSignal?.reason ?? new Error("Capability probe cancelled"));
  const timer = setTimeout(() => {
    timedOut = true;
    const error = new Error(`Capability probe timed out after ${timeoutMs}ms`);
    error.name = "TimeoutError";
    abort(error);
  }, timeoutMs);
  timer.unref?.();
  parentSignal?.addEventListener?.("abort", onParentAbort, { once: true });
  if (parentSignal?.aborted) onParentAbort();
  return {
    signal: controller.signal,
    abort,
    get timedOut() {
      return timedOut;
    },
    cleanup() {
      clearTimeout(timer);
      parentSignal?.removeEventListener?.("abort", onParentAbort);
    }
  };
}

/** @param {unknown} value */


/** @param {unknown} value */
export function boundedCapabilityProbeTimeout(value: unknown) {
  const timeout = Number(value);
  return Number.isInteger(timeout) && timeout >= 25
    ? Math.min(timeout, MODEL_CAPABILITY_PROBE_TOTAL_TIMEOUT_MS)
    : MODEL_CAPABILITY_PROBE_TOTAL_TIMEOUT_MS;
}

/** @param {unknown} value */


/** @param {unknown} value */
export function boundedCapabilityProbeResponseBytes(value: unknown) {
  const maxBytes = Number(value);
  return Number.isInteger(maxBytes) && maxBytes >= 1024
    ? Math.min(maxBytes, MODEL_CAPABILITY_PROBE_MAX_RESPONSE_BYTES)
    : MODEL_CAPABILITY_PROBE_MAX_RESPONSE_BYTES;
}

/** @param {Record<string, any>} input @param {Record<string, any>} config @param {string} protocol @param {string} gatewayUrl */


/** @param {Record<string, any>} input @param {Record<string, any>} config @param {string} protocol @param {string} gatewayUrl */
export function probeGatewayCredential(input: DashboardRequestInput, config: LabAgentConfig | Record<string, unknown>, protocol: string, gatewayUrl: string): string {
  if (normalizeCredentialAction(input.credentialAction ?? input.apiKeyAction, input.gatewayApiKey) === "clear") return "";
  const supplied = String(input.gatewayApiKey ?? "").trim();
  if (supplied) return supplied;
  const profileId = String(input.providerId ?? input.profileId ?? input.gatewayProfileId ?? "").trim();
  const profiles = gatewayProfilesFromConfig(config);
  const requestedEndpoint = { gatewayProtocol: protocol, gatewayUrl };
  const selectedProfile = profiles.find((item) => item.id === profileId);
  const profile = sameGatewayProfileEndpoint(selectedProfile, requestedEndpoint)
    ? selectedProfile
    : gatewayProfileForEndpoint(profiles, protocol, gatewayUrl);
  if (profile?.gatewayApiKey) return String(profile.gatewayApiKey);
  const previousEndpoint = {
    gatewayProtocol: String(input.previousGatewayProtocol ?? "openai-chat").trim(),
    gatewayUrl: String(input.previousGatewayUrl ?? "").trim()
  };
  const previousOrigin = gatewayUrlOrigin(previousEndpoint.gatewayUrl);
  if (selectedProfile
    && sameGatewayProfileEndpoint(selectedProfile, previousEndpoint)
    && previousOrigin
    && previousOrigin === gatewayUrlOrigin(gatewayUrl)) {
    return String(gatewayProfileCredentialState(config, selectedProfile.id).value ?? "");
  }
  const lab = isPlainObject(config.lab) ? config.lab : null;
  const activeEndpoint = {
    gatewayProtocol: String(lab?.gatewayProtocol ?? "openai-chat"),
    gatewayUrl: String(lab?.gatewayUrl ?? "")
  };
  return sameGatewayProfileEndpoint(activeEndpoint, requestedEndpoint)
    ? String(lab?.gatewayApiKey ?? "")
    : "";
}

/** @param {URL} url */


/** @param {URL} url */
export function gatewayModelsUrl(url: URL) {
  const next = new URL(url.href);
  const path = next.pathname.replace(/\/+$/, "");
  if (/\/models$/i.test(path)) return next.href;
  next.pathname = /\/chat\/completions$/i.test(path)
    ? path.replace(/\/chat\/completions$/i, "/models")
    : /\/responses$/i.test(path)
      ? path.replace(/\/responses$/i, "/models")
      : /\/messages$/i.test(path)
        ? path.replace(/\/messages$/i, "/models")
        : `${path}/models`;
  next.hash = "";
  return next.href;
}

/** @param {URL} url @param {string} protocol */


/** @param {URL} url @param {string} protocol */
export function gatewayInferenceUrl(url: URL, protocol: string) {
  const next = new URL(url.href);
  const path = next.pathname.replace(/\/+$/, "");
  const suffix = protocol === "openai-responses"
    ? "/responses"
    : protocol === "openai-chat"
      ? "/chat/completions"
      : protocol === "anthropic-messages" ? "/messages" : "";
  if (!suffix || path.endsWith(suffix)) {
    next.pathname = path || "/";
    next.hash = "";
    return next.href;
  }
  const knownRoute = /\/(models|responses|messages|chat\/completions)$/i;
  const knownBase = path === "" || /^\/$/.test(path) || /\/v\d+(?:beta\d*)?$/i.test(path);
  if (knownRoute.test(path)) {
    next.pathname = path.replace(knownRoute, suffix);
  } else if (knownBase) {
    next.pathname = `${path}${suffix}`;
  } else {
    next.pathname = path || "/";
  }
  next.hash = "";
  return next.href;
}

/** @param {unknown} value @param {string} protocol */


/** @param {unknown} value @param {string} protocol */
export function publicCatalogModel(value: unknown, protocol: string) {
  if (typeof value === "string") value = { id: value };
  if (!isPlainObject(value)) return null;
  const item = /** @type {Record<string, any>} */ (value);
  const id = String(item.id ?? "").trim();
  if (!id) return null;
  const reasoning = inferCatalogReasoning(item, { protocol });
  return {
    id,
    label: String(item.display_name ?? item.displayName ?? item.name ?? id),
    ownedBy: String(item.owned_by ?? item.ownedBy ?? ""),
    contextTokens: positiveIntegerOrNull(item.contextTokens ?? item.context_window ?? item.context_length ?? item.max_context_tokens),
    thinking: reasoning.reasoningDiscovery.supportsReasoning === true || /thinking|reason/i.test(id),
    ...reasoning,
    modalities: normalizeModelInputModalities({ modalities: item.modalities ?? item.input_modalities })
  };
}

/** @param {Response} response @param {{ maxBytes?: number; tooLargeMessage?: string }} [options] */


/** @param {Response} response @param {{ maxBytes?: number; tooLargeMessage?: string }} [options] */
export async function readProbeResponse(response: Response, options: { maxBytes?: number; tooLargeMessage?: string } = {}) {
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  const tooLargeMessage = options.tooLargeMessage ?? "模型目录响应超过 2 MB 限制";
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw capabilityProbeResponseTooLargeError(tooLargeMessage);
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += Number(value?.byteLength ?? 0);
    if (bytes > maxBytes) {
      await reader.cancel();
      throw capabilityProbeResponseTooLargeError(tooLargeMessage);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/** @param {string} message */


/** @param {string} message */
export function capabilityProbeResponseTooLargeError(message: string) {
  const error = new Error(message);
  Object.assign(error, { code: "MODEL_CAPABILITY_PROBE_RESPONSE_TOO_LARGE" });
  return error;
}


export function capabilityProbeResponseTooLarge(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error
    && error.code === "MODEL_CAPABILITY_PROBE_RESPONSE_TOO_LARGE";
}
