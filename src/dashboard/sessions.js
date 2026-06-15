import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createSession, runSessionTurn } from "../core/session.js";
import { clearSessionContext, compactSessionContextWithModel, summarizeContextWindow } from "../core/context-window.js";
import { createLabModelGateway } from "../model-gateway/client.js";
import { listConfiguredModels, normalizeAgentModelTiers, resolveModelSelection } from "../model-gateway/models.js";
import { resolveWorkspaceTrust, trustWorkspace as saveWorkspaceTrust } from "../permissions/workspace-trust.js";
import { createSessionStore } from "../storage/session-store.js";
import { GATEWAY_PROTOCOLS, loadConfig, localProjectConfigPath } from "../config/load-config.js";
import { cancelBackgroundAgentTasks } from "../agents/background-registry.js";
import { createAgentTaskStore } from "../agents/task-store.js";
import { createAgentTaskGroupStore, summarizeGroupStatus } from "../agents/task-group-store.js";
import { cloneWorkflowState } from "../tools/workflow-tools.js";
import { mapSessionEventToDashboard, permissionRequestToActivity } from "./events.js";
import { applyPermissionMode, approvalKeyFor, buildApprovalPreview, normalizePermissionMode, permissionModeSummary } from "./permissions.js";
import { collectSessionFiles } from "./files.js";
import { getAntCodeVersion } from "../version.js";

const MAX_EVENTS = 500;
const MAX_QUEUE = 20;
const DEFAULT_TRANSCRIPT_PAGE_LIMIT = 100;
const MAX_TRANSCRIPT_PAGE_LIMIT = 200;
const BACKGROUND_SNAPSHOT_INTERVAL_MS = 15_000;
const BACKGROUND_STALE_PROGRESS_MS = 10 * 60 * 1000;
const BACKGROUND_DEAD_HEARTBEAT_MS = 5 * 60 * 1000;
const VISIBLE_TRANSCRIPT_ROLES = new Set(["user", "assistant"]);
const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "partial", "blocked", "cancelled", "interrupted"]);
const TERMINAL_GROUP_STATUSES = new Set(["completed", "failed", "partial", "blocked", "cancelled", "interrupted"]);

/**
 * @param {{ cwd: string; env?: NodeJS.ProcessEnv }} options
 */
