import { composerSegments, displayWidth } from "./input-editor.js";
import { parseMarkdownBlocks, renderTable } from "./markdown-table.js";

export const SIDE_VIEWS = ["status", "workflow", "tasks"];
export const DETAIL_MODES = ["compact", "detailed", "full"];
export const PERMISSION_MODES = ["plan", "workspace", "fullAccess"];
export const ANT_CODE_LOGO = [
  "    _    _   _ _____      ____ ___  ____  _____",
  "   / \\  | \\ | |_   _|    / ___/ _ \\|  _ \\| ____|",
  "  / _ \\ |  \\| | | |_____| |  | | | | | | |  _|",
  " / ___ \\| |\\  | | |_____| |__| |_| | |_| | |___",
  "/_/   \\_\\_| \\_| |_|      \\____\\___/|____/|_____|"
];
const SPINNER_FRAMES = ["-", "\\", "|", "/"];
const FOLD_SOFT_WRAP_WIDTH = 120;
export const APPROVAL_CHOICES = Object.freeze([
  { key: "y", action: "allow-once", label: "允许一次" },
  { key: "a", action: "allow-session", label: "本会话允许" },
  { key: "n", action: "deny", label: "拒绝" },
  { key: "escape", action: "cancel", label: "取消" }
]);

export function nextSideView(value, direction = 1) {
  const index = SIDE_VIEWS.indexOf(value);
  const current = index >= 0 ? index : 0;
  const next = (current + direction + SIDE_VIEWS.length) % SIDE_VIEWS.length;
  return SIDE_VIEWS[next] ?? SIDE_VIEWS[0];
}

export function nextDetailMode(value) {
  const index = DETAIL_MODES.indexOf(value);
  return DETAIL_MODES[(index + 1) % DETAIL_MODES.length] ?? DETAIL_MODES[0];
}

export function detailModeLabel(value) {
  if (value === "full") {
    return "完整";
  }
  if (value === "detailed") {
    return "详细";
  }
  return "紧凑";
}

export function initialPermissionMode(session) {
  if (session?.permissionReadonlyLocked ?? session?.readonly) {
    return "plan";
  }
  if (session?.permissionMode) {
    return normalizePermissionMode(session.permissionMode);
  }
  if (session?.fullAccess) {
    return "fullAccess";
  }
  if (session?.allowWrite || session?.allowCommand) {
    return "workspace";
  }
  return "plan";
}

export function allowedPermissionModes(session) {
  if (session?.permissionReadonlyLocked) {
    return ["plan"];
  }
  return PERMISSION_MODES;
}

export function nextPermissionMode(session, current) {
  const modes = allowedPermissionModes(session);
  const index = modes.indexOf(normalizePermissionMode(current));
  return modes[(index + 1) % modes.length] ?? modes[0];
}

export function applyPermissionMode(session, mode) {
  const normalized = normalizePermissionMode(mode);
  session.permissionMode = normalized;
  session.fullAccess = normalized === "fullAccess";
  session.readonly = Boolean(session.permissionReadonlyLocked) && normalized === "plan";
  session.allowWrite = normalized === "workspace" || normalized === "fullAccess";
  session.allowCommand = normalized === "workspace" || normalized === "fullAccess";
  return session;
}

export function permissionModeDescription(mode) {
  const normalized = normalizePermissionMode(mode);
  if (normalized === "workspace") {
    return "工作区权限；工作区内非敏感读写和常规本地命令自动同意";
  }
  if (normalized === "fullAccess") {
    return "完全访问；测试机模式，所有本地工具、MCP、浏览器、网络和任意路径操作自动同意";
  }
  return "计划/确认模式；写入、命令和外部能力需要你确认后执行";
}

export function normalizePermissionMode(mode) {
  if (mode === "fullAccess" || mode === "full-access" || mode === "完全访问") {
    return "fullAccess";
  }
  if (mode === "workspace" || mode === "workspacePermissions" || mode === "bypassPermissions" || mode === "acceptEdits" || mode === "工作区权限") {
    return "workspace";
  }
  return "plan";
}

export function panelTitle(view) {
  if (view === "workflow") {
    return "任务";
  }
  if (view === "tasks") {
    return "子智能体";
  }
  return "状态";
}

export function sideColor(view) {
  if (view === "workflow") {
    return "green";
  }
  if (view === "tasks") {
    return "cyan";
  }
  return "green";
}

export function line(text, dim = false, color = undefined, metadata = undefined) {
  return metadata && typeof metadata === "object"
    ? { text, dim, color, ...metadata }
    : { text, dim, color };
}

/**
 * @param {Awaited<import("../../core/session.js").createSession>} session
 */
export function startupBannerLines(session) {
  const gateway = session.config.lab.gatewayUrl
    ? `${session.config.lab.gatewayProtocol ?? "lab-agent-gateway"} 就绪`
    : "网关缺失";
  const workspaceWarning = session.workspaceDiagnostic?.warning;
  return [
    ...ANT_CODE_LOGO,
    "",
    `模型：${session.model}`,
    `网关：${gateway}`,
    `模式：${permissionModeLabel(session)} / 网络=${session.networkMode}`,
    ...(workspaceWarning ? [`工作区提醒：${workspaceWarning}`] : []),
    "边界：本地工具只在这个终端客户端内执行",
    "命令：/help /status /gateway /files /diff /verify /next /report",
    "按键：Enter 发送，Ctrl+J 换行，Tab 面板，Ctrl+C 两次退出"
  ];
}

/**
 * @param {string} cwd
 * @param {boolean} trusted
 */
export function startupConfirmLines(cwd, trusted, workspaceDiagnostic = null) {
  return [
    "启动 Ant Code",
    "",
    `cwd: ${truncateMiddle(cwd, 76)}`,
    `工作区信任：${trusted ? "已授权" : "运行工具前需要确认"}`,
    ...(workspaceDiagnostic?.warning
      ? [
      "",
      `工作区提醒：${workspaceDiagnostic.warning}`,
        "子智能体会继承当前 cwd；要调查哪个项目，就从那个项目目录启动。"
      ]
      : []),
    "",
    "本地工具会在这个终端客户端中运行。",
    "模型流量只发送到配置好的实验室网关。",
    "",
    "Enter：继续",
    "Esc：退出"
  ];
}

/**
 * @param {number} pulse
 */
export function spinnerFrame(pulse) {
  return SPINNER_FRAMES[Math.abs(pulse) % SPINNER_FRAMES.length];
}

