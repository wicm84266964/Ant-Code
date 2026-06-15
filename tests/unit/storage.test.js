import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSessionStore } from "../../src/storage/session-store.js";

test("session store writes redacted metadata", async () => {
  const cwd = await makeTempWorkspace();
  const store = createSessionStore({ cwd });
  const filePath = await store.writeMetadata({
    id: "session-1",
    api_key: "secret",
    nested: { token: "secret" }
  });

  const content = await fs.readFile(filePath, "utf8");
  assert.match(content, /\[redacted\]/);
  assert.doesNotMatch(content, /secret/);
});

test("session store cleanup removes expired metadata", async () => {
  const cwd = await makeTempWorkspace();
  const store = createSessionStore({ cwd });
  const filePath = await store.writeMetadata({ id: "old-session" });
  const oldTime = new Date("2026-01-01T00:00:00.000Z");
  await fs.utimes(filePath, oldTime, oldTime);

  const result = await store.cleanupExpiredSessions(1, {
    now: new Date("2026-04-28T00:00:00.000Z")
  });

  assert.deepEqual(result.deleted, [filePath]);
  assert.deepEqual(await store.listSessions(), []);
});

test("session store deletes selected metadata and transcript chunks", async () => {
  const cwd = await makeTempWorkspace();
  const store = createSessionStore({ cwd });
  const archive = await store.writeTranscriptChunks("delete-me", [
    { role: "user", content: "prompt" },
    { role: "assistant", content: [{ type: "text", text: "answer" }] }
  ]);
  const filePath = await store.writeMetadata({
    id: "delete-me",
    transcript: { archive }
  });

  const result = await store.deleteSession("delete-me");

  assert.equal(result.ok, true);
  assert.deepEqual(result.deleted, [filePath]);
  assert.equal((await store.readMetadata("delete-me")).ok, false);
  await assert.rejects(
    fs.stat(path.join(cwd, ".lab-agent", "sessions", "delete-me.transcript")),
    /ENOENT/
  );
});

test("session store reads latest bounded metadata", async () => {
  const cwd = await makeTempWorkspace();
  const store = createSessionStore({ cwd });
  await store.writeMetadata({ id: "session-a", turnIndex: 1, prompt: "first prompt", status: "completed" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const filePath = await store.writeMetadata({
    id: "session-b",
    title: "Readable session title",
    turnIndex: 2,
    prompt: "second prompt",
    status: "interrupted",
    model: "mock-sonnet",
    transcript: {
      messages: [
        { role: "user", content: "second prompt" },
        { role: "assistant", content: [{ type: "text", text: "second answer" }] }
      ]
    }
  });

  const listed = await store.listSessionRecords();
  const latest = await store.readMetadata("latest");
  const selected = await store.readMetadata("session-b");
  const prefixSelected = await store.readMetadata("session-b".slice(0, 9));

  assert.equal(listed.length, 2);
  assert.equal(listed[0].id, "session-b");
  assert.equal(listed[0].readable, true);
  assert.equal(listed[0].title, "Readable session title");
  assert.equal(listed[0].prompt, "second prompt");
  assert.equal(listed[0].status, "interrupted");
  assert.equal(listed[0].model, "mock-sonnet");
  assert.equal(listed[0].transcriptMessages, 2);
  assert.equal(listed[0].transcriptWindowMessages, 2);
  assert.equal(listed[0].transcriptChunks, 0);
  assert.equal(latest.ok, true);
  assert.equal(latest.metadata.id, "session-b");
  assert.equal(selected.path, filePath);
  assert.equal(selected.metadata.turnIndex, 2);
  assert.equal(prefixSelected.ok, true);
  assert.equal(prefixSelected.metadata.id, "session-b");
});

test("session store writes transcript chunks without bloating metadata", async () => {
  const cwd = await makeTempWorkspace();
  const store = createSessionStore({ cwd });
  const messages = Array.from({ length: 55 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: index % 2 === 0
      ? `prompt ${index + 1}`
      : [{ type: "text", text: `answer ${index + 1}` }]
  }));

  const archive = await store.writeTranscriptChunks("chunked-session", messages);
  await store.writeMetadata({
    id: "chunked-session",
    turnIndex: 28,
    transcript: {
      version: 2,
      messages: messages.slice(-50),
      archive
    }
  });

  const metadataPath = path.join(cwd, ".lab-agent", "sessions", "chunked-session.json");
  const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
  const listed = await store.listSessionRecords();
  const firstChunk = JSON.parse(await fs.readFile(path.join(cwd, ".lab-agent", "sessions", archive.chunks[0].file), "utf8"));
  const secondChunk = JSON.parse(await fs.readFile(path.join(cwd, ".lab-agent", "sessions", archive.chunks[1].file), "utf8"));
  const readFirst = await store.readTranscriptChunk(archive, 1);
  const readSecond = await store.readTranscriptChunk("chunked-session", 2);
  const missing = await store.readTranscriptChunk(archive, 3);

  assert.equal(archive.totalMessages, 55);
  assert.equal(archive.chunks.length, 2);
  assert.equal(metadata.transcript.messages.length, 50);
  assert.equal(firstChunk.messages.length, 50);
  assert.equal(secondChunk.messages.length, 5);
  assert.equal(readFirst.ok, true);
  assert.equal(readFirst.messages.length, 50);
  assert.equal(readFirst.messages[0].content, "prompt 1");
  assert.equal(readSecond.ok, true);
  assert.equal(readSecond.messages.length, 5);
  assert.equal(readSecond.messages[0].content, "prompt 51");
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "TRANSCRIPT_CHUNK_NOT_FOUND");
  assert.equal(listed[0].transcriptMessages, 55);
  assert.equal(listed[0].transcriptWindowMessages, 50);
  assert.equal(listed[0].transcriptChunks, 2);
});

