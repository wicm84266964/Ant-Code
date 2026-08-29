#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { AUDIT_DIR, collectFiles, ensureAuditDir, rel, stableJson } from "./audit-common.js";

const SCAN_ROOTS = Object.freeze(["src", "scripts", "tests", "package.json"]);
const EXTENSIONS = new Set([".js", ".json"]);
const URL_PATTERN = /\bhttps?:\/\/[^\s"'`<>\\)]+/g;
const ENV_PATTERN = /\bLAB_[A-Z0-9_]+\b/g;
const IGNORE_FILES = new Set(["scripts/generate-endpoint-manifest.js"]);

const files = await collectFiles(SCAN_ROOTS, {
  extensions: EXTENSIONS,
  ignoreDirs: new Set(["node_modules", ".git", "coverage"])
});

const urls = [];
const envVars = new Set();

for (const filePath of files) {
  if (IGNORE_FILES.has(rel(filePath))) {
    continue;
  }
  const text = await fs.readFile(filePath, "utf8");
  for (const match of text.matchAll(URL_PATTERN)) {
    urls.push(classifyUrl(match[0], rel(filePath), lineForOffset(text, match.index ?? 0)));
  }
  for (const match of text.matchAll(ENV_PATTERN)) {
    if (match[0] === "LAB_AGENT") {
      continue;
    }
    envVars.add(match[0]);
  }
}

const manifest = {
  generatedAt: "not-recorded-deterministic-artifact",
  policy: {
    runtimeModelTraffic: "LAB_MODEL_GATEWAY_URL",
    networkDefault: "lab-only",
    mcpDefault: "explicit local stdio only",
    directProviderKeysInClient: "forbidden"
  },
  declaredRuntimeEndpoints: [
    {
      name: "Lab model gateway",
      configuredBy: "LAB_MODEL_GATEWAY_URL",
      allowedByDefault: true,
      notes: "All model traffic must pass through this lab-approved endpoint."
    },
    {
      name: "Lab model gateway health",
      configuredBy: "LAB_MODEL_GATEWAY_HEALTH_URL",
      allowedByDefault: true,
      notes: "Optional health endpoint used only by explicit gateway diagnostics and compatibility checks."
    },
    {
      name: "Lab model gateway protocol",
      configuredBy: "LAB_MODEL_GATEWAY_PROTOCOL",
      allowedByDefault: true,
      notes: "Protocol selector only; defaults to the lab-owned protocol and can enable OpenAI Chat compatible adapters."
    },
    {
      name: "Lab model gateway adapter auth",
      configuredBy: "LAB_MODEL_GATEWAY_API_KEY",
      allowedByDefault: true,
      notes: "Optional bearer token for gateway access control; provider keys remain forbidden in the local client."
    },
    {
      name: "Approved host allowlist",
      configuredBy: "LAB_AGENT_ALLOWED_HOSTS",
      allowedByDefault: false,
      notes: "Only used by explicit policy modes."
    }
  ],
  staticUrlLiterals: urls.sort(compareUrlEntry),
  environmentVariables: Array.from(envVars).sort()
};

await ensureAuditDir();
const outputPath = path.join(AUDIT_DIR, "endpoint-manifest.generated.json");
await fs.writeFile(outputPath, stableJson(manifest), "utf8");
console.log(`Endpoint manifest written to ${rel(outputPath)}.`);

/**
 * @param {string} rawUrl
 * @param {string} file
 * @param {number} line
 */
function classifyUrl(rawUrl, file, line) {
  const cleaned = rawUrl.replace(/[.,;:]$/, "");
  if (cleaned.includes("${")) {
    const dynamicLoopback = cleaned.startsWith("http://127.0.0.1") || cleaned.startsWith("http://localhost");
    const scope = file.startsWith("tests/")
      ? "test"
      : file.startsWith("scripts/mock-gateway") || file.startsWith("scripts/verify-gateway-compat")
        ? "development"
        : "dynamic";
    return {
      url: cleaned,
      host: dynamicLoopback ? "loopback-template" : "dynamic-template",
      file,
      line,
      scope,
      allowedByDefault: dynamicLoopback && scope !== "dynamic",
      notes: dynamicLoopback ? "loopback development/test endpoint" : "dynamic template URL; review source context"
    };
  }

  const url = new URL(cleaned);
  const isLoopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  const isExample = url.hostname.endsWith(".example");
  const scope = file.startsWith("tests/")
    ? "test"
    : file.startsWith("scripts/mock-gateway") || file.startsWith("scripts/verify-gateway-compat")
      ? "development"
      : "runtime-or-script";

  return {
    url: url.toString(),
    host: url.hostname,
    file,
    line,
    scope,
    allowedByDefault: (isLoopback || isExample) && scope !== "runtime-or-script",
    notes: isLoopback
      ? "loopback development/test endpoint"
      : isExample
        ? "documentation or test example endpoint"
        : "review required"
  };
}

/**
 * @param {string} text
 * @param {number} offset
 */
function lineForOffset(text, offset) {
  return text.slice(0, offset).split(/\r?\n/).length;
}

function compareUrlEntry(a, b) {
  return `${a.file}:${a.line}:${a.url}`.localeCompare(`${b.file}:${b.line}:${b.url}`);
}
