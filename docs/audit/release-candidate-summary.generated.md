# Ant Code v3.0 Internal Release Summary

Generated: not-recorded-deterministic-artifact
Package: @ant-code/cli@3.0.0
Public name: Ant Code
Public CLI: ant-code
Internal compatibility alias: lab-agent

## Acceptance Posture

- Local install readiness is checked by `npm run verify:install`.
- Full local release readiness is checked by `npm run verify:release`.
- Clean-room release seal is checked by `npm run check:release-seal`.
- Model traffic uses the model gateway/model adapter boundary.
- Tools execute locally; remote tool servers are not required for MVP.
- v1.0-v1.4 internal acceptance and v3.0 Dashboard acceptance are recorded in the deployment acceptance notes.
- Broad rollout still requires live model adapter evidence from `node scripts/verify-gateway-compat.js --live --json`.

## Required Commands

```sh
npm run verify:install
npm run verify:release
npm run check:release-seal
node scripts/verify-gateway-compat.js --live --json
```

## Evidence Artifacts

| Artifact | Status |
| --- | --- |
| docs/audit/clean-room-release-attestation.md | present |
| docs/audit/mvp-release-audit.generated.md | present |
| docs/audit/endpoint-manifest.generated.json | present |
| docs/audit/provenance-summary.generated.md | present |
| docs/audit/dependency-sbom.generated.json | present |
| docs/audit/dependency-license-summary.generated.md | present |
| docs/deployment/rc-acceptance-summary.md | present |
| docs/deployment/v1.0-acceptance.md | present |
| docs/deployment/v1.1-experience-acceptance.md | present |
| docs/deployment/v1.2-tui-acceptance.md | present |
| docs/deployment/v1.3-agent-extension-acceptance.md | present |
| docs/deployment/v1.4-orchestration-acceptance.md | present |
| docs/deployment/v3.0-dashboard-acceptance.md | present |
| docs/deployment/release-candidate-package.md | present |
| docs/deployment/model-adapter-gateway-readiness.md | present |
| docs/deployment/lab-user-quickstart.md | present |
| docs/deployment/local-installation.md | present |

## External Gates

- Real model adapter URL, health URL, authentication, quota, and retention policy must be approved by lab operators.
- Sensitive projects must use high-sensitivity mode or an approved encrypted metadata policy.
- Any future remote tools require a separate reviewed protocol and are out of scope for this MVP.
