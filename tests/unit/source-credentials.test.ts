import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sourceCredentialState, applySourceCredentials } from "../../src/config/source-credentials.ts";
import { loadConfig } from "../../src/config/load-config.ts";
import { applyRuntimeModelSelection } from "../../src/config-v2/runtime-selection.ts";
import { buildDashboardSettingsConfig, normalizeDashboardSettingsInput } from "../../src/dashboard/runtime/settings.ts";
import { createLabModelGateway } from "../../src/model-gateway/client.ts";
import { createCredentialStore } from "../../src/credentials/store.ts";
import { credentialsPath } from "../../src/config-v2/paths.ts";

const url = "http://127.0.0.1:9999/v1/chat";
const profiles = ["a", "b"].map((id) => ({ id, gatewayUrl: url, gatewayProtocol: "lab-agent-gateway", gatewayApiKey: `test-${id}`, models: [{ id }] }));

test("ambiguous sources require a choice, explicit invalid references fail closed", async () => {
  const config = { lab: { gatewayUrl: url, gatewayProfiles: profiles } };
  assert.equal(sourceCredentialState(config)[url], null);
  const blocked = applySourceCredentials(config);
  await assert.rejects(createLabModelGateway(blocked as any).sendChat({ messages: [] }), /选择生效凭据/);
  const invalid = applySourceCredentials({ lab: { ...config.lab, activeGatewayProfile: "a", sourceCredentialSelections: { [url]: "deleted" } } });
  assert.equal(invalid.lab.gatewayApiKey, null);
  assert.equal(invalid.lab.sourceCredentialSelectionRequired, true);
});

test("selection is stable across model switches and does not mutate running snapshots", () => {
  const running = applySourceCredentials({ lab: { gatewayUrl: url, activeGatewayProfile: "a", gatewayProfiles: profiles } });
  const switched = applySourceCredentials({ ...running, lab: { ...running.lab, activeGatewayProfile: "b" } });
  assert.equal(switched.lab.gatewayApiKey, "test-a");
  const updated = applySourceCredentials({ ...running, lab: { ...running.lab, sourceCredentialSelections: { [url]: "b" } } });
  assert.equal(updated.lab.gatewayApiKey, "test-b");
  assert.equal(running.lab.gatewayApiKey, "test-a");
  assert.equal(profiles[0].gatewayApiKey, "test-a");
});

test("credential settings store only references and restrict project credentials to the project", () => {
  const config = { lab: { gatewayProfiles: profiles }, configV2: { provenance: { providers: { a: "project" } } } } as any;
  assert.equal(normalizeDashboardSettingsInput({ section: "source-credential", saveTarget: "global", settings: { profileId: "a" } }, config, {}).ok, false);
  const normalized = normalizeDashboardSettingsInput({ section: "source-credential", saveTarget: "project", settings: { profileId: "b" } }, config, {});
  assert.equal(normalized.ok, true);
  const saved = buildDashboardSettingsConfig({}, normalized as any);
  assert.equal(saved.lab.sourceCredentialSelections[url], "b");
  assert.doesNotMatch(JSON.stringify(saved), /test-a|test-b/);
});

test("Config V2 reload applies scoped credentials while preserving each model's subagent routes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ant-source-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const cwd = path.join(root, "project");
  await fs.mkdir(path.join(home, ".ant-code"), { recursive: true });
  await fs.mkdir(cwd);
  const env = { USERPROFILE: home, TEST_SOURCE_A: "test-a", TEST_SOURCE_B: "test-b" };
  const store = createCredentialStore({ filePath: credentialsPath(env) });
  await store.set("TEST_SOURCE_A", "test-a");
  await store.set("TEST_SOURCE_B", "test-b");
  await fs.writeFile(path.join(home, ".ant-code", "settings.json"), JSON.stringify({ settingsVersion: 2, namespaces: {
    "model-providers": { providers: Object.fromEntries(["a", "b"].map((id) => [id, {
      displayName: id, transport: { protocol: "lab-agent-gateway", baseURL: url }, auth: { mode: "credential", ref: `TEST_SOURCE_${id.toUpperCase()}` },
      models: [{ id }, { id: `${id}-worker`, compat: { routingOnly: true } }], agents: { modelTiers: { strong: `${id}-worker` } }
    }])) }, "default-model": { selection: { provider: "a", model: "a" } }
  } }));
  const first = await loadConfig({ cwd, env });
  assert.equal(first.lab.gatewayApiKey, "test-a");
  const changed = applyRuntimeModelSelection(first, { provider: "b", model: "b" });
  assert.equal(changed.status, "resolved");
  assert.equal(changed.config.lab.gatewayApiKey, "test-a");
  assert.equal(changed.config.agents.modelTiers.strong, "b-worker");
  await fs.writeFile(path.join(cwd, "lab-agent.config.json"), JSON.stringify({ lab: { sourceCredentialSelections: { [url]: "b" } } }));
  const refreshed = await loadConfig({ cwd, env });
  assert.equal(refreshed.lab.gatewayApiKey, "test-b");
  assert.equal(refreshed.agents.modelTiers.strong, "a-worker");
  assert.equal(first.lab.gatewayApiKey, "test-a");
});
