---
module: src/context
owner: lab-tooling
implementation_status: clean-room
implementer_old_source_exposure: limited-audit-context
references:
  - lab_architecture: docs/architecture/mvp-architecture.md
design_notes:
  - Builds a small initial context from lab policy, project memory, and tool definitions.
  - Names the public assistant as Ant Code while retaining lab-agent only as internal implementation terminology.
  - Defines a clean-room behavior protocol for inspect-before-edit, validate-after-change, failure repair, sensitive data restraint, and concise final responses.
  - Adds stricter context instructions when high-sensitivity mode is active.
  - Includes project memory with bounded workspace-relative labels instead of absolute local paths.
  - Includes local skill availability and subagent profile summaries in the system context.
  - Explains MCP, skill, and subagent boundaries so the model uses local controlled extension points before assuming cloud behavior.
  - Adds explicit guidance for using `visual-verifier` on screenshot/image evidence, UI layout/readability issues, visual regression, OCR, and screenshot-heavy frontend review.
  - Marks Dashboard as a rich WebUI client that can render attachments/previews while still requiring actual model/tool evidence before claiming image inspection.
  - Emits Hooks v1 compact events around model-based and fallback context compaction.
  - Expands compaction summary capacity and adds a conversation spine so long-task summaries preserve goals, decisions, constraints, file paths, commands, validation evidence, unresolved bugs, and next steps.
  - Preserves ordinary file paths in compaction redaction while still removing secret-like values and credentials.
  - Avoids embedding provider-specific prompt or cloud-session details.
prohibited_sources_checked:
  - old source code was not copied
  - old inline source maps were not used
---

# Context Provenance

The context builder is a fresh implementation of the lab-owned MVP context assembly rules.
