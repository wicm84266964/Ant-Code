# Ant Code TUI v1.2 Interaction Polish Outline

Status: draft v0.1, second-pass reviewed
Owner: lab-tooling
Date: 2026-04-29

Implementation note 2026-04-29:

- Stage 1 has started with semantic theme tokens, built-in `sky-blue`,
  `ant-code`, `terminal-default`, and `no-color` themes, and frame-bound tests
  for startup/prompt surfaces.
- Stage 2 has started with a cursor-aware input editor core, wide-character
  width accounting, readline-style editing shortcuts, visual cursor rendering,
  and best-effort terminal cursor positioning for IME-friendly composer use.
- Stage 3 has started with a clean popover priority contract, Esc/Ctrl+G
  close-top-popover behavior, local turn interruption, and Ctrl+C double-press
  exit confirmation.
- Stage 4 has started with transcript block formatting, live turn phase labels,
  interrupted/failed states, and privacy-preserving thinking summaries.
- Stage 5 has started with decision-focused permission modal frames, risk
  previews, focusable approval choices, and tool-card formatting by action
  class and status.
- Stage 6 has started with command product panels for help, status,
  permissions, context, usage/cost, gateway output, and manual `/compact`
  context compression results.
- Full PTY screenshots and manual IME smoke results remain required before
  Stage 1 through Stage 6 are considered complete.

This document is the next modification outline after the v1.1 experience
parity baseline. It assumes the prior design baseline is complete enough to
ship a functional clean-room TUI, then lists the remaining interaction and
visual gaps that prevent Ant Code from feeling like a polished daily coding
agent.

This is not a source-parity task. The goal is a lab-owned interface with a
strong terminal aesthetic, a sky-blue visual identity, reliable input behavior,
and richer tool/agent state presentation.

## 1. Inputs And Boundaries

Allowed inputs for this outline:

- Ant Code v1.1 clean-room source and tests.
- Lab-authored design docs and user feedback from live testing.
- Public product documentation for open-source TUI coding agents.
- Public OpenCode documentation, used only as product and interaction
  inspiration:
  - https://opencode.ai/docs/tui/
  - https://opencode.ai/docs/themes
  - https://opencode.ai/docs/keybinds/
  - https://opencode.ai/docs/modes/

Implementation boundaries:

- Do not read or copy non-public source, prompts, state machines,
  private schemas, bundled assets, or file names.
- Do not copy OpenCode source code, theme files, layouts, prompts, or internal
  structures unless a later task performs a separate open-source license and
  provenance review.
- Public OpenCode docs may inspire visible product affordances such as themes,
  keybind configuration, fuzzy file references, slash commands, and mode
  switching. Ant Code implementations must use lab-owned names, tests, events,
  and components.
- Cloud-only concepts such as remote sharing, provider account connection, or
  remote tool execution remain out of scope unless replaced by local lab-owned
  behavior.

## 2. Product Direction

Ant Code v1.2 should feel calmer, sharper, and more responsive than the v1.1
TUI. The target aesthetic is "Sky Blue":

- Sky blue and cyan as the identity colors.
- Terminal-default background by default, with optional dark panel surfaces.
- Green for completed work, amber for waiting or approval, red for errors,
  magenta only for secondary accents.
- Bold and dim text used intentionally for hierarchy.
- No decorative clutter. Animation should communicate state, not decorate.
- The interface should look good in Windows Terminal, PowerShell, VS Code
  terminal, and common Linux terminals.

OpenCode-like qualities to preserve as goals:

- Themeable native TUI, not a static hard-coded color set.
- Slash-command discovery and command modals.
- Fuzzy `@` file references.
- A clear Plan/Build style mode distinction.
- Configurable keybinds with a leader-key option.
- Smooth scroll and responsive layout.
- Session operations that feel like first-class product workflows.

## 3. Gap Inventory

Each item below is a required backlog entry unless explicitly marked P2 or P3.

