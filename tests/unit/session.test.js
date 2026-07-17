import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSession, persistSessionSnapshot, runSessionTurn } from "../../src/core/session.js";
import { createSessionStore } from "../../src/storage/session-store.js";

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
    modelAlias: "text-only-model",
    models: [
      { id: "text-only-model", label: "Text Only Model", modalities: ["text"] },
      { id: "text-fast-model", label: "Text Fast Model", modalities: ["text"] }
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
      maxTokens: 260,
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
    models: [{ id: "mock-openai", contextTokens: 1000 }],
    context: {
      maxTokens: 260,
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
    models: [{ id: "mock-openai", contextTokens: 1000 }],
    context: {
      maxTokens: 1000,
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

test("session preserves in-flight tool results before later gateway rounds", async () => {
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
    assert.doesNotMatch(toolText, /\[compacted tool result\]/);
    assert.match(toolText, /large tool output large tool output/);
    assert.equal(events.some((event) => event.type === "context_compacted" && event.strategy === "in-flight-tool-summary"), false);
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
  const server = await listen(createReasoningToolGateway(requests), "127.0.0.1");

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
    model: "example-coding-model",
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
    model: "example-coding-model",
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
function createRecordingGateway(requests) {
  return http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      return;
    }

    const body = await readRequestJson(request);
    requests.push(body);
    response.writeHead(200, { "content-type": "application/json" });
    if (body.messages?.some((message) => String(message.content?.[0]?.text ?? "").includes("context compactor"))) {
      response.end(JSON.stringify({
        id: `mock-compact-${requests.length}`,
        model: body.model,
        content: [{ type: "text", text: "Model compacted summary: first turn and second turn are retained as safe background." }],
        toolCalls: [],
        stopReason: "stop"
      }));
      return;
    }
    response.end(JSON.stringify({
      id: `mock-${requests.length}`,
      model: body.model,
      content: [{ type: "text", text: `assistant ${requests.length}` }],
      toolCalls: [],
      stopReason: "stop"
    }));
  });
}

function messageText(message = {}) {
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((item) => typeof item === "string" ? item : String(item?.text ?? "")).join("");
  }
  return "";
}

/**
 * @param {Array<Record<string, any>>} requests
 */
function createToolGateway(requests) {
  return http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      return;
    }

    const body = await readRequestJson(request);
    requests.push(body);
    response.writeHead(200, { "content-type": "application/json" });

    if (requests.length === 1) {
      response.end(JSON.stringify({
        id: "mock-tool-call",
        model: body.model,
        content: [],
        toolCalls: [
          {
            id: "read-notes",
            name: "read_file",
            input: { path: "notes.txt", maxBytes: 1024 }
          }
        ],
        stopReason: "tool_calls"
      }));
      return;
    }

    response.end(JSON.stringify({
      id: "mock-final",
      model: body.model,
      content: [{ type: "text", text: "read notes done" }],
      toolCalls: [],
      stopReason: "stop"
    }));
  });
}

/**
 * @param {Array<Record<string, any>>} requests
 */
function createLargeToolThenFinalGateway(requests) {
  return http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      return;
    }

    const body = await readRequestJson(request);
    requests.push(body);
    response.writeHead(200, { "content-type": "application/json" });

    if (requests.length === 1) {
      response.end(JSON.stringify({
        id: "mock-large-tool-call",
        model: body.model,
        content: [],
        toolCalls: [
          {
            id: "read-large",
            name: "read_file",
            input: { path: "large.txt", maxBytes: 24000 }
          }
        ],
        stopReason: "tool_calls"
      }));
      return;
    }

    response.end(JSON.stringify({
      id: "mock-large-final",
      model: body.model,
      content: [{ type: "text", text: "large result consumed" }],
      toolCalls: [],
      stopReason: "stop"
    }));
  });
}

/**
 * @param {Array<Record<string, any>>} requests
 */
