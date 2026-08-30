import assert from "node:assert/strict";
import test from "node:test";
import {
  ConfigV2ValidationError,
  deepFreeze,
  isV2SettingsDocument,
  validateSettingsDocument
} from "../../src/config-v2/schema.ts";
import { ConfigV2ResolutionError, resolveSettingsLayers } from "../../src/config-v2/resolver.ts";
import { projectLegacyRuntimeConfig } from "../../src/config-v2/legacy-projection.ts";

test("validates and detaches a strict V2 settings document", () => {
  const document = settingsDocument({
    providers: { deepseek: deepSeekProvider() },
    selection: { provider: "deepseek", model: "deepseek-v4-pro", reasoningEffort: "max" }
  });

  assert.equal(isV2SettingsDocument(document), true);
  const validated = validateSettingsDocument(document);
  document.namespaces["model-providers"].providers.deepseek.models[0].description = "changed";
  document.namespaces["model-providers"].providers.deepseek.compat.vendor = "changed";

  assert.equal(validated.namespaces["model-providers"].providers.deepseek.models[0].description, "Pro model");
  assert.equal(validated.namespaces["model-providers"].providers.deepseek.compat.vendor, "deepseek");
  assert.equal(validated.namespaces["default-model"].selection.reasoningEffort, "max");
});

test("rejects unknown fields while preserving explicit compatibility objects", () => {
  const compatible = settingsDocument({ providers: { deepseek: deepSeekProvider() } });
  compatible.namespaces["model-providers"].providers.deepseek.compat.futureOption = {
    enabled: true,
    values: [1, "two"]
  };
  assert.equal(
    validateSettingsDocument(compatible).namespaces["model-providers"].providers.deepseek.compat.futureOption.enabled,
    true
  );

  const unknown = settingsDocument({ providers: { deepseek: deepSeekProvider() } });
  unknown.namespaces["model-providers"].providers.deepseek.gatewayApiKey = "must-not-be-stored";
  assert.throws(
    () => validateSettingsDocument(unknown),
    (error) => error instanceof ConfigV2ValidationError
      && error.path.endsWith("providers.deepseek.gatewayApiKey")
      && /unknown field/.test(error.message)
  );
  assert.equal(isV2SettingsDocument(unknown), false);
});

test("rejects invalid reasoning defaults and duplicate exact-model capabilities", () => {
  const invalidDefault = settingsDocument({ providers: { deepseek: deepSeekProvider() } });
  invalidDefault.namespaces["model-providers"].providers.deepseek.models[0].reasoning.default = "xhigh";
  assert.throws(
    () => validateSettingsDocument(invalidDefault),
    /unknown reasoning effort "xhigh"/
  );

  const duplicate = settingsDocument({ providers: { deepseek: deepSeekProvider() } });
  duplicate.namespaces["model-providers"].providers.deepseek.models.push({ id: "deepseek-v4-pro" });
  assert.throws(() => validateSettingsDocument(duplicate), /duplicate model id/);
});

test("resolves project and environment selections as complete atomic values", () => {
  const globalDocument = settingsDocument({
    providers: { deepseek: deepSeekProvider() },
    selection: { provider: "deepseek", model: "deepseek-v4-pro", reasoningEffort: "max" },
    modelTiers: {
      strong: { provider: "deepseek", model: "deepseek-v4-pro", reasoningEffort: "max" }
    }
  });
  const projectDocument = settingsDocument({
    providers: { grok: grokProvider() },
    selection: { provider: "grok", model: "grok-4.6" },
    modelTiers: {
      cheap: { provider: "grok", model: "grok-4.6", reasoningEffort: "high" }
    }
  });
  const environmentDocument = settingsDocument({
    selection: { provider: "grok", model: "grok-4.6", reasoningEffort: "xhigh" }
  });

  const resolved = resolveSettingsLayers({
    global: globalDocument,
    project: projectDocument,
    environment: environmentDocument
  });

  assert.deepEqual(resolved.namespaces["default-model"].selection, {
    provider: "grok",
    model: "grok-4.6",
    reasoningEffort: "xhigh"
  });
  assert.equal(resolved.provenance.defaultModel, "environment");
  assert.equal(resolved.provenance.providers.deepseek, "global");
  assert.equal(resolved.provenance.providers.grok, "project");
  assert.equal(resolved.provenance.agentRouting.modelTiers.cheap, "project");
  assert.equal(resolved.provenance.agentRouting.modelTiers.strong, undefined);
  assert.deepEqual(resolved.namespaces["agent-routing"].modelTiers, {
    cheap: { provider: "grok", model: "grok-4.6", reasoningEffort: "high" }
  });
  assert.deepEqual(projectLegacyRuntimeConfig(resolved).agents.modelTiers, {
    cheap: "grok-4.6"
  });
});

