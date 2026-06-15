const MAX_TREE_DEPTH = 2;
const MAX_TREE_ITEMS = 80;
const MAX_TABLE_ROWS = 200;
const MAX_CELL_CHARS = 160;

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
    return success(`${summaryForValue(value)} · JSON`, renderTree(value));
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
    return success(`${summaryForValue(value)} · YAML`, renderTree(value));
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
  const headers = rows[0].map((cell, index) => cell || `列 ${index + 1}`);
  const bodyRows = rows.slice(1, MAX_TABLE_ROWS + 1);
  const truncated = rows.length - 1 > bodyRows.length;
  const table = [
    `<div class="data-table-wrap"><table class="data-table"><thead><tr>${headers.map((header) => `<th>${escapeHtml(truncateCell(header))}</th>`).join("")}</tr></thead><tbody>`,
    bodyRows.map((row) => `<tr>${headers.map((_, index) => `<td>${escapeHtml(truncateCell(row[index] ?? ""))}</td>`).join("")}</tr>`).join(""),
    `</tbody></table></div>`,
    truncated ? `<div class="data-note">已显示前 ${bodyRows.length} 行，共 ${rows.length - 1} 行数据。</div>` : ""
  ].join("");
  return success(`${rows.length - 1} 行 · ${headers.length} 列 · ${label}`, table, { tsv: toTsv(rows) });
}

function renderTree(value, depth = 0, path = "root") {
  if (value === null || typeof value !== "object") {
    return `<span class="data-scalar ${scalarClass(value)}">${escapeHtml(formatScalar(value))}</span>`;
  }
  const isArray = Array.isArray(value);
  const entries = isArray ? value.map((item, index) => [String(index), item]) : Object.entries(value);
  const count = entries.length;
  const visible = entries.slice(0, MAX_TREE_ITEMS);
  const summary = isArray ? `数组 · ${count} 项` : `对象 · ${count} 项`;
  const open = depth < MAX_TREE_DEPTH ? " open" : "";
  const children = visible.map(([key, item]) => `
    <div class="data-tree-row">
      <span class="data-key">${escapeHtml(isArray ? `[${key}]` : key)}</span>
      <span class="data-value">${renderTree(item, depth + 1, `${path}.${key}`)}</span>
    </div>
  `).join("");
  const overflow = count > visible.length ? `<div class="data-note">还有 ${count - visible.length} 项已折叠。</div>` : "";
  return `<details class="data-node"${open}><summary>${escapeHtml(summary)}</summary><div class="data-tree">${children}${overflow}</div></details>`;
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

function toTsv(rows) {
  return rows.map((row) => row.map((cell) => String(cell ?? "").replace(/\t/g, " ").replace(/\r?\n/g, " ")).join("\t")).join("\n");
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
