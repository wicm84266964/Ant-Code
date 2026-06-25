import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isInside } from "../permissions/policy-engine.js";
import { normalizeToolPath } from "../permissions/path-utils.js";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);
const SKIP_DIRS = new Set([".git", ".lab-agent", "node_modules", "dist", "build", "coverage"]);
const DEFAULT_MAX_RESULTS = 100;
const DEFAULT_MAX_FILES = 200;

export async function tsSymbolsTool(input) {
  const service = await createTypeScriptService(input.cwd);
  if (!service.ok) return service;
  const filePath = await resolveWorkspaceFile(input.cwd, input.file);
  const tree = service.languageService.getNavigationTree(filePath);
  return {
    file: toDisplayPath(input.cwd, filePath),
    symbols: flattenNavigationTree(input.cwd, filePath, tree).slice(0, positiveInteger(input.maxResults, DEFAULT_MAX_RESULTS))
  };
}

export async function tsDiagnosticsTool(input) {
  const service = await createTypeScriptService(input.cwd);
  if (!service.ok) return service;
  const maxResults = positiveInteger(input.maxResults, DEFAULT_MAX_RESULTS);
  const files = input.file
    ? [await resolveWorkspaceFile(input.cwd, input.file)]
    : service.files.slice(0, positiveInteger(input.maxFiles, DEFAULT_MAX_FILES));
  const diagnostics = [];
  for (const file of files) {
    const all = [
      ...service.languageService.getSyntacticDiagnostics(file),
      ...service.languageService.getSemanticDiagnostics(file)
    ];
    for (const diagnostic of all) {
      diagnostics.push(formatDiagnostic(service.ts, input.cwd, file, diagnostic));
      if (diagnostics.length >= maxResults) {
        return { diagnostics, truncated: true, fileCount: files.length };
      }
    }
  }
  return { diagnostics, truncated: false, fileCount: files.length };
}

export async function tsFindDefinitionTool(input) {
  const service = await createTypeScriptService(input.cwd);
  if (!service.ok) return service;
  const filePath = await resolveWorkspaceFile(input.cwd, input.file);
  const position = await lineColumnToPosition(filePath, input.line, input.column);
  const definitions = service.languageService.getDefinitionAtPosition(filePath, position) ?? [];
  return {
    definitions: definitions
      .filter((item) => isInside(path.resolve(input.cwd), path.resolve(item.fileName)))
      .slice(0, positiveInteger(input.maxResults, DEFAULT_MAX_RESULTS))
      .map((item) => spanToLocation(service.ts, input.cwd, item.fileName, item.textSpan, item.name, item.kind))
  };
}

export async function tsFindReferencesTool(input) {
  const service = await createTypeScriptService(input.cwd);
  if (!service.ok) return service;
  const filePath = await resolveWorkspaceFile(input.cwd, input.file);
  const position = await lineColumnToPosition(filePath, input.line, input.column);
  const maxResults = positiveInteger(input.maxResults, DEFAULT_MAX_RESULTS);
  const refs = service.languageService.findReferences(filePath, position) ?? [];
  const references = [];
  for (const group of refs) {
    for (const ref of group.references ?? []) {
      if (!isInside(path.resolve(input.cwd), path.resolve(ref.fileName))) continue;
      references.push({
        ...spanToLocation(service.ts, input.cwd, ref.fileName, ref.textSpan, group.definition?.name, group.definition?.kind),
        isDefinition: ref.isDefinition === true
      });
      if (references.length >= maxResults) {
        return { references, truncated: true };
      }
    }
  }
  return { references, truncated: false };
}

