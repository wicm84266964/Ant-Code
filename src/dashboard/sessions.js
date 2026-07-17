import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createSession, persistSessionSnapshot, runSessionTurn } from "../core/session.js";
import { clearSessionContext, compactSessionContextWithModel, createContextWindow, summarizeContextWindow } from "../core/context-window.js";
import { createLabModelGateway } from "../model-gateway/client.js";
import { listConfiguredModels, normalizeAgentModelTiers, resolveModelSelection } from "../model-gateway/models.js";
import { resolveWorkspaceTrust, trustWorkspace as saveWorkspaceTrust } from "../permissions/workspace-trust.js";
import { createSessionStore } from "../storage/session-store.js";
import { GATEWAY_PROTOCOLS, globalConfigPath, loadConfig, localProjectConfigPath } from "../config/load-config.js";
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
 * }} options
 */
export function createDashboardRuntime(options) {
  const runtimeEnv = options.env ?? process.env;
  const active = new ActiveSessionMap();
  const sessionMutationLocks = new Map();
  const activeCapacityLocks = new Map();
  const turnRequests = new Map();
  const activePolicy = dashboardActiveSessionPolicy(runtimeEnv);
  let processTrusted = false;
  let selectedModelId = "";
  let shuttingDown = false;
  let activeSweepPromise = null;
  /** @type {any} */
  const readRuntimeActivity = options.lifecycleActivity ?? dashboardRuntimeActivity;
  /** @type {any} */
  const cancelBackgroundWork = options.cancelBackgroundWork ?? cancelSessionBackgroundWork;
  const resolveConfigEnv = () => dashboardConfigEnv(options.cwd, runtimeEnv);
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

  return {
    cwd: options.cwd,
    env: runtimeEnv,
    active,
    activePolicy: { ...activePolicy },
    async status() {
      const configEnv = await resolveConfigEnv();
      const config = await loadConfig({ cwd: options.cwd, env: configEnv });
      const modelConfig = selectedModelId ? { ...config, modelAlias: selectedModelId } : config;
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
    async switchModel(input = {}) {
      const configEnv = await resolveConfigEnv();
      const config = await loadConfig({ cwd: options.cwd, env: configEnv });
      const modelId = String(input.modelId ?? input.model ?? "").trim();
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
      let refreshed = config;
      if (input.applyAgentDefaults === true && Object.keys(selection.model.agentModelTiers ?? {}).length > 0) {
        const localPath = localProjectConfigPath(options.cwd);
        const mutation = await mutateDashboardConfig(localPath, (local) => (
          buildLocalAgentModelTiersConfig(local, config, selection.model.agentModelTiers)
        ));
        if (!mutation.ok) {
          return mutation;
        }
        refreshed = await loadConfig({ cwd: options.cwd, env: await resolveConfigEnv() });
      }
      selectedModelId = selection.model.id;
      if (state) {
        applySessionModel(state.session, selection.model.id);
        state.persisted = false;
        state.session.config = {
          ...state.session.config,
          agents: {
            ...(state.session.config.agents ?? {}),
            modelTiers: { ...(refreshed.agents?.modelTiers ?? state.session.config.agents?.modelTiers ?? {}) }
          }
        };
        appendDashboardEvent(state, {
          type: "model_switched",
          id: eventId("model"),
          model: selection.model.id,
          modelInfo: publicModelOption(selection.model, selection.model.id),
          sessionStatus: sessionStatusSummary(state.session),
          at: new Date().toISOString()
        });
        return {
          ok: true,
          sessionId: state.session.id,
          sessionStatus: sessionStatusSummary(state.session),
          models: modelOptions(state.session.config),
          agentModelTiers: publicAgentModelTiers(state.session.config),
          visionAgent: publicVisionAgent(state.session.config),
          gatewayConfig: publicGatewayConfig(refreshed),
          gatewayProfiles: publicGatewayProfiles(refreshed)
        };
      }
      const modelConfig = { ...refreshed, modelAlias: selectedModelId };
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
    async saveModelConfig(input = {}) {
      const configEnv = await resolveConfigEnv();
      let config = await loadConfig({ cwd: options.cwd, env: configEnv });
      let normalized = normalizeModelConfigInput(input, config);
      if (!normalized.ok) {
        return normalized;
      }
      const configPath = modelConfigTargetPath(options.cwd, configEnv, normalized.saveTarget);
      const mutation = await mutateDashboardConfig(configPath, async (targetConfig) => {
        config = await loadConfig({ cwd: options.cwd, env: await resolveConfigEnv() });
        normalized = normalizeModelConfigInput(input, config);
        if (!normalized.ok) {
          throw dashboardConfigResultError(normalized);
        }
        return buildLocalModelConfig(targetConfig, config, normalized);
      });
      if (!mutation.ok) {
        return mutation;
      }

      const refreshed = await loadConfig({ cwd: options.cwd, env: await resolveConfigEnv() });
      if (normalized.switchToModel) {
        selectedModelId = normalized.model.id;
      } else if (shouldReplaceModelEntries(config, normalized) && !listConfiguredModels(refreshed).some((model) => model.id === selectedModelId)) {
        selectedModelId = String(refreshed.modelAlias ?? "").trim();
      }
      const modelConfig = selectedModelId ? { ...refreshed, modelAlias: selectedModelId } : refreshed;
      const syncedState = syncIdleSessionConfig(active, input.sessionId, modelConfig);
      const state = syncedState ?? activeStateForSession(active, input.sessionId);
      const activeConfig = syncedState?.session.config ?? (state?.session.config ? configForStatusLists(state.session.config, modelConfig) : modelConfig);
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
    async deleteModelConfig(input = {}) {
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
      let nextLocal = buildLocalDeleteModelConfig(await readJsonConfig(localPath), config, modelId);
      if (!nextLocal.ok) {
        return {
          ok: false,
          status: nextLocal.status ?? 400,
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
        nextLocal = buildLocalDeleteModelConfig(local, latestConfig, modelId);
        if (!nextLocal.ok) {
          throw dashboardConfigResultError(nextLocal);
        }
        return nextLocal.config;
      });
      if (!mutation.ok) {
        return mutation;
      }
      const refreshed = await loadConfig({ cwd: options.cwd, env: await resolveConfigEnv() });
      if (selectedModelId === modelId || !listConfiguredModels(refreshed).some((model) => model.id === selectedModelId)) {
        selectedModelId = String(refreshed.modelAlias ?? "").trim();
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
      const modelConfig = selectedModelId ? { ...refreshed, modelAlias: selectedModelId } : refreshed;
      const activeConfig = state?.session.config ?? modelConfig;
      return {
        ok: true,
        deletedModel: modelId,
        clearedGateway: nextLocal.clearedGateway === true,
        configPath: localPath,
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
    async switchGatewayProfile(input = {}) {
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
      const localPath = localProjectConfigPath(options.cwd);
      let nextLocal = buildGatewayProfileSwitchConfig(await readJsonConfig(localPath), config, profileId);
      if (!nextLocal.ok) {
        return {
          ok: false,
          status: 404,
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
      if (state) {
        applySessionConfig(state.session, refreshed);
        state.persisted = false;
        appendDashboardEvent(state, {
          type: "gateway_profile_switched",
          id: eventId("gateway-profile"),
          profileId,
          sessionStatus: sessionStatusSummary(state.session),
          at: new Date().toISOString()
        });
      }
      const modelConfig = selectedModelId ? { ...refreshed, modelAlias: selectedModelId } : refreshed;
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
        encrypted: record.encrypted === true
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
          sessionStatus: activeState ? sessionStatusSummary(activeState.session) : sessionStatusFromMetadata(metadata),
          permission: permissionModeSummary(activeState?.session ?? metadata),
          transcript,
          transcriptPage: transcriptPage.summary,
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
        selectedModelId,
        runTurn: options.runTurn ?? runSessionTurn
      }, input));
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
  const configEnv = await context.resolveConfigEnv();
  const trust = await resolveDashboardTrust({ cwd: context.cwd, env: configEnv, processTrusted: context.processTrusted });
  if (!trust.trusted) {
    return { ok: false, status: 403, error: "请先确认工作区信任", trust };
  }
  const mode = normalizePermissionMode(input.permissionMode);
  const currentConfig = await loadConfig({ cwd: context.cwd, env: configEnv });
  const run = async () => {
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
        modelId: context.selectedModelId,
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
    if (state.disposed) {
      return { ok: false, status: 410, code: "SESSION_DISPOSED", error: "会话已被删除" };
    }
    if (state.quarantinedTurnId) {
      return quarantinedSessionResult(state);
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
      applyPermissionMode(state.session, options.mode);
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
    if (options.modelId) {
      applySessionModel(session, options.modelId);
    }
    applyPermissionMode(session, options.mode);
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
}

function applySessionConfig(session, config) {
  const id = String(config.modelAlias ?? session.model ?? "").trim();
  session.model = id;
  session.config = { ...config, modelAlias: id };
  refreshSessionContextWindow(session);
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
  if (currentModel && listConfiguredModels(config).some((model) => model.id === currentModel)) {
    return { ...config, modelAlias: currentModel };
  }
  return config;
}

function activeStateForSession(active, sessionId) {
  const id = String(sessionId ?? "").trim();
  return id ? active.get(id) ?? null : null;
}

function configForStatusLists(sessionConfig, refreshedConfig) {
  return {
    ...refreshedConfig,
    modelAlias: sessionConfig.modelAlias ?? refreshedConfig.modelAlias
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

function modelOptions(config) {
  const current = String(config.modelAlias ?? "").trim();
  const defaultModel = String(config.defaultModelAlias ?? config.modelAlias ?? "").trim();
  const sources = config.configSources ?? {};
  return listConfiguredModels(config).map((model) => publicModelOption(model, current, defaultModel, sources));
}

function publicModelOption(model, currentModelId = "", defaultModelId = "", sources = {}) {
  return {
    id: model.id,
    label: model.label,
    description: model.description,
    thinking: model.thinking === true,
    modalities: Array.isArray(model.modalities) && model.modalities.length > 0 ? model.modalities : ["text"],
    contextTokens: Number.isFinite(model.contextTokens) ? model.contextTokens : null,
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
    gatewayUrl: config.lab?.gatewayUrl ?? "",
    gatewayHealthUrl: config.lab?.gatewayHealthUrl ?? "",
    gatewayProtocol: config.lab?.gatewayProtocol ?? "lab-agent-gateway",
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

function publicGatewayProfiles(config) {
  const active = activeGatewayProfileId(config);
  return gatewayProfilesFromConfig(config).map((profile) => ({
    id: profile.id,
    label: profile.label || profile.id,
    gatewayUrl: profile.gatewayUrl || "",
    gatewayProtocol: profile.gatewayProtocol || "lab-agent-gateway",
    apiKeyConfigured: Boolean(profile.gatewayApiKey),
    modelAlias: profile.modelAlias || "",
    modelCount: Array.isArray(profile.models) ? profile.models.length : 0,
    current: profile.id === active
  }));
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

function normalizeModelConfigInput(input, config) {
  const saveTarget = normalizeSaveTarget(input.saveTarget ?? input.scope ?? input.target);
  const gatewayUrl = String(input.gatewayUrl ?? "").trim();
  const parsedGatewayUrl = parseConfigUrl(gatewayUrl);
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
  const modelId = String(input.modelId ?? input.id ?? "").trim();
  if (!modelId || /[\r\n\t]/.test(modelId) || modelId.length > 160) {
    return { ok: false, status: 400, error: "请输入有效的模型 ID" };
  }
  const label = String(input.label ?? "").trim();
  const contextTokens = positiveIntegerOrNull(input.contextTokens);
  const modalities = normalizeModelInputModalities(input);
  const agentModelTiers = normalizeAgentModelTiers({
    cheap: input.agentCheapModel ?? input.agentModelTiers?.cheap,
    default: input.agentDefaultModel ?? input.agentModelTiers?.default,
    strong: input.agentStrongModel ?? input.agentModelTiers?.strong
  });
  const visionAgentModel = String(input.visionAgentModel ?? input.visionModel ?? "").trim();
  return {
    ok: true,
    saveTarget,
    gatewayUrl,
    gatewayHealthUrl,
    gatewayProtocol,
    gatewayApiKey: String(input.gatewayApiKey ?? "").trim(),
    previousModelId: String(input.previousModelId ?? input.originalModelId ?? "").trim(),
    replaceModels: input.replaceModels === true,
    switchToModel: input.switchToModel !== false,
    applyAgentDefaults: input.applyAgentDefaults === true,
    visionAgentModel,
    model: {
      id: modelId,
      label: label || modelId,
      description: String(input.description ?? "Model registered from Dashboard.").trim(),
      thinking: input.thinking === true,
      modalities,
      agentModelTiers,
      ...(contextTokens ? { contextTokens } : {})
    }
  };
}

function normalizeSaveTarget(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (["global", "user", "default", "defaults"].includes(text)) {
    return "global";
  }
  return "project";
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
  return env;
}

function modelConfigTargetPath(cwd, env, saveTarget = "project") {
  return saveTarget === "global" ? globalConfigPath(env) : localProjectConfigPath(cwd);
}

function buildLocalModelConfig(local, config, normalized) {
  const replaceModels = shouldReplaceModelEntries(config, normalized);
  const models = replaceModels ? [modelConfigEntry(normalized.model)] : listConfiguredModels(config).map(modelConfigEntry);
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
  const previousModelWasAlias = String(config.modelAlias ?? local.modelAlias ?? "").trim() === normalized.previousModelId;
  const lab = {
    ...(isPlainObject(local.lab) ? local.lab : {}),
    gatewayUrl: normalized.gatewayUrl,
    gatewayProtocol: normalized.gatewayProtocol
  };
  if (normalized.gatewayHealthUrl) {
    lab.gatewayHealthUrl = normalized.gatewayHealthUrl;
  }
  if (normalized.gatewayApiKey) {
    lab.gatewayApiKey = normalized.gatewayApiKey;
  }
  const allowedHosts = Array.from(new Set([
    ...(Array.isArray(config.allowedHosts) ? config.allowedHosts : []),
    ...(Array.isArray(local.allowedHosts) ? local.allowedHosts : []),
    urlHost(normalized.gatewayUrl),
    urlHost(normalized.gatewayHealthUrl)
  ].filter(Boolean)));
  const next = {
    ...local,
    modelAlias: normalized.switchToModel || previousModelWasAlias
      ? normalized.model.id
      : local.modelAlias ?? config.modelAlias,
    models,
    allowedHosts,
    lab
  };
  applyModelContextBudget(next, local, config, normalized.model.contextTokens);
  if (replacingExistingModel) {
    next.agents = replaceModelInAgentConfig(
      {
        ...(isPlainObject(config.agents) ? config.agents : {}),
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
  if (normalized.applyAgentDefaults && Object.keys(normalized.model.agentModelTiers ?? {}).length > 0) {
    const baseTiers = replaceModels ? {} : {
      ...(config.agents?.modelTiers ?? {}),
      ...(local.agents?.modelTiers ?? {})
    };
    next.agents = {
      ...(isPlainObject(next.agents) ? next.agents : {}),
      modelTiers: {
        ...(next.agents?.modelTiers ?? {}),
        ...baseTiers,
        ...normalized.model.agentModelTiers
      }
    };
  }
  if (normalized.visionAgentModel) {
    const modelTiers = normalizeAgentModelTiers({
      ...(replaceModels ? {} : config.agents?.modelTiers ?? {}),
      ...(replaceModels ? {} : local.agents?.modelTiers ?? {}),
      ...(next.agents?.modelTiers ?? {}),
      vision: normalized.visionAgentModel
    });
    next.agents = {
      ...(isPlainObject(next.agents) ? next.agents : {}),
      modelTiers,
      vision: {
        ...(replaceModels ? {} : isPlainObject(config.agents?.vision) ? config.agents.vision : {}),
        ...(replaceModels ? {} : isPlainObject(local.agents?.vision) ? local.agents.vision : {}),
        enabled: true,
        model: normalized.visionAgentModel,
        autoUseWhenMainModelTextOnly: true
      }
    };
  }
  next.lab.gatewayProfiles = upsertGatewayProfileEntries(local, config, normalized, next);
  next.lab.activeGatewayProfile = gatewayProfileIdFromParts(normalized.gatewayProtocol, normalized.gatewayUrl);
  return next;
}

function applyModelContextBudget(next, local, config, contextTokens) {
  if (!Number.isFinite(contextTokens) || contextTokens <= 0) {
    return;
  }
  const nextContext = {
    ...(isPlainObject(config.context) ? config.context : {}),
    ...(isPlainObject(local.context) ? local.context : {}),
    ...(isPlainObject(next.context) ? next.context : {})
  };
  nextContext.maxTokens = contextTokens;
  nextContext.maxBytes = contextTokens * 4;
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
  const currentUrl = String(config.lab?.gatewayUrl ?? "").trim();
  const currentProtocol = String(config.lab?.gatewayProtocol ?? "lab-agent-gateway").trim();
  if (currentUrl !== normalized.gatewayUrl || currentProtocol !== normalized.gatewayProtocol) {
    return true;
  }
  const nextApiKey = String(normalized.gatewayApiKey ?? "").trim();
  if (!nextApiKey) {
    return false;
  }
  const currentApiKey = String(config.lab?.gatewayApiKey ?? "").trim();
  return !currentApiKey || currentApiKey !== nextApiKey;
}

function buildGatewayProfileSwitchConfig(local, config, profileId) {
  const profiles = gatewayProfilesFromLocalAndConfig(local, config);
  const profile = profiles.find((item) => item.id === profileId);
  if (!profile) {
    return { ok: false, error: "网关配置不存在" };
  }
  const currentProfile = gatewayProfileFromConfig(config, {
    id: activeGatewayProfileId(config) || gatewayProfileIdFromParts(config.lab?.gatewayProtocol, config.lab?.gatewayUrl)
  });
  const updatedProfiles = upsertGatewayProfile(profiles, currentProfile);
  return { ok: true, config: buildConfigForGatewayProfile(local, config, profile, updatedProfiles) };
}

function buildConfigForGatewayProfile(local, config, profile, profiles = []) {
  const activeProfile = normalizeGatewayProfile(profile);
  const lab = {
    ...(isPlainObject(local.lab) ? local.lab : {}),
    gatewayUrl: activeProfile.gatewayUrl || null,
    gatewayHealthUrl: activeProfile.gatewayHealthUrl || null,
    gatewayProtocol: activeProfile.gatewayProtocol,
    activeGatewayProfile: activeProfile.id,
    gatewayProfiles: upsertGatewayProfile(profiles, activeProfile)
  };
  if (activeProfile.gatewayApiKey) {
    lab.gatewayApiKey = activeProfile.gatewayApiKey;
  } else {
    delete lab.gatewayApiKey;
  }
  const next = {
    ...local,
    modelAlias: activeProfile.modelAlias || activeProfile.models[0]?.id || "",
    models: activeProfile.models,
    allowedHosts: Array.from(new Set([
      ...(Array.isArray(local.allowedHosts) ? local.allowedHosts : []),
      ...(Array.isArray(config.allowedHosts) ? config.allowedHosts : []),
      urlHost(activeProfile.gatewayUrl),
      urlHost(activeProfile.gatewayHealthUrl)
    ].filter(Boolean))),
    lab
  };
  if (isPlainObject(activeProfile.agents)) {
    next.agents = clonePlainObject(activeProfile.agents);
  }
  return next;
}

function buildLocalDeleteModelConfig(local, config, modelId) {
  const models = listConfiguredModels(config).map(modelConfigEntry);
  if (!models.some((model) => model.id === modelId)) {
    return { ok: false, status: 404, error: "模型配置不存在" };
  }
  if (models.length <= 1) {
    return {
      ok: true,
      config: buildLocalConfigAfterFinalModelDelete(local, config, modelId),
      clearedGateway: true
    };
  }
  const remainingModels = models.filter((model) => model.id !== modelId);
  const fallbackModel = remainingModels[0]?.id || "";
  const modelAlias = String(config.modelAlias ?? "").trim() === modelId
    ? fallbackModel
    : String(config.modelAlias ?? local.modelAlias ?? fallbackModel).trim() || fallbackModel;
  const agents = removeModelFromAgentConfig(
    {
      ...(isPlainObject(config.agents) ? config.agents : {}),
      ...(isPlainObject(local.agents) ? local.agents : {})
    },
    modelId,
    remainingModels
  );
  const next = {
    ...local,
    modelAlias,
    models: remainingModels,
    agents,
    lab: {
      ...(isPlainObject(local.lab) ? local.lab : {}),
      gatewayUrl: config.lab?.gatewayUrl ?? local.lab?.gatewayUrl ?? null,
      gatewayHealthUrl: config.lab?.gatewayHealthUrl ?? local.lab?.gatewayHealthUrl ?? null,
      gatewayProtocol: config.lab?.gatewayProtocol ?? local.lab?.gatewayProtocol ?? "lab-agent-gateway",
      activeGatewayProfile: activeGatewayProfileId(config)
    }
  };
  if (config.lab?.gatewayApiKey ?? local.lab?.gatewayApiKey) {
    next.lab.gatewayApiKey = config.lab?.gatewayApiKey ?? local.lab?.gatewayApiKey;
  } else {
    delete next.lab.gatewayApiKey;
  }
  next.lab.gatewayProfiles = updateActiveGatewayProfileAfterModelDelete(local, config, {
    modelId,
    modelAlias,
    models: remainingModels,
    agents
  });
  return { ok: true, config: next };
}

function buildLocalConfigAfterFinalModelDelete(local, config, modelId) {
  const activeId = activeGatewayProfileId(config);
  const profiles = gatewayProfilesFromLocalAndConfig(local, config)
    .filter((profile) => profile.id !== activeId);
  const fallbackProfile = profiles.find((profile) => Array.isArray(profile.models) && profile.models.length > 0) ?? null;
  if (fallbackProfile) {
    const next = buildConfigForGatewayProfile(local, config, fallbackProfile, profiles);
    return {
      ...next,
      lab: {
        ...(next.lab ?? {}),
        gatewayProfiles: profiles
      }
    };
  }

  const agents = removeModelFromAgentConfig(
    {
      ...(isPlainObject(config.agents) ? config.agents : {}),
      ...(isPlainObject(local.agents) ? local.agents : {})
    },
    modelId,
    []
  );
  const next = {
    ...local,
    modelAlias: "",
    models: [],
    agents,
    lab: {
      ...(isPlainObject(local.lab) ? local.lab : {}),
      gatewayUrl: null,
      gatewayHealthUrl: null,
      gatewayProtocol: config.lab?.gatewayProtocol ?? local.lab?.gatewayProtocol ?? "lab-agent-gateway",
      activeGatewayProfile: "",
      gatewayProfiles: profiles
    }
  };
  delete next.lab.gatewayApiKey;
  return next;
}

function updateActiveGatewayProfileAfterModelDelete(local, config, replacement) {
  const activeId = activeGatewayProfileId(config);
  const currentProfile = gatewayProfileFromConfig(config, { id: activeId });
  const updatedCurrent = normalizeGatewayProfile({
    ...currentProfile,
    modelAlias: replacement.modelAlias,
    models: replacement.models,
    agents: replacement.agents
  });
  return upsertGatewayProfile(gatewayProfilesFromLocalAndConfig(local, config), updatedCurrent);
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

function upsertGatewayProfileEntries(local, config, normalized, nextConfig) {
  const profiles = gatewayProfilesFromLocalAndConfig(local, config);
  const currentProfile = gatewayProfileFromConfig(config, {
    id: activeGatewayProfileId(config) || gatewayProfileIdFromParts(config.lab?.gatewayProtocol, config.lab?.gatewayUrl)
  });
  const nextProfile = gatewayProfileFromConfig(nextConfig, {
    id: gatewayProfileIdFromParts(normalized.gatewayProtocol, normalized.gatewayUrl)
  });
  return upsertGatewayProfile(upsertGatewayProfile(profiles, currentProfile), nextProfile);
}

function gatewayProfilesFromLocalAndConfig(local, config) {
  const profiles = [
    ...gatewayProfilesFromConfig(config),
    ...gatewayProfilesFromConfig(local)
  ];
  return dedupeGatewayProfiles(profiles);
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
    gatewayProtocol: config?.lab?.gatewayProtocol ?? "lab-agent-gateway",
    gatewayApiKey: config?.lab?.gatewayApiKey ?? "",
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
  const gatewayProtocol = String(value.gatewayProtocol ?? "lab-agent-gateway").trim();
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
  const raw = `${String(protocol ?? "lab-agent-gateway").trim()}|${String(gatewayUrl ?? "").trim()}`;
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
  return String(protocol ?? "lab-agent-gateway");
}

function buildReplacementAgentConfig(local, normalized) {
  const modelTiers = normalizeAgentModelTiers(normalized.model.agentModelTiers);
  for (const tier of ["cheap", "default", "strong"]) {
    if (!modelTiers[tier]) {
      modelTiers[tier] = normalized.model.id;
    }
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
    models[index] = { ...models[index], ...next };
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
    backgroundCount: visibleBackground.length
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

function beginPrompt(state, item, env) {
  if (state.disposed || state.running || state.quarantinedTurnId) {
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
          text: state.finalOutput,
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
      state.running = false;
      state.interrupting = false;
      state.quarantinedTurnId = "";
      if (wasQuarantined) {
        state.status = "interrupted";
      }
      state.currentPrompt = "";
      state.currentAttachmentBytes = 0;
      const next = wasQuarantined || state.disposed ? null : state.queuedPrompts.shift();
      if (next) {
        appendQueueUpdated(state);
        beginPrompt(state, next, env);
      } else if (!state.disposed) {
        appendDashboardEvent(state, {
          type: "run_state",
          id: eventId("run-state"),
          running: false,
          turnId: state.currentTurnId,
          queue: queueSnapshot(state),
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
        if (!next) {
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

function sessionStatusFromMetadata(metadata = {}) {
  return {
    model: metadata.model ?? "",
    context: metadata.context ?? null
  };
}

function sessionStatusSummary(session) {
  return {
    model: session?.model ?? session?.config?.modelAlias ?? "",
    context: summarizeContextWindow(session ?? {})
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
  return state.queuedPrompts.length < MAX_QUEUE;
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
    beginPrompt(state, item, env);
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
      item.title || (item.kind === "guide" ? item.guidance : item.prompt),
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
  return item.prompt;
}

function userMessageEventText(item) {
  return item.kind === "wakeup" ? displayPromptForQueueItem(item) : item.kind === "guide" ? item.guidance : item.prompt;
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
