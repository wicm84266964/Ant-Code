const DEFAULT_MAX_RECORDS = 300;
let nextId = 1;

type HookAuditRecord = {
  id: number;
  at: unknown;
  updatedAt: string;
  event: unknown;
  name: unknown;
  type: unknown;
  source: unknown;
  ok: boolean;
  skipped: boolean;
  blocked: boolean;
  blocking: boolean;
  status: string;
  durationMs: number;
  message: string;
  output: string;
  outputTruncated: boolean;
  error: unknown;
  payloadSummary: string;
};

const records: HookAuditRecord[] = [];

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
}

export function recordHookAudit(record: Record<string, unknown>) {
  const normalized = {
    id: nextId++,
    at: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    event: record.event ?? "unknown",
    name: record.name ?? "unknown",
    type: record.type ?? "unknown",
    source: record.source ?? "default",
    ok: record.ok === true,
    skipped: record.skipped === true,
    blocked: record.blocked === true,
    blocking: record.blocking === true,
    status: normalizeHookAuditStatus(record),
    durationMs: typeof record.durationMs === "number" && Number.isFinite(record.durationMs) ? record.durationMs : 0,
    message: String(record.message ?? ""),
    output: String(record.output ?? ""),
    outputTruncated: record.outputTruncated === true,
    error: record.error ?? null,
    payloadSummary: String(record.payloadSummary ?? "")
  };
  records.push(normalized);
  while (records.length > DEFAULT_MAX_RECORDS) {
    records.shift();
  }
  return normalized;
}

export function updateHookAudit(id: string | number, patch: unknown = {}) {
  const index = records.findIndex((record) => record.id === Number(id) || String(record.id) === String(id));
  if (index < 0) {
    return null;
  }
  const current = records[index];
  const patchRecord = asRecord(patch);
  const next = {
    ...current,
    ...patchRecord,
    id: current.id,
    at: current.at,
    updatedAt: new Date().toISOString()
  };
  next.ok = patchRecord.ok === undefined ? current.ok : patchRecord.ok === true;
  next.skipped = patchRecord.skipped === undefined ? current.skipped : patchRecord.skipped === true;
  next.blocked = patchRecord.blocked === undefined ? current.blocked : patchRecord.blocked === true;
  next.blocking = patchRecord.blocking === undefined ? current.blocking : patchRecord.blocking === true;
  next.status = normalizeHookAuditStatus(next);
  next.durationMs = Number.isFinite(next.durationMs) ? next.durationMs : 0;
  next.message = String(next.message ?? "");
  next.output = String(next.output ?? "");
  next.outputTruncated = next.outputTruncated === true;
  next.error = next.error ?? null;
  next.payloadSummary = String(next.payloadSummary ?? "");
  records[index] = next;
  return { ...next };
}

export function listHookAudit(options: Record<string, unknown> = {}) {
  const rawLimit = options.limit;
  const limit = typeof rawLimit === "number" && Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_MAX_RECORDS;
  const event = typeof options.event === "string" && options.event ? options.event : null;
  const failedOnly = options.failedOnly === true;
  return records
    .filter((record) => !event || record.event === event)
    .filter((record) => !failedOnly || isFailedHookRecord(record))
    .slice(-limit)
    .map((record) => ({ ...record }));
}

export function clearHookAudit() {
  records.length = 0;
  nextId = 1;
}

export function summarizeHookAudit() {
  const byEvent = new Map<unknown, number>();
  let failed = 0;
  let blocked = 0;
  let skipped = 0;
  let running = 0;
  for (const record of records) {
    byEvent.set(record.event, (byEvent.get(record.event) ?? 0) + 1);
    if (record.status === "running" || record.status === "scheduled") {
      running += 1;
    }
    if (record.status === "failed") {
      failed += 1;
    }
    if (record.status === "blocked" || record.blocked) {
      blocked += 1;
    }
    if (record.status === "skipped" || record.skipped) {
      skipped += 1;
    }
  }
  return {
    total: records.length,
    failed,
    blocked,
    skipped,
    running,
    byEvent: Object.fromEntries([...byEvent.entries()].sort(([left], [right]) => String(left).localeCompare(String(right))))
  };
}

function normalizeHookAuditStatus(record: Record<string, unknown> = {}) {
  const explicit = String(record.status ?? "").trim().toLowerCase();
  if (["scheduled", "running", "completed", "failed", "blocked", "skipped"].includes(explicit)) {
    return explicit;
  }
  if (record.skipped === true) {
    return "skipped";
  }
  if (record.blocked === true) {
    return "blocked";
  }
  return record.ok === true ? "completed" : "failed";
}

function isFailedHookRecord(record: Record<string, unknown> = {}) {
  return record.status === "failed" || record.status === "blocked" || record.blocked === true;
}
