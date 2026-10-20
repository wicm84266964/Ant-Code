import assert from "node:assert/strict";
import test from "node:test";
import { messagesForModelContext } from "../../src/core/session-messages.ts";
import { persistableMessage } from "../../src/core/session-persist.ts";
import { toolActivityTranscriptMessage } from "../../src/core/session-tools.ts";
import { captureVisibleProcessEvent, createVisibleProcessCapture, visibleProcessItemsForTranscript } from "../../src/core/session-turn.ts";

test("tool activity records stay in the transcript and out of the model context", () => {
  const message = toolActivityTranscriptMessage({
    toolCallId: "call-1",
    name: "read_file",
    display: { ok: false, blocked: false, errorCode: "ENOENT", resultBytes: 12, truncated: false, preview: "ok=false tool=read_file\nerror=ENOENT: missing" }
  });
  assert.equal(message.toolActivity, true);
  assert.equal(message.content[0].text, "读取文件未成功，本轮继续");
  assert.match(message.toolDetail, /ENOENT/);
  assert.match(message.toolDetail, /missing/);
  assert.doesNotMatch(JSON.stringify(message), /notes\.txt|file content/i);

  const persisted = persistableMessage(message);
  assert.equal(persisted?.toolActivity, true);
  assert.equal(persisted?.toolStatus, "failed");
  assert.equal(messagesForModelContext([message, { role: "user", content: "继续" }]).length, 1);
});

test("visible process keeps thinking rounds and tools in appearance order", () => {
  const capture = createVisibleProcessCapture();
  captureVisibleProcessEvent(capture, { type: "assistant_text_delta", round: 1, text: "先看目录" });
  captureVisibleProcessEvent(capture, { type: "tool_start", toolCallId: "call-1", name: "read_file" });
  captureVisibleProcessEvent(capture, { type: "tool_finish", toolCallId: "call-1", name: "read_file", ok: true, resultBytes: 4, resultPreview: "README" });
  captureVisibleProcessEvent(capture, { type: "assistant_text_delta", round: 2, text: "再总结" });
  const items = visibleProcessItemsForTranscript(capture);
  assert.deepEqual(items.map((item) => item.title), ["思考 · 第 1 轮", "读取文件已完成", "思考 · 第 2 轮"]);
  assert.equal(items[1].text.includes("README"), true);

  const persisted = persistableMessage({
    role: "assistant",
    thinkingProcess: true,
    processItems: items,
    content: [{ type: "text", text: "先看目录" }]
  });
  assert.equal(persisted?.processItems?.length, 3);
  assert.equal(messagesForModelContext([persisted, { role: "user", content: "继续" }]).length, 1);
});