/**
 * @param {{ active?: boolean; text?: string; thinking?: string; thinkingVisible?: boolean; tools?: Array<Record<string, any>>; round?: number | null }} stream
 * @param {number} pulse
 */
export function streamingPanelLines(stream, pulse = 0, detailMode = "compact") {
  if (!stream?.active) {
    return [];
  }
  const frame = spinnerFrame(pulse);
  const phase = streamPhaseLabel(stream);
  const lines = [
    line(`${frame} ${phase} - 第 ${stream.round ?? "?"} 轮`, false, streamPhaseColor(stream))
  ];
  if (stream.thinkingBytes > 0 || stream.thinking) {
    lines.push(...thinkingDisplayLines(stream, detailMode, { preview: true }));
  } else if (!stream.text) {
    lines.push(line("thinking：等待可见模型 token", true, "yellow"));
  }
  if (stream.text) {
    lines.push(line(`草稿：${truncate(stripWhitespace(stream.text), 160)}`, false, "green"));
  }
  for (const tool of (stream.tools ?? []).slice(-3)) {
    const name = tool.name || tool.nameDraft || `tool#${Number(tool.index ?? 0) + 1}`;
    const args = stripWhitespace(tool.argumentsDraft ?? "");
    const status = tool.status ? ` [${tool.status}]` : "";
    lines.push(line(`工具${status}：${name}${args ? ` ${truncate(args, 70)}` : ""}`, true, "cyan"));
  }
  return lines;
}

export function streamingViewport(stream, rowBudget, width, scrollOffset = 0, pulse = 0, detailMode = "compact") {
  const budget = Math.max(1, Number(rowBudget) || 1);
  const rows = streamingRows(stream, width, pulse, detailMode);
  const totalRows = rows.length;
  const maxOffset = Math.max(0, totalRows - budget);
  const offset = Math.min(Math.max(0, Number(scrollOffset) || 0), maxOffset);
  const end = Math.max(0, totalRows - offset);
  const start = Math.max(0, end - budget);
  return {
    lines: rows.slice(start, end),
    totalRows,
    offset,
    maxOffset,
    firstRow: totalRows === 0 ? 0 : start + 1,
    lastRow: end
  };
}

function streamingRows(stream, width, pulse, detailMode) {
  if (!stream?.active) {
    return [];
  }
  const rows = [];
  for (const item of streamingStatusLines(stream, pulse, detailMode)) {
    rows.push(...wrapTranscriptLine(item, width));
  }
  return rows;
}

function streamingStatusLines(stream, pulse, detailMode) {
  const frame = spinnerFrame(pulse);
  const lines = [
    line(`${frame} ${streamPhaseLabel(stream)} - 第 ${stream.round ?? "?"} 轮`, false, streamPhaseColor(stream))
  ];
  if (stream.thinkingBytes > 0 || stream.thinking) {
    lines.push(...thinkingDisplayLines(stream, detailMode));
  } else if (!stream.text) {
    lines.push(line("thinking：等待可见模型 token", true, "yellow"));
  }
  if (stream.text) {
    lines.push(line("草稿：", false, "green"));
    for (const item of String(stream.text).split(/\r?\n/)) {
      lines.push(line(`  ${item || " "}`, false, "green"));
    }
  }
  for (const tool of (stream.tools ?? []).slice(-5)) {
    const name = tool.name || tool.nameDraft || `tool#${Number(tool.index ?? 0) + 1}`;
    const args = stripWhitespace(tool.argumentsDraft ?? "");
    const status = tool.status ? ` [${tool.status}]` : "";
    lines.push(line(`工具${status}：${name}${args ? ` ${truncate(args, 180)}` : ""}`, true, "cyan"));
  }
  return lines;
}

export function streamPhaseLabel(stream = {}) {
  if (stream.text) {
    return "生成回答";
  }
  if ((stream.thinkingBytes ?? 0) > 0 || stream.thinking) {
    return "思考中";
  }
  if (stream.phase === "requesting") {
    return "等待模型";
  }
  if (stream.phase === "thinking") {
    return "思考中";
  }
  if (stream.phase === "answering" || stream.phase === "streaming") {
    return "接收中";
  }
  if (stream.phase === "tool-call") {
    return "准备工具";
  }
  if (stream.phase === "tool-running") {
    return "运行工具";
  }
  if (stream.phase === "tool-interrupted") {
    return "工具中断";
  }
  if (stream.phase === "tool-finished") {
    return "工具完成";
  }
  if (stream.phase === "finalizing") {
    return "收尾中";
  }
  if (stream.phase === "interrupted") {
    return "已中断";
  }
  if (stream.phase === "failed") {
    return "失败";
  }
  if ((stream.tools ?? []).length > 0) {
    return "准备工具";
  }
  return "工作中";
}

function streamPhaseColor(stream = {}) {
  if (stream.phase === "interrupted" || stream.phase === "tool-interrupted" || stream.phase === "failed") {
    return "red";
  }
  if (stream.phase === "tool-call" || stream.phase === "tool-running" || stream.phase === "tool-finished") {
    return "cyan";
  }
  if ((stream.thinkingBytes ?? 0) > 0 || stream.thinking || stream.phase === "thinking" || stream.phase === "finalizing") {
    return "yellow";
  }
  return "magenta";
}

export function thinkingSummaryLine(stream, detailMode = "compact") {
  const bytes = stream.thinkingBytes ?? Buffer.byteLength(String(stream.thinking ?? ""), "utf8");
  if (bytes <= 0) {
    return "thinking：等待可见模型 token";
  }
  if (stream.thinkingVisible) {
    return `thinking：已展开 ${bytes} 字节，当前可见预览可查看${stream.thinkingTruncated ? "（已保留最新片段）" : ""}`;
  }
  if (detailMode === "compact") {
    return `thinking：已收到 ${bytes} 字节，默认隐藏；输入 /thinking 展开`;
  }
  return `thinking：已收到 ${bytes} 字节，默认隐藏；输入 /thinking 展开当前可见预览`;
}

