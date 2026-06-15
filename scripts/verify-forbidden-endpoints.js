#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_ROOTS = Object.freeze(["src", "scripts", "tests"]);
const EXTENSIONS = new Set([".js", ".json"]);
const ALLOWLIST = Object.freeze([
  "scripts/verify-forbidden-endpoints.js",
  "scripts/verify-release-seal.js"
]);
const FORBIDDEN = Object.freeze([
  ["claude", ".ai"].join(""),
  ["api", ".anthropic", ".com/api/", "claude_code"].join(""),
  ["platform", ".claude", ".com/oauth"].join(""),
  ["mcp-proxy", ".anthropic", ".com"].join(""),
  ["http-intake", ".logs", ".us5", ".datadoghq", ".com"].join(""),
  ["growth", "book"].join(""),
  ["stats", "ig"].join(""),
  ["data", "dog"].join(""),
  ["shared_session", "_transcripts"].join(""),
  ["claude_cli", "_feedback"].join("")
]);

const findings = [];
for (const root of SCAN_ROOTS) {
  for await (const filePath of walk(path.join(ROOT, root))) {
    const relativePath = toPosix(path.relative(ROOT, filePath));
    if (ALLOWLIST.includes(relativePath)) {
      continue;
    }
    if (!EXTENSIONS.has(path.extname(filePath))) {
      continue;
    }
    const text = await fs.readFile(filePath, "utf8");
    for (const pattern of FORBIDDEN) {
      const line = findLine(text, pattern);
      if (line) {
        findings.push({ file: relativePath, pattern, line });
      }
    }
  }
}

/**
 * @param {string} value
 */
function toPosix(value) {
  return value.split(path.sep).join("/");
}

if (findings.length > 0) {
  console.error("Forbidden endpoint or service marker found in runtime source:");
  for (const finding of findings) {
    console.error(`- ${finding.file}:${finding.line} contains ${finding.pattern}`);
  }
  process.exitCode = 1;
} else {
  console.log("Forbidden endpoint scan passed.");
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

/**
 * @param {string} text
 * @param {string} pattern
 */
function findLine(text, pattern) {
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].toLowerCase().includes(pattern.toLowerCase())) {
      return index + 1;
    }
  }
  return null;
}
