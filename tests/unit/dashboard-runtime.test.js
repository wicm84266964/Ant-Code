import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAgentTaskGroupStore } from "../../src/agents/task-group-store.js";
import { createAgentTaskStore } from "../../src/agents/task-store.js";
import { registerBackgroundTerminalTask } from "../../src/agents/background-terminal-registry.js";
import { createDashboardRuntime } from "../../src/dashboard/sessions.js";
import { createSessionStore } from "../../src/storage/session-store.js";

test("dashboard runtime runs a turn and writes shared session metadata", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-"));
  const server = await listen(createGateway("dashboard answer"), "127.0.0.1", 0);
  const runtime = createDashboardRuntime({ cwd, env: mockGatewayEnv(server) });

  try {
    await runtime.trustWorkspace();
    const started = await runtime.startTurn({
      prompt: "hello dashboard",
      permissionMode: "plan"
    });
    assert.equal(started.ok, true);

    const events = await waitForEvent(runtime, started.sessionId, (event) => event.type === "files_updated");
    assert.match(events.find((event) => event.type === "assistant_final")?.text ?? "", /dashboard answer/);

    const records = await runtime.listSessionRecords();
    assert.equal(records.length, 1);
    assert.equal(records[0].id, started.sessionId);
    assert.equal(records[0].title, "hello dashboard");
  } finally {
    await close(server);
  }
});

test("dashboard runtime force-releases a turn when an interrupted gateway request hangs", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-"));
  const server = await listen(createHangingGateway(), "127.0.0.1", 0);
  const runtime = createDashboardRuntime({
    cwd,
    env: mockGatewayEnv(server, {
      ANT_CODE_INTERRUPT_FORCE_SETTLE_MS: "50",
      LAB_MODEL_GATEWAY_TIMEOUT_MS: "600000"
    })
  });

  try {
    await runtime.trustWorkspace();
    const started = await runtime.startTurn({
      prompt: "hang then interrupt",
      permissionMode: "plan"
    });
    assert.equal(started.ok, true);
    await waitForEvent(runtime, started.sessionId, (event) => event.type === "activity" && event.rawType === "gateway_request_start");

    const interrupted = runtime.interruptTurn(started.sessionId, "user");
    assert.equal(interrupted.ok, true);
    const events = await waitForEvent(runtime, started.sessionId, (event) => event.type === "run_state" && event.running === false);
    assert.equal(runtime.active.get(started.sessionId).running, false);
    assert.equal(events.some((event) => event.type === "activity" && event.rawType === "turn_interrupted"), true);
  } finally {
    await close(server);
  }
});

test("dashboard runtime deduplicates concurrent turn request ids", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-idempotent-"));
  const gate = deferred();
  let calls = 0;
  const runtime = createDashboardRuntime({
    cwd,
    env: {},
    runTurn: async (_session, options) => {
      calls += 1;
      await gate.promise;
      await options.onEvent({ type: "turn_complete", status: "completed" });
      return { output: "deduplicated" };
    }
  });
  await runtime.trustWorkspace();

  const input = {
    requestId: "turn-request-same",
    prompt: "run once",
    permissionMode: "plan"
  };
  const [first, duplicate] = await Promise.all([
    runtime.startTurn(input),
    runtime.startTurn({ ...input })
  ]);

  assert.deepEqual(duplicate, first);
  assert.equal(first.requestId, input.requestId);
  assert.equal(runtime.active.size, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);

  const conflict = await runtime.startTurn({ ...input, prompt: "different payload" });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.code, "REQUEST_ID_CONFLICT");

  gate.resolve();
  await waitForEvent(runtime, first.sessionId, (event) => event.type === "run_state" && event.running === false);
});

test("dashboard runtime quarantines an interrupt that does not settle and never overlaps the next turn", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-quarantine-"));
  const gate = deferred();
  let calls = 0;
  const runtime = createDashboardRuntime({
    cwd,
    env: { ANT_CODE_INTERRUPT_FORCE_SETTLE_MS: "50" },
    runTurn: async (_session, options) => {
      calls += 1;
      await gate.promise;
      await options.onEvent({ type: "assistant_stream_delta", delta: "late output" });
      await options.onEvent({ type: "turn_complete", status: "completed" });
      return { output: "late output" };
    }
  });
  await runtime.trustWorkspace();

  const first = await runtime.startTurn({ prompt: "ignore abort", permissionMode: "plan" });
  const second = await runtime.startTurn({
    sessionId: first.sessionId,
    prompt: "must not overlap",
    permissionMode: "plan"
  });
  assert.equal(second.queued, true);
  assert.equal(runtime.interruptTurn(first.sessionId, "test").ok, true);

  const quarantinedEvents = await waitForEvent(runtime, first.sessionId, (event) => (
    event.type === "run_state" && event.quarantined === true
  ));
  const state = runtime.active.get(first.sessionId);
  assert.equal(state.running, true);
  assert.equal(state.status, "quarantined");
  assert.equal(state.queuedPrompts.length, 1);
  assert.equal(calls, 1);
  assert.equal(quarantinedEvents.some((event) => event.type === "error" && event.quarantined === true), true);

  const rejected = await runtime.startTurn({
    sessionId: first.sessionId,
    prompt: "still must not overlap",
    permissionMode: "plan"
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, "SESSION_QUARANTINED");
  assert.equal(calls, 1);

  gate.resolve();
  const settledEvents = await waitForEvent(runtime, first.sessionId, (event) => event.type === "run_state" && event.quarantineReleased === true);
  assert.equal(runtime.active.get(first.sessionId).running, false);
  assert.equal(runtime.active.get(first.sessionId).queuedPrompts.length, 1);
  assert.equal(calls, 1);
  assert.equal(settledEvents.some((event) => event.type === "assistant_draft" && /late output/.test(event.text ?? "")), false);

  runtime.cancelQueuedTurn({ sessionId: first.sessionId, queueItemId: second.queue[0].id });
  assert.equal((await runtime.deleteSession({ sessionId: first.sessionId })).ok, true);
});

test("dashboard runtime rejects malformed and oversized turn attachments before creating a session", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-images-"));
  const runtime = createDashboardRuntime({ cwd, env: {} });
  const attachment = (data, mimeType = "image/png", size = 1) => ({
    type: "image",
    name: "image.bin",
    mimeType,
    size,
    data
  });

  const invalidBase64 = await runtime.startTurn({ prompt: "bad", attachments: [attachment("%%%=")] });
  assert.equal(invalidBase64.status, 400);
  assert.equal(invalidBase64.code, "INVALID_IMAGE_BASE64");

  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const mismatch = await runtime.startTurn({
    prompt: "bad mime",
    attachments: [attachment(pngSignature.toString("base64"), "image/jpeg")]
  });
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.code, "IMAGE_SIGNATURE_MISMATCH");

  const oversized = Buffer.alloc(8 * 1024 * 1024 + 1);
  pngSignature.copy(oversized);
  const singleTooLarge = await runtime.startTurn({
    prompt: "too large",
    attachments: [attachment(oversized.toString("base64"), "image/png", 1)]
  });
  assert.equal(singleTooLarge.status, 413);
  assert.equal(singleTooLarge.code, "IMAGE_TOO_LARGE");

  const totalImages = Array.from({ length: 4 }, (_, index) => {
    const bytes = Buffer.alloc(6 * 1024 * 1024 + 1, index);
    pngSignature.copy(bytes);
    return attachment(bytes.toString("base64"), "image/png", 1);
  });
  const totalTooLarge = await runtime.startTurn({ prompt: "too many bytes", attachments: totalImages });
  assert.equal(totalTooLarge.status, 413);
  assert.equal(totalTooLarge.code, "IMAGES_TOO_LARGE");

  const promptTooLarge = await runtime.startTurn({ prompt: "x".repeat(256 * 1024 + 1) });
  assert.equal(promptTooLarge.status, 413);
  assert.equal(promptTooLarge.code, "PROMPT_TOO_LARGE");
  assert.equal(runtime.active.size, 0);
});

test("dashboard runtime includes the active turn in the queued attachment budget", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-image-budget-"));
  const gate = deferred();
  const runtime = createDashboardRuntime({
    cwd,
    env: {},
    runTurn: async (_session, options) => {
      await gate.promise;
      await options.onEvent({ type: "turn_complete", status: "completed" });
      return { output: "done" };
    }
  });
  await runtime.trustWorkspace();
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const fullImage = () => {
    const bytes = Buffer.alloc(8 * 1024 * 1024);
    pngSignature.copy(bytes);
    return { type: "image", name: "full.png", mimeType: "image/png", size: 1, data: bytes.toString("base64") };
  };
  const started = await runtime.startTurn({
    prompt: "hold image budget",
    attachments: [fullImage(), fullImage(), fullImage()],
    permissionMode: "plan"
  });
  assert.equal(started.ok, true);
  assert.equal(runtime.active.get(started.sessionId).currentAttachmentBytes, 24 * 1024 * 1024);

  const overflow = await runtime.startTurn({
    sessionId: started.sessionId,
    prompt: "queue one more",
    attachments: [{
      type: "image",
      name: "tiny.png",
      mimeType: "image/png",
      size: 0,
      data: pngSignature.toString("base64")
    }],
    permissionMode: "plan"
  });
  assert.equal(overflow.ok, false);
  assert.equal(overflow.status, 413);
  assert.equal(overflow.code, "QUEUE_ATTACHMENT_BUDGET_EXCEEDED");
  assert.equal(runtime.active.get(started.sessionId).queuedPrompts.length, 0);

  gate.resolve();
  await waitForEvent(runtime, started.sessionId, (event) => event.type === "run_state" && event.running === false);
  assert.equal(runtime.active.get(started.sessionId).currentAttachmentBytes, 0);
});

test("dashboard runtime exposes model and context status", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-"));
  const server = await listen(createGateway("status answer"), "127.0.0.1", 0);
  const runtime = createDashboardRuntime({ cwd, env: mockGatewayEnv(server) });

  try {
    const initial = await runtime.status();
    assert.equal(initial.ok, true);
    assert.equal(typeof initial.sessionStatus.model, "string");
    assert.notEqual(initial.sessionStatus.model.length, 0);
    assert.ok(initial.models.some((model) => model.id === initial.sessionStatus.model && model.current === true));
    assert.ok(initial.sessionStatus.context.maxTokens > 0);

    await runtime.trustWorkspace();
    const started = await runtime.startTurn({
      prompt: "status please",
      permissionMode: "workspace"
    });
    assert.equal(started.sessionStatus.model, initial.sessionStatus.model);

    const events = await waitForEvent(runtime, started.sessionId, (event) => event.type === "files_updated");
    const final = events.find((event) => event.type === "files_updated")?.sessionStatus;
    assert.equal(final.model, initial.sessionStatus.model);
    assert.ok(final.context.messageTokens > 0);
    assert.equal(final.context.maxTokens, initial.sessionStatus.context.maxTokens);
  } finally {
    await close(server);
  }
});