function thinkingDisplayLines(stream, detailMode = "compact", options = {}) {
  if (!stream?.thinkingVisible) {
    return [line(thinkingSummaryLine(stream, detailMode), true, "yellow")];
  }
  const bytes = stream.thinkingBytes ?? Buffer.byteLength(String(stream.thinking ?? ""), "utf8");
  const text = String(stream.thinking ?? "");
  const rows = splitFoldableLines(text);
  if (rows.length === 0) {
    return [line(`thinking：已展开 ${bytes} 字节；等待预览 token`, true, "yellow")];
  }
  const limit = options.preview
    ? 2
    : detailMode === "full"
      ? 160
      : detailMode === "detailed"
        ? 80
        : 24;
  const visible = rows.slice(-Math.max(1, limit));
  const hidden = Math.max(0, rows.length - visible.length);
  return [
    line(`thinking：已展开 ${bytes} 字节，当前可见预览可查看${stream.thinkingTruncated ? "（已截断前部，保留最新片段）" : ""}`, false, "yellow"),
    ...(hidden > 0 ? [line(`  ... 已省略前 ${hidden} 行；Ctrl+O 可切换详情，滚轮查看 live 面板`, true, "yellow")] : []),
    ...visible.map((item) => line(`  ${item || " "}`, true, "yellow"))
  ];
}

export function trustDialogLines(cwd, status = "needed") {
  const lines = [
    "需要信任工作区",
    "",
    `cwd: ${truncateMiddle(cwd, 76)}`,
    "",
    "Ant Code 可以在此工作区读取文件、运行本地工具并请求编辑。",
    "信任决定保存在 Ant Code 用户配置目录中，不写入仓库。",
    "",
    "Enter：信任此工作区",
    "Esc：退出"
  ];
  if (status === "saving") {
    lines.push("", "正在保存信任决定...");
  } else if (status === "error") {
    lines.push("", "无法保存信任决定。按 Esc 退出。");
  }
  return lines;
}

/**
 * @param {{ toolName: string; input: Record<string, any> }} request
 */
export function approvalKeyFor(request) {
  const boundary = approvalBoundaryKey(request);
  if (request.toolName === "write_file" || request.toolName === "edit_file") {
    return `write:${boundary}:${request.toolName}:${request.input.path ?? ""}`;
  }
  if (request.toolName === "read_file" || request.toolName === "list_files" || request.toolName === "glob" || request.toolName === "grep" || request.toolName === "document_intake") {
    return `path:${boundary}:${request.toolName}:${request.input.path ?? ""}:${request.input.pattern ?? ""}`;
  }
  if (request.toolName === "powershell" || request.toolName === "bash") {
    return `command:${boundary}:${request.toolName}:${request.input.command ?? ""}`;
  }
  if (request.toolName === "mcp_call") {
    return `mcp:${boundary}:${request.input.server ?? ""}:${request.input.tool ?? ""}:${request.decision?.targetPath ?? request.decision?.resolvedPath ?? ""}`;
  }
  const risk = request.definition?.risk;
  if (risk === "network") {
    return `network:${boundary}:${request.toolName}:${request.input.url ?? request.input.query ?? ""}`;
  }
  if (risk === "browser") {
    return `browser:${boundary}:${request.input.server ?? ""}:${request.input.tool ?? request.toolName}`;
  }
  if (risk === "memory") {
    return `memory:${boundary}:${request.input.server ?? ""}:${request.input.tool ?? request.toolName}`;
  }
  return `${boundary}:${request.toolName}`;
}

function approvalBoundaryKey(request) {
  const decision = request?.decision ?? {};
  return [
    decision.sensitive === true ? "sensitive" : "normal",
    decision.outsideWorkspace === true ? "outside" : "workspace"
  ].join(":");
}

/**
 * @param {string} toolName
 * @param {Record<string, any>} value
 */
export function summarizeInput(toolName, value) {
  if (toolName === "write_file") {
    return JSON.stringify({
      path: value.path,
      contentBytes: Buffer.byteLength(String(value.content ?? ""), "utf8")
    });
  }
  if (toolName === "edit_file") {
    return JSON.stringify({
      path: value.path,
      oldTextBytes: Buffer.byteLength(String(value.oldText ?? ""), "utf8"),
      newTextBytes: Buffer.byteLength(String(value.newText ?? ""), "utf8"),
      expectedReplacements: value.expectedReplacements,
      dryRun: Boolean(value.dryRun),
      writesFile: !value.dryRun
    });
  }
  if (toolName === "powershell" || toolName === "bash") {
    return JSON.stringify({
      command: truncate(String(value.command ?? ""), 300),
      timeoutMs: value.timeoutMs
    });
  }
  if (toolName === "mcp_call") {
    return JSON.stringify({
      server: value.server,
      tool: value.tool,
      argumentBytes: Buffer.byteLength(JSON.stringify(value.arguments ?? {}), "utf8")
    });
  }
  return truncate(JSON.stringify(value), 500);
}

export function promptLines(mode, busy, inputBuffer, questionBuffer, options = {}) {
  const showCursor = options.showCursor !== false;
  const draftColumns = Number.isFinite(options.draftColumns) ? options.draftColumns : null;
  const maxPromptLines = Number.isFinite(options.maxPromptLines)
    ? Math.max(1, Math.floor(Number(options.maxPromptLines)))
    : null;
  if (mode === "approval") {
    return [
      { text: "权限弹窗已打开" },
      { text: "  用方向键/Tab 后按 Enter，或 Y 允许一次、A 本会话允许、N 拒绝、Esc 取消。", dim: true }
    ];
  }
  if (mode === "question") {
    return questionPromptLines(questionBuffer, options.questionCursor, {
      pendingQuestion: options.pendingQuestion,
      showCursor,
      draftColumns,
      maxPromptLines
    });
  }
  if (busy) {
    const queued = Array.isArray(options.queuedPrompts) ? options.queuedPrompts : [];
    const draftLines = promptDraftLines("队列>", inputBuffer, options.inputCursor, showCursor, draftColumns, maxPromptLines);
    return [
      ...(inputBuffer
        ? draftLines
        : [{ text: "队列> Ant Code 忙碌时可输入；Enter 入队，/guide <文本> 会中断并优先运行", dim: true }]),
      ...(queued.length > 0 ? [{ text: `  已排队：${queued.length} 条提示`, dim: true }] : [])
    ];
  }
  const shellMode = String(inputBuffer ?? "").trimStart().startsWith("!");
  const prompt = shellMode ? "Shell>" : ">";
  const draftLines = promptDraftLines(prompt, inputBuffer, options.inputCursor, showCursor, draftColumns, maxPromptLines);
  const lines = [
    ...draftLines,
    ...(inputBuffer.includes("\n") ? [{ text: `${inputBuffer.split(/\r?\n/).length} 行草稿；Enter 提交，Ctrl+J 新增一行`, dim: true }] : [])
  ];
  return maxPromptLines ? lines.slice(0, maxPromptLines) : lines;
}

