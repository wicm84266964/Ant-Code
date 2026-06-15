import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { isInside } from "../permissions/policy-engine.js";
import { normalizeToolPath } from "../permissions/path-utils.js";
import { htmlToMarkdown } from "./web-tools.js";

const MAX_WORKSHEET_ROWS = 500;
const MAX_WORKSHEET_COLUMNS = 80;

export async function documentIntakeTool(input) {
  const workspace = path.resolve(input.cwd);
  const requested = normalizeToolPath(input.path);
  const target = path.resolve(workspace, requested);
  if (!canUseOutsideWorkspace(input.policy) && !isInside(workspace, target)) {
    throw Object.assign(new Error("document path resolves outside workspace"), { code: "DOCUMENT_PATH_OUTSIDE_WORKSPACE" });
  }

  const stat = await fs.stat(target).catch((error) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw Object.assign(new Error(`document not found: ${toDisplayPath(workspace, target)} (from path=${JSON.stringify(input.path)})`), { code: "DOCUMENT_NOT_FOUND" });
    }
    throw error;
  });
  const maxBytes = positiveIntegerOrNull(input.maxBytes);
  if (maxBytes && stat.size > maxBytes) {
    return {
      path: toDisplayPath(workspace, target),
      supported: false,
      bytes: stat.size,
      maxBytes,
      error: { code: "DOCUMENT_TOO_LARGE", message: `Document exceeds maxBytes (${maxBytes})` }
    };
  }

  const ext = path.extname(target).toLowerCase();
  const buffer = await fs.readFile(target);
  const parsed = parseDocumentBuffer(buffer, ext);
  return {
    path: toDisplayPath(workspace, target),
    kind: parsed.kind,
    supported: parsed.supported,
    bytes: stat.size,
    content: parsed.content,
    contentTruncated: false,
    notes: parsed.notes
  };
}

function toDisplayPath(workspace, target) {
  const resolvedWorkspace = path.resolve(workspace);
  const resolvedTarget = path.resolve(target);
  if (isInside(resolvedWorkspace, resolvedTarget)) {
    return path.relative(resolvedWorkspace, resolvedTarget) || ".";
  }
  return resolvedTarget;
}

function canUseOutsideWorkspace(policy = {}) {
  return Boolean(policy.fullAccess || policy.approvedOutsideWorkspace);
}

export function parseDocumentBuffer(buffer, ext) {
  if ([".txt", ".md", ".json", ".csv", ".log", ".xml"].includes(ext)) {
    return {
      kind: ext.slice(1) || "text",
      supported: true,
      content: buffer.toString("utf8"),
      notes: []
    };
  }

  if ([".html", ".htm"].includes(ext)) {
    return {
      kind: "html",
      supported: true,
      content: htmlToMarkdown(buffer.toString("utf8")),
      notes: ["HTML converted with Ant Code's lightweight local converter."]
    };
  }

  if ([".docx", ".pptx", ".xlsx"].includes(ext)) {
    return parseOfficeZip(buffer, ext);
  }

  if (ext === ".pdf") {
    return {
      kind: "pdf",
      supported: false,
      content: "",
      notes: [
        "PDF binary parsing is not bundled in the clean-room core.",
        "Use the document-intake skill with MarkItDown installed, or convert the PDF to text/Markdown first."
      ]
    };
  }

  return {
    kind: ext.replace(/^\./, "") || "unknown",
    supported: false,
    content: "",
    notes: ["This document type is not supported by the lightweight local parser."]
  };
}

function parseOfficeZip(buffer, ext) {
  const entries = readZipEntries(buffer);
  if (ext === ".docx") {
    const xml = entries.get("word/document.xml");
    return {
      kind: "docx",
      supported: Boolean(xml),
      content: xml ? xmlToText(xml.toString("utf8")) : "",
      notes: xml ? ["Extracted word/document.xml from DOCX."] : ["DOCX document.xml was not found."]
    };
  }

  if (ext === ".pptx") {
    const slides = Array.from(entries.entries())
      .filter(([name]) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
      .sort(([a], [b]) => numericPathCompare(a, b))
      .map(([name, value], index) => `Slide ${index + 1} (${name})\n${xmlToText(value.toString("utf8"))}`);
    return {
      kind: "pptx",
      supported: slides.length > 0,
      content: slides.join("\n\n"),
      notes: slides.length > 0 ? [`Extracted ${slides.length} slide XML file(s).`] : ["No PPTX slide XML files were found."]
    };
  }

  const shared = entries.get("xl/sharedStrings.xml");
  const sharedStrings = shared ? extractSharedStrings(shared.toString("utf8")) : [];
  const sheets = Array.from(entries.entries())
    .filter(([name]) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
    .sort(([a], [b]) => numericPathCompare(a, b))
    .map(([name, value], index) => {
      const parsed = worksheetToRows(value.toString("utf8"), sharedStrings);
      return {
        name: `Sheet ${index + 1}`,
        source: name,
        rows: parsed.rows,
        truncatedRows: parsed.truncatedRows,
        truncatedColumns: parsed.truncatedColumns
      };
    });
  return {
    kind: "xlsx",
    supported: sheets.length > 0 || sharedStrings.length > 0,
    content: sheets.length > 0 ? sheets.map((sheet) => `${sheet.name} (${sheet.source})\n${worksheetRowsToText(sheet.rows)}`).join("\n\n") : sharedStrings.join("\n"),
    sheets,
    notes: [
      `Extracted ${sheets.length} worksheet XML file(s).`,
      sharedStrings.length > 0 ? `Loaded ${sharedStrings.length} shared string(s).` : "No shared string table found."
    ]
  };
}

function readZipEntries(buffer) {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  if (eocdOffset < 0) {
    throw Object.assign(new Error("ZIP end of central directory not found"), { code: "ZIP_EOCD_NOT_FOUND" });
  }
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);
  const entries = new Map();
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      break;
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + fileNameLength).toString("utf8").replace(/\\/g, "/");
    const data = readZipLocalEntry(buffer, localOffset, compressedSize, method);
    entries.set(name, data);
    offset += 46 + fileNameLength + extraLength + commentLength;
  }
  return entries;
}

