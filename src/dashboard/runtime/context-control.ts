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
  ActiveSessionCapacityError
} from "./types.ts";
import type {
  DashboardActiveSessionState,
  DashboardContextSnapshot,
  DashboardRequestInput,
  DashboardRuntimeContext
} from "./types.ts";
import {
  activeSessionCapacityResult
} from "./active-map.ts";
import {
  sessionStatusSummary
} from "./session-model.ts";
import {
  resolveDashboardTrust
} from "./trust.ts";
import {
  ensureTurnState,
  normalizeMutationSessionId,
  requireExactSessionId,
  withKeyedMutation
} from "./turn-queue.ts";
import {
  appendDashboardEvent,
  eventId
} from "./util.ts";


export async function mutateDashboardContext(
  context: DashboardRuntimeContext,
  input: DashboardRequestInput,
  operation: string
) {
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
    let state: DashboardActiveSessionState;
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


export function captureDashboardContextState(session: AgentSession): DashboardContextSnapshot {
  return {
    messages: cloneDashboardStateValue(session.messages),
    contextWindow: cloneDashboardStateValue(session.contextWindow),
    transcriptArchive: cloneDashboardStateValue(session.transcriptArchive),
    modelContextArchive: cloneDashboardStateValue(session.modelContextArchive)
  };
}


export async function persistDashboardContextMutation(state: DashboardActiveSessionState, env: NodeJS.ProcessEnv | undefined, snapshot: DashboardContextSnapshot) {
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


export function cloneDashboardStateValue<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}
