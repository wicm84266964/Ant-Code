export type LabReasoningEffort = {
  id: string;
  label: string;
  description: string;
};

export type LabModel = {
  id: string;
  label: string;
  description: string;
  thinking: boolean;
  modalities: string[];
  contextTokens: number | null;
  reasoningContentMode: string | null;
  reasoningEfforts: LabReasoningEffort[];
  defaultReasoningEffort: string | null;
  openaiExtraBody: Record<string, unknown> | null;
  agentModelTiers: Record<string, string>;
};

export const DEFAULT_MODEL_OPTIONS = Object.freeze([
  {
    id: "claude-sonnet-4-5-20250929",
    label: "Sonnet 4.5",
    description: "Balanced coding model exposed by the local lab adapter.",
    thinking: false,
    modalities: ["text"],
    contextTokens: 200000
  },
  {
    id: "claude-sonnet-4-5-20250929-thinking",
    label: "Sonnet 4.5 Thinking",
    description: "Adapter model with provider-exposed reasoning deltas when available.",
    thinking: true,
    modalities: ["text"],
    contextTokens: 200000
  },
  {
    id: "claude-haiku-4-5-20251001",
    label: "Haiku 4.5",
    description: "Lower-latency local adapter model for lighter work.",
    thinking: false,
    modalities: ["text"],
    contextTokens: 200000
  }
]);

/**
 * @param {Record<string, any>} config
 */
export type LabModelConfigSlice = {
  models?: unknown;
  modelAlias?: unknown;
  routingModels?: unknown;
};

export function listConfiguredModels(config: LabModelConfigSlice = {}): LabModel[] {
  const configured = Array.isArray(config.models)
    ? config.models
    : DEFAULT_MODEL_OPTIONS;
  const models = configured.map(normalizeModel).filter((model): model is LabModel => Boolean(model));
  const current = String(config.modelAlias ?? "").trim();
  const routedCurrent = current && listRoutingModels(config).some((model) => model.id === current);
  if (current && !routedCurrent && !models.some((model) => model.id === current)) {
    models.unshift({
      id: current,
      label: current,
      description: "Current model alias from environment or config.",
      thinking: /thinking|reason/i.test(current),
      modalities: inferModalities(current),
      contextTokens: null,
      reasoningContentMode: null,
      reasoningEfforts: [],
      defaultReasoningEffort: null,
      openaiExtraBody: null,
      agentModelTiers: {}
    });
  }
  return dedupeModels(models);
}

/**
 * Models reserved for provider-local agent routing. They are deliberately
 * separate from listConfiguredModels() so they cannot become main-model UI
 * options or fallback defaults.
 *
 * @param {Record<string, any>} config
 */
export function listRoutingModels(config: LabModelConfigSlice = {}): LabModel[] {
  const configured = Array.isArray(config.routingModels) ? config.routingModels : [];
  return dedupeModels(configured.map(normalizeModel).filter((model): model is LabModel => Boolean(model)));
}

/**
 * Resolve request metadata while optionally allowing the current provider's
 * private agent-routing registry.
 *
 * @param {Record<string, any>} config
 * @param {unknown} modelId
 * @param {{ includeRouting?: boolean }} [options]
 */
export function findModelMetadata(config: LabModelConfigSlice = {}, modelId: unknown, options: { includeRouting?: boolean } = {}) {
  const requested = String(modelId ?? "").trim();
  if (!requested) return null;
  const selectable = listConfiguredModels(config);
  const routing = options.includeRouting === true ? listRoutingModels(config) : [];
  return selectable.find((model) => model.id === requested)
    ?? routing.find((model) => model.id === requested)
    ?? selectable.find((model) => model.label.toLowerCase() === requested.toLowerCase())
    ?? routing.find((model) => model.label.toLowerCase() === requested.toLowerCase())
    ?? null;
}

/**
 * @param {Record<string, any>} config
 * @param {string} modelId
 */