function createMalformedThenHealthyGateway(requests) {
  return http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      return;
    }

    const body = await readRequestJson(request);
    requests.push(body);
    response.writeHead(200, { "content-type": "application/json" });

    if (requests.length === 1) {
      response.end(JSON.stringify({
        id: "mock-malformed-final",
        model: body.model,
        content: [{ type: "text", text: "Ver" }],
        thinking: "The verifier found one remaining issue and should now summarize it for the user.",
        toolCalls: [],
        stopReason: "stop"
      }));
      return;
    }

    response.end(JSON.stringify({
      id: "mock-healthy-final",
      model: body.model,
      content: [{ type: "text", text: "复核完成：没有发现新的阻塞问题。" }],
      toolCalls: [],
      stopReason: "stop"
    }));
  });
}

/**
 * @param {Array<Record<string, any>>} requests
 */
function createReasoningOnlyLengthThenHealthyGateway(requests) {
  return http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      return;
    }

    const body = await readRequestJson(request);
    requests.push(body);
    response.writeHead(200, { "content-type": "application/json" });

    if (requests.length === 1) {
      response.end(JSON.stringify({
        id: "mock-reasoning-only-length",
        model: body.model,
        content: [],
        thinking: "The model spent the whole budget planning without producing visible text.".repeat(80),
        toolCalls: [],
        stopReason: "length",
        usage: {
          completion_tokens: 32768,
          prompt_tokens: 1000,
          total_tokens: 33768,
          completion_tokens_details: {
            reasoning_tokens: 32678
          }
        },
        raw: {
          thinkingBytes: 5200,
          textBytes: 0
        }
      }));
      return;
    }

    response.end(JSON.stringify({
      id: "mock-reasoning-retry-healthy",
      model: body.model,
      content: [{ type: "text", text: "总结完成：已根据当前上下文给出用户可见正文。" }],
      toolCalls: [],
      stopReason: "stop"
    }));
  });
}

function createAlwaysReasoningOnlyLengthGateway(requests) {
  return http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      return;
    }
    const body = await readRequestJson(request);
    requests.push(body);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: `mock-reasoning-only-length-${requests.length}`,
      model: body.model,
      content: [],
      thinking: "The model spent the whole budget planning without producing visible text.".repeat(80),
      toolCalls: [],
      stopReason: "length",
      raw: { thinkingBytes: 5200, textBytes: 0 }
    }));
  });
}

/**
 * @param {Array<Record<string, any>>} requests
 */
function createMissingTerminalThenHealthyGateway(requests) {
  return http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      return;
    }

    const body = await readRequestJson(request);
    requests.push(body);
    response.writeHead(200, { "content-type": "application/json" });

    if (requests.length === 1) {
      response.end(JSON.stringify(missingTerminalResponse(body.model, "mock-missing-terminal")));
      return;
    }

    response.end(JSON.stringify({
      id: "mock-missing-terminal-recovered",
      model: body.model,
      content: [{ type: "text", text: "恢复完成：已返回完整正文。" }],
      toolCalls: [],
      stopReason: "stop"
    }));
  });
}

/**
 * @param {Array<Record<string, any>>} requests
 */
function createAlwaysMissingTerminalGateway(requests) {
  return http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      return;
    }

    const body = await readRequestJson(request);
    requests.push(body);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(missingTerminalResponse(body.model, `mock-missing-terminal-${requests.length}`)));
  });
}

function missingTerminalResponse(model, id) {
  return {
    id,
    model,
    content: [],
    thinking: "I need to inspect the current state. I need to see",
    toolCalls: [],
    stopReason: null,
    raw: {
      thinkingBytes: 517,
      textBytes: 0
    }
  };
}

/**
 * @param {Array<Record<string, any>>} requests
 */
