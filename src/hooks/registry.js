import { BLOCKING_EVENTS, HOOK_EVENTS, eventMayBlock, hookPathMatches, normalizeHookEvent } from "./events.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 12_000;
const DEFAULT_ENV_ALLOWLIST = Object.freeze(["PATH", "Path", "SystemRoot", "TEMP", "TMP", "HOME", "USERPROFILE"]);

const DEFAULT_HOOKS = Object.freeze({
  "session.start": [
    builtin("session-start-audit", "auditSession")
  ],
  "session.end": [
    builtin("session-end-audit", "auditSession")
  ],
  "user.prompt": [
    builtin("user-prompt-audit", "auditUserPrompt")
  ],
  "tool.before": [
    builtin("tool-before-audit", "auditToolUse"),
    builtin("record-sensitive-files", "recordSensitiveFiles")
  ],
  "tool.after": [
    builtin("tool-after-audit", "auditToolUse")
  ],
  "tool.failed": [
    builtin("tool-failed-audit", "auditToolUse")
  ],
  "permission.denied": [
    builtin("permission-denied-audit", "auditPermissionDenied")
  ],
  "file.changed": [
    builtin("file-changed-audit", "recordFileChanged")
  ],
  "todo.updated": [
    builtin("todo-updated-audit", "recordTodoUpdated")
  ],
  "subagent.started": [
    builtin("subagent-started-audit", "recordSubagentLifecycle")
  ],
  "subagent.completed": [
    builtin("subagent-completed-audit", "recordSubagentLifecycle")
  ],
  "subagent.failed": [
    builtin("subagent-failed-audit", "recordSubagentLifecycle")
  ],
  "subagent.paused": [
    builtin("subagent-paused-audit", "recordSubagentLifecycle")
  ],
  "delegation.guard": [
    builtin("delegation-guard-audit", "auditDelegationGuard")
  ],
  "compact.before": [
    builtin("compact-before-audit", "compactAudit")
  ],
  "compact.after": [
    builtin("compact-after-audit", "compactAudit")
  ]
});

export function getHookSettings(config = {}) {
  const hooks = config.hooks ?? {};
  const enabled = hooks.enabled !== false && hooks.disableAll !== true;
  return {
    enabled,
    disableAll: hooks.disableAll === true,
    managedOnly: hooks.managedOnly === true,
    defaultTimeoutMs: positiveInteger(hooks.defaultTimeoutMs, DEFAULT_TIMEOUT_MS),
    maxOutputBytes: positiveInteger(hooks.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES),
    envAllowlist: normalizeEnvAllowlist(hooks.envAllowlist),
    events: hooks.events && typeof hooks.events === "object" && !Array.isArray(hooks.events) ? hooks.events : {}
  };
}

export function listConfiguredHooks(config = {}, options = {}) {
  const settings = getHookSettings(config);
  if (!settings.enabled) {
    return [];
  }
  const includeDefaults = options.includeDefaults !== false;
  const rows = [];
  const eventNames = new Set([
    ...(includeDefaults ? Object.keys(DEFAULT_HOOKS) : []),
    ...Object.keys(settings.events ?? {})
  ]);
  for (const event of [...eventNames].sort()) {
    if (!HOOK_EVENTS.includes(event)) {
      continue;
    }
    const hooks = [
      ...(includeDefaults ? DEFAULT_HOOKS[event] ?? [] : []),
      ...normalizeConfiguredHooks(event, settings.events[event] ?? [])
    ];
    for (const hook of hooks) {
      if (settings.managedOnly && hook.managed !== true && hook.source !== "default") {
        continue;
      }
      rows.push(normalizeHook(event, hook, settings));
    }
  }
  return rows;
}

export function matchHooks(config = {}, event, payload = {}, options = {}) {
  const settings = getHookSettings(config);
  if (!settings.enabled) {
    return [];
  }
  const normalizedEvent = normalizeHookEvent(event);
  const hooks = [
    ...(DEFAULT_HOOKS[normalizedEvent] ?? []),
    ...normalizeConfiguredHooks(normalizedEvent, settings.events[normalizedEvent] ?? [])
  ]
    .map((hook) => normalizeHook(normalizedEvent, hook, settings))
    .filter((hook) => {
      if (settings.managedOnly && hook.managed !== true && hook.source !== "default") {
        return false;
      }
      return hookMatchesWhen(hook, payload, options.cwd);
    });
  return hooks;
}

export function validateHookConfig(config = {}) {
  if (config.hooks === undefined) {
    return;
  }
  const hooks = config.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) {
    throw new Error("Unsupported hooks: expected an object");
  }
  for (const key of ["enabled", "disableAll", "managedOnly"]) {
    if (hooks[key] !== undefined && typeof hooks[key] !== "boolean") {
      throw new Error(`Unsupported hooks.${key}: expected boolean`);
    }
  }
  for (const key of ["defaultTimeoutMs", "maxOutputBytes"]) {
    if (hooks[key] !== undefined && (!Number.isInteger(hooks[key]) || hooks[key] <= 0)) {
      throw new Error(`Unsupported hooks.${key}: ${hooks[key]}`);
    }
  }
  if (hooks.envAllowlist !== undefined && !Array.isArray(hooks.envAllowlist)) {
    throw new Error("Unsupported hooks.envAllowlist: expected an array");
  }
  if (hooks.events !== undefined && (!hooks.events || typeof hooks.events !== "object" || Array.isArray(hooks.events))) {
    throw new Error("Unsupported hooks.events: expected an object");
  }
  for (const [event, entries] of Object.entries(hooks.events ?? {})) {
    normalizeHookEvent(event);
    if (!Array.isArray(entries)) {
      throw new Error(`Unsupported hooks.events.${event}: expected an array`);
    }
    for (const hook of entries) {
      validateHookEntry(event, hook);
    }
  }
}

