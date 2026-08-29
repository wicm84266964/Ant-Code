import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAgentTaskGroupStore } from "../../src/agents/task-group-store.js";
import { createAgentTaskStore } from "../../src/agents/task-store.js";
import { registerBackgroundTerminalTask } from "../../src/agents/background-terminal-registry.js";
import { createFileRepository } from "../../src/config-v2/file-repository.js";
import { createCredentialStore } from "../../src/credentials/store.js";
import { withConfigMutationLock } from "../../src/dashboard/config-store.js";
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
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: cwd } });
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
  const runtime = createDashboardRuntime({ cwd, env: mockGatewayEnv(server, { LAB_AGENT_MODEL: "status-model" }) });

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

test("dashboard runtime switches model sources and reasoning effort in one request", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-source-switch-"));
  const requests = [];
  const server = await listen(createRecordingGateway(requests, "first source answer"), "127.0.0.1", 0);
  const localUrl = `http://127.0.0.1:${server.address().port}`;
  const grokUrl = "https://grok.gateway.example/sub2api/v1/responses";
  await fs.writeFile(path.join(cwd, "lab-agent.config.json"), JSON.stringify({
    modelAlias: "local-model",
    models: [{ id: "local-model", label: "Local Model" }],
    networkMode: "open-dev",
    allowedHosts: ["127.0.0.1", "grok.gateway.example"],
    lab: {
      gatewayUrl: localUrl,
      gatewayProtocol: "lab-agent-gateway",
      activeGatewayProfile: "local-source",
      gatewayProfiles: [
        {
          id: "local-source",
          label: "Local",
          gatewayUrl: localUrl,
          gatewayProtocol: "lab-agent-gateway",
          modelAlias: "local-model",
          models: [{ id: "local-model", label: "Local Model" }]
        },
        {
          id: "grok-source",
          label: "Grok",
          gatewayUrl: grokUrl,
          gatewayProtocol: "openai-responses",
          modelAlias: "grok-4.6",
          models: [{
            id: "grok-4.6",
            label: "Grok 4.6",
            reasoningEfforts: ["low", "medium", "high"],
            defaultReasoningEffort: "high"
          }]
        }
      ]
    }
  }), "utf8");
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: cwd } });

  try {
    await runtime.trustWorkspace();
    const started = await runtime.startTurn({ prompt: "open a session", permissionMode: "plan" });
    await waitForEvent(runtime, started.sessionId, (event) => event.type === "files_updated");

    const switched = await runtime.switchModel({
      sessionId: started.sessionId,
      profileId: "grok-source",
      modelId: "grok-4.6",
      reasoningEffort: "medium"
    });

    assert.equal(switched.ok, true);
    assert.equal(switched.sessionStatus.model, "grok-4.6");
    assert.equal(switched.sessionStatus.reasoningEffort, "medium");
    assert.equal(switched.gatewayConfig.gatewayUrl, grokUrl);
    assert.equal(switched.gatewayConfig.gatewayProtocol, "openai-responses");
    assert.deepEqual(switched.models.map((model) => model.id), ["grok-4.6"]);
    assert.equal(runtime.active.get(started.sessionId).session.config.lab.gatewayUrl, grokUrl);
    assert.equal(runtime.active.get(started.sessionId).session.config.lab.gatewayProtocol, "openai-responses");
  } finally {
    await close(server);
  }
});

test("dashboard runtime clears an explicit reasoning override without resolving it to the model default", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-reasoning-"));
  await fs.writeFile(path.join(cwd, "lab-agent.config.json"), JSON.stringify({
    modelAlias: "grok-4.6",
    models: [{
      id: "grok-4.6",
      reasoningEfforts: ["low", "medium", "high"],
      defaultReasoningEffort: "high"
    }]
  }), "utf8");
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: cwd } });

  const medium = await runtime.switchReasoningEffort({ reasoningEffort: "medium" });
  assert.equal(medium.ok, true);
  assert.equal(medium.sessionStatus.reasoningEffort, "medium");

  const reset = await runtime.switchReasoningEffort({ reasoningEffort: null });
  assert.equal(reset.ok, true);
  assert.equal(reset.sessionStatus.reasoningEffort, null);

  const refreshed = await runtime.status();
  assert.equal(refreshed.sessionStatus.reasoningEffort, null);

  const invalid = await runtime.switchReasoningEffort({ reasoningEffort: "ultra" });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.status, 400);
});

test("dashboard keeps a cleared legacy session effort across the next turn", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-reasoning-next-turn-"));
  const requests = [];
  const server = await listen(createRecordingGateway(requests, "reasoning answer"), "127.0.0.1", 0);
  const origin = `http://127.0.0.1:${server.address().port}`;
  await fs.writeFile(path.join(cwd, "lab-agent.config.json"), JSON.stringify({
    modelAlias: "grok-4.6",
    reasoningEffort: "high",
    models: [{
      id: "grok-4.6",
      reasoningEfforts: ["low", "medium", "high"],
      defaultReasoningEffort: "high"
    }],
    networkMode: "open-dev",
    allowedHosts: ["127.0.0.1"],
    lab: {
      gatewayUrl: origin,
      gatewayProtocol: "lab-agent-gateway"
    }
  }), "utf8");
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: cwd } });

  try {
    await runtime.trustWorkspace();
    const started = await runtime.startTurn({ prompt: "first turn", permissionMode: "plan" });
    await waitForCondition(() => runtime.active.get(started.sessionId)?.running === false);

    const reset = await runtime.switchReasoningEffort({
      sessionId: started.sessionId,
      reasoningEffort: null
    });
    assert.equal(reset.ok, true);
    assert.equal(reset.sessionStatus.reasoningEffort, null);

    const next = await runtime.startTurn({
      sessionId: started.sessionId,
      prompt: "second turn",
      permissionMode: "plan"
    });
    assert.equal(next.ok, true);
    assert.equal(next.sessionStatus.reasoningEffort, null);
    assert.equal(runtime.active.get(started.sessionId).session.config.reasoningEffort, null);

    await waitForCondition(() => runtime.active.get(started.sessionId)?.running === false);
    assert.equal(runtime.active.get(started.sessionId).session.config.reasoningEffort, null);
    assert.equal(requests.length, 2);
  } finally {
    await runtime.shutdown({ force: true, timeoutMs: 100 });
    await close(server);
  }
});

test("dashboard model switches distinguish omitted, cleared, and undeclared defaults", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-model-reasoning-defaults-"));
  await fs.writeFile(path.join(cwd, "lab-agent.config.json"), JSON.stringify({
    modelAlias: "with-default",
    reasoningEffort: "high",
    models: [
      {
        id: "with-default",
        reasoningEfforts: ["low", "high"],
        defaultReasoningEffort: "high"
      },
      {
        id: "without-default",
        reasoningEfforts: ["low", "high"]
      }
    ]
  }), "utf8");
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: cwd } });

  const cleared = await runtime.switchModel({
    modelId: "with-default",
    reasoningEffort: null
  });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.sessionStatus.reasoningEffort, null);

  const clearedByKeyword = await runtime.switchModel({
    modelId: "with-default",
    reasoningEffort: "default"
  });
  assert.equal(clearedByKeyword.ok, true);
  assert.equal(clearedByKeyword.sessionStatus.reasoningEffort, null);

  const inherited = await runtime.switchModel({ modelId: "with-default" });
  assert.equal(inherited.ok, true);
  assert.equal(inherited.sessionStatus.reasoningEffort, "high");

  const noDefault = await runtime.switchModel({ modelId: "without-default" });
  assert.equal(noDefault.ok, true);
  assert.equal(noDefault.sessionStatus.reasoningEffort, null);
  assert.equal(noDefault.models.find((model) => model.id === "without-default")?.reasoningEffort, null);

  await runtime.shutdown({ force: true, timeoutMs: 100 });
});

test("dashboard runtime throttles retention maintenance and immediately applies saved retention", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-retention-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-home-retention-"));
  const configDir = path.join(cwd, ".lab-agent");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(path.join(configDir, "config.json"), JSON.stringify({
    transcript: { enabled: true, retentionDays: 1, encryption: "off" }
  }), "utf8");
  const transcript = { enabled: true, retentionDays: 1, encryption: "off" };
  const store = createSessionStore({ cwd, transcript, env: { USERPROFILE: home } });
  const oldArchive = await store.writeTranscriptChunks("old-session", [{ role: "user", content: "old" }]);
  const oldPath = await store.writeMetadata({ id: "old-session", transcript: { archive: oldArchive } });
  const freshArchive = await store.writeTranscriptChunks("fresh-session", [{ role: "user", content: "fresh" }]);
  await store.writeMetadata({ id: "fresh-session", transcript: { archive: freshArchive } });
  const oldTime = new Date("2020-01-01T00:00:00.000Z");
  await fs.utimes(oldPath, oldTime, oldTime);
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: home } });

  const status = await runtime.status();
  assert.equal(status.ok, true);
  assert.equal((await store.readMetadataExact("old-session")).ok, false);
  await assert.rejects(fs.access(path.join(store.root, "old-session.transcript")), { code: "ENOENT" });
  assert.equal((await store.readMetadataExact("fresh-session")).ok, true);

  const lateArchive = await store.writeTranscriptChunks("late-session", [{ role: "user", content: "late" }]);
  const latePath = await store.writeMetadata({ id: "late-session", transcript: { archive: lateArchive } });
  await fs.utimes(latePath, oldTime, oldTime);
  const listed = await runtime.listSessionRecords();
  assert.equal(listed.some((record) => record.id === "late-session"), true);

  runtime.active.set("fresh-session", { session: { id: "fresh-session" } });
  const saved = await runtime.saveSettingsConfig({
    section: "transcript",
    saveTarget: "project",
    settings: { enabled: true, retentionDays: 0, encryption: "off" }
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.settings.transcript.retentionDays, 0);
  assert.equal((await store.readMetadataExact("late-session")).ok, false);
  await assert.rejects(fs.access(path.join(store.root, "late-session.transcript")), { code: "ENOENT" });
  assert.equal((await store.readMetadataExact("fresh-session")).ok, true);
  assert.equal((await store.readTranscriptPage(freshArchive)).messages.length, 1);

  runtime.active.delete("fresh-session");
  const repeated = await runtime.saveSettingsConfig({
    section: "transcript",
    saveTarget: "project",
    settings: { enabled: true, retentionDays: 0, encryption: "off" }
  });
  assert.equal(repeated.ok, true);
  assert.equal((await store.readMetadataExact("fresh-session")).ok, false);
  await assert.rejects(fs.access(path.join(store.root, "fresh-session.transcript")), { code: "ENOENT" });
});

test("dashboard runtime saves each settings section with whitelisted deep merges", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-settings-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-home-settings-"));
  const configDir = path.join(cwd, ".lab-agent");
  const configPath = path.join(configDir, "config.json");
  const original = {
    modelAlias: "kept-model",
    models: [{ id: "kept-model" }],
    customTopLevel: { keep: "top-level" },
    networkMode: "approved-web",
    allowedHosts: ["legacy.example"],
    transcript: {
      enabled: true,
      retentionDays: 30,
      encryption: "off",
      customTranscript: "keep"
    },
    agents: {
      customAgentSetting: "keep",
      syncModelTiersOnSwitch: true,
      orchestration: {
        maxParallelReadonlyAgentRuns: 3,
        customOrchestration: "keep"
      },
      backgroundWakeup: {
        enabled: true,
        defaultForModelAgentRun: false,
        customBackground: "keep"
      },
      reviewGate: {
        enabled: true,
        customReview: "keep"
      }
    },
    lab: {
      gatewayUrl: "https://gateway.example/v1/responses",
      gatewayProtocol: "openai-responses",
      gatewayApiKey: "stored-secret",
      gatewayApiKeyDisabled: true,
      gatewayProfiles: [{
        id: "kept-profile",
        gatewayUrl: "https://gateway.example/v1/responses",
        gatewayProtocol: "openai-responses",
        gatewayApiKey: "profile-secret",
        modelAlias: "kept-model",
        models: [{ id: "kept-model" }]
      }],
      gatewayMaxRetries: 1,
      gatewayTimeoutMs: 20000,
      gatewayIdleTimeoutMs: 5000,
      customLab: "keep"
    }
  };
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(original), "utf8");
  const runtime = createDashboardRuntime({
    cwd,
    env: { USERPROFILE: home, LAB_AGENT_TRANSCRIPT_KEY: "test-transcript-key" }
  });

  const transcript = await runtime.saveSettingsConfig({
    section: "transcript",
    saveTarget: "project",
    settings: {
      enabled: true,
      retentionDays: 3650,
      encryption: "required",
      customTranscript: "replace-attempt",
      gatewayApiKey: "replace-attempt"
    }
  });
  assert.equal(transcript.ok, true);
  assert.equal(transcript.settings.transcript.retentionDays, 3650);
  assert.equal(transcript.settings.transcript.encryption, "required");

  const permanentTranscript = await runtime.saveSettingsConfig({
    section: "transcript",
    saveTarget: "project",
    settings: {
      enabled: true,
      retentionDays: null,
      encryption: "required"
    }
  });
  assert.equal(permanentTranscript.ok, true);
  assert.equal(permanentTranscript.settings.transcript.retentionDays, null);

  const network = await runtime.saveSettingsConfig({
    section: "network",
    saveTarget: "project",
    settings: {
      networkMode: "offline",
      allowedHosts: ["API.EXAMPLE", "api.example.", "worker.example"]
    }
  });
  assert.equal(network.ok, true);
  assert.equal(network.settings.network.mode, "offline");
  assert.deepEqual(network.settings.network.allowedHosts, ["api.example", "worker.example", "gateway.example"]);

  const agents = await runtime.saveSettingsConfig({
    section: "agents",
    saveTarget: "project",
    settings: {
      maxParallelReadonlyAgentRuns: 8,
      backgroundWakeupEnabled: false,
      backgroundByDefault: true,
      reviewGateEnabled: false,
      syncModelTiersOnSwitch: false,
      customAgentSetting: "replace-attempt"
    }
  });
  assert.equal(agents.ok, true);
  assert.deepEqual(agents.settings.agents, {
    maxParallelReadonlyAgentRuns: 8,
    backgroundWakeupEnabled: false,
    backgroundByDefault: true,
    reviewGateEnabled: false,
    syncModelTiersOnSwitch: false,
    goalMaxAutoContinues: 12
  });

  const reliability = await runtime.saveSettingsConfig({
    section: "reliability",
    saveTarget: "project",
    settings: {
      maxRetries: 5,
      timeoutMs: 900000,
      idleTimeoutMs: 300000,
      gatewayProfiles: []
    }
  });
  assert.equal(reliability.ok, true);
  assert.deepEqual(reliability.settings.reliability, {
    maxRetries: 5,
    timeoutMs: 900000,
    idleTimeoutMs: 300000
  });

  const saved = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.deepEqual(saved.customTopLevel, original.customTopLevel);
  assert.equal(saved.transcript.customTranscript, "keep");
  assert.equal(saved.agents.customAgentSetting, "keep");
  assert.equal(saved.agents.orchestration.customOrchestration, "keep");
  assert.equal(saved.agents.backgroundWakeup.customBackground, "keep");
  assert.equal(saved.agents.reviewGate.customReview, "keep");
  assert.deepEqual(saved.lab.gatewayProfiles, original.lab.gatewayProfiles);
  assert.equal(saved.lab.gatewayApiKey, "stored-secret");
  assert.equal(saved.lab.gatewayApiKeyDisabled, true);
  assert.equal(saved.lab.customLab, "keep");
});

test("dashboard runtime persists only changed settings fields and keeps legacy section writes", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-changed-settings-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-home-changed-settings-"));
  const globalDir = path.join(home, ".ant-code");
  const projectDir = path.join(cwd, ".lab-agent");
  const projectPath = path.join(projectDir, "config.json");
  await fs.mkdir(globalDir, { recursive: true });
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(path.join(globalDir, "lab-agent.config.json"), JSON.stringify({
    transcript: { enabled: true, retentionDays: 30, encryption: "optional" }
  }), "utf8");
  await fs.writeFile(projectPath, JSON.stringify({ marker: "keep" }), "utf8");
  const runtime = createDashboardRuntime({
    cwd,
    env: { USERPROFILE: home, LAB_AGENT_TRANSCRIPT_ENABLED: "false" }
  });
  const current = (await runtime.status()).settings.transcript;

  const changed = await runtime.saveSettingsConfig({
    section: "transcript",
    saveTarget: "project",
    changedFields: ["retentionDays"],
    settings: { ...current, retentionDays: 45 }
  });
  assert.equal(changed.ok, true);
  assert.deepEqual(JSON.parse(await fs.readFile(projectPath, "utf8")), {
    marker: "keep",
    transcript: { retentionDays: 45 }
  });

  const legacy = await runtime.saveSettingsConfig({
    section: "transcript",
    saveTarget: "project",
    settings: { ...current, retentionDays: 60, encryption: "off" }
  });
  assert.equal(legacy.ok, true);
  assert.deepEqual(JSON.parse(await fs.readFile(projectPath, "utf8")), {
    marker: "keep",
    transcript: { retentionDays: 60, encryption: "off" }
  });
});

test("dashboard runtime omits environment-managed reliability fields while saving siblings", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-managed-reliability-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-home-managed-reliability-"));
  const configDir = path.join(cwd, ".lab-agent");
  const configPath = path.join(configDir, "config.json");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(configPath, JSON.stringify({ lab: { customLab: "keep" } }), "utf8");
  const runtime = createDashboardRuntime({
    cwd,
    env: { USERPROFILE: home, LAB_MODEL_GATEWAY_MAX_RETRIES: "2" }
  });
  const current = (await runtime.status()).settings.reliability;

  const saved = await runtime.saveSettingsConfig({
    section: "reliability",
    saveTarget: "project",
    changedFields: ["maxRetries", "timeoutMs"],
    settings: { ...current, timeoutMs: 6000 }
  });

  assert.equal(saved.ok, true);
  assert.deepEqual(JSON.parse(await fs.readFile(configPath, "utf8")), {
    lab: { customLab: "keep", gatewayTimeoutMs: 6000 }
  });
});

test("dashboard runtime omits managed hosts and publishes sensitivity-specific network modes", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-network-settings-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-home-network-settings-"));
  const configDir = path.join(cwd, ".lab-agent");
  const configPath = path.join(configDir, "config.json");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(configPath, JSON.stringify({
    networkMode: "approved-web",
    allowedHosts: ["existing.example"],
    lab: {
      gatewayUrl: "https://project.gateway.example/v1/chat/completions",
      gatewayProtocol: "openai-chat"
    }
  }), "utf8");
  const runtime = createDashboardRuntime({
    cwd,
    env: {
      USERPROFILE: home,
      LAB_AGENT_ALLOWED_HOSTS: "managed.example,shared.example",
      LAB_MODEL_GATEWAY_URL: "https://environment.gateway.example/v1/chat/completions"
    }
  });
  const status = await runtime.status();
  assert.equal(status.settings.network.sensitivity, "standard");
  assert.deepEqual(status.settings.network.allowedModes, ["offline", "lab-only", "approved-web", "open-dev"]);

  const saved = await runtime.saveSettingsConfig({
    section: "network",
    saveTarget: "project",
    changedFields: ["allowedHosts"],
    settings: {
      mode: status.settings.network.mode,
      allowedHosts: ["user.example", "managed.example", "environment.gateway.example"]
    }
  });
  assert.equal(saved.ok, true);
  const project = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.ok(project.allowedHosts.includes("user.example"));
  assert.ok(project.allowedHosts.includes("project.gateway.example"));
  assert.equal(project.allowedHosts.includes("managed.example"), false);
  assert.equal(project.allowedHosts.includes("shared.example"), false);
  assert.equal(project.allowedHosts.includes("environment.gateway.example"), false);

  const highCwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-high-sensitivity-settings-"));
  await fs.writeFile(path.join(highCwd, "lab-agent.config.json"), JSON.stringify({
    networkMode: "offline",
    security: { sensitivity: "high" }
  }), "utf8");
  const highRuntime = createDashboardRuntime({ cwd: highCwd, env: {} });
  const highStatus = await highRuntime.status();
  assert.equal(highStatus.settings.network.sensitivity, "high");
  assert.deepEqual(highStatus.settings.network.allowedModes, ["offline", "lab-only"]);
});

