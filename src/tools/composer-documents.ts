import fs from "node:fs/promises";
import path from "node:path";
import { parseDocumentBufferAsync } from "./document-tools.ts";
import { encodePng } from "./png-encode.ts";
import { extractImages, getDocumentProxy } from "unpdf";

export const COMPOSER_UPLOAD_DIR = "ant-code-uploads";
export const MAX_DOCUMENT_ATTACHMENTS = 4;
export const MAX_DOCUMENT_BYTES = 40 * 1024 * 1024;
export const MAX_VISION_PDF_PAGES = 2;
export const PDF_SPARSE_TEXT_CHARS = 40;
export const COMPOSER_DOCUMENT_PREVIEW_CHARS = 4000;
export const MAX_VISION_PAGE_EDGE = 1280;
export const MAX_VISION_PAGE_PNG_BYTES = 1_500_000;

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
      path: String(record.path ?? "").trim() || undefined
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
}): Promise<{ promptAppendix: string; visionImages: ComposerImage[] }> {
  const documents = normalizeComposerDocuments(input.attachments);
  if (documents.length === 0) {
    return { promptAppendix: "", visionImages: [] };
  }
  const uploadRoot = path.join(path.resolve(input.cwd), COMPOSER_UPLOAD_DIR);
  await fs.mkdir(uploadRoot, { recursive: true });
  await ensureComposerUploadIgnore(input.cwd).catch(() => undefined);
  const sections: string[] = [
    "Composer attached the following files. They are already saved. Do not search the whole workspace to find them. Use document_intake or read_file on the saved paths if you need more than the preview."
  ];
  const visionImages: ComposerImage[] = [];
  const existingImages = Math.max(0, Number(input.existingImageCount) || 0);
  const remainingVisionSlots = Math.max(0, 6 - existingImages);

  for (const document of documents) {
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
    const parsed = await parseDocumentBufferAsync(buffer, document.ext);
    const sparsePdf = document.ext === ".pdf" && parsed.content.replace(/\s+/g, "").length < PDF_SPARSE_TEXT_CHARS;
    if (sparsePdf && remainingVisionSlots - visionImages.length > 0) {
      const pageBudget = Math.min(MAX_VISION_PDF_PAGES, remainingVisionSlots - visionImages.length, existingImages > 0 ? 1 : MAX_VISION_PDF_PAGES);
      const pages = await pdfEmbeddedImagesAsPng(buffer, pageBudget);
      visionImages.push(...pages.images.slice(0, pageBudget));
      parsed.notes.push(...pages.notes);
    }
    sections.push(formatDocumentSection(relativePath, document.name, parsed.content, parsed.notes, parsed.supported));
  }

  return {
    promptAppendix: sections.join("\n\n"),
    visionImages: visionImages.slice(0, remainingVisionSlots)
  };
}

export async function pdfEmbeddedImagesAsPng(buffer: Buffer, maxPages: number) {
  const notes: string[] = [];
  const images: ComposerImage[] = [];
  try {
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const pageCount = Number(pdf.numPages) || 0;
    const limit = Math.min(Math.max(1, maxPages), pageCount, MAX_VISION_PDF_PAGES);
    for (let page = 1; page <= limit; page += 1) {
      const extracted = await extractImages(pdf, page);
      const best = pickLargestImage(extracted);
      if (!best || !best.data || !best.width || !best.height) {
        continue;
      }
      const channels = best.channels === 1 || best.channels === 3 || best.channels === 4 ? best.channels : 4;
      const scaled = downscaleRawImage(best.width, best.height, channels, best.data, MAX_VISION_PAGE_EDGE);
      const png = encodePng(scaled.width, scaled.height, channels, scaled.data);
      if (png.length > MAX_VISION_PAGE_PNG_BYTES) {
        notes.push(`Page ${page} image was still larger than ${MAX_VISION_PAGE_PNG_BYTES} bytes after downscale and was skipped.`);
        continue;
      }
      images.push({
        type: "image",
        name: `pdf-page-${page}.png`,
        mimeType: "image/png",
        size: png.length,
        data: png.toString("base64")
      });
    }
    if (images.length > 0) {
      notes.push(`No usable PDF text layer; sent ${images.length} embedded page image(s) to the vision model (pages 1-${images.length}).`);
    } else {
      notes.push("No usable PDF text layer and no embedded page images. Vision was not given raster pages; OCR is not bundled.");
    }
  } catch (error) {
    notes.push(`PDF page-image extraction failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { images, notes };
}

function pickLargestImage(images: Array<{ width?: number; height?: number; data?: Uint8ClampedArray; channels?: number }>) {
  return [...images].sort((left, right) => {
    const leftArea = Number(left.width ?? 0) * Number(left.height ?? 0);
    const rightArea = Number(right.width ?? 0) * Number(right.height ?? 0);
    return rightArea - leftArea;
  })[0];
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

function downscaleRawImage(
  width: number,
  height: number,
  channels: 1 | 3 | 4,
  data: Uint8Array | Uint8ClampedArray | Buffer,
  maxEdge: number
) {
  const edge = Math.max(width, height);
  if (edge <= maxEdge) {
    return { width, height, data };
  }
  const scale = maxEdge / edge;
  const nextWidth = Math.max(1, Math.round(width * scale));
  const nextHeight = Math.max(1, Math.round(height * scale));
  const next = new Uint8Array(nextWidth * nextHeight * channels);
  for (let y = 0; y < nextHeight; y += 1) {
    const sourceY = Math.min(height - 1, Math.floor(y / scale));
    for (let x = 0; x < nextWidth; x += 1) {
      const sourceX = Math.min(width - 1, Math.floor(x / scale));
      const sourceIndex = (sourceY * width + sourceX) * channels;
      const destIndex = (y * nextWidth + x) * channels;
      next.set(data.subarray(sourceIndex, sourceIndex + channels), destIndex);
    }
  }
  return { width: nextWidth, height: nextHeight, data: next };
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
