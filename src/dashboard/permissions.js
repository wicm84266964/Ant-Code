export { approvalKeyFor } from "../permissions/approval-keys.js";

export const PERMISSION_MODES = Object.freeze(["plan", "workspace", "fullAccess"]);

export const APPROVAL_ACTIONS = Object.freeze([
  "allow-once",
  "allow-session",
  "deny",
  "cancel"
]);

/**
 * @param {string | null | undefined} value
 */
export function normalizePermissionMode(value) {
  const mode = String(value ?? "").trim();
  if (mode === "fullAccess" || mode === "full-access" || mode === "完全访问") {
    return "fullAccess";
  }
  if (mode === "workspace" || mode === "workspacePermissions" || mode === "bypassPermissions" || mode === "acceptEdits" || mode === "工作区权限") {
    return "workspace";
  }
  return "plan";
}

/**
 * @param {Record<string, any>} session
 * @param {string} mode
 */
export function applyPermissionMode(session, mode) {
  const normalized = normalizePermissionMode(mode);
  session.permissionMode = normalized;
  session.fullAccess = normalized === "fullAccess";
  session.readonly = Boolean(session.permissionReadonlyLocked) && normalized === "plan";
  session.allowWrite = normalized === "workspace" || normalized === "fullAccess";
  session.allowCommand = normalized === "workspace" || normalized === "fullAccess";
  return session;
}

/**
 * @param {Record<string, any>} session
 */
export function permissionModeSummary(session) {
  const mode = normalizePermissionMode(session?.permissionMode ?? (session?.fullAccess ? "fullAccess" : session?.allowWrite || session?.allowCommand ? "workspace" : "plan"));
  return {
    mode,
    label: permissionModeLabel(mode),
    description: permissionModeDescription(mode),
    readonlyLocked: Boolean(session?.permissionReadonlyLocked)
  };
}

export function permissionModeLabel(mode) {
  const normalized = normalizePermissionMode(mode);
  if (normalized === "fullAccess") {
    return "完全访问";
  }
  if (normalized === "workspace") {
    return "工作区权限";
  }
  return "计划确认";
}

export function permissionModeDescription(mode) {
  const normalized = normalizePermissionMode(mode);
  if (normalized === "workspace") {
    return "工作区内非敏感读写和常规本地命令自动同意";
  }
  if (normalized === "fullAccess") {
    return "测试机模式，所有本地工具、MCP、浏览器、网络和任意路径操作自动同意";
  }
  return "写入、命令和外部能力需要确认后执行";
}

/**
 * @param {Record<string, any>} request
 */
export function buildApprovalPreview(request = {}) {
  const toolName = request.toolName ?? "unknown";
  const input = sanitizeSensitiveValue(request.input ?? {});
  if (toolName === "write_file") {
    return [
      `path: ${input.path ?? "unknown"}`,
      `内容：${Buffer.byteLength(String(input.content ?? ""), "utf8")} 字节`
    ];
  }
  if (toolName === "edit_file") {
    return [
      `path: ${input.path ?? "unknown"}`,
      `旧文本：${Buffer.byteLength(String(input.oldText ?? ""), "utf8")} 字节`,
      `新文本：${Buffer.byteLength(String(input.newText ?? ""), "utf8")} 字节`,
      `模式：${input.dryRun ? "仅预览" : "将编辑文件"}`
    ];
  }
  if (toolName === "powershell" || toolName === "bash") {
    return [
      `命令：${truncate(String(input.command ?? ""), 220)}`,
      `超时：${input.timeoutMs ?? "默认"}`
    ];
  }
  if (toolName === "mcp_call") {
    return [
      `服务器：${input.server ?? "unknown"}`,
      `工具：${input.tool ?? "unknown"}`,
      request.decision?.targetPath ? `路径：${request.decision.targetPath}` : null,
      `参数：${truncate(JSON.stringify(input.arguments ?? {}), 220)}`
    ].filter(Boolean);
  }
  if (request.definition?.risk === "network") {
    return [
      `目标：${input.url ?? input.query ?? "unknown"}`,
      "网络访问会按 host allowlist 和当前网络模式审批。"
    ];
  }
  return [`输入：${truncate(JSON.stringify(input), 220)}`];
}

function truncate(value, max) {
  const text = String(value ?? "");
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3))}...`;
}

const TOKEN_QUERY = /([?&](?:access[_-]?token|api[_-]?key|token|secret|password|authorization|credential)=)[^&#\s]*/gi;
const ASSIGNED_SECRET = /\b((?:access[_-]?token|api[_-]?key|token|secret|password|passwd|authorization|credential)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const AUTHORIZATION_VALUE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi;
const KNOWN_TOKEN = /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,})\b/g;

export function sanitizeSensitiveValue(value, options = {}) {
  const seen = new WeakSet();
  const maxDepth = positiveLimit(options.maxDepth, 8);
  const maxEntries = positiveLimit(options.maxEntries, 80);
  const maxString = positiveLimit(options.maxString, 500);

  function visit(current, depth, key = "") {
    if (isSensitiveKey(key)) {
      return "[redacted]";
    }
    if (typeof current === "string") {
      return truncate(redactTokenLikeText(current), maxString);
    }
    if (current === null || typeof current !== "object") {
      return current;
    }
    if (seen.has(current)) {
      return "[circular]";
    }
    if (depth >= maxDepth) {
      return "[truncated]";
    }
    seen.add(current);
    if (Array.isArray(current)) {
      const output = current.slice(0, maxEntries).map((item) => visit(item, depth + 1));
      if (current.length > maxEntries) output.push(`[${current.length - maxEntries} more]`);
      return output;
    }
    const output = {};
    const entries = Object.entries(current);
    for (const [childKey, childValue] of entries.slice(0, maxEntries)) {
      output[childKey] = visit(childValue, depth + 1, childKey);
    }
    if (entries.length > maxEntries) output.__truncated__ = `${entries.length - maxEntries} more fields`;
    return output;
  }

  return visit(value, 0);
}

function redactTokenLikeText(value) {
  return String(value ?? "")
    .replace(TOKEN_QUERY, "$1[redacted]")
    .replace(AUTHORIZATION_VALUE, "$1 [redacted]")
    .replace(ASSIGNED_SECRET, "$1[redacted]")
    .replace(KNOWN_TOKEN, "[redacted]");
}

function isSensitiveKey(value) {
  const key = String(value ?? "").replace(/[_-]/g, "").toLowerCase();
  return /^(?:token|apikey|secret|password|passwd|authorization|credential|cookie|privatekey|accesskey|accesstoken|refreshtoken|sessiontoken|csrftoken|authtoken)$/.test(key);
}

function positiveLimit(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}