| ID | Priority | Gap | Required outcome |
| --- | --- | --- | --- |
| V12-01 | P0 | Composer uses a drawn text box instead of a true terminal cursor anchor. IME candidate windows do not reliably follow the input position. | Input v2 with real cursor placement, blinking cursor, wide-character width handling, and common editing shortcuts. |
| V12-02 | P0 | Resize cleanup is a pragmatic clear-screen patch, not a verified renderer contract. | PTY snapshot tests for startup, main screen, model picker, permission modal, streaming, and resize at 80x24, 120x40, and wide layouts. |
| V12-03 | P0 | Visual identity exists but is not themeable. | Theme token system with built-in `sky-blue`, `ant-code`, and `terminal-default` themes. |
| V12-04 | P0 | Transcript is still log-like. | Message block lifecycle with user, assistant, thinking, tool, permission, shell, and error blocks. |
| V12-05 | P0 | Streaming has a draft, but not enough visible state transitions. | Live state changes for waiting, thinking, answering, planning tool, running tool, finalizing, complete, interrupted, and failed. |
| V12-06 | P0 | Tool output is shown as text plus inspector, not as user-scannable cards. | Tool cards by class: file read, search, edit/write, shell, MCP, workflow, ask-user. |
| V12-07 | P0 | Permission UI is key-driven text, not a decision modal. | Modal with focus choices, risk badge, path/command/diff preview, allow once, allow session, deny, and cancel. |
| V12-08 | P0 | Help and command discovery are still mostly text reports. | TUI help modal with tabs for shortcuts, commands, files, shell, permissions, and privacy. |
| V12-09 | P0 | `/model` is selectable, but other command product surfaces are not modalized. | Modal/panel versions of `/permissions`, `/context`, `/usage`, `/cost`, `/gateway`, and `/status`. |
| V12-10 | P0 | Interrupt behavior is too coarse. | Esc/Ctrl+G cancels popovers first, then current model turn, without necessarily exiting the TUI. Ctrl+C remains app-exit with confirmation if busy. |
| V12-11 | P0 | Queue exists but is not manageable. | Queue panel with queued prompts, delete, promote, and clear actions. |
| V12-12 | P0 | File mentions are basic. | Fuzzy ranking, directory entries, recent files, ignored-folder explanation, type labels, and insertion without losing draft state. |
| V12-13 | P1 | Input editor lacks full readline-like movement. | Ctrl+A/E/B/F, Alt+B/F, Ctrl+W, Alt+D, Ctrl+K, Ctrl+U, Delete, Home/End, and paste handling. |
| V12-14 | P1 | Multiline composition is functional but rough. | Shift+Enter support where terminal allows it, Ctrl+J fallback, visual line numbers, cursor row/column, and external editor command. |
| V12-15 | P1 | Keybinds are hard-coded. | User config for leader key and common actions, with disabled-key support. |
| V12-16 | P1 | Plan/build distinction is mapped to permissions but not productized. | Mode strip with Plan, Default, Accept Edits, Build, and Dont Ask semantics aligned to the permission matrix. |
| V12-17 | P1 | Sessions are command outputs, not a picker. | Session picker with resume, new, rename, cleanup, and bounded metadata display. |
| V12-18 | P1 | Undo/redo/rewind/branch are incomplete or deferred. | Local git-aware undo/redo where available, plus safe no-git messaging and no destructive silent behavior. |
| V12-19 | P1 | `/cost` and `/usage` lack rich presentation. | Usage cards by model alias, turn, tool, and gateway-provided token/cost data; mark unavailable data explicitly. |
| V12-20 | P1 | Agent/task state is not visually first-class. | Task and subagent cards with status, owner, permission boundary, output summary, failure, and stop/retry controls. |
| V12-21 | P1 | MCP and skills discovery is thin. | Local registry panel for MCP servers, tools, skills/custom commands, disabled cloud-only replacements, and risk labels. |
| V12-22 | P1 | Error/rate-limit UI is plain text. | Structured error cards with retryability, gateway diagnostics, permission reason, and suggested next action. |
| V12-23 | P1 | Scrolling and mouse behavior are not productized. | Scrollback navigation, smooth-ish acceleration where possible, optional mouse capture, and native selection mode. |
| V12-24 | P1 | Visual diff display is inspector-only. | Width-aware diff cards with stacked/side-by-side modes and exact approval preview reuse. |
| V12-25 | P1 | Theme and font claims could exceed terminal capability. | Treat fonts as terminal-owned; support ANSI style, bold/dim/italic where available, and document fallback behavior. |
| V12-26 | P1 | Accessibility and low-color terminals are not specified. | No-color mode, high-contrast mode, visible focus markers without relying on color, and text-only fallbacks. |
| V12-27 | P2 | Export/editor workflows are missing. | `/editor` for composing prompt in `$EDITOR`; `/export` for local markdown export without cloud sharing. |
| V12-28 | P2 | Timeline and child-session navigation are missing. | Timeline view for turns, tool calls, permission decisions, and child agent sessions. |
| V12-29 | P2 | Tips/onboarding are static. | Rotating but unobtrusive tips, dismissible and configurable. |
| V12-30 | P2 | Theme customization is not exposed. | `/theme` picker and local theme JSON loading after the built-in theme system is stable. |

## 4. Stage Plan

