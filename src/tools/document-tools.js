import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { Worker } from "node:worker_threads";
import { isInside } from "../permissions/policy-engine.js";
import { normalizeToolPath } from "../permissions/path-utils.js";
import { htmlToMarkdown } from "./web-tools.js";

const OFFICE_ZIP_LIMITS = Object.freeze({
  maxArchiveBytes: 20 * 1024 * 1024,
  maxEntries: 1000,
  maxEntryUncompressedBytes: 16 * 1024 * 1024,
  maxTotalUncompressedBytes: 64 * 1024 * 1024,
  maxCompressionRatio: 200,
  timeoutMs: 3000
});

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
  const ext = path.extname(target).toLowerCase();
  const configuredMaxBytes = positiveIntegerOrNull(input.maxBytes);
  const maxBytes = configuredMaxBytes ?? ([".docx", ".pptx", ".xlsx"].includes(ext)
    ? OFFICE_ZIP_LIMITS.maxArchiveBytes
    : null);
  if (maxBytes && stat.size > maxBytes) {
    return {
      path: toDisplayPath(workspace, target),
      supported: false,
      bytes: stat.size,
      maxBytes,
      error: { code: "DOCUMENT_TOO_LARGE", message: `Document exceeds maxBytes (${maxBytes})` }
    };
  }

  const buffer = await fs.readFile(target);
  const parsed = await parseDocumentBufferAsync(buffer, ext);
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

export function parseDocumentBuffer(buffer, ext, options = {}) {
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
    return parseOfficeArchive({ buffer, ext, limits: officeZipLimits(options) }, (input, inflateOptions) => zlib.inflateRawSync(input, inflateOptions));
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

export async function parseDocumentBufferAsync(buffer, ext, options = {}) {
  if (![".docx", ".pptx", ".xlsx"].includes(ext)) {
    return parseDocumentBuffer(buffer, ext, options);
  }
  const limits = officeZipLimits(options);
  return parseOfficeArchiveInWorker(buffer, ext, limits);
}

function officeZipLimits(options = {}) {
  const limited = {};
  for (const [key, fallback] of Object.entries(OFFICE_ZIP_LIMITS)) {
    const requested = positiveIntegerOrNull(options[key]);
    limited[key] = requested ? Math.min(requested, fallback) : fallback;
  }
  return limited;
}

function parseOfficeArchiveInWorker(buffer, ext, limits) {
  const source = `
    const { parentPort, workerData } = require("node:worker_threads");
    const { inflateRawSync } = require("node:zlib");
    const parseOfficeArchive = ${parseOfficeArchive.toString()};
    try {
      const result = parseOfficeArchive(workerData, (input, options) => inflateRawSync(input, options));
      parentPort.postMessage({ ok: true, result });
    } catch (error) {
      parentPort.postMessage({
        ok: false,
        error: {
          code: String(error && error.code || "OFFICE_PARSE_FAILED"),
          message: String(error && error.message || "Office document parsing failed")
        }
      });
    }
  `;
  const worker = new Worker(source, {
    eval: true,
    workerData: { buffer: Buffer.from(buffer), ext, limits },
    resourceLimits: {
      maxOldGenerationSizeMb: 128,
      maxYoungGenerationSizeMb: 32,
      stackSizeMb: 4
    }
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      finish(() => {
        worker.terminate();
        reject(documentParseError("OFFICE_PARSE_TIMEOUT", `Office parsing exceeded ${limits.timeoutMs} ms`));
      });
    }, limits.timeoutMs);
    worker.once("message", (message) => {
      finish(() => {
        worker.terminate();
        if (message?.ok) {
          resolve(message.result);
        } else {
          reject(documentParseError(message?.error?.code, message?.error?.message));
        }
      });
    });
    worker.once("error", (error) => {
      finish(() => reject(documentParseError(error?.code, error?.message)));
    });
    worker.once("exit", (code) => {
      if (code !== 0) {
        finish(() => reject(documentParseError("OFFICE_WORKER_EXIT", `Office parser worker exited with code ${code}`)));
      }
    });
  });
}

function documentParseError(code, message) {
  return Object.assign(new Error(String(message ?? "Office document parsing failed")), {
    code: String(code ?? "OFFICE_PARSE_FAILED")
  });
}

