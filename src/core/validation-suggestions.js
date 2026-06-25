import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * @param {string} cwd
 */
export async function suggestValidationCommands(cwd) {
  const suggestions = [];
  const pkg = await readJsonIfExists(path.join(cwd, "package.json"));
  const scripts = pkg?.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
  const changedFiles = await changedWorkspaceFiles(cwd);
  const hasPackage = Boolean(pkg);
  const changed = {
    source: hasChangedFile(changedFiles, SOURCE_FILE_RE),
    jsTs: hasChangedFile(changedFiles, JS_TS_FILE_RE),
    tests: hasChangedFile(changedFiles, TEST_FILE_RE),
    docs: hasChangedFile(changedFiles, DOC_FILE_RE),
    config: hasChangedFile(changedFiles, CONFIG_FILE_RE)
  };
  const hasAnyTrackedChange = changedFiles.length > 0;

  if (hasPackage) {
    const relatedTests = await relatedTestFiles(cwd, changedFiles);
    addNpmScriptSuggestion(suggestions, scripts, "check:syntax", "minimal syntax validation script", changed.source || changed.config, "minimal");
    addNpmScriptSuggestion(suggestions, scripts, "typecheck", "TypeScript or JavaScript type validation script", changed.jsTs, "related");
    addNpmScriptSuggestion(suggestions, scripts, "lint", "lint script for changed source/config files", changed.source || changed.config, "related");
    addNpmScriptSuggestion(suggestions, scripts, "format:check", "format check script for changed source/docs/config files", changed.source || changed.docs || changed.config, "related");
    addRelatedTestSuggestions(suggestions, scripts, relatedTests);
    addNpmScriptSuggestion(suggestions, scripts, "test:unit", "focused unit test script", changed.source || changed.tests, "related");
    addNpmTestSuggestion(suggestions, scripts, "package test script", !scripts["test:unit"] && (changed.source || changed.tests || !hasAnyTrackedChange), "related");
    addNpmScriptSuggestion(suggestions, scripts, "check", "full project check script", true, "full");
    addNpmScriptSuggestion(suggestions, scripts, "verify:release", "release verification script", true, "full");
  }

  if ((changed.source || changed.tests || !hasAnyTrackedChange)
    && (await exists(path.join(cwd, "pyproject.toml")) || await exists(path.join(cwd, "pytest.ini")))) {
    suggestions.push(suggestion("python -m pytest", "Python test configuration detected", "related", { source: "manifest" }));
  }
  if ((changed.source || changed.tests || !hasAnyTrackedChange) && await exists(path.join(cwd, "go.mod"))) {
    suggestions.push(suggestion("go test ./...", "Go module detected", "related", { source: "manifest" }));
  }
  if ((changed.source || changed.tests || !hasAnyTrackedChange) && await exists(path.join(cwd, "Cargo.toml"))) {
    suggestions.push(suggestion("cargo test", "Cargo project detected", "related", { source: "manifest" }));
  }
  return sortSuggestions(dedupeSuggestions(suggestions));
}

const SOURCE_FILE_RE = /\.(cjs|css|go|html|js|jsx|json|mjs|py|rs|ts|tsx|vue|yaml|yml)$/i;
const JS_TS_FILE_RE = /\.(cjs|js|jsx|mjs|ts|tsx)$/i;
const TEST_FILE_RE = /(^|[\\/])(__tests__|tests?|specs?)[\\/]|(\.|-)(test|spec)\.[^.]+$/i;
const DOC_FILE_RE = /\.(adoc|markdown|md|mdx|rst|txt)$/i;
const CONFIG_FILE_RE = /(^|[\\/])(\.?[^\\/]*(config|rc)[^\\/]*|package(-lock)?\.json|npm-shrinkwrap\.json|tsconfig\.json|jsconfig\.json|pyproject\.toml|go\.mod|Cargo\.toml)$/i;
const TEST_EXT_RE = /\.(cjs|js|jsx|mjs|ts|tsx)$/i;
const MAX_RELATED_TESTS = 3;
const MAX_SCAN_FILES = 5000;
const TIER_ORDER = new Map([
  ["minimal", 0],
  ["related", 1],
  ["full", 2]
]);

