import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectSessionFiles, previewFile, readRawFile, resolveWorkspaceFile } from "../../src/dashboard/files.js";
import { parseDocumentBufferAsync } from "../../src/tools/document-tools.js";
import { createDocxBuffer, createOfficeZip, createXlsxBuffer } from "../fixtures/office-fixtures.js";

test("dashboard file preview blocks paths outside workspace", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-files-"));
  const outside = path.join(os.tmpdir(), "outside-dashboard-file.txt");

  const resolved = resolveWorkspaceFile(cwd, outside);

  assert.equal(resolved.ok, false);
  assert.equal(resolved.status, 403);
});

test("dashboard file preview blocks symlink and junction escapes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-files-link-"));
  const cwd = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  await fs.mkdir(cwd);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "secret.txt"), "secret", "utf8");
  try {
    await fs.symlink(outside, path.join(cwd, "escape"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.skip(`directory links are unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  const preview = await previewFile(cwd, path.join("escape", "secret.txt"));
  const raw = await readRawFile(cwd, path.join("escape", "secret.txt"));

  assert.equal(preview.ok, false);
  assert.equal(preview.status, 403);
  assert.equal(raw.ok, false);
  assert.equal(raw.status, 403);
});

test("dashboard file preview accepts a session cwd that resolves to the workspace", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-files-session-link-"));
  const cwd = path.join(root, "workspace");
  const sessionCwd = path.join(root, "session-workspace");
  await fs.mkdir(cwd);
  await fs.writeFile(path.join(cwd, "report.md"), "# Session report", "utf8");
  try {
    await fs.symlink(cwd, sessionCwd, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.skip(`directory links are unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  const result = await previewFile(sessionCwd, "report.md");

  assert.equal(result.ok, true);
  assert.equal(result.file.kind, "markdown");
  assert.equal(result.file.relativePath, "report.md");
});

test("dashboard serves SVG only with download metadata and a binary MIME", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-files-svg-"));
  await fs.writeFile(path.join(cwd, "active.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>", "utf8");

  const preview = await previewFile(cwd, "active.svg");
  const raw = await readRawFile(cwd, "active.svg");

  assert.equal(preview.ok, true);
  assert.equal(preview.file.kind, "download");
  assert.equal(preview.file.downloadOnly, true);
  assert.equal(preview.file.embeddable, false);
  assert.equal(raw.ok, true);
  assert.equal(raw.contentType, "application/octet-stream");
  assert.equal(raw.contentDisposition, "attachment");
  assert.equal(raw.downloadOnly, true);
  assert.equal(raw.downloadName, "active.svg");
});

test("dashboard previews markdown as text content", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-files-"));
  await fs.writeFile(path.join(cwd, "report.md"), "# Report\n\nDone.", "utf8");

  const result = await previewFile(cwd, "report.md");

  assert.equal(result.ok, true);
  assert.equal(result.file.kind, "markdown");
  assert.match(result.file.content, /Report/);
});

test("dashboard previews structured data files and table files with suitable viewers", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-files-"));
  await fs.writeFile(path.join(cwd, "data.json"), "{\"ok\":true}", "utf8");
  await fs.writeFile(path.join(cwd, "table.csv"), "name,value\nsample,12\n", "utf8");

  const json = await previewFile(cwd, "data.json");
  const csv = await previewFile(cwd, "table.csv");

  assert.equal(json.ok, true);
  assert.equal(json.file.kind, "data");
  assert.equal(csv.ok, true);
  assert.equal(csv.file.kind, "table-preview");
  assert.deepEqual(csv.file.table.sheets[0].rows, [["name", "value"], ["sample", "12"]]);
});

test("dashboard previews png images through raw workspace URLs", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-files-"));
  await fs.writeFile(path.join(cwd, "chart.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const result = await previewFile(cwd, "chart.png");

  assert.equal(result.ok, true);
  assert.equal(result.file.kind, "image");
  assert.equal(result.file.rawUrl, "/api/files/raw?path=chart.png");
});

test("dashboard previews docx as lightweight extracted text", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-files-"));
  await fs.writeFile(path.join(cwd, "report.docx"), createDocxBuffer("报告标题\n正文内容"));

  const result = await previewFile(cwd, "report.docx");

  assert.equal(result.ok, true);
  assert.equal(result.file.kind, "office-preview");
  assert.equal(result.file.officeKind, "docx");
  assert.match(result.file.content, /报告标题/);
  assert.match(result.file.content, /正文内容/);
  assert.equal(result.file.rawUrl, "/api/files/raw?path=report.docx");
});