export function createDashboardRuntime(options) {
  const active = new Map();
  let processTrusted = false;
  let selectedModelId = "";
  const runtimeEnv = options.env ?? process.env;
  const resolveConfigEnv = () => dashboardConfigEnv(options.cwd, runtimeEnv);

  return {
    cwd: options.cwd,
    env: runtimeEnv,
    active,
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
      selectedModelId = selection.model.id;
      let refreshed = config;
      if (input.applyAgentDefaults === true && Object.keys(selection.model.agentModelTiers ?? {}).length > 0) {
        const localPath = localProjectConfigPath(options.cwd);
        const local = await readJsonConfig(localPath);
        await writeJsonConfig(localPath, buildLocalAgentModelTiersConfig(local, config, selection.model.agentModelTiers));
        refreshed = await loadConfig({ cwd: options.cwd, env: await resolveConfigEnv() });
      }
      if (state) {
        applySessionModel(state.session, selection.model.id);
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
      const config = await loadConfig({ cwd: options.cwd, env: configEnv });
      const normalized = normalizeModelConfigInput(input, config);
      if (!normalized.ok) {
        return normalized;
      }
      const localPath = localProjectConfigPath(options.cwd);
      const local = await readJsonConfig(localPath);
      const nextLocal = buildLocalModelConfig(local, config, normalized);
      await writeJsonConfig(localPath, nextLocal);

      const refreshed = await loadConfig({ cwd: options.cwd, env: await resolveConfigEnv() });
      if (normalized.switchToModel) {
        selectedModelId = normalized.model.id;
      } else if (shouldReplaceModelEntries(config, normalized) && !listConfiguredModels(refreshed).some((model) => model.id === selectedModelId)) {
        selectedModelId = String(refreshed.modelAlias ?? "").trim();
      }
      const modelConfig = selectedModelId ? { ...refreshed, modelAlias: selectedModelId } : refreshed;
      const syncedState = syncIdleSessionConfig(active, input.sessionId, modelConfig);
      const activeConfig = syncedState?.session.config ?? modelConfig;
      return {
        ok: true,
        configPath: localPath,
        sessionId: syncedState?.session.id,
        sessionStatus: syncedState ? sessionStatusSummary(syncedState.session) : sessionStatusFromConfig(modelConfig),
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
      const local = await readJsonConfig(localPath);
      const nextLocal = buildLocalDeleteModelConfig(local, config, modelId);
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
      await writeJsonConfig(localPath, nextLocal.config);
      const refreshed = await loadConfig({ cwd: options.cwd, env: await resolveConfigEnv() });
      if (selectedModelId === modelId || !listConfiguredModels(refreshed).some((model) => model.id === selectedModelId)) {
        selectedModelId = String(refreshed.modelAlias ?? "").trim();
      }
      if (state) {
        applySessionConfig(state.session, refreshed);
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
      const local = await readJsonConfig(localPath);
      const nextLocal = buildGatewayProfileSwitchConfig(local, config, profileId);
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
      await writeJsonConfig(localPath, nextLocal.config);
      const refreshed = await loadConfig({ cwd: options.cwd, env: await resolveConfigEnv() });
      selectedModelId = String(refreshed.modelAlias ?? "").trim();
      if (state) {
        applySessionConfig(state.session, refreshed);
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
      for (const state of active.values()) {
        const activeRecord = activeSessionRecord(state, byId.get(state.session.id));
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
      const storedTranscript = result.ok ? await readStoredTranscriptMessages(store, metadata) : [];
      const transcript = activeState
        ? mergeTranscriptMessages(storedTranscript, stableActiveTranscriptMessages(activeState))
        : storedTranscript;
      const transcriptPage = createTranscriptPage(transcript);
      const finalText = activeState?.finalOutput || assistantTranscriptText(transcript);
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
          transcript: transcriptPage.messages,
          transcriptPage: transcriptPage.summary,
          files: collectSessionFiles({
            cwd: session.cwd ?? metadata.cwd ?? options.cwd,
            workflow: session.workflow ?? metadata.workflow ?? null
          }, finalText),
          workflow: session.workflow ?? metadata.workflow ?? null,
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
      const storedTranscript = result.ok ? await readStoredTranscriptMessages(store, metadata) : [];
      const transcript = activeState
        ? mergeTranscriptMessages(storedTranscript, stableActiveTranscriptMessages(activeState))
        : storedTranscript;
      const page = createTranscriptPage(transcript, {
        before: input.before,
        limit: input.limit
      });
      return {
        ok: true,
        sessionId: activeState?.session.id ?? metadata.id ?? sessionId,
        transcript: page.messages,
        transcriptPage: page.summary
      };
    },
    async deleteSession(input = {}) {
      const configEnv = await resolveConfigEnv();
      const sessionId = String(input.sessionId ?? input.id ?? "").trim();
      if (!sessionId) {
        return { ok: false, status: 400, error: "请选择要删除的会话" };
      }
      const activeState = active.get(sessionId);
      if (activeState?.running) {
        return { ok: false, status: 409, error: "会话正在运行，结束或中断后再删除" };
      }
      if (activeState) {
        stopBackgroundSnapshotPolling(activeState);
        active.delete(sessionId);
      }
      const config = await loadConfig({ cwd: options.cwd, env: configEnv });
      const store = createSessionStore({ cwd: options.cwd, transcript: config.transcript, env: runtimeEnv });
      const result = await store.deleteSession(sessionId);
      if (!result.ok && activeState) {
        return { ok: true, sessionId, activeDeleted: true, persistedDeleted: false };
      }
      if (!result.ok) {
        return { ok: false, status: 404, error: result.error?.message ?? "会话不存在" };
      }
      return { ok: true, sessionId: result.id, deleted: result.deleted, activeDeleted: Boolean(activeState), persistedDeleted: true };
    },
    async startTurn(input) {
      const configEnv = await resolveConfigEnv();
      const prompt = String(input.prompt ?? "").trim();
      const attachments = normalizeTurnAttachments(input.attachments);
      if (!prompt && attachments.length === 0) {
        return { ok: false, status: 400, error: "请输入任务需求" };
      }
      const trust = await resolveDashboardTrust({ cwd: options.cwd, env: configEnv, processTrusted });
      if (!trust.trusted) {
        return { ok: false, status: 403, error: "请先确认工作区信任", trust };
      }
      const mode = normalizePermissionMode(input.permissionMode);
      const currentConfig = await loadConfig({ cwd: options.cwd, env: configEnv });
      const state = await ensureTurnState(active, {
        cwd: options.cwd,
        env: configEnv,
        sessionId: input.sessionId,
        mode,
        modelId: selectedModelId,
        config: currentConfig
      });
      state.hooksTrusted = trust.trusted;
      const eventCursor = state.eventSequence;

      if (state.running) {
        const item = enqueuePrompt(state, prompt, mode, "prompt", attachments);
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

      beginPrompt(state, createQueueItem(prompt, mode, "prompt", "", attachments), configEnv);
      return {
        ok: true,
        sessionId: state.session.id,
        eventCursor,
        permission: permissionModeSummary(state.session),
        sessionStatus: sessionStatusSummary(state.session)
      };
    },
    interruptTurn(sessionId, reason = "user") {
      const state = active.get(sessionId);
      if (!state) {
        return { ok: false, status: 404, error: "会话不存在" };
      }
      if (!state.running) {
        return { ok: false, status: 409, error: "当前没有正在运行的任务" };
      }
      requestTurnInterrupt(state, reason);
      return { ok: true, sessionId: state.session.id, queue: queueSnapshot(state), sessionStatus: sessionStatusSummary(state.session) };
    },
    cancelQueuedTurn(input = {}) {
      const state = active.get(input.sessionId);
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
      const targetTaskIds = groupResult?.ok
        ? (taskId ? groupResult.group.taskIds.filter((id) => id === taskId) : groupResult.group.taskIds)
        : [taskId];
      if (targetTaskIds.length === 0) {
        return { ok: false, status: 404, error: "子智能体任务不存在或不属于该任务组" };
      }
      const aborted = cancelBackgroundAgentTasks({
        parentSessionId: state.session.id,
        groupId: groupId || null,
        taskId: taskId || null
      });
      const now = new Date().toISOString();
      const updatedTasks = [];
      for (const id of targetTaskIds) {
        const read = await taskStore.readTask(id);
        if (!read.ok || TERMINAL_TASK_STATUSES.has(String(read.task.status))) {
          continue;
        }
        const abortedInProcess = aborted.some((task) => task.taskId === id);
        const updated = await taskStore.updateTask(id, {
          status: "interrupted",
          cancelRequestedAt: now,
          finishedAt: now,
          heartbeatAt: now,
          progressAt: now,
          latestProgress: abortedInProcess
            ? "Dashboard 已请求回收后台子智能体；当前进程 controller 已中止。"
            : "Dashboard 已标记后台子智能体为已回收；未找到当前进程 controller。"
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
        abortedTaskIds: aborted.map((task) => task.taskId),
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
        abortedTaskIds: aborted.map((task) => task.taskId),
        updatedTaskIds: updatedTasks.map((task) => task.id),
        sessionStatus: sessionStatusSummary(state.session)
      };
    },
    guideTurn(input) {
      const state = active.get(input.sessionId);
      if (!state) {
        return { ok: false, status: 404, error: "会话不存在" };
      }
      if (!state.running) {
        return { ok: false, status: 409, error: "当前没有正在运行的任务" };
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
      state.queuedPrompts = state.queuedPrompts.slice(0, MAX_QUEUE);
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
      const configEnv = await resolveConfigEnv();
      const trust = await resolveDashboardTrust({ cwd: options.cwd, env: configEnv, processTrusted });
      if (!trust.trusted) {
        return { ok: false, status: 403, error: "请先确认工作区信任", trust };
      }
      if (!input.sessionId) {
        return { ok: false, status: 400, error: "当前没有可清空上下文的会话" };
      }
      const mode = normalizePermissionMode(input.permissionMode);
      const state = await ensureTurnState(active, {
        cwd: options.cwd,
        env: configEnv,
        sessionId: input.sessionId,
        mode
      });
      if (state.running) {
        return { ok: false, status: 409, error: "任务运行中，结束或中断后再清空上下文" };
      }
      const before = summarizeContextWindow(state.session);
      const after = clearSessionContext(state.session);
      appendDashboardEvent(state, {
        type: "context_cleared",
        id: eventId("context-clear"),
        before,
        after,
        sessionStatus: sessionStatusSummary(state.session),
        at: new Date().toISOString()
      });
      return { ok: true, sessionId: state.session.id, before, after, sessionStatus: sessionStatusSummary(state.session) };
    },
    async compactContext(input = {}) {
      const configEnv = await resolveConfigEnv();
      const trust = await resolveDashboardTrust({ cwd: options.cwd, env: configEnv, processTrusted });
      if (!trust.trusted) {
        return { ok: false, status: 403, error: "请先确认工作区信任", trust };
      }
      if (!input.sessionId) {
        return { ok: false, status: 400, error: "当前没有可压缩上下文的会话" };
      }
      const mode = normalizePermissionMode(input.permissionMode);
      const state = await ensureTurnState(active, {
        cwd: options.cwd,
        env: configEnv,
        sessionId: input.sessionId,
        mode
      });
      if (state.running) {
        return { ok: false, status: 409, error: "任务运行中，结束或中断后再压缩上下文" };
      }
      const before = summarizeContextWindow(state.session);
      const result = await compactSessionContextWithModel(state.session, {
        force: true,
        reason: "manual",
        gateway: createLabModelGateway(state.session.config),
        env: configEnv,
        hooksTrusted: trust.trusted
      });
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
    },
    subscribe(sessionId, send, options = {}) {
      const state = active.get(sessionId);
      if (!state) {
        return null;
      }
      state.listeners.add(send);
      const afterSequence = nonNegativeInteger(options.afterSequence);
      for (const event of state.events) {
        if (nonNegativeInteger(event.sequence) > afterSequence) {
          send(event);
        }
      }
      return () => {
        state.listeners.delete(send);
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
        return { ok: true, cwd: activeState.session.cwd };
      }
      const config = await loadConfig({ cwd: options.cwd, env: configEnv });
      const store = createSessionStore({ cwd: options.cwd, transcript: config.transcript, env: runtimeEnv });
      const result = await store.readMetadata(id);
      if (!result.ok) {
        return { ok: false, status: 404, error: "会话不存在" };
      }
      return { ok: true, cwd: result.metadata?.cwd ?? options.cwd };
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
    sessionFiles(sessionId) {
      const state = active.get(sessionId);
      if (!state) {
        return [];
      }
      return collectSessionFiles(state.session, state.finalOutput);
    }
  };
}

async function ensureTurnState(active, options) {
  let state = options.sessionId ? active.get(options.sessionId) : null;
  if (state) {
    if (!state.running && options.config) {
      applySessionConfig(state.session, configForExistingSession(state.session, options.config));
    }
    applyPermissionMode(state.session, options.mode);
    return state;
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
  state = createTurnState(session);
  active.set(session.id, state);
  return state;
}

function applySessionModel(session, modelId) {
  const id = String(modelId ?? "").trim();
  if (!id) {
    return;
  }
  session.model = id;
  session.config = { ...session.config, modelAlias: id };
  const previous = session.contextWindow ?? {};
  session.contextWindow = {
    ...previous,
    modelMaxTokens: modelContextTokens(session.config),
    maxTokens: session.config.context?.maxTokens ?? previous.maxTokens
  };
}

function applySessionConfig(session, config) {
  const id = String(config.modelAlias ?? session.model ?? "").trim();
  session.model = id;
  session.config = { ...config, modelAlias: id };
  const previous = session.contextWindow ?? {};
  session.contextWindow = {
    ...previous,
    modelMaxTokens: modelContextTokens(session.config),
    maxTokens: session.config.context?.maxTokens ?? previous.maxTokens
  };
}

function configForExistingSession(session, config) {
  const currentModel = String(session.model ?? "").trim();
  if (currentModel && listConfiguredModels(config).some((model) => model.id === currentModel)) {
    return { ...config, modelAlias: currentModel };
  }
  return config;
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
  return listConfiguredModels(config).map((model) => publicModelOption(model, current));
}

function publicModelOption(model, currentModelId = "") {
  return {
    id: model.id,
    label: model.label,
    description: model.description,
    thinking: model.thinking === true,
    modalities: Array.isArray(model.modalities) && model.modalities.length > 0 ? model.modalities : ["text"],
    contextTokens: Number.isFinite(model.contextTokens) ? model.contextTokens : null,
    agentModelTiers: normalizeAgentModelTiers(model.agentModelTiers),
    current: model.id === currentModelId
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
    activeProfileId: activeGatewayProfileId(config)
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

function normalizeModelConfigInput(input, config) {
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

async function dashboardConfigEnv(cwd, env) {
  const localPath = localProjectConfigPath(cwd);
  try {
    await fs.access(localPath);
    return withoutGatewayEnvOverrides(env);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return env;
    }
    throw error;
  }
}

function withoutGatewayEnvOverrides(env = {}) {
  const next = { ...env };
  for (const key of [
    "LAB_MODEL_GATEWAY_URL",
    "LAB_MODEL_GATEWAY_HEALTH_URL",
    "LAB_MODEL_GATEWAY_PROTOCOL",
    "LAB_MODEL_GATEWAY_API_KEY",
    "LAB_MODEL_GATEWAY_MAX_RETRIES",
    "LAB_AGENT_MODEL",
    "LAB_AGENT_MODELS"
  ]) {
    delete next[key];
  }
  return next;
}

async function writeJsonConfig(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
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
  if (normalized.gatewayApiKey) {
    return true;
  }
  const currentUrl = String(config.lab?.gatewayUrl ?? "").trim();
  const currentProtocol = String(config.lab?.gatewayProtocol ?? "lab-agent-gateway").trim();
  return currentUrl !== normalized.gatewayUrl || currentProtocol !== normalized.gatewayProtocol;
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

function createTurnState(session) {
  return {
    session,
    status: "idle",
    running: false,
    controller: null,
    currentPrompt: "",
    currentTurnId: "",
    currentTranscriptStart: 0,
    currentPermissionMode: "plan",
    turnChangeStats: emptyChangeStats(),
    queuedPrompts: [],
    events: [],
    eventSequence: 0,
    listeners: new Set(),
    sessionApprovals: new Set(),
    pendingApprovals: new Map(),
    pendingQuestions: new Map(),
    finalOutput: "",
    backgroundSnapshotTimer: null,
    hooksTrusted: false
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

async function readStoredTranscriptMessages(store, metadata) {
  const fallback = Array.isArray(metadata?.transcript?.messages) ? metadata.transcript.messages : [];
  const archive = metadata?.transcript?.archive;
  if (!archive || !Array.isArray(archive.chunks) || archive.chunks.length === 0) {
    return fallback;
  }
  const messages = [];
  for (const chunk of archive.chunks.slice().sort((a, b) => nonNegativeInteger(a?.index) - nonNegativeInteger(b?.index))) {
    const result = await store.readTranscriptChunk(archive, chunk.index);
    if (!result.ok) {
      return fallback;
    }
    messages.push(...(result.messages ?? []));
  }
  return messages.length > 0 ? messages : fallback;
}

function mergeTranscriptMessages(baseMessages, tailMessages) {
  const base = Array.isArray(baseMessages) ? baseMessages : [];
  const tail = Array.isArray(tailMessages) ? tailMessages : [];
  if (base.length === 0) {
    return tail;
  }
  if (tail.length === 0) {
    return base;
  }
  const maxOverlap = Math.min(base.length, tail.length);
  for (let size = maxOverlap; size > 0; size -= 1) {
    if (sameTranscriptSlice(base.slice(base.length - size), tail.slice(0, size))) {
      return base.concat(tail.slice(size));
    }
  }
  return base.concat(tail);
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

function activeSessionRecord(state, persisted = null) {
  const modifiedAt = latestEventTime(state) ?? persisted?.modifiedAt ?? new Date().toISOString();
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
    queueLength: state.queuedPrompts.length
  };
}

function latestEventTime(state) {
  const latest = state.events.at(-1)?.at;
  return typeof latest === "string" ? latest : null;
}

function activeDashboardStatus(state) {
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
  applyPermissionMode(state.session, item.permissionMode);
  state.running = true;
  state.status = "running";
  state.currentPrompt = item.prompt;
  state.currentTurnId = eventId("turn");
  state.currentTranscriptStart = activeTranscriptMessages(state).length;
  state.currentPermissionMode = item.permissionMode;
  state.turnChangeStats = emptyChangeStats();
  state.controller = new AbortController();
  appendDashboardEvent(state, {
    type: "run_state",
    id: eventId("run-state"),
    running: true,
    turnId: state.currentTurnId,
    queue: queueSnapshot(state),
    current: publicQueueItem(item),
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
}

function runTurnInBackground(state, item, env) {
  const controller = state.controller;
  const eventStartIndex = state.events.length;
  queueMicrotask(async () => {
    try {
      const result = await runSessionTurn(state.session, {
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
          for (const mapped of mapSessionEventToDashboard(event)) {
            mapped.turnId = state.currentTurnId;
            mapped.sessionStatus = sessionStatusSummary(state.session);
            if (mapped.type === "activity" && mapped.changeStats) {
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
            await appendBackgroundSubagentSnapshot(state);
          }
          if (event.type === "tool_finish" && (event.name === "todo_write" || event.name === "plan_update")) {
            appendWorkflowSnapshot(state, event.name);
          }
          if (event.type === "workflow_updated") {
            appendWorkflowSnapshot(state, event.reason ?? "workflow_updated");
          }
          if (event.type === "subagent_group_wakeup") {
            await queueBackgroundWakePrompt(state, event, env);
          }
        }
      });
      state.finalOutput = result.output ?? "";
      const turnEvents = state.events.slice(eventStartIndex);
      if (!result.interrupted && !turnEvents.some((event) => event.type === "assistant_final")) {
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
      state.status = result.interrupted ? "interrupted" : "completed";
    } catch (error) {
      appendDashboardEvent(state, {
        type: "error",
        id: eventId("error"),
        message: error instanceof Error ? error.message : String(error),
        at: new Date().toISOString()
      });
      state.status = "failed";
    } finally {
      if (state.controller === controller) {
        state.controller = null;
      }
      state.running = false;
      await appendBackgroundSubagentSnapshot(state);
      state.currentPrompt = "";
      const next = state.queuedPrompts.shift();
      if (next) {
        appendQueueUpdated(state);
        beginPrompt(state, next, env);
      } else {
        appendDashboardEvent(state, {
          type: "run_state",
          id: eventId("run-state"),
          running: false,
          turnId: state.currentTurnId,
          queue: queueSnapshot(state),
          sessionStatus: sessionStatusSummary(state.session),
          changeStats: { ...state.turnChangeStats },
          at: new Date().toISOString()
        });
        state.currentTurnId = "";
        state.currentTranscriptStart = activeTranscriptMessages(state).length;
      }
    }
  });
}

function requestTurnInterrupt(state, reason) {
  appendDashboardEvent(state, {
    type: "turn_interrupt_requested",
    id: eventId("interrupt"),
    reason,
    queue: queueSnapshot(state),
    at: new Date().toISOString()
  });
  cancelPendingInteractions(state, reason);
  if (state.controller && !state.controller.signal.aborted) {
    state.controller.abort(reason);
  }
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
  const item = createQueueItem(prompt, permissionMode, kind, "", attachments);
  state.queuedPrompts.push(item);
  state.queuedPrompts = state.queuedPrompts.slice(0, MAX_QUEUE);
  return item;
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
  const item = createWakeQueueItem(event, state.currentPermissionMode);
  if (!item) {
    return;
  }
  if (state.running) {
    state.queuedPrompts.push(item);
    state.queuedPrompts = state.queuedPrompts.slice(0, MAX_QUEUE);
    appendDashboardEvent(state, {
      type: "wakeup_queued",
      id: eventId("wakeup"),
      groupId: item.groupId,
      queue: queueSnapshot(state),
      queueLength: state.queuedPrompts.length,
      running: true,
      at: new Date().toISOString()
    });
    await markWakePromptConsumed(state, event);
    await appendBackgroundSubagentSnapshot(state);
  } else {
    appendDashboardEvent(state, {
      type: "wakeup_queued",
      id: eventId("wakeup"),
      groupId: item.groupId,
      queue: queueSnapshot(state),
      queueLength: state.queuedPrompts.length,
      running: false,
      at: new Date().toISOString()
    });
    await markWakePromptConsumed(state, event);
    await appendBackgroundSubagentSnapshot(state);
    beginPrompt(state, item, env);
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
  const snapshot = await buildBackgroundSubagentSnapshot(state);
  if (!snapshot.hasRecords && snapshot.groups.length === 0) {
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

async function buildBackgroundSubagentSnapshot(state) {
  try {
    const groupStore = createAgentTaskGroupStore({ cwd: state.session.cwd });
    const taskStore = createAgentTaskStore({ cwd: state.session.cwd });
    const groups = await groupStore.listGroups({ parentSessionId: state.session.id });
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
    return { hasRecords: groups.length > 0, totalGroups: groups.length, groups: visible };
  } catch {
    return { hasRecords: false, totalGroups: 0, groups: [] };
  }
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
  if (state.backgroundSnapshotTimer) {
    return;
  }
  state.backgroundSnapshotTimer = setInterval(() => {
    void appendBackgroundSubagentSnapshot(state);
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
  state.eventSequence += 1;
  const normalized = {
    at: new Date().toISOString(),
    id: event.id ?? eventId(event.type ?? "event"),
    sequence: state.eventSequence,
    ...event
  };
  if ((normalized.status === "running" || normalized.status === "waiting") && normalized.coalesceKey) {
    const existingIndex = state.events.findIndex((item) =>
      item.type === "activity"
      && item.coalesceKey === normalized.coalesceKey
      && (item.status === "running" || item.status === "waiting")
    );
    if (existingIndex >= 0) {
      state.events[existingIndex] = normalized;
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
  const sanitized = {};
  for (const [key, value] of Object.entries(input)) {
    if (/token|api[_-]?key|secret|password|authorization|credential/i.test(key)) {
      sanitized[key] = "[redacted]";
    } else if (typeof value === "string") {
      sanitized[key] = value.length > 500 ? `${value.slice(0, 497)}...` : value;
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
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
