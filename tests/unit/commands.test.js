import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { parseSlashCommand } from "../../src/commands/parser.js";
import { runSlashCommand } from "../../src/commands/runtime.js";
import { clearHookAudit } from "../../src/hooks/audit-store.js";
import { runHooks } from "../../src/hooks/runner.js";
import { registerBackgroundAgentTask } from "../../src/agents/background-registry.js";
import { createAgentTaskStore } from "../../src/agents/task-store.js";
import { createAgentTaskGroupStore } from "../../src/agents/task-group-store.js";
import { trustWorkspace } from "../../src/permissions/workspace-trust.js";
import { createWorkflowState } from "../../src/tools/workflow-tools.js";

const execFileAsync = promisify(execFile);

test("parses slash commands with quoted arguments", () => {
  const command = parseSlashCommand("/mcp call local echo '{\"message\":\"hi\"}'");
  assert.equal(command?.name, "mcp");
  assert.deepEqual(command?.args, ["call", "local", "echo", "{\"message\":\"hi\"}"]);
});

test("help slash command groups commands for users", async () => {
  const output = await runSlashCommand({
    command: parseSlashCommand("/help"),
    cwd: process.cwd(),
    env: {}
  });

  assert.match(output, /Ant Code 命令帮助/);
  assert.match(output, /入门/);
  assert.match(output, /工作区/);
  assert.match(output, /验证/);
  assert.match(output, /\/status --json/);
});

test("status slash command reports local session settings", async () => {
  const output = await runSlashCommand({
    command: parseSlashCommand("/status --json"),
    cwd: process.cwd(),
    env: {},
    readonly: true,
    allowWrite: false,
    allowCommand: false
  });
  const status = JSON.parse(output);

  assert.equal(status.readonly, true);
  assert.equal(status.permissionMode, "plan");
  assert.equal(status.permissionReadonlyLocked, true);
  assert.equal(status.fullAccess, false);
  assert.equal(status.networkMode, "lab-only");
});

test("status slash command defaults to a human-readable report", async () => {
  const output = await runSlashCommand({
    command: parseSlashCommand("/status"),
    cwd: process.cwd(),
    env: {},
    readonly: true
  });

  assert.match(output, /Ant Code status/);
  assert.match(output, /Session/);
  assert.match(output, /Repository map/);
  assert.match(output, /Delivery status/);
  assert.match(output, /Suggested validation/);
});

test("status slash command includes delivery state when workflow is attached", async () => {
  const workflowState = createWorkflowState();
  workflowState.validations.push({
    command: "npm test",
    exitCode: 1,
    passed: false,
    timedOut: false,
    durationMs: 12
  });

  const output = await runSlashCommand({
    command: parseSlashCommand("/status --json"),
    cwd: process.cwd(),
    env: {},
    workflowState,
    sessionInfo: {
      id: "session-1",
      turnCount: 4
    }
  });
  const status = JSON.parse(output);

  assert.equal(status.sessionId, "session-1");
  assert.equal(status.delivery.state, "blocked");
  assert.equal(status.delivery.summary.validations.failed, 1);
  assert.match(status.delivery.nextActions[1], /\/verify run npm test/);
});

test("files slash command lists workspace entries", async () => {
  const cwd = await makeTempWorkspace();
  await fs.mkdir(path.join(cwd, "src"));
  await fs.writeFile(path.join(cwd, "README.md"), "# test\n", "utf8");

  const output = await runSlashCommand({
    command: parseSlashCommand("/files"),
    cwd,
    env: {}
  });

  assert.match(output, /\[dir\] src/);
  assert.match(output, /README\.md/);
});

test("map slash command reports repository shape", async () => {
  const cwd = await makeTempWorkspace();
  await fs.mkdir(path.join(cwd, "src"));
  await fs.writeFile(path.join(cwd, "package.json"), JSON.stringify({
    name: "mapped-project",
    scripts: { test: "node --test" }
  }), "utf8");

  const output = await runSlashCommand({
    command: parseSlashCommand("/map"),
    cwd,
    env: {}
  });

  assert.match(output, /Ant Code repository map/);
  assert.match(output, /mapped-project/);
  assert.match(output, /src - source/);
});

test("status reports when cwd is only Ant Code runtime data", async () => {
  const cwd = await makeTempWorkspace();
  await fs.mkdir(path.join(cwd, ".lab-agent", "sessions"), { recursive: true });
  await fs.mkdir(path.join(cwd, ".lab-agent", "tasks"), { recursive: true });

  const output = await runSlashCommand({
    command: parseSlashCommand("/status"),
    cwd,
    env: {}
  });

  assert.match(output, /Repository map/);
  assert.match(output, /只包含 Ant Code 运行数据目录/);
});

test("run slash command executes readonly commands through the permission engine", async () => {
  const cwd = await makeTempWorkspace();
  const command = process.platform === "win32" ? "/run Get-Location" : "/run pwd";

  const output = await runSlashCommand({
    command: parseSlashCommand(command),
    cwd,
    env: process.env
  });

  assert.match(output, /exit: 0/);
  assert.match(output, new RegExp(escapeRegex(cwd)));
});

test("run slash command blocks mutating commands without approval", async () => {
  const cwd = await makeTempWorkspace();
  const command = process.platform === "win32"
    ? "/run Set-Content -LiteralPath notes.txt -Value hi"
    : "/run touch notes.txt";

  const output = await runSlashCommand({
    command: parseSlashCommand(command),
    cwd,
    env: process.env
  });
  const result = JSON.parse(output);

  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  await assert.rejects(fs.readFile(path.join(cwd, "notes.txt"), "utf8"), /ENOENT/);
});

