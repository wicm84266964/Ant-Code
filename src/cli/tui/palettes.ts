import fs from "node:fs/promises";
import path from "node:path";
import { listSlashCommands } from "../../commands/registry.ts";

const MAX_FILE_CANDIDATES = 80;
const SKIP_DIRS = new Set([".git", "node_modules", "dist", ".lab-agent"]);

type SlashCommand = ReturnType<typeof listSlashCommands>[number];

export type FileMentionCandidate = {
  path: string;
  type: string;
};

type FileCandidateScore = {
  value: number;
  match: string;
};

type ScoredFileCandidate = FileMentionCandidate & {
  score: FileCandidateScore;
  recent: boolean;
  label: string;
  match: string;
};

/**
 * @param {string} draft
 */
export function slashPaletteState(draft: string) {
  if (!draft.startsWith("/")) {
    return null;
  }
  const query = draft.slice(1).trim().toLowerCase();
  const commands = listSlashCommands()
    .filter((command: SlashCommand) => {
      const aliases = Array.isArray(command.aliases) ? command.aliases : [];
      return !query
        || command.name.includes(query)
        || String(command.title ?? "").toLowerCase().includes(query)
        || command.description.toLowerCase().includes(query)
        || aliases.some((alias) => String(alias).toLowerCase().includes(query));
    })
    .map((command: SlashCommand) => ({
      ...command,
      disabledReason: command.disabledReason ?? null
    }));
  return {
    query,
    commands
  };
}

/**
 * @param {Array<Record<string, any>>} items
 * @param {number} current
 * @param {number} direction
 */
export function movePaletteIndex(items: unknown[] = [], current: number, direction: number) {
  if (!Array.isArray(items) || items.length === 0) {
    return 0;
  }
  return (current + direction + items.length) % items.length;
}

/**
 * @param {string} draft
 */
export function fileMentionState(draft: string) {
  const match = /(^|\s)@([^\s]*)$/.exec(draft);
  if (!match) {
    return null;
  }
  return {
    start: match.index + match[1].length,
    fragment: match[2] ?? ""
  };
}

/**
 * @param {{ cwd: string; fragment?: string; recentFiles?: string[] }} options
 */
export async function listFileMentionCandidates(options: { cwd: string; fragment?: string; recentFiles?: string[] }) {
  const fragment = normalizeFragment(options.fragment ?? "");
  const recentFiles = new Set((options.recentFiles ?? []).map(normalizeFragment));
  const candidates: FileMentionCandidate[] = [];
  const seen = new Set<string>();
  await addRecentCandidates(options.cwd, recentFiles, candidates, seen);
  await walk(options.cwd, "", candidates, seen);
  return candidates
    .map((item): ScoredFileCandidate => {
      const score = scoreFileCandidate(item, fragment, recentFiles);
      return {
        ...item,
        score,
        recent: recentFiles.has(item.path),
        label: item.type === "directory" ? "dir" : item.type,
        match: score.match
      };
    })
    .filter((item) => item.score.value >= 0)
    .sort(compareFileCandidates)
    .map(({ score, ...item }) => item)
    .slice(0, MAX_FILE_CANDIDATES);
}

/**
 * @param {string} draft
 * @param {{ start: number; fragment: string }} state
 * @param {string} selectedPath
 */
export function insertFileMention(draft: string, state: { start: number; fragment: string }, selectedPath: string) {
  return `${draft.slice(0, state.start)}@${selectedPath} `;
}

/**
 * @param {string} value
 */
function normalizeFragment(value: string) {
  return value.replace(/\\/g, "/").replace(/^@/, "");
}

