import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAgentTaskGroupStore } from "../../../src/agents/task-group-store.ts";
import { createAgentTaskStore } from "../../../src/agents/task-store.ts";
import { registerBackgroundTerminalTask } from "../../../src/agents/background-terminal-registry.ts";
import { createFileRepository } from "../../../src/config-v2/file-repository.ts";
import { createCredentialStore } from "../../../src/credentials/store.ts";
import { withConfigMutationLock } from "../../../src/dashboard/config-store.ts";
import { createDashboardRuntime } from "../../../src/dashboard/sessions.ts";
import { createSessionStore } from "../../../src/storage/session-store.ts";

import {
  waitForEvent,
  waitForCondition,
  cleanupAbortError,
  transcriptText,
  requestMessageText,
  createGateway,
  readDashboardRequestJson,
  createRecordingGateway,
  createHeaderRecordingGateway,
  createSequenceGateway,
  createAuthRecordingGateway,
  createOpenAIChatAuthRecordingGateway,
  createDelayedGateway,
  createFailingGateway,
  createRepeatedReadGateway,
  createHangingStreamGateway,
  createBackgroundWakeGateway,
  createQueueFullBackgroundWakeGateway,
  deferred,
  createBackgroundAnyWakeGateway,
  createToolGateway,
  createWriteGateway,
  createRepeatedEditGateway,
  createTodoGateway,
  createHangingGateway,
  createQuestionGateway,
  listen,
  close,
  mockGatewayEnv,
  assertGlobalSavePreservesProjectProjection
} from "./helpers.ts";

test("dashboard runtime saves local model gateway config", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-"));
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: cwd } });

  const saved = await runtime.saveModelConfig({
    saveTarget: "project",
    gatewayUrl: "https://local.gateway.example/v1/chat/completions",
    gatewayProtocol: "openai-chat",
    gatewayApiKey: "secret-key",
    modelId: "local-vision",
    label: "Local Vision",
    modalities: ["text", "image"],
    thinking: true,
    contextTokens: "128000",
    agentCheapModel: "local-cheap",
    agentDefaultModel: "local-default",
    agentStrongModel: "local-strong",
    visionAgentModel: "local-vision",
    applyAgentDefaults: true,
    switchToModel: true
  });

  assert.equal(saved.ok, true);
  assert.equal(saved.sessionStatus.model, "local-vision");
  assert.equal(saved.sessionStatus.context.maxTokens, 128000);
  assert.equal(saved.sessionStatus.context.modelMaxTokens, 128000);
  assert.equal(saved.gatewayConfig.apiKeyConfigured, true);
  assert.equal(saved.models.find((model) => model.id === "local-vision")?.current, true);
  assert.deepEqual(saved.models.find((model) => model.id === "local-vision")?.modalities, ["text", "image"]);

  const local = JSON.parse(await fs.readFile(path.join(cwd, ".lab-agent", "config.json"), "utf8"));
  assert.equal(local.modelAlias, "local-vision");
  assert.equal(local.lab.gatewayUrl, "https://local.gateway.example/v1/chat/completions");
  assert.equal(local.lab.gatewayApiKey, "secret-key");
  assert.equal(local.context.maxTokens, 128000);
  assert.equal(local.context.maxBytes, 512000);
  assert.ok(local.context.resumeMaxTokens >= local.context.maxTokens);
  assert.ok(local.context.resumeMaxBytes >= local.context.maxBytes);
  assert.ok(local.allowedHosts.includes("local.gateway.example"));
  assert.deepEqual(local.models.find((model) => model.id === "local-vision").modalities, ["text", "image"]);
  assert.deepEqual(local.models.find((model) => model.id === "local-vision").agentModelTiers, {
    cheap: "local-cheap",
    default: "local-default",
    strong: "local-strong"
  });
  assert.deepEqual(local.agents.modelTiers, {
    cheap: "local-cheap",
    default: "local-default",
    strong: "local-strong",
    vision: "local-vision"
  });
  assert.deepEqual(local.agents.vision, {
    enabled: true,
    model: "local-vision",
    autoUseWhenMainModelTextOnly: true
  });
});

test("dashboard runtime defaults model gateway config to the user global store", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-home-"));
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: home } });

  const saved = await runtime.saveModelConfig({
    gatewayUrl: "https://global.gateway.example/v1/chat/completions",
    gatewayProtocol: "openai-chat",
    gatewayApiKey: "global-key",
    modelId: "global-model",
    label: "Global Model",
    modalities: ["text"],
    contextTokens: "400000",
    switchToModel: true
  });

  assert.equal(saved.ok, true);
  assert.equal(saved.saveTarget, "global");
  assert.equal(saved.sessionStatus.model, "global-model");
  assert.equal(saved.gatewayConfig.gatewayUrl, "https://global.gateway.example/v1/chat/completions");
  assert.equal(saved.gatewayConfig.sources.gatewayUrl.type, "global");
  assert.equal(saved.gatewayConfig.globalConfigPath, path.join(home, ".ant-code", "lab-agent.config.json"));
  assert.equal(saved.gatewayProfiles.length, 1);
  assert.equal(saved.gatewayProfiles[0].ownerScope, "global");
  assert.equal(saved.gatewayProfiles[0].saveTarget, "global");
  assert.equal(saved.gatewayProfiles[0].editable, true);

  const global = JSON.parse(await fs.readFile(path.join(home, ".ant-code", "lab-agent.config.json"), "utf8"));
  assert.equal(global.modelAlias, "global-model");
  assert.equal(global.lab.gatewayUrl, "https://global.gateway.example/v1/chat/completions");
  await assert.rejects(fs.readFile(path.join(cwd, ".lab-agent", "config.json"), "utf8"), /ENOENT/);

  const otherProject = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-other-"));
  const otherRuntime = createDashboardRuntime({ cwd: otherProject, env: { USERPROFILE: home } });
  const status = await otherRuntime.status();
  assert.equal(status.sessionStatus.model, "global-model");
  assert.equal(status.gatewayConfig.gatewayUrl, "https://global.gateway.example/v1/chat/completions");
  assert.equal(status.gatewayConfig.sources.gatewayUrl.type, "global");
  assert.equal(status.gatewayProfiles[0].ownerScope, "global");
  assert.equal(status.gatewayProfiles[0].saveTarget, "global");
});

test("dashboard preserves a global profile identity and credential when its URL is edited", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-edit-global-profile-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-home-edit-global-profile-"));
  const globalPath = path.join(home, ".ant-code", "lab-agent.config.json");
  const profileId = "stable-global-profile";
  await fs.mkdir(path.dirname(globalPath), { recursive: true });
  await fs.writeFile(globalPath, JSON.stringify({
    modelAlias: "stable-model",
    models: [{ id: "stable-model" }],
    lab: {
      gatewayUrl: "https://same-origin.gateway.example/v1/chat/completions",
      gatewayProtocol: "openai-chat",
      gatewayApiKey: "stable-global-key",
      activeGatewayProfile: profileId,
      gatewayProfiles: [{
        id: profileId,
        gatewayUrl: "https://same-origin.gateway.example/v1/chat/completions",
        gatewayProtocol: "openai-chat",
        gatewayApiKey: "stable-global-key",
        modelAlias: "stable-model",
        models: [{ id: "stable-model" }]
      }]
    }
  }), "utf8");
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: home } });

  const initial = await runtime.status();
  assert.equal(initial.gatewayProfiles.find((profile) => profile.id === profileId)?.saveTarget, "global");

  const saved = await runtime.saveModelConfig({
    saveTarget: "global",
    profileId,
    gatewayUrl: "https://same-origin.gateway.example/v1/responses",
    gatewayProtocol: "openai-responses",
    credentialAction: "keep",
    previousGatewayUrl: "https://incorrect-client-value.example/v1",
    previousGatewayProtocol: "openai-chat",
    modelId: "stable-model",
    switchToModel: true
  });

  assert.equal(saved.ok, true);
  assert.equal(saved.gatewayProfiles.length, 1);
  assert.equal(saved.gatewayProfiles[0].id, profileId);
  assert.equal(saved.gatewayProfiles[0].gatewayUrl, "https://same-origin.gateway.example/v1/responses");
  assert.equal(saved.gatewayProfiles[0].gatewayProtocol, "openai-responses");
  assert.equal(saved.gatewayProfiles[0].apiKeyConfigured, true);
  assert.equal(saved.gatewayProfiles[0].saveTarget, "global");

  const global = JSON.parse(await fs.readFile(globalPath, "utf8"));
  assert.equal(global.lab.activeGatewayProfile, profileId);
  assert.equal(global.lab.gatewayProfiles.length, 1);
  assert.equal(global.lab.gatewayProfiles[0].id, profileId);
  assert.equal(global.lab.gatewayProfiles[0].gatewayUrl, "https://same-origin.gateway.example/v1/responses");
  assert.equal(global.lab.gatewayProfiles[0].gatewayApiKey, "stable-global-key");
  assert.equal(global.lab.gatewayProfiles.some((profile) => profile.gatewayUrl.includes("chat/completions")), false);
});

test("dashboard refuses to migrate a global profile credential into project scope", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-cross-scope-profile-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-home-cross-scope-profile-"));
  const globalPath = path.join(home, ".ant-code", "lab-agent.config.json");
  const profileId = "global-only-profile";
  await fs.mkdir(path.dirname(globalPath), { recursive: true });
  await fs.writeFile(globalPath, JSON.stringify({
    modelAlias: "global-only-model",
    models: [{ id: "global-only-model" }],
    lab: {
      gatewayUrl: "https://scope.gateway.example/v1/chat/completions",
      gatewayProtocol: "openai-chat",
      gatewayApiKey: "global-only-key",
      activeGatewayProfile: profileId,
      gatewayProfiles: [{
        id: profileId,
        gatewayUrl: "https://scope.gateway.example/v1/chat/completions",
        gatewayProtocol: "openai-chat",
        gatewayApiKey: "global-only-key",
        modelAlias: "global-only-model",
        models: [{ id: "global-only-model" }]
      }]
    }
  }), "utf8");
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: home } });

  const saved = await runtime.saveModelConfig({
    saveTarget: "project",
    profileId,
    gatewayUrl: "https://scope.gateway.example/v1/responses",
    gatewayProtocol: "openai-responses",
    credentialAction: "keep",
    modelId: "global-only-model",
    switchToModel: true
  });

  assert.equal(saved.ok, false);
  assert.equal(saved.status, 400);
  assert.match(saved.error, /全局配置/);
  await assert.rejects(fs.readFile(path.join(cwd, ".lab-agent", "config.json"), "utf8"), /ENOENT/);
  const global = JSON.parse(await fs.readFile(globalPath, "utf8"));
  assert.equal(global.lab.gatewayProfiles[0].gatewayApiKey, "global-only-key");
  assert.equal(global.lab.gatewayProfiles[0].gatewayUrl, "https://scope.gateway.example/v1/chat/completions");
});

