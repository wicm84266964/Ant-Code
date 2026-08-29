import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../../src/config/load-config.js";
import { ensureConfigV2, rollbackConfigV2 } from "../../src/config-v2/activate.js";

test("Config V2 activation separates settings and credentials, preserves scopes, and is retryable", async () => {
  const fixture = await createFixture();
  const first = await ensureConfigV2({ cwd: fixture.cwd, env: fixture.env });

  assert.equal(first.changed, true);
  assert.equal(first.dryRun, false);
  assert.equal(first.backups.length, 2);
  const [globalSettings, projectSettings, globalLegacy, projectLegacy, credentials] = await Promise.all([
    readJson(first.paths.globalSettings),
    readJson(first.paths.projectSettings),
    readJson(first.paths.globalLegacy),
    readJson(first.paths.projectLegacy),
    readJson(first.paths.credentials)
  ]);
  assert.deepEqual(Object.keys(globalSettings), ["settingsVersion", "namespaces"]);
  assert.deepEqual(Object.keys(projectSettings), ["settingsVersion", "namespaces"]);
  assert.equal(JSON.stringify(globalSettings).includes(fixture.deepseekSecret), false);
  assert.equal(JSON.stringify(globalSettings).includes(fixture.grokSecret), false);
  assert.equal(JSON.stringify(credentials).includes(fixture.deepseekSecret), true);
  assert.equal(JSON.stringify(credentials).includes(fixture.grokSecret), true);
  assert.equal(globalLegacy.networkMode, "approved-web");
  assert.equal(Object.hasOwn(globalLegacy, "models"), false);
  assert.equal(Object.hasOwn(globalLegacy.lab ?? {}, "gatewayProfiles"), false);
  assert.deepEqual(projectLegacy.allowedHosts, ["grok.example", "other.example"]);
  assert.equal(Object.hasOwn(projectLegacy, "modelAlias"), false);

  const deepseekModels = globalSettings.namespaces["model-providers"].providers.deepseek.models;
  assert.equal(deepseekModels.find((model) => model.id === "deepseek-v4-flash")?.compat?.routingOnly, true);
  assert.equal(projectSettings.namespaces["default-model"].selection.reasoningEffort, "xhigh");

  const loaded = await loadConfig({ cwd: fixture.cwd, env: fixture.env });
  assert.equal(loaded.configV2.enabled, true);
  assert.equal(loaded.modelAlias, "grok-4.6");
  assert.equal(loaded.reasoningEffort, "xhigh");
  assert.equal(loaded.lab.gatewayProtocol, "openai-responses");
  assert.equal(loaded.lab.gatewayApiKey, fixture.grokSecret);
  assert.equal(loaded.lab.gatewayMaxRetries, 2);
  assert.equal(loaded.allowedHosts.includes("other.example"), true);
  assert.equal(loaded.allowedHosts.includes("grok.example"), true);
  assert.deepEqual(loaded.lab.gatewayProfiles.map((profile) => profile.id), ["deepseek", "grok"]);
  assert.deepEqual(
    loaded.lab.gatewayProfiles.find((profile) => profile.id === "deepseek").models.map((model) => model.id),
    ["deepseek-v4-pro"]
  );
  assert.deepEqual(
    loaded.lab.gatewayProfiles.find((profile) => profile.id === "deepseek").models[0].reasoningEfforts.map((effort) => effort.id),
    ["off", "high", "max"]
  );
  assert.equal(JSON.stringify(loaded.configV2.resolved).includes(fixture.grokSecret), false);

  const second = await ensureConfigV2({ cwd: fixture.cwd, env: fixture.env });
  assert.equal(second.changed, false);
  assert.equal(second.revisions.global, first.revisions.global);
  assert.equal(second.revisions.project, first.revisions.project);
});

