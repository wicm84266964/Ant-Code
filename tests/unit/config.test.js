import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../../src/config/load-config.js";

test("loads gateway and network mode from environment", async () => {
  const cwd = await makeTempWorkspace();
  const config = await loadConfig({
    cwd,
    env: {
      LAB_MODEL_GATEWAY_URL: "https://gateway.lab.example/v1/chat",
      LAB_MODEL_GATEWAY_HEALTH_URL: "https://gateway.lab.example/health",
      LAB_AGENT_NETWORK_MODE: "lab-only",
      LAB_AGENT_MODEL: "lab-default",
      LAB_MODEL_GATEWAY_PROTOCOL: "openai-chat",
      LAB_MODEL_GATEWAY_API_KEY: "test-key"
    }
  });

  assert.equal(config.lab.gatewayUrl, "https://gateway.lab.example/v1/chat");
  assert.equal(config.lab.gatewayHealthUrl, "https://gateway.lab.example/health");
  assert.equal(config.lab.gatewayProtocol, "openai-chat");
  assert.equal(config.lab.gatewayApiKey, "test-key");
  assert.equal(config.lab.gatewayMaxRetries, 5);
  assert.equal(config.modelAlias, "lab-default");
  assert.equal(config.networkMode, "lab-only");
  assert.ok(config.allowedHosts.includes("gateway.lab.example"));
  assert.equal(config.configSources.modelAlias.type, "environment");
  assert.equal(config.configSources.lab.gatewayUrl.type, "environment");
  assert.equal(config.configSources.lab.gatewayApiKey.type, "environment");
});

test("loads gateway retry budget from environment and project config", async () => {
  const cwd = await makeTempWorkspace();
  await writeJson(cwd, {
    lab: {
      gatewayMaxRetries: 1,
      gatewayTimeoutMs: 120000,
      gatewayIdleTimeoutMs: 30000
    }
  });

  const fromProject = await loadConfig({ cwd, env: {} });
  assert.equal(fromProject.lab.gatewayMaxRetries, 1);
  assert.equal(fromProject.lab.gatewayTimeoutMs, 120000);
  assert.equal(fromProject.lab.gatewayIdleTimeoutMs, 30000);

  const fromEnv = await loadConfig({
    cwd,
    env: {
      LAB_MODEL_GATEWAY_MAX_RETRIES: "3",
      LAB_MODEL_GATEWAY_TIMEOUT_MS: "45000",
      LAB_MODEL_GATEWAY_IDLE_TIMEOUT_MS: "15000"
    }
  });
  assert.equal(fromEnv.lab.gatewayMaxRetries, 3);
  assert.equal(fromEnv.lab.gatewayTimeoutMs, 45000);
  assert.equal(fromEnv.lab.gatewayIdleTimeoutMs, 15000);
});

test("loads transcript policy from environment", async () => {
  const config = await loadConfig({
    cwd: process.cwd(),
    env: {
      LAB_AGENT_TRANSCRIPT_ENABLED: "false",
      LAB_AGENT_TRANSCRIPT_RETENTION_DAYS: "0",
      LAB_AGENT_TRANSCRIPT_ENCRYPTION: "required"
    }
  });

  assert.equal(config.transcript.enabled, false);
  assert.equal(config.transcript.retentionDays, 0);
  assert.equal(config.transcript.encryption, "required");
});

