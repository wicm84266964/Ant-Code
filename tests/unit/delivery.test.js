import assert from "node:assert/strict";
import test from "node:test";
import { buildDeliveryStatus, formatDeliveryStatus, formatTurnFooter } from "../../src/core/delivery.js";
import { createWorkflowState } from "../../src/tools/workflow-tools.js";

test("delivery status reports changed but unvalidated work", () => {
  const workflow = createWorkflowState();
  workflow.changes.push({
    toolName: "write_file",
    path: "notes.txt",
    created: true,
    diffBytes: 20
  });

  const status = buildDeliveryStatus({
    workflow,
    sessionInfo: { id: "session-1", turnCount: 2 },
    validationSuggestions: [{ command: "npm test", reason: "package test script" }]
  });

  assert.equal(status.state, "needs_validation");
  assert.equal(status.lifecycle.stage, "validate");
  assert.equal(status.sessionId, "session-1");
  assert.match(status.nextActions[0], /\/verify run npm test/);
  assert.match(formatTurnFooter(status), /state=needs_validation/);
  assert.match(formatDeliveryStatus(status), /suggested validation/);
});

test("delivery status reports unresolved validation failures", () => {
  const workflow = createWorkflowState();
  workflow.validations.push({
    command: "npm test",
    exitCode: 1,
    passed: false,
    timedOut: false,
    durationMs: 120
  });

  const status = buildDeliveryStatus({ workflow });
  const text = formatDeliveryStatus(status, { includeCommands: true });

  assert.equal(status.state, "blocked");
  assert.equal(status.lifecycle.stage, "repair");
  assert.equal(status.unresolvedFailures, 1);
  assert.match(status.nextActions[0], /Repair/);
  assert.match(status.nextActions[1], /\/verify run npm test/);
  assert.match(text, /latest validation: failed exit=1/);
  assert.match(text, /command=npm test/);
});

test("delivery status treats later passing validation as verified", () => {
  const workflow = createWorkflowState();
  workflow.changes.push({
    toolName: "edit_file",
    path: "notes.txt",
    edited: true,
    diffBytes: 12
  });
  workflow.validations.push(
    { command: "npm test", exitCode: 1, passed: false, timedOut: false },
    { command: "npm test", exitCode: 0, passed: true, timedOut: false }
  );

  const status = buildDeliveryStatus({ workflow });

  assert.equal(status.state, "verified");
  assert.equal(status.lifecycle.stage, "ready");
  assert.equal(status.unresolvedFailures, 0);
  assert.match(formatTurnFooter(status), /stage=ready/);
  assert.match(formatTurnFooter(status), /validations 1\/2 passed/);
  assert.match(status.nextActions[0], /\/report/);
});

test("delivery status treats stale validation as needing validation", () => {
  const workflow = createWorkflowState();
  workflow.validations.push({
    command: "npm test",
    exitCode: 0,
    passed: true,
    timedOut: false,
    recordedAt: "2026-04-28T00:01:00.000Z"
  });
  workflow.changes.push({
    toolName: "edit_file",
    path: "notes.txt",
    edited: true,
    diffBytes: 12,
    recordedAt: "2026-04-28T00:02:00.000Z"
  });

  const status = buildDeliveryStatus({
    workflow,
    validationSuggestions: [{ command: "npm test", reason: "package test script" }]
  });

  assert.equal(status.state, "needs_validation");
  assert.equal(status.lifecycle.stage, "validate");
  assert.equal(status.lifecycle.validationFresh, false);
  assert.match(formatDeliveryStatus(status), /validationFresh=false/);
  assert.match(status.nextActions[0], /\/verify run npm test/);
});
