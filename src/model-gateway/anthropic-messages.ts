import { emitGatewayEvent } from "./event-callback.ts";
import {
  gatewayResponseLimitError,
  normalizeGatewayMaxResponseBytes
} from "./limits.ts";
import { createOpenAIChatCompletionRequest } from "./openai-chat.ts";
import { emptyResponse, type NormalizedGatewayResponse } from "./protocol.ts";

const DEFAULT_MAX_TOKENS = 8192;

type GatewayEventHandler = (event: Record<string, unknown>) => void | Promise<void>;
type StreamReader = ReadableStreamDefaultReader<Uint8Array>;
type StreamReadOptions = {
  onEvent?: GatewayEventHandler;
  signal?: AbortSignal;
  idleTimeoutMs?: number;
  eventTimeoutMs?: number;
  maxResponseBytes?: number;
};
type GatewayProtocolError = Error & {
  code?: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
};
type AnthropicTextBlock = { type: "text"; text: string };
type AnthropicImageBlock = {
  type: "image";
  source: { type: string; media_type: string; data: string };
};
type AnthropicToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
};
type AnthropicToolResultBlock = {
  type: "tool_result";
  tool_use_id: unknown;
  content: string;
};
type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;
type AnthropicMessage = {
  role: unknown;
  content: AnthropicContentBlock[] | string;
};
type AnthropicRequest = {
  model: unknown;
  max_tokens: number;
  messages: AnthropicMessage[];
  stream: boolean;
  system?: string;
  tools?: Array<{ name: unknown; description: unknown; input_schema: unknown }>;
  [key: string]: unknown;
};
type AnthropicStreamToolCall = { id: string; name: string; arguments: string };
type AnthropicStreamAggregate = {
  id: unknown;
  model: unknown;
  text: string;
  thinking: string;
  stopReason: unknown;
  usage: unknown;
  toolCalls: Map<unknown, AnthropicStreamToolCall>;
  sawTerminal: boolean;
  records: unknown[];
};
type OpenAIFunctionTool = {
  function: {
    name: unknown;
    description: unknown;
    parameters: unknown;
  };
};
type AnthropicMessagesRequestInput = {
  model: string;
  messages: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
  toolResults?: Array<Record<string, unknown>>;
  stream?: boolean;
  extraBody?: Record<string, unknown> | null;
  reasoningEffort?: string | null;
  toolChoice?: unknown;
};

export function createAnthropicMessagesRequest(input: AnthropicMessagesRequestInput) {
  const openai = createOpenAIChatCompletionRequest(input);
  const system: string[] = [];
  const messages: AnthropicMessage[] = [];
  const openaiMessages = openai.messages as unknown[];
  for (const item of openaiMessages) {
    const message = item as Record<string, unknown>;
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
        const toolCall = call as Record<string, unknown>;
        const fn = objectRecord(toolCall.function);
        content.push({
          type: "tool_use",
          id: String(toolCall.id ?? ""),
          name: String(fn?.name ?? ""),
          input: parseJsonObject(fn?.arguments)
        });
      }
    }
    appendAnthropicMessage(messages, { role: message.role, content });
  }

  const extraBody = input.extraBody;
  const request: AnthropicRequest = {
    model: input.model,
    max_tokens: positiveInteger(extraBody?.max_tokens) ?? DEFAULT_MAX_TOKENS,
    messages,
    stream: Boolean(input.stream)
  };
  if (system.length > 0) request.system = system.join("\n\n");
  const openaiTools = openai.tools as unknown[] | undefined;
  if (openaiTools?.length) {
    request.tools = openaiTools.map((tool) => {
      const fn = (tool as OpenAIFunctionTool).function;
      return {
        name: fn.name,
        description: fn.description,
        input_schema: fn.parameters
      };
    });
  }
  if (isPlainObject(input.extraBody)) {
    Object.assign(request, input.extraBody, { max_tokens: request.max_tokens });
  }
  return request;
}

