import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectorCategoryForCommand,
  inspectorPanelLines,
  inspectorTextLine,
  makeInspector,
  moveInspectorIndex,
  movePatchFileIndex,
  nextInspectorFilter,
  parsePatch,
  patchSummaryLines,
  resolveInspectorIndex
} from "../../src/cli/tui/inspector.js";

const SAMPLE_PATCH = [
  "diff --git a/src/a.js b/src/a.js",
  "index 1111111..2222222 100644",
  "--- a/src/a.js",
  "+++ b/src/a.js",
  "@@ -1,2 +1,3 @@",
  " const value = 1;",
  "-old line",
  "+new line",
  "+added line",
  "diff --git a/docs/readme.md b/docs/readme.md",
  "index 3333333..4444444 100644",
  "--- a/docs/readme.md",
  "+++ b/docs/readme.md",
  "@@ -10 +10 @@",
  "-Title",
  "+Updated title"
].join("\n");

test("inspector navigation respects the active category filter", () => {
  const items = [
    makeInspector("Welcome", "system", "", "context"),
    makeInspector("Diff", "/diff", "", "diff"),
    makeInspector("Tool", "read_file", "", "tool"),
    makeInspector("Review", "/review patch", "", "diff")
  ];

  assert.equal(moveInspectorIndex(items, 0, "diff", 1), 1);
  assert.equal(moveInspectorIndex(items, 1, "diff", 1), 3);
  assert.equal(moveInspectorIndex(items, 3, "diff", -1), 1);
  assert.equal(resolveInspectorIndex(items, 2, "diff"), 3);
  assert.equal(resolveInspectorIndex(items, 2, "tool"), 2);
});

test("inspector filter cycling and command categorization are stable", () => {
  assert.equal(nextInspectorFilter("all"), "command");
  assert.equal(nextInspectorFilter("gateway"), "context");
  assert.equal(nextInspectorFilter("context"), "all");
  assert.equal(inspectorCategoryForCommand("diff", "anything"), "diff");
  assert.equal(inspectorCategoryForCommand("review", "diff --git a/a b/a\n@@ -1 +1 @@"), "diff");
  assert.equal(inspectorCategoryForCommand("review", "Ant Code review summary"), "command");
  assert.equal(inspectorCategoryForCommand("status", "Ant Code status"), "context");
});

test("inspector diff highlighting classifies patch lines", () => {
  assert.equal(inspectorTextLine("diff --git a/a b/a", { diff: true }).color, "magenta");
  assert.equal(inspectorTextLine("@@ -1 +1 @@", { diff: true }).color, "cyan");
  assert.equal(inspectorTextLine("+new line", { diff: true }).color, "green");
  assert.equal(inspectorTextLine("-old line", { diff: true }).color, "red");
  assert.equal(inspectorTextLine(" plain").color, undefined);
  assert.equal(inspectorTextLine("- fetch (stdio, not_connected)").color, undefined);
});

test("patch parser groups unified diff output by file", () => {
  const patch = parsePatch(SAMPLE_PATCH);

  assert.equal(patch.files.length, 2);
  assert.equal(patch.totalAdditions, 3);
  assert.equal(patch.totalDeletions, 2);
  assert.equal(patch.totalHunks, 2);
  assert.equal(patch.files[0].displayPath, "src/a.js");
  assert.equal(patch.files[0].additions, 2);
  assert.equal(patch.files[0].deletions, 1);
  assert.equal(patch.files[0].hunks[0].oldStart, 1);
  assert.equal(patch.files[1].displayPath, "docs/readme.md");
  assert.equal(parsePatch("Ant Code review summary"), null);
});

test("patch panel focuses one diff file and supports file navigation", () => {
  const item = makeInspector("Command Output", "/diff", SAMPLE_PATCH, "diff");
  const panel = inspectorPanelLines(item, [item], 0, 0, "all", 18, 1);

  assert.ok(panel.some((entry) => entry.text.includes("patch：2 个文件，2 个 hunk，+3 -2")));
  assert.ok(panel.some((entry) => entry.text.includes("文件：2/2 docs/readme.md")));
  assert.ok(panel.some((entry) => entry.text.includes("改动：+1 -1")));
  assert.equal(movePatchFileIndex(item, 0, 1), 1);
  assert.equal(movePatchFileIndex(item, 1, 1), 0);
  assert.equal(movePatchFileIndex(item, 0, -1), 1);
});

test("patch summary exposes compact per-file counters", () => {
  const summary = patchSummaryLines(parsePatch(SAMPLE_PATCH), 1);

  assert.equal(summary[0].text, "文件：2，hunks：2，+3 -2");
  assert.equal(summary[1].text, "1. src/a.js +2 -1 h=1");
  assert.equal(summary[2].text, "... 还有 1 个文件");
});
