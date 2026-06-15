import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import test from "node:test";
import path from "node:path";
import { createMcpRuntime } from "../../src/mcp/runtime.js";

test("lists tools from a configured stdio MCP server", async (t) => {
  const runtime = createRuntime({ toolRisks: { echo: "read" } });
  t.after(() => runtime.close());
  const result = await runtime.listTools("local-echo");

  assert.equal(result.ok, true);
  assert.equal(result.tools[0].name, "echo");
});

test("calls configured read-only MCP tools through permission policy", async (t) => {
  const runtime = createRuntime({ toolRisks: { echo: "read" } });
  t.after(() => runtime.close());
  const result = await runtime.callTool("local-echo", "echo", { message: "hi" });

  assert.equal(result.ok, true);
  assert.equal(result.result.content[0].text, "echo:{\"message\":\"hi\"}");
});

test("keeps MCP stdio sessions connected and exposes diagnostics", async () => {
  const runtime = createRuntime({ toolRisks: { echo: "read" } });
  const first = await runtime.listTools("local-echo");
  const second = await runtime.listTools("local-echo");
  const status = runtime.status("local-echo");

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.cached, true);
  assert.equal(status.ok, true);
  assert.equal(status.servers[0].status, "connected");
  assert.equal(status.servers[0].cachedTools, 1);
  runtime.close();
});

test("lists MCP prompts and resources through the persistent runtime", async () => {
  const runtime = createRuntime({ toolRisks: { echo: "read" } });
  const prompts = await runtime.listPrompts("local-echo");
  const resources = await runtime.listResources("local-echo");
  const read = await runtime.readResource("local-echo", "memo://hello");

  assert.equal(prompts.ok, true);
  assert.equal(prompts.prompts[0].name, "review");
  assert.equal(resources.ok, true);
  assert.equal(resources.resources[0].uri, "memo://hello");
  assert.equal(read.ok, true);
  assert.equal(read.resource.contents[0].text, "resource:memo://hello");
  runtime.close();
});

test("disabled MCP servers are visible but not launched", async () => {
  const runtime = createMcpRuntime({
    cwd: process.cwd(),
    config: {
      mcp: {
        servers: [
          {
            name: "filesystem",
            description: "Recommended local filesystem MCP",
            enabled: false,
            transport: "stdio",
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem", "."]
          }
        ]
      }
    },
    policy: { networkMode: "offline" }
  });

  const servers = runtime.listServers();
  const tools = await runtime.listTools("filesystem");

  assert.equal(servers[0].status, "disabled");
  assert.equal(tools.ok, false);
  assert.equal(tools.error.code, "MCP_SERVER_DISABLED");
});

test("blocks MCP tools with unknown risk", async (t) => {
  const runtime = createRuntime({ toolRisks: {} });
  t.after(() => runtime.close());
  const result = await runtime.callTool("local-echo", "echo", { message: "hi" });

  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.equal(result.decision.decision, "ask");
});

test("asks approval for MCP tools with unknown risk before calling them", async (t) => {
  const approvals = [];
  const runtime = createMcpRuntime({
    cwd: process.cwd(),
    config: {
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
    },
    policy: {
      networkMode: "offline"
    },
    approve: async (request) => {
      approvals.push(request);
      return true;
    }
  });
  t.after(() => runtime.close());

  const result = await runtime.callTool("local-echo", "echo", { message: "hi" });

  assert.equal(result.ok, true);
  assert.equal(result.result.content[0].text, "echo:{\"message\":\"hi\"}");
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].toolName, "mcp_call");
  assert.equal(approvals[0].input.server, "local-echo");
  assert.equal(approvals[0].input.tool, "echo");
  assert.equal(approvals[0].definition.risk, "mcp");
});

