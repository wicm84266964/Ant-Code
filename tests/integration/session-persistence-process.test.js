import assert from "node:assert/strict";
import { fork } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createSessionStore } from "../../src/storage/session-store.js";

const WORKER = fileURLToPath(new URL("../fixtures/session-persistence-worker.js", import.meta.url));
const SESSION_ID = "process-persistence-session";
const TRANSCRIPT_POLICY = Object.freeze({ enabled: true, retentionDays: 30, encryption: "off" });

test("session snapshots serialize concurrent appends from separate Node processes", async (t) => {
  const cwd = await createWorkspace(t, "lab-agent-process-concurrent-");
  const store = await seedSession(cwd);
  const base = await store.readMetadataExact(SESSION_ID);
  assert.equal(base.ok, true);
  const baseTranscriptTotal = base.metadata.transcript.archive.totalMessages;
  const baseModelTotal = base.metadata.transcript.modelArchive.totalMessages;

  const left = startWorker(t, ["append", cwd, SESSION_ID, "left process append"]);
  const right = startWorker(t, ["append", cwd, SESSION_ID, "right process append"]);
  const leftExit = waitForExit(left);
  const rightExit = waitForExit(right);
  await Promise.all([waitForMessage(left, "ready"), waitForMessage(right, "ready")]);
  left.send("commit");
  right.send("commit");
  await Promise.all([leftExit, rightExit]);

  const saved = await store.readMetadataExact(SESSION_ID);
  assert.equal(saved.ok, true);
  assert.equal(saved.metadata.transcript.archive.totalMessages, baseTranscriptTotal + 2);
  assert.equal(saved.metadata.transcript.modelArchive.totalMessages, baseModelTotal + 2);
  const transcript = await store.readTranscriptPage(saved.metadata.transcript.archive, { limit: 200 });
  const model = await store.readTranscriptPage(saved.metadata.transcript.modelArchive, {
    limit: 200,
    visibleRoles: ["user", "assistant", "tool"]
  });
  assert.equal(transcript.ok, true);
  assert.equal(model.ok, true);
  assert.deepEqual(appendedContents(transcript.messages), ["left process append", "right process append"]);
  assert.deepEqual(appendedContents(model.messages), ["left process append", "right process append"]);
});

