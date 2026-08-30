import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseModelList, type LabModel } from "../model-gateway/models.ts";
import { DEFAULT_GATEWAY_MAX_RESPONSE_BYTES } from "../model-gateway/limits.ts";
import { recommendedMcpServers } from "../mcp/recommended.ts";
import { validateHookConfig } from "../hooks/registry.ts";
import { createCredentialStore } from "../credentials/store.ts";
import { createFileRepository } from "../config-v2/file-repository.ts";
import { projectLegacyRuntimeConfig } from "../config-v2/legacy-projection.ts";
import { stripLegacyModelFields } from "../config-v2/migrate-v1.ts";
import {
  credentialsPath,
  globalLegacyConfigPath,
  globalSettingsPath,
  projectLegacyConfigPath,
  projectSettingsPath
} from "../config-v2/paths.ts";
import { resolveSettingsLayers } from "../config-v2/resolver.ts";
import { mergeRuntimeAgentRouting, replaceRuntimeAgentRouting } from "../config-v2/runtime-selection.ts";
import {
  GOAL_ABS_MAX_AUTO_CONTINUES,
  GOAL_MAX_AUTO_CONTINUES,
  GOAL_MIN_AUTO_CONTINUES
} from "../core/goal.ts";
import { NETWORK_MODES, GATEWAY_PROTOCOLS, EMPTY_JSON, type JsonObject } from "./defaults.ts";
import { assertUniqueModelEntryIds, assertUniqueLayerGatewayProfileIds } from "./load-config.ts";

