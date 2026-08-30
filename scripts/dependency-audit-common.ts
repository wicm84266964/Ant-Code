import fs from "node:fs/promises";
import path from "node:path";
import { ROOT } from "./audit-common.ts";

export const DEPENDENCY_SECTIONS = Object.freeze([
  ["dependencies", "runtime"],
  ["optionalDependencies", "optional"],
  ["peerDependencies", "peer"],
  ["devDependencies", "development"]
] as const);

export type PackageJsonLike = {
  name?: string;
  version?: string;
  license?: string;
  private?: boolean;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

export type DeclaredDependency = {
  name: string;
  versionSpec: string;
  section: (typeof DEPENDENCY_SECTIONS)[number][0];
  scope: (typeof DEPENDENCY_SECTIONS)[number][1];
};

export type LockfilePackage = {
  version?: string;
  license?: string;
  integrity?: string;
  resolved?: string;
  hasInstallScript?: boolean;
};

export type NpmLockfile = {
  packages?: Record<string, LockfilePackage | undefined>;
};

export type InstalledPackage = {
  version?: string;
  license?: string;
  licenses?: Array<string | { type?: string }>;
};

export async function readPackageJson(): Promise<PackageJsonLike> {
  const text = await fs.readFile(path.join(ROOT, "package.json"), "utf8");
  return JSON.parse(text) as PackageJsonLike;
}

/**
 * @param {PackageJsonLike} pkg
 */
export function collectDeclaredDependencies(pkg: PackageJsonLike): DeclaredDependency[] {
  const dependencies: DeclaredDependency[] = [];
  for (const [section, scope] of DEPENDENCY_SECTIONS) {
    const values = pkg[section];
    if (!values) {
      continue;
    }
    for (const [name, versionSpec] of Object.entries(values)) {
      dependencies.push({
        name,
        versionSpec,
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
export async function readInstalledPackage(packageName: string): Promise<InstalledPackage | null> {
  const packagePath = path.join(ROOT, "node_modules", ...packageName.split("/"), "package.json");
  const text = await fs.readFile(packagePath, "utf8").catch(() => null);
  return text ? JSON.parse(text) as InstalledPackage : null;
}

/**
 * @param {NpmLockfile} lock
 * @param {string} packageName
 */
export function readLockedPackage(lock: NpmLockfile, packageName: string): LockfilePackage | null {
  return lock.packages?.[`node_modules/${packageName}`] ?? null;
}

/**
 * @param {InstalledPackage | LockfilePackage | null} installed
 */
export function normalizeLicense(installed: InstalledPackage | LockfilePackage | null) {
  if (!installed) {
    return "not-installed-or-undocumented";
  }
  if (typeof installed.license === "string") {
    return installed.license;
  }
  if ("licenses" in installed && Array.isArray(installed.licenses)) {
    return installed.licenses
      .map((item) => typeof item === "string" ? item : item.type)
      .filter((value): value is string => Boolean(value))
      .join(" OR ") || "undocumented";
  }
  return "undocumented";
}
