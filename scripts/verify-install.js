#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { ROOT, rel } from "./audit-common.js";

const failures = [];
const checks = [];

await checkNodeVersion();
await checkPackageJson();
await checkCliEntrypoint();
await checkInstallDocs();

if (failures.length > 0) {
  console.error("Install readiness check failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Install readiness check passed for ${checks.length} checks.`);
}

async function checkNodeVersion() {
  const major = Number.parseInt(process.versions.node.split(".")[0], 10);
  if (major < 20) {
    failures.push(`Node ${process.versions.node} detected; Node 20+ is required`);
  }
  checks.push("node-version");
}

async function checkPackageJson() {
  const pkgPath = path.join(ROOT, "package.json");
  const pkg = JSON.parse(await fs.readFile(pkgPath, "utf8"));
  const expectedBins = {
    "ant-code": "./src/cli/index.js",
    "lab-agent": "./src/cli/index.js"
  };
  for (const [name, target] of Object.entries(expectedBins)) {
    if (pkg.bin?.[name] !== target) {
      failures.push(`package.json bin ${name} must point to ${target}`);
    }
  }
  for (const scriptName of ["doctor", "verify:install", "verify:release", "start"]) {
    if (!pkg.scripts?.[scriptName]) {
      failures.push(`package.json must define script ${scriptName}`);
    }
  }
  checks.push("package-json");
}

async function checkCliEntrypoint() {
  const cliPath = path.join(ROOT, "src", "cli", "index.js");
  const text = await fs.readFile(cliPath, "utf8").catch(() => null);
  if (text === null) {
    failures.push(`${rel(cliPath)} is missing`);
    return;
  }
  if (!text.startsWith("#!/usr/bin/env node")) {
    failures.push(`${rel(cliPath)} must start with a node shebang for linked CLI execution`);
  }
  checks.push("cli-entrypoint");
}

async function checkInstallDocs() {
  await requireDocMarkers("docs/deployment/local-installation.md", [
    "## Local Checkout",
    "npm install",
    "npm link",
    "ant-code doctor",
    "## PowerShell Environment",
    "## Troubleshooting"
  ]);
  await requireDocMarkers("docs/deployment/lab-user-quickstart.md", [
    "ant-code doctor",
    "ant-code -p \"/status\"",
    "Ant Code can still run local slash commands"
  ]);
  checks.push("install-docs");
}

/**
 * @param {string} relativePath
 * @param {string[]} markers
 */
async function requireDocMarkers(relativePath, markers) {
  const fullPath = path.join(ROOT, relativePath);
  const text = await fs.readFile(fullPath, "utf8").catch(() => null);
  if (text === null) {
    failures.push(`${relativePath} is missing`);
    return;
  }
  for (const marker of markers) {
    if (!text.includes(marker)) {
      failures.push(`${relativePath} is missing marker: ${marker}`);
    }
  }
}
