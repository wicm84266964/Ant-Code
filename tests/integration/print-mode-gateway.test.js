import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMockGatewayServer } from "../../scripts/mock-gateway.js";
import { runPrintTurn } from "../../src/core/session.js";

test("print mode completes one turn through mock lab gateway", async () => {
  const server = await listen(createMockGatewayServer(), "127.0.0.1");
  try {
    const url = serverUrl(server);
    const result = await runPrintTurn({
      prompt: "hello",
      cwd: process.cwd(),
      env: mockGatewayEnv(url, "mock-model")
    });

    assert.match(result.output, /Mock gateway response/);
    assert.match(result.output, /mock-model/);
    assert.match(result.output, /hello/);
  } finally {
    await close(server);
  }
});

test("print mode persists bounded session metadata", async () => {
  const cwd = await makeTempWorkspace();
  const server = await listen(createMockGatewayServer(), "127.0.0.1");
  try {
    const url = serverUrl(server);
    const result = await runPrintTurn({
      prompt: "hello metadata",
      cwd,
      env: mockGatewayEnv(url, "mock-model", {
        LAB_AGENT_TRANSCRIPT_ENABLED: "true"
      })
    });

    assert.match(result.output, /Mock gateway response/);
    const sessionFile = path.join(cwd, ".lab-agent", "sessions", `${result.session.id}.json`);
    const metadata = JSON.parse(await fs.readFile(sessionFile, "utf8"));
    assert.equal(metadata.id, result.session.id);
    assert.equal(metadata.status, "completed");
    assert.equal(metadata.mode, "print");
    assert.equal(metadata.promptBytes, Buffer.byteLength("hello metadata", "utf8"));
    assert.ok(metadata.outputBytes > 0);
    assert.deepEqual(metadata.gatewayErrors, []);
    assert.equal(metadata.prompt, "hello metadata");
    assert.equal(metadata.transcript.messages.length, 2);
    assert.equal(metadata.transcript.messages[0].content, "hello metadata");
    assert.equal("output" in metadata, false);
  } finally {
    await close(server);
  }
});

test("print mode validates required metadata encryption before model work", async () => {
  const cwd = await makeTempWorkspace();

  await assert.rejects(
    runPrintTurn({
      prompt: "hello",
      cwd,
      env: {
        LAB_AGENT_TRANSCRIPT_ENCRYPTION: "required"
      }
    }),
    /LAB_AGENT_TRANSCRIPT_KEY is required/
  );
});

test("print mode accepts streaming mock lab gateway responses", async () => {
  const server = await listen(createMockGatewayServer({ stream: true }), "127.0.0.1");
  try {
    const url = serverUrl(server);
    const result = await runPrintTurn({
      prompt: "stream please",
      cwd: process.cwd(),
      env: mockGatewayEnv(url, "mock-stream-model")
    });

    assert.match(result.output, /Mock gateway response/);
    assert.match(result.output, /mock-stream-model/);
    assert.match(result.output, /stream please/);
  } finally {
    await close(server);
  }
});

test("print mode executes read_file tool calls through mock lab gateway", async () => {
  const server = await listen(createMockGatewayServer(), "127.0.0.1");
  try {
    const url = serverUrl(server);
    const result = await runPrintTurn({
      prompt: "please read_file README.md",
      cwd: process.cwd(),
      env: mockGatewayEnv(url, "mock-tool-model")
    });

    assert.match(result.output, /Tool read_file returned README\.md/);
    assert.match(result.output, /Ant Code/);
  } finally {
    await close(server);
  }
});

test("print mode executes local tools through an OpenAI-compatible gateway", async () => {
  const server = await listen(createOpenAICompatibleMockGateway(), "127.0.0.1");
  try {
    const url = serverUrl(server);
    const result = await runPrintTurn({
      prompt: "please read_file README.md",
      cwd: process.cwd(),
      env: {
        LAB_MODEL_GATEWAY_URL: `${url}/v1/chat/completions`,
        LAB_MODEL_GATEWAY_PROTOCOL: "openai-chat",
        LAB_MODEL_GATEWAY_API_KEY: "test-secret",
        LAB_AGENT_MODEL: "openai-compatible-model",
        LAB_AGENT_NETWORK_MODE: "offline",
        LAB_AGENT_TRANSCRIPT_ENABLED: "false"
      }
    });

    assert.match(result.output, /OpenAI-compatible tool result/);
    assert.match(result.output, /Ant Code/);
  } finally {
    await close(server);
  }
});

