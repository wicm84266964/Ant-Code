import crypto from "node:crypto";
import type { SessionMessage } from "./session-types.ts";

export type VisualEvidenceSource = "user" | "mcp" | "file" | "subagent";

export type VisualEvidenceStatus = "pending" | "inspected" | "distilled" | "dropped" | "unreadable";

export type VisualEvidence = {
  id: string;
  source: VisualEvidenceSource;
  name: string;
  mimeType: string;
  bytes: number;
  toolCallId?: string;
  status: VisualEvidenceStatus;
  digest: string;
  data?: string;
  report?: string;
};

export type VisualEvidenceStore = {
  items: VisualEvidence[];
};

export type ImagePayload = {
  data: string;
  mimeType: string;
  name: string;
  size: number;
};

export function createVisualEvidenceStore(): VisualEvidenceStore {
  return { items: [] };
}

export function registerVisualEvidence(
  store: VisualEvidenceStore | null | undefined,
  input: {
    source: VisualEvidenceSource;
    name?: string;
    mimeType?: string;
    data?: string;
    bytes?: number;
    toolCallId?: string;
    status?: VisualEvidenceStatus;
    report?: string;
  }
): VisualEvidence | null {
  if (!store) {
    return null;
  }
  const data = String(input.data ?? "").replace(/\s+/g, "");
  const mimeType = String(input.mimeType ?? "image/png").trim().toLowerCase() || "image/png";
  const digest = data ? sha256Short(data) : `empty-${store.items.length + 1}`;
  const existing = store.items.find((item) => item.digest === digest);
  if (existing) {
    if (data && !existing.data) {
      existing.data = data;
    }
    if (input.report) {
      existing.report = input.report;
    }
    if (input.toolCallId && !existing.toolCallId) {
      existing.toolCallId = input.toolCallId;
    }
    return existing;
  }
  const evidence: VisualEvidence = {
    id: `vis-${store.items.length + 1}`,
    source: input.source,
    name: String(input.name ?? "image").trim().slice(0, 160) || "image",
    mimeType,
    bytes: Number.isFinite(Number(input.bytes)) && Number(input.bytes) > 0
      ? Number(input.bytes)
      : Buffer.byteLength(data, "utf8"),
    toolCallId: input.toolCallId,
    status: input.status ?? (data ? "pending" : "unreadable"),
    digest,
    report: input.report
  };
  if (data) {
    evidence.data = data;
  }
  store.items.push(evidence);
  return evidence;
}

export function listVisualEvidence(store: VisualEvidenceStore | null | undefined): VisualEvidence[] {
  return store?.items ?? [];
}

export function resolveVisualEvidence(
  store: VisualEvidenceStore | null | undefined,
  ids: string[] = []
): VisualEvidence[] {
  if (!store || ids.length === 0) {
    return [];
  }
  const wanted = new Set(ids.map((id) => String(id).trim()).filter(Boolean));
  return store.items.filter((item) => wanted.has(item.id));
}

export function pendingVisualEvidence(store: VisualEvidenceStore | null | undefined): VisualEvidence[] {
  return (store?.items ?? []).filter((item) => item.data && (item.status === "pending" || item.status === "distilled"));
}

export function markVisualEvidenceStatus(
  store: VisualEvidenceStore | null | undefined,
  ids: string[],
  status: VisualEvidenceStatus
) {
  const wanted = new Set(ids);
  for (const item of store?.items ?? []) {
    if (wanted.has(item.id)) {
      item.status = status;
    }
  }
}

export function extractImagePayloads(value: unknown): ImagePayload[] {
  const found: ImagePayload[] = [];
  walk(value);
  return found;

  function walk(input: unknown) {
    if (Array.isArray(input)) {
      for (const item of input) {
        walk(item);
      }
      return;
    }
    if (!input || typeof input !== "object") {
      return;
    }
    const record = input as Record<string, unknown>;
    const payload = imagePayloadFromRecord(record);
    if (payload) {
      found.push(payload);
      return;
    }
    for (const nested of Object.values(record)) {
      if (nested && typeof nested === "object") {
        walk(nested);
      }
    }
  }
}

export function distillLiveImageBlocks(
  messages: SessionMessage[] = [],
  store: VisualEvidenceStore | null | undefined
): SessionMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) {
    return messages;
  }
  for (const message of messages) {
    if (!Array.isArray(message.content)) {
      continue;
    }
    message.content = message.content.map((block) => {
      if (!block || typeof block !== "object") {
        return block;
      }
      const record = block as Record<string, unknown>;
      if (record.type !== "image" || !record.data || record.redacted === true) {
        return block;
      }
      const evidence = registerVisualEvidence(store, {
        source: "user",
        name: String(record.name ?? "image"),
        mimeType: String(record.mimeType ?? record.mime_type ?? "image/png"),
        data: String(record.data),
        bytes: Number(record.size ?? record.bytes ?? 0),
        status: "distilled"
      });
      if (evidence) {
        evidence.status = "distilled";
      }
      return {
        type: "text",
        text: visualEvidenceStubText(evidence)
      };
    });
  }
  return messages;
}

export function visualEvidenceStubText(evidence: VisualEvidence | null): string {
  if (!evidence) {
    return "视觉证据已从主上下文卸下。需要看图时交给 visual-verifier。";
  }
  return [
    `[visual evidence ${evidence.id}] name=${evidence.name} mime=${evidence.mimeType} bytes=${evidence.bytes}`,
    `像素已从主上下文卸下。需要看图时对 visual-verifier 传入 evidenceIds=["${evidence.id}"]。`
  ].join("\n");
}

export function visualEvidenceImageBlocks(evidence: VisualEvidence[] = []) {
  return evidence
    .filter((item) => item.data && /^image\//.test(item.mimeType))
    .slice(-2)
    .map((item) => ({
      type: "image",
      data: item.data,
      mimeType: item.mimeType,
      name: item.name,
      size: item.bytes
    }));
}

export function normalizeEvidenceIds(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item ?? "").trim()).filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) {
    return value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function imagePayloadFromRecord(record: Record<string, unknown>): ImagePayload | null {
  const source = record.source && typeof record.source === "object" && !Array.isArray(record.source)
    ? record.source as Record<string, unknown>
    : null;
  const data = String(record.data ?? source?.data ?? "").replace(/\s+/g, "");
  const mimeType = String(
    record.mimeType ?? record.mime_type ?? source?.media_type ?? source?.mimeType ?? ""
  ).trim().toLowerCase();
  const namedImage = record.type === "image" || record.type === "image_url" || mimeType.startsWith("image/");
  if (!data || !namedImage) {
    return null;
  }
  const resolvedMime = mimeType.startsWith("image/") ? mimeType : "image/png";
  return {
    data,
    mimeType: resolvedMime,
    name: String(record.name ?? "image").trim().slice(0, 160) || "image",
    size: Number(record.size ?? record.bytes ?? Buffer.byteLength(data, "utf8")) || Buffer.byteLength(data, "utf8")
  };
}

function sha256Short(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}
