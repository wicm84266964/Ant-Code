import { normalizeReasoningEfforts, type LabReasoningEffort } from "./models.ts";

const PROBE_EFFORT_IDS: readonly string[] = Object.freeze(["none", "off", "low", "medium", "high", "xhigh", "max", "ultra"]);
const LEGACY_GPT56_ULTRA_PRESET_IDS: readonly string[] = Object.freeze(["low", "medium", "high", "xhigh", "max", "ultra"]);

type ReasoningPreset = {
  id: string;
  modelIds: readonly string[];
  protocols: readonly string[];
  efforts: readonly string[];
  defaultEffort: string | null;
};

const EFFORT_PATHS = Object.freeze([
  ["reasoningEfforts"],
  ["supportedReasoningEfforts"],
  ["reasoning_efforts"],
  ["supported_reasoning_efforts"],
  ["supported_reasoning_levels"],
  ["reasoning", "efforts"],
  ["reasoning", "supportedEfforts"],
  ["reasoning", "supported_efforts"],
  ["capabilities", "reasoning", "efforts"],
  ["capabilities", "reasoning", "supported_efforts"],
  ["capabilities", "reasoningEfforts"],
  ["capabilities", "reasoning_efforts"]
]);

const DEFAULT_PATHS = Object.freeze([
  ["defaultReasoningEffort"],
  ["default_reasoning_effort"],
  ["reasoningEffort"],
  ["reasoning_effort"],
  ["reasoning", "default"],
  ["reasoning", "defaultEffort"],
  ["reasoning", "default_effort"],
  ["capabilities", "reasoning", "default"],
  ["capabilities", "reasoning", "default_effort"]
]);

const SUPPORT_PATHS = Object.freeze([
  ["supportsReasoningEffort"],
  ["supports_reasoning_effort"],
  ["supportsReasoning"],
  ["supports_reasoning"],
  ["reasoning", "supported"],
  ["reasoning", "enabled"],
  ["capabilities", "reasoning", "supported"],
  ["capabilities", "reasoning", "enabled"]
]);

const KNOWN_PRESETS: readonly ReasoningPreset[] = Object.freeze([
  Object.freeze({
    id: "xai.grok-4.5-4.6",
    modelIds: Object.freeze(["grok-4.5", "grok-4.6"]),
    protocols: Object.freeze(["openai-responses"]),
    efforts: Object.freeze(["low", "medium", "high", "xhigh"]),
    defaultEffort: "high"
  }),
  Object.freeze({
    id: "deepseek.v4-pro",
    modelIds: Object.freeze(["deepseek-v4-pro"]),
    protocols: Object.freeze(["openai-chat"]),
    efforts: Object.freeze(["off", "high", "max"]),
    defaultEffort: "high"
  }),
  Object.freeze({
    id: "gpt-5.6.sol",
    modelIds: Object.freeze(["gpt-5.6-sol"]),
    protocols: Object.freeze(["openai-chat", "openai-responses"]),
    efforts: Object.freeze(["none", "low", "medium", "high", "xhigh", "max"]),
    defaultEffort: null
  }),
  Object.freeze({
    id: "gpt-5.6.terra",
    modelIds: Object.freeze(["gpt-5.6-terra"]),
    protocols: Object.freeze(["openai-chat", "openai-responses"]),
    efforts: Object.freeze(["none", "low", "medium", "high", "xhigh", "max"]),
    defaultEffort: null
  }),
  Object.freeze({
    id: "gpt-5.6.luna",
    modelIds: Object.freeze(["gpt-5.6-luna"]),
    protocols: Object.freeze(["openai-chat", "openai-responses"]),
    efforts: Object.freeze(["none", "low", "medium", "high", "xhigh", "max"]),
    defaultEffort: null
  })
]);

/**
 * Infer configurable reasoning levels without recursively trusting arbitrary
 * upstream metadata. Explicit upstream declarations win over known presets.
 *
 * @param {unknown} rawModel
 * @param {{ protocol?: unknown }} [context]
 */
export function inferCatalogReasoning(rawModel: unknown, context: { protocol?: unknown } = {}) {
  const model = isPlainObject(rawModel) ? rawModel : {};
  const modelId = String(model.id ?? "").trim().toLowerCase();
  const protocol = String(context.protocol ?? "").trim().toLowerCase();
  const warnings: string[] = [];
  const support = firstPathValue(model, SUPPORT_PATHS);
  const effortField = firstPathValue(model, EFFORT_PATHS);

  if (support.found && support.value === false) {
    if (effortField.found && normalizeEffortInput(effortField.value).length > 0) {
      warnings.push("Upstream reasoning support flag conflicts with its effort list.");
    }
    return capabilityResult({
      efforts: [],
      source: "upstream-metadata",
      confidence: "declared",
      path: support.path,
      supportsReasoning: false,
      warnings
    });
  }

  if (effortField.found) {
    const efforts = normalizeEffortInput(effortField.value);
    const defaultField = firstPathValue(model, DEFAULT_PATHS);
    const requestedDefault = String(
      defaultField.found ? defaultField.value : defaultEffortEntryId(effortField.value)
    ).trim().toLowerCase();
    if (requestedDefault && !efforts.some((effort) => effort.id === requestedDefault)) {
      warnings.push("Upstream default reasoning effort is not present in its effort list.");
    }
    return capabilityResult({
      efforts,
      defaultEffort: efforts.some((effort) => effort.id === requestedDefault) ? requestedDefault : null,
      source: "upstream-metadata",
      confidence: "declared",
      path: effortField.path,
      supportsReasoning: efforts.length > 0,
      warnings
    });
  }

  const preset = KNOWN_PRESETS.find((candidate) => candidate.modelIds.includes(modelId));
  const presetProtocols = preset?.protocols ?? [];
  const protocolMatches = preset && (!protocol || presetProtocols.includes(protocol));
  if (preset && protocolMatches) {
    return capabilityResult({
      efforts: normalizeReasoningEfforts(preset.efforts),
      defaultEffort: preset.defaultEffort,
      source: "known-preset",
      confidence: "preset",
      presetId: preset.id,
      supportsReasoning: true,
      warnings
    });
  }
  if (preset) warnings.push(`Known preset expects protocol ${presetProtocols.join(" or ")}.`);

  if (support.found && support.value === true) {
    return capabilityResult({
      efforts: [],
      source: "generic-capability",
      confidence: "unknown",
      path: support.path,
      supportsReasoning: true,
      warnings: ["Upstream reports reasoning support without enumerating accepted effort values."]
    });
  }

  return capabilityResult({
    efforts: [],
    source: "unknown",
    confidence: "unknown",
    supportsReasoning: null,
    warnings
  });
}

