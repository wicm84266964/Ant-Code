import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSession, persistSessionSnapshot, runSessionTurn } from "../../src/core/session.ts";
import { createSessionStore } from "../../src/storage/session-store.ts";
import {
  createRecordingGateway,
  messageText,
  createToolGateway,
  createLargeToolThenFinalGateway,
  createMalformedThenHealthyGateway,
  createReasoningOnlyLengthThenHealthyGateway,
  createAlwaysReasoningOnlyLengthGateway,
  createMissingTerminalThenHealthyGateway,
  createAlwaysMissingTerminalGateway,
  missingTerminalResponse,
  createRepetitiveThinkingThenHealthyGateway,
  createAlwaysRepetitiveThinkingGateway,
  createUsageGateway,
  createDelegationGuardGateway,
  createAgentRunGateway,
  createBackgroundAgentRunGateway,
  createParallelAgentRunGateway,
  createDuplicateTaskIdAgentRunGateway,
  createRepeatedToolGateway,
  createTodoSyncGateway,
  createOpenAIStreamingGateway,
  createIncompleteOpenAIThenHealthyGateway,
  createOpenAIDanglingToolCompactionGateway,
  findDanglingOpenAIToolMessage,
  createDeepSeekReasoningToolGateway,
  createResponsesReasoningToolGateway,
  createLongReasoningToolGateway,
  createReasoningOnlyOpenAIStreamingGateway,
  createSlowOpenAIStreamingGateway,
  createValidationGateway,
  readRequestJson,
  listen,
  close,
  waitFor,
  serverUrl,
  mockGatewayEnv,
  mockGatewayEnvWithoutModel
} from "./session-helpers.ts";

test("createSession can resume legacy bounded metadata without transcript text", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
  const store = createSessionStore({ cwd });
  await store.writeMetadata({
    id: "session-to-resume",
    startedAt: "2026-04-28T00:00:00.000Z",
    turnIndex: 4,
    prompt: "continue the TUI work",
    status: "completed",
    model: "mock-sonnet"
  });

  const session = await createSession({
    cwd,
    mode: "interactive",
    env: {},
    resume: "session-to-resume"
  });

  assert.equal(session.id, "session-to-resume");
  assert.equal(session.startedAt, "2026-04-28T00:00:00.000Z");
  assert.equal(session.turnCount, 4);
  assert.deepEqual(session.messages, []);
  assert.equal(session.resumedFrom.id, "session-to-resume");
  assert.equal(session.resumedFrom.prompt, "continue the TUI work");
  assert.equal(session.resumedFrom.status, "completed");
  assert.equal(session.resumedFrom.model, "mock-sonnet");
});

test("createSession restores bounded persisted conversation messages", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
  const store = createSessionStore({ cwd });
  await store.writeMetadata({
    id: "session-with-transcript",
    startedAt: "2026-04-28T00:00:00.000Z",
    turnIndex: 2,
    transcript: {
      version: 1,
      messages: [
        { role: "user", content: "previous prompt token=abc123" },
        { role: "assistant", content: [{ type: "text", text: "previous answer path=C:\\secret\\file.txt" }] }
      ],
      contextWindow: {
        summary: "Compacted earlier safe context",
        compactionCount: 1,
        compactedMessages: 2,
        lastCompactedAt: "2026-04-28T01:00:00.000Z",
        lastReason: "automatic"
      }
    }
  });

  const session = await createSession({
    cwd,
    mode: "interactive",
    env: {},
    resume: "session-with-transcript"
  });

  assert.equal(session.id, "session-with-transcript");
  assert.equal(session.turnCount, 2);
  assert.equal(session.messages.length, 2);
  assert.equal(session.transcriptMessages.length, 2);
  assert.equal(session.messages[0].content, "previous prompt token=[redacted]");
  assert.equal(session.messages[1].content[0].text, "previous answer path=C:\\secret\\file.txt");
  assert.equal(session.contextWindow.summary, "Compacted earlier safe context");
  assert.equal(session.contextWindow.compactionCount, 1);
  assert.equal(session.resumedFrom.messages.length, 2);
  assert.equal(session.resumedFrom.transcriptMessages.length, 2);
});

