---
name: codebase-orientation
description: 快速接手陌生仓库，建立架构地图、入口、关键模块和验证路径。
when_to_use: 用户要求先了解项目、定位功能边界、接续 handoff 或开始一轮较大改动时。
allowed-tools: read_file, list_files, glob, grep, git_status, git_diff, todo_read, plan_update
argument-hint: 目标模块或用户关心的问题
context: instruction
agent: explorer
paths:
  - README.md
  - docs/
  - src/
---
# Codebase Orientation

先建立一个小而准的仓库地图，再进入细节。

1. 读取 README、package/config、docs 中的入口说明，确认项目目标和启动方式。
2. 找到 CLI 入口、核心运行时、工具系统、配置加载和测试目录。
3. 用 grep/glob 定位用户提到的命令、快捷键、模块名或错误码。
4. 输出结论时优先给文件路径、模块职责、数据流和下一步验证命令。
5. 如果信息不足，列出还需要读取的 3-5 个具体文件。

不要编辑文件。不要把目录树完整 dump 给用户；只保留和任务相关的结构。
