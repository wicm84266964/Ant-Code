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
const BASE_RETRY_DELAY_MS = 350;
const MAX_RETRY_DELAY_MS = 1500;
const TRANSIENT_GATEWAY_RETRY_ERROR_PATTERN = /KVTransferError|WaitingForInput|Decode transfer failed|premature close|stream.*interrupted/i;

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
      const retryHistory = [];
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        let response;
        const startedAt = Date.now();
        try {
          response = await fetch(config.lab.gatewayUrl, {
            method: "POST",
            headers: createHeaders(config, request.sessionId),
            body: JSON.stringify(gatewayRequest),
            signal: request.signal
          });
        } catch (error) {
          const retryable = shouldRetryGatewayFetchError(error, {
            attempt,
            maxAttempts,
            signal: request.signal
          });
          retryHistory.push(errorRetrySummary(error, attempt, retryable, "fetch"));
          if (!retryable) {
            return {
              ok: false,
              error: normalizeGatewayError(error, {
                details: {
                  attempts: attempt,
                  maxAttempts,
                  retryable: false,
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
          const body = await boundedResponseText(response);
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
          data = isStreamingContentType(contentType)
            ? await parseStreamForProtocol(protocol, response.body, contentType, request.onEvent, config)
            : normalizeResponseForProtocol(protocol, await response.json(), config);
        } catch (error) {
          const contentType = response.headers.get("content-type") ?? "";
          const streamInterrupted = isGatewayStreamInterruptedError(error);
          const normalized = normalizeGatewayError(error, {
            code: streamInterrupted ? "GATEWAY_STREAM_INTERRUPTED" : "GATEWAY_RESPONSE_PARSE_ERROR",
            message: streamInterrupted
              ? "Gateway response stream was interrupted before it could be fully read"
              : "Gateway response could not be parsed",
            details: {
              protocol,
              contentType,
              responseReadStage: streamInterrupted ? "read_body" : "parse_body",
              attempts: attempt,
              maxAttempts,
              responseHeaderMs,
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
  return isTransientGatewayRetryable(error);
}

/**
 * @param {Record<string, any>} error
 * @param {{ attempt: number; maxAttempts: number; signal?: AbortSignal; config: import("../config/load-config.js").LabAgentConfig }} options
 */
function shouldRetryGatewayResponseError(error, options) {
  if (options.signal?.aborted || options.attempt >= options.maxAttempts) {
    return false;
  }
  return error.code === "GATEWAY_STREAM_INTERRUPTED" || isTransientGatewayRetryable(error);
}

/**
 * @param {Record<string, any>} error
 * @param {import("../config/load-config.js").LabAgentConfig} config
 */
function isTransientGatewayRetryable(error) {
  const text = [
    error?.message,
    error?.details?.body,
    error?.details?.responseReadStage
  ].filter(Boolean).join("\n");
  return TRANSIENT_GATEWAY_RETRY_ERROR_PATTERN.test(text);
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

function abortError() {
  const error = new Error("operation aborted");
  error.name = "AbortError";
  return error;
}

/**
 * @param {string} protocol
 * @param {ReadableStream<Uint8Array> | null} body
 * @param {string | null} contentType
 * @param {(event: Record<string, any>) => void | Promise<void>} [onEvent]
 * @param {import("../config/load-config.js").LabAgentConfig} [config]
 */
function parseStreamForProtocol(protocol, body, contentType, onEvent, config) {
  return protocol === "openai-chat"
    ? parseOpenAIChatCompletionStream(body, { onEvent, reasoningContentMode: resolveReasoningContentMode(config) })
    : parseGatewayStream(body, contentType, { onEvent });
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
async function boundedResponseText(response) {
  const text = await response.text().catch(() => "");
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