test("dashboard runtime rejects settings managed by environment variables", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-managed-settings-"));
  const runtime = createDashboardRuntime({
    cwd,
    env: {
      USERPROFILE: cwd,
      LAB_AGENT_NETWORK_MODE: "offline",
      LAB_AGENT_TRANSCRIPT_ENABLED: "false",
      LAB_AGENT_TRANSCRIPT_RETENTION_DAYS: "7",
      LAB_AGENT_TRANSCRIPT_ENCRYPTION: "off",
      LAB_MODEL_GATEWAY_MAX_RETRIES: "2",
      LAB_MODEL_GATEWAY_TIMEOUT_MS: "5000",
      LAB_MODEL_GATEWAY_IDLE_TIMEOUT_MS: "3000"
    }
  });
  const current = (await runtime.status()).settings;
  const cases = [
    {
      envName: "LAB_AGENT_TRANSCRIPT_ENABLED",
      input: {
        section: "transcript",
        settings: { ...current.transcript, enabled: true }
      }
    },
    {
      envName: "LAB_AGENT_TRANSCRIPT_RETENTION_DAYS",
      input: {
        section: "transcript",
        settings: { ...current.transcript, retentionDays: 8 }
      }
    },
    {
      envName: "LAB_AGENT_TRANSCRIPT_ENCRYPTION",
      input: {
        section: "transcript",
        settings: { ...current.transcript, encryption: "optional" }
      }
    },
    {
      envName: "LAB_AGENT_NETWORK_MODE",
      input: {
        section: "network",
        settings: { networkMode: "open-dev", allowedHosts: [] }
      }
    },
    {
      envName: "LAB_MODEL_GATEWAY_MAX_RETRIES",
      input: {
        section: "reliability",
        settings: { ...current.reliability, maxRetries: 3 }
      }
    },
    {
      envName: "LAB_MODEL_GATEWAY_TIMEOUT_MS",
      input: {
        section: "reliability",
        settings: { ...current.reliability, timeoutMs: 6000 }
      }
    },
    {
      envName: "LAB_MODEL_GATEWAY_IDLE_TIMEOUT_MS",
      input: {
        section: "reliability",
        settings: { ...current.reliability, idleTimeoutMs: 4000 }
      }
    }
  ];

  for (const testCase of cases) {
    const result = await runtime.saveSettingsConfig({
      saveTarget: "project",
      ...testCase.input
    });
    assert.equal(result.ok, false, testCase.envName);
    assert.equal(result.status, 409, testCase.envName);
    assert.match(result.error, new RegExp(testCase.envName), testCase.envName);
  }
});

test("dashboard runtime validates settings boundaries and required transcript encryption", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-invalid-settings-"));
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: cwd } });
  const validAgents = {
    maxParallelReadonlyAgentRuns: 3,
    backgroundWakeupEnabled: true,
    backgroundByDefault: false,
    reviewGateEnabled: true,
    syncModelTiersOnSwitch: true
  };
  const validReliability = { maxRetries: 2, timeoutMs: 5000, idleTimeoutMs: 3000 };
  const cases = [
    {
      label: "retention below minimum",
      section: "transcript",
      settings: { enabled: true, retentionDays: -1, encryption: "off" },
      error: /永久.*0.*3650/
    },
    {
      label: "retention above maximum",
      section: "transcript",
      settings: { enabled: true, retentionDays: 3651, encryption: "off" },
      error: /永久.*0.*3650/
    },
    {
      label: "unsupported network mode",
      section: "network",
      settings: { networkMode: "tunneled", allowedHosts: [] },
      error: /tunneled/
    },
    {
      label: "invalid network host",
      section: "network",
      settings: { networkMode: "approved-web", allowedHosts: ["https://bad.example"] },
      error: /bad\.example/
    },
    {
      label: "agent count below minimum",
      section: "agents",
      settings: { ...validAgents, maxParallelReadonlyAgentRuns: 0 },
      error: /1.*8/
    },
    {
      label: "agent count above maximum",
      section: "agents",
      settings: { ...validAgents, maxParallelReadonlyAgentRuns: 9 },
      error: /1.*8/
    },
    {
      label: "goal continue cap below minimum",
      section: "agents",
      settings: { ...validAgents, goalMaxAutoContinues: 0 },
      error: /1.*100/
    },
    {
      label: "goal continue cap above maximum",
      section: "agents",
      settings: { ...validAgents, goalMaxAutoContinues: 101 },
      error: /1.*100/
    },
    {
      label: "retry count below minimum",
      section: "reliability",
      settings: { ...validReliability, maxRetries: -1 },
      error: /0.*5/
    },
    {
      label: "retry count above maximum",
      section: "reliability",
      settings: { ...validReliability, maxRetries: 6 },
      error: /0.*5/
    },
    {
      label: "total timeout below minimum",
      section: "reliability",
      settings: { ...validReliability, timeoutMs: 999 },
      error: /1.*900/
    },
    {
      label: "total timeout above maximum",
      section: "reliability",
      settings: { ...validReliability, timeoutMs: 900001 },
      error: /1.*900/
    },
    {
      label: "idle timeout below minimum",
      section: "reliability",
      settings: { ...validReliability, idleTimeoutMs: 999 },
      error: /1.*300/
    },
    {
      label: "idle timeout above maximum",
      section: "reliability",
      settings: { ...validReliability, idleTimeoutMs: 300001 },
      error: /1.*300/
    }
  ];

  for (const testCase of cases) {
    const result = await runtime.saveSettingsConfig({
      section: testCase.section,
      saveTarget: "project",
      settings: testCase.settings
    });
    assert.equal(result.ok, false, testCase.label);
    assert.equal(result.status, 400, testCase.label);
    assert.match(result.error, testCase.error, testCase.label);
  }

  const encryption = await runtime.saveSettingsConfig({
    section: "transcript",
    saveTarget: "project",
    settings: { enabled: true, retentionDays: 1, encryption: "required" }
  });
  assert.equal(encryption.ok, false);
  assert.equal(encryption.status, 400);
  assert.match(encryption.error, /LAB_AGENT_TRANSCRIPT_KEY/);
});

test("dashboard runtime refuses settings writes for a running session", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-running-settings-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-home-running-settings-"));
  const configDir = path.join(cwd, ".lab-agent");
  const configPath = path.join(configDir, "config.json");
  const originalText = JSON.stringify({
    marker: "unchanged",
    transcript: { enabled: true, retentionDays: 30, encryption: "off" }
  });
  const gate = deferred();
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(configPath, originalText, "utf8");
  const runtime = createDashboardRuntime({
    cwd,
    env: { USERPROFILE: home },
    runTurn: async (_session, options) => {
      await gate.promise;
      await options.onEvent({ type: "turn_complete", status: "completed" });
      return { output: "finished" };
    }
  });
  let started;

  try {
    await runtime.trustWorkspace();
    started = await runtime.startTurn({ prompt: "keep settings locked", permissionMode: "plan" });
    assert.equal(runtime.active.get(started.sessionId).running, true);

    const blocked = await runtime.saveSettingsConfig({
      section: "transcript",
      saveTarget: "project",
      sessionId: started.sessionId,
      settings: { enabled: false, retentionDays: 0, encryption: "off" }
    });

    assert.equal(blocked.ok, false);
    assert.equal(blocked.status, 409);
    assert.equal(await fs.readFile(configPath, "utf8"), originalText);
  } finally {
    gate.resolve();
    if (started?.sessionId) {
      await waitForEvent(runtime, started.sessionId, (event) => event.type === "run_state" && event.running === false);
    }
  }
});

test("dashboard runtime probes an OpenAI Responses model catalog", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-probe-"));
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      data: [{
        id: "grok-4.6",
        owned_by: "xai",
        supportsReasoningEffort: true,
        reasoningEfforts: ["low", "medium", "high"],
        defaultReasoningEffort: "high"
      }]
    }));
  });
  await listen(server, "127.0.0.1", 0);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const baseUrl = `${origin}/sub2api/v1?tenant=alpha`;
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: cwd } });

  try {
    const result = await runtime.probeGateway({
      gatewayUrl: baseUrl,
      gatewayProtocol: "openai-responses",
      gatewayApiKey: "probe-secret",
      credentialAction: "replace"
    });

    assert.equal(result.ok, true);
    assert.equal(result.modelsUrl, `${origin}/sub2api/v1/models?tenant=alpha`);
    assert.equal(result.suggestedGatewayUrl, `${origin}/sub2api/v1/responses?tenant=alpha`);
    assert.equal(result.modelCount, 1);
    assert.deepEqual(result.models[0].reasoningEfforts.map((effort) => effort.id), ["low", "medium", "high"]);
    assert.equal(result.models[0].defaultReasoningEffort, "high");
    assert.deepEqual(requests, [{ url: "/sub2api/v1/models?tenant=alpha", authorization: "Bearer probe-secret" }]);
  } finally {
    await close(server);
  }
});

test("dashboard gateway discovery proof is opaque, bounded, context-bound, retryable, and consumed only after success", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-discovery-proof-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-home-discovery-proof-"));
  const settingsPath = path.join(home, ".ant-code", "settings.json");
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify({ settingsVersion: 2, namespaces: {} }), "utf8");
  const server = await listen(http.createServer((req, res) => {
    assert.equal(req.url, "/v1/models");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      data: [
        { id: "catalog-main", display_name: "Catalog Main" },
        {
          id: "catalog-worker",
          display_name: "Catalog Worker",
          context_window: 131_072,
          input_modalities: ["text", "image"]
        }
      ]
    }));
  }), "127.0.0.1", 0);
  const gatewayUrl = `http://127.0.0.1:${server.address().port}/v1/responses`;
  const now = 10_000;
  const runtime = createDashboardRuntime({
    cwd,
    env: { USERPROFILE: home },
    gatewayDiscoveryTtlMs: Number.MAX_SAFE_INTEGER,
    gatewayDiscoveryNow: () => now
  });
  const initialStatus = await runtime.status();
  const identity = {
    saveTarget: "global",
    expectedRevision: initialStatus.configV2.revisions.global,
    expectedCredentialsRevision: initialStatus.configV2.revisions.credentials,
    clientId: "proof-client",
    profileId: "",
    gatewayUrl,
    gatewayProtocol: "openai-responses",
    gatewayApiKey: "proof-key",
    credentialAction: "replace"
  };

  try {
    const probe = await runtime.probeGateway(identity);
    assert.equal(probe.ok, true);
    assert.match(probe.discoveryToken, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Date.parse(probe.discoveryExpiresAt), now + 5 * 60 * 1000);
    assert.doesNotMatch(probe.discoveryToken, /proof|catalog|client|key/i);

    const rejectedContexts = [
      { gatewayDiscoveryToken: "forged-discovery-token" },
      { gatewayDiscoveryToken: probe.discoveryToken, gatewayUrl: `${gatewayUrl}?changed=true` },
      { gatewayDiscoveryToken: probe.discoveryToken, gatewayProtocol: "openai-chat" },
      { gatewayDiscoveryToken: probe.discoveryToken, profileId: "foreign-provider" },
      { gatewayDiscoveryToken: probe.discoveryToken, saveTarget: "project" },
      { gatewayDiscoveryToken: probe.discoveryToken, clientId: "foreign-client" },
      { gatewayDiscoveryToken: probe.discoveryToken, gatewayApiKey: "different-key" }
    ];
    for (const changed of rejectedContexts) {
      const rejected = await runtime.saveModelConfig({
        ...identity,
        modelId: "catalog-main",
        switchToModel: true,
        ...changed
      });
      assert.equal(rejected.ok, false);
      assert.equal(rejected.status, 409);
      assert.equal(rejected.code, "GATEWAY_DISCOVERY_STALE");
    }

    const invalid = await runtime.saveModelConfig({
      ...identity,
      gatewayDiscoveryToken: probe.discoveryToken,
      modelId: ""
    });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.status, 400);

    const saved = await runtime.saveModelConfig({
      ...identity,
      gatewayDiscoveryToken: probe.discoveryToken,
      modelId: "CATALOG-MAIN",
      agentCheapModel: "CATALOG-WORKER",
      agentDefaultModel: "catalog-main",
      agentStrongModel: "GPT-5.6-SOL",
      manualAgentModelIds: ["GPT-5.6-SOL"],
      // Browser catalog fields are intentionally forged. Only the server-side
      // proof catalog may canonicalize IDs or contribute metadata.
      catalogModelIds: ["gpt-5.6-sol"],
      catalogModels: [{
        id: "gpt-5.6-sol",
        reasoningEfforts: ["max"],
        defaultReasoningEffort: "max",
        contextTokens: 999_999
      }],
      switchToModel: true
    });
    assert.equal(saved.ok, true, `${saved.status}: ${saved.error}`);
    const document = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    const provider = document.namespaces["model-providers"].providers[saved.providerId];
    assert.equal(saved.modelId, "catalog-main");
    assert.deepEqual(provider.agents.modelTiers, {
      cheap: "catalog-worker",
      default: "catalog-main",
      strong: "GPT-5.6-SOL"
    });
    const worker = provider.models.find((model) => model.id === "catalog-worker");
    assert.equal(worker.displayName, "Catalog Worker");
    assert.equal(worker.contextWindow, 131_072);
    assert.deepEqual(worker.inputModalities, ["text", "image"]);
    const manual = provider.models.find((model) => model.id === "GPT-5.6-SOL");
    assert.deepEqual(manual, {
      id: "GPT-5.6-SOL",
      displayName: "GPT-5.6-SOL",
      compat: { routingOnly: true }
    });

    const replay = await runtime.saveModelConfig({
      ...identity,
      profileId: saved.providerId,
      gatewayDiscoveryToken: probe.discoveryToken,
      modelId: "catalog-main"
    });
    assert.equal(replay.ok, false);
    assert.equal(replay.status, 409);
    assert.equal(replay.code, "GATEWAY_DISCOVERY_STALE");
  } finally {
    await close(server);
  }
});

test("dashboard persists trusted upstream reasoning provenance and retains confirmed GPT ultra after restart", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-reasoning-proof-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-home-reasoning-proof-"));
  const settingsPath = path.join(home, ".ant-code", "settings.json");
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify({ settingsVersion: 2, namespaces: {} }), "utf8");
  const modelId = "gpt-5.6-terra";
  const efforts = ["low", "medium", "high", "xhigh", "max", "ultra"];
  const server = await listen(http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      data: [{
        id: modelId,
        reasoningEfforts: efforts,
        defaultReasoningEffort: "ultra"
      }]
    }));
  }), "127.0.0.1", 0);
  const gatewayUrl = `http://127.0.0.1:${server.address().port}/v1/responses`;
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: home } });

  try {
    const initial = await runtime.status();
    const identity = {
      saveTarget: "global",
      expectedRevision: initial.configV2.revisions.global,
      expectedCredentialsRevision: initial.configV2.revisions.credentials,
      clientId: "reasoning-proof-client",
      gatewayUrl,
      gatewayProtocol: "openai-responses",
      credentialAction: "keep"
    };
    const discovery = await runtime.probeGateway(identity);
    assert.equal(discovery.ok, true);
    assert.equal(discovery.models[0].reasoningDiscovery.source, "upstream-metadata");

    const saved = await runtime.saveModelConfig({
      ...identity,
      gatewayDiscoveryToken: discovery.discoveryToken,
      modelId,
      reasoningEfforts: efforts,
      defaultReasoningEffort: "ultra",
      reasoningDiscovery: { source: "active-probe", confidence: "browser-forged" },
      catalogModels: [{
        id: modelId,
        reasoningEfforts: ["max"],
        defaultReasoningEffort: "max",
        reasoningDiscovery: { source: "active-probe", confidence: "browser-forged" }
      }],
      switchToModel: true
    });
    assert.equal(saved.ok, true, `${saved.status}: ${saved.error}`);

    const document = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    const model = document.namespaces["model-providers"].providers[saved.providerId].models
      .find((candidate) => candidate.id === modelId);
    assert.deepEqual(model.compat?.reasoningDiscovery, {
      source: "upstream-metadata",
      confidence: "declared",
      path: "reasoningEfforts",
      presetId: null
    });

    const restarted = await createDashboardRuntime({ cwd, env: { USERPROFILE: home } }).status();
    const restartedModel = restarted.models.find((candidate) => candidate.id === modelId);
    assert.deepEqual(
      restartedModel.reasoningEfforts.map((effort) => effort.id ?? effort),
      ["low", "medium", "high", "xhigh", "max", "ultra"]
    );
    assert.equal(restartedModel.defaultReasoningEffort, "ultra");
  } finally {
    await close(server);
  }
});

test("dashboard turns a complete active reasoning probe into trusted restart-safe evidence", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-active-reasoning-proof-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-home-active-reasoning-proof-"));
  const settingsPath = path.join(home, ".ant-code", "settings.json");
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify({ settingsVersion: 2, namespaces: {} }), "utf8");
  const modelId = "grok-4.6";
  const acceptedEfforts = ["none", "off", "low", "medium", "high", "xhigh", "max", "ultra"];
  const persistedEfforts = ["off", "low", "medium", "high", "xhigh", "max", "ultra"];
  const supported = new Set(acceptedEfforts);
  const server = await listen(http.createServer(async (req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        data: [{
          id: modelId,
          reasoningEfforts: ["off", "xhigh"],
          defaultReasoningEffort: "xhigh"
        }]
      }));
      return;
    }
    const body = await readDashboardRequestJson(req);
    const effort = String(body.reasoning?.effort ?? "");
    if (!supported.has(effort)) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "unsupported effort", param: "reasoning.effort" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: `probe-${effort}`, output: [] }));
  }), "127.0.0.1", 0);
  const gatewayUrl = `http://127.0.0.1:${server.address().port}/v1/responses`;
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: home } });

  try {
    const initial = await runtime.status();
    const identity = {
      saveTarget: "global",
      expectedRevision: initial.configV2.revisions.global,
      expectedCredentialsRevision: initial.configV2.revisions.credentials,
      clientId: "active-reasoning-proof-client",
      gatewayUrl,
      gatewayProtocol: "openai-responses",
      credentialAction: "keep"
    };
    const catalog = await runtime.probeGateway(identity);
    assert.equal(catalog.ok, true);
    assert.equal(catalog.models[0].reasoningDiscovery.source, "upstream-metadata");
    const stale = await runtime.probeModelCapabilities({
      ...identity,
      gatewayDiscoveryToken: "forged-discovery-token",
      modelId
    });
    assert.equal(stale.ok, false);
    assert.equal(stale.code, "GATEWAY_DISCOVERY_STALE");

    const probed = await runtime.probeModelCapabilities({
      ...identity,
      gatewayDiscoveryToken: catalog.discoveryToken,
      modelId
    });
    assert.equal(probed.ok, true);
    assert.equal(probed.outcome, "complete");
    assert.deepEqual(probed.acceptedEfforts, acceptedEfforts);
    assert.deepEqual(probed.reasoningEfforts.map((effort) => effort.id ?? effort), persistedEfforts);
    assert.equal(probed.defaultReasoningEffort, "xhigh");
    assert.match(probed.discoveryToken, /^[A-Za-z0-9_-]{32,}$/);

    const saved = await runtime.saveModelConfig({
      ...identity,
      gatewayDiscoveryToken: probed.discoveryToken,
      modelId,
      reasoningEfforts: probed.reasoningEfforts,
      defaultReasoningEffort: probed.defaultReasoningEffort,
      switchToModel: true
    });
    assert.equal(saved.ok, true, `${saved.status}: ${saved.error}`);

    const document = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    const model = document.namespaces["model-providers"].providers[saved.providerId].models
      .find((candidate) => candidate.id === modelId);
    assert.deepEqual(model.compat?.reasoningDiscovery, {
      source: "active-probe",
      confidence: "probed",
      path: "reasoning.effort",
      presetId: null
    });

    const restarted = await createDashboardRuntime({ cwd, env: { USERPROFILE: home } }).status();
    const restartedModel = restarted.models.find((candidate) => candidate.id === modelId);
    assert.deepEqual(restartedModel.reasoningEfforts.map((effort) => effort.id ?? effort), persistedEfforts);
    assert.equal(restartedModel.defaultReasoningEffort, "xhigh");
  } finally {
    await close(server);
  }
});

