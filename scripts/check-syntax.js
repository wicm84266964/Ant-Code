#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOTS = Object.freeze(["src", "scripts", "tests"]);
const files = [];

for (const root of ROOTS) {
  for await (const file of walk(path.join(ROOT, root))) {
    if (file.endsWith(".js")) {
      files.push(file);
    }
  }
}

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], {
    cwd: ROOT,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || `Syntax check failed: ${file}\n`);
    process.exitCode = 1;
    break;
  }
}

if (!process.exitCode) {
  console.log(`Syntax check passed for ${files.length} files.`);
}

/**
 * @param {string} root
 */
async function* walk(root) {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walk(fullPath);
    } else if (entry.isFile()) {
      yield fullPath;
    }
  }
}
