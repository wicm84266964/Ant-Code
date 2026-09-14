export const TOOL_LABELS: Readonly<Record<string, string>> = Object.freeze({
  tool_result_read: "读取工具证据",
  read_file: "读取文件",
  list_files: "列出文件",
  glob: "查找文件",
  grep: "搜索文本",
  rg_search: "搜索代码",
  rg_files: "按名查找文件",
  rg_files_with_matches: "查找含匹配的文件",
  rg_count: "统计匹配",
  ts_symbols: "查看 TypeScript 符号",
  ts_diagnostics: "查看 TypeScript 诊断",
  ts_find_definition: "查找 TypeScript 定义",
  ts_find_references: "查找 TypeScript 引用",
  git_status: "检查 Git 状态",
  git_diff: "查看 Git 差异",
  git_log: "查看 Git 记录",
  git_show: "查看 Git 对象",
  git_branch_list: "列出 Git 分支",
  git_stash_list: "列出 Git 暂存",
  git_tag_list: "列出 Git 标签",
  git_add: "暂存 Git 改动",
  git_commit: "提交 Git 改动",
  git_branch: "管理 Git 分支",
  git_stash: "管理 Git 暂存",
  git_tag: "管理 Git 标签",
  write_file: "写入文件",
  edit_file: "编辑文件",
  powershell: "运行 PowerShell",
  bash: "运行 Shell",
  background_shell: "启动后台终端",
  background_terminal_list: "列出后台终端",
  background_terminal_cancel: "停止后台终端",
  mcp_list: "列出 MCP 能力",
  mcp_call: "调用 MCP 工具",
  web_fetch: "访问网页",
  web_search: "搜索网页",
  document_intake: "读取文档",
  skill_list: "列出技能",
  skill_read: "读取技能",
  skill_run: "运行技能",
  agent_run: "启动子智能体",
  todo_read: "读取任务清单",
  todo_write: "更新任务清单",
  plan_update: "更新计划",
  ask_user: "询问用户"
});

export function toolLabel(name: unknown) {
  const key = String(name ?? "").trim();
  if (!key) {
    return "工具";
  }
  return TOOL_LABELS[key] ?? key;
}
