import crypto from "node:crypto";
import { buildInitialContext } from "../context/builder.ts";
import { loadConfig, type LabAgentConfig } from "../config/load-config.ts";
import {
  applyRuntimeModelSelection,
  currentRuntimeModelSelection,
  patchSessionModelSelectionMetadata,
  resolveSessionModelSelection
} from "../config-v2/runtime-selection.ts";
import { formatGatewayError, normalizeGatewayError } from "../model-gateway/errors.ts";
import { createLabModelGateway } from "../model-gateway/client.ts";
import { listConfiguredModels, listRoutingModels } from "../model-gateway/models.ts";
import { runHooks } from "../hooks/runner.ts";
import { createMcpRuntime } from "../mcp/runtime.ts";
import { appendThinkingPreview, limitThinkingPreview } from "../model-gateway/thinking-budget.ts";
import { createSessionStore } from "../storage/session-store.ts";
import { serializeToolResult } from "../tools/result.ts";
import { countLineChanges } from "../tools/diff.ts";
import { createToolRuntime } from "../tools/runtime.ts";
import { createWorkflowState, formatWorkflowContext, summarizeWorkflow, syncWorkflowCompletionOnFinal, type WorkflowState } from "../tools/workflow-tools.ts";
import { getAgentProfile } from "../agents/profiles.ts";
import { resolveMaxParallelReadonlyAgentRuns } from "../agents/orchestration-config.ts";
import { appendDelegationReminderToExecution, createDelegationGuard } from "../agents/delegation-guard.ts";
import { createReviewGate } from "../agents/review-policy.ts";
import { buildCompactedContextMessage, compactSessionContextWithModel, createContextWindow, estimatePromptPayload, summarizeContextWindow } from "./context-window.ts";
import { buildGoalSystemPromptAppendix, normalizeSessionGoal, serializeSessionGoal, stripGoalStatusFromContent, stripGoalStatusMarkers } from "./goal.ts";
import { createAntEventNormalizer } from "./events.ts";
import { accumulateProviderUsage, normalizeProviderUsageAggregate, sanitizeProviderUsage, type ProviderUsageAggregate } from "./provider-usage.ts";
import { resolveMainToolRounds } from "./tool-rounds.ts";
import { diagnoseWorkspace } from "./workspace-diagnostics.ts";
import {
  DEFAULT_PROMPT_COMPACT_RATIO,
  OUTPUT_HEALTH_CHECK_ENABLED,
  OUTPUT_HEALTH_MAX_RETRIES,
  OUTPUT_HEALTH_RETRY_REQUIRED_REASONS,
  TRANSCRIPT_MEMORY_MESSAGES,
  DEFAULT_RESUME_CONTEXT_MESSAGES,
  DEFAULT_RESUME_CONTEXT_TOKENS,
  DEFAULT_RESUME_CONTEXT_BYTES
} from "./session-types.ts";
import type {
  CreateSessionOptions,
  SessionMessage,
  AgentSession,
  SessionEvent,
  TranscriptArchiveChunk,
  RestoredContextMessages,
  TranscriptArchiveState,
  TurnChangeTracker,
  RunSessionTurnOptions,
  SessionToolResult,
  SessionTurnMetadata
} from "./session-types.ts";
import {
  imageAttachmentSummaryBlock
} from "./session-messages.ts";
import {
  isPlainObject
} from "./session-health.ts";
import {
  SessionModelSelectionUnresolvedError
} from "./session-error.ts";
import {
  limitResumeContextMessages,
  sanitizeRestoredAssistantText,
  persistableContextWindow,
  redactPersistedText,
  positiveInteger,
  nonNegativeInteger,
  emitEvent,
  normalizeAssistantThinking
} from "./session-resume.ts";


/**
 * Legacy metadata stores the model and effort as separate fields. A missing or
 * undefined effort inherits the current config, while an explicit null keeps
 * the session-level override cleared across process restarts.
 *
 * @param {Record<string, any>} config
 * @param {Record<string, any>} metadata
 */