test("dashboard keeps a global key effective when the same project profile stored null", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-home-"));
  const gatewayUrl = "https://shared.gateway.example/v1/chat/completions";
  const profileId = "shared-profile";
  await fs.mkdir(path.join(home, ".ant-code"), { recursive: true });
  await fs.writeFile(path.join(home, ".ant-code", "lab-agent.config.json"), JSON.stringify({
    modelAlias: "shared-model",
    models: [{ id: "shared-model" }],
    lab: {
      gatewayUrl,
      gatewayProtocol: "openai-chat",
      gatewayApiKey: "global-key",
      activeGatewayProfile: profileId,
      gatewayProfiles: [{
        id: profileId,
        gatewayUrl,
        gatewayProtocol: "openai-chat",
        gatewayApiKey: "global-key",
        modelAlias: "shared-model",
        models: [{ id: "shared-model" }]
      }]
    }
  }), "utf8");
  await fs.mkdir(path.join(cwd, ".lab-agent"), { recursive: true });
  await fs.writeFile(path.join(cwd, ".lab-agent", "config.json"), JSON.stringify({
    modelAlias: "shared-model",
    models: [{ id: "shared-model" }],
    lab: {
      gatewayUrl,
      gatewayProtocol: "openai-chat",
      gatewayApiKey: null,
      activeGatewayProfile: profileId,
      gatewayProfiles: [{
        id: profileId,
        gatewayUrl,
        gatewayProtocol: "openai-chat",
        gatewayApiKey: null,
        modelAlias: "shared-model",
        models: [{ id: "shared-model" }]
      }]
    }
  }), "utf8");
  const runtime = createDashboardRuntime({
    cwd,
    env: {
      USERPROFILE: home,
      LAB_MODEL_GATEWAY_URL: "https://stale-process.gateway.example/v1/chat/completions",
      LAB_MODEL_GATEWAY_PROTOCOL: "openai-chat",
      LAB_MODEL_GATEWAY_API_KEY: "stale-process-key"
    }
  });

  const status = await runtime.status();
  assert.equal(status.gatewayConfig.apiKeyConfigured, true);
  assert.equal(status.gatewayConfig.sources.apiKey.type, "global");
  assert.equal(status.gatewayProfiles.find((profile) => profile.id === profileId)?.ownerScope, "project");
  assert.equal(status.gatewayProfiles.find((profile) => profile.id === profileId)?.saveTarget, "project");
  const switched = await runtime.switchGatewayProfile({ profileId });
  assert.equal(switched.gatewayConfig.apiKeyConfigured, true);

  const local = JSON.parse(await fs.readFile(path.join(cwd, ".lab-agent", "config.json"), "utf8"));
  assert.equal(Object.prototype.hasOwnProperty.call(local.lab, "gatewayApiKey"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(local.lab.gatewayProfiles[0], "gatewayApiKey"), false);
});

test("dashboard sends an inherited global key after ignoring stale process gateway defaults", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-inherited-key-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-home-inherited-key-"));
  const requests = [];
  const server = await listen(createAuthRecordingGateway(requests, "authorized answer", "global-key"), "127.0.0.1", 0);
  const gatewayUrl = `http://127.0.0.1:${server.address().port}`;
  const profileId = "shared-profile";
  try {
    await fs.mkdir(path.join(home, ".ant-code"), { recursive: true });
    await fs.writeFile(path.join(home, ".ant-code", "lab-agent.config.json"), JSON.stringify({
      modelAlias: "shared-model",
      models: [{ id: "shared-model" }],
      allowedHosts: ["127.0.0.1"],
      lab: {
        gatewayUrl,
        gatewayProtocol: "lab-agent-gateway",
        gatewayApiKey: "global-key",
        activeGatewayProfile: profileId,
        gatewayProfiles: [{ id: profileId, gatewayUrl, gatewayProtocol: "lab-agent-gateway", gatewayApiKey: "global-key", modelAlias: "shared-model", models: [{ id: "shared-model" }] }]
      }
    }), "utf8");
    await fs.mkdir(path.join(cwd, ".lab-agent"), { recursive: true });
    await fs.writeFile(path.join(cwd, ".lab-agent", "config.json"), JSON.stringify({
      modelAlias: "shared-model",
      models: [{ id: "shared-model" }],
      allowedHosts: ["127.0.0.1"],
      lab: {
        gatewayUrl,
        gatewayProtocol: "lab-agent-gateway",
        gatewayApiKey: null,
        activeGatewayProfile: profileId,
        gatewayProfiles: [{ id: profileId, gatewayUrl, gatewayProtocol: "lab-agent-gateway", gatewayApiKey: null, modelAlias: "shared-model", models: [{ id: "shared-model" }] }]
      }
    }), "utf8");
    const runtime = createDashboardRuntime({
      cwd,
      env: {
        USERPROFILE: home,
        APPDATA: home,
        LAB_MODEL_GATEWAY_URL: "https://stale-process.gateway.example/v1/chat/completions",
        LAB_MODEL_GATEWAY_PROTOCOL: "openai-chat"
      }
    });

    await runtime.trustWorkspace();
    const started = await runtime.startTurn({ prompt: "verify inherited key", permissionMode: "plan" });
    await waitForEvent(runtime, started.sessionId, (event) => event.type === "run_state" && event.running === false);

    assert.equal(requests.length, 1);
    assert.equal(requests[0].authorization, "Bearer global-key");
  } finally {
    await close(server);
  }
});

test("dashboard project model config overrides user global default", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-home-"));
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: home } });

  await runtime.saveModelConfig({
    saveTarget: "global",
    gatewayUrl: "https://global.gateway.example/v1/chat/completions",
    gatewayProtocol: "openai-chat",
    gatewayApiKey: "global-key",
    modelId: "global-model",
    label: "Global Model",
    modalities: ["text"],
    switchToModel: true
  });
  const savedProject = await runtime.saveModelConfig({
    saveTarget: "project",
    gatewayUrl: "https://project.gateway.example/v1/chat/completions",
    gatewayProtocol: "openai-chat",
    gatewayApiKey: "project-key",
    modelId: "project-model",
    label: "Project Model",
    modalities: ["text"],
    switchToModel: true
  });

  assert.equal(savedProject.ok, true);
  assert.equal(savedProject.saveTarget, "project");
  assert.equal(savedProject.sessionStatus.model, "project-model");
  assert.equal(savedProject.gatewayConfig.gatewayUrl, "https://project.gateway.example/v1/chat/completions");
  assert.equal(savedProject.gatewayConfig.sources.gatewayUrl.type, "project");

  const local = JSON.parse(await fs.readFile(path.join(cwd, ".lab-agent", "config.json"), "utf8"));
  assert.equal(local.modelAlias, "project-model");
  assert.equal(local.lab.gatewayUrl, "https://project.gateway.example/v1/chat/completions");
});

test("dashboard keeps a global model visible when the project uses the same gateway", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-home-"));
  const gatewayUrl = "https://shared.gateway.example/v1/chat/completions";
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: home } });

  await runtime.saveModelConfig({
    saveTarget: "project",
    gatewayUrl,
    gatewayProtocol: "openai-chat",
    gatewayApiKey: "shared-key",
    modelId: "deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
    modalities: ["text"],
    switchToModel: true
  });
  const saved = await runtime.saveModelConfig({
    saveTarget: "global",
    gatewayUrl,
    gatewayProtocol: "openai-chat",
    gatewayApiKey: "shared-key",
    modelId: "deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    modalities: ["text"],
    switchToModel: true
  });

  assert.deepEqual(saved.models.map((model) => model.id).sort(), ["deepseek-v4-flash", "deepseek-v4-pro"]);
  const switched = await runtime.switchModel({ modelId: "deepseek-v4-flash" });
  assert.deepEqual(switched.models.map((model) => model.id).sort(), ["deepseek-v4-flash", "deepseek-v4-pro"]);
  const refreshed = await runtime.status();
  assert.deepEqual(refreshed.models.map((model) => model.id).sort(), ["deepseek-v4-flash", "deepseek-v4-pro"]);
});

test("dashboard runtime refreshes idle active session after saving gateway key", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-"));
  const requests = [];
  const server = await listen(createAuthRecordingGateway(requests, "fresh answer", "new-key"), "127.0.0.1", 0);
  const env = mockGatewayEnv(server, {
    LAB_MODEL_GATEWAY_API_KEY: "old-key",
    LAB_AGENT_MODEL: "mock-model"
  });
  const runtime = createDashboardRuntime({ cwd, env });

  try {
    await runtime.trustWorkspace();
    const started = await runtime.startTurn({
      prompt: "first attempt",
      permissionMode: "plan"
    });
    assert.equal(started.ok, true);
    await waitForEvent(runtime, started.sessionId, (event) => event.type === "run_state" && event.running === false);
    assert.equal(requests.at(-1)?.authorization, "Bearer old-key");
    assert.equal(runtime.active.get(started.sessionId).session.config.lab.gatewayApiKey, "old-key");

    const saved = await runtime.saveModelConfig({
      saveTarget: "project",
      sessionId: started.sessionId,
      gatewayUrl: env.LAB_MODEL_GATEWAY_URL,
      gatewayProtocol: "lab-agent-gateway",
      gatewayApiKey: "new-key",
      modelId: "mock-model",
      label: "Mock Model",
      modalities: ["text"],
      switchToModel: true
    });
    assert.equal(saved.ok, true);
    assert.equal(saved.sessionId, started.sessionId);
    assert.equal(runtime.active.get(started.sessionId).session.config.lab.gatewayApiKey, "new-key");

    const retried = await runtime.startTurn({
      sessionId: started.sessionId,
      prompt: "retry same session",
      permissionMode: "plan"
    });
    assert.equal(retried.ok, true);
    const events = await waitForEvent(runtime, started.sessionId, (event) => (
      event.type === "files_updated" && event.sequence > retried.eventCursor
    ));
    const final = events.find((event) => event.type === "assistant_final" && event.sequence > retried.eventCursor);
    assert.match(final?.text ?? "", /fresh answer/);
    assert.equal(requests.at(-1)?.authorization, "Bearer new-key");
  } finally {
    await close(server);
  }
});

test("dashboard runtime preserves running context usage when saving model window", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-"));
  const server = await listen(createHangingGateway(), "127.0.0.1", 0);
  const runtime = createDashboardRuntime({
    cwd,
    env: mockGatewayEnv(server, {
      ANT_CODE_INTERRUPT_FORCE_SETTLE_MS: "50",
      LAB_MODEL_GATEWAY_TIMEOUT_MS: "600000",
      LAB_AGENT_MODEL: "mock-model"
    })
  });

  try {
    await runtime.trustWorkspace();
    const started = await runtime.startTurn({
      prompt: "keep the visible context usage while this request is running",
      permissionMode: "plan"
    });
    assert.equal(started.ok, true);
    await waitForEvent(runtime, started.sessionId, (event) => event.type === "activity" && event.rawType === "gateway_request_start");

    const before = runtime.active.get(started.sessionId).session.lastPromptEstimate.tokens;
    assert.ok(before > 0);

    const saved = await runtime.saveModelConfig({
      saveTarget: "project",
      sessionId: started.sessionId,
      gatewayUrl: runtime.env.LAB_MODEL_GATEWAY_URL,
      gatewayProtocol: "lab-agent-gateway",
      modelId: "mock-model",
      label: "Mock Model",
      contextTokens: "400000",
      modalities: ["text"],
      switchToModel: true
    });

    assert.equal(saved.ok, true);
    assert.equal(saved.sessionStatus.context.promptTokens, before);
    assert.equal(saved.sessionStatus.context.maxTokens, 400000);
    assert.equal(saved.sessionStatus.context.modelMaxTokens, 400000);

    runtime.interruptTurn(started.sessionId, "test cleanup");
    await waitForEvent(runtime, started.sessionId, (event) => event.type === "run_state" && event.running === false);
  } finally {
    await close(server);
  }
});