test("dashboard runtime can switch registered model for the current session", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-"));
  await fs.writeFile(path.join(cwd, "lab-agent.config.json"), JSON.stringify({
    modelAlias: "code-model",
    models: [
      { id: "code-model", label: "Code Model", modalities: ["text"], contextTokens: 200000 },
      { id: "vision-model", label: "Vision Model", modalities: ["text", "image"], contextTokens: 128000 }
    ]
  }), "utf8");
  const requests = [];
  const server = await listen(createRecordingGateway(requests, "switched answer"), "127.0.0.1", 0);
  const runtime = createDashboardRuntime({ cwd, env: mockGatewayEnv(server) });

  try {
    await runtime.trustWorkspace();
    const initial = await runtime.status();
    assert.deepEqual(initial.models.map((model) => [model.id, model.modalities, model.current]), [
      ["code-model", ["text"], true],
      ["vision-model", ["text", "image"], false]
    ]);

    const switched = await runtime.switchModel({ modelId: "vision-model" });
    assert.equal(switched.ok, true);
    assert.equal(switched.sessionStatus.model, "vision-model");
    assert.equal(switched.models.find((model) => model.id === "vision-model").current, true);
    assert.equal(switched.models.find((model) => model.id === "vision-model").default, false);
    assert.equal(switched.models.find((model) => model.id === "code-model").default, true);

    const started = await runtime.startTurn({
      prompt: "use selected model",
      permissionMode: "plan"
    });
    await waitForEvent(runtime, started.sessionId, (event) => event.type === "files_updated");

    assert.equal(requests[0].model, "vision-model");
    assert.equal(started.sessionStatus.model, "vision-model");
    assert.equal(started.sessionStatus.context.modelMaxTokens, 128000);
  } finally {
    await close(server);
  }
});

test("dashboard runtime can apply model agent defaults when switching", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-"));
  await fs.writeFile(path.join(cwd, "lab-agent.config.json"), JSON.stringify({
    modelAlias: "code-model",
    models: [
      {
        id: "code-model",
        label: "Code Model",
        modalities: ["text"],
        contextTokens: 200000,
        agentModelTiers: {
          cheap: "code-flash",
          default: "code-flash",
          strong: "code-strong"
        }
      },
      {
        id: "vision-model",
        label: "Vision Model",
        modalities: ["text", "image"],
        contextTokens: 128000,
        agentModelTiers: {
          cheap: "vision-flash",
          default: "vision-default",
          strong: "vision-strong"
        }
      }
    ],
    agents: {
      modelTiers: {
        cheap: "code-flash",
        default: "code-flash",
        strong: "code-strong"
      }
    }
  }), "utf8");
  const runtime = createDashboardRuntime({ cwd, env: {} });

  const switched = await runtime.switchModel({ modelId: "vision-model", applyAgentDefaults: true });

  assert.equal(switched.ok, true);
  assert.equal(switched.sessionStatus.model, "vision-model");
  assert.deepEqual(switched.agentModelTiers, {
    cheap: "vision-flash",
    default: "vision-default",
    strong: "vision-strong",
    vision: "example-vision-model"
  });
  assert.deepEqual(switched.models.find((model) => model.id === "vision-model")?.agentModelTiers, {
    cheap: "vision-flash",
    default: "vision-default",
    strong: "vision-strong"
  });

  const local = JSON.parse(await fs.readFile(path.join(cwd, ".lab-agent", "config.json"), "utf8"));
  assert.deepEqual(local.agents.modelTiers, {
    cheap: "vision-flash",
    default: "vision-default",
    strong: "vision-strong",
    vision: "example-vision-model"
  });
});

test("dashboard runtime saves local model gateway config", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-"));
  const runtime = createDashboardRuntime({ cwd, env: {} });

  const saved = await runtime.saveModelConfig({
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

test("dashboard runtime saves model gateway config as user global default", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-home-"));
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: home } });

  const saved = await runtime.saveModelConfig({
    saveTarget: "global",
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
    modelAlias: "alpha-pro",
    models: [
      { id: "alpha-pro", label: "Alpha Pro", modalities: ["text"] },
      { id: "alpha-vision", label: "Alpha Vision", modalities: ["text", "image"] }
    ],
    lab: {
      gatewayUrl: "https://alpha-gateway.example/v1/chat/completions",
      gatewayProtocol: "openai-chat",
      gatewayApiKey: "alpha-key"
    },
    agents: {
      modelTiers: {
        cheap: "alpha-vision",
        default: "alpha-vision",
        strong: "alpha-vision",
        vision: "alpha-vision"
      },
      vision: {
        enabled: true,
        model: "alpha-vision",
        autoUseWhenMainModelTextOnly: true
      }
    }
  }), "utf8");
  const runtime = createDashboardRuntime({ cwd, env: {} });

  const saved = await runtime.saveModelConfig({
    gatewayUrl: "https://beta-gateway.example/v1/chat/completions",
    gatewayProtocol: "openai-chat",
    gatewayApiKey: "beta-key",
    modelId: "beta-chat",
    label: "Beta Chat",
    modalities: ["text"],
    switchToModel: true
  });

  assert.equal(saved.ok, true);
  assert.equal(saved.sessionStatus.model, "beta-chat");
  assert.deepEqual(saved.models.map((model) => model.id), ["beta-chat"]);
  assert.equal(saved.gatewayProfiles.length, 2);
  assert.equal(saved.gatewayProfiles.find((profile) => profile.gatewayUrl.includes("beta-gateway"))?.current, true);
  assert.equal(saved.gatewayProfiles.find((profile) => profile.gatewayUrl.includes("alpha-gateway"))?.modelCount, 2);

  const local = JSON.parse(await fs.readFile(path.join(cwd, ".lab-agent", "config.json"), "utf8"));
  assert.deepEqual(local.models.map((model) => model.id), ["beta-chat"]);
  assert.equal(local.agents.vision.enabled, false);
  assert.equal(local.agents.vision.model, null);
  assert.equal(local.agents.modelTiers.vision, undefined);

  const alphaProfile = saved.gatewayProfiles.find((profile) => profile.gatewayUrl.includes("alpha-gateway"));
  const switched = await runtime.switchGatewayProfile({ profileId: alphaProfile.id });

  assert.equal(switched.ok, true);
  assert.equal(switched.gatewayConfig.gatewayUrl, "https://alpha-gateway.example/v1/chat/completions");
  assert.deepEqual(switched.models.map((model) => model.id), ["alpha-pro", "alpha-vision"]);
  assert.equal(switched.sessionStatus.model, "alpha-pro");
  assert.deepEqual(switched.visionAgent, {
    enabled: true,
    model: "alpha-vision",
    autoUseWhenMainModelTextOnly: true
  });
});

test("dashboard model config ignores process gateway env overrides", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-"));
  const runtime = createDashboardRuntime({
    cwd,
    env: {
      LAB_MODEL_GATEWAY_URL: "https://env-gateway.example/v1/chat/completions",
      LAB_MODEL_GATEWAY_PROTOCOL: "openai-chat",
      LAB_MODEL_GATEWAY_API_KEY: "env-key",
      LAB_AGENT_MODEL: "env-model"
    }
  });

  const initial = await runtime.status();
  assert.equal(initial.gatewayConfig.gatewayUrl, "https://env-gateway.example/v1/chat/completions");
  assert.equal(initial.sessionStatus.model, "env-model");
  assert.ok(initial.models.some((model) => model.id === "env-model"));
  assert.equal(initial.models.find((model) => model.id === "env-model")?.sources.modelAlias.type, "environment");
  assert.equal(initial.models.find((model) => model.id === "env-model")?.default, true);
  assert.equal(initial.gatewayConfig.sources.gatewayUrl.type, "environment");
  assert.equal(initial.gatewayConfig.sources.apiKey.type, "environment");

  const saved = await runtime.saveModelConfig({
    gatewayUrl: "https://beta-gateway.example/v1/chat/completions",
    gatewayProtocol: "openai-chat",
    gatewayApiKey: "beta-key",
    modelId: "beta-chat",
    label: "Beta Chat",
    modalities: ["text"],
    switchToModel: true
  });

  assert.equal(saved.ok, true);
  assert.equal(saved.gatewayConfig.gatewayUrl, "https://beta-gateway.example/v1/chat/completions");
  assert.equal(saved.gatewayConfig.sources.gatewayUrl.type, "project");
  assert.equal(saved.gatewayConfig.sources.apiKey.type, "project");
  assert.deepEqual(saved.models.map((model) => model.id), ["beta-chat"]);
  assert.equal(saved.gatewayProfiles.find((profile) => profile.gatewayUrl.includes("beta-gateway"))?.current, true);

  const after = await runtime.status();
  assert.equal(after.gatewayConfig.gatewayUrl, "https://beta-gateway.example/v1/chat/completions");
  assert.deepEqual(after.models.map((model) => model.id), ["beta-chat"]);
  assert.equal(after.gatewayConfig.sources.gatewayUrl.type, "project");
  assert.equal(after.gatewayConfig.sources.apiKey.type, "project");
});

test("dashboard runtime keeps environment key visible as fallback after project model config without local key", async () => {
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
    gatewayUrl: "https://project.gateway.example/v1/chat/completions",
    gatewayProtocol: "openai-chat",
    modelId: "project-model",
    label: "Project Model",
    modalities: ["text"],
    switchToModel: true
  });

  assert.equal(saved.ok, true);
  assert.equal(saved.gatewayConfig.gatewayUrl, "https://project.gateway.example/v1/chat/completions");
  assert.equal(saved.gatewayConfig.apiKeyConfigured, true);
  assert.equal(saved.gatewayConfig.sources.gatewayUrl.type, "project");
  assert.equal(saved.gatewayConfig.sources.apiKey.type, "environment");

  const local = JSON.parse(await fs.readFile(path.join(cwd, ".lab-agent", "config.json"), "utf8"));
  assert.equal(local.lab.gatewayApiKey, undefined);
});

test("dashboard runtime adds models to the active gateway when the same key is submitted again", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-"));
  const runtime = createDashboardRuntime({ cwd, env: {} });

  await runtime.saveModelConfig({
    gatewayUrl: "https://beta-gateway.example/v1/chat/completions",
    gatewayProtocol: "openai-chat",
    gatewayApiKey: "beta-key",
    modelId: "beta-chat",
    label: "Beta Chat",
    modalities: ["text"],
    switchToModel: true
  });
  const saved = await runtime.saveModelConfig({
    gatewayUrl: "https://beta-gateway.example/v1/chat/completions",
    gatewayProtocol: "openai-chat",
    gatewayApiKey: "beta-key",
    modelId: "beta-reasoner",
    label: "Beta Reasoner",
    modalities: ["text"],
    switchToModel: true
  });

  assert.equal(saved.ok, true);
  assert.deepEqual(saved.models.map((model) => model.id), ["beta-chat", "beta-reasoner"]);
  assert.equal(saved.gatewayProfiles.find((profile) => profile.current)?.modelCount, 2);
  assert.ok(saved.gatewayProfiles.find((profile) => profile.gatewayUrl.includes("beta-gateway")));

  const local = JSON.parse(await fs.readFile(path.join(cwd, ".lab-agent", "config.json"), "utf8"));
  assert.deepEqual(local.models.map((model) => model.id), ["beta-chat", "beta-reasoner"]);
  assert.equal(local.lab.gatewayApiKey, "beta-key");
});

test("dashboard runtime preserves concurrent model config updates through atomic mutations", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-config-"));
  const runtime = createDashboardRuntime({ cwd, env: {} });

  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => runtime.saveModelConfig({
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
  const savedModels = new Set(local.models.map((model) => model.id));
  for (let index = 0; index < 8; index += 1) {
    assert.equal(savedModels.has(`concurrent-model-${index}`), true);
  }
});

test("dashboard runtime deletes a registered model from the active gateway", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-"));
  const runtime = createDashboardRuntime({ cwd, env: {} });

  await runtime.saveModelConfig({
    gatewayUrl: "https://alpha-gateway.example/v1/chat/completions",
    gatewayProtocol: "openai-chat",
    gatewayApiKey: "alpha-key",
    modelId: "alpha-pro",
    label: "Alpha Pro",
    modalities: ["text"],
    switchToModel: true
  });
  await runtime.saveModelConfig({
    gatewayUrl: "https://alpha-gateway.example/v1/chat/completions",
    gatewayProtocol: "openai-chat",
    modelId: "alpha-vision",
    label: "Alpha Vision",
    modalities: ["text", "image"],
    visionAgentModel: "alpha-vision",
    switchToModel: true
  });

  const deleted = await runtime.deleteModelConfig({ modelId: "alpha-vision" });

  assert.equal(deleted.ok, true);
  assert.equal(deleted.deletedModel, "alpha-vision");
  assert.deepEqual(deleted.models.map((model) => [model.id, model.current]), [["alpha-pro", true]]);
  assert.deepEqual(deleted.visionAgent, {
    enabled: false,
    model: "",
    autoUseWhenMainModelTextOnly: true
  });
  assert.equal(deleted.gatewayProfiles.find((profile) => profile.current)?.modelCount, 1);

  const local = JSON.parse(await fs.readFile(path.join(cwd, ".lab-agent", "config.json"), "utf8"));
  assert.equal(local.modelAlias, "alpha-pro");
  assert.deepEqual(local.models.map((model) => model.id), ["alpha-pro"]);
  assert.equal(local.agents.vision.enabled, false);
  assert.equal(local.agents.vision.model, null);
  assert.equal(local.agents.modelTiers?.vision, undefined);
  assert.equal(local.lab.gatewayProfiles.find((profile) => profile.current || profile.id === local.lab.activeGatewayProfile)?.models.length, 1);
});

