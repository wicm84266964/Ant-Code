import { MAX_ENTRIES, TELEMETRY_ENTRY_KINDS, type TuiEntry } from "./types.ts";

export function limitTranscriptEntries(entries: TuiEntry[] | unknown = [], maxEntries: unknown = MAX_ENTRIES) {
  const limit = Math.max(1, Number(maxEntries) || MAX_ENTRIES);
  if (!Array.isArray(entries) || entries.length <= limit) {
    return Array.isArray(entries) ? entries : [];
  }

  const protectedEntries = entries.filter((entry) => isProtectedConversationEntry(entry));
  if (protectedEntries.length >= limit) {
    return protectedEntries;
  }

  const keepTelemetryCount = limit - protectedEntries.length;
  const telemetryEntries = entries
    .filter((entry) => !isProtectedConversationEntry(entry))
    .slice(-keepTelemetryCount);
  const retained = new Set([
    ...protectedEntries,
    ...telemetryEntries
  ]);
  return entries.filter((entry) => retained.has(entry));
}

export function isDiscardableTelemetryEntry(entry: { kind?: string; title?: unknown } = {}) {
  if (!TELEMETRY_ENTRY_KINDS.has(entry.kind ?? "")) {
    return false;
  }
  return entry.kind !== "turn" || !/已中断|中断确认|工具轮次上限/i.test(String(entry.title ?? ""));
}

export function isProtectedConversationEntry(entry: { kind?: string; title?: unknown } | null | undefined = {}) {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  if (entry.kind === "user" || entry.kind === "assistant") {
    return true;
  }
  return !isDiscardableTelemetryEntry(entry);
}