test("dashboard runtime switches gateway profiles without mixing previous provider models", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-"));
  await fs.writeFile(path.join(cwd, "lab-agent.config.json"), JSON.stringify({
    modelAlias: "mimo-pro",
    models: [
      { id: "mimo-pro", label: "MiMo Pro", modalities: ["text"] },
      { id: "mimo-vision", label: "MiMo Vision", modalities: ["text", "image"] }
    ],
    lab: {
      gatewayUrl: "https://mimo.example/v1/chat/completions",
      gatewayProtocol: "openai-chat",
      gatewayApiKey: "mimo-key"
    },
    agents: {
      modelTiers: {
        cheap: "mimo-vision",
        default: "mimo-vision",
        strong: "mimo-vision",
        vision: "mimo-vision"
      },
      vision: {
        enabled: true,
        model: "mimo-vision",
        autoUseWhenMainModelTextOnly: true
      }
    }
  }), "utf8");
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: cwd } });

  const saved = await runtime.saveModelConfig({
    saveTarget: "project",
    gatewayUrl: "https://deepseek.example/v1/chat/completions",
    gatewayProtocol: "openai-chat",
    gatewayApiKey: "deepseek-key",
    modelId: "deepseek-chat",
    label: "DeepSeek Chat",
    modalities: ["text"],
    switchToModel: true
  });

  assert.equal(saved.ok, true);
  assert.equal(saved.sessionStatus.model, "deepseek-chat");
  assert.deepEqual(saved.models.map((model) => model.id), ["deepseek-chat"]);
  assert.equal(saved.gatewayProfiles.length, 2);
  assert.equal(saved.gatewayProfiles.find((profile) => profile.gatewayUrl.includes("deepseek"))?.current, true);
  assert.equal(saved.gatewayProfiles.find((profile) => profile.gatewayUrl.includes("mimo"))?.modelCount, 2);

  const local = JSON.parse(await fs.readFile(path.join(cwd, ".lab-agent", "config.json"), "utf8"));
  assert.deepEqual(local.models.map((model) => model.id), ["deepseek-chat"]);
  assert.equal(local.agents.vision.enabled, false);
  assert.equal(local.agents.vision.model, null);
  assert.equal(local.agents.modelTiers.vision, undefined);

  const mimoProfile = saved.gatewayProfiles.find((profile) => profile.gatewayUrl.includes("mimo"));
  const switched = await runtime.switchGatewayProfile({ profileId: mimoProfile.id });

  assert.equal(switched.ok, true);
  assert.equal(switched.gatewayConfig.gatewayUrl, "https://mimo.example/v1/chat/completions");
  assert.deepEqual(switched.models.map((model) => model.id), ["mimo-pro", "mimo-vision"]);
  assert.equal(switched.sessionStatus.model, "mimo-pro");
  assert.deepEqual(switched.visionAgent, {
    enabled: true,
    model: "mimo-vision",
    autoUseWhenMainModelTextOnly: true
  });
});

test("dashboard model config ignores process gateway env overrides", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-"));
  const runtime = createDashboardRuntime({
    cwd,
    env: {
      LAB_MODEL_GATEWAY_URL: "https://env-mimo.example/v1/chat/completions",
      LAB_MODEL_GATEWAY_PROTOCOL: "openai-chat",
      LAB_MODEL_GATEWAY_API_KEY: "env-key",
      LAB_AGENT_MODEL: "env-mimo-model"
    }
  });

  const initial = await runtime.status();
  assert.equal(initial.gatewayConfig.gatewayUrl, "https://env-mimo.example/v1/chat/completions");
  assert.equal(initial.sessionStatus.model, "env-mimo-model");
  assert.ok(initial.models.some((model) => model.id === "env-mimo-model"));
  assert.equal(initial.models.find((model) => model.id === "env-mimo-model")?.sources.modelAlias.type, "environment");
  assert.equal(initial.models.find((model) => model.id === "env-mimo-model")?.default, true);
  assert.equal(initial.gatewayConfig.sources.gatewayUrl.type, "environment");
  assert.equal(initial.gatewayConfig.sources.apiKey.type, "environment");
  assert.equal(initial.gatewayProfiles.find((profile) => profile.current)?.ownerScope, "environment");
  assert.equal(initial.gatewayProfiles.find((profile) => profile.current)?.saveTarget, "");
  assert.equal(initial.gatewayProfiles.find((profile) => profile.current)?.editable, false);

  const saved = await runtime.saveModelConfig({
    saveTarget: "project",
    gatewayUrl: "https://deepseek.example/v1/chat/completions",
    gatewayProtocol: "openai-chat",
    gatewayApiKey: "deepseek-key",
    modelId: "deepseek-chat",
    label: "DeepSeek Chat",
    modalities: ["text"],
    switchToModel: true
  });

  assert.equal(saved.ok, true);
  assert.equal(saved.gatewayConfig.gatewayUrl, "https://deepseek.example/v1/chat/completions");
  assert.equal(saved.gatewayConfig.sources.gatewayUrl.type, "project");
  assert.equal(saved.gatewayConfig.sources.apiKey.type, "project");
  assert.deepEqual(saved.models.map((model) => model.id), ["deepseek-chat"]);
  assert.equal(saved.gatewayProfiles.find((profile) => profile.gatewayUrl.includes("deepseek"))?.current, true);

  const after = await runtime.status();
  assert.equal(after.gatewayConfig.gatewayUrl, "https://deepseek.example/v1/chat/completions");
  assert.deepEqual(after.models.map((model) => model.id), ["deepseek-chat"]);
  assert.equal(after.gatewayConfig.sources.gatewayUrl.type, "project");
  assert.equal(after.gatewayConfig.sources.apiKey.type, "project");
});

test("dashboard keeps an inherited environment gateway authenticated without materializing it", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-env-profile-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-home-env-profile-"));
  const globalPath = path.join(home, ".ant-code", "lab-agent.config.json");
  await fs.mkdir(path.dirname(globalPath), { recursive: true });
  await fs.writeFile(globalPath, JSON.stringify({
    modelAlias: "global-model",
    models: [{ id: "global-model" }],
    lab: {
      gatewayUrl: "https://global.gateway.example/v1/chat/completions",
      gatewayProtocol: "openai-chat",
      gatewayApiKey: "global-key"
    }
  }), "utf8");
  const environmentUrl = "https://environment.gateway.example/v1/chat/completions";
  const runtime = createDashboardRuntime({
    cwd,
    env: {
      USERPROFILE: home,
      LAB_AGENT_MODEL: "environment-model",
      LAB_MODEL_GATEWAY_URL: environmentUrl,
      LAB_MODEL_GATEWAY_PROTOCOL: "openai-chat",
      LAB_MODEL_GATEWAY_API_KEY: "environment-secret"
    }
  });

  const initial = await runtime.status();
  assert.equal(initial.gatewayConfig.gatewayUrl, environmentUrl);
  assert.equal(initial.gatewayConfig.apiKeyConfigured, true);

  const projectSaved = await runtime.saveModelConfig({
    saveTarget: "project",
    gatewayUrl: "https://project.gateway.example/v1/chat/completions",
    gatewayProtocol: "openai-chat",
    gatewayApiKey: "project-key",
    modelId: "project-model",
    switchToModel: true
  });
  const environmentProfile = projectSaved.gatewayProfiles.find((profile) => profile.gatewayUrl === environmentUrl);

  assert.ok(environmentProfile);
  assert.equal(environmentProfile.apiKeyConfigured, true);
  const switched = await runtime.switchGatewayProfile({ profileId: environmentProfile.id });
  assert.equal(switched.ok, true);
  assert.equal(switched.gatewayConfig.gatewayUrl, environmentUrl);
  assert.equal(switched.gatewayConfig.apiKeyConfigured, true);

  const localText = await fs.readFile(path.join(cwd, ".lab-agent", "config.json"), "utf8");
  const local = JSON.parse(localText);
  assert.equal(localText.includes("environment-secret"), false);
  assert.equal(local.lab.gatewayProfiles.some((profile) => profile.gatewayUrl === environmentUrl), false);
});

test("dashboard keeps global credentials available beside materialized environment and project gateways", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-three-source-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-home-three-source-"));
  const requests = [];
  const server = await listen(
    createOpenAIChatAuthRecordingGateway(requests, "global answer", "global-secret"),
    "127.0.0.1",
    0
  );
  const globalUrl = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
  const environmentUrl = "https://environment.gateway.example/v1/chat/completions";
  const projectUrl = "https://project.gateway.example/v1/chat/completions";
  const globalPath = path.join(home, ".ant-code", "lab-agent.config.json");
  const localPath = path.join(cwd, ".lab-agent", "config.json");

  try {
    await fs.mkdir(path.dirname(globalPath), { recursive: true });
    await fs.writeFile(globalPath, JSON.stringify({
      modelAlias: "global-model",
      models: [{ id: "global-model" }],
      allowedHosts: ["127.0.0.1"],
      lab: {
        gatewayUrl: globalUrl,
        gatewayProtocol: "openai-chat",
        gatewayApiKey: "global-secret",
        activeGatewayProfile: "global-profile",
        gatewayProfiles: [{
          id: "global-profile",
          gatewayUrl: globalUrl,
          gatewayProtocol: "openai-chat",
          gatewayApiKey: "global-secret",
          modelAlias: "global-model",
          models: [{ id: "global-model" }]
        }]
      }
    }), "utf8");
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await fs.writeFile(localPath, JSON.stringify({
      modelAlias: "project-model",
      models: [{ id: "project-model" }],
      allowedHosts: ["127.0.0.1", "environment.gateway.example", "project.gateway.example"],
      lab: {
        gatewayUrl: projectUrl,
        gatewayProtocol: "openai-chat",
        gatewayApiKey: "project-secret",
        activeGatewayProfile: "project-profile",
        gatewayProfiles: [
          {
            id: "global-profile",
            gatewayUrl: globalUrl,
            gatewayProtocol: "openai-chat",
            modelAlias: "global-model",
            models: [{ id: "global-model" }]
          },
          {
            id: "environment-profile",
            gatewayUrl: environmentUrl,
            gatewayProtocol: "openai-chat",
            modelAlias: "environment-model",
            models: [{ id: "environment-model" }]
          },
          {
            id: "project-profile",
            gatewayUrl: projectUrl,
            gatewayProtocol: "openai-chat",
            gatewayApiKey: "project-secret",
            modelAlias: "project-model",
            models: [{ id: "project-model" }]
          }
        ]
      }
    }), "utf8");
    const runtime = createDashboardRuntime({
      cwd,
      env: {
        USERPROFILE: home,
        APPDATA: home,
        LAB_AGENT_MODEL: "environment-model",
        LAB_MODEL_GATEWAY_URL: environmentUrl,
        LAB_MODEL_GATEWAY_PROTOCOL: "openai-chat",
        LAB_MODEL_GATEWAY_API_KEY: "environment-secret"
      }
    });
    const initial = await runtime.status();
    const globalProfile = initial.gatewayProfiles.find((profile) => profile.gatewayUrl === globalUrl);

    assert.equal(initial.gatewayProfiles.length, 3);
    assert.ok(globalProfile);
    assert.equal(globalProfile.apiKeyConfigured, true);
    const switched = await runtime.switchGatewayProfile({ profileId: globalProfile.id });
    assert.equal(switched.ok, true);
    assert.equal(switched.gatewayConfig.apiKeyConfigured, true);

    await runtime.trustWorkspace();
    const started = await runtime.startTurn({ prompt: "verify the global source", permissionMode: "plan" });
    await waitForEvent(runtime, started.sessionId, (event) => event.type === "run_state" && event.running === false);

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/v1/chat/completions");
    assert.equal(requests[0].authorization, "Bearer global-secret");
    assert.equal(requests[0].body.model, "global-model");
    const localText = await fs.readFile(localPath, "utf8");
    assert.equal(localText.includes("global-secret"), false);
    assert.equal(localText.includes("environment-secret"), false);
  } finally {
    await close(server);
  }
});

test("dashboard runtime does not reuse an environment key after switching gateway URL", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-"));
  const runtime = createDashboardRuntime({
    cwd,
    env: {
      LAB_MODEL_GATEWAY_URL: "https://env.gateway.example/v1/chat/completions",
      LAB_MODEL_GATEWAY_PROTOCOL: "openai-chat",
      LAB_MODEL_GATEWAY_API_KEY: "env-key",
      LAB_AGENT_MODEL: "env-model"
    }
  });

  const saved = await runtime.saveModelConfig({
    saveTarget: "project",
    gatewayUrl: "https://project.gateway.example/v1/chat/completions",
    gatewayProtocol: "openai-chat",
    modelId: "project-model",
    label: "Project Model",
    modalities: ["text"],
    switchToModel: true
  });

  assert.equal(saved.ok, true);
  assert.equal(saved.gatewayConfig.gatewayUrl, "https://project.gateway.example/v1/chat/completions");
  assert.equal(saved.gatewayConfig.apiKeyConfigured, false);
  assert.equal(saved.gatewayConfig.sources.gatewayUrl.type, "project");
  assert.equal(saved.gatewayConfig.sources.apiKey.type, "project");

  const local = JSON.parse(await fs.readFile(path.join(cwd, ".lab-agent", "config.json"), "utf8"));
  assert.equal(Object.prototype.hasOwnProperty.call(local.lab, "gatewayApiKey"), false);
  const environmentProfile = local.lab.gatewayProfiles.find((profile) => profile.gatewayUrl.includes("env.gateway"));
  assert.equal(environmentProfile, undefined);
});

