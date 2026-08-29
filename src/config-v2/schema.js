export const CONFIG_V2_SETTINGS_VERSION = 2;

export const CONFIG_V2_PROTOCOLS = Object.freeze([
  "lab-agent-gateway",
  "openai-chat",
  "openai-responses",
  "anthropic-messages"
]);

export const CONFIG_V2_RELIABILITY_DEFAULTS = Object.freeze({
  maxRetries: 5,
  timeoutMs: 900_000,
  idleTimeoutMs: 300_000,
  maxResponseBytes: 32 * 1024 * 1024
});

const NAMESPACE_KEYS = Object.freeze([
  "model-providers",
  "default-model",
  "agent-routing"
]);
const PROVIDER_ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const EFFORT_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const CREDENTIAL_REF = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TIER_ID = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const RESERVED_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const INPUT_MODALITIES = new Set(["text", "image"]);
const REASONING_CONTENT_MODES = new Set(["hidden", "visible-when-no-content"]);

export class ConfigV2ValidationError extends TypeError {
  /** @param {string} path @param {string} message */
  constructor(path, message) {
    super(`${path}: ${message}`);
    this.name = "ConfigV2ValidationError";
    this.code = "CONFIG_V2_VALIDATION_ERROR";
    this.path = path;
  }
}

/**
 * Return whether a value is a complete, structurally valid V2 settings layer.
 * This is a full validation guard, not a version-number probe.
 *
 * @param {unknown} document
 */
