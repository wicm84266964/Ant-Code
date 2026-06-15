import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadProjectMemory, loadProjectMemoryManifest } from "../../src/memory/loader.js";
import { appendProjectMemory, projectMemoryPath } from "../../src/memory/store.js";

test("appendProjectMemory writes project-local memory", async () => {
  const cwd = await makeTempWorkspace();
  const result = await appendProjectMemory({
    cwd,
    text: "Prefer local-only analysis.",
    now: new Date("2026-04-28T00:00:00.000Z")
  });

  assert.equal(result.ok, true);
  const content = await fs.readFile(projectMemoryPath(cwd), "utf8");
  assert.match(content, /Prefer local-only analysis/);

  const memories = await loadProjectMemory({ cwd });
  assert.equal(memories.length, 1);
  assert.match(memories[0].content, /Project Memory/);
});

test("project memory loads one prioritized project rule and local memory", async () => {
  const cwd = await makeTempWorkspace();
  await fs.writeFile(path.join(cwd, "AGENTS.md"), "OpenCode rules\n", "utf8");
  await fs.writeFile(path.join(cwd, "AGENT.md"), "Codex single agent rules\n", "utf8");
  await fs.writeFile(path.join(cwd, "CLAUDE.md"), "Compatibility rules\n", "utf8");
  await fs.mkdir(path.join(cwd, ".lab-agent"), { recursive: true });
  await fs.writeFile(path.join(cwd, ".lab-agent", "memory.md"), "# Project Memory\n\nLocal preference\n", "utf8");

  const manifest = await loadProjectMemoryManifest({ cwd });

  assert.equal(manifest.activeRule.name, "AGENTS.md");
  assert.deepEqual(manifest.skippedRules.map((item) => item.name), ["AGENT.md", "CLAUDE.md"]);
  assert.equal(manifest.localMemory.name, path.join(".lab-agent", "memory.md"));
  assert.deepEqual(manifest.memories.map((item) => item.name), ["AGENTS.md", path.join(".lab-agent", "memory.md")]);
});

test("ANTCODE.md is the first project rule and LAB_AGENT.md remains fallback", async () => {
  const cwd = await makeTempWorkspace();
  await fs.writeFile(path.join(cwd, "ANTCODE.md"), "Ant Code rules\n", "utf8");
  await fs.writeFile(path.join(cwd, "AGENTS.md"), "OpenCode rules\n", "utf8");
  await fs.writeFile(path.join(cwd, "LAB_AGENT.md"), "Legacy Lab Agent rules\n", "utf8");

  const manifest = await loadProjectMemoryManifest({ cwd });

  assert.equal(manifest.activeRule.name, "ANTCODE.md");
  assert.deepEqual(manifest.skippedRules.map((item) => item.name), ["AGENTS.md", "LAB_AGENT.md"]);
  assert.deepEqual((await loadProjectMemory({ cwd })).map((item) => item.name), ["ANTCODE.md"]);
});

test("legacy LAB_AGENT.md loads when no higher priority rule exists", async () => {
  const cwd = await makeTempWorkspace();
  await fs.writeFile(path.join(cwd, "LAB_AGENT.md"), "Legacy Lab Agent rules\n", "utf8");

  const manifest = await loadProjectMemoryManifest({ cwd });

  assert.equal(manifest.activeRule.name, "LAB_AGENT.md");
  assert.equal(manifest.skippedRules.length, 0);
});

test("appendProjectMemory rejects empty entries", async () => {
  const cwd = await makeTempWorkspace();
  const result = await appendProjectMemory({ cwd, text: "   " });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "MEMORY_EMPTY");
});

async function makeTempWorkspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
}
