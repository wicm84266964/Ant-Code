import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isInside } from "../permissions/policy-engine.ts";

const DEFAULT_PROJECT_SKILL_DIRS = Object.freeze([
  path.join(".lab-agent", "skills"),
  path.join(".ant-code", "skills"),
  path.join(".claude", "skills")
]);
const MAX_SKILLS = 120;
const MAX_SKILL_BYTES = 64 * 1024;
const MAX_SKILL_CONTENT_CHARS = 48 * 1024;
const BUNDLED_SKILL_ROOT = path.join(resolvePackageRoot(), "config", "skills");

type SkillConfig = { enabled?: boolean; paths?: unknown };
type SkillOptions = { cwd: string; config?: { skills?: SkillConfig }; env?: NodeJS.ProcessEnv; name?: string; message?: string };
type SkillRecord = {
  name: string;
  displayName: string | null;
  description: string;
  whenToUse: string | null;
  allowedTools: string[];
  argumentHint: string | null;
  context: string | null;
  agent: string | null;
  paths: string[];
  hooks: string[];
  model: string | null;
  disabled: boolean;
  source: string;
  path: string;
  root: string;
  contentBytes: number;
  content?: string;
  contentTruncated?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function errorCode(error: unknown): unknown {
  return error && typeof error === "object" && "code" in error ? error.code : undefined;
}

function resolvePackageRoot() {
  if (process.env.LAB_AGENT_PACKAGE_ROOT) {
    return path.resolve(process.env.LAB_AGENT_PACKAGE_ROOT);
  }
  if (process.env.NODE_SEA_EXECUTABLE || process.execPath.toLowerCase().endsWith("ant-code.exe")) {
    return path.dirname(process.execPath);
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/**
 * @param {{ cwd: string; config?: Record<string, any>; env?: NodeJS.ProcessEnv }} options
 */
export async function loadSkills(options: SkillOptions) {
  if (options.config?.skills?.enabled === false) {
    return [];
  }

  const roots = skillRoots(options);
  const skills: SkillRecord[] = [];
  const seen = new Set();

  for (const root of roots) {
    const rootSkills = await loadSkillsFromRoot(options.cwd, root);
    for (const skill of rootSkills) {
      const key = skill.name.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      skills.push(skill);
      if (skills.length >= MAX_SKILLS) {
        return skills;
      }
    }
  }

  return skills;
}

/**
 * @param {{ cwd: string; config?: Record<string, any>; env?: NodeJS.ProcessEnv; name: string }} options
 */
export async function readSkill(options: SkillOptions & { name: string }): Promise<
  { ok: false; error: { code: string; message: string } } | { ok: true; skill: SkillRecord }
> {
  if (options.config?.skills?.enabled === false) {
    return { ok: false, error: { code: "SKILLS_DISABLED", message: "Local skills are disabled by config." } };
  }

  const name = normalizeSkillName(options.name);
  if (!name) {
    return { ok: false, error: { code: "SKILL_NAME_REQUIRED", message: "Skill name is required." } };
  }

  const skills = await loadSkills(options);
  const skill = skills.find((item) => item.name.toLowerCase() === name.toLowerCase());
  if (!skill) {
    return { ok: false, error: { code: "SKILL_NOT_FOUND", message: `Skill is not configured: ${name}` } };
  }

  const text = await fs.readFile(skill.path, "utf8");
  const bounded = truncateSkillContent(text);
  return {
    ok: true,
    skill: {
      ...skill,
      content: bounded.content,
      contentTruncated: bounded.truncated
    }
  };
}

/**
 * @param {{ cwd: string; config?: Record<string, any>; env?: NodeJS.ProcessEnv; name: string; message?: string }} options
 */
export async function runSkill(options: SkillOptions & { name: string; message?: string }) {
  const result = await readSkill(options);
  if (!result.ok) {
    return result;
  }
  if (result.skill.disabled) {
    return {
      ok: false,
      error: { code: "SKILL_DISABLED", message: `Skill is disabled: ${result.skill.name}` }
    };
  }

  return {
    ok: true,
    skill: result.skill,
    userMessage: String(options.message ?? ""),
    execution: result.skill.context === "fork" ? "fork-ready" : "instruction-only",
    note: "This local skill returns bounded instructions and resources for the model. It does not execute scripts or contact a marketplace."
  };
}

/**
 * @param {{ cwd: string; config?: Record<string, any>; env?: NodeJS.ProcessEnv }} options
 */
export async function formatSkillContextLines(options: SkillOptions) {
  const skills = await loadSkills(options);
  if (skills.length === 0) {
    return [
      "- No local skills are currently configured. Built-in coding tools remain available."
    ];
  }

  return [
    `- ${skills.length} local skill(s) are configured. Use skill_list to inspect summaries and skill_read or skill_run before applying a specialized workflow.`,
    "- Local skills are instruction resources only; do not assume their scripts have run unless you explicitly invoke normal local tools with user approval.",
    ...skills.slice(0, 24).map((skill) => {
      const when = skill.whenToUse ? ` when=${truncateOneLine(skill.whenToUse, 96)}` : "";
      const tools = skill.allowedTools.length > 0 ? ` tools=${skill.allowedTools.join(",")}` : "";
      const context = skill.context ? ` context=${skill.context}` : "";
      const agent = skill.agent ? ` agent=${skill.agent}` : "";
      return `  - ${skill.name}: ${truncateOneLine(skill.description, 120)}${when}${tools}${context}${agent}`;
    }),
    ...(skills.length > 24 ? [`  - ... ${skills.length - 24} more skill(s)`] : [])
  ];
}

/**
 * @param {{ cwd: string; config?: Record<string, any>; env?: NodeJS.ProcessEnv }} options
 */
export async function formatSkillsList(options: SkillOptions) {
  if (options.config?.skills?.enabled === false) {
    return [
      "Ant Code skills",
      "",
      "本地 skills 已在配置中关闭。",
      "",
      "开启方式：把 lab-agent.config.json 的 skills.enabled 设为 true。"
    ].join("\n");
  }

  const skills = await loadSkills(options);
  if (skills.length === 0) {
    return [
      "Ant Code skills",
      "",
      "当前没有配置本地 skills。",
      "",
      "可用位置",
      "- .lab-agent/skills/<name>/SKILL.md",
      "- .ant-code/skills/<name>/SKILL.md",
      "- .claude/skills/<name>/SKILL.md",
      "- lab-agent.config.json 的 skills.paths",
      "",
      "说明：skills 是本地指令资源，不会自动访问 marketplace，也不会自动执行脚本。"
    ].join("\n");
  }

  return [
    "Ant Code skills",
    "",
    ...skills.map((skill) => {
      const disabled = skill.disabled ? " [disabled]" : "";
      const tools = skill.allowedTools.length > 0 ? ` tools=${skill.allowedTools.join(",")}` : "";
      const context = skill.context ? ` context=${skill.context}` : "";
      const agent = skill.agent ? ` agent=${skill.agent}` : "";
      return `- ${skill.name}${disabled} - ${skill.description}${tools}${context}${agent}`;
    }),
    "",
    "用法",
    "- /skills show <name>",
    "- /skills run <name> <message>",
    "",
    "边界：本地 skill 只提供说明和资源；脚本执行仍必须通过 /run 或模型工具，并经过权限策略。"
  ].join("\n");
}

/**
 * @param {{ cwd: string; config?: Record<string, any>; env?: NodeJS.ProcessEnv; name: string }} options
 */
export async function formatSkillDetail(options: SkillOptions & { name: string }) {
  const result = await readSkill(options);
  if (!result.ok) {
    return JSON.stringify(result, null, 2);
  }

  const skill = result.skill;
  return [
    `Skill: ${skill.name}`,
    "",
    `description: ${skill.description}`,
    `source: ${skill.source}`,
    `path: ${path.relative(options.cwd, skill.path) || path.basename(skill.path)}`,
    `allowed tools: ${skill.allowedTools.length > 0 ? skill.allowedTools.join(", ") : "not specified"}`,
    skill.argumentHint ? `argument hint: ${skill.argumentHint}` : null,
    skill.context ? `context: ${skill.context}` : null,
    skill.agent ? `agent: ${skill.agent}` : null,
    skill.paths.length > 0 ? `paths: ${skill.paths.join(", ")}` : null,
    skill.hooks.length > 0 ? `hooks: ${skill.hooks.join(", ")}` : null,
    `model: ${skill.model ?? "inherit"}`,
    `bytes: ${skill.contentBytes}${skill.contentTruncated ? " truncated" : ""}`,
    skill.whenToUse ? `when to use: ${skill.whenToUse}` : null,
    "",
    "Content",
    skill.content
  ].filter(Boolean).join("\n");
}

/**
 * @param {{ cwd: string; config?: Record<string, any>; env?: NodeJS.ProcessEnv }} options
 */
function skillRoots(options: SkillOptions) {
  const cwd = path.resolve(options.cwd);
  const configured = Array.isArray(options.config?.skills?.paths)
    ? options.config.skills.paths
    : [];
  const envPaths = String(options.env?.LAB_AGENT_SKILL_PATHS ?? "")
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
  const configuredRoots = configured.map((item) => path.resolve(cwd, String(item)));
  const envRoots = envPaths.map((item) => path.resolve(cwd, item));
  const configuredRootKeys = new Set(configuredRoots.map(rootKey));
  const envRootKeys = new Set(envRoots.map(rootKey));

  const roots = [
    ...DEFAULT_PROJECT_SKILL_DIRS.map((item) => path.resolve(cwd, item)),
    BUNDLED_SKILL_ROOT,
    ...configuredRoots,
    ...envRoots
  ];

  const seen = new Set();
  return roots.filter((root: string) => {
    const key = rootKey(root);
    if (!root || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return root === BUNDLED_SKILL_ROOT || isInside(cwd, root) || configuredRootKeys.has(key) || envRootKeys.has(key);
  });
}

/**
 * @param {string} cwd
 * @param {string} root
 */
async function loadSkillsFromRoot(cwd: string, root: string) {
  const directSkill = await readSkillFile(cwd, root, path.join(root, "SKILL.md"), path.basename(root));
  if (directSkill) {
    return [directSkill];
  }

  const entries = await fs.readdir(root, { withFileTypes: true }).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") {
      return [];
    }
    throw error;
  });

  const skills: SkillRecord[] = [];
  for (const entry of entries) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const skill = await readSkillFile(cwd, root, path.join(candidate, "SKILL.md"), entry.name);
      if (skill) {
        skills.push(skill);
      }
      continue;
    }
    if (entry.isFile() && /\.md$/i.test(entry.name)) {
      const skill = await readSkillFile(cwd, root, candidate, path.basename(entry.name, path.extname(entry.name)));
      if (skill) {
        skills.push(skill);
      }
    }
  }
  return skills;
}

