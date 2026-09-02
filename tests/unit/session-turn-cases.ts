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

test("interactive session turns reuse bounded conversation context", async () => {
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

    const first = await runSessionTurn(session, {
      prompt: "first",
      env
    });
    const second = await runSessionTurn(session, {
      prompt: "second",
      env
    });

    assert.equal(first.session, session);
    assert.equal(second.session, session);
    assert.equal(session.turnCount, 2);
    assert.equal(session.messages.length, 4);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0].messages.map((message) => message.role), ["system", "user"]);
    assert.match(requests[0].messages[0].content[0].text, /Behavior protocol/);
    assert.deepEqual(requests[1].messages.map((message) => message.role), ["system", "user", "assistant", "user"]);
    assert.equal(requests[1].messages[1].content, "first");
    assert.equal(requests[1].messages[2].content[0].text, "assistant 1");
    assert.equal(requests[1].messages[3].content, "second");
  } finally {
    await close(server);
  }
});

test("session image attachments reach a vision-capable main model but persist as redacted metadata", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
  await fs.writeFile(path.join(cwd, "lab-agent.config.json"), JSON.stringify({
    modelAlias: "vision-model",
    models: [
      { id: "vision-model", modalities: ["text", "image"] }
    ]
  }), "utf8");
  const requests = [];
  const server = await listen(createRecordingGateway(requests), "127.0.0.1");

  try {
    const env = {
      ...mockGatewayEnvWithoutModel(serverUrl(server)),
      LAB_AGENT_TRANSCRIPT_ENABLED: "true"
    };
    const session = await createSession({
      cwd,
      mode: "interactive",
      env
    });

    await runSessionTurn(session, {
      prompt: "what is in this image?",
      attachments: [{
        type: "image",
        name: "tiny.png",
        mimeType: "image/png",
        size: 5,
        data: "aGVsbG8="
      }],
      env
    });

    const userMessage = requests[0].messages.find((message) => message.role === "user");
    assert.equal(userMessage.content.some((block) => block.type === "image" && block.data === "aGVsbG8="), true);
    assert.equal(session.messages[0].content.some((block) => block.type === "image" && block.redacted === true), true);

    const sessionFile = path.join(cwd, ".lab-agent", "sessions", `${session.id}.json`);
    const metadata = JSON.parse(await fs.readFile(sessionFile, "utf8"));
    assert.equal(JSON.stringify(metadata).includes("aGVsbG8="), false);
    assert.equal(metadata.transcript.messages[0].content.some((block) => block.type === "image" && block.redacted === true), true);
  } finally {
    await close(server);
  }
});

test("session uses same-gateway vision agent when main model is text-only", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
  await fs.writeFile(path.join(cwd, "lab-agent.config.json"), JSON.stringify({
    modelAlias: "text-model",
    models: [
      { id: "text-model", label: "Text Model", modalities: ["text"] },
      { id: "vision-model", label: "Vision Model", modalities: ["text", "image"] }
    ],
    agents: {
      vision: {
        enabled: true,
        model: "vision-model",
        autoUseWhenMainModelTextOnly: true
      }
    }
  }), "utf8");
  const requests = [];
  const server = await listen(createRecordingGateway(requests), "127.0.0.1");

  try {
    const env = mockGatewayEnvWithoutModel(serverUrl(server));
    const session = await createSession({
      cwd,
      mode: "interactive",
      env
    });

    await runSessionTurn(session, {
      prompt: "summarize the screenshot",
      attachments: [{
        type: "image",
        name: "screen.png",
        mimeType: "image/png",
        size: 5,
        data: "aGVsbG8="
      }],
      env
    });

    const visionRequest = requests.find((request) => request.model === "vision-model");
    const textRequest = requests.find((request) => request.model === "text-model");
    assert.ok(visionRequest);
    assert.ok(textRequest);
    assert.equal(visionRequest.messages.some((message) => message.content?.some?.((block) => block.type === "image")), true);
    assert.match(visionRequest.messages[0].content.find((block) => block.type === "text")?.text ?? "", /visual-verifier/);
    assert.match(visionRequest.messages[0].content.find((block) => block.type === "text")?.text ?? "", /visualEvidence/);
    const finalUserMessage = textRequest.messages.findLast((message) => message.role === "user");
    assert.equal(finalUserMessage.content.some((block) => block.type === "image"), false);
    assert.match(finalUserMessage.content.map((block) => block.text ?? "").join("\n"), /visual-verifier 视觉子智能体预分析/);
    assert.equal(session.messages[0].content.some((block) => block.type === "image" && block.redacted === true), true);
  } finally {
    await close(server);
  }
});

test("session blocks image attachments when no same-gateway vision model exists", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
  await fs.writeFile(path.join(cwd, "lab-agent.config.json"), JSON.stringify({
    modelAlias: "deepseek-text",
    models: [
      { id: "deepseek-text", label: "DeepSeek Text", modalities: ["text"] },
      { id: "deepseek-flash", label: "DeepSeek Flash", modalities: ["text"] }
    ]
  }), "utf8");
  const requests = [];
  const server = await listen(createRecordingGateway(requests), "127.0.0.1");

  try {
    const env = mockGatewayEnvWithoutModel(serverUrl(server));
    const session = await createSession({
      cwd,
      mode: "interactive",
      env
    });

    const result = await runSessionTurn(session, {
      prompt: "describe image",
      attachments: [{
        type: "image",
        name: "screen.png",
        mimeType: "image/png",
        size: 5,
        data: "aGVsbG8="
      }],
      env
    });

    assert.equal(requests.length, 0);
    assert.match(result.output, /当前主模型不支持图片输入/);
    assert.match(result.output, /不会跨网关调用其他厂商模型/);
    assert.equal(session.messages.length, 0);
  } finally {
    await close(server);
  }
});

