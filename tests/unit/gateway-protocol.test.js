import assert from "node:assert/strict";
import test from "node:test";
import {
  createOpenAIChatCompletionRequest,
  normalizeOpenAIChatCompletionResponse,
  parseOpenAIChatCompletionStream
} from "../../src/model-gateway/openai-chat.js";
import { DEFAULT_THINKING_PREVIEW_BYTES } from "../../src/model-gateway/thinking-budget.js";
import { createGatewayRequest, normalizeGatewayResponse } from "../../src/model-gateway/protocol.js";
import { parseGatewayStream } from "../../src/model-gateway/streaming.js";
import { GATEWAY_MAX_STREAM_RECORD_BYTES } from "../../src/model-gateway/limits.js";

test("creates provider-independent gateway requests", () => {
  const request = createGatewayRequest({
    model: "lab-default",
    messages: [{ role: "user", content: "hello" }],
    tools: [{ name: "read_file" }],
    toolResults: [{ toolCallId: "tool-1", content: "{}" }],
    sessionId: "session-1"
  });

  assert.equal(request.protocolVersion, "lab-agent-gateway.v1");
  assert.equal(request.model, "lab-default");
  assert.equal(request.metadata.client, "lab-agent");
  assert.equal(request.metadata.sessionId, "session-1");
  assert.deepEqual(request.metadata.capabilities, {
    tools: true,
    toolResults: true,
    streaming: false
  });
  assert.deepEqual(request.metadata.boundary, {
    toolExecution: "local-client",
    providerCredentials: "gateway-only",
    remoteTools: false
  });
  assert.deepEqual(request.metadata.request, {
    messageCount: 1,
    toolCount: 1,
    toolResultCount: 1
  });
  assert.equal(request.tools.length, 1);
  assert.equal(request.toolResults.length, 1);
});

test("normalizes JSON gateway responses", () => {
  const response = normalizeGatewayResponse({
    id: "msg-1",
    model: "resolved",
    content: [{ type: "text", text: "hello" }],
    toolCalls: [{ name: "read_file", input: { path: "README.md" } }],
    usage: { promptBytes: 3 }
  });

  assert.equal(response.id, "msg-1");
  assert.equal(response.text, "hello");
  assert.equal(response.toolCalls[0].id, "tool-1");
  assert.equal(response.toolCalls[0].name, "read_file");
  assert.equal(response.usage?.promptBytes, 3);
});

test("creates OpenAI-compatible chat completion requests", () => {
  const request = createOpenAIChatCompletionRequest({
    model: "example-fast-model",
    messages: [
      { role: "system", content: [{ type: "text", text: "local tools only" }] },
      { role: "user", content: "read README.md" },
      {
        role: "assistant",
        content: [],
        toolCalls: [{ id: "call-1", name: "read_file", input: { path: "README.md" } }]
      },
      {
        role: "tool",
        toolCallId: "call-1",
        name: "read_file",
        content: [{ type: "text", text: "{\"ok\":true}" }]
      }
    ],
    toolResults: [
      {
        toolCallId: "call-1",
        name: "read_file",
        content: "{\"ok\":true}"
      }
    ],
    tools: [
      {
        name: "read_file",
        description: "Read a file",
        inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string" } } }
      }
    ]
  });

  assert.equal(request.model, "example-fast-model");
  assert.equal(request.messages[0].content, "local tools only");
  assert.equal(request.messages[2].tool_calls[0].function.name, "read_file");
  assert.equal(request.messages[2].tool_calls[0].function.arguments, "{\"path\":\"README.md\"}");
  assert.equal(request.messages[3].role, "tool");
  assert.equal(request.messages[3].tool_call_id, "call-1");
  assert.equal(request.messages.filter((message) => message.role === "tool").length, 1);
  assert.equal(request.tools[0].type, "function");
  assert.equal(request.tool_choice, undefined);

  const forcedToolChoiceRequest = createOpenAIChatCompletionRequest({
    model: "example-fast-model",
    messages: [{ role: "user", content: "read README.md" }],
    toolChoice: "required",
    tools: [
      {
        name: "read_file",
        inputSchema: { type: "object", properties: { path: { type: "string" } } }
      }
    ]
  });
  assert.equal(forcedToolChoiceRequest.tool_choice, "required");

  const streamRequest = createOpenAIChatCompletionRequest({
    model: "example-fast-model",
    messages: [{ role: "user", content: "hello" }],
    stream: true
  });
  assert.deepEqual(streamRequest.stream_options, { include_usage: true });
});