export function configForLegacySessionResume(config: LabAgentConfig, metadata: Record<string, unknown>) {
  const persistedModelId = String(metadata?.model ?? "").trim();
  const modelId = persistedModelId
    && listConfiguredModels(config).some((model) => model.id === persistedModelId)
    ? persistedModelId
    : String(config.modelAlias ?? "").trim();
  const metadataDefinesEffort = Object.prototype.hasOwnProperty.call(metadata ?? {}, "reasoningEffort")
    && metadata.reasoningEffort !== undefined;
  return {
    ...config,
    modelAlias: modelId,
    reasoningEffort: metadataDefinesEffort
      ? normalizeLegacyReasoningEffort(metadata.reasoningEffort)
      : config.reasoningEffort
  };
}

/** @param {unknown} value */


/** @param {unknown} value */
export function normalizeLegacyReasoningEffort(value: unknown) {
  const effort = typeof value === "string" ? value.trim().toLowerCase() : "";
  return effort || null;
}


/**
 * @param {{ readonly?: boolean; allowWrite?: boolean; allowCommand?: boolean; fullAccess?: boolean }} flags
 */
export function resolvePermissionModeFromFlags(flags: { readonly?: boolean; allowWrite?: boolean; allowCommand?: boolean; fullAccess?: boolean }) {
  if (flags.fullAccess) {
    return "fullAccess";
  }
  if (flags.allowWrite || flags.allowCommand) {
    return "workspace";
  }
  return "plan";
}

/**
 * @param {string | null | undefined} value
 */


/**
 * @param {string | null | undefined} value
 */
export function normalizePermissionModeValue(value: string | null | undefined) {
  const mode = String(value ?? "").trim();
  if (mode === "fullAccess" || mode === "full-access" || mode === "完全访问") {
    return "fullAccess";
  }
  if (mode === "workspace" || mode === "workspacePermissions" || mode === "bypassPermissions" || mode === "acceptEdits" || mode === "工作区权限") {
    return "workspace";
  }
  return "plan";
}


export function normalizeClientSurfaceValue(value: unknown) {
  const text = String(value ?? "").trim().toLowerCase();
  if (["dashboard", "web", "webui", "web-ui"].includes(text)) {
    return "dashboard";
  }
  if (["tui", "terminal"].includes(text)) {
    return "tui";
  }
  if (["chat", "interactive-chat", "line"].includes(text)) {
    return "chat";
  }
  if (["print", "headless"].includes(text)) {
    return "print";
  }
  return "generic";
}

/**
 * @param {AgentSession} session
 * @param {string} prompt
 * @param {import("../model-gateway/protocol.ts").NormalizedGatewayResponse} data
 * @param {string} fallbackText
 */


/**
 * @param {AgentSession} session
 * @param {string} prompt
 * @param {import("../model-gateway/protocol.ts").NormalizedGatewayResponse} data
 * @param {string} fallbackText
 */
export async function appendSessionMessages(session: AgentSession, data: import("../model-gateway/protocol.ts").NormalizedGatewayResponse, fallbackText: string, options: {
  thinking?: unknown;
  turnMessages?: SessionMessage[];
  transcriptMessages?: SessionMessage[];
  gateway?: ReturnType<typeof createLabModelGateway>;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  hooksTrusted?: boolean;
  eventOptions?: Record<string, unknown>;
} = {}) {
  const assistantContent = data.content.length > 0
    ? data.content
    : [{ type: "text", text: fallbackText }];
  const assistantMessage: SessionMessage = {
    role: "assistant",
    content: assistantContent
  };
  const thinking = normalizeAssistantThinking(options.thinking);
  if (thinking) {
    assistantMessage.thinking = thinking;
  }

  const turnMessages = Array.isArray(options.turnMessages) ? options.turnMessages : [];
  const transcriptMessages = Array.isArray(options.transcriptMessages) ? options.transcriptMessages : turnMessages;
  session.messages.push(...turnMessages, assistantMessage);
  appendTranscriptMessages(session, [...transcriptMessages, assistantMessage]);
  appendModelContextArchiveMessages(session, [...turnMessages, assistantMessage]);

  return compactSessionContextWithModel(session, {
    reason: "automatic",
    gateway: options.gateway,
    signal: options.signal,
    env: options.env,
    hooksTrusted: options.hooksTrusted,
    onBeforeCompact: (payload: Record<string, unknown>) => emitEvent(options.eventOptions ?? {}, {
      type: "context_compacting",
      reason: "automatic",
      beforeMessages: payload.beforeMessages,
      beforeTokens: payload.beforeTokens,
      beforeBytes: payload.beforeBytes,
      maxTokens: payload.maxTokens,
      maxBytes: payload.maxBytes,
      maxMessages: payload.maxMessages
    })
  });
}

