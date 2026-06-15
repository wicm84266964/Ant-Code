import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { editFileTool, globTool, grepTool, readFileTool, writeFileTool } from "../../src/tools/file-tools.js";
import { scrubEnvironment } from "../../src/tools/env-scrubber.js";
import { createMcpRuntime } from "../../src/mcp/runtime.js";
import { documentIntakeTool } from "../../src/tools/document-tools.js";
import { serializeToolResult } from "../../src/tools/result.js";
import { createToolRuntime } from "../../src/tools/runtime.js";
import { parseDuckDuckGoHtml } from "../../src/tools/web-tools.js";
import { createWorkflowState, syncWorkflowCompletionOnFinal } from "../../src/tools/workflow-tools.js";
import { listBackgroundAgentTasks } from "../../src/agents/background-registry.js";

const execFileAsync = promisify(execFile);

test("glob matches source files with bounded output", async () => {
  const result = await globTool({
    cwd: process.cwd(),
    pattern: "src/**/*.js",
    maxMatches: 5
  });

  assert.ok(result.matches.length <= 5);
  assert.ok(result.matches.some((item) => item.startsWith("src/") && item.endsWith(".js")));
});

test("read file returns workspace-relative path", async () => {
  const result = await readFileTool({
    cwd: process.cwd(),
    path: "README.md",
    maxBytes: 128
  });

  assert.equal(result.path, "README.md");
  assert.match(result.content, /Ant Code/);
});

test("read_file defaults to full file content", async () => {
  const cwd = await makeTempWorkspace();
  const content = `${"0123456789abcdef".repeat(8192)}\nFULL_TAIL`;
  await fs.writeFile(path.join(cwd, "large.txt"), content, "utf8");

  const result = await readFileTool({
    cwd,
    path: "large.txt"
  });

  assert.equal(result.truncated, false);
  assert.equal(result.content, content);
  assert.equal(result.bytesRead, Buffer.byteLength(content, "utf8"));
});

test("grep defaults to all matches with full matching lines", async () => {
  const cwd = await makeTempWorkspace();
  const longLine = `needle-${"x".repeat(900)}-tail`;
  await fs.writeFile(path.join(cwd, "a.txt"), `${longLine}\nneedle-two\n`, "utf8");
  await fs.writeFile(path.join(cwd, "b.txt"), "needle-three\n", "utf8");

  const result = await grepTool({
    cwd,
    pattern: "needle"
  });

  assert.equal(result.truncated, false);
  assert.equal(result.matches.length, 3);
  assert.equal(result.matches[0].text, longLine);
});

test("grep skips binary model/data artifacts while preserving text matches", async () => {
  const cwd = await makeTempWorkspace();
  await fs.mkdir(path.join(cwd, "weights"), { recursive: true });
  await fs.writeFile(path.join(cwd, "weights", "model.pth"), Buffer.from("needle-in-model\0binary"));
  await fs.writeFile(path.join(cwd, "ant_V2.db"), Buffer.from("needle-in-db\0binary"));
  await fs.writeFile(path.join(cwd, "source.py"), "needle-in-source\n", "utf8");

  const result = await grepTool({
    cwd,
    pattern: "needle"
  });

  assert.equal(result.truncated, false);
  assert.deepEqual(result.matches.map((match) => match.path), ["source.py"]);
  assert.equal(result.matches[0].text, "needle-in-source");
});

test("tool result serializer preserves oversized JSON for model context", () => {
  const result = serializeToolResult({
    ok: true,
    result: { content: `head-${"x".repeat(1000)}-tail` }
  }, { maxBytes: 128 });

  assert.equal(result.truncated, false);
  assert.match(result.content, /head-/);
  assert.match(result.content, /-tail/);
  assert.equal("omittedBytes" in result, false);
});

test("tool runtime blocks write_file without approval", async () => {
  const cwd = await makeTempWorkspace();
  const runtime = createToolRuntime({ cwd });
  const result = await runtime.execute("write_file", {
    path: "notes.txt",
    content: "hello"
  });

  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.equal(result.decision.decision, "ask");
});

test("write_file writes content and returns a diff when approved", async () => {
  const cwd = await makeTempWorkspace();
  const runtime = createToolRuntime({
    cwd,
    policy: { approvals: { workspaceWrites: true } }
  });

  const result = await runtime.execute("write_file", {
    path: "notes.txt",
    content: "hello\n"
  });

  assert.equal(result.ok, true);
  assert.equal(await fs.readFile(path.join(cwd, "notes.txt"), "utf8"), "hello\n");
  assert.match(result.result.diff, /\+\+\+ b\/notes\.txt/);
  assert.match(result.result.diff, /\+hello/);
});

test("full access file tools can read and write outside the workspace", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-full-access-"));
  const cwd = path.join(root, "workspace");
  const outside = path.join(root, "outside.txt");
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(outside, "outside before\n", "utf8");
  const runtime = createToolRuntime({
    cwd,
    policy: { fullAccess: true }
  });

  const read = await runtime.execute("read_file", {
    path: outside,
    maxBytes: 128
  });
  const write = await runtime.execute("write_file", {
    path: outside,
    content: "outside after\n"
  });

  assert.equal(read.ok, true);
  assert.equal(read.result.path, outside.replace(/\\/g, "/"));
  assert.match(read.result.content, /outside before/);
  assert.equal(write.ok, true);
  assert.equal(write.result.path, outside.replace(/\\/g, "/"));
  assert.equal(await fs.readFile(outside, "utf8"), "outside after\n");
});

test("file tools normalize quoted paths and report clear missing-file errors", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-quoted-path-"));
  const cwd = path.join(root, "workspace");
  const outside = path.join(root, "outside.txt");
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(outside, "quoted outside path\n", "utf8");
  const runtime = createToolRuntime({
    cwd,
    policy: { fullAccess: true }
  });

  const quoted = await runtime.execute("read_file", {
    path: `"${outside}"`,
    maxBytes: 128
  });
  const missing = await runtime.execute("read_file", {
    path: path.join(root, "missing.txt"),
    maxBytes: 128
  });

  assert.equal(quoted.ok, true);
  assert.match(quoted.result.content, /quoted outside path/);
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "FILE_NOT_FOUND");
  assert.match(missing.error.message, /missing\.txt/);
  assert.match(missing.error.message, /from path=/);
});

