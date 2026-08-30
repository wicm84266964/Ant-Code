import assert from "node:assert/strict";
import test from "node:test";
import {
  credentialReferenceForProvider,
  migrateV1Documents
} from "../../src/config-v2/migrate-v1.ts";
import { validateSettingsDocument } from "../../src/config-v2/schema.ts";

function model(id, efforts, defaultReasoningEffort) {
  return {
    id,
    label: id,
    reasoningEfforts: efforts.map((effort) => ({ id: effort })),
    defaultReasoningEffort
  };
}

test("Config V2 migration rebases a project clone without shadowing another global provider", () => {
  const globalDocument = {
    networkMode: "approved-web",
    lab: {
      activeGatewayProfile: "grok-global",
      gatewayProfiles: [
        {
          id: "deepseek-global",
          gatewayUrl: "http://127.0.0.1:8787/v1/chat/completions",
          gatewayProtocol: "openai-chat",
          gatewayApiKey: "deepseek-secret",
          modelAlias: "deepseek-v4-pro",
          models: [model("deepseek-v4-pro", ["off", "high", "max"], "high")]
        },
        {
          id: "grok-global",
          gatewayUrl: "https://gateway.example/v1/responses",
          gatewayProtocol: "openai-responses",
          gatewayApiKey: "grok-secret",
          modelAlias: "grok-4.6",
          models: [model("grok-4.6", ["low", "medium", "high", "xhigh"], "high")]
        }
      ]
    }
  };
  const projectDocument = {
    allowedHosts: ["gateway.example"],
    modelAlias: "grok-4.6",
    lab: {
      activeGatewayProfile: "deepseek-global",
      gatewayProfiles: [{
        id: "deepseek-global",
        gatewayUrl: "https://gateway.example/v1/responses",
        gatewayProtocol: "openai-responses",
        modelAlias: "grok-4.6",
        models: [model("grok-4.6", ["low", "medium", "high", "xhigh"], "xhigh")]
      }]
    }
  };

  const result = migrateV1Documents({ globalDocument, projectDocument });
  const globalProviders = result.globalDocument.namespaces["model-providers"].providers;
  const projectProviders = result.projectDocument.namespaces["model-providers"]?.providers ?? {};
  const projectSelection = result.projectDocument.namespaces["default-model"].selection;

  assert.deepEqual(Object.keys(globalProviders), ["deepseek-global", "grok-global"]);
  assert.equal(globalProviders["deepseek-global"].displayName, "DeepSeek");
  assert.equal(globalProviders["grok-global"].displayName, "Grok");
  assert.deepEqual(projectProviders, {});
  assert.equal(projectSelection.provider, "grok-global");
  assert.equal(projectSelection.model, "grok-4.6");
  assert.equal(projectSelection.reasoningEffort, "xhigh");
  assert.equal(result.mapping.project["deepseek-global"], "grok-global");
  assert.deepEqual(Object.keys(result.credentials).sort(), [
    credentialReferenceForProvider("deepseek-global"),
    credentialReferenceForProvider("grok-global")
  ]);
  assert.equal(JSON.stringify(result.globalDocument).includes("deepseek-secret"), false);
  assert.equal(JSON.stringify(result.globalDocument).includes("grok-secret"), false);
  assert.deepEqual(result.projectRemainder.allowedHosts, ["gateway.example"]);
  assert.doesNotThrow(() => validateSettingsDocument(result.globalDocument));
  assert.doesNotThrow(() => validateSettingsDocument(result.projectDocument));
});

test("Config V2 migration renames a project provider whose id collides with a different global endpoint", () => {
  const result = migrateV1Documents({
    globalDocument: {
      lab: {
        activeGatewayProfile: "shared-id",
        gatewayProfiles: [{
          id: "shared-id",
          gatewayUrl: "https://global.example/v1/chat/completions",
          gatewayProtocol: "openai-chat",
          models: ["global-model"]
        }]
      }
    },
    projectDocument: {
      modelAlias: "project-model",
      lab: {
        activeGatewayProfile: "shared-id",
        gatewayProfiles: [{
          id: "shared-id",
          gatewayUrl: "https://project.example/v1/responses",
          gatewayProtocol: "openai-responses",
          gatewayApiKey: "project-secret",
          modelAlias: "project-model",
          models: ["project-model"]
        }]
      }
    }
  });

  const projectProviders = result.projectDocument.namespaces["model-providers"].providers;
  const [projectProviderId] = Object.keys(projectProviders);
  assert.notEqual(projectProviderId, "shared-id");
  assert.match(projectProviderId, /^provider-[a-f0-9]{12,}$/);
  assert.equal(result.projectDocument.namespaces["default-model"].selection.provider, projectProviderId);
  assert.equal(result.credentials[credentialReferenceForProvider(projectProviderId)], "project-secret");
  assert.doesNotThrow(() => validateSettingsDocument(result.projectDocument));
});

