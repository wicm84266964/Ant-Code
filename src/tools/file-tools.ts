import fs from "node:fs/promises";
import path from "node:path";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { isInside, isSecretPath } from "../permissions/policy-engine.ts";
import { normalizeToolPath } from "../permissions/path-utils.ts";
import { countLineChanges, createUnifiedDiff } from "./diff.ts";

const SKIP_DIRS = new Set([".git", ".lab-agent", ".venv", "__pycache__", "node_modules", "dist", "build", "coverage"]);
export const DEFAULT_FILE_LIST_MAX_ENTRIES = 200;
export const DEFAULT_FILE_SEARCH_MAX_MATCHES = 200;
const BINARY_EXTENSIONS = new Set([
  ".7z", ".avi", ".bin", ".bmp", ".ckpt", ".db", ".dll", ".doc", ".docx", ".dylib", ".exe", ".gif", ".gz",
  ".ico", ".jpeg", ".jpg", ".mov", ".mp4", ".npy", ".npz", ".onnx", ".pdf", ".pkl", ".png", ".pt", ".pth",
  ".pyc", ".rar", ".safetensors", ".so", ".sqlite", ".sqlite3", ".tar", ".tiff", ".webp", ".xls", ".xlsx",
  ".zip"
]);

/**
 * @param {{ cwd: string; path: string; maxBytes?: number; policy?: Record<string, any> }} input
 */
export async function readFileTool(input: { cwd: string; path: string; maxBytes?: number; policy?: Record<string, unknown> }) {
  const filePath = await resolveWorkspacePath(input.cwd, input.path, { allowOutsideWorkspace: canUseOutsideWorkspace(input.policy) });
  await fs.access(filePath).catch((error: unknown) => {
    if (isNotFoundError(error)) {
      throw notFoundToolError("FILE_NOT_FOUND", "file not found", input.cwd, input.path, filePath);
    }
    throw error;
  });
  const explicitMaxBytes = positiveIntegerOrNull(input.maxBytes);
  if (!explicitMaxBytes) {
    const content = await fs.readFile(filePath, "utf8");
    return {
      path: toDisplayPath(input.cwd, filePath),
      bytesRead: Buffer.byteLength(content, "utf8"),
      truncated: false,
      content
    };
  }
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(explicitMaxBytes);
    const result = await handle.read(buffer, 0, explicitMaxBytes, 0);
    const stat = await handle.stat();
    return {
      path: toDisplayPath(input.cwd, filePath),
      bytesRead: result.bytesRead,
      truncated: stat.size > result.bytesRead,
      content: buffer.subarray(0, result.bytesRead).toString("utf8")
    };
  } finally {
    await handle.close();
  }
}

/**
 * @param {{ cwd: string; path?: string; policy?: Record<string, any> }} input
 */
export async function listFilesTool(input: { cwd: string; path?: string; maxEntries?: number; policy?: Record<string, unknown> }) {
  const dirPath = await resolveWorkspacePath(input.cwd, input.path ?? ".", { allowOutsideWorkspace: canUseOutsideWorkspace(input.policy) });
  const entries = await fs.readdir(dirPath, { withFileTypes: true }).catch((error: unknown) => {
    if (isNotFoundError(error)) {
      throw notFoundToolError("DIRECTORY_NOT_FOUND", "directory not found", input.cwd, input.path ?? ".", dirPath);
    }
    throw error;
  });
  const mapped = entries.map((entry) => ({
    name: entry.name,
    type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other"
  }));
  const maxEntries = positiveIntegerOrNull(input.maxEntries) ?? DEFAULT_FILE_LIST_MAX_ENTRIES;
  return {
    path: toDisplayPath(input.cwd, dirPath),
    entries: mapped.slice(0, maxEntries),
    total: mapped.length,
    truncated: mapped.length > maxEntries
  };
}

/**
 * @param {{ cwd: string; pattern: string; path?: string; maxMatches?: number; policy?: Record<string, any> }} input
 */
export async function globTool(input: { cwd: string; pattern: string; path?: string; maxMatches?: number; policy?: Record<string, unknown> }) {
  const root = await resolveWorkspacePath(input.cwd, input.path ?? ".", { allowOutsideWorkspace: canUseOutsideWorkspace(input.policy) });
  const maxMatches = positiveIntegerOrNull(input.maxMatches) ?? DEFAULT_FILE_SEARCH_MAX_MATCHES;
  const regex = globToRegex(input.pattern);
  const matches: string[] = [];

  for await (const filePath of walkPaths(root)) {
    const relativeToRoot = toPosix(path.relative(root, filePath));
    const relativeToCwd = toDisplayPath(input.cwd, filePath);
    if (regex.test(relativeToRoot) || regex.test(relativeToCwd)) {
      matches.push(relativeToCwd);
      if (maxMatches && matches.length >= maxMatches) {
        break;
      }
    }
  }

  return { matches, truncated: Boolean(maxMatches && matches.length >= maxMatches) };
}