/**
 * @param {ReturnType<typeof createSessionStore>} store
 * @param {Record<string, any>} metadata
 * @param {string} output
 * @param {string} status
 * @param {AgentSession} session
 */


/**
 * @param {ReturnType<typeof createSessionStore>} store
 * @param {Record<string, any>} metadata
 * @param {string} output
 * @param {string} status
 * @param {AgentSession} session
 */
export async function persistSessionMetadata(store: ReturnType<typeof createSessionStore>, metadata: Record<string, unknown>, output: string, status: string, session: AgentSession, options: Record<string, unknown> = {}) {
  metadata.status = status;
  metadata.finishedAt = new Date().toISOString();
  metadata.outputBytes = Buffer.byteLength(output, "utf8");
  const usage = normalizeProviderUsageAggregate(session.usage);
  metadata.usage = usage;
  metadata.lastProviderUsage = usage.last ?? null;
  metadata.workflow = summarizeWorkflow(session.workflow);
  metadata.context = summarizeContextWindow(session);
  metadata.goal = serializeSessionGoal(session.goal);
  metadata.permissionMode = session.permissionMode;
  metadata.fullAccess = session.fullAccess;
  metadata.readonly = session.readonly;
  metadata.allowWrite = session.allowWrite;
  metadata.allowCommand = session.allowCommand;
  const committed = await commitSessionSnapshot(store, metadata, session);
  Object.assign(metadata, committed.metadata);
  const metadataPath = committed.metadataPath;
  metadata.metadataPath = metadataPath;
  await runHooks({
    config: session.config,
    cwd: session.cwd,
    env: options.env,
    hooksTrusted: options.hooksTrusted,
    event: "session.end",
    sessionId: session.id,
    payload: {
      sessionId: session.id,
      status,
      turnIndex: metadata.turnIndex,
      outputBytes: metadata.outputBytes,
      metadataPath,
      context: metadata.context
    }
  });
}

/**
 * Persist an already-created session after a Dashboard-only context mutation.
 * This intentionally does not emit session.end hooks or change terminal status.
 *
 * @param {AgentSession} session
 * @param {{ env?: NodeJS.ProcessEnv; store?: ReturnType<typeof createSessionStore> }} [options]
 */


/**
 * Persist an already-created session after a Dashboard-only context mutation.
 * This intentionally does not emit session.end hooks or change terminal status.
 *
 * @param {AgentSession} session
 * @param {{ env?: NodeJS.ProcessEnv; store?: ReturnType<typeof createSessionStore> }} [options]
 */
export async function persistSessionSnapshot(session: AgentSession, options: { env?: NodeJS.ProcessEnv; store?: ReturnType<typeof createSessionStore>; requireExisting?: boolean } = {}) {
  const store = options.store ?? createSessionStore({
    cwd: session.cwd,
    transcript: session.config?.transcript,
    env: options.env ?? process.env
  });
  const metadata: Record<string, unknown> = sessionModelMetadata(session);
  metadata.id = session.id;
  metadata.cwd = session.cwd;
  metadata.startedAt = session.startedAt ?? new Date().toISOString();
  metadata.mode = session.mode;
  metadata.clientSurface = session.clientSurface;
  metadata.title = session.title ?? null;
  metadata.turnIndex = session.turnCount ?? 0;
  metadata.status = session.goal?.enabled ? session.goal.status : metadata.status;
  metadata.permissionMode = session.permissionMode;
  metadata.fullAccess = session.fullAccess;
  metadata.readonly = session.readonly;
  metadata.allowWrite = session.allowWrite;
  metadata.allowCommand = session.allowCommand;
  metadata.context = summarizeContextWindow(session);
  metadata.workflow = summarizeWorkflow(session.workflow);
  metadata.goal = serializeSessionGoal(session.goal);
  const committed = await commitSessionSnapshot(store, metadata, session, {
    requireExisting: options.requireExisting !== false
  });
  return { ok: true, metadataPath: committed.metadataPath, metadata: committed.metadata };
}


