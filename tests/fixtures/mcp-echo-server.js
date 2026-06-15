#!/usr/bin/env node
import readline from "node:readline";

const tools = Object.freeze([
  {
    name: "echo",
    description: "Echo the provided arguments.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string" }
      }
    }
  }
]);
const prompts = Object.freeze([
  {
    name: "review",
    description: "Review a short text input."
  }
]);
const resources = Object.freeze([
  {
    uri: "memo://hello",
    name: "hello memo",
    mimeType: "text/plain"
  }
]);

const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (!line.trim()) {
    return;
  }

  const request = JSON.parse(line);
  if (!("id" in request)) {
    return;
  }

  if (request.method === "initialize") {
    respond(request.id, {
      protocolVersion: "lab-agent-mcp.v1",
      capabilities: { tools: {} },
      serverInfo: { name: "mcp-echo-fixture", version: "0.1.0" }
    });
  } else if (request.method === "tools/list") {
    respond(request.id, { tools });
  } else if (request.method === "tools/call") {
    respond(request.id, {
      content: [
        {
          type: "text",
          text: `echo:${JSON.stringify(request.params?.arguments ?? {})}`
        }
      ]
    });
  } else if (request.method === "prompts/list") {
    respond(request.id, { prompts });
  } else if (request.method === "resources/list") {
    respond(request.id, { resources });
  } else if (request.method === "resources/read") {
    respond(request.id, {
      contents: [
        {
          uri: request.params?.uri,
          mimeType: "text/plain",
          text: `resource:${request.params?.uri}`
        }
      ]
    });
  } else {
    respond(request.id, null, {
      code: -32601,
      message: `Unknown method: ${request.method}`
    });
  }
});

function respond(id, result, error = null) {
  const message = error
    ? { jsonrpc: "2.0", id, error }
    : { jsonrpc: "2.0", id, result };
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
