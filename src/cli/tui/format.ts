import type { AgentSession } from "../../core/session.ts";
import { composerSegments, displayWidth } from "./input-editor.ts";
import { parseMarkdownBlocks, renderTable } from "./markdown-table.ts";
export { approvalKeyFor } from "../../permissions/approval-keys.ts";

export type TuiComposerSegment = {
  text?: string;
  cursor?: boolean;
  hidden?: boolean;
  prompt?: boolean;
};

export type TuiLine = {
  text: string;
  dim?: boolean;
  color?: string;
  entryId?: string;
  entryKind?: string;
  selectable?: boolean;
  noWrap?: boolean;
  segments?: TuiComposerSegment[];
};

export type TuiStreamTool = {
  name?: string;
  nameDraft?: string;
  argumentsDraft?: string;
  status?: string;
  index?: number;
  id?: string | null;
};

export type TuiStream = {
  active?: boolean;
  text?: string;
  thinking?: string;
  thinkingVisible?: boolean;
  thinkingBytes?: number;
  thinkingTruncated?: boolean;
  thinkingRedacted?: boolean;
  tools?: TuiStreamTool[];
  round?: number | null;
  phase?: string;
  stopReason?: string | null;
  messageId?: string | null;
  model?: string | null;
};

export type TuiEntry = {
  kind?: string;
  title?: string;
  body?: string;
  id?: string;
  at?: string;
  taskId?: string;
  excerptBody?: string;
  taskStatus?: string;
  profile?: string;
  thinking?: string;
  thinkingBytes?: number;
  thinkingTruncated?: boolean;
  thinkingVisible?: boolean;
};

type ToolInput = {
  path?: string;
  content?: string;
  oldText?: string;
  newText?: string;
  expectedReplacements?: number;
  dryRun?: boolean;
  command?: string;
  timeoutMs?: number;
  server?: string;
  tool?: string;
  arguments?: unknown;
  url?: string;
  query?: string;
};

type PermissionDecision = {
  reason?: string;
  sensitive?: boolean;
  targetPath?: string;
};

type PermissionDefinition = {
  risk?: string;
};

type PermissionRequest = {
  toolName?: string;
  input?: ToolInput;
  definition?: PermissionDefinition;
  decision?: PermissionDecision;
  request?: PermissionRequest;
};

type QuestionChoice = {
  label: string;
  value: string;
  description: string;
  selected: boolean;
};

type QuestionPrompt = {
  header?: string;
  question?: string;
  prompt?: string;
  choices?: unknown[];
  selectedIndices?: number[];
  focusedIndex?: number;
  multiple?: boolean;
  selectionMode?: string;
  allowCustom?: boolean;
  confirmLabel?: string;
};

type NormalizedQuestionPrompt = {
  header: string;
  question: string;
  choices: QuestionChoice[];
  multiple: boolean;
  allowCustom: boolean;
  confirmLabel: string;
  focusedIndex: number;
  selectedIndices: number[];
};

type PromptLineOptions = {
  showCursor?: boolean;
  draftColumns?: number | null;
  maxPromptLines?: number | null;
  queuedPrompts?: string[];
  pendingQuestion?: QuestionPrompt | null;
  pendingApproval?: PermissionRequest | null;
  inputCursor?: number;
  inputVisibleStart?: number;
  questionCursor?: number;
  questionVisibleStart?: number;
};

type FoldLimits = {
  compact: number;
  detailed: number;
};

type TelemetryCounts = {
  gateway: number;
  tool: number;
  agent: number;
  turn: number;
  workflow: number;
};

type ThinkingDisplayOptions = {
  preview?: boolean;
};

type MarkdownParagraphBlock = { type: "paragraph"; text: string };
type MarkdownCodeBlock = { type: "code"; text: string };
type MarkdownTableBlock = {
  type: "table";
  headers: string[];
  alignments: string[];
  rows: string[][];
  raw: string;
  text?: string;
};
type MarkdownBlock = MarkdownParagraphBlock | MarkdownCodeBlock | MarkdownTableBlock;

type ExitConfirmOptions = {
  busy?: boolean;
};

type ChoiceRecord = {
  label?: unknown;
  text?: unknown;
  title?: unknown;
  value?: unknown;
  description?: unknown;
  detail?: unknown;
  selected?: unknown;
  default?: unknown;
};

