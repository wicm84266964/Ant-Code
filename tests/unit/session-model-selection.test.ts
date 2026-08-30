import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runSubagent } from "../../src/agents/runner.ts";
import {
  applyRuntimeModelSelection,
  patchSessionModelSelectionMetadata,
  resolveSessionModelSelection
} from "../../src/config-v2/runtime-selection.ts";
import {
  createSession,
  persistSessionSnapshot,
  runSessionTurn,
  SessionModelSelectionUnresolvedError
} from "../../src/core/session.ts";
import { createSessionStore } from "../../src/storage/session-store.ts";

test("Config V2 session commits and resumes an exact atomic model selection", async () => {
  const fixture = await createFixture();
  const requests = [];
  const server = await listen(createGateway(requests));
  try {
    await fixture.writeSettings(settingsDocument(serverUrl(server)));
    const session = await createSession({ cwd: fixture.cwd, mode: "interactive", env: fixture.env });
    assert.deepEqual(session.modelSelection, {
      provider: "grok",
      model: "grok-4.6",
      reasoningEffort: "xhigh"
    }, JSON.stringify({
      enabled: session.config.configV2?.enabled,
      active: session.config.lab?.activeGatewayProfile,
      model: session.config.modelAlias,
      effort: session.config.reasoningEffort,
      providers: Object.keys(session.config.configV2?.resolved?.namespaces?.["model-providers"]?.providers ?? {})
    }));

    const selected = applyRuntimeModelSelection(session.config, {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      reasoningEffort: "max"
    });
    assert.equal(selected.status, "resolved");
    session.config = selected.config;
    session.model = selected.selection.model;
    session.modelSelection = selected.selection;
    await runSessionTurn(session, { prompt: "persist exact model", env: fixture.env });

    const metadataPath = path.join(fixture.cwd, ".lab-agent", "sessions", `${session.id}.json`);
    let metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
    assert.equal(metadata.metadataVersion, 2);
    assert.equal(metadata.model, "deepseek-v4-pro");
    assert.equal(metadata.reasoningEffort, "max");
    assert.deepEqual(metadata.modelSelection, {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      reasoningEffort: "max"
    });
    assert.equal(JSON.stringify(metadata).includes("secret"), false);

    session.config = applyRuntimeModelSelection(session.config, {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      reasoningEffort: "high"
    }).config;
    await persistSessionSnapshot(session, { env: fixture.env });
    metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
    assert.equal(metadata.reasoningEffort, "high");
    assert.equal(metadata.modelSelection.reasoningEffort, "high");

    const resumed = await createSession({
      cwd: fixture.cwd,
      mode: "interactive",
      env: fixture.env,
      resume: session.id
    });
    assert.equal(resumed.model, "deepseek-v4-pro");
    assert.equal(resumed.config.lab.activeGatewayProfile, "deepseek");
    assert.equal(resumed.config.reasoningEffort, "high");
    assert.deepEqual(resumed.modelSelection, metadata.modelSelection);
    assert.equal(resumed.resumedFrom.modelSelectionSource, "modelSelection");
    assert.equal(requests[0].model, "deepseek-v4-pro");
  } finally {
    await close(server);
  }
});

