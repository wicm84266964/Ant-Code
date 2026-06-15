import assert from "node:assert/strict";
import test from "node:test";
import {
  parseMarkdownBlocks,
  renderTable,
  isLargeTable,
  displayWidth
} from "../../src/cli/tui/markdown-table.js";
import { transcriptBlockLines, transcriptViewport } from "../../src/cli/tui/format.js";

// ---------------------------------------------------------------------------
// Stage 1: Table parsing tests
// ---------------------------------------------------------------------------

test("parseMarkdownBlocks identifies a standard English pipe table", () => {
  const md = [
    "| Name | Age |",
    "| --- | ---:|",
    "| Alice | 30 |",
    "| Bob | 25 |"
  ].join("\n");

  const blocks = parseMarkdownBlocks(md);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "table");
  assert.deepEqual(blocks[0].headers, ["Name", "Age"]);
  assert.deepEqual(blocks[0].alignments, ["left", "right"]);
  assert.equal(blocks[0].rows.length, 2);
  assert.deepEqual(blocks[0].rows[0], ["Alice", "30"]);
  assert.deepEqual(blocks[0].rows[1], ["Bob", "25"]);
});

test("parseMarkdownBlocks identifies a Chinese pipe table", () => {
  const md = [
    "| 姓名 | 年龄 |",
    "| --- | --- |",
    "| 张三 | 28 |",
    "| 李四 | 35 |"
  ].join("\n");

  const blocks = parseMarkdownBlocks(md);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "table");
  assert.deepEqual(blocks[0].headers, ["姓名", "年龄"]);
  assert.equal(blocks[0].rows.length, 2);
  assert.deepEqual(blocks[0].rows[0], ["张三", "28"]);
});

test("parseMarkdownBlocks parses alignment markers correctly", () => {
  const md = [
    "| L | R | C |",
    "| :--- | ---: | :---: |",
    "| a | b | c |"
  ].join("\n");

  const blocks = parseMarkdownBlocks(md);
  assert.equal(blocks[0].alignments[0], "left");
  assert.equal(blocks[0].alignments[1], "right");
  assert.equal(blocks[0].alignments[2], "center");
});

test("parseMarkdownBlocks does NOT parse content inside fenced code blocks", () => {
  const md = [
    "Some text before.",
    "",
    "```",
    "| Name | Age |",
    "| --- | --- |",
    "| Alice | 30 |",
    "```",
    "",
    "Some text after."
  ].join("\n");

  const blocks = parseMarkdownBlocks(md);
  // Should have paragraph blocks and a code block, but no table
  const tableBlocks = blocks.filter((b) => b.type === "table");
  assert.equal(tableBlocks.length, 0, "No table should be parsed inside code blocks");
  const codeBlocks = blocks.filter((b) => b.type === "code");
  assert.equal(codeBlocks.length, 1);
  assert.match(codeBlocks[0].text, /^```/);
  assert.match(codeBlocks[0].text, /```$/);
});

test("parseMarkdownBlocks preserves code fence language markers", () => {
  const md = [
    "```js",
    "console.log('hi')",
    "```"
  ].join("\n");

  const blocks = parseMarkdownBlocks(md);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "code");
  assert.equal(blocks[0].text, md);
});

test("parseMarkdownBlocks does NOT parse ~~~ fenced code blocks as tables", () => {
  const md = [
    "~~~",
    "| Name | Age |",
    "| --- | --- |",
    "| Alice | 30 |",
    "~~~"
  ].join("\n");

  const blocks = parseMarkdownBlocks(md);
  const tableBlocks = blocks.filter((b) => b.type === "table");
  assert.equal(tableBlocks.length, 0);
  const codeBlocks = blocks.filter((b) => b.type === "code");
  assert.equal(codeBlocks.length, 1);
});

