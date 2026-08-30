import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../../src/config/load-config.ts";
import { createFileRepository } from "../../src/config-v2/file-repository.ts";
import { globalSettingsPath, projectSettingsPath } from "../../src/config-v2/paths.ts";
import { createDashboardRuntime } from "../../src/dashboard/sessions.ts";

test("Dashboard V2 keeps new-task model selections isolated per tab without writing settings", async () => {
  const fixture = await createRuntimeFixture();
  const runtime = createDashboardRuntime({ cwd: fixture.cwd, env: fixture.env });
  const beforeProject = await createFileRepository({ filePath: projectSettingsPath(fixture.cwd) }).read();

  const initialA = await runtime.status({ clientId: "tab-a" });
  const initialB = await runtime.status({ clientId: "tab-b" });
  assert.equal(initialA.configV2.enabled, true);
  assert.deepEqual(initialA.configV2.defaultSelections.global, {
    provider: "deepseek",
    model: "deepseek-v4-pro",
    reasoningEffort: "max"
  });
  assert.equal(initialA.configV2.defaultSelections.project, null);
  assert.equal(initialA.sessionStatus.model, "deepseek-v4-pro");
  assert.equal(initialB.sessionStatus.model, "deepseek-v4-pro");

  const switched = await runtime.switchModel({
    clientId: "tab-a",
    profileId: "grok",
    modelId: "grok-4.6",
    reasoningEffort: "xhigh"
  });
  assert.equal(switched.ok, true);
  assert.equal(switched.sessionStatus.model, "grok-4.6");
  assert.equal(switched.sessionStatus.reasoningEffort, "xhigh");
  assert.equal(switched.gatewayConfig.activeProfileId, "grok");

  const afterA = await runtime.status({ clientId: "tab-a" });
  const afterB = await runtime.status({ clientId: "tab-b" });
  assert.equal(afterA.sessionStatus.model, "grok-4.6");
  assert.equal(afterA.gatewayConfig.activeProfileId, "grok");
  assert.equal(afterB.sessionStatus.model, "deepseek-v4-pro");
  assert.equal(afterB.gatewayConfig.activeProfileId, "deepseek");

  const afterProject = await createFileRepository({ filePath: projectSettingsPath(fixture.cwd) }).read();
  assert.equal(afterProject.revision, beforeProject.revision);
  assert.equal(afterProject.exists, false);
});

