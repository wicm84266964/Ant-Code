---
module: src/capabilities
owner: lab-tooling
implementation_status: clean-room
implementer_old_source_exposure: limited-audit-context
references:
  - lab_spec: internal planning record, not included in packaged release artifacts
  - lab_policy: docs/provenance/clean-room-provenance-policy.md
design_notes:
  - Implements a read-only capability inventory for built-in tools, recommended MCP servers, local skills, and configured agent profiles.
  - Formats /capabilities output in Chinese so users can inspect available external capability surfaces without opening source files.
  - Reports recommended MCP servers with their configured default state; self-contained no-key servers can be enabled by default while service-bound servers remain opt-in.
  - Delegates skill discovery to the local skill registry and agent discovery to the profile registry.
  - Does not launch MCP servers, execute skills, call network resources, or mutate workspace state.
prohibited_sources_checked:
  - old source code was not copied
  - old inline source maps were not used
---

# Capabilities Provenance

The capabilities registry is a lab-authored inventory layer for Stage 1-6 external capability landing. It is intentionally descriptive: users can see what Ant Code can use, while actual execution remains inside the existing tool, MCP, skill, agent, and permission runtimes.
