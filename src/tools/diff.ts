/**
 * Create a compact unified diff for a single text file.
 *
 * @param {{ filePath: string; before: string; after: string; maxBytes?: number }} input
 */
export function createUnifiedDiff(input: { filePath: string; before: string; after: string; maxBytes?: number }) {
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
export function previewUnifiedDiff(diff: unknown, maxLines: number = 24) {
  const text = String(diff ?? "").replace(/\s+$/g, "");
  if (!text) {
    return "";
  }
  const lines = text.split(/\r?\n/);
  const limit = Math.max(4, Number(maxLines) || 24);
  if (lines.length <= limit) {
    return text;
  }
  return `${lines.slice(0, limit).join("\n")}\n... 还有 ${lines.length - limit} 行`;
}

export function countLineChanges(before: string, after: string, options: { maxCells?: number } = {}) {
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
function splitLines(value: string) {
  if (value.length === 0) {
    return [];
  }
  const lines = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function positiveInteger(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

/**
 * @param {string} value
 * @param {number} maxBytes
 */
function boundText(value: string, maxBytes: number) {
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
