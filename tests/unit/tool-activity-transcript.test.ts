import assert from "node:assert/strict";
import test from "node:test";
import { messagesForModelContext } from "../../src/core/session-messages.ts";
import { persistableMessage } from "../../src/core/session-persist.ts";
import { toolActivityTranscriptMessage } from "../../src/core/session-tools.ts";

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
