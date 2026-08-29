import { appendThinkingPreview } from "./thinking-budget.js";
import { emitGatewayEvent } from "./event-callback.js";
import {
  assertGatewayStreamRecordSize,
  gatewayResponseLimitError,
  normalizeGatewayMaxResponseBytes
} from "./limits.js";
import { emptyResponse, normalizeContent } from "./protocol.js";

const RETRYABLE_RESPONSES_ERROR_CODES = new Set([
  "gateway_timeout",
  "internal_error",
  "internal_server_error",
  "overloaded",
  "overloaded_error",
  "rate_limit",
  "rate_limit_error",
  "rate_limit_exceeded",
  "rate_limited",
  "request_timeout",
  "server_error",
  "service_unavailable",
  "temporarily_unavailable",
  "timeout",
  "upstream_error",
  "upstream_unavailable"
]);

/**
 * @param {{ model: string; messages: Array<Record<string, any>>; tools?: Array<Record<string, any>>; toolResults?: Array<Record<string, any>>; stream?: boolean; extraBody?: Record<string, any> | null; reasoningEffort?: string | null }} input
 */
export function createOpenAIResponsesRequest(input) {
  const request = {
    model: input.model,
    input: normalizeResponsesInput(input.messages ?? [], input.toolResults ?? []),
    stream: Boolean(input.stream)
  };
  if (isPlainObject(input.extraBody)) {
    Object.assign(request, cloneJsonObject(input.extraBody));
  }
  if (typeof input.reasoningEffort === "string" && input.reasoningEffort.trim()) {
    request.reasoning = {
      ...(isPlainObject(request.reasoning) ? request.reasoning : {}),
      effort: input.reasoningEffort.trim()
    };
  }
  const tools = normalizeResponsesTools(input.tools ?? []);
  if (tools.length > 0) {
    request.tools = tools;
  }
  return request;
}

/**
 * @param {unknown} raw
 * @returns {import("./protocol.js").NormalizedGatewayResponse}
 */
export function normalizeOpenAIResponsesResponse(raw) {
  if (!isPlainObject(raw)) {
    return emptyResponse(raw);
  }
  assertResponsesSucceeded(raw);
  const content = [];
  const thinking = [];
  const toolCalls = [];
  let refused = false;
  for (const item of Array.isArray(raw.output) ? raw.output : []) {
    if (!isPlainObject(item)) continue;
    if (item.type === "message") {
      for (const block of Array.isArray(item.content) ? item.content : []) {
        if (!isPlainObject(block)) continue;
        if (["output_text", "text"].includes(block.type) && typeof block.text === "string") {
          content.push({ type: "text", text: block.text });
        }
        if (block.type === "refusal") {
          const text = typeof block.refusal === "string" ? block.refusal : typeof block.text === "string" ? block.text : "";
          if (text) content.push({ type: "text", text });
          refused ||= Boolean(text);
        }
        if (isReasoningBlock(block)) {
          const text = reasoningText(block);
          if (text) thinking.push(text);
        }
      }
      continue;
    }
    if (item.type === "reasoning") {
      const text = reasoningText(item);
      if (text) thinking.push(text);
      continue;
    }
    if (item.type === "function_call" && typeof item.name === "string") {
      toolCalls.push({
        id: String(item.call_id ?? item.id ?? `tool-${toolCalls.length + 1}`),
        name: item.name,
        input: parseToolArguments(item.arguments, { toolIndex: toolCalls.length, toolName: item.name })
      });
    }
  }
  if (content.length === 0 && typeof raw.output_text === "string" && raw.output_text) {
    content.push({ type: "text", text: raw.output_text });
  }
  const normalizedContent = normalizeContent(content);
  const text = normalizedContent.map((block) => block.text).join("");
  return {
    id: typeof raw.id === "string" ? raw.id : null,
    model: typeof raw.model === "string" ? raw.model : null,
    content: normalizedContent,
    text,
    thinkingText: thinking.join("\n"),
    toolCalls,
    stopReason: toolCalls.length > 0 ? "tool_calls" : refused ? "refusal" : responseStopReason(raw),
    usage: isPlainObject(raw.usage) ? raw.usage : null,
    responseItems: replayableResponseItems(raw.output),
    raw: summarizeResponse(raw, text, thinking.join("\n"), toolCalls.length)
  };
}

