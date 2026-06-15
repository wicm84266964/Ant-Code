import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "../../src/cli/args.js";

test("auto approve CLI flag enables workspace writes and commands", () => {
  const args = parseArgs(["--auto-approve", "-p", "long task"]);

  assert.equal(args.allowWrite, true);
  assert.equal(args.allowCommand, true);
  assert.equal(args.print, true);
  assert.equal(args.prompt, "long task");
});

test("auto approve workspace alias behaves like the primary flag", () => {
  const args = parseArgs(["tui", "--auto-approve-workspace"]);

  assert.equal(args.command, "tui");
  assert.equal(args.allowWrite, true);
  assert.equal(args.allowCommand, true);
});

test("full access CLI flag enables all local approvals", () => {
  const args = parseArgs(["--full-access", "-p", "autonomous task"]);

  assert.equal(args.fullAccess, true);
  assert.equal(args.readonly, false);
  assert.equal(args.allowWrite, true);
  assert.equal(args.allowCommand, true);
  assert.equal(args.print, true);
});

test("dashboard CLI args parse local web options", () => {
  const args = parseArgs(["dashboard", "--port", "7420", "--host=localhost", "--no-open", "--project", "."]);

  assert.equal(args.command, "dashboard");
  assert.equal(args.dashboard.port, 7420);
  assert.equal(args.dashboard.host, "localhost");
  assert.equal(args.dashboard.open, false);
  assert.equal(args.dashboard.project, ".");
});

test("dashboard invalid port falls back to default", () => {
  const args = parseArgs(["dashboard", "--port", "nope"]);

  assert.equal(args.dashboard.port, 7410);
});
