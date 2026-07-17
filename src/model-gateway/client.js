import { decideNetworkAccess } from "../permissions/network-policy.js";
import { isGatewayStreamInterruptedError, normalizeGatewayError, redactGatewayText } from "./errors.js";
import {
  createOpenAIChatCompletionRequest,
  normalizeOpenAIChatCompletionResponse,
  parseOpenAIChatCompletionStream
} from "./openai-chat.js";
import { listConfiguredModels } from "./models.js";
import { createGatewayRequest, normalizeGatewayResponse } from "./protocol.js";
import { parseGatewayStream } from "./streaming.js";
import { emitGatewayEvent, isGatewayEventCallbackError } from "./event-callback.js";
import {
  DEFAULT_GATEWAY_MAX_RESPONSE_BYTES,
  GATEWAY_MAX_ERROR_BODY_BYTES,
  gatewayResponseLimitCode,
  gatewayResponseLimitDetails,
  gatewayResponseLimitError,
  normalizeGatewayMaxResponseBytes
} from "./limits.js";

const DEFAULT_GATEWAY_MAX_RETRIES = 5;
const DEFAULT_GATEWAY_TIMEOUT_MS = 900000;
const DEFAULT_GATEWAY_IDLE_TIMEOUT_MS = 300000;
const BASE_RETRY_DELAY_MS = 200;
const MAX_RETRY_DELAY_MS = 30000;
const GATEWAY_TRANSIENT_ERROR_PATTERN = /KVTransferError|WaitingForInput|Decode transfer failed|premature close|stream.*interrupted/i;
const RETRYABLE_STREAM_PROTOCOL_CODES = new Set(["UPSTREAM_STREAM_ABORTED", "INCOMPLETE_TOOL_CALL"]);

/**
 * @param {import("../config/load-config.js").LabAgentConfig} config
 */
