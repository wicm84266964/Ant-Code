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

test("session store rejects a sessions root that escapes through a junction", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "session-store-root-junction-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "session-store-root-outside-"));
  await fs.mkdir(path.join(cwd, ".lab-agent"), { recursive: true });
  await fs.symlink(
    outside,
    path.join(cwd, ".lab-agent", "sessions"),
    process.platform === "win32" ? "junction" : "dir"
  );
  const store = createSessionStore({ cwd });

  await assert.rejects(
    store.writeMetadata({ id: "escaped-session", status: "completed" }),
    (error) => error?.code === "STORAGE_PATH_OUTSIDE_WORKSPACE"
  );
  assert.equal(await fs.stat(path.join(outside, "escaped-session.json")).then(() => true).catch(() => false), false);
});

test("session store rejects transcript chunks that escape through a junction", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "session-store-chunk-junction-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "session-store-chunk-outside-"));
  const store = createSessionStore({ cwd });
  await store.writeMetadata({ id: "junction-session", status: "completed" });
  await fs.writeFile(path.join(outside, "secret.json"), `${JSON.stringify({
    version: "ant-code-transcript-chunk.v1",
    sessionId: "junction-session",
    index: 1,
    messages: [{ role: "assistant", content: "OUTSIDE_SECRET" }]
  })}\n`, "utf8");
  await fs.symlink(
    outside,
    path.join(store.root, "chunk-junction"),
    process.platform === "win32" ? "junction" : "dir"
  );

  const result = await store.readTranscriptChunk({
    version: 1,
    chunkSize: 50,
    totalMessages: 1,
    totalVisibleMessages: 1,
    chunks: [{
      index: 1,
      file: "chunk-junction/secret.json",
      messages: 1,
      visibleMessages: 1,
      bytes: 1,
      encrypted: false
    }]
  }, 1);

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "TRANSCRIPT_CHUNK_READ_ERROR");
  assert.equal(JSON.stringify(result).includes("OUTSIDE_SECRET"), false);
});

test("session store keeps the committed snapshot readable when metadata commit fails", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "session-store-metadata-failure-"));
  const sessionId = "metadata-failure-session";
  const plaintext = createSessionStore({ cwd });
  const committedMessages = Array.from({ length: 51 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `committed ${index + 1}`
  }));
  const committedArchive = await plaintext.writeTranscriptChunks(sessionId, committedMessages);
  await plaintext.writeMetadata({
    id: sessionId,
    status: "completed",
    transcript: { archive: committedArchive, messages: committedMessages.slice(-50) }
  });
  const committedTailPath = path.join(plaintext.root, committedArchive.chunks.at(-1).file);
  const committedTail = await fs.readFile(committedTailPath, "utf8");

  const encrypted = createSessionStore({
    cwd,
    transcript: { enabled: true, retentionDays: 30, encryption: "required" },
    env: { LAB_AGENT_TRANSCRIPT_KEY: "metadata-failure-key" }
  });
  const uncommittedArchive = await encrypted.writeTranscriptChunks(
    sessionId,
    [{ role: "assistant", content: "must remain uncommitted" }],
    committedArchive
  );
  assert.equal(uncommittedArchive.chunks.length, committedArchive.chunks.length);
  assert.equal(uncommittedArchive.chunks.at(-1).messages, 2);
  await fs.mkdir(path.join(encrypted.root, `${sessionId}.json.enc`));

  await assert.rejects(encrypted.writeMetadata({
    id: sessionId,
    status: "completed",
    transcript: { archive: uncommittedArchive }
  }));

  const oldMetadata = await plaintext.readMetadataExact(sessionId);
  const oldPage = await plaintext.readTranscriptPage(oldMetadata.metadata.transcript.archive, { limit: 100 });
  assert.equal(oldMetadata.ok, true);
  assert.equal(oldPage.ok, true);
  assert.equal(oldPage.messages.length, 51);
  assert.equal(oldPage.messages.at(-1).content, "committed 51");
  assert.equal(await fs.readFile(committedTailPath, "utf8"), committedTail);
  assert.notEqual(uncommittedArchive.chunks.at(-1).file, committedArchive.chunks.at(-1).file);
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

test("session store migrates legacy plaintext metadata when encryption becomes required", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "session-store-encryption-migration-"));
  const plaintext = createSessionStore({
    cwd,
    transcript: { enabled: true, retentionDays: 30, encryption: "off" },
    env: {}
  });
  await plaintext.writeMetadata({ id: "migration-session", marker: "legacy-plaintext" });

  const encrypted = createSessionStore({
    cwd,
    transcript: { enabled: true, retentionDays: 30, encryption: "required" },
    env: { LAB_AGENT_TRANSCRIPT_KEY: "migration-test-key" }
  });
  const read = await encrypted.readMetadataExact("migration-session");
  const entries = await fs.readdir(encrypted.root);

  assert.equal(read.ok, true);
  assert.equal(read.encrypted, true);
  assert.equal(read.metadata.marker, "legacy-plaintext");
  assert.deepEqual(entries.filter((name) => name.startsWith("migration-session.")), ["migration-session.json.enc"]);
});

test("session store prefers encrypted metadata and deletes every legacy format", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "session-store-encryption-dual-"));
  const plaintext = createSessionStore({
    cwd,
    transcript: { enabled: true, retentionDays: 30, encryption: "off" },
    env: {}
  });
  const plaintextPath = await plaintext.writeMetadata({ id: "dual-session", marker: "stale-plaintext" });
  const stalePlaintext = await fs.readFile(plaintextPath, "utf8");

  const encrypted = createSessionStore({
    cwd,
    transcript: { enabled: true, retentionDays: 30, encryption: "required" },
    env: { LAB_AGENT_TRANSCRIPT_KEY: "dual-test-key" }
  });
  await encrypted.writeMetadata({ id: "dual-session", marker: "current-encrypted" });
  await fs.writeFile(plaintextPath, stalePlaintext, "utf8");

  const read = await encrypted.readMetadataExact("dual-session");
  const deleted = await encrypted.deleteSession("dual-session");
  const entries = await fs.readdir(encrypted.root);

  assert.equal(read.ok, true);
  assert.equal(read.metadata.marker, "current-encrypted");
  assert.equal(deleted.deleted.length, 2);
  assert.deepEqual(entries.filter((name) => name.startsWith("dual-session.")), []);
});
