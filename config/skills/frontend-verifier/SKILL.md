---
name: frontend-verifier
description: TUI/Web UI 布局、滚动、输入、弹层和交互验收工作流。
when_to_use: 需要验证前端页面、终端 TUI、小窗口/大窗口布局或快捷键交互时使用。
allowed-tools: powershell, bash, mcp_list, mcp_call, read_file, web_fetch
argument_hint: 提供要验证的界面、窗口尺寸、关键交互和通过标准。
---
# Frontend Verifier

用这个 skill 做界面验收。目标是产出可复现的通过/失败报告。

## 工作流

1. 明确视口或终端尺寸。
2. 明确核心交互：
   - 滚动。
   - 输入。
   - 弹层。
   - 快捷键。
   - 右侧栏。
3. 对 Web UI 优先使用 Playwright CLI 或 `playwright` MCP。
4. 对 TUI 优先使用项目自带 snapshot/smoke 测试和用户手动验收步骤。
5. 记录失败时的最小复现动作。

## 输出要求

- 每个验收点给出通过/失败/未测。
- 不用“看起来正常”代替证据。
- 如果需要用户手测，给出具体按键和预期表现。
