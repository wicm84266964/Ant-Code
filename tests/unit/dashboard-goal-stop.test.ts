import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../../src/config/load-config.ts";
import { resolveSessionModelSelection } from "../../src/config-v2/runtime-selection.ts";
import { createSession, persistSessionSnapshot } from "../../src/core/session.ts";
import { persistSessionMetadata } from "../../src/core/session-persist.ts";
import { applyPermissionMode } from "../../src/dashboard/permissions.ts";
import { normalizeSessionGoal } from "../../src/core/goal.ts";
import { createDashboardRuntime } from "../../src/dashboard/sessions.ts";
import { createQueueItem, createTurnState } from "../../src/dashboard/runtime/turn-queue.ts";
import { listHookAudit } from "../../src/hooks/audit-store.ts";
import { createSessionStore } from "../../src/storage/session-store.ts";

const identities = [
  { name: "legacy-empty", fields: {}, reason: "legacy-no-match" },
  { name: "legacy-removed", fields: { model: "removed-model", metadataVersion: 1, reasoningEffort: "high" }, reason: "legacy-no-match" },
  { name: "v2-missing-provider", fields: { metadataVersion: 2, model: "removed-model", reasoningEffort: "high", modelSelection: { provider: "removed", model: "removed-model", reasoningEffort: "high" } }, reason: "missing-provider" },
  { name: "ambiguous", fields: { model: "shared-model" }, reason: "ambiguous" }
];
const actions = ["disable", "clear", "pause"];

for (const identity of identities) {
  test(`archived ${identity.name}: Goal stop persists without hydrating or repairing model identity`, async (t) => {
    const fixture = await makeFixture(t);
    await fixture.runtime.trustWorkspace();
    for (const action of actions) {
      const id = `${identity.name}-${action}`;
      const original = metadata(id, identity.fields);
      await fixture.store.writeMetadata(original);
      const hooksBefore = listHookAudit();
      const opened = await fixture.runtime.readSession(id);
      assert.equal(opened.ok, true);
      assert.equal(opened.session.active, false);
      assert.equal(opened.session.running, false);
      assert.equal(opened.session.status, "paused");
      assert.equal(opened.session.goal.status, "paused");
      const listed = (await fixture.runtime.listSessionRecords()).find((item) => item.id === id);
      assert.equal(listed.running, false);
      assert.equal(listed.status, "paused");
      assert.equal(listed.goalStatus, "paused");
      assert.deepEqual((await fixture.store.readMetadataExact(id)).metadata, original);
      assert.equal(fixture.runtime.active.size, 0);
      assert.deepEqual(listHookAudit(), hooksBefore);

      for (const startAction of ["enable", "resume"]) {
        const blocked = await fixture.runtime.applyGoal({ sessionId: id, action: startAction, objective: "must not start" });
        assert.equal(blocked.ok, false);
        assert.equal(blocked.status, 409);
        assert.equal(blocked.code, "SESSION_MODEL_SELECTION_UNRESOLVED");
        assert.equal(blocked.reason, identity.reason);
        assert.equal(fixture.runtime.active.size, 0);
      }
      const blockedTurn = await fixture.runtime.startTurn({ sessionId: id, prompt: "must not run" });
      assert.equal(blockedTurn.status, 409);
      assert.equal(blockedTurn.code, "SESSION_MODEL_SELECTION_UNRESOLVED");

      const stopped = await fixture.runtime.applyGoal({ sessionId: id, action });
      assert.equal(stopped.ok, true, stopped.error);
      assert.equal(stopped.running, false);
      assert.equal(stopped.active, false);
      assert.equal(stopped.goal.enabled, action === "pause");
      assert.equal(stopped.goal.status, action === "pause" ? "paused" : "off");
      assert.equal(stopped.goal.text, action === "clear" ? "" : original.goal.text);
      assert.equal(stopped.permission.mode, "workspace");
      const persisted = (await fixture.store.readMetadataExact(id)).metadata;
      assert.deepEqual(withoutGoalPermission(persisted), withoutGoalPermission(original));
      assert.equal(persisted.goal.status, action === "pause" ? "paused" : "off");
      assert.equal(persisted.goal.enabled, action === "pause");
      assert.equal(persisted.goal.text, action === "clear" ? "" : original.goal.text);
      assert.equal(persisted.permissionMode, "workspace");
      assert.equal(fixture.calls(), 0);
      assert.equal(fixture.runtime.active.size, 0);
      assert.deepEqual(listHookAudit(), hooksBefore);
    }
  });
}

