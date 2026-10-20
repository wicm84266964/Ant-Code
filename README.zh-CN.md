# Ant Code 使用说明

Ant Code 是一个本地运行的编码智能体。工具调用在本机执行，模型请求发往你配置的网关。

## 版本

- 产品版本：`2.0.26`。运行 `ant-code --version` 应显示这个数字，与开源正式仓同一条语义版本线。
- 源码形态：本仓库从 JavaScript 改成 TypeScript，并把过大的模块拆开。1.4.1 的 TUI `/goal` 等产品能力仍在。
- 运行要求：Node.js **22.18 或更高**。CLI 入口是 `src/cli/index.ts`，由 Node 直接做类型擦除，**不必**先编译到 `dist`。
- 旧 JavaScript 源码（`src/cli/index.js`、Node 20）不能直接当这份代码跑。

2026-05-17 曾使用的内部版本 `3.0.0` 仅作为历史验收记录保留。当前 Dashboard 验收见 `docs\deployment\v1.3.0-dashboard-hardening-acceptance.md`。

## 全新安装（源码）

先确认 Node 版本：

```powershell
node -v
```

应不低于 `v22.18.0`。然后克隆仓库并进入根目录。将 `<repository-url>` 替换为实际开发仓库地址：

```powershell
git clone <repository-url> ant-code
cd ant-code
npm ci
npm run verify:install
node .\src\cli\index.ts doctor
```

需要本机 `ant-code` 命令指向这份源码时，在仓库根目录执行：

```powershell
npm link
ant-code --version
ant-code doctor
```

`where.exe ant-code` 应落到本仓库；全局入口应是 `src\cli\index.ts`。`ant-code --version` 应与当前 `package.json` 版本一致。

## 升级已有安装

在已经克隆的仓库根目录执行：

```powershell
git pull
npm ci
npm run verify:install
npm link
ant-code --version
```

只执行 `git pull` 不够：依赖和全局 `ant-code` 命令都要更新。以前做过 `npm link` 的，必须再 link 一次，否则命令可能仍指向旧目录。

要停在某一个发布标签，而不是最新 `main`：

```powershell
git fetch --tags
git checkout v2.0.26
npm ci
npm link
ant-code --version
```

把 `v2.0.26` 换成要安装的标签。

正在运行的 Dashboard 需要先退出，再重新执行 `ant-code dashboard`，然后刷新浏览器。已有网关配置、密钥和会话可以继续使用，不必重建。

## 从旧 JavaScript 源码更新

如果你以前安装的是 JavaScript 版（入口 `src/cli/index.js`，Node 20 也能跑）：

1. 把 Node 升到 22.18 或更高：`node -v`
2. 进入**这份**仓库根目录（不要更新到别的旧检出）
3. 拉代码并重装依赖
4. 做过 `npm link` 的，必须再 link 一次，否则全局命令可能仍指向已不存在的 `index.js`

```powershell
git pull
npm ci
npm run verify:install
npm link
ant-code --version
node .\src\cli\index.ts --version
```

两次 `--version` 都应是 `2.0.5`。只 `git pull` 不够：依赖、bin 入口和全局链接都要跟上。

会话、网关配置、`.lab-agent` 本地状态不用为这次语言改动重做。权限、TUI、Dashboard 交互与 2.0 产品语义一致（含 1.4.1 已有的 `/goal`）。

## Windows 免源码版

对外分发请使用这个目录：

```powershell
dist\ant-code-windows-x64\
```

目录里包含：