test("edit slash command applies exact replacements after approval", async () => {
  const cwd = await makeTempWorkspace();
  await fs.writeFile(path.join(cwd, "notes.txt"), "alpha\n", "utf8");
  const approvals = [];

  const output = await runSlashCommand({
    command: parseSlashCommand("/edit notes.txt alpha => beta"),
    cwd,
    env: {},
    approvalCallback: async (request) => {
      approvals.push(request);
      return true;
    }
  });

  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].toolName, "edit_file");
  assert.match(output, /\+beta/);
  assert.equal(await fs.readFile(path.join(cwd, "notes.txt"), "utf8"), "beta\n");
});

test("edit slash command can preview exact replacements", async () => {
  const cwd = await makeTempWorkspace();
  await fs.writeFile(path.join(cwd, "notes.txt"), "alpha\n", "utf8");

  const output = await runSlashCommand({
    command: parseSlashCommand("/edit --dry-run notes.txt alpha => beta"),
    cwd,
    env: {},
    approvalCallback: async () => true
  });

  assert.match(output, /-alpha/);
  assert.match(output, /\+beta/);
  assert.equal(await fs.readFile(path.join(cwd, "notes.txt"), "utf8"), "alpha\n");
});

test("todo and plan slash commands update interactive workflow state", async () => {
  const workflowState = createWorkflowState();
  const cwd = await makeTempWorkspace();

  const added = await runSlashCommand({
    command: parseSlashCommand("/todo add inspect runtime"),
    cwd,
    env: {},
    workflowState
  });
  const done = await runSlashCommand({
    command: parseSlashCommand("/todo done 1"),
    cwd,
    env: {},
    workflowState
  });
  const plan = await runSlashCommand({
    command: parseSlashCommand("/plan set inspect | implement | verify"),
    cwd,
    env: {},
    workflowState
  });

  assert.match(added, /inspect runtime/);
  assert.match(done, /\[completed\] inspect runtime/);
  assert.match(plan, /1\. \[pending\] inspect/);
  assert.equal(workflowState.todos[0].status, "completed");
  assert.equal(workflowState.plan.steps.length, 3);
});

test("sessions show slash command reads bounded metadata", async () => {
  const cwd = await makeTempWorkspace();
  const sessionDir = path.join(cwd, ".lab-agent", "sessions");
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(path.join(sessionDir, "session-1.json"), JSON.stringify({
    id: "session-1",
    turnIndex: 2,
    promptBytes: 5
  }), "utf8");

  const output = await runSlashCommand({
    command: parseSlashCommand("/sessions show session-1"),
    cwd,
    env: {}
  });
  const result = JSON.parse(output);

  assert.equal(result.ok, true);
  assert.equal(result.metadata.id, "session-1");
  assert.equal(result.metadata.turnIndex, 2);
});

test("verify slash command records command results in workflow state", async () => {
  const workflowState = createWorkflowState();
  const cwd = await makeTempWorkspace();
  const command = process.platform === "win32" ? "/verify run Get-Location" : "/verify run pwd";

  const output = await runSlashCommand({
    command: parseSlashCommand(command),
    cwd,
    env: process.env,
    workflowState
  });
  const list = await runSlashCommand({
    command: parseSlashCommand("/verify"),
    cwd,
    env: process.env,
    workflowState
  });

  assert.match(output, /exit: 0/);
  assert.equal(workflowState.validations.length, 1);
  assert.match(list, /\[passed\]/);
});

test("verify suggest reports project validation commands", async () => {
  const cwd = await makeTempWorkspace();
  await fs.writeFile(path.join(cwd, "package.json"), JSON.stringify({
    scripts: {
      test: "node --test",
      check: "npm test",
      "verify:release": "npm run check"
    }
  }), "utf8");

  const output = await runSlashCommand({
    command: parseSlashCommand("/verify suggest"),
    cwd,
    env: {}
  });

  assert.match(output, /npm run verify:release/);
  assert.match(output, /npm run check/);
  assert.match(output, /npm test/);
});

test("verify suggest orders lightweight checks before full release validation", async () => {
  if (!await gitAvailable()) {
    return;
  }
  const cwd = await makeTempWorkspace();
  await fs.mkdir(path.join(cwd, "src"), { recursive: true });
  await fs.writeFile(path.join(cwd, "package.json"), JSON.stringify({
    scripts: {
      "check:syntax": "node scripts/check-syntax.js",
      lint: "eslint .",
      "test:unit": "node --test tests/unit",
      test: "node --test",
      check: "npm run check:syntax && npm test",
      "verify:release": "npm run check"
    }
  }), "utf8");
  await execGit(cwd, ["init"]);
  await execGit(cwd, ["config", "user.email", "test@example.com"]);
  await execGit(cwd, ["config", "user.name", "Test User"]);
  await execGit(cwd, ["add", "package.json"]);
  await execGit(cwd, ["commit", "-m", "init"]);
  await fs.writeFile(path.join(cwd, "src", "app.js"), "export const value = 1;\n", "utf8");

  const output = await runSlashCommand({
    command: parseSlashCommand("/verify suggest"),
    cwd,
    env: {}
  });

  assert.match(output, /1\. npm run check:syntax/);
  assert.match(output, /minimal validation:/);
  assert.match(output, /related validation:/);
  assert.match(output, /full validation:/);
  assert.match(output, /npm run lint/);
  assert.match(output, /npm run test:unit/);
  assert.match(output, /npm run check/);
  assert.match(output, /npm run verify:release/);
});

