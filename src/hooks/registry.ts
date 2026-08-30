import { BLOCKING_EVENTS, HOOK_EVENTS, hookPathMatches, normalizeHookEvent } from "./events.ts";

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

type HookConfig = {
  enabled?: boolean;
  disableAll?: boolean;
  managedOnly?: boolean;
  defaultTimeoutMs?: unknown;
  maxOutputBytes?: unknown;
  envAllowlist?: unknown;
  events?: unknown;
};

function hookConfig(config: Record<string, unknown> = {}): HookConfig {
  const hooks = config.hooks;
  return hooks && typeof hooks === "object" && !Array.isArray(hooks) ? hooks as HookConfig : {};
}

export function getHookSettings(config: Record<string, unknown> = {}) {
  const hooks = hookConfig(config);
  const enabled = hooks.enabled !== false && hooks.disableAll !== true;
  return {
    enabled,
    disableAll: hooks.disableAll === true,
    managedOnly: hooks.managedOnly === true,
    defaultTimeoutMs: positiveInteger(hooks.defaultTimeoutMs, DEFAULT_TIMEOUT_MS),
    maxOutputBytes: positiveInteger(hooks.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES),
    envAllowlist: normalizeEnvAllowlist(hooks.envAllowlist),
    events: isRecord(hooks.events) ? hooks.events : {}
  };
}

export function listConfiguredHooks(config: Record<string, unknown> = {}, options: Record<string, unknown> = {}) {
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
    if (!(HOOK_EVENTS as readonly string[]).includes(event)) {
      continue;
    }
    const hooks = [
      ...(includeDefaults ? (DEFAULT_HOOKS as Record<string, HookEntry[]>)[event] ?? [] : []),
      ...normalizeConfiguredHooks(event, isRecord(settings.events) ? settings.events[event] ?? [] : [])
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

export function matchHooks(config: Record<string, unknown> = {}, event: unknown, payload: Record<string, unknown> = {}, options: Record<string, unknown> = {}) {
  const settings = getHookSettings(config);
  if (!settings.enabled) {
    return [];
  }
  const normalizedEvent = normalizeHookEvent(event);
  const hooks = [
    ...((DEFAULT_HOOKS as Record<string, HookEntry[]>)[normalizedEvent] ?? []),
    ...normalizeConfiguredHooks(normalizedEvent, isRecord(settings.events) ? settings.events[normalizedEvent] ?? [] : [])
  ]
    .map((hook) => normalizeHook(normalizedEvent, hook, settings))
    .filter((hook) => {
      if (settings.managedOnly && hook.managed !== true && hook.source !== "default") {
        return false;
      }
      return hookMatchesWhen(hook, payload, typeof options.cwd === "string" ? options.cwd : "");
    });
  return hooks;
}

export function validateHookConfig(config: Record<string, unknown> = {}) {
  if (config.hooks === undefined) {
    return;
  }
  const hooks = config.hooks as Record<string, unknown> | undefined;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) {
    throw new Error("Unsupported hooks: expected an object");
  }
  for (const key of ["enabled", "disableAll", "managedOnly"]) {
    if (hooks[key] !== undefined && typeof hooks[key] !== "boolean") {
      throw new Error(`Unsupported hooks.${key}: expected boolean`);
    }
  }
  for (const key of ["defaultTimeoutMs", "maxOutputBytes"]) {
    const value = hooks[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value) || value <= 0)) {
      throw new Error(`Unsupported hooks.${key}: ${value}`);
    }
  }
  if (hooks.envAllowlist !== undefined && !Array.isArray(hooks.envAllowlist)) {
    throw new Error("Unsupported hooks.envAllowlist: expected an array");
  }
  if (hooks.events !== undefined && (!hooks.events || typeof hooks.events !== "object" || Array.isArray(hooks.events))) {
    throw new Error("Unsupported hooks.events: expected an object");
  }
  for (const [event, entries] of Object.entries(isRecord(hooks.events) ? hooks.events : {})) {
    normalizeHookEvent(event);
    if (!Array.isArray(entries)) {
      throw new Error(`Unsupported hooks.events.${event}: expected an array`);
    }
    for (const hook of entries) {
      validateHookEntry(event, hook);
    }
  }
}

export function formatHookType(hook: HookEntry) {
  if (hook.type === "builtin") {
    return `builtin:${hook.builtin}`;
  }
  if (hook.type === "command") {
    return "command";
  }
  return hook.type ?? "unknown";
}

type HookEntry = {
  name?: string;
  type?: string;
  builtin?: unknown;
  command?: string;
  blocking?: boolean;
  managed?: boolean;
  source?: string;
  enabled?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
  envAllowlist?: unknown;
  when?: { paths?: unknown[]; tools?: unknown[] };
};

