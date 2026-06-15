import fs from "node:fs/promises";
import path from "node:path";

export const PROJECT_RULE_FILES = Object.freeze([
  "ANTCODE.md",
  "AGENTS.md",
  "AGENT.md",
  "CLAUDE.md",
  "LAB_AGENT.md"
]);
export const LOCAL_MEMORY_FILE = path.join(".lab-agent", "memory.md");

/**
 * @param {{ cwd: string }} options
 */
export async function loadProjectMemory(options) {
  return (await loadProjectMemoryManifest(options)).memories;
}

/**
 * @param {{ cwd: string }} options
 */
export async function loadProjectMemoryManifest(options) {
  const active = [];
  const skippedRules = [];
  let activeRule = null;
  for (const name of PROJECT_RULE_FILES) {
    const filePath = path.join(options.cwd, name);
    const content = await readOptionalFile(filePath);
    if (content === null) {
      continue;
    }
    const item = {
      path: filePath,
      name,
      content,
      kind: "project-rule"
    };
    if (!activeRule) {
      activeRule = item;
      active.push(item);
    } else {
      skippedRules.push({ path: filePath, name, kind: "project-rule" });
    }
  }
  const localMemoryPath = path.join(options.cwd, LOCAL_MEMORY_FILE);
  const localMemoryContent = await readOptionalFile(localMemoryPath);
  const localMemory = localMemoryContent === null
    ? null
    : {
        path: localMemoryPath,
        name: LOCAL_MEMORY_FILE,
        content: localMemoryContent,
        kind: "local-memory"
      };
  if (localMemory) {
    active.push(localMemory);
  }
  return {
    memories: active,
    activeRule,
    skippedRules,
    localMemory
  };
}

async function readOptionalFile(filePath) {
  return fs.readFile(filePath, "utf8").catch((error) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  });
}