- `ant-code.exe`：主程序。
- `configure-gateway.ps1`：一键配置网关、模型和 token。
- `config\`：配置模板和内置 skills。
- `docs\`：部署、审计、网关协议和安全边界文档。

这个目录不包含 `src\`、`tests\`、`node_modules\`、交接文件或计划文件。

## 本地代码理解能力

源码安装默认带两类本地代码增强：

- `@vscode/ripgrep` 提供随包 `rg`，用于 `rg_search`、`rg_files`、`rg_files_with_matches` 和 `rg_count`。
- `typescript` 提供本进程 TypeScript language service，用于 `ts_symbols`、`ts_diagnostics`、`ts_find_definition` 和 `ts_find_references`。

它们都是固定版本的开源 npm 依赖，只在本机读取当前工作区文件，不上传源码、索引、诊断或搜索结果。原有基础 `grep` 继续保留，作为简单搜索和降级 fallback。

## 一键配置模型和网关

在 `dist\ant-code-windows-x64\` 目录打开 PowerShell，运行：

```powershell
.\configure-gateway.ps1
```

如果 PowerShell 执行策略拦截，可以运行：

```bat
configure-gateway.cmd
```

按提示输入：

- 网关协议：OpenAI Chat Completions 兼容网关填 `openai-chat`；Claude/Anthropic Messages 网关填 `anthropic-messages`。
- 网关 Chat URL：例如 `https://gateway.example.com/v1/chat/completions`。
- 健康检查 URL：可以留空。
- 网络模式：默认 `approved-web`，可以用 `web_search` 和已批准 host 的 `web_fetch`；严格内网模式填 `lab-only`。
- 模型名：例如 `mimo-v2.5`。
- 上下文 tokens 上限：不知道就先用默认值。
- 网关 token：输入时不会显示。

脚本会自动：

- 写入用户配置文件：`%USERPROFILE%\.ant-code\lab-agent.config.json`。
- 设置用户环境变量：`LAB_AGENT_CONFIG`。
- 设置用户环境变量：`LAB_MODEL_GATEWAY_API_KEY`。
- 把主智能体和子智能体都配置成同一个模型。
- 默认允许 `duckduckgo.com`、`html.duckduckgo.com`、`en.wikipedia.org`、`zh.wikipedia.org`、`bing.com`、`www.bing.com`、`github.com`、`raw.githubusercontent.com`、`api.github.com`、`r.jina.ai`。`web_search` 合并维基开放接口、Bing HTML 与 DuckDuckGo HTML。
- 运行 `ant-code doctor` 检查配置。

配置完成后，重新打开一个终端再运行：

```powershell
.\ant-code.exe doctor
.\ant-code.exe gateway --live
.\ant-code.exe -p "Reply exactly: ready"
```

## 启动方式

默认命令仍然启动 TUI：

```powershell
ant-code
```

无人值守 Goal 与 Dashboard 同一套元数据：

```text
/goal <目标>
/goal pause
/goal resume
/goal exit
/goal status
```

Goal 开启时权限锁定完全访问，Shift+Tab 不能改权限，需先 `/goal exit`。

WebUI Dashboard 使用独立入口：

```powershell
ant-code dashboard
```

Dashboard 第一版只支持本机访问，默认地址是 `http://127.0.0.1:7410`，启动后会自动打开浏览器。端口被占用时会自动向后寻找可用端口。常用参数：

```powershell
ant-code dashboard --port 7410
ant-code dashboard --no-open
ant-code dashboard --project .
```

Dashboard 不提供局域网分享，不允许绑定 `0.0.0.0`。它复用和 TUI 相同的 `.lab-agent\sessions` 会话历史、核心智能体运行时和本地权限引擎。界面为深灰色三栏工作台：左侧任务线程，中间折叠活动流和最终回复，右侧图片、文本、Markdown、代码、PDF 和文件卡片预览。左侧任务线程可以收起；会话条目会显示运行、等待、失败、完成等动态状态，存在运行中会话时会自动刷新。网页中也提供三层权限选择；需要确认的工具调用会在输入栏顶部弹出权限确认，需求核对会显示紧凑的可滚动选择面板。首次使用需要在网页中确认工作区信任；运行中发送新内容会进入队列，发送按钮会变成“运行中”并可点击中断，输入框有内容时可用“引导对话”把新要求交给当前任务，队列项内也可以对指定未开始任务执行“引导”。后台子智能体组会在输入栏上方以可折叠状态条显示，并标记 running/stale/lost/waiting 等快照状态，可从 Dashboard 发起取消；如果使用 `background=true` 和 `wakeParent=true`，Dashboard 会在子任务组完成后消费 wake prompt，父会话忙时排队、空闲时自动续跑，并在任务组记录中写入 `wakePromptConsumedAt`。关闭后重新打开 Dashboard 并进入历史会话时，浏览器仍分页显示历史，但模型上下文会优先从本地归档 transcript chunk 恢复完整上下文。清空上下文和压缩上下文都会先弹出确认。关闭 Dashboard 可以在网页左下角点击“关闭 Dashboard”并确认，也可以回到启动它的终端按 `Ctrl+C`。