/**
 * @param {ReadableStream<Uint8Array> | null} body
 * @param {{ onEvent?: (event: Record<string, any>) => void | Promise<void>; signal?: AbortSignal; idleTimeoutMs?: number; eventTimeoutMs?: number; maxResponseBytes?: number }} [options]
 */
export async function parseOpenAIResponsesStream(body, options = {}) {
  if (!body) return emptyResponse([]);
  const aggregate = createAggregate();
  const onEvent = options.onEvent
    ? (event) => emitGatewayEvent(options.onEvent, event, {
      signal: options.signal,
      timeoutMs: options.eventTimeoutMs
    })
    : null;
  const stream = await readResponsesStream(body, async (record) => {
    await applyResponsesRecord(aggregate, record, onEvent);
  }, options);
  const trimmed = stream.text.trim();
  if (stream.records.length === 0 && (trimmed.startsWith("{") || trimmed.startsWith("["))) {
    return normalizeOpenAIResponsesResponse(JSON.parse(trimmed));
  }
  if (stream.records.length > 0 && !stream.sawDone && !aggregate.sawTerminal) {
    const error = new Error("OpenAI Responses stream ended before a terminal event");
    error.name = "GatewayStreamProtocolError";
    error.code = "UPSTREAM_STREAM_ABORTED";
    error.retryable = true;
    error.details = { reason: "missing_terminal_event" };
    throw error;
  }
  const toolCalls = normalizeStreamToolCalls(aggregate.toolCalls);
  const final = aggregate.finalResponse ? normalizeOpenAIResponsesResponse(aggregate.finalResponse) : null;
  const text = aggregate.content || final?.text || "";
  const thinkingText = aggregate.thinking || final?.thinkingText || "";
  const normalizedToolCalls = toolCalls.length > 0 ? toolCalls : final?.toolCalls ?? [];
  return {
    id: aggregate.id ?? final?.id ?? null,
    model: aggregate.model ?? final?.model ?? null,
    content: text ? [{ type: "text", text }] : [],
    text,
    thinkingText,
    toolCalls: normalizedToolCalls,
    stopReason: normalizedToolCalls.length > 0 ? "tool_calls" : aggregate.stopReason ?? final?.stopReason ?? null,
    usage: aggregate.usage ?? final?.usage ?? null,
    responseItems: final?.responseItems?.length > 0
      ? final.responseItems
      : streamReplayableResponseItems(aggregate, normalizedToolCalls),
    raw: {
      protocol: "openai-responses-stream",
      bytes: Buffer.byteLength(stream.text, "utf8"),
      textBytes: Buffer.byteLength(text, "utf8"),
      thinkingBytes: aggregate.thinkingBytes,
      thinkingTruncated: aggregate.thinkingTruncated,
      toolCallCount: normalizedToolCalls.length,
      status: aggregate.stopReason
    }
  };
}

function normalizeResponsesInput(messages, toolResults) {
  const input = [];
  const includedResults = new Set();
  for (const message of messages) {
    if (!isPlainObject(message) || typeof message.role !== "string") continue;
    if (message.role === "tool") {
      const callId = String(message.toolCallId ?? message.tool_call_id ?? "");
      if (!callId) continue;
      includedResults.add(callId);
      input.push({ type: "function_call_output", call_id: callId, output: textFromContent(message.content) });
      continue;
    }
    if (message.role === "assistant") {
      const responseItems = replayableResponseItems(message.responseItems ?? message.providerItems);
      const replayedCallIds = new Set();
      for (const item of responseItems) {
        input.push(item);
        if (item.type === "function_call") {
          replayedCallIds.add(String(item.call_id ?? item.id ?? ""));
        }
      }
      const text = textFromContent(message.content);
      if (text) input.push({ role: "assistant", content: text });
      for (const [index, call] of normalizeRequestedToolCalls(message.toolCalls ?? message.tool_calls).entries()) {
        if (call.id && replayedCallIds.has(call.id)) continue;
        input.push({
          type: "function_call",
          call_id: call.id || `tool-${index + 1}`,
          name: call.name,
          arguments: JSON.stringify(call.input)
        });
      }
      continue;
    }
    if (["system", "developer"].includes(message.role)) {
      const text = textFromContent(message.content);
      if (text) input.push({ role: message.role, content: text });
      continue;
    }
    if (message.role === "user") {
      input.push({ role: "user", content: responsesUserContent(message.content) });
    }
  }
  for (const result of toolResults) {
    if (!isPlainObject(result)) continue;
    const callId = String(result.toolCallId ?? result.tool_call_id ?? "");
    if (!callId || includedResults.has(callId)) continue;
    input.push({ type: "function_call_output", call_id: callId, output: textFromContent(result.content) });
  }
  return input;
}

