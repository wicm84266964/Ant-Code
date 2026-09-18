import { createLabModelGateway } from "./client.ts";
import type { LabAgentConfig } from "../config/load-config.ts";
import {
  interpretVisionProbeError,
  needsVisionCapabilityProbe,
  publicVisionProbeError
} from "./vision-capabilities.ts";

const VISION_PROBE_TIMEOUT_MS = 8_000;
// 64x64 gray PNG. 1x1 probes are rejected as invalid by many aggregators that still accept real photos.
const VISION_PROBE_PNG = "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAX0lEQVR4nO3PMQ0AMAzAsPJHNlgFscOqFCNI5h03OuBXA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA9oCNauCLP9TnuYAAAAASUVORK5CYII=";
const VISION_PROBE_PNG_BYTES = 152;
const visionProbeCache = new Map<string, { supported: boolean; at: number }>();

export type VisionProbeResult = {
  supported: boolean | null;
  reason: "accepted" | "rejected" | "inconclusive" | "skipped";
  error?: string;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function probeCacheKey(config: LabAgentConfig | Record<string, unknown>, modelId: string) {
  const lab = isPlainObject(config.lab) ? config.lab : {};
  return `${String(lab.gatewayProtocol ?? "")}|${String(lab.gatewayUrl ?? "")}|${modelId}`;
}

export function rememberVisionProbeResult(config: LabAgentConfig | Record<string, unknown>, modelId: string, supported: boolean) {
  visionProbeCache.set(probeCacheKey(config, modelId), { supported, at: Date.now() });
}

export function cachedVisionProbeResult(config: LabAgentConfig | Record<string, unknown>, modelId: string) {
  return visionProbeCache.get(probeCacheKey(config, modelId)) ?? null;
}

export async function probeVisionCapability(options: {
  config: LabAgentConfig;
  modelId: string;
  catalogModalities?: unknown;
  signal?: AbortSignal;
}): Promise<VisionProbeResult> {
  const modelId = String(options.modelId ?? "").trim();
  if (!modelId || !needsVisionCapabilityProbe(modelId, options.catalogModalities)) {
    return { supported: null, reason: "skipped" };
  }
  const cached = cachedVisionProbeResult(options.config, modelId);
  if (cached) {
    return { supported: cached.supported, reason: cached.supported ? "accepted" : "rejected" };
  }
  const lab = isPlainObject(options.config.lab) ? options.config.lab : {};
  const probeConfig = {
    ...options.config,
    modelAlias: modelId,
    lab: {
      ...lab,
      gatewayMaxRetries: 0
    }
  };
  const gateway = createLabModelGateway(probeConfig as LabAgentConfig);
  if (!gateway.configured) {
    return { supported: null, reason: "inconclusive", error: "网关未配置或缺少 API Key" };
  }
  const timeout = AbortSignal.timeout(VISION_PROBE_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const result = await gateway.sendChat({
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "这张图主要是什么颜色？" },
        {
          type: "image",
          data: VISION_PROBE_PNG,
          mimeType: "image/png",
          name: "vision-probe.png",
          size: VISION_PROBE_PNG_BYTES
        }
      ]
    }],
    tools: [],
    stream: false,
    signal
  });
  if (result.ok) {
    rememberVisionProbeResult(options.config, modelId, true);
    return { supported: true, reason: "accepted" };
  }
  if (interpretVisionProbeError(result.error) === "unsupported") {
    rememberVisionProbeResult(options.config, modelId, false);
    return { supported: false, reason: "rejected" };
  }
  return {
    supported: null,
    reason: "inconclusive",
    error: publicVisionProbeError(result.error)
  };
}

export function markConfiguredModelAsVision(config: { models?: unknown }, modelId: string) {
  const models = Array.isArray(config.models) ? config.models : [];
  const model = models.find((entry) => isPlainObject(entry) && entry.id === modelId);
  if (!isPlainObject(model)) {
    return;
  }
  const modalities = Array.isArray(model.modalities) ? model.modalities.map(String) : ["text"];
  if (!modalities.includes("image")) {
    model.modalities = [...modalities, "image"];
  }
}
