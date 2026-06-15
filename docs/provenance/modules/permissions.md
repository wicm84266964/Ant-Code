---
module: src/permissions
owner: lab-tooling
implementation_status: clean-room
implementer_old_source_exposure: limited-audit-context
references:
  - lab_spec: docs/specs/tool-and-permission-spec.md
  - lab_security: docs/security/data-boundary.md
  - standard: filesystem path resolution and shell command classification by policy
design_notes:
  - Enforces workspace boundaries, secret-like path strong confirmation, command classification, and network modes.
  - Defaults to ask or deny for risky operations.
  - Allows workspace writes only when a local session approval is present.
  - Requires separate sensitive approval for secret-like reads and file edit writes, even when general workspace write approval is active.
  - Readonly sessions deny write tools even when approval is present.
  - Allows mutating shell commands only when a local session approval is present.
  - Denies network-capable shell commands in offline mode.
  - Allows session-local todo and plan state updates without workspace write approval.
  - Stores workspace trust decisions outside the repository in the Ant Code user config directory, keyed by a salted hash of the resolved workspace path.
  - Supports local trust listing and reset through `/permissions trust list` and `/permissions trust reset`.
  - Requires high-sensitivity sessions to confirm trust per process even when a stored trust record exists.
prohibited_sources_checked:
  - old source code was not copied
  - old inline source maps were not used
---

# Permissions Provenance

The permission engine implements the lab tool and data-boundary policies directly.
