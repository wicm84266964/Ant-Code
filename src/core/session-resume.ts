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
  persistableUserTurnMessage
} from "./session-messages.ts";
import {
  isPlainObject,
  promptEstimateNeedsCompaction
} from "./session-health.ts";
import {
  persistSessionMetadata,
  repairDanglingToolCallMessages,
  appendTranscriptMessages,
  appendModelContextArchiveMessages,
  normalizeTranscriptArchiveState,
  persistableMessage,
  persistableThinking
} from "./session-persist.ts";


export function restorePersistedMessages(messages: unknown) {
  if (!Array.isArray(messages)) {
    return [];
  }
  return messages
    .map((message) => sanitizeRestoredMessage(persistableMessage(message)))
    .filter((message): message is SessionMessage => Boolean(message));
}


export function restoreRecentTranscriptMessages(messages: unknown) {
  if (!Array.isArray(messages)) {
    return [];
  }
  return restorePersistedMessages(messages.slice(-TRANSCRIPT_MEMORY_MESSAGES));
}


export function restorePersistedContextMessages(messages: unknown, context: unknown = {}): SessionMessage[] {
  if (!Array.isArray(messages)) {
    return [];
  }
  return repairDanglingToolCallMessages(restorePersistedMessages(limitResumeContextMessages(messages, context)));
}


export async function restoreResumeContextMessages(input: {
  store?: ReturnType<typeof createSessionStore>;
  archive?: unknown;
  modelArchive?: unknown;
  metadataMessages?: unknown;
  context?: unknown;
  allowArchive?: boolean;
  preferArchive?: boolean;
}): Promise<RestoredContextMessages> {
  const persisted = restorePersistedContextMessages(input.metadataMessages, input.context);
  if (input.allowArchive === false) {
    return { messages: persisted, persistedMessages: persisted, fromArchive: false };
  }
  let archived: SessionMessage[] = [];
  let modelArchived: SessionMessage[] = [];
  try {
    archived = await restoreArchivedContextMessages(input.store, input.archive, input.context);
    modelArchived = await restoreArchivedContextMessages(input.store, input.modelArchive, input.context);
  } catch {
    return { messages: persisted, persistedMessages: persisted, fromArchive: false };
  }
  const bestArchived = mergeModelArchiveIntoBase(archived, modelArchived, input.context);
  if (input.preferArchive === true && archived.length > 0) {
    return { messages: bestArchived.length > 0 ? bestArchived : archived, persistedMessages: persisted, fromArchive: true };
  }
  if (input.preferArchive === true && modelArchived.length > 0) {
    return { messages: modelArchived, persistedMessages: persisted, fromArchive: true };
  }
  const archiveCandidate = bestArchived.length > 0 ? bestArchived : archived.length > 0 ? archived : modelArchived;
  return archiveCandidate.length > persisted.length
    ? { messages: archiveCandidate, persistedMessages: persisted, fromArchive: true }
    : { messages: persisted, persistedMessages: persisted, fromArchive: false };
}


export function limitRestoredContextToPromptBudget(restoredContext: RestoredContextMessages, options: {
  config?: LabAgentConfig;
  model?: unknown;
  tools?: unknown;
  clearPersistedSummary?: boolean;
  contextWindow?: unknown;
} = {}): RestoredContextMessages {
  if (!restoredContext?.fromArchive) {
    return restoredContext;
  }
  const fallbackMessages = Array.isArray(restoredContext.persistedMessages)
    ? restoredContext.persistedMessages
    : [];
  if (!hasPersistedCompaction(options.contextWindow as ReturnType<typeof createContextWindow> | null | undefined) || fallbackMessages.length === 0) {
    return {
      ...restoredContext,
      clearPersistedSummary: options.clearPersistedSummary === true
    };
  }
  const contextWindow = createContextWindow(options.config ?? {});
  const estimate = estimatePromptPayload({
    model: String(options.model ?? options.config?.modelAlias ?? ""),
    messages: restoredContext.messages,
    tools: Array.isArray(options.tools) ? options.tools : [],
    toolResults: [],
    gatewayProtocol: options.config?.lab?.gatewayProtocol
  });
  if (!promptEstimateNeedsCompaction(estimate, contextWindow, options.config?.context?.promptCompactRatio)) {
    return {
      ...restoredContext,
      clearPersistedSummary: options.clearPersistedSummary === true
    };
  }
  return {
    ...restoredContext,
    messages: fallbackMessages,
    fromArchive: false,
    limited: true,
    limitReason: "restored_full_context_over_budget",
    clearPersistedSummary: false
  };
}


