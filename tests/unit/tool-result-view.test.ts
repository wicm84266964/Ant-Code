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

test("read_file model view head-tails oversized files", () => {
  const content = "head-content\n" + "y".repeat(20_000) + "\ntail-content";
  const view = renderToolResultView("read_file", {
    ok: true,
    result: { path: "big.txt", content, bytesRead: content.length }
  });

  assert.equal(view.truncated, true);
  assert.match(view.text, /truncated=true/);
  assert.match(view.text, /head-content/);
  assert.match(view.text, /tail-content/);
  assert.match(view.text, /chars omitted/);
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

  assert.match(view.text, /matches=80 truncated=true/);
  assert.equal(view.text.split("\n").filter((line) => line.startsWith("- ")).length, 40);
  assert.match(view.text, /src\/file-0\.ts:1/);
  assert.doesNotMatch(view.text, /src\/file-79\.ts/);
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
  assert.doesNotMatch(view.text, /xxxx/);
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

test("stale prune stubs older current-turn tools without waiting for the window", () => {
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

  assert.equal(result.compacted, true);
  assert.equal(result.compactedTools, 1);
  assert.match(String(messages[1].content[0].text), /previous-turn-body/);
  assert.match(String(messages[3].content[0].text), new RegExp(STALE_TOOL_MARKER.replace(/[[\]]/g, "\\$&")));
  assert.match(String(messages[3].content[0].text), /src\/0\.ts/);
  assert.match(String(messages[7].content[0].text), /src\/4\.ts/);
  assert.equal(String(messages[7].content[0].text).includes(STALE_TOOL_MARKER), false);
});