test("createSession restores only the latest transcript window separately from compacted model context", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
  const store = createSessionStore({ cwd });
  const messages = [];
  for (let index = 1; index <= 60; index += 1) {
    messages.push({ role: "user", content: `prompt ${index}` });
    messages.push({ role: "assistant", content: [{ type: "text", text: `answer ${index}` }] });
  }
  await store.writeMetadata({
    id: "session-with-full-transcript",
    startedAt: "2026-05-06T00:00:00.000Z",
    turnIndex: 60,
    transcript: {
      version: 1,
      messages,
      contextMessages: [
        { role: "user", content: "recent prompt" },
        { role: "assistant", content: [{ type: "text", text: "recent answer" }] }
      ],
      contextWindow: {
        summary: "Older context summary",
        compactionCount: 1,
        compactedMessages: 2
      }
    }
  });

  const session = await createSession({
    cwd,
    mode: "interactive",
    env: {},
    resume: "session-with-full-transcript"
  });

  assert.equal(session.messages.length, 2);
  assert.equal(session.messages[0].content, "recent prompt");
  assert.equal(session.transcriptMessages.length, 50);
  assert.equal(session.transcriptMessages[0].content, "prompt 36");
  assert.equal(session.transcriptMessages.at(-1).content[0].text, "answer 60");
  assert.equal(session.resumedFrom.messages.length, 2);
  assert.equal(session.resumedFrom.transcriptMessages.length, 50);
});

test("createSession repairs dangling assistant tool calls on resume", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
  const store = createSessionStore({ cwd });
  await store.writeMetadata({
    id: "session-with-dangling-tool-call",
    startedAt: "2026-05-08T00:00:00.000Z",
    turnIndex: 2,
    status: "interrupted",
    transcript: {
      version: 2,
      messages: [
        { role: "user", content: "fix settings" },
        {
          role: "assistant",
          interruptedDraft: true,
          content: [{ type: "text", text: "[中断草稿，非最终回复]\nI was about to run a tool." }]
        }
      ],
      contextMessages: [
        { role: "user", content: "fix settings" },
        {
          role: "assistant",
          content: [{ type: "text", text: "I should inspect settings." }],
          thinking: { text: "Need a file read.", bytes: 17 },
          toolCalls: [{ id: "call-dangling", name: "read_file", input: { path: "settings.py" } }]
        }
      ]
    }
  });

  const requests = [];
  const server = await listen(createRecordingGateway(requests), "127.0.0.1");
  try {
    const env = mockGatewayEnv(serverUrl(server));
    const session = await createSession({
      cwd,
      mode: "interactive",
      env,
      resume: "session-with-dangling-tool-call"
    });

    assert.equal(session.messages.length, 2);
    assert.equal(session.messages[1].role, "assistant");
    assert.equal(session.messages[1].toolCalls, undefined);
    assert.equal(session.messages[1].thinking.text, "Need a file read.");

    await runSessionTurn(session, {
      prompt: "continue safely",
      env
    });

    const dangling = requests[0].messages.find((message) => message.role === "assistant" && messageText(message).includes("I should inspect settings."));
    assert.ok(dangling);
    assert.equal(dangling.toolCalls, undefined);
    assert.equal(dangling.tool_calls, undefined);
    assert.equal(dangling.thinking.text, "Need a file read.");
  } finally {
    await close(server);
  }
});

