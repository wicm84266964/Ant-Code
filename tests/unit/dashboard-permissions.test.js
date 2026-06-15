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
  const key = approvalKeyFor({
    toolName: "write_file",
    input: { path: "report.md" },
    decision: { outsideWorkspace: false },
    definition: { risk: "write" }
  });

  assert.equal(key, "write:normal:workspace:write_file:report.md");
});

test("dashboard permission summary uses user-facing labels", () => {
  const summary = permissionModeSummary({ permissionMode: "fullAccess" });

  assert.equal(summary.mode, "fullAccess");
  assert.equal(summary.label, "完全访问");
});
