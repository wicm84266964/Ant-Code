import fs from "node:fs/promises";
import path from "node:path";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  createSession,
  persistSessionSnapshot,
  runSessionTurn,
  SessionModelSelectionUnresolvedError
} from "../core/session.js";
import {
  GOAL_ABS_MAX_AUTO_CONTINUES,
  GOAL_CONTINUE_KIND,
  GOAL_MIN_AUTO_CONTINUES,
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
} from "../core/goal.js";
import {
  applyRuntimeModelSelection,
  currentRuntimeModelSelection,
  patchSessionModelSelectionMetadata,
  resolveSessionModelSelection
} from "../config-v2/runtime-selection.js";
import { clearSessionContext, compactSessionContextWithModel, createContextWindow, summarizeContextWindow } from "../core/context-window.js";
import { createLabModelGateway } from "../model-gateway/client.js";
import { redactGatewayText } from "../model-gateway/errors.js";
import { listConfiguredModels, normalizeAgentModelTiers, normalizeReasoningEfforts, resolveModelSelection } from "../model-gateway/models.js";
import {
  inferCatalogReasoning,
  normalizeCapabilityEfforts,
  reasoningProbeEffortIds
} from "../model-gateway/reasoning-capabilities.js";
import { resolveWorkspaceTrust, trustWorkspace as saveWorkspaceTrust } from "../permissions/workspace-trust.js";
import { createSessionStore } from "../storage/session-store.js";
import { GATEWAY_PROTOCOLS, NETWORK_MODES, globalConfigPath, loadConfig, localProjectConfigPath } from "../config/load-config.js";
import { cancelBackgroundAgentTasks, listBackgroundAgentTasks } from "../agents/background-registry.js";
import { cancelBackgroundTerminalTasks, listBackgroundTerminalTasks } from "../agents/background-terminal-registry.js";
import { createAgentTaskStore } from "../agents/task-store.js";
import { createAgentTaskGroupStore, summarizeGroupStatus } from "../agents/task-group-store.js";
import { cloneWorkflowState } from "../tools/workflow-tools.js";
import { mapSessionEventToDashboard, permissionRequestToActivity } from "./events.js";
import { applyPermissionMode, approvalKeyFor, buildApprovalPreview, normalizePermissionMode, permissionModeSummary, sanitizeSensitiveValue } from "./permissions.js";
import { collectSessionFiles } from "./files.js";
import { getAntCodeVersion } from "../version.js";
import { mutateJsonConfig } from "./config-store.js";
import {
  dashboardV2ErrorResult,
  deleteV2Provider,
  deleteV2ProviderModel,
  publicV2ConfigState,
  saveV2DefaultModel,
  saveV2ProviderModel
} from "./model-settings-v2.js";

const MAX_EVENTS = 500;
const MAX_QUEUE = 20;
const DEFAULT_TRANSCRIPT_PAGE_LIMIT = 100;
const MAX_TRANSCRIPT_PAGE_LIMIT = 200;
const BACKGROUND_SNAPSHOT_INTERVAL_MS = 15_000;
const BACKGROUND_STALE_PROGRESS_MS = 10 * 60 * 1000;
const BACKGROUND_DEAD_HEARTBEAT_MS = 5 * 60 * 1000;
const DEFAULT_INTERRUPT_FORCE_SETTLE_MS = 5_000;
const DEFAULT_LIFECYCLE_WAIT_MS = 5_000;
const MAX_LIFECYCLE_WAIT_MS = 30_000;
const LIFECYCLE_STATUS_WAIT_MS = 3_000;
const LIFECYCLE_POLL_INTERVAL_MS = 250;
const FORCE_SHUTDOWN_GRACE_MS = 2_000;
const TURN_REQUEST_TTL_MS = 5 * 60 * 1000;
const MAX_TURN_REQUESTS = 1_000;
const MAX_PROMPT_BYTES = 256 * 1024;
const MAX_TURN_IMAGES = 6;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 24 * 1024 * 1024;
const RETENTION_MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const SENSITIVE_GATEWAY_QUERY_KEYS = new Set(["access_token", "api_key", "key", "token", "authorization"]);
const INVALID_REASONING_EFFORT_PROBE = "antcode_invalid_effort_probe";
const MODEL_CAPABILITY_PROBE_REQUEST_TIMEOUT_MS = 10_000;
const MODEL_CAPABILITY_PROBE_TOTAL_TIMEOUT_MS = 20_000;
const MODEL_CAPABILITY_PROBE_MAX_RESPONSE_BYTES = 256 * 1024;
const GATEWAY_DISCOVERY_TOKEN_TTL_MS = 5 * 60 * 1000;
const MAX_GATEWAY_DISCOVERY_TOKENS = 256;

/** @typedef {{ ok: false; status: number; error: string; code?: string }} GatewayDiscoveryFailure */
/** @typedef {{ ids: string[]; models: Array<Record<string, any>> }} GatewayDiscoveryCatalog */
/** @typedef {{ ok: true; token: string | null; entry: Record<string, any> | null; catalog: GatewayDiscoveryCatalog }} GatewayDiscoveryResolution */
/** @typedef {{ ok: true; token: string; expiresAt: number; catalog: GatewayDiscoveryCatalog }} GatewayDiscoveryReceipt */
const DASHBOARD_SETTINGS_FIELDS = /** @type {Readonly<Record<string, readonly string[]>>} */ (Object.freeze({
  transcript: Object.freeze(["enabled", "retentionDays", "encryption"]),
  network: Object.freeze(["mode", "allowedHosts"]),
  agents: Object.freeze([
    "maxParallelReadonlyAgentRuns",
    "backgroundWakeupEnabled",
    "backgroundByDefault",
    "reviewGateEnabled",
    "syncModelTiersOnSwitch",
    "goalMaxAutoContinues"
  ]),
  reliability: Object.freeze(["maxRetries", "timeoutMs", "idleTimeoutMs"])
}));
const DASHBOARD_SETTINGS_MANAGED_ENV = /** @type {Readonly<Record<string, Readonly<Record<string, string>>>>} */ (Object.freeze({
  transcript: Object.freeze({
    enabled: "LAB_AGENT_TRANSCRIPT_ENABLED",
    retentionDays: "LAB_AGENT_TRANSCRIPT_RETENTION_DAYS",
    encryption: "LAB_AGENT_TRANSCRIPT_ENCRYPTION"
  }),
  network: Object.freeze({ mode: "LAB_AGENT_NETWORK_MODE" }),
  agents: Object.freeze({}),
  reliability: Object.freeze({
    maxRetries: "LAB_MODEL_GATEWAY_MAX_RETRIES",
    timeoutMs: "LAB_MODEL_GATEWAY_TIMEOUT_MS",
    idleTimeoutMs: "LAB_MODEL_GATEWAY_IDLE_TIMEOUT_MS"
  })
}));
export const DASHBOARD_ACTIVE_SESSION_DEFAULTS = Object.freeze({
  max: 50,
  idleTtlMs: 30 * 60 * 1000,
  sweepIntervalMs: 60 * 1000
});
const ALLOWED_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const VISIBLE_TRANSCRIPT_ROLES = new Set(["user", "assistant"]);
const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "partial", "blocked", "cancelled", "interrupted"]);
const TERMINAL_GROUP_STATUSES = new Set(["completed", "failed", "partial", "blocked", "cancelled", "interrupted"]);

class ActiveSessionMap extends Map {
  get(key) {
    const state = super.get(key);
    if (state) {
      state.lastAccessedAt = Date.now();
      state.accessVersion = Number(state.accessVersion ?? 0) + 1;
    }
    return state;
  }

  peek(key) {
    return super.get(key);
  }

  set(key, state) {
    state.lastAccessedAt = Date.now();
    state.accessVersion = Number(state.accessVersion ?? 0) + 1;
    return super.set(key, state);
  }
}

class ActiveSessionCapacityError extends Error {
  constructor() {
    super("No reclaimable Dashboard active session capacity is available");
    this.name = "ActiveSessionCapacityError";
  }
}

/**
 * @param {{
 *   cwd: string;
 *   env?: NodeJS.ProcessEnv;
 *   runTurn?: any;
 *   lifecycleActivity?: (active: any, cwd: string) => Promise<any>;
 *   cancelBackgroundWork?: (state: any, options?: any) => Promise<any>;
 *   gatewayDiscoveryTtlMs?: number;
 *   gatewayDiscoveryNow?: () => number;
 * }} options
 */