test("session transcript archives complete history in 50-message chunks while memory keeps latest window", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
  const requests = [];
  const server = await listen(createRecordingGateway(requests), "127.0.0.1");

  try {
    const env = mockGatewayEnv(serverUrl(server));
    delete env.LAB_AGENT_TRANSCRIPT_ENABLED;
    const session = await createSession({
      cwd,
      mode: "interactive",
      env
    });

    for (let index = 1; index <= 31; index += 1) {
      await runSessionTurn(session, {
        prompt: `turn ${index}`,
        env
      });
    }

    assert.equal(session.transcriptMessages.length, 50);
    assert.equal(session.transcriptMessages[0].content, "turn 7");
    assert.equal(session.transcriptArchive.totalMessages, 62);
    assert.equal(session.transcriptArchive.chunks.length, 2);
    assert.equal(session.transcriptArchive.chunks[0].messages, 50);
    assert.equal(session.transcriptArchive.chunks[1].messages, 12);

    const metadataPath = path.join(cwd, ".lab-agent", "sessions", `${session.id}.json`);
    const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
    assert.equal(metadata.transcript.messages.length, 50);
    assert.equal(metadata.transcript.messages[0].content, "turn 7");
    assert.equal(metadata.transcript.contextMessages.length, 62);
    assert.equal(metadata.transcript.contextMessages[0].content, "turn 1");
    assert.equal(metadata.transcript.archive.totalMessages, 62);
    assert.equal(metadata.transcript.archive.chunks.length, 2);

    const firstChunk = JSON.parse(await fs.readFile(path.join(cwd, ".lab-agent", "sessions", metadata.transcript.archive.chunks[0].file), "utf8"));
    assert.equal(firstChunk.messages.length, 50);
    assert.equal(firstChunk.messages[0].content, "turn 1");
    assert.equal(firstChunk.messages[49].content[0].text, "assistant 25");

    metadata.transcript.contextMessages = metadata.transcript.contextMessages.slice(-50);
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), "utf8");

    const resumed = await createSession({
      cwd,
      mode: "interactive",
      env,
      resume: session.id
    });
    assert.equal(resumed.messages.length, 62);
    assert.equal(resumed.messages[0].content, "turn 1");
    assert.equal(resumed.transcriptMessages.length, 50);
    assert.equal(resumed.transcriptMessages[0].content, "turn 7");
    assert.equal(resumed.transcriptArchive.totalMessages, 62);
    assert.equal(resumed.transcriptArchive.chunks.length, 2);
    assert.equal(resumed.transcriptArchive.pendingMessages.length, 0);
  } finally {
    await close(server);
  }
});

test("session snapshot preserves pending archive messages after a failed metadata write and retries once", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-persist-retry-"));
  const env = {};
  const session = await createSession({ cwd, mode: "interactive", env });
  await runSessionTurn(session, { prompt: "seed metadata", env });

  const retryMessage = { role: "user", content: "persist exactly once after retry" };
  session.messages.push(retryMessage);
  session.transcriptMessages.push(retryMessage);
  session.transcriptArchive.pendingMessages.push(retryMessage);
  session.modelContextArchive.pendingMessages.push(retryMessage);
  const committedTranscriptTotal = session.transcriptArchive.totalMessages;
  const committedModelTotal = session.modelContextArchive.totalMessages;

  const store = createSessionStore({ cwd, transcript: session.config.transcript, env });
  const failingStore = {
    ...store,
    async writeMetadata() {
      throw Object.assign(new Error("injected metadata failure"), { code: "INJECTED_METADATA_FAILURE" });
    }
  };

  await assert.rejects(
    persistSessionSnapshot(session, { env, store: failingStore }),
    (error) => error?.code === "INJECTED_METADATA_FAILURE"
  );
  assert.equal(session.transcriptArchive.totalMessages, committedTranscriptTotal);
  assert.equal(session.modelContextArchive.totalMessages, committedModelTotal);
  assert.equal(session.transcriptArchive.pendingMessages.length, 1);
  assert.equal(session.modelContextArchive.pendingMessages.length, 1);

  await persistSessionSnapshot(session, { env, store });
  assert.equal(session.transcriptArchive.pendingMessages.length, 0);
  assert.equal(session.modelContextArchive.pendingMessages.length, 0);

  const saved = await store.readMetadataExact(session.id);
  const transcript = await store.readTranscriptPage(saved.metadata.transcript.archive, { limit: 200 });
  const modelContext = await store.readTranscriptPage(saved.metadata.transcript.modelArchive, { limit: 200 });
  assert.equal(saved.ok, true);
  assert.equal(transcript.ok, true);
  assert.equal(modelContext.ok, true);
  assert.equal(transcript.messages.filter((message) => message.content === retryMessage.content).length, 1);
  assert.equal(modelContext.messages.filter((message) => message.content === retryMessage.content).length, 1);
});

