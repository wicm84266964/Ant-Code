import { appendThinkingPreview, limitThinkingPreview } from "./thinking-budget.js";
import { redactGatewayText } from "./errors.js";
import { emptyResponse, normalizeContent } from "./protocol.js";

/**
 * Build an OpenAI Chat Completions compatible request while preserving Ant Code's
 * local-tool boundary. The model may request function calls, but execution stays
 * in the local client permission engine.
 *
 * @param {{
 *   model: string;
 *   messages: Array<Record<string, any>>;
 *   tools?: Array<Record<string, any>>;
 *   toolResults?: Array<Record<string, any>>;
 *   stream?: boolean;
 *   extraBody?: Record<string, any> | null;
 * }} input
 */
export function createOpenAIChatCompletionRequest(input) {
  const messages = normalizeOpenAIMessages(input.messages, input.toolResults ?? []);
  const request = {
    model: input.model,
    messages,
    stream: Boolean(input.stream)
  };
  if (request.stream) {
    request.stream_options = { include_usage: true };
  }
  if (isPlainObject(input.extraBody) && Object.keys(input.extraBody).length > 0) {
    Object.assign(request, cloneJsonObject(input.extraBody));
  }

  const tools = normalizeOpenAITools(input.tools ?? []);
  if (tools.length > 0) {
    request.tools = tools;
    if (input.toolChoice) {
      request.tool_choice = input.toolChoice;
    }
  }

  return request;
}

/**
 * @param {unknown} raw
 * @param {{ reasoningContentMode?: string }} [options]
 * @returns {import("./protocol.js").NormalizedGatewayResponse}
 */
export function normalizeOpenAIChatCompletionResponse(raw, options = {}) {
  if (!raw || typeof raw !== "object") {
    return emptyResponse(raw);
  }

  const value = /** @type {Record<string, any>} */ (raw);
  const choice = Array.isArray(value.choices) ? value.choices[0] : null;
  const message = choice && typeof choice === "object" ? choice.message : null;
  if (!message || typeof message !== "object") {
    return emptyResponse(raw);
  }

  const content = normalizeContent(message.content);
  const thinkingText = extractThinkingText(message);
  const visibleReasoning = visibleReasoningFallback(message, content, options);
  const normalizedContent = visibleReasoning
    ? [{ type: "text", text: visibleReasoning }]
    : content;
  const text = normalizedContent.map((block) => block.text).join("");

  return {
    id: typeof value.id === "string" ? value.id : null,
    model: typeof value.model === "string" ? value.model : null,
    content: normalizedContent,
    text,
    thinkingText,
    toolCalls: normalizeOpenAIToolCalls(message.tool_calls),
    stopReason: typeof choice.finish_reason === "string" ? choice.finish_reason : null,
    usage: isPlainObject(value.usage) ? value.usage : null,
    raw: rawWithReasoningSummary(raw, visibleReasoning)
  };
}

/**
 * Parse OpenAI-compatible streaming responses. Some local adapters also return
 * non-streaming JSON with a streaming content type, so this accepts both forms.
 *
 * @param {ReadableStream<Uint8Array> | null} body
 * @param {{ onEvent?: (event: Record<string, any>) => void | Promise<void>; reasoningContentMode?: string }} [options]
 * @returns {Promise<import("./protocol.js").NormalizedGatewayResponse>}
 */
export async function parseOpenAIChatCompletionStream(body, options = {}) {
  const aggregate = createOpenAIStreamAggregate();
  const stream = await readOpenAIStream(body, async (record) => {
    await applyOpenAIStreamRecord(aggregate, record, options.onEvent);
  }, options);
  const text = stream.text;
  const trimmed = text.trim();
  if (!trimmed) {
    return emptyResponse([]);
  }
  if (stream.records.length === 0 && (trimmed.startsWith("{") || trimmed.startsWith("["))) {
    return normalizeOpenAIChatCompletionResponse(JSON.parse(trimmed), options);
  }

  const toolCalls = Array.from(aggregate.toolCalls.values()).map((call, index) => ({
    id: call.id || `tool-${index + 1}`,
    name: call.name,
    input: parseArguments(call.arguments)
  })).filter((call) => typeof call.name === "string" && call.name.length > 0);

  const visibleReasoning = visibleReasoningFallback({
    reasoning_content: aggregate.thinking
  }, aggregate.content ? [{ type: "text", text: aggregate.content }] : [], options);
  const visibleText = aggregate.content || visibleReasoning;

  return {
    id: aggregate.id,
    model: aggregate.model,
    content: visibleText ? [{ type: "text", text: visibleText }] : [],
    text: visibleText,
    thinkingText: aggregate.thinking,
    toolCalls,
    stopReason: aggregate.finishReason,
    usage: aggregate.usage,
    raw: summarizeOpenAIStreamRaw(text, aggregate, visibleReasoning)
  };
}