/**
 * @param {string} root
 */
function rootKey(root: string) {
  const resolved = path.resolve(root);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * @param {string} cwd
 * @param {string} root
 * @param {string} filePath
 * @param {string} fallbackName
 */
async function readSkillFile(cwd: string, root: string, filePath: string, fallbackName: string) {
  const stat = await fs.stat(filePath).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (!stat || !stat.isFile() || stat.size > MAX_SKILL_BYTES) {
    return null;
  }

  const text = await fs.readFile(filePath, "utf8");
  const parsed = parseSkillMarkdown(text);
  const frontmatter = parsed.frontmatter;
  const name = normalizeSkillName(frontmatter.name ?? fallbackName);
  if (!name) {
    return null;
  }

  return {
    name,
    displayName: stringOrNull(frontmatter.displayName ?? frontmatter.title),
    description: stringOrNull(frontmatter.description) ?? inferDescription(parsed.body, name),
    whenToUse: stringOrNull(frontmatter.when_to_use ?? frontmatter.whenToUse),
    allowedTools: parseList(frontmatter.allowed_tools ?? frontmatter["allowed-tools"]),
    argumentHint: stringOrNull(frontmatter.argument_hint ?? frontmatter["argument-hint"]),
    context: stringOrNull(frontmatter.context),
    agent: stringOrNull(frontmatter.agent),
    paths: parseList(frontmatter.paths),
    hooks: parseList(frontmatter.hooks),
    model: stringOrNull(frontmatter.model),
    disabled: parseBoolean(frontmatter.disabled),
    source: sourceLabel(cwd, root),
    path: filePath,
    root,
    contentBytes: stat.size
  };
}

/**
 * @param {string} text
 */
function parseSkillMarkdown(text: string) {
  const value = String(text ?? "");
  if (!value.startsWith("---\n") && !value.startsWith("---\r\n")) {
    return { frontmatter: {} as Record<string, unknown>, body: value };
  }
  const match = value.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return { frontmatter: {} as Record<string, unknown>, body: value };
  }
  return {
    frontmatter: parseFrontmatter(match[1]),
    body: value.slice(match[0].length)
  };
}