test("session context persists bounded redacted transcript for resume", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
  await fs.writeFile(path.join(cwd, "lab-agent.config.json"), JSON.stringify({
    context: {
      maxMessages: 4,
      keepRecentMessages: 2,
      summaryBytes: 4096
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

    await runSessionTurn(session, {
      prompt: "first turn token=super-secret path=C:\\secret-project\\paper.txt",
      env
    });
    await runSessionTurn(session, {
      prompt: "second turn",
      env
    });
    await runSessionTurn(session, {
      prompt: "third turn",
      env
    });
    await runSessionTurn(session, {
      prompt: "fourth turn",
      env
    });

    assert.equal(session.messages.length, 4);
    assert.equal(session.contextWindow.compactionCount, 2);
    assert.equal(session.contextWindow.compactedMessages, 4);
    assert.equal(session.contextWindow.lastStrategy, "agent:compaction");
    assert.equal(session.contextWindow.lastInternalAgent, "compaction");
    assert.match(session.contextWindow.summary, /Model compacted summary/);
    assert.doesNotMatch(session.contextWindow.summary, /super-secret/);

    assert.equal(requests.length, 6);
    assert.match(requests[3].messages[0].content[0].text, /context compactor/);
    assert.doesNotMatch(requests[3].messages[1].content, /super-secret/);
    assert.match(requests[3].messages[1].content, /path=C:\\secret-project\\paper\.txt/);
    assert.match(requests[5].messages[0].content[0].text, /context compactor/);
    assert.deepEqual(requests[4].messages.map((message) => message.role), ["system", "system", "user", "assistant", "user", "assistant", "user"]);
    const compactedContext = requests[4].messages[1].content[0].text;
    assert.match(compactedContext, /compacted conversation context/);
    assert.match(compactedContext, /first turn/);
    assert.doesNotMatch(compactedContext, /super-secret/);

    const metadataPath = path.join(cwd, ".lab-agent", "sessions", `${session.id}.json`);
    const metadataText = await fs.readFile(metadataPath, "utf8");
    const metadata = JSON.parse(metadataText);
    assert.equal(metadata.context.messages, 4);
    assert.equal(metadata.context.compacted, 2);
    assert.equal(metadata.context.hasSummary, true);
    assert.equal(metadata.transcript.messages.length, 8);
    assert.equal(metadata.transcript.contextMessages.length, 4);
    assert.equal(metadata.transcript.archive.totalMessages, 8);
    assert.equal(metadata.transcript.archive.chunks.length, 1);
    assert.match(metadataText, /first turn/);
    assert.match(metadataText, /second turn/);
    assert.match(metadataText, /third turn/);
    assert.match(metadataText, /fourth turn/);
    assert.match(metadataText, /assistant 5/);
    assert.doesNotMatch(metadataText, /super-secret|compacted conversation context/);
    assert.match(metadataText, /path=C:\\\\secret-project\\\\paper\.txt/);

    const resumed = await createSession({
      cwd,
      mode: "interactive",
      env,
      resume: session.id
    });
    assert.equal(resumed.messages.length, 4);
    assert.equal(resumed.transcriptMessages.length, 8);
    assert.match(resumed.transcriptMessages[0].content, /first turn/);
    assert.match(resumed.transcriptMessages[0].content, /path=C:\\secret-project\\paper\.txt/);
  } finally {
    await close(server);
  }
});

test("session compacts before gateway request when full prompt payload exceeds token budget", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
  await fs.writeFile(path.join(cwd, "lab-agent.config.json"), JSON.stringify({
    context: {
      maxMessages: 100,
      maxTokens: 50000,
      promptCompactRatio: 0.01,
      keepRecentMessages: 2,
      summaryBytes: 4096
    }
  }), "utf8");
  const requests = [];
  const events = [];
  const server = await listen(createRecordingGateway(requests), "127.0.0.1");

  try {
    const env = mockGatewayEnv(serverUrl(server));
    delete env.LAB_AGENT_TRANSCRIPT_ENABLED;
    const session = await createSession({
      cwd,
      mode: "interactive",
      env
    });
    session.messages = [
      { role: "user", content: "older context " + "alpha ".repeat(80) },
      { role: "assistant", content: [{ type: "text", text: "older answer " + "beta ".repeat(80) }] },
      { role: "user", content: "recent question" },
      { role: "assistant", content: [{ type: "text", text: "recent answer" }] }
    ];

    await runSessionTurn(session, {
      prompt: "continue after large prompt",
      env,
      onEvent: (event) => events.push(event)
    });

    assert.equal(session.contextWindow.compactionCount, 1);
    assert.equal(session.contextWindow.lastReason, "automatic_prompt_budget");
    assert.equal(session.contextWindow.lastStrategy, "agent:compaction");
    assert.match(requests[0].messages[0].content[0].text, /context compactor/);
    assert.ok(requests[1].messages.some((message) => String(message.content?.[0]?.text ?? "").includes("compacted conversation context")));
    const compactEvent = events.find((event) => event.type === "context_compacted");
    assert.equal(compactEvent?.reason, "automatic_prompt_budget");
    assert.ok(compactEvent.beforeTokens > compactEvent.afterTokens);
  } finally {
    await close(server);
  }
});

test("session keeps current-turn images after automatic prompt compaction", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
  await fs.writeFile(path.join(cwd, "lab-agent.config.json"), JSON.stringify({
    modelAlias: "vision-model",
    models: [
      { id: "vision-model", modalities: ["text", "image"] }
    ],
    context: {
      maxMessages: 100,
      maxTokens: 50000,
      promptCompactRatio: 0.01,
      keepRecentMessages: 2,
      summaryBytes: 4096
    }
  }), "utf8");
  const requests = [];
  const events = [];
  const server = await listen(createRecordingGateway(requests), "127.0.0.1");

  try {
    const env = mockGatewayEnvWithoutModel(serverUrl(server));
    delete env.LAB_AGENT_TRANSCRIPT_ENABLED;
    const session = await createSession({
      cwd,
      mode: "interactive",
      env
    });
    session.messages = [
      { role: "user", content: "older context " + "alpha ".repeat(80) },
      { role: "assistant", content: [{ type: "text", text: "older answer " + "beta ".repeat(80) }] },
      { role: "user", content: "recent question" },
      { role: "assistant", content: [{ type: "text", text: "recent answer" }] }
    ];

    await runSessionTurn(session, {
      prompt: "what is in this image?",
      attachments: [{
        type: "image",
        name: "shot.png",
        mimeType: "image/png",
        size: 5,
        data: "aGVsbG8="
      }],
      env,
      onEvent: (event) => events.push(event)
    });

    const finalRequest = requests.at(-1);
    const userMessage = finalRequest.messages.findLast((message) => message.role === "user");
    assert.equal(userMessage.content.some((block) => block.type === "image" && block.data === "aGVsbG8="), true);
    assert.ok(events.some((event) => event.type === "context_compacted" && event.reason === "automatic_prompt_budget"));
  } finally {
    await close(server);
  }
});

test("session does not compact before the configured context window is reached by default", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
  await fs.writeFile(path.join(cwd, "lab-agent.config.json"), JSON.stringify({
    context: {
      maxMessages: 100,
      maxTokens: 20000,
      keepRecentMessages: 2,
      summaryBytes: 4096
    }
  }), "utf8");
  const requests = [];
  const events = [];
  const server = await listen(createRecordingGateway(requests), "127.0.0.1");

  try {
    const env = mockGatewayEnv(serverUrl(server));
    delete env.LAB_AGENT_TRANSCRIPT_ENABLED;
    const session = await createSession({
      cwd,
      mode: "interactive",
      env
    });
    session.messages = [
      { role: "user", content: "older context " + "alpha ".repeat(3200) },
      { role: "assistant", content: [{ type: "text", text: "older answer " + "beta ".repeat(3200) }] },
      { role: "user", content: "recent question" },
      { role: "assistant", content: [{ type: "text", text: "recent answer" }] }
    ];

    await runSessionTurn(session, {
      prompt: "continue before full context",
      env,
      onEvent: (event) => events.push(event)
    });

    assert.equal(session.contextWindow.compactionCount, 0);
    assert.equal(events.some((event) => event.type === "context_compacted"), false);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].messages.some((message) => String(message.content?.[0]?.text ?? "").includes("context compactor")), false);
  } finally {
    await close(server);
  }
});

test("OpenAI-compatible prompt compaction drops leading orphan tool messages", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
  await fs.writeFile(path.join(cwd, "lab-agent.config.json"), JSON.stringify({
    modelAlias: "mock-openai",
    models: [{ id: "mock-openai", contextTokens: 50000 }],
    context: {
      maxTokens: 50000,
      promptCompactRatio: 0.01,
      keepRecentMessages: 5,
      tailTurns: 1,
      preserveRecentTokens: 1,
      summaryBytes: 4096
    }
  }), "utf8");
  const requests = [];
  const server = await listen(createOpenAIDanglingToolCompactionGateway(requests), "127.0.0.1");

  try {
    const env = {
      LAB_MODEL_GATEWAY_URL: `${serverUrl(server)}/v1/chat/completions`,
      LAB_AGENT_MODEL: "mock-openai",
      LAB_AGENT_NETWORK_MODE: "offline",
      LAB_AGENT_TRANSCRIPT_ENABLED: "false",
      LAB_MODEL_GATEWAY_PROTOCOL: "openai-chat"
    };
    const session = await createSession({
      cwd,
      mode: "interactive",
      env
    });
    session.messages = [
      { role: "user", content: `older prompt ${"alpha ".repeat(80)}` },
      { role: "assistant", content: [{ type: "text", text: `older answer ${"beta ".repeat(80)}` }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "orphaned tool request" }],
        toolCalls: [{ id: "orphan-call", name: "powershell", input: { command: "Get-Date" } }]
      },
      {
        role: "tool",
        name: "powershell",
        toolCallId: "orphan-call",
        content: [{ type: "text", text: "{\"ok\":true,\"result\":\"orphan output\"}" }]
      },
      { role: "assistant", content: [{ type: "text", text: "orphan output consumed" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "kept tool request" }],
        toolCalls: [{ id: "kept-call", name: "read_file", input: { path: "notes.txt" } }]
      },
      {
        role: "tool",
        name: "read_file",
        toolCallId: "kept-call",
        content: [{ type: "text", text: "{\"ok\":true,\"result\":\"kept output\"}" }]
      },
      { role: "assistant", content: [{ type: "text", text: "kept output consumed" }] }
    ];

    const result = await runSessionTurn(session, {
      prompt: "continue after compacted tool context",
      env
    });

    assert.match(result.output, /after compaction accepted/);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].messages.some((message) => String(message.content ?? "").includes("context compactor")), true);
    const finalRequest = requests[1];
    assert.equal(finalRequest.messages.some((message) => message.role === "tool" && message.tool_call_id === "orphan-call"), false);
    const keptToolIndex = finalRequest.messages.findIndex((message) => message.role === "tool" && message.tool_call_id === "kept-call");
    assert.ok(keptToolIndex > 0);
    assert.equal(finalRequest.messages[keptToolIndex - 1].role, "assistant");
    assert.equal(finalRequest.messages[keptToolIndex - 1].tool_calls?.[0]?.id, "kept-call");
  } finally {
    await close(server);
  }
});

