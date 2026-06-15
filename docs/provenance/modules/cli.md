---
module: src/cli
owner: lab-tooling
implementation_status: clean-room
implementer_non_public_source_exposure: limited-audit-context
references:
  - lab_spec: docs/specs/mvp-product-spec.md
  - standard: Node.js executable scripts and process argv behavior
  - open_source: Ink terminal UI library, MIT licensed, public npm package
  - open_source: KaTeX math rendering library, MIT licensed, public npm package
  - open_source: Mermaid diagram rendering library, MIT licensed, public npm package
  - open_source: React UI library, MIT licensed, public npm package
  - open_source: yaml parser library, ISC licensed, public npm package
design_notes:
  - Provides a small argument parser for version, doctor, readonly, gateway health, print mode, and interactive chat.
  - Exposes `ant-code` as the public command and keeps `lab-agent` as a compatibility alias.
  - Starts interactive chat by default when no command or print prompt is supplied.
  - Interactive chat is a local terminal loop with session state, todo/plan display, context budget status, delivery status footers with validation suggestions, review/next/report commands, local resume, context clearing/compaction, and per-tool approval prompts.
  - Provides an Ink-powered `tui` product preview split across local TUI modules for orchestration, reusable Ink components, formatting helpers, and process-local runtime log helpers.
  - The TUI renders the existing clean-room session events, local tool status, slash command output, local approval prompts, responsive main/side panel layout, command hints, prompt history, a quieter conversation-first transcript, a `/logs` command panel for process-local command/tool/approval/gateway/context records, file-by-file patch browsing with per-file additions/deletions/hunk counts, diff/patch highlighting, and a multi-line composer.
  - The TUI v1.1 experience layer renders live assistant drafts from independently implemented stream events, provider-exposed thinking/reasoning deltas when available, streamed tool-call argument drafts, and local tool run status without copying non-public UI code or private prompts.
  - Print mode supports lab-owned `--output-format=json` and `--output-format=stream-json` outputs backed by AntEvent schema v2, while preserving legacy text output.
  - The TUI now gates tool-capable interactive entry on local workspace trust, uses Ctrl+O to cycle transcript detail levels, hides raw thinking text by default, and lets `/thinking` reveal retained local transcript thinking when available.
  - The TUI receives AntEvent schema v2 events alongside legacy session events and reduces them into event-driven transcript state as the migration foundation.
  - The TUI keeps resumed visible transcript memory bounded while allowing `--resume` to request archived transcript restoration for model context through the shared session runtime.
  - Stage D-H TUI work adds clean-room slash command discovery, workspace file mentions, local shell composer mode, queued prompts during active turns, permission-mode cycling, richer approval modal text, command output runtime-log routing, and local disabled-state surfaces for deferred advanced workflows.
  - Command productization pass adds a real TUI `/model` picker, session-local model switching, terminal resize-driven layout recalculation, and a visible Ant Code startup logo surface before the trust prompt and in the initial transcript.
  - v1.2 Stage 1-2 work adds lab-owned theme tokens, the `sky-blue` default theme, no-color fallback, a cursor-aware input editor core, wide-character width accounting, prompt cursor rendering, and best-effort terminal cursor positioning for IME-friendly composer behavior.
  - Dashboard report rendering uses local bundled KaTeX, Mermaid, and YAML dependencies for math, diagrams, and structured-data previews; the browser loads checked-in local assets rather than CDN resources.
  - Keeps model, tool, and policy decisions outside the entrypoint.
prohibited_sources_checked:
  - non-public source code was not copied
  - decompiled/generated private source material was not used
---

# CLI Provenance

The CLI module implements only the public lab-owned command surface described in the MVP specification.
