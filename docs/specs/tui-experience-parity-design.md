# Ant Code TUI Experience Parity Design

Status: design baseline v0.2 review-hardened
Owner: lab-tooling
Date: 2026-04-28

This document is the implementation guide for making Ant Code feel like a
polished daily coding agent while keeping the lab-owned clean-room codebase.
Future TUI and interaction work MUST cite the relevant section numbers in
this document before implementation starts.

Follow-up v1.2 polish work MUST also cite
`docs/specs/tui-v1.2-interaction-polish-outline.md`, which captures the next
round of composer, theme, transcript, permission, session, and OpenCode-inspired
product polish goals after this baseline.

## 1. Goal

Ant Code MUST preserve the safety and ownership benefits of the clean-room
rebuild while recovering the interaction quality that made the previous
prototype comfortable to use:

- a focused terminal-first interface
- real streamed model output
- visible but non-noisy thinking and tool activity
- fast keyboard-driven command discovery
- clear local permission decisions
- compact default output with expandable detail
- stable structured events for print mode, TUI mode, tests, and future clients

The target is effect parity, not source parity. We recreate observable behavior
and user-facing affordances with independent implementation.

### 1.1 Normative Language And Priority

This document is both a product design and an implementation contract.

- MUST means the behavior is required before the relevant priority can be
  considered complete.
- SHOULD means the behavior is expected unless the implementation task records a
  specific reason to defer it.
- MAY means optional behavior that MUST NOT weaken clean-room, privacy, or local
  tool boundaries.
- P0 means required for the first usable TUI parity release.
- P1 means required for a product-complete release.
- P2 means advanced workflow polish.
- P3 means explicitly deferred or replacement-only behavior.

When a lower-priority feature conflicts with a higher-priority safety,
privacy, or provenance requirement, the higher-priority requirement wins.

## 2. Clean-Room Boundary

Allowed inputs:

- Publicly observable terminal behavior from the old Ant Code prototype.
- Public documentation for terminal coding agents, MCP, shell behavior, Git,
  JSON, SSE, and OpenAI-compatible chat APIs.
- Open-source packages reviewed through the dependency policy.
- Lab-authored security, deployment, and workflow requirements.
- Pollution-side feature enumeration performed by a reviewer only to prevent
  omitted interaction surfaces.

Prohibited inputs:

- Copying non-public source code, tests, component trees, state machines, prompts,
  comments, private endpoint schemas, source maps, or bundled assets.
- Porting old implementation names or private feature-flag concepts into the
  clean repository.
- Treating old code as a template for file layout or internal architecture.
- Implementing hidden remote tool execution. Tools remain local client actions.

Implementation rule:

- Specs MAY describe behavior in our own words.
- Implementers MUST work from this document, public docs, lab-authored fixtures,
  and tests.
- Implementers MUST NOT read pollution-side source, tests, prompts, component
  trees, bundled assets, private schema definitions, or source maps while
  implementing clean modules.
- A reviewer MAY inspect pollution-side behavior only to enumerate observable
  interaction surfaces. The reviewer output MUST be a sanitized behavior note,
  not a code guide.
- Sanitized behavior notes MUST avoid old file paths, line numbers, private
  symbol names, component names, state-machine names, prompt text, and endpoint
  names.
- If a future exception is unavoidable, the owner MUST record why no public or
  observable source was sufficient, quarantine the task, and require a
  contamination review before any implementation proceeds.
- A module with direct pollution-side source exposure is not considered
  clean-room complete until a separate reviewer confirms the implementation can
  be justified from sanitized specs, public docs, and tests alone.

## 3. Design Principles

- Transcript first: the main screen is a conversation, not a dashboard.
- Details on demand: thinking, tool arguments, and full command output are
  collapsed by default and expandable with a single shortcut.
- Every busy state MUST explain what Ant Code is doing now.
- Keyboard-first interactions MUST remain discoverable through visible hints.
- Permissions are decisions, not log lines; show a modal with the exact action,
  risk, preview, and available choices.
- Local boundary is always visible when it matters: model gateway is separate,
  tools execute locally, credentials are not written to the repo.
- No fake thinking. Show provider-exposed thinking/reasoning when available;
  otherwise show phase/status only.
- The event model is the contract. UI components render events and local state;
  they do not parse provider-native responses directly.

## 4. Current Baseline

Ant Code v1.1 already has:

- OpenAI-compatible SSE parsing with incremental callbacks.
- Session events for assistant text deltas, thinking deltas, tool-call deltas,
  stream start, and stream stop.
- An Ink TUI with a startup surface, live assistant draft, side panels, prompt
  history, inspector, patch browsing, and local approval prompts.
- Verified local gateway smoke tests.