test("OpenAI-compatible prompt repair drops partially returned tool blocks", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
  await fs.writeFile(path.join(cwd, "lab-agent.config.json"), JSON.stringify({
    modelAlias: "mock-openai",
    models: [{ id: "mock-openai", contextTokens: 50000 }],
    context: {
      maxTokens: 50000,
      keepRecentMessages: 10,
      tailTurns: 2,
      preserveRecentTokens: 4000,
      summaryBytes: 4096
    }
  }), "utf8");
  const requests = [];
  const server = await listen(createOpenAIDanglingToolCompactionGateway(requests), "127.0.0.1");

  try {
    const env = {
      LAB_MODEL_GATEWAY_URL: `${serverUrl(server)}/v1/chat/completions`,
      LAB_AGENT_MODEL: "mock-openai",
      LAB_AGENT_NETWORK_MODE: "offline",
      LAB_AGENT_TRANSCRIPT_ENABLED: "false",
      LAB_MODEL_GATEWAY_PROTOCOL: "openai-chat"
    };
    const session = await createSession({
      cwd,
      mode: "interactive",
      env
    });
    session.messages = [
      { role: "user", content: "continue from partial tool history" },
      {
        role: "assistant",
        content: [{ type: "text", text: "I requested two tools." }],
        toolCalls: [
          { id: "partial-a", name: "read_file", input: { path: "a.txt" } },
          { id: "partial-b", name: "read_file", input: { path: "b.txt" } }
        ]
      },
      {
        role: "tool",
        name: "read_file",
        toolCallId: "partial-a",
        content: [{ type: "text", text: "{\"ok\":true,\"result\":\"only one tool returned\"}" }]
      },
      { role: "assistant", content: [{ type: "text", text: "I can continue safely without resending the broken tool chain." }] }
    ];

    const result = await runSessionTurn(session, {
      prompt: "continue after partial tool chain",
      env
    });

    assert.match(result.output, /after compaction accepted/);
    assert.equal(requests.length, 1);
    const finalRequest = requests[0];
    assert.equal(finalRequest.messages.some((message) => message.role === "tool" && message.tool_call_id === "partial-a"), false);
    const partialAssistant = finalRequest.messages.find((message) => message.role === "assistant" && String(message.content ?? "").includes("I requested two tools."));
    assert.ok(partialAssistant);
    assert.equal(partialAssistant.tool_calls, undefined);
  } finally {
    await close(server);
  }
});

test("session compactes oversized in-flight tool results before later gateway rounds", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
  await fs.writeFile(path.join(cwd, "lab-agent.config.json"), JSON.stringify({
    context: {
      maxTokens: 200000,
      promptCompactRatio: 0.01,
      inFlightKeepRecentTools: 0
    }
  }), "utf8");
  await fs.writeFile(path.join(cwd, "large.txt"), "large tool output ".repeat(1200), "utf8");
  const requests = [];
  const events = [];
  const server = await listen(createLargeToolThenFinalGateway(requests), "127.0.0.1");

  try {
    const env = mockGatewayEnv(serverUrl(server));
    delete env.LAB_AGENT_TRANSCRIPT_ENABLED;
    const session = await createSession({
      cwd,
      mode: "interactive",
      env
    });

    const result = await runSessionTurn(session, {
      prompt: "read large file",
      env,
      onEvent: (event) => events.push(event)
    });

    assert.equal(result.output, "large result consumed");
    assert.equal(requests.length, 2);
    const toolMessage = requests[1].messages.find((message) => message.role === "tool");
    const toolText = Array.isArray(toolMessage.content)
      ? toolMessage.content.map((item) => item.text ?? "").join("")
      : String(toolMessage.content ?? "");
    assert.match(toolText, /\[compacted tool result\]/);
    assert.match(toolText, /large tool output/);
    assert.equal(events.some((event) => event.type === "context_compacted" && event.strategy === "inflight-tools"), true);
  } finally {
    await close(server);
  }
});

test("session does not send a gateway request that remains over the context window", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
  await fs.writeFile(path.join(cwd, "lab-agent.config.json"), JSON.stringify({
    context: {
      maxTokens: 8,
      maxBytes: 32,
      promptCompactRatio: 1
    }
  }), "utf8");
  const requests = [];
  const events = [];
  const server = await listen(createRecordingGateway(requests), "127.0.0.1");

  try {
    const env = mockGatewayEnv(serverUrl(server));
    delete env.LAB_AGENT_TRANSCRIPT_ENABLED;
    const session = await createSession({
      cwd,
      mode: "interactive",
      env
    });

    const result = await runSessionTurn(session, {
      prompt: "this prompt cannot fit the configured window",
      env,
      onEvent: (event) => events.push(event)
    });

    assert.equal(requests.length, 0);
    assert.match(String(result.output), /仍超过上下文窗口/);
    assert.equal(events.some((event) => event.type === "context_overflow"), true);
    assert.equal(events.some((event) => event.type === "turn_complete" && event.status === "context_overflow"), true);
    assert.equal(events.some((event) => event.type === "gateway_request_start"), false);
  } finally {
    await close(server);
  }
});

test("session does not retry malformed final output while output health check is disabled", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
  const requests = [];
  const events = [];
  const server = await listen(createMalformedThenHealthyGateway(requests), "127.0.0.1");

  try {
    const env = mockGatewayEnv(serverUrl(server));
    delete env.LAB_AGENT_TRANSCRIPT_ENABLED;
    const session = await createSession({
      cwd,
      mode: "interactive",
      env
    });

    const result = await runSessionTurn(session, {
      prompt: "verify current work",
      env,
      onEvent: (event) => events.push(event)
    });

    assert.equal(result.output, "Ver");
    assert.equal(requests.length, 1);
    assert.equal(events.some((event) => event.type === "output_health_retry"), false);
  } finally {
    await close(server);
  }
});

test("session retries reasoning-only length final output even when generic health check is disabled", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
  const requests = [];
  const events = [];
  const server = await listen(createReasoningOnlyLengthThenHealthyGateway(requests), "127.0.0.1");

  try {
    const env = mockGatewayEnv(serverUrl(server));
    delete env.LAB_AGENT_TRANSCRIPT_ENABLED;
    const session = await createSession({
      cwd,
      mode: "interactive",
      env
    });

    const result = await runSessionTurn(session, {
      prompt: "summarize the long task",
      env,
      onEvent: (event) => events.push(event)
    });

    assert.equal(result.output, "总结完成：已根据当前上下文给出用户可见正文。");
    assert.equal(requests.length, 2);
    assert.equal(events.some((event) => event.type === "output_health_retry"), true);
    assert.equal(events.find((event) => event.type === "output_health_retry").reasons.includes("reasoning_only_length"), true);
    assert.deepEqual(result.session.resumedFrom, null);
  } finally {
    await close(server);
  }
});

test("session retries normalized empty responses without a terminal signal", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
  const requests = [];
  const events = [];
  const server = await listen(createMissingTerminalThenHealthyGateway(requests), "127.0.0.1");

  try {
    const env = mockGatewayEnv(serverUrl(server));
    delete env.LAB_AGENT_TRANSCRIPT_ENABLED;
    const session = await createSession({
      cwd,
      mode: "interactive",
      env
    });

    const result = await runSessionTurn(session, {
      prompt: "continue after the interrupted response",
      env,
      onEvent: (event) => events.push(event)
    });

    assert.equal(result.output, "恢复完成：已返回完整正文。");
    assert.equal(requests.length, 2);
    const retry = events.find((event) => event.type === "output_health_retry");
    assert.equal(retry?.reasons.includes("missing_terminal_signal"), true);
    assert.equal(JSON.stringify(requests[1]).includes("模型本轮没有返回可展示正文"), false);
  } finally {
    await close(server);
  }
});

