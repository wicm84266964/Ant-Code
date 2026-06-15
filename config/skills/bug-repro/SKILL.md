---
name: bug-repro
description: Bug 复现、最小触发路径定位和修复验证工作流。
when_to_use: 用户报告具体错误、测试失败、UI 异常或命令异常时使用。
allowed-tools: read_file, list_files, glob, grep, git_status, git_diff, powershell, bash, plan_update, todo_write
argument_hint: 提供现象、复现步骤、期望结果、实际结果和可运行的验证命令。
---
# Bug Repro

用这个 skill 复现问题并建立修复闭环。

## 工作流

1. 复述现象，确认期望行为和实际行为。
2. 找最小复现路径：
   - 优先运行已有测试或用户给的命令。
   - 没有命令时先读相关代码和文档。
3. 区分问题类型：
   - 环境缺失。
   - 权限策略阻止。
   - 实现 bug。
   - 测试假设过期。
4. 修复前写清楚验证点。
5. 修复后运行同一条复现命令和必要的回归检查。

## 输出要求

- 列出复现命令、退出码和关键错误。
- 修复成功前不要声称完成。
- 如果无法复现，说明尝试过什么和下一步需要用户提供什么。
