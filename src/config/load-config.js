import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseModelList } from "../model-gateway/models.js";
import { DEFAULT_GATEWAY_MAX_RESPONSE_BYTES } from "../model-gateway/limits.js";
import { recommendedMcpServers } from "../mcp/recommended.js";
import { validateHookConfig } from "../hooks/registry.js";
import { createCredentialStore } from "../credentials/store.js";
import { createFileRepository } from "../config-v2/file-repository.js";
import { projectLegacyRuntimeConfig } from "../config-v2/legacy-projection.js";
import { stripLegacyModelFields } from "../config-v2/migrate-v1.js";
import {
  credentialsPath,
  globalLegacyConfigPath,
  globalSettingsPath,
  projectLegacyConfigPath,
  projectSettingsPath
} from "../config-v2/paths.js";
import { resolveSettingsLayers } from "../config-v2/resolver.js";
import { mergeRuntimeAgentRouting, replaceRuntimeAgentRouting } from "../config-v2/runtime-selection.js";
import {
  GOAL_ABS_MAX_AUTO_CONTINUES,
  GOAL_MAX_AUTO_CONTINUES,
  GOAL_MIN_AUTO_CONTINUES
} from "../core/goal.js";

export const NETWORK_MODES = Object.freeze([
  "offline",
  "lab-only",
  "approved-web",
  "open-dev"
]);

export const GATEWAY_PROTOCOLS = Object.freeze([
  "lab-agent-gateway",
  "openai-chat",
  "openai-responses",
  "anthropic-messages"
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
  modelAlias: "",
  reasoningEffort: null,
  models: [],
  routingModels: [],
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
    goal: {
      maxAutoContinues: GOAL_MAX_AUTO_CONTINUES
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
    gatewayProtocol: "openai-chat",
    gatewayApiKey: null,
    gatewayMaxRetries: DEFAULT_GATEWAY_MAX_RETRIES,
    gatewayTimeoutMs: DEFAULT_GATEWAY_TIMEOUT_MS,
    gatewayIdleTimeoutMs: DEFAULT_GATEWAY_IDLE_TIMEOUT_MS,
    gatewayMaxResponseBytes: DEFAULT_GATEWAY_MAX_RESPONSE_BYTES
  }
});

/**
 * @typedef {typeof DEFAULT_CONFIG & {
 *   lab: { gatewayUrl: string | null; gatewayHealthUrl: string | null; gatewayProtocol: string; gatewayApiKey: string | null; gatewayMaxRetries: number; gatewayMaxResponseBytes: number; configPath: string | null };
 *   projectConfigPath: string | null;
 *   projectConfigPaths: string[];
 *   globalConfigPath: string;
 *   defaultModelAlias: string;
 * }} LabAgentConfig
 */

/**
 * Load config from defaults, bundled JSON, optional global JSON, environment
 * model/gateway defaults, global JSON, project JSON, and runtime environment controls.
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
  const configV2 = await loadConfigV2Runtime({
    cwd,
    env,
    readGlobal: Boolean(labConfigReadPath)
  });
  const bundled = await readJsonIfExists(BUNDLED_CONFIG_PATH);
  const rawLab = labConfigReadPath ? await readJsonIfExists(labConfigReadPath) : null;
  const lab = rawLab ? {
    ...rawLab,
    data: configV2.enabled
      ? stripLegacyModelFields(materializeLayerGatewayProfile(rawLab.data))
      : materializeLayerGatewayProfile(rawLab.data),
    path: labConfigReadPath,
    label: explicitLabConfigPath ? "LAB_AGENT_CONFIG" : "用户全局配置"
  } : null;

  const withBundled = mergeConfig(DEFAULT_CONFIG, bundled?.data ?? {});
  const withGlobalDefaults = mergeConfigWithGatewayCredentialScope(withBundled, lab?.data ?? {});
  const withLegacyEnvDefaults = configV2.enabled
    ? withGlobalDefaults
    : applyEnvDefaultConfig(withGlobalDefaults, env, {
        preserveConfiguredModels: Boolean(bundled && !lab)
      });
  const projectData = /** @type {Record<string, any>} */ (
    configV2.enabled ? stripLegacyModelFields(project?.data ?? {}) : project?.data ?? {}
  );
  const withProject = mergeConfigWithGatewayCredentialScope(withLegacyEnvDefaults, projectData);
  const withProjectedModelSettings = configV2.enabled
    ? {
        ...mergeConfigWithGatewayCredentialScope(withProject, configV2.runtimeProjection, {
          gatewayProfileIdentity: "id"
        }),
        allowedHosts: Array.from(new Set([
          ...(Array.isArray(withProject.allowedHosts) ? withProject.allowedHosts : []),
          ...configV2.gatewayHosts
        ]))
      }
    : withProject;
  const withModelSettings = configV2.enabled
    ? applyLegacyReliabilityOverrides(withProjectedModelSettings, [bundled?.data, lab?.data, projectData])
    : withProjectedModelSettings;
  const withEnvDefaults = configV2.enabled
    ? applyEnvDefaultConfig(withModelSettings, env, {
        preserveConfiguredModels: true,
        gatewayProfileIdentity: "id"
      })
    : withModelSettings;
  const selectionLayer = configV2.enabled
    ? hasModelGatewayEnvironmentControls(env) ? withEnvDefaults : configV2.runtimeProjection
    : projectData;
  const withSelectedProfile = shouldApplyActiveGatewayProfile(withEnvDefaults, selectionLayer)
    ? applyActiveGatewayProfileConfig(withEnvDefaults, {
        strictProfileId: configV2.enabled,
        projectedAgentRouting: configV2.enabled ? configV2.runtimeProjection?.agents : undefined,
        projectedAgentRoutingProviderId: configV2.enabled
          ? configV2.runtimeProjection?.lab?.activeGatewayProfile
          : undefined
      })
    : withEnvDefaults;
  const withEnv = applyRuntimeEnvConfig(withSelectedProfile, env);
  const normalized = normalizeAllowedHostsConfig(normalizeContextConfig(withEnv, env));
  const hardened = applySensitivityPolicy(normalized);
  validateConfig(hardened);
  let resolvedProfiles = /** @type {Array<Record<string, any>>} */ (
    Array.isArray(hardened.lab?.gatewayProfiles)
      ? hardened.lab.gatewayProfiles.map((/** @type {Record<string, any>} */ profile) => cloneJsonObject(profile))
      : []
  );
  const projectClearsGatewayProfiles = Array.isArray(projectData.lab?.gatewayProfiles)
    && projectData.lab.gatewayProfiles.length === 0;
  const activeEndpoint = { lab: hardened.lab };
  const configuredActiveId = String(hardened.lab?.activeGatewayProfile ?? "").trim();
  let activeProfile = configV2.enabled
    ? resolvedProfiles.find((profile) => String(profile?.id ?? "") === configuredActiveId) ?? null
    : resolvedProfiles.find((profile) => (
        String(profile?.id ?? "") === configuredActiveId
        && sameGatewayEndpoint({ lab: profile }, activeEndpoint)
      )) ?? resolvedProfiles.find((profile) => sameGatewayEndpoint({ lab: profile }, activeEndpoint)) ?? null;
  if (configV2.enabled && configuredActiveId && !activeProfile) {
    throw new Error(`Configured Config V2 provider is unavailable: ${configuredActiveId}`);
  }
  const activeGatewayUrl = String(hardened.lab?.gatewayUrl ?? "").trim();
  if (activeGatewayUrl && !projectClearsGatewayProfiles) {
    const gatewayProtocol = String(hardened.lab?.gatewayProtocol ?? "openai-chat").trim();
    const profileAgents = gatewayProfileAgentSnapshot(hardened.agents);
    const synthesizedActiveProfile = {
      id: activeProfile?.id ?? gatewayProfileIdFromParts(gatewayProtocol, activeGatewayUrl),
      label: String(activeProfile?.label ?? "").trim() || parseHost(activeGatewayUrl) || activeGatewayUrl,
      gatewayUrl: activeGatewayUrl,
      gatewayHealthUrl: String(hardened.lab?.gatewayHealthUrl ?? "").trim(),
      gatewayProtocol,
      ...(String(hardened.lab?.gatewayApiKey ?? "").trim() ? { gatewayApiKey: hardened.lab.gatewayApiKey } : {}),
      ...(hardened.lab?.gatewayApiKeyDisabled === true ? { gatewayApiKeyDisabled: true } : {}),
      modelAlias: String(hardened.modelAlias ?? "").trim(),
      models: Array.isArray(hardened.models) ? cloneJsonObject(hardened.models) : [],
      routingModels: Array.isArray(hardened.routingModels) ? cloneJsonObject(hardened.routingModels) : [],
      ...(profileAgents ? { agents: profileAgents } : {})
    };
    activeProfile = synthesizedActiveProfile;
    resolvedProfiles = [
      ...resolvedProfiles.filter((profile) => (
        String(profile?.id ?? "") !== synthesizedActiveProfile.id
        && (configV2.enabled || !sameGatewayEndpoint({ lab: profile }, activeEndpoint))
      )),
      synthesizedActiveProfile
    ];
  }
  const gatewayApiKeyDisabled = hardened.lab?.gatewayApiKeyDisabled === true
    || (!String(hardened.lab?.gatewayApiKey ?? "").trim() && activeProfile?.gatewayApiKeyDisabled === true);
  const finalLab = /** @type {Record<string, any>} */ ({
    gatewayUrl: hardened.lab?.gatewayUrl ?? null,
    gatewayHealthUrl: hardened.lab?.gatewayHealthUrl ?? null,
    gatewayProtocol: hardened.lab?.gatewayProtocol ?? "openai-chat",
    gatewayApiKey: gatewayApiKeyDisabled
      ? null
      : hardened.lab?.gatewayApiKey ?? activeProfile?.gatewayApiKey ?? null,
    gatewayApiKeyDisabled,
    gatewayMaxRetries: parseOptionalInteger(env.LAB_MODEL_GATEWAY_MAX_RETRIES, hardened.lab?.gatewayMaxRetries ?? DEFAULT_GATEWAY_MAX_RETRIES),
    gatewayTimeoutMs: parseOptionalInteger(env.LAB_MODEL_GATEWAY_TIMEOUT_MS, hardened.lab?.gatewayTimeoutMs ?? DEFAULT_GATEWAY_TIMEOUT_MS),
    gatewayIdleTimeoutMs: parseOptionalInteger(env.LAB_MODEL_GATEWAY_IDLE_TIMEOUT_MS, hardened.lab?.gatewayIdleTimeoutMs ?? DEFAULT_GATEWAY_IDLE_TIMEOUT_MS),
    gatewayMaxResponseBytes: parseOptionalInteger(env.LAB_MODEL_GATEWAY_MAX_RESPONSE_BYTES, hardened.lab?.gatewayMaxResponseBytes ?? DEFAULT_GATEWAY_MAX_RESPONSE_BYTES),
    activeGatewayProfile: activeProfile?.id ?? "",
    gatewayProfiles: resolvedProfiles,
    configPath: lab ? labConfigReadPath : explicitLabConfigPath ? labConfigPath : null
  });
  validateLabConfig(finalLab);
  /** @type {Record<string, any>} */
  let configSources = buildConfigSources({
    env,
    project,
    lab,
    bundled,
    profiles: resolvedProfiles,
    environmentConfig: withEnvDefaults,
    finalLab
  });
  configSources.lab.gatewayApiKey = activeGatewayCredentialSource({
    env,
    project,
    lab,
    bundled,
    finalLab
  });
  if (configV2.enabled) {
    configSources = applyConfigV2Sources(configSources, configV2, finalLab, env);
  }

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
    configSources,
    configV2: configV2.enabled ? {
      enabled: true,
      settingsPaths: configV2.settingsPaths,
      revisions: configV2.revisions,
      defaultSelections: configV2.defaultSelections,
      provenance: /** @type {Record<string, any>} */ (configV2.resolved).provenance,
      resolved: configV2.resolved
    } : {
      enabled: false,
      settingsPaths: configV2.settingsPaths,
      revisions: configV2.revisions,
      defaultSelections: configV2.defaultSelections,
      provenance: null,
      resolved: null
    }
  };
}