test("session reports gateway_error after normalized missing terminal retries are exhausted", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
  const requests = [];
  const events = [];
  const server = await listen(createAlwaysMissingTerminalGateway(requests), "127.0.0.1");
  const env = mockGatewayEnv(serverUrl(server));
  const transcriptEnabled = env.LAB_AGENT_TRANSCRIPT_ENABLED;
  env.LAB_AGENT_TRANSCRIPT_ENABLED = "true";

  try {
    const session = await createSession({
      cwd,
      mode: "interactive",
      env
    });

    const result = await runSessionTurn(session, {
      prompt: "do not accept an incomplete response",
      env,
      onEvent: (event) => events.push(event)
    });

    assert.equal(requests.length, 2);
    assert.match(result.output, /UPSTREAM_STREAM_ABORTED/);
    assert.equal(events.filter((event) => event.type === "output_health_retry").length, 1);
    assert.equal(events.some((event) => event.type === "assistant_final"), false);
    assert.equal(events.find((event) => event.type === "gateway_error")?.error?.code, "UPSTREAM_STREAM_ABORTED");
    assert.equal(events.find((event) => event.type === "turn_complete")?.status, "gateway_error");

    const metadataPath = path.join(cwd, ".lab-agent", "sessions", `${session.id}.json`);
    const metadataText = await fs.readFile(metadataPath, "utf8");
    const metadata = JSON.parse(metadataText);
    assert.equal(metadata.status, "gateway_error");
    assert.equal(metadata.gatewayErrors.includes("UPSTREAM_STREAM_ABORTED"), true);
    assert.equal(metadataText.includes("模型本轮没有返回可展示正文"), false);
  } finally {
    if (transcriptEnabled === undefined) {
      delete env.LAB_AGENT_TRANSCRIPT_ENABLED;
    } else {
      env.LAB_AGENT_TRANSCRIPT_ENABLED = transcriptEnabled;
    }
    try {
      await close(server);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  }
});

test("session retries repetitive thinking loops even when generic health check is disabled", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
  const requests = [];
  const events = [];
  const server = await listen(createRepetitiveThinkingThenHealthyGateway(requests), "127.0.0.1");

  try {
    const env = mockGatewayEnv(serverUrl(server));
    delete env.LAB_AGENT_TRANSCRIPT_ENABLED;
    const session = await createSession({
      cwd,
      mode: "interactive",
      env
    });

    const result = await runSessionTurn(session, {
      prompt: "finish the changelog update",
      env,
      onEvent: (event) => events.push(event)
    });

    assert.equal(result.output, "已跳出重复思考并给出最终正文。");
    assert.equal(requests.length, 2);
    assert.equal(events.find((event) => event.type === "output_health_retry").reasons.includes("repetitive_thinking_loop"), true);
  } finally {
    await close(server);
  }
});

for (const scenario of [
  {
    name: "reasoning-only length",
    reason: "reasoning_only_length",
    createGateway: createAlwaysReasoningOnlyLengthGateway
  },
  {
    name: "repetitive thinking",
    reason: "repetitive_thinking_loop",
    createGateway: createAlwaysRepetitiveThinkingGateway
  }
]) {
  test(`session preserves ${scenario.name} diagnosis when output-health retries are exhausted`, async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
    const requests = [];
    const events = [];
    const server = await listen(scenario.createGateway(requests), "127.0.0.1");

    try {
      const env = mockGatewayEnv(serverUrl(server));
      const session = await createSession({ cwd, mode: "interactive", env });
      const result = await runSessionTurn(session, {
        prompt: "preserve the real output-health failure reason",
        env,
        onEvent: (event) => events.push(event)
      });

      const gatewayError = events.find((event) => event.type === "gateway_error")?.error;
      assert.equal(requests.length, 2);
      assert.match(result.output, /UPSTREAM_STREAM_ABORTED/);
      assert.equal(gatewayError?.details?.reason, scenario.reason);
      assert.equal(gatewayError?.details?.outputHealthReasons.includes(scenario.reason), true);
      assert.equal(events.find((event) => event.type === "turn_complete")?.status, "gateway_error");
    } finally {
      await close(server);
    }
  });
}

test("session metadata preserves context token diagnostics and provider usage", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
  const requests = [];
  const server = await listen(createUsageGateway(requests), "127.0.0.1");

  try {
    const env = mockGatewayEnv(serverUrl(server));
    delete env.LAB_AGENT_TRANSCRIPT_ENABLED;
    const session = await createSession({
      cwd,
      mode: "interactive",
      env
    });

    await runSessionTurn(session, {
      prompt: "hello usage",
      env
    });

    const metadataPath = path.join(cwd, ".lab-agent", "sessions", `${session.id}.json`);
    const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
    assert.equal(typeof metadata.context.promptTokens, "number");
    assert.equal(typeof metadata.context.maxTokens, "number");
    assert.equal(metadata.context.providerPromptTokens, 123);
    assert.equal(typeof metadata.gatewayRounds[0].request.promptTokensEstimate, "number");
    assert.equal(metadata.gatewayRounds[0].response.usage.prompt_tokens, 123);
    assert.equal(metadata.gatewayRounds[0].response.usage.completion_tokens, 45);
    assert.equal(metadata.gatewayRounds[0].response.usage.prompt_tokens_details.cached_tokens, 100);
    assert.equal(session.usage.reports, 1);
    assert.equal(session.usage.promptTokens, 123);
    assert.equal(session.usage.cachedPromptTokens, 100);
    assert.equal(session.usage.completionTokens, 45);
    assert.equal(session.usage.totalTokens, 168);
    assert.equal(metadata.usage.reports, 1);
    assert.equal(metadata.usage.lastPromptTokens, 123);
    assert.equal(metadata.usage.lastCachedPromptTokens, 100);
    assert.equal(metadata.context.providerCachedPromptTokens, 100);
  } finally {
    await close(server);
  }
});

test("failed validation context is injected into follow-up turns with redaction", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
  const requests = [];
  const shellTool = process.platform === "win32" ? "powershell" : "bash";
  const failingCommand = process.platform === "win32"
    ? "Write-Error \"validation failed token=super-secret path=C:\\secret-project\\file.txt\"; exit 1"
    : "printf 'validation failed token=super-secret path=/home/secret-project/file.txt\\n' >&2; exit 1";
  const server = await listen(createValidationGateway(requests, shellTool, failingCommand), "127.0.0.1");

  try {
    const env = mockGatewayEnv(serverUrl(server));
    delete env.LAB_AGENT_TRANSCRIPT_ENABLED;
    const session = await createSession({
      cwd,
      mode: "interactive",
      env,
      allowCommand: true
    });

    await runSessionTurn(session, {
      prompt: "run validation",
      env
    });
    await runSessionTurn(session, {
      prompt: "fix the validation",
      env
    });

    assert.equal(session.workflow.validations.length, 1);
    assert.equal(session.workflow.validations[0].passed, false);
    assert.equal(requests.length, 3);
    assert.deepEqual(requests[2].messages.map((message) => message.role), ["system", "user", "assistant", "tool", "assistant", "user"]);

    assert.match(requests[2].messages[0].content[0].text, /Final response protocol/);
    const context = requests[2].messages.at(-1).content[0].text;
    assert.match(context, /Recent failed validations requiring follow-up/);
    assert.match(context, /commandCategory=shell/);
    assert.match(context, /exit=1/);
    assert.match(context, /stderr excerpt/);
    assert.doesNotMatch(context, /super-secret/);
    assert.match(context, process.platform === "win32" ? /path=C:\\secret-project\\file\.txt/ : /path=\/home\/secret-project\/file\.txt/);
    assert.doesNotMatch(context, /Write-Error|printf/);
    assert.equal(requests[2].messages.at(-1).content[1].text, "fix the validation");

    const metadataPath = path.join(cwd, ".lab-agent", "sessions", `${session.id}.json`);
    const metadataText = await fs.readFile(metadataPath, "utf8");
    assert.match(metadataText, /"failed":\s*1/);
    assert.match(metadataText, /"role":\s*"tool"/);
    assert.doesNotMatch(metadataText, /super-secret/);
    assert.match(metadataText, process.platform === "win32" ? /path=C:\\\\secret-project\\\\file\.txt/ : /path=\/home\/secret-project\/file\.txt/);
  } finally {
    await close(server);
  }
});

test("workflow context is appended to current user message to preserve prompt cache prefix", async () => {
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
    session.messages.push(
      { role: "user", content: "stable prior prompt" },
      { role: "assistant", content: [{ type: "text", text: "stable prior answer" }] }
    );
    session.workflow.changes = [{ id: "change-1", path: "src/a.js", edited: true, diffTruncated: true }];
    session.workflow.validations = [{ id: "validation-1", command: "npm test", passed: true }];

    await runSessionTurn(session, {
      prompt: "continue after workflow",
      env
    });

    assert.deepEqual(requests[0].messages.map((message) => message.role), ["system", "user", "assistant", "user"]);
    assert.equal(requests[0].messages[1].content, "stable prior prompt");
    assert.equal(requests[0].messages[2].content[0].text, "stable prior answer");
    assert.match(requests[0].messages[3].content[0].text, /Ant Code local workflow context/);
    assert.equal(requests[0].messages[3].content[1].text, "continue after workflow");
  } finally {
    await close(server);
  }
});

