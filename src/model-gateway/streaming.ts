import { emptyResponse, normalizeGatewayResponse, type NormalizedGatewayResponse } from "./protocol.ts";
import { emitGatewayEvent } from "./event-callback.ts";
import {
  assertGatewayStreamRecordSize,
  gatewayResponseLimitError,
  normalizeGatewayMaxResponseBytes
} from "./limits.ts";

type GatewayEventHandler = (event: Record<string, unknown>) => void | Promise<void>;
type StreamReader = ReadableStreamDefaultReader<Uint8Array>;
type StreamParseOptions = {
  onEvent?: GatewayEventHandler;
  signal?: AbortSignal;
  idleTimeoutMs?: number;
  eventTimeoutMs?: number;
  maxResponseBytes?: number;
};
type StreamReadOptions = {
  signal?: AbortSignal;
  idleTimeoutMs?: number;
  maxResponseBytes?: number;
};
type GatewayProtocolError = Error & { code?: string };

/**
 * Parse a lab gateway streaming response.
 *
 * The gateway supports two lab-owned streaming encodings:
 * - text/event-stream with `data: {...}` records
 * - application/x-ndjson with one JSON object per line
 *
 * @param {ReadableStream<Uint8Array> | null} body
 * @param {string | null} contentType
 * @param {{ onEvent?: (event: Record<string, any>) => void | Promise<void>; signal?: AbortSignal; idleTimeoutMs?: number; eventTimeoutMs?: number; maxResponseBytes?: number }} [options]
 */
export async function parseGatewayStream(body: ReadableStream<Uint8Array> | null, contentType: string | null, options: StreamParseOptions = {}) {
  if (!body) {
    return emptyResponse();
  }

  const records = contentType?.includes("text/event-stream")
    ? await parseServerSentEvents(body, options)
    : await parseNewlineDelimitedJson(body, options);

  return finalizeStreamRecords(records);
}

/**
 * @param {unknown[]} records
 * @param {{ onEvent?: (event: Record<string, any>) => void | Promise<void> }} [options]
 */
export async function normalizeStreamRecords(records: unknown[], options: { onEvent?: GatewayEventHandler } = {}) {
  const response = emptyResponse();

  for (const record of records) {
    await applyStreamRecord(response, record, options);
  }

  response.raw = records as unknown as Record<string, unknown>;
  return response;
}

/**
 * @param {unknown[]} records
 */
function finalizeStreamRecords(records: unknown[]) {
  const response = emptyResponse();
  for (const record of records) {
    applyStreamRecordPayload(response, record);
  }
  response.raw = records as unknown as Record<string, unknown>;
  return response;
}

/**
 * @param {ReadableStream<Uint8Array>} body
 * @param {{ onEvent?: (event: Record<string, any>) => void | Promise<void> }} [options]
 */
async function parseServerSentEvents(body: ReadableStream<Uint8Array>, options: StreamParseOptions = {}) {
  const records: unknown[] = [];
  const response = emptyResponse();
  let text = "";
  for await (const chunk of streamTextChunks(body, options)) {
    text += chunk;
    const parts = text.split(/\r?\n\r?\n/);
    text = parts.pop() ?? "";
    assertGatewayStreamRecordSize(text);
    for (const eventText of parts) {
      assertGatewayStreamRecordSize(eventText);
      await consumeServerSentEvent(eventText, records, response, options);
    }
  }
  if (text.trim()) {
    assertGatewayStreamRecordSize(text);
    await consumeServerSentEvent(text, records, response, options);
  }
  return records;
}

/**
 * @param {string} eventText
 * @param {unknown[]} records
 * @param {import("./protocol.ts").NormalizedGatewayResponse} response
 * @param {{ onEvent?: (event: Record<string, any>) => void | Promise<void> }} [options]
 */
async function consumeServerSentEvent(eventText: string, records: unknown[], response: NormalizedGatewayResponse, options: StreamParseOptions = {}) {
  const data = eventText
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .join("\n");

  if (!data || data === "[DONE]") {
    return;
  }
  const record = JSON.parse(data);
  records.push(record);
  await applyStreamRecord(response, record, options);
}

/**
 * @param {ReadableStream<Uint8Array>} body
 * @param {{ onEvent?: (event: Record<string, any>) => void | Promise<void> }} [options]
 */