test("concurrent session snapshots rebase pending messages onto the latest committed archives", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-persist-concurrent-"));
  const env = {};
  const seed = await createSession({ cwd, mode: "interactive", env });
  await runSessionTurn(seed, { prompt: "seed concurrent archive", env });
  const baseTotal = seed.transcriptArchive.totalMessages;
  const left = await createSession({ cwd, mode: "interactive", env, resume: seed.id });
  const right = await createSession({ cwd, mode: "interactive", env, resume: seed.id });

  const appendPending = (session, content) => {
    const message = { role: "user", content };
    session.messages.push(message);
    session.transcriptMessages.push(message);
    session.transcriptArchive.pendingMessages.push(message);
    session.modelContextArchive.pendingMessages.push(message);
  };
  appendPending(left, "concurrent left message");
  appendPending(right, "concurrent right message");

  const leftStore = createSessionStore({ cwd, transcript: left.config.transcript, env });
  const rightStore = createSessionStore({ cwd, transcript: right.config.transcript, env });
  await Promise.all([
    persistSessionSnapshot(left, { env, store: leftStore }),
    persistSessionSnapshot(right, { env, store: rightStore })
  ]);

  const saved = await leftStore.readMetadataExact(seed.id);
  const transcript = await leftStore.readTranscriptPage(saved.metadata.transcript.archive, { limit: 200 });
  const modelContext = await leftStore.readTranscriptPage(saved.metadata.transcript.modelArchive, {
    limit: 200,
    visibleRoles: ["user", "assistant", "tool"]
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.metadata.transcript.archive.totalMessages, baseTotal + 2);
  assert.equal(saved.metadata.transcript.modelArchive.totalMessages, baseTotal + 2);
  assert.equal(transcript.messages.some((message) => message.content === "concurrent left message"), true);
  assert.equal(transcript.messages.some((message) => message.content === "concurrent right message"), true);
  assert.equal(modelContext.messages.some((message) => message.content === "concurrent left message"), true);
  assert.equal(modelContext.messages.some((message) => message.content === "concurrent right message"), true);
});

test("session model archive preserves tool-call context for resume after compaction", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
  await fs.writeFile(path.join(cwd, "notes.txt"), "important evidence from tool file", "utf8");
  await fs.writeFile(path.join(cwd, "lab-agent.config.json"), JSON.stringify({
    context: {
      maxMessages: 2,
      keepRecentMessages: 1,
      summaryBytes: 4096,
      resumeMaxMessages: 50,
      resumeMaxTokens: 200000,
      resumeMaxBytes: 1000000
    }
  }), "utf8");
  const requests = [];
  const server = await listen(createToolGateway(requests), "127.0.0.1");

  try {
    const env = mockGatewayEnv(serverUrl(server));
    delete env.LAB_AGENT_TRANSCRIPT_ENABLED;
    const session = await createSession({
      cwd,
      mode: "interactive",
      env
    });

    await runSessionTurn(session, {
      prompt: "read the evidence file",
      env
    });

    assert.ok(session.contextWindow.compactionCount > 0);
    assert.equal(session.messages.some((message) => message.role === "tool"), false);
    assert.equal(session.transcriptArchive.totalMessages, 2);
    assert.equal(session.modelContextArchive.totalMessages, 4);

    const metadataPath = path.join(cwd, ".lab-agent", "sessions", `${session.id}.json`);
    const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
    assert.equal(metadata.transcript.archive.totalMessages, 2);
    assert.equal(metadata.transcript.modelArchive.totalMessages, 4);
    assert.equal(metadata.transcript.contextMessages.some((message) => message.role === "tool"), false);

    const modelChunk = JSON.parse(await fs.readFile(path.join(cwd, ".lab-agent", "sessions", metadata.transcript.modelArchive.chunks[0].file), "utf8"));
    assert.deepEqual(modelChunk.messages.map((message) => message.role), ["user", "assistant", "tool", "assistant"]);
    assert.equal(modelChunk.messages[1].toolCalls[0].name, "read_file");
    assert.match(modelChunk.messages[2].content[0].text, /important evidence from tool file/);

    const resumed = await createSession({
      cwd,
      mode: "interactive",
      env,
      resume: session.id,
      resumeFullContext: true
    });

    assert.deepEqual(resumed.messages.map((message) => message.role), ["user", "assistant", "tool", "assistant"]);
    assert.equal(resumed.messages[1].toolCalls[0].id, "read-notes");
    assert.equal(resumed.messages[2].toolCallId, "read-notes");
    assert.match(resumed.messages[2].content[0].text, /important evidence from tool file/);
    assert.equal(resumed.resumedFrom.fullContextRestored, true);
  } finally {
    await close(server);
  }
});