The major remaining gap is product polish and completeness: command discovery,
file mentions, modal permissions, transcript detail levels, keyboard modes,
session management, and richer event normalization.

## 5. Target Information Architecture

The TUI is composed of these persistent regions:

```text
+--------------------------------------------------------------------------------+
| Ant Code logo/version  model/gateway/permission/cwd                            |
+--------------------------------------------------------------------------------+
|                                                                                |
| Transcript                                                                     |
| - user prompts                                                                 |
| - assistant streamed output                                                     |
| - collapsed thinking/tool groups                                                |
| - command results                                                               |
| - errors and rate-limit messages                                                |
|                                                                                |
+--------------------------------------------------------------------------------+
| Prompt composer or active modal                                                 |
+--------------------------------------------------------------------------------+
| Status strip: permission mode | active work | shortcut hint | transient notice  |
+--------------------------------------------------------------------------------+
```

Wide terminals MAY show auxiliary panels only when useful, but the default
product feel MUST remain transcript-first. Side panels MUST never become the
primary experience.

## 6. Event Model V2

All interactive and print behavior MUST flow through normalized events.
Provider-native event shapes are parsed once in the gateway/session layer.

### 6.1 Event Envelope

Every emitted event MUST include:

```ts
type AntEvent = {
  schemaVersion: 2;
  id: string;
  sequence: number;
  type: AntEventType;
  at: string; // ISO 8601 UTC
  sessionId: string;
  turnId: string | null;
  round: number | null;
  parentId?: string | null;
  parentToolUseId?: string | null;
  source: "session" | "gateway" | "tool" | "command" | "permission" | "ui";
  visibility: "default" | "detail" | "debug";
  persistence: "persist" | "redact" | "memory";
  redaction: "none" | "partial" | "full";
  payload: Record<string, unknown>;
};
```

Rules:

- Event `type` names are lab-owned and MUST NOT mirror private provider event
  names unless the name is also publicly documented.
- `sequence` is session-local, starts at 1, and increases by 1 for every
  emitted event after parsing. TUI reducers, transcript replay, and
  `stream-json` MUST process events in sequence order.
- `id` is stable for the stored event and unique within the session. It MUST NOT
  encode private provider ids or secrets.
- `at` uses UTC ISO 8601. Tests normalize this field.
- `turnId` is required for turn-scoped events and `null` for session-level
  events.
- `visibility` controls default rendering only; it is not a privacy boundary.
- `persistence=memory` events MUST NOT be written to session files or print
  output.
- `persistence=redact` events MAY persist only sanitized payload fields and a
  redaction marker.
- Payloads are bounded and redacted before persistence.
- Raw provider messages MAY be retained only in memory for debugging views when
  explicitly enabled.
- Every new event type MUST ship with a golden fixture, payload notes, and a
  reducer test.

Compatibility:

- `schemaVersion=2` is the first event version governed by this document.
- Additive payload fields are allowed. Removing or changing a field requires a
  migration note and a fixture showing the old and new behavior.
- Unknown event types are rendered as compact debug messages in the TUI and are
  preserved in `stream-json`; they MUST NOT crash the reducer.

### 6.2 Session Events

Required event types:

| Event | Purpose |
| --- | --- |
| `system_init` | Session started; cwd, model, gateway, tools, commands, agents, plugins, permission mode. |
| `turn_start` | User prompt accepted; includes prompt byte count and queue state. |
| `turn_queued` | Prompt submitted while a turn is busy. |
| `turn_interrupted` | User interrupted an active turn. |
| `turn_result` | Final outcome, stop reason, duration, usage, cost, permission denials. |
| `session_resumed` | Metadata/session selection restored. |
| `context_compacted` | Context was compacted, manually or automatically. |

### 6.3 Assistant Stream Events

Required event types:

| Event | Purpose |
| --- | --- |
| `assistant_message_start` | New assistant message started; model and message id. |
| `assistant_thinking_start` | Thinking block started. |
| `assistant_thinking_delta` | Provider-exposed thinking/reasoning delta. |
| `assistant_thinking_stop` | Thinking block ended; duration if known. |
| `assistant_text_start` | Text block started. |
| `assistant_text_delta` | Visible assistant text delta. |
| `assistant_text_stop` | Text block ended. |
| `assistant_message_stop` | Assistant message completed; stop reason and usage. |

Rendering rules:

- Thinking deltas are hidden in the default transcript while a turn is active.
- A compact line such as `Thinking...` or `thought for 3s` is shown instead.
- Detailed transcript MAY reveal thinking only if the privacy policy below
  allows it.
- Redacted thinking is represented as its own message state, not as empty text.

Thinking privacy policy:

