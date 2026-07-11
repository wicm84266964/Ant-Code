import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import ts from "typescript";

const MAX_TSC_OUTPUT_BYTES = 256 * 1024 * 1024;

/**
 * @typedef {{ typescriptVersion: string, diagnostics: Record<string, Record<string, number>> }} TypeBaseline
 */

/**
 * @param {{ root: string, projectPath: string, baseline: TypeBaseline, scopePaths?: string[] }} options
 */
export async function runTypeRatchet(options) {
  const root = path.resolve(options.root);
  const scopePaths = options.scopePaths ?? await collectDashboardTypeScope(root);
  const scope = new Set(scopePaths.map(normalizeRelativePath));
  const compilerPackage = JSON.parse(await fs.readFile(
    path.join(root, "node_modules", "typescript", "package.json"),
    "utf8"
  ));

  if (compilerPackage.version !== options.baseline.typescriptVersion) {
    return {
      ok: false,
      failures: [`TypeScript ${compilerPackage.version} is installed; baseline requires ${options.baseline.typescriptVersion}`],
      currentCount: 0,
      reductions: 0,
      scopeCount: scope.size
    };
  }

  const compilerPath = path.join(root, "node_modules", "typescript", "bin", "tsc");
  const result = spawnSync(process.execPath, [
    compilerPath,
    "--noEmit",
    "--project",
    options.projectPath,
    "--pretty",
    "false"
  ], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: MAX_TSC_OUTPUT_BYTES,
    windowsHide: true
  });

  if (result.error) {
    return {
      ok: false,
      failures: [`TypeScript could not run: ${result.error.message}`],
      currentCount: 0,
      reductions: 0,
      scopeCount: scope.size
    };
  }

  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const parsed = parseTypeScriptDiagnostics(output, root);
  if (result.status !== 0 && parsed.diagnostics.length === 0 && parsed.globalErrors.length === 0) {
    return {
      ok: false,
      failures: [`TypeScript exited with status ${result.status} without parseable diagnostics`, output.trim()].filter(Boolean),
      currentCount: 0,
      reductions: 0,
      scopeCount: scope.size
    };
  }

  const infrastructureFailures = parsed.globalErrors.map((code) => `TypeScript reported global error ${code}`);
  /** @type {Record<string, Record<string, number>>} */
  const current = {};
  for (const diagnostic of parsed.diagnostics) {
    if (!scope.has(diagnostic.file)) {
      if (!isIgnoredTransitiveDiagnostic(diagnostic.file)) {
        infrastructureFailures.push(`TypeScript reported out-of-scope project error ${diagnostic.file} ${diagnostic.code}`);
      }
      continue;
    }
    current[diagnostic.file] ??= {};
    current[diagnostic.file][diagnostic.code] = (current[diagnostic.file][diagnostic.code] ?? 0) + 1;
  }

  const comparison = compareTypeDiagnosticCounts(options.baseline.diagnostics, current);
  return {
    ok: infrastructureFailures.length === 0 && comparison.failures.length === 0,
    failures: [...infrastructureFailures, ...comparison.failures],
    currentCount: comparison.currentCount,
    reductions: comparison.reductions,
    scopeCount: scope.size
  };
}

/**
 * @param {{ root: string, projectPath: string }} options
 */
export function runStrictTypeCheck(options) {
  const result = executeTypeScript(options.root, options.projectPath);
  if (result.error) {
    return { ok: false, output: `TypeScript could not run: ${result.error.message}` };
  }
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  return {
    ok: result.status === 0,
    output
  };
}

/**
 * @param {Record<string, Record<string, number>>} baseline
 * @param {Record<string, Record<string, number>>} current
 */
export function compareTypeDiagnosticCounts(baseline, current) {
  const failures = [];
  let currentCount = 0;
  let reductions = 0;

  for (const [file, codes] of Object.entries(current)) {
    for (const [code, count] of Object.entries(codes)) {
      currentCount += count;
      const allowed = baseline[file]?.[code] ?? 0;
      if (count > allowed) {
        failures.push(`${file} ${code}: ${count} diagnostics (baseline allows ${allowed})`);
      }
    }
  }
  for (const [file, codes] of Object.entries(baseline)) {
    for (const [code, allowed] of Object.entries(codes)) {
      const count = current[file]?.[code] ?? 0;
      if (count < allowed) {
        reductions += allowed - count;
      }
    }
  }

  return { failures, currentCount, reductions };
}

