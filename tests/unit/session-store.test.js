import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSessionStore } from "../../src/storage/session-store.js";

test("session store pages a 10k transcript by reading only cursor chunks", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "session-store-page-"));
  const store = createSessionStore({ cwd });
  const messages = Array.from({ length: 10_000 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `message ${index + 1}`
  }));
  const archive = await store.writeTranscriptChunks("large-session", messages);
  await store.writeMetadata({
    id: "large-session",
    status: "completed",
    transcript: { archive, messages: messages.slice(-50) }
  });

  const latest = await store.readTranscriptPage(archive, { limit: 100 });
  assert.equal(latest.ok, true);
  assert.equal(latest.chunksRead, 2);
  assert.equal(latest.messages.length, 100);
  assert.equal(latest.messages[0].content, "message 9901");
  assert.equal(latest.messages.at(-1).content, "message 10000");
  assert.equal(latest.summary.cursor, "9900");
  assert.equal(latest.summary.total, 10_000);

  const previous = await store.readTranscriptPage(archive, {
    before: latest.summary.cursor,
    limit: 100
  });
  assert.equal(previous.ok, true);
  assert.equal(previous.chunksRead, 2);
  assert.equal(previous.messages[0].content, "message 9801");
  assert.equal(previous.messages.at(-1).content, "message 9900");
  assert.equal(previous.summary.cursor, "9800");

  const appendedMessages = Array.from({ length: 7 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `appended ${index + 1}`
  }));
  const appended = await store.writeTranscriptChunks("large-session", appendedMessages, archive);
  const appendedPage = await store.readTranscriptPage(appended, { limit: 100 });
  assert.equal(appended.totalMessages, 10_007);
  assert.equal(appended.totalVisibleMessages, 10_007);
  assert.equal(appendedPage.ok, true);
  assert.equal(appendedPage.chunksRead, 3);
  assert.equal(appendedPage.messages.length, 100);
  assert.equal(appendedPage.messages.at(-1).content, "appended 7");
  assert.equal(appendedPage.summary.total, 10_007);
});

test("session store reports corrupt and missing target chunks without metadata fallback", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "session-store-corrupt-"));
  const store = createSessionStore({ cwd });
  const messages = Array.from({ length: 120 }, (_, index) => ({ role: "user", content: `message ${index + 1}` }));
  const archive = await store.writeTranscriptChunks("corrupt-session", messages);
  const lastChunk = archive.chunks.at(-1);
  const lastPath = path.join(store.root, lastChunk.file);
  const original = await fs.readFile(lastPath, "utf8");

  await fs.writeFile(lastPath, "{not-json", "utf8");
  const corrupt = await store.readTranscriptPage(archive, { limit: 50 });
  assert.equal(corrupt.ok, false);
  assert.equal(corrupt.error.code, "TRANSCRIPT_CHUNK_INVALID");
  assert.equal(corrupt.chunksRead, 1);

  await fs.writeFile(lastPath, original, "utf8");
  await fs.unlink(lastPath);
  const missing = await store.readTranscriptPage(archive, { limit: 50 });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "TRANSCRIPT_CHUNK_MISSING");
  assert.equal(missing.chunksRead, 1);
});

test("session store refuses to append over a corrupt partial chunk", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "session-store-append-corrupt-"));
  const store = createSessionStore({ cwd });
  const archive = await store.writeTranscriptChunks(
    "append-corrupt-session",
    Array.from({ length: 51 }, (_, index) => ({ role: "user", content: `message ${index + 1}` }))
  );
  await fs.writeFile(path.join(store.root, archive.chunks.at(-1).file), "{broken", "utf8");

  await assert.rejects(
    store.writeTranscriptChunks("append-corrupt-session", [{ role: "assistant", content: "new" }], archive),
    (error) => error?.code === "TRANSCRIPT_CHUNK_INVALID"
  );
});

test("session store keeps legacy archives without visible counters pageable", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "session-store-legacy-"));
  const store = createSessionStore({ cwd });
  const archive = await store.writeTranscriptChunks(
    "legacy-session",
    Array.from({ length: 125 }, (_, index) => ({ role: "user", content: `legacy ${index + 1}` }))
  );
  const legacy = {
    version: 1,
    chunkSize: archive.chunkSize,
    totalMessages: archive.totalMessages,
    chunks: archive.chunks.map(({ visibleMessages, ...chunk }) => chunk)
  };

  const page = await store.readTranscriptPage(legacy, { limit: 75 });
  assert.equal(page.ok, true);
  assert.equal(page.messages.length, 75);
  assert.equal(page.messages[0].content, "legacy 51");
  assert.equal(page.summary.total, 125);
  assert.equal(page.chunksRead, 2);
});
