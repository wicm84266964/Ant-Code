import { resolveModelContextTokens } from "../model-gateway/models.js";
import { createOpenAIChatCompletionRequest } from "../model-gateway/openai-chat.js";
import { createGatewayRequest } from "../model-gateway/protocol.js";
import { createInternalAgentRequest } from "../agents/internal.js";
import { runHooks } from "../hooks/runner.js";
import { normalizeProviderUsageAggregate } from "./provider-usage.js";

const DEFAULT_MAX_MESSAGES = 100000;
const DEFAULT_MAX_TOKENS = 200000;
const DEFAULT_MAX_BYTES = DEFAULT_MAX_TOKENS * 4;
const DEFAULT_TOKEN_BYTES = 4;
const DEFAULT_KEEP_MESSAGES = 8;
const DEFAULT_SUMMARY_BYTES = 64 * 1024;
const MESSAGE_SNIPPET_CHARS = 280;
const MODEL_COMPACT_MAX_INPUT_CHARS = 240_000;
const MODEL_COMPACT_MAX_MESSAGE_CHARS = 8_000;
const MODEL_COMPACT_SPINE_CHARS = 64_000;
const DEFAULT_TAIL_TURNS = 2;
const DEFAULT_PRESERVE_RECENT_TOKENS = 8_000;

/**
 * @param {Record<string, any>} config
 */
export function createContextWindow(config = {}) {
  const context = config.context ?? {};
  const maxMessages = positiveInteger(context.maxMessages, DEFAULT_MAX_MESSAGES);
  const maxBytes = positiveInteger(context.maxBytes, DEFAULT_MAX_BYTES);
  const modelMaxTokens = positiveIntegerOrNull(context.modelMaxTokens) ?? resolveModelContextTokens(config);
  const maxTokens = positiveInteger(context.maxTokens, modelMaxTokens ?? DEFAULT_MAX_TOKENS);
  const keepRecentMessages = Math.min(
    positiveInteger(context.keepRecentMessages, DEFAULT_KEEP_MESSAGES),
    Math.max(1, maxMessages)
  );

  return {
    maxMessages,
    maxBytes,
    maxTokens,
    modelMaxTokens,
    keepRecentMessages,
    tailTurns: positiveInteger(context.tailTurns ?? context.tail_turns, DEFAULT_TAIL_TURNS),
    preserveRecentTokens: positiveInteger(
      context.preserveRecentTokens ?? context.preserve_recent_tokens,
      DEFAULT_PRESERVE_RECENT_TOKENS
    ),
    summaryBytes: positiveInteger(context.summaryBytes, DEFAULT_SUMMARY_BYTES),
    summary: "",
    compactionCount: 0,
    compactedMessages: 0,
    lastCompactedAt: null,
    lastReason: null,
    lastStrategy: null,
    lastFallbackReason: null,
    lastInternalAgent: null
  };
}

/**
 * @param {{ config?: Record<string, any>; messages?: Array<Record<string, any>>; contextWindow?: ReturnType<typeof createContextWindow> }} session
 * @param {{ force?: boolean; reason?: string; keepRecentMessages?: number }} options
 */
