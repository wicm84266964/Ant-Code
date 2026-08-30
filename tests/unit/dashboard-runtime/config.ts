import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAgentTaskGroupStore } from "../../../src/agents/task-group-store.ts";
import { createAgentTaskStore } from "../../../src/agents/task-store.ts";
import { registerBackgroundTerminalTask } from "../../../src/agents/background-terminal-registry.ts";
import { createFileRepository } from "../../../src/config-v2/file-repository.ts";
import { createCredentialStore } from "../../../src/credentials/store.ts";
import { withConfigMutationLock } from "../../../src/dashboard/config-store.ts";
import { createDashboardRuntime } from "../../../src/dashboard/sessions.ts";
import { createSessionStore } from "../../../src/storage/session-store.ts";

import {
  waitForEvent,
  waitForCondition,
  cleanupAbortError,
  transcriptText,
  requestMessageText,
  createGateway,
  readDashboardRequestJson,
  createRecordingGateway,
  createHeaderRecordingGateway,
  createSequenceGateway,
  createAuthRecordingGateway,
  createOpenAIChatAuthRecordingGateway,
  createDelayedGateway,
  createFailingGateway,
  createRepeatedReadGateway,
  createHangingStreamGateway,
  createBackgroundWakeGateway,
  createQueueFullBackgroundWakeGateway,
  deferred,
  createBackgroundAnyWakeGateway,
  createToolGateway,
  createWriteGateway,
  createRepeatedEditGateway,
  createTodoGateway,
  createHangingGateway,
  createQuestionGateway,
  listen,
  close,
  mockGatewayEnv,
  assertGlobalSavePreservesProjectProjection
} from "./helpers.ts";

test("dashboard global model saves do not regress capabilities from a stale project profile override", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-global-capability-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-home-global-capability-"));
  const globalPath = path.join(home, ".ant-code", "lab-agent.config.json");
  const localPath = path.join(cwd, ".lab-agent", "config.json");
  const gatewayUrl = "https://shared-capability.gateway.example/v1/responses";
  const profileId = "shared-capability-profile";
  const staleModel = {
    id: "deepseek-reasoner",
    label: "Stale project copy",
    reasoningEfforts: ["low", "high"],
    defaultReasoningEffort: "high"
  };

  await fs.mkdir(path.dirname(globalPath), { recursive: true });
  await fs.writeFile(globalPath, JSON.stringify({
    modelAlias: staleModel.id,
    models: [staleModel],
    lab: {
      gatewayUrl,
      gatewayProtocol: "openai-responses",
      activeGatewayProfile: profileId,
      gatewayProfiles: [{
        id: profileId,
        gatewayUrl,
        gatewayProtocol: "openai-responses",
        modelAlias: staleModel.id,
        models: [staleModel]
      }]
    }
  }), "utf8");
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, JSON.stringify({
    modelAlias: staleModel.id,
    models: [staleModel],
    lab: {
      gatewayUrl,
      gatewayProtocol: "openai-responses",
      activeGatewayProfile: profileId,
      gatewayProfiles: [{
        id: profileId,
        gatewayUrl,
        gatewayProtocol: "openai-responses",
        modelAlias: staleModel.id,
        models: [staleModel]
      }]
    }
  }), "utf8");

  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: home } });
  const upgraded = await runtime.saveModelConfig({
    saveTarget: "global",
    gatewayUrl,
    gatewayProtocol: "openai-responses",
    modelId: staleModel.id,
    label: "DeepSeek Reasoner Max",
    reasoningEfforts: ["low", "medium", "high", "max"],
    defaultReasoningEffort: "max",
    switchToModel: false
  });
  assert.equal(upgraded.ok, true);

  const added = await runtime.saveModelConfig({
    saveTarget: "global",
    gatewayUrl,
    gatewayProtocol: "openai-responses",
    modelId: "deepseek-chat",
    label: "DeepSeek Chat",
    switchToModel: false
  });
  assert.equal(added.ok, true);

  const global = JSON.parse(await fs.readFile(globalPath, "utf8"));
  const reasoner = global.models.find((model) => model.id === staleModel.id);
  assert.equal(reasoner.label, "DeepSeek Reasoner Max");
  assert.deepEqual(reasoner.reasoningEfforts.map((effort) => effort.id ?? effort), ["low", "medium", "high", "max"]);
  assert.equal(reasoner.defaultReasoningEffort, "max");

  const status = await runtime.status();
  const restarted = await createDashboardRuntime({ cwd, env: { USERPROFILE: home } }).status();
  const capabilitySnapshot = (snapshot) => {
    const model = snapshot.models.find((candidate) => candidate.id === staleModel.id);
    const profile = snapshot.gatewayProfiles.find((candidate) => candidate.gatewayUrl === gatewayUrl);
    const profileModel = profile?.models.find((candidate) => candidate.id === staleModel.id);
    const capability = (candidate) => ({
      label: candidate?.label,
      reasoningEfforts: candidate?.reasoningEfforts?.map((effort) => effort.id ?? effort),
      defaultReasoningEffort: candidate?.defaultReasoningEffort,
      ownerScope: candidate?.source?.ownerScope
    });
    return {
      effectiveModel: capability(model),
      effectiveProfileModel: capability(profileModel)
    };
  };
  const expectedCapability = () => ({
    effectiveModel: {
      label: "DeepSeek Reasoner Max",
      reasoningEfforts: ["low", "medium", "high", "max"],
      defaultReasoningEffort: "max",
      ownerScope: "global"
    },
    effectiveProfileModel: {
      label: "DeepSeek Reasoner Max",
      reasoningEfforts: ["low", "medium", "high", "max"],
      defaultReasoningEffort: "max",
      ownerScope: "global"
    }
  });
  assert.deepEqual({
    afterUpgrade: capabilitySnapshot(upgraded),
    afterAdditionalGlobalSave: capabilitySnapshot(added),
    liveStatus: capabilitySnapshot(status),
    restartedStatus: capabilitySnapshot(restarted)
  }, {
    afterUpgrade: expectedCapability(),
    afterAdditionalGlobalSave: expectedCapability(),
    liveStatus: expectedCapability(),
    restartedStatus: expectedCapability()
  });
});

