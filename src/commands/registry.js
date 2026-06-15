export const SLASH_COMMANDS = Object.freeze([
  command("help", "入门", "帮助", "显示可用命令。", { keybind: "/help" }),
  command("status", "入门", "状态", "显示当前会话和策略状态。"),
  command("next", "入门", "下一步", "显示建议的下一步和验证命令。"),
  command("report", "入门", "交付报告", "显示当前会话的交付报告。"),
  command("files", "工作区", "文件", "列出工作区文件。"),
  command("map", "工作区", "仓库地图", "显示轻量仓库地图。"),
  command("diff", "工作区", "差异", "显示本地 git diff 输出。"),
  command("review", "工作区", "审查", "检查工作区改动和验证状态。"),
  command("edit", "工作区", "编辑", "经批准后执行精确文本替换。"),
  command("run", "验证", "运行命令", "通过权限引擎运行本地命令。", { aliases: ["!"] }),
  command("verify", "验证", "验证", "运行或列出验证命令。"),
  command("todo", "工作流", "待办", "查看或更新当前会话待办。"),
  command("plan", "工作流", "计划", "查看或更新当前会话计划。"),
  command("memory", "工作流", "记忆", "显示已加载记忆来源。"),
  command("tasks", "工作流", "任务", "显示本地任务状态。", { aliases: ["agents tasks"] }),
  command("model", "配置", "模型", "查看或切换模型别名。"),
  command("cost", "配置", "费用", "显示本地用量和费用估算可用性。"),
  command("usage", "配置", "用量", "显示可用的本地用量计数。"),
  command("context", "配置", "上下文", "显示当前上下文窗口状态。"),
  command("config", "配置", "配置", "显示生效配置摘要。"),
  command("capabilities", "配置", "能力", "显示内置工具、MCP、技能和子智能体能力清单。"),
  command("permissions", "配置", "权限", "显示权限策略摘要。", { keybind: "Shift+Tab" }),
  command("thinking", "配置", "思考链", "切换 TUI 中 thinking/reasoning 预览显示；默认隐藏，超长内容仅保留最新片段。"),
  command("keybindings", "配置", "快捷键", "显示 TUI 快捷键。"),
  command("logs", "配置", "运行日志", "在 TUI 中查看最近的本地运行日志。"),
  command("hooks", "配置", "Hooks", "显示本地 hooks 开关、注册项和最近审计记录。"),
  command("theme", "配置", "主题", "显示本地主题可用性。", { disabledReason: "主题注册表仍在评审中" }),
  command("feedback", "配置", "反馈", "显示实验室本地反馈路径。", { disabledReason: "云端反馈上传已禁用" }),
  command("fast", "配置", "快速模型", "显示快速模型模式可用性。", { disabledReason: "自动快速模型切换暂缓" }),
  command("doctor", "配置", "诊断", "运行本地诊断。"),
  command("gateway", "配置", "网关", "检查实验室网关配置和健康状态。"),
  command("clear", "会话", "清空上下文", "清除可见会话上下文。"),
  command("compact", "会话", "压缩", "压缩当前上下文。"),
  command("queue", "会话", "队列", "管理当前 TUI 会话的排队提示。"),
  command("guide", "会话", "引导", "在当前模型响应结束后中断并优先运行引导；停止/stop 只取消。"),
  command("new", "会话", "新会话", "在 TUI 中启动新本地会话。"),
  command("resume", "会话", "历史分片", "查看当前会话的 50 条 transcript 分片。"),
  command("sessions", "会话", "会话列表", "显示、恢复或清理本地会话记录。"),
  command("rewind", "会话", "回退", "显示本地回退可用性。", { disabledReason: "本地回退/分叉元数据暂缓" }),
  command("branch", "会话", "分支", "显示本地分支可用性。", { disabledReason: "会话分支元数据暂缓" }),
  command("stash", "会话", "暂存", "显示提示暂存可用性。", { disabledReason: "提示暂存暂缓" }),
  command("background", "会话", "后台", "运行、取消或查看本地后台子任务。"),
  command("mcp", "扩展", "MCP", "显示已配置 MCP 服务器。"),
  command("agents", "扩展", "子智能体", "显示可用子智能体、任务组和配置。"),
  command("skills", "扩展", "技能", "显示或读取本地技能指令资源。")
]);

