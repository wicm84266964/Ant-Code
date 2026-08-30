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

export const NETWORK_MODES: readonly string[] = Object.freeze([
  "offline",
  "lab-only",
  "approved-web",
  "open-dev"
]);

export const GATEWAY_PROTOCOLS: readonly string[] = Object.freeze([
  "lab-agent-gateway",
  "openai-chat",
  "openai-responses",
  "anthropic-messages"
]);

export type JsonObject = Record<string, unknown>;
export type ConfigLayerSnapshot = {
  data: JsonObject;
  path?: string | null;
  paths?: string[];
  label?: string;
  ignoredModelGatewayTemplate?: boolean;
};
export const EMPTY_JSON: JsonObject = {};
export const EMPTY_NAMESPACES: JsonObject = {};
export const EMPTY_STRING_MAP: Record<string, string> = {};

export const PROJECT_CONFIG_FILES = Object.freeze([
  "lab-agent.config.json",
  path.join(".lab-agent", "config.json")
]);

export const DEFAULT_CONTEXT_TOKENS = 200000;
export const DEFAULT_GATEWAY_MAX_RETRIES = 5;
export const DEFAULT_GATEWAY_TIMEOUT_MS = 900000;
export const DEFAULT_GATEWAY_IDLE_TIMEOUT_MS = 300000;
export const PACKAGE_ROOT = resolvePackageRoot();
export const BUNDLED_CONFIG_PATH = path.join(PACKAGE_ROOT, "lab-agent.config.json");

function resolvePackageRoot() {
  if (process.env.LAB_AGENT_PACKAGE_ROOT) {
    return path.resolve(process.env.LAB_AGENT_PACKAGE_ROOT);
  }
  if (process.env.NODE_SEA_EXECUTABLE || process.execPath.toLowerCase().endsWith("ant-code.exe")) {
    return path.dirname(process.execPath);
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export const DEFAULT_CONFIG = Object.freeze({
  appName: "lab-agent" as string,
  modelAlias: "" as string,
  reasoningEffort: null as string | null,
  models: [] as LabModel[],
  routingModels: [] as LabModel[],
  networkMode: "approved-web" as string,
  allowedHosts: [] as string[],
  transcript: {
    enabled: true,
    retentionDays: 30 as number | null,
    includeToolOutput: "policy" as string,
    encryption: "off" as string
  },
  security: {
    sensitivity: "standard" as string
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
    inFlightCompactRatio: null as number | null,
    inFlightKeepRecentTools: null as number | null
  },
  mcp: {
    servers: recommendedMcpServers()
  },
  skills: {
    enabled: true,
    paths: [] as string[]
  },
  agents: {
    orchestration: {
      enabled: true,
      defaultMode: "one-shot" as string,
      allowParallelReadonly: true,
      allowParallelWrites: false,
      maxParallelReadonlyAgentRuns: 3,
      autoReview: true,
      autoContinuePartial: false
    },
    delegationGuard: {
      enabled: true,
      mode: "remind" as string,
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
      mode: "remind" as string,
      todoThreshold: 4,
      requireForWrites: false,
      requireForHighRisk: false
    },
    goal: {
      maxAutoContinues: GOAL_MAX_AUTO_CONTINUES
    },
    vision: {
      enabled: true,
      model: null as string | null,
      autoUseWhenMainModelTextOnly: true
    },
    modelTiers: {} as Record<string, string>,
    budgets: {} as Record<string, unknown>,
    routing: {
      preferCheapForReadonly: true,
      strongForHighRisk: true,
      reviewerForHighRisk: true
    },
    profiles: [] as Array<Record<string, unknown>>
  },
  limits: {
    maxToolRounds: null as number | null
  },
  hooks: {
    enabled: true,
    disableAll: false,
    managedOnly: false,
    defaultTimeoutMs: 30000,
    maxOutputBytes: 12000,
    envAllowlist: ["PATH", "Path", "SystemRoot", "TEMP", "TMP", "HOME", "USERPROFILE"],
    events: {} as Record<string, unknown>
  },
  lab: {
    gatewayUrl: null as string | null,
    gatewayHealthUrl: null as string | null,
    gatewayProtocol: "openai-chat" as string,
    gatewayApiKey: null as string | null,
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

export type Mutable<T> = {
  -readonly [K in keyof T]: T[K] extends ReadonlyArray<infer U>
    ? U[]
    : T[K] extends object
      ? Mutable<T[K]>
      : T[K];
};

export type LabAgentConfig = Mutable<typeof DEFAULT_CONFIG> & {
  context: Mutable<typeof DEFAULT_CONFIG.context> & {
    promptCompactRatio?: number | null;
  };
  agents: Mutable<typeof DEFAULT_CONFIG.agents> & {
    syncModelTiersOnSwitch?: boolean;
    backgroundWakeupEnabled?: boolean;
    backgroundByDefault?: boolean;
    reviewGateEnabled?: boolean;
    goalMaxAutoContinues?: number;
    maxParallelReadonlyAgentRuns?: number;
    maxRounds?: number | null;
  };
  lab: Mutable<typeof DEFAULT_CONFIG.lab> & {
    configPath: string | null;
    gatewayApiKeyDisabled?: boolean;
    activeGatewayProfile?: string;
    gatewayProfiles?: Array<JsonObject>;
    sources?: {
      gatewayUrl?: unknown;
      gatewayHealthUrl?: unknown;
      gatewayProtocol?: unknown;
      gatewayApiKey?: unknown;
      gatewayProfiles?: unknown;
    };
  };
  projectConfigPath: string | null;
  projectConfigPaths: string[];
  bundledConfigPath: string | null;
  globalConfigPath: string;
  defaultModelAlias: string;
  configSources?: {
    modelAlias?: unknown;
    models?: unknown;
    lab?: {
      gatewayUrl?: unknown;
      gatewayHealthUrl?: unknown;
      gatewayProtocol?: unknown;
      gatewayApiKey?: unknown;
      gatewayProfiles?: unknown;
    };
    [key: string]: unknown;
  };
  configV2?: {
    enabled: boolean;
    settingsPaths?: Record<string, string>;
    revisions?: unknown;
    defaultSelections?: unknown;
    provenance?: {
      providers?: Record<string, unknown>;
      defaultModel?: unknown;
      [key: string]: unknown;
    };
    resolved?: {
      namespaces?: JsonObject;
      provenance?: {
        providers?: Record<string, unknown>;
        defaultModel?: unknown;
        [key: string]: unknown;
      };
      [key: string]: unknown;
    } | null;
  };
};

export type ConfigSourceDescriptor = {
  type: string;
  label: string;
  env?: string;
  path?: string | null;
};

export type ConfigSources = {
  modelAlias: ConfigSourceDescriptor;
  models: ConfigSourceDescriptor;
  lab: {
    gatewayUrl: ConfigSourceDescriptor;
    gatewayHealthUrl: ConfigSourceDescriptor;
    gatewayProtocol: ConfigSourceDescriptor;
    gatewayApiKey: ConfigSourceDescriptor;
    gatewayProfiles?: unknown;
  };
};

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