export function isV2SettingsDocument(document) {
  try {
    validateSettingsDocument(document);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate and detach one raw V2 settings layer. Validation is deliberately
 * structural: cross-layer provider/model references are checked by the
 * resolver after all provider scopes are known.
 *
 * @param {unknown} document
 * @param {{ label?: string }} [options]
 * @returns {Record<string, any>}
 */
export function validateSettingsDocument(document, options = {}) {
  const rootPath = options.label ? `$[${options.label}]` : "$";
  const root = strictObject(document, rootPath, ["settingsVersion", "namespaces"], [
    "settingsVersion",
    "namespaces"
  ]);
  if (root.settingsVersion !== CONFIG_V2_SETTINGS_VERSION) {
    fail(`${rootPath}.settingsVersion`, `expected ${CONFIG_V2_SETTINGS_VERSION}`);
  }
  const namespaces = strictObject(root.namespaces, `${rootPath}.namespaces`, NAMESPACE_KEYS);
  /** @type {Record<string, any>} */
  const normalizedNamespaces = {};
  if (hasOwn(namespaces, "model-providers")) {
    normalizedNamespaces["model-providers"] = normalizeProviderNamespace(
      namespaces["model-providers"],
      `${rootPath}.namespaces.model-providers`
    );
  }
  if (hasOwn(namespaces, "default-model")) {
    normalizedNamespaces["default-model"] = normalizeDefaultModelNamespace(
      namespaces["default-model"],
      `${rootPath}.namespaces.default-model`
    );
  }
  if (hasOwn(namespaces, "agent-routing")) {
    normalizedNamespaces["agent-routing"] = normalizeAgentRoutingNamespace(
      namespaces["agent-routing"],
      `${rootPath}.namespaces.agent-routing`
    );
  }
  return {
    settingsVersion: CONFIG_V2_SETTINGS_VERSION,
    namespaces: normalizedNamespaces
  };
}

/**
 * Recursively freeze an object graph and return the same value.
 *
 * @template T
 * @param {T} value
 * @param {WeakSet<object>} [seen]
 * @returns {T}
 */
export function deepFreeze(value, seen = new WeakSet()) {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return value;
  }
  const object = /** @type {object} */ (value);
  if (seen.has(object)) return value;
  seen.add(object);
  for (const key of Reflect.ownKeys(object)) {
    deepFreeze(/** @type {any} */ (object)[key], seen);
  }
  return Object.freeze(value);
}

/** @param {unknown} value @param {string} path */
function normalizeProviderNamespace(value, path) {
  const namespace = strictObject(value, path, ["providers"], ["providers"]);
  const providers = strictObject(namespace.providers, `${path}.providers`, null);
  /** @type {Record<string, any>} */
  const normalizedProviders = {};
  for (const [providerId, provider] of Object.entries(providers)) {
    validateProviderId(providerId, `${path}.providers`);
    normalizedProviders[providerId] = normalizeProvider(provider, `${path}.providers.${providerId}`);
  }
  return { providers: normalizedProviders };
}

/** @param {unknown} value @param {string} path */
function normalizeDefaultModelNamespace(value, path) {
  const namespace = strictObject(value, path, ["selection"], ["selection"]);
  return { selection: normalizeModelReference(namespace.selection, `${path}.selection`) };
}

/** @param {unknown} value @param {string} path */
function normalizeAgentRoutingNamespace(value, path) {
  const namespace = strictObject(value, path, ["modelTiers", "vision", "compat"]);
  /** @type {Record<string, any>} */
  const normalized = {};
  if (hasOwn(namespace, "modelTiers")) {
    normalized.modelTiers = normalizeQualifiedModelTiers(namespace.modelTiers, `${path}.modelTiers`);
  }
  if (hasOwn(namespace, "vision")) {
    normalized.vision = normalizeQualifiedVision(namespace.vision, `${path}.vision`);
  }
  if (hasOwn(namespace, "compat")) {
    normalized.compat = normalizeCompatObject(namespace.compat, `${path}.compat`);
  }
  return normalized;
}

/** @param {unknown} value @param {string} path */
function normalizeProvider(value, path) {
  const provider = strictObject(value, path, [
    "displayName",
    "transport",
    "auth",
    "models",
    "reliability",
    "agents",
    "compat"
  ], ["displayName", "transport", "auth", "models"]);
  const displayName = nonEmptyString(provider.displayName, `${path}.displayName`, 160);
  if (!Array.isArray(provider.models) || provider.models.length === 0) {
    fail(`${path}.models`, "expected a non-empty array");
  }
  const seenModels = new Set();
  const models = /** @type {any[]} */ (provider.models).map((model, index) => {
    const normalized = normalizeModel(model, `${path}.models[${index}]`);
    if (seenModels.has(normalized.id)) {
      fail(`${path}.models[${index}].id`, `duplicate model id "${normalized.id}"`);
    }
    seenModels.add(normalized.id);
    return normalized;
  });
  /** @type {Record<string, any>} */
  const normalized = {
    displayName,
    transport: normalizeTransport(provider.transport, `${path}.transport`),
    auth: normalizeAuth(provider.auth, `${path}.auth`),
    models
  };
  if (hasOwn(provider, "reliability")) {
    normalized.reliability = normalizeReliability(provider.reliability, `${path}.reliability`);
  }
  if (hasOwn(provider, "agents")) {
    normalized.agents = normalizeProviderAgents(provider.agents, `${path}.agents`);
  }
  if (hasOwn(provider, "compat")) {
    normalized.compat = normalizeCompatObject(provider.compat, `${path}.compat`);
  }
  return normalized;
}

/** @param {unknown} value @param {string} path */
function normalizeTransport(value, path) {
  const transport = strictObject(value, path, ["protocol", "baseURL", "healthURL", "compat"], [
    "protocol",
    "baseURL"
  ]);
  const protocol = nonEmptyString(transport.protocol, `${path}.protocol`, 64);
  if (!CONFIG_V2_PROTOCOLS.includes(protocol)) {
    fail(`${path}.protocol`, `unsupported protocol "${protocol}"`);
  }
  /** @type {Record<string, any>} */
  const normalized = {
    protocol,
    baseURL: httpUrl(transport.baseURL, `${path}.baseURL`)
  };
  if (hasOwn(transport, "healthURL")) {
    normalized.healthURL = transport.healthURL === null
      ? null
      : httpUrl(transport.healthURL, `${path}.healthURL`);
  }
  if (hasOwn(transport, "compat")) {
    normalized.compat = normalizeCompatObject(transport.compat, `${path}.compat`);
  }
  return normalized;
}

/** @param {unknown} value @param {string} path */
function normalizeAuth(value, path) {
  const auth = strictObject(value, path, ["mode", "ref"], ["mode"]);
  if (!new Set(["credential", "ambient", "none"]).has(auth.mode)) {
    fail(`${path}.mode`, "expected credential, ambient, or none");
  }
  if (auth.mode === "credential") {
    const ref = nonEmptyString(auth.ref, `${path}.ref`, 128);
    if (!CREDENTIAL_REF.test(ref)) {
      fail(`${path}.ref`, "expected a POSIX environment-style credential reference");
    }
    return { mode: "credential", ref };
  }
  if (hasOwn(auth, "ref") && auth.ref !== null) {
    fail(`${path}.ref`, `must be omitted or null when auth mode is "${auth.mode}"`);
  }
  return { mode: auth.mode };
}

/** @param {unknown} value @param {string} path */
function normalizeModel(value, path) {
  const model = strictObject(value, path, [
    "id",
    "displayName",
    "description",
    "thinking",
    "inputModalities",
    "contextWindow",
    "maxOutputTokens",
    "reasoningContentMode",
    "reasoning",
    "openaiExtraBody",
    "agentModelTiers",
    "compat"
  ], ["id"]);
  /** @type {Record<string, any>} */
  const normalized = { id: modelId(model.id, `${path}.id`) };
  if (hasOwn(model, "displayName")) {
    normalized.displayName = nonEmptyString(model.displayName, `${path}.displayName`, 160);
  }
  if (hasOwn(model, "description")) {
    normalized.description = stringValue(model.description, `${path}.description`, 4_096);
  }
  if (hasOwn(model, "thinking")) {
    normalized.thinking = booleanValue(model.thinking, `${path}.thinking`);
  }
  if (hasOwn(model, "inputModalities")) {
    normalized.inputModalities = normalizeModalities(model.inputModalities, `${path}.inputModalities`);
  }
  if (hasOwn(model, "contextWindow")) {
    normalized.contextWindow = positiveInteger(model.contextWindow, `${path}.contextWindow`);
  }
  if (hasOwn(model, "maxOutputTokens")) {
    normalized.maxOutputTokens = positiveInteger(model.maxOutputTokens, `${path}.maxOutputTokens`);
  }
  if (hasOwn(model, "reasoningContentMode")) {
    if (model.reasoningContentMode !== null && !REASONING_CONTENT_MODES.has(model.reasoningContentMode)) {
      fail(`${path}.reasoningContentMode`, "expected hidden, visible-when-no-content, or null");
    }
    normalized.reasoningContentMode = model.reasoningContentMode;
  }
  if (hasOwn(model, "reasoning")) {
    normalized.reasoning = normalizeReasoning(model.reasoning, `${path}.reasoning`);
  }
  if (hasOwn(model, "openaiExtraBody")) {
    normalized.openaiExtraBody = model.openaiExtraBody === null
      ? null
      : normalizeCompatObject(model.openaiExtraBody, `${path}.openaiExtraBody`);
  }
  if (hasOwn(model, "agentModelTiers")) {
    normalized.agentModelTiers = normalizeLocalModelTiers(model.agentModelTiers, `${path}.agentModelTiers`);
  }
  if (hasOwn(model, "compat")) {
    normalized.compat = normalizeCompatObject(model.compat, `${path}.compat`);
  }
  return normalized;
}

/** @param {unknown} value @param {string} path */
function normalizeReasoning(value, path) {
  const reasoning = strictObject(value, path, ["efforts", "default"], ["efforts"]);
  if (!Array.isArray(reasoning.efforts) || reasoning.efforts.length === 0) {
    fail(`${path}.efforts`, "expected a non-empty array");
  }
  const seen = new Set();
  const efforts = /** @type {any[]} */ (reasoning.efforts).map((effort, index) => {
    const effortPath = `${path}.efforts[${index}]`;
    const entry = strictObject(effort, effortPath, ["id", "label", "description"], ["id"]);
    const id = effortId(entry.id, `${effortPath}.id`);
    if (seen.has(id)) fail(`${effortPath}.id`, `duplicate reasoning effort "${id}"`);
    seen.add(id);
    /** @type {Record<string, any>} */
    const normalized = { id };
    if (hasOwn(entry, "label")) normalized.label = nonEmptyString(entry.label, `${effortPath}.label`, 80);
    if (hasOwn(entry, "description")) {
      normalized.description = stringValue(entry.description, `${effortPath}.description`, 1_024);
    }
    return normalized;
  });
  /** @type {Record<string, any>} */
  const normalized = { efforts };
  if (hasOwn(reasoning, "default")) {
    if (reasoning.default === null) {
      normalized.default = null;
    } else {
      const defaultEffort = effortId(reasoning.default, `${path}.default`);
      if (!seen.has(defaultEffort)) {
        fail(`${path}.default`, `unknown reasoning effort "${defaultEffort}"`);
      }
      normalized.default = defaultEffort;
    }
  }
  return normalized;
}

/** @param {unknown} value @param {string} path */
function normalizeReliability(value, path) {
  const reliability = strictObject(value, path, [
    "maxRetries",
    "timeoutMs",
    "idleTimeoutMs",
    "maxResponseBytes"
  ]);
  /** @type {Record<string, any>} */
  const normalized = {};
  if (hasOwn(reliability, "maxRetries")) {
    normalized.maxRetries = nonNegativeInteger(reliability.maxRetries, `${path}.maxRetries`);
  }
  for (const field of ["timeoutMs", "idleTimeoutMs", "maxResponseBytes"]) {
    if (hasOwn(reliability, field)) {
      normalized[field] = positiveInteger(reliability[field], `${path}.${field}`);
    }
  }
  return normalized;
}

/** @param {unknown} value @param {string} path */
function normalizeProviderAgents(value, path) {
  const agents = strictObject(value, path, ["modelTiers", "vision", "compat"]);
  /** @type {Record<string, any>} */
  const normalized = {};
  if (hasOwn(agents, "modelTiers")) {
    normalized.modelTiers = normalizeLocalModelTiers(agents.modelTiers, `${path}.modelTiers`);
  }
  if (hasOwn(agents, "vision")) {
    normalized.vision = normalizeLocalVision(agents.vision, `${path}.vision`);
  }
  if (hasOwn(agents, "compat")) {
    normalized.compat = normalizeCompatObject(agents.compat, `${path}.compat`);
  }
  return normalized;
}

/** @param {unknown} value @param {string} path */
function normalizeLocalVision(value, path) {
  const vision = strictObject(value, path, ["enabled", "model", "autoUseWhenMainModelTextOnly"]);
  /** @type {Record<string, any>} */
  const normalized = {};
  if (hasOwn(vision, "enabled")) normalized.enabled = booleanValue(vision.enabled, `${path}.enabled`);
  if (hasOwn(vision, "model")) {
    normalized.model = vision.model === null ? null : modelId(vision.model, `${path}.model`);
  }
  if (hasOwn(vision, "autoUseWhenMainModelTextOnly")) {
    normalized.autoUseWhenMainModelTextOnly = booleanValue(
      vision.autoUseWhenMainModelTextOnly,
      `${path}.autoUseWhenMainModelTextOnly`
    );
  }
  return normalized;
}

/** @param {unknown} value @param {string} path */
function normalizeQualifiedVision(value, path) {
  const vision = strictObject(value, path, ["enabled", "model", "autoUseWhenMainModelTextOnly"]);
  /** @type {Record<string, any>} */
  const normalized = {};
  if (hasOwn(vision, "enabled")) normalized.enabled = booleanValue(vision.enabled, `${path}.enabled`);
  if (hasOwn(vision, "model")) {
    normalized.model = vision.model === null ? null : normalizeModelReference(vision.model, `${path}.model`);
  }
  if (hasOwn(vision, "autoUseWhenMainModelTextOnly")) {
    normalized.autoUseWhenMainModelTextOnly = booleanValue(
      vision.autoUseWhenMainModelTextOnly,
      `${path}.autoUseWhenMainModelTextOnly`
    );
  }
  return normalized;
}

/** @param {unknown} value @param {string} path */
function normalizeQualifiedModelTiers(value, path) {
  const tiers = strictObject(value, path, null);
  /** @type {Record<string, any>} */
  const normalized = {};
  for (const [tier, reference] of Object.entries(tiers)) {
    validateTierId(tier, path);
    normalized[tier] = normalizeModelReference(reference, `${path}.${tier}`);
  }
  return normalized;
}

/** @param {unknown} value @param {string} path */
function normalizeLocalModelTiers(value, path) {
  const tiers = strictObject(value, path, null);
  /** @type {Record<string, any>} */
  const normalized = {};
  for (const [tier, model] of Object.entries(tiers)) {
    validateTierId(tier, path);
    normalized[tier] = modelId(model, `${path}.${tier}`);
  }
  return normalized;
}

/** @param {unknown} value @param {string} path */
function normalizeModelReference(value, path) {
  const reference = strictObject(value, path, ["provider", "model", "reasoningEffort"], [
    "provider",
    "model"
  ]);
  const provider = nonEmptyString(reference.provider, `${path}.provider`, 128);
  validateProviderId(provider, `${path}.provider`);
  /** @type {Record<string, any>} */
  const normalized = {
    provider,
    model: modelId(reference.model, `${path}.model`)
  };
  if (hasOwn(reference, "reasoningEffort")) {
    normalized.reasoningEffort = effortId(reference.reasoningEffort, `${path}.reasoningEffort`);
  }
  return normalized;
}

/** @param {unknown} value @param {string} path */
function normalizeModalities(value, path) {
  if (!Array.isArray(value) || value.length === 0) fail(path, "expected a non-empty array");
  const seen = new Set();
  return value.map((modality, index) => {
    if (typeof modality !== "string" || !INPUT_MODALITIES.has(modality)) {
      fail(`${path}[${index}]`, "expected text or image");
    }
    if (seen.has(modality)) fail(`${path}[${index}]`, `duplicate modality "${modality}"`);
    seen.add(modality);
    return modality;
  });
}

/** @param {unknown} value @param {string} path */
function normalizeCompatObject(value, path) {
  if (!isPlainObject(value)) fail(path, "expected a JSON object");
  return cloneJsonValue(value, path, new WeakSet());
}

/** @param {unknown} value @param {string} path @param {WeakSet<object>} seen @returns {any} */
function cloneJsonValue(value, path, seen) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(path, "expected a finite JSON number");
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) fail(path, "circular JSON value");
    seen.add(value);
    /** @type {any[]} */
    const cloned = value.map((entry, index) => cloneJsonValue(entry, `${path}[${index}]`, seen));
    seen.delete(value);
    return cloned;
  }
  if (!isPlainObject(value)) fail(path, "expected a JSON-compatible value");
  if (seen.has(value)) fail(path, "circular JSON value");
  seen.add(value);
  /** @type {Record<string, any>} */
  const cloned = {};
  for (const [key, entry] of Object.entries(value)) {
    if (RESERVED_OBJECT_KEYS.has(key)) fail(`${path}.${key}`, "reserved object key");
    cloned[key] = cloneJsonValue(entry, `${path}.${key}`, seen);
  }
  seen.delete(value);
  return cloned;
}

