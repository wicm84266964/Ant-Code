import assert from "node:assert/strict";
import test from "node:test";
import {
  deleteProvider,
  deleteProviderModel,
  updateDefaultModelSelection,
  upsertProviderModel
} from "../../src/config-v2/model-mutations.ts";
import { resolveSettingsLayers } from "../../src/config-v2/resolver.ts";

test("Config V2 model upsert preserves provider model tiers when the field is omitted", () => {
  const document = settingsDocument();
  const result = upsertProviderModel(document, providerModelInput());

  assert.equal(result.ok, true);
  const provider = result.document.namespaces["model-providers"].providers.deepseek;
  assert.deepEqual(provider.agents.modelTiers, {
    cheap: "deepseek-v4-flash",
    default: "deepseek-v4-pro",
    strong: "deepseek-v4-pro"
  });
  assert.deepEqual(provider.agents.vision, {
    enabled: true,
    model: "deepseek-v4-pro",
    autoUseWhenMainModelTextOnly: true
  });
});

test("Config V2 model upsert clears provider model tiers when given an explicit empty object", () => {
  const document = settingsDocument();
  const result = upsertProviderModel(document, providerModelInput({ agentModelTiers: {} }));

  assert.equal(result.ok, true);
  const provider = result.document.namespaces["model-providers"].providers.deepseek;
  assert.equal(Object.prototype.hasOwnProperty.call(provider.agents, "modelTiers"), false);
  assert.deepEqual(provider.agents.vision, {
    enabled: true,
    model: "deepseek-v4-pro",
    autoUseWhenMainModelTextOnly: true
  });
});

test("Config V2 default provider switch removes qualified routes owned by another provider", () => {
  const document = settingsDocument();
  document.namespaces["model-providers"].providers.grok = {
    displayName: "Grok",
    transport: { protocol: "openai-responses", baseURL: "https://grok.example/v1/responses" },
    auth: { mode: "none" },
    models: [{ id: "grok-4.6" }]
  };
  document.namespaces["agent-routing"] = {
    modelTiers: {
      cheap: { provider: "deepseek", model: "deepseek-v4-pro" },
      strong: { provider: "grok", model: "grok-4.6" }
    },
    vision: {
      enabled: true,
      model: { provider: "deepseek", model: "deepseek-v4-pro" }
    },
    compat: { source: "legacy" }
  };

  const result = updateDefaultModelSelection(document, { provider: "grok", model: "grok-4.6" });

  assert.equal(result.ok, true);
  assert.deepEqual(result.document.namespaces["agent-routing"], {
    modelTiers: { strong: { provider: "grok", model: "grok-4.6" } },
    compat: { source: "legacy" }
  });
});

test("Config V2 model upsert preserves fields that the Dashboard does not manage", () => {
  const document = settingsDocument();
  const provider = document.namespaces["model-providers"].providers.deepseek;
  provider.compat = { vendor: "deepseek" };
  provider.transport.compat = { preserveQuery: true };
  provider.agents.compat = { routingPolicy: "custom" };
  provider.models[0] = {
    ...provider.models[0],
    description: "Keep this operator-authored description.",
    maxOutputTokens: 131_072,
    reasoningContentMode: "hidden",
    openaiExtraBody: { response_format: { type: "json_object" } },
    compat: { vendorFlag: true }
  };

  const result = upsertProviderModel(document, providerModelInput());

  assert.equal(result.ok, true);
  const updated = result.document.namespaces["model-providers"].providers.deepseek;
  assert.deepEqual(updated.compat, { vendor: "deepseek" });
  assert.deepEqual(updated.transport.compat, { preserveQuery: true });
  assert.deepEqual(updated.agents.compat, { routingPolicy: "custom" });
  assert.equal(updated.models[0].description, "Keep this operator-authored description.");
  assert.equal(updated.models[0].maxOutputTokens, 131_072);
  assert.equal(updated.models[0].reasoningContentMode, "hidden");
  assert.deepEqual(updated.models[0].openaiExtraBody, { response_format: { type: "json_object" } });
  assert.deepEqual(updated.models[0].compat, { vendorFlag: true });
  assert.deepEqual(updated.models[0].reasoning.efforts.map((effort) => effort.id), ["off", "high", "max"]);
});