function createRepetitiveThinkingThenHealthyGateway(requests) {
  return http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      return;
    }

    const body = await readRequestJson(request);
    requests.push(body);
    response.writeHead(200, { "content-type": "application/json" });

    if (requests.length === 1) {
      const repeated = [
        "Let me now create the entries and edit the files.",
        "Actually, I should inspect the same format one more time before editing."
      ].join("\n");
      response.end(JSON.stringify({
        id: "mock-repetitive-thinking",
        model: body.model,
        content: [],
        thinking: `${repeated}\n`.repeat(80),
        toolCalls: [],
        stopReason: "length",
        raw: {
          thinkingBytes: 9000,
          textBytes: 0
        }
      }));
      return;
    }

    response.end(JSON.stringify({
      id: "mock-repetitive-retry-healthy",
      model: body.model,
      content: [{ type: "text", text: "已跳出重复思考并给出最终正文。" }],
      toolCalls: [],
      stopReason: "stop"
    }));
  });
}

function createAlwaysRepetitiveThinkingGateway(requests) {
  return http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      return;
    }
    const body = await readRequestJson(request);
    requests.push(body);
    const repeated = [
      "Let me now create the entries and edit the files.",
      "Actually, I should inspect the same format one more time before editing."
    ].join("\n");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: `mock-repetitive-thinking-${requests.length}`,
      model: body.model,
      content: [],
      thinking: `${repeated}\n`.repeat(80),
      toolCalls: [],
      stopReason: "stop",
      raw: { thinkingBytes: 9000, textBytes: 0 }
    }));
  });
}

/**
 * @param {Array<Record<string, any>>} requests
 */
function createUsageGateway(requests) {
  return http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      return;
    }

    const body = await readRequestJson(request);
    requests.push(body);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "mock-usage-final",
      model: body.model,
      content: [{ type: "text", text: "usage recorded" }],
      toolCalls: [],
      stopReason: "stop",
      usage: {
        prompt_tokens: 123,
        completion_tokens: 45,
        total_tokens: 168,
        prompt_tokens_details: {
          cached_tokens: 100
        }
      }
    }));
  });
}

/**
 * @param {Array<Record<string, any>>} requests
 */
function createDelegationGuardGateway(requests) {
  return http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      return;
    }

    const body = await readRequestJson(request);
    requests.push(body);
    response.writeHead(200, { "content-type": "application/json" });

    if (requests.length === 1) {
      response.end(JSON.stringify({
        id: "mock-guard-tools",
        model: body.model,
        content: [],
        toolCalls: [
          {
            id: "glob-wide",
            name: "glob",
            input: { pattern: "**/*.js", path: "." }
          },
          {
            id: "grep-wide",
            name: "grep",
            input: { pattern: "fullAccess", path: "." }
          }
        ],
        stopReason: "tool_calls"
      }));
      return;
    }

    response.end(JSON.stringify({
      id: "mock-guard-final",
      model: body.model,
      content: [{ type: "text", text: "guard consumed" }],
      toolCalls: [],
      stopReason: "stop"
    }));
  });
}

/**
 * @param {Array<Record<string, any>>} requests
 */
function createAgentRunGateway(requests) {
  return http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      return;
    }

    const body = await readRequestJson(request);
    requests.push(body);
    response.writeHead(200, { "content-type": "application/json" });

    const sessionId = String(body.metadata?.sessionId ?? body.sessionId ?? "");
    if (sessionId.startsWith("agent-explorer-")) {
      response.end(JSON.stringify({
        id: "mock-child-final",
        model: body.model,
        content: [{ type: "text", text: "explorer child done" }],
        toolCalls: [],
        stopReason: "stop"
      }));
      return;
    }

    if (requests.filter((item) => !String(item.sessionId ?? "").startsWith("agent-explorer-")).length === 1) {
      response.end(JSON.stringify({
        id: "mock-agent-run",
        model: body.model,
        content: [],
        toolCalls: [
          {
            id: "delegate-explorer",
            name: "agent_run",
            input: { profile: "explorer", query: "inspect current workspace" }
          }
        ],
        stopReason: "tool_calls"
      }));
      return;
    }

    response.end(JSON.stringify({
      id: "mock-final",
      model: body.model,
      content: [{ type: "text", text: "agent result consumed" }],
      toolCalls: [],
      stopReason: "stop"
    }));
  });
}

