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

const DEFAULT_GATEWAY_MAX_RETRIES = 2;
const DEFAULT_GATEWAY_TIMEOUT_MS = 180000;
const DEFAULT_GATEWAY_IDLE_TIMEOUT_MS = 60000;
const BASE_RETRY_DELAY_MS = 350;
const MAX_RETRY_DELAY_MS = 1500;
const GATEWAY_TRANSIENT_ERROR_PATTERN = /KVTransferError|WaitingForInput|Decode transfer failed|premature close|stream.*interrupted/i;

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
          const delayed = await emitRetryAndDelay(request, {
            attempt,
            maxAttempts,
            retryHistory,
            delayMs: retryDelayMs(attempt),
            error,
            stage: "fetch"
          });
          if (!delayed) {
            return abortedRetryError(attempt, maxAttempts, retryHistory);
          }
          continue;
        }

        const responseHeaderMs = Date.now() - startedAt;
        if (!response.ok) {
          let body;
          try {
            body = await boundedResponseText(response, {
              signal: attemptAbort.signal,
              idleTimeoutMs
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
              return {
                ok: false,
                error: normalizeGatewayError(error, {
                  code: attemptAbort.timedOut ? "GATEWAY_TIMEOUT" : undefined,
                  message: attemptAbort.timedOut ? `Gateway request timed out after ${timeoutMs}ms` : undefined,
                  details: {
                    attempts: attempt,
                    maxAttempts,
                    retryable: false,
                    responseHeaderMs,
                    timeoutMs,
                    idleTimeoutMs,
                    retryHistory
                  }
                })
              };
            }
            const delayed = await emitRetryAndDelay(request, {
              attempt,
              maxAttempts,
              retryHistory,
              delayMs: retryDelayMs(attempt),
              error,
              stage: "http_body"
            });
            if (!delayed) {
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
              body,
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
          const delayed = await emitRetryAndDelay(request, {
            attempt,
            maxAttempts,
            retryHistory,
            delayMs: retryDelayMs(attempt),
            error,
            stage: "http"
          });
          if (!delayed) {
            return abortedRetryError(attempt, maxAttempts, retryHistory);
          }
          continue;
        }

        let data;
        try {
          const contentType = response.headers.get("content-type");
          data = await parseResponseForProtocol(protocol, response, contentType, request.onEvent, config, {
            signal: attemptAbort.signal,
            idleTimeoutMs
          });
          attemptAbort.cleanup();
        } catch (error) {
          attemptAbort.cleanup();
          const contentType = response.headers.get("content-type") ?? "";
          const streamInterrupted = isGatewayStreamInterruptedError(error);
          const normalized = normalizeGatewayError(error, {
            code: attemptAbort.timedOut ? "GATEWAY_TIMEOUT" : streamInterrupted ? "GATEWAY_STREAM_INTERRUPTED" : "GATEWAY_RESPONSE_PARSE_ERROR",
            message: attemptAbort.timedOut
              ? `Gateway request timed out after ${timeoutMs}ms`
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
              retryHistory
            }
          });
          const retryable = shouldRetryGatewayResponseError(normalized, {
            attempt,
            maxAttempts,
            config,
            signal: request.signal
          });
          retryHistory.push(gatewayErrorRetrySummary(normalized, attempt, retryable, streamInterrupted ? "read_body" : "parse_body"));
          if (!retryable) {
            return { ok: false, error: normalized };
          }
          const delayed = await emitRetryAndDelay(request, {
            attempt,
            maxAttempts,
            retryHistory,
            delayMs: retryDelayMs(attempt),
            error: normalized,
            stage: streamInterrupted ? "read_body" : "parse_body"
          });
          if (!delayed) {
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
  await request.onEvent?.({
    type: "gateway_retry",
    attempt: input.attempt,
    maxAttempts: input.maxAttempts,
    delayMs: input.delayMs,
    stage: input.stage,
    error
  });
  return delay(input.delayMs, request.signal);
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
    || isRetryableGatewayParseError(error)
    || isConfiguredGatewayRetryable(error, options.config);
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
  return Math.min(MAX_RETRY_DELAY_MS, BASE_RETRY_DELAY_MS * (2 ** Math.max(0, attempt - 1)));
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

async function readResponseText(body, options = {}) {
  if (!body) {
    return "";
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (true) {
      const { done, value } = await readStreamChunk(reader, options);
      if (done) {
        break;
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
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
  if (!idleTimeoutMs) {
    return reader.read();
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      callback(value);
    };
    const timer = setTimeout(() => {
      cancelReader(reader, timeoutError(idleTimeoutMs));
      finish(reject, timeoutError(idleTimeoutMs));
    }, idleTimeoutMs);
    const onAbort = () => {
      cancelReader(reader, signal.reason);
      finish(reject, abortError());
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
    reader.read().then(
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
 * @param {{ signal?: AbortSignal; idleTimeoutMs?: number }} [options]
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
 * @param {{ signal?: AbortSignal; idleTimeoutMs?: number }} [options]
 */
async function parseResponseForProtocol(protocol, response, contentType, onEvent, config, options = {}) {
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
 */
async function boundedResponseText(response, options = {}) {
  const text = await readResponseText(response.body, options);
  return redactGatewayText(text).slice(0, 1000);
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
