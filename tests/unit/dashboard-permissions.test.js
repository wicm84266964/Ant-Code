import assert from "node:assert/strict";
import test from "node:test";
import { applyPermissionMode, approvalKeyFor, permissionModeSummary } from "../../src/dashboard/permissions.js";

test("dashboard permission modes map to session flags", () => {
  const session = {};

  applyPermissionMode(session, "workspace");
  assert.equal(session.permissionMode, "workspace");
  assert.equal(session.allowWrite, true);
  assert.equal(session.allowCommand, true);
  assert.equal(session.fullAccess, false);

  applyPermissionMode(session, "fullAccess");
  assert.equal(session.fullAccess, true);
  assert.equal(session.allowWrite, true);
  assert.equal(session.allowCommand, true);

  applyPermissionMode(session, "plan");
  assert.equal(session.permissionMode, "plan");
  assert.equal(session.allowWrite, false);
  assert.equal(session.allowCommand, false);
});

test("dashboard approval key scopes same-session approvals", () => {
  const writeKey = approvalKeyFor({
    toolName: "write_file",
    input: { path: "report.md" },
    decision: { outsideWorkspace: false },
    definition: { risk: "write" }
  });
  const editKey = approvalKeyFor({
    toolName: "edit_file",
    input: { path: "report.md" },
    decision: { outsideWorkspace: false },
    definition: { risk: "write" }
  });
  const otherPathKey = approvalKeyFor({
    toolName: "edit_file",
    input: { path: "other.md" },
    decision: { outsideWorkspace: false },
    definition: { risk: "write" }
  });

  assert.equal(writeKey, "write:normal:workspace:report.md");
  assert.equal(editKey, writeKey);
  assert.notEqual(otherPathKey, writeKey);
});

test("dashboard approval keys group safe command families only", () => {
  const firstNodeTest = approvalKeyFor({
    toolName: "powershell",
    input: { command: "node --test tests/unit/a.test.js" },
    decision: {},
    definition: { risk: "execute" }
  });
  const secondNodeTest = approvalKeyFor({
    toolName: "powershell",
    input: { command: "node --test tests/unit/b.test.js" },
    decision: {},
    definition: { risk: "execute" }
  });
  const firstScript = approvalKeyFor({
    toolName: "powershell",
    input: { command: "npm run check -- --filter dashboard" },
    decision: {},
    definition: { risk: "execute" }
  });
  const secondScript = approvalKeyFor({
    toolName: "powershell",
    input: { command: "npm run check -- --filter tui" },
    decision: {},
    definition: { risk: "execute" }
  });
  const highRiskA = approvalKeyFor({
    toolName: "powershell",
    input: { command: "Remove-Item -Recurse -Force .\\build" },
    decision: {},
    definition: { risk: "execute" }
  });
  const highRiskB = approvalKeyFor({
    toolName: "powershell",
    input: { command: "Remove-Item -Recurse -Force .\\dist" },
    decision: {},
    definition: { risk: "execute" }
  });
  const outsideA = approvalKeyFor({
    toolName: "powershell",
    input: { command: "node --test C:\\tmp\\a.test.js" },
    decision: { outsideWorkspace: true },
    definition: { risk: "execute" }
  });
  const outsideB = approvalKeyFor({
    toolName: "powershell",
    input: { command: "node --test C:\\tmp\\b.test.js" },
    decision: { outsideWorkspace: true },
    definition: { risk: "execute" }
  });

  assert.equal(firstNodeTest, secondNodeTest);
  assert.equal(firstScript, secondScript);
  assert.notEqual(highRiskA, highRiskB);
  assert.notEqual(outsideA, outsideB);
});

test("dashboard permission summary uses user-facing labels", () => {
  const summary = permissionModeSummary({ permissionMode: "fullAccess" });

  assert.equal(summary.mode, "fullAccess");
  assert.equal(summary.label, "完全访问");
});