export const KEYBINDINGS = Object.freeze([
  keybinding("submit", "输入区", "Enter", "提交提示，或选择当前面板项。"),
  keybinding("newline", "输入区", "Ctrl+J", "在输入草稿中插入换行。"),
  keybinding("clear-draft", "输入区", "Ctrl+U", "清空当前草稿。"),
  keybinding("prompt-history", "输入区", "Ctrl+↑/Ctrl+↓", "召回上一条/下一条已提交提示。", "输入区聚焦且没有弹层。"),
  keybinding("slash", "发现", "/", "打开斜杠命令面板。"),
  keybinding("file-mention", "发现", "@", "打开工作区文件提及面板。"),
  keybinding("shell", "发现", "!", "通过 /run 进入本地 shell 模式。"),
  keybinding("side-tab", "面板", "Tab", "切换右侧栏：状态、任务、子智能体。", "宽终端显示固定侧栏；窄终端显示 compact 摘要。"),
  keybinding("side-arrows", "面板", "←/→", "输入区为空时切换当前侧栏分类；在状态栏中切换侧栏。", "输入草稿里仍然用于移动光标。"),
  keybinding("message-actions", "面板", "鼠标点击消息块", "选中消息并打开复制、回退和重生成操作面板。", "回退只影响对话上下文，不撤销文件改动。"),
  keybinding("transcript-detail", "面板", "Ctrl+O", "在紧凑/详细/完整 transcript 间切换。"),
  keybinding("thinking-toggle", "面板", "/thinking", "切换 thinking 预览显示；默认隐藏，超长内容仅保留最新片段。"),
  keybinding("wheel", "面板", "鼠标滚轮", "按鼠标位置滚动聊天区、右侧栏或当前弹层。"),
  keybinding("page-scroll", "面板", "PageUp/PageDown", "滚动聊天区或当前弹层。"),
  keybinding("logs", "日志", "/logs", "打开最近运行日志；日志类型用 Tab 或 ←/→ 切换。", "日志仅保存在当前 TUI 进程内。"),
  keybinding("permission-mode", "权限", "Shift+Tab", "切换权限：计划确认 -> 工作区权限 -> 完全访问；后续提示/命令生效，当前运行轮次保留启动时权限。"),
  keybinding("close", "生命周期", "Esc", "先关闭顶部弹层；忙碌时第一次确认、第二次中断当前轮次。"),
  keybinding("interrupt", "生命周期", "Ctrl+G", "先关闭顶部弹层；忙碌时直接中断当前轮次。"),
  keybinding("exit", "生命周期", "Ctrl+C", "第一次进入退出确认；第二次退出。"),
  keybinding("approval", "权限", "Y/N/A", "权限弹窗中分别表示允许一次、拒绝、允许本会话同类请求。", "仅在权限确认框显示时有效。")
]);

const CATEGORY_ORDER = Object.freeze([
  "入门",
  "工作区",
  "验证",
  "工作流",
  "配置",
  "会话",
  "扩展"
]);

export function listSlashCommands() {
  return SLASH_COMMANDS.map((command) => ({ ...command }));
}

export function listSlashCommandGroups() {
  const commands = listSlashCommands();
  return CATEGORY_ORDER.map((category) => ({
    category,
    commands: commands.filter((command) => command.category === category)
  })).filter((group) => group.commands.length > 0);
}

export function listKeybindings() {
  return KEYBINDINGS.map((item) => ({ ...item }));
}

export function listKeybindingGroups() {
  const grouped = new Map();
  for (const item of listKeybindings()) {
    const group = item.category || "其他";
    grouped.set(group, [...(grouped.get(group) ?? []), item]);
  }
  return Array.from(grouped, ([category, keybindings]) => ({ category, keybindings }));
}

function command(name, category, title, description, options = {}) {
  return {
    id: `slash.${name}`,
    name,
    title,
    category,
    description,
    aliases: options.aliases ?? [],
    keybind: options.keybind ?? null,
    disabledReason: options.disabledReason ?? null,
    action: options.action ?? `slash:${name}`,
    panel: options.panel ?? null
  };
}

function keybinding(id, category, key, description, condition = "") {
  return {
    id,
    category,
    key,
    description,
    condition
  };
}