test("loads context budget from environment", async () => {
  const config = await loadConfig({
    cwd: process.cwd(),
    env: {
      LAB_AGENT_CONTEXT_MAX_MESSAGES: "12",
      LAB_AGENT_CONTEXT_MAX_BYTES: "32000",
      LAB_AGENT_CONTEXT_MAX_TOKENS: "9000",
      LAB_AGENT_CONTEXT_KEEP_RECENT_MESSAGES: "6",
      LAB_AGENT_CONTEXT_TAIL_TURNS: "3",
      LAB_AGENT_CONTEXT_PRESERVE_RECENT_TOKENS: "7000",
      LAB_AGENT_CONTEXT_SUMMARY_BYTES: "4096",
      LAB_AGENT_CONTEXT_RESUME_MAX_MESSAGES: "24",
      LAB_AGENT_CONTEXT_RESUME_MAX_TOKENS: "12000",
      LAB_AGENT_CONTEXT_RESUME_MAX_BYTES: "48000"
    }
  });

  assert.equal(config.context.maxMessages, 12);
  assert.equal(config.context.maxBytes, 32000);
  assert.equal(config.context.maxTokens, 9000);
  assert.equal(config.context.keepRecentMessages, 6);
  assert.equal(config.context.tailTurns, 3);
  assert.equal(config.context.preserveRecentTokens, 7000);
  assert.equal(config.context.summaryBytes, 4096);
  assert.equal(config.context.resumeMaxMessages, 24);
  assert.equal(config.context.resumeMaxTokens, 12000);
  assert.equal(config.context.resumeMaxBytes, 48000);
});

test("resume context budget follows active context budget by default", async () => {
  const cwd = await makeTempWorkspace();
  await writeJson(cwd, {
    context: {
      maxMessages: 100000,
      maxBytes: 2000000,
      maxTokens: 500000,
      keepRecentMessages: 8,
      tailTurns: 2,
      preserveRecentTokens: 8000,
      summaryBytes: 65536,
      resumeMaxMessages: 200,
      resumeMaxTokens: 200000,
      resumeMaxBytes: 1000000
    }
  });

  const config = await loadConfig({ cwd, env: {} });

  assert.equal(config.context.maxBytes, 2000000);
  assert.equal(config.context.resumeMaxMessages, 100000);
  assert.equal(config.context.resumeMaxTokens, 500000);
  assert.equal(config.context.resumeMaxBytes, 2000000);
});

test("context byte budget follows a larger token window by default", async () => {
  const cwd = await makeTempWorkspace();
  await writeJson(cwd, {
    context: {
      maxMessages: 100000,
      maxBytes: 2000000,
      maxTokens: 800000,
      keepRecentMessages: 8,
      tailTurns: 2,
      preserveRecentTokens: 8000,
      summaryBytes: 65536,
      resumeMaxMessages: 100000,
      resumeMaxTokens: 800000,
      resumeMaxBytes: 2000000
    }
  });

  const config = await loadConfig({ cwd, env: {} });

  assert.equal(config.context.maxTokens, 800000);
  assert.equal(config.context.maxBytes, 3200000);
  assert.equal(config.context.resumeMaxTokens, 800000);
  assert.equal(config.context.resumeMaxBytes, 3200000);
});

test("resume context budget env overrides remain explicit", async () => {
  const cwd = await makeTempWorkspace();
  await writeJson(cwd, {
    context: {
      maxMessages: 100000,
      maxBytes: 2000000,
      maxTokens: 500000,
      keepRecentMessages: 8,
      tailTurns: 2,
      preserveRecentTokens: 8000,
      summaryBytes: 65536
    }
  });

  const config = await loadConfig({
    cwd,
    env: {
      LAB_AGENT_CONTEXT_RESUME_MAX_MESSAGES: "200",
      LAB_AGENT_CONTEXT_RESUME_MAX_TOKENS: "200000",
      LAB_AGENT_CONTEXT_RESUME_MAX_BYTES: "1000000"
    }
  });

  assert.equal(config.context.resumeMaxMessages, 200);
  assert.equal(config.context.resumeMaxTokens, 200000);
  assert.equal(config.context.resumeMaxBytes, 1000000);
});

test("explicit context byte env override remains a hard budget", async () => {
  const cwd = await makeTempWorkspace();
  await writeJson(cwd, {
    context: {
      maxMessages: 100000,
      maxBytes: 2000000,
      maxTokens: 800000,
      keepRecentMessages: 8,
      tailTurns: 2,
      preserveRecentTokens: 8000,
      summaryBytes: 65536,
      resumeMaxMessages: 100000,
      resumeMaxTokens: 800000,
      resumeMaxBytes: 2000000
    }
  });

  const config = await loadConfig({
    cwd,
    env: {
      LAB_AGENT_CONTEXT_MAX_BYTES: "1600000"
    }
  });

  assert.equal(config.context.maxTokens, 800000);
  assert.equal(config.context.maxBytes, 1600000);
  assert.equal(config.context.resumeMaxBytes, 2000000);
});

