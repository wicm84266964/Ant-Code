#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const REQUIRED_DOCS = Object.freeze([
  {
    file: "docs/deployment/local-installation.md",
    markers: [
      "## Local Checkout",
      "npm run verify:install",
      "npm link",
      "ant-code doctor",
      "## PowerShell Environment",
      "## Troubleshooting"
    ]
  },
  {
    file: "docs/deployment/model-adapter-gateway-readiness.md",
    markers: [
      "## Boundary",
      "Tools execute on the local client.",
      "## Required Endpoints",
      "node scripts/verify-gateway-compat.js --live --json",
      "## Gateway Responsibilities",
      "## Rollout Questions"
    ]
  },
  {
    file: "docs/deployment/quickstart.md",
    markers: [
      "## First Run",
      "## Connecting The Model Gateway",
      "ant-code doctor",
      "## Daily Code Workflow",
      "## Sensitive Research Data",
      "## Rollback"
    ]
  },
  {
    file: "docs/security/data-boundary.md",
    markers: [
      "## Primary Rule",
      "LAB_MODEL_GATEWAY_URL",
      "LAB_AGENT_NETWORK_MODE",
      "## Model Traffic Boundary"
    ]
  }
]);

const failures = [];

for (const doc of REQUIRED_DOCS) {
  const fullPath = path.join(ROOT, doc.file);
  const text = await fs.readFile(fullPath, "utf8").catch(() => null);
  if (text === null) {
    failures.push(`${doc.file} is missing`);
    continue;
  }
  for (const marker of doc.markers) {
    if (!text.includes(marker)) {
      failures.push(`${doc.file} is missing marker: ${marker}`);
    }
  }
}

await verifyConfigTemplate();

if (failures.length > 0) {
  console.error("Gateway readiness documentation check failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Gateway readiness documentation check passed for ${REQUIRED_DOCS.length + 1} artifacts.`);
}

async function verifyConfigTemplate() {
  const relativePath = "config/lab-agent.lab-template.json";
  const fullPath = path.join(ROOT, relativePath);
  const text = await fs.readFile(fullPath, "utf8").catch(() => null);
  if (text === null) {
    failures.push(`${relativePath} is missing`);
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    failures.push(`${relativePath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  if (parsed.networkMode !== "lab-only") {
    failures.push(`${relativePath} must default to lab-only network mode`);
  }
  if (!Array.isArray(parsed.allowedHosts) || parsed.allowedHosts.length === 0) {
    failures.push(`${relativePath} must declare allowedHosts`);
  }
  if (!parsed.lab?.gatewayUrl || !parsed.lab?.gatewayHealthUrl) {
    failures.push(`${relativePath} must declare gateway and health URLs`);
  }
  if (parsed.transcript?.retentionDays > 30) {
    failures.push(`${relativePath} transcript retention must be 30 days or lower`);
  }
  if (!["off", "optional", "required"].includes(parsed.transcript?.encryption)) {
    failures.push(`${relativePath} must declare transcript encryption policy`);
  }
  if (!Array.isArray(parsed.mcp?.servers)) {
    failures.push(`${relativePath} must declare an MCP server list`);
  }
}
