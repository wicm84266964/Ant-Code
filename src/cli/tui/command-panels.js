import { listSlashCommandGroups } from "../../commands/registry.js";
import { summarizeContextWindow } from "../../core/context-window.js";
import { listConfiguredModels } from "../../model-gateway/models.js";
import { INSPECTOR_FILTERS, inspectorFilterLabel, inspectorPanelLines } from "./inspector.js";
import { displayWidth } from "./input-editor.js";
import { line, permissionModeDescription, permissionModeLabel, truncate, truncateMiddle } from "./format.js";
import { parseMarkdownBlocks, renderTable } from "./markdown-table.js";

const MESSAGE_EXCERPT_WRAP_WIDTH = 72;
const MESSAGE_EXCERPT_LINE_WIDTH = 100;
const MESSAGE_EXCERPT_TABLE_WIDTH = MESSAGE_EXCERPT_LINE_WIDTH - 2;

/**
 * @param {{ tabIndex?: number }} options
 */
export function createHelpPanel(options = {}) {
  const groups = listSlashCommandGroups();
  const tabIndex = clampIndex(options.tabIndex ?? 0, groups.length);
  const group = groups[tabIndex] ?? groups[0];
  return panel({
    kind: "help",
    title: "帮助",
    subtitle: "斜杠命令都在本地执行；禁用项会说明替代方式。",
    tabs: groups.map((item) => item.category),
    tabIndex,
    lines: [
      line(group.category, false, "cyan"),
      ...group.commands.flatMap((command) => [
        line(`/${command.name} ${command.title ? `(${command.title})` : ""} - ${command.description}${command.keybind ? ` [${command.keybind}]` : ""}${command.disabledReason ? " [已禁用]" : ""}`, Boolean(command.disabledReason), command.disabledReason ? "yellow" : undefined),
        ...(command.aliases?.length ? [line(`  别名：${command.aliases.join(", ")}`, true)] : []),
        ...(command.disabledReason ? [line(`  原因：${command.disabledReason}`, true)] : [])
      ]),
      line(""),
      line("使用 Left/Right 或 Tab 切换帮助标签。Esc 关闭此面板。", true)
    ],
    footer: "Left/Right 标签 | Up/Down 滚动 | Esc 关闭"
  });
}

/**
 * @param {{ session: Record<string, any>; activity?: Record<string, any>; trusted?: boolean; cwd?: string }} options
 */
export function createStatusPanel(options) {
  const session = options.session;
  const activity = options.activity ?? {};
  const context = summarizeContextWindow(session);
  return panel({
    kind: "status",
    title: "状态",
    subtitle: "本地会话、网关、工作流和上下文状态。",
    lines: [
      line("会话", false, "cyan"),
      line(`id: ${truncate(session.id ?? "unknown", 26)}`),
      line(`cwd: ${truncateMiddle(options.cwd ?? session.cwd ?? "unknown", 86)}`),
      line(`信任：${options.trusted ? "已信任" : "尚未信任"}`),
      line(`轮次：${session.turnCount ?? 0}`),
      line(`模型：${session.model}`),
      line(`网络：${session.networkMode}`),
      line(`敏感级别：${session.sensitivity}`),
      line(`权限：${permissionModeLabel(session)}`),
      line(`只读锁定：${session.permissionReadonlyLocked || session.readonly ? "是" : "否"}`),
      line(""),
      line("网关", false, "magenta"),
      line(`状态：${activity.gateway ?? (session.config?.lab?.gatewayUrl ? "已配置" : "缺失")}`),
      line(`协议：${session.config?.lab?.gatewayProtocol ?? "lab-agent-gateway"}`),
      line(`最近：${activity.lastGateway ?? "无"}`),
      line(""),
      line("活动", false, "green"),
      line(`状态：${activity.status ?? "idle"}`),
      line(`最近轮次：${activity.lastTurn ?? "无"}`),
      line(`最近工具：${activity.lastTool ?? "无"}`),
      line(`工具：${activity.toolCount ?? 0}; 阻止：${activity.blockedTools ?? 0}; 失败：${activity.failedTools ?? 0}`),
      line(""),
      line("上下文", false, "yellow"),
      line(formatContextBrief(context))
    ],
    footer: "使用 /context 查看上下文详情，/gateway 查看网关诊断。"
  });
}

/**
 * @param {{ session: Record<string, any>; trusted?: boolean }} options
 */
export function createPermissionsPanel(options) {
  const session = options.session;
  const mode = session.permissionMode ?? (session.fullAccess ? "fullAccess" : (session.allowWrite || session.allowCommand) ? "workspace" : "plan");
  return panel({
    kind: "permissions",
    title: "权限",
    subtitle: "当前本地工具策略；不会调用远程工具服务器。",
    lines: [
      line("当前模式", false, "cyan"),
      line(`${permissionModeLabel(session)} - ${permissionModeDescription(mode)}`),
      line(`只读锁定：${session.permissionReadonlyLocked || session.readonly ? "是" : "否"}`),
      line(`工作区信任：${options.trusted ? "已授权" : "运行工具前需要确认"}`),
      line(`网络模式：${session.networkMode}`),
      line(`高敏模式：${session.sensitivity === "high" ? "是" : "否"}`),
      line(""),
      line("操作矩阵", false, "yellow"),
      ...permissionMatrixRows(session).map((row) => line(row.text, row.dim, row.color)),
      line(""),
      line("信任命令", false, "cyan"),
      line("/permissions trust list"),
      line("/permissions trust reset"),
      line("三档模式：计划确认、工作区权限、完全访问。完全访问只建议在专用测试机使用。", true)
    ],
    footer: "Shift+Tab 切换权限模式 | Esc 关闭"
  });
}

/**
 * @param {{ session: Record<string, any>; compactResult?: Record<string, any> | null; before?: Record<string, any> | null; after?: Record<string, any> | null }} options
 */
