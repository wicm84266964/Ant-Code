---
module: src/ui
owner: lab-tooling
implementation_status: clean-room
implementer_old_source_exposure: limited-audit-context
references:
  - lab_spec: docs/specs/mvp-product-spec.md
  - lab_spec: docs/specs/tui-experience-parity-design.md
  - lab_spec: docs/specs/tui-v1.2-interaction-polish-outline.md
design_notes:
  - Provides simple terminal text formatting for help and status output.
  - Groups slash command help by workflow area for user-facing guidance.
  - Interactive approval prompts name the local execution boundary and summarize dry-run edits without raw edit text.
  - The current TUI is implemented in `src/cli/tui*`; this module remains the plain-text fallback for non-Ink output.
  - v1.2 polish planning uses public OpenCode documentation only as product inspiration for themeability, keybind configuration, fuzzy file references, and modal command discovery.
  - v1.3 keeps Ink after an OpenTUI evaluation because the accepted scroll/overlay architecture is already stable and OpenTUI would add new native dependency review risk on Windows.
prohibited_sources_checked:
  - old source code was not copied
  - old inline source maps were not used
  - OpenCode source code, themes, prompts, and internal component structures were not copied
---

# UI Provenance

The UI module is a fresh minimal terminal text layer for the clean-room MVP.