export function createLabModelGateway(config) {
  return {
    configured: Boolean(config.lab.gatewayUrl),
    /**
     * @param {{ messages: Array<Record<string, any>>; tools?: Array<Record<string, any>>; toolResults?: Array<Record<string, any>>; sessionId?: string; stream?: boolean; signal?: AbortSignal; onEvent?: (event: Record<string, any>) => void | Promise<void> }} request
     */
    async sendChat(request) {
      if (!config.lab.gatewayUrl) {
        return {
          ok: false,
          error: normalizeGatewayError(null, {
            code: "GATEWAY_NOT_CONFIGURED",
            message: "LAB_MODEL_GATEWAY_URL is not configured"
          })
        };
      }

      const networkDecision = decideNetworkAccess({
        url: config.lab.gatewayUrl,
        networkMode: config.networkMode,
        allowedHosts: config.allowedHosts
      });

      if (networkDecision.decision !== "allow") {
        return {
          ok: false,
          blocked: true,
          decision: networkDecision,
          error: normalizeGatewayError(null, {
            code: "GATEWAY_NETWORK_BLOCKED",
            message: networkDecision.reason
          })
        };
      }

      const protocol = config.lab.gatewayProtocol ?? "lab-agent-gateway";
      const requestInput = {
        model: config.modelAlias,
        messages: request.messages,
        tools: request.tools ?? [],
        toolResults: request.toolResults ?? [],
        stream: Boolean(request.stream),
        sessionId: request.sessionId,
        extraBody: protocol === "openai-chat" ? resolveOpenAIExtraBody(config) : null
      };
      const gatewayRequest = protocol === "openai-chat"
        ? createOpenAIChatCompletionRequest(requestInput)
        : createGatewayRequest(requestInput);

      const maxRetries = resolveGatewayMaxRetries(config);
      const maxAttempts = maxRetries + 1;
      const timeoutMs = resolveGatewayTimeoutMs(config);
      const idleTimeoutMs = resolveGatewayIdleTimeoutMs(config);
      const maxResponseBytes = resolveGatewayMaxResponseBytes(config);
      const retryHistory = [];
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        let response;
        const startedAt = Date.now();
        const attemptAbort = createGatewayAttemptAbort(request.signal, timeoutMs);
        try {
          response = await fetch(config.lab.gatewayUrl, {
            method: "POST",
            headers: createHeaders(config, request.sessionId),
            body: JSON.stringify(gatewayRequest),
            signal: attemptAbort.signal
          });
        } catch (error) {
          attemptAbort.cleanup();
          const retryable = shouldRetryGatewayFetchError(error, {
            attempt,
            maxAttempts,
            signal: attemptAbort.signal
          });
          retryHistory.push(errorRetrySummary(error, attempt, retryable, "fetch"));
          if (!retryable) {
            return {
              ok: false,
              error: normalizeGatewayError(error, {
                code: attemptAbort.timedOut ? "GATEWAY_TIMEOUT" : undefined,
                message: attemptAbort.timedOut ? `Gateway request timed out after ${timeoutMs}ms` : undefined,
                details: {
                  attempts: attempt,
                  maxAttempts,
                  retryable: false,
                  timeoutMs,
                  retryHistory
                }
              })
            };
          }
          const retry = await emitRetryAndDelay(request, {
            attempt,
            maxAttempts,
            retryHistory,
            delayMs: retryDelayMs(attempt),
            error,
            stage: "fetch"
          });
          if (retry.eventError) {
            return gatewayEventCallbackFailure(retry.eventError, { attempts: attempt, maxAttempts, stage: "fetch", retryHistory });
          }
          if (!retry.delayed) {
            return abortedRetryError(attempt, maxAttempts, retryHistory);
          }
          continue;
        }

        const responseHeaderMs = Date.now() - startedAt;
        if (!response.ok) {
          let errorBody;
          try {
            errorBody = await boundedResponseText(response, {
              signal: attemptAbort.signal,
              idleTimeoutMs,
              maxResponseBytes: GATEWAY_MAX_ERROR_BODY_BYTES
            });
          } catch (error) {
            attemptAbort.cleanup();
            const retryable = shouldRetryGatewayFetchError(error, {
              attempt,
              maxAttempts,
              signal: attemptAbort.signal
            });
            retryHistory.push(errorRetrySummary(error, attempt, retryable, "http_body"));
            if (!retryable) {
              const limitCode = gatewayResponseLimitCode(error);
              return {
                ok: false,
                error: normalizeGatewayError(error, {
                  code: attemptAbort.timedOut ? "GATEWAY_TIMEOUT" : limitCode ?? undefined,
                  message: attemptAbort.timedOut
                    ? `Gateway request timed out after ${timeoutMs}ms`
                    : limitCode
                      ? error instanceof Error ? error.message : String(error)
                      : undefined,
                  details: {
                    attempts: attempt,
                    maxAttempts,
                    retryable: false,
                    responseHeaderMs,
                    timeoutMs,
                    idleTimeoutMs,
                    ...gatewayResponseLimitDetails(error),
                    retryHistory
                  }
                })
              };
            }
            const retry = await emitRetryAndDelay(request, {
              attempt,
              maxAttempts,
              retryHistory,
              delayMs: retryDelayMs(attempt),
              error,
              stage: "http_body"
            });
            if (retry.eventError) {
              return gatewayEventCallbackFailure(retry.eventError, { attempts: attempt, maxAttempts, stage: "http_body", retryHistory });
            }
            if (!retry.delayed) {
              return abortedRetryError(attempt, maxAttempts, retryHistory);
            }
            continue;
          } finally {
            attemptAbort.cleanup();
          }
          const error = normalizeGatewayError(null, {
            code: "GATEWAY_HTTP_ERROR",
            message: `Gateway returned HTTP ${response.status}`,
            status: response.status,
            protocol,
            details: {
              body: errorBody.body,
              bodyTruncated: errorBody.truncated,
              bodyLimitCode: errorBody.truncated ? "GATEWAY_ERROR_BODY_TOO_LARGE" : null,
              bodyMaxBytes: GATEWAY_MAX_ERROR_BODY_BYTES,
              bodyReceivedBytes: errorBody.receivedBytes,
              ...(errorBody.truncated ? { retryable: false } : {}),
              attempts: attempt,
              maxAttempts,
              responseHeaderMs,
              retryHistory
            }
          });
          const retryable = shouldRetryGatewayHttpError(error, {
            attempt,
            maxAttempts,
            config,
            signal: request.signal
          });
          retryHistory.push(gatewayErrorRetrySummary(error, attempt, retryable, "http"));
          if (!retryable) {
            return { ok: false, error };
          }
          const retry = await emitRetryAndDelay(request, {
            attempt,
            maxAttempts,
            retryHistory,
            delayMs: retryDelayMs(attempt),
            error,
            stage: "http"
          });
          if (retry.eventError) {
            return gatewayEventCallbackFailure(retry.eventError, { attempts: attempt, maxAttempts, stage: "http", retryHistory });
          }
          if (!retry.delayed) {
            return abortedRetryError(attempt, maxAttempts, retryHistory);
          }
          continue;
        }

        let data;
        try {
          const contentType = response.headers.get("content-type");
          data = await parseResponseForProtocol(protocol, response, contentType, request.onEvent, config, {
            signal: attemptAbort.signal,
            idleTimeoutMs,
            maxResponseBytes
          });
          attemptAbort.cleanup();
        } catch (error) {
          attemptAbort.cleanup();
          const contentType = response.headers.get("content-type") ?? "";
          if (isGatewayEventCallbackError(error)) {
            return gatewayEventCallbackFailure(error, {
              attempts: attempt,
              maxAttempts,
              stage: "parse_body",
              contentType,
              retryHistory
            });
          }
          const streamError = /** @type {{ retryable?: boolean; details?: Record<string, any> }} */ (error);
          const limitCode = gatewayResponseLimitCode(error);
          const streamProtocolCode = gatewayStreamProtocolCode(error);
          const streamInterrupted = isGatewayStreamInterruptedError(error);
          const normalized = normalizeGatewayError(error, {
            code: attemptAbort.timedOut
              ? "GATEWAY_TIMEOUT"
              : limitCode ?? streamProtocolCode ?? (streamInterrupted ? "GATEWAY_STREAM_INTERRUPTED" : "GATEWAY_RESPONSE_PARSE_ERROR"),
            message: attemptAbort.timedOut
              ? `Gateway request timed out after ${timeoutMs}ms`
              : limitCode
                ? error instanceof Error ? error.message : String(error)
              : streamProtocolCode
                ? error instanceof Error ? error.message : String(error)
              : streamInterrupted
                ? "Gateway response stream was interrupted before it could be fully read"
                : "Gateway response could not be parsed",
            details: {
              protocol,
              contentType,
              bodyPreview: error?.gatewayBodyPreview ?? undefined,
              responseReadStage: streamInterrupted ? "read_body" : "parse_body",
              attempts: attempt,
              maxAttempts,
              responseHeaderMs,
              timeoutMs,
              idleTimeoutMs,
              ...(streamProtocolCode ? {
                retryable: streamError?.retryable === true,
                streamReason: streamError?.details?.reason ?? null,
                toolIndex: streamError?.details?.toolIndex ?? null,
                toolName: streamError?.details?.toolName ?? null
              } : {}),
              ...gatewayResponseLimitDetails(error),
              retryHistory
            }
          });
          const retryable = shouldRetryGatewayResponseError(normalized, {
            attempt,
            maxAttempts,
            config,
            signal: request.signal
          });
          retryHistory.push(gatewayErrorRetrySummary(normalized, attempt, retryable, limitCode || streamInterrupted ? "read_body" : "parse_body"));
          if (!retryable) {
            return { ok: false, error: normalized };
          }
          const retry = await emitRetryAndDelay(request, {
            attempt,
            maxAttempts,
            retryHistory,
            delayMs: retryDelayMs(attempt),
            error: normalized,
            stage: limitCode || streamInterrupted ? "read_body" : "parse_body"
          });
          if (retry.eventError) {
            return gatewayEventCallbackFailure(retry.eventError, {
              attempts: attempt,
              maxAttempts,
              stage: limitCode || streamInterrupted ? "read_body" : "parse_body",
              retryHistory
            });
          }
          if (!retry.delayed) {
            return abortedRetryError(attempt, maxAttempts, retryHistory);
          }
          continue;
        }

        return { ok: true, data };
      }

      return abortedRetryError(maxAttempts, maxAttempts, retryHistory);
    }
  };
}