test("resume merges legacy transcript base with newer model-context archive tail", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
  const store = createSessionStore({ cwd });
  const baseMessages = [
    { role: "user", content: "old prompt 1" },
    { role: "assistant", content: [{ type: "text", text: "old answer 1" }] },
    { role: "user", content: "new prompt with tools" },
    { role: "assistant", content: [{ type: "text", text: "visible answer without tool context" }] }
  ];
  const modelMessages = [
    { role: "user", content: "new prompt with tools" },
    {
      role: "assistant",
      content: [],
      toolCalls: [{ id: "read-new", name: "read_file", input: { path: "new.txt" } }]
    },
    {
      role: "tool",
      toolCallId: "read-new",
      name: "read_file",
      content: [{ type: "text", text: "{\"ok\":true,\"result\":{\"content\":\"new tool evidence\"}}" }]
    },
    { role: "assistant", content: [{ type: "text", text: "new answer with tool context" }] }
  ];
  const archive = await store.writeTranscriptChunks("mixed-archive-session", baseMessages);
  const modelArchive = await store.writeTranscriptChunks("mixed-archive-session", modelMessages, {}, { suffix: "model-context" });
  await store.writeMetadata({
    id: "mixed-archive-session",
    prompt: "new prompt with tools",
    title: "mixed archive",
    status: "completed",
    transcript: {
      version: 2,
      messages: baseMessages,
      contextMessages: baseMessages,
      archive,
      modelArchive
    }
  });

  const session = await createSession({
    cwd,
    mode: "interactive",
    env: {},
    resume: "mixed-archive-session",
    resumeFullContext: true
  });

  assert.deepEqual(session.messages.map((message) => message.role), ["user", "assistant", "user", "assistant", "tool", "assistant"]);
  assert.equal(session.messages[0].content, "old prompt 1");
  assert.equal(session.messages[3].toolCalls[0].id, "read-new");
  assert.equal(session.messages[4].toolCallId, "read-new");
  assert.match(session.messages[4].content[0].text, /new tool evidence/);
  assert.equal(session.messages[5].content[0].text, "new answer with tool context");
});

test("createSession restores archived context up to active context budget after resume", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
  await fs.writeFile(path.join(cwd, "lab-agent.config.json"), JSON.stringify({
    context: {
      maxMessages: 100000,
      maxBytes: 2000000,
      maxTokens: 500000,
      keepRecentMessages: 8,
      tailTurns: 2,
      preserveRecentTokens: 8000,
      summaryBytes: 65536,
      resumeMaxMessages: 200,
      resumeMaxTokens: 200000,
      resumeMaxBytes: 1000000
    }
  }), "utf8");
  const requests = [];
  const server = await listen(createRecordingGateway(requests), "127.0.0.1");

  try {
    const env = mockGatewayEnv(serverUrl(server));
    delete env.LAB_AGENT_TRANSCRIPT_ENABLED;
    const session = await createSession({
      cwd,
      mode: "interactive",
      env
    });

    for (let index = 1; index <= 153; index += 1) {
      await runSessionTurn(session, {
        prompt: `archive turn ${index}`,
        env
      });
    }

    assert.equal(session.transcriptArchive.totalMessages, 306);
    assert.equal(session.transcriptArchive.chunks.length, 7);

    const resumed = await createSession({
      cwd,
      mode: "interactive",
      env,
      resume: session.id
    });

    assert.equal(resumed.config.context.resumeMaxMessages, 100000);
    assert.equal(resumed.config.context.resumeMaxTokens, 500000);
    assert.equal(resumed.config.context.resumeMaxBytes, 2000000);
    assert.equal(resumed.messages.length, 306);
    assert.equal(resumed.messages[0].content, "archive turn 1");
    assert.equal(resumed.messages.at(-1).content[0].text, "assistant 153");
  } finally {
    await close(server);
  }
});

