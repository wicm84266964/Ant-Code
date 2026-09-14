import assert from "node:assert/strict";
import test from "node:test";
import { handleApprovalInput } from "../../src/cli/tui/input-handlers.ts";

function runApprovalKey(key: Record<string, boolean>, startIndex = 0) {
  let nextIndex = startIndex;
  handleApprovalInput("", key, {
    pendingApproval: { toolName: "web_search" },
    approvalChoiceIndex: startIndex
  }, { add() {} }, () => {}, () => {}, () => {}, () => {}, (value) => {
    nextIndex = typeof value === "function" ? value(startIndex) : value;
  });
  return nextIndex;
}

test("approval Tab and Shift+Tab move choices without leaving the modal", () => {
  assert.equal(runApprovalKey({ tab: true }, 0), 1);
  assert.equal(runApprovalKey({ tab: true, shift: true }, 0), 3);
});
