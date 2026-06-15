---
module: src/commands
owner: lab-tooling
implementation_status: clean-room
implementer_old_source_exposure: limited-audit-context
references:
  - lab_spec: docs/specs/mvp-product-spec.md
design_notes:
  - Defines command metadata for the MVP slash command list.
  - Implements local slash command parsing and execution for status, config, permissions, files, map, diff, review, verify, next, report, run, edit, todo, plan, memory, doctor, agents, skills, and MCP inspection.
  - Adds local `/files`, `/map`, `/diff`, `/review`, `/verify`, `/verify suggest`, `/verify run suggested`, `/next`, `/report`, `/run`, `/edit`, `/todo`, `/plan`, `/memory add`, `/agents run`, `/skills`, `/skills show`, `/skills run`, `/sessions show`, and `/sessions cleanup` commands.
  - Adds `/edit --dry-run` as a local preview path that reuses the edit_file preflight and permission boundary without writing files.
  - Slash commands are handled locally and do not require a model gateway call.
  - Local tool-style slash commands reuse the permission engine and bounded output rules.
  - `/status`, `/next`, `/report`, and `/help` use consistent sectioned text output; `/status --json` preserves the machine-readable shape for automation.
  - `/help` groups commands by user workflow area so non-expert lab users can find common actions faster.
  - `/status`, `/next`, and `/report` include derived delivery state and next-action hints from session-local workflow state.
  - `/verify suggest` derives validation command suggestions from local package scripts and common project manifests without running them.
  - `/verify run suggested` resolves the first validation suggestion before using the normal shell permission engine.
  - MCP slash commands use the same configured MCP runtime as model tool calls.
  - Skill slash commands use the same local skill registry as model skill tools and stay instruction-only.
  - Adds `/cost`, `/usage`, `/context`, `/keybindings`, `/background`, and explicit lab-local disabled outputs for deferred theme, feedback, fast-model, rewind, branch, and stash surfaces.
  - `/background` runs, lists, shows, cancels, and manages explicit worktree cleanup for local background subagent tasks.
  - `/mcp` exposes status, tools, prompts, resources, read-resource, reconnect, and disconnect for configured local MCP servers.
  - `/agents tasks` and related task display commands show local child-task metadata.
  - `/model`, `/model list`, and `/model use <model-id>` render locally configured gateway aliases and can switch an attached TUI session without calling provider model-list endpoints.
  - `/hooks` displays local hook configuration, current-process audit records, recent failures, and trusted command-hook state.
  - Deferred commands remain visible in slash discovery but return local replacement guidance instead of attempting cloud or marketplace behavior.
prohibited_sources_checked:
  - old source code was not copied
  - old inline source maps were not used
---

# Commands Provenance

The command list is derived from the lab MVP command requirements and the later lab-approved TUI/agent upgrade plan, not from legacy implementation internals.