async function createTypeScriptService(cwd) {
  const ts = await import("typescript").catch((error) => null);
  if (!ts) {
    return { ok: false, error: { code: "TYPESCRIPT_NOT_AVAILABLE", message: "The typescript package is not installed." } };
  }
  const workspace = path.resolve(cwd);
  const configPath = ts.findConfigFile(workspace, ts.sys.fileExists, "tsconfig.json");
  const parsed = configPath ? parseTsConfig(ts, configPath) : null;
  const files = parsed?.fileNames?.filter((file) => SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase())) ?? await collectSourceFiles(workspace);
  const options = {
    allowJs: true,
    checkJs: true,
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    target: ts.ScriptTarget.ES2022,
    skipLibCheck: true,
    ...(parsed?.options ?? {})
  };
  const versions = new Map(files.map((file) => [path.resolve(file), "0"]));
  const host = {
    getScriptFileNames: () => Array.from(versions.keys()),
    getScriptVersion: (fileName) => versions.get(path.resolve(fileName)) ?? "0",
    getScriptSnapshot: (fileName) => {
      const text = ts.sys.readFile(fileName);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => workspace,
    getCompilationSettings: () => options,
    getDefaultLibFileName: (compilerOptions) => ts.getDefaultLibFilePath(compilerOptions),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
    realpath: ts.sys.realpath,
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames
  };
  return {
    ok: true,
    ts,
    files: Array.from(versions.keys()),
    languageService: ts.createLanguageService(host, ts.createDocumentRegistry())
  };
}

function parseTsConfig(ts, configPath) {
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) return null;
  return ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(configPath), { allowJs: true, checkJs: true }, configPath);
}

async function collectSourceFiles(root) {
  const files = [];
  await walk(root, files);
  return files;
}

async function walk(dir, files) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await walk(full, files);
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(full);
    }
  }
}

function flattenNavigationTree(cwd, filePath, tree) {
  const symbols = [];
  const visit = (node, container = "") => {
    if (node.text && node.kind !== "script") {
      const location = spanToLocationFromNumber(cwd, filePath, node.spans?.[0]?.start ?? 0, node.spans?.[0]?.length ?? 0);
      symbols.push({ name: node.text, kind: node.kind, container, ...location });
    }
    for (const child of node.childItems ?? []) {
      visit(child, node.text || container);
    }
  };
  visit(tree);
  return symbols;
}

function formatDiagnostic(ts, cwd, file, diagnostic) {
  const text = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  const location = spanToLocationFromNumber(cwd, file, diagnostic.start ?? 0, diagnostic.length ?? 0);
  return {
    ...location,
    code: diagnostic.code,
    category: ts.DiagnosticCategory[diagnostic.category] ?? String(diagnostic.category),
    message: text
  };
}

function spanToLocation(ts, cwd, fileName, span, name, kind) {
  return {
    name,
    kind,
    ...spanToLocationFromNumber(cwd, fileName, span.start, span.length)
  };
}

function spanToLocationFromNumber(cwd, fileName, start, length) {
  const text = readFileSyncFallback(fileName);
  const startPos = offsetToLineColumn(text, start);
  const endPos = offsetToLineColumn(text, start + length);
  return {
    file: toDisplayPath(cwd, fileName),
    startLine: startPos.line,
    startColumn: startPos.column,
    endLine: endPos.line,
    endColumn: endPos.column
  };
}

function readFileSyncFallback(fileName) {
  try {
    return readFileSync(fileName, "utf8");
  } catch {
    return "";
  }
}

async function resolveWorkspaceFile(cwd, file) {
  const workspace = path.resolve(cwd);
  const resolved = path.resolve(workspace, normalizeToolPath(file));
  if (!isInside(workspace, resolved)) {
    throw toolError("PATH_OUTSIDE_WORKSPACE", "path resolves outside workspace");
  }
  if (!SOURCE_EXTENSIONS.has(path.extname(resolved).toLowerCase())) {
    throw toolError("UNSUPPORTED_SOURCE_FILE", "TypeScript semantic tools support .ts, .tsx, .js, and .jsx files");
  }
  await fs.access(resolved);
  return resolved;
}

async function lineColumnToPosition(filePath, line, column) {
  const text = await fs.readFile(filePath, "utf8");
  const targetLine = Math.max(1, Number.parseInt(String(line ?? 1), 10));
  const targetColumn = Math.max(1, Number.parseInt(String(column ?? 1), 10));
  let offset = 0;
  let currentLine = 1;
  while (currentLine < targetLine && offset < text.length) {
    const next = text.indexOf("\n", offset);
    if (next < 0) return text.length;
    offset = next + 1;
    currentLine += 1;
  }
  return Math.min(text.length, offset + targetColumn - 1);
}

function offsetToLineColumn(text, offset) {
  const safe = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let column = 1;
  for (let index = 0; index < safe; index += 1) {
    if (text[index] === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

function toDisplayPath(cwd, filePath) {
  return path.relative(path.resolve(cwd), path.resolve(filePath)).split(path.sep).join("/") || ".";
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function toolError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
