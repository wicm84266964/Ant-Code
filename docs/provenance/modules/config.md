---
module: src/config
owner: lab-tooling
implementation_status: clean-room
implementer_old_source_exposure: limited-audit-context
references:
  - lab_spec: docs/specs/mvp-product-spec.md
  - lab_security: docs/security/data-boundary.md
  - standard: JSON configuration files and environment variables
design_notes:
  - Uses defaults, project config, optional lab config, and environment overrides.
  - Adds the lab gateway host to the allowlist when configured.
  - Includes explicit MCP server configuration with no auto-discovery behavior.
  - Supports local transcript retention and encryption policy environment overrides.
  - Supports explicit `standard` / `high` sensitivity modes; high mode forces zero-retention metadata and rejects broad network modes.
  - Supports configurable context budgets for automatic in-memory compaction.
  - Supports Hooks v1 config for local builtin hooks, trusted command hooks, output caps, timeouts, and env allowlists.
  - Supports registered model metadata including modalities, context windows, provider extra request body, per-model subagent tiers, and the `agents.vision` same-gateway visual fallback config.
  - Supports Dashboard-managed `lab.gatewayProfiles` and `lab.activeGatewayProfile` so multiple gateway profiles can be stored while runtime model calls still use exactly one active gateway/key.
  - Validates model modality declarations (`text` / `image`) and visual-agent config without querying provider model-list endpoints.
prohibited_sources_checked:
  - old source code was not copied
  - old inline source maps were not used
---

# Config Provenance

The config loader was designed from the lab data-boundary and deployment requirements.
