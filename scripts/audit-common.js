import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const AUDIT_DIR = path.join(ROOT, "docs", "audit");

export async function ensureAuditDir() {
  await fs.mkdir(AUDIT_DIR, { recursive: true });
}

/**
 * @param {string[]} roots
 * @param {{ extensions?: Set<string>; ignoreDirs?: Set<string> }} options
 */
export async function collectFiles(roots, options = {}) {
  const files = [];
  for (const root of roots) {
    const fullRoot = path.join(ROOT, root);
    const stat = await fs.stat(fullRoot).catch(() => null);
    if (!stat) {
      continue;
    }
    if (stat.isFile()) {
      if (matchesExtension(fullRoot, options.extensions)) {
        files.push(fullRoot);
      }
    } else {
      for await (const file of walk(fullRoot, options)) {
        files.push(file);
      }
    }
  }
  return files.sort();
}

/**
 * @param {string} filePath
 */
export function rel(filePath) {
  return path.relative(ROOT, filePath).split(path.sep).join("/");
}

/**
 * @param {unknown} value
 */
export function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * @param {string} root
 * @param {{ extensions?: Set<string>; ignoreDirs?: Set<string> }} options
 */
async function* walk(root, options) {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (!options.ignoreDirs?.has(entry.name)) {
        yield* walk(fullPath, options);
      }
    } else if (entry.isFile() && matchesExtension(fullPath, options.extensions)) {
      yield fullPath;
    }
  }
}

/**
 * @param {string} filePath
 * @param {Set<string> | undefined} extensions
 */
function matchesExtension(filePath, extensions) {
  return !extensions || extensions.has(path.extname(filePath));
}