test("dashboard keeps old credentials scoped when the real settings payload changes endpoint", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-key-scope-save-"));
  await fs.mkdir(path.join(cwd, ".lab-agent"), { recursive: true });
  await fs.writeFile(path.join(cwd, ".lab-agent", "config.json"), JSON.stringify({
    modelAlias: "old-main",
    models: [{ id: "old-main" }, { id: "old-worker" }],
    agents: {
      modelTiers: { cheap: "old-worker", default: "old-worker", strong: "old-worker" },
      vision: { enabled: false, model: null }
    },
    lab: {
      gatewayUrl: "https://old.gateway.example/v1/chat/completions",
      gatewayProtocol: "openai-chat",
      gatewayApiKey: "old-secret",
      activeGatewayProfile: "old-profile",
      gatewayProfiles: [{
        id: "old-profile",
        gatewayUrl: "https://old.gateway.example/v1/chat/completions",
        gatewayProtocol: "openai-chat",
        gatewayApiKey: "old-secret",
        modelAlias: "old-main",
        models: [{ id: "old-main" }, { id: "old-worker" }],
        agents: { modelTiers: { cheap: "old-worker", default: "old-worker", strong: "old-worker" } }
      }]
    }
  }), "utf8");
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: cwd } });

  const saved = await runtime.saveModelConfig({
    saveTarget: "project",
    gatewayUrl: "https://new.gateway.example/v1/chat/completions",
    gatewayProtocol: "openai-chat",
    gatewayApiKey: "",
    credentialAction: "keep",
    previousGatewayUrl: "https://old.gateway.example/v1/chat/completions",
    previousGatewayProtocol: "openai-chat",
    modelId: "new-main",
    label: "New Main",
    agentCheapModel: "old-worker",
    agentDefaultModel: "old-worker",
    agentStrongModel: "old-worker",
    modalities: ["text"],
    switchToModel: true
  });

  assert.equal(saved.ok, true);
  assert.equal(saved.gatewayConfig.apiKeyConfigured, false);
  assert.deepEqual(saved.models.map((model) => model.id), ["new-main"]);
  assert.deepEqual(saved.agentModelTiers, { cheap: "new-main", default: "new-main", strong: "new-main" });
  const oldProfile = saved.gatewayProfiles.find((profile) => profile.id === "old-profile");
  const newProfile = saved.gatewayProfiles.find((profile) => profile.current);
  assert.equal(oldProfile.apiKeyConfigured, true);
  assert.equal(newProfile.apiKeyConfigured, false);

  const local = JSON.parse(await fs.readFile(path.join(cwd, ".lab-agent", "config.json"), "utf8"));
  assert.equal(Object.prototype.hasOwnProperty.call(local.lab, "gatewayApiKey"), false);
  assert.equal(local.lab.gatewayProfiles.find((profile) => profile.id === "old-profile").gatewayApiKey, "old-secret");
  assert.equal(
    Object.prototype.hasOwnProperty.call(local.lab.gatewayProfiles.find((profile) => profile.id === newProfile.id), "gatewayApiKey"),
    false
  );

  const switchedBack = await runtime.switchGatewayProfile({ profileId: "old-profile" });
  assert.equal(switchedBack.ok, true);
  assert.equal(switchedBack.gatewayConfig.apiKeyConfigured, true);
  assert.deepEqual(switchedBack.models.map((model) => model.id), ["old-main", "old-worker"]);
});

test("dashboard keeps an owned key when editing an endpoint path on the same origin", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-key-path-migration-"));
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: cwd } });
  await runtime.saveModelConfig({
    saveTarget: "project",
    gatewayUrl: "https://same-origin.gateway.example/v1",
    gatewayProtocol: "openai-chat",
    gatewayApiKey: "same-origin-key",
    modelId: "same-origin-model",
    switchToModel: true
  });

  const saved = await runtime.saveModelConfig({
    saveTarget: "project",
    gatewayUrl: "https://same-origin.gateway.example/v1/responses",
    gatewayProtocol: "openai-responses",
    gatewayApiKey: "",
    credentialAction: "keep",
    previousGatewayUrl: "https://same-origin.gateway.example/v1",
    previousGatewayProtocol: "openai-chat",
    previousModelId: "same-origin-model",
    modelId: "same-origin-model",
    switchToModel: true
  });

  assert.equal(saved.ok, true);
  assert.equal(saved.gatewayConfig.gatewayUrl, "https://same-origin.gateway.example/v1/responses");
  assert.equal(saved.gatewayConfig.gatewayProtocol, "openai-responses");
  assert.equal(saved.gatewayConfig.apiKeyConfigured, true);
  const local = JSON.parse(await fs.readFile(path.join(cwd, ".lab-agent", "config.json"), "utf8"));
  assert.equal(local.lab.gatewayApiKey, "same-origin-key");
  assert.equal(
    local.lab.gatewayProfiles.find((profile) => profile.gatewayUrl.endsWith("/responses")).gatewayApiKey,
    "same-origin-key"
  );
});

test("dashboard keeps a same-origin migrated key after restart and sends it to OpenAI Chat", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-key-migration-restart-"));
  const requests = [];
  const server = await listen(
    createOpenAIChatAuthRecordingGateway(requests, "migrated answer", "same-origin-key"),
    "127.0.0.1",
    0
  );
  const origin = `http://127.0.0.1:${server.address().port}`;
  const previousUrl = `${origin}/legacy/chat/completions`;
  const migratedUrl = `${origin}/v1/chat/completions`;

  try {
    const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: cwd, APPDATA: cwd } });
    await runtime.saveModelConfig({
      saveTarget: "project",
      gatewayUrl: previousUrl,
      gatewayProtocol: "openai-chat",
      gatewayApiKey: "same-origin-key",
      modelId: "same-origin-model",
      switchToModel: true
    });
    const saved = await runtime.saveModelConfig({
      saveTarget: "project",
      gatewayUrl: migratedUrl,
      gatewayProtocol: "openai-chat",
      gatewayApiKey: "",
      credentialAction: "keep",
      previousGatewayUrl: previousUrl,
      previousGatewayProtocol: "openai-chat",
      previousModelId: "same-origin-model",
      modelId: "same-origin-model",
      switchToModel: true
    });

    assert.equal(saved.ok, true);
    assert.equal(saved.gatewayConfig.apiKeyConfigured, true);
    const restarted = createDashboardRuntime({ cwd, env: { USERPROFILE: cwd, APPDATA: cwd } });
    const restartedStatus = await restarted.status();
    assert.equal(restartedStatus.gatewayConfig.gatewayUrl, migratedUrl);
    assert.equal(restartedStatus.gatewayConfig.apiKeyConfigured, true);

    await restarted.trustWorkspace();
    const started = await restarted.startTurn({ prompt: "verify the migrated source", permissionMode: "plan" });
    await waitForEvent(restarted, started.sessionId, (event) => event.type === "run_state" && event.running === false);

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/v1/chat/completions");
    assert.equal(requests[0].authorization, "Bearer same-origin-key");
    assert.equal(requests[0].body.model, "same-origin-model");
  } finally {
    await close(server);
  }
});

test("dashboard requires re-entry before copying an inherited key to a migrated endpoint", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-inherited-key-migration-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-home-inherited-key-migration-"));
  const globalPath = path.join(home, ".ant-code", "lab-agent.config.json");
  const localPath = path.join(cwd, ".lab-agent", "config.json");
  await fs.mkdir(path.dirname(globalPath), { recursive: true });
  await fs.writeFile(globalPath, JSON.stringify({
    modelAlias: "inherited-model",
    models: [{ id: "inherited-model" }],
    lab: {
      gatewayUrl: "https://inherited.gateway.example/v1",
      gatewayProtocol: "openai-chat",
      gatewayApiKey: "global-secret"
    }
  }), "utf8");
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, JSON.stringify({
    modelAlias: "inherited-model",
    models: [{ id: "inherited-model" }],
    lab: {
      gatewayUrl: "https://inherited.gateway.example/v1",
      gatewayProtocol: "openai-chat"
    }
  }), "utf8");
  const before = await fs.readFile(localPath, "utf8");
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: home } });

  const saved = await runtime.saveModelConfig({
    saveTarget: "project",
    gatewayUrl: "https://inherited.gateway.example/v1/responses",
    gatewayProtocol: "openai-responses",
    gatewayApiKey: "",
    credentialAction: "keep",
    previousGatewayUrl: "https://inherited.gateway.example/v1",
    previousGatewayProtocol: "openai-chat",
    previousModelId: "inherited-model",
    modelId: "inherited-model",
    switchToModel: true
  });

  assert.equal(saved.ok, false);
  assert.equal(saved.status, 400);
  assert.match(saved.error, /来自其他配置层/);
  assert.equal(await fs.readFile(localPath, "utf8"), before);
});

test("dashboard API key rotation preserves every model on the same gateway", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-key-rotation-"));
  const gatewayUrl = "https://shared.gateway.example/v1/chat/completions";
  await fs.mkdir(path.join(cwd, ".lab-agent"), { recursive: true });
  await fs.writeFile(path.join(cwd, ".lab-agent", "config.json"), JSON.stringify({
    modelAlias: "main",
    models: [{ id: "main" }, { id: "worker" }],
    agents: { modelTiers: { cheap: "worker", default: "worker", strong: "worker" } },
    lab: {
      gatewayUrl,
      gatewayProtocol: "openai-chat",
      gatewayApiKey: "old-key",
      activeGatewayProfile: "shared-profile",
      gatewayProfiles: [{
        id: "shared-profile",
        gatewayUrl,
        gatewayProtocol: "openai-chat",
        gatewayApiKey: "old-key",
        modelAlias: "main",
        models: [{ id: "main" }, { id: "worker" }]
      }]
    }
  }), "utf8");
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: cwd } });

  const saved = await runtime.saveModelConfig({
    saveTarget: "project",
    gatewayUrl,
    gatewayProtocol: "openai-chat",
    gatewayApiKey: "new-key",
    credentialAction: "replace",
    previousModelId: "main",
    modelId: "main",
    label: "Main",
    modalities: ["text"],
    switchToModel: true
  });

  assert.equal(saved.ok, true);
  assert.deepEqual(saved.models.map((model) => model.id), ["main", "worker"]);
  assert.deepEqual(saved.agentModelTiers, { cheap: "worker", default: "worker", strong: "worker" });
  const local = JSON.parse(await fs.readFile(path.join(cwd, ".lab-agent", "config.json"), "utf8"));
  assert.deepEqual(local.models.map((model) => model.id), ["main", "worker"]);
  assert.equal(local.lab.gatewayApiKey, "new-key");
});

