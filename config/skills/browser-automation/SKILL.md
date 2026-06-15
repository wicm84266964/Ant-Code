---
name: browser-automation
description: 浏览器自动化和前端页面验收工作流。
when_to_use: 需要打开网页、点击、输入、截图、检查本地 dev server 或验证 UI 行为时使用。
allowed-tools: mcp_list, mcp_call, powershell, bash, read_file, web_fetch
argument_hint: 提供目标 URL、要验证的用户流程、期望看到的页面状态和是否允许启动本地服务。
---
# Browser Automation

用这个 skill 做浏览器交互和 UI 验收。浏览器能力默认需要用户批准。

## 推荐路线

1. 轻量验收优先使用 Playwright CLI 或项目自带测试脚本。
2. 需要模型逐步观察页面、点击、输入、截图时，再使用 `playwright` MCP。
3. 如果目标是本地网页，先确认 dev server 是否已启动；没有启动时先询问或用受权限控制的 shell 命令启动。

## MCP 检查

- 先用 `mcp_list` 查看是否有 `playwright` server。
- 如果没有或被禁用，提示用户运行 `/mcp doctor` 并启用 `playwright`。
- 使用 `mcp_call` 时只做必要动作，不连续抓取大量页面快照。

## 验收报告

报告应包含：

- 访问的 URL。
- 执行的关键步骤。
- 观察到的实际结果。
- 截图或快照是否生成。
- 通过/失败结论。
- 复现失败时的下一步命令。
