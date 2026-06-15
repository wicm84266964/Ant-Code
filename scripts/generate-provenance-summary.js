#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { AUDIT_DIR, ROOT, ensureAuditDir, rel } from "./audit-common.js";

const MODULES_DIR = path.join(ROOT, "docs", "provenance", "modules");
const entries = await fs.readdir(MODULES_DIR, { withFileTypes: true });
const records = [];

for (const entry of entries) {
  if (!entry.isFile() || !entry.name.endsWith(".md")) {
    continue;
  }
  const filePath = path.join(MODULES_DIR, entry.name);
  const text = await fs.readFile(filePath, "utf8");
  records.push({
    file: rel(filePath),
    ...parseFrontMatter(text)
  });
}

records.sort((a, b) => String(a.module).localeCompare(String(b.module)));

const lines = [
  "# Provenance Summary",
  "",
  "Generated: not-recorded-deterministic-artifact",
  "",
  "| Module | Status | Old Source Exposure | Record |",
  "| --- | --- | --- | --- |",
  ...records.map((record) => `| ${record.module ?? "unknown"} | ${record.implementation_status ?? "unknown"} | ${record.implementer_old_source_exposure ?? "unknown"} | ${record.file} |`),
  "",
  "## Review Notes",
  "",
  "- Every source module must have a matching provenance record.",
  "- Generated summary is evidence for release review; module records remain the source of truth.",
  ""
];

await ensureAuditDir();
const outputPath = path.join(AUDIT_DIR, "provenance-summary.generated.md");
await fs.writeFile(outputPath, lines.join("\n"), "utf8");
console.log(`Provenance summary written to ${rel(outputPath)}.`);

/**
 * @param {string} text
 */
function parseFrontMatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    return {};
  }

  const result = {};
  for (const line of match[1].split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon === -1 || line.startsWith("  - ")) {
      continue;
    }
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    result[key] = value;
  }
  return result;
}
