import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMockGatewayServer } from "../../scripts/mock-gateway.js";
import { createLabModelGateway } from "../../src/model-gateway/client.js";
import { formatGatewayError, normalizeGatewayError } from "../../src/model-gateway/errors.js";
import { formatGatewayHealthReport, runGatewayHealth } from "../../src/model-gateway/health.js";

test("normalizes gateway timeout errors", () => {
  const error = new Error("operation aborted");
  error.name = "AbortError";

  const normalized = normalizeGatewayError(error);

  assert.equal(normalized.code, "GATEWAY_TIMEOUT");
  assert.equal(normalized.message, "operation aborted");
  assert.ok(normalized.diagnostics.some((hint) => /latency|queue|timeout/i.test(hint)));
  assert.equal(normalized.redacted, true);
});

test("formats gateway errors with diagnostic hints", () => {
  const normalized = normalizeGatewayError(null, {
    code: "GATEWAY_RESPONSE_PARSE_ERROR",
    message: "bad response token=secret"
  });
  const text = formatGatewayError(normalized);

  assert.match(text, /Gateway error: GATEWAY_RESPONSE_PARSE_ERROR/);
  assert.match(text, /diagnostics/);
  assert.match(text, /verify:gateway/);
  assert.doesNotMatch(text, /token=secret/);
});

test("gateway 404 hint matches OpenAI-compatible chat route", () => {
  const normalized = normalizeGatewayError(null, {
    code: "GATEWAY_HTTP_ERROR",
    message: "Gateway returned HTTP 404",
    status: 404,
    protocol: "openai-chat"
  });

  assert.ok(normalized.diagnostics.some((hint) => /\/v1\/chat\/completions/.test(hint)));
  assert.equal(normalized.diagnostics.some((hint) => /usually \/v1\/chat\./.test(hint)), false);
});

test("gateway image-input 404 reports unsupported vision route", () => {
  const normalized = normalizeGatewayError(null, {
    code: "GATEWAY_HTTP_ERROR",
    message: "Gateway returned HTTP 404",
    status: 404,
    protocol: "openai-chat",
    details: {
      body: JSON.stringify({
        error: {
          code: "404",
          message: "No endpoints found that support image input"
        }
      })
    }
  });
  const text = formatGatewayError(normalized);

  assert.equal(normalized.providerMessage, "No endpoints found that support image input");
  assert.match(text, /provider: No endpoints found that support image input/);
  assert.ok(normalized.diagnostics.some((hint) => /rejected image input|vision-capable/i.test(hint)));
  assert.equal(normalized.diagnostics.some((hint) => /\/v1\/chat\/completions/.test(hint)), false);
});

test("gateway health dry run validates config and network policy", async () => {
  const report = await runGatewayHealth({
    cwd: process.cwd(),
    env: {
      LAB_MODEL_GATEWAY_URL: "https://gateway.lab.example/v1/chat",
      LAB_MODEL_GATEWAY_HEALTH_URL: "https://gateway.lab.example/health",
      LAB_AGENT_NETWORK_MODE: "lab-only"
    }
  });

  assert.equal(report.ok, true);
  assert.equal(report.live, false);
  assert.equal(report.config.gatewayConfigured, true);
  assert.equal(report.config.healthConfigured, true);
  assert.equal(report.config.gatewayMaxRetries, 2);
  assert.deepEqual(report.hints, []);
  assert.equal(report.checks.some((check) => check.name === "gateway live health"), false);
  assert.match(formatGatewayHealthReport(report), /fetch retries: 2/);
});

test("gateway health report includes next steps when configuration is incomplete", async () => {
  const cwd = await makeTempWorkspace();
  await fs.writeFile(path.join(cwd, "lab-agent.config.json"), JSON.stringify({ lab: { gatewayUrl: null } }), "utf8");
  const report = await runGatewayHealth({
    cwd,
    env: {}
  });

  assert.equal(report.ok, false);
  assert.ok(report.hints.some((hint) => /LAB_MODEL_GATEWAY_URL/.test(hint)));
});

test("gateway health live check accepts the mock gateway health endpoint", async () => {
  const server = await listen(createMockGatewayServer(), "127.0.0.1");
  try {
    const url = serverUrl(server);
    const report = await runGatewayHealth({
      cwd: process.cwd(),
      live: true,
      env: {
        LAB_MODEL_GATEWAY_URL: `${url}/v1/chat`,
        LAB_MODEL_GATEWAY_HEALTH_URL: `${url}/health`,
        LAB_AGENT_NETWORK_MODE: "offline"
      }
    });

    assert.equal(report.ok, true);
    assert.deepEqual(
      report.checks.find((check) => check.name === "gateway live health"),
      { name: "gateway live health", status: "ok", message: "HTTP 200" }
    );
  } finally {
    await close(server);
  }
});

