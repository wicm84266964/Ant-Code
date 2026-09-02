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
  ALLOWED_IMAGE_MIME_TYPES,
  ActiveSessionCapacityError,
  ActiveSessionMap,
  DASHBOARD_ACTIVE_SESSION_DEFAULTS,
  MAX_IMAGE_BYTES,
  MAX_PROMPT_BYTES,
  MAX_QUEUE,
  MAX_TOTAL_IMAGE_BYTES,
  MAX_TURN_IMAGES,
  MAX_TURN_REQUESTS,
  TURN_REQUEST_TTL_MS
} from "./types.ts";
import type {
  DashboardActiveSessionState,
  DashboardQueueItem,
  DashboardRequestInput,
  DashboardRuntimeContext,
  DashboardTurnAttachment,
  EnsureTurnStateOptions,
  RequireExactSessionIdOptions,
  TurnRequestRecord,
  TurnSubmissionResult
} from "./types.ts";
import {
  activeSessionCapacityResult,
  reclaimActiveSessions,
  scheduleSessionPersistenceCheck
} from "./active-map.ts";
import {
  appendWorkflowSnapshot,
  askApproval,
  askQuestion,
  clearForceSettleTimer
} from "./approvals.ts";
import {
  queueBackgroundWakePrompt,
  scheduleBackgroundSubagentSnapshot
} from "./background.ts";
import {
  dropGoalContinueItems,
  emitGoalState,
  maybeEnqueueGoalContinue,
  persistGoalSnapshot,
  publicStateGoal,
  updateGoalAfterTurn
} from "./goal-runtime.ts";
import {
  cancelAllQueuedTurns
} from "./lifecycle.ts";
import {
  accumulateTurnChangeStats,
  applyDashboardSessionV2MutationView,
  applySessionConfig,
  applySessionModel,
  applySessionReasoningEffort,
  configForDashboardSelection,
  configForExistingSession,
  dashboardSessionV2MutationView,
  emptyChangeStats,
  invalidateRunningDashboardSessionSelection,
  isConfigV2Enabled,
  normalizeChangeStats,
  sessionStatusSummary,
  unresolvedSessionModelSelectionResult
} from "./session-model.ts";
import {
  activeTranscriptMessages
} from "./session-records.ts";
import {
  resolveDashboardTrust
} from "./trust.ts";
import {
  appendDashboardEvent,
  eventId,
  isPlainObject,
  nonNegativeInteger
} from "./util.ts";


export async function withIdempotentTurnRequest(
  records: Map<string, { fingerprint: string; expiresAt: number; settled: boolean; promise: Promise<unknown> | null }>,
  input: DashboardRequestInput,
  create: () => unknown
) {
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

  const record: { fingerprint: string; expiresAt: number; settled: boolean; promise: Promise<unknown> | null } = {
    fingerprint,
    expiresAt: Date.now() + TURN_REQUEST_TTL_MS,
    settled: false,
    promise: null
  };
  record.promise = Promise.resolve()
    .then(create)
    .then((result) => ({ ...(isPlainObject(result) ? result : {}), requestId: requestId.value }));
  records.set(requestId.value, record);
  try {
    return await record.promise;
  } finally {
    record.settled = true;
  }
}

