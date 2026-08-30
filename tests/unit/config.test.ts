import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { globalConfigPath, loadConfig } from "../../src/config/load-config.ts";

test("defaults an unconfigured model gateway to OpenAI Chat Completions", async () => {
  const cwd = await makeTempWorkspace();
  const config = await loadConfig({ cwd, env: { USERPROFILE: cwd } });

  assert.equal(config.lab.gatewayUrl, null);
  assert.equal(config.lab.gatewayProtocol, "openai-chat");
});

test("normalizes /v1 gateway bases to each protocol inference route", async (t) => {
  const cases = [
    { protocol: "openai-chat", route: "/v1/chat/completions" },
    { protocol: "openai-responses", route: "/v1/responses" },
    { protocol: "anthropic-messages", route: "/v1/messages" }
  ];

  for (const { protocol, route } of cases) {
    await t.test(protocol, async () => {
      const cwd = await makeTempWorkspace();
      const modelAlias = `${protocol}-model`;
      await writeJson(cwd, {
        modelAlias,
        models: [{ id: modelAlias }],
        lab: {
          gatewayUrl: "https://gateway.lab.example/v1",
          gatewayProtocol: protocol
        }
      });

      const config = await loadConfig({ cwd, env: { USERPROFILE: cwd } });
      const activeProfile = config.lab.gatewayProfiles.find((profile) => (
        profile.id === config.lab.activeGatewayProfile
      ));

      assert.equal(config.lab.gatewayUrl, `https://gateway.lab.example${route}`);
      assert.equal(activeProfile?.gatewayUrl, `https://gateway.lab.example${route}`);

      const envCwd = await makeTempWorkspace();
      const environmentConfig = await loadConfig({
        cwd: envCwd,
        env: {
          USERPROFILE: envCwd,
          LAB_AGENT_MODEL: modelAlias,
          LAB_MODEL_GATEWAY_URL: "https://environment.gateway.example/v1",
          LAB_MODEL_GATEWAY_PROTOCOL: protocol
        }
      });
      const environmentProfile = environmentConfig.lab.gatewayProfiles.find((profile) => (
        profile.id === environmentConfig.lab.activeGatewayProfile
      ));
      assert.equal(environmentConfig.lab.gatewayUrl, `https://environment.gateway.example${route}`);
      assert.equal(environmentProfile?.gatewayUrl, `https://environment.gateway.example${route}`);
    });
  }
});

test("preserves explicit custom inference paths while normalizing gateway identity", async () => {
  const cwd = await makeTempWorkspace();
  await writeJson(cwd, {
    modelAlias: "custom-model",
    models: [{ id: "custom-model" }],
    lab: {
      gatewayUrl: "https://gateway.lab.example/v1/custom-chat",
      gatewayProtocol: "openai-chat"
    }
  });

  const config = await loadConfig({ cwd, env: { USERPROFILE: cwd } });

  assert.equal(config.lab.gatewayUrl, "https://gateway.lab.example/v1/custom-chat");
  assert.equal(config.lab.gatewayProfiles[0].gatewayUrl, "https://gateway.lab.example/v1/custom-chat");
});

test("preserves gateway query parameters and canonicalizes trailing-slash profile ids", async () => {
  const first = await makeTempWorkspace();
  const second = await makeTempWorkspace();
  await writeJson(first, {
    modelAlias: "query-model",
    models: [{ id: "query-model" }],
    lab: {
      gatewayUrl: "https://gateway.lab.example/v1?tenant=alpha",
      gatewayProtocol: "openai-responses"
    }
  });
  await writeJson(second, {
    modelAlias: "query-model",
    models: [{ id: "query-model" }],
    lab: {
      gatewayUrl: "https://gateway.lab.example/v1/responses/?tenant=alpha",
      gatewayProtocol: "openai-responses"
    }
  });

  const firstConfig = await loadConfig({ cwd: first, env: { USERPROFILE: first } });
  const secondConfig = await loadConfig({ cwd: second, env: { USERPROFILE: second } });

  assert.equal(firstConfig.lab.gatewayUrl, "https://gateway.lab.example/v1/responses?tenant=alpha");
  assert.equal(secondConfig.lab.gatewayUrl, "https://gateway.lab.example/v1/responses?tenant=alpha");
  assert.equal(firstConfig.lab.activeGatewayProfile, secondConfig.lab.activeGatewayProfile);
});

test("rebinds a dangling active selector to the matching endpoint profile", async () => {
  const cwd = await makeTempWorkspace();
  const gatewayUrl = "https://gateway.lab.example/v1/responses";
  await writeJson(cwd, {
    lab: {
      gatewayUrl,
      gatewayProtocol: "openai-responses",
      activeGatewayProfile: "missing-profile",
      gatewayProfiles: [{
        id: "valid-profile",
        gatewayUrl,
        gatewayProtocol: "openai-responses",
        modelAlias: "stored-model",
        models: [{ id: "stored-model", reasoningEfforts: ["high", "max"] }]
      }]
    }
  });

  const config = await loadConfig({ cwd, env: { USERPROFILE: cwd } });

  assert.equal(config.lab.activeGatewayProfile, "valid-profile");
  assert.equal(config.modelAlias, "stored-model");
  assert.deepEqual(config.models.map((model) => model.id), ["stored-model"]);
  assert.deepEqual(config.lab.gatewayProfiles[0].models.map((model) => model.id), ["stored-model"]);
});

