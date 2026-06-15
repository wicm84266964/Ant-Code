import assert from "node:assert/strict";
import test from "node:test";
import { resolveScrollTarget, resolveTuiFrame } from "../../src/cli/tui/layout.js";
import { createScrollableRegion } from "../../src/cli/tui/scroll-region.js";

test("scrollable region keeps bottom-pinned offset semantics", () => {
  const region = createScrollableRegion({ totalRows: 100, visibleRows: 20, offset: 0 });

  assert.equal(region.isPinnedToBottom, true);
  assert.equal(region.maxOffset, 80);
  assert.equal(region.scrollBy(5), 5);
  assert.equal(region.scrollToTop(), 80);
  assert.equal(region.scrollToBottom(), 0);
  assert.deepEqual(region.visibleRange, { firstRow: 81, lastRow: 100 });
});

test("scrollable region clamps offsets and reports reading history", () => {
  const region = createScrollableRegion({ totalRows: 30, visibleRows: 10, offset: 200 });

  assert.equal(region.offset, 20);
  assert.equal(region.isPinnedToBottom, false);
  assert.equal(region.newContentWhileScrolledUp, true);
  assert.equal(region.scrollBy(-50), 0);
});

test("TUI frame routes mouse wheel coordinates to docked panel, side, or transcript", () => {
  const frame = resolveTuiFrame({
    width: 140,
    height: 36,
    wide: true,
    rows: { bodyRows: 16, panelRows: 14, promptRows: 4, footerRows: 1 }
  });

  assert.equal(frame.regions.overlay.top, frame.regions.body.bottom + 1);
  assert.equal(frame.regions.overlay.left, 1);
  assert.equal(frame.regions.overlay.width, 140);
  assert.equal(resolveScrollTarget({ x: 70, y: 20 }, frame, { activeOverlay: true }), "overlay");
  assert.equal(resolveScrollTarget({ x: 130, y: 5 }, frame, { activeOverlay: false }), "side");
  assert.equal(resolveScrollTarget({ x: 10, y: 5 }, frame, { activeOverlay: false }), "transcript");
});
