import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readFileTool, grepTool, globTool, listFilesTool } from "../../src/tools/file-tools.ts";
import { rgSearchTool, rgFilesTool, rgFilesWithMatchesTool } from "../../src/tools/rg-tools.ts";
import { formatToolResultForModel } from "../../src/tools/result-view.ts";
import { compactInFlightToolMessages } from "../../src/core/inflight-compaction.ts";

test("source pages preserve Unicode and continue from the model-visible boundary", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ant-evidence-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const source = "\u4e2d\u6587\ud83d\ude80abc".repeat(2000);
  await fs.writeFile(path.join(cwd, "source.txt"), source);
  let startColumn = 1;
  let recovered = "";
  for (let page = 0; page < 100; page++) {
    const result = await readFileTool({ cwd, path: "source.txt", startLine: 1, startColumn, maxBytes: 4000 });
    const view = formatToolResultForModel("read_file", { ok: true, result }, { maxBytes: 2000 });
    assert.ok(view.bytes <= 2000);
    assert.doesNotMatch(view.content, /\ufffd/);
    const chunk = /^1: (.*)$/m.exec(view.content)?.[1] ?? "";
    assert.ok(chunk.length > 0);
    recovered += chunk;
    const next = /nextStartLine=(\d+) nextStartColumn=(\d+)/.exec(view.content);
    if (!next) break;
    assert.equal(Number(next[1]), 1);
    assert.equal(Number(next[2]), startColumn + chunk.length);
    startColumn = Number(next[2]);
  }
  assert.equal(recovered, source);
});

test("range reads preserve original line numbers, CRLF and exact end-of-file", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ant-evidence-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  await fs.writeFile(path.join(cwd, "source.txt"), "alpha\r\nbeta\r\ngamma\r\ndelta");
  const first = await readFileTool({ cwd, path: "source.txt", startLine: 2, maxLines: 2 });
  assert.equal(first.content, "beta\ngamma");
  assert.equal(first.nextStartLine, 4);
  const view = formatToolResultForModel("read_file", { ok: true, result: first });
  assert.match(view.content, /2: beta\n3: gamma/);
  const last = await readFileTool({ cwd, path: "source.txt", startLine: 4, maxLines: 1 });
  assert.equal(last.content, "delta");
  assert.equal(last.truncated, false);
  const past = await readFileTool({ cwd, path: "source.txt", startLine: 8 });
  assert.equal(past.content, "");
  assert.equal(past.truncated, false);
});

test("byte-limited Unicode reads do not fabricate a replacement character or loop", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ant-evidence-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  await fs.writeFile(path.join(cwd, "source.txt"), "\u4e2d\u6587-tail");
  const first = await readFileTool({ cwd, path: "source.txt", maxBytes: 5 });
  assert.equal(first.content, "\u4e2d");
  const view = formatToolResultForModel("read_file", { ok: true, result: first });
  assert.match(view.content, /nextStartLine=1 nextStartColumn=2/);
  const next = await readFileTool({ cwd, path: "source.txt", startLine: 1, startColumn: 2 });
  assert.equal(first.content + next.content, "\u4e2d\u6587-tail");
  await assert.rejects(readFileTool({ cwd, path: "source.txt", startLine: 1, maxBytes: 1 }), /too small/);
});

test("all search tools page beyond 40 results without omissions or duplicates", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ant-evidence-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const names = Array.from({ length: 85 }, (_, i) => `file-${String(i).padStart(3, "0")}.txt`);
  await Promise.all(names.map((name) => fs.writeFile(path.join(cwd, name), "needle\n")));
  const tools = [
    ["grep", (offset: number) => grepTool({ cwd, pattern: "needle", maxMatches: 60, offset }), "matches"],
    ["glob", (offset: number) => globTool({ cwd, pattern: "*.txt", maxMatches: 60, offset }), "matches"],
    ["list_files", (offset: number) => listFilesTool({ cwd, maxEntries: 60, offset }), "entries"],
    ["rg_search", (offset: number) => rgSearchTool({ cwd, pattern: "needle", maxResults: 60, offset }), "matches"],
    ["rg_files", (offset: number) => rgFilesTool({ cwd, maxResults: 60, offset }), "files"],
    ["rg_files_with_matches", (offset: number) => rgFilesWithMatchesTool({ cwd, pattern: "needle", maxResults: 60, offset }), "files"]
  ] as const;
  for (const [name, run, key] of tools) {
    const collected: string[] = [];
    let offset = 0;
    for (let page = 0; page < 20; page++) {
      const result = await run(offset) as Record<string, any>;
      assert.notEqual(result.ok, false, `${name}: ${JSON.stringify(result.error)}`);
      const view = formatToolResultForModel(name, { ok: true, result }, { maxBytes: 1200 });
      const shown = Number(/shown=(\d+)/.exec(view.content)?.[1]);
      assert.ok(shown > 0, name);
      collected.push(...result[key].slice(0, shown).map((row: any) => typeof row === "string" ? row : row.path ?? row.name));
      const next = /nextOffset=(\d+)/.exec(view.content);
      if (!next) break;
      assert.ok(Number(next[1]) > offset, name);
      offset = Number(next[1]);
    }
    assert.deepEqual(collected, names, name);
  }
});

test("search context rows page with consistent offsets", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ant-evidence-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  await fs.writeFile(path.join(cwd, "source.txt"), "before\nneedle\nafter\n");
  const first = await rgSearchTool({ cwd, pattern: "needle", beforeContext: 1, afterContext: 1, maxResults: 2 });
  assert.equal(first.nextOffset, 2);
  const last = await rgSearchTool({ cwd, pattern: "needle", beforeContext: 1, afterContext: 1, maxResults: 2, offset: 2 });
  assert.deepEqual([...first.matches, ...last.matches].map((row) => row.text), ["before", "needle", "after"]);
  assert.equal(last.nextOffset, null);
});

test("full-request pressure stops compaction as soon as one result makes room", () => {
  const messages = ["read_file", "list_files", "bash", "read_file", "read_file", "read_file"].map((name) => ({
    role: "tool", name, content: [{ type: "text", text: `ok=true tool=${name}\n${"evidence ".repeat(400)}` }]
  }));
  const original = structuredClone(messages);
  const result = compactInFlightToolMessages(messages, {
    force: true, maxTokens: 1_000_000,
    needsCompaction: () => !messages[1].content[0].text.startsWith("[compacted tool result]")
  });
  assert.equal(result.compactedTools, 1);
  assert.deepEqual(messages[0], original[0]);
  assert.deepEqual(messages.slice(2), original.slice(2));
});

test("tiny model budgets report no progress without returning a looping cursor", () => {
  const view = formatToolResultForModel("glob", { ok: true, result: { offset: 0, matches: ["x".repeat(1000)] } }, { maxBytes: 800 });
  assert.match(view.content, /will not advance/);
  assert.doesNotMatch(view.content, /nextOffset=/);
});

test("a short receipt cannot prevent reduction of a larger recent result", () => {
  const messages = [
    { role: "tool", name: "write_file", content: [{ type: "text", text: "ok=true tool=write_file" }] },
    { role: "tool", name: "read_file", content: [{ type: "text", text: "source ".repeat(3000) }] }
  ];
  const result = compactInFlightToolMessages(messages, { force: true, needsCompaction: () => messages[1].content[0].text.length > 2000 });
  assert.equal(result.compactedTools, 1);
  assert.match(messages[1].content[0].text, /\[compacted tool result\]/);
});
