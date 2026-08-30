#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runStrictTypeCheck } from "./type-ratchet.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const result = runStrictTypeCheck({
  root,
  projectPath: path.join(root, "tsconfig.json")
});
if (!result.ok) {
  console.error("Project type check failed:");
  console.error(result.output);
  process.exitCode = 1;
} else {
  console.log("Project type check passed with 0 diagnostics.");
}
