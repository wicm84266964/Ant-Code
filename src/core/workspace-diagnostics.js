import fs from "node:fs/promises";
import path from "node:path";

const SOURCE_MARKERS = new Set([
  ".git",
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "go.mod",
  "Cargo.toml",
  "CMakeLists.txt",
  "Makefile",
  "README.md",
  "lab-agent.config.json"
]);

const SOURCE_DIRECTORIES = new Set([
  "src",
  "lib",
  "app",
  "packages",
  "tests",
  "test",
  "__tests__",
  "docs",
  "scripts",
  "config"
]);

const RUNTIME_DATA_DIRS = new Set([".lab-agent", ".ant-code"]);

/**
 * @param {string} cwd
 */
export async function diagnoseWorkspace(cwd) {
  const workspace = path.resolve(cwd);
  const entries = await fs.readdir(workspace, { withFileTypes: true }).catch(() => []);
  const names = entries.map((entry) => entry.name).sort((a, b) => a.localeCompare(b));
  const sourceMarkers = names.filter((name) => SOURCE_MARKERS.has(name));
  const sourceDirectories = entries
    .filter((entry) => entry.isDirectory() && SOURCE_DIRECTORIES.has(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  const runtimeDataDirs = entries
    .filter((entry) => entry.isDirectory() && RUNTIME_DATA_DIRS.has(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  const nonRuntimeEntries = names.filter((name) => !RUNTIME_DATA_DIRS.has(name));
  const runtimeDataOnly = entries.length > 0 && runtimeDataDirs.length > 0 && nonRuntimeEntries.length === 0;
  const unreadableOrEmpty = entries.length === 0;
  const hasSourceSignals = sourceMarkers.length > 0 || sourceDirectories.length > 0;

  return {
    cwd: workspace,
    entryCount: entries.length,
    sourceMarkers,
    sourceDirectories,
    runtimeDataDirs,
    runtimeDataOnly,
    hasSourceSignals,
    warning: workspaceWarning({ runtimeDataOnly, unreadableOrEmpty })
  };
}

/**
 * @param {Awaited<ReturnType<typeof diagnoseWorkspace>>} diagnostic
 * @param {{ includeCwd?: boolean }} [options]
 */
export function formatWorkspaceDiagnosticLines(diagnostic, options = {}) {
  if (!diagnostic) {
    return ["- workspace check unavailable"];
  }
  const markers = [
    ...(diagnostic.sourceMarkers ?? []),
    ...(diagnostic.sourceDirectories ?? []).map((item) => `${item}/`)
  ];
  return [
    ...(options.includeCwd ? [`- cwd: ${diagnostic.cwd}`] : []),
    `- source markers: ${markers.length > 0 ? markers.join(", ") : "none detected"}`,
    `- runtime data dirs: ${(diagnostic.runtimeDataDirs ?? []).length > 0 ? diagnostic.runtimeDataDirs.join(", ") : "none"}`,
    diagnostic.warning
      ? `- Warning: ${diagnostic.warning}`
      : "- Workspace looks usable for local project inspection."
  ];
}

function workspaceWarning({ runtimeDataOnly, unreadableOrEmpty }) {
  if (runtimeDataOnly) {
    return "当前 cwd 看起来只包含 Ant Code 运行数据目录；如果你原本想调查某个项目，请从那个项目目录启动 ant-code，或让模型先确认目标路径。";
  }
  if (unreadableOrEmpty) {
    return "当前 cwd 为空或不可读取；文件工具和子智能体只能基于可见路径工作，请确认目标项目目录。";
  }
  return null;
}
