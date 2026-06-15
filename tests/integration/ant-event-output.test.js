import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPrintEventCollector } from "../../src/cli/print-output.js";
import { isPrintableAntEvent } from "../../src/core/events.js";
import { reduceAntEvents } from "../../src/core/event-reducer.js";
import { createSession, runPrintTurn, runSessionTurn } from "../../src/core/session.js";

test("session turns emit ordered AntEvent v2 stream alongside legacy events", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
  const requests = [];
  const legacyEvents = [];
  const antEvents = [];
  const server = await listen(createOpenAIStreamingGateway(requests), "127.0.0.1");

  try {
    const env = openAIStreamEnv(serverUrl(server));
    const session = await createSession({ cwd, mode: "interactive", env });

    const result = await runSessionTurn(session, {
      prompt: "stream please",
      env,
      onEvent: (event) => legacyEvents.push(event),
      onAntEvent: (event) => antEvents.push(event)
    });

    assert.equal(result.output, "hello world");
    assert.ok(legacyEvents.some((event) => event.type === "assistant_delta"));
    assert.ok(antEvents.every((event) => event.schemaVersion === 2));
    assert.deepEqual(antEvents.map((event) => event.sequence), antEvents.map((_, index) => index + 1));
    assert.ok(antEvents.some((event) => event.type === "assistant_text_delta" && event.payload.text === "hello "));

    const thinkingDelta = antEvents.find((event) => event.type === "assistant_thinking_delta");
    assert.equal(thinkingDelta.persistence, "memory");
    assert.equal(isPrintableAntEvent(thinkingDelta, { includePartialMessages: true }), false);

    const state = reduceAntEvents(antEvents);
    assert.equal(state.transcript[0].kind, "assistant");
    assert.equal(state.transcript[0].text, "hello world");
  } finally {
    await close(server);
  }
});

test("print collector can build schema v2 JSON output without memory-only events", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
  const requests = [];
  const written = [];
  const collector = createPrintEventCollector({
    format: "stream-json",
    includePartialMessages: true,
    write: (line) => written.push(line)
  });
  const server = await listen(createOpenAIStreamingGateway(requests), "127.0.0.1");

  try {
    const env = openAIStreamEnv(serverUrl(server));
    const result = await runPrintTurn({
      prompt: "stream please",
      cwd,
      env,
      stream: true,
      onAntEvent: collector.onAntEvent
    });

    assert.equal(result.output, "hello world");
    const lines = written.map((line) => JSON.parse(line));
    assert.ok(lines.length > 0);
    assert.ok(lines.every((event) => event.schemaVersion === 2));
    assert.equal(lines.some((event) => event.type === "assistant_thinking_delta"), false);
    assert.ok(lines.some((event) => event.type === "assistant_text_delta"));
  } finally {
    await close(server);
  }
});

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
    assert.equal(body.stream, true);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('data: {"id":"chatcmpl-live","model":"mock-openai","choices":[{"delta":{"reasoning_content":"private thought token=secret"}}]}\n\n');
    response.write('data: {"choices":[{"delta":{"content":"hello "}}]}\n\n');
    response.write('data: {"choices":[{"delta":{"content":"world"},"finish_reason":"stop"}]}\n\n');
    response.end("data: [DONE]\n\n");
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
function openAIStreamEnv(url) {
  return {
    LAB_MODEL_GATEWAY_URL: `${url}/v1/chat/completions`,
    LAB_AGENT_MODEL: "mock-openai",
    LAB_AGENT_NETWORK_MODE: "offline",
    LAB_AGENT_TRANSCRIPT_ENABLED: "false",
    LAB_MODEL_GATEWAY_PROTOCOL: "openai-chat"
  };
}
