/**
 * Markdown table parser and renderer for Ant Code TUI.
 *
 * Stage 1+2: Parse standard pipe tables, compute column widths using
 * displayWidth(), render them as aligned text lines with noWrap metadata
 * so the transcript pipeline skips secondary soft-wrap for table rows.
 *
 * Fallback strategies per the plan:
 * - Small table:  render completely when it fits available width.
 * - Medium table: compress columns proportionally, truncate long cells.
 * - Large table:  render a summary line in the main transcript, unless the
 *   caller explicitly requests a full rendered table for excerpt/copy views.
 *
 * Code block content is never parsed as a table.
 */

// Re-export displayWidth so consumers can import from this single module.
export { displayWidth } from "./input-editor.js";
import { displayWidth } from "./input-editor.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LARGE_TABLE_ROW_THRESHOLD = 20;
const LARGE_TABLE_COL_THRESHOLD = 8;

// ---------------------------------------------------------------------------
// Stage 1 – Table parsing
// ---------------------------------------------------------------------------

/**
 * Split markdown text into a sequence of blocks.
 * Each block is either:
 *   { type: "paragraph", text: string }
 *   { type: "code",     text: string }
 *   { type: "table",    headers: string[], alignments: string[], rows: string[][], raw: string }
 *
 * Code blocks (fenced with ``` or ~~~) are detected and skipped for table parsing.
 * Only content outside code fences is considered for table recognition.
 */
