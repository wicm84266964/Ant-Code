---
name: release-readiness-review
description: 交付前审查功能完成度、权限边界、文档、测试和可回滚性。
when_to_use: 用户说基本完工、准备打包、全量验收、发布或上交成果时。
allowed-tools: read_file, glob, grep, git_status, git_diff, powershell, bash
argument-hint: 发布版本、验收范围或目标包路径
context: instruction
agent: verifier
paths:
  - docs/deployment/
  - docs/audit/
  - scripts/
  - package.json
---
# Release Readiness Review

按交付风险排序检查，而不是只看测试是否通过。

1. 确认当前工作目录、全局安装目标和备份路径，避免跑到旧项目。
2. 查看 git 状态，区分本轮修改、历史遗留修改和生成文件。
3. 运行或确认 `npm run check`，关注语法、禁用端点、provenance、依赖策略和测试结果。
4. 审查权限、MCP、skill、agent、transcript、网关 key 边界是否有泄露或默认启用风险。
5. 检查 README、部署说明、验收文档和 handoff 是否说明当前限制。
6. 输出时先列阻塞问题，再列非阻塞风险，最后给交付结论。

不要把本地 API key、私有路径、session transcript 原文写入发布文档。
