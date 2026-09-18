const VISION_HINT = /vision|visual|image|omni|multimodal|(?:^|[^a-z0-9])vl(?:$|[^a-z0-9])|-vl|qwen-vl/i;
const TEXT_ONLY = /(?:^|[^a-z0-9])(?:luna|embed(?:ding)?|whisper|tts|asr)(?:$|[^a-z0-9])/i;
const VISION_REJECT = /does not support (?:image|vision|multimodal)|image input is not supported|vision is not supported|only text|text-only model|unknown[^\n]{0,40}image|invalid[^\n]{0,40}image|unsupported[^\n]{0,40}image|cannot accept image|not a multimodal|no vision/i;

export type ModelVisionEvidence = "catalog" | "hint" | "text-only" | "uncertain";

export function inferModelSupportsImages(modelId: unknown, catalogModalities?: unknown) {
  const evidence = classifyModelVisionEvidence(modelId, catalogModalities);
  return evidence === "catalog" || evidence === "hint";
}

export function classifyModelVisionEvidence(modelId: unknown, catalogModalities?: unknown): ModelVisionEvidence {
  if (catalogListsImageModality(catalogModalities)) {
    return "catalog";
  }
  const id = String(modelId ?? "").trim().toLowerCase();
  if (!id) {
    return "uncertain";
  }
  if (TEXT_ONLY.test(id)) {
    return "text-only";
  }
  if (VISION_HINT.test(id)) {
    return "hint";
  }
  return "uncertain";
}

export function needsVisionCapabilityProbe(modelId: unknown, catalogModalities?: unknown) {
  const evidence = classifyModelVisionEvidence(modelId, catalogModalities);
  return evidence === "uncertain" || evidence === "hint";
}

export function visionProbeErrorText(error: unknown) {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const details = record.details && typeof record.details === "object" && !Array.isArray(record.details)
    ? record.details as Record<string, unknown>
    : {};
  const body = typeof details.body === "string" ? details.body : "";
  return [record.providerMessage, record.message, record.gatewayBodyPreview, body]
    .map((entry) => String(entry ?? "").trim())
    .filter(Boolean)
    .join(" ");
}

export function publicVisionProbeError(error: unknown) {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const providerMessage = String(record.providerMessage ?? "").trim();
  if (providerMessage) {
    return providerMessage.slice(0, 180);
  }
  const status = Number(record.status);
  if (status === 400 || status === 422) {
    return `网关拒绝了读图请求（HTTP ${status}），未返回原因`;
  }
  return String(record.message ?? "").trim() || "网关未给出可判定的视觉结果";
}

export function interpretVisionProbeError(error: unknown): "unsupported" | "inconclusive" {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const status = Number(record.status);
  if (status === 401 || status === 403 || status === 429 || status >= 500) {
    return "inconclusive";
  }
  const text = visionProbeErrorText(error);
  if (VISION_REJECT.test(text)) {
    return "unsupported";
  }
  if ((status === 400 || status === 422) && /image|vision|multimodal|modalit/i.test(text)) {
    return "unsupported";
  }
  return "inconclusive";
}

export function catalogListsImageModality(modalities: unknown) {
  if (!Array.isArray(modalities)) {
    return false;
  }
  return modalities.some((entry) => {
    const text = String(entry ?? "").trim().toLowerCase();
    return ["image", "images", "vision", "visual", "multimodal", "图片", "视觉"].includes(text);
  });
}

export function resolveModelSupportsImages(input: { id?: unknown; modelId?: unknown; modalities?: unknown } = {}) {
  if (catalogListsImageModality(input.modalities)) {
    return true;
  }
  return inferModelSupportsImages(input.id ?? input.modelId);
}