/**
 * @param {Array<Record<string, any>>} requests
 */
function createBackgroundAgentRunGateway(requests) {
  return http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      return;
    }

    const body = await readRequestJson(request);
    requests.push(body);
    response.writeHead(200, { "content-type": "application/json" });

    const sessionId = String(body.metadata?.sessionId ?? body.sessionId ?? "");
    if (sessionId.startsWith("agent-explorer-")) {
      response.end(JSON.stringify({
        id: "mock-background-child-final",
        model: body.model,
        content: [{ type: "text", text: "background child done" }],
        toolCalls: [],
        stopReason: "stop"
      }));
      return;
    }

    if (requests.filter((item) => !String(item.sessionId ?? "").startsWith("agent-explorer-")).length === 1) {
      response.end(JSON.stringify({
        id: "mock-background-agent-run",
        model: body.model,
        content: [],
        toolCalls: [
          {
            id: "delegate-background-explorer",
            name: "agent_run",
            input: {
              profile: "explorer",
              query: "inspect current workspace in background",
              background: true,
              groupId: "group-session-bg",
              waitForGroup: "all",
              wakeParent: true
            }
          }
        ],
        stopReason: "tool_calls"
      }));
      return;
    }

    response.end(JSON.stringify({
      id: "mock-background-parent-final",
      model: body.model,
      content: [{ type: "text", text: "background dispatched" }],
      toolCalls: [],
      stopReason: "stop"
    }));
  });
}

/**
 * @param {Array<Record<string, any>>} requests
 */
function createParallelAgentRunGateway(requests) {
  return http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      return;
    }

    const body = await readRequestJson(request);
    requests.push(body);
    response.writeHead(200, { "content-type": "application/json" });

    const sessionId = String(body.metadata?.sessionId ?? body.sessionId ?? "");
    if (sessionId.startsWith("agent-explorer-")) {
      setTimeout(() => {
        response.end(JSON.stringify({
          id: `mock-child-final-${sessionId}`,
          model: body.model,
          content: [{ type: "text", text: `child done ${sessionId}` }],
          toolCalls: [],
          stopReason: "stop"
        }));
      }, sessionId.includes("child-b") ? 10 : 50);
      return;
    }

    if (requests.filter((item) => !String(item.sessionId ?? "").startsWith("agent-explorer-")).length === 1) {
      response.end(JSON.stringify({
        id: "mock-agent-run-parallel",
        model: body.model,
        content: [],
        toolCalls: [
          {
            id: "delegate-explorer-a",
            name: "agent_run",
            input: { profile: "explorer", taskId: "child-a", query: "inspect module A" }
          },
          {
            id: "delegate-explorer-b",
            name: "agent_run",
            input: { profile: "explorer", taskId: "child-b", query: "inspect module B" }
          }
        ],
        stopReason: "tool_calls"
      }));
      return;
    }

    response.end(JSON.stringify({
      id: "mock-final",
      model: body.model,
      content: [{ type: "text", text: "parallel agent results consumed" }],
      toolCalls: [],
      stopReason: "stop"
    }));
  });
}

/**
 * @param {Array<Record<string, any>>} requests
 */