test("Config V2 reload resolves a routing-only vision model without exposing it as a main model", async () => {
  const fixture = await createFixture();
  const requests = [];
  const server = await listen(createGateway(requests));
  try {
    const document = settingsDocument(serverUrl(server));
    const grok = document.namespaces["model-providers"].providers.grok;
    grok.models[0].inputModalities = ["text"];
    grok.models.push({
      id: "grok-vision-worker",
      displayName: "Grok Vision Worker",
      inputModalities: ["text", "image"],
      compat: { routingOnly: true }
    });
    grok.agents = {
      modelTiers: { cheap: "grok-vision-worker" },
      vision: {
        enabled: true,
        model: "grok-vision-worker",
        autoUseWhenMainModelTextOnly: true
      }
    };
    await fixture.writeSettings(document);

    const session = await createSession({ cwd: fixture.cwd, mode: "interactive", env: fixture.env });
    const activeProfile = session.config.lab.gatewayProfiles.find((profile) => profile.id === "grok");
    assert.deepEqual(session.config.models.map((model) => model.id), ["grok-4.6"]);
    assert.deepEqual(activeProfile.models.map((model) => model.id), ["grok-4.6"]);
    assert.deepEqual(activeProfile.routingModels.map((model) => model.id), ["grok-vision-worker"]);
    assert.deepEqual(activeProfile.routingModels[0].modalities, ["text", "image"]);
    assert.equal(session.config.agents.modelTiers.cheap, "grok-vision-worker");
    assert.equal(session.config.agents.vision.model, "grok-vision-worker");
    assert.notEqual(applyRuntimeModelSelection(session.config, {
      provider: "grok",
      model: "grok-vision-worker"
    }).status, "resolved");

    await runSessionTurn(session, {
      prompt: "summarize the screenshot",
      attachments: [{
        type: "image",
        name: "screen.png",
        mimeType: "image/png",
        size: 5,
        data: "aGVsbG8="
      }],
      env: fixture.env
    });

    assert.deepEqual(requests.map((request) => request.model), ["grok-vision-worker", "grok-4.6"]);
    assert.equal(
      requests[0].messages.some((message) => message.content?.some?.((block) => block.type === "image")),
      true
    );
    const finalUserMessage = requests[1].messages.findLast((message) => message.role === "user");
    assert.equal(finalUserMessage.content.some((block) => block.type === "image"), false);
    assert.match(finalUserMessage.content.map((block) => block.text ?? "").join("\n"), /visual-verifier 视觉子智能体预分析/);
  } finally {
    await close(server);
  }
});

test("Config V2 resume infers a legacy model only for one exact provider owner", async () => {
  const fixture = await createFixture();
  await fixture.writeSettings(settingsDocument("https://gateway.example/v1/chat"));
  const store = createSessionStore({ cwd: fixture.cwd, env: fixture.env });
  await store.writeMetadata({
    id: "legacy-unique-model",
    startedAt: "2026-08-28T00:00:00.000Z",
    turnIndex: 1,
    model: "deepseek-v4-pro"
  });

  const resumed = await createSession({
    cwd: fixture.cwd,
    mode: "interactive",
    env: fixture.env,
    resume: "legacy-unique-model"
  });
  assert.deepEqual(resumed.modelSelection, {
    provider: "deepseek",
    model: "deepseek-v4-pro"
  });
  assert.equal(resumed.config.reasoningEffort, null);
  assert.equal(resumed.resumedFrom.modelSelectionSource, "legacy-model");
});

test("legacy resume preserves an explicitly cleared effort while missing metadata inherits config", async () => {
  const fixture = await createFixture();
  const configDir = path.join(fixture.cwd, ".lab-agent");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(path.join(configDir, "config.json"), JSON.stringify({
    modelAlias: "grok-legacy",
    reasoningEffort: "high",
    models: [{
      id: "grok-legacy",
      reasoningEfforts: ["low", "high"],
      defaultReasoningEffort: "high"
    }],
    lab: {
      gatewayUrl: "https://legacy.example/v1/chat/completions",
      gatewayProtocol: "openai-chat",
      gatewayApiKeyDisabled: true
    }
  }), "utf8");
  const store = createSessionStore({ cwd: fixture.cwd, env: fixture.env });
  await store.writeMetadata({
    id: "legacy-cleared-effort",
    model: "grok-legacy",
    reasoningEffort: null
  });
  await store.writeMetadata({
    id: "legacy-inherited-effort",
    model: "grok-legacy"
  });

  const cleared = await createSession({
    cwd: fixture.cwd,
    mode: "interactive",
    env: fixture.env,
    resume: "legacy-cleared-effort"
  });
  assert.equal(cleared.config.configV2?.enabled, false);
  assert.equal(cleared.model, "grok-legacy");
  assert.equal(cleared.config.reasoningEffort, null);

  const inherited = await createSession({
    cwd: fixture.cwd,
    mode: "interactive",
    env: fixture.env,
    resume: "legacy-inherited-effort"
  });
  assert.equal(inherited.config.reasoningEffort, "high");
});

