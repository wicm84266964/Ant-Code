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
    return goal?.status === "paused" && (goal?.lastBlockReason === "budget" || goal?.continueCount >= 2);
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