test("dashboard project clear blocks an inherited key for the same endpoint", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-key-clear-project-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-home-key-clear-project-"));
  const gatewayUrl = "https://shared.gateway.example/v1/chat/completions";
  await fs.mkdir(path.join(home, ".ant-code"), { recursive: true });
  await fs.writeFile(path.join(home, ".ant-code", "lab-agent.config.json"), JSON.stringify({
    modelAlias: "shared-model",
    models: [{ id: "shared-model" }],
    lab: {
      gatewayUrl,
      gatewayProtocol: "openai-chat",
      gatewayApiKey: "global-key",
      activeGatewayProfile: "shared-profile",
      gatewayProfiles: [{
        id: "shared-profile",
        gatewayUrl,
        gatewayProtocol: "openai-chat",
        gatewayApiKey: "global-key",
        modelAlias: "shared-model",
        models: [{ id: "shared-model" }]
      }]
    }
  }), "utf8");
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: home } });

  const cleared = await runtime.saveModelConfig({
    saveTarget: "project",
    gatewayUrl,
    gatewayProtocol: "openai-chat",
    gatewayApiKey: "",
    credentialAction: "clear",
    previousModelId: "shared-model",
    modelId: "shared-model",
    modalities: ["text"],
    switchToModel: true
  });

  assert.equal(cleared.ok, true);
  assert.equal(cleared.gatewayConfig.apiKeyConfigured, false);
  assert.equal((await runtime.status()).gatewayConfig.apiKeyConfigured, false);
  const local = JSON.parse(await fs.readFile(path.join(cwd, ".lab-agent", "config.json"), "utf8"));
  assert.equal(local.lab.gatewayApiKey, null);
  assert.equal(local.lab.gatewayApiKeyDisabled, true);
  assert.equal(local.lab.gatewayProfiles[0].gatewayApiKey, null);
  assert.equal(local.lab.gatewayProfiles[0].gatewayApiKeyDisabled, true);
});

test("dashboard refuses incomplete legacy gateway profiles without mutating config", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-incomplete-profile-"));
  const configPath = path.join(cwd, ".lab-agent", "config.json");
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify({
    modelAlias: "active-model",
    models: [{ id: "active-model" }],
    lab: {
      gatewayUrl: "https://active.gateway.example/v1/chat/completions",
      gatewayProtocol: "openai-chat",
      activeGatewayProfile: "active-profile",
      gatewayProfiles: [
        {
          id: "active-profile",
          gatewayUrl: "https://active.gateway.example/v1/chat/completions",
          gatewayProtocol: "openai-chat",
          modelAlias: "active-model",
          models: [{ id: "active-model" }]
        },
        { id: "legacy-profile", gatewayProtocol: "openai-chat", modelAlias: "legacy-model" }
      ]
    }
  }), "utf8");
  const before = await fs.readFile(configPath, "utf8");
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: cwd } });

  const switched = await runtime.switchGatewayProfile({ profileId: "legacy-profile" });

  assert.equal(switched.ok, false);
  assert.equal(switched.status, 400);
  assert.match(switched.error, /API 地址或协议不完整/);
  assert.equal(await fs.readFile(configPath, "utf8"), before);
});

test("dashboard runtime keeps no-key profiles isolated across switches and model deletion", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-no-key-profile-"));
  const runtime = createDashboardRuntime({
    cwd,
    env: {
      LAB_MODEL_GATEWAY_URL: "https://env.gateway.example/v1/chat/completions",
      LAB_MODEL_GATEWAY_PROTOCOL: "openai-chat",
      LAB_MODEL_GATEWAY_API_KEY: "env-key",
      LAB_AGENT_MODEL: "env-model"
    }
  });

  await runtime.saveModelConfig({
    saveTarget: "project",
    gatewayUrl: "https://no-key.gateway.example/v1/chat/completions",
    gatewayProtocol: "openai-chat",
    modelId: "no-key-a",
    label: "No Key A",
    modalities: ["text"],
    switchToModel: true
  });
  const saved = await runtime.saveModelConfig({
    saveTarget: "project",
    gatewayUrl: "https://no-key.gateway.example/v1/chat/completions",
    gatewayProtocol: "openai-chat",
    modelId: "no-key-b",
    label: "No Key B",
    modalities: ["text"],
    switchToModel: true
  });
  const environmentProfile = saved.gatewayProfiles.find((profile) => profile.gatewayUrl.includes("env.gateway"));
  const noKeyProfile = saved.gatewayProfiles.find((profile) => profile.gatewayUrl.includes("no-key.gateway"));
  assert.equal(environmentProfile.apiKeyConfigured, true);
  assert.equal(noKeyProfile.apiKeyConfigured, false);

  const environmentSwitch = await runtime.switchGatewayProfile({ profileId: environmentProfile.id });
  assert.equal(environmentSwitch.gatewayConfig.apiKeyConfigured, true);
  assert.equal(environmentSwitch.gatewayProfiles.find((profile) => profile.id === environmentProfile.id).apiKeyConfigured, true);
  const noKeySwitch = await runtime.switchGatewayProfile({ profileId: noKeyProfile.id });
  assert.equal(noKeySwitch.gatewayConfig.apiKeyConfigured, false);
  assert.equal(noKeySwitch.gatewayProfiles.find((profile) => profile.id === environmentProfile.id).apiKeyConfigured, true);
  assert.equal(noKeySwitch.gatewayProfiles.find((profile) => profile.id === noKeyProfile.id).apiKeyConfigured, false);

  const deleted = await runtime.deleteModelConfig({ modelId: "no-key-a" });
  assert.deepEqual(deleted.models.map((model) => model.id), ["no-key-b"]);
  assert.equal(deleted.gatewayConfig.apiKeyConfigured, false);

  const local = JSON.parse(await fs.readFile(path.join(cwd, ".lab-agent", "config.json"), "utf8"));
  assert.equal(Object.prototype.hasOwnProperty.call(local.lab, "gatewayApiKey"), false);
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      local.lab.gatewayProfiles.find((profile) => profile.id === noKeyProfile.id),
      "gatewayApiKey"
    ),
    false
  );
  assert.equal(local.lab.gatewayProfiles.some((profile) => profile.id === environmentProfile.id), false);
});

test("dashboard runtime clears a stale health URL when the field is blank", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-health-"));
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: cwd } });

  await runtime.saveModelConfig({
    gatewayUrl: "https://old.gateway.example/v1/chat/completions",
    gatewayHealthUrl: "https://health-old.example/health",
    gatewayProtocol: "openai-chat",
    modelId: "old-model"
  });
  const saved = await runtime.saveModelConfig({
    gatewayUrl: "https://old.gateway.example/v1/chat/completions",
    gatewayHealthUrl: "",
    gatewayProtocol: "openai-chat",
    modelId: "new-model"
  });

  assert.equal(saved.gatewayConfig.gatewayHealthUrl, "");
  const globalConfig = JSON.parse(await fs.readFile(saved.configPath, "utf8"));
  assert.equal(globalConfig.lab.gatewayHealthUrl, null);
  assert.equal(globalConfig.allowedHosts.includes("health-old.example"), false);
  assert.equal(globalConfig.allowedHosts.includes("old.gateway.example"), true);
});

test("dashboard runtime preserves custom gateway ids and collapses endpoint duplicates", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-custom-profile-"));
  await fs.mkdir(path.join(cwd, ".lab-agent"), { recursive: true });
  await fs.writeFile(path.join(cwd, ".lab-agent", "config.json"), JSON.stringify({
    modelAlias: "legacy-model",
    models: [{ id: "legacy-model" }],
    allowedHosts: ["buddy.example"],
    lab: {
      gatewayUrl: "https://buddy.example/v1/chat/completions",
      gatewayProtocol: "openai-chat",
      gatewayApiKey: "legacy-key",
      activeGatewayProfile: "gw-stale-generated",
      gatewayProfiles: [
        {
          id: "legacy-custom-id",
          gatewayUrl: "https://buddy.example/v1/chat/completions",
          gatewayProtocol: "openai-chat",
          gatewayApiKey: "legacy-key",
          modelAlias: "legacy-model",
          models: [{ id: "legacy-model" }]
        },
        {
          id: "gw-stale-generated",
          gatewayUrl: "https://buddy.example/v1/chat/completions",
          gatewayProtocol: "openai-chat",
          gatewayApiKey: "generated-key",
          modelAlias: "legacy-model",
          models: [{ id: "legacy-model" }]
        }
      ]
    }
  }), "utf8");
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: cwd } });

  const saved = await runtime.saveModelConfig({
    saveTarget: "project",
    gatewayUrl: "https://buddy.example/v1/chat/completions",
    gatewayProtocol: "openai-chat",
    gatewayApiKey: "replacement-key",
    modelId: "edited-model",
    previousModelId: "legacy-model",
    switchToModel: true
  });

  assert.equal(saved.gatewayConfig.activeProfileId, "legacy-custom-id");
  assert.deepEqual(saved.gatewayProfiles.map((profile) => profile.id), ["legacy-custom-id"]);
  const localAfterSave = JSON.parse(await fs.readFile(path.join(cwd, ".lab-agent", "config.json"), "utf8"));
  assert.equal(localAfterSave.lab.gatewayProfiles.length, 1);
  assert.equal(localAfterSave.lab.gatewayProfiles[0].id, "legacy-custom-id");
  assert.equal(localAfterSave.lab.gatewayProfiles[0].gatewayApiKey, "replacement-key");

  const deleted = await runtime.deleteGatewayProfile({ profileId: "legacy-custom-id" });
  assert.equal(deleted.ok, true);
  assert.deepEqual(deleted.gatewayProfiles, []);
  const localAfterDelete = JSON.parse(await fs.readFile(path.join(cwd, ".lab-agent", "config.json"), "utf8"));
  assert.deepEqual(localAfterDelete.lab.gatewayProfiles, []);
  assert.equal(localAfterDelete.lab.gatewayApiKey, null);
  assert.equal(localAfterDelete.allowedHosts.includes("buddy.example"), false);
});

test("dashboard runtime clears stale agent routes when an older gateway profile has no agent config", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-profile-agents-"));
  await fs.mkdir(path.join(cwd, ".lab-agent"), { recursive: true });
  await fs.writeFile(path.join(cwd, ".lab-agent", "config.json"), JSON.stringify({
    modelAlias: "alpha-main",
    models: [{ id: "alpha-main" }, { id: "alpha-agent" }],
    agents: {
      modelTiers: { cheap: "alpha-agent", default: "alpha-agent", strong: "alpha-agent" },
      vision: { enabled: false, model: null }
    },
    lab: {
      gatewayUrl: "https://alpha.gateway.example/v1/chat/completions",
      gatewayProtocol: "openai-chat",
      gatewayApiKey: "alpha-key",
      activeGatewayProfile: "profile-alpha",
      gatewayProfiles: [
        {
          id: "profile-alpha",
          gatewayUrl: "https://alpha.gateway.example/v1/chat/completions",
          gatewayProtocol: "openai-chat",
          gatewayApiKey: "alpha-key",
          modelAlias: "alpha-main",
          models: [{ id: "alpha-main" }, { id: "alpha-agent" }]
        },
        {
          id: "profile-beta",
          gatewayUrl: "https://beta.gateway.example/v1/chat/completions",
          gatewayProtocol: "openai-chat",
          gatewayApiKey: null,
          modelAlias: "beta-main",
          models: [{ id: "beta-main" }]
        }
      ]
    }
  }), "utf8");
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: cwd } });

  const switched = await runtime.switchGatewayProfile({ profileId: "profile-beta" });

  assert.deepEqual(switched.models.map((model) => model.id), ["beta-main"]);
  assert.deepEqual(switched.agentModelTiers, {});
  assert.equal(switched.visionAgent.enabled, false);
  const local = JSON.parse(await fs.readFile(path.join(cwd, ".lab-agent", "config.json"), "utf8"));
  assert.equal(local.agents, undefined);
});

