import assert from "node:assert/strict";
import test from "node:test";
import {
  inferCatalogReasoning,
  isLegacyGpt56UltraPreset,
  reasoningProbeEffortIds
} from "../../src/model-gateway/reasoning-capabilities.js";

test("reads camelCase reasoning effort metadata", () => {
  const result = inferCatalogReasoning({
    id: "catalog-model",
    reasoningEfforts: ["low", { id: "HIGH", label: "High power" }],
    defaultReasoningEffort: "HIGH"
  });

  assert.deepEqual(result.reasoningEfforts, [
    { id: "low", label: "Low", description: "" },
    { id: "high", label: "High power", description: "" }
  ]);
  assert.equal(result.defaultReasoningEffort, "high");
  assert.deepEqual(result.reasoningDiscovery, {
    source: "upstream-metadata",
    confidence: "declared",
    path: "reasoningEfforts",
    presetId: null,
    supportsReasoning: true,
    probeAvailable: false,
    warnings: []
  });
});

test("reads snake_case reasoning effort metadata", () => {
  const result = inferCatalogReasoning({
    id: "catalog-model",
    supported_reasoning_efforts: ["minimal", "medium"],
    default_reasoning_effort: "medium"
  });

  assert.deepEqual(result.reasoningEfforts.map((effort) => effort.id), ["minimal", "medium"]);
  assert.equal(result.defaultReasoningEffort, "medium");
  assert.equal(result.reasoningDiscovery.path, "supported_reasoning_efforts");
  assert.equal(result.reasoningDiscovery.source, "upstream-metadata");
});

test("reads nested reasoning metadata", () => {
  const result = inferCatalogReasoning({
    id: "catalog-model",
    capabilities: {
      reasoning: {
        efforts: ["off", "high", "max"],
        default: "max"
      }
    }
  });

  assert.deepEqual(result.reasoningEfforts.map((effort) => effort.id), ["off", "high", "max"]);
  assert.equal(result.defaultReasoningEffort, "max");
  assert.equal(result.reasoningDiscovery.path, "capabilities.reasoning.efforts");
  assert.equal(result.reasoningDiscovery.supportsReasoning, true);
});

test("explicit unsupported metadata prevents a known preset", () => {
  const result = inferCatalogReasoning({
    id: "grok-4.6",
    supports_reasoning_effort: false
  }, { protocol: "openai-responses" });

  assert.deepEqual(result.reasoningEfforts, []);
  assert.equal(result.defaultReasoningEffort, null);
  assert.equal(result.reasoningDiscovery.source, "upstream-metadata");
  assert.equal(result.reasoningDiscovery.path, "supports_reasoning_effort");
  assert.equal(result.reasoningDiscovery.supportsReasoning, false);
  assert.equal(result.reasoningDiscovery.probeAvailable, false);
  assert.equal(result.reasoningDiscovery.presetId, null);
});

test("an explicitly empty effort list prevents a known preset", () => {
  const result = inferCatalogReasoning({
    id: "deepseek-v4-pro",
    reasoning_efforts: [],
    default_reasoning_effort: "high"
  }, { protocol: "openai-chat" });

  assert.deepEqual(result.reasoningEfforts, []);
  assert.equal(result.defaultReasoningEffort, null);
  assert.equal(result.reasoningDiscovery.source, "upstream-metadata");
  assert.equal(result.reasoningDiscovery.path, "reasoning_efforts");
  assert.equal(result.reasoningDiscovery.supportsReasoning, false);
  assert.equal(result.reasoningDiscovery.probeAvailable, false);
  assert.deepEqual(result.reasoningDiscovery.warnings, [
    "Upstream default reasoning effort is not present in its effort list."
  ]);
});

test("uses exact Grok presets when upstream metadata is absent", () => {
  for (const modelId of ["grok-4.5", "grok-4.6"]) {
    const result = inferCatalogReasoning({ id: modelId }, { protocol: "openai-responses" });

    assert.deepEqual(result.reasoningEfforts.map((effort) => effort.id), ["low", "medium", "high", "xhigh"]);
    assert.equal(result.defaultReasoningEffort, "high");
    assert.equal(result.reasoningDiscovery.source, "known-preset");
    assert.equal(result.reasoningDiscovery.confidence, "preset");
    assert.equal(result.reasoningDiscovery.presetId, "xai.grok-4.5-4.6");
  }
});

test("uses the exact DeepSeek preset when upstream metadata is absent", () => {
  const result = inferCatalogReasoning({ id: "deepseek-v4-pro" }, { protocol: "openai-chat" });

  assert.deepEqual(result.reasoningEfforts.map((effort) => effort.id), ["off", "high", "max"]);
  assert.equal(result.defaultReasoningEffort, "high");
  assert.equal(result.reasoningDiscovery.source, "known-preset");
  assert.equal(result.reasoningDiscovery.confidence, "preset");
  assert.equal(result.reasoningDiscovery.presetId, "deepseek.v4-pro");
});

