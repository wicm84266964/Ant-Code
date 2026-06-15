# Ant Code v3.0 Release Audit Report

Generated: not-recorded-deterministic-artifact
Package: @ant-code/cli@3.0.0
Public name: Ant Code
Public CLI: ant-code
Internal implementation codename: lab-agent

## Scope

- Ant Code clean-room local coding agent v3.0 open-source source release.
- Local-first operation with lab model gateway boundary.
- No direct provider keys or forbidden cloud service dependencies in runtime source.

## Evidence

- Source files: 105
- Test files: 58
- Module provenance records: 19
- Endpoint manifest: docs/audit/endpoint-manifest.generated.json
- Provenance summary: docs/audit/provenance-summary.generated.md
- Dependency SBOM: docs/audit/dependency-sbom.generated.json
- Dependency license summary: docs/audit/dependency-license-summary.generated.md
- Clean-room release attestation: docs/audit/clean-room-release-attestation.md
- Release candidate summary: docs/audit/release-candidate-summary.generated.md
- Gateway rollout checklist: docs/deployment/lab-gateway-rollout-checklist.md
- Release candidate package: docs/deployment/release-candidate-package.md
- v1.0 acceptance record: docs/deployment/v1.0-acceptance.md
- v1.1 experience acceptance record: docs/deployment/v1.1-experience-acceptance.md
- v1.2 TUI acceptance record: docs/deployment/v1.2-tui-acceptance.md
- v1.3 agent extension acceptance record: docs/deployment/v1.3-agent-extension-acceptance.md
- v1.4 orchestration acceptance record: docs/deployment/v1.4-orchestration-acceptance.md
- v3.0 Dashboard acceptance record: docs/deployment/v3.0-dashboard-acceptance.md
- Lab user quickstart: docs/deployment/lab-user-quickstart.md
- Local installation guide: docs/deployment/local-installation.md
- Model adapter readiness guide: docs/deployment/model-adapter-gateway-readiness.md
- Gateway compatibility matrix: docs/specs/lab-model-gateway-compatibility-matrix.md
- Pre-launch security config: docs/deployment/pre-launch-security-config.md
- Lab config template: config/lab-agent.lab-template.json
- High-sensitivity config template: config/lab-agent.high-sensitivity-template.json
- Public identity record: docs/branding/public-identity.md

## Required Release Command

```sh
npm run verify:release
```

This command runs syntax checks, forbidden endpoint scan, provenance check, release seal check, dependency policy check, unit/integration tests, install readiness, mock gateway compatibility, readiness documentation checks, and regenerates audit artifacts.

Gateway compatibility can also be run directly:

```sh
npm run verify:gateway
```

The default compatibility check uses the local mock gateway. `node scripts/verify-gateway-compat.js --live` uses only the configured lab gateway endpoints and should be run before broad rollout.

Gateway rollout readiness materials can also be checked directly:

```sh
npm run verify:readiness
```

Dependency audit artifacts are generated locally without registry lookups:

```sh
npm run check:dependencies
npm run check:release-seal
npm run audit:sbom
npm run audit:licenses
```

## Runtime Boundary Summary

- Public command name is `ant-code`; `lab-agent` remains an internal compatibility alias.
- User-facing diagnostics and rollout material use the Ant Code public name while protocol, config, and metadata compatibility anchors remain stable.
- Model gateway metadata declares the intended boundary: local client tool execution, gateway-only provider credentials, and no MVP remote tools.
- Release seal checks validate clean-room attestation material, runtime source markers, public identity, package privacy, reviewed runtime dependency evidence, and local tool/model-adapter boundary evidence.
- Dependency policy checks validate reviewed runtime dependencies, package-lock integrity, and npm-shrinkwrap parity for reproducible packaged releases.
- Release candidate packaging includes a generated RC summary and human-readable acceptance summary for lab review.
- Model traffic is configured only by `LAB_MODEL_GATEWAY_URL`, `LAB_MODEL_GATEWAY_PROTOCOL`, and optional gateway adapter auth.
- Gateway health diagnostics are configured only by `LAB_MODEL_GATEWAY_HEALTH_URL` and are never contacted unless a gateway health command is run with live mode.
- Gateway requests include non-sensitive compatibility metadata, and gateway errors include redacted diagnostic hints.
- Doctor checks deployment readiness for CLI bins, config sources, gateway settings, allowed hosts, metadata policy, MCP servers, provenance, and release audit material.
- Network default is `lab-only`; `offline` permits loopback only.
- MCP is explicit local stdio only in MVP.
- Read-only local git tools provide bounded status and diff output without shell interpolation.
- Repository maps are derived locally from manifests and top-level directories for status, next-action, report, and map commands without persisting raw source contents.
- User-facing local commands use consistent sectioned text output, with `/status --json` reserved for machine-readable automation.
- Command help is grouped by workflow area, and approval prompts name the local execution boundary before risky actions.
- Release candidate deployment material defines freeze criteria, evidence bundles, high-sensitivity rollout requirements, and rollback steps.
- Lab user quickstart material covers first run, gateway setup, daily workflow, sensitive-data mode, and rollback.
- Local installation readiness checks validate CLI bin wiring, Node entrypoint shape, install docs, and startup commands.
- Edit tools provide exact-replacement preflight, dry-run diff previews, stable error codes, replacement-count validation, byte summaries, and bounded diffs before writes.
- `/verify suggest`, `/verify run suggested`, and `/next` connect local validation suggestions to the delivery workflow without persisting raw command output.
- Transcripts/session metadata are local, bounded, retention-limited, can be zero-retention for high-sensitivity projects, and can be encrypted with local key material.
- High-sensitivity mode forces zero-retention metadata and restricts network mode to offline or lab-only.
- Every model turn receives clean-room Ant Code behavior and final-response protocol context through the lab gateway request.
- Delivery status includes a derived task lifecycle stage and detects stale passing validations when later file changes exist.
- Conversation context is budgeted and older turns compact into bounded redacted process-local summaries; persisted metadata stores only context counts and byte totals.
- Interactive chat keeps bounded session context, session-local todo/plan state, recorded changes, validation history, redacted failed-validation repair context, delivery status and concrete next-action hints, review/next/report commands, metadata-only resume, context clearing/compaction, and local per-tool approval prompts; print mode still requires explicit approval flags.
- Ink TUI v1.2 renders the same clean-room session runtime with a modularized local TUI implementation, Chinese-first common UI copy, TUI-owned transcript scrolling, pinned side panels, command panels, queue/session/resume workflows, model-summary-first context compaction, file-by-file patch browsing, diff/patch highlighting for command/tool details, multi-line composer, local approval prompts, and non-TTY fallback.
- v1.0-v1.4 acceptance records cover the clean-room base, TUI experience, local extension runtime, and orchestration milestones.
- v3.0 Dashboard acceptance records the WebUI surface, transcript paging, SSE recovery, session actions, change statistics, packaging, known limitations, and rollback procedure.
- Write and mutating shell tools require explicit local session approval.

## Open Release Risks

- Stage 8 extension depth is partial by release decision: richer skills/task/background/branch/rewind panels and write-capable subagents remain deferred.
- Real lab gateway compatibility should be validated against the deployed gateway before broad model-enabled rollout.
- Dependency audit is package-manifest based; if future dependencies are installed, package metadata should be present locally before release audit generation.