export function resolveModelSelection(config: LabModelConfigSlice = {}, modelId: string):
  | { ok: true; model: LabModel; models: LabModel[] }
  | { ok: false; error: { code: string; message: string }; models: LabModel[] } {
  const requested = String(modelId ?? "").trim();
  const models = listConfiguredModels(config);
  const exact = models.find((model) => model.id === requested);
  if (exact) {
    return { ok: true, model: exact, models };
  }
  const byLabel = models.find((model) => model.label.toLowerCase() === requested.toLowerCase());
  if (byLabel) {
    return { ok: true, model: byLabel, models };
  }
  return {
    ok: false,
    error: {
      code: "MODEL_NOT_CONFIGURED",
      message: requested ? `Model is not configured: ${requested}` : "No model id supplied."
    },
    models
  };
}

/**
 * @param {Record<string, any>} config
 */
export function formatModelOptions(config: LabModelConfigSlice = {}) {
  const current = config.modelAlias;
  return listConfiguredModels(config).map((model, index) => {
    const marker = model.id === current ? "*" : " ";
    const thinking = model.thinking ? " thinking" : "";
    const context = Number.isFinite(model.contextTokens) ? ` context=${formatTokenCount(model.contextTokens)}` : "";
    return `${marker} ${index + 1}. ${model.id}${thinking}${context} - ${model.description}`;
  }).join("\n");
}

/**
 * @param {string} value
 */
export function parseModelList(value: string) {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((id: string) => ({
      id,
      label: id,
      description: "Model alias supplied by LAB_AGENT_MODELS.",
      thinking: /thinking|reason/i.test(id),
      modalities: inferModalities(id),
      contextTokens: null,
      reasoningContentMode: null,
      reasoningEfforts: [],
      defaultReasoningEffort: null,
      openaiExtraBody: null,
      agentModelTiers: {}
    }));
}

/**
 * @param {unknown} item
 */
function normalizeModel(item: unknown): LabModel | null {
  if (typeof item === "string") {
    return {
      id: item,
      label: item,
      description: "Configured model alias.",
      thinking: /thinking|reason/i.test(item),
      modalities: inferModalities(item),
      contextTokens: null,
      reasoningContentMode: null,
      reasoningEfforts: [],
      defaultReasoningEffort: null,
      openaiExtraBody: null,
      agentModelTiers: {}
    };
  }
  if (!item || typeof item !== "object") {
    return null;
  }
  const value = item as Record<string, unknown>;
  if (!value.id) {
    return null;
  }
  const id = String(value.id);
  const reasoning = isPlainObject(value.reasoning) ? value.reasoning : undefined;
  const reasoningEfforts = normalizeReasoningEfforts(
    value.reasoningEfforts
      ?? value.supportedReasoningEfforts
      ?? reasoning?.efforts
      ?? (value.supportsReasoningEffort === true ? ["low", "medium", "high"] : [])
  );
  const requestedDefaultReasoningEffort = String(
    value.defaultReasoningEffort ?? reasoning?.default ?? ""
  ).trim().toLowerCase();
  return {
    id,
    label: String(value.label ?? id),
    description: String(value.description ?? "Configured model alias."),
    thinking: Boolean(value.thinking ?? /thinking|reason/i.test(id)),
    modalities: normalizeModalities(value.modalities ?? value.capabilities ?? value.inputs, value),
    contextTokens: positiveIntegerOrNull(value.contextTokens ?? value.maxContextTokens ?? value.contextWindowTokens),
    reasoningContentMode: normalizeReasoningContentMode(value.reasoningContentMode),
    reasoningEfforts,
    defaultReasoningEffort: reasoningEfforts.some((effort) => effort.id === requestedDefaultReasoningEffort)
      ? requestedDefaultReasoningEffort
      : null,
    openaiExtraBody: isPlainObject(value.openaiExtraBody) ? cloneJsonObject(value.openaiExtraBody) : null,
    agentModelTiers: normalizeAgentModelTiers(
      value.agentModelTiers ?? (isPlainObject(value.agentDefaults) ? value.agentDefaults.modelTiers : undefined)
    )
  };
}