test("session turns emit ordered gateway and local tool events", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
  await fs.writeFile(path.join(cwd, "notes.txt"), "hello from tool\n", "utf8");
  const requests = [];
  const events = [];
  const server = await listen(createToolGateway(requests), "127.0.0.1");

  try {
    const env = mockGatewayEnv(serverUrl(server));
    const session = await createSession({
      cwd,
      mode: "interactive",
      env
    });

    const result = await runSessionTurn(session, {
      prompt: "read notes",
      env,
      onEvent: (event) => events.push(event)
    });

    assert.match(result.output, /read notes done/);
    assert.deepEqual(events.map((event) => event.type), [
      "turn_start",
      "gateway_request_start",
      "gateway_response",
      "tool_calls_requested",
      "tool_start",
      "tool_finish",
      "gateway_request_start",
      "gateway_response",
      "assistant_final",
      "turn_complete"
    ]);
    assert.equal(events.find((event) => event.type === "tool_start").name, "read_file");
    assert.equal(events.find((event) => event.type === "tool_finish").ok, true);
    assert.equal(events.find((event) => event.type === "assistant_final").text, "read notes done");
    const gatewayStarts = events.filter((event) => event.type === "gateway_request_start");
    assert.ok(gatewayStarts[0].promptTokensEstimate > 0);
    assert.ok(gatewayStarts[1].promptTokensEstimate > gatewayStarts[0].promptTokensEstimate);
    assert.ok(gatewayStarts[1].promptToolResultTokensEstimate > 0);
    assert.equal(session.lastPromptEstimate.tokens, gatewayStarts[1].promptTokensEstimate);
  } finally {
    await close(server);
  }
});

test("session keeps tool evidence in later turns and resume context", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
  await fs.writeFile(path.join(cwd, "notes.txt"), "hello from tool\n", "utf8");
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

    const first = await runSessionTurn(session, {
      prompt: "read notes",
      env
    });
    const second = await runSessionTurn(session, {
      prompt: "follow up",
      env
    });

    assert.match(first.output, /read notes done/);
    assert.match(second.output, /read notes done/);
    assert.equal(session.messages.length, 6);
    assert.deepEqual(session.messages.map((message) => message.role), ["user", "assistant", "tool", "assistant", "user", "assistant"]);
    assert.deepEqual(requests[2].messages.map((message) => message.role), ["system", "user", "assistant", "tool", "assistant", "user"]);
    assert.equal(requests[2].messages[3].toolCallId, "read-notes");
    assert.match(requests[2].messages[3].content[0].text, /hello from tool/);

    const resumed = await createSession({
      cwd,
      mode: "interactive",
      env,
      resume: session.id
    });
    assert.equal(resumed.messages.length, 6);
    assert.equal(resumed.messages[2].role, "tool");
    assert.equal(resumed.messages[2].toolCallId, "read-notes");
    assert.match(resumed.messages[2].content[0].text, /hello from tool/);
  } finally {
    await close(server);
  }
});

test("session injects delegation guard reminder into broad parent tool results", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
  await fs.mkdir(path.join(cwd, "src"), { recursive: true });
  await fs.writeFile(path.join(cwd, "src", "a.js"), "const fullAccess = true;\n", "utf8");
  const requests = [];
  const events = [];
  const server = await listen(createDelegationGuardGateway(requests), "127.0.0.1");

  try {
    const env = mockGatewayEnv(serverUrl(server));
    const session = await createSession({
      cwd,
      mode: "interactive",
      env
    });

    const result = await runSessionTurn(session, {
      prompt: "全面排查当前项目权限链路",
      env,
      onEvent: (event) => events.push(event)
    });

    assert.match(result.output, /guard consumed/);
    const guardEvent = events.find((event) => event.type === "delegation_guard");
    assert.equal(guardEvent?.level, "soft");
    assert.equal(guardEvent.name, "grep");
    const toolMessage = requests[1].messages.find((message) => message.role === "tool" && message.name === "grep");
    assert.match(toolMessage.content[0].text, /Ant Code delegation guard/);
    assert.match(toolMessage.content[0].text, /agent_run/);
  } finally {
    await close(server);
  }
});

test("agent_run events carry a stable task id for TUI lifecycle cards", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
  const requests = [];
  const events = [];
  const server = await listen(createAgentRunGateway(requests), "127.0.0.1");

  try {
    const env = mockGatewayEnv(serverUrl(server));
    const session = await createSession({
      cwd,
      mode: "interactive",
      env
    });

    const result = await runSessionTurn(session, {
      prompt: "delegate read-only work",
      env,
      onEvent: (event) => events.push(event)
    });

    const start = events.find((event) => event.type === "tool_start" && event.name === "agent_run");
    const finish = events.find((event) => event.type === "tool_finish" && event.name === "agent_run");
    assert.match(result.output, /agent result consumed/);
    assert.match(start.taskId, /^task-/);
    assert.equal(finish.taskId, start.taskId);
    assert.equal(start.profile, "explorer");
    assert.equal(finish.profile, "explorer");
    assert.equal(finish.taskStatus, "completed");
    assert.match(finish.outputSummary, /explorer child done/);
  } finally {
    await close(server);
  }
});

test("background agent_run finish event remains running until the group wakes the parent", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
  const requests = [];
  const events = [];
  const server = await listen(createBackgroundAgentRunGateway(requests), "127.0.0.1");

  try {
    const env = mockGatewayEnv(serverUrl(server));
    const session = await createSession({
      cwd,
      mode: "interactive",
      env
    });

    const result = await runSessionTurn(session, {
      prompt: "delegate background read-only work",
      env,
      onEvent: (event) => events.push(event)
    });

    const finish = events.find((event) => event.type === "tool_finish" && event.name === "agent_run");
    assert.match(result.output, /background dispatched/);
    assert.equal(finish.taskStatus, "running");
    assert.match(finish.outputSummary, /后台子智能体 explorer 已启动/);
    await waitFor(async () => events.some((event) => event.type === "subagent_group_wakeup"));
  } finally {
    await close(server);
  }
});

test("session runs same-batch readonly agent_run calls in parallel", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
  const requests = [];
  const events = [];
  const server = await listen(createParallelAgentRunGateway(requests), "127.0.0.1");

  try {
    const env = mockGatewayEnv(serverUrl(server));
    const session = await createSession({
      cwd,
      mode: "interactive",
      env
    });

    const result = await runSessionTurn(session, {
      prompt: "delegate parallel read-only work",
      env,
      onEvent: (event) => events.push(event)
    });

    const starts = events.filter((event) => event.type === "tool_start" && event.name === "agent_run");
    const finishes = events.filter((event) => event.type === "tool_finish" && event.name === "agent_run");
    assert.match(result.output, /parallel agent results consumed/);
    assert.equal(starts.length, 2);
    assert.equal(finishes.length, 2);
    assert.ok(events.indexOf(starts[1]) < events.indexOf(finishes[0]));
    assert.deepEqual(finishes.map((event) => event.toolCallId).sort(), ["delegate-explorer-a", "delegate-explorer-b"]);
  } finally {
    await close(server);
  }
});

test("session respects configured readonly agent_run parallel budget", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
  await fs.writeFile(path.join(cwd, "lab-agent.config.json"), JSON.stringify({
    agents: {
      orchestration: {
        maxParallelReadonlyAgentRuns: 1
      }
    }
  }), "utf8");
  const requests = [];
  const events = [];
  const server = await listen(createParallelAgentRunGateway(requests), "127.0.0.1");

  try {
    const env = mockGatewayEnv(serverUrl(server));
    const session = await createSession({
      cwd,
      mode: "interactive",
      env
    });

    const result = await runSessionTurn(session, {
      prompt: "delegate serial read-only work",
      env,
      onEvent: (event) => events.push(event)
    });

    const starts = events.filter((event) => event.type === "tool_start" && event.name === "agent_run");
    const finishes = events.filter((event) => event.type === "tool_finish" && event.name === "agent_run");
    assert.match(result.output, /parallel agent results consumed/);
    assert.equal(starts.length, 2);
    assert.equal(finishes.length, 2);
    assert.ok(events.indexOf(finishes[0]) < events.indexOf(starts[1]));
  } finally {
    await close(server);
  }
});

