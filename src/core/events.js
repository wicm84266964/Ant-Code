export const ANT_EVENT_SCHEMA_VERSION = 2;

const PARTIAL_EVENT_TYPES = new Set([
  "assistant_text_delta",
  "assistant_interrupted_draft",
  "tool_input_delta"
]);

/**
 * @param {{ sessionId: string; now?: () => string; idFactory?: (sequence: number, type: string) => string }} options
 */
export function createAntEventNormalizer(options) {
  let sequence = 0;
  let activeTurnId = null;
  let activeRound = null;
  let activeMessage = false;
  let activeText = false;
  let activeThinking = false;

  const now = options.now ?? (() => new Date().toISOString());
  const idFactory = options.idFactory ?? ((nextSequence, type) => `${options.sessionId}:${String(nextSequence).padStart(6, "0")}:${type}`);

  /**
   * @param {Record<string, any>} legacyEvent
   * @returns {Array<Record<string, any>>}
   */
  function normalize(legacyEvent) {
    if (!legacyEvent || typeof legacyEvent !== "object") {
      return [];
    }

    const events = [];
    const type = String(legacyEvent.type ?? "unknown");

    if (type === "turn_start") {
      activeTurnId = `${options.sessionId}:turn-${legacyEvent.turnIndex ?? "unknown"}`;
      activeRound = null;
      activeMessage = false;
      activeText = false;
      activeThinking = false;
      events.push(makeEvent("turn_start", legacyEvent, {
        turnIndex: legacyEvent.turnIndex ?? null,
        promptBytes: legacyEvent.promptBytes ?? null,
        queueState: legacyEvent.queueState ?? "accepted"
      }, { source: "session" }));
      return events;
    }

    if (type === "gateway_request_start") {
      activeRound = Number.isFinite(legacyEvent.round) ? legacyEvent.round : activeRound;
      events.push(makeEvent("gateway_request_start", legacyEvent, {
        round: activeRound,
        messageCount: legacyEvent.messageCount ?? null,
        toolResultCount: legacyEvent.toolResultCount ?? null,
        toolSchemaCount: legacyEvent.toolSchemaCount ?? null,
        promptBytesEstimate: legacyEvent.promptBytesEstimate ?? null,
        promptTokensEstimate: legacyEvent.promptTokensEstimate ?? null,
        promptMessageTokensEstimate: legacyEvent.promptMessageTokensEstimate ?? null,
        promptToolSchemaTokensEstimate: legacyEvent.promptToolSchemaTokensEstimate ?? null,
        promptToolResultTokensEstimate: legacyEvent.promptToolResultTokensEstimate ?? null
      }, { source: "gateway" }));
      return events;
    }

    if (type === "gateway_stream_start") {
      activeRound = Number.isFinite(legacyEvent.round) ? legacyEvent.round : activeRound;
      activeMessage = true;
      activeText = false;
      activeThinking = false;
      events.push(makeEvent("assistant_message_start", legacyEvent, {
        round: activeRound,
        messageId: legacyEvent.messageId ?? null,
        model: legacyEvent.model ?? null
      }, { source: "gateway" }));
      return events;
    }

    if (type === "assistant_thinking_delta") {
      activeRound = Number.isFinite(legacyEvent.round) ? legacyEvent.round : activeRound;
      ensureMessage(events, legacyEvent);
      if (!activeThinking) {
        activeThinking = true;
        events.push(makeEvent("assistant_thinking_start", legacyEvent, {
          round: activeRound
        }, {
          source: "gateway",
          visibility: "detail",
          persistence: "redact",
          redaction: "full"
        }));
      }
      events.push(makeEvent("assistant_thinking_delta", legacyEvent, {
        round: activeRound,
        text: String(legacyEvent.text ?? ""),
        bytes: legacyEvent.bytes ?? Buffer.byteLength(String(legacyEvent.text ?? ""), "utf8")
      }, {
        source: "gateway",
        visibility: "debug",
        persistence: "memory",
        redaction: "none"
      }));
      return events;
    }

    if (type === "assistant_delta") {
      activeRound = Number.isFinite(legacyEvent.round) ? legacyEvent.round : activeRound;
      ensureMessage(events, legacyEvent);
      ensureText(events, legacyEvent, true);
      const text = String(legacyEvent.text ?? "");
      events.push(makeEvent("assistant_text_delta", legacyEvent, {
        round: activeRound,
        text,
        bytes: legacyEvent.bytes ?? Buffer.byteLength(text, "utf8"),
        partial: true
      }, { source: "gateway" }));
      return events;
    }

    if (type === "tool_call_delta") {
      activeRound = Number.isFinite(legacyEvent.round) ? legacyEvent.round : activeRound;
      ensureMessage(events, legacyEvent);
      const argumentsDelta = String(legacyEvent.argumentsDelta ?? "");
      events.push(makeEvent("tool_input_delta", legacyEvent, {
        round: activeRound,
        index: Number.isInteger(legacyEvent.index) ? legacyEvent.index : null,
        id: typeof legacyEvent.id === "string" ? legacyEvent.id : null,
        nameDelta: typeof legacyEvent.nameDelta === "string" ? legacyEvent.nameDelta : "",
        argumentsDelta: redactText(argumentsDelta),
        argumentBytes: Buffer.byteLength(argumentsDelta, "utf8"),
        partial: true
      }, {
        source: "gateway",
        visibility: "detail",
        persistence: "redact",
        redaction: argumentsDelta ? "partial" : "none"
      }));
      return events;
    }

    if (type === "gateway_stream_stop") {
      closeThinking(events, legacyEvent);
      closeText(events, legacyEvent);
      if (activeMessage) {
        events.push(makeEvent("assistant_message_stop", legacyEvent, {
          round: activeRound,
          stopReason: legacyEvent.stopReason ?? null
        }, { source: "gateway" }));
      }
      activeMessage = false;
      return events;
    }

    if (type === "gateway_response") {
      activeRound = Number.isFinite(legacyEvent.round) ? legacyEvent.round : activeRound;
      events.push(makeEvent("gateway_response", legacyEvent, {
        round: activeRound,
        messageId: legacyEvent.messageId ?? null,
        model: legacyEvent.model ?? null,
        textBytes: legacyEvent.textBytes ?? null,
        toolCallCount: legacyEvent.toolCallCount ?? null,
        stopReason: legacyEvent.stopReason ?? null
      }, { source: "gateway" }));
      return events;
    }

    if (type === "assistant_final") {
      ensureMessage(events, legacyEvent);
      ensureText(events, legacyEvent, false);
      const text = String(legacyEvent.text ?? "");
      if (text.length > 0) {
        events.push(makeEvent("assistant_text_delta", legacyEvent, {
          round: activeRound,
          text,
          bytes: legacyEvent.outputBytes ?? Buffer.byteLength(text, "utf8"),
          partial: false
        }, { source: "session" }));
      }
      closeText(events, legacyEvent);
      events.push(makeEvent("assistant_message_stop", legacyEvent, {
        round: activeRound,
        stopReason: "completed"
      }, { source: "session" }));
      activeMessage = false;
      return events;
    }

    if (type === "tool_calls_requested") {
      const calls = Array.isArray(legacyEvent.toolCalls) ? legacyEvent.toolCalls : [];
      for (const call of calls) {
        events.push(makeEvent("tool_use_start", legacyEvent, {
          round: legacyEvent.round ?? activeRound,
          toolUseId: call.id ?? null,
          name: call.name ?? null,
          inputKeys: Array.isArray(call.inputKeys) ? call.inputKeys : []
        }, {
          source: "gateway",
          parentToolUseId: call.id ?? null
        }));
      }
      return events;
    }

    if (type === "tool_start") {
      events.push(makeEvent("tool_start", legacyEvent, {
        toolUseId: legacyEvent.toolCallId ?? null,
        name: legacyEvent.name ?? null,
        inputKeys: Array.isArray(legacyEvent.inputKeys) ? legacyEvent.inputKeys : []
      }, {
        source: "tool",
        parentToolUseId: legacyEvent.toolCallId ?? null
      }));
      return events;
    }

    if (type === "tool_finish") {
      events.push(makeEvent("tool_result", legacyEvent, {
        toolUseId: legacyEvent.toolCallId ?? null,
        name: legacyEvent.name ?? null,
        status: legacyEvent.ok ? "completed" : legacyEvent.blocked ? "blocked" : "failed",
        ok: legacyEvent.ok === true,
        blocked: legacyEvent.blocked === true,
        errorCode: legacyEvent.errorCode ?? null,
        decision: legacyEvent.decision ?? null,
        changeStats: sanitizeChangeStats(legacyEvent.changeStats),
        turnChangeStats: sanitizeChangeStats(legacyEvent.turnChangeStats, { allowEmpty: true }),
        resultBytes: legacyEvent.resultBytes ?? null,
        truncated: legacyEvent.truncated === true
      }, {
        source: "tool",
        parentToolUseId: legacyEvent.toolCallId ?? null
      }));
      return events;
    }

    if (type === "delegation_guard") {
      events.push(makeEvent("delegation_guard", legacyEvent, {
        toolUseId: legacyEvent.toolCallId ?? null,
        name: legacyEvent.name ?? null,
        level: legacyEvent.level ?? "soft",
        reason: legacyEvent.reason ?? null,
        broadActions: legacyEvent.broadActions ?? null,
        suggestedProfiles: Array.isArray(legacyEvent.suggestedProfiles) ? legacyEvent.suggestedProfiles : []
      }, {
        source: "tool",
        visibility: "detail",
        parentToolUseId: legacyEvent.toolCallId ?? null
      }));
      return events;
    }

    if (type === "review_gate") {
      events.push(makeEvent("review_gate", legacyEvent, {
        level: legacyEvent.level ?? "remind",
        reasons: Array.isArray(legacyEvent.reasons) ? legacyEvent.reasons : []
      }, {
        source: "session",
        visibility: "detail"
      }));
      return events;
    }

    if (type === "context_compacted") {
      events.push(makeEvent("context_compacted", legacyEvent, {
        beforeMessages: legacyEvent.beforeMessages ?? null,
        afterMessages: legacyEvent.afterMessages ?? null,
        summaryBytes: legacyEvent.summaryBytes ?? null,
        strategy: legacyEvent.strategy ?? null,
        internalAgent: legacyEvent.internalAgent ?? null,
        fallbackReason: legacyEvent.fallbackReason ?? null
      }, { source: "session" }));
      return events;
    }

    if (type === "workflow_updated") {
      events.push(makeEvent("workflow_updated", legacyEvent, {
        reason: legacyEvent.reason ?? "workflow_update",
        todosCompleted: legacyEvent.todosCompleted ?? 0,
        planStepsCompleted: legacyEvent.planStepsCompleted ?? 0
      }, {
        source: "session",
        visibility: "detail"
      }));
      return events;
    }

    if (type === "gateway_error" || type === "gateway_not_configured") {
      events.push(makeEvent("gateway_error", legacyEvent, {
        code: legacyEvent.error?.code ?? (type === "gateway_not_configured" ? "GATEWAY_NOT_CONFIGURED" : "GATEWAY_ERROR"),
        message: legacyEvent.error?.message ? redactText(String(legacyEvent.error.message)) : null,
        outputBytes: legacyEvent.outputBytes ?? null
      }, {
        source: "gateway",
        redaction: "partial"
      }));
      return events;
    }

    if (type === "turn_interrupted") {
      closeThinking(events, legacyEvent);
      closeText(events, legacyEvent);
      if (activeMessage) {
        events.push(makeEvent("assistant_message_stop", legacyEvent, {
          round: activeRound,
          stopReason: "interrupted"
        }, { source: "session" }));
      }
      events.push(makeEvent("turn_interrupted", legacyEvent, {
        reason: legacyEvent.reason ?? "user",
        draftText: redactText(String(legacyEvent.draftText ?? "")),
        draftBytes: legacyEvent.draftBytes ?? null,
        draftThinkingBytes: legacyEvent.draftThinkingBytes ?? null,
        outputBytes: legacyEvent.outputBytes ?? null
      }, { source: "session" }));
      activeMessage = false;
      activeText = false;
      activeThinking = false;
      return events;
    }

    if (type === "assistant_interrupted_draft") {
      const text = String(legacyEvent.text ?? "");
      events.push(makeEvent("assistant_interrupted_draft", legacyEvent, {
        round: activeRound,
        text: redactText(text),
        bytes: legacyEvent.outputBytes ?? Buffer.byteLength(text, "utf8"),
        thinkingBytes: legacyEvent.thinkingBytes ?? null,
        partial: true
      }, {
        source: "session",
        visibility: "detail",
        persistence: "redact",
        redaction: "partial"
      }));
      return events;
    }

    if (type === "tool_limit" || type === "turn_unexpected_end") {
      events.push(makeEvent(type, legacyEvent, {
        outputBytes: legacyEvent.outputBytes ?? null,
        toolCallCount: legacyEvent.toolCallCount ?? null
      }, { source: "session" }));
      return events;
    }

    if (type === "turn_complete") {
      closeThinking(events, legacyEvent);
      closeText(events, legacyEvent);
      events.push(makeEvent("turn_result", legacyEvent, {
        status: legacyEvent.status ?? "unknown",
        outputBytes: legacyEvent.outputBytes ?? null
      }, { source: "session" }));
      activeMessage = false;
      activeText = false;
      activeThinking = false;
      return events;
    }

    if (type === "command_result") {
      events.push(makeEvent("command_result", legacyEvent, {
        command: legacyEvent.command ?? null,
        text: redactText(String(legacyEvent.text ?? "")),
        bytes: Buffer.byteLength(String(legacyEvent.text ?? ""), "utf8")
      }, {
        source: "command",
        redaction: "partial"
      }));
      return events;
    }

    events.push(makeEvent(type, legacyEvent, sanitizePayload(legacyEvent), {
      source: "session",
      visibility: "debug",
      redaction: "partial"
    }));
    return events;
  }

  /**
   * @param {Array<Record<string, any>>} events
   * @param {Record<string, any>} legacyEvent
   */
  function ensureMessage(events, legacyEvent) {
    if (activeMessage) {
      return;
    }
    activeMessage = true;
    events.push(makeEvent("assistant_message_start", legacyEvent, {
      round: activeRound,
      messageId: legacyEvent.messageId ?? null,
      model: legacyEvent.model ?? null
    }, { source: legacyEvent.type === "assistant_final" ? "session" : "gateway" }));
  }

  /**
   * @param {Array<Record<string, any>>} events
   * @param {Record<string, any>} legacyEvent
   * @param {boolean} partial
   */
  function ensureText(events, legacyEvent, partial) {
    if (activeText) {
      return;
    }
    activeText = true;
    events.push(makeEvent("assistant_text_start", legacyEvent, {
      round: activeRound,
      partial
    }, { source: legacyEvent.type === "assistant_final" ? "session" : "gateway" }));
  }

  /**
   * @param {Array<Record<string, any>>} events
   * @param {Record<string, any>} legacyEvent
   */
  function closeText(events, legacyEvent) {
    if (!activeText) {
      return;
    }
    events.push(makeEvent("assistant_text_stop", legacyEvent, {
      round: activeRound
    }, { source: legacyEvent.type === "assistant_final" ? "session" : "gateway" }));
    activeText = false;
  }

  /**
   * @param {Array<Record<string, any>>} events
   * @param {Record<string, any>} legacyEvent
   */
  function closeThinking(events, legacyEvent) {
    if (!activeThinking) {
      return;
    }
    events.push(makeEvent("assistant_thinking_stop", legacyEvent, {
      round: activeRound
    }, {
      source: "gateway",
      visibility: "detail",
      persistence: "redact",
      redaction: "full"
    }));
    activeThinking = false;
  }

  /**
   * @param {string} type
   * @param {Record<string, any>} legacyEvent
   * @param {Record<string, any>} payload
   * @param {{ source?: string; visibility?: string; persistence?: string; redaction?: string; parentToolUseId?: string | null }} overrides
   */
  function makeEvent(type, legacyEvent, payload, overrides = {}) {
    sequence += 1;
    return {
      schemaVersion: ANT_EVENT_SCHEMA_VERSION,
      id: idFactory(sequence, type),
      sequence,
      type,
      at: typeof legacyEvent.at === "string" ? legacyEvent.at : now(),
      sessionId: options.sessionId,
      turnId: activeTurnId,
      round: Number.isFinite(payload.round) ? payload.round : activeRound,
      parentId: null,
      parentToolUseId: overrides.parentToolUseId ?? legacyEvent.parentToolUseId ?? null,
      source: overrides.source ?? "session",
      visibility: overrides.visibility ?? "default",
      persistence: overrides.persistence ?? "persist",
      redaction: overrides.redaction ?? "none",
      payload
    };
  }

  return { normalize };
}

