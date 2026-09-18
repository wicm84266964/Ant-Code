import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { renderPdfBatches, loadPdfCanvas } from "../../src/tools/pdf-render.ts";
import { ingestComposerDocuments, MAX_VISION_PDF_PAGES } from "../../src/tools/composer-documents.ts";
import { parseDocumentBufferAsync } from "../../src/tools/document-tools.ts";
import { createSession, runSessionTurn } from "../../src/core/session.ts";
import { prepareVisionAttachmentsForTurn } from "../../src/core/session-messages.ts";
import http from "node:http";
import { validateTurnSubmission, turnRequestFingerprint } from "../../src/dashboard/runtime/turn-queue.ts";
import { mapSessionEventToDashboard } from "../../src/dashboard/events.ts";
import { visualPdf } from "../fixtures/pdf-vision.ts";
import { createRecordingGateway, listen, close, serverUrl, mockGatewayEnvWithoutModel } from "./session-helpers.ts";

test("PDF page ranges are validated, retained and included in request identity", () => {
  const attachment = { type: "document", name: "paper.pdf", data: visualPdf().toString("base64"), pageStart: 2, pageEnd: 4 };
  const input = { prompt: "read", attachments: [attachment] };
  const valid = validateTurnSubmission(input);
  assert.equal(valid.ok, true);
  if (valid.ok) assert.equal(valid.attachments[0].pageStart, 2);
  for (const range of [{ pageStart: 0 }, { pageStart: 2.5 }, { pageEnd: 1 }]) {
    assert.equal(validateTurnSubmission({ ...input, attachments: [{ ...attachment, ...range }] }).ok, false);
  }
  assert.notEqual(turnRequestFingerprint(input), turnRequestFingerprint({ ...input, attachments: [{ ...attachment, pageEnd: 5 }] }));
  const events = mapSessionEventToDashboard({ type: "pdf_vision_progress", name: "paper.pdf", pageStart: 3, pageEnd: 4, totalPages: 5, stage: "analyzing" });
  assert.match(JSON.stringify(events), /3-4 \/ 5/);
});

test("PDF rendering covers all pages, vector content, text and multiple images", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ant-pdf-render-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const file = path.join(cwd, "five.pdf");
  await fs.writeFile(file, visualPdf());
  const batches = [];
  for await (const batch of renderPdfBatches({ name: "five.pdf", path: file })) batches.push(batch);
  assert.deepEqual(batches.map((batch) => [batch.pageStart, batch.pageEnd]), [[1, 2], [3, 4], [5, 5]]);
  const { createCanvas, loadImage } = loadPdfCanvas();
  const image = await loadImage(Buffer.from(batches[0].images[0].data, "base64"));
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const pixel = (x: number, y: number) => Array.from(context.getImageData(x * 2, y * 2, 1, 1).data);
  assert.ok(pixel(50, 150)[1] > 150, "vector rectangle must be green");
  assert.ok(pixel(50, 300)[0] > 200, "first embedded image must be red");
  assert.ok(pixel(210, 300)[2] > 200, "second embedded image must be blue");
  const textPixels = context.getImageData(40, 50, 500, 65).data;
  assert.ok(textPixels.some((value, index) => index % 4 !== 3 && value < 50), "text must render");
  assert.equal(batches[2].images[0].name, "five.pdf / page 5");
});

test("PDF ranges, cancellation and invalid documents do not silently skip pages", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ant-pdf-range-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const file = path.join(cwd, "pages.pdf");
  await fs.writeFile(file, visualPdf());
  const batches = [];
  for await (const batch of renderPdfBatches({ name: "pages.pdf", path: file, pageStart: 3, pageEnd: 4 })) batches.push(batch);
  assert.deepEqual(batches.map((batch) => [batch.pageStart, batch.pageEnd]), [[3, 4]]);
  await assert.rejects(async () => { for await (const _ of renderPdfBatches({ name: "bad", path: file, pageEnd: 6 })) {} }, /Invalid PDF page range/);
  const controller = new AbortController();
  const iterator = renderPdfBatches({ name: "pages", path: file }, { signal: controller.signal });
  await iterator.next();
  controller.abort();
  await assert.rejects(iterator.next(), /abort/i);
  await fs.writeFile(file, "%PDF-broken");
  await assert.rejects(async () => { for await (const _ of renderPdfBatches({ name: "bad", path: file })) {} });
});