test("workspace permission asks before file tool writes outside the workspace", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-workspace-approval-"));
  const cwd = path.join(root, "workspace");
  const outside = path.join(root, "outside.txt");
  await fs.mkdir(cwd, { recursive: true });
  const runtime = createToolRuntime({
    cwd,
    policy: { approvals: { workspaceWrites: true } }
  });

  const result = await runtime.execute("write_file", {
    path: outside,
    content: "should not write\n"
  });

  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.equal(result.decision.decision, "ask");
  assert.equal(result.decision.outsideWorkspace, true);
  await assert.rejects(fs.readFile(outside, "utf8"), /ENOENT/);
});

test("workspace permission asks before quoted file tool paths outside the workspace", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-quoted-outside-ask-"));
  const cwd = path.join(root, "workspace");
  const outside = path.join(root, "outside.txt");
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(outside, "quoted outside read should ask\n", "utf8");
  const runtime = createToolRuntime({
    cwd,
    policy: { approvals: { workspaceWrites: true } }
  });

  const read = await runtime.execute("read_file", {
    path: `"${outside}"`,
    maxBytes: 128
  });
  const write = await runtime.execute("write_file", {
    path: `"${outside}"`,
    content: "should not write\n"
  });

  assert.equal(read.ok, false);
  assert.equal(read.blocked, true);
  assert.equal(read.decision.outsideWorkspace, true);
  assert.equal(write.ok, false);
  assert.equal(write.blocked, true);
  assert.equal(write.decision.outsideWorkspace, true);
  assert.equal(await fs.readFile(outside, "utf8"), "quoted outside read should ask\n");
});

test("approved outside-workspace file tool writes execute in plan mode", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-plan-outside-"));
  const cwd = path.join(root, "workspace");
  const outside = path.join(root, "outside.txt");
  const approvals = [];
  await fs.mkdir(cwd, { recursive: true });
  const runtime = createToolRuntime({
    cwd,
    approve: async (request) => {
      approvals.push(request);
      return true;
    }
  });

  const result = await runtime.execute("write_file", {
    path: outside,
    content: "approved outside write\n"
  });

  assert.equal(result.ok, true);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].decision.outsideWorkspace, true);
  assert.equal(result.result.path, outside.replace(/\\/g, "/"));
  assert.equal(await fs.readFile(outside, "utf8"), "approved outside write\n");
});

test("approved outside-workspace file reads execute in plan mode", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-plan-outside-read-"));
  const cwd = path.join(root, "workspace");
  const outside = path.join(root, "outside.txt");
  const approvals = [];
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(outside, "approved outside read\n", "utf8");
  const runtime = createToolRuntime({
    cwd,
    approve: async (request) => {
      approvals.push(request);
      return true;
    }
  });

  const result = await runtime.execute("read_file", {
    path: outside,
    maxBytes: 128
  });

  assert.equal(result.ok, true);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].decision.outsideWorkspace, true);
  assert.match(result.result.content, /approved outside read/);
});

test("sensitive file writes require explicit approval and redact diffs", async () => {
  const cwd = await makeTempWorkspace();
  await fs.writeFile(path.join(cwd, ".env"), "API_KEY=old-secret\n", "utf8");
  const approvals = [];
  const runtime = createToolRuntime({
    cwd,
    policy: { approvals: { workspaceWrites: true } },
    approve: async (request) => {
      approvals.push(request);
      return true;
    }
  });

  const result = await runtime.execute("write_file", {
    path: ".env",
    content: "API_KEY=new-secret\n"
  });

  assert.equal(result.ok, true);
  assert.equal(await fs.readFile(path.join(cwd, ".env"), "utf8"), "API_KEY=new-secret\n");
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].decision.sensitive, true);
  assert.equal(result.result.diffRedacted, true);
  assert.match(result.result.diff, /sensitive diff redacted/);
  assert.doesNotMatch(result.result.diff, /old-secret|new-secret/);
});

test("sensitive file writes are blocked when strong confirmation is rejected", async () => {
  const cwd = await makeTempWorkspace();
  await fs.writeFile(path.join(cwd, ".env"), "API_KEY=old-secret\n", "utf8");
  const runtime = createToolRuntime({
    cwd,
    policy: { approvals: { workspaceWrites: true } },
    approve: async () => false
  });

  const result = await runtime.execute("write_file", {
    path: ".env",
    content: "API_KEY=new-secret\n"
  });

  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.equal(result.decision.sensitive, true);
  assert.equal(await fs.readFile(path.join(cwd, ".env"), "utf8"), "API_KEY=old-secret\n");
});

test("edit_file replaces exact text and returns a diff", async () => {
  const cwd = await makeTempWorkspace();
  await writeFileTool({ cwd, path: "notes.txt", content: "alpha\nbeta\n" });

  const result = await editFileTool({
    cwd,
    path: "notes.txt",
    oldText: "beta",
    newText: "gamma"
  });

  assert.equal(result.edited, true);
  assert.equal(await fs.readFile(path.join(cwd, "notes.txt"), "utf8"), "alpha\ngamma\n");
  assert.match(result.diff, /-beta/);
  assert.match(result.diff, /\+gamma/);
  assert.equal(result.beforeBytes, Buffer.byteLength("alpha\nbeta\n", "utf8"));
  assert.equal(result.afterBytes, Buffer.byteLength("alpha\ngamma\n", "utf8"));
});

test("file tools report line-level change stats", async () => {
  const cwd = await makeTempWorkspace();
  await writeFileTool({ cwd, path: "notes.txt", content: "alpha\nbeta\ngamma\n" });

  const result = await editFileTool({
    cwd,
    path: "notes.txt",
    oldText: "beta",
    newText: "delta"
  });

  assert.equal(result.edited, true);
  assert.deepEqual(result.changeStats, {
    path: "notes.txt",
    additions: 1,
    deletions: 1,
    files: 1,
    redacted: false,
    truncated: false,
    approximate: false
  });
  assert.equal(Object.keys(result).includes("__changeSnapshot"), false);
});

test("edit_file redacts diffs for sensitive files", async () => {
  const cwd = await makeTempWorkspace();
  await fs.writeFile(path.join(cwd, ".env"), "API_KEY=old-secret\n", "utf8");

  const result = await editFileTool({
    cwd,
    path: ".env",
    oldText: "old-secret",
    newText: "new-secret"
  });

  assert.equal(result.edited, true);
  assert.equal(result.diffRedacted, true);
  assert.match(result.diff, /sensitive diff redacted/);
  assert.doesNotMatch(result.diff, /old-secret|new-secret/);
});