test("parseMarkdownBlocks handles mixed paragraph and table blocks", () => {
  const md = [
    "Hello world.",
    "",
    "| A | B |",
    "| -- | -- |",
    "| 1 | 2 |",
    "",
    "Goodbye."
  ].join("\n");

  const blocks = parseMarkdownBlocks(md);
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].type, "paragraph");
  assert.equal(blocks[1].type, "table");
  assert.equal(blocks[2].type, "paragraph");
});

test("parseMarkdownBlocks does not treat plain text with | as a table", () => {
  const md = "This is a sentence with a | pipe character.";
  const blocks = parseMarkdownBlocks(md);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "paragraph");
});

test("parseMarkdownBlocks returns empty array for empty input", () => {
  assert.deepEqual(parseMarkdownBlocks(""), []);
  assert.deepEqual(parseMarkdownBlocks(null), []);
});

test("parseMarkdownBlocks stops data rows when column count is inconsistent", () => {
  const md = [
    "| A | B |",
    "| -- | -- |",
    "| 1 | 2 |",
    "| x | y | z | w | extra |",
    "| 3 | 4 |"
  ].join("\n");

  const blocks = parseMarkdownBlocks(md);
  assert.equal(blocks[0].type, "table");
  // The inconsistent row (5 cols vs 2) triggers a break;
  // subsequent valid rows are also skipped since parsing stops.
  assert.equal(blocks[0].rows.length, 1);
});

// ---------------------------------------------------------------------------
// Stage 2: Table layout and rendering tests
// ---------------------------------------------------------------------------

test("renderTable renders a small English table that fits within availWidth", () => {
  const block = {
    type: "table",
    headers: ["Name", "Age"],
    alignments: ["left", "right"],
    rows: [["Alice", "30"], ["Bob", "25"]],
    raw: ""
  };
  const lines = renderTable(block, 80);
  // Header + separator + 2 data rows = 4 lines
  assert.equal(lines.length, 4);
  // All lines should have noWrap
  assert.ok(lines.every((l) => l.noWrap === true));
  // Header line
  assert.match(lines[0].text, /\|.*Name.*\|.*Age.*\|/);
  // Separator line
  assert.match(lines[1].text, /\|.*-.*\|.*-.*\|/);
  // Data lines
  assert.match(lines[2].text, /Alice/);
  assert.match(lines[3].text, /Bob/);
  // All lines should fit within 80 columns
  for (const l of lines) {
    assert.ok(displayWidth(l.text) <= 80, `Line exceeds 80 columns: "${l.text}" (${displayWidth(l.text)})`);
  }
});

test("renderTable renders a Chinese table with correct displayWidth alignment", () => {
  const block = {
    type: "table",
    headers: ["姓名", "年龄", "城市"],
    alignments: ["left", "center", "right"],
    rows: [["张三", "28", "北京"], ["李四", "35", "上海"]],
    raw: ""
  };
  const lines = renderTable(block, 80);
  assert.equal(lines.length, 4);
  // All lines should fit within 80 columns
  for (const l of lines) {
    assert.ok(displayWidth(l.text) <= 80, `Chinese line exceeds width: "${l.text}" (${displayWidth(l.text)})`);
  }
  // All lines should have the same displayWidth (alignment correctness)
  const widths = lines.map((l) => displayWidth(l.text));
  assert.ok(widths.every((w) => w === widths[0]), `Table rows have inconsistent widths: ${widths}`);
});

test("renderTable returns summary for large tables (>= 20 rows)", () => {
  const rows = Array.from({ length: 20 }, (_, i) => [`r${i}`, `${i}`]);
  const block = {
    type: "table",
    headers: ["Name", "Id"],
    alignments: ["left", "left"],
    rows,
    raw: ""
  };
  assert.ok(isLargeTable(block));
  const lines = renderTable(block, 80);
  assert.equal(lines.length, 1);
  assert.match(lines[0].text, /表格 20 行 x 2 列/);
  assert.equal(lines[0].dim, true);
  assert.equal(lines[0].color, "yellow");
  assert.equal(lines[0].noWrap, true);
});