export function normalizeQuestionPrompt(pendingQuestion = {}) {
  const choices = Array.isArray(pendingQuestion.choices)
    ? pendingQuestion.choices.map(normalizeQuestionChoice).filter(Boolean)
    : [];
  const selectedIndices = Array.isArray(pendingQuestion.selectedIndices)
    ? pendingQuestion.selectedIndices
      .map((index) => Number(index))
      .filter((index) => Number.isInteger(index) && index >= 0 && index < choices.length)
    : [];
  const seededSelected = choices
    .map((choice, index) => choice.selected ? index : -1)
    .filter((index) => index >= 0);
  const normalizedSelected = selectedIndices.length > 0 ? selectedIndices : seededSelected;
  const focusedIndex = choices.length > 0
    ? Math.min(Math.max(0, Number(pendingQuestion.focusedIndex) || 0), choices.length - 1)
    : 0;
  const multiple = Boolean(pendingQuestion.multiple || pendingQuestion.selectionMode === "multi");
  const allowCustom = choices.length === 0 || pendingQuestion.allowCustom !== false;

  return {
    header: String(pendingQuestion.header ?? "模型提问"),
    question: String(pendingQuestion.question ?? pendingQuestion.prompt ?? "模型请求澄清"),
    choices,
    multiple,
    allowCustom,
    confirmLabel: String(pendingQuestion.confirmLabel ?? "确认"),
    focusedIndex,
    selectedIndices: multiple
      ? [...new Set(normalizedSelected)]
      : normalizedSelected.slice(0, 1)
  };
}

function questionPromptLines(questionBuffer, questionCursor, options = {}) {
  const prompt = normalizeQuestionPrompt(options.pendingQuestion);
  const showCursor = options.showCursor !== false;
  const maxPromptLines = Number.isFinite(options.maxPromptLines)
    ? Math.max(1, Math.floor(Number(options.maxPromptLines)))
    : null;
  const draftPrompt = prompt.choices.length > 0 ? "自定义>" : "回答>";
  const draftLines = prompt.allowCustom
    ? promptDraftLines(draftPrompt, questionBuffer, questionCursor, showCursor, options.draftColumns, maxPromptLines)
    : [];
  if (prompt.choices.length === 0) {
    const lines = [
      line(`${prompt.header}：${truncate(prompt.question, 96)}`, false, "cyan"),
      ...draftLines,
      line("Enter 提交；Esc 取消。", true)
    ];
    return maxPromptLines ? lines.slice(0, maxPromptLines) : lines;
  }
  const visibleChoices = visibleQuestionChoices(prompt);
  const lines = [
    line(`${prompt.header}：${truncate(prompt.question, 96)}`, false, "cyan"),
    ...visibleChoices.map(({ choice, index }) => {
      const focused = index === prompt.focusedIndex;
      const selected = prompt.selectedIndices.includes(index);
      const marker = prompt.multiple ? `[${selected ? "x" : " "}]` : `(${selected || focused ? "x" : " "})`;
      const description = choice.description ? ` - ${choice.description}` : "";
      return line(`${focused ? ">" : " "} ${marker} ${truncate(`${choice.label}${description}`, 90)}`, false, focused ? "cyan" : undefined);
    }),
    ...(prompt.choices.length > visibleChoices.length ? [line(`... 共 ${prompt.choices.length} 项，用方向键查看更多`, true)] : []),
    ...(prompt.allowCustom ? draftLines : []),
    line(`${prompt.multiple ? "↑/↓ 选择，Space 勾选，" : "↑/↓ 选择，"}Enter ${prompt.confirmLabel}；Esc 取消。`, false, "cyan")
  ];
  return maxPromptLines ? lines.slice(0, maxPromptLines) : lines;
}

function visibleQuestionChoices(prompt) {
  const maxVisible = prompt.choices.length > 4 ? 3 : 4;
  if (prompt.choices.length <= maxVisible) {
    return prompt.choices.map((choice, index) => ({ choice, index }));
  }
  const start = Math.min(
    Math.max(0, prompt.focusedIndex - 1),
    Math.max(0, prompt.choices.length - maxVisible)
  );
  return prompt.choices.slice(start, start + maxVisible).map((choice, offset) => ({
    choice,
    index: start + offset
  }));
}

function normalizeQuestionChoice(choice) {
  if (typeof choice === "string") {
    const label = choice.trim();
    return label ? { label, value: label, description: "", selected: false } : null;
  }
  if (!choice || typeof choice !== "object") {
    return null;
  }
  const label = String(choice.label ?? choice.text ?? choice.title ?? choice.value ?? "").trim();
  if (!label) {
    return null;
  }
  return {
    label,
    value: String(choice.value ?? label),
    description: String(choice.description ?? choice.detail ?? "").trim(),
    selected: Boolean(choice.selected ?? choice.default)
  };
}

export function exitConfirmLines(options = {}) {
  const busy = Boolean(options.busy);
  return [
    "退出 Ant Code？",
    busy
      ? "模型/工具轮次正在运行。第一次 Ctrl+C 只进入退出确认。"
      : "第一次 Ctrl+C 只进入退出确认。",
    "再次按 Ctrl+C 退出；继续输入则留在 TUI。"
  ];
}

export function interruptConfirmLines() {
  return [
    "中断当前轮次？",
    "再次按 Esc 中断模型/工具轮次。",
    "按 Ctrl+G 可直接中断；继续输入则取消本次确认。"
  ];
}

/**
 * @param {{ request?: Record<string, any>; toolName?: string } | null} pendingApproval
 * @param {number} focusedIndex
 */
export function permissionModalLines(pendingApproval, focusedIndex = 0) {
  const request = pendingApproval?.request ?? pendingApproval ?? {};
  const toolName = request.toolName ?? pendingApproval?.toolName ?? "unknown";
  const risk = request.definition?.risk ?? "unknown";
  const reason = request.decision?.reason ?? "需要审批";
  const preview = permissionPreviewLines(request);
  const sensitive = request.decision?.sensitive === true;
  return [
    line("需要权限", false, "yellow"),
    line(`${riskBadge(risk)} ${toolName}`, false, riskColor(risk)),
    line(reason, true),
    ...(sensitive
      ? [
          line("敏感信息强确认：批准后相关文件内容或变更可能进入模型上下文。", false, "yellow"),
          line("仅在你主动需要读取或修改密钥/凭据时允许。", false, "yellow")
        ]
      : []),
    ...preview.map((item) => line(item, true)),
    line(""),
    line(APPROVAL_CHOICES.map((choice, index) => {
      const focused = index === focusedIndex;
      return `${focused ? ">" : " "} ${choice.label} (${choice.key === "escape" ? "Esc" : choice.key.toUpperCase()})`;
    }).join("   "), false, "yellow")
  ];
}

