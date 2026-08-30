type AssistantThinkingState = {
  state: string;
  bytes: number;
  preview?: string;
};

type ActiveAssistantState = {
  id: unknown;
  text: string;
  thinking: AssistantThinkingState;
  round: unknown;
};

type ActiveTurnState = {
  id: unknown;
  turnIndex: unknown;
  promptBytes: unknown;
};

type EventSessionState = {
  id: unknown;
  status: unknown;
};

type ToolState = {
  id: string;
  name?: unknown;
  status?: unknown;
  inputKeys?: unknown;
  ok?: unknown;
  blocked?: unknown;
  resultBytes?: unknown;
};

type TranscriptItem = {
  kind: string;
  text?: unknown;
  thinking?: unknown;
  thinkingBytes?: unknown;
  round?: unknown;
  stopReason?: unknown;
  id?: unknown;
  name?: unknown;
  status?: unknown;
  code?: unknown;
  message?: unknown;
  type?: unknown;
};

type EventErrorItem = {
  code: unknown;
  message: unknown;
};

export type EventState = {
  session: EventSessionState;
  transcript: TranscriptItem[];
  activeTurn: ActiveTurnState | null;
  activeAssistant: ActiveAssistantState | null;
  tools: ToolState[];
  errors: EventErrorItem[];
  [key: string]: unknown;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function payloadOf(event: Record<string, unknown>): Record<string, unknown> {
  return asRecord(event.payload);
}

/**
 * @returns {Record<string, any>}
 */
export function createInitialEventState(): EventState {
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
export function reduceAntEvent(state: Record<string, unknown>, event: Record<string, unknown>): EventState {
  const next = cloneState(state);
  if (!event || typeof event.type !== "string") {
    return next;
  }

  const payload = payloadOf(event);
  next.session.id = event.sessionId ?? next.session.id;

  if (event.type === "turn_start") {
    next.session.status = "working";
    next.activeTurn = {
      id: event.turnId,
      turnIndex: payload.turnIndex ?? null,
      promptBytes: payload.promptBytes ?? null
    };
    return next;
  }

  if (event.type === "assistant_message_start") {
    next.activeAssistant = {
      id: payload.messageId ?? event.id,
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
    assistant.thinking.bytes += Number(payload.bytes ?? 0);
    if (event.persistence === "memory" && typeof payload.text === "string") {
      assistant.thinking.preview = `${assistant.thinking.preview ?? ""}${payload.text}`;
    }
    return next;
  }

  if (event.type === "assistant_thinking_stop") {
    ensureAssistant(next).thinking.state = "stopped";
    return next;
  }

  if (event.type === "assistant_text_delta") {
    ensureAssistant(next).text += String(payload.text ?? "");
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
        stopReason: payload.stopReason ?? null
      });
    }
    next.activeAssistant = null;
    return next;
  }

  if (event.type === "tool_use_start" || event.type === "tool_start") {
    upsertTool(next, payload.toolUseId ?? event.parentToolUseId ?? event.id, {
      id: payload.toolUseId ?? event.parentToolUseId ?? event.id,
      name: payload.name ?? "tool",
      status: event.type === "tool_start" ? "running" : "planned",
      inputKeys: payload.inputKeys ?? []
    });
    return next;
  }

  if (event.type === "tool_result") {
    const id = payload.toolUseId ?? event.parentToolUseId ?? event.id;
    upsertTool(next, id, {
      id,
      name: payload.name ?? "tool",
      status: payload.status ?? "completed",
      ok: payload.ok === true,
      blocked: payload.blocked === true,
      resultBytes: payload.resultBytes ?? null
    });
    next.transcript.push({
      kind: "tool",
      id,
      name: payload.name ?? "tool",
      status: payload.status ?? "completed"
    });
    return next;
  }

  if (event.type === "gateway_error") {
    next.session.status = "error";
    next.errors.push({
      code: payload.code ?? "GATEWAY_ERROR",
      message: payload.message ?? null
    });
    next.transcript.push({
      kind: "error",
      code: payload.code ?? "GATEWAY_ERROR",
      message: payload.message ?? null
    });
    return next;
  }

  if (event.type === "turn_result") {
    next.session.status = payload.status ?? "completed";
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
export function reduceAntEvents(events: Array<Record<string, unknown>>): EventState {
  let state = createInitialEventState();
  for (const event of events) {
    state = reduceAntEvent(state, event);
  }
  return state;
}

/**
 * @param {Record<string, any>} state
 */
function ensureAssistant(state: EventState): ActiveAssistantState {
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
function upsertTool(state: EventState, id: unknown, patch: Record<string, unknown>) {
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
function cloneState(state: Record<string, unknown>): EventState {
  const session = asRecord(state.session);
  const transcript = Array.isArray(state.transcript) ? state.transcript : [];
  const tools = Array.isArray(state.tools) ? state.tools : [];
  const errors = Array.isArray(state.errors) ? state.errors : [];
  return {
    session: {
      id: session.id ?? null,
      status: session.status ?? "idle"
    },
    transcript: transcript.map((item) => ({ ...asRecord(item) } as TranscriptItem)),
    activeTurn: cloneActiveTurn(state.activeTurn),
    activeAssistant: cloneActiveAssistant(state.activeAssistant),
    tools: tools.map((tool) => cloneTool(tool)),
    errors: errors.map((error) => cloneError(error))
  };
}

function cloneActiveTurn(value: unknown): ActiveTurnState | null {
  if (!isRecord(value)) {
    return null;
  }
  return {
    id: value.id,
    turnIndex: value.turnIndex,
    promptBytes: value.promptBytes
  };
}

function cloneActiveAssistant(value: unknown): ActiveAssistantState | null {
  if (!isRecord(value)) {
    return null;
  }
  return {
    id: value.id,
    text: typeof value.text === "string" ? value.text : "",
    thinking: cloneThinking(value.thinking),
    round: value.round
  };
}

function cloneThinking(value: unknown): AssistantThinkingState {
  const record = asRecord(value);
  const bytes = record.bytes;
  const thinking: AssistantThinkingState = {
    state: typeof record.state === "string" ? record.state : "none",
    bytes: typeof bytes === "number" && Number.isFinite(bytes) ? bytes : 0
  };
  if (typeof record.preview === "string") {
    thinking.preview = record.preview;
  }
  return thinking;
}

function cloneTool(value: unknown): ToolState {
  const record = asRecord(value);
  return {
    ...record,
    id: typeof record.id === "string" ? record.id : String(record.id ?? "tool")
  };
}

function cloneError(value: unknown): EventErrorItem {
  const record = asRecord(value);
  return {
    code: record.code,
    message: record.message
  };
}