test("loads tool round budgets from environment", async () => {
  const config = await loadConfig({
    cwd: process.cwd(),
    env: {
      LAB_AGENT_MAX_TOOL_ROUNDS: "24",
      LAB_AGENT_AGENT_MAX_ROUNDS: "20"
    }
  });

  assert.equal(config.limits.maxToolRounds, 24);
  assert.equal(config.agents.maxRounds, 20);
});

test("loads default hooks config", async () => {
  const config = await loadConfig({ cwd: await makeTempWorkspace(), env: {} });

  assert.equal(config.limits.maxToolRounds, null);
  assert.equal(config.hooks.enabled, true);
  assert.equal(config.hooks.disableAll, false);
  assert.equal(config.hooks.managedOnly, false);
  assert.equal(config.hooks.defaultTimeoutMs, 30000);
  assert.equal(config.hooks.maxOutputBytes, 12000);
  assert.deepEqual(config.hooks.events, {});
});

test("loads model choices from environment", async () => {
  const cwd = await makeTempWorkspace();
  const config = await loadConfig({
    cwd,
    env: {
      LAB_AGENT_MODEL: "local-b",
      LAB_AGENT_MODELS: "local-a,local-b-thinking"
    }
  });

  assert.equal(config.modelAlias, "local-b");
  assert.deepEqual(config.models.map((model) => model.id), ["local-a", "local-b-thinking"]);
  assert.equal(config.models[1].thinking, true);
  assert.equal(config.models[1].contextTokens, null);
  assert.equal(config.configSources.modelAlias.type, "environment");
  assert.equal(config.configSources.models.type, "environment");
});

test("project model and gateway config override environment defaults but keep env key fallback", async () => {
  const cwd = await makeTempWorkspace();
  await writeJson(cwd, {
    modelAlias: "project-model",
    models: [
      { id: "project-model", label: "Project Model", modalities: ["text"], contextTokens: 128000 }
    ],
    lab: {
      gatewayUrl: "https://project.gateway.example/v1/chat/completions",
      gatewayProtocol: "openai-chat"
    }
  });

  const config = await loadConfig({
    cwd,
    env: {
      LAB_AGENT_MODEL: "env-model",
      LAB_AGENT_MODELS: "env-model",
      LAB_MODEL_GATEWAY_URL: "https://env.gateway.example/v1/chat/completions",
      LAB_MODEL_GATEWAY_PROTOCOL: "lab-agent-gateway",
      LAB_MODEL_GATEWAY_API_KEY: "env-key"
    }
  });

  assert.equal(config.modelAlias, "project-model");
  assert.deepEqual(config.models.map((model) => model.id), ["project-model"]);
  assert.equal(config.lab.gatewayUrl, "https://project.gateway.example/v1/chat/completions");
  assert.equal(config.lab.gatewayProtocol, "openai-chat");
  assert.equal(config.lab.gatewayApiKey, "env-key");
  assert.equal(config.configSources.modelAlias.type, "project");
  assert.equal(config.configSources.models.type, "project");
  assert.equal(config.configSources.lab.gatewayUrl.type, "project");
  assert.equal(config.configSources.lab.gatewayProtocol.type, "project");
  assert.equal(config.configSources.lab.gatewayApiKey.type, "environment");
});

test("loads model context windows from project config", async () => {
  const cwd = await makeTempWorkspace();
  await writeJson(cwd, {
    modelAlias: "local-large",
    models: [
      {
        id: "local-large",
        label: "Local Large",
        contextTokens: 128000
      }
    ]
  });

  const config = await loadConfig({ cwd, env: {} });

  assert.equal(config.modelAlias, "local-large");
  assert.equal(config.models[0].contextTokens, 128000);
});

