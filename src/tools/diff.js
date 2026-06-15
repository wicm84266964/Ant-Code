/**
 * Create a compact unified diff for a single text file.
 *
 * @param {{ filePath: string; before: string; after: string; maxBytes?: number }} input
 */
export function createUnifiedDiff(input) {
  const beforeLines = splitLines(input.before);
  const afterLines = splitLines(input.after);
  const beforeCount = beforeLines.length;
  const afterCount = afterLines.length;

  const lines = [
    `--- a/${input.filePath}`,
    `+++ b/${input.filePath}`,
    `@@ -1,${beforeCount} +1,${afterCount} @@`,
    ...beforeLines.map((line) => `-${line}`),
    ...afterLines.map((line) => `+${line}`)
  ];

  return boundText(lines.join("\n"), input.maxBytes ?? 32 * 1024);
}

/**
 * Count changed lines between two text snapshots without exposing the text.
 *
 * @param {string} before
 * @param {string} after
 * @param {{ maxCells?: number }} options
 */
export function countLineChanges(before, after, options = {}) {
  const beforeLines = splitLines(String(before ?? ""));
  const afterLines = splitLines(String(after ?? ""));
  let prefix = 0;
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix += 1;
  }

  let beforeEnd = beforeLines.length;
  let afterEnd = afterLines.length;
  while (
    beforeEnd > prefix &&
    afterEnd > prefix &&
    beforeLines[beforeEnd - 1] === afterLines[afterEnd - 1]
  ) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }

  const beforeMiddle = beforeLines.slice(prefix, beforeEnd);
  const afterMiddle = afterLines.slice(prefix, afterEnd);
  if (beforeMiddle.length === 0 || afterMiddle.length === 0) {
    return {
      additions: afterMiddle.length,
      deletions: beforeMiddle.length,
      approximate: false
    };
  }

  const maxCells = positiveInteger(options.maxCells, 1_000_000);
  if (beforeMiddle.length * afterMiddle.length > maxCells) {
    return {
      additions: afterMiddle.length,
      deletions: beforeMiddle.length,
      approximate: true
    };
  }

  let previous = new Uint32Array(afterMiddle.length + 1);
  let current = new Uint32Array(afterMiddle.length + 1);
  for (let beforeIndex = 1; beforeIndex <= beforeMiddle.length; beforeIndex += 1) {
    const beforeLine = beforeMiddle[beforeIndex - 1];
    for (let afterIndex = 1; afterIndex <= afterMiddle.length; afterIndex += 1) {
      current[afterIndex] = beforeLine === afterMiddle[afterIndex - 1]
        ? previous[afterIndex - 1] + 1
        : Math.max(previous[afterIndex], current[afterIndex - 1]);
    }
    [previous, current] = [current, previous];
    current.fill(0);
  }

  const common = previous[afterMiddle.length];
  return {
    additions: afterMiddle.length - common,
    deletions: beforeMiddle.length - common,
    approximate: false
  };
}

/**
 * @param {string} value
 */
function splitLines(value) {
  if (value.length === 0) {
    return [];
  }
  const lines = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

/**
 * @param {string} value
 * @param {number} maxBytes
 */
function boundText(value, maxBytes) {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes <= maxBytes) {
    return { text: value, truncated: false, bytes };
  }
  return {
    text: `${Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8")}\n...[diff truncated at ${maxBytes} bytes]`,
    truncated: true,
    bytes
  };
}