/**
 * @param {import("../config/load-config.js").LabAgentConfig} config
 */
function resolveGatewayMaxRetries(config) {
  const value = Number(config.lab?.gatewayMaxRetries ?? DEFAULT_GATEWAY_MAX_RETRIES);
  if (!Number.isFinite(value)) {
    return DEFAULT_GATEWAY_MAX_RETRIES;
  }
  return Math.max(0, Math.min(5, Math.trunc(value)));
}

/**
 * @param {import("../config/load-config.js").LabAgentConfig} config
 */
function resolveGatewayTimeoutMs(config) {
  const value = Number(config.lab?.gatewayTimeoutMs ?? DEFAULT_GATEWAY_TIMEOUT_MS);
  if (!Number.isFinite(value)) {
    return DEFAULT_GATEWAY_TIMEOUT_MS;
  }
  return Math.max(50, Math.min(900000, Math.trunc(value)));
}

/**
 * @param {import("../config/load-config.js").LabAgentConfig} config
 */
function resolveGatewayIdleTimeoutMs(config) {
  const value = Number(config.lab?.gatewayIdleTimeoutMs ?? DEFAULT_GATEWAY_IDLE_TIMEOUT_MS);
  if (!Number.isFinite(value)) {
    return DEFAULT_GATEWAY_IDLE_TIMEOUT_MS;
  }
  return Math.max(50, Math.min(300000, Math.trunc(value)));
}