test("verify suggest avoids test suggestions for docs-only changes when check exists", async () => {
  if (!await gitAvailable()) {
    return;
  }
  const cwd = await makeTempWorkspace();
  await fs.mkdir(path.join(cwd, "docs"), { recursive: true });
  await fs.writeFile(path.join(cwd, "package.json"), JSON.stringify({
    scripts: {
      test: "node --test",
      check: "npm test"
    }
  }), "utf8");
  await execGit(cwd, ["init"]);
  await execGit(cwd, ["config", "user.email", "test@example.com"]);
  await execGit(cwd, ["config", "user.name", "Test User"]);
  await execGit(cwd, ["add", "package.json"]);
  await execGit(cwd, ["commit", "-m", "init"]);
  await fs.writeFile(path.join(cwd, "docs", "note.md"), "# Note\n", "utf8");

  const output = await runSlashCommand({
    command: parseSlashCommand("/verify suggest"),
    cwd,
    env: {}
  });

  assert.match(output, /npm run check/);
  assert.doesNotMatch(output, /npm test/);
});

test("verify suggest reports related test file suggestions", async () => {
  if (!await gitAvailable()) {
    return;
  }
  const cwd = await makeTempWorkspace();
  await fs.mkdir(path.join(cwd, "src"), { recursive: true });
  await fs.mkdir(path.join(cwd, "tests"), { recursive: true });
  await fs.writeFile(path.join(cwd, "package.json"), JSON.stringify({
    scripts: {
      "test:unit": "node --test tests/unit"
    }
  }), "utf8");
  await fs.writeFile(path.join(cwd, "tests", "math.test.ts"), "import '../src/math';\n", "utf8");
  await execGit(cwd, ["init"]);
  await execGit(cwd, ["config", "user.email", "test@example.com"]);
  await execGit(cwd, ["config", "user.name", "Test User"]);
  await execGit(cwd, ["add", "package.json", "tests/math.test.ts"]);
  await execGit(cwd, ["commit", "-m", "init"]);
  await fs.writeFile(path.join(cwd, "src", "math.ts"), "export const add = (a: number, b: number) => a + b;\n", "utf8");

  const output = await runSlashCommand({
    command: parseSlashCommand("/verify suggest"),
    cwd,
    env: {}
  });

  assert.match(output, /npm run test:unit -- tests[\\/]math\.test\.ts/);
  assert.match(output, /related test file/);
});

test("verify run suggested executes the first suggested validation command", async () => {
  const workflowState = createWorkflowState();
  const cwd = await makeTempWorkspace();
  await fs.writeFile(path.join(cwd, "package.json"), JSON.stringify({
    scripts: {
      check: "node -e \"process.exit(0)\""
    }
  }), "utf8");

  const output = await runSlashCommand({
    command: parseSlashCommand("/verify run suggested"),
    cwd,
    env: process.env,
    allowCommand: true,
    workflowState
  });

  assert.match(output, /exit: 0/);
  assert.equal(workflowState.validations.length, 1);
  assert.equal(workflowState.validations[0].command, "npm run check");
  assert.equal(workflowState.validations[0].passed, true);
});

test("verify list reports validation memory with pending and stale states", async () => {
  const workflowState = createWorkflowState();
  workflowState.validations.push({
    command: "npm test",
    exitCode: 0,
    passed: true,
    timedOut: false,
    durationMs: 10,
    recordedAt: "2026-04-28T00:01:00.000Z"
  });
  workflowState.changes.push({
    toolName: "edit_file",
    path: "src/app.js",
    edited: true,
    diffBytes: 10,
    recordedAt: "2026-04-28T00:02:00.000Z"
  });
  const cwd = await makeTempWorkspace();
  await fs.writeFile(path.join(cwd, "package.json"), JSON.stringify({
    scripts: {
      test: "node --test",
      check: "npm test"
    }
  }), "utf8");

  const output = await runSlashCommand({
    command: parseSlashCommand("/verify"),
    cwd,
    env: {},
    workflowState
  });

  assert.match(output, /Validation memory/);
  assert.match(output, /pending=2/);
  assert.match(output, /stale=1/);
  assert.match(output, /pending suggestions:/);
  assert.match(output, /\[passed, stale\] npm test/);
});

test("next slash command shows concrete validation guidance", async () => {
  const workflowState = createWorkflowState();
  workflowState.changes.push({
    toolName: "edit_file",
    path: "notes.txt",
    edited: true,
    diffBytes: 10
  });
  const cwd = await makeTempWorkspace();
  await fs.writeFile(path.join(cwd, "package.json"), JSON.stringify({
    scripts: {
      test: "node --test"
    }
  }), "utf8");

  const output = await runSlashCommand({
    command: parseSlashCommand("/next"),
    cwd,
    env: {},
    workflowState,
    sessionInfo: { id: "session-1", turnCount: 2 }
  });

  assert.match(output, /Ant Code next actions/);
  assert.match(output, /state: needs_validation/);
  assert.match(output, /\/verify run npm test/);
  assert.match(output, /Suggested validation/);
});

test("report slash command summarizes workflow and git state", async (t) => {
  if (!(await gitAvailable())) {
    t.skip("git executable is not available");
    return;
  }

  const cwd = await makeTempWorkspace();
  await execGit(cwd, ["init"]);
  await fs.writeFile(path.join(cwd, "notes.txt"), "before\n", "utf8");
  const workflowState = createWorkflowState();
  workflowState.changes.push({
    toolName: "write_file",
    path: "notes.txt",
    created: true,
    diffBytes: 42
  });
  workflowState.validations.push({
    command: "npm test",
    exitCode: 1,
    passed: false,
    timedOut: false,
    durationMs: 12
  });

  const output = await runSlashCommand({
    command: parseSlashCommand("/report"),
    cwd,
    env: process.env,
    workflowState,
    sessionInfo: {
      id: "session-1",
      turnCount: 3,
      model: "mock",
      networkMode: "offline"
    }
  });

  assert.match(output, /Ant Code delivery report/);
  assert.match(output, /session: session-1/);
  assert.match(output, /Delivery status/);
  assert.match(output, /state: blocked/);
  assert.match(output, /notes\.txt/);
  assert.match(output, /\[failed\] npm test/);
  assert.match(output, /Git status/);
});