test("same-batch agent_run calls get distinct task ids for TUI cards", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
  const requests = [];
  const events = [];
  const server = await listen(createDuplicateTaskIdAgentRunGateway(requests), "127.0.0.1");

  try {
    const env = mockGatewayEnv(serverUrl(server));
    const session = await createSession({
      cwd,
      mode: "interactive",
      env
    });

    const result = await runSessionTurn(session, {
      prompt: "delegate duplicate-id read-only work",
      env,
      onEvent: (event) => events.push(event)
    });

    const starts = events.filter((event) => event.type === "tool_start" && event.name === "agent_run");
    const finishes = events.filter((event) => event.type === "tool_finish" && event.name === "agent_run");
    assert.match(result.output, /duplicate task ids consumed/);
    assert.deepEqual(starts.map((event) => event.taskId), ["child-same", "child-same-2"]);
    assert.deepEqual(finishes.map((event) => event.taskId).sort(), ["child-same", "child-same-2"]);
  } finally {
    await close(server);
  }
});

test("session tool loop uses configurable round budget for longer tasks", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
  await fs.writeFile(path.join(cwd, "notes.txt"), "hello from tool\n", "utf8");
  const requests = [];
  const events = [];
  const server = await listen(createRepeatedToolGateway(requests, {
    toolRounds: 4,
    toolName: "read_file",
    input: { path: "notes.txt", maxBytes: 1024 },
    finalText: "long tool chain done"
  }), "127.0.0.1");

  try {
    const env = {
      ...mockGatewayEnv(serverUrl(server)),
      LAB_AGENT_MAX_TOOL_ROUNDS: "5"
    };
    const session = await createSession({
      cwd,
      mode: "interactive",
      env
    });

    const result = await runSessionTurn(session, {
      prompt: "read notes repeatedly",
      env,
      onEvent: (event) => events.push(event)
    });

    assert.equal(result.output, "long tool chain done");
    assert.equal(requests.length, 5);
    assert.equal(events.filter((event) => event.type === "tool_start").length, 4);
    assert.equal(events.some((event) => event.type === "tool_limit"), false);
  } finally {
    await close(server);
  }
});

test("session reports configurable tool round limit in Chinese", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
  await fs.writeFile(path.join(cwd, "notes.txt"), "hello from tool\n", "utf8");
  const requests = [];
  const events = [];
  const server = await listen(createRepeatedToolGateway(requests, {
    toolRounds: 99,
    toolName: "read_file",
    input: { path: "notes.txt", maxBytes: 1024 },
    finalText: "should not reach final"
  }), "127.0.0.1");

  try {
    const env = {
      ...mockGatewayEnv(serverUrl(server)),
      LAB_AGENT_MAX_TOOL_ROUNDS: "2"
    };
    const session = await createSession({
      cwd,
      mode: "interactive",
      env
    });

    const result = await runSessionTurn(session, {
      prompt: "loop tools",
      env,
      onEvent: (event) => events.push(event)
    });

    assert.match(result.output, /工具轮次已达到当前上限（2 轮）/);
    assert.equal(requests.length, 3);
    assert.equal(events.find((event) => event.type === "tool_limit").maxToolRounds, 2);
  } finally {
    await close(server);
  }
});

test("session syncs workflow sidebar state when final answer announces completion", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
  const requests = [];
  const events = [];
  const server = await listen(createTodoSyncGateway(requests), "127.0.0.1");

  try {
    const env = mockGatewayEnv(serverUrl(server));
    const session = await createSession({
      cwd,
      mode: "interactive",
      env
    });

    await runSessionTurn(session, {
      prompt: "run workflow",
      env,
      onEvent: (event) => events.push(event)
    });

    assert.deepEqual(session.workflow.todos.map((item) => item.status), ["completed", "completed"]);
    const syncEvent = events.find((event) => event.type === "workflow_updated");
    assert.equal(syncEvent.reason, "assistant_final_sync");
    assert.equal(syncEvent.todosCompleted, 2);
  } finally {
    await close(server);
  }
});

test("interactive session turns emit live OpenAI-compatible stream events", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
  const requests = [];
  const events = [];
  const server = await listen(createOpenAIStreamingGateway(requests), "127.0.0.1");

  try {
    const env = {
      LAB_MODEL_GATEWAY_URL: `${serverUrl(server)}/v1/chat/completions`,
      LAB_AGENT_MODEL: "mock-openai",
      LAB_AGENT_NETWORK_MODE: "offline",
      LAB_AGENT_TRANSCRIPT_ENABLED: "false",
      LAB_MODEL_GATEWAY_PROTOCOL: "openai-chat"
    };
    const session = await createSession({
      cwd,
      mode: "interactive",
      env
    });

    const result = await runSessionTurn(session, {
      prompt: "stream please",
      env,
      onEvent: (event) => events.push(event)
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].stream, true);
    assert.equal(result.output, "hello world");
    assert.deepEqual(events.map((event) => event.type), [
      "turn_start",
      "gateway_request_start",
      "gateway_stream_start",
      "assistant_thinking_delta",
      "assistant_delta",
      "assistant_delta",
      "gateway_stream_stop",
      "gateway_response",
      "assistant_final",
      "turn_complete"
    ]);
    assert.equal(events.find((event) => event.type === "assistant_thinking_delta").text, "checking ");
    assert.equal(events.filter((event) => event.type === "assistant_delta").map((event) => event.text).join(""), "hello world");
  } finally {
    await close(server);
  }
});

