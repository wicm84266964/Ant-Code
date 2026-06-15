const DEFAULT_MAX_RECORDS = 300;
let nextId = 1;
const records = [];

export function recordHookAudit(record) {
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
    durationMs: Number.isFinite(record.durationMs) ? record.durationMs : 0,
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

export function updateHookAudit(id, patch = {}) {
  const index = records.findIndex((record) => record.id === id);
  if (index < 0) {
    return null;
  }
  const current = records[index];
  const next = {
    ...current,
    ...patch,
    id: current.id,
    at: current.at,
    updatedAt: new Date().toISOString()
  };
  next.ok = patch.ok === undefined ? current.ok : patch.ok === true;
  next.skipped = patch.skipped === undefined ? current.skipped : patch.skipped === true;
  next.blocked = patch.blocked === undefined ? current.blocked : patch.blocked === true;
  next.blocking = patch.blocking === undefined ? current.blocking : patch.blocking === true;
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

export function listHookAudit(options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : DEFAULT_MAX_RECORDS;
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
  const byEvent = new Map();
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
    byEvent: Object.fromEntries([...byEvent.entries()].sort((a, b) => a[0].localeCompare(b[0])))
  };
}

function normalizeHookAuditStatus(record = {}) {
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

function isFailedHookRecord(record = {}) {
  return record.status === "failed" || record.status === "blocked" || record.blocked === true;
}