/**
 * @param {{ cwd: string; pattern: string; path?: string; maxMatches?: number; policy?: Record<string, any> }} input
 */
export async function grepTool(input: { cwd: string; pattern: string; path?: string; maxMatches?: number; policy?: Record<string, unknown> }) {
  const root = await resolveWorkspacePath(input.cwd, input.path ?? ".", { allowOutsideWorkspace: canUseOutsideWorkspace(input.policy) });
  const maxMatches = positiveIntegerOrNull(input.maxMatches) ?? DEFAULT_FILE_SEARCH_MAX_MATCHES;
  const matches: Array<{ path: string; line: number; text: string }> = [];

  for await (const filePath of walkTextFiles(root)) {
    if (maxMatches && matches.length >= maxMatches) {
      break;
    }
    let lineNumber = 0;
    try {
      for await (const line of readLines(filePath)) {
        lineNumber += 1;
        if (!line.includes(input.pattern)) {
          continue;
        }
        matches.push({
          path: toDisplayPath(input.cwd, filePath),
          line: lineNumber,
          text: line
        });
        if (maxMatches && matches.length >= maxMatches) {
          break;
        }
      }
    } catch {
      continue;
    }
  }

  return { matches, truncated: Boolean(maxMatches && matches.length >= maxMatches) };
}

/**
 * @param {{ cwd: string; path: string; content: string; policy?: Record<string, any> }} input
 */
export async function writeFileTool(input: { cwd: string; path: string; content: string; policy?: Record<string, unknown> }) {
  const filePath = await resolveWorkspacePath(input.cwd, input.path, { allowMissingTarget: true, allowOutsideWorkspace: canUseOutsideWorkspace(input.policy) });
  const displayPath = toDisplayPath(input.cwd, filePath);
  const existed = await fs.stat(filePath).then(() => true).catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  });
  const before = await fs.readFile(filePath, "utf8").catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return "";
    }
    throw error;
  });

  await fs.writeFile(filePath, input.content, "utf8");

  const diff = createFileDiff({
    absolutePath: filePath,
    filePath: displayPath,
    before,
    after: input.content
  });
  const changeStats = createFileChangeStats({
    path: displayPath,
    before,
    after: input.content,
    diff,
    redacted: diff.redacted === true
  });

  const result = {
    path: displayPath,
    created: !existed,
    bytesWritten: Buffer.byteLength(input.content, "utf8"),
    diff: diff.text,
    diffTruncated: diff.truncated,
    diffRedacted: diff.redacted === true,
    changeStats
  };
  attachChangeSnapshot(result, {
    absolutePath: filePath,
    before,
    after: input.content,
    redacted: diff.redacted === true
  });
  return result;
}

/**
 * @param {{ cwd: string; path: string; oldText: string; newText: string; expectedReplacements?: number; dryRun?: boolean; policy?: Record<string, any> }} input
 */