test("Config V2 persists only trusted catalog reasoning provenance when declarations match", () => {
  const document = settingsDocument();
  document.namespaces["model-providers"].providers.deepseek.models[0] = {
    id: "deepseek-v4-pro",
    reasoning: { efforts: [{ id: "off" }, { id: "high" }, { id: "max" }], default: "max" },
    compat: {
      vendorFlag: true,
      reasoningDiscovery: { source: "stale-browser-value" }
    }
  };
  const input = providerModelInput({
    compat: {
      submittedFlag: true,
      reasoningDiscovery: { source: "active-probe", confidence: "forged" }
    }
  });
  input.catalogModelIds = ["deepseek-v4-pro"];
  input.catalogModels = [{
    id: "deepseek-v4-pro",
    reasoningEfforts: ["off", "high", "max"],
    defaultReasoningEffort: "max",
    reasoningDiscovery: {
      source: "upstream-metadata",
      confidence: "declared",
      path: "capabilities.reasoning.efforts",
      presetId: null,
      warnings: ["not persisted"]
    }
  }];

  const result = upsertProviderModel(document, input);

  assert.equal(result.ok, true);
  const compat = result.document.namespaces["model-providers"].providers.deepseek.models[0].compat;
  assert.deepEqual(compat, {
    vendorFlag: true,
    submittedFlag: true,
    reasoningDiscovery: {
      source: "upstream-metadata",
      confidence: "declared",
      path: "capabilities.reasoning.efforts",
      presetId: null
    }
  });
});

test("Config V2 clears stale reasoning provenance when trusted catalog capabilities differ", () => {
  const document = settingsDocumentWithReasoningDiscovery();
  const input = providerModelInput();
  input.catalogModelIds = ["deepseek-v4-pro"];
  input.catalogModels = [{
    id: "deepseek-v4-pro",
    reasoningEfforts: ["off", "high"],
    defaultReasoningEffort: "high",
    reasoningDiscovery: {
      source: "upstream-metadata",
      confidence: "declared",
      path: "reasoningEfforts",
      presetId: null
    }
  }];

  const result = upsertProviderModel(document, input);
  const compat = result.document.namespaces["model-providers"].providers.deepseek.models[0].compat;

  assert.deepEqual(compat, { vendorFlag: true });
});

test("Config V2 preserves reasoning provenance for credential-only saves with unchanged capabilities", () => {
  const document = settingsDocumentWithReasoningDiscovery();
  const input = providerModelInput();
  input.credentialAction = "replace";
  input.gatewayApiKey = "replacement-secret";

  const result = upsertProviderModel(document, input);
  const compat = result.document.namespaces["model-providers"].providers.deepseek.models[0].compat;

  assert.deepEqual(compat, {
    vendorFlag: true,
    reasoningDiscovery: trustedReasoningDiscovery()
  });
});

test("Config V2 clears reasoning provenance after manual capability or endpoint changes", () => {
  const manualInput = providerModelInput({
    reasoningEfforts: ["off", "high"],
    defaultReasoningEffort: "high"
  });
  const manual = upsertProviderModel(settingsDocumentWithReasoningDiscovery(), manualInput);
  assert.deepEqual(
    manual.document.namespaces["model-providers"].providers.deepseek.models[0].compat,
    { vendorFlag: true }
  );

  const endpointInput = providerModelInput();
  endpointInput.gatewayUrl = "https://replacement.example/v1/chat/completions";
  const endpoint = upsertProviderModel(settingsDocumentWithReasoningDiscovery(), endpointInput);
  assert.deepEqual(
    endpoint.document.namespaces["model-providers"].providers.deepseek.models[0].compat,
    { vendorFlag: true }
  );
});

test("Config V2 ignores browser reasoning provenance without trusted catalog evidence", () => {
  const input = providerModelInput({
    compat: {
      vendorFlag: true,
      reasoningDiscovery: { source: "active-probe", confidence: "forged" }
    }
  });

  const result = upsertProviderModel(settingsDocument(), input);
  const compat = result.document.namespaces["model-providers"].providers.deepseek.models[0].compat;

  assert.deepEqual(compat, { vendorFlag: true });
});