test("OpenAI-compatible requests preserve assistant reasoning_content for tool call continuations", () => {
  const request = createOpenAIChatCompletionRequest({
    model: "example-reasoner",
    messages: [
      { role: "user", content: "inspect" },
      {
        role: "assistant",
        content: [],
        thinking: { text: "I should inspect the file first." },
        toolCalls: [{ id: "call-1", name: "read_file", input: { path: "README.md" } }]
      },
      {
        role: "tool",
        toolCallId: "call-1",
        content: [{ type: "text", text: "{\"ok\":true}" }]
      }
    ],
    tools: [
      {
        name: "read_file",
        inputSchema: { type: "object", properties: { path: { type: "string" } } }
      }
    ]
  });

  assert.equal(request.messages[1].reasoning_content, "I should inspect the file first.");
  assert.equal(request.messages[1].tool_calls[0].id, "call-1");
});

test("OpenAI-compatible requests include configured provider extra_body", () => {
  const extraBody = { thinking: { type: "enabled" } };
  const request = createOpenAIChatCompletionRequest({
    model: "example-coding-model",
    messages: [{ role: "user", content: "use thinking" }],
    extraBody
  });

  assert.deepEqual(request.thinking, { type: "enabled" });
  assert.equal(request.extra_body, undefined);
  assert.notEqual(request.thinking, extraBody.thinking);
});

test("OpenAI-compatible requests map user image blocks to image_url content", () => {
  const request = createOpenAIChatCompletionRequest({
    model: "example-coding-model",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "describe this image" },
        { type: "image", mimeType: "image/png", data: "aGVsbG8=", name: "sample.png" }
      ]
    }]
  });

  assert.deepEqual(request.messages[0].content, [
    { type: "text", text: "describe this image" },
    { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } }
  ]);
});

test("OpenAI-compatible requests keep only the latest oversized assistant reasoning_content", () => {
  const prefix = "old-".repeat(80_000);
  const suffix = "LATEST_REASONING_TAIL";
  const request = createOpenAIChatCompletionRequest({
    model: "example-reasoner",
    messages: [
      { role: "user", content: "inspect" },
      {
        role: "assistant",
        content: [],
        thinking: { text: `${prefix}${suffix}` },
        toolCalls: [{ id: "call-1", name: "read_file", input: { path: "README.md" } }]
      }
    ]
  });

  const reasoning = request.messages[1].reasoning_content;
  assert.equal(Buffer.byteLength(reasoning, "utf8") <= DEFAULT_THINKING_PREVIEW_BYTES, true);
  assert.equal(reasoning.endsWith(suffix), true);
  assert.equal(reasoning.startsWith("old-old-old-"), false);
});

test("normalizes OpenAI-compatible chat completion responses", () => {
  const response = normalizeOpenAIChatCompletionResponse({
    id: "chatcmpl-1",
    model: "resolved",
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: "checking",
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: {
                name: "read_file",
                arguments: "{\"path\":\"README.md\",\"maxBytes\":1024}"
              }
            }
          ]
        }
      }
    ],
    usage: { prompt_tokens: 10, completion_tokens: 2 }
  });

  assert.equal(response.id, "chatcmpl-1");
  assert.equal(response.model, "resolved");
  assert.equal(response.text, "checking");
  assert.equal(response.stopReason, "tool_calls");
  assert.deepEqual(response.toolCalls, [
    {
      id: "call-1",
      name: "read_file",
      input: { path: "README.md", maxBytes: 1024 }
    }
  ]);
  assert.equal(response.usage?.prompt_tokens, 10);
});