### Stage 1: Renderer Contract And Theme Tokens

Deliverables:

- Theme token module with semantic names: identity, text, dim, panel, border,
  success, warning, danger, info, accent, selection, cursor, diffAdd,
  diffRemove, and diffContext.
- Built-in `sky-blue` theme with sky-blue identity.
- Theme application through all TUI components.
- PTY/snapshot harness draft that can capture startup and main-screen frames.
- No-color and low-color fallback rules.

Acceptance:

- Startup and main screen fit 80x24 without line overflow.
- Theme can switch in code without changing component logic.
- Color is never the only focus indicator.

### Stage 2: Composer/Input v2

Deliverables:

- Real cursor anchoring in the prompt composer.
- Blinking cursor rendered at the active insertion point.
- IME-friendly cursor placement for terminals that follow the terminal cursor.
- Wide-character width accounting for Chinese text.
- Basic editing: left, right, up, down, Home, End, Delete, Backspace.
- Readline-style shortcuts listed in V12-13.
- Paste handling that preserves newlines and does not trigger accidental submit.

Acceptance:

- Chinese IME candidate window follows the current input position in Windows
  Terminal or documents a terminal-specific limitation.
- Cursor position remains correct after resize.
- Multiline draft editing does not corrupt slash or file mention palettes.

### Stage 3: Popovers And Interrupt Semantics

Deliverables:

- Unified popover stack for slash palette, file picker, model picker, help,
  context, permissions, queue, and theme.
- Esc and Ctrl+G close the top popover before cancelling a model turn.
- Busy turn cancellation sends a local abort signal to the gateway client when
  supported and marks the transcript as interrupted.
- Ctrl+C while busy asks for exit confirmation; Ctrl+C when idle exits.

Acceptance:

- No modal can strand the app without a visible exit path.
- Interrupt events are represented in transcript and AntEvent output.

### Stage 4: Transcript Blocks And Streaming Rhythm

Deliverables:

- Transcript block component model.
- Collapsed thinking summary with privacy-preserving detail modes.
- Tool call draft cards while arguments stream.
- Final assistant block replaces the draft without flicker.
- Turn lifecycle animation states: waiting, thinking, answering, planning tool,
  running tool, finalizing, ready, interrupted, failed.

Acceptance:

- A streaming turn with text, thinking, tool input, tool output, and final text
  is readable without opening the inspector.
- Raw thinking remains hidden by default and is never persisted.

### Stage 5: Tool Cards And Permission Modals

Deliverables:

- Tool card renderer by risk/action class.
- Permission modal with focusable choices.
- Shared preview builder for edit/write/shell/MCP requests.
- Width-aware diff preview.
- Session approval badges and revocation display.

Acceptance:

- A non-expert user can tell what will be read, written, or executed before
  approving.
- Denied and cancelled actions remain visible in the transcript.

### Stage 6: Command Product Surfaces

Deliverables:

- `/help` modal with tabs.
- `/permissions` modal with trust, current mode, matrix summary, and reset.
- `/model` picker upgraded with health, aliases, current marker, and save
  default action.
- `/context`, `/usage`, `/cost`, `/gateway`, and `/status` panels.
- `/theme` command stub or implementation depending on Stage 1 progress.

Acceptance:

- Command output that affects user choices is not just dumped as text.
- Disabled cloud-only commands explain the local replacement or reason.

### Stage 7: File, Session, And Queue Workflows

Deliverables:

- Fuzzy file picker with type labels and recent files.
- Queue manager panel.
- Session picker and local metadata resume flow.
- New session command and safe clear/compact flows.
- Git-aware undo/redo feasibility note and implementation plan.

Acceptance:

- A user can recover from the wrong session, wrong queued prompt, or wrong file
  mention without restarting the app.

### Stage 8: Agent, MCP, And Local Extension Panels

Deliverables:

- Task/subagent activity cards.
- MCP server/tool registry panel.
- Local skills/custom commands panel.
- Risk and permission labels for all extension-like actions.

Acceptance:

- Extension and subagent actions never look like invisible remote execution.

### Stage 9: Release Hardening

Deliverables:

- Full PTY snapshot suite.
- Visual regression fixtures for 80x24, 120x40, and wide terminals.
- Manual smoke checklist for Windows Terminal, PowerShell, VS Code terminal,
  and one Linux terminal.
- Provenance note for public references and any new dependencies.
- Updated v1.2 acceptance summary.

Acceptance:

- No known overlap, stale-frame, or missing-cursor issue remains in supported
  terminals.
- `npm run check` and release verification pass.

## 5. Acceptance Matrix