/** @param {unknown} value @param {string} path */
function httpUrl(value, path) {
  const text = nonEmptyString(value, path, 2_048);
  /** @type {URL} */
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    fail(path, "expected an absolute HTTP(S) URL");
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol) || parsed.username || parsed.password) {
    fail(path, "expected an absolute HTTP(S) URL without embedded credentials");
  }
  return text;
}

/** @param {unknown} value @param {string} path @param {number} maxLength */
function nonEmptyString(value, path, maxLength) {
  const text = stringValue(value, path, maxLength).trim();
  if (!text) fail(path, "expected a non-empty string");
  if (/[\r\n\t\0]/.test(text)) fail(path, "contains control characters");
  return text;
}

/** @param {unknown} value @param {string} path @param {number} maxLength */
function stringValue(value, path, maxLength) {
  if (typeof value !== "string") fail(path, "expected a string");
  if (value.length > maxLength) fail(path, `must be at most ${maxLength} characters`);
  return value;
}

/** @param {unknown} value @param {string} path */
function modelId(value, path) {
  return nonEmptyString(value, path, 160);
}

/** @param {unknown} value @param {string} path */
function effortId(value, path) {
  const id = nonEmptyString(value, path, 32).toLowerCase();
  if (!EFFORT_ID.test(id)) fail(path, "invalid reasoning effort id");
  return id;
}

