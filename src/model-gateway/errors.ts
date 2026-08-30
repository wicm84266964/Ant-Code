const GATEWAY_CREDENTIAL_NAME_PATTERN = String.raw`(?:x[-_]?api[-_]?key|api[-_]?key|access[-_]?token|authorization|token|secret|password)`;
const GATEWAY_CREDENTIAL_KEY_PATTERN = String.raw`(?:"${GATEWAY_CREDENTIAL_NAME_PATTERN}"|'${GATEWAY_CREDENTIAL_NAME_PATTERN}'|${GATEWAY_CREDENTIAL_NAME_PATTERN})`;
const LABELED_GATEWAY_CREDENTIAL_PATTERN = new RegExp(
  String.raw`(?<![A-Za-z0-9_-])(${GATEWAY_CREDENTIAL_KEY_PATTERN}\s*[:=]\s*)("(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|(?:(?:Bearer|Basic|Token|Api[-_]?Key)\s+)?(?:\[redacted\]|[^\s,;{}&\]#]+))`,
  "gi"
);

/**
 * @param {unknown} error
 * @param {{ code?: string; message?: string; status?: number; details?: Record<string, any>; protocol?: string }} context
 */
export function normalizeGatewayError(error: unknown, context: { code?: string; message?: string; status?: number; details?: Record<string, unknown>; protocol?: string } = {}) {
  const code = context.code ?? inferCode(error);
  const details = redactDetails(context.details ?? {});
  const providerMessage = extractProviderErrorMessage(details);
  return {
    code,
    message: redactGatewayText(context.message ?? inferMessage(error)),
    status: context.status ?? null,
    details,
    providerMessage,
    diagnostics: gatewayTroubleshootingHints(code, context.status ?? null, context.protocol, { providerMessage }),
    redacted: true
  };
}

/**
 * @param {unknown} error
 */
export function isGatewayStreamInterruptedError(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }
  const name = "name" in error ? String(error.name ?? "") : "";
  const code = "code" in error ? String(error.code ?? "") : "";
  const message = error instanceof Error ? error.message : String(error);
  return name === "AbortError"
    || code === "ABORT_ERR"
    || code === "UND_ERR_ABORTED"
    || /aborted|abort|terminated|premature close|stream.*interrupted/i.test(message);
}

/**
 * @param {Record<string, any>} error
 */
type GatewayErrorView = {
  code?: unknown;
  message?: unknown;
  status?: unknown;
  providerMessage?: unknown;
  diagnostics?: unknown;
};

export function formatGatewayError(error: unknown) {
  const view = error as GatewayErrorView;
  const lines = [
    `Gateway error: ${view.code ?? "GATEWAY_ERROR"}`,
    `message: ${view.message ?? "request failed"}`
  ];
  if (view.status) {
    lines.push(`http status: ${view.status}`);
  }
  if (view.providerMessage) {
    lines.push(`provider: ${view.providerMessage}`);
  }
  const diagnostics = Array.isArray(view.diagnostics) ? view.diagnostics : [];
  if (diagnostics.length > 0) {
    lines.push("diagnostics:");
    lines.push(...diagnostics.map((hint) => `- ${hint}`));
  }
  return lines.join("\n");
}

/**
 * @param {string} code
 * @param {number | null} status
 * @param {string | undefined} protocol
 * @param {{ providerMessage?: string }} options
 */
