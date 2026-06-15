/**
 * @returns {Record<string, any>}
 */
export function createInitialEventState() {
  return {
    session: {
      id: null,
      status: "idle"
    },
    transcript: [],
    activeTurn: null,
    activeAssistant: null,
    tools: [],
    errors: []
  };
}

/**
 * @param {Record<string, any>} state
 * @param {Record<string, any>} event
 */
export function reduceAntEvent(state, event) {
  const next = cloneState(state);
  if (!event || typeof event.type !== "string") {
    return next;
  }

  next.session.id = event.sessionId ?? next.session.id;

  if (event.type === "turn_start") {
    next.session.status = "working";
    next.activeTurn = {
      id: event.turnId,
      turnIndex: event.payload?.turnIndex ?? null,
      promptBytes: event.payload?.promptBytes ?? null
    };
    return next;
  }

  if (event.type === "assistant_message_start") {
    next.activeAssistant = {
      id: event.payload?.messageId ?? event.id,
      text: "",
      thinking: {
        state: "none",
        bytes: 0
      },
      round: event.round
    };
    return next;
  }

  if (event.type === "assistant_thinking_start") {
    ensureAssistant(next).thinking.state = "active";
    return next;
  }

  if (event.type === "assistant_thinking_delta") {
    const assistant = ensureAssistant(next);
    assistant.thinking.state = "active";
    assistant.thinking.bytes += Number(event.payload?.bytes ?? 0);
    if (event.persistence === "memory" && typeof event.payload?.text === "string") {
      assistant.thinking.preview = `${assistant.thinking.preview ?? ""}${event.payload.text}`;
    }
    return next;
  }

  if (event.type === "assistant_thinking_stop") {
    ensureAssistant(next).thinking.state = "stopped";
    return next;
  }

  if (event.type === "assistant_text_delta") {
    ensureAssistant(next).text += String(event.payload?.text ?? "");
    return next;
  }

  if (event.type === "assistant_message_stop") {
    const assistant = next.activeAssistant;
    if (assistant) {
      next.transcript.push({
        kind: "assistant",
        text: assistant.text,
        thinking: assistant.thinking.state === "none" ? "none" : "collapsed",
        thinkingBytes: assistant.thinking.bytes,
        round: assistant.round,
        stopReason: event.payload?.stopReason ?? null
      });
    }
    next.activeAssistant = null;
    return next;
  }

  if (event.type === "tool_use_start" || event.type === "tool_start") {
    upsertTool(next, event.payload?.toolUseId ?? event.parentToolUseId ?? event.id, {
      id: event.payload?.toolUseId ?? event.parentToolUseId ?? event.id,
      name: event.payload?.name ?? "tool",
      status: event.type === "tool_start" ? "running" : "planned",
      inputKeys: event.payload?.inputKeys ?? []
    });
    return next;
  }

  if (event.type === "tool_result") {
    const id = event.payload?.toolUseId ?? event.parentToolUseId ?? event.id;
    upsertTool(next, id, {
      id,
      name: event.payload?.name ?? "tool",
      status: event.payload?.status ?? "completed",
      ok: event.payload?.ok === true,
      blocked: event.payload?.blocked === true,
      resultBytes: event.payload?.resultBytes ?? null
    });
    next.transcript.push({
      kind: "tool",
      id,
      name: event.payload?.name ?? "tool",
      status: event.payload?.status ?? "completed"
    });
    return next;
  }

  if (event.type === "gateway_error") {
    next.session.status = "error";
    next.errors.push({
      code: event.payload?.code ?? "GATEWAY_ERROR",
      message: event.payload?.message ?? null
    });
    next.transcript.push({
      kind: "error",
      code: event.payload?.code ?? "GATEWAY_ERROR",
      message: event.payload?.message ?? null
    });
    return next;
  }

  if (event.type === "turn_result") {
    next.session.status = event.payload?.status ?? "completed";
    next.activeTurn = null;
    return next;
  }

  if (event.visibility === "debug") {
    next.transcript.push({
      kind: "debug",
      type: event.type
    });
  }

  return next;
}

/**
 * @param {Array<Record<string, any>>} events
 */
export function reduceAntEvents(events) {
  return events.reduce((state, event) => reduceAntEvent(state, event), createInitialEventState());
}

/**
 * @param {Record<string, any>} state
 */
function ensureAssistant(state) {
  if (!state.activeAssistant) {
    state.activeAssistant = {
      id: null,
      text: "",
      thinking: {
        state: "none",
        bytes: 0
      },
      round: null
    };
  }
  return state.activeAssistant;
}

/**
 * @param {Record<string, any>} state
 * @param {string} id
 * @param {Record<string, any>} patch
 */
function upsertTool(state, id, patch) {
  const key = String(id ?? "tool");
  const index = state.tools.findIndex((tool) => tool.id === key);
  if (index >= 0) {
    state.tools[index] = { ...state.tools[index], ...patch, id: key };
    return;
  }
  state.tools.push({ ...patch, id: key });
}

/**
 * @param {Record<string, any>} state
 */
function cloneState(state) {
  return {
    session: { ...state.session },
    transcript: state.transcript.map((item) => ({ ...item })),
    activeTurn: state.activeTurn ? { ...state.activeTurn } : null,
    activeAssistant: state.activeAssistant ? {
      ...state.activeAssistant,
      thinking: { ...state.activeAssistant.thinking }
    } : null,
    tools: state.tools.map((tool) => ({ ...tool })),
    errors: state.errors.map((error) => ({ ...error }))
  };
}
