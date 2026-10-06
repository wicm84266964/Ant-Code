import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDashboardRuntime } from "../../src/dashboard/sessions.ts";
import {
  collectContentSearchHits,
  contentSearchExcerpt
} from "../../src/dashboard/runtime/session-search.ts";
import { createSessionStore } from "../../src/storage/session-store.ts";

test("content search excerpt keeps the matched phrase and nearby words", () => {
  const excerpt = contentSearchExcerpt("前面的说明。请核对实验标签 alpha-tag，然后继续。", "alpha-tag", 8);
  assert.match(excerpt, /alpha-tag/);
  assert.match(excerpt, /^…/);
  assert.doesNotMatch(excerpt, /前面的说明/);
});

test("content search hits user and assistant text and skips hidden process", () => {
  const hits = collectContentSearchHits([
    { role: "user", content: "请核对实验标签 alpha-tag" },
    { role: "assistant", thinkingProcess: true, content: "alpha-tag 的思考过程" },
    { role: "assistant", content: "标签 alpha-tag 已核对。" },
    { role: "tool", content: "alpha-tag" }
  ], "ALPHA-TAG", { sessionId: "s1", title: "分类整理" });
  assert.deepEqual(hits.map((hit) => hit.role), ["user", "assistant"]);
  assert.equal(hits[0].title, "分类整理");
  assert.equal(hits[1].position, 2);
});

test("dashboard content search reads saved session text and rejects an oversized query", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ant-code-content-search-"));
  try {
    const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: cwd } });
    const store = createSessionStore({ cwd });
    await store.writeMetadata({
      id: "search-session",
      title: "分类整理",
      prompt: "分类整理",
      status: "completed",
      transcript: {
        version: 2,
        messages: [
          { role: "user", content: "请核对实验标签 alpha-tag" },
          { role: "assistant", content: "标签已核对。" }
        ]
      }
    });
    const found = await runtime.searchSessionContent("alpha-tag");
    assert.equal(found.ok, true);
    assert.equal(found.hits.length, 1);
    assert.equal(found.hits[0].sessionId, "search-session");
    assert.equal(found.hits[0].role, "user");
    assert.match(found.hits[0].excerpt, /alpha-tag/);
    const empty = await runtime.searchSessionContent("不存在的句子");
    assert.equal(empty.ok, true);
    assert.equal(empty.hits.length, 0);
    const tooLong = await runtime.searchSessionContent("a".repeat(201));
    assert.equal(tooLong.ok, false);
    assert.equal(tooLong.status, 400);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