test("rejects one configuration layer reusing a profile id for different endpoints", async () => {
  const cwd = await makeTempWorkspace();
  await writeJson(cwd, {
    lab: {
      gatewayProfiles: [
        {
          id: "conflicting-profile",
          gatewayUrl: "https://first.gateway.example/v1/chat/completions",
          gatewayProtocol: "openai-chat"
        },
        {
          id: "conflicting-profile",
          gatewayUrl: "https://second.gateway.example/v1/responses",
          gatewayProtocol: "openai-responses"
        }
      ]
    }
  });

  await assert.rejects(
    loadConfig({ cwd, env: { USERPROFILE: cwd } }),
    /Conflicting lab\.gatewayProfiles id/
  );
});

test("rejects duplicate model ids within one configuration layer", async () => {
  const cwd = await makeTempWorkspace();
  await writeJson(cwd, {
    models: [{ id: "duplicate-model" }, { id: "duplicate-model" }],
    lab: {
      gatewayProfiles: [{
        id: "duplicate-model-profile",
        gatewayUrl: "https://duplicate.gateway.example/v1/responses",
        gatewayProtocol: "openai-responses",
        models: [{ id: "duplicate-model" }]
      }]
    }
  });

  await assert.rejects(
    loadConfig({ cwd, env: { USERPROFILE: cwd } }),
    /Duplicate models id: duplicate-model/
  );
});

test("rejects duplicate model ids inside one gateway profile", async () => {
  const cwd = await makeTempWorkspace();
  await writeJson(cwd, {
    lab: {
      gatewayProfiles: [{
        id: "duplicate-profile-models",
        gatewayUrl: "https://duplicate.gateway.example/v1/responses",
        gatewayProtocol: "openai-responses",
        models: [{ id: "duplicate-model" }, { id: "duplicate-model" }]
      }]
    }
  });

  await assert.rejects(
    loadConfig({ cwd, env: { USERPROFILE: cwd } }),
    /Duplicate lab\.gatewayProfiles\[duplicate-profile-models\]\.models id: duplicate-model/
  );
});

test("rejects duplicate gateway profile ids even when their endpoints match", async () => {
  const cwd = await makeTempWorkspace();
  const profile = {
    id: "duplicate-profile",
    gatewayUrl: "https://duplicate.gateway.example/v1/responses",
    gatewayProtocol: "openai-responses",
    models: [{ id: "duplicate-model" }]
  };
  await writeJson(cwd, {
    lab: {
      gatewayProfiles: [profile, { ...profile }]
    }
  });

  await assert.rejects(
    loadConfig({ cwd, env: { USERPROFILE: cwd } }),
    /Duplicate lab\.gatewayProfiles id: duplicate-profile/
  );
});

test("keeps a legacy project gateway distinct from an inherited active selector", async () => {
  const cwd = await makeTempWorkspace();
  const home = await makeTempWorkspace();
  const globalPath = globalConfigPath({ USERPROFILE: home });
  const globalUrl = "https://global.gateway.example/v1/responses";
  const projectUrl = "https://project.gateway.example/v1/chat/completions";
  await fs.mkdir(path.dirname(globalPath), { recursive: true });
  await fs.writeFile(globalPath, JSON.stringify({
    modelAlias: "global-model",
    models: [{ id: "global-model" }],
    lab: {
      gatewayUrl: globalUrl,
      gatewayProtocol: "openai-responses",
      activeGatewayProfile: "global-profile",
      gatewayProfiles: [{
        id: "global-profile",
        gatewayUrl: globalUrl,
        gatewayProtocol: "openai-responses",
        modelAlias: "global-model",
        models: [{ id: "global-model" }]
      }]
    }
  }), "utf8");
  await writeJson(cwd, {
    modelAlias: "legacy-project-model",
    models: [{ id: "legacy-project-model" }],
    lab: {
      gatewayUrl: projectUrl,
      gatewayProtocol: "openai-chat",
      activeGatewayProfile: "global-profile"
    }
  });

  const config = await loadConfig({ cwd, env: { USERPROFILE: home } });
  const legacyProfile = config.lab.gatewayProfiles.find((profile) => profile.gatewayUrl === projectUrl);

  assert.equal(config.lab.activeGatewayProfile, "global-profile");
  assert.equal(config.modelAlias, "global-model");
  assert.ok(legacyProfile);
  assert.notEqual(legacyProfile.id, "global-profile");
  assert.deepEqual(legacyProfile.models.map((model) => model.id), ["legacy-project-model"]);
  assert.equal(
    config.configSources.lab.gatewayProfiles.find((source) => source.id === "global-profile")?.type,
    "global"
  );
});

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
      gatewayIdleTimeoutMs: 30000,
      gatewayMaxResponseBytes: 4194304
    }
  });

  const fromProject = await loadConfig({ cwd, env: {} });
  assert.equal(fromProject.lab.gatewayMaxRetries, 1);
  assert.equal(fromProject.lab.gatewayTimeoutMs, 120000);
  assert.equal(fromProject.lab.gatewayIdleTimeoutMs, 30000);
  assert.equal(fromProject.lab.gatewayMaxResponseBytes, 4194304);

  const fromEnv = await loadConfig({
    cwd,
    env: {
      LAB_MODEL_GATEWAY_MAX_RETRIES: "3",
      LAB_MODEL_GATEWAY_TIMEOUT_MS: "45000",
      LAB_MODEL_GATEWAY_IDLE_TIMEOUT_MS: "15000",
      LAB_MODEL_GATEWAY_MAX_RESPONSE_BYTES: "8388608"
    }
  });
  assert.equal(fromEnv.lab.gatewayMaxRetries, 3);
  assert.equal(fromEnv.lab.gatewayTimeoutMs, 45000);
  assert.equal(fromEnv.lab.gatewayIdleTimeoutMs, 15000);
  assert.equal(fromEnv.lab.gatewayMaxResponseBytes, 8388608);
});