function createOpenAIStreamAggregate() {
  return {
    id: null,
    model: null,
    content: "",
    thinking: "",
    thinkingBytes: 0,
    thinkingTruncated: false,
    finishReason: null,
    usage: null,
    toolCalls: new Map()
  };
}

/**
 * @param {Array<Record<string, any>>} messages
 * @param {Array<Record<string, any>>} toolResults
 */
function normalizeOpenAIMessages(messages, toolResults) {
  const normalized = [];
  const includedToolCallIds = new Set();
  for (const message of messages) {
    if (!isPlainObject(message) || typeof message.role !== "string") {
      continue;
    }
    if (message.role === "tool") {
      const toolCallId = String(message.toolCallId ?? message.tool_call_id ?? "");
      includedToolCallIds.add(toolCallId);
      normalized.push({
        role: "tool",
        tool_call_id: toolCallId,
        content: textFromContent(message.content)
      });
      continue;
    }
    if (message.role === "assistant") {
      const assistant = {
        role: "assistant",
        content: textFromContent(message.content) || null
      };
      const reasoningContent = assistantReasoningContent(message);
      if (reasoningContent) {
        assistant.reasoning_content = reasoningContent;
      }
      const toolCalls = normalizeOpenAIToolCallRequests(message.toolCalls ?? message.tool_calls);
      if (toolCalls.length > 0) {
        assistant.tool_calls = toolCalls;
      }
      normalized.push(assistant);
      continue;
    }
    if (["system", "user", "developer"].includes(message.role)) {
      normalized.push({
        role: message.role === "developer" ? "system" : message.role,
        content: message.role === "user"
          ? openAIUserContent(message.content)
          : textFromContent(message.content)
      });
    }
  }

  for (const result of toolResults) {
    if (!isPlainObject(result)) {
      continue;
    }
    const toolCallId = String(result.toolCallId ?? result.tool_call_id ?? "");
    if (includedToolCallIds.has(toolCallId)) {
      continue;
    }
    normalized.push({
      role: "tool",
      tool_call_id: toolCallId,
      content: textFromContent(result.content)
    });
  }

  return normalized;
}

/**
 * @param {Array<Record<string, any>>} tools
 */
function normalizeOpenAITools(tools) {
  return tools
    .filter((tool) => isPlainObject(tool) && typeof tool.name === "string")
    .map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: typeof tool.description === "string" ? tool.description : "",
        parameters: isPlainObject(tool.inputSchema) ? tool.inputSchema : { type: "object", properties: {} }
      }
    }));
}

function assistantReasoningContent(message) {
  if (typeof message.reasoning_content === "string" && message.reasoning_content.length > 0) {
    return limitThinkingPreview(message.reasoning_content).text;
  }
  const thinking = message.thinking;
  if (typeof thinking === "string" && thinking.length > 0) {
    return limitThinkingPreview(thinking).text;
  }
  if (isPlainObject(thinking) && typeof thinking.text === "string" && thinking.text.length > 0) {
    return limitThinkingPreview(thinking.text).text;
  }
  return "";
}

function cloneJsonObject(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * @param {unknown} value
 */
function normalizeOpenAIToolCallRequests(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item) => isPlainObject(item) && typeof item.name === "string")
    .map((item, index) => ({
      id: typeof item.id === "string" ? item.id : `tool-${index + 1}`,
      type: "function",
      function: {
        name: item.name,
        arguments: JSON.stringify(isPlainObject(item.input) ? item.input : {})
      }
    }));
}

/**
 * @param {unknown} value
 */
function normalizeOpenAIToolCalls(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item) => isPlainObject(item) && isPlainObject(item.function) && typeof item.function.name === "string")
    .map((item, index) => ({
      id: typeof item.id === "string" ? item.id : `tool-${index + 1}`,
      name: item.function.name,
      input: parseArguments(item.function.arguments)
    }));
}

/**
 * @param {unknown} value
 */
