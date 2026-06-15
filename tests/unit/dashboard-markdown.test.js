import assert from "node:assert/strict";
import test from "node:test";
import { parseMarkdownBlocks, renderMarkdown } from "../../src/dashboard/public/markdown.js";

test("dashboard markdown renders pipe tables as html tables", () => {
  const html = renderMarkdown([
    "结果如下：",
    "",
    "| 指标 | 数值 | 说明 |",
    "| --- | ---: | :--- |",
    "| 样本 | 12 | 已清洗 |",
    "| 通过率 | 98% | 稳定 |"
  ].join("\n"));

  assert.match(html, /<table>/);
  assert.match(html, /<th>指标<\/th>/);
  assert.match(html, /<td class="align-right">12<\/td>/);
  assert.match(html, /<td class="align-left">已清洗<\/td>/);
  assert.doesNotMatch(html, /\| --- \|/);
});

test("dashboard markdown does not parse tables inside fenced code", () => {
  const markdown = [
    "```md",
    "| A | B |",
    "| --- | --- |",
    "```"
  ].join("\n");
  const blocks = parseMarkdownBlocks(markdown);

  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "code");
  assert.doesNotMatch(renderMarkdown(markdown), /<table>/);
});

test("dashboard markdown escapes html while rendering basic inline formatting", () => {
  const html = renderMarkdown("**OK** `<script>` <img src=x>");

  assert.match(html, /<strong>OK<\/strong>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img src=x&gt;/);
});

test("dashboard markdown keeps unordered and ordered lists separate", () => {
  const html = renderMarkdown([
    "- A",
    "- B",
    "1. First",
    "2. Second"
  ].join("\n"));

  assert.match(html, /<ul><li>A<\/li><li>B<\/li><\/ul>/);
  assert.match(html, /<ol><li>First<\/li><li>Second<\/li><\/ol>/);
});

test("dashboard markdown renders links images task lists and blockquotes", () => {
  const html = renderMarkdown([
    "> 重要提示",
    ">",
    "> - [x] 已完成",
    "> - [ ] 待确认",
    "",
    "查看 [报告](https://example.test/report?a=1&b=2) 和 ![图表](chart.png)。"
  ].join("\n"));

  assert.match(html, /<blockquote>/);
  assert.match(html, /class="task-list-item"/);
  assert.match(html, /type="checkbox" disabled checked/);
  assert.match(html, /href="https:\/\/example.test\/report\?a=1&amp;b=2"/);
  assert.match(html, /class="md-image-button"/);
  assert.match(html, /data-image-src="chart.png"/);
});

test("dashboard markdown resolves local links and images relative to previewed document", () => {
  const html = renderMarkdown([
    "查看 [原始数据](data/result.csv) 和 ![图表](./images/chart.png)。",
    "",
    "> 附件 [说明](notes.md)",
    "",
    "已生成 [完整报告](reports/round-1/final.md)。"
  ].join("\n"), { basePath: "reports/round-1" });

  assert.match(html, /class="file-link"/);
  assert.match(html, /data-file="reports\/round-1\/data\/result.csv"/);
  assert.match(html, /data-image-src="reports\/round-1\/images\/chart.png"/);
  assert.match(html, /data-file="reports\/round-1\/notes.md"/);
  assert.match(html, /data-file="reports\/round-1\/final.md"/);
  assert.doesNotMatch(html, /reports\/round-1\/reports\/round-1\/final.md/);
  assert.doesNotMatch(html, /href="data\/result.csv"/);
});

test("dashboard markdown keeps unknown bare domains out of local file links", () => {
  const html = renderMarkdown("[站点](example.com)");

  assert.doesNotMatch(html, /example.com/);
  assert.doesNotMatch(html, /class="file-link"/);
});