test("filesystem-like MCP calls ask before reading outside workspace paths", async (t) => {
  const cwd = await makeTempWorkspace();
  const outside = path.resolve(cwd, "..", "outside.txt");
  const approvals = [];
  const runtime = createFilesystemRuntime(cwd, {
    approve: async (request) => {
      approvals.push(request);
      return false;
    }
  });
  t.after(() => runtime.close());

  const result = await runtime.callTool("filesystem", "read_file", { path: `"${outside}"` });

  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.equal(result.decision.decision, "ask");
  assert.equal(result.decision.outsideWorkspace, true);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].input.server, "filesystem");
  assert.equal(approvals[0].input.tool, "read_file");
  assert.equal(approvals[0].decision.outsideWorkspace, true);
});

test("approved filesystem-like MCP outside paths execute", async (t) => {
  const cwd = await makeTempWorkspace();
  const outside = path.resolve(cwd, "..", "outside.txt");
  const approvals = [];
  const runtime = createFilesystemRuntime(cwd, {
    approve: async (request) => {
      approvals.push(request);
      return true;
    }
  });
  t.after(() => runtime.close());

  const result = await runtime.callTool("filesystem", "read_file", { path: outside });

  assert.equal(result.ok, true);
  assert.equal(approvals.length, 1);
  assert.equal(result.result.content[0].text, `echo:${JSON.stringify({ path: outside })}`);
});

test("full access auto-allows filesystem-like MCP outside paths", async (t) => {
  const cwd = await makeTempWorkspace();
  const outside = path.resolve(cwd, "..", "outside.txt");
  const approvals = [];
  const runtime = createFilesystemRuntime(cwd, {
    policy: { fullAccess: true, networkMode: "offline" },
    approve: async (request) => {
      approvals.push(request);
      return false;
    }
  });
  t.after(() => runtime.close());

  const result = await runtime.callTool("filesystem", "read_file", { path: outside });

  assert.equal(result.ok, true);
  assert.equal(approvals.length, 0);
});

test("github MCP repository paths are not treated as local filesystem paths", async (t) => {
  const cwd = await makeTempWorkspace();
  const runtime = createMcpRuntime({
    cwd,
    config: {
      mcp: {
        servers: [
          {
            name: "github",
            category: "web",
            transport: "stdio",
            command: process.execPath,
            args: [path.resolve("tests/fixtures/mcp-echo-server.js")],
            toolRisks: { get_file_contents: "read" }
          }
        ]
      }
    },
    policy: { networkMode: "offline" },
    approve: async () => {
      throw new Error("github repo paths should not ask for local path approval");
    }
  });
  t.after(() => runtime.close());

  const result = await runtime.callTool("github", "get_file_contents", {
    owner: "openai",
    repo: "codex",
    path: "../README.md"
  });

  assert.equal(result.ok, true);
  assert.match(result.result.content[0].text, /README\.md/);
});

test("MCP network tools declare URL arguments to approved-web policy", async (t) => {
  const runtime = createMcpRuntime({
    cwd: process.cwd(),
    config: {
      mcp: {
        servers: [
          {
            name: "fetch",
            transport: "stdio",
            command: process.execPath,
            args: [path.resolve("tests/fixtures/mcp-echo-server.js")],
            toolRisks: { echo: "network" }
          }
        ]
      }
    },
    policy: {
      networkMode: "approved-web",
      allowedHosts: ["example.com"]
    },
    approve: async () => {
      throw new Error("approved MCP network URL should not ask");
    }
  });
  t.after(() => runtime.close());

  const result = await runtime.callTool("fetch", "echo", { url: "https://example.com/docs" });

  assert.equal(result.ok, true);
  assert.match(result.result.content[0].text, /example\.com/);
});

test("MCP search servers declare their provider host to approved-web policy", async (t) => {
  const runtime = createMcpRuntime({
    cwd: process.cwd(),
    config: {
      mcp: {
        servers: [
          {
            name: "duckduckgo-search",
            transport: "stdio",
            command: process.execPath,
            args: [path.resolve("tests/fixtures/mcp-echo-server.js")],
            toolRisks: { search: "network" }
          }
        ]
      }
    },
    policy: {
      networkMode: "approved-web",
      allowedHosts: ["duckduckgo.com"]
    },
    approve: async () => {
      throw new Error("approved MCP search provider should not ask");
    }
  });
  t.after(() => runtime.close());

  const result = await runtime.callTool("duckduckgo-search", "search", { query: "ant code" });

  assert.equal(result.ok, true);
  assert.match(result.result.content[0].text, /ant code/);
});