| Surface | Required evidence |
| --- | --- |
| Composer cursor | PTY frame shows cursor at insertion point; manual IME smoke result recorded. |
| Theme | Snapshot under `sky-blue`, no-color fallback, and default theme. |
| Resize | Before/after PTY frames at growing and shrinking widths. |
| Transcript | Golden event fixture renders stable blocks for text, thinking, tools, and errors. |
| Permission modal | Allow once, allow session, deny, cancel, and readonly denial tests. |
| Slash/help | Keyboard path from `/` to selected command and `/help` tab navigation. |
| Model/context/usage | Modal or panel snapshot with unavailable data clearly marked. |
| File picker | Fuzzy ranking test and workspace-boundary test. |
| Interrupt | Abort/cancel test for popover, busy turn, and app exit. |
| Sessions | Resume picker with bounded visible history and archive-backed model-context restoration when current resume policy allows it. |
| Agent/MCP | Local-only labels and disabled-state tests. |
| Accessibility | High-contrast/no-color snapshot and non-color focus marker. |

Current note: this v1.2 outline originally captured a more conservative restore
target. The current v3 session runtime keeps the TUI display bounded but lets
`--resume` restore model context from local transcript archive chunks when they
exist and fit the configured resume budget.

## 6. Second-Pass Review

This section reviews the outline itself for omissions, ambiguous wording, and
implementation risk.

### 6.1 Omissions Found And Added

- The first gap list could have focused only on one provider-like parity. It now
  includes OpenCode-like product affordances that are safe for clean-room use:
  themes, keybind config, fuzzy files, Plan/Build mode framing, and sessions.
- The first gap list did not explicitly cover mouse/scroll behavior. V12-23
  adds optional mouse capture, scrollback, and native selection behavior.
- The first gap list did not separate terminal font claims from color styling.
  V12-25 clarifies that Ant Code cannot enforce terminal fonts.
- The first gap list mentioned IME but not wide-character layout. V12-01 and
  Stage 2 now require Chinese/wide-character width handling.
- The first gap list mentioned command productization but not disabled
  cloud-only replacements. Stage 6 now requires explicit local replacement
  explanations.
- The first gap list did not require no-color/high-contrast behavior. V12-26
  and Stage 1 add this.
- The first gap list did not require editor/export workflows. V12-27 adds them
  as P2 local-only features.

### 6.2 Ambiguous Terms Tightened

- "OpenCode-like" means public, observable product qualities: themeability,
  keyboard discovery, modal commands, fuzzy file references, and calm motion.
  It does not mean copying OpenCode source, component structure, or assets.
- "Sky-blue theme" means a semantic theme token set with cyan/sky identity
  colors plus non-blue status colors. It does not mean every UI element is blue.
- "Fonts" means ANSI styles and terminal-compatible text hierarchy. The actual
  typeface is controlled by the user's terminal.
- "IME support" means placing the real terminal cursor at the input insertion
  point so the terminal and OS can position candidate windows correctly. It
  does not guarantee behavior in terminals that do not expose proper IME
  positioning.
- "Animation" means stateful terminal frames for waiting/streaming/tool work.
  It does not mean decorative motion that obscures text.
- "Plan/Build mode" in Ant Code must map to the lab permission matrix, not to
  another product's internal mode semantics.

### 6.3 Remaining Risks

- Ink may not provide enough low-level cursor control for high-quality IME
  behavior. Stage 2 must validate whether to use Ink only, a custom raw input
  composer, or a small terminal input helper.
- Full-screen clear on resize can reduce stale frames but may flicker. Stage 1
  and Stage 2 must decide whether to keep full-screen clearing, use alternate
  screen buffering, or implement a renderer-level diff.
- Mouse capture can break native copy/paste expectations. It must be optional
  and default to conservative behavior until tested.
- Theme customization can become a compatibility burden. v1.2 should first
  implement semantic tokens and built-in themes before accepting arbitrary JSON.
- Undo/redo can be dangerous outside Git worktrees. Any implementation must
  detect Git state and avoid silent destructive changes.
- Raw thinking display remains privacy-sensitive. Visual polish must not
  weaken the existing default hidden/summary policy.

### 6.4 Definition Of Done For This Outline

The outline is ready to drive implementation when:

- Each P0 gap has a stage, acceptance evidence, and test strategy.
- Each OpenCode-inspired item has a clean-room interpretation.
- All cloud or remote affordances have a local-only replacement or are marked
  disabled.
- IME/cursor support is treated as a first-class architecture task.
- Theme goals are expressed as semantic tokens, not hard-coded colors.
- Accessibility and no-color behavior are included from the start.