function readZipLocalEntry(buffer, offset, compressedSize, method) {
  if (buffer.readUInt32LE(offset) !== 0x04034b50) {
    throw Object.assign(new Error("ZIP local file header not found"), { code: "ZIP_LOCAL_HEADER_NOT_FOUND" });
  }
  const fileNameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + fileNameLength + extraLength;
  const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
  if (method === 0) {
    return Buffer.from(compressed);
  }
  if (method === 8) {
    return zlib.inflateRawSync(compressed);
  }
  return Buffer.alloc(0);
}

function findEndOfCentralDirectory(buffer) {
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65557); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      return offset;
    }
  }
  return -1;
}

function xmlToText(xml) {
  return decodeXml(String(xml ?? "")
    .replace(/<w:tab\b[^>]*\/?>/gi, "\t")
    .replace(/<w:br\b[^>]*\/?>/gi, "\n")
    .replace(/<\/(?:w|a):p>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractSharedStrings(xml) {
  return Array.from(String(xml ?? "").matchAll(/<si[\s\S]*?<\/si>/gi))
    .map((match) => xmlToText(match[0]))
    .filter(Boolean);
}

function worksheetToRows(xml, sharedStrings) {
  const rowMap = new Map();
  let maxRow = -1;
  let maxColumn = -1;
  let truncatedRows = false;
  let truncatedColumns = false;
  for (const match of String(xml ?? "").matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)) {
    const attrs = match[1];
    const body = match[2];
    const ref = attrs.match(/\br="([^"]+)"/)?.[1] ?? "?";
    const position = cellReferenceToIndexes(ref);
    const value = cellValueToText(attrs, body, sharedStrings);
    if (!position || !value) {
      continue;
    }
    if (position.row >= MAX_WORKSHEET_ROWS) {
      truncatedRows = true;
      continue;
    }
    if (position.column >= MAX_WORKSHEET_COLUMNS) {
      truncatedColumns = true;
      continue;
    }
    const row = rowMap.get(position.row) ?? [];
    row[position.column] = value;
    rowMap.set(position.row, row);
    maxRow = Math.max(maxRow, position.row);
    maxColumn = Math.max(maxColumn, position.column);
  }
  if (maxRow < 0 || maxColumn < 0) {
    return { rows: [], truncatedRows, truncatedColumns };
  }
  const rows = [];
  for (let rowIndex = 0; rowIndex <= maxRow; rowIndex += 1) {
    const row = rowMap.get(rowIndex) ?? [];
    rows.push(Array.from({ length: maxColumn + 1 }, (_, columnIndex) => row[columnIndex] ?? ""));
  }
  return { rows, truncatedRows, truncatedColumns };
}

function worksheetRowsToText(rows) {
  const cells = [];
  rows.forEach((row, rowIndex) => {
    row.forEach((value, columnIndex) => {
      if (value) {
        cells.push(`${columnName(columnIndex)}${rowIndex + 1}: ${value}`);
      }
    });
  });
  return cells.join("\n");
}

function cellReferenceToIndexes(ref) {
  const match = String(ref ?? "").match(/^([A-Z]+)(\d+)$/i);
  if (!match) {
    return null;
  }
  return {
    column: columnNameToIndex(match[1]),
    row: Math.max(0, Number(match[2]) - 1)
  };
}

function columnNameToIndex(value) {
  let result = 0;
  for (const char of String(value ?? "").toUpperCase()) {
    const code = char.charCodeAt(0);
    if (code < 65 || code > 90) {
      return 0;
    }
    result = result * 26 + code - 64;
  }
  return Math.max(0, result - 1);
}

function columnName(index) {
  let value = Number(index) + 1;
  let out = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    out = String.fromCharCode(65 + remainder) + out;
    value = Math.floor((value - 1) / 26);
  }
  return out;
}

function cellValueToText(attrs, body, sharedStrings) {
  const type = String(attrs.match(/\bt="([^"]+)"/)?.[1] ?? "");
  const raw = body.match(/<v[^>]*>([\s\S]*?)<\/v>/i)?.[1] ?? "";
  const inline = body.match(/<t[^>]*>([\s\S]*?)<\/t>/i)?.[1] ?? "";
  if (type === "s") {
    return sharedStrings[Number(raw)] ?? raw;
  }
  if (type === "inlineStr" || inline) {
    return decodeXml(inline);
  }
  return decodeXml(raw);
}

function decodeXml(value) {
  return String(value ?? "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function numericPathCompare(a, b) {
  const left = Number(a.match(/(\d+)\.xml$/)?.[1] ?? 0);
  const right = Number(b.match(/(\d+)\.xml$/)?.[1] ?? 0);
  return left - right || a.localeCompare(b);
}

function positiveIntegerOrNull(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}