export function createContextPanel(options) {
  const summary = summarizeContextWindow(options.session);
  const resultLines = options.compactResult
    ? compactResultLines(options.compactResult, options.before, options.after)
    : [];
  return panel({
    kind: "context",
    title: options.compactResult ? "上下文压缩" : "上下文",
    subtitle: "会话本地上下文窗口；恢复会话使用 /sessions，历史分片回看使用 /resume。",
    lines: [
      ...resultLines,
      ...(resultLines.length > 0 ? [line("")] : []),
      line("窗口", false, "cyan"),
      line(`当前模型上下文：${formatTokenCount(summary.messageTokens)}/${formatTokenCount(primaryTokenLimit(summary))} tokens（估算）`),
      ...(Number.isFinite(summary.promptTokens)
        ? [line(`最近模型输入：${formatTokenCount(summary.promptTokens)}/${formatTokenCount(primaryTokenLimit(summary))} tokens（估算）`, true)]
        : []),
      ...(Number.isFinite(summary.providerPromptTokens)
        ? [line(`Provider 实报：${formatProviderUsageBrief(summary)}（最近第 ${summary.providerRound ?? "?"} 轮）`, false, "green")]
        : []),
      line(`模型消息链：${formatTokenCount(summary.messageTokens)} tokens（估算）`),
      ...(summary.promptTokens
        ? [
            line(`拆分：消息 ${formatTokenCount(summary.promptMessageTokens)} / 工具定义 ${formatTokenCount(summary.promptToolSchemaTokens)} / 工具结果 ${formatTokenCount(summary.promptToolResultTokens)}`, true)
          ]
        : []),
      line(`模型窗口：${summary.modelMaxTokens ? `${formatTokenCount(summary.modelMaxTokens)} tokens` : "未配置"}`),
      line(`本地压缩阈值：${formatTokenCount(summary.maxTokens)} tokens`),
      line(`字节：${summary.messageBytes}/${summary.maxBytes}`),
      line(`消息：${summary.messages}/${summary.maxMessages}`),
      line(`保留最近：${summary.keepRecentMessages}`),
      line(""),
      line("压缩", false, "yellow"),
      line(`压缩次数：${summary.compacted}`),
      line(`已压缩消息：${summary.compactedMessages}`),
      line(`是否有摘要：${summary.hasSummary ? "是" : "否"}`),
      line(`摘要 tokens：${formatTokenCount(summary.summaryTokens)}（估算）`),
      line(`摘要字节：${summary.summaryBytes}`),
      line(`最近原因：${summary.lastReason ?? "从未"}`),
      line(`最近方式：${formatCompactionStrategy(summary.lastStrategy)}`),
      ...(summary.lastInternalAgent ? [line(`内部 agent：${summary.lastInternalAgent}`, true, "cyan")] : []),
      ...(summary.lastFallbackReason ? [line(`降级原因：${summary.lastFallbackReason}`, true, "yellow")] : []),
      line(`最近压缩：${summary.lastCompactedAt ?? "从未"}`),
      line(""),
      line("/compact 优先调用当前模型生成压缩摘要，失败时降级为本地摘要。", true),
      line("疑似路径、token 和凭据会在压缩摘要中脱敏。", true)
    ],
    footer: "/compact 立即压缩 | /clear 重置上下文 | Esc 关闭"
  });
}

/**
 * @param {{ result: Record<string, any>; before?: Record<string, any> | null; after?: Record<string, any> | null; session?: Record<string, any> }} options
 */
export function createCompactPanel(options) {
  return panel({
    kind: "compact",
    title: "上下文压缩",
    subtitle: "手动上下文压缩结果。",
    lines: [
      ...compactResultLines(options.result, options.before, options.after),
      line(""),
      line("含义", false, "cyan"),
      line("较旧消息会被模型摘要化，并从活跃消息列表移除。"),
      line("如果模型网关不可用，会自动降级为本地确定性摘要。"),
      line("最近消息会保持精确，方便下一轮模型继续当前任务。"),
      line("摘要是有界且脱敏的；需要精确信息时请重新读取文件。", true)
    ],
    footer: "Esc 关闭 | /context 查看当前窗口"
  });
}

/**
 * @param {{ session: Record<string, any>; name: "usage" | "cost" }} options
 */
export function createUsagePanel(options) {
  const session = options.session;
  const workflow = session.workflow ?? {};
  const usage = session.usage ?? {};
  const hasProviderUsage = Number.isFinite(usage.reports) && usage.reports > 0;
  const changes = Array.isArray(workflow.changes) ? workflow.changes : [];
  const validations = Array.isArray(workflow.validations) ? workflow.validations : [];
  const passed = validations.filter((validation) => validation.passed).length;
  const failed = validations.filter((validation) => validation.passed === false).length;
  return panel({
    kind: options.name,
    title: options.name === "cost" ? "费用" : "用量",
    subtitle: "本地计数，以及网关提供的 token/费用数据。",
    lines: [
      line("提供方用量", false, "cyan"),
      ...(hasProviderUsage
        ? providerUsagePanelLines(usage)
        : [line("配置的网关尚未报告提供方 token 或费用总量。", true)]),
      line(""),
      line("本地会话", false, "green"),
      line(`轮次：${session.turnCount ?? 0}`),
      line(`模型：${session.model}`),
      line(`网络：${session.networkMode}`),
      line(`上下文：${formatContextBrief(summarizeContextWindow(session))}`),
      line(""),
      line("本地工作计数", false, "yellow"),
      line(`记录的改动：${changes.length}`),
      line(`验证命令：${validations.length}`),
      line(`验证通过：${passed}`),
      line(`验证失败：${failed}`),
      line(""),
      line("Ant Code 不会从私有提供方内部信息推断价格。", true)
    ],
    footer: "网关提供 token 统计时会显示在这里。"
  });
}

/**
 * @param {{ session: Record<string, any>; models?: Array<Record<string, any>> }} options
 */
export function createModelPanel(options) {
  const session = options.session;
  const models = options.models ?? listConfiguredModels(session.config ?? {});
  return panel({
    kind: "model",
    title: "模型",
    subtitle: "本地网关别名；Ant Code 不查询提供方账号的模型列表接口。",
    lines: [
      line("当前", false, "cyan"),
      line(`模型：${session.model}`),
      line(`网关：${session.config?.lab?.gatewayUrl ? "已配置" : "缺失"}`),
      line(`协议：${session.config?.lab?.gatewayProtocol ?? "lab-agent-gateway"}`),
      line(""),
      line("别名", false, "green"),
      ...models.map((model) => {
        const active = model.id === session.model;
        return line(`${active ? "*" : " "} ${model.id}${model.thinking ? " thinking" : ""} - ${model.description}`, !active, active ? "cyan" : undefined);
      }),
      line(""),
      line("提供方暴露的 thinking 默认隐藏；/thinking 可展开当前会话可见预览。", true)
    ],
    footer: "/model 打开选择器 | /model use <id> 切换当前会话"
  });
}

/**
 * @param {{ title: string; command: string; output: string; kind?: string }} options
 */
export function createTextOutputPanel(options) {
  return panel({
    kind: options.kind ?? "command-output",
    title: options.title,
    subtitle: options.command,
    lines: String(options.output ?? "").split(/\r?\n/).map((text, index) => line(text || " ", index > 12)),
    footer: "Up/Down 滚动 | Esc 关闭"
  });
}

/**
 * @param {{ inspector?: Record<string, any> | null; items?: Array<Record<string, any>>; index?: number; offset?: number; filter?: string; visibleRows?: number; patchFileIndex?: number }} options
 */
export function createLogsPanel(options = {}) {
  const filter = options.filter ?? "all";
  const tabs = INSPECTOR_FILTERS.map((item) => inspectorFilterLabel(item));
  const tabIndex = Math.max(0, INSPECTOR_FILTERS.indexOf(filter));
  return panel({
    kind: "logs",
    title: "运行日志",
    subtitle: "当前 TUI 进程内最近命令、工具、审批、网关和上下文事件。",
    tabs,
    tabIndex,
    lines: [
      line("说明", false, "cyan"),
      line("这里用于按需查看最近命令、工具、审批、网关和上下文事件。"),
      line("日志只保存在当前 TUI 内存中，不会作为 session transcript 持久化。", true),
      line(""),
      ...inspectorPanelLines(
        options.inspector,
        options.items ?? [],
        options.index ?? 0,
        options.offset ?? 0,
        filter,
        options.visibleRows ?? 18,
        options.patchFileIndex ?? 0
      )
    ],
    footer: "Tab/Left/Right 切换类型 | Up/Down 或滚轮滚动 | Esc 关闭"
  });
}

