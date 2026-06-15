---
name: test-failure-triage
description: 定位测试、构建或运行失败原因，并给出最小修复路径。
when_to_use: npm run check、node --test、集成测试、TUI 验收或本地命令失败时。
allowed-tools: read_file, glob, grep, powershell, bash, git_status, git_diff
argument-hint: 失败命令、错误摘要或测试文件
context: fork
agent: verifier
paths:
  - tests/
  - scripts/
  - package.json
---
# Test Failure Triage

围绕失败信号收敛，不做大范围重构。

1. 先复现或读取失败输出，记录命令、退出码和第一处关键错误。
2. 找到对应测试文件和被测模块，比较期望行为与当前行为。
3. 优先判断是测试夹具、边界条件、异步时序、配置缺失还是真实回归。
4. 给出最小修复建议；如果允许修改，再只改和失败直接相关的文件。
5. 修复后运行最小相关测试，再视风险运行 `npm run check`。

不要隐藏失败；如果没有复现环境，说明缺失条件和建议用户执行的命令。
