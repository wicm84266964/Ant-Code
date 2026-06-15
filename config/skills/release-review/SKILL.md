---
name: release-review
description: 发版前检查测试、文档、配置、安装和残余风险的交付审查工作流。
when_to_use: 准备打包、全局安装、交付验收或生成最终报告前使用。
allowed-tools: read_file, list_files, glob, grep, git_status, git_diff, powershell, bash, skill_read
argument_hint: 提供本次发布范围、必须通过的验证命令和目标环境。
---
# Release Review

用这个 skill 做交付前审查。

## 检查项

1. 代码状态：
   - 本次改动文件。
   - 是否有无关改动。
   - 是否有敏感文件或密钥风险。
2. 测试状态：
   - `npm run check` 或项目指定验证命令。
   - 失败项和未测项。
3. 文档状态：
   - 用户可读说明。
   - 维护日志。
   - LLM onboarding。
4. 安装状态：
   - 全局命令是否指向当前项目。
   - 配置是否不包含真实 key。
5. 残余风险：
   - 需要手工验收的点。
   - 暂缓项。

## 输出要求

- 先列阻塞项。
- 再列非阻塞风险。
- 最后给出是否建议交付。
