#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";

const logPath = process.env.MCP_CANCEL_LOG;
const lines = readline.createInterface({ input: process.stdin });

lines.on("line", (line) => {
  if (!line.trim()) {
    return;
  }

  const request = JSON.parse(line);
  if (request.method === "notifications/cancelled") {
    if (logPath) {
      fs.appendFileSync(logPath, `${JSON.stringify(request.params ?? {})}\n`, "utf8");
    }
    return;
  }
  if (!("id" in request)) {
    return;
  }

  if (request.method === "initialize") {
    respond(request.id, {
      protocolVersion: "lab-agent-mcp.v1",
      capabilities: { tools: {} },
      serverInfo: { name: "mcp-cancel-fixture", version: "0.1.0" }
    });
    return;
  }
  if (request.method === "tools/list") {
    respond(request.id, {
      tools: [
        {
          name: "slow",
          description: "Slow tool for cancellation tests.",
          inputSchema: { type: "object", properties: {} }
        }
      ]
    });
    return;
  }
  if (request.method === "tools/call") {
    setTimeout(() => {
      respond(request.id, { content: [{ type: "text", text: "slow done" }] });
    }, 10_000);
    return;
  }
  respond(request.id, null, { code: -32601, message: `Unknown method: ${request.method}` });
});

function respond(id, result, error = null) {
  const message = error
    ? { jsonrpc: "2.0", id, error }
    : { jsonrpc: "2.0", id, result };
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
