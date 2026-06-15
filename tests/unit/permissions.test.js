import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { classifyCommand } from "../../src/permissions/command-classifier.js";
import { decidePermission } from "../../src/permissions/policy-engine.js";

test("allows readonly file access inside workspace", () => {
  const cwd = path.resolve("tests/fixtures/workspace");
  const decision = decidePermission({
    toolName: "read_file",
    risk: "read",
    cwd,
    targetPaths: ["src/index.js"],
    summary: "read test"
  }, { workspace: cwd });

  assert.equal(decision.decision, "allow");
});

test("asks with a sensitive flag for secret-like reads", () => {
  const cwd = path.resolve("tests/fixtures/workspace");
  const decision = decidePermission({
    toolName: "read_file",
    risk: "read",
    cwd,
    targetPaths: [".env"],
    summary: "read env"
  }, { workspace: cwd });

  assert.equal(decision.decision, "ask");
  assert.equal(decision.sensitive, true);
});

test("asks for sensitive file writes even with general write approval", () => {
  const cwd = path.resolve("tests/fixtures/workspace");
  const decision = decidePermission({
    toolName: "write_file",
    risk: "write",
    cwd,
    targetPaths: [".env"],
    summary: "write env"
  }, { workspace: cwd, approvals: { workspaceWrites: true } });

  assert.equal(decision.decision, "ask");
  assert.equal(decision.sensitive, true);
});

test("readonly sessions deny sensitive file writes", () => {
  const cwd = path.resolve("tests/fixtures/workspace");
  const decision = decidePermission({
    toolName: "write_file",
    risk: "write",
    cwd,
    targetPaths: [".env"],
    summary: "write env"
  }, { workspace: cwd, readonly: true, approvals: { workspaceWrites: true } });

  assert.equal(decision.decision, "deny");
});

test("asks before writes outside workspace", () => {
  const cwd = path.resolve("tests/fixtures/workspace");
  const outside = path.resolve(cwd, "..", "outside.txt");
  const decision = decidePermission({
    toolName: "write_file",
    risk: "write",
    cwd,
    targetPaths: [outside],
    summary: "write outside"
  }, { workspace: cwd });

  assert.equal(decision.decision, "ask");
  assert.equal(decision.outsideWorkspace, true);
});

test("normalizes quoted paths before permission boundary checks", () => {
  const cwd = path.resolve("tests/fixtures/workspace");
  const outside = path.resolve(cwd, "..", "outside.txt");
  const outsideDecision = decidePermission({
    toolName: "read_file",
    risk: "read",
    cwd,
    targetPaths: [`"${outside}"`],
    summary: "read quoted outside"
  }, { workspace: cwd });
  const sensitiveDecision = decidePermission({
    toolName: "write_file",
    risk: "write",
    cwd,
    targetPaths: ["\".env\""],
    summary: "write quoted env"
  }, { workspace: cwd, approvals: { workspaceWrites: true } });

  assert.equal(outsideDecision.decision, "ask");
  assert.equal(outsideDecision.outsideWorkspace, true);
  assert.equal(sensitiveDecision.decision, "ask");
  assert.equal(sensitiveDecision.sensitive, true);
});

test("readonly sessions deny writes outside workspace", () => {
  const cwd = path.resolve("tests/fixtures/workspace");
  const outside = path.resolve(cwd, "..", "outside.txt");
  const decision = decidePermission({
    toolName: "write_file",
    risk: "write",
    cwd,
    targetPaths: [outside],
    summary: "write outside"
  }, { workspace: cwd, readonly: true });

  assert.equal(decision.decision, "deny");
  assert.equal(decision.outsideWorkspace, true);
});

test("full access allows writes outside workspace and sensitive file writes", () => {
  const cwd = path.resolve("tests/fixtures/workspace");
  const outside = path.resolve(cwd, "..", "outside.txt");
  const outsideDecision = decidePermission({
    toolName: "write_file",
    risk: "write",
    cwd,
    targetPaths: [outside],
    summary: "write outside"
  }, { workspace: cwd, fullAccess: true });
  const sensitiveDecision = decidePermission({
    toolName: "write_file",
    risk: "write",
    cwd,
    targetPaths: [".env"],
    summary: "write env"
  }, { workspace: cwd, fullAccess: true });

  assert.equal(outsideDecision.decision, "allow");
  assert.equal(sensitiveDecision.decision, "allow");
});