test("dashboard runtime clears the active gateway when deleting its final model", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-"));
  const runtime = createDashboardRuntime({ cwd, env: {} });

  await runtime.saveModelConfig({
    gatewayUrl: "https://beta-gateway.example/v1/chat/completions",
    gatewayProtocol: "openai-chat",
    gatewayApiKey: "beta-key",
    modelId: "beta-chat",
    label: "Beta Chat",
    modalities: ["text"],
    switchToModel: true
  });

  const deleted = await runtime.deleteModelConfig({ modelId: "beta-chat" });

  assert.equal(deleted.ok, true);
  assert.equal(deleted.deletedModel, "beta-chat");
  assert.equal(deleted.clearedGateway, true);
  assert.equal(deleted.gatewayConfig.gatewayUrl, "");
  assert.equal(deleted.gatewayConfig.apiKeyConfigured, false);
  assert.deepEqual(deleted.models.map((model) => model.id), ["example-coding-model", "example-vision-model"]);
  assert.equal(deleted.sessionStatus.model, "");

  const local = JSON.parse(await fs.readFile(path.join(cwd, ".lab-agent", "config.json"), "utf8"));
  assert.equal(local.modelAlias, "");
  assert.deepEqual(local.models, []);
  assert.equal(local.lab.gatewayUrl, null);
  assert.equal(local.lab.gatewayApiKey, undefined);
  assert.equal(local.lab.gatewayProfiles.some((profile) => profile.gatewayUrl.includes("beta-gateway")), false);
});

test("dashboard runtime replaces the edited model id instead of keeping the stale entry", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-"));
  const runtime = createDashboardRuntime({ cwd, env: {} });

  await runtime.saveModelConfig({
    gatewayUrl: "https://alpha-gateway.example/v1/chat/completions",
    gatewayProtocol: "openai-chat",
    gatewayApiKey: "alpha-key",
    modelId: "wrong-model",
    label: "Wrong Model",
    modalities: ["text", "image"],
    visionAgentModel: "wrong-model",
    agentDefaultModel: "wrong-model",
    switchToModel: true,
    applyAgentDefaults: true
  });

  const saved = await runtime.saveModelConfig({
    gatewayUrl: "https://alpha-gateway.example/v1/chat/completions",
    gatewayProtocol: "openai-chat",
    previousModelId: "wrong-model",
    modelId: "alpha-correct",
    label: "Alpha Correct",
    modalities: ["text", "image"],
    visionAgentModel: "alpha-correct",
    agentDefaultModel: "alpha-correct",
    switchToModel: true
  });

  assert.equal(saved.ok, true);
  assert.deepEqual(saved.models.map((model) => model.id), ["alpha-correct"]);
  assert.equal(saved.sessionStatus.model, "alpha-correct");

  const local = JSON.parse(await fs.readFile(path.join(cwd, ".lab-agent", "config.json"), "utf8"));
  assert.deepEqual(local.models.map((model) => model.id), ["alpha-correct"]);
  assert.equal(local.modelAlias, "alpha-correct");
  assert.equal(local.agents.modelTiers.default, "alpha-correct");
  assert.equal(local.agents.vision.model, "alpha-correct");
  assert.equal(local.lab.gatewayProfiles.find((profile) => profile.id === local.lab.activeGatewayProfile)?.models[0]?.id, "alpha-correct");
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
    modelAlias: "image-model",
    models: [
      { id: "image-model", label: "Image Model", modalities: ["text", "image"], contextTokens: 200000 }
    ]
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
  const runtime = createDashboardRuntime({ cwd, env: {} });
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
    await waitForEvent(runtime, result.sessionId, (event) => event.type === "files_updated");

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
    runtime.interruptTurn(started.sessionId, "test-cleanup");
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

test("dashboard runtime pauses for ask_user and resumes with the answer", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-"));
  const server = await listen(createQuestionGateway(), "127.0.0.1", 0);
  const runtime = createDashboardRuntime({ cwd, env: mockGatewayEnv(server) });

  try {
    await runtime.trustWorkspace();
    const started = await runtime.startTurn({
      prompt: "clarify requirement",
      permissionMode: "workspace"
    });
    assert.equal(started.ok, true);

    const waitingEvents = await waitForEvent(runtime, started.sessionId, (event) => event.type === "question_required");
    const question = waitingEvents.find((event) => event.type === "question_required")?.question;
    assert.equal(question?.header, "需求核对");
    assert.equal(question?.question, "输出格式选哪种？");
    assert.equal(question?.multiple, true);
    assert.equal(question?.allowCustom, true);
    assert.deepEqual(question?.choices.map((choice) => choice.label), ["Markdown", "PDF"]);

    const resolved = runtime.resolveQuestion(question.id, {
      selectedChoices: ["md"],
      customAnswer: "同时保留图表说明"
    });
    assert.equal(resolved.ok, true);

    const finalEvents = await waitForEvent(runtime, started.sessionId, (event) => event.type === "files_updated");
    const resolvedEvent = finalEvents.find((event) => event.type === "question_resolved");
    assert.equal(resolvedEvent?.answer, "同时保留图表说明");
    assert.deepEqual(resolvedEvent?.selectedChoices, ["Markdown"]);
    assert.match(finalEvents.find((event) => event.type === "assistant_final")?.text ?? "", /Markdown/);
    assert.match(finalEvents.find((event) => event.type === "assistant_final")?.text ?? "", /图表说明/);
  } finally {
    await close(server);
  }
});

test("dashboard runtime resolves cancelled ask_user requests", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-"));
  const server = await listen(createQuestionGateway(), "127.0.0.1", 0);
  const runtime = createDashboardRuntime({ cwd, env: mockGatewayEnv(server) });

  try {
    await runtime.trustWorkspace();
    const started = await runtime.startTurn({
      prompt: "cancel clarification",
      permissionMode: "workspace"
    });
    assert.equal(started.ok, true);

    const waitingEvents = await waitForEvent(runtime, started.sessionId, (event) => event.type === "question_required");
    const question = waitingEvents.find((event) => event.type === "question_required")?.question;
    const resolved = runtime.resolveQuestion(question.id, { cancelled: true });
    assert.equal(resolved.ok, true);

    const finalEvents = await waitForEvent(runtime, started.sessionId, (event) => event.type === "files_updated");
    const resolvedEvent = finalEvents.find((event) => event.type === "question_resolved");
    assert.equal(resolvedEvent?.cancelled, true);
    assert.match(finalEvents.find((event) => event.type === "assistant_final")?.text ?? "", /已取消/);
  } finally {
    await close(server);
  }
});

test("dashboard approval denial blocks a requested file write", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-"));
  const server = await listen(createToolGateway(), "127.0.0.1", 0);
  const runtime = createDashboardRuntime({ cwd, env: mockGatewayEnv(server) });

  try {
    await runtime.trustWorkspace();
    const started = await runtime.startTurn({
      prompt: "write file",
      permissionMode: "plan"
    });
    assert.equal(started.ok, true);

    const events = await waitForEvent(runtime, started.sessionId, (event) => event.type === "approval_required");
    const approval = events.find((event) => event.type === "approval_required")?.approval;
    assert.equal(approval?.toolName, "write_file");

    const denied = runtime.resolveApproval(approval.id, "deny");
    assert.equal(denied.ok, true);

    await waitForEvent(runtime, started.sessionId, (event) => event.type === "files_updated");
    await assert.rejects(() => fs.stat(path.join(cwd, "denied.md")), /ENOENT/);
  } finally {
    await close(server);
  }
});

test("dashboard runtime interrupts the current turn", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-"));
  const server = await listen(createHangingStreamGateway(), "127.0.0.1", 0);
  const runtime = createDashboardRuntime({ cwd, env: mockGatewayEnv(server) });
  await runtime.trustWorkspace();

  try {
    const started = await runtime.startTurn({
      prompt: "interrupt me",
      permissionMode: "workspace"
    });
    assert.equal(started.ok, true);
    await waitForEvent(runtime, started.sessionId, (event) => event.type === "assistant_draft");

    const interrupted = runtime.interruptTurn(started.sessionId, "user");
    assert.equal(interrupted.ok, true);

    const events = await waitForEvent(runtime, started.sessionId, (event) => event.type === "run_state" && event.running === false);
    assert.equal(events.some((event) => event.type === "turn_interrupt_requested"), true);
    assert.equal(events.some((event) => event.rawType === "turn_interrupted" || event.coalesceKey === "turn"), true);
  } finally {
    await close(server);
  }
});

test("dashboard runtime queues guide prompts and interrupts active work", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-"));
  const server = await listen(createDelayedGateway(["old answer", "guided answer"], 80), "127.0.0.1", 0);
  const runtime = createDashboardRuntime({ cwd, env: mockGatewayEnv(server) });
  await runtime.trustWorkspace();

  try {
    const started = await runtime.startTurn({
      prompt: "draft old plan",
      permissionMode: "workspace"
    });
    assert.equal(started.ok, true);

    const guided = runtime.guideTurn({
      sessionId: started.sessionId,
      guidance: "改成先检查测试",
      permissionMode: "workspace"
    });
    assert.equal(guided.ok, true);
    assert.equal(guided.queued, true);
    assert.equal(guided.queue[0].kind, "guide");

    const events = await waitForEvent(runtime, started.sessionId, (event) =>
      event.type === "background_subagent_snapshot"
      && event.groups.some((group) =>
        group.groupId === "group-dashboard-any"
        && group.status === "running"
        && group.wakePromptQueued === false
      )
      && runtime.listActiveEvents(started.sessionId).filter((item) => item.type === "files_updated").length >= 2
    );
    assert.equal(events.some((event) => event.type === "guide_queued"), true);
    assert.equal(events.some((event) => event.type === "turn_interrupt_requested" && event.reason === "guided"), true);
    assert.match(events.filter((event) => event.type === "user_message").map((event) => event.text).join("\n"), /改成先检查测试/);
  } finally {
    await close(server);
  }
});

