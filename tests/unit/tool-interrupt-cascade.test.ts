import assert from "node:assert/strict";
import test from "node:test";
import { executeToolCalls } from "../../src/core/session-health.ts";

test("executeToolCalls keeps later tools when one result is interrupted without a turn abort", async () => {
  const names = [];
  const toolRuntime = {
    cwd: process.cwd(),
    config: {},
    execute: async (name) => {
      names.push(name);
      if (name === "read_file") {
        return {
          ok: false,
          interrupted: true,
          error: { code: "TOOL_INTERRUPTED", message: "read_file was interrupted." }
        };
      }
      return { ok: true, result: { matches: ["ok.txt"] } };
    }
  };

  const results = await executeToolCalls([
    { id: "a", name: "read_file", input: { path: "a.txt" } },
    { id: "b", name: "glob", input: { pattern: "*.txt" } }
  ], toolRuntime);

  assert.deepEqual(names, ["read_file", "glob"]);
  assert.equal(results.length, 2);
  assert.equal(results[0].interrupted, true);
  assert.equal(results[1].interrupted, false);
  assert.match(results[1].content, /ok\.txt/);
});

test("executeToolCalls stops remaining tools after the turn abort signal", async () => {
  const controller = new AbortController();
  const names = [];
  const toolRuntime = {
    cwd: process.cwd(),
    config: {},
    execute: async (name) => {
      names.push(name);
      controller.abort();
      return { ok: true, result: { ok: true } };
    }
  };

  const results = await executeToolCalls([
    { id: "a", name: "read_file", input: { path: "a.txt" } },
    { id: "b", name: "glob", input: { pattern: "*.txt" } }
  ], toolRuntime, { signal: controller.signal });

  assert.deepEqual(names, ["read_file"]);
  assert.equal(results.length, 1);
  assert.equal(results[0].interrupted, false);
});
