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
import {
  DEFAULT_CONFIG,
  BUNDLED_CONFIG_PATH,
  EMPTY_JSON,
  EMPTY_NAMESPACES,
  EMPTY_STRING_MAP,
  PROJECT_CONFIG_FILES,
  DEFAULT_GATEWAY_MAX_RETRIES,
  DEFAULT_GATEWAY_TIMEOUT_MS,
  DEFAULT_GATEWAY_IDLE_TIMEOUT_MS,
  NETWORK_MODES,
  GATEWAY_PROTOCOLS,
  type LabAgentConfig,
  type JsonObject,
  type ConfigSources,
  type ConfigLayerSnapshot
} from "./defaults.ts";
import {
  mergeConfig,
  mergeConfigWithGatewayCredentialScope,
  applyEnvDefaultConfig,
  applyRuntimeEnvConfig,
  applySensitivityPolicy,
  hasNonEmptyEnv,
  shouldApplyActiveGatewayProfile,
  applyActiveGatewayProfileConfig,
  sameGatewayEndpoint,
  gatewayProfileAgentSnapshot,
  gatewayProfileIdFromParts,
  buildConfigSources,
  activeGatewayCredentialSource,
  modelEntryId,
  normalizeGatewayInferenceUrl,
  sameGatewayProfileEndpoint,
  hasConfigPath
} from "./merge.ts";
import {
  validateConfig,
  isPlainObject,
  cloneJsonObject,
  parseHost,
  parseOptionalInteger,
  integerOr,
  validateLabConfig,
  parseHostList,
  parseBoolean,
  parseOptionalPositiveInteger
} from "./validate.ts";