export function normalizeAnthropicMessagesResponse(raw: unknown): NormalizedGatewayResponse {
  if (!isPlainObject(raw)) return emptyResponse(raw);
  const blocks = Array.isArray(raw.content) ? raw.content : [];
  const content = blocks
    .filter((block): block is Record<string, unknown> & { type: string; text: string } => isPlainObject(block) && block.type === "text" && typeof block.text === "string")
    .map((block) => ({ type: "text" as const, text: block.text }));
  return {
    id: typeof raw.id === "string" ? raw.id : null,
    model: typeof raw.model === "string" ? raw.model : null,
    content,
    text: content.map((block) => block.text).join(""),
    thinkingText: blocks
      .filter((block): block is Record<string, unknown> & { thinking: string } => isPlainObject(block) && block.type === "thinking" && typeof block.thinking === "string")
      .map((block) => block.thinking).join(""),
    toolCalls: blocks
      .filter((block): block is Record<string, unknown> & { name: string } => isPlainObject(block) && block.type === "tool_use" && typeof block.name === "string")
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

export async function parseAnthropicMessagesStream(body: ReadableStream<Uint8Array> | null | undefined, options: StreamReadOptions = {}): Promise<NormalizedGatewayResponse> {
  if (!body) return emptyResponse();
  const aggregate: AnthropicStreamAggregate = {
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
    const error: GatewayProtocolError = new Error("Anthropic stream ended before message_stop or stop_reason");
    error.name = "GatewayStreamProtocolError";
    error.code = "UPSTREAM_STREAM_ABORTED";
    error.retryable = true;
    error.details = { reason: "missing_message_stop_and_stop_reason" };
    throw error;
  }
  return {
    id: aggregate.id as string | null,
    model: aggregate.model as string | null,
    content: aggregate.text ? [{ type: "text", text: aggregate.text }] : [],
    text: aggregate.text,
    thinkingText: aggregate.thinking,
    toolCalls: Array.from(aggregate.toolCalls.values()).map((call) => ({
      id: call.id,
      name: call.name,
      input: parseJsonObject(call.arguments)
    })),
    stopReason: aggregate.stopReason as string | null,
    usage: aggregate.usage as Record<string, unknown> | null,
    raw: { protocol: "anthropic-messages-stream", recordCount: aggregate.records.length }
  };
}

async function consumeEvent(eventText: string, aggregate: AnthropicStreamAggregate, options: StreamReadOptions) {
  const data = eventText.split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim()).join("\n");
  if (!data || data === "[DONE]") return;
  const parsed: unknown = JSON.parse(data);
  aggregate.records.push(parsed);
  const record = parsed as Record<string, unknown>;
  const type = record.type;
  const message = objectRecord(record.message);
  const contentBlock = objectRecord(record.content_block);
  const delta = objectRecord(record.delta);
  if (type === "message_start") {
    aggregate.id = message?.id ?? aggregate.id;
    aggregate.model = message?.model ?? aggregate.model;
    aggregate.usage = message?.usage ?? aggregate.usage;
    await emit(options, { type: "message_start", id: aggregate.id, model: aggregate.model });
  } else if (type === "content_block_start" && contentBlock?.type === "tool_use") {
    aggregate.toolCalls.set(record.index, {
      id: String(contentBlock.id ?? ""),
      name: String(contentBlock.name ?? ""),
      arguments: ""
    });
    await emit(options, {
      type: "tool_call_delta",
      index: record.index,
      id: contentBlock.id,
      nameDelta: contentBlock.name,
      argumentsDelta: ""
    });
  } else if (type === "content_block_delta") {
    if (delta?.type === "text_delta" && typeof delta.text === "string") {
      aggregate.text += delta.text;
      await emit(options, { type: "text_delta", text: delta.text });
    } else if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
      aggregate.thinking += delta.thinking;
      await emit(options, { type: "thinking_delta", text: delta.thinking });
    } else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
      const call = aggregate.toolCalls.get(record.index) ?? { id: "", name: "", arguments: "" };
      call.arguments += delta.partial_json;
      aggregate.toolCalls.set(record.index, call);
      await emit(options, {
        type: "tool_call_delta",
        index: record.index,
        id: call.id,
        nameDelta: "",
        argumentsDelta: delta.partial_json
      });
    }
  } else if (type === "message_delta") {
    aggregate.stopReason = delta?.stop_reason ?? aggregate.stopReason;
    aggregate.usage = isPlainObject(record.usage) ? { ...(objectRecord(aggregate.usage) ?? {}), ...record.usage } : aggregate.usage;
    if (aggregate.stopReason) aggregate.sawTerminal = true;
  } else if (type === "message_stop") {
    aggregate.sawTerminal = true;
    aggregate.stopReason ??= "end_turn";
    await emit(options, { type: "message_stop", stopReason: aggregate.stopReason });
  } else if (type === "error") {
    throw new Error(String(objectRecord(record.error)?.message ?? "Anthropic stream error"));
  }
}