test("dashboard migrates exact inherited clones from every project config path", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-all-project-configs-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-home-all-project-configs-"));
  const globalPath = path.join(home, ".ant-code", "lab-agent.config.json");
  const projectPaths = [
    path.join(cwd, "lab-agent.config.json"),
    path.join(cwd, ".lab-agent", "config.json")
  ];
  const gatewayUrl = "https://all-project-configs.gateway.example/v1/responses";
  const profileId = "all-project-configs-profile";
  const staleModel = {
    id: "deepseek-reasoner",
    label: "DeepSeek before max",
    reasoningEfforts: ["low", "high"],
    defaultReasoningEffort: "high"
  };
  const profile = {
    id: profileId,
    label: "Custom source label",
    gatewayUrl,
    gatewayProtocol: "openai-responses",
    modelAlias: staleModel.id,
    models: [staleModel]
  };
  const clone = {
    modelAlias: staleModel.id,
    models: [staleModel],
    lab: {
      gatewayUrl,
      gatewayProtocol: "openai-responses",
      activeGatewayProfile: profileId,
      gatewayProfiles: [profile]
    }
  };

  await fs.mkdir(path.dirname(globalPath), { recursive: true });
  await fs.writeFile(globalPath, JSON.stringify(clone), "utf8");
  for (const projectPath of projectPaths) {
    await fs.mkdir(path.dirname(projectPath), { recursive: true });
    await fs.writeFile(projectPath, JSON.stringify(clone), "utf8");
  }

  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: home } });
  const saved = await runtime.saveModelConfig({
    saveTarget: "global",
    gatewayUrl,
    gatewayProtocol: "openai-responses",
    modelId: staleModel.id,
    label: "DeepSeek with max",
    reasoningEfforts: ["low", "high", "max"],
    defaultReasoningEffort: "max",
    switchToModel: false
  });

  assert.equal(saved.ok, true, `${saved.status}: ${saved.error}`);
  for (const projectPath of projectPaths) {
    const project = JSON.parse(await fs.readFile(projectPath, "utf8"));
    assert.equal(project.modelAlias, undefined);
    assert.equal(project.models, undefined);
    assert.equal(project.lab.activeGatewayProfile, profileId);
    assert.equal(project.lab.gatewayProfiles, undefined);
  }
  const restarted = await createDashboardRuntime({ cwd, env: { USERPROFILE: home } }).status();
  const model = restarted.models.find((candidate) => candidate.id === staleModel.id);
  assert.equal(model?.label, "DeepSeek with max");
  assert.deepEqual(model?.reasoningEfforts.map((effort) => effort.id ?? effort), ["low", "high", "max"]);
  assert.equal(model?.defaultReasoningEffort, "max");
  assert.equal(model?.source?.ownerScope, "global");
});

test("dashboard preserves project health and agent overrides while saving a global model", async (t) => {
  const scenarios = [
    {
      name: "health override",
      project: {
        lab: { gatewayHealthUrl: "https://project-health.gateway.example/health" }
      }
    },
    {
      name: "agent routes",
      project: {
        agents: {
          modelTiers: { strong: "project-strong", vision: "project-vision" },
          vision: {
            enabled: true,
            model: "project-vision",
            autoUseWhenMainModelTextOnly: true
          }
        }
      }
    }
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, () => assertGlobalSavePreservesProjectProjection(scenario.project));
  }
});


test("dashboard switching to an inherited global profile does not materialize that profile into project config", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-inherited-switch-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-home-inherited-switch-"));
  const globalPath = path.join(home, ".ant-code", "lab-agent.config.json");
  const localPath = path.join(cwd, ".lab-agent", "config.json");
  const globalProfile = {
    id: "inherited-global-profile",
    gatewayUrl: "https://global-inherited.gateway.example/v1/responses",
    gatewayProtocol: "openai-responses",
    modelAlias: "global-model",
    models: [{ id: "global-model" }]
  };
  const projectProfile = {
    id: "owned-project-profile",
    gatewayUrl: "https://project-owned.gateway.example/v1/chat/completions",
    gatewayProtocol: "openai-chat",
    modelAlias: "project-model",
    models: [{ id: "project-model" }]
  };

  await fs.mkdir(path.dirname(globalPath), { recursive: true });
  await fs.writeFile(globalPath, JSON.stringify({
    modelAlias: globalProfile.modelAlias,
    models: globalProfile.models,
    lab: {
      gatewayUrl: globalProfile.gatewayUrl,
      gatewayProtocol: globalProfile.gatewayProtocol,
      activeGatewayProfile: globalProfile.id,
      gatewayProfiles: [globalProfile]
    }
  }), "utf8");
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, JSON.stringify({
    modelAlias: projectProfile.modelAlias,
    models: projectProfile.models,
    lab: {
      gatewayUrl: projectProfile.gatewayUrl,
      gatewayProtocol: projectProfile.gatewayProtocol,
      activeGatewayProfile: projectProfile.id,
      gatewayProfiles: [projectProfile]
    }
  }), "utf8");

  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: home } });
  const switched = await runtime.switchGatewayProfile({ profileId: globalProfile.id });
  assert.equal(switched.ok, true);
  assert.equal(switched.gatewayConfig.activeProfileId, globalProfile.id);

  const local = JSON.parse(await fs.readFile(localPath, "utf8"));
  assert.equal(local.lab.activeGatewayProfile, globalProfile.id);
  assert.equal(
    local.lab.gatewayProfiles.some((profile) => profile.id === globalProfile.id),
    false,
    "an inherited global profile must remain owned by the global layer"
  );
  assert.deepEqual(local.lab.gatewayProfiles.map((profile) => profile.id), [projectProfile.id]);
});