test("dashboard runtime converts queued prompts into guides without duplicating them", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-"));
  const server = await listen(createDelayedGateway(["old answer", "guided answer"], 80), "127.0.0.1", 0);
  const runtime = createDashboardRuntime({ cwd, env: mockGatewayEnv(server) });
  await runtime.trustWorkspace();

  try {
    const started = await runtime.startTurn({
      prompt: "draft old plan",
      permissionMode: "workspace"
    });
    assert.equal(started.ok, true);

    const queued = await runtime.startTurn({
      sessionId: started.sessionId,
      prompt: "改成先检查测试",
      permissionMode: "workspace"
    });
    assert.equal(queued.ok, true);
    assert.equal(queued.queued, true);
    assert.equal(queued.queueLength, 1);

    const guided = runtime.guideTurn({
      sessionId: started.sessionId,
      queueItemId: queued.queue[0].id,
      permissionMode: "workspace"
    });
    assert.equal(guided.ok, true);
    assert.equal(guided.queued, true);
    assert.equal(guided.queue.length, 1);
    assert.equal(guided.queue[0].kind, "guide");
    assert.match(guided.queue[0].preview, /改成先检查测试/);
    assert.equal(guided.queue.some((item) => item.kind === "prompt" && /改成先检查测试/.test(item.preview)), false);

    const events = await waitForEvent(runtime, started.sessionId, () =>
      runtime.listActiveEvents(started.sessionId).filter((event) => event.type === "files_updated").length >= 2
    );
    assert.equal(events.some((event) => event.type === "guide_queued"), true);
    assert.equal(events.some((event) => event.type === "turn_interrupt_requested" && event.reason === "guided"), true);
    assert.deepEqual(events.filter((event) => event.type === "user_message").map((event) => event.text), [
      "draft old plan",
      "改成先检查测试"
    ]);
  } finally {
    await close(server);
  }
});

test("dashboard runtime stores guide transcript using visible guidance only", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-"));
  const server = await listen(createDelayedGateway(["old answer", "guided answer"], 80), "127.0.0.1", 0);
  const runtime = createDashboardRuntime({ cwd, env: mockGatewayEnv(server) });
  await runtime.trustWorkspace();

  try {
    const started = await runtime.startTurn({
      prompt: "draft old plan",
      permissionMode: "workspace"
    });
    assert.equal(started.ok, true);

    const guided = runtime.guideTurn({
      sessionId: started.sessionId,
      guidance: "改成先检查测试",
      permissionMode: "workspace"
    });
    assert.equal(guided.ok, true);
    assert.equal(guided.queued, true);

    await waitForEvent(runtime, started.sessionId, () =>
      runtime.listActiveEvents(started.sessionId).filter((event) => event.type === "files_updated").length >= 2
    );

    const reopened = await runtime.readSession(started.sessionId);
    assert.equal(reopened.ok, true);
    assert.equal(reopened.session.prompt, "改成先检查测试");
    assert.equal(
      reopened.session.transcript.some((message) => message.role === "user" && message.content === "改成先检查测试"),
      true
    );
    assert.equal(JSON.stringify(reopened.session.transcript).includes("User guidance for the interrupted active turn"), false);
    assert.equal(JSON.stringify(reopened.session.transcript).includes("Original active prompt"), false);

    const metadata = JSON.parse(await fs.readFile(path.join(cwd, ".lab-agent", "sessions", `${started.sessionId}.json`), "utf8"));
    assert.equal(metadata.prompt, "改成先检查测试");
    assert.equal(
      metadata.transcript.messages.some((message) => message.role === "user" && message.content === "改成先检查测试"),
      true
    );
    assert.equal(JSON.stringify(metadata.transcript.messages).includes("User guidance for the interrupted active turn"), false);
    assert.equal(JSON.stringify(metadata.transcript.messages).includes("Original active prompt"), false);
  } finally {
    await close(server);
  }
});

test("dashboard runtime consumes background subagent wake prompts", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-"));
  const requests = [];
  const server = await listen(createBackgroundWakeGateway(requests), "127.0.0.1", 0);
  const runtime = createDashboardRuntime({ cwd, env: mockGatewayEnv(server) });
  await runtime.trustWorkspace();

  try {
    const started = await runtime.startTurn({
      prompt: "delegate background work",
      permissionMode: "workspace"
    });
    assert.equal(started.ok, true);

    const events = await waitForEvent(runtime, started.sessionId, () =>
      runtime.listActiveEvents(started.sessionId).filter((event) => event.type === "files_updated").length >= 2
    );
    const parentRequests = requests.filter((item) => !String(item.sessionId ?? "").startsWith("agent-explorer-"));

    assert.equal(events.some((event) => event.rawType === "subagent_group_wakeup"), true);
    assert.equal(events.some((event) => event.type === "wakeup_queued"), true);
    assert.equal(events.some((event) => event.type === "background_subagent_snapshot"), true);
    assert.match(parentRequests.at(-1)?.messages?.at(-1)?.content ?? "", /Ant Code subagent group completed/);
    assert.match(events.filter((event) => event.type === "assistant_final").map((event) => event.text).join("\n"), /parent consumed wake prompt/);

    const group = JSON.parse(await fs.readFile(path.join(cwd, ".lab-agent", "task-groups", "group-dashboard-bg.json"), "utf8"));
    assert.ok(group.wakePromptQueuedAt);
    assert.ok(group.wakePromptConsumedAt);
    const lastSnapshot = events.filter((event) => event.type === "background_subagent_snapshot").at(-1);
    assert.deepEqual(lastSnapshot.groups, []);
  } finally {
    await close(server);
  }
});

test("dashboard runtime keeps a background wake prompt unconsumed when the queue is full", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-"));
  const firstParentGate = deferred();
  const finishParentGate = deferred();
  const requests = [];
  const server = await listen(
    createQueueFullBackgroundWakeGateway(requests, firstParentGate.promise, finishParentGate.promise),
    "127.0.0.1",
    0
  );
  const runtime = createDashboardRuntime({
    cwd,
    env: mockGatewayEnv(server, { ANT_CODE_INTERRUPT_FORCE_SETTLE_MS: "50" })
  });
  await runtime.trustWorkspace();

  try {
    const started = await runtime.startTurn({
      prompt: "delegate while queue is full",
      permissionMode: "workspace"
    });
    await waitForEvent(runtime, started.sessionId, (event) => event.type === "activity" && event.rawType === "gateway_request_start");
    for (let index = 0; index < 20; index += 1) {
      const queued = await runtime.startTurn({
        prompt: `waiting ${index + 1}`,
        sessionId: started.sessionId,
        permissionMode: "workspace"
      });
      assert.equal(queued.ok, true);
    }

    firstParentGate.resolve();
    const events = await waitForEvent(runtime, started.sessionId, (event) => event.type === "wakeup_queue_full");
    assert.equal(events.some((event) => event.type === "wakeup_queued"), false);
    assert.equal(runtime.active.get(started.sessionId).queuedPrompts.length, 20);

    const groupPath = path.join(cwd, ".lab-agent", "task-groups", "group-dashboard-queue-full.json");
    const group = JSON.parse(await fs.readFile(groupPath, "utf8"));
    assert.ok(group.wakePromptQueuedAt);
    assert.equal(group.wakePromptConsumedAt, null);

    for (const item of [...runtime.active.get(started.sessionId).queuedPrompts]) {
      runtime.cancelQueuedTurn({ sessionId: started.sessionId, queueItemId: item.id });
    }
    finishParentGate.resolve();
    await waitForEvent(runtime, started.sessionId, (event) => event.type === "run_state" && event.running === false);
  } finally {
    firstParentGate.resolve();
    finishParentGate.resolve();
    if ([...runtime.active.values()].some((state) => state.running)) {
      for (const state of runtime.active.values()) {
        if (state.running) runtime.interruptTurn(state.session.id, "test-cleanup");
      }
    }
    await runtime.shutdown({
      cancelActive: true,
      cancelBackground: true,
      force: true,
      timeoutMs: 200
    });
    await close(server);
  }
});

test("dashboard runtime keeps still-running background siblings visible after wake prompt is consumed", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-"));
  const requests = [];
  const server = await listen(createBackgroundAnyWakeGateway(requests), "127.0.0.1", 0);
  const runtime = createDashboardRuntime({ cwd, env: mockGatewayEnv(server) });
  await runtime.trustWorkspace();

  try {
    const started = await runtime.startTurn({
      prompt: "delegate any background work",
      permissionMode: "workspace"
    });
    assert.equal(started.ok, true);

    const events = await waitForEvent(runtime, started.sessionId, () =>
      runtime.listActiveEvents(started.sessionId).filter((event) => event.type === "files_updated").length >= 2
    );

    assert.equal(events.some((event) => event.rawType === "subagent_group_wakeup"), true);
    const snapshots = events.filter((event) => event.type === "background_subagent_snapshot");
    assert.ok(snapshots.length >= 2);
    const lastSnapshot = snapshots.at(-1);
    assert.equal(lastSnapshot.groups.length, 1);
    assert.equal(lastSnapshot.groups[0].groupId, "group-dashboard-any");
    assert.equal(lastSnapshot.groups[0].status, "running");
    assert.equal(lastSnapshot.groups[0].runningCount, 1);
    assert.equal(lastSnapshot.groups[0].wakePromptQueued, false);

    const reopened = await runtime.readSession(started.sessionId);
    assert.equal(reopened.ok, true);
    assert.equal(reopened.session.active, true);
    assert.equal(reopened.session.running, false);
    assert.equal(reopened.session.backgroundSnapshot.groups.length, 1);
    assert.equal(reopened.session.backgroundSnapshot.groups[0].groupId, "group-dashboard-any");
    assert.equal(reopened.session.backgroundSnapshot.groups[0].status, "running");
    const records = await runtime.listSessionRecords();
    const record = records.find((item) => item.id === started.sessionId);
    assert.equal(record.backgroundVisible, true);
    assert.deepEqual(record.backgroundKinds, ["subagent"]);

    const group = JSON.parse(await fs.readFile(path.join(cwd, ".lab-agent", "task-groups", "group-dashboard-any.json"), "utf8"));
    assert.ok(group.wakePromptConsumedAt);
  } finally {
    await close(server);
  }
});

test("dashboard runtime reports stale background subagents without claiming an absent controller was cancelled", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-"));
  const server = await listen(createGateway("snapshot refresh"), "127.0.0.1", 0);
  const runtime = createDashboardRuntime({ cwd, env: mockGatewayEnv(server) });
  await runtime.trustWorkspace();

  try {
    const started = await runtime.startTurn({
      prompt: "seed session",
      permissionMode: "workspace"
    });
    assert.equal(started.ok, true);
    await waitForEvent(runtime, started.sessionId, (event) => event.type === "files_updated");

    const taskStore = createAgentTaskStore({ cwd });
    const groupStore = createAgentTaskGroupStore({ cwd });
    const old = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    await taskStore.createTask({
      id: "task-lost-bg",
      parentSessionId: started.sessionId,
      groupId: "group-lost-bg",
      childSessionId: "agent-explorer-lost",
      profile: "explorer",
      title: "Lost background task",
      prompt: "hang",
      status: "running",
      startedAt: old,
      heartbeatAt: old,
      progressAt: old,
      latestProgress: "still running"
    });
    await groupStore.createGroup({
      id: "group-lost-bg",
      parentSessionId: started.sessionId,
      status: "running",
      waitFor: "all",
      wakeParent: true,
      taskIds: ["task-lost-bg"],
      latestProgress: "后台子任务仍在运行"
    });

    await runtime.startTurn({
      sessionId: started.sessionId,
      prompt: "refresh background status",
      permissionMode: "workspace"
    });
    const events = await waitForEvent(runtime, started.sessionId, (event) =>
      event.type === "background_subagent_snapshot"
      && event.groups.some((group) => group.groupId === "group-lost-bg" && group.status === "lost")
    );
    const staleSnapshot = events.filter((event) => event.type === "background_subagent_snapshot").at(-1);
    assert.equal(staleSnapshot.groups[0].status, "lost");
    assert.equal(staleSnapshot.groups[0].stale, true);
    assert.match(staleSnapshot.groups[0].staleReason, /heartbeat/);

    const cancelled = await runtime.cancelBackgroundSubagent({
      sessionId: started.sessionId,
      groupId: "group-lost-bg"
    });
    assert.equal(cancelled.ok, false);
    assert.equal(cancelled.status, 409);
    assert.equal(cancelled.code, "BACKGROUND_CONTROLLER_NOT_FOUND");
    const readTask = await taskStore.readTask("task-lost-bg");
    assert.equal(readTask.ok, true);
    assert.equal(readTask.task.status, "running");
    assert.equal(readTask.task.cancelRequestedAt, null);
  } finally {
    await close(server);
  }
});