export function compactSessionContext(session, options = {}) {
  session.contextWindow ??= createContextWindow(session.config ?? {});
  const window = session.contextWindow;
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const bytes = estimateMessagesBytes(messages);
  const tokens = estimateMessagesTokens(messages);
  const overBudget = messages.length > window.maxMessages || bytes > window.maxBytes || tokens >= window.maxTokens;

  if (!options.force && !overBudget) {
    return {
      compacted: false,
      reason: options.reason ?? "within_budget",
      beforeMessages: messages.length,
      afterMessages: messages.length,
      beforeBytes: bytes,
      afterBytes: bytes,
      beforeTokens: tokens,
      afterTokens: tokens,
      summaryBytes: Buffer.byteLength(window.summary ?? "", "utf8"),
      strategy: "none"
    };
  }

  const keepCount = selectRecentConversationContext(messages, window, options).keepCount;
  const splitAt = messages.length - keepCount;
  if (splitAt <= 0) {
    return {
      compacted: false,
      reason: "nothing_to_compact",
      beforeMessages: messages.length,
      afterMessages: messages.length,
      beforeBytes: bytes,
      afterBytes: bytes,
      beforeTokens: tokens,
      afterTokens: tokens,
      summaryBytes: Buffer.byteLength(window.summary ?? "", "utf8"),
      strategy: "none"
    };
  }

  const plan = createCompactionPlan(session, options, { bytes, tokens, keepCount, splitAt });
  const olderMessages = plan.olderMessages;
  const recentMessages = plan.recentMessages;
  const mergedSummary = mergeSummaries(window.summary, summarizeMessages(olderMessages), window.summaryBytes);
  session.messages = recentMessages;
  window.summary = mergedSummary;
  window.compactionCount += 1;
  window.compactedMessages += olderMessages.length;
  window.lastCompactedAt = new Date().toISOString();
  window.lastReason = options.reason ?? (overBudget ? "budget" : "manual");
  window.lastStrategy = "local";
  window.lastFallbackReason = null;
  window.lastInternalAgent = null;

  return {
    compacted: true,
    reason: window.lastReason,
    strategy: "local",
    beforeMessages: messages.length,
    afterMessages: recentMessages.length,
    beforeBytes: bytes,
    afterBytes: estimateMessagesBytes(recentMessages),
    beforeTokens: tokens,
    afterTokens: estimateMessagesTokens(recentMessages),
    summaryBytes: Buffer.byteLength(window.summary, "utf8")
  };
}

/**
 * @param {{ config?: Record<string, any>; id?: string; messages?: Array<Record<string, any>>; contextWindow?: ReturnType<typeof createContextWindow> }} session
 * @param {{ force?: boolean; reason?: string; keepRecentMessages?: number; gateway?: { configured?: boolean; sendChat?: (request: Record<string, any>) => Promise<Record<string, any>> }; signal?: AbortSignal; onBeforeCompact?: (payload: Record<string, any>) => void | Promise<void> }} options
 */
export async function compactSessionContextWithModel(session, options = {}) {
  session.contextWindow ??= createContextWindow(session.config ?? {});
  const window = session.contextWindow;
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const bytes = estimateMessagesBytes(messages);
  const tokens = estimateMessagesTokens(messages);
  const overBudget = messages.length > window.maxMessages || bytes > window.maxBytes || tokens >= window.maxTokens;
  const beforePayload = {
    reason: options.reason ?? (overBudget ? "budget" : "manual"),
    force: options.force === true,
    beforeMessages: messages.length,
    beforeBytes: bytes,
    beforeTokens: tokens,
    maxMessages: window.maxMessages,
    maxBytes: window.maxBytes,
    maxTokens: window.maxTokens
  };

  if (!options.force && !overBudget) {
    const result = {
      compacted: false,
      reason: options.reason ?? "within_budget",
      beforeMessages: messages.length,
      afterMessages: messages.length,
      beforeBytes: bytes,
      afterBytes: bytes,
      beforeTokens: tokens,
      afterTokens: tokens,
      summaryBytes: Buffer.byteLength(window.summary ?? "", "utf8"),
      strategy: "none"
    };
    await emitCompactAfterHook(session, options, beforePayload, result);
    return result;
  }

  const keepCount = selectRecentConversationContext(messages, window, options).keepCount;
  const splitAt = messages.length - keepCount;
  if (splitAt <= 0) {
    const result = {
      compacted: false,
      reason: "nothing_to_compact",
      beforeMessages: messages.length,
      afterMessages: messages.length,
      beforeBytes: bytes,
      afterBytes: bytes,
      beforeTokens: tokens,
      afterTokens: tokens,
      summaryBytes: Buffer.byteLength(window.summary ?? "", "utf8"),
      strategy: "none"
    };
    await emitCompactAfterHook(session, options, beforePayload, result);
    return result;
  }

  const beforeHook = await runHooks({
    config: session.config,
    cwd: session.cwd,
    env: options.env,
    hooksTrusted: options.hooksTrusted,
    event: "compact.before",
    sessionId: session.id,
    payload: beforePayload
  });
  if (beforeHook.blocked) {
    const result = {
      compacted: false,
      reason: "blocked_by_hook",
      beforeMessages: messages.length,
      afterMessages: messages.length,
      beforeBytes: bytes,
      afterBytes: bytes,
      beforeTokens: tokens,
      afterTokens: tokens,
      summaryBytes: Buffer.byteLength(window.summary ?? "", "utf8"),
      strategy: "none",
      error: beforeHook.blockingError
    };
    await emitCompactAfterHook(session, options, beforePayload, result);
    return result;
  }

  if (typeof options.onBeforeCompact === "function") {
    await options.onBeforeCompact(beforePayload);
  }

  const gateway = options.gateway;
  if (!gateway?.configured || typeof gateway.sendChat !== "function") {
    const result = fallbackLocalCompaction(session, options, "gateway_not_configured");
    await emitCompactAfterHook(session, options, beforePayload, result);
    return result;
  }

  const plan = createCompactionPlan(session, options, { bytes, tokens, keepCount, splitAt });
  const request = buildModelCompactionRequest(session, plan);
  let response;
  try {
    response = await gateway.sendChat({
      messages: request.messages,
      tools: request.tools ?? [],
      toolResults: request.toolResults ?? [],
      sessionId: session.id,
      stream: false,
      signal: options.signal
    });
  } catch (error) {
    const result = fallbackLocalCompaction(session, options, `model_compaction_exception:${error instanceof Error ? error.message : String(error)}`);
    await emitCompactAfterHook(session, options, beforePayload, result);
    return result;
  }

  if (!response?.ok) {
    const code = response?.error?.code ?? "model_compaction_failed";
    const result = fallbackLocalCompaction(session, options, code);
    await emitCompactAfterHook(session, options, beforePayload, result);
    return result;
  }

  const summaryText = String(response.data?.text ?? "").trim();
  if (!summaryText) {
    const result = fallbackLocalCompaction(session, options, "model_compaction_empty");
    await emitCompactAfterHook(session, options, beforePayload, result);
    return result;
  }

  const result = applyModelCompactionSummary(session, plan, summaryText, {
    reason: options.reason ?? (overBudget ? "budget" : "manual"),
    model: response.data?.model ?? null
  });
  await emitCompactAfterHook(session, options, beforePayload, result);
  return result;
}