test("dashboard deleting a project profile override reveals rather than deletes the same-id global profile", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-delete-override-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-home-delete-override-"));
  const globalPath = path.join(home, ".ant-code", "lab-agent.config.json");
  const localPath = path.join(cwd, ".lab-agent", "config.json");
  const profileId = "same-id-profile";
  const gatewayUrl = "https://same-id.gateway.example/v1/responses";
  const globalProfile = {
    id: profileId,
    label: "Global profile",
    gatewayUrl,
    gatewayProtocol: "openai-responses",
    modelAlias: "global-model",
    models: [{ id: "global-model" }]
  };
  const projectProfile = {
    ...globalProfile,
    label: "Project override",
    modelAlias: "project-model",
    models: [{ id: "project-model" }]
  };

  await fs.mkdir(path.dirname(globalPath), { recursive: true });
  await fs.writeFile(globalPath, JSON.stringify({
    modelAlias: globalProfile.modelAlias,
    models: globalProfile.models,
    lab: {
      gatewayUrl,
      gatewayProtocol: "openai-responses",
      activeGatewayProfile: profileId,
      gatewayProfiles: [globalProfile]
    }
  }), "utf8");
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, JSON.stringify({
    modelAlias: projectProfile.modelAlias,
    models: projectProfile.models,
    lab: {
      gatewayUrl,
      gatewayProtocol: "openai-responses",
      activeGatewayProfile: profileId,
      gatewayProfiles: [projectProfile]
    }
  }), "utf8");

  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: home } });
  const initial = await runtime.status();
  assert.equal(initial.gatewayProfiles.find((profile) => profile.id === profileId)?.ownerScope, "project");

  const deleted = await runtime.deleteGatewayProfile({ profileId });
  assert.equal(deleted.ok, true);
  assert.deepEqual(deleted.deletedFromScopes, ["project"]);

  const global = JSON.parse(await fs.readFile(globalPath, "utf8"));
  assert.equal(global.lab.gatewayProfiles.some((profile) => profile.id === profileId), true);
  const refreshed = await runtime.status();
  const revealed = refreshed.gatewayProfiles.find((profile) => profile.id === profileId);
  assert.equal(revealed?.ownerScope, "global");
  assert.equal(revealed?.current, true);
  assert.deepEqual(revealed?.models.map((model) => model.id), ["global-model"]);
});

test("dashboard edits an inactive project profile without switching or mixing agent routes", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-edit-inactive-profile-"));
  const localPath = path.join(cwd, ".lab-agent", "config.json");
  const profileA = {
    id: "project-profile-a",
    gatewayUrl: "https://profile-a.acme.test/v1/responses",
    gatewayProtocol: "openai-responses",
    modelAlias: "a-main",
    models: [
      { id: "a-main", label: "A Main" },
      { id: "a-worker", label: "A Worker" },
      { id: "a-vision", label: "A Vision", modalities: ["text", "image"] }
    ],
    agents: {
      modelTiers: { cheap: "a-worker", default: "a-main", strong: "a-main", vision: "a-vision" },
      vision: { enabled: true, model: "a-vision", autoUseWhenMainModelTextOnly: true }
    }
  };
  const profileB = {
    id: "project-profile-b",
    gatewayUrl: "https://profile-b.acme.test/v1/responses",
    gatewayProtocol: "openai-responses",
    modelAlias: "b-main",
    models: [
      { id: "b-main", label: "B Main" },
      { id: "b-worker", label: "B Worker" },
      { id: "b-vision", label: "B Vision", modalities: ["text", "image"] }
    ],
    agents: {
      modelTiers: { cheap: "b-worker", default: "b-main", strong: "b-main", vision: "b-vision" },
      vision: { enabled: true, model: "b-vision", autoUseWhenMainModelTextOnly: true }
    }
  };

  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, JSON.stringify({
    modelAlias: profileA.modelAlias,
    models: profileA.models,
    agents: profileA.agents,
    lab: {
      gatewayUrl: profileA.gatewayUrl,
      gatewayProtocol: profileA.gatewayProtocol,
      activeGatewayProfile: profileA.id,
      gatewayProfiles: [profileA, profileB]
    }
  }), "utf8");

  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: cwd } });
  const saved = await runtime.saveModelConfig({
    saveTarget: "project",
    profileId: profileB.id,
    gatewayUrl: profileB.gatewayUrl,
    gatewayProtocol: profileB.gatewayProtocol,
    previousModelId: "b-main",
    modelId: "b-main",
    label: "B Main Edited",
    modalities: ["text"],
    switchToModel: false,
    applyAgentDefaults: false
  });

  assert.equal(saved.ok, true);
  assert.equal(saved.gatewayConfig.activeProfileId, profileA.id);
  assert.equal(saved.sessionStatus.model, profileA.modelAlias);

  const local = JSON.parse(await fs.readFile(localPath, "utf8"));
  assert.equal(local.lab.activeGatewayProfile, profileA.id);
  assert.equal(local.modelAlias, profileA.modelAlias);
  assert.deepEqual(local.models.map((model) => model.id), profileA.models.map((model) => model.id));
  assert.deepEqual(local.agents, profileA.agents);
  const storedB = local.lab.gatewayProfiles.find((profile) => profile.id === profileB.id);
  assert.deepEqual(storedB.models.map((model) => model.id), ["b-main", "b-worker", "b-vision"]);
  assert.equal(storedB.models.find((model) => model.id === "b-main")?.label, "B Main Edited");
  assert.deepEqual(storedB.agents, profileB.agents);
  assert.equal(JSON.stringify(storedB).includes("a-main"), false);
  assert.equal(JSON.stringify(storedB).includes("a-vision"), false);

  const restarted = await createDashboardRuntime({ cwd, env: { USERPROFILE: cwd } }).status();
  assert.equal(restarted.gatewayConfig.activeProfileId, profileA.id);
  assert.equal(restarted.sessionStatus.model, profileA.modelAlias);
  assert.deepEqual(
    restarted.gatewayProfiles.find((profile) => profile.id === profileB.id)?.models.map((model) => model.id),
    ["b-main", "b-worker", "b-vision"]
  );
});

