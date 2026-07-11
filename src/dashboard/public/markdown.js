let renderInstanceCounter = 0;
const MAX_INLINE_DATA_IMAGE_BYTES = 2 * 1024 * 1024;
const LOCAL_FILE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg",
  "pdf",
  "md", "markdown", "txt", "log",
  "json", "csv", "tsv", "yaml", "yml",
  "js", "mjs", "cjs", "ts", "tsx", "jsx", "css", "html", "xml",
  "py", "ps1", "cmd", "sh", "java", "c", "cpp", "h", "hpp", "cs", "go", "rs", "php", "rb", "sql", "toml", "ini",
  "doc", "docx", "xls", "xlsx", "ppt", "pptx"
]);

export function renderMarkdown(value, options = {}) {
  const blocks = parseMarkdownBlocks(value);
  if (blocks.length === 0) {
    return "";
  }
  const context = createRenderContext(blocks, value, options);
  const body = blocks.map((block) => renderBlock(block, context)).join("");
  return context.includeToc ? `${renderToc(context.headings)}${body}` : body;
}

export function parseMarkdownBlocks(value) {
  const lines = String(value ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let paragraph = [];
  let list = null;
  let code = null;
  let math = null;

  function flushParagraph() {
    if (paragraph.length > 0) {
      blocks.push({ type: "paragraph", text: paragraph.join("\n") });
      paragraph = [];
    }
  }

  function flushList() {
    if (list?.items?.length) {
      blocks.push(list);
    }
    list = null;
  }

  function flushOpenText() {
    flushParagraph();
    flushList();
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = line.match(/^```([^`]*)\s*$/);
    const mathFence = line.match(/^\s*\$\$\s*$/);
    if (math) {
      if (mathFence) {
        blocks.push(math);
        math = null;
      } else {
        math.text.push(line);
      }
      continue;
    }
    if (code) {
      if (fence) {
        blocks.push(code);
        code = null;
      } else {
        code.text.push(line);
      }
      continue;
    }
    if (mathFence) {
      flushOpenText();
      math = { type: "math", display: true, text: [] };
      continue;
    }
    if (fence) {
      flushOpenText();
      code = { type: "code", language: normalizeCodeLanguage(fence[1]), text: [] };
      continue;
    }
    if (/^\s*$/.test(line)) {
      flushOpenText();
      continue;
    }

    const table = readTable(lines, index);
    if (table) {
      flushOpenText();
      blocks.push(table.block);
      index = table.endIndex;
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      flushOpenText();
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2].trim() });
      continue;
    }

    const listItem = line.match(/^\s*[-*]\s+(.+)$/);
    if (listItem) {
      flushParagraph();
      if (!list || list.ordered) {
        flushList();
        list = { type: "list", ordered: false, items: [] };
      }
      list.items.push(parseListItem(listItem[1]));
      continue;
    }

    const orderedItem = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (orderedItem) {
      flushParagraph();
      if (!list || !list.ordered) {
        flushList();
        list = { type: "list", ordered: true, items: [] };
      }
      list.items.push(parseListItem(orderedItem[1]));
      continue;
    }

    const blockquote = readBlockquote(lines, index);
    if (blockquote) {
      flushOpenText();
      blocks.push(blockquote.block);
      index = blockquote.endIndex;
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  if (code) {
    blocks.push(code);
  }
  if (math) {
    blocks.push(math);
  }
  flushOpenText();
  return blocks;
}

function createRenderContext(blocks, source, options = {}) {
  const lightweight = options.lightweight === true;
  const instance = `md-${++renderInstanceCounter}`;
  const headingCounts = new Map();
  const headings = [];
  for (const block of blocks) {
    if (block.type !== "heading") {
      continue;
    }
    const base = slugifyHeading(block.text) || "section";
    const count = headingCounts.get(base) ?? 0;
    headingCounts.set(base, count + 1);
    const id = `${instance}-${base}${count > 0 ? `-${count + 1}` : ""}`;
    block.id = id;
    headings.push({
      id,
      level: block.level,
      text: block.text
    });
  }
  const includeToc = !lightweight &&
    options.toc !== false &&
    headings.length > 0 &&
    (headings.length >= 3 || String(source ?? "").length > 2500 || blocks.length > 12);
  return { headings, includeToc, basePath: normalizeBasePath(options.basePath), lightweight };
}

