# MVP Product Spec

本文档定义 clean-room 新主仓库的第一版产品范围。它描述的是实验室自研代码助手的 MVP，而不是旧仓库功能复刻。

## Product Positioning

项目定位：

```text
Ant Code: 实验室自研、本地优先、通过实验室模型网关工作的代码智能体。
```

`ant-code` 是对外展示和用户入口名称；`lab-agent` 是 clean-room 实现阶段保留的内部代号，用于协议、配置、本地状态和审计兼容。

核心使用场景：

- 在本地代码仓库中理解、搜索、修改代码。
- 在用户确认后执行本地命令和测试。
- 通过实验室模型网关调用模型。
- 使用本地或实验室内网 MCP 服务扩展能力。
- 使用项目、用户、实验室三级记忆和规则。
- 支持子智能体完成隔离上下文任务。

MVP 不追求复刻 任何第三方云端体验。它优先保证科研数据安全、来源清白、可审计部署和本地代码能力。

## Target Users

- 实验室研究生、博士后、老师。
- 项目维护者和平台管理员。
- 处理未发表论文、实验数据、内部代码和高敏感科研材料的研发人员。

## Success Criteria

MVP 成功标准：

- 用户能在任意项目目录启动工具。
- 用户能完成常见代码任务：搜索、阅读、编辑、运行测试、查看 diff。
- 所有模型请求只经过实验室模型网关。
- 默认不访问 未由用户配置和批准的第三方云端周边服务。
- 文件和命令工具受权限系统约束。
- 编辑工具在写入前报告精确替换预检失败，避免空替换、误替换和无效替换次数直接落盘。
- 本地 transcript 可关闭、可限制保留、可脱敏。
- 插件、MCP、skills 只来自本地或实验室允许来源。
- 每个模块有 provenance 记录。

## MVP In Scope

### CLI and Session

- Interactive terminal session.
  - `ant-code` starts the interactive terminal by default.
  - `ant-code chat` remains an explicit interactive alias.
- Non-interactive print mode:
  - `ant-code -p "question"`
  - pipe input support.
- Interactive mode:
  - reuses one session and bounded conversation context across turns
  - sends a clean-room behavior protocol on every model turn
  - local per-tool approval prompts for ask-level write and command requests
  - process-local approval cache for matching requests in the active session
  - session-local todo and plan state for code-change workflow tracking
  - session-local recorded file changes and validation command history
  - redacted failed-validation context injected into follow-up model turns for repair loops
  - concise delivery status after model turns and in `/status` / `/report`
  - human-readable sectioned local command output with `/status --json` for machine-readable automation
  - grouped command help and approval prompts that name the local execution boundary
  - `/next` guidance and concrete validation suggestions for unfinished work
  - task lifecycle stages: `inspect`, `plan`, `edit`, `validate`, `repair`, `ready`
  - lightweight repository map for local project type, manifests, key directories, and likely source/test entrypoints
  - configurable context budget with automatic local compaction of older turns
  - local transcript resume by session id, unique id prefix, or `latest`, with UI display kept paged while model context prefers archived model-context chunks within configured resume budgets
  - `/clear` and `/compact` for local context management
- Project working directory detection.
- Session ID, session metadata, local transcript.
- Graceful interrupt and cancellation.
- Config loading from:
- project config
- user config
- lab managed config
- environment variables
- configurable context budget:
  - `models[].contextTokens` / `models[].maxContextTokens` / `models[].contextWindowTokens`
  - `context.maxTokens`
  - `context.maxMessages`
  - `context.maxBytes`
  - `context.keepRecentMessages`
  - `context.summaryBytes`
- High-sensitivity mode:
  - `security.sensitivity: "high"` or `LAB_AGENT_SENSITIVITY=high`
  - forces local metadata persistence off / zero-retention
  - permits only `offline` or `lab-only` network modes
  - adds stricter model behavior context for sensitive research data

### Model Gateway

- All model traffic goes through `LAB_MODEL_GATEWAY_URL`.
- Every model request includes Ant Code system context with behavior, safety, validation, and final-response rules.
- Gateway adapter supports:
  - chat messages
  - tool definitions
  - tool call responses
  - streaming text
  - usage metadata if provided
  - model selection by alias
  - non-sensitive compatibility metadata and redacted diagnostic hints for gateway failures
  - OpenAI Chat Completions compatible history repair before request conversion, so dangling assistant tool-call records from older local transcripts do not produce provider-side tool-chain validation errors
- The local client never stores provider API keys.

### Core Tools

MVP built-in tools:

- `read_file`
- `write_file`
- `edit_file`
- `list_files`
- `glob`
- `grep`
- `git_status`
- `git_diff`
- `bash`
- `powershell`
- `todo_read`
- `todo_write`
- `plan_update`
- `ask_user`