export function formatHookType(hook) {
  if (hook.type === "builtin") {
    return `builtin:${hook.builtin}`;
  }
  if (hook.type === "command") {
    return "command";
  }
  return hook.type ?? "unknown";
}

function builtin(name, builtinName, options = {}) {
  return {
    name,
    type: "builtin",
    builtin: builtinName,
    blocking: options.blocking === true,
    managed: true,
    source: "default"
  };
}

function normalizeConfiguredHooks(event, value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((hook) => hook && typeof hook === "object" && hook.enabled !== false)
    .map((hook, index) => ({
      ...hook,
      name: hook.name || `${event}-${index + 1}`,
      source: hook.source ?? "config"
    }));
}

function normalizeHook(event, hook, settings) {
  const type = hook.type === "command" ? "command" : "builtin";
  const blocking = eventMayBlock(event) && hook.blocking === true;
  return {
    event,
    name: String(hook.name ?? `${event}-hook`),
    type,
    builtin: type === "builtin" ? String(hook.builtin ?? hook.name ?? "") : null,
    command: type === "command" ? String(hook.command ?? "") : null,
    blocking,
    requestedBlocking: hook.blocking === true,
    timeoutMs: positiveInteger(hook.timeoutMs, settings.defaultTimeoutMs),
    maxOutputBytes: positiveInteger(hook.maxOutputBytes, settings.maxOutputBytes),
    envAllowlist: normalizeEnvAllowlist(hook.envAllowlist ?? settings.envAllowlist),
    when: hook.when && typeof hook.when === "object" ? hook.when : {},
    managed: hook.managed === true,
    source: hook.source ?? "config"
  };
}

function hookMatchesWhen(hook, payload, cwd) {
  const paths = hook.when?.paths;
  if (Array.isArray(paths) && paths.length > 0) {
    const targetPaths = Array.isArray(payload.targetPaths) ? payload.targetPaths : [];
    return hookPathMatches(cwd ?? payload.cwd ?? process.cwd(), paths, targetPaths);
  }
  const tools = hook.when?.tools;
  if (Array.isArray(tools) && tools.length > 0) {
    const toolName = String(payload.toolName ?? "");
    return tools.some((tool) => String(tool) === toolName);
  }
  return true;
}

function validateHookEntry(event, hook) {
  if (!hook || typeof hook !== "object" || Array.isArray(hook)) {
    throw new Error(`Unsupported hooks.events.${event} entry: expected object`);
  }
  if (hook.type !== "builtin" && hook.type !== "command") {
    throw new Error(`Unsupported hooks.events.${event} hook type: ${hook.type}`);
  }
  if (hook.type === "builtin" && typeof hook.builtin !== "string") {
    throw new Error(`Unsupported hooks.events.${event} builtin hook: expected builtin string`);
  }
  if (hook.type === "command" && typeof hook.command !== "string") {
    throw new Error(`Unsupported hooks.events.${event} command hook: expected command string`);
  }
  if (hook.blocking === true && !BLOCKING_EVENTS.includes(event)) {
    throw new Error(`Unsupported blocking hook for ${event}: only ${BLOCKING_EVENTS.join(", ")} may block`);
  }
  if (hook.timeoutMs !== undefined && (!Number.isInteger(hook.timeoutMs) || hook.timeoutMs <= 0)) {
    throw new Error(`Unsupported hooks.events.${event} timeoutMs: ${hook.timeoutMs}`);
  }
  if (hook.maxOutputBytes !== undefined && (!Number.isInteger(hook.maxOutputBytes) || hook.maxOutputBytes <= 0)) {
    throw new Error(`Unsupported hooks.events.${event} maxOutputBytes: ${hook.maxOutputBytes}`);
  }
  if (hook.when !== undefined && (!hook.when || typeof hook.when !== "object" || Array.isArray(hook.when))) {
    throw new Error(`Unsupported hooks.events.${event} when: expected object`);
  }
  if (hook.when?.paths !== undefined && !Array.isArray(hook.when.paths)) {
    throw new Error(`Unsupported hooks.events.${event} when.paths: expected array`);
  }
  if (hook.when?.tools !== undefined && !Array.isArray(hook.when.tools)) {
    throw new Error(`Unsupported hooks.events.${event} when.tools: expected array`);
  }
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function normalizeEnvAllowlist(value) {
  const list = Array.isArray(value) ? value : DEFAULT_ENV_ALLOWLIST;
  const normalized = list
    .filter((item) => typeof item === "string" && item.trim())
    .map((item) => item.trim());
  return Array.from(new Set(normalized.length > 0 ? normalized : DEFAULT_ENV_ALLOWLIST));
}