test("dashboard deletes a model from its global owner without creating a project shadow", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-delete-global-model-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-home-delete-global-model-"));
  const globalPath = path.join(home, ".ant-code", "lab-agent.config.json");
  const localPath = path.join(cwd, ".lab-agent", "config.json");
  const globalProfile = {
    id: "global-model-profile",
    gatewayUrl: "https://global-models.acme.test/v1/responses",
    gatewayProtocol: "openai-responses",
    modelAlias: "global-main",
    models: [
      { id: "global-main", label: "Global Main" },
      { id: "global-remove", label: "Global Remove" },
      { id: "global-vision", label: "Global Vision", modalities: ["text", "image"] }
    ]
  };

  await fs.mkdir(path.dirname(globalPath), { recursive: true });
  await fs.writeFile(globalPath, JSON.stringify({
    modelAlias: globalProfile.modelAlias,
    models: globalProfile.models,
    lab: {
      gatewayUrl: globalProfile.gatewayUrl,
      gatewayProtocol: globalProfile.gatewayProtocol,
      activeGatewayProfile: globalProfile.id,
      gatewayProfiles: [globalProfile]
    }
  }), "utf8");

  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: home } });
  const deleted = await runtime.deleteModelConfig({
    profileId: globalProfile.id,
    modelId: "global-remove"
  });

  assert.equal(deleted.ok, true);
  assert.equal(deleted.deletedFrom, "global");
  assert.equal(deleted.gatewayConfig.activeProfileId, globalProfile.id);
  assert.deepEqual(deleted.models.map((model) => model.id), ["global-main", "global-vision"]);

  const global = JSON.parse(await fs.readFile(globalPath, "utf8"));
  assert.equal(global.lab.activeGatewayProfile, globalProfile.id);
  assert.deepEqual(global.models.map((model) => model.id), ["global-main", "global-vision"]);
  assert.deepEqual(global.lab.gatewayProfiles[0].models.map((model) => model.id), ["global-main", "global-vision"]);
  await assert.rejects(fs.access(localPath), /ENOENT/);

  const restarted = await createDashboardRuntime({ cwd, env: { USERPROFILE: home } }).status();
  assert.equal(restarted.gatewayConfig.activeProfileId, globalProfile.id);
  assert.deepEqual(restarted.models.map((model) => model.id), ["global-main", "global-vision"]);
});

test("dashboard preserves a legacy project gateway as an owned profile before switching global", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-switch-legacy-project-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-home-switch-legacy-project-"));
  const globalPath = path.join(home, ".ant-code", "lab-agent.config.json");
  const localPath = path.join(cwd, ".lab-agent", "config.json");
  const globalProfile = {
    id: "global-switch-profile",
    gatewayUrl: "https://global-switch.acme.test/v1/responses",
    gatewayProtocol: "openai-responses",
    modelAlias: "global-switch-model",
    models: [{ id: "global-switch-model" }]
  };
  const legacyProjectUrl = "https://legacy-project.acme.test/v1/chat/completions";

  await fs.mkdir(path.dirname(globalPath), { recursive: true });
  await fs.writeFile(globalPath, JSON.stringify({
    modelAlias: globalProfile.modelAlias,
    models: globalProfile.models,
    lab: {
      gatewayUrl: globalProfile.gatewayUrl,
      gatewayProtocol: globalProfile.gatewayProtocol,
      activeGatewayProfile: globalProfile.id,
      gatewayProfiles: [globalProfile]
    }
  }), "utf8");
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, JSON.stringify({
    modelAlias: "legacy-project-main",
    models: [
      { id: "legacy-project-main" },
      { id: "legacy-project-worker" }
    ],
    agents: {
      modelTiers: {
        cheap: "legacy-project-worker",
        default: "legacy-project-main",
        strong: "legacy-project-main"
      }
    },
    lab: {
      gatewayUrl: legacyProjectUrl,
      gatewayProtocol: "openai-chat"
    }
  }), "utf8");

  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: home } });
  const initial = await runtime.status();
  const legacyProfile = initial.gatewayProfiles.find((profile) => profile.gatewayUrl === legacyProjectUrl);
  assert.ok(legacyProfile);
  assert.equal(legacyProfile.ownerScope, "project");

  const switched = await runtime.switchGatewayProfile({ profileId: globalProfile.id });
  assert.equal(switched.ok, true);
  assert.equal(switched.gatewayConfig.activeProfileId, globalProfile.id);

  const local = JSON.parse(await fs.readFile(localPath, "utf8"));
  assert.equal(local.lab.activeGatewayProfile, globalProfile.id);
  assert.equal(local.lab.gatewayProfiles.some((profile) => profile.id === globalProfile.id), false);
  const persistedLegacy = local.lab.gatewayProfiles.find((profile) => profile.id === legacyProfile.id);
  assert.ok(persistedLegacy);
  assert.equal(persistedLegacy.gatewayUrl, legacyProjectUrl);
  assert.deepEqual(persistedLegacy.models.map((model) => model.id), [
    "legacy-project-main",
    "legacy-project-worker"
  ]);

  const restartedRuntime = createDashboardRuntime({ cwd, env: { USERPROFILE: home } });
  const restarted = await restartedRuntime.status();
  assert.equal(restarted.gatewayConfig.activeProfileId, globalProfile.id);
  assert.ok(restarted.gatewayProfiles.some((profile) => profile.id === legacyProfile.id));
  const switchedBack = await restartedRuntime.switchGatewayProfile({ profileId: legacyProfile.id });
  assert.equal(switchedBack.ok, true);
  assert.equal(switchedBack.gatewayConfig.activeProfileId, legacyProfile.id);
  assert.equal(switchedBack.gatewayConfig.gatewayUrl, legacyProjectUrl);
  assert.deepEqual(switchedBack.models.map((model) => model.id), [
    "legacy-project-main",
    "legacy-project-worker"
  ]);
});