test("Config V2 migration is idempotent for an existing settings document", () => {
  const document = {
    settingsVersion: 2,
    namespaces: {
      "model-providers": { providers: {} }
    }
  };
  const result = migrateV1Documents({ globalDocument: document, projectDocument: {} });
  assert.deepEqual(result.globalDocument, document);
  assert.deepEqual(result.globalRemainder, {});
});

test("Config V2 migration rejects ambiguous unqualified agent model routes", () => {
  assert.throws(() => migrateV1Documents({
    globalDocument: {
      agents: { modelTiers: { strong: "same-model" } },
      lab: {
        gatewayProfiles: [
          {
            id: "first",
            gatewayUrl: "https://first.example/v1/chat/completions",
            models: ["same-model"]
          },
          {
            id: "second",
            gatewayUrl: "https://second.example/v1/chat/completions",
            models: ["same-model"]
          }
        ]
      }
    }
  }), (error) => error.code === "CONFIG_V2_AMBIGUOUS_MODEL_REF");
});

test("Config V2 migration drops agent routes owned by a non-active provider", () => {
  const result = migrateV1Documents({
    globalDocument: {
      modelAlias: "main-model",
      agents: {
        modelTiers: { cheap: "worker-model" },
        vision: { enabled: true, model: "worker-model" }
      },
      lab: {
        activeGatewayProfile: "main",
        gatewayProfiles: [
          {
            id: "main",
            gatewayUrl: "https://main.example/v1/chat/completions",
            modelAlias: "main-model",
            models: ["main-model"]
          },
          {
            id: "worker",
            gatewayUrl: "https://worker.example/v1/chat/completions",
            modelAlias: "worker-model",
            models: ["worker-model"]
          }
        ]
      }
    }
  });

  assert.equal(result.globalDocument.namespaces["agent-routing"], undefined);
  assert.equal(result.globalDocument.namespaces["default-model"].selection.provider, "main");
});

test("Config V2 migration preserves an explicit cleared reasoning override", () => {
  const legacyDocument = {
    modelAlias: "reasoning-model",
    reasoningEffort: null,
    lab: {
      activeGatewayProfile: "reasoning-provider",
      gatewayProfiles: [{
        id: "reasoning-provider",
        gatewayUrl: "https://reasoning.example/v1/chat/completions",
        modelAlias: "reasoning-model",
        models: [model("reasoning-model", ["low", "high"], "high")]
      }]
    }
  };
  const cleared = migrateV1Documents({ globalDocument: legacyDocument });
  const inheritedDocument = structuredClone(legacyDocument);
  delete inheritedDocument.reasoningEffort;
  const inherited = migrateV1Documents({ globalDocument: inheritedDocument });

  assert.equal(
    Object.prototype.hasOwnProperty.call(
      cleared.globalDocument.namespaces["default-model"].selection,
      "reasoningEffort"
    ),
    false
  );
  assert.equal(
    inherited.globalDocument.namespaces["default-model"].selection.reasoningEffort,
    "high"
  );
});

test("Config V2 migration removes only the exact obsolete GPT ultra preset", () => {
  const obsolete = ["low", "medium", "high", "xhigh", "max", "ultra"];
  const migrate = (modelId, efforts) => migrateV1Documents({
    globalDocument: {
      modelAlias: modelId,
      reasoningEffort: "ultra",
      lab: {
        activeGatewayProfile: "gpt",
        gatewayProfiles: [{
          id: "gpt",
          gatewayUrl: "https://gateway.example/v1/responses",
          gatewayProtocol: "openai-responses",
          modelAlias: modelId,
          models: [model(modelId, efforts, "ultra")]
        }]
      }
    }
  }).globalDocument;

  const cleaned = migrate("gpt-5.6-sol", obsolete);
  const preserved = migrate("gpt-5.6-sol", ["none", ...obsolete]);
  const cleanedModel = cleaned.namespaces["model-providers"].providers.gpt.models[0];
  const preservedModel = preserved.namespaces["model-providers"].providers.gpt.models[0];

  assert.deepEqual(cleanedModel.reasoning.efforts.map((effort) => effort.id), obsolete.slice(0, -1));
  assert.equal(cleanedModel.reasoning.default, undefined);
  assert.equal(cleaned.namespaces["default-model"].selection.reasoningEffort, undefined);
  assert.deepEqual(preservedModel.reasoning.efforts.map((effort) => effort.id), ["none", ...obsolete]);
  assert.equal(preserved.namespaces["default-model"].selection.reasoningEffort, "ultra");
  assert.doesNotThrow(() => validateSettingsDocument(cleaned));
  assert.doesNotThrow(() => validateSettingsDocument(preserved));
});