export function validateConfig(config: Record<string, unknown>) {
  const security = isPlainObject(config.security) ? config.security : undefined;
  const sensitivity = security?.sensitivity ?? "standard";
  const sensitivityModes: readonly string[] = ["standard", "high"];
  if (typeof sensitivity !== "string" || !sensitivityModes.includes(sensitivity)) {
    throw new Error(`Unsupported security.sensitivity: ${sensitivity}`);
  }
  const highSensitivityNetworks: readonly string[] = ["offline", "lab-only"];
  if (sensitivity === "high" && (typeof config.networkMode !== "string" || !highSensitivityNetworks.includes(config.networkMode))) {
    throw new Error("High-sensitivity mode requires networkMode offline or lab-only");
  }

  if (typeof config.networkMode !== "string" || !NETWORK_MODES.includes(config.networkMode)) {
    throw new Error(`Unsupported networkMode: ${config.networkMode}`);
  }
  if (!Array.isArray(config.allowedHosts)) {
    throw new Error("Unsupported allowedHosts: expected an array");
  }
  for (const host of config.allowedHosts) {
    if (!validAllowedHost(host)) {
      throw new Error(`Unsupported allowedHosts entry: ${host}`);
    }
  }

  const transcript = isPlainObject(config.transcript) ? config.transcript : undefined;
  if (typeof transcript?.enabled !== "boolean") {
    throw new Error("Unsupported transcript.enabled: expected boolean");
  }

  const encryption = transcript?.encryption ?? "off";
  const encryptionModes: readonly string[] = ["off", "optional", "required"];
  if (typeof encryption !== "string" || !encryptionModes.includes(encryption)) {
    throw new Error(`Unsupported transcript.encryption: ${encryption}`);
  }

  const retentionDays = transcript?.retentionDays === undefined
    ? 30
    : transcript.retentionDays;
  if (retentionDays !== null && (typeof retentionDays !== "number" || !Number.isInteger(retentionDays) || retentionDays < 0 || retentionDays > 3650)) {
    throw new Error(`Unsupported transcript.retentionDays: ${retentionDays}`);
  }

  const context = isPlainObject(config.context) ? config.context : EMPTY_JSON;
  for (const key of ["maxMessages", "maxBytes", "maxTokens", "keepRecentMessages", "tailTurns", "preserveRecentTokens", "summaryBytes", "resumeMaxMessages", "resumeMaxTokens", "resumeMaxBytes"]) {
    const value = context[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      throw new Error(`Unsupported context.${key}: ${value}`);
    }
  }
  const keepRecentMessages = context.keepRecentMessages;
  const maxMessages = context.maxMessages;
  if (typeof keepRecentMessages === "number" && typeof maxMessages === "number" && keepRecentMessages > maxMessages) {
    throw new Error("context.keepRecentMessages must be less than or equal to context.maxMessages");
  }
  const promptCompactRatio = context.promptCompactRatio;
  if (
    promptCompactRatio !== undefined
    && promptCompactRatio !== null
    && (typeof promptCompactRatio !== "number" || !Number.isFinite(promptCompactRatio) || promptCompactRatio <= 0 || promptCompactRatio > 1)
  ) {
    throw new Error(`Unsupported context.promptCompactRatio: ${promptCompactRatio}`);
  }

  if (config.models !== undefined && !Array.isArray(config.models)) {
    throw new Error("Unsupported models: expected an array");
  }
  assertUniqueModelEntryIds(config.models, "models");
  if (config.routingModels !== undefined && !Array.isArray(config.routingModels)) {
    throw new Error("Unsupported routingModels: expected an array");
  }
  assertUniqueModelEntryIds(config.routingModels, "routingModels");
  validateProfileModels(config.routingModels ?? []);
  for (const model of Array.isArray(config.models) ? config.models : []) {
    if (typeof model === "string") {
      continue;
    }
    if (!isPlainObject(model) || typeof model.id !== "string" || model.id.trim() === "") {
      throw new Error("Unsupported models entry: expected string or object with id");
    }
    for (const key of ["contextTokens", "maxContextTokens", "contextWindowTokens"]) {
      const field = model[key];
      if (field !== undefined && field !== null && (typeof field !== "number" || !Number.isInteger(field) || field <= 0)) {
        throw new Error(`Unsupported models entry ${key}: ${field}`);
      }
    }
    const reasoningModes: readonly string[] = ["hidden", "visible-when-no-content"];
    if (
      model.reasoningContentMode !== undefined
      && model.reasoningContentMode !== null
      && (typeof model.reasoningContentMode !== "string" || !reasoningModes.includes(model.reasoningContentMode))
    ) {
      throw new Error(`Unsupported models entry reasoningContentMode: ${model.reasoningContentMode}`);
    }
    if (model.reasoningEfforts !== undefined && model.reasoningEfforts !== null && !Array.isArray(model.reasoningEfforts)) {
      throw new Error("Unsupported models entry reasoningEfforts: expected array");
    }
    if (
      model.defaultReasoningEffort !== undefined
      && model.defaultReasoningEffort !== null
      && typeof model.defaultReasoningEffort !== "string"
    ) {
      throw new Error("Unsupported models entry defaultReasoningEffort: expected string");
    }
    if (
      model.openaiExtraBody !== undefined
      && model.openaiExtraBody !== null
      && !isPlainObject(model.openaiExtraBody)
    ) {
      throw new Error("Unsupported models entry openaiExtraBody: expected object");
    }
    if (model.modalities !== undefined && model.modalities !== null && !validModelModalities(model.modalities)) {
      throw new Error("Unsupported models entry modalities: expected array or comma-separated string containing text/image");
    }
    if (model.agentModelTiers !== undefined && model.agentModelTiers !== null) {
      if (!isPlainObject(model.agentModelTiers)) {
        throw new Error("Unsupported models entry agentModelTiers: expected object");
      }
      for (const [tier, tierModel] of Object.entries(model.agentModelTiers)) {
        if (typeof tierModel !== "string" || tierModel.trim() === "") {
          throw new Error(`Unsupported models entry agentModelTiers.${tier}: expected model id string`);
        }
      }
    }
    for (const key of ["vision", "multimodal", "supportsImages", "imageInput"]) {
      if (model[key] !== undefined && typeof model[key] !== "boolean") {
        throw new Error(`Unsupported models entry ${key}: expected boolean`);
      }
    }
  }
  if (config.reasoningEffort !== undefined && config.reasoningEffort !== null && typeof config.reasoningEffort !== "string") {
    throw new Error("Unsupported reasoningEffort: expected string");
  }

  if (config.skills !== undefined) {
    if (!isPlainObject(config.skills)) {
      throw new Error("Unsupported skills: expected an object");
    }
    if (config.skills.enabled !== undefined && typeof config.skills.enabled !== "boolean") {
      throw new Error("Unsupported skills.enabled: expected boolean");
    }
    if (config.skills.paths !== undefined && !Array.isArray(config.skills.paths)) {
      throw new Error("Unsupported skills.paths: expected an array");
    }
  }

  if (config.agents !== undefined) {
    if (!isPlainObject(config.agents)) {
      throw new Error("Unsupported agents: expected an object");
    }
    if (config.agents.maxRounds !== undefined && config.agents.maxRounds !== null) {
      const maxRounds = config.agents.maxRounds;
      if (typeof maxRounds !== "number" || !Number.isInteger(maxRounds) || maxRounds <= 0) {
        throw new Error(`Unsupported agents.maxRounds: ${maxRounds}`);
      }
    }
    if (config.agents.syncModelTiersOnSwitch !== undefined && typeof config.agents.syncModelTiersOnSwitch !== "boolean") {
      throw new Error("Unsupported agents.syncModelTiersOnSwitch: expected boolean");
    }
    if (config.agents.orchestration !== undefined && !isPlainObject(config.agents.orchestration)) {
      throw new Error("Unsupported agents.orchestration: expected an object");
    }
    if (config.agents.orchestration !== undefined) {
      validateAgentOrchestrationConfig(config.agents.orchestration);
    }
    if (config.agents.delegationGuard !== undefined) {
      validateDelegationGuardConfig(config.agents.delegationGuard);
    }
    if (config.agents.backgroundWakeup !== undefined) {
      validateBackgroundWakeupConfig(config.agents.backgroundWakeup);
    }
    if (config.agents.reviewGate !== undefined) {
      validateReviewGateConfig(config.agents.reviewGate);
    }
    if (config.agents.goal !== undefined) {
      validateGoalConfig(config.agents.goal);
    }
    if (config.agents.vision !== undefined) {
      validateVisionAgentConfig(config.agents.vision);
    }
    if (config.agents.modelTiers !== undefined && !isPlainObject(config.agents.modelTiers)) {
      throw new Error("Unsupported agents.modelTiers: expected an object");
    }
    if (config.agents.modelTiers !== undefined) {
      for (const [tier, model] of Object.entries(config.agents.modelTiers)) {
        if (typeof model !== "string" || model.trim() === "") {
          throw new Error(`Unsupported agents.modelTiers.${tier}: expected model id string`);
        }
      }
    }
    if (config.agents.budgets !== undefined && !isPlainObject(config.agents.budgets)) {
      throw new Error("Unsupported agents.budgets: expected an object");
    }
    if (config.agents.budgets !== undefined) {
      for (const [name, budget] of Object.entries(config.agents.budgets)) {
        if (!isPlainObject(budget)) {
          throw new Error(`Unsupported agents.budgets.${name}: expected an object`);
        }
        for (const key of ["maxRounds", "maxToolCalls", "maxDurationMs", "maxOutputBytes", "maxConsecutiveFailures", "maxPermissionDenials"]) {
          if ((key === "maxRounds" || key === "maxToolCalls") && budget[key] === null) {
            continue;
          }
          const field = budget[key];
          if (field !== undefined && (typeof field !== "number" || !Number.isInteger(field) || field <= 0)) {
            throw new Error(`Unsupported agents.budgets.${name}.${key}: ${field}`);
          }
        }
      }
    }
    if (config.agents.routing !== undefined && !isPlainObject(config.agents.routing)) {
      throw new Error("Unsupported agents.routing: expected an object");
    }
    if (config.agents.profiles !== undefined && !Array.isArray(config.agents.profiles)) {
      throw new Error("Unsupported agents.profiles: expected an array");
    }
  }

  if (config.limits !== undefined) {
    if (!isPlainObject(config.limits)) {
      throw new Error("Unsupported limits: expected an object");
    }
    if (config.limits.maxToolRounds !== undefined && config.limits.maxToolRounds !== null) {
      const maxToolRounds = config.limits.maxToolRounds;
      if (typeof maxToolRounds !== "number" || !Number.isInteger(maxToolRounds) || maxToolRounds <= 0) {
        throw new Error(`Unsupported limits.maxToolRounds: ${maxToolRounds}`);
      }
    }
  }

  const lab = isPlainObject(config.lab) ? config.lab : undefined;
  if (lab?.gatewayProfiles !== undefined) {
    validateGatewayProfiles(lab.gatewayProfiles);
  }

  validateHookConfig(config);
}

