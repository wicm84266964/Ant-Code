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
    }, 15_000);
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

test("dashboard runtime tombstones lost background subagents when no live controller exists", async () => {
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
    assert.equal(cancelled.ok, true);
    assert.deepEqual(cancelled.updatedTaskIds, ["task-lost-bg"]);
    const readTask = await taskStore.readTask("task-lost-bg");
    assert.equal(readTask.ok, true);
    assert.equal(readTask.task.status, "interrupted");
    assert.ok(readTask.task.cancelRequestedAt);
    assert.match(readTask.task.latestProgress, /未找到当前进程 controller/);
    const readGroup = await groupStore.readGroup("group-lost-bg");
    assert.equal(readGroup.ok, true);
    assert.equal(readGroup.group.status, "partial");
    assert.ok(readGroup.group.completedAt);
  } finally {
    await close(server);
  }
});

test("dashboard recycle of a lost multi-profile group tombstones every child even when the chip also sends taskId", async () => {
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
      id: "task-lost-explorer",
      parentSessionId: started.sessionId,
      groupId: "group-lost-pair",
      childSessionId: "agent-explorer-lost",
      profile: "explorer",
      title: "Lost explorer",
      prompt: "hang",
      status: "running",
      startedAt: old,
      heartbeatAt: old,
      progressAt: old,
      latestProgress: "glob 完成"
    });
    await taskStore.createTask({
      id: "task-lost-researcher",
      parentSessionId: started.sessionId,
      groupId: "group-lost-pair",
      childSessionId: "agent-web-researcher-lost",
      profile: "web-researcher",
      title: "Lost researcher",
      prompt: "hang",
      status: "running",
      startedAt: old,
      heartbeatAt: old,
      progressAt: old,
      latestProgress: "运行工具 web_fetch"
    });
    await groupStore.createGroup({
      id: "group-lost-pair",
      parentSessionId: started.sessionId,
      status: "running",
      waitFor: "all",
      wakeParent: true,
      taskIds: ["task-lost-explorer", "task-lost-researcher"],
      latestProgress: "后台子任务仍在运行"
    });

    const cancelled = await runtime.cancelBackgroundSubagent({
      sessionId: started.sessionId,
      groupId: "group-lost-pair",
      taskId: "task-lost-explorer"
    });
    assert.equal(cancelled.ok, true);
    assert.deepEqual(new Set(cancelled.updatedTaskIds), new Set(["task-lost-explorer", "task-lost-researcher"]));
    const explorer = await taskStore.readTask("task-lost-explorer");
    const researcher = await taskStore.readTask("task-lost-researcher");
    assert.equal(explorer.task.status, "interrupted");
    assert.equal(researcher.task.status, "interrupted");
    const group = await groupStore.readGroup("group-lost-pair");
    assert.equal(group.group.status, "partial");
    assert.ok(group.group.completedAt);
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
  assert.ok(
    timedOut.code === "SHUTDOWN_TIMEOUT" || timedOut.code === "SHUTDOWN_BACKGROUND_TIMEOUT",
    `expected bounded shutdown timeout, received ${timedOut.code}`
  );
  if (timedOut.code === "SHUTDOWN_TIMEOUT") {
    assert.equal(timedOut.activity.quarantinedTurns, 1);
  }
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