test("four-page scans default to the first vision window and ignore synthetic page headings", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ant-pdf-scan-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const buffer = visualPdf(4, false);
  const parsed = await parseDocumentBufferAsync(buffer, ".pdf");
  assert.equal(parsed.sparseText, true);
  assert.ok(parsed.notes.some((note) => /Very little/.test(note)));
  const ingested = await ingestComposerDocuments({ cwd, attachments: [{ type: "document", name: "scan.pdf", data: buffer.toString("base64") }] });
  assert.equal(ingested.pdfDocuments.length, 1);
  assert.deepEqual(
    [ingested.pdfDocuments[0].pageStart, ingested.pdfDocuments[0].pageEnd],
    [1, MAX_VISION_PDF_PAGES]
  );
  assert.match(ingested.promptAppendix, /pages 1-2 of 4/);
  assert.match(ingested.promptAppendix, /Pages 3-4 have not been visually read/);
  let count = 0;
  for await (const batch of renderPdfBatches(ingested.pdfDocuments[0])) count += batch.images.length;
  assert.equal(count, MAX_VISION_PDF_PAGES);
  const continued = await ingestComposerDocuments({
    cwd,
    attachments: [{ type: "document", name: "scan.pdf", data: buffer.toString("base64"), pageStart: 3 }]
  });
  assert.deepEqual([continued.pdfDocuments[0].pageStart, continued.pdfDocuments[0].pageEnd], [3, 4]);
  const full = await ingestComposerDocuments({
    cwd,
    attachments: [{ type: "document", name: "scan.pdf", data: buffer.toString("base64"), pageStart: 1, pageEnd: 4 }]
  });
  assert.deepEqual([full.pdfDocuments[0].pageStart, full.pdfDocuments[0].pageEnd], [1, 4]);
});

test("text-layer PDFs are ingested without automatic page vision", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ant-pdf-text-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const ingested = await ingestComposerDocuments({
    cwd,
    attachments: [{ type: "document", name: "paper.pdf", data: visualPdf().toString("base64"), pageStart: 1, pageEnd: 5 }]
  });
  assert.equal(ingested.pdfDocuments.length, 0);
  assert.match(ingested.promptAppendix, /usable text layer/);
  assert.match(ingested.promptAppendix, /Page 1 - PDF vision/);
});

for (const mainVision of [true, false]) {
  test(`scanned PDF session analyzes the default window; mainVision=${mainVision}`, async (t) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ant-pdf-session-"));
    t.after(() => fs.rm(cwd, { recursive: true, force: true }));
    await fs.writeFile(path.join(cwd, "lab-agent.config.json"), JSON.stringify({
      modelAlias: mainVision ? "vision-model" : "embed-text-model",
      models: [{ id: "vision-model", modalities: ["text", "image"] }, { id: "embed-text-model", modalities: ["text"] }],
      agents: { vision: { enabled: true, model: "vision-model" } }
    }));
    const requests = [];
    const server = await listen(createRecordingGateway(requests), "127.0.0.1");
    t.after(() => close(server));
    const env = mockGatewayEnvWithoutModel(serverUrl(server));
    const session = await createSession({ cwd, mode: "interactive", env });
    const events = [];
    await runSessionTurn(session, {
      prompt: "read the attached scan",
      env,
      attachments: [{ type: "document", name: "scan.pdf", data: visualPdf(5, false).toString("base64") }],
      onEvent: (event) => { events.push(event); }
    });
    const visual = requests.filter((request) => request.messages.some((message) => Array.isArray(message.content) && message.content.some((block) => block.type === "image")));
    assert.equal(visual.length, 1);
    const pageImages = visual.flatMap((request) => request.messages.flatMap((message) => Array.isArray(message.content) ? message.content.filter((block) => block.type === "image") : []));
    assert.equal(pageImages.length, MAX_VISION_PDF_PAGES);
    assert.equal(visual.every((request) => request.model === "vision-model"), true);
    assert.equal(events.filter((event) => event.type === "pdf_vision_progress" && event.stage === "completed").length, 1);
    assert.match(JSON.stringify(requests.at(-1).messages), /pages 1-2 of 5/);
    assert.equal(JSON.stringify(session.messages).includes(pageImages[0].data), false);
  });
}