/**
 * @param {{ queuedPrompts?: string[]; selectedIndex?: number; busy?: boolean }} options
 */
export function createQueuePanel(options = {}) {
  const prompts = options.queuedPrompts ?? [];
  const selectedIndex = clampIndex(options.selectedIndex ?? 0, Math.max(1, prompts.length));
  return panel({
    kind: "queue",
    title: "队列",
    subtitle: prompts.length > 0 ? `${prompts.length} 条排队提示` : "没有排队提示",
    lines: prompts.length === 0
      ? [
        line("没有排队提示。", true),
        line("模型忙碌时提交内容会进入队列。"),
        line("排队提示会在当前 TUI 会话中按顺序本地运行。", true)
      ]
      : [
        line("排队提示", false, "cyan"),
        ...prompts.map((prompt, index) => {
          const focused = index === selectedIndex;
          return line(`${focused ? ">" : " "} ${index + 1}. ${truncate(prompt, 120)}`, !focused, focused ? "yellow" : undefined);
        }),
        line(""),
        line(options.busy ? "Enter 将当前提示提升为下一条运行。" : "Enter 立即运行当前提示。", true),
        line("D/Delete 删除一条；P 提升；C 清空全部。", true)
      ],
    footer: "Up/Down 选择 | Enter 运行/提升 | D 删除 | P 提升 | C 清空 | Esc 关闭"
  });
}

/**
 * @param {{ entry?: Record<string, any> | null; actionIndex?: number }} options
 */
export function createMessageActionsPanel(options = {}) {
  const entry = options.entry ?? null;
  const actions = messageActionsForEntry(entry);
  const selectedIndex = clampIndex(options.actionIndex ?? 0, Math.max(1, actions.length));
  const title = entry?.kind === "user" ? "用户消息" : entry?.kind === "assistant" ? "助手消息" : "消息";
  return panel({
    kind: "message-actions",
    title: "消息操作",
    subtitle: entry ? `${title} - ${truncate(messageActionPreview(entry), 72)}` : "未选中消息",
    lines: entry
      ? [
        line("已选中消息块", false, "cyan"),
        line(`${messageRoleLabel(entry.kind)} · ${entry.at ?? ""}`.trim(), true),
        line(truncate(messageActionPreview(entry), 120)),
        line(""),
        ...actions.map((action, index) => {
          const focused = index === selectedIndex;
          return line(`${focused ? ">" : " "} ${action.label}`, !focused, focused ? "yellow" : undefined);
        }),
        line(""),
        line("提示：回退只修改对话上下文和输入栏，不会撤销已经写入的文件。", true)
      ]
      : [
        line("点击聊天区内的消息块可选中。", true)
      ],
    footer: "Up/Down 选择 | Enter 执行 | Esc 关闭"
  });
}

/**
 * @param {{ entry?: Record<string, any> | null }} options
 */
export function createMessageExcerptPanel(options = {}) {
  const entry = options.entry ?? null;
  const isAgentTask = entry?.kind === "agent";
  const title = isAgentTask
    ? "子智能体"
    : entry?.kind === "user"
      ? "用户消息"
      : entry?.kind === "assistant"
        ? "助手消息"
        : entry?.kind
          ? `${entry.kind} 消息`
          : "消息";
  const contentLines = entry
    ? messageExcerptContentLines(entry)
    : [line("未选中消息。", true)];
  return panel({
    kind: "message-excerpt",
    title: isAgentTask ? "子智能体摘录" : "消息摘录",
    subtitle: entry
      ? isAgentTask && entry.task
        ? `${truncate(String(entry.task.title ?? entry.title ?? "子任务"), 48)} · ${truncate(String(entry.task.profile ?? entry.profile ?? "unknown"), 24)} · ${truncate(String(entry.task.status ?? entry.taskStatus ?? "unknown"), 24)}`
        : `${title} - ${truncate(messageActionPreview(entry), 72)}`
      : "未选中消息",
    borderless: true,
    lines: [
      excerptUiLine("消息摘录：鼠标可直接拖选下方文字复制片段；Esc 返回。", "yellow"),
      excerptUiLine("键盘：C 复制整条 | F 复制到最新 | R 回退编辑 | G 重新生成 | PgUp/PgDn 滚动"),
      line(""),
      ...contentLines,
      line(""),
      excerptUiLine("提示：此区域无边框，复制时不会混入右侧框线。")
    ],
    footer: "C 复制整条 | F 复制到最新 | R 回退编辑 | G 重新生成 | PgUp/PgDn 滚动 | Esc 返回"
  });
}

/**
 * @param {{ task?: Record<string, any> | null; entry?: Record<string, any> | null }} options
 */
export function createAgentTaskLivePanel(options = {}) {
  const task = options.task ?? {};
  const entry = options.entry ?? {};
  const taskId = String(task.id ?? entry.taskId ?? "").trim();
  const status = String(task.status ?? entry.taskStatus ?? "unknown");
  const profile = String(task.profile ?? entry.profile ?? "unknown");
  const title = task.title || entry.title || "子智能体任务";
  return panel({
    kind: "agent-live",
    title: "子智能体详情",
    subtitle: `${truncate(String(title), 48)} · ${truncate(profile, 24)} · ${agentTaskStatusLabel(status)}`,
    taskId,
    entryId: entry.id ?? null,
    task,
    entry,
    lines: [
      line("运行态详情：这里会随任务记录刷新，用来确认后台子智能体还在做什么。", false, "cyan"),
      line("Enter/C 冻结到摘录层；摘录层停止刷新，适合鼠标拖选复制。", false, "yellow"),
      line(""),
      ...agentTaskIdentityLines(task, entry),
      line(""),
      ...agentTaskProgressLines(task),
      line(""),
      ...agentTaskBudgetLines(task),
      line(""),
      ...agentTaskToolLines(task),
      line(""),
      ...agentTaskOutputPreviewLines(task),
      line(""),
      ...agentTaskContinuationLines(task)
    ],
    footer: "Enter/C 冻结摘录 | Up/Down 或滚轮滚动 | Esc 返回"
  });
}

/**
 * @param {{ records?: Array<Record<string, any>>; selectedIndex?: number; currentSessionId?: string }} options
 */