test("Dashboard V2 persists defaults only through the qualified revisioned endpoint", async () => {
  const fixture = await createRuntimeFixture();
  const runtime = createDashboardRuntime({ cwd: fixture.cwd, env: fixture.env });
  const initial = await runtime.status({ clientId: "settings-tab" });

  const saved = await runtime.saveDefaultModelSelection({
    clientId: "settings-tab",
    scope: "project",
    providerId: "grok",
    modelId: "grok-4.6",
    reasoningEffort: "xhigh",
    expectedRevision: initial.configRevisions.project
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.selection.provider, "grok");
  assert.deepEqual(saved.configV2.defaultSelections.project, {
    provider: "grok",
    model: "grok-4.6",
    reasoningEffort: "xhigh"
  });
  assert.notEqual(saved.configRevisions.project, initial.configRevisions.project);

  const project = await createFileRepository({ filePath: projectSettingsPath(fixture.cwd) }).read();
  assert.deepEqual(project.data.namespaces["default-model"].selection, {
    provider: "grok",
    model: "grok-4.6",
    reasoningEffort: "xhigh"
  });
  const stale = await runtime.saveDefaultModelSelection({
    scope: "project",
    providerId: "deepseek",
    modelId: "deepseek-v4-pro",
    reasoningEffort: "max",
    expectedRevision: initial.configRevisions.project
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.status, 409);
  assert.equal(stale.code, "CONFIG_REVISION_CONFLICT");
});

test("Config V2 keeps providers with distinct ids separate when they share one endpoint", async () => {
  const document = settingsDocument();
  const providers = document.namespaces["model-providers"].providers;
  providers.grok.transport.baseURL = providers.deepseek.transport.baseURL;
  const fixture = await createRuntimeFixture(document);

  const config = await loadConfig({ cwd: fixture.cwd, env: fixture.env });
  assert.equal(config.lab.activeGatewayProfile, "deepseek");
  assert.deepEqual(config.lab.gatewayProfiles.map((profile) => profile.id).sort(), ["deepseek", "grok"]);
  assert.deepEqual(config.lab.gatewayProfiles.find((profile) => profile.id === "deepseek").models.map((model) => model.id), [
    "deepseek-v4-pro"
  ]);
  assert.deepEqual(config.lab.gatewayProfiles.find((profile) => profile.id === "grok").models.map((model) => model.id), [
    "grok-4.6"
  ]);
  assert.deepEqual(config.models.map((model) => model.id), ["deepseek-v4-pro"]);

  const runtime = createDashboardRuntime({ cwd: fixture.cwd, env: fixture.env });
  const switched = await runtime.switchModel({
    clientId: "shared-endpoint-tab",
    providerId: "grok",
    modelId: "grok-4.6",
    reasoningEffort: "xhigh"
  });
  assert.equal(switched.ok, true);
  assert.equal(switched.gatewayConfig.activeProfileId, "grok");
  assert.deepEqual(switched.models.map((model) => model.id), ["grok-4.6"]);
});

test("Dashboard V2 model save preserves provider agent tiers when agent fields are omitted", async () => {
  const fixture = await createRuntimeFixture(settingsDocumentWithAgentDefaults());
  const runtime = createDashboardRuntime({ cwd: fixture.cwd, env: fixture.env });
  const initial = await runtime.status();

  const saved = await runtime.saveModelConfig(deepseekModelSaveInput(initial));
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.agentModelTiers, deepseekAgentModelTiers());

  const stored = await createFileRepository({ filePath: globalSettingsPath(fixture.env) }).read();
  assert.deepEqual(
    stored.data.namespaces["model-providers"].providers.deepseek.agents.modelTiers,
    deepseekAgentModelTiers()
  );
});

test("Dashboard V2 model save clears provider agent tiers when all agent fields are explicitly empty", async () => {
  const fixture = await createRuntimeFixture(settingsDocumentWithAgentDefaults());
  const runtime = createDashboardRuntime({ cwd: fixture.cwd, env: fixture.env });
  const initial = await runtime.status();

  const saved = await runtime.saveModelConfig(deepseekModelSaveInput(initial, {
    agentCheapModel: "",
    agentDefaultModel: "",
    agentStrongModel: ""
  }));
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.agentModelTiers, {});

  const stored = await createFileRepository({ filePath: globalSettingsPath(fixture.env) }).read();
  const agents = stored.data.namespaces["model-providers"].providers.deepseek.agents;
  assert.equal(Object.prototype.hasOwnProperty.call(agents, "modelTiers"), false);
  assert.deepEqual(agents.vision, {
    enabled: true,
    model: "deepseek-v4-pro",
    autoUseWhenMainModelTextOnly: true
  });
});

test("Dashboard V2 ignores browser catalog evidence and preserves manual route ids without injected metadata", async () => {
  const fixture = await createRuntimeFixture(settingsDocumentWithAgentDefaults());
  const runtime = createDashboardRuntime({ cwd: fixture.cwd, env: fixture.env });
  const initial = await runtime.status();

  const saved = await runtime.saveModelConfig(deepseekModelSaveInput(initial, {
    agentCheapModel: "gpt-5.6-Luna",
    agentDefaultModel: "deepseek-v4-pro",
    agentStrongModel: "deepseek-v4-pro",
    visionAgentModel: "gpt-5.6-Luna",
    catalogModelIds: ["deepseek-v4-pro", "gpt-5.6-luna"],
    catalogModels: [{
      id: "gpt-5.6-luna",
      label: "GPT 5.6 Luna Vision",
      modalities: ["text", "image"],
      contextTokens: 262_144,
      thinking: true
    }]
  }));

  assert.equal(saved.ok, true);
  assert.deepEqual(saved.agentModelTiers, {
    cheap: "gpt-5.6-Luna",
    default: "deepseek-v4-pro",
    strong: "deepseek-v4-pro"
  });
  const stored = await createFileRepository({ filePath: globalSettingsPath(fixture.env) }).read();
  const provider = stored.data.namespaces["model-providers"].providers.deepseek;
  const routingModel = provider.models.find((model) => model.id === "gpt-5.6-Luna");
  assert.deepEqual(routingModel, {
    id: "gpt-5.6-Luna",
    displayName: "gpt-5.6-Luna",
    compat: { routingOnly: true }
  });
  assert.equal(provider.agents.vision.model, "gpt-5.6-Luna");
  assert.equal(saved.models.some((model) => model.id === "gpt-5.6-Luna"), false);
});

