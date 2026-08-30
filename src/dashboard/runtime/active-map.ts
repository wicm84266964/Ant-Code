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
  ActiveSessionMap,
  DASHBOARD_ACTIVE_SESSION_DEFAULTS
} from "./types.ts";
import type {
  DashboardActiveSessionState
} from "./types.ts";
import {
  buildBackgroundSubagentSnapshot
} from "./background.ts";
import {
  disposeTurnState
} from "./lifecycle.ts";
import {
  withKeyedMutation
} from "./turn-queue.ts";


export async function reclaimActiveSessions(active: ActiveSessionMap, options: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  sessionMutationLocks: Map<string, Promise<unknown>>;
  policy?: { max: number; idleTtlMs: number; sweepIntervalMs: number };
  ttlOnly?: boolean;
  targetSize?: number;
}) {
  const policy = options.policy ?? DASHBOARD_ACTIVE_SESSION_DEFAULTS;
  const candidates = [...active.values()]
    .filter((state: DashboardActiveSessionState) => basicReclaimableState(state, policy, options.ttlOnly === true))
    .sort((left: DashboardActiveSessionState, right: DashboardActiveSessionState) => Number(left.lastAccessedAt ?? 0) - Number(right.lastAccessedAt ?? 0));
  const evicted: string[] = [];
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


export function basicReclaimableState(state: DashboardActiveSessionState, policy: { idleTtlMs?: number }, requireExpired: unknown) {
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
  return !requireExpired || Date.now() - Number(state.lastAccessedAt ?? 0) >= Number(policy.idleTtlMs ?? 0);
}


export async function isSessionStatePersisted(state: DashboardActiveSessionState, env?: NodeJS.ProcessEnv) {
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


/** @param {any} state @param {any} env */
export function scheduleSessionPersistenceCheck(state: DashboardActiveSessionState, env?: NodeJS.ProcessEnv) {
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


export function activeSessionCapacityResult(active: ActiveSessionMap, policy: { max?: number; idleTtlMs?: number; sweepIntervalMs?: number }) {
  return {
    ok: false,
    status: 503,
    code: "ACTIVE_SESSION_CAPACITY_REACHED",
    error: "活动会话已达到上限，且没有可安全回收的空闲会话",
    activeSessions: active.size,
    maxActiveSessions: policy?.max ?? DASHBOARD_ACTIVE_SESSION_DEFAULTS.max
  };
}