export function reasoningProbeEffortIds() {
  return [...PROBE_EFFORT_IDS];
}

/**
 * Identify the exact capability fingerprint emitted by the short-lived GPT
 * 5.6 preset that incorrectly included ultra. Any differing declaration is
 * treated as independent upstream/manual evidence and remains untouched.
 *
 * @param {unknown} modelId
 * @param {unknown} protocol
 * @param {unknown} efforts
 */
export function isLegacyGpt56UltraPreset(modelId: unknown, protocol: unknown, efforts: unknown) {
  const id = String(modelId ?? "").trim().toLowerCase();
  const normalizedProtocol = String(protocol ?? "").trim().toLowerCase();
  const preset = KNOWN_PRESETS.find((candidate) =>
    ["gpt-5.6.sol", "gpt-5.6.terra"].includes(candidate.id) && candidate.modelIds.includes(id)
  );
  if (!preset || !preset.protocols.includes(normalizedProtocol)) return false;
  const effortIds = normalizeEffortInput(efforts).map((effort) => effort.id);
  return effortIds.length === LEGACY_GPT56_ULTRA_PRESET_IDS.length
    && effortIds.every((effort) => LEGACY_GPT56_ULTRA_PRESET_IDS.includes(effort));
}

/** @param {unknown} value */
export function normalizeCapabilityEfforts(value: unknown) {
  return normalizeEffortInput(value);
}

/**
 * @param {{ efforts?: Array<Record<string, any>>; defaultEffort?: string | null; source: string; confidence: string; path?: string | null; presetId?: string | null; supportsReasoning?: boolean | null; warnings?: string[]; probeAvailable?: boolean }} input
 */
function capabilityResult(input: { efforts?: LabReasoningEffort[]; defaultEffort?: string | null; source: string; confidence: string; path?: string | null; presetId?: string | null; supportsReasoning?: boolean | null; warnings?: string[]; probeAvailable?: boolean }) {
  const efforts = Array.isArray(input.efforts) ? input.efforts : [];
  const requestedDefault = String(input.defaultEffort ?? "").trim().toLowerCase();
  return {
    reasoningEfforts: efforts.map((effort) => ({ id: effort.id, label: effort.label, description: effort.description })),
    defaultReasoningEffort: efforts.some((effort) => effort.id === requestedDefault) ? requestedDefault : null,
    reasoningDiscovery: {
      source: input.source,
      confidence: input.confidence,
      path: input.path ?? null,
      presetId: input.presetId ?? null,
      supportsReasoning: input.supportsReasoning ?? (efforts.length > 0 ? true : null),
      probeAvailable: input.probeAvailable ?? input.source !== "upstream-metadata",
      warnings: Array.isArray(input.warnings) ? [...input.warnings] : []
    }
  };
}

/** @param {unknown} value */
function normalizeEffortInput(value: unknown) {
  let entries = value;
  if (typeof entries === "string") {
    const text = entries.trim();
    if (!text) return [];
    try {
      entries = JSON.parse(text);
    } catch {
      entries = text.split(/[,\s]+/).filter(Boolean);
    }
  }
  if (isPlainObject(entries)) {
    entries = entries.values ?? entries.supported ?? entries.efforts ?? [];
  }
  if (!Array.isArray(entries)) return [];
  return normalizeReasoningEfforts(entries.slice(0, 16));
}

/** @param {unknown} value */
function defaultEffortEntryId(value: unknown) {
  let entries = value;
  if (typeof entries === "string") {
    try {
      entries = JSON.parse(entries);
    } catch {
      return "";
    }
  }
  if (isPlainObject(entries)) {
    entries = entries.values ?? entries.supported ?? entries.efforts ?? [];
  }
  if (!Array.isArray(entries)) return "";
  const entry = entries.find((candidate: unknown) => isPlainObject(candidate) && candidate.default === true);
  return isPlainObject(entry) ? String(entry.id ?? entry.value ?? "") : "";
}

/**
 * @param {Record<string, any>} value
 * @param {readonly (readonly string[])[]} paths
 * @returns {{ found: true; path: string; value: unknown } | { found: false; path: null; value: undefined }}
 */
function firstPathValue(value: unknown, paths: readonly (readonly string[])[]) {
  for (const path of paths) {
    let current = value;
    let found = true;
    for (const segment of path) {
      if (!isPlainObject(current) || !Object.prototype.hasOwnProperty.call(current, segment)) {
        found = false;
        break;
      }
      current = current[segment];
    }
    if (found) return { found: true, path: path.join("."), value: current };
  }
  return { found: false, path: null, value: undefined };
}

/** @param {unknown} value @returns {value is Record<string, any>} */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
