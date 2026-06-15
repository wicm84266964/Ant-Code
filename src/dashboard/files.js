import fs from "node:fs/promises";
import { statSync } from "node:fs";
import path from "node:path";
import { parseDocumentBuffer } from "../tools/document-tools.js";

const DATA_EXTENSIONS = new Set([".json", ".csv", ".tsv", ".yaml", ".yml"]);
const TEXT_EXTENSIONS = new Set([".txt", ".log", ".json", ".csv", ".tsv", ".md", ".markdown", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".css", ".html", ".xml", ".yaml", ".yml", ".py", ".ps1", ".cmd", ".sh", ".java", ".c", ".cpp", ".h", ".hpp", ".cs", ".go", ".rs", ".php", ".rb", ".sql", ".toml", ".ini"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const PREVIEWABLE_IMAGE_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ".svg"]);
const OFFICE_EXTENSIONS = new Set([".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx"]);
const PREVIEWABLE_OFFICE_EXTENSIONS = new Set([".docx", ".xlsx", ".pptx"]);
const MAX_TEXT_BYTES = 512 * 1024;
const MAX_RAW_BYTES = 20 * 1024 * 1024;
const MAX_OFFICE_BYTES = 10 * 1024 * 1024;
const MAX_OFFICE_PREVIEW_CHARS = 24 * 1024;
const MAX_TABLE_ROWS = 500;
const MAX_TABLE_COLUMNS = 80;
const MAX_TABLE_TEXT_BYTES = 1024 * 1024;

/**
 * @param {string} cwd
 * @param {string} requestedPath
 */
export async function previewFile(cwd, requestedPath) {
  const resolved = resolveWorkspaceFile(cwd, requestedPath);
  if (!resolved.ok) {
    return resolved;
  }
  const stat = await fs.stat(resolved.path).catch(() => null);
  if (!stat || !stat.isFile()) {
    return { ok: false, status: 404, error: "文件不存在或不是普通文件" };
  }
  const ext = path.extname(resolved.path).toLowerCase();
  const base = baseFile(resolved.path, cwd, stat);
  if (PREVIEWABLE_IMAGE_EXTENSIONS.has(ext)) {
    return { ok: true, file: { ...base, kind: "image", rawUrl: rawUrl(base.relativePath) } };
  }
  if (ext === ".pdf") {
    return { ok: true, file: { ...base, kind: "pdf", rawUrl: rawUrl(base.relativePath) } };
  }
  if (PREVIEWABLE_OFFICE_EXTENSIONS.has(ext)) {
    return previewOfficeFile(resolved.path, base, stat, ext);
  }
  if (OFFICE_EXTENSIONS.has(ext)) {
    return { ok: true, file: { ...base, kind: "office", rawUrl: rawUrl(base.relativePath), message: "第一版提供文件卡片和打开入口，在线预览后续增强。" } };
  }
  if ((ext === ".csv" || ext === ".tsv") && stat.size <= MAX_TABLE_TEXT_BYTES) {
    return previewDelimitedFile(resolved.path, base, ext);
  }
  if (TEXT_EXTENSIONS.has(ext) || stat.size <= MAX_TEXT_BYTES) {
    if (stat.size > MAX_TEXT_BYTES) {
      return { ok: true, file: { ...base, kind: "text", truncated: true, content: await readTextHead(resolved.path) } };
    }
    return { ok: true, file: { ...base, kind: fileKindForTextExtension(ext), content: await fs.readFile(resolved.path, "utf8") } };
  }
  return { ok: true, file: { ...base, kind: "binary", rawUrl: rawUrl(base.relativePath), message: "二进制文件不在网页中直接预览。" } };
}

async function previewDelimitedFile(filePath, base, ext) {
  const content = await fs.readFile(filePath, "utf8");
  const table = parseDelimitedTable(content, ext === ".tsv" ? "\t" : ",");
  return {
    ok: true,
    file: {
      ...base,
      kind: "table-preview",
      tableKind: ext.slice(1),
      content,
      table,
      truncated: table.truncatedRows || table.truncatedColumns
    }
  };
}