function normalizeResponsesTools(tools) {
  return tools
    .filter((tool) => isPlainObject(tool) && typeof tool.name === "string")
    .map((tool) => ({
      type: "function",
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description : "",
      parameters: isPlainObject(tool.inputSchema) ? tool.inputSchema : { type: "object", properties: {} },
      strict: false
    }));
}

function normalizeRequestedToolCalls(value) {
  if (!Array.isArray(value)) return [];
  return value.map((call) => {
    if (!isPlainObject(call)) return null;
    const source = isPlainObject(call.function) ? call.function : call;
    const name = String(source.name ?? "");
    if (!name) return null;
    return {
      id: String(call.id ?? call.call_id ?? ""),
      name,
      input: isPlainObject(call.input) ? call.input : parseArguments(source.arguments)
    };
  }).filter(Boolean);
}

function responsesUserContent(content) {
  if (!Array.isArray(content)) return textFromContent(content);
  const blocks = [];
  for (const item of content) {
    if (typeof item === "string" && item) {
      blocks.push({ type: "input_text", text: item });
      continue;
    }
    if (!isPlainObject(item)) continue;
    if (item.type === "text" && typeof item.text === "string") {
      blocks.push({ type: "input_text", text: item.text });
    } else if (item.type === "image") {
      const imageUrl = imageDataUrl(item);
      if (imageUrl) blocks.push({ type: "input_image", image_url: imageUrl });
    }
  }
  return blocks.length > 0 ? blocks : "";
}

function createAggregate() {
  return {
    id: null,
    model: null,
    content: "",
    thinking: "",
    thinkingBytes: 0,
    thinkingTruncated: false,
    toolCalls: new Map(),
    itemIndexes: new Map(),
    responseItems: new Map(),
    usage: null,
    stopReason: null,
    sawStart: false,
    sawTerminal: false,
    finalResponse: null
  };
}