test("review slash command shows diff stat", async (t) => {
  if (!(await gitAvailable())) {
    t.skip("git executable is not available");
    return;
  }

  const cwd = await makeTempWorkspace();
  await execGit(cwd, ["init"]);
  await fs.writeFile(path.join(cwd, "notes.txt"), "before\n", "utf8");
  await execGit(cwd, ["add", "notes.txt"]);
  await execGit(cwd, ["-c", "user.email=test@example.invalid", "-c", "user.name=Test User", "commit", "-m", "init"]);
  await fs.writeFile(path.join(cwd, "notes.txt"), "after\n", "utf8");

  const output = await runSlashCommand({
    command: parseSlashCommand("/review stat"),
    cwd,
    env: process.env,
    workflowState: createWorkflowState()
  });

  assert.match(output, /exit: 0/);
  assert.match(output, /notes\.txt/);
});

test("review slash command reports validation memory evidence", async (t) => {
  if (!(await gitAvailable())) {
    t.skip("git executable is not available");
    return;
  }

  const cwd = await makeTempWorkspace();
  await execGit(cwd, ["init"]);
  await fs.writeFile(path.join(cwd, "package.json"), JSON.stringify({
    scripts: {
      test: "node --test",
      check: "npm test"
    }
  }), "utf8");
  await execGit(cwd, ["add", "package.json"]);
  await execGit(cwd, ["-c", "user.email=test@example.invalid", "-c", "user.name=Test User", "commit", "-m", "init"]);
  const workflowState = createWorkflowState();
  workflowState.validations.push({
    command: "npm test",
    exitCode: 0,
    passed: true,
    timedOut: false,
    durationMs: 10,
    recordedAt: "2026-04-28T00:01:00.000Z"
  });
  workflowState.changes.push({
    toolName: "edit_file",
    path: "src/app.js",
    edited: true,
    diffBytes: 10,
    recordedAt: "2026-04-28T00:02:00.000Z"
  });

  const output = await runSlashCommand({
    command: parseSlashCommand("/review"),
    cwd,
    env: process.env,
    workflowState
  });

  assert.match(output, /Validation evidence/);
  assert.match(output, /Validation memory/);
  assert.match(output, /pending=/);
  assert.match(output, /stale=1/);
  assert.match(output, /\[passed, stale\] npm test/);
});

test("diff slash command shows local git changes without shell interpolation", async (t) => {
  if (!(await gitAvailable())) {
    t.skip("git executable is not available");
    return;
  }

  const cwd = await makeTempWorkspace();
  await execGit(cwd, ["init"]);
  await fs.writeFile(path.join(cwd, "notes.txt"), "before\n", "utf8");
  await execGit(cwd, ["add", "notes.txt"]);
  await execGit(cwd, ["-c", "user.email=test@example.invalid", "-c", "user.name=Test User", "commit", "-m", "init"]);
  await fs.writeFile(path.join(cwd, "notes.txt"), "after\n", "utf8");

  const output = await runSlashCommand({
    command: parseSlashCommand("/diff notes.txt"),
    cwd,
    env: process.env
  });

  assert.match(output, /exit: 0/);
  assert.match(output, /\+after/);
});

test("mcp slash command lists configured servers", async () => {
  const cwd = await makeTempWorkspace();
  await writeProjectConfig(cwd);

  const output = await runSlashCommand({
    command: parseSlashCommand("/mcp"),
    cwd,
    env: {}
  });

  assert.match(output, /local-echo \(stdio, not_connected\)/);
});

test("mcp slash command can list tools", async () => {
  const cwd = await makeTempWorkspace();
  await writeProjectConfig(cwd);

  const output = await runSlashCommand({
    command: parseSlashCommand("/mcp tools local-echo"),
    cwd,
    env: {}
  });
  const tools = JSON.parse(output);

  assert.equal(tools[0].name, "echo");
});

test("capabilities slash command reports tools, MCP, skills, and agents", async () => {
  const output = await runSlashCommand({
    command: parseSlashCommand("/capabilities"),
    cwd: process.cwd(),
    env: {}
  });

  assert.match(output, /Ant Code 能力清单/);
  assert.match(output, /web_fetch/);
  assert.match(output, /duckduckgo-search/);
  assert.match(output, /web-research/);
  assert.match(output, /readonly-researcher/);
});

test("mcp doctor reports configured recommended servers without launching them", async () => {
  const output = await runSlashCommand({
    command: parseSlashCommand("/mcp doctor"),
    cwd: process.cwd(),
    env: {}
  });

  assert.match(output, /Ant Code MCP doctor/);
  assert.match(output, /filesystem/);
  assert.match(output, /memory/);
  assert.match(output, /playwright/);
  assert.match(output, /不拉起 MCP 进程/);
  assert.match(output, /\/mcp doctor --live/);
});

test("skills doctor checks bundled skill pack", async () => {
  const output = await runSlashCommand({
    command: parseSlashCommand("/skills doctor"),
    cwd: process.cwd(),
    env: {}
  });

  assert.match(output, /Ant Code skills doctor/);
  assert.match(output, /\[ok\] web-research/);
  assert.match(output, /\[ok\] browser-automation/);
  assert.match(output, /\[ok\] document-intake/);
});