test("renderTable returns summary for large tables (>= 8 columns)", () => {
  const headers = Array.from({ length: 8 }, (_, i) => `Col${i}`);
  const block = {
    type: "table",
    headers,
    alignments: headers.map(() => "left"),
    rows: [["a", "b", "c", "d", "e", "f", "g", "h"]],
    raw: ""
  };
  assert.ok(isLargeTable(block));
  const lines = renderTable(block, 80);
  assert.equal(lines.length, 1);
  assert.match(lines[0].text, /表格 1 行 x 8 列/);
});

test("renderTable compresses columns when table is too wide for availWidth", () => {
  const block = {
    type: "table",
    headers: ["A Very Long Header Name", "Another Long Header"],
    alignments: ["left", "left"],
    rows: [["This is a long value", "Another long value here"]],
    raw: ""
  };
  const lines = renderTable(block, 40);
  // 1 header + 1 separator + 1 data row = 3 lines
  assert.equal(lines.length, 3);
  // All lines must fit within 40 columns
  for (const l of lines) {
    assert.ok(displayWidth(l.text) <= 40, `Compressed line exceeds 40: "${l.text}" (${displayWidth(l.text)})`);
  }
});

test("renderTable can wrap wide cells inside table columns for excerpt views", () => {
  const block = {
    type: "table",
    headers: ["Long Header A", "Long Header B", "Long Header C"],
    alignments: ["left", "left", "left"],
    rows: [[
      "alpha-beta-gamma-delta-epsilon",
      "second-alpha-beta-gamma-delta-epsilon",
      "third-alpha-beta-gamma-delta-epsilon"
    ]],
    raw: ""
  };
  const lines = renderTable(block, 42, displayWidth, {
    summarizeLarge: false,
    wrapCells: true,
    minColumnWidth: 8
  });
  const text = lines.map((item) => item.text).join("\n");
  const compactText = text.replace(/\s+/g, "");

  assert.ok(lines.length > 3, "Wrapped table should use multiple physical rows");
  assert.ok(lines.every((item) => item.noWrap === true));
  for (const item of lines) {
    assert.ok(displayWidth(item.text) <= 42, `wrapped row exceeds width: ${displayWidth(item.text)} ${item.text}`);
    assert.ok(item.text.startsWith("|") && item.text.endsWith("|"), `wrapped row should remain a table row: ${item.text}`);
  }
  assert.ok(containsOrderedCharacters(compactText, "alpha-beta-gamma-delta-epsilon"));
  assert.ok(containsOrderedCharacters(compactText, "second-alpha-beta-gamma-delta-epsilon"));
  assert.ok(containsOrderedCharacters(compactText, "third-alpha-beta-gamma-delta-epsilon"));
  assert.doesNotMatch(text, /…/);
});

test("renderTable falls back to summary for extremely narrow windows", () => {
  const block = {
    type: "table",
    headers: ["Col1", "Col2", "Col3", "Col4"],
    alignments: ["left", "left", "left", "left"],
    rows: [["a", "b", "c", "d"]],
    raw: ""
  };
  const lines = renderTable(block, 10);
  assert.equal(lines.length, 1);
  assert.match(lines[0].text, /表格 1/);
  assert.equal(lines[0].dim, true);
  assert.equal(lines[0].noWrap, true);
});

test("renderTable handles a table with no data rows", () => {
  const block = {
    type: "table",
    headers: ["A", "B"],
    alignments: ["left", "left"],
    rows: [],
    raw: ""
  };
  const lines = renderTable(block, 80);
  // Header + separator only (0 data rows)
  assert.equal(lines.length, 2);
});

test("renderTable handles a single-column table", () => {
  const block = {
    type: "table",
    headers: ["Only"],
    alignments: ["left"],
    rows: [["val1"], ["val2"]],
    raw: ""
  };
  const lines = renderTable(block, 80);
  assert.equal(lines.length, 4);
  for (const l of lines) {
    assert.ok(displayWidth(l.text) <= 80);
  }
});

