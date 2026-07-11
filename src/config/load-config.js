import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
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
const DEFAULT_GATEWAY_MAX_RETRIES = 5;
const DEFAULT_GATEWAY_TIMEOUT_MS = 900000;
const DEFAULT_GATEWAY_IDLE_TIMEOUT_MS = 300000;
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
    gatewayMaxRetries: DEFAULT_GATEWAY_MAX_RETRIES,
    gatewayTimeoutMs: DEFAULT_GATEWAY_TIMEOUT_MS,
    gatewayIdleTimeoutMs: DEFAULT_GATEWAY_IDLE_TIMEOUT_MS
  }
});

/**
 * @typedef {typeof DEFAULT_CONFIG & {
 *   lab: { gatewayUrl: string | null; gatewayHealthUrl: string | null; gatewayProtocol: string; gatewayApiKey: string | null; gatewayMaxRetries: number; configPath: string | null };
 *   projectConfigPath: string | null;
 *   globalConfigPath: string;
 *   defaultModelAlias: string;
 * }} LabAgentConfig
 */

/**
 * Load config from defaults, bundled JSON, optional global JSON, environment
 * model/gateway defaults, project JSON, and runtime environment controls.
 *
 * Precedence:
 * defaults < bundled config < global config < model/gateway env defaults
 * < project config < runtime env controls.
 *
 * @param {{ cwd?: string; env?: NodeJS.ProcessEnv }} options
 * @returns {Promise<LabAgentConfig>}
 */
