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
 * @param {{ toolName: string; input: Record<string, any>; decision?: Record<string, any>; definition?: Record<string, any> }} request
 */
export function approvalKeyFor(request) {
  const boundary = approvalBoundaryKey(request);
  if (request.toolName === "write_file" || request.toolName === "edit_file") {
    return `write:${boundary}:${request.toolName}:${request.input?.path ?? ""}`;
  }
  if (request.toolName === "read_file" || request.toolName === "list_files" || request.toolName === "glob" || request.toolName === "grep" || request.toolName === "document_intake") {
    return `path:${boundary}:${request.toolName}:${request.input?.path ?? ""}:${request.input?.pattern ?? ""}`;
  }
  if (request.toolName === "powershell" || request.toolName === "bash") {
    return `command:${boundary}:${request.toolName}:${request.input?.command ?? ""}`;
  }
  if (request.toolName === "mcp_call") {
    return `mcp:${boundary}:${request.input?.server ?? ""}:${request.input?.tool ?? ""}:${request.decision?.targetPath ?? request.decision?.resolvedPath ?? ""}`;
  }
  const risk = request.definition?.risk;
  if (risk === "network") {
    return `network:${boundary}:${request.toolName}:${request.input?.url ?? request.input?.query ?? ""}`;
  }
  if (risk === "browser") {
    return `browser:${boundary}:${request.input?.server ?? ""}:${request.input?.tool ?? request.toolName}`;
  }
  if (risk === "memory") {
    return `memory:${boundary}:${request.input?.server ?? ""}:${request.input?.tool ?? request.toolName}`;
  }
  return `${boundary}:${request.toolName}`;
}

/**
 * @param {Record<string, any>} request
 */
export function buildApprovalPreview(request = {}) {
  const toolName = request.toolName ?? "unknown";
  const input = request.input ?? {};
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

function approvalBoundaryKey(request) {
  const decision = request?.decision ?? {};
  return [
    decision.sensitive === true ? "sensitive" : "normal",
    decision.outsideWorkspace === true ? "outside" : "workspace"
  ].join(":");
}

function truncate(value, max) {
  const text = String(value ?? "");
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3))}...`;
}