test("edit_file dry run previews a diff without writing", async () => {
  const cwd = await makeTempWorkspace();
  await writeFileTool({ cwd, path: "notes.txt", content: "alpha\nbeta\n" });

  const result = await editFileTool({
    cwd,
    path: "notes.txt",
    oldText: "beta",
    newText: "gamma",
    dryRun: true
  });

  assert.equal(result.edited, false);
  assert.equal(result.wouldEdit, true);
  assert.equal(await fs.readFile(path.join(cwd, "notes.txt"), "utf8"), "alpha\nbeta\n");
  assert.match(result.diff, /\+gamma/);
});

test("edit_file reports precise edit preflight failures", async () => {
  const cwd = await makeTempWorkspace();
  await writeFileTool({ cwd, path: "notes.txt", content: "alpha\nbeta\nbeta\n" });

  const missing = await editFileTool({
    cwd,
    path: "notes.txt",
    oldText: "delta",
    newText: "epsilon"
  });
  const ambiguous = await editFileTool({
    cwd,
    path: "notes.txt",
    oldText: "beta",
    newText: "gamma"
  });
  const noop = await editFileTool({
    cwd,
    path: "notes.txt",
    oldText: "beta",
    newText: "beta"
  });

  assert.equal(missing.edited, false);
  assert.equal(missing.error.code, "OLD_TEXT_NOT_FOUND");
  assert.equal(missing.replacements, 0);
  assert.equal(ambiguous.edited, false);
  assert.equal(ambiguous.error.code, "REPLACEMENT_COUNT_MISMATCH");
  assert.equal(ambiguous.replacements, 2);
  assert.equal(noop.edited, false);
  assert.equal(noop.error.code, "NOOP_EDIT");
});

test("scrubs secret-like environment variables", () => {
  const result = scrubEnvironment({
    PATH: process.env.PATH ?? "",
    LAB_TOKEN: "secret",
    OPENAI_API_KEY: "secret",
    NORMAL_VALUE: "ok"
  });

  assert.equal(result.env.NORMAL_VALUE, "ok");
  assert.equal("LAB_TOKEN" in result.env, false);
  assert.equal("OPENAI_API_KEY" in result.env, false);
  assert.ok(result.removed.includes("LAB_TOKEN"));
  assert.ok(result.removed.includes("OPENAI_API_KEY"));
});

test("workflow tools keep todo and plan state inside the session runtime", async () => {
  const workflowState = createWorkflowState();
  const runtime = createToolRuntime({ cwd: process.cwd(), workflowState });

  const todos = await runtime.execute("todo_write", {
    items: [
      "confirm requirements",
      { content: "inspect code", status: "completed" },
      { task: "write tests", status: "in progress" }
    ]
  });
  const plan = await runtime.execute("plan_update", {
    explanation: "phase plan",
    steps: [
      "prepare",
      { description: "implement", status: "pending" },
      { content: "verify", status: "pending" }
    ]
  });
  const read = await runtime.execute("todo_read", {});
  const aliasTodos = await runtime.execute("todo_write", {
    todos: [
      { task: "alias todo", status: "complete" },
      { task: "中文完成", status: "已完成" },
      { task: "bool done", done: true },
      { task: "active todo", status: "进行中" },
      { task: "queued todo", status: "未开始" }
    ]
  });
  const aliasPlan = await runtime.execute("plan_update", {
    plan: ["alias plan"]
  });

  assert.equal(todos.ok, true);
  assert.equal(plan.ok, true);
  assert.deepEqual(read.result, [
    { id: "todo-1", content: "confirm requirements", status: "pending" },
    { id: "todo-2", content: "inspect code", status: "completed" },
    { id: "todo-3", content: "write tests", status: "in_progress" }
  ]);
  assert.equal(plan.result.steps.length, 3);
  assert.equal(plan.result.steps[0].content, "prepare");
  assert.equal(plan.result.steps[1].content, "implement");
  assert.equal(aliasTodos.result.todos[0].content, "alias todo");
  assert.equal(aliasTodos.result.todos[0].status, "completed");
  assert.equal(aliasTodos.result.todos[1].status, "completed");
  assert.equal(aliasTodos.result.todos[2].status, "completed");
  assert.equal(aliasTodos.result.todos[3].status, "in_progress");
  assert.equal(aliasTodos.result.todos[4].status, "pending");
  assert.equal(aliasPlan.result.steps[0].content, "alias plan");
});

test("workflow final sync completes visible active items after successful final text", () => {
  const workflowState = createWorkflowState();
  workflowState.todos = [
    { id: "todo-1", content: "inspect", status: "in_progress" },
    { id: "todo-2", content: "report", status: "pending" },
    { id: "todo-3", content: "skip", status: "cancelled" }
  ];
  workflowState.plan.steps = [
    { id: "step-1", content: "verify", status: "进行中" },
    { id: "step-2", content: "publish", status: "pending" }
  ];

  const result = syncWorkflowCompletionOnFinal(workflowState, "全部待办和计划步骤已完成。");

  assert.equal(result.changed, true);
  assert.equal(result.todosCompleted, 2);
  assert.equal(result.planStepsCompleted, 2);
  assert.deepEqual(workflowState.todos.map((item) => item.status), ["completed", "completed", "cancelled"]);
  assert.deepEqual(workflowState.plan.steps.map((item) => item.status), ["completed", "completed"]);
});

test("workflow final sync leaves active items alone when final text reports failure", () => {
  const workflowState = createWorkflowState();
  workflowState.todos = [
    { id: "todo-1", content: "inspect", status: "in_progress" }
  ];

  const result = syncWorkflowCompletionOnFinal(workflowState, "验证失败，任务未完成。");

  assert.equal(result.changed, false);
  assert.equal(workflowState.todos[0].status, "in_progress");
});

test("skill tools expose local instruction resources without executing scripts", async () => {
  const cwd = await makeTempWorkspace();
  const skillDir = path.join(cwd, ".lab-agent", "skills", "demo");
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), [
    "---",
    "name: demo",
    "description: Demo workflow",
    "when_to_use: demo tasks",
    "---",
    "# Demo Skill",
    "Read first, then act."
  ].join("\n"), "utf8");
  const runtime = createToolRuntime({ cwd, env: {} });

  const listed = await runtime.execute("skill_list", {});
  const read = await runtime.execute("skill_read", { name: "demo" });
  const run = await runtime.execute("skill_run", { name: "demo", message: "inspect" });

  assert.equal(listed.ok, true);
  assert.equal(listed.result[0].name, "demo");
  assert.equal(read.ok, true);
  assert.match(read.result.content, /Read first/);
  assert.equal(run.ok, true);
  assert.equal(run.result.execution, "instruction-only");
  assert.match(run.result.note, /does not execute scripts/);
});