test("session forwards gateway retry events during model turns", async () => {
  const originalFetch = globalThis.fetch;
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
  const events = [];
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) {
        throw new TypeError("fetch failed");
      }
      return new Response(JSON.stringify({
        id: "retry-session-ok",
        model: "mock-context",
        content: [{ type: "text", text: "retry recovered" }],
        toolCalls: [],
        stopReason: "stop"
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    const env = {
      LAB_MODEL_GATEWAY_URL: "http://127.0.0.1/v1/chat",
      LAB_MODEL_GATEWAY_PROTOCOL: "lab-agent-gateway",
      LAB_MODEL_GATEWAY_MAX_RETRIES: "1",
      LAB_AGENT_MODEL: "mock-context",
      LAB_AGENT_NETWORK_MODE: "offline",
      LAB_AGENT_TRANSCRIPT_ENABLED: "false"
    };
    const session = await createSession({
      cwd,
      mode: "interactive",
      env
    });

    const result = await runSessionTurn(session, {
      prompt: "recover from transient fetch",
      env,
      onEvent: (event) => events.push(event)
    });

    assert.equal(result.output, "retry recovered");
    assert.equal(calls, 2);
    const retry = events.find((event) => event.type === "gateway_retry");
    assert.equal(retry.attempt, 1);
    assert.equal(retry.maxAttempts, 2);
    assert.equal(retry.round, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("session retries OpenAI streams that end without a terminal signal", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
  const requests = [];
  const events = [];
  const server = await listen(createIncompleteOpenAIThenHealthyGateway(requests), "127.0.0.1");

  try {
    const env = {
      LAB_MODEL_GATEWAY_URL: `${serverUrl(server)}/v1/chat/completions`,
      LAB_MODEL_GATEWAY_PROTOCOL: "openai-chat",
      LAB_MODEL_GATEWAY_MAX_RETRIES: "1",
      LAB_AGENT_MODEL: "mock-openai",
      LAB_AGENT_NETWORK_MODE: "offline",
      LAB_AGENT_TRANSCRIPT_ENABLED: "false"
    };
    const session = await createSession({
      cwd,
      mode: "interactive",
      env
    });

    const result = await runSessionTurn(session, {
      prompt: "recover the interrupted stream",
      env,
      onEvent: (event) => events.push(event)
    });

    assert.equal(result.output, "stream recovered");
    assert.equal(requests.length, 2);
    const retry = events.find((event) => event.type === "gateway_retry");
    assert.equal(retry?.error?.code, "UPSTREAM_STREAM_ABORTED");
    assert.equal(retry?.error?.details?.streamReason, "missing_done_and_finish_reason");
    assert.equal(events.some((event) => event.type === "assistant_final"), true);
  } finally {
    await close(server);
  }
});

test("streamed thinking persists into resume context and follows later turns", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
  const requests = [];
  const server = await listen(createOpenAIStreamingGateway(requests), "127.0.0.1");

  try {
    const env = {
      LAB_MODEL_GATEWAY_URL: `${serverUrl(server)}/v1/chat/completions`,
      LAB_AGENT_MODEL: "mock-openai",
      LAB_AGENT_NETWORK_MODE: "offline",
      LAB_MODEL_GATEWAY_PROTOCOL: "openai-chat"
    };
    const session = await createSession({
      cwd,
      mode: "interactive",
      env
    });

    await runSessionTurn(session, {
      prompt: "stream please",
      env
    });

    assert.equal(session.messages[1].thinking.text, "checking ");
    const metadataPath = path.join(cwd, ".lab-agent", "sessions", `${session.id}.json`);
    const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
    assert.equal(metadata.transcript.messages[1].thinking.text, "checking ");

    const resumed = await createSession({
      cwd,
      mode: "interactive",
      env,
      resume: session.id
    });
    assert.equal(resumed.messages[1].thinking.text, "checking ");

    await runSessionTurn(resumed, {
      prompt: "second prompt",
      env
    });
    const previousAssistant = requests[1].messages.find((message) => message.role === "assistant");
    const previousText = typeof previousAssistant.content === "string"
      ? previousAssistant.content
      : previousAssistant.content[0].text;
    assert.equal(previousText, "hello world");
    assert.equal(previousAssistant.reasoning_content, "checking ");
  } finally {
    await close(server);
  }
});

test("OpenAI-compatible tool continuations include prior assistant reasoning_content", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
  await fs.writeFile(path.join(cwd, "notes.txt"), "hello notes", "utf8");
  const requests = [];
  const server = await listen(createDeepSeekReasoningToolGateway(requests), "127.0.0.1");

  try {
    const env = {
      LAB_MODEL_GATEWAY_URL: `${serverUrl(server)}/v1/chat/completions`,
      LAB_AGENT_MODEL: "mock-openai",
      LAB_AGENT_NETWORK_MODE: "offline",
      LAB_AGENT_TRANSCRIPT_ENABLED: "false",
      LAB_MODEL_GATEWAY_PROTOCOL: "openai-chat"
    };
    const session = await createSession({
      cwd,
      mode: "interactive",
      env
    });

    const result = await runSessionTurn(session, {
      prompt: "read notes",
      env
    });

    assert.equal(result.output, "reasoning continuation accepted");
    assert.equal(requests.length, 2);
    const assistant = requests[1].messages.find((message) => message.role === "assistant" && Array.isArray(message.tool_calls));
    assert.equal(assistant.reasoning_content, "Need to read notes before answering.");
  } finally {
    await close(server);
  }
});

test("OpenAI Responses tool continuations replay native reasoning items", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
  await fs.writeFile(path.join(cwd, "notes.txt"), "hello notes", "utf8");
  const requests = [];
  const server = await listen(createResponsesReasoningToolGateway(requests), "127.0.0.1");

  try {
    const env = {
      LAB_MODEL_GATEWAY_URL: `${serverUrl(server)}/v1/responses`,
      LAB_AGENT_MODEL: "grok-4.6",
      LAB_AGENT_NETWORK_MODE: "offline",
      LAB_AGENT_TRANSCRIPT_ENABLED: "false",
      LAB_MODEL_GATEWAY_PROTOCOL: "openai-responses"
    };
    const session = await createSession({ cwd, mode: "interactive", env });

    const result = await runSessionTurn(session, { prompt: "read notes", env });

    assert.equal(result.output, "responses reasoning continuation accepted");
    assert.equal(requests.length, 2);
    assert.equal(requests[1].input.filter((item) => item.type === "reasoning").length, 1);
    assert.equal(requests[1].input.filter((item) => item.type === "function_call").length, 1);
    assert.equal(requests[1].input.some((item) => item.type === "function_call_output" && item.call_id === "call-read-notes"), true);
  } finally {
    await close(server);
  }
});

test("OpenAI-compatible tool continuations trim oversized reasoning_content from the front", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
  await fs.writeFile(path.join(cwd, "notes.txt"), "hello notes", "utf8");
  const requests = [];
  const server = await listen(createLongReasoningToolGateway(requests), "127.0.0.1");

  try {
    const env = {
      LAB_MODEL_GATEWAY_URL: `${serverUrl(server)}/v1/chat/completions`,
      LAB_AGENT_MODEL: "mock-openai",
      LAB_AGENT_NETWORK_MODE: "offline",
      LAB_AGENT_TRANSCRIPT_ENABLED: "false",
      LAB_MODEL_GATEWAY_PROTOCOL: "openai-chat"
    };
    const session = await createSession({
      cwd,
      mode: "interactive",
      env
    });

    const result = await runSessionTurn(session, {
      prompt: "read notes",
      env
    });

    assert.equal(result.output, "trimmed reasoning accepted");
    const assistant = requests[1].messages.find((message) => message.role === "assistant" && Array.isArray(message.tool_calls));
    assert.equal(assistant.reasoning_content.endsWith("LATEST_REASONING_TAIL"), true);
    assert.equal(assistant.reasoning_content.includes("VERY_OLD_REASONING_START"), false);
  } finally {
    await close(server);
  }
});

test("interactive session does not persist raw OpenAI reasoning-only streams as JSON output", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
  const events = [];
  const server = await listen(createReasoningOnlyOpenAIStreamingGateway(), "127.0.0.1");

  try {
    const env = {
      LAB_MODEL_GATEWAY_URL: `${serverUrl(server)}/v1/chat/completions`,
      LAB_AGENT_MODEL: "mock-openai",
      LAB_AGENT_NETWORK_MODE: "offline",
      LAB_AGENT_TRANSCRIPT_ENABLED: "false",
      LAB_MODEL_GATEWAY_PROTOCOL: "openai-chat"
    };
    const session = await createSession({
      cwd,
      mode: "interactive",
      env
    });

    const result = await runSessionTurn(session, {
      prompt: "reasoning only",
      env,
      onEvent: (event) => events.push(event)
    });

    assert.match(result.output, /没有返回可展示正文/);
    assert.doesNotMatch(result.output, /chat\.completion\.chunk/);
    assert.doesNotMatch(result.output, /private final text/);
    assert.ok(events.some((event) => event.type === "assistant_thinking_delta"));
    assert.ok(events.some((event) => event.type === "assistant_final"));
  } finally {
    await close(server);
  }
});

test("interactive session turns can be interrupted through AbortSignal", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
  const requests = [];
  const events = [];
  const server = await listen(createSlowOpenAIStreamingGateway(requests), "127.0.0.1");

  try {
    const env = {
      LAB_MODEL_GATEWAY_URL: `${serverUrl(server)}/v1/chat/completions`,
      LAB_AGENT_MODEL: "mock-openai",
      LAB_AGENT_NETWORK_MODE: "offline",
      LAB_AGENT_TRANSCRIPT_ENABLED: "false",
      LAB_MODEL_GATEWAY_PROTOCOL: "openai-chat"
    };
    const session = await createSession({
      cwd,
      mode: "interactive",
      env
    });
    const controller = new AbortController();

    const result = await runSessionTurn(session, {
      prompt: "stream until interrupted",
      env,
      signal: controller.signal,
      onEvent: (event) => {
        events.push(event);
        if (event.type === "assistant_delta") {
          controller.abort();
        }
      }
    });

    assert.equal(requests.length, 1);
    assert.equal(result.interrupted, true);
    assert.match(result.output, /Turn interrupted by the local user/);
    assert.match(result.output, /Interrupted assistant draft saved/);
    assert.match(result.output, /partial/);
    assert.ok(events.some((event) => event.type === "assistant_interrupted_draft"));
    assert.ok(events.some((event) => event.type === "turn_interrupted"));
    assert.match(events.find((event) => event.type === "turn_interrupted").draftText, /partial/);
    assert.equal(session.messages.length, 2);
    assert.equal(session.messages[0].role, "user");
    assert.equal(session.messages[0].content, "stream until interrupted");
    assert.match(session.messages[1].content[0].text, /中断草稿，非最终回复/);
    assert.match(session.messages[1].content[0].text, /partial/);
    assert.equal(events.at(-1).type, "turn_complete");
    assert.equal(events.at(-1).status, "interrupted");
  } finally {
    await close(server);
  }
});

test("session turns can be interrupted after gateway response before tool execution", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
  const requests = [];
  const events = [];
  const server = await listen(createToolGateway(requests), "127.0.0.1");

  try {
    const env = mockGatewayEnv(serverUrl(server));
    const session = await createSession({
      cwd,
      mode: "interactive",
      env
    });
    const controller = new AbortController();

    const result = await runSessionTurn(session, {
      prompt: "read notes",
      env,
      signal: controller.signal,
      onEvent: (event) => {
        events.push(event);
        if (event.type === "gateway_response") {
          controller.abort();
        }
      }
    });

    assert.equal(requests.length, 1);
    assert.equal(result.interrupted, true);
    assert.equal(events.find((event) => event.type === "turn_interrupted").reason, "after_gateway_response");
    assert.deepEqual(events.map((event) => event.type), [
      "turn_start",
      "gateway_request_start",
      "gateway_response",
      "turn_interrupted",
      "turn_complete"
    ]);
  } finally {
    await close(server);
  }
});

