import fs from "node:fs/promises";
import path from "node:path";
import { diagnoseWorkspace } from "./workspace-diagnostics.ts";

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

type PackageJson = {
  name?: unknown;
  private?: unknown;
  type?: unknown;
  main?: unknown;
  bin?: unknown;
  scripts?: unknown;
  workspaces?: unknown;
};

type RepoEntrypoint = {
  kind: string;
  name?: unknown;
  path?: string;
  command?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {string} cwd
 * @param {{ maxScripts?: number; maxEntrypoints?: number }} options
 */
export async function buildRepoMap(cwd: string, options: { maxScripts?: number; maxEntrypoints?: number } = {}) {
  const workspace = path.resolve(cwd);
  const entries = await fs.readdir(workspace, { withFileTypes: true }).catch(() => []);
  const names = new Set(entries.map((entry) => entry.name));
  const packageJson = await readJsonIfExists(path.join(workspace, "package.json"));
  const maxScripts = options.maxScripts ?? DEFAULT_MAX_SCRIPTS;
  const maxEntrypoints = options.maxEntrypoints ?? DEFAULT_MAX_ENTRYPOINTS;

  const manifestFiles = sortedKnownFiles(names, MANIFEST_TYPES);
  const packageManagers = sortedKnownFiles(names, PACKAGE_MANAGER_LOCKS)
    .map((name: string) => PACKAGE_MANAGER_LOCKS.get(name));
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
export function formatRepoMap(repoMap: Awaited<ReturnType<typeof buildRepoMap>>, options: { includeHeader?: boolean } = {}) {
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
async function collectKeyDirectories(workspace: string, entries: import("node:fs").Dirent[]) {
  const result = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
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
async function collectSourceEntrypoints(workspace: string, packageJson: PackageJson | null, maxEntrypoints: number) {
  const candidates: RepoEntrypoint[] = [];
  if (packageJson?.main && typeof packageJson.main === "string") {
    candidates.push({ kind: "package-main", path: packageJson.main });
  }
  if (typeof packageJson?.bin === "string") {
    candidates.push({ kind: "package-bin", name: packageJson.name ?? "bin", path: packageJson.bin });
  } else if (isRecord(packageJson?.bin)) {
    for (const [name, target] of Object.entries(packageJson.bin).sort(([left], [right]) => left.localeCompare(right))) {
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
async function collectTestEntrypoints(workspace: string, packageJson: PackageJson | null, rootNames: Set<string>, maxEntrypoints: number) {
  const candidates: RepoEntrypoint[] = [];
  const scripts = isRecord(packageJson?.scripts) ? packageJson.scripts : {};
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
function detectProjectTypes(names: Set<string>, packageJson: PackageJson | null) {
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
function summarizePackage(packageJson: PackageJson | null, maxScripts: number) {
  if (!packageJson) {
    return null;
  }
  const scripts = isRecord(packageJson.scripts)
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
function summarizeBins(bin: unknown) {
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
function countWorkspaces(workspaces: unknown) {
  if (Array.isArray(workspaces)) {
    return workspaces.length;
  }
  if (isRecord(workspaces) && Array.isArray(workspaces.packages)) {
    return workspaces.packages.length;
  }
  return null;
}

/**
 * @param {Set<string>} names
 * @param {Map<string, string>} known
 */
function sortedKnownFiles(names: Set<string>, known: Map<string, string>) {
  return [...known.keys()].filter((name: string) => names.has(name)).sort();
}

/**
 * @param {string} filePath
 */
async function readJsonIfExists(filePath: string): Promise<PackageJson | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    return isRecord(parsed) ? parsed : null;
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
async function countImmediateEntries(dir: string) {
  return fs.readdir(dir).then((entries) => entries.length).catch(() => 0);
}

/**
 * @param {string} filePath
 */
async function exists(filePath: string) {
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
async function isDirectory(filePath: string) {
  return fs.stat(filePath).then((stat) => stat.isDirectory()).catch(() => false);
}

/**
 * @param {Array<Record<string, any>>} entries
 */
function dedupeEntrypoints(entries: RepoEntrypoint[]) {
  const seen = new Set<string>();
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
function uniqueSorted(items: Array<string | undefined>) {
  return [...new Set(items.filter((item): item is string => Boolean(item)))].sort();
}

/**
 * @param {string} value
 */
function toPosix(value: string) {
  return value.split(path.sep).join("/");
}

/**
 * @param {string[]} items
 */
function formatList(items: string[]) {
  return items.length === 0 ? "none" : items.join(", ");
}

/**
 * @param {Array<Record<string, any>>} items
 * @param {(item: Record<string, any>) => string} formatter
 */
function formatListBlock<T>(items: T[], formatter: (item: T) => string) {
  return items.length === 0
    ? "none"
    : items.map((item) => `- ${formatter(item)}`).join("\n");
}

/**
 * @param {Record<string, any>} entry
 */
function formatEntrypoint(entry: RepoEntrypoint) {
  const label = entry.name ? `${entry.name}: ` : "";
  return `${entry.kind} - ${label}${entry.command ?? entry.path ?? "unknown"}`;
}