export function validateGatewayProfiles(value: unknown) {
  if (!Array.isArray(value)) {
    throw new Error("Unsupported lab.gatewayProfiles: expected an array");
  }
  assertUniqueLayerGatewayProfileIds(value);
  for (const profile of value) {
    if (!isPlainObject(profile)) {
      throw new Error("Unsupported lab.gatewayProfiles entry: expected object");
    }
    if (typeof profile.id !== "string" || profile.id.trim() === "") {
      throw new Error("Unsupported lab.gatewayProfiles entry id: expected string");
    }
    if (profile.label !== undefined && typeof profile.label !== "string") {
      throw new Error("Unsupported lab.gatewayProfiles entry label: expected string");
    }
    if (profile.gatewayUrl !== undefined && profile.gatewayUrl !== null && typeof profile.gatewayUrl !== "string") {
      throw new Error("Unsupported lab.gatewayProfiles entry gatewayUrl: expected string");
    }
    if (profile.gatewayHealthUrl !== undefined && profile.gatewayHealthUrl !== null && typeof profile.gatewayHealthUrl !== "string") {
      throw new Error("Unsupported lab.gatewayProfiles entry gatewayHealthUrl: expected string");
    }
    if (profile.gatewayProtocol !== undefined && (typeof profile.gatewayProtocol !== "string" || !GATEWAY_PROTOCOLS.includes(profile.gatewayProtocol))) {
      throw new Error(`Unsupported lab.gatewayProfiles entry gatewayProtocol: ${profile.gatewayProtocol}`);
    }
    if (profile.gatewayApiKey !== undefined && profile.gatewayApiKey !== null && typeof profile.gatewayApiKey !== "string") {
      throw new Error("Unsupported lab.gatewayProfiles entry gatewayApiKey: expected string");
    }
    if (profile.gatewayApiKeyDisabled !== undefined && typeof profile.gatewayApiKeyDisabled !== "boolean") {
      throw new Error("Unsupported lab.gatewayProfiles entry gatewayApiKeyDisabled: expected boolean");
    }
    if (profile.modelAlias !== undefined && typeof profile.modelAlias !== "string") {
      throw new Error("Unsupported lab.gatewayProfiles entry modelAlias: expected string");
    }
    if (profile.models !== undefined && !Array.isArray(profile.models)) {
      throw new Error("Unsupported lab.gatewayProfiles entry models: expected array");
    }
    if (profile.routingModels !== undefined && !Array.isArray(profile.routingModels)) {
      throw new Error("Unsupported lab.gatewayProfiles entry routingModels: expected array");
    }
    if (profile.agents !== undefined && !isPlainObject(profile.agents)) {
      throw new Error("Unsupported lab.gatewayProfiles entry agents: expected object");
    }
    validateProfileModels(profile.models ?? []);
    validateProfileModels(profile.routingModels ?? []);
    if (profile.agents?.vision !== undefined) {
      validateVisionAgentConfig(profile.agents.vision);
    }
    if (profile.agents?.modelTiers !== undefined) {
      if (!isPlainObject(profile.agents.modelTiers)) {
        throw new Error("Unsupported lab.gatewayProfiles entry agents.modelTiers: expected object");
      }
      for (const [tier, model] of Object.entries(profile.agents.modelTiers)) {
        if (typeof model !== "string" || model.trim() === "") {
          throw new Error(`Unsupported lab.gatewayProfiles entry agents.modelTiers.${tier}: expected model id string`);
        }
      }
    }
  }
}

