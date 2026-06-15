import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { clearHookAudit, listHookAudit, summarizeHookAudit } from "../../src/hooks/audit-store.js";
import { createHookPayload } from "../../src/hooks/events.js";
import { matchHooks } from "../../src/hooks/registry.js";
import { formatHooksReport } from "../../src/hooks/report.js";
import { runHooks } from "../../src/hooks/runner.js";
import { compactSessionContextWithModel, createContextWindow } from "../../src/core/context-window.js";
import { runSessionTurn } from "../../src/core/session.js";
import { createToolRuntime } from "../../src/tools/runtime.js";
import { createWorkflowState } from "../../src/tools/workflow-tools.js";

test("hook registry matches defaults and path-filtered command hooks", () => {
  const config = {
    hooks: {
      events: {
        "file.changed": [
          {
            name: "js-check",
            type: "command",
            command: "npm run check",
            when: { paths: ["src/**/*.js"] }
          }
        ]
      }
    }
  };

  const matched = matchHooks(config, "file.changed", {
    targetPaths: ["src/hooks/runner.js"]
  }, { cwd: process.cwd() });
  const ignored = matchHooks(config, "file.changed", {
    targetPaths: ["docs/readme.md"]
  }, { cwd: process.cwd() });

  assert.ok(matched.some((hook) => hook.name === "file-changed-audit"));
  assert.ok(matched.some((hook) => hook.name === "js-check"));
  assert.ok(ignored.some((hook) => hook.name === "file-changed-audit"));
  assert.equal(ignored.some((hook) => hook.name === "js-check"), false);

  const beforeHooks = matchHooks({}, "tool.before", {
    toolName: "read_file",
    targetPaths: [".env"]
  }, { cwd: process.cwd() });
  assert.equal(beforeHooks.find((hook) => hook.name === "record-sensitive-files")?.blocking, false);
  assert.equal(beforeHooks.some((hook) => hook.name === "deny-sensitive-files"), false);
});

test("hook runner records sensitive file targets and leaves approval to permissions", async () => {
  clearHookAudit();
  const result = await runHooks({
    config: {},
    cwd: process.cwd(),
    event: "tool.before",
    payload: {
      toolName: "read_file",
      input: { path: ".env" },
      targetPaths: [".env"]
    }
  });

  assert.equal(result.blocked, false);
  const audit = listHookAudit();
  assert.ok(audit.some((record) => record.name === "record-sensitive-files" && record.status === "completed" && !record.blocked));
  assert.ok(audit.some((record) => /权限强确认/.test(record.message ?? "")));
});

test("legacy denySensitiveFiles builtin remains compatible", async () => {
  clearHookAudit();
  const result = await runHooks({
    config: {
      hooks: {
        events: {
          "tool.before": [
            {
              name: "legacy-sensitive-hook",
              type: "builtin",
              builtin: "denySensitiveFiles"
            }
          ]
        }
      }
    },
    cwd: process.cwd(),
    event: "tool.before",
    payload: {
      toolName: "read_file",
      input: { path: ".env" },
      targetPaths: [".env"]
    }
  });

  assert.equal(result.blocked, false);
  assert.ok(listHookAudit().some((record) => record.name === "legacy-sensitive-hook" && /权限强确认/.test(record.message)));
});

test("command hooks are skipped unless trusted and scrub sensitive env vars", async () => {
  clearHookAudit();
  const cwd = await makeTempWorkspace();
  const config = {
    hooks: {
      events: {
        "file.changed": [
          {
            name: "write-env-check",
            type: "command",
            command: process.platform === "win32"
              ? "[System.IO.File]::WriteAllText((Join-Path (Get-Location) 'hook-env.txt'), [string]$env:LAB_SECRET_TOKEN)"
              : "printf '%s' \"$LAB_SECRET_TOKEN\" > hook-env.txt",
            timeoutMs: 10_000,
            envAllowlist: ["PATH", "Path", "SystemRoot", "TEMP", "TMP", "LAB_SECRET_TOKEN"]
          }
        ]
      }
    }
  };

  await runHooks({
    config,
    cwd,
    env: { ...process.env, LAB_SECRET_TOKEN: "should-not-leak" },
    event: "file.changed",
    payload: { path: "notes.txt", targetPaths: ["notes.txt"] },
    hooksTrusted: false
  });
  assert.equal(await exists(path.join(cwd, "hook-env.txt")), false);
  assert.ok(listHookAudit().some((record) => record.skipped));

  clearHookAudit();
  await runHooks({
    config,
    cwd,
    env: { ...process.env, LAB_SECRET_TOKEN: "should-not-leak" },
    event: "file.changed",
    payload: { path: "notes.txt", targetPaths: ["notes.txt"] },
    hooksTrusted: true,
    awaitNonBlockingCommandHooks: true
  });
  assert.equal((await fs.readFile(path.join(cwd, "hook-env.txt"), "utf8")).trim(), "");
  assert.ok(listHookAudit().some((record) => record.name === "write-env-check" && record.ok));
});