test("dashboard deletes a global-owned model through a same-endpoint project profile without shadowing", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-delete-mixed-owner-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-home-delete-mixed-owner-"));
  const globalPath = path.join(home, ".ant-code", "lab-agent.config.json");
  const localPath = path.join(cwd, ".lab-agent", "config.json");
  const gatewayUrl = "https://mixed-owner.gateway.example/v1/responses";
  const globalProfile = {
    id: "global-shared",
    gatewayUrl,
    gatewayProtocol: "openai-responses",
    modelAlias: "global-a",
    models: [
      { id: "global-a", label: "Global A" },
      { id: "global-b", label: "Global B" }
    ]
  };
  const projectProfile = {
    id: "project-shared",
    gatewayUrl,
    gatewayProtocol: "openai-responses",
    modelAlias: "project-a",
    models: [{ id: "project-a", label: "Project A" }]
  };

  await fs.mkdir(path.dirname(globalPath), { recursive: true });
  await fs.writeFile(globalPath, JSON.stringify({
    modelAlias: globalProfile.modelAlias,
    models: globalProfile.models,
    lab: {
      gatewayUrl,
      gatewayProtocol: "openai-responses",
      activeGatewayProfile: globalProfile.id,
      gatewayProfiles: [globalProfile]
    }
  }), "utf8");
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, JSON.stringify({
    modelAlias: projectProfile.modelAlias,
    models: projectProfile.models,
    lab: {
      gatewayUrl,
      gatewayProtocol: "openai-responses",
      activeGatewayProfile: projectProfile.id,
      gatewayProfiles: [projectProfile]
    }
  }), "utf8");

  const projectBefore = await fs.readFile(localPath, "utf8");
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: home } });
  const initial = await runtime.status();
  const effectiveProfile = initial.gatewayProfiles.find((profile) => profile.gatewayUrl === gatewayUrl);
  assert.equal(effectiveProfile?.id, projectProfile.id);
  assert.deepEqual(Object.fromEntries(effectiveProfile.models.map((model) => [model.id, model.source?.ownerScope])), {
    "global-a": "global",
    "global-b": "global",
    "project-a": "project"
  });

  const deleted = await runtime.deleteModelConfig({
    profileId: effectiveProfile.id,
    modelId: "global-b"
  });

  assert.equal(deleted.ok, true, `${deleted.status}: ${deleted.error}`);
  assert.equal(deleted.deletedFrom, "global");
  assert.equal(deleted.configPath, globalPath);
  assert.equal(await fs.readFile(localPath, "utf8"), projectBefore);
  const global = JSON.parse(await fs.readFile(globalPath, "utf8"));
  assert.deepEqual(global.models.map((model) => model.id), ["global-a"]);
  assert.deepEqual(global.lab.gatewayProfiles.find((profile) => profile.id === globalProfile.id).models.map((model) => model.id), ["global-a"]);
  const project = JSON.parse(await fs.readFile(localPath, "utf8"));
  assert.deepEqual(project.models.map((model) => model.id), ["project-a"]);
  assert.deepEqual(project.lab.gatewayProfiles[0].models.map((model) => model.id), ["project-a"]);

  const restarted = await createDashboardRuntime({ cwd, env: { USERPROFILE: home } }).status();
  const restartedProfile = restarted.gatewayProfiles.find((profile) => profile.gatewayUrl === gatewayUrl);
  assert.deepEqual(restartedProfile.models.map((model) => model.id).sort(), ["global-a", "project-a"]);
  assert.equal(restartedProfile.models.find((model) => model.id === "global-a")?.source?.ownerScope, "global");
  assert.equal(restartedProfile.models.find((model) => model.id === "project-a")?.source?.ownerScope, "project");
});