test("dashboard runtime does not carry an expired project key into a new gateway across turns", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-key-isolation-"));
  await fs.mkdir(path.join(cwd, ".lab-agent"), { recursive: true });
  await fs.writeFile(path.join(cwd, ".lab-agent", "config.json"), JSON.stringify({
    modelAlias: "old-model",
    models: [{ id: "old-model", label: "Old Model", modalities: ["text"] }],
    allowedHosts: ["old-gateway.example"],
    lab: {
      gatewayUrl: "https://old-gateway.example/v1/chat/completions",
      gatewayProtocol: "lab-agent-gateway",
      gatewayApiKey: "expired-old-key"
    }
  }), "utf8");
  const requests = [];
  const server = await listen(createHeaderRecordingGateway(requests, "new gateway answer"), "127.0.0.1", 0);
  const address = server.address();
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: cwd } });

  try {
    const saved = await runtime.saveModelConfig({
      saveTarget: "project",
      gatewayUrl: `http://127.0.0.1:${address.port}`,
      gatewayProtocol: "lab-agent-gateway",
      modelId: "new-model",
      label: "New Model",
      modalities: ["text"],
      switchToModel: true
    });
    assert.equal(saved.ok, true);
    assert.equal(saved.gatewayConfig.apiKeyConfigured, false);

    await runtime.trustWorkspace();
    const first = await runtime.startTurn({ prompt: "first new turn", permissionMode: "plan" });
    await waitForEvent(runtime, first.sessionId, (event) => event.type === "run_state" && event.running === false);
    const second = await runtime.startTurn({ sessionId: first.sessionId, prompt: "second new turn", permissionMode: "plan" });
    await waitForEvent(runtime, first.sessionId, (event) => event.type === "run_state" && event.running === false && event.sequence > second.eventCursor);

    assert.equal(requests.length, 2);
    assert.deepEqual(requests.map((request) => request.authorization), ["", ""]);
    assert.deepEqual(requests.map((request) => request.body.model), ["new-model", "new-model"]);
  } finally {
    await close(server);
  }
});

test("dashboard runtime adds models to the active gateway when the same key is submitted again", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-"));
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: cwd } });

  await runtime.saveModelConfig({
    saveTarget: "project",
    gatewayUrl: "https://deepseek.example/v1/chat/completions",
    gatewayProtocol: "openai-chat",
    gatewayApiKey: "deepseek-key",
    modelId: "deepseek-chat",
    label: "DeepSeek Chat",
    modalities: ["text"],
    switchToModel: true
  });
  const saved = await runtime.saveModelConfig({
    saveTarget: "project",
    gatewayUrl: "https://deepseek.example/v1/chat/completions",
    gatewayProtocol: "openai-chat",
    gatewayApiKey: "deepseek-key",
    modelId: "deepseek-reasoner",
    label: "DeepSeek Reasoner",
    modalities: ["text"],
    switchToModel: true
  });

  assert.equal(saved.ok, true);
  assert.deepEqual(saved.models.map((model) => model.id), ["deepseek-chat", "deepseek-reasoner"]);
  assert.equal(saved.gatewayProfiles.find((profile) => profile.current)?.modelCount, 2);
  assert.ok(saved.gatewayProfiles.find((profile) => profile.gatewayUrl.includes("deepseek")));

  const local = JSON.parse(await fs.readFile(path.join(cwd, ".lab-agent", "config.json"), "utf8"));
  assert.deepEqual(local.models.map((model) => model.id), ["deepseek-chat", "deepseek-reasoner"]);
  assert.equal(local.lab.gatewayApiKey, "deepseek-key");
});

test("dashboard runtime preserves concurrent model config updates through atomic mutations", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-config-"));
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: cwd } });

  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => runtime.saveModelConfig({
    saveTarget: "project",
    gatewayUrl: "https://concurrent-gateway.example/v1/chat/completions",
    gatewayProtocol: "openai-chat",
    gatewayApiKey: "concurrent-key",
    modelId: `concurrent-model-${index}`,
    label: `Concurrent Model ${index}`,
    modalities: ["text"],
    switchToModel: false
  })));

  assert.equal(results.every((result) => result.ok), true);
  assert.equal(new Set(results.map((result) => result.configRevision)).size, 8);
  const local = JSON.parse(await fs.readFile(path.join(cwd, ".lab-agent", "config.json"), "utf8"));
  assert.equal(local.models, undefined);
  const profile = local.lab.gatewayProfiles.find((item) => item.gatewayUrl.includes("concurrent-gateway.example"));
  assert.ok(profile);
  const savedModels = new Set(profile.models.map((model) => model.id));
  for (let index = 0; index < 8; index += 1) {
    assert.equal(savedModels.has(`concurrent-model-${index}`), true);
  }
});

test("dashboard runtime deletes a registered model from the active gateway", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-"));
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: cwd } });

  await runtime.saveModelConfig({
    saveTarget: "project",
    gatewayUrl: "https://mimo.example/v1/chat/completions",
    gatewayProtocol: "openai-chat",
    gatewayApiKey: "mimo-key",
    modelId: "mimo-pro",
    label: "Mimo Pro",
    modalities: ["text"],
    switchToModel: true
  });
  await runtime.saveModelConfig({
    saveTarget: "project",
    gatewayUrl: "https://mimo.example/v1/chat/completions",
    gatewayProtocol: "openai-chat",
    modelId: "mimo-vision",
    label: "Mimo Vision",
    modalities: ["text", "image"],
    visionAgentModel: "mimo-vision",
    switchToModel: true
  });

  const deleted = await runtime.deleteModelConfig({ modelId: "mimo-vision" });

  assert.equal(deleted.ok, true);
  assert.equal(deleted.deletedModel, "mimo-vision");
  assert.deepEqual(deleted.models.map((model) => [model.id, model.current]), [["mimo-pro", true]]);
  assert.deepEqual(deleted.visionAgent, {
    enabled: false,
    model: "",
    autoUseWhenMainModelTextOnly: true
  });
  assert.equal(deleted.gatewayProfiles.find((profile) => profile.current)?.modelCount, 1);

  const local = JSON.parse(await fs.readFile(path.join(cwd, ".lab-agent", "config.json"), "utf8"));
  assert.equal(local.modelAlias, "mimo-pro");
  assert.deepEqual(local.models.map((model) => model.id), ["mimo-pro"]);
  assert.equal(local.agents.vision.enabled, false);
  assert.equal(local.agents.vision.model, null);
  assert.equal(local.agents.modelTiers?.vision, undefined);
  assert.equal(local.lab.gatewayProfiles.find((profile) => profile.current || profile.id === local.lab.activeGatewayProfile)?.models.length, 1);
});

test("dashboard runtime clears the active gateway when deleting its final model", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-"));
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: cwd } });

  await runtime.saveModelConfig({
    saveTarget: "project",
    gatewayUrl: "https://deepseek.example/v1/chat/completions",
    gatewayProtocol: "openai-chat",
    gatewayApiKey: "deepseek-key",
    modelId: "deepseek-chat",
    label: "DeepSeek Chat",
    modalities: ["text"],
    switchToModel: true
  });

  const deleted = await runtime.deleteModelConfig({ modelId: "deepseek-chat" });

  assert.equal(deleted.ok, true);
  assert.equal(deleted.deletedModel, "deepseek-chat");
  assert.equal(deleted.clearedGateway, true);
  assert.equal(deleted.gatewayConfig.gatewayUrl, "");
  assert.equal(deleted.gatewayConfig.apiKeyConfigured, false);
  assert.deepEqual(deleted.models, []);
  assert.equal(deleted.sessionStatus.model, "");

  const local = JSON.parse(await fs.readFile(path.join(cwd, ".lab-agent", "config.json"), "utf8"));
  assert.equal(local.modelAlias, "");
  assert.deepEqual(local.models, []);
  assert.equal(local.lab.gatewayUrl, null);
  assert.equal(local.lab.gatewayApiKey, null);
  assert.equal(local.lab.gatewayProfiles.some((profile) => profile.gatewayUrl.includes("deepseek")), false);
});

test("dashboard runtime deletes the active gateway profile without falling back to an expired profile", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-delete-gateway-"));
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: cwd } });

  await runtime.saveModelConfig({
    saveTarget: "project",
    gatewayUrl: "https://old-gateway.example/v1/chat/completions",
    gatewayProtocol: "openai-chat",
    gatewayApiKey: "expired-old-key",
    modelId: "old-model",
    label: "Old Model",
    modalities: ["text"],
    switchToModel: true
  });
  const saved = await runtime.saveModelConfig({
    saveTarget: "project",
    gatewayUrl: "https://new-gateway.example/v1/chat/completions",
    gatewayProtocol: "openai-chat",
    gatewayApiKey: "new-key",
    modelId: "new-model",
    label: "New Model",
    modalities: ["text"],
    switchToModel: true
  });

  const deleted = await runtime.deleteGatewayProfile({ profileId: saved.gatewayConfig.activeProfileId });

  assert.equal(deleted.ok, true);
  assert.equal(deleted.clearedGateway, true);
  assert.equal(deleted.gatewayConfig.gatewayUrl, "");
  assert.equal(deleted.gatewayConfig.apiKeyConfigured, false);
  assert.deepEqual(deleted.models, []);
  assert.equal(deleted.gatewayProfiles.length, 1);
  assert.equal(deleted.gatewayProfiles[0].gatewayUrl, "https://old-gateway.example/v1/chat/completions");
  assert.equal(deleted.gatewayProfiles[0].current, false);

  const local = JSON.parse(await fs.readFile(path.join(cwd, ".lab-agent", "config.json"), "utf8"));
  assert.equal(local.lab.gatewayUrl, null);
  assert.equal(local.lab.gatewayApiKey, null);
  assert.equal(local.lab.activeGatewayProfile, "");
  assert.deepEqual(local.models, []);
  assert.equal(local.allowedHosts.includes("new-gateway.example"), false);
  assert.equal(local.allowedHosts.includes("old-gateway.example"), true);
});

test("dashboard keeps a deleted global gateway hidden after refresh and restart", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-delete-global-"));
  const otherProject = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-delete-global-other-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-home-delete-global-"));
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: home } });
  const saved = await runtime.saveModelConfig({
    saveTarget: "global",
    gatewayUrl: "https://global.gateway.example/v1/chat/completions",
    gatewayProtocol: "openai-chat",
    gatewayApiKey: "global-key",
    modelId: "global-model",
    switchToModel: true
  });

  const deleted = await runtime.deleteGatewayProfile({ profileId: saved.gatewayConfig.activeProfileId });
  const refreshed = await runtime.status();
  const restarted = await createDashboardRuntime({ cwd, env: { USERPROFILE: home } }).status();
  const newProject = await createDashboardRuntime({ cwd: otherProject, env: { USERPROFILE: home } }).status();

  assert.equal(deleted.ok, true);
  assert.equal(deleted.deletedFrom, "global");
  assert.deepEqual(deleted.gatewayProfiles, []);
  assert.deepEqual(refreshed.gatewayProfiles, []);
  assert.deepEqual(restarted.gatewayProfiles, []);
  assert.deepEqual(newProject.gatewayProfiles, []);
  assert.equal(restarted.gatewayConfig.gatewayProtocol, "openai-chat");
  await assert.rejects(fs.access(path.join(cwd, ".lab-agent", "config.json")), /ENOENT/);
  const global = JSON.parse(await fs.readFile(path.join(home, ".ant-code", "lab-agent.config.json"), "utf8"));
  assert.deepEqual(global.lab.gatewayProfiles, []);
});