export async function editFileTool(input: { cwd: string; path: string; oldText: string; newText: string; expectedReplacements?: number; dryRun?: boolean; policy?: Record<string, unknown> }) {
  const filePath = await resolveWorkspacePath(input.cwd, input.path, { allowOutsideWorkspace: canUseOutsideWorkspace(input.policy) });
  const displayPath = toDisplayPath(input.cwd, filePath);
  const before = await fs.readFile(filePath, "utf8").catch((error: unknown) => {
    if (isNotFoundError(error)) {
      throw notFoundToolError("FILE_NOT_FOUND", "file not found", input.cwd, input.path, filePath);
    }
    throw error;
  });
  const expectedReplacements = normalizeExpectedReplacements(input.expectedReplacements);
  const oldText = String(input.oldText ?? "");
  const newText = String(input.newText ?? "");
  const replacements = countOccurrences(before, oldText);
  const base = {
    path: displayPath,
    dryRun: Boolean(input.dryRun),
    replacements,
    expectedReplacements,
    beforeBytes: Buffer.byteLength(before, "utf8"),
    oldTextBytes: Buffer.byteLength(oldText, "utf8"),
    newTextBytes: Buffer.byteLength(newText, "utf8")
  };

  if (oldText.length === 0) {
    return {
      ...base,
      edited: false,
      error: {
        code: "EMPTY_OLD_TEXT",
        message: "oldText must not be empty"
      }
    };
  }

  if (expectedReplacements === null) {
    return {
      ...base,
      expectedReplacements: input.expectedReplacements,
      edited: false,
      error: {
        code: "INVALID_EXPECTED_REPLACEMENTS",
        message: "expectedReplacements must be a positive integer"
      }
    };
  }

  if (oldText === newText) {
    return {
      ...base,
      edited: false,
      error: {
        code: "NOOP_EDIT",
        message: "oldText and newText are identical"
      }
    };
  }

  if (replacements !== expectedReplacements) {
    return {
      ...base,
      edited: false,
      error: {
        code: replacements === 0 ? "OLD_TEXT_NOT_FOUND" : "REPLACEMENT_COUNT_MISMATCH",
        message: `Expected ${expectedReplacements} replacement(s), found ${replacements}`
      }
    };
  }

  const after = before.split(oldText).join(newText);
  const diff = createFileDiff({ absolutePath: filePath, filePath: displayPath, before, after });
  const changeStats = createFileChangeStats({
    path: displayPath,
    before,
    after,
    diff,
    redacted: diff.redacted === true
  });
  const result = {
    ...base,
    afterBytes: Buffer.byteLength(after, "utf8"),
    diff: diff.text,
    diffTruncated: diff.truncated,
    diffRedacted: diff.redacted === true,
    changeStats
  };

  if (input.dryRun) {
    return {
      ...result,
      edited: false,
      wouldEdit: true
    };
  }

  await fs.writeFile(filePath, after, "utf8");

  const written = {
    ...result,
    edited: true,
    bytesWritten: result.afterBytes
  };
  attachChangeSnapshot(written, {
    absolutePath: filePath,
    before,
    after,
    redacted: diff.redacted === true
  });
  return written;
}

/**
 * @param {string} root
 */
async function* walkTextFiles(root: string) {
  for await (const filePath of walkPaths(root)) {
    if (await looksTextual(filePath)) {
      yield filePath;
    }
  }
}

/**
 * @param {string} root
 */
async function* walkPaths(root: string): AsyncGenerator<string> {
  const rootStat = await fs.stat(root).catch(() => null);
  if (!rootStat) {
    return;
  }
  if (rootStat.isFile()) {
    yield root;
    return;
  }
  if (!rootStat.isDirectory()) {
    return;
  }
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        yield fullPath;
        yield* walkPaths(fullPath);
      }
    } else if (entry.isFile()) {
      yield fullPath;
    }
  }
}

/**
 * @param {string} fileName
 */
async function looksTextual(fileName: string) {
  if (BINARY_EXTENSIONS.has(path.extname(fileName).toLowerCase())) {
    return false;
  }
  return !await hasBinaryHeader(fileName);
}

