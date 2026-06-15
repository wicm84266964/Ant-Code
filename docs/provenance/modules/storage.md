---
module: src/storage
owner: lab-tooling
implementation_status: clean-room
implementer_old_source_exposure: limited-audit-context
references:
  - lab_security: docs/security/data-boundary.md
  - standard: local filesystem JSON persistence
design_notes:
  - Stores local session metadata only.
  - Stores bounded turn metadata without raw prompts or assistant outputs.
  - Stores redacted transcript archive chunks locally for paged review and resume when transcript retention policy allows it.
  - Stores redacted model-context archive chunks separately from visible transcript chunks so resume can restore tool-call requests and tool results without forcing the UI to render them.
  - Redacts secret-like keys before writing JSON.
  - Preserves ordinary file paths during redaction because they are task-critical, while still redacting token/secret/password/credential values and emails.
  - Skips new local metadata writes when transcript persistence is disabled or retention is zero.
  - Honors high-sensitivity config indirectly through the zero-retention transcript policy.
  - Supports AES-256-GCM encrypted local metadata when configured with local key material.
  - Lists, reads, decrypts, and cleans local session metadata using a retention-day policy.
  - Does not upload transcripts or crash/session metadata.
prohibited_sources_checked:
  - old source code was not copied
  - old inline source maps were not used
---

# Storage Provenance

The storage module is local-only and aligned with transcript retention requirements.