test("dashboard model edits can clear optional capabilities across restart", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-clear-model-options-"));
  const localPath = path.join(cwd, ".lab-agent", "config.json");
  const gatewayUrl = "https://clear-options.gateway.example/v1/chat/completions";
  const profileId = "clear-options-profile";
  const modelId = "optional-model";
  const model = {
    id: modelId,
    label: "Optional Model",
    thinking: true,
    modalities: ["text", "image"],
    contextTokens: 480000,
    reasoningEfforts: ["low", "medium", "high"],
    defaultReasoningEffort: "high",
    agentModelTiers: {
      cheap: "optional-cheap",
      default: "optional-default",
      strong: "optional-strong"
    }
  };
  const agentRoutes = {
    modelTiers: {
      cheap: "optional-cheap",
      default: "optional-default",
      strong: "optional-strong",
      vision: modelId
    },
    vision: { enabled: true, model: modelId, autoUseWhenMainModelTextOnly: true }
  };

  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, JSON.stringify({
    modelAlias: modelId,
    models: [model],
    agents: agentRoutes,
    lab: {
      gatewayUrl,
      gatewayProtocol: "openai-chat",
      activeGatewayProfile: profileId,
      gatewayProfiles: [{
        id: profileId,
        gatewayUrl,
        gatewayProtocol: "openai-chat",
        modelAlias: modelId,
        models: [model],
        agents: agentRoutes
      }]
    }
  }), "utf8");

  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: cwd } });
  const saved = await runtime.saveModelConfig({
    saveTarget: "project",
    profileId,
    gatewayUrl,
    gatewayProtocol: "openai-chat",
    previousModelId: modelId,
    modelId,
    label: "Optional Model",
    contextTokens: "",
    reasoningEfforts: [],
    defaultReasoningEffort: null,
    agentCheapModel: "",
    agentDefaultModel: "",
    agentStrongModel: "",
    visionAgentModel: "",
    modalities: ["text"],
    thinking: false,
    applyAgentDefaults: true,
    switchToModel: true
  });

  assert.equal(saved.ok, true);
  const savedModel = saved.models.find((candidate) => candidate.id === modelId);
  assert.equal(savedModel.contextTokens, null);
  assert.deepEqual(savedModel.reasoningEfforts, []);
  assert.equal(savedModel.defaultReasoningEffort, null);
  assert.deepEqual(savedModel.agentModelTiers, {});
  assert.equal(savedModel.thinking, false);
  assert.deepEqual(savedModel.modalities, ["text"]);
  assert.deepEqual(saved.agentModelTiers, {});
  assert.equal(saved.visionAgent.enabled, false);
  assert.equal(saved.visionAgent.model, "");

  const local = JSON.parse(await fs.readFile(localPath, "utf8"));
  const persistedModels = [
    local.models.find((candidate) => candidate.id === modelId),
    local.lab.gatewayProfiles.find((profile) => profile.id === profileId).models.find((candidate) => candidate.id === modelId)
  ];
  for (const persistedModel of persistedModels) {
    assert.equal(Object.prototype.hasOwnProperty.call(persistedModel, "contextTokens"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(persistedModel, "reasoningEfforts"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(persistedModel, "defaultReasoningEffort"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(persistedModel, "agentModelTiers"), false);
  }
  assert.equal(Object.prototype.hasOwnProperty.call(local.agents, "modelTiers"), false);
  assert.deepEqual(local.agents.vision, {
    enabled: false,
    model: null,
    autoUseWhenMainModelTextOnly: true
  });
  const persistedAgents = local.lab.gatewayProfiles.find((profile) => profile.id === profileId).agents;
  assert.equal(Object.prototype.hasOwnProperty.call(persistedAgents, "modelTiers"), false);
  assert.deepEqual(persistedAgents.vision, local.agents.vision);

  const restarted = await createDashboardRuntime({ cwd, env: { USERPROFILE: cwd } }).status();
  const restartedModel = restarted.models.find((candidate) => candidate.id === modelId);
  assert.equal(restartedModel.contextTokens, null);
  assert.deepEqual(restartedModel.reasoningEfforts, []);
  assert.equal(restartedModel.defaultReasoningEffort, null);
  assert.deepEqual(restartedModel.agentModelTiers, {});
  assert.equal(restartedModel.thinking, false);
  assert.deepEqual(restartedModel.modalities, ["text"]);
  assert.deepEqual(restarted.agentModelTiers, {});
  assert.equal(restarted.visionAgent.enabled, false);
  assert.equal(restarted.visionAgent.model, "");
});

test("dashboard preserves the largest persisted context budget regardless of model save order", async (t) => {
  const cases = [
    { name: "large then small", order: [["large-model", 480000], ["small-model", 120000]] },
    { name: "small then large", order: [["small-model", 120000], ["large-model", 480000]] }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-context-order-"));
      const localPath = path.join(cwd, ".lab-agent", "config.json");
      const gatewayUrl = `https://${testCase.name.startsWith("large") ? "large-first" : "small-first"}.context.gateway.example/v1/chat/completions`;
      const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: cwd } });
      let profileId = "";

      for (const [modelId, contextTokens] of testCase.order) {
        const saved = await runtime.saveModelConfig({
          saveTarget: "project",
          ...(profileId ? { profileId } : {}),
          gatewayUrl,
          gatewayProtocol: "openai-chat",
          modelId,
          label: modelId,
          contextTokens: String(contextTokens),
          modalities: ["text"],
          switchToModel: true
        });
        assert.equal(saved.ok, true);
        profileId = saved.gatewayConfig.activeProfileId;
      }

      const local = JSON.parse(await fs.readFile(localPath, "utf8"));
      assert.equal(local.context.maxTokens, 480000);
      assert.equal(local.context.maxBytes, 1920000);
      assert.ok(local.context.resumeMaxTokens >= 480000);
      assert.ok(local.context.resumeMaxBytes >= 1920000);
      const profile = local.lab.gatewayProfiles.find((candidate) => candidate.id === profileId);
      assert.deepEqual(Object.fromEntries(profile.models.map((candidate) => [candidate.id, candidate.contextTokens])), {
        "large-model": 480000,
        "small-model": 120000
      });

      const restartedRuntime = createDashboardRuntime({ cwd, env: { USERPROFILE: cwd } });
      const switched = await restartedRuntime.switchModel({ profileId, modelId: "large-model" });
      assert.equal(switched.ok, true);
      assert.equal(switched.sessionStatus.context.maxTokens, 480000);
      assert.equal(switched.sessionStatus.context.modelMaxTokens, 480000);
      const afterRestart = JSON.parse(await fs.readFile(localPath, "utf8"));
      assert.equal(afterRestart.context.maxTokens, 480000);
      assert.equal(afterRestart.context.maxBytes, 1920000);
    });
  }
});