test("normalizes concatenated OpenAI-compatible tool arguments", () => {
  const response = normalizeOpenAIChatCompletionResponse({
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: {
                name: "read_file",
                arguments: "{}{\"path\":\"README.md\"}"
              }
            }
          ]
        }
      }
    ]
  });

  assert.deepEqual(response.toolCalls[0].input, { path: "README.md" });
});

test("parses OpenAI-compatible JSON returned with a stream content type", async () => {
  const body = streamFromText(JSON.stringify({
    id: "chatcmpl-json",
    model: "resolved",
    choices: [
      {
        finish_reason: "stop",
        message: {
          role: "assistant",
          content: "plain json"
        }
      }
    ]
  }));

  const response = await parseOpenAIChatCompletionStream(body);

  assert.equal(response.id, "chatcmpl-json");
  assert.equal(response.text, "plain json");
  assert.equal(response.stopReason, "stop");
});

test("parses OpenAI-compatible SSE deltas", async () => {
  const body = streamFromText([
    'data: {"id":"chatcmpl-stream","model":"resolved","choices":[{"delta":{"role":"assistant","content":"hel"}}]}',
    "",
    'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}',
    "",
    "data: [DONE]",
    ""
  ].join("\n"));

  const response = await parseOpenAIChatCompletionStream(body);

  assert.equal(response.id, "chatcmpl-stream");
  assert.equal(response.model, "resolved");
  assert.equal(response.text, "hello");
  assert.equal(response.stopReason, "stop");
});

test("emits OpenAI-compatible stream events while parsing", async () => {
  const events = [];
  const body = streamFromText([
    'data: {"id":"chatcmpl-stream","model":"resolved","choices":[{"delta":{"reasoning_content":"checking "}}]}',
    "",
    'data: {"choices":[{"delta":{"content":"hel"}}]}',
    "",
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"read_file","arguments":"{\\"path\\":"}}]}}]}',
    "",
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"README.md\\"}"}}]},"finish_reason":"tool_calls"}]}',
    "",
    'data: {"choices":[],"usage":{"prompt_tokens":21,"completion_tokens":3,"total_tokens":24}}',
    "",
    "data: [DONE]",
    ""
  ].join("\n"));

  const response = await parseOpenAIChatCompletionStream(body, {
    onEvent: (event) => events.push(event)
  });

  assert.equal(response.text, "hel");
  assert.equal(response.stopReason, "tool_calls");
  assert.deepEqual(response.toolCalls, [
    {
      id: "call-1",
      name: "read_file",
      input: { path: "README.md" }
    }
  ]);
  assert.equal(response.usage?.prompt_tokens, 21);
  assert.equal(response.usage?.completion_tokens, 3);
  assert.deepEqual(events.map((event) => event.type), [
    "message_start",
    "thinking_delta",
    "text_delta",
    "tool_call_delta",
    "tool_call_delta",
    "message_stop"
  ]);
  assert.equal(events.find((event) => event.type === "thinking_delta").text, "checking ");
  assert.equal(events.find((event) => event.type === "text_delta").text, "hel");
});

test("OpenAI-compatible streams summarize reasoning-only chunks without raw transcript leaks", async () => {
  const body = streamFromText([
    'data: {"id":"chatcmpl-reasoning","model":"resolved","choices":[{"delta":{"reasoning_content":"private visible-looking text"}}]}',
    "",
    'data: {"choices":[{"delta":{"content":null},"finish_reason":"stop"}]}',
    "",
    "data: [DONE]",
    ""
  ].join("\n"));

  const response = await parseOpenAIChatCompletionStream(body);

  assert.equal(response.text, "");
  assert.equal(response.stopReason, "stop");
  assert.equal(response.raw.protocol, "openai-chat-stream");
  assert.equal(response.raw.thinkingBytes > 0, true);
  assert.equal("private visible-looking text" in response.raw, false);
  assert.equal(JSON.stringify(response.raw).includes("private visible-looking text"), false);
});