export function createSessionsPanel(options = {}) {
  const records = options.records ?? [];
  const selectedIndex = clampIndex(options.selectedIndex ?? 0, Math.max(1, records.length));
  return panel({
    kind: "sessions",
    title: "会话",
    subtitle: records.length > 0 ? `${records.length} 条本地会话记录` : "没有已保存记录",
    lines: records.length === 0
      ? [
        line("没有本地会话记录。", true),
        line("模型轮次完成或中断后会写入会话记录。"),
        line("使用 /new 可启动全新的本地会话。", true)
      ]
      : [
        line("本地会话", false, "cyan"),
        ...records.map((record, index) => {
          const focused = index === selectedIndex;
          const current = record.id === options.currentSessionId;
          const marker = focused ? ">" : current ? "*" : " ";
          const status = record.readable === false ? record.readError ?? "unreadable" : record.status ?? "metadata";
          const title = record.title ? truncate(record.title, 48) : "未命名会话";
          const fallbackPrompt = !record.title && record.prompt ? ` - ${truncate(record.prompt, 34)}` : "";
          const model = record.model ? ` ${truncate(record.model, 24)}` : "";
          const turn = Number.isFinite(record.turnIndex) ? ` turn=${record.turnIndex}` : "";
          const messages = Number.isFinite(record.transcriptMessages) && record.transcriptMessages > 0 ? ` msgs=${record.transcriptMessages}` : "";
          return line(`${marker} ${title} (${truncate(record.id, 8)}) ${formatSessionTime(record.finishedAt ?? record.modifiedAt)} ${status}${turn}${messages}${model}${fallbackPrompt}`, !focused && !current, focused ? "yellow" : current ? "cyan" : undefined);
        }),
        line(""),
        line("Enter 恢复选中的会话和已保留 transcript。", true),
        line("N 新建会话。C 按保留策略清理过期记录。", true)
      ],
    footer: "Up/Down 选择 | Enter 恢复 | N 新建 | C 清理 | Esc 关闭"
  });
}

/**
 * @param {{ session?: Record<string, any>; selectedIndex?: number }} options
 */
export function createResumePanel(options = {}) {
  const session = options.session ?? {};
  const archive = normalizeResumeArchive(session.transcriptArchive);
  const chunks = archive.chunks;
  const selectedIndex = clampIndex(options.selectedIndex ?? Math.max(0, chunks.length - 1), Math.max(1, chunks.length));
  const visibleWindow = Array.isArray(session.transcriptMessages) ? session.transcriptMessages.length : 0;
  return panel({
    kind: "resume",
    title: "Resume",
    subtitle: chunks.length > 0
      ? `当前会话历史分片：${chunks.length} 个；每片最多 ${archive.chunkSize} 条消息`
      : "当前会话还没有落盘历史分片",
    selectedIndex,
    sessionId: session.id ?? null,
    lines: chunks.length === 0
      ? [
        line("当前会话暂无可查看的历史分片。", true),
        line(`聊天区仍保留最近 ${visibleWindow} 条可见消息；继续对话后会按 50 条写入分片。`),
        line("切换或恢复其他会话请使用 /sessions。", true)
      ]
      : [
        line("当前会话", false, "cyan"),
        line(`id: ${truncate(String(session.id ?? "unknown"), 32)}`),
        line(`总历史消息：${archive.totalMessages}；当前可见窗口：${visibleWindow}`),
        line(""),
        line("历史分片", false, "yellow"),
        ...chunks.map((chunk, index) => {
          const focused = index === selectedIndex;
          const range = resumeChunkRange(chunk, archive.chunkSize);
          const bytes = Number.isFinite(chunk.bytes) && chunk.bytes > 0 ? ` bytes=${chunk.bytes}` : "";
          const encrypted = chunk.encrypted ? " encrypted" : "";
          return line(`${focused ? ">" : " "} chunk ${chunk.index}  ${range}  msgs=${chunk.messages}${bytes}${encrypted}`, !focused, focused ? "yellow" : undefined);
        }),
        line(""),
        line("Enter 查看选中分片；也可以直接输入 /resume <分片序号>。", true),
        line("/resume 只查看当前会话历史，不会恢复会话，也不会把旧分片塞回模型上下文。", true),
        line("恢复/切换完整会话请使用 /sessions。", true)
      ],
    footer: "Up/Down 选择 | Enter 查看分片 | /sessions 恢复会话 | Esc 关闭"
  });
}

/**
 * @param {{ session?: Record<string, any>; chunk?: Record<string, any>; messages?: Array<Record<string, any>> }} options
 */
export function createResumeChunkPanel(options = {}) {
  const session = options.session ?? {};
  const chunk = options.chunk ?? {};
  const messages = Array.isArray(options.messages) ? options.messages : [];
  return panel({
    kind: "resume-chunk",
    title: `Resume chunk ${chunk.index ?? "?"}`,
    subtitle: `${truncate(String(session.id ?? chunk.sessionId ?? "current"), 32)} · ${messages.length} 条历史消息`,
    lines: [
      line("当前会话历史分片：只读回看，不进入聊天区或模型上下文。", false, "cyan"),
      line("需要恢复/切换会话请用 /sessions；需要回看其他分片请用 /resume <序号>。", true),
      line(""),
      ...resumeChunkMessageLines(messages)
    ],
    footer: "Up/Down 或滚轮滚动 | /resume 返回分片列表 | Esc 关闭"
  });
}

export function createResumeHelpPanel() {
  return panel({
    kind: "resume-help",
    title: "Resume",
    subtitle: "/resume 只查看当前会话历史分片；恢复会话请使用 /sessions。",
    lines: [
      line("会话恢复", false, "cyan"),
      line("/sessions"),
      line("  打开历史会话选择器，查看标题、最近提示、时间和消息数，然后回车恢复。"),
      line(""),
      line("当前会话回看", false, "yellow"),
      line("/resume"),
      line("  显示当前会话的 50 条历史分片列表。"),
      line("/resume <分片序号>"),
      line("  打开当前会话指定分片，只用于阅读和复制。", true),
      line(""),
      line("/resume 不恢复会话，不改变聊天区，也不扩大模型上下文。", true)
    ],
    footer: "/resume 分片列表 | /sessions 选择会话 | Esc 关闭"
  });
}

/**
 * @param {{ session?: Record<string, any> }} options
 */
export function createClearConfirmPanel(options = {}) {
  const summary = options.session ? summarizeContextWindow(options.session) : null;
  return panel({
    kind: "clear-confirm",
    title: "清除上下文",
    subtitle: "确认重置本地上下文",
    lines: [
      line("这会清除当前 TUI 会话的活跃对话上下文。", false, "yellow"),
      line("不会删除源码文件、工作区记忆或已有会话记录。"),
      ...(summary ? [
        line(""),
        line("当前上下文", false, "cyan"),
        line(formatContextBrief(summary))
      ] : []),
      line(""),
      line("按 Enter 清除，或按 Esc 保持不变。", true)
    ],
    footer: "Enter 清除 | Esc 取消"
  });
}

/**
 * @param {{ session?: Record<string, any>; gitAvailable?: boolean; gitStatus?: string }} options
 */
export function createUndoRedoPanel(options = {}) {
  const status = options.gitAvailable ? "git detected" : "git unavailable or not initialized";
  return panel({
    kind: "undo-redo",
    title: "撤销 / 回退",
    subtitle: "Stage 7 可行性说明",
    lines: [
      line("当前决策", false, "cyan"),
      line("Ant Code 不会静默运行破坏性的 git reset/checkout 操作。"),
      line(`工作区版本控制：${status}`, false, options.gitAvailable ? "green" : "yellow"),
      ...(options.gitStatus ? [line(`git status: ${truncate(options.gitStatus, 120)}`)] : []),
      line(""),
      line("安全 MVP 计划", false, "yellow"),
      line("1. 任何撤销动作前先展示改动文件和验证状态。"),
      line("2. 只在审批后提供 patch 预览和逐文件回退。"),
      line("3. 对话回退作为本地 metadata 分叉，和源码分支分离。"),
      line("4. 无 git 工作区要明确提示，不假装可以撤销。"),
      line(""),
      line("当前请先用 /review 和 /diff 安全检查，再手动操作版本控制。", true)
    ],
    footer: "Esc 关闭 | /review 和 /diff 检查当前改动"
  });
}