Optional but recommended for MVP:

- `notebook_read`
- `notebook_edit`

### Permission System

Permission checks before:

- file writes
- file edits
- command execution
- network access
- MCP tool calls
- workspace boundary expansion

Policy sources:

- lab policy
- project policy
- user policy
- session approvals

Default mode:

- read files inside workspace: allowed unless denied
- write files inside workspace: ask unless allowlisted
- commands: ask unless readonly allowlisted
- network: deny except lab endpoints
- secrets: deny read and scrub from subprocess env

### Local Memory

Memory layers:

- lab memory: managed and read-only to users
- user memory: local user preferences
- project memory: repository-specific instructions
- session memory: temporary notes for current session

MVP only needs local files. Cloud memory sync is out of scope.

Project memory is sent to the model only as bounded system context with workspace-relative labels. It is not written into session metadata.

### Slash Commands

MVP supports:

- built-in commands
- project commands
- user commands
- simple arguments
- file references
- validation command suggestions based on local project files and package scripts

Initial commands:

- `/help`
- `/status`
  - `/status --json` for machine-readable status
- `/model`
- `/config`
- `/permissions`
- `/files`
- `/map`
- `/diff`
- `/run`
- `/edit`
- `/review`
- `/verify`
- `/next`
- `/report`
- `/todo`
- `/plan`
- `/memory`
- `/clear`
- `/compact`
- `/resume`
- `/doctor`
- `/mcp`
- `/agents`
- `/gateway`
- `/sessions`

### Subagents

MVP subagents support:

- named agent profiles
- separate context window
- tool allowlist per agent
- read-only and write-capable modes
- structured result returned to parent session

No background cloud agents in MVP.

Initial implementation:

- `readonly-researcher` runs locally in the current process.
- It uses read-only workspace tools only.
- Write-capable subagents remain listed as profiles but are not executable in MVP until review.

### MCP

MVP supports:

- local stdio MCP servers
- HTTP/SSE MCP only for lab-approved hosts
- MCP resource listing
- MCP tool invocation through the same permission engine

MVP excludes:

- third-party managed MCP discovery
- official marketplace auto-install
- MCP proxy tied to provider OAuth

### Plugins and Skills

MVP supports:

- local skill directories
- lab-curated skill registry
- version-pinned plugin installation
- checksums for registry entries

MVP excludes:

- public marketplace discovery by default
- auto-update from arbitrary GitHub or URLs

### Diagnostics

MVP diagnostics:

- local debug log
- local crash report file
- `doctor` command with deployment readiness checks for Node, CLI bins, config sources, gateway URLs, allowed hosts, metadata retention/encryption, MCP servers, provenance, release audit material, and release candidate package material
- endpoint manifest
- config summary
- release candidate package with freeze criteria, evidence bundle, high-sensitivity requirements, distribution checklist, and rollback steps
- lab user quickstart for first run, gateway connection, daily workflow, sensitive-data mode, and rollback
- local installation readiness check and installation guide for checkout, linked CLI, PowerShell environment, startup checks, and troubleshooting
- model adapter readiness material clarifying that tools run locally while model traffic uses the lab gateway/model adapter boundary
- clean-room release attestation and release seal check for runtime source markers, package privacy, public identity, and boundary evidence
- release candidate acceptance summary and generated RC evidence summary for lab maintainer review

MVP excludes:

- Datadog
- GrowthBook / Statsig
- first-party telemetry
- transcript upload

### Local Memory and Session Retention

MVP memory updates are project-local:

- `/memory` lists loaded project memory files.
- `/memory add <text>` appends to `.lab-agent/memory.md`.
- `--readonly` blocks memory updates.

MVP session metadata retention is local:

- session metadata lives under `.lab-agent/sessions/`.
- turn metadata records bounded fields such as byte counts, status, model alias, tool names, and approval outcomes; it does not store raw prompts or assistant outputs.
- workflow metadata records todo, plan, change, and validation counts/status summaries only, not raw workflow text or command output.
- context metadata records estimated token counts, configured token budgets, byte counts, message counts, compaction counts, and summary token/byte counts; compacted summary text stays process-local.
- transcript archive chunks under `.lab-agent/sessions/<session-id>.transcript/` can store redacted visible conversation messages for local UI paging when transcript retention policy allows it.
- model-context archive chunks under `.lab-agent/sessions/<session-id>.model-context/` can store redacted model history, including assistant tool-call requests and matching local tool results, for resume when transcript retention policy allows it.
- Resume separates UI display from model context. The TUI and Dashboard keep visible history bounded or paged, while `ant-code --resume` and Dashboard session reopen prefer archived model-context chunks for model context restoration within `context.resumeMaxMessages`, `context.resumeMaxTokens`, and `context.resumeMaxBytes`; older sessions without model-context chunks fall back to transcript chunks.
- If resume restores full archived context, persisted compaction summary state is cleared before the next model turn to avoid sending duplicate "summary plus original history" context.
- Path-like values are preserved in local transcript/context redaction because they are task-critical. Secret-like values, Bearer tokens, API keys, token/secret/password/credential/authorization values, and emails remain redacted.
- failed validation excerpts are process-local, bounded, and redacted before follow-up model turns; raw commands and full output are excluded from session metadata.
- delivery status is derived from process-local workflow state and classifies the session as `blocked`, `needs_validation`, `verified`, `in_progress`, or `idle`.
- task lifecycle status is derived from process-local workflow state and classifies the current stage as `inspect`, `plan`, `edit`, `validate`, `repair`, or `ready`; a passing validation is stale when later recorded file changes exist.
- validation suggestions are derived from local manifests and package scripts for `/verify suggest`, `/verify run suggested`, `/next`, `/status`, and `/report`; they are not written into session metadata.
- repository maps are derived from local manifests and top-level directories for `/map`, `/status`, `/next`, and `/report`; raw source file contents are not read or persisted for this summary.
- behavior protocol and project memory are request context only; they are not persisted as prompt transcripts in bounded metadata.
- high-sensitivity mode forces transcript metadata disabled and retention `0` regardless of looser local defaults.
- `/sessions show <id|latest>` reads bounded metadata; encrypted metadata requires local key material.
- Inside the TUI, `/sessions` is the visual restore/switch entry for saved sessions.
- `ant-code --resume latest` remains a startup option for loading local metadata and restoring model context from archived model-context chunks when available.
- Inside the TUI, `/resume` is reserved for viewing the current session's archived 50-message transcript chunks; it does not switch sessions.
- `LAB_AGENT_TRANSCRIPT_ENABLED=false` disables future transcript persistence behavior.
- `LAB_AGENT_TRANSCRIPT_RETENTION_DAYS=0` skips new local session metadata writes and cleanup removes existing local session metadata.
- `LAB_AGENT_TRANSCRIPT_ENCRYPTION=optional|required` controls local session metadata encryption when `LAB_AGENT_TRANSCRIPT_KEY` is supplied.
- `/sessions cleanup` applies the configured retention policy.

## Out of Scope for MVP

- third-party cloud account login.
- third-party remote control.
- provider-hosted remote sessions.
- provider-hosted scheduled agents.
- third-party managed connectors.
- Official marketplace auto-install.
- Chrome extension.
- Desktop handoff.
- Voice mode.
- Billing / extra usage screens.
- Auto-update from public channels.
- Any direct use of `private provider-specific coding-agent endpoints`.

## User Workflows

### Workflow 1: Code Change

1. User starts `ant-code` in a project directory.
2. Agent reads project memory and config.
3. User asks for a change.
4. Agent searches and reads relevant files.
5. Agent proposes or applies edits.
6. Permission engine asks before writes if running interactively, or requires explicit print-mode approval flags.
7. Exact-replacement edits run a preflight first; ambiguous, missing, no-op, or invalid replacements fail before writing, and dry-run mode can preview the bounded diff.
8. Agent checks local git status/diff and runs tests after command approval.
9. If validation fails, the next turn receives a bounded redacted failure summary so the agent can inspect, repair, and rerun.
10. Interactive output, `/status`, and `/next` show whether the work is inspecting, planning, editing, validating, repairing, or ready and suggest a concrete validation command when available.
11. Agent summarizes files changed and verification.

### Workflow 2: Read-only Analysis

1. User starts `ant-code --readonly`.
2. Agent can search and read files.
3. Write tools and shell mutation are denied.
4. Agent returns explanation or plan.

### Workflow 3: Sensitive Project

1. Project policy sets network mode to `lab-only` or `offline`.
2. Transcript retention is disabled or encrypted.
3. Only lab model gateway is reachable.
4. MCP servers must be local or lab-approved.

### Workflow 4: Subagent Research

1. User asks for codebase investigation.
2. Parent session spawns read-only subagent.
3. Subagent searches independently.
4. Subagent returns concise findings.
5. Parent decides whether to edit.

## MVP Acceptance Tests

- Can start in an arbitrary project directory.
- Can answer a question about local files using `read_file` and `grep`.
- Can edit a file after permission approval.
- Can refuse a write outside workspace.
- Can run a readonly command without extra approval if allowlisted.
- Can ask approval for a mutating command.
- Can block a command containing a denied pattern.
- Can connect to a local stdio MCP server.
- Can load project memory.
- Can call lab model gateway without direct provider keys.
- Can run with network mode `offline`.
- CI fails if forbidden cloud endpoints appear in runtime code.