export function persistableMessages(messages: unknown) {
  return persistableMessagesWithOptions(messages);
}


export function persistableTranscriptMessages(messages: unknown, session: AgentSession) {
  return persistableMessagesWithOptions(messages, {
    includeThinking: true,
    includeToolCalls: false,
    stripGoalStatus: session?.goal?.enabled === true
  });
}


export function persistableContextMessages(messages: unknown) {
  return persistableMessagesWithOptions(repairDanglingToolCallMessages(messages), {
    includeThinking: true,
    includeToolCalls: true
  });
}


export function persistableMessagesWithOptions(messages: unknown, options: Record<string, unknown> = {}) {
  if (!Array.isArray(messages)) {
    return [];
  }
  return messages
    .map((message) => persistableMessage(message, options))
    .filter(Boolean);
}


export function repairDanglingToolCallMessages(messages: unknown = []): SessionMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) {
    return [];
  }
  const source = messages.map((message) => cloneTranscriptMessage(message)).filter((message): message is SessionMessage => Boolean(message) && typeof message === "object");
  const repaired = [];
  for (let index = 0; index < source.length; index += 1) {
    const message = source[index];
    if (message?.role === "tool") {
      continue;
    }
    const calls = assistantToolCalls(message);
    if (calls.length === 0) {
      repaired.push(message);
      continue;
    }
    const expected = new Set(calls.map((call) => String(call.id ?? "")).filter(Boolean));
    const seen = new Set();
    const toolMessages = [];
    let nextIndex = index + 1;
    for (; nextIndex < source.length; nextIndex += 1) {
      const next = source[nextIndex];
      if (!next || next.role !== "tool") {
        break;
      }
      const toolCallId = String(next.toolCallId ?? next.tool_call_id ?? "");
      if (expected.has(toolCallId) && !seen.has(toolCallId)) {
        seen.add(toolCallId);
        toolMessages.push(next);
      }
    }
    if (seen.size === expected.size && expected.size > 0) {
      repaired.push(message, ...toolMessages);
      index = nextIndex - 1;
      continue;
    }
    delete message.toolCalls;
    delete message.tool_calls;
    repaired.push(message);
    index = nextIndex - 1;
  }
  return repaired;
}


export function assistantToolCalls(message: SessionMessage | null | undefined) {
  if (!message || message.role !== "assistant") {
    return [];
  }
  if (Array.isArray(message.toolCalls)) {
    return message.toolCalls;
  }
  if (Array.isArray(message.tool_calls)) {
    return message.tool_calls.map((call) => {
      const record = call && typeof call === "object" ? call as Record<string, unknown> : {};
      const fn = record.function && typeof record.function === "object" ? record.function as Record<string, unknown> : {};
      return {
        id: record.id,
        name: fn.name ?? record.name,
        input: fn.arguments ?? record.input
      };
    });
  }
  return [];
}


export function transcriptMessagesForPersistence(session: AgentSession) {
  return Array.isArray(session.transcriptMessages) && session.transcriptMessages.length > 0
    ? session.transcriptMessages
    : session.messages;
}

/**
 * Commit both archives and their metadata pointers under one session lock.
 * Each writer rebases its pending messages onto the latest committed archives.
 *
 * @param {ReturnType<typeof createSessionStore>} store
 * @param {Record<string, any>} metadataUpdates
 * @param {AgentSession} session
 * @param {{ requireExisting?: boolean }} [options]
 */


/**
 * Commit both archives and their metadata pointers under one session lock.
 * Each writer rebases its pending messages onto the latest committed archives.
 *
 * @param {ReturnType<typeof createSessionStore>} store
 * @param {Record<string, any>} metadataUpdates
 * @param {AgentSession} session
 * @param {{ requireExisting?: boolean }} [options]
 */
