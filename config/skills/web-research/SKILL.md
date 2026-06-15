---
name: web-research
description: 联网检索、网页抓取、来源核验和带引用摘要工作流。
when_to_use: 需要获取网络公开信息、查最新文档、比较资料来源、引用网页证据时使用。
allowed-tools: web_search, web_fetch, mcp_list, mcp_call, read_file, skill_read
argument_hint: 简述要调查的问题、时间范围、可信来源偏好和需要输出的格式。
---
# Web Research

用这个 skill 做外部信息调查。先判断问题是否真的需要联网；如果只是本地代码问题，优先读本地文件。

## 工作流

1. 明确用户要查什么、是否需要最新信息、是否有指定来源。
2. 优先使用 `web_search` 搜索 3-5 个候选来源；如果配置了 SearXNG 或搜索 MCP，可先检查 `mcp_list`。
3. 对关键来源使用 `web_fetch` 抓取正文，优先 `markdown`。当前 Ant Code 默认让 `web_fetch` 先走 `fetch` MCP；如果 MCP 不可用，再回退到内置抓取器。
   - 如果抓取被权限策略、反爬或 HTML 噪声阻断，先改用搜索摘要、官方 API/raw 文件。
   - 若配置允许，可尝试 reader mirror：`https://r.jina.ai/http://r.jina.ai/http://<原始URL>`，并在 caveats 中说明使用了镜像读取。
4. 对来源做分级：
   - 官方文档、标准、论文、项目仓库优先。
   - 博客、论坛、二手摘要只作为辅助。
5. 输出时写清楚：
   - 直接结论。
   - 关键证据和 URL。
   - 时间敏感性。
   - 仍未验证或来源冲突的点。

## 输出要求

- 不要编造来源。
- 不要把长网页全文贴进主回答。
- 如果网络被权限策略阻止，明确说明需要用户允许网络或配置 MCP。
- 如果搜索结果质量差，说明局限，不要把猜测包装成事实。
