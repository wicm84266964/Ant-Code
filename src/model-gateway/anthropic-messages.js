import { emitGatewayEvent } from "./event-callback.js";
import {
  gatewayResponseLimitError,
  normalizeGatewayMaxResponseBytes
} from "./limits.js";
import { createOpenAIChatCompletionRequest } from "./openai-chat.js";
import { emptyResponse } from "./protocol.js";

const DEFAULT_MAX_TOKENS = 8192;

export function createAnthropicMessagesRequest(input) {
  const openai = createOpenAIChatCompletionRequest(input);
  const system = [];
  const messages = [];
  for (const message of openai.messages) {
    if (message.role === "system") {
      const text = contentText(message.content);
      if (text) system.push(text);
      continue;
    }
    if (message.role === "tool") {
      appendAnthropicMessage(messages, {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: message.tool_call_id,
          content: contentText(message.content)
        }]
      });
      continue;
    }
    const content = anthropicContent(message.content);
    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        content.push({
          type: "tool_use",
          id: String(call.id ?? ""),
          name: String(call.function?.name ?? ""),
          input: parseJsonObject(call.function?.arguments)
        });
      }
    }
    appendAnthropicMessage(messages, { role: message.role, content });
  }

  const request = {
    model: input.model,
    max_tokens: positiveInteger(input.extraBody?.max_tokens) ?? DEFAULT_MAX_TOKENS,
    messages,
    stream: Boolean(input.stream)
  };
  if (system.length > 0) request.system = system.join("\n\n");
  if (openai.tools?.length) {
    request.tools = openai.tools.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters
    }));
  }
  if (isPlainObject(input.extraBody)) {
    Object.assign(request, input.extraBody, { max_tokens: request.max_tokens });
  }
  return request;
}

export function normalizeAnthropicMessagesResponse(raw) {
  if (!isPlainObject(raw)) return emptyResponse(raw);
  const blocks = Array.isArray(raw.content) ? raw.content : [];
  const content = blocks
    .filter((block) => isPlainObject(block) && block.type === "text" && typeof block.text === "string")
    .map((block) => ({ type: "text", text: block.text }));
  return {
    id: typeof raw.id === "string" ? raw.id : null,
    model: typeof raw.model === "string" ? raw.model : null,
    content,
    text: content.map((block) => block.text).join(""),
    thinkingText: blocks
      .filter((block) => isPlainObject(block) && block.type === "thinking" && typeof block.thinking === "string")
      .map((block) => block.thinking).join(""),
    toolCalls: blocks
      .filter((block) => isPlainObject(block) && block.type === "tool_use" && typeof block.name === "string")
      .map((block, index) => ({
        id: typeof block.id === "string" ? block.id : `tool-${index + 1}`,
        name: block.name,
        input: isPlainObject(block.input) ? block.input : {}
      })),
    stopReason: typeof raw.stop_reason === "string" ? raw.stop_reason : null,
    usage: isPlainObject(raw.usage) ? raw.usage : null,
    raw
  };
}

export async function parseAnthropicMessagesStream(body, options = {}) {
  if (!body) return emptyResponse();
  const aggregate = {
    id: null,
    model: null,
    text: "",
    thinking: "",
    stopReason: null,
    usage: null,
    toolCalls: new Map(),
    sawTerminal: false,
    records: []
  };
  let pending = "";
  for await (const chunk of streamTextChunks(body, options)) {
    pending += chunk;
    const events = pending.split(/\r?\n\r?\n/);
    pending = events.pop() ?? "";
    for (const event of events) await consumeEvent(event, aggregate, options);
  }
  if (pending.trim()) await consumeEvent(pending, aggregate, options);
  if (aggregate.records.length > 0 && !aggregate.sawTerminal) {
    const error = new Error("Anthropic stream ended before message_stop or stop_reason");
    error.name = "GatewayStreamProtocolError";
    error.code = "UPSTREAM_STREAM_ABORTED";
    error.retryable = true;
    error.details = { reason: "missing_message_stop_and_stop_reason" };
    throw error;
  }
  return {
    id: aggregate.id,
    model: aggregate.model,
    content: aggregate.text ? [{ type: "text", text: aggregate.text }] : [],
    text: aggregate.text,
    thinkingText: aggregate.thinking,
    toolCalls: Array.from(aggregate.toolCalls.values()).map((call) => ({
      id: call.id,
      name: call.name,
      input: parseJsonObject(call.arguments)
    })),
    stopReason: aggregate.stopReason,
    usage: aggregate.usage,
    raw: { protocol: "anthropic-messages-stream", recordCount: aggregate.records.length }
  };
}