export function createDashboardRuntime(options) {
  const runtimeEnv = options.env ?? process.env;
  const active = new ActiveSessionMap();
  const sessionMutationLocks = new Map();
  const sessionConfigMutationLock = Symbol("session-config-mutation-lock");
  const activeCapacityLocks = new Map();
  const turnRequests = new Map();
  const clientModelSelections = new Map();
  const gatewayDiscoveries = new Map();
  const gatewayDiscoverySecret = randomBytes(32);
  const gatewayDiscoveryTtlMs = boundedGatewayDiscoveryTtl(options.gatewayDiscoveryTtlMs);
  const gatewayDiscoveryNow = typeof options.gatewayDiscoveryNow === "function"
    ? options.gatewayDiscoveryNow
    : Date.now;
  const activePolicy = dashboardActiveSessionPolicy(runtimeEnv);
  let processTrusted = false;
  let selectedModelId = "";
  let selectedProviderId = "";
  let selectedReasoningEffort = "";
  let shuttingDown = false;
  let activeSweepPromise = null;
  /** @type {any} */
  const readRuntimeActivity = options.lifecycleActivity ?? dashboardRuntimeActivity;
  /** @type {any} */
  const cancelBackgroundWork = options.cancelBackgroundWork ?? cancelSessionBackgroundWork;
  const resolveConfigEnv = () => dashboardConfigEnv(options.cwd, runtimeEnv);
  let retentionMaintenanceTail = Promise.resolve();
  /** @type {Promise<any> | null} */
  let pendingRetentionMaintenance = null;
  let lastRetentionMaintenanceAt = 0;
  /**
   * @param {Record<string, any>} config
   * @param {{ force?: boolean }} [maintenanceOptions]
   */
  const maintainSessionRetention = (config, maintenanceOptions = {}) => {
    const force = maintenanceOptions.force === true;
    const requestedAt = Date.now();
    if (!force && pendingRetentionMaintenance) {
      return pendingRetentionMaintenance;
    }
    if (!force && requestedAt - lastRetentionMaintenanceAt < RETENTION_MAINTENANCE_INTERVAL_MS) {
      return Promise.resolve({ ok: true, deleted: [], skipped: "throttled" });
    }
    lastRetentionMaintenanceAt = requestedAt;
    const retentionDays = config.transcript?.retentionDays === null
      ? null
      : Number.isFinite(config.transcript?.retentionDays) ? config.transcript.retentionDays : 30;
    const run = retentionMaintenanceTail.then(async () => {
      try {
        return await withKeyedMutation(activeCapacityLocks, "active-capacity", async () => {
          const store = createSessionStore({ cwd: options.cwd, transcript: config.transcript, env: runtimeEnv });
          const result = await store.cleanupExpiredSessions(retentionDays, {
            excludeSessionIds: [...active.keys()]
          });
          return { ok: true, deleted: result.deleted };
        });
      } catch (error) {
        return {
          ok: false,
          deleted: [],
          error: error instanceof Error ? error.message : String(error)
        };
      }
    });
    retentionMaintenanceTail = run.then(() => undefined, () => undefined);
    const pending = run.finally(() => {
      if (pendingRetentionMaintenance === pending) {
        pendingRetentionMaintenance = null;
      }
    });
    pendingRetentionMaintenance = pending;
    return pending;
  };
  const activeSweepTimer = setInterval(() => {
    if (activeSweepPromise || shuttingDown) {
      return;
    }
    activeSweepPromise = reclaimActiveSessions(active, {
      cwd: options.cwd,
      env: runtimeEnv,
      sessionMutationLocks,
      policy: activePolicy,
      ttlOnly: true
    }).catch(() => {
      // Maintenance retries on the next sweep; runtime requests remain authoritative.
    }).finally(() => {
      activeSweepPromise = null;
    });
  }, activePolicy.sweepIntervalMs);
  activeSweepTimer.unref?.();

  /** @param {Record<string, any>} input @param {(lockedInput: Record<string, any>) => Promise<any>} rerun */
  const rerunWithSessionConfigLock = (input, rerun) => {
    const sessionId = String(input?.sessionId ?? "").trim();
    if (!sessionId || Reflect.get(input, sessionConfigMutationLock) === sessionId) return null;
    const lockedInput = { ...input, sessionId };
    Reflect.set(lockedInput, sessionConfigMutationLock, sessionId);
    return withKeyedMutation(sessionMutationLocks, sessionId, () => rerun(lockedInput));
  };

  const runtime = {
    cwd: options.cwd,
    env: runtimeEnv,
    active,
    activePolicy: { ...activePolicy },
    /** @param {Record<string, any>} [input] */
    async status(input = {}) {
      const configEnv = await resolveConfigEnv();
      const config = await loadConfig({ cwd: options.cwd, env: configEnv });
      await maintainSessionRetention(config);
      const runtimeSelection = dashboardRuntimeSelection(
        clientModelSelections,
        input.clientId,
        { providerId: selectedProviderId, modelId: selectedModelId, reasoningEffort: selectedReasoningEffort }
      );
      const modelConfig = configForDashboardSelection(config, runtimeSelection);
      const configV2 = publicV2ConfigState(config);
      return {
        ok: true,
        sessionStatus: sessionStatusFromConfig(modelConfig),
        models: modelOptions(modelConfig),
        agentModelTiers: publicAgentModelTiers(modelConfig),
        visionAgent: publicVisionAgent(modelConfig),
        gatewayConfig: publicGatewayConfig(modelConfig),
        gatewayProfiles: publicGatewayProfiles(modelConfig),
        settings: publicDashboardSettings(modelConfig, runtimeEnv),
        configV2,
        configRevisions: configV2.revisions
      };
    },
    /** @param {Record<string, any>} input */
    async saveSettingsConfig(input = {}) {
      const locked = rerunWithSessionConfigLock(input, (lockedInput) => runtime.saveSettingsConfig(lockedInput));
      if (locked) return locked;
      const configEnv = await resolveConfigEnv();
      let config = await loadConfig({ cwd: options.cwd, env: configEnv });
      const sessionId = String(input.sessionId ?? "").trim();
      const state = sessionId ? active.get(sessionId) : null;
      if (state?.running) {
        return {
          ok: false,
          status: 409,
          error: "任务运行中，结束或中断后再修改设置",
          settings: publicDashboardSettings(state.session.config, runtimeEnv)
        };
      }
      let normalized = normalizeDashboardSettingsInput(input, config, runtimeEnv);
      if (!normalized.ok) {
        return normalized;
      }
      const configPath = modelConfigTargetPath(options.cwd, configEnv, normalized.saveTarget);
      const mutation = await mutateDashboardConfig(configPath, async (/** @type {Record<string, any>} */ targetConfig) => {
        config = await loadConfig({ cwd: options.cwd, env: await resolveConfigEnv() });
        normalized = normalizeDashboardSettingsInput(input, config, runtimeEnv);
        if (!normalized.ok) {
          throw dashboardConfigResultError(normalized);
        }
        return buildDashboardSettingsConfig(targetConfig, normalized);
      });
      if (!mutation.ok) {
        return mutation;
      }
      const refreshed = await loadConfig({ cwd: options.cwd, env: await resolveConfigEnv() });
      if (normalized.section === "transcript") {
        await maintainSessionRetention(refreshed, { force: true });
      }
      const sessionView = isConfigV2Enabled(refreshed) && sessionId
        ? await refreshDashboardSessionAfterV2Mutation({
            active,
            cwd: options.cwd,
            env: runtimeEnv,
            sessionId,
            config: refreshed
          })
        : null;
      let sessionConfig;
      let syncedState = null;
      if (isConfigV2Enabled(refreshed)) {
        sessionConfig = sessionView?.config ?? configForDashboardSelection(refreshed, dashboardRuntimeSelection(
          clientModelSelections,
          input.clientId,
          { providerId: selectedProviderId, modelId: selectedModelId, reasoningEffort: selectedReasoningEffort }
        ));
      } else {
        const currentModel = String(state?.session?.model || selectedModelId || refreshed.modelAlias || "").trim();
        const sessionDefinesEffort = Boolean(state)
          && Object.prototype.hasOwnProperty.call(state.session.config ?? {}, "reasoningEffort")
          && state.session.config.reasoningEffort !== undefined;
        const currentEffort = sessionDefinesEffort
          ? state.session.config.reasoningEffort
          : selectedReasoningEffort;
        sessionConfig = configWithModelSelection(refreshed, currentModel, currentEffort, {
          explicitReasoningEffort: sessionDefinesEffort || Boolean(selectedModelId)
        });
        syncedState = syncIdleSessionConfig(active, sessionId, sessionConfig);
      }
      const activeState = sessionView?.state ?? syncedState ?? activeStateForSession(active, sessionId);
      return {
        ok: true,
        configPath,
        configRevision: mutation.revision,
        saveTarget: normalized.saveTarget,
        sessionId: sessionId || undefined,
        sessionStatus: sessionView?.sessionStatus
          ?? (activeState ? sessionStatusSummary(activeState.session) : sessionStatusFromConfig(sessionConfig)),
        settings: publicDashboardSettings(sessionConfig, runtimeEnv)
      };
    },
    /** @param {Record<string, any>} input */
    async switchModel(input = {}) {
      const locked = rerunWithSessionConfigLock(input, (lockedInput) => runtime.switchModel(lockedInput));
      if (locked) return locked;
      const configEnv = await resolveConfigEnv();
      let config = /** @type {Record<string, any>} */ (await loadConfig({ cwd: options.cwd, env: configEnv }));
      const modelId = String(input.modelId ?? input.model ?? "").trim();
      const sessionId = String(input.sessionId ?? "").trim();
      const state = sessionId ? active.get(sessionId) : null;
      if (state?.running) {
        return {
          ok: false,
          status: 409,
          error: "任务运行中，结束或中断后再切换模型",
          models: modelOptions(state.session.config),
          agentModelTiers: publicAgentModelTiers(state.session.config),
          visionAgent: publicVisionAgent(state.session.config),
          gatewayConfig: publicGatewayConfig(state.session.config),
          gatewayProfiles: publicGatewayProfiles(state.session.config)
        };
      }
      const archived = sessionId && !state
        ? await readDashboardSessionMetadataExact({
            cwd: options.cwd,
            env: runtimeEnv,
            config,
            sessionId
          })
        : null;
      if (archived && !archived.ok) {
        return archived;
      }
      const archivedResolution = archived?.ok && isConfigV2Enabled(config)
        ? resolveSessionModelSelection(config, archived.metadata)
        : null;
      const clientSelection = dashboardRuntimeSelection(
        clientModelSelections,
        input.clientId,
        { providerId: selectedProviderId, modelId: selectedModelId, reasoningEffort: selectedReasoningEffort }
      );
      if (isConfigV2Enabled(config)) {
        const currentSelection = state
          ? {
              providerId: activeGatewayProfileId(state.session.config),
              modelId: state.session.model,
              reasoningEffort: state.session.config?.reasoningEffort
            }
          : archivedResolution?.status === "resolved"
            ? {
                providerId: archivedResolution.selection.provider,
                modelId: archivedResolution.selection.model,
                reasoningEffort: archivedResolution.selection.reasoningEffort ?? null
              }
            : clientSelection;
        config = configForDashboardSelection(config, currentSelection);
      }
      const requestedProfileId = String(
        input.providerId ?? input.profileId ?? input.gatewayProfileId ?? ""
      ).trim();
      if (sessionId && archivedResolution?.status === "unresolved" && !requestedProfileId) {
        return unresolvedSessionModelSelectionResult(archivedResolution, sessionId);
      }
      const profileId = String(
        requestedProfileId
          || (isConfigV2Enabled(config)
            ? activeGatewayProfileId(config) || clientSelection.providerId
            : "")
      ).trim();
      if (profileId && profileId !== activeGatewayProfileId(config)) {
        const profile = gatewayProfilesFromConfig(config).find((item) => item.id === profileId);
        if (!profile) {
          return {
            ok: false,
            status: 404,
            error: "网关配置不存在",
            models: modelOptions(config),
            agentModelTiers: publicAgentModelTiers(config),
            visionAgent: publicVisionAgent(config),
            gatewayConfig: publicGatewayConfig(config),
            gatewayProfiles: publicGatewayProfiles(config)
          };
        }
        if (!parseConfigUrl(profile.gatewayUrl) || !GATEWAY_PROTOCOLS.includes(profile.gatewayProtocol)) {
          return {
            ok: false,
            status: 400,
            error: "该网关的 API 地址或协议不完整，请先在设置中修正",
            models: modelOptions(config),
            agentModelTiers: publicAgentModelTiers(config),
            visionAgent: publicVisionAgent(config),
            gatewayConfig: publicGatewayConfig(config),
            gatewayProfiles: publicGatewayProfiles(config)
          };
        }
        if (!Array.isArray(profile.models) || profile.models.length === 0) {
          return {
            ok: false,
            status: 400,
            error: "该网关没有已配置模型，请先在设置中添加模型",
            models: modelOptions(config),
            agentModelTiers: publicAgentModelTiers(config),
            visionAgent: publicVisionAgent(config),
            gatewayConfig: publicGatewayConfig(config),
            gatewayProfiles: publicGatewayProfiles(config)
          };
        }
        if (modelId && !/** @type {Array<Record<string, any>>} */ (profile.models).some((model) => model.id === modelId)) {
          return {
            ok: false,
            status: 400,
            error: `模型 ${modelId} 不属于所选来源`,
            models: modelOptions(config),
            agentModelTiers: publicAgentModelTiers(config),
            visionAgent: publicVisionAgent(config),
            gatewayConfig: publicGatewayConfig(config),
            gatewayProfiles: publicGatewayProfiles(config)
          };
        }
        if (isConfigV2Enabled(config)) {
          config = configForGatewayProfileSelection(config, profileId);
        } else {
          const localPath = localProjectConfigPath(options.cwd);
          let nextLocal = buildGatewayProfileSwitchConfig(await readJsonConfig(localPath), config, profileId);
          const mutation = await mutateDashboardConfig(localPath, async (local) => {
            const latestConfig = await loadConfig({ cwd: options.cwd, env: await resolveConfigEnv() });
            nextLocal = buildGatewayProfileSwitchConfig(local, latestConfig, profileId);
            if (!nextLocal.ok) {
              throw dashboardConfigResultError(nextLocal);
            }
            return nextLocal.config;
          });
          if (!mutation.ok) {
            return mutation;
          }
          config = await loadConfig({ cwd: options.cwd, env: await resolveConfigEnv() });
        }
      }
      const selection = resolveModelSelection(config, modelId);
      if (!selection.ok) {
        return {
          ok: false,
          status: 400,
          error: selection.error.message,
          models: modelOptions(config),
          agentModelTiers: publicAgentModelTiers(config),
          visionAgent: publicVisionAgent(config),
          gatewayConfig: publicGatewayConfig(config),
          gatewayProfiles: publicGatewayProfiles(config)
        };
      }
      const selectedModel = /** @type {Record<string, any>} */ (selection.model);
      let refreshed = config;
      if (
        !isConfigV2Enabled(config)
        && input.applyAgentDefaults === true
        && Object.keys(selectedModel.agentModelTiers ?? {}).length > 0
      ) {
        const localPath = localProjectConfigPath(options.cwd);
        const mutation = await mutateDashboardConfig(localPath, (local) => (
          buildLocalAgentModelTiersConfig(local, config, selectedModel.agentModelTiers)
        ));
        if (!mutation.ok) {
          return mutation;
        }
        refreshed = await loadConfig({ cwd: options.cwd, env: await resolveConfigEnv() });
      }
      const nextModelId = selectedModel.id;
      const nextReasoningEffort = resolveReasoningEffortSelection(
        selectedModel,
        input.reasoningEffort,
        selectedModel.defaultReasoningEffort
      );
      const nextProviderId = profileId || activeGatewayProfileId(refreshed);
      const modelConfig = configWithModelSelection(refreshed, nextModelId, nextReasoningEffort, {
        explicitReasoningEffort: true
      });
      if (sessionId) {
        const persisted = await persistDashboardSessionModelConfig({
          active,
          sessionMutationLocks,
          cwd: options.cwd,
          env: runtimeEnv,
          sessionId,
          config: modelConfig,
          lockHeld: Reflect.get(input, sessionConfigMutationLock) === sessionId
        });
        if (!persisted.ok) {
          return {
            ...persisted,
            models: modelOptions(modelConfig),
            agentModelTiers: publicAgentModelTiers(modelConfig),
            visionAgent: publicVisionAgent(modelConfig),
            gatewayConfig: publicGatewayConfig(modelConfig),
            gatewayProfiles: publicGatewayProfiles(modelConfig)
          };
        }
        if (persisted.state) appendDashboardEvent(persisted.state, {
          type: "model_switched",
          id: eventId("model"),
          model: selectedModel.id,
          modelInfo: publicModelOption(selectedModel, selectedModel.id),
          sessionStatus: persisted.sessionStatus,
          at: new Date().toISOString()
        });
        return {
          ok: true,
          sessionId,
          sessionStatus: persisted.sessionStatus,
          models: modelOptions(modelConfig),
          agentModelTiers: publicAgentModelTiers(modelConfig),
          visionAgent: publicVisionAgent(modelConfig),
          gatewayConfig: publicGatewayConfig(modelConfig),
          gatewayProfiles: publicGatewayProfiles(modelConfig)
        };
      }
      selectedModelId = nextModelId;
      selectedReasoningEffort = nextReasoningEffort;
      selectedProviderId = nextProviderId;
      rememberDashboardRuntimeSelection(clientModelSelections, input.clientId, {
        providerId: nextProviderId,
        modelId: nextModelId,
        reasoningEffort: nextReasoningEffort
      });
      return {
        ok: true,
        sessionStatus: sessionStatusFromConfig(modelConfig),
        models: modelOptions(modelConfig),
        agentModelTiers: publicAgentModelTiers(modelConfig),
        visionAgent: publicVisionAgent(modelConfig),
        gatewayConfig: publicGatewayConfig(modelConfig),
        gatewayProfiles: publicGatewayProfiles(modelConfig)
      };
    },
    /** @param {Record<string, any>} input */
    async switchReasoningEffort(input = {}) {
      const locked = rerunWithSessionConfigLock(input, (lockedInput) => runtime.switchReasoningEffort(lockedInput));
      if (locked) return locked;
      const configEnv = await resolveConfigEnv();
      let config = /** @type {Record<string, any>} */ (await loadConfig({ cwd: options.cwd, env: configEnv }));
      const sessionId = String(input.sessionId ?? "").trim();
      const state = sessionId ? active.get(sessionId) : null;
      if (state?.running) {
        return { ok: false, status: 409, error: "任务运行中，结束或中断后再调整思考强度" };
      }
      const archived = sessionId && !state
        ? await readDashboardSessionMetadataExact({
            cwd: options.cwd,
            env: runtimeEnv,
            config,
            sessionId
          })
        : null;
      if (archived && !archived.ok) {
        return archived;
      }
      const clientSelection = dashboardRuntimeSelection(
        clientModelSelections,
        input.clientId,
        { providerId: selectedProviderId, modelId: selectedModelId, reasoningEffort: selectedReasoningEffort }
      );
      let atomicSelection = null;
      if (isConfigV2Enabled(config)) {
        if (state) {
          atomicSelection = currentRuntimeModelSelection(state.session.config, {
            model: state.session.model,
            reasoningEffort: state.session.config?.reasoningEffort
          });
        } else if (archived?.ok) {
          const resolution = resolveSessionModelSelection(config, archived.metadata);
          if (resolution.status !== "resolved") {
            return unresolvedSessionModelSelectionResult(resolution, sessionId);
          }
          atomicSelection = resolution.selection;
        } else {
          const requestedSelection = {
            providerId: input.providerId ?? input.profileId ?? clientSelection.providerId,
            modelId: input.modelId ?? input.model ?? clientSelection.modelId,
            reasoningEffort: clientSelection.reasoningEffort
          };
          const selectedConfig = configForDashboardSelection(config, requestedSelection);
          atomicSelection = currentRuntimeModelSelection(selectedConfig, {
            model: selectedConfig.modelAlias,
            reasoningEffort: selectedConfig.reasoningEffort
          });
        }
        if (!atomicSelection) {
          return unresolvedSessionModelSelectionResult({
            status: "unresolved",
            reason: "invalid-runtime-selection",
            model: state?.session?.model ?? archived?.metadata?.model ?? input.modelId ?? ""
          }, sessionId);
        }
        const requestedProviderId = String(input.providerId ?? input.profileId ?? "").trim();
        const requestedModelId = String(input.modelId ?? input.model ?? "").trim();
        if (
          (requestedProviderId && requestedProviderId !== atomicSelection.provider)
          || (requestedModelId && requestedModelId !== atomicSelection.model)
        ) {
          return {
            ok: false,
            status: 409,
            code: "SESSION_MODEL_SELECTION_CHANGED",
            error: "模型选择已经变化，请刷新后重试",
            sessionId
          };
        }
        config = configForDashboardSelection(config, {
          providerId: atomicSelection.provider,
          modelId: atomicSelection.model,
          reasoningEffort: atomicSelection.reasoningEffort ?? null
        });
      } else {
        config = state?.session?.config ?? configForDashboardSelection(config, clientSelection);
      }
      const modelId = String(atomicSelection?.model || state?.session?.model || clientSelection.modelId || config.modelAlias || "").trim();
      const selection = resolveModelSelection(config, modelId);
      if (!selection.ok) {
        return { ok: false, status: 400, error: selection.error.message };
      }
      const selectedModel = /** @type {Record<string, any>} */ (selection.model);
      const requested = String(input.reasoningEffort ?? input.effort ?? "").trim().toLowerCase();
      const clearOverride = !requested || requested === "default";
      const effort = clearOverride ? "" : resolveReasoningEffortSelection(selectedModel, requested, "");
      if (!clearOverride && effort !== requested) {
        return { ok: false, status: 400, error: `模型 ${selectedModel.id} 不支持思考强度 ${requested || "（空）"}` };
      }
      const activeConfig = configWithModelSelection(config, modelId, effort, { explicitReasoningEffort: true });
      if (sessionId) {
        const persisted = await persistDashboardSessionModelConfig({
          active,
          sessionMutationLocks,
          cwd: options.cwd,
          env: runtimeEnv,
          sessionId,
          config: activeConfig,
          expectedSelection: atomicSelection,
          lockHeld: Reflect.get(input, sessionConfigMutationLock) === sessionId
        });
        if (!persisted.ok) return persisted;
        if (persisted.state) appendDashboardEvent(persisted.state, {
          type: "reasoning_effort_switched",
          id: eventId("reasoning-effort"),
          reasoningEffort: effort || null,
          sessionStatus: persisted.sessionStatus,
          at: new Date().toISOString()
        });
        return {
          ok: true,
          sessionId,
          sessionStatus: persisted.sessionStatus,
          models: modelOptions(activeConfig),
          gatewayConfig: publicGatewayConfig(activeConfig),
          gatewayProfiles: publicGatewayProfiles(activeConfig)
        };
      }
      selectedReasoningEffort = effort;
      selectedModelId = selectedModel.id;
      selectedProviderId = activeGatewayProfileId(config);
      rememberDashboardRuntimeSelection(clientModelSelections, input.clientId, {
        providerId: selectedProviderId,
        modelId: selectedModelId,
        reasoningEffort: effort || null
      });
      return {
        ok: true,
        sessionStatus: sessionStatusFromConfig(activeConfig),
        models: modelOptions(activeConfig),
        gatewayConfig: publicGatewayConfig(activeConfig),
        gatewayProfiles: publicGatewayProfiles(activeConfig)
      };
    },
    /** @param {Record<string, any>} input */
    async saveModelConfig(input = {}) {
      const locked = rerunWithSessionConfigLock(input, (lockedInput) => runtime.saveModelConfig(lockedInput));
      if (locked) return locked;
      const configEnv = await resolveConfigEnv();
      let config = /** @type {Record<string, any>} */ (await loadConfig({ cwd: options.cwd, env: configEnv }));
      const discovery = resolveGatewayDiscovery({
        discoveries: gatewayDiscoveries,
        secret: gatewayDiscoverySecret,
        now: gatewayDiscoveryNow(),
        input,
        config
      });
      if (!discovery.ok) return discovery;
      let committedDiscovery = discovery;
      let normalized = normalizeModelConfigInput(input, config, discovery.catalog);
      if (!normalized.ok) {
        return normalized;
      }
      if (isConfigV2Enabled(config)) {
        const sessionId = String(input.sessionId ?? "").trim();
        const state = sessionId ? active.get(sessionId) : null;
        if (state?.running) {
          return {
            ok: false,
            status: 409,
            error: "任务运行中，结束或中断后再修改模型设置",
            models: modelOptions(state.session.config),
            gatewayConfig: publicGatewayConfig(state.session.config),
            gatewayProfiles: publicGatewayProfiles(state.session.config)
          };
        }
        /** @type {Record<string, any>} */
        let saved;
        try {
          saved = await saveV2ProviderModel({
            cwd: options.cwd,
            env: configEnv,
            scope: input.scope ?? input.saveTarget,
            expectedRevision: input.expectedRevision,
            expectedCredentialsRevision: input.expectedCredentialsRevision ?? input.credentialsRevision,
            prepareInput: async () => {
              const lockedConfig = await loadConfig({ cwd: options.cwd, env: await resolveConfigEnv() });
              const lockedDiscovery = resolveGatewayDiscovery({
                discoveries: gatewayDiscoveries,
                secret: gatewayDiscoverySecret,
                now: gatewayDiscoveryNow(),
                input,
                config: lockedConfig
              });
              if (!lockedDiscovery.ok) throw dashboardConfigResultError(lockedDiscovery);
              const lockedNormalized = normalizeModelConfigInput(input, lockedConfig, lockedDiscovery.catalog);
              if (!lockedNormalized.ok) throw dashboardConfigResultError(lockedNormalized);
              config = lockedConfig;
              committedDiscovery = lockedDiscovery;
              normalized = lockedNormalized;
              return {
                ...lockedNormalized,
                profileId: String(input.providerId ?? input.profileId ?? input.gatewayProfileId ?? "").trim()
              };
            },
            input: {
              ...normalized,
              profileId: String(input.providerId ?? input.profileId ?? input.gatewayProfileId ?? "").trim()
            }
          });
        } catch (error) {
          return dashboardV2ErrorResult(error);
        }
        const refreshed = await loadConfig({ cwd: options.cwd, env: await resolveConfigEnv() });
        const sessionView = sessionId
          ? await refreshDashboardSessionAfterV2Mutation({
              active,
              cwd: options.cwd,
              env: runtimeEnv,
              sessionId,
              config: refreshed
            })
          : null;
        const previousClientSelection = dashboardRuntimeSelection(
          clientModelSelections,
          input.clientId,
          { providerId: selectedProviderId, modelId: selectedModelId, reasoningEffort: selectedReasoningEffort }
        );
        let modelConfig = sessionView?.config ?? configForDashboardSelection(refreshed, previousClientSelection);
        if (normalized.switchToModel && !sessionId) {
          selectedProviderId = saved.providerId;
          selectedModelId = saved.modelId;
          selectedReasoningEffort = resolveReasoningEffortSelection(
            normalized.model,
            normalized.model.defaultReasoningEffort,
            ""
          );
          rememberDashboardRuntimeSelection(clientModelSelections, input.clientId, {
            providerId: selectedProviderId,
            modelId: selectedModelId,
            reasoningEffort: selectedReasoningEffort
          });
          modelConfig = configForDashboardSelection(refreshed, {
            providerId: selectedProviderId,
            modelId: selectedModelId,
            reasoningEffort: selectedReasoningEffort
          });
        }
        const activeState = sessionView?.state ?? activeStateForSession(active, sessionId);
        const activeConfig = activeState?.session.config ?? modelConfig;
        const configV2 = publicV2ConfigState(refreshed);
        consumeGatewayDiscovery(gatewayDiscoveries, committedDiscovery);
        return {
          ...saved,
          sessionId: sessionId || undefined,
          sessionStatus: sessionView?.sessionStatus
            ?? (activeState ? sessionStatusSummary(activeState.session) : sessionStatusFromConfig(modelConfig)),
          models: modelOptions(activeConfig),
          agentModelTiers: publicAgentModelTiers(activeConfig),
          visionAgent: publicVisionAgent(activeConfig),
          gatewayConfig: publicGatewayConfig(activeConfig),
          gatewayProfiles: publicGatewayProfiles(activeConfig),
          configV2,
          configRevisions: configV2.revisions
        };
      }
      const configPath = modelConfigTargetPath(options.cwd, configEnv, normalized.saveTarget);
      if (normalized.saveTarget === "global") {
        const inheritedBeforeSave = await readJsonConfig(configPath);
        const seenProjectPaths = new Set();
        let cleanedProjectConfig = false;
        for (const configuredPath of Array.isArray(config.projectConfigPaths) ? config.projectConfigPaths : []) {
          const configuredProjectPath = String(configuredPath ?? "").trim();
          if (!configuredProjectPath) {
            continue;
          }
          const projectPath = path.resolve(configuredProjectPath);
          const projectPathKey = projectPath.toLowerCase();
          if (projectPathKey === path.resolve(configPath).toLowerCase() || seenProjectPaths.has(projectPathKey)) {
            continue;
          }
          seenProjectPaths.add(projectPathKey);
          const projectBeforeSave = await readJsonConfig(projectPath);
          if (removeRedundantInheritedGatewayShadows(projectBeforeSave, inheritedBeforeSave) !== projectBeforeSave) {
            const cleanup = await mutateDashboardConfig(
              projectPath,
              (local) => removeRedundantInheritedGatewayShadows(local, inheritedBeforeSave)
            );
            if (!cleanup.ok) {
              return cleanup;
            }
            cleanedProjectConfig = true;
          }
        }
        if (cleanedProjectConfig) {
          config = await loadConfig({ cwd: options.cwd, env: await resolveConfigEnv() });
          const currentDiscovery = validateGatewayDiscoveryEntry({
            entry: discovery.entry,
            secret: gatewayDiscoverySecret,
            now: gatewayDiscoveryNow(),
            input,
            config
          });
          if (!currentDiscovery.ok) {
            return currentDiscovery;
          }
          normalized = normalizeModelConfigInput(input, config, discovery.catalog);
          if (!normalized.ok) {
            return normalized;
          }
        }
      }
      const mutation = await mutateDashboardConfig(configPath, async (targetConfig) => {
        config = await loadConfig({ cwd: options.cwd, env: await resolveConfigEnv() });
        const currentDiscovery = validateGatewayDiscoveryEntry({
          entry: discovery.entry,
          secret: gatewayDiscoverySecret,
          now: gatewayDiscoveryNow(),
          input,
          config
        });
        if (!currentDiscovery.ok) {
          throw dashboardConfigResultError(currentDiscovery);
        }
        normalized = normalizeModelConfigInput(input, config, discovery.catalog);
        if (!normalized.ok) {
          throw dashboardConfigResultError(normalized);
        }
        const credentialMigration = validateGatewayCredentialMigration(targetConfig, config, normalized);
        if (!credentialMigration.ok) {
          throw dashboardConfigResultError(credentialMigration);
        }
        return buildLocalModelConfig(targetConfig, config, normalized);
      });
      if (!mutation.ok) {
        return mutation;
      }

      const refreshed = await loadConfig({ cwd: options.cwd, env: await resolveConfigEnv() });
      if (normalized.switchToModel) {
        selectedModelId = normalized.model.id;
        selectedReasoningEffort = resolveReasoningEffortSelection(
          normalized.model,
          normalized.model.defaultReasoningEffort,
          ""
        );
      } else if (shouldReplaceModelEntries(config, normalized) && !listConfiguredModels(refreshed).some((model) => model.id === selectedModelId)) {
        selectedModelId = String(refreshed.modelAlias ?? "").trim();
      }
      const modelConfig = configWithModelSelection(refreshed, selectedModelId, selectedReasoningEffort, {
        explicitReasoningEffort: true
      });
      const syncedState = syncIdleSessionConfig(active, input.sessionId, modelConfig);
      const state = syncedState ?? activeStateForSession(active, input.sessionId);
      const activeConfig = syncedState?.session.config ?? (state?.session.config ? configForStatusLists(state.session.config, modelConfig) : modelConfig);
      consumeGatewayDiscovery(gatewayDiscoveries, discovery);
      return {
        ok: true,
        configPath,
        configRevision: mutation.revision,
        saveTarget: normalized.saveTarget,
        sessionId: syncedState?.session.id,
        sessionStatus: state ? sessionStatusForConfigUpdate(state.session, modelConfig) : sessionStatusFromConfig(modelConfig),
        models: modelOptions(activeConfig),
        agentModelTiers: publicAgentModelTiers(activeConfig),
        visionAgent: publicVisionAgent(activeConfig),
        gatewayConfig: publicGatewayConfig(activeConfig),
        gatewayProfiles: publicGatewayProfiles(activeConfig)
      };
    },
    /** @param {Record<string, any>} input */
    async probeGateway(input = {}) {
      const configEnv = await resolveConfigEnv();
      const config = await loadConfig({ cwd: options.cwd, env: configEnv });
      const result = await probeGatewayConnection(input, config);
      if (!result.ok) return result;
      const discovery = rememberGatewayDiscovery({
        discoveries: gatewayDiscoveries,
        secret: gatewayDiscoverySecret,
        ttlMs: gatewayDiscoveryTtlMs,
        now: gatewayDiscoveryNow(),
        input,
        config,
        models: result.models
      });
      if (!discovery.ok) return discovery;
      return {
        ...result,
        models: clonePlainObject(discovery.catalog.models),
        discoveryToken: discovery.token,
        discoveryExpiresAt: new Date(discovery.expiresAt).toISOString()
      };
    },
    /**
     * @param {Record<string, any>} input
     * @param {{ signal?: AbortSignal }} [request]
     */
    async probeModelCapabilities(input = {}, request = {}) {
      const configEnv = await resolveConfigEnv();
      const config = await loadConfig({ cwd: options.cwd, env: configEnv });
      /** @type {GatewayDiscoveryCatalog} */
      let catalog = { ids: [], models: [] };
      if (String(input.gatewayDiscoveryToken ?? input.discoveryToken ?? "").trim()) {
        const existing = resolveGatewayDiscovery({
          discoveries: gatewayDiscoveries,
          secret: gatewayDiscoverySecret,
          now: gatewayDiscoveryNow(),
          input,
          config
        });
        if (!existing.ok) return existing;
        catalog = existing.catalog;
      }
      const result = /** @type {Record<string, any>} */ (
        await probeModelReasoningCapabilities(input, config, request.signal)
      );
      if (!result.ok || result.outcome !== "complete") return result;

      const mergedModels = mergeReasoningProbeIntoCatalog(catalog.models, result);
      const discovery = rememberGatewayDiscovery({
        discoveries: gatewayDiscoveries,
        secret: gatewayDiscoverySecret,
        ttlMs: gatewayDiscoveryTtlMs,
        now: gatewayDiscoveryNow(),
        input,
        config,
        models: mergedModels
      });
      if (!discovery.ok) return discovery;
      const mergedModel = discovery.catalog.models.find((model) => (
        String(model?.id ?? "").trim().toLowerCase() === String(result.modelId ?? "").trim().toLowerCase()
      ));
      return {
        ...result,
        reasoningEfforts: clonePlainObject(mergedModel?.reasoningEfforts ?? result.reasoningEfforts),
        defaultReasoningEffort: mergedModel?.defaultReasoningEffort ?? null,
        discoveryToken: discovery.token,
        discoveryExpiresAt: new Date(discovery.expiresAt).toISOString()
      };
    },
    /** @param {Record<string, any>} input */
    async deleteModelConfig(input = {}) {
      const locked = rerunWithSessionConfigLock(input, (lockedInput) => runtime.deleteModelConfig(lockedInput));
      if (locked) return locked;
      const configEnv = await resolveConfigEnv();
      const config = await loadConfig({ cwd: options.cwd, env: configEnv });
      const modelId = String(input.modelId ?? input.model ?? "").trim();
      if (!modelId) {
        return {
          ok: false,
          status: 400,
          error: "请选择要删除的模型",
          models: modelOptions(config),
          agentModelTiers: publicAgentModelTiers(config),
          visionAgent: publicVisionAgent(config),
          gatewayConfig: publicGatewayConfig(config),
          gatewayProfiles: publicGatewayProfiles(config)
        };
      }
      if (isConfigV2Enabled(config)) {
        const sessionId = String(input.sessionId ?? "").trim();
        const state = sessionId ? active.get(sessionId) : null;
        if (state?.running) {
          return {
            ok: false,
            status: 409,
            error: "任务运行中，结束或中断后再删除模型",
            models: modelOptions(state.session.config),
            gatewayConfig: publicGatewayConfig(state.session.config),
            gatewayProfiles: publicGatewayProfiles(state.session.config)
          };
        }
        let deleted;
        try {
          deleted = await deleteV2ProviderModel({
            cwd: options.cwd,
            env: configEnv,
            scope: input.scope ?? input.saveTarget,
            expectedRevision: input.expectedRevision,
            expectedCredentialsRevision: input.expectedCredentialsRevision ?? input.credentialsRevision,
            providerId: input.providerId ?? input.profileId ?? input.gatewayProfileId,
            modelId
          });
        } catch (error) {
          return dashboardV2ErrorResult(error);
        }
        const refreshed = await loadConfig({ cwd: options.cwd, env: await resolveConfigEnv() });
        const activeViews = reconcileActiveDashboardSessionsAfterV2Mutation(active, refreshed);
        const sessionView = sessionId
          ? activeViews.get(sessionId) ?? await refreshDashboardSessionAfterV2Mutation({
              active,
              cwd: options.cwd,
              env: runtimeEnv,
              sessionId,
              config: refreshed
            })
          : null;
        const reconciledSelection = reconcileDashboardRuntimeSelections(
          clientModelSelections,
          refreshed,
          { providerId: selectedProviderId, modelId: selectedModelId, reasoningEffort: selectedReasoningEffort }
        );
        selectedProviderId = reconciledSelection.providerId;
        selectedModelId = reconciledSelection.modelId;
        selectedReasoningEffort = reconciledSelection.reasoningEffort;
        let modelConfig;
        if (sessionId) {
          modelConfig = sessionView?.config ?? refreshed;
        } else {
          const previousSelection = dashboardRuntimeSelection(
            clientModelSelections,
            input.clientId,
            { providerId: selectedProviderId, modelId: selectedModelId, reasoningEffort: selectedReasoningEffort }
          );
          modelConfig = configForDashboardSelection(refreshed, previousSelection);
          selectedProviderId = activeGatewayProfileId(modelConfig);
          selectedModelId = String(modelConfig.modelAlias ?? "").trim();
          selectedReasoningEffort = String(modelConfig.reasoningEffort ?? "").trim();
          rememberDashboardRuntimeSelection(clientModelSelections, input.clientId, {
            providerId: selectedProviderId,
            modelId: selectedModelId,
            reasoningEffort: selectedReasoningEffort
          });
        }
        if (sessionView?.state) {
          appendDashboardEvent(sessionView.state, {
            type: "model_deleted",
            id: eventId("model-delete"),
            model: modelId,
            sessionStatus: sessionView.sessionStatus,
            at: new Date().toISOString()
          });
        }
        const activeConfig = modelConfig;
        const configV2 = publicV2ConfigState(refreshed);
        return {
          ...deleted,
          deletedFrom: deleted.scope,
          sessionId: sessionId || undefined,
          sessionStatus: sessionView?.sessionStatus ?? sessionStatusFromConfig(modelConfig),
          models: modelOptions(activeConfig),
          agentModelTiers: publicAgentModelTiers(activeConfig),
          visionAgent: publicVisionAgent(activeConfig),
          gatewayConfig: publicGatewayConfig(activeConfig),
          gatewayProfiles: publicGatewayProfiles(activeConfig),
          configV2,
          configRevisions: configV2.revisions
        };
      }
      const profileId = String(input.profileId ?? input.gatewayProfileId ?? activeGatewayProfileId(config)).trim();
      const profile = gatewayProfilesFromConfig(config).find((item) => item.id === profileId);
      if (!profile || !profile.models.some((model) => model.id === modelId)) {
        return {
          ok: false,
          status: 404,
          error: "模型配置不存在",
          models: modelOptions(config),
          agentModelTiers: publicAgentModelTiers(config),
          visionAgent: publicVisionAgent(config),
          gatewayConfig: publicGatewayConfig(config),
          gatewayProfiles: publicGatewayProfiles(config)
        };
      }
      const ownerScope = String(gatewayProfileModelSource(config, profile, modelId)?.ownerScope ?? "").trim();
      if (!["project", "global"].includes(ownerScope)) {
        return {
          ok: false,
          status: 409,
          error: "该模型由环境或内置配置提供，无法从 Dashboard 删除",
          models: modelOptions(config),
          agentModelTiers: publicAgentModelTiers(config),
          visionAgent: publicVisionAgent(config),
          gatewayConfig: publicGatewayConfig(config),
          gatewayProfiles: publicGatewayProfiles(config)
        };
      }
      const requestedScope = String(input.saveTarget ?? input.scope ?? "").trim().toLowerCase();
      if (["project", "global"].includes(requestedScope) && requestedScope !== ownerScope) {
        return { ok: false, status: 400, error: "模型删除范围与网关档案来源不一致" };
      }
      const sessionId = String(input.sessionId ?? "").trim();
      const state = sessionId ? active.get(sessionId) : null;
      if (state?.running) {
        return {
          ok: false,
          status: 409,
          error: "任务运行中，结束或中断后再删除模型",
          models: modelOptions(state.session.config),
          agentModelTiers: publicAgentModelTiers(state.session.config),
          visionAgent: publicVisionAgent(state.session.config),
          gatewayConfig: publicGatewayConfig(state.session.config),
          gatewayProfiles: publicGatewayProfiles(state.session.config)
        };
      }
      const localPath = localProjectConfigPath(options.cwd);
      const globalPath = globalConfigPath(configEnv);
      const targetPath = ownerScope === "global" ? globalPath : localPath;
      const global = await readJsonConfig(globalPath);
      const inheritedProfile = ownerScope === "project"
        ? gatewayProfileForEndpoint(
            gatewayProfilesOwnedByConfig(global),
            profile.gatewayProtocol,
            profile.gatewayUrl
          )
        : null;
      const inheritedFallback = Boolean(inheritedProfile);
      let deletion = buildOwnedDeleteModelConfig(
        await readJsonConfig(targetPath),
        config,
        profileId,
        modelId,
        { inheritedFallback, inheritedProfileId: inheritedProfile?.id }
      );
      if (!deletion.ok) {
        return {
          ok: false,
          status: deletion.status ?? 400,
          error: deletion.error,
          models: modelOptions(config),
          agentModelTiers: publicAgentModelTiers(config),
          visionAgent: publicVisionAgent(config),
          gatewayConfig: publicGatewayConfig(config),
          gatewayProfiles: publicGatewayProfiles(config)
        };
      }
      const mutation = await mutateDashboardConfig(targetPath, async (stored) => {
        const latestConfig = await loadConfig({ cwd: options.cwd, env: await resolveConfigEnv() });
        deletion = buildOwnedDeleteModelConfig(stored, latestConfig, profileId, modelId, {
          inheritedFallback,
          inheritedProfileId: inheritedProfile?.id
        });
        if (!deletion.ok) {
          throw dashboardConfigResultError(deletion);
        }
        return deletion.config;
      });
      if (!mutation.ok) {
        return mutation;
      }
      if (ownerScope === "global" && deletion.removedProfile === true
        && path.resolve(localPath).toLowerCase() !== path.resolve(globalPath).toLowerCase()) {
        await mutateDashboardConfig(
          localPath,
          (local) => clearDanglingGatewayProfileSelection(local, deletion.ownerProfileId ?? profileId)
        );
      }
      const refreshed = await loadConfig({ cwd: options.cwd, env: await resolveConfigEnv() });
      const clearedGateway = deletion.clearedGateway === true && !activeGatewayProfileId(refreshed);
      if (selectedModelId === modelId || !listConfiguredModels(refreshed).some((model) => model.id === selectedModelId)) {
        selectedModelId = String(refreshed.modelAlias ?? "").trim();
        selectedReasoningEffort = defaultReasoningEffortForConfig(refreshed, selectedModelId);
      }
      if (state) {
        applySessionConfig(state.session, refreshed);
        state.persisted = false;
        appendDashboardEvent(state, {
          type: "model_deleted",
          id: eventId("model-delete"),
          model: modelId,
          sessionStatus: sessionStatusSummary(state.session),
          at: new Date().toISOString()
        });
      }
      const modelConfig = configWithModelSelection(refreshed, selectedModelId, selectedReasoningEffort, {
        explicitReasoningEffort: true
      });
      const activeConfig = state?.session.config ?? modelConfig;
      return {
        ok: true,
        deletedModel: modelId,
        deletedFrom: ownerScope,
        clearedGateway,
        restoredInherited: deletion.restoredInherited === true,
        configPath: targetPath,
        configRevision: mutation.revision,
        sessionId: state?.session.id,
        sessionStatus: state ? sessionStatusSummary(state.session) : sessionStatusFromConfig(modelConfig),
        models: modelOptions(activeConfig),
        agentModelTiers: publicAgentModelTiers(activeConfig),
        visionAgent: publicVisionAgent(activeConfig),
        gatewayConfig: publicGatewayConfig(activeConfig),
        gatewayProfiles: publicGatewayProfiles(activeConfig)
      };
    },
    /** @param {Record<string, any>} input */
    async deleteGatewayProfile(input = {}) {
      const locked = rerunWithSessionConfigLock(input, (lockedInput) => runtime.deleteGatewayProfile(lockedInput));
      if (locked) return locked;
      const configEnv = await resolveConfigEnv();
      const profileId = String(input.profileId ?? input.id ?? "").trim();
      if (!profileId) {
        return { ok: false, status: 400, error: "请选择要删除的网关" };
      }
      const sessionId = String(input.sessionId ?? "").trim();
      const state = sessionId ? active.get(sessionId) : null;
      if (state?.running) {
        return {
          ok: false,
          status: 409,
          error: "任务运行中，结束或中断后再删除网关",
          models: modelOptions(state.session.config),
          gatewayConfig: publicGatewayConfig(state.session.config),
          gatewayProfiles: publicGatewayProfiles(state.session.config)
        };
      }
      const config = await loadConfig({ cwd: options.cwd, env: configEnv });
      if (isConfigV2Enabled(config)) {
        let deleted;
        try {
          deleted = await deleteV2Provider({
            cwd: options.cwd,
            env: configEnv,
            scope: input.scope ?? input.saveTarget,
            expectedRevision: input.expectedRevision,
            expectedCredentialsRevision: input.expectedCredentialsRevision ?? input.credentialsRevision,
            providerId: input.providerId ?? profileId
          });
        } catch (error) {
          return dashboardV2ErrorResult(error);
        }
        const refreshed = await loadConfig({ cwd: options.cwd, env: await resolveConfigEnv() });
        const activeViews = reconcileActiveDashboardSessionsAfterV2Mutation(active, refreshed);
        const sessionView = sessionId
          ? activeViews.get(sessionId) ?? await refreshDashboardSessionAfterV2Mutation({
              active,
              cwd: options.cwd,
              env: runtimeEnv,
              sessionId,
              config: refreshed
            })
          : null;
        const reconciledSelection = reconcileDashboardRuntimeSelections(
          clientModelSelections,
          refreshed,
          { providerId: selectedProviderId, modelId: selectedModelId, reasoningEffort: selectedReasoningEffort }
        );
        selectedProviderId = reconciledSelection.providerId;
        selectedModelId = reconciledSelection.modelId;
        selectedReasoningEffort = reconciledSelection.reasoningEffort;
        let modelConfig;
        if (sessionId) {
          modelConfig = sessionView?.config ?? refreshed;
        } else {
          const previousSelection = dashboardRuntimeSelection(
            clientModelSelections,
            input.clientId,
            { providerId: selectedProviderId, modelId: selectedModelId, reasoningEffort: selectedReasoningEffort }
          );
          modelConfig = configForDashboardSelection(refreshed, previousSelection);
          selectedProviderId = activeGatewayProfileId(modelConfig);
          selectedModelId = String(modelConfig.modelAlias ?? "").trim();
          selectedReasoningEffort = String(modelConfig.reasoningEffort ?? "").trim();
          rememberDashboardRuntimeSelection(clientModelSelections, input.clientId, {
            providerId: selectedProviderId,
            modelId: selectedModelId,
            reasoningEffort: selectedReasoningEffort
          });
        }
        const activeConfig = modelConfig;
        const configV2 = publicV2ConfigState(refreshed);
        return {
          ...deleted,
          deletedProfile: profileId,
          deletedFrom: deleted.scope,
          deletedFromScopes: [deleted.scope],
          sessionId: sessionId || undefined,
          sessionStatus: sessionView?.sessionStatus ?? sessionStatusFromConfig(modelConfig),
          models: modelOptions(activeConfig),
          agentModelTiers: publicAgentModelTiers(activeConfig),
          visionAgent: publicVisionAgent(activeConfig),
          gatewayConfig: publicGatewayConfig(activeConfig),
          gatewayProfiles: publicGatewayProfiles(activeConfig),
          configV2,
          configRevisions: configV2.revisions
        };
      }
      const localPath = localProjectConfigPath(options.cwd);
      const globalPath = globalConfigPath(configEnv);
      const local = await readJsonConfig(localPath);
      const global = await readJsonConfig(globalPath);
      const ownerScope = String(gatewayProfileOwner(config, profileId)?.type ?? "").trim();
      const targets = gatewayProfileDeleteTargets({ local, localPath, global, globalPath, profileId, ownerScope });
      if (targets.length === 0) {
        return { ok: false, status: 409, error: "该网关由外部环境提供，无法从 Dashboard 删除" };
      }
      const wasActive = activeGatewayProfileId(config) === profileId;
      const effectiveProfile = gatewayProfilesFromConfig(config).find((profile) => profile.id === profileId);
      const mutations = /** @type {Array<Record<string, any>>} */ ([]);
      for (const target of targets) {
        const inheritedProfile = target.scope === "project" && effectiveProfile
          ? gatewayProfileForEndpoint(
              gatewayProfilesOwnedByConfig(global),
              effectiveProfile.gatewayProtocol,
              effectiveProfile.gatewayUrl
            )
          : null;
        const inheritedFallback = Boolean(inheritedProfile);
        const deletionOptions = {
          inheritedFallback,
          inheritedProfileId: inheritedProfile?.id
        };
        let deletion = buildGatewayProfileDeleteConfig(target.config, target.config, profileId, deletionOptions);
        if (!deletion.ok) {
          return { ok: false, status: 404, error: deletion.error };
        }
        const mutation = await mutateDashboardConfig(target.path, async (stored) => {
          deletion = buildGatewayProfileDeleteConfig(stored, stored, profileId, deletionOptions);
          if (!deletion.ok) {
            throw dashboardConfigResultError(deletion);
          }
          return deletion.config;
        });
        if (!mutation.ok) {
          return mutation;
        }
        mutations.push({ ...target, revision: mutation.revision });
      }
      const refreshed = await loadConfig({ cwd: options.cwd, env: await resolveConfigEnv() });
      const clearedGateway = wasActive && !activeGatewayProfileId(refreshed);
      selectedModelId = clearedGateway ? "" : String(refreshed.modelAlias ?? "").trim();
      if (state) {
        applySessionConfig(state.session, refreshed);
        state.persisted = false;
      }
      return {
        ok: true,
        deletedProfile: profileId,
        deletedFrom: mutations.map((mutation) => mutation.scope).join("+"),
        deletedFromScopes: mutations.map((mutation) => mutation.scope),
        clearedGateway,
        configPath: mutations[0].path,
        configPaths: mutations.map((mutation) => mutation.path),
        configRevision: mutations.at(-1)?.revision,
        sessionId: state?.session.id,
        sessionStatus: state ? sessionStatusSummary(state.session) : sessionStatusFromConfig(refreshed),
        models: modelOptions(state?.session.config ?? refreshed),
        agentModelTiers: publicAgentModelTiers(state?.session.config ?? refreshed),
        visionAgent: publicVisionAgent(state?.session.config ?? refreshed),
        gatewayConfig: publicGatewayConfig(state?.session.config ?? refreshed),
        gatewayProfiles: publicGatewayProfiles(state?.session.config ?? refreshed)
      };
    },
    /** @param {Record<string, any>} input */
    async switchGatewayProfile(input = {}) {
      const locked = rerunWithSessionConfigLock(input, (lockedInput) => runtime.switchGatewayProfile(lockedInput));
      if (locked) return locked;
      const configEnv = await resolveConfigEnv();
      const profileId = String(input.profileId ?? input.id ?? "").trim();
      if (!profileId) {
        return { ok: false, status: 400, error: "请选择要切换的网关" };
      }
      const sessionId = String(input.sessionId ?? "").trim();
      const state = sessionId ? active.get(sessionId) : null;
      if (state?.running) {
        return {
          ok: false,
          status: 409,
          error: "任务运行中，结束或中断后再切换网关",
          models: modelOptions(state.session.config),
          agentModelTiers: publicAgentModelTiers(state.session.config),
          visionAgent: publicVisionAgent(state.session.config),
          gatewayConfig: publicGatewayConfig(state.session.config),
          gatewayProfiles: publicGatewayProfiles(state.session.config)
        };
      }
      const config = await loadConfig({ cwd: options.cwd, env: configEnv });
      if (isConfigV2Enabled(config)) {
        const profile = gatewayProfilesFromConfig(config).find((item) => item.id === profileId);
        if (!profile) {
          return { ok: false, status: 404, error: "模型来源不存在" };
        }
        const modelId = String(input.modelId ?? profile.modelAlias ?? profile.models?.[0]?.id ?? "").trim();
        return runtime.switchModel({
          ...input,
          providerId: profileId,
          modelId,
          reasoningEffort: input.reasoningEffort
        });
      }
      const localPath = localProjectConfigPath(options.cwd);
      let nextLocal = buildGatewayProfileSwitchConfig(await readJsonConfig(localPath), config, profileId);
      if (!nextLocal.ok) {
        return {
          ok: false,
          status: nextLocal.status ?? 404,
          error: nextLocal.error,
          models: modelOptions(config),
          agentModelTiers: publicAgentModelTiers(config),
          visionAgent: publicVisionAgent(config),
          gatewayConfig: publicGatewayConfig(config),
          gatewayProfiles: publicGatewayProfiles(config)
        };
      }
      const mutation = await mutateDashboardConfig(localPath, async (local) => {
        const latestConfig = await loadConfig({ cwd: options.cwd, env: await resolveConfigEnv() });
        nextLocal = buildGatewayProfileSwitchConfig(local, latestConfig, profileId);
        if (!nextLocal.ok) {
          throw dashboardConfigResultError(nextLocal);
        }
        return nextLocal.config;
      });
      if (!mutation.ok) {
        return mutation;
      }
      const refreshed = await loadConfig({ cwd: options.cwd, env: await resolveConfigEnv() });
      selectedModelId = String(refreshed.modelAlias ?? "").trim();
      selectedReasoningEffort = defaultReasoningEffortForConfig(refreshed, selectedModelId);
      if (state) {
        applySessionConfig(state.session, configWithModelSelection(refreshed, selectedModelId, selectedReasoningEffort, {
          explicitReasoningEffort: true
        }));
        state.persisted = false;
        appendDashboardEvent(state, {
          type: "gateway_profile_switched",
          id: eventId("gateway-profile"),
          profileId,
          sessionStatus: sessionStatusSummary(state.session),
          at: new Date().toISOString()
        });
      }
      const modelConfig = configWithModelSelection(refreshed, selectedModelId, selectedReasoningEffort, {
        explicitReasoningEffort: true
      });
      const activeConfig = state?.session.config ?? modelConfig;
      return {
        ok: true,
        configRevision: mutation.revision,
        sessionId: state?.session.id,
        sessionStatus: state ? sessionStatusSummary(state.session) : sessionStatusFromConfig(modelConfig),
        models: modelOptions(activeConfig),
        agentModelTiers: publicAgentModelTiers(activeConfig),
        visionAgent: publicVisionAgent(activeConfig),
        gatewayConfig: publicGatewayConfig(activeConfig),
        gatewayProfiles: publicGatewayProfiles(activeConfig)
      };
    },
    /** @param {Record<string, any>} input */
    async saveDefaultModelSelection(input = {}) {
      const locked = rerunWithSessionConfigLock(input, (lockedInput) => runtime.saveDefaultModelSelection(lockedInput));
      if (locked) return locked;
      const configEnv = await resolveConfigEnv();
      const config = await loadConfig({ cwd: options.cwd, env: configEnv });
      if (!isConfigV2Enabled(config)) {
        return {
          ok: false,
          status: 409,
          code: "CONFIG_V2_REQUIRED",
          error: "默认模型设置需要先完成 Config V2 迁移"
        };
      }
      const sessionId = String(input.sessionId ?? "").trim();
      const state = sessionId ? active.get(sessionId) : null;
      if (state?.running) {
        return { ok: false, status: 409, error: "任务运行中，结束或中断后再修改默认模型" };
      }
      let saved;
      try {
        saved = await saveV2DefaultModel({
          cwd: options.cwd,
          env: configEnv,
          scope: input.scope ?? input.saveTarget,
          expectedRevision: input.expectedRevision,
          providerId: input.providerId ?? input.profileId,
          modelId: input.modelId ?? input.model,
          reasoningEffort: input.reasoningEffort
        });
      } catch (error) {
        return dashboardV2ErrorResult(error);
      }
      const refreshed = await loadConfig({ cwd: options.cwd, env: await resolveConfigEnv() });
      const sessionView = sessionId
        ? await refreshDashboardSessionAfterV2Mutation({
            active,
            cwd: options.cwd,
            env: runtimeEnv,
            sessionId,
            config: refreshed
          })
        : null;
      const modelConfig = sessionView?.config ?? configForDashboardSelection(refreshed, dashboardRuntimeSelection(
          clientModelSelections,
          input.clientId,
          { providerId: selectedProviderId, modelId: selectedModelId, reasoningEffort: selectedReasoningEffort }
        ));
      const configV2 = publicV2ConfigState(refreshed);
      return {
        ...saved,
        sessionId: sessionId || undefined,
        sessionStatus: sessionView?.sessionStatus ?? sessionStatusFromConfig(modelConfig),
        models: modelOptions(modelConfig),
        gatewayConfig: publicGatewayConfig(modelConfig),
        gatewayProfiles: publicGatewayProfiles(modelConfig),
        configV2,
        configRevisions: configV2.revisions
      };
    },
    async trustStatus() {
      const configEnv = await resolveConfigEnv();
      return {
        ok: true,
        trust: await resolveDashboardTrust({ cwd: options.cwd, env: configEnv, processTrusted })
      };
    },
    async trustWorkspace() {
      const configEnv = await resolveConfigEnv();
      await saveWorkspaceTrust({
        cwd: options.cwd,
        env: runtimeEnv,
        version: await getAntCodeVersion()
      });
      processTrusted = true;
      return {
        ok: true,
        trust: await resolveDashboardTrust({ cwd: options.cwd, env: configEnv, processTrusted })
      };
    },
    async listSessionRecords() {
      const configEnv = await resolveConfigEnv();
      const config = await loadConfig({ cwd: options.cwd, env: configEnv });
      await maintainSessionRetention(config);
      const store = createSessionStore({ cwd: options.cwd, transcript: config.transcript, env: runtimeEnv });
      const records = await store.listSessionRecords();
      const persisted = records.map((record) => ({
        id: record.id,
        title: record.title || record.prompt || "未命名任务",
        status: record.status ?? "unknown",
        model: record.model ?? "",
        modifiedAt: record.modifiedAt,
        finishedAt: record.finishedAt ?? null,
        transcriptMessages: record.transcriptMessages ?? 0,
        readable: record.readable !== false,
        encrypted: record.encrypted === true,
        goalStatus: sessionRecordGoalStatus(record)
      }));
      const byId = new Map(persisted.map((record) => [record.id, record]));
      const activeStates = [...active.values()];
      const groupSnapshots = await loadDashboardGroupSnapshots(activeStates);
      for (const state of activeStates) {
        const snapshot = await buildBackgroundSubagentSnapshot(state, {
          groups: groupSnapshots.get(path.resolve(state.session.cwd)) ?? []
        });
        const activeRecord = activeSessionRecord(state, byId.get(state.session.id), snapshot);
        byId.set(activeRecord.id, activeRecord);
      }
      return Array.from(byId.values()).sort(compareSessionRecords);
    },
    async readSession(selector) {
      const configEnv = await resolveConfigEnv();
      const config = await loadConfig({ cwd: options.cwd, env: configEnv });
      const store = createSessionStore({ cwd: options.cwd, transcript: config.transcript, env: runtimeEnv });
      const activeState = active.get(String(selector ?? ""));
      const result = await store.readMetadata(selector);
      if (!result.ok && !activeState) {
        return result;
      }
      const metadata = result.ok ? result.metadata ?? {} : {};
      const session = activeState?.session ?? {};
      const storedPage = result.ok
        ? await readStoredTranscriptPage(store, metadata)
        : createTranscriptPageResult([]);
      if (!storedPage.ok) {
        return transcriptPageReadError(storedPage);
      }
      const transcriptPage = activeState
        ? mergeActiveTranscriptPage(storedPage, activeState)
        : storedPage;
      const transcript = transcriptPage.messages;
      const finalText = activeState?.finalOutput || assistantTranscriptText(transcript);
      const snapshotState = activeState ?? createSnapshotReadState(metadata, options.cwd);
      const backgroundSnapshot = snapshotState ? await buildBackgroundSubagentSnapshot(snapshotState) : null;
      return {
        ok: true,
        session: {
          id: activeState?.session.id ?? metadata.id,
          title: session.title || metadata.title || metadata.prompt || "未命名任务",
          status: activeState ? activeDashboardStatus(activeState) : metadata.status ?? "unknown",
          cwd: session.cwd ?? metadata.cwd ?? options.cwd,
          prompt: session.prompt ?? metadata.prompt ?? "",
          outputBytes: metadata.outputBytes ?? 0,
          model: session.model ?? metadata.model ?? "",
          context: metadata.context ?? null,
          active: Boolean(activeState),
          running: activeState?.running === true,
          eventCursor: activeState ? activeReplayCursor(activeState) : null,
          sessionStatus: activeState ? sessionStatusSummary(activeState.session) : sessionStatusFromMetadata(metadata, config),
          permission: permissionModeSummary(activeState?.session ?? metadata),
          goal: publicGoalSnapshot(activeState?.session?.goal ?? /** @type {Record<string, any>} */ (metadata).goal, activeState?.session?.config),
          transcript,
          transcriptPage: transcriptPage.summary,
          failure: persistedSessionFailure(metadata),
          files: collectSessionFiles({
            cwd: session.cwd ?? metadata.cwd ?? options.cwd,
            workflow: session.workflow ?? metadata.workflow ?? null
          }, finalText),
          workflow: session.workflow ?? metadata.workflow ?? null,
          backgroundSnapshot: backgroundSnapshot ? publicBackgroundSnapshot(backgroundSnapshot) : null,
          modifiedAt: result.modifiedAt ?? null,
          finishedAt: metadata.finishedAt ?? null
        }
      };
    },
    async readTranscriptPage(input = {}) {
      const configEnv = await resolveConfigEnv();
      const sessionId = String(input.sessionId ?? input.id ?? "").trim();
      if (!sessionId) {
        return { ok: false, status: 400, error: "缺少会话 ID" };
      }
      const config = await loadConfig({ cwd: options.cwd, env: configEnv });
      const store = createSessionStore({ cwd: options.cwd, transcript: config.transcript, env: runtimeEnv });
      const activeState = active.get(sessionId);
      const result = await store.readMetadata(sessionId);
      if (!result.ok && !activeState) {
        return { ok: false, status: 404, error: result.error?.message ?? "会话不存在" };
      }
      const metadata = result.ok ? result.metadata ?? {} : {};
      const storedPage = result.ok
        ? await readStoredTranscriptPage(store, metadata, { before: input.before, limit: input.limit })
        : createTranscriptPageResult([], { before: input.before, limit: input.limit });
      if (!storedPage.ok) {
        return transcriptPageReadError(storedPage);
      }
      const page = activeState && !hasTranscriptCursor(input.before)
        ? mergeActiveTranscriptPage(storedPage, activeState, { limit: input.limit })
        : storedPage;
      return {
        ok: true,
        sessionId: activeState?.session.id ?? metadata.id ?? sessionId,
        transcript: page.messages,
        transcriptPage: page.summary
      };
    },
    async deleteSession(input = {}) {
      return deleteDashboardSession({
        active,
        sessionMutationLocks,
        activeCapacityLocks,
        activePolicy,
        cwd: options.cwd,
        runtimeEnv,
        resolveConfigEnv
      }, input);
    },
    async startTurn(input = {}) {
      if (shuttingDown) {
        return { ok: false, status: 503, code: "DASHBOARD_SHUTTING_DOWN", error: "Dashboard 正在关闭，不能再提交新任务" };
      }
      return withIdempotentTurnRequest(turnRequests, input, () => startDashboardTurn({
        active,
        sessionMutationLocks,
        activeCapacityLocks,
        activePolicy,
        cwd: options.cwd,
        runtimeEnv,
        resolveConfigEnv,
        processTrusted,
        runtimeSelection: dashboardRuntimeSelection(
          clientModelSelections,
          input.clientId,
          { providerId: selectedProviderId, modelId: selectedModelId, reasoningEffort: selectedReasoningEffort }
        ),
        runTurn: options.runTurn ?? runSessionTurn
      }, input));
    },
    async applyGoal(/** @type {Record<string, any>} */ input = {}) {
      return applyDashboardGoal({
        active,
        sessionMutationLocks,
        activeCapacityLocks,
        activePolicy,
        cwd: options.cwd,
        runtimeEnv,
        resolveConfigEnv,
        processTrusted,
        runtimeSelection: dashboardRuntimeSelection(
          clientModelSelections,
          input.clientId,
          { providerId: selectedProviderId, modelId: selectedModelId, reasoningEffort: selectedReasoningEffort }
        ),
        runTurn: options.runTurn ?? runSessionTurn
      }, input);
    },
    interruptTurn(sessionId, reason = "user") {
      const normalized = normalizeMutationSessionId(sessionId);
      if (!normalized.ok) {
        return normalized;
      }
      if (sessionMutationLocks.has(normalized.sessionId)) {
        return sessionMutationBusyResult(normalized.sessionId);
      }
      const state = active.get(normalized.sessionId);
      if (!state) {
        return { ok: false, status: 404, error: "会话不存在" };
      }
      if (!state.running) {
        return { ok: false, status: 409, error: "当前没有正在运行的任务" };
      }
      if (state.quarantinedTurnId) {
        return quarantinedSessionResult(state);
      }
      requestTurnInterrupt(state, reason);
      return {
        ok: true,
        sessionId: state.session.id,
        interrupting: true,
        queue: queueSnapshot(state),
        sessionStatus: sessionStatusSummary(state.session)
      };
    },
    cancelQueuedTurn(input = {}) {
      const normalized = normalizeMutationSessionId(input.sessionId);
      if (!normalized.ok) {
        return normalized;
      }
      if (sessionMutationLocks.has(normalized.sessionId)) {
        return sessionMutationBusyResult(normalized.sessionId);
      }
      const state = active.get(normalized.sessionId);
      if (!state) {
        return { ok: false, status: 404, error: "会话不存在" };
      }
      const queueItemId = String(input.queueItemId ?? "").trim();
      if (!queueItemId) {
        return { ok: false, status: 400, error: "请选择要取消的排队消息" };
      }
      const queueItemIndex = state.queuedPrompts.findIndex((item) => item.id === queueItemId);
      if (queueItemIndex < 0) {
        return { ok: false, status: 404, error: "排队消息不存在或已被处理" };
      }
      const [removed] = state.queuedPrompts.splice(queueItemIndex, 1);
      const publicItem = publicQueueItem(removed);
      appendDashboardEvent(state, {
        type: "queue_item_cancelled",
        id: eventId("queue-cancelled"),
        item: publicItem,
        queue: queueSnapshot(state),
        queueLength: state.queuedPrompts.length,
        running: state.running,
        sessionStatus: sessionStatusSummary(state.session),
        changeStats: { ...state.turnChangeStats },
        at: new Date().toISOString()
      });
      appendQueueUpdated(state);
      return {
        ok: true,
        sessionId: state.session.id,
        item: publicItem,
        queue: queueSnapshot(state),
        queueLength: state.queuedPrompts.length,
        sessionStatus: sessionStatusSummary(state.session)
      };
    },
    async cancelBackgroundSubagent(input = {}) {
      const sessionId = String(input.sessionId ?? "").trim();
      const state = active.get(sessionId);
      if (!state) {
        return { ok: false, status: 404, error: "会话不存在" };
      }
      const groupId = String(input.groupId ?? "").trim();
      const taskId = String(input.taskId ?? "").trim();
      if (!groupId && !taskId) {
        return { ok: false, status: 400, error: "请选择要回收的子智能体任务" };
      }
      const groupStore = createAgentTaskGroupStore({ cwd: state.session.cwd });
      const taskStore = createAgentTaskStore({ cwd: state.session.cwd });
      const groupResult = groupId ? await groupStore.readGroup(groupId) : null;
      if (groupId && !groupResult?.ok) {
        return { ok: false, status: 404, error: "子智能体任务组不存在或已结束" };
      }
      if (groupResult?.ok && groupResult.group.parentSessionId !== state.session.id) {
        return { ok: false, status: 403, code: "BACKGROUND_TASK_OWNERSHIP_MISMATCH", error: "子智能体任务组不属于该会话" };
      }
      const targetTaskIds = groupResult?.ok
        ? (taskId ? groupResult.group.taskIds.filter((id) => id === taskId) : groupResult.group.taskIds)
        : [taskId];
      if (targetTaskIds.length === 0) {
        return { ok: false, status: 404, error: "子智能体任务不存在或不属于该任务组" };
      }
      const targetTasks = [];
      for (const id of targetTaskIds) {
        const read = await taskStore.readTask(id);
        if (!read.ok) {
          return { ok: false, status: 404, error: "子智能体任务不存在" };
        }
        if (
          read.task.parentSessionId !== state.session.id
          || (groupId && read.task.groupId !== groupId)
        ) {
          return { ok: false, status: 403, code: "BACKGROUND_TASK_OWNERSHIP_MISMATCH", error: "子智能体任务不属于该会话或任务组" };
        }
        targetTasks.push(read.task);
      }
      const aborted = cancelBackgroundAgentTasks({
        parentSessionId: state.session.id,
        groupId: groupId || null,
        taskId: taskId || null
      });
      const abortedTaskIds = new Set(aborted.filter((task) => task.aborted === true).map((task) => task.taskId));
      const cancellableTargets = targetTasks.filter((task) => !TERMINAL_TASK_STATUSES.has(String(task.status)));
      if (cancellableTargets.length > 0 && !cancellableTargets.some((task) => abortedTaskIds.has(task.id))) {
        return {
          ok: false,
          status: 409,
          code: "BACKGROUND_CONTROLLER_NOT_FOUND",
          error: "未找到可确认中止的后台子智能体 controller，任务状态未被修改"
        };
      }
      const now = new Date().toISOString();
      const updatedTasks = [];
      for (const task of targetTasks) {
        if (TERMINAL_TASK_STATUSES.has(String(task.status)) || !abortedTaskIds.has(task.id)) {
          continue;
        }
        const updated = await taskStore.updateTask(task.id, {
          status: "interrupted",
          cancelRequestedAt: now,
          finishedAt: now,
          heartbeatAt: now,
          progressAt: now,
          latestProgress: "Dashboard 已请求回收后台子智能体；当前进程 controller 已中止。"
        });
        if (updated.ok) {
          updatedTasks.push(updated.task);
        }
      }
      let group = groupResult?.group ?? null;
      if (groupId && group) {
        const tasks = await readDashboardGroupTasks(taskStore, group.taskIds);
        const summary = summarizeGroupStatus(tasks, { waitFor: group.waitFor });
        const patch = {
          status: summary.status,
          latestProgress: summary.summary,
          summary: summary.summary,
          metadata: {
            ...(group.metadata ?? {}),
            cancelledFromDashboardAt: now
          }
        };
        if (summary.completed) {
          patch.completedAt = now;
        }
        const updatedGroup = await groupStore.updateGroup(groupId, patch);
        group = updatedGroup.ok ? updatedGroup.group : group;
      }
      appendDashboardEvent(state, {
        type: "background_subagent_cancelled",
        id: eventId("background-subagent-cancelled"),
        groupId: groupId || null,
        taskId: taskId || null,
        abortedTaskIds: [...abortedTaskIds],
        updatedTaskIds: updatedTasks.map((task) => task.id),
        sessionStatus: sessionStatusSummary(state.session),
        at: now
      });
      await appendBackgroundSubagentSnapshot(state);
      return {
        ok: true,
        sessionId: state.session.id,
        groupId: groupId || group?.id || null,
        taskId: taskId || null,
        abortedTaskIds: [...abortedTaskIds],
        updatedTaskIds: updatedTasks.map((task) => task.id),
        sessionStatus: sessionStatusSummary(state.session)
      };
    },
    async cancelBackgroundTerminal(input = {}) {
      const sessionId = String(input.sessionId ?? "").trim();
      const state = active.get(sessionId);
      if (!state) {
        return { ok: false, status: 404, error: "会话不存在" };
      }
      const taskId = String(input.taskId ?? "").trim();
      if (!taskId) {
        return { ok: false, status: 400, error: "请选择要回收的后台终端任务" };
      }
      const owned = listBackgroundTerminalTasks({
        parentSessionId: state.session.id,
        cwd: state.session.cwd,
        taskId
      }).filter((task) => (
        (task.status === "starting" || task.status === "running" || task.status === "cancelling")
        && task.cwd
        && path.resolve(task.cwd) === path.resolve(state.session.cwd)
      ));
      if (owned.length === 0) {
        return {
          ok: false,
          status: 404,
          code: "BACKGROUND_TERMINAL_NOT_ACTIVE",
          error: "后台终端任务不存在、不属于该会话或已结束"
        };
      }
      const cancellationResults = await cancelBackgroundTerminalTasks({
        parentSessionId: state.session.id,
        cwd: state.session.cwd,
        taskId
      });
      const cancelled = cancellationResults.filter((task) => task.status === "cancelled" && task.cancellationConfirmed === true);
      if (cancelled.length === 0) {
        return {
          ok: false,
          status: 409,
          code: "BACKGROUND_TERMINAL_CANCEL_UNCONFIRMED",
          error: cancellationResults[0]?.cancelError || "后台终端任务未确认退出，未标记为已取消"
        };
      }
      appendDashboardEvent(state, {
        type: "background_terminal_cancelled",
        id: eventId("background-terminal-cancelled"),
        taskId,
        cancelledTaskIds: cancelled.map((task) => task.taskId),
        sessionStatus: sessionStatusSummary(state.session),
        at: new Date().toISOString()
      });
      await appendBackgroundSubagentSnapshot(state);
      return {
        ok: true,
        sessionId: state.session.id,
        taskId,
        cancelledTaskIds: cancelled.map((task) => task.taskId),
        sessionStatus: sessionStatusSummary(state.session)
      };
    },
    guideTurn(input) {
      const normalized = normalizeMutationSessionId(input.sessionId);
      if (!normalized.ok) {
        return normalized;
      }
      if (sessionMutationLocks.has(normalized.sessionId)) {
        return sessionMutationBusyResult(normalized.sessionId);
      }
      const state = active.get(normalized.sessionId);
      if (!state) {
        return { ok: false, status: 404, error: "会话不存在" };
      }
      if (!state.running) {
        return { ok: false, status: 409, error: "当前没有正在运行的任务" };
      }
      if (state.quarantinedTurnId) {
        return quarantinedSessionResult(state);
      }
      const queueItemId = String(input.queueItemId ?? "").trim();
      const queueItemIndex = queueItemId
        ? state.queuedPrompts.findIndex((item) => item.id === queueItemId && item.kind !== "guide")
        : -1;
      const queuedItem = queueItemIndex >= 0 ? state.queuedPrompts[queueItemIndex] : null;
      if (queueItemId && !queuedItem) {
        return { ok: false, status: 404, error: "排队消息不存在或已被处理" };
      }
      const guidance = String(queuedItem?.guidance ?? input.guidance ?? input.prompt ?? "").trim();
      if (!guidance) {
        return { ok: false, status: 400, error: "请输入引导内容" };
      }
      if (!queuedItem && !queueHasCapacity(state)) {
        return queueFullResult(state);
      }
      if (queuedItem) {
        state.queuedPrompts.splice(queueItemIndex, 1);
      }
      if (isStopGuidance(guidance)) {
        requestTurnInterrupt(state, "guide-stop");
        appendDashboardEvent(state, {
          type: "guide_stopped",
          id: eventId("guide-stop"),
          guidance: previewText(guidance),
          queue: queueSnapshot(state),
          at: new Date().toISOString()
        });
        return { ok: true, stopped: true, sessionId: state.session.id, queue: queueSnapshot(state), sessionStatus: sessionStatusSummary(state.session) };
      }

      const mode = normalizePermissionMode(input.permissionMode ?? state.currentPermissionMode);
      const item = createQueueItem(buildGuidePrompt(guidance, state.currentPrompt), mode, "guide", guidance);
      state.queuedPrompts.unshift(item);
      appendDashboardEvent(state, {
        type: "guide_queued",
        id: eventId("guide"),
        item: publicQueueItem(item),
        guidance: previewText(guidance),
        queue: queueSnapshot(state),
        queueLength: state.queuedPrompts.length,
        at: new Date().toISOString()
      });
      appendQueueUpdated(state);
      requestTurnInterrupt(state, "guided");
      return {
        ok: true,
        queued: true,
        sessionId: state.session.id,
        queue: queueSnapshot(state),
        queueLength: state.queuedPrompts.length,
        sessionStatus: sessionStatusSummary(state.session)
      };
    },
    async clearContext(input = {}) {
      return mutateDashboardContext({
        active,
        sessionMutationLocks,
        activeCapacityLocks,
        activePolicy,
        cwd: options.cwd,
        runtimeEnv,
        resolveConfigEnv,
        processTrusted
      }, input, "clear");
    },
    async compactContext(input = {}) {
      return mutateDashboardContext({
        active,
        sessionMutationLocks,
        activeCapacityLocks,
        activePolicy,
        cwd: options.cwd,
        runtimeEnv,
        resolveConfigEnv,
        processTrusted
      }, input, "compact");
    },
    subscribe(sessionId, send, options = {}) {
      const state = active.get(sessionId);
      if (!state) {
        return null;
      }
      state.listeners.add(send);
      if (typeof options.onDispose === "function") {
        state.listenerDisposers.set(send, options.onDispose);
      }
      const afterSequence = nonNegativeInteger(options.afterSequence);
      for (const event of state.events) {
        if (nonNegativeInteger(event.sequence) > afterSequence) {
          send(event);
        }
      }
      return () => {
        state.listeners.delete(send);
        state.listenerDisposers.delete(send);
      };
    },
    listActiveEvents(sessionId) {
      return active.get(sessionId)?.events ?? [];
    },
    async sessionCwd(sessionId) {
      const configEnv = await resolveConfigEnv();
      const id = String(sessionId ?? "").trim();
      if (!id) {
        return { ok: false, status: 400, error: "缺少会话 ID" };
      }
      const activeState = active.get(id);
      if (activeState?.session?.cwd) {
        return boundedSessionCwd(options.cwd, activeState.session.cwd);
      }
      const config = await loadConfig({ cwd: options.cwd, env: configEnv });
      const store = createSessionStore({ cwd: options.cwd, transcript: config.transcript, env: runtimeEnv });
      const result = await store.readMetadata(id);
      if (!result.ok) {
        return { ok: false, status: 404, error: "会话不存在" };
      }
      if (String(result.metadata?.id ?? "") !== id) {
        return { ok: false, status: 400, code: "EXACT_SESSION_ID_REQUIRED", error: "文件接口只接受完整会话 ID" };
      }
      return boundedSessionCwd(options.cwd, result.metadata?.cwd ?? options.cwd);
    },
    resolveApproval(approvalId, action) {
      for (const state of active.values()) {
        const pending = state.pendingApprovals.get(approvalId);
        if (!pending) {
          continue;
        }
        state.pendingApprovals.delete(approvalId);
        const allowed = action === "allow-once" || action === "allow-session";
        if (action === "allow-session") {
          state.sessionApprovals.add(pending.approvalKey);
        }
        appendDashboardEvent(state, {
          type: "approval_resolved",
          id: eventId("approval-resolved"),
          approvalId,
          action,
          allowed,
          at: new Date().toISOString()
        });
        pending.resolve(allowed);
        return { ok: true };
      }
      return { ok: false, status: 404, error: "审批请求不存在或已处理" };
    },
    resolveQuestion(questionId, answer = {}) {
      for (const state of active.values()) {
        const pending = state.pendingQuestions.get(questionId);
        if (!pending) {
          continue;
        }
        state.pendingQuestions.delete(questionId);
        const result = normalizeQuestionAnswer(answer, pending.question);
        appendDashboardEvent(state, {
          type: "question_resolved",
          id: eventId("question-resolved"),
          questionId,
          answer: result.answer,
          selectedChoice: result.selectedChoice,
          selectedChoices: result.selectedChoices,
          cancelled: result.cancelled === true,
          at: new Date().toISOString()
        });
        pending.resolve(result);
        return { ok: true };
      }
      return { ok: false, status: 404, error: "需求核对请求不存在或已处理" };
    },
    async lifecycleStatus() {
      const timeoutMs = Math.min(LIFECYCLE_STATUS_WAIT_MS, lifecycleWaitMs(undefined, runtimeEnv));
      const probe = await waitForLifecycleOperation(
        (signal) => readRuntimeActivity(active, options.cwd, { signal }),
        Date.now() + timeoutMs
      );
      if (!probe.settled || probe.error) {
        return {
          ok: false,
          status: 503,
          code: probe.error ? "LIFECYCLE_STATUS_FAILED" : "LIFECYCLE_STATUS_TIMEOUT",
          error: probe.error ? "Dashboard 活动状态检查失败" : "Dashboard 活动状态检查超时",
          activity: dashboardMemoryActivity(active, true),
          timeoutMs
        };
      }
      return {
        ok: true,
        activity: probe.value
      };
    },
    async sweepIdleSessions() {
      const evicted = await reclaimActiveSessions(active, {
        cwd: options.cwd,
        env: runtimeEnv,
        sessionMutationLocks,
        policy: activePolicy,
        ttlOnly: true
      });
      return { ok: true, evicted, activeSessions: active.size };
    },
    async shutdown(input = {}) {
      if (shuttingDown) {
        return { ok: false, status: 409, code: "SHUTDOWN_IN_PROGRESS", error: "Dashboard 已在关闭" };
      }
      const forceShutdown = input.force === true;
      const requestedTimeoutMs = lifecycleWaitMs(input.timeoutMs, runtimeEnv);
      const timeoutMs = forceShutdown
        ? Math.min(requestedTimeoutMs, FORCE_SHUTDOWN_GRACE_MS)
        : requestedTimeoutMs;
      const deadline = Date.now() + timeoutMs;
      shuttingDown = true;
      let completed = false;
      try {
        const initialProbe = forceShutdown
          ? { settled: false }
          : await waitForLifecycleOperation(
            (signal) => readRuntimeActivity(active, options.cwd, { signal }),
            deadline
          );
        const initial = initialProbe.settled && !initialProbe.error
          ? initialProbe.value
          : dashboardMemoryActivity(active, true);
        if ((!initialProbe.settled || initialProbe.error) && !forceShutdown) {
          return {
            ok: false,
            status: 409,
            code: initialProbe.error ? "SHUTDOWN_ACTIVITY_FAILED" : "SHUTDOWN_ACTIVITY_TIMEOUT",
            error: initialProbe.error ? "关闭前活动状态检查失败" : "关闭前活动状态检查超时",
            activity: initial,
            timeoutMs
          };
        }
        const cancelActive = input.cancel === true || input.cancelActive === true || forceShutdown;
        const cancelBackground = input.cancel === true || input.cancelBackground === true || forceShutdown;
        if (initial.total > 0 && !cancelActive && !cancelBackground) {
          return {
            ok: false,
            status: 409,
            code: "ACTIVE_WORK_REQUIRES_DECISION",
            error: "仍有活动任务，请明确选择取消并关闭或返回",
            activity: initial
          };
        }
        if (cancelActive) {
          for (const state of active.values()) {
            cancelAllQueuedTurns(state, "shutdown");
            if (state.running) {
              requestTurnInterrupt(state, "shutdown");
            } else {
              cancelPendingInteractions(state, "shutdown");
            }
          }
        }
        if (cancelBackground) {
          await cancelWorkspaceBackgroundTerminals(options.cwd, { memoryOnly: forceShutdown });
          const cancellations = [...active.values()].map((state) => (
            Promise.resolve().then(() => cancelBackgroundWork(state, { cancelTerminals: false }))
          ));
          const cancellation = await waitForLifecycleOperation(
            () => Promise.allSettled(cancellations),
            deadline
          );
          if ((!cancellation.settled || cancellation.error) && !forceShutdown) {
            return {
              ok: false,
              status: 409,
              code: cancellation.error ? "SHUTDOWN_BACKGROUND_FAILED" : "SHUTDOWN_BACKGROUND_TIMEOUT",
              error: cancellation.error ? "后台任务清理失败" : "后台任务未在清理时限内结束",
              activity: dashboardMemoryActivity(active, true),
              timeoutMs
            };
          }
        }
        const activityResult = forceShutdown
          ? { settled: false, activity: dashboardMemoryActivity(active, true) }
          : await waitForRuntimeActivity(active, deadline, options.cwd, readRuntimeActivity);
        const settled = activityResult.activity;
        if ((!activityResult.settled || settled.total > 0) && !forceShutdown) {
          return {
            ok: false,
            status: 409,
            code: "SHUTDOWN_TIMEOUT",
            error: "活动任务未在清理时限内结束",
            activity: settled,
            timeoutMs
          };
        }
        const sweepSettled = await waitForLifecyclePromise(activeSweepPromise, deadline);
        if (!sweepSettled && !forceShutdown) {
          return {
            ok: false,
            status: 409,
            code: "SHUTDOWN_SWEEP_TIMEOUT",
            error: "会话维护任务未在清理时限内结束",
            activity: settled,
            timeoutMs
          };
        }
        clearInterval(activeSweepTimer);
        for (const state of active.values()) {
          if (state.session?.goal?.enabled) {
            state.session.goal.status = "paused";
            state.session.goal.lastBlockReason = "dashboard_shutdown";
            await persistGoalSnapshot(state);
          }
          disposeTurnState(state, "shutdown");
        }
        active.clear();
        turnRequests.clear();
        completed = true;
        return {
          ok: true,
          forced: forceShutdown || !activityResult.settled || settled.total > 0 || !sweepSettled,
          cancelled: cancelActive || cancelBackground,
          activity: settled,
          initialActivity: initial,
          timeoutMs
        };
      } finally {
        if (!completed) {
          shuttingDown = false;
        }
      }
    },
    sessionFiles(sessionId) {
      const state = active.get(sessionId);
      if (!state) {
        return [];
      }
      return collectSessionFiles(state.session, state.finalOutput);
    }
  };
  return runtime;
}

