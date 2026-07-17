const DEFAULT_GATEWAY_EVENT_TIMEOUT_MS = 30_000;

/**
 * Await a gateway event consumer without allowing it to outlive cancellation or
 * hold the transport open forever. Consumer errors remain authoritative.
 *
 * @param {((event: Record<string, any>) => void | Promise<void>) | undefined} onEvent
 * @param {Record<string, any>} event
 * @param {{ signal?: AbortSignal; timeoutMs?: number }} [options]
 */
export async function emitGatewayEvent(onEvent, event, options = {}) {
  if (!onEvent) {
    return;
  }
  const signal = options.signal;
  if (signal?.aborted) {
    throw gatewayEventAbortError(signal.reason);
  }
  const timeoutMs = gatewayEventTimeoutMs(options.timeoutMs);
  let timer = null;
  let onAbort = null;
  const boundary = new Promise((_, reject) => {
    timer = setTimeout(() => reject(gatewayEventTimeoutError(timeoutMs)), timeoutMs);
    if (signal) {
      onAbort = () => reject(gatewayEventAbortError(signal.reason));
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  try {
    await Promise.race([
      Promise.resolve()
        .then(() => onEvent(event))
        .catch((error) => Promise.reject(markGatewayEventCallbackError(error))),
      boundary
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/** @param {unknown} error */
export function isGatewayEventCallbackError(error) {
  return Boolean(error && typeof error === "object" && error.gatewayEventCallback === true);
}

function gatewayEventTimeoutMs(value) {
  const number = Number(value ?? DEFAULT_GATEWAY_EVENT_TIMEOUT_MS);
  if (!Number.isFinite(number)) {
    return DEFAULT_GATEWAY_EVENT_TIMEOUT_MS;
  }
  return Math.max(1, Math.min(DEFAULT_GATEWAY_EVENT_TIMEOUT_MS, Math.trunc(number)));
}

function gatewayEventAbortError(reason) {
  if (reason instanceof Error) {
    return reason;
  }
  const error = new Error(reason ? String(reason) : "Gateway event delivery was aborted");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

function gatewayEventTimeoutError(timeoutMs) {
  const error = new Error(`Gateway event callback timed out after ${timeoutMs}ms`);
  error.name = "TimeoutError";
  error.code = "GATEWAY_EVENT_CALLBACK_TIMEOUT";
  error.gatewayEventCallback = true;
  return error;
}

function markGatewayEventCallbackError(error) {
  const callbackError = error && typeof error === "object"
    ? error
    : new Error(String(error ?? "Gateway event callback failed"));
  try {
    Object.defineProperty(callbackError, "gatewayEventCallback", {
      value: true,
      configurable: true
    });
  } catch {
    callbackError.gatewayEventCallback = true;
  }
  return callbackError;
}