test("skill tools load configured external roots without treating sibling docs as skills", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-external-skills-"));
  const cwd = path.join(root, "workspace");
  const packageRoot = path.join(root, "external-package");
  const containerRoot = path.join(root, "external-container");
  const nestedSkill = path.join(containerRoot, "nested-demo");
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(packageRoot, { recursive: true });
  await fs.mkdir(nestedSkill, { recursive: true });
  await fs.writeFile(path.join(packageRoot, "SKILL.md"), [
    "---",
    "name: external-direct",
    "description: External direct skill",
    "---",
    "# External Direct",
    "Use an outside package root."
  ].join("\n"), "utf8");
  await fs.writeFile(path.join(packageRoot, "README.md"), "# Not a skill\n", "utf8");
  await fs.writeFile(path.join(nestedSkill, "SKILL.md"), [
    "---",
    "name: external-nested",
    "description: External nested skill",
    "---",
    "# External Nested",
    "Use a configured container root."
  ].join("\n"), "utf8");
  const runtime = createToolRuntime({
    cwd,
    env: {},
    config: {
      skills: {
        enabled: true,
        paths: [
          packageRoot.replace(/\\/g, "/"),
          containerRoot
        ]
      }
    }
  });

  const listed = await runtime.execute("skill_list", { query: "external" });
  const read = await runtime.execute("skill_read", { name: "external-direct" });

  assert.equal(listed.ok, true);
  assert.deepEqual(listed.result.map((skill) => skill.name).sort(), ["external-direct", "external-nested"]);
  assert.equal(read.ok, true);
  assert.match(read.result.content, /Use an outside package root/);
  assert.doesNotMatch(JSON.stringify(listed.result), /README/);
});

test("fork skills run through a hidden local subagent and create a task record", async () => {
  const cwd = await makeTempWorkspace();
  const skillDir = path.join(cwd, ".lab-agent", "skills", "demo-fork");
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), [
    "---",
    "name: demo-fork",
    "description: Demo fork workflow",
    "context: fork",
    "agent: explorer",
    "allowed-tools: glob, grep",
    "---",
    "# Demo Fork Skill",
    "Inspect files in an isolated subagent."
  ].join("\n"), "utf8");
  await fs.mkdir(path.join(cwd, "src"));
  await fs.writeFile(path.join(cwd, "src", "notes.js"), "const marker = 'ForkSkill';\n", "utf8");
  const runtime = createToolRuntime({
    cwd,
    env: {},
    config: {
      networkMode: "approved-web",
      allowedHosts: [],
      lab: {
        gatewayUrl: "",
        gatewayProtocol: "lab-agent-gateway",
        gatewayApiKey: null
      },
      agents: {
        modelTiers: {}
      },
      mcp: {
        servers: []
      }
    }
  });

  const result = await runtime.execute("skill_run", {
    name: "demo-fork",
    message: "find ForkSkill"
  });

  assert.equal(result.ok, true);
  assert.equal(result.result.execution, "fork");
  assert.equal(result.result.task.ok, true);
  assert.match(result.result.task.taskId, /^task-/);
  assert.equal(result.result.task.profile, "skill-demo-fork");
});

test("full access lets fork skills use the base profile toolset instead of the skill allowlist", async () => {
  const cwd = await makeTempWorkspace();
  const requests = [];
  const server = await listen(createToolGateway(requests, {
    toolCall: {
      id: "fetch-docs",
      name: "web_fetch",
      input: { url: "https://example.com/docs", maxBytes: 2048 }
    },
    finalText: "used web fetch from a full-access skill fork"
  }), "127.0.0.1");
  const skillDir = path.join(cwd, ".lab-agent", "skills", "demo-web-skill");
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), [
    "---",
    "name: demo-web-skill",
    "description: Demo web skill",
    "context: fork",
    "agent: web-researcher",
    "allowed-tools: skill_list",
    "---",
    "# Demo Web Skill",
    "Use web evidence when allowed."
  ].join("\n"), "utf8");
  const runtime = createToolRuntime({
    cwd,
    env: {
      LAB_AGENT_TRANSCRIPT_ENABLED: "false"
    },
    policy: { fullAccess: true },
    config: {
      modelAlias: "mock-agent",
      networkMode: "lab-only",
      allowedHosts: [],
      lab: {
        gatewayUrl: `${serverUrl(server)}/v1/chat`,
        gatewayProtocol: "lab-agent-gateway",
        gatewayApiKey: null
      },
      agents: {
        modelTiers: {}
      },
      mcp: {
        servers: []
      }
    }
  });

  try {
    const result = await runtime.execute("skill_run", {
      name: "demo-web-skill",
      message: "fetch the docs"
    });

    assert.equal(result.ok, true);
    assert.equal(result.result.execution, "fork");
    assert.equal(result.result.task.ok, true);
    assert.match(result.result.task.output, /used web fetch/);
    assert.equal(result.result.task.tools[0].name, "web_fetch");
    assert.equal(result.result.task.tools[0].ok, true);
  } finally {
    await close(server);
  }
});

test("browser verifier agent_run uses browser risk approval", async () => {
  const cwd = await makeTempWorkspace();
  const approvals = [];
  const runtime = createToolRuntime({
    cwd,
    env: {
      LAB_AGENT_TRANSCRIPT_ENABLED: "false"
    },
    config: {
      networkMode: "lab-only",
      allowedHosts: [],
      lab: {
        gatewayUrl: "",
        gatewayProtocol: "lab-agent-gateway",
        gatewayApiKey: null
      },
      agents: { profiles: [] },
      mcp: { servers: [] }
    },
    approve: async (request) => {
      approvals.push(request);
      return false;
    }
  });

  const result = await runtime.execute("agent_run", {
    profile: "browser-verifier",
    query: "verify local UI"
  });

  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].decision.reason.includes("browser automation"), true);
  assert.equal(approvals[0].definition.name, "agent_run");
});

