import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDashboardRuntime } from "../../src/dashboard/sessions.js";
import { saveV2ProviderModel } from "../../src/dashboard/model-settings-v2.js";
import { createSessionStore } from "../../src/storage/session-store.js";

test("Config V2 bottom selection stays isolated per browser tab and never writes settings", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-v2-tab-selection-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "project");
  const env = { USERPROFILE: home };
  await fs.mkdir(path.join(home, ".ant-code"), { recursive: true });
  await fs.mkdir(path.join(cwd, ".lab-agent"), { recursive: true });

  const grok = await saveV2ProviderModel({
    cwd,
    env,
    scope: "global",
    expectedRevision: "missing",
    expectedCredentialsRevision: "missing",
    input: providerInput({
      url: "https://grok.example/v1/responses",
      protocol: "openai-responses",
      modelId: "grok-4.6",
      efforts: ["low", "medium", "high", "xhigh"],
      defaultEffort: "high",
      secret: "grok-tab-secret",
      switchToModel: true
    })
  });
  const deepseek = await saveV2ProviderModel({
    cwd,
    env,
    scope: "global",
    expectedRevision: grok.revisions.global,
    expectedCredentialsRevision: grok.revisions.credentials,
    input: providerInput({
      url: "https://deepseek.example/v1/chat/completions",
      protocol: "openai-chat",
      modelId: "deepseek-v4-pro",
      efforts: ["off", "high", "max"],
      defaultEffort: "high",
      secret: "deepseek-tab-secret"
    })
  });
  const settingsPath = path.join(home, ".ant-code", "settings.json");
  const settingsBefore = await fs.readFile(settingsPath, "utf8");
  const runtime = createDashboardRuntime({ cwd, env });

  const initialA = await runtime.status({ clientId: "tab-a" });
  assert.equal(initialA.sessionStatus.model, "grok-4.6");
  assert.equal(initialA.sessionStatus.reasoningEffort, "high");

  const switched = await runtime.switchModel({
    clientId: "tab-a",
    providerId: deepseek.providerId,
    modelId: "deepseek-v4-pro",
    reasoningEffort: "max"
  });
  assert.equal(switched.ok, true);
  assert.equal(switched.sessionStatus.model, "deepseek-v4-pro");
  assert.equal(switched.sessionStatus.reasoningEffort, "max");

  const reset = await runtime.switchReasoningEffort({
    clientId: "tab-a",
    providerId: deepseek.providerId,
    modelId: "deepseek-v4-pro",
    reasoningEffort: null
  });
  assert.equal(reset.ok, true);
  assert.equal(reset.sessionStatus.reasoningEffort, null);

  const [statusA, statusB] = await Promise.all([
    runtime.status({ clientId: "tab-a" }),
    runtime.status({ clientId: "tab-b" })
  ]);
  assert.equal(statusA.sessionStatus.model, "deepseek-v4-pro");
  assert.equal(statusA.sessionStatus.reasoningEffort, null);
  assert.equal(statusB.sessionStatus.model, "grok-4.6");
  assert.equal(statusB.sessionStatus.reasoningEffort, "high");
  assert.equal(await fs.readFile(settingsPath, "utf8"), settingsBefore);
  await assert.rejects(fs.access(path.join(cwd, ".lab-agent", "settings.json")), { code: "ENOENT" });
});

test("Config V2 provider switches replace subagent and vision routes atomically", async () => {
  const fixture = await createRuntimeFixture({ deepseekAgents: true });
  const runtime = createDashboardRuntime({ cwd: fixture.cwd, env: fixture.env });
  try {
    const deepseek = await runtime.switchModel({
      clientId: "route-switch",
      providerId: "deepseek",
      modelId: "deepseek-v4-pro",
      reasoningEffort: "max"
    });
    assert.equal(deepseek.ok, true);
    assert.deepEqual(deepseek.agentModelTiers, {
      strong: "deepseek-v4-pro",
      vision: "deepseek-v4-pro"
    });
    assert.deepEqual(deepseek.visionAgent, {
      enabled: true,
      model: "deepseek-v4-pro",
      autoUseWhenMainModelTextOnly: true
    });

    const grok = await runtime.switchModel({
      clientId: "route-switch",
      providerId: "grok",
      modelId: "grok-4.6",
      reasoningEffort: "xhigh"
    });
    assert.equal(grok.ok, true);
    assert.deepEqual(grok.agentModelTiers, {});
    assert.equal(grok.visionAgent.model, "");
  } finally {
    await runtime.shutdown({ force: true, timeoutMs: 50 });
  }
});