for (const running of [false, true]) {
  test(`active ${running ? "running" : "idle"} unresolved Goal controls do not restore models or start new work`, async (t) => {
    const fixture = await makeFixture(t);
    await fixture.runtime.trustWorkspace();
    for (const [index, action] of actions.entries()) {
      const identity = identities[index === 2 ? 3 : index + 1];
      const id = `active-${running}-${action}`;
      // Construct a real session only for the fixture; the operation under test
      // must reuse this state even after its model becomes unresolvable.
      const session = await createSession({ cwd: fixture.cwd, env: fixture.env, mode: "interactive" });
      session.id = id;
      session.model = String(identity.fields.model ?? "");
      session.modelSelection = identity.fields.modelSelection ?? null;
      session.goal = normalizeSessionGoal(metadata(id).goal, { hydrateRunningAsPaused: false });
      session.permissionMode = "fullAccess";
      session.permissionReadonlyLocked = true; // Must not block stop controls.
      const original = metadata(id, identity.fields);
      await fixture.store.writeMetadata(original);
      const state = createTurnState(session, fixture.runTurn, { persisted: true });
      state.running = running;
      state.status = running ? "running" : "idle";
      state.controller = new AbortController();
      state.workAdmissionBlocked = () => true; // Maintenance cannot prevent stopping.
      state.queuedPrompts.push(createQueueItem("continuation", "fullAccess", "goal-continue"));
      fixture.runtime.active.set(id, state);
      const modelBefore = { model: session.model, selection: session.modelSelection, config: session.config };
      const transcriptBefore = structuredClone(session.transcriptMessages);
      const hooksBefore = listHookAudit();
      for (const startAction of ["enable", "resume"]) {
        const blocked = await fixture.runtime.applyGoal({ sessionId: id, action: startAction, objective: "must not start" });
        assert.equal(blocked.status, 409);
        assert.equal(blocked.code, "SESSION_MODEL_SELECTION_UNRESOLVED");
        assert.equal(blocked.reason, identity.reason);
      }
      const stopped = await fixture.runtime.applyGoal({ sessionId: id, action });
      assert.equal(stopped.ok, true, stopped.error);
      assert.equal(stopped.running, running, "an interrupt request is not proof of turn termination");
      assert.equal(stopped.interrupting, running);
      assert.equal(state.running, running);
      assert.equal(state.controller.signal.aborted, running);
      assert.equal(state.queuedPrompts.length, 0);
      assert.equal(session.model, modelBefore.model);
      assert.deepEqual(session.modelSelection, modelBefore.selection);
      assert.equal(session.config, modelBefore.config);
      assert.deepEqual(session.transcriptMessages, transcriptBefore);
      assert.deepEqual(withoutGoalPermission((await fixture.store.readMetadataExact(id)).metadata), withoutGoalPermission(original));
      assert.deepEqual(listHookAudit(), hooksBefore);
      assert.equal(fixture.calls(), 0);
      // No real execution was started for this state fixture.
      state.running = false;
      fixture.runtime.active.delete(id);
    }
  });
}

test("Goal stop failures are not reported as persisted success, and selectors remain exact", async (t) => {
  const fixture = await makeFixture(t);
  const original = metadata("exact-goal-id", identities[2].fields);
  const metadataPath = await fixture.store.writeMetadata(original);
  // No trust acknowledgement is required to stop an archived Goal.
  for (const sessionId of ["latest", "exact-goal", "absent-id"]) {
    const rejected = await fixture.runtime.applyGoal({ sessionId, action: "disable" });
    assert.equal(rejected.ok, false);
    assert.ok([400, 404].includes(rejected.status));
  }
  const rename = fs.rename;
  t.mock.method(fs, "rename", async (...args) => {
    if (args[1] === metadataPath) throw Object.assign(new Error("fixture disk failure"), { code: "EIO" });
    return rename(...args);
  });
  const failed = await fixture.runtime.applyGoal({ sessionId: original.id, action: "disable" });
  assert.equal(failed.ok, false);
  assert.equal(failed.status, 500);
  assert.equal(failed.code, "GOAL_PERSIST_FAILED");
  assert.deepEqual((await fixture.store.readMetadataExact(original.id)).metadata, original);
  assert.equal(fixture.runtime.active.size, 0);
  assert.equal(fixture.calls(), 0);
});