test("visual verifier agent_run uses browser risk approval", async () => {
  const cwd = await makeTempWorkspace();
  const approvals = [];
  const runtime = createToolRuntime({
    cwd,
    env: {
      LAB_AGENT_TRANSCRIPT_ENABLED: "false"
    },
    config: {
      networkMode: "lab-only",
      allowedHosts: [],
      lab: {
        gatewayUrl: "",
        gatewayProtocol: "lab-agent-gateway",
        gatewayApiKey: null
      },
      agents: {
        profiles: [],
        vision: { enabled: true, model: "vision-model" }
      },
      mcp: { servers: [] }
    },
    approve: async (request) => {
      approvals.push(request);
      return false;
    }
  });

  const result = await runtime.execute("agent_run", {
    profile: "visual-verifier",
    purpose: "visual",
    query: "review screenshot layout"
  });

  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].decision.reason.includes("browser automation"), true);
  assert.equal(approvals[0].definition.name, "agent_run");
});

test("full access agent_run starts write-capable subagents without approval", async () => {
  const cwd = await makeTempWorkspace();
  const approvals = [];
  const runtime = createToolRuntime({
    cwd,
    env: {
      LAB_AGENT_TRANSCRIPT_ENABLED: "false"
    },
    config: {
      networkMode: "offline",
      allowedHosts: [],
      lab: {
        gatewayUrl: "",
        gatewayProtocol: "lab-agent-gateway",
        gatewayApiKey: null
      },
      agents: { profiles: [] },
      mcp: { servers: [] }
    },
    policy: { fullAccess: true },
    approve: async (request) => {
      approvals.push(request);
      return false;
    }
  });

  const result = await runtime.execute("agent_run", {
    profile: "junior",
    query: "try to write"
  });

  assert.equal(approvals.length, 0);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "AGENT_GATEWAY_NOT_CONFIGURED");
  assert.equal(result.blocked, undefined);
});

test("full access agent_run starts verifier without empty command denial", async () => {
  const cwd = await makeTempWorkspace();
  const approvals = [];
  const runtime = createToolRuntime({
    cwd,
    env: {
      LAB_AGENT_TRANSCRIPT_ENABLED: "false"
    },
    config: {
      networkMode: "offline",
      allowedHosts: [],
      lab: {
        gatewayUrl: "",
        gatewayProtocol: "lab-agent-gateway",
        gatewayApiKey: null
      },
      agents: { profiles: [] },
      mcp: { servers: [] }
    },
    policy: { fullAccess: true },
    approve: async (request) => {
      approvals.push(request);
      return false;
    }
  });

  const result = await runtime.execute("agent_run", {
    profile: "verifier",
    taskId: "task-verifier-full-access",
    query: "run a validation command"
  });

  assert.equal(approvals.length, 0);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "AGENT_GATEWAY_NOT_CONFIGURED");
  assert.notEqual(result.decision?.reason, "empty commands are not executable");
  const rawTask = await fs.readFile(path.join(cwd, ".lab-agent", "tasks", "task-verifier-full-access.json"), "utf8");
  const task = JSON.parse(rawTask);
  assert.equal(task.status, "failed");
  assert.equal(task.profile, "verifier");
  assert.equal(task.error.code, "AGENT_GATEWAY_NOT_CONFIGURED");
});

test("background agent_run returns task and group immediately", async () => {
  const cwd = await makeTempWorkspace();
  const backgroundEvents = [];
  const runtime = createToolRuntime({
    cwd,
    env: {
      LAB_AGENT_TRANSCRIPT_ENABLED: "false"
    },
    config: {
      networkMode: "offline",
      allowedHosts: [],
      lab: {
        gatewayUrl: "",
        gatewayProtocol: "lab-agent-gateway",
        gatewayApiKey: null
      },
      agents: {
        backgroundWakeup: {
          enabled: true,
          autoQueueParentPrompt: true,
          defaultWaitFor: "all"
        },
        profiles: []
      },
      mcp: { servers: [] }
    },
    policy: { fullAccess: true },
    parentSessionId: "session-bg-test",
    onBackgroundAgentEvent: (event) => backgroundEvents.push(event)
  });

  const result = await runtime.execute("agent_run", {
    profile: "explorer",
    taskId: "task-bg-explorer",
    groupId: "group-bg",
    background: true,
    query: "inspect in background"
  });

  assert.equal(result.ok, true);
  assert.equal(result.result.background, true);
  assert.equal(result.result.taskId, "task-bg-explorer");
  assert.equal(result.result.groupId, "group-bg");
  assert.equal(listBackgroundAgentTasks({ parentSessionId: "session-bg-test" }).length, 1);

  await waitFor(async () => listBackgroundAgentTasks({ parentSessionId: "session-bg-test" }).length === 0);
  const rawGroup = await fs.readFile(path.join(cwd, ".lab-agent", "task-groups", "group-bg.json"), "utf8");
  const group = JSON.parse(rawGroup);
  assert.equal(group.status, "completed");
  assert.match(group.wakePrompt, /Ant Code subagent group completed/);
  const progress = backgroundEvents.find((event) => event.type === "subagent_group_progress");
  const wakeup = backgroundEvents.find((event) => event.type === "subagent_group_wakeup");
  assert.equal(progress?.waitFor, "all");
  assert.equal(progress?.wakeParent, true);
  assert.equal(wakeup?.waitFor, "all");
  assert.equal(wakeup?.wakeParent, true);
});

test("blocked agent_run writes a task record for TUI detail views", async () => {
  const cwd = await makeTempWorkspace();
  const runtime = createToolRuntime({
    cwd,
    env: {
      LAB_AGENT_TRANSCRIPT_ENABLED: "false"
    },
    config: {
      networkMode: "offline",
      allowedHosts: [],
      lab: {
        gatewayUrl: "",
        gatewayProtocol: "lab-agent-gateway",
        gatewayApiKey: null
      },
      agents: { profiles: [] },
      mcp: { servers: [] }
    },
    policy: { networkMode: "offline" }
  });

  const result = await runtime.execute("agent_run", {
    profile: "verifier",
    taskId: "task-verifier-blocked",
    query: "run a validation command"
  });
  const rawTask = await fs.readFile(path.join(cwd, ".lab-agent", "tasks", "task-verifier-blocked.json"), "utf8");
  const task = JSON.parse(rawTask);

  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.equal(result.decision.decision, "ask");
  assert.doesNotMatch(result.decision.reason, /empty commands/);
  assert.equal(task.status, "blocked");
  assert.equal(task.profile, "verifier");
  assert.equal(task.error.code, "AGENT_RUN_BLOCKED");
  assert.match(task.output, /子智能体未启动/);
});