export function mergeModelArchiveIntoBase(baseMessages: unknown, modelMessages: unknown, context: unknown = {}) {
  const base = Array.isArray(baseMessages) ? baseMessages.filter(Boolean) : [];
  const model = Array.isArray(modelMessages) ? modelMessages.filter(Boolean) : [];
  if (model.length === 0) {
    return base;
  }
  if (base.length === 0) {
    return model;
  }
  const first = model[0];
  if (first?.role === "user") {
    const index = findLastMessageIndex(base, first);
    if (index >= 0) {
      return restorePersistedContextMessages(base.slice(0, index).concat(model), context);
    }
  }
  const overlap = largestMessageOverlap(base, model);
  return restorePersistedContextMessages(base.concat(model.slice(overlap)), context);
}


export function findLastMessageIndex(messages: unknown, target: unknown) {
  const list = Array.isArray(messages) ? messages : [];
  const key = stableMessageKey(target);
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (stableMessageKey(list[index]) === key) {
      return index;
    }
  }
  return -1;
}


export function largestMessageOverlap(left: unknown, right: unknown) {
  const leftList = Array.isArray(left) ? left : [];
  const rightList = Array.isArray(right) ? right : [];
  const max = Math.min(leftList.length, rightList.length);
  for (let size = max; size > 0; size -= 1) {
    let same = true;
    for (let offset = 0; offset < size; offset += 1) {
      if (stableMessageKey(leftList[leftList.length - size + offset]) !== stableMessageKey(rightList[offset])) {
        same = false;
        break;
      }
    }
    if (same) {
      return size;
    }
  }
  return 0;
}


export function stableMessageKey(message: unknown) {
  return JSON.stringify(message ?? null);
}


export function clearPersistedContextSummary(contextWindow: ReturnType<typeof createContextWindow> | null | undefined) {
  if (!contextWindow || typeof contextWindow !== "object") {
    return contextWindow;
  }
  return {
    ...contextWindow,
    summary: "",
    compactionCount: 0,
    compactedMessages: 0,
    lastCompactedAt: null,
    lastReason: "dashboard_full_context_resume",
    lastStrategy: null,
    lastFallbackReason: null,
    lastInternalAgent: null
  };
}


export function hasPersistedCompaction(contextWindow: ReturnType<typeof createContextWindow> | null | undefined) {
  return Boolean(
    contextWindow &&
    (
      Number(contextWindow.compactionCount) > 0 ||
      Number(contextWindow.compactedMessages) > 0 ||
      String(contextWindow.summary ?? "").trim()
    )
  );
}


export async function restoreArchivedContextMessages(store: ReturnType<typeof createSessionStore> | null | undefined, archive: unknown = {}, context: unknown = {}): Promise<SessionMessage[]> {
  const normalized = normalizeTranscriptArchiveState(archive);
  if (!store?.readTranscriptChunk || normalized.chunks.length === 0) {
    return [];
  }
  const contextRecord = context && typeof context === "object" ? context as Record<string, unknown> : {};
  const maxMessages = positiveInteger(contextRecord.resumeMaxMessages, DEFAULT_RESUME_CONTEXT_MESSAGES) ?? DEFAULT_RESUME_CONTEXT_MESSAGES;
  const chunkCount = Math.max(1, Math.ceil(maxMessages / normalized.chunkSize));
  const chunks = normalized.chunks.slice(-chunkCount);
  const messages = [];
  for (const chunk of chunks) {
    const result = await store.readTranscriptChunk(normalized, chunk.index);
    if (!result.ok) {
      const error = new Error(result.error?.message ?? `Unable to read transcript chunk '${chunk.index}'`);
      Object.assign(error, { code: result.error?.code ?? "TRANSCRIPT_CHUNK_READ_ERROR" });
      throw error;
    }
    messages.push(...(Array.isArray(result.messages) ? result.messages : []));
  }
  return repairDanglingToolCallMessages(restorePersistedMessages(limitResumeContextMessages(messages, context)));
}