test("archived Config V2 sessions can clear max effort without changing defaults", async () => {
  const fixture = await createRuntimeFixture();
  const store = createSessionStore({ cwd: fixture.cwd, env: fixture.env });
  const sessionId = "archived-deepseek-max";
  await store.writeMetadata(sessionMetadata(sessionId, {
    model: "deepseek-v4-pro",
    reasoningEffort: "max",
    modelSelection: {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      reasoningEffort: "max"
    }
  }));

  const runtime = createDashboardRuntime({ cwd: fixture.cwd, env: fixture.env });
  try {
    const before = await runtime.status({ clientId: "new-task" });
    const settingsBefore = await fs.readFile(fixture.settingsPath, "utf8");
    const opened = await runtime.readSession(sessionId);
    assert.equal(opened.ok, true);
    assert.deepEqual(selectionStatus(opened.session.sessionStatus), {
      providerId: "deepseek",
      model: "deepseek-v4-pro",
      reasoningEffort: "max",
      selectionResolved: true
    });

    const switched = await runtime.switchModel({
      sessionId,
      providerId: "deepseek",
      modelId: "deepseek-v4-pro",
      reasoningEffort: "max"
    });
    assert.equal(switched.ok, true);
    assert.deepEqual(selectionStatus(switched.sessionStatus), {
      providerId: "deepseek",
      model: "deepseek-v4-pro",
      reasoningEffort: "max",
      selectionResolved: true
    });

    const persisted = await store.readMetadataExact(sessionId);
    assert.equal(persisted.ok, true);
    assert.equal(persisted.metadata.metadataVersion, 2);
    assert.equal(persisted.metadata.model, "deepseek-v4-pro");
    assert.equal(persisted.metadata.reasoningEffort, "max");
    assert.deepEqual(persisted.metadata.modelSelection, {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      reasoningEffort: "max"
    });

    const reset = await runtime.switchReasoningEffort({
      sessionId,
      providerId: "deepseek",
      modelId: "deepseek-v4-pro",
      reasoningEffort: null
    });
    assert.equal(reset.ok, true);
    assert.deepEqual(selectionStatus(reset.sessionStatus), {
      providerId: "deepseek",
      model: "deepseek-v4-pro",
      reasoningEffort: null,
      selectionResolved: true
    });

    const resetMetadata = await store.readMetadataExact(sessionId);
    assert.equal(resetMetadata.ok, true);
    assert.equal(resetMetadata.metadata.reasoningEffort, null);
    assert.deepEqual(resetMetadata.metadata.modelSelection, {
      provider: "deepseek",
      model: "deepseek-v4-pro"
    });

    const reopened = await runtime.readSession(sessionId);
    assert.equal(reopened.ok, true);
    assert.deepEqual(selectionStatus(reopened.session.sessionStatus), {
      providerId: "deepseek",
      model: "deepseek-v4-pro",
      reasoningEffort: null,
      selectionResolved: true
    });

    const after = await runtime.status({ clientId: "new-task" });
    assert.deepEqual(selectionStatus(after.sessionStatus), {
      providerId: "grok",
      model: "grok-4.6",
      reasoningEffort: "high",
      selectionResolved: true
    });
    assert.deepEqual(after.configRevisions, before.configRevisions);
    assert.equal(await fs.readFile(fixture.settingsPath, "utf8"), settingsBefore);
  } finally {
    await runtime.shutdown({ force: true, timeoutMs: 50 });
  }
});

