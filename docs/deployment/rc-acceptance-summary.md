# Ant Code RC Acceptance Summary

This document is the human-readable acceptance summary for an Ant Code release candidate. The accepted v1.0 baseline is recorded in `docs/deployment/v1.0-acceptance.md`; the current v3.0 Dashboard release line is recorded in `docs/deployment/v3.0-dashboard-acceptance.md`.

## Candidate Scope

The candidate provides:

- local CLI entrypoints through `ant-code`
- local file, git, shell, workflow, memory, and MCP boundaries
- local permission checks for writes and mutating commands
- model gateway/model adapter support for provider-independent model traffic
- no MVP dependency on remote tool servers
- local session metadata controls, including high-sensitivity zero-retention mode
- accepted Stage 1-7 TUI experience surfaces, recorded in
  `docs/deployment/v1.2-tui-acceptance.md`
- accepted local agent extension and orchestration records in
  `docs/deployment/v1.3-agent-extension-acceptance.md` and
  `docs/deployment/v1.4-orchestration-acceptance.md`
- local Dashboard/WebUI release surface, recorded in
  `docs/deployment/v3.0-dashboard-acceptance.md`
- clean-room provenance and release seal evidence

## Acceptance Criteria

The candidate is acceptable for controlled lab rollout when:

- `npm run verify:release` passes from a clean working tree
- `npm run check:release-seal` passes
- `npm run verify:install` passes
- `ant-code doctor` has no unexpected errors on target lab machines
- `node scripts/verify-gateway-compat.js --live --json` passes against the chosen model adapter before broad model-enabled use
- high-sensitivity projects use zero-retention or approved encrypted local metadata
- lab operators have documented gateway/model adapter quota, retention, and rollback policy
- Stage 7 live TUI smoke is either passed or documented as a known issue with
  an explicit release decision

## Current Non-Goals

The candidate does not include:

- remote tool execution
- cloud remote sessions
- public plugin marketplace access
- direct provider credentials in the local client
- transcript upload
- public package publishing

## Current TUI Status

The current TUI acceptance posture is:

- Stage 1-6: accepted for the internal build.
- Stage 7: accepted for the controlled build. Sessions/resume,
  long-output scrolling, `Ctrl+O`, `/guide`, `/compact`, permission flows, and
  common command surfaces have direct operator acceptance; queue, file mention,
  and remaining shortcut edge cases have automated coverage and an explicit
  non-blocking release decision.
- Stage 8: partial and non-blocking; local MCP and readonly agents are
  functional, while richer extension panels and skills remain deferred with
  visible disabled/local-replacement states.
- Stage 9: automated hardening passed on 2026-04-29. `npm run check` passed
  with 241 tests, `npm run verify:release` passed, generated audit/release
  artifacts were refreshed, the final Stage 7 release decision is recorded, and
  package hashing is recorded outside the package before distribution. Live
  gateway evidence is deferred on this workstation because
  `LAB_MODEL_GATEWAY_URL` and `LAB_MODEL_GATEWAY_HEALTH_URL` are not configured;
  lab-operator live evidence is still required before broad model-enabled
  rollout.

Use `docs/deployment/v1.2-tui-acceptance.md` as the detailed checklist.

## First Cohort Recommendation

Start with a small internal cohort using:

- one lab-managed model adapter endpoint
- one approved model alias
- high-sensitivity mode for private research projects
- local-only tools and explicit write/command approvals
- mandatory `/report` output before handing off changed code

## Rollback Summary

Disable model turns by unsetting `LAB_MODEL_GATEWAY_URL` and `LAB_MODEL_GATEWAY_HEALTH_URL`, then set `LAB_AGENT_NETWORK_MODE=offline`. Local slash commands, diagnostics, and cleanup remain available without model access.