export function validateProfileModels(models: unknown) {
  if (!Array.isArray(models)) {
    return;
  }
  for (const model of models) {
    if (typeof model === "string") {
      continue;
    }
    if (!isPlainObject(model) || typeof model.id !== "string" || model.id.trim() === "") {
      throw new Error("Unsupported lab.gatewayProfiles entry models item: expected string or object with id");
    }
    if (model.modalities !== undefined && model.modalities !== null && !validModelModalities(model.modalities)) {
      throw new Error("Unsupported lab.gatewayProfiles entry models item modalities: expected text/image");
    }
    if (model.agentModelTiers !== undefined && model.agentModelTiers !== null && !isPlainObject(model.agentModelTiers)) {
      throw new Error("Unsupported lab.gatewayProfiles entry models item agentModelTiers: expected object");
    }
    if (model.reasoningEfforts !== undefined && model.reasoningEfforts !== null && !Array.isArray(model.reasoningEfforts)) {
      throw new Error("Unsupported lab.gatewayProfiles entry models item reasoningEfforts: expected array");
    }
    if (model.defaultReasoningEffort !== undefined && model.defaultReasoningEffort !== null && typeof model.defaultReasoningEffort !== "string") {
      throw new Error("Unsupported lab.gatewayProfiles entry models item defaultReasoningEffort: expected string");
    }
  }
}