async function previewOfficeFile(filePath, base, stat, ext) {
  const raw = {
    ...base,
    kind: "office",
    rawUrl: rawUrl(base.relativePath)
  };
  if (stat.size > MAX_OFFICE_BYTES) {
    return {
      ok: true,
      file: {
        ...raw,
        message: "文件较大，右侧栏只提供打开入口。"
      }
    };
  }
  try {
    const parsed = parseDocumentBuffer(await fs.readFile(filePath), ext);
    if (!parsed.supported || !String(parsed.content ?? "").trim()) {
      return {
        ok: true,
        file: {
          ...raw,
          message: "未能抽取可预览文本，仍可打开文件查看。"
        }
      };
    }
    const content = String(parsed.content ?? "");
    const truncated = content.length > MAX_OFFICE_PREVIEW_CHARS;
    return {
      ok: true,
      file: {
        ...raw,
        kind: "office-preview",
        officeKind: parsed.kind,
        content: truncated ? content.slice(0, MAX_OFFICE_PREVIEW_CHARS) : content,
        table: officeTablePreview(parsed),
        truncated,
        notes: parsed.notes ?? []
      }
    };
  } catch {
    return {
      ok: true,
      file: {
        ...raw,
        message: "文件解析失败，右侧栏保留打开入口。"
      }
    };
  }
}

function officeTablePreview(parsed) {
  if (parsed.kind !== "xlsx" || !Array.isArray(parsed.sheets)) {
    return null;
  }
  const sheets = parsed.sheets.map((sheet) => ({
    name: sheet.name,
    source: sheet.source,
    rows: trimTableRows(sheet.rows ?? [], MAX_TABLE_ROWS, MAX_TABLE_COLUMNS),
    truncatedRows: Boolean(sheet.truncatedRows || (sheet.rows?.length ?? 0) > MAX_TABLE_ROWS),
    truncatedColumns: Boolean(sheet.truncatedColumns || maxColumnCount(sheet.rows ?? []) > MAX_TABLE_COLUMNS)
  })).filter((sheet) => sheet.rows.length > 0);
  return {
    kind: "xlsx",
    sheets,
    totalSheets: parsed.sheets.length
  };
}

function parseDelimitedTable(content, delimiter) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  let truncatedRows = false;
  let truncatedColumns = false;
  let ignoredRows = 0;
  const text = String(content ?? "");
  const pushRow = (nextRow) => {
    if (rows.length >= MAX_TABLE_ROWS) {
      ignoredRows += 1;
      truncatedRows = true;
      return;
    }
    if (nextRow.length > MAX_TABLE_COLUMNS) {
      truncatedColumns = true;
    }
    rows.push(nextRow);
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === "\"" && text[index + 1] === "\"") {
        cell += "\"";
        index += 1;
      } else if (char === "\"") {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === "\"") {
      quoted = true;
    } else if (char === delimiter) {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      pushRow(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }
  if (cell || row.length > 0) {
    row.push(cell);
    pushRow(row);
  }
  truncatedColumns = rows.some((item) => item.length > MAX_TABLE_COLUMNS) || truncatedColumns;
  return {
    kind: delimiter === "\t" ? "tsv" : "csv",
    sheets: [{
      name: delimiter === "\t" ? "TSV" : "CSV",
      rows: trimTableRows(rows, MAX_TABLE_ROWS, MAX_TABLE_COLUMNS),
      truncatedRows,
      truncatedColumns,
      ignoredRows
    }],
    totalSheets: 1
  };
}

function trimTableRows(rows, maxRows, maxColumns) {
  return rows.slice(0, maxRows).map((row) => row.slice(0, maxColumns).map((value) => String(value ?? "")));
}

function maxColumnCount(rows) {
  return rows.reduce((max, row) => Math.max(max, row.length), 0);
}

/**
 * @param {string} cwd
 * @param {string} requestedPath
 */
export async function readRawFile(cwd, requestedPath) {
  const resolved = resolveWorkspaceFile(cwd, requestedPath);
  if (!resolved.ok) {
    return resolved;
  }
  const stat = await fs.stat(resolved.path).catch(() => null);
  if (!stat || !stat.isFile()) {
    return { ok: false, status: 404, error: "文件不存在或不是普通文件" };
  }
  if (stat.size > MAX_RAW_BYTES) {
    return { ok: false, status: 413, error: "文件过大，已阻止内嵌预览" };
  }
  return {
    ok: true,
    path: resolved.path,
    contentType: contentTypeForPath(resolved.path),
    bytes: await fs.readFile(resolved.path)
  };
}