test("dashboard runtime starts cancellable background terminal tasks without blocking the turn", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-terminal-"));
  const command = process.platform === "win32"
    ? "Start-Sleep -Seconds 10; Write-Output done"
    : "sleep 10; echo done";
  const server = await listen(createSequenceGateway([
    {
      content: "starting background terminal",
      toolCalls: [
        {
          id: "call-background-terminal",
          name: "background_shell",
          input: {
            command,
            title: "Long discover",
            taskId: "discover-test"
          }
        }
      ],
      stopReason: "tool_calls"
    },
    {
      content: "discover is running in the background",
      toolCalls: [],
      stopReason: "stop"
    }
  ]), "127.0.0.1", 0);
  const runtime = createDashboardRuntime({ cwd, env: mockGatewayEnv(server) });
  await runtime.trustWorkspace();

  try {
    const startedAt = Date.now();
    const started = await runtime.startTurn({
      prompt: "run long discover",
      permissionMode: "workspace"
    });
    assert.equal(started.ok, true);

    const startedEvents = await waitForEvent(runtime, started.sessionId, (event) =>
      event.type === "background_subagent_snapshot"
      && event.groups.some((group) => group.kind === "terminal" && group.taskId === "discover-test" && group.status === "running")
    );
    assert.equal(startedEvents.some((event) => event.rawType === "background_terminal_started"), true);
    assert.equal(runtime.active.get(started.sessionId).running, true);

    const events = await waitForEvent(runtime, started.sessionId, (event) => event.type === "run_state" && event.running === false);
    assert.ok(Date.now() - startedAt < 5000);
    const snapshot = events.filter((event) => event.type === "background_subagent_snapshot").at(-1);
    assert.equal(snapshot.groups.some((group) => group.kind === "terminal" && group.taskId === "discover-test" && group.status === "running"), true);

    const reopened = await runtime.readSession(started.sessionId);
    assert.equal(reopened.ok, true);
    assert.equal(reopened.session.active, true);
    assert.equal(reopened.session.running, false);
    assert.equal(
      reopened.session.backgroundSnapshot.groups.some((group) =>
        group.kind === "terminal" && group.taskId === "discover-test" && group.status === "running"
      ),
      true
    );
    const records = await runtime.listSessionRecords();
    const record = records.find((item) => item.id === started.sessionId);
    assert.equal(record.backgroundVisible, true);
    assert.deepEqual(record.backgroundKinds, ["terminal"]);

    const cancelled = await runtime.cancelBackgroundTerminal({
      sessionId: started.sessionId,
      taskId: "discover-test"
    });
    assert.equal(cancelled.ok, true);
    assert.deepEqual(cancelled.cancelledTaskIds, ["discover-test"]);
  } finally {
    await close(server);
  }
});

test("dashboard runtime shows starting background terminal tasks before pid is available", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-terminal-starting-"));
  await fs.writeFile(path.join(cwd, "lab-agent.config.json"), JSON.stringify({
    lab: {
      gatewayUrl: null
    }
  }), "utf8");
  const runtime = createDashboardRuntime({ cwd, env: {} });
  await runtime.trustWorkspace();
  const started = await runtime.startTurn({
    prompt: "seed session",
    permissionMode: "workspace"
  });
  assert.equal(started.ok, true);
  await waitForEvent(runtime, started.sessionId, (event) => event.type === "run_state" && event.running === false);

  registerBackgroundTerminalTask({
    taskId: "starting-terminal",
    parentSessionId: started.sessionId,
    title: "Starting terminal",
    command: "blocked by endpoint security",
    cwd,
    stdoutPath: path.join(cwd, ".lab-agent", "background-terminal", "starting-terminal.stdout.log"),
    stderrPath: path.join(cwd, ".lab-agent", "background-terminal", "starting-terminal.stderr.log"),
    status: "starting"
  });

  const reopened = await runtime.readSession(started.sessionId);
  assert.equal(reopened.ok, true);
  assert.equal(
    reopened.session.backgroundSnapshot.groups.some((group) =>
      group.kind === "terminal" && group.taskId === "starting-terminal" && group.status === "starting"
    ),
    true
  );
  const records = await runtime.listSessionRecords();
  const record = records.find((item) => item.id === started.sessionId);
  assert.equal(record.backgroundVisible, true);
  assert.deepEqual(record.backgroundKinds, ["terminal"]);
});

test("dashboard runtime cancels queued prompts before they run", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-"));
  const server = await listen(createDelayedGateway(["first answer", "second answer"], 80), "127.0.0.1", 0);
  const runtime = createDashboardRuntime({ cwd, env: mockGatewayEnv(server) });
  await runtime.trustWorkspace();

  try {
    const started = await runtime.startTurn({
      prompt: "first",
      permissionMode: "workspace"
    });
    const queued = await runtime.startTurn({
      sessionId: started.sessionId,
      prompt: "second should cancel",
      permissionMode: "workspace"
    });
    assert.equal(queued.ok, true);
    assert.equal(queued.queued, true);

    const cancelled = runtime.cancelQueuedTurn({
      sessionId: started.sessionId,
      queueItemId: queued.queue[0].id
    });
    assert.equal(cancelled.ok, true);
    assert.equal(cancelled.queueLength, 0);

    const events = await waitForEvent(runtime, started.sessionId, (event) => event.type === "run_state" && event.running === false);
    assert.equal(events.some((event) => event.type === "queue_item_cancelled"), true);
    assert.deepEqual(events.filter((event) => event.type === "user_message").map((event) => event.text), ["first"]);
    assert.doesNotMatch(events.filter((event) => event.type === "assistant_final").map((event) => event.text).join("\n"), /second answer/);
  } finally {
    await close(server);
  }
});

test("dashboard runtime deletes completed saved sessions", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-"));
  const server = await listen(createGateway("delete answer"), "127.0.0.1", 0);
  const runtime = createDashboardRuntime({ cwd, env: mockGatewayEnv(server) });

  try {
    await runtime.trustWorkspace();
    const started = await runtime.startTurn({
      prompt: "delete me",
      permissionMode: "workspace"
    });
    await waitForEvent(runtime, started.sessionId, (event) => event.type === "files_updated");

    const deleted = await runtime.deleteSession({ sessionId: started.sessionId });

    assert.equal(deleted.ok, true);
    assert.equal((await runtime.readSession(started.sessionId)).ok, false);
    assert.equal((await runtime.listSessionRecords()).some((record) => record.id === started.sessionId), false);
  } finally {
    await close(server);
  }
});

test("dashboard runtime pages archived transcript history for display", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-"));
  const runtime = createDashboardRuntime({ cwd, env: {} });
  const store = createSessionStore({ cwd });
  const messages = Array.from({ length: 155 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: index % 2 === 0
      ? `prompt ${index + 1}`
      : [{ type: "text", text: `answer ${index + 1}` }]
  }));
  const archive = await store.writeTranscriptChunks("archived-dashboard-session", messages);
  await store.writeMetadata({
    id: "archived-dashboard-session",
    prompt: "archived prompt",
    title: "archived prompt",
    status: "completed",
    transcript: {
      version: 2,
      messages: messages.slice(-50),
      archive
    }
  });

  const reopened = await runtime.readSession("archived-dashboard-session");
  const older = await runtime.readTranscriptPage({
    sessionId: "archived-dashboard-session",
    before: reopened.session.transcriptPage.cursor,
    limit: 100
  });

  assert.equal(reopened.ok, true);
  assert.equal(reopened.session.transcript.length, 100);
  assert.equal(transcriptText(reopened.session.transcript[0]), "answer 56");
  assert.equal(reopened.session.transcript.at(-1).content, "prompt 155");
  assert.equal(reopened.session.transcriptPage.hasMore, true);
  assert.equal(reopened.session.transcriptPage.cursor, "55");
  assert.equal(reopened.session.transcriptPage.total, 155);
  assert.equal(older.ok, true);
  assert.equal(older.transcript.length, 55);
  assert.equal(older.transcript[0].content, "prompt 1");
  assert.equal(older.transcript.at(-1).content, "prompt 55");
  assert.equal(older.transcriptPage.hasMore, false);
});

test("dashboard resume sends archived full context while display stays paged", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-"));
  const requests = [];
  const server = await listen(createRecordingGateway(requests, "continued with full context"), "127.0.0.1", 0);
  const runtime = createDashboardRuntime({ cwd, env: mockGatewayEnv(server) });
  const store = createSessionStore({ cwd });
  const messages = [];
  for (let index = 1; index <= 60; index += 1) {
    messages.push({ role: "user", content: `prompt ${index}` });
    messages.push({ role: "assistant", content: [{ type: "text", text: `answer ${index}` }] });
  }
  const archive = await store.writeTranscriptChunks("dashboard-full-context-session", messages);
  await store.writeMetadata({
    id: "dashboard-full-context-session",
    prompt: "archived prompt",
    title: "archived prompt",
    status: "completed",
    transcript: {
      version: 2,
      messages: messages.slice(-50),
      contextMessages: messages.slice(-2),
      contextWindow: {
        summary: "Old compact summary that should not be sent when full archive is restored",
        compactionCount: 1,
        compactedMessages: 118
      },
      archive
    }
  });

  try {
    const reopened = await runtime.readSession("dashboard-full-context-session");
    assert.equal(reopened.ok, true);
    assert.equal(reopened.session.transcript.length, 100);
    assert.equal(reopened.session.transcriptPage.hasMore, true);

    await runtime.trustWorkspace();
    const started = await runtime.startTurn({
      sessionId: "dashboard-full-context-session",
      prompt: "continue with full context",
      permissionMode: "workspace"
    });
    assert.equal(started.ok, true);
    await waitForEvent(runtime, started.sessionId, (event) => event.type === "files_updated");

    assert.equal(requests.length, 1);
    const request = requests[0];
    const userMessages = request.messages.filter((message) => message.role === "user").map(requestMessageText);
    const assistantMessages = request.messages.filter((message) => message.role === "assistant").map(requestMessageText);
    assert.equal(userMessages.includes("prompt 1"), true);
    assert.equal(assistantMessages.includes("answer 60"), true);
    assert.equal(userMessages.includes("continue with full context"), true);
    assert.doesNotMatch(JSON.stringify(request.messages), /Old compact summary/);
  } finally {
    await close(server);
  }
});

test("dashboard runtime refuses deleting running sessions", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-"));
  const server = await listen(createHangingStreamGateway(), "127.0.0.1", 0);
  const runtime = createDashboardRuntime({ cwd, env: mockGatewayEnv(server) });

  try {
    await runtime.trustWorkspace();
    const started = await runtime.startTurn({
      prompt: "do not delete running",
      permissionMode: "workspace"
    });
    await waitForEvent(runtime, started.sessionId, (event) => event.type === "assistant_draft");

    const deleted = await runtime.deleteSession({ sessionId: started.sessionId });

    assert.equal(deleted.ok, false);
    assert.equal(deleted.status, 409);
    assert.equal(runtime.active.has(started.sessionId), true);
    runtime.interruptTurn(started.sessionId, "test-cleanup");
    await waitForEvent(runtime, started.sessionId, (event) => event.type === "run_state" && event.running === false);
  } finally {
    await close(server);
  }
});

