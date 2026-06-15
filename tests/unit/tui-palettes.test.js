import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  fileMentionState,
  insertFileMention,
  listFileMentionCandidates,
  movePaletteIndex,
  slashPaletteState
} from "../../src/cli/tui/palettes.js";

test("slash palette filters lab-owned command metadata", () => {
  const palette = slashPaletteState("/stat");

  assert.ok(palette.commands.some((command) => command.name === "status"));
  assert.equal(movePaletteIndex(palette.commands, 0, -1), palette.commands.length - 1);
  assert.equal(slashPaletteState("hello"), null);
});

test("slash palette exposes disabled reasons for deferred commands", () => {
  const palette = slashPaletteState("/theme");
  const theme = palette.commands.find((command) => command.name === "theme");

  assert.match(theme.disabledReason, /主题注册表/);
});

test("file mention state detects only the active trailing token", () => {
  assert.deepEqual(fileMentionState("read @src/cli"), { start: 5, fragment: "src/cli" });
  assert.equal(fileMentionState("email a@b.com now"), null);
});

test("file mention candidates stay inside workspace and skip heavy folders", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-palette-"));
  await fs.mkdir(path.join(cwd, "src"));
  await fs.mkdir(path.join(cwd, "node_modules"));
  await fs.writeFile(path.join(cwd, "README.md"), "# hi\n", "utf8");
  await fs.writeFile(path.join(cwd, "src", "agent.js"), "export {}\n", "utf8");
  await fs.writeFile(path.join(cwd, "node_modules", "hidden.js"), "no\n", "utf8");

  const candidates = await listFileMentionCandidates({ cwd, fragment: "agent" });

  assert.ok(candidates.some((candidate) => candidate.path === "src/agent.js"));
  assert.ok(!candidates.some((candidate) => candidate.path.includes("node_modules")));
});

test("file mention candidates mark recent files and support fuzzy matches", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-palette-"));
  await fs.mkdir(path.join(cwd, "src", "cli"), { recursive: true });
  await fs.mkdir(path.join(cwd, "notes"), { recursive: true });
  await fs.writeFile(path.join(cwd, "src", "cli", "command-panel.js"), "export {}\n", "utf8");
  await fs.writeFile(path.join(cwd, "notes", "daily-plan.md"), "# plan\n", "utf8");

  const recent = await listFileMentionCandidates({
    cwd,
    fragment: "",
    recentFiles: ["notes/daily-plan.md"]
  });
  const fuzzy = await listFileMentionCandidates({
    cwd,
    fragment: "cmdpnl"
  });

  assert.equal(recent[0].path, "notes/daily-plan.md");
  assert.equal(recent[0].recent, true);
  assert.equal(recent[0].label, "file");
  assert.ok(fuzzy.some((candidate) => (
    candidate.path === "src/cli/command-panel.js" &&
    candidate.match === "fuzzy"
  )));
});

test("file mention insertion replaces the active mention token", () => {
  const draft = "please read @src";
  const state = fileMentionState(draft);

  assert.equal(insertFileMention(draft, state, "src/agent.js"), "please read @src/agent.js ");
});