test("asks for workspace writes without session approval", () => {
  const cwd = path.resolve("tests/fixtures/workspace");
  const decision = decidePermission({
    toolName: "write_file",
    risk: "write",
    cwd,
    targetPaths: ["notes.txt"],
    summary: "write inside"
  }, { workspace: cwd });

  assert.equal(decision.decision, "ask");
});

test("allows workspace writes with session approval", () => {
  const cwd = path.resolve("tests/fixtures/workspace");
  const decision = decidePermission({
    toolName: "write_file",
    risk: "write",
    cwd,
    targetPaths: ["notes.txt"],
    summary: "write inside"
  }, { workspace: cwd, approvals: { workspaceWrites: true } });

  assert.equal(decision.decision, "allow");
});

test("readonly sessions deny workspace writes", () => {
  const cwd = path.resolve("tests/fixtures/workspace");
  const decision = decidePermission({
    toolName: "write_file",
    risk: "write",
    cwd,
    targetPaths: ["notes.txt"],
    summary: "write inside"
  }, { workspace: cwd, readonly: true, approvals: { workspaceWrites: true } });

  assert.equal(decision.decision, "deny");
});

test("allows readonly shell commands without approval", () => {
  const cwd = path.resolve("tests/fixtures/workspace");
  const decision = decidePermission({
    toolName: "powershell",
    risk: "execute",
    cwd,
    command: "Get-Location",
    summary: "run readonly command"
  }, { workspace: cwd, networkMode: "offline" });

  assert.equal(decision.decision, "allow");
});

test("readonly shell commands ask when they reference outside workspace paths", () => {
  const cwd = path.resolve("tests/fixtures/workspace");
  const outside = path.resolve(cwd, "..", "outside.txt");
  const explicitOption = decidePermission({
    toolName: "powershell",
    risk: "execute",
    cwd,
    command: `Get-Content -LiteralPath "${outside}"`,
    summary: "run readonly command outside workspace"
  }, { workspace: cwd, networkMode: "offline" });
  const positionalArg = decidePermission({
    toolName: "powershell",
    risk: "execute",
    cwd,
    command: `Get-Content "${outside}"`,
    summary: "run readonly command outside workspace"
  }, { workspace: cwd, networkMode: "offline" });

  assert.equal(explicitOption.decision, "ask");
  assert.equal(positionalArg.decision, "ask");
  assert.match(explicitOption.reason, /outside workspace/);
  assert.match(positionalArg.reason, /outside workspace/);
});

test("asks for mutating shell commands without approval", () => {
  const cwd = path.resolve("tests/fixtures/workspace");
  const decision = decidePermission({
    toolName: "powershell",
    risk: "execute",
    cwd,
    command: "Set-Content -LiteralPath notes.txt -Value hello",
    summary: "run mutating command"
  }, { workspace: cwd, networkMode: "offline" });

  assert.equal(decision.decision, "ask");
});

test("allows mutating shell commands with session approval", () => {
  const cwd = path.resolve("tests/fixtures/workspace");
  const decision = decidePermission({
    toolName: "powershell",
    risk: "execute",
    cwd,
    command: "Set-Content -LiteralPath notes.txt -Value hello",
    summary: "run mutating command"
  }, { workspace: cwd, networkMode: "offline", approvals: { workspaceCommands: true } });

  assert.equal(decision.decision, "allow");
});

