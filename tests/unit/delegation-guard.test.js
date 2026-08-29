import assert from "node:assert/strict";
import test from "node:test";
import {
  appendDelegationReminderToExecution,
  classifyToolUse,
  createDelegationGuard,
  normalizeDelegationGuardConfig
} from "../../src/agents/delegation-guard.js";

test("delegation guard reminds after broad web research without delegation", () => {
  const guard = createDelegationGuard({
    config: { agents: { delegationGuard: { softThreshold: 3, strongThreshold: 5 } } },
    prompt: "请联网调研一个 GitHub 项目的架构和依赖"
  });

  assert.equal(guard.observeToolResult("web_search", { query: "project architecture" }, { ok: true }), null);
  const reminder = guard.observeToolResult("web_fetch", { url: "https://github.com/example/project" }, { ok: true });

  assert.equal(reminder.level, "soft");
  assert.match(reminder.text, /agent_run/);
  assert.deepEqual(reminder.suggestedProfiles, ["web-researcher"]);
});

test("delegation guard does not remind for a single precise file read", () => {
  const guard = createDelegationGuard({
    config: { agents: { delegationGuard: { softThreshold: 3, strongThreshold: 5 } } },
    prompt: "请读取 src/cli/index.js 说明入口做了什么"
  });

  const reminder = guard.observeToolResult("read_file", { path: "src/cli/index.js" }, {
    ok: true,
    result: { bytesRead: 400, content: "entry" }
  });

  assert.equal(reminder, null);
});

test("delegation guard detects broad repository exploration", () => {
  const guard = createDelegationGuard({
    config: { agents: { delegationGuard: { softThreshold: 3, strongThreshold: 5 } } },
    prompt: "全面排查当前项目权限链路"
  });

  const first = guard.observeToolResult("glob", { pattern: "**/*.js", path: "." }, { ok: true });
  assert.equal(first, null);
  const second = guard.observeToolResult("grep", { pattern: "fullAccess", path: "." }, { ok: true });

  assert.equal(second.level, "soft");
  assert.match(second.text, /explorer/);
  assert.match(second.text, /planner/);
});

test("delegation guard stops reminding after agent_run", () => {
  const guard = createDelegationGuard({
    config: { agents: { delegationGuard: { softThreshold: 2, strongThreshold: 4 } } },
    prompt: "全面审计代码"
  });

  guard.observeToolResult("agent_run", { profile: "explorer" }, { ok: true });
  const reminder = guard.observeToolResult("grep", { pattern: "auth", path: "." }, { ok: true });

  assert.equal(reminder, null);
});

test("delegation guard can be disabled by config", () => {
  const guard = createDelegationGuard({
    config: { agents: { delegationGuard: { enabled: false } } },
    prompt: "全面审计代码"
  });

  assert.equal(guard.observeToolResult("web_search", { query: "x" }, { ok: true }), null);
  assert.equal(normalizeDelegationGuardConfig({ agents: { delegationGuard: { mode: "off" } } }).enabled, false);
});

test("classifies shell wide scans and appends reminder to execution result", () => {
  const classified = classifyToolUse("powershell", {
    command: "Get-ChildItem -Recurse src | Select-String fullAccess"
  }, { ok: true }, { complexPrompt: true });

  assert.equal(classified.broad, true);
  assert.equal(classified.category, "repository");

  const execution = appendDelegationReminderToExecution({ ok: true, result: { matches: [] } }, {
    level: "soft",
    reason: "shell command looks like broad search/fetch",
    broadActions: 3,
    suggestedProfiles: ["explorer", "planner"],
    text: "[Ant Code delegation guard]\n请调用 agent_run。"
  });

  assert.equal(execution.result.delegationGuard.level, "soft");
  assert.match(execution.result.systemReminder, /agent_run/);
});