function builtin(name: string, builtinName: unknown, options: Record<string, unknown> = {}): HookEntry {
  return {
    name,
    type: "builtin",
    builtin: builtinName,
    blocking: options.blocking === true,
    managed: true,
    source: "default"
  };
}

function normalizeConfiguredHooks(event: string, value: unknown): HookEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((hook): hook is HookEntry => Boolean(hook && typeof hook === "object" && (hook as HookEntry).enabled !== false))
    .map((hook, index) => ({
      ...hook,
      name: hook.name || `${event}-${index + 1}`,
      source: hook.source ?? "config"
    }));
}

function normalizeHook(event: string, hook: HookEntry, settings: { defaultTimeoutMs?: number; maxOutputBytes?: number; envAllowlist?: unknown }) {
  const type = hook.type === "command" ? "command" : "builtin";
  const blocking = (BLOCKING_EVENTS as readonly string[]).includes(event) && hook.blocking === true;
  return {
    event,
    name: String(hook.name ?? `${event}-hook`),
    type,
    builtin: type === "builtin" ? String(hook.builtin ?? hook.name ?? "") : null,
    command: type === "command" ? String(hook.command ?? "") : null,
    blocking,
    requestedBlocking: hook.blocking === true,
    timeoutMs: positiveInteger(hook.timeoutMs, settings.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS),
    maxOutputBytes: positiveInteger(hook.maxOutputBytes, settings.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES),
    envAllowlist: normalizeEnvAllowlist(hook.envAllowlist ?? settings.envAllowlist),
    when: hook.when && typeof hook.when === "object" ? hook.when as { paths?: unknown[]; tools?: unknown[] } : {},
    managed: hook.managed === true,
    source: hook.source ?? "config"
  };
}

function hookMatchesWhen(hook: { when?: { paths?: unknown[]; tools?: unknown[] } }, payload: Record<string, unknown>, cwd: string) {
  const paths = hook.when?.paths;
  if (Array.isArray(paths) && paths.length > 0) {
    const targetPaths = Array.isArray(payload.targetPaths) ? payload.targetPaths : [];
    return hookPathMatches(cwd ?? payload.cwd ?? process.cwd(), paths, targetPaths);
  }
  const tools = hook.when?.tools;
  if (Array.isArray(tools) && tools.length > 0) {
    const toolName = String(payload.toolName ?? "");
    return tools.some((tool: unknown) => String(tool) === toolName);
  }
  return true;
}

function validateHookEntry(event: string, hook: unknown) {
  if (!hook || typeof hook !== "object" || Array.isArray(hook)) {
    throw new Error(`Unsupported hooks.events.${event} entry: expected object`);
  }
  const entry = hook as HookEntry & { when?: { paths?: unknown; tools?: unknown } };
  if (entry.type !== "builtin" && entry.type !== "command") {
    throw new Error(`Unsupported hooks.events.${event} hook type: ${entry.type}`);
  }
  if (entry.type === "builtin" && typeof entry.builtin !== "string") {
    throw new Error(`Unsupported hooks.events.${event} builtin hook: expected builtin string`);
  }
  if (entry.type === "command" && typeof entry.command !== "string") {
    throw new Error(`Unsupported hooks.events.${event} command hook: expected command string`);
  }
  if (entry.blocking === true && !(BLOCKING_EVENTS as readonly string[]).includes(event)) {
    throw new Error(`Unsupported blocking hook for ${event}: only ${BLOCKING_EVENTS.join(", ")} may block`);
  }
  if (entry.timeoutMs !== undefined && (!Number.isInteger(entry.timeoutMs) || entry.timeoutMs <= 0)) {
    throw new Error(`Unsupported hooks.events.${event} timeoutMs: ${entry.timeoutMs}`);
  }
  if (entry.maxOutputBytes !== undefined && (!Number.isInteger(entry.maxOutputBytes) || entry.maxOutputBytes <= 0)) {
    throw new Error(`Unsupported hooks.events.${event} maxOutputBytes: ${entry.maxOutputBytes}`);
  }
  if (entry.when !== undefined && (!entry.when || typeof entry.when !== "object" || Array.isArray(entry.when))) {
    throw new Error(`Unsupported hooks.events.${event} when: expected object`);
  }
  if (entry.when?.paths !== undefined && !Array.isArray(entry.when.paths)) {
    throw new Error(`Unsupported hooks.events.${event} when.paths: expected array`);
  }
  if (entry.when?.tools !== undefined && !Array.isArray(entry.when.tools)) {
    throw new Error(`Unsupported hooks.events.${event} when.tools: expected array`);
  }
}

function positiveInteger(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeEnvAllowlist(value: unknown) {
  const list = Array.isArray(value) ? value : DEFAULT_ENV_ALLOWLIST;
  const normalized = list
    .filter((item) => typeof item === "string" && item.trim())
    .map((item) => item.trim());
  return Array.from(new Set(normalized.length > 0 ? normalized : DEFAULT_ENV_ALLOWLIST));
}