async function applyResponsesRecord(aggregate, record, onEvent) {
  if (!isPlainObject(record)) return;
  const response = isPlainObject(record.response) ? record.response : null;
  if (response) {
    if (typeof response.id === "string") aggregate.id = response.id;
    if (typeof response.model === "string") aggregate.model = response.model;
    if (isPlainObject(response.usage)) aggregate.usage = response.usage;
  }
  const type = String(record.type ?? "");
  if (!aggregate.sawStart && (type === "response.created" || type === "response.in_progress" || aggregate.id)) {
    aggregate.sawStart = true;
    await emit(onEvent, { type: "message_start", id: aggregate.id, model: aggregate.model });
  }
  if (type === "response.output_text.delta" && typeof record.delta === "string") {
    aggregate.content += record.delta;
    await emit(onEvent, { type: "text_delta", text: record.delta });
    return;
  }
  if (type === "response.refusal.delta" && typeof record.delta === "string") {
    aggregate.content += record.delta;
    aggregate.stopReason = "refusal";
    await emit(onEvent, { type: "text_delta", text: record.delta });
    return;
  }
  if (["response.reasoning_summary_text.delta", "response.reasoning_text.delta"].includes(type) && typeof record.delta === "string") {
    aggregate.thinkingBytes += Buffer.byteLength(record.delta, "utf8");
    const preview = appendThinkingPreview(aggregate.thinking, record.delta);
    aggregate.thinking = preview.text;
    aggregate.thinkingTruncated ||= preview.truncated;
    await emit(onEvent, { type: "thinking_delta", text: record.delta, truncated: aggregate.thinkingTruncated });
    return;
  }
  if (type === "response.output_item.added" && isPlainObject(record.item) && record.item.type === "function_call") {
    captureResponseItem(aggregate, record.item, record.output_index);
    const index = toolIndex(aggregate, record, record.item);
    const call = streamToolCall(record.item, index);
    aggregate.toolCalls.set(index, call);
    await emit(onEvent, { type: "tool_call_delta", index, id: call.id, nameDelta: call.name, argumentsDelta: call.arguments });
    return;
  }
  if (type === "response.output_item.added" && isPlainObject(record.item)) {
    captureResponseItem(aggregate, record.item, record.output_index);
    return;
  }
  if (type === "response.function_call_arguments.delta") {
    const index = toolIndex(aggregate, record);
    const call = aggregate.toolCalls.get(index) ?? { id: String(record.item_id ?? `tool-${index + 1}`), name: "", arguments: "" };
    const delta = typeof record.delta === "string" ? record.delta : "";
    call.arguments += delta;
    aggregate.toolCalls.set(index, call);
    await emit(onEvent, { type: "tool_call_delta", index, id: call.id, nameDelta: "", argumentsDelta: delta });
    return;
  }
  if (type === "response.function_call_arguments.done") {
    const index = toolIndex(aggregate, record);
    const current = aggregate.toolCalls.get(index) ?? {
      id: String(record.call_id ?? record.item_id ?? `tool-${index + 1}`),
      name: String(record.name ?? ""),
      arguments: ""
    };
    if (typeof record.arguments === "string") current.arguments = record.arguments;
    if (typeof record.name === "string") current.name = record.name;
    aggregate.toolCalls.set(index, current);
    return;
  }
  if (type === "response.output_item.done" && isPlainObject(record.item)) {
    const item = record.item;
    captureResponseItem(aggregate, item, record.output_index);
    if (item.type === "function_call") {
      const index = toolIndex(aggregate, record, item);
      const current = aggregate.toolCalls.get(index) ?? streamToolCall(item, index);
      current.id = String(item.call_id ?? current.id ?? item.id ?? `tool-${index + 1}`);
      current.name = String(item.name ?? current.name ?? "");
      if (typeof item.arguments === "string") current.arguments = item.arguments;
      aggregate.toolCalls.set(index, current);
    }
    return;
  }
  if (["response.failed", "response.incomplete"].includes(type)) {
    aggregate.sawTerminal = true;
    aggregate.finalResponse = response;
    throw responsesTerminalError(response ?? {}, type.replace("response.", ""));
  }
  if (type === "response.completed") {
    assertResponsesSucceeded(response ?? {});
    aggregate.sawTerminal = true;
    aggregate.finalResponse = response;
    aggregate.stopReason = aggregate.stopReason === "refusal" ? "refusal" : "stop";
    await emit(onEvent, { type: "message_stop", stopReason: aggregate.stopReason });
  }
}

function toolIndex(aggregate, record, item = null) {
  const itemId = String(record.item_id ?? item?.id ?? item?.call_id ?? "");
  const outputKey = Number.isInteger(record.output_index) ? `output:${record.output_index}` : "";
  for (const key of [itemId ? `item:${itemId}` : "", outputKey].filter(Boolean)) {
    if (aggregate.itemIndexes.has(key)) return aggregate.itemIndexes.get(key);
  }
  const index = aggregate.toolCalls.size;
  if (itemId) aggregate.itemIndexes.set(`item:${itemId}`, index);
  if (outputKey) aggregate.itemIndexes.set(outputKey, index);
  return index;
}

function streamToolCall(item, index) {
  return {
    id: String(item.call_id ?? item.id ?? `tool-${index + 1}`),
    name: String(item.name ?? ""),
    arguments: typeof item.arguments === "string" ? item.arguments : ""
  };
}

function normalizeStreamToolCalls(calls) {
  return Array.from(calls.entries()).map(([index, call]) => {
    if (!call.name) {
      const error = new Error("OpenAI Responses stream ended before a tool call name was complete");
      error.name = "GatewayStreamProtocolError";
      error.code = "INCOMPLETE_TOOL_CALL";
      error.retryable = true;
      error.details = { reason: "missing_tool_name", toolIndex: index };
      throw error;
    }
    return {
      id: call.id || `tool-${index + 1}`,
      name: call.name,
      input: parseToolArguments(call.arguments, { toolIndex: index, toolName: call.name })
    };
  });
}