test("project config sets custom model window and leaves in-flight compaction off", async () => {
  const cwd = await makeTempWorkspace();
  await writeJson(cwd, {
    modelAlias: "external-v1",
    models: [
      {
        id: "external-v1",
        label: "External Test Model",
        description: "OpenAI-compatible model used for config tests.",
        thinking: false,
        reasoningContentMode: "visible-when-no-content",
        contextTokens: 400000
      }
    ],
    allowedHosts: [
      "gateway.lab.example",
      "duckduckgo.com",
      "github.com",
      "raw.githubusercontent.com",
      "r.jina.ai"
    ],
    networkMode: "approved-web",
    lab: {
      gatewayUrl: "https://gateway.lab.example/v1/chat/completions",
      gatewayProtocol: "openai-chat"
    },
    context: {
      maxMessages: 100000,
      maxBytes: 2000000,
      maxTokens: 400000,
      keepRecentMessages: 8,
      tailTurns: 2,
      preserveRecentTokens: 8000,
      summaryBytes: 65536,
      resumeMaxMessages: 100000,
      resumeMaxTokens: 400000,
      resumeMaxBytes: 2000000,
      inFlightCompactRatio: null,
      inFlightKeepRecentTools: null
    },
    agents: {
      maxRounds: null,
      orchestration: {
        maxParallelReadonlyAgentRuns: 2
      },
      modelTiers: {
        cheap: "external-v1",
        default: "external-v1",
        strong: "external-v1"
      },
      budgets: {
        defaults: {
          maxOutputBytes: 320000
        },
        "readonly-researcher": {
          maxOutputBytes: 320000
        },
        "web-researcher": {
          maxPermissionDenials: 6,
          maxConsecutiveFailures: 6
        },
        "junior.deep": {
          maxDurationMs: 2700000
        }
      }
    }
  });

  const config = await loadConfig({ cwd, env: {} });

  assert.equal(config.context.maxTokens, 400000);
  assert.equal(config.context.maxBytes, 2000000);
  assert.equal(config.context.promptCompactRatio, undefined);
  assert.equal(config.context.tailTurns, 2);
  assert.equal(config.context.preserveRecentTokens, 8000);
  assert.equal(config.context.inFlightCompactRatio, null);
  assert.equal(config.context.inFlightKeepRecentTools, null);
  assert.deepEqual(config.models.map((model) => [model.id, model.contextTokens]), [
    ["external-v1", 400000]
  ]);
  assert.equal(config.agents.modelTiers.cheap, "external-v1");
  assert.equal(config.agents.modelTiers.default, "external-v1");
  assert.equal(config.agents.modelTiers.strong, "external-v1");
  assert.equal(config.agents.modelTiers.vision, "example-vision-model");
  assert.equal(config.agents.maxRounds, null);
  assert.equal(config.agents.orchestration.maxParallelReadonlyAgentRuns, 2);
  assert.ok(config.allowedHosts.includes("gateway.lab.example"));
  assert.ok(config.allowedHosts.includes("duckduckgo.com"));
  assert.ok(config.allowedHosts.includes("github.com"));
  assert.ok(config.allowedHosts.includes("raw.githubusercontent.com"));
  assert.ok(config.allowedHosts.includes("r.jina.ai"));
  assert.ok(config.mcp.servers.some((server) => server.name === "filesystem" && server.enabled === false));
  assert.ok(config.mcp.servers.some((server) => server.name === "playwright" && server.enabled === false));
  assert.equal(config.networkMode, "approved-web");
  assert.equal(config.lab.gatewayUrl, "https://gateway.lab.example/v1/chat/completions");
  assert.equal(config.lab.gatewayProtocol, "openai-chat");
  assert.equal(config.lab.gatewayApiKey, null);
  assert.equal(config.agents.budgets.defaults.maxToolCalls, undefined);
  assert.equal(config.agents.budgets.defaults.maxOutputBytes, 320000);
  assert.equal(config.agents.budgets["readonly-researcher"].maxOutputBytes, 320000);
  assert.equal(config.agents.budgets["web-researcher"].maxPermissionDenials, 6);
  assert.equal(config.agents.budgets["web-researcher"].maxConsecutiveFailures, 6);
  assert.equal(config.agents.budgets["junior.deep"].maxRounds, undefined);
  assert.equal(config.agents.delegationGuard.enabled, true);
  assert.equal(config.agents.delegationGuard.mode, "remind");
  assert.equal(config.agents.delegationGuard.softThreshold, 3);
  assert.equal(config.agents.delegationGuard.strongThreshold, 5);
  assert.equal(config.agents.backgroundWakeup.enabled, true);
  assert.equal(config.agents.backgroundWakeup.defaultForModelAgentRun, false);
  assert.equal(config.agents.backgroundWakeup.defaultWaitFor, "all");
  assert.equal(config.agents.reviewGate.enabled, true);
  assert.equal(config.agents.reviewGate.mode, "remind");
});