/**
 * Gateway reliability remains part of the general composition settings UI.
 * V2 provider values supply defaults, while explicit global/project fields
 * continue to override them without reconstructing a provider document.
 *
 * @param {Record<string, any>} config
 * @param {Array<Record<string, any> | null | undefined>} layers
 */
function applyLegacyReliabilityOverrides(config, layers) {
  /** @type {Record<string, any>} */
  const overrides = {};
  for (const layer of layers) {
    const lab = isPlainObject(layer?.lab) ? layer.lab : {};
    for (const field of [
      "gatewayMaxRetries",
      "gatewayTimeoutMs",
      "gatewayIdleTimeoutMs",
      "gatewayMaxResponseBytes"
    ]) {
      if (Object.prototype.hasOwnProperty.call(lab, field)) overrides[field] = lab[field];
    }
  }
  if (Object.keys(overrides).length === 0) return config;
  return {
    ...config,
    lab: { ...(isPlainObject(config.lab) ? config.lab : {}), ...overrides }
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

/** @param {Record<string, any>} config */
function normalizeAllowedHostsConfig(config) {
  if (!Array.isArray(config.allowedHosts)) {
    return config;
  }
  const allowedHosts = [];
  const seen = new Set();
  for (const value of config.allowedHosts) {
    if (typeof value !== "string") {
      allowedHosts.push(value);
      continue;
    }
    const host = value.trim().replace(/\.$/, "").toLowerCase();
    if (host && !seen.has(host)) {
      seen.add(host);
      allowedHosts.push(host);
    }
  }
  return { ...config, allowedHosts };
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
  return projectLegacyConfigPath(cwd);
}

/**
 * User-level model/gateway defaults edited by Dashboard.
 *
 * @param {NodeJS.ProcessEnv} env
 */
export function globalConfigPath(env = process.env) {
  return globalLegacyConfigPath(env);
}

/**
 * Read strict model settings independently from legacy composition files and
 * materialize a one-way V1 runtime projection. Credential values are resolved
 * only into that transient projection; the resolved V2 snapshot remains safe
 * to expose to the Dashboard.
 *
 * @param {{ cwd: string; env: NodeJS.ProcessEnv; readGlobal: boolean }} options
 */
async function loadConfigV2Runtime({ cwd, env, readGlobal }) {
  const settingsPaths = {
    global: globalSettingsPath(env),
    project: projectSettingsPath(cwd),
    credentials: credentialsPath(env)
  };
  const missingGlobal = {
    data: {},
    revision: "missing",
    exists: false,
    path: settingsPaths.global
  };
  const [globalSnapshot, projectSnapshot] = await Promise.all([
    readGlobal
      ? createFileRepository({ filePath: settingsPaths.global }).read()
      : Promise.resolve(missingGlobal),
    createFileRepository({ filePath: settingsPaths.project }).read()
  ]);
  const credentialStore = createCredentialStore({ filePath: settingsPaths.credentials });
  const credentialDescriptor = await credentialStore.describeAll();
  const revisions = {
    global: globalSnapshot.revision,
    project: projectSnapshot.revision,
    credentials: credentialDescriptor.revision
  };
  const enabled = globalSnapshot.exists || projectSnapshot.exists;
  if (!enabled) {
    return {
      enabled: false,
      settingsPaths,
      revisions,
      defaultSelections: { global: null, project: null },
      resolved: null,
      runtimeProjection: {},
      gatewayHosts: []
    };
  }

  const emptyDocument = { settingsVersion: 2, namespaces: {} };
  const resolved = resolveSettingsLayers({
    global: globalSnapshot.exists ? globalSnapshot.data : emptyDocument,
    project: projectSnapshot.exists ? projectSnapshot.data : emptyDocument
  });
  const runtimeProjection = cloneJsonObject(projectLegacyRuntimeConfig(resolved));
  const gatewayHosts = configV2GatewayHosts(resolved);
  const profiles = Array.isArray(runtimeProjection.lab?.gatewayProfiles)
    ? runtimeProjection.lab.gatewayProfiles
    : [];
  await Promise.all(/** @type {any[]} */ (profiles).map(async (profile) => {
    if (profile.gatewayCredentialMode !== "credential" || !profile.gatewayCredentialRef) return;
    const secret = await credentialStore.resolve(profile.gatewayCredentialRef);
    if (secret) profile.gatewayApiKey = secret;
  }));
  const activeProfile = /** @type {any[]} */ (profiles).find((profile) => (
    profile.id === runtimeProjection.lab?.activeGatewayProfile
  ));
  if (activeProfile?.gatewayApiKey) {
    runtimeProjection.lab.gatewayApiKey = activeProfile.gatewayApiKey;
  }
  return {
    enabled: true,
    settingsPaths,
    revisions,
    defaultSelections: {
      global: globalSnapshot.data.namespaces?.["default-model"]?.selection
        ? cloneJsonObject(globalSnapshot.data.namespaces["default-model"].selection)
        : null,
      project: projectSnapshot.data.namespaces?.["default-model"]?.selection
        ? cloneJsonObject(projectSnapshot.data.namespaces["default-model"].selection)
        : null
    },
    resolved,
    runtimeProjection,
    gatewayHosts
  };
}

/** @param {Readonly<Record<string, any>>} resolved */
function configV2GatewayHosts(resolved) {
  /** @type {string[]} */
  const hosts = [];
  for (const provider of Object.values(resolved.namespaces?.["model-providers"]?.providers ?? {})) {
    for (const candidate of [provider?.transport?.baseURL, provider?.transport?.healthURL]) {
      const host = parseHost(String(candidate ?? ""));
      if (host && !hosts.includes(host)) hosts.push(host);
    }
  }
  return hosts;
}

/**
 * Replace legacy owner inference with the provenance produced while resolving
 * raw V2 layers. Effective values are never used to guess write ownership.
 *
 * @param {Record<string, any>} sources
 * @param {Record<string, any>} configV2
 * @param {Record<string, any>} finalLab
 * @param {NodeJS.ProcessEnv} env
 */
function applyConfigV2Sources(sources, configV2, finalLab, env) {
  const provenance = configV2.resolved.provenance ?? {};
  const providerSources = provenance.providers ?? {};
  const existingProfiles = new Map(
    /** @type {any[]} */ (sources.lab?.gatewayProfiles ?? []).map((entry) => [entry.id, entry])
  );
  const gatewayProfiles = /** @type {any[]} */ (finalLab.gatewayProfiles ?? []).map((profile) => {
    const scope = providerSources[profile.id];
    if (!scope) return existingProfiles.get(profile.id) ?? { id: profile.id, type: "environment", label: "模型网关环境变量" };
    const descriptor = configV2SourceDescriptor(scope, configV2.settingsPaths);
    return {
      id: profile.id,
      ...descriptor,
      modelScopes: Object.fromEntries(
        /** @type {any[]} */ (profile.models ?? []).map((model) => [modelEntryId(model), scope])
      )
    };
  });
  if (hasModelGatewayEnvironmentControls(env)) {
    return {
      ...sources,
      lab: { ...sources.lab, gatewayProfiles }
    };
  }
  const activeId = String(finalLab.activeGatewayProfile ?? "").trim();
  const providerScope = providerSources[activeId];
  const selectionScope = provenance.defaultModel;
  const providerSource = providerScope
    ? configV2SourceDescriptor(providerScope, configV2.settingsPaths)
    : sources.models;
  const selectionSource = selectionScope
    ? configV2SourceDescriptor(selectionScope, configV2.settingsPaths)
    : sources.modelAlias;
  return {
    ...sources,
    modelAlias: selectionSource,
    models: providerSource,
    lab: {
      ...sources.lab,
      gatewayUrl: providerSource,
      gatewayHealthUrl: providerSource,
      gatewayProtocol: providerSource,
      gatewayApiKey: providerSource,
      gatewayProfiles
    }
  };
}

/** @param {string} scope @param {Record<string, string>} settingsPaths */
function configV2SourceDescriptor(scope, settingsPaths) {
  if (scope === "global") {
    return { type: "global", label: "全局模型设置", path: settingsPaths.global };
  }
  if (scope === "project") {
    return { type: "project", label: ".lab-agent/settings.json", path: settingsPaths.project };
  }
  if (scope === "environment") {
    return { type: "environment", label: "模型网关环境变量" };
  }
  return { type: "bundled", label: "bundled" };
}

/** @param {NodeJS.ProcessEnv} env */
function hasModelGatewayEnvironmentControls(env) {
  return [
    "LAB_AGENT_MODEL",
    "LAB_AGENT_MODELS",
    "LAB_MODEL_GATEWAY_URL",
    "LAB_MODEL_GATEWAY_HEALTH_URL",
    "LAB_MODEL_GATEWAY_PROTOCOL",
    "LAB_MODEL_GATEWAY_API_KEY"
  ].some((name) => hasNonEmptyEnv(env, name));
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
      configs.push({ path: candidate, data: materializeLayerGatewayProfile(data.data) });
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
  const merged = configs.reduce((current, item) => mergeConfigWithGatewayCredentialScope(current, item.data ?? {}), {});
  return {
    path: configs[configs.length - 1].path,
    paths: configs.map((item) => item.path),
    data: merged
  };
}

/**
 * Convert a layer's legacy top-level gateway snapshot into an owned profile
 * before layers are merged. This keeps older root project configs selectable
 * after the Dashboard writes only a selector to .lab-agent/config.json.
 *
 * @param {Record<string, any>} value
 */
function materializeLayerGatewayProfile(value) {
  const config = cloneJsonObject(value);
  const lab = isPlainObject(config.lab) ? config.lab : {};
  assertUniqueModelEntryIds(config.models, "models");
  if (Array.isArray(lab.gatewayProfiles)) {
    lab.gatewayProfiles = lab.gatewayProfiles.map((/** @type {Record<string, any>} */ profile) => {
      if (!isPlainObject(profile)) return profile;
      const gatewayProtocol = String(profile.gatewayProtocol ?? "openai-chat").trim() || "openai-chat";
      return {
        ...profile,
        gatewayUrl: normalizeGatewayInferenceUrl(profile.gatewayUrl, gatewayProtocol)
      };
    });
    assertUniqueLayerGatewayProfileIds(lab.gatewayProfiles);
  }
  const gatewayProtocol = String(lab.gatewayProtocol ?? "openai-chat").trim() || "openai-chat";
  const gatewayUrl = normalizeGatewayInferenceUrl(lab.gatewayUrl, gatewayProtocol);
  if (gatewayUrl) {
    lab.gatewayUrl = gatewayUrl;
  }
  config.lab = lab;
  if (!gatewayUrl || (Array.isArray(lab.gatewayProfiles) && lab.gatewayProfiles.length === 0)) {
    return config;
  }
  const profiles = Array.isArray(lab.gatewayProfiles) ? lab.gatewayProfiles : [];
  const existingProfile = profiles.find((/** @type {Record<string, any>} */ candidate) => (
    sameGatewayProfileEndpoint(candidate, { gatewayUrl, gatewayProtocol })
  ));
  if (existingProfile) {
    if (!String(lab.activeGatewayProfile ?? "").trim()) {
      lab.activeGatewayProfile = String(existingProfile.id ?? "").trim();
      config.lab = lab;
    }
    return config;
  }
  const profileId = gatewayProfileIdFromParts(gatewayProtocol, gatewayUrl);
  const agents = gatewayProfileAgentSnapshot(config.agents);
  const profile = {
    id: profileId,
    label: parseHost(gatewayUrl) || gatewayUrl,
    gatewayUrl,
    gatewayHealthUrl: String(lab.gatewayHealthUrl ?? "").trim(),
    gatewayProtocol,
    ...(String(lab.gatewayApiKey ?? "").trim() ? { gatewayApiKey: lab.gatewayApiKey } : {}),
    ...(lab.gatewayApiKeyDisabled === true ? { gatewayApiKey: null, gatewayApiKeyDisabled: true } : {}),
    modelAlias: String(config.modelAlias ?? "").trim(),
    models: Array.isArray(config.models) ? cloneJsonObject(config.models) : [],
    routingModels: Array.isArray(config.routingModels) ? cloneJsonObject(config.routingModels) : [],
    ...(agents ? { agents } : {})
  };
  lab.gatewayProfiles = [
    ...profiles.filter((/** @type {Record<string, any>} */ candidate) => (
      String(candidate?.id ?? "").trim() !== profileId
      && !sameGatewayProfileEndpoint(candidate, profile)
    )),
    profile
  ];
  if (!String(lab.activeGatewayProfile ?? "").trim()) {
    lab.activeGatewayProfile = profileId;
  }
  config.lab = lab;
  return config;
}

/** @param {Array<unknown>} profiles */
function assertUniqueLayerGatewayProfileIds(profiles) {
  const byId = new Map();
  for (const profile of profiles) {
    if (!isPlainObject(profile)) continue;
    const id = String(profile.id ?? "").trim();
    if (id) {
      const previous = byId.get(id);
      if (previous) {
        if (!sameGatewayProfileEndpoint(previous, profile)) {
          throw new Error(`Conflicting lab.gatewayProfiles id: ${id} points to multiple endpoints`);
        }
        throw new Error(`Duplicate lab.gatewayProfiles id: ${id}`);
      }
      byId.set(id, profile);
    }
    assertUniqueModelEntryIds(profile.models, `lab.gatewayProfiles[${id || "?"}].models`);
    assertUniqueModelEntryIds(profile.routingModels, `lab.gatewayProfiles[${id || "?"}].routingModels`);
  }
}

/** @param {unknown} value @param {string} keyPath */
function assertUniqueModelEntryIds(value, keyPath) {
  if (!Array.isArray(value)) return;
  const ids = new Set();
  for (const model of value) {
    const id = modelEntryId(model);
    if (id && ids.has(id)) {
      throw new Error(`Duplicate ${keyPath} id: ${id}`);
    }
    if (id) ids.add(id);
  }
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
  const bundled = path.resolve(filePath) === path.resolve(BUNDLED_CONFIG_PATH);
  const templateLike = isExampleConfig(data);
  let ignoredModelGatewayTemplate = templateLike || bundled;
  if (bundled) {
    stripBundledTemplateModelGateway(data);
  } else if (templateLike) {
    stripModelGatewayConfig(data);
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
    const hadModels = config.models.length > 0;
    const nextModels = config.models.filter((model) => !isPlaceholderConfigValue(typeof model === "string" ? model : model?.id));
    if (nextModels.length !== config.models.length) {
      config.models = nextModels;
      stripped = true;
    }
    if (hadModels && nextModels.length === 0) {
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
      if (profiles.length > 0 || config.lab.gatewayProfiles.length === 0) {
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
  delete config.routingModels;
  if (isPlainObject(config.lab)) {
    delete config.lab.gatewayUrl;
    delete config.lab.gatewayHealthUrl;
    delete config.lab.gatewayProtocol;
    delete config.lab.gatewayApiKey;
    delete config.lab.gatewayApiKeyDisabled;
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
function stripBundledTemplateModelGateway(config) {
  stripModelGatewayConfig(config);
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

/**
 * @param {Record<string, any>} base
 * @param {Record<string, any>} overlay
 * @param {{ gatewayProfileIdentity?: "endpoint" | "id" }} [options]
 */
function mergeConfigWithGatewayCredentialScope(base, overlay, options = {}) {
  const next = mergeConfig(base, overlay);
  const overlayLab = isPlainObject(overlay?.lab) ? overlay.lab : {};
  const disablesCredential = overlayLab.gatewayApiKeyDisabled === true;
  const overlayHasCredential = Boolean(String(overlayLab.gatewayApiKey ?? "").trim());
  const changesEndpoint = Object.prototype.hasOwnProperty.call(overlayLab, "gatewayUrl")
    || Object.prototype.hasOwnProperty.call(overlayLab, "gatewayProtocol");
  const endpointChanged = changesEndpoint
    && (!hasGatewayEndpoint(base) || !sameGatewayEndpoint(base, next));
  if (!disablesCredential && (overlayHasCredential || endpointChanged) && isPlainObject(next.lab)) {
    delete next.lab.gatewayApiKeyDisabled;
  }
  if (disablesCredential) {
    next.lab = {
      ...(isPlainObject(next.lab) ? next.lab : {}),
      gatewayApiKey: null,
      gatewayApiKeyDisabled: true
    };
  }
  if (hasGatewayEndpoint(next) && sameGatewayEndpoint(base, next)) {
    if (hasGatewayCredential(base) && !hasGatewayCredential(next) && !disablesCredential) {
      next.lab = {
        ...(isPlainObject(next.lab) ? next.lab : {}),
        gatewayApiKey: base.lab.gatewayApiKey
      };
    }
    if (Array.isArray(base?.models) && Array.isArray(overlay?.models)) {
      next.models = mergeModelEntries(base.models, overlay.models);
    }
  }
  if (Array.isArray(overlayLab.gatewayProfiles)) {
    next.lab = {
      ...(isPlainObject(next.lab) ? next.lab : {}),
      gatewayProfiles: mergeGatewayProfileEntries(
        Array.isArray(base?.lab?.gatewayProfiles) ? base.lab.gatewayProfiles : [],
        overlayLab.gatewayProfiles,
        { identity: options.gatewayProfileIdentity }
      )
    };
  }
  const declaresCredential = Object.prototype.hasOwnProperty.call(overlayLab, "gatewayApiKey") || disablesCredential;
  if (changesEndpoint
    && hasGatewayCredential(base)
    && !declaresCredential
    && (!hasGatewayEndpoint(base) || !sameGatewayEndpoint(base, next))) {
    next.lab = {
      ...(isPlainObject(next.lab) ? next.lab : {}),
      gatewayApiKey: null
    };
  }
  return next;
}

/**
 * A higher layer that explicitly selects a profile owns the selector. Legacy
 * top-level model/gateway fields instead own the effective snapshot and must
 * not be replaced by an inherited selector from a lower layer.
 *
 * @param {Record<string, any>} config
 * @param {Record<string, any>} highestLayer
 */
function shouldApplyActiveGatewayProfile(config, highestLayer) {
  const profileId = String(config?.lab?.activeGatewayProfile ?? "").trim();
  if (!profileId) {
    return false;
  }
  const layerLab = isPlainObject(highestLayer?.lab) ? highestLayer.lab : {};
  if (Object.prototype.hasOwnProperty.call(layerLab, "activeGatewayProfile")) {
    return true;
  }
  const ownsLegacySnapshot = ["modelAlias", "models", "reasoningEffort"]
    .some((key) => Object.prototype.hasOwnProperty.call(highestLayer, key))
    || [
      "gatewayUrl",
      "gatewayHealthUrl",
      "gatewayProtocol",
      "gatewayApiKey",
      "gatewayApiKeyDisabled"
    ].some((key) => Object.prototype.hasOwnProperty.call(layerLab, key));
  return !ownsLegacySnapshot;
}

/**
 * Resolve the selected profile into the effective runtime fields. Stored
 * profile definitions remain the source of truth; a higher layer may switch
 * profiles by writing only lab.activeGatewayProfile.
 *
 * @param {Record<string, any>} config
 * @param {{ strictProfileId?: boolean; projectedAgentRouting?: unknown; projectedAgentRoutingProviderId?: unknown }} [options]
 */
function applyActiveGatewayProfileConfig(config, options = {}) {
  const lab = isPlainObject(config?.lab) ? config.lab : {};
  let profileId = String(lab.activeGatewayProfile ?? "").trim();
  const profiles = Array.isArray(lab.gatewayProfiles) ? lab.gatewayProfiles : [];
  if (!profileId || profiles.length === 0) {
    return config;
  }
  let profile = profiles.find((candidate) => (
    isPlainObject(candidate) && String(candidate.id ?? "").trim() === profileId
  ));
  if (!profile) {
    if (options.strictProfileId === true) {
      throw new Error(`Configured Config V2 provider is unavailable: ${profileId}`);
    }
    profile = profiles.find((candidate) => (
      isPlainObject(candidate)
      && sameGatewayProfileEndpoint(candidate, {
        gatewayUrl: lab.gatewayUrl,
        gatewayProtocol: lab.gatewayProtocol
      })
    ));
    if (!profile) {
      return config;
    }
    profileId = String(profile.id ?? "").trim();
  }

  const models = Array.isArray(profile.models) ? cloneJsonObject(profile.models) : [];
  const routingModels = Array.isArray(profile.routingModels) ? cloneJsonObject(profile.routingModels) : [];
  const modelAlias = String(profile.modelAlias ?? "").trim() || modelEntryId(models[0]);
  const nextLab = /** @type {Record<string, any>} */ ({
    ...lab,
    gatewayUrl: String(profile.gatewayUrl ?? "").trim() || null,
    gatewayHealthUrl: String(profile.gatewayHealthUrl ?? "").trim() || null,
    gatewayProtocol: String(profile.gatewayProtocol ?? "openai-chat").trim() || "openai-chat",
    activeGatewayProfile: profileId,
    gatewayProfiles: profiles
  });
  if (profile.gatewayApiKeyDisabled === true) {
    nextLab.gatewayApiKey = null;
    nextLab.gatewayApiKeyDisabled = true;
  } else if (String(profile.gatewayApiKey ?? "").trim()) {
    nextLab.gatewayApiKey = profile.gatewayApiKey;
    delete nextLab.gatewayApiKeyDisabled;
  } else {
    nextLab.gatewayApiKey = null;
    delete nextLab.gatewayApiKeyDisabled;
  }

  const endpointChanged = !sameGatewayProfileEndpoint({
    gatewayUrl: lab.gatewayUrl,
    gatewayProtocol: lab.gatewayProtocol
  }, profile);
  const useProjectedRouting = String(options.projectedAgentRoutingProviderId ?? "").trim() === profileId;
  const agents = useProjectedRouting
    ? replaceRuntimeAgentRouting(
        config.agents,
        mergeRuntimeAgentRouting(profile.agents, options.projectedAgentRouting)
      )
    : applyGatewayProfileAgentSelection(config.agents, profile.agents, endpointChanged);
  const gatewayHosts = [
    parseHost(String(nextLab.gatewayUrl ?? "")),
    parseHost(String(nextLab.gatewayHealthUrl ?? ""))
  ].filter(Boolean);
  return {
    ...config,
    modelAlias,
    models,
    routingModels,
    allowedHosts: Array.from(new Set([...(Array.isArray(config.allowedHosts) ? config.allowedHosts : []), ...gatewayHosts])),
    agents,
    lab: nextLab
  };
}

/** @param {unknown} current @param {unknown} selected @param {boolean} endpointChanged */
function applyGatewayProfileAgentSelection(current, selected, endpointChanged) {
  const agents = isPlainObject(current) ? cloneJsonObject(current) : {};
  if (isPlainObject(selected)) {
    if (isPlainObject(selected.modelTiers)) {
      agents.modelTiers = cloneJsonObject(selected.modelTiers);
    } else if (endpointChanged) {
      delete agents.modelTiers;
    }
    if (isPlainObject(selected.vision)) {
      agents.vision = cloneJsonObject(selected.vision);
    } else if (endpointChanged) {
      agents.vision = {
        ...(isPlainObject(agents.vision) ? agents.vision : {}),
        enabled: false,
        model: null
      };
    }
    return agents;
  }
  if (endpointChanged) {
    delete agents.modelTiers;
    agents.vision = {
      ...(isPlainObject(agents.vision) ? agents.vision : {}),
      enabled: false,
      model: null
    };
  }
  return agents;
}

/** @param {unknown} value */
function gatewayProfileAgentSnapshot(value) {
  if (!isPlainObject(value)) {
    return null;
  }
  const agents = {};
  if (isPlainObject(value.modelTiers)) {
    agents.modelTiers = cloneJsonObject(value.modelTiers);
  }
  if (isPlainObject(value.vision)) {
    agents.vision = cloneJsonObject(value.vision);
  }
  return Object.keys(agents).length > 0 ? agents : null;
}

/**
 * @param {Array<Record<string, any>>} base
 * @param {Array<Record<string, any>>} overlay
 * @param {{ identity?: "endpoint" | "id" }} [options]
 */
function mergeGatewayProfileEntries(base, overlay, options = {}) {
  if (overlay.length === 0) {
    return [];
  }
  const merged = base.map((profile) => cloneJsonObject(profile));
  for (const rawProfile of overlay) {
    if (!isPlainObject(rawProfile)) {
      continue;
    }
    const profile = cloneJsonObject(rawProfile);
    const id = String(profile.id ?? "").trim();
    const inherited = options.identity === "id"
      ? merged.find((candidate) => id && String(candidate.id ?? "").trim() === id)
      : merged.find((candidate) => sameGatewayProfileEndpoint(candidate, profile));
    if (profile.gatewayApiKeyDisabled === true) {
      profile.gatewayApiKey = null;
    } else if (inherited
      && !String(profile.gatewayApiKey ?? "").trim()
      && String(inherited.gatewayApiKey ?? "").trim()) {
      profile.gatewayApiKey = inherited.gatewayApiKey;
    }
    if (inherited && Array.isArray(inherited.models) && Array.isArray(profile.models)) {
      profile.models = mergeModelEntries(inherited.models, profile.models);
    }
    if (inherited && Array.isArray(inherited.routingModels) && Array.isArray(profile.routingModels)) {
      profile.routingModels = mergeModelEntries(inherited.routingModels, profile.routingModels);
    }
    const retained = merged.filter((candidate) => (
      (options.identity === "id" || !sameGatewayProfileEndpoint(candidate, profile))
      && (!id || String(candidate.id ?? "").trim() !== id)
    ));
    retained.push(profile);
    merged.splice(0, merged.length, ...retained);
  }
  return merged;
}

/**
 * @param {Array<string | Record<string, any>>} base
 * @param {Array<string | Record<string, any>>} overlay
 * @returns {Array<string | Record<string, any>>}
 */
function mergeModelEntries(base, overlay) {
  const merged = [...base];
  /** @type {Map<string, number>} */
  const indexes = new Map();
  for (let index = 0; index < merged.length; index += 1) {
    const id = modelEntryId(merged[index]);
    if (id) {
      indexes.set(id, index);
    }
  }
  for (const model of overlay) {
    const id = modelEntryId(model);
    const index = id ? indexes.get(id) : undefined;
    if (index === undefined) {
      if (id) {
        indexes.set(id, merged.length);
      }
      merged.push(model);
    } else {
      merged[index] = model;
    }
  }
  return merged;
}

/** @param {unknown} model */
function modelEntryId(model) {
  return String(typeof model === "string"
    ? model
    : model && typeof model === "object" && "id" in model
      ? model.id
      : "").trim();
}

/** @param {Record<string, any>} left @param {Record<string, any>} right */
function sameGatewayProfileEndpoint(left, right) {
  if (!String(left?.gatewayUrl ?? "").trim() || !String(right?.gatewayUrl ?? "").trim()) {
    return false;
  }
  return sameGatewayEndpoint(
    { lab: { gatewayUrl: left?.gatewayUrl, gatewayProtocol: left?.gatewayProtocol } },
    { lab: { gatewayUrl: right?.gatewayUrl, gatewayProtocol: right?.gatewayProtocol } }
  );
}

/** @param {Record<string, any>} config */
function hasGatewayEndpoint(config) {
  return Boolean(String(config?.lab?.gatewayUrl ?? "").trim());
}

/** @param {Record<string, any>} config */
function hasGatewayCredential(config) {
  return Boolean(String(config?.lab?.gatewayApiKey ?? "").trim());
}

/** @param {Record<string, any>} left @param {Record<string, any>} right */
function sameGatewayEndpoint(left, right) {
  const leftProtocol = String(left?.lab?.gatewayProtocol ?? "openai-chat").trim();
  const rightProtocol = String(right?.lab?.gatewayProtocol ?? "openai-chat").trim();
  return canonicalGatewayEndpointUrl(left?.lab?.gatewayUrl, leftProtocol)
      === canonicalGatewayEndpointUrl(right?.lab?.gatewayUrl, rightProtocol)
    && leftProtocol === rightProtocol;
}

/** @param {unknown} value @param {string} [protocol] */
function canonicalGatewayEndpointUrl(value, protocol = "") {
  const text = protocol ? normalizeGatewayInferenceUrl(value, protocol) : String(value ?? "").trim();
  if (!text) {
    return "";
  }
  try {
    const url = new URL(text);
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    url.hash = "";
    return url.href;
  } catch {
    return text.replace(/\/+$/, "");
  }
}

/** @param {unknown} value @param {string} protocol */
function normalizeGatewayInferenceUrl(value, protocol) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  try {
    const url = new URL(text);
    const path = url.pathname.replace(/\/+$/, "");
    const suffix = protocol === "openai-responses"
      ? "/responses"
      : protocol === "openai-chat"
        ? "/chat/completions"
        : protocol === "anthropic-messages" ? "/messages" : "";
    const knownRoute = /\/(models|responses|messages|chat\/completions)$/i;
    const knownBase = path === "" || /^\/$/.test(path) || /\/v\d+(?:beta\d*)?$/i.test(path);
    if (suffix && !path.endsWith(suffix) && (knownRoute.test(path) || knownBase)) {
      url.pathname = knownRoute.test(path)
        ? path.replace(knownRoute, suffix)
        : `${path}${suffix}`;
    } else {
      url.pathname = path || "/";
    }
    url.hash = "";
    return url.href;
  } catch {
    return text;
  }
}

/**
 * @param {{
 *   env: NodeJS.ProcessEnv;
 *   project: any;
 *   lab: any;
 *   bundled: any;
 *   profiles?: Array<Record<string, any>>;
 *   environmentConfig?: Record<string, any>;
 *   finalLab?: Record<string, any>;
 * }} options
 */
function buildConfigSources({ env, project, lab, bundled, profiles = [], environmentConfig = {}, finalLab = {} }) {
  const source = {
    modelAlias: configSourceFor("modelAlias", { env, project, lab, bundled }),
    models: configSourceFor("models", { env, project, lab, bundled }),
    lab: {
      gatewayUrl: configSourceFor("lab.gatewayUrl", { env, project, lab, bundled }),
      gatewayHealthUrl: configSourceFor("lab.gatewayHealthUrl", { env, project, lab, bundled }),
      gatewayProtocol: configSourceFor("lab.gatewayProtocol", { env, project, lab, bundled }),
      gatewayApiKey: configSourceFor("lab.gatewayApiKey", { env, project, lab, bundled }),
      gatewayProfiles: gatewayProfileSources({
        profiles,
        env,
        project,
        lab,
        bundled,
        environmentConfig,
        finalLab
      })
    }
  };
  return source;
}

/**
 * Resolve profile ownership from the original configuration layers. Profile
 * contents in the merged config cannot identify whether an inherited entry is
 * owned by the project or the user-global file.
 *
 * @param {{
 *   profiles: Array<Record<string, any>>;
 *   env: NodeJS.ProcessEnv;
 *   project: any;
 *   lab: any;
 *   bundled: any;
 *   environmentConfig: Record<string, any>;
 *   finalLab: Record<string, any>;
 * }} options
 */
function gatewayProfileSources({ profiles, env, project, lab, bundled, environmentConfig, finalLab }) {
  const environmentControlsProfile = hasNonEmptyEnv(env, "LAB_AGENT_MODEL")
    || hasNonEmptyEnv(env, "LAB_AGENT_MODELS")
    || hasNonEmptyEnv(env, "LAB_MODEL_GATEWAY_URL")
    || hasNonEmptyEnv(env, "LAB_MODEL_GATEWAY_HEALTH_URL")
    || hasNonEmptyEnv(env, "LAB_MODEL_GATEWAY_PROTOCOL")
    || hasNonEmptyEnv(env, "LAB_MODEL_GATEWAY_API_KEY");
  const environmentProfileId = environmentControlsProfile
    ? String(environmentConfig?.lab?.activeGatewayProfile ?? "").trim()
    : "";
  const environmentProfile = environmentProfileId
    ? (Array.isArray(environmentConfig?.lab?.gatewayProfiles)
      ? environmentConfig.lab.gatewayProfiles.find((/** @type {Record<string, any>} */ profile) => (
          String(profile?.id ?? "").trim() === environmentProfileId
        ))
      : null)
    : null;

  return profiles.map((profile) => {
    const id = String(profile?.id ?? "").trim();
    const active = Boolean(id) && id === String(finalLab?.activeGatewayProfile ?? "").trim();
    const modelScopes = gatewayProfileModelScopes({
      profile,
      active,
      project: project?.data,
      environmentProfile,
      global: lab?.data,
      bundled: bundled?.data
    });
    let owner;
    if (layerOwnsGatewayProfile(project?.data, profile, active)) {
      owner = { id, type: "project", label: ".lab-agent/config.json", path: project?.path ?? null };
    } else if (environmentProfile && sameGatewayProfileIdentity(environmentProfile, profile)) {
      owner = { id, type: "environment", label: "模型网关环境变量" };
    } else if (layerOwnsGatewayProfile(lab?.data, profile, active)) {
      owner = { id, type: "global", label: lab?.label ?? "全局配置", path: lab?.path ?? null };
    } else if (layerOwnsGatewayProfile(bundled?.data, profile, active)) {
      owner = { id, type: "bundled", label: "bundled", path: BUNDLED_CONFIG_PATH };
    } else {
      owner = { id, type: "default", label: "default" };
    }
    return { ...owner, modelScopes };
  });
}

/**
 * @param {{ profile: Record<string, any>; active: boolean; project?: Record<string, any>; environmentProfile?: Record<string, any> | null; global?: Record<string, any>; bundled?: Record<string, any> }} input
 */
function gatewayProfileModelScopes({ profile, active, project, environmentProfile, global, bundled }) {
  const scopes = /** @type {Record<string, string>} */ ({});
  const models = Array.isArray(profile.models) ? profile.models : [];
  for (const model of models) {
    const modelId = modelEntryId(model);
    if (!modelId) continue;
    if (layerOwnsGatewayProfileModel(project, profile, modelId, active)) {
      scopes[modelId] = "project";
    } else if (environmentProfile
      && sameGatewayProfileIdentity(environmentProfile, profile)
      && Array.isArray(environmentProfile.models)
      && environmentProfile.models.some((entry) => modelEntryId(entry) === modelId)) {
      scopes[modelId] = "environment";
    } else if (layerOwnsGatewayProfileModel(global, profile, modelId, active)) {
      scopes[modelId] = "global";
    } else if (layerOwnsGatewayProfileModel(bundled, profile, modelId, active)) {
      scopes[modelId] = "bundled";
    } else {
      scopes[modelId] = "default";
    }
  }
  return scopes;
}

/** @param {Record<string, any> | null | undefined} layer @param {Record<string, any>} profile @param {string} modelId @param {boolean} active */
function layerOwnsGatewayProfileModel(layer, profile, modelId, active) {
  const layerLab = isPlainObject(layer?.lab) ? layer.lab : {};
  const declaredProfiles = Array.isArray(layerLab.gatewayProfiles) ? layerLab.gatewayProfiles : [];
  if (declaredProfiles.some((candidate) => (
    isPlainObject(candidate)
    && sameGatewayProfileIdentity(candidate, profile)
    && Array.isArray(candidate.models)
    && candidate.models.some((entry) => modelEntryId(entry) === modelId)
  ))) {
    return true;
  }
  return active
    && sameGatewayEndpoint(layer ?? {}, { lab: profile })
    && Array.isArray(layer?.models)
    && layer.models.some((entry) => modelEntryId(entry) === modelId);
}

/** @param {Record<string, any> | null | undefined} layer @param {Record<string, any>} profile @param {boolean} active */
function layerOwnsGatewayProfile(layer, profile, active) {
  const layerLab = isPlainObject(layer?.lab) ? layer.lab : {};
  const declaredProfiles = Array.isArray(layerLab.gatewayProfiles) ? layerLab.gatewayProfiles : [];
  if (declaredProfiles.some((candidate) => isPlainObject(candidate) && sameGatewayProfileIdentity(candidate, profile))) {
    return true;
  }
  const declaresTopLevelEndpoint = Object.prototype.hasOwnProperty.call(layerLab, "gatewayUrl")
    || Object.prototype.hasOwnProperty.call(layerLab, "gatewayProtocol");
  if (!active || !declaresTopLevelEndpoint) {
    return false;
  }
  if (Object.prototype.hasOwnProperty.call(layerLab, "gatewayUrl")
    && canonicalGatewayEndpointUrl(layerLab.gatewayUrl) !== canonicalGatewayEndpointUrl(profile?.gatewayUrl)) {
    return false;
  }
  if (Object.prototype.hasOwnProperty.call(layerLab, "gatewayProtocol")
    && String(layerLab.gatewayProtocol ?? "openai-chat").trim()
      !== String(profile?.gatewayProtocol ?? "openai-chat").trim()) {
    return false;
  }
  return true;
}

/** @param {Record<string, any>} left @param {Record<string, any>} right */
function sameGatewayProfileIdentity(left, right) {
  const leftId = String(left?.id ?? "").trim();
  const rightId = String(right?.id ?? "").trim();
  return Boolean(leftId && rightId && leftId === rightId) || sameGatewayProfileEndpoint(left, right);
}

/** @param {{ env: NodeJS.ProcessEnv; project: any; lab: any; bundled: any; finalLab: Record<string, any> }} options */
function activeGatewayCredentialSource({ env, project, lab, bundled, finalLab }) {
  const active = { lab: finalLab };
  const projectCredential = explicitLayerGatewayCredential(project?.data, active);
  if (projectCredential) {
    return { type: "project", label: ".lab-agent/config.json", path: project?.path ?? null };
  }
  const projectLab = isPlainObject(project?.data?.lab) ? project.data.lab : {};
  const projectSelectsActiveEndpoint = (
    Object.prototype.hasOwnProperty.call(projectLab, "gatewayUrl")
    || Object.prototype.hasOwnProperty.call(projectLab, "gatewayProtocol")
  ) && sameGatewayEndpoint(project.data, active);
  if (!String(finalLab?.gatewayApiKey ?? "").trim() && projectSelectsActiveEndpoint) {
    return { type: "project", label: ".lab-agent/config.json", path: project?.path ?? null };
  }
  const environmentEndpoint = hasNonEmptyEnv(env, "LAB_MODEL_GATEWAY_URL")
    ? { lab: { gatewayUrl: env.LAB_MODEL_GATEWAY_URL, gatewayProtocol: env.LAB_MODEL_GATEWAY_PROTOCOL ?? "openai-chat" } }
    : null;
  if (hasNonEmptyEnv(env, "LAB_MODEL_GATEWAY_API_KEY")
    && (!environmentEndpoint || sameGatewayEndpoint(environmentEndpoint, active))
    && String(finalLab?.gatewayApiKey ?? "") === String(env.LAB_MODEL_GATEWAY_API_KEY)) {
    return { type: "environment", label: "LAB_MODEL_GATEWAY_API_KEY", env: "LAB_MODEL_GATEWAY_API_KEY" };
  }
  if (explicitLayerGatewayCredential(lab?.data, active)) {
    return { type: "global", label: lab?.label ?? "全局配置", path: lab?.path ?? null };
  }
  if (explicitLayerGatewayCredential(bundled?.data, active)) {
    return { type: "bundled", label: "bundled", path: BUNDLED_CONFIG_PATH };
  }
  return { type: "default", label: "default" };
}

/** @param {Record<string, any> | null | undefined} config @param {Record<string, any>} active */
function explicitLayerGatewayCredential(config, active) {
  if (!isPlainObject(config?.lab)) {
    return false;
  }
  const lab = config.lab;
  const topHasEndpoint = Boolean(String(lab.gatewayUrl ?? "").trim());
  const topMatches = !topHasEndpoint || sameGatewayEndpoint(config, active);
  if (topMatches && (lab.gatewayApiKeyDisabled === true || Boolean(String(lab.gatewayApiKey ?? "").trim()))) {
    return true;
  }
  const profiles = Array.isArray(lab.gatewayProfiles) ? lab.gatewayProfiles : [];
  return profiles.some((profile) => (
    isPlainObject(profile)
    && sameGatewayProfileEndpoint(profile, active.lab)
    && (profile.gatewayApiKeyDisabled === true || Boolean(String(profile.gatewayApiKey ?? "").trim()))
  ));
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
      label: lab?.label ?? "全局配置",
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
 * @param {{ preserveConfiguredModels?: boolean; gatewayProfileIdentity?: "endpoint" | "id" }} [options]
 */
function applyEnvDefaultConfig(value, env, options = {}) {
  const next = { ...value };
  const previousModelAlias = String(value.modelAlias ?? "").trim();
  const previousGateway = { lab: { ...(isPlainObject(value.lab) ? value.lab : {}) } };
  const envControlsModel = hasNonEmptyEnv(env, "LAB_AGENT_MODEL") || hasNonEmptyEnv(env, "LAB_AGENT_MODELS");
  const envControlsGateway = hasNonEmptyEnv(env, "LAB_MODEL_GATEWAY_URL")
    || hasNonEmptyEnv(env, "LAB_MODEL_GATEWAY_HEALTH_URL")
    || hasNonEmptyEnv(env, "LAB_MODEL_GATEWAY_PROTOCOL")
    || hasNonEmptyEnv(env, "LAB_MODEL_GATEWAY_API_KEY");

  if (env.LAB_AGENT_MODEL) {
    next.modelAlias = env.LAB_AGENT_MODEL;
    if (String(env.LAB_AGENT_MODEL).trim() !== previousModelAlias) {
      next.reasoningEffort = null;
    }
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
  if (lab.gatewayUrl) {
    lab.gatewayUrl = normalizeGatewayInferenceUrl(
      lab.gatewayUrl,
      String(lab.gatewayProtocol ?? "openai-chat").trim() || "openai-chat"
    );
  }
  const environmentGatewayChanged = envControlsGateway
    && !sameGatewayEndpoint(previousGateway, { lab });
  if (env.LAB_MODEL_GATEWAY_API_KEY) {
    lab.gatewayApiKey = env.LAB_MODEL_GATEWAY_API_KEY;
    delete lab.gatewayApiKeyDisabled;
  } else if ((env.LAB_MODEL_GATEWAY_URL || env.LAB_MODEL_GATEWAY_PROTOCOL)
    && !sameGatewayEndpoint(previousGateway, { lab })) {
    lab.gatewayApiKey = null;
    delete lab.gatewayApiKeyDisabled;
  }
  if (environmentGatewayChanged) {
    next.routingModels = [];
    next.agents = replaceRuntimeAgentRouting(next.agents, null);
  }
  if (envControlsModel || envControlsGateway) {
    const environmentProfile = envGatewayProfile({
      modelAlias: next.modelAlias,
      models: next.models,
      routingModels: next.routingModels,
      lab,
      agents: next.agents
    });
    const environmentProfiles = /** @type {Array<Record<string, any>>} */ (
      environmentProfile ? [environmentProfile] : []
    );
    if (environmentProfiles.length > 0) {
      lab.gatewayProfiles = mergeGatewayProfileEntries(
        Array.isArray(lab.gatewayProfiles) ? lab.gatewayProfiles : [],
        environmentProfiles,
        { identity: options.gatewayProfileIdentity }
      );
    }
    lab.activeGatewayProfile = environmentProfiles[0]?.id ?? "";
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
  const gatewayProtocol = String(config.lab?.gatewayProtocol ?? "openai-chat").trim() || "openai-chat";
  const gatewayUrl = normalizeGatewayInferenceUrl(config.lab?.gatewayUrl, gatewayProtocol);
  if (!gatewayUrl) {
    return null;
  }
  return {
    id: gatewayProfileIdFromParts(gatewayProtocol, gatewayUrl),
    label: parseHost(gatewayUrl) || gatewayUrl,
    gatewayUrl,
    gatewayHealthUrl: String(config.lab?.gatewayHealthUrl ?? "").trim(),
    gatewayProtocol,
    ...(config.lab?.gatewayApiKey ? { gatewayApiKey: config.lab.gatewayApiKey } : {}),
    modelAlias: String(config.modelAlias ?? "").trim(),
    models: Array.isArray(config.models) ? config.models : [],
    routingModels: Array.isArray(config.routingModels) ? config.routingModels : [],
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
  const normalizedProtocol = String(protocol ?? "openai-chat").trim();
  const normalizedUrl = canonicalGatewayEndpointUrl(gatewayUrl, normalizedProtocol);
  const raw = `${normalizedProtocol}|${normalizedUrl}`;
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
    const retentionValue = String(env.LAB_AGENT_TRANSCRIPT_RETENTION_DAYS).trim().toLowerCase();
    next.transcript = {
      ...(next.transcript ?? {}),
      retentionDays: ["forever", "permanent", "unlimited"].includes(retentionValue)
        ? null
        : Number.parseInt(retentionValue, 10)
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

  if (!NETWORK_MODES.includes(config.networkMode)) {
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

  if (typeof config.transcript?.enabled !== "boolean") {
    throw new Error("Unsupported transcript.enabled: expected boolean");
  }

  const encryption = config.transcript?.encryption ?? "off";
  if (!["off", "optional", "required"].includes(encryption)) {
    throw new Error(`Unsupported transcript.encryption: ${encryption}`);
  }

  const retentionDays = config.transcript?.retentionDays === undefined
    ? 30
    : config.transcript.retentionDays;
  if (retentionDays !== null && (!Number.isInteger(retentionDays) || retentionDays < 0 || retentionDays > 3650)) {
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
  assertUniqueModelEntryIds(config.models, "models");
  if (config.routingModels !== undefined && !Array.isArray(config.routingModels)) {
    throw new Error("Unsupported routingModels: expected an array");
  }
  assertUniqueModelEntryIds(config.routingModels, "routingModels");
  validateProfileModels(config.routingModels ?? []);
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
    if (
      config.agents.maxRounds !== undefined
      && config.agents.maxRounds !== null
      && (!Number.isInteger(config.agents.maxRounds) || config.agents.maxRounds <= 0)
    ) {
      throw new Error(`Unsupported agents.maxRounds: ${config.agents.maxRounds}`);
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
    if (profile.gatewayProtocol !== undefined && !GATEWAY_PROTOCOLS.includes(profile.gatewayProtocol)) {
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
    if (model.reasoningEfforts !== undefined && model.reasoningEfforts !== null && !Array.isArray(model.reasoningEfforts)) {
      throw new Error("Unsupported lab.gatewayProfiles entry models item reasoningEfforts: expected array");
    }
    if (model.defaultReasoningEffort !== undefined && model.defaultReasoningEffort !== null && typeof model.defaultReasoningEffort !== "string") {
      throw new Error("Unsupported lab.gatewayProfiles entry models item defaultReasoningEffort: expected string");
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

/** @param {Record<string, any>} value */
function validateGoalConfig(value) {
  if (!isPlainObject(value)) {
    throw new Error("Unsupported agents.goal: expected an object");
  }
  if (
    value.maxAutoContinues !== undefined
    && (
      !Number.isInteger(value.maxAutoContinues)
      || value.maxAutoContinues < GOAL_MIN_AUTO_CONTINUES
      || value.maxAutoContinues > GOAL_ABS_MAX_AUTO_CONTINUES
    )
  ) {
    throw new Error(`Unsupported agents.goal.maxAutoContinues: ${value.maxAutoContinues}`);
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
 * @param {{ gatewayProtocol?: string; gatewayApiKey?: string | null; gatewayApiKeyDisabled?: boolean; gatewayMaxRetries?: number; gatewayTimeoutMs?: number; gatewayIdleTimeoutMs?: number; gatewayMaxResponseBytes?: number }} lab
 */
function validateLabConfig(lab) {
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
function parseHostList(value) {
  if (!value) {
    return [];
  }
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

/** @param {unknown} value */
function validAllowedHost(value) {
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