/**
 * @param {Record<string, any>} request
 */
export function permissionPreviewLines(request = {}) {
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
      `命令：${truncate(String(input.command ?? ""), 180)}`,
      `超时：${input.timeoutMs ?? "默认"}`
    ];
  }
  if (toolName === "mcp_call") {
    return [
      `服务器：${input.server ?? "unknown"}`,
      `工具：${input.tool ?? "unknown"}`,
      request.decision?.targetPath ? `路径：${request.decision.targetPath}` : null,
      `参数：${truncate(JSON.stringify(input.arguments ?? {}), 180)}`
    ].filter(Boolean);
  }
  if (request.definition?.risk === "network") {
    return [
      `目标：${input.url ?? input.query ?? "unknown"}`,
      "网络访问会按 host allowlist 和当前网络模式审批。"
    ];
  }
  if (request.definition?.risk === "browser") {
    return [
      `浏览器动作：${input.tool ?? toolName}`,
      `目标/参数：${truncate(JSON.stringify(input.arguments ?? input), 180)}`,
      "浏览器自动化可能读取页面内容或使用当前浏览器会话状态。"
    ];
  }
  if (request.definition?.risk === "document") {
    return [
      `文档：${input.path ?? "unknown"}`,
      "仅做有界文本抽取；不会把原文件完整展开。"
    ];
  }
  if (request.definition?.risk === "memory") {
    return [
      `记忆工具：${input.tool ?? toolName}`,
      `参数：${truncate(JSON.stringify(input.arguments ?? input), 180)}`,
      "长期记忆写入会作为高风险本地状态变更处理。"
    ];
  }
  return [`输入：${summarizeInput(toolName, input)}`];
}

/**
 * @param {{ kind?: string; title?: string; body?: string }} entry
 */
export function transcriptBlockLines(entry = {}, detailMode = "compact", options = {}) {
  if (entry.kind === "user") {
    const compactUser = compactUserPromptLines(entry.body, detailMode);
    if (compactUser) {
      return [
        line("你", false, "cyan"),
        ...compactUser
      ];
    }
    return [
      line("你", false, "cyan"),
      ...foldBodyLines(splitFoldableLines(entry.body), detailMode, { compact: 8, detailed: 24 }).map((item) => line(`  ${item.text}`, item.dim))
    ];
  }
  if (entry.kind === "assistant") {
    const thinking = assistantThinkingLines(entry, detailMode);
    const bodyLines = assistantBodyLines(entry.body, detailMode, options);
    return [
      line("Ant Code", false, "green"),
      ...thinking,
      ...bodyLines
    ];
  }
  if (entry.kind === "tool" || entry.kind === "tools") {
    return toolCardLines(entry, detailMode);
  }
  if (entry.kind === "trace") {
    return [
      line(`过程 - ${entry.title ?? "已收起"}`, false, "cyan"),
      ...splitFoldableLines(entry.body).map((item) => line(`  ${item}`, true))
    ];
  }
  if (entry.kind === "agent") {
    return agentTaskCardLines(entry, detailMode);
  }
  if (entry.kind === "session") {
    return [
      line(`会话 - ${entry.title ?? ""}`.trim(), false, "cyan"),
      ...splitFoldableLines(entry.body).map((item) => line(`  ${item}`, false))
    ];
  }
  if (entry.kind === "approval") {
    return [
      line(`权限 - ${entry.title ?? "decision"}`, false, "yellow"),
      ...foldBodyLines(splitFoldableLines(entry.body), detailMode, { compact: 2, detailed: 8 }).map((item) => line(`  ${item.text}`, true))
    ];
  }
  if (entry.kind === "error") {
    return [
      line(`错误 - ${entry.title ?? "runtime"}`, false, "red"),
      ...foldBodyLines(splitFoldableLines(entry.body), detailMode, { compact: 4, detailed: 12 }).map((item) => line(`  ${item.text}`, item.dim))
    ];
  }
  return [
    line(`${entry.kind ?? "event"} - ${entry.title ?? ""}`.trim(), false, colorForKind(entry.kind)),
    ...foldBodyLines(splitFoldableLines(entry.body), detailMode, { compact: 1, detailed: 6 }).map((item) => line(`  ${item.text}`, true))
  ];
}

export function transcriptEntriesWithThinkingVisibility(entries = [], thinkingVisible = false) {
  return entries.map((entry) => {
    if (entry?.kind !== "assistant") {
      return entry;
    }
    const thinking = String(entry.thinking ?? "");
    const thinkingBytes = entry.thinkingBytes ?? Buffer.byteLength(thinking, "utf8");
    if (!thinkingVisible || !thinking) {
      return {
        ...entry,
        thinking: "",
        thinkingVisible: false,
        thinkingBytes
      };
    }
    return {
      ...entry,
      thinkingVisible: true,
      thinkingBytes
    };
  });
}

/**
 * Render assistant body text as a sequence of line objects.
 * Parses the body into markdown blocks: paragraphs go through splitFoldableLines,
 * table blocks are rendered by the markdown-table module with noWrap metadata.
 */
function assistantBodyLines(body, detailMode = "compact", options = {}) {
  const bodyText = String(body ?? "");
  if (!bodyText) {
    return [];
  }
  const tableWidth = Number.isFinite(options.tableWidth) && Number(options.tableWidth) > 0
    ? Math.floor(Number(options.tableWidth))
    : null;
  const blocks = parseMarkdownBlocks(bodyText);
  // If there's only one paragraph block, fall back to the original behavior
  if (blocks.length === 1 && blocks[0].type === "paragraph") {
    return splitFoldableLines(bodyText).map((item) => line(`  ${item}`, false));
  }
  const result = [];
  for (const block of blocks) {
    if (block.type === "table") {
      const tableLines = renderTable(block, tableWidth ?? FOLD_SOFT_WRAP_WIDTH);
      for (const tl of tableLines) {
        result.push({ ...tl, text: `  ${tl.text}` });
      }
    } else if (block.type === "code") {
      for (const codeLine of splitFoldableLines(block.text)) {
        result.push(line(`  ${codeLine}`, false, "code"));
      }
    } else {
      // paragraph
      for (const paraLine of splitFoldableLines(block.text)) {
        result.push(line(`  ${paraLine}`, false));
      }
    }
  }
  return result;
}

