import assert from "node:assert/strict";
import test from "node:test";
import { createInternalAgentRequest } from "../../src/agents/internal.js";
import { buildCompactedContextMessage, clearSessionContext, compactSessionContext, compactSessionContextWithModel, createContextWindow, estimatePromptPayload, estimateTokensFromBytes, summarizeContextWindow } from "../../src/core/context-window.js";
import { compactInFlightToolMessages } from "../../src/core/inflight-compaction.js";

test("context window compacts older messages into a bounded redacted summary", () => {
  const session = {
    config: {
      context: {
        maxMessages: 4,
        maxBytes: 4096,
        keepRecentMessages: 2,
        summaryBytes: 2048
      }
    },
    contextWindow: createContextWindow({
      context: {
        maxMessages: 4,
        maxBytes: 4096,
        keepRecentMessages: 2,
        summaryBytes: 2048
      }
    }),
    messages: [
      { role: "user", content: "token=super-secret path=C:\\private\\file.txt" },
      { role: "assistant", content: [{ type: "text", text: "noted" }] },
      { role: "user", content: "recent question" },
      { role: "assistant", content: [{ type: "text", text: "recent answer" }] },
      { role: "user", content: "new question" }
    ]
  };

  const result = compactSessionContext(session);
  const summary = summarizeContextWindow(session);
  const message = buildCompactedContextMessage(session);

  assert.equal(result.compacted, true);
  assert.equal(result.strategy, "local");
  assert.equal(session.messages.length, 3);
  assert.equal(summary.compacted, 1);
  assert.equal(summary.compactedMessages, 2);
  assert.match(message.content[0].text, /compacted conversation context/);
  assert.doesNotMatch(message.content[0].text, /super-secret/);
  assert.match(message.content[0].text, /token=\[redacted\]/);
  assert.match(message.content[0].text, /path=C:\\private\\file\.txt/);
});

test("model compaction summarizes older messages through the configured gateway", async () => {
  const requests = [];
  const session = {
    id: "session-model-compact",
    config: {
      context: {
        maxMessages: 4,
        maxBytes: 4096,
        keepRecentMessages: 2,
        summaryBytes: 2048
      }
    },
    contextWindow: createContextWindow({
      context: {
        maxMessages: 4,
        maxBytes: 4096,
        keepRecentMessages: 2,
        summaryBytes: 2048
      }
    }),
    messages: [
      { role: "user", content: "早期目标 token=super-secret path=C:\\private\\paper.txt" },
      { role: "assistant", content: [{ type: "text", text: "早期结论" }] },
      { role: "user", content: "recent question" },
      { role: "assistant", content: [{ type: "text", text: "recent answer" }] },
      { role: "user", content: "new question" }
    ]
  };
  const gateway = {
    configured: true,
    async sendChat(request) {
      requests.push(request);
      return {
        ok: true,
        data: {
          model: "mock-summarizer",
          text: "模型摘要：保留早期目标和早期结论，继续处理 new question。token=exposed path=C:\\private\\paper.txt"
        }
      };
    }
  };

  const result = await compactSessionContextWithModel(session, {
    force: true,
    reason: "manual",
    gateway
  });

  assert.equal(result.compacted, true);
  assert.equal(result.strategy, "agent:compaction");
  assert.equal(result.internalAgent, "compaction");
  assert.equal(result.model, "mock-summarizer");
  assert.equal(session.messages.length, 3);
  assert.equal(session.contextWindow.lastStrategy, "agent:compaction");
  assert.equal(session.contextWindow.lastInternalAgent, "compaction");
  assert.match(session.contextWindow.summary, /模型摘要/);
  assert.doesNotMatch(session.contextWindow.summary, /super-secret|exposed/);
  assert.match(session.contextWindow.summary, /token=\[redacted\]/);
  assert.match(session.contextWindow.summary, /path=C:\\private\\paper\.txt/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].tools.length, 0);
  assert.match(requests[0].messages[0].content[0].text, /context compactor/);
  assert.match(requests[0].messages[1].content, /Older messages to compact/);
  assert.match(requests[0].messages[1].content, /Conversation spine to preserve/);
  assert.match(requests[0].messages[1].content, /## Conversation spine/);
  assert.match(requests[0].messages[1].content, /Summarize large tool outputs/);
  assert.doesNotMatch(requests[0].messages[1].content, /super-secret/);
  assert.match(requests[0].messages[1].content, /path=C:\\private\\paper\.txt/);
});

test("internal compaction agent keeps full selected input by default", () => {
  const sentinel = "KEEP_FULL_COMPACTION_INPUT_SENTINEL";
  const input = `${"older context ".repeat(900)}${sentinel}`;

  const result = createInternalAgentRequest({
    profileName: "compaction",
    task: "Create a durable compacted conversation summary.",
    input
  });

  assert.equal(result.ok, true);
  const userPrompt = result.request.messages[1].content;
  assert.match(userPrompt, new RegExp(sentinel));
  assert.doesNotMatch(userPrompt, /\[internal input truncated\]/);
});