/**
 * @param {string} output
 * @param {string} root
 */
export function parseTypeScriptDiagnostics(output, root) {
  const diagnostics = [];
  const globalErrors = [];
  const diagnosticPattern = /^(.+?)\((\d+),(\d+)\): error TS(\d+):/gm;
  const globalPattern = /^error TS(\d+):/gm;
  let match;

  while ((match = diagnosticPattern.exec(output)) !== null) {
    const absolutePath = path.isAbsolute(match[1]) ? match[1] : path.resolve(root, match[1]);
    diagnostics.push({
      file: normalizeRelativePath(path.relative(root, absolutePath)),
      code: `TS${match[4]}`
    });
  }
  while ((match = globalPattern.exec(output)) !== null) {
    globalErrors.push(`TS${match[1]}`);
  }
  return { diagnostics, globalErrors };
}

/**
 * Include every Dashboard source file plus one layer of internal relative imports.
 *
 * @param {string} root
 */
export async function collectDashboardTypeScope(root) {
  const dashboardRoot = path.join(root, "src", "dashboard");
  const dashboardFiles = (await collectJavaScriptFiles(dashboardRoot, dashboardRoot))
    .filter((file) => !isGeneratedDashboardAsset(path.relative(dashboardRoot, file)));
  const scope = new Set(dashboardFiles.map((file) => normalizeRelativePath(path.relative(root, file))));

  for (const file of dashboardFiles) {
    const source = await fs.readFile(file, "utf8");
    const imports = ts.preProcessFile(source, true, true).importedFiles;
    for (const imported of imports) {
      if (!imported.fileName.startsWith(".")) {
        continue;
      }
      const resolved = await resolveJavaScriptImport(path.dirname(file), imported.fileName);
      if (resolved && isPathWithin(root, resolved) && !isGeneratedDashboardAsset(path.relative(dashboardRoot, resolved))) {
        scope.add(normalizeRelativePath(path.relative(root, resolved)));
      }
    }
  }
  return [...scope].sort();
}

/**
 * @param {string} root
 * @param {string} dashboardRoot
 * @returns {Promise<string[]>}
 */
async function collectJavaScriptFiles(root, dashboardRoot) {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    const relativePath = normalizeRelativePath(path.relative(dashboardRoot, fullPath));
    if (entry.isDirectory()) {
      if (relativePath === "public/vendor") {
        continue;
      }
      files.push(...await collectJavaScriptFiles(fullPath, dashboardRoot));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * @param {string} fromDirectory
 * @param {string} specifier
 */
async function resolveJavaScriptImport(fromDirectory, specifier) {
  const candidate = path.resolve(fromDirectory, specifier);
  for (const filePath of [candidate, `${candidate}.js`, path.join(candidate, "index.js")]) {
    const stat = await fs.stat(filePath).catch(() => null);
    if (stat?.isFile()) {
      return filePath;
    }
  }
  return null;
}

/**
 * @param {string} root
 * @param {string} candidate
 */
function isPathWithin(root, candidate) {
  const relativePath = path.relative(root, candidate);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

/**
 * @param {string} file
 */
function isIgnoredTransitiveDiagnostic(file) {
  return file.startsWith("src/") || file.startsWith("node_modules/");
}

/**
 * @param {string} value
 */
function isGeneratedDashboardAsset(value) {
  const relativePath = normalizeRelativePath(value);
  return relativePath === "public/vendor" || relativePath.startsWith("public/vendor/");
}

/**
 * @param {string} value
 */
function normalizeRelativePath(value) {
  return value.replaceAll("\\", "/");
}

/**
 * @param {string} root
 * @param {string} projectPath
 */
function executeTypeScript(root, projectPath) {
  const compilerPath = path.join(root, "node_modules", "typescript", "bin", "tsc");
  return spawnSync(process.execPath, [
    compilerPath,
    "--noEmit",
    "--project",
    projectPath,
    "--pretty",
    "false"
  ], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: MAX_TSC_OUTPUT_BYTES,
    windowsHide: true
  });
}