function renderToc(headings) {
  const items = headings
    .filter((heading) => heading.level <= 3)
    .map((heading) => `<a class="md-toc-item md-toc-level-${heading.level}" href="#${escapeAttribute(heading.id)}">${renderInlineText(heading.text)}</a>`)
    .join("");
  return `<details class="md-toc"><summary>目录 · ${headings.length} 节</summary><div class="md-toc-list">${items}</div></details>`;
}

function renderBlock(block, context) {
  if (block.type === "heading") {
    const id = block.id ? ` id="${escapeAttribute(block.id)}"` : "";
    return `<h${block.level}${id}>${renderInline(block.text, context)}</h${block.level}>`;
  }
  if (block.type === "table") {
    if (context.lightweight) {
      return renderPlainDraftBlock(tableBlockToMarkdown(block), "表格预览");
    }
    return renderTable(block, context);
  }
  if (block.type === "code") {
    return renderCodeBlock(block, context);
  }
  if (block.type === "math") {
    if (context.lightweight) {
      return renderPlainDraftBlock(block.text.join("\n").trim(), "公式预览");
    }
    return renderMathBlock(block);
  }
  if (block.type === "list") {
    const tag = block.ordered ? "ol" : "ul";
    const items = block.items.map((item) => renderListItem(item, context)).join("");
    return `<${tag}>${items}</${tag}>`;
  }
  if (block.type === "blockquote") {
    return `<blockquote>${renderMarkdown(block.text, { toc: false, basePath: context.basePath, lightweight: context.lightweight })}</blockquote>`;
  }
  return `<p>${renderInline(block.text, context).replace(/\n/g, "<br>")}</p>`;
}

function renderCodeBlock(block, context = {}) {
  const text = block.text.join("\n");
  if (context.lightweight) {
    const label = block.language ? `${block.language} 预览` : "代码预览";
    return renderPlainDraftBlock(text, label);
  }
  if (block.language === "mermaid") {
    return renderMermaidBlock(text);
  }
  if (isDataLanguage(block.language)) {
    return renderDataBlock(block.language, text);
  }
  const language = block.language ? `<span>${escapeHtml(block.language)}</span>` : "";
  const diff = isDiffLanguage(block.language) ? " diff-code" : "";
  const code = isDiffLanguage(block.language) ? renderDiffCode(text) : escapeHtml(text);
  return `<div class="md-code-frame"><div class="md-code-bar">${language}<button type="button" class="md-copy-code">复制</button></div><pre class="md-code${diff}"><code>${code}</code></pre></div>`;
}

function renderMathBlock(block) {
  const text = block.text.join("\n").trim();
  return `<div class="md-math-block" data-math-display="true" data-math-source="${escapeAttribute(text)}"><div class="md-rich-label">公式</div><div class="md-math-output"><code>${escapeHtml(text)}</code></div></div>`;
}

function renderMermaidBlock(text) {
  return `<div class="md-mermaid-frame"><div class="md-rich-bar"><span>流程图</span><button type="button" class="md-toggle-raw">查看原文</button></div><div class="md-mermaid-output" data-mermaid-source="${escapeAttribute(text)}">正在渲染流程图</div><pre class="md-raw-source hidden"><code>${escapeHtml(text)}</code></pre></div>`;
}

function renderDataBlock(language, text) {
  const label = dataLanguageLabel(language);
  return `<div class="md-data-frame" data-data-kind="${escapeAttribute(language)}"><div class="md-rich-bar"><span>${escapeHtml(label)}数据预览</span><button type="button" class="md-toggle-raw">查看原文</button></div><div class="md-data-output">正在整理数据预览</div><pre class="md-raw-source hidden"><code>${escapeHtml(text)}</code></pre></div>`;
}

function renderPlainDraftBlock(text, label) {
  return `<div class="md-draft-plain"><div class="md-draft-plain-label">${escapeHtml(label)}</div><pre><code>${escapeHtml(text)}</code></pre></div>`;
}