function createDuplicateTaskIdAgentRunGateway(requests) {
  return http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      return;
    }

    const body = await readRequestJson(request);
    requests.push(body);
    response.writeHead(200, { "content-type": "application/json" });

    const sessionId = String(body.metadata?.sessionId ?? body.sessionId ?? "");
    if (sessionId.startsWith("agent-explorer-")) {
      response.end(JSON.stringify({
        id: `mock-duplicate-child-final-${sessionId}`,
        model: body.model,
        content: [{ type: "text", text: `child done ${sessionId}` }],
        toolCalls: [],
        stopReason: "stop"
      }));
      return;
    }

    if (requests.filter((item) => !String(item.sessionId ?? "").startsWith("agent-explorer-")).length === 1) {
      response.end(JSON.stringify({
        id: "mock-agent-run-duplicate-task-ids",
        model: body.model,
        content: [],
        toolCalls: [
          {
            id: "delegate-duplicate-a",
            name: "agent_run",
            input: { profile: "explorer", taskId: "child-same", query: "inspect module A" }
          },
          {
            id: "delegate-duplicate-b",
            name: "agent_run",
            input: { profile: "explorer", taskId: "child-same", query: "inspect module B" }
          }
        ],
        stopReason: "tool_calls"
      }));
      return;
    }

    response.end(JSON.stringify({
      id: "mock-final",
      model: body.model,
      content: [{ type: "text", text: "duplicate task ids consumed" }],
      toolCalls: [],
      stopReason: "stop"
    }));
  });
}

/**
 * @param {Array<Record<string, any>>} requests
 * @param {{ toolRounds: number; toolName: string; input: Record<string, any>; finalText: string }} fixture
 */
function createRepeatedToolGateway(requests, fixture) {
  return http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      return;
    }

    const body = await readRequestJson(request);
    requests.push(body);
    response.writeHead(200, { "content-type": "application/json" });

    if (requests.length <= fixture.toolRounds) {
      response.end(JSON.stringify({
        id: `mock-tool-call-${requests.length}`,
        model: body.model,
        content: [],
        toolCalls: [
          {
            id: `tool-${requests.length}`,
            name: fixture.toolName,
            input: fixture.input
          }
        ],
        stopReason: "tool_calls"
      }));
      return;
    }

    response.end(JSON.stringify({
      id: "mock-final",
      model: body.model,
      content: [{ type: "text", text: fixture.finalText }],
      toolCalls: [],
      stopReason: "stop"
    }));
  });
}

/**
 * @param {Array<Record<string, any>>} requests
 */
function createTodoSyncGateway(requests) {
  return http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      return;
    }

    const body = await readRequestJson(request);
    requests.push(body);
    response.writeHead(200, { "content-type": "application/json" });

    if (requests.length === 1) {
      response.end(JSON.stringify({
        id: "mock-todo-call",
        model: body.model,
        content: [],
        toolCalls: [
          {
            id: "write-todos",
            name: "todo_write",
            input: {
              items: [
                { content: "确认需求", status: "进行中" },
                { content: "汇总结果", status: "待办" }
              ]
            }
          }
        ],
        stopReason: "tool_calls"
      }));
      return;
    }

    response.end(JSON.stringify({
      id: "mock-final",
      model: body.model,
      content: [{ type: "text", text: "全部待办已完成。" }],
      toolCalls: [],
      stopReason: "stop"
    }));
  });
}

/**
 * @param {Array<Record<string, any>>} requests
 */
function createOpenAIStreamingGateway(requests) {
  return http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      return;
    }

    const body = await readRequestJson(request);
    requests.push(body);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('data: {"id":"chatcmpl-live","model":"mock-openai","choices":[{"delta":{"reasoning_content":"checking "}}]}\n\n');
    response.write('data: {"choices":[{"delta":{"content":"hello "}}]}\n\n');
    response.write('data: {"choices":[{"delta":{"content":"world"},"finish_reason":"stop"}]}\n\n');
    response.end("data: [DONE]\n\n");
  });
}

/**
 * @param {Array<Record<string, any>>} requests
 */