test("OpenAI-compatible streams keep latest thinking preview while counting total bytes", async () => {
  const old = "旧".repeat(160_000);
  const tail = "最新推理尾部";
  const body = streamFromText([
    `data: ${JSON.stringify({ id: "chatcmpl-long-reasoning", model: "resolved", choices: [{ delta: { reasoning_content: old } }] })}`,
    "",
    `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: tail }, finish_reason: "stop" }] })}`,
    "",
    "data: [DONE]",
    ""
  ].join("\n"));

  const response = await parseOpenAIChatCompletionStream(body);

  assert.equal(Buffer.byteLength(response.thinkingText, "utf8") <= DEFAULT_THINKING_PREVIEW_BYTES, true);
  assert.equal(response.thinkingText.endsWith(tail), true);
  assert.equal(response.raw.thinkingBytes > DEFAULT_THINKING_PREVIEW_BYTES, true);
  assert.equal(response.raw.thinkingTruncated, true);
});

test("OpenAI-compatible streams can explicitly treat reasoning-only chunks as visible text", async () => {
  const body = streamFromText([
    'data: {"id":"chatcmpl-reasoning","model":"example-coding-model","choices":[{"delta":{"reasoning_content":"正常中文报告"}}]}',
    "",
    'data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}]}',
    "",
    "data: [DONE]",
    ""
  ].join("\n"));

  const response = await parseOpenAIChatCompletionStream(body, {
    reasoningContentMode: "visible-when-no-content"
  });

  assert.equal(response.text, "正常中文报告");
  assert.equal(response.content[0].text, "正常中文报告");
  assert.equal(response.thinkingText, "正常中文报告");
  assert.equal(response.raw.visibleReasoningBytes > 0, true);
  assert.equal(JSON.stringify(response.raw).includes("正常中文报告"), false);
});

test("OpenAI-compatible stream rejects clean EOF without DONE or finish_reason", async () => {
  const body = streamFromText(`data: ${JSON.stringify({
    id: "chatcmpl-incomplete-eof",
    model: "mimo-v2.5-pro",
    choices: [{ delta: { reasoning_content: "I need to inspect the file. I need to see" } }]
  })}`);

  await assert.rejects(
    parseOpenAIChatCompletionStream(body),
    (error) => error?.code === "UPSTREAM_STREAM_ABORTED"
      && error?.retryable === true
      && error?.details?.reason === "missing_done_and_finish_reason"
  );
});

test("OpenAI-compatible stream accepts finish_reason without a DONE sentinel", async () => {
  const body = streamFromText(`data: ${JSON.stringify({
    id: "chatcmpl-finish-no-done",
    model: "resolved",
    choices: [{ delta: { content: "complete" }, finish_reason: "stop" }]
  })}`);

  const response = await parseOpenAIChatCompletionStream(body);
  assert.equal(response.text, "complete");
  assert.equal(response.stopReason, "stop");
});

test("OpenAI-compatible stream rejects tool_calls finish without a valid call", async () => {
  const body = streamFromText(`data: ${JSON.stringify({
    choices: [{ delta: {}, finish_reason: "tool_calls" }]
  })}`);

  await assert.rejects(
    parseOpenAIChatCompletionStream(body),
    (error) => error?.code === "INCOMPLETE_TOOL_CALL"
      && error?.retryable === true
      && error?.details?.reason === "finish_without_valid_tool_call"
  );
});

