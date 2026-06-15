import fs from "node:fs/promises";
import path from "node:path";
import { diagnoseWorkspace } from "./workspace-diagnostics.js";

const DEFAULT_MAX_SCRIPTS = 20;
const DEFAULT_MAX_ENTRYPOINTS = 12;
const SKIP_DIRS = new Set([".git", ".lab-agent", "node_modules", "dist", "build", "coverage"]);

const DIRECTORY_ROLES = new Map([
  ["src", "source"],
  ["lib", "source"],
  ["app", "application"],
  ["packages", "workspace-packages"],
  ["tests", "tests"],
  ["test", "tests"],
  ["__tests__", "tests"],
  ["docs", "docs"],
  ["scripts", "automation"],
  ["config", "configuration"],
  ["tools", "tooling"],
  ["examples", "examples"],
  ["notebooks", "notebooks"]
]);

const MANIFEST_TYPES = new Map([
  ["package.json", "node"],
  ["pyproject.toml", "python"],
  ["requirements.txt", "python"],
  ["pytest.ini", "python"],
  ["go.mod", "go"],
  ["Cargo.toml", "rust"],
  ["CMakeLists.txt", "cpp"],
  ["Makefile", "make"],
  ["lab-agent.config.json", "ant-code-config"],
  ["README.md", "docs"],
  [".gitignore", "git"]
]);

const PACKAGE_MANAGER_LOCKS = new Map([
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lockb", "bun"]
]);

/**
 * @param {string} cwd
 * @param {{ maxScripts?: number; maxEntrypoints?: number }} options
 */
export async function buildRepoMap(cwd, options = {}) {
  const workspace = path.resolve(cwd);
  const entries = await fs.readdir(workspace, { withFileTypes: true }).catch(() => []);
  const names = new Set(entries.map((entry) => entry.name));
  const packageJson = await readJsonIfExists(path.join(workspace, "package.json"));
  const maxScripts = options.maxScripts ?? DEFAULT_MAX_SCRIPTS;
  const maxEntrypoints = options.maxEntrypoints ?? DEFAULT_MAX_ENTRYPOINTS;

  const manifestFiles = sortedKnownFiles(names, MANIFEST_TYPES);
  const packageManagers = sortedKnownFiles(names, PACKAGE_MANAGER_LOCKS)
    .map((name) => PACKAGE_MANAGER_LOCKS.get(name));
  const projectTypes = detectProjectTypes(names, packageJson);
  const keyDirectories = await collectKeyDirectories(workspace, entries);
  const packageSummary = summarizePackage(packageJson, maxScripts);
  const workspaceDiagnostic = await diagnoseWorkspace(workspace);

  return {
    rootName: path.basename(workspace),
    workspace: workspaceDiagnostic,
    projectTypes,
    packageManagers: uniqueSorted(packageManagers),
    manifestFiles,
    keyDirectories,
    package: packageSummary,
    sourceEntrypoints: await collectSourceEntrypoints(workspace, packageJson, maxEntrypoints),
    testEntrypoints: await collectTestEntrypoints(workspace, packageJson, names, maxEntrypoints)
  };
}

/**
 * @param {Awaited<ReturnType<typeof buildRepoMap>>} repoMap
 * @param {{ includeHeader?: boolean }} options
 */
export function formatRepoMap(repoMap, options = {}) {
  const lines = [
    `root: ${repoMap.rootName}`,
    `workspace: ${repoMap.workspace?.warning ?? "looks usable"}`,
    `project types: ${formatList(repoMap.projectTypes)}`,
    `package managers: ${formatList(repoMap.packageManagers)}`,
    `manifest files: ${formatList(repoMap.manifestFiles)}`
  ];

  if (options.includeHeader !== false) {
    lines.unshift("Ant Code repository map", "");
  }

  if (repoMap.package) {
    const privacy = repoMap.package.private ? "private" : "public";
    const type = repoMap.package.type ? `, type=${repoMap.package.type}` : "";
    lines.push(`package: ${repoMap.package.name ?? "unnamed"} (${privacy}${type})`);
    lines.push(`scripts: ${formatList(repoMap.package.scriptNames)}`);
    lines.push(`bins: ${formatList(repoMap.package.bins)}`);
    if (repoMap.package.workspaces !== null) {
      lines.push(`workspaces: ${repoMap.package.workspaces}`);
    }
  }

  lines.push("", "Key directories", formatListBlock(repoMap.keyDirectories, (entry) => `${entry.path} - ${entry.role}`));
  lines.push("", "Source entrypoints", formatListBlock(repoMap.sourceEntrypoints, formatEntrypoint));
  lines.push("", "Test entrypoints", formatListBlock(repoMap.testEntrypoints, formatEntrypoint));

  return lines.join("\n");
}

/**
 * @param {string} workspace
 * @param {import("node:fs").Dirent[]} entries
 */
async function collectKeyDirectories(workspace, entries) {
  const result = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) {
      continue;
    }
    const role = DIRECTORY_ROLES.get(entry.name);
    if (!role) {
      continue;
    }
    result.push({
      path: toPosix(entry.name),
      role,
      entries: await countImmediateEntries(path.join(workspace, entry.name))
    });
  }
  return result;
}

/**
 * @param {string} workspace
 * @param {Record<string, any> | null} packageJson
 * @param {number} maxEntrypoints
 */