/**
 * @param {Record<string, any>} result
 * @param {Record<string, any> | null | undefined} before
 * @param {Record<string, any> | null | undefined} after
 */
function compactResultLines(result, before, after) {
  const color = result.compacted ? "green" : "yellow";
  return [
    line(result.compacted ? "已压缩" : "未压缩", false, color),
    line(`原因：${result.reason ?? "unknown"}`),
    line(`tokens：${formatTokenCount(result.beforeTokens ?? before?.messageTokens)} -> ${formatTokenCount(result.afterTokens ?? after?.messageTokens)}（估算）`),
    line(`消息：${result.beforeMessages ?? before?.messages ?? "?"} -> ${result.afterMessages ?? after?.messages ?? "?"}`),
    line(`字节：${result.beforeBytes ?? before?.messageBytes ?? "?"} -> ${result.afterBytes ?? after?.messageBytes ?? "?"}`),
    line(`方式：${formatCompactionStrategy(result.strategy)}`),
    ...(result.internalAgent ? [line(`内部 agent：${result.internalAgent}`, true, "cyan")] : []),
    ...(result.fallbackReason ? [line(`降级原因：${result.fallbackReason}`, true, "yellow")] : []),
    line(`摘要字节：${result.summaryBytes ?? after?.summaryBytes ?? "?"}`),
    ...(after ? [
      line(`总压缩次数：${after.compacted}`),
      line(`累计压缩消息：${after.compactedMessages}`)
    ] : [])
  ];
}

function formatCompactionStrategy(strategy) {
  if (strategy === "agent:compaction") {
    return "内部压缩 agent";
  }
  if (strategy === "model") {
    return "模型摘要";
  }
  if (strategy === "local") {
    return "本地摘要";
  }
  return "从未";
}

function messageActionsForEntry(entry) {
  const base = [
    { id: "copy", label: "复制当前消息块" },
    { id: "copy-forward", label: "复制从这里到最新" }
  ];
  if (entry?.kind === "user" && Number.isInteger(entry.checkpointMessagesLength)) {
    base.push({ id: "rewind-edit", label: "回退到这里并放回输入栏" });
    base.push({ id: "regenerate", label: "从这里重新生成" });
  } else if (entry?.kind === "user") {
    base.push({ id: "rewind-disabled", label: "此消息缺少 checkpoint，不能回退" });
  }
  return base;
}

function messageExcerptContentLines(entry = {}) {
  const rows = [
    line(messageRoleLabel(entry.kind), false, entry.kind === "assistant" ? "green" : entry.kind === "user" || entry.kind === "agent" ? "cyan" : undefined)
  ];
  if (entry.title && entry.kind !== "user" && entry.kind !== "assistant" && entry.kind !== "agent") {
    rows.push(...wrapExcerptText(String(entry.title), { prefix: "  ", color: "cyan" }));
  }
  const body = String(entry.excerptBody ?? entry.body ?? "");
  if (!body) {
    rows.push(line("  [空消息]", true));
    return rows;
  }
  if (entry.kind === "assistant") {
    rows.push(...assistantExcerptBodyLines(body, { prefix: "  " }));
    return rows;
  }
  for (const text of body.split(/\r?\n/)) {
    rows.push(...wrapExcerptText(text, { prefix: "  " }));
  }
  return rows;
}

export function formatMessageBodyForDisplayClipboard(entry = {}) {
  const body = String(entry.excerptBody ?? entry.body ?? "");
  if (!body || entry.kind !== "assistant") {
    return body;
  }
  return renderAssistantBodyForClipboard(body);
}

/**
 * @param {Record<string, any>} task
 * @param {Record<string, any>} entry
 */
export function formatAgentTaskExcerptBody(task = {}, entry = {}) {
  const toolCalls = Array.isArray(task.toolCalls) ? task.toolCalls : [];
  const parts = [
    `标题：${truncate(String(task.title ?? entry.title ?? "子智能体任务"), 120)}`,
    `task：${task.id ?? entry.taskId ?? "unknown"}`,
    `profile：${task.profile ?? entry.profile ?? "unknown"}`,
    `状态：${task.status ?? entry.taskStatus ?? "unknown"}`,
    task.mode ? `mode：${task.mode}` : null,
    task.model ? `model：${task.model}${task.modelTier ? ` (${task.modelTier})` : ""}` : null,
    task.purpose ? `purpose：${task.purpose}` : null,
    task.difficulty ? `difficulty：${task.difficulty}` : null,
    task.risk ? `risk：${task.risk}` : null,
    task.createdAt ? `createdAt：${task.createdAt}` : null,
    task.startedAt ? `startedAt：${task.startedAt}` : null,
    task.finishedAt ? `finishedAt：${task.finishedAt}` : null,
    task.metadata?.outputPath ? `outputPath：${task.metadata.outputPath}` : null,
    Number.isFinite(task.metadata?.outputBytes) ? `outputBytes：${task.metadata.outputBytes}` : null,
    "",
    "latestProgress：",
    task.latestProgress ? `  ${task.latestProgress}` : "  [空]",
    "",
    "prompt：",
    task.prompt ? `  ${task.prompt}` : "  [空]",
    "",
    "toolCalls：",
    ...(toolCalls.length > 0
      ? toolCalls.map((call, index) => {
        const status = call.interrupted ? "interrupted" : call.ok ? "ok" : call.blocked ? "blocked" : "failed";
        const details = [
          call.inputSummary ? `input=${call.inputSummary}` : null,
          call.errorCode ? `error=${call.errorCode}` : null,
          call.decision ? `decision=${call.decision}` : null,
          Number.isFinite(call.resultBytes) ? `bytes=${call.resultBytes}` : null,
          Number.isFinite(call.omittedBytes) ? `omitted=${call.omittedBytes}` : null,
          call.truncated ? "truncated=true" : null
        ].filter(Boolean).join(" ");
        return `  ${index + 1}. ${call.name} [${status}]${details ? ` ${details}` : ""}`;
      })
      : ["  [空]"]),
    "",
    "outputSummary：",
    task.outputSummary ? `  ${task.outputSummary}` : "  [空]",
    "",
    "output：",
    task.output ? `  ${task.output}` : "  [空]",
    task.continuationPrompt ? [
      "",
      "continuationPrompt：",
      `  ${task.continuationPrompt}`
    ].join("\n") : null,
    task.budgetExceeded ? [
      "",
      "budgetExceeded：",
      `  ${JSON.stringify(task.budgetExceeded, null, 2)}`
    ].join("\n") : null,
    task.error ? [
      "",
      "error：",
      `  ${JSON.stringify(task.error, null, 2)}`
    ].join("\n") : null
  ].filter((part) => part !== null);
  return parts.join("\n");
}