test("dashboard runtime clears and compacts context after confirmation routes call runtime", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-"));
  const server = await listen(createGateway("context answer"), "127.0.0.1", 0);
  const runtime = createDashboardRuntime({ cwd, env: mockGatewayEnv(server) });
  await runtime.trustWorkspace();

  try {
    const started = await runtime.startTurn({
      prompt: "context seed",
      permissionMode: "workspace"
    });
    await waitForEvent(runtime, started.sessionId, (event) => event.type === "files_updated");

    const cleared = await runtime.clearContext({ sessionId: started.sessionId, permissionMode: "workspace" });
    assert.equal(cleared.ok, true);
    assert.equal(cleared.after.messages, 0);
    const store = createSessionStore({ cwd, env: mockGatewayEnv(server) });
    const clearedMetadata = await store.readMetadataExact(started.sessionId);
    assert.equal(clearedMetadata.ok, true);
    assert.equal(clearedMetadata.metadata.context.messages, 0);
    assert.deepEqual(clearedMetadata.metadata.transcript.contextMessages, []);
    assert.equal(runtime.active.get(started.sessionId).persisted, true);

    runtime.active.get(started.sessionId).session.messages = [
      { role: "user", content: "older context" },
      { role: "assistant", content: [{ type: "text", text: "older answer" }] },
      { role: "user", content: "new context" },
      { role: "assistant", content: [{ type: "text", text: "new answer" }] }
    ];
    const compacted = await runtime.compactContext({ sessionId: started.sessionId, permissionMode: "workspace" });
    assert.equal(compacted.ok, true);
    assert.equal(["local", "agent:compaction", "none"].includes(compacted.result.strategy), true);
    assert.equal(runtime.listActiveEvents(started.sessionId).some((event) => event.type === "context_compacted"), true);
    const compactedMetadata = await store.readMetadataExact(started.sessionId);
    assert.equal(compactedMetadata.ok, true);
    assert.equal(compactedMetadata.metadata.context.messages, compacted.after.messages);
    assert.equal(compactedMetadata.metadata.transcript.contextMessages.length, compacted.after.messages);
    assert.equal(typeof compactedMetadata.metadata.transcript.contextWindow.summary, "string");
    assert.equal(runtime.active.get(started.sessionId).persisted, true);
  } finally {
    await close(server);
  }
});

test("dashboard runtime rolls back a context mutation when immediate persistence fails", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-context-rollback-"));
  const server = await listen(createGateway("context rollback answer"), "127.0.0.1", 0);
  const env = mockGatewayEnv(server);
  const runtime = createDashboardRuntime({ cwd, env });
  await runtime.trustWorkspace();

  try {
    const started = await runtime.startTurn({
      prompt: "context must survive a failed save",
      permissionMode: "workspace"
    });
    await waitForEvent(runtime, started.sessionId, (event) => event.type === "files_updated");
    const state = runtime.active.get(started.sessionId);
    const before = structuredClone(state.session.messages);
    const store = createSessionStore({ cwd, env });
    await store.deleteSession(started.sessionId);

    const cleared = await runtime.clearContext({ sessionId: started.sessionId, permissionMode: "workspace" });

    assert.equal(cleared.ok, false);
    assert.equal(cleared.code, "CONTEXT_PERSIST_FAILED");
    assert.deepEqual(state.session.messages, before);
    assert.equal(state.persisted, false);
  } finally {
    await close(server);
  }
});

test("dashboard runtime serializes concurrent cold resumes and rejects selector aliases", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-resume-lock-"));
  const store = createSessionStore({ cwd });
  await store.writeMetadata({
    id: "dashboard-exact-session-id",
    prompt: "saved prompt",
    title: "saved prompt",
    status: "completed",
    transcript: { messages: [] }
  });
  const gate = deferred();
  let calls = 0;
  const runtime = createDashboardRuntime({
    cwd,
    env: {},
    runTurn: async (_session, options) => {
      calls += 1;
      await gate.promise;
      await options.onEvent({ type: "turn_complete", status: "completed" });
      return { output: "resumed" };
    }
  });
  await runtime.trustWorkspace();

  const [first, second] = await Promise.all([
    runtime.startTurn({ sessionId: "dashboard-exact-session-id", prompt: "first", permissionMode: "plan" }),
    runtime.startTurn({ sessionId: "dashboard-exact-session-id", prompt: "second", permissionMode: "plan" })
  ]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal([first, second].filter((result) => result.queued === true).length, 1);
  assert.equal(runtime.active.size, 1);
  assert.equal(runtime.active.get("dashboard-exact-session-id").queuedPrompts.length, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);

  const prefix = await runtime.startTurn({ sessionId: "dashboard-exact", prompt: "prefix", permissionMode: "plan" });
  assert.equal(prefix.ok, false);
  assert.equal(prefix.code, "EXACT_SESSION_ID_REQUIRED");
  const latest = await runtime.clearContext({ sessionId: "latest", permissionMode: "plan" });
  assert.equal(latest.ok, false);
  assert.equal(latest.code, "EXACT_SESSION_ID_REQUIRED");

  runtime.cancelQueuedTurn({
    sessionId: "dashboard-exact-session-id",
    queueItemId: runtime.active.get("dashboard-exact-session-id").queuedPrompts[0].id
  });
  gate.resolve();
  await waitForEvent(runtime, "dashboard-exact-session-id", (event) => event.type === "run_state" && event.running === false);
});

test("dashboard runtime blocks background deletion unless cancellation is explicit", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-delete-background-"));
  const runtime = createDashboardRuntime({
    cwd,
    env: {},
    runTurn: async (_session, options) => {
      await options.onEvent({ type: "turn_complete", status: "completed" });
      return { output: "done" };
    }
  });
  await runtime.trustWorkspace();
  const started = await runtime.startTurn({ prompt: "seed", permissionMode: "plan" });
  await waitForEvent(runtime, started.sessionId, (event) => event.type === "run_state" && event.running === false);
  const unregister = registerBackgroundTerminalTask({
    taskId: "delete-owned-terminal",
    parentSessionId: started.sessionId,
    title: "owned terminal",
    command: "pending",
    cwd,
    status: "starting"
  });

  try {
    const blocked = await runtime.deleteSession({ sessionId: started.sessionId });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.code, "SESSION_HAS_ACTIVE_WORK");
    assert.equal(blocked.activity.backgroundTasks, 1);
    assert.equal(runtime.active.has(started.sessionId), true);

    const deleted = await runtime.deleteSession({
      sessionId: started.sessionId,
      cancelBackground: true,
      timeoutMs: 250
    });
    assert.equal(deleted.ok, true);
    assert.equal(runtime.active.has(started.sessionId), false);
  } finally {
    unregister();
  }
});

test("dashboard runtime shutdown reports activity and requires bounded cancel or force semantics", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-shutdown-"));
  const gate = deferred();
  const runtime = createDashboardRuntime({
    cwd,
    env: { ANT_CODE_INTERRUPT_FORCE_SETTLE_MS: "50" },
    runTurn: async () => {
      await gate.promise;
      return { output: "late" };
    }
  });
  await runtime.trustWorkspace();
  const started = await runtime.startTurn({ prompt: "stay active", permissionMode: "plan" });
  const state = runtime.active.peek(started.sessionId);
  let disposedReason = "";
  runtime.subscribe(started.sessionId, () => {}, {
    onDispose: (reason) => {
      disposedReason = reason;
    }
  });

  const undecided = await runtime.shutdown({});
  assert.equal(undecided.ok, false);
  assert.equal(undecided.code, "ACTIVE_WORK_REQUIRES_DECISION");
  assert.equal(undecided.activity.activeTurns, 1);

  const timedOut = await runtime.shutdown({ cancel: true, timeoutMs: 75 });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.code, "SHUTDOWN_TIMEOUT");
  assert.equal(timedOut.activity.quarantinedTurns, 1);
  assert.equal(runtime.active.has(started.sessionId), true);

  const forced = await runtime.shutdown({ force: true, timeoutMs: 75 });
  assert.equal(forced.ok, true);
  assert.equal(forced.forced, true);
  assert.equal(runtime.active.size, 0);
  assert.equal(disposedReason, "shutdown");
  assert.equal(state.controller, null);
  assert.equal(state.listeners.size, 0);
  assert.equal(state.events.length, 0);
  gate.resolve();
});

test("dashboard runtime refuses metadata cwd outside the dashboard workspace", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-cwd-root-"));
  const child = path.join(cwd, "child");
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-cwd-outside-"));
  await fs.mkdir(child);
  const store = createSessionStore({ cwd });
  await store.writeMetadata({ id: "inside-cwd", cwd: child, status: "completed" });
  await store.writeMetadata({ id: "outside-cwd", cwd: outside, status: "completed" });
  const runtime = createDashboardRuntime({ cwd, env: {} });

  const inside = await runtime.sessionCwd("inside-cwd");
  assert.equal(inside.ok, true);
  assert.equal(inside.cwd, await fs.realpath(child));
  const escaped = await runtime.sessionCwd("outside-cwd");
  assert.equal(escaped.ok, false);
  assert.equal(escaped.status, 403);
  assert.equal(escaped.code, "SESSION_CWD_OUTSIDE_WORKSPACE");
});

test("dashboard transcript endpoints page a 10k archive without materializing full history", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-large-page-"));
  const store = createSessionStore({ cwd });
  const messages = Array.from({ length: 10_000 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `message ${index + 1}`
  }));
  const archive = await store.writeTranscriptChunks("dashboard-large-page", messages);
  await store.writeMetadata({
    id: "dashboard-large-page",
    cwd,
    title: "large page",
    status: "completed",
    transcript: { archive, messages: messages.slice(-50) }
  });
  const runtime = createDashboardRuntime({ cwd, env: {} });

  const opened = await runtime.readSession("dashboard-large-page");
  assert.equal(opened.ok, true);
  assert.equal(opened.session.transcript.length, 100);
  assert.equal(opened.session.transcript[0].content, "message 9901");
  assert.equal(opened.session.transcript.at(-1).content, "message 10000");
  assert.equal(opened.session.transcriptPage.cursor, "9900");
  assert.equal(opened.session.transcriptPage.total, 10_000);

  const previous = await runtime.readTranscriptPage({
    sessionId: "dashboard-large-page",
    before: opened.session.transcriptPage.cursor,
    limit: 100
  });
  assert.equal(previous.ok, true);
  assert.equal(previous.transcript[0].content, "message 9801");
  assert.equal(previous.transcript.at(-1).content, "message 9900");
  assert.equal(previous.transcriptPage.cursor, "9800");

  await fs.writeFile(path.join(store.root, archive.chunks.at(-1).file), "{corrupt", "utf8");
  const corrupt = await runtime.readSession("dashboard-large-page");
  assert.equal(corrupt.ok, false);
  assert.equal(corrupt.status, 500);
  assert.equal(corrupt.code, "TRANSCRIPT_CHUNK_INVALID");
  await runtime.shutdown({ force: true, timeoutMs: 50 });
});