test("renderTable returns empty array for non-table block", () => {
  assert.deepEqual(renderTable({ type: "paragraph", text: "hi" }, 80), []);
  assert.deepEqual(renderTable(null, 80), []);
});

test("displayWidth returns correct width for CJK characters", () => {
  // CJK chars take 2 columns each
  assert.equal(displayWidth("张三"), 4);
  assert.equal(displayWidth("ab"), 2);
  assert.equal(displayWidth("张a三"), 5); // 2+1+2
});

// ---------------------------------------------------------------------------
// Stage 3: Transcript integration tests
// ---------------------------------------------------------------------------

test("transcriptBlockLines renders assistant body with markdown table correctly", () => {
  const body = [
    "Here is a table:",
    "",
    "| Name | Age |",
    "| --- | --- |",
    "| Alice | 30 |",
    "| Bob | 25 |",
    "",
    "End of table."
  ].join("\n");

  const lines = transcriptBlockLines({ kind: "assistant", title: "assistant", body }, "compact");
  const texts = lines.map((l) => l.text);

  // Should contain the intro line
  assert.ok(texts.some((t) => t.includes("Here is a table:")));
  // Should contain table header
  assert.ok(texts.some((t) => t.includes("Name") && t.includes("Age")));
  // Should contain table data
  assert.ok(texts.some((t) => t.includes("Alice")));
  assert.ok(texts.some((t) => t.includes("Bob")));
  // Should contain the outro line
  assert.ok(texts.some((t) => t.includes("End of table.")));
});

test("transcriptBlockLines preserves noWrap metadata for table lines", () => {
  const body = [
    "| A | B |",
    "| -- | -- |",
    "| 1 | 2 |"
  ].join("\n");

  const lines = transcriptBlockLines({ kind: "assistant", title: "assistant", body }, "compact");
  // Table lines should have noWrap set
  const tableLines = lines.filter((l) => l.noWrap);
  assert.ok(tableLines.length >= 3, `Expected at least 3 noWrap lines, got ${tableLines.length}`);
});

test("transcriptBlockLines preserves dim/color for large table summary", () => {
  const rows = Array.from({ length: 25 }, (_, i) => `| r${i} | ${i} |`).join("\n");
  const body = [
    "| Name | Id |",
    "| --- | --- |",
    rows
  ].join("\n");

  const lines = transcriptBlockLines({ kind: "assistant", title: "assistant", body }, "compact");
  const summaryLine = lines.find((l) => l.text?.includes("表格 25 行"));
  assert.ok(summaryLine, "Should contain large table summary");
  assert.equal(summaryLine.dim, true);
  assert.equal(summaryLine.color, "yellow");
  assert.equal(summaryLine.noWrap, true);
});

test("transcriptBlockLines falls back to soft-wrap for plain text without tables", () => {
  const body = "This is a plain paragraph without any tables.";
  const lines = transcriptBlockLines({ kind: "assistant", title: "assistant", body }, "compact");
  assert.ok(lines.length >= 1);
  // Should not have noWrap on plain text lines
  assert.ok(lines.every((l) => !l.noWrap), "Plain text lines should not have noWrap");
});

test("transcriptBlockLines wraps long plain paragraphs in transcript viewport", () => {
  // A paragraph long enough to trigger soft-wrap (80-char lines at 40-column width)
  const body = "Line 1: " + "word ".repeat(20) + "\nLine 2: " + "word ".repeat(20);
  const lines = transcriptBlockLines({ kind: "assistant", title: "assistant", body }, "compact");
  assert.ok(lines.length > 2, "Long paragraphs should be soft-wrapped into multiple lines");
});