test("a session persisted under legacy config remains inferable after enabling Config V2", async () => {
  const fixture = await createFixture();
  const legacyDir = path.join(fixture.cwd, ".lab-agent");
  await fs.mkdir(legacyDir, { recursive: true });
  await fs.writeFile(path.join(legacyDir, "config.json"), JSON.stringify({
    modelAlias: "deepseek-v4-pro",
    models: [{ id: "deepseek-v4-pro" }],
    lab: {
      gatewayUrl: "https://legacy.example/v1/chat/completions",
      gatewayProtocol: "openai-chat",
      gatewayApiKeyDisabled: true
    }
  }), "utf8");

  const legacySession = await createSession({ cwd: fixture.cwd, mode: "interactive", env: fixture.env });
  assert.equal(legacySession.config.configV2?.enabled, false);
  const store = createSessionStore({ cwd: fixture.cwd, env: fixture.env });
  await store.writeMetadata({
    id: legacySession.id,
    startedAt: legacySession.startedAt,
    turnIndex: legacySession.turnIndex,
    model: legacySession.model
  });
  await persistSessionSnapshot(legacySession, { env: fixture.env });
  const legacyMetadata = await store.readMetadataExact(legacySession.id);
  assert.equal(legacyMetadata.ok, true);
  assert.equal(legacyMetadata.metadata.metadataVersion, 1);
  assert.equal(legacyMetadata.metadata.model, "deepseek-v4-pro");
  assert.equal(legacyMetadata.metadata.modelSelection, null);

  await fixture.writeSettings(settingsDocument("https://gateway.example/v1/chat"));
  const resumed = await createSession({
    cwd: fixture.cwd,
    mode: "interactive",
    env: fixture.env,
    resume: legacySession.id
  });
  assert.deepEqual(resumed.modelSelection, {
    provider: "deepseek",
    model: "deepseek-v4-pro"
  });
  assert.equal(resumed.config.lab.activeGatewayProfile, "deepseek");
  assert.equal(resumed.resumedFrom.modelSelectionSource, "legacy-model");
});

test("Config V2 metadata never falls back to legacy model inference", async () => {
  const fixture = await createFixture();
  await fixture.writeSettings(settingsDocument("https://gateway.example/v1/chat"));
  const config = (await createSession({ cwd: fixture.cwd, mode: "interactive", env: fixture.env })).config;

  for (const metadata of [
    { metadataVersion: 2, model: "deepseek-v4-pro" },
    { metadataVersion: 2, model: "deepseek-v4-pro", modelSelection: null }
  ]) {
    assert.deepEqual(resolveSessionModelSelection(config, metadata), {
      status: "unresolved",
      code: "SESSION_MODEL_SELECTION_UNRESOLVED",
      reason: "missing-provider",
      model: "deepseek-v4-pro"
    });
  }
  assert.deepEqual(resolveSessionModelSelection(config, { model: "deepseek-v4-pro" }), {
    status: "resolved",
    source: "legacy-model",
    selection: { provider: "deepseek", model: "deepseek-v4-pro" }
  });
});

