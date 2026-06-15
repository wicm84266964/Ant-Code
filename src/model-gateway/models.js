export const DEFAULT_MODEL_OPTIONS = Object.freeze([
  {
    id: "example-coding-model",
    label: "Example Coding Model",
    description: "Balanced coding model exposed by a local gateway.",
    thinking: false,
    modalities: ["text"],
    contextTokens: 200000
  },
  {
    id: "example-thinking-model",
    label: "Example Thinking Model",
    description: "Gateway model with provider-exposed reasoning deltas when available.",
    thinking: true,
    modalities: ["text"],
    contextTokens: 200000
  },
  {
    id: "example-fast-model",
    label: "Example Fast Model",
    description: "Lower-latency gateway model for lighter work.",
    thinking: false,
    modalities: ["text"],
    contextTokens: 200000
  }
]);

/**
 * @param {Record<string, any>} config
 */
export function listConfiguredModels(config) {
  const configured = Array.isArray(config.models)
    ? config.models
    : DEFAULT_MODEL_OPTIONS;
  const models = configured.map(normalizeModel).filter(Boolean);
  const current = String(config.modelAlias ?? "").trim();
  if (current && !models.some((model) => model.id === current)) {
    models.unshift({
      id: current,
      label: current,
      description: "Current model alias from environment or config.",
      thinking: /thinking|reason/i.test(current),
      modalities: inferModalities(current),
      agentModelTiers: {}
    });
  }
  return dedupeModels(models);
}

/**
 * @param {Record<string, any>} config
 * @param {string} modelId
 */
export function resolveModelSelection(config, modelId) {
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
export function formatModelOptions(config) {
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
export function parseModelList(value) {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((id) => ({
      id,
      label: id,
      description: "Model alias supplied by LAB_AGENT_MODELS.",
      thinking: /thinking|reason/i.test(id),
      modalities: inferModalities(id),
      contextTokens: null,
      reasoningContentMode: null,
      openaiExtraBody: null,
      agentModelTiers: {}
    }));
}

/**
 * @param {unknown} item
 */
function normalizeModel(item) {
  if (typeof item === "string") {
    return {
      id: item,
      label: item,
      description: "Configured model alias.",
      thinking: /thinking|reason/i.test(item),
      modalities: inferModalities(item),
      contextTokens: null,
      reasoningContentMode: null,
      openaiExtraBody: null,
      agentModelTiers: {}
    };
  }
  if (!item || typeof item !== "object" || !item.id) {
    return null;
  }
  const id = String(item.id);
  return {
    id,
    label: String(item.label ?? id),
    description: String(item.description ?? "Configured model alias."),
    thinking: Boolean(item.thinking ?? /thinking|reason/i.test(id)),
    modalities: normalizeModalities(item.modalities ?? item.capabilities ?? item.inputs, item),
    contextTokens: positiveIntegerOrNull(item.contextTokens ?? item.maxContextTokens ?? item.contextWindowTokens),
    reasoningContentMode: normalizeReasoningContentMode(item.reasoningContentMode),
    openaiExtraBody: isPlainObject(item.openaiExtraBody) ? cloneJsonObject(item.openaiExtraBody) : null,
    agentModelTiers: normalizeAgentModelTiers(item.agentModelTiers ?? item.agentDefaults?.modelTiers)
  };
}

export function normalizeAgentModelTiers(value) {
  if (!isPlainObject(value)) {
    return {};
  }
  const tiers = {};
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
export function resolveModelContextTokens(config) {
  const current = String(config?.modelAlias ?? "").trim();
  const model = listConfiguredModels(config ?? {}).find((item) => item.id === current);
  return Number.isFinite(model?.contextTokens) ? model.contextTokens : null;
}

/**
 * @param {Array<Record<string, any>>} models
 */
function dedupeModels(models) {
  const seen = new Set();
  const result = [];
  for (const model of models) {
    if (seen.has(model.id)) {
      continue;
    }
    seen.add(model.id);
    result.push(model);
  }
  return result;
}

function positiveIntegerOrNull(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function normalizeReasoningContentMode(value) {
  return value === "visible-when-no-content" || value === "hidden" ? value : null;
}

function normalizeModalities(value, item = {}) {
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

function normalizeModality(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (text === "text" || text === "文本") return "text";
  if (["image", "images", "vision", "visual", "图片", "视觉", "multimodal"].includes(text)) return "image";
  return "";
}

function inferModalities(modelId) {
  return /vision|visual|image|omni|multimodal/i.test(String(modelId ?? "")) ? ["text", "image"] : ["text"];
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function cloneJsonObject(value) {
  return JSON.parse(JSON.stringify(value));
}

function formatTokenCount(value) {
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
