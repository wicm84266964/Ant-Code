const INITIAL_TREE_DEPTH = 2;
const MAX_TREE_DEPTH = 12;
const MAX_TREE_ITEMS = 80;
const MAX_TREE_NODES = 400;
const MAX_TABLE_ROWS = 200;
const MAX_TABLE_COLUMNS = 50;
const MAX_CELL_CHARS = 160;
const MAX_COPY_BYTES = 256 * 1024;

export function renderStructuredData(kind, source, vendor = {}) {
  const normalized = String(kind ?? "").toLowerCase();
  if (normalized === "json") {
    return renderJson(source);
  }
  if (normalized === "yaml" || normalized === "yml") {
    return renderYaml(source, vendor);
  }
  if (normalized === "csv" || normalized === "tsv") {
    return renderDelimited(source, normalized === "tsv" ? "\t" : ",", normalized.toUpperCase());
  }
  return failure("暂不支持这种数据格式");
}

function renderJson(source) {
  try {
    const value = JSON.parse(String(source ?? ""));
    const tree = createTreeRenderer(value);
    return success(`${summaryForValue(value)} · JSON`, tree.html, {
      expandTreeNode: tree.expand
    });
  } catch (error) {
    return failure(`JSON 解析失败：${errorMessage(error)}`);
  }
}

function renderYaml(source, vendor) {
  try {
    if (typeof vendor.parseYaml !== "function") {
      return failure("YAML 渲染器尚未加载");
    }
    const value = vendor.parseYaml(String(source ?? ""));
    const tree = createTreeRenderer(value);
    return success(`${summaryForValue(value)} · YAML`, tree.html, {
      expandTreeNode: tree.expand
    });
  } catch (error) {
    return failure(`YAML 解析失败：${errorMessage(error)}`);
  }
}

function renderDelimited(source, delimiter, label) {
  const parsed = parseDelimited(source, delimiter);
  if (!parsed.ok) {
    return failure(`${label} 解析失败：${parsed.error}`);
  }
  const rows = parsed.rows;
  if (rows.length === 0) {
    return success(`0 行 · ${label}`, `<div class="data-empty">没有可预览的数据</div>`);
  }
  const allHeaders = rows[0].map((cell, index) => cell || `列 ${index + 1}`);
  const headers = allHeaders.slice(0, MAX_TABLE_COLUMNS);
  const bodyRows = rows.slice(1, MAX_TABLE_ROWS + 1);
  const rowsTruncated = rows.length - 1 > bodyRows.length;
  const columnsTruncated = allHeaders.length > headers.length;
  const copy = boundedTsv([headers, ...bodyRows.map((row) => row.slice(0, headers.length))]);
  const table = [
    `<div class="data-table-wrap"><table class="data-table"><thead><tr>${headers.map((header) => `<th>${escapeHtml(truncateCell(header))}</th>`).join("")}</tr></thead><tbody>`,
    bodyRows.map((row) => `<tr>${headers.map((_, index) => `<td>${escapeHtml(truncateCell(row[index] ?? ""))}</td>`).join("")}</tr>`).join(""),
    `</tbody></table></div>`,
    rowsTruncated ? `<div class="data-note">已显示前 ${bodyRows.length} 行，共 ${rows.length - 1} 行数据。</div>` : "",
    columnsTruncated ? `<div class="data-note">已显示前 ${headers.length} 列，共 ${allHeaders.length} 列。</div>` : "",
    copy.truncated ? `<div class="data-note">复制内容已限制为 ${formatBytes(MAX_COPY_BYTES)}。</div>` : ""
  ].join("");
  return success(`${rows.length - 1} 行 · ${allHeaders.length} 列 · ${label}`, table, { tsv: copy.text });
}

