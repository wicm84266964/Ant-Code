import path from "node:path";

export const HOOK_EVENTS = Object.freeze([
  "session.start",
  "session.end",
  "user.prompt",
  "tool.before",
  "tool.after",
  "tool.failed",
  "permission.denied",
  "file.changed",
  "todo.updated",
  "subagent.started",
  "subagent.completed",
  "subagent.failed",
  "subagent.paused",
  "subagent.group.started",
  "subagent.group.completed",
  "subagent.group.wakeup_queued",
  "delegation.guard",
  "review.gate",
  "compact.before",
  "compact.after"
]);

export const BLOCKING_EVENTS = Object.freeze([
  "tool.before"
]);

const SECRET_KEY_PATTERN = /token|secret|password|api_?key|apikey|credential|authorization|cookie/i;
const SECRET_VALUE_PATTERN = /\b(?:Bearer\s+)?[A-Za-z0-9._~+/=-]{24,}\b/g;
const MAX_TEXT_CHARS = 1200;
const MAX_ARRAY_ITEMS = 20;
const MAX_OBJECT_KEYS = 40;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function lengthOf(value: unknown): unknown {
  if (value == null) {
    return undefined;
  }
  if (typeof value === "string" || Array.isArray(value)) {
    return value.length;
  }
  if (typeof value === "object" && "length" in value) {
    return value.length;
  }
  return undefined;
}

export function isHookEvent(value: unknown) {
  return (HOOK_EVENTS as readonly string[]).includes(String(value ?? ""));
}

export function normalizeHookEvent(value: unknown) {
  const event = String(value ?? "").trim();
  if (!isHookEvent(event)) {
    throw new Error(`Unsupported hook event: ${event || "empty"}`);
  }
  return event;
}

export function eventMayBlock(event: unknown) {
  return (BLOCKING_EVENTS as readonly string[]).includes(String(event ?? ""));
}

export function createHookPayload(event: unknown, payload: Record<string, unknown> = {}, options: Record<string, unknown> = {}) {
  const normalizedEvent = normalizeHookEvent(event);
  const cwd = typeof options.cwd === "string" ? options.cwd : typeof payload.cwd === "string" ? payload.cwd : process.cwd();
  const base = {
    event: normalizedEvent,
    at: new Date().toISOString(),
    cwd,
    sessionId: options.sessionId ?? payload.sessionId ?? null,
    taskId: options.taskId ?? payload.taskId ?? null
  };
  return redactHookValue({
    ...base,
    ...payload,
    event: normalizedEvent,
    cwd
  });
}

export function summarizeHookPayload(payload: unknown = {}) {
  const data = asRecord(payload);
  const event = data.event ?? "unknown";
  const decision = asRecord(data.decision);
  const error = asRecord(data.error);
  if (String(event).startsWith("tool.")) {
    return [
      `tool=${data.toolName ?? "unknown"}`,
      data.ok === undefined ? null : `ok=${Boolean(data.ok)}`,
      data.blocked ? "blocked=true" : null,
      decision.decision ? `decision=${decision.decision}` : null,
      error.code ? `error=${error.code}` : null
    ].filter(Boolean).join(", ");
  }
  if (event === "permission.denied") {
    return [
      `tool=${data.toolName ?? "unknown"}`,
      `decision=${decision.decision ?? "deny"}`,
      decision.reason ? `reason=${truncateText(decision.reason, 120)}` : null
    ].filter(Boolean).join(", ");
  }
  if (event === "file.changed") {
    return [
      `path=${data.path ?? data.targetPath ?? "unknown"}`,
      data.toolName ? `tool=${data.toolName}` : null,
      data.created ? "created" : data.edited ? "edited" : "changed"
    ].filter(Boolean).join(", ");
  }
  if (event === "todo.updated") {
    return `todos=${data.count ?? lengthOf(data.todos) ?? 0}`;
  }
  if (String(event).startsWith("subagent.group.")) {
    return [
      `group=${data.groupId ?? "unknown"}`,
      data.taskId ? `task=${data.taskId}` : null,
      data.status ? `status=${data.status}` : null,
      Array.isArray(data.taskIds) ? `tasks=${data.taskIds.length}` : null
    ].filter(Boolean).join(", ");
  }
  if (String(event).startsWith("subagent.")) {
    return [
      `task=${data.taskId ?? "unknown"}`,
      `profile=${data.profile ?? "unknown"}`,
      data.status ? `status=${data.status}` : null
    ].filter(Boolean).join(", ");
  }
  if (event === "delegation.guard") {
    return [
      `level=${data.level ?? "soft"}`,
      `tool=${data.toolName ?? "unknown"}`,
      Number.isFinite(data.broadActions) ? `broadActions=${data.broadActions}` : null,
      data.reason ? `reason=${truncateText(data.reason, 120)}` : null
    ].filter(Boolean).join(", ");
  }
  if (event === "review.gate") {
    return [
      `level=${data.level ?? "remind"}`,
      Array.isArray(data.reasons) ? `reasons=${data.reasons.length}` : null
    ].filter(Boolean).join(", ");
  }
  if (String(event).startsWith("compact.")) {
    return [
      data.reason ? `reason=${data.reason}` : null,
      data.strategy ? `strategy=${data.strategy}` : null,
      Number.isFinite(data.beforeTokens) ? `tokens=${data.beforeTokens}->${data.afterTokens ?? "?"}` : null
    ].filter(Boolean).join(", ");
  }
  if (String(event).startsWith("session.")) {
    return `session=${data.sessionId ?? "unknown"}`;
  }
  if (event === "user.prompt") {
    return `promptBytes=${data.promptBytes ?? 0}`;
  }
  return truncateText(JSON.stringify(redactHookValue(data)), 180);
}