const EMPTY_STREAM: TuiStream = {};
const EMPTY_TOOL_INPUT: ToolInput = {};
const EMPTY_PERMISSION_REQUEST: PermissionRequest = {};
const EMPTY_QUESTION_PROMPT: QuestionPrompt = {};
const EMPTY_PROMPT_OPTIONS: PromptLineOptions = {};
const EMPTY_ENTRY: TuiEntry = {};
const EMPTY_THINKING_OPTIONS: ThinkingDisplayOptions = {};
const EMPTY_EXIT_CONFIRM: ExitConfirmOptions = {};

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

export function nextSideView(value: string, direction: number = 1) {
  const index = SIDE_VIEWS.indexOf(value);
  const current = index >= 0 ? index : 0;
  const next = (current + direction + SIDE_VIEWS.length) % SIDE_VIEWS.length;
  return SIDE_VIEWS[next] ?? SIDE_VIEWS[0];
}

export function nextDetailMode(value: string) {
  const index = DETAIL_MODES.indexOf(value);
  return DETAIL_MODES[(index + 1) % DETAIL_MODES.length] ?? DETAIL_MODES[0];
}

export function detailModeLabel(value: string) {
  if (value === "full") {
    return "完整";
  }
  if (value === "detailed") {
    return "详细";
  }
  return "紧凑";
}