test("gateway client normalizes HTTP errors with bounded response body", async () => {
  const server = await listen(http.createServer((request, response) => {
    response.writeHead(503, { "content-type": "application/json" });
    response.end(`service unavailable token=secret ${"x".repeat(1200)}`);
  }), "127.0.0.1");
  try {
    const gateway = createLabModelGateway({
      modelAlias: "test-model",
      networkMode: "offline",
      allowedHosts: [],
      lab: { gatewayUrl: `${serverUrl(server)}/v1/chat` }
    });

    const result = await gateway.sendChat({
      messages: [{ role: "user", content: "hello" }]
    });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "GATEWAY_HTTP_ERROR");
    assert.equal(result.error.status, 503);
    assert.equal(result.error.details.body.length, 1000);
    assert.match(result.error.details.body, /service unavailable/);
    assert.doesNotMatch(result.error.details.body, /token=secret/);
    assert.ok(result.error.diagnostics.some((hint) => /server logs/i.test(hint)));
  } finally {
    await close(server);
  }
});

test("gateway client times out hung HTTP error responses", async () => {
  const server = await listen(http.createServer(async (request, response) => {
    await readRequestText(request);
    response.writeHead(503, { "content-type": "application/json" });
  }), "127.0.0.1");
  try {
    const gateway = createLabModelGateway({
      modelAlias: "test-model",
      networkMode: "offline",
      allowedHosts: [],
      lab: {
        gatewayUrl: `${serverUrl(server)}/v1/chat`,
        gatewayMaxRetries: 0,
        gatewayTimeoutMs: 500,
        gatewayIdleTimeoutMs: 50
      }
    });

    const result = await gateway.sendChat({
      messages: [{ role: "user", content: "hello" }]
    });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "GATEWAY_TIMEOUT");
    assert.equal(result.error.details.timeoutMs, 500);
    assert.equal(result.error.details.retryHistory[0].stage, "fetch");
  } finally {
    await close(server);
  }
});

test("gateway client can use OpenAI-compatible chat protocol with bearer auth", async () => {
  const requests = [];
  const server = await listen(http.createServer(async (request, response) => {
    const body = JSON.parse(await readRequestText(request));
    requests.push({
      authorization: request.headers.authorization,
      body
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "chatcmpl-test",
      model: body.model,
      choices: [
        {
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: `openai-compatible ${body.messages.at(-1).content}`
          }
        }
      ]
    }));
  }), "127.0.0.1");
  try {
    const gateway = createLabModelGateway({
      modelAlias: "test-model",
      networkMode: "offline",
      allowedHosts: [],
      lab: {
        gatewayUrl: `${serverUrl(server)}/v1/chat/completions`,
        gatewayProtocol: "openai-chat",
        gatewayApiKey: "test-secret"
      }
    });

    const result = await gateway.sendChat({
      messages: [{ role: "user", content: "hello" }],
      tools: [{ name: "read_file", description: "Read", inputSchema: { type: "object" } }]
    });

    assert.equal(result.ok, true);
    assert.equal(result.data.text, "openai-compatible hello");
    assert.equal(requests[0].authorization, "Bearer test-secret");
    assert.equal(requests[0].body.model, "test-model");
    assert.equal(requests[0].body.messages[0].content, "hello");
    assert.equal(requests[0].body.tools[0].function.name, "read_file");
  } finally {
    await close(server);
  }
});

