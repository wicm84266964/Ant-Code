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
import { applyModelContextBudget, contextTokensForConfig } from "../../config/context-budget.ts";
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
  ActiveSessionMap
} from "./types.ts";
import type {
  DashboardActiveSessionState,
  DashboardRuntimeSelection,
  DashboardSessionStatusView,
  DashboardV2MutationView,
  PersistDashboardSessionModelConfigResult
} from "./types.ts";
import {
  cancelAllQueuedTurns
} from "./lifecycle.ts";
import {
  activeGatewayProfileId,
  gatewayProfilesFromConfig,
  modelConfigEntry,
  replaceGatewayAgentRoutes
} from "./model-config.ts";
import {
  withKeyedMutation
} from "./turn-queue.ts";
import {
  appendDashboardEvent,
  eventId,
  isPlainObject,
  nonNegativeInteger
} from "./util.ts";


export function applySessionModel(session: AgentSession, modelId: unknown) {
  const id = String(modelId ?? "").trim();
  if (!id) {
    return;
  }
  session.model = id;
  session.config = { ...session.config, modelAlias: id };
  refreshSessionContextWindow(session);
  refreshDashboardSessionModelSelection(session);
}


export function applySessionReasoningEffort(session: AgentSession, reasoningEffort: unknown) {
  const effort = String(reasoningEffort ?? "").trim().toLowerCase();
  const model = listConfiguredModels(session.config).find((item) => item.id === String(session.model ?? "").trim());
  const normalized = resolveReasoningEffortSelection(model, effort, model?.defaultReasoningEffort ?? "");
  session.config = { ...session.config, reasoningEffort: normalized || null };
  refreshDashboardSessionModelSelection(session);
}


export function applySessionConfig(session: AgentSession, config: LabAgentConfig) {
  const id = String(config.modelAlias ?? session.model ?? "").trim();
  session.model = id;
  session.config = { ...config, modelAlias: id };
  session.modelSelectionInvalidation = null;
  session.pendingModelSelectionMutation = null;
  refreshSessionContextWindow(session);
  refreshDashboardSessionModelSelection(session);
}

/** @param {Record<string, any>} session */


/** @param {Record<string, any>} session */
export function refreshDashboardSessionModelSelection(session: AgentSession) {
  session.modelSelection = currentRuntimeModelSelection(session.config, {
    model: session.model,
    reasoningEffort: session.config.reasoningEffort
  });
}