test("model compaction preserves summaries beyond the old 8KB ceiling", async () => {
  const longSection = "durable detail ".repeat(900);
  const summaryText = [
    "## Goal",
    "Preserve a long-running task handoff.",
    "## Conversation spine",
    longSection,
    "## Open questions and next steps",
    "LONG_SUMMARY_AFTER_8KB_SENTINEL"
  ].join("\n");
  const session = {
    id: "session-large-model-compact",
    config: {},
    contextWindow: createContextWindow(),
    messages: [
      { role: "user", content: "older request" },
      { role: "assistant", content: [{ type: "text", text: "older final reply" }] },
      { role: "user", content: "current request" }
    ]
  };
  const gateway = {
    configured: true,
    async sendChat() {
      return {
        ok: true,
        data: {
          model: "mock-summarizer",
          text: summaryText
        }
      };
    }
  };

  const result = await compactSessionContextWithModel(session, {
    force: true,
    reason: "manual",
    keepRecentMessages: 1,
    gateway
  });

  assert.equal(result.compacted, true);
  assert.ok(result.summaryBytes > 8192);
  assert.match(session.contextWindow.summary, /^## Goal/);
  assert.match(session.contextWindow.summary, /LONG_SUMMARY_AFTER_8KB_SENTINEL/);
  assert.doesNotMatch(session.contextWindow.summary, /\[earlier compacted context omitted\]/);
});

test("model compaction falls back to local compaction when the gateway is unavailable", async () => {
  const session = {
    config: {
      context: {
        maxMessages: 4,
        keepRecentMessages: 1,
        summaryBytes: 2048
      }
    },
    contextWindow: createContextWindow({
      context: {
        maxMessages: 4,
        keepRecentMessages: 1,
        summaryBytes: 2048
      }
    }),
    messages: [
      { role: "user", content: "first" },
      { role: "assistant", content: "second" }
    ]
  };

  const result = await compactSessionContextWithModel(session, {
    force: true,
    reason: "manual",
    gateway: { configured: false }
  });

  assert.equal(result.compacted, true);
  assert.equal(result.strategy, "local");
  assert.equal(result.fallbackReason, "gateway_not_configured");
  assert.equal(session.contextWindow.lastStrategy, "local");
  assert.equal(session.contextWindow.lastFallbackReason, "gateway_not_configured");
});

test("clearSessionContext removes compacted summary and recent messages", () => {
  const session = {
    config: {},
    contextWindow: createContextWindow(),
    messages: [
      { role: "user", content: "old" },
      { role: "assistant", content: [{ type: "text", text: "older" }] },
      { role: "user", content: "recent" }
    ]
  };

  compactSessionContext(session, { force: true, keepRecentMessages: 1 });
  assert.equal(buildCompactedContextMessage(session).role, "system");

  const summary = clearSessionContext(session);

  assert.equal(session.messages.length, 0);
  assert.equal(summary.hasSummary, false);
  assert.equal(buildCompactedContextMessage(session), null);
});

test("context summaries expose local token budget and configured model window", () => {
  const config = {
    modelAlias: "local-large",
    models: [
      {
        id: "local-large",
        contextTokens: 128000
      }
    ],
    context: {
      maxMessages: 20,
      maxBytes: 4000,
      maxTokens: 1000,
      keepRecentMessages: 4,
      summaryBytes: 1024
    }
  };
  const session = {
    config,
    contextWindow: createContextWindow(config),
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "world" }] }
    ]
  };

  const summary = summarizeContextWindow(session);

  assert.equal(summary.maxTokens, 1000);
  assert.equal(summary.modelMaxTokens, 128000);
  assert.equal(summary.messageTokens, estimateTokensFromBytes(summary.messageBytes));
});

test("prompt payload estimates include tools and tool results shown to the model", () => {
  const toolResultText = "file content\n".repeat(200);
  const estimate = estimatePromptPayload({
    messages: [
      { role: "system", content: [{ type: "text", text: "system prompt" }] },
      { role: "user", content: "read file" },
      { role: "tool", toolCallId: "read-1", name: "read_file", content: [{ type: "text", text: toolResultText }] }
    ],
    tools: [{ name: "read_file", description: "Read", inputSchema: { type: "object" } }],
    toolResults: [{ toolCallId: "read-1", name: "read_file", content: toolResultText }]
  });
  const session = {
    config: {},
    contextWindow: createContextWindow(),
    messages: [{ role: "user", content: "read file" }],
    lastPromptEstimate: { ...estimate, round: 2, source: "local-estimate" }
  };
  const summary = summarizeContextWindow(session);

  assert.ok(estimate.toolResultTokens > 0);
  assert.ok(estimate.tokens > summary.messageTokens);
  assert.equal(summary.promptTokens, estimate.tokens);
  assert.equal(summary.promptToolResultTokens, estimate.toolResultTokens);
});

