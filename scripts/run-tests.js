#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL_TEST_ROOTS = Object.freeze(["tests/unit", "tests/integration"]);

export async function collectLocalTestFiles(root = ROOT) {
  const files = [];
  for (const relativeRoot of LOCAL_TEST_ROOTS) {
    await collectTests(path.join(root, relativeRoot), root, files);
  }
  return files.sort();
}

async function collectTests(directory, root, files) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectTests(fullPath, root, files);
    } else if (entry.isFile() && entry.name.endsWith(".test.js")) {
      files.push(path.relative(root, fullPath));
    }
  }
}

async function main() {
  const testFiles = await collectLocalTestFiles();
  if (testFiles.length === 0) {
    throw new Error("No unit or integration tests were found");
  }
  const { runnerArgs, selectedFiles } = selectTestFiles(process.argv.slice(2), testFiles);
  const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "ant-code-test-home-"));
  try {
    process.exitCode = await runTestChild(runnerArgs, selectedFiles, testHome);
  } finally {
    await fs.rm(testHome, { recursive: true, force: true });
  }
}

/**
 * @param {string[]} runnerArgs
 * @param {string[]} selectedFiles
 * @param {string} testHome
 */
function runTestChild(runnerArgs, selectedFiles, testHome) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", ...runnerArgs, ...selectedFiles], {
      cwd: ROOT,
      env: sanitizedTestEnvironment(process.env, testHome),
      stdio: "inherit",
      windowsHide: true
    });
    child.once("error", (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      resolve(1);
    });
    child.once("exit", (code, signal) => {
      resolve(signal ? 1 : (code ?? 1));
    });
  });
}

/**
 * Unit and integration tests provide their own config objects and fixtures.
 * Do not let a developer's live model/gateway/session settings change them.
 *
 * @param {NodeJS.ProcessEnv} source
 * @param {string} [testHome]
 */
export function sanitizedTestEnvironment(source, testHome) {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (
      key.startsWith("LAB_AGENT_")
      || key.startsWith("LAB_MODEL_")
      || key.startsWith("ANTCODE_")
      || key.startsWith("ANT_CODE_DASHBOARD_")
    ) {
      delete env[key];
    }
  }
  if (testHome) {
    env.HOME = testHome;
    env.USERPROFILE = testHome;
  }
  return env;
}

function selectTestFiles(args, testFiles) {
  const runnerArgs = [];
  const requested = new Set();
  for (const argument of args) {
    const candidate = path.resolve(ROOT, argument);
    const relative = path.relative(ROOT, candidate);
    const insideTests = relative === "tests" || relative.startsWith(`tests${path.sep}`);
    if (!insideTests) {
      runnerArgs.push(argument);
      continue;
    }

    const matches = testFiles.filter((file) => {
      const absolute = path.resolve(ROOT, file);
      return absolute === candidate || absolute.startsWith(`${candidate}${path.sep}`);
    });
    if (matches.length === 0) {
      throw new Error(`npm test only accepts tests from tests/unit or tests/integration: ${argument}`);
    }
    for (const match of matches) {
      requested.add(match);
    }
  }
  return {
    runnerArgs,
    selectedFiles: requested.size > 0 ? Array.from(requested).sort() : testFiles
  };
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await main();
}
