#!/usr/bin/env node
import readline from "node:readline";

const tools = Object.freeze([
  {
    name: "fetch",
    description: "Fetch fixture.",
    inputSchema: {
      type: "object",
      required: ["url"],
      properties: {
        url: { type: "string" },
        max_length: { type: "number" },
        raw: { type: "boolean" }
      }
    }
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
      serverInfo: { name: "mcp-fetch-fixture", version: "0.1.0" }
    });
    return;
  }
  if (request.method === "tools/list") {
    respond(request.id, { tools });
    return;
  }
  if (request.method === "tools/call") {
    const args = request.params?.arguments ?? {};
    const text = String(args.url ?? "").includes("large")
      ? "x".repeat(4096)
      : `mcp-fetch:${JSON.stringify(args)}`;
    respond(request.id, {
      content: [
        {
          type: "text",
          text
        }
      ]
    });
    return;
  }
  respond(request.id, null, {
    code: -32601,
    message: `Unknown method: ${request.method}`
  });
});

function respond(id, result, error = null) {
  const message = error
    ? { jsonrpc: "2.0", id, error }
    : { jsonrpc: "2.0", id, result };
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
