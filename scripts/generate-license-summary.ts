#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { AUDIT_DIR, ROOT, ensureAuditDir, rel } from "./audit-common.ts";
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
const dependencies = collectDeclaredDependencies(pkg);
const rows: Array<{
  name: string;
  scope: string;
  version: string;
  license: string;
}> = [];

for (const dependency of dependencies) {
  const installed = await readInstalledPackage(dependency.name);
  const locked = readLockedPackage(lock, dependency.name);
  rows.push({
    name: dependency.name,
    scope: dependency.scope,
    version: installed?.version ?? locked?.version ?? dependency.versionSpec,
    license: normalizeLicense(installed ?? locked)
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
  `Root license: ${pkg.license ?? (pkg.private ? "private-unlicensed" : "missing")}`,
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