function assistantThinkingLines(entry = {}, detailMode = "compact") {
  const bytes = entry.thinkingBytes ?? Buffer.byteLength(String(entry.thinking ?? ""), "utf8");
  if (bytes <= 0) {
    return [];
  }
  if (!entry.thinkingVisible) {
    return [line(`  thinking：已收到 ${bytes} 字节，默认隐藏；输入 /thinking 展开`, true, "yellow")];
  }
  const rows = splitFoldableLines(entry.thinking);
  const folded = foldBodyLines(rows, detailMode, { compact: 12, detailed: 80 });
  return [
    line(`  thinking：已展开 ${bytes} 字节，当前可见预览可查看${entry.thinkingTruncated ? "（已截断前部，保留最新片段）" : ""}`, false, "yellow"),
    ...folded.map((item) => line(`    ${item.text}`, true, "yellow"))
  ];
}

function compactUserPromptLines(body, detailMode) {
  if (detailMode === "full") {
    return null;
  }
  const text = String(body ?? "");
  const lines = text.split(/\r?\n/);
  const bytes = Buffer.byteLength(text, "utf8");
  if (lines.length < 8 && bytes < 1200) {
    return null;
  }
  const preview = lines.map((item) => item.trim()).find(Boolean) ?? "[空行]";
  return [
    line(`  {${lines.length} lines, ${bytes} bytes 粘贴文本}`, false, "yellow"),
    line(`  ${truncate(preview, 110)}`, true),
    line("  Ctrl+O 可切换完整/折叠显示。", true)
  ];
}

/**
 * @param {{ title?: string; body?: string }} entry
 */
export function toolCardLines(entry = {}, detailMode = "compact") {
  const title = String(entry.title ?? "tool");
  const state = inferToolState(title, entry.body);
  const name = title.replace(/\s+(running|done|blocked|failed)$/i, "");
  return [
    line(`${toolStatusMarker(state)} ${toolClassLabel(name)} - ${title}`, false, toolStateColor(state)),
    ...foldBodyLines(splitFoldableLines(entry.body), detailMode, { compact: 2, detailed: 8 }).map((item) => line(`  ${item.text}`, true))
  ];
}

function agentTaskCardLines(entry = {}, detailMode = "compact") {
  const status = entry.taskStatus ?? inferAgentTaskStatus(entry.title, entry.body);
  return [
    line(`${agentTaskMarker(status)} 子智能体 - ${entry.title ?? "任务"}`, false, agentTaskColor(status)),
    ...foldBodyLines(splitFoldableLines(entry.body), detailMode, { compact: 5, detailed: 14 }).map((item) => line(`  ${item.text}`, item.dim))
  ];
}

function splitFoldableLines(value) {
  const rows = [];
  for (const item of splitLines(value)) {
    rows.push(...softWrapFoldLine(item, FOLD_SOFT_WRAP_WIDTH));
  }
  return rows;
}

function softWrapFoldLine(value, maxWidth) {
  const text = String(value ?? "");
  if (displayWidth(text) <= maxWidth) {
    return [text];
  }
  const rows = [];
  let current = "";
  let currentWidth = 0;
  for (const char of Array.from(text)) {
    const charWidth = Math.max(0, displayWidth(char));
    if (current && currentWidth + charWidth > maxWidth) {
      rows.push(current);
      current = char;
      currentWidth = charWidth;
    } else {
      current += char;
      currentWidth += charWidth;
    }
  }
  if (current) {
    rows.push(current);
  }
  return rows;
}

function foldBodyLines(lines, detailMode, limits) {
  const all = Array.isArray(lines) ? lines : [];
  const limit = detailMode === "full"
    ? Infinity
    : detailMode === "detailed"
      ? limits.detailed
      : limits.compact;
  if (!Number.isFinite(limit) || all.length <= limit) {
    return all.map((text) => ({ text, dim: false }));
  }
  const shown = all.slice(0, Math.max(0, limit)).map((text) => ({ text, dim: false }));
  shown.push({
    text: `... 已折叠 ${all.length - limit} 行；Ctrl+O 查看${detailMode === "compact" ? "详细" : "完整"}内容`,
    dim: true
  });
  return shown;
}

function inferToolState(title, body) {
  const value = `${title} ${body ?? ""}`.toLowerCase();
  if (value.includes("blocked")) {
    return "blocked";
  }
  if (value.includes("failed") || value.includes("error=")) {
    return "failed";
  }
  if (value.includes("cancelled") || value.includes("interrupted")) {
    return "interrupted";
  }
  if (value.includes("done") || value.includes("approved")) {
    return "done";
  }
  return "running";
}

function toolClassLabel(name) {
  if (["read_file", "list_files", "glob", "grep", "git_status", "git_diff"].includes(name)) {
    return "read";
  }
  if (["write_file", "edit_file", "todo_write", "plan_update"].includes(name)) {
    return "edit";
  }
  if (["powershell", "bash"].includes(name)) {
    return "shell";
  }
  if (name === "mcp_call") {
    return "mcp";
  }
  if (name === "ask_user") {
    return "ask";
  }
  return "tool";
}

function toolStatusMarker(state) {
  if (state === "done") {
    return "[ok]";
  }
  if (state === "blocked") {
    return "[blocked]";
  }
  if (state === "failed") {
    return "[failed]";
  }
  if (state === "interrupted") {
    return "[stopped]";
  }
  return "[run]";
}

function toolStateColor(state) {
  if (state === "done") {
    return "green";
  }
  if (state === "blocked") {
    return "yellow";
  }
  if (state === "failed" || state === "interrupted") {
    return "red";
  }
  return "cyan";
}

function inferAgentTaskStatus(title, body) {
  const value = `${title ?? ""} ${body ?? ""}`.toLowerCase();
  if (value.includes("阶段暂停") || value.includes("partial")) {
    return "partial";
  }
  if (value.includes("完成") || value.includes("completed") || value.includes("已完成")) {
    return "completed";
  }
  if (value.includes("阻止") || value.includes("blocked")) {
    return "blocked";
  }
  if (value.includes("中断") || value.includes("取消") || value.includes("interrupted") || value.includes("cancelled")) {
    return "interrupted";
  }
  if (value.includes("失败") || value.includes("failed") || value.includes("error")) {
    return "failed";
  }
  return "running";
}

