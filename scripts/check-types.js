#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runStrictTypeCheck, runTypeRatchet } from "./type-ratchet.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseline = JSON.parse(await fs.readFile(
  path.join(root, "scripts", "dashboard-type-baseline.json"),
  "utf8"
));
const releaseGateResult = runStrictTypeCheck({
  root,
  projectPath: path.join(root, "tsconfig.release-gates.json")
});
if (!releaseGateResult.ok) {
  console.error("Release gate type check failed:");
  console.error(releaseGateResult.output);
  process.exitCode = 1;
}

const result = await runTypeRatchet({
  root,
  projectPath: path.join(root, "tsconfig.dashboard.json"),
  baseline
});

if (!result.ok) {
  console.error("Dashboard type ratchet failed:");
  for (const failure of result.failures) {
    console.error(`- ${failure}`);
  }
  process.exitCode = 1;
} else if (!process.exitCode) {
  const reductionText = result.reductions > 0 ? `; ${result.reductions} historical diagnostics removed` : "";
  console.log(
    `Dashboard type ratchet passed for ${result.scopeCount} files ` +
    `with ${result.currentCount} baseline technical-debt diagnostics${reductionText}; ` +
    "new diagnostics are blocked."
  );
}
