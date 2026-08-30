import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGoalRecap,
  enableGoalState,
  evaluateGoalCompletion,
  formatGoalElapsed,
  formatGoalRecapLine,
  formatGoalTokens,
  GOAL_MAX_AUTO_CONTINUES,
  parseGoalStatusMarkers,
  publicGoalSnapshot,
  resolveGoalMaxAutoContinues,
  resolveGoalPreviousPermissionMode,
  serializeSessionGoal,
  shouldShowGoalRecap,
  shouldSkipGoalContinue,
  stripGoalStatusMarkers
} from "../../src/core/goal.ts";
import { mapSessionEventToDashboard } from "../../src/dashboard/events.ts";

test("evaluateGoalCompletion does not complete on verbal done with pending work", () => {
  const result = evaluateGoalCompletion({
    goal: { enabled: true, text: "ship filters", hasWrites: true },
    finalOutput: "已完成\nGOAL_STATUS: complete\nEVIDENCE: looks good\nGAPS:\n",
    liveWorkflow: {
      todos: [{ id: "1", content: "write tests", status: "pending" }]
    }
  });
  assert.equal(result.complete, false);
  assert.equal(result.reason, "pending_work");
});

test("evaluateGoalCompletion rejects empty evidence without writes", () => {
  const result = evaluateGoalCompletion({
    goal: { enabled: true, text: "ship filters", hasWrites: false },
    finalOutput: "完成了\nGOAL_STATUS: complete\nEVIDENCE:\nGAPS:\n",
    liveWorkflow: { todos: [] }
  });
  assert.equal(result.complete, false);
  assert.equal(result.reason, "empty_evidence");
});

test("stripGoalStatusMarkers removes machine lines from visible text", () => {
  const stripped = stripGoalStatusMarkers([
    "筛选已经加上。",
    "GOAL_STATUS: complete",
    "EVIDENCE: tests/unit/dashboard-ui.test.js",
    "GAPS:",
    "- none"
  ].join("\n"));
  assert.match(stripped, /筛选已经加上/);
  assert.doesNotMatch(stripped, /GOAL_STATUS:/);
  assert.doesNotMatch(stripped, /EVIDENCE:/);
  assert.doesNotMatch(stripped, /GAPS:/);
});

test("parseGoalStatusMarkers reads completion claim from model context", () => {
  const parsed = parseGoalStatusMarkers("hello\nGOAL_STATUS: complete\nEVIDENCE: file a\nGAPS:\n- leftover");
  assert.equal(parsed.claimedComplete, true);
  assert.equal(parsed.evidence, "file a");
});

test("resolveGoalMaxAutoContinues reads config and rejects out-of-range values", () => {
  assert.equal(resolveGoalMaxAutoContinues(), GOAL_MAX_AUTO_CONTINUES);
  assert.equal(resolveGoalMaxAutoContinues({ agents: { goal: { maxAutoContinues: 24 } } }), 24);
  assert.equal(resolveGoalMaxAutoContinues({ agents: { goal: { maxAutoContinues: 0 } } }), GOAL_MAX_AUTO_CONTINUES);
  assert.equal(resolveGoalMaxAutoContinues({ agents: { goal: { maxAutoContinues: 101 } } }), GOAL_MAX_AUTO_CONTINUES);
  assert.equal(resolveGoalMaxAutoContinues({ agents: { goal: { maxAutoContinues: 24 } } }, 3), 24);
});

test("shouldSkipGoalContinue uses the live config cap before the stored session cap", () => {
  const goal = {
    enabled: true,
    status: "active",
    text: "ship filters",
    continueCount: 2,
    maxAutoContinues: 12
  };
  assert.equal(shouldSkipGoalContinue({
    session: { config: { agents: { goal: { maxAutoContinues: 2 } } }, goal }
  }), true);
  assert.equal(shouldSkipGoalContinue({
    session: { config: { agents: { goal: { maxAutoContinues: 4 } } }, goal }
  }), false);
});

