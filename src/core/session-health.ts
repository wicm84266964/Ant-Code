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
import { compactInFlightToolMessages, DEFAULT_IN_FLIGHT_COMPACT_RATIO, isReducedToolText } from "./inflight-compaction.ts";
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
  buildTurnMessages,
  buildUserTurnMessage
} from "./session-messages.ts";
import {
  skippedInterruptedToolResult,
  createToolExecutionBatches,
  executeOneToolCall,
  createTurnChangeTracker,
  recordGatewayRoundError
} from "./session-tools.ts";
import {
  persistSessionMetadata
} from "./session-persist.ts";
import {
  emitEvent,
  extractThinkingFromGatewayRaw
} from "./session-resume.ts";


/**
 * @param {AgentSession} session
 */
export function buildSystemMessages(session: AgentSession): SessionMessage[] {
  const base = Array.isArray(session.context?.system)
    ? session.context.system.filter((line: unknown) => typeof line === "string").join("\n")
    : "";
  const parts = [base.trim()];
  if (session.goal?.enabled) {
    const goalText = String(session.goal.text ?? "").trim();
    parts.push(buildGoalSystemPromptAppendix());
    if (goalText) {
      parts.push(`Active Goal:\nstatus=${session.goal.status}\ntext=${goalText}`);
    }
  }
  const text = parts.filter(Boolean).join("\n\n");
  return text.trim()
    ? [{ role: "system", content: [{ type: "text", text }] }]
    : [];
}

/**
 * @param {import("../model-gateway/protocol.ts").NormalizedGatewayResponse} data
 */


/**
 * @param {import("../model-gateway/protocol.ts").NormalizedGatewayResponse} data
 */
export function formatAssistantOutput(data: import("../model-gateway/protocol.ts").NormalizedGatewayResponse) {
  if (data.text.trim().length > 0) {
    return data.text;
  }

  if (data.toolCalls.length > 0) {
    const names = data.toolCalls.map((call) => call.name).filter(Boolean);
    return [
      "模型本轮只返回了工具调用，没有返回正文。",
      names.length > 0 ? `工具：${names.join(", ")}` : ""
    ].filter(Boolean).join("\n");
  }

  const thinkingBytes = Number(data.raw && data.raw.thinkingBytes != null ? data.raw.thinkingBytes : 0);
  if (thinkingBytes > 0) {
    return [
      "模型本轮没有返回可展示正文。",
      `已收到 ${thinkingBytes} 字节 reasoning/thinking 流，按隐私策略未展示。`,
      "如这是网关把正文误放入 reasoning_content，请切换非 thinking 模型或修正网关映射。"
    ].join("\n");
  }

  return "模型本轮没有返回可展示正文。";
}


export function analyzeAssistantOutputHealth(data: import("../model-gateway/protocol.ts").NormalizedGatewayResponse, finalOutput: unknown, thinking: { text?: string; bytes?: number } | null | undefined) {
  const reasons = [];
  const text = String(finalOutput ?? "").trim();
  const stopReason = String(data?.stopReason ?? "").toLowerCase();
  const thinkingText = String(thinking?.text ?? "");
  const thinkingBytes = thinking && Number.isFinite(thinking.bytes) ? Number(thinking.bytes) : gatewayThinkingBytes(data);

  if (!stopReason && data?.toolCalls?.length === 0 && assistantResponseText(data).trim() === "") {
    reasons.push("missing_terminal_signal");
  }
  if (["length", "max_tokens", "token_limit", "context_length_exceeded"].includes(stopReason)) {
    reasons.push(`stop_reason:${stopReason}`);
  }
  if (text.length > 0 && data?.toolCalls?.length === 0 && thinkingBytes >= 1024 && dataTextBytes(data) === 0 && ["length", "max_tokens", "token_limit"].includes(stopReason)) {
    reasons.push("reasoning_only_length");
  }
  if (data?.toolCalls?.length === 0 && dataTextBytes(data) === 0 && thinkingBytes >= 4096 && looksLikeRepetitiveThinkingLoop(thinkingText)) {
    reasons.push("repetitive_thinking_loop");
  }
  if (text.length > 0 && text.length <= 8 && thinkingBytes >= 64) {
    reasons.push("too_short_visible_text_after_reasoning");
  }
  if (looksLikeInternalDraft(text)) {
    reasons.push("internal_draft_visible");
  }
  if (looksLikeThinkingLeak(text, thinkingText)) {
    reasons.push("thinking_leak_visible");
  }
  if (looksLikeTruncatedSentence(text)) {
    reasons.push("truncated_visible_text");
  }

  return {
    ok: reasons.length === 0,
    reasons,
    mustRetry: reasons.some((reason: string) => OUTPUT_HEALTH_RETRY_REQUIRED_REASONS.has(reason))
  };
}

