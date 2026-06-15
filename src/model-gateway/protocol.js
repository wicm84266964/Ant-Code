export const GATEWAY_PROTOCOL_VERSION = "lab-agent-gateway.v1";

/**
 * @typedef {{ type: "text"; text: string }} TextBlock
 * @typedef {{ type: "image"; data?: string; mimeType?: string; name?: string; size?: number; redacted?: boolean }} ImageBlock
 * @typedef {{ id: string; name: string; input: Record<string, any> }} GatewayToolCall
 * @typedef {{
 *   id: string | null;
 *   model: string | null;
 *   content: TextBlock[];
 *   text: string;
 *   toolCalls: GatewayToolCall[];
 *   stopReason: string | null;
 *   usage: Record<string, any> | null;
 *   raw?: unknown;
 * }} NormalizedGatewayResponse
 */

/**
 * @param {{
 *   model: string;
 *   messages: Array<Record<string, any>>;
 *   tools?: Array<Record<string, any>>;
 *   sessionId?: string;
 *   stream?: boolean;
 *   toolResults?: Array<Record<string, any>>;
 * }} input
 */
export function createGatewayRequest(input) {
  const capabilities = {
    tools: true,
    toolResults: true,
    streaming: Boolean(input.stream)
  };
  if (requestIncludesImages(input.messages)) {
    capabilities.images = true;
  }
  return {
    protocolVersion: GATEWAY_PROTOCOL_VERSION,
    model: input.model,
    messages: input.messages,
    tools: input.tools ?? [],
    toolResults: input.toolResults ?? [],
    stream: Boolean(input.stream),
    metadata: {
      client: "lab-agent",
      sessionId: input.sessionId ?? null,
      capabilities,
      boundary: {
        toolExecution: "local-client",
        providerCredentials: "gateway-only",
        remoteTools: false
      },
      request: {
        messageCount: input.messages.length,
        toolCount: (input.tools ?? []).length,
        toolResultCount: (input.toolResults ?? []).length
      }
    }
  };
}

function requestIncludesImages(messages = []) {
  if (!Array.isArray(messages)) {
    return false;
  }
  return messages.some((message) => {
    const content = message?.content;
    return Array.isArray(content) && content.some((item) => item && typeof item === "object" && item.type === "image");
  });
}

/**
 * Normalize the lab gateway response shape into the internal assistant result.
 *
 * @param {unknown} raw
 * @returns {NormalizedGatewayResponse}
 */
export function normalizeGatewayResponse(raw) {
  if (!raw || typeof raw !== "object") {
    return emptyResponse(raw);
  }

  const value = /** @type {Record<string, any>} */ (raw);
  const content = normalizeContent(value.content ?? value.output ?? value.message?.content);
  const text = content.map((block) => block.text).join("");

  return {
    id: typeof value.id === "string" ? value.id : null,
    model: typeof value.model === "string" ? value.model : null,
    content,
    text,
    toolCalls: normalizeToolCalls(value.toolCalls ?? value.tool_calls ?? value.message?.toolCalls),
    stopReason: normalizeStopReason(value.stopReason ?? value.stop_reason),
    usage: isPlainObject(value.usage) ? value.usage : null,
    raw
  };
}

/**
 * @param {unknown} raw
 */
export function emptyResponse(raw = null) {
  return {
    id: null,
    model: null,
    content: [],
    text: "",
    toolCalls: [],
    stopReason: null,
    usage: null,
    raw
  };
}

/**
 * @param {unknown} value
 * @returns {TextBlock[]}
 */
export function normalizeContent(value) {
  if (typeof value === "string") {
    return [{ type: "text", text: value }];
  }

  if (!Array.isArray(value)) {
    return [];
  }

  const blocks = [];
  for (const item of value) {
    if (typeof item === "string") {
      blocks.push({ type: "text", text: item });
    } else if (isPlainObject(item) && item.type === "text" && typeof item.text === "string") {
      blocks.push({ type: "text", text: item.text });
    }
  }
  return blocks;
}

/**
 * @param {unknown} value
 * @returns {GatewayToolCall[]}
 */
function normalizeToolCalls(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item) => isPlainObject(item) && typeof item.name === "string")
    .map((item, index) => ({
      id: typeof item.id === "string" ? item.id : `tool-${index + 1}`,
      name: item.name,
      input: isPlainObject(item.input) ? item.input : {}
    }));
}

/**
 * @param {unknown} value
 */
function normalizeStopReason(value) {
  return typeof value === "string" ? value : null;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
