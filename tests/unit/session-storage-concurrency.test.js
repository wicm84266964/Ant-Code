import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSessionStore } from "../../src/storage/session-store.js";

test("session cleanup preserves a snapshot committed after its initial expiry scan", { timeout: 15_000 }, async () => {
  const cwd = await makeTempWorkspace("session-cleanup-race-");
  const writer = createSessionStore({ cwd });
  const cleaner = createSessionStore({ cwd });
  const sessionId = "cleanup-race-session";
  const initialArchive = await writer.writeTranscriptChunks(sessionId, [message("initial")]);
  const metadataPath = await writer.writeMetadata({
    id: sessionId,
    marker: "expired",
    transcript: { archive: initialArchive }
  });
  const oldTime = new Date("2026-01-01T00:00:00.000Z");
  await fs.utimes(metadataPath, oldTime, oldTime);

  const mutationEntered = deferred();
  const initialStatObserved = deferred();
  const originalStat = fs.stat;
  let intercepted = false;
  fs.stat = async (...args) => {
    const stat = await originalStat(...args);
    if (!intercepted && path.resolve(String(args[0])) === path.resolve(metadataPath)) {
      intercepted = true;
      initialStatObserved.resolve();
    }
    return stat;
  };

  try {
    const snapshot = writer.withSessionMutation(sessionId, async () => {
      mutationEntered.resolve();
      await initialStatObserved.promise;
      const current = await writer.readMetadataExact(sessionId, { lockHeld: true });
      assert.equal(current.ok, true);
      const archive = await writer.writeTranscriptChunks(
        sessionId,
        [message("renewed")],
        current.metadata.transcript.archive,
        { lockHeld: true }
      );
      await writer.writeMetadata({
        ...current.metadata,
        marker: "renewed",
        transcript: { archive }
      }, { lockHeld: true });
      return archive;
    });

    await mutationEntered.promise;
    const cleanup = cleaner.cleanupExpiredSessions(1, {
      now: new Date("2026-04-28T00:00:00.000Z")
    });
    const [archive, cleanupResult] = await Promise.all([snapshot, cleanup]);

    assert.deepEqual(cleanupResult.deleted, []);
    const committed = await writer.readMetadataExact(sessionId);
    assert.equal(committed.ok, true);
    assert.equal(committed.metadata.marker, "renewed");
    assert.equal(committed.metadata.transcript.archive.totalMessages, 2);
    await assertArchiveReadable(writer, archive, ["initial", "renewed"]);
  } finally {
    fs.stat = originalStat;
    initialStatObserved.resolve();
  }
});

test("a snapshot queued behind deletion recreates one complete session", { timeout: 15_000 }, async () => {
  const cwd = await makeTempWorkspace("session-delete-race-");
  const deletingStore = createSessionStore({ cwd });
  const writer = createSessionStore({ cwd });
  const sessionId = "delete-race-session";
  const initialArchive = await deletingStore.writeTranscriptChunks(sessionId, [message("obsolete")]);
  const metadataPath = await deletingStore.writeMetadata({
    id: sessionId,
    marker: "obsolete",
    transcript: { archive: initialArchive }
  });

  const deleteOwnsLock = deferred();
  const releaseDelete = deferred();
  const originalUnlink = fs.unlink;
  let intercepted = false;
  fs.unlink = async (...args) => {
    if (!intercepted && path.resolve(String(args[0])) === path.resolve(metadataPath)) {
      intercepted = true;
      deleteOwnsLock.resolve();
      await releaseDelete.promise;
    }
    return originalUnlink(...args);
  };

  try {
    const deletion = deletingStore.deleteSession(sessionId);
    await deleteOwnsLock.promise;
    const snapshot = commitSnapshot(writer, sessionId, [message("recreated")], "recreated");
    releaseDelete.resolve();

    const [deleteResult, archive] = await Promise.all([deletion, snapshot]);
    assert.equal(deleteResult.ok, true);
    assert.deepEqual(deleteResult.deleted, [metadataPath]);

    const committed = await writer.readMetadataExact(sessionId);
    assert.equal(committed.ok, true);
    assert.equal(committed.metadata.marker, "recreated");
    assert.equal(committed.metadata.transcript.archive.totalMessages, 1);
    await assertArchiveReadable(writer, archive, ["recreated"]);
  } finally {
    fs.unlink = originalUnlink;
    releaseDelete.resolve();
  }
});

