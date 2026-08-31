import assert from "node:assert/strict";
import test from "node:test";
import {
  formatVisibleTranscriptSelection,
  isMeaningfulTranscriptDrag,
  transcriptLineIndexForMouseY
} from "../../src/cli/tui/transcript-selection.ts";

test("transcript mouse y maps onto chat lines after the box chrome, not the border", () => {
  assert.equal(transcriptLineIndexForMouseY(3, 1, 10), 0);
  assert.equal(transcriptLineIndexForMouseY(4, 1, 10), 1);
  assert.equal(transcriptLineIndexForMouseY(2, 1, 10), null);
  assert.equal(transcriptLineIndexForMouseY(4, 1, 10, { historyWarning: true }), 0);
});

test("drag copy joins visible chat lines and skips wrap artifacts", () => {
  const text = formatVisibleTranscriptSelection([
    { text: "hello " },
    { text: "world", wrapContinue: true },
    { text: "next" }
  ], 0, 2);
  assert.equal(text, "hello world\nnext");
});

test("drag copy never includes sidebar or box-drawing characters that are not chat text", () => {
  const text = formatVisibleTranscriptSelection([
    { text: "only chat" },
    { text: "more chat" }
  ], 0, 1);
  assert.equal(text, "only chat\nmore chat");
  assert.doesNotMatch(text, /│|╭|╮|侧栏/);
});

test("tiny mouse jitter is a click; moving to another line is a drag", () => {
  assert.equal(isMeaningfulTranscriptDrag({ x: 10, y: 5 }, { x: 11, y: 5 }, 3, 3), false);
  assert.equal(isMeaningfulTranscriptDrag({ x: 10, y: 5 }, { x: 16, y: 5 }, 3, 3), true);
  assert.equal(isMeaningfulTranscriptDrag({ x: 10, y: 5 }, { x: 10, y: 6 }, 3, 4), true);
});
