import path from "node:path";
import { classifyCommand } from "./command-classifier.ts";

/**
 * @param {{ toolName: string; input?: Record<string, any>; decision?: Record<string, any>; definition?: Record<string, any> }} request
 */
export function approvalKeyFor(request: { toolName: string; input?: Record<string, unknown>; decision?: Record<string, unknown>; definition?: Record<string, unknown> }) {
  const boundary = approvalBoundaryKey(request);
  const input = request?.input ?? {};
  if (request.toolName === "write_file" || request.toolName === "edit_file") {
    return `write:${boundary}:${input.path ?? ""}`;
  }
  if (request.toolName === "read_file" || request.toolName === "list_files" || request.toolName === "glob" || request.toolName === "grep" || request.toolName === "document_intake") {
    return `path:${boundary}:${request.toolName}:${input.path ?? ""}:${input.pattern ?? ""}`;
  }
  if (request.toolName === "powershell" || request.toolName === "bash") {
    return `command:${boundary}:${request.toolName}:${commandApprovalScope(request)}`;
  }
  if (request.toolName === "mcp_call") {
    return `mcp:${boundary}:${input.server ?? ""}:${input.tool ?? ""}:${request.decision?.targetPath ?? request.decision?.resolvedPath ?? ""}`;
  }
  const risk = request.definition?.risk;
  if (risk === "network") {
    return `network:${boundary}:${request.toolName}:${input.url ?? input.query ?? ""}`;
  }
  if (risk === "browser") {
    return `browser:${boundary}:${input.server ?? ""}:${input.tool ?? request.toolName}`;
  }
  if (risk === "memory") {
    return `memory:${boundary}:${input.server ?? ""}:${input.tool ?? request.toolName}`;
  }
  return `${boundary}:${request.toolName}`;
}

/**
 * @param {Record<string, any>} request
 */
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function approvalBoundaryKey(request: Record<string, unknown>) {
  const decision = asRecord(request.decision);
  return [
    decision.sensitive === true ? "sensitive" : "normal",
    decision.outsideWorkspace === true ? "outside" : "workspace"
  ].join(":");
}

/**
 * @param {{ input?: Record<string, any>; decision?: Record<string, any> }} request
 */
function commandApprovalScope(request: { input?: Record<string, unknown>; decision?: Record<string, unknown> }) {
  const command = String(request?.input?.command ?? "");
  const exact = normalizeCommand(command);
  const classification = classifyCommand(command);
  const decision = asRecord(request?.decision);
  if (
    decision.sensitive === true
    || decision.outsideWorkspace === true
    || classification.kind === "high-risk"
    || classification.kind === "network"
  ) {
    return `exact:${exact}`;
  }

  const family = safeCommandFamily(command);
  return family ? `family:${family}` : `exact:${exact}`;
}

/**
 * @param {string} command
 */
function safeCommandFamily(command: string) {
  if (hasShellControlOperator(command)) {
    return null;
  }
  const tokens = tokenizeCommand(command);
  if (tokens.length === 0) {
    return null;
  }
  const executable = normalizeExecutable(tokens[0]);
  const args = tokens.slice(1);
  if (args.some(isMutatingCommandArg)) {
    return null;
  }

  if (["npm", "pnpm", "yarn", "bun"].includes(executable)) {
    return packageManagerFamily(executable, args);
  }
  if (executable === "node") {
    return nodeFamily(args);
  }
  if (["python", "python3", "py"].includes(executable)) {
    return pythonFamily(args);
  }
  if (executable === "pytest") {
    return "python:pytest";
  }
  if (executable === "go" && lower(args[0]) === "test") {
    return "go:test";
  }
  if (executable === "cargo" && lower(args[0]) === "test") {
    return "cargo:test";
  }
  if (executable === "dotnet" && lower(args[0]) === "test") {
    return "dotnet:test";
  }
  if ((executable === "mvn" || executable === "mvnw") && args.some((arg: unknown) => lower(arg) === "test")) {
    return "maven:test";
  }
  if ((executable === "gradle" || executable === "gradlew") && args.some((arg: unknown) => lower(arg) === "test")) {
    return "gradle:test";
  }
  if (["vitest", "jest", "mocha", "ava"].includes(executable)) {
    return `js-test:${executable}`;
  }
  if (executable === "playwright" && lower(args[0]) === "test") {
    return "js-test:playwright";
  }
  if (executable === "eslint") {
    return "js-lint:eslint";
  }
  if (executable === "tsc" && args.some((arg: unknown) => lower(arg) === "--noemit")) {
    return "js-typecheck:tsc";
  }
  if (executable === "ruff" && lower(args[0]) === "check") {
    return "python-lint:ruff";
  }
  if (executable === "mypy") {
    return "python-typecheck:mypy";
  }
  if (executable === "prettier" && args.some((arg: unknown) => lower(arg) === "--check")) {
    return "format-check:prettier";
  }

  return null;
}