export async function commitSessionSnapshot(store: ReturnType<typeof createSessionStore>, metadataUpdates: Record<string, unknown>, session: AgentSession, options: { requireExisting?: boolean } = {}) {
  const transcriptState = normalizeTranscriptArchiveState(session.transcriptArchive);
  const modelState = normalizeTranscriptArchiveState(session.modelContextArchive);
  const transcriptPending = transcriptState.pendingMessages.slice();
  const modelPending = modelState.pendingMessages.slice();

  const committed = await store.withSessionMutation(session.id, async () => {
    const current = await store.readMetadataExact(session.id, { lockHeld: true });
    if (!current.ok && (options.requireExisting === true || current.error?.code !== "SESSION_NOT_FOUND")) {
      const error = Object.assign(
        new Error(current.error?.message ?? "Session metadata is not available for persistence"),
        { code: current.error?.code ?? "SESSION_METADATA_NOT_FOUND" }
      );
      throw error;
    }

    const currentMetadata = current.ok ? current.metadata : {};
    const currentTranscript = isPlainObject(currentMetadata.transcript) ? currentMetadata.transcript : {};
    const transcriptBase = current.ok
      ? normalizeTranscriptArchiveState(currentTranscript.archive)
      : transcriptState;
    const modelBase = current.ok
      ? normalizeTranscriptArchiveState(currentTranscript.modelArchive)
      : modelState;
    const transcriptArchive = await store.writeTranscriptChunks(
      session.id,
      transcriptPending,
      transcriptBase,
      { lockHeld: true }
    );
    const modelArchive = await store.writeTranscriptChunks(
      session.id,
      modelPending,
      modelBase,
      { suffix: "model-context", lockHeld: true }
    );
    const metadata = {
      ...currentMetadata,
      ...metadataUpdates,
      ...sessionModelMetadata(session),
      transcript: {
        ...(currentMetadata.transcript ?? {}),
        ...(metadataUpdates.transcript ?? {}),
        version: 2,
        messages: persistableTranscriptMessages(transcriptMessagesForPersistence(session), session),
        contextMessages: persistableContextMessages(limitResumeContextMessages(session.messages, session.config.context)),
        contextWindow: persistableContextWindow(session.contextWindow),
        archive: persistableTranscriptArchive(transcriptArchive),
        modelArchive: persistableTranscriptArchive(modelArchive)
      }
    };
    const metadataPath = await store.writeMetadata(metadata, { lockHeld: true });
    return { metadataPath, metadata, transcriptArchive, modelArchive };
  });

  session.transcriptArchive = normalizeTranscriptArchiveState(committed.transcriptArchive);
  session.modelContextArchive = normalizeTranscriptArchiveState(committed.modelArchive);
  session.transcriptArchive.pendingMessages = transcriptState.pendingMessages.slice(transcriptPending.length);
  session.modelContextArchive.pendingMessages = modelState.pendingMessages.slice(modelPending.length);
  return committed;
}

/** @param {AgentSession} session */


/** @param {AgentSession} session */
export function refreshSessionModelSelection(session: AgentSession) {
  const selection = currentRuntimeModelSelection(session.config, {
    model: session.model,
    reasoningEffort: session.config?.reasoningEffort
  });
  session.modelSelection = selection;
  return selection;
}

/** @param {AgentSession} session @returns {Record<string, any>} */


/** @param {AgentSession} session @returns {Record<string, any>} */
export function sessionModelMetadata(session: AgentSession): Record<string, unknown> {
  const selection = refreshSessionModelSelection(session);
  if (selection) return patchSessionModelSelectionMetadata({}, selection as Record<string, unknown>);
  if (session.config?.configV2?.enabled === true) {
    throw new SessionModelSelectionUnresolvedError({
      reason: "invalid-runtime-selection",
      model: String(session.model ?? ""),
      selection: isPlainObject(session.modelSelection) ? session.modelSelection : null
    });
  }
  return {
    metadataVersion: 1,
    model: String(session.model ?? ""),
    reasoningEffort: typeof session.config?.reasoningEffort === "string"
      ? session.config.reasoningEffort
      : null,
    modelSelection: null
  };
}