test("legacy sessions infer one provider but ambiguous and deleted selections remain blocked", async () => {
  const fixture = await createRuntimeFixture({ sharedModel: true });
  const store = createSessionStore({ cwd: fixture.cwd, env: fixture.env });
  await Promise.all([
    store.writeMetadata(sessionMetadata("legacy-unique-deepseek", {
      model: "deepseek-v4-pro"
    })),
    store.writeMetadata(sessionMetadata("legacy-ambiguous-model", {
      model: "shared-model"
    })),
    store.writeMetadata(sessionMetadata("deleted-provider-model", {
      model: "removed-model",
      modelSelection: {
        provider: "removed-provider",
        model: "removed-model",
        reasoningEffort: "high"
      }
    }))
  ]);

  let runCalls = 0;
  const runtime = createDashboardRuntime({
    cwd: fixture.cwd,
    env: fixture.env,
    runTurn: async () => {
      runCalls += 1;
      return { output: "must not run" };
    }
  });
  try {
    const unique = await runtime.readSession("legacy-unique-deepseek");
    assert.equal(unique.ok, true);
    assert.deepEqual(selectionStatus(unique.session.sessionStatus), {
      providerId: "deepseek",
      model: "deepseek-v4-pro",
      reasoningEffort: null,
      selectionResolved: true
    });

    const ambiguous = await runtime.readSession("legacy-ambiguous-model");
    assert.equal(ambiguous.ok, true);
    assert.equal(ambiguous.session.sessionStatus.selectionResolved, false);
    assert.equal(ambiguous.session.sessionStatus.selectionIssue.reason, "ambiguous");
    assert.deepEqual(ambiguous.session.sessionStatus.selectionIssue.candidates, ["deepseek", "grok"]);

    const deleted = await runtime.readSession("deleted-provider-model");
    assert.equal(deleted.ok, true);
    assert.equal(deleted.session.sessionStatus.selectionResolved, false);
    assert.equal(deleted.session.sessionStatus.selectionIssue.reason, "missing-provider");
    assert.equal(deleted.session.sessionStatus.providerId, "removed-provider");

    await runtime.trustWorkspace();
    for (const sessionId of ["legacy-ambiguous-model", "deleted-provider-model"]) {
      const blocked = await runtime.startTurn({
        sessionId,
        prompt: "must require an explicit model selection",
        permissionMode: "plan"
      });
      assert.equal(blocked.ok, false);
      assert.equal(blocked.status, 409);
      assert.equal(blocked.code, "SESSION_MODEL_SELECTION_UNRESOLVED");
      assert.equal(blocked.sessionId, sessionId);
    }
    assert.equal(runCalls, 0);
  } finally {
    await runtime.shutdown({ force: true, timeoutMs: 50 });
  }
});

