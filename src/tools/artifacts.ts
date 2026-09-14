import { readdirSync, statSync } from "node:fs";
import path from "node:path";

export const EXHIBIT_WALK_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg",
  ".pdf",
  ".md", ".markdown",
  ".csv", ".tsv",
  ".docx", ".xlsx", ".pptx"
]);

export const EXHIBIT_MENTION_EXTENSIONS = new Set([
  ...EXHIBIT_WALK_EXTENSIONS,
  ".txt", ".json", ".yaml", ".yml", ".html", ".htm"
]);

const IGNORE_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  ".lab-agent",
  "dist",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  "vendor",
  ".tmp_validation",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  ".next"
]);

const MAX_WALK_ENTRIES = 4000;
const MAX_WALK_DEPTH = 6;
const MAX_SHELL_ARTIFACTS = 24;
const MAX_PERSISTED_ARTIFACTS = 50;
const ARTIFACT_MTIME_SLACK_MS = 2000;

export type PersistedExhibitArtifact = {
  relativePath: string;
  name: string;
  source: string;
};

export type ShellArtifact = {
  path: string;
  created: boolean;
};

/**
 * Pull file-like paths out of command text, tool output, or assistant replies.
 * Existence and workspace checks happen at the collection site.
 */
export function extractCandidatePaths(text: string): string[] {
  const source = String(text ?? "");
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    let value = String(raw ?? "").trim();
    if (!value) {
      return;
    }
    value = value.replace(/^<|>$/g, "");
    const titled = value.match(/^(\S+)(?:\s+"[^"]*")?$/);
    if (titled) {
      value = titled[1];
    }
    value = value.replace(/[.,;:!?]+$/g, "");
    if (!value || seen.has(value)) {
      return;
    }
    if (/^(https?:|data:|mailto:)/i.test(value)) {
      return;
    }
    const cleaned = value.split(/[?#]/)[0];
    const ext = path.extname(cleaned).toLowerCase();
    if (!ext || ext === ".") {
      return;
    }
    seen.add(value);
    out.push(cleaned);
  };

  for (const match of source.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    add(match[1]);
  }
  for (const match of source.matchAll(/`([^`]+)`/g)) {
    add(match[1]);
  }
  for (const match of source.matchAll(/["']([^"']+)["']/g)) {
    add(match[1]);
  }
  for (const match of source.matchAll(/[A-Za-z]:[\\/][^\s"'<>|*?]+/g)) {
    add(match[0]);
  }
  for (const match of source.matchAll(/(?<![A-Za-z0-9])(?:\.{1,2}[\\/])?(?:[^\s"'<>|*?:\\/]+[\\/])*[^\s"'<>|*?:\\/]+\.[A-Za-z0-9]{1,8}\b/g)) {
    add(match[0]);
  }
  return out;
}

export function isExhibitMentionPath(target: string): boolean {
  return EXHIBIT_MENTION_EXTENSIONS.has(path.extname(String(target ?? "")).toLowerCase());
}

export function isExhibitWalkPath(target: string): boolean {
  return EXHIBIT_WALK_EXTENSIONS.has(path.extname(String(target ?? "")).toLowerCase());
}

/**
 * Collect previewable files a shell command just produced.
 * Mentions in stdout/stderr are trusted; command-line paths and a bounded
 * workspace walk only accept recently modified exhibit files.
 */
export function serializeExhibitArtifacts(cwd: string, changes: unknown): PersistedExhibitArtifact[] {
  const root = path.resolve(String(cwd ?? ""));
  const items: PersistedExhibitArtifact[] = [];
  const seen = new Set<string>();
  const records = Array.isArray(changes) ? changes : [];
  for (const change of records) {
    const record = change && typeof change === "object" && !Array.isArray(change)
      ? change as { path?: unknown; created?: unknown; edited?: unknown }
      : {};
    const value = String(record.path ?? "").trim();
    if (!value || !isExhibitWalkPath(value)) {
      continue;
    }
    const resolved = path.resolve(root, value);
    const relative = path.relative(root, resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      continue;
    }
    if (relative.split(/[\\/]/).some((part) => IGNORE_DIR_NAMES.has(part.toLowerCase()))) {
      continue;
    }
    try {
      if (!statSync(resolved).isFile()) {
        continue;
      }
    } catch {
      continue;
    }
    const key = resolved.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    items.push({
      relativePath: relative,
      name: path.basename(resolved),
      source: record.created ? "created" : record.edited ? "edited" : "changed"
    });
  }
  return items.slice(-MAX_PERSISTED_ARTIFACTS);
}

export function collectShellArtifacts(
  cwd: string,
  input: {
    command?: unknown;
    stdout?: unknown;
    stderr?: unknown;
    durationMs?: unknown;
  } = {}
): ShellArtifact[] {
  const root = path.resolve(String(cwd ?? ""));
  const now = Date.now();
  const durationMs = Number(input.durationMs);
  const startedAt = Number.isFinite(durationMs) && durationMs >= 0
    ? now - durationMs - ARTIFACT_MTIME_SLACK_MS
    : now - ARTIFACT_MTIME_SLACK_MS;
  const items: ShellArtifact[] = [];
  const seen = new Set<string>();

  const add = (target: unknown, requireRecent: boolean) => {
    if (items.length >= MAX_SHELL_ARTIFACTS) {
      return;
    }
    const value = String(target ?? "").trim();
    if (!value || !isExhibitMentionPath(value)) {
      return;
    }
    const resolved = path.resolve(root, value);
    const relative = path.relative(root, resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      return;
    }
    if (relative.split(/[\\/]/).some((part) => IGNORE_DIR_NAMES.has(part.toLowerCase()))) {
      return;
    }
    const key = resolved.toLowerCase();
    if (seen.has(key)) {
      return;
    }
    let stat;
    try {
      stat = statSync(resolved);
    } catch {
      return;
    }
    if (!stat.isFile() || stat.size <= 0) {
      return;
    }
    if (requireRecent && stat.mtimeMs < startedAt) {
      return;
    }
    seen.add(key);
    items.push({
      path: relative,
      created: true
    });
  };

  for (const candidate of extractCandidatePaths(`${String(input.stdout ?? "")}\n${String(input.stderr ?? "")}`)) {
    add(candidate, false);
  }
  for (const candidate of extractCandidatePaths(String(input.command ?? ""))) {
    add(candidate, true);
  }
  for (const found of walkRecentArtifactFiles(root, startedAt)) {
    add(found, true);
  }
  return items;
}

function walkRecentArtifactFiles(root: string, sinceMs: number): string[] {
  const found: string[] = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  let visited = 0;
  while (stack.length > 0 && visited < MAX_WALK_ENTRIES && found.length < MAX_SHELL_ARTIFACTS) {
    const current = stack.pop();
    if (!current) {
      break;
    }
    let entries;
    try {
      entries = readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      if (visited > MAX_WALK_ENTRIES || found.length >= MAX_SHELL_ARTIFACTS) {
        break;
      }
      const name = entry.name;
      if (name.startsWith(".")) {
        continue;
      }
      const full = path.join(current.dir, name);
      if (entry.isDirectory()) {
        if (current.depth >= MAX_WALK_DEPTH) {
          continue;
        }
        if (IGNORE_DIR_NAMES.has(name.toLowerCase())) {
          continue;
        }
        stack.push({ dir: full, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile() || !isExhibitWalkPath(name)) {
        continue;
      }
      try {
        const stat = statSync(full);
        if (!stat.isFile() || stat.size <= 0 || stat.mtimeMs < sinceMs) {
          continue;
        }
      } catch {
        continue;
      }
      found.push(full);
    }
  }
  return found;
}
