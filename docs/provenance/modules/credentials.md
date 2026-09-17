---
module: src/credentials
owner: lab-tooling
implementation_status: independent
implementer_old_source_exposure: limited-audit-context
references:
  - lab_security: docs/security/data-boundary.md
  - lab_spec: docs/specs/mvp-product-spec.md
  - standard: local JSON secret stores and optimistic concurrency
design_notes:
  - Stores gateway secrets separately from model and provider settings.
  - Exposes credential references and configured-state descriptors without serializing secret values through public configuration APIs.
  - Uses revision-checked writes so a stale settings page cannot silently replace a newer credential.
  - Preserves unrelated credential entries during scoped set and delete operations.
  - Requests restrictive owner-only file permissions on platforms that support mode bits.
  - Validates credential references and rejects empty secrets before persistence.
prohibited_sources_checked:
  - old source code was not copied
  - old inline source maps were not used
---

# Credentials Provenance

The credential store is an independent local persistence adapter derived from the
lab data-boundary requirements. It keeps secrets outside model configuration and
returns only bounded metadata to configuration and Dashboard callers.