/**
 * @param {string} text
 */
function parseFrontmatter(text: string) {
  const result: Record<string, unknown> = {};
  let currentKey: string | null = null;
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line.trim() || line.trimStart().startsWith("#")) {
      continue;
    }
    if (/^\s+-\s+/.test(line) && currentKey) {
      const current: unknown[] = Array.isArray(result[currentKey]) ? result[currentKey] as unknown[] : [];
      current.push(unquote(line.replace(/^\s+-\s+/, "").trim()));
      result[currentKey] = current;
      continue;
    }
    const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!match) {
      continue;
    }
    currentKey = match[1];
    const rawValue = match[2].trim();
    result[currentKey] = rawValue === "" ? [] : unquote(rawValue);
  }
  return result;
}

function parseList(value: unknown) {
  if (Array.isArray(value)) {
    return value.map(String).map((item) => item.trim()).filter(Boolean);
  }
  if (typeof value !== "string") {
    return [];
  }
  const text = value.trim();
  if (!text) {
    return [];
  }
  return text
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .split(",")
    .map((item) => unquote(item.trim()))
    .filter(Boolean);
}

function parseBoolean(value: unknown) {
  return /^(1|true|yes|on)$/i.test(String(value ?? ""));
}

function stringOrNull(value: unknown) {
  if (value === null || value === undefined) {
    return null;
  }
  const text = String(value).trim();
  return text ? text : null;
}