test("active idle session switches survive restart and do not contaminate the new-task selection", async () => {
  const fixture = await createRuntimeFixture();
  const store = createSessionStore({ cwd: fixture.cwd, env: fixture.env });
  const sessionId = "active-idle-selection";
  await store.writeMetadata(sessionMetadata(sessionId, {
    model: "grok-4.6",
    reasoningEffort: "high",
    modelSelection: {
      provider: "grok",
      model: "grok-4.6",
      reasoningEffort: "high"
    }
  }));

  const runTurn = async (_session, options) => {
    await options.onEvent({ type: "turn_complete", status: "completed" });
    return { output: "completed" };
  };
  const runtime = createDashboardRuntime({ cwd: fixture.cwd, env: fixture.env, runTurn });
  try {
    await runtime.trustWorkspace();
    const settingsBefore = await fs.readFile(fixture.settingsPath, "utf8");
    const defaultBefore = await runtime.status({ clientId: "new-task" });
    const resumed = await runtime.startTurn({
      sessionId,
      prompt: "activate persisted session",
      permissionMode: "plan"
    });
    assert.equal(resumed.ok, true);
    await waitUntil(() => runtime.active.peek(sessionId)?.running === false);
    await waitUntil(() => runtime.active.peek(sessionId)?.persisted === true);

    const switched = await runtime.switchModel({
      sessionId,
      providerId: "deepseek",
      modelId: "deepseek-v4-pro",
      reasoningEffort: "max"
    });
    assert.equal(switched.ok, true);
    assert.deepEqual(selectionStatus(switched.sessionStatus), {
      providerId: "deepseek",
      model: "deepseek-v4-pro",
      reasoningEffort: "max",
      selectionResolved: true
    });

    const persisted = await store.readMetadataExact(sessionId);
    assert.equal(persisted.ok, true);
    assert.deepEqual(persisted.metadata.modelSelection, {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      reasoningEffort: "max"
    });

    const reset = await runtime.switchReasoningEffort({
      sessionId,
      providerId: "deepseek",
      modelId: "deepseek-v4-pro",
      reasoningEffort: null
    });
    assert.equal(reset.ok, true);
    assert.deepEqual(selectionStatus(reset.sessionStatus), {
      providerId: "deepseek",
      model: "deepseek-v4-pro",
      reasoningEffort: null,
      selectionResolved: true
    });
    assert.deepEqual(runtime.active.peek(sessionId)?.session.modelSelection, {
      provider: "deepseek",
      model: "deepseek-v4-pro"
    });

    const resetMetadata = await store.readMetadataExact(sessionId);
    assert.equal(resetMetadata.ok, true);
    assert.equal(resetMetadata.metadata.reasoningEffort, null);
    assert.deepEqual(resetMetadata.metadata.modelSelection, {
      provider: "deepseek",
      model: "deepseek-v4-pro"
    });

    const nextTurn = await runtime.startTurn({
      sessionId,
      prompt: "continue with the provider default effort",
      permissionMode: "plan"
    });
    assert.equal(nextTurn.ok, true);
    assert.deepEqual(selectionStatus(nextTurn.sessionStatus), {
      providerId: "deepseek",
      model: "deepseek-v4-pro",
      reasoningEffort: null,
      selectionResolved: true
    });
    await waitUntil(() => runtime.active.peek(sessionId)?.running === false);
    assert.equal(runtime.active.peek(sessionId)?.session.config.reasoningEffort, null);

    const newTask = await runtime.status({ clientId: "new-task" });
    assert.deepEqual(selectionStatus(newTask.sessionStatus), {
      providerId: "grok",
      model: "grok-4.6",
      reasoningEffort: "high",
      selectionResolved: true
    });
    assert.deepEqual(newTask.configRevisions, defaultBefore.configRevisions);
    assert.equal(await fs.readFile(fixture.settingsPath, "utf8"), settingsBefore);
  } finally {
    await runtime.shutdown({ force: true, timeoutMs: 50 });
  }

  const restarted = createDashboardRuntime({ cwd: fixture.cwd, env: fixture.env, runTurn });
  try {
    const reopened = await restarted.readSession(sessionId);
    assert.equal(reopened.ok, true);
    assert.deepEqual(selectionStatus(reopened.session.sessionStatus), {
      providerId: "deepseek",
      model: "deepseek-v4-pro",
      reasoningEffort: null,
      selectionResolved: true
    });
    await restarted.trustWorkspace();
    const resumedTurn = await restarted.startTurn({
      sessionId,
      prompt: "resume after restart with the provider default effort",
      permissionMode: "plan"
    });
    assert.equal(resumedTurn.ok, true);
    assert.deepEqual(selectionStatus(resumedTurn.sessionStatus), {
      providerId: "deepseek",
      model: "deepseek-v4-pro",
      reasoningEffort: null,
      selectionResolved: true
    });
    await waitUntil(() => restarted.active.peek(sessionId)?.running === false);
    assert.equal(restarted.active.peek(sessionId)?.session.config.reasoningEffort, null);
  } finally {
    await restarted.shutdown({ force: true, timeoutMs: 50 });
  }
});

test("Config V2 common settings saves preserve an active idle session's DeepSeek max selection", async () => {
  const fixture = await createRuntimeFixture();
  const sessionId = "active-settings-deepseek-max";
  const { runtime, store, selection } = await activateDeepseekMaxSession(fixture, sessionId);
  try {
    const defaultStatus = await runtime.status({ clientId: "settings-default" });
    assert.deepEqual(selectionStatus(defaultStatus.sessionStatus), {
      providerId: "grok",
      model: "grok-4.6",
      reasoningEffort: "high",
      selectionResolved: true
    });

    const saves = [
      {
        section: "transcript",
        settings: { enabled: true, retentionDays: 3650, encryption: "optional" }
      },
      {
        section: "network",
        settings: { networkMode: "approved-web", allowedHosts: ["api.example"] }
      },
      {
        section: "agents",
        settings: {
          maxParallelReadonlyAgentRuns: 4,
          backgroundWakeupEnabled: true,
          backgroundByDefault: false,
          reviewGateEnabled: true,
          syncModelTiersOnSwitch: false
        }
      },
      {
        section: "reliability",
        settings: { maxRetries: 5, timeoutMs: 900000, idleTimeoutMs: 300000 }
      }
    ];

    for (const save of saves) {
      const saved = await runtime.saveSettingsConfig({
        sessionId,
        saveTarget: "global",
        ...save
      });
      assert.equal(saved.ok, true, `${save.section}: ${saved.status} ${saved.error}`);
      assert.deepEqual(selectionStatus(saved.sessionStatus), {
        providerId: selection.provider,
        model: selection.model,
        reasoningEffort: selection.reasoningEffort,
        selectionResolved: true
      });
      assert.deepEqual(runtime.active.peek(sessionId)?.session.modelSelection, selection);

      const persisted = await store.readMetadataExact(sessionId);
      assert.equal(persisted.ok, true);
      assert.equal(persisted.metadata.metadataVersion, 2);
      assert.deepEqual(persisted.metadata.modelSelection, selection);
    }
  } finally {
    await runtime.shutdown({ force: true, timeoutMs: 50 });
  }
});

