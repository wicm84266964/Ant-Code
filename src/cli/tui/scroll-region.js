/**
 * Scroll offsets in the TUI are measured from the bottom of the region:
 * 0 means pinned to the latest content, larger values mean the user is
 * reading older rows above the bottom.
 */
export function createScrollableRegion(options = {}) {
  const totalRows = Math.max(0, Number(options.totalRows) || 0);
  const visibleRows = Math.max(1, Number(options.visibleRows) || 1);
  const maxOffset = Math.max(0, totalRows - visibleRows);
  const offset = clampOffset(options.offset, maxOffset);

  return {
    totalRows,
    visibleRows,
    offset,
    maxOffset,
    isPinnedToBottom: offset === 0,
    newContentWhileScrolledUp: offset > 0,
    visibleRange: visibleRange({ totalRows, visibleRows, offset }),
    scrollBy(rows) {
      return clampOffset(offset + Number(rows || 0), maxOffset);
    },
    scrollToBottom() {
      return 0;
    },
    scrollToTop() {
      return maxOffset;
    }
  };
}

export function clampOffset(value, maxOffset) {
  const max = Math.max(0, Number(maxOffset) || 0);
  return Math.min(max, Math.max(0, Number(value) || 0));
}

export function visibleRange(options = {}) {
  const totalRows = Math.max(0, Number(options.totalRows) || 0);
  const visibleRows = Math.max(1, Number(options.visibleRows) || 1);
  const offset = clampOffset(options.offset, Math.max(0, totalRows - visibleRows));
  const end = Math.max(0, totalRows - offset);
  const start = Math.max(0, end - visibleRows);
  return {
    firstRow: totalRows === 0 ? 0 : start + 1,
    lastRow: end
  };
}