test("dashboard active transcript paging preserves cursor positions with duplicate messages and pending tail", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-active-page-"));
  const store = createSessionStore({ cwd });
  const messages = Array.from({ length: 150 }, (_, index) => ({ role: "user", content: `message ${index + 1}` }));
  messages[60] = { ...messages[50] };
  const archive = await store.writeTranscriptChunks("active-page-session", messages);
  await store.writeMetadata({
    id: "active-page-session",
    cwd,
    status: "completed",
    transcript: { archive, messages: messages.slice(-50) }
  });
  const runtime = createDashboardRuntime({
    cwd,
    env: {},
    runTurn: async (_session, options) => {
      await options.onEvent({ type: "turn_complete", status: "completed" });
      return { output: "unchanged" };
    }
  });
  await runtime.trustWorkspace();
  const resumed = await runtime.startTurn({
    sessionId: "active-page-session",
    prompt: "activate",
    permissionMode: "plan"
  });
  await waitForEvent(runtime, resumed.sessionId, (event) => event.type === "run_state" && event.running === false);
  const state = runtime.active.peek(resumed.sessionId);
  const pending = Array.from({ length: 10 }, (_, index) => ({ role: "assistant", content: `pending ${index + 1}` }));
  state.session.transcriptMessages.push(...pending);
  state.session.transcriptArchive.pendingMessages.push(...pending);

  const first = await runtime.readSession(resumed.sessionId);
  assert.equal(first.ok, true);
  assert.equal(first.session.transcript.length, 100);
  assert.equal(first.session.transcript[0].content, "message 51");
  assert.equal(first.session.transcript.at(-1).content, "pending 10");
  assert.equal(first.session.transcriptPage.cursor, "60");
  assert.equal(first.session.transcriptPage.total, 160);

  const previous = await runtime.readTranscriptPage({
    sessionId: resumed.sessionId,
    before: first.session.transcriptPage.cursor,
    limit: 100
  });
  assert.equal(previous.ok, true);
  assert.equal(previous.transcript.length, 60);
  assert.equal(previous.transcript[0].content, "message 1");
  assert.equal(previous.transcript.at(-1).content, "message 60");
  assert.equal(previous.transcriptPage.hasMore, false);
  await runtime.shutdown({ force: true, timeoutMs: 50 });
});

test("dashboard active capacity evicts the least recently used persisted state and can reopen it", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-lru-"));
  const store = createSessionStore({ cwd });
  const runtime = createDashboardRuntime({
    cwd,
    env: { ANT_CODE_DASHBOARD_ACTIVE_SESSION_MAX: "3" },
    runTurn: async (session, options) => {
      await store.writeMetadata({
        id: session.id,
        cwd,
        title: session.title ?? session.id,
        status: "completed",
        transcript: { messages: [] }
      });
      await options.onEvent({ type: "turn_complete", status: "completed" });
      return { output: "persisted" };
    }
  });
  await runtime.trustWorkspace();
  const started = [];
  for (let index = 0; index < 3; index += 1) {
    const result = await runtime.startTurn({ prompt: `session ${index + 1}`, permissionMode: "plan" });
    started.push(result);
    await waitForEvent(runtime, result.sessionId, (event) => event.type === "run_state" && event.running === false);
  }
  const [first, second, third] = started.map((result) => runtime.active.peek(result.sessionId));
  first.lastAccessedAt = 1;
  second.lastAccessedAt = 2;
  third.lastAccessedAt = 3;
  await runtime.readSession(started[0].sessionId);

  const fourth = await runtime.startTurn({ prompt: "session 4", permissionMode: "plan" });
  await waitForEvent(runtime, fourth.sessionId, (event) => event.type === "run_state" && event.running === false);
  assert.equal(runtime.active.size, 3);
  assert.equal(runtime.active.has(started[0].sessionId), true);
  assert.equal(runtime.active.has(started[1].sessionId), false);
  assert.equal(second.disposed, true);
  assert.equal(second.controller, null);
  assert.equal(second.listeners.size, 0);
  assert.equal(second.events.length, 0);
  assert.deepEqual(second.session.messages, []);

  const reopened = await runtime.startTurn({
    sessionId: started[1].sessionId,
    prompt: "reopen evicted",
    permissionMode: "plan"
  });
  assert.equal(reopened.ok, true);
  assert.equal(reopened.sessionId, started[1].sessionId);
  await waitForEvent(runtime, reopened.sessionId, (event) => event.type === "run_state" && event.running === false);
  assert.equal(runtime.active.size, 3);
  assert.equal(runtime.active.has(started[1].sessionId), true);
  await runtime.shutdown({ force: true, timeoutMs: 50 });
});

test("dashboard idle TTL waits for listeners, pending interactions, background work, and controllers", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-ttl-"));
  const store = createSessionStore({ cwd });
  const runtime = createDashboardRuntime({
    cwd,
    env: {
      ANT_CODE_DASHBOARD_ACTIVE_SESSION_MAX: "10",
      ANT_CODE_DASHBOARD_ACTIVE_IDLE_TTL_MS: "30",
      ANT_CODE_DASHBOARD_ACTIVE_SWEEP_MS: "60000"
    },
    runTurn: async (session, options) => {
      await store.writeMetadata({ id: session.id, cwd, status: "completed", transcript: { messages: [] } });
      await options.onEvent({ type: "turn_complete", status: "completed" });
      return { output: "persisted" };
    }
  });
  await runtime.trustWorkspace();
  const started = await runtime.startTurn({ prompt: "ttl state", permissionMode: "plan" });
  await waitForEvent(runtime, started.sessionId, (event) => event.type === "run_state" && event.running === false);
  const state = runtime.active.peek(started.sessionId);
  const unsubscribe = runtime.subscribe(started.sessionId, () => {});
  state.lastAccessedAt = Date.now() - 100;
  await runtime.sweepIdleSessions();
  assert.equal(runtime.active.has(started.sessionId), true);

  unsubscribe();
  state.pendingApprovals.set("pending-test", { resolve: () => {}, approvalKey: "test" });
  state.lastAccessedAt = Date.now() - 100;
  await runtime.sweepIdleSessions();
  assert.equal(runtime.active.has(started.sessionId), true);
  state.pendingApprovals.clear();

  const unregister = registerBackgroundTerminalTask({
    taskId: "ttl-terminal",
    parentSessionId: started.sessionId,
    cwd,
    title: "ttl terminal",
    command: "pending",
    status: "starting"
  });
  state.lastAccessedAt = Date.now() - 100;
  await runtime.sweepIdleSessions();
  assert.equal(runtime.active.has(started.sessionId), true);
  unregister();

  state.controller = new AbortController();
  state.lastAccessedAt = Date.now() - 100;
  await runtime.sweepIdleSessions();
  assert.equal(runtime.active.has(started.sessionId), true);
  state.controller = null;
  state.lastAccessedAt = Date.now() - 100;
  const swept = await runtime.sweepIdleSessions();
  assert.deepEqual(swept.evicted, [started.sessionId]);
  assert.equal(runtime.active.has(started.sessionId), false);
  assert.equal(state.disposed, true);
  assert.equal(state.listeners.size, 0);
  assert.equal(state.controller, null);
  assert.deepEqual(state.session.messages, []);
  await runtime.shutdown({ force: true, timeoutMs: 50 });
});

test("dashboard active capacity never evicts an unpersisted idle state", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-unpersisted-"));
  const runtime = createDashboardRuntime({
    cwd,
    env: {
      ANT_CODE_DASHBOARD_ACTIVE_SESSION_MAX: "1",
      ANT_CODE_DASHBOARD_ACTIVE_IDLE_TTL_MS: "20",
      ANT_CODE_DASHBOARD_ACTIVE_SWEEP_MS: "60000"
    },
    runTurn: async (_session, options) => {
      await options.onEvent({ type: "turn_complete", status: "completed" });
      return { output: "not persisted" };
    }
  });
  await runtime.trustWorkspace();
  const first = await runtime.startTurn({ prompt: "keep me", permissionMode: "plan" });
  await waitForEvent(runtime, first.sessionId, (event) => event.type === "run_state" && event.running === false);
  runtime.active.peek(first.sessionId).lastAccessedAt = Date.now() - 100;
  await runtime.sweepIdleSessions();
  assert.equal(runtime.active.has(first.sessionId), true);
  assert.equal(runtime.active.peek(first.sessionId).persisted, false);

  const rejected = await runtime.startTurn({ prompt: "no capacity", permissionMode: "plan" });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.status, 503);
  assert.equal(rejected.code, "ACTIVE_SESSION_CAPACITY_REACHED");
  assert.equal(runtime.active.size, 1);
  await runtime.shutdown({ force: true, timeoutMs: 50 });
});

async function waitForEvent(runtime, sessionId, predicate, timeoutMs = 5000) {
  const existing = runtime.listActiveEvents(sessionId);
  if (existing.some(predicate)) {
    return existing;
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe?.();
      reject(new Error("Timed out waiting for dashboard event"));
    }, timeoutMs);
    let unsubscribe;
    unsubscribe = runtime.subscribe(sessionId, (event) => {
      if (predicate(event)) {
        clearTimeout(timeout);
        unsubscribe?.();
        resolve(runtime.listActiveEvents(sessionId));
      }
    });
  });
}

function transcriptText(message) {
  if (typeof message?.content === "string") {
    return message.content;
  }
  if (!Array.isArray(message?.content)) {
    return "";
  }
  return message.content.map((item) => item?.text ?? "").join("");
}

function requestMessageText(message) {
  if (typeof message?.content === "string") {
    return message.content;
  }
  if (!Array.isArray(message?.content)) {
    return "";
  }
  return message.content.map((item) => {
    if (typeof item === "string") {
      return item;
    }
    if (item && typeof item === "object" && "text" in item) {
      return String(item.text ?? "");
    }
    return "";
  }).join("");
}

function createGateway(text, options = {}) {
  return http.createServer(async (req, res) => {
    for await (const _ of req) {
      // Drain request body.
    }
    if ((Array.isArray(options.thinkingChunks) && options.thinkingChunks.length > 0)
      || (Array.isArray(options.textChunks) && options.textChunks.length > 0)) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ type: "message_start", id: "mock-dashboard-stream", model: "mock-model" })}\n\n`);
      for (const chunk of options.thinkingChunks ?? []) {
        res.write(`data: ${JSON.stringify({ type: "thinking_delta", text: chunk })}\n\n`);
      }
      const textChunks = Array.isArray(options.textChunks) && options.textChunks.length > 0
        ? options.textChunks
        : [text];
      for (const chunk of textChunks) {
        res.write(`data: ${JSON.stringify({ type: "text_delta", text: chunk })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ type: "message_stop", stopReason: "stop" })}\n\n`);
      return res.end();
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "mock-dashboard-response",
      model: "mock-model",
      content: [{ type: "text", text }],
      toolCalls: [],
      stopReason: "stop"
    }));
  });
}

function createRecordingGateway(requests, text) {
  return http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) {
      body += Buffer.from(chunk).toString("utf8");
    }
    requests.push(JSON.parse(body));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: `recording-${requests.length}`,
      model: "mock-model",
      content: [{ type: "text", text }],
      toolCalls: [],
      stopReason: "stop"
    }));
  });
}

function createSequenceGateway(responses) {
  let index = 0;
  return http.createServer(async (req, res) => {
    for await (const _chunk of req) {
      // Drain request body.
    }
    const response = responses[Math.min(index, responses.length - 1)] ?? {};
    index += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: `tool-gateway-${index}`,
      model: "mock-model",
      content: [{ type: "text", text: response.content ?? "" }],
      toolCalls: response.toolCalls ?? [],
      stopReason: response.stopReason ?? "stop"
    }));
  });
}

function createAuthRecordingGateway(requests, text, validKey) {
  return http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) {
      body += Buffer.from(chunk).toString("utf8");
    }
    requests.push({
      authorization: req.headers.authorization ?? "",
      body: JSON.parse(body)
    });
    if (req.headers.authorization !== `Bearer ${validKey}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({
        error: {
          message: "Invalid API Key",
          type: "invalid_key",
          code: "401"
        }
      }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: `auth-recording-${requests.length}`,
      model: "mock-model",
      content: [{ type: "text", text }],
      toolCalls: [],
      stopReason: "stop"
    }));
  });
}

function createDelayedGateway(texts, delayMs) {
  let calls = 0;
  return http.createServer(async (req, res) => {
    for await (const _ of req) {
      // Drain request body.
    }
    const text = texts[Math.min(calls, texts.length - 1)];
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: `delayed-${calls}`,
      model: "mock-model",
      content: [{ type: "text", text }],
      toolCalls: [],
      stopReason: "stop"
    }));
  });
}

function createFailingGateway() {
  return http.createServer(async (req, res) => {
    for await (const _ of req) {
      // Drain request body.
    }
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "mock gateway failure" }));
  });
}