function agentTaskIdentityLines(task = {}, entry = {}) {
  return [
    line("任务", false, "cyan"),
    line(`标题：${truncate(String(task.title ?? entry.title ?? "子智能体任务"), 120)}`),
    line(`task：${task.id ?? entry.taskId ?? "unknown"}`),
    line(`profile：${task.profile ?? entry.profile ?? "unknown"}`),
    line(`状态：${agentTaskStatusLabel(task.status ?? entry.taskStatus ?? "unknown")}`),
    task.mode ? line(`mode：${task.mode}`, true) : null,
    task.model ? line(`model：${task.model}${task.modelTier ? ` (${task.modelTier})` : ""}`, true) : null,
    task.purpose || task.difficulty || task.risk
      ? line(`route：${[task.purpose, task.difficulty, task.risk].filter(Boolean).join(" / ")}`, true)
      : null,
    task.startedAt ? line(`开始：${task.startedAt}`, true) : null,
    task.updatedAt ? line(`更新：${task.updatedAt}`, true) : null,
    task.finishedAt ? line(`结束：${task.finishedAt}`, true) : null
  ].filter(Boolean);
}

function agentTaskProgressLines(task = {}) {
  return [
    line("进度", false, "green"),
    task.latestProgress
      ? line(truncateMultiline(`最近：${task.latestProgress}`, 180))
      : line("最近：[暂无]", true),
    task.prompt
      ? line(truncateMultiline(`原始任务：${task.prompt}`, 220), true)
      : null,
    task.outputSummary
      ? line(truncateMultiline(`已产出摘要：${task.outputSummary}`, 220), false, "cyan")
      : null
  ].filter(Boolean);
}

function agentTaskBudgetLines(task = {}) {
  const budget = task.budget && typeof task.budget === "object" ? task.budget : {};
  const progress = task.budgetProgress && typeof task.budgetProgress === "object" ? task.budgetProgress : {};
  const lines = [
    line("预算/上下文", false, "yellow")
  ];
  const summary = [
    Number.isFinite(budget.maxRounds) ? `rounds<=${budget.maxRounds}` : "rounds=无限制",
    Number.isFinite(budget.maxOutputBytes) ? `output<=${budget.maxOutputBytes}B` : null
  ].filter(Boolean).join("  ");
  lines.push(summary ? line(summary, true) : line("未记录预算配置。", true));
  const runtime = [
    Number.isFinite(progress.toolCalls) ? `工具=${progress.toolCalls}` : null,
    Number.isFinite(progress.outputBytes) ? `输出=${progress.outputBytes}B` : null,
    Number.isFinite(progress.promptTokens)
      ? `模型输入≈${formatTokenCount(progress.promptTokens)}${Number.isFinite(progress.maxTokens) ? `/${formatTokenCount(progress.maxTokens)}` : ""} tokens`
      : null,
    Number.isFinite(progress.promptRound) ? `模型轮=${progress.promptRound}` : null,
    Number.isFinite(progress.consecutiveFailures) ? `连续失败=${progress.consecutiveFailures}` : null,
    Number.isFinite(progress.permissionDenials) ? `权限拒绝=${progress.permissionDenials}` : null,
    Number.isFinite(progress.contextTokensAfter) ? `ctx≈${progress.contextTokensAfter}` : null
  ].filter(Boolean).join("  ");
  if (runtime) {
    lines.push(line(runtime, true));
  }
  lines.push(...taskProviderUsagePanelLines(progress));
  const split = [
    Number.isFinite(progress.promptMessageTokens) ? `消息 ${formatTokenCount(progress.promptMessageTokens)}` : null,
    Number.isFinite(progress.promptToolSchemaTokens) ? `工具定义 ${formatTokenCount(progress.promptToolSchemaTokens)}` : null,
    Number.isFinite(progress.promptToolResultTokens) ? `工具结果 ${formatTokenCount(progress.promptToolResultTokens)}` : null
  ].filter(Boolean).join(" / ");
  if (split) {
    lines.push(line(`拆分：${split}`, true));
  }
  if (task.budgetExceeded) {
    lines.push(line(`阶段暂停：${truncateJson(task.budgetExceeded, 180)}`, false, "yellow"));
  }
  return lines;
}

function agentTaskToolLines(task = {}) {
  const calls = Array.isArray(task.toolCalls) ? task.toolCalls : [];
  const lines = [
    line(`工具调用（最近 ${Math.min(12, calls.length)}/${calls.length}）`, false, "cyan")
  ];
  if (calls.length === 0) {
    lines.push(line("暂无工具调用记录。", true));
    return lines;
  }
  for (const [index, call] of calls.slice(-12).entries()) {
    const absolute = calls.length - Math.min(12, calls.length) + index + 1;
    const status = call.interrupted ? "interrupted" : call.ok ? "ok" : call.blocked ? "blocked" : "failed";
    const color = call.ok ? "green" : call.blocked || call.interrupted ? "yellow" : "red";
    const details = [
      call.inputSummary ? truncate(String(call.inputSummary), 72) : null,
      call.errorCode ? `error=${call.errorCode}` : null,
      call.decision ? `decision=${call.decision}` : null,
      call.truncated ? "truncated" : null
    ].filter(Boolean).join("  ");
    lines.push(line(`${absolute}. ${call.name} [${status}]${details ? ` ${details}` : ""}`, false, color));
  }
  return lines;
}

function agentTaskOutputPreviewLines(task = {}) {
  const lines = [line("最新输出预览", false, "green")];
  if (task.output) {
    lines.push(...previewMultiline(task.output, 8, 120, { fromEnd: true }));
    return lines;
  }
  if (task.outputSummary) {
    lines.push(...previewMultiline(task.outputSummary, 5, 120, { fromEnd: true }));
    return lines;
  }
  lines.push(line("任务完成前通常只有进度和工具记录；完整输出会在结束后写入。", true));
  return lines;
}

function agentTaskContinuationLines(task = {}) {
  const lines = [];
  if (task.continuationPrompt) {
    lines.push(line("续跑提示", false, "yellow"));
    lines.push(...previewMultiline(task.continuationPrompt, 5, 120));
  }
  if (task.error) {
    if (lines.length > 0) {
      lines.push(line(""));
    }
    lines.push(line("错误", false, "red"));
    lines.push(line(truncateJson(task.error, 220), false, "red"));
  }
  if (lines.length === 0) {
    lines.push(line("操作", false, "cyan"));
    lines.push(line(task.status === "partial" ? `可用 /agents continue ${task.id} 续跑。` : "如需完整复制，按 Enter/C 进入冻结摘录层。", true));
  }
  return lines;
}

function agentTaskStatusLabel(status) {
  const value = String(status ?? "unknown");
  if (value === "running") {
    return "运行中";
  }
  if (value === "queued") {
    return "排队中";
  }
  if (value === "completed") {
    return "已完成";
  }
  if (value === "partial") {
    return "阶段暂停";
  }
  if (value === "failed") {
    return "失败";
  }
  if (value === "blocked") {
    return "被阻止";
  }
  if (value === "cancelled") {
    return "已取消";
  }
  if (value === "interrupted") {
    return "已中断";
  }
  return value;
}