async function emit(options: StreamReadOptions, event: Record<string, unknown>) {
  if (options.onEvent) {
    await emitGatewayEvent(options.onEvent, event, { signal: options.signal, timeoutMs: options.eventTimeoutMs });
  }
}

async function* streamTextChunks(body: ReadableStream<Uint8Array>, options: StreamReadOptions) {
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

function readStreamChunk(reader: StreamReader, options: StreamReadOptions) {
  const signal = options.signal;
  const idleTimeoutMs = typeof options.idleTimeoutMs === "number" && Number.isFinite(options.idleTimeoutMs)
    ? Math.max(1000, Math.trunc(options.idleTimeoutMs))
    : null;
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("stream aborted"));
  if (!signal && !idleTimeoutMs) return reader.read();
  return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (ok: boolean, value: unknown) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      if (ok) {
        resolve(value as ReadableStreamReadResult<Uint8Array>);
      } else {
        reject(value);
      }
    };
    const onAbort = () => finish(false, signal?.reason ?? new Error("stream aborted"));
    if (idleTimeoutMs) {
      timer = setTimeout(() => {
        const error: GatewayProtocolError = new Error(`Gateway stream idle timeout after ${idleTimeoutMs}ms`);
        error.name = "AbortError";
        error.code = "GATEWAY_STREAM_IDLE_TIMEOUT";
        try { Promise.resolve(reader.cancel(error)).catch(() => {}); } catch {}
        finish(false, error);
      }, idleTimeoutMs);
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
    Promise.resolve(reader.read()).then(
      (chunk) => finish(true, chunk),
      (error: unknown) => finish(false, error)
    );
  });
}

function appendAnthropicMessage(messages: AnthropicMessage[], incoming: AnthropicMessage) {
  const previous = messages.at(-1);
  if (previous && previous.role === incoming.role && Array.isArray(previous.content) && Array.isArray(incoming.content)) {
    previous.content.push(...incoming.content);
  } else {
    messages.push(incoming);
  }
}

function anthropicContent(content: unknown): AnthropicContentBlock[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block): AnthropicContentBlock[] => {
    const record = objectRecord(block);
    if (!record) return [];
    if (record.type === "text" && typeof record.text === "string") return [{ type: "text", text: record.text }];
    if (record.type === "image_url") {
      const match = /^data:([^;]+);base64,(.+)$/s.exec(String(objectRecord(record.image_url)?.url ?? ""));
      if (match) return [{ type: "image", source: { type: "base64", media_type: match[1], data: match[2] } }];
    }
    return [];
  });
}

function contentText(content: unknown) {
  if (typeof content === "string") return content;
  return Array.isArray(content)
    ? content.filter((block) => objectRecord(block)?.type === "text").map((block) => objectRecord(block)?.text).join("")
    : "";
}

function parseJsonObject(value: unknown) {
  if (isPlainObject(value)) return value;
  try {
    const parsed = JSON.parse(String(value ?? "{}"));
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function positiveInteger(value: unknown) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && value !== undefined && typeof value === "object"
    ? value as Record<string, unknown>
    : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