/**
 * @param {import("../config/load-config.js").LabAgentConfig} config
 */
function resolveGatewayMaxResponseBytes(config) {
  return normalizeGatewayMaxResponseBytes(
    config.lab?.gatewayMaxResponseBytes,
    DEFAULT_GATEWAY_MAX_RESPONSE_BYTES
  );
}

function createGatewayAttemptAbort(parentSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const abort = (reason) => {
    if (!controller.signal.aborted) {
      controller.abort(reason);
    }
  };
  const onParentAbort = () => abort(parentSignal?.reason ?? abortError());
  const timer = setTimeout(() => {
    timedOut = true;
    abort(timeoutError(timeoutMs));
  }, timeoutMs);
  parentSignal?.addEventListener?.("abort", onParentAbort, { once: true });
  if (parentSignal?.aborted) {
    onParentAbort();
  }
  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    cleanup() {
      clearTimeout(timer);
      parentSignal?.removeEventListener?.("abort", onParentAbort);
    }
  };
}

/**
 * @param {unknown} error
 * @param {{ attempt: number; maxAttempts: number; signal?: AbortSignal }} options
 */
function shouldRetryGatewayFetchError(error, options) {
  if (options.signal?.aborted) {
    return false;
  }
  if (gatewayResponseLimitCode(error)) {
    return false;
  }
  if (error && typeof error === "object" && "name" in error && error.name === "AbortError") {
    return false;
  }
  return options.attempt < options.maxAttempts;
}

/**
 * @param {unknown} error
 * @param {number} attempt
 * @param {boolean} retryable
 */
function errorRetrySummary(error, attempt, retryable, stage = "fetch") {
  const cause = error && typeof error === "object" && "cause" in error && error.cause && typeof error.cause === "object"
    ? error.cause
    : null;
  return {
    attempt,
    stage,
    retryable,
    errorName: error && typeof error === "object" && "name" in error ? String(error.name ?? "") : "",
    message: error instanceof Error ? redactGatewayText(error.message).slice(0, 200) : "",
    cause: cause
      ? Object.fromEntries(["name", "code", "errno", "syscall", "address", "port"].map((key) => [
        key,
        cause[key]
      ]).filter(([, value]) => value !== undefined && value !== null))
      : null
  };
}

