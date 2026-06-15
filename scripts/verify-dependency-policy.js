#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { collectDeclaredDependencies, readPackageJson } from "./dependency-audit-common.js";
import { ROOT } from "./audit-common.js";

const pkg = await readPackageJson();
const dependencies = collectDeclaredDependencies(pkg);
const failures = [];
const reviewedBuildInstallScriptAllowlist = new Set(["esbuild"]);

for (const scriptName of ["preinstall", "install", "postinstall"]) {
  if (pkg.scripts?.[scriptName]) {
    failures.push(`package.json defines ${scriptName}; install-time scripts require explicit review`);
  }
}

for (const dependency of dependencies) {
  if (/^(https?:|git\+|file:)/i.test(dependency.versionSpec)) {
    failures.push(`${dependency.section}.${dependency.name} uses non-registry spec ${dependency.versionSpec}`);
  }
}

await verifyLockfileDependencyBoundaries(dependencies.length);
await verifyShrinkwrapMatchesLockfile(dependencies.length);

if (failures.length > 0) {
  console.error("Dependency policy check failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Dependency policy check passed for ${dependencies.length} external dependencies.`);
}

async function verifyShrinkwrapMatchesLockfile(declaredDependencyCount) {
  if (declaredDependencyCount === 0) {
    return;
  }
  const lockPath = path.join(ROOT, "package-lock.json");
  const shrinkwrapPath = path.join(ROOT, "npm-shrinkwrap.json");
  const lockText = await fs.readFile(lockPath, "utf8").catch(() => null);
  const shrinkwrapText = await fs.readFile(shrinkwrapPath, "utf8").catch(() => null);
  if (shrinkwrapText === null) {
    failures.push("npm-shrinkwrap.json is required so packaged releases keep the reviewed dependency graph");
    return;
  }
  if (lockText !== shrinkwrapText) {
    failures.push("npm-shrinkwrap.json must match package-lock.json exactly");
  }
}

/**
 * @param {number} declaredDependencyCount
 */
async function verifyLockfileDependencyBoundaries(declaredDependencyCount) {
  const lockPath = path.join(ROOT, "package-lock.json");
  const text = await fs.readFile(lockPath, "utf8").catch(() => null);
  if (text === null) {
    if (declaredDependencyCount > 0) {
      failures.push("package-lock.json is required when external dependencies are declared");
    }
    return;
  }

  let lock;
  try {
    lock = JSON.parse(text);
  } catch (error) {
    failures.push(`package-lock.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const packages = lock.packages ?? {};
  for (const [packagePath, metadata] of Object.entries(packages)) {
    if (packagePath === "" || !packagePath.startsWith("node_modules/")) {
      continue;
    }
    const name = packagePath.slice("node_modules/".length);
    if (metadata?.hasInstallScript && !isReviewedBuildInstallScript(name, pkg)) {
      failures.push(`${name} declares an install script in package-lock.json`);
    }
    if (!metadata?.integrity) {
      failures.push(`${name} is missing an integrity hash in package-lock.json`);
    }
    if (metadata?.resolved && !String(metadata.resolved).startsWith("https://")) {
      failures.push(`${name} has a non-HTTPS resolved URL in package-lock.json`);
    }
  }
}

/**
 * @param {string} name
 * @param {Record<string, any>} rootPackage
 */
function isReviewedBuildInstallScript(name, rootPackage) {
  return reviewedBuildInstallScriptAllowlist.has(name) &&
    Object.hasOwn(rootPackage.devDependencies ?? {}, name) &&
    !Object.hasOwn(rootPackage.dependencies ?? {}, name);
}