test("invalid agent_run writes a failed task record for TUI detail views", async () => {
  const cwd = await makeTempWorkspace();
  const runtime = createToolRuntime({
    cwd,
    env: {
      LAB_AGENT_TRANSCRIPT_ENABLED: "false"
    },
    config: {
      networkMode: "offline",
      allowedHosts: [],
      lab: {
        gatewayUrl: "",
        gatewayProtocol: "lab-agent-gateway",
        gatewayApiKey: null
      },
      agents: { profiles: [] },
      mcp: { servers: [] }
    },
    policy: { fullAccess: true },
    parentSessionId: "session-invalid-agent"
  });

  const result = await runtime.execute("agent_run", {
    profile: "explorer",
    taskId: "task-invalid-agent"
  });
  const rawTask = await fs.readFile(path.join(cwd, ".lab-agent", "tasks", "task-invalid-agent.json"), "utf8");
  const task = JSON.parse(rawTask);

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "TOOL_INPUT_INVALID");
  assert.match(result.error.message, /query/);
  assert.equal(task.status, "failed");
  assert.equal(task.profile, "explorer");
  assert.equal(task.error.code, "TOOL_INPUT_INVALID");
  assert.match(task.output, /子智能体未启动/);
});

test("agent_run accepts message as a query alias", async () => {
  const cwd = await makeTempWorkspace();
  const runtime = createToolRuntime({
    cwd,
    env: {
      LAB_AGENT_TRANSCRIPT_ENABLED: "false"
    },
    config: {
      networkMode: "offline",
      allowedHosts: [],
      lab: {
        gatewayUrl: "",
        gatewayProtocol: "lab-agent-gateway",
        gatewayApiKey: null
      },
      agents: { profiles: [] },
      mcp: { servers: [] }
    },
    policy: { fullAccess: true },
    parentSessionId: "session-agent-alias"
  });

  const result = await runtime.execute("agent_run", {
    profile: "explorer",
    taskId: "task-agent-alias",
    message: "inspect with alias"
  });
  const rawTask = await fs.readFile(path.join(cwd, ".lab-agent", "tasks", "task-agent-alias.json"), "utf8");
  const task = JSON.parse(rawTask);

  assert.equal(result.ok, true);
  assert.equal(task.prompt, "inspect with alias");
  assert.notEqual(task.status, "failed");
});

test("mcp_list tool exposes configured MCP servers and tools", async (t) => {
  const config = {
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
  };
  const mcpRuntime = createMcpRuntime({
    cwd: process.cwd(),
    config,
    policy: { networkMode: "offline" }
  });
  t.after(() => mcpRuntime.close());
  const runtime = createToolRuntime({
    cwd: process.cwd(),
    config,
    mcpRuntime
  });

  const servers = await runtime.execute("mcp_list", {});
  const tools = await runtime.execute("mcp_list", { server: "local-echo" });

  assert.equal(servers.ok, true);
  assert.equal(servers.result[0].name, "local-echo");
  assert.equal(tools.ok, true);
  assert.equal(tools.tools[0].name, "echo");
});

test("tool runtime records file changes and validation commands in workflow state", async () => {
  const cwd = await makeTempWorkspace();
  const workflowState = createWorkflowState();
  const runtime = createToolRuntime({
    cwd,
    workflowState,
    policy: {
      networkMode: "offline",
      approvals: {
        workspaceWrites: true,
        workspaceCommands: true
      }
    }
  });
  const shellTool = process.platform === "win32" ? "powershell" : "bash";
  const command = process.platform === "win32" ? "Get-Location" : "pwd";

  await runtime.execute("write_file", {
    path: "notes.txt",
    content: "hello\n"
  });
  await runtime.execute(shellTool, {
    command,
    timeoutMs: 10_000
  });

  assert.equal(workflowState.changes.length, 1);
  assert.equal(workflowState.changes[0].path, "notes.txt");
  assert.equal(workflowState.changes[0].created, true);
  assert.equal(workflowState.validations.length, 1);
  assert.equal(workflowState.validations[0].command, command);
  assert.equal(workflowState.validations[0].passed, true);
});

test("shell tools preserve full output for model context", async () => {
  const cwd = await makeTempWorkspace();
  const runtime = createToolRuntime({
    cwd,
    policy: {
      networkMode: "offline",
      approvals: {
        workspaceCommands: true
      }
    }
  });
  const toolName = process.platform === "win32" ? "powershell" : "bash";
  const command = process.platform === "win32"
    ? "\"HEAD\"; 1..9000 | ForEach-Object { \"middle-$_\" }; \"TAIL\""
    : "printf 'HEAD\\n'; for i in $(seq 1 9000); do printf 'middle-%s\\n' \"$i\"; done; printf 'TAIL\\n'";

  const result = await runtime.execute(toolName, {
    command,
    timeoutMs: 120_000
  });

  assert.equal(result.ok, true);
  assert.equal(result.result.stdoutTruncated, false);
  assert.match(result.result.stdout, /HEAD/);
  assert.doesNotMatch(result.result.stdout, /shell output truncated/);
  assert.match(result.result.stdout, /TAIL/);
  assert.match(result.result.stdout, /middle-4500/);
  assert.equal(typeof result.result.stdoutBytes, "number");
});

