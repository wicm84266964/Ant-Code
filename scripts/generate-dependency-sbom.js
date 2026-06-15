#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { AUDIT_DIR, ensureAuditDir, rel, stableJson } from "./audit-common.js";
import {
  collectDeclaredDependencies,
  normalizeLicense,
  readInstalledPackage,
  readPackageJson
} from "./dependency-audit-common.js";

const pkg = await readPackageJson();
const declared = collectDeclaredDependencies(pkg);
const components = [];

for (const dependency of declared) {
  const installed = await readInstalledPackage(dependency.name);
  components.push({
    type: "library",
    name: dependency.name,
    scope: dependency.scope,
    packageSection: dependency.section,
    versionSpec: dependency.versionSpec,
    installedVersion: installed?.version ?? null,
    license: normalizeLicense(installed)
  });
}

const sbom = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  version: 1,
  generatedAt: "not-recorded-deterministic-artifact",
  metadata: {
    component: {
      type: "application",
      name: pkg.name,
      version: pkg.version,
      private: Boolean(pkg.private),
      license: pkg.license ?? "missing",
      properties: [
        { name: "publicName", value: "Ant Code" },
        { name: "publicCli", value: "ant-code" },
        { name: "internalCodename", value: "lab-agent" }
      ]
    },
    dependencyCounts: {
      external: components.length,
      runtime: components.filter((item) => item.scope === "runtime").length,
      development: components.filter((item) => item.scope === "development").length,
      optional: components.filter((item) => item.scope === "optional").length,
      peer: components.filter((item) => item.scope === "peer").length
    }
  },
  components
};

await ensureAuditDir();
const outputPath = path.join(AUDIT_DIR, "dependency-sbom.generated.json");
await fs.writeFile(outputPath, stableJson(sbom), "utf8");
console.log(`Dependency SBOM written to ${rel(outputPath)}.`);