test("dashboard gateway discovery proof expires and becomes stale after any bound config revision changes", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-discovery-stale-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-home-discovery-stale-"));
  const settingsPath = path.join(home, ".ant-code", "settings.json");
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify({ settingsVersion: 2, namespaces: {} }), "utf8");
  const server = await listen(http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "catalog-model" }] }));
  }), "127.0.0.1", 0);
  const gatewayUrl = `http://127.0.0.1:${server.address().port}/v1/responses`;
  let now = 1_000;
  const runtime = createDashboardRuntime({
    cwd,
    env: { USERPROFILE: home },
    gatewayDiscoveryTtlMs: 50,
    gatewayDiscoveryNow: () => now
  });
  const initialStatus = await runtime.status();
  const identity = {
    saveTarget: "global",
    expectedRevision: initialStatus.configV2.revisions.global,
    expectedCredentialsRevision: initialStatus.configV2.revisions.credentials,
    clientId: "stale-client",
    gatewayUrl,
    gatewayProtocol: "openai-responses",
    credentialAction: "keep"
  };

  try {
    const expiring = await runtime.probeGateway(identity);
    now += 51;
    const expired = await runtime.saveModelConfig({
      ...identity,
      gatewayDiscoveryToken: expiring.discoveryToken,
      modelId: "catalog-model"
    });
    assert.equal(expired.status, 409);
    assert.equal(expired.code, "GATEWAY_DISCOVERY_STALE");

    const revisionBound = await runtime.probeGateway(identity);
    const unrelated = await runtime.saveModelConfig({
      saveTarget: "global",
      expectedRevision: initialStatus.configV2.revisions.global,
      expectedCredentialsRevision: initialStatus.configV2.revisions.credentials,
      clientId: "other-client",
      gatewayUrl: "https://other-proof.example/v1/responses",
      gatewayProtocol: "openai-responses",
      credentialAction: "keep",
      modelId: "other-model",
      switchToModel: true
    });
    assert.equal(unrelated.ok, true);
    const staleRevision = await runtime.saveModelConfig({
      ...identity,
      gatewayDiscoveryToken: revisionBound.discoveryToken,
      modelId: "catalog-model"
    });
    assert.equal(staleRevision.status, 409);
    assert.equal(staleRevision.code, "GATEWAY_DISCOVERY_STALE");
  } finally {
    await close(server);
  }
});

test("dashboard revalidates discovery proof after waiting for the model transaction lock", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-discovery-lock-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-home-discovery-lock-"));
  const settingsPath = path.join(home, ".ant-code", "settings.json");
  const projectPath = path.join(cwd, ".lab-agent", "settings.json");
  const credentialPath = path.join(home, ".ant-code", "credentials.json");
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify({ settingsVersion: 2, namespaces: {} }), "utf8");
  const server = await listen(http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      data: [{ id: "catalog-main" }, {
        id: "catalog-worker",
        display_name: "Catalog Worker",
        context_window: 262_144,
        input_modalities: ["text", "image"]
      }]
    }));
  }), "127.0.0.1", 0);
  const gatewayUrl = `http://127.0.0.1:${server.address().port}/v1/responses`;
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: home } });
  const lockTarget = path.join(home, ".ant-code", "model-settings-v2.transaction");
  const heldLocks = [];

  /** @returns {Promise<{ release: () => void; completion: Promise<any> }>} */
  async function holdModelTransaction() {
    const acquired = deferred();
    const gate = deferred();
    const completion = withConfigMutationLock(lockTarget, async () => {
      acquired.resolve();
      await gate.promise;
    });
    await acquired.promise;
    const held = { release: gate.resolve, completion };
    heldLocks.push(held);
    return held;
  }

  /** @param {Record<string, any>} status @param {string} token */
  function saveInput(status, token) {
    return {
      saveTarget: "global",
      expectedRevision: status.configV2.revisions.global,
      expectedCredentialsRevision: status.configV2.revisions.credentials,
      clientId: "locked-proof-client",
      gatewayUrl,
      gatewayProtocol: "openai-responses",
      credentialAction: "keep",
      gatewayDiscoveryToken: token,
      modelId: "CATALOG-MAIN",
      agentCheapModel: "CATALOG-WORKER",
      agentDefaultModel: "catalog-main",
      agentStrongModel: "catalog-worker",
      switchToModel: true
    };
  }

  try {
    const initial = await runtime.status();
    const projectProof = await runtime.probeGateway({
      saveTarget: "global",
      clientId: "locked-proof-client",
      gatewayUrl,
      gatewayProtocol: "openai-responses",
      credentialAction: "keep"
    });
    const firstLock = await holdModelTransaction();
    let projectSaveSettled = false;
    const projectSave = runtime.saveModelConfig(saveInput(initial, projectProof.discoveryToken))
      .finally(() => { projectSaveSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(projectSaveSettled, false);
    await createFileRepository({ filePath: projectPath }).replace(
      { settingsVersion: 2, namespaces: {} },
      { expectedRevision: "missing" }
    );
    firstLock.release();
    await firstLock.completion;
    const staleProject = await projectSave;
    assert.equal(staleProject.ok, false);
    assert.equal(staleProject.status, 409);
    assert.equal(staleProject.code, "GATEWAY_DISCOVERY_STALE");
    assert.doesNotMatch(await fs.readFile(settingsPath, "utf8"), /catalog-main|catalog-worker/i);

    const afterProject = await runtime.status();
    const credentialProof = await runtime.probeGateway({
      saveTarget: "global",
      clientId: "locked-proof-client",
      gatewayUrl,
      gatewayProtocol: "openai-responses",
      credentialAction: "keep"
    });
    const secondLock = await holdModelTransaction();
    let credentialSaveSettled = false;
    const credentialSave = runtime.saveModelConfig(saveInput(afterProject, credentialProof.discoveryToken))
      .finally(() => { credentialSaveSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(credentialSaveSettled, false);
    await createCredentialStore({ filePath: credentialPath }).set(
      "ANTCODE_CONCURRENT_DISCOVERY_TEST",
      "concurrent-secret",
      { expectedRevision: afterProject.configV2.revisions.credentials }
    );
    secondLock.release();
    await secondLock.completion;
    const staleCredential = await credentialSave;
    assert.equal(staleCredential.ok, false);
    assert.equal(staleCredential.status, 409);
    assert.equal(staleCredential.code, "GATEWAY_DISCOVERY_STALE");
    assert.doesNotMatch(await fs.readFile(settingsPath, "utf8"), /catalog-main|catalog-worker/i);
  } finally {
    for (const held of heldLocks) held.release();
    await Promise.allSettled(heldLocks.map((held) => held.completion));
    await close(server);
  }
});

test("dashboard keeps explicit manual agent ids across an edited provider endpoint without treating browser catalogs as evidence", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-manual-endpoint-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-home-manual-endpoint-"));
  const settingsPath = path.join(home, ".ant-code", "settings.json");
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify({ settingsVersion: 2, namespaces: {} }), "utf8");
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: home } });
  const initialStatus = await runtime.status();
  const created = await runtime.saveModelConfig({
    saveTarget: "global",
    expectedRevision: initialStatus.configV2.revisions.global,
    expectedCredentialsRevision: initialStatus.configV2.revisions.credentials,
    gatewayUrl: "https://old-manual.example/v1/responses",
    gatewayProtocol: "openai-responses",
    credentialAction: "keep",
    modelId: "manual-main",
    switchToModel: true
  });
  assert.equal(created.ok, true);

  const changed = await runtime.saveModelConfig({
    saveTarget: "global",
    expectedRevision: created.configRevisions.global,
    expectedCredentialsRevision: created.configRevisions.credentials,
    profileId: created.providerId,
    providerId: created.providerId,
    previousModelId: "manual-main",
    gatewayUrl: "https://new-manual.example/v1/responses",
    gatewayProtocol: "openai-responses",
    credentialAction: "keep",
    modelId: "manual-main",
    agentCheapModel: "gpt-5.6-sol",
    agentDefaultModel: "manual-main",
    agentStrongModel: "gpt-5.6-sol",
    visionAgentModel: "manual-vision",
    manualAgentModelIds: ["gpt-5.6-sol", "manual-vision"],
    catalogModelIds: ["gpt-5.6-sol", "manual-vision"],
    catalogModels: [{
      id: "gpt-5.6-sol",
      reasoningEfforts: ["max"],
      defaultReasoningEffort: "max"
    }, {
      id: "manual-vision",
      modalities: ["text", "image"],
      contextTokens: 999_999
    }],
    switchToModel: false
  });
  assert.equal(changed.ok, true, `${changed.status}: ${changed.error}`);

  const document = JSON.parse(await fs.readFile(settingsPath, "utf8"));
  const provider = document.namespaces["model-providers"].providers[created.providerId];
  assert.deepEqual(provider.agents.modelTiers, {
    cheap: "gpt-5.6-sol",
    default: "manual-main",
    strong: "gpt-5.6-sol"
  });
  assert.equal(provider.agents.vision.model, "manual-vision");
  assert.deepEqual(provider.models.find((model) => model.id === "gpt-5.6-sol"), {
    id: "gpt-5.6-sol",
    displayName: "gpt-5.6-sol",
    compat: { routingOnly: true }
  });
  assert.deepEqual(provider.models.find((model) => model.id === "manual-vision"), {
    id: "manual-vision",
    displayName: "manual-vision",
    compat: { routingOnly: true }
  });
});

test("dashboard catalog discovery rejects redirects without forwarding credentials", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-catalog-redirect-"));
  let redirectRequests = 0;
  let targetRequests = 0;
  const target = await listen(http.createServer((_req, res) => {
    targetRequests += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "must-not-be-reached" }] }));
  }), "127.0.0.1", 0);
  const targetUrl = `http://127.0.0.1:${target.address().port}/v1/models`;
  const redirect = await listen(http.createServer((req, res) => {
    redirectRequests += 1;
    assert.equal(req.headers.authorization, "Bearer catalog-secret");
    res.writeHead(307, { location: targetUrl });
    res.end();
  }), "127.0.0.1", 0);
  const origin = `http://127.0.0.1:${redirect.address().port}`;
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: cwd } });

  try {
    const result = await runtime.probeGateway({
      gatewayUrl: `${origin}/v1?access_token=query-secret&tenant=visible`,
      gatewayProtocol: "openai-responses",
      gatewayApiKey: "catalog-secret",
      credentialAction: "replace"
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, 502);
    assert.match(result.error, /重定向/);
    assert.equal(result.diagnostic.stage, "redirect");
    assert.equal(result.diagnostic.httpStatus, 307);
    assert.equal(
      result.diagnostic.modelsUrl,
      `${origin}/v1/models?access_token=%5Bredacted%5D&tenant=visible`
    );
    assert.equal(redirectRequests, 1);
    assert.equal(targetRequests, 0);
    assert.doesNotMatch(JSON.stringify(result), /query-secret|catalog-secret/);
  } finally {
    await close(redirect);
    await close(target);
  }
});

test("dashboard catalog inference combines declared metadata with exact Grok and DeepSeek presets using only GET", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-catalog-reasoning-"));
  const requests = [];
  const server = await listen(http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    const catalog = new URL(req.url, "http://catalog.test").searchParams.get("catalog");
    const data = catalog === "deepseek"
      ? [
          { id: "deepseek-v4-pro" },
          { id: "deepseek-v4-pro-plus" }
        ]
      : [
          {
            id: "metadata-model",
            capabilities: {
              reasoning: { efforts: ["minimal", "high"], default: "high" }
            }
          },
          { id: "grok-4.6" },
          { id: "grok-4.6-preview" }
        ];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data }));
  }), "127.0.0.1", 0);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: cwd } });

  try {
    const grokCatalog = await runtime.probeGateway({
      gatewayUrl: `${origin}/v1?catalog=grok`,
      gatewayProtocol: "openai-responses"
    });
    const deepSeekCatalog = await runtime.probeGateway({
      gatewayUrl: `${origin}/v1?catalog=deepseek`,
      gatewayProtocol: "openai-chat"
    });

    assert.equal(grokCatalog.ok, true);
    const metadata = grokCatalog.models.find((model) => model.id === "metadata-model");
    assert.deepEqual(metadata.reasoningEfforts.map((effort) => effort.id), ["minimal", "high"]);
    assert.equal(metadata.defaultReasoningEffort, "high");
    assert.equal(metadata.reasoningDiscovery.source, "upstream-metadata");
    const grok = grokCatalog.models.find((model) => model.id === "grok-4.6");
    assert.deepEqual(grok.reasoningEfforts.map((effort) => effort.id), ["low", "medium", "high", "xhigh"]);
    assert.equal(grok.reasoningDiscovery.presetId, "xai.grok-4.5-4.6");
    assert.equal(grokCatalog.models.find((model) => model.id === "grok-4.6-preview").reasoningDiscovery.source, "unknown");

    assert.equal(deepSeekCatalog.ok, true);
    const deepSeek = deepSeekCatalog.models.find((model) => model.id === "deepseek-v4-pro");
    assert.deepEqual(deepSeek.reasoningEfforts.map((effort) => effort.id), ["off", "high", "max"]);
    assert.equal(deepSeek.defaultReasoningEffort, "high");
    assert.equal(deepSeek.reasoningDiscovery.presetId, "deepseek.v4-pro");
    assert.equal(deepSeekCatalog.models.find((model) => model.id === "deepseek-v4-pro-plus").reasoningDiscovery.source, "unknown");
    assert.deepEqual(requests, [
      { method: "GET", url: "/v1/models?catalog=grok" },
      { method: "GET", url: "/v1/models?catalog=deepseek" }
    ]);
  } finally {
    await close(server);
  }
});

test("dashboard capability probe stops after one accepted invalid effort and discards generated text", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-capability-silent-ignore-"));
  const requests = [];
  const generatedText = "generated text that must never leave the probe";
  const server = await listen(http.createServer(async (req, res) => {
    requests.push(await readDashboardRequestJson(req));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "ignored-reasoning-field",
      choices: [{ message: { role: "assistant", content: generatedText } }]
    }));
  }), "127.0.0.1", 0);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: cwd } });

  try {
    const result = await runtime.probeModelCapabilities({
      gatewayUrl: `${origin}/v1/chat/completions`,
      gatewayProtocol: "openai-chat",
      modelId: "silent-ignore-model"
    });

    assert.equal(result.ok, true);
    assert.equal(result.outcome, "indeterminate");
    assert.equal(result.diagnostic.requestCount, 1);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].reasoning_effort, "antcode_invalid_effort_probe");
    assert.deepEqual(result.reasoningEfforts, []);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(generatedText, "i"));
    assert.equal(Object.prototype.hasOwnProperty.call(result, "raw"), false);
  } finally {
    await close(server);
  }
});

test("dashboard chat capability probe requires a structured field then sends reasoning_effort candidates", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-capability-chat-"));
  const requests = [];
  const accepted = new Set(["off", "high", "max"]);
  const server = await listen(http.createServer(async (req, res) => {
    const body = await readDashboardRequestJson(req);
    requests.push(body);
    const effort = body.reasoning_effort;
    if (effort === "antcode_invalid_effort_probe" || !accepted.has(effort)) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "invalid_request_error", param: "reasoning_effort" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "discard me" } }] }));
  }), "127.0.0.1", 0);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: cwd } });

  try {
    const result = await runtime.probeModelCapabilities({
      gatewayUrl: `${origin}/v1/chat/completions`,
      gatewayProtocol: "openai-chat",
      modelId: "deepseek-v4-pro"
    });

    assert.equal(result.ok, true);
    assert.equal(result.outcome, "complete");
    assert.deepEqual(result.acceptedEfforts, ["off", "high", "max"]);
    assert.equal(result.defaultReasoningEffort, "high");
    assert.equal(result.reasoningDiscovery.path, "reasoning_effort");
    assert.equal(result.diagnostic.requestCount, 9);
    assert.deepEqual(requests.map((body) => body.reasoning_effort), [
      "antcode_invalid_effort_probe",
      "none",
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra"
    ]);
    assert.equal(requests.every((body) => !Object.prototype.hasOwnProperty.call(body, "reasoning")), true);
  } finally {
    await close(server);
  }
});

test("dashboard Responses capability probe sends reasoning.effort with bearer auth", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-capability-responses-"));
  const requests = [];
  const apiKey = "capability-probe-secret";
  const accepted = new Set(["low", "high", "xhigh"]);
  const server = await listen(http.createServer(async (req, res) => {
    const body = await readDashboardRequestJson(req);
    requests.push({ authorization: req.headers.authorization, body });
    const effort = body.reasoning?.effort;
    if (effort === "antcode_invalid_effort_probe" || !accepted.has(effort)) {
      res.writeHead(422, { "content-type": "application/json" });
      res.end(JSON.stringify({ detail: [{ loc: ["body", "reasoning", "effort"], type: "enum" }] }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ output_text: "discard generated probe output" }));
  }), "127.0.0.1", 0);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: cwd } });

  try {
    const result = await runtime.probeModelCapabilities({
      gatewayUrl: `${origin}/v1/responses`,
      gatewayProtocol: "openai-responses",
      gatewayApiKey: apiKey,
      credentialAction: "replace",
      modelId: "grok-4.6"
    });

    assert.equal(result.ok, true);
    assert.equal(result.outcome, "complete");
    assert.deepEqual(result.acceptedEfforts, ["low", "high", "xhigh"]);
    assert.equal(result.defaultReasoningEffort, "high");
    assert.equal(result.reasoningDiscovery.path, "reasoning.effort");
    assert.equal(result.apiKeyUsed, true);
    assert.equal(requests.length, 9);
    assert.equal(requests.every((request) => request.authorization === `Bearer ${apiKey}`), true);
    assert.deepEqual(requests.map((request) => request.body.reasoning.effort), [
      "antcode_invalid_effort_probe",
      "none",
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra"
    ]);
    assert.equal(requests.every((request) => !Object.prototype.hasOwnProperty.call(request.body, "reasoning_effort")), true);
    assert.doesNotMatch(JSON.stringify(result), /capability-probe-secret|discard generated probe output/);
  } finally {
    await close(server);
  }
});