/**
 * @param {{ config?: Record<string, any>; messages?: Array<Record<string, any>>; contextWindow?: ReturnType<typeof createContextWindow> }} session
 */
export function clearSessionContext(session) {
  session.messages = [];
  session.contextWindow = createContextWindow(session.config ?? {});
  return summarizeContextWindow(session);
}

/**
 * @param {{ contextWindow?: ReturnType<typeof createContextWindow> }} session
 */
export function buildCompactedContextMessage(session) {
  const summary = session.contextWindow?.summary?.trim();
  if (!summary) {
    return null;
  }

  return {
    role: "system",
    content: [{
      type: "text",
      text: [
        "Ant Code compacted conversation context (session-local, bounded, redacted before local transcript retention):",
        summary,
        "",
        "Use this as background only. Re-read files or rerun tools when exact details matter."
      ].join("\n")
    }]
  };
}

/**
 * @param {{ config?: Record<string, any>; messages?: Array<Record<string, any>>; contextWindow?: ReturnType<typeof createContextWindow> }} session
 */
export function summarizeContextWindow(session) {
  const window = session.contextWindow ?? createContextWindow(session.config ?? {});
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const messageBytes = estimateMessagesBytes(messages);
  const summaryBytes = Buffer.byteLength(window.summary ?? "", "utf8");
  const promptEstimate = session.lastPromptEstimate && typeof session.lastPromptEstimate === "object"
    ? session.lastPromptEstimate
    : null;
  const providerUsage = normalizeProviderUsageAggregate(session.usage);
  return {
    messages: messages.length,
    messageBytes,
    messageTokens: estimateTokensFromBytes(messageBytes),
    promptBytes: Number.isFinite(promptEstimate?.bytes) ? promptEstimate.bytes : null,
    promptTokens: Number.isFinite(promptEstimate?.tokens) ? promptEstimate.tokens : null,
    promptMessageTokens: Number.isFinite(promptEstimate?.messageTokens) ? promptEstimate.messageTokens : null,
    promptToolSchemaTokens: Number.isFinite(promptEstimate?.toolSchemaTokens) ? promptEstimate.toolSchemaTokens : null,
    promptToolResultTokens: Number.isFinite(promptEstimate?.toolResultTokens) ? promptEstimate.toolResultTokens : null,
    promptRound: Number.isFinite(promptEstimate?.round) ? promptEstimate.round : null,
    promptSource: promptEstimate?.source ?? null,
    providerUsage,
    providerUsageReports: Number.isFinite(providerUsage.reports) ? providerUsage.reports : 0,
    providerPromptTokens: Number.isFinite(providerUsage.lastPromptTokens) ? providerUsage.lastPromptTokens : null,
    providerCompletionTokens: Number.isFinite(providerUsage.lastCompletionTokens) ? providerUsage.lastCompletionTokens : null,
    providerTotalTokens: Number.isFinite(providerUsage.lastTotalTokens) ? providerUsage.lastTotalTokens : null,
    providerCachedPromptTokens: Number.isFinite(providerUsage.lastCachedPromptTokens) ? providerUsage.lastCachedPromptTokens : null,
    providerPromptTokensTotal: Number.isFinite(providerUsage.promptTokens) ? providerUsage.promptTokens : null,
    providerCompletionTokensTotal: Number.isFinite(providerUsage.completionTokens) ? providerUsage.completionTokens : null,
    providerTotalTokensTotal: Number.isFinite(providerUsage.totalTokens) ? providerUsage.totalTokens : null,
    providerCachedPromptTokensTotal: Number.isFinite(providerUsage.cachedPromptTokens) ? providerUsage.cachedPromptTokens : null,
    providerRound: Number.isFinite(providerUsage.lastRound) ? providerUsage.lastRound : null,
    providerModel: providerUsage.lastModel ?? null,
    maxMessages: window.maxMessages,
    maxBytes: window.maxBytes,
    maxTokens: window.maxTokens,
    modelMaxTokens: window.modelMaxTokens ?? null,
    keepRecentMessages: window.keepRecentMessages,
    tailTurns: window.tailTurns,
    preserveRecentTokens: window.preserveRecentTokens,
    compacted: window.compactionCount,
    compactedMessages: window.compactedMessages,
    hasSummary: Boolean(window.summary),
    summaryBytes,
    summaryTokens: estimateTokensFromBytes(summaryBytes),
    lastCompactedAt: window.lastCompactedAt,
    lastReason: window.lastReason,
    lastStrategy: window.lastStrategy ?? null,
    lastFallbackReason: window.lastFallbackReason ?? null,
    lastInternalAgent: window.lastInternalAgent ?? null
  };
}

