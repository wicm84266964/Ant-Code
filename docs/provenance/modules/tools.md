---
module: src/tools
owner: lab-tooling
implementation_status: clean-room
implementer_old_source_exposure: limited-audit-context
references:
  - lab_spec: docs/specs/tool-and-permission-spec.md
  - standard: Node.js fs/promises APIs
design_notes:
  - Defines typed tool metadata and a minimal tool runtime.
  - Implements bounded read, list, glob, and grep handlers.
  - Implements read-only git_status and git_diff handlers using direct git argument arrays rather than shell interpolation.
  - Implements approved write_file and exact-replacement edit_file handlers.
  - Hardens edit_file with dry-run preview, stable preflight error codes, replacement-count validation, byte summaries, and bounded diffs before writes.
  - Implements PowerShell and Bash shell handlers with timeout and bounded output.
  - Scrubs secret-like subprocess environment variables before command execution.
  - Rejects symlink paths in MVP to avoid workspace boundary escape.
  - Serializes tool results with a maximum byte budget before model submission.
  - Write tool results include bounded unified diffs.
  - Supports a local approval callback for ask-level permission decisions.
  - Exposes mcp_list so the model can inspect configured MCP servers/tools before calling them.
  - Delegates mcp_call to the configured MCP runtime, which performs permission checks.
  - Exposes skill_list, skill_read, and instruction-only skill_run for local skill resources.
  - Exposes agent_run for profile-scoped local subagents that reuse the lab gateway and permission engine.
  - Implements session-local todo_read, todo_write, plan_update, and ask_user workflow helpers.
  - Keeps workflow state in the active session object instead of writing raw workflow text to metadata.
  - Records successful file edit/write effects and shell validation results in session-local workflow state for review/report commands.
  - Stores only bounded redacted failure excerpts for failed validations so follow-up turns can repair without persisting raw command output.
  - Emits Hooks v1 events around tool execution, permission denial, file changes, and todo updates.
prohibited_sources_checked:
  - old source code was not copied
  - old inline source maps were not used
---

# Tools Provenance

The built-in tools are designed from the clean MVP tool protocol and permission lifecycle.