export function limitResumeContextMessages(messages: unknown, context: unknown = {}): SessionMessage[] {
  if (!Array.isArray(messages)) {
    return [];
  }
  const record = isPlainObject(context) ? context : {};
  const maxMessages = positiveInteger(record.resumeMaxMessages, DEFAULT_RESUME_CONTEXT_MESSAGES) ?? DEFAULT_RESUME_CONTEXT_MESSAGES;
  const maxTokens = positiveInteger(record.resumeMaxTokens, DEFAULT_RESUME_CONTEXT_TOKENS) ?? DEFAULT_RESUME_CONTEXT_TOKENS;
  const maxBytes = positiveInteger(record.resumeMaxBytes, DEFAULT_RESUME_CONTEXT_BYTES) ?? DEFAULT_RESUME_CONTEXT_BYTES;
  let kept = messages.filter(Boolean).slice(-maxMessages);
  while (kept.length > 1) {
    const bytes = estimatePersistedMessagesBytes(kept);
    if (bytes <= maxBytes && estimateTokensFromBytesLocal(bytes) <= maxTokens) {
      break;
    }
    kept = kept.slice(1);
  }
  return alignContextStartToUser(kept);
}


export function alignContextStartToUser(messages: SessionMessage[]): SessionMessage[] {
  if (messages.length <= 1 || messages[0]?.role === "user") {
    return messages;
  }
  const firstUser = messages.findIndex((message) => message?.role === "user");
  return firstUser > 0 ? messages.slice(firstUser) : messages;
}


export function estimatePersistedMessagesBytes(messages: unknown) {
  return Buffer.byteLength(JSON.stringify(messages ?? []), "utf8");
}


export function estimateTokensFromBytesLocal(bytes: unknown) {
  const number = Number(bytes);
  if (!Number.isFinite(number) || number <= 0) {
    return 0;
  }
  return Math.max(1, Math.ceil(number / 4));
}


export function sanitizeRestoredMessage(message: SessionMessage | null | undefined): SessionMessage | null {
  if (!message || message.role !== "assistant") {
    return message ?? null;
  }
  const restored: SessionMessage = {
    ...message,
    content: sanitizeRestoredContent(message.content)
  };
  const thinking = persistableThinking(message.thinking);
  if (thinking) {
    restored.thinking = thinking;
  }
  return restored;
}


export function sanitizeRestoredContent(content: unknown) {
  if (typeof content === "string") {
    return sanitizeRestoredAssistantText(content);
  }
  if (!Array.isArray(content)) {
    return content;
  }
  return content.map((item) => {
    if (typeof item === "string") {
      return sanitizeRestoredAssistantText(item);
    }
    if (item && typeof item === "object" && "text" in item) {
      return {
        ...item,
        text: sanitizeRestoredAssistantText(String(item.text ?? ""))
      };
    }
    return item;
  });
}


export function sanitizeRestoredAssistantText(value: unknown) {
  const text = String(value ?? "");
  if (!looksLikeRawOpenAIResponseDump(text)) {
    return text;
  }
  const summary = summarizeRawOpenAIResponseDump(text);
  return [
    "这条历史回复是旧版本保存的 OpenAI 兼容网关原始响应，已在恢复时折叠清理。",
    "原因：模型没有返回 content 正文，旧版本把 raw SSE JSON 当作助手正文保存。",
    summary ? `摘要：${summary}` : "",
    "建议：重新发送上一条需求，新版本会使用当前网关映射和安全 fallback。"
  ].filter(Boolean).join("\n");
}


export function looksLikeRawOpenAIResponseDump(value: unknown) {
  if (typeof value !== "string" || value.length < 5000) {
    return false;
  }
  return value.includes("\"object\":\"chat.completion.chunk\"")
    || value.includes('"object": "chat.completion.chunk"')
    || (value.includes('"raw": "data:') && value.includes("reasoning_content"));
}


export function summarizeRawOpenAIResponseDump(value: unknown) {
  try {
    const parsed = JSON.parse(String(value ?? ""));
    const bytes = Buffer.byteLength(String(parsed.raw ?? ""), "utf8");
    const model = typeof parsed.model === "string" ? parsed.model : "";
    return [model ? `model=${model}` : "", bytes ? `rawBytes=${bytes}` : ""].filter(Boolean).join(", ");
  } catch {
    return "";
  }
}


