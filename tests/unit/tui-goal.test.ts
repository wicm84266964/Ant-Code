import assert from "node:assert/strict";
import test from "node:test";
import {
  executeTuiGoalCommand,
  finishTuiGoalTurn,
  formatTuiGoalFooter,
  parseTuiGoalCommand
} from "../../src/cli/tui/goal.ts";
import { isImmediateTuiCommand } from "../../src/cli/tui/workflows.ts";
import {
  applyGoalTurnOutcome,
  enableGoalState,
  planGoalHostContinue
} from "../../src/core/goal.ts";

test("parseTuiGoalCommand treats free text as enable and reserves control verbs", () => {
  assert.deepEqual(parseTuiGoalCommand([]), { action: "status", objective: "" });
  assert.deepEqual(parseTuiGoalCommand(["pause"]), { action: "pause", objective: "" });
  assert.deepEqual(parseTuiGoalCommand(["exit"]), { action: "exit", objective: "" });
  assert.deepEqual(parseTuiGoalCommand(["clear"]), { action: "exit", objective: "" });
  assert.deepEqual(parseTuiGoalCommand(["ship", "filters"]), { action: "enable", objective: "ship filters" });
  assert.deepEqual(parseTuiGoalCommand(["enable", "ship", "filters"]), { action: "enable", objective: "ship filters" });
});

test("TUI /goal is a busy-safe immediate command", () => {
  assert.equal(isImmediateTuiCommand("/goal pause"), true);
  assert.equal(isImmediateTuiCommand("/goal ship filters"), true);
});

test("applyGoalTurnOutcome completes with recap and stops continue", () => {
  const goal = enableGoalState({
    text: "ship filters",
    startedAt: "2026-08-29T10:00:00.000Z"
  });
  goal.status = "running";
  const outcome = applyGoalTurnOutcome(goal, {
    terminalStatus: "completed",
    finalOutput: "done\nGOAL_STATUS: complete\nEVIDENCE: tests/unit/tui-goal.test.ts\nGAPS:\n"
  });
  assert.equal(outcome.action, "complete");
  assert.equal(outcome.recap, true);
  assert.equal(goal.status, "complete");
  assert.equal(goal.roundCount, 1);
  const plan = planGoalHostContinue({ session: { goal, config: {} } });
  assert.equal(plan.continue, false);
});

test("planGoalHostContinue builds a host continue prompt", () => {
  const goal = enableGoalState({ text: "ship filters" });
  goal.status = "active";
  const plan = planGoalHostContinue({ session: { goal, config: { agents: { goal: { maxAutoContinues: 12 } } } } });
  assert.equal(plan.continue, true);
  assert.match(plan.prompt, /\[Ant Code goal continuation\]/);
  assert.match(plan.displayPrompt, /Goal 续跑 · 第 1 轮/);
  assert.equal(goal.continueCount, 1);
});

test("formatTuiGoalFooter shows compact recap on complete", () => {
  const goal = enableGoalState({
    text: "ship filters",
    startedAt: "2026-08-29T10:00:00.000Z",
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, reports: 0 }
  });
  goal.status = "complete";
  goal.endedAt = "2026-08-29T11:12:00.000Z";
  goal.continueCount = 8;
  goal.roundCount = 23;
  const line = formatTuiGoalFooter({
    goal,
    usage: { promptTokens: 412000, completionTokens: 86000, totalTokens: 498000, reports: 3 }
  });
  assert.match(String(line), /Goal · 已完成/);
  assert.match(String(line), /1h12m/);
  assert.match(String(line), /8 次续跑/);
  assert.match(String(line), /23 轮/);
  assert.match(String(line), /输入 412k \/ 输出 86k/);
});

test("finishTuiGoalTurn does not throw when session metadata is not on disk yet", async () => {
  const session = {
    id: "4d55e431-6d86-477a-b2bd-a899990c12cb",
    cwd: process.cwd(),
    config: {},
    usage: {},
    workflow: {},
    permissionMode: "fullAccess",
    goal: enableGoalState({ text: "ship filters" })
  };
  session.goal.status = "running";
  const result = await finishTuiGoalTurn({
    session,
    terminalStatus: "completed",
    output: "still working"
  });
  assert.equal(session.goal.enabled, true);
  assert.equal(result.continue === true || session.goal.status === "active" || session.goal.status === "running", true);
});

test("executeTuiGoalCommand enable requires objective and locks fullAccess", async () => {
  const session = {
    permissionMode: "workspace",
    config: {},
    usage: {},
    goal: { enabled: false }
  };
  const status = await executeTuiGoalCommand({ session, args: [] });
  assert.equal(status.ok, true);
  assert.match(status.message, /Goal 未开启/);
  const missing = await executeTuiGoalCommand({ session, args: ["enable"] });
  assert.equal(missing.ok, false);
  const enabled = await executeTuiGoalCommand({ session, args: ["add", "filters"] });
  assert.equal(enabled.ok, true);
  assert.equal(session.goal.enabled, true);
  assert.equal(session.permissionMode, "fullAccess");
  assert.equal(enabled.startTurn, "add filters");
  assert.equal(session.goal.previousPermissionMode, "workspace");
});