test("Config V2 runtime ignores stale legacy model fields after activation", async () => {
  const fixture = await createFixture();
  const migrated = await ensureConfigV2({ cwd: fixture.cwd, env: fixture.env });
  const legacy = await readJson(migrated.paths.projectLegacy);
  await fs.writeFile(migrated.paths.projectLegacy, `${JSON.stringify({
    ...legacy,
    modelAlias: "stale-model",
    models: ["stale-model"],
    lab: {
      ...(legacy.lab ?? {}),
      gatewayUrl: "https://stale.example/v1/chat/completions",
      gatewayProtocol: "openai-chat"
    }
  }, null, 2)}\n`, "utf8");

  const loaded = await loadConfig({ cwd: fixture.cwd, env: fixture.env });
  assert.equal(loaded.modelAlias, "grok-4.6");
  assert.equal(loaded.lab.gatewayUrl, "https://grok.example/v1/responses");
  assert.equal(loaded.lab.gatewayProfiles.some((profile) => profile.id === "stale-model"), false);
});

test("Config V2 environment endpoint overrides isolate provider-owned agent routes", async () => {
  const fixture = await createFixture();
  const migrated = await ensureConfigV2({ cwd: fixture.cwd, env: fixture.env });
  const settings = await readJson(migrated.paths.globalSettings);
  const grok = settings.namespaces["model-providers"].providers.grok;
  grok.models.push({
    id: "grok-route",
    inputModalities: ["text", "image"],
    compat: { routingOnly: true }
  });
  grok.agents = {
    modelTiers: { strong: "grok-route" },
    vision: { enabled: true, model: "grok-route", autoUseWhenMainModelTextOnly: true }
  };
  settings.namespaces["agent-routing"] = {
    modelTiers: { cheap: { provider: "grok", model: "grok-route" } }
  };
  await writeJson(migrated.paths.globalSettings, settings);
  const legacy = await readJson(migrated.paths.projectLegacy);
  legacy.agents = {
    ...(legacy.agents ?? {}),
    orchestration: { maxParallelReadonlyAgentRuns: 7 }
  };
  await writeJson(migrated.paths.projectLegacy, legacy);

  const configured = await loadConfig({ cwd: fixture.cwd, env: fixture.env });
  assert.deepEqual(configured.routingModels.map((model) => model.id), ["grok-route"]);
  assert.equal(configured.agents.modelTiers.strong, "grok-route");
  assert.equal(configured.agents.modelSelections.cheap.model, "grok-route");
  assert.equal(configured.agents.vision.model, "grok-route");

  const loaded = await loadConfig({
    cwd: fixture.cwd,
    env: {
      ...fixture.env,
      LAB_AGENT_MODEL: "environment-model",
      LAB_MODEL_GATEWAY_URL: "https://environment.example/v1/chat/completions",
      LAB_MODEL_GATEWAY_PROTOCOL: "openai-chat"
    }
  });
  const activeProfile = loaded.lab.gatewayProfiles.find((profile) => (
    profile.id === loaded.lab.activeGatewayProfile
  ));
  const storedGrok = loaded.lab.gatewayProfiles.find((profile) => profile.id === "grok");

  assert.equal(loaded.modelAlias, "environment-model");
  assert.deepEqual(loaded.routingModels, []);
  assert.equal(loaded.agents.modelTiers, undefined);
  assert.equal(loaded.agents.modelSelections, undefined);
  assert.equal(loaded.agents.vision, undefined);
  assert.equal(loaded.agents.orchestration.maxParallelReadonlyAgentRuns, 7);
  assert.equal(loaded.agents.orchestration.enabled, true);
  assert.deepEqual(activeProfile.routingModels, []);
  assert.equal(JSON.stringify(activeProfile).includes("grok-route"), false);
  assert.equal(storedGrok.routingModels.some((model) => model.id === "grok-route"), true);
});