test("archive-write crashes preserve the old snapshot and stale-lock retries commit once", async (t) => {
  const scenarios = [
    { mode: "crash-after-transcript", name: "after transcript chunks" },
    { mode: "crash-after-chunks", name: "after transcript and model chunks" },
    { mode: "crash-before-metadata-rename", name: "before metadata atomic rename" }
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async (t) => {
      const cwd = await createWorkspace(t, `lab-agent-process-${scenario.mode}-`);
      const store = await seedSession(cwd);
      const before = await store.readMetadataExact(SESSION_ID);
      assert.equal(before.ok, true);
      const beforeMetadata = JSON.parse(JSON.stringify(before.metadata));
      const marker = path.join(cwd, "crash-archives.json");
      const content = `recover once ${scenario.name}`;

      const crashing = startWorker(t, [scenario.mode, cwd, SESSION_ID, content, marker]);
      await waitForExit(crashing, 86);
      const orphaned = JSON.parse(await fs.readFile(marker, "utf8"));
      if (scenario.mode === "crash-before-metadata-rename") {
        assert.equal(path.basename(orphaned.target), `${SESSION_ID}.json`);
        assert.match(path.basename(orphaned.source), /^\.process-persistence-session\.json\..+\.tmp$/);
      } else {
        assert.equal(orphaned.transcriptArchive.totalMessages, beforeMetadata.transcript.archive.totalMessages + 1);
        if (scenario.mode === "crash-after-chunks") {
          assert.equal(orphaned.modelArchive.totalMessages, beforeMetadata.transcript.modelArchive.totalMessages + 1);
        } else {
          assert.equal(orphaned.modelArchive, undefined);
        }
      }

      const afterCrash = await store.readMetadataExact(SESSION_ID);
      assert.equal(afterCrash.ok, true);
      assert.deepEqual(afterCrash.metadata.transcript.archive, beforeMetadata.transcript.archive);
      assert.deepEqual(afterCrash.metadata.transcript.modelArchive, beforeMetadata.transcript.modelArchive);
      const oldTranscript = await store.readTranscriptPage(afterCrash.metadata.transcript.archive, { limit: 200 });
      const oldModel = await store.readTranscriptPage(afterCrash.metadata.transcript.modelArchive, {
        limit: 200,
        visibleRoles: ["user", "assistant", "tool"]
      });
      assert.equal(oldTranscript.ok, true);
      assert.equal(oldModel.ok, true);
      assert.equal(oldTranscript.messages.some((message) => message.content === content), false);
      assert.equal(oldModel.messages.some((message) => message.content === content), false);
      const listed = await store.listSessions();
      assert.deepEqual(listed.map((file) => path.basename(file)), [`${SESSION_ID}.json`]);

      const lockDirectory = path.join(cwd, ".lab-agent", "sessions", `.${SESSION_ID}.metadata.ant-code.lock`);
      const staleTime = new Date(Date.now() - 31_000);
      await fs.utimes(lockDirectory, staleTime, staleTime);

      const retry = startWorker(t, ["append", cwd, SESSION_ID, content]);
      const retryExit = waitForExit(retry);
      await waitForMessage(retry, "ready");
      retry.send("commit");
      await retryExit;

      const recovered = await store.readMetadataExact(SESSION_ID);
      assert.equal(recovered.ok, true);
      const transcript = await store.readTranscriptPage(recovered.metadata.transcript.archive, { limit: 200 });
      const model = await store.readTranscriptPage(recovered.metadata.transcript.modelArchive, {
        limit: 200,
        visibleRoles: ["user", "assistant", "tool"]
      });
      assert.equal(transcript.ok, true);
      assert.equal(model.ok, true);
      assert.equal(transcript.messages.filter((message) => message.content === content).length, 1);
      assert.equal(model.messages.filter((message) => message.content === content).length, 1);
    });
  }
});

function appendedContents(messages) {
  return messages
    .filter((message) => typeof message.content === "string" && message.content.endsWith("process append"))
    .map((message) => message.content)
    .sort();
}

async function createWorkspace(t, prefix) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  return cwd;
}

async function seedSession(cwd) {
  const store = createSessionStore({ cwd, transcript: TRANSCRIPT_POLICY, env: {} });
  const messages = [
    { role: "user", content: "seed prompt" },
    { role: "assistant", content: [{ type: "text", text: "seed answer" }] }
  ];
  const archive = await store.writeTranscriptChunks(SESSION_ID, messages);
  const modelArchive = await store.writeTranscriptChunks(SESSION_ID, messages, {}, { suffix: "model-context" });
  await store.writeMetadata({
    id: SESSION_ID,
    startedAt: new Date().toISOString(),
    status: "metadata",
    model: "test-model",
    turnIndex: 1,
    permissionMode: "default",
    readonly: false,
    allowWrite: true,
    allowCommand: true,
    fullAccess: false,
    transcript: {
      version: 2,
      messages,
      contextMessages: messages,
      contextWindow: {},
      archive,
      modelArchive
    }
  });
  return store;
}

function startWorker(t, args) {
  const child = fork(WORKER, args, {
    cwd: path.resolve("."),
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.testStderr = () => stderr;
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
  });
  return child;
}

function waitForMessage(child, type) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for worker message '${type}'`)), 10_000);
    child.on("message", (message) => {
      if (message?.type === type) {
        clearTimeout(timeout);
        resolve(message);
      }
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`Worker exited before '${type}' (${signal ?? code}): ${child.testStderr()}`));
    });
  });
}

function waitForExit(child, expectedCode = 0) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal || code !== expectedCode) {
        reject(new Error(`Worker exited with ${signal ?? code}, expected ${expectedCode}: ${child.testStderr()}`));
        return;
      }
      resolve();
    });
  });
}