async function hasBinaryHeader(fileName: string) {
  const handle = await fs.open(fileName, "r").catch(() => null);
  if (!handle) {
    return true;
  }
  try {
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0).catch(() => ({ bytesRead: 0, failed: true }));
    if (bytesRead === 0) {
      const stat = await handle.stat().catch(() => null);
      return stat ? !stat.isFile() : true;
    }
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

function readLines(fileName: string) {
  return createInterface({
    input: createReadStream(fileName, { encoding: "utf8" }),
    crlfDelay: Infinity
  });
}

/**
 * @param {{ absolutePath: string; filePath: string; before: string; after: string; maxBytes?: number }} input
 */
function createFileDiff(input: { absolutePath: string; filePath: string; before: string; after: string; maxBytes?: number }): {
  text: string;
  truncated: boolean;
  redacted?: boolean;
  bytes: number;
} {
  if (!isSecretPath(input.absolutePath)) {
    return { ...createUnifiedDiff(input), redacted: false };
  }
  const beforeBytes = Buffer.byteLength(input.before, "utf8");
  const afterBytes = Buffer.byteLength(input.after, "utf8");
  return {
    text: [
      `--- a/${input.filePath}`,
      `+++ b/${input.filePath}`,
      "@@ sensitive file diff redacted @@",
      `[sensitive diff redacted: ${beforeBytes} -> ${afterBytes} bytes]`
    ].join("\n"),
    truncated: false,
    redacted: true,
    bytes: beforeBytes + afterBytes
  };
}

function createFileChangeStats(input: {
  path: string;
  before: string;
  after: string;
  diff: { truncated?: boolean };
  redacted?: boolean;
}) {
  const lineStats = input.redacted
    ? { additions: 0, deletions: 0, approximate: false }
    : countLineChanges(input.before, input.after);
  return {
    path: input.path,
    additions: lineStats.additions,
    deletions: lineStats.deletions,
    files: 1,
    redacted: input.redacted === true,
    truncated: input.diff.truncated === true,
    approximate: lineStats.approximate === true
  };
}

function attachChangeSnapshot(result: Record<string, unknown>, snapshot: {
  absolutePath: string;
  before: string;
  after: string;
  redacted?: boolean;
}) {
  Object.defineProperty(result, "__changeSnapshot", {
    value: {
      path: snapshot.absolutePath,
      before: snapshot.redacted ? null : snapshot.before,
      after: snapshot.redacted ? null : snapshot.after,
      redacted: snapshot.redacted === true
    },
    enumerable: false,
    configurable: false
  });
}

/**
 * @param {string} cwd
 * @param {string} filePath
 */
function toRelativePath(cwd: string, filePath: string) {
  return toPosix(path.relative(cwd, filePath) || ".");
}

/**
 * @param {string} cwd
 * @param {string} filePath
 */
function toDisplayPath(cwd: string, filePath: string) {
  const workspace = path.resolve(cwd);
  const resolved = path.resolve(filePath);
  if (isInside(workspace, resolved)) {
    return toRelativePath(workspace, resolved);
  }
  return toPosix(resolved);
}

/**
 * @param {string} value
 */
function toPosix(value: string) {
  return value.split(path.sep).join("/");
}

/**
 * @param {string} pattern
 */
function globToRegex(pattern: string) {
  const normalized = toPosix(pattern).replace(/^\.?\//, "");
  let source = "^";

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];

    if (char === "*" && next === "*") {
      index += 1;
      if (normalized[index + 1] === "/") {
        index += 1;
        source += "(?:.*\\/)?";
      } else {
        source += ".*";
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else if (char === "/") {
      source += "\\/";
    } else {
      source += escapeRegex(char);
    }
  }

  source += "$";
  return new RegExp(source);
}

/**
 * @param {string} value
 */
function escapeRegex(value: string) {
  return value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}

/**
 * @param {string} cwd
 * @param {string} targetPath
 * @param {{ allowMissingTarget?: boolean; allowOutsideWorkspace?: boolean }} options
 */
async function resolveWorkspacePath(cwd: string, targetPath: string, options: { allowMissingTarget?: boolean; allowOutsideWorkspace?: boolean } = {}) {
  const workspace = path.resolve(cwd);
  const normalizedTarget = normalizeToolPath(targetPath);
  const resolved = path.resolve(workspace, normalizedTarget);

  if (!options.allowOutsideWorkspace && !isInside(workspace, resolved)) {
    throw toolError("PATH_OUTSIDE_WORKSPACE", "path resolves outside workspace");
  }

  if (!options.allowOutsideWorkspace) {
    await ensureNoSymlinkEscape(workspace, resolved, options);
  }
  return resolved;
}

function canUseOutsideWorkspace(policy: Record<string, unknown> = {}) {
  return Boolean(policy.fullAccess || policy.approvedOutsideWorkspace);
}

/**
 * @param {string} workspace
 * @param {string} resolved
 * @param {{ allowMissingTarget?: boolean }} options
 */
async function ensureNoSymlinkEscape(workspace: string, resolved: string, options: { allowMissingTarget?: boolean }) {
  const relative = path.relative(workspace, resolved);
  const parts = relative ? relative.split(path.sep) : [];
  let current = workspace;

  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    const isFinal = index === parts.length - 1;
    const stat = await fs.lstat(current).catch((error: unknown) => {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT" &&
        isFinal &&
        options.allowMissingTarget
      ) {
        return null;
      }
      throw error;
    });

    if (!stat) {
      return;
    }

    if (stat.isSymbolicLink()) {
      const real = await fs.realpath(current);
      if (!isInside(workspace, real)) {
        throw toolError("SYMLINK_ESCAPE", "path follows a symlink outside workspace");
      }
      throw toolError("SYMLINK_REQUIRES_APPROVAL", "symlink paths require explicit approval under the default safety policy");
    }
  }
}

/**
 * @param {string} text
 * @param {string} search
 */
function countOccurrences(text: string, search: string) {
  if (search.length === 0) {
    return 0;
  }
  return text.split(search).length - 1;
}

/**
 * @param {unknown} value
 */
function normalizeExpectedReplacements(value: unknown) {
  if (value === undefined || value === null) {
    return 1;
  }
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function positiveIntegerOrNull(value: unknown) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

/**
 * @param {string} code
 * @param {string} message
 */
function toolError(code: string, message: string) {
  const error = new Error(message) as Error & { code?: string };
  error.code = code;
  return error;
}

function isNotFoundError(error: unknown) {
  return error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function notFoundToolError(code: string, message: string, cwd: string, originalPath: unknown, resolvedPath: string) {
  return toolError(code, `${message}: ${toDisplayPath(cwd, resolvedPath)} (from path=${JSON.stringify(originalPath)})`);
}