test("dashboard capability probe stops after a generic validation error", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-capability-generic-error-"));
  let requestCount = 0;
  const server = await listen(http.createServer(async (req, res) => {
    requestCount += 1;
    await readDashboardRequestJson(req);
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "generic malformed request" } }));
  }), "127.0.0.1", 0);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: cwd } });

  try {
    const result = await runtime.probeModelCapabilities({
      gatewayUrl: `${origin}/v1/chat/completions`,
      gatewayProtocol: "openai-chat",
      modelId: "generic-error-model"
    });

    assert.equal(result.ok, true);
    assert.equal(result.outcome, "indeterminate");
    assert.equal(result.negativeControl.status, "indeterminate");
    assert.equal(result.reasoningDiscovery.path, null);
    assert.equal(result.diagnostic.requestCount, 1);
    assert.equal(requestCount, 1);
  } finally {
    await close(server);
  }
});

test("dashboard capability probe stops after auth and rate-limit responses", async () => {
  for (const scenario of [
    { status: 401, stage: "auth", error: "API Key 未通过验证" },
    { status: 429, stage: "rate-limit", error: "模型来源限制了档位检测请求" }
  ]) {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), `dashboard-runtime-capability-${scenario.stage}-`));
    let requestCount = 0;
    const server = await listen(http.createServer(async (req, res) => {
      requestCount += 1;
      await readDashboardRequestJson(req);
      res.writeHead(scenario.status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: scenario.error } }));
    }), "127.0.0.1", 0);
    const origin = `http://127.0.0.1:${server.address().port}`;
    const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: cwd } });

    try {
      const result = await runtime.probeModelCapabilities({
        gatewayUrl: `${origin}/v1/chat/completions`,
        gatewayProtocol: "openai-chat",
        modelId: `${scenario.stage}-model`
      });

      assert.equal(result.ok, false, scenario.stage);
      assert.equal(result.status, 502, scenario.stage);
      assert.equal(result.error, scenario.error, scenario.stage);
      assert.equal(result.diagnostic.stage, scenario.stage, scenario.stage);
      assert.equal(result.diagnostic.requestCount, 1, scenario.stage);
      assert.equal(requestCount, 1, scenario.stage);
    } finally {
      await close(server);
    }
  }
});

test("dashboard capability probe bounds timeout and oversized errors without retrying", { timeout: 3_000 }, async () => {
  const timeoutCwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-capability-timeout-"));
  let timeoutRequests = 0;
  const timeoutServer = await listen(http.createServer(async (req) => {
    timeoutRequests += 1;
    await readDashboardRequestJson(req);
    // Leave the response pending until the probe's bounded signal aborts it.
  }), "127.0.0.1", 0);
  const timeoutOrigin = `http://127.0.0.1:${timeoutServer.address().port}`;

  try {
    const runtime = createDashboardRuntime({ cwd: timeoutCwd, env: { USERPROFILE: timeoutCwd } });
    const result = await runtime.probeModelCapabilities({
      gatewayUrl: `${timeoutOrigin}/v1/chat/completions`,
      gatewayProtocol: "openai-chat",
      modelId: "timeout-model",
      probeTimeoutMs: 25
    });

    assert.equal(result.ok, false);
    assert.equal(result.diagnostic.stage, "timeout");
    assert.equal(result.diagnostic.requestCount, 1);
    assert.equal(timeoutRequests, 1);
  } finally {
    await close(timeoutServer);
  }

  const oversizedCwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-capability-oversized-"));
  let oversizedRequests = 0;
  const oversizedResponseClosed = deferred();
  const oversizedBody = "x".repeat(2048);
  const oversizedServer = await listen(http.createServer(async (req, res) => {
    oversizedRequests += 1;
    await readDashboardRequestJson(req);
    res.once("close", () => oversizedResponseClosed.resolve());
    res.writeHead(400, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(oversizedBody)
    });
    res.write(oversizedBody.slice(0, 16));
    // Keep sending pending; the bounded reader must cancel this response.
  }), "127.0.0.1", 0);
  const oversizedOrigin = `http://127.0.0.1:${oversizedServer.address().port}`;

  try {
    const runtime = createDashboardRuntime({ cwd: oversizedCwd, env: { USERPROFILE: oversizedCwd } });
    const result = await runtime.probeModelCapabilities({
      gatewayUrl: `${oversizedOrigin}/v1/responses`,
      gatewayProtocol: "openai-responses",
      modelId: "oversized-model",
      probeMaxResponseBytes: 1024
    });

    assert.equal(result.ok, false);
    assert.equal(result.diagnostic.stage, "response-too-large");
    assert.equal(result.diagnostic.requestCount, 1);
    assert.equal(oversizedRequests, 1);
    await oversizedResponseClosed.promise;
  } finally {
    oversizedServer.closeAllConnections?.();
    await close(oversizedServer);
  }
});

test("dashboard capability probe stops the upstream request when its caller aborts", { timeout: 3_000 }, async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-capability-cancel-"));
  const requestStarted = deferred();
  let requestCount = 0;
  const server = await listen(http.createServer(async (req) => {
    requestCount += 1;
    await readDashboardRequestJson(req);
    requestStarted.resolve();
    // Keep the response pending until the caller's signal reaches fetch.
  }), "127.0.0.1", 0);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: cwd } });
  const controller = new AbortController();

  try {
    const probe = runtime.probeModelCapabilities({
      gatewayUrl: `${origin}/v1/chat/completions`,
      gatewayProtocol: "openai-chat",
      modelId: "cancelled-model"
    }, { signal: controller.signal });
    await requestStarted.promise;
    controller.abort(new Error("capability dialog closed"));
    const result = await probe;

    assert.equal(result.ok, false);
    assert.equal(result.error, "思考档位检测已取消");
    assert.equal(result.diagnostic.stage, "cancelled");
    assert.equal(result.diagnostic.requestCount, 1);
    assert.equal(requestCount, 1);
  } finally {
    await close(server);
  }
});

test("dashboard capability probe reports a truncated upstream response separately from size limits", { timeout: 3_000 }, async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-capability-truncated-"));
  let requestCount = 0;
  const server = await listen(http.createServer(async (req, res) => {
    requestCount += 1;
    await readDashboardRequestJson(req);
    res.writeHead(400, {
      "content-type": "application/json",
      "content-length": 512
    });
    res.flushHeaders();
    res.write('{"error":{"param":"reasoning_effort"');
    setImmediate(() => res.destroy());
  }), "127.0.0.1", 0);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: cwd } });

  try {
    const result = await runtime.probeModelCapabilities({
      gatewayUrl: `${origin}/v1/chat/completions`,
      gatewayProtocol: "openai-chat",
      modelId: "truncated-response-model"
    });

    assert.equal(result.ok, false);
    assert.equal(result.error, "读取模型来源响应失败");
    assert.equal(result.diagnostic.stage, "response");
    assert.equal(result.diagnostic.requestCount, 1);
    assert.equal(requestCount, 1);
  } finally {
    server.closeAllConnections?.();
    await close(server);
  }
});

test("dashboard runtime redacts credentials from public gateway URLs", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-public-gateway-url-"));
  await fs.mkdir(path.join(cwd, ".lab-agent"), { recursive: true });
  await fs.writeFile(path.join(cwd, ".lab-agent", "config.json"), JSON.stringify({
    modelAlias: "safe-model",
    models: [{ id: "safe-model" }],
    lab: {
      gatewayUrl: "https://alice:password@gateway.example/v1?access_token=one&api_key=two&key=three&token=four&authorization=five&tenant=visible",
      gatewayHealthUrl: "https://health-user:health-password@gateway.example/health?TOKEN=health-secret&check=ready",
      gatewayProtocol: "openai-responses",
      activeGatewayProfile: "credential-profile",
      gatewayProfiles: [{
        id: "credential-profile",
        label: "Credential profile",
        gatewayUrl: "https://alice:password@gateway.example/v1?access_token=one&api_key=two&key=three&token=four&authorization=five&tenant=visible",
        gatewayHealthUrl: "https://health-user:health-password@gateway.example/health?TOKEN=health-secret&check=ready",
        gatewayProtocol: "openai-responses",
        modelAlias: "safe-model",
        models: [{ id: "safe-model" }]
      }]
    }
  }), "utf8");
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: cwd } });

  const result = await runtime.status();
  const expectedGatewayUrl = "https://gateway.example/v1/responses?access_token=%5Bredacted%5D&api_key=%5Bredacted%5D&key=%5Bredacted%5D&token=%5Bredacted%5D&authorization=%5Bredacted%5D&tenant=visible";
  const expectedHealthUrl = "https://gateway.example/health?TOKEN=%5Bredacted%5D&check=ready";

  assert.equal(result.gatewayConfig.gatewayUrl, expectedGatewayUrl);
  assert.equal(result.gatewayConfig.gatewayHealthUrl, expectedHealthUrl);
  assert.equal(result.gatewayProfiles[0].gatewayUrl, expectedGatewayUrl);
  assert.equal(result.gatewayProfiles[0].gatewayHealthUrl, expectedHealthUrl);
  assert.doesNotMatch(JSON.stringify(result.gatewayConfig), /alice|password|health-user|health-password|health-secret|access_token=one/);
});

test("dashboard gateway probe redacts credential query values from success and diagnostic URLs", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-public-probe-url-"));
  const requests = [];
  const server = await listen(http.createServer((req, res) => {
    requests.push(req.url);
    if (req.url.includes("fail=true")) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "safe-model" }] }));
  }), "127.0.0.1", 0);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: cwd } });

  try {
    const success = await runtime.probeGateway({
      gatewayUrl: `${origin}/v1?token=probe-secret&tenant=visible`,
      gatewayProtocol: "openai-responses"
    });
    const failure = await runtime.probeGateway({
      gatewayUrl: `${origin}/v1?authorization=query-secret&fail=true`,
      gatewayProtocol: "openai-responses"
    });

    assert.equal(success.ok, true);
    assert.equal(success.modelsUrl, `${origin}/v1/models?token=%5Bredacted%5D&tenant=visible`);
    assert.equal(success.suggestedGatewayUrl, `${origin}/v1/responses?token=%5Bredacted%5D&tenant=visible`);
    assert.equal(failure.ok, false);
    assert.equal(failure.diagnostic.modelsUrl, `${origin}/v1/models?authorization=%5Bredacted%5D&fail=true`);
    assert.doesNotMatch(JSON.stringify({ success, failure }), /probe-secret|query-secret/);
    assert.deepEqual(requests, [
      "/v1/models?token=probe-secret&tenant=visible",
      "/v1/models?authorization=query-secret&fail=true"
    ]);
  } finally {
    await close(server);
  }
});

test("dashboard gateway probe never sends a selected profile key to a different endpoint", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-probe-key-scope-"));
  await fs.mkdir(path.join(cwd, ".lab-agent"), { recursive: true });
  await fs.writeFile(path.join(cwd, ".lab-agent", "config.json"), JSON.stringify({
    modelAlias: "old-model",
    models: [{ id: "old-model" }],
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
        modelAlias: "old-model",
        models: [{ id: "old-model" }]
      }]
    }
  }), "utf8");
  const requests = [];
  const server = await listen(http.createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "new-model" }] }));
  }), "127.0.0.1", 0);
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: cwd } });

  try {
    const result = await runtime.probeGateway({
      profileId: "old-profile",
      gatewayUrl: baseUrl,
      gatewayProtocol: "openai-chat",
      previousGatewayUrl: "https://old.gateway.example/v1/chat/completions",
      previousGatewayProtocol: "openai-chat",
      credentialAction: "keep"
    });

    assert.equal(result.ok, true);
    assert.equal(result.apiKeyUsed, false);
    assert.deepEqual(requests, [{ url: "/v1/models", authorization: undefined }]);
  } finally {
    await close(server);
  }
});

test("dashboard gateway probe reuses the selected key for a same-origin endpoint migration", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-probe-key-migration-"));
  const requests = [];
  const server = await listen(http.createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "responses-model" }] }));
  }), "127.0.0.1", 0);
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  await fs.mkdir(path.join(cwd, ".lab-agent"), { recursive: true });
  await fs.writeFile(path.join(cwd, ".lab-agent", "config.json"), JSON.stringify({
    modelAlias: "chat-model",
    models: [{ id: "chat-model" }],
    lab: {
      gatewayUrl: baseUrl,
      gatewayProtocol: "openai-chat",
      gatewayApiKey: "stored-secret",
      activeGatewayProfile: "chat-profile",
      gatewayProfiles: [{
        id: "chat-profile",
        gatewayUrl: baseUrl,
        gatewayProtocol: "openai-chat",
        gatewayApiKey: "stored-secret",
        modelAlias: "chat-model",
        models: [{ id: "chat-model" }]
      }]
    }
  }), "utf8");
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: cwd } });

  try {
    const result = await runtime.probeGateway({
      profileId: "chat-profile",
      gatewayUrl: `${baseUrl}/responses`,
      gatewayProtocol: "openai-responses",
      previousGatewayUrl: baseUrl,
      previousGatewayProtocol: "openai-chat",
      credentialAction: "keep"
    });

    assert.equal(result.ok, true);
    assert.equal(result.apiKeyUsed, true);
    assert.deepEqual(requests, [{ url: "/v1/models", authorization: "Bearer stored-secret" }]);
  } finally {
    await close(server);
  }
});

test("dashboard gateway probe reuses a key for the exact stored base endpoint", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-probe-base-key-"));
  const requests = [];
  const server = await listen(http.createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "responses-model" }] }));
  }), "127.0.0.1", 0);
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  await fs.mkdir(path.join(cwd, ".lab-agent"), { recursive: true });
  await fs.writeFile(path.join(cwd, ".lab-agent", "config.json"), JSON.stringify({
    modelAlias: "responses-model",
    models: [{ id: "responses-model" }],
    lab: {
      gatewayUrl: baseUrl,
      gatewayProtocol: "openai-responses",
      gatewayApiKey: "stored-secret",
      activeGatewayProfile: "responses-profile",
      gatewayProfiles: [{
        id: "responses-profile",
        gatewayUrl: baseUrl,
        gatewayProtocol: "openai-responses",
        gatewayApiKey: "stored-secret",
        modelAlias: "responses-model",
        models: [{ id: "responses-model" }]
      }]
    }
  }), "utf8");
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: cwd } });

  try {
    const result = await runtime.probeGateway({
      profileId: "responses-profile",
      gatewayUrl: baseUrl,
      gatewayProtocol: "openai-responses",
      credentialAction: "keep"
    });

    assert.equal(result.ok, true);
    assert.equal(result.apiKeyUsed, true);
    assert.equal(result.suggestedGatewayUrl, `${baseUrl}/responses`);
    assert.deepEqual(requests, [{ url: "/v1/models", authorization: "Bearer stored-secret" }]);
  } finally {
    await close(server);
  }
});

test("dashboard gateway probe uses Anthropic headers and suggests the Messages endpoint", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-probe-anthropic-"));
  const requests = [];
  const server = await listen(http.createServer((req, res) => {
    requests.push({
      url: req.url,
      authorization: req.headers.authorization,
      apiKey: req.headers["x-api-key"],
      version: req.headers["anthropic-version"]
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "claude-test" }] }));
  }), "127.0.0.1", 0);
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: cwd } });

  try {
    const result = await runtime.probeGateway({
      gatewayUrl: baseUrl,
      gatewayProtocol: "anthropic-messages",
      gatewayApiKey: "anthropic-secret",
      credentialAction: "replace"
    });

    assert.equal(result.ok, true);
    assert.equal(result.modelsUrl, `${baseUrl}/models`);
    assert.equal(result.suggestedGatewayUrl, `${baseUrl}/messages`);
    assert.deepEqual(requests, [{
      url: "/v1/models",
      authorization: undefined,
      apiKey: "anthropic-secret",
      version: "2023-06-01"
    }]);
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
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: cwd } });

  const switched = await runtime.switchModel({ modelId: "vision-model", applyAgentDefaults: true });

  assert.equal(switched.ok, true);
  assert.equal(switched.sessionStatus.model, "vision-model");
  assert.deepEqual(switched.agentModelTiers, {
    cheap: "vision-flash",
    default: "vision-default",
    strong: "vision-strong"
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
    strong: "vision-strong"
  });
});

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
  const firstRequestReceived = deferred();
  const server = await listen(createDelayedGateway(
    ["old answer", "guided answer"],
    80,
    { onRequest: () => firstRequestReceived.resolve() }
  ), "127.0.0.1", 0);
  const runtime = createDashboardRuntime({ cwd, env: mockGatewayEnv(server) });
  await runtime.trustWorkspace();

  try {
    const started = await runtime.startTurn({
      prompt: "draft old plan",
      permissionMode: "workspace"
    });
    assert.equal(started.ok, true);
    await firstRequestReceived.promise;

    const guided = runtime.guideTurn({
      sessionId: started.sessionId,
      guidance: "改成先检查测试",
      permissionMode: "workspace"
    });
    assert.equal(guided.ok, true);
    assert.equal(guided.queued, true);
    assert.equal(guided.queue[0].kind, "guide");

    const events = await waitForEvent(runtime, started.sessionId, (event) => (
      event.type === "assistant_final" && /guided answer/.test(String(event.text ?? ""))
    ));
    assert.equal(events.some((event) => event.type === "guide_queued"), true);
    assert.equal(events.some((event) => event.type === "turn_interrupt_requested" && event.reason === "guided"), true);
    assert.match(events.filter((event) => event.type === "user_message").map((event) => event.text).join("\n"), /改成先检查测试/);
    assert.match(events.filter((event) => event.type === "assistant_final").at(-1)?.text ?? "", /guided answer/);
  } finally {
    await close(server);
  }
});

test("dashboard runtime converts queued prompts into guides without duplicating them", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-"));
  const firstRequestReceived = deferred();
  const server = await listen(createDelayedGateway(
    ["old answer", "guided answer"],
    80,
    { onRequest: () => firstRequestReceived.resolve() }
  ), "127.0.0.1", 0);
  const runtime = createDashboardRuntime({ cwd, env: mockGatewayEnv(server) });
  await runtime.trustWorkspace();

  try {
    const started = await runtime.startTurn({
      prompt: "draft old plan",
      permissionMode: "workspace"
    });
    assert.equal(started.ok, true);
    await firstRequestReceived.promise;

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

    const events = await waitForEvent(runtime, started.sessionId, (event) => (
      event.type === "assistant_final" && /guided answer/.test(String(event.text ?? ""))
    ));
    assert.equal(events.some((event) => event.type === "guide_queued"), true);
    assert.equal(events.some((event) => event.type === "turn_interrupt_requested" && event.reason === "guided"), true);
    assert.deepEqual(events.filter((event) => event.type === "user_message").map((event) => event.text), [
      "draft old plan",
      "改成先检查测试"
    ]);
    assert.match(events.filter((event) => event.type === "assistant_final").at(-1)?.text ?? "", /guided answer/);
  } finally {
    await close(server);
  }
});