/** @param {import("../model-gateway/protocol.ts").NormalizedGatewayResponse} data */


/** @param {import("../model-gateway/protocol.ts").NormalizedGatewayResponse} data */
export function assistantResponseText(data: import("../model-gateway/protocol.ts").NormalizedGatewayResponse) {
  if (typeof data?.text === "string") {
    return data.text;
  }
  return Array.isArray(data?.content)
    ? data.content.map((block) => typeof block.text === "string" ? block.text : "").join("")
    : "";
}


export async function finishIncompleteAssistantResponse(input: {
  session: AgentSession;
  sessionStore: ReturnType<typeof createSessionStore>;
  metadata: SessionTurnMetadata;
  eventOptions: {
    onEvent?: (event: SessionEvent) => void | Promise<void>;
    onAntEvent?: (event: Record<string, unknown>) => void | Promise<void>;
    antEventNormalizer?: ReturnType<typeof createAntEventNormalizer>;
  };
  round: number;
  outputHealth: { ok?: boolean; reasons?: string[]; mustRetry?: boolean };
  options: RunSessionTurnOptions;
}) {
  const error = normalizeGatewayError(null, {
    code: "UPSTREAM_STREAM_ABORTED",
    message: "Upstream model response ended before a complete assistant message",
    protocol: sessionGatewayProtocol(input.session),
    details: {
      reason: requiredOutputHealthReason(input.outputHealth),
      retryable: false,
      outputHealthReasons: input.outputHealth.reasons
    }
  });
  input.metadata.gatewayErrors.push(error.code);
  recordGatewayRoundError(input.metadata, {
    round: input.round,
    error
  });
  const output = formatGatewayError(error);
  await emitEvent(input.eventOptions, {
    type: "gateway_error",
    error,
    outputBytes: Buffer.byteLength(output, "utf8")
  });
  await persistSessionMetadata(
    input.sessionStore,
    input.metadata,
    output,
    "gateway_error",
    input.session,
    input.options
  );
  await emitEvent(input.eventOptions, {
    type: "turn_complete",
    status: "gateway_error",
    outputBytes: Buffer.byteLength(output, "utf8")
  });
  return { session: input.session, output };
}


export function requiredOutputHealthReason(outputHealth: { reasons?: string[] } | null | undefined) {
  const reasons = Array.isArray(outputHealth?.reasons) ? outputHealth.reasons : [];
  return reasons.find((reason) => OUTPUT_HEALTH_RETRY_REQUIRED_REASONS.has(reason))
    ?? reasons[0]
    ?? "output_health_failed";
}


export function shouldRetryOutputHealth(health: { ok?: boolean; mustRetry?: boolean } | null | undefined, retries: number) {
  if (!health || health.ok) {
    return false;
  }
  if (health.mustRetry) {
    return retries < OUTPUT_HEALTH_MAX_RETRIES;
  }
  return OUTPUT_HEALTH_CHECK_ENABLED && retries < OUTPUT_HEALTH_MAX_RETRIES;
}