export function collectHookTargetPaths(input: Record<string, unknown> = {}, result: Record<string, unknown> = {}) {
  const paths: string[] = [];
  for (const source of [input, result]) {
    if (!source || typeof source !== "object") {
      continue;
    }
    addPath(paths, source.path);
    addPath(paths, source.targetPath);
    addPath(paths, source.file);
    const uri = source.uri;
    addPath(paths, typeof uri === "string" && uri.startsWith("file:") ? uri : null);
    if (Array.isArray(source.paths)) {
      for (const item of source.paths) {
        addPath(paths, item);
      }
    }
    if (Array.isArray(source.pathspecs)) {
      for (const item of source.pathspecs) {
        addPath(paths, item);
      }
    }
  }
  return Array.from(new Set(paths.map((item) => String(item))));
}

export function hookPathMatches(cwd: string, patterns: unknown = [], targetPaths: unknown = []) {
  if (!Array.isArray(patterns) || patterns.length === 0) {
    return true;
  }
  const candidates = Array.isArray(targetPaths) && targetPaths.length > 0 ? targetPaths : ["."];
  return candidates.some((candidate: unknown) => {
    const normalized = normalizePathForMatch(cwd, candidate);
    return patterns.some((pattern: unknown) => globToRegex(String(pattern ?? "")).test(normalized));
  });
}

export function redactHookValue(value: unknown, depth = 0): unknown {
  if (depth > 6) {
    return "[truncated]";
  }
  if (typeof value === "string") {
    return redactText(truncateText(value, MAX_TEXT_CHARS));
  }
  if (Array.isArray(value)) {
    const items: unknown[] = value.slice(0, MAX_ARRAY_ITEMS).map((item) => redactHookValue(item, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) {
      items.push(`[${value.length - MAX_ARRAY_ITEMS} more item(s)]`);
    }
    return items;
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const entries: Array<[string, unknown]> = Object.entries(value).slice(0, MAX_OBJECT_KEYS).map(([key, item]) => [
    key,
    SECRET_KEY_PATTERN.test(key) ? "[redacted]" : redactHookValue(item, depth + 1)
  ]);
  if (Object.keys(value).length > MAX_OBJECT_KEYS) {
    entries.push(["_truncatedKeys", Object.keys(value).length - MAX_OBJECT_KEYS]);
  }
  return Object.fromEntries(entries);
}

export function redactText(value: unknown) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]")
    .replace(/(--?(?:api-?key|token|secret|password)(?:=|\s+))\S+/gi, "$1[redacted]")
    .replace(/((?:api_?key|token|secret|password)\s*=\s*)\S+/gi, "$1[redacted]")
    .replace(/([?&](?:api_?key|token|secret|password)=)[^&\s]+/gi, "$1[redacted]")
    .replace(SECRET_VALUE_PATTERN, (match) => looksSecretValue(match) ? "[redacted]" : match);
}

export function truncateText(value: unknown, max = MAX_TEXT_CHARS) {
  const text = String(value ?? "");
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3))}...`;
}

function looksSecretValue(value: unknown) {
  const text = String(value ?? "");
  if (/^[0-9]+$/.test(text)) {
    return false;
  }
  return /[A-Za-z]/.test(text) && /[0-9]/.test(text);
}

function addPath(paths: string[], value: unknown) {
  if (typeof value === "string" && value.trim()) {
    paths.push(value.trim());
  }
}

function normalizePathForMatch(cwd: string, candidate: unknown) {
  const text = String(candidate ?? ".");
  const withoutFileUri = text.startsWith("file://") ? text.replace(/^file:\/+/, "") : text;
  const absolute = path.isAbsolute(withoutFileUri)
    ? withoutFileUri
    : path.resolve(cwd || process.cwd(), withoutFileUri);
  const relative = path.relative(cwd || process.cwd(), absolute) || path.basename(absolute) || ".";
  return toPosix(relative).replace(/^\.\//, "");
}

function globToRegex(pattern: unknown) {
  const normalized = toPosix(pattern).replace(/^\.?\//, "");
  let source = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];
    if (char === "*" && next === "*") {
      index += 1;
      if (normalized[index + 1] === "/") {
        index += 1;
        source += "(?:.*\\/)?";
      } else {
        source += ".*";
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else if (char === "/") {
      source += "\\/";
    } else {
      source += escapeRegex(char);
    }
  }
  source += "$";
  return new RegExp(source);
}

function toPosix(value: unknown) {
  return String(value ?? "").split(path.sep).join("/").replace(/\\/g, "/");
}

function escapeRegex(value: string) {
  return value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}