/** @param {unknown} value @param {string} path */
function positiveInteger(value, path) {
  const number = /** @type {number} */ (value);
  if (!Number.isSafeInteger(number) || number <= 0) fail(path, "expected a positive safe integer");
  return number;
}

/** @param {unknown} value @param {string} path */
function nonNegativeInteger(value, path) {
  const number = /** @type {number} */ (value);
  if (!Number.isSafeInteger(number) || number < 0) fail(path, "expected a non-negative safe integer");
  return number;
}

/** @param {unknown} value @param {string} path */
function booleanValue(value, path) {
  if (typeof value !== "boolean") fail(path, "expected a boolean");
  return value;
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {readonly string[] | null} allowed
 * @param {readonly string[]} [required]
 * @returns {Record<string, any>}
 */
function strictObject(value, path, allowed, required = []) {
  if (!isPlainObject(value)) fail(path, "expected an object");
  const object = /** @type {Record<string, any>} */ (value);
  for (const key of Object.keys(object)) {
    if (RESERVED_OBJECT_KEYS.has(key)) fail(`${path}.${key}`, "reserved object key");
    if (allowed !== null && !allowed.includes(key)) fail(`${path}.${key}`, "unknown field");
  }
  for (const key of required) {
    if (!hasOwn(object, key)) fail(`${path}.${key}`, "required field is missing");
  }
  return object;
}

/** @param {string} providerId @param {string} path */
function validateProviderId(providerId, path) {
  if (!PROVIDER_ID.test(providerId) || RESERVED_OBJECT_KEYS.has(providerId)) {
    fail(path, `invalid provider id "${providerId}"`);
  }
}

/** @param {string} tier @param {string} path */
function validateTierId(tier, path) {
  if (!TIER_ID.test(tier) || RESERVED_OBJECT_KEYS.has(tier)) {
    fail(path, `invalid agent tier id "${tier}"`);
  }
}

/** @param {unknown} value @returns {value is Record<string, any>} */
function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** @param {Record<string, any>} value @param {string} key */
function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/** @param {string} path @param {string} message @returns {never} */
function fail(path, message) {
  throw new ConfigV2ValidationError(path, message);
}
