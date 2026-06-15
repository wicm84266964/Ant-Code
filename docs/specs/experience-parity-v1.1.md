# Ant Code v1.1 Experience Parity Plan

This document records the first post-1.0 experience pass. The goal is to make
Ant Code feel like a capable daily coding agent while preserving the clean-room
boundary.

For the full post-v1.1 implementation roadmap, use
`docs/specs/tui-experience-parity-design.md` as the controlling design
document. Future TUI work should cite that document's sections and acceptance
matrix rows before implementation.

## Clean-Room Boundary

Allowed inputs:

- Publicly observable terminal behavior from coding-agent tools.
- Public OpenAI-compatible streaming protocol behavior.
- Open-source terminal UI libraries already reviewed for this repository.
- Lab-authored design decisions and tests.

Prohibited inputs:

- Non-public source files, source maps, private prompts, bundled assets,
  telemetry internals, or copied implementation structure.
- Provider-hosted remote tool execution as a hidden dependency.

## v1.1 Implemented

- OpenAI-compatible SSE parsing now emits incremental events while the response
  is being read.
- Session turns forward live `assistant_delta`, `assistant_thinking_delta`,
  `tool_call_delta`, stream start, and stream stop events.
- TUI renders a live assistant draft instead of waiting for the final message.
- TUI shows real provider thinking/reasoning deltas when the local adapter
  exposes them; otherwise it shows only stage status and does not fabricate
  hidden reasoning.
- TUI tracks streamed tool-call argument drafts and local tool run status.
- Startup surface now presents Ant Code identity, configured model/gateway,
  permission mode, and local-tool boundary more prominently.

## Remaining UX Gap

The core streaming feel is now present, but Ant Code is still not finished as a
high-polish daily driver. The next experience pass should focus on:

- Approval modal polish and keyboard affordances.
- Better diff review and patch application flow.
- Persistent task timeline across tool rounds.
- Command palette/autocomplete for slash commands and file paths.
- Better error recovery when model JSON/tool-call streaming is malformed.
- Visual regression captures for common terminal sizes.

## Validation Evidence

Validated locally on 2026-04-28:

- `npm run check:syntax`
- `npm test`
- Local gateway print smoke: `model-ready`
- Local gateway interactive stream smoke: `stream-ready`, with live
  `assistant_delta` events observed.