test("runtime provider switches replace gateway agent routes without dropping agent controls", async () => {
  const fixture = await createFixture();
  const document = settingsDocument("https://gateway.example/v1/chat");
  document.namespaces["model-providers"].providers.grok.models.push({
    id: "grok-route",
    inputModalities: ["text", "image"],
    compat: { routingOnly: true }
  });
  document.namespaces["model-providers"].providers.deepseek.models.push({
    id: "deepseek-route",
    inputModalities: ["text"],
    compat: { routingOnly: true }
  });
  document.namespaces["model-providers"].providers.grok.agents = {
    modelTiers: { strong: "grok-route" },
    vision: { enabled: true, model: "grok-route", autoUseWhenMainModelTextOnly: true }
  };
  document.namespaces["model-providers"].providers.deepseek.agents = {
    modelTiers: { strong: "deepseek-route" },
    vision: { enabled: false, model: null, autoUseWhenMainModelTextOnly: false }
  };
  document.namespaces["agent-routing"] = {
    modelTiers: { cheap: { provider: "grok", model: "grok-4.6" } }
  };
  await fixture.writeSettings(document);
  const session = await createSession({ cwd: fixture.cwd, mode: "interactive", env: fixture.env });
  assert.deepEqual(session.config.agents.modelTiers, {
    strong: "grok-route",
    cheap: "grok-4.6"
  });
  assert.deepEqual(session.config.agents.modelSelections, {
    cheap: { provider: "grok", model: "grok-4.6" }
  });
  assert.deepEqual(session.config.agents.vision, {
    enabled: true,
    model: "grok-route",
    autoUseWhenMainModelTextOnly: true
  });
  assert.deepEqual(session.config.routingModels.map((model) => model.id), ["grok-route"]);
  const config = {
    ...session.config,
    agents: {
      ...(session.config.agents ?? {}),
      orchestration: { maxParallelReadonlyAgentRuns: 7 },
      modelTiers: { stale: "grok-4.6" },
      modelSelections: { stale: { provider: "grok", model: "grok-4.6" } },
      vision: { enabled: true, model: "grok-4.6" },
      compat: { stale: true }
    }
  };

  const deepseek = applyRuntimeModelSelection(config, {
    provider: "deepseek",
    model: "deepseek-v4-pro",
    reasoningEffort: "max"
  });
  assert.equal(deepseek.status, "resolved");
  assert.deepEqual(deepseek.config.agents.modelTiers, { strong: "deepseek-route" });
  assert.equal(deepseek.config.agents.modelSelections, undefined);
  assert.deepEqual(deepseek.config.routingModels.map((model) => model.id), ["deepseek-route"]);
  assert.equal(deepseek.config.routingModels.some((model) => model.id === "grok-route"), false);
  assert.deepEqual(deepseek.config.agents.vision, {
    enabled: false,
    model: null,
    autoUseWhenMainModelTextOnly: false
  });
  assert.equal(deepseek.config.agents.compat, undefined);
  assert.deepEqual(deepseek.config.agents.orchestration, { maxParallelReadonlyAgentRuns: 7 });

  const grok = applyRuntimeModelSelection(deepseek.config, {
    provider: "grok",
    model: "grok-4.6",
    reasoningEffort: "xhigh"
  });
  assert.equal(grok.status, "resolved");
  assert.deepEqual(grok.config.agents.modelTiers, {
    strong: "grok-route",
    cheap: "grok-4.6"
  });
  assert.deepEqual(grok.config.agents.modelSelections, {
    cheap: { provider: "grok", model: "grok-4.6" }
  });
  assert.deepEqual(grok.config.routingModels.map((model) => model.id), ["grok-route"]);
  assert.equal(grok.config.routingModels.some((model) => model.id === "deepseek-route"), false);

  const environmentConfig = {
    ...grok.config,
    lab: {
      ...grok.config.lab,
      gatewayProfiles: [
        ...grok.config.lab.gatewayProfiles,
        {
          id: "environment",
          label: "Environment",
          gatewayUrl: "https://environment.example/v1/chat",
          gatewayProtocol: "openai-chat",
          gatewayApiKeyDisabled: true,
          modelAlias: "environment-model",
          models: [{ id: "environment-model" }],
          agents: { modelTiers: { strong: "environment-model" } }
        }
      ]
    }
  };
  const environment = applyRuntimeModelSelection(environmentConfig, {
    provider: "environment",
    model: "environment-model"
  });
  assert.equal(environment.status, "resolved");
  assert.deepEqual(environment.config.agents.modelTiers, { strong: "environment-model" });
  assert.deepEqual(environment.config.routingModels, []);
  assert.equal(environment.config.agents.modelSelections, undefined);
  assert.equal(environment.config.agents.vision, undefined);
  assert.deepEqual(environment.config.agents.orchestration, { maxParallelReadonlyAgentRuns: 7 });
});

