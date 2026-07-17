import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSession, persistSessionSnapshot } from "../../src/core/session.js";
import { createSessionStore } from "../../src/storage/session-store.js";

const PROPERTY_SEEDS = Object.freeze([
  0x05e55104,
  0x1badb002,
  0xc0ffee11,
  0xdecafbad
]);
const PROPERTY_STEPS = 32;

for (const seed of PROPERTY_SEEDS) {
  test(`session persistence preserves archive invariants for seed 0x${seed.toString(16)}`, () => (
    runPersistencePropertySequence(seed)
  ));
}

async function runPersistencePropertySequence(seed) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-persistence-property-"));
  const env = {};
  const random = seededRandom(seed);
  const trace = [];
  trace.seed = seed;
  let session = await createSession({ cwd, mode: "interactive", env });
  let store = createSessionStore({ cwd, transcript: session.config.transcript, env });
  const expectedCommitted = [];

  await store.writeMetadata({
    id: session.id,
    startedAt: session.startedAt,
    status: "active",
    model: session.model,
    transcript: {
      version: 2,
      messages: [],
      contextMessages: [],
      archive: emptyArchive(7),
      modelArchive: emptyArchive(7)
    }
  });

  try {
    for (let step = 0; step < PROPERTY_STEPS; step += 1) {
      const message = {
        role: step % 2 === 0 ? "user" : "assistant",
        content: `property-${seed.toString(16)}-${step}`
      };
      appendPending(session, message);
      const operation = Math.floor(random() * 5);

      if (operation === 0 || operation === 1) {
        trace.push(`${step}:fail`);
        await assert.rejects(
          persistSessionSnapshot(session, { env, store: metadataFailingStore(store, step) }),
          (error) => error?.code === "INJECTED_PROPERTY_METADATA_FAILURE"
        );
        await assertCommittedSnapshot(store, session.id, expectedCommitted, trace);
        assert.equal(session.transcriptArchive.pendingMessages.length > 0, true, diagnostic(trace));
        assert.equal(session.modelContextArchive.pendingMessages.length > 0, true, diagnostic(trace));

        if (operation === 1) {
          trace.push(`${step}:retry`);
          const newlyCommitted = pendingContents(session, message.content);
          await persistSessionSnapshot(session, { env, store });
          expectedCommitted.push(...newlyCommitted);
          await assertCommittedSnapshot(store, session.id, expectedCommitted, trace);
        }
      } else {
        trace.push(`${step}:commit`);
        const newlyCommitted = session.transcriptArchive.pendingMessages.map((pending) => pending.content);
        await persistSessionSnapshot(session, { env, store });
        expectedCommitted.push(...newlyCommitted);
        await assertCommittedSnapshot(store, session.id, expectedCommitted, trace);
      }

      if (session.transcriptArchive.pendingMessages.length === 0 && random() < 0.3) {
        trace.push(`${step}:resume`);
        session = await createSession({
          cwd,
          mode: "interactive",
          env,
          resume: session.id,
          resumeFullContext: true
        });
        store = createSessionStore({ cwd, transcript: session.config.transcript, env });
        assert.deepEqual(session.messages.map((item) => item.content), expectedCommitted, diagnostic(trace));
      }
    }

    if (session.transcriptArchive.pendingMessages.length > 0) {
      trace.push("final:retry");
      const newlyCommitted = session.transcriptArchive.pendingMessages.map((pending) => pending.content);
      await persistSessionSnapshot(session, { env, store });
      expectedCommitted.push(...newlyCommitted);
    }
    await assertCommittedSnapshot(store, session.id, expectedCommitted, trace);
    assert.equal(expectedCommitted.length, PROPERTY_STEPS, diagnostic(trace));
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
}

function appendPending(session, message) {
  session.messages.push(message);
  session.transcriptMessages.push(message);
  session.transcriptArchive.pendingMessages.push(message);
  session.modelContextArchive.pendingMessages.push(message);
}

function pendingContents(session, latestContent) {
  const contents = session.transcriptArchive.pendingMessages.map((message) => message.content);
  assert.equal(contents.includes(latestContent), true);
  return contents;
}

function metadataFailingStore(store, step) {
  return {
    ...store,
    async writeMetadata() {
      throw Object.assign(new Error(`injected metadata failure at property step ${step}`), {
        code: "INJECTED_PROPERTY_METADATA_FAILURE"
      });
    }
  };
}

async function assertCommittedSnapshot(store, sessionId, expected, trace) {
  const saved = await store.readMetadataExact(sessionId);
  assert.equal(saved.ok, true, diagnostic(trace));

  for (const archiveName of ["archive", "modelArchive"]) {
    const archive = saved.metadata.transcript[archiveName];
    assert.equal(archive.totalMessages, expected.length, diagnostic(trace));
    assert.equal(
      archive.chunks.reduce((total, chunk) => total + chunk.messages, 0),
      expected.length,
      diagnostic(trace)
    );
    assert.deepEqual(
      archive.chunks.map((chunk) => chunk.index),
      archive.chunks.map((_, index) => index + 1),
      diagnostic(trace)
    );

    const messages = [];
    for (const chunk of archive.chunks) {
      const read = await store.readTranscriptChunk(archive, chunk.index);
      assert.equal(read.ok, true, `${diagnostic(trace)}; unreadable metadata reference: ${chunk.file}`);
      assert.equal(read.messages.length, chunk.messages, diagnostic(trace));
      messages.push(...read.messages);
    }
    const contents = messages.map((message) => message.content);
    assert.deepEqual(contents, expected, diagnostic(trace));
    assert.equal(new Set(contents).size, contents.length, diagnostic(trace));
  }
}

function emptyArchive(chunkSize) {
  return {
    version: 1,
    chunkSize,
    totalMessages: 0,
    totalVisibleMessages: 0,
    chunks: []
  };
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function diagnostic(trace) {
  return `seed=0x${trace.seed.toString(16)} trace=${trace.join(",")}`;
}