test("web_fetch fetches loopback HTML and converts it to markdown", async () => {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<html><body><h1>Lab Page</h1><p>Hello <a href=\"/docs\">docs</a>.</p></body></html>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const runtime = createToolRuntime({
      cwd: process.cwd(),
      policy: { networkMode: "offline" }
    });
    const result = await runtime.execute("web_fetch", {
      url: `http://127.0.0.1:${address.port}/`,
      format: "markdown"
    });

    assert.equal(result.ok, true);
    assert.equal(result.result.status, 200);
    assert.match(result.result.content, /# Lab Page/);
    assert.match(result.result.content, /\[docs\]/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("web_fetch accepts URL aliases before execution", async () => {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<html><body><h1>Alias Page</h1></body></html>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const runtime = createToolRuntime({
      cwd: process.cwd(),
      policy: { networkMode: "offline" }
    });
    const result = await runtime.execute("web_fetch", {
      target: `http://127.0.0.1:${address.port}/`,
      format: "markdown"
    });

    assert.equal(result.ok, true);
    assert.match(result.result.content, /# Alias Page/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("web_fetch prefers configured fetch MCP and does not add a default max_length", async (t) => {
  const mcpRuntime = createMcpRuntime({
    cwd: process.cwd(),
    config: {
      mcp: {
        servers: [
          {
            name: "fetch",
            transport: "stdio",
            command: process.execPath,
            args: [path.resolve("tests/fixtures/mcp-fetch-server.js")],
            toolRisks: { fetch: "network" }
          }
        ]
      }
    },
    policy: {
      networkMode: "approved-web",
      allowedHosts: ["example.com"]
    },
    approve: async () => {
      throw new Error("approved MCP fetch URL should not ask");
    }
  });
  t.after(() => mcpRuntime.close());

  const runtime = createToolRuntime({
    cwd: process.cwd(),
    config: { web: { fetchProvider: "mcp-first" } },
    policy: {
      networkMode: "approved-web",
      allowedHosts: ["example.com"]
    },
    mcpRuntime
  });
  const result = await runtime.execute("web_fetch", {
    url: "example.com/docs"
  });

  assert.equal(result.ok, true);
  assert.equal(result.result.provider, "mcp-fetch");
  assert.match(result.result.content, /mcp-fetch/);
  assert.match(result.result.content, /https:\/\/example\.com\/docs/);
  assert.doesNotMatch(result.result.content, /max_length/);
});

test("web_fetch honors explicit maxBytes for MCP fetch output", async (t) => {
  const mcpRuntime = createMcpRuntime({
    cwd: process.cwd(),
    config: {
      mcp: {
        servers: [
          {
            name: "fetch",
            transport: "stdio",
            command: process.execPath,
            args: [path.resolve("tests/fixtures/mcp-fetch-server.js")],
            toolRisks: { fetch: "network" }
          }
        ]
      }
    },
    policy: {
      networkMode: "approved-web",
      allowedHosts: ["example.com"]
    }
  });
  t.after(() => mcpRuntime.close());

  const runtime = createToolRuntime({
    cwd: process.cwd(),
    config: { web: { fetchProvider: "mcp-first" } },
    policy: {
      networkMode: "approved-web",
      allowedHosts: ["example.com"]
    },
    mcpRuntime
  });
  const result = await runtime.execute("web_fetch", {
    url: "https://example.com/large",
    maxBytes: 1024
  });

  assert.equal(result.ok, true);
  assert.equal(result.result.provider, "mcp-fetch");
  assert.equal(result.result.truncated, true);
  assert.equal(Buffer.byteLength(result.result.content, "utf8"), 1024);
  assert.equal(result.result.bytes, 4096);
});

test("web_search is blocked by lab-only policy for public fallback search", async () => {
  const runtime = createToolRuntime({
    cwd: process.cwd(),
    policy: { networkMode: "lab-only", allowedHosts: [] }
  });

  const result = await runtime.execute("web_search", { query: "ant code" });

  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.equal(result.decision.decision, "deny");
});

test("duckduckgo html parser extracts result titles and URLs", () => {
  const results = parseDuckDuckGoHtml(`
    <div class="result">
      <a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs">Example Docs</a>
      <div class="result__snippet">Official documentation snippet.</div>
    </div>
  `);

  assert.equal(results.length, 1);
  assert.equal(results[0].title, "Example Docs");
  assert.equal(results[0].url, "https://example.com/docs");
  assert.match(results[0].snippet, /Official documentation/);
});

test("document_intake extracts markdown from local HTML documents", async () => {
  const cwd = await makeTempWorkspace();
  await fs.writeFile(path.join(cwd, "report.html"), "<h1>Report</h1><p>Alpha beta.</p>", "utf8");

  const result = await documentIntakeTool({ cwd, path: "report.html" });

  assert.equal(result.supported, true);
  assert.equal(result.kind, "html");
  assert.match(result.content, /# Report/);
  assert.match(result.content, /Alpha beta/);
});

test("full access document_intake can read outside the workspace", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-full-access-doc-"));
  const cwd = path.join(root, "workspace");
  const outside = path.join(root, "outside.html");
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(outside, "<h1>Outside Report</h1><p>Full access.</p>", "utf8");

  const result = await documentIntakeTool({
    cwd,
    path: outside,
    policy: { fullAccess: true }
  });

  assert.equal(result.supported, true);
  assert.equal(result.path, outside);
  assert.match(result.content, /# Outside Report/);
});

test("document_intake normalizes quoted paths and reports clear missing document errors", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-doc-quoted-"));
  const cwd = path.join(root, "workspace");
  const outside = path.join(root, "outside.md");
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(outside, "# Quoted Document\n", "utf8");
  const runtime = createToolRuntime({
    cwd,
    policy: { fullAccess: true }
  });

  const quoted = await runtime.execute("document_intake", {
    path: `"${outside}"`,
    maxBytes: 4096
  });
  const missing = await runtime.execute("document_intake", {
    path: path.join(root, "missing.md"),
    maxBytes: 4096
  });

  assert.equal(quoted.ok, true);
  assert.match(quoted.result.content, /Quoted Document/);
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "DOCUMENT_NOT_FOUND");
  assert.match(missing.error.message, /missing\.md/);
  assert.match(missing.error.message, /from path=/);
});

test("document_intake asks before reading outside the workspace", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-doc-outside-ask-"));
  const cwd = path.join(root, "workspace");
  const outside = path.join(root, "outside.md");
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(outside, "# Outside\n\nNeeds approval.\n", "utf8");
  const runtime = createToolRuntime({ cwd });

  const result = await runtime.execute("document_intake", {
    path: outside,
    maxBytes: 4096
  });

  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.equal(result.decision.decision, "ask");
  assert.equal(result.decision.outsideWorkspace, true);
});

test("approved outside-workspace document_intake executes in plan mode", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-doc-outside-approved-"));
  const cwd = path.join(root, "workspace");
  const outside = path.join(root, "outside.md");
  const approvals = [];
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(outside, "# Outside\n\nApproved document read.\n", "utf8");
  const runtime = createToolRuntime({
    cwd,
    approve: async (request) => {
      approvals.push(request);
      return true;
    }
  });

  const result = await runtime.execute("document_intake", {
    path: outside,
    maxBytes: 4096
  });

  assert.equal(result.ok, true);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].decision.outsideWorkspace, true);
  assert.equal(result.result.path, outside);
  assert.match(result.result.content, /Approved document read/);
});

test("git status and diff tools return full git output", async (t) => {
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

  const runtime = createToolRuntime({ cwd });
  const status = await runtime.execute("git_status", {});
  const diff = await runtime.execute("git_diff", { pathspecs: ["notes.txt"] });

  assert.equal(status.ok, true);
  assert.match(status.result.stdout, /notes\.txt/);
  assert.equal(diff.ok, true);
  assert.match(diff.result.stdout, /\+after/);
});