test("dashboard deletes a global gateway without creating or deleting a project copy", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-delete-copied-global-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-home-delete-copied-global-"));
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: home } });
  const globalSaved = await runtime.saveModelConfig({
    saveTarget: "global",
    gatewayUrl: "https://global-a.gateway.example/v1/chat/completions",
    gatewayProtocol: "openai-chat",
    gatewayApiKey: "global-a-key",
    modelId: "global-a-model",
    switchToModel: true
  });
  const projectSaved = await runtime.saveModelConfig({
    saveTarget: "project",
    gatewayUrl: "https://project-b.gateway.example/v1/chat/completions",
    gatewayProtocol: "openai-chat",
    gatewayApiKey: "project-b-key",
    modelId: "project-b-model",
    switchToModel: true
  });

  assert.deepEqual(projectSaved.gatewayProfiles.map((profile) => profile.gatewayUrl), [
    "https://global-a.gateway.example/v1/chat/completions",
    "https://project-b.gateway.example/v1/chat/completions"
  ]);

  const deleted = await runtime.deleteGatewayProfile({ profileId: globalSaved.gatewayConfig.activeProfileId });
  const refreshed = await runtime.status();
  const restarted = await createDashboardRuntime({ cwd, env: { USERPROFILE: home } }).status();

  assert.equal(deleted.ok, true);
  assert.equal(deleted.deletedFrom, "global");
  assert.deepEqual(deleted.deletedFromScopes, ["global"]);
  assert.equal(deleted.clearedGateway, false);
  assert.deepEqual(deleted.gatewayProfiles.map((profile) => profile.gatewayUrl), [
    "https://project-b.gateway.example/v1/chat/completions"
  ]);
  assert.deepEqual(refreshed.gatewayProfiles, deleted.gatewayProfiles);
  assert.deepEqual(restarted.gatewayProfiles, deleted.gatewayProfiles);
  assert.equal(restarted.gatewayConfig.gatewayUrl, "https://project-b.gateway.example/v1/chat/completions");

  const local = JSON.parse(await fs.readFile(path.join(cwd, ".lab-agent", "config.json"), "utf8"));
  const global = JSON.parse(await fs.readFile(path.join(home, ".ant-code", "lab-agent.config.json"), "utf8"));
  assert.deepEqual(local.lab.gatewayProfiles.map((profile) => profile.gatewayUrl), [
    "https://project-b.gateway.example/v1/chat/completions"
  ]);
  assert.deepEqual(global.lab.gatewayProfiles, []);
});

test("dashboard runtime replaces the edited model id instead of keeping the stale entry", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-"));
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: cwd } });

  await runtime.saveModelConfig({
    saveTarget: "project",
    gatewayUrl: "https://mimo.example/v1/chat/completions",
    gatewayProtocol: "openai-chat",
    gatewayApiKey: "mimo-key",
    modelId: "wrong-model",
    label: "Wrong Model",
    modalities: ["text", "image"],
    visionAgentModel: "wrong-model",
    agentDefaultModel: "wrong-model",
    switchToModel: true,
    applyAgentDefaults: true
  });

  const saved = await runtime.saveModelConfig({
    saveTarget: "project",
    gatewayUrl: "https://mimo.example/v1/chat/completions",
    gatewayProtocol: "openai-chat",
    previousModelId: "wrong-model",
    modelId: "mimo-correct",
    label: "Mimo Correct",
    modalities: ["text", "image"],
    visionAgentModel: "mimo-correct",
    agentDefaultModel: "mimo-correct",
    switchToModel: true
  });

  assert.equal(saved.ok, true);
  assert.deepEqual(saved.models.map((model) => model.id), ["mimo-correct"]);
  assert.equal(saved.sessionStatus.model, "mimo-correct");

  const local = JSON.parse(await fs.readFile(path.join(cwd, ".lab-agent", "config.json"), "utf8"));
  assert.deepEqual(local.models.map((model) => model.id), ["mimo-correct"]);
  assert.equal(local.modelAlias, "mimo-correct");
  assert.equal(local.agents.modelTiers.default, "mimo-correct");
  assert.equal(local.agents.vision.model, "mimo-correct");
  assert.equal(local.lab.gatewayProfiles.find((profile) => profile.id === local.lab.activeGatewayProfile)?.models[0]?.id, "mimo-correct");
});

test("dashboard runtime accumulates per-turn change counters", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-"));
  const server = await listen(createWriteGateway(), "127.0.0.1", 0);
  const runtime = createDashboardRuntime({ cwd, env: mockGatewayEnv(server) });

  try {
    await runtime.trustWorkspace();
    const started = await runtime.startTurn({
      prompt: "write file",
      permissionMode: "workspace"
    });

    const events = await waitForEvent(runtime, started.sessionId, (event) => event.type === "files_updated");
    const finish = events.find((event) => event.type === "activity" && event.toolName === "write_file" && event.status === "completed");
    assert.deepEqual(finish?.changeStats, {
      path: "created.md",
      additions: 2,
      deletions: 0,
      files: 1,
      redacted: false,
      truncated: false,
      approximate: false
    });
    assert.deepEqual(finish?.turnChangeStats, {
      additions: 2,
      deletions: 0,
      files: 1,
      redacted: false,
      truncated: false,
      approximate: false
    });
    assert.deepEqual(events.find((event) => event.type === "files_updated")?.changeStats, finish.turnChangeStats);
  } finally {
    await close(server);
  }
});

test("dashboard runtime reports net per-turn change counters for repeated edits", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-"));
  await fs.writeFile(path.join(cwd, "notes.md"), "alpha\nbeta\ngamma\n", "utf8");
  const server = await listen(createRepeatedEditGateway(), "127.0.0.1", 0);
  const runtime = createDashboardRuntime({ cwd, env: mockGatewayEnv(server) });

  try {
    await runtime.trustWorkspace();
    const started = await runtime.startTurn({
      prompt: "edit same file twice",
      permissionMode: "workspace"
    });

    const events = await waitForEvent(runtime, started.sessionId, (event) => event.type === "files_updated");
    const finishes = events.filter((event) => event.type === "activity" && event.toolName === "edit_file" && event.status === "completed");
    assert.equal(finishes.length, 2);
    assert.deepEqual(finishes.map((event) => event.changeStats), [
      {
        path: "notes.md",
        additions: 1,
        deletions: 1,
        files: 1,
        redacted: false,
        truncated: false,
        approximate: false
      },
      {
        path: "notes.md",
        additions: 1,
        deletions: 1,
        files: 1,
        redacted: false,
        truncated: false,
        approximate: false
      }
    ]);
    assert.deepEqual(finishes.at(-1)?.turnChangeStats, {
      additions: 2,
      deletions: 2,
      files: 1,
      redacted: false,
      truncated: false,
      approximate: false
    });
    assert.deepEqual(events.find((event) => event.type === "files_updated")?.changeStats, finishes.at(-1)?.turnChangeStats);
  } finally {
    await close(server);
  }
});

test("dashboard runtime returns collected files when reopening a saved session", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-"));
  await fs.writeFile(path.join(cwd, "chart.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const server = await listen(createGateway("请查看 chart.png"), "127.0.0.1", 0);
  const runtime = createDashboardRuntime({ cwd, env: mockGatewayEnv(server) });

  try {
    await runtime.trustWorkspace();
    const started = await runtime.startTurn({
      prompt: "image reference",
      permissionMode: "plan"
    });
    await waitForEvent(runtime, started.sessionId, (event) => event.type === "files_updated");

    const reopened = await runtime.readSession(started.sessionId);

    assert.equal(reopened.ok, true);
    assert.equal(reopened.session.cwd, cwd);
    assert.equal(reopened.session.files.some((file) => file.relativePath === "chart.png" && file.kind === "image"), true);
  } finally {
    await close(server);
  }
});

test("dashboard runtime sends WebUI client surface in model context", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-"));
  const requests = [];
  const server = await listen(createRecordingGateway(requests, "dashboard surface answer"), "127.0.0.1", 0);
  const runtime = createDashboardRuntime({ cwd, env: mockGatewayEnv(server) });

  try {
    await runtime.trustWorkspace();
    const started = await runtime.startTurn({
      prompt: "check dashboard surface",
      permissionMode: "plan"
    });
    assert.equal(started.ok, true);
    await waitForEvent(runtime, started.sessionId, (event) => event.type === "files_updated");

    const systemText = requests[0]?.messages?.[0]?.content?.[0]?.text ?? "";
    assert.match(systemText, /Client surface: dashboard WebUI/);
    assert.match(systemText, /not the terminal TUI/);
    assert.doesNotMatch(systemText, /TUI sidebar/);
    assert.doesNotMatch(systemText, /The TUI will automatically continue/);

    const metadata = JSON.parse(await fs.readFile(path.join(cwd, ".lab-agent", "sessions", `${started.sessionId}.json`), "utf8"));
    assert.equal(metadata.clientSurface, "dashboard");
  } finally {
    await close(server);
  }
});

test("dashboard runtime sends image attachments while persisting only metadata", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-"));
  await fs.writeFile(path.join(cwd, "lab-agent.config.json"), JSON.stringify({
    modelAlias: "vision-model",
    models: [{ id: "vision-model", modalities: ["text", "image"] }]
  }), "utf8");
  const requests = [];
  const server = await listen(createRecordingGateway(requests, "image answer"), "127.0.0.1", 0);
  const runtime = createDashboardRuntime({ cwd, env: mockGatewayEnv(server) });

  try {
    await runtime.trustWorkspace();
    const started = await runtime.startTurn({
      prompt: "describe attached image",
      attachments: [{
        type: "image",
        name: "tiny.png",
        mimeType: "image/png",
        size: 5,
        data: "iVBORw0KGgo="
      }],
      permissionMode: "plan"
    });
    assert.equal(started.ok, true);

    const events = await waitForEvent(runtime, started.sessionId, (event) => event.type === "files_updated");
    const userEvent = events.find((event) => event.type === "user_message");
    assert.equal(userEvent?.attachments?.[0]?.name, "tiny.png");
    assert.equal(userEvent?.attachments?.[0]?.data, undefined);

    const userMessage = requests[0]?.messages?.find((message) => message.role === "user");
    assert.equal(userMessage.content.some((block) => block.type === "image" && block.data === "iVBORw0KGgo="), true);

    const metadata = JSON.parse(await fs.readFile(path.join(cwd, ".lab-agent", "sessions", `${started.sessionId}.json`), "utf8"));
    const persisted = JSON.stringify(metadata);
    assert.equal(persisted.includes("iVBORw0KGgo="), false);
    assert.equal(metadata.transcript.messages[0].content.some((block) => block.type === "image" && block.redacted === true), true);
    assert.equal(metadata.transcript.contextMessages[0].content.some((block) => block.name === "tiny.png" && block.data === undefined), true);
  } finally {
    await close(server);
  }
});

test("dashboard runtime requires workspace trust before running a turn", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-"));
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: cwd } });
  const blocked = await runtime.startTurn({ prompt: "first", permissionMode: "plan" });

  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, 403);
  assert.equal(blocked.trust.trusted, false);
});

test("dashboard runtime queues concurrent turns in same session", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-"));
  const server = await listen(createDelayedGateway(["first answer", "second answer"], 80), "127.0.0.1", 0);
  const runtime = createDashboardRuntime({ cwd, env: mockGatewayEnv(server) });
  await runtime.trustWorkspace();

  try {
  const first = await runtime.startTurn({ prompt: "first", permissionMode: "plan" });
  const second = await runtime.startTurn({ prompt: "second", sessionId: first.sessionId, permissionMode: "plan" });

  assert.equal(first.ok, true);
    assert.equal(first.running, true);
    assert.equal(first.current.preview, "first");
    assert.equal(second.ok, true);
    assert.equal(second.queued, true);
    assert.equal(second.queueLength, 1);

    const events = await waitForEvent(runtime, first.sessionId, () =>
      runtime.listActiveEvents(first.sessionId).filter((event) => event.type === "files_updated").length >= 2
    );
    assert.deepEqual(events.filter((event) => event.type === "user_message").map((event) => event.text), ["first", "second"]);
    assert.match(events.filter((event) => event.type === "assistant_final").map((event) => event.text).join("\n"), /first answer/);
    assert.match(events.filter((event) => event.type === "assistant_final").map((event) => event.text).join("\n"), /second answer/);
  } finally {
    await close(server);
  }
});