test("skills slash command lists, reads, and prepares local skills", async () => {
  const cwd = await makeTempWorkspace();
  const skillDir = path.join(cwd, ".lab-agent", "skills", "demo");
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), [
    "---",
    "name: demo",
    "description: Demo workflow",
    "allowed-tools: read_file, grep",
    "---",
    "# Demo Skill",
    "Use this workflow for focused demo tasks."
  ].join("\n"), "utf8");

  const list = await runSlashCommand({
    command: parseSlashCommand("/skills"),
    cwd,
    env: {}
  });
  const detail = await runSlashCommand({
    command: parseSlashCommand("/skills show demo"),
    cwd,
    env: {}
  });
  const prepared = await runSlashCommand({
    command: parseSlashCommand("/skills run demo inspect"),
    cwd,
    env: {}
  });

  assert.match(list, /demo - Demo workflow/);
  assert.match(detail, /Skill: demo/);
  assert.match(detail, /Use this workflow/);
  assert.match(prepared, /模式：instruction-only/);
  assert.match(prepared, /任务：inspect/);
});

test("memory add slash command asks in plan mode before writing project memory", async () => {
  const cwd = await makeTempWorkspace();
  const output = await runSlashCommand({
    command: parseSlashCommand("/memory add Prefer local memory."),
    cwd,
    env: {}
  });
  const result = JSON.parse(output);

  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.equal(result.decision.decision, "ask");
  await assert.rejects(fs.readFile(path.join(cwd, ".lab-agent", "memory.md"), "utf8"), /ENOENT/);
});

test("memory add slash command writes after approval", async () => {
  const cwd = await makeTempWorkspace();
  const approvals = [];
  const output = await runSlashCommand({
    command: parseSlashCommand("/memory add Prefer local memory."),
    cwd,
    env: {},
    approvalCallback: async (request) => {
      approvals.push(request);
      return true;
    }
  });
  const result = JSON.parse(output);

  assert.equal(result.ok, true);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].toolName, "add_project_memory");
  const listed = await runSlashCommand({
    command: parseSlashCommand("/memory"),
    cwd,
    env: {}
  });
  assert.match(listed, /Ant Code memory/);
  assert.match(listed, /本地记忆：.*memory\.md/);
});

test("memory add slash command auto-writes in workspace permission mode", async () => {
  const cwd = await makeTempWorkspace();
  const output = await runSlashCommand({
    command: parseSlashCommand("/memory add Workspace memory."),
    cwd,
    env: {},
    sessionInfo: {
      permissionMode: "workspace",
      allowWrite: true,
      allowCommand: true
    }
  });
  const result = JSON.parse(output);

  assert.equal(result.ok, true);
  assert.match(await fs.readFile(path.join(cwd, ".lab-agent", "memory.md"), "utf8"), /Workspace memory/);
});

test("slash commands derive capabilities from permissionMode when booleans are absent", async () => {
  const cwd = await makeTempWorkspace();
  const permissions = JSON.parse(await runSlashCommand({
    command: parseSlashCommand("/permissions"),
    cwd,
    env: {},
    sessionInfo: { permissionMode: "fullAccess" }
  }));
  const memory = JSON.parse(await runSlashCommand({
    command: parseSlashCommand("/memory add Full access memory."),
    cwd,
    env: {},
    sessionInfo: { permissionMode: "fullAccess" }
  }));

  assert.equal(permissions.mode, "fullAccess");
  assert.equal(permissions.fullAccess, true);
  assert.equal(permissions.workspaceWrites, true);
  assert.equal(permissions.workspaceCommands, true);
  assert.equal(memory.ok, true);
  assert.match(await fs.readFile(path.join(cwd, ".lab-agent", "memory.md"), "utf8"), /Full access memory/);
});

test("memory add slash command is blocked in readonly mode", async () => {
  const cwd = await makeTempWorkspace();
  const output = await runSlashCommand({
    command: parseSlashCommand("/memory add no"),
    cwd,
    env: {},
    readonly: true
  });
  const result = JSON.parse(output);

  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.equal(result.decision.decision, "deny");
});

test("memory slash command reports active project rule and skipped compatibility files", async () => {
  const cwd = await makeTempWorkspace();
  await fs.writeFile(path.join(cwd, "ANTCODE.md"), "Ant Code rules\n", "utf8");
  await fs.writeFile(path.join(cwd, "AGENTS.md"), "OpenCode rules\n", "utf8");
  await fs.writeFile(path.join(cwd, "CLAUDE.md"), "Compatibility rules\n", "utf8");
  await fs.mkdir(path.join(cwd, ".lab-agent"), { recursive: true });
  await fs.writeFile(path.join(cwd, ".lab-agent", "memory.md"), "# Project Memory\n\nLocal note\n", "utf8");

  const output = await runSlashCommand({
    command: parseSlashCommand("/memory"),
    cwd,
    env: {}
  });

  assert.match(output, /主项目规则：ANTCODE\.md/);
  assert.match(output, /已跳过兼容文件：AGENTS\.md, CLAUDE\.md/);
  assert.match(output, /本地记忆：.*memory\.md/);
});

test("agents run slash command invokes readonly subagent", async () => {
  const cwd = await makeTempWorkspace();
  await fs.writeFile(path.join(cwd, "LabAgent.txt"), "LabAgent task marker\n", "utf8");
  await fs.writeFile(path.join(cwd, "lab-agent.config.json"), JSON.stringify({
    lab: {
      gatewayUrl: null
    }
  }), "utf8");
  const output = await runSlashCommand({
    command: parseSlashCommand("/agents run readonly-researcher find LabAgent"),
    cwd,
    env: {
      LAB_MODEL_GATEWAY_URL: "",
      LAB_MODEL_GATEWAY_PROTOCOL: "lab-agent-gateway",
      LAB_MODEL_GATEWAY_API_KEY: "",
      LAB_AGENT_MODEL: "mock-agent"
    },
    sessionInfo: { id: "parent-session" }
  });
  const result = JSON.parse(output);
  const tasks = await runSlashCommand({
    command: parseSlashCommand("/agents tasks"),
    cwd,
    env: {}
  });

  assert.equal(result.ok, true);
  assert.equal(result.profile, "readonly-researcher");
  assert.match(result.taskId, /^task-/);
  assert.match(tasks, /readonly-researcher/);
  assert.match(tasks, /Ant Code 子任务树/);
  assert.match(tasks, /find LabAgent/);
});

