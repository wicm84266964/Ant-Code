# OpenTUI POC Decision

Date: 2026-04-30

## Question

Stage 10 asked whether Ant Code should migrate the TUI from the current
Ink/React stack to OpenTUI after the Stage 1/2 scroll and overlay rewrite.

## Evidence

Package inspection on 2026-04-30:

- `@opentui/core@0.2.0`, MIT.
- `@opentui/react@0.2.0`, MIT.
- `@opentui/core` depends on `bun-ffi-structs`, `yoga-layout`, `jimp`,
  `marked`, `string-width`, `strip-ansi`, and optional native packages
  including `@opentui/core-win32-x64` and `@opentui/core-win32-arm64`.
- `@opentui/react` depends on `@opentui/core` and `react-reconciler`.

Local product evidence:

- The current Ink TUI now has a split shell, fixed side panel, overlay region,
  explicit scroll regions, region-aware wheel routing, prompt editor tests, and
  accepted live behavior for long answers, small windows, slash command panels,
  resume, guide, and two-press interrupt.
- At the time of this decision, the release seal only reviewed runtime
  dependencies `ink` and `react`. Migrating would have required a new dependency
  review, SBOM refresh, Windows native package validation, and longer
  live-terminal soak testing.

Public design references used as product inspiration only:

- OpenCode documents agent configuration and local extension surfaces as
  explicit project/user configuration rather than hidden provider routing.
- Model Context Protocol examples commonly use explicit local stdio servers for
  filesystem, memory, and browser automation.

## Decision

Do not migrate the production TUI to OpenTUI in this stage.

Keep the current Ink implementation and the Stage 1/2 `ScrollableRegion`
architecture for the v1.3 internal build. OpenTUI remains worth a later
separate branch POC if the lab wants richer terminal layout primitives, but it
should not be introduced into the deadline build without native-package and
Windows resize/wheel soak evidence.

## Acceptance

- `node .\src\cli\index.js tui` remains the production launch path.
- Current scroll, overlay, side panel, and input behavior remain owned by
  `src/cli/tui.js` and modules under `src/cli/tui/`.
- No new runtime dependencies are added for Stage 10.
- The decision is reversible by opening a separate evaluated migration branch.