async function parseNewlineDelimitedJson(body: ReadableStream<Uint8Array>, options: StreamParseOptions = {}) {
  const records: unknown[] = [];
  const response = emptyResponse();
  let text = "";
  for await (const chunk of streamTextChunks(body, options)) {
    text += chunk;
    const lines = text.split(/\r?\n/);
    text = lines.pop() ?? "";
    assertGatewayStreamRecordSize(text);
    for (const line of lines) {
      assertGatewayStreamRecordSize(line);
      await consumeJsonLine(line, records, response, options);
    }
  }
  if (text.trim()) {
    assertGatewayStreamRecordSize(text);
    await consumeJsonLine(text, records, response, options);
  }
  return records;
}

/**
 * @param {string} line
 * @param {unknown[]} records
 * @param {import("./protocol.ts").NormalizedGatewayResponse} response
 * @param {{ onEvent?: (event: Record<string, any>) => void | Promise<void> }} [options]
 */
async function consumeJsonLine(line: string, records: unknown[], response: NormalizedGatewayResponse, options: StreamParseOptions = {}) {
  const data = line.trim();
  if (!data || data === "[DONE]") {
    return;
  }
  const record = JSON.parse(data);
  records.push(record);
  await applyStreamRecord(response, record, options);
}

/**
 * @param {import("./protocol.ts").NormalizedGatewayResponse} response
 * @param {unknown} record
 * @param {{ onEvent?: (event: Record<string, any>) => void | Promise<void> }} [options]
 */
async function applyStreamRecord(response: NormalizedGatewayResponse, record: unknown, options: StreamParseOptions = {}) {
  const event = applyStreamRecordPayload(response, record);
  if (event) {
    await emitStreamEvent(options.onEvent, event, options);
  }
}

/**
 * @param {import("./protocol.ts").NormalizedGatewayResponse} response
 * @param {unknown} record
 * @returns {Record<string, any> | null}
 */
function applyStreamRecordPayload(response: NormalizedGatewayResponse, record: unknown): Record<string, unknown> | null {
  if (!record || typeof record !== "object") {
    return null;
  }
  const value = record as Record<string, unknown>;
  const type = value.type ?? value.event;
  const delta = objectRecord(value.delta);

  if (type === "message_start") {
    response.id = typeof value.id === "string" ? value.id : response.id;
    response.model = typeof value.model === "string" ? value.model : response.model;
    return {
      type: "message_start",
      id: response.id,
      model: response.model
    };
  } else if (type === "text_delta" || type === "content_delta") {
    const text = appendText(response, value.text ?? delta?.text);
    if (text) {
      return {
        type: "text_delta",
        text
      };
    }
  } else if (type === "thinking_delta") {
    const text = typeof value.text === "string" ? value.text : delta?.text;
    if (typeof text === "string" && text.length > 0) {
      return {
        type: "thinking_delta",
        text
      };
    }
  } else if (type === "tool_call_delta") {
    return {
      type: "tool_call_delta",
      index: Number.isInteger(value.index) ? value.index : null,
      id: typeof value.id === "string" ? value.id : null,
      nameDelta: typeof value.nameDelta === "string" ? value.nameDelta : "",
      argumentsDelta: typeof value.argumentsDelta === "string" ? value.argumentsDelta : ""
    };
  } else if (type === "message_delta") {
    response.stopReason = typeof value.stopReason === "string" ? value.stopReason : response.stopReason;
    response.usage = value.usage && typeof value.usage === "object" ? value.usage as Record<string, unknown> : response.usage;
  } else if (type === "message_stop") {
    response.stopReason = response.stopReason ?? "stop";
    return {
      type: "message_stop",
      stopReason: response.stopReason
    };
  } else if ("content" in value) {
    const normalized = normalizeGatewayResponse(value);
    for (const block of normalized.content) {
      appendText(response, block.text);
    }
    response.id = normalized.id ?? response.id;
    response.model = normalized.model ?? response.model;
    response.stopReason = normalized.stopReason ?? response.stopReason;
    response.usage = normalized.usage ?? response.usage;
  }
  return null;
}

/**
 * @param {ReadableStream<Uint8Array>} body
 */