test("loads transcript policy from environment", async () => {
  const cwd = await makeTempWorkspace();
  const config = await loadConfig({
    cwd,
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

test("loads permanent transcript retention from config and environment", async () => {
  const configuredCwd = await makeTempWorkspace();
  await writeJson(configuredCwd, { transcript: { retentionDays: null } });
  const configured = await loadConfig({ cwd: configuredCwd, env: {} });
  assert.equal(configured.transcript.retentionDays, null);

  const environmentCwd = await makeTempWorkspace();
  const environment = await loadConfig({
    cwd: environmentCwd,
    env: { LAB_AGENT_TRANSCRIPT_RETENTION_DAYS: "forever" }
  });
  assert.equal(environment.transcript.retentionDays, null);
});

test("loads context budget from environment", async () => {
  const cwd = await makeTempWorkspace();
  const config = await loadConfig({
    cwd,
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
  const cwd = await makeTempWorkspace();
  const config = await loadConfig({
    cwd,
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

test("project gateway endpoint changes do not inherit an environment key", async () => {
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
  assert.equal(config.lab.gatewayApiKey, null);
  assert.equal(config.configSources.modelAlias.type, "project");
  assert.equal(config.configSources.models.type, "project");
  assert.equal(config.configSources.lab.gatewayUrl.type, "project");
  assert.equal(config.configSources.lab.gatewayProtocol.type, "project");
  assert.equal(config.configSources.lab.gatewayApiKey.type, "project");
});

test("project gateways do not inherit an environment key without an environment URL", async () => {
  const cwd = await makeTempWorkspace();
  await writeJson(cwd, {
    modelAlias: "buddy-model",
    models: [{ id: "buddy-model" }],
    lab: {
      gatewayUrl: "https://buddy.example/v1/chat/completions",
      gatewayProtocol: "openai-chat"
    }
  });

  const config = await loadConfig({
    cwd,
    env: { LAB_MODEL_GATEWAY_API_KEY: "unscoped-env-key" }
  });

  assert.equal(config.lab.gatewayUrl, "https://buddy.example/v1/chat/completions");
  assert.equal(config.lab.gatewayApiKey, null);
  assert.equal(config.configSources.lab.gatewayApiKey.type, "project");
});

test("project settings may inherit an environment key for the same gateway endpoint", async () => {
  const cwd = await makeTempWorkspace();
  await writeJson(cwd, {
    modelAlias: "project-model",
    models: [{ id: "project-model" }],
    lab: {
      gatewayUrl: "https://shared.gateway.example/v1/chat/completions",
      gatewayProtocol: "openai-chat"
    }
  });

  const config = await loadConfig({
    cwd,
    env: {
      LAB_MODEL_GATEWAY_URL: "https://shared.gateway.example/v1/chat/completions",
      LAB_MODEL_GATEWAY_PROTOCOL: "openai-chat",
      LAB_MODEL_GATEWAY_API_KEY: "env-key"
    }
  });

  assert.equal(config.lab.gatewayApiKey, "env-key");
  assert.equal(config.configSources.lab.gatewayApiKey.type, "environment");
});

test("project and global models merge only for the same gateway endpoint", async () => {
  const cwd = await makeTempWorkspace();
  const home = await makeTempWorkspace();
  const globalPath = globalConfigPath({ USERPROFILE: home });
  const gatewayUrl = "https://shared.gateway.example/v1/chat/completions";
  await fs.mkdir(path.dirname(globalPath), { recursive: true });
  await fs.writeFile(globalPath, JSON.stringify({
    modelAlias: "deepseek-v4-pro",
    models: [
      { id: "deepseek-v4-flash", label: "Global Flash" },
      { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" }
    ],
    lab: {
      gatewayUrl,
      gatewayProtocol: "openai-chat",
      gatewayProfiles: [{
        id: "global-shared",
        gatewayUrl,
        gatewayProtocol: "openai-chat",
        modelAlias: "deepseek-v4-pro",
        models: [
          { id: "deepseek-v4-flash", label: "Global Flash" },
          { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" }
        ]
      }]
    }
  }), "utf8");
  await writeJson(cwd, {
    modelAlias: "deepseek-v4-flash",
    models: [{ id: "deepseek-v4-flash", label: "Project Flash" }],
    lab: {
      gatewayUrl,
      gatewayProtocol: "openai-chat",
      gatewayProfiles: [{
        id: "project-shared",
        gatewayUrl,
        gatewayProtocol: "openai-chat",
        modelAlias: "deepseek-v4-flash",
        models: [{ id: "deepseek-v4-flash", label: "Project Flash" }]
      }]
    }
  });

  const config = await loadConfig({ cwd, env: { USERPROFILE: home } });

  assert.equal(config.modelAlias, "deepseek-v4-flash");
  assert.deepEqual(config.models.map((model) => model.id), ["deepseek-v4-flash", "deepseek-v4-pro"]);
  assert.equal(config.models[0].label, "Project Flash");
  assert.deepEqual(config.lab.gatewayProfiles[0].models.map((model) => model.id), [
    "deepseek-v4-flash",
    "deepseek-v4-pro"
  ]);
  assert.equal(
    config.configSources.lab.gatewayProfiles.find((source) => source.id === config.lab.gatewayProfiles[0].id)?.type,
    "project"
  );
});

test("loads dashboard global model defaults from user config file", async () => {
  const cwd = await makeTempWorkspace();
  const home = await makeTempWorkspace();
  const globalPath = globalConfigPath({ USERPROFILE: home });
  await fs.mkdir(path.dirname(globalPath), { recursive: true });
  await fs.writeFile(globalPath, JSON.stringify({
    modelAlias: "global-model",
    models: [
      { id: "global-model", label: "Global Model", modalities: ["text"], contextTokens: 400000 }
    ],
    lab: {
      gatewayUrl: "https://global.gateway.example/v1/chat/completions",
      gatewayProtocol: "openai-chat",
      gatewayApiKey: "global-key"
    }
  }), "utf8");

  const config = await loadConfig({ cwd, env: { USERPROFILE: home } });

  assert.equal(config.globalConfigPath, globalPath);
  assert.equal(config.modelAlias, "global-model");
  assert.deepEqual(config.models.map((model) => model.id), ["global-model"]);
  assert.equal(config.lab.gatewayUrl, "https://global.gateway.example/v1/chat/completions");
  assert.equal(config.lab.gatewayApiKey, "global-key");
  assert.equal(config.configSources.modelAlias.type, "global");
  assert.equal(config.configSources.lab.gatewayUrl.type, "global");
  assert.equal(config.configSources.lab.gatewayProfiles.length, 1);
  assert.equal(config.configSources.lab.gatewayProfiles[0].type, "global");
});

test("same-endpoint project null credentials inherit the saved global key", async () => {
  const cwd = await makeTempWorkspace();
  const home = await makeTempWorkspace();
  const gatewayUrl = "https://shared.gateway.example/v1/chat/completions";
  const globalPath = globalConfigPath({ USERPROFILE: home });
  await fs.mkdir(path.dirname(globalPath), { recursive: true });
  await fs.writeFile(globalPath, JSON.stringify({
    modelAlias: "global-model",
    models: [{ id: "global-model" }],
    lab: {
      gatewayUrl,
      gatewayProtocol: "openai-chat",
      gatewayApiKey: "global-key",
      gatewayProfiles: [{
        id: "shared-profile",
        gatewayUrl,
        gatewayProtocol: "openai-chat",
        gatewayApiKey: "global-key",
        modelAlias: "global-model",
        models: [{ id: "global-model" }]
      }]
    }
  }), "utf8");
  await writeJson(cwd, {
    modelAlias: "project-model",
    models: [{ id: "project-model" }],
    lab: {
      gatewayUrl,
      gatewayProtocol: "openai-chat",
      gatewayApiKey: null,
      activeGatewayProfile: "shared-profile",
      gatewayProfiles: [{
        id: "shared-profile",
        gatewayUrl,
        gatewayProtocol: "openai-chat",
        gatewayApiKey: null,
        modelAlias: "project-model",
        models: [{ id: "project-model" }]
      }]
    }
  });

  const config = await loadConfig({ cwd, env: { USERPROFILE: home } });

  assert.equal(config.lab.gatewayApiKey, "global-key");
  assert.equal(config.lab.gatewayProfiles[0].gatewayApiKey, "global-key");
  assert.equal(config.configSources.lab.gatewayApiKey.type, "global");
});

test("same-endpoint profiles inherit global credentials without model arrays", async () => {
  const cwd = await makeTempWorkspace();
  const home = await makeTempWorkspace();
  const gatewayUrl = "https://shared.gateway.example/v1/chat/completions";
  const globalPath = globalConfigPath({ USERPROFILE: home });
  await fs.mkdir(path.dirname(globalPath), { recursive: true });
  await fs.writeFile(globalPath, JSON.stringify({
    modelAlias: "shared-model",
    models: [{ id: "shared-model" }],
    lab: {
      gatewayUrl,
      gatewayProtocol: "openai-chat",
      gatewayApiKey: "global-key",
      gatewayProfiles: [{ id: "shared-profile", gatewayUrl, gatewayProtocol: "openai-chat", gatewayApiKey: "global-key" }]
    }
  }), "utf8");
  await writeJson(cwd, {
    modelAlias: "shared-model",
    models: [{ id: "shared-model" }],
    lab: {
      gatewayUrl,
      gatewayProtocol: "openai-chat",
      gatewayApiKey: null,
      gatewayProfiles: [{ id: "shared-profile", gatewayUrl, gatewayProtocol: "openai-chat", gatewayApiKey: null }]
    }
  });

  const config = await loadConfig({ cwd, env: { USERPROFILE: home } });

  assert.equal(config.lab.gatewayProfiles[0].gatewayApiKey, "global-key");
});

test("active gateway profile credentials feed the runtime client", async () => {
  const cwd = await makeTempWorkspace();
  const gatewayUrl = "https://grok.gateway.example/v1/responses";
  await writeJson(cwd, {
    modelAlias: "grok-4.6",
    models: [{
      id: "grok-4.6",
      reasoningEfforts: ["low", "medium", "high"],
      defaultReasoningEffort: "high"
    }],
    lab: {
      gatewayUrl,
      gatewayProtocol: "openai-responses",
      gatewayApiKey: null,
      activeGatewayProfile: "grok",
      gatewayProfiles: [{
        id: "grok",
        gatewayUrl: `${gatewayUrl}/`,
        gatewayProtocol: "openai-responses",
        gatewayApiKey: "profile-key",
        modelAlias: "grok-4.6",
        models: [{ id: "grok-4.6", reasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "high" }]
      }]
    }
  });

  const config = await loadConfig({ cwd, env: {} });

  assert.equal(config.lab.gatewayProtocol, "openai-responses");
  assert.equal(config.lab.gatewayApiKey, "profile-key");
  assert.equal(config.models[0].defaultReasoningEffort, "high");
});

test("explicit empty project gateway profiles override inherited global profiles", async () => {
  const cwd = await makeTempWorkspace();
  const home = await makeTempWorkspace();
  const globalPath = globalConfigPath({ USERPROFILE: home });
  await fs.mkdir(path.dirname(globalPath), { recursive: true });
  await fs.writeFile(globalPath, JSON.stringify({
    modelAlias: "global-model",
    models: [{ id: "global-model" }],
    lab: {
      gatewayUrl: "https://global.gateway.example/v1/chat/completions",
      gatewayProtocol: "openai-chat",
      activeGatewayProfile: "global-profile",
      gatewayProfiles: [{
        id: "global-profile",
        gatewayUrl: "https://global.gateway.example/v1/chat/completions",
        gatewayProtocol: "openai-chat",
        modelAlias: "global-model",
        models: [{ id: "global-model" }]
      }]
    }
  }), "utf8");
  await writeJson(cwd, { lab: { gatewayProfiles: [] } });

  const config = await loadConfig({ cwd, env: { USERPROFILE: home } });

  assert.deepEqual(config.lab.gatewayProfiles, []);
});

test("project endpoint changes clear inherited credential tombstones and realign the active profile", async () => {
  const cwd = await makeTempWorkspace();
  const home = await makeTempWorkspace();
  const globalPath = globalConfigPath({ USERPROFILE: home });
  await fs.mkdir(path.dirname(globalPath), { recursive: true });
  await fs.writeFile(globalPath, JSON.stringify({
    modelAlias: "global-model",
    models: [{ id: "global-model" }],
    lab: {
      gatewayUrl: "https://global.gateway.example/v1/chat/completions",
      gatewayProtocol: "openai-chat",
      gatewayApiKey: null,
      gatewayApiKeyDisabled: true,
      activeGatewayProfile: "global-profile",
      gatewayProfiles: [{
        id: "global-profile",
        gatewayUrl: "https://global.gateway.example/v1/chat/completions",
        gatewayProtocol: "openai-chat",
        gatewayApiKey: null,
        gatewayApiKeyDisabled: true,
        modelAlias: "global-model",
        models: [{ id: "global-model" }]
      }]
    }
  }), "utf8");
  await writeJson(cwd, {
    modelAlias: "project-model",
    models: [{ id: "project-model" }],
    lab: {
      gatewayUrl: "https://project.gateway.example/v1/responses",
      gatewayProtocol: "openai-responses",
      gatewayApiKey: "project-key"
    }
  });

  const config = await loadConfig({ cwd, env: { USERPROFILE: home } });
  const active = config.lab.gatewayProfiles.find((profile) => profile.id === config.lab.activeGatewayProfile);

  assert.equal(config.lab.gatewayApiKey, "project-key");
  assert.equal(config.lab.gatewayApiKeyDisabled, false);
  assert.equal(active.gatewayUrl, "https://project.gateway.example/v1/responses");
  assert.equal(active.gatewayProtocol, "openai-responses");
  assert.equal(active.modelAlias, "project-model");
  assert.ok(config.lab.gatewayProfiles.some((profile) => profile.id === "global-profile"));
});

test("model gateway environment defaults become active while retaining saved global profiles", async () => {
  const cwd = await makeTempWorkspace();
  const home = await makeTempWorkspace();
  const globalPath = globalConfigPath({ USERPROFILE: home });
  await fs.mkdir(path.dirname(globalPath), { recursive: true });
  await fs.writeFile(globalPath, JSON.stringify({
    modelAlias: "old-global",
    models: [
      { id: "old-global", label: "Old Global", modalities: ["text"], contextTokens: 200000 }
    ],
    lab: {
      gatewayUrl: "https://old.gateway.example/v1/chat/completions",
      gatewayProtocol: "openai-chat",
      gatewayProfiles: [
        {
          id: "gw-old",
          label: "old",
          gatewayUrl: "https://old.gateway.example/v1/chat/completions",
          gatewayProtocol: "openai-chat",
          modelAlias: "old-global",
          models: [{ id: "old-global", label: "Old Global", modalities: ["text"] }]
        },
        {
          id: "gw-stale",
          label: "stale",
          gatewayUrl: "https://stale.gateway.example/v1/chat/completions",
          gatewayProtocol: "openai-chat",
          modelAlias: "stale-global",
          models: [{ id: "stale-global", label: "Stale Global", modalities: ["text"] }]
        }
      ]
    }
  }), "utf8");

  const config = await loadConfig({
    cwd,
    env: {
      USERPROFILE: home,
      LAB_AGENT_MODEL: "env-mimo",
      LAB_MODEL_GATEWAY_URL: "http://localhost:8080/v1/chat/completions",
      LAB_MODEL_GATEWAY_PROTOCOL: "openai-chat",
      LAB_MODEL_GATEWAY_API_KEY: "env-key"
    }
  });

  assert.equal(config.modelAlias, "env-mimo");
  assert.deepEqual(config.models.map((model) => model.id), ["env-mimo"]);
  assert.equal(config.lab.gatewayUrl, "http://localhost:8080/v1/chat/completions");
  assert.equal(config.lab.gatewayProtocol, "openai-chat");
  assert.equal(config.lab.gatewayApiKey, "env-key");
  assert.equal(config.lab.gatewayProfiles.length, 3);
  assert.ok(config.lab.gatewayProfiles.some((profile) => profile.id === "gw-old"));
  assert.ok(config.lab.gatewayProfiles.some((profile) => profile.id === "gw-stale"));
  const active = config.lab.gatewayProfiles.find((profile) => profile.id === config.lab.activeGatewayProfile);
  assert.equal(active.label, "localhost");
  assert.equal(active.modelAlias, "env-mimo");
  assert.deepEqual(active.models.map((model) => model.id), ["env-mimo"]);
  assert.equal(config.configSources.modelAlias.type, "environment");
  assert.equal(config.configSources.lab.gatewayUrl.type, "environment");
  assert.equal(
    config.configSources.lab.gatewayProfiles.find((source) => source.id === active.id)?.type,
    "environment"
  );
});

test("template project model config does not override global defaults", async () => {
  const cwd = await makeTempWorkspace();
  const home = await makeTempWorkspace();
  const globalPath = globalConfigPath({ USERPROFILE: home });
  await fs.mkdir(path.dirname(globalPath), { recursive: true });
  await fs.writeFile(globalPath, JSON.stringify({
    modelAlias: "real-global-model",
    models: [
      { id: "real-global-model", label: "Real Global Model", modalities: ["text"], contextTokens: 300000 }
    ],
    lab: {
      gatewayUrl: "https://real.gateway.example/v1/chat/completions",
      gatewayProtocol: "openai-chat",
      gatewayApiKey: "real-key"
    }
  }), "utf8");
  await writeJson(cwd, {
    template: true,
    modelAlias: "claude-sonnet-4-5-20250929",
    models: [
      { id: "claude-sonnet-4-5-20250929", label: "Template Model", contextTokens: 200000 }
    ],
    allowedHosts: ["gateway.lab.example", "project.example"],
    lab: {
      gatewayUrl: "https://gateway.lab.example/v1/chat",
      gatewayHealthUrl: "https://gateway.lab.example/health",
      gatewayProtocol: "lab-agent-gateway"
    },
    context: {
      maxMessages: 100000,
      maxBytes: 1600000,
      maxTokens: 400000,
      keepRecentMessages: 8,
      tailTurns: 2,
      preserveRecentTokens: 8000,
      summaryBytes: 65536
    }
  });

  const config = await loadConfig({ cwd, env: { USERPROFILE: home } });

  assert.equal(config.modelAlias, "real-global-model");
  assert.deepEqual(config.models.map((model) => model.id), ["real-global-model"]);
  assert.equal(config.lab.gatewayUrl, "https://real.gateway.example/v1/chat/completions");
  assert.equal(config.lab.gatewayProtocol, "openai-chat");
  assert.equal(config.lab.gatewayApiKey, "real-key");
  assert.equal(config.context.maxTokens, 400000);
  assert.equal(config.configSources.modelAlias.type, "global");
  assert.equal(config.configSources.lab.gatewayUrl.type, "global");
  assert.ok(config.allowedHosts.includes("project.example"));
  assert.equal(config.allowedHosts.includes("gateway.lab.example"), false);
});

test("placeholder project model fields do not override global defaults", async () => {
  const cwd = await makeTempWorkspace();
  const home = await makeTempWorkspace();
  const globalPath = globalConfigPath({ USERPROFILE: home });
  await fs.mkdir(path.dirname(globalPath), { recursive: true });
  await fs.writeFile(globalPath, JSON.stringify({
    modelAlias: "global-real",
    models: [
      { id: "global-real", label: "Global Real", modalities: ["text"], contextTokens: 200000 }
    ],
    lab: {
      gatewayUrl: "https://global-real.example/v1/chat/completions",
      gatewayProtocol: "openai-chat"
    }
  }), "utf8");
  await writeJson(cwd, {
    modelAlias: "<model-id>",
    models: [
      { id: "<model-id>", label: "Placeholder" }
    ],
    lab: {
      gatewayUrl: "https://gateway.example.invalid/v1/chat",
      gatewayProtocol: "lab-agent-gateway"
    },
    agents: {
      delegationGuard: {
        enabled: true,
        mode: "remind",
        softThreshold: 2,
        strongThreshold: 4
      }
    }
  });

  const config = await loadConfig({ cwd, env: { USERPROFILE: home } });

  assert.equal(config.modelAlias, "global-real");
  assert.deepEqual(config.models.map((model) => model.id), ["global-real"]);
  assert.equal(config.lab.gatewayUrl, "https://global-real.example/v1/chat/completions");
  assert.equal(config.lab.gatewayProtocol, "openai-chat");
  assert.equal(config.agents.delegationGuard.softThreshold, 2);
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
  assert.equal(config.agents.modelTiers.vision, undefined);
  assert.equal(config.agents.maxRounds, null);
  assert.equal(config.agents.orchestration.maxParallelReadonlyAgentRuns, 2);
  assert.ok(config.allowedHosts.includes("gateway.lab.example"));
  assert.ok(config.allowedHosts.includes("duckduckgo.com"));
  assert.ok(config.allowedHosts.includes("github.com"));
  assert.ok(config.allowedHosts.includes("raw.githubusercontent.com"));
  assert.ok(config.allowedHosts.includes("r.jina.ai"));
  assert.ok(config.mcp.servers.some((server) => server.name === "github" && server.args.includes("package:scripts/github-mcp-server.ts")));
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
  assert.equal(config.agents.goal.maxAutoContinues, 12);
});

test("loads bundled config when no project or lab config is present", async () => {
  const cwd = await makeTempWorkspace();
  const config = await loadConfig({ cwd, env: {} });

  assert.equal(config.projectConfigPath, null);
  assert.match(config.bundledConfigPath, /lab-agent\.config\.json$/);
  assert.equal(config.modelAlias, "");
  assert.equal(config.context.maxTokens, 400000);
  assert.equal(config.context.summaryBytes, 65536);
  assert.equal(config.context.promptCompactRatio, undefined);
  assert.deepEqual(config.models, []);
  assert.deepEqual(config.agents.modelTiers, {});
  assert.equal(config.agents.budgets.defaults.maxToolCalls, undefined);
  assert.equal(config.agents.budgets.defaults.maxOutputBytes, 320000);
  assert.equal(config.agents.orchestration.maxParallelReadonlyAgentRuns, 2);
  assert.equal(config.agents.delegationGuard.enabled, true);
  assert.equal(config.agents.backgroundWakeup.enabled, true);
  assert.equal(config.agents.reviewGate.enabled, true);
  assert.equal(config.agents.goal.maxAutoContinues, 12);
  assert.equal(config.lab.gatewayUrl, null);
  assert.equal(config.lab.gatewayHealthUrl, null);
  assert.equal(config.allowedHosts.includes("gateway.example.com"), false);
  assert.deepEqual(config.agents.vision, {
    enabled: true,
    model: null,
    autoUseWhenMainModelTextOnly: true
  });
});

test("environment model selection does not expose the bundled example catalog", async () => {
  const cwd = await makeTempWorkspace();
  const config = await loadConfig({ cwd, env: { LAB_AGENT_MODEL: "external-model-alias" } });

  assert.equal(config.modelAlias, "external-model-alias");
  assert.deepEqual(config.models.map((model) => model.id), ["external-model-alias"]);
  assert.equal(config.lab.gatewayUrl, null);
});

test("explicit empty project model list remains empty instead of restoring bundled examples", async () => {
  const cwd = await makeTempWorkspace();
  await fs.mkdir(path.join(cwd, ".lab-agent"), { recursive: true });
  await fs.writeFile(path.join(cwd, ".lab-agent", "config.json"), JSON.stringify({
    modelAlias: "",
    models: [],
    lab: {
      gatewayApiKey: "test-key"
    }
  }), "utf8");

  const config = await loadConfig({ cwd, env: {} });

  assert.equal(path.basename(config.projectConfigPath), "config.json");
  assert.equal(path.basename(path.dirname(config.projectConfigPath)), ".lab-agent");
  assert.match(config.bundledConfigPath, /lab-agent\.config\.json$/);
  assert.equal(config.modelAlias, "");
  assert.equal(config.context.maxTokens, 400000);
  assert.equal(config.context.promptCompactRatio, undefined);
  assert.equal(config.context.maxBytes, 2000000);
  assert.deepEqual(config.models, []);
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

test("normalizes configured allowed hosts for exact network policy matching", async () => {
  const cwd = await makeTempWorkspace();
  await writeJson(cwd, {
    allowedHosts: [" API.Example.COM. ", "api.example.com", "127.0.0.1"]
  });

  const config = await loadConfig({ cwd, env: {} });

  assert.deepEqual(config.allowedHosts, ["api.example.com", "127.0.0.1"]);
});

test("rejects malformed network, host, and transcript settings from config", async () => {
  for (const [config, pattern] of [
    [{ networkMode: "internet" }, /networkMode/],
    [{ allowedHosts: ["https:\/\/example.com"] }, /allowedHosts entry/],
    [{ allowedHosts: "example.com" }, /allowedHosts: expected an array/],
    [{ transcript: { enabled: "yes" } }, /transcript\.enabled/]
  ]) {
    const cwd = await makeTempWorkspace();
    await writeJson(cwd, config);
    await assert.rejects(loadConfig({ cwd, env: {} }), pattern);
  }
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
  const cwd = await makeTempWorkspace();
  const config = await loadConfig({
    cwd,
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
  const cwd = await makeTempWorkspace();
  await assert.rejects(
    loadConfig({
      cwd,
      env: {
        LAB_AGENT_SENSITIVITY: "high",
        LAB_AGENT_NETWORK_MODE: "open-dev"
      }
    }),
    /High-sensitivity mode requires networkMode offline or lab-only/
  );
});

test("rejects unsupported transcript encryption modes", async () => {
  const cwd = await makeTempWorkspace();
  await assert.rejects(
    loadConfig({
      cwd,
      env: { LAB_AGENT_TRANSCRIPT_ENCRYPTION: "surprise" }
    }),
    /Unsupported LAB_AGENT_TRANSCRIPT_ENCRYPTION/
  );
});

test("rejects unsupported gateway protocol modes", async () => {
  const cwd = await makeTempWorkspace();
  await assert.rejects(
    loadConfig({
      cwd,
      env: { LAB_MODEL_GATEWAY_PROTOCOL: "provider-magic" }
    }),
    /Unsupported LAB_MODEL_GATEWAY_PROTOCOL/
  );
});

test("rejects unsupported gateway retry budgets", async () => {
  const cwd = await makeTempWorkspace();
  await assert.rejects(
    loadConfig({
      cwd,
      env: { LAB_MODEL_GATEWAY_MAX_RETRIES: "6" }
    }),
    /Unsupported lab\.gatewayMaxRetries/
  );
  await writeJson(cwd, {
    lab: { gatewayMaxRetries: -1 }
  });

  await assert.rejects(
    loadConfig({ cwd, env: {} }),
    /Unsupported lab\.gatewayMaxRetries/
  );
});

test("rejects unsupported transcript retention values from config", async () => {
  for (const retentionDays of [-1, 1.5, 3651]) {
    const cwd = await makeTempWorkspace();
    await writeJson(cwd, {
      transcript: { retentionDays }
    });

    await assert.rejects(
      loadConfig({ cwd, env: {} }),
      /Unsupported transcript\.retentionDays/
    );
  }
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

test("rejects unsupported goal auto-continue cap from config", async () => {
  const cwd = await makeTempWorkspace();
  await writeJson(cwd, {
    agents: {
      goal: {
        maxAutoContinues: 0
      }
    }
  });

  await assert.rejects(
    loadConfig({ cwd, env: {} }),
    /agents\.goal\.maxAutoContinues/
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
async function writeJson(cwd: string, value: Record<string, unknown>) {
  await fs.writeFile(path.join(cwd, "lab-agent.config.json"), JSON.stringify(value), "utf8");
}