function parseArguments(value) {
  if (isPlainObject(value)) {
    return value;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return parseLastJsonObject(value);
  }
}

/**
 * Some OpenAI-compatible Claude adapters concatenate an initial empty object
 * with the final tool arguments, for example `{}{"path":"README.md"}`.
 *
 * @param {string} value
 */
function parseLastJsonObject(value) {
  const trimmed = value.trim();
  for (let index = trimmed.lastIndexOf("{"); index >= 0; index = trimmed.lastIndexOf("{", index - 1)) {
    try {
      const parsed = JSON.parse(trimmed.slice(index));
      if (isPlainObject(parsed)) {
        return parsed;
      }
    } catch {
      // Keep scanning earlier object starts.
    }
  }
  return {};
}

/**
 * @param {ReadableStream<Uint8Array> | null} body
 * @param {(record: unknown) => void | Promise<void>} onRecord
 * @param {{ signal?: AbortSignal; idleTimeoutMs?: number }} [options]
 */
async function readOpenAIStream(body, onRecord, options = {}) {
  if (!body) {
    return { text: "", records: [] };
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let lineBuffer = "";
  const records = [];

  const emitLine = async (line) => {
    let record;
    try {
      record = parseStreamingLine(line);
    } catch (error) {
      attachOpenAIStreamPreview(error, text, line);
      throw error;
    }
    if (!record) {
      return;
    }
    records.push(record);
    await onRecord(record);
  };

  const drainLines = async (final = false) => {
    const lines = lineBuffer.split(/\r?\n/);
    if (!final && !lineBuffer.endsWith("\n") && !lineBuffer.endsWith("\r")) {
      lineBuffer = lines.pop() ?? "";
    } else {
      lineBuffer = "";
    }
    for (const line of lines) {
      await emitLine(line);
    }
  };

  try {
    while (true) {
      const { value, done } = await readStreamChunk(reader, options);
      if (done) {
        break;
      }
      const chunk = decoder.decode(value, { stream: true });
      text += chunk;
      lineBuffer += chunk;
      await drainLines(false);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Reader may already be released after stream completion.
    }
  }
  const tail = decoder.decode();
  if (tail) {
    text += tail;
    lineBuffer += tail;
  }
  await drainLines(true);
  return { text, records };
}

function attachOpenAIStreamPreview(error, text, line) {
  if (!error || typeof error !== "object") {
    return;
  }
  const preview = `${String(text ?? "")}\n${String(line ?? "")}`.trim();
  error.gatewayBodyPreview = redactGatewayText(preview).slice(0, 1000);
}

function readStreamChunk(reader, options = {}) {
  const signal = options.signal;
  const idleTimeoutMs = Number.isFinite(options.idleTimeoutMs) ? Math.max(1000, Math.trunc(options.idleTimeoutMs)) : null;
  if (signal?.aborted) {
    return Promise.reject(abortError(signal.reason));
  }
  if (!idleTimeoutMs) {
    return reader.read();
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      callback(value);
    };
    const timer = setTimeout(() => {
      cancelReader(reader, timeoutError(idleTimeoutMs));
      finish(reject, timeoutError(idleTimeoutMs));
    }, idleTimeoutMs);
    const onAbort = () => {
      cancelReader(reader, signal.reason);
      finish(reject, abortError(signal.reason));
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
    reader.read().then(
      (chunk) => finish(resolve, chunk),
      (error) => finish(reject, error)
    );
  });
}

function cancelReader(reader, reason) {
  try {
    Promise.resolve(reader.cancel(reason)).catch(() => {});
  } catch {
    // Best effort.
  }
}

function abortError(reason) {
  if (reason instanceof Error) {
    return reason;
  }
  const error = new Error("stream read aborted");
  error.name = "AbortError";
  return error;
}

function timeoutError(ms) {
  const error = new Error(`Gateway stream idle timeout after ${ms}ms`);
  error.name = "AbortError";
  error.code = "GATEWAY_STREAM_IDLE_TIMEOUT";
  return error;
}

/**
 * @param {string} line
 */
function parseStreamingLine(line) {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  const payload = trimmed.startsWith("data:") ? trimmed.slice("data:".length).trim() : trimmed;
  if (!payload || payload === "[DONE]" || payload.startsWith(":")) {
    return null;
  }
  return JSON.parse(payload);
}

