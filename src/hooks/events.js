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

export function isHookEvent(value) {
  return HOOK_EVENTS.includes(String(value ?? ""));
}

export function normalizeHookEvent(value) {
  const event = String(value ?? "").trim();
  if (!isHookEvent(event)) {
    throw new Error(`Unsupported hook event: ${event || "empty"}`);
  }
  return event;
}

export function eventMayBlock(event) {
  return BLOCKING_EVENTS.includes(String(event ?? ""));
}

export function createHookPayload(event, payload = {}, options = {}) {
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

export function summarizeHookPayload(payload = {}) {
  const event = payload.event ?? "unknown";
  if (String(event).startsWith("tool.")) {
    return [
      `tool=${payload.toolName ?? "unknown"}`,
      payload.ok === undefined ? null : `ok=${Boolean(payload.ok)}`,
      payload.blocked ? "blocked=true" : null,
      payload.decision?.decision ? `decision=${payload.decision.decision}` : null,
      payload.error?.code ? `error=${payload.error.code}` : null
    ].filter(Boolean).join(", ");
  }
  if (event === "permission.denied") {
    return [
      `tool=${payload.toolName ?? "unknown"}`,
      `decision=${payload.decision?.decision ?? "deny"}`,
      payload.decision?.reason ? `reason=${truncateText(payload.decision.reason, 120)}` : null
    ].filter(Boolean).join(", ");
  }
  if (event === "file.changed") {
    return [
      `path=${payload.path ?? payload.targetPath ?? "unknown"}`,
      payload.toolName ? `tool=${payload.toolName}` : null,
      payload.created ? "created" : payload.edited ? "edited" : "changed"
    ].filter(Boolean).join(", ");
  }
  if (event === "todo.updated") {
    return `todos=${payload.count ?? payload.todos?.length ?? 0}`;
  }
  if (String(event).startsWith("subagent.group.")) {
    return [
      `group=${payload.groupId ?? "unknown"}`,
      payload.taskId ? `task=${payload.taskId}` : null,
      payload.status ? `status=${payload.status}` : null,
      Array.isArray(payload.taskIds) ? `tasks=${payload.taskIds.length}` : null
    ].filter(Boolean).join(", ");
  }
  if (String(event).startsWith("subagent.")) {
    return [
      `task=${payload.taskId ?? "unknown"}`,
      `profile=${payload.profile ?? "unknown"}`,
      payload.status ? `status=${payload.status}` : null
    ].filter(Boolean).join(", ");
  }
  if (event === "delegation.guard") {
    return [
      `level=${payload.level ?? "soft"}`,
      `tool=${payload.toolName ?? "unknown"}`,
      Number.isFinite(payload.broadActions) ? `broadActions=${payload.broadActions}` : null,
      payload.reason ? `reason=${truncateText(payload.reason, 120)}` : null
    ].filter(Boolean).join(", ");
  }
  if (event === "review.gate") {
    return [
      `level=${payload.level ?? "remind"}`,
      Array.isArray(payload.reasons) ? `reasons=${payload.reasons.length}` : null
    ].filter(Boolean).join(", ");
  }
  if (String(event).startsWith("compact.")) {
    return [
      payload.reason ? `reason=${payload.reason}` : null,
      payload.strategy ? `strategy=${payload.strategy}` : null,
      Number.isFinite(payload.beforeTokens) ? `tokens=${payload.beforeTokens}->${payload.afterTokens ?? "?"}` : null
    ].filter(Boolean).join(", ");
  }
  if (String(event).startsWith("session.")) {
    return `session=${payload.sessionId ?? "unknown"}`;
  }
  if (event === "user.prompt") {
    return `promptBytes=${payload.promptBytes ?? 0}`;
  }
  return truncateText(JSON.stringify(redactHookValue(payload)), 180);
}

export function collectHookTargetPaths(input = {}, result = {}) {
  const paths = [];
  for (const source of [input, result]) {
    if (!source || typeof source !== "object") {
      continue;
    }
    addPath(paths, source.path);
    addPath(paths, source.targetPath);
    addPath(paths, source.file);
    addPath(paths, source.uri?.startsWith?.("file:") ? source.uri : null);
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

export function hookPathMatches(cwd, patterns = [], targetPaths = []) {
  if (!Array.isArray(patterns) || patterns.length === 0) {
    return true;
  }
  const candidates = targetPaths.length > 0 ? targetPaths : ["."];
  return candidates.some((candidate) => {
    const normalized = normalizePathForMatch(cwd, candidate);
    return patterns.some((pattern) => globToRegex(String(pattern ?? "")).test(normalized));
  });
}

export function redactHookValue(value, depth = 0) {
  if (depth > 6) {
    return "[truncated]";
  }
  if (typeof value === "string") {
    return redactText(truncateText(value, MAX_TEXT_CHARS));
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => redactHookValue(item, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) {
      items.push(`[${value.length - MAX_ARRAY_ITEMS} more item(s)]`);
    }
    return items;
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const entries = Object.entries(value).slice(0, MAX_OBJECT_KEYS).map(([key, item]) => [
    key,
    SECRET_KEY_PATTERN.test(key) ? "[redacted]" : redactHookValue(item, depth + 1)
  ]);
  if (Object.keys(value).length > MAX_OBJECT_KEYS) {
    entries.push(["_truncatedKeys", Object.keys(value).length - MAX_OBJECT_KEYS]);
  }
  return Object.fromEntries(entries);
}

export function redactText(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]")
    .replace(/(--?(?:api-?key|token|secret|password)(?:=|\s+))\S+/gi, "$1[redacted]")
    .replace(/((?:api_?key|token|secret|password)\s*=\s*)\S+/gi, "$1[redacted]")
    .replace(/([?&](?:api_?key|token|secret|password)=)[^&\s]+/gi, "$1[redacted]")
    .replace(SECRET_VALUE_PATTERN, (match) => looksSecretValue(match) ? "[redacted]" : match);
}

export function truncateText(value, max = MAX_TEXT_CHARS) {
  const text = String(value ?? "");
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3))}...`;
}

function looksSecretValue(value) {
  const text = String(value ?? "");
  if (/^[0-9]+$/.test(text)) {
    return false;
  }
  return /[A-Za-z]/.test(text) && /[0-9]/.test(text);
}

function addPath(paths, value) {
  if (typeof value === "string" && value.trim()) {
    paths.push(value.trim());
  }
}

function normalizePathForMatch(cwd, candidate) {
  const text = String(candidate ?? ".");
  const withoutFileUri = text.startsWith("file://") ? text.replace(/^file:\/+/, "") : text;
  const absolute = path.isAbsolute(withoutFileUri)
    ? withoutFileUri
    : path.resolve(cwd || process.cwd(), withoutFileUri);
  const relative = path.relative(cwd || process.cwd(), absolute) || path.basename(absolute) || ".";
  return toPosix(relative).replace(/^\.\//, "");
}

function globToRegex(pattern) {
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

function toPosix(value) {
  return String(value ?? "").split(path.sep).join("/").replace(/\\/g, "/");
}

function escapeRegex(value) {
  return value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}