for (const migrationCase of [
  {
    name: "exact plaintext migration rebases on a snapshot committed after the migration read",
    targetRead: 1,
    read: (store, sessionId) => store.readMetadataExact(sessionId)
  },
  {
    name: "selected plaintext migration rebases on a snapshot committed after the migration read",
    targetRead: 2,
    read: (store, sessionId) => store.readMetadata(sessionId)
  }
]) test(migrationCase.name, { timeout: 15_000 }, async () => {
  const cwd = await makeTempWorkspace("session-migration-race-");
  const sessionId = "migration-race-session";
  const plaintext = createSessionStore({
    cwd,
    transcript: { enabled: true, retentionDays: 30, encryption: "off" },
    env: {}
  });
  const encrypted = createSessionStore({
    cwd,
    transcript: { enabled: true, retentionDays: 30, encryption: "required" },
    env: { LAB_AGENT_TRANSCRIPT_KEY: "migration-race-test-key" }
  });
  const initialArchive = await plaintext.writeTranscriptChunks(sessionId, [message("initial")]);
  const plaintextPath = await plaintext.writeMetadata({
    id: sessionId,
    marker: "initial",
    transcript: { archive: initialArchive }
  });

  const stalePlaintextRead = deferred();
  const releaseMigrationRead = deferred();
  const originalReadFile = fs.readFile;
  let plaintextReads = 0;
  fs.readFile = async (...args) => {
    const contents = await originalReadFile(...args);
    if (path.resolve(String(args[0])) === path.resolve(plaintextPath)) {
      plaintextReads += 1;
    }
    if (plaintextReads === migrationCase.targetRead) {
      plaintextReads += 1;
      stalePlaintextRead.resolve();
      await releaseMigrationRead.promise;
    }
    return contents;
  };

  try {
    const migration = migrationCase.read(encrypted, sessionId);
    await stalePlaintextRead.promise;
    const archive = await commitSnapshot(plaintext, sessionId, [message("concurrent")], "concurrent");
    releaseMigrationRead.resolve();
    const migrated = await migration;

    assert.equal(migrated.ok, true);
    assert.equal(migrated.encrypted, true);
    assert.equal(migrated.metadata.marker, "concurrent");
    assert.equal(migrated.metadata.transcript.archive.totalMessages, 2);
    await assert.rejects(fs.stat(plaintextPath), { code: "ENOENT" });
    await assertArchiveReadable(encrypted, archive, ["initial", "concurrent"]);
  } finally {
    fs.readFile = originalReadFile;
    releaseMigrationRead.resolve();
  }
});

async function commitSnapshot(store, sessionId, messages, marker) {
  return store.withSessionMutation(sessionId, async () => {
    const current = await store.readMetadataExact(sessionId, { lockHeld: true });
    const archive = await store.writeTranscriptChunks(
      sessionId,
      messages,
      current.ok ? current.metadata?.transcript?.archive : {},
      { lockHeld: true }
    );
    await store.writeMetadata({
      ...(current.ok ? current.metadata : {}),
      id: sessionId,
      marker,
      transcript: { archive }
    }, { lockHeld: true });
    return archive;
  });
}

async function assertArchiveReadable(store, archive, expectedContents) {
  const contents = [];
  for (const chunk of archive.chunks) {
    const read = await store.readTranscriptChunk(archive, chunk.index);
    assert.equal(read.ok, true, read.error?.message);
    contents.push(...read.messages.map((entry) => entry.content));
  }
  assert.deepEqual(contents, expectedContents);
}

function message(content) {
  return { role: "user", content };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function makeTempWorkspace(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}
