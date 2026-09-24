import assert from "node:assert/strict";
import test from "node:test";
import { formatToolResultForModel, renderToolResultView } from "../../src/tools/result-view.ts";
import { compactInFlightToolMessages, STALE_TOOL_MARKER } from "../../src/core/inflight-compaction.ts";

test("read_file model view is numbered excerpt instead of pretty JSON envelope", () => {
  const content = Array.from({ length: 80 }, (_, index) => `line-${index} ${"x".repeat(40)}`).join("\n");
  const view = renderToolResultView("read_file", {
    ok: true,
    result: { path: "src/a.ts", bytesRead: Buffer.byteLength(content, "utf8"), content }
  });

  assert.match(view.text, /ok=true tool=read_file/);
  assert.match(view.text, /path=src\/a\.ts/);
  assert.match(view.text, /1: line-0/);
  assert.equal(view.text.includes("\"ok\": true"), false);
  assert.doesNotMatch(view.text, /"bytesRead"/);
});

test("read_file model view keeps a continuous prefix and a long-line continuation", () => {
  const content = "head-content\n" + "y".repeat(80_000) + "\ntail-content";
  const view = renderToolResultView("read_file", {
    ok: true,
    result: { path: "big.txt", content, bytesRead: content.length }
  });

  assert.equal(view.truncated, true);
  assert.match(view.text, /truncated=true/);
  assert.match(view.text, /head-content/);
  assert.doesNotMatch(view.text, /tail-content|chars omitted/);
  assert.match(view.text, /nextStartLine=2 nextStartColumn=\d+/);
  assert.ok(Buffer.byteLength(view.text) <= 32_000);
});

test("grep model view keeps a bounded match list", () => {
  const matches = Array.from({ length: 80 }, (_, index) => ({
    path: `src/file-${index}.ts`,
    line: index + 1,
    text: `hit ${index} ${"z".repeat(300)}`
  }));
  const view = renderToolResultView("grep", {
    ok: true,
    result: { matches, truncated: true }
  });

  assert.match(view.text, /matches=80 shown=80 offset=0 truncated=true/);
  assert.equal(view.text.split("\n").filter((line) => line.startsWith("- ")).length, 80);
  assert.match(view.text, /src\/file-0\.ts:1/);
  assert.match(view.text, /src\/file-79\.ts/);
});

test("write_file model view drops the full diff", () => {
  const diff = Array.from({ length: 80 }, (_, index) => `+line ${index}`).join("\n");
  const view = renderToolResultView("write_file", {
    ok: true,
    result: {
      path: "notes.txt",
      created: true,
      bytesWritten: 12,
      changeStats: { additions: 80, deletions: 0 },
      diff
    }
  });

  assert.match(view.text, /path=notes\.txt/);
  assert.match(view.text, /created=true/);
  assert.equal(view.truncated, true);
  assert.ok(view.text.split("\n").length < 40);
});

test("failed write_file without a result does not claim edited=true", () => {
  const view = renderToolResultView("write_file", {
    ok: false,
    error: {
      code: "ENOENT",
      message: "ENOENT: no such file or directory, open 'missing/dir/notes.txt'"
    }
  });

  assert.match(view.text, /ok=false tool=write_file/);
  assert.match(view.text, /error=ENOENT: ENOENT: no such file or directory, open 'missing\/dir\/notes\.txt'/);
  assert.doesNotMatch(view.text, /edited=true/);
  assert.doesNotMatch(view.text, /created=true/);
});

test("failed edit_file without a result does not claim edited=true", () => {
  const view = renderToolResultView("edit_file", {
    ok: false,
    error: {
      code: "FILE_NOT_FOUND",
      message: "file not found"
    }
  });

  assert.match(view.text, /ok=false tool=edit_file/);
  assert.match(view.text, /error=FILE_NOT_FOUND: file not found/);
  assert.doesNotMatch(view.text, /edited=true/);
});

test("write_file overwrite still reports edited=true", () => {
  const view = renderToolResultView("write_file", {
    ok: true,
    result: {
      path: "notes.txt",
      created: false,
      bytesWritten: 12,
      changeStats: { additions: 1, deletions: 1 }
    }
  });

  assert.match(view.text, /ok=true tool=write_file/);
  assert.match(view.text, /path=notes\.txt/);
  assert.match(view.text, /edited=true/);
  assert.doesNotMatch(view.text, /created=true/);
});

test("edit_file success and no-op keep their edited flags", () => {
  const edited = renderToolResultView("edit_file", {
    ok: true,
    result: { path: "notes.txt", edited: true, bytesWritten: 20 }
  });
  const skipped = renderToolResultView("edit_file", {
    ok: true,
    result: { path: "notes.txt", edited: false }
  });

  assert.match(edited.text, /edited=true/);
  assert.match(skipped.text, /edited=false/);
});

test("mcp image payloads are omitted from the model view", () => {
  const view = renderToolResultView("mcp_call", {
    ok: true,
    result: {
      content: [
        { type: "text", text: "captured" },
        { type: "image", mimeType: "image/png", data: "A".repeat(400), size: 400 }
      ]
    }
  });

  assert.match(view.text, /images=1 omitted=true/);
  assert.doesNotMatch(view.text, /AAAA/);
});