test("read-only history views preserve terminal results and never write paused into metadata", async (t) => {
  const fixture = await makeFixture(t);
  for (const status of ["completed", "failed"]) {
    const original = metadata(`terminal-${status}`, { status, goal: { ...metadata("unused").goal, status: "complete" } });
    await fixture.store.writeMetadata(original);
    const opened = await fixture.runtime.readSession(original.id);
    assert.equal(opened.session.status, status);
    assert.equal(opened.session.goal.status, "complete");
    assert.equal((await fixture.runtime.listSessionRecords()).find((item) => item.id === original.id).status, status);
    assert.deepEqual((await fixture.store.readMetadataExact(original.id)).metadata, original);
  }
  assert.equal(fixture.runtime.active.size, 0);
  assert.equal(fixture.calls(), 0);
});

test("real running turn remains interrupting until its execution settles after Goal disable", async (t) => {
  let started;
  const startGate = new Promise((resolve) => { started = resolve; });
  let finish;
  const finishGate = new Promise((resolve) => { finish = resolve; });
  let signal;
  const fixture = await makeFixture(t, async (_session, options) => {
    signal = options.signal;
    started();
    await finishGate;
    throw Object.assign(new Error("interrupted"), { name: "AbortError" });
  });
  t.after(() => finish());
  await fixture.runtime.trustWorkspace();
  const turn = await fixture.runtime.startTurn({ prompt: "hold", permissionMode: "workspace" });
  assert.equal(turn.ok, true);
  await startGate;
  const state = fixture.runtime.active.peek(turn.sessionId);
  state.session.goal = normalizeSessionGoal(metadata("fixture").goal, { hydrateRunningAsPaused: false });
  await fixture.store.writeMetadata(metadata(turn.sessionId, {
    model: state.session.model, metadataVersion: 2, modelSelection: state.session.modelSelection
  }));
  state.persisted = true;
  const original = (await fixture.store.readMetadataExact(turn.sessionId)).metadata;
  const stopped = await fixture.runtime.applyGoal({ sessionId: turn.sessionId, action: "disable" });
  assert.equal(stopped.ok, true, stopped.error);
  assert.equal(stopped.running, true);
  assert.equal(stopped.interrupting, true);
  assert.equal(signal.aborted, true);
  assert.deepEqual(withoutGoalPermission((await fixture.store.readMetadataExact(turn.sessionId)).metadata), withoutGoalPermission(original));
  finish();
  await waitUntil(() => !state.running);
  assert.equal(fixture.calls(), 1);
  assert.equal(state.session.goal.enabled, false);
});

test("F1: a turn snapshot captured while stop holds the file lock cannot restore old Goal controls", async (t) => {
  const fixture = await makeFixture(t);
  for (const snapshotKind of ["turn-end", "dashboard"]) {
    const { session, state, metadataPath } = await activeFixture(fixture, `interleaved-${snapshotKind}`);
    const readEntered = deferred();
    const releaseRead = deferred();
    const readFile = fs.readFile;
    let held = false;
    const mock = t.mock.method(fs, "readFile", async (...args) => {
      const raw = await readFile(...args);
      if (!held && String(args[0]) === metadataPath) {
        held = true;
        readEntered.resolve();
        await releaseRead.promise;
      }
      return raw;
    });
    t.after(() => releaseRead.resolve());
    const stopping = fixture.runtime.applyGoal({ sessionId: session.id, action: "disable" });
    await readEntered.promise;
    assert.equal(session.goal.enabled, true, "stop is suspended before changing live controls");
    const pending = snapshotKind === "turn-end"
      ? persistSessionMetadata(fixture.store, { id: session.id }, "old output", "completed", session, { env: fixture.env })
      : persistSessionSnapshot(session, { env: fixture.env });
    releaseRead.resolve();
    const stopped = await stopping;
    assert.equal(stopped.ok, true, stopped.error);
    await pending;
    mock.mock.restore();
    const saved = (await fixture.store.readMetadataExact(session.id)).metadata;
    assert.equal(saved.goal.enabled, false);
    assert.equal(saved.goal.status, "off");
    assert.equal(saved.permissionMode, "workspace");
    assert.equal(saved.fullAccess, false);
    assert.equal(state.session.permissionMode, "workspace");
  }
});

