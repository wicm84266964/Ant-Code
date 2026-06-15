# Clean-Room Release Attestation

This attestation records the release boundary for Ant Code. It is a release evidence artifact and should be kept with the generated audit files for each release candidate.

## Clean-Room Statement

Ant Code is implemented as a local coding agent. The implementation in this repository is intended to be independent work based on project requirements, public documentation, public standards, and behavior-level product expectations.

The non-public source material remains out of scope. It is not a source for code, tests, generated bundles, source maps, prompts, runtime assets, private endpoint schemas, UI component structure, or internal state-machine structure.

## Allowed Design Inputs

Allowed inputs for this repository:

- project-owned product, security, deployment, and usability requirements
- public documentation and public standards
- provider-independent protocol design
- black-box behavior descriptions at the user-workflow level
- locally authored tests derived from the clean MVP specification
- reviewed public open-source packages with license, lockfile, SBOM, and module provenance evidence

## Prohibited Inputs

The release must not include:

- copied non-public source code
- decompiled or reconstructed private implementation details
- private generated bundles or fixtures
- private cloud endpoint contracts
- private feature flag or telemetry service concepts
- private transcript or prompt assets
- private test snapshots or golden outputs

## Data Boundary

Release boundary:

- Local tools execute on the Ant Code client.
- The model gateway/model adapter receives model traffic only when configured.
- Provider credentials remain inside the gateway/model adapter service boundary.
- Remote tool servers are not required for MVP.
- Session metadata is local, bounded, and can be disabled or forced to zero retention for high-sensitivity projects.

## Release Evidence

Required release evidence:

- `npm run verify:release` output summary
- `npm run check:release-seal` output
- `docs/audit/mvp-release-audit.generated.md`
- `docs/audit/endpoint-manifest.generated.json`
- `docs/audit/provenance-summary.generated.md`
- `docs/audit/dependency-sbom.generated.json`
- `docs/deployment/release-candidate-package.md`
- live model gateway compatibility evidence when a real gateway/model adapter is used

## Reviewer Notes

Reviewers should confirm:

- The public product name remains Ant Code.
- Internal `lab-agent` names appear only as compatibility anchors.
- Runtime source has no forbidden cloud endpoint markers.
- Runtime dependencies are either absent or present only in the reviewed open-source dependency allowlist.
- Deployment documents explain that tools run locally.
- High-sensitivity mode remains available before handling private research data.
