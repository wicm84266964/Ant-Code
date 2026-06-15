#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { AUDIT_DIR, ROOT, collectFiles, ensureAuditDir, rel } from "./audit-common.js";

const pkg = JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf8"));
const sourceFiles = await collectFiles(["src"], { extensions: new Set([".js"]) });
const testFiles = await collectFiles(["tests"], { extensions: new Set([".js"]) });
const provenanceFiles = await collectFiles(["docs/provenance/modules"], { extensions: new Set([".md"]) });

const endpointManifestPath = path.join(AUDIT_DIR, "endpoint-manifest.generated.json");
const provenanceSummaryPath = path.join(AUDIT_DIR, "provenance-summary.generated.md");
const dependencySbomPath = path.join(AUDIT_DIR, "dependency-sbom.generated.json");
const dependencyLicensePath = path.join(AUDIT_DIR, "dependency-license-summary.generated.md");
const cleanRoomAttestationPath = path.join(AUDIT_DIR, "clean-room-release-attestation.md");
const rcSummaryPath = path.join(AUDIT_DIR, "release-candidate-summary.generated.md");
const rolloutChecklistPath = path.join(ROOT, "docs", "deployment", "lab-gateway-rollout-checklist.md");
const releaseCandidatePackagePath = path.join(ROOT, "docs", "deployment", "release-candidate-package.md");
const v1AcceptancePath = path.join(ROOT, "docs", "deployment", "v1.0-acceptance.md");
const v11AcceptancePath = path.join(ROOT, "docs", "deployment", "v1.1-experience-acceptance.md");
const v12AcceptancePath = path.join(ROOT, "docs", "deployment", "v1.2-tui-acceptance.md");
const v13AcceptancePath = path.join(ROOT, "docs", "deployment", "v1.3-agent-extension-acceptance.md");
const v14AcceptancePath = path.join(ROOT, "docs", "deployment", "v1.4-orchestration-acceptance.md");
const v30AcceptancePath = path.join(ROOT, "docs", "deployment", "v3.0-dashboard-acceptance.md");
const labUserQuickstartPath = path.join(ROOT, "docs", "deployment", "lab-user-quickstart.md");
const localInstallationPath = path.join(ROOT, "docs", "deployment", "local-installation.md");
const modelAdapterReadinessPath = path.join(ROOT, "docs", "deployment", "model-adapter-gateway-readiness.md");
const compatibilityMatrixPath = path.join(ROOT, "docs", "specs", "lab-model-gateway-compatibility-matrix.md");
const securityConfigPath = path.join(ROOT, "docs", "deployment", "pre-launch-security-config.md");
const labConfigTemplatePath = path.join(ROOT, "config", "lab-agent.lab-template.json");
const highSensitivityTemplatePath = path.join(ROOT, "config", "lab-agent.high-sensitivity-template.json");
const endpointManifestExists = await exists(endpointManifestPath);
const provenanceSummaryExists = await exists(provenanceSummaryPath);
const dependencySbomExists = await exists(dependencySbomPath);
const dependencyLicenseExists = await exists(dependencyLicensePath);
const cleanRoomAttestationExists = await exists(cleanRoomAttestationPath);
const rcSummaryExists = await exists(rcSummaryPath);
const rolloutChecklistExists = await exists(rolloutChecklistPath);
const releaseCandidatePackageExists = await exists(releaseCandidatePackagePath);
const v1AcceptanceExists = await exists(v1AcceptancePath);
const v11AcceptanceExists = await exists(v11AcceptancePath);
const v12AcceptanceExists = await exists(v12AcceptancePath);
const v13AcceptanceExists = await exists(v13AcceptancePath);
const v14AcceptanceExists = await exists(v14AcceptancePath);
const v30AcceptanceExists = await exists(v30AcceptancePath);
const labUserQuickstartExists = await exists(labUserQuickstartPath);
const localInstallationExists = await exists(localInstallationPath);
const modelAdapterReadinessExists = await exists(modelAdapterReadinessPath);
const compatibilityMatrixExists = await exists(compatibilityMatrixPath);
const securityConfigExists = await exists(securityConfigPath);
const labConfigTemplateExists = await exists(labConfigTemplatePath);
const highSensitivityTemplateExists = await exists(highSensitivityTemplatePath);