export async function loadConfig(options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<LabAgentConfig> {
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

  const withBundled = mergeConfig(DEFAULT_CONFIG, bundled?.data ?? EMPTY_JSON);
  const withGlobalDefaults = mergeConfigWithGatewayCredentialScope(withBundled, lab?.data ?? EMPTY_JSON);
  const withLegacyEnvDefaults = configV2.enabled
    ? withGlobalDefaults
    : applyEnvDefaultConfig(withGlobalDefaults, env, {
        preserveConfiguredModels: Boolean(bundled && !lab)
      });
  const projectData: JsonObject = configV2.enabled
    ? stripLegacyModelFields(project?.data ?? EMPTY_JSON)
    : project?.data ?? EMPTY_JSON;
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
        projectedAgentRouting: configV2.enabled && isPlainObject(configV2.runtimeProjection) ? configV2.runtimeProjection.agents : undefined,
        projectedAgentRoutingProviderId: configV2.enabled && isPlainObject(configV2.runtimeProjection) && isPlainObject(configV2.runtimeProjection.lab)
          ? configV2.runtimeProjection.lab.activeGatewayProfile
          : undefined
      })
    : withEnvDefaults;
  const withEnv = applyRuntimeEnvConfig(withSelectedProfile, env);
  const normalized = normalizeAllowedHostsConfig(normalizeContextConfig(withEnv, env));
  const hardened = applySensitivityPolicy(normalized);
  validateConfig(hardened);
  const hardenedLab: JsonObject = isPlainObject(hardened.lab) ? hardened.lab : EMPTY_JSON;
  let resolvedProfiles = Array.isArray(hardenedLab.gatewayProfiles)
    ? hardenedLab.gatewayProfiles.map((profile: unknown) => cloneJsonObject(isPlainObject(profile) ? profile : EMPTY_JSON))
    : [];
  const projectLab = isPlainObject(projectData.lab) ? projectData.lab : null;
  const projectGatewayProfiles = projectLab && Array.isArray(projectLab.gatewayProfiles)
    ? projectLab.gatewayProfiles
    : null;
  const projectClearsGatewayProfiles = Array.isArray(projectGatewayProfiles) && projectGatewayProfiles.length === 0;
  const activeEndpoint = { lab: hardenedLab };
  const configuredActiveId = String(hardenedLab.activeGatewayProfile ?? "").trim();
  let activeProfile = configV2.enabled
    ? resolvedProfiles.find((profile) => String(profile?.id ?? "") === configuredActiveId) ?? null
    : resolvedProfiles.find((profile) => (
        String(profile?.id ?? "") === configuredActiveId
        && sameGatewayEndpoint({ lab: profile }, activeEndpoint)
      )) ?? resolvedProfiles.find((profile) => sameGatewayEndpoint({ lab: profile }, activeEndpoint)) ?? null;
  if (configV2.enabled && configuredActiveId && !activeProfile) {
    throw new Error(`Configured Config V2 provider is unavailable: ${configuredActiveId}`);
  }
  const activeGatewayUrl = String(hardenedLab.gatewayUrl ?? "").trim();
  if (activeGatewayUrl && !projectClearsGatewayProfiles) {
    const gatewayProtocol = String(hardenedLab.gatewayProtocol ?? "openai-chat").trim();
    const profileAgents = gatewayProfileAgentSnapshot(hardened.agents);
    const synthesizedActiveProfile = {
      id: activeProfile?.id ?? gatewayProfileIdFromParts(gatewayProtocol, activeGatewayUrl),
      label: String(activeProfile?.label ?? "").trim() || parseHost(activeGatewayUrl) || activeGatewayUrl,
      gatewayUrl: activeGatewayUrl,
      gatewayHealthUrl: String(hardenedLab.gatewayHealthUrl ?? "").trim(),
      gatewayProtocol,
      ...(String(hardenedLab.gatewayApiKey ?? "").trim() ? { gatewayApiKey: hardenedLab.gatewayApiKey } : EMPTY_JSON),
      ...(hardenedLab.gatewayApiKeyDisabled === true ? { gatewayApiKeyDisabled: true } : EMPTY_JSON),
      modelAlias: String(hardened.modelAlias ?? "").trim(),
      models: Array.isArray(hardened.models) ? cloneJsonObject(hardened.models) : [],
      routingModels: Array.isArray(hardened.routingModels) ? cloneJsonObject(hardened.routingModels) : [],
      ...(profileAgents ? { agents: profileAgents } : EMPTY_JSON)
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
  const gatewayApiKeyDisabled = hardenedLab.gatewayApiKeyDisabled === true
    || (!String(hardenedLab.gatewayApiKey ?? "").trim() && activeProfile?.gatewayApiKeyDisabled === true);
  const finalLab = {
    gatewayUrl: typeof hardenedLab.gatewayUrl === "string" ? hardenedLab.gatewayUrl : null,
    gatewayHealthUrl: typeof hardenedLab.gatewayHealthUrl === "string" ? hardenedLab.gatewayHealthUrl : null,
    gatewayProtocol: typeof hardenedLab.gatewayProtocol === "string" ? hardenedLab.gatewayProtocol : "openai-chat",
    gatewayApiKey: gatewayApiKeyDisabled
      ? null
      : typeof hardenedLab.gatewayApiKey === "string"
        ? hardenedLab.gatewayApiKey
        : typeof activeProfile?.gatewayApiKey === "string" ? activeProfile.gatewayApiKey : null,
    gatewayApiKeyDisabled,
    gatewayMaxRetries: parseOptionalInteger(env.LAB_MODEL_GATEWAY_MAX_RETRIES, integerOr(hardenedLab.gatewayMaxRetries, DEFAULT_GATEWAY_MAX_RETRIES)),
    gatewayTimeoutMs: parseOptionalInteger(env.LAB_MODEL_GATEWAY_TIMEOUT_MS, integerOr(hardenedLab.gatewayTimeoutMs, DEFAULT_GATEWAY_TIMEOUT_MS)),
    gatewayIdleTimeoutMs: parseOptionalInteger(env.LAB_MODEL_GATEWAY_IDLE_TIMEOUT_MS, integerOr(hardenedLab.gatewayIdleTimeoutMs, DEFAULT_GATEWAY_IDLE_TIMEOUT_MS)),
    gatewayMaxResponseBytes: parseOptionalInteger(env.LAB_MODEL_GATEWAY_MAX_RESPONSE_BYTES, integerOr(hardenedLab.gatewayMaxResponseBytes, DEFAULT_GATEWAY_MAX_RESPONSE_BYTES)),
    activeGatewayProfile: activeProfile?.id ?? "",
    gatewayProfiles: resolvedProfiles,
    configPath: lab ? labConfigReadPath : explicitLabConfigPath ? labConfigPath : null
  };
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

  const labWithSources = {
    ...finalLab,
    sources: configSources.lab
  } as LabAgentConfig["lab"];
  const configV2State = (configV2.enabled
    ? {
      enabled: true,
      settingsPaths: configV2.settingsPaths,
      revisions: configV2.revisions,
      defaultSelections: configV2.defaultSelections,
      provenance: isPlainObject(configV2.resolved) && isPlainObject(configV2.resolved.provenance)
        ? configV2.resolved.provenance
        : undefined,
      resolved: configV2.resolved
    }
    : {
      enabled: false,
      settingsPaths: configV2.settingsPaths,
      revisions: configV2.revisions,
      defaultSelections: configV2.defaultSelections,
      provenance: undefined,
      resolved: null
    }) as LabAgentConfig["configV2"];
  return {
    ...hardened,
    lab: labWithSources,
    defaultModelAlias: typeof hardened.modelAlias === "string" ? hardened.modelAlias : "",
    projectConfigPath: project?.path ?? null,
    projectConfigPaths: project?.paths ?? [],
    bundledConfigPath: bundled ? BUNDLED_CONFIG_PATH : null,
    globalConfigPath: labConfigPath,
    configSources,
    configV2: configV2State
  } as LabAgentConfig;
}

/**
 * Gateway reliability remains part of the general composition settings UI.
 * V2 provider values supply defaults, while explicit global/project fields
 * continue to override them without reconstructing a provider document.
 *
 * @param {Record<string, any>} config
 * @param {Array<Record<string, any> | null | undefined>} layers
 */
export function applyLegacyReliabilityOverrides(config: Record<string, unknown>, layers: Array<Record<string, unknown> | null | undefined>) {
  const overrides: Record<string, unknown> = {};
  for (const layer of layers) {
    const lab: Record<string, unknown> = isPlainObject(layer?.lab) ? layer.lab : EMPTY_JSON;
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
  const currentLab: Record<string, unknown> = isPlainObject(config.lab) ? config.lab : EMPTY_JSON;
  return {
    ...config,
    lab: { ...currentLab, ...overrides }
  };
}

/**
 * @param {Record<string, any>} config
 * @param {NodeJS.ProcessEnv} env
 */
export function normalizeContextConfig(config: Record<string, unknown>, env: NodeJS.ProcessEnv) {
  const context: Record<string, unknown> = isPlainObject(config.context) ? config.context : EMPTY_JSON;
  const maxMessages = Number(context.maxMessages ?? 0);
  const maxTokens = Number(context.maxTokens ?? 0);
  const maxBytes = normalizeContextMaxBytes(context, env);
  return {
    ...config,
    context: {
      ...context,
      maxBytes,
      resumeMaxMessages: env.LAB_AGENT_CONTEXT_RESUME_MAX_MESSAGES
        ? Number(context.resumeMaxMessages ?? maxMessages)
        : Math.max(Number(context.resumeMaxMessages ?? maxMessages), maxMessages),
      resumeMaxTokens: env.LAB_AGENT_CONTEXT_RESUME_MAX_TOKENS
        ? Number(context.resumeMaxTokens ?? maxTokens)
        : Math.max(Number(context.resumeMaxTokens ?? maxTokens), maxTokens),
      resumeMaxBytes: env.LAB_AGENT_CONTEXT_RESUME_MAX_BYTES
        ? Number(context.resumeMaxBytes ?? maxBytes)
        : Math.max(Number(context.resumeMaxBytes ?? maxBytes), Number(maxBytes ?? 0))
    }
  };
}

/** @param {Record<string, any>} config */
export function normalizeAllowedHostsConfig(config: Record<string, unknown>) {
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

export function normalizeContextMaxBytes(context: Record<string, unknown>, env: NodeJS.ProcessEnv) {
  const maxTokensValue = Number(context.maxTokens);
  const maxBytesValue = Number(context.maxBytes);
  const maxTokens = Number.isInteger(maxTokensValue) && maxTokensValue > 0 ? maxTokensValue : null;
  const currentMaxBytes = Number.isInteger(maxBytesValue) && maxBytesValue > 0 ? maxBytesValue : null;
  const tokenAlignedMaxBytes = maxTokens ? maxTokens * 4 : null;
  if (env.LAB_AGENT_CONTEXT_MAX_BYTES) {
    return currentMaxBytes;
  }
  return Math.max(currentMaxBytes ?? 0, tokenAlignedMaxBytes ?? 0) || currentMaxBytes;
}

/**
 * @param {string} cwd
 */
export function localProjectConfigPath(cwd: string) {
  return projectLegacyConfigPath(cwd);
}

/**
 * User-level model/gateway defaults edited by Dashboard.
 *
 * @param {NodeJS.ProcessEnv} env
 */
export function globalConfigPath(env: NodeJS.ProcessEnv = process.env) {
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
export async function loadConfigV2Runtime({ cwd, env, readGlobal }: { cwd: string; env: NodeJS.ProcessEnv; readGlobal: boolean }) {
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
      runtimeProjection: EMPTY_JSON,
      gatewayHosts: []
    };
  }

  const emptyDocument = { settingsVersion: 2, namespaces: EMPTY_NAMESPACES };
  const resolved = resolveSettingsLayers({
    global: globalSnapshot.exists ? globalSnapshot.data : emptyDocument,
    project: projectSnapshot.exists ? projectSnapshot.data : emptyDocument
  });
  const runtimeProjection: JsonObject = cloneJsonObject(projectLegacyRuntimeConfig(resolved)) as JsonObject;
  const gatewayHosts = configV2GatewayHosts(isPlainObject(resolved) ? resolved : EMPTY_JSON);
  const projectionLab: JsonObject = isPlainObject(runtimeProjection.lab) ? runtimeProjection.lab : EMPTY_JSON;
  const profiles = Array.isArray(projectionLab.gatewayProfiles)
    ? projectionLab.gatewayProfiles.filter(isPlainObject)
    : [];
  await Promise.all(profiles.map(async (profile) => {
    if (profile.gatewayCredentialMode !== "credential" || typeof profile.gatewayCredentialRef !== "string") return;
    const secret = await credentialStore.resolve(profile.gatewayCredentialRef);
    if (secret) profile.gatewayApiKey = secret;
  }));
  const activeProfile = profiles.find((profile) => (
    profile.id === projectionLab.activeGatewayProfile
  ));
  if (activeProfile?.gatewayApiKey) {
    projectionLab.gatewayApiKey = activeProfile.gatewayApiKey;
    runtimeProjection.lab = projectionLab;
  }
  return {
    enabled: true,
    settingsPaths,
    revisions,
    defaultSelections: {
      global: namespaceSelection(globalSnapshot.data),
      project: namespaceSelection(projectSnapshot.data)
    },
    resolved,
    runtimeProjection,
    gatewayHosts
  };
}

/** @param {Readonly<Record<string, any>>} resolved */
export function namespaceSelection(data: unknown): unknown {
  const record = isPlainObject(data) ? data : undefined;
  const namespaces = record && isPlainObject(record.namespaces) ? record.namespaces : undefined;
  const group = namespaces && isPlainObject(namespaces["default-model"]) ? namespaces["default-model"] : undefined;
  const selection = group && isPlainObject(group.selection) ? group.selection : null;
  return selection ? cloneJsonObject(selection) : null;
}

export function configV2GatewayHosts(resolved: Readonly<JsonObject>): string[] {
  const hosts: string[] = [];
  const namespaces = isPlainObject(resolved.namespaces) ? resolved.namespaces : undefined;
  const providerNs = namespaces && isPlainObject(namespaces["model-providers"]) ? namespaces["model-providers"] : undefined;
  const providers = providerNs && isPlainObject(providerNs.providers) ? providerNs.providers : EMPTY_JSON;
  for (const provider of Object.values(providers)) {
    const record = isPlainObject(provider) ? provider : undefined;
    const transport = record && isPlainObject(record.transport) ? record.transport : undefined;
    for (const candidate of [transport?.baseURL, transport?.healthURL]) {
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
export function applyConfigV2Sources(sources: ConfigSources, configV2: {
  resolved?: { provenance?: { providers?: Record<string, unknown>; defaultModel?: unknown; [key: string]: unknown } } | null;
  settingsPaths?: Record<string, string>;
}, finalLab: JsonObject, env: NodeJS.ProcessEnv): ConfigSources {
  const provenance = configV2.resolved && isPlainObject(configV2.resolved.provenance) ? configV2.resolved.provenance : EMPTY_JSON;
  const providerSources = isPlainObject(provenance.providers) ? provenance.providers : EMPTY_JSON;
  const existingProfileList = Array.isArray(sources.lab.gatewayProfiles) ? sources.lab.gatewayProfiles : [];
  const existingProfiles = new Map(
    existingProfileList.filter(isPlainObject).map((entry) => [entry.id, entry])
  );
  const finalProfiles = Array.isArray(finalLab.gatewayProfiles) ? finalLab.gatewayProfiles : [];
  const settingsPaths = configV2.settingsPaths ?? EMPTY_STRING_MAP;
  const gatewayProfiles = finalProfiles.filter(isPlainObject).map((profile) => {
    const profileId = typeof profile.id === "string" ? profile.id : "";
    const scope = profileId ? providerSources[profileId] : undefined;
    if (!scope || typeof scope !== "string") {
      return existingProfiles.get(profile.id) ?? { id: profile.id, type: "environment", label: "模型网关环境变量" };
    }
    const descriptor = configV2SourceDescriptor(scope, settingsPaths);
    const models = Array.isArray(profile.models) ? profile.models : [];
    return {
      id: profile.id,
      ...descriptor,
      modelScopes: Object.fromEntries(
        models.map((model) => [modelEntryId(model), scope])
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
  const providerSource = typeof providerScope === "string"
    ? configV2SourceDescriptor(providerScope, settingsPaths)
    : sources.models;
  const selectionSource = typeof selectionScope === "string"
    ? configV2SourceDescriptor(selectionScope, settingsPaths)
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
export function configV2SourceDescriptor(scope: string, settingsPaths: Record<string, string>) {
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
export function hasModelGatewayEnvironmentControls(env: NodeJS.ProcessEnv) {
  return [
    "LAB_AGENT_MODEL",
    "LAB_AGENT_MODELS",
    "LAB_MODEL_GATEWAY_URL",
    "LAB_MODEL_GATEWAY_HEALTH_URL",
    "LAB_MODEL_GATEWAY_PROTOCOL",
    "LAB_MODEL_GATEWAY_API_KEY"
  ].some((name: string) => hasNonEmptyEnv(env, name));
}

export function shouldReadDefaultGlobalConfig(env: NodeJS.ProcessEnv) {
  return env === process.env
    || hasNonEmptyEnv(env, "LAB_AGENT_HOME")
    || hasNonEmptyEnv(env, "USERPROFILE")
    || hasNonEmptyEnv(env, "HOME");
}

/**
 * @param {string} cwd
 */
export async function loadProjectConfigs(cwd: string) {
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
export function mergeProjectConfigs(configs: Array<{ path: string; data: unknown }>) {
  if (configs.length === 0) {
    return null;
  }
  const merged = configs.reduce((current, item) => mergeConfigWithGatewayCredentialScope(current, item.data ?? EMPTY_JSON), {});
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
export function materializeLayerGatewayProfile(value: unknown): JsonObject {
  const config: JsonObject = isPlainObject(value) ? cloneJsonObject(value) : { ...EMPTY_JSON };
  const lab = isPlainObject(config.lab) ? config.lab : EMPTY_JSON;
  assertUniqueModelEntryIds(config.models, "models");
  if (Array.isArray(lab.gatewayProfiles)) {
    lab.gatewayProfiles = lab.gatewayProfiles.map((/** @type {Record<string, any>} */ profile: Record<string, unknown>) => {
      if (!isPlainObject(profile)) return profile;
      const gatewayProtocol = String(profile.gatewayProtocol ?? "openai-chat").trim() || "openai-chat";
      return {
        ...profile,
        gatewayUrl: normalizeGatewayInferenceUrl(profile.gatewayUrl, gatewayProtocol)
      };
    });
    assertUniqueLayerGatewayProfileIds(Array.isArray(lab.gatewayProfiles) ? lab.gatewayProfiles : []);
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
  const existingProfile = profiles.find((/** @type {Record<string, any>} */ candidate: Record<string, unknown>) => (
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
    ...(String(lab.gatewayApiKey ?? "").trim() ? { gatewayApiKey: lab.gatewayApiKey } : EMPTY_JSON),
    ...(lab.gatewayApiKeyDisabled === true ? { gatewayApiKey: null, gatewayApiKeyDisabled: true } : EMPTY_JSON),
    modelAlias: String(config.modelAlias ?? "").trim(),
    models: Array.isArray(config.models) ? cloneJsonObject(config.models) : [],
    routingModels: Array.isArray(config.routingModels) ? cloneJsonObject(config.routingModels) : [],
    ...(agents ? { agents } : EMPTY_JSON)
  };
  lab.gatewayProfiles = [
    ...profiles.filter((/** @type {Record<string, any>} */ candidate: Record<string, unknown>) => (
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
export function assertUniqueLayerGatewayProfileIds(profiles: Array<unknown>) {
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
export function assertUniqueModelEntryIds(value: unknown, keyPath: string) {
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
export async function readJsonIfExists(filePath: string) {
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
export function sanitizeLoadedConfig(raw: unknown, filePath: string) {
  const data = isPlainObject(raw) ? cloneJsonObject(raw) : EMPTY_JSON;
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

export function isExampleConfig(config: Record<string, unknown>) {
  const marked = config?.example === true
    || config?.template === true
    || config?.isExample === true
    || config?.isTemplate === true
    || (isPlainObject(config.metadata) && config.metadata.example === true)
    || (isPlainObject(config.metadata) && config.metadata.template === true);
  return marked && hasTemplatePlaceholderModelGatewayConfig(config);
}

export function hasTemplatePlaceholderModelGatewayConfig(config: Record<string, unknown>) {
  const lab = isPlainObject(config?.lab) ? config.lab : EMPTY_JSON;
  return isTemplatePlaceholderConfigValue(config?.modelAlias)
    || (Array.isArray(config?.models) && config.models.some((model) => isTemplatePlaceholderConfigValue(typeof model === "string" ? model : isPlainObject(model) ? model.id : "")))
    || isTemplatePlaceholderConfigValue(lab.gatewayUrl)
    || isTemplatePlaceholderConfigValue(lab.gatewayHealthUrl)
    || (Array.isArray(lab.gatewayProfiles) && lab.gatewayProfiles.some((profile) => {
      if (!isPlainObject(profile)) return false;
      return isTemplatePlaceholderConfigValue(profile.gatewayUrl)
      || isTemplatePlaceholderConfigValue(profile.gatewayHealthUrl)
      || isTemplatePlaceholderConfigValue(profile.modelAlias)
      || (Array.isArray(profile.models) && profile.models.some((model) => isTemplatePlaceholderConfigValue(typeof model === "string" ? model : isPlainObject(model) ? model.id : "")));
    }));
}

export function isTemplatePlaceholderConfigValue(value: unknown) {
  const text = String(value ?? "").trim().toLowerCase();
  return isPlaceholderConfigValue(value)
    || text.includes("gateway.lab.example")
    || text.includes("gateway.example.com");
}

export function isPlaceholderConfigValue(value: unknown) {
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

export function stripPlaceholderModelGatewayFields(config: Record<string, unknown>) {
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

export function stripModelGatewayConfig(config: Record<string, unknown>) {
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
export function stripBundledTemplateModelGateway(config: Record<string, unknown>) {
  stripModelGatewayConfig(config);
}

export function stripPlaceholderAllowedHosts(config: Record<string, unknown>) {
  if (!Array.isArray(config.allowedHosts)) {
    return;
  }
  config.allowedHosts = config.allowedHosts.filter((host: unknown) => !isPlaceholderAllowedHost(host));
}

export function isPlaceholderAllowedHost(value: unknown) {
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

export { NETWORK_MODES, GATEWAY_PROTOCOLS } from "./defaults.ts";
export type { LabAgentConfig } from "./defaults.ts";