- Default policy is `thinkingVisibility=summary`.
- In default and print views, raw thinking text MUST NOT be shown.
  Local session transcript retention persists provider-exposed thinking with the
  assistant message so `/resume` can support audit/review.
- `thinkingVisibility=sessionDetail` MAY show provider-exposed thinking in
  interactive detailed mode. It MUST NOT write raw thinking to logs, telemetry,
  snapshots, package outputs, or future model-context requests.
- High-sensitivity config forces `thinkingVisibility=summary` and rejects any
  request to export raw thinking.
- When the provider does not expose thinking, the UI MUST show only phase
  status and MUST NOT fabricate reasoning.
- `assistant_thinking_delta` payloads remain non-printable event output; the
  durable copy lives on retained assistant transcript metadata.

### 6.4 Tool Events

Required event types:

| Event | Purpose |
| --- | --- |
| `tool_use_start` | Model chose a tool; name, id, display category. |
| `tool_input_delta` | Partial JSON/tool input delta. |
| `tool_input_complete` | Parsed and validated tool input. |
| `tool_permission_required` | Tool needs local approval. |
| `tool_start` | Local execution started. |
| `tool_progress` | Optional bounded progress update. |
| `tool_result` | Tool completed, blocked, failed, or was denied. |
| `tool_group_summary` | UI-friendly rollup, such as "Read 3 files". |

Tool input rules:

- Stream partial JSON for live display.
- Keep exact raw input only in memory.
- Parse and validate before execution.
- Render a concise default summary and a detailed transcript expansion.

### 6.5 Permission Events

Required event types:

| Event | Purpose |
| --- | --- |
| `permission_request` | Local approval is required. |
| `permission_preview` | Diff/content/command preview prepared. |
| `permission_choice_focus` | UI selection changed. |
| `permission_decision` | Allowed once, allowed for session, amended, cancelled, or denied. |

Permission payload MUST include:

- tool name
- action type
- affected path or command summary
- risk classification
- preview text or diff summary
- available choices
- policy reason

### 6.6 Command Events

Required event types:

| Event | Purpose |
| --- | --- |
| `command_palette_opened` | Slash palette opened. |
| `command_filter_changed` | User typed into palette. |
| `command_selected` | A slash command was selected. |
| `command_result` | Command output completed. |
| `command_modal_opened` | Help/model/plugin/MCP modal opened. |
| `command_modal_closed` | Modal accepted, cancelled, or errored. |

### 6.7 Print/Automation Protocol

Legacy `-p` text output remains supported during migration. Event-mode outputs
use this contract:

`--output-format=json` returns a single envelope:

```ts
type AntJsonOutput = {
  schemaVersion: 2;
  sessionId: string;
  events: AntEvent[];
  result: Record<string, unknown>;
};
```

The envelope contains:

- `system_init`
- assistant messages and tool messages
- `turn_result`

`--output-format=stream-json` emits one newline-delimited `AntEvent` object as
each event happens.
When `--include-partial-messages` is set, text/thinking/tool-input deltas MUST
be included. Without it, only completed blocks are emitted.

Print protocol invariants:

- Events MUST appear in ascending `sequence` order.
- Each NDJSON line MUST be parseable as one complete JSON object.
- `memory` events are omitted unless an explicit debug flag is added by a later
  security review.
- Raw API keys, raw environment values, and raw provider-native messages MUST
  never appear in print output.

## 7. Visual And Interaction Surfaces

### 7.1 Workspace Trust

Required:

- On first interactive entry in a workspace, show a trust dialog.
- Include cwd, concise security explanation, and two choices: trust or exit.
- `Enter` confirms focused choice; `Esc` exits/cancels.
- Trust decision is workspace-scoped and revocable from a command.

Persistence:

- Trust metadata MUST be stored outside the repository in the Ant Code user
  config directory.
- The trust key is a hash of the resolved absolute workspace path plus a local
  salt. The stored display path MAY be retained for UI only.
- Trust records include `workspaceId`, display path, created time, last used
  time, Ant Code version, and config profile.
- Trust records MUST NOT include API keys, prompts, transcript content, file
  contents, or raw command output.
- If the resolved path changes, trust MUST be requested again.

Revocation and non-interactive behavior:

- `/permissions trust reset` removes trust for the current workspace.
- `/permissions trust list` shows trusted local workspaces without exposing
  sensitive paths beyond normal path display rules.
- A CLI equivalent MUST exist for non-TUI cleanup.
- Print mode does not show the interactive trust dialog, but it MUST still apply
  the permission policy for any tool-capable action.
- High-sensitivity config MAY require trust confirmation on every new process.

Acceptance:

- A new user cannot enter a tool-capable TUI without acknowledging workspace
  trust unless print mode explicitly bypasses this behavior.
