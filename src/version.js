import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FALLBACK_VERSION = "3.0.0";

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolvePackageRoot(env = process.env) {
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
export async function readPackageJson(packageRoot = resolvePackageRoot()) {
  const text = await fs.readFile(path.join(packageRoot, "package.json"), "utf8");
  return JSON.parse(text);
}

/**
 * @param {string} [packageRoot]
 */
export async function getAntCodeVersion(packageRoot = resolvePackageRoot()) {
  try {
    const pkg = await readPackageJson(packageRoot);
    return typeof pkg.version === "string" && pkg.version.length > 0 ? pkg.version : FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
}
