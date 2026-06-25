import assert from "node:assert/strict";
import test from "node:test";
import { buildValidationMemory } from "../../src/core/validation-memory.js";
import { createWorkflowState } from "../../src/tools/workflow-tools.js";

test("validation memory treats stale validations as pending reruns", () => {
  const workflow = createWorkflowState();
  workflow.validations.push({
    command: "npm test",
    passed: true,
    exitCode: 0,
    recordedAt: "2026-06-25T01:00:00.000Z"
  });
  workflow.changes.push({
    path: "src/app.js",
    edited: true,
    recordedAt: "2026-06-25T01:01:00.000Z"
  });

  const memory = buildValidationMemory({
    workflow,
    suggestions: [{ command: "npm test", reason: "package test script", tier: "related" }]
  });

  assert.equal(memory.summary.stale, 1);
  assert.equal(memory.summary.pending, 1);
  assert.equal(memory.pending[0].command, "npm test");
});

test("validation memory clears earlier failures after a later passing validation", () => {
  const workflow = createWorkflowState();
  workflow.validations.push(
    {
      command: "npm test",
      passed: false,
      exitCode: 1,
      recordedAt: "2026-06-25T01:00:00.000Z"
    },
    {
      command: "npm run check",
      passed: true,
      exitCode: 0,
      recordedAt: "2026-06-25T01:01:00.000Z"
    }
  );

  const memory = buildValidationMemory({
    workflow,
    suggestions: [
      { command: "npm test", reason: "package test script", tier: "related" },
      { command: "npm run check", reason: "full project check script", tier: "full" }
    ]
  });

  assert.equal(memory.summary.failed, 0);
  assert.deepEqual(memory.failed, []);
});