test("ask_user requires an interactive callback", async () => {
  const runtime = createToolRuntime({ cwd: process.cwd() });
  const blocked = await runtime.execute("ask_user", { question: "Which file?" });

  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, "USER_INPUT_UNAVAILABLE");

  const interactive = createToolRuntime({
    cwd: process.cwd(),
    askUser: async (input) => ({
      answer: `answered: ${input.question}`,
      selectedChoices: input.choices?.map((choice) => choice.label ?? choice) ?? []
    })
  });
  const answered = await interactive.execute("ask_user", {
    question: "Which file?",
    choices: [{ label: "README.md" }],
    multiple: true
  });

  assert.equal(answered.ok, true);
  assert.equal(answered.result.answer, "answered: Which file?");
  assert.deepEqual(answered.result.selectedChoices, ["README.md"]);
});

test("powershell readonly commands execute through tool runtime", { skip: process.platform !== "win32" ? "PowerShell executable is only assumed in Windows CI for now" : false }, async () => {
  const cwd = await makeTempWorkspace();
  const runtime = createToolRuntime({ cwd, policy: { networkMode: "offline" } });
  const result = await runtime.execute("powershell", {
    command: "Get-Location",
    timeoutMs: 10_000
  });

  assert.equal(result.ok, true);
  assert.equal(result.result.exitCode, 0);
  assert.match(result.result.stdout, new RegExp(escapeRegex(cwd)));
});

test("powershell mutating commands are blocked without approval", { skip: process.platform !== "win32" ? "PowerShell executable is only assumed in Windows CI for now" : false }, async () => {
  const cwd = await makeTempWorkspace();
  const runtime = createToolRuntime({ cwd, policy: { networkMode: "offline" } });
  const result = await runtime.execute("powershell", {
    command: "Set-Content -LiteralPath notes.txt -Value hello",
    timeoutMs: 10_000
  });

  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  await assert.rejects(fs.readFile(path.join(cwd, "notes.txt"), "utf8"), /ENOENT/);
});

test("powershell mutating commands execute with approval", { skip: process.platform !== "win32" ? "PowerShell executable is only assumed in Windows CI for now" : false }, async () => {
  const cwd = await makeTempWorkspace();
  const runtime = createToolRuntime({
    cwd,
    policy: {
      networkMode: "offline",
      approvals: { workspaceCommands: true }
    }
  });
  const result = await runtime.execute("powershell", {
    command: "Set-Content -LiteralPath notes.txt -Value hello",
    timeoutMs: 10_000
  });

  assert.equal(result.ok, true);
  assert.equal(result.result.exitCode, 0);
  assert.match(await fs.readFile(path.join(cwd, "notes.txt"), "utf8"), /hello/);
});

test("shell runtime accepts common command field aliases", { skip: process.platform !== "win32" ? "PowerShell executable is only assumed in Windows CI for now" : false }, async () => {
  const cwd = await makeTempWorkspace();
  const runtime = createToolRuntime({
    cwd,
    policy: {
      networkMode: "offline",
      approvals: { workspaceCommands: true }
    }
  });
  const result = await runtime.execute("powershell", {
    cmd: "Write-Output alias-ok",
    timeoutMs: 10_000
  });

  assert.equal(result.ok, true);
  assert.equal(result.result.exitCode, 0);
  assert.match(result.result.stdout, /alias-ok/);
});

test("full access shell commands can see secret-like env vars", async () => {
  const cwd = await makeTempWorkspace();
  const runtime = createToolRuntime({
    cwd,
    env: {
      ...process.env,
      LAB_SECRET_TOKEN: "full-access-secret"
    },
    policy: {
      networkMode: "offline",
      fullAccess: true
    }
  });
  const command = process.platform === "win32"
    ? "[Console]::Write($env:LAB_SECRET_TOKEN)"
    : "printf '%s' \"$LAB_SECRET_TOKEN\"";
  const result = await runtime.execute(process.platform === "win32" ? "powershell" : "bash", {
    command,
    timeoutMs: 10_000
  });

  assert.equal(result.ok, true);
  assert.equal(result.result.exitCode, 0);
  assert.match(result.result.stdout, /full-access-secret/);
  assert.equal(result.result.scrubbedEnv.includes("LAB_SECRET_TOKEN"), false);
});

test("shell tools stop promptly when the runtime signal is aborted", async () => {
  const cwd = await makeTempWorkspace();
  const controller = new AbortController();
  const runtime = createToolRuntime({
    cwd,
    signal: controller.signal,
    policy: {
      networkMode: "offline",
      approvals: { workspaceCommands: true }
    }
  });
  const shellTool = process.platform === "win32" ? "powershell" : "bash";
  const command = process.platform === "win32" ? "Start-Sleep -Seconds 20" : "sleep 20";
  const startedAt = Date.now();
  const pending = runtime.execute(shellTool, {
    command,
    timeoutMs: 60_000
  });

  setTimeout(() => controller.abort(), 100);
  const result = await pending;

  assert.equal(result.ok, false);
  assert.equal(result.interrupted, true);
  assert.equal(result.error.code, "SHELL_INTERRUPTED");
  assert.ok(Date.now() - startedAt < 5000);
});

async function makeTempWorkspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
}

function createToolGateway(requests, fixture) {
  return createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      return;
    }

    const body = await readRequestJson(request);
    requests.push(body);
    response.writeHead(200, { "content-type": "application/json" });

    if (Array.isArray(body.tools) && body.tools.length === 0) {
      response.end(JSON.stringify({
        id: "mock-tool-final-no-tools",
        model: body.model,
        content: [{ type: "text", text: fixture.finalText }],
        toolCalls: [],
        stopReason: "stop"
      }));
      return;
    }

    if (requests.length === 1) {
      response.end(JSON.stringify({
        id: "mock-tool-call",
        model: body.model,
        content: [],
        toolCalls: [fixture.toolCall],
        stopReason: "tool_calls"
      }));
      return;
    }

    response.end(JSON.stringify({
      id: "mock-tool-final",
      model: body.model,
      content: [{ type: "text", text: fixture.finalText }],
      toolCalls: [],
      stopReason: "stop"
    }));
  });
}

function readRequestJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("error", reject);
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function listen(server, host) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve(undefined));
  });
}

function serverUrl(server) {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("server is not listening on a TCP address");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function waitFor(predicate, timeoutMs = 1000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("Timed out waiting for condition");
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
 * @param {string} value
 */
function escapeRegex(value) {
  return value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}
