import assert from "node:assert/strict";
import test from "node:test";
import { importProviderCatalog, parseContextWindowInput, saveModelContextWindow, saveProviderAgentModels } from "../../src/config-v2/import-provider-catalog.ts";
import { contextChangeAppliesNextTurn } from "../../src/dashboard/runtime/source-import.ts";
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

test("catalog refresh keeps a saved context window and only fills an empty one", () => {
  const document = {
    settingsVersion: 2,
    namespaces: {
      "model-providers": {
        providers: {
          "example-com": {
            displayName: "example.com",
            transport: { protocol: "openai-chat", baseURL: "https://example.com/v1/chat/completions" },
            auth: { mode: "none" },
            models: [
              { id: "alpha", displayName: "Alpha", inputModalities: ["text"], contextWindow: 1_000_000 },
              { id: "beta", displayName: "Beta", inputModalities: ["text"] }
            ]
          }
        }
      }
    }
  };
  const refreshed = importProviderCatalog(document, {
    providerId: "example-com",
    displayName: "example.com",
    protocol: "openai-chat",
    baseURL: "https://example.com/v1/chat/completions",
    authMode: "ambient",
    models: [
      { id: "alpha", displayName: "Alpha", contextWindow: 128_000 },
      { id: "beta", displayName: "Beta", contextWindow: 128_000 }
    ]
  });
  assert.equal(refreshed.ok, true);
  if (!refreshed.ok) return;
  const models = refreshed.document.namespaces["model-providers"].providers["example-com"].models;
  assert.equal(models.find((model: { id: string }) => model.id === "alpha").contextWindow, 1_000_000);
  assert.equal(models.find((model: { id: string }) => model.id === "beta").contextWindow, 128_000);
});

test("model context window can be saved and cleared without rewriting the catalog", () => {
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
  const saved = saveModelContextWindow(document, {
    providerId: "alpha",
    modelId: "alpha-fast",
    contextWindow: 400_000
  });
  assert.equal(saved.ok, true);
  if (!saved.ok) return;
  assert.equal(saved.document.namespaces["model-providers"].providers.alpha.models[0].contextWindow, 400_000);
  assert.equal(saved.document.namespaces["model-providers"].providers.alpha.models[1].id, "alpha-strong");
  const cleared = saveModelContextWindow(saved.document, {
    providerId: "alpha",
    modelId: "alpha-fast",
    contextWindow: null
  });
  assert.equal(cleared.ok, true);
  if (!cleared.ok) return;
  assert.equal(Object.hasOwn(cleared.document.namespaces["model-providers"].providers.alpha.models[0], "contextWindow"), false);
  assert.equal(parseContextWindowInput("").ok && parseContextWindowInput("").value, null);
  assert.equal(parseContextWindowInput("400000").ok && parseContextWindowInput("400000").value, 400_000);
  assert.equal(parseContextWindowInput("12k").ok, false);
});

test("a running session keeps its current context window until the next turn", () => {
  const running = {
    running: true,
    session: {
      model: "alpha-fast",
      modelSelection: { provider: "alpha" },
      config: { lab: { activeGatewayProfile: "alpha" } }
    }
  };
  assert.equal(contextChangeAppliesNextTurn(running, "alpha", "alpha-fast"), true);
  assert.equal(contextChangeAppliesNextTurn(running, "other", "alpha-fast"), false);
  assert.equal(contextChangeAppliesNextTurn({ ...running, running: false }, "alpha", "alpha-fast"), false);
  assert.equal(contextChangeAppliesNextTurn(running, "alpha", "alpha-strong"), false);
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