function createTreeRenderer(root) {
  const deferred = new Map();
  let nextDeferredId = 1;
  let renderedNodes = 0;

  function renderValue(value, depth, eagerUntil, ancestors = new Set()) {
    if (renderedNodes >= MAX_TREE_NODES) {
      return nodeBudgetNote();
    }
    renderedNodes += 1;
    if (value === null || typeof value !== "object") {
      return `<span class="data-scalar ${scalarClass(value)}">${escapeHtml(formatScalar(value))}</span>`;
    }
    if (ancestors.has(value)) {
      return `<span class="data-note data-cycle">检测到循环引用，已停止展开。</span>`;
    }
    if (depth >= MAX_TREE_DEPTH) {
      return `<span class="data-note data-depth-limit">已达到 ${MAX_TREE_DEPTH} 层预览上限（${escapeHtml(summaryForValue(value))}）。</span>`;
    }

    const nextAncestors = new Set(ancestors);
    nextAncestors.add(value);
    if (depth >= eagerUntil) {
      const id = `tree-${nextDeferredId}`;
      nextDeferredId += 1;
      deferred.set(id, { value, depth, ancestors: nextAncestors });
      return `<details class="data-node data-node-deferred" data-tree-node="${id}"><summary>${escapeHtml(summaryForValue(value))}</summary><div class="data-tree data-tree-placeholder"><span class="data-note">展开后加载下一层。</span></div></details>`;
    }
    return renderNode(value, depth, eagerUntil, nextAncestors, true);
  }

  function renderNode(value, depth, eagerUntil, ancestors, open) {
    const isArray = Array.isArray(value);
    const entries = isArray ? value.map((item, index) => [String(index), item]) : Object.entries(value);
    const visible = entries.slice(0, MAX_TREE_ITEMS);
    const rows = [];
    for (const [key, item] of visible) {
      if (renderedNodes >= MAX_TREE_NODES) {
        rows.push(nodeBudgetNote());
        break;
      }
      rows.push(`
        <div class="data-tree-row">
          <span class="data-key">${escapeHtml(isArray ? `[${key}]` : key)}</span>
          <span class="data-value">${renderValue(item, depth + 1, eagerUntil, ancestors)}</span>
        </div>
      `);
    }
    const overflow = entries.length > visible.length
      ? `<div class="data-note">还有 ${entries.length - visible.length} 项未渲染。</div>`
      : "";
    return `<details class="data-node"${open ? " open" : ""}><summary>${escapeHtml(summaryForValue(value))}</summary><div class="data-tree">${rows.join("")}${overflow}</div></details>`;
  }

  function expand(id) {
    const entry = deferred.get(String(id ?? ""));
    if (!entry) {
      return `<span class="data-note">该数据层已加载或不可用。</span>`;
    }
    deferred.delete(String(id));
    if (renderedNodes >= MAX_TREE_NODES) {
      return nodeBudgetNote();
    }
    const wrapper = renderNode(entry.value, entry.depth, entry.depth + 1, entry.ancestors, false);
    const match = wrapper.match(/<div class="data-tree">([\s\S]*)<\/div><\/details>$/);
    return match ? match[1] : nodeBudgetNote();
  }

  return {
    html: renderValue(root, 0, INITIAL_TREE_DEPTH),
    expand
  };
}

function nodeBudgetNote() {
  return `<span class="data-note data-node-limit">已达到 ${MAX_TREE_NODES} 个节点的预览上限。</span>`;
}

function summaryForValue(value) {
  if (Array.isArray(value)) {
    return `数组 · ${value.length} 项`;
  }
  if (value && typeof value === "object") {
    return `对象 · ${Object.keys(value).length} 字段`;
  }
  return `值 · ${typeof value}`;
}

function scalarClass(value) {
  if (value === null) return "is-null";
  if (typeof value === "number") return "is-number";
  if (typeof value === "boolean") return "is-boolean";
  return "is-string";
}

function formatScalar(value) {
  if (typeof value === "string") {
    return value.length > MAX_CELL_CHARS ? `${value.slice(0, MAX_CELL_CHARS)}...` : `"${value}"`;
  }
  return String(value);
}

function parseDelimited(source, delimiter) {
  const text = String(source ?? "").replace(/\r\n?/g, "\n");
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === "\"") {
        if (text[index + 1] === "\"") {
          cell += "\"";
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === "\"") {
      quoted = true;
      continue;
    }
    if (char === delimiter) {
      row.push(cell);
      cell = "";
      continue;
    }
    if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += char;
  }
  if (quoted) {
    return { ok: false, error: "引号没有闭合" };
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return { ok: true, rows: rows.filter((item) => item.some((cellValue) => String(cellValue).trim())) };
}

function boundedTsv(rows) {
  const lines = [];
  let bytes = 0;
  let truncated = false;
  for (const row of rows) {
    const line = row.map((cell) => truncateCell(cell).replace(/\t/g, " ").replace(/\r?\n/g, " ")).join("\t");
    const separatorBytes = lines.length > 0 ? 1 : 0;
    const lineBytes = utf8Bytes(line);
    if (bytes + separatorBytes + lineBytes > MAX_COPY_BYTES) {
      truncated = true;
      break;
    }
    lines.push(line);
    bytes += separatorBytes + lineBytes;
  }
  return { text: lines.join("\n"), truncated };
}

function utf8Bytes(value) {
  return new TextEncoder().encode(String(value ?? "")).byteLength;
}

function formatBytes(value) {
  return `${Math.round(value / 1024)} KiB`;
}

function truncateCell(value) {
  const text = String(value ?? "");
  return text.length > MAX_CELL_CHARS ? `${text.slice(0, MAX_CELL_CHARS)}...` : text;
}

function success(summary, html, extra = {}) {
  return { ok: true, summary, html, ...extra };
}

function failure(error) {
  return { ok: false, error, html: `<div class="data-error">${escapeHtml(error)}</div>` };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