export function refreshSessionContextWindow(session: AgentSession) {
  applyModelContextBudget(session.config, session.config, contextTokensForConfig(session.config));
  const previous = session.contextWindow;
  const next = createContextWindow(session.config);
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


export function configForExistingSession(session: AgentSession, config: LabAgentConfig) {
  const currentModel = String(session.model ?? "").trim();
  if (isConfigV2Enabled(config)) {
    const currentSelection = currentRuntimeModelSelection(session.config, {
      model: currentModel,
      reasoningEffort: session.config?.reasoningEffort
    }) ?? session.modelSelection ?? null;
    const resolution = resolveSessionModelSelection(config, currentSelection
      ? { model: currentModel, modelSelection: currentSelection }
      : { model: currentModel });
    if (resolution.status !== "resolved" || !resolution.selection) {
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
    const sessionDefinesEffort = Object.prototype.hasOwnProperty.call(session.config, "reasoningEffort")
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


export function activeStateForSession(active: ActiveSessionMap, sessionId: string) {
  const id = String(sessionId ?? "").trim();
  return id ? active.get(id) ?? null : null;
}


export function configForStatusLists(sessionConfig: LabAgentConfig | null | undefined, refreshedConfig: LabAgentConfig): LabAgentConfig {
  if (!sessionConfig) {
    return refreshedConfig;
  }
  const sessionDefinesEffort = Object.prototype.hasOwnProperty.call(sessionConfig, "reasoningEffort")
    && sessionConfig.reasoningEffort !== undefined;
  return {
    ...refreshedConfig,
    modelAlias: sessionConfig.modelAlias ?? refreshedConfig.modelAlias,
    reasoningEffort: sessionDefinesEffort
      ? sessionConfig.reasoningEffort
      : refreshedConfig.reasoningEffort ?? null
  };
}


export function sessionStatusForConfigUpdate(session: AgentSession | null | undefined, config: LabAgentConfig): DashboardSessionStatusView {
  if (!session) {
    return sessionStatusFromConfig(config);
  }
  const current = sessionStatusSummary(session);
  const configured = sessionStatusFromConfig(config);
  const currentContext = current.context;
  const configuredContext = configured.context;
  const mergedContext: Record<string, unknown> = { ...(currentContext ?? {}) };
  mergedContext.maxTokens = configuredContext?.maxTokens ?? currentContext?.maxTokens;
  mergedContext.maxBytes = configuredContext?.maxBytes ?? currentContext?.maxBytes;
  mergedContext.modelMaxTokens = configuredContext?.modelMaxTokens ?? currentContext?.modelMaxTokens;
  return {
    ...current,
    model: String(current.model || configured.model || ""),
    context: mergedContext
  };
}


export function syncIdleSessionConfig(active: ActiveSessionMap, sessionId: string, config: LabAgentConfig) {
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


export async function persistDashboardSessionModelConfig(options: {
  active: ActiveSessionMap;
  sessionMutationLocks: Map<string, Promise<unknown>>;
  cwd: string;
  env: NodeJS.ProcessEnv;
  sessionId: string;
  config: LabAgentConfig;
  expectedSelection?: RuntimeModelSelection | Record<string, unknown> | null;
  lockHeld?: boolean;
}): Promise<PersistDashboardSessionModelConfigResult> {
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
    type MetadataCommit =
      | { ok: true; metadata: Record<string, unknown> }
      | {
          ok: false;
          status?: number;
          code?: string;
          sessionId?: string;
          error?: string | { code?: string; message?: string };
        };
    const committed = await store.withSessionMutation(options.sessionId, async () => {
      const current = await store.readMetadataExact(options.sessionId, { lockHeld: true });
      if (!current.ok) return current;
      if (options.expectedSelection && isConfigV2Enabled(options.config)) {
        const resolution = resolveSessionModelSelection(
          options.config,
          isPlainObject(current.metadata) ? current.metadata : {}
        );
        if (
          resolution.status !== "resolved"
          || !sameRuntimeModelSelection(resolution.selection, options.expectedSelection)
        ) {
          return sessionModelSelectionChangedResult(options.sessionId);
        }
      }
      const currentMetadata = isPlainObject(current.metadata) ? current.metadata : {};
      const metadata = isConfigV2Enabled(options.config)
        ? patchSessionModelSelectionMetadata(currentMetadata, {
            provider: String(selection?.provider ?? ""),
            model: String(selection?.model ?? ""),
            ...(selection && "reasoningEffort" in selection && selection.reasoningEffort
              ? { reasoningEffort: selection.reasoningEffort }
              : {})
          })
        : {
            ...currentMetadata,
            model: options.config.modelAlias,
            reasoningEffort: options.config.reasoningEffort ?? null
          };
      await store.writeMetadata(metadata, { lockHeld: true });
      return { ok: true, metadata };
    }) as MetadataCommit;
    if (!committed.ok) {
      if (typeof committed.status === "number") {
        return {
          ok: false,
          status: committed.status,
          code: committed.code,
          error: typeof committed.error === "string" ? committed.error : "模型选择未能安全保存",
          sessionId: committed.sessionId
        };
      }
      const errorRec = committed.error && typeof committed.error === "object" ? committed.error : {};
      return {
        ok: false,
        status: errorRec.code === "SESSION_NOT_FOUND" ? 404 : 500,
        code: errorRec.code ?? "SESSION_MODEL_SELECTION_PERSIST_FAILED",
        error: errorRec.message ?? "模型选择未能安全保存"
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


/** @param {Record<string, any> | null | undefined} left @param {Record<string, any> | null | undefined} right */
export function sameRuntimeModelSelection(
  left: { provider?: unknown; model?: unknown; reasoningEffort?: unknown } | null | undefined,
  right: { provider?: unknown; model?: unknown; reasoningEffort?: unknown } | null | undefined
) {
  if (!left || !right) return false;
  return String(left.provider ?? "") === String(right.provider ?? "")
    && String(left.model ?? "") === String(right.model ?? "")
    && String(left.reasoningEffort ?? "") === String(right.reasoningEffort ?? "");
}

/** @param {string} sessionId */


/** @param {string} sessionId */
export function sessionModelSelectionChangedResult(sessionId: string) {
  return {
    ok: false,
    status: 409,
    code: "SESSION_MODEL_SELECTION_CHANGED",
    error: "模型选择已经变化，请刷新后重试",
    sessionId
  };
}

/** @param {Record<string, any>} resolution @param {string} [sessionId] */


/** @param {Record<string, any>} resolution @param {string} [sessionId] */
export function unresolvedSessionModelSelectionResult(
  resolution: Record<string, unknown> | SessionModelSelectionUnresolvedError | SessionModelSelectionResolution,
  sessionId: string = ""
) {
  return {
    ok: false,
    status: 409,
    code: "SESSION_MODEL_SELECTION_UNRESOLVED",
    error: "当前会话的模型来源无法确定，请重新选择模型来源和模型",
    sessionId,
    reason: "reason" in resolution ? resolution.reason ?? "legacy-no-match" : "legacy-no-match",
    model: String(
      ("model" in resolution ? resolution.model : "")
      || (isPlainObject((resolution as { selection?: unknown }).selection)
        ? (resolution as { selection?: { model?: unknown } }).selection?.model
        : "")
      || ""
    ),
    candidates: Array.isArray((resolution as { candidates?: unknown }).candidates)
      ? (resolution as { candidates: unknown[] }).candidates.slice()
      : []
  };
}

/** @param {{ cwd: string; env: NodeJS.ProcessEnv; config: Record<string, any>; sessionId: string }} options */


/** @param {{ cwd: string; env: NodeJS.ProcessEnv; config: Record<string, any>; sessionId: string }} options */
export async function readDashboardSessionMetadataExact(options: { cwd: string; env: NodeJS.ProcessEnv; config: LabAgentConfig; sessionId: string }): Promise<
  | { ok: true; path: string; encrypted: boolean; metadata: Record<string, unknown> }
  | { ok: false; status: number; code: string; error: string }
> {
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


/**
 * Refresh an idle session after a settings mutation. If its exact selection
 * was removed, keep that identity visible but detach all gateway credentials
 * so the next turn is blocked until the user explicitly repairs it.
 *
 * @param {{ active: Map<string, Record<string, any>>; cwd: string; env: NodeJS.ProcessEnv; sessionId: string; config: Record<string, any> }} options
 */
export async function refreshDashboardSessionAfterV2Mutation(options: { active: ActiveSessionMap; cwd: string; env: NodeJS.ProcessEnv; sessionId: string; config: LabAgentConfig }) {
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


export function dashboardSessionV2MutationView(session: AgentSession, config: LabAgentConfig): DashboardV2MutationView {
  const previousSelection = currentRuntimeModelSelection(session.config, {
    model: session.model,
    reasoningEffort: session.config.reasoningEffort
  }) ?? session.modelSelection ?? null;
  const resolution = resolveSessionModelSelection(config, previousSelection
    ? { model: session.model, modelSelection: previousSelection }
    : { model: session.model });
  const nextConfig = resolution.status === "resolved" && resolution.selection
    ? configForDashboardSelection(config, {
        providerId: resolution.selection.provider,
        modelId: resolution.selection.model,
        reasoningEffort: resolution.selection.reasoningEffort ?? null
      })
    : configForUnresolvedSessionSelection(config, previousSelection && typeof previousSelection === "object"
      ? previousSelection
      : null, session);
  return { previousSelection, resolution, config: nextConfig };
}

/** @param {Record<string, any>} state @param {Record<string, any>} view */


/** @param {Record<string, any>} state @param {Record<string, any>} view */
export function applyDashboardSessionV2MutationView(state: DashboardActiveSessionState, view: DashboardV2MutationView) {
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


/**
 * Publish a V2 mutation to every in-memory session synchronously. Running
 * turns retain their current gateway until they settle, but their queued work
 * is cancelled and all later admission is blocked by the invalidation marker.
 *
 * @param {Map<string, Record<string, any>>} active
 * @param {Record<string, any>} config
 */
export function reconcileActiveDashboardSessionsAfterV2Mutation(active: ActiveSessionMap, config: LabAgentConfig) {
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


/** @param {Record<string, any>} state @param {Record<string, any>} view */
export function invalidateRunningDashboardSessionSelection(state: DashboardActiveSessionState, view: Record<string, unknown>) {
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


/** @param {Record<string, any>} config @param {Record<string, any> | null} selection @param {Record<string, any>} session */
export function configForUnresolvedSessionSelection(config: LabAgentConfig, selection: { provider?: string; model?: string; reasoningEffort?: string } | null, session: { model?: string; config?: LabAgentConfig }) {
  const providerId = String(selection?.provider ?? session?.config?.lab?.activeGatewayProfile ?? "").trim();
  const modelId = String(selection?.model ?? session?.model ?? "").trim();
  const reasoningEffort = String(selection?.reasoningEffort ?? session?.config?.reasoningEffort ?? "").trim().toLowerCase();
  return {
    ...config,
    modelAlias: modelId,
    reasoningEffort: reasoningEffort || null,
    lab: {
      ...config.lab,
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


/**
 * @param {Record<string, any>} config
 * @param {unknown} modelId
 * @param {unknown} reasoningEffort
 * @param {{ explicitReasoningEffort?: boolean }} [options]
 */
export function configWithModelSelection(config: LabAgentConfig, modelId: unknown = "", reasoningEffort: unknown = undefined, options: { explicitReasoningEffort?: boolean } = {}): LabAgentConfig {
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
  const next = {
    ...config,
    modelAlias: selectedModel,
    reasoningEffort: effort || null
  };
  applyModelContextBudget(next, config, model?.contextTokens);
  return next;
}

/** @param {Record<string, any>} config @param {Record<string, any> | null | undefined} selection */


/** @param {Record<string, any>} config @param {Record<string, any> | null | undefined} selection */
export function configForDashboardSelection(config: LabAgentConfig, selection: DashboardRuntimeSelection | Record<string, unknown> | null | undefined) {
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


/** @param {Record<string, any>} config */
export function isConfigV2Enabled(config: { configV2?: { enabled?: boolean } } | null | undefined) {
  return config?.configV2?.enabled === true;
}

/** @param {Record<string, any>} config @param {unknown} profileId */


/** @param {Record<string, any>} config @param {unknown} profileId */
export function configForGatewayProfileSelection(config: LabAgentConfig, profileId: unknown): LabAgentConfig {
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
    if (applied.status === "resolved" && "config" in applied && isPlainObject(applied.config)) {
      return applied.config as LabAgentConfig;
    }
    return config;
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
      ...config.lab,
      activeGatewayProfile: id,
      gatewayUrl: profile.gatewayUrl,
      gatewayHealthUrl: profile.gatewayHealthUrl,
      gatewayProtocol: profile.gatewayProtocol,
      gatewayApiKey: profile.gatewayApiKey,
      gatewayApiKeyDisabled: profile.gatewayApiKeyDisabled === true
    }
  } as LabAgentConfig;
}

/** @param {Map<string, Record<string, any>>} selections @param {unknown} clientId @param {Record<string, any>} fallback */


/** @param {Map<string, Record<string, any>>} selections @param {unknown} clientId @param {Record<string, any>} fallback */
export function dashboardRuntimeSelection(selections: Map<string, DashboardRuntimeSelection>, clientId: unknown, fallback: DashboardRuntimeSelection): DashboardRuntimeSelection {
  const id = normalizeDashboardClientId(clientId);
  if (!id) return { ...fallback };
  const selected = selections.get(id);
  return selected ? { ...selected } : { providerId: "", modelId: "", reasoningEffort: "" };
}

/** @param {Map<string, Record<string, any>>} selections @param {unknown} clientId @param {Record<string, any>} selection */


/** @param {Map<string, Record<string, any>>} selections @param {unknown} clientId @param {Record<string, any>} selection */
export function rememberDashboardRuntimeSelection(selections: Map<string, DashboardRuntimeSelection>, clientId: unknown, selection: DashboardRuntimeSelection | Record<string, unknown>) {
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


/**
 * Remove ephemeral tab selections that no longer resolve after a provider or
 * model deletion, and return a valid process fallback for clients without ids.
 *
 * @param {Map<string, Record<string, any>>} selections
 * @param {Record<string, any>} config
 * @param {Record<string, any>} fallback
 */
export function reconcileDashboardRuntimeSelections(selections: Map<string, DashboardRuntimeSelection>, config: LabAgentConfig, fallback: DashboardRuntimeSelection): DashboardRuntimeSelection {
  for (const [clientId, selection] of selections) {
    if (!dashboardSelectionResolution(config, selection)) {
      selections.delete(clientId);
    }
  }
  const resolvedFallback = dashboardSelectionResolution(config, fallback);
  if (resolvedFallback) {
    return {
      providerId: String(resolvedFallback.provider ?? ""),
      modelId: String(resolvedFallback.model ?? ""),
      reasoningEffort: String(resolvedFallback.reasoningEffort ?? "")
    };
  }
  const selection = currentRuntimeModelSelection(config, {
    model: config.modelAlias,
    reasoningEffort: config.reasoningEffort
  });
  return {
    providerId: String(selection?.provider ?? ""),
    modelId: String(selection?.model ?? config.modelAlias ?? "").trim(),
    reasoningEffort: String(selection?.reasoningEffort ?? config.reasoningEffort ?? "").trim()
  };
}

/** @param {Record<string, any>} config @param {Record<string, any>} selection */


/** @param {Record<string, any>} config @param {Record<string, any>} selection */
export function dashboardSelectionResolution(config: LabAgentConfig | Record<string, unknown>, selection: DashboardRuntimeSelection | Record<string, unknown>) {
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


/** @param {unknown} value */
export function normalizeDashboardClientId(value: unknown) {
  const id = String(value ?? "").trim();
  return id && id.length <= 160 && !/[\u0000-\u001f\u007f]/.test(id) ? id : "";
}

/** @param {Record<string, any>} config @param {unknown} modelId */


/** @param {Record<string, any>} config @param {unknown} modelId */
export function defaultReasoningEffortForConfig(config: Record<string, unknown>, modelId: unknown = "") {
  const selectedModel = String(modelId ?? config.modelAlias ?? "").trim();
  const model = listConfiguredModels(config).find((item) => item.id === selectedModel);
  return resolveReasoningEffortSelection(model, undefined, model?.defaultReasoningEffort);
}

/** @param {Record<string, any> | null | undefined} model @param {unknown} requested @param {unknown} fallback */


/** @param {Record<string, any> | null | undefined} model @param {unknown} requested @param {unknown} fallback */
export function resolveReasoningEffortSelection(model: { reasoningEfforts?: unknown; defaultReasoningEffort?: unknown; id?: string } | null | undefined, requested: unknown, fallback: unknown = undefined) {
  const efforts = normalizeReasoningEfforts(model?.reasoningEfforts);
  if (efforts.length === 0) return "";
  if (requested !== undefined) {
    const requestedId = String(requested ?? "").trim().toLowerCase();
    return efforts.some((effort: { id?: string }) => effort.id === requestedId) ? requestedId : "";
  }
  const fallbackId = String(fallback ?? "").trim().toLowerCase();
  return efforts.some((effort: { id?: string; default?: boolean }) => effort.id === fallbackId) ? fallbackId : "";
}


export function sessionStatusFromConfig(config: LabAgentConfig): DashboardSessionStatusView {
  const pseudoSession = {
    config,
    model: config.modelAlias,
    messages: [],
    contextWindow: null,
    usage: null
  };
  return sessionStatusSummary(pseudoSession);
}


export function sessionStatusFromMetadata(metadata: Record<string, unknown> = {}, config: LabAgentConfig | Record<string, unknown> = {}): DashboardSessionStatusView {
  const status: DashboardSessionStatusView = {
    model: String(metadata.model ?? ""),
    reasoningEffort: metadata.reasoningEffort == null ? null : String(metadata.reasoningEffort),
    context: (metadata.context ?? null) as DashboardSessionStatusView["context"]
  };
  if (!isConfigV2Enabled(config)) {
    return status;
  }
  return sessionStatusWithSelectionResolution(
    status,
    resolveSessionModelSelection(config, metadata)
  );
}


export function sessionStatusSummary(session: AgentSession | {
  model?: unknown;
  config?: LabAgentConfig;
  messages?: unknown[];
  contextWindow?: ReturnType<typeof createContextWindow> | null;
  usage?: unknown;
  lastPromptEstimate?: unknown;
  modelSelectionInvalidation?: { status?: string; [key: string]: unknown } | null;
  modelSelection?: unknown;
}): DashboardSessionStatusView {
  const status: DashboardSessionStatusView = {
    model: String(session?.model ?? session?.config?.modelAlias ?? ""),
    reasoningEffort: session?.config?.reasoningEffort ?? null,
    context: summarizeContextWindow({
      config: session.config,
      messages: session.messages,
      contextWindow: session.contextWindow ?? undefined,
      usage: session.usage,
      lastPromptEstimate: "lastPromptEstimate" in session ? session.lastPromptEstimate : undefined
    })
  };
  const config = session.config;
  if (!config || !isConfigV2Enabled(config)) {
    return status;
  }
  const invalidation = isPlainObject(session.modelSelectionInvalidation) ? session.modelSelectionInvalidation : null;
  if (invalidation?.status === "unresolved") {
    return sessionStatusWithSelectionResolution(status, invalidation);
  }
  const selection = currentRuntimeModelSelection(config, {
    model: status.model,
    reasoningEffort: status.reasoningEffort
  });
  if (selection) {
    return {
      ...status,
      providerId: String(selection.provider ?? ""),
      model: String(selection.model ?? status.model),
      reasoningEffort: selection.reasoningEffort == null ? null : String(selection.reasoningEffort),
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


export function sessionStatusWithSelectionResolution(
  status: DashboardSessionStatusView,
  resolution: SessionModelSelectionResolution | { status?: string; selection?: { provider?: string; model?: string; reasoningEffort?: string | null } | null; model?: string; code?: string; reason?: string; candidates?: unknown }
): DashboardSessionStatusView {
  const rec = resolution as {
    status?: string;
    selection?: { provider?: unknown; model?: unknown; reasoningEffort?: unknown } | null;
    model?: unknown;
    code?: unknown;
    reason?: unknown;
    candidates?: unknown;
  };
  const selection = rec.selection;
  if (rec.status === "resolved") {
    return {
      ...status,
      providerId: selection?.provider == null ? undefined : String(selection.provider),
      model: String(selection?.model ?? status.model ?? ""),
      reasoningEffort: selection?.reasoningEffort == null ? null : String(selection.reasoningEffort),
      selectionResolved: true,
      selectionIssue: null
    };
  }
  return {
    ...status,
    providerId: selection?.provider == null ? "" : String(selection.provider),
    model: String(rec.model || selection?.model || status.model || ""),
    selectionResolved: false,
    selectionIssue: {
      code: rec.code ?? "SESSION_MODEL_SELECTION_UNRESOLVED",
      reason: rec.reason ?? "legacy-no-match",
      model: String(rec.model || selection?.model || status.model || ""),
      candidates: Array.isArray(rec.candidates) ? rec.candidates.slice() : []
    }
  };
}


export function emptyChangeStats() {
  return {
    additions: 0,
    deletions: 0,
    files: 0,
    redacted: false,
    truncated: false,
    approximate: false
  };
}


export function accumulateTurnChangeStats(state: DashboardActiveSessionState, stats: unknown) {
  if (!isPlainObject(stats)) {
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


export function normalizeChangeStats(stats: { additions?: unknown; deletions?: unknown; files?: unknown; redacted?: unknown; truncated?: unknown; approximate?: unknown } | null | undefined) {
  return {
    additions: nonNegativeInteger(stats?.additions),
    deletions: nonNegativeInteger(stats?.deletions),
    files: nonNegativeInteger(stats?.files),
    redacted: stats?.redacted === true,
    truncated: stats?.truncated === true,
    approximate: stats?.approximate === true
  };
}