test("Config V2 persists and resumes a materialized environment provider", async () => {
  const fixture = await createFixture();
  const requests = [];
  const server = await listen(createGateway(requests));
  try {
    await fixture.writeSettings(settingsDocument("https://configured.example/v1/chat"));
    Object.assign(fixture.env, {
      LAB_MODEL_GATEWAY_URL: serverUrl(server),
      LAB_MODEL_GATEWAY_PROTOCOL: "openai-chat",
      LAB_MODEL_GATEWAY_API_KEY: "environment-secret",
      LAB_AGENT_MODEL: "environment-model"
    });
    const session = await createSession({ cwd: fixture.cwd, mode: "interactive", env: fixture.env });
    assert.match(session.modelSelection.provider, /^gw-[a-f0-9]{12}$/);
    assert.equal(session.modelSelection.model, "environment-model");
    await runSessionTurn(session, { prompt: "persist environment selection", env: fixture.env });

    const metadataPath = path.join(fixture.cwd, ".lab-agent", "sessions", `${session.id}.json`);
    const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
    assert.deepEqual(metadata.modelSelection, session.modelSelection);
    assert.equal(JSON.stringify(metadata).includes("environment-secret"), false);

    const resumed = await createSession({
      cwd: fixture.cwd,
      mode: "interactive",
      env: fixture.env,
      resume: session.id
    });
    assert.deepEqual(resumed.modelSelection, session.modelSelection);
    assert.equal(resumed.config.lab.gatewayUrl, serverUrl(server));
    assert.equal(requests[0].model, "environment-model");
  } finally {
    await close(server);
  }
});

test("Config V2 environment endpoint switches never send stale provider routes to subagents", async () => {
  const fixture = await createFixture();
  const requests = [];
  const server = await listen(createGateway(requests));
  try {
    const document = settingsDocument("https://configured.example/v1/chat");
    const grok = document.namespaces["model-providers"].providers.grok;
    grok.models.push({
      id: "grok-route",
      inputModalities: ["text", "image"],
      compat: { routingOnly: true }
    });
    grok.agents = {
      modelTiers: { strong: "grok-route" },
      vision: { enabled: true, model: "grok-route", autoUseWhenMainModelTextOnly: true }
    };
    document.namespaces["agent-routing"] = {
      modelTiers: { cheap: { provider: "grok", model: "grok-4.6" } }
    };
    await fixture.writeSettings(document);
    Object.assign(fixture.env, {
      LAB_AGENT_MODEL: "environment-model",
      LAB_MODEL_GATEWAY_URL: serverUrl(server),
      LAB_MODEL_GATEWAY_PROTOCOL: "lab-agent-gateway"
    });

    const session = await createSession({ cwd: fixture.cwd, mode: "interactive", env: fixture.env });
    assert.equal(session.modelSelection.model, "environment-model");
    assert.deepEqual(session.config.routingModels, []);
    assert.equal(session.config.agents.modelTiers, undefined);
    assert.equal(session.config.agents.modelSelections, undefined);
    assert.equal(session.config.agents.vision, undefined);

    const result = await runSubagent({
      cwd: fixture.cwd,
      profileName: "reviewer",
      query: "Review the endpoint isolation result.",
      config: session.config,
      env: fixture.env,
      routeDecision: { modelTier: "strong" }
    });

    assert.equal(result.ok, true);
    assert.deepEqual(requests.map((request) => request.model), ["environment-model"]);
  } finally {
    await close(server);
  }
});

test("Config V2 resume reports deleted and ambiguous selections instead of using the default", async () => {
  const fixture = await createFixture();
  const initial = settingsDocument("https://gateway.example/v1/chat");
  await fixture.writeSettings(initial);
  const store = createSessionStore({ cwd: fixture.cwd, env: fixture.env });
  await store.writeMetadata({
    id: "deleted-provider-selection",
    model: "deepseek-v4-pro",
    modelSelection: {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      reasoningEffort: "max"
    }
  });
  delete initial.namespaces["model-providers"].providers.deepseek;
  await fixture.writeSettings(initial);

  await assert.rejects(
    createSession({
      cwd: fixture.cwd,
      mode: "interactive",
      env: fixture.env,
      resume: "deleted-provider-selection"
    }),
    (error) => error instanceof SessionModelSelectionUnresolvedError
      && error.code === "SESSION_MODEL_SELECTION_UNRESOLVED"
      && error.reason === "missing-provider"
      && error.model === "deepseek-v4-pro"
  );

  const ambiguous = settingsDocument("https://gateway.example/v1/chat");
  ambiguous.namespaces["model-providers"].providers.grok.models.push({ id: "shared-model" });
  ambiguous.namespaces["model-providers"].providers.deepseek.models.push({ id: "shared-model" });
  await fixture.writeSettings(ambiguous);
  await store.writeMetadata({ id: "ambiguous-legacy-model", model: "shared-model" });
  await assert.rejects(
    createSession({
      cwd: fixture.cwd,
      mode: "interactive",
      env: fixture.env,
      resume: "ambiguous-legacy-model"
    }),
    (error) => error.code === "SESSION_MODEL_SELECTION_UNRESOLVED"
      && error.reason === "ambiguous"
      && error.model === "shared-model"
      && error.candidates.join(",") === "deepseek,grok"
  );
});

