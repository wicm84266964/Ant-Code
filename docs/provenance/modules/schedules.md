---
module: src/schedules
owner: lab-tooling
implementation_status: independent
implementer_old_source_exposure: none
references:
  - lab_spec: docs/specs/tool-and-permission-spec.md
  - standard: Node.js fs/promises and Intl.DateTimeFormat
design_notes:
  - Stores host-owned scheduled prompts under the project `.lab-agent/schedules/` directory.
  - Supports one-time, daily, weekly, and interval cadences.
  - Requires an in-session confirmation before a schedule is saved.
  - Fired runs use full access and do not pause for another permission prompt.
  - Skips a due run when the bound session is already running or in Goal mode.
  - Does not copy an external scheduler implementation.
prohibited_sources_checked:
  - old source code was not copied
  - old inline source maps were not used
---

# Schedules Provenance

Scheduled prompts are a local host clock. The saved prompt is sent back into the bound session when it is due.