test("dashboard runtime stores guide transcript using visible guidance only", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-"));
  const firstRequestReceived = deferred();
  const server = await listen(createDelayedGateway(
    ["old answer", "guided answer"],
    80,
    { onRequest: () => firstRequestReceived.resolve() }
  ), "127.0.0.1", 0);
  const runtime = createDashboardRuntime({ cwd, env: mockGatewayEnv(server) });
  await runtime.trustWorkspace();

  try {
    const started = await runtime.startTurn({
      prompt: "draft old plan",
      permissionMode: "workspace"
    });
    assert.equal(started.ok, true);
    await firstRequestReceived.promise;

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
  const runtime = createDashboardRuntime({ cwd, env: mockGatewayEnv(server, { LAB_AGENT_MODEL: "mock-model" }) });
  await runtime.trustWorkspace();

  try {
    const started = await runtime.startTurn({
      prompt: "delegate background work",
      permissionMode: "workspace"
    });
    assert.equal(started.ok, true);

    try {
      await waitForEvent(runtime, started.sessionId, (event) => (
        event.type === "assistant_final" && /parent consumed wake prompt/.test(String(event.text ?? ""))
      ), 3_000);
    } catch (error) {
      console.error(JSON.stringify({
        events: runtime.listActiveEvents(started.sessionId).map((event) => ({
          type: event.type,
          rawType: event.rawType,
          text: event.text,
          running: event.running,
          groups: event.groups,
          queueLength: event.queueLength
        })),
        requests: requests.map((request) => ({
          sessionId: request.sessionId,
          lastMessage: request.messages?.at(-1)?.content
        })),
        state: {
          running: runtime.active.get(started.sessionId)?.running,
          queue: runtime.active.get(started.sessionId)?.queuedPrompts
        }
      }, null, 2));
      throw error;
    }
    await waitForCondition(() => runtime.active.get(started.sessionId)?.running === false);
    const groupPath = path.join(cwd, ".lab-agent", "task-groups", "group-dashboard-bg.json");
    await waitForCondition(async () => {
      try {
        const group = JSON.parse(await fs.readFile(groupPath, "utf8"));
        return Boolean(group.wakePromptConsumedAt);
      } catch {
        return false;
      }
    });
    await waitForCondition(() => (
      runtime.listActiveEvents(started.sessionId)
        .filter((event) => event.type === "background_subagent_snapshot")
        .at(-1)?.groups?.length === 0
    ));
    const events = runtime.listActiveEvents(started.sessionId);
    const parentRequests = requests.filter((item) => !String(item.sessionId ?? "").startsWith("agent-explorer-"));
    const group = JSON.parse(await fs.readFile(groupPath, "utf8"));

    assert.equal(events.some((event) => event.rawType === "subagent_group_wakeup"), true);
    assert.equal(events.some((event) => event.type === "wakeup_queued"), true);
    assert.equal(events.some((event) => event.type === "background_subagent_snapshot"), true);
    assert.match(parentRequests.at(-1)?.messages?.at(-1)?.content ?? "", /Ant Code subagent group completed/);
    assert.match(events.filter((event) => event.type === "assistant_final").map((event) => event.text).join("\n"), /parent consumed wake prompt/);
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

    await waitForEvent(runtime, started.sessionId, (event) => (
      event.type === "assistant_final" && /parent consumed any wake prompt/.test(String(event.text ?? ""))
    ), 15_000);
    await waitForCondition(() => runtime.active.get(started.sessionId)?.running === false);
    const groupPath = path.join(cwd, ".lab-agent", "task-groups", "group-dashboard-any.json");
    await waitForCondition(async () => {
      try {
        const group = JSON.parse(await fs.readFile(groupPath, "utf8"));
        return Boolean(group.wakePromptConsumedAt);
      } catch {
        return false;
      }
    });
    await waitForCondition(() => {
      const lastSnapshot = runtime.listActiveEvents(started.sessionId)
        .filter((event) => event.type === "background_subagent_snapshot")
        .at(-1);
      return lastSnapshot?.groups?.length === 1
        && lastSnapshot.groups[0].status === "running"
        && lastSnapshot.groups[0].wakePromptQueued === false;
    });
    const events = runtime.listActiveEvents(started.sessionId);
    const snapshots = events.filter((event) => event.type === "background_subagent_snapshot");
    const lastSnapshot = snapshots.at(-1);
    const reopened = await runtime.readSession(started.sessionId);
    const records = await runtime.listSessionRecords();
    const record = records.find((item) => item.id === started.sessionId);
    const group = JSON.parse(await fs.readFile(groupPath, "utf8"));

    assert.equal(events.some((event) => event.rawType === "subagent_group_wakeup"), true);
    assert.ok(snapshots.length >= 2);
    assert.equal(lastSnapshot.groups.length, 1);
    assert.equal(lastSnapshot.groups[0].groupId, "group-dashboard-any");
    assert.equal(lastSnapshot.groups[0].status, "running");
    assert.equal(lastSnapshot.groups[0].runningCount, 1);
    assert.equal(lastSnapshot.groups[0].wakePromptQueued, false);
    assert.equal(reopened.ok, true);
    assert.equal(reopened.session.active, true);
    assert.equal(reopened.session.running, false);
    assert.equal(reopened.session.backgroundSnapshot.groups.length, 1);
    assert.equal(reopened.session.backgroundSnapshot.groups[0].groupId, "group-dashboard-any");
    assert.equal(reopened.session.backgroundSnapshot.groups[0].status, "running");
    assert.equal(record.backgroundVisible, true);
    assert.deepEqual(record.backgroundKinds, ["subagent"]);
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
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: cwd } });
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
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: cwd } });
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

test("dashboard runtime exposes a redacted gateway failure summary for archived sessions", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-"));
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: cwd } });
  const store = createSessionStore({ cwd });
  await store.writeMetadata({
    id: "archived-gateway-failure",
    prompt: "failed request",
    title: "failed request",
    status: "gateway_error",
    gatewayRounds: [{
      round: 1,
      error: {
        code: "GATEWAY_HTTP_ERROR",
        message: "Gateway returned HTTP 502; Bearer archive-secret-value",
        status: 502,
        details: {
          body: JSON.stringify({ error: { message: "Upstream service temporarily unavailable; api_key=archive-secret-value" } }),
          attempts: 6,
          retryHistory: [{ attempt: 1, body: "private retry detail" }]
        }
      }
    }],
    transcript: { messages: [] }
  });

  const reopened = await runtime.readSession("archived-gateway-failure");

  assert.equal(reopened.ok, true);
  assert.deepEqual(reopened.session.failure, {
    kind: "gateway",
    code: "GATEWAY_HTTP_ERROR",
    message: "Gateway returned HTTP 502; Bearer [redacted]",
    httpStatus: 502,
    upstreamMessage: "Upstream service temporarily unavailable; api_key=[redacted]",
    attempts: 6
  });
  assert.doesNotMatch(JSON.stringify(reopened.session.failure), /archive-secret-value/);
  assert.equal("retryHistory" in reopened.session.failure, false);
  assert.equal("body" in reopened.session.failure, false);
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
    runtime.interruptTurn(started.sessionId, cleanupAbortError());
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

test("dashboard runtime bounds stalled lifecycle probes and releases the shutdown lock", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-shutdown-probe-timeout-"));
  const never = new Promise(() => {});
  let lifecycleCalls = 0;
  const runtime = createDashboardRuntime({
    cwd,
    env: { ANT_CODE_DASHBOARD_LIFECYCLE_WAIT_MS: "50" },
    lifecycleActivity: () => {
      lifecycleCalls += 1;
      return never;
    }
  });

  const status = await runtime.lifecycleStatus();
  assert.equal(status.ok, false);
  assert.equal(status.code, "LIFECYCLE_STATUS_TIMEOUT");
  assert.equal(status.activity.uncertain, true);

  const timedOut = await runtime.shutdown({ timeoutMs: 50 });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.code, "SHUTDOWN_ACTIVITY_TIMEOUT");

  const callsBeforeForce = lifecycleCalls;
  const forced = await runtime.shutdown({ force: true, timeoutMs: 50 });
  assert.equal(forced.ok, true);
  assert.equal(forced.forced, true);
  assert.equal(runtime.active.size, 0);
  assert.equal(lifecycleCalls, callsBeforeForce);
});

test("dashboard session listing scans group history once for ten active sessions", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-group-index-"));
  const runtime = createDashboardRuntime({
    cwd,
    env: {},
    runTurn: async (_session, options) => {
      await options.onEvent({ type: "turn_complete", status: "completed" });
      return { output: "done" };
    }
  });
  await runtime.trustWorkspace();
  for (let index = 0; index < 10; index += 1) {
    const started = await runtime.startTurn({ prompt: `active ${index}`, permissionMode: "plan" });
    await waitForEvent(runtime, started.sessionId, (event) => event.type === "run_state" && event.running === false);
  }
  await waitForCondition(() => [...runtime.active.values()].every((state) => !state.backgroundSnapshotPromise));

  const groupRoot = path.join(cwd, ".lab-agent", "task-groups");
  await fs.mkdir(groupRoot, { recursive: true });
  await Promise.all(Array.from({ length: 300 }, (_, index) => fs.writeFile(
    path.join(groupRoot, `unrelated-${index}.json`),
    JSON.stringify({
      id: `unrelated-${index}`,
      parentSessionId: "unrelated-session",
      status: "running",
      taskIds: []
    }),
    "utf8"
  )));

  const originalReadFile = fs.readFile;
  const originalNow = Date.now;
  let groupReads = 0;
  let virtualNow = originalNow();
  fs.readFile = async (filePath, ...args) => {
    if (path.resolve(String(filePath)).startsWith(`${path.resolve(groupRoot)}${path.sep}`)) {
      groupReads += 1;
    }
    return originalReadFile(filePath, ...args);
  };
  Date.now = () => (virtualNow += 600);
  try {
    const records = await runtime.listSessionRecords();
    assert.equal(records.filter((record) => record.active).length, 10);
    assert.ok(groupReads <= 300, `expected at most one 300-file scan, received ${groupReads} reads`);
  } finally {
    Date.now = originalNow;
    fs.readFile = originalReadFile;
    await runtime.shutdown({ force: true, timeoutMs: 50 });
  }
});

test("dashboard lifecycle timeout reuses the in-flight group scan without overlap", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-group-timeout-"));
  const groupRoot = path.join(cwd, ".lab-agent", "task-groups");
  await fs.mkdir(groupRoot, { recursive: true });
  await Promise.all(Array.from({ length: 300 }, (_, index) => fs.writeFile(
    path.join(groupRoot, `history-${index}.json`),
    JSON.stringify({ id: `history-${index}`, parentSessionId: "other", status: "completed", taskIds: [] }),
    "utf8"
  )));
  const runtime = createDashboardRuntime({
    cwd,
    env: { ANT_CODE_DASHBOARD_LIFECYCLE_WAIT_MS: "50" }
  });
  runtime.active.set("active-timeout", {
    session: { id: "active-timeout", cwd, status: "active" },
    running: false,
    quarantinedTurnId: "",
    queuedPrompts: [],
    pendingApprovals: new Map(),
    pendingQuestions: new Map()
  });

  const gate = deferred();
  const originalReadFile = fs.readFile;
  let groupReads = 0;
  fs.readFile = async (filePath, ...args) => {
    if (path.resolve(String(filePath)).startsWith(`${path.resolve(groupRoot)}${path.sep}`)) {
      groupReads += 1;
      await gate.promise;
    }
    return originalReadFile(filePath, ...args);
  };
  try {
    const first = await runtime.lifecycleStatus();
    const second = await runtime.lifecycleStatus();
    assert.equal(first.code, "LIFECYCLE_STATUS_TIMEOUT");
    assert.equal(second.code, "LIFECYCLE_STATUS_TIMEOUT");
    assert.equal(groupReads, 32);

    gate.resolve();
    await waitForCondition(() => groupReads === 300);
    const recovered = await runtime.lifecycleStatus();
    assert.equal(recovered.ok, true);
    assert.equal(groupReads, 300);
  } finally {
    gate.resolve();
    fs.readFile = originalReadFile;
    runtime.active.clear();
    await runtime.shutdown({ force: true, timeoutMs: 50 });
  }
});

test("dashboard runtime bounds stalled background cleanup and still permits force shutdown", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-shutdown-background-timeout-"));
  const never = new Promise(() => {});
  const runtime = createDashboardRuntime({
    cwd,
    env: { ANT_CODE_DASHBOARD_LIFECYCLE_WAIT_MS: "50" },
    lifecycleActivity: async (active) => ({
      sessions: active.size,
      activeTurns: 0,
      quarantinedTurns: 0,
      queuedTurns: 0,
      backgroundTasks: 0,
      pendingInteractions: 0,
      total: 0
    }),
    cancelBackgroundWork: () => never,
    runTurn: async (_session, options) => {
      await options.onEvent({ type: "turn_complete", status: "completed" });
      return { output: "done" };
    }
  });
  await runtime.trustWorkspace();
  const started = await runtime.startTurn({ prompt: "seed", permissionMode: "plan" });
  await waitForEvent(runtime, started.sessionId, (event) => event.type === "run_state" && event.running === false);

  const timedOut = await runtime.shutdown({ cancel: true, timeoutMs: 50 });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.code, "SHUTDOWN_BACKGROUND_TIMEOUT");
  assert.equal(runtime.active.has(started.sessionId), true);

  const forced = await runtime.shutdown({ force: true, timeoutMs: 50 });
  assert.equal(forced.ok, true);
  assert.equal(forced.forced, true);
  assert.equal(runtime.active.size, 0);
});

test("dashboard runtime emits terminal run state before background observability refresh", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-terminal-before-snapshot-"));
  const runtime = createDashboardRuntime({
    cwd,
    env: {},
    runTurn: async (_session, options) => {
      await options.onEvent({ type: "turn_complete", status: "completed" });
      return { output: "done" };
    }
  });
  await runtime.trustWorkspace();
  const started = await runtime.startTurn({ prompt: "finish promptly", permissionMode: "plan" });
  const terminalEvents = await waitForEvent(
    runtime,
    started.sessionId,
    (event) => event.type === "run_state" && event.running === false
  );
  const terminal = terminalEvents.find((event) => event.type === "run_state" && event.running === false);
  assert.ok(terminal);
  assert.equal(runtime.active.peek(started.sessionId).running, false);

  const events = await waitForEvent(
    runtime,
    started.sessionId,
    (event) => event.type === "background_subagent_snapshot" && event.sequence > terminal.sequence
  );
  const snapshot = events.find((event) => event.type === "background_subagent_snapshot" && event.sequence > terminal.sequence);
  assert.ok(snapshot);
  await runtime.shutdown({ force: true, timeoutMs: 50 });
});

test("dashboard runtime refuses metadata cwd outside the dashboard workspace", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-cwd-root-"));
  const child = path.join(cwd, "child");
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-cwd-outside-"));
  await fs.mkdir(child);
  const store = createSessionStore({ cwd });
  await store.writeMetadata({ id: "inside-cwd", cwd: child, status: "completed" });
  await store.writeMetadata({ id: "outside-cwd", cwd: outside, status: "completed" });
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: cwd } });

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
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: cwd } });

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
    await waitForCondition(() => runtime.active.peek(result.sessionId).persisted === true);
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
  await waitForCondition(() => runtime.active.peek(started.sessionId).persisted === true);
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

async function waitForCondition(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for dashboard condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function cleanupAbortError() {
  const error = new Error("test-cleanup");
  error.name = "AbortError";
  return error;
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

async function readDashboardRequestJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += Buffer.from(chunk).toString("utf8");
  }
  return body ? JSON.parse(body) : {};
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

function createHeaderRecordingGateway(requests, text) {
  return http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) {
      body += Buffer.from(chunk).toString("utf8");
    }
    requests.push({
      authorization: req.headers.authorization ?? "",
      body: JSON.parse(body)
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: `header-recording-${requests.length}`,
      model: "new-model",
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

function createOpenAIChatAuthRecordingGateway(requests, text, validKey) {
  return http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) {
      body += Buffer.from(chunk).toString("utf8");
    }
    requests.push({
      url: req.url,
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
      id: `chat-auth-recording-${requests.length}`,
      model: String(requests.at(-1)?.body?.model ?? "mock-model"),
      choices: [{
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop"
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    }));
  });
}

function createDelayedGateway(texts, delayMs, options = {}) {
  let calls = 0;
  return http.createServer(async (req, res) => {
    for await (const _ of req) {
      // Drain request body.
    }
    options.onRequest?.(calls + 1);
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

test("dashboard global model saves do not regress capabilities from a stale project profile override", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-global-capability-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-home-global-capability-"));
  const globalPath = path.join(home, ".ant-code", "lab-agent.config.json");
  const localPath = path.join(cwd, ".lab-agent", "config.json");
  const gatewayUrl = "https://shared-capability.gateway.example/v1/responses";
  const profileId = "shared-capability-profile";
  const staleModel = {
    id: "deepseek-reasoner",
    label: "Stale project copy",
    reasoningEfforts: ["low", "high"],
    defaultReasoningEffort: "high"
  };

  await fs.mkdir(path.dirname(globalPath), { recursive: true });
  await fs.writeFile(globalPath, JSON.stringify({
    modelAlias: staleModel.id,
    models: [staleModel],
    lab: {
      gatewayUrl,
      gatewayProtocol: "openai-responses",
      activeGatewayProfile: profileId,
      gatewayProfiles: [{
        id: profileId,
        gatewayUrl,
        gatewayProtocol: "openai-responses",
        modelAlias: staleModel.id,
        models: [staleModel]
      }]
    }
  }), "utf8");
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, JSON.stringify({
    modelAlias: staleModel.id,
    models: [staleModel],
    lab: {
      gatewayUrl,
      gatewayProtocol: "openai-responses",
      activeGatewayProfile: profileId,
      gatewayProfiles: [{
        id: profileId,
        gatewayUrl,
        gatewayProtocol: "openai-responses",
        modelAlias: staleModel.id,
        models: [staleModel]
      }]
    }
  }), "utf8");

  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: home } });
  const upgraded = await runtime.saveModelConfig({
    saveTarget: "global",
    gatewayUrl,
    gatewayProtocol: "openai-responses",
    modelId: staleModel.id,
    label: "DeepSeek Reasoner Max",
    reasoningEfforts: ["low", "medium", "high", "max"],
    defaultReasoningEffort: "max",
    switchToModel: false
  });
  assert.equal(upgraded.ok, true);

  const added = await runtime.saveModelConfig({
    saveTarget: "global",
    gatewayUrl,
    gatewayProtocol: "openai-responses",
    modelId: "deepseek-chat",
    label: "DeepSeek Chat",
    switchToModel: false
  });
  assert.equal(added.ok, true);

  const global = JSON.parse(await fs.readFile(globalPath, "utf8"));
  const reasoner = global.models.find((model) => model.id === staleModel.id);
  assert.equal(reasoner.label, "DeepSeek Reasoner Max");
  assert.deepEqual(reasoner.reasoningEfforts.map((effort) => effort.id ?? effort), ["low", "medium", "high", "max"]);
  assert.equal(reasoner.defaultReasoningEffort, "max");

  const status = await runtime.status();
  const restarted = await createDashboardRuntime({ cwd, env: { USERPROFILE: home } }).status();
  const capabilitySnapshot = (snapshot) => {
    const model = snapshot.models.find((candidate) => candidate.id === staleModel.id);
    const profile = snapshot.gatewayProfiles.find((candidate) => candidate.gatewayUrl === gatewayUrl);
    const profileModel = profile?.models.find((candidate) => candidate.id === staleModel.id);
    const capability = (candidate) => ({
      label: candidate?.label,
      reasoningEfforts: candidate?.reasoningEfforts?.map((effort) => effort.id ?? effort),
      defaultReasoningEffort: candidate?.defaultReasoningEffort,
      ownerScope: candidate?.source?.ownerScope
    });
    return {
      effectiveModel: capability(model),
      effectiveProfileModel: capability(profileModel)
    };
  };
  const expectedCapability = () => ({
    effectiveModel: {
      label: "DeepSeek Reasoner Max",
      reasoningEfforts: ["low", "medium", "high", "max"],
      defaultReasoningEffort: "max",
      ownerScope: "global"
    },
    effectiveProfileModel: {
      label: "DeepSeek Reasoner Max",
      reasoningEfforts: ["low", "medium", "high", "max"],
      defaultReasoningEffort: "max",
      ownerScope: "global"
    }
  });
  assert.deepEqual({
    afterUpgrade: capabilitySnapshot(upgraded),
    afterAdditionalGlobalSave: capabilitySnapshot(added),
    liveStatus: capabilitySnapshot(status),
    restartedStatus: capabilitySnapshot(restarted)
  }, {
    afterUpgrade: expectedCapability(),
    afterAdditionalGlobalSave: expectedCapability(),
    liveStatus: expectedCapability(),
    restartedStatus: expectedCapability()
  });
});