function agentTaskMarker(status) {
  if (status === "completed") {
    return "[✓]";
  }
  if (status === "partial") {
    return "[..]";
  }
  if (status === "blocked") {
    return "[?]";
  }
  if (status === "failed") {
    return "[!]";
  }
  if (status === "interrupted" || status === "cancelled") {
    return "[-]";
  }
  return "[>]";
}

function agentTaskColor(status) {
  if (status === "completed") {
    return "green";
  }
  if (status === "partial" || status === "blocked") {
    return "yellow";
  }
  if (status === "failed" || status === "interrupted" || status === "cancelled") {
    return "red";
  }
  return "cyan";
}

function riskBadge(risk) {
  if (risk === "read") {
    return "[read]";
  }
  if (risk === "write") {
    return "[write]";
  }
  if (risk === "execute") {
    return "[shell]";
  }
  if (risk === "mcp") {
    return "[mcp]";
  }
  if (risk === "network") {
    return "[network]";
  }
  if (risk === "browser") {
    return "[browser]";
  }
  if (risk === "document") {
    return "[doc]";
  }
  if (risk === "memory") {
    return "[memory]";
  }
  return "[risk]";
}

function riskColor(risk) {
  if (risk === "read") {
    return "cyan";
  }
  if (risk === "write" || risk === "execute" || risk === "mcp" || risk === "browser" || risk === "memory") {
    return "yellow";
  }
  if (risk === "network" || risk === "document") {
    return "magenta";
  }
  return "white";
}

export function promptColor(mode, busy) {
  if (mode === "approval") {
    return "yellow";
  }
  if (mode === "question") {
    return "cyan";
  }
  return busy ? "magenta" : "green";
}

export function colorForKind(kind) {
  if (kind === "error") {
    return "red";
  }
  if (kind === "approval") {
    return "yellow";
  }
  if (kind === "assistant") {
    return "green";
  }
  if (kind === "tool" || kind === "tools") {
    return "cyan";
  }
  if (kind === "agent") {
    return "cyan";
  }
  if (kind === "gateway") {
    return "magenta";
  }
  return "white";
}

export function splitLines(value) {
  return String(value ?? "").split(/\r?\n/).filter((line) => line.length > 0);
}

export function visibleDraftLines(value) {
  const lines = String(value ?? "").split(/\r?\n/);
  const visible = lines.slice(-5);
  return visible.length === 1 && visible[0] === "" ? [] : visible;
}

function promptDraftLines(prompt, text, cursor, showCursor, draftColumns = null, maxLines = null) {
  const value = String(text ?? "");
  const cursorIndex = Number.isFinite(cursor) ? cursor : Array.from(value).length;
  const visibleLines = Number.isFinite(maxLines) ? Math.max(1, Math.floor(Number(maxLines))) : undefined;
  const compactPaste = compactMultilineDraftLines(prompt, value, showCursor);
  if (compactPaste) {
    return visibleLines ? compactPaste.slice(0, visibleLines) : compactPaste;
  }
  if (value.length === 0) {
    return [{
      text: `${prompt}  `,
      segments: [
        { text: `${prompt} `, prompt: true },
        { text: " ", cursor: true, hidden: !showCursor }
      ]
    }];
  }
  const promptColumns = displayWidth(`${prompt} `);
  const continuationColumns = 2;
  const contentColumns = Number.isFinite(draftColumns) && draftColumns > 0
    ? Math.max(8, Math.floor(draftColumns) - Math.max(promptColumns, continuationColumns))
    : null;
  const lines = composerSegments(value, cursorIndex, { showCursor, columns: contentColumns, maxLines: visibleLines });
  if (lines.length === 0) {
    return [{
      text: `${prompt}  `,
      segments: [
        { text: `${prompt} `, prompt: true },
        { text: " ", cursor: true, hidden: !showCursor }
      ]
    }];
  }
  return lines.map((line, index) => {
    const prefix = index === 0 ? `${prompt} ` : "  ";
    return {
      text: `${prefix}${line.text || " "}`,
      segments: [
        { text: prefix, prompt: index === 0 },
        ...(line.segments.length > 0 ? line.segments : [{ text: " " }])
      ]
    };
  });
}

function compactMultilineDraftLines(prompt, value, showCursor = true) {
  const normalized = String(value ?? "");
  const lines = normalized.split(/\r?\n/);
  if (lines.length < 4 && normalized.length < 600) {
    return null;
  }
  const nonEmpty = lines.map((item) => item.trim()).filter(Boolean);
  const preview = nonEmpty[0] ?? lines[0] ?? "";
  const suffix = lines.length === 1 ? "line" : "lines";
  const summary = `${prompt} {${lines.length} ${suffix}, ${Buffer.byteLength(normalized, "utf8")} bytes 粘贴文本}`;
  return [
    line(`${summary} `, false, "yellow", {
      segments: [
        { text: summary },
        { text: " ", cursor: true, hidden: !showCursor }
      ]
    }),
    line(`  ${truncate(preview || "[空行]", 96)}`, true),
    line("  Enter 发送；Esc 清空；Ctrl+J 新增一行。", true)
  ];
}

export function sliceEntriesForRows(entries, rowBudget, width) {
  const selected = [];
  let rows = 0;
  let trimmingTrailingMeta = true;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (trimmingTrailingMeta && isLowPriorityTrailingEntry(entry)) {
      continue;
    }
    trimmingTrailingMeta = false;
    const entryRows = estimateEntryRows(entry, width);
    if (selected.length > 0 && rows + entryRows > rowBudget) {
      break;
    }
    selected.unshift(entry);
    rows += entryRows;
  }
  return selected.length > 0 ? selected : entries.slice(-1);
}

export function transcriptViewport(entries, rowBudget, width, scrollOffset = 0, detailMode = "compact") {
  const budget = Math.max(1, Number(rowBudget) || 1);
  const rows = transcriptRows(entries, width, detailMode);
  const totalRows = rows.length;
  const maxOffset = Math.max(0, totalRows - budget);
  const offset = Math.min(Math.max(0, Number(scrollOffset) || 0), maxOffset);
  const end = Math.max(0, totalRows - offset);
  const start = Math.max(0, end - budget);
  return {
    lines: rows.slice(start, end),
    totalRows,
    offset,
    maxOffset,
    firstRow: totalRows === 0 ? 0 : start + 1,
    lastRow: end
  };
}

