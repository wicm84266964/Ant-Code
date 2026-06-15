import assert from "node:assert/strict";
import test from "node:test";
import { createAntEventNormalizer } from "../../src/core/events.js";
import { reduceAntEvents } from "../../src/core/event-reducer.js";

test("AntEvent reducer builds transcript from assistant and tool events", () => {
  const normalizer = createAntEventNormalizer({
    sessionId: "reducer-session",
    now: () => "2026-04-28T00:00:00.000Z"
  });
  const events = [
    ...normalizer.normalize({ type: "turn_start", turnIndex: 1, promptBytes: 9 }),
    ...normalizer.normalize({ type: "gateway_stream_start", round: 1, messageId: "message-1", model: "model" }),
    ...normalizer.normalize({ type: "assistant_thinking_delta", round: 1, text: "private thought", bytes: 15 }),
    ...normalizer.normalize({ type: "assistant_delta", round: 1, text: "hello ", bytes: 6 }),
    ...normalizer.normalize({ type: "assistant_delta", round: 1, text: "world", bytes: 5 }),
    ...normalizer.normalize({ type: "gateway_stream_stop", round: 1, stopReason: "stop" }),
    ...normalizer.normalize({ type: "tool_calls_requested", round: 1, toolCalls: [{ id: "read-1", name: "read_file", inputKeys: ["path"] }] }),
    ...normalizer.normalize({ type: "tool_start", toolCallId: "read-1", name: "read_file", inputKeys: ["path"] }),
    ...normalizer.normalize({ type: "tool_finish", toolCallId: "read-1", name: "read_file", ok: true, blocked: false, resultBytes: 20 }),
    ...normalizer.normalize({ type: "turn_complete", status: "completed", outputBytes: 11 })
  ];

  const state = reduceAntEvents(events);

  assert.equal(state.session.id, "reducer-session");
  assert.equal(state.session.status, "completed");
  assert.deepEqual(state.transcript.map((item) => item.kind), ["assistant", "tool"]);
  assert.equal(state.transcript[0].text, "hello world");
  assert.equal(state.transcript[0].thinking, "collapsed");
  assert.equal(state.tools[0].id, "read-1");
  assert.equal(state.tools[0].status, "completed");
});

test("AntEvent reducer preserves compact error transcript item", () => {
  const normalizer = createAntEventNormalizer({
    sessionId: "error-session",
    now: () => "2026-04-28T00:00:00.000Z"
  });
  const events = [
    ...normalizer.normalize({ type: "turn_start", turnIndex: 1, promptBytes: 5 }),
    ...normalizer.normalize({ type: "gateway_error", error: { code: "GATEWAY_HTTP_ERROR", message: "token=secret failed" }, outputBytes: 10 }),
    ...normalizer.normalize({ type: "turn_complete", status: "gateway_error", outputBytes: 10 })
  ];
  const state = reduceAntEvents(events);

  assert.equal(state.session.status, "gateway_error");
  assert.equal(state.errors[0].code, "GATEWAY_HTTP_ERROR");
  assert.equal(state.errors[0].message, "token=<redacted> failed");
  assert.equal(state.transcript[0].kind, "error");
});
