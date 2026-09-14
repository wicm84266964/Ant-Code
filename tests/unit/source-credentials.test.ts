import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { sourceCredentialState, applySourceCredentials, sourceCredentialFailureMessage, sourceHasAlternateCredentials } from "../../src/config/source-credentials.ts";
import { createLabModelGateway } from "../../src/model-gateway/client.ts";
import { normalizeGatewayError } from "../../src/model-gateway/errors.ts";
import { mapSessionEventToDashboard } from "../../src/dashboard/events.ts";
import { loadConfig } from "../../src/config/load-config.ts";
import { applyRuntimeModelSelection } from "../../src/config-v2/runtime-selection.ts";
import { buildDashboardSettingsConfig, normalizeDashboardSettingsInput } from "../../src/dashboard/runtime/settings.ts";
import { createCredentialStore } from "../../src/credentials/store.ts";
import { credentialsPath } from "../../src/config-v2/paths.ts";

const url = "http://127.0.0.1:9999/v1/chat";
const profiles = ["a", "b"].map((id) => ({ id, gatewayUrl: url, gatewayProtocol: "lab-agent-gateway", gatewayApiKey: `test-${id}`, models: [{ id }] }));

test("ambiguous sources pick a default credential instead of blocking chat", async () => {
  const config = { lab: { gatewayUrl: url, gatewayProfiles: profiles } };
  assert.equal(sourceCredentialState(config)[url], "a");
  const resolved = applySourceCredentials(config);
  assert.equal(resolved.lab.gatewayApiKey, "test-a");
  assert.equal(resolved.lab.sourceCredentialSelectionRequired, false);
  const invalid = applySourceCredentials({ lab: { ...config.lab, activeGatewayProfile: "a", sourceCredentialSelections: { [url]: "deleted" } } });
  assert.equal(invalid.lab.gatewayApiKey, "test-a");
  assert.equal(invalid.lab.sourceCredentialSelectionRequired, false);
  const activeB = applySourceCredentials({ lab: { gatewayUrl: url, activeGatewayProfile: "b", gatewayProfiles: profiles } });
  assert.equal(activeB.lab.gatewayApiKey, "test-b");
});

test("unusable selected credentials tell the user to switch when another key exists", async () => {
  const config = { lab: { gatewayUrl: url, gatewayProfiles: profiles } };
  assert.equal(sourceHasAlternateCredentials(config), true);
  assert.match(sourceCredentialFailureMessage(true, 401), /切换生效凭据/);
  const hinted = normalizeGatewayError(null, {
    code: "GATEWAY_HTTP_ERROR",
    message: "Gateway returned HTTP 401",
    status: 401,
    canSwitchSourceCredential: true
  });
  assert.match(hinted.diagnostics.join("\n"), /切换生效凭据/);
  const events = mapSessionEventToDashboard({ type: "gateway_error", error: hinted });
  assert.match(String(events[0]?.detail ?? ""), /切换生效凭据/);

  const server = http.createServer((_req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "unauthorized" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const origin = typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : "";
  try {
    const failed = await createLabModelGateway({
      modelAlias: "test-model",
      networkMode: "offline",
      allowedHosts: [],
      lab: {
        gatewayUrl: origin,
        gatewayProtocol: "openai-chat",
        gatewayApiKey: "test-a",
        gatewayProfiles: [
          { id: "a", gatewayUrl: origin, gatewayApiKey: "test-a" },
          { id: "b", gatewayUrl: origin, gatewayApiKey: "test-b" }
        ]
      }
    } as any).sendChat({ messages: [{ role: "user", content: "hello" }] });
    assert.equal(failed.ok, false);
    if (failed.ok) {
      return;
    }
    assert.equal(failed.error.status, 401);
    assert.match(failed.error.message, /切换生效凭据/);
    assert.doesNotMatch(failed.error.message, /未发送模型请求/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("a single unusable credential asks the user to inspect settings without offering a switch", () => {
  const config = { lab: { gatewayUrl: url, gatewayProfiles: [profiles[0]] } };
  assert.equal(sourceHasAlternateCredentials(config), false);
  const hinted = normalizeGatewayError(null, {
    code: "GATEWAY_HTTP_ERROR",
    status: 401
  });
  assert.match(hinted.diagnostics.join("\n"), /检查这份凭据/);
  assert.doesNotMatch(hinted.diagnostics.join("\n"), /切换生效凭据/);
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
