import path from "node:path";
import { classifyCommand } from "./command-classifier.js";
import { decideNetworkAccess } from "./network-policy.js";
import { normalizeToolPath, resolveToolPath } from "./path-utils.js";

const SECRET_BASENAMES = Object.freeze([
  ".env",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "credentials",
  "token",
  "cookies"
]);

/**
 * @typedef {{
 *   toolName: string;
 *   risk: "read" | "write" | "execute" | "network" | "browser" | "document" | "mcp" | "memory";
 *   cwd: string;
 *   targetPaths?: string[];
 *   command?: string;
 *   networkHosts?: string[];
 *   summary: string;
 * }} PermissionRequest
 */

/**
 * @param {PermissionRequest} request
 * @param {{ workspace?: string; permissionMode?: string; networkMode?: string; allowedHosts?: string[]; readonly?: boolean; fullAccess?: boolean; approvals?: { workspaceWrites?: boolean; workspaceCommands?: boolean } }} policy
 */
export function decidePermission(request, policy = {}) {
  if (policy.fullAccess) {
    if (isShellCommandRequest(request)) {
      return decideCommand(request, policy);
    }
    return { decision: "allow", reason: "full access mode auto-approves local tools, MCP, browser, network, memory, and path access" };
  }

  const workspace = path.resolve(policy.workspace ?? request.cwd);
  const pathDecision = decidePathAccess(request, workspace, policy);
  if (pathDecision) {
    return pathDecision;
  }

  if (request.toolName === "todo_write" || request.toolName === "plan_update") {
    return { decision: "allow", reason: "session workflow state updates are local metadata" };
  }

  if (isShellCommandRequest(request)) {
    return decideCommand(request, policy);
  }

  if (request.risk === "execute") {
    if (policy.readonly) {
      return { decision: "deny", reason: "readonly session denies execute tools" };
    }
    return policy.approvals?.workspaceCommands
      ? { decision: "allow", reason: "execute tool allowed by session approval" }
      : { decision: "ask", reason: "执行型工具需要确认" };
  }

  if (request.risk === "network") {
    return decideNetworkRequest(request, policy);
  }

  if (request.risk === "browser") {
    return decideBrowserRequest(request, policy);
  }

  if (request.risk === "document") {
    return decideDocumentRequest(request, policy);
  }

  if (request.risk === "memory") {
    return decideMemoryRequest(request, policy);
  }

  if (request.risk === "mcp") {
    return { decision: "ask", reason: "MCP 工具调用需要明确审批；只读 list/status 可在命令层展示。" };
  }

  if (request.risk === "write") {
    if (policy.readonly) {
      return { decision: "deny", reason: "readonly session denies write tools" };
    }
    if (policy.approvals?.workspaceWrites) {
      return { decision: "allow", reason: "workspace write allowed by session approval" };
    }
    return { decision: "ask", reason: "workspace writes require approval in MVP" };
  }

  return { decision: "allow", reason: "read-only request inside workspace" };
}

function isShellCommandRequest(request) {
  return request.risk === "execute"
    && (request.toolName === "powershell" || request.toolName === "bash" || typeof request.command === "string");
}

function decideBrowserRequest(request, policy) {
  if (policy.networkMode === "offline") {
    return { decision: "deny", reason: "offline mode denies browser actions that may touch web pages" };
  }
  return { decision: "ask", reason: "browser automation may expose page content or session state and requires approval" };
}

function decideDocumentRequest(request, policy) {
  if (policy.readonly) {
    return { decision: "allow", reason: "document intake is bounded read-only extraction" };
  }
  return { decision: "allow", reason: "document intake is bounded read-only extraction" };
}

function decideMemoryRequest(request, policy) {
  if (request.toolName.includes("create_") || request.toolName.includes("add_") || request.toolName.includes("write")) {
    if (policy.readonly) {
      return { decision: "deny", reason: "readonly session denies memory writes" };
    }
    return policy.approvals?.workspaceWrites
      ? { decision: "allow", reason: "memory write allowed by session approval" }
      : { decision: "ask", reason: "memory writes require approval" };
  }
  return { decision: "allow", reason: "read-only memory lookup is allowed" };
}

/**
 * @param {PermissionRequest} request
 * @param {string} workspace
 * @param {{ readonly?: boolean; fullAccess?: boolean }} policy
 */
