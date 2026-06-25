import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runSubagent } from "../../src/agents/runner.js";

test("readonly researcher returns workspace summary and grep matches without gateway", async () => {
  const cwd = await makeTempWorkspace();
  await fs.mkdir(path.join(cwd, "src"), { recursive: true });
  await fs.writeFile(path.join(cwd, "src", "notes.js"), "const name = 'LabAgent';\n", "utf8");
  const result = await runSubagent({
    cwd,
    profileName: "research",
    query: "find LabAgent",
    env: isolatedEnv()
  });

  assert.equal(result.ok, true);
  assert.equal(result.profile, "readonly-researcher");
  assert.equal(result.mode, "readonly");
  assert.equal(result.modelDriven, false);
  assert.ok(result.summary.files.length > 0);
  assert.ok(result.summary.matches.some((match) => match.text.includes("LabAgent")));
});

test("write-capable subagents require a configured gateway", async () => {
  const cwd = await makeTempWorkspace();
  const result = await runSubagent({
    cwd,
    profileName: "code-worker",
    query: "change something",
    env: isolatedEnv()
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "AGENT_GATEWAY_NOT_CONFIGURED");
});

test("hidden build profile is not available through normal subagent runs", async () => {
  const cwd = await makeTempWorkspace();
  const result = await runSubagent({
    cwd,
    profileName: "build",
    query: "try to run parent coordinator as a child",
    env: isolatedEnv()
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "AGENT_PROFILE_NOT_FOUND");
  assert.match(result.error.message, /Unknown agent profile: build/);
  assert.doesNotMatch(result.error.message.split("Available profiles:")[1] ?? "", /build|default/);
});

test("model-driven explorer subagent can use readonly tools", async () => {
  const cwd = await makeTempWorkspace();
  await fs.writeFile(path.join(cwd, "notes.txt"), "hello from notes\n", "utf8");
  const requests = [];
  const server = await listen(createToolGateway(requests, {
    toolCall: { id: "read-notes", name: "read_file", input: { path: "notes.txt", maxBytes: 1024 } },
    finalText: "explorer read notes"
  }), "127.0.0.1");

  try {
    const result = await runSubagent({
      cwd,
      profileName: "explorer",
      query: "read notes",
      env: mockGatewayEnv(serverUrl(server))
    });

    assert.equal(result.ok, true);
    assert.equal(result.profile, "explorer");
    assert.equal(result.modelDriven, true);
    assert.match(result.output, /explorer read notes/);
    assert.equal(result.tools[0].name, "read_file");
    assert.equal(result.tools[0].ok, true);
    assert.equal(requests[0].tools.some((tool) => tool.name === "read_file"), true);
    assert.equal(requests[0].tools.some((tool) => tool.name === "write_file"), false);
  } finally {
    await close(server);
  }
});

test("model-driven subagent preserves reasoning_content across OpenAI-compatible tool continuations", async () => {
  const cwd = await makeTempWorkspace();
  await fs.writeFile(path.join(cwd, "notes.txt"), "hello from notes\n", "utf8");
  const requests = [];
  const server = await listen(createReasoningToolGateway(requests), "127.0.0.1");

  try {
    const result = await runSubagent({
      cwd,
      profileName: "explorer",
      query: "read notes",
      env: mockGatewayEnv(serverUrl(server), { protocol: "openai-chat" })
    });

    assert.equal(result.ok, true);
    assert.match(result.output, /subagent reasoning continuation accepted/);
    assert.equal(requests.length, 2);
    const assistant = requests[1].messages.find((message) => message.role === "assistant" && Array.isArray(message.tool_calls));
    assert.equal(assistant.reasoning_content, "Subagent needs to read notes before reporting.");
  } finally {
    await close(server);
  }
});

test("model-driven subagent system prompt includes delegated operating doctrine", async () => {
  const cwd = await makeTempWorkspace();
  await fs.writeFile(path.join(cwd, "notes.txt"), "hello from notes\n", "utf8");
  const requests = [];
  const server = await listen(createToolGateway(requests, {
    toolCall: { id: "read-notes", name: "read_file", input: { path: "notes.txt", maxBytes: 1024 } },
    finalText: "explorer read notes"
  }), "127.0.0.1");

  try {
    const result = await runSubagent({
      cwd,
      profileName: "explorer",
      query: "read notes",
      env: mockGatewayEnv(serverUrl(server))
    });

    assert.equal(result.ok, true);
    const systemText = requests[0].messages.find((message) => message.role === "system")?.content?.[0]?.text ?? "";
    assert.match(systemText, /Delegated operating doctrine/);
    assert.match(systemText, /Treat the delegated prompt and context pack as your whole mission/);
    assert.match(systemText, /Do not take over the parent user's entire task/);
    assert.match(systemText, /Do not output raw JSON unless the requested contract explicitly asks for JSON/);
    assert.match(systemText, /compact evidence map/);
  } finally {
    await close(server);
  }
});

test("reviewer subagent receives validation memory without launching verifier", async () => {
  const cwd = await makeTempWorkspace();
  await fs.writeFile(path.join(cwd, "package.json"), JSON.stringify({
    scripts: {
      test: "node --test",
      check: "npm test"
    }
  }), "utf8");
  const workflowState = {
    todos: [],
    plan: { steps: [] },
    changes: [{
      toolName: "edit_file",
      path: "src/app.js",
      edited: true,
      diffBytes: 12,
      recordedAt: "2026-04-28T00:02:00.000Z"
    }],
    validations: [{
      command: "npm test",
      exitCode: 0,
      passed: true,
      timedOut: false,
      durationMs: 10,
      recordedAt: "2026-04-28T00:01:00.000Z"
    }]
  };
  const requests = [];
  const server = await listen(createFinalOnlyGateway(requests, "reviewer saw validation memory"), "127.0.0.1");

  try {
    const result = await runSubagent({
      cwd,
      profileName: "reviewer",
      query: "review current changes",
      env: mockGatewayEnv(serverUrl(server)),
      workflowState
    });

    assert.equal(result.ok, true);
    assert.equal(result.profile, "reviewer");
    const systemText = requests[0].messages.find((message) => message.role === "system")?.content?.[0]?.text ?? "";
    const userText = requests[0].messages.find((message) => message.role === "user")?.content ?? "";
    assert.match(systemText, /Always check any validationMemory/);
    assert.match(systemText, /Do not launch verifier/);
    assert.match(userText, /validationMemory:/);
    assert.match(userText, /Validation memory/);
    assert.match(userText, /stale=1/);
    assert.match(userText, /Do not trigger verifier/);
    assert.equal(requests.length, 1);
  } finally {
    await close(server);
  }
});

test("model-driven explorer preserves explicit read_file requests", async () => {
  const cwd = await makeTempWorkspace();
  const largeText = `${"0123456789abcdef".repeat(1024)}\n`;
  await fs.writeFile(path.join(cwd, "large.txt"), largeText, "utf8");
  const requests = [];
  const server = await listen(createToolGateway(requests, {
    toolCall: { id: "read-large", name: "read_file", input: { path: "large.txt", maxBytes: 999999 } },
    finalText: "explorer handled large file"
  }), "127.0.0.1");

  try {
    const result = await runSubagent({
      cwd,
      profileName: "explorer",
      query: "inspect large file without dumping it",
      env: mockGatewayEnv(serverUrl(server))
    });

    assert.equal(result.ok, true);
    assert.equal(result.tools[0].ok, true);
    assert.match(result.tools[0].inputSummary, /maxBytes=999999/);
    const toolResultMessage = requests[1].toolResults?.[0]?.content ?? "";
    assert.match(toolResultMessage, /"bytesRead": 16385/);
    assert.match(toolResultMessage, /"truncated": false/);
  } finally {
    await close(server);
  }
});

test("web researcher writes staged report when search backend is unavailable", async () => {
  const cwd = await makeTempWorkspace();
  const requests = [];
  const server = await listen(createRepeatedToolGateway(requests, {
    toolRounds: 2,
    toolName: "web_search",
    input: { query: "Ant Code project", maxResults: 99 },
    finalText: "staged report from search failure context"
  }), "127.0.0.1");

  try {
    const result = await runSubagent({
      cwd,
      profileName: "web-researcher",
      query: "search for Ant Code project references",
      env: {
        LAB_AGENT_TRANSCRIPT_ENABLED: "false",
        HTTP_PROXY: "http://127.0.0.1:9",
        HTTPS_PROXY: "http://127.0.0.1:9"
      },
      config: {
        modelAlias: "mock-agent",
        networkMode: "lab-only",
        allowedHosts: ["duckduckgo.com"],
        lab: {
          gatewayUrl: `${serverUrl(server)}/v1/chat`,
          gatewayProtocol: "lab-agent-gateway",
          gatewayApiKey: null
        },
        agents: {
          modelTiers: {}
        },
        mcp: {
          servers: []
        }
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.partial, undefined);
    assert.match(result.output, /staged report from search failure context/);
    assert.match(result.tools[0].inputSummary, /maxResults=5/);
    assert.equal(requests.length, 3);
    assert.equal(requests[2].tools.length, 0);
    assert.match(requests[2].messages.at(-1).content, /Do not call more tools/);
  } finally {
    await close(server);
  }
});

test("web researcher continues after a single blocked source fetch", async () => {
  const cwd = await makeTempWorkspace();
  const requests = [];
  const server = await listen(createToolGateway(requests, {
    toolCall: { id: "fetch-github", name: "web_fetch", input: { url: "https://github.com/example/project", maxBytes: 999999 } },
    finalText: "reported with accessible sources and noted github was blocked"
  }), "127.0.0.1");

  try {
    const result = await runSubagent({
      cwd,
      profileName: "web-researcher",
      query: "fetch a github source and report what is available",
      env: {
        LAB_AGENT_TRANSCRIPT_ENABLED: "false"
      },
      config: {
        modelAlias: "mock-agent",
        networkMode: "lab-only",
        allowedHosts: ["duckduckgo.com"],
        lab: {
          gatewayUrl: `${serverUrl(server)}/v1/chat`,
          gatewayProtocol: "lab-agent-gateway",
          gatewayApiKey: null
        },
        agents: {
          modelTiers: {}
        },
        mcp: {
          servers: []
        }
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.partial, undefined);
    assert.match(result.output, /reported with accessible sources/);
    assert.equal(result.tools[0].name, "web_fetch");
    assert.equal(result.tools[0].blocked, true);
    assert.equal(requests.length, 2);
    assert.match(requests[1].toolResults?.[0]?.content ?? "", /blocked|decision|lab-only/i);
  } finally {
    await close(server);
  }
});

test("web researcher writes final report after repeated blocked source fetches", async () => {
  const cwd = await makeTempWorkspace();
  const requests = [];
  const server = await listen(createRepeatedToolGateway(requests, {
    toolRounds: 4,
    toolName: "web_fetch",
    input: { url: "https://blocked.example/project", maxBytes: 999999 },
    finalText: "final report from prior search results with blocked sources listed as caveats"
  }), "127.0.0.1");

  try {
    const result = await runSubagent({
      cwd,
      profileName: "web-researcher",
      query: "fetch several web sources and report what is available",
      env: {
        LAB_AGENT_TRANSCRIPT_ENABLED: "false"
      },
      config: {
        modelAlias: "mock-agent",
        networkMode: "lab-only",
        allowedHosts: ["duckduckgo.com"],
        lab: {
          gatewayUrl: `${serverUrl(server)}/v1/chat`,
          gatewayProtocol: "lab-agent-gateway",
          gatewayApiKey: null
        },
        agents: {
          modelTiers: {},
          budgets: {
            "web-researcher": {
              maxPermissionDenials: 2,
              maxConsecutiveFailures: 2
            }
          }
        },
        mcp: {
          servers: []
        }
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.partial, undefined);
    assert.match(result.output, /final report from prior search results/);
    assert.equal(result.tools.length, 2);
    assert.equal(result.tools.every((tool) => tool.blocked === true), true);
    assert.equal(requests.length, 3);
    assert.deepEqual(requests[2].tools, []);
    assert.match(requests[2].messages.at(-1).content, /Do not call more tools/);
  } finally {
    await close(server);
  }
});

test("readonly researcher writes final report after repeated blocked github fetches", async () => {
  const cwd = await makeTempWorkspace();
  const requests = [];
  const server = await listen(createRepeatedToolGateway(requests, {
    toolRounds: 6,
    toolName: "web_fetch",
    input: { url: "https://github.com/example/project", maxBytes: 999999 },
    finalText: "readonly researcher final report from successful raw and api evidence"
  }), "127.0.0.1");

  try {
    const result = await runSubagent({
      cwd,
      profileName: "readonly-researcher",
      query: "research a GitHub repository and summarize available evidence",
      env: {
        LAB_AGENT_TRANSCRIPT_ENABLED: "false"
      },
      config: {
        modelAlias: "mock-agent",
        networkMode: "lab-only",
        allowedHosts: ["raw.githubusercontent.com", "api.github.com"],
        lab: {
          gatewayUrl: `${serverUrl(server)}/v1/chat`,
          gatewayProtocol: "lab-agent-gateway",
          gatewayApiKey: null
        },
        agents: {
          modelTiers: {},
          budgets: {
            "readonly-researcher": {
              maxPermissionDenials: 2,
              maxConsecutiveFailures: 2
            }
          }
        },
        mcp: {
          servers: []
        }
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.partial, undefined);
    assert.match(result.output, /readonly researcher final report/);
    assert.equal(result.tools.length, 2);
    assert.equal(result.tools.every((tool) => tool.blocked === true), true);
    assert.equal(requests.length, 3);
    assert.deepEqual(requests[2].tools, []);
    assert.match(requests[2].messages.at(-1).content, /Do not call more tools/);
  } finally {
    await close(server);
  }
});

test("readonly researcher reports from successful evidence when github denials accumulate", async () => {
  const cwd = await makeTempWorkspace();
  const contentServer = await listen(createTextServer("raw api source evidence for evropi U-Net requirements"), "127.0.0.1");
  const sourceUrl = `${serverUrl(contentServer)}/raw-requirements`;
  const requests = [];
  const server = await listen(createSequenceToolGateway(requests, {
    toolCalls: [
      { id: "fetch-readme-html", name: "web_fetch", input: { url: "https://github.com/evropi/U-Net/tree/main", maxBytes: 15000 } },
      { id: "fetch-raw-requirements", name: "web_fetch", input: { url: sourceUrl, maxBytes: 8000 } },
      { id: "fetch-github-html-a", name: "web_fetch", input: { url: "https://github.com/evropi/U-Net/blob/main/unet/unet.py", maxBytes: 8000 } },
      { id: "fetch-raw-unet", name: "web_fetch", input: { url: sourceUrl, maxBytes: 8000 } },
      { id: "fetch-github-html-b", name: "web_fetch", input: { url: "https://github.com/evropi/U-Net/blob/main/unet/layers.py", maxBytes: 5000 } },
      { id: "fetch-raw-layers", name: "web_fetch", input: { url: sourceUrl, maxBytes: 5000 } },
      { id: "fetch-github-html-c", name: "web_fetch", input: { url: "https://github.com/evropi/U-Net/blob/main/unet/image_util.py", maxBytes: 5000 } }
    ],
    finalText: "final U-Net environment report from successful raw/API evidence with github HTML caveats"
  }), "127.0.0.1");

  try {
    const result = await runSubagent({
      cwd,
      profileName: "readonly-researcher",
      query: "research evropi/U-Net runtime requirements from GitHub and raw sources",
      env: {
        LAB_AGENT_TRANSCRIPT_ENABLED: "false"
      },
      config: {
        modelAlias: "mock-agent",
        networkMode: "lab-only",
        allowedHosts: ["127.0.0.1"],
        lab: {
          gatewayUrl: `${serverUrl(server)}/v1/chat`,
          gatewayProtocol: "lab-agent-gateway",
          gatewayApiKey: null
        },
        agents: {
          modelTiers: {},
          budgets: {
            "readonly-researcher": {
              maxPermissionDenials: 3,
              maxConsecutiveFailures: 10
            }
          }
        },
        mcp: {
          servers: []
        }
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.partial, undefined);
    assert.match(result.output, /final U-Net environment report/);
    assert.equal(result.tools.length, 5);
    assert.equal(result.tools.filter((tool) => tool.blocked).length, 3);
    assert.equal(result.tools.filter((tool) => tool.ok).length, 2);
    assert.deepEqual(requests.at(-1).tools, []);
    assert.match(requests.at(-1).messages.at(-1).content, /Do not call more tools/);
  } finally {
    await close(server);
    await close(contentServer);
  }
});

test("model-driven subagent preserves older tool results while continuing long web research", async () => {
  const cwd = await makeTempWorkspace();
  const contentServer = await listen(createTextServer("large source evidence ".repeat(1200)), "127.0.0.1");
  const sourceUrl = `${serverUrl(contentServer)}/large-source`;
  const requests = [];
  const server = await listen(createRepeatedToolGateway(requests, {
    toolRounds: 6,
    toolName: "web_fetch",
    input: { url: sourceUrl, maxBytes: 999999 },
    finalText: "web researcher finished after preserving old evidence"
  }), "127.0.0.1");

  try {
    const result = await runSubagent({
      cwd,
      profileName: "web-researcher",
      query: "fetch several large web sources and summarize them",
      env: {
        LAB_AGENT_TRANSCRIPT_ENABLED: "false"
      },
      config: {
        modelAlias: "mock-agent",
        networkMode: "lab-only",
        allowedHosts: ["127.0.0.1"],
        context: {
          maxTokens: 800,
          inFlightCompactRatio: 0.1,
          inFlightKeepRecentTools: 1
        },
        lab: {
          gatewayUrl: `${serverUrl(server)}/v1/chat`,
          gatewayProtocol: "lab-agent-gateway",
          gatewayApiKey: null
        },
        agents: {
          modelTiers: {},
          budgets: {
            "web-researcher": {
              maxConsecutiveFailures: 20,
              maxPermissionDenials: 20
            }
          }
        },
        mcp: {
          servers: []
        }
      }
    });

    const laterRequests = requests.slice(2);
    const compactedSeen = laterRequests.some((request) => JSON.stringify(request.messages).includes("[compacted tool result]"));
    assert.equal(result.ok, true);
    assert.match(result.output, /finished after preserving/);
    assert.equal(requests.length, 7);
    assert.equal(compactedSeen, false);
  } finally {
    await close(server);
    await close(contentServer);
  }
});

test("model-driven subagent records prompt token estimates for task displays", async () => {
  const cwd = await makeTempWorkspace();
  await fs.writeFile(path.join(cwd, "notes.txt"), "hello from notes\n", "utf8");
  const requests = [];
  const server = await listen(createRepeatedToolGateway(requests, {
    toolRounds: 1,
    finalText: "explorer finished with token diagnostics",
    usage: { prompt_tokens: 321, completion_tokens: 17, total_tokens: 338 }
  }), "127.0.0.1");

  try {
    const result = await runSubagent({
      cwd,
      profileName: "explorer",
      query: "read notes once and summarize",
      env: mockGatewayEnv(serverUrl(server)),
      config: {
        modelAlias: "mock-agent",
        networkMode: "offline",
        allowedHosts: [],
        transcript: { enabled: false, retentionDays: 30, includeToolOutput: "policy", encryption: "off" },
        context: { maxMessages: 100000, maxBytes: 800000, maxTokens: 200000, keepRecentMessages: 8, summaryBytes: 65536 },
        agents: { profiles: [] },
        lab: {
          gatewayUrl: `${serverUrl(server)}/v1/chat`,
          gatewayProtocol: "lab-agent-gateway",
          gatewayApiKey: null
        }
      }
    });

    const raw = await fs.readFile(path.join(cwd, ".lab-agent", "tasks", `${result.taskId}.json`), "utf8");
    const task = JSON.parse(raw);
    assert.equal(result.ok, true);
    assert.equal(typeof task.budgetProgress.promptTokens, "number");
    assert.ok(task.heartbeatAt);
    assert.ok(task.progressAt);
    assert.equal(typeof task.budgetProgress.promptBytes, "number");
    assert.equal(task.budgetProgress.maxTokens, 200000);
    assert.equal(task.budgetProgress.promptRound, 2);
    assert.equal(typeof task.budgetProgress.promptMessageTokens, "number");
    assert.equal(typeof task.budgetProgress.promptToolSchemaTokens, "number");
    assert.equal(typeof task.budgetProgress.promptToolResultTokens, "number");
    assert.equal(task.budgetProgress.providerPromptTokens, 321);
    assert.equal(task.budgetProgress.providerCompletionTokens, 17);
    assert.equal(task.budgetProgress.providerTotalTokens, 338);
  } finally {
    await close(server);
  }
});

test("model-driven subagent uses configurable agent round budget", async () => {
  const cwd = await makeTempWorkspace();
  await fs.writeFile(path.join(cwd, "notes.txt"), "hello from notes\n", "utf8");
  const requests = [];
  const server = await listen(createRepeatedToolGateway(requests, {
    toolRounds: 4,
    finalText: "explorer finished longer investigation"
  }), "127.0.0.1");

  try {
    const result = await runSubagent({
      cwd,
      profileName: "explorer",
      query: "read notes several times",
      env: {
        ...mockGatewayEnv(serverUrl(server)),
        LAB_AGENT_AGENT_MAX_ROUNDS: "5"
      },
      config: {
        modelAlias: "mock-agent",
        networkMode: "offline",
        allowedHosts: [],
        transcript: { enabled: false, retentionDays: 30, includeToolOutput: "policy", encryption: "off" },
        context: { maxMessages: 100000, maxBytes: 800000, maxTokens: 200000, keepRecentMessages: 8, summaryBytes: 65536 },
        agents: {
          maxRounds: 5,
          profiles: [
            {
              name: "tiny-explorer",
              aliases: ["explorer"],
              mode: "readonly",
              tools: ["read_file"],
              description: "test explorer"
            }
          ]
        },
        lab: {
          gatewayUrl: `${serverUrl(server)}/v1/chat`,
          gatewayProtocol: "lab-agent-gateway",
          gatewayApiKey: null
        }
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.output, "explorer finished longer investigation");
    assert.equal(result.rounds, 5);
    assert.equal(result.tools.length, 4);
  } finally {
    await close(server);
  }
});

test("model-driven subagent default has no model-tool round limit", async () => {
  const cwd = await makeTempWorkspace();
  await fs.writeFile(path.join(cwd, "notes.txt"), "hello from notes\n", "utf8");
  const requests = [];
  const server = await listen(createRepeatedToolGateway(requests, {
    toolRounds: 70,
    finalText: "explorer finished beyond old round limit"
  }), "127.0.0.1");

  try {
    const result = await runSubagent({
      cwd,
      profileName: "explorer",
      query: "read notes many times",
      env: mockGatewayEnv(serverUrl(server)),
      config: {
        modelAlias: "mock-agent",
        networkMode: "offline",
        allowedHosts: [],
        transcript: { enabled: false, retentionDays: 30, includeToolOutput: "policy", encryption: "off" },
        context: { maxMessages: 100000, maxBytes: 800000, maxTokens: 200000, keepRecentMessages: 8, summaryBytes: 65536 },
        agents: {
          maxRounds: null,
          profiles: []
        },
        lab: {
          gatewayUrl: `${serverUrl(server)}/v1/chat`,
          gatewayProtocol: "lab-agent-gateway",
          gatewayApiKey: null
        }
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.partial, undefined);
    assert.equal(result.budget.maxRounds, null);
    assert.equal(result.output, "explorer finished beyond old round limit");
    assert.equal(result.tools.length, 70);
    assert.equal(requests.length, 71);
  } finally {
    await close(server);
  }
});

test("model-driven subagent output budget requests no-tool staged report before partial pause", async () => {
  const cwd = await makeTempWorkspace();
  await fs.writeFile(path.join(cwd, "notes.txt"), `${"evidence ".repeat(20)}\n`, "utf8");
  const requests = [];
  const server = await listen(createRepeatedToolGateway(requests, {
    toolRounds: 99,
    finalText: "staged report from existing evidence"
  }), "127.0.0.1");

  try {
    const result = await runSubagent({
      cwd,
      profileName: "tiny-explorer",
      query: "inspect notes until output budget is reached",
      env: mockGatewayEnv(serverUrl(server)),
      config: {
        modelAlias: "mock-agent",
        networkMode: "offline",
        allowedHosts: [],
        transcript: { enabled: false, retentionDays: 30, includeToolOutput: "policy", encryption: "off" },
        context: { maxMessages: 100000, maxBytes: 800000, maxTokens: 200000, keepRecentMessages: 8, summaryBytes: 65536 },
        agents: {
          profiles: [
            {
              name: "tiny-explorer",
              mode: "readonly",
              tools: ["read_file"],
              description: "test explorer",
              maxOutputBytes: 80,
              maxToolResultBytes: 4000
            }
          ]
        },
        lab: {
          gatewayUrl: `${serverUrl(server)}/v1/chat`,
          gatewayProtocol: "lab-agent-gateway",
          gatewayApiKey: null
        }
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.partial, undefined);
    assert.equal(result.output, "staged report from existing evidence");
    assert.equal(result.tools.length, 1);
    assert.equal(requests.length, 2);
    assert.equal(Array.isArray(requests[1].tools), true);
    assert.equal(requests[1].tools.length, 0);
    const finalPrompt = requests[1].messages.at(-1)?.content ?? "";
    assert.match(finalPrompt, /local guardrail/);
    assert.match(finalPrompt, /Do not call more tools/);
    assert.match(finalPrompt, /continuation plan/);
  } finally {
    await close(server);
  }
});

test("model-driven subagent skips remaining same-round tools after soft guardrail", async () => {
  const cwd = await makeTempWorkspace();
  await fs.writeFile(path.join(cwd, "notes.txt"), `${"evidence ".repeat(20)}\n`, "utf8");
  await fs.writeFile(path.join(cwd, "second.txt"), "this file should not be read\n", "utf8");
  const requests = [];
  const server = await listen(createMultiToolThenFinalGateway(requests, {
    finalText: "staged report after first tool only"
  }), "127.0.0.1");

  try {
    const result = await runSubagent({
      cwd,
      profileName: "tiny-explorer",
      query: "inspect two files but stop after budget",
      env: mockGatewayEnv(serverUrl(server)),
      config: {
        modelAlias: "mock-agent",
        networkMode: "offline",
        allowedHosts: [],
        transcript: { enabled: false, retentionDays: 30, includeToolOutput: "policy", encryption: "off" },
        context: { maxMessages: 100000, maxBytes: 800000, maxTokens: 200000, keepRecentMessages: 8, summaryBytes: 65536 },
        agents: {
          profiles: [
            {
              name: "tiny-explorer",
              mode: "readonly",
              tools: ["read_file"],
              description: "test explorer",
              maxOutputBytes: 80,
              maxToolResultBytes: 4000
            }
          ]
        },
        lab: {
          gatewayUrl: `${serverUrl(server)}/v1/chat`,
          gatewayProtocol: "lab-agent-gateway",
          gatewayApiKey: null
        }
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.output, "staged report after first tool only");
    assert.equal(result.tools.length, 2);
    assert.equal(result.tools[0].ok, true);
    assert.equal(result.tools[1].ok, false);
    assert.equal(result.tools[1].errorCode, "AGENT_TOOL_SKIPPED_AFTER_GUARDRAIL");
    assert.equal(requests.length, 2);
    const toolMessages = requests[1].messages.filter((message) => message.role === "tool");
    assert.equal(toolMessages.length, 2);
    assert.match(toolMessages[1].content[0].text, /AGENT_TOOL_SKIPPED_AFTER_GUARDRAIL/);
    assert.equal(requests[1].tools.length, 0);
  } finally {
    await close(server);
  }
});

test("model-driven subagent saves full long output to task sidecar", async () => {
  const cwd = await makeTempWorkspace();
  const requests = [];
  const longFinalText = `HEAD-${"x".repeat(40_000)}-TAIL`;
  const server = await listen(createRepeatedToolGateway(requests, {
    toolRounds: 0,
    finalText: longFinalText
  }), "127.0.0.1");

  try {
    const result = await runSubagent({
      cwd,
      profileName: "explorer",
      query: "write a long report",
      env: mockGatewayEnv(serverUrl(server))
    });

    assert.equal(result.ok, true);
    assert.equal(result.outputTruncated, true);
    assert.notEqual(result.output, longFinalText);
    assert.equal(result.outputFull, longFinalText);
    const task = JSON.parse(await fs.readFile(path.join(cwd, ".lab-agent", "tasks", `${result.taskId}.json`), "utf8"));
    assert.equal(task.metadata.outputTruncated, true);
    assert.equal(task.metadata.outputBytes, Buffer.byteLength(longFinalText, "utf8"));
    assert.match(task.output, /full task output saved to sidecar/);
    const sidecar = await fs.readFile(path.join(cwd, task.metadata.outputPath), "utf8");
    assert.equal(sidecar, longFinalText);
  } finally {
    await close(server);
  }
});

test("planner subagent persists parseable plan package under .lab-agent/plans", async () => {
  const cwd = await makeTempWorkspace();
  const requests = [];
  const finalText = JSON.stringify({
    requirementsDoc: "# Requirements\n\n- Confirmed requirement",
    taskPlanDoc: "# Task Plan\n\n- Detailed planning",
    executionChecklist: "# Execution Checklist\n\n- Stage 1: implement\n- Stage 1 review gate",
    traceabilityMap: { requirement1: ["stage-1"] },
    handoffPrompt: "Run stage 1."
  });
  const server = await listen(createRepeatedToolGateway(requests, {
    toolRounds: 0,
    finalText
  }), "127.0.0.1");

  try {
    const result = await runSubagent({
      cwd,
      profileName: "planner",
      query: "generate plan package",
      parentSessionId: "session-plan",
      env: mockGatewayEnv(serverUrl(server))
    });

    assert.equal(result.ok, true);
    const task = JSON.parse(await fs.readFile(path.join(cwd, ".lab-agent", "tasks", `${result.taskId}.json`), "utf8"));
    assert.equal(task.metadata.planPackage, true);
    assert.match(task.metadata.planPackagePath, /^\.lab-agent\/plans\/plan-/);
    assert.equal(task.metadata.planPackageFiles.requirements.endsWith("/requirements.md"), true);
    assert.match(await fs.readFile(path.join(cwd, task.metadata.planPackageFiles.requirements), "utf8"), /Confirmed requirement/);
    assert.match(await fs.readFile(path.join(cwd, task.metadata.planPackageFiles.taskPlan), "utf8"), /Detailed planning/);
    assert.match(await fs.readFile(path.join(cwd, task.metadata.planPackageFiles.executionChecklist), "utf8"), /Stage 1 review gate/);
  } finally {
    await close(server);
  }
});

test("planner subagent persists fenced json plan package with nested markdown code fences", async () => {
  const cwd = await makeTempWorkspace();
  const requests = [];
  const finalText = [
    "Planner package follows.",
    "```json",
    JSON.stringify({
      requirementsDoc: "# Requirements\n\n- Confirm plan package persistence.",
      taskPlanDoc: "# Task Plan\n\n```js\nconsole.log(\"nested fence\");\n```\n\n- Keep runner-owned persistence.",
      executionChecklist: "# Execution Checklist\n\n```powershell\nnode --test tests/unit/agents.test.js\n```\n\n- Strict review gate.",
      traceabilityMap: { requirement1: ["stage-1"] },
      handoffPrompt: "Run stage 1."
    }, null, 2),
    "```"
  ].join("\n");
  const server = await listen(createRepeatedToolGateway(requests, {
    toolRounds: 0,
    finalText
  }), "127.0.0.1");

  try {
    const result = await runSubagent({
      cwd,
      profileName: "planner",
      query: "generate fenced plan package",
      env: mockGatewayEnv(serverUrl(server))
    });

    assert.equal(result.ok, true);
    assert.equal(result.planPackage.ok, true);
    const task = JSON.parse(await fs.readFile(path.join(cwd, ".lab-agent", "tasks", `${result.taskId}.json`), "utf8"));
    assert.equal(task.metadata.planPackage, true);
    assert.match(await fs.readFile(path.join(cwd, task.metadata.planPackageFiles.taskPlan), "utf8"), /nested fence/);
    assert.match(await fs.readFile(path.join(cwd, task.metadata.planPackageFiles.executionChecklist), "utf8"), /Strict review gate/);
  } finally {
    await close(server);
  }
});

test("planner subagent keeps successful task when plan package cannot be parsed", async () => {
  const cwd = await makeTempWorkspace();
  const requests = [];
  const server = await listen(createRepeatedToolGateway(requests, {
    toolRounds: 0,
    finalText: "plain planning notes without the three required documents"
  }), "127.0.0.1");

  try {
    const result = await runSubagent({
      cwd,
      profileName: "planner",
      query: "generate incomplete plan",
      env: mockGatewayEnv(serverUrl(server))
    });

    assert.equal(result.ok, true);
    const task = JSON.parse(await fs.readFile(path.join(cwd, ".lab-agent", "tasks", `${result.taskId}.json`), "utf8"));
    assert.equal(task.status, "completed");
    assert.equal(task.metadata.planPackage, false);
    assert.equal(task.metadata.planPackageError.code, "PLAN_PACKAGE_NOT_FOUND");
    await assert.rejects(fs.readdir(path.join(cwd, ".lab-agent", "plans")), /ENOENT/);
  } finally {
    await close(server);
  }
});

test("model-driven subagent writes staged report at configurable round limit", async () => {
  const cwd = await makeTempWorkspace();
  await fs.writeFile(path.join(cwd, "notes.txt"), "hello from notes\n", "utf8");
  const requests = [];
  const server = await listen(createRepeatedToolGateway(requests, {
    toolRounds: 99,
    finalText: "staged report at configured round limit"
  }), "127.0.0.1");

  try {
    const result = await runSubagent({
      cwd,
      profileName: "tiny-explorer",
      query: "loop tools",
      env: mockGatewayEnv(serverUrl(server)),
      config: {
        modelAlias: "mock-agent",
        networkMode: "offline",
        allowedHosts: [],
        transcript: { enabled: false, retentionDays: 30, includeToolOutput: "policy", encryption: "off" },
        context: { maxMessages: 100000, maxBytes: 800000, maxTokens: 200000, keepRecentMessages: 8, summaryBytes: 65536 },
        agents: {
          maxRounds: 2,
          profiles: [
            {
              name: "tiny-explorer",
              mode: "readonly",
              tools: ["read_file"],
              description: "test explorer"
            }
          ]
        },
        lab: {
          gatewayUrl: `${serverUrl(server)}/v1/chat`,
          gatewayProtocol: "lab-agent-gateway",
          gatewayApiKey: null
        }
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.partial, undefined);
    assert.match(result.output, /staged report at configured round limit/);
    assert.equal(result.budget.maxRounds, 2);
    assert.equal(requests.length, 3);
    assert.equal(requests[2].tools.length, 0);
    assert.match(requests[2].messages.at(-1).content, /local guardrail/);
  } finally {
    await close(server);
  }
});

test("configured agent round budget overrides builtin profile defaults", async () => {
  const cwd = await makeTempWorkspace();
  await fs.writeFile(path.join(cwd, "notes.txt"), "hello from notes\n", "utf8");
  const requests = [];
  const server = await listen(createRepeatedToolGateway(requests, {
    toolRounds: 99,
    finalText: "staged report from configured builtin round limit"
  }), "127.0.0.1");

  try {
    const result = await runSubagent({
      cwd,
      profileName: "explorer",
      query: "loop builtin explorer",
      env: {
        ...mockGatewayEnv(serverUrl(server)),
        LAB_AGENT_AGENT_MAX_ROUNDS: "3"
      },
      config: {
        modelAlias: "mock-agent",
        networkMode: "offline",
        allowedHosts: [],
        transcript: { enabled: false, retentionDays: 30, includeToolOutput: "policy", encryption: "off" },
        context: { maxMessages: 100000, maxBytes: 800000, maxTokens: 200000, keepRecentMessages: 8, summaryBytes: 65536 },
        agents: {
          maxRounds: 3,
          profiles: []
        },
        lab: {
          gatewayUrl: `${serverUrl(server)}/v1/chat`,
          gatewayProtocol: "lab-agent-gateway",
          gatewayApiKey: null
        }
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.partial, undefined);
    assert.match(result.output, /configured builtin round limit/);
    assert.equal(result.budget.maxRounds, 3);
    assert.equal(requests.length, 4);
    assert.equal(requests[3].tools.length, 0);
  } finally {
    await close(server);
  }
});

test("junior subagent requires write scope before writing", async () => {
  const cwd = await makeTempWorkspace();
  const requests = [];
  const server = await listen(createToolGateway(requests, {
    toolCall: { id: "write-notes", name: "write_file", input: { path: "notes.txt", content: "created by junior\n" } },
    finalText: "junior wrote notes"
  }), "127.0.0.1");

  try {
    const blockedByScope = await runSubagent({
      cwd,
      profileName: "junior",
      query: "write notes",
      allowWrite: true,
      env: mockGatewayEnv(serverUrl(server))
    });
    assert.equal(blockedByScope.ok, true);
    assert.equal(blockedByScope.tools[0].errorCode, "AGENT_TOOL_NOT_ALLOWED");
    await assert.rejects(fs.readFile(path.join(cwd, "notes.txt"), "utf8"), /ENOENT/);

    requests.length = 0;
    const allowed = await runSubagent({
      cwd,
      profileName: "junior",
      query: "write notes",
      writeScope: ["notes.txt"],
      allowWrite: true,
      env: mockGatewayEnv(serverUrl(server))
    });

    assert.equal(allowed.ok, true);
    assert.equal(allowed.tools[0].ok, true);
    assert.equal(await fs.readFile(path.join(cwd, "notes.txt"), "utf8"), "created by junior\n");
  } finally {
    await close(server);
  }
});

test("full access junior can write without write scope approval blockers", async () => {
  const cwd = await makeTempWorkspace();
  const requests = [];
  const server = await listen(createToolGateway(requests, {
    toolCall: { id: "write-notes", name: "write_file", input: { path: "notes.txt", content: "created by full access junior\n" } },
    finalText: "junior wrote notes in full access"
  }), "127.0.0.1");

  try {
    const result = await runSubagent({
      cwd,
      profileName: "junior",
      query: "write notes without a declared scope",
      fullAccess: true,
      env: mockGatewayEnv(serverUrl(server))
    });

    assert.equal(result.ok, true);
    assert.equal(result.tools[0].name, "write_file");
    assert.equal(result.tools[0].ok, true);
    assert.equal(await fs.readFile(path.join(cwd, "notes.txt"), "utf8"), "created by full access junior\n");
    const offeredToolNames = requests[0].tools.map((tool) => tool.name);
    assert.equal(offeredToolNames.includes("write_file"), true);
    assert.equal(offeredToolNames.includes("powershell"), true);
  } finally {
    await close(server);
  }
});

test("code-worker subagent requires write scope and parent policy before writing", async () => {
  const cwd = await makeTempWorkspace();
  const requests = [];
  const server = await listen(createToolGateway(requests, {
    toolCall: { id: "write-notes", name: "write_file", input: { path: "notes.txt", content: "created by agent\n" } },
    finalText: "code-worker wrote notes"
  }), "127.0.0.1");

  try {
    const blockedByScope = await runSubagent({
      cwd,
      profileName: "code-worker",
      query: "write notes",
      allowWrite: true,
      allowCommand: true,
      env: mockGatewayEnv(serverUrl(server))
    });

    assert.equal(blockedByScope.ok, true);
    assert.equal(blockedByScope.tools[0].errorCode, "AGENT_TOOL_NOT_ALLOWED");
    const blockedToolNames = requests[0].tools.map((tool) => tool.name);
    assert.equal(blockedToolNames.includes("write_file"), false);
    assert.equal(blockedToolNames.includes("edit_file"), false);
    assert.equal(blockedToolNames.includes("powershell"), false);
    assert.equal(blockedToolNames.includes("mcp_call"), false);
    await assert.rejects(fs.readFile(path.join(cwd, "notes.txt"), "utf8"), /ENOENT/);

    requests.length = 0;
    const allowed = await runSubagent({
      cwd,
      profileName: "code-worker",
      query: "write notes",
      writeScope: ["notes.txt"],
      allowWrite: true,
      env: mockGatewayEnv(serverUrl(server))
    });

    assert.equal(allowed.ok, true);
    assert.equal(allowed.tools[0].ok, true);
    assert.equal(await fs.readFile(path.join(cwd, "notes.txt"), "utf8"), "created by agent\n");
  } finally {
    await close(server);
  }
});

test("verifier execute subagent can run validation commands without write tools", async () => {
  const cwd = await makeTempWorkspace();
  const requests = [];
  const server = await listen(createToolGateway(requests, {
    toolCall: { id: "verify-command", name: "powershell", input: { command: "Write-Output verifier-ok" } },
    finalText: "verifier command completed"
  }), "127.0.0.1");

  try {
    const result = await runSubagent({
      cwd,
      profileName: "verifier",
      query: "run a minimal validation command",
      allowCommand: true,
      env: mockGatewayEnv(serverUrl(server))
    });

    assert.equal(result.ok, true);
    assert.equal(result.profile, "verifier");
    assert.equal(result.mode, "execute");
    assert.equal(result.tools[0].name, "powershell");
    assert.equal(result.tools[0].ok, true);
    assert.equal(result.tools[0].blocked, false);
    assert.equal(result.tools[0].errorCode, null);
    assert.match(result.output, /verifier command completed/);
    const offeredToolNames = requests[0].tools.map((tool) => tool.name);
    assert.equal(offeredToolNames.includes("powershell"), true);
    assert.equal(offeredToolNames.includes("write_file"), false);
    assert.equal(offeredToolNames.includes("edit_file"), false);
  } finally {
    await close(server);
  }
});

async function makeTempWorkspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
}

/**
 * @param {Array<Record<string, any>>} requests
 * @param {{ toolCall: Record<string, any>; finalText: string }} fixture
 */
function createToolGateway(requests, fixture) {
  return http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      return;
    }

    const body = await readRequestJson(request);
    requests.push(body);
    response.writeHead(200, { "content-type": "application/json" });

    if (requests.length % 2 === 1) {
      response.end(JSON.stringify({
        id: "mock-agent-tool",
        model: body.model,
        content: [],
        toolCalls: [fixture.toolCall],
        stopReason: "tool_calls"
      }));
      return;
    }

    response.end(JSON.stringify({
      id: "mock-agent-final",
      model: body.model,
      content: [{ type: "text", text: fixture.finalText }],
      toolCalls: [],
      stopReason: "stop"
    }));
  });
}

function createFinalOnlyGateway(requests, finalText) {
  return http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      return;
    }

    const body = await readRequestJson(request);
    requests.push(body);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "mock-agent-final",
      model: body.model,
      content: [{ type: "text", text: finalText }],
      toolCalls: [],
      stopReason: "stop"
    }));
  });
}

/**
 * @param {Array<Record<string, any>>} requests
 */
function createReasoningToolGateway(requests) {
  return http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      return;
    }

    const body = await readRequestJson(request);
    requests.push(body);

    if (requests.length === 1) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"id":"chatcmpl-subagent-tool","model":"mock-agent","choices":[{"delta":{"reasoning_content":"Subagent needs to read notes before reporting."}}]}\n\n');
      response.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-read-notes","function":{"name":"read_file","arguments":"{\\"path\\":\\"notes.txt\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n');
      response.end("data: [DONE]\n\n");
      return;
    }

    const assistant = body.messages?.find((message) => message.role === "assistant" && Array.isArray(message.tool_calls));
    if (assistant?.reasoning_content !== "Subagent needs to read notes before reporting.") {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({
        error: {
          message: "The `reasoning_content` in the thinking mode must be passed back to the API.",
          type: "invalid_request_error"
        }
      }));
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "chatcmpl-subagent-final",
      model: body.model,
      choices: [
        {
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: "subagent reasoning continuation accepted"
          }
        }
      ]
    }));
  });
}

/**
 * @param {Array<Record<string, any>>} requests
 * @param {{ toolRounds: number; finalText: string; toolName?: string; input?: Record<string, any>; usage?: Record<string, any> }} fixture
 */
function createRepeatedToolGateway(requests, fixture) {
  return http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      return;
    }

    const body = await readRequestJson(request);
    requests.push(body);
    response.writeHead(200, { "content-type": "application/json" });

    if (Array.isArray(body.tools) && body.tools.length === 0) {
      response.end(JSON.stringify({
        id: "mock-agent-final-no-tools",
        model: body.model,
        content: [{ type: "text", text: fixture.finalText }],
        toolCalls: [],
        stopReason: "stop"
      }));
      return;
    }

    if (requests.length <= fixture.toolRounds) {
      const toolName = fixture.toolName ?? "read_file";
      const input = fixture.input ?? { path: "notes.txt", maxBytes: 1024 };
      response.end(JSON.stringify({
        id: `mock-agent-tool-${requests.length}`,
        model: body.model,
        content: [],
        toolCalls: [
          {
            id: `${toolName}-${requests.length}`,
            name: toolName,
            input
          }
        ],
        stopReason: "tool_calls",
        usage: fixture.usage
      }));
      return;
    }

    response.end(JSON.stringify({
      id: "mock-agent-final",
      model: body.model,
      content: [{ type: "text", text: fixture.finalText }],
      toolCalls: [],
      stopReason: "stop",
      usage: fixture.usage
    }));
  });
}

/**
 * @param {Array<Record<string, any>>} requests
 * @param {{ finalText: string }} fixture
 */
function createMultiToolThenFinalGateway(requests, fixture) {
  return http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      return;
    }

    const body = await readRequestJson(request);
    requests.push(body);
    response.writeHead(200, { "content-type": "application/json" });

    if (Array.isArray(body.tools) && body.tools.length === 0) {
      response.end(JSON.stringify({
        id: "mock-agent-final-no-tools",
        model: body.model,
        content: [{ type: "text", text: fixture.finalText }],
        toolCalls: [],
        stopReason: "stop"
      }));
      return;
    }

    response.end(JSON.stringify({
      id: "mock-agent-tool-pair",
      model: body.model,
      content: [],
      toolCalls: [
        {
          id: "read-notes",
          name: "read_file",
          input: { path: "notes.txt", maxBytes: 1024 }
        },
        {
          id: "read-second",
          name: "read_file",
          input: { path: "second.txt", maxBytes: 1024 }
        }
      ],
      stopReason: "tool_calls"
    }));
  });
}

/**
 * @param {Array<Record<string, any>>} requests
 * @param {{ toolCalls: Array<Record<string, any>>; finalText: string }} fixture
 */
function createSequenceToolGateway(requests, fixture) {
  return http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      return;
    }

    const body = await readRequestJson(request);
    requests.push(body);
    response.writeHead(200, { "content-type": "application/json" });

    if (Array.isArray(body.tools) && body.tools.length === 0) {
      response.end(JSON.stringify({
        id: "mock-agent-final-no-tools",
        model: body.model,
        content: [{ type: "text", text: fixture.finalText }],
        toolCalls: [],
        stopReason: "stop"
      }));
      return;
    }

    const toolCall = fixture.toolCalls[requests.length - 1];
    if (toolCall) {
      response.end(JSON.stringify({
        id: `mock-agent-tool-${requests.length}`,
        model: body.model,
        content: [],
        toolCalls: [toolCall],
        stopReason: "tool_calls"
      }));
      return;
    }

    response.end(JSON.stringify({
      id: "mock-agent-final",
      model: body.model,
      content: [{ type: "text", text: fixture.finalText }],
      toolCalls: [],
      stopReason: "stop"
    }));
  });
}

function createTextServer(text) {
  return http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end(text);
  });
}

/**
 * @param {http.IncomingMessage} request
 */
function readRequestJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("error", reject);
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
  });
}

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
 * @param {{ protocol?: string }} [options]
 */
function mockGatewayEnv(url, options = {}) {
  const protocol = options.protocol ?? "lab-agent-gateway";
  const route = protocol === "openai-chat" ? "/v1/chat/completions" : "/v1/chat";
  return {
    LAB_MODEL_GATEWAY_URL: `${url}${route}`,
    LAB_MODEL_GATEWAY_PROTOCOL: protocol,
    LAB_AGENT_MODEL: "mock-agent",
    LAB_AGENT_NETWORK_MODE: "offline",
    LAB_AGENT_TRANSCRIPT_ENABLED: "false"
  };
}

function isolatedEnv() {
  return {
    LAB_MODEL_GATEWAY_URL: "",
    LAB_MODEL_GATEWAY_PROTOCOL: "lab-agent-gateway",
    LAB_MODEL_GATEWAY_API_KEY: "",
    LAB_AGENT_MODEL: "mock-agent",
    LAB_AGENT_TRANSCRIPT_ENABLED: "false"
  };
}
