---
module: src/diagnostics
owner: lab-tooling
implementation_status: clean-room
implementer_old_source_exposure: limited-audit-context
references:
  - lab_spec: docs/specs/mvp-product-spec.md
  - lab_architecture: docs/architecture/mvp-architecture.md
design_notes:
  - Checks Node version, CLI bin wiring, config sources, gateway configuration, network mode, allowed hosts, metadata retention/encryption, MCP configuration, provenance files, clean-room release attestation, release audit material, local installation material, release candidate package material, RC acceptance material, and lab user quickstart material.
  - Reports the active sensitivity mode and verifies high-sensitivity zero-retention behavior through config.
  - Reports deployment next-step hints for shared lab-machine rollout.
  - Uses Ant Code public labels in user-facing doctor output while keeping lab-agent internal compatibility anchors unchanged.
  - Gateway health diagnostics are explicit local commands and do not run unless invoked.
  - Reports locally and does not upload diagnostics.
prohibited_sources_checked:
  - old source code was not copied
  - old inline source maps were not used
---

# Diagnostics Provenance

The doctor command is lab-local and does not depend on external telemetry services.
