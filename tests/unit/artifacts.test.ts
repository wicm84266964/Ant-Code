import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectShellArtifacts, extractCandidatePaths, serializeExhibitArtifacts } from "../../src/tools/artifacts.ts";

test("extractCandidatePaths keeps unicode, markdown, and quoted artifact paths", () => {
  const paths = extractCandidatePaths([
    "见 `图1.png` 和 [报表](reports/成绩.xlsx)",
    "saved \"outputs/final.md\"",
    "https://example.com/remote.png should be ignored"
  ].join("\n"));

  assert.equal(paths.includes("图1.png"), true);
  assert.equal(paths.includes("reports/成绩.xlsx"), true);
  assert.equal(paths.includes("outputs/final.md"), true);
  assert.equal(paths.some((item) => /^https?:/i.test(item)), false);
});

test("collectShellArtifacts picks up silent image writes and announced reports", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-artifacts-"));
  await fs.mkdir(path.join(cwd, "outputs"));
  await fs.mkdir(path.join(cwd, "node_modules", "pkg"), { recursive: true });
  await fs.writeFile(path.join(cwd, "outputs", "chart.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await fs.writeFile(path.join(cwd, "report.md"), "# Report\n", "utf8");
  await fs.writeFile(path.join(cwd, "stale.txt"), "old", "utf8");
  await fs.writeFile(path.join(cwd, "node_modules", "pkg", "noise.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const stale = path.join(cwd, "stale.txt");
  const past = new Date(Date.now() - 60_000);
  await fs.utimes(stale, past, past);

  const artifacts = collectShellArtifacts(cwd, {
    command: "python plot.py",
    stdout: "wrote report.md\n",
    stderr: "",
    durationMs: 250
  });
  const relativePaths = artifacts.map((item) => item.path.replace(/\\/g, "/"));

  assert.equal(relativePaths.includes("outputs/chart.png"), true);
  assert.equal(relativePaths.includes("report.md"), true);
  assert.equal(relativePaths.includes("stale.txt"), false);
  assert.equal(relativePaths.some((item) => item.includes("node_modules")), false);
});

test("serializeExhibitArtifacts keeps previewable outputs and skips ordinary text paths", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-artifacts-persist-"));
  await fs.writeFile(path.join(cwd, "chart.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await fs.writeFile(path.join(cwd, "notes.txt"), "hello", "utf8");

  const artifacts = serializeExhibitArtifacts(cwd, [
    { path: "chart.png", created: true },
    { path: "notes.txt", created: true },
    { path: "missing.png", created: true }
  ]);

  assert.deepEqual(artifacts.map((item) => item.relativePath.replace(/\\/g, "/")), ["chart.png"]);
  assert.equal(artifacts[0]?.source, "created");
});

test("collectShellArtifacts does not treat package.json as a silent walk artifact", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-artifacts-json-"));
  await fs.writeFile(path.join(cwd, "package.json"), "{\"ok\":true}\n", "utf8");

  const artifacts = collectShellArtifacts(cwd, {
    command: "echo ready",
    stdout: "ready\n",
    durationMs: 20
  });

  assert.equal(artifacts.some((item) => item.path.endsWith("package.json")), false);
});