Dashboard 底部会显示当前模型和文本/视觉/thinking 标签。点击模型区域的下拉按钮可以切换当前网关内已注册模型，也可以切换已保存的网关档案；打开本地模型配置入口后，可保存 URL、API key、模型 ID、显示名称、上下文窗口、主/子智能体模型和视觉子智能体。保存新 URL 或新 key 会创建/更新一个网关档案并设为当前活跃档案；同一网关不输入新 key 时会追加/更新该网关内模型。运行时仍只有一个网关档案生效，不会把 DeepSeek 和 MiMo 等不同网关混用。如果主模型是文本模型但当前网关内配置了视觉模型，图片任务会先由视觉子智能体生成视觉证据报告，再交给主模型继续处理。

长会话恢复和压缩现在把“模型上下文”和“界面显示”拆开处理：Dashboard/TUI 仍只渲染最近窗口或按页读取，避免浏览器/终端渲染过重；模型侧会在 resume 时优先恢复 `.lab-agent\sessions\<session-id>.model-context\chunk-*.json` 中的历史消息、assistant tool calls 和 tool results，受 `context.resumeMaxMessages`、`context.resumeMaxTokens`、`context.resumeMaxBytes` 限制。`.transcript` 分片只负责 UI/命令面板回看；旧会话没有 `model-context` 归档时才回退使用 `.transcript`。普通文件路径不会再被替换成 `[path]`，以免恢复后丢失用户复制的关键路径；Bearer token、API key、token、secret、password、credential、authorization 和邮箱仍会脱敏。OpenAI Chat Completions 兼容网关请求前还会修复历史里不完整的工具调用链，避免旧会话里缺失 tool result 的 assistant 消息继续触发 HTTP 400。

复杂任务可使用 planner 子智能体生成计划包。父会话先确认需求，再让 planner 产出 `requirements.md`、`task-plan.md`、`execution-checklist.md` 和 `manifest.json`；计划包保存在 `.lab-agent\plans\<plan-id>\`，方便长任务分阶段执行、复核和交接。

## 临时命令行配置

如果不想交互输入，也可以直接传参数：

```powershell
.\configure-gateway.ps1 `
  -GatewayUrl "https://gateway.example.com/v1/chat/completions" `
  -Model "my-model" `
  -ApiKey "your-gateway-token" `
  -Protocol "openai-chat" `
  -NetworkMode "approved-web"
```

如果只是测试生成 JSON、不想写入用户环境变量，可以加 `-NoEnvWrite`。

如果你的环境必须禁止公网搜索和抓取，把网络模式设为：

```powershell
.\configure-gateway.ps1 -NetworkMode "lab-only"
```

## 以后切换模型或网关

再次运行：

```powershell
.\configure-gateway.ps1
```

或者手动编辑：

```text
%USERPROFILE%\.ant-code\lab-agent.config.json
```

通常只需要改：

- `modelAlias`
- `models[0].id`
- `models[0].label`
- `models[].modalities`：至少包含 `text`；视觉模型再包含 `image`
- `lab.gatewayUrl`
- `lab.gatewayHealthUrl`
- `lab.activeGatewayProfile` / `lab.gatewayProfiles[]`：Dashboard 保存的可切换网关档案；每次运行只使用当前活跃档案。
- `agents.modelTiers.cheap/default/strong/vision`
- `agents.vision.model`：同一网关下的视觉模型 ID

如果 token 变了，重新运行脚本最省事。

## 注意

`LAB_MODEL_GATEWAY_API_KEY` 是网关访问 token，不建议写进 JSON 文件。JSON 里只放模型名、网关 URL、上下文上限这类非密钥配置。