/**
 * @param {Record<string, any>} error
 * @param {number} attempt
 * @param {boolean} retryable
 * @param {string} stage
 */
function gatewayErrorRetrySummary(error, attempt, retryable, stage) {
  return {
    attempt,
    stage,
    retryable,
    code: error?.code ?? "GATEWAY_ERROR",
    status: error?.status ?? null,
    message: redactGatewayText(error?.message ?? "").slice(0, 200),
    body: redactGatewayText(error?.details?.body ?? "").slice(0, 300)
  };
}

/**
 * @param {{ signal?: AbortSignal; onEvent?: (event: Record<string, any>) => void | Promise<void> }} request
 * @param {{ attempt: number; maxAttempts: number; retryHistory: Array<Record<string, any>>; delayMs: number; error: unknown; stage: string }} input
 */
async function emitRetryAndDelay(request, input) {
  const error = normalizeRetryEventError(input.error, {
    attempts: input.attempt,
    maxAttempts: input.maxAttempts,
    retryable: true,
    retryHistory: input.retryHistory
  });
  try {
    await emitGatewayEvent(request.onEvent, {
      type: "gateway_retry",
      attempt: input.attempt,
      maxAttempts: input.maxAttempts,
      delayMs: input.delayMs,
      stage: input.stage,
      error
    }, {
      signal: request.signal
    });
  } catch (eventError) {
    if (isGatewayEventCallbackError(eventError)) {
      return { delayed: false, eventError };
    }
    throw eventError;
  }
  return { delayed: await delay(input.delayMs, request.signal), eventError: null };
}

function gatewayEventCallbackFailure(error, details = {}) {
  const code = error?.code === "GATEWAY_EVENT_CALLBACK_TIMEOUT"
    ? "GATEWAY_EVENT_CALLBACK_TIMEOUT"
    : "GATEWAY_EVENT_CALLBACK_FAILED";
  return {
    ok: false,
    error: normalizeGatewayError(error, {
      code,
      message: error instanceof Error ? error.message : "Gateway event callback failed",
      details: { ...details, retryable: false }
    })
  };
}

function normalizeRetryEventError(error, details) {
  if (error && typeof error === "object" && typeof error.code === "string" && error.redacted === true) {
    return normalizeGatewayError(null, {
      code: error.code,
      message: error.message,
      status: error.status,
      details: {
        ...(error.details && typeof error.details === "object" ? error.details : {}),
        ...details
      }
    });
  }
  return normalizeGatewayError(error, { details });
}

/**
 * @param {number} attempt
 * @param {number} maxAttempts
 * @param {Array<Record<string, any>>} retryHistory
 */
function abortedRetryError(attempt, maxAttempts, retryHistory) {
  return {
    ok: false,
    error: normalizeGatewayError(abortError(), {
      details: {
        attempts: attempt,
        maxAttempts,
        retryable: false,
        retryHistory
      }
    })
  };
}

/**
 * @param {Record<string, any>} error
 * @param {{ attempt: number; maxAttempts: number; signal?: AbortSignal; config: import("../config/load-config.js").LabAgentConfig }} options
 */
function shouldRetryGatewayHttpError(error, options) {
  if (options.signal?.aborted || options.attempt >= options.maxAttempts) {
    return false;
  }
  if (error?.details?.bodyTruncated === true) {
    return false;
  }
  if (Number(error.status) >= 500) {
    return true;
  }
  return isConfiguredGatewayRetryable(error, options.config);
}

/**
 * @param {Record<string, any>} error
 * @param {{ attempt: number; maxAttempts: number; signal?: AbortSignal; config: import("../config/load-config.js").LabAgentConfig }} options
 */
function shouldRetryGatewayResponseError(error, options) {
  if (options.signal?.aborted || options.attempt >= options.maxAttempts) {
    return false;
  }
  return error.code === "GATEWAY_STREAM_INTERRUPTED"
    || RETRYABLE_STREAM_PROTOCOL_CODES.has(error.code)
    || isRetryableGatewayParseError(error)
    || isConfiguredGatewayRetryable(error, options.config);
}