for (const mainVision of [true, false]) {
  test(`explicit PDF page range analyzes every selected page; mainVision=${mainVision}`, async (t) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ant-pdf-full-"));
    t.after(() => fs.rm(cwd, { recursive: true, force: true }));
    await fs.writeFile(path.join(cwd, "lab-agent.config.json"), JSON.stringify({
      modelAlias: mainVision ? "vision-model" : "embed-text-model",
      models: [{ id: "vision-model", modalities: ["text", "image"] }, { id: "embed-text-model", modalities: ["text"] }],
      agents: { vision: { enabled: true, model: "vision-model" } }
    }));
    const requests = [];
    const server = await listen(createRecordingGateway(requests), "127.0.0.1");
    t.after(() => close(server));
    const env = mockGatewayEnvWithoutModel(serverUrl(server));
    const session = await createSession({ cwd, mode: "interactive", env });
    const events = [];
    await runSessionTurn(session, {
      prompt: "read all figures",
      env,
      attachments: [{ type: "document", name: "scan.pdf", data: visualPdf(5, false).toString("base64"), pageStart: 1, pageEnd: 5 }],
      onEvent: (event) => { events.push(event); }
    });
    const visual = requests.filter((request) => request.messages.some((message) => Array.isArray(message.content) && message.content.some((block) => block.type === "image")));
    assert.equal(visual.length, 3);
    const pageImages = visual.flatMap((request) => request.messages.flatMap((message) => Array.isArray(message.content) ? message.content.filter((block) => block.type === "image") : []));
    assert.equal(pageImages.length, 5);
    assert.equal(visual.every((request) => request.model === "vision-model"), true);
    assert.equal(events.filter((event) => event.type === "pdf_vision_progress" && event.stage === "completed").length, 3);
    assert.match(JSON.stringify(requests.at(-1).messages), /pages 5-5 of 5/);
    assert.equal(JSON.stringify(session.messages).includes(pageImages[0].data), false);
  });
}

for (const failure of ["empty", "gateway", "cancel", "unavailable"]) {
  test(`PDF vision stops without claiming complete results: ${failure}`, async (t) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ant-pdf-failure-"));
    t.after(() => fs.rm(cwd, { recursive: true, force: true }));
    const file = path.join(cwd, "five.pdf");
    await fs.writeFile(file, visualPdf());
    let requests = 0;
    const server = await listen(http.createServer(async (req, res) => {
      for await (const _ of req) {}
      requests += 1;
      res.writeHead(failure === "gateway" ? 400 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify(failure === "gateway" ? { error: { code: "VISION_FAILED", message: "mock failure" } } : { model: "vision-model", content: [], toolCalls: [], stopReason: "stop" }));
    }), "127.0.0.1");
    t.after(() => close(server));
    const env = mockGatewayEnvWithoutModel(serverUrl(server));
    await fs.writeFile(path.join(cwd, "lab-agent.config.json"), JSON.stringify({
      modelAlias: failure === "unavailable" ? "embed-text-model" : "vision-model",
      models: [{
        id: failure === "unavailable" ? "embed-text-model" : "vision-model",
        modalities: failure === "unavailable" ? ["text"] : ["text", "image"]
      }],
      agents: { vision: { enabled: false } }
    }));
    const session = await createSession({ cwd, mode: "interactive", env });
    const controller = new AbortController();
    if (failure === "cancel") controller.abort();
    const result = await prepareVisionAttachmentsForTurn({ session, pdfDocuments: [{ name: "five.pdf", path: file }], signal: controller.signal, eventOptions: {} });
    assert.equal(result.ok, false);
    assert.equal(result.status, failure === "cancel" ? "interrupted" : failure === "unavailable" ? "vision_unavailable" : "vision_error");
    assert.equal(requests, ["cancel", "unavailable"].includes(failure) ? 0 : 1);
  });
}