/**
 * @param {Record<string, any>} event
 * @param {{ includePartialMessages?: boolean }} [options]
 */
export function isPrintableAntEvent(event, options = {}) {
  if (!event || event.persistence === "memory") {
    return false;
  }
  if (!options.includePartialMessages && PARTIAL_EVENT_TYPES.has(event.type) && event.payload?.partial === true) {
    return false;
  }
  return true;
}

/**
 * @param {Record<string, any>} event
 */
export function sanitizeAntEventForPersistence(event) {
  if (!event || event.persistence === "memory") {
    return null;
  }
  if (event.redaction === "none") {
    return event;
  }
  return {
    ...event,
    payload: sanitizePayload(event.payload),
    redaction: event.redaction
  };
}

/**
 * @param {{ sessionId: string; events: Array<Record<string, any>>; result: Record<string, any> }} output
 */
export function createAntJsonOutput(output) {
  return {
    schemaVersion: ANT_EVENT_SCHEMA_VERSION,
    sessionId: output.sessionId,
    events: output.events,
    result: output.result
  };
}

/**
 * @param {unknown} value
 * @returns {Record<string, any>}
 */
function sanitizePayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const sanitized = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "type" || key === "at") {
      continue;
    }
    sanitized[key] = sanitizeValue(key, item);
  }
  return sanitized;
}

