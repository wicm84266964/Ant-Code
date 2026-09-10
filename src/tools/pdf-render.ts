import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { createIsomorphicCanvasFactory, getDocumentProxy } from "unpdf";
import { PACKAGE_ROOT } from "../config/defaults.ts";

export type PdfVisionDocument = { name: string; path: string; pageStart?: number; pageEnd?: number };
export type PdfPageImage = { type: "image"; name: string; mimeType: string; size: number; data: string };
export const PDF_VISION_BATCH_PAGES = 2;
export const PDF_RENDER_MAX_EDGE = 2000;
export const PDF_RENDER_TIMEOUT_MS = 60_000;

// Native canvas stays beside the executable; SEA bundles run from a temp directory.
export function loadPdfCanvas(): typeof import("@napi-rs/canvas") {
  return createRequire(path.join(PACKAGE_ROOT, "package.json"))("@napi-rs/canvas");
}

export async function* renderPdfBatches(document: PdfVisionDocument, options: { signal?: AbortSignal } = {}) {
  options.signal?.throwIfAborted();
  const CanvasFactory = await createIsomorphicCanvasFactory(async () => loadPdfCanvas());
  const bytes = await fs.readFile(document.path, { signal: options.signal });
  const pdf = await getDocumentProxy(new Uint8Array(bytes), {
    CanvasFactory, useSystemFonts: true
  });
  try {
    const first = document.pageStart ?? 1;
    const last = document.pageEnd ?? pdf.numPages;
    if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last < first || last > pdf.numPages) {
      throw new Error(`Invalid PDF page range ${first}-${last}; document has ${pdf.numPages} pages.`);
    }
    let images: PdfPageImage[] = [];
    for (let pageNumber = first; pageNumber <= last; pageNumber += 1) {
      options.signal?.throwIfAborted();
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const scale = Math.min(2, PDF_RENDER_MAX_EDGE / Math.max(viewport.width, viewport.height));
      const factory = new CanvasFactory();
      const drawing = factory.create(Math.max(1, Math.ceil(viewport.width * scale)), Math.max(1, Math.ceil(viewport.height * scale)));
      try {
        const render = page.render({ canvas: drawing.canvas as unknown as HTMLCanvasElement, canvasContext: drawing.context as unknown as CanvasRenderingContext2D, viewport: page.getViewport({ scale }) });
        const abort = () => render.cancel();
        const timeout = setTimeout(abort, PDF_RENDER_TIMEOUT_MS);
        options.signal?.addEventListener("abort", abort, { once: true });
        try {
          options.signal?.throwIfAborted();
          await render.promise;
        } finally {
          clearTimeout(timeout);
          options.signal?.removeEventListener("abort", abort);
        }
        options.signal?.throwIfAborted();
        // JPEG bounds request size even for full-page scans with photographic noise.
        const canvas = drawing.canvas as import("@napi-rs/canvas").Canvas;
        const image = await canvas.encode("jpeg", 90);
        if (image.length > 8 * 1024 * 1024) throw new Error(`PDF page ${pageNumber} exceeds the 8 MiB image limit.`);
        images.push({ type: "image", name: `${document.name} / page ${pageNumber}`, mimeType: "image/jpeg", size: image.length, data: image.toString("base64") });
      } finally {
        factory.destroy(drawing);
        page.cleanup();
      }
      if (images.length === PDF_VISION_BATCH_PAGES || pageNumber === last) {
        yield { images, pageStart: pageNumber - images.length + 1, pageEnd: pageNumber, totalPages: pdf.numPages };
        images = [];
      }
    }
  } finally {
    await pdf.loadingTask.destroy();
  }
}