test("session selection helpers are pure and preserve unrelated archived metadata", async () => {
  const fixture = await createFixture();
  await fixture.writeSettings(settingsDocument("https://gateway.example/v1/chat"));
  const config = (await createSession({ cwd: fixture.cwd, mode: "interactive", env: fixture.env })).config;
  const original = {
    id: "archived-session",
    model: "grok-4.6",
    transcript: { version: 2, messages: [{ role: "user", content: "keep me" }] },
    status: "completed"
  };
  const before = JSON.parse(JSON.stringify(original));
  const patched = patchSessionModelSelectionMetadata(original, {
    provider: "deepseek",
    model: "deepseek-v4-pro",
    reasoningEffort: "max"
  });

  assert.deepEqual(original, before);
  assert.deepEqual(patched.transcript, original.transcript);
  assert.equal(patched.status, "completed");
  assert.equal(patched.metadataVersion, 2);
  assert.equal(patched.model, "deepseek-v4-pro");
  assert.equal(patched.reasoningEffort, "max");
  assert.deepEqual(patched.modelSelection, {
    provider: "deepseek",
    model: "deepseek-v4-pro",
    reasoningEffort: "max"
  });

  const unresolved = resolveSessionModelSelection(config, { model: "not-configured" });
  assert.deepEqual(unresolved, {
    status: "unresolved",
    code: "SESSION_MODEL_SELECTION_UNRESOLVED",
    reason: "legacy-no-match",
    model: "not-configured"
  });
});

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "session-model-selection-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "project");
  const settingsPath = path.join(home, ".ant-code", "settings.json");
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.mkdir(cwd, { recursive: true });
  return {
    cwd,
    env: { USERPROFILE: home, LAB_AGENT_TRANSCRIPT_ENABLED: "true" },
    writeSettings: (document) => fs.writeFile(settingsPath, JSON.stringify(document, null, 2), "utf8")
  };
}

function settingsDocument(baseURL) {
  return {
    settingsVersion: 2,
    namespaces: {
      "model-providers": {
        providers: {
          grok: provider("Grok", `${baseURL}?provider=grok`, [{
            id: "grok-4.6",
            reasoning: reasoning(["low", "high", "xhigh"], "xhigh")
          }]),
          deepseek: provider("DeepSeek", `${baseURL}?provider=deepseek`, [{
            id: "deepseek-v4-pro",
            reasoning: reasoning(["off", "high", "max"], "high")
          }])
        }
      },
      "default-model": {
        selection: { provider: "grok", model: "grok-4.6", reasoningEffort: "xhigh" }
      }
    }
  };
}

function provider(displayName, baseURL, models) {
  return {
    displayName,
    transport: { protocol: "lab-agent-gateway", baseURL },
    auth: { mode: "none" },
    models
  };
}

function reasoning(efforts, defaultEffort) {
  return {
    efforts: efforts.map((id) => ({ id })),
    default: defaultEffort
  };
}

function createGateway(requests) {
  return http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "selection-test-response",
      model: requests.at(-1).model,
      content: [{ type: "text", text: "ok" }],
      toolCalls: [],
      stopReason: "stop"
    }));
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function serverUrl(server) {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not expose an address");
  return `http://127.0.0.1:${address.port}/v1/chat`;
}
