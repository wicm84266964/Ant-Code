---
name: project-intake
description: 陌生项目接手、结构梳理、入口识别和风险初筛工作流。
when_to_use: 需要快速理解一个新仓库、生成项目地图、找运行命令或准备后续修改时使用。
allowed-tools: list_files, glob, grep, read_file, git_status, skill_read, agent_run
argument_hint: 说明要理解的项目范围、重点模块和是否只读。
---
# Project Intake

用这个 skill 接手陌生项目。默认只读，不改文件。

## 工作流

1. 先列根目录和关键配置文件。
2. 识别技术栈：
   - package、lockfile、tsconfig、pytest、go.mod、Cargo.toml、Dockerfile 等。
3. 找入口：
   - CLI、server、frontend、test、build scripts。
4. 找项目规则：
   - README、docs、AGENTS、CLAUDE、OPENCODE、.lab-agent、.ant-code。
5. 输出结构化项目画像：
   - 这是做什么的。
   - 怎么启动。
   - 怎么测试。
   - 关键目录。
   - 风险点。
   - 下一步建议。

## 输出要求

- 引用具体文件路径。
- 不猜测未读过的模块。
- 如果仓库很大，建议派只读子智能体分区调查。