export function appendTranscriptMessages(session: AgentSession, messages: unknown) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return;
  }
  const cloned = messages.map((message) => {
    const copy = cloneTranscriptMessage(message);
    if (!copy) {
      return null;
    }
    if (session.goal?.enabled && copy.role === "assistant") {
      copy.content = stripGoalStatusFromContent(copy.content);
    }
    return copy;
  }).filter((message): message is SessionMessage => Boolean(message));
  if (!Array.isArray(session.transcriptMessages)) {
    session.transcriptMessages = Array.isArray(session.messages) ? session.messages.slice() : [];
  }
  session.transcriptMessages.push(...cloned);
  session.transcriptMessages = limitTranscriptMemory(session.transcriptMessages);
  session.transcriptArchive = normalizeTranscriptArchiveState(session.transcriptArchive);
  session.transcriptArchive.pendingMessages.push(...persistableContextMessages(cloned));
}


export function appendModelContextArchiveMessages(session: AgentSession, messages: unknown) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return;
  }
  const cloned = messages.map((message: string) => cloneTranscriptMessage(message));
  session.modelContextArchive = normalizeTranscriptArchiveState(session.modelContextArchive);
  session.modelContextArchive.pendingMessages.push(...persistableContextMessages(cloned));
}


export function limitTranscriptMemory(messages: unknown) {
  if (!Array.isArray(messages)) {
    return [];
  }
  return messages.slice(-TRANSCRIPT_MEMORY_MESSAGES);
}


export function normalizeTranscriptArchiveState(archive: unknown = {}): TranscriptArchiveState {
  const record = archive && typeof archive === "object" && !Array.isArray(archive)
    ? archive as Record<string, unknown>
    : {};
  const chunkSize = positiveInteger(record.chunkSize, TRANSCRIPT_MEMORY_MESSAGES) ?? TRANSCRIPT_MEMORY_MESSAGES;
  const chunks = Array.isArray(record.chunks)
    ? record.chunks.map(normalizeTranscriptArchiveChunk).filter((chunk): chunk is TranscriptArchiveChunk => chunk != null)
    : [];
  const totalFromChunks = chunks.reduce((sum, chunk) => sum + chunk.messages, 0);
  const visibleFromChunks = chunks.reduce((sum, chunk) => sum + (chunk.visibleMessages ?? 0), 0);
  const chunksHaveVisibleCounts = chunks.every((chunk) => chunk.visibleMessages !== null);
  return {
    version: 1,
    chunkSize: chunkSize ?? TRANSCRIPT_MEMORY_MESSAGES,
    totalMessages: nonNegativeInteger(record.totalMessages, totalFromChunks) ?? totalFromChunks,
    totalVisibleMessages: nonNegativeInteger(
      record.totalVisibleMessages,
      chunks.length === 0 ? 0 : chunksHaveVisibleCounts ? visibleFromChunks : null
    ) ?? (chunks.length === 0 ? 0 : chunksHaveVisibleCounts ? visibleFromChunks : null),
    chunks,
    pendingMessages: Array.isArray(record.pendingMessages) ? record.pendingMessages.filter(Boolean) : []
  };
}


export function normalizeTranscriptArchiveChunk(chunk: unknown): TranscriptArchiveChunk | null {
  if (!chunk || typeof chunk !== "object") {
    return null;
  }
  const record = chunk as Record<string, unknown>;
  const index = positiveInteger(record.index, null);
  const file = typeof record.file === "string" ? record.file : "";
  if (!index || !file) {
    return null;
  }
  return {
    index,
    file,
    messages: nonNegativeInteger(record.messages, 0) ?? 0,
    visibleMessages: nonNegativeInteger(record.visibleMessages, null),
    bytes: nonNegativeInteger(record.bytes, 0) ?? 0,
    encrypted: record.encrypted === true || file.endsWith(".json.enc")
  };
}


export function persistableTranscriptArchive(archive: unknown = {}) {
  const normalized = normalizeTranscriptArchiveState(archive);
  return {
    version: normalized.version,
    chunkSize: normalized.chunkSize,
    totalMessages: normalized.totalMessages,
    totalVisibleMessages: normalized.totalVisibleMessages,
    chunks: normalized.chunks
  };
}


