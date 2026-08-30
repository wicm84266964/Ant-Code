#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { AUDIT_DIR, ROOT, ensureAuditDir, rel, stableJson } from "./audit-common.ts";
import {
  collectDeclaredDependencies,
  normalizeLicense,
  readLockedPackage,
  readInstalledPackage,
  readPackageJson,
  type NpmLockfile
} from "./dependency-audit-common.ts";

const pkg = await readPackageJson();
const lock = JSON.parse(await fs.readFile(path.join(ROOT, "package-lock.json"), "utf8")) as NpmLockfile;
const declared = collectDeclaredDependencies(pkg);
const components: Array<{
  type: string;
  name: string;
  scope: string;
  packageSection: string;
  versionSpec: string;
  installedVersion: string | null;
  lockedVersion: string | null;
  license: string;
}> = [];

for (const dependency of declared) {
  const installed = await readInstalledPackage(dependency.name);
  const locked = readLockedPackage(lock, dependency.name);
  components.push({
    type: "library",
    name: dependency.name,
    scope: dependency.scope,
    packageSection: dependency.section,
    versionSpec: dependency.versionSpec,
    installedVersion: installed?.version ?? null,
    lockedVersion: locked?.version ?? null,
    license: normalizeLicense(installed ?? locked)
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
      license: pkg.license ?? (pkg.private ? "private-unlicensed" : "missing"),
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