test("dashboard migrates exact inherited clones from every project config path", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-all-project-configs-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-home-all-project-configs-"));
  const globalPath = path.join(home, ".ant-code", "lab-agent.config.json");
  const projectPaths = [
    path.join(cwd, "lab-agent.config.json"),
    path.join(cwd, ".lab-agent", "config.json")
  ];
  const gatewayUrl = "https://all-project-configs.gateway.example/v1/responses";
  const profileId = "all-project-configs-profile";
  const staleModel = {
    id: "deepseek-reasoner",
    label: "DeepSeek before max",
    reasoningEfforts: ["low", "high"],
    defaultReasoningEffort: "high"
  };
  const profile = {
    id: profileId,
    label: "Custom source label",
    gatewayUrl,
    gatewayProtocol: "openai-responses",
    modelAlias: staleModel.id,
    models: [staleModel]
  };
  const clone = {
    modelAlias: staleModel.id,
    models: [staleModel],
    lab: {
      gatewayUrl,
      gatewayProtocol: "openai-responses",
      activeGatewayProfile: profileId,
      gatewayProfiles: [profile]
    }
  };

  await fs.mkdir(path.dirname(globalPath), { recursive: true });
  await fs.writeFile(globalPath, JSON.stringify(clone), "utf8");
  for (const projectPath of projectPaths) {
    await fs.mkdir(path.dirname(projectPath), { recursive: true });
    await fs.writeFile(projectPath, JSON.stringify(clone), "utf8");
  }

  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: home } });
  const saved = await runtime.saveModelConfig({
    saveTarget: "global",
    gatewayUrl,
    gatewayProtocol: "openai-responses",
    modelId: staleModel.id,
    label: "DeepSeek with max",
    reasoningEfforts: ["low", "high", "max"],
    defaultReasoningEffort: "max",
    switchToModel: false
  });

  assert.equal(saved.ok, true, `${saved.status}: ${saved.error}`);
  for (const projectPath of projectPaths) {
    const project = JSON.parse(await fs.readFile(projectPath, "utf8"));
    assert.equal(project.modelAlias, undefined);
    assert.equal(project.models, undefined);
    assert.equal(project.lab.activeGatewayProfile, profileId);
    assert.equal(project.lab.gatewayProfiles, undefined);
  }
  const restarted = await createDashboardRuntime({ cwd, env: { USERPROFILE: home } }).status();
  const model = restarted.models.find((candidate) => candidate.id === staleModel.id);
  assert.equal(model?.label, "DeepSeek with max");
  assert.deepEqual(model?.reasoningEfforts.map((effort) => effort.id ?? effort), ["low", "high", "max"]);
  assert.equal(model?.defaultReasoningEffort, "max");
  assert.equal(model?.source?.ownerScope, "global");
});

test("dashboard preserves project health and agent overrides while saving a global model", async (t) => {
  const scenarios = [
    {
      name: "health override",
      project: {
        lab: { gatewayHealthUrl: "https://project-health.gateway.example/health" }
      }
    },
    {
      name: "agent routes",
      project: {
        agents: {
          modelTiers: { strong: "project-strong", vision: "project-vision" },
          vision: {
            enabled: true,
            model: "project-vision",
            autoUseWhenMainModelTextOnly: true
          }
        }
      }
    }
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, () => assertGlobalSavePreservesProjectProjection(scenario.project));
  }
});

async function assertGlobalSavePreservesProjectProjection(projectProjection) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-project-projection-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-home-project-projection-"));
  const globalPath = path.join(home, ".ant-code", "lab-agent.config.json");
  const localPath = path.join(cwd, ".lab-agent", "config.json");
  const gatewayUrl = "https://project-projection.gateway.example/v1/responses";
  const profileId = "project-projection-profile";
  const profile = {
    id: profileId,
    gatewayUrl,
    gatewayProtocol: "openai-responses",
    modelAlias: "shared-model",
    models: [
      { id: "shared-model", reasoningEfforts: ["high"] },
      { id: "project-strong" },
      { id: "project-vision", modalities: ["text", "image"] }
    ]
  };
  const global = {
    modelAlias: profile.modelAlias,
    models: profile.models,
    lab: {
      gatewayUrl,
      gatewayProtocol: "openai-responses",
      activeGatewayProfile: profileId,
      gatewayProfiles: [profile]
    }
  };
  const project = {
    ...(projectProjection.agents ? { agents: projectProjection.agents } : {}),
    lab: {
      activeGatewayProfile: profileId,
      gatewayProfiles: [profile],
      ...(projectProjection.lab ?? {})
    }
  };

  await fs.mkdir(path.dirname(globalPath), { recursive: true });
  await fs.writeFile(globalPath, JSON.stringify(global), "utf8");
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, JSON.stringify(project), "utf8");
  const before = await fs.readFile(localPath, "utf8");

  const saved = await createDashboardRuntime({ cwd, env: { USERPROFILE: home } }).saveModelConfig({
    saveTarget: "global",
    gatewayUrl,
    gatewayProtocol: "openai-responses",
    modelId: "shared-model",
    reasoningEfforts: ["high", "max"],
    defaultReasoningEffort: "max",
    switchToModel: false
  });

  assert.equal(saved.ok, true, `${saved.status}: ${saved.error}`);
  assert.equal(await fs.readFile(localPath, "utf8"), before);
  const storedGlobal = JSON.parse(await fs.readFile(globalPath, "utf8"));
  const storedModel = storedGlobal.lab.gatewayProfiles[0].models
    .find((model) => model.id === "shared-model");
  assert.deepEqual(storedModel.reasoningEfforts.map((effort) => effort.id ?? effort), ["high", "max"]);
  assert.equal(storedModel.defaultReasoningEffort, "max");
}

test("dashboard switching to an inherited global profile does not materialize that profile into project config", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-inherited-switch-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-home-inherited-switch-"));
  const globalPath = path.join(home, ".ant-code", "lab-agent.config.json");
  const localPath = path.join(cwd, ".lab-agent", "config.json");
  const globalProfile = {
    id: "inherited-global-profile",
    gatewayUrl: "https://global-inherited.gateway.example/v1/responses",
    gatewayProtocol: "openai-responses",
    modelAlias: "global-model",
    models: [{ id: "global-model" }]
  };
  const projectProfile = {
    id: "owned-project-profile",
    gatewayUrl: "https://project-owned.gateway.example/v1/chat/completions",
    gatewayProtocol: "openai-chat",
    modelAlias: "project-model",
    models: [{ id: "project-model" }]
  };

  await fs.mkdir(path.dirname(globalPath), { recursive: true });
  await fs.writeFile(globalPath, JSON.stringify({
    modelAlias: globalProfile.modelAlias,
    models: globalProfile.models,
    lab: {
      gatewayUrl: globalProfile.gatewayUrl,
      gatewayProtocol: globalProfile.gatewayProtocol,
      activeGatewayProfile: globalProfile.id,
      gatewayProfiles: [globalProfile]
    }
  }), "utf8");
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, JSON.stringify({
    modelAlias: projectProfile.modelAlias,
    models: projectProfile.models,
    lab: {
      gatewayUrl: projectProfile.gatewayUrl,
      gatewayProtocol: projectProfile.gatewayProtocol,
      activeGatewayProfile: projectProfile.id,
      gatewayProfiles: [projectProfile]
    }
  }), "utf8");

  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: home } });
  const switched = await runtime.switchGatewayProfile({ profileId: globalProfile.id });
  assert.equal(switched.ok, true);
  assert.equal(switched.gatewayConfig.activeProfileId, globalProfile.id);

  const local = JSON.parse(await fs.readFile(localPath, "utf8"));
  assert.equal(local.lab.activeGatewayProfile, globalProfile.id);
  assert.equal(
    local.lab.gatewayProfiles.some((profile) => profile.id === globalProfile.id),
    false,
    "an inherited global profile must remain owned by the global layer"
  );
  assert.deepEqual(local.lab.gatewayProfiles.map((profile) => profile.id), [projectProfile.id]);
});

test("dashboard deleting a project profile override reveals rather than deletes the same-id global profile", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-delete-override-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-home-delete-override-"));
  const globalPath = path.join(home, ".ant-code", "lab-agent.config.json");
  const localPath = path.join(cwd, ".lab-agent", "config.json");
  const profileId = "same-id-profile";
  const gatewayUrl = "https://same-id.gateway.example/v1/responses";
  const globalProfile = {
    id: profileId,
    label: "Global profile",
    gatewayUrl,
    gatewayProtocol: "openai-responses",
    modelAlias: "global-model",
    models: [{ id: "global-model" }]
  };
  const projectProfile = {
    ...globalProfile,
    label: "Project override",
    modelAlias: "project-model",
    models: [{ id: "project-model" }]
  };

  await fs.mkdir(path.dirname(globalPath), { recursive: true });
  await fs.writeFile(globalPath, JSON.stringify({
    modelAlias: globalProfile.modelAlias,
    models: globalProfile.models,
    lab: {
      gatewayUrl,
      gatewayProtocol: "openai-responses",
      activeGatewayProfile: profileId,
      gatewayProfiles: [globalProfile]
    }
  }), "utf8");
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, JSON.stringify({
    modelAlias: projectProfile.modelAlias,
    models: projectProfile.models,
    lab: {
      gatewayUrl,
      gatewayProtocol: "openai-responses",
      activeGatewayProfile: profileId,
      gatewayProfiles: [projectProfile]
    }
  }), "utf8");

  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: home } });
  const initial = await runtime.status();
  assert.equal(initial.gatewayProfiles.find((profile) => profile.id === profileId)?.ownerScope, "project");

  const deleted = await runtime.deleteGatewayProfile({ profileId });
  assert.equal(deleted.ok, true);
  assert.deepEqual(deleted.deletedFromScopes, ["project"]);

  const global = JSON.parse(await fs.readFile(globalPath, "utf8"));
  assert.equal(global.lab.gatewayProfiles.some((profile) => profile.id === profileId), true);
  const refreshed = await runtime.status();
  const revealed = refreshed.gatewayProfiles.find((profile) => profile.id === profileId);
  assert.equal(revealed?.ownerScope, "global");
  assert.equal(revealed?.current, true);
  assert.deepEqual(revealed?.models.map((model) => model.id), ["global-model"]);
});

test("dashboard edits an inactive project profile without switching or mixing agent routes", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-edit-inactive-profile-"));
  const localPath = path.join(cwd, ".lab-agent", "config.json");
  const profileA = {
    id: "project-profile-a",
    gatewayUrl: "https://profile-a.acme.test/v1/responses",
    gatewayProtocol: "openai-responses",
    modelAlias: "a-main",
    models: [
      { id: "a-main", label: "A Main" },
      { id: "a-worker", label: "A Worker" },
      { id: "a-vision", label: "A Vision", modalities: ["text", "image"] }
    ],
    agents: {
      modelTiers: { cheap: "a-worker", default: "a-main", strong: "a-main", vision: "a-vision" },
      vision: { enabled: true, model: "a-vision", autoUseWhenMainModelTextOnly: true }
    }
  };
  const profileB = {
    id: "project-profile-b",
    gatewayUrl: "https://profile-b.acme.test/v1/responses",
    gatewayProtocol: "openai-responses",
    modelAlias: "b-main",
    models: [
      { id: "b-main", label: "B Main" },
      { id: "b-worker", label: "B Worker" },
      { id: "b-vision", label: "B Vision", modalities: ["text", "image"] }
    ],
    agents: {
      modelTiers: { cheap: "b-worker", default: "b-main", strong: "b-main", vision: "b-vision" },
      vision: { enabled: true, model: "b-vision", autoUseWhenMainModelTextOnly: true }
    }
  };

  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, JSON.stringify({
    modelAlias: profileA.modelAlias,
    models: profileA.models,
    agents: profileA.agents,
    lab: {
      gatewayUrl: profileA.gatewayUrl,
      gatewayProtocol: profileA.gatewayProtocol,
      activeGatewayProfile: profileA.id,
      gatewayProfiles: [profileA, profileB]
    }
  }), "utf8");

  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: cwd } });
  const saved = await runtime.saveModelConfig({
    saveTarget: "project",
    profileId: profileB.id,
    gatewayUrl: profileB.gatewayUrl,
    gatewayProtocol: profileB.gatewayProtocol,
    previousModelId: "b-main",
    modelId: "b-main",
    label: "B Main Edited",
    modalities: ["text"],
    switchToModel: false,
    applyAgentDefaults: false
  });

  assert.equal(saved.ok, true);
  assert.equal(saved.gatewayConfig.activeProfileId, profileA.id);
  assert.equal(saved.sessionStatus.model, profileA.modelAlias);

  const local = JSON.parse(await fs.readFile(localPath, "utf8"));
  assert.equal(local.lab.activeGatewayProfile, profileA.id);
  assert.equal(local.modelAlias, profileA.modelAlias);
  assert.deepEqual(local.models.map((model) => model.id), profileA.models.map((model) => model.id));
  assert.deepEqual(local.agents, profileA.agents);
  const storedB = local.lab.gatewayProfiles.find((profile) => profile.id === profileB.id);
  assert.deepEqual(storedB.models.map((model) => model.id), ["b-main", "b-worker", "b-vision"]);
  assert.equal(storedB.models.find((model) => model.id === "b-main")?.label, "B Main Edited");
  assert.deepEqual(storedB.agents, profileB.agents);
  assert.equal(JSON.stringify(storedB).includes("a-main"), false);
  assert.equal(JSON.stringify(storedB).includes("a-vision"), false);

  const restarted = await createDashboardRuntime({ cwd, env: { USERPROFILE: cwd } }).status();
  assert.equal(restarted.gatewayConfig.activeProfileId, profileA.id);
  assert.equal(restarted.sessionStatus.model, profileA.modelAlias);
  assert.deepEqual(
    restarted.gatewayProfiles.find((profile) => profile.id === profileB.id)?.models.map((model) => model.id),
    ["b-main", "b-worker", "b-vision"]
  );
});

test("dashboard deletes a model from its global owner without creating a project shadow", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-delete-global-model-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-home-delete-global-model-"));
  const globalPath = path.join(home, ".ant-code", "lab-agent.config.json");
  const localPath = path.join(cwd, ".lab-agent", "config.json");
  const globalProfile = {
    id: "global-model-profile",
    gatewayUrl: "https://global-models.acme.test/v1/responses",
    gatewayProtocol: "openai-responses",
    modelAlias: "global-main",
    models: [
      { id: "global-main", label: "Global Main" },
      { id: "global-remove", label: "Global Remove" },
      { id: "global-vision", label: "Global Vision", modalities: ["text", "image"] }
    ]
  };

  await fs.mkdir(path.dirname(globalPath), { recursive: true });
  await fs.writeFile(globalPath, JSON.stringify({
    modelAlias: globalProfile.modelAlias,
    models: globalProfile.models,
    lab: {
      gatewayUrl: globalProfile.gatewayUrl,
      gatewayProtocol: globalProfile.gatewayProtocol,
      activeGatewayProfile: globalProfile.id,
      gatewayProfiles: [globalProfile]
    }
  }), "utf8");

  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: home } });
  const deleted = await runtime.deleteModelConfig({
    profileId: globalProfile.id,
    modelId: "global-remove"
  });

  assert.equal(deleted.ok, true);
  assert.equal(deleted.deletedFrom, "global");
  assert.equal(deleted.gatewayConfig.activeProfileId, globalProfile.id);
  assert.deepEqual(deleted.models.map((model) => model.id), ["global-main", "global-vision"]);

  const global = JSON.parse(await fs.readFile(globalPath, "utf8"));
  assert.equal(global.lab.activeGatewayProfile, globalProfile.id);
  assert.deepEqual(global.models.map((model) => model.id), ["global-main", "global-vision"]);
  assert.deepEqual(global.lab.gatewayProfiles[0].models.map((model) => model.id), ["global-main", "global-vision"]);
  await assert.rejects(fs.access(localPath), /ENOENT/);

  const restarted = await createDashboardRuntime({ cwd, env: { USERPROFILE: home } }).status();
  assert.equal(restarted.gatewayConfig.activeProfileId, globalProfile.id);
  assert.deepEqual(restarted.models.map((model) => model.id), ["global-main", "global-vision"]);
});

test("dashboard preserves a legacy project gateway as an owned profile before switching global", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-switch-legacy-project-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-home-switch-legacy-project-"));
  const globalPath = path.join(home, ".ant-code", "lab-agent.config.json");
  const localPath = path.join(cwd, ".lab-agent", "config.json");
  const globalProfile = {
    id: "global-switch-profile",
    gatewayUrl: "https://global-switch.acme.test/v1/responses",
    gatewayProtocol: "openai-responses",
    modelAlias: "global-switch-model",
    models: [{ id: "global-switch-model" }]
  };
  const legacyProjectUrl = "https://legacy-project.acme.test/v1/chat/completions";

  await fs.mkdir(path.dirname(globalPath), { recursive: true });
  await fs.writeFile(globalPath, JSON.stringify({
    modelAlias: globalProfile.modelAlias,
    models: globalProfile.models,
    lab: {
      gatewayUrl: globalProfile.gatewayUrl,
      gatewayProtocol: globalProfile.gatewayProtocol,
      activeGatewayProfile: globalProfile.id,
      gatewayProfiles: [globalProfile]
    }
  }), "utf8");
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, JSON.stringify({
    modelAlias: "legacy-project-main",
    models: [
      { id: "legacy-project-main" },
      { id: "legacy-project-worker" }
    ],
    agents: {
      modelTiers: {
        cheap: "legacy-project-worker",
        default: "legacy-project-main",
        strong: "legacy-project-main"
      }
    },
    lab: {
      gatewayUrl: legacyProjectUrl,
      gatewayProtocol: "openai-chat"
    }
  }), "utf8");

  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: home } });
  const initial = await runtime.status();
  const legacyProfile = initial.gatewayProfiles.find((profile) => profile.gatewayUrl === legacyProjectUrl);
  assert.ok(legacyProfile);
  assert.equal(legacyProfile.ownerScope, "project");

  const switched = await runtime.switchGatewayProfile({ profileId: globalProfile.id });
  assert.equal(switched.ok, true);
  assert.equal(switched.gatewayConfig.activeProfileId, globalProfile.id);

  const local = JSON.parse(await fs.readFile(localPath, "utf8"));
  assert.equal(local.lab.activeGatewayProfile, globalProfile.id);
  assert.equal(local.lab.gatewayProfiles.some((profile) => profile.id === globalProfile.id), false);
  const persistedLegacy = local.lab.gatewayProfiles.find((profile) => profile.id === legacyProfile.id);
  assert.ok(persistedLegacy);
  assert.equal(persistedLegacy.gatewayUrl, legacyProjectUrl);
  assert.deepEqual(persistedLegacy.models.map((model) => model.id), [
    "legacy-project-main",
    "legacy-project-worker"
  ]);

  const restartedRuntime = createDashboardRuntime({ cwd, env: { USERPROFILE: home } });
  const restarted = await restartedRuntime.status();
  assert.equal(restarted.gatewayConfig.activeProfileId, globalProfile.id);
  assert.ok(restarted.gatewayProfiles.some((profile) => profile.id === legacyProfile.id));
  const switchedBack = await restartedRuntime.switchGatewayProfile({ profileId: legacyProfile.id });
  assert.equal(switchedBack.ok, true);
  assert.equal(switchedBack.gatewayConfig.activeProfileId, legacyProfile.id);
  assert.equal(switchedBack.gatewayConfig.gatewayUrl, legacyProjectUrl);
  assert.deepEqual(switchedBack.models.map((model) => model.id), [
    "legacy-project-main",
    "legacy-project-worker"
  ]);
});

