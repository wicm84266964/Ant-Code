import fs from "node:fs/promises";
import path from "node:path";
import { parseDocumentBufferAsync } from "./document-tools.ts";
import type { PdfVisionDocument } from "./pdf-render.ts";

export const COMPOSER_UPLOAD_DIR = "ant-code-uploads";
export const MAX_DOCUMENT_ATTACHMENTS = 4;
export const MAX_DOCUMENT_BYTES = 40 * 1024 * 1024;
export const COMPOSER_DOCUMENT_PREVIEW_CHARS = 4000;
export const MAX_VISION_PDF_PAGES = 2;

export const ALLOWED_DOCUMENT_EXTENSIONS = new Set([
  ".pdf", ".docx", ".xlsx", ".pptx", ".txt", ".md", ".markdown", ".csv", ".json", ".html", ".htm"
]);

const DOCUMENT_MIME_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".html": "text/html",
  ".htm": "text/html"
};

type ComposerImage = {
  type: "image";
  name: string;
  mimeType: string;
  size: number;
  data: string;
};

type ComposerDocument = {
  type: "document";
  name: string;
  mimeType: string;
  size: number;
  data: string;
  ext: string;
  path?: string;
  pageStart?: number;
  pageEnd?: number;
};

export function extensionOfName(name: unknown) {
  const base = path.extname(String(name ?? "")).toLowerCase();
  return base;
}

export function isAllowedDocumentExtension(ext: string) {
  return ALLOWED_DOCUMENT_EXTENSIONS.has(ext);
}

export function mimeTypeForDocumentExt(ext: string) {
  return DOCUMENT_MIME_BY_EXT[ext] ?? "application/octet-stream";
}

export function normalizeComposerDocuments(value: unknown): ComposerDocument[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const documents: ComposerDocument[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || !("type" in item) || item.type !== "document") {
      continue;
    }
    const record = item as Record<string, unknown>;
    const name = String(record.name ?? "document").trim().slice(0, 160) || "document";
    const ext = extensionOfName(name);
    if (!isAllowedDocumentExtension(ext)) {
      continue;
    }
    const data = String(record.data ?? "").replace(/\s+/g, "");
    if (!data) {
      continue;
    }
    documents.push({
      type: "document",
      name,
      mimeType: mimeTypeForDocumentExt(ext),
      size: Number(record.size ?? 0) || 0,
      data,
      ext,
      path: String(record.path ?? "").trim() || undefined,
      pageStart: record.pageStart === undefined ? undefined : Number(record.pageStart),
      pageEnd: record.pageEnd === undefined ? undefined : Number(record.pageEnd)
    });
    if (documents.length >= MAX_DOCUMENT_ATTACHMENTS) {
      break;
    }
  }
  return documents;
}

export async function storeComposerAttachments<T extends { type?: string; name?: string; data?: string; path?: string }>(
  cwd: string,
  attachments: T[] = []
): Promise<Array<T & { path?: string }>> {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return [];
  }
  const uploadRoot = path.join(path.resolve(cwd), COMPOSER_UPLOAD_DIR);
  await fs.mkdir(uploadRoot, { recursive: true });
  await ensureComposerUploadIgnore(cwd).catch(() => undefined);
  const stored: Array<T & { path?: string }> = [];
  for (const item of attachments) {
    if (item?.path) {
      stored.push(item);
      continue;
    }
    const data = String(item?.data ?? "").replace(/\s+/g, "");
    if (!data) {
      stored.push(item);
      continue;
    }
    const savedName = uniqueUploadName(String(item.name ?? (item.type === "document" ? "document" : "image")));
    const relativePath = `${COMPOSER_UPLOAD_DIR}/${savedName}`.replace(/\\/g, "/");
    await fs.writeFile(path.join(uploadRoot, savedName), Buffer.from(data, "base64"));
    stored.push({ ...item, path: relativePath });
  }
  return stored;
}

export async function ingestComposerDocuments(input: {
  cwd: string;
  attachments?: unknown;
  existingImageCount?: number;
  signal?: AbortSignal;
}): Promise<{ promptAppendix: string; visionImages: ComposerImage[]; pdfDocuments: PdfVisionDocument[] }> {
  const documents = normalizeComposerDocuments(input.attachments);
  if (documents.length === 0) {
    return { promptAppendix: "", visionImages: [], pdfDocuments: [] };
  }
  const uploadRoot = path.join(path.resolve(input.cwd), COMPOSER_UPLOAD_DIR);
  await fs.mkdir(uploadRoot, { recursive: true });
  await ensureComposerUploadIgnore(input.cwd).catch(() => undefined);
  const sections: string[] = [
    "Composer attached the following files. They are already saved. Do not search the whole workspace to find them. Use document_intake or read_file on the saved paths if you need more than the preview."
  ];
  const visionImages: ComposerImage[] = [];
  const pdfDocuments: PdfVisionDocument[] = [];

  for (const document of documents) {
    input.signal?.throwIfAborted();
    const relativePath = typeof document.path === "string" && document.path.trim()
      ? document.path.replace(/\\/g, "/")
      : `${COMPOSER_UPLOAD_DIR}/${uniqueUploadName(document.name)}`;
    const savedAbs = path.resolve(input.cwd, relativePath);
    const buffer = document.path
      ? await fs.readFile(savedAbs)
      : Buffer.from(document.data, "base64");
    if (!document.path) {
      await fs.writeFile(savedAbs, buffer);
    }
    const parsed = await parseDocumentBufferAsync(buffer, document.ext, {
      pageStart: document.pageStart,
      maxPages: document.pageEnd === undefined ? undefined : document.pageEnd - (document.pageStart ?? 1) + 1
    });
    if (document.ext === ".pdf") {
      schedulePdfVision(document, parsed, savedAbs, pdfDocuments);
    }
    sections.push(formatDocumentSection(relativePath, document.name, parsed.content, parsed.notes, parsed.supported));
  }

  return {
    promptAppendix: sections.join("\n\n"),
    visionImages,
    pdfDocuments
  };
}