export function buildOutputHealthRepairPrompt(health: { reasons?: string[] } | null | undefined, finalOutput: unknown) {
  const excerpt = truncateForRepairPrompt(finalOutput, 1200);
  const reasons = health?.reasons ?? [];
  const reasoningOnlyLength = reasons.includes("reasoning_only_length");
  const repetitiveThinking = reasons.includes("repetitive_thinking_loop");
  return [
    "Ant Code local output health check caught a likely malformed final response.",
    `Reasons: ${reasons.join(", ") || "unknown"}.`,
    reasoningOnlyLength
      ? "The previous model call exhausted its completion budget in reasoning/thinking without producing visible user-facing text."
      : "",
    repetitiveThinking
      ? "The previous model call repeated internal planning text in a thinking loop. Break the loop and answer directly."
      : "",
    "",
    "Rewrite the final answer for the user now.",
    "Requirements:",
    "- Return only user-facing answer text.",
    "- Produce the answer immediately and keep it concise enough to finish.",
    "- Do not expose internal planning, hidden reasoning, scratch notes, or JSON/debug dumps.",
    "- If the prior answer was cut off, continue from the available task context and produce a complete answer.",
    "- Prefer the user's language unless the user explicitly requested otherwise.",
    "- Do not call tools unless a factual answer is impossible without one.",
    "",
    "Malformed visible response excerpt:",
    excerpt || "[empty]"
  ].join("\n");
}


export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}


export function gatewayThinkingBytes(data: unknown = {}) {
  const record = isPlainObject(data) ? data : {};
  const raw = isPlainObject(record.raw) ? record.raw : {};
  const reported = Number(raw.thinkingBytes ?? raw.labAgentReasoningContentBytes ?? 0);
  if (Number.isFinite(reported) && reported > 0) {
    return reported;
  }
  const text = extractThinkingFromGatewayRaw(raw);
  return Buffer.byteLength(String(text ?? ""), "utf8");
}


export function dataTextBytes(data: Record<string, unknown> = {}) {
  const raw = isPlainObject(data.raw) ? data.raw : {};
  const reported = Number(raw.textBytes ?? 0);
  if (Number.isFinite(reported) && reported >= 0) {
    return reported;
  }
  return Buffer.byteLength(String(data?.text ?? ""), "utf8");
}