test("transcriptViewport handles assistant body with mixed paragraphs and tables", () => {
  const body = [
    "Intro paragraph.",
    "",
    "| A | B |",
    "| -- | -- |",
    "| 1 | 2 |",
    "",
    "Outro paragraph."
  ].join("\n");

  const entries = [{ kind: "assistant", title: "assistant", body }];
  const viewport = transcriptViewport(entries, 20, 80, 0, "compact");
  assert.ok(viewport.totalRows > 0, "Viewport should have rows");
  assert.ok(viewport.lines.length > 0, "Viewport should have visible lines");
});

test("transcriptViewport renders table rows within narrow chat width", () => {
  const body = [
    "| 字段名称 | 含义说明 | 备注 |",
    "| --- | --- | --- |",
    "| veryVeryLongColumnNameThatShouldOverflow | 这是一段很长很长的中文说明，用来测试窄窗口是否会撑破边框 | 需要稳定显示 |"
  ].join("\n");
  const viewport = transcriptViewport([{ kind: "assistant", title: "assistant", body }], 20, 50, 0, "compact");
  for (const row of viewport.lines) {
    assert.ok(displayWidth(row.text) <= 44, `row exceeds usable transcript width: ${displayWidth(row.text)} ${row.text}`);
  }
});

test("transcriptBlockLines handles empty body gracefully", () => {
  const lines = transcriptBlockLines({ kind: "assistant", title: "assistant", body: "" }, "compact");
  // Should at least have the "Ant Code" header line
  assert.ok(lines.length >= 1);
});

test("transcriptBlockLines handles body with only a table (no surrounding text)", () => {
  const body = [
    "| X | Y |",
    "| -- | -- |",
    "| a | b |",
    "| c | d |"
  ].join("\n");

  const lines = transcriptBlockLines({ kind: "assistant", title: "assistant", body }, "compact");
  // Should include "Ant Code" header + table lines
  assert.ok(lines.length >= 4);
  // All table lines should have noWrap
  const tableLines = lines.filter((l) => l.noWrap);
  assert.ok(tableLines.length >= 3);
});

test("transcriptBlockLines handles body with code block containing pipe characters", () => {
  const body = [
    "Before code:",
    "",
    "```",
    "| This | is | not | a | table |",
    "| --- | --- | --- | --- | --- |",
    "| inside | code | block | yes | ok |",
    "```",
    "",
    "After code."
  ].join("\n");

  const lines = transcriptBlockLines({ kind: "assistant", title: "assistant", body }, "compact");
  // Code block content should use the readable code color but NOT be treated as a table.
  const codeLines = lines.filter((l) => l.color === "code");
  assert.ok(codeLines.every((l) => !l.dim), "Code block lines should not use dim gray");
  assert.ok(codeLines.some((l) => l.text.includes("```")), "Code block fence should be preserved");
  assert.ok(codeLines.some((l) => l.text.includes("is | not")), "Code block content should appear as code-colored lines");
  // No lines should have noWrap from table rendering
  const noWrapLines = lines.filter((l) => l.noWrap);
  assert.equal(noWrapLines.length, 0, "No lines should have noWrap when only code blocks have pipes");
});

test("renderTable separator row width matches data row width exactly", () => {
  const block = {
    type: "table",
    headers: ["Col", "Val"],
    alignments: ["left", "left"],
    rows: [["hello", "world"]],
    raw: ""
  };
  const lines = renderTable(block, 80);
  const headerWidth = displayWidth(lines[0].text);
  const separatorWidth = displayWidth(lines[1].text);
  const dataWidth = displayWidth(lines[2].text);
  assert.equal(headerWidth, separatorWidth, "Header and separator should have same width");
  assert.equal(separatorWidth, dataWidth, "Separator and data should have same width");
});

function containsOrderedCharacters(haystack, needle) {
  const source = Array.from(String(haystack ?? ""));
  const target = Array.from(String(needle ?? "").replace(/\s+/g, ""));
  let index = 0;
  for (const char of source) {
    if (char === target[index]) {
      index += 1;
      if (index >= target.length) {
        return true;
      }
    }
  }
  return target.length === 0;
}
