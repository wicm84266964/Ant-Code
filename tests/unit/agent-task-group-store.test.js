import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAgentTaskGroupStore, summarizeGroupStatus } from "../../src/agents/task-group-store.js";

test("task group store creates, updates, reads, and lists groups", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-group-"));
  const store = createAgentTaskGroupStore({ cwd });

  const created = await store.createGroup({
    id: "group-test",
    parentSessionId: "session-a",
    waitFor: "all",
    taskIds: ["task-a"]
  });
  assert.equal(created.id, "group-test");
  assert.equal(created.status, "running");

  const updated = await store.updateGroup("group-test", {
    taskIds: ["task-a", "task-b"],
    status: "completed",
    wakePromptQueuedAt: "now"
  });
  assert.equal(updated.ok, true);
  assert.deepEqual(updated.group.taskIds, ["task-a", "task-b"]);

  const read = await store.readGroup("group-test");
  assert.equal(read.ok, true);
  assert.equal(read.group.status, "completed");

  const listed = await store.listGroups({ parentSessionId: "session-a" });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, "group-test");
});

test("summarizeGroupStatus reports running and partial completion", () => {
  assert.deepEqual(summarizeGroupStatus([
    { status: "completed" },
    { status: "running" }
  ]), {
    status: "running",
    completed: false,
    summary: "2 个子任务，完成 1，问题 0，运行中 1"
  });

  assert.deepEqual(summarizeGroupStatus([
    { status: "completed" },
    { status: "failed" }
  ]), {
    status: "partial",
    completed: true,
    summary: "2 个子任务，完成 1，问题 1，运行中 0"
  });
});

test("summarizeGroupStatus supports waitFor any", () => {
  assert.deepEqual(summarizeGroupStatus([
    { status: "completed" },
    { status: "running" }
  ], { waitFor: "any" }), {
    status: "completed",
    completed: true,
    summary: "2 个子任务，完成 1，问题 0，运行中 1"
  });

  assert.deepEqual(summarizeGroupStatus([
    { status: "failed" },
    { status: "running" }
  ], { waitFor: "any" }), {
    status: "partial",
    completed: true,
    summary: "2 个子任务，完成 0，问题 1，运行中 1"
  });
});

test("ensureGroup preserves concurrent task ids for the same group", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-group-concurrent-"));
  const store = createAgentTaskGroupStore({ cwd });

  await Promise.all([
    store.ensureGroup({
      id: "group-concurrent",
      parentSessionId: "session-a",
      waitFor: "all",
      taskIds: ["task-a"],
      latestProgress: "task a started"
    }),
    store.ensureGroup({
      id: "group-concurrent",
      parentSessionId: "session-a",
      waitFor: "all",
      taskIds: ["task-b"],
      latestProgress: "task b started"
    })
  ]);

  const read = await store.readGroup("group-concurrent");
  assert.equal(read.ok, true);
  assert.deepEqual(read.group.taskIds.sort(), ["task-a", "task-b"]);
});

test("task group stores coalesce one history scan across active sessions", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-group-scan-cache-"));
  const root = path.join(cwd, ".lab-agent", "task-groups");
  await fs.mkdir(root, { recursive: true });
  await Promise.all(Array.from({ length: 300 }, (_, index) => fs.writeFile(
    path.join(root, `group-${index}.json`),
    JSON.stringify({
      id: `group-${index}`,
      parentSessionId: `session-${index % 10}`,
      status: "running",
      taskIds: [`task-${index}`],
      updatedAt: new Date(2026, 0, 1, 0, 0, index).toISOString()
    }),
    "utf8"
  )));
  let scans = 0;
  const stores = Array.from({ length: 10 }, () => createAgentTaskGroupStore({
    cwd,
    onListScan: () => {
      scans += 1;
    }
  }));

  const results = await Promise.all(stores.map((store, index) => store.listGroups({
    parentSessionId: `session-${index}`
  })));
  const repeated = await stores[0].listGroups({ parentSessionId: "session-0" });

  assert.equal(scans, 1);
  assert.equal(results.every((groups) => groups.length === 30), true);
  assert.equal(repeated.length, 30);
  assert.equal(scans, 1);
});