test("Config V2 rollback restores exact legacy documents and removes only created V2 data", async () => {
  const fixture = await createFixture();
  const beforeGlobal = await fs.readFile(path.join(fixture.home, ".ant-code", "lab-agent.config.json"), "utf8");
  const beforeProject = await fs.readFile(path.join(fixture.cwd, ".lab-agent", "config.json"), "utf8");
  const migrated = await ensureConfigV2({ cwd: fixture.cwd, env: fixture.env });

  const result = await rollbackConfigV2(migrated);
  assert.equal(result.ok, true);
  assert.equal(await fs.readFile(migrated.paths.globalLegacy, "utf8"), beforeGlobal);
  assert.equal(await fs.readFile(migrated.paths.projectLegacy, "utf8"), beforeProject);
  await assert.rejects(fs.access(migrated.paths.globalSettings), { code: "ENOENT" });
  await assert.rejects(fs.access(migrated.paths.projectSettings), { code: "ENOENT" });
  const credentialDocument = await readJson(migrated.paths.credentials);
  assert.deepEqual(credentialDocument.credentials, {});
});

test("Config V2 activation refuses an invalid existing settings file without overwriting it", async () => {
  const fixture = await createFixture();
  const settingsPath = path.join(fixture.home, ".ant-code", "settings.json");
  const invalid = "{\n  \"settingsVersion\": 2,\n  \"unexpected\": true\n}\n";
  await fs.writeFile(settingsPath, invalid, "utf8");

  await assert.rejects(
    ensureConfigV2({ cwd: fixture.cwd, env: fixture.env }),
    (error) => error.code === "CONFIG_V2_INVALID_SETTINGS_FILE"
  );
  assert.equal(await fs.readFile(settingsPath, "utf8"), invalid);
});

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "config-v2-activation-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "project");
  const deepseekSecret = "deepseek-activation-secret";
  const grokSecret = "grok-activation-secret";
  await fs.mkdir(path.join(home, ".ant-code"), { recursive: true });
  await fs.mkdir(path.join(cwd, ".lab-agent"), { recursive: true });
  const deepseekModel = {
    id: "deepseek-v4-pro",
    reasoningEfforts: ["off", "high", "max"],
    defaultReasoningEffort: "high",
    agentModelTiers: {
      cheap: "deepseek-v4-flash",
      default: "deepseek-v4-flash",
      strong: "deepseek-v4-pro"
    }
  };
  const grokModel = {
    id: "grok-4.6",
    modalities: ["text", "image"],
    reasoningEfforts: ["low", "medium", "high", "xhigh"],
    defaultReasoningEffort: "high"
  };
  await writeJson(path.join(home, ".ant-code", "lab-agent.config.json"), {
    networkMode: "approved-web",
    modelAlias: "grok-4.6",
    lab: {
      gatewayMaxRetries: 4,
      activeGatewayProfile: "grok",
      gatewayProfiles: [
        {
          id: "deepseek",
          label: "DeepSeek",
          gatewayUrl: "http://127.0.0.1:8787/v1/chat/completions",
          gatewayProtocol: "openai-chat",
          gatewayApiKey: deepseekSecret,
          modelAlias: "deepseek-v4-pro",
          models: [deepseekModel],
          agents: { modelTiers: deepseekModel.agentModelTiers }
        },
        {
          id: "grok",
          label: "Grok",
          gatewayUrl: "https://grok.example/v1/responses",
          gatewayProtocol: "openai-responses",
          gatewayApiKey: grokSecret,
          modelAlias: "grok-4.6",
          models: [grokModel]
        }
      ]
    }
  });
  await writeJson(path.join(cwd, ".lab-agent", "config.json"), {
    allowedHosts: ["grok.example", "other.example"],
    modelAlias: "grok-4.6",
    reasoningEffort: "xhigh",
    lab: {
      gatewayMaxRetries: 2,
      activeGatewayProfile: "grok",
      gatewayProfiles: [{
        id: "grok",
        label: "Grok",
        gatewayUrl: "https://grok.example/v1/responses",
        gatewayProtocol: "openai-responses",
        modelAlias: "grok-4.6",
        models: [grokModel]
      }]
    }
  });
  return { root, home, cwd, env: { USERPROFILE: home }, deepseekSecret, grokSecret };
}

/** @param {string} filePath @param {Record<string, any>} value */
async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** @param {string} filePath */
async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}
