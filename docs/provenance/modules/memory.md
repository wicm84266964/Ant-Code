---
module: src/memory
owner: lab-tooling
implementation_status: clean-room
implementer_old_source_exposure: limited-audit-context
references:
  - lab_spec: docs/specs/mvp-product-spec.md
design_notes:
  - Loads only lab-owned project memory filenames.
  - Appends project memory to `.lab-agent/memory.md` through explicit local commands.
  - Rejects empty and oversized memory entries.
  - Cloud memory sync is out of scope for MVP.
prohibited_sources_checked:
  - old source code was not copied
  - old inline source maps were not used
---

# Memory Provenance

The memory loader and updater follow the local-only memory layer described in the MVP product spec.
