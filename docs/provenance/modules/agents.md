---
module: src/agents
owner: lab-tooling
implementation_status: clean-room
implementer_old_source_exposure: limited-audit-context
references:
  - lab_spec: docs/specs/mvp-product-spec.md
  - lab_architecture: docs/architecture/mvp-architecture.md
  - lab_policy: docs/provenance/clean-room-provenance-policy.md
design_notes:
  - Defines lab-owned local subagent profile metadata and optional config-provided profile overlays.
  - Provides explorer, readonly-researcher, planner, verifier, and code-worker profiles with explicit tool allowlists.
  - Supports build/default and hidden internal profiles for compaction, title, and summary-style internal tasks.
  - Includes a `visual-verifier` profile for screenshots, image attachments, OCR extraction, UI layout/readability checks, visual regression evidence, and screenshot-heavy frontend review.
  - Routes visual/image/screenshot/layout prompts to the visual profile and resolves it through the configured `vision` model tier or `agents.vision.model`.
  - Runs model-driven subagents through the same configured lab gateway as the parent session.
  - Reuses the parent session permission engine, approval callback, workflow state, and MCP runtime.
  - Records task metadata with parent session id, child session id, status, progress, tool summary, output summary, and cancellation metadata.
  - Persists complex planner output as runtime plan packages under `.lab-agent/plans/<plan-id>/`, with `requirements.md`, `task-plan.md`, `execution-checklist.md`, and `manifest.json`.
  - Supports explicit local background tasks and optional git worktree isolation under .lab-agent/worktrees.
  - Persists background task group wake lifecycle markers including queued and consumed wake prompt timestamps so clients can distinguish generated-but-unconsumed continuations.
  - Emits Hooks v1 lifecycle events for subagent start, completion, failure, and partial pause.
  - Keeps readonly fallback scanning for readonly-researcher/explorer when no gateway is configured.
  - Requires a configured gateway for verifier and code-worker profiles.
  - Requires a same-gateway vision-capable model for visual image fallback; cross-provider or multi-key visual routing is intentionally not implemented.
  - Does not implement cloud scheduling, remote agent behavior, or provider-owned backend agents.
prohibited_sources_checked:
  - old source code was not copied
  - old inline source maps were not used
---

# Agents Provenance

The profile list, task store, and runner were written from lab requirements for controlled local delegation. They are local-only and do not depend on provider-hosted agent backends.