test("Dashboard V2 ignores a case-colliding browser catalog instead of treating it as authority", async () => {
  const fixture = await createRuntimeFixture();
  const runtime = createDashboardRuntime({ cwd: fixture.cwd, env: fixture.env });
  const initial = await runtime.status();

  const result = await runtime.saveModelConfig(deepseekModelSaveInput(initial, {
    catalogModelIds: ["gpt-5.6-luna", "gpt-5.6-Luna"]
  }));

  assert.equal(result.ok, true);
  const stored = await createFileRepository({ filePath: globalSettingsPath(fixture.env) }).read();
  assert.notEqual(stored.revision, initial.configRevisions.global);
  assert.equal(JSON.stringify(stored.data).includes("gpt-5.6-luna"), false);
  assert.equal(JSON.stringify(stored.data).includes("gpt-5.6-Luna"), false);
});

test("Dashboard V2 ignores browser metadata for an unconfirmed model", async () => {
  const fixture = await createRuntimeFixture();
  const runtime = createDashboardRuntime({ cwd: fixture.cwd, env: fixture.env });
  const initial = await runtime.status();

  const result = await runtime.saveModelConfig(deepseekModelSaveInput(initial, {
    catalogModelIds: ["deepseek-v4-pro"],
    catalogModels: [{
      id: "unconfirmed-vision-model",
      label: "Unconfirmed Vision Model",
      modalities: ["text", "image"]
    }]
  }));

  assert.equal(result.ok, true);
  const stored = await createFileRepository({ filePath: globalSettingsPath(fixture.env) }).read();
  assert.notEqual(stored.revision, initial.configRevisions.global);
  assert.equal(JSON.stringify(stored.data).includes("unconfirmed-vision-model"), false);
});

async function createRuntimeFixture(document = settingsDocument()) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-v2-runtime-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "project");
  const env = { LAB_AGENT_HOME: home };
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(path.join(home, "lab-agent.config.json"), "{}\n", "utf8");
  const global = createFileRepository({ filePath: globalSettingsPath(env) });
  await global.replace(document, { expectedRevision: "missing" });
  return { root, home, cwd, env };
}

function settingsDocument() {
  return {
    settingsVersion: 2,
    namespaces: {
      "model-providers": {
        providers: {
          deepseek: provider("DeepSeek", "https://deepseek.example/v1/responses", {
            id: "deepseek-v4-pro",
            efforts: ["off", "high", "max"],
            defaultEffort: "max"
          }),
          grok: provider("Grok", "https://grok.example/v1/responses", {
            id: "grok-4.6",
            efforts: ["low", "medium", "high", "xhigh"],
            defaultEffort: "high"
          })
        }
      },
      "default-model": {
        selection: { provider: "deepseek", model: "deepseek-v4-pro", reasoningEffort: "max" }
      }
    }
  };
}

function settingsDocumentWithAgentDefaults() {
  const document = settingsDocument();
  document.namespaces["model-providers"].providers.deepseek.agents = {
    modelTiers: deepseekAgentModelTiers(),
    vision: {
      enabled: true,
      model: "deepseek-v4-pro",
      autoUseWhenMainModelTextOnly: true
    }
  };
  return document;
}

function deepseekAgentModelTiers() {
  return {
    cheap: "deepseek-v4-pro",
    default: "deepseek-v4-pro",
    strong: "deepseek-v4-pro"
  };
}

function deepseekModelSaveInput(status, overrides = {}) {
  return {
    scope: "global",
    expectedRevision: status.configRevisions.global,
    expectedCredentialsRevision: status.configRevisions.credentials,
    providerId: "deepseek",
    gatewayUrl: "https://deepseek.example/v1/responses",
    gatewayProtocol: "openai-responses",
    previousModelId: "deepseek-v4-pro",
    modelId: "deepseek-v4-pro",
    label: "deepseek-v4-pro",
    reasoningEfforts: ["off", "high", "max"],
    defaultReasoningEffort: "max",
    switchToModel: false,
    ...overrides
  };
}

function provider(displayName, baseURL, model) {
  return {
    displayName,
    transport: { protocol: "openai-responses", baseURL },
    auth: { mode: "none" },
    models: [{
      id: model.id,
      displayName: model.id,
      thinking: true,
      inputModalities: ["text"],
      reasoning: {
        efforts: model.efforts.map((id) => ({ id })),
        default: model.defaultEffort
      }
    }]
  };
}