export function validateTurnSubmission(input: DashboardRequestInput = {}): TurnSubmissionResult {
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
    if (!isPlainObject(item) || item.type !== "image") {
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


export function isCanonicalBase64(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length % 4 !== 0 || /\s/.test(value)) {
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


export function matchesImageSignature(buffer: Buffer, mimeType: unknown) {
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


export function normalizeTurnRequestId(value: unknown) {
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


export function turnRequestFingerprint(input: DashboardRequestInput = {}) {
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


export function updateFingerprintField(hash: Hash, name: string, value: unknown) {
  const text = String(value);
  hash.update(name);
  hash.update("\0");
  hash.update(String(Buffer.byteLength(text, "utf8")));
  hash.update("\0");
  hash.update(text);
  hash.update("\0");
}


export function pruneTurnRequests(records: Map<string, TurnRequestRecord>) {
  const now = Date.now();
  for (const [requestId, record] of records) {
    if (record.settled && record.expiresAt <= now) {
      records.delete(requestId);
    }
  }
}


/** @param {Record<string, any>} state */
export function takeNextQueueItem(state: DashboardActiveSessionState) {
  const hasUserWork = state.queuedPrompts.some((item) => ["guide", "prompt", "wakeup"].includes(item.kind ?? ""));
  if (hasUserWork) {
    dropGoalContinueItems(state);
  }
  return state.queuedPrompts.shift() ?? null;
}

/** @param {Record<string, any>} state */


/** @param {Record<string, any>} state */
export function userVisibleQueueLength(state: DashboardActiveSessionState) {
  return state.queuedPrompts.filter((item) => item.kind !== GOAL_CONTINUE_KIND).length;
}

/** @param {Record<string, any>} state @param {string} terminalStatus */


export async function startDashboardTurn(context: DashboardRuntimeContext, input: DashboardRequestInput) {
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
    let state: DashboardActiveSessionState;
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
      if (error instanceof SessionModelSelectionUnresolvedError || (isPlainObject(error) && error.code === "SESSION_MODEL_SELECTION_UNRESOLVED")) {
        return unresolvedSessionModelSelectionResult(error, normalized.sessionId);
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
        usage: state.session.usage,
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
        total + (queued.attachments ?? []).reduce((sum, attachment) => sum + nonNegativeInteger(attachment.size), 0)
      ), 0);
      const newAttachmentBytes = attachments.reduce((total, attachment) => total + nonNegativeInteger(attachment.size), 0);
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
        goal: publicStateGoal(state),
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
      goal: publicStateGoal(state),
      sessionStatus: sessionStatusSummary(state.session)
    };
  };
  return normalized.sessionId
    ? withKeyedMutation(context.sessionMutationLocks, normalized.sessionId, run)
    : run();
}


export function normalizeMutationSessionId(value: unknown):
  | { ok: true; sessionId: string }
  | { ok: false; status: number; code: string; error: string } {
  const sessionId = String(value ?? "").trim();
  if (!sessionId) {
    return { ok: false, status: 400, code: "SESSION_ID_REQUIRED", error: "请选择完整的会话 ID" };
  }
  if (sessionId.toLowerCase() === "latest") {
    return { ok: false, status: 400, code: "EXACT_SESSION_ID_REQUIRED", error: "修改操作只接受完整会话 ID" };
  }
  return { ok: true, sessionId };
}


export async function requireExactSessionId(active: ActiveSessionMap, options: RequireExactSessionIdOptions) {
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


export async function withKeyedMutation<T>(locks: Map<string, Promise<unknown>>, key: string, fn: () => Promise<T> | T): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise<void>((resolve) => {
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


export function sessionMutationBusyResult(sessionId: string) {
  return {
    ok: false,
    status: 409,
    code: "SESSION_MUTATION_IN_PROGRESS",
    error: "该会话正在执行另一项修改，请稍后重试",
    sessionId
  };
}


export function quarantinedSessionResult(state: DashboardActiveSessionState) {
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


export async function ensureTurnState(active: ActiveSessionMap, options: EnsureTurnStateOptions) {
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


export function createTurnState(
  session: Awaited<ReturnType<typeof createSession>>,
  runTurn: DashboardActiveSessionState["runTurn"] = runSessionTurn,
  options: { persisted?: boolean } = {}
): DashboardActiveSessionState {
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
    turnEnv: null,
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


export async function prepareDashboardSessionForQueuedTurn(state: DashboardActiveSessionState, env: NodeJS.ProcessEnv | undefined) {
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


export function beginPrompt(state: DashboardActiveSessionState, item: DashboardQueueItem, env: NodeJS.ProcessEnv | undefined) {
  if (
    state.disposed
    || state.running
    || state.quarantinedTurnId
    || (isPlainObject(state.session.modelSelectionInvalidation) && state.session.modelSelectionInvalidation.status === "unresolved")
  ) {
    return false;
  }
  applyPermissionMode(state.session, item.permissionMode ?? "plan");
  state.persisted = false;
  state.running = true;
  state.interrupting = false;
  state.status = "running";
  state.currentPrompt = String(item.prompt ?? "");
  state.currentTurnId = eventId("turn");
  state.currentAttachmentBytes = (item.attachments ?? []).reduce((total, attachment) => total + nonNegativeInteger(attachment.size), 0);
  state.currentTranscriptStart = activeTranscriptMessages(state).length;
  state.currentPermissionMode = item.permissionMode ?? "plan";
  state.turnChangeStats = emptyChangeStats();
  state.controller = new AbortController();
  state.turnEnv = env ?? null;
  appendDashboardEvent(state, {
    type: "run_state",
    id: eventId("run-state"),
    running: true,
    turnId: state.currentTurnId,
    queue: queueSnapshot(state),
    current: publicQueueItem(item),
    permission: permissionModeSummary(state.session),
    goal: publicStateGoal(state),
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


export function runTurnInBackground(state: DashboardActiveSessionState, item: DashboardQueueItem, env: NodeJS.ProcessEnv | undefined) {
  const controller = state.controller;
  const turnId = state.currentTurnId;
  const eventStartIndex = state.events.length;
  let turnCompleteStatus = "";
  queueMicrotask(async () => {
    try {
      const result = await state.runTurn(state.session, {
        prompt: String(item.prompt ?? ""),
        displayPrompt: String(displayPromptForQueueItem(item) ?? ""),
        attachments: item.attachments,
        env,
        stream: true,
        signal: controller?.signal,
        hooksTrusted: state.hooksTrusted,
        approvalCallback: (request: Record<string, unknown>) => askApproval(state, request),
        userInputCallback: async (request: Record<string, unknown>) => {
          const answered = await askQuestion(state, request);
          return isPlainObject(answered) ? answered : { answer: String(answered ?? "") };
        },
        onEvent: async (event: Record<string, unknown>) => {
          const currentTurn = isCurrentTurn(state, controller, turnId);
          const backgroundEvent = isBackgroundLifecycleEvent(event);
          if (!currentTurn && !backgroundEvent) {
            return;
          }
          if (currentTurn && event.type === "turn_complete") {
            turnCompleteStatus = String(event.status ?? "").trim();
          }
          for (const mapped of mapSessionEventToDashboard(event)) {
            const mappedEvent = mapped as typeof mapped & {
              turnId?: string;
              sessionStatus?: unknown;
              text?: unknown;
              changeStats?: unknown;
              turnChangeStats?: unknown;
            };
            mappedEvent.turnId = turnId;
            mappedEvent.sessionStatus = sessionStatusSummary(state.session);
            if (mappedEvent.type === "assistant_final") {
              mappedEvent.text = stripGoalStatusMarkers(String(mappedEvent.text ?? ""));
            }
            if (currentTurn && mappedEvent.type === "activity" && mappedEvent.changeStats) {
              if (mappedEvent.turnChangeStats) {
                state.turnChangeStats = normalizeChangeStats(mappedEvent.turnChangeStats);
              } else {
                accumulateTurnChangeStats(state, mappedEvent.changeStats);
                mappedEvent.turnChangeStats = { ...state.turnChangeStats };
              }
            }
            appendDashboardEvent(state, mappedEvent);
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
            appendWorkflowSnapshot(state, String(event.reason ?? "workflow_updated"));
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
      if (isPlainObject(pendingMutation) && isPlainObject(pendingMutation.resolution) && isPlainObject(pendingMutation.config)) {
        applyDashboardSessionV2MutationView(state, {
          previousSelection: pendingMutation.previousSelection,
          resolution: pendingMutation.resolution as SessionModelSelectionResolution,
          config: pendingMutation.config as LabAgentConfig
        });
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
          goal: publicStateGoal(state),
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


export function isCurrentTurn(state: DashboardActiveSessionState, controller: unknown, turnId: unknown) {
  return ownsTurn(state, controller, turnId) && state.quarantinedTurnId !== turnId && !state.disposed;
}


export function ownsTurn(state: DashboardActiveSessionState, controller: unknown, turnId: unknown) {
  return state.controller === controller && state.currentTurnId === turnId;
}


export function dashboardTurnStatus(turnCompleteStatus: unknown, result: Record<string, unknown>) {
  const status = String(turnCompleteStatus ?? "").trim().toLowerCase();
  if (status === "cancelled") {
    return "cancelled";
  }
  if (result?.interrupted === true || status === "interrupted") {
    return "interrupted";
  }
  if (["gateway_not_configured", "tool_limit", "vision_unavailable", "context_overflow", "blocked"].includes(status)) {
    return "blocked";
  }
  return status === "completed" ? "completed" : "failed";
}


export function isBackgroundLifecycleEvent(event: Record<string, unknown>) {
  const type = String(event?.type ?? "");
  return type.startsWith("subagent_group_") || type.startsWith("background_terminal_");
}


export function enqueuePrompt(state: DashboardActiveSessionState, prompt: string, permissionMode: unknown, kind: string, attachments: DashboardTurnAttachment[] | unknown = []) {
  if (!queueHasCapacity(state)) {
    return null;
  }
  const item = createQueueItem(prompt, permissionMode, kind, "", attachments);
  state.queuedPrompts.push(item);
  return item;
}


export function queueHasCapacity(state: DashboardActiveSessionState) {
  return userVisibleQueueLength(state) < MAX_QUEUE;
}


export function queueFullResult(state: DashboardActiveSessionState) {
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


export function createQueueItem(prompt: string, permissionMode: unknown = "plan", kind: string = "prompt", guidance: unknown = "", attachments: DashboardTurnAttachment[] | unknown = []): DashboardQueueItem {
  const text = String(prompt ?? "").trim();
  return {
    id: eventId("queue"),
    prompt: text,
    permissionMode: normalizePermissionMode(permissionMode == null ? "plan" : String(permissionMode)),
    kind,
    title: "",
    guidance: String(guidance || text).trim(),
    attachments: kind === "prompt" ? normalizeTurnAttachments(attachments) : [],
    at: new Date().toISOString()
  };
}


export function createWakeQueueItem(event: Record<string, unknown>, permissionMode: unknown = "plan") {
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


export function appendQueueUpdated(state: DashboardActiveSessionState) {
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


export function queueSnapshot(state: DashboardActiveSessionState) {
  return state.queuedPrompts.map(publicQueueItem);
}


export function publicQueueItem(item: DashboardQueueItem) {
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


export function displayPromptForQueueItem(item: DashboardQueueItem) {
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


export function userMessageEventText(item: DashboardQueueItem) {
  if (item.kind === "wakeup" || item.kind === GOAL_CONTINUE_KIND) {
    return displayPromptForQueueItem(item);
  }
  return item.kind === "guide" ? item.guidance : item.prompt;
}


export function normalizeTurnAttachments(value: unknown): DashboardTurnAttachment[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map(normalizeTurnAttachment)
    .filter((item): item is DashboardTurnAttachment => item != null)
    .slice(0, 6);
}


export function normalizeTurnAttachment(item: unknown): DashboardTurnAttachment | null {
  if (!isPlainObject(item) || item.type !== "image") {
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


export function publicAttachments(attachments: unknown) {
  return normalizeTurnAttachments(attachments).map((item) => ({
    type: "image",
    name: item.name,
    mimeType: item.mimeType,
    size: item.size
  }));
}


export function previewText(value: unknown, max: unknown = 120) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  const limit = Number(max);
  const width = Number.isFinite(limit) && limit > 0 ? limit : 120;
  return text.length <= width ? text : `${text.slice(0, width - 3)}...`;
}


export function buildGuidePrompt(guidance: unknown, activePrompt: unknown = "") {
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


export function includesPromptContext(text: string, original: unknown) {
  if (!text || !original) {
    return false;
  }
  return normalizeGuideText(text).includes(normalizeGuideText(original));
}


export function normalizeGuideText(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}


export function isStopGuidance(guidance: unknown) {
  const normalized = String(guidance ?? "")
    .trim()
    .toLowerCase()
    .replace(/[。.!！\s]+$/g, "");
  return /^(停止|停下|取消|中止|终止|abort|cancel|stop)(当前(任务|轮次|请求))?$/.test(normalized);
}