function createIncompleteOpenAIThenHealthyGateway(requests) {
  return http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      return;
    }

    const body = await readRequestJson(request);
    requests.push(body);
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (requests.length === 1) {
      response.end('data: {"id":"chatcmpl-incomplete","model":"mock-openai","choices":[{"delta":{"reasoning_content":"I need to see"}}]}\n\n');
      return;
    }

    response.write('data: {"id":"chatcmpl-recovered","model":"mock-openai","choices":[{"delta":{"content":"stream recovered"},"finish_reason":"stop"}]}\n\n');
    response.end("data: [DONE]\n\n");
  });
}

/**
 * @param {Array<Record<string, any>>} requests
 */
function createOpenAIDanglingToolCompactionGateway(requests) {
  return http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      return;
    }

    const body = await readRequestJson(request);
    requests.push(body);
    if (body.messages?.some((message) => String(message.content ?? "").includes("context compactor"))) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "chatcmpl-compact",
        model: body.model,
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: "Compacted older tool context."
            }
          }
        ]
      }));
      return;
    }

    const danglingTool = findDanglingOpenAIToolMessage(body.messages ?? []);
    if (danglingTool) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({
        error: {
          message: "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'",
          type: "invalid_request_error"
        }
      }));
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "chatcmpl-after-compact",
      model: body.model,
      choices: [
        {
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: "after compaction accepted"
          }
        }
      ]
    }));
  });
}

function findDanglingOpenAIToolMessage(messages = []) {
  const pendingToolCallIds = new Set();
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role !== "tool" && pendingToolCallIds.size > 0) {
      return {
        role: "assistant",
        missing_tool_call_ids: Array.from(pendingToolCallIds)
      };
    }
    if (message?.role === "assistant") {
      pendingToolCallIds.clear();
      for (const call of message.tool_calls ?? []) {
        const id = String(call?.id ?? "");
        if (id) {
          pendingToolCallIds.add(id);
        }
      }
      continue;
    }
    if (message?.role === "tool") {
      const id = String(message.tool_call_id ?? "");
      if (!pendingToolCallIds.has(id)) {
        return message;
      }
      pendingToolCallIds.delete(id);
      continue;
    }
    if (message?.role) {
      pendingToolCallIds.clear();
    }
  }
  if (pendingToolCallIds.size > 0) {
    return {
      role: "assistant",
      missing_tool_call_ids: Array.from(pendingToolCallIds)
    };
  }
  return null;
}

/**
 * @param {Array<Record<string, any>>} requests
 */
function createReasoningToolGateway(requests) {
  return http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      return;
    }

    const body = await readRequestJson(request);
    requests.push(body);

    if (requests.length === 1) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"id":"chatcmpl-reasoning-tool","model":"mock-openai","choices":[{"delta":{"reasoning_content":"Need to read notes before answering."}}]}\n\n');
      response.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-read-notes","function":{"name":"read_file","arguments":"{\\"path\\":\\"notes.txt\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n');
      response.end("data: [DONE]\n\n");
      return;
    }

    const assistant = body.messages?.find((message) => message.role === "assistant" && Array.isArray(message.tool_calls));
    if (assistant?.reasoning_content !== "Need to read notes before answering.") {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({
        error: {
          message: "The `reasoning_content` in the thinking mode must be passed back to the API.",
          type: "invalid_request_error"
        }
      }));
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "chatcmpl-reasoning-final",
      model: body.model,
      choices: [
        {
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: "reasoning continuation accepted"
          }
        }
      ]
    }));
  });
}

/**
 * @param {Array<Record<string, any>>} requests
 */