function transcriptRows(entries, width, detailMode = "compact") {
  const rows = [];
  const displayEntries = displayEntriesForDetailMode(trimTrailingLowPriorityEntries(entries), detailMode);
  for (const [entryIndex, entry] of displayEntries.entries()) {
    const tableWidth = tableRenderWidth(width);
    const block = entry.kind === "startup"
      ? startupTranscriptLines(entry)
      : transcriptBlockLines(entry, detailMode, { tableWidth });
    for (const item of block) {
      rows.push(...wrapTranscriptLine(withTranscriptEntryMetadata(item, entry), width));
    }
    if (entryIndex < displayEntries.length - 1) {
      rows.push(line(""));
    }
  }
  return rows;
}

function withTranscriptEntryMetadata(item, entry = {}) {
  if (!entry?.id) {
    return item;
  }
  return {
    ...item,
    entryId: entry.id,
    entryKind: entry.kind,
    selectable: isSelectableTranscriptEntry(entry)
  };
}

function isSelectableTranscriptEntry(entry = {}) {
  return ["user", "assistant", "tool", "tools", "trace", "error", "approval", "output", "command", "context", "agent", "session"].includes(entry.kind);
}

function displayEntriesForDetailMode(entries = [], detailMode = "compact") {
  if (detailMode === "full") {
    return entries;
  }
  if (detailMode === "detailed") {
    return collapseRoutineTelemetry(entries);
  }
  return entries.filter((entry) => !isRoutineTelemetryEntry(entry));
}

function collapseRoutineTelemetry(entries = []) {
  const collapsed = [];
  let pending = [];

  const flush = () => {
    if (pending.length === 0) {
      return;
    }
    collapsed.push(makeTelemetrySummaryEntry(pending));
    pending = [];
  };

  for (const entry of entries) {
    if (isRoutineTelemetryEntry(entry)) {
      pending.push(entry);
      continue;
    }
    flush();
    collapsed.push(entry);
  }
  flush();
  return collapsed;
}

function makeTelemetrySummaryEntry(entries) {
  const counts = summarizeTelemetry(entries);
  const parts = [
    counts.gateway ? `网关 ${counts.gateway}` : null,
    counts.tool ? `工具 ${counts.tool}` : null,
    counts.agent ? `子任务 ${counts.agent}` : null,
    counts.turn ? `轮次 ${counts.turn}` : null,
    counts.workflow ? `状态 ${counts.workflow}` : null
  ].filter(Boolean);
  return {
    kind: "trace",
    title: `已收起 ${entries.length} 条运行过程`,
    body: `${parts.join("，") || "运行过程"}。Ctrl+O 再按一次查看完整过程日志。`
  };
}

function summarizeTelemetry(entries) {
  return entries.reduce((summary, entry) => {
    if (entry?.kind === "gateway") {
      summary.gateway += 1;
    } else if (entry?.kind === "tool" || entry?.kind === "tools") {
      summary.tool += 1;
    } else if (entry?.kind === "agent") {
      summary.agent += 1;
    } else if (entry?.kind === "turn") {
      summary.turn += 1;
    } else if (entry?.kind === "workflow") {
      summary.workflow += 1;
    }
    return summary;
  }, { gateway: 0, tool: 0, agent: 0, turn: 0, workflow: 0 });
}

function trimTrailingLowPriorityEntries(entries = []) {
  let end = entries.length;
  while (end > 0 && isLowPriorityTrailingEntry(entries[end - 1])) {
    end -= 1;
  }
  return end === entries.length ? entries : entries.slice(0, end);
}

function startupTranscriptLines(entry) {
  return String(entry.body ?? "")
    .split(/\r?\n/)
    .filter((item) => item.length > 0)
    .map((item, index) => line(
      `  ${item}`,
      index > 6,
      index < 5 ? "cyan" : index === 6 ? "green" : undefined
    ));
}

function wrapTranscriptLine(item, width) {
  // If noWrap is set (e.g., table lines), skip soft-wrap entirely
  if (item?.noWrap) {
    return [item];
  }
  const usableWidth = Math.max(24, width - 6);
  const text = String(item?.text ?? "");
  if (text.length === 0) {
    return [{ ...item, text: "" }];
  }
  const rows = [];
  let current = "";
  let currentWidth = 0;
  for (const char of Array.from(text)) {
    const charWidth = Math.max(0, displayWidth(char));
    if (current && currentWidth + charWidth > usableWidth) {
      rows.push({ ...item, text: current });
      current = char;
      currentWidth = charWidth;
    } else {
      current += char;
      currentWidth += charWidth;
    }
  }
  rows.push({ ...item, text: current || " " });
  return rows;
}

function tableRenderWidth(width) {
  return Math.max(16, Math.max(24, Number(width) || 0) - 8);
}

function isLowPriorityTrailingEntry(entry) {
  return entry?.kind === "turn" && entry?.title === "completed";
}

function isRoutineTelemetryEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  const title = String(entry.title ?? "");
  if (entry.kind === "turn") {
    return /^turn\s+\d+$/i.test(title) || title === "completed";
  }
  if (entry.kind === "gateway") {
    return /^gateway\s+(round|response)\b/i.test(title);
  }
  if (entry.kind === "tools") {
    return true;
  }
  if (entry.kind === "tool") {
    const state = inferToolState(title, entry.body);
    return state === "running" || state === "done";
  }
  if (entry.kind === "workflow" && title === "状态同步") {
    return true;
  }
  return false;
}

function estimateEntryRows(entry, width) {
  const usableWidth = Math.max(24, width - 6);
  const bodyRows = splitLines(entry.body).reduce((sum, lineText) => (
    sum + Math.max(1, Math.ceil(lineText.length / usableWidth))
  ), 0);
  return 1 + bodyRows + 1;
}

/**
 * @param {string} value
 * @param {number} max
 */
export function truncate(value, max) {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}

export function truncateMiddle(value, max) {
  const text = String(value ?? "");
  if (text.length <= max) {
    return text;
  }
  const half = Math.max(4, Math.floor((max - 3) / 2));
  return `${text.slice(0, half)}...${text.slice(text.length - half)}`;
}

export function permissionModeLabel(session) {
  const mode = session?.permissionMode
    ? normalizePermissionMode(session.permissionMode)
    : session?.fullAccess
      ? "fullAccess"
      : session?.allowWrite || session?.allowCommand
        ? "workspace"
        : "plan";
  if (mode === "fullAccess") {
    return "完全访问";
  }
  if (mode === "workspace") {
    return "工作区权限";
  }
  return "计划确认";
}

function stripWhitespace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}