function gatewayStreamProtocolCode(error) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code ?? "") : "";
  return RETRYABLE_STREAM_PROTOCOL_CODES.has(code) ? code : null;
}

function isRetryableGatewayParseError(error) {
  if (error?.code !== "GATEWAY_RESPONSE_PARSE_ERROR") {
    return false;
  }
  const contentType = String(error?.details?.contentType ?? "").trim().toLowerCase();
  const bodyPreview = String(error?.details?.bodyPreview ?? "").trim().toLowerCase();
  if (!contentType) {
    return true;
  }
  if (contentType.includes("text/event-stream") || contentType.includes("application/x-ndjson")) {
    return true;
  }
  return /<html|bad gateway|gateway timeout|upstream|temporar|try again|service unavailable/.test(bodyPreview);
}

/**
 * @param {Record<string, any>} error
 * @param {import("../config/load-config.js").LabAgentConfig} config
 */
function isConfiguredGatewayRetryable(error, config) {
  if (!usesGatewayRetryProfile(config)) {
    return false;
  }
  const text = [
    error?.message,
    error?.details?.body,
    error?.details?.responseReadStage
  ].filter(Boolean).join("\n");
  return GATEWAY_TRANSIENT_ERROR_PATTERN.test(text);
}

/**
 * @param {import("../config/load-config.js").LabAgentConfig} config
 */
function usesGatewayRetryProfile(config) {
  return /retry/i.test(String(config?.modelAlias ?? config?.lab?.gatewayRetryProfile ?? ""));
}

/**
 * @param {number} attempt
 */
function retryDelayMs(attempt) {
  const rawDelay = BASE_RETRY_DELAY_MS * (2 ** Math.max(0, attempt - 1));
  const jitter = 0.9 + (Math.random() * 0.2);
  return Math.min(MAX_RETRY_DELAY_MS, Math.max(0, Math.round(rawDelay * jitter)));
}

/**
 * @param {number} ms
 * @param {AbortSignal | undefined} signal
 */
function delay(ms, signal) {
  if (signal?.aborted) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      resolve(value);
    };
    const timer = setTimeout(() => finish(true), ms);
    const onAbort = () => {
      finish(false);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * @param {ReadableStream<Uint8Array> | null} body
 * @param {{ signal?: AbortSignal; idleTimeoutMs?: number; maxResponseBytes?: number; limitCode?: string }} [options]
 */
async function readResponseText(body, options = {}) {
  if (!body) {
    return "";
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const maxResponseBytes = normalizeGatewayMaxResponseBytes(options.maxResponseBytes);
  const limitCode = options.limitCode ?? "GATEWAY_RESPONSE_TOO_LARGE";
  let receivedBytes = 0;
  let text = "";
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
        throw gatewayResponseLimitError(limitCode, maxResponseBytes, receivedBytes + chunkBytes);
      }
      receivedBytes += chunkBytes;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    if (!completed) {
      cancelReader(reader, options.signal?.reason ?? new Error("Gateway response consumer stopped before completion"));
    }
    try {
      reader.releaseLock();
    } catch {
      // Reader may already be released.
    }
  }
  const rest = decoder.decode();
  return rest ? text + rest : text;
}

