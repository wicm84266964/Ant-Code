import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildRepoMap, formatRepoMap } from "../../src/core/repo-map.js";

test("repo map detects package metadata and key directories", async () => {
  const cwd = await makeTempWorkspace();
  await fs.mkdir(path.join(cwd, "src"));
  await fs.mkdir(path.join(cwd, "tests"));
  await fs.writeFile(path.join(cwd, "src", "index.js"), "export {}\n", "utf8");
  await fs.writeFile(path.join(cwd, "package.json"), JSON.stringify({
    name: "sample-project",
    type: "module",
    private: true,
    bin: { sample: "src/index.js" },
    scripts: {
      test: "node --test",
      check: "npm test"
    }
  }), "utf8");
  await fs.writeFile(path.join(cwd, "package-lock.json"), "{}\n", "utf8");

  const repoMap = await buildRepoMap(cwd);

  assert.deepEqual(repoMap.projectTypes, ["node"]);
  assert.deepEqual(repoMap.packageManagers, ["npm"]);
  assert.equal(repoMap.package.name, "sample-project");
  assert.deepEqual(repoMap.package.scriptNames, ["check", "test"]);
  assert.deepEqual(repoMap.package.bins, ["sample"]);
  assert.equal(repoMap.keyDirectories.find((entry) => entry.path === "src")?.role, "source");
  assert.equal(repoMap.keyDirectories.find((entry) => entry.path === "tests")?.role, "tests");
  assert.ok(repoMap.sourceEntrypoints.some((entry) => entry.path === "src/index.js"));
  assert.ok(repoMap.testEntrypoints.some((entry) => entry.command === "npm test"));
});

test("formatRepoMap emits a concise local summary", async () => {
  const cwd = await makeTempWorkspace();
  await fs.writeFile(path.join(cwd, "package.json"), JSON.stringify({
    name: "sample-project",
    scripts: { test: "node --test" }
  }), "utf8");

  const output = formatRepoMap(await buildRepoMap(cwd));

  assert.match(output, /Ant Code repository map/);
  assert.match(output, /project types: node/);
  assert.match(output, /scripts: test/);
});

async function makeTempWorkspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
}