async function* streamTextChunks(body: ReadableStream<Uint8Array>, options: StreamReadOptions = {}) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const maxResponseBytes = normalizeGatewayMaxResponseBytes(options.maxResponseBytes);
  let receivedBytes = 0;
  let completed = false;
  try {
    while (true) {
      const { done, value } = await readStreamChunk(reader, options);
      if (done) {
        completed = true;
        break;
      }
      const chunkBytes = Number(value?.byteLength ?? 0);
      if (chunkBytes > maxResponseBytes - receivedBytes) {
        throw gatewayResponseLimitError(
          "GATEWAY_RESPONSE_TOO_LARGE",
          maxResponseBytes,
          receivedBytes + chunkBytes
        );
      }
      receivedBytes += chunkBytes;
      yield decoder.decode(value, { stream: true });
    }
  } finally {
    if (!completed) {
      cancelReader(reader, options.signal?.reason ?? new Error("Gateway stream consumer stopped before completion"));
    }
    try {
      reader.releaseLock();
    } catch {
      // Reader may already be released after stream completion.
    }
  }
  const rest = decoder.decode();
  if (rest) {
    yield rest;
  }
}

function readStreamChunk(reader: StreamReader, options: StreamReadOptions = {}) {
  const signal = options.signal;
  const idleTimeoutMs = typeof options.idleTimeoutMs === "number" && Number.isFinite(options.idleTimeoutMs)
    ? Math.max(1000, Math.trunc(options.idleTimeoutMs))
    : null;
  if (signal?.aborted) {
    return Promise.reject(abortError(signal.reason));
  }
  if (!idleTimeoutMs && !signal) {
    return reader.read();
  }
  return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    let settled = false;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let timer: ReturnType<typeof setTimeout> | null = null;
    /** @type {(() => void) | null} */
    let onAbort: (() => void) | null = null;
    const finish = (ok: boolean, value: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      if (ok) {
        resolve(value as ReadableStreamReadResult<Uint8Array>);
      } else {
        reject(value);
      }
    };
    if (idleTimeoutMs) {
      timer = setTimeout(() => {
        cancelReader(reader, timeoutError(idleTimeoutMs));
        finish(false, timeoutError(idleTimeoutMs));
      }, idleTimeoutMs);
    }
    if (signal) {
      onAbort = () => {
        cancelReader(reader, signal.reason);
        finish(false, abortError(signal.reason));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
    }
    Promise.resolve().then(() => reader.read()).then(
      (chunk) => finish(true, chunk),
      (error: unknown) => finish(false, error)
    );
  });
}

function cancelReader(reader: StreamReader, reason: unknown) {
  try {
    Promise.resolve(reader.cancel(reason)).catch(() => {});
  } catch {
    // Best effort.
  }
}

function abortError(reason: unknown) {
  if (reason instanceof Error) {
    return reason;
  }
  const error = new Error("stream read aborted");
  error.name = "AbortError";
  return error;
}

function timeoutError(ms: unknown) {
  const error: GatewayProtocolError = new Error(`Gateway stream idle timeout after ${ms}ms`);
  error.name = "AbortError";
  error.code = "GATEWAY_STREAM_IDLE_TIMEOUT";
  return error;
}

/**
 * @param {import("./protocol.ts").NormalizedGatewayResponse} response
 * @param {unknown} text
 */
function appendText(response: NormalizedGatewayResponse, text: unknown) {
  if (typeof text !== "string" || text.length === 0) {
    return "";
  }
  response.content.push({ type: "text", text });
  response.text += text;
  return text;
}

/**
 * @param {(event: Record<string, any>) => void | Promise<void>} [onEvent]
 * @param {Record<string, any>} event
 * @param {{ signal?: AbortSignal; eventTimeoutMs?: number }} [options]
 */
async function emitStreamEvent(onEvent: GatewayEventHandler | undefined, event: Record<string, unknown>, options: { signal?: AbortSignal; eventTimeoutMs?: number } = {}) {
  await emitGatewayEvent(onEvent, event, {
    signal: options.signal,
    timeoutMs: options.eventTimeoutMs
  });
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && value !== undefined && typeof value === "object"
    ? value as Record<string, unknown>
    : undefined;
}