function decidePathAccess(request, workspace, policy = {}) {
  for (const target of request.targetPaths ?? []) {
    const resolved = resolveToolPath(request.cwd, target);
    const inside = isInside(workspace, resolved);
    const sensitive = isSecretPath(resolved);

    if (request.risk === "write" && policy.readonly) {
      if (!inside) {
        return { decision: "deny", outsideWorkspace: true, targetPath: target, resolvedPath: resolved, reason: "readonly session denies writes outside workspace" };
      }
      if (sensitive) {
        return { decision: "deny", sensitive: true, targetPath: target, resolvedPath: resolved, reason: "readonly session denies sensitive file writes" };
      }
    }

    if (sensitive) {
      return {
        decision: "ask",
        sensitive: true,
        outsideWorkspace: !inside || undefined,
        targetPath: target,
        resolvedPath: resolved,
        reason: `敏感文件访问需要强确认：${path.basename(resolved)}`
      };
    }

    if (!inside && request.risk === "write") {
      if (policy.readonly) {
        return { decision: "deny", outsideWorkspace: true, targetPath: target, resolvedPath: resolved, reason: "readonly session denies writes outside workspace" };
      }
      return {
        decision: "ask",
        outsideWorkspace: true,
        targetPath: target,
        resolvedPath: resolved,
        reason: "工作区外写入需要确认"
      };
    }

    if (!inside && isPathReadRisk(request.risk)) {
      return { decision: "ask", outsideWorkspace: true, targetPath: target, resolvedPath: resolved, reason: "工作区外读取需要确认" };
    }
  }

  return null;
}

function isPathReadRisk(risk) {
  return risk === "read" || risk === "document";
}

/**
 * @param {PermissionRequest} request
 * @param {{ networkMode?: string; readonly?: boolean; fullAccess?: boolean; approvals?: { workspaceCommands?: boolean } }} policy
 */
function decideCommand(request, policy) {
  const command = request.command ?? "";
  const classification = classifyCommand(command);

  if (classification.kind === "empty") {
    return { decision: "deny", reason: "empty commands are not executable" };
  }

  if (policy.fullAccess) {
    return { decision: "allow", reason: "full access mode auto-approves shell commands" };
  }

  if (classification.kind === "high-risk") {
    if (policy.readonly) {
      return { decision: "deny", reason: "readonly session denies high-risk shell commands" };
    }
    return { decision: "ask", reason: `高风险命令需要确认：${classification.reason}` };
  }

  if (policy.readonly && classification.kind !== "readonly") {
    return { decision: "deny", reason: "readonly session denies mutating shell commands" };
  }

  if (classification.kind === "network") {
    if (policy.networkMode === "offline") {
      return { decision: "deny", reason: "offline mode denies network-capable shell commands" };
    }
    return { decision: "ask", reason: "network-capable shell commands require explicit network approval" };
  }

  const pathDecision = decideCommandPathAccess(request, policy);
  if (pathDecision) {
    return pathDecision;
  }

  if (classification.kind === "readonly") {
    return { decision: "allow", reason: classification.reason };
  }

  if (policy.approvals?.workspaceCommands) {
    return { decision: "allow", reason: "shell command allowed by session approval" };
  }

  return { decision: "ask", reason: classification.reason };
}

/**
 * @param {PermissionRequest} request
 * @param {{ workspace?: string }} policy
 */
function decideCommandPathAccess(request, policy) {
  const workspace = policy.workspace ? path.resolve(policy.workspace) : null;
  if (!workspace) {
    return null;
  }
  for (const candidate of extractCommandTargetPaths(request.command ?? "")) {
    const resolved = resolveToolPath(request.cwd, candidate);
    const inside = isInside(workspace, resolved);
    if (isSecretPath(resolved)) {
      return {
        decision: "ask",
        sensitive: true,
        outsideWorkspace: !inside || undefined,
        targetPath: candidate,
        resolvedPath: resolved,
        reason: `敏感文件访问需要强确认：${path.basename(resolved)}`
      };
    }
    if (!inside) {
      return {
        decision: "ask",
        outsideWorkspace: true,
        targetPath: candidate,
        resolvedPath: resolved,
        reason: `command references path outside workspace and needs confirmation: ${path.basename(resolved) || candidate}`
      };
    }
  }
  return null;
}

/**
 * @param {string} command
 */