function renderDiffCode(text) {
  return text.split("\n").map((line) => {
    const escaped = escapeHtml(line);
    if (line.startsWith("+") && !line.startsWith("+++")) return `<span class="diff-add">${escaped}</span>`;
    if (line.startsWith("-") && !line.startsWith("---")) return `<span class="diff-del">${escaped}</span>`;
    if (line.startsWith("@@")) return `<span class="diff-hunk">${escaped}</span>`;
    return `<span>${escaped}</span>`;
  }).join("\n");
}

function renderListItem(item, context) {
  if (item.task) {
    return `<li class="task-list-item"><input type="checkbox" disabled${item.checked ? " checked" : ""}> <span>${renderInline(item.text, context)}</span></li>`;
  }
  return `<li>${renderInline(item.text, context)}</li>`;
}

function renderTable(block, context) {
  const headers = block.headers.map((cell, index) =>
    `<th${alignmentAttribute(block.alignments[index])}>${renderInline(cell, context)}</th>`
  ).join("");
  const rows = block.rows.map((row) => {
    const cells = block.headers.map((_, index) =>
      `<td${alignmentAttribute(block.alignments[index])}>${renderInline(row[index] ?? "", context)}</td>`
    ).join("");
    return `<tr>${cells}</tr>`;
  }).join("");
  return `<div class="md-table-wrap"><table><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function tableBlockToMarkdown(block) {
  const alignments = block.alignments.map((alignment) => {
    if (alignment === "center") return ":---:";
    if (alignment === "right") return "---:";
    if (alignment === "left") return ":---";
    return "---";
  });
  return [block.headers, alignments, ...block.rows]
    .map((row) => `| ${row.map((cell) => String(cell ?? "").replace(/\|/g, "\\|")).join(" | ")} |`)
    .join("\n");
}

function alignmentAttribute(value) {
  return value ? ` class="align-${value}"` : "";
}

function readTable(lines, startIndex) {
  if (startIndex + 1 >= lines.length) {
    return null;
  }
  const header = parseTableRow(lines[startIndex]);
  const separator = parseTableSeparator(lines[startIndex + 1]);
  if (!header || !separator || header.length !== separator.length) {
    return null;
  }
  const rows = [];
  let index = startIndex + 2;
  for (; index < lines.length; index += 1) {
    if (/^\s*$/.test(lines[index])) {
      break;
    }
    const row = parseTableRow(lines[index]);
    if (!row || row.length !== header.length) {
      break;
    }
    rows.push(row);
  }
  return {
    block: {
      type: "table",
      headers: header,
      alignments: separator,
      rows
    },
    endIndex: index - 1
  };
}

function readBlockquote(lines, startIndex) {
  if (!/^>\s?/.test(lines[startIndex] ?? "")) {
    return null;
  }
  const quote = [];
  let index = startIndex;
  for (; index < lines.length; index += 1) {
    const match = lines[index].match(/^>\s?(.*)$/);
    if (!match) {
      break;
    }
    quote.push(match[1]);
  }
  return {
    block: { type: "blockquote", text: quote.join("\n") },
    endIndex: index - 1
  };
}

function parseListItem(value) {
  const text = String(value ?? "").trim();
  const task = text.match(/^\[([ xX])\]\s+(.+)$/);
  if (task) {
    return {
      task: true,
      checked: task[1].toLowerCase() === "x",
      text: task[2].trim()
    };
  }
  return { task: false, checked: false, text };
}

function parseTableRow(line) {
  const trimmed = String(line ?? "").trim();
  if (!trimmed.includes("|")) {
    return null;
  }
  const normalized = trimmed.startsWith("|") && trimmed.endsWith("|")
    ? trimmed.slice(1, -1)
    : trimmed;
  const cells = splitTableCells(normalized).map((cell) => cell.trim());
  return cells.length >= 2 ? cells : null;
}

function parseTableSeparator(line) {
  const cells = parseTableRow(line);
  if (!cells || !cells.every((cell) => /^:?-+:?$/.test(cell.replace(/\s+/g, "")))) {
    return null;
  }
  return cells.map((cell) => {
    const marker = cell.replace(/\s+/g, "");
    if (marker.startsWith(":") && marker.endsWith(":")) return "center";
    if (marker.endsWith(":")) return "right";
    if (marker.startsWith(":")) return "left";
    return "";
  });
}

function splitTableCells(value) {
  const cells = [];
  let current = "";
  let escaped = false;
  for (const char of value) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "|") {
      cells.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current);
  return cells;
}

function renderInline(value, context) {
  const parts = String(value ?? "").split(/(`[^`]+`)/g);
  return parts.map((part) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length >= 2) {
      return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
    }
    return renderInlineMath(part, context);
  }).join("");
}