test("OpenAI-compatible stream rejects incomplete structured tool arguments", async () => {
  for (const argumentsText of ["{", '{"outer":{"path":']) {
    const body = streamFromText(`data: ${JSON.stringify({
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: "call-incomplete",
            function: { name: "read_file", arguments: argumentsText }
          }]
        },
        finish_reason: "tool_calls"
      }]
    })}`);

    await assert.rejects(
      parseOpenAIChatCompletionStream(body),
      (error) => error?.code === "INCOMPLETE_TOOL_CALL"
        && error?.retryable === true
        && error?.details?.reason === "incomplete_tool_arguments"
        && error?.details?.toolName === "read_file"
    );
  }
});

test("OpenAI-compatible stream recovers the last complete tool arguments object", async () => {
  const body = streamFromText(`data: ${JSON.stringify({
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: "call-recovered",
          function: { name: "read_file", arguments: '{}{"path":"README.md"}' }
        }]
      },
      finish_reason: "tool_calls"
    }]
  })}`);

  const response = await parseOpenAIChatCompletionStream(body);
  assert.deepEqual(response.toolCalls, [{
    id: "call-recovered",
    name: "read_file",
    input: { path: "README.md" }
  }]);
});

test("parses text/event-stream gateway responses", async () => {
  const body = streamFromText([
    'data: {"type":"message_start","id":"msg-1","model":"resolved"}',
    "",
    'data: {"type":"text_delta","text":"hel"}',
    "",
    'data: {"type":"text_delta","text":"lo"}',
    "",
    'data: {"type":"message_stop","stopReason":"stop"}',
    "",
    "data: [DONE]",
    ""
  ].join("\n"));

  const response = await parseGatewayStream(body, "text/event-stream");
  assert.equal(response.id, "msg-1");
  assert.equal(response.model, "resolved");
  assert.equal(response.text, "hello");
  assert.equal(response.stopReason, "stop");
});

test("gateway SSE stream emits text deltas before the stream closes", async () => {
  const encoder = new TextEncoder();
  let controller;
  const body = new ReadableStream({
    start(nextController) {
      controller = nextController;
    }
  });
  const events = [];
  const parsed = parseGatewayStream(body, "text/event-stream", {
    onEvent: (event) => events.push(event)
  });

  controller.enqueue(encoder.encode('data: {"type":"message_start","id":"msg-live","model":"resolved"}\n\n'));
  controller.enqueue(encoder.encode('data: {"type":"text_delta","text":"live"}\n\n'));
  await waitFor(() => events.some((event) => event.type === "text_delta"));

  assert.equal(events.find((event) => event.type === "text_delta")?.text, "live");
  controller.enqueue(encoder.encode('data: {"type":"message_stop","stopReason":"stop"}\n\n'));
  controller.enqueue(encoder.encode("data: [DONE]\n\n"));
  controller.close();

  const response = await parsed;
  assert.equal(response.text, "live");
  assert.equal(response.stopReason, "stop");
});

test("gateway stream event callbacks have a hard completion deadline", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"text_delta","text":"blocked"}\n\n'));
    },
    cancel() {
      cancelled = true;
    }
  });

  await assert.rejects(
    parseGatewayStream(body, "text/event-stream", {
      eventTimeoutMs: 20,
      onEvent: () => new Promise(() => {})
    }),
    (error) => error?.code === "GATEWAY_EVENT_CALLBACK_TIMEOUT"
  );
  assert.equal(cancelled, true);
});

test("gateway stream cancellation interrupts a pending event callback", async () => {
  let callbackStartedResolve;
  const callbackStarted = new Promise((resolve) => {
    callbackStartedResolve = resolve;
  });
  const controller = new AbortController();
  const body = streamFromText('data: {"type":"text_delta","text":"blocked"}\n\n');
  const parsed = parseGatewayStream(body, "text/event-stream", {
    signal: controller.signal,
    eventTimeoutMs: 1000,
    onEvent: () => {
      callbackStartedResolve();
      return new Promise(() => {});
    }
  });

  await callbackStarted;
  controller.abort();
  await assert.rejects(parsed, (error) => error?.name === "AbortError");
});

