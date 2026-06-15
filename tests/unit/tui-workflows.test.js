import assert from "node:assert/strict";
import test from "node:test";
import {
  boundedIndex,
  buildGuidePrompt,
  isImmediateTuiCommand,
  isStopGuidance,
  prependQueuedPrompt,
  promoteQueuedPrompt,
  rememberRecentFile,
  removeQueuedPrompt,
  takeQueuedPrompt
} from "../../src/cli/tui/workflows.js";

test("queue workflow helpers remove, promote, and take focused prompts", () => {
  const queue = ["first", "second", "third"];

  const removed = removeQueuedPrompt(queue, 1);
  const promoted = promoteQueuedPrompt(queue, 2);
  const taken = takeQueuedPrompt(queue, 0);

  assert.deepEqual(removed, {
    prompts: ["first", "third"],
    removed: "second",
    index: 1
  });
  assert.deepEqual(promoted, {
    prompts: ["third", "first", "second"],
    promoted: "third",
    index: 0
  });
  assert.deepEqual(taken, {
    prompts: ["second", "third"],
    prompt: "first",
    index: 0
  });
  assert.deepEqual(prependQueuedPrompt(queue, "guide now", 3), ["guide now", "first", "second"]);
});

test("recent files are normalized, de-duplicated, and bounded", () => {
  const recent = rememberRecentFile(["src/old.js", "docs/readme.md"], "@src\\old.js");
  const bounded = rememberRecentFile(["a", "b", "c"], "d", 2);

  assert.deepEqual(recent, ["src/old.js", "docs/readme.md"]);
  assert.deepEqual(bounded, ["d", "a"]);
});

test("bounded index is stable for empty and out-of-range lists", () => {
  assert.equal(boundedIndex([], 4), 0);
  assert.equal(boundedIndex(["a", "b"], 8), 1);
  assert.equal(boundedIndex(["a", "b"], -2), 0);
});

test("busy-safe TUI commands can run immediately instead of entering the prompt queue", () => {
  assert.equal(isImmediateTuiCommand("/queue"), true);
  assert.equal(isImmediateTuiCommand("/guide focus on tests"), true);
  assert.equal(isImmediateTuiCommand("/status"), true);
  assert.equal(isImmediateTuiCommand("/run npm test"), false);
  assert.equal(isImmediateTuiCommand("please inspect"), false);
});

test("guide prompts preserve active-turn context without changing the visible queue order", () => {
  const prompt = buildGuidePrompt("Prefer the smallest patch.", "Fix the failing TUI scroll test.");

  assert.match(prompt, /User guidance/);
  assert.match(prompt, /Prefer the smallest patch/);
  assert.match(prompt, /Original active prompt/);
  assert.match(prompt, /Fix the failing TUI scroll test/);
});

test("guide stop phrases cancel instead of creating a continuation prompt", () => {
  assert.equal(isStopGuidance("停止"), true);
  assert.equal(isStopGuidance("stop"), true);
  assert.equal(isStopGuidance("取消当前任务。"), true);
  assert.equal(isStopGuidance("停止重复但继续检查测试"), false);
  assert.equal(isStopGuidance("focus on tests"), false);
});