test("F2: pending user prompts survive Goal stop and cannot inherit fullAccess after interrupt settles", async (t) => {
  for (const action of actions) {
    for (const requestedMode of ["workspace", "fullAccess", "legacy-unknown", "independent-fullAccess"]) {
      const releaseTurn = deferred();
      const started = deferred();
      const observed = [];
      const fixture = await makeFixture(t, async (session, options) => {
        observed.push({ prompt: options.prompt, mode: session.permissionMode, fullAccess: session.fullAccess });
        if (options.prompt === "hold") {
          started.resolve();
          await releaseTurn.promise;
          return { output: "interrupted", interrupted: true };
        }
        return { output: "user prompt retained" };
      });
      t.after(() => releaseTurn.resolve());
      await fixture.runtime.trustWorkspace();
      const turn = await fixture.runtime.startTurn({ prompt: "hold", permissionMode: "workspace" });
      await started.promise;
      const state = fixture.runtime.active.peek(turn.sessionId);
      if (requestedMode === "independent-fullAccess") {
        // A request queued before Goal enable has independent authorization.
        await fixture.runtime.startTurn({ sessionId: turn.sessionId, prompt: "keep me", permissionMode: "fullAccess" });
      }
      const enabled = await fixture.runtime.applyGoal({ sessionId: turn.sessionId, action: "enable", objective: "hold goal" });
      assert.equal(enabled.ok, true, enabled.error);
      if (requestedMode === "legacy-unknown") {
        state.queuedPrompts.push(createQueueItem("keep me", "fullAccess", "prompt"));
      } else if (requestedMode !== "independent-fullAccess") {
        const queued = await fixture.runtime.startTurn({ sessionId: turn.sessionId, prompt: "keep me", permissionMode: requestedMode });
        assert.equal(queued.queued, true);
      }
      const queuedId = state.queuedPrompts[0].id;
      const stopped = await fixture.runtime.applyGoal({ sessionId: turn.sessionId, action });
      assert.equal(stopped.ok, true, stopped.error);
      releaseTurn.resolve();
      await waitUntil(() => !state.running);
      const independentlyAuthorized = requestedMode === "independent-fullAccess";
      const needsConfirmation = ["fullAccess", "legacy-unknown"].includes(requestedMode);
      if (needsConfirmation) {
        assert.equal(observed.length, 1, "ambiguous Goal-era fullAccess must wait for user confirmation");
        assert.equal(state.queuedPrompts.length, 1);
        assert.equal(state.queuedPrompts[0].id, queuedId);
        assert.equal(state.queuedPrompts[0].prompt, "keep me");
        assert.equal(state.queuedPrompts[0].requiresPermissionConfirmation, true);
        assert.equal(state.session.fullAccess, false);
      } else {
        assert.deepEqual(observed[1], { prompt: "keep me", mode: independentlyAuthorized ? "fullAccess" : "workspace", fullAccess: independentlyAuthorized });
        assert.equal(state.queuedPrompts.length, 0);
      }
      assert.equal(fixture.runtime.listActiveEvents(turn.sessionId).some((event) => event.type === "goal_continued"), false);
    }
  }
});