test("editing a Grok model without switching preserves an active idle DeepSeek max selection", async () => {
  const fixture = await createRuntimeFixture();
  const sessionId = "active-edit-grok-deepseek-max";
  const clientId = "grok-settings-editor";
  const { runtime, store, selection } = await activateDeepseekMaxSession(fixture, sessionId);
  try {
    const before = await runtime.status({ clientId });
    assert.deepEqual(selectionStatus(before.sessionStatus), {
      providerId: "grok",
      model: "grok-4.6",
      reasoningEffort: "high",
      selectionResolved: true
    });

    const saved = await runtime.saveModelConfig({
      sessionId,
      clientId,
      saveTarget: "global",
      expectedRevision: before.configRevisions.global,
      expectedCredentialsRevision: before.configRevisions.credentials,
      providerId: "grok",
      gatewayUrl: "https://grok.example/v1/responses",
      gatewayProtocol: "openai-responses",
      previousModelId: "grok-4.6",
      modelId: "grok-4.6",
      label: "Grok 4.6 edited",
      thinking: true,
      modalities: ["text"],
      reasoningEfforts: ["low", "medium", "high", "xhigh"],
      defaultReasoningEffort: "high",
      credentialAction: "keep",
      switchToModel: false
    });

    assert.equal(saved.ok, true, `${saved.status}: ${saved.error}`);
    assert.notEqual(saved.configRevisions.global, before.configRevisions.global);
    assert.equal(saved.configRevisions.global, saved.configRevision);
    assert.equal(saved.configRevisions.project, before.configRevisions.project);
    assert.equal(saved.configRevisions.credentials, before.configRevisions.credentials);
    assert.deepEqual(selectionStatus(saved.sessionStatus), {
      providerId: selection.provider,
      model: selection.model,
      reasoningEffort: selection.reasoningEffort,
      selectionResolved: true
    });
    assert.deepEqual(runtime.active.peek(sessionId)?.session.modelSelection, selection);

    const persisted = await store.readMetadataExact(sessionId);
    assert.equal(persisted.ok, true);
    assert.equal(persisted.metadata.metadataVersion, 2);
    assert.deepEqual(persisted.metadata.modelSelection, selection);

    const settings = JSON.parse(await fs.readFile(fixture.settingsPath, "utf8"));
    const edited = settings.namespaces["model-providers"].providers.grok.models
      .find((model) => model.id === "grok-4.6");
    assert.equal(edited?.displayName, "Grok 4.6 edited");
  } finally {
    await runtime.shutdown({ force: true, timeoutMs: 50 });
  }
});