/**
 * @param {{ id: string | null; model: string | null; content: string; thinking: string; finishReason: string | null; usage: Record<string, any> | null; toolCalls: Map<number, Record<string, any>> }} aggregate
 * @param {unknown} record
 * @param {(event: Record<string, any>) => void | Promise<void>} [onEvent]
 */
async function applyOpenAIStreamRecord(aggregate, record, onEvent) {
  if (!isPlainObject(record)) {
    return;
  }
  if (typeof record.id === "string") {
    aggregate.id = record.id;
  }
  if (typeof record.model === "string") {
    aggregate.model = record.model;
  }
  if (isPlainObject(record.usage)) {
    aggregate.usage = record.usage;
  }
  if (typeof record.id === "string" || typeof record.model === "string") {
    await emitStreamEvent(onEvent, {
      type: "message_start",
      id: aggregate.id,
      model: aggregate.model
    });
  }

  const choice = Array.isArray(record.choices) ? record.choices[0] : null;
  if (!isPlainObject(choice)) {
    return;
  }
  if (typeof choice.finish_reason === "string") {
    aggregate.finishReason = choice.finish_reason;
  }
  if (isPlainObject(choice.message)) {
    const normalized = normalizeOpenAIChatCompletionResponse({
      id: aggregate.id,
      model: aggregate.model,
      choices: [choice]
    });
    aggregate.content += normalized.text;
    await emitThinkingFromValue(aggregate, choice.message, onEvent);
    if (normalized.text.length > 0) {
      await emitStreamEvent(onEvent, {
        type: "text_delta",
        text: normalized.text
      });
    }
    for (const [index, call] of normalized.toolCalls.entries()) {
      aggregate.toolCalls.set(index, {
        id: call.id,
        name: call.name,
        arguments: JSON.stringify(call.input)
      });
      await emitStreamEvent(onEvent, {
        type: "tool_call_delta",
        index,
        id: call.id,
        nameDelta: call.name,
        argumentsDelta: JSON.stringify(call.input)
      });
    }
    if (aggregate.finishReason) {
      await emitStreamEvent(onEvent, {
        type: "message_stop",
        stopReason: aggregate.finishReason
      });
    }
    return;
  }

  const delta = choice.delta;
  if (!isPlainObject(delta)) {
    return;
  }
  await emitThinkingFromValue(aggregate, delta, onEvent);
  if (typeof delta.content === "string") {
    aggregate.content += delta.content;
    await emitStreamEvent(onEvent, {
      type: "text_delta",
      text: delta.content
    });
  }
  if (Array.isArray(delta.tool_calls)) {
    for (const item of delta.tool_calls) {
      if (!isPlainObject(item)) {
        continue;
      }
      const index = Number.isInteger(item.index) ? item.index : aggregate.toolCalls.size;
      const current = aggregate.toolCalls.get(index) ?? { id: "", name: "", arguments: "" };
      if (typeof item.id === "string") {
        current.id = item.id;
      }
      const event = {
        type: "tool_call_delta",
        index,
        id: typeof item.id === "string" ? item.id : current.id,
        nameDelta: "",
        argumentsDelta: ""
      };
      if (isPlainObject(item.function)) {
        if (typeof item.function.name === "string") {
          current.name += item.function.name;
          event.nameDelta = item.function.name;
        }
        if (typeof item.function.arguments === "string") {
          current.arguments += item.function.arguments;
          event.argumentsDelta = item.function.arguments;
        }
      }
      aggregate.toolCalls.set(index, current);
      await emitStreamEvent(onEvent, event);
    }
  }
  if (aggregate.finishReason) {
    await emitStreamEvent(onEvent, {
      type: "message_stop",
      stopReason: aggregate.finishReason
    });
  }
}

/**
 * @param {{ thinking: string }} aggregate
 * @param {Record<string, any>} value
 * @param {(event: Record<string, any>) => void | Promise<void>} [onEvent]
 */
async function emitThinkingFromValue(aggregate, value, onEvent) {
  const text = extractThinkingText(value);
  if (!text) {
    return;
  }
  aggregate.thinkingBytes += Buffer.byteLength(text, "utf8");
  const preview = appendThinkingPreview(aggregate.thinking, text);
  aggregate.thinking = preview.text;
  aggregate.thinkingTruncated = aggregate.thinkingTruncated || preview.truncated;
  await emitStreamEvent(onEvent, {
    type: "thinking_delta",
    text,
    truncated: aggregate.thinkingTruncated
  });
}

