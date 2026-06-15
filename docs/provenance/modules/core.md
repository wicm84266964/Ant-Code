---
module: src/core
owner: lab-tooling
implementation_status: clean-room
implementer_old_source_exposure: limited-audit-context
references:
  - lab_architecture: docs/architecture/mvp-architecture.md
  - standard: Node.js crypto randomUUID
design_notes:
  - Owns session metadata and print-mode orchestration.
  - Delegates config, context, and gateway transport to separate modules.
  - Prepends clean-room system context to each lab gateway model request.
  - Runs a bounded local tool-call loop for print mode.
  - Appends tool results as bounded JSON text before returning to the lab gateway.
  - Persists bounded session metadata after print and interactive turns without storing raw prompts or assistant outputs.
  - Carries explicit non-interactive workspace-write approval into the tool runtime.
  - Carries explicit non-interactive shell-command approval into the tool runtime.
  - Supports interactive per-tool approval callbacks for ask-level permission decisions.
  - Passes the configured MCP runtime into the tool runtime for model-triggered MCP calls.
  - Supports reusable interactive sessions with bounded visible conversation history, transcript archives, model-context archives, and per-turn metadata indexes.
  - Separates resumed display history from resumed model context: TUI/Dashboard can keep visible transcript windows bounded while the core runtime restores archived model-context chunks into model context within configured resume budgets.
  - Automatically compacts older conversation messages into bounded, redacted, process-local context summaries when configured budgets are exceeded.
  - Prefers a hidden internal compaction agent for model-based summaries and records fallback strategy metadata when the gateway is unavailable.
  - Clears persisted compaction summary state when full archived context is restored, avoiding duplicate original-history plus summary prompts.
  - Persists and restores bounded internal-agent metadata such as the last compaction strategy without storing raw transcript text.
  - Preserves task-critical file paths during transcript/context redaction while still redacting secrets, token-like values, credentials, and emails.
  - Persists assistant tool-call requests and matching local tool results into a model-context archive before compaction can remove them from the active message window.
  - Repairs dangling assistant tool-call records before persistence and model-context restoration so incomplete historical tool chains do not trigger gateway validation errors.
  - Owns session-local workflow state, including todo/plan summaries, recorded changes, validation summaries, and local resume from bounded metadata plus transcript archives when available.
  - Injects bounded redacted workflow context into follow-up model turns when recent validations failed.
  - Derives local delivery status, task lifecycle stage, validation freshness, validation suggestions, and next-action hints from workflow state for CLI and slash-command display.
  - Builds lightweight repository maps from local manifests and top-level directory names without reading or persisting raw source contents.
  - Refreshes persisted workflow metadata from current session state while storing only counts/status summaries.
  - Persists context metadata as counts and byte totals only; compacted summary text is not written to session metadata.
  - Normalizes legacy session events into lab-owned AntEvent schema v2 with stable sequence numbers, source, visibility, persistence, and redaction metadata.
  - Persists provider-exposed thinking with local retained assistant transcript metadata for resume/review while omitting it from printable event output and future model-context requests.
  - Handles image attachments as request-scoped user content, persists only redacted image metadata, and prevents raw image bytes from entering session metadata.
  - Uses a same-gateway visual verifier preflight when the selected main model is text-only but an enabled vision model is configured, then passes the resulting visual evidence report to the main model.
  - Provides a deterministic event reducer foundation for transcript, tool, error, and turn state rendering.
prohibited_sources_checked:
  - old source code was not copied
  - old inline source maps were not used
---

# Core Provenance

The session module is a small orchestration layer created from the Phase 1 architecture.