/**
 * @param {Record<string, any>} session
 * @param {string} finalOutput
 */
export function collectSessionFiles(session, finalOutput = "") {
  const cwd = session?.cwd ?? process.cwd();
  const items = [];
  const changes = Array.isArray(session?.workflow?.changes) ? session.workflow.changes : [];
  for (const change of changes) {
    addFile(items, cwd, change.path, {
      source: change.created ? "created" : change.edited ? "edited" : "changed",
      toolName: change.toolName ?? null
    });
  }
  for (const candidate of extractPaths(finalOutput)) {
    addFile(items, cwd, candidate, { source: "mentioned" });
  }
  return dedupeFiles(items);
}

/**
 * @param {string} cwd
 * @param {string} requestedPath
 */
export function resolveWorkspaceFile(cwd, requestedPath) {
  const root = path.resolve(cwd);
  const text = String(requestedPath ?? "").trim();
  if (!text) {
    return { ok: false, status: 400, error: "缺少文件路径" };
  }
  const resolved = path.resolve(root, text);
  if (!isInside(root, resolved)) {
    return { ok: false, status: 403, error: "第一版只允许预览当前工作区内文件" };
  }
  return { ok: true, path: resolved };
}

/**
 * @param {string} cwd
 * @param {string} target
 */
export function fileSummary(cwd, target) {
  const resolved = path.resolve(cwd, target);
  return {
    path: resolved,
    relativePath: path.relative(cwd, resolved) || path.basename(resolved),
    name: path.basename(resolved),
    kind: kindForPath(resolved)
  };
}

function baseFile(filePath, cwd, stat) {
  return {
    path: filePath,
    relativePath: path.relative(cwd, filePath) || path.basename(filePath),
    name: path.basename(filePath),
    extension: path.extname(filePath).toLowerCase(),
    size: stat.size,
    modifiedAt: stat.mtime.toISOString()
  };
}

async function readTextHead(filePath) {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(MAX_TEXT_BYTES);
    const read = await handle.read(buffer, 0, MAX_TEXT_BYTES, 0);
    return buffer.subarray(0, read.bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function rawUrl(relativePath) {
  return `/api/files/raw?path=${encodeURIComponent(relativePath)}`;
}

function contentTypeForPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".pdf") return "application/pdf";
  return "application/octet-stream";
}

function kindForPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (PREVIEWABLE_IMAGE_EXTENSIONS.has(ext)) return "image";
  if (ext === ".pdf") return "pdf";
  if (ext === ".md" || ext === ".markdown") return "markdown";
  if (DATA_EXTENSIONS.has(ext)) return "data";
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  if (OFFICE_EXTENSIONS.has(ext)) return "office";
  return "file";
}

function fileKindForTextExtension(ext) {
  if (ext === ".md" || ext === ".markdown") {
    return "markdown";
  }
  if (DATA_EXTENSIONS.has(ext)) {
    return "data";
  }
  return "text";
}

function extractPaths(text) {
  const matches = String(text ?? "").match(/(?:[A-Za-z]:[\\/][^\s"'<>|]+|(?:\.{1,2}[\\/])?[A-Za-z0-9_.-]+[\\/][A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8}|[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8})/g);
  return matches ?? [];
}

function addFile(items, cwd, target, meta = {}) {
  const value = String(target ?? "").trim();
  if (!value) {
    return;
  }
  const resolved = path.isAbsolute(value) ? value : path.resolve(cwd, value);
  if (!isInside(cwd, resolved)) {
    return;
  }
  if (!fileExists(resolved)) {
    return;
  }
  items.push({
    ...fileSummary(cwd, path.relative(cwd, resolved)),
    ...meta
  });
}

function dedupeFiles(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = item.path.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(item);
  }
  return out;
}

function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function fileExists(filePath) {
  try {
    const stat = statSync(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}