function previewMultiline(value, maxLines = 6, maxWidth = 120, options = {}) {
  const lines = String(value ?? "").split(/\r?\n/);
  const fromEnd = options.fromEnd === true;
  const hidden = Math.max(0, lines.length - maxLines);
  const source = fromEnd && hidden > 0 ? lines.slice(-maxLines) : lines.slice(0, maxLines);
  const visible = source.map((text) => line(truncate(text || " ", maxWidth), false));
  if (hidden > 0) {
    const hint = fromEnd
      ? `... 上方还有 ${hidden} 行；这里显示最新内容，Enter/C 进入摘录层查看完整内容`
      : `... 还有 ${hidden} 行；Enter/C 进入摘录层查看完整内容`;
    if (fromEnd) {
      visible.unshift(line(hint, true));
    } else {
      visible.push(line(hint, true));
    }
  }
  return visible.length > 0 ? visible : [line("[空]", true)];
}

function truncateMultiline(value, max) {
  return truncate(String(value ?? "").replace(/\s+/g, " ").trim(), max);
}

function truncateJson(value, max) {
  try {
    return truncate(JSON.stringify(value), max);
  } catch {
    return truncate(String(value ?? ""), max);
  }
}

function normalizeResumeArchive(archive = {}) {
  const chunkSize = positiveInteger(archive?.chunkSize) ?? 50;
  const chunks = Array.isArray(archive?.chunks)
    ? archive.chunks.map(normalizeResumeChunk).filter(Boolean)
    : [];
  const totalFromChunks = chunks.reduce((sum, chunk) => sum + chunk.messages, 0);
  return {
    chunkSize,
    totalMessages: nonNegativeInteger(archive?.totalMessages) ?? totalFromChunks,
    chunks
  };
}

function normalizeResumeChunk(chunk = {}) {
  const index = positiveInteger(chunk.index);
  if (!index) {
    return null;
  }
  return {
    index,
    file: typeof chunk.file === "string" ? chunk.file : "",
    messages: nonNegativeInteger(chunk.messages) ?? 0,
    bytes: nonNegativeInteger(chunk.bytes) ?? 0,
    encrypted: chunk.encrypted === true
  };
}

function resumeChunkRange(chunk, chunkSize) {
  const start = ((chunk.index - 1) * chunkSize) + 1;
  const end = start + Math.max(0, chunk.messages) - 1;
  return chunk.messages > 0 ? `${start}-${end}` : "空";
}

function resumeChunkMessageLines(messages = []) {
  if (messages.length === 0) {
    return [line("[空分片]", true)];
  }
  const rows = [];
  for (const [index, message] of messages.entries()) {
    const role = message?.role === "user" ? "你" : message?.role === "assistant" ? "Ant Code" : String(message?.role ?? "message");
    const color = message?.role === "assistant" ? "green" : message?.role === "user" ? "cyan" : undefined;
    rows.push(line(`${String(index + 1).padStart(2, "0")}. ${role}`, false, color));
    const body = resumeMessageText(message?.content);
    if (!body) {
      rows.push(line("  [空消息]", true));
    } else if (message?.role === "assistant") {
      rows.push(...assistantExcerptBodyLines(body, { prefix: "  " }));
    } else {
      for (const text of body.split(/\r?\n/)) {
        rows.push(...wrapExcerptText(text, { prefix: "  " }));
      }
    }
    rows.push(line(""));
  }
  return rows;
}