function readStreamChunk(reader, options = {}) {
  const signal = options.signal;
  const idleTimeoutMs = Number.isFinite(options.idleTimeoutMs) ? Math.max(50, Math.trunc(options.idleTimeoutMs)) : null;
  if (signal?.aborted) {
    return Promise.reject(abortError());
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
        finish(reject, abortError());
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

function abortError() {
  const error = new Error("operation aborted");
  error.name = "AbortError";
  return error;
}

function timeoutError(ms) {
  const error = new Error(`Gateway response idle timeout after ${ms}ms`);
  error.name = "AbortError";
  error.code = "GATEWAY_RESPONSE_IDLE_TIMEOUT";
  return error;
}

/**
 * @param {string} protocol
 * @param {ReadableStream<Uint8Array> | null} body
 * @param {string | null} contentType
 * @param {(event: Record<string, any>) => void | Promise<void>} [onEvent]
 * @param {import("../config/load-config.js").LabAgentConfig} [config]
 * @param {{ signal?: AbortSignal; idleTimeoutMs?: number; maxResponseBytes?: number }} [options]
 */
function parseStreamForProtocol(protocol, body, contentType, onEvent, config, options = {}) {
  return protocol === "openai-chat"
    ? parseOpenAIChatCompletionStream(body, { onEvent, reasoningContentMode: resolveReasoningContentMode(config), ...options })
    : parseGatewayStream(body, contentType, { onEvent, ...options });
}

/**
 * @param {string} protocol
 * @param {Response} response
 * @param {string | null} contentType
 * @param {(event: Record<string, any>) => void | Promise<void>} [onEvent]
 * @param {import("../config/load-config.js").LabAgentConfig} [config]
 * @param {{ signal?: AbortSignal; idleTimeoutMs?: number; maxResponseBytes?: number }} [options]
 */
async function parseResponseForProtocol(protocol, response, contentType, onEvent, config, options = {}) {
  assertResponseContentLength(response, options.maxResponseBytes, "GATEWAY_RESPONSE_TOO_LARGE");
  if (isStreamingContentType(contentType)) {
    return parseStreamForProtocol(protocol, response.body, contentType, onEvent, config, options);
  }
  const text = await readResponseText(response.body, options);
  try {
    if (looksLikeStreamingResponseText(text, protocol)) {
      return await parseStreamForProtocol(protocol, textToReadableStream(text), sniffedStreamContentType(text), onEvent, config, options);
    }
    return normalizeResponseForProtocol(protocol, JSON.parse(text), config);
  } catch (error) {
    attachGatewayBodyPreview(error, text);
    throw error;
  }
}

function looksLikeStreamingResponseText(text, protocol) {
  const trimmed = String(text ?? "").trimStart();
  if (trimmed.startsWith("data:")) {
    return true;
  }
  if (protocol !== "openai-chat" && looksLikeNewlineDelimitedJson(trimmed)) {
    return true;
  }
  return false;
}

function looksLikeNewlineDelimitedJson(text) {
  const lines = String(text ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.length > 1 && lines.every((line) => line.startsWith("{") || line.startsWith("["));
}

function sniffedStreamContentType(text) {
  return String(text ?? "").trimStart().startsWith("data:")
    ? "text/event-stream"
    : "application/x-ndjson";
}

function textToReadableStream(text) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    }
  });
}

function attachGatewayBodyPreview(error, text) {
  if (!error || typeof error !== "object") {
    return;
  }
  error.gatewayBodyPreview = redactGatewayText(String(text ?? "")).slice(0, 1000);
}

/**
 * @param {import("../config/load-config.js").LabAgentConfig} config
 */
function createHeaders(config, sessionId = null) {
  const headers = { "content-type": "application/json" };
  const apiKey = config.lab.gatewayApiKey;
  if (typeof apiKey === "string" && apiKey.length > 0) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  const affinity = sanitizeHeaderValue(sessionId);
  if (affinity) {
    headers["x-session-affinity"] = affinity;
  }
  return headers;
}