function extractCommandTargetPaths(command) {
  const paths = new Set();
  const value = String(command ?? "");
  const pathArg = String.raw`(?:"([^"]+)"|'([^']+)'|([^\s"'` + "`" + String.raw`|;&<>]+))`;
  const powershellPathOption = new RegExp(String.raw`\s-(?:LiteralPath|Path|Destination|Target|OutFile|FilePath)\s+${pathArg}`, "gi");
  const powershellKnownCommand = new RegExp(String.raw`(?:^|[|;&]\s*)(?:Get-Content|Test-Path|Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item|Remove-Item)\s+${pathArg}`, "gi");
  const shellKnownCommand = new RegExp(String.raw`(?:^|[|;&]\s*)(?:cat|head|tail|less|more|touch|mkdir|rmdir|rm|cp|mv)\s+${pathArg}`, "gi");
  const knownCommandSegment = /(?:^|[|;&]\s*)(?:Get-Content|Test-Path|Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item|Remove-Item|cat|head|tail|less|more|touch|mkdir|rmdir|rm|cp|mv)\b([^|;&\r\n]*)/gi;
  const shellRedirection = new RegExp(String.raw`(?:>|>>)\s*${pathArg}`, "g");
  const absoluteToken = /(?:^|[\s=({[,])(?:"([^"]+)"|'([^']+)'|([A-Za-z]:[\\/][^\s"'|;&<>]+|\\\\[^\s"'|;&<>]+|\/[^\s"'|;&<>]+))/g;

  for (const match of value.matchAll(powershellPathOption)) {
    addPathMatch(paths, match, { allowRelative: true });
  }
  for (const match of value.matchAll(powershellKnownCommand)) {
    addPathMatch(paths, match, { allowRelative: true });
  }
  for (const match of value.matchAll(shellKnownCommand)) {
    addPathMatch(paths, match, { allowRelative: true });
  }
  for (const match of value.matchAll(knownCommandSegment)) {
    addPathTokens(paths, match[1]);
  }
  for (const match of value.matchAll(shellRedirection)) {
    addPathMatch(paths, match, { allowRelative: true });
  }
  for (const match of value.matchAll(absoluteToken)) {
    addPathMatch(paths, match);
  }
  return [...paths].filter(Boolean);
}

function addPathMatch(paths, match, options = {}) {
  const candidate = cleanCommandPath(match[1] ?? match[2] ?? match[3] ?? "");
  if (isCommandPathCandidate(candidate, options)) {
    paths.add(candidate);
  }
}

function addPathTokens(paths, segment) {
  const tokenPattern = /"([^"]+)"|'([^']+)'|([^\s]+)/g;
  for (const match of String(segment ?? "").matchAll(tokenPattern)) {
    addPathMatch(paths, match, { allowRelative: true });
  }
}

/**
 * @param {string} value
 */
function isAbsoluteCommandPath(value) {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value) || value.startsWith("/");
}

/**
 * @param {string} value
 * @param {{ allowRelative?: boolean }} options
 */
function isCommandPathCandidate(value, options = {}) {
  const text = normalizeToolPath(value);
  if (!text || text.startsWith("-") || /^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    return false;
  }
  if (isAbsoluteCommandPath(text)) {
    return true;
  }
  if (!options.allowRelative) {
    return false;
  }
  return text === "."
    || text === ".."
    || text.startsWith(".")
    || text.includes("/")
    || text.includes("\\")
    || /\.[A-Za-z0-9_-]{1,12}$/.test(path.basename(text));
}

/**
 * @param {string} value
 */
function cleanCommandPath(value) {
  return normalizeToolPath(value).replace(/[),\].}]+$/g, "");
}

/**
 * @param {PermissionRequest} request
 * @param {{ networkMode?: string; allowedHosts?: string[] }} policy
 */
function decideNetworkRequest(request, policy) {
  const targets = request.networkHosts ?? [];
  if (targets.length === 0) {
    return { decision: "ask", reason: "network request has no declared host" };
  }

  for (const target of targets) {
    const decision = decideNetworkAccess({
      url: target,
      networkMode: policy.networkMode ?? "lab-only",
      allowedHosts: policy.allowedHosts
    });
    if (decision.decision !== "allow") {
      return decision;
    }
  }

  return { decision: "allow", reason: "all declared hosts satisfy network policy" };
}

/**
 * @param {string} workspace
 * @param {string} candidate
 */
export function isInside(workspace, candidate) {
  const relative = path.relative(workspace, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * @param {string} filePath
 */
export function isSecretPath(filePath) {
  const base = path.basename(filePath).toLowerCase();
  if (base.startsWith(".env")) {
    return true;
  }
  return SECRET_BASENAMES.some((secret) => base === secret || base.includes(`${secret}.`));
}
