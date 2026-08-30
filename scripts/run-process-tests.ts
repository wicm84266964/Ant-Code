#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizedTestEnvironment } from "./run-tests.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROCESS_TEST_PATTERN = [
  "dashboard runtime starts cancellable background terminal tasks",
  "background terminal tools list and cancel registered tasks",
  "background shell registry reconciles externally killed terminal tasks"
].join("|");

const suites = [
  ["tests/integration/session-persistence-process.test.ts"],
  [
    `--test-name-pattern=${PROCESS_TEST_PATTERN}`,
    "tests/unit/dashboard-runtime.test.ts",
    "tests/unit/tools.test.ts"
  ]
];

const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "ant-code-process-test-home-"));
try {
  for (const args of suites) {
    const code = await runNodeTests(args, testHome);
    if (code !== 0) {
      process.exitCode = code;
      break;
    }
  }
} finally {
  await fs.rm(testHome, { recursive: true, force: true });
}

function runNodeTests(args: readonly string[], testHome: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", ...args], {
      cwd: ROOT,
      env: sanitizedTestEnvironment(process.env, testHome),
      stdio: "inherit",
      windowsHide: true
    });
    child.once("error", (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      resolve(1);
    });
    child.once("exit", (code, signal) => resolve(signal ? 1 : (code ?? 1)));
  });
}