/**
 * @param {string} executable
 * @param {string[]} args
 */
function packageManagerFamily(executable: string, args: string[]) {
  const first = lower(args[0]);
  if (first === "test" || first === "t") {
    return `package:${executable}:test`;
  }
  if (first !== "run" && first !== "run-script") {
    return null;
  }
  const script = lower(args[1]);
  if (!script || !isSafePackageScript(script)) {
    return null;
  }
  return `package:${executable}:run:${script}`;
}

/**
 * @param {string[]} args
 */
function nodeFamily(args: string[]) {
  if (args.some((arg: unknown) => lower(arg) === "--test")) {
    return "node:test";
  }
  const script = args.find((arg) => arg && !arg.startsWith("-"));
  if (script && isSafeScriptPath(script)) {
    return `node-script:${normalizePathToken(script)}`;
  }
  return null;
}

/**
 * @param {string[]} args
 */
function pythonFamily(args: string[]) {
  const first = lower(args[0]);
  if (first === "-m") {
    const moduleName = lower(args[1]);
    if (moduleName === "pytest" || moduleName === "unittest") {
      return `python:${moduleName}`;
    }
  }
  const script = args.find((arg) => arg && !arg.startsWith("-"));
  if (script && isSafeScriptPath(script)) {
    return `python-script:${normalizePathToken(script)}`;
  }
  return null;
}

/**
 * @param {string} script
 */
function isSafePackageScript(script: string) {
  return /^(test|unit|integration|e2e|lint|check|typecheck|verify|validate)(?::[\w.-]+)?$/i.test(script);
}

/**
 * @param {string} script
 */
function isSafeScriptPath(script: string) {
  const normalized = normalizePathToken(script);
  const base = path.posix.basename(normalized);
  return /(?:^|[-_.])(test|unit|integration|e2e|lint|check|typecheck|verify|validate)(?:[-_.]|$)/i.test(base);
}

/**
 * @param {string} arg
 */
function isMutatingCommandArg(arg: string) {
  const value = lower(arg);
  return value === "--fix"
    || value === "--write"
    || value === "--update"
    || value === "--update-snapshots"
    || value === "--updatesnapshot"
    || value === "--update-snapshot"
    || value === "--test-update-snapshots"
    || value === "-u"
    || value === "-w";
}

/**
 * @param {string} value
 */
function normalizeExecutable(value: string) {
  return path.basename(String(value ?? "").trim()).replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
}

/**
 * @param {string} value
 */
function normalizePathToken(value: string) {
  return String(value ?? "").replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

/**
 * @param {unknown} value
 */
function lower(value: unknown) {
  return String(value ?? "").toLowerCase();
}

/**
 * @param {string} command
 */
function normalizeCommand(command: string) {
  let output = "";
  let quote = null;
  let pendingSpace = false;
  for (const char of String(command ?? "")) {
    if (quote) {
      output += char;
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      if (pendingSpace && output) {
        output += " ";
      }
      pendingSpace = false;
      quote = char;
      output += char;
      continue;
    }
    if (/\s/.test(char)) {
      pendingSpace = true;
      continue;
    }
    if (pendingSpace && output) {
      output += " ";
    }
    pendingSpace = false;
    output += char;
  }
  return output.trim();
}

/**
 * @param {string} command
 */
function hasShellControlOperator(command: string) {
  let quote = null;
  for (const char of String(command ?? "")) {
    if (quote) {
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "|" || char === ";" || char === "&") {
      return true;
    }
  }
  return false;
}

/**
 * @param {string} command
 */
function tokenizeCommand(command: string) {
  const tokens = [];
  let current = "";
  let quote = null;
  for (const char of String(command ?? "")) {
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}