- After revocation, the next tool-capable TUI entry MUST show the trust dialog
  again before any local tool can run.

### 7.2 Startup Header

Required:

- Compact Ant Code identity/logo.
- Version.
- Model display name.
- Gateway/protocol status.
- Permission mode.
- Current cwd, truncated from the middle if needed.

Acceptance:

- Header fits in 80-column terminals.
- Header does not push the prompt below a usable position on 24-row terminals.

### 7.3 Transcript

Message classes:

- user text
- user command
- user bash input
- user local command output
- user image/resource attachment placeholder
- assistant text
- assistant thinking collapsed/redacted/full
- assistant tool use collapsed/full
- grouped tool use
- plan approval
- task assignment
- rate-limit message
- API/gateway error
- shutdown/interruption
- compact boundary/context message

Default transcript rules:

- Show user prompts exactly enough for recognition.
- Show assistant text as the primary content.
- Collapse tool details after completion.
- Collapse thinking by default.
- Keep errors visible and actionable.

Detailed transcript rules:

- `Ctrl+O` toggles detailed mode for the current transcript.
- Detailed mode shows tool args, tool results, model/time metadata, and
  provider-exposed thinking only under the thinking privacy policy in section
  6.3.
- `Ctrl+E` reveals full content where a long output was truncated.

### 7.4 Prompt Composer

Required input modes:

- normal prompt mode with `>` or `❯`
- slash command mode
- file mention mode
- shell mode triggered by `!`
- queued prompt mode while a turn is running
- permission/modal mode

Required editing controls:

- Enter submits.
- Backspace/delete edit current draft.
- Up/down recall history when not in a menu.
- Escape cancels current menu/modal or clears a transient state.
- `Ctrl+J` or backslash+Enter inserts newline.
- `Ctrl+U` clears current draft.
- `Ctrl+C` interrupts active turn; exits when idle after confirmation or repeated use.

P1 controls:

- `Ctrl+S` stash current prompt.
- `Ctrl+G` edit draft in `$EDITOR`.
- paste image placeholder handling.

### 7.5 Slash Command Palette

Required:

- Opens when the draft begins with `/`.
- Filters as the user types.
- Shows command name and one-line description.
- Supports built-in commands, custom commands, skills, and disabled/unavailable
  commands with a clear reason.
- Up/down changes focus.
- Enter runs the focused command or submits the typed command.
- Esc closes palette and leaves draft editable.

Required command groups:

- session: `/status`, `/resume`, `/sessions`, `/clear`, `/compact`, `/context`
- model: `/model`, `/cost`, `/usage`, `/fast`
- work: `/files`, `/diff`, `/review`, `/verify`, `/next`, `/report`
- workflow: `/todo`, `/plan`, `/tasks`
- tools: `/mcp`, `/agents`, `/permissions`, `/memory`
- product: `/help`, `/keybindings`, `/theme`, `/feedback`, `/doctor`
- lab custom commands/skills

Command availability rules:

- P0 commands that MUST be functional: `/help`, `/status`, `/clear`,
  `/model`, and `/permissions`.
- P1 commands that MUST appear but MAY be disabled until their stage:
  `/resume`, `/sessions`, `/compact`, `/context`, `/cost`, `/usage`, `/files`,
  `/diff`, `/mcp`, `/agents`, `/memory`, `/doctor`.
- P2 commands MAY appear only if they have a clear disabled reason or a working
  local implementation: `/review`, `/verify`, `/next`, `/report`, `/todo`,
  `/plan`, `/tasks`, `/fast`, `/theme`, `/feedback`, lab skills.
- Disabled commands MUST remain selectable enough to show the reason, but MUST
  NOT silently submit as normal prompts.

### 7.6 Help Modal

Required:

- Full-width modal rather than transcript text.
- Tabs for general, commands, and custom/lab commands.
- Shortcut table.
- Scrollable command browser.
- Esc closes.

Acceptance:

- A new user can discover `/`, `@`, `!`, permission cycling, transcript detail,
  multiline input, and exit from this screen.

### 7.7 File Mention Palette

Required:

- Opens when the draft contains `@`.
- Lists workspace files and directories.
- Shows directories distinctly.
- Filters by typed path fragment.
- Enter inserts the selected path token.
- Esc closes palette.

P1:

- Honor ignored files.
- Show file type icons or lightweight labels.
- Show recently referenced files first.

### 7.8 Shell Mode

Required:

- `!` at draft start enters shell mode.
- Prompt indicator changes visually.
- Read-only commands MAY run through the local permission engine.
- Mutating commands request approval unless the current permission mode allows them.
- Shell output is collapsed by default and expandable.

### 7.9 Permission Mode Strip

Modes:

- `default`: ask before writes/mutating commands.
- `acceptEdits`: allow file edits, still ask for commands.
- `plan`: no writes; the model is instructed to produce a plan and request
  approval.
- `bypassPermissions`: developer mode that skips low/medium-risk approval
  prompts only where the policy matrix allows it. It is not raw auto-approval.
- `dontAsk`: deny actions requiring approval.

Permission matrix:

| Action class | default | acceptEdits | plan | bypassPermissions | dontAsk |
| --- | --- | --- | --- | --- | --- |
| Workspace read/search of non-secret files | allow | allow | allow | allow | allow |
| Read outside workspace | ask | ask | deny | ask | deny |
| Secret-like path, env, credential, key, token | ask or deny by policy | ask or deny by policy | deny | ask or deny by policy | deny |
| Create/edit file inside trusted workspace | ask | allow for non-secret paths | deny | allow for trusted non-secret paths | deny |
| Delete/rename/overwrite large content | ask | ask | deny | ask | deny |
| Shell read-only low-risk command | allow if classifier confirms low risk, else ask | allow if classifier confirms low risk, else ask | deny | allow if classifier confirms low risk, else ask | deny |
| Shell mutating command | ask | ask | deny | allow only for low/medium risk policy matches | deny |
| Network command or package install | ask | ask | deny | ask | deny |
| Unknown MCP/local tool action | ask | ask | deny | ask | deny |
| Remote server-side tool execution | deny | deny | deny | deny | deny |

Policy rules:

- High-sensitivity config removes `bypassPermissions` from the cycle and MAY
  downgrade `acceptEdits` to `default`.
- A denied action emits both a permission event and a visible transcript item.
- "Allow matching/session" creates a bounded matcher with action class, path
  scope, command/tool name, risk ceiling, and expiry. It MUST NOT be a global
  yes.
- Command classification MUST be conservative. Unknown commands are treated as
  mutating or network-capable until classified.

Required:

- Bottom strip shows active mode.
- `Shift+Tab` cycles allowed modes.
- Mode changes emit events and are included in the transcript or status strip.
- High-sensitivity config MUST remove unsafe modes from the cycle.

### 7.10 Thinking And Busy Animation

Required:

- While waiting for model output, show a spinner plus a short activity verb.
- Activity state changes as the turn progresses: waiting, thinking, planning
  tool, running tool, finalizing.
- If thinking deltas arrive, detailed mode can show them only under section 6.3
  thinking privacy rules.
- If no thinking deltas arrive, do not fabricate hidden reasoning.

Implementation note:

- Use lab-owned activity labels. Do not copy old random phrase lists.

### 7.11 Tool Cards

Default collapsed examples:

- `Read 1 file`
- `Searched 12 files`
- `Edited 2 files`
- `Ran PowerShell command`
- `Asked user`
- `Subagent running`

Expanded view includes:

- tool name
- input summary and full input only when redaction policy permits
- permission decision
- duration
- stdout/stderr or file preview
- truncation notice
- related file paths

Tool groups:

- Multiple reads/searches in one turn SHOULD group into a compact summary.
- Failed/blocked tools MUST remain individually visible.

### 7.12 Permission Modals

File create/write/edit modal:

- title: action type
- target path
- preview or diff
- choices: allow once, allow matching/session, deny
- amend option when applicable
- Esc cancels

Shell modal:

- command preview
- risk reason
- cwd
- environment redaction summary
- choices: allow once, allow matching/session, deny

MCP/tool modal:

- server/tool name
- local process boundary
- input summary
- risk and source

### 7.13 Model, Cost, And Context Modals

`/model`:

- model list
- current model marker
- gateway compatibility status
- context/window notes
- gateway-reported effort/thinking support when present

`/cost` or `/usage`:

- session cost estimate when available
- wall duration
- API duration
- token usage
- model usage by alias
- code changes summary

`/context`:

- messages/window usage
- compaction state
- memory files included
- active tool/workflow context

`/compact`:

- queued compaction with busy state
- completion summary

### 7.14 Sessions, Resume, Rewind, Branch

Required:

- `--resume`, `--continue`, and `/resume` select bounded local metadata.
- TUI resume picker lists sessions by cwd, time, title/name, and status.
- `/clear` clears active context.

P1:

- `/rewind` to choose a prior turn and fork from it.
- `/branch` to create a named branch of the current conversation.
- `--fork-session` equivalent for local metadata.

### 7.15 Tasks And Subagents

Required:

- Represent subagent/task start, progress, output, stop, and failure as events.
- Show a compact task progress area when active.
- `Ctrl+T` toggles task view when tasks exist.

P1:

- Background tasks with `&`.
- Task output retrieval and stop controls.
- Worker permission badges.