test("dashboard deletes a global-owned model through a same-endpoint project profile without shadowing", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-delete-mixed-owner-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-home-delete-mixed-owner-"));
  const globalPath = path.join(home, ".ant-code", "lab-agent.config.json");
  const localPath = path.join(cwd, ".lab-agent", "config.json");
  const gatewayUrl = "https://mixed-owner.gateway.example/v1/responses";
  const globalProfile = {
    id: "global-shared",
    gatewayUrl,
    gatewayProtocol: "openai-responses",
    modelAlias: "global-a",
    models: [
      { id: "global-a", label: "Global A" },
      { id: "global-b", label: "Global B" }
    ]
  };
  const projectProfile = {
    id: "project-shared",
    gatewayUrl,
    gatewayProtocol: "openai-responses",
    modelAlias: "project-a",
    models: [{ id: "project-a", label: "Project A" }]
  };

  await fs.mkdir(path.dirname(globalPath), { recursive: true });
  await fs.writeFile(globalPath, JSON.stringify({
    modelAlias: globalProfile.modelAlias,
    models: globalProfile.models,
    lab: {
      gatewayUrl,
      gatewayProtocol: "openai-responses",
      activeGatewayProfile: globalProfile.id,
      gatewayProfiles: [globalProfile]
    }
  }), "utf8");
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, JSON.stringify({
    modelAlias: projectProfile.modelAlias,
    models: projectProfile.models,
    lab: {
      gatewayUrl,
      gatewayProtocol: "openai-responses",
      activeGatewayProfile: projectProfile.id,
      gatewayProfiles: [projectProfile]
    }
  }), "utf8");

  const projectBefore = await fs.readFile(localPath, "utf8");
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: home } });
  const initial = await runtime.status();
  const effectiveProfile = initial.gatewayProfiles.find((profile) => profile.gatewayUrl === gatewayUrl);
  assert.equal(effectiveProfile?.id, projectProfile.id);
  assert.deepEqual(Object.fromEntries(effectiveProfile.models.map((model) => [model.id, model.source?.ownerScope])), {
    "global-a": "global",
    "global-b": "global",
    "project-a": "project"
  });

  const deleted = await runtime.deleteModelConfig({
    profileId: effectiveProfile.id,
    modelId: "global-b"
  });

  assert.equal(deleted.ok, true, `${deleted.status}: ${deleted.error}`);
  assert.equal(deleted.deletedFrom, "global");
  assert.equal(deleted.configPath, globalPath);
  assert.equal(await fs.readFile(localPath, "utf8"), projectBefore);
  const global = JSON.parse(await fs.readFile(globalPath, "utf8"));
  assert.deepEqual(global.models.map((model) => model.id), ["global-a"]);
  assert.deepEqual(global.lab.gatewayProfiles.find((profile) => profile.id === globalProfile.id).models.map((model) => model.id), ["global-a"]);
  const project = JSON.parse(await fs.readFile(localPath, "utf8"));
  assert.deepEqual(project.models.map((model) => model.id), ["project-a"]);
  assert.deepEqual(project.lab.gatewayProfiles[0].models.map((model) => model.id), ["project-a"]);

  const restarted = await createDashboardRuntime({ cwd, env: { USERPROFILE: home } }).status();
  const restartedProfile = restarted.gatewayProfiles.find((profile) => profile.gatewayUrl === gatewayUrl);
  assert.deepEqual(restartedProfile.models.map((model) => model.id).sort(), ["global-a", "project-a"]);
  assert.equal(restartedProfile.models.find((model) => model.id === "global-a")?.source?.ownerScope, "global");
  assert.equal(restartedProfile.models.find((model) => model.id === "project-a")?.source?.ownerScope, "project");
});

test("dashboard model edits can clear optional capabilities across restart", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-clear-model-options-"));
  const localPath = path.join(cwd, ".lab-agent", "config.json");
  const gatewayUrl = "https://clear-options.gateway.example/v1/chat/completions";
  const profileId = "clear-options-profile";
  const modelId = "optional-model";
  const model = {
    id: modelId,
    label: "Optional Model",
    thinking: true,
    modalities: ["text", "image"],
    contextTokens: 480000,
    reasoningEfforts: ["low", "medium", "high"],
    defaultReasoningEffort: "high",
    agentModelTiers: {
      cheap: "optional-cheap",
      default: "optional-default",
      strong: "optional-strong"
    }
  };
  const agentRoutes = {
    modelTiers: {
      cheap: "optional-cheap",
      default: "optional-default",
      strong: "optional-strong",
      vision: modelId
    },
    vision: { enabled: true, model: modelId, autoUseWhenMainModelTextOnly: true }
  };

  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, JSON.stringify({
    modelAlias: modelId,
    models: [model],
    agents: agentRoutes,
    lab: {
      gatewayUrl,
      gatewayProtocol: "openai-chat",
      activeGatewayProfile: profileId,
      gatewayProfiles: [{
        id: profileId,
        gatewayUrl,
        gatewayProtocol: "openai-chat",
        modelAlias: modelId,
        models: [model],
        agents: agentRoutes
      }]
    }
  }), "utf8");

  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: cwd } });
  const saved = await runtime.saveModelConfig({
    saveTarget: "project",
    profileId,
    gatewayUrl,
    gatewayProtocol: "openai-chat",
    previousModelId: modelId,
    modelId,
    label: "Optional Model",
    contextTokens: "",
    reasoningEfforts: [],
    defaultReasoningEffort: null,
    agentCheapModel: "",
    agentDefaultModel: "",
    agentStrongModel: "",
    visionAgentModel: "",
    modalities: ["text"],
    thinking: false,
    applyAgentDefaults: true,
    switchToModel: true
  });

  assert.equal(saved.ok, true);
  const savedModel = saved.models.find((candidate) => candidate.id === modelId);
  assert.equal(savedModel.contextTokens, null);
  assert.deepEqual(savedModel.reasoningEfforts, []);
  assert.equal(savedModel.defaultReasoningEffort, null);
  assert.deepEqual(savedModel.agentModelTiers, {});
  assert.equal(savedModel.thinking, false);
  assert.deepEqual(savedModel.modalities, ["text"]);
  assert.deepEqual(saved.agentModelTiers, {});
  assert.equal(saved.visionAgent.enabled, false);
  assert.equal(saved.visionAgent.model, "");

  const local = JSON.parse(await fs.readFile(localPath, "utf8"));
  const persistedModels = [
    local.models.find((candidate) => candidate.id === modelId),
    local.lab.gatewayProfiles.find((profile) => profile.id === profileId).models.find((candidate) => candidate.id === modelId)
  ];
  for (const persistedModel of persistedModels) {
    assert.equal(Object.prototype.hasOwnProperty.call(persistedModel, "contextTokens"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(persistedModel, "reasoningEfforts"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(persistedModel, "defaultReasoningEffort"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(persistedModel, "agentModelTiers"), false);
  }
  assert.equal(Object.prototype.hasOwnProperty.call(local.agents, "modelTiers"), false);
  assert.deepEqual(local.agents.vision, {
    enabled: false,
    model: null,
    autoUseWhenMainModelTextOnly: true
  });
  const persistedAgents = local.lab.gatewayProfiles.find((profile) => profile.id === profileId).agents;
  assert.equal(Object.prototype.hasOwnProperty.call(persistedAgents, "modelTiers"), false);
  assert.deepEqual(persistedAgents.vision, local.agents.vision);

  const restarted = await createDashboardRuntime({ cwd, env: { USERPROFILE: cwd } }).status();
  const restartedModel = restarted.models.find((candidate) => candidate.id === modelId);
  assert.equal(restartedModel.contextTokens, null);
  assert.deepEqual(restartedModel.reasoningEfforts, []);
  assert.equal(restartedModel.defaultReasoningEffort, null);
  assert.deepEqual(restartedModel.agentModelTiers, {});
  assert.equal(restartedModel.thinking, false);
  assert.deepEqual(restartedModel.modalities, ["text"]);
  assert.deepEqual(restarted.agentModelTiers, {});
  assert.equal(restarted.visionAgent.enabled, false);
  assert.equal(restarted.visionAgent.model, "");
});

test("dashboard preserves the largest persisted context budget regardless of model save order", async (t) => {
  const cases = [
    { name: "large then small", order: [["large-model", 480000], ["small-model", 120000]] },
    { name: "small then large", order: [["small-model", 120000], ["large-model", 480000]] }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-context-order-"));
      const localPath = path.join(cwd, ".lab-agent", "config.json");
      const gatewayUrl = `https://${testCase.name.startsWith("large") ? "large-first" : "small-first"}.context.gateway.example/v1/chat/completions`;
      const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: cwd } });
      let profileId = "";

      for (const [modelId, contextTokens] of testCase.order) {
        const saved = await runtime.saveModelConfig({
          saveTarget: "project",
          ...(profileId ? { profileId } : {}),
          gatewayUrl,
          gatewayProtocol: "openai-chat",
          modelId,
          label: modelId,
          contextTokens: String(contextTokens),
          modalities: ["text"],
          switchToModel: true
        });
        assert.equal(saved.ok, true);
        profileId = saved.gatewayConfig.activeProfileId;
      }

      const local = JSON.parse(await fs.readFile(localPath, "utf8"));
      assert.equal(local.context.maxTokens, 480000);
      assert.equal(local.context.maxBytes, 1920000);
      assert.ok(local.context.resumeMaxTokens >= 480000);
      assert.ok(local.context.resumeMaxBytes >= 1920000);
      const profile = local.lab.gatewayProfiles.find((candidate) => candidate.id === profileId);
      assert.deepEqual(Object.fromEntries(profile.models.map((candidate) => [candidate.id, candidate.contextTokens])), {
        "large-model": 480000,
        "small-model": 120000
      });

      const restartedRuntime = createDashboardRuntime({ cwd, env: { USERPROFILE: cwd } });
      const switched = await restartedRuntime.switchModel({ profileId, modelId: "large-model" });
      assert.equal(switched.ok, true);
      assert.equal(switched.sessionStatus.context.maxTokens, 480000);
      assert.equal(switched.sessionStatus.context.modelMaxTokens, 480000);
      const afterRestart = JSON.parse(await fs.readFile(localPath, "utf8"));
      assert.equal(afterRestart.context.maxTokens, 480000);
      assert.equal(afterRestart.context.maxBytes, 1920000);
    });
  }
});

test("dashboard edits a global-owned model through a same-endpoint project profile without shadowing", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-edit-mixed-owner-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-home-edit-mixed-owner-"));
  const globalPath = path.join(home, ".ant-code", "lab-agent.config.json");
  const localPath = path.join(cwd, ".lab-agent", "config.json");
  const gatewayUrl = "https://mixed-edit.gateway.example/v1/responses";
  const globalProfile = {
    id: "global-edit-profile",
    gatewayUrl,
    gatewayProtocol: "openai-responses",
    modelAlias: "global-a",
    models: [
      { id: "global-a", label: "Global A" },
      { id: "global-b", label: "Global B" }
    ]
  };
  const projectProfile = {
    id: "project-edit-profile",
    gatewayUrl,
    gatewayProtocol: "openai-responses",
    modelAlias: "project-a",
    models: [{ id: "project-a", label: "Project A" }]
  };

  await fs.mkdir(path.dirname(globalPath), { recursive: true });
  await fs.writeFile(globalPath, JSON.stringify({
    modelAlias: globalProfile.modelAlias,
    models: globalProfile.models,
    lab: {
      gatewayUrl,
      gatewayProtocol: "openai-responses",
      activeGatewayProfile: globalProfile.id,
      gatewayProfiles: [globalProfile]
    }
  }), "utf8");
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, JSON.stringify({
    modelAlias: projectProfile.modelAlias,
    models: projectProfile.models,
    lab: {
      gatewayUrl,
      gatewayProtocol: "openai-responses",
      activeGatewayProfile: projectProfile.id,
      gatewayProfiles: [projectProfile]
    }
  }), "utf8");

  const projectBefore = await fs.readFile(localPath, "utf8");
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: home } });
  const initial = await runtime.status();
  const effectiveProfile = initial.gatewayProfiles.find((profile) => profile.gatewayUrl === gatewayUrl);
  assert.equal(effectiveProfile?.id, projectProfile.id);
  assert.equal(
    effectiveProfile.models.find((model) => model.id === "global-b")?.source?.ownerScope,
    "global"
  );

  const saved = await runtime.saveModelConfig({
    saveTarget: "global",
    profileId: effectiveProfile.id,
    gatewayUrl,
    gatewayProtocol: "openai-responses",
    previousModelId: "global-b",
    modelId: "global-b",
    label: "Global B Edited",
    modalities: ["text"],
    switchToModel: false
  });

  assert.equal(saved.ok, true, `${saved.status}: ${saved.error}`);
  assert.equal(saved.saveTarget, "global");
  assert.equal(saved.configPath, globalPath);
  assert.equal(saved.gatewayConfig.activeProfileId, projectProfile.id);
  assert.equal(await fs.readFile(localPath, "utf8"), projectBefore);

  const global = JSON.parse(await fs.readFile(globalPath, "utf8"));
  assert.equal(global.models.find((model) => model.id === "global-b")?.label, "Global B Edited");
  const storedGlobalProfile = global.lab.gatewayProfiles.find((profile) => profile.id === globalProfile.id);
  assert.equal(storedGlobalProfile.models.find((model) => model.id === "global-b")?.label, "Global B Edited");
  assert.equal(storedGlobalProfile.models.some((model) => model.id === "project-a"), false);

  const restarted = await createDashboardRuntime({ cwd, env: { USERPROFILE: home } }).status();
  const restartedProfile = restarted.gatewayProfiles.find((profile) => profile.gatewayUrl === gatewayUrl);
  assert.equal(restarted.gatewayConfig.activeProfileId, projectProfile.id);
  assert.equal(restartedProfile.models.find((model) => model.id === "global-b")?.label, "Global B Edited");
  assert.equal(restartedProfile.models.find((model) => model.id === "global-b")?.source?.ownerScope, "global");
  assert.equal(restartedProfile.models.find((model) => model.id === "project-a")?.source?.ownerScope, "project");
});

test("dashboard moves the owning global profile when editing its endpoint through a different effective id", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-move-mixed-owner-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-home-move-mixed-owner-"));
  const globalPath = path.join(home, ".ant-code", "lab-agent.config.json");
  const localPath = path.join(cwd, ".lab-agent", "config.json");
  const oldUrl = "https://mixed-move.gateway.example/v1/responses";
  const newUrl = "https://mixed-move.gateway.example/v2/responses";
  const globalProfile = {
    id: "global-move-profile",
    gatewayUrl: oldUrl,
    gatewayProtocol: "openai-responses",
    gatewayApiKey: "global-move-key",
    modelAlias: "global-a",
    models: [
      { id: "global-a", label: "Global A" },
      { id: "global-b", label: "Global B" }
    ]
  };
  const projectProfile = {
    id: "project-move-profile",
    gatewayUrl: oldUrl,
    gatewayProtocol: "openai-responses",
    modelAlias: "project-a",
    models: [{ id: "project-a", label: "Project A" }]
  };

  await fs.mkdir(path.dirname(globalPath), { recursive: true });
  await fs.writeFile(globalPath, JSON.stringify({
    modelAlias: globalProfile.modelAlias,
    models: globalProfile.models,
    lab: {
      gatewayUrl: oldUrl,
      gatewayProtocol: "openai-responses",
      gatewayApiKey: "global-move-key",
      activeGatewayProfile: globalProfile.id,
      gatewayProfiles: [globalProfile]
    }
  }), "utf8");
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, JSON.stringify({
    modelAlias: projectProfile.modelAlias,
    models: projectProfile.models,
    lab: {
      gatewayUrl: oldUrl,
      gatewayProtocol: "openai-responses",
      activeGatewayProfile: projectProfile.id,
      gatewayProfiles: [projectProfile]
    }
  }), "utf8");

  const projectBefore = await fs.readFile(localPath, "utf8");
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: home } });
  const initial = await runtime.status();
  const effectiveProfile = initial.gatewayProfiles.find((profile) => profile.gatewayUrl === oldUrl);
  assert.equal(effectiveProfile?.id, projectProfile.id);
  assert.equal(effectiveProfile.models.find((model) => model.id === "global-b")?.source?.ownerScope, "global");

  const saved = await runtime.saveModelConfig({
    saveTarget: "global",
    profileId: effectiveProfile.id,
    previousGatewayUrl: oldUrl,
    previousGatewayProtocol: "openai-responses",
    gatewayUrl: newUrl,
    gatewayProtocol: "openai-responses",
    previousModelId: "global-b",
    modelId: "global-b",
    label: "Global B Moved",
    credentialAction: "keep",
    switchToModel: false
  });

  assert.equal(saved.ok, true, `${saved.status}: ${saved.error}`);
  assert.equal(await fs.readFile(localPath, "utf8"), projectBefore);
  const global = JSON.parse(await fs.readFile(globalPath, "utf8"));
  assert.equal(global.lab.gatewayProfiles.length, 1);
  assert.equal(global.lab.gatewayProfiles[0].id, globalProfile.id);
  assert.equal(global.lab.gatewayProfiles[0].gatewayUrl, newUrl);
  assert.equal(global.lab.gatewayProfiles[0].gatewayApiKey, "global-move-key");
  assert.deepEqual(global.lab.gatewayProfiles[0].models.map((model) => model.id), ["global-a", "global-b"]);
  assert.equal(global.lab.gatewayProfiles[0].models.find((model) => model.id === "global-b")?.label, "Global B Moved");
  assert.equal(global.lab.gatewayUrl, newUrl);
  assert.equal(global.lab.gatewayApiKey, "global-move-key");

  const restarted = await createDashboardRuntime({ cwd, env: { USERPROFILE: home } }).status();
  assert.deepEqual(new Set(restarted.gatewayProfiles.map((profile) => profile.id)), new Set([
    projectProfile.id,
    globalProfile.id
  ]));
  assert.equal(restarted.gatewayProfiles.find((profile) => profile.id === globalProfile.id)?.gatewayUrl, newUrl);
});