/**
 * @param {{ config?: Record<string, any>; messages?: Array<Record<string, any>>; contextWindow?: ReturnType<typeof createContextWindow> }} session
 */
export function formatContextWindowStatus(session) {
  const summary = summarizeContextWindow(session);
  return [
    `context messages: ${summary.messages}/${summary.maxMessages}`,
    `context tokens: ${summary.messageTokens}/${summary.maxTokens}`,
    `context bytes: ${summary.messageBytes}/${summary.maxBytes}`,
    summary.promptTokens ? `latest model input tokens: ${summary.promptTokens}` : null,
    Number.isFinite(summary.providerPromptTokens) ? `latest provider input tokens: ${summary.providerPromptTokens}` : null,
    `model message tokens: ${summary.messageTokens}`,
    `compactions: ${summary.compacted}`,
    `compacted messages: ${summary.compactedMessages}`,
    `summary bytes: ${summary.summaryBytes}`,
    `last strategy: ${summary.lastStrategy ?? "never"}`,
    `last compacted: ${summary.lastCompactedAt ?? "never"}`
  ].filter(Boolean).join("\n");
}

/**
 * @param {{ config?: Record<string, any>; messages?: Array<Record<string, any>>; contextWindow?: ReturnType<typeof createContextWindow> }} session
 * @param {{ keepRecentMessages?: number }} options
 * @param {{ bytes: number; tokens: number; keepCount: number; splitAt: number }} metrics
 */
