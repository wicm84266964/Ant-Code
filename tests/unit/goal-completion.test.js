import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateGoalCompletion,
  GOAL_MAX_AUTO_CONTINUES,
  parseGoalStatusMarkers,
  resolveGoalMaxAutoContinues,
  resolveGoalPreviousPermissionMode,
  shouldSkipGoalContinue,
  stripGoalStatusMarkers
} from "../../src/core/goal.js";
import { mapSessionEventToDashboard } from "../../src/dashboard/events.js";

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

test("dashboard assistant_final mapping keeps raw text for host; strip is applied by runtime", () => {
  const mapped = mapSessionEventToDashboard({
    type: "assistant_final",
    text: "done\nGOAL_STATUS: complete"
  });
  assert.equal(mapped[0].type, "assistant_final");
  assert.match(mapped[0].text, /GOAL_STATUS:/);
});
