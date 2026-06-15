import { emptyResponse, normalizeGatewayResponse } from "./protocol.js";

/**
 * Parse a lab gateway streaming response.
 *
 * MVP supports two lab-owned streaming encodings:
 * - text/event-stream with `data: {...}` records
 * - application/x-ndjson with one JSON object per line
 *
 * @param {ReadableStream<Uint8Array> | null} body
 * @param {string | null} contentType
 * @param {{ onEvent?: (event: Record<string, any>) => void | Promise<void> }} [options]
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
  for await (const chunk of streamTextChunks(body)) {
    text += chunk;
    const parts = text.split(/\r?\n\r?\n/);
    text = parts.pop() ?? "";
    for (const eventText of parts) {
      await consumeServerSentEvent(eventText, records, response, options);
    }
  }
  if (text.trim()) {
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
  for await (const chunk of streamTextChunks(body)) {
    text += chunk;
    const lines = text.split(/\r?\n/);
    text = lines.pop() ?? "";
    for (const line of lines) {
      await consumeJsonLine(line, records, response, options);
    }
  }
  if (text.trim()) {
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
    await emitStreamEvent(options.onEvent, event);
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
async function* streamTextChunks(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    yield decoder.decode(value, { stream: true });
  }
  const rest = decoder.decode();
  if (rest) {
    yield rest;
  }
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
 */
async function emitStreamEvent(onEvent, event) {
  if (!onEvent) {
    return;
  }
  await onEvent(event);
}
