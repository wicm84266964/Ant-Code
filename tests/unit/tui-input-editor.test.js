import assert from "node:assert/strict";
import test from "node:test";
import {
  composerSegments,
  createDraft,
  cursorColumn,
  cursorVisualPosition,
  deleteBackward,
  deleteForward,
  deleteToEnd,
  deleteToStart,
  deleteWordBackward,
  deleteWordForward,
  displayWidth,
  insertText,
  moveCursor,
  moveCursorLineBoundary,
  moveCursorVertical,
  stabilizeDraftViewport,
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

test("input editor deletes the next word without splitting graphemes", () => {
  const draft = deleteWordForward({ text: "go 👨‍👩‍👧‍👦 home", cursor: 3 });

  assert.deepEqual(draft, { text: "go home", cursor: 3 });
});

test("input editor tracks wide character display columns", () => {
  assert.equal(displayWidth("abc"), 3);
  assert.equal(displayWidth("天蓝"), 4);
  assert.equal(cursorColumn("a天b", 2), 3);
});

test("input editor treats emoji and combining sequences as grapheme clusters", () => {
  for (const [text, width] of [["👨‍👩‍👧‍👦", 2], ["é", 1], ["🇨🇳", 2]]) {
    const draft = createDraft(text);
    assert.equal(draft.cursor, 1);
    assert.equal(displayWidth(text), width);
    assert.deepEqual(deleteBackward(draft), { text: "", cursor: 0 });
  }
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

  assert.deepEqual(down, { text, cursor: 8, preferredColumn: 3 });
  assert.deepEqual(downAgain, { text, cursor: 12, preferredColumn: 3 });
  assert.deepEqual(up, down);
});

test("vertical cursor movement follows soft-wrapped visual lines", () => {
  const text = "abcdefghijklmnopqrstuvwxyz";
  const down = moveCursorVertical({ text, cursor: 3 }, "down", { columns: 8 });
  const downAgain = moveCursorVertical(down, "down", { columns: 8 });
  const up = moveCursorVertical(downAgain, "up", { columns: 8 });

  assert.deepEqual(down, { text, cursor: 11, preferredColumn: 3 });
  assert.deepEqual(downAgain, { text, cursor: 19, preferredColumn: 3 });
  assert.deepEqual(up, down);
});

test("vertical cursor movement respects wide character columns", () => {
  const text = "一二三四五六";
  const down = moveCursorVertical({ text, cursor: 2 }, "down", { columns: 4 });
  const up = moveCursorVertical(down, "up", { columns: 4 });

  assert.deepEqual(down, { text, cursor: 4, preferredColumn: 0 });
  assert.deepEqual(up, { text, cursor: 2, preferredColumn: 0 });
});

test("vertical movement preserves the desired column across a short line", () => {
  const text = "abcdef\nx\nabcdef";
  const shortLine = moveCursorVertical({ text, cursor: 5 }, "down");
  const restoredColumn = moveCursorVertical(shortLine, "down");

  assert.equal(shortLine.cursor, 8);
  assert.equal(shortLine.preferredColumn, 5);
  assert.equal(restoredColumn.cursor, 14);
});

test("composer viewport scrolls only when the cursor leaves the visible window", () => {
  const text = "one\ntwo\nthree\nfour\nfive";
  const bottom = stabilizeDraftViewport(createDraft(text), { columns: 20, maxLines: 3 });
  const upOne = stabilizeDraftViewport(moveCursorVertical(bottom, "up", { columns: 20 }), { columns: 20, maxLines: 3 });
  const upTwo = stabilizeDraftViewport(moveCursorVertical(upOne, "up", { columns: 20 }), { columns: 20, maxLines: 3 });
  const upThree = stabilizeDraftViewport(moveCursorVertical(upTwo, "up", { columns: 20 }), { columns: 20, maxLines: 3 });

  assert.equal(bottom.visibleStart, 2);
  assert.equal(upOne.visibleStart, 2);
  assert.equal(upTwo.visibleStart, 2);
  assert.equal(upThree.visibleStart, 1);
});

test("Home and End move within the current visual line", () => {
  const draft = { text: "abcdefghijk", cursor: 6 };
  assert.equal(moveCursorLineBoundary(draft, "start", { columns: 4 }).cursor, 4);
  assert.equal(moveCursorLineBoundary(draft, "end", { columns: 4 }).cursor, 8);
});

test("cursor visual position follows the visible soft-wrapped row", () => {
  assert.deepEqual(cursorVisualPosition("abcdefghijklmnopqrstuvwxyz", 19, { columns: 8, maxLines: 5 }), {
    lineIndex: 2,
    column: 3,
    totalLines: 4,
    visibleStart: 0
  });
});