test("dashboard markdown allows data images only for image syntax", () => {
  const html = renderMarkdown([
    "[bad](data:image/svg+xml;base64,PHN2Zy8+)",
    "![inline](data:image/png;base64,AAAA)",
    "![](chart.png)"
  ].join("\n"));

  assert.doesNotMatch(html, /href="data:image/);
  assert.match(html, /data-image-src="data:image\/png;base64,AAAA"/);
  assert.match(html, /aria-label="打开  大图"/);
});

test("dashboard markdown rejects unsafe links and highlights diff code", () => {
  const html = renderMarkdown([
    "[bad](javascript:alert(1))",
    "",
    "```diff",
    "@@ section",
    "-old",
    "+new",
    "```"
  ].join("\n"));

  assert.doesNotMatch(html, /javascript:/);
  assert.doesNotMatch(html, /<a /);
  assert.match(html, /class="md-copy-code"/);
  assert.doesNotMatch(html, /data-code=/);
  assert.match(html, /class="diff-hunk"/);
  assert.match(html, /class="diff-del"/);
  assert.match(html, /class="diff-add"/);
});

test("dashboard markdown emits math placeholders for inline and block formulas", () => {
  const html = renderMarkdown([
    "实验公式 $E = mc^2$ 如下：",
    "",
    "$$",
    "\\int_0^1 x^2 dx = \\frac{1}{3}",
    "$$"
  ].join("\n"));

  assert.match(html, /class="md-math-inline"/);
  assert.match(html, /data-math-source="E = mc\^2"/);
  assert.match(html, /class="md-math-block"/);
  assert.match(html, /data-math-display="true"/);
  assert.match(html, /\\int_0\^1 x\^2 dx = \\frac/);
});

test("dashboard markdown emits mermaid and structured data placeholders", () => {
  const html = renderMarkdown([
    "```mermaid",
    "flowchart TD",
    "A-->B",
    "```",
    "",
    "```json",
    "{\"ok\":true}",
    "```",
    "",
    "```csv",
    "name,value",
    "sample,12",
    "```"
  ].join("\n"));

  assert.match(html, /class="md-mermaid-frame"/);
  assert.match(html, /data-mermaid-source="flowchart TD/);
  assert.match(html, /class="md-data-frame"/);
  assert.match(html, /data-data-kind="json"/);
  assert.match(html, /data-data-kind="csv"/);
  assert.match(html, /JSON 数据预览/);
  assert.match(html, /CSV 数据预览/);
});

test("dashboard markdown emits a toc for long heading-rich content", () => {
  const html = renderMarkdown([
    "## 背景",
    "内容",
    "## 方法",
    "内容",
    "### 指标",
    "内容",
    "## 结论",
    "内容"
  ].join("\n"));

  assert.match(html, /class="md-toc"/);
  assert.match(html, /目录 · 4 节/);
  assert.match(html, /class="md-toc-list"/);
  assert.match(html, /class="md-toc-item md-toc-level-3"/);
  assert.doesNotMatch(html, /<ol>/);
  assert.doesNotMatch(html, /<li/);
  assert.match(html, /href="#md-\d+-/);
  assert.match(html, /id="md-\d+-/);
});

test("dashboard markdown toc keeps existing numbered heading text clean", () => {
  const html = renderMarkdown([
    "# 🧪 Dashboard WebUI 富内容渲染测试",
    "内容",
    "## 1. KaTeX 数学公式",
    "内容",
    "## 6. 长内容目录 / 锚点导航",
    "内容",
    "### 6.1 引言",
    "内容",
    "### 6.8 附录",
    "内容",
    "## ✅ 渲染测试总结",
    "内容"
  ].join("\n"));

  assert.match(html, /class="md-toc"/);
  assert.match(html, />6\.8 附录<\/a>/);
  assert.doesNotMatch(html, /15\.6\.8/);
  assert.doesNotMatch(html, /<ol>/);
});

test("dashboard markdown lightweight mode skips heavy rich render placeholders", () => {
  const html = renderMarkdown([
    "## 背景",
    "",
    "| 指标 | 数值 |",
    "| --- | --- |",
    "| 样本 | 12 |",
    "",
    "公式 $E = mc^2$：",
    "",
    "$$",
    "\\int_0^1 x^2 dx",
    "$$",
    "",
    "```mermaid",
    "flowchart TD",
    "A-->B",
    "```",
    "",
    "```json",
    "{\"ok\":true}",
    "```",
    "",
    "![图表](chart.png)"
  ].join("\n"), { lightweight: true });

  assert.doesNotMatch(html, /<table>/);
  assert.doesNotMatch(html, /class="md-mermaid-frame"/);
  assert.doesNotMatch(html, /class="md-data-frame"/);
  assert.doesNotMatch(html, /class="md-math-inline"/);
  assert.doesNotMatch(html, /class="md-math-block"/);
  assert.doesNotMatch(html, /class="md-image-button"/);
  assert.doesNotMatch(html, /class="md-toc"/);
  assert.match(html, /class="md-draft-plain"/);
  assert.match(html, /表格预览/);
  assert.match(html, /mermaid 预览/);
  assert.match(html, /json 预览/);
  assert.match(html, /公式预览/);
  assert.match(html, /class="md-draft-media"/);
});

test("dashboard markdown accepts compact table alignment separators", () => {
  const html = renderMarkdown([
    "⑧ Todo List 完整生命周期",
    "| # | 任务名称 | pending | in_progress | completed |",
    "|:-:|---------|:-------:|:-----------:|:---------:|",
    "| 1 | KaTeX 公式渲染测试 | ✅ | ✅ | ✅ |",
    "| 2 | Mermaid 流程图渲染测试 | ✅ | ✅ | ✅ |"
  ].join("\n"));

  assert.match(html, /<table>/);
  assert.match(html, /<th class="align-center">#<\/th>/);
  assert.match(html, /<th>任务名称<\/th>/);
  assert.match(html, /<td>KaTeX 公式渲染测试<\/td>/);
});
