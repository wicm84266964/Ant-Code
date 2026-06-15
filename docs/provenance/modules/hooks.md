---
module: src/hooks
owner: lab-runtime
implementation_status: clean-room
implementer_old_source_exposure: limited-audit-context
references:
  - lab_plan: internal planning record, not included in packaged release artifacts
design_notes:
  - Implements a local hooks runtime for audit, safety, and bounded automation.
  - Supports builtin hooks and local command hooks.
  - Keeps command hooks behind trusted workspace gating.
  - Scrubs command hook environment variables with an allowlist and secret-key filter.
  - Records recent hook execution in an in-memory ring buffer for /hooks and /logs inspection.
  - Avoids recursive hook triggering.
  - Does not implement remote hook marketplaces, HTTP hooks, telemetry, or provider-specific managed settings.
prohibited_sources_checked:
  - old source code was not copied
  - remote telemetry and provider hook endpoints were not introduced
---

# Hooks Provenance

Hooks v1 is a local runtime layer designed for Ant Code's lab-local execution
model. It records and optionally blocks selected runtime events without adding a
remote plugin system.

The implementation is intentionally conservative:

- Builtin hooks provide default audit records and sensitive-path detection.
- Sensitive file access is approved by the permission engine, not hard-blocked
  by hooks. This keeps key rotation usable while still requiring an explicit
  warning and audit record.
- Command hooks are project-configurable but execute only after workspace trust.
- Non-blocking command hooks are scheduled asynchronously so local validation
  does not hold the agent turn.
- Background command hook audit records are visible as running records and are
  updated in place when they complete or fail.
- Background command hook child processes and timers are unref'ed to avoid
  keeping the CLI/TUI process alive solely for hook completion.
- Hook records stay in process memory and are not persisted to session
  transcript metadata.
- Only explicitly blocking `tool.before` hooks may block. Permission,
  compaction, file-change, todo, session, and subagent events are audit or
  background automation surfaces.
