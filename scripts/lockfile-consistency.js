import fs from "node:fs/promises";
import path from "node:path";

/**
 * @param {string} root
 * @param {{ required?: boolean }} [options]
 */
export async function collectLockfileConsistencyFailures(root, options = {}) {
  const required = options.required ?? true;
  const lockPath = path.join(root, "package-lock.json");
  const shrinkwrapPath = path.join(root, "npm-shrinkwrap.json");
  const [lockText, shrinkwrapText] = await Promise.all([
    fs.readFile(lockPath, "utf8").catch(() => null),
    fs.readFile(shrinkwrapPath, "utf8").catch(() => null)
  ]);
  const failures = [];

  if (lockText === null) {
    if (required) {
      failures.push("package-lock.json is required when external dependencies are declared");
    }
    return failures;
  }
  if (shrinkwrapText === null) {
    if (required) {
      failures.push("npm-shrinkwrap.json is required so packaged releases keep the reviewed dependency graph");
    }
    return failures;
  }
  if (lockText !== shrinkwrapText) {
    failures.push("npm-shrinkwrap.json must match package-lock.json exactly");
  }
  return failures;
}