function dashboardActiveSessionPolicy(env = process.env) {
  return {
    max: boundedPolicyInteger(
      env?.ANT_CODE_DASHBOARD_ACTIVE_SESSION_MAX,
      DASHBOARD_ACTIVE_SESSION_DEFAULTS.max,
      1,
      1000
    ),
    idleTtlMs: boundedPolicyInteger(
      env?.ANT_CODE_DASHBOARD_ACTIVE_IDLE_TTL_MS,
      DASHBOARD_ACTIVE_SESSION_DEFAULTS.idleTtlMs,
      10,
      24 * 60 * 60 * 1000
    ),
    sweepIntervalMs: boundedPolicyInteger(
      env?.ANT_CODE_DASHBOARD_ACTIVE_SWEEP_MS,
      DASHBOARD_ACTIVE_SESSION_DEFAULTS.sweepIntervalMs,
      10,
      60 * 60 * 1000
    )
  };
}

function boundedPolicyInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, number));
}

async function reclaimActiveSessions(active, options) {
  const policy = options.policy ?? DASHBOARD_ACTIVE_SESSION_DEFAULTS;
  const candidates = [...active.values()]
    .filter((state) => basicReclaimableState(state, policy, options.ttlOnly === true))
    .sort((left, right) => Number(left.lastAccessedAt ?? 0) - Number(right.lastAccessedAt ?? 0));
  const evicted = [];
  for (const candidate of candidates) {
    if (options.ttlOnly !== true && active.size <= Number(options.targetSize ?? policy.max - 1)) {
      break;
    }
    const sessionId = candidate.session.id;
    const observedAccess = candidate.lastAccessedAt;
    const observedVersion = candidate.accessVersion;
    await withKeyedMutation(options.sessionMutationLocks, sessionId, async () => {
      const state = active.peek(sessionId);
      if (
        state !== candidate
        || state.lastAccessedAt !== observedAccess
        || state.accessVersion !== observedVersion
        || !basicReclaimableState(state, policy, options.ttlOnly === true)
        || !state.persisted
      ) {
        return;
      }
      if (!await isSessionStatePersisted(state, options.env)) {
        state.persisted = false;
        return;
      }
      const snapshot = await buildBackgroundSubagentSnapshot(state);
      if (snapshot.groups.length > 0) {
        return;
      }
      if (
        state.lastAccessedAt !== observedAccess
        || state.accessVersion !== observedVersion
        || !basicReclaimableState(state, policy, options.ttlOnly === true)
        || listBackgroundAgentTasks({ parentSessionId: sessionId }).length > 0
        || listBackgroundTerminalTasks({ parentSessionId: sessionId, cwd: state.session.cwd })
          .some((task) => task.status === "starting" || task.status === "running" || task.status === "cancelling")
      ) {
        return;
      }
      disposeTurnState(state, options.ttlOnly === true ? "active-idle-ttl" : "active-lru-capacity");
      if (active.peek(sessionId) === state) {
        active.delete(sessionId);
        evicted.push(sessionId);
      }
    });
  }
  return evicted;
}

function basicReclaimableState(state, policy, requireExpired) {
  if (
    !state
    || state.disposed
    || state.running
    || state.interrupting
    || state.quarantinedTurnId
    || state.controller
    || state.forceSettleTimer
    || state.queuedPrompts.length > 0
    || state.listeners.size > 0
    || state.pendingApprovals.size > 0
    || state.pendingQuestions.size > 0
  ) {
    return false;
  }
  return !requireExpired || Date.now() - Number(state.lastAccessedAt ?? 0) >= policy.idleTtlMs;
}

async function isSessionStatePersisted(state, env) {
  if (!state?.session?.id || !state.session.cwd) {
    return false;
  }
  const store = createSessionStore({
    cwd: state.session.cwd,
    transcript: state.session.config?.transcript,
    env
  });
  const result = await store.readMetadataExact(state.session.id);
  return result.ok && String(result.metadata?.id ?? "") === state.session.id;
}

/** @param {any} state @param {any} env */
function scheduleSessionPersistenceCheck(state, env) {
  void isSessionStatePersisted(state, env).then(
    (persisted) => {
      if (!state.disposed && !state.running && !state.currentTurnId) {
        state.persisted = persisted;
      }
    },
    () => {
      // Persistence remains conservative (false) when the background check fails.
    }
  );
}

function activeSessionCapacityResult(active, policy) {
  return {
    ok: false,
    status: 503,
    code: "ACTIVE_SESSION_CAPACITY_REACHED",
    error: "活动会话已达到上限，且没有可安全回收的空闲会话",
    activeSessions: active.size,
    maxActiveSessions: policy?.max ?? DASHBOARD_ACTIVE_SESSION_DEFAULTS.max
  };
}

async function withIdempotentTurnRequest(records, input, create) {
  const requestId = normalizeTurnRequestId(input.requestId);
  if (!requestId.ok) {
    return requestId;
  }
  if (!requestId.value) {
    return create();
  }

  pruneTurnRequests(records);
  const fingerprint = turnRequestFingerprint(input);
  const existing = records.get(requestId.value);
  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      return {
        ok: false,
        status: 409,
        code: "REQUEST_ID_CONFLICT",
        error: "同一 requestId 不能用于不同的任务提交",
        requestId: requestId.value
      };
    }
    return existing.promise;
  }
  if (records.size >= MAX_TURN_REQUESTS) {
    return {
      ok: false,
      status: 503,
      code: "IDEMPOTENCY_CAPACITY_REACHED",
      error: "任务提交去重记录已达到容量上限，请稍后重试",
      requestId: requestId.value
    };
  }

  const record = {
    fingerprint,
    expiresAt: Date.now() + TURN_REQUEST_TTL_MS,
    settled: false,
    promise: null
  };
  record.promise = Promise.resolve()
    .then(create)
    .then((result) => ({ ...result, requestId: requestId.value }));
  records.set(requestId.value, record);
  try {
    return await record.promise;
  } finally {
    record.settled = true;
  }
}

function validateTurnSubmission(input = {}) {
  const rawPrompt = String(input.prompt ?? "");
  if (Buffer.byteLength(rawPrompt, "utf8") > MAX_PROMPT_BYTES) {
    return {
      ok: false,
      status: 413,
      code: "PROMPT_TOO_LARGE",
      error: "任务内容不能超过 256 KiB"
    };
  }
  const prompt = rawPrompt.trim();
  const source = input.attachments ?? [];
  if (!Array.isArray(source)) {
    return { ok: false, status: 400, code: "INVALID_ATTACHMENTS", error: "attachments 必须是数组" };
  }
  if (source.length > MAX_TURN_IMAGES) {
    return { ok: false, status: 400, code: "TOO_MANY_IMAGES", error: "每次任务最多上传 6 张图片" };
  }
  const attachments = [];
  let totalBytes = 0;
  for (const item of source) {
    if (!item || typeof item !== "object" || item.type !== "image") {
      return { ok: false, status: 400, code: "INVALID_IMAGE", error: "附件只允许图片" };
    }
    const mimeType = String(item.mimeType ?? item.mime_type ?? "").trim().toLowerCase();
    if (!ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) {
      return { ok: false, status: 400, code: "UNSUPPORTED_IMAGE_TYPE", error: "图片只支持 PNG、JPEG、GIF 或 WebP" };
    }
    const data = String(item.data ?? "");
    if (!isCanonicalBase64(data)) {
      return { ok: false, status: 400, code: "INVALID_IMAGE_BASE64", error: "图片内容不是有效的 base64" };
    }
    const decoded = Buffer.from(data, "base64");
    if (decoded.length > MAX_IMAGE_BYTES) {
      return { ok: false, status: 413, code: "IMAGE_TOO_LARGE", error: "单张图片不能超过 8 MiB" };
    }
    totalBytes += decoded.length;
    if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
      return { ok: false, status: 413, code: "IMAGES_TOO_LARGE", error: "图片总量不能超过 24 MiB" };
    }
    if (!matchesImageSignature(decoded, mimeType)) {
      return { ok: false, status: 400, code: "IMAGE_SIGNATURE_MISMATCH", error: "图片内容与声明的 MIME 类型不匹配" };
    }
    attachments.push({
      type: "image",
      data,
      mimeType,
      name: String(item.name ?? "image").trim().slice(0, 160) || "image",
      size: decoded.length
    });
  }
  return { ok: true, prompt, attachments };
}

