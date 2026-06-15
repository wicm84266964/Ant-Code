#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { AUDIT_DIR, ensureAuditDir, rel } from "./audit-common.js";
import {
  collectDeclaredDependencies,
  normalizeLicense,
  readInstalledPackage,
  readPackageJson
} from "./dependency-audit-common.js";

const pkg = await readPackageJson();
const dependencies = collectDeclaredDependencies(pkg);
const rows = [];

for (const dependency of dependencies) {
  const installed = await readInstalledPackage(dependency.name);
  rows.push({
    name: dependency.name,
    scope: dependency.scope,
    version: installed?.version ?? dependency.versionSpec,
    license: normalizeLicense(installed)
  });
}

const lines = [
  "# Dependency License Summary",
  "",
  "Generated: not-recorded-deterministic-artifact",
  "",
  `Root package: ${pkg.name}@${pkg.version}`,
  "Public name: Ant Code",
  "Public CLI: ant-code",
  "Internal codename: lab-agent",
  `Root license: ${pkg.license ?? "missing"}`,
  `External dependencies: ${rows.length}`,
  "",
  rows.length === 0
    ? "No external dependencies are declared in package.json."
    : "| Package | Scope | Version | License |",
  ...(rows.length === 0
    ? []
    : [
        "| --- | --- | --- | --- |",
        ...rows.map((row) => `| ${row.name} | ${row.scope} | ${row.version} | ${row.license} |`)
      ]),
  "",
  "## Policy Notes",
  "",
  "- Generated from package.json and installed package metadata when available.",
  "- Registry lookups are intentionally not performed during audit generation.",
  "- Non-registry dependency specs, install-time package scripts, missing lockfile integrity, and non-HTTPS lockfile resolved URLs are blocked by `npm run check:dependencies`.",
  ""
];

await ensureAuditDir();
const outputPath = path.join(AUDIT_DIR, "dependency-license-summary.generated.md");
await fs.writeFile(outputPath, lines.join("\n"), "utf8");
console.log(`Dependency license summary written to ${rel(outputPath)}.`);