test("deleting an active idle session model preserves its exact unresolved selection", async () => {
  const fixture = await createRuntimeFixture({ deepseekSecondary: true });
  const store = createSessionStore({ cwd: fixture.cwd, env: fixture.env });
  const sessionId = "active-delete-current-model";
  const originalSelection = {
    provider: "deepseek",
    model: "deepseek-v4-pro",
    reasoningEffort: "max"
  };
  await store.writeMetadata(sessionMetadata(sessionId, {
    metadataVersion: 2,
    model: originalSelection.model,
    reasoningEffort: originalSelection.reasoningEffort,
    modelSelection: originalSelection
  }));

  let runCalls = 0;
  const runtime = createDashboardRuntime({
    cwd: fixture.cwd,
    env: fixture.env,
    runTurn: async (_session, options) => {
      runCalls += 1;
      await options.onEvent({ type: "turn_complete", status: "completed" });
      return { output: "completed" };
    }
  });
  try {
    await runtime.trustWorkspace();
    const activated = await runtime.startTurn({
      sessionId,
      prompt: "activate before deleting the selected model",
      permissionMode: "plan"
    });
    assert.equal(activated.ok, true);
    await waitUntil(() => runtime.active.peek(sessionId)?.running === false);
    await waitUntil(() => runtime.active.peek(sessionId)?.persisted === true);
    assert.equal(runCalls, 1);

    const before = await runtime.status({ clientId: "active-delete-review" });
    const deletePromise = runtime.deleteModelConfig({
      sessionId,
      providerId: originalSelection.provider,
      modelId: originalSelection.model,
      scope: "global",
      expectedRevision: before.configRevisions.global,
      expectedCredentialsRevision: before.configRevisions.credentials
    });
    const startPromise = runtime.startTurn({
      sessionId,
      prompt: "must wait for the selected model deletion",
      permissionMode: "plan"
    });
    const [deleted, blocked] = await Promise.all([deletePromise, startPromise]);

    assert.equal(deleted.ok, true);
    assert.equal(deleted.sessionStatus.providerId, originalSelection.provider);
    assert.equal(deleted.sessionStatus.model, originalSelection.model);
    assert.equal(deleted.sessionStatus.reasoningEffort, originalSelection.reasoningEffort);
    assert.equal(deleted.sessionStatus.selectionResolved, false);
    assert.equal(deleted.sessionStatus.selectionIssue.reason, "missing-model");
    assert.ok(
      deleted.gatewayProfiles.find((profile) => profile.id === "deepseek")?.models.some((model) => model.id === "deepseek-fallback"),
      "the provider must retain another model so this test proves no fallback occurred"
    );

    const activeSession = runtime.active.peek(sessionId)?.session;
    assert.equal(activeSession?.model, originalSelection.model);
    assert.deepEqual(activeSession?.modelSelection, originalSelection);

    const persisted = await store.readMetadataExact(sessionId);
    assert.equal(persisted.ok, true);
    assert.equal(persisted.metadata.model, originalSelection.model);
    assert.equal(persisted.metadata.reasoningEffort, originalSelection.reasoningEffort);
    assert.deepEqual(persisted.metadata.modelSelection, originalSelection);

    assert.equal(blocked.ok, false);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.code, "SESSION_MODEL_SELECTION_UNRESOLVED");
    assert.equal(blocked.reason, "missing-model");
    assert.equal(runCalls, 1);
  } finally {
    await runtime.shutdown({ force: true, timeoutMs: 50 });
  }
});