export function initialPermissionMode(session: AgentSession) {
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

export function allowedPermissionModes(session: AgentSession) {
  if (session?.permissionReadonlyLocked) {
    return ["plan"];
  }
  return PERMISSION_MODES;
}

export function nextPermissionMode(session: AgentSession, current: string) {
  const modes = allowedPermissionModes(session);
  const index = modes.indexOf(normalizePermissionMode(current));
  return modes[(index + 1) % modes.length] ?? modes[0];
}

export function applyPermissionMode(session: AgentSession, mode: string) {
  const normalized = normalizePermissionMode(mode);
  session.permissionMode = normalized;
  session.fullAccess = normalized === "fullAccess";
  session.readonly = Boolean(session.permissionReadonlyLocked) && normalized === "plan";
  session.allowWrite = normalized === "workspace" || normalized === "fullAccess";
  session.allowCommand = normalized === "workspace" || normalized === "fullAccess";
  return session;
}

export function permissionModeDescription(mode: string) {
  const normalized = normalizePermissionMode(mode);
  if (normalized === "workspace") {
    return "工作区权限；工作区内非敏感读写和常规本地命令自动同意";
  }
  if (normalized === "fullAccess") {
    return "完全访问；测试机模式，所有本地工具、MCP、浏览器、网络和任意路径操作自动同意";
  }
  return "计划/确认模式；写入、命令和外部能力需要你确认后执行";
}

export function normalizePermissionMode(mode: string) {
  if (mode === "fullAccess" || mode === "full-access" || mode === "完全访问") {
    return "fullAccess";
  }
  if (mode === "workspace" || mode === "workspacePermissions" || mode === "bypassPermissions" || mode === "acceptEdits" || mode === "工作区权限") {
    return "workspace";
  }
  return "plan";
}

export function panelTitle(view: unknown) {
  if (view === "workflow") {
    return "任务";
  }
  if (view === "tasks") {
    return "子智能体";
  }
  return "状态";
}

export function sideColor(view: unknown) {
  if (view === "workflow") {
    return "green";
  }
  if (view === "tasks") {
    return "cyan";
  }
  return "green";
}

export function line(text: string, dim: boolean = false, color?: string, metadata?: Partial<TuiLine>): TuiLine {
  return metadata
    ? { text, dim, color, ...metadata }
    : { text, dim, color };
}

/**
 * @param {Awaited<import("../../core/session.ts").createSession>} session
 */
export function startupBannerLines(session: AgentSession) {
  const gateway = session.config.lab.gatewayUrl
    ? `${session.config.lab.gatewayProtocol ?? "openai-chat"} 就绪`
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
export function startupConfirmLines(cwd: string, trusted: boolean, workspaceDiagnostic: { warning?: string } | null = null) {
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
export function spinnerFrame(pulse: number) {
  return SPINNER_FRAMES[Math.abs(pulse) % SPINNER_FRAMES.length];
}

/**
 * @param {{ active?: boolean; text?: string; thinking?: string; thinkingVisible?: boolean; tools?: Array<Record<string, any>>; round?: number | null }} stream
 * @param {number} pulse
 */
export function streamingPanelLines(stream: TuiStream, pulse: number = 0, detailMode: string = "compact") {
  if (!stream?.active) {
    return [];
  }
  const frame = spinnerFrame(pulse);
  const phase = streamPhaseLabel(stream);
  const lines = [
    line(`${frame} ${phase} - 第 ${stream.round ?? "?"} 轮`, false, streamPhaseColor(stream))
  ];
  if (Number(stream.thinkingBytes ?? 0) > 0 || stream.thinking) {
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

export function streamingViewport(stream: TuiStream, rowBudget: number, width: number, scrollOffset: number = 0, pulse: number = 0, detailMode: string = "compact") {
  const budget = Math.max(1, rowBudget || 1);
  const rows = streamingRows(stream, width, pulse, detailMode);
  const totalRows = rows.length;
  const maxOffset = Math.max(0, totalRows - budget);
  const offset = Math.min(Math.max(0, scrollOffset || 0), maxOffset);
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

function streamingRows(stream: TuiStream, width: number, pulse: number, detailMode: string): TuiLine[] {
  if (!stream?.active) {
    return [];
  }
  const rows: TuiLine[] = [];
  for (const item of streamingStatusLines(stream, pulse, detailMode)) {
    rows.push(...wrapTranscriptLine(item, width));
  }
  return rows;
}

function streamingStatusLines(stream: TuiStream, pulse: number, detailMode: string): TuiLine[] {
  const frame = spinnerFrame(pulse);
  const lines = [
    line(`${frame} ${streamPhaseLabel(stream)} - 第 ${stream.round ?? "?"} 轮`, false, streamPhaseColor(stream))
  ];
  if (Number(stream.thinkingBytes ?? 0) > 0 || stream.thinking) {
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

export function streamPhaseLabel(stream: TuiStream = EMPTY_STREAM) {
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

function streamPhaseColor(stream: TuiStream = EMPTY_STREAM) {
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

export function thinkingSummaryLine(stream: TuiStream, detailMode: string = "compact") {
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

function thinkingDisplayLines(stream: TuiStream, detailMode: string = "compact", options: ThinkingDisplayOptions = EMPTY_THINKING_OPTIONS) {
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

export function trustDialogLines(cwd: string, status: string = "needed") {
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
 * @param {string} toolName
 * @param {Record<string, any>} value
 */
export function summarizeInput(toolName: string, value: unknown) {
  const input = asToolInput(value);
  if (toolName === "write_file") {
    return JSON.stringify({
      path: input.path,
      contentBytes: Buffer.byteLength(input.content ?? "", "utf8")
    });
  }
  if (toolName === "edit_file") {
    return JSON.stringify({
      path: input.path,
      oldTextBytes: Buffer.byteLength(input.oldText ?? "", "utf8"),
      newTextBytes: Buffer.byteLength(input.newText ?? "", "utf8"),
      expectedReplacements: input.expectedReplacements,
      dryRun: Boolean(input.dryRun),
      writesFile: !input.dryRun
    });
  }
  if (toolName === "powershell" || toolName === "bash") {
    return JSON.stringify({
      command: truncate(input.command ?? "", 300),
      timeoutMs: input.timeoutMs
    });
  }
  if (toolName === "mcp_call") {
    return JSON.stringify({
      server: input.server,
      tool: input.tool,
      argumentBytes: Buffer.byteLength(JSON.stringify(input.arguments ?? EMPTY_TOOL_INPUT), "utf8")
    });
  }
  return truncate(JSON.stringify(value), 500);
}

export function promptLines(
  mode: string,
  busy: boolean | undefined,
  inputBuffer: string | undefined,
  questionBuffer: string | undefined,
  options: PromptLineOptions = EMPTY_PROMPT_OPTIONS
) {
  const showCursor = options.showCursor !== false;
  const draftColumns = typeof options.draftColumns === "number" && Number.isFinite(options.draftColumns)
    ? options.draftColumns
    : null;
  const maxPromptLines = typeof options.maxPromptLines === "number" && Number.isFinite(options.maxPromptLines)
    ? Math.max(1, Math.floor(options.maxPromptLines))
    : null;
  if (mode === "approval") {
    return [
      { text: "权限弹窗已打开" },
      { text: "  用方向键/Tab 后按 Enter，或 Y 允许一次、A 本会话允许、N 拒绝、Esc 取消。", dim: true }
    ];
  }
  if (mode === "question") {
    return questionPromptLines(questionBuffer ?? "", options.questionCursor, {
      pendingQuestion: options.pendingQuestion,
      showCursor,
      draftColumns,
      maxPromptLines,
      visibleStart: options.questionVisibleStart
    });
  }
  if (busy) {
    const queued = Array.isArray(options.queuedPrompts) ? options.queuedPrompts : [];
    const draftLines = promptDraftLines("队列>", inputBuffer ?? "", options.inputCursor, showCursor, draftColumns, maxPromptLines, options.inputVisibleStart);
    return [
      ...(inputBuffer
        ? draftLines
        : [{ text: "队列> Ant Code 忙碌时可输入；Enter 入队，/guide <文本> 会中断并优先运行", dim: true }]),
      ...(queued.length > 0 ? [{ text: `  已排队：${queued.length} 条提示`, dim: true }] : [])
    ];
  }
  const buffer = inputBuffer ?? "";
  const shellMode = buffer.trimStart().startsWith("!");
  const prompt = shellMode ? "Shell>" : ">";
  const draftLines = promptDraftLines(prompt, buffer, options.inputCursor, showCursor, draftColumns, maxPromptLines, options.inputVisibleStart);
  const lines = [
    ...draftLines,
    ...(buffer.includes("\n") ? [{ text: `${buffer.split(/\r?\n/).length} 行草稿；Enter 提交，Shift/Alt+Enter 或 Ctrl+J 换行`, dim: true }] : [])
  ];
  return maxPromptLines ? lines.slice(0, maxPromptLines) : lines;
}

export function normalizeQuestionPrompt(pendingQuestion: QuestionPrompt | null | undefined = EMPTY_QUESTION_PROMPT): NormalizedQuestionPrompt {
  const source = pendingQuestion && typeof pendingQuestion === "object" ? pendingQuestion : EMPTY_QUESTION_PROMPT;
  const choices = Array.isArray(source.choices)
    ? source.choices.map(normalizeQuestionChoice).filter((choice): choice is QuestionChoice => choice !== null)
    : [];
  const selectedIndices = Array.isArray(source.selectedIndices)
    ? source.selectedIndices
      .map((index) => index)
      .filter((index) => Number.isInteger(index) && index >= 0 && index < choices.length)
    : [];
  const seededSelected = choices
    .map((choice, index) => choice.selected ? index : -1)
    .filter((index) => index >= 0);
  const normalizedSelected = selectedIndices.length > 0 ? selectedIndices : seededSelected;
  const focusedIndex = choices.length > 0
    ? Math.min(Math.max(0, Number(source.focusedIndex) || 0), choices.length - 1)
    : 0;
  const multiple = Boolean(source.multiple || source.selectionMode === "multi");
  const allowCustom = choices.length === 0 || source.allowCustom !== false;

  return {
    header: String(source.header ?? "模型提问"),
    question: String(source.question ?? source.prompt ?? "模型请求澄清"),
    choices,
    multiple,
    allowCustom,
    confirmLabel: String(source.confirmLabel ?? "确认"),
    focusedIndex,
    selectedIndices: multiple
      ? [...new Set(normalizedSelected)]
      : normalizedSelected.slice(0, 1)
  };
}

function questionPromptLines(questionBuffer: string, questionCursor: number | undefined, options: PromptLineOptions & { visibleStart?: number | null } = EMPTY_PROMPT_OPTIONS) {
  const prompt = normalizeQuestionPrompt(options.pendingQuestion ?? EMPTY_QUESTION_PROMPT);
  const showCursor = options.showCursor !== false;
  const maxPromptLines = typeof options.maxPromptLines === "number" && Number.isFinite(options.maxPromptLines)
    ? Math.max(1, Math.floor(options.maxPromptLines))
    : null;
  const draftPrompt = prompt.choices.length > 0 ? "自定义>" : "回答>";
  const draftLines = prompt.allowCustom
    ? promptDraftLines(draftPrompt, questionBuffer, questionCursor, showCursor, options.draftColumns ?? null, maxPromptLines, options.visibleStart)
    : [];
  if (prompt.choices.length === 0) {
    const lines = [
      line(`${prompt.header}：${truncate(prompt.question, 96)}`, false, "cyan"),
      ...draftLines,
      line("Enter 提交；Shift/Alt+Enter 或 Ctrl+J 换行；Esc 取消。", true)
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

function visibleQuestionChoices(prompt: NormalizedQuestionPrompt) {
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

function normalizeQuestionChoice(choice: unknown): QuestionChoice | null {
  if (typeof choice === "string") {
    const label = choice.trim();
    return label ? { label, value: label, description: "", selected: false } : null;
  }
  if (!choice || typeof choice !== "object") {
    return null;
  }
  const record = choice as ChoiceRecord;
  const label = textValue(record.label ?? record.text ?? record.title ?? record.value).trim();
  if (!label) {
    return null;
  }
  return {
    label,
    value: textValue(record.value) || label,
    description: textValue(record.description ?? record.detail).trim(),
    selected: Boolean(record.selected ?? record.default)
  };
}

export function exitConfirmLines(options: ExitConfirmOptions = EMPTY_EXIT_CONFIRM) {
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
export function permissionModalLines(
  pendingApproval: { toolName?: string; request?: PermissionRequest | Record<string, unknown> } | null,
  focusedIndex: number = 0
) {
  const request = asPermissionRequest(pendingApproval?.request ?? pendingApproval);
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
export function permissionPreviewLines(request: PermissionRequest = EMPTY_PERMISSION_REQUEST) {
  const toolName = request.toolName ?? "unknown";
  const input = request.input ?? EMPTY_TOOL_INPUT;
  if (toolName === "write_file") {
    return [
      `path: ${input.path ?? "unknown"}`,
      `内容：${Buffer.byteLength(input.content ?? "", "utf8")} 字节`
    ];
  }
  if (toolName === "edit_file") {
    return [
      `path: ${input.path ?? "unknown"}`,
      `旧文本：${Buffer.byteLength(input.oldText ?? "", "utf8")} 字节`,
      `新文本：${Buffer.byteLength(input.newText ?? "", "utf8")} 字节`,
      `模式：${input.dryRun ? "仅预览" : "将编辑文件"}`
    ];
  }
  if (toolName === "powershell" || toolName === "bash") {
    return [
      `命令：${truncate(input.command ?? "", 180)}`,
      `超时：${input.timeoutMs ?? "默认"}`
    ];
  }
  if (toolName === "mcp_call") {
    return [
      `服务器：${input.server ?? "unknown"}`,
      `工具：${input.tool ?? "unknown"}`,
      request.decision?.targetPath ? `路径：${request.decision.targetPath}` : null,
      `参数：${truncate(JSON.stringify(input.arguments ?? {}), 180)}`
    ].filter((item): item is string => item !== null);
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
export function transcriptBlockLines(entry: TuiEntry = EMPTY_ENTRY, detailMode: string = "compact", options: { tableWidth?: number | null } = {}) {
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
      ...foldBodyLines(splitFoldableLines(entry.body ?? ""), detailMode, { compact: 8, detailed: 24 }).map((item) => line(`  ${item.text}`, item.dim))
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
      ...splitFoldableLines(entry.body ?? "").map((item) => line(`  ${item}`, true))
    ];
  }
  if (entry.kind === "agent") {
    return agentTaskCardLines(entry, detailMode);
  }
  if (entry.kind === "session") {
    return [
      line(`会话 - ${entry.title ?? ""}`.trim(), false, "cyan"),
      ...splitFoldableLines(entry.body ?? "").map((item) => line(`  ${item}`, false))
    ];
  }
  if (entry.kind === "approval") {
    return [
      line(`权限 - ${entry.title ?? "decision"}`, false, "yellow"),
      ...foldBodyLines(splitFoldableLines(entry.body ?? ""), detailMode, { compact: 2, detailed: 8 }).map((item) => line(`  ${item.text}`, true))
    ];
  }
  if (entry.kind === "error") {
    return [
      line(`错误 - ${entry.title ?? "runtime"}`, false, "red"),
      ...foldBodyLines(splitFoldableLines(entry.body ?? ""), detailMode, { compact: 4, detailed: 12 }).map((item) => line(`  ${item.text}`, item.dim))
    ];
  }
  return [
    line(`${entry.kind ?? "event"} - ${entry.title ?? ""}`.trim(), false, colorForKind(entry.kind ?? "")),
    ...foldBodyLines(splitFoldableLines(entry.body ?? ""), detailMode, { compact: 1, detailed: 6 }).map((item) => line(`  ${item.text}`, true))
  ];
}

export function transcriptEntriesWithThinkingVisibility(entries: TuiEntry[] = [], thinkingVisible: boolean | undefined = false): TuiEntry[] {
  return entries.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return entry;
    }
    if (entry.kind !== "assistant") {
      return entry;
    }
    const thinking = entry.thinking ?? "";
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
function assistantBodyLines(body: string | undefined, detailMode: string = "compact", options: { tableWidth?: number | null } = {}): TuiLine[] {
  const bodyText = body ?? "";
  if (!bodyText) {
    return [];
  }
  const tableWidth = typeof options.tableWidth === "number" && Number.isFinite(options.tableWidth) && options.tableWidth > 0
    ? Math.floor(options.tableWidth)
    : null;
  const blocks = asMarkdownBlocks(parseMarkdownBlocks(bodyText));
  // If there's only one paragraph block, fall back to the original behavior
  if (blocks.length === 1 && blocks[0].type === "paragraph") {
    return splitFoldableLines(bodyText).map((item) => line(`  ${item}`, false));
  }
  const result: TuiLine[] = [];
  for (const block of blocks) {
    if (block.type === "table") {
      const tableLines = renderTable(block, tableWidth ?? FOLD_SOFT_WRAP_WIDTH);
      for (const tl of tableLines) {
        result.push({ ...tl, text: `  ${tl.text}` });
      }
    } else if (block.type === "code") {
      for (const codeLine of splitFoldableLines(block.text ?? "")) {
        result.push(line(`  ${codeLine}`, false, "code"));
      }
    } else {
      for (const paraLine of splitFoldableLines(block.text ?? "")) {
        result.push(line(`  ${paraLine}`, false));
      }
    }
  }
  return result;
}

function assistantThinkingLines(entry: TuiEntry = EMPTY_ENTRY, detailMode: string = "compact"): TuiLine[] {
  const bytes = entry.thinkingBytes ?? Buffer.byteLength(String(entry.thinking ?? ""), "utf8");
  if (bytes <= 0) {
    return [];
  }
  if (!entry.thinkingVisible) {
    return [line(`  thinking：已收到 ${bytes} 字节，默认隐藏；输入 /thinking 展开`, true, "yellow")];
  }
  const rows = splitFoldableLines(entry.thinking ?? "");
  const folded = foldBodyLines(rows, detailMode, { compact: 12, detailed: 80 });
  return [
    line(`  thinking：已展开 ${bytes} 字节，当前可见预览可查看${entry.thinkingTruncated ? "（已截断前部，保留最新片段）" : ""}`, false, "yellow"),
    ...folded.map((item) => line(`    ${item.text}`, true, "yellow"))
  ];
}

function compactUserPromptLines(body: string | undefined, detailMode: string): TuiLine[] | null {
  if (detailMode === "full") {
    return null;
  }
  const text = body ?? "";
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
export function toolCardLines(entry: { title?: string; body?: string } = {}, detailMode: string = "compact"): TuiLine[] {
  const title = entry.title ?? "tool";
  const state = inferToolState(title, entry.body);
  const name = title.replace(/\s+(running|done|blocked|failed)$/i, "");
  return [
    line(`${toolStatusMarker(state)} ${toolClassLabel(name)} - ${title}`, false, toolStateColor(state)),
    ...foldBodyLines(splitFoldableLines(entry.body ?? ""), detailMode, { compact: 2, detailed: 8 }).map((item) => line(`  ${item.text}`, true))
  ];
}

function agentTaskCardLines(entry: TuiEntry = EMPTY_ENTRY, detailMode: string = "compact"): TuiLine[] {
  const status = entry.taskStatus ?? inferAgentTaskStatus(entry.title, entry.body);
  return [
    line(`${agentTaskMarker(status)} 子智能体 - ${entry.title ?? "任务"}`, false, agentTaskColor(status)),
    ...foldBodyLines(splitFoldableLines(entry.body ?? ""), detailMode, { compact: 5, detailed: 14 }).map((item) => line(`  ${item.text}`, item.dim))
  ];
}

function splitFoldableLines(value: string): string[] {
  const rows: string[] = [];
  for (const item of splitLines(value)) {
    rows.push(...softWrapFoldLine(item, FOLD_SOFT_WRAP_WIDTH));
  }
  return rows;
}

function softWrapFoldLine(value: string, maxWidth: number): string[] {
  const text = value ?? "";
  if (displayWidth(text) <= maxWidth) {
    return [text];
  }
  const rows: string[] = [];
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

function foldBodyLines(lines: string[], detailMode: string, limits: FoldLimits): Array<{ text: string; dim: boolean }> {
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

function inferToolState(title: string, body: string | undefined): string {
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

function toolClassLabel(name: string) {
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

function toolStatusMarker(state: string): string {
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

function toolStateColor(state: string): string {
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

function inferAgentTaskStatus(title: string | undefined, body: string | undefined): string {
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

function agentTaskMarker(status: string) {
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

function agentTaskColor(status: string) {
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

function riskBadge(risk: string | undefined) {
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

function riskColor(risk: string | undefined) {
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

export function promptColor(mode: string, busy: boolean | undefined) {
  if (mode === "approval") {
    return "yellow";
  }
  if (mode === "question") {
    return "cyan";
  }
  return busy ? "magenta" : "green";
}

export function colorForKind(kind: string) {
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
  if (kind === "goal") {
    return "red";
  }
  return "white";
}

export function splitLines(value: string | null | undefined): string[] {
  return (value ?? "").split(/\r?\n/).filter((item) => item.length > 0);
}

export function visibleDraftLines(value: string | null | undefined): string[] {
  const lines = (value ?? "").split(/\r?\n/);
  const visible = lines.slice(-5);
  return visible.length === 1 && visible[0] === "" ? [] : visible;
}

function promptDraftLines(
  prompt: string,
  text: string,
  cursor: number | undefined,
  showCursor: boolean,
  draftColumns: number | null = null,
  maxLines: number | null = null,
  visibleStart: number | null | undefined = null
): TuiLine[] {
  const value = text ?? "";
  const cursorIndex = typeof cursor === "number" && Number.isFinite(cursor) ? cursor : Array.from(value).length;
  const visibleLines = typeof maxLines === "number" && Number.isFinite(maxLines) ? Math.max(1, Math.floor(maxLines)) : undefined;
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
  const contentColumns = typeof draftColumns === "number" && Number.isFinite(draftColumns) && draftColumns > 0
    ? Math.max(8, Math.floor(draftColumns) - Math.max(promptColumns, continuationColumns))
    : null;
  const lines = composerSegments(value, cursorIndex, {
    showCursor,
    columns: contentColumns,
    maxLines: visibleLines,
    visibleStart
  });
  if (lines.length === 0) {
    return [{
      text: `${prompt}  `,
      segments: [
        { text: `${prompt} `, prompt: true },
        { text: " ", cursor: true, hidden: !showCursor }
      ]
    }];
  }
  return lines.map((draftLine, index) => {
    const prefix = index === 0 ? `${prompt} ` : "  ";
    return {
      text: `${prefix}${draftLine.text || " "}`,
      segments: [
        { text: prefix, prompt: index === 0 },
        ...(draftLine.segments.length > 0 ? draftLine.segments : [{ text: " " }])
      ]
    };
  });
}

export function sliceEntriesForRows(entries: TuiEntry[], rowBudget: number, width: number): TuiEntry[] {
  const selected: TuiEntry[] = [];
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

export function transcriptViewport(
  entries: TuiEntry[],
  rowBudget: number | undefined,
  width: number | undefined,
  scrollOffset: number | undefined = 0,
  detailMode: string | undefined = "compact"
) {
  const budget = Math.max(1, rowBudget || 1);
  const resolvedWidth = width ?? 0;
  const rows = transcriptRows(entries, resolvedWidth, detailMode ?? "compact");
  const totalRows = rows.length;
  const maxOffset = Math.max(0, totalRows - budget);
  const offset = Math.min(Math.max(0, scrollOffset || 0), maxOffset);
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

function transcriptRows(entries: TuiEntry[], width: number, detailMode: string = "compact"): TuiLine[] {
  const rows: TuiLine[] = [];
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

function withTranscriptEntryMetadata(item: TuiLine, entry: { id?: string; kind?: string } = {}): TuiLine {
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

function isSelectableTranscriptEntry(entry: { kind?: string } = {}) {
  return ["user", "assistant", "tool", "tools", "trace", "error", "approval", "output", "command", "context", "agent", "session"].includes(entry.kind ?? "");
}

function displayEntriesForDetailMode(entries: TuiEntry[] = [], detailMode: string = "compact"): TuiEntry[] {
  if (detailMode === "full") {
    return entries;
  }
  if (detailMode === "detailed") {
    return collapseRoutineTelemetry(entries);
  }
  return entries.filter((entry) => !isRoutineTelemetryEntry(entry));
}

function collapseRoutineTelemetry(entries: TuiEntry[] = []): TuiEntry[] {
  const collapsed: TuiEntry[] = [];
  let pending: TuiEntry[] = [];

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

function makeTelemetrySummaryEntry(entries: TuiEntry[]): TuiEntry {
  const counts = summarizeTelemetry(entries);
  const parts = [
    counts.gateway ? `网关 ${counts.gateway}` : null,
    counts.tool ? `工具 ${counts.tool}` : null,
    counts.agent ? `子任务 ${counts.agent}` : null,
    counts.turn ? `轮次 ${counts.turn}` : null,
    counts.workflow ? `状态 ${counts.workflow}` : null
  ].filter((part): part is string => part !== null);
  return {
    kind: "trace",
    title: `已收起 ${entries.length} 条运行过程`,
    body: `${parts.join("，") || "运行过程"}。Ctrl+O 再按一次查看完整过程日志。`
  };
}

function summarizeTelemetry(entries: TuiEntry[]): TelemetryCounts {
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

function trimTrailingLowPriorityEntries(entries: TuiEntry[] = []): TuiEntry[] {
  let end = entries.length;
  while (end > 0 && isLowPriorityTrailingEntry(entries[end - 1])) {
    end -= 1;
  }
  return end === entries.length ? entries : entries.slice(0, end);
}

function startupTranscriptLines(entry: TuiEntry): TuiLine[] {
  return (entry.body ?? "")
    .split(/\r?\n/)
    .filter((item) => item.length > 0)
    .map((item, index) => line(
      `  ${item}`,
      index > 6,
      index < 5 ? "cyan" : index === 6 ? "green" : undefined
    ));
}

function wrapTranscriptLine(item: TuiLine, width: number): TuiLine[] {
  if (item?.noWrap) {
    return [item];
  }
  const usableWidth = Math.max(24, width - 6);
  const text = item?.text ?? "";
  if (text.length === 0) {
    return [{ ...item, text: "" }];
  }
  const rows: TuiLine[] = [];
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

function tableRenderWidth(width: number) {
  return Math.max(16, Math.max(24, width || 0) - 8);
}

function isLowPriorityTrailingEntry(entry: TuiEntry | undefined) {
  return entry?.kind === "turn" && entry?.title === "completed";
}

function isRoutineTelemetryEntry(entry: TuiEntry) {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  const title = entry.title ?? "";
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

function estimateEntryRows(entry: TuiEntry, width: number) {
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
export function truncate(value: string, max: number) {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}

export function truncateMiddle(value: string | number | null | undefined, max: number) {
  const text = value == null ? "" : `${value}`;
  if (text.length <= max) {
    return text;
  }
  const half = Math.max(4, Math.floor((max - 3) / 2));
  return `${text.slice(0, half)}...${text.slice(text.length - half)}`;
}

export function permissionModeLabel(session: AgentSession) {
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

function stripWhitespace(value: string | null | undefined) {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function textValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value == null) {
    return "";
  }
  return `${value}`;
}

function asToolInput(value: unknown): ToolInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return EMPTY_TOOL_INPUT;
  }
  return value as ToolInput;
}

function asPermissionRequest(value: unknown): PermissionRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return EMPTY_PERMISSION_REQUEST;
  }
  return value as PermissionRequest;
}

function asMarkdownBlocks(blocks: ReturnType<typeof parseMarkdownBlocks>): MarkdownBlock[] {
  return blocks as MarkdownBlock[];
}
