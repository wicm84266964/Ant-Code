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
  DEFAULT_TRANSCRIPT_PAGE_LIMIT,
  MAX_TRANSCRIPT_PAGE_LIMIT,
  VISIBLE_TRANSCRIPT_ROLES
} from "./types.ts";
import type {
  DashboardActiveSessionState,
  DashboardRequestInput,
  DashboardRuntimeContext,
  TranscriptPageView
} from "./types.ts";
import {
  cancelPendingInteractions,
  requestTurnInterrupt
} from "./approvals.ts";
import {
  cancelSessionBackgroundWork
} from "./background.ts";
import {
  sessionRecordGoalStatus
} from "./goal-runtime.ts";
import {
  cancelAllQueuedTurns,
  dashboardSessionActivity,
  disposeTurnState,
  emptyRuntimeActivity,
  lifecycleWaitMs,
  waitForSessionActivity
} from "./lifecycle.ts";
import {
  normalizeMutationSessionId,
  requireExactSessionId,
  withKeyedMutation
} from "./turn-queue.ts";
import {
  isPlainObject,
  nonNegativeInteger
} from "./util.ts";


export async function deleteDashboardSession(context: DashboardRuntimeContext, input: DashboardRequestInput) {
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


export async function boundedSessionCwd(workspaceCwd: string, candidateCwd: string) {
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


export function isPathInside(root: string, candidate: string) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}


export function createSnapshotReadState(metadata: Record<string, unknown> = {}, cwd: string): { session: { id: string; cwd: string; [key: string]: unknown } } | null {
  const id = String(metadata.id ?? "").trim();
  if (!id) {
    return null;
  }
  const transcript = isPlainObject(metadata.transcript) ? metadata.transcript : {};
  return {
    session: {
      id,
      cwd: String(metadata.cwd ?? cwd),
      model: String(metadata.model ?? ""),
      config: {},
      messages: Array.isArray(transcript.messages) ? transcript.messages : [],
      contextWindow: metadata.context ?? null,
      workflow: metadata.workflow ?? null
    }
  };
}


export function publicBackgroundSnapshot(snapshot: { groups?: unknown[]; totalGroups?: unknown; hasRecords?: unknown } | null | undefined) {
  const groups = Array.isArray(snapshot?.groups) ? snapshot.groups : [];
  return {
    groups,
    totalGroups: snapshot?.totalGroups,
    visibleGroups: groups.length,
    hasRecords: snapshot?.hasRecords === true
  };
}


export function assistantTranscriptText(messages: unknown = []) {
  if (!Array.isArray(messages)) {
    return "";
  }
  return messages
    .filter((message): message is { role?: string; content?: unknown } => Boolean(message) && typeof message === "object" && (message as { role?: string }).role === "assistant")
    .map((message) => messageContentText(message.content))
    .filter(Boolean)
    .join("\n");
}


export function activeTranscriptMessages(state: DashboardActiveSessionState) {
  if (Array.isArray(state.session.transcriptMessages) && state.session.transcriptMessages.length > 0) {
    return state.session.transcriptMessages;
  }
  return Array.isArray(state.session.messages) ? state.session.messages : [];
}


export function stableActiveTranscriptMessages(state: DashboardActiveSessionState) {
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


export async function readStoredTranscriptPage(store: ReturnType<typeof createSessionStore>, metadata: unknown, options: Record<string, unknown> = {}) {
  const record = isPlainObject(metadata) ? metadata : {};
  const transcript = isPlainObject(record.transcript) ? record.transcript : {};
  const fallback = Array.isArray(transcript.messages) ? transcript.messages : [];
  const archive = transcript.archive;
  if (!isPlainObject(archive) || !Array.isArray(archive.chunks) || archive.chunks.length === 0) {
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


export function createTranscriptPageResult(messages: unknown, options: Record<string, unknown> = {}) {
  return { ok: true, positions: [], chunksRead: 0, ...createTranscriptPage(messages, options) };
}


export function transcriptPageReadError(result: unknown) {
  const record = isPlainObject(result) ? result : {};
  const error = isPlainObject(record.error) ? record.error : null;
  return {
    ok: false,
    status: 500,
    code: error?.code ?? "TRANSCRIPT_PAGE_READ_ERROR",
    error: error?.message ?? "读取会话记录分页失败"
  };
}


export function mergeActiveTranscriptPage(storedPage: TranscriptPageView, state: DashboardActiveSessionState, options: Record<string, unknown> = {}) {
  const storedMessages = Array.isArray(storedPage.messages) ? storedPage.messages : [];
  const storedPositions = Array.isArray(storedPage.positions) ? storedPage.positions : [];
  const storedSummary = storedPage.summary ?? {};
  const activeTail = stableActiveTranscriptMessages(state)
    .filter((message) => VISIBLE_TRANSCRIPT_ROLES.has(String(message?.role ?? "")));
  const overlap = transcriptOverlapSize(storedMessages, activeTail);
  const storedEntries = storedMessages.map((message, index) => ({
    message,
    position: nonNegativeInteger(storedPositions[index] ?? (Number(storedSummary.start) + index))
  }));
  const appended = activeTail.slice(overlap);
  const pendingEntries = activePendingTranscriptEntries(state, nonNegativeInteger(storedSummary.end));
  const positionedPending = pendingEntries.slice(-appended.length);
  const pendingMatches = positionedPending.length === appended.length
    && sameTranscriptSlice(positionedPending.map((entry) => entry.message), appended);
  const appendedEntries = appended.map((message, index) => ({
    message,
    position: pendingMatches
      ? positionedPending[index].position
      : nonNegativeInteger(storedSummary.end) + index
  }));
  const mergedEntries = storedEntries.concat(appendedEntries);
  const limit = clampTranscriptPageLimit(options.limit);
  const selected = mergedEntries.slice(-limit);
  const messages = selected.map((entry: { message?: unknown; position?: number }) => entry.message);
  const start = selected[0]?.position ?? 0;
  const pendingVisible = Array.isArray(state.session.transcriptArchive?.pendingMessages)
    ? state.session.transcriptArchive.pendingMessages.filter((message) => {
      if (!message || typeof message !== "object") {
        return false;
      }
      return VISIBLE_TRANSCRIPT_ROLES.has(String((message as { role?: string }).role ?? ""));
    }).length
    : 0;
  const archiveVisible = Number(state.session.transcriptArchive?.totalVisibleMessages);
  const total = Math.max(
    nonNegativeInteger(storedSummary.total),
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
      end: Math.max(nonNegativeInteger(storedSummary.end), (pendingEntries.at(-1)?.position ?? -1) + 1)
    }
  };
}


export function activePendingTranscriptEntries(state: DashboardActiveSessionState, archiveEnd: number) {
  const pending = Array.isArray(state.session.transcriptArchive?.pendingMessages)
    ? state.session.transcriptArchive.pendingMessages
    : [];
  const entries = [];
  for (let index = 0; index < pending.length; index += 1) {
    const message = pending[index];
    const role = isPlainObject(message) ? message.role : undefined;
    if (VISIBLE_TRANSCRIPT_ROLES.has(String(role ?? ""))) {
      entries.push({ message, position: archiveEnd + index });
    }
  }
  return entries;
}


export function transcriptOverlapSize(baseMessages: unknown, tailMessages: unknown) {
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


export function hasTranscriptCursor(value: unknown) {
  return value !== undefined && value !== null && value !== "";
}


export function sameTranscriptSlice(left: unknown, right: unknown) {
  const leftMessages = Array.isArray(left) ? left : [];
  const rightMessages = Array.isArray(right) ? right : [];
  if (leftMessages.length !== rightMessages.length) {
    return false;
  }
  return leftMessages.every((message, index) => transcriptMessageKey(message) === transcriptMessageKey(rightMessages[index]));
}


export function transcriptMessageKey(message: unknown) {
  return JSON.stringify(message ?? null);
}


export function createTranscriptPage(messages: unknown, options: Record<string, unknown> = {}) {
  const visible = Array.isArray(messages)
    ? messages.filter((message) => VISIBLE_TRANSCRIPT_ROLES.has(String(isPlainObject(message) ? message.role : "")))
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


export function clampTranscriptPageLimit(value: unknown) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    return DEFAULT_TRANSCRIPT_PAGE_LIMIT;
  }
  return Math.min(number, MAX_TRANSCRIPT_PAGE_LIMIT);
}


export function transcriptCursorIndex(value: unknown, fallback: unknown): number {
  const fallbackNumber = Number(fallback);
  const safeFallback = Number.isFinite(fallbackNumber) ? fallbackNumber : 0;
  if (value === undefined || value === null || value === "") {
    return safeFallback;
  }
  const number = Number(value);
  if (!Number.isInteger(number)) {
    return safeFallback;
  }
  return Math.max(0, Math.min(number, safeFallback));
}


export function activeReplayCursor(state: DashboardActiveSessionState) {
  if (!state?.running || !state.currentTurnId) {
    return state?.eventSequence ?? 0;
  }
  const index = state.events.findIndex((event) => event.turnId === state.currentTurnId);
  return index > 0 ? nonNegativeInteger(state.events[index - 1].sequence) : 0;
}


export function activeSessionRecord(state: DashboardActiveSessionState, persisted: Record<string, unknown> | null = null, backgroundSnapshot: { groups?: Array<{ kind?: string; [key: string]: unknown }>; [key: string]: unknown } | null = null) {
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


export function latestEventTime(state: DashboardActiveSessionState) {
  const latest = state.events.at(-1)?.at;
  return typeof latest === "string" ? latest : null;
}


export function activeDashboardStatus(state: DashboardActiveSessionState) {
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


export function compareSessionRecords(a: { modifiedAt?: unknown }, b: { modifiedAt?: unknown }) {
  return String(b.modifiedAt ?? "").localeCompare(String(a.modifiedAt ?? ""));
}


export function messageContentText(content: unknown) {
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


/** @param {Record<string, any>} metadata */
export function persistedSessionFailure(metadata: Record<string, unknown>) {
  const status = String(metadata?.status ?? "").trim().toLowerCase();
  if (!["failed", "error", "gateway_error"].includes(status)) {
    return null;
  }
  const rounds = Array.isArray(metadata?.gatewayRounds) ? metadata.gatewayRounds : [];
  const round = [...rounds].reverse().find((item) => isPlainObject(item) && isPlainObject(item.error));
  const error = isPlainObject(round) && isPlainObject(round.error) ? round.error : null;
  if (!error) {
    return null;
  }
  const details = isPlainObject(error.details) ? error.details : null;
  const httpStatus = Number.isInteger(error.status) && Number(error.status) > 0 ? Number(error.status) : null;
  const attempts = Number.isInteger(details?.attempts) && Number(details?.attempts) > 0
    ? Number(details?.attempts)
    : null;
  return {
    kind: "gateway",
    code: publicFailureText(error.code, 120) || "GATEWAY_ERROR",
    message: publicFailureText(error.message, 500) || "模型网关请求失败",
    httpStatus,
    upstreamMessage: gatewayFailureBodyMessage(details?.body),
    attempts
  };
}

/** @param {unknown} body */


/** @param {unknown} body */
export function gatewayFailureBodyMessage(body: unknown) {
  if (typeof body !== "string" || !body.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(body);
    const record = isPlainObject(parsed) ? parsed : {};
    const nested = isPlainObject(record.error) ? record.error : {};
    return publicFailureText(nested.message ?? record.message, 500) || null;
  } catch {
    return null;
  }
}

/** @param {unknown} value @param {number} maxLength */


/** @param {unknown} value @param {number} maxLength */
export function publicFailureText(value: unknown, maxLength: number) {
  const text = typeof value === "string" ? redactGatewayText(value).trim() : "";
  return text ? text.slice(0, maxLength) : "";
}