async function readResponsesStream(body, onRecord, options) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const maxBytes = normalizeGatewayMaxResponseBytes(options.maxResponseBytes);
  let received = 0;
  let text = "";
  let buffer = "";
  let sawDone = false;
  let completed = false;
  const records = [];
  const drain = async (final = false) => {
    const lines = buffer.split(/\r?\n/);
    if (!final && !buffer.endsWith("\n") && !buffer.endsWith("\r")) buffer = lines.pop() ?? "";
    else buffer = "";
    assertGatewayStreamRecordSize(buffer);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("event:") || trimmed.startsWith("id:") || trimmed.startsWith(":")) continue;
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload) continue;
      if (payload === "[DONE]") {
        sawDone = true;
        continue;
      }
      assertGatewayStreamRecordSize(payload);
      const record = JSON.parse(payload);
      records.push(record);
      await onRecord(record);
    }
  };
  try {
    while (true) {
      const { done, value } = await readChunk(reader, options);
      if (done) {
        completed = true;
        break;
      }
      const bytes = Number(value?.byteLength ?? 0);
      if (bytes > maxBytes - received) throw gatewayResponseLimitError("GATEWAY_RESPONSE_TOO_LARGE", maxBytes, received + bytes);
      received += bytes;
      const chunk = decoder.decode(value, { stream: true });
      text += chunk;
      buffer += chunk;
      await drain(false);
    }
  } finally {
    if (!completed) Promise.resolve(reader.cancel(options.signal?.reason)).catch(() => {});
    try { reader.releaseLock(); } catch { /* already released */ }
  }
  const tail = decoder.decode();
  text += tail;
  buffer += tail;
  await drain(true);
  return { text, records, sawDone };
}

function readChunk(reader, options) {
  if (options.signal?.aborted) return Promise.reject(abortError(options.signal.reason));
  const idleMs = Number.isFinite(options.idleTimeoutMs) ? Math.max(50, Math.trunc(options.idleTimeoutMs)) : 0;
  if (!idleMs && !options.signal) return reader.read();
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener?.("abort", onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, abortError(options.signal?.reason));
    if (idleMs) timer = setTimeout(() => finish(reject, timeoutError(idleMs)), idleMs);
    options.signal?.addEventListener?.("abort", onAbort, { once: true });
    Promise.resolve().then(() => reader.read()).then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}

function reasoningText(value) {
  if (!isPlainObject(value)) return "";
  if (typeof value.text === "string") return value.text;
  const parts = [];
  for (const key of ["summary", "content"]) {
    for (const item of Array.isArray(value[key]) ? value[key] : []) {
      if (isPlainObject(item) && typeof item.text === "string") parts.push(item.text);
    }
  }
  return parts.join("\n");
}

function isReasoningBlock(block) {
  return ["reasoning", "reasoning_text", "summary_text"].includes(String(block.type ?? ""));
}

function replayableResponseItems(value) {
  return (Array.isArray(value) ? value : [])
    .filter((item) => isPlainObject(item) && ["reasoning", "function_call"].includes(String(item.type ?? "")))
    .map((item) => cloneJsonObject(item));
}

function captureResponseItem(aggregate, item, outputIndex) {
  if (!isPlainObject(item) || !["reasoning", "function_call"].includes(String(item.type ?? ""))) return;
  const key = typeof item.id === "string" && item.id
    ? `item:${item.id}`
    : Number.isInteger(outputIndex) ? `output:${outputIndex}` : `response-item:${aggregate.responseItems.size}`;
  aggregate.responseItems.set(key, cloneJsonObject(item));
}

function streamReplayableResponseItems(aggregate, toolCalls) {
  const items = Array.from(aggregate.responseItems.values())
    .filter((item) => item.type === "reasoning")
    .flatMap((item) => replayableResponseItems([item]));
  for (const call of toolCalls) {
    items.push({
      type: "function_call",
      call_id: call.id,
      name: call.name,
      arguments: JSON.stringify(call.input ?? {})
    });
  }
  return items;
}

function assertResponsesSucceeded(raw) {
  const status = String(raw?.status ?? "").trim().toLowerCase();
  if (status === "failed" || status === "incomplete") {
    throw responsesTerminalError(raw, status);
  }
}