test("dashboard previews xlsx as compact extracted cells", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-files-"));
  await fs.writeFile(path.join(cwd, "scores.xlsx"), createXlsxBuffer([["姓名", "分数"], ["张三", "98"]]));

  const result = await previewFile(cwd, "scores.xlsx");

  assert.equal(result.ok, true);
  assert.equal(result.file.kind, "office-preview");
  assert.equal(result.file.officeKind, "xlsx");
  assert.deepEqual(result.file.table.sheets[0].rows, [["姓名", "分数"], ["张三", "98"]]);
  assert.match(result.file.content, /Sheet 1/);
  assert.match(result.file.content, /A1: 姓名/);
  assert.match(result.file.content, /B2: 98/);
});

test("dashboard Office preview rejects archives over the entry budget", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-files-office-entries-"));
  const entries = Object.fromEntries(Array.from({ length: 1001 }, (_, index) => [`unused/${index}.xml`, ""]));
  await fs.writeFile(path.join(cwd, "many.docx"), createOfficeZip(entries));

  const result = await previewFile(cwd, "many.docx");

  assert.equal(result.ok, true);
  assert.equal(result.file.kind, "office");
  assert.equal(result.file.parseErrorCode, "ZIP_ENTRY_LIMIT");
});

test("dashboard Office preview rejects high-ratio and damaged archives", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-files-office-budget-"));
  await fs.writeFile(path.join(cwd, "ratio.docx"), createOfficeZip({
    "word/document.xml": "A".repeat(1024 * 1024)
  }));
  await fs.writeFile(path.join(cwd, "damaged.docx"), Buffer.from("not a ZIP archive"));

  const ratio = await previewFile(cwd, "ratio.docx");
  const damaged = await previewFile(cwd, "damaged.docx");

  assert.equal(ratio.file.parseErrorCode, "ZIP_COMPRESSION_RATIO_LIMIT");
  assert.equal(damaged.file.parseErrorCode, "ZIP_EOCD_NOT_FOUND");
});

test("dashboard Office parser worker can be terminated on timeout", async () => {
  await assert.rejects(
    parseDocumentBufferAsync(createDocxBuffer("timeout"), ".docx", { timeoutMs: 1 }),
    (error) => error?.code === "OFFICE_PARSE_TIMEOUT"
  );
});

test("dashboard previews csv as lightweight table data", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-files-"));
  await fs.writeFile(path.join(cwd, "scores.csv"), "姓名,分数,备注\n张三,98,\"表现稳定\"\n李四,87,继续观察\n", "utf8");

  const result = await previewFile(cwd, "scores.csv");

  assert.equal(result.ok, true);
  assert.equal(result.file.kind, "table-preview");
  assert.equal(result.file.tableKind, "csv");
  assert.deepEqual(result.file.table.sheets[0].rows, [
    ["姓名", "分数", "备注"],
    ["张三", "98", "表现稳定"],
    ["李四", "87", "继续观察"]
  ]);
});

test("dashboard previews nested markdown assets through workspace-relative paths", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-files-"));
  await fs.mkdir(path.join(cwd, "reports", "images"), { recursive: true });
  await fs.writeFile(path.join(cwd, "reports", "report.md"), "![图](images/chart.png)", "utf8");
  await fs.writeFile(path.join(cwd, "reports", "images", "chart.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const markdown = await previewFile(cwd, "reports/report.md");
  const image = await previewFile(cwd, "reports/images/chart.png");

  assert.equal(markdown.ok, true);
  assert.equal(markdown.file.relativePath, path.join("reports", "report.md"));
  assert.equal(image.ok, true);
  assert.equal(image.file.kind, "image");
});

test("dashboard collects workflow and mentioned files inside workspace", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-files-"));
  await fs.writeFile(path.join(cwd, "chart.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await fs.writeFile(path.join(cwd, "report.md"), "# Report\n", "utf8");
  const session = {
    cwd,
    workflow: {
      changes: [
        { path: "report.md", created: true, toolName: "write_file" }
      ]
    }
  };

  const files = collectSessionFiles(session, "see chart.png and C:\\outside\\secret.txt");

  assert.equal(files.some((file) => file.relativePath === "report.md"), true);
  assert.equal(files.some((file) => file.relativePath === "chart.png"), true);
  assert.equal(files.some((file) => file.path.includes("secret.txt")), false);
});

test("dashboard skips mentioned image files that do not exist", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-files-"));
  const session = { cwd, workflow: { changes: [] } };

  const files = collectSessionFiles(session, "see missing.png");

  assert.equal(files.some((file) => file.relativePath === "missing.png"), false);
});

test("dashboard collects mentioned files when persisted workflow changes are summarized", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-files-"));
  await fs.writeFile(path.join(cwd, "chart.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const session = {
    cwd,
    workflow: {
      changes: { total: 1, created: 1, edited: 0, diffTruncated: 0 }
    }
  };

  const files = collectSessionFiles(session, "see chart.png");

  assert.equal(files.some((file) => file.relativePath === "chart.png"), true);
});