for (const failure of ["unresolved-model", "config-load-failed"]) {
  test(`F2: paused queue head retains its full prompt before ${failure} preparation`, async (t) => {
    const releaseTurn = deferred();
    const started = deferred();
    const fixture = await makeFixture(t, async () => {
      started.resolve();
      await releaseTurn.promise;
      return { output: "interrupted", interrupted: true };
    });
    t.after(() => releaseTurn.resolve());
    await fixture.runtime.trustWorkspace();
    const turn = await fixture.runtime.startTurn({ prompt: "hold", permissionMode: "workspace" });
    assert.equal(turn.ok, true);
    await started.promise;
    const state = fixture.runtime.active.peek(turn.sessionId);
    const enabled = await fixture.runtime.applyGoal({ sessionId: turn.sessionId, action: "enable", objective: "hold goal" });
    assert.equal(enabled.ok, true, enabled.error);
    const prompt = `retain the complete user message\n${"Goal-era unknown fullAccess message.\n".repeat(2000)}END OF USER MESSAGE`;
    const head = createQueueItem(prompt, "fullAccess", "prompt");
    assert.equal(head.permissionSource, undefined);
    state.queuedPrompts.push(head);
    const later = await fixture.runtime.startTurn({ sessionId: turn.sessionId, prompt: "must not skip the paused head", permissionMode: "workspace" });
    assert.equal(later.queued, true);
    const stopped = await fixture.runtime.applyGoal({ sessionId: turn.sessionId, action: "disable" });
    assert.equal(stopped.ok, true, stopped.error);
    assert.equal(head.requiresPermissionConfirmation, true);
    assert.equal(head.prompt, prompt);
    const queueIds = state.queuedPrompts.map((item) => item.id);
    assert.equal(queueIds.length, 2);

    if (failure === "unresolved-model") {
      state.session.model = "removed-model";
      state.session.modelSelection = { provider: "removed", model: "removed-model" };
      const resolution = resolveSessionModelSelection(await loadConfig({ cwd: fixture.cwd, env: fixture.env }), state.session);
      assert.equal(resolution.status, "unresolved");
      assert.equal(resolution.reason, "missing-provider");
    } else {
      await fs.writeFile(path.join(fixture.env.USERPROFILE, ".ant-code", "settings.json"), "{ invalid settings JSON");
      await assert.rejects(loadConfig({ cwd: fixture.cwd, env: fixture.env }));
    }

    releaseTurn.resolve();
    await waitUntil(() => !state.running && state.currentTurnId === "");
    assert.equal(fixture.calls(), 1, "neither the paused head nor later work may execute");
    assert.deepEqual(state.queuedPrompts.map((item) => item.id), queueIds);
    assert.equal(state.queuedPrompts[0], head);
    assert.equal(head.prompt, prompt, "the real queue must retain the full prompt, not its UI preview");
    assert.equal(head.requiresPermissionConfirmation, true);
    const events = fixture.runtime.listActiveEvents(turn.sessionId);
    const idle = events.filter((event) => event.type === "run_state" && event.running === false).at(-1);
    assert.ok(idle, "turn completion must publish idle state with the retained queue");
    assert.deepEqual(idle.queue.map((item) => item.id), queueIds);
    assert.equal(idle.queue[0].requiresPermissionConfirmation, true);
    assert.ok(idle.queue[0].preview.length > 0 && idle.queue[0].preview.length < prompt.length);
    assert.equal(events.some((event) => event.type === "queue_item_cancelled"), false);
    assert.equal(events.some((event) => event.code === "SESSION_CONFIG_RELOAD_FAILED"), false);
    assert.equal(events.some((event) => event.type === "goal_continued"), false);

    const cancelled = fixture.runtime.cancelQueuedTurn({ sessionId: turn.sessionId, queueItemId: head.id });
    assert.equal(cancelled.ok, true, cancelled.error);
    assert.equal(cancelled.item.id, head.id);
    assert.equal(cancelled.item.requiresPermissionConfirmation, true);
    assert.deepEqual(cancelled.queue.map((item) => item.id), [queueIds[1]]);
    assert.equal(fixture.calls(), 1);
    assert.equal(state.running, false);
    assert.equal(fixture.runtime.cancelQueuedTurn({ sessionId: turn.sessionId, queueItemId: queueIds[1] }).ok, true);
  });
}