test("createSession can prefer full archive context for TUI resume without expanding visible transcript memory", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
  const store = createSessionStore({ cwd });
  const messages = [];
  for (let index = 1; index <= 60; index += 1) {
    messages.push({ role: "user", content: `tui prompt ${index}` });
    messages.push({ role: "assistant", content: [{ type: "text", text: `tui answer ${index}` }] });
  }
  const archive = await store.writeTranscriptChunks("tui-full-context-session", messages);
  await store.writeMetadata({
    id: "tui-full-context-session",
    prompt: "tui archived prompt",
    title: "tui archived prompt",
    status: "completed",
    transcript: {
      version: 2,
      messages: messages.slice(-50),
      contextMessages: messages.slice(-2),
      contextWindow: {
        summary: "Old TUI compact summary",
        compactionCount: 1,
        compactedMessages: 118
      },
      archive
    }
  });

  const session = await createSession({
    cwd,
    mode: "interactive",
    env: {},
    resume: "tui-full-context-session",
    resumeFullContext: true
  });

  assert.equal(session.messages.length, 120);
  assert.equal(session.messages[0].content, "tui prompt 1");
  assert.equal(session.messages.at(-1).content[0].text, "tui answer 60");
  assert.equal(session.transcriptMessages.length, 50);
  assert.equal(session.transcriptMessages[0].content, "tui prompt 36");
  assert.equal(session.contextWindow.summary, "");
  assert.equal(session.resumedFrom.fullContextRestored, true);
  assert.equal(session.resumedFrom.messages.length, 120);
  assert.equal(session.resumedFrom.transcriptMessages.length, 50);
});

test("createSession keeps compacted context when restored full archive would exceed prompt budget", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
  await fs.writeFile(path.join(cwd, "lab-agent.config.json"), JSON.stringify({
    context: {
      maxMessages: 100,
      maxBytes: 20000,
      maxTokens: 5000,
      keepRecentMessages: 2,
      summaryBytes: 4096,
      resumeMaxMessages: 100,
      resumeMaxTokens: 5000,
      resumeMaxBytes: 20000
    }
  }), "utf8");
  const store = createSessionStore({ cwd });
  const archiveMessages = [
    { role: "user", content: `large archived prompt ${"alpha ".repeat(900)}` },
    { role: "assistant", content: [{ type: "text", text: `large archived answer ${"beta ".repeat(900)}` }] }
  ];
  const compactedContextMessages = [
    { role: "user", content: "recent compacted prompt" },
    { role: "assistant", content: [{ type: "text", text: "recent compacted answer" }] }
  ];
  const archive = await store.writeTranscriptChunks("budget-limited-resume-session", archiveMessages);
  await store.writeMetadata({
    id: "budget-limited-resume-session",
    prompt: "recent compacted prompt",
    title: "budget limited resume",
    status: "completed",
    model: "mock-model",
    transcript: {
      version: 2,
      messages: compactedContextMessages,
      contextMessages: compactedContextMessages,
      contextWindow: {
        summary: "Compacted summary that must remain active after resume.",
        compactionCount: 1,
        compactedMessages: 2,
        lastReason: "automatic_prompt_budget"
      },
      archive
    }
  });

  const session = await createSession({
    cwd,
    mode: "interactive",
    env: {},
    resume: "budget-limited-resume-session",
    resumeFullContext: true
  });

  assert.deepEqual(session.messages.map((message) => message.role), ["user", "assistant"]);
  assert.equal(session.messages[0].content, "recent compacted prompt");
  assert.equal(session.contextWindow.summary, "Compacted summary that must remain active after resume.");
  assert.equal(session.contextWindow.compactionCount, 1);
  assert.equal(session.resumedFrom.fullContextRestored, false);
  assert.equal(session.resumedFrom.fullContextRestoreLimited, true);
  assert.equal(session.resumedFrom.fullContextRestoreLimitReason, "restored_full_context_over_budget");
});

test("createSession cleans legacy raw OpenAI stream dumps on resume", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
  const store = createSessionStore({ cwd });
  const rawDump = JSON.stringify({
    id: "legacy-raw",
    model: "mimo-v2.5-pro",
    content: [],
    text: "",
    toolCalls: [],
    raw: `data: {"object":"chat.completion.chunk","choices":[{"delta":{"reasoning_content":"${"旧正文".repeat(3000)}"}}]}`
  }, null, 2);

  await store.writeMetadata({
    id: "session-with-raw-dump",
    startedAt: "2026-05-01T00:00:00.000Z",
    turnIndex: 1,
    transcript: {
      version: 1,
      messages: [
        { role: "user", content: "trigger legacy dump" },
        { role: "assistant", content: [{ type: "text", text: rawDump }] }
      ]
    }
  });

  const session = await createSession({
    cwd,
    mode: "interactive",
    env: {},
    resume: "session-with-raw-dump"
  });

  const restoredText = session.messages[1].content[0].text;
  assert.match(restoredText, /旧版本保存的 OpenAI 兼容网关原始响应/);
  assert.doesNotMatch(restoredText, /chat\.completion\.chunk/);
  assert.doesNotMatch(restoredText, /旧正文旧正文/);
});

