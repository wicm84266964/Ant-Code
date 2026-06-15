import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAgentTaskStore } from "../../src/agents/task-store.js";

test("agent task store creates, updates, lists, and reads task records", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-tasks-"));
  const store = createAgentTaskStore({ cwd });

  const created = await store.createTask({
    id: "task-test",
    parentSessionId: "parent-session",
    parentTaskId: "parent-task",
    childSessionId: "child-session",
    profile: "explorer",
    purpose: "explore",
    difficulty: "quick",
    risk: "low",
    title: "Read docs",
    prompt: "inspect",
    contextPack: { task: "inspect", filesOfInterest: ["src/index.js"] },
    budget: { maxRounds: 16, maxToolCalls: 40 },
    routeDecision: { profile: "explorer", purpose: "explore" },
    status: "running"
  });
  const updated = await store.updateTask(created.id, {
    status: "partial",
    latestProgress: "done",
    toolCalls: [{ name: "read_file", inputSummary: "path=src/index.js", ok: true }],
    continuationPrompt: "continue task",
    budgetExceeded: { kind: "maxRounds" }
  });
  const listed = await store.listTasks({ parentSessionId: "parent-session" });
  const read = await store.readTask("task-test");

  assert.equal(updated.ok, true);
  assert.equal(listed.length, 1);
  assert.equal(read.ok, true);
  assert.equal(read.task.status, "partial");
  assert.equal(read.task.parentTaskId, "parent-task");
  assert.equal(read.task.title, "Read docs");
  assert.equal(read.task.purpose, "explore");
  assert.equal(read.task.contextPack.filesOfInterest[0], "src/index.js");
  assert.equal(read.task.budget.maxRounds, 16);
  assert.equal(read.task.routeDecision.profile, "explorer");
  assert.equal(read.task.continuationPrompt, "continue task");
  assert.equal(read.task.budgetExceeded.kind, "maxRounds");
  assert.equal(read.task.toolCalls[0].name, "read_file");
  assert.equal(read.task.toolCalls[0].inputSummary, "path=src/index.js");
  assert.ok(read.task.heartbeatAt);
  assert.ok(read.task.progressAt);
  assert.equal(read.task.heartbeatAt, read.task.finishedAt ?? read.task.updatedAt);
  assert.ok(await exists(path.join(cwd, ".lab-agent", "tasks", "task-test.json")));
});

test("agent task store separates heartbeat from progress timestamps", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-tasks-"));
  const store = createAgentTaskStore({ cwd });

  const created = await store.createTask({
    id: "task-heartbeat",
    profile: "explorer",
    title: "Observe",
    prompt: "watch",
    status: "running",
    startedAt: "2026-06-01T00:00:00.000Z",
    heartbeatAt: "2026-06-01T00:00:00.000Z",
    progressAt: "2026-06-01T00:00:00.000Z"
  });
  const heartbeat = await store.updateTask(created.id, {
    heartbeatAt: "2026-06-01T00:01:00.000Z"
  });
  const progress = await store.updateTask(created.id, {
    latestProgress: "running tool"
  });

  assert.equal(heartbeat.ok, true);
  assert.equal(heartbeat.task.heartbeatAt, "2026-06-01T00:01:00.000Z");
  assert.equal(heartbeat.task.progressAt, "2026-06-01T00:00:00.000Z");
  assert.equal(progress.ok, true);
  assert.notEqual(progress.task.progressAt, "2026-06-01T00:00:00.000Z");
  assert.equal(progress.task.heartbeatAt, "2026-06-01T00:01:00.000Z");
});

test("agent task store writes and reads sidecar task output", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-tasks-"));
  const store = createAgentTaskStore({ cwd });
  const longOutput = `HEAD-${"x".repeat(40_000)}-TAIL`;

  await store.createTask({
    id: "task-output",
    profile: "explorer",
    title: "Long output",
    prompt: "report",
    status: "running"
  });
  const sidecar = await store.writeTaskOutput("task-output", longOutput);
  await store.updateTask("task-output", {
    output: sidecar.preview,
    metadata: {
      outputPath: sidecar.path,
      outputBytes: sidecar.bytes,
      outputTruncated: sidecar.truncated
    }
  });
  const read = await store.readTask("task-output");
  const output = await store.readTaskOutput(read.task);

  assert.equal(read.ok, true);
  assert.equal(read.task.metadata.outputTruncated, true);
  assert.match(read.task.output, /full task output saved to sidecar/);
  assert.equal(output.ok, true);
  assert.equal(output.output, longOutput);
});

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