function createCompactionPlan(session, options, metrics) {
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const olderMessages = messages.slice(0, metrics.splitAt);
  const recentMessages = messages.slice(metrics.splitAt);
  return {
    beforeMessages: messages.length,
    beforeBytes: metrics.bytes,
    beforeTokens: metrics.tokens,
    keepCount: metrics.keepCount,
    splitAt: metrics.splitAt,
    olderMessages,
    recentMessages,
    conversationSpine: summarizeConversationSpine(olderMessages)
  };
}

/**
 * @param {{ contextWindow?: ReturnType<typeof createContextWindow> }} session
 * @param {ReturnType<typeof createCompactionPlan>} plan
 */
function buildModelCompactionRequest(session, plan) {
  const previousSummary = session.contextWindow?.summary?.trim();
  const transcript = truncateBytesFromStart(formatMessagesForModelCompaction(plan.olderMessages), MODEL_COMPACT_MAX_INPUT_CHARS);
  const input = [
    "Compress the older conversation context below into a durable handoff summary for the next model turn.",
    "",
    "Rules:",
    "- Preserve the conversation spine: user requests and assistant final conclusions are more important than raw telemetry.",
    "- Preserve user goals, decisions, constraints, file paths, commands, validation results, unresolved bugs, and next steps.",
    "- Preserve code identifiers, command names, slash commands, model ids, config keys, and error strings exactly when useful.",
    "- Summarize large tool outputs, web fetches, file contents, logs, and repetitive progress instead of copying them verbatim.",
    "- Prefer the user's language for product-facing notes; keep technical names unchanged.",
    "- Do not invent facts. If something is uncertain, say it is uncertain.",
    "- Do not include secrets, API keys, credentials, Bearer tokens, or password/token values.",
    "- Return only the compacted summary text. Do not call tools.",
    "",
    "Required summary shape:",
    "## Goal",
    "## Conversation spine",
    "## Decisions and current state",
    "## Important files, commands, and errors",
    "## Open questions and next steps",
    "",
    previousSummary ? `Previous compacted summary:\n${previousSummary}` : "Previous compacted summary: none",
    "",
    "Conversation spine to preserve:",
    plan.conversationSpine || "[no older user/assistant conversation spine]",
    "",
    "Older messages to compact:",
    transcript
  ].join("\n");

  const internal = createInternalAgentRequest({
    profileName: "compaction",
    config: session.config,
    cwd: session.cwd,
    task: "Create a durable compacted conversation summary.",
    input,
    rules: [
      "Preserve user goals, decisions, constraints, validation results, unresolved bugs, and next steps.",
      "Prefer the user's language for product-facing notes; keep technical names unchanged.",
      "Do not invent facts. If something is uncertain, say it is uncertain."
    ]
  });

  return internal.ok
    ? internal.request
    : {
      messages: [
        {
          role: "system",
          content: [{
            type: "text",
            text: [
              "You are Ant Code's conversation context compactor.",
              "Your job is to turn older transcript messages into a concise, faithful, safe summary for future turns.",
              "Keep user requests and assistant final conclusions as the durable spine. Summarize old tool output aggressively.",
              "Never request tools. Never expose secrets."
            ].join("\n")
          }]
        },
        { role: "user", content: input }
      ],
      tools: [],
      toolResults: []
    };
}

/**
 * @param {Array<Record<string, any>>} messages
 */
function formatMessagesForModelCompaction(messages) {
  const lines = [];
  for (const [index, message] of messages.entries()) {
    const role = typeof message.role === "string" ? message.role : "unknown";
    const name = typeof message.name === "string" ? ` name=${message.name}` : "";
    const toolCalls = Array.isArray(message.toolCalls) && message.toolCalls.length > 0
      ? ` toolCalls=${message.toolCalls.map((call) => call.name).filter(Boolean).join(",") || message.toolCalls.length}`
      : "";
    const text = redactContextText(extractMessageText(message.content));
    lines.push(`Message ${index + 1} role=${role}${name}${toolCalls}`);
    lines.push(truncate(text || "[no text]", MODEL_COMPACT_MAX_MESSAGE_CHARS));
    lines.push("");
  }
  return lines.join("\n").trim() || "[no older messages]";
}