test("loads bundled config when no project or lab config is present", async () => {
  const cwd = await makeTempWorkspace();
  const config = await loadConfig({ cwd, env: {} });

  assert.equal(config.projectConfigPath, null);
  assert.match(config.bundledConfigPath, /lab-agent\.config\.json$/);
  assert.equal(config.modelAlias, "example-coding-model");
  assert.equal(config.context.maxTokens, 200000);
  assert.equal(config.context.maxBytes, 800000);
  assert.equal(config.context.summaryBytes, 65536);
  assert.equal(config.context.promptCompactRatio, undefined);
  assert.deepEqual(config.models.map((model) => [model.id, model.reasoningContentMode]), [
    ["example-coding-model", "visible-when-no-content"],
    ["example-vision-model", "visible-when-no-content"]
  ]);
  assert.deepEqual(config.models.map((model) => [model.id, model.thinking, model.openaiExtraBody?.thinking?.type]), [
    ["example-coding-model", false, undefined],
    ["example-vision-model", false, undefined]
  ]);
  assert.deepEqual(config.models.map((model) => [model.id, model.contextTokens]), [
    ["example-coding-model", 200000],
    ["example-vision-model", 200000]
  ]);
  assert.deepEqual(config.models.map((model) => [model.id, model.modalities]), [
    ["example-coding-model", ["text"]],
    ["example-vision-model", ["text", "image"]]
  ]);
  assert.deepEqual(config.models.map((model) => [model.id, model.agentModelTiers]), [
    ["example-coding-model", undefined],
    ["example-vision-model", undefined]
  ]);
  assert.equal(config.agents.modelTiers.vision, "example-vision-model");
  assert.equal(config.agents.budgets.defaults.maxToolCalls, undefined);
  assert.equal(config.agents.budgets.defaults.maxOutputBytes, 320000);
  assert.equal(config.agents.orchestration.maxParallelReadonlyAgentRuns, 3);
  assert.equal(config.agents.delegationGuard.enabled, true);
  assert.equal(config.agents.backgroundWakeup.enabled, true);
  assert.equal(config.agents.reviewGate.enabled, true);
  assert.deepEqual(config.agents.vision, {
    enabled: false,
    model: "example-vision-model",
    autoUseWhenMainModelTextOnly: true
  });
});

test("project config overlays bundled example defaults without resetting model window", async () => {
  const cwd = await makeTempWorkspace();
  await fs.mkdir(path.join(cwd, ".lab-agent"), { recursive: true });
  await fs.writeFile(path.join(cwd, ".lab-agent", "config.json"), JSON.stringify({
    lab: {
      gatewayApiKey: "test-key"
    }
  }), "utf8");

  const config = await loadConfig({ cwd, env: {} });

  assert.equal(path.basename(config.projectConfigPath), "config.json");
  assert.equal(path.basename(path.dirname(config.projectConfigPath)), ".lab-agent");
  assert.match(config.bundledConfigPath, /lab-agent\.config\.json$/);
  assert.equal(config.modelAlias, "example-coding-model");
  assert.equal(config.context.maxTokens, 200000);
  assert.equal(config.context.promptCompactRatio, undefined);
  assert.equal(config.context.maxBytes, 800000);
  assert.deepEqual(config.models.map((model) => [model.id, model.contextTokens]), [
    ["example-coding-model", 200000],
    ["example-vision-model", 200000]
  ]);
  assert.equal(config.lab.gatewayApiKey, "test-key");
});

