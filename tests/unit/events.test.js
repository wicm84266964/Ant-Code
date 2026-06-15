import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  ANT_EVENT_SCHEMA_VERSION,
  createAntEventNormalizer,
  createAntJsonOutput,
  isPrintableAntEvent,
  sanitizeAntEventForPersistence
} from "../../src/core/events.js";

test("AntEvent normalizer emits schema v2 events with stable sequence", () => {
  const normalizer = createAntEventNormalizer({
    sessionId: "fixture-session",
    now: () => "2026-04-28T00:00:00.000Z",
    idFactory: (sequence, type) => `fixture:${String(sequence).padStart(6, "0")}:${type}`
  });

  const events = [
    ...normalizer.normalize({ type: "turn_start", turnIndex: 1, promptBytes: 12 }),
    ...normalizer.normalize({ type: "gateway_stream_start", round: 1, messageId: "message-1", model: "fixture-model" }),
    ...normalizer.normalize({ type: "assistant_delta", round: 1, text: "hello", bytes: 5 }),
    ...normalizer.normalize({ type: "gateway_stream_stop", round: 1, stopReason: "stop" }),
    ...normalizer.normalize({ type: "turn_complete", status: "completed", outputBytes: 5 })
  ];

  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4, 5, 6, 7]);
  assert.ok(events.every((event) => event.schemaVersion === ANT_EVENT_SCHEMA_VERSION));
  assert.deepEqual(events.map((event) => event.type), [
    "turn_start",
    "assistant_message_start",
    "assistant_text_start",
    "assistant_text_delta",
    "assistant_text_stop",
    "assistant_message_stop",
    "turn_result"
  ]);
  assert.equal(events[0].turnId, "fixture-session:turn-1");
  assert.equal(events[3].payload.text, "hello");
});

test("AntEvent text fixture stays aligned with normalizer contract", async () => {
  const fixturePath = path.resolve("tests/fixtures/events/text-stream.v2.json");
  const fixture = JSON.parse(await fs.readFile(fixturePath, "utf8"));
  assert.equal(fixture.length, 7);
  assert.deepEqual(fixture.map((event) => event.sequence), [1, 2, 3, 4, 5, 6, 7]);
  assert.ok(fixture.every((event) => event.schemaVersion === 2));
  assert.equal(fixture.find((event) => event.type === "assistant_text_delta").payload.text, "hello");
});

test("thinking deltas remain memory-only and are omitted from printable output", () => {
  const normalizer = createAntEventNormalizer({
    sessionId: "thinking-session",
    now: () => "2026-04-28T00:00:00.000Z"
  });
  const events = [
    ...normalizer.normalize({ type: "turn_start", turnIndex: 1, promptBytes: 8 }),
    ...normalizer.normalize({ type: "gateway_stream_start", round: 1, messageId: "message-1", model: "model" }),
    ...normalizer.normalize({ type: "assistant_thinking_delta", round: 1, text: "raw private reasoning token=secret", bytes: 34 })
  ];
  const thinkingDelta = events.find((event) => event.type === "assistant_thinking_delta");

  assert.equal(thinkingDelta.persistence, "memory");
  assert.equal(isPrintableAntEvent(thinkingDelta, { includePartialMessages: true }), false);
  assert.equal(sanitizeAntEventForPersistence(thinkingDelta), null);
});

test("printable event filtering omits partial text unless requested", () => {
  const normalizer = createAntEventNormalizer({
    sessionId: "partial-session",
    now: () => "2026-04-28T00:00:00.000Z"
  });
  const events = [
    ...normalizer.normalize({ type: "turn_start", turnIndex: 1, promptBytes: 5 }),
    ...normalizer.normalize({ type: "assistant_delta", round: 1, text: "hel", bytes: 3 }),
    ...normalizer.normalize({ type: "assistant_final", text: "hello", outputBytes: 5 })
  ];
  const partial = events.find((event) => event.type === "assistant_text_delta" && event.payload.partial === true);
  const complete = events.find((event) => event.type === "assistant_text_delta" && event.payload.partial === false);

  assert.equal(isPrintableAntEvent(partial, { includePartialMessages: false }), false);
  assert.equal(isPrintableAntEvent(partial, { includePartialMessages: true }), true);
  assert.equal(isPrintableAntEvent(complete, { includePartialMessages: false }), true);
});

test("turn interruption closes active assistant blocks before the turn result", () => {
  const normalizer = createAntEventNormalizer({
    sessionId: "interrupt-session",
    now: () => "2026-04-28T00:00:00.000Z"
  });
  const events = [
    ...normalizer.normalize({ type: "turn_start", turnIndex: 1, promptBytes: 5 }),
    ...normalizer.normalize({ type: "gateway_stream_start", round: 1, messageId: "message-1", model: "model" }),
    ...normalizer.normalize({ type: "assistant_delta", round: 1, text: "hel", bytes: 3 }),
    ...normalizer.normalize({ type: "turn_interrupted", reason: "ctrl-g", outputBytes: 35 }),
    ...normalizer.normalize({ type: "turn_complete", status: "interrupted", outputBytes: 35 })
  ];

  assert.deepEqual(events.map((event) => event.type), [
    "turn_start",
    "assistant_message_start",
    "assistant_text_start",
    "assistant_text_delta",
    "assistant_text_stop",
    "assistant_message_stop",
    "turn_interrupted",
    "turn_result"
  ]);
  assert.equal(events.find((event) => event.type === "turn_interrupted").payload.reason, "ctrl-g");
  assert.equal(events.at(-1).payload.status, "interrupted");
});

test("Ant JSON output envelope is schema v2", () => {
  const output = createAntJsonOutput({
    sessionId: "json-session",
    events: [],
    result: { status: "completed", outputBytes: 0 }
  });

  assert.equal(output.schemaVersion, 2);
  assert.equal(output.sessionId, "json-session");
  assert.deepEqual(output.events, []);
});