test("F3: valid-model enable and resume write failures roll back controls without starting work", async (t) => {
  const fixture = await makeFixture(t);
  await fixture.runtime.trustWorkspace();
  for (const action of ["enable", "resume"]) {
    const { state, session, metadataPath } = await activeFixture(fixture, `write-failed-${action}`);
    session.goal = normalizeSessionGoal({ ...session.goal, enabled: action === "resume", status: action === "resume" ? "paused" : "off" }, { hydrateRunningAsPaused: false });
    applyPermissionMode(session, "workspace");
    await persistSessionSnapshot(session, { env: fixture.env });
    const original = (await fixture.store.readMetadataExact(session.id)).metadata;
    const goalBefore = structuredClone(session.goal);
    const permissionBefore = permissionFields(session);
    const eventCursor = state.eventSequence;
    const rename = fs.rename;
    const mock = t.mock.method(fs, "rename", async (...args) => {
      if (args[1] === metadataPath) throw Object.assign(new Error("fixture disk failure"), { code: "EIO" });
      return rename(...args);
    });
    const result = await fixture.runtime.applyGoal({ sessionId: session.id, action, objective: "must not start", permissionMode: "fullAccess" });
    mock.mock.restore();
    assert.equal(result.status, 500);
    assert.equal(result.code, "GOAL_PERSIST_FAILED");
    assert.equal(fixture.calls(), 0);
    assert.equal(state.running, false);
    assert.equal(state.queuedPrompts.length, 0);
    assert.deepEqual(session.goal, goalBefore);
    assert.deepEqual(permissionFields(session), permissionBefore);
    assert.equal(state.eventSequence, eventCursor);
    assert.deepEqual((await fixture.store.readMetadataExact(session.id)).metadata, original);
  }
});

function permissionFields(session) {
  return Object.fromEntries(["permissionMode", "fullAccess", "readonly", "allowWrite", "allowCommand"].map((key) => [key, session[key]]));
}

async function activeFixture(fixture, id) {
  const session = await createSession({ cwd: fixture.cwd, env: fixture.env, mode: "interactive" });
  session.id = id;
  session.goal = normalizeSessionGoal(metadata(id).goal, { hydrateRunningAsPaused: false });
  applyPermissionMode(session, "fullAccess");
  const metadataPath = await fixture.store.writeMetadata(metadata(id, {
    model: session.model, metadataVersion: 2, modelSelection: session.modelSelection
  }));
  const state = createTurnState(session, fixture.runTurn, { persisted: true });
  fixture.runtime.active.set(id, state);
  return { session, state, metadataPath };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function metadata(id, extra = {}) {
  return {
    id, cwd: "project", title: id, status: "running", startedAt: "2026-08-28T00:00:00.000Z",
    turnIndex: 3, usage: { totalTokens: 42, promptTokens: 30, completionTokens: 12 },
    transcript: { messages: [{ role: "user", content: [{ type: "text", text: "original transcript" }] }], contextMessages: [] },
    permissionMode: "fullAccess", fullAccess: true, readonly: false, allowWrite: true, allowCommand: true,
    goal: { enabled: true, status: "running", text: "keep existing goal", previousPermissionMode: "workspace", continueCount: 2 },
    ...extra
  };
}

function withoutGoalPermission(value) {
  const result = structuredClone(value);
  for (const key of ["goal", "permissionMode", "fullAccess", "readonly", "allowWrite", "allowCommand"]) delete result[key];
  return result;
}

async function makeFixture(t, implementation = async () => ({ output: "must not run" })) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-goal-stop-"));
  const cwd = path.join(root, "project");
  const home = path.join(root, "home");
  const env = { USERPROFILE: home, HOME: home };
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(path.join(home, ".ant-code"), { recursive: true });
  const provider = (name) => ({
    displayName: name, transport: { protocol: "openai-chat", baseURL: `https://${name}.example/v1/chat/completions` },
    auth: { mode: "none" }, models: [{ id: "shared-model" }, { id: `${name}-model` }]
  });
  await fs.writeFile(path.join(home, ".ant-code", "settings.json"), JSON.stringify({
    settingsVersion: 2,
    namespaces: {
      "model-providers": { providers: { alpha: provider("alpha"), beta: provider("beta") } },
      "default-model": { selection: { provider: "alpha", model: "alpha-model" } }
    }
  }));
  let calls = 0;
  const runTurn = async (...args) => { calls += 1; return implementation(...args); };
  const runtime = createDashboardRuntime({ cwd, env, runTurn });
  t.after(async () => {
    await runtime.shutdown({ cancelActive: true, force: true, timeoutMs: 50 });
    await fs.rm(root, { recursive: true, force: true });
  });
  return { runtime, cwd, env, runTurn, store: createSessionStore({ cwd, env }), calls: () => calls };
}

async function waitUntil(predicate) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("timed out waiting for turn to settle");
}