function renderInlineMath(value, context) {
  if (context.lightweight) {
    return renderInlineMarkdown(value, context);
  }
  return String(value ?? "").split(/(\$[^$\n]+\$)/g).map((part) => {
    if (/^\$[^$\n]+\$$/.test(part)) {
      const source = part.slice(1, -1).trim();
      if (!source) {
        return escapeHtml(part);
      }
      return `<span class="md-math-inline" data-math-source="${escapeAttribute(source)}"><code>${escapeHtml(source)}</code></span>`;
    }
    return renderInlineMarkdown(part, context);
  }).join("");
}

function renderInlineMarkdown(value, context) {
  return String(value ?? "").split(/(!?\[[^\]]*\]\([^)]+\))/g).map((part) => {
    const image = part.match(/^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/);
    if (image) {
      return renderImage(image[1], image[2], context);
    }
    const link = part.match(/^\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/);
    if (link) {
      return renderLink(link[1], link[2], context);
    }
    return renderInlineText(part);
  }).join("");
}

function renderInlineText(value) {
  return escapeHtml(value)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    .replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, "$1<em>$2</em>");
}

function renderLink(label, href, context) {
  const safeHref = safeUrl(href);
  if (!safeHref) {
    return renderInlineText(label);
  }
  const resolvedHref = resolveRelativeUrl(safeHref, context?.basePath);
  if (isLocalWorkspaceUrl(resolvedHref)) {
    return `<button type="button" class="file-link" data-file="${escapeAttribute(resolvedHref)}" title="${escapeAttribute(resolvedHref)}">${renderInlineText(label)}</button>`;
  }
  return `<a href="${escapeAttribute(resolvedHref)}" target="_blank" rel="noopener noreferrer">${renderInlineText(label)}</a>`;
}

function renderImage(alt, src, context) {
  const safeSrc = safeUrl(src, { allowDataImage: true });
  if (!safeSrc) {
    return renderInlineText(alt);
  }
  const resolvedSrc = resolveRelativeUrl(safeSrc, context?.basePath);
  if (resolvedSrc.startsWith("/") && !resolvedSrc.startsWith("/api/files/raw?")) {
    return renderInlineText(alt);
  }
  if (context?.lightweight) {
    return `<span class="md-draft-media">${renderInlineText(alt || "图片")} · ${escapeHtml(resolvedSrc)}</span>`;
  }
  if (/^https?:\/\//i.test(resolvedSrc)) {
    const host = remoteImageHost(resolvedSrc);
    const label = alt || "远程图片";
    return `<span class="md-draft-media md-remote-media"><span>${renderInlineText(label)} · ${escapeHtml(host)}</span> <a href="${escapeAttribute(resolvedSrc)}" target="_blank" rel="noopener noreferrer">${escapeHtml(resolvedSrc)}</a></span>`;
  }
  const escapedAlt = escapeAttribute(alt);
  return `<button type="button" class="md-image-button" data-image-src="${escapeAttribute(resolvedSrc)}" data-image-alt="${escapedAlt}" aria-label="打开 ${escapedAlt} 大图"><img src="${escapeAttribute(resolvedSrc)}" alt="${escapedAlt}"></button>`;
}

function safeUrl(value, options = {}) {
  const text = String(value ?? "").trim();
  if (options.allowDataImage && /^data:/i.test(text)) {
    return safeDataImageUrl(text);
  }
  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      return url.protocol === "http:" || url.protocol === "https:" ? text : "";
    } catch {
      return "";
    }
  }
  if (/^(\/|\.\/|\.\.\/)/i.test(text) || isLikelyLocalFileUrl(text)) {
    return text;
  }
  return "";
}