export function looksLikeInternalDraft(text: string) {
  if (!text) {
    return false;
  }
  return /^(now i need to|i need to|let me|the user wants|we need to|i should|i'll now|next i need to|my plan is)\b/i.test(text)
    || /\b(let me (?:check|inspect|read|fix|synthesize)|now i need to|the user asked me to)\b/i.test(text.slice(0, 600));
}


export function looksLikeThinkingLeak(text: string, thinkingText: unknown) {
  if (!text || !thinkingText) {
    return false;
  }
  const visible = normalizeForHealthCompare(text).slice(0, 800);
  const hidden = normalizeForHealthCompare(thinkingText).slice(0, 800);
  if (visible.length < 80 || hidden.length < 80) {
    return false;
  }
  return hidden.startsWith(visible.slice(0, 120)) || visible.startsWith(hidden.slice(0, 120));
}


export function looksLikeTruncatedSentence(text: string) {
  if (text.length < 80) {
    return false;
  }
  const lastLine = text.trim().split(/\r?\n/).pop()?.trim() ?? "";
  if (!lastLine || /[.!?。！？)`'"）\]]$/.test(lastLine)) {
    return false;
  }
  return lastLine.length <= 16 && /^[\d.\-\sA-Za-z|:，,;、（(]+$/.test(lastLine);
}


export function looksLikeRepetitiveThinkingLoop(text: string) {
  const segments = thinkingRepetitionSegments(text);
  if (segments.length < 12) {
    return false;
  }
  const counts = new Map();
  for (const segment of segments) {
    counts.set(segment, (counts.get(segment) ?? 0) + 1);
  }
  for (const count of counts.values()) {
    if (count >= 8) {
      return true;
    }
  }
  return false;
}


export function thinkingRepetitionSegments(text: string) {
  return String(text ?? "")
    .split(/\r?\n|(?<=[.!?。！？])\s+/)
    .map((part) => normalizeForHealthCompare(part).replace(/^\d+[.)、-]\s*/, ""))
    .filter((part) => part.length >= 30 && part.length <= 260);
}


export function normalizeForHealthCompare(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}


export function truncateForRepairPrompt(value: unknown, maxChars: number) {
  const text = String(value ?? "").trim();
  return text.length <= maxChars ? text : `${text.slice(0, maxChars).trimEnd()}\n...[truncated by output health check]`;
}

/**
 * @param {number} maxToolRounds
 * @param {Array<Record<string, any>>} pendingToolCalls
 */


/**
 * @param {number} maxToolRounds
 * @param {Array<Record<string, any>>} pendingToolCalls
 */
export function toolRoundLimitMessage(maxToolRounds: number | null, pendingToolCalls: Array<{ name?: string }> = []) {
  const names = pendingToolCalls
    .map((call) => call?.name)
    .filter((name): name is string => typeof name === "string" && name.length > 0);
  return [
    `工具轮次已达到当前上限（${maxToolRounds} 轮），本轮已暂停，避免模型继续无限调用工具。`,
    names.length > 0 ? `尚未执行的下一批工具：${names.join(", ")}` : "",
    "如这是预期的超长任务，可以提高 LAB_AGENT_MAX_TOOL_ROUNDS 或在 lab-agent.config.json 的 limits.maxToolRounds 中配置更大的值，然后继续要求我接着执行。"
  ].filter(Boolean).join("\n");
}


export function mainToolRoundLimitReached(maxToolRounds: number | null | undefined, round: number) {
  return Number.isInteger(maxToolRounds) && Number(maxToolRounds) > 0 && round === maxToolRounds;
}

export function contextOverflowMessage(
  estimate: { tokens?: number; bytes?: number },
  contextWindow: ReturnType<typeof createContextWindow> | null | undefined
) {
  const tokens = Number.isFinite(estimate?.tokens) ? Math.floor(Number(estimate.tokens)) : 0;
  const maxTokens = contextWindow && Number.isFinite(contextWindow.maxTokens) ? contextWindow.maxTokens : "未知";
  return [
    `当前请求在压缩历史和工具结果后仍超过上下文窗口（约 ${tokens} tokens，上限 ${maxTokens}）。`,
    "已取消本轮模型请求，避免网关返回 400。",
    "可以新开一轮、手动压缩上下文，或换更大窗口的模型后再继续。"
  ].join("");
}

type PromptBudgetInput = {
  session: AgentSession;
  prompt: string;
  messages: SessionMessage[];
  toolResults: SessionToolResult[];
  round: number;
  gateway: ReturnType<typeof createLabModelGateway>;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  hooksTrusted?: boolean;
  eventOptions: Record<string, unknown>;
  attachments?: Parameters<typeof buildUserTurnMessage>[2];
  visionAnalysisText?: string;
};

export async function preparePromptBudgetForGateway(input: PromptBudgetInput) {
  let messages: SessionMessage[] = input.messages;
  const estimateOf = (current: SessionMessage[]) => estimatePromptPayload({
    model: input.session.model,
    messages: current,
    tools: input.session.context.tools,
    toolResults: input.toolResults,
    gatewayProtocol: sessionGatewayProtocol(input.session)
  });
  const needsCompaction = (currentEstimate: ReturnType<typeof estimatePromptPayload>) => (
    promptEstimateNeedsCompaction(
      currentEstimate,
      input.session.contextWindow,
      input.session.config.context?.promptCompactRatio
    )
  );

  messages = pruneStaleInflightForGateway(input, messages);
  let estimate = estimateOf(messages);
  if (!needsCompaction(estimate)) {
    return { messages, estimate, blocked: false };
  }

  if (input.round !== 0) {
    messages = await compactInflightForGateway(input, messages, true);
    estimate = estimateOf(messages);
  }

  if (needsCompaction(estimate)) {
    messages = await compactHistoryForGateway(input, messages, estimate);
    estimate = estimateOf(messages);
  }

  if (needsCompaction(estimate)) {
    messages = await compactInflightForGateway(input, messages, true);
    estimate = estimateOf(messages);
  }

  if (promptEstimateOverBudget(estimate, input.session.contextWindow)) {
    await emitEvent(input.eventOptions, {
      type: "context_overflow",
      round: input.round + 1,
      promptBytesEstimate: estimate.bytes,
      promptTokensEstimate: estimate.tokens,
      maxBytes: input.session.contextWindow?.maxBytes ?? null,
      maxTokens: input.session.contextWindow?.maxTokens ?? null
    });
    return { messages, estimate, blocked: true };
  }

  return { messages, estimate, blocked: false };
}

async function compactHistoryForGateway(
  input: PromptBudgetInput,
  messages: SessionMessage[],
  beforeEstimate: ReturnType<typeof estimatePromptPayload>
) {
  const compaction = await compactSessionContextWithModel(input.session, {
    reason: "automatic_prompt_budget",
    force: true,
    gateway: input.gateway,
    signal: input.signal,
    env: input.env,
    hooksTrusted: input.hooksTrusted,
    onBeforeCompact: (payload: Record<string, unknown>) => emitEvent(input.eventOptions, {
      type: "context_compacting",
      reason: "automatic_prompt_budget",
      beforeMessages: payload.beforeMessages,
      beforeTokens: beforeEstimate.tokens,
      beforeBytes: payload.beforeBytes,
      maxTokens: payload.maxTokens,
      maxBytes: payload.maxBytes,
      maxMessages: payload.maxMessages
    })
  });
  if (!compaction.compacted) {
    return messages;
  }

  const rebuilt = buildTurnMessages(input.session, buildUserTurnMessage(
    input.prompt,
    input.session.workflow,
    input.attachments ?? [],
    input.visionAnalysisText ?? ""
  ));
  const nextMessages = input.round === 0
    ? rebuilt
    : [...rebuilt, ...continuationAfterLastUser(messages)];
  await emitEvent(input.eventOptions, {
    type: "context_compacted",
    beforeMessages: compaction.beforeMessages,
    afterMessages: compaction.afterMessages,
    beforeTokens: beforeEstimate.tokens,
    afterTokens: estimatePromptPayload({
      model: input.session.model,
      messages: nextMessages,
      tools: input.session.context.tools,
      toolResults: input.toolResults,
      gatewayProtocol: sessionGatewayProtocol(input.session)
    }).tokens,
    summaryBytes: compaction.summaryBytes,
    strategy: compaction.strategy,
    internalAgent: compaction.internalAgent ?? null,
    fallbackReason: compaction.fallbackReason ?? null,
    reason: "automatic_prompt_budget"
  });
  return nextMessages;
}

function pruneStaleInflightForGateway(input: PromptBudgetInput, messages: SessionMessage[]) {
  const inflight = compactInFlightToolMessages(messages as Array<Record<string, unknown>>, {
    maxTokens: input.session.contextWindow?.maxTokens,
    keepRecentTools: input.session.config.context?.inFlightKeepRecentTools ?? undefined,
    pruneStale: true,
    currentTurnOnly: true
  });
  if (!inflight.compacted) {
    return messages;
  }
  syncCompactedToolResults(input.toolResults, messages);
  return messages;
}

async function compactInflightForGateway(
  input: PromptBudgetInput,
  messages: SessionMessage[],
  force: boolean
) {
  const inflight = compactInFlightToolMessages(messages as Array<Record<string, unknown>>, {
    maxTokens: input.session.contextWindow?.maxTokens,
    triggerRatio: boundedContextRatio(input.session.config.context?.inFlightCompactRatio, DEFAULT_IN_FLIGHT_COMPACT_RATIO),
    keepRecentTools: input.session.config.context?.inFlightKeepRecentTools ?? undefined,
    force
  });
  if (!inflight.compacted) {
    return messages;
  }
  syncCompactedToolResults(input.toolResults, messages);
  await emitEvent(input.eventOptions, {
    type: "context_compacted",
    beforeMessages: messages.length,
    afterMessages: messages.length,
    beforeTokens: inflight.beforeTokens,
    afterTokens: inflight.afterTokens,
    compactedTools: inflight.compactedTools,
    strategy: "inflight-tools",
    reason: input.round === 0 ? "automatic_prompt_budget" : "automatic_inflight_tools"
  });
  return messages;
}

function continuationAfterLastUser(messages: SessionMessage[]) {
  let lastUser = -1;
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index]?.role === "user") {
      lastUser = index;
    }
  }
  if (lastUser < 0 || lastUser >= messages.length - 1) {
    return [];
  }
  return messages.slice(lastUser + 1);
}

function syncCompactedToolResults(toolResults: SessionToolResult[] = [], messages: SessionMessage[] = []) {
  const compacted = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "tool") {
      continue;
    }
    const id = String(message.toolCallId ?? message.tool_call_id ?? "").trim();
    if (!id) {
      continue;
    }
    const content = message.content;
    const text = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((item) => {
          if (typeof item === "string") {
            return item;
          }
          if (item && typeof item === "object" && "text" in item && typeof item.text === "string") {
            return item.text;
          }
          return "";
        }).filter(Boolean).join("\n")
        : "";
    if (isReducedToolText(text)) {
      compacted.set(id, text);
    }
  }
  for (const result of toolResults) {
    const id = String(result.toolCallId ?? "").trim();
    const text = compacted.get(id);
    if (!text) {
      continue;
    }
    result.content = text;
    result.truncated = true;
  }
}


export function promptEstimateNeedsCompaction(
  estimate: { tokens?: number; bytes?: number },
  contextWindow: ReturnType<typeof createContextWindow> | null | undefined,
  ratioValue: unknown
) {
  const ratio = boundedContextRatio(ratioValue, DEFAULT_PROMPT_COMPACT_RATIO);
  const maxTokens = contextWindow && Number.isFinite(contextWindow.maxTokens)
    ? Math.floor(contextWindow.maxTokens * ratio)
    : null;
  const maxBytes = contextWindow && Number.isFinite(contextWindow.maxBytes)
    ? Math.floor(contextWindow.maxBytes * ratio)
    : null;
  return Boolean(
    (maxTokens && (estimate.tokens ?? 0) >= maxTokens) ||
    (maxBytes && (estimate.bytes ?? 0) >= maxBytes)
  );
}


export function promptEstimateOverBudget(
  estimate: { tokens?: number; bytes?: number },
  contextWindow: ReturnType<typeof createContextWindow> | null | undefined
) {
  const maxTokens = contextWindow && Number.isFinite(contextWindow.maxTokens) ? contextWindow.maxTokens : null;
  const maxBytes = contextWindow && Number.isFinite(contextWindow.maxBytes) ? contextWindow.maxBytes : null;
  return Boolean(
    (maxTokens && (estimate.tokens ?? 0) >= maxTokens) ||
    (maxBytes && (estimate.bytes ?? 0) >= maxBytes)
  );
}


export function boundedContextRatio(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number <= 1 ? number : fallback;
}


export function sessionGatewayProtocol(session: AgentSession) {
  return session?.config?.lab?.gatewayProtocol ?? "openai-chat";
}

/**
 * @param {import("../model-gateway/protocol.ts").GatewayToolCall[]} toolCalls
 * @param {ReturnType<typeof createToolRuntime>} toolRuntime
 * @param {{ onEvent?: (event: SessionEvent) => void | Promise<void>; signal?: AbortSignal; delegationGuard?: ReturnType<typeof createDelegationGuard>; reviewGate?: ReturnType<typeof createReviewGate> }} options
 */
export async function executeToolCalls(toolCalls: import("../model-gateway/protocol.ts").GatewayToolCall[], toolRuntime: ReturnType<typeof createToolRuntime>, options: { onEvent?: (event: SessionEvent) => void | Promise<void>; signal?: AbortSignal; delegationGuard?: ReturnType<typeof createDelegationGuard>; reviewGate?: ReturnType<typeof createReviewGate>; turnChangeTracker?: ReturnType<typeof createTurnChangeTracker>; antEventNormalizer?: ReturnType<typeof createAntEventNormalizer>; onAntEvent?: (event: Record<string, unknown>) => void | Promise<void> } = {}): Promise<SessionToolResult[]> {
  const results: SessionToolResult[] = [];
  const batches = createToolExecutionBatches(toolCalls, toolRuntime);
  const agentTaskIds = new Set<string>();

  for (const batch of batches) {
    if (options.signal?.aborted) {
      results.push(...batch.calls.map((call) => skippedInterruptedToolResult(call)));
      return results;
    }
    if (batch.parallel) {
      const batchResults = await Promise.all(batch.calls.map((call) => executeOneToolCall(call, toolRuntime, options, agentTaskIds)));
      results.push(...batchResults);
      if (options.signal?.aborted) {
        return results;
      }
      continue;
    }
    for (const call of batch.calls) {
      if (options.signal?.aborted) {
        results.push(skippedInterruptedToolResult(call));
        return results;
      }
      const result = await executeOneToolCall(call, toolRuntime, options, agentTaskIds);
      results.push(result);
      if (options.signal?.aborted) {
        return results;
      }
    }
  }

  return results;
}

/**
 * @param {import("../model-gateway/protocol.ts").GatewayToolCall} call
 */