function selectRecentConversationContext(messages, window, options = {}) {
  const explicit = Number.isInteger(options.keepRecentMessages) ? options.keepRecentMessages : null;
  if (explicit !== null) {
    return {
      keepCount: Math.min(messages.length, Math.max(0, explicit)),
      reason: "explicit_keep_recent_messages"
    };
  }
  const tailTurns = Math.max(0, Number.isInteger(window.tailTurns) ? window.tailTurns : DEFAULT_TAIL_TURNS);
  const preserveTokens = Math.max(1, Number.isInteger(window.preserveRecentTokens) ? window.preserveRecentTokens : DEFAULT_PRESERVE_RECENT_TOKENS);
  const fallbackKeep = Math.min(messages.length, Math.max(0, window.keepRecentMessages));
  if (!Array.isArray(messages) || messages.length === 0 || tailTurns <= 0) {
    return { keepCount: fallbackKeep, reason: "fallback_keep_recent_messages" };
  }

  let userTurns = 0;
  let startIndex = messages.length;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      userTurns += 1;
      if (userTurns >= tailTurns) {
        startIndex = index;
        break;
      }
    }
  }
  if (userTurns < tailTurns) {
    startIndex = 0;
  }

  while (startIndex < messages.length && estimateMessagesTokens(messages.slice(startIndex)) > preserveTokens) {
    let absoluteNextUser = -1;
    for (let index = startIndex + 1; index < messages.length; index += 1) {
      if (messages[index]?.role === "user") {
        absoluteNextUser = index;
        break;
      }
    }
    if (absoluteNextUser <= startIndex) {
      startIndex += 1;
    } else {
      startIndex = absoluteNextUser;
    }
  }

  if (startIndex <= 0 && messages.length > fallbackKeep) {
    startIndex = messages.length - fallbackKeep;
  }

  const keepCount = Math.max(fallbackKeep, messages.length - startIndex);
  return {
    keepCount: Math.min(messages.length, keepCount),
    reason: "tail_turns_with_token_budget"
  };
}

function summarizeConversationSpine(messages) {
  const lines = [];
  for (const [index, message] of messages.entries()) {
    if (!message || (message.role !== "user" && message.role !== "assistant")) {
      continue;
    }
    if (message.role === "assistant" && Array.isArray(message.toolCalls) && message.toolCalls.length > 0 && !extractMessageText(message.content)) {
      continue;
    }
    const text = redactContextText(extractMessageText(message.content));
    if (!text) {
      continue;
    }
    lines.push(`- ${index + 1}. ${message.role}: ${truncate(text, 2_000)}`);
  }
  return truncateBytesFromStart(lines.join("\n"), MODEL_COMPACT_SPINE_CHARS);
}

/**
 * @param {{ messages?: Array<Record<string, any>>; contextWindow?: ReturnType<typeof createContextWindow> }} session
 * @param {ReturnType<typeof createCompactionPlan>} plan
 * @param {string} summaryText
 * @param {{ reason: string; model?: string | null }} options
 */
function applyModelCompactionSummary(session, plan, summaryText, options) {
  const window = session.contextWindow;
  const summary = truncateBytesFromStart(redactContextText(summaryText).trim(), window.summaryBytes);
  session.messages = plan.recentMessages;
  window.summary = summary;
  window.compactionCount += 1;
  window.compactedMessages += plan.olderMessages.length;
  window.lastCompactedAt = new Date().toISOString();
  window.lastReason = options.reason;
  window.lastStrategy = "agent:compaction";
  window.lastFallbackReason = null;
  window.lastInternalAgent = "compaction";

  return {
    compacted: true,
    reason: window.lastReason,
    strategy: "agent:compaction",
    internalAgent: "compaction",
    model: options.model ?? null,
    beforeMessages: plan.beforeMessages,
    afterMessages: plan.recentMessages.length,
    beforeBytes: plan.beforeBytes,
    afterBytes: estimateMessagesBytes(plan.recentMessages),
    beforeTokens: plan.beforeTokens,
    afterTokens: estimateMessagesTokens(plan.recentMessages),
    summaryBytes: Buffer.byteLength(window.summary, "utf8")
  };
}

/**
 * @param {Parameters<typeof compactSessionContext>[0]} session
 * @param {Parameters<typeof compactSessionContext>[1]} options
 * @param {string} fallbackReason
 */
