import assert from "node:assert/strict";
import test from "node:test";
import { mapSessionEventToDashboard } from "../../src/dashboard/events.js";

test("dashboard maps thinking to folded activity without text", () => {
  const events = mapSessionEventToDashboard({
    type: "assistant_thinking_delta",
    text: "secret reasoning"
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "activity");
  assert.equal(events[0].title, "正在分析任务");
  assert.equal(events[0].coalesceKey, "thinking");
  assert.doesNotMatch(JSON.stringify(events[0]), /secret reasoning/);
});

test("dashboard maps visible assistant deltas to draft events", () => {
  const events = mapSessionEventToDashboard({
    type: "assistant_delta",
    round: 2,
    text: "visible draft",
    bytes: 13
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "assistant_draft");
  assert.equal(events[0].round, 2);
  assert.equal(events[0].text, "visible draft");
  assert.equal(events[0].bytes, 13);
});

test("dashboard maps normalized assistant text deltas to draft events", () => {
  const events = mapSessionEventToDashboard({
    type: "assistant_text_delta",
    payload: {
      round: 3,
      text: "normalized draft",
      bytes: 16
    }
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "assistant_draft");
  assert.equal(events[0].round, 3);
  assert.equal(events[0].text, "normalized draft");
});

test("dashboard maps streaming status to coalesced live activity", () => {
  const events = mapSessionEventToDashboard({
    type: "gateway_stream_start",
    round: 1
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "activity");
  assert.equal(events[0].status, "running");
  assert.equal(events[0].coalesceKey, "assistant-stream");
});

test("dashboard maps context compaction to live status and transcript boundary", () => {
  const running = mapSessionEventToDashboard({
    type: "context_compacting",
    beforeMessages: 40,
    beforeTokens: 320000,
    maxTokens: 256000
  });

  assert.equal(running.length, 1);
  assert.equal(running[0].type, "activity");
  assert.equal(running[0].title, "正在压缩上下文");
  assert.equal(running[0].status, "running");
  assert.equal(running[0].coalesceKey, "context-compaction");

  const completed = mapSessionEventToDashboard({
    type: "context_compacted",
    reason: "automatic_prompt_budget",
    beforeMessages: 40,
    afterMessages: 8,
    beforeTokens: 320000,
    afterTokens: 18000,
    summaryBytes: 4096
  });

  assert.equal(completed.length, 2);
  assert.equal(completed[0].type, "activity");
  assert.equal(completed[0].status, "completed");
  assert.equal(completed[0].coalesceKey, "context-compaction");
  assert.equal(completed[1].type, "context_boundary");
  assert.equal(completed[1].title, "聊天内容已压缩");
  assert.equal(completed[1].detail, "以下回复基于压缩后的上下文继续");
  assert.equal(completed[1].reason, "automatic_prompt_budget");
});

test("dashboard marks agent_run activity for live subtask display", () => {
  const events = mapSessionEventToDashboard({
    type: "tool_start",
    name: "agent_run",
    toolCallId: "agent-1",
    profile: "explorer"
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].toolName, "agent_run");
  assert.equal(events[0].profile, "explorer");
  assert.equal(events[0].coalesceKey, "tool:agent-1");
});

test("dashboard maps background subagent group start to live activity", () => {
  const events = mapSessionEventToDashboard({
    type: "subagent_group_started",
    groupId: "group-1",
    taskId: "task-1",
    profile: "explorer",
    waitFor: "all",
    wakeParent: true
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "activity");
  assert.equal(events[0].source, "subagent");
  assert.equal(events[0].backgroundSubagent, true);
  assert.equal(events[0].status, "running");
  assert.equal(events[0].groupId, "group-1");
  assert.equal(events[0].taskId, "task-1");
  assert.equal(events[0].profile, "explorer");
  assert.equal(events[0].coalesceKey, "subagent-group:group-1");
  assert.match(events[0].detail, /自动唤醒主控/);
});

test("dashboard maps background subagent progress without wake prompt text", () => {
  const events = mapSessionEventToDashboard({
    type: "subagent_group_progress",
    groupId: "group-1",
    taskId: "task-1",
    profile: "explorer",
    status: "completed",
    waitFor: "all",
    wakeParent: true,
    completed: true,
    summary: "1 个子任务，完成 1，问题 0，运行中 0"
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].backgroundSubagent, true);
  assert.equal(events[0].status, "completed");
  assert.equal(events[0].completed, true);
  assert.equal(events[0].summary, "1 个子任务，完成 1，问题 0，运行中 0");
  assert.equal(events[0].waitFor, "all");
  assert.equal(events[0].wakeParent, true);
});

test("dashboard maps background subagent wakeup to waiting activity", () => {
  const events = mapSessionEventToDashboard({
    type: "subagent_group_wakeup",
    groupId: "group-1",
    taskId: "task-1",
    profile: "explorer",
    status: "completed",
    waitFor: "all",
    wakeParent: true,
    wakePrompt: "Ant Code subagent group completed\nsecret details",
    summary: "1 个子任务，完成 1，问题 0，运行中 0"
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].backgroundSubagent, true);
  assert.equal(events[0].status, "waiting");
  assert.equal(events[0].wakePromptQueued, true);
  assert.ok(events[0].wakePromptBytes > 0);
  assert.doesNotMatch(JSON.stringify(events[0]), /secret details/);
});

test("dashboard maps tool finish to concise result", () => {
  const events = mapSessionEventToDashboard({
    type: "tool_finish",
    name: "write_file",
    toolCallId: "tool-1",
    ok: true,
    resultBytes: 120
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].title, "写入文件已完成");
  assert.equal(events[0].status, "completed");
  assert.equal(events[0].collapsed, true);
});

test("dashboard carries compact file change counters without diff text", () => {
  const events = mapSessionEventToDashboard({
    type: "tool_finish",
    name: "edit_file",
    toolCallId: "tool-2",
    ok: true,
    changeStats: {
      path: "src/app.js",
      additions: 3,
      deletions: 1,
      files: 1,
      truncated: true
    }
  });

  assert.deepEqual(events[0].changeStats, {
    path: "src/app.js",
    additions: 3,
    deletions: 1,
    files: 1,
    redacted: false,
    truncated: true,
    approximate: false
  });
  assert.doesNotMatch(JSON.stringify(events[0]), /diff --git|@@ -/);
});

test("dashboard carries empty per-turn change counters", () => {
  const events = mapSessionEventToDashboard({
    type: "tool_finish",
    name: "edit_file",
    toolCallId: "tool-3",
    ok: true,
    turnChangeStats: {
      additions: 0,
      deletions: 0,
      files: 0
    }
  });

  assert.deepEqual(events[0].turnChangeStats, {
    additions: 0,
    deletions: 0,
    files: 0,
    redacted: false,
    truncated: false,
    approximate: false
  });
});