test("gateway client retries transient fetch failures before response", async () => {
  const originalFetch = globalThis.fetch;
  const events = [];
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) {
        const error = new TypeError("fetch failed");
        error.cause = { code: "ECONNRESET", syscall: "connect" };
        throw error;
      }
      return new Response(JSON.stringify({
        id: "retry-ok",
        model: "test-model",
        content: [{ type: "text", text: "recovered" }],
        toolCalls: [],
        stopReason: "stop"
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    const gateway = createLabModelGateway({
      modelAlias: "test-model",
      networkMode: "offline",
      allowedHosts: [],
      lab: {
        gatewayUrl: "http://127.0.0.1/v1/chat",
        gatewayMaxRetries: 1
      }
    });

    const result = await gateway.sendChat({
      messages: [{ role: "user", content: "hello" }],
      onEvent: (event) => events.push(event)
    });

    assert.equal(result.ok, true);
    assert.equal(result.data.text, "recovered");
    assert.equal(calls, 2);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "gateway_retry");
    assert.equal(events[0].attempt, 1);
    assert.equal(events[0].maxAttempts, 2);
    assert.equal(events[0].error.details.retryHistory[0].cause.code, "ECONNRESET");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("gateway client sends session affinity header", async () => {
  const originalFetch = globalThis.fetch;
  try {
    let headers = null;
    globalThis.fetch = async (_url, options) => {
      headers = options.headers;
      return new Response(JSON.stringify({
        id: "affinity-ok",
        model: "test-model",
        content: [{ type: "text", text: "ok" }],
        toolCalls: [],
        stopReason: "stop"
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    const gateway = createLabModelGateway({
      modelAlias: "test-model",
      networkMode: "offline",
      allowedHosts: [],
      lab: {
        gatewayUrl: "http://127.0.0.1/v1/chat",
        gatewayMaxRetries: 0
      }
    });

    const result = await gateway.sendChat({
      sessionId: "session-affinity-1",
      messages: [{ role: "user", content: "hello" }]
    });

    assert.equal(result.ok, true);
    assert.equal(headers["x-session-affinity"], "session-affinity-1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("gateway client retries configured transient HTTP 500 responses", async () => {
  const originalFetch = globalThis.fetch;
  const events = [];
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({
          error: {
            code: "500",
            message: "Decode transfer failed with exception KVTransferError: Request timed out in KVPoll.WaitingForInput"
          }
        }), {
          status: 500,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(JSON.stringify({
        id: "example-retry-ok",
        model: "example-retry-model",
        content: [{ type: "text", text: "recovered" }],
        toolCalls: [],
        stopReason: "stop"
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    const gateway = createLabModelGateway({
      modelAlias: "example-retry-model",
      networkMode: "offline",
      allowedHosts: [],
      lab: {
        gatewayUrl: "http://127.0.0.1/v1/chat",
        gatewayMaxRetries: 1
      }
    });

    const result = await gateway.sendChat({
      messages: [{ role: "user", content: "hello" }],
      onEvent: (event) => events.push(event)
    });

    assert.equal(result.ok, true);
    assert.equal(result.data.text, "recovered");
    assert.equal(calls, 2);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "gateway_retry");
    assert.equal(events[0].stage, "http");
    assert.equal(events[0].error.code, "GATEWAY_HTTP_ERROR");
    assert.equal(events[0].error.status, 500);
    assert.match(events[0].error.details.retryHistory[0].body, /KVTransferError/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("gateway client retries interrupted streams", async () => {
  const originalFetch = globalThis.fetch;
  const events = [];
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) {
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"id":"broken","choices":[{"delta":{"content":"hel"}}]}\n\n'));
            controller.error(new Error("premature close"));
          }
        });
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" }
        });
      }
      return new Response([
        'data: {"id":"retry-ok","model":"example-retry-model","choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}',
        "",
        "data: [DONE]",
        ""
      ].join("\n"), {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    };

    const gateway = createLabModelGateway({
      modelAlias: "example-retry-model",
      networkMode: "offline",
      allowedHosts: [],
      lab: {
        gatewayUrl: "http://127.0.0.1/v1/chat",
        gatewayProtocol: "openai-chat",
        gatewayMaxRetries: 1
      }
    });

    const result = await gateway.sendChat({
      messages: [{ role: "user", content: "hello" }],
      stream: true,
      onEvent: (event) => events.push(event)
    });

    assert.equal(result.ok, true);
    assert.equal(result.data.text, "ok");
    assert.equal(calls, 2);
    const retry = events.find((event) => event.type === "gateway_retry");
    assert.equal(retry.stage, "read_body");
    assert.equal(retry.error.code, "GATEWAY_STREAM_INTERRUPTED");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("gateway client does not retry when retry budget is disabled", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      calls += 1;
      throw new TypeError("fetch failed");
    };

    const gateway = createLabModelGateway({
      modelAlias: "test-model",
      networkMode: "offline",
      allowedHosts: [],
      lab: {
        gatewayUrl: "http://127.0.0.1/v1/chat",
        gatewayMaxRetries: 0
      }
    });

    const result = await gateway.sendChat({
      messages: [{ role: "user", content: "hello" }]
    });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "GATEWAY_FETCH_ERROR");
    assert.equal(result.error.details.attempts, 1);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("gateway client normalizes malformed JSON responses", async () => {
  const server = await listen(http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{bad json");
  }), "127.0.0.1");
  try {
    const gateway = createLabModelGateway({
      modelAlias: "test-model",
      networkMode: "offline",
      allowedHosts: [],
      lab: { gatewayUrl: `${serverUrl(server)}/v1/chat` }
    });

    const result = await gateway.sendChat({
      messages: [{ role: "user", content: "hello" }]
    });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "GATEWAY_RESPONSE_PARSE_ERROR");
    assert.equal(result.error.message, "Gateway response could not be parsed");
  } finally {
    await close(server);
  }
});

test("gateway client parses event streams when content type is missing", async () => {
  const server = await listen(http.createServer((request, response) => {
    response.writeHead(200);
    response.write("data: {\"id\":\"chatcmpl-missing-type\",\"object\":\"chat.completion.chunk\",\"model\":\"mock\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"hello\"}}]}\n\n");
    response.end("data: [DONE]\n\n");
  }), "127.0.0.1");
  try {
    const gateway = createLabModelGateway({
      modelAlias: "test-model",
      networkMode: "offline",
      allowedHosts: [],
      lab: {
        gatewayUrl: `${serverUrl(server)}/v1/chat`,
        gatewayProtocol: "openai-chat"
      }
    });

    const result = await gateway.sendChat({
      messages: [{ role: "user", content: "hello" }]
    });

    assert.equal(result.ok, true);
    assert.equal(result.data.text, "hello");
  } finally {
    await close(server);
  }
});

test("gateway client includes a bounded body preview for parse errors", async () => {
  const server = await listen(http.createServer((request, response) => {
    response.writeHead(200);
    response.end("<html><body>upstream gateway timeout</body></html>");
  }), "127.0.0.1");
  try {
    const gateway = createLabModelGateway({
      modelAlias: "test-model",
      networkMode: "offline",
      allowedHosts: [],
      lab: { gatewayUrl: `${serverUrl(server)}/v1/chat` }
    });

    const result = await gateway.sendChat({
      messages: [{ role: "user", content: "hello" }]
    });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "GATEWAY_RESPONSE_PARSE_ERROR");
    assert.match(result.error.details.bodyPreview, /upstream gateway timeout/);
  } finally {
    await close(server);
  }
});

test("gateway client retries transient parse errors", async () => {
  let calls = 0;
  const server = await listen(http.createServer((request, response) => {
    calls += 1;
    if (calls === 1) {
      response.writeHead(200);
      response.end("<html><body>upstream gateway timeout</body></html>");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "retry-parse-ok",
      model: "mock-model",
      content: [{ type: "text", text: "recovered" }],
      toolCalls: [],
      stopReason: "stop"
    }));
  }), "127.0.0.1");
  try {
    const events = [];
    const gateway = createLabModelGateway({
      modelAlias: "test-model",
      networkMode: "offline",
      allowedHosts: [],
      lab: {
        gatewayUrl: `${serverUrl(server)}/v1/chat`,
        gatewayMaxRetries: 1
      }
    });

    const result = await gateway.sendChat({
      messages: [{ role: "user", content: "hello" }],
      onEvent: (event) => events.push(event)
    });

    assert.equal(result.ok, true);
    assert.equal(result.data.text, "recovered");
    assert.equal(calls, 2);
    const retry = events.find((event) => event.type === "gateway_retry");
    assert.equal(retry.stage, "parse_body");
    assert.equal(retry.error.code, "GATEWAY_RESPONSE_PARSE_ERROR");
  } finally {
    await close(server);
  }
});

test("gateway client times out hung responses", async () => {
  const server = await listen(http.createServer(async (request, response) => {
    await readRequestText(request);
    response.writeHead(200, { "content-type": "application/json" });
  }), "127.0.0.1");
  try {
    const gateway = createLabModelGateway({
      modelAlias: "test-model",
      networkMode: "offline",
      allowedHosts: [],
      lab: {
        gatewayUrl: `${serverUrl(server)}/v1/chat`,
        gatewayMaxRetries: 0,
        gatewayTimeoutMs: 50,
        gatewayIdleTimeoutMs: 50
      }
    });

    const result = await gateway.sendChat({
      messages: [{ role: "user", content: "hello" }]
    });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "GATEWAY_TIMEOUT");
    assert.equal(result.error.details.timeoutMs, 50);
  } finally {
    await close(server);
  }
});

/**
 * @param {http.IncomingMessage} request
 */
async function readRequestText(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * @param {import("node:http").Server} server
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
 * @param {import("node:http").Server} server
 */
function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve(undefined));
  });
}

/**
 * @param {import("node:http").Server} server
 */
function serverUrl(server) {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("server did not expose an address");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function makeTempWorkspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
}