function fallbackLocalCompaction(session, options, fallbackReason) {
  const result = compactSessionContext(session, options);
  if (session.contextWindow) {
    session.contextWindow.lastFallbackReason = fallbackReason;
  }
  return {
    ...result,
    fallbackReason
  };
}

async function emitCompactAfterHook(session, options, beforePayload, result) {
  return runHooks({
    config: session.config,
    cwd: session.cwd,
    env: options.env,
    hooksTrusted: options.hooksTrusted,
    event: "compact.after",
    sessionId: session.id,
    payload: {
      ...beforePayload,
      compacted: result.compacted === true,
      reason: result.reason,
      strategy: result.strategy,
      fallbackReason: result.fallbackReason ?? null,
      beforeMessages: result.beforeMessages,
      afterMessages: result.afterMessages,
      beforeBytes: result.beforeBytes,
      afterBytes: result.afterBytes,
      beforeTokens: result.beforeTokens,
      afterTokens: result.afterTokens,
      summaryBytes: result.summaryBytes,
      error: result.error ?? null
    }
  });
}

/**
 * @param {Array<Record<string, any>>} messages
 */
function summarizeMessages(messages) {
  if (messages.length === 0) {
    return "";
  }

  const lines = [
    `Compacted ${messages.length} older message(s):`
  ];

  for (const message of messages) {
    const role = typeof message.role === "string" ? message.role : "unknown";
    const toolName = typeof message.name === "string" ? ` ${message.name}` : "";
    const toolCalls = Array.isArray(message.toolCalls) && message.toolCalls.length > 0
      ? ` toolCalls=${message.toolCalls.map((call) => call.name).filter(Boolean).join(",") || message.toolCalls.length}`
      : "";

    if (role === "tool") {
      lines.push(`- tool${toolName}: resultBytes=${extractMessageText(message.content).length}${toolCalls}`);
      continue;
    }

    const text = redactContextText(extractMessageText(message.content));
    const snippet = text ? truncate(text, MESSAGE_SNIPPET_CHARS) : "[no text]";
    lines.push(`- ${role}${toolName}${toolCalls}: ${snippet}`);
  }

  return lines.join("\n");
}

/**
 * @param {unknown} value
 */
function extractMessageText(value) {
  if (typeof value === "string") {
    return normalizeWhitespace(value);
  }
  if (!Array.isArray(value)) {
    return "";
  }

  return normalizeWhitespace(value.map((item) => {
    if (typeof item === "string") {
      return item;
    }
    if (item && typeof item === "object" && "text" in item) {
      return String(item.text ?? "");
    }
    return "";
  }).filter(Boolean).join(" "));
}

/**
 * @param {string} previous
 * @param {string} next
 * @param {number} maxBytes
 */
function mergeSummaries(previous, next, maxBytes) {
  const sections = [];
  if (previous?.trim()) {
    sections.push(previous.trim());
  }
  if (next.trim()) {
    sections.push(next.trim());
  }
  return truncateBytesFromStart(sections.join("\n\n"), maxBytes);
}

/**
 * @param {Array<Record<string, any>>} messages
 */
function estimateMessagesBytes(messages) {
  return Buffer.byteLength(JSON.stringify(messagesForContextBudget(messages)), "utf8");
}

/**
 * @param {Array<Record<string, any>>} messages
 */
function estimateMessagesTokens(messages) {
  return estimateTokensFromBytes(estimateMessagesBytes(messages));
}

/**
 * @param {{ messages?: Array<Record<string, any>>; tools?: Array<Record<string, any>>; toolResults?: Array<Record<string, any>>; gatewayProtocol?: string }} input
 */