test("uses exact GPT 5.6 presets across supported OpenAI protocols", () => {
  const expected = {
    "gpt-5.6-sol": ["none", "low", "medium", "high", "xhigh", "max"],
    "gpt-5.6-terra": ["none", "low", "medium", "high", "xhigh", "max"],
    "gpt-5.6-luna": ["none", "low", "medium", "high", "xhigh", "max"]
  };

  for (const protocol of ["openai-chat", "openai-responses"]) {
    for (const [modelId, efforts] of Object.entries(expected)) {
      const result = inferCatalogReasoning({ id: modelId }, { protocol });

      assert.deepEqual(result.reasoningEfforts.map((effort) => effort.id), efforts);
      assert.equal(result.defaultReasoningEffort, null);
      assert.equal(result.reasoningDiscovery.source, "known-preset");
      assert.equal(result.reasoningDiscovery.presetId, `gpt-5.6.${modelId.split("-").at(-1)}`);
    }
  }
});

test("active probes cover both disabled aliases and third-party ultra without adding ultra to GPT presets", () => {
  assert.deepEqual(reasoningProbeEffortIds(), ["none", "off", "low", "medium", "high", "xhigh", "max", "ultra"]);
  for (const modelId of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
    assert.deepEqual(
      inferCatalogReasoning({ id: modelId }, { protocol: "openai-responses" }).reasoningEfforts.map((effort) => effort.id),
      ["none", "low", "medium", "high", "xhigh", "max"]
    );
  }
});

test("recognizes only the exact obsolete GPT 5.6 ultra preset fingerprint", () => {
  const obsolete = ["low", "medium", "high", "xhigh", "max", "ultra"];
  for (const modelId of ["gpt-5.6-sol", "gpt-5.6-terra"]) {
    assert.equal(isLegacyGpt56UltraPreset(modelId, "openai-responses", obsolete), true);
    assert.equal(isLegacyGpt56UltraPreset(modelId, "openai-chat", [...obsolete].reverse()), true);
    assert.equal(isLegacyGpt56UltraPreset(modelId, "anthropic-messages", obsolete), false);
    assert.equal(isLegacyGpt56UltraPreset(modelId, "openai-responses", ["none", ...obsolete]), false);
    assert.equal(isLegacyGpt56UltraPreset(modelId, "openai-responses", ["low", "high", "ultra"]), false);
  }
  assert.equal(isLegacyGpt56UltraPreset("gpt-5.6-luna", "openai-responses", obsolete), false);
  assert.equal(isLegacyGpt56UltraPreset("gpt-5.6-sol-preview", "openai-responses", obsolete), false);
});

test("does not transfer a known preset across protocols", () => {
  const grokChat = inferCatalogReasoning({ id: "grok-4.6" }, { protocol: "openai-chat" });
  const deepseekResponses = inferCatalogReasoning({ id: "deepseek-v4-pro" }, { protocol: "openai-responses" });

  for (const result of [grokChat, deepseekResponses]) {
    assert.deepEqual(result.reasoningEfforts, []);
    assert.equal(result.defaultReasoningEffort, null);
    assert.equal(result.reasoningDiscovery.source, "unknown");
    assert.equal(result.reasoningDiscovery.presetId, null);
    assert.equal(result.reasoningDiscovery.warnings.length, 1);
  }
});

test("does not apply presets to similar model ids", () => {
  for (const modelId of [
    "grok-4.60",
    "grok-4.6-preview",
    "grok-4.5-mini",
    "deepseek-v4-pro-plus",
    "not-deepseek-v4-pro",
    "gpt-5.6-sol-preview",
    "not-gpt-5.6-sol"
  ]) {
    const result = inferCatalogReasoning({ id: modelId });

    assert.deepEqual(result.reasoningEfforts, [], modelId);
    assert.equal(result.defaultReasoningEffort, null, modelId);
    assert.equal(result.reasoningDiscovery.source, "unknown", modelId);
    assert.equal(result.reasoningDiscovery.presetId, null, modelId);
    assert.equal(result.reasoningDiscovery.supportsReasoning, null, modelId);
  }
});

test("accepts only a declared default that is present in the effort list", () => {
  const valid = inferCatalogReasoning({
    id: "catalog-model",
    reasoning: { efforts: ["low", "high"], default_effort: "HIGH" }
  });
  const invalid = inferCatalogReasoning({
    id: "catalog-model",
    reasoning: { efforts: ["low", "high"], default_effort: "max" }
  });

  assert.equal(valid.defaultReasoningEffort, "high");
  assert.deepEqual(valid.reasoningDiscovery.warnings, []);
  assert.equal(invalid.defaultReasoningEffort, null);
  assert.deepEqual(invalid.reasoningDiscovery.warnings, [
    "Upstream default reasoning effort is not present in its effort list."
  ]);
});

test("accepts a default marker on an effort entry when no separate default is declared", () => {
  const result = inferCatalogReasoning({
    id: "catalog-model",
    reasoningEfforts: [
      { id: "low" },
      { id: "high", default: true }
    ]
  });

  assert.equal(result.defaultReasoningEffort, "high");
});

test("does not mutate or retain mutable references to catalog metadata", () => {
  const rawModel = {
    id: "catalog-model",
    capabilities: {
      reasoning: {
        efforts: [
          { id: "low", label: "Low upstream", description: "Economical" },
          { id: "high", label: "High upstream", description: "Thorough" }
        ],
        default: "high"
      }
    }
  };
  const before = structuredClone(rawModel);

  const result = inferCatalogReasoning(rawModel, { protocol: "openai-responses" });

  assert.deepEqual(rawModel, before);
  result.reasoningEfforts[0].label = "Changed result";
  result.reasoningDiscovery.warnings.push("Changed result");
  assert.deepEqual(rawModel, before);
});