function addNpmScriptSuggestion(suggestions, scripts, scriptName, reason, relevant, tier = "related") {
  if (!relevant || !scripts[scriptName]) {
    return;
  }
  suggestions.push(suggestion(`npm run ${scriptName}`, reason, tier, { source: "package-script" }));
}

function addNpmTestSuggestion(suggestions, scripts, reason, relevant, tier = "related") {
  if (!relevant || !scripts.test) {
    return;
  }
  suggestions.push(suggestion("npm test", reason, tier, { source: "package-script" }));
}

function addRelatedTestSuggestions(suggestions, scripts, relatedTests) {
  if (!scripts["test:unit"] || relatedTests.length === 0) {
    return;
  }
  for (const file of relatedTests.slice(0, MAX_RELATED_TESTS)) {
    suggestions.push(suggestion(
      `npm run test:unit -- ${shellQuote(file)}`,
      `related test file for changed source: ${file}`,
      "related",
      { source: "related-test", confidence: "medium", relatedFiles: [file] }
    ));
  }
}

function suggestion(command, reason, tier = "related", extra = {}) {
  return {
    command,
    reason,
    tier: normalizeTier(tier),
    source: String(extra.source ?? "heuristic"),
    confidence: String(extra.confidence ?? "high"),
    relatedFiles: Array.isArray(extra.relatedFiles) ? extra.relatedFiles.map(String) : []
  };
}

function hasChangedFile(files, pattern) {
  return files.some((file) => pattern.test(file));
}

async function changedWorkspaceFiles(cwd) {
  const files = new Set();
  await collectGitChangedFiles(cwd, ["diff", "--name-only", "--diff-filter=ACMRT", "HEAD", "--"], files);
  await collectGitChangedFiles(cwd, ["diff", "--name-only", "--cached", "--diff-filter=ACMRT", "--"], files);
  await collectGitChangedFiles(cwd, ["ls-files", "--others", "--exclude-standard"], files);
  return Array.from(files);
}

async function collectGitChangedFiles(cwd, args, files) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
      windowsHide: true,
      timeout: 1500,
      maxBuffer: 256 * 1024
    });
    for (const line of stdout.split(/\r?\n/)) {
      const file = line.trim();
      if (file) {
        files.add(file);
      }
    }
  } catch {
    // Suggestions are best-effort; non-git workspaces still use config files.
  }
}

/**
 * @param {Array<{ command: string; reason: string }>} suggestions
 * @param {{ grouped?: boolean }} options
 */
export function formatValidationSuggestions(suggestions, options = {}) {
  const normalized = sortSuggestions(suggestions ?? []);
  if (normalized.length === 0) {
    return "No validation command suggestions found.";
  }

  if (options.grouped === false) {
    return normalized.map((item, index) => formatSuggestionLine(item, index)).join("\n");
  }

  let index = 0;
  const lines = [];
  for (const tier of ["minimal", "related", "full"]) {
    const items = normalized.filter((item) => normalizeTier(item.tier) === tier);
    if (items.length === 0) {
      continue;
    }
    lines.push(`${tier} validation:`);
    for (const item of items) {
      lines.push(formatSuggestionLine(item, index));
      index += 1;
    }
  }
  return lines.join("\n");
}

function formatSuggestionLine(item, index) {
  const files = Array.isArray(item.relatedFiles) && item.relatedFiles.length > 0
    ? ` [files: ${item.relatedFiles.join(", ")}]`
    : "";
  return `${index + 1}. ${item.command} - ${item.reason}${files}`;
}

/**
 * @param {Array<{ command: string; reason: string }>} suggestions
 */
export function flattenValidationSuggestions(suggestions) {
  return sortSuggestions(suggestions ?? []);
}

/**
 * @param {Array<{ command: string; reason: string }>} suggestions
 */
export function summarizeValidationSuggestionTiers(suggestions) {
  const summary = { minimal: 0, related: 0, full: 0 };
  for (const item of suggestions ?? []) {
    summary[normalizeTier(item.tier)] += 1;
  }
  return summary;
}