test("local project config overlays root project config", async () => {
  const cwd = await makeTempWorkspace();
  await writeJson(cwd, {
    modelAlias: "shared-code",
    models: [
      { id: "shared-code", label: "Shared Code", modalities: ["text"], contextTokens: 200000 }
    ],
    allowedHosts: ["shared.gateway.example"],
    lab: {
      gatewayUrl: "https://shared.gateway.example/v1/chat/completions",
      gatewayProtocol: "openai-chat"
    }
  });
  await fs.mkdir(path.join(cwd, ".lab-agent"), { recursive: true });
  await fs.writeFile(path.join(cwd, ".lab-agent", "config.json"), JSON.stringify({
    modelAlias: "local-vision",
    models: [
      { id: "local-vision", label: "Local Vision", modalities: ["text", "image"], contextTokens: 128000 }
    ],
    allowedHosts: ["local.gateway.example"],
    lab: {
      gatewayUrl: "https://local.gateway.example/v1/chat/completions",
      gatewayApiKey: "local-key"
    }
  }), "utf8");

  const config = await loadConfig({ cwd, env: {} });

  assert.equal(path.basename(config.projectConfigPath), "config.json");
  assert.equal(config.projectConfigPaths.length, 2);
  assert.equal(config.modelAlias, "local-vision");
  assert.equal(config.lab.gatewayUrl, "https://local.gateway.example/v1/chat/completions");
  assert.equal(config.lab.gatewayProtocol, "openai-chat");
  assert.equal(config.lab.gatewayApiKey, "local-key");
  assert.deepEqual(config.models.map((model) => [model.id, model.modalities]), [
    ["local-vision", ["text", "image"]]
  ]);
  assert.ok(config.allowedHosts.includes("local.gateway.example"));
});

test("rejects invalid prompt compact ratio", async () => {
  const cwd = await makeTempWorkspace();
  await writeJson(cwd, {
    context: {
      promptCompactRatio: 1.2
    }
  });

  await assert.rejects(
    loadConfig({ cwd, env: {} }),
    /context\.promptCompactRatio/
  );
});

test("rejects invalid background wakeup config", async () => {
  const cwd = await makeTempWorkspace();
  await writeJson(cwd, {
    agents: {
      backgroundWakeup: {
        enabled: true,
        defaultWaitFor: "forever"
      }
    }
  });

  await assert.rejects(
    loadConfig({ cwd, env: {} }),
    /backgroundWakeup\.defaultWaitFor/
  );
});

test("rejects invalid review gate config", async () => {
  const cwd = await makeTempWorkspace();
  await writeJson(cwd, {
    agents: {
      reviewGate: {
        enabled: true,
        mode: "hard-stop"
      }
    }
  });

  await assert.rejects(
    loadConfig({ cwd, env: {} }),
    /reviewGate\.mode/
  );
});

test("rejects invalid delegation guard config", async () => {
  const cwd = await makeTempWorkspace();
  await writeJson(cwd, {
    agents: {
      delegationGuard: {
        enabled: true,
        mode: "remind",
        softThreshold: 5,
        strongThreshold: 5
      }
    }
  });

  await assert.rejects(
    loadConfig({ cwd, env: {} }),
    /strongThreshold must be greater than softThreshold/
  );
});

test("allows null agent maxRounds so profile budgets can apply", async () => {
  const cwd = await makeTempWorkspace();
  await writeJson(cwd, {
    agents: { maxRounds: null }
  });

  const config = await loadConfig({ cwd, env: {} });

  assert.equal(config.agents.maxRounds, null);
});

test("high sensitivity mode forces zero-retention metadata policy", async () => {
  const config = await loadConfig({
    cwd: process.cwd(),
    env: {
      LAB_AGENT_SENSITIVITY: "high",
      LAB_AGENT_TRANSCRIPT_RETENTION_DAYS: "30",
      LAB_AGENT_NETWORK_MODE: "lab-only"
    }
  });

  assert.equal(config.security.sensitivity, "high");
  assert.equal(config.transcript.enabled, false);
  assert.equal(config.transcript.retentionDays, 0);
});