function resumeMessageText(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content.map((item) => {
    if (typeof item === "string") {
      return item;
    }
    if (item && typeof item === "object" && "text" in item) {
      return String(item.text ?? "");
    }
    return "";
  }).filter(Boolean).join("\n");
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function assistantExcerptBodyLines(body, options = {}) {
  const prefix = options.prefix ?? "";
  const blocks = parseMarkdownBlocks(body);
  if (blocks.length === 0) {
    return [];
  }
  const rows = [];
  for (const block of blocks) {
    if (block.type === "table") {
      rows.push(...renderExcerptTableLines(block, { prefix }));
      continue;
    }
    for (const text of block.text.split(/\r?\n/)) {
      rows.push(...wrapExcerptText(text, { prefix }));
    }
  }
  return rows;
}

function renderAssistantBodyForClipboard(body) {
  const blocks = parseMarkdownBlocks(body);
  if (blocks.length === 0) {
    return "";
  }
  const rows = [];
  for (const block of blocks) {
    if (block.type === "table") {
      rows.push(...renderExcerptTableLines(block).map((item) => item.text));
    } else {
      rows.push(block.text);
    }
  }
  return rows.join("\n").trimEnd();
}

function renderExcerptTableLines(block, options = {}) {
  const prefix = options.prefix ?? "";
  const tableWidth = Math.max(16, MESSAGE_EXCERPT_TABLE_WIDTH - displayWidth(prefix));
  return renderTable(block, tableWidth, displayWidth, {
    summarizeLarge: false,
    wrapCells: true,
    minColumnWidth: 10
  }).map((item) => ({ ...item, text: `${prefix}${item.text}` }));
}

function wrapExcerptText(value, options = {}) {
  const prefix = options.prefix ?? "";
  const color = options.color;
  const text = String(value ?? "");
  const available = Math.max(16, MESSAGE_EXCERPT_WRAP_WIDTH - displayWidth(prefix));
  if (text.length === 0) {
    return [line(prefix || " ", false, color)];
  }
  const rows = [];
  let current = "";
  let currentWidth = 0;
  for (const char of Array.from(text)) {
    const charWidth = Math.max(0, displayWidth(char));
    if (current && currentWidth + charWidth > available) {
      rows.push(line(`${prefix}${current}`, false, color));
      current = char;
      currentWidth = charWidth;
    } else {
      current += char;
      currentWidth += charWidth;
    }
  }
  rows.push(line(`${prefix}${current}`, false, color));
  return rows;
}

function excerptUiLine(text, color = undefined) {
  return line(padExcerptLine(text), color ? false : true, color);
}

function padExcerptLine(text) {
  const value = String(text ?? "");
  const width = displayWidth(value);
  if (width >= MESSAGE_EXCERPT_LINE_WIDTH) {
    return value;
  }
  return `${value}${" ".repeat(MESSAGE_EXCERPT_LINE_WIDTH - width)}`;
}

function messageRoleLabel(kind) {
  if (kind === "user") {
    return "你";
  }
  if (kind === "assistant") {
    return "Ant Code";
  }
  if (kind === "agent") {
    return "子智能体";
  }
  return kind ?? "message";
}

function messageActionPreview(entry) {
  return String(entry?.body ?? "").replace(/\s+/g, " ").trim() || "[空消息]";
}

function permissionMatrixRows(session) {
  if (session.fullAccess || session.permissionMode === "fullAccess") {
    return [
      { text: "读取/写入任意路径：自动同意", color: "green" },
      { text: "shell 命令：自动同意（空命令仍视为无效）", color: "green" },
      { text: "MCP/本地扩展：自动同意", color: "green" },
      { text: "浏览器/网络：自动同意", color: "green" },
      { text: "疑似密钥路径：自动同意并由 hooks 记录", color: "yellow" }
    ];
  }
  if (session.permissionReadonlyLocked || session.readonly) {
    return [
      { text: "读取工作区：允许", color: "green" },
      { text: "写入/编辑工作区：拒绝（只读启动锁定）", color: "red" },
      { text: "只读 shell：允许", color: "green" },
      { text: "可变更 shell：拒绝（只读启动锁定）", color: "red" },
      { text: "MCP/本地扩展：按风险询问/拒绝", color: "yellow" },
      { text: "疑似密钥路径：拒绝", color: "red" }
    ];
  }
  if (session.permissionMode === "workspace" || session.allowWrite || session.allowCommand) {
    return [
      { text: "读取工作区：允许", color: "green" },
      { text: "写入/编辑工作区：自动同意（非敏感路径）", color: "green" },
      { text: "只读 shell：允许", color: "green" },
      { text: "常规本地 shell：自动同意", color: "green" },
      { text: "工作区外路径/疑似密钥路径：询问或强确认", color: "yellow" },
      { text: "MCP/浏览器/联网能力：按风险询问", color: "yellow" }
    ];
  }
  return [
    { text: "读取工作区：允许", color: "green" },
    { text: "写入/编辑工作区：询问", color: "yellow" },
    { text: "只读 shell：允许", color: "green" },
    { text: "可变更 shell：询问", color: "yellow" },
    { text: "MCP/浏览器/联网能力：询问", color: "yellow" },
    { text: "工作区外路径/疑似密钥路径：询问或强确认", color: "yellow" }
  ];
}

function formatContextBrief(summary) {
  const localLimit = summary.modelMaxTokens ? `, 本地阈值=${formatTokenCount(summary.maxTokens)}` : "";
  const latestInput = Number.isFinite(summary.promptTokens)
    ? `, 最近输入=${formatTokenCount(summary.promptTokens)}`
    : "";
  const provider = Number.isFinite(summary.providerPromptTokens)
    ? `, Provider=${formatProviderUsageBrief(summary)}`
    : "";
  return `模型上下文=${formatTokenCount(summary.messageTokens)}/${formatTokenCount(primaryTokenLimit(summary))}（估算）${latestInput}${localLimit}${provider}, 压缩=${summary.compacted}, 摘要=${formatTokenCount(summary.summaryTokens)} tokens`;
}

function providerUsagePanelLines(usage = {}) {
  const lines = [
    line(`报告次数：${usage.reports}`),
    line(`累计：${formatProviderUsageBrief({
      providerPromptTokens: usage.promptTokens,
      providerCachedPromptTokens: usage.cachedPromptTokens,
      providerCompletionTokens: usage.completionTokens,
      providerTotalTokens: usage.totalTokens
    })}`),
    line(`最近：${formatProviderUsageBrief({
      providerPromptTokens: usage.lastPromptTokens,
      providerCachedPromptTokens: usage.lastCachedPromptTokens,
      providerCompletionTokens: usage.lastCompletionTokens,
      providerTotalTokens: usage.lastTotalTokens
    })}`)
  ];
  if (usage.lastModel || usage.lastRound) {
    lines.push(line(`最近轮次：${usage.lastRound ?? "?"}${usage.lastModel ? ` / ${usage.lastModel}` : ""}`, true));
  }
  if (usage.last) {
    lines.push(line(`最近原始 usage：${formatValue(usage.last)}`, true));
  }
  return lines;
}

function formatProviderUsageBrief(summary = {}) {
  const parts = [
    Number.isFinite(summary.providerPromptTokens) ? `输入 ${formatTokenCount(summary.providerPromptTokens)}` : null,
    Number.isFinite(summary.providerCachedPromptTokens) ? `缓存 ${formatCachedPromptUsage(summary.providerCachedPromptTokens, summary.providerPromptTokens)}` : null,
    Number.isFinite(summary.providerCompletionTokens) ? `输出 ${formatTokenCount(summary.providerCompletionTokens)}` : null,
    Number.isFinite(summary.providerTotalTokens) ? `合计 ${formatTokenCount(summary.providerTotalTokens)}` : null
  ].filter(Boolean);
  return parts.length > 0 ? `${parts.join(" / ")} tokens` : "未报告 token 细分";
}

function formatTokenCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return "?";
  }
  if (number >= 1000000) {
    return `${Math.round(number / 100000) / 10}M`;
  }
  if (number >= 1000) {
    return `${Math.round(number / 100) / 10}k`;
  }
  return String(number);
}

function formatValue(value) {
  if (value === null || value === undefined || value === "") {
    return "无";
  }
  if (typeof value === "object") {
    return truncate(JSON.stringify(value), 160);
  }
  return String(value);
}

function taskProviderUsagePanelLines(progress = {}) {
  const hasProviderUsage = Number.isFinite(progress.providerPromptTokens) ||
    Number.isFinite(progress.providerCachedPromptTokens) ||
    Number.isFinite(progress.providerCompletionTokens) ||
    Number.isFinite(progress.providerTotalTokens);
  if (!hasProviderUsage) {
    return [];
  }
  const lines = [
    line("Provider 实报", false, "green"),
    Number.isFinite(progress.providerPromptTokens)
      ? line(`输入：${formatTokenCount(progress.providerPromptTokens)} tokens`, true, "green")
      : null,
    Number.isFinite(progress.providerCachedPromptTokens)
      ? line(`缓存命中：${formatCachedPromptUsage(progress.providerCachedPromptTokens, progress.providerPromptTokens)} tokens`, true, "green")
      : null,
    Number.isFinite(progress.providerCompletionTokens)
      ? line(`输出：${formatTokenCount(progress.providerCompletionTokens)} tokens`, true, "green")
      : null,
    Number.isFinite(progress.providerTotalTokens)
      ? line(`合计：${formatTokenCount(progress.providerTotalTokens)} tokens`, true, "green")
      : null,
    Number.isFinite(progress.providerRound)
      ? line(`模型轮：${progress.providerRound}`, true, "green")
      : null
  ].filter(Boolean);
  return lines;
}

function formatCachedPromptUsage(cachedTokens, promptTokens) {
  const cached = formatTokenCount(cachedTokens);
  if (!Number.isFinite(promptTokens) || promptTokens <= 0) {
    return cached;
  }
  const percent = Math.round((cachedTokens / promptTokens) * 100);
  return `${cached}/${formatTokenCount(promptTokens)} (${percent}%)`;
}

function formatSessionTime(value) {
  if (!value) {
    return "未知时间";
  }
  return String(value).replace("T", " ").replace(/\.\d{3}Z$/, "Z");
}

function primaryTokenLimit(summary) {
  return summary.modelMaxTokens ?? summary.maxTokens;
}

function panel(value) {
  return {
    tabs: [],
    tabIndex: 0,
    lines: [],
    footer: "Esc 关闭",
    ...value
  };
}

function clampIndex(index, length) {
  if (length <= 0) {
    return 0;
  }
  return Math.min(length - 1, Math.max(0, index));
}
