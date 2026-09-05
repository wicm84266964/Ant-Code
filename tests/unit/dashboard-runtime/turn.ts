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

  const oldWord = await runtime.startTurn({
    prompt: "old word",
    attachments: [{
      type: "document",
      name: "legacy.doc",
      mimeType: "application/msword",
      size: 4,
      data: Buffer.from("ABCD").toString("base64")
    }]
  });
  assert.equal(oldWord.ok, false);
  assert.equal(oldWord.code, "UNSUPPORTED_DOCUMENT_TYPE");
  assert.equal(runtime.active.size, 0);
});

test("dashboard runtime accepts composer PDF attachments and rejects them from the image budget", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-docs-"));
  const seen = deferred();
  const runtime = createDashboardRuntime({
    cwd,
    env: { USERPROFILE: cwd },
    runTurn: async (_session, options) => {
      seen.resolve(options.attachments ?? []);
      await options.onEvent({ type: "turn_complete", status: "completed" });
      return { output: "done" };
    }
  });
  await runtime.trustWorkspace();
  const pdf = Buffer.from("%PDF-1.4\ntrailer<</Root 1 0 R>>\n%%EOF\n");
  const started = await runtime.startTurn({
    prompt: "read attached pdf",
    attachments: [{
      type: "document",
      name: "note.pdf",
      mimeType: "application/pdf",
      size: pdf.length,
      data: pdf.toString("base64")
    }],
    permissionMode: "plan"
  });
  assert.equal(started.ok, true);
  assert.equal(runtime.active.get(started.sessionId).currentAttachmentBytes, 0);
  const received = await seen.promise;
  assert.equal(received.length, 1);
  assert.equal(received[0].type, "document");
  assert.equal(received[0].name, "note.pdf");
  assert.match(String(received[0].path ?? ""), /ant-code-uploads[/\\].*note\.pdf$/);
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
  function saveInput(status: Record<string, unknown>, token: string) {
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