test("print mode executes glob tool calls through mock lab gateway", async () => {
  const server = await listen(createMockGatewayServer(), "127.0.0.1");
  try {
    const url = serverUrl(server);
    const result = await runPrintTurn({
      prompt: "please glob src/cli/*.js",
      cwd: process.cwd(),
      env: mockGatewayEnv(url, "mock-tool-model")
    });

    assert.match(result.output, /Tool glob returned/);
    assert.match(result.output, /src\/cli\/index\.js/);
  } finally {
    await close(server);
  }
});

test("print mode executes git_status tool calls through mock lab gateway", async () => {
  const server = await listen(createMockGatewayServer(), "127.0.0.1");
  try {
    const url = serverUrl(server);
    const result = await runPrintTurn({
      prompt: "please git_status",
      cwd: process.cwd(),
      env: mockGatewayEnv(url, "mock-tool-model")
    });

    assert.match(result.output, /Tool git_status exited/);
  } finally {
    await close(server);
  }
});

test("print mode blocks write_file tool calls without approval", async () => {
  const cwd = await makeTempWorkspace();
  const server = await listen(createMockGatewayServer(), "127.0.0.1");
  try {
    const url = serverUrl(server);
    const result = await runPrintTurn({
      prompt: "please write_file notes.txt hello",
      cwd,
      env: mockGatewayEnv(url, "mock-tool-model")
    });

    assert.match(result.output, /workspace writes require approval/);
    await assert.rejects(fs.readFile(path.join(cwd, "notes.txt"), "utf8"), /ENOENT/);
  } finally {
    await close(server);
  }
});

test("print mode writes files with explicit approval", async () => {
  const cwd = await makeTempWorkspace();
  const server = await listen(createMockGatewayServer(), "127.0.0.1");
  try {
    const url = serverUrl(server);
    const result = await runPrintTurn({
      prompt: "please write_file notes.txt hello",
      cwd,
      allowWrite: true,
      env: mockGatewayEnv(url, "mock-tool-model")
    });

    assert.match(result.output, /Tool write_file wrote notes\.txt/);
    assert.match(result.output, /\+hello/);
    assert.equal(await fs.readFile(path.join(cwd, "notes.txt"), "utf8"), "hello");
  } finally {
    await close(server);
  }
});

test("print mode can approve a single write tool through callback", async () => {
  const cwd = await makeTempWorkspace();
  const server = await listen(createMockGatewayServer(), "127.0.0.1");
  const approvals = [];
  try {
    const url = serverUrl(server);
    const result = await runPrintTurn({
      prompt: "please write_file notes.txt hello",
      cwd,
      approvalCallback: async (request) => {
        approvals.push(request);
        return true;
      },
      env: mockGatewayEnv(url, "mock-tool-model")
    });

    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].toolName, "write_file");
    assert.match(result.output, /Tool write_file wrote notes\.txt/);
    assert.equal(await fs.readFile(path.join(cwd, "notes.txt"), "utf8"), "hello");
  } finally {
    await close(server);
  }
});

test("print mode edits files with explicit approval", async () => {
  const cwd = await makeTempWorkspace();
  await fs.writeFile(path.join(cwd, "notes.txt"), "alpha beta\n", "utf8");
  const server = await listen(createMockGatewayServer(), "127.0.0.1");
  try {
    const url = serverUrl(server);
    const result = await runPrintTurn({
      prompt: "please edit_file notes.txt beta => gamma",
      cwd,
      allowWrite: true,
      env: mockGatewayEnv(url, "mock-tool-model")
    });

    assert.match(result.output, /Tool edit_file edited notes\.txt/);
    assert.match(result.output, /\+alpha gamma/);
    assert.equal(await fs.readFile(path.join(cwd, "notes.txt"), "utf8"), "alpha gamma\n");
  } finally {
    await close(server);
  }
});

