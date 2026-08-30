import fs from "node:fs/promises";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { parseDocumentBufferAsync } from "../tools/document-tools.ts";

const DATA_EXTENSIONS = new Set([".json", ".csv", ".tsv", ".yaml", ".yml"]);
const TEXT_EXTENSIONS = new Set([".txt", ".log", ".json", ".csv", ".tsv", ".md", ".markdown", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".css", ".html", ".xml", ".yaml", ".yml", ".py", ".ps1", ".cmd", ".sh", ".java", ".c", ".cpp", ".h", ".hpp", ".cs", ".go", ".rs", ".php", ".rb", ".sql", ".toml", ".ini"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const PREVIEWABLE_IMAGE_EXTENSIONS = IMAGE_EXTENSIONS;
const OFFICE_EXTENSIONS = new Set([".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx"]);
const PREVIEWABLE_OFFICE_EXTENSIONS = new Set([".docx", ".xlsx", ".pptx"]);
const MAX_TEXT_BYTES = 512 * 1024;
const MAX_RAW_BYTES = 20 * 1024 * 1024;
const MAX_OFFICE_BYTES = 10 * 1024 * 1024;
const MAX_OFFICE_PREVIEW_CHARS = 24 * 1024;
const MAX_TABLE_ROWS = 500;
const MAX_TABLE_COLUMNS = 80;
const MAX_TABLE_TEXT_BYTES = 1024 * 1024;

type WorkspaceFailure = { ok: false; status: number; error: string };
type WorkspaceResolved = { ok: true; path: string; root: string };
type WorkspaceOpened = {
  ok: true;
  path: string;
  root: string;
  stat: import("node:fs").Stats;
  handle: import("node:fs/promises").FileHandle;
};
type FileBase = {
  path: string;
  relativePath: string;
  name: string;
  extension: string;
  size: number;
  modifiedAt: string;
};
type SessionFileItem = {
  path: string;
  relativePath: string;
  name: string;
  kind: string;
  source?: string;
  toolName?: unknown;
};
type TableSheet = {
  name: string;
  source?: unknown;
  rows: string[][];
  truncatedRows?: boolean;
  truncatedColumns?: boolean;
  ignoredRows?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function errorCode(error: unknown): unknown {
  return error && typeof error === "object" && "code" in error ? error.code : undefined;
}

/**
 * @param {string} cwd
 * @param {string} requestedPath
 */
export async function previewFile(cwd: string, requestedPath: string) {
  const opened = await openWorkspaceFile(cwd, requestedPath);
  if (!opened.ok) {
    return opened;
  }
  try {
    const ext = path.extname(opened.path).toLowerCase();
    const base = baseFile(opened.path, opened.root, opened.stat);
    if (PREVIEWABLE_IMAGE_EXTENSIONS.has(ext)) {
      return { ok: true, file: { ...base, kind: "image", rawUrl: rawUrl(base.relativePath), embeddable: true } };
    }
    if (ext === ".svg") {
      return {
        ok: true,
        file: {
          ...base,
          kind: "download",
          rawUrl: rawUrl(base.relativePath),
          downloadOnly: true,
          embeddable: false,
          message: "SVG contains active content and is available only as a download."
        }
      };
    }
    if (ext === ".pdf") {
      return { ok: true, file: { ...base, kind: "pdf", rawUrl: rawUrl(base.relativePath), embeddable: true } };
    }
    if (PREVIEWABLE_OFFICE_EXTENSIONS.has(ext)) {
      const buffer = opened.stat.size > MAX_OFFICE_BYTES ? null : await opened.handle.readFile();
      return previewOfficeFile(buffer, base, opened.stat, ext);
    }
    if (OFFICE_EXTENSIONS.has(ext)) {
      return { ok: true, file: { ...base, kind: "office", rawUrl: rawUrl(base.relativePath), message: "第一版提供文件卡片和打开入口，在线预览后续增强。" } };
    }
    if ((ext === ".csv" || ext === ".tsv") && opened.stat.size <= MAX_TABLE_TEXT_BYTES) {
      return previewDelimitedFile(await opened.handle.readFile(), base, ext);
    }
    if (TEXT_EXTENSIONS.has(ext) || opened.stat.size <= MAX_TEXT_BYTES) {
      if (opened.stat.size > MAX_TEXT_BYTES) {
        return { ok: true, file: { ...base, kind: "text", truncated: true, content: await readTextHead(opened.handle) } };
      }
      return { ok: true, file: { ...base, kind: fileKindForTextExtension(ext), content: (await opened.handle.readFile()).toString("utf8") } };
    }
    return { ok: true, file: { ...base, kind: "binary", rawUrl: rawUrl(base.relativePath), downloadOnly: true, embeddable: false, message: "二进制文件不在网页中直接预览。" } };
  } finally {
    await opened.handle.close();
  }
}

function previewDelimitedFile(buffer: Buffer, base: FileBase, ext: string) {
  const content = buffer.toString("utf8");
  const table = parseDelimitedTable(content, ext === ".tsv" ? "\t" : ",");
  return {
    ok: true,
    file: {
      ...base,
      kind: "table-preview",
      tableKind: ext.slice(1),
      content,
      table,
      truncated: Boolean((table as { truncatedRows?: boolean; truncatedColumns?: boolean }).truncatedRows
        || (table as { truncatedRows?: boolean; truncatedColumns?: boolean }).truncatedColumns)
    }
  };
}

async function previewOfficeFile(buffer: Buffer | null, base: FileBase, stat: import("node:fs").Stats, ext: string) {
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
    if (!buffer) {
      throw Object.assign(new Error("Office preview buffer is unavailable"), { code: "OFFICE_PARSE_FAILED" });
    }
    const parsed = await parseDocumentBufferAsync(buffer, ext) as Record<string, unknown>;
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
  } catch (error) {
    return {
      ok: true,
      file: {
        ...raw,
        parseErrorCode: String(errorCode(error) ?? "OFFICE_PARSE_FAILED"),
        message: "文件解析失败，右侧栏保留打开入口。"
      }
    };
  }
}

function officeTablePreview(parsed: Record<string, unknown>) {
  if (parsed.kind !== "xlsx" || !Array.isArray(parsed.sheets)) {
    return null;
  }
  const sheets = (parsed.sheets as unknown[]).map((sheet: unknown) => {
    const record = isRecord(sheet) ? sheet : {};
    const rows: unknown[] = Array.isArray(record.rows) ? record.rows : [];
    return {
      name: record.name,
      source: record.source,
      rows: trimTableRows(rows, MAX_TABLE_ROWS, MAX_TABLE_COLUMNS),
      truncatedRows: Boolean(record.truncatedRows) || rows.length > MAX_TABLE_ROWS,
      truncatedColumns: Boolean(record.truncatedColumns) || maxColumnCount(rows) > MAX_TABLE_COLUMNS
    };
  }).filter((sheet) => sheet.rows.length > 0);
  return {
    kind: "xlsx",
    sheets,
    totalSheets: parsed.sheets.length
  };
}

function parseDelimitedTable(content: unknown, delimiter: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let truncatedRows = false;
  let truncatedColumns = false;
  let ignoredRows = 0;
  const text = String(content ?? "");
  const pushRow = (nextRow: string[]) => {
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

function trimTableRows(rows: unknown[], maxRows: number, maxColumns: number) {
  return rows.slice(0, maxRows).map((row) => (Array.isArray(row) ? row : []).slice(0, maxColumns).map((value) => String(value ?? "")));
}

function maxColumnCount(rows: unknown[]) {
  return rows.reduce<number>((max, row) => Math.max(max, Array.isArray(row) ? row.length : 0), 0);
}

/**
 * @param {string} cwd
 * @param {string} requestedPath
 */
export async function readRawFile(cwd: string, requestedPath: string) {
  const opened = await openWorkspaceFile(cwd, requestedPath);
  if (!opened.ok) {
    return opened;
  }
  try {
    if (opened.stat.size > MAX_RAW_BYTES) {
      return { ok: false, status: 413, error: "文件过大，已阻止内嵌预览" };
    }
    const downloadOnly = !isEmbeddableRawPath(opened.path);
    return {
      ok: true,
      path: opened.path,
      contentType: contentTypeForPath(opened.path),
      contentDisposition: downloadOnly ? "attachment" : "inline",
      downloadName: path.basename(opened.path),
      downloadOnly,
      bytes: await opened.handle.readFile()
    };
  } finally {
    await opened.handle.close();
  }
}

/**
 * @param {Record<string, any>} session
 * @param {string} finalOutput
 */
export function collectSessionFiles(session: { cwd?: unknown; workflow?: unknown } = {}, finalOutput: string = "") {
  const cwd = typeof session?.cwd === "string" ? session.cwd : process.cwd();
  const items: SessionFileItem[] = [];
  const workflow = session?.workflow && typeof session.workflow === "object" ? session.workflow as { changes?: unknown } : {};
  const changes = Array.isArray(workflow.changes) ? workflow.changes : [];
  for (const change of changes) {
    const record = isRecord(change) ? change : {};
    addFile(items, cwd, record.path, {
      source: record.created ? "created" : record.edited ? "edited" : "changed",
      toolName: record.toolName ?? null
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
export function resolveWorkspaceFile(cwd: string, requestedPath: string): WorkspaceFailure | WorkspaceResolved {
  const root = path.resolve(cwd);
  const text = String(requestedPath ?? "").trim();
  if (!text) {
    return { ok: false, status: 400, error: "缺少文件路径" };
  }
  const resolved = path.resolve(root, text);
  if (!isInside(root, resolved)) {
    return { ok: false, status: 403, error: "第一版只允许预览当前工作区内文件" };
  }
  let realRoot;
  let realTarget;
  try {
    realRoot = realpathSync(root);
    realTarget = realpathSync(resolved);
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") {
      return { ok: false, status: 404, error: "文件不存在或不是普通文件" };
    }
    return { ok: false, status: 400, error: "无法解析文件真实路径" };
  }
  if (!isInside(realRoot, realTarget)) {
    return { ok: false, status: 403, error: "文件真实路径位于工作区外" };
  }
  return { ok: true, path: realTarget, root: realRoot };
}

async function openWorkspaceFile(cwd: string, requestedPath: string): Promise<WorkspaceFailure | WorkspaceOpened> {
  const resolved = resolveWorkspaceFile(cwd, requestedPath);
  if (!resolved.ok) {
    return resolved;
  }
  const handle = await fs.open(resolved.path, "r").catch(() => null);
  if (!handle) {
    return { ok: false, status: 404, error: "文件不存在或无法读取" };
  }
  try {
    const [stat, currentRealPath] = await Promise.all([
      handle.stat(),
      fs.realpath(resolved.path)
    ]);
    if (!stat.isFile() || !isInside(resolved.root, currentRealPath)) {
      await handle.close();
      return { ok: false, status: stat.isFile() ? 403 : 404, error: "文件真实路径不在允许范围内" };
    }
    const currentStat = await fs.stat(currentRealPath);
    if (!sameOpenedFile(stat, currentStat)) {
      await handle.close();
      return { ok: false, status: 409, error: "文件在安全检查期间发生变化，请重试" };
    }
    return { ok: true, path: currentRealPath, root: resolved.root, stat, handle };
  } catch {
    await handle.close();
    return { ok: false, status: 404, error: "文件不存在或无法读取" };
  }
}

function sameOpenedFile(opened: import("node:fs").Stats, current: import("node:fs").Stats) {
  const openedDev = Number(opened.dev);
  const currentDev = Number(current.dev);
  const openedIno = Number(opened.ino);
  const currentIno = Number(current.ino);
  const hasComparableDev = openedDev !== 0 && currentDev !== 0;
  const hasComparableIno = openedIno !== 0 && currentIno !== 0;
  if (hasComparableDev && opened.dev !== current.dev) {
    return false;
  }
  if (hasComparableIno && opened.ino !== current.ino) {
    return false;
  }
  if (hasComparableDev || hasComparableIno) {
    return true;
  }
  return opened.size === current.size && opened.mtimeMs === current.mtimeMs;
}

/**
 * @param {string} cwd
 * @param {string} target
 */
export function fileSummary(cwd: string, target: string) {
  const resolved = path.resolve(cwd, target);
  return {
    path: resolved,
    relativePath: path.relative(cwd, resolved) || path.basename(resolved),
    name: path.basename(resolved),
    kind: kindForPath(resolved)
  };
}

function baseFile(filePath: string, cwd: string, stat: import("node:fs").Stats) {
  return {
    path: filePath,
    relativePath: path.relative(cwd, filePath) || path.basename(filePath),
    name: path.basename(filePath),
    extension: path.extname(filePath).toLowerCase(),
    size: stat.size,
    modifiedAt: stat.mtime.toISOString()
  };
}

async function readTextHead(handle: import("node:fs/promises").FileHandle) {
  const buffer = Buffer.alloc(MAX_TEXT_BYTES);
  const read = await handle.read(buffer, 0, MAX_TEXT_BYTES, 0);
  return buffer.subarray(0, read.bytesRead).toString("utf8");
}

function rawUrl(relativePath: string) {
  return `/api/files/raw?path=${encodeURIComponent(relativePath)}`;
}

function contentTypeForPath(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".pdf") return "application/pdf";
  return "application/octet-stream";
}

function isEmbeddableRawPath(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  return PREVIEWABLE_IMAGE_EXTENSIONS.has(ext) || ext === ".pdf";
}

function kindForPath(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  if (PREVIEWABLE_IMAGE_EXTENSIONS.has(ext)) return "image";
  if (ext === ".pdf") return "pdf";
  if (ext === ".md" || ext === ".markdown") return "markdown";
  if (DATA_EXTENSIONS.has(ext)) return "data";
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  if (OFFICE_EXTENSIONS.has(ext)) return "office";
  return "file";
}

function fileKindForTextExtension(ext: string) {
  if (ext === ".md" || ext === ".markdown") {
    return "markdown";
  }
  if (DATA_EXTENSIONS.has(ext)) {
    return "data";
  }
  return "text";
}

function extractPaths(text: string) {
  const matches = String(text ?? "").match(/(?:[A-Za-z]:[\\/][^\s"'<>|]+|(?:\.{1,2}[\\/])?[A-Za-z0-9_.-]+[\\/][A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8}|[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8})/g);
  return matches ?? [];
}

function addFile(items: SessionFileItem[], cwd: string, target: unknown, meta: Partial<SessionFileItem> = {}) {
  const value = String(target ?? "").trim();
  if (!value) {
    return;
  }
  const resolved = resolveWorkspaceFile(cwd, value);
  if (!resolved.ok) {
    return;
  }
  if (!fileExists(resolved.path)) {
    return;
  }
  items.push({
    ...fileSummary(resolved.root, resolved.path),
    ...meta
  });
}

function dedupeFiles(items: SessionFileItem[]) {
  const seen = new Set<string>();
  const out: SessionFileItem[] = [];
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

function isInside(root: string, target: string) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function fileExists(filePath: string) {
  try {
    const stat = statSync(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}
