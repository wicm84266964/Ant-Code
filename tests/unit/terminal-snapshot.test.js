import assert from "node:assert/strict";
import test from "node:test";
import { assertTerminalBounds, normalizeTerminalSnapshot } from "../helpers/terminal-snapshot.js";

test("terminal snapshot helper normalizes volatile values", () => {
  const normalized = normalizeTerminalSnapshot([
    "\u001b[32mAnt Code\u001b[0m",
    "session-abc123 2026-04-28T00:00:00.000Z",
    "- round 1: waiting 120ms 42 tokens"
  ].join("\n"));

  assert.match(normalized, /<ansi>Ant Code<ansi>/);
  assert.match(normalized, /session-<id>/);
  assert.match(normalized, /<time>/);
  assert.match(normalized, /<duration>/);
  assert.match(normalized, /<tokens>/);
});

test("terminal snapshot helper enforces 80x24 bounds", () => {
  assertTerminalBounds("Ant Code\n> ready", { columns: 80, rows: 24 });
  assert.throws(
    () => assertTerminalBounds(`${"x".repeat(81)}`, { columns: 80, rows: 24 }),
    /exceeded 80 columns/
  );
});