test("print mode executes readonly powershell commands through mock lab gateway", { skip: process.platform !== "win32" ? "PowerShell executable is only assumed in Windows CI for now" : false }, async () => {
  const cwd = await makeTempWorkspace();
  const server = await listen(createMockGatewayServer(), "127.0.0.1");
  try {
    const url = serverUrl(server);
    const result = await runPrintTurn({
      prompt: "please powershell Get-Location",
      cwd,
      env: mockGatewayEnv(url, "mock-tool-model")
    });

    assert.match(result.output, /Tool powershell exited 0/);
    assert.match(result.output, new RegExp(escapeRegex(cwd)));
  } finally {
    await close(server);
  }
});

test("print mode blocks mutating powershell commands without approval", { skip: process.platform !== "win32" ? "PowerShell executable is only assumed in Windows CI for now" : false }, async () => {
  const cwd = await makeTempWorkspace();
  const server = await listen(createMockGatewayServer(), "127.0.0.1");
  try {
    const url = serverUrl(server);
    const result = await runPrintTurn({
      prompt: "please powershell Set-Content -LiteralPath notes.txt -Value hello",
      cwd,
      env: mockGatewayEnv(url, "mock-tool-model")
    });

    assert.match(result.output, /not classified as readonly/);
    await assert.rejects(fs.readFile(path.join(cwd, "notes.txt"), "utf8"), /ENOENT/);
  } finally {
    await close(server);
  }
});

test("print mode executes mutating powershell commands with approval", { skip: process.platform !== "win32" ? "PowerShell executable is only assumed in Windows CI for now" : false }, async () => {
  const cwd = await makeTempWorkspace();
  const server = await listen(createMockGatewayServer(), "127.0.0.1");
  try {
    const url = serverUrl(server);
    const result = await runPrintTurn({
      prompt: "please powershell Set-Content -LiteralPath notes.txt -Value hello",
      cwd,
      allowCommand: true,
      env: mockGatewayEnv(url, "mock-tool-model")
    });

    assert.match(result.output, /Tool powershell exited 0/);
    assert.match(await fs.readFile(path.join(cwd, "notes.txt"), "utf8"), /hello/);
  } finally {
    await close(server);
  }
});

test("print mode executes configured MCP calls through mock lab gateway", async () => {
  const cwd = await makeTempWorkspace();
  await fs.writeFile(path.join(cwd, "lab-agent.config.json"), JSON.stringify({
    mcp: {
      servers: [
        {
          name: "local-echo",
          transport: "stdio",
          command: process.execPath,
          args: [path.resolve("tests/fixtures/mcp-echo-server.js")],
          toolRisks: { echo: "read" }
        }
      ]
    }
  }), "utf8");

  const server = await listen(createMockGatewayServer(), "127.0.0.1");
  try {
    const url = serverUrl(server);
    const result = await runPrintTurn({
      prompt: "please mcp_call local-echo echo {\"message\":\"hi\"}",
      cwd,
      env: mockGatewayEnv(url, "mock-tool-model")
    });

    assert.match(result.output, /Tool mcp_call returned/);
    assert.match(result.output, /echo/);
    assert.match(result.output, /hi/);
  } finally {
    await close(server);
  }
});

test("print mode passes allowedHosts into MCP network permission checks", async () => {
  const cwd = await makeTempWorkspace();
  await fs.writeFile(path.join(cwd, "lab-agent.config.json"), JSON.stringify({
    networkMode: "approved-web",
    allowedHosts: ["example.com"],
    mcp: {
      servers: [
        {
          name: "local-echo",
          transport: "stdio",
          command: process.execPath,
          args: [path.resolve("tests/fixtures/mcp-echo-server.js")],
          toolRisks: { echo: "network" }
        }
      ]
    }
  }), "utf8");

  const server = await listen(createMockGatewayServer(), "127.0.0.1");
  try {
    const url = serverUrl(server);
    const result = await runPrintTurn({
      prompt: "please mcp_call local-echo echo {\"url\":\"https://example.com/docs\"}",
      cwd,
      env: mockGatewayEnv(url, "mock-tool-model", {
        LAB_AGENT_NETWORK_MODE: "approved-web"
      })
    });

    assert.match(result.output, /Tool mcp_call returned/);
    assert.match(result.output, /example\.com/);
    assert.doesNotMatch(result.output, /blocked|did not complete|permission/i);
  } finally {
    await close(server);
  }
});