export function gatewayTroubleshootingHints(code: string, status: number | null = null, protocol: string | undefined = undefined, options: { providerMessage?: string } = {}) {
  if (code === "GATEWAY_NOT_CONFIGURED") {
    return [
      "Set LAB_MODEL_GATEWAY_URL to the lab gateway chat endpoint.",
      "Run /gateway or ant-code gateway before retrying the model turn."
    ];
  }
  if (code === "GATEWAY_NETWORK_BLOCKED") {
    return [
      "Check LAB_AGENT_NETWORK_MODE and LAB_AGENT_ALLOWED_HOSTS.",
      "Use lab-only with a gateway host on the allowlist, or offline only for loopback testing."
    ];
  }
  if (code === "GATEWAY_HTTP_ERROR") {
    if (isImageUnsupportedMessage(options.providerMessage)) {
      return [
        "The configured model route rejected image input; this endpoint does not currently expose a vision-capable backend.",
        "Remove image attachments for this turn, or switch LAB_AGENT_MODEL/modelAlias and LAB_MODEL_GATEWAY_URL to a route that supports image input."
      ];
    }
    if (status === 401 || status === 403) {
      return ["Check lab gateway authentication and user authorization at the gateway service."];
    }
    if (status === 404) {
      return [
        protocol === "openai-chat"
          ? "Check that LAB_MODEL_GATEWAY_URL points to the OpenAI-compatible Chat Completions route, usually /v1/chat/completions."
          : protocol === "openai-responses"
            ? "Check that LAB_MODEL_GATEWAY_URL points to the OpenAI-compatible Responses route, usually /v1/responses."
            : protocol === "anthropic-messages"
              ? "Check that LAB_MODEL_GATEWAY_URL points to the Anthropic Messages route, usually /v1/messages."
              : "Check that LAB_MODEL_GATEWAY_URL points to the Ant Code lab gateway chat route, usually /v1/chat."
      ];
    }
    if (status && status >= 500) {
      return ["Check gateway server logs using the local session id and retry after the service is healthy."];
    }
    return ["Check gateway route, method, and reverse proxy configuration."];
  }
  if (code === "GATEWAY_RESPONSE_PARSE_ERROR") {
    return [
      "Verify the gateway returns JSON, text/event-stream, or application/x-ndjson in the supported protocol shape.",
      "Run npm run verify:gateway or node scripts/verify-gateway-compat.js --live."
    ];
  }
  if (code === "GATEWAY_TIMEOUT") {
    return [
      "Check gateway latency, model queue health, and reverse proxy timeout settings.",
      "Retry with a smaller prompt or after the gateway worker is healthy."
    ];
  }
  return ["Run /gateway --live and verify the configured lab gateway endpoint."];
}

/**
 * @param {string} value
 */
export function redactGatewayText(value: string) {
  return String(value)
    .replace(/(https?:\/\/)([^/\s:@]+):([^@\s/]+)@/gi, "$1[redacted]@")
    .replace(LABELED_GATEWAY_CREDENTIAL_PATTERN, redactLabeledGatewayCredential)
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]")
    .replace(/(--?(?:x[-_]?api[-_]?key|api[-_]?key|access[-_]?token|authorization|token|secret|password)(?:=|\s+))\S+/gi, "$1[redacted]");
}

/** @param {string} _match @param {string} prefix @param {string} credential */
function redactLabeledGatewayCredential(_match: string, prefix: string, credential: string) {
  const quote = credential[0];
  return quote === '"' || quote === "'"
    ? `${prefix}${quote}[redacted]${quote}`
    : `${prefix}[redacted]`;
}

/**
 * @param {unknown} error
 */
function inferCode(error: unknown) {
  if (error && typeof error === "object" && "name" in error && error.name === "AbortError") {
    return "GATEWAY_TIMEOUT";
  }
  return "GATEWAY_FETCH_ERROR";
}

/**
 * @param {unknown} error
 */
function inferMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * @param {Record<string, any>} details
 */
function redactDetails(details: Record<string, unknown>) {
  return JSON.parse(JSON.stringify(details, (_key: string, value: unknown) => (
    typeof value === "string" ? redactGatewayText(value) : value
  )));
}

/**
 * @param {Record<string, any>} details
 */
function extractProviderErrorMessage(details: Record<string, unknown>) {
  const body = details.body;
  const parsed = objectRecord(typeof body === "string" ? parseJsonObject(body) : body);
  const errorField = parsed?.error;
  const errorRecord = objectRecord(errorField);
  const message = firstString(
    errorRecord?.message,
    parsed?.message,
    errorField,
    parsed?.detail,
    parsed?.details
  );
  return message ? redactGatewayText(message).slice(0, 500) : "";
}

/**
 * @param {unknown} value
 */
function parseJsonObject(value: unknown) {
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** @param {...unknown} values */
function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

/**
 * @param {unknown} value
 */
function isImageUnsupportedMessage(value: unknown) {
  const text = String(value ?? "");
  return /image input|image_url|vision|multimodal/i.test(text)
    && /no endpoints found|not support|does not support|unsupported|not available|not found/i.test(text);
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && value !== undefined && typeof value === "object"
    ? value as Record<string, unknown>
    : undefined;
}
