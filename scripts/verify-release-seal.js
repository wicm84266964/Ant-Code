#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { ROOT, collectFiles, rel } from "./audit-common.js";

const failures = [];
const REVIEWED_RUNTIME_DEPENDENCIES = new Map([
  ["ink", {
    versionSpec: "^6.8.0",
    installedVersion: "6.8.0",
    license: "MIT",
    provenanceMarker: "open_source: Ink terminal UI library, MIT licensed, public npm package"
  }],
  ["katex", {
    versionSpec: "^0.16.46",
    installedVersion: "0.16.46",
    license: "MIT",
    provenanceMarker: "open_source: KaTeX math rendering library, MIT licensed, public npm package"
  }],
  ["mermaid", {
    versionSpec: "^11.15.0",
    installedVersion: "11.15.0",
    license: "MIT",
    provenanceMarker: "open_source: Mermaid diagram rendering library, MIT licensed, public npm package"
  }],
  ["react", {
    versionSpec: "^19.2.5",
    installedVersion: "19.2.5",
    license: "MIT",
    provenanceMarker: "open_source: React UI library, MIT licensed, public npm package"
  }],
  ["yaml", {
    versionSpec: "^2.9.0",
    installedVersion: "2.9.0",
    license: "ISC",
    provenanceMarker: "open_source: yaml parser library, ISC licensed, public npm package"
  }]
]);

await verifyRequiredAttestation();
await verifyRuntimeSourceMarkers();
await verifyPackageBoundary();
await verifyReviewedRuntimeDependencies();

if (failures.length > 0) {
  console.error("Release seal check failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log("Release seal check passed.");
}

async function verifyRequiredAttestation() {
  await requireDocMarkers("docs/audit/clean-room-release-attestation.md", [
    "## Clean-Room Statement",
    "## Allowed Design Inputs",
    "## Prohibited Inputs",
    "## Data Boundary",
    "## Release Evidence"
  ]);
  await requireDocMarkers("docs/branding/public-identity.md", [
    "The public project name is **Ant Code**.",
    "Primary CLI command: `ant-code`",
    "Internal Surface Kept Stable"
  ]);
  await requireDocMarkers("docs/deployment/model-adapter-gateway-readiness.md", [
    "Tools execute on the local client.",
    "Provider credentials live inside the gateway/model adapter service boundary"
  ]);
}

async function verifyRuntimeSourceMarkers() {
  const files = await collectFiles(["src", "scripts", "tests", "package.json"], {
    extensions: new Set([".js", ".json"])
  });
  const allowlist = new Set([
    "scripts/verify-forbidden-endpoints.js",
    "scripts/verify-release-seal.js"
  ]);
  const forbidden = [
    "ClaudeCode",
    "sourceMappingURL=data",
    "GrowthBook",
    "Statsig",
    "Datadog",
    "claude.ai",
    "claude_code",
    "Tengu"
  ];

  for (const filePath of files) {
    const relativePath = rel(filePath);
    if (allowlist.has(relativePath)) {
      continue;
    }
    const text = await fs.readFile(filePath, "utf8");
    for (const marker of forbidden) {
      if (text.toLowerCase().includes(marker.toLowerCase())) {
        failures.push(`${relativePath} contains prohibited runtime marker: ${marker}`);
      }
    }
  }
}

async function verifyPackageBoundary() {
  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf8"));
  if (pkg.private !== true) {
    failures.push("package.json must remain private until a reviewed distribution channel is approved");
  }
  if (pkg.name !== "@ant-code/cli") {
    failures.push("package.json name must remain @ant-code/cli for the Ant Code public identity");
  }
}

async function verifyReviewedRuntimeDependencies() {
  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf8"));
  const runtimeDependencies = pkg.dependencies ?? {};
  for (const [name, versionSpec] of Object.entries(runtimeDependencies)) {
    const reviewed = REVIEWED_RUNTIME_DEPENDENCIES.get(name);
    if (!reviewed) {
      failures.push(`runtime dependency ${name} is not in the reviewed dependency allowlist`);
      continue;
    }
    if (versionSpec !== reviewed.versionSpec) {
      failures.push(`runtime dependency ${name} uses ${versionSpec}; reviewed spec is ${reviewed.versionSpec}`);
    }
  }

  for (const name of REVIEWED_RUNTIME_DEPENDENCIES.keys()) {
    if (!Object.hasOwn(runtimeDependencies, name)) {
      continue;
    }
    await verifyRuntimeDependencyEvidence(name, REVIEWED_RUNTIME_DEPENDENCIES.get(name));
  }
}

/**
 * @param {string} name
 * @param {{ versionSpec: string; installedVersion: string; license: string; provenanceMarker: string }} reviewed
 */
async function verifyRuntimeDependencyEvidence(name, reviewed) {
  const lock = await readJson("package-lock.json");
  const locked = lock?.packages?.[`node_modules/${name}`];
  if (!locked) {
    failures.push(`package-lock.json is missing reviewed runtime dependency ${name}`);
  } else {
    if (locked.version !== reviewed.installedVersion) {
      failures.push(`package-lock.json records ${name}@${locked.version}; reviewed version is ${reviewed.installedVersion}`);
    }
    if (locked.license !== reviewed.license) {
      failures.push(`package-lock.json records ${name} license ${locked.license ?? "missing"}; reviewed license is ${reviewed.license}`);
    }
    if (!locked.integrity) {
      failures.push(`package-lock.json records ${name} without an integrity hash`);
    }
  }

  const sbom = await readJson("docs/audit/dependency-sbom.generated.json");
  const sbomComponent = sbom?.components?.find((component) => component.name === name && component.scope === "runtime");
  if (!sbomComponent) {
    failures.push(`dependency SBOM is missing runtime component ${name}`);
  } else {
    if (sbomComponent.installedVersion !== reviewed.installedVersion) {
      failures.push(`dependency SBOM records ${name}@${sbomComponent.installedVersion}; reviewed version is ${reviewed.installedVersion}`);
    }
    if (sbomComponent.license !== reviewed.license) {
      failures.push(`dependency SBOM records ${name} license ${sbomComponent.license}; reviewed license is ${reviewed.license}`);
    }
  }

  await requireDocMarkers("docs/audit/dependency-license-summary.generated.md", [
    `| ${name} | runtime | ${reviewed.installedVersion} | ${reviewed.license} |`
  ]);
  await requireDocMarkers("docs/provenance/modules/cli.md", [
    reviewed.provenanceMarker
  ]);
}

/**
 * @param {string} relativePath
 */
async function readJson(relativePath) {
  const fullPath = path.join(ROOT, relativePath);
  const text = await fs.readFile(fullPath, "utf8").catch(() => null);
  if (text === null) {
    failures.push(`${relativePath} is missing`);
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    failures.push(`${relativePath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * @param {string} relativePath
 * @param {string[]} markers
 */
async function requireDocMarkers(relativePath, markers) {
  const fullPath = path.join(ROOT, relativePath);
  const text = await fs.readFile(fullPath, "utf8").catch(() => null);
  if (text === null) {
    failures.push(`${relativePath} is missing`);
    return;
  }
  for (const marker of markers) {
    if (!text.includes(marker)) {
      failures.push(`${relativePath} is missing marker: ${marker}`);
    }
  }
}