test("agents group slash commands list, show, and wake groups", async () => {
  const cwd = await makeTempWorkspace();
  const taskStore = createAgentTaskStore({ cwd });
  const groupStore = createAgentTaskGroupStore({ cwd });
  await taskStore.createTask({
    id: "task-group-a",
    parentSessionId: "parent-session",
    profile: "explorer",
    title: "Inspect module",
    prompt: "inspect module",
    status: "completed",
    outputSummary: "found module evidence"
  });
  await groupStore.createGroup({
    id: "group-a",
    parentSessionId: "parent-session",
    status: "completed",
    taskIds: ["task-group-a"],
    wakeReason: "test wake"
  });

  const groups = await runSlashCommand({
    command: parseSlashCommand("/agents groups"),
    cwd,
    env: {}
  });
  const group = await runSlashCommand({
    command: parseSlashCommand("/agents group group-a"),
    cwd,
    env: {}
  });
  const wake = await runSlashCommand({
    command: parseSlashCommand("/agents wake group-a"),
    cwd,
    env: {}
  });

  assert.match(groups, /Ant Code 子任务组/);
  assert.match(groups, /group-a/);
  assert.match(group, /"id": "group-a"/);
  assert.match(wake, /Ant Code subagent group completed/);
  assert.match(wake, /found module evidence/);
});

test("agents cancel-group aborts matching in-process background tasks", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-agents-group-cancel-"));
  const groupStore = createAgentTaskGroupStore({ cwd });
  const taskStore = createAgentTaskStore({ cwd });
  await taskStore.createTask({
    id: "task-cancel-group-a",
    childSessionId: "agent-test",
    profile: "explorer",
    prompt: "background",
    status: "running",
    mode: "readonly",
    startedAt: new Date().toISOString()
  });
  await groupStore.createGroup({
    id: "group-cancel-test",
    parentSessionId: "session-cancel-test",
    taskIds: ["task-cancel-group-a"]
  });
  const controller = new AbortController();
  const unregister = registerBackgroundAgentTask({
    taskId: "task-cancel-group-a",
    groupId: "group-cancel-test",
    parentSessionId: "session-cancel-test",
    profile: "explorer",
    controller
  });

  try {
    const output = await runSlashCommand({
      command: parseSlashCommand("/agents cancel-group group-cancel-test"),
      cwd,
      env: {},
      sessionInfo: { id: "session-cancel-test" }
    });

    assert.equal(controller.signal.aborted, true);
    assert.match(output, /task-cancel-group-a/);
    const group = await groupStore.readGroup("group-cancel-test");
    const task = await taskStore.readTask("task-cancel-group-a");
    assert.equal(group.group.status, "cancelled");
    assert.equal(task.task.status, "cancelled");
  } finally {
    unregister();
  }
});

test("run slash command interrupts long shell commands through the turn signal", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-run-abort-"));
  const controller = new AbortController();
  const command = process.platform === "win32"
    ? "/run --powershell Start-Sleep -Seconds 10; Write-Output done"
    : "/run --bash sleep 10; echo done";

  const startedAt = Date.now();
  const pending = runSlashCommand({
    command: parseSlashCommand(command),
    cwd,
    env: {},
    allowCommand: true,
    signal: controller.signal
  });
  setTimeout(() => controller.abort(), 50);
  const output = await pending;
  const parsed = JSON.parse(output);

  assert.match(output, /PROCESS_INTERRUPTED|SHELL_INTERRUPTED|interrupted/i);
  assert.doesNotMatch(parsed.result?.stdout ?? "", /done/);
  assert.ok(Date.now() - startedAt < 5000);
});

