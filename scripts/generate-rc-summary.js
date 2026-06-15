#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { AUDIT_DIR, ROOT, ensureAuditDir, rel } from "./audit-common.js";

const pkg = JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf8"));

const artifacts = [
  "docs/audit/clean-room-release-attestation.md",
  "docs/audit/mvp-release-audit.generated.md",
  "docs/audit/endpoint-manifest.generated.json",
  "docs/audit/provenance-summary.generated.md",
  "docs/audit/dependency-sbom.generated.json",
  "docs/audit/dependency-license-summary.generated.md",
  "docs/deployment/rc-acceptance-summary.md",
  "docs/deployment/v1.0-acceptance.md",
  "docs/deployment/v1.1-experience-acceptance.md",
  "docs/deployment/v1.2-tui-acceptance.md",
  "docs/deployment/v1.3-agent-extension-acceptance.md",
  "docs/deployment/v1.4-orchestration-acceptance.md",
  "docs/deployment/v3.0-dashboard-acceptance.md",
  "docs/deployment/release-candidate-package.md",
  "docs/deployment/model-adapter-gateway-readiness.md",
  "docs/deployment/lab-user-quickstart.md",
  "docs/deployment/local-installation.md"
];

const artifactRows = [];
for (const artifact of artifacts) {
  artifactRows.push({
    artifact,
    present: await exists(path.join(ROOT, artifact))
  });
}

const lines = [
  "# Ant Code v3.0 Internal Release Summary",
  "",
  "Generated: not-recorded-deterministic-artifact",
  `Package: ${pkg.name}@${pkg.version}`,
  "Public name: Ant Code",
  "Public CLI: ant-code",
  "Internal compatibility alias: lab-agent",
  "",
  "## Acceptance Posture",
  "",
  "- Local install readiness is checked by `npm run verify:install`.",
  "- Full local release readiness is checked by `npm run verify:release`.",
  "- Clean-room release seal is checked by `npm run check:release-seal`.",
  "- Model traffic uses the model gateway/model adapter boundary.",
  "- Tools execute locally; remote tool servers are not required for MVP.",
  "- v1.0-v1.4 internal acceptance and v3.0 Dashboard acceptance are recorded in the deployment acceptance notes.",
  "- Broad rollout still requires live model adapter evidence from `node scripts/verify-gateway-compat.js --live --json`.",
  "",
  "## Required Commands",
  "",
  "```sh",
  "npm run verify:install",
  "npm run verify:release",
  "npm run check:release-seal",
  "node scripts/verify-gateway-compat.js --live --json",
  "```",
  "",
  "## Evidence Artifacts",
  "",
  "| Artifact | Status |",
  "| --- | --- |",
  ...artifactRows.map((row) => `| ${row.artifact} | ${row.present ? "present" : "missing"} |`),
  "",
  "## External Gates",
  "",
  "- Real model adapter URL, health URL, authentication, quota, and retention policy must be approved by lab operators.",
  "- Sensitive projects must use high-sensitivity mode or an approved encrypted metadata policy.",
  "- Any future remote tools require a separate reviewed protocol and are out of scope for this MVP.",
  ""
];

await ensureAuditDir();
const outputPath = path.join(AUDIT_DIR, "release-candidate-summary.generated.md");
await fs.writeFile(outputPath, lines.join("\n"), "utf8");
console.log(`Release candidate summary written to ${rel(outputPath)}.`);

/**
 * @param {string} filePath
 */
async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