test("dashboard edits a global-owned model through a same-endpoint project profile without shadowing", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-edit-mixed-owner-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-home-edit-mixed-owner-"));
  const globalPath = path.join(home, ".ant-code", "lab-agent.config.json");
  const localPath = path.join(cwd, ".lab-agent", "config.json");
  const gatewayUrl = "https://mixed-edit.gateway.example/v1/responses";
  const globalProfile = {
    id: "global-edit-profile",
    gatewayUrl,
    gatewayProtocol: "openai-responses",
    modelAlias: "global-a",
    models: [
      { id: "global-a", label: "Global A" },
      { id: "global-b", label: "Global B" }
    ]
  };
  const projectProfile = {
    id: "project-edit-profile",
    gatewayUrl,
    gatewayProtocol: "openai-responses",
    modelAlias: "project-a",
    models: [{ id: "project-a", label: "Project A" }]
  };

  await fs.mkdir(path.dirname(globalPath), { recursive: true });
  await fs.writeFile(globalPath, JSON.stringify({
    modelAlias: globalProfile.modelAlias,
    models: globalProfile.models,
    lab: {
      gatewayUrl,
      gatewayProtocol: "openai-responses",
      activeGatewayProfile: globalProfile.id,
      gatewayProfiles: [globalProfile]
    }
  }), "utf8");
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, JSON.stringify({
    modelAlias: projectProfile.modelAlias,
    models: projectProfile.models,
    lab: {
      gatewayUrl,
      gatewayProtocol: "openai-responses",
      activeGatewayProfile: projectProfile.id,
      gatewayProfiles: [projectProfile]
    }
  }), "utf8");

  const projectBefore = await fs.readFile(localPath, "utf8");
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: home } });
  const initial = await runtime.status();
  const effectiveProfile = initial.gatewayProfiles.find((profile) => profile.gatewayUrl === gatewayUrl);
  assert.equal(effectiveProfile?.id, projectProfile.id);
  assert.equal(
    effectiveProfile.models.find((model) => model.id === "global-b")?.source?.ownerScope,
    "global"
  );

  const saved = await runtime.saveModelConfig({
    saveTarget: "global",
    profileId: effectiveProfile.id,
    gatewayUrl,
    gatewayProtocol: "openai-responses",
    previousModelId: "global-b",
    modelId: "global-b",
    label: "Global B Edited",
    modalities: ["text"],
    switchToModel: false
  });

  assert.equal(saved.ok, true, `${saved.status}: ${saved.error}`);
  assert.equal(saved.saveTarget, "global");
  assert.equal(saved.configPath, globalPath);
  assert.equal(saved.gatewayConfig.activeProfileId, projectProfile.id);
  assert.equal(await fs.readFile(localPath, "utf8"), projectBefore);

  const global = JSON.parse(await fs.readFile(globalPath, "utf8"));
  assert.equal(global.models.find((model) => model.id === "global-b")?.label, "Global B Edited");
  const storedGlobalProfile = global.lab.gatewayProfiles.find((profile) => profile.id === globalProfile.id);
  assert.equal(storedGlobalProfile.models.find((model) => model.id === "global-b")?.label, "Global B Edited");
  assert.equal(storedGlobalProfile.models.some((model) => model.id === "project-a"), false);

  const restarted = await createDashboardRuntime({ cwd, env: { USERPROFILE: home } }).status();
  const restartedProfile = restarted.gatewayProfiles.find((profile) => profile.gatewayUrl === gatewayUrl);
  assert.equal(restarted.gatewayConfig.activeProfileId, projectProfile.id);
  assert.equal(restartedProfile.models.find((model) => model.id === "global-b")?.label, "Global B Edited");
  assert.equal(restartedProfile.models.find((model) => model.id === "global-b")?.source?.ownerScope, "global");
  assert.equal(restartedProfile.models.find((model) => model.id === "project-a")?.source?.ownerScope, "project");
});