function sanitizeChangeStats(value, options = {}) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const additions = nonNegativeInteger(value.additions);
  const deletions = nonNegativeInteger(value.deletions);
  const files = nonNegativeInteger(value.files);
  if (!options.allowEmpty && additions === 0 && deletions === 0 && files === 0 && value.redacted !== true) {
    return null;
  }
  const normalized = {
    additions,
    deletions,
    files,
    redacted: value.redacted === true,
    truncated: value.truncated === true,
    approximate: value.approximate === true
  };
  if (typeof value.path === "string" && value.path.trim()) {
    normalized.path = value.path;
  }
  return normalized;
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

/**
 * @param {string} key
 * @param {unknown} value
 */
function sanitizeValue(key, value) {
  if (isSecretKey(key)) {
    return "<redacted>";
  }
  if (typeof value === "string") {
    return redactText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(key, item));
  }
  if (value && typeof value === "object") {
    return sanitizePayload(value);
  }
  return value;
}

/**
 * @param {string} value
 */
export function redactText(value) {
  return String(value)
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "<redacted:key>")
    .replace(/\b(AKIA[0-9A-Z]{16})\b/g, "<redacted:aws-key>")
    .replace(/\b(token|api[_-]?key|password|secret)=([^\s]+)/gi, "$1=<redacted>")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer <redacted>");
}

/**
 * @param {string} key
 */
function isSecretKey(key) {
  return /token|api_?key|password|secret|authorization|credential/i.test(key);
}