export function parseMarkdownBlocks(text) {
  const raw = String(text ?? "");
  if (!raw) {
    return [];
  }
  const lines = raw.split(/\r?\n/);
  const blocks = [];
  let inCode = false;
  let codeLines = [];
  let paragraphLines = [];

  function flushParagraph() {
    if (paragraphLines.length > 0) {
      blocks.push({ type: "paragraph", text: paragraphLines.join("\n") });
      paragraphLines = [];
    }
  }

  function flushCode() {
    if (codeLines.length > 0) {
      blocks.push({ type: "code", text: codeLines.join("\n") });
      codeLines = [];
    }
  }

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Detect fenced code block boundaries: ``` or ~~~.
    // Keep the fence lines so code answers retain language markers and copy shape.
    if (/^\s*(```+|~~~+)/.test(line)) {
      if (inCode) {
        codeLines.push(line);
        // Closing fence must be at least as long as opening, with no info string.
        if (/^\s*(```+|~~~+)\s*$/.test(line)) {
          flushCode();
          inCode = false;
          i += 1;
          continue;
        }
        // Not a valid closing fence – treat as code content
        i += 1;
        continue;
      }
      // Opening fence – start code block, skip any table detection
      flushParagraph();
      inCode = true;
      codeLines = [line];
      i += 1;
      continue;
    }

    if (inCode) {
      codeLines.push(line);
      i += 1;
      continue;
    }

    // Try to parse a table starting at this line
    const tableResult = tryParseTable(lines, i);
    if (tableResult) {
      flushParagraph();
      blocks.push(tableResult.block);
      i = tableResult.endIndex;
      continue;
    }

    paragraphLines.push(line);
    i += 1;
  }

  // Flush remaining state
  if (inCode) {
    flushCode();
  }
  flushParagraph();
  return blocks;
}

/**
 * Try to parse a Markdown pipe table starting at lines[startIndex].
 * Returns { block, endIndex } if successful, or null if not a table.
 */
function tryParseTable(lines, startIndex) {
  if (startIndex >= lines.length) {
    return null;
  }

  // A table row must contain at least one | character
  const firstLine = lines[startIndex];
  if (!firstLine.includes("|")) {
    return null;
  }

  // Look for a separator row on the next line
  const separatorIndex = startIndex + 1;
  if (separatorIndex >= lines.length) {
    return null;
  }

  const separatorLine = lines[separatorIndex];
  if (!isSeparatorRow(separatorLine)) {
    return null;
  }

  // Parse header
  const headers = parseRow(firstLine);
  const alignments = parseAlignments(separatorLine);

  // Parse data rows, validating column count consistency
  const dataRows = [];
  let endIndex = separatorIndex + 1;
  while (endIndex < lines.length) {
    const line = lines[endIndex];
    if (!line.includes("|") || line.trim() === "") {
      break;
    }
    const parsed = parseRow(line);
    // Loosely validate column count: stop if wildly inconsistent with header
    // Allow ±2 tolerance to handle common markdown variations
    if (parsed.length > headers.length + 2 || parsed.length < Math.max(1, headers.length - 2)) {
      break;
    }
    dataRows.push(parsed);
    endIndex += 1;
  }

  return {
    block: {
      type: "table",
      headers,
      alignments,
      rows: dataRows,
      raw: lines.slice(startIndex, endIndex).join("\n"),
    },
    endIndex,
  };
}

/**
 * Check if a line is a valid Markdown table separator row.
 * e.g.,  |---|---:|:---:|
 */
function isSeparatorRow(line) {
  const trimmed = line.trim();
  // Must contain at least one | and the rest should be - and : and spaces
  if (!trimmed.includes("|")) {
    return false;
  }
  // Split by |, each cell must match the separator pattern
  const cells = trimmed
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|");
  if (cells.length === 0) {
    return false;
  }
  return cells.every((cell) => /^[\s]*:?-+:?[\s]*$/.test(cell));
}

/**
 * Parse a pipe-separated row into cell values.
 * Strips leading/trailing | and trims whitespace.
 */
function parseRow(line) {
  let text = line.trim();
  // Remove leading and trailing |
  if (text.startsWith("|")) {
    text = text.slice(1);
  }
  if (text.endsWith("|")) {
    text = text.slice(0, -1);
  }
  return text.split("|").map((cell) => cell.trim());
}

/**
 * Parse alignment markers from a separator row.
 * Returns array of "left" | "center" | "right" for each column.
 */
function parseAlignments(line) {
  let text = line.trim();
  if (text.startsWith("|")) {
    text = text.slice(1);
  }
  if (text.endsWith("|")) {
    text = text.slice(0, -1);
  }
  return text.split("|").map((cell) => {
    const trimmed = cell.trim();
    const hasLeft = trimmed.startsWith(":");
    const hasRight = trimmed.endsWith(":");
    if (hasLeft && hasRight) {
      return "center";
    }
    if (hasRight) {
      return "right";
    }
    return "left";
  });
}

// ---------------------------------------------------------------------------
// Stage 2 – Table layout and rendering
// ---------------------------------------------------------------------------

/**
 * Check if a parsed table block is too large to render inline.
 */
export function isLargeTable(block) {
  if (block.type !== "table") {
    return false;
  }
  return (
    block.rows.length >= LARGE_TABLE_ROW_THRESHOLD ||
    block.headers.length >= LARGE_TABLE_COL_THRESHOLD
  );
}

/**
 * Render a table block into an array of line objects.
 *
 * Each returned line has shape { text, dim, color, noWrap }.
 * The noWrap flag signals the transcript pipeline to skip soft-wrap.
 *
 * @param {object}  block        – a { type: "table", headers, alignments, rows, raw } block
 * @param {number}  availWidth   – available terminal width for rendering
 * @param {Function} widthFn     – displayWidth function (injected for testability)
 * @param {{ summarizeLarge?: boolean; wrapCells?: boolean; minColumnWidth?: number }} options
 * @returns {Array<{text: string, dim?: boolean, color?: string, noWrap?: boolean}>}
 */
export function renderTable(block, availWidth, widthFn = displayWidth, options = {}) {
  if (!block || block.type !== "table") {
    return [];
  }

  const summarizeLarge = options.summarizeLarge !== false;
  const numCols = block.headers.length;
  const totalRows = block.rows.length;

  // Large table → summary
  if (summarizeLarge && isLargeTable(block)) {
    return [
      {
        text: summaryText(`{表格 ${totalRows} 行 x ${numCols} 列，双击消息进入摘录查看完整表格}`, availWidth, widthFn),
        dim: true,
        color: "yellow",
        noWrap: true,
      },
    ];
  }

  // Compute raw column widths using displayWidth
  const colWidths = new Array(numCols).fill(0);
  for (let c = 0; c < numCols; c += 1) {
    colWidths[c] = Math.max(colWidths[c], widthFn(block.headers[c] ?? ""));
  }
  for (const row of block.rows) {
    for (let c = 0; c < numCols; c += 1) {
      colWidths[c] = Math.max(colWidths[c], widthFn(row[c] ?? ""));
    }
  }

  // Add padding: 1 space on each side of cell content
  const paddedWidths = colWidths.map((w) => w + 2);

  // Calculate total width needed (including column separators |)
  const separatorWidth = numCols - 1; // | between columns
  const totalWidth = paddedWidths.reduce((sum, w) => sum + w, 0) + separatorWidth;

  // If total fits in availWidth, render as-is
  if (totalWidth <= availWidth) {
    return renderFormattedTable(block, paddedWidths, widthFn);
  }

  // Medium table: compress columns proportionally
  const availableForCells = availWidth - separatorWidth;
  if (availableForCells < numCols * 3) {
    // Too narrow even for minimal cells, fall back to summary
    return [
      {
        text: summaryText(`{表格 ${totalRows} 行 x ${numCols} 列，窗口过窄无法显示，双击消息进入摘录查看完整表格}`, availWidth, widthFn),
        dim: true,
        color: "yellow",
        noWrap: true,
      },
    ];
  }

  // Proportionally compress, preserving a readable minimum column width.
  const requestedMinColumnWidth = Math.max(3, Number(options.minColumnWidth) || 3);
  const minColumnWidth = Math.max(3, Math.min(requestedMinColumnWidth, Math.floor(availableForCells / Math.max(1, numCols))));
  const compressedWidths = proportionalCompress(paddedWidths, availableForCells, minColumnWidth);
  return options.wrapCells
    ? renderWrappedTable(block, compressedWidths, widthFn)
    : renderFormattedTable(block, compressedWidths, widthFn);
}

/**
 * Proportionally compress column widths to fit within maxWidth.
 * Each column gets at least minWidth.
 * After floor allocation, distributes remainder to columns with largest fractional parts.
 */
function proportionalCompress(widths, maxWidth, minWidth) {
  const total = widths.reduce((sum, w) => sum + w, 0);
  if (total <= maxWidth) {
    return widths;
  }
  const totalMin = minWidth * widths.length;
  if (totalMin >= maxWidth) {
    return widths.map(() => minWidth);
  }
  const availableExtra = maxWidth - totalMin;
  const totalExtra = total - totalMin;
  // Calculate fractional allocations for remainder distribution
  const allocations = widths.map((w) => {
    const extra = Math.max(0, w - minWidth);
    const exact = (extra / totalExtra) * availableExtra;
    return { floor: Math.floor(exact), frac: exact - Math.floor(exact) };
  });
  const result = allocations.map((a) => minWidth + a.floor);
  // Distribute remainder (one char each) to columns with largest fractional parts
  let remainder = maxWidth - result.reduce((sum, w) => sum + w, 0);
  const indices = allocations
    .map((a, i) => ({ i, frac: a.frac }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < remainder; k += 1) {
    result[indices[k].i] += 1;
  }
  return result;
}

/**
 * Render a formatted table with given column widths.
 */
function renderFormattedTable(block, colWidths, widthFn) {
  const lines = [];

  // Header row
  lines.push({
    text: renderRow(block.headers, block.alignments, colWidths, widthFn),
    dim: false,
    color: undefined,
    noWrap: true,
  });

  // Separator row
  lines.push({
    text: renderSeparatorRow(colWidths),
    dim: false,
    color: undefined,
    noWrap: true,
  });

  // Data rows
  for (const row of block.rows) {
    lines.push({
      text: renderRow(row, block.alignments, colWidths, widthFn),
      dim: false,
      color: undefined,
      noWrap: true,
    });
  }

  return lines;
}

/**
 * Render a table with wrapped cells. Used by excerpt/copy surfaces where
 * preserving complete cell content matters more than one-physical-line rows.
 */
function renderWrappedTable(block, colWidths, widthFn) {
  const lines = [];
  for (const text of renderWrappedPhysicalRow(block.headers, block.alignments, colWidths, widthFn)) {
    lines.push({
      text,
      dim: false,
      color: undefined,
      noWrap: true,
    });
  }
  lines.push({
    text: renderSeparatorRow(colWidths),
    dim: false,
    color: undefined,
    noWrap: true,
  });
  for (const row of block.rows) {
    for (const text of renderWrappedPhysicalRow(row, block.alignments, colWidths, widthFn)) {
      lines.push({
        text,
        dim: false,
        color: undefined,
        noWrap: true,
      });
    }
  }
  return lines;
}

function renderWrappedPhysicalRow(cells, alignments, colWidths, widthFn) {
  const wrappedCells = colWidths.map((width, column) => {
    const targetWidth = Math.max(1, width - 2);
    return wrapCellText(cells[column] ?? "", targetWidth, widthFn);
  });
  const height = Math.max(1, ...wrappedCells.map((cell) => cell.length));
  return Array.from({ length: height }, (_, lineIndex) => {
    const parts = colWidths.map((width, column) => {
      const targetWidth = Math.max(1, width - 2);
      const align = alignments[column] ?? "left";
      const text = wrappedCells[column][lineIndex] ?? "";
      return padCell(text, targetWidth, align, widthFn);
    });
    return "|" + parts.join("|") + "|";
  });
}

/**
 * Render a single data row, padding cells to column widths with alignment.
 */
function renderRow(cells, alignments, colWidths, widthFn) {
  const parts = [];
  for (let c = 0; c < colWidths.length; c += 1) {
    const cellText = cells[c] ?? "";
    const targetWidth = colWidths[c] - 2; // subtract padding
    const align = alignments[c] ?? "left";
    parts.push(padCell(cellText, targetWidth, align, widthFn));
  }
  return "|" + parts.join("|") + "|";
}

/**
 * Render a separator row: |---|:---:|---:|
 * Separator width matches the data cell content width exactly.
 */
function renderSeparatorRow(colWidths) {
  const parts = [];
  for (let c = 0; c < colWidths.length; c += 1) {
    const innerWidth = Math.max(1, colWidths[c] - 2);
    parts.push("-".repeat(innerWidth));
  }
  return "|" + parts.join("|") + "|";
}

/**
 * Pad a cell string to the target display width, respecting alignment.
 * If the cell exceeds the target width, truncate it with "…" suffix.
 */
function padCell(text, targetWidth, alignment, widthFn) {
  const currentWidth = widthFn(text);
  if (currentWidth > targetWidth) {
    // Truncate
    return truncateToFit(text, targetWidth, widthFn);
  }
  const padding = targetWidth - currentWidth;
  if (alignment === "right") {
    return " ".repeat(padding) + text;
  }
  if (alignment === "center") {
    const leftPad = Math.floor(padding / 2);
    const rightPad = padding - leftPad;
    return " ".repeat(leftPad) + text + " ".repeat(rightPad);
  }
  // left alignment (default)
  return text + " ".repeat(padding);
}

function wrapCellText(text, targetWidth, widthFn) {
  const value = String(text ?? "");
  if (!value) {
    return [""];
  }
  const rows = [];
  let current = "";
  let currentWidth = 0;
  for (const char of Array.from(value)) {
    const charWidth = Math.max(0, widthFn(char));
    if (current && currentWidth + charWidth > targetWidth) {
      rows.push(current);
      current = char;
      currentWidth = charWidth;
    } else {
      current += char;
      currentWidth += charWidth;
    }
  }
  rows.push(current);
  return rows;
}

/**
 * Truncate text to fit within maxWidth display columns, appending "…".
 * Returns the text with enough content removed to fit.
 */
function truncateToFit(text, maxWidth, widthFn) {
  if (maxWidth <= 0) {
    return "";
  }
  if (widthFn(text) <= maxWidth) {
    return text;
  }
  const chars = Array.from(text);
  let result = "";
  let used = 0;
  // Reserve 1 column for "…"
  const budget = maxWidth - 1;
  for (const char of chars) {
    const cw = widthFn(char);
    if (used + cw > budget) {
      break;
    }
    result += char;
    used += cw;
  }
  return result + "…";
}

function summaryText(text, maxWidth, widthFn) {
  const width = Math.max(1, Number(maxWidth) || 1);
  return truncateToFit(text, width, widthFn);
}

/**
 * Split assistant body text into paragraph and table blocks, preserving order.
 * This is the main entry point for Stage 3 integration.
 */
export function splitBodyBlocks(bodyText) {
  return parseMarkdownBlocks(bodyText);
}