test("high sensitivity mode rejects broad network modes", async () => {
  await assert.rejects(
    loadConfig({
      cwd: process.cwd(),
      env: {
        LAB_AGENT_SENSITIVITY: "high",
        LAB_AGENT_NETWORK_MODE: "open-dev"
      }
    }),
    /High-sensitivity mode requires networkMode offline or lab-only/
  );
});

test("rejects unsupported transcript encryption modes", async () => {
  await assert.rejects(
    loadConfig({
      cwd: process.cwd(),
      env: { LAB_AGENT_TRANSCRIPT_ENCRYPTION: "surprise" }
    }),
    /Unsupported LAB_AGENT_TRANSCRIPT_ENCRYPTION/
  );
});

test("rejects unsupported gateway protocol modes", async () => {
  await assert.rejects(
    loadConfig({
      cwd: process.cwd(),
      env: { LAB_MODEL_GATEWAY_PROTOCOL: "provider-magic" }
    }),
    /Unsupported LAB_MODEL_GATEWAY_PROTOCOL/
  );
});

test("rejects unsupported gateway retry budgets", async () => {
  await assert.rejects(
    loadConfig({
      cwd: process.cwd(),
      env: { LAB_MODEL_GATEWAY_MAX_RETRIES: "6" }
    }),
    /Unsupported lab\.gatewayMaxRetries/
  );

  const cwd = await makeTempWorkspace();
  await writeJson(cwd, {
    lab: { gatewayMaxRetries: -1 }
  });

  await assert.rejects(
    loadConfig({ cwd, env: {} }),
    /Unsupported lab\.gatewayMaxRetries/
  );
});

test("rejects unsupported transcript retention values from config", async () => {
  const cwd = await makeTempWorkspace();
  await writeJson(cwd, {
    transcript: { retentionDays: -1 }
  });

  await assert.rejects(
    loadConfig({ cwd, env: {} }),
    /Unsupported transcript\.retentionDays/
  );
});

test("rejects unsupported context budget values from config", async () => {
  const cwd = await makeTempWorkspace();
  await writeJson(cwd, {
    context: {
      maxMessages: 4,
      keepRecentMessages: 8
    }
  });

  await assert.rejects(
    loadConfig({ cwd, env: {} }),
    /context\.keepRecentMessages/
  );
});

test("rejects unsupported main tool round budget from config", async () => {
  const cwd = await makeTempWorkspace();
  await writeJson(cwd, {
    limits: { maxToolRounds: 0 }
  });

  await assert.rejects(
    loadConfig({ cwd, env: {} }),
    /limits\.maxToolRounds/
  );
});

test("rejects unsupported agent tool round budget from config", async () => {
  const cwd = await makeTempWorkspace();
  await writeJson(cwd, {
    agents: { maxRounds: -1 }
  });

  await assert.rejects(
    loadConfig({ cwd, env: {} }),
    /agents\.maxRounds/
  );
});

test("rejects unsupported readonly agent parallel budget from config", async () => {
  const cwd = await makeTempWorkspace();
  await writeJson(cwd, {
    agents: {
      orchestration: {
        maxParallelReadonlyAgentRuns: 0
      }
    }
  });

  await assert.rejects(
    loadConfig({ cwd, env: {} }),
    /agents\.orchestration\.maxParallelReadonlyAgentRuns/
  );
});

test("rejects invalid hook config", async () => {
  const cwd = await makeTempWorkspace();
  await writeJson(cwd, {
    hooks: {
      events: {
        "file.changed": [
          {
            name: "bad-blocking",
            type: "command",
            command: "npm test",
            blocking: true
          }
        ]
      }
    }
  });

  await assert.rejects(
    loadConfig({ cwd, env: {} }),
    /Unsupported blocking hook/
  );
});

async function makeTempWorkspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
}

/**
 * @param {string} cwd
 * @param {Record<string, any>} value
 */
async function writeJson(cwd, value) {
  await fs.writeFile(path.join(cwd, "lab-agent.config.json"), JSON.stringify(value), "utf8");
}