async function consumeEvent(eventText, aggregate, options) {
  const data = eventText.split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim()).join("\n");
  if (!data || data === "[DONE]") return;
  const record = JSON.parse(data);
  aggregate.records.push(record);
  const type = record.type;
  if (type === "message_start") {
    aggregate.id = record.message?.id ?? aggregate.id;
    aggregate.model = record.message?.model ?? aggregate.model;
    aggregate.usage = record.message?.usage ?? aggregate.usage;
    await emit(options, { type: "message_start", id: aggregate.id, model: aggregate.model });
  } else if (type === "content_block_start" && record.content_block?.type === "tool_use") {
    aggregate.toolCalls.set(record.index, {
      id: String(record.content_block.id ?? ""),
      name: String(record.content_block.name ?? ""),
      arguments: ""
    });
    await emit(options, {
      type: "tool_call_delta",
      index: record.index,
      id: record.content_block.id,
      nameDelta: record.content_block.name,
      argumentsDelta: ""
    });
  } else if (type === "content_block_delta") {
    if (record.delta?.type === "text_delta" && typeof record.delta.text === "string") {
      aggregate.text += record.delta.text;
      await emit(options, { type: "text_delta", text: record.delta.text });
    } else if (record.delta?.type === "thinking_delta" && typeof record.delta.thinking === "string") {
      aggregate.thinking += record.delta.thinking;
      await emit(options, { type: "thinking_delta", text: record.delta.thinking });
    } else if (record.delta?.type === "input_json_delta" && typeof record.delta.partial_json === "string") {
      const call = aggregate.toolCalls.get(record.index) ?? { id: "", name: "", arguments: "" };
      call.arguments += record.delta.partial_json;
      aggregate.toolCalls.set(record.index, call);
      await emit(options, {
        type: "tool_call_delta",
        index: record.index,
        id: call.id,
        nameDelta: "",
        argumentsDelta: record.delta.partial_json
      });
    }
  } else if (type === "message_delta") {
    aggregate.stopReason = record.delta?.stop_reason ?? aggregate.stopReason;
    aggregate.usage = isPlainObject(record.usage) ? { ...(aggregate.usage ?? {}), ...record.usage } : aggregate.usage;
    if (aggregate.stopReason) aggregate.sawTerminal = true;
  } else if (type === "message_stop") {
    aggregate.sawTerminal = true;
    aggregate.stopReason ??= "end_turn";
    await emit(options, { type: "message_stop", stopReason: aggregate.stopReason });
  } else if (type === "error") {
    throw new Error(String(record.error?.message ?? "Anthropic stream error"));
  }
}

async function emit(options, event) {
  if (options.onEvent) {
    await emitGatewayEvent(options.onEvent, event, { signal: options.signal, timeoutMs: options.eventTimeoutMs });
  }
}

async function* streamTextChunks(body, options) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const limit = normalizeGatewayMaxResponseBytes(options.maxResponseBytes);
  let received = 0;
  let completed = false;
  try {
    while (true) {
      const { done, value } = await readStreamChunk(reader, options);
      if (done) {
        completed = true;
        break;
      }
      received += Number(value?.byteLength ?? 0);
      if (received > limit) throw gatewayResponseLimitError("GATEWAY_RESPONSE_TOO_LARGE", limit, received);
      yield decoder.decode(value, { stream: true });
    }
    const tail = decoder.decode();
    if (tail) yield tail;
  } finally {
    if (!completed) {
      try { Promise.resolve(reader.cancel(options.signal?.reason)).catch(() => {}); } catch {}
    }
    try { reader.releaseLock(); } catch {}
  }
}

function readStreamChunk(reader, options) {
  const signal = options.signal;
  const idleTimeoutMs = Number.isFinite(options.idleTimeoutMs) ? Math.max(1000, Math.trunc(options.idleTimeoutMs)) : null;
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("stream aborted"));
  if (!signal && !idleTimeoutMs) return reader.read();
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, signal?.reason ?? new Error("stream aborted"));
    if (idleTimeoutMs) {
      timer = setTimeout(() => {
        const error = new Error(`Gateway stream idle timeout after ${idleTimeoutMs}ms`);
        error.name = "AbortError";
        error.code = "GATEWAY_STREAM_IDLE_TIMEOUT";
        try { Promise.resolve(reader.cancel(error)).catch(() => {}); } catch {}
        finish(reject, error);
      }, idleTimeoutMs);
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
    Promise.resolve(reader.read()).then(
      (chunk) => finish(resolve, chunk),
      (error) => finish(reject, error)
    );
  });
}

function appendAnthropicMessage(messages, incoming) {
  const previous = messages.at(-1);
  if (previous?.role === incoming.role && Array.isArray(previous.content) && Array.isArray(incoming.content)) {
    previous.content.push(...incoming.content);
  } else {
    messages.push(incoming);
  }
}

function anthropicContent(content) {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    if (block?.type === "text" && typeof block.text === "string") return [{ type: "text", text: block.text }];
    if (block?.type === "image_url") {
      const match = /^data:([^;]+);base64,(.+)$/s.exec(String(block.image_url?.url ?? ""));
      if (match) return [{ type: "image", source: { type: "base64", media_type: match[1], data: match[2] } }];
    }
    return [];
  });
}

function contentText(content) {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.filter((block) => block?.type === "text").map((block) => block.text).join("") : "";
}

function parseJsonObject(value) {
  if (isPlainObject(value)) return value;
  try {
    const parsed = JSON.parse(String(value ?? "{}"));
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