export function validateAgentOrchestrationConfig(value: unknown) {
  if (!isPlainObject(value)) {
    throw new Error("Unsupported agents.orchestration: expected an object");
  }
  for (const key of ["enabled", "allowParallelReadonly", "allowParallelWrites", "autoReview", "autoContinuePartial"]) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") {
      throw new Error(`Unsupported agents.orchestration.${key}: expected boolean`);
    }
  }
  if (value.maxParallelReadonlyAgentRuns !== undefined) {
    const maxParallel = value.maxParallelReadonlyAgentRuns;
    if (!isIntegerValue(maxParallel) || maxParallel <= 0) {
      throw new Error(`Unsupported agents.orchestration.maxParallelReadonlyAgentRuns: ${maxParallel}`);
    }
  }
}

export function validateDelegationGuardConfig(value: unknown) {
  if (!isPlainObject(value)) {
    throw new Error("Unsupported agents.delegationGuard: expected an object");
  }
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    throw new Error("Unsupported agents.delegationGuard.enabled: expected boolean");
  }
  if (value.mode !== undefined && !["remind", "off", "disabled"].includes(String(value.mode))) {
    throw new Error(`Unsupported agents.delegationGuard.mode: ${value.mode}`);
  }
  for (const key of ["softThreshold", "strongThreshold"]) {
    const field = value[key];
    if (field !== undefined && (!isIntegerValue(field) || field <= 0)) {
      throw new Error(`Unsupported agents.delegationGuard.${key}: ${field}`);
    }
  }
  if (
    isIntegerValue(value.softThreshold)
    && isIntegerValue(value.strongThreshold)
    && value.strongThreshold <= value.softThreshold
  ) {
    throw new Error("Unsupported agents.delegationGuard: strongThreshold must be greater than softThreshold");
  }
}

