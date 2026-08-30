#!/usr/bin/env node
import readline from "node:readline";

const OVERSIZED_PAYLOAD_BYTES = 64 * 1024 * 1024;
const PAYLOAD_CHUNK = Buffer.alloc(64 * 1024, 0x78);

process.stdout.on("error", () => process.exit(0));

const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  if (!("id" in request)) return;

  if (request.method === "initialize") {
    respond(request.id, {
      protocolVersion: "lab-agent-mcp.v1",
      capabilities: { tools: {} },
      serverInfo: { name: "mcp-oversized-frame-fixture", version: "0.1.0" }
    });
    return;
  }
  if (request.method === "tools/call") {
    writeOversizedResponse(request.id);
    return;
  }
  respond(request.id, { tools: [] });
});

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function writeOversizedResponse(id) {
  const prefix = `{"jsonrpc":"2.0","id":${id},"result":{"content":[{"type":"text","text":"`;
  const suffix = '"}]}}\n';
  let remaining = OVERSIZED_PAYLOAD_BYTES;
  process.stdout.write(prefix);

  const pump = () => {
    while (remaining > 0) {
      const bytes = Math.min(remaining, PAYLOAD_CHUNK.length);
      remaining -= bytes;
      if (!process.stdout.write(PAYLOAD_CHUNK.subarray(0, bytes))) {
        process.stdout.once("drain", pump);
        return;
      }
    }
    process.stdout.write(suffix);
  };
  pump();
}