export function persistableContextWindow(contextWindow?: ReturnType<typeof createContextWindow> | null) {
  return {
    summary: redactPersistedText(contextWindow?.summary ?? ""),
    compactionCount: Number.isFinite(contextWindow?.compactionCount) ? Number(contextWindow?.compactionCount) : 0,
    compactedMessages: Number.isFinite(contextWindow?.compactedMessages) ? Number(contextWindow?.compactedMessages) : 0,
    lastCompactedAt: contextWindow?.lastCompactedAt ?? null,
    lastReason: contextWindow?.lastReason ?? null,
    lastStrategy: contextWindow?.lastStrategy ?? null,
    lastFallbackReason: contextWindow?.lastFallbackReason ?? null,
    lastInternalAgent: contextWindow?.lastInternalAgent ?? null
  };
}


export function redactPersistedText(value: unknown) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]")
    .replace(/(^|[\s"'`])(--?(?:api-?key|token|secret|password|credential|authorization)(?:=|\s+))\S+/gi, "$1$2[redacted]")
    .replace(/\b([A-Za-z0-9_.-]*(?:api[-_]?key|token|secret|password|credential|authorization)[A-Za-z0-9_.-]*\s*(?:=|:|\bis\b)\s*)\S+/gi, "$1[redacted]")
    .replace(/([?&](?:api[-_]?key|token|secret|password|credential|authorization)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]");
}


export function makeSessionTitle(value: unknown) {
  const text = redactPersistedText(value).replace(/\s+/g, " ").trim();
  if (!text) {
    return null;
  }
  return text.length <= 80 ? text : `${text.slice(0, 77)}...`;
}


export function positiveInteger(value: unknown, fallback: number | null = 1): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}


export function nonNegativeInteger(value: unknown, fallback: number | null = 0): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

/**
 * @param {{ session: AgentSession; sessionStore: ReturnType<typeof createSessionStore>; metadata: Record<string, any>; eventOptions: Record<string, any>; prompt?: string; env?: NodeJS.ProcessEnv; hooksTrusted?: boolean; reason: string; draft?: ReturnType<typeof createInterruptedDraftCapture> }} options
 */


/**
 * @param {{ session: AgentSession; sessionStore: ReturnType<typeof createSessionStore>; metadata: Record<string, any>; eventOptions: Record<string, any>; prompt?: string; env?: NodeJS.ProcessEnv; hooksTrusted?: boolean; reason: string; draft?: ReturnType<typeof createInterruptedDraftCapture> }} options
 */
export async function finishInterruptedTurn(options: { session: AgentSession; sessionStore: ReturnType<typeof createSessionStore>; metadata: Record<string, unknown>; eventOptions: Record<string, unknown>; prompt?: string; displayPrompt?: string; env?: NodeJS.ProcessEnv; hooksTrusted?: boolean; reason: string; draft?: ReturnType<typeof createInterruptedDraftCapture> }) {
  const draft = normalizeInterruptedDraft(options.draft);
  const finalOutput = draft
    ? [
      "Turn interrupted by the local user.",
      "",
      "Interrupted assistant draft saved:",
      draft.text
    ].join("\n")
    : "Turn interrupted by the local user.";
  if (draft) {
    options.metadata.interruptedDraft = {
      textBytes: draft.bytes,
      thinkingBytes: draft.thinkingBytes,
      reason: options.reason
    };
    appendInterruptedDraftMessages(options.session, String(options.prompt ?? ""), options.displayPrompt ?? options.prompt, draft, options.reason);
    await emitEvent(options.eventOptions, {
      type: "assistant_interrupted_draft",
      reason: options.reason,
      text: draft.text,
      outputBytes: draft.bytes,
      thinking: draft.thinking,
      thinkingBytes: draft.thinkingBytes
    });
  }
  await emitEvent(options.eventOptions, {
    type: "turn_interrupted",
    reason: options.reason,
    draftText: draft?.text ?? "",
    draftBytes: draft?.bytes ?? 0,
    draftThinking: draft?.thinking ?? "",
    draftThinkingBytes: draft?.thinkingBytes ?? 0,
    outputBytes: Buffer.byteLength(finalOutput, "utf8")
  });
  await persistSessionMetadata(options.sessionStore, options.metadata, finalOutput, "interrupted", options.session, {
    env: options.env,
    hooksTrusted: options.hooksTrusted
  });
  await emitEvent(options.eventOptions, {
    type: "turn_complete",
    status: "interrupted",
    outputBytes: Buffer.byteLength(finalOutput, "utf8")
  });
  return {
    session: options.session,
    output: finalOutput,
    interrupted: true
  };
}


export function createInterruptedDraftCapture() {
  return {
    text: "",
    thinking: "",
    thinkingBytes: 0
  };
}


export function captureInterruptedDraftEvent(capture: { text: string; thinking: string; thinkingBytes: number } | null | undefined, event: Record<string, unknown>) {
  if (!capture || !event || typeof event !== "object") {
    return;
  }
  if (event.type === "assistant_delta") {
    capture.text += String(event.text ?? "");
    return;
  }
  if (event.type === "assistant_thinking_delta") {
    const text = String(event.text ?? "");
    capture.thinking += text;
    capture.thinkingBytes += Number(event.bytes ?? Buffer.byteLength(text, "utf8"));
  }
}


export function normalizeInterruptedDraft(draft: { text?: unknown; thinking?: unknown; thinkingBytes?: unknown } | null | undefined) {
  const text = String(draft?.text ?? "");
  const thinkingPreview = limitThinkingPreview(String(draft?.thinking ?? ""));
  const bytes = Buffer.byteLength(text, "utf8");
  const thinkingBytes = Number.isFinite(Number(draft?.thinkingBytes))
    ? Number(draft?.thinkingBytes)
    : thinkingPreview.bytes;
  if (!text.trim()) {
    return null;
  }
  return {
    text,
    bytes,
    thinking: thinkingPreview.text,
    thinkingBytes
  };
}


export function appendFailedGatewayDraft(options: {
  draft?: { text?: unknown; thinking?: unknown; thinkingBytes?: unknown } | null;
  metadata?: Record<string, unknown>;
  session: AgentSession;
  prompt: string;
  displayPrompt?: string;
  reason: string;
}) {
  const draft = normalizeInterruptedDraft(options.draft);
  if (!draft) {
    return null;
  }
  if (options.metadata) {
    options.metadata.interruptedDraft = {
      textBytes: draft.bytes,
      thinkingBytes: draft.thinkingBytes,
      reason: options.reason
    };
  }
  appendInterruptedDraftMessages(options.session, options.prompt, options.displayPrompt ?? options.prompt, draft, options.reason);
  return {
    ...draft,
    reason: options.reason
  };
}


export function appendInterruptedDraftMessages(session: AgentSession, prompt: string, displayPrompt: unknown, draft: { text?: unknown; thinking?: unknown; thinkingBytes?: unknown }, reason: string) {
  const note = [
    "[中断草稿，非最终回复]",
    `原因：${reason}`,
    "",
    String(draft.text ?? "")
  ].join("\n");
  const assistantMessage: SessionMessage = {
    role: "assistant",
    content: [{ type: "text", text: note }],
    interruptedDraft: true
  };
  const thinking = normalizeAssistantThinking({
    text: draft.thinking,
    bytes: draft.thinkingBytes,
    source: "gateway-interrupted"
  });
  if (thinking) {
    assistantMessage.thinking = thinking;
  }
  if (typeof prompt === "string" && prompt.trim()) {
    const userMessage = persistableUserTurnMessage(prompt);
    session.messages.push(userMessage);
    appendModelContextArchiveMessages(session, [userMessage]);
  }
  session.messages.push(assistantMessage);
  appendModelContextArchiveMessages(session, [assistantMessage]);
  appendTranscriptMessages(session, [
    ...(typeof displayPrompt === "string" && displayPrompt.trim() ? [{ role: "user", content: displayPrompt }] : []),
    assistantMessage
  ]);
}

/**
 * @param {import("../model-gateway/protocol.ts").GatewayToolCall[]} calls
 * @param {Array<Record<string, any>>} results
 */


/**
 * @param {import("../model-gateway/protocol.ts").GatewayToolCall[]} calls
 * @param {Array<Record<string, any>>} results
 */
export function summarizeToolCalls(calls: import("../model-gateway/protocol.ts").GatewayToolCall[], results: Array<Record<string, unknown>>) {
  return calls.map((call, index: number) => {
    const result = parseToolResult(results[index]?.content);
    return {
      id: call.id,
      name: call.name,
      inputKeys: Object.keys(call.input ?? {}).sort(),
      ok: result.ok === true,
      blocked: result.blocked === true,
      interrupted: results[index]?.interrupted === true || result.interrupted === true,
      decision: result.decision?.decision ?? null,
      truncated: Boolean(results[index]?.truncated)
    };
  });
}

/**
 * @param {import("../model-gateway/protocol.ts").GatewayToolCall[]} calls
 */


/**
 * @param {import("../model-gateway/protocol.ts").GatewayToolCall[]} calls
 */
export function summarizeToolCallRequests(calls: import("../model-gateway/protocol.ts").GatewayToolCall[]) {
  return calls.map((call) => ({
    id: call.id,
    name: call.name,
    inputKeys: Object.keys(call.input ?? {}).sort()
  }));
}

/**
 * @param {AgentSession} session
 * @param {Record<string, any>} options
 */


/**
 * @param {AgentSession} session
 * @param {Record<string, any>} options
 */
export function withAntEventOptions(session: AgentSession, options: Record<string, unknown>) {
  if (!options.onAntEvent) {
    return options;
  }
  return {
    ...options,
    antEventNormalizer: createAntEventNormalizer({ sessionId: session.id })
  };
}

/**
 * @param {{ onEvent?: (event: SessionEvent) => void | Promise<void>; onAntEvent?: (event: Record<string, any>) => void | Promise<void>; antEventNormalizer?: ReturnType<typeof createAntEventNormalizer> }} options
 * @param {SessionEvent} event
 */


/**
 * @param {{ onEvent?: (event: SessionEvent) => void | Promise<void>; onAntEvent?: (event: Record<string, any>) => void | Promise<void>; antEventNormalizer?: ReturnType<typeof createAntEventNormalizer> }} options
 * @param {SessionEvent} event
 */
export async function emitEvent(options: { onEvent?: (event: SessionEvent) => void | Promise<void>; onAntEvent?: (event: Record<string, unknown>) => void | Promise<void>; antEventNormalizer?: ReturnType<typeof createAntEventNormalizer> }, event: SessionEvent | Record<string, unknown>) {
  const legacyEvent = {
    at: new Date().toISOString(),
    ...event
  };
  if (options.onEvent) {
    await options.onEvent(legacyEvent);
  }
  if (options.onAntEvent && options.antEventNormalizer) {
    for (const antEvent of options.antEventNormalizer.normalize(legacyEvent)) {
      await options.onAntEvent(antEvent);
    }
  }
}

/**
 * @param {{ onEvent?: (event: SessionEvent) => void | Promise<void>; onAntEvent?: (event: Record<string, any>) => void | Promise<void>; antEventNormalizer?: ReturnType<typeof createAntEventNormalizer> }} options
 * @param {Record<string, any>} event
 * @param {number} round
 */


/**
 * @param {{ onEvent?: (event: SessionEvent) => void | Promise<void>; onAntEvent?: (event: Record<string, any>) => void | Promise<void>; antEventNormalizer?: ReturnType<typeof createAntEventNormalizer> }} options
 * @param {Record<string, any>} event
 * @param {number} round
 */
export async function emitGatewayStreamEvent(options: { onEvent?: (event: SessionEvent) => void | Promise<void>; onAntEvent?: (event: Record<string, unknown>) => void | Promise<void>; antEventNormalizer?: ReturnType<typeof createAntEventNormalizer> }, event: Record<string, unknown>, round: number) {
  if (event.type === "gateway_retry") {
    await emitEvent(options, {
      type: "gateway_retry",
      round,
      attempt: event.attempt ?? null,
      maxAttempts: event.maxAttempts ?? null,
      delayMs: event.delayMs ?? null,
      stage: event.stage ?? null,
      error: event.error ?? null
    });
    return;
  }
  if (event.type === "message_start") {
    await emitEvent(options, {
      type: "gateway_stream_start",
      round,
      messageId: event.id ?? null,
      model: event.model ?? null
    });
    return;
  }
  if (event.type === "text_delta" && typeof event.text === "string" && event.text.length > 0) {
    await emitEvent(options, {
      type: "assistant_delta",
      round,
      text: event.text,
      bytes: Buffer.byteLength(event.text, "utf8")
    });
    return;
  }
  if (event.type === "thinking_delta" && typeof event.text === "string" && event.text.length > 0) {
    await emitEvent(options, {
      type: "assistant_thinking_delta",
      round,
      text: event.text,
      bytes: Buffer.byteLength(event.text, "utf8")
    });
    return;
  }
  if (event.type === "tool_call_delta") {
    await emitEvent(options, {
      type: "tool_call_delta",
      round,
      index: Number.isInteger(event.index) ? event.index : null,
      id: typeof event.id === "string" ? event.id : null,
      nameDelta: typeof event.nameDelta === "string" ? event.nameDelta : "",
      argumentsDelta: typeof event.argumentsDelta === "string" ? event.argumentsDelta : ""
    });
    return;
  }
  if (event.type === "message_stop") {
    await emitEvent(options, {
      type: "gateway_stream_stop",
      round,
      stopReason: typeof event.stopReason === "string" ? event.stopReason : null
    });
  }
}

/**
 * @param {unknown} content
 */


/**
 * @param {unknown} content
 */
export function parseToolResult(content: unknown) {
  if (typeof content !== "string") {
    return {};
  }
  try {
    return JSON.parse(content);
  } catch {
    return {};
  }
}

type ThinkingRoundCapture = {
  text: string;
  bytes: number;
  truncated: boolean;
};

type ThinkingCapture = {
  byRound: Map<number, ThinkingRoundCapture>;
};


export function createThinkingCapture(): ThinkingCapture {
  return {
    byRound: new Map()
  };
}


export function captureThinkingEvent(capture: ThinkingCapture, event: Record<string, unknown>) {
  if (!capture || event?.type !== "assistant_thinking_delta") {
    return;
  }
  const round = Number.isFinite(Number(event.round)) ? Number(event.round) : 0;
  const text = String(event.text ?? "");
  if (!text) {
    return;
  }
  const current = capture.byRound.get(round) ?? { text: "", bytes: 0, truncated: false };
  const bytes = Number(event.bytes) || Buffer.byteLength(text, "utf8");
  const preview = appendThinkingPreview(current.text, text);
  capture.byRound.set(round, {
    text: preview.text,
    bytes: current.bytes + bytes,
    truncated: current.truncated || preview.truncated || event.truncated === true
  });
}


export function thinkingForRound(capture: ThinkingCapture, round: unknown, data: Record<string, unknown> = {}) {
  const captured = capture.byRound.get(Number(round));
  const fallback = typeof data.thinkingText === "string" ? data.thinkingText : extractThinkingFromGatewayRaw(data.raw);
  const preview = captured
    ? { text: captured.text, bytes: captured.bytes, truncated: captured.truncated }
    : limitThinkingPreview(fallback);
  const raw = isPlainObject(data.raw) ? data.raw : {};
  const reportedBytes = Number(raw.thinkingBytes ?? 0);
  const bytes = Math.max(preview.bytes, reportedBytes);
  if (!preview.text && bytes <= 0) {
    return null;
  }
  return {
    text: preview.text,
    bytes,
    source: "gateway",
    truncated: preview.truncated || Boolean(raw.thinkingTruncated),
    persistedAt: new Date().toISOString()
  };
}


export function normalizeAssistantThinking(value: unknown) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const preview = limitThinkingPreview(String(record.text ?? ""));
  const bytes = Number.isFinite(Number(record.bytes))
    ? Number(record.bytes)
    : preview.bytes;
  if (!preview.text && bytes <= 0) {
    return null;
  }
  return {
    text: preview.text,
    bytes,
    truncated: record.truncated === true || preview.truncated,
    source: typeof record.source === "string" ? record.source : "gateway",
    persistedAt: typeof record.persistedAt === "string" ? record.persistedAt : new Date().toISOString()
  };
}


export function extractThinkingFromGatewayRaw(raw: unknown) {
  if (!isPlainObject(raw)) {
    return "";
  }
  const choices = Array.isArray(raw.choices) ? raw.choices : [];
  const choice = choices[0];
  const message = isPlainObject(choice) ? choice.message : null;
  return firstThinkingText(isPlainObject(message) ? message : raw);
}


export function firstThinkingText(value: unknown) {
  if (!value || typeof value !== "object") {
    return "";
  }
  const record = value as Record<string, unknown>;
  for (const key of ["reasoning_content", "thinking", "thought", "reasoning"]) {
    const field = record[key];
    if (typeof field === "string" && field.length > 0) {
      return field;
    }
  }
  return "";
}
