import assert from "node:assert/strict";
import test from "node:test";
import {
  limitResumeContextMessages,
  selectResumeArchiveChunks
} from "../../src/core/session-resume.ts";

test("resume context trim keeps a user-aligned tail under the byte budget", () => {
  const messages = [
    { role: "assistant", content: "old" },
    { role: "user", content: "x".repeat(400) },
    { role: "assistant", content: "y".repeat(400) },
    { role: "user", content: "keep-a" },
    { role: "assistant", content: "keep-b" }
  ];
  const limited = limitResumeContextMessages(messages, {
    resumeMaxMessages: 50,
    resumeMaxTokens: 10_000,
    resumeMaxBytes: 200
  });
  assert.equal(limited[0]?.role, "user");
  assert.ok(limited.length >= 1);
  assert.ok(limited.length < messages.length);
  assert.equal(limited.at(-1)?.role, "assistant");
});

test("resume context trim does not walk one message at a time on a large over-budget history", () => {
  const messages = Array.from({ length: 2500 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `payload-${index}-${"z".repeat(80)}`
  }));
  const started = Date.now();
  const limited = limitResumeContextMessages(messages, {
    resumeMaxMessages: 100000,
    resumeMaxTokens: 2_000,
    resumeMaxBytes: 8_000
  });
  const elapsed = Date.now() - started;
  assert.ok(limited.length >= 1);
  assert.ok(limited.length < 2500);
  assert.equal(limited[0]?.role, "user");
  assert.ok(elapsed < 250, `resume trim took ${elapsed}ms`);
});

test("resume archive chunk selection reads only the tail needed for the budget", () => {
  const chunks = Array.from({ length: 20 }, (_, index) => ({
    index: index + 1,
    messages: 50,
    bytes: 20_000
  }));
  const selected = selectResumeArchiveChunks(chunks, { maxMessages: 100000, maxBytes: 45_000 });
  assert.deepEqual(selected.map((chunk) => chunk.index), [18, 19, 20]);
});