function normalizeSkillName(value: unknown) {
  return String(value ?? "")
    .trim()
    .replace(/^@+/, "")
    .replace(/[^A-Za-z0-9_.:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function inferDescription(body: string, name: string) {
  const heading = String(body ?? "").split(/\r?\n/).find((line) => /^#{1,3}\s+\S/.test(line));
  if (heading) {
    return heading.replace(/^#{1,3}\s+/, "").trim();
  }
  const first = String(body ?? "").split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return first ? truncateOneLine(first, 120) : `Local skill ${name}`;
}

function truncateSkillContent(text: string) {
  const value = String(text ?? "");
  if (value.length <= MAX_SKILL_CONTENT_CHARS) {
    return { content: value, truncated: false };
  }
  return {
    content: `${value.slice(0, MAX_SKILL_CONTENT_CHARS)}\n...[skill truncated at ${MAX_SKILL_CONTENT_CHARS} chars]`,
    truncated: true
  };
}

function truncateOneLine(value: unknown, max: number) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3))}...`;
}

function sourceLabel(cwd: string, root: string) {
  const relative = path.relative(cwd, root);
  return relative && !relative.startsWith("..") ? relative : root;
}

function unquote(value: unknown) {
  const text = String(value ?? "").trim();
  if ((text.startsWith("\"") && text.endsWith("\"")) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}