test("Config V2 model upsert can still clear Dashboard-managed optional fields", () => {
  const document = settingsDocument();
  document.namespaces["model-providers"].providers.deepseek.models[0] = {
    id: "deepseek-v4-pro",
    contextWindow: 128_000,
    reasoning: { efforts: [{ id: "high" }], default: "high" }
  };

  const result = upsertProviderModel(document, providerModelInput({
    contextTokens: null,
    reasoningEfforts: [],
    defaultReasoningEffort: null
  }));

  const updated = result.document.namespaces["model-providers"].providers.deepseek.models[0];
  assert.equal(Object.prototype.hasOwnProperty.call(updated, "contextWindow"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(updated, "reasoning"), false);
});

test("Config V2 model upsert declares unresolved agent routes as hidden provider models", () => {
  const document = settingsDocument();
  const result = upsertProviderModel(document, providerModelInput({
    agentModelTiers: {
      cheap: "gpt-5.6-luna",
      default: "deepseek-v4-pro",
      strong: "gpt-5.6-sol"
    }
  }));

  assert.equal(result.ok, true);
  const provider = result.document.namespaces["model-providers"].providers.deepseek;
  assert.deepEqual(provider.agents.modelTiers, {
    cheap: "gpt-5.6-luna",
    default: "deepseek-v4-pro",
    strong: "gpt-5.6-sol"
  });
  assert.deepEqual(provider.models.find((model) => model.id === "gpt-5.6-luna"), {
    id: "gpt-5.6-luna",
    displayName: "gpt-5.6-luna",
    compat: { routingOnly: true }
  });
  assert.deepEqual(provider.models.find((model) => model.id === "gpt-5.6-sol"), {
    id: "gpt-5.6-sol",
    displayName: "gpt-5.6-sol",
    compat: { routingOnly: true }
  });
});

test("Config V2 model upsert canonicalizes route casing and promotes routing-only models", () => {
  const document = settingsDocument();
  const provider = document.namespaces["model-providers"].providers.deepseek;
  provider.models.push({
    id: "gpt-5.6-luna",
    displayName: "Luna route",
    compat: { routingOnly: true, vendorFlag: true }
  });

  const routed = upsertProviderModel(document, providerModelInput({
    agentModelTiers: { cheap: "gpt-5.6-Luna", default: "deepseek-v4-pro", strong: "deepseek-v4-pro" }
  }));
  assert.equal(routed.document.namespaces["model-providers"].providers.deepseek.agents.modelTiers.cheap, "gpt-5.6-luna");

  const promoted = upsertProviderModel(routed.document, providerModelInput({
    id: "gpt-5.6-luna",
    label: "GPT 5.6 Luna",
    agentModelTiers: {}
  }));
  const luna = promoted.document.namespaces["model-providers"].providers.deepseek.models.find((model) => model.id === "gpt-5.6-luna");
  assert.equal(luna.compat.routingOnly, undefined);
  assert.equal(luna.compat.vendorFlag, true);
  assert.equal(luna.displayName, "GPT 5.6 Luna");
});

test("Config V2 uses exact catalog IDs for agent routes without registering them as main models", () => {
  const input = providerModelInput({
    agentModelTiers: {
      cheap: "gpt-5.6-Luna",
      default: "deepseek-v4-pro",
      strong: "gpt-5.6-SOL"
    }
  });
  input.catalogModelIds = ["deepseek-v4-pro", "gpt-5.6-luna", "gpt-5.6-sol"];

  const result = upsertProviderModel(settingsDocument(), input);

  assert.equal(result.ok, true);
  const provider = result.document.namespaces["model-providers"].providers.deepseek;
  assert.deepEqual(provider.agents.modelTiers, {
    cheap: "gpt-5.6-luna",
    default: "deepseek-v4-pro",
    strong: "gpt-5.6-sol"
  });
  assert.deepEqual(
    provider.models.filter((model) => model.compat?.routingOnly === true).map((model) => model.id).sort(),
    ["gpt-5.6-luna", "gpt-5.6-sol"]
  );
});

test("Config V2 persists discovered metadata on hidden routing models", () => {
  const input = providerModelInput({
    agentModelTiers: {
      cheap: "vision-worker",
      default: "deepseek-v4-pro",
      strong: "deepseek-v4-pro"
    }
  });
  input.catalogModelIds = ["deepseek-v4-pro", "vision-worker"];
  input.catalogModels = [{
    id: "vision-worker",
    label: "Vision Worker",
    modalities: ["text", "image"],
    contextTokens: 131_072,
    thinking: true,
    compat: { routingOnly: false, vendorFlag: true },
    agentModelTiers: { strong: "untrusted-route" }
  }];
  input.visionAgentModelProvided = true;
  input.visionAgentModel = "vision-worker";

  const result = upsertProviderModel(settingsDocument(), input);

  assert.equal(result.ok, true);
  const provider = result.document.namespaces["model-providers"].providers.deepseek;
  const routingModel = provider.models.find((model) => model.id === "vision-worker");
  assert.equal(routingModel.displayName, "Vision Worker");
  assert.deepEqual(routingModel.inputModalities, ["text", "image"]);
  assert.equal(routingModel.contextWindow, 131_072);
  assert.equal(routingModel.thinking, true);
  assert.deepEqual(routingModel.compat, { routingOnly: true });
  assert.equal(Object.prototype.hasOwnProperty.call(routingModel, "agentModelTiers"), false);
  assert.equal(provider.agents.vision.model, "vision-worker");
  assert.equal(provider.models.filter((model) => model.compat?.routingOnly !== true).some((model) => model.id === "vision-worker"), false);
});

test("Config V2 rejects ambiguous case-folded catalog IDs", () => {
  const input = providerModelInput({
    agentModelTiers: { cheap: "WORKER", default: "deepseek-v4-pro", strong: "deepseek-v4-pro" }
  });
  input.catalogModelIds = ["worker", "Worker"];

  const result = upsertProviderModel(settingsDocument(), input);

  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(result.code, "CONFIG_V2_MODEL_ID_CASE_COLLISION");
});

test("Config V2 rename migrates provider-local, qualified and default references atomically", () => {
  const document = settingsDocument();
  const provider = document.namespaces["model-providers"].providers.deepseek;
  provider.models.push({
    id: "reviewer",
    agentModelTiers: { cheap: "deepseek-v4-pro", strong: "reviewer" }
  });
  provider.agents = {
    modelTiers: {
      cheap: "deepseek-v4-pro",
      default: "deepseek-v4-pro",
      strong: "reviewer"
    },
    vision: { enabled: true, model: "deepseek-v4-pro", autoUseWhenMainModelTextOnly: true }
  };
  document.namespaces["agent-routing"] = {
    modelTiers: {
      cheap: { provider: "deepseek", model: "deepseek-v4-pro", reasoningEffort: "high" }
    },
    vision: {
      enabled: true,
      model: { provider: "deepseek", model: "deepseek-v4-pro", reasoningEffort: "max" },
      autoUseWhenMainModelTextOnly: true
    }
  };
  const input = providerModelInput({ id: "deepseek-v5-pro", label: "DeepSeek V5 Pro", modalities: ["text", "image"] });
  input.previousModelId = "deepseek-v4-pro";

  const result = upsertProviderModel(document, input);

  assert.equal(result.ok, true);
  const updated = result.document.namespaces["model-providers"].providers.deepseek;
  assert.equal(updated.models.some((model) => model.id === "deepseek-v4-pro"), false);
  assert.deepEqual(updated.models.find((model) => model.id === "reviewer").agentModelTiers, {
    cheap: "deepseek-v5-pro",
    strong: "reviewer"
  });
  assert.deepEqual(updated.agents.modelTiers, {
    cheap: "deepseek-v5-pro",
    default: "deepseek-v5-pro",
    strong: "reviewer"
  });
  assert.equal(updated.agents.vision.model, "deepseek-v5-pro");
  assert.equal(result.document.namespaces["default-model"].selection.model, "deepseek-v5-pro");
  assert.equal(result.document.namespaces["agent-routing"].modelTiers.cheap.model, "deepseek-v5-pro");
  assert.equal(result.document.namespaces["agent-routing"].vision.model.model, "deepseek-v5-pro");
  assert.doesNotThrow(() => resolveSettingsLayers({ global: result.document }));
});

test("Config V2 endpoint replacement keeps catalog-confirmed main models and never revives stale routes", () => {
  const document = settingsDocument();
  const provider = document.namespaces["model-providers"].providers.deepseek;
  provider.models.push(
    {
      id: "deepseek-reviewer",
      displayName: "Reviewer",
      inputModalities: ["text"],
      agentModelTiers: { cheap: "stale-worker", default: "GPT-5.6-LUNA" }
    },
    {
      id: "deepseek-coder",
      displayName: "Coder",
      inputModalities: ["text"],
      agentModelTiers: { cheap: "stale-worker" }
    },
    { id: "stale-worker", displayName: "Stale", compat: { routingOnly: true } }
  );
  provider.agents = {
    modelTiers: { cheap: "stale-worker", default: "deepseek-reviewer", strong: "deepseek-v4-pro" },
    vision: { enabled: true, model: "stale-worker", autoUseWhenMainModelTextOnly: true }
  };
  document.namespaces["default-model"].selection = { provider: "deepseek", model: "deepseek-reviewer" };
  document.namespaces["agent-routing"] = {
    modelTiers: {
      cheap: { provider: "deepseek", model: "stale-worker" },
      default: { provider: "deepseek", model: "deepseek-reviewer" }
    }
  };
  const input = providerModelInput({
    agentModelTiers: {
      cheap: "new-worker",
      default: "deepseek-reviewer",
      strong: "deepseek-v4-pro"
    }
  });
  input.previousModelId = "deepseek-v4-pro";
  input.gatewayUrl = "https://deepseek.example/v2/chat/completions";
  input.catalogModelIds = [
    "deepseek-v4-pro",
    "deepseek-reviewer",
    "deepseek-coder",
    "new-worker",
    "gpt-5.6-luna"
  ];
  input.visionAgentModelProvided = true;
  input.visionAgentModel = "";

  const result = upsertProviderModel(document, input);

  assert.equal(result.ok, true);
  const updated = result.document.namespaces["model-providers"].providers.deepseek;
  assert.deepEqual(updated.models.filter((model) => model.compat?.routingOnly !== true).map((model) => model.id).sort(), [
    "deepseek-coder",
    "deepseek-reviewer",
    "deepseek-v4-pro"
  ]);
  assert.equal(updated.models.some((model) => model.id === "stale-worker"), false);
  assert.equal(updated.models.find((model) => model.id === "new-worker")?.compat?.routingOnly, true);
  assert.deepEqual(updated.models.find((model) => model.id === "deepseek-reviewer")?.agentModelTiers, {
    default: "gpt-5.6-luna"
  });
  assert.equal(
    Object.prototype.hasOwnProperty.call(updated.models.find((model) => model.id === "deepseek-coder"), "agentModelTiers"),
    false
  );
  assert.equal(result.document.namespaces["agent-routing"].modelTiers.cheap.model, "deepseek-v4-pro");
  assert.equal(result.document.namespaces["agent-routing"].modelTiers.default.model, "deepseek-reviewer");
  assert.equal(result.document.namespaces["default-model"].selection.model, "deepseek-reviewer");
  assert.doesNotThrow(() => resolveSettingsLayers({ global: result.document }));
});

test("Config V2 endpoint replacement drops stale agent selections resubmitted by an old form", () => {
  const document = settingsDocument();
  const provider = document.namespaces["model-providers"].providers.deepseek;
  provider.models.push({ id: "old-worker", compat: { routingOnly: true } });
  provider.agents = {
    modelTiers: { cheap: "old-worker", default: "old-worker", strong: "old-worker" },
    vision: { enabled: true, model: "old-worker", autoUseWhenMainModelTextOnly: true }
  };
  const input = providerModelInput({
    agentModelTiers: { cheap: "old-worker", default: "old-worker", strong: "old-worker" }
  });
  input.gatewayUrl = "https://replacement.example/v1/chat/completions";
  input.catalogModelIds = ["deepseek-v4-pro"];
  input.visionAgentModelProvided = true;
  input.visionAgentModel = "old-worker";

  const result = upsertProviderModel(document, input);

  assert.equal(result.ok, true);
  const updated = result.document.namespaces["model-providers"].providers.deepseek;
  assert.equal(updated.models.some((model) => model.id === "old-worker"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(updated.models[0], "agentModelTiers"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(updated.agents, "modelTiers"), false);
  assert.deepEqual(updated.agents.vision, {
    enabled: false,
    model: null,
    autoUseWhenMainModelTextOnly: true
  });
  assert.doesNotThrow(() => resolveSettingsLayers({ global: result.document }));
});

test("Config V2 endpoint replacement retains explicitly submitted manual agent model ids without catalog metadata", () => {
  const document = settingsDocument();
  const input = providerModelInput({
    agentModelTiers: {
      cheap: "Manual-New-Worker",
      default: "deepseek-v4-pro",
      strong: "Manual-New-Worker"
    }
  });
  input.gatewayUrl = "https://manual-replacement.example/v1/chat/completions";
  input.catalogModelIds = [];
  input.catalogModels = [];
  input.manualAgentModelIds = ["Manual-New-Worker", "Manual-New-Vision"];
  input.visionAgentModelProvided = true;
  input.visionAgentModel = "Manual-New-Vision";

  const result = upsertProviderModel(document, input);

  assert.equal(result.ok, true);
  const updated = result.document.namespaces["model-providers"].providers.deepseek;
  assert.deepEqual(updated.agents.modelTiers, {
    cheap: "Manual-New-Worker",
    default: "deepseek-v4-pro",
    strong: "Manual-New-Worker"
  });
  assert.equal(updated.agents.vision.model, "Manual-New-Vision");
  for (const id of ["Manual-New-Worker", "Manual-New-Vision"]) {
    const model = updated.models.find((candidate) => candidate.id === id);
    assert.deepEqual(model, {
      id,
      displayName: id,
      compat: { routingOnly: true }
    });
  }
  assert.doesNotThrow(() => resolveSettingsLayers({ global: result.document }));
});

test("Config V2 endpoint and protocol changes clear the old credential unless a new key replaces it", () => {
  for (const change of [
    { gatewayUrl: "https://other.example/v1/chat/completions" },
    { gatewayProtocol: "openai-responses" }
  ]) {
    const document = settingsDocument();
    document.namespaces["model-providers"].providers.deepseek.auth = {
      mode: "credential",
      ref: "ANT_CODE_PROVIDER_DEEPSEEK_API_KEY"
    };
    const input = { ...providerModelInput(), ...change };
    input.catalogModelIds = ["deepseek-v4-pro"];

    const result = upsertProviderModel(document, input);

    assert.equal(result.ok, true);
    assert.deepEqual(result.document.namespaces["model-providers"].providers.deepseek.auth, { mode: "none" });
    assert.deepEqual(result.credentialMutation, {
      op: "clear",
      ref: "ANT_CODE_PROVIDER_DEEPSEEK_API_KEY"
    });
  }

  const replacementDocument = settingsDocument();
  replacementDocument.namespaces["model-providers"].providers.deepseek.auth = {
    mode: "credential",
    ref: "ANT_CODE_PROVIDER_DEEPSEEK_API_KEY"
  };
  const replacementInput = providerModelInput();
  replacementInput.gatewayUrl = "https://other.example/v1/chat/completions";
  replacementInput.gatewayApiKey = "new-secret";
  replacementInput.credentialAction = "replace";
  replacementInput.catalogModelIds = ["deepseek-v4-pro"];

  const replaced = upsertProviderModel(replacementDocument, replacementInput);
  const replacementRef = replaced.document.namespaces["model-providers"].providers.deepseek.auth.ref;

  assert.deepEqual(replaced.document.namespaces["model-providers"].providers.deepseek.auth, {
    mode: "credential",
    ref: replacementRef
  });
  assert.notEqual(replacementRef, "ANT_CODE_PROVIDER_DEEPSEEK_API_KEY");
  assert.match(replacementRef, /^ANTCODE_GATEWAY_/);
  assert.deepEqual(replaced.credentialMutation, {
    op: "set",
    ref: replacementRef,
    value: "new-secret",
    cleanupRef: "ANT_CODE_PROVIDER_DEEPSEEK_API_KEY"
  });

  const rotationDocument = settingsDocument();
  rotationDocument.namespaces["model-providers"].providers.deepseek.auth = {
    mode: "credential",
    ref: "ANT_CODE_PROVIDER_DEEPSEEK_API_KEY"
  };
  const rotationInput = providerModelInput();
  rotationInput.gatewayApiKey = "rotated-secret";
  rotationInput.credentialAction = "replace";
  const rotated = upsertProviderModel(rotationDocument, rotationInput);
  const rotatedRef = rotated.document.namespaces["model-providers"].providers.deepseek.auth.ref;

  assert.notEqual(rotatedRef, "ANT_CODE_PROVIDER_DEEPSEEK_API_KEY");
  assert.deepEqual(rotated.credentialMutation, {
    op: "set",
    ref: rotatedRef,
    value: "rotated-secret",
    cleanupRef: "ANT_CODE_PROVIDER_DEEPSEEK_API_KEY"
  });
});

test("Config V2 credential mutations isolate shared references", () => {
  const sharedRef = "ANTCODE_SHARED_GATEWAY_KEY";
  const document = settingsDocument();
  document.namespaces["model-providers"].providers.deepseek.auth = {
    mode: "credential",
    ref: sharedRef
  };
  document.namespaces["model-providers"].providers.backup = {
    displayName: "Backup",
    transport: {
      protocol: "openai-chat",
      baseURL: "https://backup.example/v1/chat/completions"
    },
    auth: { mode: "credential", ref: sharedRef },
    models: [{ id: "backup-model" }]
  };

  const clearInput = providerModelInput();
  clearInput.gatewayUrl = "https://replacement.example/v1/chat/completions";
  clearInput.catalogModelIds = ["deepseek-v4-pro"];
  const cleared = upsertProviderModel(document, clearInput);

  assert.equal(cleared.ok, true);
  assert.deepEqual(cleared.document.namespaces["model-providers"].providers.deepseek.auth, { mode: "none" });
  assert.equal(cleared.credentialMutation, null);
  assert.equal(cleared.credentialConfigured, false);
  assert.deepEqual(cleared.document.namespaces["model-providers"].providers.backup.auth, {
    mode: "credential",
    ref: sharedRef
  });

  const replaceInput = providerModelInput();
  replaceInput.gatewayApiKey = "replacement-secret";
  replaceInput.credentialAction = "replace";
  const replaced = upsertProviderModel(document, replaceInput);
  const replacementRef = replaced.document.namespaces["model-providers"].providers.deepseek.auth.ref;

  assert.equal(replaced.ok, true);
  assert.notEqual(replacementRef, sharedRef);
  assert.match(replacementRef, /^ANTCODE_GATEWAY_/);
  assert.deepEqual(replaced.credentialMutation, {
    op: "set",
    ref: replacementRef,
    value: "replacement-secret"
  });
  assert.deepEqual(replaced.document.namespaces["model-providers"].providers.backup.auth, {
    mode: "credential",
    ref: sharedRef
  });
});

test("Config V2 provider deletion clears only the last credential reference", () => {
  const sharedRef = "ANTCODE_SHARED_GATEWAY_KEY";
  const document = settingsDocument();
  document.namespaces["model-providers"].providers.deepseek.auth = {
    mode: "credential",
    ref: sharedRef
  };
  document.namespaces["model-providers"].providers.backup = {
    displayName: "Backup",
    transport: {
      protocol: "openai-chat",
      baseURL: "https://backup.example/v1/chat/completions"
    },
    auth: { mode: "credential", ref: sharedRef },
    models: [{ id: "backup-model" }]
  };

  const sharedDelete = deleteProvider(document, "deepseek");
  assert.equal(sharedDelete.ok, true);
  assert.equal(sharedDelete.credentialRef, "");

  delete document.namespaces["model-providers"].providers.backup;
  const lastDelete = deleteProvider(document, "deepseek");
  assert.equal(lastDelete.ok, true);
  assert.equal(lastDelete.credentialRef, sharedRef);
});

test("Config V2 explicit model replacement drops catalog-confirmed old main models", () => {
  const document = settingsDocument();
  const provider = document.namespaces["model-providers"].providers.deepseek;
  provider.models.push({ id: "deepseek-reviewer", displayName: "Reviewer" });
  document.namespaces["default-model"].selection = { provider: "deepseek", model: "deepseek-reviewer" };
  const input = providerModelInput();
  input.previousModelId = "deepseek-v4-pro";
  input.replaceModels = true;
  input.catalogModelIds = ["deepseek-v4-pro", "deepseek-reviewer"];

  const result = upsertProviderModel(document, input);

  assert.equal(result.ok, true);
  const updated = result.document.namespaces["model-providers"].providers.deepseek;
  assert.deepEqual(updated.models.map((model) => model.id), ["deepseek-v4-pro"]);
  assert.equal(result.document.namespaces["default-model"].selection.model, "deepseek-v4-pro");
});

test("Config V2 garbage-collects only unreferenced routing models", () => {
  const document = settingsDocument();
  const provider = document.namespaces["model-providers"].providers.deepseek;
  provider.models.push(
    { id: "unused-worker", compat: { routingOnly: true } },
    { id: "project-worker", compat: { routingOnly: true } }
  );
  provider.agents = {
    modelTiers: { cheap: "deepseek-v4-pro", default: "deepseek-v4-pro", strong: "deepseek-v4-pro" }
  };
  const input = providerModelInput();
  input.protectedRoutingModelIds = ["project-worker"];

  const result = upsertProviderModel(document, input);

  assert.equal(result.ok, true);
  const ids = result.document.namespaces["model-providers"].providers.deepseek.models.map((model) => model.id);
  assert.equal(ids.includes("unused-worker"), false);
  assert.equal(ids.includes("project-worker"), true);
});

test("Config V2 model deletion safely migrates tiers and disables vision references", () => {
  const document = settingsDocument();
  const provider = document.namespaces["model-providers"].providers.deepseek;
  provider.models.push({
    id: "fallback-model",
    inputModalities: ["text"],
    agentModelTiers: { cheap: "deepseek-v4-pro", strong: "fallback-model" }
  });
  provider.agents = {
    modelTiers: { cheap: "deepseek-v4-pro", default: "deepseek-v4-pro", vision: "deepseek-v4-pro" },
    vision: { enabled: true, model: "deepseek-v4-pro", autoUseWhenMainModelTextOnly: true }
  };
  document.namespaces["agent-routing"] = {
    modelTiers: {
      cheap: { provider: "deepseek", model: "deepseek-v4-pro", reasoningEffort: "max" },
      vision: { provider: "deepseek", model: "deepseek-v4-pro" }
    },
    vision: {
      enabled: true,
      model: { provider: "deepseek", model: "deepseek-v4-pro" },
      autoUseWhenMainModelTextOnly: true
    }
  };

  const result = deleteProviderModel(document, "deepseek", "deepseek-v4-pro");

  assert.equal(result.ok, true);
  const updated = result.document.namespaces["model-providers"].providers.deepseek;
  assert.deepEqual(updated.models.map((model) => model.id), ["fallback-model"]);
  assert.deepEqual(updated.models[0].agentModelTiers, { cheap: "fallback-model", strong: "fallback-model" });
  assert.deepEqual(updated.agents.modelTiers, { cheap: "fallback-model", default: "fallback-model" });
  assert.deepEqual(updated.agents.vision, {
    enabled: false,
    model: null,
    autoUseWhenMainModelTextOnly: true
  });
  assert.equal(result.document.namespaces["default-model"].selection.model, "fallback-model");
  assert.deepEqual(result.document.namespaces["agent-routing"].modelTiers, {
    cheap: { provider: "deepseek", model: "fallback-model" }
  });
  assert.equal(result.document.namespaces["agent-routing"].vision.enabled, false);
  assert.equal(result.document.namespaces["agent-routing"].vision.model, null);
  assert.doesNotThrow(() => resolveSettingsLayers({ global: result.document }));
});

function settingsDocument() {
  return {
    settingsVersion: 2,
    namespaces: {
      "model-providers": {
        providers: {
          deepseek: {
            displayName: "DeepSeek",
            transport: {
              protocol: "openai-chat",
              baseURL: "https://deepseek.example/v1/chat/completions"
            },
            auth: { mode: "none" },
            models: [{ id: "deepseek-v4-pro", inputModalities: ["text"] }],
            agents: {
              modelTiers: {
                cheap: "deepseek-v4-flash",
                default: "deepseek-v4-pro",
                strong: "deepseek-v4-pro"
              },
              vision: {
                enabled: true,
                model: "deepseek-v4-pro",
                autoUseWhenMainModelTextOnly: true
              }
            }
          }
        }
      },
      "default-model": {
        selection: {
          provider: "deepseek",
          model: "deepseek-v4-pro",
          reasoningEffort: "max"
        }
      }
    }
  };
}

function trustedReasoningDiscovery() {
  return {
    source: "upstream-metadata",
    confidence: "declared",
    path: "reasoningEfforts",
    presetId: null
  };
}

function settingsDocumentWithReasoningDiscovery() {
  const document = settingsDocument();
  document.namespaces["model-providers"].providers.deepseek.models[0] = {
    id: "deepseek-v4-pro",
    inputModalities: ["text"],
    reasoning: {
      efforts: [{ id: "off" }, { id: "high" }, { id: "max" }],
      default: "max"
    },
    compat: {
      vendorFlag: true,
      reasoningDiscovery: trustedReasoningDiscovery()
    }
  };
  return document;
}

function providerModelInput(modelOverrides = {}) {
  return {
    profileId: "deepseek",
    gatewayUrl: "https://deepseek.example/v1/chat/completions",
    gatewayProtocol: "openai-chat",
    gatewayHealthUrl: "",
    credentialAction: "keep",
    switchToModel: false,
    model: {
      id: "deepseek-v4-pro",
      label: "DeepSeek V4 Pro",
      thinking: true,
      modalities: ["text"],
      reasoningEfforts: ["off", "high", "max"],
      defaultReasoningEffort: "max",
      ...modelOverrides
    }
  };
}
