#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
const PROVENANCE = path.join(ROOT, "docs", "provenance", "modules");

const modules = await sourceModules();
const missing = [];

for (const moduleName of modules) {
  const record = path.join(PROVENANCE, `${moduleName}.md`);
  if (!(await exists(record))) {
    missing.push(path.relative(ROOT, record));
  }
}

if (missing.length > 0) {
  console.error("Missing provenance records:");
  for (const file of missing) {
    console.error(`- ${file}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Provenance check passed for ${modules.length} source modules.`);
}

async function sourceModules() {
  const entries = await fs.readdir(SRC, { withFileTypes: true });
  const names = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (await hasSourceFile(path.join(SRC, entry.name))) {
      names.push(entry.name);
    }
  }
  return names.sort();
}

/**
 * @param {string} dir
 */
async function hasSourceFile(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.endsWith(".js")) {
      return true;
    }
    if (entry.isDirectory() && await hasSourceFile(fullPath)) {
      return true;
    }
  }
  return false;
}

/**
 * @param {string} filePath
 */
async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
