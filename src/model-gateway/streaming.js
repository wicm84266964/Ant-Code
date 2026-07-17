import { emptyResponse, normalizeGatewayResponse } from "./protocol.js";
import { emitGatewayEvent } from "./event-callback.js";
import {
  assertGatewayStreamRecordSize,
  gatewayResponseLimitError,
  normalizeGatewayMaxResponseBytes
} from "./limits.js";

/**
 * Parse a lab gateway streaming response.
 *
 * MVP supports two lab-owned streaming encodings:
 * - text/event-stream with `data: {...}` records
 * - application/x-ndjson with one JSON object per line
 *
 * @param {ReadableStream<Uint8Array> | null} body
 * @param {string | null} contentType
 * @param {{ onEvent?: (event: Record<string, any>) => void | Promise<void>; signal?: AbortSignal; idleTimeoutMs?: number; eventTimeoutMs?: number; maxResponseBytes?: number }} [options]
 */
export async function parseGatewayStream(body, contentType, options = {}) {
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
export async function normalizeStreamRecords(records, options = {}) {
  const response = emptyResponse();

  for (const record of records) {
    await applyStreamRecord(response, record, options);
  }

  response.raw = records;
  return response;
}

/**
 * @param {unknown[]} records
 */
function finalizeStreamRecords(records) {
  const response = emptyResponse();
  for (const record of records) {
    applyStreamRecordPayload(response, record);
  }
  response.raw = records;
  return response;
}

/**
 * @param {ReadableStream<Uint8Array>} body
 * @param {{ onEvent?: (event: Record<string, any>) => void | Promise<void> }} [options]
 */
async function parseServerSentEvents(body, options = {}) {
  const records = [];
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
 * @param {import("./protocol.js").NormalizedGatewayResponse} response
 * @param {{ onEvent?: (event: Record<string, any>) => void | Promise<void> }} [options]
 */
async function consumeServerSentEvent(eventText, records, response, options = {}) {
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
async function parseNewlineDelimitedJson(body, options = {}) {
  const records = [];
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
 * @param {import("./protocol.js").NormalizedGatewayResponse} response
 * @param {{ onEvent?: (event: Record<string, any>) => void | Promise<void> }} [options]
 */
async function consumeJsonLine(line, records, response, options = {}) {
  const data = line.trim();
  if (!data || data === "[DONE]") {
    return;
  }
  const record = JSON.parse(data);
  records.push(record);
  await applyStreamRecord(response, record, options);
}

/**
 * @param {import("./protocol.js").NormalizedGatewayResponse} response
 * @param {unknown} record
 * @param {{ onEvent?: (event: Record<string, any>) => void | Promise<void> }} [options]
 */
async function applyStreamRecord(response, record, options = {}) {
  const event = applyStreamRecordPayload(response, record);
  if (event) {
    await emitStreamEvent(options.onEvent, event, options);
  }
}

/**
 * @param {import("./protocol.js").NormalizedGatewayResponse} response
 * @param {unknown} record
 * @returns {Record<string, any> | null}
 */
function applyStreamRecordPayload(response, record) {
  if (!record || typeof record !== "object") {
    return null;
  }
  const value = /** @type {Record<string, any>} */ (record);
  const type = value.type ?? value.event;

  if (type === "message_start") {
    response.id = typeof value.id === "string" ? value.id : response.id;
    response.model = typeof value.model === "string" ? value.model : response.model;
    return {
      type: "message_start",
      id: response.id,
      model: response.model
    };
  } else if (type === "text_delta" || type === "content_delta") {
    const text = appendText(response, value.text ?? value.delta?.text);
    if (text) {
      return {
        type: "text_delta",
        text
      };
    }
  } else if (type === "thinking_delta") {
    const text = typeof value.text === "string" ? value.text : value.delta?.text;
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
    response.usage = value.usage && typeof value.usage === "object" ? value.usage : response.usage;
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
async function* streamTextChunks(body, options = {}) {
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

function readStreamChunk(reader, options = {}) {
  const signal = options.signal;
  const idleTimeoutMs = Number.isFinite(options.idleTimeoutMs) ? Math.max(1000, Math.trunc(options.idleTimeoutMs)) : null;
  if (signal?.aborted) {
    return Promise.reject(abortError(signal.reason));
  }
  if (!idleTimeoutMs && !signal) {
    return reader.read();
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let timer = null;
    /** @type {(() => void) | null} */
    let onAbort = null;
    const finish = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener?.("abort", onAbort);
      callback(value);
    };
    if (idleTimeoutMs) {
      timer = setTimeout(() => {
        cancelReader(reader, timeoutError(idleTimeoutMs));
        finish(reject, timeoutError(idleTimeoutMs));
      }, idleTimeoutMs);
    }
    if (signal) {
      onAbort = () => {
        cancelReader(reader, signal.reason);
        finish(reject, abortError(signal.reason));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
    }
    Promise.resolve().then(() => reader.read()).then(
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
 * @param {import("./protocol.js").NormalizedGatewayResponse} response
 * @param {unknown} text
 */
function appendText(response, text) {
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
async function emitStreamEvent(onEvent, event, options = {}) {
  await emitGatewayEvent(onEvent, event, {
    signal: options.signal,
    timeoutMs: options.eventTimeoutMs
  });
}