function sanitizeHeaderValue(value) {
  const text = String(value ?? "").trim();
  if (!text) {
    return "";
  }
  return text.replace(/[^\x20-\x7E]/g, "").slice(0, 200);
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/**
 * @param {string} protocol
 * @param {unknown} raw
 * @param {import("../config/load-config.js").LabAgentConfig} [config]
 */
function normalizeResponseForProtocol(protocol, raw, config) {
  return protocol === "openai-chat"
    ? normalizeOpenAIChatCompletionResponse(raw, { reasoningContentMode: resolveReasoningContentMode(config) })
    : normalizeGatewayResponse(raw);
}

/**
 * @param {import("../config/load-config.js").LabAgentConfig | undefined} config
 */
function resolveReasoningContentMode(config) {
  if (!config) {
    return "hidden";
  }
  const current = String(config.modelAlias ?? "").trim();
  const model = listConfiguredModels(config).find((item) => item.id === current);
  return model?.reasoningContentMode ?? "hidden";
}

/**
 * @param {import("../config/load-config.js").LabAgentConfig | undefined} config
 */
function resolveOpenAIExtraBody(config) {
  if (!config) {
    return null;
  }
  const current = String(config.modelAlias ?? "").trim();
  const model = listConfiguredModels(config).find((item) => item.id === current);
  return isPlainObject(model?.openaiExtraBody) ? model.openaiExtraBody : null;
}

/**
 * @param {Response} response
 * @param {{ signal?: AbortSignal; idleTimeoutMs?: number; maxResponseBytes?: number }} [options]
 */
async function boundedResponseText(response, options = {}) {
  const maxResponseBytes = normalizeGatewayMaxResponseBytes(
    options.maxResponseBytes,
    GATEWAY_MAX_ERROR_BODY_BYTES
  );
  const declaredBytes = responseContentLength(response);
  if (declaredBytes !== null && declaredBytes > maxResponseBytes) {
    cancelResponseBody(response.body, gatewayResponseLimitError(
      "GATEWAY_ERROR_BODY_TOO_LARGE",
      maxResponseBytes,
      declaredBytes
    ));
    return { body: "", truncated: true, receivedBytes: declaredBytes };
  }
  if (!response.body) {
    return { body: "", truncated: false, receivedBytes: 0 };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let retainedBytes = 0;
  let receivedBytes = 0;
  let completed = false;
  let truncated = declaredBytes !== null && declaredBytes > maxResponseBytes;
  try {
    while (true) {
      const { done, value } = await readStreamChunk(reader, options);
      if (done) {
        completed = true;
        break;
      }
      const chunkBytes = Number(value?.byteLength ?? 0);
      receivedBytes += chunkBytes;
      const remaining = Math.max(0, maxResponseBytes - retainedBytes);
      if (remaining > 0) {
        const retained = chunkBytes > remaining ? value.subarray(0, remaining) : value;
        retainedBytes += retained.byteLength;
        text += decoder.decode(retained, { stream: true });
      }
      if (chunkBytes > remaining || truncated && retainedBytes >= maxResponseBytes) {
        truncated = true;
        break;
      }
    }
  } finally {
    if (!completed) {
      cancelReader(reader, gatewayResponseLimitError(
        "GATEWAY_ERROR_BODY_TOO_LARGE",
        maxResponseBytes,
        Math.max(receivedBytes, declaredBytes ?? 0)
      ));
    }
    try {
      reader.releaseLock();
    } catch {
      // Reader cancellation closes pending reads before the lock is released.
    }
  }
  text += decoder.decode();
  return {
    body: redactGatewayText(text).slice(0, 1000),
    truncated,
    receivedBytes: Math.max(receivedBytes, declaredBytes ?? 0)
  };
}

/** @param {Response} response @returns {number | null} */
function responseContentLength(response) {
  const raw = response.headers.get("content-length");
  if (raw === null || raw.trim() === "") return null;
  const contentLength = Number(raw);
  return Number.isSafeInteger(contentLength) && contentLength >= 0 ? contentLength : null;
}

/** @param {Response} response @param {unknown} maxBytesValue @param {string} code */
function assertResponseContentLength(response, maxBytesValue, code) {
  const maxBytes = normalizeGatewayMaxResponseBytes(maxBytesValue);
  const contentLength = responseContentLength(response);
  if (contentLength === null || contentLength <= maxBytes) return;
  const error = gatewayResponseLimitError(code, maxBytes, contentLength);
  cancelResponseBody(response.body, error);
  throw error;
}

/** @param {ReadableStream<Uint8Array> | null} body @param {unknown} reason */
function cancelResponseBody(body, reason) {
  try {
    Promise.resolve(body?.cancel(reason)).catch(() => {});
  } catch {
    // Best effort; the body has not been locked by a reader yet.
  }
}

/**
 * @param {string | null} contentType
 */
function isStreamingContentType(contentType) {
  return Boolean(
    contentType &&
    (contentType.includes("text/event-stream") || contentType.includes("application/x-ndjson"))
  );
}
