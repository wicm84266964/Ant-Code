import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MODEL_OPTIONS, parseModelList } from "../model-gateway/models.js";
import { recommendedMcpServers } from "../mcp/recommended.js";
import { validateHookConfig } from "../hooks/registry.js";

export const NETWORK_MODES = Object.freeze([
  "offline",
  "lab-only",
  "approved-web",
  "open-dev"
]);

export const GATEWAY_PROTOCOLS = Object.freeze([
  "lab-agent-gateway",
  "openai-chat"
]);

const PROJECT_CONFIG_FILES = Object.freeze([
  "lab-agent.config.json",
  path.join(".lab-agent", "config.json")
]);

const DEFAULT_CONTEXT_TOKENS = 200000;
const PACKAGE_ROOT = resolvePackageRoot();
const BUNDLED_CONFIG_PATH = path.join(PACKAGE_ROOT, "lab-agent.config.json");

function resolvePackageRoot() {
  if (process.env.LAB_AGENT_PACKAGE_ROOT) {
    return path.resolve(process.env.LAB_AGENT_PACKAGE_ROOT);
  }
  if (process.env.NODE_SEA_EXECUTABLE || process.execPath.toLowerCase().endsWith("ant-code.exe")) {
    return path.dirname(process.execPath);
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

const DEFAULT_CONFIG = Object.freeze({
  appName: "lab-agent",
  modelAlias: "default",
  models: DEFAULT_MODEL_OPTIONS,
  networkMode: "approved-web",
  allowedHosts: [],
  transcript: {
    enabled: true,
    retentionDays: 30,
    includeToolOutput: "policy",
    encryption: "off"
  },
  security: {
    sensitivity: "standard"
  },
  context: {
    maxMessages: 100000,
    maxBytes: DEFAULT_CONTEXT_TOKENS * 4,
    maxTokens: DEFAULT_CONTEXT_TOKENS,
    keepRecentMessages: 8,
    tailTurns: 2,
    preserveRecentTokens: 8000,
    summaryBytes: 65536,
    resumeMaxMessages: 100000,
    resumeMaxTokens: DEFAULT_CONTEXT_TOKENS,
    resumeMaxBytes: DEFAULT_CONTEXT_TOKENS * 4,
    inFlightCompactRatio: null,
    inFlightKeepRecentTools: null
  },
  mcp: {
    servers: recommendedMcpServers()
  },
  skills: {
    enabled: true,
    paths: []
  },
  agents: {
    orchestration: {
      enabled: true,
      defaultMode: "one-shot",
      allowParallelReadonly: true,
      allowParallelWrites: false,
      maxParallelReadonlyAgentRuns: 3,
      autoReview: true,
      autoContinuePartial: false
    },
    delegationGuard: {
      enabled: true,
      mode: "remind",
      softThreshold: 3,
      strongThreshold: 5
    },
    backgroundWakeup: {
      enabled: true,
      defaultForModelAgentRun: false,
      maxConcurrentBackground: 3,
      defaultWaitFor: "all",
      autoQueueParentPrompt: true,
      maxWakeSummaryBytes: 12000
    },
    reviewGate: {
      enabled: true,
      mode: "remind",
      todoThreshold: 4,
      requireForWrites: false,
      requireForHighRisk: false
    },
    vision: {
      enabled: true,
      model: null,
      autoUseWhenMainModelTextOnly: true
    },
    modelTiers: {},
    budgets: {},
    routing: {
      preferCheapForReadonly: true,
      strongForHighRisk: true,
      reviewerForHighRisk: true
    },
    profiles: []
  },
  limits: {
    maxToolRounds: null
  },
  hooks: {
    enabled: true,
    disableAll: false,
    managedOnly: false,
    defaultTimeoutMs: 30000,
    maxOutputBytes: 12000,
    envAllowlist: ["PATH", "Path", "SystemRoot", "TEMP", "TMP", "HOME", "USERPROFILE"],
    events: {}
  },
  lab: {
    gatewayUrl: null,
    gatewayHealthUrl: null,
    gatewayProtocol: "lab-agent-gateway",
    gatewayApiKey: null,
    gatewayMaxRetries: 2
  }
});

/**
 * @typedef {typeof DEFAULT_CONFIG & {
 *   lab: { gatewayUrl: string | null; gatewayHealthUrl: string | null; gatewayProtocol: string; gatewayApiKey: string | null; gatewayMaxRetries: number; configPath: string | null };
 *   projectConfigPath: string | null;
 * }} LabAgentConfig
 */

/**
 * Load config from defaults, project JSON, lab-managed JSON, and environment.
 *
 * Precedence: defaults < project config < lab config < environment.
 *
 * @param {{ cwd?: string; env?: NodeJS.ProcessEnv }} options
 * @returns {Promise<LabAgentConfig>}
 */
export async function loadConfig(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;

  const projectConfigs = await loadProjectConfigs(cwd);
  const project = mergeProjectConfigs(projectConfigs);
  const labConfigPath = env.LAB_AGENT_CONFIG ?? null;
  const bundled = await readJsonIfExists(BUNDLED_CONFIG_PATH);
  const lab = labConfigPath ? await readJsonIfExists(labConfigPath) : null;

  const withBundled = mergeConfig(DEFAULT_CONFIG, bundled?.data ?? {});
  const withProject = mergeConfig(withBundled, project?.data ?? {});
  const withLab = mergeConfig(withProject, lab?.data ?? {});
  const withEnv = applyEnvConfig(withLab, env);
  const normalized = normalizeContextConfig(withEnv, env);
  const hardened = applySensitivityPolicy(normalized);
  validateConfig(hardened);
  const finalLab = {
    gatewayUrl: env.LAB_MODEL_GATEWAY_URL ?? hardened.lab?.gatewayUrl ?? null,
    gatewayHealthUrl: env.LAB_MODEL_GATEWAY_HEALTH_URL ?? hardened.lab?.gatewayHealthUrl ?? null,
    gatewayProtocol: env.LAB_MODEL_GATEWAY_PROTOCOL ?? hardened.lab?.gatewayProtocol ?? "lab-agent-gateway",
    gatewayApiKey: env.LAB_MODEL_GATEWAY_API_KEY ?? hardened.lab?.gatewayApiKey ?? null,
    gatewayMaxRetries: parseOptionalInteger(env.LAB_MODEL_GATEWAY_MAX_RETRIES, hardened.lab?.gatewayMaxRetries ?? 2),
    activeGatewayProfile: typeof hardened.lab?.activeGatewayProfile === "string" ? hardened.lab.activeGatewayProfile : "",
    gatewayProfiles: Array.isArray(hardened.lab?.gatewayProfiles) ? hardened.lab.gatewayProfiles : [],
    configPath: labConfigPath
  };
  validateLabConfig(finalLab);

  return {
    ...hardened,
    lab: finalLab,
    projectConfigPath: project?.path ?? null,
    projectConfigPaths: project?.paths ?? [],
    bundledConfigPath: bundled ? BUNDLED_CONFIG_PATH : null
  };
}

/**
 * @param {Record<string, any>} config
 * @param {NodeJS.ProcessEnv} env
 */
function normalizeContextConfig(config, env) {
  const context = config.context ?? {};
  const maxMessages = context.maxMessages;
  const maxTokens = context.maxTokens;
  const maxBytes = context.maxBytes;
  return {
    ...config,
    context: {
      ...context,
      resumeMaxMessages: env.LAB_AGENT_CONTEXT_RESUME_MAX_MESSAGES
        ? context.resumeMaxMessages
        : Math.max(context.resumeMaxMessages ?? maxMessages, maxMessages),
      resumeMaxTokens: env.LAB_AGENT_CONTEXT_RESUME_MAX_TOKENS
        ? context.resumeMaxTokens
        : Math.max(context.resumeMaxTokens ?? maxTokens, maxTokens),
      resumeMaxBytes: env.LAB_AGENT_CONTEXT_RESUME_MAX_BYTES
        ? context.resumeMaxBytes
        : Math.max(context.resumeMaxBytes ?? maxBytes, maxBytes)
    }
  };
}

/**
 * @param {string} cwd
 */
export function localProjectConfigPath(cwd) {
  return path.join(cwd, ".lab-agent", "config.json");
}

/**
 * @param {string} cwd
 */
async function loadProjectConfigs(cwd) {
  const configs = [];
  for (const name of PROJECT_CONFIG_FILES) {
    const candidate = path.join(cwd, name);
    const data = await readJsonIfExists(candidate);
    if (data) {
      configs.push({ path: candidate, data: data.data });
    }
  }
  return configs;
}

/**
 * @param {Array<{ path: string; data: Record<string, any> }>} configs
 */
function mergeProjectConfigs(configs) {
  if (configs.length === 0) {
    return null;
  }
  const merged = configs.reduce((current, item) => mergeConfig(current, item.data ?? {}), {});
  return {
    path: configs[configs.length - 1].path,
    paths: configs.map((item) => item.path),
    data: merged
  };
}

/**
 * @param {string} filePath
 */
async function readJsonIfExists(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return { data: JSON.parse(text) };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/**
 * @param {Record<string, any>} base
 * @param {Record<string, any>} overlay
 */
function mergeConfig(base, overlay) {
  const result = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (isPlainObject(value) && isPlainObject(result[key])) {
      result[key] = mergeConfig(result[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * @param {Record<string, any>} value
 * @param {NodeJS.ProcessEnv} env
 */
function applyEnvConfig(value, env) {
  const next = { ...value };

  if (env.LAB_AGENT_MODEL) {
    next.modelAlias = env.LAB_AGENT_MODEL;
  }

  if (env.LAB_AGENT_MODELS) {
    next.models = parseModelList(env.LAB_AGENT_MODELS);
  }

  if (env.LAB_AGENT_NETWORK_MODE) {
    if (!NETWORK_MODES.includes(env.LAB_AGENT_NETWORK_MODE)) {
      throw new Error(`Unsupported LAB_AGENT_NETWORK_MODE: ${env.LAB_AGENT_NETWORK_MODE}`);
    }
    next.networkMode = env.LAB_AGENT_NETWORK_MODE;
  }

  const allowedHosts = parseHostList(env.LAB_AGENT_ALLOWED_HOSTS);
  if (allowedHosts.length > 0) {
    next.allowedHosts = Array.from(new Set([...(next.allowedHosts ?? []), ...allowedHosts]));
  }

  if (env.LAB_MODEL_GATEWAY_URL) {
    const host = parseHost(env.LAB_MODEL_GATEWAY_URL);
    if (host) {
      next.allowedHosts = Array.from(new Set([...(next.allowedHosts ?? []), host]));
    }
  }

  if (env.LAB_MODEL_GATEWAY_HEALTH_URL) {
    const host = parseHost(env.LAB_MODEL_GATEWAY_HEALTH_URL);
    if (host) {
      next.allowedHosts = Array.from(new Set([...(next.allowedHosts ?? []), host]));
    }
  }

  if (env.LAB_AGENT_TRANSCRIPT_ENABLED) {
    next.transcript = {
      ...(next.transcript ?? {}),
      enabled: parseBoolean(env.LAB_AGENT_TRANSCRIPT_ENABLED)
    };
  }

  if (env.LAB_AGENT_TRANSCRIPT_RETENTION_DAYS) {
    next.transcript = {
      ...(next.transcript ?? {}),
      retentionDays: Number.parseInt(env.LAB_AGENT_TRANSCRIPT_RETENTION_DAYS, 10)
    };
  }

  if (env.LAB_AGENT_TRANSCRIPT_ENCRYPTION) {
    const encryption = env.LAB_AGENT_TRANSCRIPT_ENCRYPTION;
    if (!["off", "optional", "required"].includes(encryption)) {
      throw new Error(`Unsupported LAB_AGENT_TRANSCRIPT_ENCRYPTION: ${encryption}`);
    }
    next.transcript = {
      ...(next.transcript ?? {}),
      encryption
    };
  }

  if (env.LAB_AGENT_SENSITIVITY) {
    next.security = {
      ...(next.security ?? {}),
      sensitivity: env.LAB_AGENT_SENSITIVITY
    };
  }

  const context = {
    maxMessages: parseOptionalPositiveInteger(env.LAB_AGENT_CONTEXT_MAX_MESSAGES),
    maxBytes: parseOptionalPositiveInteger(env.LAB_AGENT_CONTEXT_MAX_BYTES),
    maxTokens: parseOptionalPositiveInteger(env.LAB_AGENT_CONTEXT_MAX_TOKENS),
    keepRecentMessages: parseOptionalPositiveInteger(env.LAB_AGENT_CONTEXT_KEEP_RECENT_MESSAGES),
    tailTurns: parseOptionalPositiveInteger(env.LAB_AGENT_CONTEXT_TAIL_TURNS),
    preserveRecentTokens: parseOptionalPositiveInteger(env.LAB_AGENT_CONTEXT_PRESERVE_RECENT_TOKENS),
    summaryBytes: parseOptionalPositiveInteger(env.LAB_AGENT_CONTEXT_SUMMARY_BYTES),
    resumeMaxMessages: parseOptionalPositiveInteger(env.LAB_AGENT_CONTEXT_RESUME_MAX_MESSAGES),
    resumeMaxTokens: parseOptionalPositiveInteger(env.LAB_AGENT_CONTEXT_RESUME_MAX_TOKENS),
    resumeMaxBytes: parseOptionalPositiveInteger(env.LAB_AGENT_CONTEXT_RESUME_MAX_BYTES)
  };
  const contextEntries = Object.entries(context).filter(([, value]) => value !== null);
  if (contextEntries.length > 0) {
    next.context = {
      ...(next.context ?? {}),
      ...Object.fromEntries(contextEntries)
    };
  }

  const limits = {
    maxToolRounds: parseOptionalPositiveInteger(env.LAB_AGENT_MAX_TOOL_ROUNDS),
    agentMaxRounds: parseOptionalPositiveInteger(env.LAB_AGENT_AGENT_MAX_ROUNDS)
  };
  const limitEntries = Object.entries(limits).filter(([, value]) => value !== null);
  if (limitEntries.length > 0) {
    next.limits = {
      ...(next.limits ?? {}),
      ...(limits.maxToolRounds !== null ? { maxToolRounds: limits.maxToolRounds } : {})
    };
    next.agents = {
      ...(next.agents ?? {}),
      ...(limits.agentMaxRounds !== null ? { maxRounds: limits.agentMaxRounds } : {})
    };
  }

  return next;
}

/**
 * @param {Record<string, any>} config
 */
function applySensitivityPolicy(config) {
  if (config.security?.sensitivity !== "high") {
    return config;
  }

  return {
    ...config,
    transcript: {
      ...(config.transcript ?? {}),
      retentionDays: 0,
      enabled: false
    }
  };
}

/**
 * @param {Record<string, any>} config
 */
function validateConfig(config) {
  const sensitivity = config.security?.sensitivity ?? "standard";
  if (!["standard", "high"].includes(sensitivity)) {
    throw new Error(`Unsupported security.sensitivity: ${sensitivity}`);
  }
  if (sensitivity === "high" && !["offline", "lab-only"].includes(config.networkMode)) {
    throw new Error("High-sensitivity mode requires networkMode offline or lab-only");
  }

  const encryption = config.transcript?.encryption ?? "off";
  if (!["off", "optional", "required"].includes(encryption)) {
    throw new Error(`Unsupported transcript.encryption: ${encryption}`);
  }

  const retentionDays = config.transcript?.retentionDays ?? 30;
  if (!Number.isFinite(retentionDays) || retentionDays < 0) {
    throw new Error(`Unsupported transcript.retentionDays: ${retentionDays}`);
  }

  const context = config.context ?? {};
  for (const key of ["maxMessages", "maxBytes", "maxTokens", "keepRecentMessages", "tailTurns", "preserveRecentTokens", "summaryBytes", "resumeMaxMessages", "resumeMaxTokens", "resumeMaxBytes"]) {
    const value = context[key];
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`Unsupported context.${key}: ${value}`);
    }
  }
  if (context.keepRecentMessages > context.maxMessages) {
    throw new Error("context.keepRecentMessages must be less than or equal to context.maxMessages");
  }
  if (
    context.promptCompactRatio !== undefined
    && context.promptCompactRatio !== null
    && (!Number.isFinite(context.promptCompactRatio) || context.promptCompactRatio <= 0 || context.promptCompactRatio >= 1)
  ) {
    throw new Error(`Unsupported context.promptCompactRatio: ${context.promptCompactRatio}`);
  }

  if (config.models !== undefined && !Array.isArray(config.models)) {
    throw new Error("Unsupported models: expected an array");
  }
  for (const model of config.models ?? []) {
    if (typeof model === "string") {
      continue;
    }
    if (!model || typeof model !== "object" || typeof model.id !== "string" || model.id.trim() === "") {
      throw new Error("Unsupported models entry: expected string or object with id");
    }
    for (const key of ["contextTokens", "maxContextTokens", "contextWindowTokens"]) {
      if (
        model[key] !== undefined
        && model[key] !== null
        && (!Number.isInteger(model[key]) || model[key] <= 0)
      ) {
        throw new Error(`Unsupported models entry ${key}: ${model[key]}`);
      }
    }
    if (
      model.reasoningContentMode !== undefined
      && model.reasoningContentMode !== null
      && !["hidden", "visible-when-no-content"].includes(model.reasoningContentMode)
    ) {
      throw new Error(`Unsupported models entry reasoningContentMode: ${model.reasoningContentMode}`);
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
    if (
      config.agents.maxRounds !== undefined
      && config.agents.maxRounds !== null
      && (!Number.isInteger(config.agents.maxRounds) || config.agents.maxRounds <= 0)
    ) {
      throw new Error(`Unsupported agents.maxRounds: ${config.agents.maxRounds}`);
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
          if (budget[key] !== undefined && (!Number.isInteger(budget[key]) || budget[key] <= 0)) {
            throw new Error(`Unsupported agents.budgets.${name}.${key}: ${budget[key]}`);
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
    if (
      config.limits.maxToolRounds !== undefined
      && config.limits.maxToolRounds !== null
      && (!Number.isInteger(config.limits.maxToolRounds) || config.limits.maxToolRounds <= 0)
    ) {
      throw new Error(`Unsupported limits.maxToolRounds: ${config.limits.maxToolRounds}`);
    }
  }

  if (config.lab?.gatewayProfiles !== undefined) {
    validateGatewayProfiles(config.lab.gatewayProfiles);
  }

  validateHookConfig(config);
}

function validateGatewayProfiles(value) {
  if (!Array.isArray(value)) {
    throw new Error("Unsupported lab.gatewayProfiles: expected an array");
  }
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
    if (profile.gatewayProtocol !== undefined && !GATEWAY_PROTOCOLS.includes(profile.gatewayProtocol)) {
      throw new Error(`Unsupported lab.gatewayProfiles entry gatewayProtocol: ${profile.gatewayProtocol}`);
    }
    if (profile.gatewayApiKey !== undefined && profile.gatewayApiKey !== null && typeof profile.gatewayApiKey !== "string") {
      throw new Error("Unsupported lab.gatewayProfiles entry gatewayApiKey: expected string");
    }
    if (profile.modelAlias !== undefined && typeof profile.modelAlias !== "string") {
      throw new Error("Unsupported lab.gatewayProfiles entry modelAlias: expected string");
    }
    if (profile.models !== undefined && !Array.isArray(profile.models)) {
      throw new Error("Unsupported lab.gatewayProfiles entry models: expected array");
    }
    if (profile.agents !== undefined && !isPlainObject(profile.agents)) {
      throw new Error("Unsupported lab.gatewayProfiles entry agents: expected object");
    }
    validateProfileModels(profile.models ?? []);
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

function validateProfileModels(models) {
  for (const model of models) {
    if (typeof model === "string") {
      continue;
    }
    if (!model || typeof model !== "object" || typeof model.id !== "string" || model.id.trim() === "") {
      throw new Error("Unsupported lab.gatewayProfiles entry models item: expected string or object with id");
    }
    if (model.modalities !== undefined && model.modalities !== null && !validModelModalities(model.modalities)) {
      throw new Error("Unsupported lab.gatewayProfiles entry models item modalities: expected text/image");
    }
    if (model.agentModelTiers !== undefined && model.agentModelTiers !== null && !isPlainObject(model.agentModelTiers)) {
      throw new Error("Unsupported lab.gatewayProfiles entry models item agentModelTiers: expected object");
    }
  }
}

function validateAgentOrchestrationConfig(value) {
  if (!isPlainObject(value)) {
    throw new Error("Unsupported agents.orchestration: expected an object");
  }
  for (const key of ["enabled", "allowParallelReadonly", "allowParallelWrites", "autoReview", "autoContinuePartial"]) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") {
      throw new Error(`Unsupported agents.orchestration.${key}: expected boolean`);
    }
  }
  if (
    value.maxParallelReadonlyAgentRuns !== undefined
    && (!Number.isInteger(value.maxParallelReadonlyAgentRuns) || value.maxParallelReadonlyAgentRuns <= 0)
  ) {
    throw new Error(`Unsupported agents.orchestration.maxParallelReadonlyAgentRuns: ${value.maxParallelReadonlyAgentRuns}`);
  }
}

function validateDelegationGuardConfig(value) {
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
    if (value[key] !== undefined && (!Number.isInteger(value[key]) || value[key] <= 0)) {
      throw new Error(`Unsupported agents.delegationGuard.${key}: ${value[key]}`);
    }
  }
  if (
    Number.isInteger(value.softThreshold)
    && Number.isInteger(value.strongThreshold)
    && value.strongThreshold <= value.softThreshold
  ) {
    throw new Error("Unsupported agents.delegationGuard: strongThreshold must be greater than softThreshold");
  }
}

function validateBackgroundWakeupConfig(value) {
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
    if (value[key] !== undefined && (!Number.isInteger(value[key]) || value[key] <= 0)) {
      throw new Error(`Unsupported agents.backgroundWakeup.${key}: ${value[key]}`);
    }
  }
}

function validateReviewGateConfig(value) {
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
    if (value[key] !== undefined && (!Number.isInteger(value[key]) || value[key] <= 0)) {
      throw new Error(`Unsupported agents.reviewGate.${key}: ${value[key]}`);
    }
  }
  for (const key of ["requireForWrites", "requireForHighRisk"]) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") {
      throw new Error(`Unsupported agents.reviewGate.${key}: expected boolean`);
    }
  }
}

function validateVisionAgentConfig(value) {
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
 * @param {{ gatewayProtocol?: string; gatewayApiKey?: string | null; gatewayMaxRetries?: number }} lab
 */
function validateLabConfig(lab) {
  const protocol = lab.gatewayProtocol ?? "lab-agent-gateway";
  if (!GATEWAY_PROTOCOLS.includes(protocol)) {
    throw new Error(`Unsupported LAB_MODEL_GATEWAY_PROTOCOL: ${protocol}`);
  }
  if (lab.gatewayApiKey !== null && lab.gatewayApiKey !== undefined && typeof lab.gatewayApiKey !== "string") {
    throw new Error("Unsupported lab.gatewayApiKey: expected string");
  }
  if (!Number.isInteger(lab.gatewayMaxRetries) || lab.gatewayMaxRetries < 0 || lab.gatewayMaxRetries > 5) {
    throw new Error(`Unsupported lab.gatewayMaxRetries: ${lab.gatewayMaxRetries}`);
  }
}

/**
 * @param {string | undefined} value
 */
function parseHostList(value) {
  if (!value) {
    return [];
  }
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

/**
 * @param {string} value
 */
function parseHost(value) {
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

/**
 * @param {string} value
 */
function parseBoolean(value) {
  return /^(1|true|yes|on)$/i.test(value);
}

/**
 * @param {string | undefined} value
 */
function parseOptionalPositiveInteger(value) {
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

function parseOptionalInteger(value, fallback) {
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
function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validModelModalities(value) {
  const items = Array.isArray(value)
    ? value
    : typeof value === "string" ? value.split(/[, ]+/) : [];
  return items.length > 0 && items.every((item) => {
    const text = String(item ?? "").trim().toLowerCase();
    return !text || ["text", "image", "images", "vision", "visual", "multimodal", "文本", "图片", "视觉"].includes(text);
  });
}
