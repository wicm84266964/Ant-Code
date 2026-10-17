import assert from "node:assert/strict";
import test from "node:test";
import { importProviderCatalog, saveProviderAgentModels } from "../../src/config-v2/import-provider-catalog.ts";
import { officialSourceStatus } from "../../src/model-gateway/official-sources.ts";

test("official DeepSeek source reports the environment key without storing it", () => {
  const sources = officialSourceStatus({ DEEPSEEK_API_KEY: "test-key" });
  assert.equal(sources[0].id, "deepseek-official");
  assert.equal(sources[0].keyConfigured, true);
  assert.equal(JSON.stringify(sources).includes("test-key"), false);
});

test("importing a catalog keeps agent routing and stores every model", () => {
  const result = importProviderCatalog({
    settingsVersion: 2,
    namespaces: {
      "agent-routing": {
        modelTiers: {
          cheap: { provider: "custom", model: "old-cheap" }
        }
      }
    }
  }, {
    providerId: "example-com",
    displayName: "example.com",
    protocol: "openai-chat",
    baseURL: "https://example.com/v1/chat/completions",
    authMode: "credential",
    apiKey: "secret",
    models: [
      { id: "alpha" },
      { id: "beta", displayName: "Beta" }
    ]
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const providers = result.document.namespaces["model-providers"].providers;
  assert.deepEqual(providers["example-com"].models.map((model: { id: string }) => model.id), ["alpha", "beta"]);
  assert.equal(result.document.namespaces["agent-routing"].modelTiers.cheap.model, "old-cheap");
  assert.equal(result.credentialMutation?.op, "set");
});

test("sub-agent models stay inside the selected source", () => {
  const document = {
    settingsVersion: 2,
    namespaces: {
      "model-providers": {
        providers: {
          alpha: {
            displayName: "Alpha",
            transport: { protocol: "openai-chat", baseURL: "https://alpha.example/v1/chat/completions" },
            auth: { mode: "none" },
            models: [{ id: "alpha-fast", inputModalities: ["text"] }, { id: "alpha-strong", inputModalities: ["text"] }]
          }
        }
      }
    }
  };
  const saved = saveProviderAgentModels(document, {
    providerId: "alpha",
    cheap: "alpha-fast",
    defaultModel: "alpha-strong",
    strong: "alpha-strong",
    visionModel: ""
  });
  assert.equal(saved.ok, true);
  if (!saved.ok) return;
  assert.deepEqual(saved.document.namespaces["model-providers"].providers.alpha.agents.modelTiers, {
    cheap: "alpha-fast",
    default: "alpha-strong",
    strong: "alpha-strong"
  });
  const rejected = saveProviderAgentModels(document, {
    providerId: "alpha",
    cheap: "other-channel-model",
    defaultModel: "",
    strong: "",
    visionModel: ""
  });
  assert.equal(rejected.ok, false);
});
