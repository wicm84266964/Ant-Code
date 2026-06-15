import assert from "node:assert/strict";
import test from "node:test";
import { buildTaskLifecycle } from "../../src/core/task-lifecycle.js";
import { createWorkflowState } from "../../src/tools/workflow-tools.js";

test("task lifecycle starts in inspect stage for empty workflow", () => {
  const lifecycle = buildTaskLifecycle({ workflow: createWorkflowState() });

  assert.equal(lifecycle.stage, "inspect");
  assert.equal(lifecycle.state, "idle");
});

test("task lifecycle requires validation after changes", () => {
  const workflow = createWorkflowState();
  workflow.changes.push({
    path: "notes.txt",
    edited: true,
    recordedAt: "2026-04-28T00:02:00.000Z"
  });

  const lifecycle = buildTaskLifecycle({ workflow });

  assert.equal(lifecycle.stage, "validate");
  assert.equal(lifecycle.state, "needs_validation");
});

test("task lifecycle treats validation before latest change as stale", () => {
  const workflow = createWorkflowState();
  workflow.validations.push({
    command: "npm test",
    passed: true,
    exitCode: 0,
    recordedAt: "2026-04-28T00:01:00.000Z"
  });
  workflow.changes.push({
    path: "notes.txt",
    edited: true,
    recordedAt: "2026-04-28T00:02:00.000Z"
  });

  const lifecycle = buildTaskLifecycle({ workflow });

  assert.equal(lifecycle.stage, "validate");
  assert.equal(lifecycle.state, "needs_validation");
  assert.equal(lifecycle.validationFresh, false);
});

test("task lifecycle reaches ready when validation covers latest change", () => {
  const workflow = createWorkflowState();
  workflow.changes.push({
    path: "notes.txt",
    edited: true,
    recordedAt: "2026-04-28T00:01:00.000Z"
  });
  workflow.validations.push({
    command: "npm test",
    passed: true,
    exitCode: 0,
    recordedAt: "2026-04-28T00:02:00.000Z"
  });

  const lifecycle = buildTaskLifecycle({ workflow });

  assert.equal(lifecycle.stage, "ready");
  assert.equal(lifecycle.state, "verified");
  assert.equal(lifecycle.validationFresh, true);
});

test("task lifecycle enters repair after unresolved validation failure", () => {
  const workflow = createWorkflowState();
  workflow.validations.push({
    command: "npm test",
    passed: false,
    exitCode: 1,
    recordedAt: "2026-04-28T00:02:00.000Z"
  });

  const lifecycle = buildTaskLifecycle({ workflow });

  assert.equal(lifecycle.stage, "repair");
  assert.equal(lifecycle.state, "blocked");
});