### 7.16 MCP, Plugins, Agents, Skills

Required:

- `/mcp` lists configured local servers and tools.
- `/agents` lists local agent profiles.
- `/skills` or slash palette exposes lab skills/custom commands.
- Plugins/marketplaces are local/lab registries only unless later approved.

Unavailable cloud features:

- Show a first-class disabled state, not a broken command.
- Explain the local replacement path.

### 7.17 Errors, Rate Limits, And Interrupts

Required:

- Gateway/network errors render as compact, actionable messages.
- Rate-limit or overload messages have a dedicated style and retry guidance.
- Esc/Ctrl+C during active turn interrupts with a visible state transition.
- Tool failures show failed tool, reason, and next step.

### 7.18 Responsive Behavior

Required terminal sizes:

- 80x24 minimum supported layout.
- 120x40 comfortable layout.
- Long paths are middle-truncated.
- Long lines wrap without overlapping status strips.
- Modals MUST keep action choices visible.

## 8. Component Architecture

Recommended module ownership, not a mandatory file layout:

- Keep the current repository structure when it already has a clear owner.
- Split files only when it improves reducer, keymap, transcript, composer, modal,
  or status ownership.
- Do not copy old project file names, component names, or directory shape as a
  template.

Reference layout for discussion:

```text
src/cli/tui/
  app.js
  event-reducer.js
  keymap.js
  layout.js
  transcript/
    TranscriptPane.js
    MessageRow.js
    ThinkingMessage.js
    ToolCard.js
    ErrorMessage.js
  composer/
    PromptComposer.js
    SlashPalette.js
    FileMentionPalette.js
    ShellComposer.js
  modals/
    TrustDialog.js
    HelpModal.js
    ModelModal.js
    PermissionModal.js
    ResumeModal.js
  status/
    Header.js
    StatusStrip.js
    Toast.js
```

The exact file names can vary, but these ownership boundaries MUST remain
stable:

- event reducer owns state transitions
- keymap owns keyboard interpretation
- transcript components render normalized messages
- composer components render input modes
- modals render focused decision flows
- session/runtime remains UI-agnostic

## 9. State Model

TUI state MUST be reducible from events plus local UI state:

```ts
type TuiState = {
  session: SessionSummary;
  transcript: TranscriptItem[];
  activeTurn: ActiveTurn | null;
  composer: ComposerState;
  modal: ModalState | null;
  palette: PaletteState | null;
  status: StatusState;
  detailMode: "compact" | "detailed" | "full";
  permissionMode: PermissionMode;
  tasks: TaskState[];
  toasts: Toast[];
};
```

Reducer rules:

- No component mutates transcript directly.
- Every model/tool/permission event has a deterministic reducer test.
- UI-only events, such as palette navigation, are separate from session events.

## 10. Implementation Stages

Scope rules:

- P0 usable parity is Stage A through Stage E plus the functional P0 commands
  listed in section 7.5. Those commands MAY be pulled forward into Stage D or E
  as thin local modals.
- P1 product-complete release includes Stage F and the P1 command
  behaviors in section 7.5.
- P2 advanced workflow polish includes Stage G.
- Stage H is required before any release labeled stable, regardless of feature
  priority.
- Stubs are allowed only when the UI clearly marks the command or surface as
  unavailable, emits a `command_result` or equivalent event, and links to the
  deferred stage.

### Stage A: Design And Test Harness

Deliverables:

- This design document.
- Snapshot helper for sanitized reference/new terminal frames.
- Golden event fixtures for text, thinking, tool call, permission, error.
- Visual smoke harness for 80x24 and 120x40.

Acceptance:

- Future tasks can cite a fixture, expected event sequence, and expected screen
  state before coding.

### Stage B: Event Model V2

Deliverables:

- Normalized event envelope.
- Gateway parser emits block start/stop and tool input deltas.
- Session emits usage/result events.
- Print `stream-json` uses the same events.

Acceptance:

- A streaming model response with thinking, text, tool input, tool result, and
  final usage can be tested without launching the TUI.
- The resulting events have contiguous `sequence` values and deterministic
  redaction/persistence fields.

### Stage C: Transcript-First Shell

Deliverables:

- Header/status strip.
- Workspace trust dialog.
- Single-column transcript.
- Compact/detail/full transcript toggles.
- Busy animation states.

Acceptance:

- A simple prompt follows this visible sequence: ready prompt, submitted user
  message, busy/thinking summary, streamed assistant draft, completed assistant
  message, ready prompt.
- The 80x24 snapshot keeps header, transcript, composer, and status strip
  visible without overlap.

### Stage D: Composer And Palettes

Deliverables:

- Slash palette.
- Help modal.
- File mention palette.
- Shell mode.
- Prompt history and queued prompt display.