export function estimatePromptPayload(input = {}) {
  const messages = Array.isArray(input.messages) ? input.messages : [];
  const tools = Array.isArray(input.tools) ? input.tools : [];
  const toolResults = Array.isArray(input.toolResults) ? input.toolResults : [];
  const messageBytes = estimateMessagesBytes(messages);
  const toolSchemaBytes = estimateJsonBytes(tools);
  const requestBytes = estimateGatewayRequestBytes({
    model: typeof input.model === "string" ? input.model : "",
    gatewayProtocol: input.gatewayProtocol,
    messages,
    tools,
    toolResults
  });
  const toolResultBytes = estimateToolResultBytes({
    gatewayProtocol: input.gatewayProtocol,
    messages,
    toolResults
  });
  return {
    bytes: requestBytes,
    tokens: estimateTokensFromBytes(requestBytes),
    messageBytes,
    messageTokens: estimateTokensFromBytes(messageBytes),
    toolSchemaBytes,
    toolSchemaTokens: estimateTokensFromBytes(toolSchemaBytes),
    toolResultBytes,
    toolResultTokens: estimateTokensFromBytes(toolResultBytes)
  };
}

function estimateGatewayRequestBytes(input) {
  if (String(input.gatewayProtocol ?? "").trim() === "openai-chat") {
    return Buffer.byteLength(JSON.stringify(createOpenAIChatCompletionRequest({
      model: input.model ?? "",
      messages: input.messages,
      tools: input.tools,
      toolResults: input.toolResults,
      stream: false
    })), "utf8");
  }
  return Buffer.byteLength(JSON.stringify(createGatewayRequest({
    model: input.model ?? "",
    messages: input.messages,
    tools: input.tools,
    toolResults: input.toolResults,
    stream: false,
    sessionId: null
  })), "utf8");
}

function estimateToolResultBytes(input) {
  if (String(input.gatewayProtocol ?? "").trim() === "openai-chat") {
    const missingToolResults = toolResultsNotRepresentedInMessages(input.messages, input.toolResults);
    return missingToolResults.length > 0 ? estimateJsonBytes(missingToolResults) : 0;
  }
  return estimateJsonBytes(input.toolResults);
}

function toolResultsNotRepresentedInMessages(messages, toolResults) {
  const represented = new Set();
  for (const message of messages) {
    if (!message || typeof message !== "object" || message.role !== "tool") {
      continue;
    }
    const id = toolResultId(message);
    if (id) {
      represented.add(id);
    }
  }
  return toolResults.filter((result) => {
    const id = toolResultId(result);
    return !id || !represented.has(id);
  });
}

function toolResultId(value) {
  if (!value || typeof value !== "object") {
    return "";
  }
  return String(value.toolCallId ?? value.tool_call_id ?? value.id ?? "").trim();
}

function estimateJsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value ?? []), "utf8");
}

function messagesForContextBudget(messages = []) {
  if (!Array.isArray(messages)) {
    return [];
  }
  return messages.map((message) => {
    if (!message || typeof message !== "object") {
      return message;
    }
    return message;
  });
}

export function estimateTokensFromBytes(bytes) {
  const number = Number(bytes);
  if (!Number.isFinite(number) || number <= 0) {
    return 0;
  }
  return Math.max(1, Math.ceil(number / DEFAULT_TOKEN_BYTES));
}

/**
 * @param {string} value
 */
function redactContextText(value) {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]")
    .replace(/(^|[\s"'`])(--?(?:api-?key|token|secret|password|credential|authorization)(?:=|\s+))\S+/gi, "$1$2[redacted]")
    .replace(/\b([A-Za-z0-9_.-]*(?:api[-_]?key|token|secret|password|credential|authorization)[A-Za-z0-9_.-]*\s*(?:=|:|\bis\b)\s*)\S+/gi, "$1[redacted]")
    .replace(/([?&](?:api[-_]?key|token|secret|password|credential|authorization)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]");
}

/**
 * @param {string} value
 */
function normalizeWhitespace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

/**
 * @param {string} value
 * @param {number} max
 */
function truncate(value, max) {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}

/**
 * @param {string} value
 * @param {number} maxBytes
 */
function truncateBytesFromStart(value, maxBytes) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) {
    return value;
  }
  const marker = "[earlier compacted context omitted]\n";
  const markerBytes = Buffer.from(marker, "utf8");
  const budget = Math.max(0, maxBytes - markerBytes.length);
  const slice = bytes.subarray(Math.max(0, bytes.length - budget));
  return `${marker}${slice.toString("utf8").replace(/^\uFFFD+/, "")}`;
}

/**
 * @param {unknown} value
 * @param {number} fallback
 */
function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function positiveIntegerOrNull(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}