test("resolveGoalPreviousPermissionMode prefers live session mode over stale client plan", () => {
  assert.equal(resolveGoalPreviousPermissionMode({
    alreadyEnabled: false,
    sessionPermissionMode: "workspace",
    clientPreviousPermissionMode: "plan",
    preferClientForNewSession: false
  }), "workspace");
  assert.equal(resolveGoalPreviousPermissionMode({
    alreadyEnabled: false,
    sessionPermissionMode: "fullAccess",
    clientPreviousPermissionMode: "workspace",
    preferClientForNewSession: true
  }), "workspace");
  assert.equal(resolveGoalPreviousPermissionMode({
    alreadyEnabled: false,
    sessionPermissionMode: "fullAccess",
    preferClientForNewSession: true
  }), "plan");
});

test("Goal recap line is compact and omits unknown token usage", () => {
  assert.equal(formatGoalElapsed(32_000), "32s");
  assert.equal(formatGoalElapsed((12 * 60 + 32) * 1000), "12m32s");
  assert.equal(formatGoalElapsed((60 * 60 + 12 * 60) * 1000), "1h12m");
  assert.equal(formatGoalElapsed(2 * 60 * 60 * 1000), "2h");
  assert.equal(formatGoalTokens(999), "999");
  assert.equal(formatGoalTokens(1_500), "1.5k");
  assert.equal(formatGoalTokens(412_000), "412k");
  assert.equal(formatGoalTokens(86_000), "86k");
  assert.equal(formatGoalTokens(1_200_000), "1.2M");
  assert.equal(
    formatGoalRecapLine({
      elapsedMs: (60 * 60 + 12 * 60) * 1000,
      continueCount: 8,
      roundCount: 23,
      promptTokens: 412_000,
      completionTokens: 86_000
    }),
    "1h12m · 8 次续跑 · 23 轮 · 输入 412k / 输出 86k"
  );
  assert.equal(
    formatGoalRecapLine({ continueCount: 0, roundCount: 0, elapsedMs: null, promptTokens: null, completionTokens: null }),
    "0 次续跑"
  );
});

test("Goal recap uses enable usage baseline and only appears on terminal states", () => {
  const startedAt = new Date("2026-08-29T10:00:00.000Z").toISOString();
  const endedAt = new Date("2026-08-29T11:12:00.000Z").toISOString();
  const goal = enableGoalState({
    text: "ship filters",
    startedAt,
    usage: { promptTokens: 1000, completionTokens: 200, totalTokens: 1200, reports: 1 }
  });
  goal.status = "complete";
  goal.endedAt = endedAt;
  goal.continueCount = 8;
  goal.roundCount = 23;
  const recap = buildGoalRecap(goal, {
    promptTokens: 413_000,
    completionTokens: 86_200,
    totalTokens: 499_200,
    reports: 4
  });
  assert.equal(recap.elapsedMs, (60 * 60 + 12 * 60) * 1000);
  assert.equal(recap.promptTokens, 412_000);
  assert.equal(recap.completionTokens, 86_000);
  assert.equal(recap.line, "1h12m · 8 次续跑 · 23 轮 · 输入 412k / 输出 86k");
  assert.equal(shouldShowGoalRecap({ status: "running" }), false);
  assert.equal(shouldShowGoalRecap({ status: "paused", lastBlockReason: "user_pause" }), false);
  assert.equal(shouldShowGoalRecap({ status: "paused", lastBlockReason: "budget" }), true);
  assert.equal(shouldShowGoalRecap({ status: "complete" }), true);
  assert.equal(publicGoalSnapshot({ ...goal, status: "running" }, {}, { reports: 4 }).recap, null);
  assert.equal(publicGoalSnapshot(goal, {}, { promptTokens: 413_000, completionTokens: 86_200, reports: 4 }).recap.line, recap.line);
  const persisted = serializeSessionGoal(goal);
  assert.equal(persisted.startedAt, startedAt);
  assert.equal(persisted.endedAt, endedAt);
  assert.deepEqual(persisted.usageBaseline, {
    promptTokens: 1000,
    completionTokens: 200,
    totalTokens: 1200,
    reports: 1
  });
});

test("dashboard assistant_final mapping keeps raw text for host; strip is applied by runtime", () => {
  const mapped = mapSessionEventToDashboard({
    type: "assistant_final",
    text: "done\nGOAL_STATUS: complete"
  });
  assert.equal(mapped[0].type, "assistant_final");
  assert.match(mapped[0].text, /GOAL_STATUS:/);
});
