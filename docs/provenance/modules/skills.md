---
module: src/skills
owner: lab-tooling
implementation_status: clean-room
implementer_old_source_exposure: limited-audit-context
references:
  - lab_spec: docs/specs/mvp-product-spec.md
  - lab_policy: docs/provenance/clean-room-provenance-policy.md
design_notes:
  - Implements a local-only skill registry for bounded instruction resources.
  - Discovers project skills from .lab-agent/skills, .ant-code/skills, .claude/skills, configured skills.paths, and LAB_AGENT_SKILL_PATHS, including explicitly configured external absolute paths.
  - Reads SKILL.md or markdown skill files with a small frontmatter parser for name, description, when_to_use, allowed tools, model, disabled flags, argument-hint, context, agent, paths, and hooks.
  - If a configured root directly contains SKILL.md, treats it as one skill package and does not register sibling README/handoff markdown files as skills.
  - Enforces bounded skill count, file size, and returned content size.
  - Exposes skill list/detail/run formatting for slash commands and model tools.
  - skill_run is instruction-only; it does not execute bundled scripts, install marketplace packages, or contact provider/cloud skill backends.
  - context: fork skills run through a hidden child subagent with ordinary tool and permission boundaries.
  - Checked-in local skills cover codebase orientation, test failure triage, release readiness review, web/document intake, browser/frontend guidance, and project intake.
  - Honors skills.enabled=false by returning a local disabled state.
prohibited_sources_checked:
  - old source code was not copied
  - old inline source maps were not used
---

# Skills Provenance

The skills registry is a fresh local resource loader designed for controlled lab workflows. It intentionally avoids automatic marketplace discovery and script execution. The default skills are lab-authored workflow instructions, not copied provider skills.
