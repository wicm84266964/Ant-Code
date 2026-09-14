import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FALLBACK_VERSION = "2.0.12";

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolvePackageRoot(env: NodeJS.ProcessEnv = process.env) {
  if (env.LAB_AGENT_PACKAGE_ROOT) {
    return path.resolve(env.LAB_AGENT_PACKAGE_ROOT);
  }
  if (process.env.NODE_SEA_EXECUTABLE || process.execPath.toLowerCase().endsWith("ant-code.exe")) {
    return path.dirname(process.execPath);
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

/**
 * @param {string} [packageRoot]
 */
export async function readPackageJson(packageRoot: string = resolvePackageRoot()) {
  const text = await fsPromises.readFile(path.join(packageRoot, "package.json"), "utf8");
  return JSON.parse(text);
}

export function getAntCodeVersionSync(packageRoot: string = resolvePackageRoot()) {
  try {
    const text = fs.readFileSync(path.join(packageRoot, "package.json"), "utf8");
    const pkg = JSON.parse(text);
    return typeof pkg.version === "string" && pkg.version.length > 0 ? pkg.version : FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
}

/**
 * @param {string} [packageRoot]
 */
export async function getAntCodeVersion(packageRoot: string = resolvePackageRoot()) {
  try {
    const pkg = await readPackageJson(packageRoot);
    return typeof pkg.version === "string" && pkg.version.length > 0 ? pkg.version : FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
}
