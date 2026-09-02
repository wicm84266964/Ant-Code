# Changelog

## Unreleased

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
