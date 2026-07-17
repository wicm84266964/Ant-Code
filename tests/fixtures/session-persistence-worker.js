import fs from "node:fs/promises";
import path from "node:path";
import { createSession, persistSessionSnapshot } from "../../src/core/session.js";
import { createSessionStore } from "../../src/storage/session-store.js";

const [mode, cwd, sessionId, content, markerPath] = process.argv.slice(2);

if (!mode || !cwd || !sessionId || !content) {
  throw new Error("Expected mode, cwd, session id, and message content");
}

const env = {};
const session = await createSession({ cwd, mode: "interactive", env, resume: sessionId });
const store = createSessionStore({ cwd, transcript: session.config.transcript, env });
const message = { role: "user", content };

if (mode === "append") {
  appendPendingMessage(session, message);
  await sendToParent({ type: "ready" });
  await waitForParentMessage("commit");
  await persistSessionSnapshot(session, { env, store });
  await sendToParent({ type: "committed" });
  process.disconnect?.();
} else if (mode === "crash-before-metadata-rename") {
  if (!markerPath) {
    throw new Error("Crash mode requires a marker path");
  }
  appendPendingMessage(session, message);
  const rename = fs.rename;
  fs.rename = async (source, target) => {
    const targetName = path.basename(String(target));
    if ([`${sessionId}.json`, `${sessionId}.json.enc`].includes(targetName)) {
      await fs.writeFile(markerPath, JSON.stringify({ source, target }), "utf8");
      process.exit(86);
    }
    return rename(source, target);
  };
  await persistSessionSnapshot(session, { env, store });
} else if (["crash-after-transcript", "crash-after-chunks"].includes(mode)) {
  if (!markerPath) {
    throw new Error("Crash mode requires a marker path");
  }
  await store.withSessionMutation(sessionId, async () => {
    const current = await store.readMetadataExact(sessionId, { lockHeld: true });
    if (!current.ok) {
      throw new Error(current.error?.message ?? "Unable to read committed session metadata");
    }
    const transcriptArchive = await store.writeTranscriptChunks(
      sessionId,
      [message],
      current.metadata.transcript?.archive,
      { lockHeld: true }
    );
    if (mode === "crash-after-transcript") {
      await fs.writeFile(markerPath, JSON.stringify({ transcriptArchive }), "utf8");
      process.exit(86);
    }
    const modelArchive = await store.writeTranscriptChunks(
      sessionId,
      [message],
      current.metadata.transcript?.modelArchive,
      { suffix: "model-context", lockHeld: true }
    );
    await fs.writeFile(markerPath, JSON.stringify({ transcriptArchive, modelArchive }), "utf8");
    process.exit(86);
  });
} else {
  throw new Error(`Unknown worker mode: ${mode}`);
}

function appendPendingMessage(target, pending) {
  target.messages.push(pending);
  target.transcriptMessages.push(pending);
  target.transcriptArchive.pendingMessages.push(pending);
  target.modelContextArchive.pendingMessages.push(pending);
}

function waitForParentMessage(expected) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      process.off("message", onMessage);
      reject(new Error(`Timed out waiting for parent message '${expected}'`));
    }, 10_000);
    timeout.unref();
    const onMessage = (message) => {
      if (message === expected) {
        clearTimeout(timeout);
        process.off("message", onMessage);
        resolve();
      }
    };
    process.on("message", onMessage);
  });
}

function sendToParent(message) {
  return new Promise((resolve, reject) => {
    if (!process.send) {
      resolve();
      return;
    }
    process.send(message, (error) => error ? reject(error) : resolve());
  });
}