test("report slash command interrupts self-managed process calls through the turn signal", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-report-abort-"));
  const bin = path.join(cwd, "bin");
  const markerPath = path.join(cwd, "fake-git-done.txt");
  await fs.mkdir(bin, { recursive: true });
  if (process.platform === "win32") {
    const escapedMarker = markerPath.replace(/'/g, "''");
    await fs.writeFile(path.join(bin, "git.cmd"), `@echo off\r\npowershell -NoProfile -Command "Start-Sleep -Seconds 10; Set-Content -LiteralPath '${escapedMarker}' -Value done; Write-Output fake-git-done"\r\n`, "utf8");
  } else {
    const gitPath = path.join(bin, "git");
    await fs.writeFile(gitPath, `#!/bin/sh\nsleep 10\necho done > ${shellQuote(markerPath)}\necho fake-git-done\n`, "utf8");
    await fs.chmod(gitPath, 0o755);
  }

  const controller = new AbortController();
  const startedAt = Date.now();
  const pending = runSlashCommand({
    command: parseSlashCommand("/report"),
    cwd,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`
    },
    allowCommand: true,
    signal: controller.signal
  });
  setTimeout(() => controller.abort(), 50);
  const output = await pending;

  assert.match(output, /PROCESS_INTERRUPTED|interrupted/i);
  assert.doesNotMatch(output, /stdout:\s*fake-git-done/i);
  assert.ok(Date.now() - startedAt < 5000);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(await fileExists(markerPath), false);
});

test("gateway slash command reports dry-run gateway health", async () => {
  const output = await runSlashCommand({
    command: parseSlashCommand("/gateway"),
    cwd: process.cwd(),
    env: {
      LAB_MODEL_GATEWAY_URL: "http://127.0.0.1:8787/v1/chat",
      LAB_MODEL_GATEWAY_HEALTH_URL: "http://127.0.0.1:8787/health",
      LAB_AGENT_NETWORK_MODE: "offline"
    }
  });

  assert.match(output, /Ant Code gateway health/);
  assert.match(output, /live: false/);
  assert.match(output, /\[ok\] gateway health url/);
});

test("config slash command redacts gateway api keys", async () => {
  const output = await runSlashCommand({
    command: parseSlashCommand("/config"),
    cwd: process.cwd(),
    env: {
      LAB_MODEL_GATEWAY_URL: "http://127.0.0.1:8080/v1/chat/completions",
      LAB_MODEL_GATEWAY_PROTOCOL: "openai-chat",
      LAB_MODEL_GATEWAY_API_KEY: "test-secret"
    }
  });

  assert.match(output, /"gatewayProtocol": "openai-chat"/);
  assert.match(output, /"gatewayApiKey": "\[redacted\]"/);
  assert.doesNotMatch(output, /test-secret/);
});

test("usage and cost commands report local counters without provider pricing guesses", async () => {
  const workflowState = createWorkflowState();
  workflowState.validations.push({
    command: "npm test",
    exitCode: 0,
    passed: true,
    timedOut: false,
    durationMs: 8
  });

  const output = await runSlashCommand({
    command: parseSlashCommand("/cost"),
    cwd: process.cwd(),
    env: {},
    workflowState,
    sessionInfo: {
      id: "session-usage",
      turnCount: 2,
      model: "mock-sonnet"
    }
  });

  assert.match(output, /Ant Code cost/);
  assert.match(output, /No provider token or cost totals/);
  assert.match(output, /validation commands: 1/);
  assert.match(output, /does not infer pricing/);
});

test("keybindings expose TUI discovery states", async () => {
  const keybindings = await runSlashCommand({
    command: parseSlashCommand("/keybindings"),
    cwd: process.cwd(),
    env: {}
  });

  assert.match(keybindings, /Shift\+Tab：切换权限：计划确认 -> 工作区权限 -> 完全访问；后续提示\/命令生效，当前运行轮次保留启动时权限/);
  assert.match(keybindings, /Ctrl\+↑\/Ctrl\+↓：召回上一条\/下一条已提交提示/);
  assert.match(keybindings, /@：打开工作区文件提及面板/);
  assert.match(keybindings, /鼠标滚轮：按鼠标位置滚动聊天区、右侧栏或当前弹层/);
  assert.match(keybindings, /←\/→：输入区为空时切换当前侧栏分类；在状态栏中切换侧栏/);
  assert.match(keybindings, /Tab：切换右侧栏：状态、任务、子智能体/);
  assert.doesNotMatch(keybindings, /切换右侧栏：状态、待办、任务/);
  assert.match(keybindings, /\/logs：打开最近运行日志/);
  assert.doesNotMatch(keybindings, /Ctrl\+T：切换检查过滤器/);
  assert.match(keybindings, /\/thinking：切换 thinking 预览显示/);
  assert.match(keybindings, /Esc：先关闭顶部弹层；忙碌时第一次确认、第二次中断当前轮次/);
  assert.match(keybindings, /Ctrl\+G：先关闭顶部弹层；忙碌时直接中断当前轮次/);
});

test("background slash command lists, shows, cancels, and reports worktree preconditions", async () => {
  const cwd = await makeTempWorkspace();
  const store = createAgentTaskStore({ cwd });
  await store.createTask({
    id: "task-bg-test",
    parentSessionId: "parent-session",
    childSessionId: "child-session",
    profile: "explorer",
    prompt: "inspect in background",
    status: "running"
  });

  const listed = await runSlashCommand({
    command: parseSlashCommand("/background list"),
    cwd,
    env: {}
  });
  const cancelled = JSON.parse(await runSlashCommand({
    command: parseSlashCommand("/background cancel task-bg-test"),
    cwd,
    env: {}
  }));
  const shown = JSON.parse(await runSlashCommand({
    command: parseSlashCommand("/background show task-bg-test"),
    cwd,
    env: {}
  }));
  const worktreeAsk = JSON.parse(await runSlashCommand({
    command: parseSlashCommand("/background worktree task-bg-test"),
    cwd,
    env: {}
  }));
  const worktree = JSON.parse(await runSlashCommand({
    command: parseSlashCommand("/background worktree task-bg-test"),
    cwd,
    env: {},
    sessionInfo: {
      permissionMode: "workspace"
    }
  }));

  assert.match(listed, /task-bg-test/);
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.task.status, "cancelled");
  assert.equal(shown.status ?? shown.task?.status, "cancelled");
  assert.equal(worktreeAsk.ok, false);
  assert.equal(worktreeAsk.blocked, true);
  assert.equal(worktreeAsk.decision.decision, "ask");
  assert.equal(worktree.ok, false);
  assert.equal(worktree.error.code, "WORKTREE_REQUIRES_GIT");
});

test("interactive-only session workflow commands stay reserved outside the TUI", async () => {
  const queue = await runSlashCommand({
    command: parseSlashCommand("/queue"),
    cwd: process.cwd(),
    env: {}
  });
  const fresh = await runSlashCommand({
    command: parseSlashCommand("/new"),
    cwd: process.cwd(),
    env: {}
  });
  const guide = await runSlashCommand({
    command: parseSlashCommand("/guide focus on tests"),
    cwd: process.cwd(),
    env: {}
  });

  assert.match(queue, /reserved for interactive sessions/);
  assert.match(fresh, /reserved for interactive sessions/);
  assert.match(guide, /reserved for interactive sessions/);
});

test("model command explains local gateway-owned model selection", async () => {
  const cwd = await makeTempWorkspace();
  const output = await runSlashCommand({
    command: parseSlashCommand("/model"),
    cwd,
    env: {
      LAB_AGENT_MODEL: "external-model-alias",
      LAB_MODEL_GATEWAY_PROTOCOL: "openai-chat",
      LAB_MODEL_GATEWAY_URL: "http://127.0.0.1:8080/v1/chat/completions"
    }
  });

  assert.match(output, /Ant Code model/);
  assert.match(output, /current: external-model-alias/);
  assert.match(output, /current context window: unknown/);
  assert.match(output, /example-vision-model context=200k/);
  assert.match(output, /gateway protocol: openai-chat/);
  assert.match(output, /does not call provider account\/model-list endpoints/);
});

test("model command reports current repo example model context", async () => {
  const cwd = await makeTempWorkspace();
  const output = await runSlashCommand({
    command: parseSlashCommand("/model"),
    cwd,
    env: {
      LAB_AGENT_MODEL: "example-vision-model",
      LAB_MODEL_GATEWAY_PROTOCOL: "openai-chat",
      LAB_MODEL_GATEWAY_URL: "http://127.0.0.1:8080/v1/chat/completions"
    }
  });

  assert.match(output, /Ant Code model/);
  assert.match(output, /current: example-vision-model/);
  assert.match(output, /current context window: 200k tokens/);
  assert.match(output, /example-vision-model context=200k/);
  assert.match(output, /gateway protocol: openai-chat/);
  assert.match(output, /does not call provider account\/model-list endpoints/);
});

test("model use command can switch an attached TUI session callback", async () => {
  let selected = null;
  const output = await runSlashCommand({
    command: parseSlashCommand("/model use example-vision-model"),
    cwd: process.cwd(),
    env: {
      LAB_AGENT_MODEL: "example-vision-model"
    },
    setModelCallback: async (model) => {
      selected = model;
    }
  });

  assert.equal(selected.id, "example-vision-model");
  assert.equal(selected.thinking, false);
  assert.match(output, /Switched current TUI session model/);
});

test("model use command reports configured options for unknown models", async () => {
  const cwd = await makeTempWorkspace();
  const output = await runSlashCommand({
    command: parseSlashCommand("/model use missing-model"),
    cwd,
    env: {
      LAB_AGENT_MODELS: "local-a,local-b"
    }
  });

  assert.match(output, /Model is not configured: missing-model/);
  assert.match(output, /local-a/);
  assert.match(output, /local-b/);
});

test("permissions trust commands list and reset workspace trust", async () => {
  const cwd = await makeTempWorkspace();
  const home = await makeTempWorkspace();
  const env = { LAB_AGENT_HOME: home };

  await trustWorkspace({ cwd, env });
  const before = JSON.parse(await runSlashCommand({
    command: parseSlashCommand("/permissions trust list"),
    cwd,
    env
  }));
  assert.equal(before.workspaces.length, 1);

  await runSlashCommand({
    command: parseSlashCommand("/permissions trust reset"),
    cwd,
    env
  });

  const initial = JSON.parse(await runSlashCommand({
    command: parseSlashCommand("/permissions trust list"),
    cwd,
    env
  }));
  assert.deepEqual(initial.workspaces, []);
});

test("sessions cleanup slash command removes expired sessions", async () => {
  const cwd = await makeTempWorkspace();
  const sessionDir = path.join(cwd, ".lab-agent", "sessions");
  await fs.mkdir(sessionDir, { recursive: true });
  const filePath = path.join(sessionDir, "old.json");
  await fs.writeFile(filePath, "{}\n", "utf8");
  const oldTime = new Date("2026-01-01T00:00:00.000Z");
  await fs.utimes(filePath, oldTime, oldTime);
  await fs.writeFile(path.join(cwd, "lab-agent.config.json"), JSON.stringify({
    transcript: { retentionDays: 0 }
  }), "utf8");

  const output = await runSlashCommand({
    command: parseSlashCommand("/sessions cleanup"),
    cwd,
    env: {}
  });
  const result = JSON.parse(output);

  assert.deepEqual(result.deleted, [filePath]);
});

test("hooks slash command reports configured hooks and audit records", async () => {
  clearHookAudit();
  await runHooks({
    config: {},
    cwd: process.cwd(),
    event: "tool.before",
    payload: {
      toolName: "read_file",
      input: { path: "README.md" },
      targetPaths: ["README.md"]
    }
  });

  const output = await runSlashCommand({
    command: parseSlashCommand("/hooks"),
    cwd: process.cwd(),
    env: {},
    trusted: true
  });

  assert.match(output, /Ant Code Hooks/);
  assert.match(output, /事件注册/);
  assert.match(output, /tool\.before/);
  assert.match(output, /最近记录/);
});

async function makeTempWorkspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
}

async function gitAvailable() {
  try {
    await execFileAsync("git", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} cwd
 * @param {string[]} args
 */
async function execGit(cwd, args) {
  await execFileAsync("git", args, { cwd, env: process.env });
}

/**
 * @param {string} cwd
 */
async function writeProjectConfig(cwd) {
  await fs.writeFile(path.join(cwd, "lab-agent.config.json"), JSON.stringify({
    mcp: {
      servers: [
        {
          name: "local-echo",
          transport: "stdio",
          command: process.execPath,
          args: [path.resolve("tests/fixtures/mcp-echo-server.js")],
          toolRisks: { echo: "read" }
        }
      ]
    }
  }), "utf8");
}

/**
 * @param {string} value
 */
function escapeRegex(value) {
  return value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}

/**
 * @param {string} value
 */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * @param {string} filePath
 */
async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