/**
 * @param {Array<Record<string, any>>} requests
 */

test("session hydrates and persists Goal metadata", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "session-goal-hydrate-"));
  const server = await listen(createRecordingGateway([]), "127.0.0.1");
  const { enableGoalState } = await import("../../src/core/goal.ts");
  try {
    const env = mockGatewayEnv(serverUrl(server));
    env.LAB_AGENT_TRANSCRIPT_ENABLED = "true";
    const session = await createSession({ cwd, mode: "interactive", env, fullAccess: true });
    await runSessionTurn(session, { prompt: "seed", env });
    session.goal = enableGoalState({ text: "finish filters", previousPermissionMode: "workspace" });
    await persistSessionSnapshot(session, { env });
    const resumed = await createSession({ cwd, mode: "interactive", env, resume: session.id, resumeFullContext: true });
    assert.equal(resumed.goal.enabled, true);
    assert.equal(resumed.goal.text, "finish filters");
    assert.equal(resumed.goal.previousPermissionMode, "workspace");
    assert.equal(Boolean(resumed.goal.startedAt), true);
    assert.equal(resumed.goal.usageBaseline?.promptTokens, 0);
  } finally {
    await close(server);
  }
});

test("Goal snapshot can create session metadata before the first turn", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "session-goal-bootstrap-"));
  const server = await listen(createRecordingGateway([]), "127.0.0.1");
  const { enableGoalState } = await import("../../src/core/goal.ts");
  try {
    const env = mockGatewayEnv(serverUrl(server));
    env.LAB_AGENT_TRANSCRIPT_ENABLED = "true";
    const session = await createSession({ cwd, mode: "interactive", env, fullAccess: true });
    session.goal = enableGoalState({ text: "bootstrap goal file", previousPermissionMode: "plan" });
    await persistSessionSnapshot(session, { env, requireExisting: false });
    const resumed = await createSession({ cwd, mode: "interactive", env, resume: session.id, resumeFullContext: true });
    assert.equal(resumed.goal.enabled, true);
    assert.equal(resumed.goal.text, "bootstrap goal file");
  } finally {
    await close(server);
  }
});

test("Goal sessions skip verbal workflow sync and strip GOAL_STATUS from transcript", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "session-goal-strip-"));
  const requests = [];
  const server = await listen(http.createServer(async (request, response) => {
    const body = await readRequestJson(request);
    requests.push(body);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "goal-strip",
      model: body.model,
      content: [{ type: "text", text: "任务已完成\nGOAL_STATUS: complete\nEVIDENCE: none\nGAPS:\n" }],
      toolCalls: [],
      stopReason: "stop"
    }));
  }), "127.0.0.1");
  const { enableGoalState } = await import("../../src/core/goal.ts");
  try {
    const env = mockGatewayEnv(serverUrl(server));
    env.LAB_AGENT_TRANSCRIPT_ENABLED = "true";
    const session = await createSession({ cwd, mode: "interactive", env, fullAccess: true });
    session.workflow.todos = [{ id: "1", content: "still pending", status: "pending" }];
    session.goal = enableGoalState({ text: "do not fake complete", previousPermissionMode: "plan" });
    await runSessionTurn(session, { prompt: "are we done?", env });
    assert.equal(session.workflow.todos[0].status, "pending");
    const assistantTranscript = session.transcriptMessages.find((message) => message.role === "assistant");
    const transcriptText = Array.isArray(assistantTranscript?.content)
      ? assistantTranscript.content.map((item) => item.text ?? "").join("")
      : String(assistantTranscript?.content ?? "");
    assert.doesNotMatch(transcriptText, /GOAL_STATUS:/);
    const assistantContext = session.messages.find((message) => message.role === "assistant");
    const contextText = Array.isArray(assistantContext?.content)
      ? assistantContext.content.map((item) => item.text ?? "").join("")
      : String(assistantContext?.content ?? "");
    assert.match(contextText, /GOAL_STATUS: complete/);
  } finally {
    await close(server);
  }
});