test("non-blocking command hooks are scheduled without holding the agent turn", async () => {
  clearHookAudit();
  const cwd = await makeTempWorkspace();
  const marker = path.join(cwd, "slow-hook.txt");
  const config = {
    hooks: {
      events: {
        "file.changed": [
          {
            name: "slow-check",
            type: "command",
            command: process.platform === "win32"
              ? "Start-Sleep -Milliseconds 600; [System.IO.File]::WriteAllText((Join-Path (Get-Location) 'slow-hook.txt'), 'done')"
              : "sleep 0.6; printf done > slow-hook.txt",
            timeoutMs: 10_000
          }
        ]
      }
    }
  };

  const started = Date.now();
  const result = await runHooks({
    config,
    cwd,
    env: process.env,
    event: "file.changed",
    payload: { path: "notes.txt", targetPaths: ["notes.txt"] },
    hooksTrusted: true
  });
  const durationMs = Date.now() - started;

  assert.equal(result.blocked, false);
  assert.ok(result.results.some((item) => item.scheduled));
  assert.ok(durationMs < 350, `non-blocking hook should return quickly, got ${durationMs}ms`);
  const running = listHookAudit().find((record) => record.name === "slow-check");
  assert.equal(running?.status, "running");
  assert.match(formatHooksReport(config, { trusted: true }), /运行中：1/);
  assert.equal(summarizeHookAudit().running, 1);
  assert.equal(await exists(marker), false);
  await waitFor(async () => (await fs.readFile(marker, "utf8")).trim() === "done");
  await waitFor(() => listHookAudit().some((record) => record.name === "slow-check" && record.status === "completed" && record.ok));
  assert.equal(summarizeHookAudit().running, 0);
});

test("tool runtime emits hook audit for tool use, file changes, todo updates, and permission denied", async () => {
  clearHookAudit();
  const cwd = await makeTempWorkspace();
  const workflowState = createWorkflowState();
  const runtime = createToolRuntime({
    cwd,
    config: {},
    workflowState,
    policy: {
      networkMode: "offline",
      approvals: { workspaceWrites: true }
    }
  });

  const write = await runtime.execute("write_file", { path: "notes.txt", content: "hello\n" });
  const todos = await runtime.execute("todo_write", { items: ["inspect hooks"] });
  const denied = await createToolRuntime({ cwd, config: {} }).execute("write_file", {
    path: "blocked.txt",
    content: "no\n"
  });

  assert.equal(write.ok, true);
  assert.equal(todos.ok, true);
  assert.equal(denied.blocked, true);
  const audit = listHookAudit();
  assert.ok(audit.some((record) => record.event === "tool.before" && record.name === "tool-before-audit"));
  assert.ok(audit.some((record) => record.event === "tool.after" && record.name === "tool-after-audit"));
  assert.ok(audit.some((record) => record.event === "file.changed" && record.name === "file-changed-audit"));
  assert.ok(audit.some((record) => record.event === "todo.updated" && record.name === "todo-updated-audit"));
  assert.ok(audit.some((record) => record.event === "permission.denied" && record.name === "permission-denied-audit"));
});

test("compact with model emits compact hook audit", async () => {
  clearHookAudit();
  const session = {
    id: "compact-test",
    cwd: process.cwd(),
    config: {
      context: {
        maxMessages: 2,
        maxBytes: 100,
        maxTokens: 25,
        keepRecentMessages: 1,
        summaryBytes: 4096
      }
    },
    contextWindow: createContextWindow({
      context: {
        maxMessages: 2,
        maxBytes: 100,
        maxTokens: 25,
        keepRecentMessages: 1,
        summaryBytes: 4096
      }
    }),
    messages: [
      { role: "user", content: "alpha" },
      { role: "assistant", content: [{ type: "text", text: "beta" }] },
      { role: "user", content: "gamma" }
    ]
  };

  const result = await compactSessionContextWithModel(session, {
    force: true,
    reason: "manual",
    gateway: { configured: false }
  });

  assert.equal(result.compacted, true);
  const audit = listHookAudit();
  assert.ok(audit.some((record) => record.event === "compact.before"));
  assert.ok(audit.some((record) => record.event === "compact.after"));
});

test("hooks report is Chinese and includes recent audit", async () => {
  clearHookAudit();
  await runHooks({
    config: {},
    cwd: process.cwd(),
    event: "user.prompt",
    payload: createHookPayload("user.prompt", { promptBytes: 12 })
  });

  const report = formatHooksReport({}, { trusted: true });

  assert.match(report, /Ant Code Hooks/);
  assert.match(report, /状态/);
  assert.match(report, /最近记录/);
  assert.match(report, /user\.prompt/);
});

test("session end command hooks receive trusted state from session turns", async () => {
  clearHookAudit();
  const cwd = await makeTempWorkspace();
  const config = {
    lab: { gatewayUrl: null },
    hooks: {
      events: {
        "session.end": [
          {
            name: "session-end-marker",
            type: "command",
            command: process.platform === "win32"
              ? "[System.IO.File]::WriteAllText((Join-Path (Get-Location) 'session-end.txt'), $env:ANT_CODE_HOOK_EVENT)"
              : "printf '%s' \"$ANT_CODE_HOOK_EVENT\" > session-end.txt",
            timeoutMs: 10_000
          }
        ]
      }
    }
  };
  const session = {
    id: "session-hook-test",
    cwd,
    startedAt: new Date().toISOString(),
    mode: "print",
    readonly: true,
    allowWrite: false,
    allowCommand: false,
    networkMode: "offline",
    sensitivity: "standard",
    model: "test",
    config,
    context: { system: [], tools: [] },
    contextWindow: createContextWindow(config),
    workflow: createWorkflowState(),
    messages: [],
    title: null,
    turnCount: 0
  };

  await runSessionTurn(session, {
    prompt: "hello",
    env: process.env,
    hooksTrusted: true
  });

  await waitFor(async () => (await fs.readFile(path.join(cwd, "session-end.txt"), "utf8")).trim() === "session.end");
  assert.equal((await fs.readFile(path.join(cwd, "session-end.txt"), "utf8")).trim(), "session.end");
  await waitFor(() => listHookAudit().some((record) => record.event === "session.end" && record.name === "session-end-marker" && record.ok));
});

async function makeTempWorkspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-hooks-"));
}

async function exists(filePath) {
  return fs.stat(filePath).then(() => true).catch((error) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  });
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (lastError) {
    throw lastError;
  }
  throw new Error(`condition was not met within ${timeoutMs}ms`);
}