function safeDataImageUrl(value) {
  const match = String(value ?? "").match(/^data:image\/(png|jpeg|gif|webp);base64,([a-z0-9+/]+={0,2})$/i);
  if (!match || match[2].length % 4 !== 0) {
    return "";
  }
  const padding = match[2].endsWith("==") ? 2 : match[2].endsWith("=") ? 1 : 0;
  const decodedBytes = (match[2].length / 4) * 3 - padding;
  if (decodedBytes <= 0 || decodedBytes > MAX_INLINE_DATA_IMAGE_BYTES) {
    return "";
  }
  let prefix;
  try {
    prefix = atob(match[2].slice(0, 32));
  } catch {
    return "";
  }
  const bytes = Array.from(prefix, (char) => char.charCodeAt(0));
  if (!matchesBitmapSignature(match[1].toLowerCase(), bytes)) {
    return "";
  }
  return String(value);
}

function matchesBitmapSignature(kind, bytes) {
  if (kind === "png") {
    return startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  }
  if (kind === "jpeg") {
    return startsWithBytes(bytes, [0xff, 0xd8, 0xff]);
  }
  if (kind === "gif") {
    return startsWithBytes(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || startsWithBytes(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
  }
  return startsWithBytes(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWithBytes(bytes.slice(8), [0x57, 0x45, 0x42, 0x50]);
}

function startsWithBytes(value, expected) {
  return expected.every((byte, index) => value[index] === byte);
}

function remoteImageHost(value) {
  try {
    return new URL(value).host || "remote";
  } catch {
    return "remote";
  }
}

function isLikelyLocalFileUrl(value) {
  if (!/^[A-Za-z0-9_.\-\/\\]+\.[A-Za-z0-9]{1,8}$/i.test(value)) {
    return false;
  }
  const extension = value.split(".").pop()?.toLowerCase() ?? "";
  return LOCAL_FILE_EXTENSIONS.has(extension);
}

function normalizeBasePath(value) {
  const text = String(value ?? "").trim().replace(/\\/g, "/");
  if (!text || text.startsWith("/") || text.startsWith("../") || text.includes("://")) {
    return "";
  }
  return text.replace(/^\.\/+/, "").replace(/\/+$/, "");
}

function resolveRelativeUrl(url, basePath = "") {
  const text = String(url ?? "").trim().replace(/\\/g, "/");
  if (!text || !basePath || /^(https?:|\/|data:image\/)/i.test(text)) {
    return text;
  }
  if (isWorkspaceRelativeToBase(text, basePath)) {
    return normalizeRelativePath(text);
  }
  return normalizeRelativePath(`${basePath}/${text}`);
}

function isLocalWorkspaceUrl(value) {
  const text = String(value ?? "").trim();
  return Boolean(text) && !/^(https?:|\/|data:image\/|#)/i.test(text);
}

function normalizeRelativePath(value) {
  const parts = String(value ?? "").replace(/\\/g, "/").split("/");
  const stack = [];
  for (const part of parts) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      if (stack.length > 0 && stack[stack.length - 1] !== "..") {
        stack.pop();
      } else {
        stack.push(part);
      }
      continue;
    }
    stack.push(part);
  }
  return stack.join("/");
}

function isWorkspaceRelativeToBase(value, basePath = "") {
  const firstBaseSegment = String(basePath ?? "").split("/").filter(Boolean)[0];
  return Boolean(firstBaseSegment) && String(value ?? "").startsWith(`${firstBaseSegment}/`);
}

function normalizeCodeLanguage(value) {
  return String(value ?? "").trim().split(/\s+/)[0].toLowerCase();
}

function isDiffLanguage(value) {
  return ["diff", "patch"].includes(String(value ?? "").toLowerCase());
}

function isDataLanguage(value) {
  return ["json", "yaml", "yml", "csv", "tsv"].includes(String(value ?? "").toLowerCase());
}

function dataLanguageLabel(value) {
  const language = String(value ?? "").toLowerCase();
  if (language === "yml") return "YAML ";
  return language ? `${language.toUpperCase()} ` : "";
}

function slugifyHeading(value) {
  const ascii = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[`*_~()[\]{}:;,.!?/\\|"'<>]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (ascii) {
    return ascii.slice(0, 64);
  }
  const encoded = Array.from(String(value ?? "").trim())
    .slice(0, 24)
    .map((char) => char.codePointAt(0)?.toString(16) ?? "")
    .filter(Boolean)
    .join("-");
  return encoded ? `section-${encoded}` : "section";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}
