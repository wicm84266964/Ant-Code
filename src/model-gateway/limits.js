import { Buffer } from "node:buffer";

export const DEFAULT_GATEWAY_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
export const GATEWAY_MAX_STREAM_RECORD_BYTES = 8 * 1024 * 1024;
export const GATEWAY_MAX_ERROR_BODY_BYTES = 64 * 1024;

const LIMIT_CODES = new Set([
  "GATEWAY_RESPONSE_TOO_LARGE",
  "GATEWAY_STREAM_RECORD_TOO_LARGE",
  "GATEWAY_ERROR_BODY_TOO_LARGE"
]);

/**
 * @param {string} code
 * @param {number} maxBytes
 * @param {number} receivedBytes
 */
export function gatewayResponseLimitError(code, maxBytes, receivedBytes) {
  const scope = code === "GATEWAY_STREAM_RECORD_TOO_LARGE"
    ? "Gateway stream record"
    : code === "GATEWAY_ERROR_BODY_TOO_LARGE"
      ? "Gateway error response body"
      : "Gateway response body";
  return Object.assign(new Error(`${scope} exceeded the ${maxBytes} byte limit.`), {
    name: "GatewayResponseLimitError",
    code,
    maxBytes,
    receivedBytes,
    retryable: false
  });
}

/** @param {unknown} error @returns {string | null} */
export function gatewayResponseLimitCode(error) {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return null;
  }
  const code = String(error.code ?? "");
  return LIMIT_CODES.has(code) ? code : null;
}

/** @param {unknown} error */
export function gatewayResponseLimitDetails(error) {
  if (!gatewayResponseLimitCode(error) || !error || typeof error !== "object") {
    return {};
  }
  return {
    maxBytes: "maxBytes" in error ? Number(error.maxBytes) : null,
    receivedBytes: "receivedBytes" in error ? Number(error.receivedBytes) : null,
    retryable: false
  };
}

/** @param {unknown} value @param {number} [maxBytes] */
export function assertGatewayStreamRecordSize(value, maxBytes = GATEWAY_MAX_STREAM_RECORD_BYTES) {
  const receivedBytes = Buffer.byteLength(String(value ?? ""), "utf8");
  if (receivedBytes > maxBytes) {
    throw gatewayResponseLimitError("GATEWAY_STREAM_RECORD_TOO_LARGE", maxBytes, receivedBytes);
  }
}

/** @param {unknown} value @param {number} [fallback] */
export function normalizeGatewayMaxResponseBytes(value, fallback = DEFAULT_GATEWAY_MAX_RESPONSE_BYTES) {
  const bytes = Number(value);
  return Number.isFinite(bytes) && bytes > 0 ? Math.max(1, Math.trunc(bytes)) : fallback;
}