test("print mode routes MCP approval requests through the callback", async () => {
  const cwd = await makeTempWorkspace();
  await fs.writeFile(path.join(cwd, "lab-agent.config.json"), JSON.stringify({
    mcp: {
      servers: [
        {
          name: "local-echo",
          transport: "stdio",
          command: process.execPath,
          args: [path.resolve("tests/fixtures/mcp-echo-server.js")]
        }
      ]
    }
  }), "utf8");

  const approvals = [];
  const server = await listen(createMockGatewayServer(), "127.0.0.1");
  try {
    const url = serverUrl(server);
    const result = await runPrintTurn({
      prompt: "please mcp_call local-echo echo {\"message\":\"hi\"}",
      cwd,
      approvalCallback: async (request) => {
        approvals.push(request);
        return true;
      },
      env: mockGatewayEnv(url, "mock-tool-model")
    });

    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].toolName, "mcp_call");
    assert.equal(approvals[0].input.server, "local-echo");
    assert.equal(approvals[0].input.tool, "echo");
    assert.match(result.output, /Tool mcp_call returned/);
    assert.match(result.output, /hi/);
  } finally {
    await close(server);
  }
});

test("print mode executes session-local workflow tools through mock lab gateway", async () => {
  const cwd = await makeTempWorkspace();
  const server = await listen(createMockGatewayServer(), "127.0.0.1");
  try {
    const url = serverUrl(server);
    const result = await runPrintTurn({
      prompt: "please todo_write inspect code | run tests",
      cwd,
      env: mockGatewayEnv(url, "mock-workflow-model")
    });

    assert.match(result.output, /Tool todo_write updated 2 todos/);
    assert.equal(result.session.workflow.todos.length, 2);
    assert.equal(result.session.workflow.todos[0].content, "inspect code");
  } finally {
    await close(server);
  }
});

test("print mode reports ask_user as unavailable without interactive callback", async () => {
  const cwd = await makeTempWorkspace();
  const server = await listen(createMockGatewayServer(), "127.0.0.1");
  try {
    const url = serverUrl(server);
    const result = await runPrintTurn({
      prompt: "please ask_user Which file should I edit?",
      cwd,
      env: mockGatewayEnv(url, "mock-workflow-model")
    });

    assert.match(result.output, /USER_INPUT_UNAVAILABLE/);
  } finally {
    await close(server);
  }
});

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

function createOpenAICompatibleMockGateway() {
  return http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }
    if (request.headers.authorization !== "Bearer test-secret") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "unauthorized" } }));
      return;
    }

    const body = await readRequestJson(request);
    const toolMessage = [...(body.messages ?? [])].reverse().find((message) => message.role === "tool");
    if (toolMessage) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(openAITextResponse(body, `OpenAI-compatible tool result:\n${toolMessage.content}`)));
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "chatcmpl-tool",
      model: body.model,
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call-readme",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: "{\"path\":\"README.md\",\"maxBytes\":4096}"
                }
              }
            ]
          }
        }
      ]
    }));
  });
}

/**
 * @param {import("node:http").IncomingMessage} request
 */
async function readRequestJson(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * @param {Record<string, any>} body
 * @param {string} content
 */
function openAITextResponse(body, content) {
  return {
    id: "chatcmpl-text",
    model: body.model,
    choices: [
      {
        finish_reason: "stop",
        message: {
          role: "assistant",
          content
        }
      }
    ]
  };
}

/**
 * @param {string} url
 * @param {string} model
 * @param {Record<string, string>} extra
 */
function mockGatewayEnv(url, model, extra = {}) {
  return {
    LAB_MODEL_GATEWAY_URL: `${url}/v1/chat`,
    LAB_MODEL_GATEWAY_PROTOCOL: "lab-agent-gateway",
    LAB_AGENT_MODEL: model,
    LAB_AGENT_NETWORK_MODE: "offline",
    LAB_AGENT_TRANSCRIPT_ENABLED: "false",
    ...extra
  };
}

async function makeTempWorkspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
}

/**
 * @param {string} value
 */
function escapeRegex(value) {
  return value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}
