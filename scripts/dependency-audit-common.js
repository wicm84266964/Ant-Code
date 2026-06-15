import fs from "node:fs/promises";
import path from "node:path";
import { ROOT } from "./audit-common.js";

export const DEPENDENCY_SECTIONS = Object.freeze([
  ["dependencies", "runtime"],
  ["optionalDependencies", "optional"],
  ["peerDependencies", "peer"],
  ["devDependencies", "development"]
]);

export async function readPackageJson() {
  const text = await fs.readFile(path.join(ROOT, "package.json"), "utf8");
  return JSON.parse(text);
}

/**
 * @param {Record<string, any>} pkg
 */
export function collectDeclaredDependencies(pkg) {
  const dependencies = [];
  for (const [section, scope] of DEPENDENCY_SECTIONS) {
    const values = pkg[section] ?? {};
    for (const [name, versionSpec] of Object.entries(values)) {
      dependencies.push({
        name,
        versionSpec: String(versionSpec),
        section,
        scope
      });
    }
  }
  return dependencies.sort((a, b) => `${a.scope}:${a.name}`.localeCompare(`${b.scope}:${b.name}`));
}

/**
 * @param {string} packageName
 */
export async function readInstalledPackage(packageName) {
  const packagePath = path.join(ROOT, "node_modules", ...packageName.split("/"), "package.json");
  const text = await fs.readFile(packagePath, "utf8").catch(() => null);
  return text ? JSON.parse(text) : null;
}

/**
 * @param {Record<string, any> | null} installed
 */
export function normalizeLicense(installed) {
  if (!installed) {
    return "not-installed-or-undocumented";
  }
  if (typeof installed.license === "string") {
    return installed.license;
  }
  if (Array.isArray(installed.licenses)) {
    return installed.licenses
      .map((item) => typeof item === "string" ? item : item?.type)
      .filter(Boolean)
      .join(" OR ") || "undocumented";
  }
  return "undocumented";
}