/** @param {Record<string, any>} raw @param {string} status */
function responsesTerminalError(raw, status) {
  const providerError = isPlainObject(raw?.error) ? raw.error : null;
  const incomplete = isPlainObject(raw?.incomplete_details) ? raw.incomplete_details : null;
  const reason = String(incomplete?.reason ?? providerError?.code ?? status ?? "response_failed");
  const providerMessage = String(providerError?.message ?? "").trim();
  const providerStatus = responsesProviderStatus(raw, providerError);
  const retryable = isRetryableResponsesTerminal(raw, providerError, incomplete);
  const error = new Error(providerMessage || `OpenAI Responses request ended with status ${status}`);
  error.name = "GatewayResponseProtocolError";
  error.code = status === "incomplete" ? "GATEWAY_RESPONSE_INCOMPLETE" : "GATEWAY_RESPONSE_FAILED";
  error.retryable = retryable;
  error.details = {
    reason,
    providerCode: providerError?.code ?? null,
    providerStatus,
    retryable,
    responseId: typeof raw?.id === "string" ? raw.id : null
  };
  return error;
}

/**
 * @param {Record<string, any>} raw
 * @param {Record<string, any> | null} providerError
 * @param {Record<string, any> | null} incomplete
 */
function isRetryableResponsesTerminal(raw, providerError, incomplete) {
  const codes = [
    providerError?.code,
    providerError?.type,
    incomplete?.reason
  ].map(normalizeResponsesErrorCode).filter(Boolean);
  if (codes.some((code) => RETRYABLE_RESPONSES_ERROR_CODES.has(code))) {
    return true;
  }
  const status = responsesProviderStatus(raw, providerError);
  return status === 408 || status === 409 || status === 429 || Number(status) >= 500;
}

/** @param {unknown} value */
function normalizeResponsesErrorCode(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/** @param {Record<string, any>} raw @param {Record<string, any> | null} providerError */
function responsesProviderStatus(raw, providerError) {
  for (const value of [
    providerError?.status_code,
    providerError?.status,
    providerError?.http_status,
    raw?.status_code,
    raw?.http_status,
    /^\d{3}$/.test(String(providerError?.code ?? "")) ? providerError.code : null
  ]) {
    const status = Number(value);
    if (Number.isInteger(status) && status >= 100 && status <= 599) {
      return status;
    }
  }
  return null;
}

function responseStopReason(raw) {
  const status = String(raw.status ?? "").trim();
  if (status === "completed") return "stop";
  return status || null;
}

function summarizeResponse(raw, text, thinking, toolCallCount) {
  return {
    protocol: "openai-responses",
    id: typeof raw.id === "string" ? raw.id : null,
    status: typeof raw.status === "string" ? raw.status : null,
    textBytes: Buffer.byteLength(text, "utf8"),
    thinkingBytes: Buffer.byteLength(thinking, "utf8"),
    toolCallCount,
    usage: isPlainObject(raw.usage) ? raw.usage : null
  };
}

function parseArguments(value) {
  if (isPlainObject(value)) return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseToolArguments(value, details = {}) {
  if (isPlainObject(value)) return value;
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (isPlainObject(parsed)) return parsed;
    } catch {
      // Report the incomplete tool call below without exposing provider arguments.
    }
  }
  const error = new Error("OpenAI Responses returned incomplete or invalid tool arguments");
  error.name = "GatewayStreamProtocolError";
  error.code = "INCOMPLETE_TOOL_CALL";
  error.retryable = true;
  error.details = {
    reason: "invalid_tool_arguments",
    toolIndex: Number.isInteger(details.toolIndex) ? details.toolIndex : null,
    toolName: typeof details.toolName === "string" ? details.toolName : null
  };
  throw error;
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  return normalizeContent(content).map((block) => block.text).join("");
}

function imageDataUrl(item) {
  const data = String(item.data ?? "").replace(/\s+/g, "");
  const mimeType = String(item.mimeType ?? item.mime_type ?? "").trim().toLowerCase();
  return data && /^image\/[a-z0-9.+-]+$/i.test(mimeType) ? `data:${mimeType};base64,${data}` : "";
}

async function emit(onEvent, event) {
  if (onEvent) await onEvent(event);
}

function abortError(reason) {
  if (reason instanceof Error) return reason;
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

function cloneJsonObject(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