export function cloneTranscriptMessage(message: unknown): SessionMessage | null {
  if (!isPlainObject(message)) {
    return null;
  }
  return {
    ...message,
    role: String(message.role ?? ""),
    content: cloneTranscriptContent(message.content),
    ...(isPlainObject(message.thinking) ? { thinking: { ...message.thinking } } : {})
  };
}


export function cloneTranscriptContent(content: unknown) {
  if (Array.isArray(content)) {
    return content.map((item) => (item && typeof item === "object" ? { ...item } : item));
  }
  return content;
}


export function persistableMessage(message: unknown, options: Record<string, unknown> = {}) {
  if (!isPlainObject(message)) {
    return null;
  }
  const role = typeof message.role === "string" ? message.role : "";
  if (!["user", "assistant", "tool"].includes(role)) {
    return null;
  }
  const persisted: SessionMessage = {
    role,
    content: persistableContent(message.content, {
      sanitizeAssistantText: role === "assistant",
      stripGoalStatus: options.stripGoalStatus === true && role === "assistant"
    })
  };
  if (message.interruptedDraft === true) {
    persisted.interruptedDraft = true;
  }
  const thinking = options.includeThinking === false ? null : role === "assistant" ? persistableThinking(message.thinking) : null;
  if (thinking) {
    persisted.thinking = thinking;
  }
  if (options.includeToolCalls !== false && Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
    persisted.toolCalls = message.toolCalls.map((call) => ({
      id: typeof call.id === "string" ? call.id : "",
      name: typeof call.name === "string" ? call.name : "",
      input: sanitizePersistedValue(call.input ?? {})
    }));
  }
  if (role === "tool") {
    if (typeof message.toolCallId === "string" && message.toolCallId) {
      persisted.toolCallId = message.toolCallId;
    }
    if (typeof message.name === "string" && message.name) {
      persisted.name = message.name;
    }
  }
  return persisted;
}


export function persistableThinking(thinking: unknown) {
  const normalized = normalizeAssistantThinking(thinking);
  if (!normalized) {
    return null;
  }
  const text = redactPersistedText(normalized.text);
  const bytes = Buffer.byteLength(text, "utf8") || normalized.bytes;
  return {
    text,
    bytes,
    truncated: normalized.truncated === true,
    source: normalized.source,
    persistedAt: normalized.persistedAt
  };
}


export function persistableContent(content: unknown, options: Record<string, unknown> = {}) {
  const sanitizeAssistantText = options.sanitizeAssistantText === true;
  const stripGoalStatus = options.stripGoalStatus === true;
  if (typeof content === "string") {
    let text = redactPersistedText(content);
    if (stripGoalStatus) text = stripGoalStatusMarkers(text);
    return sanitizeAssistantText ? sanitizeRestoredAssistantText(text) : text;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content.map((item) => {
    if (typeof item === "string") {
      let text = redactPersistedText(item);
      if (stripGoalStatus) text = stripGoalStatusMarkers(text);
      return sanitizeAssistantText ? sanitizeRestoredAssistantText(text) : text;
    }
    if (!item || typeof item !== "object") {
      return item;
    }
    const record = item as Record<string, unknown>;
    if (record.type === "image") {
      return imageAttachmentSummaryBlock({
        name: String(record.name ?? "image"),
        mimeType: String(record.mimeType ?? record.mime_type ?? "image"),
        size: nonNegativeInteger(record.size ?? record.bytes ?? record.sizeBytes, 0) ?? 0
      });
    }
    if ("text" in record) {
      let text = redactPersistedText(String(record.text ?? ""));
      if (stripGoalStatus) text = stripGoalStatusMarkers(text);
      return {
        ...item,
        text: sanitizeAssistantText ? sanitizeRestoredAssistantText(text) : text
      };
    }
    return sanitizePersistedValue(item);
  });
}


export function sanitizePersistedValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactPersistedText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizePersistedValue(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    /token|secret|password|api_key/i.test(key) ? "[redacted]" : sanitizePersistedValue(item)
  ]));
}