test("MCP status reports scrubbed sensitive environment variables", async () => {
  const previous = process.env.MCP_TEST_TOKEN;
  process.env.MCP_TEST_TOKEN = "secret";
  const runtime = createRuntime({ toolRisks: { echo: "read" } });
  const tools = await runtime.listTools("local-echo");
  const status = runtime.status("local-echo");

  assert.equal(tools.ok, true);
  assert.equal(status.ok, true);
  assert.ok(status.servers[0].scrubbedEnv.includes("MCP_TEST_TOKEN"));
  runtime.close();
  if (previous === undefined) {
    delete process.env.MCP_TEST_TOKEN;
  } else {
    process.env.MCP_TEST_TOKEN = previous;
  }
});

test("MCP envAllowlist preserves explicitly allowed sensitive variables", async () => {
  const previous = process.env.MCP_ALLOWED_TOKEN;
  process.env.MCP_ALLOWED_TOKEN = "allowed";
  const runtime = createRuntime({
    toolRisks: { echo: "read" },
    envAllowlist: ["MCP_ALLOWED_TOKEN"]
  });
  const tools = await runtime.listTools("local-echo");
  const status = runtime.status("local-echo");

  assert.equal(tools.ok, true);
  assert.equal(status.ok, true);
  assert.equal(status.servers[0].scrubbedEnv.includes("MCP_ALLOWED_TOKEN"), false);
  runtime.close();
  if (previous === undefined) {
    delete process.env.MCP_ALLOWED_TOKEN;
  } else {
    process.env.MCP_ALLOWED_TOKEN = previous;
  }
});

test("MCP package: args resolve bundled server scripts from any cwd", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ant-code-mcp-test-"));
  const runtime = createMcpRuntime({
    cwd,
    config: {
      mcp: {
        servers: [
          {
            name: "github",
            transport: "stdio",
            command: process.execPath,
            args: ["package:scripts/github-mcp-server.js"],
            env: { GITHUB_READ_ONLY: "1" },
            toolRisks: { get_file_contents: "read" }
          }
        ]
      }
    },
    policy: {
      networkMode: "offline"
    }
  });
  t.after(() => runtime.close());

  const tools = await runtime.listTools("github");

  assert.equal(tools.ok, true);
  assert.ok(tools.tools.some((tool) => tool.name === "get_file_contents"));
});

test("MCP servers can configure request timeout", async (t) => {
  const runtime = createRuntime({
    toolRisks: { echo: "read" },
    requestTimeoutMs: 30_000
  });
  t.after(() => runtime.close());

  const tools = await runtime.listTools("local-echo");

  assert.equal(tools.ok, true);
});

function createRuntime(serverOptions) {
  return createMcpRuntime({
    cwd: process.cwd(),
    config: {
      mcp: {
        servers: [
          {
            name: "local-echo",
            transport: "stdio",
            command: process.execPath,
            args: [path.resolve("tests/fixtures/mcp-echo-server.js")],
            ...serverOptions
          }
        ]
      }
    },
    policy: {
      networkMode: "offline"
    }
  });
}

async function makeTempWorkspace() {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  return fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-mcp-test-"));
}

function createFilesystemRuntime(cwd, options = {}) {
  return createMcpRuntime({
    cwd,
    config: {
      mcp: {
        servers: [
          {
            name: "filesystem",
            category: "filesystem",
            transport: "stdio",
            command: process.execPath,
            args: [path.resolve("tests/fixtures/mcp-echo-server.js")],
            toolRisks: {
              read_file: "read",
              write_file: "write",
              list_directory: "read"
            }
          }
        ]
      }
    },
    policy: options.policy ?? { networkMode: "offline" },
    approve: options.approve
  });
}