Acceptance:

- `/`, `@`, and `!` are discoverable and usable without reading docs.
- Disabled commands show a reason instead of being submitted as normal prompts.

### Stage E: Tool And Permission UX

Deliverables:

- Tool cards with collapsed and expanded detail.
- Tool grouping.
- File write/edit permission modal with preview.
- Shell permission modal.
- Permission mode strip and Shift+Tab cycle.

Acceptance:

- A write request shows the exact path/content or diff before any write occurs.
- Denied or cancelled writes produce no filesystem changes and leave a visible
  transcript item.

### Stage F: Session And Product Commands

Deliverables:

- `/model`, `/status`, `/clear`, and `/permissions` functional if not completed
  earlier.
- `/cost`, `/usage`, `/context`, `/compact`.
- `/resume` picker and session list.
- `/memory`, `/mcp`, `/agents`.

Acceptance:

- A non-expert lab user can inspect model, cost, context, and permissions from
  inside the TUI.
- Commands not yet implemented remain visible with disabled/local-replacement
  states.

### Stage G: Advanced Workflows

Deliverables:

- Tasks/subagents UI.
- Background mode.
- Plan approval flow.
- Rewind/branch workflow.
- Optional editor/prompt stash.

Acceptance:

- Longer coding tasks render with a grouped task header, progress state,
  permission badges, failure state, and retrieval or stop controls where
  applicable.

### Stage H: Release Hardening

Deliverables:

- Accessibility/responsive pass.
- Error/rate-limit/interrupt pass.
- Provenance update.
- Dependency/security review.
- User quickstart screenshots or terminal captures.

Acceptance:

- `npm run verify:release` passes.
- Visual smoke captures cover the main flows.

## 11. Acceptance Matrix

| Area | Priority | Pass criteria | Required evidence |
| --- | --- | --- | --- |
| Workspace trust | P0 | Untrusted interactive entry blocks tool-capable TUI until trust or exit; trust stores outside repo; reset causes the next entry to prompt again. | Terminal snapshot, reducer test, first-run state test, trust reset test |
| Header/status strip | P0 | Fits 80x24 and 120x40; shows Ant Code identity, model, gateway, permission mode, cwd, and active work without hiding the prompt. | 80x24 and 120x40 snapshots |
| Assistant text streaming | P0 | Text deltas render live, then collapse into one completed assistant message with ordered events. | Event parser test, reducer test, TUI live draft snapshot |
| Thinking collapsed/detail | P0 | Default view shows summary only; raw thinking is locally persisted for resume but not printed; detail obeys section 6.3 policy. | Thinking event fixture, persistence test, Ctrl+O snapshot |
| Tool input partial JSON | P0 | Partial tool input is visible while streaming, then parsed and validated before any execution. | Gateway parser test, invalid JSON fixture, tool draft snapshot |
| Tool collapsed summary | P0 | Completed reads/searches/edits render as compact summaries; failures remain individually visible. | Read/Grep/Edit fixtures, grouping reducer test |
| File permission modal | P0 | Write/edit/create shows exact target and content/diff before write; deny/cancel makes no filesystem change. | Preview snapshot, no-write-before-approval test, deny/cancel filesystem test |
| Permission mode cycle | P0 | Shift+Tab cycles only policy-allowed modes; each mode follows the matrix in section 7.9. | Keyboard test, policy restriction test, action matrix tests |
| Slash palette | P0 | `/` opens filterable palette; up/down/enter/esc work; disabled commands show a reason. | Keyboard test for filter/up/down/enter/esc, disabled command snapshot |
| P0 commands | P0 | `/help`, `/status`, `/clear`, `/model`, and `/permissions` are functional or explicitly blocked by policy with a visible reason. | Command result fixtures, modal snapshots |
| Help modal | P0 | Tabs expose shortcuts, command discovery, file mentions, shell mode, permission cycling, detail toggle, and exit behavior. | Tab navigation snapshot |
| File mention palette | P0 | `@` opens file picker, filters workspace files, distinguishes directories, and inserts the chosen token. | `@` filter/insert test |
| Shell mode | P0 | `!` changes prompt mode; low-risk reads follow classifier; mutating commands request approval or obey denial policy. | Read-only command test, approval command test, classifier fixture |
| Print stream-json | P0 | Emits one parseable AntEvent per line in sequence order; partials obey `--include-partial-messages`; memory events are omitted. | NDJSON order test, partial message test, redaction test |
| Error/rate-limit UI | P0 | Gateway errors, overloads, interrupts, and tool failures render as compact actionable transcript items. | Gateway error, rate-limit, interrupt, and tool failure fixtures |
| `/cost` and usage | P1 | Usage/cost modal uses final `turn_result` data and clearly marks unavailable estimates. | Result event fixture with cost/usage |
| `/context` and `/compact` | P1 | Context modal shows window/compaction state; compaction emits busy and completion events. | Context state fixture, compaction event fixture |
| Session resume picker | P1 | Local metadata picker lists bounded sessions and resumes without reading unrelated transcript content. | Metadata fixture and picker snapshot |
| MCP/plugins/agents/skills | P1 | Local registries render available and disabled states; cloud-only features show local replacement text. | Local registry fixtures and disabled-state snapshots |
| Tasks/subagents | P2 | Task start/progress/result/failure render as grouped events without hiding permission decisions. | Task start/progress/result fixtures |
| Background work | P2 | Queued/background work has visible state, retrieval, and stop controls. | Queue/task state tests |
| Rewind/branch | P2 | Fork metadata is local, bounded, and visible in session history. | Session branch metadata tests |
| IDE/Chrome/mobile/share | P3 | Features are absent or represented by disabled/local-replacement states only. | Disabled or local-replacement state |