function createLongReasoningToolGateway(requests) {
  return http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      return;
    }

    const body = await readRequestJson(request);
    requests.push(body);

    if (requests.length === 1) {
      const reasoning = `VERY_OLD_REASONING_START${"填充".repeat(160_000)}LATEST_REASONING_TAIL`;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({
        id: "chatcmpl-reasoning-long-tool",
        model: "mock-openai",
        choices: [{ delta: { reasoning_content: reasoning } }]
      })}\n\n`);
      response.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-read-notes","function":{"name":"read_file","arguments":"{\\"path\\":\\"notes.txt\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n');
      response.end("data: [DONE]\n\n");
      return;
    }

    const assistant = body.messages?.find((message) => message.role === "assistant" && Array.isArray(message.tool_calls));
    if (!assistant?.reasoning_content?.endsWith("LATEST_REASONING_TAIL") || assistant.reasoning_content.includes("VERY_OLD_REASONING_START")) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({
        error: {
          message: "Expected trimmed latest reasoning tail.",
          type: "invalid_request_error"
        }
      }));
      return;
    }

    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('data: {"id":"chatcmpl-reasoning-final","model":"mock-openai","choices":[{"delta":{"content":"trimmed reasoning accepted"},"finish_reason":"stop"}]}\n\n');
    response.end("data: [DONE]\n\n");
  });
}

function createReasoningOnlyOpenAIStreamingGateway() {
  return http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      return;
    }

    await readRequestJson(request);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('data: {"id":"chatcmpl-reasoning","model":"mock-openai","choices":[{"delta":{"reasoning_content":"private final text"}}]}\n\n');
    response.write('data: {"choices":[{"delta":{"content":null},"finish_reason":"stop"}]}\n\n');
    response.end("data: [DONE]\n\n");
  });
}

/**
 * @param {Array<Record<string, any>>} requests
 */
function createSlowOpenAIStreamingGateway(requests) {
  return http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      return;
    }

    const body = await readRequestJson(request);
    requests.push(body);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('data: {"id":"chatcmpl-slow","model":"mock-openai","choices":[{"delta":{"role":"assistant","content":"partial "}}]}\n\n');
    const timer = setInterval(() => {
      response.write('data: {"choices":[{"delta":{"content":"more "}}]}\n\n');
    }, 25);
    response.on("close", () => clearInterval(timer));
  });
}

/**
 * @param {Array<Record<string, any>>} requests
 * @param {string} toolName
 * @param {string} command
 */
function createValidationGateway(requests, toolName, command) {
  return http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      return;
    }

    const body = await readRequestJson(request);
    requests.push(body);
    response.writeHead(200, { "content-type": "application/json" });

    if (requests.length === 1) {
      response.end(JSON.stringify({
        id: "mock-tool-call",
        model: body.model,
        content: [{ type: "text", text: "running validation" }],
        toolCalls: [
          {
            id: "validation-tool",
            name: toolName,
            input: { command, timeoutMs: 10_000 }
          }
        ],
        stopReason: "tool_calls"
      }));
      return;
    }

    response.end(JSON.stringify({
      id: `mock-${requests.length}`,
      model: body.model,
      content: [{ type: "text", text: `assistant ${requests.length}` }],
      toolCalls: [],
      stopReason: "stop"
    }));
  });
}

/**
 * @param {http.IncomingMessage} request
 */
async function readRequestJson(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * @param {http.Server} server
 * @param {string} host
 */
function listen(server, host) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

/**
 * @param {http.Server} server
 */
function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve(undefined));
  });
}

async function waitFor(predicate, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("Timed out waiting for condition");
}

/**
 * @param {http.Server} server
 */
function serverUrl(server) {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("server did not expose an address");
  }
  return `http://127.0.0.1:${address.port}`;
}

/**
 * @param {string} url
 */
function mockGatewayEnv(url) {
  return {
    LAB_MODEL_GATEWAY_URL: `${url}/v1/chat`,
    LAB_MODEL_GATEWAY_PROTOCOL: "lab-agent-gateway",
    LAB_AGENT_MODEL: "mock-context",
    LAB_AGENT_NETWORK_MODE: "offline",
    LAB_AGENT_TRANSCRIPT_ENABLED: "false"
  };
}

function mockGatewayEnvWithoutModel(url) {
  const env = mockGatewayEnv(url);
  delete env.LAB_AGENT_MODEL;
  return env;
}