test("auto-approved shell commands still ask when they reference outside workspace paths", () => {
  const cwd = path.resolve("tests/fixtures/workspace");
  const outside = path.resolve(cwd, "..", "outside.txt");
  const decision = decidePermission({
    toolName: "powershell",
    risk: "execute",
    cwd,
    command: `Set-Content -LiteralPath "${outside}" -Value hello`,
    summary: "run mutating command outside workspace"
  }, { workspace: cwd, networkMode: "offline", approvals: { workspaceCommands: true } });

  assert.equal(decision.decision, "ask");
  assert.match(decision.reason, /outside workspace/);
});

test("auto-approved shell commands still ask for relative paths escaping the workspace", () => {
  const cwd = path.resolve("tests/fixtures/workspace");
  const decision = decidePermission({
    toolName: "powershell",
    risk: "execute",
    cwd,
    command: "Set-Content -LiteralPath ..\\outside.txt -Value hello",
    summary: "run mutating command through a relative outside path"
  }, { workspace: cwd, networkMode: "offline", approvals: { workspaceCommands: true } });

  assert.equal(decision.decision, "ask");
  assert.equal(decision.outsideWorkspace, true);
  assert.match(decision.reason, /outside workspace/);
});

test("auto-approved shell commands do not treat nested relative paths as absolute paths", () => {
  const cwd = path.resolve("tests/fixtures/workspace");
  const decision = decidePermission({
    toolName: "background_worktree",
    risk: "execute",
    cwd,
    command: "git worktree add --detach .lab-agent/worktrees/task-bg-test HEAD",
    summary: "create worktree"
  }, { workspace: cwd, networkMode: "offline", approvals: { workspaceCommands: true } });

  assert.equal(decision.decision, "allow");
});

test("auto-approved shell commands still ask for sensitive paths", () => {
  const cwd = path.resolve("tests/fixtures/workspace");
  const decision = decidePermission({
    toolName: "powershell",
    risk: "execute",
    cwd,
    command: "Set-Content -LiteralPath .env -Value SECRET=value",
    summary: "run mutating command touching env"
  }, { workspace: cwd, networkMode: "offline", approvals: { workspaceCommands: true } });

  assert.equal(decision.decision, "ask");
  assert.equal(decision.sensitive, true);
});

test("denies network-capable shell commands in offline mode", () => {
  const cwd = path.resolve("tests/fixtures/workspace");
  const decision = decidePermission({
    toolName: "powershell",
    risk: "execute",
    cwd,
    command: "Invoke-WebRequest https://gateway.lab.example",
    summary: "run network command"
  }, { workspace: cwd, networkMode: "offline", approvals: { workspaceCommands: true } });

  assert.equal(decision.decision, "deny");
});

test("full access allows mutating high-risk and network shell commands", () => {
  const cwd = path.resolve("tests/fixtures/workspace");
  const highRisk = decidePermission({
    toolName: "powershell",
    risk: "execute",
    cwd,
    command: "Remove-Item -Recurse C:\\tmp\\demo",
    summary: "high risk command"
  }, { workspace: cwd, networkMode: "offline", fullAccess: true });
  const network = decidePermission({
    toolName: "powershell",
    risk: "execute",
    cwd,
    command: "Invoke-WebRequest https://gateway.lab.example",
    summary: "network command"
  }, { workspace: cwd, networkMode: "offline", fullAccess: true });

  assert.equal(highRisk.decision, "allow");
  assert.equal(network.decision, "allow");
});

test("full access allows execute-risk agent_run without shell command text", () => {
  const cwd = path.resolve("tests/fixtures/workspace");
  const decision = decidePermission({
    toolName: "agent_run",
    risk: "execute",
    cwd,
    summary: "run verifier subagent"
  }, { workspace: cwd, networkMode: "offline", fullAccess: true });

  assert.equal(decision.decision, "allow");
});

