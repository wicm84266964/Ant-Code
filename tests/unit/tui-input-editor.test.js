import assert from "node:assert/strict";
import test from "node:test";
import {
  composerSegments,
  cursorColumn,
  cursorVisualPosition,
  deleteBackward,
  deleteForward,
  deleteToEnd,
  deleteToStart,
  deleteWordBackward,
  displayWidth,
  insertText,
  moveCursor,
  moveCursorVertical,
  visibleDraftLineEntries
} from "../../src/cli/tui/input-editor.js";

test("input editor inserts and deletes at the active cursor", () => {
  let draft = { text: "ac", cursor: 1 };
  draft = insertText(draft, "b");
  assert.deepEqual(draft, { text: "abc", cursor: 2 });

  draft = moveCursor(draft, "left");
  draft = deleteForward(draft);
  assert.deepEqual(draft, { text: "ac", cursor: 1 });

  draft = deleteBackward(draft);
  assert.deepEqual(draft, { text: "c", cursor: 0 });
});

test("input editor supports readline-like deletion", () => {
  assert.deepEqual(deleteToStart({ text: "hello world", cursor: 6 }), { text: "world", cursor: 0 });
  assert.deepEqual(deleteToEnd({ text: "hello world", cursor: 5 }), { text: "hello", cursor: 5 });
  assert.deepEqual(deleteWordBackward({ text: "hello brave world", cursor: 12 }), { text: "hello world", cursor: 6 });
});

test("input editor tracks wide character display columns", () => {
  assert.equal(displayWidth("abc"), 3);
  assert.equal(displayWidth("天蓝"), 4);
  assert.equal(cursorColumn("a天b", 2), 3);
});

test("composer segments mark the cursor without losing surrounding text", () => {
  const [line] = composerSegments("a天b", 2, { showCursor: true });

  assert.equal(line.text, "a天b");
  assert.deepEqual(line.segments.map((segment) => segment.text), ["a天", "b"]);
  assert.equal(line.segments[1].cursor, true);
});

test("composer segments soft-wrap long single-line drafts", () => {
  const lines = composerSegments("abcdefghijklmnopqrstuvwxyz", 26, {
    showCursor: true,
    columns: 8,
    maxLines: 5
  });

  assert.deepEqual(lines.map((line) => line.text), ["abcdefgh", "ijklmnop", "qrstuvwx", "yz "]);
  assert.equal(lines.at(-1).segments.some((segment) => segment.cursor), true);
});

test("visible draft line entries wrap wide characters by display columns", () => {
  const lines = visibleDraftLineEntries("一二三四五六", 6, 5, 4);

  assert.deepEqual(lines.map((line) => line.text), ["一二", "三四", "五六"]);
});

test("vertical cursor movement follows explicit multiline drafts", () => {
  const text = "abcde\nxy\n123456";
  const down = moveCursorVertical({ text, cursor: 3 }, "down");
  const downAgain = moveCursorVertical(down, "down");
  const up = moveCursorVertical(downAgain, "up");

  assert.deepEqual(down, { text, cursor: 8 });
  assert.deepEqual(downAgain, { text, cursor: 11 });
  assert.deepEqual(up, down);
});

test("vertical cursor movement follows soft-wrapped visual lines", () => {
  const text = "abcdefghijklmnopqrstuvwxyz";
  const down = moveCursorVertical({ text, cursor: 3 }, "down", { columns: 8 });
  const downAgain = moveCursorVertical(down, "down", { columns: 8 });
  const up = moveCursorVertical(downAgain, "up", { columns: 8 });

  assert.deepEqual(down, { text, cursor: 11 });
  assert.deepEqual(downAgain, { text, cursor: 19 });
  assert.deepEqual(up, down);
});

test("vertical cursor movement respects wide character columns", () => {
  const text = "一二三四五六";
  const down = moveCursorVertical({ text, cursor: 2 }, "down", { columns: 4 });
  const up = moveCursorVertical(down, "up", { columns: 4 });

  assert.deepEqual(down, { text, cursor: 4 });
  assert.deepEqual(up, { text, cursor: 2 });
});

test("cursor visual position follows the visible soft-wrapped row", () => {
  assert.deepEqual(cursorVisualPosition("abcdefghijklmnopqrstuvwxyz", 19, { columns: 8, maxLines: 5 }), {
    lineIndex: 2,
    column: 3,
    totalLines: 4,
    visibleStart: 0
  });
});