export function validateBackgroundWakeupConfig(value: unknown) {
  if (!isPlainObject(value)) {
    throw new Error("Unsupported agents.backgroundWakeup: expected an object");
  }
  for (const key of ["enabled", "defaultForModelAgentRun", "autoQueueParentPrompt"]) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") {
      throw new Error(`Unsupported agents.backgroundWakeup.${key}: expected boolean`);
    }
  }
  if (value.defaultWaitFor !== undefined && !["all", "any", "none"].includes(String(value.defaultWaitFor))) {
    throw new Error(`Unsupported agents.backgroundWakeup.defaultWaitFor: ${value.defaultWaitFor}`);
  }
  for (const key of ["maxConcurrentBackground", "maxWakeSummaryBytes"]) {
    const field = value[key];
    if (field !== undefined && (!isIntegerValue(field) || field <= 0)) {
      throw new Error(`Unsupported agents.backgroundWakeup.${key}: ${field}`);
    }
  }
}

/** @param {Record<string, any>} value */
export function validateGoalConfig(value: unknown) {
  if (!isPlainObject(value)) {
    throw new Error("Unsupported agents.goal: expected an object");
  }
  if (value.maxAutoContinues !== undefined) {
    const maxAutoContinues = value.maxAutoContinues;
    if (
      !isIntegerValue(maxAutoContinues)
      || maxAutoContinues < GOAL_MIN_AUTO_CONTINUES
      || maxAutoContinues > GOAL_ABS_MAX_AUTO_CONTINUES
    ) {
      throw new Error(`Unsupported agents.goal.maxAutoContinues: ${maxAutoContinues}`);
    }
  }
}

export function validateReviewGateConfig(value: unknown) {
  if (!isPlainObject(value)) {
    throw new Error("Unsupported agents.reviewGate: expected an object");
  }
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    throw new Error("Unsupported agents.reviewGate.enabled: expected boolean");
  }
  if (value.mode !== undefined && !["remind", "require", "off", "disabled"].includes(String(value.mode))) {
    throw new Error(`Unsupported agents.reviewGate.mode: ${value.mode}`);
  }
  for (const key of ["todoThreshold", "planThreshold", "deliveryThreshold"]) {
    const field = value[key];
    if (field !== undefined && (!isIntegerValue(field) || field <= 0)) {
      throw new Error(`Unsupported agents.reviewGate.${key}: ${field}`);
    }
  }
  for (const key of ["requireForWrites", "requireForHighRisk"]) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") {
      throw new Error(`Unsupported agents.reviewGate.${key}: expected boolean`);
    }
  }
}

export function validateVisionAgentConfig(value: unknown) {
  if (!isPlainObject(value)) {
    throw new Error("Unsupported agents.vision: expected an object");
  }
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    throw new Error("Unsupported agents.vision.enabled: expected boolean");
  }
  if (value.autoUseWhenMainModelTextOnly !== undefined && typeof value.autoUseWhenMainModelTextOnly !== "boolean") {
    throw new Error("Unsupported agents.vision.autoUseWhenMainModelTextOnly: expected boolean");
  }
  if (value.model !== undefined && value.model !== null && (typeof value.model !== "string" || value.model.trim() === "")) {
    throw new Error("Unsupported agents.vision.model: expected model id string");
  }
}

/**
 * @param {{ gatewayProtocol?: string; gatewayApiKey?: string | null; gatewayApiKeyDisabled?: boolean; gatewayMaxRetries?: number; gatewayTimeoutMs?: number; gatewayIdleTimeoutMs?: number; gatewayMaxResponseBytes?: number }} lab
 */
