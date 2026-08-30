import { appendThinkingPreview } from "../../model-gateway/thinking-budget.ts";
import type { TuiRuntimeEvent, TuiStreamDeltaBuffer, TuiStreamState } from "./types.ts";

export function initialStream(overrides: Partial<TuiStreamState> = {}): TuiStreamState {
  return {
    active: false,
    phase: "idle",
    round: null,
    messageId: null,
    model: null,
    thinking: "",
    thinkingBytes: 0,
    thinkingTruncated: false,
    thinkingVisible: false,
    thinkingRedacted: false,
    text: "",
    tools: [],
    stopReason: null,
    ...overrides
  };
}

export function createStreamDeltaBuffer(): TuiStreamDeltaBuffer {
  return { text: "", textBytes: 0, thinking: "", thinkingBytes: 0, thinkingTruncated: false, round: null };
}

export function appendStreamDelta(buffer: ReturnType<typeof createStreamDeltaBuffer> = createStreamDeltaBuffer(), event: { type?: string; text?: string; bytes?: number; round?: number | null; truncated?: boolean } = {}) {
  const next = {
    text: String(buffer.text ?? ""),
    textBytes: Number(buffer.textBytes) || 0,
    thinking: String(buffer.thinking ?? ""),
    thinkingBytes: Number(buffer.thinkingBytes) || 0,
    thinkingTruncated: buffer.thinkingTruncated === true,
    round: buffer.round ?? null
  };
  if (event.type === "assistant_delta") {
    const text = String(event.text ?? "");
    next.text += text;
    next.textBytes += event.bytes ?? Buffer.byteLength(text, "utf8");
    next.round = event.round ?? next.round;
  } else if (event.type === "assistant_thinking_delta") {
    const text = String(event.text ?? "");
    next.thinking += text;
    next.thinkingBytes += event.bytes ?? Buffer.byteLength(text, "utf8");
    next.thinkingTruncated ||= event.truncated === true;
    next.round = event.round ?? next.round;
  }
  return next;
}

export function applyStreamDeltaBuffer(current: TuiStreamState = initialStream(), buffer: TuiStreamDeltaBuffer = createStreamDeltaBuffer(), options: { thinkingVisible?: boolean } = {}) {
  let next = {
    ...current,
    active: true,
    round: buffer.round ?? current.round
  };
  if (buffer.thinking) {
    const preview = appendThinkingPreview(next.thinking ?? "", buffer.thinking);
    const answerStarted = next.phase === "answering" || String(next.text ?? "").length > 0;
    next = {
      ...next,
      phase: answerStarted ? "answering" : "thinking",
      thinking: preview.text,
      thinkingBytes: next.thinkingBytes + (Number(buffer.thinkingBytes) || 0),
      thinkingVisible: options.thinkingVisible === true,
      thinkingRedacted: options.thinkingVisible !== true,
      thinkingTruncated: Boolean(next.thinkingTruncated || buffer.thinkingTruncated || preview.truncated)
    };
  }
  if (buffer.text) {
    next = {
      ...next,
      phase: "answering",
      text: `${next.text}${buffer.text}`
    };
  }
  return next;
}

export function resolveStreamDeltaActivityStatus(currentStatus: string = "", stream: TuiStreamState | Record<string, unknown> = {}, buffer: TuiStreamDeltaBuffer = createStreamDeltaBuffer()): string {
  if (buffer.text) {
    return "生成回答";
  }
  if (!buffer.thinking) {
    return currentStatus;
  }
  if (stream.phase === "answering" || String(stream.text ?? "").length > 0 || currentStatus === "生成回答") {
    return "生成回答";
  }
  return "思考中";
}

export function appendToolCallDraft(current: TuiStreamState, event: TuiRuntimeEvent) {
  const index = Number.isInteger(event.index) ? Number(event.index) : current.tools.length;
  const tools = [...current.tools];
  const existing = tools[index] ?? {
    index,
    id: event.id ?? null,
    nameDraft: "",
    argumentsDraft: ""
  };
  tools[index] = {
    ...existing,
    id: event.id ?? existing.id ?? null,
    nameDraft: `${existing.nameDraft ?? ""}${event.nameDelta ?? ""}`,
    argumentsDraft: `${existing.argumentsDraft ?? ""}${event.argumentsDelta ?? ""}`
  };
  return {
    ...current,
    active: true,
    phase: "tool-call",
    round: event.round ?? current.round,
    tools
  };
}

export function updateRuntimeTool(current: TuiStreamState, event: TuiRuntimeEvent, status: string) {
  const index = current.tools.findIndex((tool) => tool.id === event.toolCallId);
  const resolvedIndex = index >= 0 ? index : current.tools.length;
  const tools = [...current.tools];
  const existing = tools[resolvedIndex] ?? {
    index: resolvedIndex,
    id: event.toolCallId,
    nameDraft: event.name,
    argumentsDraft: ""
  };
  tools[resolvedIndex] = {
    ...existing,
    id: event.toolCallId ?? existing.id ?? null,
    name: event.name ?? existing.name ?? existing.nameDraft,
    status
  };
  return {
    ...current,
    active: true,
    phase: status === "running" ? "tool-running" : status === "interrupted" ? "tool-interrupted" : "tool-finished",
    tools
  };
}

export function isModelResponseInFlight(stream: TuiStreamState | Partial<TuiStreamState> = initialStream()) {
  if (!stream?.active) {
    return false;
  }
  return new Set(["requesting", "streaming", "thinking", "answering", "tool-call", "finalizing"]).has(stream.phase ?? "");
}