/**
 * @param {Record<string, any>} value
 */
function extractThinkingText(value) {
  for (const key of ["reasoning_content", "thinking", "thought", "reasoning"]) {
    if (typeof value[key] === "string") {
      return value[key];
    }
  }
  if (isPlainObject(value.reasoning) && typeof value.reasoning.content === "string") {
    return value.reasoning.content;
  }
  return "";
}

/**
 * @param {Record<string, any>} message
 * @param {Array<Record<string, any>>} content
 * @param {{ reasoningContentMode?: string }} options
 */
function visibleReasoningFallback(message, content, options = {}) {
  if (options.reasoningContentMode !== "visible-when-no-content") {
    return "";
  }
  const currentText = content.map((block) => typeof block?.text === "string" ? block.text : "").join("").trim();
  if (currentText) {
    return "";
  }
  const text = extractThinkingText(message);
  return text.trim() ? text : "";
}

/**
 * @param {unknown} raw
 * @param {string} visibleReasoning
 */
function rawWithReasoningSummary(raw, visibleReasoning) {
  if (!visibleReasoning || !isPlainObject(raw)) {
    return raw;
  }
  return {
    ...raw,
    labAgentReasoningContentMode: "visible-when-no-content",
    labAgentReasoningContentBytes: Buffer.byteLength(visibleReasoning, "utf8")
  };
}

/**
 * Some OpenAI-compatible gateways expose visible assistant text in
 * `reasoning_content` when streaming. Keep that data out of the user transcript
 * fallback path; it may be private reasoning or provider-specific visible text.
 *
 * @param {string} rawText
 * @param {{ thinking: string; content: string; usage: Record<string, any> | null; toolCalls: Map<number, Record<string, any>> }} aggregate
 * @param {string} visibleReasoning
 */
function summarizeOpenAIStreamRaw(rawText, aggregate, visibleReasoning = "") {
  return {
    protocol: "openai-chat-stream",
    bytes: Buffer.byteLength(String(rawText ?? ""), "utf8"),
    thinkingBytes: Number.isFinite(aggregate.thinkingBytes)
      ? aggregate.thinkingBytes
      : Buffer.byteLength(String(aggregate.thinking ?? ""), "utf8"),
    textBytes: Buffer.byteLength(String(aggregate.content ?? ""), "utf8"),
    visibleReasoningBytes: Buffer.byteLength(String(visibleReasoning ?? ""), "utf8"),
    reasoningContentMode: visibleReasoning ? "visible-when-no-content" : "hidden",
    thinkingTruncated: aggregate.thinkingTruncated === true,
    usage: aggregate.usage,
    toolCallCount: aggregate.toolCalls.size
  };
}

/**
 * @param {(event: Record<string, any>) => void | Promise<void>} onEvent
 * @param {Record<string, any>} event
 */
async function emitStreamEvent(onEvent, event) {
  if (!onEvent) {
    return;
  }
  await onEvent(event);
}

/**
 * @param {unknown} content
 */
function textFromContent(content) {
  if (typeof content === "string") {
    return content;
  }
  return normalizeContent(content).map((block) => block.text).join("");
}

function openAIUserContent(content) {
  if (!Array.isArray(content)) {
    return textFromContent(content);
  }
  const blocks = [];
  for (const item of content) {
    if (typeof item === "string") {
      if (item) {
        blocks.push({ type: "text", text: item });
      }
      continue;
    }
    if (!isPlainObject(item)) {
      continue;
    }
    if (item.type === "text" && typeof item.text === "string") {
      blocks.push({ type: "text", text: item.text });
      continue;
    }
    if (item.type === "image") {
      const imageUrl = imageDataUrl(item);
      if (imageUrl) {
        blocks.push({
          type: "image_url",
          image_url: { url: imageUrl }
        });
      }
    }
  }
  if (blocks.length === 0) {
    return "";
  }
  return blocks.some((block) => block.type === "image_url") ? blocks : blocks.map((block) => block.text).join("");
}

function imageDataUrl(item) {
  const data = String(item.data ?? "").replace(/\s+/g, "");
  const mimeType = String(item.mimeType ?? item.mime_type ?? "").trim().toLowerCase();
  if (!data || !/^image\/[a-z0-9.+-]+$/i.test(mimeType)) {
    return "";
  }
  return `data:${mimeType};base64,${data}`;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