export function validateLabConfig(lab: { gatewayProtocol?: string; gatewayApiKey?: string | null; gatewayApiKeyDisabled?: boolean; gatewayMaxRetries: number; gatewayTimeoutMs: number; gatewayIdleTimeoutMs: number; gatewayMaxResponseBytes: number }) {
  const protocol = lab.gatewayProtocol ?? "openai-chat";
  if (!GATEWAY_PROTOCOLS.includes(protocol)) {
    throw new Error(`Unsupported LAB_MODEL_GATEWAY_PROTOCOL: ${protocol}`);
  }
  if (lab.gatewayApiKey !== null && lab.gatewayApiKey !== undefined && typeof lab.gatewayApiKey !== "string") {
    throw new Error("Unsupported lab.gatewayApiKey: expected string");
  }
  if (lab.gatewayApiKeyDisabled !== undefined && typeof lab.gatewayApiKeyDisabled !== "boolean") {
    throw new Error("Unsupported lab.gatewayApiKeyDisabled: expected boolean");
  }
  if (!Number.isInteger(lab.gatewayMaxRetries) || lab.gatewayMaxRetries < 0 || lab.gatewayMaxRetries > 5) {
    throw new Error(`Unsupported lab.gatewayMaxRetries: ${lab.gatewayMaxRetries}`);
  }
  if (!Number.isInteger(lab.gatewayTimeoutMs) || lab.gatewayTimeoutMs < 1000 || lab.gatewayTimeoutMs > 900000) {
    throw new Error(`Unsupported lab.gatewayTimeoutMs: ${lab.gatewayTimeoutMs}`);
  }
  if (!Number.isInteger(lab.gatewayIdleTimeoutMs) || lab.gatewayIdleTimeoutMs < 1000 || lab.gatewayIdleTimeoutMs > 300000) {
    throw new Error(`Unsupported lab.gatewayIdleTimeoutMs: ${lab.gatewayIdleTimeoutMs}`);
  }
  const gatewayMaxResponseBytes = Number(lab.gatewayMaxResponseBytes);
  if (!Number.isInteger(gatewayMaxResponseBytes) || gatewayMaxResponseBytes < 1024 || gatewayMaxResponseBytes > 256 * 1024 * 1024) {
    throw new Error(`Unsupported lab.gatewayMaxResponseBytes: ${lab.gatewayMaxResponseBytes}`);
  }
}

/**
 * @param {string | undefined} value
 */
export function parseHostList(value: string | undefined) {
  if (!value) {
    return [];
  }
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

/** @param {unknown} value */
export function validAllowedHost(value: unknown) {
  if (typeof value !== "string") {
    return false;
  }
  const host = value.trim();
  if (!host || /[\s/@]/.test(host) || host.includes("://")) {
    return false;
  }
  try {
    const parsed = new URL(`http://${host}`);
    return parsed.hostname === host
      && parsed.port === ""
      && parsed.pathname === "/"
      && parsed.search === ""
      && parsed.hash === "";
  } catch {
    return false;
  }
}

/**
 * @param {string} value
 */
export function parseHost(value: string) {
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

/**
 * @param {string} value
 */
export function parseBoolean(value: string) {
  return /^(1|true|yes|on)$/i.test(value);
}

/**
 * @param {string | undefined} value
 */
export function parseOptionalPositiveInteger(value: string | undefined) {
  if (!value) {
    return null;
  }
  if (!/^\d+$/.test(value)) {
    throw new Error(`Expected positive integer environment value, received: ${value}`);
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`Expected positive integer environment value, received: ${value}`);
  }
  return number;
}

export function parseOptionalInteger(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  if (!/^\d+$/.test(String(value))) {
    throw new Error(`Expected integer environment value, received: ${value}`);
  }
  const number = Number(value);
  if (!Number.isInteger(number)) {
    throw new Error(`Expected integer environment value, received: ${value}`);
  }
  return number;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
export function isIntegerValue(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

export function integerOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function cloneJsonObject<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? EMPTY_JSON)) as T;
}

export function validModelModalities(value: unknown) {
  const items = Array.isArray(value)
    ? value
    : typeof value === "string" ? value.split(/[, ]+/) : [];
  return items.length > 0 && items.every((item) => {
    const text = String(item ?? "").trim().toLowerCase();
    return !text || ["text", "image", "images", "vision", "visual", "multimodal", "文本", "图片", "视觉"].includes(text);
  });
}

