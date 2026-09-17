---
module: src/config-v2
owner: lab-tooling
implementation_status: independent
implementer_old_source_exposure: limited-audit-context
references:
  - lab_spec: docs/specs/mvp-product-spec.md
  - lab_security: docs/security/data-boundary.md
  - lab_history: PROJECT_CHANGELOG.zh-CN.md
  - standard: JSON configuration files, optimistic concurrency, and layered configuration
design_notes:
  - Defines a strict versioned schema for model providers, exact-model capabilities, default selections, and provider-qualified agent routing.
  - Treats provider IDs as permanent identities that do not change when an endpoint is edited.
  - Resolves base, global, project, and environment layers in one direction while retaining field provenance.
  - Rejects project provider shadowing and invalid cross-scope references instead of resolving ownership heuristically.
  - Stores a model choice atomically as provider, model, and optional reasoning effort.
  - Uses revision-checked repository patches so stale settings pages cannot overwrite a newer edit.
  - Migrates legacy model configuration into V2 with backups and an idempotent marker, then exposes a one-way legacy runtime projection during transition.
  - Preserves unknown settings namespaces while validating and mutating only owned paths.
prohibited_sources_checked:
  - old source code was not copied
  - old inline source maps were not used
  - external product behavior informed configuration concepts only; no external implementation was copied
---

# Config V2 Provenance

Config V2 is an independent replacement for Ant Code's ambiguous legacy model
configuration merge. Its schema and ownership rules were derived from the
project's observed failure history, local product requirements, and standard
layered-configuration and optimistic-concurrency patterns.
