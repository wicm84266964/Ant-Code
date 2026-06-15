# Ant Code

Ant Code 是一个本地运行的编码智能体运行时，包含终端 TUI、本机 Dashboard、
工具权限、skills、MCP 集成、子智能体、会话存储和模型网关适配。

工具调用在用户本机执行。模型请求只会发往用户自己配置的模型网关。网关访问
token 等密钥应该放在环境变量或本机用户配置里，不应该写进这个仓库。

本仓库使用 GNU Affero General Public License v3.0 发布。

## 当前状态

这是整理后的开源源码版本。它刻意不包含本机运行状态、日志、transcript、构建产物、
私有网关配置、机器备份和交接文档。

公开项目名是 **Ant Code**。为了兼容已有安装，`lab-agent` 这个内部代号仍保留在
配置文件名、协议标识和本地状态路径中。

## 功能

- 交互式终端编码智能体
- 绑定 `127.0.0.1` 的本机 Dashboard/WebUI
- 一次性 prompt 的 print mode
- 本地文件、Shell、网络、MCP 和工作流工具权限控制
- 可配置模型网关
- OpenAI Chat Completions 兼容网关模式
- 原生 `lab-agent-gateway` 协议模式
- 从 `config/skills` 加载本地 skills
- 本地 MCP server 配置
- 子智能体、后台任务、planner 计划包和 wakeup 流程
- 会话持久化、transcript 分片和 model-context 恢复
- Dashboard 渲染 Markdown、代码、图片、PDF、文件、Mermaid 和 KaTeX

## 目录结构

```text
ant-code/
  src/                         # 运行时源码
  tests/                       # 单元测试和集成测试
  scripts/                     # 校验、构建、审计和 mock gateway 脚本
  config/                      # 脱敏配置模板和内置 skills
  docs/                        # 架构、部署、安全、规格和 provenance 文档
  lab-agent.config.json         # 脱敏默认示例配置
```

不包含：

- `.lab-agent/` 本机会话、记忆、计划、任务、worktree 和 transcript
- `logs/`、`.tmp/`、`dist/`、`node_modules/`
- 私有网关配置或供应商凭据
- 模型生成输出或用户项目数据

## 环境要求

- Node.js 20+
- npm
- Windows 上的 PowerShell，或 Linux/macOS 上的 POSIX shell
- 真实模型调用需要用户自己控制的模型网关

测试和 mock gateway 不需要真实模型服务。

## 从源码安装

```sh
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

## Dashboard

启动本机 Dashboard：

```powershell
ant-code dashboard
```

Dashboard 绑定 `127.0.0.1`，默认端口是 `7410`，并拒绝非 loopback host。它复用
和 TUI 相同的本地运行时、权限引擎和 `.lab-agent/sessions` 会话存储。

常用参数：

```powershell
ant-code dashboard --port 7410
ant-code dashboard --no-open
ant-code dashboard --project .
```

## 给智能体的安装提示词

把下面这段提示词交给 AI 编程智能体，让它自己理解这个仓库：

```text
请把这个仓库内化为 Ant Code 本地编码智能体运行时。

仓库地址：https://github.com/wicm84266964/ant-code

请阅读 README.md、必要时阅读 README.zh-CN.md、docs/branding/public-identity.md、
docs/security/data-boundary.md、docs/deployment/local-installation.md 和 AGENT.md。
把 src/ 视为运行时源码，tests/ 视为可执行契约，config/ 视为脱敏模板和内置
skills，docs/ 视为架构、部署、安全和 provenance 上下文。

当你协助我维护这个项目时：
- 不要把密钥、网关 token、本机会话、transcript、日志、构建产物、node_modules
  或机器专属配置写入仓库。
- 公开名称保持 Ant Code；除非有明确迁移方案，否则保留协议、配置和本地状态路径
  里的 lab-agent 兼容名。
- 使用 npm ci 安装依赖，用 npm test 或聚焦的 node --test 命令做验证。
- 不需要真实模型的测试和演示优先使用 mock gateway。
- 发布相关工作前运行语法、依赖、provenance、安装校验和相关单元测试。
- 模型供应商凭据属于客户端外部的网关/适配器边界。
```

## 常用命令

```sh
npm run doctor
npm run check:syntax
npm run check:dependencies
npm run check:provenance
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
