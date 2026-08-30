#!/usr/bin/env node
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "docs", "provenance", "public-release-allowed-differences.json");
const publicRoot = path.resolve(process.argv[2] ?? process.env.ANT_CODE_PUBLIC_ROOT ?? "");
const execFileAsync = promisify(execFile);

if (!process.argv[2] && !process.env.ANT_CODE_PUBLIC_ROOT) {
  console.error("Usage: node scripts/verify-public-release-parity.ts <public-repository-root>");
  process.exit(2);
}

type ReviewedPath = {
  path: string;
  publicMayBeMissing?: boolean;
  publicContains?: string[];
  publicNotContains?: string[];
};

type PublicReleaseManifest = {
  exactPaths?: string[];
  reviewedDifferences?: ReviewedPath[];
  supportingPublicPaths?: Array<{ path: string; publicContains?: string[] }>;
  scope?: { developmentCommit?: string };
};

const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as PublicReleaseManifest;
const failures: string[] = [];
let exactMatches = 0;
let reviewedMatches = 0;

const declaredPaths = new Set([
  ...(manifest.exactPaths ?? []),
  ...(manifest.reviewedDifferences ?? []).map((entry) => entry.path)
]);
const duplicateCount = (manifest.exactPaths?.length ?? 0)
  + (manifest.reviewedDifferences?.length ?? 0)
  - declaredPaths.size;
if (duplicateCount > 0) {
  failures.push(`manifest declares ${duplicateCount} duplicate path(s)`);
}
const developmentPaths = await commitPaths(manifest.scope?.developmentCommit);
for (const relativePath of developmentPaths) {
  if (!declaredPaths.has(relativePath)) {
    failures.push(`${relativePath}: development commit path is not classified`);
  }
}
for (const relativePath of declaredPaths) {
  if (!developmentPaths.has(relativePath)) {
    failures.push(`${relativePath}: manifest path is outside the scoped development commit`);
  }
}

for (const relativePath of manifest.exactPaths ?? []) {
  const developmentFile = path.join(root, relativePath);
  const publicFile = path.join(publicRoot, relativePath);
  const [developmentHash, publicHash] = await Promise.all([
    fileHash(developmentFile),
    fileHash(publicFile)
  ]);
  if (!developmentHash || !publicHash) {
    failures.push(`${relativePath}: exact-parity file is missing`);
  } else if (developmentHash !== publicHash) {
    failures.push(`${relativePath}: content differs but no reviewed difference is declared`);
  } else {
    exactMatches += 1;
  }
}

for (const entry of manifest.reviewedDifferences ?? []) {
  const publicFile = path.join(publicRoot, entry.path);
  const content = await fs.readFile(publicFile, "utf8").catch(() => null);
  if (content === null) {
    if (entry.publicMayBeMissing === true) {
      reviewedMatches += 1;
      continue;
    }
    failures.push(`${entry.path}: reviewed public file is missing`);
    continue;
  }
  for (const expected of entry.publicContains ?? []) {
    if (!content.includes(expected)) {
      failures.push(`${entry.path}: missing required public content ${JSON.stringify(expected)}`);
    }
  }
  for (const forbidden of entry.publicNotContains ?? []) {
    if (content.includes(forbidden)) {
      failures.push(`${entry.path}: contains forbidden internal content ${JSON.stringify(forbidden)}`);
    }
  }
  reviewedMatches += 1;
}

for (const entry of manifest.supportingPublicPaths ?? []) {
  const publicFile = path.join(publicRoot, entry.path);
  const content = await fs.readFile(publicFile, "utf8").catch(() => null);
  if (content === null) {
    failures.push(`${entry.path}: required supporting public file is missing`);
    continue;
  }
  for (const expected of entry.publicContains ?? []) {
    if (!content.includes(expected)) {
      failures.push(`${entry.path}: missing required supporting content ${JSON.stringify(expected)}`);
    }
  }
}

if (failures.length > 0) {
  console.error("Public release parity check failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(`Public release parity check passed: ${exactMatches} exact paths and ${reviewedMatches} reviewed differences.`);

async function fileHash(filePath: string) {
  const content = await fs.readFile(filePath).catch(() => null);
  return content ? crypto.createHash("sha256").update(content).digest("hex") : null;
}

async function commitPaths(commit: string | undefined) {
  if (!commit) {
    failures.push("manifest does not declare scope.developmentCommit");
    return new Set<string>();
  }
  try {
    const { stdout } = await execFileAsync("git", [
      "diff-tree",
      "--no-commit-id",
      "--name-only",
      "-r",
      commit
    ], { cwd: root, windowsHide: true });
    return new Set(stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  } catch (error) {
    failures.push(`unable to inspect development commit ${commit}: ${error instanceof Error ? error.message : String(error)}`);
    return new Set<string>();
  }
}