export async function ensureComposerUploadIgnore(cwd: string) {
  const root = path.resolve(cwd);
  const uploadDir = path.join(root, COMPOSER_UPLOAD_DIR);
  await fs.mkdir(uploadDir, { recursive: true });
  await writeFileIfMissing(path.join(uploadDir, ".gitignore"), "*\n!.gitignore\n");
  await ensureGitignoreEntry(path.join(root, ".gitignore"), "ant-code-uploads/");
}

async function writeFileIfMissing(filePath: string, content: string) {
  try {
    await fs.writeFile(filePath, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      return;
    }
    throw error;
  }
}

async function ensureGitignoreEntry(filePath: string, entry: string) {
  let current = "";
  try {
    current = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
  if (gitignoreHasEntry(current, entry)) {
    return;
  }
  const prefix = current.length === 0 || current.endsWith("\n") ? "" : "\n";
  const block = `${prefix}${current.length === 0 ? "" : "\n"}# Ant Code composer uploads\n${entry}\n`;
  await fs.appendFile(filePath, block, "utf8");
}

function gitignoreHasEntry(text: string, entry: string) {
  const normalized = entry.replace(/\/$/, "");
  const variants = new Set([normalized, `${normalized}/`, `/${normalized}`, `/${normalized}/`]);
  return String(text ?? "").split(/\r?\n/).some((line) => variants.has(line.trim()));
}

function uniqueUploadName(name: string) {
  const ext = extensionOfName(name);
  const stem = path.basename(name, ext).replace(/[^\w.\u4e00-\u9fff-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "document";
  return `${Date.now()}-${stem}${ext}`;
}

export function resolvePdfVisionWindow(input: { pageStart?: number; pageEnd?: number; totalPages: number }) {
  const totalPages = Math.max(1, Number(input.totalPages) || 1);
  const explicitStart = Number.isInteger(input.pageStart) && Number(input.pageStart) >= 1;
  const explicitEnd = Number.isInteger(input.pageEnd) && Number(input.pageEnd) >= 1;
  const pageStart = Math.min(totalPages, explicitStart ? Number(input.pageStart) : 1);
  const requestedEnd = explicitEnd ? Number(input.pageEnd) : pageStart + MAX_VISION_PDF_PAGES - 1;
  return {
    pageStart,
    pageEnd: Math.min(totalPages, Math.max(pageStart, requestedEnd)),
    explicit: explicitStart || explicitEnd
  };
}

function schedulePdfVision(
  document: ComposerDocument,
  parsed: { supported?: boolean; sparseText?: boolean; totalPages?: number; notes: string[] },
  savedAbs: string,
  pdfDocuments: PdfVisionDocument[]
) {
  if (!parsed.supported) {
    return;
  }
  if (!parsed.sparseText) {
    parsed.notes.push("This PDF has a usable text layer. Answer from the extracted text. If the preview is insufficient, call document_intake or read_file on the saved path. Do not send pages to vision automatically.");
    return;
  }
  const totalPages = Number(parsed.totalPages) || 0;
  if (totalPages < 1) {
    return;
  }
  const window = resolvePdfVisionWindow({
    pageStart: document.pageStart,
    pageEnd: document.pageEnd,
    totalPages
  });
  pdfDocuments.push({
    name: document.name,
    path: savedAbs,
    pageStart: window.pageStart,
    pageEnd: window.pageEnd
  });
  const unreadFrom = window.pageEnd + 1;
  parsed.notes.push(
    `No usable text layer; rendered pages ${window.pageStart}-${window.pageEnd} of ${totalPages} as full pages for vision. Cite those page numbers. Do not assume they contain the abstract or summary.`
  );
  if (unreadFrom <= totalPages) {
    parsed.notes.push(
      `Pages ${unreadFrom}-${totalPages} have not been visually read. If more is needed, state that uncovered range, ask whether to continue the next pages or do a full visual read, and mention extra time and model cost. Full visual read is explicit: the user must set start and end pages on the paperclip and resend this PDF.`
    );
  }
}

function formatDocumentSection(relativePath: string, originalName: string, content: string, notes: string[], supported: boolean) {
  const body = String(content ?? "").trim();
  const truncated = body.length > COMPOSER_DOCUMENT_PREVIEW_CHARS;
  const preview = truncated ? `${body.slice(0, COMPOSER_DOCUMENT_PREVIEW_CHARS).trimEnd()}\n\n[preview truncated; read ${relativePath} for the rest]` : body;
  const header = [
    `### Attached document: ${originalName}`,
    `Saved to ${relativePath}. Do not glob the workspace to rediscover this file.`,
    `Use document_intake or read_file on ${relativePath} if you need more than this preview.`,
    supported ? null : "Extraction reported this type as unsupported.",
    truncated ? `Preview is first ${COMPOSER_DOCUMENT_PREVIEW_CHARS} characters of extracted text.` : null,
    ...notes.map((note) => `Note: ${note}`)
  ].filter(Boolean).join("\n");
  return preview ? `${header}\n\n${preview}` : header;
}