test("dashboard runtime rejects ordinary and guide prompts when the queue is full", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-"));
  const server = await listen(createHangingStreamGateway(), "127.0.0.1", 0);
  const runtime = createDashboardRuntime({
    cwd,
    env: mockGatewayEnv(server, {
      ANT_CODE_INTERRUPT_FORCE_SETTLE_MS: "50",
      LAB_MODEL_GATEWAY_TIMEOUT_MS: "600000"
    })
  });
  await runtime.trustWorkspace();

  try {
    const started = await runtime.startTurn({ prompt: "keep running", permissionMode: "plan" });
    await waitForEvent(runtime, started.sessionId, (event) => event.type === "activity" && event.rawType === "gateway_request_start");

    for (let index = 0; index < 20; index += 1) {
      const queued = await runtime.startTurn({
        prompt: `queued ${index + 1}`,
        sessionId: started.sessionId,
        permissionMode: "plan"
      });
      assert.equal(queued.ok, true);
      assert.equal(queued.queued, true);
    }

    const before = runtime.active.get(started.sessionId).queuedPrompts.map((item) => item.id);
    const overflow = await runtime.startTurn({
      prompt: "ordinary overflow",
      sessionId: started.sessionId,
      permissionMode: "plan"
    });
    assert.equal(overflow.ok, false);
    assert.equal(overflow.status, 429);
    assert.equal(overflow.code, "QUEUE_FULL");
    assert.equal(overflow.queueLength, 20);

    const guideOverflow = runtime.guideTurn({
      sessionId: started.sessionId,
      guidance: "guide overflow",
      permissionMode: "workspace"
    });
    assert.equal(guideOverflow.ok, false);
    assert.equal(guideOverflow.status, 429);
    assert.equal(guideOverflow.code, "QUEUE_FULL");
    assert.deepEqual(runtime.active.get(started.sessionId).queuedPrompts.map((item) => item.id), before);
    assert.equal(runtime.listActiveEvents(started.sessionId).some((event) => event.type === "guide_queued"), false);

    for (const queueItemId of before) {
      assert.equal(runtime.cancelQueuedTurn({ sessionId: started.sessionId, queueItemId }).ok, true);
    }
    runtime.interruptTurn(started.sessionId, "test-cleanup");
    await waitForEvent(runtime, started.sessionId, (event) => event.type === "run_state" && event.running === false);
  } finally {
    await close(server);
  }
});

test("dashboard runtime keeps queued permissions isolated until that turn begins", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-"));
  const server = await listen(createDelayedGateway(["first answer", "second answer"], 80), "127.0.0.1", 0);
  const runtime = createDashboardRuntime({ cwd, env: mockGatewayEnv(server) });
  await runtime.trustWorkspace();

  try {
    const first = await runtime.startTurn({ prompt: "first", permissionMode: "plan" });
    const second = await runtime.startTurn({
      prompt: "second",
      sessionId: first.sessionId,
      permissionMode: "fullAccess"
    });

    assert.equal(second.queued, true);
    assert.equal(second.queue[0].permissionMode, "fullAccess");
    assert.equal(runtime.active.get(first.sessionId).session.permissionMode, "plan");
    assert.equal((await runtime.readSession(first.sessionId)).session.permission.mode, "plan");

    await waitForEvent(runtime, first.sessionId, () =>
      runtime.listActiveEvents(first.sessionId).filter((event) => event.type === "files_updated").length >= 2
    );
    assert.equal(runtime.active.get(first.sessionId).session.permissionMode, "fullAccess");
    assert.equal((await runtime.readSession(first.sessionId)).session.permission.mode, "fullAccess");
  } finally {
    await close(server);
  }
});

test("dashboard runtime coalesces repeated live status events", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-"));
  const server = await listen(createGateway("status answer", {
    thinkingChunks: ["one ", "two ", "three "]
  }), "127.0.0.1", 0);
  try {
    const runtime = createDashboardRuntime({
      cwd,
      env: mockGatewayEnv(server)
    });
    await runtime.trustWorkspace();
    const result = await runtime.startTurn({
      prompt: "coalesce live status",
      permissionMode: "workspace"
    });
    await waitForEvent(runtime, result.sessionId, (event) => event.type === "activity" && event.coalesceKey === "thinking");

    const events = runtime.listActiveEvents(result.sessionId);
    assert.equal(events.filter((event) => event.type === "activity" && event.coalesceKey === "thinking").length, 1);
    assert.equal(events.filter((event) => event.type === "activity" && event.coalesceKey === "assistant-stream").length, 1);
    assert.deepEqual(events.map((event) => event.sequence), events.map((event) => event.sequence).toSorted((a, b) => a - b));
    assert.equal(new Set(events.map((event) => event.sequence)).size, events.length);
  } finally {
    await close(server);
  }
});

test("dashboard runtime reports gateway terminal failures instead of completed", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-"));
  const server = await listen(createFailingGateway(), "127.0.0.1", 0);
  const runtime = createDashboardRuntime({ cwd, env: mockGatewayEnv(server) });
  await runtime.trustWorkspace();

  try {
    const started = await runtime.startTurn({ prompt: "fail this turn", permissionMode: "plan" });
    await waitForEvent(runtime, started.sessionId, (event) => event.type === "run_state" && event.running === false);

    assert.equal(runtime.active.get(started.sessionId).status, "failed");
    const records = await runtime.listSessionRecords();
    assert.equal(records.find((record) => record.id === started.sessionId)?.status, "failed");
  } finally {
    await close(server);
  }
});

test("dashboard runtime reports tool-limit terminal outcomes instead of completed", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-"));
  await fs.writeFile(path.join(cwd, "notes.txt"), "tool loop fixture\n", "utf8");
  const server = await listen(createRepeatedReadGateway(), "127.0.0.1", 0);
  const runtime = createDashboardRuntime({
    cwd,
    env: mockGatewayEnv(server, { LAB_AGENT_MAX_TOOL_ROUNDS: "2" })
  });
  await runtime.trustWorkspace();

  try {
    const started = await runtime.startTurn({ prompt: "loop until the tool limit", permissionMode: "workspace" });
    await waitForEvent(runtime, started.sessionId, (event) => event.type === "run_state" && event.running === false);

    assert.equal(runtime.active.get(started.sessionId).status, "blocked");
    assert.equal(runtime.listActiveEvents(started.sessionId).some((event) => event.terminalStatus === "tool_limit"), true);
  } finally {
    await close(server);
  }
});

test("dashboard runtime emits assistant draft events while streaming visible text", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-"));
  const server = await listen(createGateway("streamed dashboard answer", {
    thinkingChunks: ["secret reasoning"],
    textChunks: ["streamed ", "dashboard ", "answer"]
  }), "127.0.0.1", 0);
  try {
    const runtime = createDashboardRuntime({
      cwd,
      env: mockGatewayEnv(server)
    });
    await runtime.trustWorkspace();
    const result = await runtime.startTurn({
      prompt: "stream draft",
      permissionMode: "workspace"
    });
    await waitForEvent(runtime, result.sessionId, (event) => event.type === "files_updated");

    const drafts = runtime.listActiveEvents(result.sessionId).filter((event) => event.type === "assistant_draft");
    assert.equal(drafts.map((event) => event.text).join(""), "streamed dashboard answer");
    assert.equal(runtime.listActiveEvents(result.sessionId).some((event) => /secret reasoning/.test(JSON.stringify(event))), false);
  } finally {
    await close(server);
  }
});

test("dashboard runtime replays active events after the requested sequence only", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-"));
  const server = await listen(createGateway("streamed dashboard answer", {
    textChunks: ["streamed ", "dashboard ", "answer"]
  }), "127.0.0.1", 0);
  try {
    const runtime = createDashboardRuntime({
      cwd,
      env: mockGatewayEnv(server)
    });
    await runtime.trustWorkspace();
    const result = await runtime.startTurn({
      prompt: "stream draft",
      permissionMode: "workspace"
    });
    const cursor = result.eventCursor;
    await waitForEvent(runtime, result.sessionId, (event) => event.type === "files_updated");

    const replayed = [];
    const unsubscribe = runtime.subscribe(result.sessionId, (event) => replayed.push(event), {
      afterSequence: cursor
    });
    unsubscribe?.();

    assert.deepEqual(replayed.filter((event) => event.type === "user_message").map((event) => event.text), ["stream draft"]);
    assert.equal(replayed.some((event) => event.type === "assistant_draft"), true);
    assert.equal(replayed.every((event) => event.sequence > cursor), true);
    assert.equal(new Set(replayed.map((event) => event.turnId).filter(Boolean)).size, 1);
  } finally {
    await close(server);
  }
});

test("dashboard runtime exposes running active sessions for refresh recovery", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-"));
  const server = await listen(createHangingStreamGateway(), "127.0.0.1", 0);
  try {
    const runtime = createDashboardRuntime({
      cwd,
      env: mockGatewayEnv(server)
    });
    await runtime.trustWorkspace();
    const started = await runtime.startTurn({
      prompt: "recover streaming draft",
      permissionMode: "workspace"
    });
    await waitForEvent(runtime, started.sessionId, (event) => event.type === "assistant_draft");

    const records = await runtime.listSessionRecords();
    const active = records.find((record) => record.id === started.sessionId);
    const reopened = await runtime.readSession(started.sessionId);
    const replayed = [];
    const unsubscribe = runtime.subscribe(started.sessionId, (event) => replayed.push(event), {
      afterSequence: reopened.session.eventCursor
    });
    unsubscribe?.();

    assert.equal(active.running, true);
    assert.equal(reopened.session.active, true);
    assert.equal(reopened.session.running, true);
    assert.equal(reopened.session.eventCursor, 0);
    assert.deepEqual(replayed.filter((event) => event.type === "user_message").map((event) => event.text), ["recover streaming draft"]);
    assert.equal(replayed.some((event) => event.type === "assistant_draft" && /partial draft/.test(event.text)), true);
    runtime.interruptTurn(started.sessionId, cleanupAbortError());
    await waitForEvent(runtime, started.sessionId, (event) => event.type === "run_state" && event.running === false);
  } finally {
    await close(server);
  }
});

test("dashboard runtime omits the active turn transcript during refresh recovery", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-"));
  const server = await listen(createGateway("stable answer"), "127.0.0.1", 0);
  try {
    const runtime = createDashboardRuntime({
      cwd,
      env: mockGatewayEnv(server)
    });
    await runtime.trustWorkspace();
    const started = await runtime.startTurn({
      prompt: "refresh during final",
      permissionMode: "workspace"
    });
    await waitForEvent(runtime, started.sessionId, (event) => event.type === "assistant_final");

    const reopened = await runtime.readSession(started.sessionId);
    const replayed = [];
    const unsubscribe = runtime.subscribe(started.sessionId, (event) => replayed.push(event), {
      afterSequence: reopened.session.eventCursor
    });
    unsubscribe?.();

    assert.equal(reopened.session.active, true);
    assert.equal(reopened.session.running, true);
    assert.deepEqual(reopened.session.transcript, []);
    assert.equal(reopened.session.eventCursor, 0);
    assert.deepEqual(replayed.filter((event) => event.type === "user_message").map((event) => event.text), ["refresh during final"]);
    assert.match(replayed.find((event) => event.type === "assistant_final")?.text ?? "", /stable answer/);
    await waitForEvent(runtime, started.sessionId, (event) => event.type === "run_state" && event.running === false);
  } finally {
    await close(server);
  }
});

test("dashboard runtime emits workflow snapshots for visible progress", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-"));
  const server = await listen(createTodoGateway(), "127.0.0.1", 0);
  const runtime = createDashboardRuntime({ cwd, env: mockGatewayEnv(server) });

  try {
    await runtime.trustWorkspace();
    const started = await runtime.startTurn({
      prompt: "show todo progress",
      permissionMode: "workspace"
    });
    assert.equal(started.ok, true);

    await waitForEvent(runtime, started.sessionId, (event) => event.type === "files_updated");
    const snapshots = runtime.listActiveEvents(started.sessionId).filter((event) => event.type === "workflow_snapshot");

    assert.equal(snapshots.length >= 2, true);
    assert.deepEqual(snapshots[0].workflow.todos.map((item) => item.status), ["in_progress", "pending"]);
    assert.deepEqual(snapshots.at(-1).workflow.todos.map((item) => item.status), ["completed", "completed"]);
    assert.equal(snapshots.at(-1).summary.completed, 2);
  } finally {
    await close(server);
  }
});