test("rejects project provider shadowing instead of guessing an owner", () => {
  const globalDocument = settingsDocument({ providers: { shared: deepSeekProvider() } });
  const projectDocument = settingsDocument({ providers: { shared: grokProvider() } });

  assert.throws(
    () => resolveSettingsLayers({ global: globalDocument, project: projectDocument }),
    (error) => error instanceof ConfigV2ResolutionError
      && error.code === "CONFIG_V2_PROVIDER_SCOPE_CONFLICT"
      && /already owned by global/.test(error.message)
  );
});

test("rejects a global default that depends on a project-owned provider", () => {
  const globalDocument = settingsDocument({
    selection: { provider: "project-only", model: "project-model" }
  });
  const projectDocument = settingsDocument({
    providers: {
      "project-only": {
        displayName: "Project only",
        transport: { protocol: "openai-chat", baseURL: "https://project.example/v1" },
        auth: { mode: "none" },
        models: [{ id: "project-model" }]
      }
    }
  });

  assert.throws(
    () => resolveSettingsLayers({ global: globalDocument, project: projectDocument }),
    (error) => error.code === "CONFIG_V2_REFERENCE_SCOPE_ERROR"
  );
});

test("replaces a base provider atomically from global without merging model lists", () => {
  const baseProvider = deepSeekProvider();
  baseProvider.models = [{ id: "base-only" }];
  const base = settingsDocument({ providers: { deepseek: baseProvider } });
  const globalDocument = settingsDocument({
    providers: { deepseek: deepSeekProvider() },
    selection: { provider: "deepseek", model: "deepseek-v4-pro" }
  });

  const resolved = resolveSettingsLayers({ base, global: globalDocument });
  assert.deepEqual(
    resolved.namespaces["model-providers"].providers.deepseek.models.map((model) => model.id),
    ["deepseek-v4-pro"]
  );
  assert.equal(resolved.provenance.providers.deepseek, "global");
});

test("validates provider-qualified references and exact-model efforts after layering", () => {
  const unsupported = settingsDocument({
    providers: { grok: grokProvider() },
    selection: { provider: "grok", model: "grok-4.6", reasoningEffort: "max" }
  });
  assert.throws(
    () => resolveSettingsLayers({ global: unsupported }),
    (error) => error instanceof ConfigV2ResolutionError
      && error.code === "CONFIG_V2_REFERENCE_ERROR"
      && /does not support reasoning effort "max"/.test(error.message)
  );

  const missingModel = settingsDocument({
    providers: { grok: grokProvider() },
    selection: { provider: "grok", model: "grok-4.6" },
    modelTiers: { strong: { provider: "grok", model: "unknown" } }
  });
  assert.throws(() => resolveSettingsLayers({ global: missingModel }), /model "unknown" is not declared/);
});

test("deep-freezes the resolved snapshot and every nested compatibility field", () => {
  const resolved = resolveSettingsLayers({
    global: settingsDocument({
      providers: { deepseek: deepSeekProvider() },
      selection: { provider: "deepseek", model: "deepseek-v4-pro" }
    })
  });
  const provider = resolved.namespaces["model-providers"].providers.deepseek;

  assert.equal(Object.isFrozen(resolved), true);
  assert.equal(Object.isFrozen(provider.models[0].openaiExtraBody.thinking), true);
  assert.equal(Object.isFrozen(provider.compat), true);
  assert.throws(() => {
    provider.transport.baseURL = "https://changed.example/v1/responses";
  }, TypeError);

  const standalone = { nested: { value: 1 } };
  assert.equal(deepFreeze(standalone), standalone);
  assert.equal(Object.isFrozen(standalone.nested), true);
});

