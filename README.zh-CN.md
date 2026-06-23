# Ant Code

[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.20709743.svg)](https://doi.org/10.5281/zenodo.20709743)

Ant Code 是一个本地优先的代码智能体，面向真实仓库里的复杂软件工作。它把交互式
终端 TUI、本机 Dashboard、工具权限、skills、MCP 集成、可恢复会话、子智能体编排
和模型网关适配放在同一个运行时里。

它的核心边界很明确：工具在用户本机执行，模型请求只发往用户配置的模型网关。文件
编辑、Shell 命令、MCP 调用、任务状态、审批记录、transcript 和验证历史都由本地
运行时控制。

本仓库使用 GNU Affero General Public License v3.0 发布。

## Ant Code 的特点

- 本地优先执行：文件、Shell、Git、网络、MCP 和工作流工具都经过本地权限引擎。
- 子智能体编排：可以把有边界的任务交给 explorer、planner、verifier、reviewer、
  visual-verifier、browser-verifier、junior、code-worker 等类型的子智能体。
- 后台任务流：长任务可以通过 task record、task group、预算、wakeup 和父会话摘要
  持续跟踪。
- Planner 计划包：规划型子智能体可以持久化结构化实现计划，方便后续命令和 reviewer
  检查。
- 面向验证的工作流：会话会记录本地 todo、plan、验证结果、交付状态和下一步建议。
- 与模型供应商解耦：支持原生 `lab-agent-gateway` 协议，也支持 OpenAI Chat
  Completions 兼容适配器。
- 文本和视觉路由：当网关支持时，可以给编码任务和图像输入配置不同模型别名。
- Dashboard 和 TUI 共用同一运行时：终端和浏览器界面看到的是同一套会话、权限、任务
  和本地状态。
- Skills 与 MCP 扩展：可通过内置 skills 和显式配置的 MCP server 扩展能力，同时不把
  供应商凭据放进客户端。
- 高敏感模式：可收紧 transcript 保留、网络模式和元数据策略，用于私有仓库或研究数据。

## 核心能力

- 交互式终端编码智能体（`ant-code`）
- 适合脚本化调用的一次性 print mode
- 绑定 `127.0.0.1` 的本机 Dashboard/WebUI
- 文件读写、精确替换、diff preview 和 Git 状态检查
- 带审批边界的本地 Shell 执行
- 可配置模型网关和健康检查
- OpenAI Chat Completions 兼容网关模式
- 原生 provider-independent 网关协议模式
- 从 `config/skills` 加载本地 skills
- 本地 MCP server 配置
- 会话持久化、transcript 分片、model-context resume 和 compaction
- Dashboard 渲染 Markdown、代码、图片、PDF、文件、Mermaid 和 KaTeX

## 目录结构

```text
ant-code/
  src/                         # 运行时源码
  tests/                       # 单元测试和集成测试
  scripts/                     # 校验、构建、审计和 mock gateway 脚本
  config/                      # 配置模板和内置 skills
  docs/                        # 安装、网关、快速开始和安全边界文档
  lab-agent.config.json         # 默认示例配置
```

## 环境要求

- Node.js 20+
- npm
- Windows 上的 PowerShell，或 Linux/macOS 上的 POSIX shell
- 真实模型调用需要用户自己控制的模型网关

测试和 mock gateway 不需要真实模型服务。

## 从源码安装

```sh
git clone https://github.com/wicm84266964/Ant-Code.git
cd Ant-Code
npm ci
npm run verify:install
node src/cli/index.js doctor
node src/cli/index.js tui
```

如果希望在任意项目目录里使用本地开发版：

```sh
npm link
ant-code --version
ant-code doctor
ant-code
```

`package.json` 保留 `"private": true`，用于避免误发布到 npm registry。源码仓库
本身按 AGPL-3.0 开源。

## 配置模型网关

创建或复制本地配置：

```powershell
copy .\config\lab-agent.lab-template.json .\lab-agent.config.json
```

编辑复制后的文件，设置：

- `modelAlias`
- `models`
- `lab.gatewayProtocol`
- `lab.gatewayUrl`
- `lab.gatewayHealthUrl`
- `allowedHosts`
- `agents.modelTiers`

网关访问 token 不要写进 JSON：

```powershell
[Environment]::SetEnvironmentVariable("LAB_MODEL_GATEWAY_API_KEY", "<gateway-access-token>", "User")
```

重新打开终端后验证：

```powershell
ant-code doctor
ant-code gateway --live
ant-code -p "Reply exactly: ready"
```

本地临时测试可以使用内置 mock gateway：

```powershell
npm run mock-gateway -- --port 8787
$env:LAB_MODEL_GATEWAY_URL = "http://127.0.0.1:8787/v1/chat"
$env:LAB_MODEL_GATEWAY_PROTOCOL = "openai-chat"
node .\src\cli\index.js -p "hello"
```

## 运行 Ant Code

交互式终端会话：

```sh
ant-code
```

一次性 prompt：

```sh
ant-code -p "总结这个仓库，并建议下一步验证命令。"
```

本机 Dashboard：

```powershell
ant-code dashboard
```

Dashboard 绑定 `127.0.0.1`，默认端口是 `7410`，并拒绝非 loopback host。它复用
和 TUI 相同的本地运行时、权限引擎、任务存储和 `.lab-agent/sessions` 会话存储。

常用 Dashboard 参数：

```powershell
ant-code dashboard --port 7410
ant-code dashboard --no-open
ant-code dashboard --project .
```

## 常用命令

```sh
npm run doctor
npm run check:syntax
npm run check:dependencies
npm test
npm run mock-gateway -- --port 8787
node src/cli/index.js --version
node src/cli/index.js -p "/status"
```

## 安全边界

Ant Code 是本地客户端。文件编辑、Shell 命令、MCP 工具、网络访问和工作流动作都由
本地权限系统控制。供应商凭据应该放在配置的网关/模型适配器中，或放在本机环境变量
里。不要提交 `.env`、网关 token、会话存储、transcript 或私有项目数据。

## 许可证

GNU Affero General Public License v3.0。见 [LICENSE](LICENSE)。

项目 DOI：[10.5281/zenodo.20709743](https://doi.org/10.5281/zenodo.20709743)。

内置第三方运行时依赖和 Dashboard 静态资源见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