test("dashboard moves the owning global profile when editing its endpoint through a different effective id", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-move-mixed-owner-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-home-move-mixed-owner-"));
  const globalPath = path.join(home, ".ant-code", "lab-agent.config.json");
  const localPath = path.join(cwd, ".lab-agent", "config.json");
  const oldUrl = "https://mixed-move.gateway.example/v1/responses";
  const newUrl = "https://mixed-move.gateway.example/v2/responses";
  const globalProfile = {
    id: "global-move-profile",
    gatewayUrl: oldUrl,
    gatewayProtocol: "openai-responses",
    gatewayApiKey: "global-move-key",
    modelAlias: "global-a",
    models: [
      { id: "global-a", label: "Global A" },
      { id: "global-b", label: "Global B" }
    ]
  };
  const projectProfile = {
    id: "project-move-profile",
    gatewayUrl: oldUrl,
    gatewayProtocol: "openai-responses",
    modelAlias: "project-a",
    models: [{ id: "project-a", label: "Project A" }]
  };

  await fs.mkdir(path.dirname(globalPath), { recursive: true });
  await fs.writeFile(globalPath, JSON.stringify({
    modelAlias: globalProfile.modelAlias,
    models: globalProfile.models,
    lab: {
      gatewayUrl: oldUrl,
      gatewayProtocol: "openai-responses",
      gatewayApiKey: "global-move-key",
      activeGatewayProfile: globalProfile.id,
      gatewayProfiles: [globalProfile]
    }
  }), "utf8");
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, JSON.stringify({
    modelAlias: projectProfile.modelAlias,
    models: projectProfile.models,
    lab: {
      gatewayUrl: oldUrl,
      gatewayProtocol: "openai-responses",
      activeGatewayProfile: projectProfile.id,
      gatewayProfiles: [projectProfile]
    }
  }), "utf8");

  const projectBefore = await fs.readFile(localPath, "utf8");
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: home } });
  const initial = await runtime.status();
  const effectiveProfile = initial.gatewayProfiles.find((profile) => profile.gatewayUrl === oldUrl);
  assert.equal(effectiveProfile?.id, projectProfile.id);
  assert.equal(effectiveProfile.models.find((model) => model.id === "global-b")?.source?.ownerScope, "global");

  const saved = await runtime.saveModelConfig({
    saveTarget: "global",
    profileId: effectiveProfile.id,
    previousGatewayUrl: oldUrl,
    previousGatewayProtocol: "openai-responses",
    gatewayUrl: newUrl,
    gatewayProtocol: "openai-responses",
    previousModelId: "global-b",
    modelId: "global-b",
    label: "Global B Moved",
    credentialAction: "keep",
    switchToModel: false
  });

  assert.equal(saved.ok, true, `${saved.status}: ${saved.error}`);
  assert.equal(await fs.readFile(localPath, "utf8"), projectBefore);
  const global = JSON.parse(await fs.readFile(globalPath, "utf8"));
  assert.equal(global.lab.gatewayProfiles.length, 1);
  assert.equal(global.lab.gatewayProfiles[0].id, globalProfile.id);
  assert.equal(global.lab.gatewayProfiles[0].gatewayUrl, newUrl);
  assert.equal(global.lab.gatewayProfiles[0].gatewayApiKey, "global-move-key");
  assert.deepEqual(global.lab.gatewayProfiles[0].models.map((model) => model.id), ["global-a", "global-b"]);
  assert.equal(global.lab.gatewayProfiles[0].models.find((model) => model.id === "global-b")?.label, "Global B Moved");
  assert.equal(global.lab.gatewayUrl, newUrl);
  assert.equal(global.lab.gatewayApiKey, "global-move-key");

  const restarted = await createDashboardRuntime({ cwd, env: { USERPROFILE: home } }).status();
  assert.deepEqual(new Set(restarted.gatewayProfiles.map((profile) => profile.id)), new Set([
    projectProfile.id,
    globalProfile.id
  ]));
  assert.equal(restarted.gatewayProfiles.find((profile) => profile.id === globalProfile.id)?.gatewayUrl, newUrl);
});

test("dashboard deleting the final project model reveals a same-endpoint global profile with a different id", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-runtime-delete-final-project-model-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-home-delete-final-project-model-"));
  const globalPath = path.join(home, ".ant-code", "lab-agent.config.json");
  const localPath = path.join(cwd, ".lab-agent", "config.json");
  const gatewayUrl = "https://mixed-final.gateway.example/v1/responses";
  const globalProfile = {
    id: "global-final-profile",
    gatewayUrl,
    gatewayProtocol: "openai-responses",
    modelAlias: "global-only",
    models: [{ id: "global-only", label: "Global Only" }]
  };
  const projectProfile = {
    id: "project-final-profile",
    gatewayUrl,
    gatewayProtocol: "openai-responses",
    modelAlias: "project-only",
    models: [{ id: "project-only", label: "Project Only" }]
  };

  await fs.mkdir(path.dirname(globalPath), { recursive: true });
  await fs.writeFile(globalPath, JSON.stringify({
    modelAlias: globalProfile.modelAlias,
    models: globalProfile.models,
    lab: {
      gatewayUrl,
      gatewayProtocol: "openai-responses",
      activeGatewayProfile: globalProfile.id,
      gatewayProfiles: [globalProfile]
    }
  }), "utf8");
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, JSON.stringify({
    modelAlias: projectProfile.modelAlias,
    models: projectProfile.models,
    lab: {
      gatewayUrl,
      gatewayProtocol: "openai-responses",
      activeGatewayProfile: projectProfile.id,
      gatewayProfiles: [projectProfile]
    }
  }), "utf8");

  const globalBefore = await fs.readFile(globalPath, "utf8");
  const runtime = createDashboardRuntime({ cwd, env: { USERPROFILE: home } });
  const deleted = await runtime.deleteModelConfig({
    profileId: projectProfile.id,
    modelId: projectProfile.modelAlias
  });

  assert.equal(deleted.ok, true, `${deleted.status}: ${deleted.error}`);
  assert.equal(deleted.deletedFrom, "project");
  assert.equal(deleted.restoredInherited, true);
  assert.equal(deleted.clearedGateway, false);
  assert.equal(deleted.gatewayConfig.activeProfileId, globalProfile.id);
  assert.deepEqual(deleted.models.map((model) => model.id), [globalProfile.modelAlias]);
  assert.equal(await fs.readFile(globalPath, "utf8"), globalBefore);

  const local = JSON.parse(await fs.readFile(localPath, "utf8"));
  assert.equal(local.modelAlias, undefined);
  assert.equal(local.models, undefined);
  assert.equal(local.lab.activeGatewayProfile, globalProfile.id);
  assert.equal(Object.prototype.hasOwnProperty.call(local.lab, "gatewayProfiles"), false);
  for (const key of [
    "gatewayUrl",
    "gatewayHealthUrl",
    "gatewayProtocol",
    "gatewayApiKey",
    "gatewayApiKeyDisabled"
  ]) {
    assert.equal(Object.prototype.hasOwnProperty.call(local.lab, key), false);
  }

  const restarted = await createDashboardRuntime({ cwd, env: { USERPROFILE: home } }).status();
  assert.equal(restarted.gatewayConfig.activeProfileId, globalProfile.id);
  assert.deepEqual(restarted.models.map((model) => model.id), [globalProfile.modelAlias]);
  assert.deepEqual(restarted.gatewayProfiles.map((profile) => profile.id), [globalProfile.id]);
  assert.equal(restarted.models[0].source?.ownerScope, "global");
});
