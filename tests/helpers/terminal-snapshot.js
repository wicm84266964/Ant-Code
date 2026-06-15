import assert from "node:assert/strict";

/**
 * Normalize volatile terminal output before snapshot-style assertions.
 *
 * @param {string} value
 */
export function normalizeTerminalSnapshot(value) {
  return String(value)
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "<ansi>")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<time>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/session-[A-Za-z0-9_-]+/g, "session-<id>")
    .replace(/turn-[A-Za-z0-9_-]+/g, "turn-<id>")
    .replace(/\b\d+(?:\.\d+)?\s?(?:ms|s)\b/g, "<duration>")
    .replace(/\b\d+\s?tokens?\b/gi, "<tokens>")
    .replace(/[\\|/-]\s(?=round|thinking|working|waiting)/g, "- ")
    .replace(/\r\n/g, "\n")
    .trimEnd();
}

/**
 * @param {string} snapshot
 * @param {{ columns: number; rows: number }} size
 */
export function assertTerminalBounds(snapshot, size) {
  const lines = String(snapshot).split(/\n/);
  assert.ok(lines.length <= size.rows, `terminal rows exceeded: ${lines.length} > ${size.rows}`);
  for (const [index, line] of lines.entries()) {
    assert.ok(visibleLength(line) <= size.columns, `line ${index + 1} exceeded ${size.columns} columns: ${visibleLength(line)}`);
  }
}

/**
 * @param {string} value
 */
function visibleLength(value) {
  return String(value).replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").length;
}
