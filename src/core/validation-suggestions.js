import fs from "node:fs/promises";
import path from "node:path";

/**
 * @param {string} cwd
 */
export async function suggestValidationCommands(cwd) {
  const suggestions = [];
  const pkg = await readJsonIfExists(path.join(cwd, "package.json"));
  const scripts = pkg?.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
  if (scripts["verify:release"]) {
    suggestions.push({ command: "npm run verify:release", reason: "project release verification script" });
  }
  if (scripts.check) {
    suggestions.push({ command: "npm run check", reason: "project check script" });
  }
  if (scripts.test) {
    suggestions.push({ command: "npm test", reason: "package test script" });
  }
  if (await exists(path.join(cwd, "pyproject.toml")) || await exists(path.join(cwd, "pytest.ini"))) {
    suggestions.push({ command: "python -m pytest", reason: "Python test configuration detected" });
  }
  if (await exists(path.join(cwd, "go.mod"))) {
    suggestions.push({ command: "go test ./...", reason: "Go module detected" });
  }
  if (await exists(path.join(cwd, "Cargo.toml"))) {
    suggestions.push({ command: "cargo test", reason: "Cargo project detected" });
  }
  return dedupeSuggestions(suggestions);
}

/**
 * @param {Array<{ command: string; reason: string }>} suggestions
 */
export function formatValidationSuggestions(suggestions) {
  return suggestions.length === 0
    ? "No validation command suggestions found."
    : suggestions.map((item, index) => `${index + 1}. ${item.command} - ${item.reason}`).join("\n");
}

/**
 * @param {Array<{ command: string; reason: string }>} suggestions
 * @param {string} selector
 */
export function selectValidationSuggestion(suggestions, selector) {
  const normalized = selector.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  if (normalized === "suggested" || normalized === "first") {
    return suggestions[0] ?? null;
  }

  const numeric = normalized.match(/^#?(\d+)$/);
  if (!numeric) {
    return null;
  }

  const index = Number.parseInt(numeric[1], 10) - 1;
  return Number.isInteger(index) && index >= 0 && index < suggestions.length
    ? suggestions[index]
    : null;
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