test("projects all legacy model runtime fields without exposing credentials or mutable aliases", () => {
  const source = settingsDocument({
    providers: { deepseek: deepSeekProvider() },
    selection: { provider: "deepseek", model: "deepseek-v4-pro", reasoningEffort: "max" },
    modelTiers: {
      strong: { provider: "deepseek", model: "deepseek-v4-pro", reasoningEffort: "max" }
    }
  });
  const resolved = resolveSettingsLayers({ global: source });
  const legacy = projectLegacyRuntimeConfig(resolved);
  const model = legacy.models[0];

  assert.equal(legacy.modelAlias, "deepseek-v4-pro");
  assert.equal(legacy.reasoningEffort, "max");
  assert.equal(legacy.lab.gatewayUrl, "https://api.deepseek.example/v1/responses?tenant=alpha");
  assert.equal(legacy.lab.gatewayCredentialRef, "DEEPSEEK_API_KEY");
  assert.equal(legacy.lab.gatewayApiKey, null);
  assert.equal(JSON.stringify(legacy).includes("secret"), false);
  assert.equal(model.description, "Pro model");
  assert.equal(model.thinking, true);
  assert.deepEqual(model.modalities, ["text", "image"]);
  assert.equal(model.contextTokens, 1_000_000);
  assert.equal(model.reasoningContentMode, "visible-when-no-content");
  assert.deepEqual(model.openaiExtraBody, { thinking: { type: "enabled" } });
  assert.deepEqual(model.agentModelTiers, {
    cheap: "deepseek-v4-pro",
    default: "deepseek-v4-pro",
    strong: "deepseek-v4-pro"
  });
  assert.deepEqual(model.reasoningEfforts.map((effort) => effort.id), ["off", "high", "max"]);
  assert.equal(model.defaultReasoningEffort, "max");
  assert.equal(legacy.agents.modelTiers.strong, "deepseek-v4-pro");
  assert.equal(Object.isFrozen(legacy.lab.gatewayProfiles[0].models[0]), true);

  assert.throws(() => {
    legacy.lab.gatewayProfiles[0].gatewayUrl = "https://mutated.invalid";
  }, TypeError);
  assert.equal(
    resolved.namespaces["model-providers"].providers.deepseek.transport.baseURL,
    "https://api.deepseek.example/v1/responses?tenant=alpha"
  );
});

test("projects routing-only models into a private provider registry", () => {
  const provider = deepSeekProvider();
  provider.models.push({
    id: "deepseek-vision-worker",
    displayName: "DeepSeek Vision Worker",
    thinking: true,
    inputModalities: ["text", "image"],
    contextWindow: 262_144,
    compat: { routingOnly: true }
  });
  provider.agents = {
    vision: {
      enabled: true,
      model: "deepseek-vision-worker",
      autoUseWhenMainModelTextOnly: true
    }
  };
  const resolved = resolveSettingsLayers({
    global: settingsDocument({
      providers: { deepseek: provider },
      selection: { provider: "deepseek", model: "deepseek-v4-pro", reasoningEffort: "max" }
    })
  });

  const legacy = projectLegacyRuntimeConfig(resolved);
  const profile = legacy.lab.gatewayProfiles.find((candidate) => candidate.id === "deepseek");
  assert.deepEqual(legacy.models.map((model) => model.id), ["deepseek-v4-pro"]);
  assert.deepEqual(profile.models.map((model) => model.id), ["deepseek-v4-pro"]);
  assert.deepEqual(profile.routingModels.map((model) => model.id), ["deepseek-vision-worker"]);
  assert.equal(profile.routingModels[0].label, "DeepSeek Vision Worker");
  assert.deepEqual(profile.routingModels[0].modalities, ["text", "image"]);
  assert.equal(profile.routingModels[0].contextTokens, 262_144);
  assert.equal(profile.modelAlias, "deepseek-v4-pro");
  assert.equal(Object.isFrozen(profile.routingModels[0]), true);
});

test("supplements incomplete historical reasoning declarations from exact protocol presets", () => {
  const provider = {
    displayName: "GPT 5.6",
    transport: {
      protocol: "openai-responses",
      baseURL: "https://gateway.example/v1/responses"
    },
    auth: { mode: "none" },
    models: [{
      id: "gpt-5.6-sol",
      reasoning: {
        efforts: [{ id: "max", label: "Historical max" }],
        default: "max"
      }
    }, {
      id: "gpt-5.6-sol-preview",
      reasoning: { efforts: [{ id: "max" }] }
    }]
  };
  const resolved = resolveSettingsLayers({
    global: settingsDocument({
      providers: { "gpt-5-6": provider },
      selection: { provider: "gpt-5-6", model: "gpt-5.6-sol", reasoningEffort: "max" }
    })
  });

  const legacy = projectLegacyRuntimeConfig(resolved);
  const sol = legacy.models.find((model) => model.id === "gpt-5.6-sol");
  const preview = legacy.models.find((model) => model.id === "gpt-5.6-sol-preview");

  assert.deepEqual(
    sol.reasoningEfforts.map((effort) => effort.id),
    ["none", "low", "medium", "high", "xhigh", "max"]
  );
  assert.equal(sol.reasoningEfforts.find((effort) => effort.id === "max").label, "Historical max");
  assert.equal(sol.defaultReasoningEffort, "max");
  assert.deepEqual(preview.reasoningEfforts.map((effort) => effort.id), ["max"]);
  assert.deepEqual(
    resolved.namespaces["model-providers"].providers["gpt-5-6"].models[0].reasoning.efforts.map((effort) => effort.id),
    ["max"]
  );
});

