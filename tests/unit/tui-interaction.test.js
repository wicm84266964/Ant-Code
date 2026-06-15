import assert from "node:assert/strict";
import test from "node:test";
import {
  getPopoverStack,
  hasMouseSequence,
  mouseClickEvents,
  mouseWheelDirection,
  mouseWheelDirections,
  mouseWheelEvents,
  pageScrollDirections,
  rawScrollEvents,
  rawBackspacePresses,
  rawCtrlCPresses,
  rawDeletePresses,
  rawCtrlOPresses,
  rawShiftTabPresses,
  resolveCtrlCExit,
  resolveEscInterrupt,
  shouldUseScrollbackMode,
  topPopover
} from "../../src/cli/tui/interaction.js";

test("popover stack reports the highest active interaction first for cancellation", () => {
  const state = {
    slashPalette: { commands: [] },
    fileMention: { fragment: "src" },
    modelPickerOpen: true,
    commandPanel: { kind: "help" },
    mode: "approval",
    pendingApproval: { toolName: "edit_file" }
  };

  assert.deepEqual(getPopoverStack(state).map((item) => item.kind), ["slash", "file", "model", "command", "approval"]);
  assert.equal(topPopover(state).kind, "approval");
});

test("Ctrl+C requires a second press inside the confirmation window", () => {
  const first = resolveCtrlCExit({ now: 1000, windowMs: 2000 });
  const second = resolveCtrlCExit({ now: 2500, confirmationUntil: first.nextConfirmationUntil, windowMs: 2000 });
  const expired = resolveCtrlCExit({ now: 4001, confirmationUntil: first.nextConfirmationUntil, windowMs: 2000 });

  assert.equal(first.confirmed, false);
  assert.equal(first.message, "再次按 Ctrl+C 退出");
  assert.equal(second.confirmed, true);
  assert.equal(expired.confirmed, false);
});

test("Esc requires a second press inside the interrupt confirmation window", () => {
  const first = resolveEscInterrupt({ now: 1000, windowMs: 2000 });
  const second = resolveEscInterrupt({ now: 2500, confirmationUntil: first.nextConfirmationUntil, windowMs: 2000 });
  const expired = resolveEscInterrupt({ now: 4001, confirmationUntil: first.nextConfirmationUntil, windowMs: 2000 });

  assert.equal(first.confirmed, false);
  assert.equal(first.message, "再次按 Esc 中断当前轮次");
  assert.equal(second.confirmed, true);
  assert.equal(expired.confirmed, false);
});

test("mouse wheel SGR events resolve to transcript scroll directions", () => {
  assert.equal(mouseWheelDirection("[<64;40;12M"), 1);
  assert.equal(mouseWheelDirection("\u001b[<65;40;12M"), -1);
  assert.equal(mouseWheelDirection("\u001b[<80;40;12M"), 1);
  assert.equal(mouseWheelDirection("\u001b[<81;40;12M"), -1);
  assert.equal(mouseWheelDirection("\u001b[<96;40;12M"), 1);
  assert.equal(mouseWheelDirection("\u001b[<97;40;12M"), -1);
  assert.equal(mouseWheelDirection("\u001b[<66;40;12M"), 0);
  assert.equal(mouseWheelDirection("[<0;40;12M"), 0);
});

test("mouse wheel parser handles raw stdin chunks and legacy X10 encoding", () => {
  assert.deepEqual(mouseWheelDirections("a\u001b[<64;40;12M\u001b[<65;40;12Mb"), [1, -1]);
  assert.deepEqual(mouseWheelDirections("\u001b[M`!!\u001b[Ma!!"), [1, -1]);
  assert.deepEqual(mouseWheelDirections("\u001b[64;40;12M\u001b[65;40;12M"), [1, -1]);
  assert.deepEqual(mouseWheelEvents("\u001b[<64;40;12M")[0], {
    direction: 1,
    x: 40,
    y: 12,
    encoding: "sgr"
  });
});

test("raw scroll parser keeps incomplete mouse chunks for the next stdin data event", () => {
  const first = rawScrollEvents("\u001b[<64;40");
  assert.deepEqual(first.wheelDirections, []);
  assert.equal(first.remainder, "\u001b[<64;40");

  const second = rawScrollEvents(`${first.remainder};12M`);
  assert.deepEqual(second.wheelDirections, [1]);
  assert.equal(second.remainder, "");
});

test("mouse sequence detector catches non-wheel mouse reports", () => {
  assert.equal(hasMouseSequence("\u001b[<35;40;12M"), true);
  assert.equal(hasMouseSequence("\u001b[0;40;12M"), true);
  assert.equal(hasMouseSequence("plain text"), false);
});

test("mouse click parser returns primary button press coordinates", () => {
  assert.deepEqual(mouseClickEvents("\u001b[<0;40;12M"), [{
    kind: "press",
    button: 0,
    x: 40,
    y: 12,
    encoding: "sgr"
  }]);
  assert.deepEqual(mouseClickEvents("\u001b[<0;40;12m"), [{
    kind: "release",
    button: 0,
    x: 40,
    y: 12,
    encoding: "sgr"
  }]);
  assert.deepEqual(mouseClickEvents("\u001b[<64;40;12M"), []);
});

test("raw terminal fallback recognizes page scroll and Ctrl+C sequences", () => {
  assert.deepEqual(pageScrollDirections("\u001b[5~\u001b[6~"), [1, -1]);
  assert.deepEqual(pageScrollDirections("[5;1:1~\u001b[6;5~"), [1, -1]);
  assert.equal(rawCtrlCPresses("\x03"), 1);
  assert.equal(rawCtrlCPresses("a\x03b\x03"), 2);
  assert.equal(rawCtrlOPresses("\x0f"), 1);
  assert.equal(rawCtrlOPresses("a\x0fb\x0f"), 2);
  assert.equal(rawShiftTabPresses("\u001b[Z"), 1);
  assert.equal(rawShiftTabPresses("a\u001b[Zb\u001b[1;2Z"), 2);
  assert.equal(rawShiftTabPresses("\u001b[1;2\t"), 1);
  assert.equal(rawShiftTabPresses("\u001b[9;2u\u001b[9;2~\u001b[\t"), 3);
  assert.equal(rawBackspacePresses("\x7f"), 1);
  assert.equal(rawBackspacePresses("a\x08b\x7f"), 2);
  assert.equal(rawBackspacePresses("\u001b[127;1u"), 1);
  assert.equal(rawBackspacePresses("\u001b[8;1u"), 1);
  assert.equal(rawDeletePresses("\u001b[3~"), 1);
  assert.equal(rawDeletePresses("\u001b[3;1:1~"), 1);
  assert.equal(rawDeletePresses("a\u001b[3;5~b\u001b[3~"), 2);
});

test("native scrollback mode is disabled when the TUI owns scroll layout", () => {
  assert.equal(shouldUseScrollbackMode(18), false);
  assert.equal(shouldUseScrollbackMode(32), false);
  assert.equal(shouldUseScrollbackMode(33), false);
  assert.equal(shouldUseScrollbackMode(48), false);
  assert.equal(shouldUseScrollbackMode(48, { nativeScrollback: true }), true);
  assert.equal(shouldUseScrollbackMode(48, { nativeScrollback: true, pinnedSidePanel: true }), false);
  assert.equal(shouldUseScrollbackMode(24, { nativeScrollback: true, streamActive: true }), false);
  assert.equal(shouldUseScrollbackMode(0), false);
});