test("OpenAI-compatible prompt estimates do not double-count represented tool results", () => {
  const toolResultText = "file content\n".repeat(200);
  const base = {
    messages: [
      { role: "system", content: [{ type: "text", text: "system prompt" }] },
      { role: "user", content: "read file" },
      { role: "assistant", content: [], toolCalls: [{ id: "read-1", name: "read_file", input: { path: "a.txt" } }] },
      { role: "tool", toolCallId: "read-1", name: "read_file", content: [{ type: "text", text: toolResultText }] }
    ],
    tools: [{ name: "read_file", description: "Read", inputSchema: { type: "object" } }],
    toolResults: [{ toolCallId: "read-1", name: "read_file", content: toolResultText }]
  };

  const labEstimate = estimatePromptPayload(base);
  const openAiEstimate = estimatePromptPayload({
    ...base,
    gatewayProtocol: "openai-chat"
  });

  assert.ok(labEstimate.toolResultTokens > 0);
  assert.equal(openAiEstimate.toolResultTokens, 0);
  assert.ok(openAiEstimate.tokens < labEstimate.tokens);
});

test("automatic compaction is token-budget driven by default", () => {
  const quietSession = {
    config: {},
    contextWindow: createContextWindow(),
    messages: Array.from({ length: 25 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `small message ${index}`
    }))
  };

  const quietResult = compactSessionContext(quietSession);

  assert.equal(quietSession.contextWindow.maxTokens, 200000);
  assert.equal(quietResult.compacted, false);

  const tokenSession = {
    config: {
      context: {
        maxMessages: 100000,
        maxBytes: 800000,
        maxTokens: 10,
        keepRecentMessages: 1,
        summaryBytes: 1024
      }
    },
    contextWindow: createContextWindow({
      context: {
        maxMessages: 100000,
        maxBytes: 800000,
        maxTokens: 10,
        keepRecentMessages: 1,
        summaryBytes: 1024
      }
    }),
    messages: [
      { role: "user", content: "one two three four five six seven eight nine ten" },
      { role: "assistant", content: "answer" }
    ]
  };

  const tokenResult = compactSessionContext(tokenSession);

  assert.equal(tokenResult.compacted, true);
  assert.ok(tokenResult.beforeTokens >= 10);
  assert.equal(tokenSession.messages.length, 1);
});

test("compaction keeps recent user turns with a token budget instead of only message count", () => {
  const session = {
    config: {
      context: {
        maxMessages: 100000,
        maxBytes: 800000,
        maxTokens: 40,
        keepRecentMessages: 1,
        tailTurns: 2,
        preserveRecentTokens: 200,
        summaryBytes: 2048
      }
    },
    contextWindow: createContextWindow({
      context: {
        maxMessages: 100000,
        maxBytes: 800000,
        maxTokens: 40,
        keepRecentMessages: 1,
        tailTurns: 2,
        preserveRecentTokens: 200,
        summaryBytes: 2048
      }
    }),
    messages: [
      { role: "user", content: "old question" },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "recent question one" },
      { role: "assistant", content: "recent answer one" },
      { role: "user", content: "recent question two" },
      { role: "assistant", content: "recent answer two" }
    ]
  };

  const result = compactSessionContext(session);

  assert.equal(result.compacted, true);
  assert.deepEqual(session.messages.map((message) => message.content), [
    "recent question one",
    "recent answer one",
    "recent question two",
    "recent answer two"
  ]);
  assert.match(session.contextWindow.summary, /old question/);
});

test("in-flight compaction summarizes older tool results before context limit", () => {
  const longContent = "source evidence ".repeat(400);
  const messages = [
    { role: "system", content: [{ type: "text", text: "system" }] },
    { role: "assistant", content: [], toolCalls: [{ id: "fetch-1", name: "web_fetch", input: {} }] },
    {
      role: "tool",
      toolCallId: "fetch-1",
      name: "web_fetch",
      content: [{
        type: "text",
        text: JSON.stringify({
          ok: true,
          result: {
            url: "https://example.com/a",
            status: 200,
            bytes: longContent.length,
            content: longContent
          }
        })
      }]
    },
    { role: "assistant", content: [], toolCalls: [{ id: "fetch-2", name: "web_fetch", input: {} }] },
    {
      role: "tool",
      toolCallId: "fetch-2",
      name: "web_fetch",
      content: [{
        type: "text",
        text: JSON.stringify({
          ok: true,
          result: {
            url: "https://example.com/b",
            status: 200,
            bytes: 5,
            content: "fresh"
          }
        })
      }]
    }
  ];

  const result = compactInFlightToolMessages(messages, {
    maxTokens: 100,
    triggerRatio: 0.1,
    keepRecentTools: 1,
    maxToolTextChars: 500
  });

  const olderTool = messages[2].content[0].text;
  const recentTool = messages[4].content[0].text;
  assert.equal(result.compacted, true);
  assert.equal(result.compactedTools, 1);
  assert.ok(result.afterTokens < result.beforeTokens);
  assert.match(olderTool, /\[compacted tool result\]/);
  assert.match(olderTool, /https:\/\/example.com\/a/);
  assert.ok(olderTool.length < longContent.length / 2);
  assert.match(recentTool, /fresh/);
});