test("deleting an archived session provider preserves its exact unresolved selection", async () => {
  const fixture = await createRuntimeFixture();
  const store = createSessionStore({ cwd: fixture.cwd, env: fixture.env });
  const sessionId = "archived-delete-current-provider";
  const originalSelection = {
    provider: "deepseek",
    model: "deepseek-v4-pro",
    reasoningEffort: "max"
  };
  await store.writeMetadata(sessionMetadata(sessionId, {
    metadataVersion: 2,
    model: originalSelection.model,
    reasoningEffort: originalSelection.reasoningEffort,
    modelSelection: originalSelection
  }));

  let runCalls = 0;
  const runtime = createDashboardRuntime({
    cwd: fixture.cwd,
    env: fixture.env,
    runTurn: async () => {
      runCalls += 1;
      return { output: "must not run" };
    }
  });
  try {
    await runtime.trustWorkspace();
    const before = await runtime.status({ clientId: "archived-delete-review" });
    const deleted = await runtime.deleteGatewayProfile({
      sessionId,
      profileId: originalSelection.provider,
      providerId: originalSelection.provider,
      scope: "global",
      expectedRevision: before.configRevisions.global,
      expectedCredentialsRevision: before.configRevisions.credentials
    });

    assert.equal(deleted.ok, true);
    assert.equal(deleted.sessionStatus.providerId, originalSelection.provider);
    assert.equal(deleted.sessionStatus.model, originalSelection.model);
    assert.equal(deleted.sessionStatus.reasoningEffort, originalSelection.reasoningEffort);
    assert.equal(deleted.sessionStatus.selectionResolved, false);
    assert.equal(deleted.sessionStatus.selectionIssue.reason, "missing-provider");
    assert.equal(runtime.active.peek(sessionId), undefined);

    const persisted = await store.readMetadataExact(sessionId);
    assert.equal(persisted.ok, true);
    assert.equal(persisted.metadata.model, originalSelection.model);
    assert.equal(persisted.metadata.reasoningEffort, originalSelection.reasoningEffort);
    assert.deepEqual(persisted.metadata.modelSelection, originalSelection);

    const blocked = await runtime.startTurn({
      sessionId,
      prompt: "must not fall back to the global Grok default",
      permissionMode: "plan"
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.code, "SESSION_MODEL_SELECTION_UNRESOLVED");
    assert.equal(blocked.reason, "missing-provider");
    assert.equal(runCalls, 0);
  } finally {
    await runtime.shutdown({ force: true, timeoutMs: 50 });
  }
});

test("cross-runtime provider deletion cancels queued turns without affecting other providers", async () => {
  const fixture = await createRuntimeFixture();
  const store = createSessionStore({ cwd: fixture.cwd, env: fixture.env });
  const deepseekSessionId = "cross-runtime-deepseek-queue";
  const grokSessionId = "cross-runtime-grok-control";
  await Promise.all([
    store.writeMetadata(sessionMetadata(deepseekSessionId, {
      metadataVersion: 2,
      model: "deepseek-v4-pro",
      reasoningEffort: "max",
      modelSelection: {
        provider: "deepseek",
        model: "deepseek-v4-pro",
        reasoningEffort: "max"
      }
    })),
    store.writeMetadata(sessionMetadata(grokSessionId, {
      metadataVersion: 2,
      model: "grok-4.6",
      reasoningEffort: "high",
      modelSelection: {
        provider: "grok",
        model: "grok-4.6",
        reasoningEffort: "high"
      }
    }))
  ]);

  const firstDeepseekTurn = deferred();
  const calls = [];
  const runtimeA = createDashboardRuntime({
    cwd: fixture.cwd,
    env: fixture.env,
    runTurn: async (session, options) => {
      calls.push({ sessionId: session.id, prompt: options.prompt });
      if (session.id === deepseekSessionId) {
        await firstDeepseekTurn.promise;
      }
      await options.onEvent({ type: "turn_complete", status: "completed" });
      return { output: "completed" };
    }
  });
  const runtimeB = createDashboardRuntime({ cwd: fixture.cwd, env: fixture.env });
  try {
    await runtimeA.trustWorkspace();
    const first = await runtimeA.startTurn({
      sessionId: deepseekSessionId,
      prompt: "running before another runtime deletes DeepSeek",
      permissionMode: "plan"
    });
    assert.equal(first.ok, true);
    await waitUntil(() => calls.some((call) => call.sessionId === deepseekSessionId));

    const queued = await runtimeA.startTurn({
      sessionId: deepseekSessionId,
      prompt: "must be cancelled after DeepSeek is deleted",
      permissionMode: "plan"
    });
    assert.equal(queued.ok, true);
    assert.equal(queued.queued, true);
    assert.equal(runtimeA.active.peek(deepseekSessionId)?.queuedPrompts.length, 1);

    const before = await runtimeB.status({ clientId: "cross-runtime-delete" });
    const deleted = await runtimeB.deleteGatewayProfile({
      profileId: "deepseek",
      providerId: "deepseek",
      scope: "global",
      expectedRevision: before.configRevisions.global,
      expectedCredentialsRevision: before.configRevisions.credentials
    });
    assert.equal(deleted.ok, true);

    const grok = await runtimeA.startTurn({
      sessionId: grokSessionId,
      prompt: "Grok remains available after DeepSeek is deleted",
      permissionMode: "plan"
    });
    assert.equal(grok.ok, true);
    await waitUntil(() => runtimeA.active.peek(grokSessionId)?.running === false);

    firstDeepseekTurn.resolve();
    await waitUntil(() => runtimeA.active.peek(deepseekSessionId)?.running === false);
    await waitUntil(() => runtimeA.active.peek(deepseekSessionId)?.queuedPrompts.length === 0);

    assert.equal(calls.filter((call) => call.sessionId === deepseekSessionId).length, 1);
    assert.equal(calls.filter((call) => call.sessionId === grokSessionId).length, 1);
    const blocked = await runtimeA.startTurn({
      sessionId: deepseekSessionId,
      prompt: "must stay blocked until an explicit valid selection is chosen",
      permissionMode: "plan"
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.code, "SESSION_MODEL_SELECTION_UNRESOLVED");
    assert.equal(blocked.reason, "missing-provider");
  } finally {
    firstDeepseekTurn.resolve();
    await Promise.all([
      runtimeA.shutdown({ force: true, timeoutMs: 50 }),
      runtimeB.shutdown({ force: true, timeoutMs: 50 })
    ]);
  }
});

async function activateDeepseekMaxSession(fixture, sessionId) {
  const store = createSessionStore({ cwd: fixture.cwd, env: fixture.env });
  const selection = {
    provider: "deepseek",
    model: "deepseek-v4-pro",
    reasoningEffort: "max"
  };
  await store.writeMetadata(sessionMetadata(sessionId, {
    metadataVersion: 2,
    model: selection.model,
    reasoningEffort: selection.reasoningEffort,
    modelSelection: selection
  }));

  const runtime = createDashboardRuntime({
    cwd: fixture.cwd,
    env: fixture.env,
    runTurn: async (_session, options) => {
      await options.onEvent({ type: "turn_complete", status: "completed" });
      return { output: "completed" };
    }
  });
  await runtime.trustWorkspace();
  const activated = await runtime.startTurn({
    sessionId,
    prompt: "activate the persisted DeepSeek max session",
    permissionMode: "plan"
  });
  assert.equal(activated.ok, true);
  await waitUntil(() => runtime.active.peek(sessionId)?.running === false);
  await waitUntil(() => runtime.active.peek(sessionId)?.persisted === true);
  assert.deepEqual(selectionStatus((await runtime.readSession(sessionId)).session.sessionStatus), {
    providerId: selection.provider,
    model: selection.model,
    reasoningEffort: selection.reasoningEffort,
    selectionResolved: true
  });
  return { runtime, store, selection };
}

async function createRuntimeFixture(options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-v2-session-selection-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "project");
  const settingsPath = path.join(home, ".ant-code", "settings.json");
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify(runtimeSettingsDocument(options), null, 2), "utf8");
  return { cwd, settingsPath, env: { USERPROFILE: home } };
}

