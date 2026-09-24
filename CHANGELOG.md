# Changelog

## Unreleased

## 2.0.19 - 2026-09-24

Published 2026-09-24: [v2.0.19](https://github.com/wicm84266964/Ant-Code/releases/tag/v2.0.19).

Parent sessions receive each child's complete final handoff report. Guide takeover keeps thinking drafts labeled as steered. Failed write receipts no longer claim the file was edited.

## 2.0.18 - 2026-09-22

Published 2026-09-22: [v2.0.18](https://github.com/wicm84266964/Ant-Code/releases/tag/v2.0.18).

Long-session prompt budget rebuilds the next gateway request as a handoff summary plus a token-capped tail, including the current-turn tool chain. Subagents reuse the same gate. Thinking-only empty replies after compaction retry. Guide takeover shows as steered rather than interrupted.

## 2.0.17 - 2026-09-21

Published 2026-09-21: [v2.0.17](https://github.com/wicm84266964/Ant-Code/releases/tag/v2.0.17).

Dashboard keeps failed and interrupted drafts in the conversation, including after refresh. Completed turns keep the thinking-process fold. Interrupted subagents store completed tool calls and visible drafts in the task record for later lookup, without auto-waking the parent.

## 2.0.16 - 2026-09-18

Published 2026-09-18: [v2.0.16](https://github.com/wicm84266964/Ant-Code/releases/tag/v2.0.16).

Dashboard session search, cheap-model titles, and observational vision/thinking probes. Leftover project agent routes no longer block startup. Settings uses the saved API key for probes and a 64×64 image instead of a 1×1 PNG.

## 2.0.15 - 2026-09-18

Published 2026-09-18: [v2.0.15](https://github.com/wicm84266964/Ant-Code/releases/tag/v2.0.15).

修复内置 HTTPS 代理在 TLS 握手断开时可能导致 Dashboard 进程退出的问题。现将网络错误返回给当前请求，并在 socket 关闭前持续处理错误事件。

升级后重启 Dashboard；现有配置和 session 可继续使用。


## 2.0.14 - 2026-09-14

Published 2026-09-14 14:52:10 UTC (2026-09-14 22:52:10 UTC+08:00): [v2.0.14](https://github.com/wicm84266964/Ant-Code/releases/tag/v2.0.14).
Release commit: `8ca6ff4545f964ebc64dd1723e2ce2fce6824751`. PR #58 and main CI passed; local release verification passed 1,358 unit/integration tests and 38 browser tests, with no failures or skips. Cross-repository parity verified 10 exact paths and 12 reviewed differences.

This is a small Responses-search and Dashboard layout release on the 2.0 TypeScript runtime.
Hosted `web_search_call` events from a Responses gateway no longer abort the turn. Todo and plan stay in the header strip instead of duplicating into the chat. The settings gear is rotationally symmetric. Permission mode ids are unchanged.

### Fixed

- Responses hosted search no longer fails the turn as a protocol mismatch. Local function calls and visible text still run.
- Dashboard todo/plan live only in the top progress strip. Chat no longer inserts a second workflow panel or “任务状态已同步” cards.
- The settings gear icon is an eight-tooth symmetric mark.

### Upgrade

```sh
git pull
npm ci
npm run verify:install
npm link
ant-code --version
```

`ant-code --version` should print `2.0.14`. Restart a running Dashboard
and hard-refresh the browser. Gateway config and `.lab-agent` sessions
do not need to be recreated.

## 2.0.13 - 2026-09-14

Published 2026-09-14 13:40:52 UTC (2026-09-14 21:40:52 UTC+08:00): [v2.0.13](https://github.com/wicm84266964/Ant-Code/releases/tag/v2.0.13).
Release commit: `60b6154174523a6653579feff88a458e54dfef6e`. PR #56 and main CI passed; local release verification passed 1,356 unit/integration tests and 38 browser tests, with no failures or skips. Cross-repository parity verified 34 exact paths and 12 reviewed differences.

This is a small Dashboard artifact, credential, and session-guard release on the 2.0 TypeScript runtime.
Generated plots and reports can appear in the right pane without a manual open. Same-URL credentials are chosen automatically so chat is not blocked before send. Empty-body diagnostics stay in the UI, not the next model prompt. A one-line tool promise with no tool call is retried once with a new gateway session binding. Permission mode ids are unchanged.

### Added

- Dashboard lists script-generated previewable files and opens the latest exhibit automatically.
- Optional `gatewaySessionAffinity` is persisted so a session can rebind the gateway conversation without changing the local session id.

### Fixed

- Multiple keys on one gateway URL no longer block chat until a settings click. HTTP 401/403 then asks the user to inspect or switch the active credential.
- Empty-visible-text diagnostics are no longer written into model context.
- A short “I will call this tool now” stop with no tool call is retried once after rotating gateway session affinity.
- Unsolicited Responses `web_search_call` events fail as a protocol mismatch instead of a silent completion.
- Dashboard event-stream disconnects show unknown task status instead of implying the turn finished.

### Upgrade

```sh
git pull
npm ci
npm run verify:install
npm link
ant-code --version
```

`ant-code --version` should print `2.0.13`. Restart a running Dashboard
and hard-refresh the browser. Gateway config and `.lab-agent` sessions
do not need to be recreated.

## 2.0.12 - 2026-09-14

Published 2026-09-14 02:04:48 UTC (2026-09-14 10:04:48 UTC+08:00): [v2.0.12](https://github.com/wicm84266964/Ant-Code/releases/tag/v2.0.12).
Release commit: `27cdb0d2922987985b6b5b4115193829e3cc7ae9`. PR #54 and main CI passed; local release verification passed 1,342 unit/integration tests and 38 browser tests, with no failures or skips. Additional process tests passed; cross-repository parity verified 36 exact paths and 16 reviewed differences.

This is a small Dashboard interaction and send-stability release on the 2.0 TypeScript runtime.
A successful send no longer rewrites the current session or draft after the user has switched away. Session retention no longer blocks first paint or a new send. Long session resume reads the archive tail. Permission mode ids are unchanged.

### Fixed

- Late `/api/turns` responses no longer replace the last selected session or clear a draft written while waiting.
- While a turn is running, the main button queues when the composer has text or attachments, and interrupts only when empty.
- Session retention cleanup no longer blocks Dashboard first paint or a new-task send.
- Long session resume no longer hits the 15-second request timeout before the gateway is called. Turn start waits up to 60 seconds.
- TUI approval Tab/Shift+Tab stay inside the panel. Gateway 429 responses honor `Retry-After` up to 30 seconds.

### Upgrade

```sh
git pull
npm ci
npm run verify:install
npm link
ant-code --version
```

`ant-code --version` should print `2.0.12`. Restart a running Dashboard
and hard-refresh the browser. Gateway config and `.lab-agent` sessions
do not need to be recreated.

## 2.0.11 - 2026-09-10

Published 2026-09-10 09:14:36 UTC (2026-09-10 17:14:36 UTC+08:00): [v2.0.11](https://github.com/wicm84266964/Ant-Code/releases/tag/v2.0.11).
Release commit: `474930e346a48f0ea919f0aaa1839498b067efc9`. PR #51 and main CI passed; local release verification passed 1,331 unit/integration tests and 38 browser tests, with no failures or skips. Additional process tests passed; cross-repository parity verified 27 exact paths and 13 reviewed differences.

This is a small Dashboard document and background-task release on the 2.0 TypeScript runtime.
Composer PDFs with a text layer are answered from extracted text. Scanned PDFs render the first few full pages for vision and cite those pages. Full visual reading is explicit. Background subagent groups merge wakeup settings so a later disable cannot cancel an existing wakeup. Permission mode ids are unchanged.

### Added

- Scanned paperclip PDFs render the first two full pages (text, vectors, and embedded images) for vision. Text-layer PDFs stay on extracted text.
- PDF chips accept optional start and end pages. Empty fields use the default window; filling both pages is the explicit full visual read.
- PNG pastes without a MIME type are classified by file extension.

### Fixed

- Joining a background subagent group merges `wakeParent` with OR and `waitForGroup` as all > any > none, so dispatch order cannot disable an existing wakeup.
- Sparse PDF text detection no longer counts synthetic page headings as body text.

### Upgrade

```sh
git pull
npm ci
npm run verify:install
npm link
ant-code --version
```

`ant-code --version` should print `2.0.11`. Restart a running Dashboard
and hard-refresh the browser. Gateway config and `.lab-agent` sessions
do not need to be recreated. Windows exe distributions now include
`@napi-rs/canvas` and the Windows x64 native binary; do not copy only
the exe.

## 2.0.10 - 2026-09-10

Published 2026-09-10 03:38:31 UTC (2026-09-10 11:38:31 UTC+08:00): [v2.0.10](https://github.com/wicm84266964/Ant-Code/releases/tag/v2.0.10).
Release commit: `e51b203038a44d72575c99d0bf87a9ab98a7c8eb`. PR #49 and main CI passed; local release verification passed 1,312 unit/integration tests and 37 browser tests, with no failures or skips. Additional process tests passed; cross-repository parity verified 23 exact paths and 6 reviewed differences.

This is a small context-window release on the 2.0 TypeScript runtime.
After the full request reaches its configured budget, older tool results are summarized in bounded model batches instead of a fixed character clip. Tool summaries are distinct from conversation compaction. Permission mode ids are unchanged.

### Added

- Bounded model-batch summaries of older tool results, targeting a 10-20% context reserve.
- `tool_result_read` retrieves pre-summary tool text through a session-scoped evidence reference.

### Fixed

- Tool summaries no longer insert conversation compaction boundaries in Dashboard and TUI.
- Original tool text is kept when a summary fails, is cancelled, or does not save enough space.
- Config replacement retries transient file sharing on Windows.

### Upgrade

```sh
git pull
npm ci
npm run verify:install
npm link
ant-code --version
```

`ant-code --version` should print `2.0.10`. Restart a running Dashboard
and hard-refresh the browser. Gateway config and `.lab-agent` sessions
do not need to be recreated.

## 2.0.9 - 2026-09-10

Published 2026-09-09 17:37:09 UTC (2026-09-10 01:37:09 UTC+08:00): [v2.0.9](https://github.com/wicm84266964/Ant-Code/releases/tag/v2.0.9).
Release commit: `3f1a49b736c1f6ec1fbeba2d7854553382865f64`. PR and main CI passed; local release verification passed 1,304 unit/integration tests and 37 browser tests, with no failures or skips.

This is a small reliability and Dashboard model-source release on the 2.0 TypeScript runtime.
Tool evidence stays until the full request reaches its context budget. Dashboard groups models by source URL and selects one active credential per source. Permission mode ids are unchanged.

### Added

- Continuous file excerpts with original line numbers, plus byte-budgeted search and directory pagination.
- Dashboard model picker groups connections by source URL. New same-source duplicate models require a remark.
- Per-source active credential selection, saved as `lab.sourceCredentialSelections`.

### Fixed

- Tool results are no longer stubbed before the complete request reaches its context budget.
- Permission confirmation stays on screen and queues instead of being clipped by the composer.
- Windows storage lock release retries transient sharing violations.

### Upgrade

```sh
git pull
npm ci
npm run verify:install
npm link
ant-code --version
```

`ant-code --version` should print `2.0.9`. Restart a running Dashboard
and hard-refresh the browser. Gateway config and `.lab-agent` sessions
do not need to be recreated.

## 2.0.8 - 2026-09-06

This is a small Dashboard workflow release on the 2.0 TypeScript runtime.
The paperclip can attach PDF, docx, xlsx, pptx, and common text files.
Documents are saved under `ant-code-uploads/` with a bounded preview for
the model. The right pane can preview those files, and Open launches the
workspace copy with the system app. Permission mode ids are unchanged.

### Added

- Dashboard paperclip accepts PDF / Office Open XML / text documents in
  addition to images. Documents are stored in `ant-code-uploads/` and
  ingested through `document_intake`.
- PDF text-layer extraction via `unpdf`. Scanned PDFs are not OCR'd;
  composer-attached PDFs with no text layer send a few page images to
  the configured vision model.
- Right-pane preview for PDF, extracted Office text/tables, and
  clickable attachment chips after refresh.
- Open uses the OS file association on the workspace copy.
- `ant-code-uploads/` is added to the project `.gitignore` on send.

### Upgrade

```sh
git pull
npm ci
npm run verify:install
npm link
ant-code --version
```

`ant-code --version` should print `2.0.8`. Restart a running Dashboard
and hard-refresh the browser. Gateway config and `.lab-agent` sessions
do not need to be recreated.

## 2.0.7 - 2026-09-05

This is a dependency security patch on the 2.0 TypeScript runtime.
Dashboard Mermaid is updated to `11.17.2` with DOMPurify `3.4.14`.
The TUI `ink` stack now uses `ws` `8.21.3`. The Dashboard asset bundler
`esbuild` is `0.28.2`. Permission mode ids, search, and tool behavior are
unchanged.

### Fixed

- Mermaid `11.17.2` and DOMPurify `3.4.14` close the stacked Dashboard
  diagram/sanitizer advisories.
- `ws` `8.21.3` closes the high-severity WebSocket memory-exhaustion issue
  pulled in by `ink`.
- `esbuild` `0.28.2` closes the Windows development-server advisory. This
  package is not on the user runtime path.

### Upgrade

```sh
git pull
npm ci
npm run verify:install
npm link
ant-code --version
```

`ant-code --version` should print `2.0.7`. Restart a running Dashboard so it
loads the rebuilt local Mermaid bundle. Gateway config and `.lab-agent`
sessions do not need to be recreated.

## 2.0.6 - 2026-09-05

This is a small reliability release on the 2.0 TypeScript runtime.
`web_search` now queries Wikipedia's open MediaWiki API, then Bing HTML, then
DuckDuckGo HTML. Wikipedia is encyclopedia-only; Bing is the no-key web
fallback when Wikipedia is unreachable. Bundled ripgrep is used for `rg_*`
tools so Windows no longer depends on a system `rg`. Array tool results such as
`skill_list` keep their payloads in the model-facing short view. Permission
mode ids are unchanged.

### Fixed

- `web_search` merges Wikipedia, Bing HTML, and DuckDuckGo HTML (optional
  SearXNG still works). Wikipedia requests are capped at about eight seconds.
- `rg_search`, `rg_files`, and `rg_count` prefer the bundled ripgrep binary.
- `skill_list`, `todo_read`, `mcp_list`, and `rg_count` short views no longer
  collapse arrays to `{}`.

### Upgrade

```sh
git pull
npm ci
npm run verify:install
npm link
ant-code --version
```

`ant-code --version` should print `2.0.6`. Restart a running Dashboard so it
loads this runtime. Gateway config and `.lab-agent` sessions do not need to
be recreated.

## 2.0.5 - 2026-09-04

This is a small reliability release on the 2.0 TypeScript runtime. Tool
results sent to the model are now per-tool short views instead of pretty-printed
JSON. Older current-turn tool results beyond the most recent four are stubbed
without waiting for the context window to fill. User images and tool screenshots
are registered as in-session visual evidence: the main model can still see the
picture on the first round, then later requests keep evidence ids instead of
replaying pixels. `visual-verifier` can continue from those ids. Permission
mode ids are unchanged.

### Fixed

- Model-facing tool output uses bounded views: numbered file excerpts, limited
  search matches, head/tail shell output, and write results without a full diff.
  32KB remains the hard safety valve.
- Current-turn tool results older than the last four are replaced with a
  one-line stub on the next gateway request.
- After the first gateway round that uses tools, live image pixels are dropped
  from the main context. MCP images are recorded as evidence ids, not base64 in
  tool JSON.
- `agent_run` can pass `evidenceIds` to `visual-verifier`; pending evidence is
  attached when ids are omitted.
- TUI and Dashboard context usage prefer the live prompt estimate that will be
  sent to the gateway.

### Upgrade

```sh
git pull
npm ci
npm run verify:install
npm link
ant-code --version
```

`ant-code --version` should print `2.0.5`. Restart a running Dashboard so it
loads this runtime. Gateway config and `.lab-agent` sessions do not need to
be recreated.

## 2.0.4 - 2026-09-02

This is a small reliability release on the 2.0 TypeScript runtime. Automatic
compaction waits until the configured context window is full. Later gateway
rounds compact in-flight tool results first, then history if still over. If
the prompt remains over budget after both, the turn is cancelled locally as
`context_overflow` instead of sending a request that would likely return HTTP
400. Dashboard Goal text stays inside the status bar, and the composer
placeholder is no longer replaced by the Goal prompt. Permission mode ids are
unchanged.

### Fixed

- In-flight tool compaction defaults to 100% of the configured window, the
  same as history compaction. An explicit ratio of `1` is accepted.
- After tools land, later rounds compact those results before summarizing
  history. If the prompt is still over the window, Ant Code does not send
  the gateway request.
- Dashboard Goal status text no longer stretches the status bar. Completed,
  failed, and budget-paused goals stay on one ellipsis line; in-progress goals
  clamp to three lines. The composer placeholder keeps the original task hint.

### Upgrade

```sh
git pull
npm ci
npm run verify:install
npm link
ant-code --version
```

`ant-code --version` should print `2.0.4`. Restart a running Dashboard so it
loads this runtime. Gateway config and `.lab-agent` sessions do not need to
be recreated.

## 2.0.3 - 2026-09-02

This is a small reliability release on the 2.0 TypeScript runtime. Image
attachments no longer inflate the local prompt estimate into a false
compaction that drops the current picture. Switching to a larger-window
model raises the local context budget. An interrupted sibling subagent no
longer marks the whole parent turn interrupted. Permission mode ids are
unchanged.

### Fixed

- Prompt-budget estimates no longer treat image base64 as text tokens. After
  history compaction, the current turn's image or vision report is still sent
  to the model. If the first-round compact already brings the prompt under
  the threshold, in-flight tool compaction is not forced.
- Switching to a model with a larger advertised window raises local
  `context.maxTokens` / `maxBytes` to at least that window. A smaller model
  still caps the effective window.
- A single interrupted parallel readonly subagent no longer finishes the
  parent turn as `interrupted`. MCP timeouts are `MCP_REQUEST_TIMEOUT`
  failures, not user interrupts. An explicit stop still aborts the turn.

### Upgrade

```sh
git pull
npm ci
npm run verify:install
npm link
ant-code --version
```

`ant-code --version` should print `2.0.3`. Restart a running Dashboard so it
loads this runtime. Gateway config and `.lab-agent` sessions do not need to
be recreated.

## 2.0.2 - 2026-09-01

This is a small reliability release on the 2.0 TypeScript runtime. Dashboard
recycle of lost background subagents no longer requires a live in-process
controller. Parent tool results are capped so a broad scan cannot inflate the
next gateway request into an upstream HTTP 400. Permission mode ids are
unchanged.

### Fixed

- Dashboard recycle of lost background subagents now marks those tasks
  `interrupted` even when the current process has no live controller. A group
  recycle chip cancels every child in the group. Child agents that throw after
  heartbeat stops persist `failed` or `interrupted` instead of remaining
  `running` on disk.
- Parent tool results sent to the model are capped at 32KB. Later gateway
  rounds compact oversized in-flight tool output, not only older session
  messages. `glob`/`grep` default to 200 matches and `list_files` defaults to
  200 entries so a broad scan cannot inflate the next request into an upstream
  HTTP 400. Pass a higher `maxMatches` or `maxEntries` when a larger bounded
  slice is required.

### Upgrade

```sh
git pull
npm ci
npm run verify:install
npm link
ant-code --version
```

`ant-code --version` should print `2.0.2`. Gateway config and `.lab-agent`
sessions do not need to be recreated.

## 2.0.1 - 2026-08-31

This is a small release on the 2.0 TypeScript runtime. Default TUI and
Dashboard chrome are gold-on-black, transcript drag-select copies chat text
only, and search plus Windows terminal fixes are included. Permission mode
ids are unchanged.

### Changed

- TUI default theme is `gold-black`. `LAB_AGENT_TUI_THEME=sky-blue` still
  selects the older sky-blue theme.
- Transcript drag-select copies chat lines from the session pane. It does not
  copy pane borders or the right sidebar. Click still selects a block; double
  click still opens the excerpt panel.
- Dashboard chrome matches the same gold-on-black direction. Goal sits next to
  the permission radios. Context status shows cache-hit rate instead of the
  latest input token count.
- `web_search` uses built-in DuckDuckGo HTML. The `duckduckgo-search` MCP is
  disabled by default because public search often times out. `fetch` MCP is
  unchanged for `web_fetch`. A self-hosted SearXNG remains the stable no-key
  search backend when configured.
- User-facing copy no longer describes the current product as a clean-room MVP.

### Fixed

- Windows `background_shell` stays attached so a long-running task remains
  visible after launch returns. Cancellable background tasks can be reclaimed
  from the Dashboard live chips.
- `grep` on a single file no longer misses matches.
- Windows bash launched through WSL converts the workspace to `/mnt/<drive>/...`
  instead of passing a Windows path.

### Upgrade

```sh
git pull
npm ci
npm run verify:install
npm link
ant-code --version
```

`ant-code --version` should print `2.0.1`. Gateway config and `.lab-agent`
sessions do not need to be recreated.

## 2.0.0 - 2026-08-30

This is a runtime-generation release. TUI, Dashboard, permissions, Goal, tools,
and gateway behavior stay on the 1.4.1 product line. The source language and
module layout changed.

### Changed

- The runtime is TypeScript. Node.js 22.18+ runs `src/cli/index.ts` directly
  with type stripping. There is no compile-to-`dist` step for the CLI.
- Oversized modules were split behind the same public facades:
  `createDashboardRuntime`, `runTui`, session exports, and config exports.
  Dashboard still ships `public/app.js`. Permission radiogroup ids are unchanged.
- JavaScript 1.x checkouts (`src/cli/index.js`, Node 20) cannot run this tree.
  Upgrade Node, run `npm ci`, and re-run `npm link` so the global command points
  at `index.ts`. `git pull` alone is not enough.

### Added

- TUI `/goal` uses the same unattended Goal loop as the Dashboard: enable with
  an objective, lock full access, skip `ask_user`, and host-continue until the
  goal completes, pauses, fails, or hits the auto-continue budget.
- `/goal pause | resume | exit | status`. Shift+Tab does not clear Goal;
  permission stays locked until `/goal exit`.
- Goal completion recap on the Dashboard status bar and TUI footer: elapsed
  time, continue count, model rounds, and 输入/输出 tokens for the Goal interval.

### Fixed

- `/goal` on a brand-new TUI session no longer crashes when session metadata
  does not exist yet.
- TUI `/sessions` restore no longer throws on `null.choices`.
- Missing transcript archive chunks no longer fail the entire session resume.

### Upgrade

```sh
git pull
npm ci
npm run verify:install
npm link
ant-code --version
```

`ant-code --version` should print `2.0.0`. Gateway config and `.lab-agent`
sessions do not need to be recreated.

## 1.4.1 - 2026-08-29

### Added

- TUI `/goal` uses the same unattended Goal loop as the Dashboard: enable with
  an objective, lock full access, skip `ask_user`, and host-continue until the
  goal completes, pauses, fails, or hits the auto-continue budget.
- Goal completion recap on the Dashboard status bar and TUI footer: elapsed
  time, continue count, model rounds, and prompt/completion tokens for the Goal
  interval (`输入` / `输出`).

### Changed

- Shift+Tab no longer clears Goal. Permission stays locked until `/goal exit`.
- Token recap wording uses 输入/输出 instead of the abbreviated 入/出.

### Fixed

- `/goal` on a brand-new TUI session no longer crashes when session metadata
  does not exist yet. Goal now bootstraps a session file so it can be resumed.
- TUI `/sessions` restore no longer throws `Cannot read properties of null
  (reading 'choices')` when clearing an empty question draft.
- Missing transcript archive chunks no longer fail the entire session resume.

## 1.4.0 - 2026-08-29

### Added

- Dashboard Goal mode: an unattended full-access loop beside the permission
  control. Enable it with a confirmation and a required objective. The host
  continues finished turns until the goal is done, paused, failed, or the
  auto-continue budget is reached. Goal is not a fourth permission mode.
- Dashboard Settings can change the Goal auto-continue cap (default 12,
  range 1–100) under Agents.
- Config V2 model settings: durable provider identity, credential refs,
  catalog-backed reasoning efforts, and provider-local subagent routing.
- OpenAI Responses gateway adapter, including streaming and tool calls.
- Isolated credential store so gateway keys are not written into settings
  files.
- Automatic model capability discovery for reasoning efforts.

### Changed

- Session list status is a color dot only; the chat header keeps the
  idle/running pill.
- The chat header local identity and connection lamp are one control:
  "本地网关已连接" when the Dashboard event stream is live.

### Fixed

- Goal enable starts the first turn instead of only showing "in progress".
- Exiting Goal restores the previous permission mode even if a turn is
  still running.

## 1.3.7 - 2026-08-25

### Fixed

- Manual Dashboard context compaction no longer inherits the 15-second
  frontend timeout used by ordinary API requests. The browser now waits for
  the server-bounded model compaction to finish, avoiding a timeout error after
  compaction succeeds. Other Dashboard requests retain their existing timeout.

## 1.3.6 - 2026-08-22

### Fixed

- Deleting the final inherited global gateway in a project now remains deleted
  after Dashboard refresh and restart instead of restoring the global profiles.
- Unconfigured gateways now default to OpenAI Chat Completions. The Dashboard
  exposes the two common provider protocols: OpenAI Chat Completions and
  Anthropic Messages for Claude. The legacy private gateway protocol remains
  available only for existing configurations.

### Added

- Anthropic Messages request, authentication, JSON response, streaming SSE,
  image, and local tool-call adaptation.

## 1.3.5 - 2026-08-13

### Fixed

- A saved global gateway API key now remains effective when a project has a
  stale empty credential for the same protocol and URL. Switching that profile
  removes the empty project override without copying the secret into the
  project file, while different endpoints and intentional no-key profiles stay
  isolated.
- Same-endpoint profiles inherit their saved global credential even when an
  older profile omits its model list, so profile switching and real requests
  agree with the Dashboard's configured-key status.
- The Dashboard model configuration dialog now defaults its save scope to the
  current gateway source instead of always selecting the global user config.

## 1.3.4 - 2026-08-08

### Fixed

- Bundled example models are no longer exposed as runtime defaults for new or
  unconfigured installations.
- Gateway API keys are scoped to their matching gateway profile, preventing a
  stale project or environment key from leaking into a newly configured URL.
- Environment and user-level gateway keys are no longer copied into project
  gateway profiles, and explicit no-key profiles remain isolated after profile
  switches and model deletion.
- Clearing an optional gateway health URL now removes the stale value, while
  switching older profiles without agent routing clears previous-provider
  subagent model assignments.
- An explicitly empty model list is now preserved, so deleting the final model
  does not restore bundled examples.
- Deleting the active model or gateway now leaves Ant Code unconfigured instead
  of silently falling back to an older gateway profile.
- Deleting a gateway removes its no-longer-used Dashboard-managed hosts, and
  local context budgets are capped by the configured model context window.
- Environment keys without a matching environment gateway URL are no longer
  inherited by project gateways. Editing a gateway now collapses duplicate
  endpoint profiles while preserving custom profile IDs, and clearing a health
  URL removes its unused host from the Dashboard-managed allowlist.
- The Dashboard now exposes project and global model-config save scopes, uses
  the global user config when no scope is supplied, and reports which scope was
  updated after saving.
- Gateway retries remain the primary live status even while background work is
  active, and the final failure replaces the retry status instead of creating a
  disconnected activity entry.
- `rg_files` is classified as a directory-scoped file-list operation by the
  delegation guard instead of being treated as a glob search.
- TUI shell and slash commands now receive the active turn cancellation signal,
  so interrupting a turn also stops command work launched from that turn.
- Aborting an MCP tool request now sends the protocol cancellation notification
  before the local call settles as interrupted.
- Interrupted and failed gateway drafts now enter the model-context archive as
  explicitly marked non-final messages, keeping full-history resume consistent
  with the visible transcript.
- Global and project model catalogs now merge when they refer to the same
  gateway protocol and URL. A globally added model therefore remains available
  after switching back to a project-default model, while different gateway
  endpoints remain isolated.

### Added

- Gateway profiles can now be deleted from the Dashboard.

## 1.3.3 - 2026-07-25

### Fixed

- Windows background terminal workers are now tracked by their exact runtime
  process handles, so cancellation and external-exit reconciliation no longer
  depend on slow or restricted system-wide process enumeration.
- Verified Windows terminal cancellation now falls back to terminating the
  owned root process when process-tree control is unavailable, while recovered
  persisted tasks continue to require creation-identity checks before a PID can
  be terminated.

### Validation

- `node --test tests/unit/background-terminal-registry-safety.test.js`
- `node --test tests/unit/tools.test.js` (88 tests)

## 1.3.2 - 2026-07-17

### Fixed

- Session archives, metadata, memory records, and task registries now use
  durable atomic updates with cross-process coordination and crash recovery,
  preventing lost updates and partial files under concurrent writers.
- Encrypted session migration now serializes competing readers and writers so
  migration cannot publish stale data or temporarily fall back to plaintext.
- Background terminal state now reconciles externally terminated processes and
  writes its registry atomically, keeping list and cancellation results
  accurate after crashes or interrupted cleanup.
- Gateway callbacks now have bounded execution and consistent timeout/error
  convergence, while buffered and streaming responses enforce explicit size
  limits before unbounded data can accumulate.
- MCP connections now deduplicate concurrent startup, recover cleanly from
  failed handshakes, and reject oversized protocol frames.

### Validation

- Added cross-process crash-recovery, storage concurrency, property-sequence,
  background-terminal safety, oversized-frame, and reliability soak coverage.
## 1.3.1 - 2026-07-16

### Fixed

- Windows Dashboard file previews now compare only file identity fields that
  are available from both the open handle and path stat. This keeps the
  symlink/junction boundary check while avoiding false 409 responses when
  Windows reports a non-zero device only for the open handle.
- Dashboard browser coverage now waits for both the resize separator state and
  the rendered file-panel geometry, removing a race that could report 480px
  while the persisted 600px layout was still settling.
- Dashboard API requests now have bounded timeouts and preserve caller
  cancellation, so refresh, file preview, and turn interruption cannot remain
  pending forever during an event-stream reconnect.
- Dashboard shutdown activity checks can be cancelled and recover from a
  timeout with an explicit force-close path instead of staying on "checking".

### Validation

- `npm run check`: 841 unit/integration tests and 11 Microsoft Edge Dashboard
  tests pass on Windows with Node.js 22.

## 1.3.0 - 2026-07-11

### Security

- Dashboard is restricted to loopback hosts and now uses process-local session
  and CSRF credentials, strict cookie settings, exact Host/port and Origin
  validation, JSON-only mutations, anti-framing headers, and cross-site request
  rejection.
- Dashboard turn, image, file, SVG, remote media, and Office preview paths now
  enforce explicit size, type, canonical-path, signature, extraction, ratio,
  and worker-time boundaries.
- New Dashboard tasks default to `plan`; permission state is session-specific,
  and `fullAccess` requires an explicit risk confirmation.

### Changed

- Dashboard event streams resume from the last sequence with bounded
  exponential retry, visible stale/offline states, and manual reconnect.
- Mobile and tablet layouts provide dedicated Sessions, Conversation, and Files
  views with keyboard and modal focus handling.
- Transcript history uses cursor pagination and a bounded browser DOM. Idle
  active-session state is reclaimed without removing persisted history or
  compatibility with older transcript metadata and chunks.
- Shutdown reports active, quarantined, queued, background, and pending work;
  cancelling active work requires an explicit close decision and bounded
  cleanup.

### Validation

- `npm run check` now covers syntax, forbidden endpoints, dependency and lockfile
  policy, strict release-script types plus the Dashboard diagnostic ratchet,
  unit/integration tests, a real Microsoft Edge Dashboard suite, committed asset
  parity, and `git diff --check`.
- Windows executable builds verify the committed rich-renderer bundle, KaTeX
  CSS, and fonts before release output is changed.

## 1.2.4 - 2026-07-04

### Fixed

- Dashboard model settings can now save a user-level global default at
  `~/.ant-code/lab-agent.config.json`, while project defaults continue to save
  under `.lab-agent/config.json`.
- New workspaces now load the user global gateway/model defaults automatically,
  so users do not need to reconfigure the same gateway in every project.
- Project model/gateway settings still override global and environment defaults,
  while gateway API keys from environment variables remain available as a
  fallback when the project does not store a key.
- Environment-provided gateway/model defaults now present a single active
  gateway profile instead of mixing in stale profiles from older global config
  files.
- Template and placeholder project configs no longer override real global
  model/gateway defaults.

### Validation

- `node --test tests/unit/config.test.js`
- `node --test tests/unit/dashboard-runtime.test.js`

## 1.2.3 - 2026-07-01

### Fixed

- Dashboard model configuration now treats a saved model context window as the
  current project's local context budget, so the composer context limit and
  automatic compaction budget stay aligned with the configured model window.
- Saving model configuration while a turn is running no longer resets the
  Dashboard context badge to `0`; existing prompt/context usage is preserved
  while the updated configured limit is displayed.
- Idle Dashboard sessions rebuild their context window after model/config
  changes while retaining existing compaction summary metadata.
- Automatic context compaction now defaults to the configured context window
  itself instead of a hidden ratio, and the byte fallback budget follows larger
  token windows unless explicitly overridden.
- Resuming a compacted session no longer expands archived full context when the
  restored prompt would immediately exceed the configured context budget; Ant
  Code keeps the compacted summary active instead.
- Background terminal tasks can now be listed and cancelled by model tools,
  allowing agents to reuse or recycle an existing server/viewer before starting
  a replacement.

### Validation

- `npm test -- tests/unit/dashboard-runtime.test.js`
- `npm test -- tests/unit/dashboard-runtime.test.js tests/unit/dashboard-server.test.js tests/unit/context-window.test.js tests/unit/config.test.js`
- `npm test -- tests/unit/config.test.js`
- `npm test -- tests/unit/session.test.js`
- `node --test --test-name-pattern "createSession keeps compacted context when restored full archive would exceed prompt budget" tests/unit/session.test.js`
- `npm test -- tests/unit/tools.test.js`
- `npm test -- tests/unit/agent-profiles-config.test.js tests/unit/context.test.js`