function parseOfficeArchive(payload, inflateRaw) {
  const buffer = Buffer.from(payload.buffer);
  const ext = String(payload.ext ?? "").toLowerCase();
  const limits = payload.limits ?? {};
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
  function readZipEntries(archive) {
    if (archive.length > limits.maxArchiveBytes) {
      fail("ZIP_ARCHIVE_LIMIT", "Office archive exceeds the compressed size limit");
    }
    const eocdOffset = findEndOfCentralDirectory(archive);
    if (eocdOffset < 0) {
      fail("ZIP_EOCD_NOT_FOUND", "ZIP end of central directory not found");
    }
    ensureRange(archive, eocdOffset, 22, "ZIP_EOCD_INVALID");
    const diskNumber = archive.readUInt16LE(eocdOffset + 4);
    const centralDisk = archive.readUInt16LE(eocdOffset + 6);
    const diskEntries = archive.readUInt16LE(eocdOffset + 8);
    const entryCount = archive.readUInt16LE(eocdOffset + 10);
    const centralSize = archive.readUInt32LE(eocdOffset + 12);
    const centralOffset = archive.readUInt32LE(eocdOffset + 16);
    if (diskNumber !== 0 || centralDisk !== 0 || diskEntries !== entryCount) {
      fail("ZIP_MULTIDISK_UNSUPPORTED", "Multi-disk ZIP archives are not supported");
    }
    if (entryCount === 0xffff || centralOffset === 0xffffffff || centralSize === 0xffffffff) {
      fail("ZIP64_UNSUPPORTED", "ZIP64 Office archives are not supported by the preview parser");
    }
    if (entryCount > limits.maxEntries) {
      fail("ZIP_ENTRY_LIMIT", "Office archive contains too many entries");
    }
    ensureRange(archive, centralOffset, centralSize, "ZIP_CENTRAL_DIRECTORY_INVALID");
    if (centralOffset + centralSize > eocdOffset) {
      fail("ZIP_CENTRAL_DIRECTORY_INVALID", "ZIP central directory overlaps its end record");
    }

    const extracted = new Map();
    let offset = centralOffset;
    let declaredCompressedTotal = 0;
    let declaredUncompressedTotal = 0;
    let extractedTotal = 0;
    for (let index = 0; index < entryCount; index += 1) {
      ensureRange(archive, offset, 46, "ZIP_CENTRAL_ENTRY_INVALID");
      if (archive.readUInt32LE(offset) !== 0x02014b50) {
        fail("ZIP_CENTRAL_ENTRY_INVALID", "ZIP central directory entry signature is invalid");
      }
      const flags = archive.readUInt16LE(offset + 8);
      const method = archive.readUInt16LE(offset + 10);
      const compressedSize = archive.readUInt32LE(offset + 20);
      const uncompressedSize = archive.readUInt32LE(offset + 24);
      const fileNameLength = archive.readUInt16LE(offset + 28);
      const extraLength = archive.readUInt16LE(offset + 30);
      const commentLength = archive.readUInt16LE(offset + 32);
      const localOffset = archive.readUInt32LE(offset + 42);
      const entryLength = 46 + fileNameLength + extraLength + commentLength;
      ensureRange(archive, offset, entryLength, "ZIP_CENTRAL_ENTRY_INVALID");
      if (offset + entryLength > centralOffset + centralSize) {
        fail("ZIP_CENTRAL_ENTRY_INVALID", "ZIP central directory entry exceeds the declared directory");
      }
      if ((flags & 1) !== 0) {
        fail("ZIP_ENCRYPTED_UNSUPPORTED", "Encrypted Office ZIP entries are not supported");
      }
      if (method !== 0 && method !== 8) {
        fail("ZIP_COMPRESSION_UNSUPPORTED", `Unsupported ZIP compression method: ${method}`);
      }
      declaredCompressedTotal += compressedSize;
      if (declaredCompressedTotal > limits.maxArchiveBytes) {
        fail("ZIP_TOTAL_SIZE_LIMIT", "Office ZIP archive exceeds the compressed entry budget");
      }

      const name = archive.subarray(offset + 46, offset + 46 + fileNameLength).toString("utf8").replace(/\\/g, "/");
      if (!isSafeEntryName(name)) {
        fail("ZIP_ENTRY_NAME_INVALID", "Office ZIP entry has an unsafe path");
      }
      if (shouldExtract(name)) {
        if (uncompressedSize > limits.maxEntryUncompressedBytes) {
          fail("ZIP_ENTRY_SIZE_LIMIT", "Office ZIP entry exceeds the uncompressed size limit");
        }
        const ratio = uncompressedSize === 0 ? 0 : uncompressedSize / Math.max(1, compressedSize);
        if (ratio > limits.maxCompressionRatio) {
          fail("ZIP_COMPRESSION_RATIO_LIMIT", "Office ZIP entry exceeds the compression ratio limit");
        }
        declaredUncompressedTotal += uncompressedSize;
        if (declaredUncompressedTotal > limits.maxTotalUncompressedBytes) {
          fail("ZIP_TOTAL_SIZE_LIMIT", "Office ZIP archive exceeds the extraction budget");
        }
        if (extracted.has(name)) {
          fail("ZIP_DUPLICATE_ENTRY", "Office ZIP contains a duplicate preview entry");
        }
        const data = readZipLocalEntry(archive, { localOffset, compressedSize, uncompressedSize, method });
        extractedTotal += data.length;
        if (extractedTotal > limits.maxTotalUncompressedBytes) {
          fail("ZIP_TOTAL_SIZE_LIMIT", "Office ZIP archive exceeds the extraction budget");
        }
        extracted.set(name, data);
      }
      offset += entryLength;
    }
    return extracted;
  }

  function readZipLocalEntry(archive, entry) {
    ensureRange(archive, entry.localOffset, 30, "ZIP_LOCAL_HEADER_NOT_FOUND");
    if (archive.readUInt32LE(entry.localOffset) !== 0x04034b50) {
      fail("ZIP_LOCAL_HEADER_NOT_FOUND", "ZIP local file header not found");
    }
    const localMethod = archive.readUInt16LE(entry.localOffset + 8);
    const fileNameLength = archive.readUInt16LE(entry.localOffset + 26);
    const extraLength = archive.readUInt16LE(entry.localOffset + 28);
    if (localMethod !== entry.method) {
      fail("ZIP_LOCAL_HEADER_MISMATCH", "ZIP local entry compression method does not match the central directory");
    }
    const dataStart = entry.localOffset + 30 + fileNameLength + extraLength;
    ensureRange(archive, dataStart, entry.compressedSize, "ZIP_ENTRY_DATA_INVALID");
    const compressed = archive.subarray(dataStart, dataStart + entry.compressedSize);
    let data;
    if (entry.method === 0) {
      data = Buffer.from(compressed);
    } else {
      try {
        data = inflateRaw(compressed, { maxOutputLength: limits.maxEntryUncompressedBytes });
      } catch (error) {
        if (error?.code === "ERR_BUFFER_TOO_LARGE" || /maxOutputLength|larger than/i.test(String(error?.message ?? ""))) {
          fail("ZIP_ENTRY_SIZE_LIMIT", "Office ZIP entry exceeds the uncompressed size limit");
        }
        throw error;
      }
    }
    if (data.length !== entry.uncompressedSize) {
      fail("ZIP_ENTRY_SIZE_MISMATCH", "Office ZIP entry size does not match the central directory");
    }
    return data;
  }

  function shouldExtract(name) {
    if (ext === ".docx") return name === "word/document.xml";
    if (ext === ".pptx") return /^ppt\/slides\/slide\d+\.xml$/i.test(name);
    return name === "xl/sharedStrings.xml" || /^xl\/worksheets\/sheet\d+\.xml$/i.test(name);
  }

  function isSafeEntryName(name) {
    return Boolean(name) && !name.includes("\0") && !name.startsWith("/") && !/^[A-Za-z]:/.test(name) && !name.split("/").includes("..");
  }

  function ensureRange(source, offset, length, code) {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset > source.length - length) {
      fail(code, "Office ZIP metadata points outside the archive");
    }
  }

  function findEndOfCentralDirectory(source) {
    for (let offset = source.length - 22; offset >= Math.max(0, source.length - 65557); offset -= 1) {
      if (source.readUInt32LE(offset) === 0x06054b50) {
        return offset;
      }
    }
    return -1;
  }

  function fail(code, message) {
    throw Object.assign(new Error(message), { code });
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
      if (position.row >= 500) {
        truncatedRows = true;
        continue;
      }
      if (position.column >= 80) {
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
}

function positiveIntegerOrNull(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}