test("dashboard deleting the final project model reveals a same-endpoint global profile with a different id", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-delete-final-project-model-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-home-delete-final-project-model-"));
  const globalPath = path.join(home, ".ant-code", "lab-agent.config.json");
  const localPath = path.join(cwd, ".lab-agent", "config.json");
  const gatewayUrl = "https://mixed-final.gateway.example/v1/responses";
  const globalProfile = {
    id: "global-final-profile",
    gatewayUrl,
    gatewayProtocol: "openai-responses",
    modelAlias: "global-only",
    models: [{ id: "global-only", label: "Global Only" }]
  };
  const projectProfile = {
    id: "project-final-profile",
    gatewayUrl,
    gatewayProtocol: "openai-responses",
    modelAlias: "project-only",
    models: [{ id: "project-only", label: "Project Only" }]
  };

  await fs.mkdir(path.dirname(globalPath), { recursive: true });
  await fs.writeFile(globalPath, JSON.stringify({
    modelAlias: globalProfile.modelAlias,
    models: globalProfile.models,
    lab: {
      gatewayUrl,
      gatewayProtocol: "openai-responses",
      activeGatewayProfile: globalProfile.id,
      gatewayProfiles: [globalProfile]
    }
  }), "utf8");
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, JSON.stringify({
    modelAlias: projectProfile.modelAlias,
    models: projectProfile.models,
    lab: {
      gatewayUrl,
      gatewayProtocol: "openai-responses",
      activeGatewayProfile: projectProfile.id,
      gatewayProfiles: [projectProfile]
    }
  }), "utf8");

  const globalBefore = await fs.readFile(globalPath, "utf8");
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: home } });
  const deleted = await runtime.deleteModelConfig({
    profileId: projectProfile.id,
    modelId: projectProfile.modelAlias
  });

  assert.equal(deleted.ok, true, `${deleted.status}: ${deleted.error}`);
  assert.equal(deleted.deletedFrom, "project");
  assert.equal(deleted.restoredInherited, true);
  assert.equal(deleted.clearedGateway, false);
  assert.equal(deleted.gatewayConfig.activeProfileId, globalProfile.id);
  assert.deepEqual(deleted.models.map((model) => model.id), [globalProfile.modelAlias]);
  assert.equal(await fs.readFile(globalPath, "utf8"), globalBefore);

  const local = JSON.parse(await fs.readFile(localPath, "utf8"));
  assert.equal(local.modelAlias, undefined);
  assert.equal(local.models, undefined);
  assert.equal(local.lab.activeGatewayProfile, globalProfile.id);
  assert.equal(Object.prototype.hasOwnProperty.call(local.lab, "gatewayProfiles"), false);
  for (const key of [
    "gatewayUrl",
    "gatewayHealthUrl",
    "gatewayProtocol",
    "gatewayApiKey",
    "gatewayApiKeyDisabled"
  ]) {
    assert.equal(Object.prototype.hasOwnProperty.call(local.lab, key), false);
  }

  const restarted = await createDashboardRuntime({ cwd, env: { USERPROFILE: home } }).status();
  assert.equal(restarted.gatewayConfig.activeProfileId, globalProfile.id);
  assert.deepEqual(restarted.models.map((model) => model.id), [globalProfile.modelAlias]);
  assert.deepEqual(restarted.gatewayProfiles.map((profile) => profile.id), [globalProfile.id]);
  assert.equal(restarted.models[0].source?.ownerScope, "global");
});

test("dashboard Goal enable requires objective, locks fullAccess, and restores prior mode", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-goal-entry-"));
  const runtime = createDashboardRuntime({
    cwd,
    env: {},
    runTurn: async (_session, options) => {
      await options.onEvent({ type: "turn_complete", status: "completed" });
      return { output: "seeded" };
    }
  });
  await runtime.trustWorkspace();
  const started = await runtime.startTurn({ prompt: "seed session", permissionMode: "workspace" });
  await waitForEvent(runtime, started.sessionId, (event) => event.type === "run_state" && event.running === false);

  const rejected = await runtime.applyGoal({ sessionId: started.sessionId, action: "enable", objective: "   " });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.status, 400);

  const enabled = await runtime.applyGoal({
    sessionId: started.sessionId,
    action: "enable",
    objective: "add running-state filters",
    clientPreviousPermissionMode: "plan"
  });
  assert.equal(enabled.ok, true);
  assert.equal(enabled.goal.enabled, true);
  assert.equal(enabled.goal.text, "add running-state filters");
  assert.equal(enabled.goal.previousPermissionMode, "workspace");
  assert.equal(enabled.permission.mode, "fullAccess");
  assert.equal(enabled.running, true);
  await waitForEvent(runtime, started.sessionId, (event) => event.type === "user_message" && /add running-state filters/.test(String(event.text ?? "")));

  const opened = await runtime.readSession(started.sessionId);
  assert.equal(opened.session.goal.enabled, true);
  assert.equal(opened.session.goal.text, "add running-state filters");

  const disabled = await runtime.applyGoal({ sessionId: started.sessionId, action: "disable" });
  assert.equal(disabled.ok, true);
  assert.equal(disabled.goal.enabled, false);
  assert.equal(disabled.permission.mode, "workspace");
  await runtime.shutdown({ force: true, timeoutMs: 50 });
});

test("dashboard Goal complete snapshot includes compact recap ledger", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-goal-recap-"));
  const runtime = createDashboardRuntime({
    cwd,
    env: {},
    runTurn: async (session, options) => {
      if (session.goal?.enabled) {
        session.usage = {
          source: "provider-reported",
          reports: 3,
          promptTokens: 412000,
          completionTokens: 86000,
          totalTokens: 498000
        };
        await options.onEvent({ type: "turn_complete", status: "completed" });
        return { output: "筛选已加上。\nGOAL_STATUS: complete\nEVIDENCE: tests/unit/dashboard-ui.test.js\nGAPS:\n" };
      }
      await options.onEvent({ type: "turn_complete", status: "completed" });
      return { output: "seeded" };
    }
  });
  await runtime.trustWorkspace();
  const started = await runtime.startTurn({ prompt: "seed session", permissionMode: "workspace" });
  await waitForEvent(runtime, started.sessionId, (event) => event.type === "run_state" && event.running === false);

  const enabled = await runtime.applyGoal({
    sessionId: started.sessionId,
    action: "enable",
    objective: "add running-state filters"
  });
  assert.equal(enabled.ok, true);
  const events = await waitForEvent(runtime, started.sessionId, (event) => (
    event.type === "goal_state" && event.reason === "complete"
  ));
  const completed = events.find((event) => event.type === "goal_state" && event.reason === "complete");
  assert.equal(completed.goal.status, "complete");
  assert.equal(completed.goal.roundCount, 1);
  assert.equal(completed.goal.continueCount, 0);
  assert.match(String(completed.goal.recap?.line ?? ""), /1 轮/);
  assert.match(String(completed.goal.recap?.line ?? ""), /输入 412k \/ 输出 86k/);
  assert.equal(completed.goal.recap?.promptTokens, 412000);
  assert.equal(completed.goal.recap?.completionTokens, 86000);
  await runtime.shutdown({ force: true, timeoutMs: 50 });
});

test("dashboard Goal host continues after a finished turn and honors skip rules", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-goal-continue-"));
  let calls = 0;
  const continueGate = deferred();
  const runtime = createDashboardRuntime({
    cwd,
    env: {},
    runTurn: async (_session, options) => {
      calls += 1;
      if (calls === 1) {
        await options.onEvent({ type: "turn_complete", status: "completed" });
        return { output: "seeded" };
      }
      if (calls === 2) {
        await options.onEvent({ type: "turn_complete", status: "completed" });
        return { output: "working toward goal" };
      }
      await new Promise((_, reject) => {
        const abort = () => reject(cleanupAbortError());
        if (options.signal?.aborted) {
          abort();
          return;
        }
        options.signal?.addEventListener("abort", abort, { once: true });
        continueGate.promise.then(() => reject(cleanupAbortError()));
      });
      return { output: "continued" };
    }
  });
  await runtime.trustWorkspace();
  const started = await runtime.startTurn({ prompt: "seed", permissionMode: "plan" });
  await waitForEvent(runtime, started.sessionId, (event) => event.type === "run_state" && event.running === false);
  const enabled = await runtime.applyGoal({
    sessionId: started.sessionId,
    action: "enable",
    objective: "keep going until filters land"
  });
  assert.equal(enabled.ok, true);
  assert.equal(enabled.running, true);
  const continued = await waitForEvent(runtime, started.sessionId, (event) => event.type === "goal_continued");
  assert.equal(continued.some((event) => event.type === "goal_continued"), true);
  assert.equal(runtime.active.get(started.sessionId).queuedPrompts.some((item) => item.kind === "goal-continue") || calls >= 3, true);

  assert.equal(runtime.listActiveEvents(started.sessionId).filter((event) => event.type === "goal_continued").length, 1);
  runtime.interruptTurn(started.sessionId, "user");
  continueGate.resolve();
  await waitForEvent(runtime, started.sessionId, (event) => event.type === "run_state" && event.running === false);
  assert.equal(runtime.listActiveEvents(started.sessionId).filter((event) => event.type === "goal_continued").length, 1);
  await runtime.shutdown({ force: true, timeoutMs: 50 });
});

test("dashboard Goal skips ask_user and does not emit approval_required for queued writes", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-goal-skip-"));
  const runtime = createDashboardRuntime({
    cwd,
    env: {},
    runTurn: async (session, options) => {
      if (session.goal?.enabled) {
        const asked = await options.userInputCallback({ question: "Which format?" });
        assert.equal(asked.skipped, true);
        assert.equal(asked.reason, "goal_unattended");
        if (session.permissionMode !== "fullAccess") {
          await options.approvalCallback({
            toolName: "write_file",
            input: { path: "filters.md", content: "x" },
            definition: { risk: "write" },
            decision: { reason: "write" }
          });
        }
      }
      await options.onEvent({ type: "turn_complete", status: "completed" });
      return { output: "skipped question\nGOAL_STATUS: in_progress\nEVIDENCE:\nGAPS:\n" };
    }
  });
  await runtime.trustWorkspace();
  const started = await runtime.startTurn({ prompt: "seed", permissionMode: "plan" });
  await waitForEvent(runtime, started.sessionId, (event) => event.type === "run_state" && event.running === false);
  await runtime.applyGoal({
    sessionId: started.sessionId,
    action: "enable",
    objective: "write filters without asking"
  });
  const events = await waitForEvent(runtime, started.sessionId, (event) => event.type === "goal_question_skipped");
  assert.equal(events.some((event) => event.type === "question_required"), false);
  assert.equal(events.some((event) => event.type === "approval_required"), false);
  const finalEvents = await waitForEvent(runtime, started.sessionId, (event) => event.type === "assistant_final");
  assert.doesNotMatch(finalEvents.find((event) => event.type === "assistant_final")?.text ?? "", /GOAL_STATUS:/);
  await runtime.shutdown({ cancelActive: true, force: true, timeoutMs: 200 });
});

test("dashboard Goal continue does not consume the user queue cap and user items win", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-goal-queue-"));
  const firstGate = deferred();
  const runtime = createDashboardRuntime({
    cwd,
    env: {},
    runTurn: async (_session, options) => {
      await firstGate.promise;
      await options.onEvent({ type: "turn_complete", status: "completed" });
      return { output: "held" };
    }
  });
  await runtime.trustWorkspace();
  const started = await runtime.startTurn({ prompt: "hold the turn", permissionMode: "plan" });
  await waitForEvent(runtime, started.sessionId, (event) => event.type === "run_state" && event.running === true);
  await runtime.applyGoal({
    sessionId: started.sessionId,
    action: "enable",
    objective: "do not steal the user queue"
  });
  for (let index = 0; index < 20; index += 1) {
    const queued = await runtime.startTurn({
      prompt: `user ${index + 1}`,
      sessionId: started.sessionId,
      permissionMode: "plan"
    });
    assert.equal(queued.ok, true, queued.error);
  }
  const overflow = await runtime.startTurn({
    prompt: "one too many",
    sessionId: started.sessionId,
    permissionMode: "plan"
  });
  assert.equal(overflow.ok, false);
  assert.equal(overflow.status, 429);
  firstGate.resolve();
  await waitForEvent(runtime, started.sessionId, (event) => event.type === "run_state" && event.running === false, 8000);
  const state = runtime.active.get(started.sessionId);
  assert.equal(state.queuedPrompts.filter((item) => item.kind === "goal-continue").length, 0);
  await runtime.shutdown({ cancelActive: true, force: true, timeoutMs: 200 });
});

test("dashboard Goal stops auto-continue at the configured cap", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-goal-cap-config-"));
  const runtime = createDashboardRuntime({
    cwd,
    env: {},
    runTurn: async (_session, options) => {
      await options.onEvent({ type: "turn_complete", status: "completed" });
      return { output: "still working" };
    }
  });
  await runtime.trustWorkspace();
  const saved = await runtime.saveSettingsConfig({
    section: "agents",
    saveTarget: "project",
    changedFields: ["goalMaxAutoContinues"],
    settings: {
      maxParallelReadonlyAgentRuns: 3,
      backgroundWakeupEnabled: true,
      backgroundByDefault: false,
      reviewGateEnabled: true,
      syncModelTiersOnSwitch: true,
      goalMaxAutoContinues: 2
    }
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.settings.agents.goalMaxAutoContinues, 2);
  const started = await runtime.startTurn({ prompt: "seed", permissionMode: "plan" });
  await waitForEvent(runtime, started.sessionId, (event) => event.type === "run_state" && event.running === false);
  await runtime.applyGoal({
    sessionId: started.sessionId,
    action: "enable",
    objective: "hit the configured continue cap"
  });
  await waitForCondition(() => {
    const goal = runtime.active.get(started.sessionId)?.session?.goal;
    return goal?.lastBlockReason === "budget" || goal?.continueCount >= 2;
  }, 8000);
  const goal = runtime.active.get(started.sessionId).session.goal;
  assert.equal(goal.continueCount, 2);
  assert.equal(goal.status, "paused");
  assert.equal(goal.lastBlockReason, "budget");
  await runtime.shutdown({ cancelActive: true, force: true, timeoutMs: 200 });
});

test("dashboard Goal stops auto-continue at 12 continues", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-goal-cap-"));
  const runtime = createDashboardRuntime({
    cwd,
    env: {},
    runTurn: async (_session, options) => {
      await options.onEvent({ type: "turn_complete", status: "completed" });
      return { output: "still working" };
    }
  });
  await runtime.trustWorkspace();
  const started = await runtime.startTurn({ prompt: "seed", permissionMode: "plan" });
  await waitForEvent(runtime, started.sessionId, (event) => event.type === "run_state" && event.running === false);
  await runtime.applyGoal({
    sessionId: started.sessionId,
    action: "enable",
    objective: "hit the continue cap"
  });
  await waitForCondition(() => {
    const goal = runtime.active.get(started.sessionId)?.session?.goal;
    return goal?.lastBlockReason === "budget";
  }, 8000);
  const goal = runtime.active.get(started.sessionId).session.goal;
  assert.equal(goal.continueCount, 12);
  assert.equal(goal.status, "paused");
  await runtime.shutdown({ cancelActive: true, force: true, timeoutMs: 200 });
});

test("mid-turn Goal enable without text never auto-continues", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-goal-empty-"));
  const gate = deferred();
  const runtime = createDashboardRuntime({
    cwd,
    env: {},
    runTurn: async (_session, options) => {
      await gate.promise;
      await options.onEvent({ type: "turn_complete", status: "completed" });
      return { output: "done without goal text" };
    }
  });
  await runtime.trustWorkspace();
  const started = await runtime.startTurn({ prompt: "running", permissionMode: "plan" });
  await waitForEvent(runtime, started.sessionId, (event) => event.type === "run_state" && event.running === true);
  const rejected = await runtime.applyGoal({ sessionId: started.sessionId, action: "enable" });
  assert.equal(rejected.ok, false);
  gate.resolve();
  await waitForEvent(runtime, started.sessionId, (event) => event.type === "run_state" && event.running === false);
  assert.equal(runtime.listActiveEvents(started.sessionId).some((event) => event.type === "goal_continued"), false);
  await runtime.shutdown({ force: true, timeoutMs: 50 });
});

test("first Goal turn stores client pre-Goal permission instead of upgraded fullAccess", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-goal-first-turn-"));
  const runtime = createDashboardRuntime({
    cwd,
    env: {},
    runTurn: async (_session, options) => {
      await options.onEvent({ type: "turn_complete", status: "completed" });
      return { output: "first goal turn" };
    }
  });
  await runtime.trustWorkspace();
  const started = await runtime.startTurn({
    prompt: "begin unattended work",
    permissionMode: "fullAccess",
    goalMode: true,
    goalText: "add running-state filters",
    clientPreviousPermissionMode: "workspace"
  });
  assert.equal(started.ok, true);
  assert.equal(started.goal.enabled, true);
  assert.equal(started.goal.previousPermissionMode, "workspace");
  await waitForEvent(runtime, started.sessionId, (event) => event.type === "run_state" && event.running === false);
  const disabled = await runtime.applyGoal({ sessionId: started.sessionId, action: "disable" });
  assert.equal(disabled.ok, true);
  assert.equal(disabled.goal.enabled, false);
  assert.equal(disabled.permission.mode, "workspace");
  const opened = await runtime.readSession(started.sessionId);
  assert.equal(opened.session.permission.mode, "workspace");
  await runtime.shutdown({ force: true, timeoutMs: 50 });
});

test("Goal disable while running restores previous permission after interrupt settles", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-goal-disable-running-"));
  const gate = deferred();
  let calls = 0;
  const runtime = createDashboardRuntime({
    cwd,
    env: { ANT_CODE_INTERRUPT_FORCE_SETTLE_MS: "50" },
    runTurn: async (_session, options) => {
      calls += 1;
      if (calls === 1) {
        await options.onEvent({ type: "turn_complete", status: "completed" });
        return { output: "seeded" };
      }
      await gate.promise;
      await options.onEvent({ type: "turn_complete", status: "completed" });
      return { output: "finished after disable" };
    }
  });
  await runtime.trustWorkspace();
  const started = await runtime.startTurn({ prompt: "seed", permissionMode: "workspace" });
  await waitForEvent(runtime, started.sessionId, (event) => event.type === "run_state" && event.running === false);
  const enabled = await runtime.applyGoal({
    sessionId: started.sessionId,
    action: "enable",
    objective: "keep going without a sitter"
  });
  assert.equal(enabled.ok, true);
  assert.equal(enabled.permission.mode, "fullAccess");
  assert.equal(enabled.running, true);
  await waitForEvent(runtime, started.sessionId, (event) => event.type === "run_state" && event.running === true);
  const disabled = await runtime.applyGoal({ sessionId: started.sessionId, action: "disable" });
  assert.equal(disabled.ok, true);
  assert.equal(disabled.goal.enabled, false);
  assert.equal(disabled.permission.mode, "workspace");
  gate.resolve();
  await waitForEvent(runtime, started.sessionId, (event) => event.type === "run_state" && event.running === false);
  const opened = await runtime.readSession(started.sessionId);
  assert.equal(opened.session.goal.enabled, false);
  assert.equal(opened.session.permission.mode, "workspace");
  await runtime.shutdown({ force: true, timeoutMs: 50 });
});