test("interrupted assistant draft persists in session metadata for resume", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
  const requests = [];
  const server = await listen(createSlowOpenAIStreamingGateway(requests), "127.0.0.1");

  try {
    const env = {
      LAB_MODEL_GATEWAY_URL: `${serverUrl(server)}/v1/chat/completions`,
      LAB_AGENT_MODEL: "mock-openai",
      LAB_AGENT_NETWORK_MODE: "offline",
      LAB_MODEL_GATEWAY_PROTOCOL: "openai-chat"
    };
    const session = await createSession({
      cwd,
      mode: "interactive",
      env
    });
    const controller = new AbortController();

    await runSessionTurn(session, {
      prompt: "stream until interrupted",
      env,
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === "assistant_delta") {
          controller.abort();
        }
      }
    });

    const metadataPath = path.join(cwd, ".lab-agent", "sessions", `${session.id}.json`);
    const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
    assert.equal(metadata.status, "interrupted");
    assert.equal(metadata.transcript.messages.length, 2);
    assert.equal(metadata.transcript.messages[0].content, "stream until interrupted");
    assert.equal(metadata.transcript.messages[1].interruptedDraft, true);
    assert.match(metadata.transcript.messages[1].content[0].text, /partial/);
    assert.equal(metadata.interruptedDraft.textBytes > 0, true);

    const resumed = await createSession({
      cwd,
      mode: "interactive",
      env,
      resume: session.id
    });
    assert.equal(resumed.messages.length, 2);
    assert.match(resumed.messages[1].content[0].text, /中断草稿，非最终回复/);
  } finally {
    await close(server);
  }
});

test("gateway failures persist streamed assistant draft for resume", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
  const originalFetch = globalThis.fetch;
  const requests = [];
  const events = [];
  const encoder = new TextEncoder();
  let fetchCalls = 0;

  try {
    globalThis.fetch = async (_url, options) => {
      fetchCalls += 1;
      requests.push(JSON.parse(String(options.body ?? "{}")));
      if (fetchCalls > 1) {
        return new Response(JSON.stringify({
          id: "chatcmpl-resume-ok",
          model: "mock-openai",
          choices: [
            {
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: "resumed from phase 3 draft"
              }
            }
          ]
        }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      let streamStep = 0;
      const body = new ReadableStream({
        pull(controller) {
          streamStep += 1;
          if (streamStep === 1) {
            controller.enqueue(encoder.encode('data: {"id":"chatcmpl-failing-draft","model":"mock-openai","choices":[{"delta":{"reasoning_content":"Need to keep the latest phase."}}]}\n\n'));
            return;
          }
          if (streamStep === 2) {
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Phase 3 readonly review is complete; stay in Phase 3 before Phase 4."}}]}\n\n'));
            return;
          }
          controller.error(new Error("premature close"));
        }
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    };

    const env = {
      LAB_MODEL_GATEWAY_URL: "http://127.0.0.1/v1/chat/completions",
      LAB_AGENT_MODEL: "mock-openai",
      LAB_AGENT_NETWORK_MODE: "offline",
      LAB_MODEL_GATEWAY_PROTOCOL: "openai-chat",
      LAB_MODEL_GATEWAY_MAX_RETRIES: "0"
    };
    const session = await createSession({
      cwd,
      mode: "interactive",
      env
    });

    const result = await runSessionTurn(session, {
      prompt: "continue the long task",
      env,
      onEvent: (event) => events.push(event)
    });

    assert.match(result.output, /Gateway error: GATEWAY_(RESPONSE_PARSE_ERROR|STREAM_INTERRUPTED)/);
    assert.equal(session.messages.length, 2);
    assert.equal(session.messages[0].content, "continue the long task");
    assert.equal(session.messages[1].interruptedDraft, true);
    assert.match(session.messages[1].content[0].text, /Phase 3 readonly review/);
    assert.equal(events.some((event) => event.type === "assistant_interrupted_draft"), true);
    assert.equal(events.find((event) => event.type === "gateway_error").draftBytes > 0, true);

    const metadataPath = path.join(cwd, ".lab-agent", "sessions", `${session.id}.json`);
    const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
    assert.equal(metadata.status, "gateway_error");
    assert.equal(metadata.transcript.messages[1].interruptedDraft, true);
    assert.match(metadata.transcript.messages[1].content[0].text, /Phase 3 readonly review/);
    assert.equal(metadata.interruptedDraft.textBytes > 0, true);
    assert.match(metadata.interruptedDraft.reason, /gateway_error:GATEWAY_(RESPONSE_PARSE_ERROR|STREAM_INTERRUPTED)/);
    assert.equal(metadata.transcript.modelArchive.totalMessages, 2);
    const modelChunk = JSON.parse(await fs.readFile(path.join(cwd, ".lab-agent", "sessions", metadata.transcript.modelArchive.chunks[0].file), "utf8"));
    assert.equal(modelChunk.messages[1].interruptedDraft, true);
    assert.match(modelChunk.messages[1].content[0].text, /Phase 3 readonly review/);

    const resumed = await createSession({
      cwd,
      mode: "interactive",
      env,
      resume: session.id
    });
    assert.match(resumed.messages[1].content[0].text, /Phase 3 readonly review/);

    await runSessionTurn(resumed, {
      prompt: "continue from the failed phase",
      env
    });
    assert.equal(requests.length, 2);
    const resumeAssistant = requests[1].messages.find((message) => message.role === "assistant" && String(message.content ?? "").includes("Phase 3 readonly review"));
    assert.ok(resumeAssistant);
    assert.equal(resumeAssistant.reasoning_content, "Need to keep the latest phase.");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("session turns interrupt an in-flight shell tool and finish locally", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
  const requests = [];
  const events = [];
  const shellTool = process.platform === "win32" ? "powershell" : "bash";
  const command = process.platform === "win32" ? "Start-Sleep -Seconds 20" : "sleep 20";
  const server = await listen(createValidationGateway(requests, shellTool, command), "127.0.0.1");

  try {
    const env = {
      ...mockGatewayEnv(serverUrl(server)),
      LAB_AGENT_NETWORK_MODE: "open-dev"
    };
    const session = await createSession({
      cwd,
      mode: "interactive",
      env
    });
    session.allowCommand = true;
    session.permissionMode = "workspace";
    const controller = new AbortController();

    const result = await runSessionTurn(session, {
      prompt: "run slow shell command",
      env,
      signal: controller.signal,
      onEvent: (event) => {
        events.push(event);
        if (event.type === "tool_start") {
          setTimeout(() => controller.abort(), 100);
        }
      }
    });

    const finish = events.find((event) => event.type === "tool_finish");
    assert.equal(result.interrupted, true);
    assert.equal(finish.name, shellTool);
    assert.equal(finish.interrupted, true);
    assert.equal(finish.errorCode, "SHELL_INTERRUPTED");
    assert.equal(events.find((event) => event.type === "turn_interrupted").reason, "after_tool_execution");
    assert.equal(requests.length, 1);
    assert.equal(events.at(-1).type, "turn_complete");
    assert.equal(events.at(-1).status, "interrupted");
  } finally {
    await close(server);
  }
});

test("session metadata stores workflow summary without workflow text", async () => {
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
    session.workflow.todos = [{ id: "todo-1", content: "sensitive task text", status: "pending" }];
    session.workflow.plan.steps = [{ id: "step-1", content: "sensitive plan text", status: "completed" }];
    session.workflow.changes = [{ id: "change-1", path: "secret-project/file.txt", created: true }];
    session.workflow.validations = [{ id: "validation-1", command: "npm test -- secret-project", passed: false }];

    await runSessionTurn(session, {
      prompt: "hello",
      env
    });

    const metadataPath = path.join(cwd, ".lab-agent", "sessions", `${session.id}.json`);
    const metadataText = await fs.readFile(metadataPath, "utf8");
    const metadata = JSON.parse(metadataText);
    assert.equal(metadata.workflow.todos.total, 1);
    assert.equal(metadata.workflow.planSteps.completed, 1);
    assert.equal(metadata.workflow.changes.total, 1);
    assert.equal(metadata.workflow.validations.failed, 1);
    assert.doesNotMatch(metadataText, /sensitive task text/);
    assert.doesNotMatch(metadataText, /sensitive plan text/);
    assert.doesNotMatch(metadataText, /secret-project/);
  } finally {
    await close(server);
  }
});