/**
 * @param {Array<{ command: string; reason: string }>} suggestions
 * @param {string} selector
 */
export function selectValidationSuggestion(suggestions, selector) {
  const normalizedSuggestions = sortSuggestions(suggestions ?? []);
  const normalized = selector.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  if (normalized === "suggested" || normalized === "first") {
    return normalizedSuggestions[0] ?? null;
  }

  const tierMatch = normalized.match(/^(minimal|related|full)$/);
  if (tierMatch) {
    return normalizedSuggestions.find((item) => normalizeTier(item.tier) === tierMatch[1]) ?? null;
  }

  const numeric = normalized.match(/^#?(\d+)$/);
  if (!numeric) {
    return null;
  }

  const index = Number.parseInt(numeric[1], 10) - 1;
  return Number.isInteger(index) && index >= 0 && index < normalizedSuggestions.length
    ? normalizedSuggestions[index]
    : null;
}

async function relatedTestFiles(cwd, changedFiles) {
  const sourceFiles = changedFiles
    .filter((file) => JS_TS_FILE_RE.test(file))
    .filter((file) => !TEST_FILE_RE.test(file));
  if (sourceFiles.length === 0) {
    return [];
  }

  const allFiles = await listWorkspaceFiles(cwd);
  const testFiles = allFiles.filter((file) => TEST_FILE_RE.test(file) && TEST_EXT_RE.test(file));
  const matches = [];
  for (const sourceFile of sourceFiles) {
    const sourceBase = baseNameWithoutExtensions(sourceFile);
    const sameDir = path.dirname(sourceFile);
    for (const testFile of testFiles) {
      const testBase = baseNameWithoutExtensions(testFile);
      if (testBase !== sourceBase) {
        continue;
      }
      if (path.dirname(testFile) === sameDir || /(^|[\\/])(__tests__|tests?|specs?)[\\/]/i.test(testFile)) {
        matches.push(testFile);
      }
    }
  }
  return Array.from(new Set(matches)).slice(0, MAX_RELATED_TESTS);
}

async function listWorkspaceFiles(cwd) {
  const files = [];
  await walk(cwd, "", files);
  return files;
}

async function walk(root, relativeDir, files) {
  if (files.length >= MAX_SCAN_FILES) {
    return;
  }
  const absoluteDir = path.join(root, relativeDir);
  let entries;
  try {
    entries = await fs.readdir(absoluteDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (files.length >= MAX_SCAN_FILES || shouldSkipDir(entry.name)) {
      continue;
    }
    const relativePath = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
    if (entry.isDirectory()) {
      await walk(root, relativePath, files);
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
}

function shouldSkipDir(name) {
  return name === ".git" || name === "node_modules" || name === "dist" || name === "build" || name === "coverage";
}

function baseNameWithoutExtensions(file) {
  const base = path.basename(file).replace(TEST_EXT_RE, "");
  return base.replace(/(\.|-)(test|spec)$/i, "");
}

function shellQuote(value) {
  const text = String(value ?? "");
  if (/^[A-Za-z0-9_./\\:-]+$/.test(text)) {
    return text;
  }
  return `"${text.replace(/(["`$\\])/g, "\\$1")}"`;
}

function normalizeTier(tier) {
  return TIER_ORDER.has(tier) ? tier : "related";
}

function sortSuggestions(suggestions) {
  return [...suggestions].sort((a, b) => {
    const tierDelta = (TIER_ORDER.get(normalizeTier(a.tier)) ?? 1) - (TIER_ORDER.get(normalizeTier(b.tier)) ?? 1);
    return tierDelta || 0;
  });
}

/**
 * @param {Array<{ command: string; reason: string }>} suggestions
 */
function dedupeSuggestions(suggestions) {
  const seen = new Set();
  return suggestions.filter((item) => {
    if (seen.has(item.command)) {
      return false;
    }
    seen.add(item.command);
    return true;
  });
}

/**
 * @param {string} filePath
 */
async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
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
