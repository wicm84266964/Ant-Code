import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildInitialContext } from "../../src/context/builder.js";

test("context builder includes clean-room behavior and final response protocols", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
  const context = await buildInitialContext({
    cwd,
    config: {
      networkMode: "offline"
    }
  });

  const systemText = context.system.join("\n");
  assert.match(systemText, /Behavior protocol/);
  assert.match(systemText, /inspect relevant local files before editing/);
  assert.match(systemText, /After code changes, run or request a relevant validation command/);
  assert.match(systemText, /Final response protocol/);
  assert.match(systemText, /completed work/);
  assert.match(systemText, /blocked work/);
});

test("context builder warns when cwd is only Ant Code runtime data", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-runtime-only-"));
  await fs.mkdir(path.join(cwd, ".lab-agent", "sessions"), { recursive: true });
  await fs.mkdir(path.join(cwd, ".lab-agent", "tasks"), { recursive: true });

  const context = await buildInitialContext({
    cwd,
    config: {
      networkMode: "lab-only"
    }
  });

  const systemText = context.system.join("\n");
  assert.match(systemText, /Workspace diagnostics/);
  assert.match(systemText, /source markers: none detected/);
  assert.match(systemText, /只包含 Ant Code 运行数据目录/);
  assert.match(systemText, /current cwd/);
});

test("context builder explains compact, MCP, and local subagent boundaries", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
  const context = await buildInitialContext({
    cwd,
    config: {
      networkMode: "offline"
    }
  });

  const systemText = context.system.join("\n");
  assert.match(systemText, /\/compact .* prefers a separate model summarization request/);
  assert.match(systemText, /falls back to local deterministic compaction/);
  assert.match(systemText, /keeps recent messages exactly/);
  assert.match(systemText, /mcp_call works only when .* MCP server is configured/);
  assert.match(systemText, /skill_list, skill_read, or skill_run/);
  assert.match(systemText, /agent_run provide controlled local subagents/);
  assert.match(systemText, /Coordinator operating model/);
  assert.match(systemText, /Delegation-first mandate/);
  assert.match(systemText, /Complex-task orchestration/);
  assert.match(systemText, /intake -> classify -> plan -> delegate readonly exploration -> synthesize -> implement scoped slices -> verify -> review -> report/);
  assert.match(systemText, /Subagent routing guide/);
  assert.match(systemText, /orchestrate first, execute second/);
  assert.match(systemText, /parent session is expensive global attention/);
  assert.match(systemText, /current parallel budget \(3 at once\)/);
  assert.match(systemText, /background=true/);
  assert.match(systemText, /group completion prompt/);
  assert.match(systemText, /review gate/);
  assert.match(systemText, /configured low-cost model/);
  assert.match(systemText, /Use the Subagent routing guide and Complex-task orchestration sections above as the authoritative routing policy/);
  assert.match(systemText, /code-worker/);
});

test("context builder describes dashboard as WebUI instead of terminal TUI", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-dashboard-context-"));
  const context = await buildInitialContext({
    cwd,
    config: {
      networkMode: "offline"
    },
    clientSurface: "dashboard"
  });

  const systemText = context.system.join("\n");
  assert.match(systemText, /Client surface: dashboard WebUI/);
  assert.match(systemText, /not the terminal TUI/);
  assert.match(systemText, /current client can track progress/);
  assert.match(systemText, /Image preview is a browser UI feature only/);
  assert.doesNotMatch(systemText, /TUI sidebar/);
  assert.doesNotMatch(systemText, /The TUI will automatically continue/);
});

test("context builder preserves TUI surface only when explicitly requested", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-tui-context-"));
  const context = await buildInitialContext({
    cwd,
    config: {
      networkMode: "offline"
    },
    clientSurface: "tui"
  });

  const systemText = context.system.join("\n");
  assert.match(systemText, /Client surface: terminal TUI/);
  assert.match(systemText, /terminal display constraints/);
});

test("context builder includes high-sensitivity behavior when configured", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
  const context = await buildInitialContext({
    cwd,
    config: {
      networkMode: "lab-only",
      security: { sensitivity: "high" }
    }
  });

  const systemText = context.system.join("\n");
  assert.match(systemText, /Sensitivity mode: high/);
  assert.match(systemText, /metadata-minimal workflows/);
});

test("context builder includes bounded project memory with relative paths", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
  await fs.writeFile(path.join(cwd, "ANTCODE.md"), "Prefer short answers.\n", "utf8");
  await fs.writeFile(path.join(cwd, "LAB_AGENT.md"), "Legacy instruction should be skipped.\n", "utf8");

  const context = await buildInitialContext({
    cwd,
    config: {
      networkMode: "lab-only"
    }
  });

  const systemText = context.system.join("\n");
  assert.match(systemText, /Project memory/);
  assert.match(systemText, /Project memory discipline/);
  assert.match(systemText, /durable preference, habit, or desired working style/);
  assert.match(systemText, /proactively append a concise note to \.lab-agent\/memory\.md/);
  assert.match(systemText, /Update ANTCODE\.md only for stable project maintenance rules/);
  assert.match(systemText, /Do not store secrets/);
  assert.match(systemText, /From ANTCODE\.md/);
  assert.match(systemText, /Prefer short answers/);
  assert.doesNotMatch(systemText, /Do not silently create or edit persistent memory/);
  assert.doesNotMatch(systemText, /Legacy instruction should be skipped/);
  assert.doesNotMatch(systemText, new RegExp(escapeRegex(cwd)));
});

/**
 * @param {string} value
 */
function escapeRegex(value) {
  return value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}