## 12. Testing Strategy

Unit tests:

- event parser
- event reducer
- permission preview builder
- palette filtering
- keymap transitions
- transcript item grouping

Integration tests:

- stream text only
- stream thinking then text
- stream tool input and execute local read
- write approval allow/deny
- shell mode allow/deny
- slash command modal flow
- session resume flow

Visual tests:

- Component-level snapshots SHOULD use the Ink test renderer or equivalent
  approved test utility.
- End-to-end terminal snapshots SHOULD run the CLI inside a real PTY and render
  output through `@xterm/headless` or an approved equivalent.
- Cover 80x24 and 120x40 for every P0 surface.
- Preserve ANSI style categories, but normalize volatile values:
  - timestamps to `<time>`
  - event ids to `<event-id>`
  - session/turn ids to `<session-id>` and `<turn-id>`
  - cwd to `<cwd>` when the absolute path is not under test
  - spinner frames to a fixed frame
  - durations and token counts to stable placeholders unless the value is under
    test
- Snapshots MUST fail on text overlap, missing status strip, missing prompt,
  unparseable ANSI output, or terminal rows exceeding the configured height.
- Golden fixtures MUST contain sanitized data only and MUST NOT be generated by
  copying non-public source fixtures.

Manual smoke:

```powershell
cd <repo-root>
node .\src\cli\index.js tui
```

Required manual flows before release:

- first-run trust
- `/help`
- `/model`
- `@README`
- prompt that reads a file
- prompt that asks to write a file
- `Ctrl+O` detailed transcript
- Shift+Tab permission mode cycling
- gateway unavailable error

## 13. Provenance And Review Gate

Before merging a stage:

- Update the relevant provenance module document.
- Run forbidden marker scan.
- Confirm no real API key appears in repo files or package tarballs.
- Confirm implementers did not use pollution-side source.
- Record any reviewer-only pollution-side exposure in a quarantine note, not in
  implementation comments or code.
- Link implementation PR/task to this design section and acceptance rows.
- Link each new event type to a fixture and reducer test.

Review checklist:

- Is the behavior specified here, or was a new behavior invented ad hoc?
- Is the implementation event-driven?
- Is the local tool boundary preserved?
- Is the UI detail collapsed by default and expandable on demand?
- Are destructive actions impossible before approval in default mode?
- Are raw thinking, provider-native messages, credentials, and secret-like paths
  kept out of persistent outputs?
- Does every command/tool decision follow the permission matrix?
- Does the feature fit in 80x24?

## 14. Deferred Or Explicitly Local-Only Features

These are not required for core parity:

- Official cloud marketplace integration.
- provider-hosted account/team memory.
- Remote server-side tool execution.
- IDE/Chrome/mobile integrations beyond local disabled states.
- Public auto-update channel.

If a deferred feature is visible in a menu, it MUST clearly say one of:

- unavailable in lab-local build
- replaced by local/lab registry
- requires later security review

## 15. How Future Tasks Should Use This Document

Every implementation task MUST start with:

- design section references
- acceptance matrix rows
- priority and pass criteria
- events added or consumed
- persistence/redaction behavior for those events
- affected UI surfaces
- security/provenance notes
- whether the task uses only clean-room allowed inputs

Example:

```text
Task: implement slash palette
Design: sections 7.5, 7.6, 9, 10 Stage D
Acceptance rows: Slash palette, Help modal
Priority: P0
Events: command_palette_opened, command_filter_changed, command_selected
Persistence/redaction: no sensitive payloads; command text bounded
Security: clean-room inputs only; command descriptions are lab-authored
```

This keeps the work aligned and makes it clear when a task is adding new scope.