function scoreFileCandidate(item: FileMentionCandidate, fragment: string, recentFiles: Set<string>): FileCandidateScore {
  const pathText = item.path.toLowerCase();
  const baseName = path.basename(item.path).toLowerCase();
  const query = fragment.toLowerCase();
  const recentBonus = recentFiles.has(item.path) ? 35 : 0;
  const typeBonus = item.type === "file" ? 5 : 0;
  if (!query) {
    return {
      value: recentBonus + typeBonus - item.path.length / 100,
      match: recentFiles.has(item.path) ? "recent" : "workspace"
    };
  }
  if (pathText === query || baseName === query) {
    return { value: 120 + recentBonus + typeBonus, match: "exact" };
  }
  if (pathText.startsWith(query)) {
    return { value: 105 + recentBonus + typeBonus - item.path.length / 100, match: "path-prefix" };
  }
  if (baseName.startsWith(query)) {
    return { value: 95 + recentBonus + typeBonus - baseName.length / 100, match: "name-prefix" };
  }
  const includesAt = pathText.indexOf(query);
  if (includesAt >= 0) {
    return { value: 75 + recentBonus + typeBonus - includesAt / 10, match: "contains" };
  }
  const fuzzy = fuzzySubsequenceScore(pathText, query);
  if (fuzzy >= 0) {
    return { value: 45 + fuzzy + recentBonus + typeBonus, match: "fuzzy" };
  }
  return { value: -1, match: "no-match" };
}

function fuzzySubsequenceScore(text: string, query: string) {
  let searchIndex = 0;
  let previousIndex = -1;
  let score = 0;
  for (const char of query) {
    const found = text.indexOf(char, searchIndex);
    if (found < 0) {
      return -1;
    }
    score += previousIndex >= 0 && found === previousIndex + 1 ? 4 : 1;
    previousIndex = found;
    searchIndex = found + 1;
  }
  return score - Math.max(0, text.length - query.length) / 50;
}

function compareFileCandidates(left: ScoredFileCandidate, right: ScoredFileCandidate) {
  if (right.score.value !== left.score.value) {
    return right.score.value - left.score.value;
  }
  if (left.type !== right.type) {
    return left.type === "directory" ? -1 : right.type === "directory" ? 1 : left.type.localeCompare(right.type);
  }
  return left.path.localeCompare(right.path);
}

/**
 * @param {string} root
 * @param {Set<string>} recentFiles
 * @param {Array<Record<string, any>>} output
 * @param {Set<string>} seen
 */
async function addRecentCandidates(root: string, recentFiles: Set<string>, output: FileMentionCandidate[], seen: Set<string>) {
  for (const relativePath of recentFiles) {
    if (!relativePath || seen.has(relativePath) || isSkippedRelativePath(relativePath)) {
      continue;
    }
    const resolved = path.resolve(root, relativePath);
    if (!isInside(path.resolve(root), resolved)) {
      continue;
    }
    let stat;
    try {
      stat = await fs.stat(resolved);
    } catch {
      continue;
    }
    output.push({
      path: relativePath,
      type: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other"
    });
    seen.add(relativePath);
  }
}

/**
 * @param {string} root
 * @param {string} relative
 * @param {Array<Record<string, any>>} output
 */
async function walk(root: string, relative: string, output: FileMentionCandidate[], seen: Set<string> = new Set()) {
  if (output.length >= MAX_FILE_CANDIDATES) {
    return;
  }
  const dir = path.join(root, relative);
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) {
      return a.isDirectory() ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
  for (const entry of entries) {
    if (output.length >= MAX_FILE_CANDIDATES) {
      return;
    }
    if (entry.name.startsWith(".") && entry.name !== ".github") {
      continue;
    }
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) {
      continue;
    }
    const itemRelative = path.join(relative, entry.name);
    const displayPath = itemRelative.replace(/\\/g, "/");
    if (seen.has(displayPath)) {
      continue;
    }
    output.push({
      path: displayPath,
      type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other"
    });
    seen.add(displayPath);
    if (entry.isDirectory()) {
      await walk(root, itemRelative, output, seen);
    }
  }
}

function isSkippedRelativePath(relativePath: string) {
  return normalizeFragment(relativePath).split("/").some((part) => SKIP_DIRS.has(part));
}

function isInside(root: string, target: string) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