const lines = [
  "# Ant Code v3.0 Release Audit Report",
  "",
  "Generated: not-recorded-deterministic-artifact",
  `Package: ${pkg.name}@${pkg.version}`,
  "Public name: Ant Code",
  "Public CLI: ant-code",
  "Internal implementation codename: lab-agent",
  "",
  "## Scope",
  "",
  "- Ant Code clean-room local coding agent v3.0 open-source source release.",
  "- Local-first operation with lab model gateway boundary.",
  "- No direct provider keys or forbidden cloud service dependencies in runtime source.",
  "",
  "## Evidence",
  "",
  `- Source files: ${sourceFiles.length}`,
  `- Test files: ${testFiles.length}`,
  `- Module provenance records: ${provenanceFiles.length}`,
  `- Endpoint manifest: ${endpointManifestExists ? rel(endpointManifestPath) : "missing"}`,
  `- Provenance summary: ${provenanceSummaryExists ? rel(provenanceSummaryPath) : "missing"}`,
  `- Dependency SBOM: ${dependencySbomExists ? rel(dependencySbomPath) : "missing"}`,
  `- Dependency license summary: ${dependencyLicenseExists ? rel(dependencyLicensePath) : "missing"}`,
  `- Clean-room release attestation: ${cleanRoomAttestationExists ? rel(cleanRoomAttestationPath) : "missing"}`,
  `- Release candidate summary: ${rcSummaryExists ? rel(rcSummaryPath) : "missing"}`,
  `- Gateway rollout checklist: ${rolloutChecklistExists ? rel(rolloutChecklistPath) : "missing"}`,
  `- Release candidate package: ${releaseCandidatePackageExists ? rel(releaseCandidatePackagePath) : "missing"}`,
  `- v1.0 acceptance record: ${v1AcceptanceExists ? rel(v1AcceptancePath) : "missing"}`,
  `- v1.1 experience acceptance record: ${v11AcceptanceExists ? rel(v11AcceptancePath) : "missing"}`,
  `- v1.2 TUI acceptance record: ${v12AcceptanceExists ? rel(v12AcceptancePath) : "missing"}`,
  `- v1.3 agent extension acceptance record: ${v13AcceptanceExists ? rel(v13AcceptancePath) : "missing"}`,
  `- v1.4 orchestration acceptance record: ${v14AcceptanceExists ? rel(v14AcceptancePath) : "missing"}`,
  `- v3.0 Dashboard acceptance record: ${v30AcceptanceExists ? rel(v30AcceptancePath) : "missing"}`,
  `- Lab user quickstart: ${labUserQuickstartExists ? rel(labUserQuickstartPath) : "missing"}`,
  `- Local installation guide: ${localInstallationExists ? rel(localInstallationPath) : "missing"}`,
  `- Model adapter readiness guide: ${modelAdapterReadinessExists ? rel(modelAdapterReadinessPath) : "missing"}`,
  `- Gateway compatibility matrix: ${compatibilityMatrixExists ? rel(compatibilityMatrixPath) : "missing"}`,
  `- Pre-launch security config: ${securityConfigExists ? rel(securityConfigPath) : "missing"}`,
  `- Lab config template: ${labConfigTemplateExists ? rel(labConfigTemplatePath) : "missing"}`,
  `- High-sensitivity config template: ${highSensitivityTemplateExists ? rel(highSensitivityTemplatePath) : "missing"}`,
  "- Public identity record: docs/branding/public-identity.md",
  "",
  "## Required Release Command",
  "",
  "```sh",
  "npm run verify:release",
  "```",
  "",
  "This command runs syntax checks, forbidden endpoint scan, provenance check, release seal check, dependency policy check, unit/integration tests, install readiness, mock gateway compatibility, readiness documentation checks, and regenerates audit artifacts.",
  "",
  "Gateway compatibility can also be run directly:",
  "",
  "```sh",
  "npm run verify:gateway",
  "```",
  "",
  "The default compatibility check uses the local mock gateway. `node scripts/verify-gateway-compat.js --live` uses only the configured lab gateway endpoints and should be run before broad rollout.",
  "",
  "Gateway rollout readiness materials can also be checked directly:",
  "",
  "```sh",
  "npm run verify:readiness",
  "```",
  "",
  "Dependency audit artifacts are generated locally without registry lookups:",
  "",
  "```sh",
  "npm run check:dependencies",
  "npm run check:release-seal",
  "npm run audit:sbom",
  "npm run audit:licenses",
  "```",
  "",
  "## Runtime Boundary Summary",
  "",
  "- Public command name is `ant-code`; `lab-agent` remains an internal compatibility alias.",
  "- User-facing diagnostics and rollout material use the Ant Code public name while protocol, config, and metadata compatibility anchors remain stable.",
  "- Model gateway metadata declares the intended boundary: local client tool execution, gateway-only provider credentials, and no MVP remote tools.",
  "- Release seal checks validate clean-room attestation material, runtime source markers, public identity, package privacy, reviewed runtime dependency evidence, and local tool/model-adapter boundary evidence.",
  "- Dependency policy checks validate reviewed runtime dependencies, package-lock integrity, and npm-shrinkwrap parity for reproducible packaged releases.",
  "- Release candidate packaging includes a generated RC summary and human-readable acceptance summary for lab review.",
  "- Model traffic is configured only by `LAB_MODEL_GATEWAY_URL`, `LAB_MODEL_GATEWAY_PROTOCOL`, and optional gateway adapter auth.",
  "- Gateway health diagnostics are configured only by `LAB_MODEL_GATEWAY_HEALTH_URL` and are never contacted unless a gateway health command is run with live mode.",
  "- Gateway requests include non-sensitive compatibility metadata, and gateway errors include redacted diagnostic hints.",
  "- Doctor checks deployment readiness for CLI bins, config sources, gateway settings, allowed hosts, metadata policy, MCP servers, provenance, and release audit material.",
  "- Network default is `lab-only`; `offline` permits loopback only.",
  "- MCP is explicit local stdio only in MVP.",
  "- Read-only local git tools provide bounded status and diff output without shell interpolation.",
  "- Repository maps are derived locally from manifests and top-level directories for status, next-action, report, and map commands without persisting raw source contents.",
  "- User-facing local commands use consistent sectioned text output, with `/status --json` reserved for machine-readable automation.",
  "- Command help is grouped by workflow area, and approval prompts name the local execution boundary before risky actions.",
  "- Release candidate deployment material defines freeze criteria, evidence bundles, high-sensitivity rollout requirements, and rollback steps.",
  "- Lab user quickstart material covers first run, gateway setup, daily workflow, sensitive-data mode, and rollback.",
  "- Local installation readiness checks validate CLI bin wiring, Node entrypoint shape, install docs, and startup commands.",
  "- Edit tools provide exact-replacement preflight, dry-run diff previews, stable error codes, replacement-count validation, byte summaries, and bounded diffs before writes.",
  "- `/verify suggest`, `/verify run suggested`, and `/next` connect local validation suggestions to the delivery workflow without persisting raw command output.",
  "- Transcripts/session metadata are local, bounded, retention-limited, can be zero-retention for high-sensitivity projects, and can be encrypted with local key material.",
  "- High-sensitivity mode forces zero-retention metadata and restricts network mode to offline or lab-only.",
  "- Every model turn receives clean-room Ant Code behavior and final-response protocol context through the lab gateway request.",
  "- Delivery status includes a derived task lifecycle stage and detects stale passing validations when later file changes exist.",
  "- Conversation context is budgeted and older turns compact into bounded redacted process-local summaries; persisted metadata stores only context counts and byte totals.",
  "- Interactive chat keeps bounded session context, session-local todo/plan state, recorded changes, validation history, redacted failed-validation repair context, delivery status and concrete next-action hints, review/next/report commands, metadata-only resume, context clearing/compaction, and local per-tool approval prompts; print mode still requires explicit approval flags.",
  "- Ink TUI v1.2 renders the same clean-room session runtime with a modularized local TUI implementation, Chinese-first common UI copy, TUI-owned transcript scrolling, pinned side panels, command panels, queue/session/resume workflows, model-summary-first context compaction, file-by-file patch browsing, diff/patch highlighting for command/tool details, multi-line composer, local approval prompts, and non-TTY fallback.",
  "- v1.0-v1.4 acceptance records cover the clean-room base, TUI experience, local extension runtime, and orchestration milestones.",
  "- v3.0 Dashboard acceptance records the WebUI surface, transcript paging, SSE recovery, session actions, change statistics, packaging, known limitations, and rollback procedure.",
  "- Write and mutating shell tools require explicit local session approval.",
  "",
  "## Open Release Risks",
  "",
  "- Stage 8 extension depth is partial by release decision: richer skills/task/background/branch/rewind panels and write-capable subagents remain deferred.",
  "- Real lab gateway compatibility should be validated against the deployed gateway before broad model-enabled rollout.",
  "- Dependency audit is package-manifest based; if future dependencies are installed, package metadata should be present locally before release audit generation.",
  ""
];

await ensureAuditDir();
const outputPath = path.join(AUDIT_DIR, "mvp-release-audit.generated.md");
await fs.writeFile(outputPath, lines.join("\n"), "utf8");
console.log(`Ant Code v3.0 audit report written to ${rel(outputPath)}.`);

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