function createRepeatedReadGateway() {
  let calls = 0;
  return http.createServer(async (req, res) => {
    for await (const _ of req) {
      // Drain request body.
    }
    calls += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: `dashboard-tool-limit-${calls}`,
      model: "mock-model",
      content: [],
      toolCalls: [{
        id: `dashboard-read-${calls}`,
        name: "read_file",
        input: { path: "notes.txt", maxBytes: 1024 }
      }],
      stopReason: "tool_calls"
    }));
  });
}

function createHangingStreamGateway() {
  return http.createServer(async (req, res) => {
    for await (const _ of req) {
      // Drain request body.
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ type: "message_start", id: "hanging", model: "mock-model" })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "text_delta", text: "partial draft" })}\n\n`);
  });
}

function createBackgroundWakeGateway(requests) {
  return http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) {
      raw += Buffer.from(chunk).toString("utf8");
    }
    const body = JSON.parse(raw || "{}");
    requests.push(body);
    res.writeHead(200, { "content-type": "application/json" });

    const sessionId = String(body.metadata?.sessionId ?? body.sessionId ?? "");
    if (sessionId.startsWith("agent-explorer-")) {
      res.end(JSON.stringify({
        id: "dashboard-background-child-final",
        model: "mock-model",
        content: [{ type: "text", text: "dashboard background child done" }],
        toolCalls: [],
        stopReason: "stop"
      }));
      return;
    }

    const parentCalls = requests.filter((item) => !String(item.sessionId ?? "").startsWith("agent-explorer-")).length;
    if (parentCalls === 1) {
      res.end(JSON.stringify({
        id: "dashboard-background-agent-run",
        model: "mock-model",
        content: [],
        toolCalls: [
          {
            id: "delegate-dashboard-background",
            name: "agent_run",
            input: {
              profile: "explorer",
              query: "inspect current workspace in background",
              background: true,
              groupId: "group-dashboard-bg",
              waitForGroup: "all",
              wakeParent: true
            }
          }
        ],
        stopReason: "tool_calls"
      }));
      return;
    }

    const lastMessage = body.messages?.at(-1)?.content ?? "";
    res.end(JSON.stringify({
      id: "dashboard-background-parent-final",
      model: "mock-model",
      content: [{ type: "text", text: /Ant Code subagent group completed/.test(String(lastMessage)) ? "parent consumed wake prompt" : "parent did not receive wake prompt" }],
      toolCalls: [],
      stopReason: "stop"
    }));
  });
}

function createQueueFullBackgroundWakeGateway(requests, firstParentGate, finishParentGate) {
  return http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) {
      raw += Buffer.from(chunk).toString("utf8");
    }
    const body = JSON.parse(raw || "{}");
    requests.push(body);
    const sessionId = String(body.metadata?.sessionId ?? body.sessionId ?? "");
    if (sessionId.startsWith("agent-explorer-")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "dashboard-queue-full-child-final",
        model: "mock-model",
        content: [{ type: "text", text: "queue full child done" }],
        toolCalls: [],
        stopReason: "stop"
      }));
      return;
    }

    const parentCalls = requests.filter((item) => !String(item.sessionId ?? "").startsWith("agent-explorer-")).length;
    if (parentCalls === 1) {
      await firstParentGate;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "dashboard-queue-full-agent-run",
        model: "mock-model",
        content: [],
        toolCalls: [{
          id: "delegate-dashboard-queue-full",
          name: "agent_run",
          input: {
            profile: "explorer",
            query: "finish while parent queue is full",
            background: true,
            groupId: "group-dashboard-queue-full",
            waitForGroup: "all",
            wakeParent: true
          }
        }],
        stopReason: "tool_calls"
      }));
      return;
    }

    await finishParentGate;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "dashboard-queue-full-parent-final",
      model: "mock-model",
      content: [{ type: "text", text: "parent finished without consuming overflow wake" }],
      toolCalls: [],
      stopReason: "stop"
    }));
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function createBackgroundAnyWakeGateway(requests) {
  return http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) {
      raw += Buffer.from(chunk).toString("utf8");
    }
    const body = JSON.parse(raw || "{}");
    requests.push(body);
    res.writeHead(200, { "content-type": "application/json" });

    const sessionId = String(body.metadata?.sessionId ?? body.sessionId ?? "");
    if (sessionId.startsWith("agent-explorer-")) {
      const slow = /slow sibling/.test(JSON.stringify(body.messages ?? []));
      if (slow) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      const text = slow ? "slow sibling done later" : "fast sibling done";
      res.end(JSON.stringify({
        id: `dashboard-background-any-${requests.length}`,
        model: "mock-model",
        content: [{ type: "text", text }],
        toolCalls: [],
        stopReason: "stop"
      }));
      return;
    }

    const parentCalls = requests.filter((item) => !String(item.sessionId ?? "").startsWith("agent-explorer-")).length;
    if (parentCalls === 1) {
      res.end(JSON.stringify({
        id: "dashboard-background-any-agent-run",
        model: "mock-model",
        content: [],
        toolCalls: [
          {
            id: "delegate-dashboard-any-fast",
            name: "agent_run",
            input: {
              profile: "explorer",
              query: "fast sibling",
              background: true,
              groupId: "group-dashboard-any",
              waitForGroup: "any",
              wakeParent: true
            }
          },
          {
            id: "delegate-dashboard-any-slow",
            name: "agent_run",
            input: {
              profile: "explorer",
              query: "slow sibling",
              background: true,
              groupId: "group-dashboard-any",
              waitForGroup: "any",
              wakeParent: true
            }
          }
        ],
        stopReason: "tool_calls"
      }));
      return;
    }

    const lastMessage = body.messages?.at(-1)?.content ?? "";
    res.end(JSON.stringify({
      id: "dashboard-background-any-parent-final",
      model: "mock-model",
      content: [{ type: "text", text: /Ant Code subagent group completed/.test(String(lastMessage)) ? "parent consumed any wake prompt" : "parent missed any wake prompt" }],
      toolCalls: [],
      stopReason: "stop"
    }));
  });
}

function createToolGateway() {
  let calls = 0;
  return http.createServer(async (req, res) => {
    for await (const _ of req) {
      // Drain request body.
    }
    calls += 1;
    res.writeHead(200, { "content-type": "application/json" });
    if (calls === 1) {
      res.end(JSON.stringify({
        id: "tool-request",
        model: "mock-model",
        content: [],
        toolCalls: [
          {
            id: "write-1",
            name: "write_file",
            input: {
              path: "denied.md",
              content: "should not be written"
            }
          }
        ],
        stopReason: "tool_calls"
      }));
      return;
    }
    res.end(JSON.stringify({
      id: "final-after-deny",
      model: "mock-model",
      content: [{ type: "text", text: "write was denied" }],
      toolCalls: [],
      stopReason: "stop"
    }));
  });
}

function createWriteGateway() {
  let calls = 0;
  return http.createServer(async (req, res) => {
    for await (const _ of req) {
      // Drain request body.
    }
    calls += 1;
    res.writeHead(200, { "content-type": "application/json" });
    if (calls === 1) {
      res.end(JSON.stringify({
        id: "write-request",
        model: "mock-model",
        content: [],
        toolCalls: [
          {
            id: "write-1",
            name: "write_file",
            input: {
              path: "created.md",
              content: "alpha\nbeta"
            }
          }
        ],
        stopReason: "tool_calls"
      }));
      return;
    }
    res.end(JSON.stringify({
      id: "write-final",
      model: "mock-model",
      content: [{ type: "text", text: "write complete" }],
      toolCalls: [],
      stopReason: "stop"
    }));
  });
}

function createRepeatedEditGateway() {
  let calls = 0;
  return http.createServer(async (req, res) => {
    for await (const _ of req) {
      // Drain request body.
    }
    calls += 1;
    res.writeHead(200, { "content-type": "application/json" });
    if (calls === 1) {
      res.end(JSON.stringify({
        id: "edit-request-1",
        model: "mock-model",
        content: [],
        toolCalls: [
          {
            id: "edit-1",
            name: "edit_file",
            input: {
              path: "notes.md",
              oldText: "beta",
              newText: "delta"
            }
          }
        ],
        stopReason: "tool_calls"
      }));
      return;
    }
    if (calls === 2) {
      res.end(JSON.stringify({
        id: "edit-request-2",
        model: "mock-model",
        content: [],
        toolCalls: [
          {
            id: "edit-2",
            name: "edit_file",
            input: {
              path: "notes.md",
              oldText: "gamma",
              newText: "omega"
            }
          }
        ],
        stopReason: "tool_calls"
      }));
      return;
    }
    res.end(JSON.stringify({
      id: "edit-final",
      model: "mock-model",
      content: [{ type: "text", text: "edits complete" }],
      toolCalls: [],
      stopReason: "stop"
    }));
  });
}

function createTodoGateway() {
  let calls = 0;
  return http.createServer(async (req, res) => {
    for await (const _ of req) {
      // Drain request body.
    }
    calls += 1;
    res.writeHead(200, { "content-type": "application/json" });
    if (calls === 1) {
      res.end(JSON.stringify({
        id: "todo-request",
        model: "mock-model",
        content: [],
        toolCalls: [
          {
            id: "todo-1",
            name: "todo_write",
            input: {
              items: [
                { content: "确认需求", status: "进行中" },
                { content: "汇总结果", status: "待办" }
              ]
            }
          }
        ],
        stopReason: "tool_calls"
      }));
      return;
    }
    res.end(JSON.stringify({
      id: "todo-final",
      model: "mock-model",
      content: [{ type: "text", text: "全部待办已完成。" }],
      toolCalls: [],
      stopReason: "stop"
    }));
  });
}

function createHangingGateway() {
  return http.createServer(async (req, res) => {
    for await (const _ of req) {
      // Drain request body, then deliberately never complete the response.
    }
    res.writeHead(200, { "content-type": "application/json" });
  });
}

function createQuestionGateway() {
  let calls = 0;
  return http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) {
      body += Buffer.from(chunk).toString("utf8");
    }
    calls += 1;
    res.writeHead(200, { "content-type": "application/json" });
    if (calls === 1) {
      res.end(JSON.stringify({
        id: "question-request",
        model: "mock-model",
        content: [],
        toolCalls: [
          {
            id: "question-1",
            name: "ask_user",
            input: {
              header: "需求核对",
              question: "输出格式选哪种？",
              choices: [
                { label: "Markdown", value: "md", description: "生成可直接阅读的 Markdown" },
                { label: "PDF", value: "pdf" }
              ],
              multiple: true,
              allowCustom: true,
              confirmLabel: "继续"
            }
          }
        ],
        stopReason: "tool_calls"
      }));
      return;
    }

    const parsed = JSON.parse(body);
    const toolResults = parsed.toolResults ?? [];
    const answerText = JSON.stringify(toolResults);
    const cancelled = toolResults.some((result) => {
      try {
        return JSON.parse(result.content)?.result?.cancelled === true;
      } catch {
        return false;
      }
    });
    res.end(JSON.stringify({
      id: "question-final",
      model: "mock-model",
      content: [{
        type: "text",
        text: cancelled
          ? "已取消需求核对。"
          : `已按 Markdown 继续，并保留图表说明。${answerText.includes("workflowReminder") ? " 已收到 workflow 提醒。" : ""}`
      }],
      toolCalls: [],
      stopReason: "stop"
    }));
  });
}

function listen(server, host, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(resolve);
  });
}

function mockGatewayEnv(server, extra = {}) {
  const address = server.address();
  return {
    LAB_MODEL_GATEWAY_URL: `http://127.0.0.1:${address.port}`,
    LAB_MODEL_GATEWAY_PROTOCOL: "lab-agent-gateway",
    LAB_MODEL_GATEWAY_MAX_RETRIES: "0",
    ...extra
  };
}