test("session store derives a readable title from retained transcript", async () => {
  const cwd = await makeTempWorkspace();
  const store = createSessionStore({ cwd });
  await store.writeMetadata({
    id: "session-title",
    turnIndex: 1,
    transcript: {
      messages: [
        { role: "user", content: "investigate resume picker labels" },
        { role: "assistant", content: [{ type: "text", text: "done" }] }
      ]
    }
  });

  const listed = await store.listSessionRecords();

  assert.equal(listed[0].title, "investigate resume picker labels");
});

test("session store decrypts metadata when key material is available", async () => {
  const cwd = await makeTempWorkspace();
  const env = { LAB_AGENT_TRANSCRIPT_KEY: "local-test-key" };
  const store = createSessionStore({
    cwd,
    transcript: { enabled: true, retentionDays: 30, encryption: "required" },
    env
  });
  await store.writeMetadata({ id: "encrypted-session", turnIndex: 3 });

  const read = await store.readMetadata("encrypted-session");

  assert.equal(read.ok, true);
  assert.equal(read.metadata.id, "encrypted-session");
  assert.equal(read.metadata.turnIndex, 3);
});

test("session store skips writes when transcript retention is zero", async () => {
  const cwd = await makeTempWorkspace();
  const store = createSessionStore({
    cwd,
    transcript: { enabled: true, retentionDays: 0 }
  });

  const filePath = await store.writeMetadata({ id: "sensitive-session" });

  assert.equal(filePath, null);
  assert.deepEqual(await store.listSessions(), []);
});

test("session store skips writes when transcript persistence is disabled", async () => {
  const cwd = await makeTempWorkspace();
  const store = createSessionStore({
    cwd,
    transcript: { enabled: false, retentionDays: 30 }
  });

  const filePath = await store.writeMetadata({ id: "disabled-session" });

  assert.equal(filePath, null);
  assert.deepEqual(await store.listSessions(), []);
});

test("session store encrypts metadata when transcript key is provided", async () => {
  const cwd = await makeTempWorkspace();
  const store = createSessionStore({
    cwd,
    transcript: { enabled: true, retentionDays: 30, encryption: "required" },
    env: { LAB_AGENT_TRANSCRIPT_KEY: "local-test-key" }
  });

  const filePath = await store.writeMetadata({
    id: "encrypted-session",
    prompt: "sensitive prompt",
    token: "secret"
  });

  assert.match(filePath, /\.json\.enc$/);
  const content = await fs.readFile(filePath, "utf8");
  const envelope = JSON.parse(content);
  assert.equal(envelope.encrypted, true);
  assert.equal(envelope.algorithm, "aes-256-gcm");
  assert.doesNotMatch(content, /sensitive prompt/);
  assert.doesNotMatch(content, /secret/);
  assert.deepEqual(await store.listSessions(), [filePath]);
});

test("session store requires key material when encryption is required", async () => {
  const cwd = await makeTempWorkspace();
  const store = createSessionStore({
    cwd,
    transcript: { enabled: true, retentionDays: 30, encryption: "required" },
    env: {}
  });

  await assert.rejects(
    store.writeMetadata({ id: "missing-key" }),
    /LAB_AGENT_TRANSCRIPT_KEY is required/
  );
});

async function makeTempWorkspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
}