function runtimeSettingsDocument(options = {}) {
  const shared = options.sharedModel === true ? [{ id: "shared-model" }] : [];
  const deepseek = runtimeProvider("DeepSeek", "openai-chat", "https://deepseek.example/v1/chat/completions", [
    runtimeModel("deepseek-v4-pro", ["off", "high", "max"], "high"),
    ...(options.deepseekSecondary === true
      ? [runtimeModel("deepseek-fallback", ["off", "high", "max"], "high")]
      : []),
    ...shared
  ]);
  if (options.deepseekAgents === true) {
    deepseek.agents = {
      modelTiers: {
        strong: "deepseek-v4-pro",
        vision: "deepseek-v4-pro"
      },
      vision: {
        enabled: true,
        model: "deepseek-v4-pro",
        autoUseWhenMainModelTextOnly: true
      }
    };
  }
  return {
    settingsVersion: 2,
    namespaces: {
      "model-providers": {
        providers: {
          grok: runtimeProvider("Grok", "openai-responses", "https://grok.example/v1/responses", [
            runtimeModel("grok-4.6", ["low", "medium", "high", "xhigh"], "high"),
            ...shared
          ]),
          deepseek
        }
      },
      "default-model": {
        selection: { provider: "grok", model: "grok-4.6", reasoningEffort: "high" }
      }
    }
  };
}

function runtimeProvider(displayName, protocol, baseURL, models) {
  return {
    displayName,
    transport: { protocol, baseURL },
    auth: { mode: "none" },
    models
  };
}

function runtimeModel(id, efforts, defaultEffort) {
  return {
    id,
    reasoning: {
      efforts: efforts.map((effortId) => ({ id: effortId })),
      default: defaultEffort
    }
  };
}

function sessionMetadata(id, selection = {}) {
  return {
    id,
    cwd: "project",
    title: id,
    status: "completed",
    startedAt: "2026-08-28T00:00:00.000Z",
    turnIndex: 1,
    transcript: { messages: [], contextMessages: [] },
    ...selection
  };
}

function selectionStatus(status) {
  return {
    providerId: status.providerId,
    model: status.model,
    reasoningEffort: status.reasoningEffort,
    selectionResolved: status.selectionResolved
  };
}

async function waitUntil(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("timed out waiting for dashboard state");
}

function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function providerInput(options) {
  return {
    profileId: "",
    gatewayUrl: options.url,
    gatewayProtocol: options.protocol,
    gatewayApiKey: options.secret,
    credentialAction: "replace",
    switchToModel: options.switchToModel === true,
    model: {
      id: options.modelId,
      label: options.modelId,
      thinking: true,
      modalities: ["text"],
      reasoningEfforts: options.efforts,
      defaultReasoningEffort: options.defaultEffort
    }
  };
}