function isCanonicalBase64(value) {
  if (!value || value.length % 4 !== 0 || /\s/.test(value)) {
    return false;
  }
  if (/[^A-Za-z0-9+/=]/.test(value)) {
    return false;
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const firstPadding = value.indexOf("=");
  if (firstPadding >= 0 && firstPadding !== value.length - padding) {
    return false;
  }
  try {
    return Buffer.from(value, "base64").toString("base64") === value;
  } catch {
    return false;
  }
}

function matchesImageSignature(buffer, mimeType) {
  if (mimeType === "image/png") {
    return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (mimeType === "image/jpeg") {
    return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (mimeType === "image/gif") {
    const signature = buffer.subarray(0, 6).toString("ascii");
    return signature === "GIF87a" || signature === "GIF89a";
  }
  if (mimeType === "image/webp") {
    return buffer.length >= 12
      && buffer.subarray(0, 4).toString("ascii") === "RIFF"
      && buffer.subarray(8, 12).toString("ascii") === "WEBP";
  }
  return false;
}

function normalizeTurnRequestId(value) {
  if (value === undefined || value === null || value === "") {
    return { ok: true, value: "" };
  }
  const requestId = String(value).trim();
  if (!requestId || requestId.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(requestId)) {
    return {
      ok: false,
      status: 400,
      code: "INVALID_REQUEST_ID",
      error: "requestId 必须是 1 到 200 位的字母、数字或 . _ : -"
    };
  }
  return { ok: true, value: requestId };
}

function turnRequestFingerprint(input = {}) {
  const hash = createHash("sha256");
  updateFingerprintField(hash, "sessionId", String(input.sessionId ?? "").trim());
  updateFingerprintField(hash, "prompt", String(input.prompt ?? ""));
  updateFingerprintField(hash, "permissionMode", String(input.permissionMode ?? ""));
  const attachments = Array.isArray(input.attachments) ? input.attachments : [];
  updateFingerprintField(hash, "attachmentCount", String(attachments.length));
  for (let index = 0; index < attachments.length; index += 1) {
    const attachment = attachments[index] && typeof attachments[index] === "object" ? attachments[index] : {};
    updateFingerprintField(hash, `${index}:type`, String(attachment.type ?? ""));
    updateFingerprintField(hash, `${index}:name`, String(attachment.name ?? ""));
    updateFingerprintField(hash, `${index}:mimeType`, String(attachment.mimeType ?? attachment.mime_type ?? ""));
    updateFingerprintField(hash, `${index}:size`, String(attachment.size ?? ""));
    updateFingerprintField(hash, `${index}:data`, String(attachment.data ?? ""));
  }
  return hash.digest("hex");
}

function updateFingerprintField(hash, name, value) {
  const text = String(value);
  hash.update(name);
  hash.update("\0");
  hash.update(String(Buffer.byteLength(text, "utf8")));
  hash.update("\0");
  hash.update(text);
  hash.update("\0");
}

function pruneTurnRequests(records) {
  const now = Date.now();
  for (const [requestId, record] of records) {
    if (record.settled && record.expiresAt <= now) {
      records.delete(requestId);
    }
  }
}

/** @param {any} record */
function sessionRecordGoalStatus(record) {
  const goal = record?.goal;
  if (!goal?.enabled) {
    return undefined;
  }
  return goal.status ?? "active";
}

/** @param {unknown} value */
function optionalDashboardPermissionMode(value) {
  if (value == null || String(value).trim() === "") {
    return undefined;
  }
  return normalizePermissionMode(String(value));
}

/** @param {Record<string, any>} context @param {Record<string, any>} input */
async function applyDashboardGoal(context, input) {
  const action = String(input.action ?? "").trim().toLowerCase();
  if (!["enable", "disable", "pause", "resume", "clear"].includes(action)) {
    return { ok: false, status: 400, error: "未知 Goal 操作" };
  }
  const objective = String(input.objective ?? input.text ?? "").trim();
  if (action === "enable" && !objective) {
    return { ok: false, status: 400, error: "请输入目标" };
  }
  const normalized = normalizeMutationSessionId(input.sessionId);
  if (!normalized.ok) {
    return normalized;
  }
  const trustEnv = await context.resolveConfigEnv();
  const trust = await resolveDashboardTrust({ cwd: context.cwd, env: trustEnv, processTrusted: context.processTrusted });
  if (!trust.trusted) {
    return { ok: false, status: 403, error: "请先确认工作区信任", trust };
  }
  return withKeyedMutation(context.sessionMutationLocks, normalized.sessionId, async () => {
    const configEnv = await context.resolveConfigEnv();
    const loadedConfig = await loadConfig({ cwd: context.cwd, env: configEnv });
    const currentConfig = configForDashboardSelection(loadedConfig, context.runtimeSelection);
    const exact = await requireExactSessionId(context.active, {
      cwd: context.cwd,
      env: context.runtimeEnv,
      config: currentConfig,
      sessionId: normalized.sessionId
    });
    if (!exact.ok) {
      return exact;
    }
    let state;
    try {
      state = await ensureTurnState(context.active, {
        cwd: context.cwd,
        env: configEnv,
        sessionId: normalized.sessionId,
        mode: optionalDashboardPermissionMode(input.permissionMode),
        config: currentConfig,
        runTurn: context.runTurn,
        sessionMutationLocks: context.sessionMutationLocks,
        activeCapacityLocks: context.activeCapacityLocks,
        activePolicy: context.activePolicy
      });
    } catch (error) {
      if (error instanceof ActiveSessionCapacityError) {
        return activeSessionCapacityResult(context.active, context.activePolicy);
      }
      throw error;
    }
    if (state.session.permissionReadonlyLocked) {
      return { ok: false, status: 400, error: "只读锁定会话不能启用 Goal" };
    }
    const eventCursor = state.eventSequence;
    if (action === "enable") {
      const previous = resolveGoalPreviousPermissionMode({
        alreadyEnabled: state.session.goal?.enabled === true,
        storedPrevious: state.session.goal?.previousPermissionMode,
        sessionPermissionMode: state.session.permissionMode,
        clientPreviousPermissionMode: input.clientPreviousPermissionMode,
        preferClientForNewSession: false
      });
      state.session.goal = enableGoalState({
        text: objective,
        previousPermissionMode: previous,
        maxAutoContinues: resolveGoalMaxAutoContinues(state.session.config)
      });
      if (!state.running) {
        applyPermissionMode(state.session, "fullAccess");
      }
      emitGoalState(state, "enabled");
      startIdleGoalTurn(state, configEnv, objective);
    } else if (action === "disable" || action === "clear") {
      const previous = state.session.goal?.previousPermissionMode ?? "plan";
      if (state.running) {
        requestTurnInterrupt(state, "goal-disable");
      }
      dropGoalContinueItems(state);
      state.session.goal = action === "clear"
        ? disableGoalState({ ...state.session.goal, text: "" }, { clearedBy: "user" })
        : disableGoalState(state.session.goal, { clearedBy: "user" });
      if (action === "clear") {
        state.session.goal.text = "";
      }
      applyPermissionMode(state.session, previous);
      emitGoalState(state, action);
    } else if (action === "pause") {
      if (!state.session.goal?.enabled) {
        return { ok: false, status: 409, error: "当前没有启用 Goal" };
      }
      if (state.running) {
        requestTurnInterrupt(state, "goal-pause");
      }
      dropGoalContinueItems(state);
      state.session.goal.status = "paused";
      state.session.goal.lastBlockReason = "user_pause";
      emitGoalState(state, "paused");
    } else if (action === "resume") {
      const goal = state.session.goal;
      if (!goal?.enabled || !String(goal.text ?? "").trim()) {
        return { ok: false, status: 409, error: "没有可继续的 Goal" };
      }
      if (goal.status !== "paused" && goal.status !== "failed") {
        return { ok: false, status: 409, error: "Goal 当前不可继续" };
      }
      applyPermissionMode(state.session, "fullAccess");
      goal.status = "active";
      goal.lastBlockReason = "";
      goal.consecutiveFailures = 0;
      emitGoalState(state, "resumed");
      if (!state.running && !state.disposed && !state.quarantinedTurnId) {
        const item = createGoalContinueItem(state);
        if (item) {
          state.queuedPrompts.push(item);
          const prepared = await prepareDashboardSessionForQueuedTurn(state, configEnv);
          if (prepared) {
            const next = takeNextQueueItem(state);
            if (next) {
              if (state.session.goal?.enabled) {
                next.permissionMode = "fullAccess";
              }
              beginPrompt(state, next, configEnv);
            }
          }
        }
      }
    }
    await persistGoalSnapshot(state);
    return {
      ok: true,
      sessionId: state.session.id,
      permission: permissionModeSummary(state.session),
      goal: publicGoalSnapshot(state.session.goal, state.session.config),
      sessionStatus: sessionStatusSummary(state.session),
      running: state.running === true,
      eventCursor,
      queue: queueSnapshot(state)
    };
  });
}

/** @param {Record<string, any>} state @param {string} reason */
function emitGoalState(state, reason) {
  appendDashboardEvent(state, {
    type: "goal_state",
    id: eventId("goal-state"),
    reason,
    goal: publicGoalSnapshot(state.session.goal, state.session.config),
    permission: permissionModeSummary(state.session),
    at: new Date().toISOString()
  });
}

/** @param {Record<string, any>} state */
async function persistGoalSnapshot(state) {
  if (!state?.session) {
    return;
  }
  try {
    await persistSessionSnapshot(state.session, { env: state.turnEnv ?? process.env });
    state.persisted = true;
  } catch (error) {
    const code = /** @type {{ code?: string }} */ (error)?.code;
    if (code !== "SESSION_NOT_FOUND" && code !== "SESSION_METADATA_NOT_FOUND") {
      appendDashboardEvent(state, {
        type: "error",
        id: eventId("goal-persist"),
        message: error instanceof Error ? error.message : String(error),
        at: new Date().toISOString()
      });
    }
  }
}

/** @param {Record<string, any>} state @param {NodeJS.ProcessEnv} env @param {string} prompt */
function startIdleGoalTurn(state, env, prompt) {
  if (state.running || state.disposed || state.quarantinedTurnId) {
    return false;
  }
  const text = String(prompt ?? state.session?.goal?.text ?? "").trim();
  if (!text || !state.session?.goal?.enabled) {
    return false;
  }
  applyPermissionMode(state.session, "fullAccess");
  state.session.goal.status = "running";
  const item = createQueueItem(text, "fullAccess", "prompt");
  return beginPrompt(state, item, env);
}

/** @param {Record<string, any>} state */
function dropGoalContinueItems(state) {
  state.queuedPrompts = state.queuedPrompts.filter((item) => item.kind !== GOAL_CONTINUE_KIND);
}

/** @param {Record<string, any>} state */
function createGoalContinueItem(state) {
  const goal = state.session?.goal;
  const text = String(goal?.text ?? "").trim();
  if (!text) {
    return null;
  }
  const prompt = buildGoalContinuePrompt({
    ...goal,
    maxAutoContinues: resolveGoalMaxAutoContinues(state.session.config, goal.maxAutoContinues)
  }, {
    lastTurn: state.status || "completed",
    hostNotes: goal.lastEvidence?.gaps?.length
      ? goal.lastEvidence.gaps.slice(0, 4)
      : [`remaining todos: ${goal.lastEvidence?.activeItems ?? 0}`]
  });
  const item = createQueueItem(prompt, "fullAccess", GOAL_CONTINUE_KIND);
  item.title = `Goal 续跑 · 第 ${nonNegativeInteger(goal.continueCount) + 1} 轮`;
  return item;
}

/** @param {Record<string, any>} state @param {{ wasQuarantined?: boolean }} [options] */
function maybeEnqueueGoalContinue(state, options = {}) {
  const wasQuarantined = options.wasQuarantined;
  if (wasQuarantined || state.disposed) {
    return false;
  }
  if (shouldSkipGoalContinue(state)) {
    if (state.session?.goal?.enabled && nonNegativeInteger(state.session.goal.continueCount) >= resolveGoalMaxAutoContinues(state.session.config, state.session.goal.maxAutoContinues)) {
      state.session.goal.status = "paused";
      state.session.goal.lastBlockReason = "budget";
      emitGoalState(state, "budget");
    }
    return false;
  }
  if (state.queuedPrompts.some((item) => ["guide", "prompt", "wakeup"].includes(item.kind))) {
    dropGoalContinueItems(state);
    return false;
  }
  if (state.queuedPrompts.some((item) => item.kind === GOAL_CONTINUE_KIND)) {
    return false;
  }
  const item = createGoalContinueItem(state);
  if (!item) {
    return false;
  }
  state.session.goal.continueCount = nonNegativeInteger(state.session.goal.continueCount) + 1;
  state.session.goal.status = "running";
  state.session.goal.lastContinueReason = "unfinished";
  state.queuedPrompts.push(item);
  appendDashboardEvent(state, {
    type: "goal_continued",
    id: eventId("goal-continue"),
    reason: state.session.goal.lastContinueReason,
    continueCount: state.session.goal.continueCount,
    goal: publicGoalSnapshot(state.session.goal, state.session.config),
    queue: queueSnapshot(state),
    at: new Date().toISOString()
  });
  return true;
}

/** @param {Record<string, any>} state */
function takeNextQueueItem(state) {
  const hasUserWork = state.queuedPrompts.some((item) => ["guide", "prompt", "wakeup"].includes(item.kind));
  if (hasUserWork) {
    dropGoalContinueItems(state);
  }
  return state.queuedPrompts.shift() ?? null;
}

/** @param {Record<string, any>} state */
function userVisibleQueueLength(state) {
  return state.queuedPrompts.filter((item) => item.kind !== GOAL_CONTINUE_KIND).length;
}

/** @param {Record<string, any>} state @param {string} terminalStatus */
function updateGoalAfterTurn(state, terminalStatus) {
  const goal = state.session?.goal;
  if (!goal?.enabled) {
    return;
  }
  if (terminalStatus === "interrupted") {
    goal.status = "paused";
    goal.lastBlockReason = "user_interrupt";
    dropGoalContinueItems(state);
    emitGoalState(state, "paused");
    return;
  }
  if (["blocked", "cancelled"].includes(terminalStatus)) {
    goal.status = "paused";
    goal.lastBlockReason = terminalStatus;
    emitGoalState(state, "paused");
    return;
  }
  if (terminalStatus === "failed") {
    goal.consecutiveFailures = nonNegativeInteger(goal.consecutiveFailures) + 1;
    if (goal.consecutiveFailures >= 3) {
      goal.status = "failed";
      goal.lastBlockReason = "consecutive_failures";
      emitGoalState(state, "failed");
    } else {
      goal.status = "paused";
      goal.lastBlockReason = "transient_failure";
      emitGoalState(state, "paused");
    }
    return;
  }
  if (terminalStatus === "completed") {
    goal.consecutiveFailures = 0;
    const evaluation = evaluateGoalCompletion({
      goal,
      finalOutput: state.finalOutput,
      lastEvidence: goal.lastEvidence,
      liveWorkflow: state.session.workflow
    });
    goal.lastEvidence = evaluation.evidence;
    if (evaluation.complete) {
      goal.status = "complete";
      goal.lastContinueReason = evaluation.reason;
      emitGoalState(state, "complete");
    } else if (goal.status !== "paused") {
      goal.status = "active";
    }
  }
}

async function startDashboardTurn(context, input) {
  const validated = validateTurnSubmission(input);
  if (!validated.ok) {
    return validated;
  }
  const { prompt, attachments } = validated;
  if (!prompt && attachments.length === 0) {
    return { ok: false, status: 400, error: "请输入任务需求" };
  }
  const normalized = input.sessionId ? normalizeMutationSessionId(input.sessionId) : { ok: true, sessionId: "" };
  if (!normalized.ok) {
    return normalized;
  }
  const trustEnv = await context.resolveConfigEnv();
  const trust = await resolveDashboardTrust({ cwd: context.cwd, env: trustEnv, processTrusted: context.processTrusted });
  if (!trust.trusted) {
    return { ok: false, status: 403, error: "请先确认工作区信任", trust };
  }
  let mode = normalizePermissionMode(input.permissionMode);
  const createdThisRequest = !normalized.sessionId;
  const run = async () => {
    const configEnv = await context.resolveConfigEnv();
    const loadedConfig = await loadConfig({ cwd: context.cwd, env: configEnv });
    const currentConfig = configForDashboardSelection(loadedConfig, context.runtimeSelection);
    if (normalized.sessionId) {
      const exact = await requireExactSessionId(context.active, {
        cwd: context.cwd,
        env: context.runtimeEnv,
        config: currentConfig,
        sessionId: normalized.sessionId
      });
      if (!exact.ok) {
        return exact;
      }
    }
    let state;
    try {
      state = await ensureTurnState(context.active, {
        cwd: context.cwd,
        env: configEnv,
        sessionId: normalized.sessionId,
        mode,
        modelId: context.runtimeSelection?.modelId,
        reasoningEffort: context.runtimeSelection?.reasoningEffort,
        config: currentConfig,
        runTurn: context.runTurn,
        sessionMutationLocks: context.sessionMutationLocks,
        activeCapacityLocks: context.activeCapacityLocks,
        activePolicy: context.activePolicy
      });
    } catch (error) {
      if (error instanceof ActiveSessionCapacityError) {
        return activeSessionCapacityResult(context.active, context.activePolicy);
      }
      if (error instanceof SessionModelSelectionUnresolvedError || error?.code === "SESSION_MODEL_SELECTION_UNRESOLVED") {
        return unresolvedSessionModelSelectionResult(/** @type {Record<string, any>} */ (error), normalized.sessionId);
      }
      throw error;
    }
    if (state.disposed) {
      return { ok: false, status: 410, code: "SESSION_DISPOSED", error: "会话已被删除" };
    }
    if (state.quarantinedTurnId) {
      return quarantinedSessionResult(state);
    }
    if (state.running && isConfigV2Enabled(loadedConfig)) {
      const admission = dashboardSessionV2MutationView(state.session, loadedConfig);
      if (admission.resolution.status !== "resolved") {
        invalidateRunningDashboardSessionSelection(state, admission);
        return unresolvedSessionModelSelectionResult(admission.resolution, state.session.id);
      }
      state.session.modelSelectionInvalidation = null;
      state.session.pendingModelSelectionMutation = null;
    }
    if (!state.running && state.queuedPrompts.length > 0) {
      return {
        ok: false,
        status: 409,
        code: "QUEUED_TURNS_REQUIRE_RESOLUTION",
        error: "隔离任务留下的排队消息尚未处理，请先取消排队消息后再提交",
        sessionId: state.session.id,
        queue: queueSnapshot(state)
      };
    }
    state.hooksTrusted = trust.trusted;
    const eventCursor = state.eventSequence;
    if (state.session.goal?.enabled) {
      mode = "fullAccess";
    } else if (input.goalMode === true && String(input.goalText ?? "").trim()) {
      const created = enableGoalState({
        text: input.goalText,
        maxAutoContinues: resolveGoalMaxAutoContinues(state.session.config),
        previousPermissionMode: resolveGoalPreviousPermissionMode({
          alreadyEnabled: false,
          sessionPermissionMode: state.session.permissionMode,
          clientPreviousPermissionMode: input.clientPreviousPermissionMode,
          preferClientForNewSession: createdThisRequest
        })
      });
      if (created) {
        state.session.goal = created;
        mode = "fullAccess";
        if (!state.running) {
          applyPermissionMode(state.session, "fullAccess");
        }
        emitGoalState(state, "enabled");
      }
    }

    if (state.running) {
      const queuedAttachmentBytes = state.queuedPrompts.reduce((total, queued) => (
        total + queued.attachments.reduce((sum, attachment) => sum + nonNegativeInteger(attachment.size), 0)
      ), 0);
      const newAttachmentBytes = attachments.reduce((total, attachment) => total + attachment.size, 0);
      if (state.currentAttachmentBytes + queuedAttachmentBytes + newAttachmentBytes > MAX_TOTAL_IMAGE_BYTES) {
        return {
          ok: false,
          status: 413,
          code: "QUEUE_ATTACHMENT_BUDGET_EXCEEDED",
          error: "排队消息中的图片总量不能超过 24 MiB",
          sessionId: state.session.id,
          queue: queueSnapshot(state)
        };
      }
      const item = enqueuePrompt(state, prompt, mode, "prompt", attachments);
      if (!item) {
        return queueFullResult(state);
      }
      appendDashboardEvent(state, {
        type: "prompt_queued",
        id: eventId("prompt-queued"),
        item: publicQueueItem(item),
        queue: queueSnapshot(state),
        queueLength: state.queuedPrompts.length,
        at: new Date().toISOString()
      });
      appendQueueUpdated(state);
      return {
        ok: true,
        queued: true,
        sessionId: state.session.id,
        eventCursor,
        queue: queueSnapshot(state),
        queueLength: state.queuedPrompts.length,
        permission: permissionModeSummary(state.session),
        goal: publicGoalSnapshot(state.session.goal, state.session.config),
        sessionStatus: sessionStatusSummary(state.session)
      };
    }

    const item = createQueueItem(prompt, mode, "prompt", "", attachments);
    beginPrompt(state, item, configEnv);
    return {
      ok: true,
      sessionId: state.session.id,
      eventCursor,
      running: true,
      queue: queueSnapshot(state),
      current: publicQueueItem(item),
      permission: permissionModeSummary(state.session),
      goal: publicGoalSnapshot(state.session.goal, state.session.config),
      sessionStatus: sessionStatusSummary(state.session)
    };
  };
  return normalized.sessionId
    ? withKeyedMutation(context.sessionMutationLocks, normalized.sessionId, run)
    : run();
}

async function mutateDashboardContext(context, input, operation) {
  const normalized = normalizeMutationSessionId(input.sessionId);
  if (!normalized.ok) {
    return normalized;
  }
  const configEnv = await context.resolveConfigEnv();
  const trust = await resolveDashboardTrust({ cwd: context.cwd, env: configEnv, processTrusted: context.processTrusted });
  if (!trust.trusted) {
    return { ok: false, status: 403, error: "请先确认工作区信任", trust };
  }
  const config = await loadConfig({ cwd: context.cwd, env: configEnv });
  return withKeyedMutation(context.sessionMutationLocks, normalized.sessionId, async () => {
    const exact = await requireExactSessionId(context.active, {
      cwd: context.cwd,
      env: context.runtimeEnv,
      config,
      sessionId: normalized.sessionId
    });
    if (!exact.ok) {
      return exact;
    }
    const mode = normalizePermissionMode(input.permissionMode);
    let state;
    try {
      state = await ensureTurnState(context.active, {
        cwd: context.cwd,
        env: configEnv,
        sessionId: normalized.sessionId,
        mode,
        config,
        sessionMutationLocks: context.sessionMutationLocks,
        activeCapacityLocks: context.activeCapacityLocks,
        activePolicy: context.activePolicy
      });
    } catch (error) {
      if (error instanceof ActiveSessionCapacityError) {
        return activeSessionCapacityResult(context.active, context.activePolicy);
      }
      throw error;
    }
    if (state.running || state.quarantinedTurnId) {
      return {
        ok: false,
        status: 409,
        code: state.quarantinedTurnId ? "SESSION_QUARANTINED" : "SESSION_RUNNING",
        error: operation === "compact" ? "任务运行中，结束或中断后再压缩上下文" : "任务运行中，结束或中断后再清空上下文"
      };
    }
    const before = summarizeContextWindow(state.session);
    const contextSnapshot = captureDashboardContextState(state.session);
    if (operation === "clear") {
      const after = clearSessionContext(state.session);
      state.persisted = false;
      const persistence = await persistDashboardContextMutation(state, configEnv, contextSnapshot);
      if (!persistence.ok) {
        return persistence;
      }
      appendDashboardEvent(state, {
        type: "context_cleared",
        id: eventId("context-clear"),
        before,
        after,
        sessionStatus: sessionStatusSummary(state.session),
        at: new Date().toISOString()
      });
      return { ok: true, sessionId: state.session.id, before, after, sessionStatus: sessionStatusSummary(state.session) };
    }
    const result = await compactSessionContextWithModel(state.session, {
      force: true,
      reason: "manual",
      gateway: createLabModelGateway(state.session.config),
      env: configEnv,
      hooksTrusted: trust.trusted
    });
    state.persisted = false;
    const persistence = await persistDashboardContextMutation(state, configEnv, contextSnapshot);
    if (!persistence.ok) {
      return persistence;
    }
    const after = summarizeContextWindow(state.session);
    appendDashboardEvent(state, {
      type: "context_compacted",
      id: eventId("context-compact"),
      ...result,
      before,
      after,
      sessionStatus: sessionStatusSummary(state.session),
      at: new Date().toISOString()
    });
    return { ok: true, sessionId: state.session.id, result, before, after, sessionStatus: sessionStatusSummary(state.session) };
  });
}

function captureDashboardContextState(session) {
  return {
    messages: cloneDashboardStateValue(session.messages),
    contextWindow: cloneDashboardStateValue(session.contextWindow),
    transcriptArchive: cloneDashboardStateValue(session.transcriptArchive),
    modelContextArchive: cloneDashboardStateValue(session.modelContextArchive)
  };
}

async function persistDashboardContextMutation(state, env, snapshot) {
  try {
    await persistSessionSnapshot(state.session, { env });
    state.persisted = true;
    return { ok: true };
  } catch (error) {
    state.session.messages = snapshot.messages;
    state.session.contextWindow = snapshot.contextWindow;
    state.session.transcriptArchive = snapshot.transcriptArchive;
    state.session.modelContextArchive = snapshot.modelContextArchive;
    state.persisted = false;
    return {
      ok: false,
      status: 500,
      code: "CONTEXT_PERSIST_FAILED",
      error: "上下文状态未能安全保存，操作已回退，请重试"
    };
  }
}

function cloneDashboardStateValue(value) {
  return value === undefined ? undefined : structuredClone(value);
}

async function deleteDashboardSession(context, input) {
  const normalized = normalizeMutationSessionId(input.sessionId ?? input.id);
  if (!normalized.ok) {
    return normalized;
  }
  const configEnv = await context.resolveConfigEnv();
  const config = await loadConfig({ cwd: context.cwd, env: configEnv });
  return withKeyedMutation(context.sessionMutationLocks, normalized.sessionId, async () => {
    const exact = await requireExactSessionId(context.active, {
      cwd: context.cwd,
      env: context.runtimeEnv,
      config,
      sessionId: normalized.sessionId
    });
    if (!exact.ok) {
      return exact;
    }
    const state = context.active.get(normalized.sessionId) ?? null;
    const initialActivity = state ? await dashboardSessionActivity(state) : emptyRuntimeActivity();
    const cancelActive = input.cancelActive === true;
    const cancelBackground = input.cancelBackground === true;
    if (initialActivity.total > 0 && !cancelActive && !cancelBackground) {
      return {
        ok: false,
        status: 409,
        code: "SESSION_HAS_ACTIVE_WORK",
        error: "会话仍有主任务、排队消息、后台任务或待处理交互，不能直接删除",
        sessionId: normalized.sessionId,
        activity: initialActivity
      };
    }
    if (state && cancelActive) {
      cancelAllQueuedTurns(state, "session-delete");
      if (state.running) {
        requestTurnInterrupt(state, "session-delete");
      } else {
        cancelPendingInteractions(state, "session-delete");
      }
    }
    if (state && cancelBackground) {
      await cancelSessionBackgroundWork(state);
    }
    if (state && (cancelActive || cancelBackground)) {
      const timeoutMs = lifecycleWaitMs(input.timeoutMs, context.runtimeEnv);
      const remaining = await waitForSessionActivity(state, timeoutMs);
      if (remaining.total > 0) {
        return {
          ok: false,
          status: 409,
          code: "SESSION_CANCEL_TIMEOUT",
          error: "会话活动任务未在清理时限内结束，未执行删除",
          sessionId: normalized.sessionId,
          activity: remaining,
          timeoutMs
        };
      }
    }

    const store = createSessionStore({ cwd: context.cwd, transcript: config.transcript, env: context.runtimeEnv });
    const result = await store.deleteSession(normalized.sessionId);
    if (!result.ok && !state) {
      return { ok: false, status: 404, error: result.error?.message ?? "会话不存在" };
    }
    if (state) {
      disposeTurnState(state, "session-delete");
      if (context.active.get(normalized.sessionId) === state) {
        context.active.delete(normalized.sessionId);
      }
    }
    return {
      ok: true,
      sessionId: result.ok ? result.id : normalized.sessionId,
      deleted: result.ok ? result.deleted : [],
      activeDeleted: Boolean(state),
      persistedDeleted: result.ok
    };
  });
}

function normalizeMutationSessionId(value) {
  const sessionId = String(value ?? "").trim();
  if (!sessionId) {
    return { ok: false, status: 400, code: "SESSION_ID_REQUIRED", error: "请选择完整的会话 ID" };
  }
  if (sessionId.toLowerCase() === "latest") {
    return { ok: false, status: 400, code: "EXACT_SESSION_ID_REQUIRED", error: "修改操作只接受完整会话 ID" };
  }
  return { ok: true, sessionId };
}

async function boundedSessionCwd(workspaceCwd, candidateCwd) {
  try {
    const [workspaceReal, candidateReal] = await Promise.all([
      fs.realpath(workspaceCwd),
      fs.realpath(candidateCwd)
    ]);
    if (!isPathInside(workspaceReal, candidateReal)) {
      return {
        ok: false,
        status: 403,
        code: "SESSION_CWD_OUTSIDE_WORKSPACE",
        error: "会话工作目录不在 Dashboard 工作区内"
      };
    }
    return { ok: true, cwd: candidateReal };
  } catch {
    return { ok: false, status: 404, code: "SESSION_CWD_NOT_FOUND", error: "会话工作目录不存在" };
  }
}

function isPathInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function requireExactSessionId(active, options) {
  if (active.has(options.sessionId)) {
    return { ok: true, sessionId: options.sessionId };
  }
  const store = createSessionStore({ cwd: options.cwd, transcript: options.config.transcript, env: options.env });
  const result = await store.readMetadata(options.sessionId);
  if (!result.ok) {
    return { ok: false, status: 404, code: "SESSION_NOT_FOUND", error: result.error?.message ?? "会话不存在" };
  }
  const resolvedId = String(result.metadata?.id ?? "").trim();
  if (!resolvedId || resolvedId !== options.sessionId) {
    return {
      ok: false,
      status: 400,
      code: "EXACT_SESSION_ID_REQUIRED",
      error: "修改操作不接受 latest 或会话 ID 前缀，请使用完整会话 ID"
    };
  }
  return { ok: true, sessionId: resolvedId };
}

async function withKeyedMutation(locks, key, fn) {
  const previous = locks.get(key) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  locks.set(key, current);
  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === current) {
      locks.delete(key);
    }
  }
}

function sessionMutationBusyResult(sessionId) {
  return {
    ok: false,
    status: 409,
    code: "SESSION_MUTATION_IN_PROGRESS",
    error: "该会话正在执行另一项修改，请稍后重试",
    sessionId
  };
}

function quarantinedSessionResult(state) {
  return {
    ok: false,
    status: 409,
    code: "SESSION_QUARANTINED",
    error: "旧任务未能及时停止，会话已隔离；底层执行真正结束前不能继续运行",
    sessionId: state.session.id,
    turnId: state.quarantinedTurnId,
    queue: queueSnapshot(state)
  };
}

/** @param {any} active @param {string} cwd @param {{ signal?: AbortSignal }} [options] */
async function dashboardRuntimeActivity(active, cwd = process.cwd(), options = {}) {
  const result = emptyRuntimeActivity();
  const activeSessionIds = new Set();
  const activeStates = [...active.values()];
  const groupSnapshots = await loadDashboardGroupSnapshots(activeStates, options);
  for (const state of activeStates) {
    activeSessionIds.add(state.session.id);
    const activity = await dashboardSessionActivity(state, {
      groups: groupSnapshots.get(path.resolve(state.session.cwd)) ?? []
    });
    result.activeTurns += activity.activeTurns;
    result.quarantinedTurns += activity.quarantinedTurns;
    result.queuedTurns += activity.queuedTurns;
    result.backgroundTasks += activity.backgroundTasks;
    result.pendingInteractions += activity.pendingInteractions;
  }
  const workspace = path.resolve(cwd);
  const orphanTerminals = listBackgroundTerminalTasks({ cwd })
    .filter((task) => task.status === "starting" || task.status === "running" || task.status === "cancelling")
    .filter((task) => task.cwd && path.resolve(task.cwd) === workspace)
    .filter((task) => !task.parentSessionId || !activeSessionIds.has(task.parentSessionId));
  result.backgroundTasks += orphanTerminals.length;
  result.sessions = active.size;
  result.total = activityTotal(result);
  return result;
}

/** @param {any} active @param {boolean} [uncertain] */
function dashboardMemoryActivity(active, uncertain = false) {
  const result = /** @type {any} */ (emptyRuntimeActivity());
  for (const state of active.values()) {
    result.activeTurns += state.running ? 1 : 0;
    result.quarantinedTurns += state.quarantinedTurnId ? 1 : 0;
    result.queuedTurns += state.queuedPrompts.length;
    result.pendingInteractions += state.pendingApprovals.size + state.pendingQuestions.size;
  }
  result.sessions = active.size;
  result.total = activityTotal(result);
  if (uncertain) {
    result.uncertain = true;
  }
  return result;
}

/** @param {any} state @param {{ groups?: Array<Record<string, any>>; signal?: AbortSignal }} [options] */
async function dashboardSessionActivity(state, options = {}) {
  const snapshot = await buildBackgroundSubagentSnapshot(state, options);
  const activeTurns = state.running ? 1 : 0;
  const visibleBackgroundTasks = snapshot.groups.reduce((total, group) => (
    total + Math.max(1, nonNegativeInteger(group.runningCount))
  ), 0);
  const registeredAgents = listBackgroundAgentTasks({ parentSessionId: state.session.id }).length;
  const registeredTerminals = listBackgroundTerminalTasks({ parentSessionId: state.session.id, cwd: state.session.cwd })
    .filter((task) => task.status === "starting" || task.status === "running" || task.status === "cancelling")
    .filter((task) => !task.cwd || path.resolve(task.cwd) === path.resolve(state.session.cwd))
    .length;
  const result = {
    sessions: 1,
    activeTurns,
    quarantinedTurns: state.quarantinedTurnId ? 1 : 0,
    queuedTurns: state.queuedPrompts.length,
    backgroundTasks: Math.max(visibleBackgroundTasks, registeredAgents + registeredTerminals),
    pendingInteractions: state.pendingApprovals.size + state.pendingQuestions.size,
    total: 0
  };
  result.total = activityTotal(result);
  return result;
}

function emptyRuntimeActivity() {
  return {
    sessions: 0,
    activeTurns: 0,
    quarantinedTurns: 0,
    queuedTurns: 0,
    backgroundTasks: 0,
    pendingInteractions: 0,
    total: 0
  };
}

function activityTotal(activity) {
  return activity.activeTurns + activity.queuedTurns + activity.backgroundTasks + activity.pendingInteractions;
}

/** @param {any} state @param {any} [options] */
async function cancelSessionBackgroundWork(state, options = {}) {
  const aborted = cancelBackgroundAgentTasks({ parentSessionId: state.session.id });
  if (options.cancelTerminals !== false) {
    await cancelBackgroundTerminalTasks({
      parentSessionId: state.session.id,
      cwd: state.session.cwd,
      workspaceCwd: state.session.cwd
    });
  }
  const abortedIds = new Set(aborted.filter((task) => task.aborted === true).map((task) => task.taskId));
  const taskStore = createAgentTaskStore({ cwd: state.session.cwd });
  const groupStore = createAgentTaskGroupStore({ cwd: state.session.cwd });
  const tasks = await taskStore.listTasks({ parentSessionId: state.session.id });
  const now = new Date().toISOString();
  for (const task of tasks) {
    if (!abortedIds.has(task.id) || TERMINAL_TASK_STATUSES.has(String(task.status))) {
      continue;
    }
    await taskStore.updateTask(task.id, {
      status: "interrupted",
      cancelRequestedAt: now,
      finishedAt: now,
      heartbeatAt: now,
      progressAt: now,
      latestProgress: "Dashboard 已取消会话，后台子任务 controller 已中止。"
    });
  }
  const groups = await groupStore.listGroups({ parentSessionId: state.session.id });
  for (const group of groups) {
    const groupTasks = await readDashboardGroupTasks(taskStore, group.taskIds);
    const summary = summarizeGroupStatus(groupTasks, { waitFor: group.waitFor });
    await groupStore.updateGroup(group.id, {
      status: summary.completed ? summary.status : group.status,
      summary: summary.summary,
      latestProgress: summary.summary,
      wakePromptConsumedAt: group.wakePromptQueuedAt && !group.wakePromptConsumedAt ? now : group.wakePromptConsumedAt,
      metadata: {
        ...(group.metadata ?? {}),
        cancelledFromDashboardAt: now
      }
    });
  }
  scheduleBackgroundSubagentSnapshot(state);
}

/** @param {string} cwd @param {Record<string, any>} [options] */
async function cancelWorkspaceBackgroundTerminals(cwd, options = {}) {
  return cancelBackgroundTerminalTasks({
    cwd,
    workspaceCwd: cwd,
    refresh: options.memoryOnly !== true,
    persist: options.memoryOnly !== true
  });
}

function cancelAllQueuedTurns(state, reason) {
  if (state.queuedPrompts.length === 0) {
    return [];
  }
  const removed = state.queuedPrompts.splice(0).map(publicQueueItem);
  appendDashboardEvent(state, {
    type: "queue_cleared",
    id: eventId("queue-cleared"),
    reason,
    items: removed,
    queue: [],
    queueLength: 0,
    running: state.running,
    at: new Date().toISOString()
  });
  appendQueueUpdated(state);
  return removed;
}

async function waitForRuntimeActivity(active, deadline, cwd, readActivity = dashboardRuntimeActivity) {
  let activity = dashboardMemoryActivity(active, true);
  while (Date.now() < deadline) {
    const probe = await waitForLifecycleOperation((signal) => readActivity(active, cwd, { signal }), deadline);
    if (!probe.settled || probe.error) {
      return { settled: false, activity: dashboardMemoryActivity(active, true), error: probe.error };
    }
    activity = probe.value;
    if (activity.total <= 0) {
      return { settled: true, activity };
    }
    await waitForLifecycleTick(deadline);
  }
  return { settled: false, activity: dashboardMemoryActivity(active, true) };
}

async function waitForSessionActivity(state, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let activity = await dashboardSessionActivity(state);
  while (activity.total > 0 && Date.now() < deadline) {
    await waitForLifecycleTick(deadline);
    activity = await dashboardSessionActivity(state);
  }
  return activity;
}

function waitForLifecycleTick(deadline) {
  return new Promise((resolve) => {
    const delay = Math.max(1, Math.min(LIFECYCLE_POLL_INTERVAL_MS, deadline - Date.now()));
    setTimeout(resolve, delay);
  });
}

/**
 * @param {Promise<unknown> | null | undefined} promise
 * @param {number} deadline
 * @returns {Promise<boolean>}
 */
async function waitForLifecyclePromise(promise, deadline) {
  if (!promise) {
    return true;
  }
  const result = await waitForLifecycleOperation(() => promise, deadline);
  return result.settled;
}

/**
 * @param {(signal: AbortSignal) => any} operation
 * @param {number} deadline
 */
async function waitForLifecycleOperation(operation, deadline) {
  const remaining = Math.max(0, deadline - Date.now());
  if (remaining <= 0) {
    return { settled: false };
  }
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  const controller = new AbortController();
  const work = Promise.resolve().then(() => operation(controller.signal));
  try {
    return await Promise.race([
      work.then(
        (value) => ({ settled: true, value }),
        (error) => ({ settled: true, error })
      ),
      new Promise((resolve) => {
        timer = setTimeout(() => {
          resolve({ settled: false });
          controller.abort(new Error("Dashboard lifecycle operation timed out"));
        }, remaining);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function lifecycleWaitMs(value, env = process.env) {
  const configured = Number(value ?? env?.ANT_CODE_DASHBOARD_LIFECYCLE_WAIT_MS ?? DEFAULT_LIFECYCLE_WAIT_MS);
  if (!Number.isFinite(configured)) {
    return DEFAULT_LIFECYCLE_WAIT_MS;
  }
  return Math.max(50, Math.min(MAX_LIFECYCLE_WAIT_MS, Math.trunc(configured)));
}

function disposeTurnState(state, reason) {
  if (state.disposed) {
    return;
  }
  clearForceSettleTimer(state);
  stopBackgroundSnapshotPolling(state);
  const canReleaseSessionMemory = !state.controller;
  if (state.controller && !state.controller.signal.aborted) {
    state.controller.abort(reason);
  }
  cancelPendingInteractions(state, reason);
  state.queuedPrompts.length = 0;
  state.currentAttachmentBytes = 0;
  for (const dispose of state.listenerDisposers.values()) {
    try {
      dispose(reason);
    } catch {
      // Listener disposal is best-effort; state references are still removed below.
    }
  }
  state.listenerDisposers.clear();
  state.disposed = true;
  state.controller = null;
  state.running = false;
  state.interrupting = false;
  state.quarantinedTurnId = "";
  state.currentPrompt = "";
  state.currentTurnId = "";
  state.turnEnv = null;
  state.finalOutput = "";
  state.backgroundSnapshotDirty = false;
  state.backgroundSnapshotPromise = null;
  state.events.length = 0;
  state.listeners.clear();
  if (canReleaseSessionMemory) {
    state.session.messages = [];
    state.session.transcriptMessages = [];
    if (state.session.transcriptArchive) {
      state.session.transcriptArchive.pendingMessages = [];
    }
    if (state.session.modelContextArchive) {
      state.session.modelContextArchive.pendingMessages = [];
    }
    state.session.workflow = null;
    state.session.context = null;
    state.session.contextWindow = null;
    state.session.workspaceDiagnostic = null;
    state.session.usage = null;
    state.session.lastProviderUsage = null;
  }
}

async function ensureTurnState(active, options) {
  let state = options.sessionId ? active.get(options.sessionId) : null;
  if (state) {
    if (options.runTurn) {
      state.runTurn = options.runTurn;
    }
    if (!state.running && options.config) {
      applySessionConfig(state.session, configForExistingSession(state.session, options.config));
    }
    if (!state.running) {
      if (state.session.goal?.enabled) {
        applyPermissionMode(state.session, "fullAccess");
      } else if (options.mode) {
        applyPermissionMode(state.session, options.mode);
      }
    }
    return state;
  }
  return withKeyedMutation(options.activeCapacityLocks, "active-capacity", async () => {
    state = options.sessionId ? active.get(options.sessionId) : null;
    if (state) {
      return state;
    }
    const policy = options.activePolicy ?? DASHBOARD_ACTIVE_SESSION_DEFAULTS;
    if (active.size >= policy.max) {
      await reclaimActiveSessions(active, {
        cwd: options.cwd,
        env: options.env,
        sessionMutationLocks: options.sessionMutationLocks,
        policy,
        ttlOnly: false,
        targetSize: policy.max - 1
      });
    }
    if (active.size >= policy.max) {
      throw new ActiveSessionCapacityError();
    }
    const session = await createSession({
      cwd: options.cwd,
      mode: "interactive",
      clientSurface: "dashboard",
      env: options.env,
      resume: options.sessionId || null,
      resumeFullContext: Boolean(options.sessionId),
      readonly: false,
      allowWrite: options.mode === "workspace",
      allowCommand: options.mode === "workspace",
      fullAccess: options.mode === "fullAccess"
    });
    if (!options.sessionId) {
      if (options.config) {
        applySessionConfig(session, options.config);
      }
      if (options.modelId) {
        applySessionModel(session, options.modelId);
      }
      if (options.reasoningEffort) {
        applySessionReasoningEffort(session, options.reasoningEffort);
      }
    }
    applyPermissionMode(session, session.goal?.enabled ? "fullAccess" : (options.mode ?? "plan"));
    state = createTurnState(session, options.runTurn, { persisted: Boolean(options.sessionId) });
    active.set(session.id, state);
    return state;
  });
}

function applySessionModel(session, modelId) {
  const id = String(modelId ?? "").trim();
  if (!id) {
    return;
  }
  session.model = id;
  session.config = { ...session.config, modelAlias: id };
  refreshSessionContextWindow(session);
  refreshDashboardSessionModelSelection(session);
}

/** @param {Record<string, any>} session @param {unknown} reasoningEffort */
function applySessionReasoningEffort(session, reasoningEffort) {
  const effort = String(reasoningEffort ?? "").trim().toLowerCase();
  const model = listConfiguredModels(session.config ?? {}).find((item) => item.id === String(session.model ?? "").trim());
  const normalized = resolveReasoningEffortSelection(model, effort, model?.defaultReasoningEffort ?? "");
  session.config = { ...session.config, reasoningEffort: normalized || null };
  refreshDashboardSessionModelSelection(session);
}

function applySessionConfig(session, config) {
  const id = String(config.modelAlias ?? session.model ?? "").trim();
  session.model = id;
  session.config = { ...config, modelAlias: id };
  session.modelSelectionInvalidation = null;
  session.pendingModelSelectionMutation = null;
  refreshSessionContextWindow(session);
  refreshDashboardSessionModelSelection(session);
}

/** @param {Record<string, any>} session */
function refreshDashboardSessionModelSelection(session) {
  session.modelSelection = currentRuntimeModelSelection(session.config ?? {}, {
    model: session.model,
    reasoningEffort: session.config?.reasoningEffort
  });
}

function refreshSessionContextWindow(session) {
  const previous = session.contextWindow ?? {};
  const next = createContextWindow(session.config ?? {});
  session.contextWindow = {
    ...next,
    summary: typeof previous.summary === "string" ? previous.summary : next.summary,
    compactionCount: Number.isFinite(previous.compactionCount) ? previous.compactionCount : next.compactionCount,
    compactedMessages: Number.isFinite(previous.compactedMessages) ? previous.compactedMessages : next.compactedMessages,
    lastCompactedAt: previous.lastCompactedAt ?? next.lastCompactedAt,
    lastReason: previous.lastReason ?? next.lastReason,
    lastStrategy: previous.lastStrategy ?? next.lastStrategy,
    lastFallbackReason: previous.lastFallbackReason ?? next.lastFallbackReason,
    lastInternalAgent: previous.lastInternalAgent ?? next.lastInternalAgent
  };
}

function configForExistingSession(session, config) {
  const currentModel = String(session.model ?? "").trim();
  if (isConfigV2Enabled(config)) {
    const currentSelection = currentRuntimeModelSelection(session.config ?? {}, {
      model: currentModel,
      reasoningEffort: session.config?.reasoningEffort
    }) ?? session.modelSelection ?? null;
    const resolution = resolveSessionModelSelection(config, currentSelection
      ? { model: currentModel, modelSelection: currentSelection }
      : { model: currentModel });
    if (resolution.status !== "resolved") {
      throw new SessionModelSelectionUnresolvedError(resolution);
    }
    return configForDashboardSelection(config, {
      providerId: resolution.selection.provider,
      modelId: resolution.selection.model,
      reasoningEffort: resolution.selection.reasoningEffort ?? null
    });
  }
  const providerId = isConfigV2Enabled(config) ? activeGatewayProfileId(session.config) : "";
  const selectedConfig = providerId
    ? configForGatewayProfileSelection(config, providerId)
    : config;
  if (currentModel && listConfiguredModels(selectedConfig).some((model) => model.id === currentModel)) {
    const sessionDefinesEffort = Object.prototype.hasOwnProperty.call(session.config ?? {}, "reasoningEffort")
      && session.config.reasoningEffort !== undefined;
    return configWithModelSelection(
      selectedConfig,
      currentModel,
      sessionDefinesEffort ? session.config.reasoningEffort : undefined,
      { explicitReasoningEffort: sessionDefinesEffort }
    );
  }
  return config;
}

function activeStateForSession(active, sessionId) {
  const id = String(sessionId ?? "").trim();
  return id ? active.get(id) ?? null : null;
}

function configForStatusLists(sessionConfig, refreshedConfig) {
  const sessionDefinesEffort = Object.prototype.hasOwnProperty.call(sessionConfig ?? {}, "reasoningEffort")
    && sessionConfig.reasoningEffort !== undefined;
  return {
    ...refreshedConfig,
    modelAlias: sessionConfig.modelAlias ?? refreshedConfig.modelAlias,
    reasoningEffort: sessionDefinesEffort
      ? sessionConfig.reasoningEffort
      : refreshedConfig.reasoningEffort ?? null
  };
}

function sessionStatusForConfigUpdate(session, config) {
  if (!session) {
    return sessionStatusFromConfig(config);
  }
  const current = sessionStatusSummary(session);
  const configured = sessionStatusFromConfig(config);
  return {
    ...current,
    model: current.model || configured.model,
    context: {
      ...(current.context ?? {}),
      maxTokens: configured.context?.maxTokens ?? current.context?.maxTokens,
      maxBytes: configured.context?.maxBytes ?? current.context?.maxBytes,
      modelMaxTokens: configured.context?.modelMaxTokens ?? current.context?.modelMaxTokens
    }
  };
}

function syncIdleSessionConfig(active, sessionId, config) {
  const id = String(sessionId ?? "").trim();
  if (!id) {
    return null;
  }
  const state = active.get(id);
  if (!state || state.running) {
    return null;
  }
  applySessionConfig(state.session, config);
  state.persisted = false;
  appendDashboardEvent(state, {
    type: "session_config_updated",
    id: eventId("session-config"),
    sessionStatus: sessionStatusSummary(state.session),
    at: new Date().toISOString()
  });
  return state;
}

/**
 * Persist one complete provider/model/effort selection without touching the
 * Config V2 default. Active and archived sessions share this commit path so a
 * process restart cannot change the provider behind a historical model name.
 *
 * @param {{
 *   active: Map<string, Record<string, any>>;
 *   sessionMutationLocks: Map<string, Promise<any>>;
 *   cwd: string;
 *   env: NodeJS.ProcessEnv;
 *   sessionId: string;
 *   config: Record<string, any>;
 *   expectedSelection?: Record<string, any> | null;
 *   lockHeld?: boolean;
 * }} options
 */
async function persistDashboardSessionModelConfig(options) {
  const selection = currentRuntimeModelSelection(options.config, {
    model: options.config.modelAlias,
    reasoningEffort: options.config.reasoningEffort
  });
  if (isConfigV2Enabled(options.config) && !selection) {
    return {
      ok: false,
      status: 409,
      code: "SESSION_MODEL_SELECTION_UNRESOLVED",
      error: "模型来源、模型或思考强度不再有效，请重新选择"
    };
  }

  const persist = async () => {
    const state = options.active.get(options.sessionId);
    if (state?.running) {
      return {
        ok: false,
        status: 409,
        code: "SESSION_RUNNING",
        error: "任务运行中，结束或中断后再切换模型"
      };
    }
    if (state) {
      const currentSelection = currentRuntimeModelSelection(state.session.config, {
        model: state.session.model,
        reasoningEffort: state.session.config?.reasoningEffort
      });
      if (options.expectedSelection && !sameRuntimeModelSelection(currentSelection, options.expectedSelection)) {
        return sessionModelSelectionChangedResult(options.sessionId);
      }
      const previous = {
        model: state.session.model,
        modelSelection: state.session.modelSelection,
        config: state.session.config,
        contextWindow: state.session.contextWindow,
        persisted: state.persisted
      };
      applySessionConfig(state.session, options.config);
      state.session.modelSelection = selection;
      state.persisted = false;
      try {
        await persistSessionSnapshot(state.session, { env: options.env });
        state.persisted = true;
      } catch {
        state.session.model = previous.model;
        state.session.modelSelection = previous.modelSelection;
        state.session.config = previous.config;
        state.session.contextWindow = previous.contextWindow;
        state.persisted = previous.persisted;
        return {
          ok: false,
          status: 500,
          code: "SESSION_MODEL_SELECTION_PERSIST_FAILED",
          error: "模型选择未能安全保存，操作已回退，请重试"
        };
      }
      return { ok: true, state, sessionStatus: sessionStatusSummary(state.session) };
    }

    const store = createSessionStore({
      cwd: options.cwd,
      transcript: options.config.transcript,
      env: options.env
    });
    const committed = /** @type {Record<string, any>} */ (await store.withSessionMutation(options.sessionId, async () => {
      const current = await store.readMetadataExact(options.sessionId, { lockHeld: true });
      if (!current.ok) return current;
      if (options.expectedSelection && isConfigV2Enabled(options.config)) {
        const resolution = resolveSessionModelSelection(options.config, current.metadata);
        if (
          resolution.status !== "resolved"
          || !sameRuntimeModelSelection(resolution.selection, options.expectedSelection)
        ) {
          return sessionModelSelectionChangedResult(options.sessionId);
        }
      }
      const metadata = isConfigV2Enabled(options.config)
        ? patchSessionModelSelectionMetadata(current.metadata, /** @type {Record<string, any>} */ (selection))
        : {
            ...current.metadata,
            model: options.config.modelAlias,
            reasoningEffort: options.config.reasoningEffort ?? null
          };
      await store.writeMetadata(metadata, { lockHeld: true });
      return { ok: true, metadata };
    }));
    if (!committed.ok) {
      if (committed.status) return committed;
      return {
        ok: false,
        status: committed.error?.code === "SESSION_NOT_FOUND" ? 404 : 500,
        code: committed.error?.code ?? "SESSION_MODEL_SELECTION_PERSIST_FAILED",
        error: committed.error?.message ?? "模型选择未能安全保存"
      };
    }
    return {
      ok: true,
      state: null,
      metadata: committed.metadata,
      sessionStatus: sessionStatusFromMetadata(committed.metadata, options.config)
    };
  };
  return options.lockHeld === true
    ? persist()
    : withKeyedMutation(options.sessionMutationLocks, options.sessionId, persist);
}

/** @param {Record<string, any> | null | undefined} left @param {Record<string, any> | null | undefined} right */
function sameRuntimeModelSelection(left, right) {
  if (!left || !right) return false;
  return String(left.provider ?? "") === String(right.provider ?? "")
    && String(left.model ?? "") === String(right.model ?? "")
    && String(left.reasoningEffort ?? "") === String(right.reasoningEffort ?? "");
}

/** @param {string} sessionId */
function sessionModelSelectionChangedResult(sessionId) {
  return {
    ok: false,
    status: 409,
    code: "SESSION_MODEL_SELECTION_CHANGED",
    error: "模型选择已经变化，请刷新后重试",
    sessionId
  };
}

/** @param {Record<string, any>} resolution @param {string} [sessionId] */
function unresolvedSessionModelSelectionResult(resolution, sessionId = "") {
  return {
    ok: false,
    status: 409,
    code: "SESSION_MODEL_SELECTION_UNRESOLVED",
    error: "当前会话的模型来源无法确定，请重新选择模型来源和模型",
    sessionId,
    reason: resolution?.reason ?? "legacy-no-match",
    model: resolution?.model ?? resolution?.selection?.model ?? "",
    candidates: Array.isArray(resolution?.candidates) ? resolution.candidates.slice() : []
  };
}

/** @param {{ cwd: string; env: NodeJS.ProcessEnv; config: Record<string, any>; sessionId: string }} options */
async function readDashboardSessionMetadataExact(options) {
  const store = createSessionStore({
    cwd: options.cwd,
    transcript: options.config.transcript,
    env: options.env
  });
  const result = await store.readMetadataExact(options.sessionId);
  if (result.ok) return result;
  return {
    ok: false,
    status: result.error?.code === "SESSION_NOT_FOUND" ? 404 : 500,
    code: result.error?.code ?? "SESSION_METADATA_READ_ERROR",
    error: result.error?.message ?? "无法读取会话"
  };
}

/**
 * Refresh an idle session after a settings mutation. If its exact selection
 * was removed, keep that identity visible but detach all gateway credentials
 * so the next turn is blocked until the user explicitly repairs it.
 *
 * @param {{ active: Map<string, Record<string, any>>; cwd: string; env: NodeJS.ProcessEnv; sessionId: string; config: Record<string, any> }} options
 */
async function refreshDashboardSessionAfterV2Mutation(options) {
  if (!options.sessionId) return null;
  const state = options.active.get(options.sessionId);
  if (state) {
    return applyDashboardSessionV2MutationView(state, dashboardSessionV2MutationView(state.session, options.config));
  }

  const archived = await readDashboardSessionMetadataExact({
    cwd: options.cwd,
    env: options.env,
    config: options.config,
    sessionId: options.sessionId
  });
  if (!archived.ok) return null;
  return {
    state: null,
    config: options.config,
    sessionStatus: sessionStatusFromMetadata(archived.metadata, options.config),
    resolution: resolveSessionModelSelection(options.config, archived.metadata)
  };
}

/** @param {Record<string, any>} session @param {Record<string, any>} config */
function dashboardSessionV2MutationView(session, config) {
  const previousSelection = currentRuntimeModelSelection(session.config ?? {}, {
    model: session.model,
    reasoningEffort: session.config?.reasoningEffort
  }) ?? session.modelSelection ?? null;
  const resolution = resolveSessionModelSelection(config, previousSelection
    ? { model: session.model, modelSelection: previousSelection }
    : { model: session.model });
  const nextConfig = resolution.status === "resolved"
    ? configForDashboardSelection(config, {
        providerId: resolution.selection.provider,
        modelId: resolution.selection.model,
        reasoningEffort: resolution.selection.reasoningEffort ?? null
      })
    : configForUnresolvedSessionSelection(config, previousSelection, session);
  return { previousSelection, resolution, config: nextConfig };
}

/** @param {Record<string, any>} state @param {Record<string, any>} view */
function applyDashboardSessionV2MutationView(state, view) {
  applySessionConfig(state.session, view.config);
  if (view.resolution.status !== "resolved" && view.previousSelection) {
    state.session.modelSelection = { ...view.previousSelection };
    state.session.modelSelectionInvalidation = view.resolution;
  }
  return {
    state,
    config: view.config,
    sessionStatus: sessionStatusSummary(state.session),
    resolution: view.resolution
  };
}

/**
 * Publish a V2 mutation to every in-memory session synchronously. Running
 * turns retain their current gateway until they settle, but their queued work
 * is cancelled and all later admission is blocked by the invalidation marker.
 *
 * @param {Map<string, Record<string, any>>} active
 * @param {Record<string, any>} config
 */
function reconcileActiveDashboardSessionsAfterV2Mutation(active, config) {
  const views = new Map();
  for (const state of active.values()) {
    const view = dashboardSessionV2MutationView(state.session, config);
    if (!state.running) {
      views.set(state.session.id, applyDashboardSessionV2MutationView(state, view));
      continue;
    }
    if (view.resolution.status !== "resolved") {
      invalidateRunningDashboardSessionSelection(state, view);
    }
    views.set(state.session.id, {
      state,
      config: view.config,
      sessionStatus: sessionStatusSummary(state.session),
      resolution: view.resolution
    });
  }
  return views;
}

/** @param {Record<string, any>} state @param {Record<string, any>} view */
function invalidateRunningDashboardSessionSelection(state, view) {
  state.session.modelSelectionInvalidation = view.resolution;
  state.session.pendingModelSelectionMutation = view;
  cancelAllQueuedTurns(state, "model-selection-invalidated");
  appendDashboardEvent(state, {
    type: "session_config_updated",
    id: eventId("session-config"),
    sessionStatus: sessionStatusSummary(state.session),
    at: new Date().toISOString()
  });
}

/** @param {Record<string, any>} config @param {Record<string, any> | null} selection @param {Record<string, any>} session */
function configForUnresolvedSessionSelection(config, selection, session) {
  const providerId = String(selection?.provider ?? session?.config?.lab?.activeGatewayProfile ?? "").trim();
  const modelId = String(selection?.model ?? session?.model ?? "").trim();
  const reasoningEffort = String(selection?.reasoningEffort ?? session?.config?.reasoningEffort ?? "").trim().toLowerCase();
  return {
    ...config,
    modelAlias: modelId,
    reasoningEffort: reasoningEffort || null,
    lab: {
      ...(config.lab ?? {}),
      activeGatewayProfile: providerId,
      gatewayUrl: null,
      gatewayHealthUrl: null,
      gatewayApiKey: null,
      gatewayApiKeyDisabled: true
    }
  };
}

/**
 * @param {Record<string, any>} config
 * @param {unknown} modelId
 * @param {unknown} reasoningEffort
 * @param {{ explicitReasoningEffort?: boolean }} [options]
 */
function configWithModelSelection(config, modelId = "", reasoningEffort = undefined, options = {}) {
  const selectedModel = String(modelId ?? "").trim() || String(config.modelAlias ?? "").trim();
  const model = listConfiguredModels({ ...config, modelAlias: selectedModel }).find((item) => item.id === selectedModel);
  const requestedEffort = options.explicitReasoningEffort === true
    ? reasoningEffort
    : config.reasoningEffort;
  const effort = resolveReasoningEffortSelection(
    model,
    requestedEffort,
    model?.defaultReasoningEffort
  );
  return {
    ...config,
    modelAlias: selectedModel,
    reasoningEffort: effort || null
  };
}

/** @param {Record<string, any>} config @param {Record<string, any> | null | undefined} selection */
function configForDashboardSelection(config, selection) {
  const providerId = String(selection?.providerId ?? selection?.provider ?? "").trim();
  const selected = providerId ? configForGatewayProfileSelection(config, providerId) : config;
  const requestedModel = String(selection?.modelId ?? selection?.model ?? "").trim();
  const modelId = requestedModel && listConfiguredModels(selected).some((model) => model.id === requestedModel)
    ? requestedModel
    : String(selected.modelAlias ?? "").trim();
  return configWithModelSelection(selected, modelId, selection?.reasoningEffort, {
    explicitReasoningEffort: Boolean(providerId || requestedModel)
  });
}

/** @param {Record<string, any>} config */
function isConfigV2Enabled(config) {
  return config?.configV2?.enabled === true;
}

/** @param {Record<string, any>} config @param {unknown} profileId */
function configForGatewayProfileSelection(config, profileId) {
  const id = String(profileId ?? "").trim();
  if (!id || id === activeGatewayProfileId(config)) return config;
  const profile = gatewayProfilesFromConfig(config).find((item) => item.id === id);
  if (!profile) return config;
  const modelAlias = String(profile.modelAlias ?? profile.models?.[0]?.id ?? "").trim();
  if (isConfigV2Enabled(config)) {
    const reasoningEffort = defaultReasoningEffortForConfig(
      { models: profile.models, modelAlias },
      modelAlias
    );
    const applied = applyRuntimeModelSelection(config, {
      provider: id,
      model: modelAlias,
      ...(reasoningEffort ? { reasoningEffort } : {})
    });
    return applied.status === "resolved" ? applied.config : config;
  }
  const agents = isPlainObject(profile.agents) ? profile.agents : {};
  return {
    ...config,
    modelAlias,
    defaultModelAlias: modelAlias,
    models: profile.models.map(modelConfigEntry),
    reasoningEffort: defaultReasoningEffortForConfig({ models: profile.models, modelAlias }, modelAlias) || null,
    agents: replaceGatewayAgentRoutes(config.agents, agents),
    lab: {
      ...(config.lab ?? {}),
      activeGatewayProfile: id,
      gatewayUrl: profile.gatewayUrl,
      gatewayHealthUrl: profile.gatewayHealthUrl,
      gatewayProtocol: profile.gatewayProtocol,
      gatewayApiKey: profile.gatewayApiKey,
      gatewayApiKeyDisabled: profile.gatewayApiKeyDisabled === true
    }
  };
}

/** @param {Map<string, Record<string, any>>} selections @param {unknown} clientId @param {Record<string, any>} fallback */
function dashboardRuntimeSelection(selections, clientId, fallback) {
  const id = normalizeDashboardClientId(clientId);
  if (!id) return { ...fallback };
  const selected = selections.get(id);
  return selected ? { ...selected } : {};
}

/** @param {Map<string, Record<string, any>>} selections @param {unknown} clientId @param {Record<string, any>} selection */
function rememberDashboardRuntimeSelection(selections, clientId, selection) {
  const id = normalizeDashboardClientId(clientId);
  if (!id) return;
  selections.delete(id);
  selections.set(id, {
    providerId: String(selection.providerId ?? "").trim(),
    modelId: String(selection.modelId ?? "").trim(),
    reasoningEffort: String(selection.reasoningEffort ?? "").trim().toLowerCase()
  });
  while (selections.size > 100) {
    const oldest = selections.keys().next().value;
    if (typeof oldest !== "string") break;
    selections.delete(oldest);
  }
}

/**
 * Remove ephemeral tab selections that no longer resolve after a provider or
 * model deletion, and return a valid process fallback for clients without ids.
 *
 * @param {Map<string, Record<string, any>>} selections
 * @param {Record<string, any>} config
 * @param {Record<string, any>} fallback
 */
function reconcileDashboardRuntimeSelections(selections, config, fallback) {
  for (const [clientId, selection] of selections) {
    if (!dashboardSelectionResolution(config, selection)) {
      selections.delete(clientId);
    }
  }
  const resolvedFallback = dashboardSelectionResolution(config, fallback);
  if (resolvedFallback) {
    return {
      providerId: resolvedFallback.provider,
      modelId: resolvedFallback.model,
      reasoningEffort: resolvedFallback.reasoningEffort ?? ""
    };
  }
  const selection = currentRuntimeModelSelection(config, {
    model: config.modelAlias,
    reasoningEffort: config.reasoningEffort
  });
  return {
    providerId: selection?.provider ?? "",
    modelId: selection?.model ?? String(config.modelAlias ?? "").trim(),
    reasoningEffort: selection?.reasoningEffort ?? String(config.reasoningEffort ?? "").trim()
  };
}

/** @param {Record<string, any>} config @param {Record<string, any>} selection */
function dashboardSelectionResolution(config, selection) {
  const provider = String(selection?.providerId ?? selection?.provider ?? "").trim();
  const model = String(selection?.modelId ?? selection?.model ?? "").trim();
  if (!provider || !model) return null;
  const resolution = resolveSessionModelSelection(config, {
    model,
    modelSelection: {
      provider,
      model,
      ...(selection?.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {})
    }
  });
  return resolution.status === "resolved" ? resolution.selection : null;
}

/** @param {unknown} value */
function normalizeDashboardClientId(value) {
  const id = String(value ?? "").trim();
  return id && id.length <= 160 && !/[\u0000-\u001f\u007f]/.test(id) ? id : "";
}

/** @param {Record<string, any>} config @param {unknown} modelId */
function defaultReasoningEffortForConfig(config, modelId = "") {
  const selectedModel = String(modelId ?? config.modelAlias ?? "").trim();
  const model = listConfiguredModels(config).find((item) => item.id === selectedModel);
  return resolveReasoningEffortSelection(model, undefined, model?.defaultReasoningEffort);
}

/** @param {Record<string, any> | null | undefined} model @param {unknown} requested @param {unknown} fallback */
function resolveReasoningEffortSelection(model, requested, fallback = undefined) {
  const efforts = normalizeReasoningEfforts(model?.reasoningEfforts);
  if (efforts.length === 0) return "";
  if (requested !== undefined) {
    const requestedId = String(requested ?? "").trim().toLowerCase();
    return efforts.some((effort) => effort.id === requestedId) ? requestedId : "";
  }
  const fallbackId = String(fallback ?? "").trim().toLowerCase();
  return efforts.some((effort) => effort.id === fallbackId) ? fallbackId : "";
}

function modelOptions(config) {
  const current = String(config.modelAlias ?? "").trim();
  const defaultModel = String(config.defaultModelAlias ?? config.modelAlias ?? "").trim();
  const sources = config.configSources ?? {};
  return listConfiguredModels(config).map((model) => publicModelOption(model, current, defaultModel, sources, {
    source: activeGatewaySource(config, model.id),
    reasoningEffort: model.id === current ? config.reasoningEffort : ""
  }));
}

/** @param {Record<string, any>} model @param {string} currentModelId @param {string} defaultModelId @param {Record<string, any>} sources @param {Record<string, any>} options */
function publicModelOption(model, currentModelId = "", defaultModelId = "", sources = {}, options = {}) {
  const reasoningEfforts = normalizeReasoningEfforts(model.reasoningEfforts);
  const selectedReasoningEffort = resolveReasoningEffortSelection(
    { ...model, reasoningEfforts },
    options.reasoningEffort,
    model.defaultReasoningEffort
  );
  return {
    id: model.id,
    label: model.label,
    description: model.description,
    thinking: model.thinking === true,
    modalities: Array.isArray(model.modalities) && model.modalities.length > 0 ? model.modalities : ["text"],
    contextTokens: Number.isFinite(model.contextTokens) ? model.contextTokens : null,
    source: options.source ?? null,
    reasoningEfforts,
    defaultReasoningEffort: reasoningEfforts.some((effort) => effort.id === model.defaultReasoningEffort)
      ? model.defaultReasoningEffort
      : null,
    reasoningEffort: selectedReasoningEffort || null,
    agentModelTiers: normalizeAgentModelTiers(model.agentModelTiers),
    sources: {
      modelAlias: publicConfigSource(sources.modelAlias),
      models: publicConfigSource(sources.models)
    },
    current: model.id === currentModelId,
    default: model.id === defaultModelId
  };
}

function modelContextTokens(config) {
  const current = String(config?.modelAlias ?? "").trim();
  const model = listConfiguredModels(config ?? {}).find((item) => item.id === current);
  return Number.isFinite(model?.contextTokens) ? model.contextTokens : null;
}

function publicGatewayConfig(config) {
  return {
    gatewayUrl: publicGatewayUrl(config.lab?.gatewayUrl),
    gatewayHealthUrl: publicGatewayUrl(config.lab?.gatewayHealthUrl),
    gatewayProtocol: config.lab?.gatewayProtocol ?? "openai-chat",
    supportedProtocols: [...GATEWAY_PROTOCOLS],
    apiKeyConfigured: Boolean(config.lab?.gatewayApiKey),
    activeProfileId: activeGatewayProfileId(config),
    globalConfigPath: config.globalConfigPath ?? "",
    projectConfigPath: config.projectConfigPath ?? "",
    sources: {
      gatewayUrl: publicConfigSource(config.lab?.sources?.gatewayUrl ?? config.configSources?.lab?.gatewayUrl),
      gatewayHealthUrl: publicConfigSource(config.lab?.sources?.gatewayHealthUrl ?? config.configSources?.lab?.gatewayHealthUrl),
      gatewayProtocol: publicConfigSource(config.lab?.sources?.gatewayProtocol ?? config.configSources?.lab?.gatewayProtocol),
      apiKey: publicConfigSource(config.lab?.sources?.gatewayApiKey ?? config.configSources?.lab?.gatewayApiKey)
    }
  };
}

/** @param {Record<string, any>} config @param {NodeJS.ProcessEnv} env */
function publicDashboardSettings(config, env = {}) {
  const transcript = isPlainObject(config.transcript) ? config.transcript : {};
  const orchestration = isPlainObject(config.agents?.orchestration) ? config.agents.orchestration : {};
  const backgroundWakeup = isPlainObject(config.agents?.backgroundWakeup) ? config.agents.backgroundWakeup : {};
  const reviewGate = isPlainObject(config.agents?.reviewGate) ? config.agents.reviewGate : {};
  const sensitivity = config.security?.sensitivity === "high" ? "high" : "standard";
  const managedAllowedHosts = dashboardManagedAllowedHosts(env);
  return {
    transcript: {
      enabled: transcript.enabled !== false,
      retentionDays: transcript.retentionDays === null
        ? null
        : Number.isFinite(transcript.retentionDays) ? transcript.retentionDays : 30,
      encryption: ["off", "optional", "required"].includes(transcript.encryption) ? transcript.encryption : "off",
      encryptionKeyConfigured: Boolean(String(env.LAB_AGENT_TRANSCRIPT_KEY ?? "").trim())
    },
    network: {
      mode: NETWORK_MODES.includes(config.networkMode) ? config.networkMode : "approved-web",
      allowedModes: sensitivity === "high" ? ["offline", "lab-only"] : [...NETWORK_MODES],
      sensitivity,
      allowedHosts: Array.isArray(config.allowedHosts) ? [...config.allowedHosts] : [],
      managedAllowedHosts
    },
    agents: {
      maxParallelReadonlyAgentRuns: Math.min(8, Math.max(1, Number(orchestration.maxParallelReadonlyAgentRuns) || 3)),
      backgroundWakeupEnabled: backgroundWakeup.enabled !== false,
      backgroundByDefault: backgroundWakeup.defaultForModelAgentRun === true,
      reviewGateEnabled: reviewGate.enabled !== false,
      syncModelTiersOnSwitch: config.agents?.syncModelTiersOnSwitch !== false,
      goalMaxAutoContinues: resolveGoalMaxAutoContinues(config)
    },
    reliability: {
      maxRetries: Number(config.lab?.gatewayMaxRetries ?? 5),
      timeoutMs: Number(config.lab?.gatewayTimeoutMs ?? 900000),
      idleTimeoutMs: Number(config.lab?.gatewayIdleTimeoutMs ?? 300000)
    },
    managed: {
      transcriptEnabled: hasRuntimeEnvValue(env, "LAB_AGENT_TRANSCRIPT_ENABLED"),
      transcriptRetentionDays: hasRuntimeEnvValue(env, "LAB_AGENT_TRANSCRIPT_RETENTION_DAYS"),
      transcriptEncryption: hasRuntimeEnvValue(env, "LAB_AGENT_TRANSCRIPT_ENCRYPTION"),
      networkMode: hasRuntimeEnvValue(env, "LAB_AGENT_NETWORK_MODE"),
      gatewayMaxRetries: hasRuntimeEnvValue(env, "LAB_MODEL_GATEWAY_MAX_RETRIES"),
      gatewayTimeoutMs: hasRuntimeEnvValue(env, "LAB_MODEL_GATEWAY_TIMEOUT_MS"),
      gatewayIdleTimeoutMs: hasRuntimeEnvValue(env, "LAB_MODEL_GATEWAY_IDLE_TIMEOUT_MS")
    }
  };
}

function publicGatewayProfiles(config) {
  const active = activeGatewayProfileId(config);
  return gatewayProfilesFromConfig(config).map((profile) => {
    const owner = gatewayProfileOwner(config, profile.id);
    const ownerScope = String(owner?.type ?? "").trim();
    const profileConfig = {
      models: profile.models,
      modelAlias: profile.modelAlias,
      reasoningEffort: profile.id === active ? config.reasoningEffort : ""
    };
    const models = listConfiguredModels(profileConfig).map((model) => publicModelOption(
      model,
      profile.id === active ? String(config.modelAlias ?? profile.modelAlias ?? "") : profile.modelAlias,
      profile.modelAlias,
      {},
      {
        source: gatewayProfileModelSource(config, profile, model.id),
        reasoningEffort: profile.id === active ? config.reasoningEffort : ""
      }
    ));
    return {
      id: profile.id,
      label: profile.label || profile.id,
      gatewayUrl: publicGatewayUrl(profile.gatewayUrl),
      gatewayHealthUrl: publicGatewayUrl(profile.gatewayHealthUrl),
      gatewayProtocol: profile.gatewayProtocol || "openai-chat",
      apiKeyConfigured: Boolean(profile.gatewayApiKey) || (profile.id === active && Boolean(config.lab?.gatewayApiKey)),
      modelAlias: profile.modelAlias || "",
      modelCount: models.length,
      models,
      agentModelTiers: normalizeAgentModelTiers(profile.agents?.modelTiers),
      visionAgent: publicVisionAgent({ agents: { vision: profile.agents?.vision } }),
      ownerScope,
      saveTarget: ownerScope === "project" || ownerScope === "global" ? ownerScope : "",
      editable: ownerScope === "project" || ownerScope === "global",
      ready: Boolean(parseConfigUrl(profile.gatewayUrl) && GATEWAY_PROTOCOLS.includes(profile.gatewayProtocol) && models.length > 0),
      current: profile.id === active
    };
  });
}

/** @param {Record<string, any>} config @param {string} profileId */
function gatewayProfileOwner(config, profileId) {
  const v2Owner = String(config?.configV2?.provenance?.providers?.[profileId] ?? "").trim();
  if (v2Owner) {
    return { type: v2Owner, label: v2Owner };
  }
  const sources = config?.configSources?.lab?.gatewayProfiles;
  if (Array.isArray(sources)) {
    return sources.find((source) => String(source?.id ?? "").trim() === profileId) ?? null;
  }
  return isPlainObject(sources?.[profileId]) ? sources[profileId] : null;
}

/** @param {Record<string, any>} config @param {string} [modelId] */
function activeGatewaySource(config, modelId = "") {
  const active = activeGatewayProfileId(config);
  const profile = gatewayProfilesFromConfig(config).find((item) => item.id === active)
    ?? gatewayProfileFromConfig(config, { id: active });
  return gatewayProfileModelSource(config, profile, modelId);
}

/** @param {Record<string, any>} config @param {Record<string, any> | null | undefined} profile @param {string} modelId */
function gatewayProfileModelSource(config, profile, modelId) {
  const source = publicGatewaySource(profile);
  if (!source) return null;
  const owner = gatewayProfileOwner(config, String(profile?.id ?? ""));
  const ownerScope = String(owner?.modelScopes?.[modelId] ?? owner?.type ?? "default").trim();
  return {
    ...source,
    ownerScope,
    saveTarget: ownerScope === "project" || ownerScope === "global" ? ownerScope : "",
    editable: ownerScope === "project" || ownerScope === "global"
  };
}

/** @param {Record<string, any> | null | undefined} profile */
function publicGatewaySource(profile) {
  if (!profile) return null;
  return {
    id: String(profile.id ?? ""),
    profileId: String(profile.id ?? ""),
    label: String(profile.label ?? "").trim() || gatewayProfileLabel(profile.gatewayUrl, profile.gatewayProtocol),
    protocol: String(profile.gatewayProtocol ?? "openai-chat")
  };
}

function publicAgentModelTiers(config) {
  return normalizeAgentModelTiers(config.agents?.modelTiers);
}

function publicVisionAgent(config) {
  const vision = config.agents?.vision ?? {};
  return {
    enabled: vision.enabled !== false,
    model: String(vision.model ?? "").trim(),
    autoUseWhenMainModelTextOnly: vision.autoUseWhenMainModelTextOnly !== false
  };
}

function publicConfigSource(source) {
  if (!source || typeof source !== "object") {
    return { type: "default", label: "default" };
  }
  return {
    type: String(source.type ?? "default"),
    label: String(source.label ?? source.type ?? "default")
  };
}

/** @param {unknown} value */
function boundedGatewayDiscoveryTtl(value) {
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
function rememberGatewayDiscovery(options) {
  const models = Array.isArray(options.models) ? options.models : [];
  const catalog = normalizeCatalogModelInput(
    models.map((model) => String(model?.id ?? "").trim()).filter(Boolean),
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
  const storedCatalog = {
    ids: [...catalog.ids],
    models: clonePlainObject(catalog.models)
  };
  options.discoveries.set(token, {
    expiresAt,
    identity: identity.value,
    catalog: storedCatalog
  });
  return { ok: true, token, expiresAt, catalog: clonePlainObject(storedCatalog) };
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
function resolveGatewayDiscovery(options) {
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
function consumeGatewayDiscovery(discoveries, discovery) {
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
function mergeReasoningProbeIntoCatalog(models, result) {
  const modelId = String(result.modelId ?? "").trim();
  const existingModels = Array.isArray(models) ? clonePlainObject(models) : [];
  const index = existingModels.findIndex((model) => (
    String(model?.id ?? "").trim().toLowerCase() === modelId.toLowerCase()
  ));
  const previous = index >= 0 ? existingModels[index] : null;
  const canonicalId = String(previous?.id ?? modelId).trim() || modelId;
  const probedDefault = String(result.defaultReasoningEffort ?? "").trim().toLowerCase();
  const previousDisabled = normalizeCapabilityEfforts(previous?.reasoningEfforts)
    .find((effort) => isDisabledDiscoveryEffort(effort.id))?.id ?? "";
  const reasoningEfforts = collapseDisabledDiscoveryEfforts(
    normalizeCapabilityEfforts(result.reasoningEfforts),
    isDisabledDiscoveryEffort(probedDefault) ? probedDefault : previousDisabled
  );
  const effortIds = new Set(reasoningEfforts.map((effort) => effort.id));
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
      path: String(result.reasoningDiscovery?.path ?? "").trim() || null,
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
function validateGatewayDiscoveryEntry(options) {
  if (!options.entry) return { ok: true };
  if (!Number.isFinite(options.entry.expiresAt) || options.entry.expiresAt <= options.now) {
    return staleGatewayDiscovery();
  }
  const identity = gatewayDiscoveryRequestIdentity(options.input, options.config, options.secret);
  if (!identity.ok || !isDeepStrictEqual(identity.value, options.entry.identity)) {
    return staleGatewayDiscovery();
  }
  return { ok: true };
}

/** @param {Map<string, Record<string, any>>} discoveries @param {number} now */
function pruneGatewayDiscoveries(discoveries, now) {
  for (const [token, entry] of discoveries) {
    if (!Number.isFinite(entry?.expiresAt) || entry.expiresAt <= now) discoveries.delete(token);
  }
}

/** @returns {GatewayDiscoveryFailure} */
function staleGatewayDiscovery() {
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
function gatewayDiscoveryRequestIdentity(input, config, secret) {
  const protocol = String(input.gatewayProtocol ?? config.lab?.gatewayProtocol ?? "openai-chat").trim();
  if (!GATEWAY_PROTOCOLS.includes(protocol)) {
    return { ok: false, status: 400, error: `不支持的网关协议：${protocol}` };
  }
  const parsed = parseConfigUrl(String(input.gatewayUrl ?? config.lab?.gatewayUrl ?? "").trim());
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
function gatewayDiscoveryConfigIdentity(config) {
  if (!isConfigV2Enabled(config)) return { version: 1 };
  return {
    version: 2,
    global: String(config.configV2?.revisions?.global ?? ""),
    project: String(config.configV2?.revisions?.project ?? ""),
    credentials: String(config.configV2?.revisions?.credentials ?? "")
  };
}

/** @param {Record<string, any>} input @param {Record<string, any>} config */
async function probeGatewayConnection(input, config) {
  const protocol = String(input.gatewayProtocol ?? config.lab?.gatewayProtocol ?? "openai-chat").trim();
  if (!GATEWAY_PROTOCOLS.includes(protocol)) {
    return { ok: false, status: 400, error: `不支持的网关协议：${protocol}` };
  }
  const rawUrl = String(input.gatewayUrl ?? config.lab?.gatewayUrl ?? "").trim();
  const parsed = parseConfigUrl(rawUrl);
  if (!parsed) {
    return { ok: false, status: 400, error: "请输入有效的 API 地址" };
  }
  const modelsUrl = gatewayModelsUrl(parsed);
  const suggestedGatewayUrl = gatewayInferenceUrl(parsed, protocol);
  const publicModelsUrl = publicGatewayUrl(modelsUrl);
  const publicSuggestedGatewayUrl = publicGatewayUrl(suggestedGatewayUrl);
  const gatewayApiKey = probeGatewayCredential(input, config, protocol, parsed.href);
  const headers = /** @type {Record<string, string>} */ ({ accept: "application/json" });
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
      error: error?.name === "TimeoutError" ? "读取模型超时" : "无法连接模型来源",
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
  const models = rawModels.map((model) => publicCatalogModel(model, protocol)).filter(Boolean);
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
async function probeModelReasoningCapabilities(input, config, signal) {
  const protocol = String(input.gatewayProtocol ?? config.lab?.gatewayProtocol ?? "openai-chat").trim();
  if (!["openai-chat", "openai-responses"].includes(protocol)) {
    return { ok: false, status: 400, error: `该协议不支持思考档位检测：${protocol}` };
  }
  const modelId = String(input.modelId ?? input.model ?? "").trim();
  if (!modelId || modelId.length > 160 || /[\r\n\t\0]/.test(modelId)) {
    return { ok: false, status: 400, error: "请输入有效的模型 ID" };
  }
  const rawUrl = String(input.gatewayUrl ?? config.lab?.gatewayUrl ?? "").trim();
  const parsed = parseConfigUrl(rawUrl);
  if (!parsed) {
    return { ok: false, status: 400, error: "请输入有效的 API 地址" };
  }

  const inferenceUrl = gatewayInferenceUrl(parsed, protocol);
  const publicInferenceUrl = publicGatewayUrl(inferenceUrl);
  const gatewayApiKey = probeGatewayCredential(input, config, protocol, parsed.href);
  const headers = /** @type {Record<string, string>} */ ({
    accept: "application/json",
    "content-type": "application/json"
  });
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

/** @param {Record<string, any>} options @param {string} effort */
async function sendReasoningCapabilityProbe(options, effort) {
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
function reasoningProbeHttpFailure(status) {
  if (status === 401 || status === 403) return { kind: "auth", message: "API Key 未通过验证" };
  if (status === 429) return { kind: "rate-limit", message: "模型来源限制了档位检测请求" };
  if (status >= 500) return { kind: "upstream", message: `模型来源返回 HTTP ${status}` };
  if (status >= 300 && status < 400) return { kind: "redirect", message: "模型地址返回重定向，已停止以避免转发凭据" };
  if (![400, 422].includes(status)) return { kind: "endpoint", message: `模型地址返回 HTTP ${status}` };
  return null;
}

/** @param {string} protocol @param {string} modelId @param {string} effort */
function reasoningCapabilityProbeBody(protocol, modelId, effort) {
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
function structuredReasoningErrorField(value) {
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
function normalizedStructuredReasoningField(value) {
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
function publicReasoningProbeAttempt(effort, attempt) {
  return {
    effort,
    status: attempt.failure ? "indeterminate" : attempt.ok ? "accepted" : attempt.reasoningField ? "rejected" : "indeterminate",
    httpStatus: Number.isInteger(attempt.httpStatus) ? attempt.httpStatus : null,
    reasoningField: attempt.reasoningField ?? null,
    failure: attempt.failure?.kind ?? null
  };
}

/** @param {Record<string, any>} input */
function completedReasoningCapabilityProbe(input) {
  const accepted = normalizeCapabilityEfforts(input.acceptedEfforts);
  const preset = inferCatalogReasoning({ id: input.modelId }, { protocol: input.protocol });
  const presetDefault = preset.reasoningDiscovery.source === "known-preset"
    && accepted.some((effort) => effort.id === preset.defaultReasoningEffort)
    ? preset.defaultReasoningEffort
    : null;
  return {
    ok: true,
    protocol: input.protocol,
    modelId: input.modelId,
    inferenceUrl: input.inferenceUrl,
    apiKeyUsed: input.apiKeyUsed,
    outcome: input.outcome,
    acceptedEfforts: accepted.map((effort) => effort.id),
    reasoningEfforts: accepted,
    defaultReasoningEffort: presetDefault,
    reasoningDiscovery: {
      source: "active-probe",
      confidence: input.outcome === "complete" ? "probed" : input.outcome,
      path: input.reasoningField,
      presetId: null,
      supportsReasoning: accepted.length > 0 ? true : null,
      probeAvailable: true,
      warnings: [...new Set(input.warnings ?? [])]
    },
    negativeControl: input.negativeControl,
    efforts: input.efforts,
    diagnostic: {
      stage: input.outcome === "complete" ? "complete" : input.outcome,
      requestCount: 1 + input.efforts.length
    }
  };
}

/** @param {Record<string, any>} input */
function failedReasoningCapabilityProbe(input) {
  return {
    ok: false,
    status: 502,
    error: input.failure.message,
    protocol: input.protocol,
    modelId: input.modelId,
    inferenceUrl: input.inferenceUrl,
    apiKeyUsed: input.apiKeyUsed,
    outcome: "failed",
    acceptedEfforts: [],
    reasoningEfforts: [],
    defaultReasoningEffort: null,
    negativeControl: input.negativeControl,
    efforts: [],
    diagnostic: { stage: input.failure.kind, requestCount: 1 }
  };
}

/** @param {Response} response */
async function cancelProbeResponseBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    // The response status is sufficient; generated content is intentionally discarded.
  }
}

/** @param {AbortSignal | undefined} parentSignal @param {number} timeoutMs */
function createCapabilityProbeAbort(parentSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const abort = (reason) => {
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
function boundedCapabilityProbeTimeout(value) {
  const timeout = Number(value);
  return Number.isInteger(timeout) && timeout >= 25
    ? Math.min(timeout, MODEL_CAPABILITY_PROBE_TOTAL_TIMEOUT_MS)
    : MODEL_CAPABILITY_PROBE_TOTAL_TIMEOUT_MS;
}

/** @param {unknown} value */
function boundedCapabilityProbeResponseBytes(value) {
  const maxBytes = Number(value);
  return Number.isInteger(maxBytes) && maxBytes >= 1024
    ? Math.min(maxBytes, MODEL_CAPABILITY_PROBE_MAX_RESPONSE_BYTES)
    : MODEL_CAPABILITY_PROBE_MAX_RESPONSE_BYTES;
}

/** @param {Record<string, any>} input @param {Record<string, any>} config @param {string} protocol @param {string} gatewayUrl */
function probeGatewayCredential(input, config, protocol, gatewayUrl) {
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
  if (profile?.gatewayApiKey) return profile.gatewayApiKey;
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
  const activeEndpoint = {
    gatewayProtocol: String(config.lab?.gatewayProtocol ?? "openai-chat"),
    gatewayUrl: String(config.lab?.gatewayUrl ?? "")
  };
  return sameGatewayProfileEndpoint(activeEndpoint, requestedEndpoint)
    ? String(config.lab?.gatewayApiKey ?? "")
    : "";
}

/** @param {URL} url */
function gatewayModelsUrl(url) {
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
function gatewayInferenceUrl(url, protocol) {
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
function publicCatalogModel(value, protocol) {
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
async function readProbeResponse(response, options = {}) {
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
function capabilityProbeResponseTooLargeError(message) {
  const error = new Error(message);
  /** @type {any} */ (error).code = "MODEL_CAPABILITY_PROBE_RESPONSE_TOO_LARGE";
  return error;
}

/** @param {unknown} error */
function capabilityProbeResponseTooLarge(error) {
  return error instanceof Error
    && /** @type {any} */ (error).code === "MODEL_CAPABILITY_PROBE_RESPONSE_TOO_LARGE";
}

/** @param {Record<string, any>} input @param {Record<string, any>} config @param {NodeJS.ProcessEnv} [env] */
function normalizeDashboardSettingsInput(input, config, env = {}) {
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
    if (!NETWORK_MODES.includes(mode)) {
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
function buildDashboardSettingsConfig(targetConfig, normalized) {
  const target = isPlainObject(targetConfig) ? targetConfig : {};
  const changedFields = new Set(Array.isArray(normalized.changedFields)
    ? normalized.changedFields
    : DASHBOARD_SETTINGS_FIELDS[normalized.section] ?? []);
  if (changedFields.size === 0) {
    return { ...target };
  }
  if (normalized.section === "transcript") {
    const transcript = { ...(isPlainObject(target.transcript) ? target.transcript : {}) };
    if (changedFields.has("enabled")) transcript.enabled = normalized.values.enabled;
    if (changedFields.has("retentionDays")) transcript.retentionDays = normalized.values.retentionDays;
    if (changedFields.has("encryption")) transcript.encryption = normalized.values.encryption;
    return {
      ...target,
      transcript
    };
  }
  if (normalized.section === "network") {
    const next = { ...target };
    if (changedFields.has("mode")) next.networkMode = normalized.values.mode;
    if (changedFields.has("allowedHosts")) next.allowedHosts = normalized.values.allowedHosts;
    return next;
  }
  if (normalized.section === "agents") {
    const agents = { ...(isPlainObject(target.agents) ? target.agents : {}) };
    if (changedFields.has("syncModelTiersOnSwitch")) {
      agents.syncModelTiersOnSwitch = normalized.values.syncModelTiersOnSwitch;
    }
    if (changedFields.has("maxParallelReadonlyAgentRuns")) {
      agents.orchestration = {
        ...(isPlainObject(agents.orchestration) ? agents.orchestration : {}),
        maxParallelReadonlyAgentRuns: normalized.values.maxParallelReadonlyAgentRuns
      };
    }
    if (changedFields.has("backgroundWakeupEnabled") || changedFields.has("backgroundByDefault")) {
      agents.backgroundWakeup = { ...(isPlainObject(agents.backgroundWakeup) ? agents.backgroundWakeup : {}) };
      if (changedFields.has("backgroundWakeupEnabled")) {
        agents.backgroundWakeup.enabled = normalized.values.backgroundWakeupEnabled;
      }
      if (changedFields.has("backgroundByDefault")) {
        agents.backgroundWakeup.defaultForModelAgentRun = normalized.values.backgroundByDefault;
      }
    }
    if (changedFields.has("reviewGateEnabled")) {
      agents.reviewGate = {
        ...(isPlainObject(agents.reviewGate) ? agents.reviewGate : {}),
        enabled: normalized.values.reviewGateEnabled
      };
    }
    if (changedFields.has("goalMaxAutoContinues")) {
      const agentsRecord = /** @type {Record<string, any>} */ (agents);
      agentsRecord.goal = {
        ...(isPlainObject(agentsRecord.goal) ? agentsRecord.goal : {}),
        maxAutoContinues: /** @type {Record<string, any>} */ (normalized.values).goalMaxAutoContinues
      };
    }
    return { ...target, agents };
  }
  const lab = { ...(isPlainObject(target.lab) ? target.lab : {}) };
  if (changedFields.has("maxRetries")) lab.gatewayMaxRetries = normalized.values.maxRetries;
  if (changedFields.has("timeoutMs")) lab.gatewayTimeoutMs = normalized.values.timeoutMs;
  if (changedFields.has("idleTimeoutMs")) lab.gatewayIdleTimeoutMs = normalized.values.idleTimeoutMs;
  return { ...target, lab };
}

/** @param {Record<string, any>} input @param {string} section @param {NodeJS.ProcessEnv} env */
function dashboardSettingsChangedFields(input, section, env) {
  const fields = DASHBOARD_SETTINGS_FIELDS[section] ?? [];
  const requested = Object.prototype.hasOwnProperty.call(input, "changedFields")
    ? Array.isArray(input.changedFields) ? input.changedFields : []
    : fields;
  const managed = DASHBOARD_SETTINGS_MANAGED_ENV[section] ?? {};
  /** @type {string[]} */
  const changedFields = [];
  for (const rawField of requested) {
    const field = dashboardSettingsFieldAlias(section, String(rawField ?? "").trim());
    if (!fields.includes(field) || changedFields.includes(field)) continue;
    if (managed[field] && hasRuntimeEnvValue(env, managed[field])) continue;
    changedFields.push(field);
  }
  return changedFields;
}

/** @param {string} section @param {string} field */
function dashboardSettingsFieldAlias(section, field) {
  if (section === "transcript" && field === "transcriptEnabled") return "enabled";
  if (section === "network" && field === "networkMode") return "mode";
  return field;
}

/** @param {NodeJS.ProcessEnv} env */
function dashboardManagedAllowedHosts(env) {
  return normalizeDashboardAllowedHosts([
    ...String(env.LAB_AGENT_ALLOWED_HOSTS ?? "").split(","),
    urlHost(env.LAB_MODEL_GATEWAY_URL),
    urlHost(env.LAB_MODEL_GATEWAY_HEALTH_URL)
  ]).hosts;
}

/** @param {unknown} value */
function booleanSetting(value) {
  if (value === true || value === false) return value;
  if (String(value).toLowerCase() === "true") return true;
  if (String(value).toLowerCase() === "false") return false;
  return null;
}

/** @param {Array<[string, unknown, unknown, string]>} entries @param {NodeJS.ProcessEnv} env */
function changedManagedSetting(entries, env) {
  const changed = entries.find(([key, requested, current]) => hasRuntimeEnvValue(env, key) && requested !== current);
  return changed
    ? { ok: false, status: 409, error: `${changed[3]}由环境变量 ${changed[0]} 管理` }
    : null;
}

/** @param {NodeJS.ProcessEnv} env @param {string} key */
function hasRuntimeEnvValue(env, key) {
  return env?.[key] !== undefined && env?.[key] !== null && String(env[key]).trim() !== "";
}

/** @param {unknown} value */
function normalizeDashboardAllowedHosts(value) {
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
function validDashboardHost(host) {
  if (!host || /[\s/@]/.test(host) || host.includes("://")) return false;
  try {
    const parsed = new URL(`http://${host}`);
    return parsed.hostname === host && parsed.port === "" && parsed.pathname === "/";
  } catch {
    return false;
  }
}

/** @param {Record<string, any>} config */
function gatewayHostsForSettings(config) {
  const hosts = [];
  for (const value of [
    config.lab?.gatewayUrl,
    config.lab?.gatewayHealthUrl,
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
function normalizeModelConfigInput(input, config, catalogEvidence = {}) {
  const rawGatewayUrl = String(input.gatewayUrl ?? "").trim();
  const parsedGatewayUrl = parseConfigUrl(rawGatewayUrl);
  if (!parsedGatewayUrl) {
    return { ok: false, status: 400, error: "请输入有效的网关 URL" };
  }
  const gatewayHealthUrl = String(input.gatewayHealthUrl ?? "").trim();
  if (gatewayHealthUrl && !parseConfigUrl(gatewayHealthUrl)) {
    return { ok: false, status: 400, error: "请输入有效的健康检查 URL，或留空" };
  }
  const gatewayProtocol = String(input.gatewayProtocol ?? config.lab?.gatewayProtocol ?? "openai-chat").trim();
  if (!GATEWAY_PROTOCOLS.includes(gatewayProtocol)) {
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
  const agentModelTiers = normalizeAgentModelTiers({
    cheap: input.agentCheapModel ?? input.agentModelTiers?.cheap,
    default: input.agentDefaultModel ?? input.agentModelTiers?.default,
    strong: input.agentStrongModel ?? input.agentModelTiers?.strong
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
  const defaultReasoningEffort = reasoningEfforts.some((effort) => effort.id === requestedDefaultReasoningEffort)
    ? requestedDefaultReasoningEffort
    : reasoningEfforts.find((effort) => effort.default === true)?.id ?? null;
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
    catalogModels: catalog.models,
    manualAgentModelIds: manualAgentModels.ids,
    model: {
      id: modelId,
      label: label || modelId,
      ...(Object.prototype.hasOwnProperty.call(input, "description")
        ? { description: String(input.description ?? "").trim() }
        : {}),
      thinking: input.thinking === true || reasoningEfforts.length > 0,
      reasoningEfforts: reasoningEfforts.map(({ id, label, description }) => ({ id, label, description })),
      defaultReasoningEffort,
      modalities,
      agentModelTiers,
      ...(contextTokens ? { contextTokens } : {})
    }
  };
}

/** @param {unknown} value @returns {Record<string, any>} */
function normalizeManualAgentModelIds(value) {
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
function normalizeCatalogModelInput(idsValue, modelsValue) {
  const catalog = normalizeCatalogModelIdInput(idsValue);
  if (!catalog.ok) return catalog;
  if (modelsValue === undefined || modelsValue === null) {
    return { ...catalog, models: [] };
  }
  if (!Array.isArray(modelsValue) || modelsValue.length > 2_048) {
    return invalidModelCatalog("模型目录元数据格式无效，请重新读取模型列表");
  }

  const canonicalByFold = new Map(catalog.ids.map((id) => [id.toLowerCase(), id]));
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
      && (!Number.isSafeInteger(contextValue) || contextValue <= 0)) {
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
function normalizeCatalogModelIdInput(value) {
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
function normalizeCatalogModalities(value) {
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
function normalizeCatalogReasoning(value, defaultValue) {
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
  const exactDefault = normalizedEfforts.some((effort) => effort.id === requestedDefault)
    ? requestedDefault
    : isDisabledDiscoveryEffort(requestedDefault)
      ? normalizedEfforts.find((effort) => isDisabledDiscoveryEffort(effort.id))?.id ?? ""
      : "";
  return {
    ok: true,
    efforts: normalizedEfforts,
    defaultEffort: exactDefault
  };
}

/** @param {unknown} value */
function isDisabledDiscoveryEffort(value) {
  return ["none", "off"].includes(String(value ?? "").trim().toLowerCase());
}

/** @param {Array<Record<string, any>>} efforts @param {unknown} preferred */
function collapseDisabledDiscoveryEfforts(efforts, preferred = "") {
  const preferredId = String(preferred ?? "").trim().toLowerCase();
  const disabledId = isDisabledDiscoveryEffort(preferredId)
    && efforts.some((effort) => effort.id === preferredId)
    ? preferredId
    : efforts.find((effort) => isDisabledDiscoveryEffort(effort.id))?.id ?? "";
  let keptDisabled = false;
  return efforts.filter((effort) => {
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
function normalizeCatalogReasoningDiscovery(value) {
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
function boundedDiscoveryField(value, limit) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return text.length <= limit && !/[\u0000-\u001f\u007f]/.test(text) ? text : "";
}

/** @param {unknown} value @param {number} limit */
function nullableDiscoveryField(value, limit) {
  if (value === undefined || value === null || value === "") return null;
  return boundedDiscoveryField(value, limit) || null;
}

/** @param {string} id */
function validCatalogModelId(id) {
  return Boolean(id) && id.length <= 160 && !/[\r\n\t\0]/.test(id);
}

/** @param {string} error */
function invalidModelCatalog(error) {
  return { ok: false, status: 400, code: "CONFIG_V2_INVALID_MODEL_CATALOG", error };
}

/** @param {unknown} value @param {unknown} gatewayApiKey */
function normalizeCredentialAction(value, gatewayApiKey = "") {
  const action = String(value ?? "").trim().toLowerCase();
  if (["keep", "replace", "clear"].includes(action)) return action;
  return gatewayApiKey ? "replace" : "keep";
}

/** @param {unknown} value */
function normalizeReasoningEffortInput(value) {
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
    ...effort,
    default: entries.some((entry) => (
      isPlainObject(entry)
      && String(entry.id ?? entry.value ?? "").trim().toLowerCase() === effort.id
      && entry.default === true
    ))
  }));
}

function normalizeModelConfigSaveTarget(value) {
  const target = String(value ?? "global").trim().toLowerCase();
  if (target === "global" || target === "user" || target === "default") {
    return "global";
  }
  return "project";
}

function modelConfigTargetPath(cwd, env, saveTarget = "project") {
  return saveTarget === "global"
    ? globalConfigPath(env)
    : localProjectConfigPath(cwd);
}

function normalizeModelInputModalities(input) {
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

async function readJsonConfig(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    const data = JSON.parse(text);
    return isPlainObject(data) ? data : {};
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function mutateDashboardConfig(filePath, update) {
  try {
    return { ok: true, ...await mutateJsonConfig(filePath, update) };
  } catch (error) {
    if (error?.dashboardResult) {
      return error.dashboardResult;
    }
    if (error?.code === "CONFIG_REVISION_CONFLICT" || error?.code === "CONFIG_LOCK_TIMEOUT") {
      return {
        ok: false,
        status: 409,
        code: error.code,
        error: "配置已被其他进程修改，请刷新后重试"
      };
    }
    throw error;
  }
}

function dashboardConfigResultError(result) {
  const error = new Error(result?.error ?? "配置更新失败");
  error.dashboardResult = result;
  return error;
}

async function dashboardConfigEnv(cwd, env) {
  void cwd;
  return env;
}

function buildLocalModelConfig(local, config, normalized) {
  const ownedProfiles = gatewayProfilesOwnedByConfig(local);
  const ownedProfile = ownedGatewayProfileForMutation(local, config, normalized);
  const endpointProfile = ownedProfile ?? gatewayProfileForEndpoint(
    ownedProfiles,
    normalized.gatewayProtocol,
    normalized.gatewayUrl
  );
  const targetOwnsEndpoint = Boolean(endpointProfile) || sameGatewayConfig(local, normalized);
  const replaceModels = normalized.replaceModels || !targetOwnsEndpoint;
  const existingModels = endpointProfile?.models?.length
    ? endpointProfile.models
    : targetOwnsEndpoint ? listConfiguredModels(local) : [];
  const models = replaceModels ? [modelConfigEntry(normalized.model)] : existingModels.map(modelConfigEntry);
  const replacingExistingModel = !replaceModels
    && normalized.previousModelId
    && normalized.previousModelId !== normalized.model.id
    && models.some((model) => model.id === normalized.previousModelId);
  if (replacingExistingModel) {
    const index = models.findIndex((model) => model.id === normalized.previousModelId);
    models.splice(index, 1);
  }
  if (!replaceModels) {
    upsertModelEntry(models, normalized.model);
  }
  const previousModelWasAlias = String(endpointProfile?.modelAlias ?? local.modelAlias ?? "").trim() === normalized.previousModelId;
  const targetProfileId = endpointProfile?.id
    ?? gatewayProfileIdFromParts(normalized.gatewayProtocol, normalized.gatewayUrl);
  const targetWasActive = String(local?.lab?.activeGatewayProfile ?? "").trim() === targetProfileId
    || sameGatewayConfig(local, normalized);
  const activateTarget = normalized.switchToModel || targetWasActive;
  const lab = {
    ...(isPlainObject(local.lab) ? local.lab : {}),
    gatewayUrl: normalized.gatewayUrl,
    gatewayProtocol: normalized.gatewayProtocol,
    activeGatewayProfile: targetProfileId
  };
  if (normalized.gatewayHealthUrl) {
    lab.gatewayHealthUrl = normalized.gatewayHealthUrl;
  } else {
    lab.gatewayHealthUrl = null;
  }
  if (normalized.credentialAction === "replace") {
    lab.gatewayApiKey = normalized.gatewayApiKey;
    delete lab.gatewayApiKeyDisabled;
  } else if (normalized.credentialAction === "clear") {
    lab.gatewayApiKey = null;
    lab.gatewayApiKeyDisabled = true;
  } else if (!sameGatewayConfig(config, normalized)) {
    const matchingLocalProfile = gatewayProfileForEndpoint(
      gatewayProfilesOwnedByConfig(local),
      normalized.gatewayProtocol,
      normalized.gatewayUrl
    );
    const migration = gatewayCredentialMigration(normalized, local, ownedProfile);
    const previousLocalProfile = migration?.sameOrigin
      ? (ownedProfile ?? gatewayProfileForEndpoint(
          gatewayProfilesOwnedByConfig(local),
          migration.previousGatewayProtocol,
          migration.previousGatewayUrl
        ))
      : null;
    const credentialProfile = matchingLocalProfile ?? previousLocalProfile;
    const credential = credentialProfile
      ? gatewayProfileCredentialState(local, credentialProfile.id)
      : { explicit: false, value: undefined };
    if (credential.explicit) {
      lab.gatewayApiKey = credential.value;
      if (credential.disabled) {
        lab.gatewayApiKeyDisabled = true;
      } else {
        delete lab.gatewayApiKeyDisabled;
      }
    } else {
      delete lab.gatewayApiKey;
      delete lab.gatewayApiKeyDisabled;
    }
  }
  const allowedHosts = Array.from(new Set([
    ...(Array.isArray(local.allowedHosts) ? local.allowedHosts : []),
    urlHost(normalized.gatewayUrl),
    urlHost(normalized.gatewayHealthUrl)
  ].filter(Boolean)));
  const next = {
    ...local,
    modelAlias: normalized.switchToModel || previousModelWasAlias
      ? normalized.model.id
      : local.modelAlias ?? endpointProfile?.modelAlias ?? normalized.model.id,
    models,
    allowedHosts,
    lab,
    agents: replaceGatewayAgentRoutes(local.agents, endpointProfile?.agents ?? {})
  };
  applyModelContextBudget(next, local, normalized.model.contextTokens);
  if (replacingExistingModel) {
    next.agents = replaceModelInAgentConfig(
      {
        ...(isPlainObject(local.agents) ? local.agents : {}),
        ...(isPlainObject(next.agents) ? next.agents : {})
      },
      normalized.previousModelId,
      normalized.model.id
    );
  }
  if (replaceModels) {
    next.agents = buildReplacementAgentConfig(local, normalized);
  }
  if (normalized.applyAgentDefaults) {
    const agents = isPlainObject(next.agents) ? next.agents : {};
    const modelTiers = normalizeAgentModelTiers(normalized.model.agentModelTiers);
    const preservedVisionTier = normalized.visionAgentModelProvided
      ? ""
      : String(agents.modelTiers?.vision ?? "").trim();
    if (preservedVisionTier) {
      modelTiers.vision = preservedVisionTier;
    }
    if (Object.keys(modelTiers).length > 0) {
      agents.modelTiers = modelTiers;
    } else {
      delete agents.modelTiers;
    }
    next.agents = agents;
  }
  if (normalized.visionAgentModelProvided) {
    const agents = isPlainObject(next.agents) ? next.agents : {};
    const modelTiers = normalizeAgentModelTiers(agents.modelTiers);
    if (normalized.visionAgentModel) {
      modelTiers.vision = normalized.visionAgentModel;
    } else {
      delete modelTiers.vision;
    }
    if (Object.keys(modelTiers).length > 0) {
      agents.modelTiers = modelTiers;
    } else {
      delete agents.modelTiers;
    }
    agents.vision = {
      ...(isPlainObject(agents.vision) ? agents.vision : {}),
      enabled: Boolean(normalized.visionAgentModel),
      model: normalized.visionAgentModel || null,
      autoUseWhenMainModelTextOnly: true
    };
    next.agents = agents;
  }
  next.lab.gatewayProfiles = upsertGatewayProfileEntries(local, normalized, next);
  next.lab.activeGatewayProfile = targetProfileId;
  if (!activateTarget) {
    const preserved = clonePlainObject(local);
    preserved.allowedHosts = removeUnusedGatewayHosts(
      allowedHosts,
      [local.lab?.gatewayHealthUrl],
      next.lab.gatewayProfiles,
      isPlainObject(local.lab) ? local.lab : {}
    );
    preserved.lab = {
      ...(isPlainObject(local.lab) ? local.lab : {}),
      gatewayProfiles: next.lab.gatewayProfiles
    };
    applyModelContextBudget(preserved, local, normalized.model.contextTokens);
    return preserved;
  }
  next.allowedHosts = removeUnusedGatewayHosts(
    next.allowedHosts,
    [local.lab?.gatewayHealthUrl],
    next.lab.gatewayProfiles,
    next.lab
  );
  return next;
}

function applyModelContextBudget(next, local, contextTokens) {
  if (!Number.isFinite(contextTokens) || contextTokens <= 0) {
    return;
  }
  const nextContext = {
    ...(isPlainObject(local.context) ? local.context : {}),
    ...(isPlainObject(next.context) ? next.context : {})
  };
  nextContext.maxTokens = Math.max(positiveIntegerOrNull(nextContext.maxTokens) ?? 0, contextTokens);
  nextContext.maxBytes = Math.max(positiveIntegerOrNull(nextContext.maxBytes) ?? 0, contextTokens * 4);
  nextContext.resumeMaxTokens = Math.max(positiveIntegerOrNull(nextContext.resumeMaxTokens) ?? 0, contextTokens);
  nextContext.resumeMaxBytes = Math.max(positiveIntegerOrNull(nextContext.resumeMaxBytes) ?? 0, contextTokens * 4);
  next.context = nextContext;
}

function replaceModelInAgentConfig(agents, previousModelId, nextModelId) {
  const next = isPlainObject(agents) ? clonePlainObject(agents) : {};
  const previous = String(previousModelId ?? "").trim();
  const replacement = String(nextModelId ?? "").trim();
  if (!previous || !replacement || previous === replacement) {
    return next;
  }
  const tiers = normalizeAgentModelTiers(next.modelTiers);
  for (const [tier, model] of Object.entries(tiers)) {
    if (model === previous) {
      tiers[tier] = replacement;
    }
  }
  if (Object.keys(tiers).length > 0) {
    next.modelTiers = tiers;
  } else {
    delete next.modelTiers;
  }
  if (String(next.vision?.model ?? "").trim() === previous) {
    next.vision = {
      ...(isPlainObject(next.vision) ? next.vision : {}),
      model: replacement
    };
  }
  return next;
}

function shouldReplaceModelEntries(config, normalized) {
  if (normalized.replaceModels) {
    return true;
  }
  return !sameGatewayProfileEndpoint({
    gatewayUrl: config.lab?.gatewayUrl,
    gatewayProtocol: config.lab?.gatewayProtocol
  }, normalized);
}

/** @param {Record<string, any>} config @param {Record<string, any>} normalized */
function sameGatewayConfig(config, normalized) {
  return sameGatewayProfileEndpoint({
    gatewayUrl: config.lab?.gatewayUrl,
    gatewayProtocol: config.lab?.gatewayProtocol
  }, normalized);
}

/**
 * Resolve an effective profile id back to the profile id owned by the file
 * being edited. Different layers may use different ids for the same endpoint.
 *
 * @param {Record<string, any>} ownerConfig
 * @param {Record<string, any>} effectiveConfig
 * @param {Record<string, any>} normalized
 */
function ownedGatewayProfileForMutation(ownerConfig, effectiveConfig, normalized) {
  const ownedProfiles = gatewayProfilesOwnedByConfig(ownerConfig);
  if (!normalized.profileId) {
    return gatewayProfileForEndpoint(ownedProfiles, normalized.gatewayProtocol, normalized.gatewayUrl);
  }
  const direct = ownedProfiles.find((profile) => profile.id === normalized.profileId);
  if (direct) return direct;
  const effectiveProfile = gatewayProfilesFromConfig(effectiveConfig)
    .find((profile) => profile.id === normalized.profileId);
  if (effectiveProfile) {
    const endpointMatch = gatewayProfileForEndpoint(
      ownedProfiles,
      effectiveProfile.gatewayProtocol,
      effectiveProfile.gatewayUrl
    );
    if (endpointMatch) return endpointMatch;
  }
  if (normalized.previousGatewayUrl) {
    return gatewayProfileForEndpoint(
      ownedProfiles,
      normalized.previousGatewayProtocol,
      normalized.previousGatewayUrl
    );
  }
  return null;
}

/**
 * @param {Record<string, any>} targetConfig
 * @param {Record<string, any>} config
 * @param {Record<string, any>} normalized
 */
function validateGatewayCredentialMigration(targetConfig, config, normalized) {
  const effectiveProfile = normalized.profileId
    ? gatewayProfilesFromConfig(config).find((profile) => profile.id === normalized.profileId)
    : null;
  const ownedProfile = ownedGatewayProfileForMutation(targetConfig, config, normalized);
  if (normalized.profileId) {
    if (effectiveProfile && !ownedProfile) {
      const ownerScope = String(gatewayProfileOwner(config, normalized.profileId)?.type ?? "").trim();
      return {
        ok: false,
        status: 400,
        error: ownerScope === "project" || ownerScope === "global"
          ? `该网关档案属于${ownerScope === "global" ? "全局" : "项目"}配置，请保存到原配置范围`
          : "该网关档案由环境或其他配置层管理，不能直接覆盖"
      };
    }
  }
  if (normalized.credentialAction !== "keep") {
    return { ok: true };
  }
  const migration = gatewayCredentialMigration(normalized, targetConfig, ownedProfile);
  if (!migration) {
    return { ok: true };
  }
  const effectiveCredential = normalized.profileId
    ? gatewayProfileCredentialState(config, effectiveProfile?.id ?? normalized.profileId)
    : gatewayCredentialForEndpoint(
        config,
        migration.previousGatewayProtocol,
        migration.previousGatewayUrl
      );
  if (!effectiveCredential.value) {
    return { ok: true };
  }
  if (!migration.sameOrigin) {
    return { ok: true };
  }
  const ownedCredential = normalized.profileId
    ? (ownedProfile
      ? gatewayProfileCredentialState(targetConfig, ownedProfile.id)
      : { explicit: false, value: undefined, disabled: false })
    : gatewayCredentialForEndpoint(
        targetConfig,
        migration.previousGatewayProtocol,
        migration.previousGatewayUrl
      );
  if (!ownedCredential.value) {
    return {
      ok: false,
      status: 400,
      error: "当前 API Key 来自其他配置层。修改请求路径或协议时无法自动复制该密钥，请重新输入 API Key"
    };
  }
  return { ok: true };
}

/**
 * @param {Record<string, any>} normalized
 * @param {Record<string, any>} [ownerConfig]
 * @param {Record<string, any> | null} [resolvedProfile]
 */
function gatewayCredentialMigration(normalized, ownerConfig = {}, resolvedProfile = null) {
  const previousProfile = resolvedProfile ?? (normalized.profileId
    ? gatewayProfilesOwnedByConfig(ownerConfig).find((profile) => profile.id === normalized.profileId)
    : null);
  const previousGatewayUrl = String(previousProfile?.gatewayUrl ?? normalized.previousGatewayUrl ?? "").trim();
  const previousGatewayProtocol = String(
    previousProfile?.gatewayProtocol ?? normalized.previousGatewayProtocol ?? "openai-chat"
  ).trim();
  if ((!normalized.profileId && !normalized.previousModelId) || !parseConfigUrl(previousGatewayUrl)) {
    return null;
  }
  const previous = { gatewayUrl: previousGatewayUrl, gatewayProtocol: previousGatewayProtocol };
  if (sameGatewayProfileEndpoint(previous, normalized)) {
    return null;
  }
  return {
    previousGatewayUrl,
    previousGatewayProtocol,
    sameOrigin: gatewayUrlOrigin(previousGatewayUrl) === gatewayUrlOrigin(normalized.gatewayUrl)
  };
}

/** @param {Record<string, any>} config @param {string} gatewayProtocol @param {string} gatewayUrl */
function gatewayCredentialForEndpoint(config, gatewayProtocol, gatewayUrl) {
  const profile = gatewayProfileForEndpoint(gatewayProfilesOwnedByConfig(config), gatewayProtocol, gatewayUrl);
  return profile
    ? gatewayProfileCredentialState(config, profile.id)
    : { explicit: false, value: undefined, disabled: false };
}

/** @param {unknown} value */
function gatewayUrlOrigin(value) {
  try {
    return new URL(String(value ?? "").trim()).origin;
  } catch {
    return "";
  }
}

function buildGatewayProfileSwitchConfig(local, config, profileId) {
  const profile = gatewayProfilesFromConfig(config).find((item) => item.id === profileId)
    ?? gatewayProfilesFromConfig(local).find((item) => item.id === profileId);
  if (!profile) {
    return { ok: false, status: 404, error: "网关配置不存在" };
  }
  if (!parseConfigUrl(profile.gatewayUrl) || !GATEWAY_PROTOCOLS.includes(profile.gatewayProtocol)) {
    return { ok: false, status: 400, error: "该网关的 API 地址或协议不完整，请先在设置中修正" };
  }
  if (!Array.isArray(profile.models) || profile.models.length === 0) {
    return { ok: false, status: 400, error: "该网关没有已配置模型，请先在设置中添加模型" };
  }
  const next = clonePlainObject(local);
  delete next.modelAlias;
  delete next.models;
  delete next.reasoningEffort;
  const lab = isPlainObject(next.lab) ? next.lab : {};
  const ownedProfiles = gatewayProfilesForPersistence(local);
  for (const key of [
    "gatewayUrl",
    "gatewayHealthUrl",
    "gatewayProtocol",
    "gatewayApiKey",
    "gatewayApiKeyDisabled"
  ]) {
    delete lab[key];
  }
  lab.activeGatewayProfile = profile.id;
  if (ownedProfiles.length > 0) {
    lab.gatewayProfiles = ownedProfiles;
  }
  next.lab = lab;
  if (isPlainObject(next.agents)) {
    delete next.agents.modelTiers;
    delete next.agents.vision;
    if (Object.keys(next.agents).length === 0) {
      delete next.agents;
    }
  }
  return { ok: true, config: next };
}

/**
 * Delete a model from the configuration layer that owns its gateway profile.
 * Effective merged config is used only to determine whether the profile is
 * currently selected; inherited definitions are never copied into the owner.
 *
 * @param {Record<string, any>} ownerConfig
 * @param {Record<string, any>} effectiveConfig
 * @param {string} profileId
 * @param {string} modelId
 * @param {{ inheritedFallback?: boolean; inheritedProfileId?: string }} [options]
 */
function buildOwnedDeleteModelConfig(ownerConfig, effectiveConfig, profileId, modelId, options = {}) {
  const effectiveProfile = gatewayProfilesFromConfig(effectiveConfig).find((item) => item.id === profileId);
  const ownedProfiles = gatewayProfilesOwnedByConfig(ownerConfig);
  const profile = ownedProfiles.find((item) => item.id === profileId && item.models.some((model) => model.id === modelId))
    ?? (effectiveProfile
      ? gatewayProfileForEndpoint(ownedProfiles, effectiveProfile.gatewayProtocol, effectiveProfile.gatewayUrl)
      : null);
  if (!profile || !profile.models.some((model) => model.id === modelId)) {
    return { ok: false, status: 404, error: "模型配置不存在" };
  }
  const ownerProfileId = profile.id;
  if (profile.models.length <= 1) {
    const deletion = buildGatewayProfileDeleteConfig(ownerConfig, ownerConfig, ownerProfileId, {
      inheritedFallback: options.inheritedFallback === true,
      inheritedProfileId: options.inheritedProfileId
    });
    return {
      ...deletion,
      ownerProfileId,
      removedProfile: deletion.ok === true,
      clearedGateway: deletion.clearedGateway === true
        && activeGatewayProfileId(effectiveConfig) === profileId
        && (effectiveProfile?.models.length ?? 0) <= 1
    };
  }

  const remainingModels = profile.models.filter((model) => model.id !== modelId).map(modelConfigEntry);
  const fallbackModel = remainingModels[0]?.id || "";
  const modelAlias = profile.modelAlias === modelId
    ? fallbackModel
    : String(profile.modelAlias ?? fallbackModel).trim() || fallbackModel;
  const agents = removeModelFromAgentConfig(profile.agents ?? {}, modelId, remainingModels);
  const updatedProfile = normalizeGatewayProfile({
    ...profile,
    modelAlias,
    models: remainingModels,
    ...(Object.keys(agents).length > 0 ? { agents } : {})
  });
  const next = clonePlainObject(ownerConfig);
  const lab = isPlainObject(next.lab) ? next.lab : {};
  lab.gatewayProfiles = upsertGatewayProfileForPersistence(
    gatewayProfilesForPersistence(ownerConfig),
    updatedProfile,
    ownerConfig
  );
  next.lab = lab;

  if (ownerConfigMirrorsGatewayProfile(ownerConfig, profile)) {
    next.modelAlias = modelAlias;
    next.models = remainingModels;
    next.agents = replaceGatewayAgentRoutes(ownerConfig.agents, agents);
  }
  return {
    ok: true,
    config: next,
    ownerProfileId,
    removedProfile: false,
    clearedGateway: false
  };
}

/** @param {Record<string, any>} config @param {Record<string, any>} profile */
function ownerConfigMirrorsGatewayProfile(config, profile) {
  const selected = String(config?.lab?.activeGatewayProfile ?? "").trim();
  return selected === profile.id || sameGatewayProfileEndpoint({
    gatewayUrl: config?.lab?.gatewayUrl,
    gatewayProtocol: config?.lab?.gatewayProtocol
  }, profile);
}

/** @param {unknown} current @param {Record<string, any>} routes */
function replaceGatewayAgentRoutes(current, routes) {
  const next = /** @type {Record<string, any>} */ (isPlainObject(current) ? clonePlainObject(current) : {});
  delete next.modelTiers;
  delete next.vision;
  if (isPlainObject(routes?.modelTiers) && Object.keys(routes.modelTiers).length > 0) {
    next.modelTiers = clonePlainObject(routes.modelTiers);
  }
  if (isPlainObject(routes?.vision)) {
    next.vision = clonePlainObject(routes.vision);
  }
  return next;
}

/** @param {Record<string, any>} local @param {string} profileId */
function clearDanglingGatewayProfileSelection(local, profileId) {
  if (configOwnsGatewayProfile(local, profileId)
    || String(local?.lab?.activeGatewayProfile ?? "").trim() !== profileId) {
    return local;
  }
  const next = clonePlainObject(local);
  if (isPlainObject(next.lab)) {
    delete next.lab.activeGatewayProfile;
    if (Object.keys(next.lab).length === 0) {
      delete next.lab;
    }
  }
  return next;
}

/**
 * @param {Record<string, any>} local
 * @param {Record<string, any>} config
 * @param {string} profileId
 * @param {{ inheritedFallback?: boolean; inheritedProfileId?: string }} [options]
 */
function buildGatewayProfileDeleteConfig(local, config, profileId, options = {}) {
  const profiles = gatewayProfilesFromLocalAndConfig(local, config);
  const deletedProfile = profiles.find((profile) => profile.id === profileId);
  if (!deletedProfile) {
    return { ok: false, error: "网关配置不存在" };
  }
  const remaining = gatewayProfilesForPersistence(local, config)
    .filter((profile) => profile.id !== profileId && !sameGatewayProfileEndpoint(profile, deletedProfile));
  const allowedHosts = removeDeletedGatewayHosts(local.allowedHosts, deletedProfile, remaining);
  if (options.inheritedFallback === true) {
    const next = clonePlainObject(local);
    delete next.modelAlias;
    delete next.models;
    delete next.reasoningEffort;
    next.allowedHosts = allowedHosts;
    const lab = isPlainObject(next.lab) ? next.lab : {};
    delete lab.gatewayUrl;
    delete lab.gatewayHealthUrl;
    delete lab.gatewayProtocol;
    delete lab.gatewayApiKey;
    delete lab.gatewayApiKeyDisabled;
    lab.activeGatewayProfile = String(options.inheritedProfileId ?? "").trim() || profileId;
    if (remaining.length > 0) {
      lab.gatewayProfiles = remaining;
    } else {
      delete lab.gatewayProfiles;
    }
    next.lab = lab;
    if (isPlainObject(next.agents)) {
      delete next.agents.modelTiers;
      delete next.agents.vision;
    }
    return { ok: true, clearedGateway: false, restoredInherited: true, config: next };
  }
  if (activeGatewayProfileId(config) !== profileId) {
    return {
      ok: true,
      clearedGateway: false,
      config: {
        ...local,
        allowedHosts,
        lab: {
          ...(isPlainObject(local.lab) ? local.lab : {}),
          gatewayProfiles: remaining
        }
      }
    };
  }
  return {
    ok: true,
    clearedGateway: true,
    config: {
      ...local,
      modelAlias: "",
      models: [],
      allowedHosts,
      agents: clearGatewayAgentModels(local, config),
      lab: {
        ...(isPlainObject(local.lab) ? local.lab : {}),
        gatewayUrl: null,
        gatewayHealthUrl: null,
        gatewayProtocol: "openai-chat",
        gatewayApiKey: null,
        activeGatewayProfile: "",
        gatewayProfiles: remaining
      }
    }
  };
}

/**
 * @param {{ local: Record<string, any>; localPath: string; global: Record<string, any>; globalPath: string; profileId: string; ownerScope?: string }} input
 */
function gatewayProfileDeleteTargets({ local, localPath, global, globalPath, profileId, ownerScope = "" }) {
  const targets = [];
  if ((ownerScope === "project" || !ownerScope) && configOwnsGatewayProfile(local, profileId)) {
    targets.push({ scope: "project", path: localPath, config: local });
  }
  if ((ownerScope === "global" || !ownerScope)
    && path.resolve(globalPath).toLowerCase() !== path.resolve(localPath).toLowerCase()
    && configOwnsGatewayProfile(global, profileId)) {
    targets.push({ scope: "global", path: globalPath, config: global });
  }
  return targets;
}

function configOwnsGatewayProfile(config, profileId) {
  return gatewayProfilesOwnedByConfig(config).some((profile) => profile.id === profileId);
}

/** @param {Record<string, any>} local @param {Record<string, any>} config */
function clearGatewayAgentModels(local, config) {
  const agents = {
    ...(isPlainObject(config.agents) ? config.agents : {}),
    ...(isPlainObject(local.agents) ? local.agents : {})
  };
  delete agents.modelTiers;
  agents.vision = {
    ...(isPlainObject(agents.vision) ? agents.vision : {}),
    enabled: false,
    model: null,
    autoUseWhenMainModelTextOnly: agents.vision?.autoUseWhenMainModelTextOnly !== false
  };
  return agents;
}

function removeModelFromAgentConfig(agents, modelId, remainingModels = []) {
  const next = isPlainObject(agents) ? clonePlainObject(agents) : {};
  const tiers = normalizeAgentModelTiers(next.modelTiers);
  for (const [tier, model] of Object.entries(tiers)) {
    if (model === modelId) {
      delete tiers[tier];
    }
  }
  if (Object.keys(tiers).length > 0) {
    next.modelTiers = tiers;
  } else {
    delete next.modelTiers;
  }
  const visionModel = String(next.vision?.model ?? "").trim();
  if (visionModel === modelId) {
    const fallbackVision = remainingModels.find((model) => Array.isArray(model.modalities) && model.modalities.includes("image"))?.id || "";
    next.vision = {
      ...(isPlainObject(next.vision) ? next.vision : {}),
      enabled: Boolean(fallbackVision),
      model: fallbackVision || null,
      autoUseWhenMainModelTextOnly: next.vision?.autoUseWhenMainModelTextOnly !== false
    };
    if (fallbackVision) {
      next.modelTiers = {
        ...(next.modelTiers ?? {}),
        vision: fallbackVision
      };
    }
  }
  return next;
}

function upsertGatewayProfileEntries(local, normalized, nextConfig) {
  const profiles = gatewayProfilesForPersistence(local);
  const nextProfile = gatewayProfileFromConfig(nextConfig, {
    id: String(nextConfig?.lab?.activeGatewayProfile ?? "").trim()
      || normalized.profileId
      || gatewayProfileIdFromParts(normalized.gatewayProtocol, normalized.gatewayUrl)
  });
  return upsertGatewayProfileForPersistence(profiles, nextProfile, nextConfig);
}

function gatewayProfilesFromLocalAndConfig(local, config) {
  const profiles = [
    ...gatewayProfilesFromConfig(config),
    ...gatewayProfilesFromConfig(local)
  ];
  return dedupeGatewayProfiles(profiles);
}

/** @param {Record<string, any>} config */
function gatewayProfilesOwnedByConfig(config) {
  const profiles = gatewayProfilesFromConfig(config);
  const gatewayUrl = String(config?.lab?.gatewayUrl ?? "").trim();
  if (!gatewayUrl) {
    return profiles;
  }
  const gatewayProtocol = String(config?.lab?.gatewayProtocol ?? "openai-chat").trim();
  const endpointProfile = gatewayProfileForEndpoint(profiles, gatewayProtocol, gatewayUrl);
  const selectedId = String(config?.lab?.activeGatewayProfile ?? "").trim();
  const profileId = endpointProfile?.id
    ?? (profiles.length === 0 && selectedId ? selectedId : gatewayProfileIdFromParts(gatewayProtocol, gatewayUrl));
  return upsertGatewayProfile(profiles, normalizeGatewayProfile({
    id: profileId,
    gatewayUrl,
    gatewayHealthUrl: config?.lab?.gatewayHealthUrl ?? "",
    gatewayProtocol,
    gatewayApiKey: config?.lab?.gatewayApiKey ?? "",
    gatewayApiKeyDisabled: config?.lab?.gatewayApiKeyDisabled === true,
    modelAlias: config?.modelAlias ?? "",
    models: Array.isArray(config?.models) ? config.models : [],
    agents: profileAgentConfig(config)
  }));
}

/** @param {Record<string, any>} local @param {Record<string, any>} config */
function gatewayProfilesForPersistence(local, config = {}) {
  void config;
  const byId = new Map();
  for (const profile of gatewayProfilesOwnedByConfig(local)) {
    const persisted = gatewayProfileForPersistence(profile, local);
    if (persisted) {
      byId.set(persisted.id, persisted);
    }
  }
  return Array.from(byId.values());
}

/**
 * Remove only legacy project snapshots that are provably identical to the
 * pre-save inherited profile. Project credentials or model-route differences
 * make the profile an intentional override and keep it untouched.
 *
 * @param {Record<string, any>} local
 * @param {Record<string, any>} inheritedConfig
 */
function removeRedundantInheritedGatewayShadows(local, inheritedConfig) {
  const configured = Array.isArray(local?.lab?.gatewayProfiles)
    ? local.lab.gatewayProfiles
    : [];
  if (configured.length === 0) return local;
  const configuredInheritedProfiles = gatewayProfilesFromConfig(inheritedConfig);
  const materializedInheritedProfiles = gatewayProfilesOwnedByConfig(inheritedConfig);
  const retained = [];
  const replacements = new Map();
  const removed = [];
  for (const rawProfile of configured) {
    const profile = normalizeGatewayProfile(rawProfile);
    const inherited = profile
      ? gatewayProfileForEndpoint(configuredInheritedProfiles, profile.gatewayProtocol, profile.gatewayUrl)
        ?? gatewayProfileForEndpoint(materializedInheritedProfiles, profile.gatewayProtocol, profile.gatewayUrl)
      : null;
    if (!profile || !inherited || !isRedundantInheritedGatewayShadow(local, profile, inherited)) {
      retained.push(rawProfile);
      continue;
    }
    replacements.set(profile.id, inherited.id);
    removed.push({ profile, inherited });
  }
  if (removed.length === 0) return local;

  const next = clonePlainObject(local);
  const lab = isPlainObject(next.lab) ? next.lab : {};
  const selectedId = String(lab.activeGatewayProfile ?? "").trim();
  let replacementId = String(replacements.get(selectedId) ?? "").trim();
  if (!replacementId && String(lab.gatewayUrl ?? "").trim()) {
    const activeRemoved = removed.find(({ profile }) => sameGatewayProfileEndpoint(profile, {
      gatewayUrl: lab.gatewayUrl,
      gatewayProtocol: lab.gatewayProtocol
    }));
    replacementId = String(activeRemoved?.inherited?.id ?? "").trim();
  }

  if (retained.length > 0) {
    lab.gatewayProfiles = retained;
  } else {
    delete lab.gatewayProfiles;
  }
  if (replacementId) {
    lab.activeGatewayProfile = replacementId;
    for (const key of [
      "gatewayUrl",
      "gatewayHealthUrl",
      "gatewayProtocol",
      "gatewayApiKey",
      "gatewayApiKeyDisabled"
    ]) {
      delete lab[key];
    }
    delete next.modelAlias;
    delete next.models;
    if (isPlainObject(next.agents)) {
      delete next.agents.modelTiers;
      delete next.agents.vision;
      if (Object.keys(next.agents).length === 0) delete next.agents;
    }
  }
  next.lab = lab;
  return next;
}

/**
 * @param {Record<string, any>} local
 * @param {Record<string, any>} profile
 * @param {Record<string, any>} inherited
 */
function isRedundantInheritedGatewayShadow(local, profile, inherited) {
  const credentialExplicit = gatewayProfileCredentialState(local, profile.id).explicit;
  const profileSignature = gatewayProfileInheritanceSignature(profile);
  const inheritedSignature = gatewayProfileInheritanceSignature(inherited);
  if (credentialExplicit) return false;
  if (!isDeepStrictEqual(profileSignature, inheritedSignature)) {
    return false;
  }
  const activeId = String(local?.lab?.activeGatewayProfile ?? "").trim();
  const topMatches = activeId === profile.id
    || sameGatewayProfileEndpoint(profile, {
      gatewayUrl: local?.lab?.gatewayUrl,
      gatewayProtocol: local?.lab?.gatewayProtocol
    });
  if (!topMatches) return true;
  const lab = isPlainObject(local?.lab) ? local.lab : {};
  if (Object.prototype.hasOwnProperty.call(lab, "gatewayApiKey")
    || lab.gatewayApiKeyDisabled === true) {
    return false;
  }
  const ownsTopProjection = Object.prototype.hasOwnProperty.call(local, "modelAlias")
    || Object.prototype.hasOwnProperty.call(local, "models")
    || Object.prototype.hasOwnProperty.call(lab, "gatewayUrl")
    || Object.prototype.hasOwnProperty.call(lab, "gatewayHealthUrl")
    || Object.prototype.hasOwnProperty.call(lab, "gatewayProtocol")
    || Object.keys(profileAgentConfig(local)).length > 0;
  if (!ownsTopProjection) return true;
  const topAgents = profileAgentConfig(local);
  const topProfile = normalizeGatewayProfile({
    id: profile.id,
    label: profile.label,
    gatewayUrl: lab.gatewayUrl ?? profile.gatewayUrl,
    gatewayHealthUrl: lab.gatewayHealthUrl ?? profile.gatewayHealthUrl,
    gatewayProtocol: lab.gatewayProtocol ?? profile.gatewayProtocol,
    modelAlias: local.modelAlias ?? profile.modelAlias,
    models: Array.isArray(local.models) ? local.models : profile.models,
    agents: Object.keys(topAgents).length > 0 ? topAgents : profile.agents
  });
  const topSignature = gatewayProfileInheritanceSignature(topProfile, false);
  const inheritedTopSignature = gatewayProfileInheritanceSignature(inherited, false);
  return isDeepStrictEqual(topSignature, inheritedTopSignature);
}

/** @param {Record<string, any> | null} profile @param {boolean} [includeLabel] */
function gatewayProfileInheritanceSignature(profile, includeLabel = true) {
  const normalized = normalizeGatewayProfile(profile);
  if (!normalized) return null;
  return {
    ...(includeLabel ? { label: normalized.label } : {}),
    gatewayUrl: canonicalGatewayEndpointUrl(normalized.gatewayUrl, normalized.gatewayProtocol),
    gatewayHealthUrl: canonicalGatewayEndpointUrl(normalized.gatewayHealthUrl),
    gatewayProtocol: normalized.gatewayProtocol,
    modelAlias: normalized.modelAlias,
    models: listConfiguredModels({
      modelAlias: normalized.modelAlias,
      models: normalized.models
    }).map(modelConfigEntry),
    agents: isPlainObject(normalized.agents) ? clonePlainObject(normalized.agents) : {}
  };
}

/**
 * @param {Array<Record<string, any>>} profiles
 * @param {Record<string, any> | null} profile
 * @param {Record<string, any>} ownerConfig
 */
function upsertGatewayProfileForPersistence(profiles, profile, ownerConfig) {
  const normalized = normalizeGatewayProfile(profile);
  const existing = normalized
    ? gatewayProfileForEndpoint(profiles, normalized.gatewayProtocol, normalized.gatewayUrl)
    : null;
  const candidate = normalized && existing
    ? { ...normalized, id: preferredGatewayProfileId(existing, normalized) }
    : normalized;
  const persisted = gatewayProfileForPersistence(candidate, ownerConfig);
  const next = profiles.filter((item) => item.id !== persisted?.id && !sameGatewayProfileEndpoint(item, persisted));
  if (persisted) {
    next.push(persisted);
  }
  return next;
}

/** @param {Record<string, any> | null} profile @param {Record<string, any>} ownerConfig */
function gatewayProfileForPersistence(profile, ownerConfig) {
  const normalized = normalizeGatewayProfile(profile);
  if (!normalized) {
    return null;
  }
  const credential = gatewayProfileCredentialState(ownerConfig, normalized.id);
  if (credential.explicit) {
    const persisted = /** @type {Record<string, any>} */ ({ ...normalized, gatewayApiKey: credential.value });
    if (credential.disabled) {
      persisted.gatewayApiKeyDisabled = true;
    } else {
      delete persisted.gatewayApiKeyDisabled;
    }
    return persisted;
  }
  const persisted = /** @type {Record<string, any>} */ ({ ...normalized });
  delete persisted.gatewayApiKey;
  delete persisted.gatewayApiKeyDisabled;
  return persisted;
}

/** @param {Record<string, any>} config @param {string} profileId */
function gatewayProfileCredentialState(config, profileId) {
  const lab = isPlainObject(config?.lab) ? config.lab : {};
  const topId = activeGatewayProfileId(config);
  if (topId === profileId && lab.gatewayApiKeyDisabled === true) {
    return { explicit: true, value: null, disabled: true };
  }
  if (topId === profileId && Object.prototype.hasOwnProperty.call(lab, "gatewayApiKey")) {
    const value = explicitGatewayApiKeyValue(lab.gatewayApiKey);
    if (value) {
      return { explicit: true, value };
    }
  }
  const configured = Array.isArray(lab.gatewayProfiles) ? lab.gatewayProfiles : [];
  for (let index = configured.length - 1; index >= 0; index -= 1) {
    const raw = configured[index];
    const normalized = normalizeGatewayProfile(raw);
    if (normalized?.id === profileId && raw.gatewayApiKeyDisabled === true) {
      return { explicit: true, value: null, disabled: true };
    }
    if (normalized?.id === profileId && Object.prototype.hasOwnProperty.call(raw, "gatewayApiKey")) {
      const value = explicitGatewayApiKeyValue(raw.gatewayApiKey);
      if (value) {
        return { explicit: true, value };
      }
    }
  }
  return { explicit: false, value: undefined, disabled: false };
}

/** @param {unknown} value */
function explicitGatewayApiKeyValue(value) {
  const key = String(value ?? "").trim();
  return key || null;
}

/**
 * @param {unknown} allowedHosts
 * @param {Record<string, any>} deletedProfile
 * @param {Array<Record<string, any>>} remainingProfiles
 */
function removeDeletedGatewayHosts(allowedHosts, deletedProfile, remainingProfiles) {
  return removeUnusedGatewayHosts(
    allowedHosts,
    [deletedProfile?.gatewayUrl, deletedProfile?.gatewayHealthUrl],
    remainingProfiles
  );
}

/**
 * @param {unknown} allowedHosts
 * @param {Array<unknown>} removedUrls
 * @param {Array<Record<string, any>>} remainingProfiles
 * @param {Record<string, any>} [activeLab]
 */
function removeUnusedGatewayHosts(allowedHosts, removedUrls, remainingProfiles, activeLab = {}) {
  const deletedHosts = new Set(removedUrls.map(urlHost).filter(Boolean));
  const retainedHosts = new Set([
    ...remainingProfiles.flatMap((profile) => [
      urlHost(profile.gatewayUrl),
      urlHost(profile.gatewayHealthUrl)
    ]),
    urlHost(activeLab.gatewayUrl),
    urlHost(activeLab.gatewayHealthUrl)
  ].filter(Boolean));
  return (Array.isArray(allowedHosts) ? allowedHosts : [])
    .filter((host) => !deletedHosts.has(host) || retainedHosts.has(host));
}

/** @param {Array<Record<string, any>>} profiles @param {string} protocol @param {string} gatewayUrl */
function gatewayProfileForEndpoint(profiles, protocol, gatewayUrl) {
  const matches = profiles.filter((profile) => sameGatewayProfileEndpoint(profile, { gatewayProtocol: protocol, gatewayUrl }));
  return matches.find((profile) => !isGeneratedGatewayProfileId(profile)) ?? matches[0] ?? null;
}

/** @param {Record<string, any> | null} left @param {Record<string, any> | null} right */
function sameGatewayProfileEndpoint(left, right) {
  if (!left || !right) {
    return false;
  }
  const leftProtocol = String(left.gatewayProtocol ?? "openai-chat").trim();
  const rightProtocol = String(right.gatewayProtocol ?? "openai-chat").trim();
  return canonicalGatewayEndpointUrl(left.gatewayUrl, leftProtocol)
      === canonicalGatewayEndpointUrl(right.gatewayUrl, rightProtocol)
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
  const parsed = parseConfigUrl(String(value ?? "").trim());
  return parsed ? gatewayInferenceUrl(parsed, protocol) : String(value ?? "").trim();
}

/** @param {Record<string, any>} profile */
function isGeneratedGatewayProfileId(profile) {
  return String(profile.id ?? "").trim()
    === gatewayProfileIdFromParts(profile.gatewayProtocol, profile.gatewayUrl);
}

/** @param {Record<string, any>} existing @param {Record<string, any>} incoming */
function preferredGatewayProfileId(existing, incoming) {
  return isGeneratedGatewayProfileId(existing) && !isGeneratedGatewayProfileId(incoming)
    ? incoming.id
    : existing.id;
}

function gatewayProfilesFromConfig(config) {
  const configured = Array.isArray(config?.lab?.gatewayProfiles) ? config.lab.gatewayProfiles : [];
  return dedupeGatewayProfiles(configured.map(normalizeGatewayProfile).filter(Boolean));
}

function gatewayProfileFromConfig(config, overrides = {}) {
  const id = String(overrides.id ?? config?.lab?.activeGatewayProfile ?? "").trim()
    || gatewayProfileIdFromParts(config?.lab?.gatewayProtocol, config?.lab?.gatewayUrl);
  return normalizeGatewayProfile({
    id,
    label: gatewayProfileLabel(config?.lab?.gatewayUrl, config?.lab?.gatewayProtocol),
    gatewayUrl: config?.lab?.gatewayUrl ?? "",
    gatewayHealthUrl: config?.lab?.gatewayHealthUrl ?? "",
    gatewayProtocol: config?.lab?.gatewayProtocol ?? "openai-chat",
    gatewayApiKey: config?.lab?.gatewayApiKey ?? "",
    gatewayApiKeyDisabled: config?.lab?.gatewayApiKeyDisabled === true,
    modelAlias: config?.modelAlias ?? "",
    models: listConfiguredModels(config ?? {}).map(modelConfigEntry),
    agents: profileAgentConfig(config)
  });
}

function profileAgentConfig(config) {
  const agents = {};
  const tiers = normalizeAgentModelTiers(config?.agents?.modelTiers);
  if (Object.keys(tiers).length > 0) {
    agents.modelTiers = tiers;
  }
  if (isPlainObject(config?.agents?.vision)) {
    agents.vision = {
      enabled: config.agents.vision.enabled !== false,
      model: config.agents.vision.model ?? null,
      autoUseWhenMainModelTextOnly: config.agents.vision.autoUseWhenMainModelTextOnly !== false
    };
  }
  return agents;
}

function normalizeGatewayProfile(value) {
  if (!isPlainObject(value)) {
    return null;
  }
  const gatewayUrl = String(value.gatewayUrl ?? "").trim();
  const gatewayProtocol = String(value.gatewayProtocol ?? "openai-chat").trim();
  const id = String(value.id ?? "").trim() || gatewayProfileIdFromParts(gatewayProtocol, gatewayUrl);
  if (!id) {
    return null;
  }
  const models = Array.isArray(value.models) ? value.models.map(profileModelEntry).filter((model) => model.id) : [];
  return {
    id,
    label: String(value.label ?? "").trim() || gatewayProfileLabel(gatewayUrl, gatewayProtocol),
    gatewayUrl,
    gatewayHealthUrl: String(value.gatewayHealthUrl ?? "").trim(),
    gatewayProtocol,
    gatewayApiKey: String(value.gatewayApiKey ?? "").trim(),
    gatewayApiKeyDisabled: value.gatewayApiKeyDisabled === true,
    modelAlias: String(value.modelAlias ?? "").trim() || models[0]?.id || "",
    models,
    ...(isPlainObject(value.agents) ? { agents: clonePlainObject(value.agents) } : {})
  };
}

function profileModelEntry(model) {
  if (typeof model === "string") {
    return {
      id: model,
      label: model,
      description: "Configured model alias.",
      thinking: /thinking|reason/i.test(model),
      modalities: /vision|visual|image|omni|multimodal/i.test(model) ? ["text", "image"] : ["text"]
    };
  }
  return modelConfigEntry(model);
}

function upsertGatewayProfile(profiles, profile) {
  const next = dedupeGatewayProfiles(profiles);
  const normalized = normalizeGatewayProfile(profile);
  if (!normalized) {
    return next;
  }
  const index = next.findIndex((item) => item.id === normalized.id);
  if (index >= 0) {
    next[index] = normalized;
  } else {
    next.push(normalized);
  }
  return next;
}

function dedupeGatewayProfiles(profiles) {
  const byId = new Map();
  for (const profile of profiles) {
    const normalized = normalizeGatewayProfile(profile);
    if (normalized) {
      byId.set(normalized.id, normalized);
    }
  }
  return Array.from(byId.values());
}

function activeGatewayProfileId(config) {
  const explicit = String(config?.lab?.activeGatewayProfile ?? "").trim();
  if (explicit) {
    return explicit;
  }
  return gatewayProfileIdFromParts(config?.lab?.gatewayProtocol, config?.lab?.gatewayUrl);
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

function gatewayProfileLabel(gatewayUrl, protocol) {
  const host = urlHost(gatewayUrl);
  if (host) {
    return host;
  }
  return String(protocol ?? "openai-chat");
}

function buildReplacementAgentConfig(local, normalized) {
  const modelTiers = {};
  for (const tier of ["cheap", "default", "strong"]) {
    modelTiers[tier] = normalized.model.id;
  }
  const visionModel = String(normalized.visionAgentModel ?? "").trim();
  if (visionModel && visionModel === normalized.model.id && normalized.model.modalities.includes("image")) {
    modelTiers.vision = visionModel;
    return {
      ...(isPlainObject(local.agents) ? local.agents : {}),
      modelTiers,
      vision: {
        enabled: true,
        model: visionModel,
        autoUseWhenMainModelTextOnly: true
      }
    };
  }
  return {
    ...(isPlainObject(local.agents) ? local.agents : {}),
    modelTiers,
    vision: {
      enabled: false,
      model: null,
      autoUseWhenMainModelTextOnly: true
    }
  };
}

function buildLocalAgentModelTiersConfig(local, config, agentModelTiers) {
  return {
    ...local,
    agents: {
      ...(isPlainObject(local.agents) ? local.agents : {}),
      modelTiers: {
        ...(config.agents?.modelTiers ?? {}),
        ...(local.agents?.modelTiers ?? {}),
        ...normalizeAgentModelTiers(agentModelTiers)
      }
    }
  };
}

function modelConfigEntry(model) {
  const entry = {
    id: model.id,
    label: model.label,
    description: model.description,
    thinking: model.thinking === true,
    modalities: Array.isArray(model.modalities) && model.modalities.length > 0 ? model.modalities : ["text"]
  };
  if (Number.isFinite(model.contextTokens)) {
    entry.contextTokens = model.contextTokens;
  }
  if (model.reasoningContentMode) {
    entry.reasoningContentMode = model.reasoningContentMode;
  }
  const reasoningEfforts = normalizeReasoningEfforts(model.reasoningEfforts);
  if (reasoningEfforts.length > 0) {
    entry.reasoningEfforts = reasoningEfforts;
  }
  if (reasoningEfforts.some((effort) => effort.id === model.defaultReasoningEffort)) {
    entry.defaultReasoningEffort = model.defaultReasoningEffort;
  }
  if (model.openaiExtraBody) {
    entry.openaiExtraBody = model.openaiExtraBody;
  }
  const agentModelTiers = normalizeAgentModelTiers(model.agentModelTiers);
  if (Object.keys(agentModelTiers).length > 0) {
    entry.agentModelTiers = agentModelTiers;
  }
  return entry;
}

function upsertModelEntry(models, model) {
  const next = modelConfigEntry(model);
  const index = models.findIndex((item) => item.id === next.id);
  if (index >= 0) {
    const merged = { ...models[index], ...next };
    if (!Number.isFinite(model.contextTokens)) delete merged.contextTokens;
    if (normalizeReasoningEfforts(model.reasoningEfforts).length === 0) {
      delete merged.reasoningEfforts;
      delete merged.defaultReasoningEffort;
    } else if (!normalizeReasoningEfforts(model.reasoningEfforts).some((effort) => effort.id === model.defaultReasoningEffort)) {
      delete merged.defaultReasoningEffort;
    }
    if (Object.keys(normalizeAgentModelTiers(model.agentModelTiers)).length === 0) {
      delete merged.agentModelTiers;
    }
    models[index] = merged;
  } else {
    models.push(next);
  }
}

function parseConfigUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** @param {unknown} value */
function publicGatewayUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const parsed = parseConfigUrl(raw);
  if (!parsed) {
    return raw.replace(/([?&](?:access_token|api_key|key|token|authorization)=)[^&#]*/gi, "$1[redacted]");
  }
  parsed.username = "";
  parsed.password = "";
  const query = new URLSearchParams();
  for (const [key, queryValue] of parsed.searchParams) {
    query.append(key, SENSITIVE_GATEWAY_QUERY_KEYS.has(key.toLowerCase()) ? "[redacted]" : queryValue);
  }
  parsed.search = query.toString();
  return parsed.href;
}

function urlHost(value) {
  return parseConfigUrl(value)?.hostname ?? "";
}

function positiveIntegerOrNull(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clonePlainObject(value) {
  return JSON.parse(JSON.stringify(value ?? {}));
}

function createTurnState(session, runTurn = runSessionTurn, options = {}) {
  return {
    session,
    runTurn,
    persisted: options.persisted === true,
    lastAccessedAt: Date.now(),
    accessVersion: 0,
    status: "idle",
    running: false,
    interrupting: false,
    quarantinedTurnId: "",
    forceSettleTimer: null,
    disposed: false,
    controller: null,
    currentPrompt: "",
    currentTurnId: "",
    currentAttachmentBytes: 0,
    currentTranscriptStart: 0,
    currentPermissionMode: permissionModeSummary(session).mode,
    turnChangeStats: emptyChangeStats(),
    queuedPrompts: [],
    events: [],
    eventSequence: 0,
    listeners: new Set(),
    listenerDisposers: new Map(),
    sessionApprovals: new Set(),
    pendingApprovals: new Map(),
    pendingQuestions: new Map(),
    finalOutput: "",
    backgroundSnapshotTimer: null,
    backgroundSnapshotDirty: false,
    backgroundSnapshotPromise: null,
    hooksTrusted: false
  };
}

function createSnapshotReadState(metadata = {}, cwd) {
  const id = String(metadata.id ?? "").trim();
  if (!id) {
    return null;
  }
  return {
    session: {
      id,
      cwd: metadata.cwd ?? cwd,
      model: metadata.model ?? "",
      config: {},
      messages: Array.isArray(metadata.transcript?.messages) ? metadata.transcript.messages : [],
      contextWindow: metadata.context ?? null,
      workflow: metadata.workflow ?? null
    }
  };
}

function publicBackgroundSnapshot(snapshot) {
  return {
    groups: snapshot.groups,
    totalGroups: snapshot.totalGroups,
    visibleGroups: snapshot.groups.length,
    hasRecords: snapshot.hasRecords === true
  };
}

function assistantTranscriptText(messages = []) {
  if (!Array.isArray(messages)) {
    return "";
  }
  return messages
    .filter((message) => message?.role === "assistant")
    .map((message) => messageContentText(message.content))
    .filter(Boolean)
    .join("\n");
}

function activeTranscriptMessages(state) {
  if (Array.isArray(state.session.transcriptMessages) && state.session.transcriptMessages.length > 0) {
    return state.session.transcriptMessages;
  }
  return Array.isArray(state.session.messages) ? state.session.messages : [];
}

function stableActiveTranscriptMessages(state) {
  const messages = activeTranscriptMessages(state);
  if (!state?.running || !state.currentTurnId) {
    return messages;
  }
  const start = Number(state.currentTranscriptStart);
  if (!Number.isInteger(start) || start < 0) {
    return messages;
  }
  return messages.slice(0, Math.min(start, messages.length));
}

async function readStoredTranscriptPage(store, metadata, options = {}) {
  const fallback = Array.isArray(metadata?.transcript?.messages) ? metadata.transcript.messages : [];
  const archive = metadata?.transcript?.archive;
  if (!archive || !Array.isArray(archive.chunks) || archive.chunks.length === 0) {
    return createTranscriptPageResult(fallback, options);
  }
  const result = await store.readTranscriptPage(archive, {
    before: options.before,
    limit: options.limit,
    visibleRoles: VISIBLE_TRANSCRIPT_ROLES
  });
  if (!result.ok) {
    return result;
  }
  return result;
}

function createTranscriptPageResult(messages, options = {}) {
  return { ok: true, positions: [], chunksRead: 0, ...createTranscriptPage(messages, options) };
}

function transcriptPageReadError(result) {
  return {
    ok: false,
    status: 500,
    code: result.error?.code ?? "TRANSCRIPT_PAGE_READ_ERROR",
    error: result.error?.message ?? "读取会话记录分页失败"
  };
}

function mergeActiveTranscriptPage(storedPage, state, options = {}) {
  const activeTail = stableActiveTranscriptMessages(state)
    .filter((message) => VISIBLE_TRANSCRIPT_ROLES.has(String(message?.role ?? "")));
  const overlap = transcriptOverlapSize(storedPage.messages, activeTail);
  const storedEntries = storedPage.messages.map((message, index) => ({
    message,
    position: nonNegativeInteger(storedPage.positions?.[index] ?? (storedPage.summary.start + index))
  }));
  const appended = activeTail.slice(overlap);
  const pendingEntries = activePendingTranscriptEntries(state, nonNegativeInteger(storedPage.summary.end));
  const positionedPending = pendingEntries.slice(-appended.length);
  const pendingMatches = positionedPending.length === appended.length
    && sameTranscriptSlice(positionedPending.map((entry) => entry.message), appended);
  const appendedEntries = appended.map((message, index) => ({
    message,
    position: pendingMatches
      ? positionedPending[index].position
      : nonNegativeInteger(storedPage.summary.end) + index
  }));
  const mergedEntries = storedEntries.concat(appendedEntries);
  const limit = clampTranscriptPageLimit(options.limit);
  const selected = mergedEntries.slice(-limit);
  const messages = selected.map((entry) => entry.message);
  const start = selected[0]?.position ?? 0;
  const pendingVisible = Array.isArray(state.session.transcriptArchive?.pendingMessages)
    ? state.session.transcriptArchive.pendingMessages.filter((message) => VISIBLE_TRANSCRIPT_ROLES.has(String(message?.role ?? ""))).length
    : 0;
  const archiveVisible = Number(state.session.transcriptArchive?.totalVisibleMessages);
  const total = Math.max(
    nonNegativeInteger(storedPage.summary.total),
    Number.isInteger(archiveVisible) && archiveVisible >= 0 ? archiveVisible + pendingVisible : 0,
    activeTail.length
  );
  return {
    ok: true,
    messages,
    positions: [],
    chunksRead: storedPage.chunksRead ?? 0,
    summary: {
      cursor: messages.length > 0 && start > 0 ? String(start) : null,
      nextCursor: messages.length > 0 && start > 0 ? String(start) : null,
      hasMore: messages.length > 0 && start > 0,
      total,
      returned: messages.length,
      start,
      end: Math.max(nonNegativeInteger(storedPage.summary.end), pendingEntries.at(-1)?.position + 1 || 0)
    }
  };
}

function activePendingTranscriptEntries(state, archiveEnd) {
  const pending = Array.isArray(state.session.transcriptArchive?.pendingMessages)
    ? state.session.transcriptArchive.pendingMessages
    : [];
  const entries = [];
  for (let index = 0; index < pending.length; index += 1) {
    const message = pending[index];
    if (VISIBLE_TRANSCRIPT_ROLES.has(String(message?.role ?? ""))) {
      entries.push({ message, position: archiveEnd + index });
    }
  }
  return entries;
}

function transcriptOverlapSize(baseMessages, tailMessages) {
  const base = Array.isArray(baseMessages) ? baseMessages : [];
  const tail = Array.isArray(tailMessages) ? tailMessages : [];
  const maxOverlap = Math.min(base.length, tail.length);
  for (let size = maxOverlap; size > 0; size -= 1) {
    if (sameTranscriptSlice(base.slice(base.length - size), tail.slice(0, size))) {
      return size;
    }
  }
  return 0;
}

function hasTranscriptCursor(value) {
  return value !== undefined && value !== null && value !== "";
}

function sameTranscriptSlice(left, right) {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((message, index) => transcriptMessageKey(message) === transcriptMessageKey(right[index]));
}

function transcriptMessageKey(message) {
  return JSON.stringify(message ?? null);
}

function createTranscriptPage(messages, options = {}) {
  const visible = Array.isArray(messages)
    ? messages.filter((message) => VISIBLE_TRANSCRIPT_ROLES.has(String(message?.role ?? "")))
    : [];
  const limit = clampTranscriptPageLimit(options.limit);
  const end = transcriptCursorIndex(options.before, visible.length);
  const start = Math.max(0, end - limit);
  const pageMessages = visible.slice(start, end);
  return {
    messages: pageMessages,
    summary: {
      cursor: start > 0 ? String(start) : null,
      nextCursor: start > 0 ? String(start) : null,
      hasMore: start > 0,
      total: visible.length,
      returned: pageMessages.length,
      start,
      end
    }
  };
}

function clampTranscriptPageLimit(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    return DEFAULT_TRANSCRIPT_PAGE_LIMIT;
  }
  return Math.min(number, MAX_TRANSCRIPT_PAGE_LIMIT);
}

function transcriptCursorIndex(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const number = Number(value);
  if (!Number.isInteger(number)) {
    return fallback;
  }
  return Math.max(0, Math.min(number, fallback));
}

function activeReplayCursor(state) {
  if (!state?.running || !state.currentTurnId) {
    return state?.eventSequence ?? 0;
  }
  const index = state.events.findIndex((event) => event.turnId === state.currentTurnId);
  return index > 0 ? nonNegativeInteger(state.events[index - 1].sequence) : 0;
}

function activeSessionRecord(state, persisted = null, backgroundSnapshot = null) {
  const modifiedAt = latestEventTime(state) ?? persisted?.modifiedAt ?? new Date().toISOString();
  const visibleBackground = Array.isArray(backgroundSnapshot?.groups) ? backgroundSnapshot.groups : [];
  const backgroundKinds = [...new Set(visibleBackground.map((group) => group.kind === "terminal" ? "terminal" : "subagent"))];
  return {
    id: state.session.id,
    title: state.session.title || persisted?.title || state.session.prompt || "未命名任务",
    status: activeDashboardStatus(state),
    model: state.session.model ?? persisted?.model ?? "",
    modifiedAt,
    finishedAt: persisted?.finishedAt ?? null,
    transcriptMessages: persisted?.transcriptMessages ?? activeTranscriptMessages(state).length,
    readable: persisted?.readable !== false,
    encrypted: persisted?.encrypted === true,
    active: true,
    running: state.running === true,
    queueLength: state.queuedPrompts.length,
    backgroundVisible: visibleBackground.length > 0,
    backgroundKinds,
    backgroundCount: visibleBackground.length,
    goalStatus: sessionRecordGoalStatus(state.session)
  };
}

function latestEventTime(state) {
  const latest = state.events.at(-1)?.at;
  return typeof latest === "string" ? latest : null;
}

function activeDashboardStatus(state) {
  if (state.quarantinedTurnId) {
    return "quarantined";
  }
  if (state.interrupting) {
    return "interrupting";
  }
  if (state.running) {
    return state.queuedPrompts.some((item) => item.kind === "guide") ? "引导中" : "running";
  }
  return state.status || state.session.status || "active";
}

function compareSessionRecords(a, b) {
  return String(b.modifiedAt ?? "").localeCompare(String(a.modifiedAt ?? ""));
}

function messageContentText(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content.map((item) => {
    if (typeof item === "string") return item;
    if (item && typeof item === "object" && "text" in item) return String(item.text ?? "");
    return "";
  }).filter(Boolean).join("\n");
}

/** @param {Record<string, any>} metadata */
function persistedSessionFailure(metadata) {
  const status = String(metadata?.status ?? "").trim().toLowerCase();
  if (!["failed", "error", "gateway_error"].includes(status)) {
    return null;
  }
  const rounds = Array.isArray(metadata?.gatewayRounds) ? metadata.gatewayRounds : [];
  const round = [...rounds].reverse().find((item) => item?.error && typeof item.error === "object");
  const error = round?.error;
  if (!error) {
    return null;
  }
  const httpStatus = Number.isInteger(error.status) && error.status > 0 ? error.status : null;
  const attempts = Number.isInteger(error.details?.attempts) && error.details.attempts > 0
    ? error.details.attempts
    : null;
  return {
    kind: "gateway",
    code: publicFailureText(error.code, 120) || "GATEWAY_ERROR",
    message: publicFailureText(error.message, 500) || "模型网关请求失败",
    httpStatus,
    upstreamMessage: gatewayFailureBodyMessage(error.details?.body),
    attempts
  };
}

/** @param {unknown} body */
function gatewayFailureBodyMessage(body) {
  if (typeof body !== "string" || !body.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(body);
    return publicFailureText(parsed?.error?.message ?? parsed?.message, 500) || null;
  } catch {
    return null;
  }
}

/** @param {unknown} value @param {number} maxLength */
function publicFailureText(value, maxLength) {
  const text = typeof value === "string" ? redactGatewayText(value).trim() : "";
  return text ? text.slice(0, maxLength) : "";
}

async function prepareDashboardSessionForQueuedTurn(state, env) {
  let config;
  try {
    config = await loadConfig({ cwd: state.session.cwd, env });
  } catch (error) {
    cancelAllQueuedTurns(state, "session-config-reload-failed");
    appendDashboardEvent(state, {
      type: "error",
      id: eventId("error"),
      code: "SESSION_CONFIG_RELOAD_FAILED",
      message: error instanceof Error ? error.message : String(error),
      at: new Date().toISOString()
    });
    return false;
  }
  if (!isConfigV2Enabled(config)) {
    applySessionConfig(state.session, configForExistingSession(state.session, config));
    return true;
  }
  const view = dashboardSessionV2MutationView(state.session, config);
  if (view.resolution.status !== "resolved") {
    applyDashboardSessionV2MutationView(state, view);
    cancelAllQueuedTurns(state, "model-selection-invalidated");
    appendDashboardEvent(state, {
      type: "session_config_updated",
      id: eventId("session-config"),
      sessionStatus: sessionStatusSummary(state.session),
      at: new Date().toISOString()
    });
    return false;
  }
  applyDashboardSessionV2MutationView(state, view);
  return true;
}

function beginPrompt(state, item, env) {
  if (
    state.disposed
    || state.running
    || state.quarantinedTurnId
    || state.session.modelSelectionInvalidation?.status === "unresolved"
  ) {
    return false;
  }
  applyPermissionMode(state.session, item.permissionMode);
  state.persisted = false;
  state.running = true;
  state.interrupting = false;
  state.status = "running";
  state.currentPrompt = item.prompt;
  state.currentTurnId = eventId("turn");
  state.currentAttachmentBytes = item.attachments.reduce((total, attachment) => total + nonNegativeInteger(attachment.size), 0);
  state.currentTranscriptStart = activeTranscriptMessages(state).length;
  state.currentPermissionMode = item.permissionMode;
  state.turnChangeStats = emptyChangeStats();
  state.controller = new AbortController();
  state.turnEnv = env;
  appendDashboardEvent(state, {
    type: "run_state",
    id: eventId("run-state"),
    running: true,
    turnId: state.currentTurnId,
    queue: queueSnapshot(state),
    current: publicQueueItem(item),
    permission: permissionModeSummary(state.session),
    goal: publicGoalSnapshot(state.session.goal, state.session.config),
    sessionStatus: sessionStatusSummary(state.session),
    changeStats: { ...state.turnChangeStats },
    at: new Date().toISOString()
  });
  appendDashboardEvent(state, {
    type: "user_message",
    id: eventId("user"),
    text: userMessageEventText(item),
    attachments: publicAttachments(item.attachments),
    turnId: state.currentTurnId,
    queuedKind: item.kind,
    at: new Date().toISOString()
  });
  runTurnInBackground(state, item, env);
  return true;
}

function runTurnInBackground(state, item, env) {
  const controller = state.controller;
  const turnId = state.currentTurnId;
  const eventStartIndex = state.events.length;
  let turnCompleteStatus = "";
  queueMicrotask(async () => {
    try {
      const result = await state.runTurn(state.session, {
        prompt: item.prompt,
        displayPrompt: displayPromptForQueueItem(item),
        attachments: item.attachments,
        env,
        stream: true,
        signal: controller.signal,
        hooksTrusted: state.hooksTrusted,
        approvalCallback: (request) => askApproval(state, request),
        userInputCallback: (request) => askQuestion(state, request),
        onEvent: async (event) => {
          const currentTurn = isCurrentTurn(state, controller, turnId);
          const backgroundEvent = isBackgroundLifecycleEvent(event);
          if (!currentTurn && !backgroundEvent) {
            return;
          }
          if (currentTurn && event.type === "turn_complete") {
            turnCompleteStatus = String(event.status ?? "").trim();
          }
          for (const mapped of mapSessionEventToDashboard(event)) {
            mapped.turnId = turnId;
            mapped.sessionStatus = sessionStatusSummary(state.session);
            if (mapped.type === "assistant_final") {
              const mappedEvent = /** @type {Record<string, any>} */ (mapped);
              mappedEvent.text = stripGoalStatusMarkers(mappedEvent.text);
            }
            if (currentTurn && mapped.type === "activity" && mapped.changeStats) {
              if (mapped.turnChangeStats) {
                state.turnChangeStats = normalizeChangeStats(mapped.turnChangeStats);
              } else {
                accumulateTurnChangeStats(state, mapped.changeStats);
                mapped.turnChangeStats = { ...state.turnChangeStats };
              }
            }
            appendDashboardEvent(state, mapped);
          }
          if (String(event.type ?? "").startsWith("subagent_group_")) {
            scheduleBackgroundSubagentSnapshot(state);
          }
          if (String(event.type ?? "").startsWith("background_terminal_")) {
            scheduleBackgroundSubagentSnapshot(state);
          }
          if (currentTurn && event.type === "tool_finish" && (event.name === "todo_write" || event.name === "plan_update")) {
            appendWorkflowSnapshot(state, event.name);
          }
          if (currentTurn && event.type === "tool_finish" && state.session.goal?.enabled) {
            const name = String(event.name ?? "");
            if (["write_file", "edit_file", "powershell", "bash"].includes(name)) {
              state.session.goal.hasWrites = true;
            }
          }
          if (currentTurn && event.type === "workflow_updated") {
            appendWorkflowSnapshot(state, event.reason ?? "workflow_updated");
          }
          if (event.type === "subagent_group_wakeup") {
            await queueBackgroundWakePrompt(state, event, env);
          }
        }
      });
      if (!isCurrentTurn(state, controller, turnId)) {
        return;
      }
      state.finalOutput = result.output ?? "";
      const turnEvents = state.events.slice(eventStartIndex);
      const terminalStatus = dashboardTurnStatus(turnCompleteStatus, result);
      if (terminalStatus === "completed" && !turnEvents.some((event) => event.type === "assistant_final")) {
        appendDashboardEvent(state, {
          type: "assistant_final",
          id: eventId("assistant-final"),
          text: stripGoalStatusMarkers(state.finalOutput),
          turnId: state.currentTurnId,
          at: new Date().toISOString()
        });
      }
      appendDashboardEvent(state, {
        type: "files_updated",
        id: eventId("files"),
        turnId: state.currentTurnId,
        files: collectSessionFiles(state.session, state.finalOutput),
        sessionStatus: sessionStatusSummary(state.session),
        changeStats: { ...state.turnChangeStats },
        at: new Date().toISOString()
      });
      state.status = terminalStatus;
    } catch (error) {
      if (!isCurrentTurn(state, controller, turnId)) {
        return;
      }
      appendDashboardEvent(state, {
        type: "error",
        id: eventId("error"),
        message: error instanceof Error ? error.message : String(error),
        at: new Date().toISOString()
      });
      state.status = "failed";
    } finally {
      if (!ownsTurn(state, controller, turnId)) {
        return;
      }
      const wasQuarantined = state.quarantinedTurnId === turnId;
      clearForceSettleTimer(state);
      state.controller = null;
      state.interrupting = false;
      state.quarantinedTurnId = "";
      if (wasQuarantined) {
        state.status = "interrupted";
      }
      state.currentPrompt = "";
      state.currentAttachmentBytes = 0;
      const pendingMutation = state.session.pendingModelSelectionMutation;
      if (pendingMutation) {
        applyDashboardSessionV2MutationView(state, pendingMutation);
      }
      updateGoalAfterTurn(state, state.status);
      maybeEnqueueGoalContinue(state, { wasQuarantined });
      let canStartNext = false;
      if (!wasQuarantined && !state.disposed && state.queuedPrompts.length > 0) {
        canStartNext = await prepareDashboardSessionForQueuedTurn(state, env);
      }
      state.running = false;
      const next = canStartNext ? takeNextQueueItem(state) : null;
      if (next && state.session.goal?.enabled) {
        next.permissionMode = "fullAccess";
      }
      let startedNext = false;
      if (next) {
        appendQueueUpdated(state);
        startedNext = beginPrompt(state, next, env);
      }
      if (state.session.goal?.enabled) {
        await persistGoalSnapshot(state);
      }
      if (!startedNext && !state.disposed) {
        appendDashboardEvent(state, {
          type: "run_state",
          id: eventId("run-state"),
          running: false,
          turnId: state.currentTurnId,
          queue: queueSnapshot(state),
          permission: permissionModeSummary(state.session),
          goal: publicGoalSnapshot(state.session.goal, state.session.config),
          sessionStatus: sessionStatusSummary(state.session),
          changeStats: { ...state.turnChangeStats },
          quarantined: false,
          quarantineReleased: wasQuarantined,
          at: new Date().toISOString()
        });
        state.currentTurnId = "";
        state.currentTranscriptStart = activeTranscriptMessages(state).length;
        state.turnEnv = null;
      }
      if (!state.disposed) {
        if (!startedNext) {
          scheduleSessionPersistenceCheck(state, env);
        }
        scheduleBackgroundSubagentSnapshot(state);
      }
    }
  });
}

function isCurrentTurn(state, controller, turnId) {
  return ownsTurn(state, controller, turnId) && state.quarantinedTurnId !== turnId && !state.disposed;
}

function ownsTurn(state, controller, turnId) {
  return state.controller === controller && state.currentTurnId === turnId;
}

function dashboardTurnStatus(turnCompleteStatus, result) {
  const status = String(turnCompleteStatus ?? "").trim().toLowerCase();
  if (status === "cancelled") {
    return "cancelled";
  }
  if (result?.interrupted === true || status === "interrupted") {
    return "interrupted";
  }
  if (["gateway_not_configured", "tool_limit", "vision_unavailable", "blocked"].includes(status)) {
    return "blocked";
  }
  return status === "completed" ? "completed" : "failed";
}

function isBackgroundLifecycleEvent(event) {
  const type = String(event?.type ?? "");
  return type.startsWith("subagent_group_") || type.startsWith("background_terminal_");
}

function requestTurnInterrupt(state, reason) {
  if (state.disposed || !state.running) {
    return false;
  }
  state.interrupting = true;
  state.status = "interrupting";
  appendDashboardEvent(state, {
    type: "turn_interrupt_requested",
    id: eventId("interrupt"),
    reason,
    queue: queueSnapshot(state),
    interrupting: true,
    at: new Date().toISOString()
  });
  cancelPendingInteractions(state, reason);
  if (state.controller && !state.controller.signal.aborted) {
    state.controller.abort(reason);
  }
  scheduleForceSettleInterruptedTurn(state, reason);
  return true;
}

function scheduleForceSettleInterruptedTurn(state, reason) {
  clearForceSettleTimer(state);
  const turnId = state.currentTurnId;
  if (!state.running || !turnId) {
    return;
  }
  const delayMs = interruptForceSettleMs(state.turnEnv);
  state.forceSettleTimer = setTimeout(() => {
    if (!state.running || state.currentTurnId !== turnId) {
      return;
    }
    forceSettleInterruptedTurn(state, reason, turnId);
  }, delayMs);
  state.forceSettleTimer.unref?.();
}

function interruptForceSettleMs(env = process.env) {
  const value = Number(env?.ANT_CODE_INTERRUPT_FORCE_SETTLE_MS ?? DEFAULT_INTERRUPT_FORCE_SETTLE_MS);
  if (!Number.isFinite(value)) {
    return DEFAULT_INTERRUPT_FORCE_SETTLE_MS;
  }
  return Math.max(50, Math.min(30000, Math.trunc(value)));
}

function clearForceSettleTimer(state) {
  if (state.forceSettleTimer) {
    clearTimeout(state.forceSettleTimer);
    state.forceSettleTimer = null;
  }
}

function forceSettleInterruptedTurn(state, reason, turnId) {
  state.forceSettleTimer = null;
  if (!state.running || state.currentTurnId !== turnId || state.disposed) {
    return;
  }
  state.quarantinedTurnId = turnId;
  state.interrupting = false;
  state.status = "quarantined";
  if (state.controller && !state.controller.signal.aborted) {
    state.controller.abort(reason);
  }
  cancelPendingInteractions(state, reason);
  appendDashboardEvent(state, {
    type: "error",
    id: eventId("error"),
    message: "中断请求已发出，但底层执行未及时结束；会话已隔离，不会启动排队任务。",
    turnId,
    interrupted: true,
    quarantined: true,
    at: new Date().toISOString()
  });
  void appendBackgroundSubagentSnapshot(state);
  appendDashboardEvent(state, {
    type: "run_state",
    id: eventId("run-state"),
    running: true,
    interrupting: false,
    quarantined: true,
    turnId,
    queue: queueSnapshot(state),
    sessionStatus: sessionStatusSummary(state.session),
    changeStats: { ...state.turnChangeStats },
    forced: true,
    at: new Date().toISOString()
  });
}

function cancelPendingInteractions(state, reason) {
  for (const [approvalId, pending] of Array.from(state.pendingApprovals.entries())) {
    state.pendingApprovals.delete(approvalId);
    appendDashboardEvent(state, {
      type: "approval_resolved",
      id: eventId("approval-resolved"),
      approvalId,
      action: reason,
      allowed: false,
      interrupted: true,
      at: new Date().toISOString()
    });
    pending.resolve(false);
  }
  for (const [questionId, pending] of Array.from(state.pendingQuestions.entries())) {
    state.pendingQuestions.delete(questionId);
    const result = normalizeQuestionAnswer({ cancelled: true }, pending.question);
    appendDashboardEvent(state, {
      type: "question_resolved",
      id: eventId("question-resolved"),
      questionId,
      answer: result.answer,
      selectedChoice: result.selectedChoice,
      selectedChoices: result.selectedChoices,
      cancelled: true,
      interrupted: true,
      at: new Date().toISOString()
    });
    pending.resolve(result);
  }
}

function askQuestion(state, request) {
  if (state.session?.goal?.enabled) {
    const skipped = goalUnattendedQuestionResult();
    appendDashboardEvent(state, {
      type: "goal_question_skipped",
      id: eventId("goal-question-skipped"),
      reason: skipped.reason,
      question: {
        prompt: String(request?.question ?? request?.prompt ?? "").slice(0, 240)
      },
      at: new Date().toISOString()
    });
    return skipped;
  }
  const questionId = eventId("question");
  const payload = normalizeQuestionRequest(request, questionId);
  const promise = new Promise((resolve) => {
    state.pendingQuestions.set(questionId, { resolve, question: payload });
  });
  appendDashboardEvent(state, {
    type: "question_required",
    id: questionId,
    question: payload,
    at: payload.at
  });
  return promise;
}

function askApproval(state, request) {
  const approvalKey = approvalKeyFor(request);
  if (state.sessionApprovals.has(approvalKey)) {
    appendDashboardEvent(state, {
      type: "approval_auto_allowed",
      id: eventId("approval-auto"),
      title: "已按本会话批准继续",
      approvalKey,
      at: new Date().toISOString()
    });
    return true;
  }
  const approvalId = eventId("approval");
  const payload = {
    id: approvalId,
    toolName: request.toolName,
    risk: request.definition?.risk ?? "unknown",
    reason: request.decision?.reason ?? "需要确认后继续",
    sensitive: request.decision?.sensitive === true,
    outsideWorkspace: request.decision?.outsideWorkspace === true,
    preview: buildApprovalPreview(request),
    input: sanitizeApprovalInput(request.input ?? {}),
    decision: request.decision ?? {},
    approvalKey,
    at: new Date().toISOString()
  };
  appendDashboardEvent(state, {
    type: "approval_required",
    id: approvalId,
    approval: payload,
    activity: permissionRequestToActivity(request),
    at: payload.at
  });
  return new Promise((resolve) => {
    state.pendingApprovals.set(approvalId, { resolve, approvalKey });
  });
}

function appendWorkflowSnapshot(state, reason) {
  const workflow = cloneWorkflowState(state.session.workflow);
  const hasItems = workflow.todos.length > 0 || workflow.plan.steps.length > 0;
  if (!hasItems) {
    return;
  }
  appendDashboardEvent(state, {
    type: "workflow_snapshot",
    id: eventId("workflow"),
    reason,
    workflow,
    summary: summarizeWorkflowSnapshot(workflow),
    at: new Date().toISOString()
  });
}

function summarizeWorkflowSnapshot(workflow) {
  const items = [...workflow.todos, ...(workflow.plan?.steps ?? [])];
  return {
    total: items.length,
    pending: items.filter((item) => item.status === "pending").length,
    in_progress: items.filter((item) => item.status === "in_progress").length,
    completed: items.filter((item) => item.status === "completed").length,
    cancelled: items.filter((item) => item.status === "cancelled").length
  };
}

function sessionStatusFromConfig(config) {
  const pseudoSession = {
    config,
    model: config.modelAlias,
    messages: [],
    contextWindow: null,
    usage: null
  };
  return sessionStatusSummary(pseudoSession);
}

function sessionStatusFromMetadata(metadata = {}, config = {}) {
  const status = {
    model: metadata.model ?? "",
    reasoningEffort: metadata.reasoningEffort ?? null,
    context: metadata.context ?? null
  };
  if (!isConfigV2Enabled(config)) {
    return status;
  }
  return sessionStatusWithSelectionResolution(
    status,
    resolveSessionModelSelection(config, metadata)
  );
}

function sessionStatusSummary(session) {
  const status = {
    model: session?.model ?? session?.config?.modelAlias ?? "",
    reasoningEffort: session?.config?.reasoningEffort ?? null,
    context: summarizeContextWindow(session ?? {})
  };
  const config = session?.config ?? {};
  if (!isConfigV2Enabled(config)) {
    return status;
  }
  if (session?.modelSelectionInvalidation?.status === "unresolved") {
    return sessionStatusWithSelectionResolution(status, session.modelSelectionInvalidation);
  }
  const selection = currentRuntimeModelSelection(config, {
    model: status.model,
    reasoningEffort: status.reasoningEffort
  });
  if (selection) {
    return {
      ...status,
      providerId: selection.provider,
      model: selection.model,
      reasoningEffort: selection.reasoningEffort ?? null,
      selectionResolved: true,
      selectionIssue: null
    };
  }
  const provider = activeGatewayProfileId(config);
  return sessionStatusWithSelectionResolution(status, resolveSessionModelSelection(config, {
    model: status.model,
    ...(provider
      ? {
          modelSelection: {
            provider,
            model: status.model,
            ...(status.reasoningEffort ? { reasoningEffort: status.reasoningEffort } : {})
          }
        }
      : {})
  }));
}

/** @param {Record<string, any>} status @param {Record<string, any>} resolution */
function sessionStatusWithSelectionResolution(status, resolution) {
  if (resolution?.status === "resolved") {
    return {
      ...status,
      providerId: resolution.selection.provider,
      model: resolution.selection.model,
      reasoningEffort: resolution.selection.reasoningEffort ?? null,
      selectionResolved: true,
      selectionIssue: null
    };
  }
  return {
    ...status,
    providerId: resolution?.selection?.provider ?? "",
    model: resolution?.model || resolution?.selection?.model || status.model || "",
    selectionResolved: false,
    selectionIssue: {
      code: resolution?.code ?? "SESSION_MODEL_SELECTION_UNRESOLVED",
      reason: resolution?.reason ?? "legacy-no-match",
      model: resolution?.model || resolution?.selection?.model || status.model || "",
      candidates: Array.isArray(resolution?.candidates) ? resolution.candidates.slice() : []
    }
  };
}

function emptyChangeStats() {
  return {
    additions: 0,
    deletions: 0,
    files: 0,
    redacted: false,
    truncated: false,
    approximate: false
  };
}

function accumulateTurnChangeStats(state, stats) {
  if (!stats || typeof stats !== "object") {
    return;
  }
  state.turnChangeStats ??= emptyChangeStats();
  state.turnChangeStats.additions += nonNegativeInteger(stats.additions);
  state.turnChangeStats.deletions += nonNegativeInteger(stats.deletions);
  state.turnChangeStats.files += Math.max(0, nonNegativeInteger(stats.files));
  state.turnChangeStats.redacted ||= stats.redacted === true;
  state.turnChangeStats.truncated ||= stats.truncated === true;
  state.turnChangeStats.approximate ||= stats.approximate === true;
}

function normalizeChangeStats(stats) {
  return {
    additions: nonNegativeInteger(stats?.additions),
    deletions: nonNegativeInteger(stats?.deletions),
    files: nonNegativeInteger(stats?.files),
    redacted: stats?.redacted === true,
    truncated: stats?.truncated === true,
    approximate: stats?.approximate === true
  };
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

function enqueuePrompt(state, prompt, permissionMode, kind, attachments = []) {
  if (!queueHasCapacity(state)) {
    return null;
  }
  const item = createQueueItem(prompt, permissionMode, kind, "", attachments);
  state.queuedPrompts.push(item);
  return item;
}

function queueHasCapacity(state) {
  return userVisibleQueueLength(state) < MAX_QUEUE;
}

function queueFullResult(state) {
  return {
    ok: false,
    status: 429,
    code: "QUEUE_FULL",
    error: `任务队列已满（最多 ${MAX_QUEUE} 条），请等待或取消排队任务后重试`,
    sessionId: state.session.id,
    queue: queueSnapshot(state),
    queueLength: state.queuedPrompts.length,
    permission: permissionModeSummary(state.session),
    sessionStatus: sessionStatusSummary(state.session)
  };
}

function createQueueItem(prompt, permissionMode = "plan", kind = "prompt", guidance = "", attachments = []) {
  const text = String(prompt ?? "").trim();
  return {
    id: eventId("queue"),
    prompt: text,
    permissionMode: normalizePermissionMode(permissionMode),
    kind,
    title: "",
    guidance: String(guidance || text).trim(),
    attachments: kind === "prompt" ? normalizeTurnAttachments(attachments) : [],
    at: new Date().toISOString()
  };
}

function createWakeQueueItem(event, permissionMode = "plan") {
  const prompt = String(event?.wakePrompt ?? "").trim();
  if (!prompt) {
    return null;
  }
  return {
    ...createQueueItem(prompt, permissionMode, "wakeup"),
    title: "子智能体完成，主控自动接续",
    groupId: String(event.groupId ?? "").trim() || null
  };
}

async function queueBackgroundWakePrompt(state, event, env) {
  if (state.disposed || state.quarantinedTurnId) {
    return { ok: false, status: 409, code: "SESSION_UNAVAILABLE" };
  }
  const item = createWakeQueueItem(event, state.currentPermissionMode);
  if (!item) {
    return;
  }
  if (state.running) {
    let config;
    try {
      config = await loadConfig({ cwd: state.session.cwd, env });
    } catch {
      return { ok: false, status: 503, code: "SESSION_CONFIG_RELOAD_FAILED" };
    }
    if (isConfigV2Enabled(config)) {
      const admission = dashboardSessionV2MutationView(state.session, config);
      if (admission.resolution.status !== "resolved") {
        invalidateRunningDashboardSessionSelection(state, admission);
        return unresolvedSessionModelSelectionResult(admission.resolution, state.session.id);
      }
    }
    if (!queueHasCapacity(state)) {
      appendDashboardEvent(state, {
        type: "wakeup_queue_full",
        id: eventId("wakeup-queue-full"),
        code: "QUEUE_FULL",
        groupId: item.groupId,
        queue: queueSnapshot(state),
        queueLength: state.queuedPrompts.length,
        running: true,
        at: new Date().toISOString()
      });
      await appendBackgroundSubagentSnapshot(state);
      return { ok: false, ...queueFullResult(state) };
    }
    state.queuedPrompts.push(item);
    appendDashboardEvent(state, {
      type: "wakeup_queued",
      id: eventId("wakeup"),
      groupId: item.groupId,
      queue: queueSnapshot(state),
      queueLength: state.queuedPrompts.length,
      running: true,
      at: new Date().toISOString()
    });
    appendQueueUpdated(state);
    void markWakePromptConsumed(state, event)
      .finally(() => scheduleBackgroundSubagentSnapshot(state));
    scheduleBackgroundSubagentSnapshot(state);
    return { ok: true, queued: true, item };
  } else {
    if (!await prepareDashboardSessionForQueuedTurn(state, env)) {
      return unresolvedSessionModelSelectionResult(
        state.session.modelSelectionInvalidation ?? { status: "unresolved", reason: "session-config-reload-failed" },
        state.session.id
      );
    }
    if (!beginPrompt(state, item, env)) {
      return unresolvedSessionModelSelectionResult(
        state.session.modelSelectionInvalidation ?? { status: "unresolved", reason: "admission-blocked" },
        state.session.id
      );
    }
    appendDashboardEvent(state, {
      type: "wakeup_queued",
      id: eventId("wakeup"),
      groupId: item.groupId,
      queue: queueSnapshot(state),
      queueLength: state.queuedPrompts.length,
      running: true,
      started: true,
      at: new Date().toISOString()
    });
    void markWakePromptConsumed(state, event)
      .finally(() => scheduleBackgroundSubagentSnapshot(state));
    scheduleBackgroundSubagentSnapshot(state);
    return { ok: true, started: true, item };
  }
}

async function markWakePromptConsumed(state, event) {
  const groupId = String(event?.groupId ?? "").trim();
  if (!groupId) {
    return;
  }
  try {
    await createAgentTaskGroupStore({ cwd: state.session.cwd }).updateGroup(groupId, {
      wakePromptConsumedAt: new Date().toISOString()
    });
  } catch {
    // Wakeup continuation must not fail only because the observability marker could not be written.
  }
}

async function appendBackgroundSubagentSnapshot(state) {
  if (state.disposed) {
    return;
  }
  const snapshot = await buildBackgroundSubagentSnapshot(state);
  if (state.disposed) {
    return;
  }
  if (!snapshot.hasRecords && snapshot.groups.length === 0) {
    appendDashboardEvent(state, {
      type: "background_subagent_snapshot",
      id: eventId("background-subagents"),
      groups: [],
      totalGroups: 0,
      visibleGroups: 0,
      sessionStatus: sessionStatusSummary(state.session),
      at: new Date().toISOString()
    });
    stopBackgroundSnapshotPolling(state);
    return;
  }
  appendDashboardEvent(state, {
    type: "background_subagent_snapshot",
    id: eventId("background-subagents"),
    groups: snapshot.groups,
    totalGroups: snapshot.totalGroups,
    visibleGroups: snapshot.groups.length,
    sessionStatus: sessionStatusSummary(state.session),
    at: new Date().toISOString()
  });
  updateBackgroundSnapshotPolling(state, snapshot.groups);
}

/** @param {any} state */
function scheduleBackgroundSubagentSnapshot(state) {
  if (state.disposed) {
    return null;
  }
  if (state.backgroundSnapshotPromise) {
    state.backgroundSnapshotDirty = true;
    return state.backgroundSnapshotPromise;
  }
  state.backgroundSnapshotDirty = false;
  const promise = appendBackgroundSubagentSnapshot(state)
    .catch(() => {})
    .finally(() => {
      if (state.backgroundSnapshotPromise === promise) {
        state.backgroundSnapshotPromise = null;
        if (state.backgroundSnapshotDirty && !state.disposed) {
          state.backgroundSnapshotDirty = false;
          queueMicrotask(() => scheduleBackgroundSubagentSnapshot(state));
        }
      }
    });
  state.backgroundSnapshotPromise = promise;
  return promise;
}

/** @param {any} state @param {{ groups?: Array<Record<string, any>>; signal?: AbortSignal }} [options] */
async function buildBackgroundSubagentSnapshot(state, options = {}) {
  try {
    const groupStore = createAgentTaskGroupStore({ cwd: state.session.cwd });
    const taskStore = createAgentTaskStore({ cwd: state.session.cwd });
    const groups = Array.isArray(options.groups)
      ? options.groups.filter((group) => group.parentSessionId === state.session.id)
      : await groupStore.listGroups({ parentSessionId: state.session.id, signal: options.signal });
    const visible = [];
    for (const group of groups) {
      const tasks = await readDashboardGroupTasks(taskStore, group.taskIds);
      const summary = summarizeGroupStatus(tasks, { waitFor: group.waitFor });
      const runningTasks = tasks.filter((task) => !TERMINAL_TASK_STATUSES.has(String(task.status)));
      const health = backgroundTaskHealth(runningTasks);
      const status = backgroundSnapshotStatus(group, summary, runningTasks, health);
      if (!status) {
        continue;
      }
      visible.push({
        groupId: group.id,
        taskId: runningTasks[0]?.id ?? tasks[0]?.id ?? group.taskIds[0] ?? null,
        profile: snapshotGroupProfile(tasks),
        waitFor: group.waitFor,
        wakeParent: group.wakeParent,
        status,
        stale: status === "stale" || status === "lost",
        staleKind: status === "lost" ? "lost" : status === "stale" ? "stale" : null,
        staleReason: backgroundStaleReason(status, health),
        lastProgressAt: health.lastProgressAt,
        heartbeatAt: health.heartbeatAt,
        staleSeconds: Number.isFinite(health.staleMs) ? Math.floor(health.staleMs / 1000) : null,
        heartbeatAgeSeconds: Number.isFinite(health.heartbeatAgeMs) ? Math.floor(health.heartbeatAgeMs / 1000) : null,
        cancellable: runningTasks.length > 0 || !TERMINAL_GROUP_STATUSES.has(String(group.status)),
        completed: summary.completed === true,
        wakePromptQueued: Boolean(group.wakePromptQueuedAt && !group.wakePromptConsumedAt),
        summary: group.summary || group.latestProgress || summary.summary,
        taskCount: tasks.length || group.taskIds.length,
        runningCount: runningTasks.length,
        updatedAt: latestSnapshotTimestamp(group, tasks)
      });
    }
    const terminals = listBackgroundTerminalTasks({ parentSessionId: state.session.id, cwd: state.session.cwd })
      .filter((task) => task.status === "running" || task.status === "starting" || task.status === "cancelling")
      .map((task) => ({
        groupId: null,
        taskId: task.taskId,
        kind: "terminal",
        profile: "terminal",
        waitFor: null,
        wakeParent: false,
        status: task.status === "starting" ? "starting" : task.status === "cancelling" ? "cancelling" : "running",
        stale: false,
        staleKind: null,
        staleReason: "",
        lastProgressAt: task.updatedAt,
        heartbeatAt: task.updatedAt,
        staleSeconds: null,
        heartbeatAgeSeconds: null,
        cancellable: true,
        completed: false,
        wakePromptQueued: false,
        summary: [
          task.title,
          task.pid ? `pid=${task.pid}` : null,
          task.stdoutPath ? `stdout=${task.stdoutPath}` : null
        ].filter(Boolean).join(" · "),
        taskCount: 1,
        runningCount: task.status === "running" || task.status === "cancelling" ? 1 : 0,
        updatedAt: task.updatedAt
      }));
    return {
      hasRecords: groups.length > 0 || terminals.length > 0,
      totalGroups: groups.length + terminals.length,
      groups: [...visible, ...terminals]
    };
  } catch {
    return { hasRecords: false, totalGroups: 0, groups: [] };
  }
}

/**
 * @param {any[]} states
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<Map<string, Array<Record<string, any>> | null>>}
 */
async function loadDashboardGroupSnapshots(states, options = {}) {
  /** @type {Map<string, Array<Record<string, any>> | null>} */
  const byWorkspace = new Map();
  for (const state of states) {
    const cwd = path.resolve(state.session.cwd);
    if (!byWorkspace.has(cwd)) {
      byWorkspace.set(cwd, null);
    }
  }
  await Promise.all([...byWorkspace.keys()].map(async (cwd) => {
    const store = createAgentTaskGroupStore({ cwd });
    const groups = await store.listGroups({ signal: options.signal });
    byWorkspace.set(cwd, groups);
  }));
  return byWorkspace;
}

async function readDashboardGroupTasks(taskStore, taskIds = []) {
  const tasks = [];
  for (const id of Array.isArray(taskIds) ? taskIds : []) {
    const result = await taskStore.readTask(id);
    if (result.ok) {
      tasks.push(result.task);
    }
  }
  return tasks;
}

function backgroundSnapshotStatus(group, summary, runningTasks, health = {}) {
  if (group.wakePromptQueuedAt && !group.wakePromptConsumedAt) {
    return "waiting";
  }
  if (runningTasks.length > 0) {
    if (health.heartbeatLost) {
      return "lost";
    }
    if (health.progressStale) {
      return "stale";
    }
    return "running";
  }
  if (!TERMINAL_GROUP_STATUSES.has(String(group.status)) && summary.completed !== true) {
    return "running";
  }
  return null;
}

function backgroundTaskHealth(runningTasks = []) {
  if (!Array.isArray(runningTasks) || runningTasks.length === 0) {
    return {
      progressStale: false,
      heartbeatLost: false,
      lastProgressAt: null,
      heartbeatAt: null,
      staleMs: null,
      heartbeatAgeMs: null
    };
  }
  const now = Date.now();
  const progressTimes = runningTasks.map((task) => parseTimestamp(task.progressAt ?? task.updatedAt ?? task.startedAt)).filter(Number.isFinite);
  const heartbeatTimes = runningTasks.map((task) => parseTimestamp(task.heartbeatAt ?? task.updatedAt ?? task.startedAt)).filter(Number.isFinite);
  const latestProgressMs = progressTimes.length > 0 ? Math.max(...progressTimes) : null;
  const latestHeartbeatMs = heartbeatTimes.length > 0 ? Math.max(...heartbeatTimes) : null;
  const staleMs = Number.isFinite(latestProgressMs) ? now - latestProgressMs : null;
  const heartbeatAgeMs = Number.isFinite(latestHeartbeatMs) ? now - latestHeartbeatMs : null;
  return {
    progressStale: Number.isFinite(staleMs) && staleMs >= BACKGROUND_STALE_PROGRESS_MS,
    heartbeatLost: !Number.isFinite(heartbeatAgeMs) || heartbeatAgeMs >= BACKGROUND_DEAD_HEARTBEAT_MS,
    lastProgressAt: Number.isFinite(latestProgressMs) ? new Date(latestProgressMs).toISOString() : null,
    heartbeatAt: Number.isFinite(latestHeartbeatMs) ? new Date(latestHeartbeatMs).toISOString() : null,
    staleMs,
    heartbeatAgeMs
  };
}

function backgroundStaleReason(status, health = {}) {
  if (status === "lost") {
    return "heartbeat 已超时，后台子智能体可能已经失联";
  }
  if (status === "stale") {
    return "长时间没有新的进展记录，但 heartbeat 仍在更新";
  }
  return "";
}

function snapshotGroupProfile(tasks = []) {
  const profiles = [...new Set(tasks.map((task) => String(task.profile ?? "").trim()).filter(Boolean))];
  if (profiles.length === 1) {
    return profiles[0];
  }
  if (profiles.length > 1) {
    return `${profiles.length} profiles`;
  }
  return null;
}

function latestSnapshotTimestamp(group, tasks = []) {
  return [
    group.updatedAt,
    group.completedAt,
    ...tasks.map((task) => task.progressAt),
    ...tasks.map((task) => task.heartbeatAt),
    ...tasks.map((task) => task.updatedAt),
    ...tasks.map((task) => task.finishedAt)
  ].filter(Boolean).sort().at(-1) ?? new Date().toISOString();
}

function updateBackgroundSnapshotPolling(state, groups = []) {
  if (Array.isArray(groups) && groups.length > 0) {
    startBackgroundSnapshotPolling(state);
  } else {
    stopBackgroundSnapshotPolling(state);
  }
}

function startBackgroundSnapshotPolling(state) {
  if (state.backgroundSnapshotTimer || state.disposed) {
    return;
  }
  state.backgroundSnapshotTimer = setInterval(() => {
    scheduleBackgroundSubagentSnapshot(state);
  }, BACKGROUND_SNAPSHOT_INTERVAL_MS);
  state.backgroundSnapshotTimer.unref?.();
}

function stopBackgroundSnapshotPolling(state) {
  if (!state.backgroundSnapshotTimer) {
    return;
  }
  clearInterval(state.backgroundSnapshotTimer);
  state.backgroundSnapshotTimer = null;
}

function parseTimestamp(value) {
  const time = Date.parse(String(value ?? ""));
  return Number.isFinite(time) ? time : null;
}

function appendQueueUpdated(state) {
  appendDashboardEvent(state, {
    type: "queue_updated",
    id: eventId("queue-updated"),
    turnId: state.currentTurnId || null,
    queue: queueSnapshot(state),
    queueLength: state.queuedPrompts.length,
    running: state.running,
    sessionStatus: sessionStatusSummary(state.session),
    changeStats: { ...state.turnChangeStats },
    at: new Date().toISOString()
  });
}

function queueSnapshot(state) {
  return state.queuedPrompts.map(publicQueueItem);
}

function publicQueueItem(item) {
  const attachments = publicAttachments(item.attachments);
  return {
    id: item.id,
    kind: item.kind,
    preview: previewText([
      item.title || (item.kind === "guide" ? item.guidance : item.kind === GOAL_CONTINUE_KIND ? "Goal 续跑" : item.prompt),
      attachments.length > 0 ? `${attachments.length} 张图片` : ""
    ].filter(Boolean).join(" · ")),
    attachments,
    permissionMode: item.permissionMode,
    at: item.at
  };
}

function displayPromptForQueueItem(item) {
  if (item.kind === "guide") {
    return item.guidance;
  }
  if (item.kind === "wakeup") {
    return item.title || "子智能体完成，主控自动接续";
  }
  if (item.kind === GOAL_CONTINUE_KIND) {
    return item.title || "Goal 续跑";
  }
  return item.prompt;
}

function userMessageEventText(item) {
  if (item.kind === "wakeup" || item.kind === GOAL_CONTINUE_KIND) {
    return displayPromptForQueueItem(item);
  }
  return item.kind === "guide" ? item.guidance : item.prompt;
}

function normalizeTurnAttachments(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map(normalizeTurnAttachment)
    .filter(Boolean)
    .slice(0, 6);
}

function normalizeTurnAttachment(item) {
  if (!item || typeof item !== "object" || item.type !== "image") {
    return null;
  }
  const data = String(item.data ?? "").replace(/\s+/g, "");
  const mimeType = String(item.mimeType ?? item.mime_type ?? "").trim().toLowerCase();
  if (!data || !/^image\/[a-z0-9.+-]+$/i.test(mimeType)) {
    return null;
  }
  return {
    type: "image",
    data,
    mimeType,
    name: String(item.name ?? "image").trim().slice(0, 160),
    size: nonNegativeInteger(item.size ?? item.bytes ?? item.sizeBytes)
  };
}

function publicAttachments(attachments) {
  return normalizeTurnAttachments(attachments).map((item) => ({
    type: "image",
    name: item.name,
    mimeType: item.mimeType,
    size: item.size
  }));
}

function previewText(value, max = 120) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

function buildGuidePrompt(guidance, activePrompt = "") {
  const text = String(guidance ?? "").trim();
  const original = String(activePrompt ?? "").trim();
  const lines = [
    "User guidance for the interrupted active turn:",
    text,
    "",
    "Continue the task using this guidance. If partial work from the interrupted turn is already visible, avoid repeating it unless needed."
  ];
  if (original && !includesPromptContext(text, original)) {
    lines.push("", "Original active prompt:", original);
  }
  return lines.join("\n");
}

function includesPromptContext(text, original) {
  if (!text || !original) {
    return false;
  }
  return normalizeGuideText(text).includes(normalizeGuideText(original));
}

function normalizeGuideText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function isStopGuidance(guidance) {
  const normalized = String(guidance ?? "")
    .trim()
    .toLowerCase()
    .replace(/[。.!！\s]+$/g, "");
  return /^(停止|停下|取消|中止|终止|abort|cancel|stop)(当前(任务|轮次|请求))?$/.test(normalized);
}

function appendDashboardEvent(state, event) {
  if (state.disposed) {
    return;
  }
  state.eventSequence += 1;
  const normalized = {
    at: new Date().toISOString(),
    ...event,
    id: event.id ?? eventId(event.type ?? "event"),
    sequence: state.eventSequence
  };
  if ((normalized.status === "running" || normalized.status === "waiting") && normalized.coalesceKey) {
    const existingIndex = state.events.findIndex((item) =>
      item.type === "activity"
      && item.coalesceKey === normalized.coalesceKey
      && (item.status === "running" || item.status === "waiting")
    );
    if (existingIndex >= 0) {
      state.events.splice(existingIndex, 1);
      state.events.push(normalized);
      for (const listener of state.listeners) {
        listener(normalized);
      }
      return;
    }
  }
  state.events.push(normalized);
  if (state.events.length > MAX_EVENTS) {
    state.events.splice(0, state.events.length - MAX_EVENTS);
  }
  for (const listener of state.listeners) {
    listener(normalized);
  }
}

async function resolveDashboardTrust(options) {
  const config = await loadConfig({ cwd: options.cwd, env: options.env });
  const trust = await resolveWorkspaceTrust({
    cwd: options.cwd,
    env: options.env,
    sensitivity: config.security?.sensitivity
  });
  return {
    trusted: options.processTrusted === true || trust.trusted === true,
    persisted: Boolean(trust.record),
    requiresPerProcessConfirmation: trust.requiresPerProcessConfirmation === true,
    sensitivity: config.security?.sensitivity ?? "standard",
    displayPath: trust.displayPath,
    storePath: trust.storePath,
    workspaceId: trust.workspaceId,
    record: trust.record
  };
}

function sanitizeApprovalInput(input) {
  return sanitizeSensitiveValue(input, { maxStringLength: 500 });
}

function normalizeQuestionRequest(request, id) {
  const choices = Array.isArray(request?.choices)
    ? request.choices.map(normalizeQuestionChoice).filter(Boolean)
    : [];
  return {
    id,
    header: String(request?.header ?? "需求核对"),
    question: String(request?.question ?? request?.prompt ?? "请确认需求"),
    choices,
    multiple: Boolean(request?.multiple || request?.selectionMode === "multi"),
    allowCustom: choices.length === 0 || request?.allowCustom !== false,
    confirmLabel: String(request?.confirmLabel ?? "确认"),
    at: new Date().toISOString()
  };
}

function normalizeQuestionChoice(choice) {
  if (typeof choice === "string") {
    const label = choice.trim();
    return label ? { label, value: label, selected: false } : null;
  }
  if (!choice || typeof choice !== "object") {
    return null;
  }
  const label = String(choice.label ?? choice.text ?? choice.value ?? "").trim();
  if (!label) {
    return null;
  }
  return {
    label,
    value: String(choice.value ?? label),
    description: typeof choice.description === "string" ? choice.description : "",
    selected: choice.selected === true
  };
}

function normalizeQuestionAnswer(answer, question) {
  const choices = Array.isArray(question?.choices) ? question.choices : [];
  const cancelled = answer?.cancelled === true;
  if (cancelled) {
    return {
      answer: "",
      selectedChoice: null,
      selectedChoices: [],
      customAnswer: null,
      cancelled: true,
      workflowReminder: null
    };
  }
  const selectedValues = Array.isArray(answer?.selectedChoices)
    ? answer.selectedChoices.map(String)
    : typeof answer?.selectedChoice === "string"
      ? [answer.selectedChoice]
      : [];
  const selectedChoices = selectedValues
    .map((value) => choices.find((choice) => choice.value === value || choice.label === value)?.label ?? value)
    .filter(Boolean);
  const customAnswer = String(answer?.customAnswer ?? answer?.answer ?? "").trim();
  const resolvedAnswer = customAnswer || selectedChoices.join(", ");
  return {
    answer: resolvedAnswer,
    selectedChoice: selectedChoices[0] ?? null,
    selectedChoices,
    customAnswer: customAnswer || null,
    cancelled: false,
    workflowReminder: choices.length > 0
      ? "If this confirmation starts multi-step work, update the visible workflow state with todo_write and/or plan_update. Before the final response, mark completed visible items as completed."
      : null
  };
}

function eventId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