test("OpenAI stream cancellation interrupts a pending event callback", async () => {
  let callbackStartedResolve;
  const callbackStarted = new Promise((resolve) => {
    callbackStartedResolve = resolve;
  });
  const controller = new AbortController();
  const body = streamFromText([
    'data: {"id":"chatcmpl-blocked","choices":[{"delta":{"content":"blocked"}}]}',
    "",
    "data: [DONE]",
    ""
  ].join("\n"));
  const parsed = parseOpenAIChatCompletionStream(body, {
    signal: controller.signal,
    eventTimeoutMs: 1000,
    onEvent: () => {
      callbackStartedResolve();
      return new Promise(() => {});
    }
  });

  await callbackStarted;
  controller.abort();
  await assert.rejects(parsed, (error) => error?.name === "AbortError");
});

test("gateway signal-only cancellation interrupts a pending stream read", async () => {
  let cancelled = false;
  const controller = new AbortController();
  const body = new ReadableStream({
    cancel() {
      cancelled = true;
    }
  });
  const parsed = parseGatewayStream(body, "text/event-stream", {
    signal: controller.signal
  });

  await waitFor(() => body.locked);
  controller.abort();
  await assert.rejects(parsed, (error) => error?.name === "AbortError");
  await waitFor(() => cancelled && !body.locked);
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});

test("OpenAI signal-only cancellation interrupts a pending stream read", async () => {
  let cancelled = false;
  const controller = new AbortController();
  const body = new ReadableStream({
    cancel() {
      cancelled = true;
    }
  });
  const parsed = parseOpenAIChatCompletionStream(body, {
    signal: controller.signal
  });

  await waitFor(() => body.locked);
  controller.abort();
  await assert.rejects(parsed, (error) => error?.name === "AbortError");
  await waitFor(() => cancelled && !body.locked);
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});

test("gateway rejects and releases an oversized stream record", async () => {
  let cancelled = false;
  const oversized = `${JSON.stringify({
    type: "text_delta",
    text: "x".repeat(GATEWAY_MAX_STREAM_RECORD_BYTES)
  })}\n`;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(oversized));
    },
    cancel() {
      cancelled = true;
    }
  });

  await assert.rejects(
    parseGatewayStream(body, "application/x-ndjson"),
    (error) => error?.code === "GATEWAY_STREAM_RECORD_TOO_LARGE"
      && error.maxBytes === GATEWAY_MAX_STREAM_RECORD_BYTES
      && error.retryable === false
  );
  await waitFor(() => cancelled && !body.locked);
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});

test("gateway limit rejection does not await a stalled cancel promise", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(2));
    },
    cancel() {
      cancelled = true;
      return new Promise(() => {});
    }
  });
  const parsed = parseGatewayStream(body, "application/x-ndjson", {
    maxResponseBytes: 1
  });

  await assert.rejects(
    Promise.race([
      parsed,
      new Promise((_, reject) => setTimeout(() => reject(new Error("limit rejection timed out")), 500))
    ]),
    (error) => error?.code === "GATEWAY_RESPONSE_TOO_LARGE"
  );
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});

test("gateway stream event callback errors remain visible", async () => {
  const expected = new Error("observer failed");
  for (const cancel of [
    () => {
      throw new Error("cancel failed synchronously");
    },
    () => Promise.reject(new Error("cancel failed asynchronously"))
  ]) {
    let cancelCalled = false;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"text_delta","text":"blocked"}\n\n'));
      },
      cancel() {
        cancelCalled = true;
        return cancel();
      }
    });
    await assert.rejects(
      parseGatewayStream(body, "text/event-stream", {
        onEvent: () => {
          throw expected;
        }
      }),
      expected
    );
    assert.equal(cancelCalled, true);
  }
});

/**
 * @param {string} text
 */
function streamFromText(text) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    }
  });
}

async function waitFor(predicate) {
  const started = Date.now();
  while (Date.now() - started < 1000) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for predicate");
}