export async function loadConfig(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;

  const projectConfigs = await loadProjectConfigs(cwd);
  const project = mergeProjectConfigs(projectConfigs);
  const explicitLabConfigPath = hasNonEmptyEnv(env, "LAB_AGENT_CONFIG");
  const labConfigPath = globalConfigPath(env);
  const labConfigReadPath = explicitLabConfigPath || shouldReadDefaultGlobalConfig(env) ? labConfigPath : null;
  const bundled = await readJsonIfExists(BUNDLED_CONFIG_PATH);
  const rawLab = labConfigReadPath ? await readJsonIfExists(labConfigReadPath) : null;
  const lab = rawLab ? {
    ...rawLab,
    path: labConfigReadPath,
    label: explicitLabConfigPath ? "LAB_AGENT_CONFIG" : "user global config"
  } : null;

  const withBundled = mergeConfig(DEFAULT_CONFIG, bundled?.data ?? {});
  const withGlobalDefaults = mergeConfig(withBundled, lab?.data ?? {});
  const withEnvDefaults = applyEnvDefaultConfig(withGlobalDefaults, env, {
    preserveConfiguredModels: Boolean(bundled && !lab)
  });
  const withProject = mergeConfig(withEnvDefaults, project?.data ?? {});
  const withEnv = applyRuntimeEnvConfig(withProject, env);
  const normalized = normalizeContextConfig(withEnv, env);
  const hardened = applySensitivityPolicy(normalized);
  validateConfig(hardened);
  const finalLab = {
    gatewayUrl: hardened.lab?.gatewayUrl ?? null,
    gatewayHealthUrl: hardened.lab?.gatewayHealthUrl ?? null,
    gatewayProtocol: hardened.lab?.gatewayProtocol ?? "lab-agent-gateway",
    gatewayApiKey: hardened.lab?.gatewayApiKey ?? null,
    gatewayMaxRetries: parseOptionalInteger(env.LAB_MODEL_GATEWAY_MAX_RETRIES, hardened.lab?.gatewayMaxRetries ?? DEFAULT_GATEWAY_MAX_RETRIES),
    gatewayTimeoutMs: parseOptionalInteger(env.LAB_MODEL_GATEWAY_TIMEOUT_MS, hardened.lab?.gatewayTimeoutMs ?? DEFAULT_GATEWAY_TIMEOUT_MS),
    gatewayIdleTimeoutMs: parseOptionalInteger(env.LAB_MODEL_GATEWAY_IDLE_TIMEOUT_MS, hardened.lab?.gatewayIdleTimeoutMs ?? DEFAULT_GATEWAY_IDLE_TIMEOUT_MS),
    activeGatewayProfile: typeof hardened.lab?.activeGatewayProfile === "string" ? hardened.lab.activeGatewayProfile : "",
    gatewayProfiles: Array.isArray(hardened.lab?.gatewayProfiles) ? hardened.lab.gatewayProfiles : [],
    configPath: lab ? labConfigReadPath : explicitLabConfigPath ? labConfigPath : null
  };
  validateLabConfig(finalLab);
  const configSources = buildConfigSources({ env, project, lab, bundled });

  return {
    ...hardened,
    lab: {
      ...finalLab,
      sources: configSources.lab
    },
    defaultModelAlias: hardened.modelAlias,
    projectConfigPath: project?.path ?? null,
    projectConfigPaths: project?.paths ?? [],
    bundledConfigPath: bundled ? BUNDLED_CONFIG_PATH : null,
    globalConfigPath: labConfigPath,
    configSources
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
  const maxBytes = normalizeContextMaxBytes(context, env);
  return {
    ...config,
    context: {
      ...context,
      maxBytes,
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

function normalizeContextMaxBytes(context, env) {
  const maxTokens = Number.isInteger(context.maxTokens) && context.maxTokens > 0 ? context.maxTokens : null;
  const currentMaxBytes = Number.isInteger(context.maxBytes) && context.maxBytes > 0 ? context.maxBytes : null;
  const tokenAlignedMaxBytes = maxTokens ? maxTokens * 4 : null;
  if (env.LAB_AGENT_CONTEXT_MAX_BYTES) {
    return currentMaxBytes;
  }
  return Math.max(currentMaxBytes ?? 0, tokenAlignedMaxBytes ?? 0) || currentMaxBytes;
}

/**
 * @param {string} cwd
 */
export function localProjectConfigPath(cwd) {
  return path.join(cwd, ".lab-agent", "config.json");
}

/**
 * User-level model/gateway defaults edited by Dashboard.
 *
 * @param {NodeJS.ProcessEnv} env
 */
export function globalConfigPath(env = process.env) {
  const explicit = String(env.LAB_AGENT_CONFIG ?? "").trim();
  if (explicit) {
    return path.resolve(explicit);
  }
  if (env.LAB_AGENT_HOME) {
    return path.join(path.resolve(env.LAB_AGENT_HOME), "lab-agent.config.json");
  }
  const home = env.USERPROFILE || env.HOME || os.homedir();
  return path.join(home, ".ant-code", "lab-agent.config.json");
}

function shouldReadDefaultGlobalConfig(env) {
  return env === process.env
    || hasNonEmptyEnv(env, "LAB_AGENT_HOME")
    || hasNonEmptyEnv(env, "USERPROFILE")
    || hasNonEmptyEnv(env, "HOME");
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
    return sanitizeLoadedConfig(JSON.parse(text), filePath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/**
 * @param {unknown} raw
 * @param {string} filePath
 */
function sanitizeLoadedConfig(raw, filePath) {
  const data = isPlainObject(raw) ? cloneJsonObject(raw) : {};
  const templateLike = isExampleConfig(data);
  let ignoredModelGatewayTemplate = templateLike;
  if (templateLike) {
    if (path.resolve(filePath) === path.resolve(BUNDLED_CONFIG_PATH)) {
      stripBundledTemplateGateway(data);
    } else {
      stripModelGatewayConfig(data);
    }
  } else {
    ignoredModelGatewayTemplate = stripPlaceholderModelGatewayFields(data);
  }
  if (templateLike || ignoredModelGatewayTemplate) {
    stripPlaceholderAllowedHosts(data);
  }
  return {
    data,
    ignoredModelGatewayTemplate,
    path: filePath
  };
}

function isExampleConfig(config) {
  const marked = config?.example === true
    || config?.template === true
    || config?.isExample === true
    || config?.isTemplate === true
    || config?.metadata?.example === true
    || config?.metadata?.template === true;
  return marked && hasTemplatePlaceholderModelGatewayConfig(config);
}

function hasTemplatePlaceholderModelGatewayConfig(config) {
  const lab = isPlainObject(config?.lab) ? config.lab : {};
  return isTemplatePlaceholderConfigValue(config?.modelAlias)
    || (Array.isArray(config?.models) && config.models.some((model) => isTemplatePlaceholderConfigValue(typeof model === "string" ? model : model?.id)))
    || isTemplatePlaceholderConfigValue(lab.gatewayUrl)
    || isTemplatePlaceholderConfigValue(lab.gatewayHealthUrl)
    || (Array.isArray(lab.gatewayProfiles) && lab.gatewayProfiles.some((profile) =>
      isTemplatePlaceholderConfigValue(profile?.gatewayUrl)
      || isTemplatePlaceholderConfigValue(profile?.gatewayHealthUrl)
      || isTemplatePlaceholderConfigValue(profile?.modelAlias)
      || (Array.isArray(profile?.models) && profile.models.some((model) => isTemplatePlaceholderConfigValue(typeof model === "string" ? model : model?.id)))
    ));
}

function isTemplatePlaceholderConfigValue(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return isPlaceholderConfigValue(value)
    || text.includes("gateway.lab.example")
    || text.includes("gateway.example.com");
}

function isPlaceholderConfigValue(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) {
    return false;
  }
  return text.includes("<")
    || text.includes(">")
    || text.includes("your-")
    || text.includes("your_")
    || text.includes("replace-me")
    || text.includes("replace_me")
    || text.includes("placeholder")
    || text.includes("example.invalid")
    || text === "model-id"
    || text === "demo-model";
}

function stripPlaceholderModelGatewayFields(config) {
  let stripped = false;
  if (isPlaceholderConfigValue(config.modelAlias)) {
    delete config.modelAlias;
    stripped = true;
  }
  if (Array.isArray(config.models)) {
    const nextModels = config.models.filter((model) => !isPlaceholderConfigValue(typeof model === "string" ? model : model?.id));
    if (nextModels.length !== config.models.length) {
      config.models = nextModels;
      stripped = true;
    }
    if (nextModels.length === 0) {
      delete config.models;
    }
  }
  if (isPlainObject(config.lab)) {
    for (const key of ["gatewayUrl", "gatewayHealthUrl", "gatewayApiKey"]) {
      if (isPlaceholderConfigValue(config.lab[key])) {
        delete config.lab[key];
        stripped = true;
      }
    }
    if (stripped && !hasConfigPath(config, "lab.gatewayUrl")) {
      delete config.lab.gatewayProtocol;
    }
    if (Array.isArray(config.lab.gatewayProfiles)) {
      const profiles = [];
      for (const profile of config.lab.gatewayProfiles) {
        if (!isPlainObject(profile)) {
          continue;
        }
        const nextProfile = cloneJsonObject(profile);
        let profileStripped = false;
        for (const key of ["gatewayUrl", "gatewayHealthUrl", "modelAlias", "gatewayApiKey"]) {
          if (isPlaceholderConfigValue(nextProfile[key])) {
            delete nextProfile[key];
            profileStripped = true;
          }
        }
        if (Array.isArray(nextProfile.models)) {
          const nextModels = nextProfile.models.filter((model) => !isPlaceholderConfigValue(typeof model === "string" ? model : model?.id));
          if (nextModels.length !== nextProfile.models.length) {
            nextProfile.models = nextModels;
            profileStripped = true;
          }
        }
        stripped = stripped || profileStripped;
        if (nextProfile.gatewayUrl || nextProfile.gatewayHealthUrl || nextProfile.modelAlias || (Array.isArray(nextProfile.models) && nextProfile.models.length > 0)) {
          profiles.push(nextProfile);
        }
      }
      if (profiles.length !== config.lab.gatewayProfiles.length) {
        stripped = true;
      }
      if (profiles.length > 0) {
        config.lab.gatewayProfiles = profiles;
      } else {
        delete config.lab.gatewayProfiles;
      }
    }
  }
  return stripped;
}

function stripModelGatewayConfig(config) {
  delete config.modelAlias;
  delete config.models;
  if (isPlainObject(config.lab)) {
    delete config.lab.gatewayUrl;
    delete config.lab.gatewayHealthUrl;
    delete config.lab.gatewayProtocol;
    delete config.lab.gatewayApiKey;
    delete config.lab.activeGatewayProfile;
    delete config.lab.gatewayProfiles;
  }
  if (isPlainObject(config.agents)) {
    delete config.agents.modelTiers;
    if (isPlainObject(config.agents.vision)) {
      delete config.agents.vision.model;
    }
  }
}

/** @param {Record<string, any>} config */
function stripBundledTemplateGateway(config) {
  if (!isPlainObject(config.lab)) {
    return;
  }
  delete config.lab.gatewayUrl;
  delete config.lab.gatewayHealthUrl;
  delete config.lab.gatewayProtocol;
  delete config.lab.gatewayApiKey;
  delete config.lab.activeGatewayProfile;
  delete config.lab.gatewayProfiles;
}

function stripPlaceholderAllowedHosts(config) {
  if (!Array.isArray(config.allowedHosts)) {
    return;
  }
  config.allowedHosts = config.allowedHosts.filter((host) => !isPlaceholderAllowedHost(host));
}

function isPlaceholderAllowedHost(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return isPlaceholderConfigValue(value)
    || text === "gateway.lab.example"
    || text.endsWith(".lab.example")
    || text === "gateway.example.com"
    || text === "example.invalid"
    || text.endsWith(".example.invalid");
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

function buildConfigSources({ env, project, lab, bundled }) {
  const source = {
    modelAlias: configSourceFor("modelAlias", { env, project, lab, bundled }),
    models: configSourceFor("models", { env, project, lab, bundled }),
    lab: {
      gatewayUrl: configSourceFor("lab.gatewayUrl", { env, project, lab, bundled }),
      gatewayHealthUrl: configSourceFor("lab.gatewayHealthUrl", { env, project, lab, bundled }),
      gatewayProtocol: configSourceFor("lab.gatewayProtocol", { env, project, lab, bundled }),
      gatewayApiKey: configSourceFor("lab.gatewayApiKey", { env, project, lab, bundled })
    }
  };
  return source;
}

function configSourceFor(keyPath, { env, project, lab, bundled }) {
  const envKey = envKeyForConfigPath(keyPath);
  if (hasConfigPath(project?.data, keyPath)) {
    return {
      type: "project",
      label: ".lab-agent/config.json",
      path: project?.path ?? null
    };
  }
  if (envKey && hasNonEmptyEnv(env, envKey)) {
    return {
      type: "environment",
      label: envKey,
      env: envKey
    };
  }
  if (hasConfigPath(lab?.data, keyPath)) {
    return {
      type: "global",
      label: lab?.label ?? "global config",
      path: lab?.path ?? null
    };
  }
  if (hasConfigPath(bundled?.data, keyPath)) {
    return {
      type: "bundled",
      label: "bundled",
      path: BUNDLED_CONFIG_PATH
    };
  }
  return {
    type: "default",
    label: "default"
  };
}

function envKeyForConfigPath(keyPath) {
  return {
    modelAlias: "LAB_AGENT_MODEL",
    models: "LAB_AGENT_MODELS",
    "lab.gatewayUrl": "LAB_MODEL_GATEWAY_URL",
    "lab.gatewayHealthUrl": "LAB_MODEL_GATEWAY_HEALTH_URL",
    "lab.gatewayProtocol": "LAB_MODEL_GATEWAY_PROTOCOL",
    "lab.gatewayApiKey": "LAB_MODEL_GATEWAY_API_KEY"
  }[keyPath] ?? "";
}

function hasNonEmptyEnv(env, key) {
  return env[key] !== undefined && env[key] !== null && String(env[key]).trim() !== "";
}

function hasConfigPath(config, keyPath) {
  if (!config || typeof config !== "object") {
    return false;
  }
  let current = config;
  for (const segment of keyPath.split(".")) {
    if (!current || typeof current !== "object") {
      return false;
    }
    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
      return false;
    }
    current = current[segment];
  }
  return current !== undefined && !(typeof current === "string" && current.trim() === "");
}

/**
 * @param {Record<string, any>} value
 * @param {NodeJS.ProcessEnv} env
 * @param {{ preserveConfiguredModels?: boolean }} [options]
 */
function applyEnvDefaultConfig(value, env, options = {}) {
  const next = { ...value };
  const envControlsModel = hasNonEmptyEnv(env, "LAB_AGENT_MODEL") || hasNonEmptyEnv(env, "LAB_AGENT_MODELS");
  const envControlsGateway = hasNonEmptyEnv(env, "LAB_MODEL_GATEWAY_URL")
    || hasNonEmptyEnv(env, "LAB_MODEL_GATEWAY_HEALTH_URL")
    || hasNonEmptyEnv(env, "LAB_MODEL_GATEWAY_PROTOCOL")
    || hasNonEmptyEnv(env, "LAB_MODEL_GATEWAY_API_KEY");

  if (env.LAB_AGENT_MODEL) {
    next.modelAlias = env.LAB_AGENT_MODEL;
  }

  if (env.LAB_AGENT_MODELS) {
    next.models = parseModelList(env.LAB_AGENT_MODELS);
  } else if (env.LAB_AGENT_MODEL) {
    next.models = envModelList(next.models, env.LAB_AGENT_MODEL, options.preserveConfiguredModels === true);
  }

  const lab = { ...(next.lab ?? {}) };
  if (env.LAB_MODEL_GATEWAY_URL) {
    lab.gatewayUrl = env.LAB_MODEL_GATEWAY_URL;
  }
  if (env.LAB_MODEL_GATEWAY_HEALTH_URL) {
    lab.gatewayHealthUrl = env.LAB_MODEL_GATEWAY_HEALTH_URL;
  }
  if (env.LAB_MODEL_GATEWAY_PROTOCOL) {
    if (!GATEWAY_PROTOCOLS.includes(env.LAB_MODEL_GATEWAY_PROTOCOL)) {
      throw new Error(`Unsupported LAB_MODEL_GATEWAY_PROTOCOL: ${env.LAB_MODEL_GATEWAY_PROTOCOL}`);
    }
    lab.gatewayProtocol = env.LAB_MODEL_GATEWAY_PROTOCOL;
  }
  if (env.LAB_MODEL_GATEWAY_API_KEY) {
    lab.gatewayApiKey = env.LAB_MODEL_GATEWAY_API_KEY;
  }
  if (envControlsModel || envControlsGateway) {
    lab.gatewayProfiles = [
      envGatewayProfile({
        modelAlias: next.modelAlias,
        models: next.models,
        lab,
        agents: next.agents
      })
    ].filter(Boolean);
    lab.activeGatewayProfile = lab.gatewayProfiles[0]?.id ?? "";
  }
  next.lab = lab;

  const envGatewayHosts = [
    parseHost(env.LAB_MODEL_GATEWAY_URL),
    parseHost(env.LAB_MODEL_GATEWAY_HEALTH_URL)
  ].filter(Boolean);
  if (envGatewayHosts.length > 0) {
    next.allowedHosts = Array.from(new Set([...(next.allowedHosts ?? []), ...envGatewayHosts]));
  }

  return next;
}

function envGatewayProfile(config) {
  const gatewayUrl = String(config.lab?.gatewayUrl ?? "").trim();
  if (!gatewayUrl) {
    return null;
  }
  const gatewayProtocol = String(config.lab?.gatewayProtocol ?? "lab-agent-gateway").trim();
  return {
    id: gatewayProfileIdFromParts(gatewayProtocol, gatewayUrl),
    label: parseHost(gatewayUrl) || gatewayUrl,
    gatewayUrl,
    gatewayHealthUrl: String(config.lab?.gatewayHealthUrl ?? "").trim(),
    gatewayProtocol,
    ...(config.lab?.gatewayApiKey ? { gatewayApiKey: config.lab.gatewayApiKey } : {}),
    modelAlias: String(config.modelAlias ?? "").trim(),
    models: Array.isArray(config.models) ? config.models : [],
    ...(isPlainObject(config.agents) ? { agents: cloneJsonObject(config.agents) } : {})
  };
}

function envModelList(models, modelAlias, preserveConfiguredModels = false) {
  const id = String(modelAlias ?? "").trim();
  if (!id) {
    return Array.isArray(models) ? models : [];
  }
  const configured = Array.isArray(models) ? models : [];
  const matching = configured.filter((model) => String(typeof model === "string" ? model : model?.id ?? "").trim() === id);
  if (matching.length > 0) {
    return preserveConfiguredModels ? configured : matching;
  }
  const selected = parseModelList(id);
  return preserveConfiguredModels ? [...selected, ...configured] : selected;
}

function gatewayProfileIdFromParts(protocol, gatewayUrl) {
  const raw = `${String(protocol ?? "lab-agent-gateway").trim()}|${String(gatewayUrl ?? "").trim()}`;
  if (!String(gatewayUrl ?? "").trim()) {
    return "";
  }
  return `gw-${createHash("sha1").update(raw).digest("hex").slice(0, 12)}`;
}

/**
 * @param {Record<string, any>} value
 * @param {NodeJS.ProcessEnv} env
 */
function applyRuntimeEnvConfig(value, env) {
  const next = { ...value };

  if (env.LAB_AGENT_NETWORK_MODE) {
    if (!NETWORK_MODES.includes(env.LAB_AGENT_NETWORK_MODE)) {
      throw new Error(`Unsupported LAB_AGENT_NETWORK_MODE: ${env.LAB_AGENT_NETWORK_MODE}`);
    }
    next.networkMode = env.LAB_AGENT_NETWORK_MODE;
  }

  const allowedHosts = parseHostList(env.LAB_AGENT_ALLOWED_HOSTS);
  const runtimeGatewayHosts = [
    parseHost(env.LAB_MODEL_GATEWAY_URL ?? ""),
    parseHost(env.LAB_MODEL_GATEWAY_HEALTH_URL ?? "")
  ].filter(isNonEmptyString);
  if (allowedHosts.length > 0 || runtimeGatewayHosts.length > 0) {
    next.allowedHosts = Array.from(new Set([
      ...(next.allowedHosts ?? []),
      ...allowedHosts,
      ...runtimeGatewayHosts
    ]));
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
 * @param {unknown} value
 * @returns {value is string}
 */
function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
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
    && (!Number.isFinite(context.promptCompactRatio) || context.promptCompactRatio <= 0 || context.promptCompactRatio > 1)
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
 * @param {{ gatewayProtocol?: string; gatewayApiKey?: string | null; gatewayMaxRetries?: number; gatewayTimeoutMs?: number; gatewayIdleTimeoutMs?: number }} lab
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
  if (!Number.isInteger(lab.gatewayTimeoutMs) || lab.gatewayTimeoutMs < 1000 || lab.gatewayTimeoutMs > 900000) {
    throw new Error(`Unsupported lab.gatewayTimeoutMs: ${lab.gatewayTimeoutMs}`);
  }
  if (!Number.isInteger(lab.gatewayIdleTimeoutMs) || lab.gatewayIdleTimeoutMs < 1000 || lab.gatewayIdleTimeoutMs > 300000) {
    throw new Error(`Unsupported lab.gatewayIdleTimeoutMs: ${lab.gatewayIdleTimeoutMs}`);
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

function cloneJsonObject(value) {
  return JSON.parse(JSON.stringify(value ?? {}));
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