/**
 * @param {unknown} value
 */
export function normalizeReasoningEfforts(value: unknown): LabReasoningEffort[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const efforts: LabReasoningEffort[] = [];
  for (const entry of value) {
    const raw = typeof entry === "string" ? { id: entry } : entry;
    if (!isPlainObject(raw)) {
      continue;
    }
    const id = String(raw.id ?? raw.value ?? "").trim().toLowerCase();
    if (!id || seen.has(id) || !/^[a-z0-9_-]{1,32}$/.test(id)) {
      continue;
    }
    seen.add(id);
    efforts.push({
      id,
      label: String(raw.label ?? raw.name ?? reasoningEffortLabel(id)).trim() || id,
      description: String(raw.description ?? "").trim()
    });
  }
  return efforts;
}

/** @param {string} id */
function reasoningEffortLabel(id: string) {
  const labels: Record<string, string> = {
    none: "Off",
    off: "Off",
    minimal: "Minimal",
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "Extra high",
    max: "Max",
    ultra: "Ultra"
  };
  return labels[id] ?? id;
}

export function normalizeAgentModelTiers(value: unknown): Record<string, string> {
  if (!isPlainObject(value)) {
    return {};
  }
  const tiers: Record<string, string> = {};
  for (const [tier, model] of Object.entries(value)) {
    const key = String(tier ?? "").trim();
    const id = String(model ?? "").trim();
    if (key && id) {
      tiers[key] = id;
    }
  }
  return tiers;
}

/**
 * @param {Record<string, any>} config
 */
export function resolveModelContextTokens(config: LabModelConfigSlice = {}) {
  const current = String(config?.modelAlias ?? "").trim();
  const model = listConfiguredModels(config ?? {}).find((item) => item.id === current);
  const tokens = model?.contextTokens;
  return typeof tokens === "number" && Number.isFinite(tokens) ? tokens : null;
}

/**
 * @param {Array<Record<string, any>>} models
 */
function dedupeModels(models: LabModel[]): LabModel[] {
  const seen = new Set<string>();
  const result: LabModel[] = [];
  for (const model of models) {
    if (seen.has(model.id)) {
      continue;
    }
    seen.add(model.id);
    result.push(model);
  }
  return result;
}

function positiveIntegerOrNull(value: unknown) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function normalizeReasoningContentMode(value: unknown) {
  return value === "visible-when-no-content" || value === "hidden" ? value : null;
}

function normalizeModalities(value: unknown, item: Record<string, unknown> = {}) {
  const set = new Set(["text"]);
  if (Array.isArray(value)) {
    for (const entry of value) {
      const modality = normalizeModality(entry);
      if (modality) {
        set.add(modality);
      }
    }
  } else if (typeof value === "string") {
    for (const entry of value.split(/[, ]+/)) {
      const modality = normalizeModality(entry);
      if (modality) {
        set.add(modality);
      }
    }
  }
  if (item.vision === true || item.multimodal === true || item.supportsImages === true || item.imageInput === true) {
    set.add("image");
  }
  return Array.from(set);
}

function normalizeModality(value: unknown) {
  const text = String(value ?? "").trim().toLowerCase();
  if (text === "text" || text === "文本") return "text";
  if (["image", "images", "vision", "visual", "图片", "视觉", "multimodal"].includes(text)) return "image";
  return "";
}

function inferModalities(modelId: unknown) {
  return /vision|visual|image|omni|multimodal/i.test(String(modelId ?? "")) ? ["text", "image"] : ["text"];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function cloneJsonObject(value: unknown) {
  return JSON.parse(JSON.stringify(value));
}

function formatTokenCount(value: unknown) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return "?";
  }
  if (number >= 1000000) {
    return `${Math.round(number / 100000) / 10}M`;
  }
  if (number >= 1000) {
    return `${Math.round(number / 1000)}k`;
  }
  return String(number);
}