async function collectSourceEntrypoints(workspace, packageJson, maxEntrypoints) {
  const candidates = [];
  if (packageJson?.main && typeof packageJson.main === "string") {
    candidates.push({ kind: "package-main", path: packageJson.main });
  }
  if (typeof packageJson?.bin === "string") {
    candidates.push({ kind: "package-bin", name: packageJson.name ?? "bin", path: packageJson.bin });
  } else if (packageJson?.bin && typeof packageJson.bin === "object") {
    for (const [name, target] of Object.entries(packageJson.bin).sort(([a], [b]) => a.localeCompare(b))) {
      if (typeof target === "string") {
        candidates.push({ kind: "package-bin", name, path: target });
      }
    }
  }

  for (const candidate of ["src/index.js", "src/cli/index.js", "index.js", "main.py", "app.py"]) {
    if (await exists(path.join(workspace, candidate))) {
      candidates.push({ kind: "known-file", path: candidate });
    }
  }

  return dedupeEntrypoints(candidates).slice(0, maxEntrypoints);
}

/**
 * @param {string} workspace
 * @param {Record<string, any> | null} packageJson
 * @param {Set<string>} rootNames
 * @param {number} maxEntrypoints
 */
async function collectTestEntrypoints(workspace, packageJson, rootNames, maxEntrypoints) {
  const candidates = [];
  const scripts = packageJson?.scripts && typeof packageJson.scripts === "object" ? packageJson.scripts : {};
  for (const name of Object.keys(scripts).sort()) {
    if (/^(test|check|verify|lint|typecheck|ci)(:|$)/i.test(name)) {
      candidates.push({
        kind: "package-script",
        name,
        command: name === "test" ? "npm test" : `npm run ${name}`
      });
    }
  }

  for (const dir of ["tests", "test", "__tests__"]) {
    if (rootNames.has(dir) && await isDirectory(path.join(workspace, dir))) {
      candidates.push({ kind: "test-directory", path: dir });
    }
  }
  if (rootNames.has("pytest.ini") || rootNames.has("pyproject.toml")) {
    candidates.push({ kind: "python-test-config", command: "python -m pytest" });
  }
  if (rootNames.has("go.mod")) {
    candidates.push({ kind: "go-test", command: "go test ./..." });
  }
  if (rootNames.has("Cargo.toml")) {
    candidates.push({ kind: "cargo-test", command: "cargo test" });
  }

  return dedupeEntrypoints(candidates).slice(0, maxEntrypoints);
}

/**
 * @param {Set<string>} names
 * @param {Record<string, any> | null} packageJson
 */
function detectProjectTypes(names, packageJson) {
  const types = [];
  for (const [name, type] of MANIFEST_TYPES.entries()) {
    if (names.has(name)) {
      types.push(type);
    }
  }
  if (packageJson?.workspaces) {
    types.push("monorepo");
  }
  return uniqueSorted(types);
}

/**
 * @param {Record<string, any> | null} packageJson
 * @param {number} maxScripts
 */
function summarizePackage(packageJson, maxScripts) {
  if (!packageJson) {
    return null;
  }
  const scripts = packageJson.scripts && typeof packageJson.scripts === "object"
    ? Object.keys(packageJson.scripts).sort().slice(0, maxScripts)
    : [];

  return {
    name: typeof packageJson.name === "string" ? packageJson.name : null,
    private: Boolean(packageJson.private),
    type: typeof packageJson.type === "string" ? packageJson.type : null,
    scriptNames: scripts,
    bins: summarizeBins(packageJson.bin),
    workspaces: countWorkspaces(packageJson.workspaces)
  };
}

/**
 * @param {unknown} bin
 */
function summarizeBins(bin) {
  if (typeof bin === "string") {
    return ["default"];
  }
  if (!bin || typeof bin !== "object") {
    return [];
  }
  return Object.keys(bin).sort();
}

/**
 * @param {unknown} workspaces
 */
function countWorkspaces(workspaces) {
  if (Array.isArray(workspaces)) {
    return workspaces.length;
  }
  if (workspaces && typeof workspaces === "object" && Array.isArray(workspaces.packages)) {
    return workspaces.packages.length;
  }
  return null;
}

/**
 * @param {Set<string>} names
 * @param {Map<string, string>} known
 */
function sortedKnownFiles(names, known) {
  return [...known.keys()].filter((name) => names.has(name)).sort();
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
 * @param {string} dir
 */
async function countImmediateEntries(dir) {
  return fs.readdir(dir).then((entries) => entries.length).catch(() => 0);
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

/**
 * @param {string} filePath
 */
async function isDirectory(filePath) {
  return fs.stat(filePath).then((stat) => stat.isDirectory()).catch(() => false);
}

/**
 * @param {Array<Record<string, any>>} entries
 */
function dedupeEntrypoints(entries) {
  const seen = new Set();
  return entries.filter((entry) => {
    const key = [entry.kind, entry.name ?? "", entry.path ?? "", entry.command ?? ""].join("\0");
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  }).map((entry) => ({
    ...entry,
    path: entry.path ? toPosix(entry.path) : undefined
  }));
}

/**
 * @param {string[]} items
 */
function uniqueSorted(items) {
  return [...new Set(items.filter(Boolean))].sort();
}

/**
 * @param {string} value
 */
function toPosix(value) {
  return value.split(path.sep).join("/");
}

/**
 * @param {string[]} items
 */
function formatList(items) {
  return items.length === 0 ? "none" : items.join(", ");
}

/**
 * @param {Array<Record<string, any>>} items
 * @param {(item: Record<string, any>) => string} formatter
 */
function formatListBlock(items, formatter) {
  return items.length === 0
    ? "none"
    : items.map((item) => `- ${formatter(item)}`).join("\n");
}

/**
 * @param {Record<string, any>} entry
 */
function formatEntrypoint(entry) {
  const label = entry.name ? `${entry.name}: ` : "";
  return `${entry.kind} - ${label}${entry.command ?? entry.path ?? "unknown"}`;
}