test("execute-risk agent_run uses execute-tool approval instead of empty shell denial", () => {
  const cwd = path.resolve("tests/fixtures/workspace");
  const ask = decidePermission({
    toolName: "agent_run",
    risk: "execute",
    cwd,
    summary: "run verifier subagent"
  }, { workspace: cwd, networkMode: "offline" });
  const approved = decidePermission({
    toolName: "agent_run",
    risk: "execute",
    cwd,
    summary: "run verifier subagent"
  }, { workspace: cwd, networkMode: "offline", approvals: { workspaceCommands: true } });
  const readonly = decidePermission({
    toolName: "agent_run",
    risk: "execute",
    cwd,
    summary: "run verifier subagent"
  }, { workspace: cwd, networkMode: "offline", readonly: true, approvals: { workspaceCommands: true } });

  assert.equal(ask.decision, "ask");
  assert.doesNotMatch(ask.reason, /empty commands/);
  assert.equal(approved.decision, "allow");
  assert.equal(readonly.decision, "deny");
});

test("high-risk shell commands ask outside readonly and are denied when readonly locked", () => {
  const cwd = path.resolve("tests/fixtures/workspace");
  const normal = decidePermission({
    toolName: "powershell",
    risk: "execute",
    cwd,
    command: "Remove-Item -Recurse -Force .\\build",
    summary: "high risk command"
  }, { workspace: cwd, networkMode: "offline", approvals: { workspaceCommands: true } });
  const readonly = decidePermission({
    toolName: "powershell",
    risk: "execute",
    cwd,
    command: "Remove-Item -Recurse -Force .\\build",
    summary: "high risk command"
  }, { workspace: cwd, networkMode: "offline", readonly: true, approvals: { workspaceCommands: true } });

  assert.equal(normal.decision, "ask");
  assert.equal(readonly.decision, "deny");
});

test("documents and browser actions use distinct risk decisions", () => {
  const cwd = path.resolve("tests/fixtures/workspace");
  const documentDecision = decidePermission({
    toolName: "document_intake",
    risk: "document",
    cwd,
    targetPaths: ["docs/spec.md"],
    summary: "extract document"
  }, { workspace: cwd, networkMode: "offline" });
  const browserDecision = decidePermission({
    toolName: "mcp:playwright/browser_click",
    risk: "browser",
    cwd,
    summary: "click page"
  }, { workspace: cwd, networkMode: "approved-web" });

  assert.equal(documentDecision.decision, "allow");
  assert.equal(browserDecision.decision, "ask");
  assert.match(browserDecision.reason, /browser automation/);
});

test("full access allows MCP browser network and memory risks", () => {
  const cwd = path.resolve("tests/fixtures/workspace");
  const mcp = decidePermission({
    toolName: "mcp:github/search_repositories",
    risk: "mcp",
    cwd,
    summary: "call mcp"
  }, { workspace: cwd, fullAccess: true });
  const browser = decidePermission({
    toolName: "mcp:playwright/browser_click",
    risk: "browser",
    cwd,
    summary: "click page"
  }, { workspace: cwd, networkMode: "offline", fullAccess: true });
  const network = decidePermission({
    toolName: "web_fetch",
    risk: "network",
    cwd,
    networkHosts: ["https://example.com"],
    summary: "fetch"
  }, { workspace: cwd, networkMode: "offline", fullAccess: true });
  const memory = decidePermission({
    toolName: "mcp:memory/create_entities",
    risk: "memory",
    cwd,
    summary: "write memory"
  }, { workspace: cwd, fullAccess: true });

  assert.equal(mcp.decision, "allow");
  assert.equal(browser.decision, "allow");
  assert.equal(network.decision, "allow");
  assert.equal(memory.decision, "allow");
});

test("memory writes ask while memory reads are allowed", () => {
  const cwd = path.resolve("tests/fixtures/workspace");
  const read = decidePermission({
    toolName: "mcp:memory/read_graph",
    risk: "memory",
    cwd,
    summary: "read graph"
  }, { workspace: cwd });
  const write = decidePermission({
    toolName: "mcp:memory/create_entities",
    risk: "memory",
    cwd,
    summary: "write graph"
  }, { workspace: cwd });

  assert.equal(read.decision, "allow");
  assert.equal(write.decision, "ask");
});

test("classifies readonly and dangerous commands", () => {
  assert.equal(classifyCommand("git status --short").kind, "readonly");
  assert.equal(classifyCommand("git reset --hard HEAD").kind, "high-risk");
});