test("keeps confirmed reasoning declarations exact instead of supplementing a preset", () => {
  const provider = {
    displayName: "GPT 5.6",
    transport: {
      protocol: "openai-responses",
      baseURL: "https://gateway.example/v1/responses"
    },
    auth: { mode: "none" },
    models: [{
      id: "gpt-5.6-sol",
      reasoning: {
        efforts: [{ id: "high" }, { id: "max" }],
        default: "high"
      },
      compat: { reasoningDiscovery: { source: "upstream-metadata" } }
    }, {
      id: "gpt-5.6-terra",
      compat: { reasoningDiscovery: { source: "active-probe" } }
    }]
  };
  const resolved = resolveSettingsLayers({
    global: settingsDocument({
      providers: { "gpt-5-6": provider },
      selection: { provider: "gpt-5-6", model: "gpt-5.6-sol", reasoningEffort: "high" }
    })
  });

  const legacy = projectLegacyRuntimeConfig(resolved);
  const sol = legacy.models.find((model) => model.id === "gpt-5.6-sol");
  const terra = legacy.models.find((model) => model.id === "gpt-5.6-terra");

  assert.deepEqual(sol.reasoningEfforts.map((effort) => effort.id), ["high", "max"]);
  assert.equal(sol.defaultReasoningEffort, "high");
  assert.equal(terra.reasoningEfforts, undefined);
});

test("removes only the exact obsolete GPT ultra preset and clears its runtime override", () => {
  const obsoleteEfforts = ["low", "medium", "high", "xhigh", "max", "ultra"].map((id) => ({ id }));
  const provider = {
    displayName: "GPT 5.6",
    transport: {
      protocol: "openai-responses",
      baseURL: "https://gateway.example/v1/responses"
    },
    auth: { mode: "none" },
    models: [{
      id: "gpt-5.6-terra",
      reasoning: { efforts: obsoleteEfforts, default: "ultra" }
    }, {
      id: "gpt-5.6-luna",
      reasoning: { efforts: obsoleteEfforts, default: "ultra" }
    }, {
      id: "gpt-5.6-sol",
      reasoning: { efforts: obsoleteEfforts, default: "ultra" },
      compat: { reasoningDiscovery: { source: "active-probe" } }
    }]
  };
  const resolved = resolveSettingsLayers({
    global: settingsDocument({
      providers: { "gpt-5-6": provider },
      selection: { provider: "gpt-5-6", model: "gpt-5.6-terra", reasoningEffort: "ultra" }
    })
  });

  const legacy = projectLegacyRuntimeConfig(resolved);
  const terra = legacy.models.find((model) => model.id === "gpt-5.6-terra");
  const luna = legacy.lab.gatewayProfiles[0].models.find((model) => model.id === "gpt-5.6-luna");
  const probed = legacy.lab.gatewayProfiles[0].models.find((model) => model.id === "gpt-5.6-sol");

  assert.deepEqual(terra.reasoningEfforts.map((effort) => effort.id), ["none", "low", "medium", "high", "xhigh", "max"]);
  assert.equal(terra.defaultReasoningEffort, null);
  assert.equal(legacy.reasoningEffort, null);
  assert.deepEqual(luna.reasoningEfforts.map((effort) => effort.id), ["none", "low", "medium", "high", "xhigh", "max", "ultra"]);
  assert.equal(luna.defaultReasoningEffort, "ultra");
  assert.deepEqual(probed.reasoningEfforts.map((effort) => effort.id), ["low", "medium", "high", "xhigh", "max", "ultra"]);
  assert.equal(probed.defaultReasoningEffort, "ultra");
  assert.equal(
    resolved.namespaces["model-providers"].providers["gpt-5-6"].models[0].reasoning.efforts.at(-1).id,
    "ultra"
  );
});

test("filters a stale agent route that targets a provider other than the active provider", () => {
  const resolved = resolveSettingsLayers({
    global: settingsDocument({
      providers: { deepseek: deepSeekProvider(), grok: grokProvider() },
      selection: { provider: "deepseek", model: "deepseek-v4-pro" },
      modelTiers: { cheap: { provider: "grok", model: "grok-4.6" } }
    })
  });

  assert.equal(resolved.namespaces["agent-routing"], undefined);
  assert.equal(resolved.provenance.agentRouting.modelTiers.cheap, undefined);
});