test("agent_run model view keeps the report and drops nested tool dumps", () => {
  const view = renderToolResultView("agent_run", {
    ok: true,
    result: {
      profile: "explorer",
      status: "completed",
      outputSummary: "found 2 files",
      output: "found 2 files\nnext: read src/a.ts",
      tools: Array.from({ length: 12 }, (_, index) => ({
        name: "read_file",
        content: "x".repeat(2000),
        index
      }))
    }
  });

  assert.match(view.text, /profile=explorer/);
  assert.match(view.text, /found 2 files/);
  assert.match(view.text, /next: read src\/a.ts/);
  assert.doesNotMatch(view.text, /xxxx/);
});

test("agent_run model view prefers the full handoff report over the eight-line summary", () => {
  const findings = Array.from({ length: 8 }, (_, index) => `F-${index + 1} 正文对照 L${index + 10}`).join("\n");
  const view = renderToolResultView("agent_run", {
    ok: true,
    result: {
      profile: "reviewer",
      status: "completed",
      outputSummary: "I have sufficient evidence. Writing the report now.",
      output: `# 复核报告\n${findings}`
    }
  });

  assert.match(view.text, /F-1 正文对照 L10/);
  assert.match(view.text, /F-8 正文对照 L17/);
  assert.doesNotMatch(view.text, /I have sufficient evidence/);
  assert.equal(view.truncated, false);
});

test("skill_list, todo_read, rg_count, and empty mcp_list keep array payloads", () => {
  const skills = renderToolResultView("skill_list", {
    ok: true,
    result: [
      { name: "codebase-orientation", description: "orient" },
      { name: "web-research", description: "search" }
    ]
  });
  assert.match(skills.text, /skills=2/);
  assert.match(skills.text, /codebase-orientation/);
  assert.equal(skills.text.includes("\n{}"), false);

  const todos = renderToolResultView("todo_read", {
    ok: true,
    result: [{ id: "1", status: "pending", content: "inspect workspace" }]
  });
  assert.match(todos.text, /todos=1/);
  assert.match(todos.text, /inspect workspace/);

  const count = renderToolResultView("rg_count", {
    ok: true,
    result: { command: "rg --count-matches", mode: "matches", count: 9 }
  });
  assert.match(count.text, /count=9/);
  assert.equal(count.text.includes("matches=0"), false);

  const mcp = renderToolResultView("mcp_list", { ok: true, result: [] });
  assert.match(mcp.text, /servers=0/);
});

test("hard safety valve still truncates a huge view", () => {
  const serialized = formatToolResultForModel("bash", {
    ok: true,
    result: { exitCode: 0, stdout: "n".repeat(80_000) }
  }, { maxBytes: 128 });

  assert.equal(serialized.truncated, true);
  assert.ok(serialized.bytes <= 128);
  assert.match(serialized.content, /\[tool result truncated\]/);
});

test("budget pruning retains all current-turn evidence while the window has room", () => {
  const messages = [
    { role: "user", content: "previous turn" },
    {
      role: "tool",
      toolCallId: "old-1",
      name: "read_file",
      content: [{ type: "text", text: "previous-turn-body ".repeat(40) }]
    },
    { role: "user", content: "current turn" },
    ...Array.from({ length: 5 }, (_, index) => ({
      role: "tool",
      toolCallId: `cur-${index}`,
      name: "read_file",
      content: [{ type: "text", text: `ok=true tool=read_file path=src/${index}.ts\n${"body ".repeat(80)}` }]
    }))
  ];

  const result = compactInFlightToolMessages(messages, {
    maxTokens: 1_000_000,
    keepRecentTools: 4,
    pruneStale: true,
    currentTurnOnly: true
  });

  assert.equal(result.compacted, false);
  assert.equal(result.compactedTools, 0);
  assert.match(String(messages[1].content[0].text), /previous-turn-body/);
  assert.match(String(messages[3].content[0].text), /body/);
  assert.match(String(messages[3].content[0].text), /src\/0\.ts/);
  assert.match(String(messages[7].content[0].text), /src\/4\.ts/);
  assert.equal(String(messages[7].content[0].text).includes(STALE_TOOL_MARKER), false);
});

test("tool budget compacts a low-value result first and stops when sufficient", () => {
  const messages = [
    { role: "user", name: "", content: [{ type: "text", text: "analyze" }] },
    ...["read_file", "list_files", "bash", "read_file", "read_file", "read_file"].map((name, index) => ({
      role: "tool", name,
      content: [{ type: "text", text: `ok=true tool=${name}\npath=${index}.txt\n${"evidence ".repeat(400)}` }]
    }))
  ];
  const before = structuredClone(messages);
  const result = compactInFlightToolMessages(messages, {
    maxTokens: 5_300, keepRecentTools: 4, pruneStale: true, currentTurnOnly: true
  });
  assert.equal(result.compactedTools, 1);
  assert.match(messages[2].content[0].text, /\[compacted tool result\]/);
  assert.deepEqual(messages[1], before[1]);
  assert.deepEqual(messages.slice(3), before.slice(3));
});

test("search byte budget returns whole entries with a resumable offset", () => {
  const result = formatToolResultForModel("grep", {
    ok: true,
    result: { offset: 30, matches: Array.from({ length: 100 }, (_, i) => ({ path: `file-${i}.ts`, line: 1, text: "x".repeat(100) })) }
  }, { maxBytes: 2000 });
  const shown = Number(/shown=(\d+)/.exec(result.content)?.[1]);
  assert.ok(shown > 0 && shown < 100);
  assert.match(result.content, new RegExp(`nextOffset=${30 + shown}\\b`));
  assert.ok(result.bytes <= 2000);
  assert.doesNotMatch(result.content, /\[tool result truncated\]/);
});