test("a higher-scope stale route does not hide a lower-scope active-provider route", () => {
  const globalDocument = settingsDocument({
    providers: { deepseek: deepSeekProvider(), grok: grokProvider() },
    selection: { provider: "deepseek", model: "deepseek-v4-pro" },
    modelTiers: { cheap: { provider: "deepseek", model: "deepseek-v4-pro" } }
  });
  globalDocument.namespaces["agent-routing"].vision = {
    enabled: true,
    model: { provider: "deepseek", model: "deepseek-v4-pro" },
    autoUseWhenMainModelTextOnly: true
  };
  const projectDocument = settingsDocument({
    modelTiers: { cheap: { provider: "grok", model: "grok-4.6" } }
  });
  projectDocument.namespaces["agent-routing"].vision = {
    enabled: true,
    model: { provider: "grok", model: "grok-4.5" },
    autoUseWhenMainModelTextOnly: true
  };

  const resolved = resolveSettingsLayers({ global: globalDocument, project: projectDocument });

  assert.deepEqual(resolved.namespaces["agent-routing"].modelTiers.cheap, {
    provider: "deepseek",
    model: "deepseek-v4-pro"
  });
  assert.deepEqual(resolved.namespaces["agent-routing"].vision.model, {
    provider: "deepseek",
    model: "deepseek-v4-pro"
  });
  assert.equal(resolved.provenance.agentRouting.modelTiers.cheap, "global");
  assert.equal(resolved.provenance.agentRouting.vision, "global");
});

/**
 * @param {{ providers?: Record<string, any>; selection?: Record<string, any>; modelTiers?: Record<string, any> }} input
 */
function settingsDocument(input: { providers?: Record<string, unknown>; selection?: Record<string, unknown>; modelTiers?: Record<string, unknown> } = {}) {
  const namespaces = {};
  if (input.providers) namespaces["model-providers"] = { providers: input.providers };
  if (input.selection) namespaces["default-model"] = { selection: input.selection };
  if (input.modelTiers) namespaces["agent-routing"] = { modelTiers: input.modelTiers };
  return { settingsVersion: 2, namespaces };
}

function deepSeekProvider() {
  return {
    displayName: "DeepSeek",
    transport: {
      protocol: "openai-responses",
      baseURL: "https://api.deepseek.example/v1/responses?tenant=alpha",
      healthURL: "https://api.deepseek.example/v1/models",
      compat: { preserveQuery: true }
    },
    auth: { mode: "credential", ref: "DEEPSEEK_API_KEY" },
    models: [{
      id: "deepseek-v4-pro",
      displayName: "DeepSeek V4 Pro",
      description: "Pro model",
      thinking: true,
      inputModalities: ["text", "image"],
      contextWindow: 1_000_000,
      maxOutputTokens: 256_000,
      reasoningContentMode: "visible-when-no-content",
      reasoning: {
        efforts: [
          { id: "off", label: "Off", description: "Disable reasoning" },
          { id: "high", label: "High", description: "Extended reasoning" },
          { id: "max", label: "Max", description: "Maximum reasoning" }
        ],
        default: "max"
      },
      openaiExtraBody: { thinking: { type: "enabled" } },
      agentModelTiers: {
        cheap: "deepseek-v4-pro",
        default: "deepseek-v4-pro",
        strong: "deepseek-v4-pro"
      },
      compat: { replay: true }
    }],
    reliability: {
      maxRetries: 6,
      timeoutMs: 800_000,
      idleTimeoutMs: 240_000,
      maxResponseBytes: 64 * 1024 * 1024
    },
    agents: {
      modelTiers: {
        cheap: "deepseek-v4-pro",
        default: "deepseek-v4-pro",
        strong: "deepseek-v4-pro"
      },
      vision: {
        enabled: true,
        model: "deepseek-v4-pro",
        autoUseWhenMainModelTextOnly: true
      },
      compat: { migratedSnapshot: true }
    },
    compat: { vendor: "deepseek" }
  };
}

function grokProvider() {
  return {
    displayName: "Grok",
    transport: {
      protocol: "openai-responses",
      baseURL: "https://grok.example/v1/responses"
    },
    auth: { mode: "credential", ref: "GROK_API_KEY" },
    models: [{
      id: "grok-4.6",
      displayName: "Grok 4.6",
      thinking: true,
      inputModalities: ["text"],
      reasoning: {
        efforts: [
          { id: "low", label: "Low" },
          { id: "medium", label: "Medium" },
          { id: "high", label: "High" },
          { id: "xhigh", label: "Extra high" }
        ],
        default: "high"
      }
    }]
  };
}
