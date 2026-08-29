import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createFileRepository } from "../../src/config-v2/file-repository.js";
import { projectLegacyRuntimeConfig } from "../../src/config-v2/legacy-projection.js";
import { resolveSettingsLayers } from "../../src/config-v2/resolver.js";
import { validateSettingsDocument } from "../../src/config-v2/schema.js";
import { createCredentialStore } from "../../src/credentials/store.js";
import {
  dashboardV2ErrorResult,
  deleteV2Provider,
  deleteV2ProviderModel,
  saveV2DefaultModel,
  saveV2ProviderModel
} from "../../src/dashboard/model-settings-v2.js";
import { withConfigMutationLock } from "../../src/dashboard/config-store.js";

test("Dashboard V2 writes a provider and credential separately with revision CAS", async () => {
  const fixture = await createFixture();
  const saved = await saveV2ProviderModel({
    cwd: fixture.cwd,
    env: fixture.env,
    scope: "global",
    expectedRevision: "missing",
    expectedCredentialsRevision: "missing",
    input: providerInput({ secret: fixture.secret, switchToModel: true })
  });

  assert.equal(saved.ok, true);
  assert.match(saved.providerId, /^provider-/);
  assert.notEqual(saved.revisions.global, "missing");
  assert.notEqual(saved.revisions.credentials, "missing");
  const settingsText = await fs.readFile(path.join(fixture.home, ".ant-code", "settings.json"), "utf8");
  const credentialText = await fs.readFile(path.join(fixture.home, ".ant-code", "credentials.json"), "utf8");
  assert.equal(settingsText.includes(fixture.secret), false);
  assert.equal(credentialText.includes(fixture.secret), true);

  await assert.rejects(
    saveV2ProviderModel({
      cwd: fixture.cwd,
      env: fixture.env,
      scope: "global",
      expectedRevision: "missing",
      expectedCredentialsRevision: saved.revisions.credentials,
      input: providerInput({ providerId: saved.providerId, secret: "replacement" })
    }),
    (error) => dashboardV2ErrorResult(error).status === 409
  );
  assert.equal((await fs.readFile(path.join(fixture.home, ".ant-code", "credentials.json"), "utf8")).includes("replacement"), false);
});

test("Dashboard V2 checks the credentials revision before a settings-only provider commit", async () => {
  const fixture = await createFixture();
  const settingsPath = path.join(fixture.home, ".ant-code", "settings.json");
  const credentialPath = path.join(fixture.home, ".ant-code", "credentials.json");
  await fs.writeFile(settingsPath, `${JSON.stringify(existingProviderSettings(), null, 2)}\n`, "utf8");
  const repository = createFileRepository({ filePath: settingsPath });
  const before = await repository.read();
  await createCredentialStore({ filePath: credentialPath }).set(
    "ANTCODE_CONCURRENT_SETTINGS_ONLY_TEST",
    "concurrent-secret",
    { expectedRevision: "missing" }
  );

  await assert.rejects(
    saveV2ProviderModel({
      cwd: fixture.cwd,
      env: fixture.env,
      scope: "global",
      expectedRevision: before.revision,
      expectedCredentialsRevision: "missing",
      input: existingProviderInput({ label: "Must Not Commit" })
    }),
    (error) => error.code === "CONFIG_REVISION_CONFLICT" && error.status === 409
  );
  assert.equal((await repository.read()).revision, before.revision);
  assert.equal((await fs.readFile(settingsPath, "utf8")).includes("Must Not Commit"), false);
});

test("Dashboard V2 clears a provider credential transactionally when its endpoint changes", async () => {
  const fixture = await createFixture();
  const created = await saveV2ProviderModel({
    cwd: fixture.cwd,
    env: fixture.env,
    scope: "global",
    expectedRevision: "missing",
    expectedCredentialsRevision: "missing",
    input: providerInput({ secret: fixture.secret, switchToModel: true })
  });
  const settingsPath = path.join(fixture.home, ".ant-code", "settings.json");
  const credentialsPath = path.join(fixture.home, ".ant-code", "credentials.json");
  const before = validateSettingsDocument(JSON.parse(await fs.readFile(settingsPath, "utf8")));
  const credentialRef = before.namespaces["model-providers"].providers[created.providerId].auth.ref;
  const input = providerInput({ providerId: created.providerId });
  input.gatewayUrl = "https://replacement.example/v1/responses";
  input.gatewayApiKey = "";
  input.credentialAction = "keep";
  input.catalogModelIds = ["grok-4.6"];

  const changed = await saveV2ProviderModel({
    cwd: fixture.cwd,
    env: fixture.env,
    scope: "global",
    expectedRevision: created.revisions.global,
    expectedCredentialsRevision: created.revisions.credentials,
    input
  });

  assert.equal(changed.credentialConfigured, false);
  const document = validateSettingsDocument(JSON.parse(await fs.readFile(settingsPath, "utf8")));
  const provider = document.namespaces["model-providers"].providers[created.providerId];
  assert.deepEqual(provider.auth, { mode: "none" });
  const credentialDocument = JSON.parse(await fs.readFile(credentialsPath, "utf8"));
  assert.equal(Object.prototype.hasOwnProperty.call(credentialDocument.credentials, credentialRef), false);
  assert.equal(JSON.stringify(credentialDocument).includes(fixture.secret), false);
  const runtime = projectLegacyRuntimeConfig(resolveSettingsLayers({ global: document }));
  assert.equal(runtime.lab.gatewayCredentialMode, "none");
  assert.equal(runtime.lab.gatewayCredentialRef, null);
  assert.equal(runtime.lab.gatewayApiKeyDisabled, true);
});

test("Dashboard V2 endpoint changes detach but preserve a credential shared across scopes", async () => {
  const fixture = await createFixture();
  const shared = await writeSharedCredentialLayers(fixture);
  const input = providerInput({ providerId: shared.globalProviderId });
  input.gatewayUrl = "https://replacement.example/v1/responses";
  input.gatewayApiKey = "";
  input.credentialAction = "keep";
  input.catalogModelIds = ["grok-4.6"];

  const changed = await saveV2ProviderModel({
    cwd: fixture.cwd,
    env: fixture.env,
    scope: "global",
    expectedRevision: shared.globalRevision,
    expectedCredentialsRevision: shared.credentialsRevision,
    input
  });

  assert.equal(changed.credentialConfigured, false);
  assert.equal(changed.revisions.credentials, shared.credentialsRevision);
  const globalDocument = validateSettingsDocument(JSON.parse(await fs.readFile(shared.globalPath, "utf8")));
  const projectDocument = validateSettingsDocument(JSON.parse(await fs.readFile(shared.projectPath, "utf8")));
  assert.deepEqual(
    globalDocument.namespaces["model-providers"].providers[shared.globalProviderId].auth,
    { mode: "none" }
  );
  assert.deepEqual(
    projectDocument.namespaces["model-providers"].providers[shared.projectProviderId].auth,
    { mode: "credential", ref: shared.credentialRef }
  );
  const credentialDocument = JSON.parse(await fs.readFile(shared.credentialsPath, "utf8"));
  assert.equal(credentialDocument.credentials[shared.credentialRef], fixture.secret);
});

test("Dashboard V2 credential replacement forks a reference shared across scopes", async () => {
  const fixture = await createFixture();
  const shared = await writeSharedCredentialLayers(fixture);

  const replaced = await saveV2ProviderModel({
    cwd: fixture.cwd,
    env: fixture.env,
    scope: "global",
    expectedRevision: shared.globalRevision,
    expectedCredentialsRevision: shared.credentialsRevision,
    input: providerInput({
      providerId: shared.globalProviderId,
      secret: "replacement-global-secret"
    })
  });

  assert.equal(replaced.credentialConfigured, true);
  const globalDocument = validateSettingsDocument(JSON.parse(await fs.readFile(shared.globalPath, "utf8")));
  const projectDocument = validateSettingsDocument(JSON.parse(await fs.readFile(shared.projectPath, "utf8")));
  const globalRef = globalDocument.namespaces["model-providers"].providers[shared.globalProviderId].auth.ref;
  assert.notEqual(globalRef, shared.credentialRef);
  assert.equal(
    projectDocument.namespaces["model-providers"].providers[shared.projectProviderId].auth.ref,
    shared.credentialRef
  );
  const credentialDocument = JSON.parse(await fs.readFile(shared.credentialsPath, "utf8"));
  assert.equal(credentialDocument.credentials[shared.credentialRef], fixture.secret);
  assert.equal(credentialDocument.credentials[globalRef], "replacement-global-secret");
});

test("Dashboard V2 model/provider deletion clears a cross-scope credential only after its last reference", async () => {
  const fixture = await createFixture();
  const shared = await writeSharedCredentialLayers(fixture);

  const deletedGlobal = await deleteV2ProviderModel({
    cwd: fixture.cwd,
    env: fixture.env,
    scope: "global",
    expectedRevision: shared.globalRevision,
    expectedCredentialsRevision: shared.credentialsRevision,
    providerId: shared.globalProviderId,
    modelId: "grok-4.6"
  });

  assert.equal(deletedGlobal.deletedProvider, shared.globalProviderId);
  assert.equal(deletedGlobal.revisions.credentials, shared.credentialsRevision);
  let credentialDocument = JSON.parse(await fs.readFile(shared.credentialsPath, "utf8"));
  assert.equal(credentialDocument.credentials[shared.credentialRef], fixture.secret);

  const deletedProject = await deleteV2Provider({
    cwd: fixture.cwd,
    env: fixture.env,
    scope: "project",
    expectedRevision: shared.projectRevision,
    expectedCredentialsRevision: deletedGlobal.revisions.credentials,
    providerId: shared.projectProviderId
  });

  assert.notEqual(deletedProject.revisions.credentials, shared.credentialsRevision);
  credentialDocument = JSON.parse(await fs.readFile(shared.credentialsPath, "utf8"));
  assert.equal(Object.prototype.hasOwnProperty.call(credentialDocument.credentials, shared.credentialRef), false);
});

test("Dashboard V2 credential replacement switches references before garbage-collecting the old secret", async () => {
  const fixture = await createFixture();
  const created = await saveV2ProviderModel({
    cwd: fixture.cwd,
    env: fixture.env,
    scope: "global",
    expectedRevision: "missing",
    expectedCredentialsRevision: "missing",
    input: providerInput({ secret: fixture.secret })
  });
  const settingsPath = path.join(fixture.home, ".ant-code", "settings.json");
  const credentialsPath = path.join(fixture.home, ".ant-code", "credentials.json");
  const before = validateSettingsDocument(JSON.parse(await fs.readFile(settingsPath, "utf8")));
  const oldRef = before.namespaces["model-providers"].providers[created.providerId].auth.ref;

  const replaced = await saveV2ProviderModel({
    cwd: fixture.cwd,
    env: fixture.env,
    scope: "global",
    expectedRevision: created.revisions.global,
    expectedCredentialsRevision: created.revisions.credentials,
    input: providerInput({ providerId: created.providerId, secret: "rotated-secret" })
  });

  const after = validateSettingsDocument(JSON.parse(await fs.readFile(settingsPath, "utf8")));
  const newRef = after.namespaces["model-providers"].providers[created.providerId].auth.ref;
  const credentials = JSON.parse(await fs.readFile(credentialsPath, "utf8")).credentials;
  assert.notEqual(newRef, oldRef);
  assert.equal(credentials[newRef], "rotated-secret");
  assert.equal(Object.prototype.hasOwnProperty.call(credentials, oldRef), false);
  assert.equal(replaced.credentialCleanupPending, undefined);
});

test("Dashboard V2 reports cleanup pending without breaking the committed credential binding", async () => {
  const fixture = await createFixture();
  const created = await createCredentialProvider(fixture);
  const before = await readCredentialFixture(fixture, created.providerId);
  const store = createCredentialStore({
    filePath: path.join(fixture.home, ".ant-code", "credentials.json")
  });
  let injected = false;

  const replaced = await saveV2ProviderModel({
    cwd: fixture.cwd,
    env: fixture.env,
    scope: "global",
    expectedRevision: created.revisions.global,
    expectedCredentialsRevision: created.revisions.credentials,
    input: replacementProviderInput(created.providerId, "replacement-with-cleanup-race"),
    async credentialTransactionStage(stage, details) {
      if (stage !== "settings-committed" || injected) return;
      injected = true;
      await store.set("ANTCODE_TEST_CONCURRENT_KEY", "unrelated-secret", {
        expectedRevision: details.credentialsRevision
      });
    }
  });

  const after = await readCredentialFixture(fixture, created.providerId);
  assert.equal(replaced.credentialCleanupPending, true);
  assert.notEqual(after.provider.auth.ref, before.provider.auth.ref);
  assert.equal(after.credentials[after.provider.auth.ref], "replacement-with-cleanup-race");
  assert.equal(after.credentials[before.provider.auth.ref], fixture.secret);
  assert.equal(after.credentials.ANTCODE_TEST_CONCURRENT_KEY, "unrelated-secret");
});

test("Dashboard V2 never rolls back a staged credential after an ambiguous settings commit", async () => {
  const fixture = await createFixture();
  const created = await createCredentialProvider(fixture);
  const before = await readCredentialFixture(fixture, created.providerId);
  const settingsPath = path.join(fixture.home, ".ant-code", "settings.json");
  const repository = createFileRepository({ filePath: settingsPath });
  let committedRef = "";

  await assert.rejects(
    saveV2ProviderModel({
      cwd: fixture.cwd,
      env: fixture.env,
      scope: "global",
      expectedRevision: created.revisions.global,
      expectedCredentialsRevision: created.revisions.credentials,
      input: replacementProviderInput(created.providerId, "replacement-after-ambiguous-commit"),
      async credentialTransactionStage(stage, details) {
        if (stage !== "credential-staged") return;
        committedRef = details.ref;
        const snapshot = await repository.read();
        const document = validateSettingsDocument(snapshot.data);
        document.namespaces["model-providers"].providers[created.providerId].auth = {
          mode: "credential",
          ref: committedRef
        };
        await repository.replace(document, { expectedRevision: snapshot.revision });
      }
    }),
    (error) => error.code === "CONFIG_REVISION_CONFLICT"
  );

  const after = await readCredentialFixture(fixture, created.providerId);
  assert.notEqual(committedRef, "");
  assert.notEqual(committedRef, before.provider.auth.ref);
  assert.equal(after.provider.auth.ref, committedRef);
  assert.equal(after.credentials[committedRef], "replacement-after-ambiguous-commit");
  assert.equal(after.credentials[before.provider.auth.ref], fixture.secret);
});

test("Dashboard V2 leaves only an orphan when settings CAS fails after credential staging", async () => {
  const fixture = await createFixture();
  const created = await createCredentialProvider(fixture);
  const before = await readCredentialFixture(fixture, created.providerId);
  const repository = createFileRepository({
    filePath: path.join(fixture.home, ".ant-code", "settings.json")
  });
  let stagedRef = "";

  await assert.rejects(
    saveV2ProviderModel({
      cwd: fixture.cwd,
      env: fixture.env,
      scope: "global",
      expectedRevision: created.revisions.global,
      expectedCredentialsRevision: created.revisions.credentials,
      input: replacementProviderInput(created.providerId, "replacement-after-cas-conflict"),
      async credentialTransactionStage(stage, details) {
        if (stage !== "credential-staged") return;
        stagedRef = details.ref;
        const snapshot = await repository.read();
        const document = validateSettingsDocument(snapshot.data);
        document.namespaces["model-providers"].providers[created.providerId].displayName = "Concurrent winner";
        await repository.replace(document, { expectedRevision: snapshot.revision });
      }
    }),
    (error) => error.code === "CONFIG_REVISION_CONFLICT"
  );

  const after = await readCredentialFixture(fixture, created.providerId);
  assert.notEqual(stagedRef, "");
  assert.equal(after.provider.displayName, "Concurrent winner");
  assert.equal(after.provider.auth.ref, before.provider.auth.ref);
  assert.equal(after.credentials[before.provider.auth.ref], fixture.secret);
  assert.equal(after.credentials[stagedRef], "replacement-after-cas-conflict");
});

test("Dashboard V2 credential transaction remains safe across process crashes", async (t) => {
  await t.test("replacement crash after staging leaves the old live binding intact", async () => {
    const fixture = await createFixture();
    const created = await createCredentialProvider(fixture);
    const before = await readCredentialFixture(fixture, created.providerId);
    const input = replacementProviderInput(created.providerId, "replacement-after-stage");

    await runCredentialCrashChild("save", {
      cwd: fixture.cwd,
      env: fixture.env,
      scope: "global",
      expectedRevision: created.revisions.global,
      expectedCredentialsRevision: created.revisions.credentials,
      input
    }, "credential-staged");

    const after = await readCredentialFixture(fixture, created.providerId);
    assert.equal(after.provider.transport.baseURL, before.provider.transport.baseURL);
    assert.equal(after.provider.auth.ref, before.provider.auth.ref);
    assert.equal(after.credentials[before.provider.auth.ref], fixture.secret);
    assert.equal(Object.values(after.credentials).includes("replacement-after-stage"), true);
  });

  await t.test("replacement crash after settings commit leaves only the old secret orphaned", async () => {
    const fixture = await createFixture();
    const created = await createCredentialProvider(fixture);
    const before = await readCredentialFixture(fixture, created.providerId);
    const input = replacementProviderInput(created.providerId, "replacement-after-settings");

    await runCredentialCrashChild("save", {
      cwd: fixture.cwd,
      env: fixture.env,
      scope: "global",
      expectedRevision: created.revisions.global,
      expectedCredentialsRevision: created.revisions.credentials,
      input
    }, "settings-committed");

    const after = await readCredentialFixture(fixture, created.providerId);
    assert.equal(after.provider.transport.baseURL, input.gatewayUrl);
    assert.notEqual(after.provider.auth.ref, before.provider.auth.ref);
    assert.equal(after.credentials[after.provider.auth.ref], "replacement-after-settings");
    assert.equal(after.credentials[before.provider.auth.ref], fixture.secret);
  });

  await t.test("clear crash detaches settings before leaving the old secret orphaned", async () => {
    const fixture = await createFixture();
    const created = await createCredentialProvider(fixture);
    const before = await readCredentialFixture(fixture, created.providerId);
    const input = replacementProviderInput(created.providerId, "");
    input.credentialAction = "keep";

    await runCredentialCrashChild("save", {
      cwd: fixture.cwd,
      env: fixture.env,
      scope: "global",
      expectedRevision: created.revisions.global,
      expectedCredentialsRevision: created.revisions.credentials,
      input
    }, "settings-committed");

    const after = await readCredentialFixture(fixture, created.providerId);
    assert.deepEqual(after.provider.auth, { mode: "none" });
    assert.equal(after.credentials[before.provider.auth.ref], fixture.secret);
  });

  await t.test("delete crash removes the provider before leaving the old secret orphaned", async () => {
    const fixture = await createFixture();
    const created = await createCredentialProvider(fixture);
    const before = await readCredentialFixture(fixture, created.providerId);

    await runCredentialCrashChild("delete", {
      cwd: fixture.cwd,
      env: fixture.env,
      scope: "global",
      expectedRevision: created.revisions.global,
      expectedCredentialsRevision: created.revisions.credentials,
      providerId: created.providerId
    }, "settings-committed");

    const after = await readCredentialFixture(fixture, created.providerId);
    assert.equal(after.provider, null);
    assert.equal(after.credentials[before.provider.auth.ref], fixture.secret);
  });
});

test("Dashboard V2 permits a project default for a global provider and blocks deleting its target", async () => {
  const fixture = await createFixture();
  const saved = await saveV2ProviderModel({
    cwd: fixture.cwd,
    env: fixture.env,
    scope: "global",
    expectedRevision: "missing",
    expectedCredentialsRevision: "missing",
    input: providerInput({ secret: fixture.secret, switchToModel: true })
  });
  const selected = await saveV2DefaultModel({
    cwd: fixture.cwd,
    env: fixture.env,
    scope: "project",
    expectedRevision: "missing",
    providerId: saved.providerId,
    modelId: "grok-4.6",
    reasoningEffort: "xhigh"
  });

  assert.deepEqual(selected.selection, {
    provider: saved.providerId,
    model: "grok-4.6",
    reasoningEffort: "xhigh"
  });
  await assert.rejects(
    deleteV2Provider({
      cwd: fixture.cwd,
      env: fixture.env,
      scope: "global",
      expectedRevision: saved.revisions.global,
      expectedCredentialsRevision: saved.revisions.credentials,
      providerId: saved.providerId
    }),
    (error) => error.code === "CONFIG_V2_PROJECT_REFERENCE_CONFLICT" && error.status === 409
  );
});

test("Dashboard V2 ignores stale project agent routes when deleting an inactive global model and provider", async () => {
  const fixture = await createFixture();
  const settingsPath = path.join(fixture.home, ".ant-code", "settings.json");
  const projectPath = path.join(fixture.cwd, ".lab-agent", "settings.json");
  const globalDocument = crossScopeDeletionSettings("active");
  const projectDocument = {
    settingsVersion: 2,
    namespaces: {
      "default-model": { selection: { provider: "active", model: "active-main" } },
      "agent-routing": {
        modelTiers: {
          cheap: { provider: "legacy", model: "legacy-worker" }
        },
        vision: {
          enabled: true,
          model: { provider: "legacy", model: "legacy-worker" },
          autoUseWhenMainModelTextOnly: true
        }
      }
    }
  };
  await Promise.all([
    fs.writeFile(settingsPath, `${JSON.stringify(globalDocument, null, 2)}\n`, "utf8"),
    fs.writeFile(projectPath, `${JSON.stringify(projectDocument, null, 2)}\n`, "utf8")
  ]);
  const repository = createFileRepository({ filePath: settingsPath });
  const initial = await repository.read();

  const deletedModel = await deleteV2ProviderModel({
    cwd: fixture.cwd,
    env: fixture.env,
    scope: "global",
    expectedRevision: initial.revision,
    expectedCredentialsRevision: "missing",
    providerId: "legacy",
    modelId: "legacy-worker"
  });
  let savedDocument = validateSettingsDocument(JSON.parse(await fs.readFile(settingsPath, "utf8")));
  assert.deepEqual(
    savedDocument.namespaces["model-providers"].providers.legacy.models.map((model) => model.id),
    ["legacy-main"]
  );
  assert.equal(
    resolveSettingsLayers({ global: savedDocument, project: projectDocument })
      .namespaces["agent-routing"],
    undefined
  );

  const deletedProvider = await deleteV2Provider({
    cwd: fixture.cwd,
    env: fixture.env,
    scope: "global",
    expectedRevision: deletedModel.revisions.global,
    expectedCredentialsRevision: deletedModel.revisions.credentials,
    providerId: "legacy"
  });
  assert.equal(deletedProvider.deletedProvider, "legacy");
  savedDocument = validateSettingsDocument(JSON.parse(await fs.readFile(settingsPath, "utf8")));
  assert.deepEqual(Object.keys(savedDocument.namespaces["model-providers"].providers), ["active"]);
});

test("Dashboard V2 blocks deleting global models and providers referenced by active project routes", async () => {
  const fixture = await createFixture();
  const settingsPath = path.join(fixture.home, ".ant-code", "settings.json");
  const projectPath = path.join(fixture.cwd, ".lab-agent", "settings.json");
  const globalDocument = crossScopeDeletionSettings("legacy");
  const projectDocument = {
    settingsVersion: 2,
    namespaces: {
      "agent-routing": {
        modelTiers: {
          cheap: { provider: "legacy", model: "legacy-worker" }
        }
      }
    }
  };
  await Promise.all([
    fs.writeFile(settingsPath, `${JSON.stringify(globalDocument, null, 2)}\n`, "utf8"),
    fs.writeFile(projectPath, `${JSON.stringify(projectDocument, null, 2)}\n`, "utf8")
  ]);
  const repository = createFileRepository({ filePath: settingsPath });
  const initial = await repository.read();

  await assert.rejects(
    deleteV2ProviderModel({
      cwd: fixture.cwd,
      env: fixture.env,
      scope: "global",
      expectedRevision: initial.revision,
      expectedCredentialsRevision: "missing",
      providerId: "legacy",
      modelId: "legacy-worker"
    }),
    (error) => error.code === "CONFIG_V2_PROJECT_REFERENCE_CONFLICT" && error.status === 409
  );
  await assert.rejects(
    deleteV2Provider({
      cwd: fixture.cwd,
      env: fixture.env,
      scope: "global",
      expectedRevision: initial.revision,
      expectedCredentialsRevision: "missing",
      providerId: "legacy"
    }),
    (error) => error.code === "CONFIG_V2_PROJECT_REFERENCE_CONFLICT" && error.status === 409
  );
  assert.equal((await repository.read()).revision, initial.revision);
});

test("Dashboard V2 serializes global deletes with project selections", async () => {
  const fixture = await createFixture();
  const saved = await saveV2ProviderModel({
    cwd: fixture.cwd,
    env: fixture.env,
    scope: "global",
    expectedRevision: "missing",
    expectedCredentialsRevision: "missing",
    input: providerInput({ secret: fixture.secret, switchToModel: true })
  });
  const lockTarget = path.join(fixture.home, ".ant-code", "model-settings-v2.transaction");
  let releaseBlockedMutations = () => {};
  const blockedMutations = new Promise((resolve) => {
    releaseBlockedMutations = resolve;
  });
  let lockAcquired = () => {};
  const acquired = new Promise((resolve) => {
    lockAcquired = resolve;
  });
  const heldLock = withConfigMutationLock(lockTarget, async () => {
    lockAcquired();
    await blockedMutations;
  });
  await acquired;

  let settled = 0;
  const deleting = deleteV2Provider({
    cwd: fixture.cwd,
    env: fixture.env,
    scope: "global",
    expectedRevision: saved.revisions.global,
    expectedCredentialsRevision: saved.revisions.credentials,
    providerId: saved.providerId
  }).finally(() => {
    settled += 1;
  });
  const selecting = saveV2DefaultModel({
    cwd: fixture.cwd,
    env: fixture.env,
    scope: "project",
    expectedRevision: "missing",
    providerId: saved.providerId,
    modelId: "grok-4.6",
    reasoningEffort: "xhigh"
  }).finally(() => {
    settled += 1;
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(settled, 0);
  releaseBlockedMutations();
  await heldLock;

  const outcomes = await Promise.allSettled([deleting, selecting]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
  const rejected = outcomes.find((outcome) => outcome.status === "rejected");
  assert.ok([
    "CONFIG_V2_PROJECT_REFERENCE_CONFLICT",
    "CONFIG_V2_REFERENCE_ERROR"
  ].includes(rejected?.reason?.code), `unexpected rejection: ${rejected?.reason?.code}`);
  const globalSnapshot = await createFileRepository({
    filePath: path.join(fixture.home, ".ant-code", "settings.json")
  }).read();
  const projectSnapshot = await createFileRepository({
    filePath: path.join(fixture.cwd, ".lab-agent", "settings.json")
  }).read();
  assert.doesNotThrow(() => resolveSettingsLayers({
    global: globalSnapshot.exists ? validateSettingsDocument(globalSnapshot.data) : undefined,
    project: projectSnapshot.exists ? validateSettingsDocument(projectSnapshot.data) : undefined
  }));
});

test("Dashboard V2 model mutations honor the transaction lock across processes", async () => {
  const fixture = await createFixture();
  const saved = await saveV2ProviderModel({
    cwd: fixture.cwd,
    env: fixture.env,
    scope: "global",
    expectedRevision: "missing",
    expectedCredentialsRevision: "missing",
    input: providerInput({ secret: fixture.secret, switchToModel: true })
  });
  const lockTarget = path.join(fixture.home, ".ant-code", "model-settings-v2.transaction");
  const configStoreUrl = new URL("../../src/dashboard/config-store.js", import.meta.url).href;
  const holder = spawn(process.execPath, [
    "--input-type=module",
    "-e",
    `
      import { withConfigMutationLock } from ${JSON.stringify(configStoreUrl)};
      await withConfigMutationLock(process.argv.at(-1), async () => {
        process.stdout.write("LOCKED\\n");
        await new Promise((resolve) => process.stdin.once("data", resolve));
      });
    `,
    lockTarget
  ], { stdio: ["pipe", "pipe", "pipe"] });
  let selecting;
  try {
    await waitForChildOutput(holder, "LOCKED");
    let settled = false;
    selecting = saveV2DefaultModel({
      cwd: fixture.cwd,
      env: fixture.env,
      scope: "project",
      expectedRevision: "missing",
      providerId: saved.providerId,
      modelId: "grok-4.6",
      reasoningEffort: "xhigh"
    }).finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(settled, false);

    const exited = once(holder, "exit");
    holder.stdin.end("release\n");
    const [exitCode] = await exited;
    assert.equal(exitCode, 0);
    const selected = await selecting;
    assert.deepEqual(selected.selection, {
      provider: saved.providerId,
      model: "grok-4.6",
      reasoningEffort: "xhigh"
    });
  } finally {
    if (holder.exitCode === null) {
      const exited = once(holder, "exit");
      holder.stdin.end("release\n");
      holder.kill();
      await exited.catch(() => {});
    }
    await selecting?.catch(() => {});
  }
});

test("Dashboard V2 rejects a global default that points at a project-only provider", async () => {
  const fixture = await createFixture();
  const projectProvider = await saveV2ProviderModel({
    cwd: fixture.cwd,
    env: fixture.env,
    scope: "project",
    expectedRevision: "missing",
    expectedCredentialsRevision: "missing",
    input: providerInput({ secret: fixture.secret, switchToModel: true })
  });

  await assert.rejects(
    saveV2DefaultModel({
      cwd: fixture.cwd,
      env: fixture.env,
      scope: "global",
      expectedRevision: "missing",
      providerId: projectProvider.providerId,
      modelId: "grok-4.6",
      reasoningEffort: "high"
    }),
    (error) => error.code === "CONFIG_V2_REFERENCE_SCOPE_ERROR"
  );
});

test("Dashboard V2 model saves preserve unmanaged fields while updating and clearing managed capabilities", async () => {
  const fixture = await createFixture();
  const settingsPath = path.join(fixture.home, ".ant-code", "settings.json");
  await fs.writeFile(settingsPath, `${JSON.stringify(existingProviderSettings(), null, 2)}\n`, "utf8");
  const repository = createFileRepository({ filePath: settingsPath });
  const initial = await repository.read();

  const updated = await saveV2ProviderModel({
    cwd: fixture.cwd,
    env: fixture.env,
    scope: "global",
    expectedRevision: initial.revision,
    expectedCredentialsRevision: "missing",
    input: existingProviderInput({
      contextTokens: 262_144,
      reasoningEfforts: ["low", "medium", "high", "xhigh"],
      defaultReasoningEffort: "xhigh"
    })
  });

  assert.equal(updated.ok, true);
  const updatedDocument = validateSettingsDocument(JSON.parse(await fs.readFile(settingsPath, "utf8")));
  const updatedProvider = updatedDocument.namespaces["model-providers"].providers.grok;
  const updatedModel = updatedProvider.models.find((model) => model.id === "grok-4.6");
  assert.deepEqual(updatedProvider.compat, { vendor: "xai", dashboard: { color: "black" } });
  assert.deepEqual(updatedProvider.transport.compat, { dialect: "responses-proxy", tenantAware: true });
  assert.equal(updatedModel.description, "Preserve this curated description.");
  assert.equal(updatedModel.maxOutputTokens, 16_384);
  assert.equal(updatedModel.reasoningContentMode, "visible-when-no-content");
  assert.deepEqual(updatedModel.openaiExtraBody, { store: false, metadata: { channel: "lab" } });
  assert.deepEqual(updatedModel.compat, {
    capabilityDiscovery: { source: "catalog", observedBy: "fixture" },
    vendorFlag: true
  });
  assert.equal(updatedModel.contextWindow, 262_144);
  assert.deepEqual(updatedModel.reasoning, {
    efforts: [
      { id: "low" },
      { id: "medium" },
      { id: "high" },
      { id: "xhigh" }
    ],
    default: "xhigh"
  });

  const cleared = await saveV2ProviderModel({
    cwd: fixture.cwd,
    env: fixture.env,
    scope: "global",
    expectedRevision: updated.revisions.global,
    expectedCredentialsRevision: updated.revisions.credentials,
    input: existingProviderInput({
      contextTokens: null,
      reasoningEfforts: [],
      defaultReasoningEffort: null,
      thinking: false
    })
  });

  assert.equal(cleared.ok, true);
  const clearedDocument = validateSettingsDocument(JSON.parse(await fs.readFile(settingsPath, "utf8")));
  const clearedProvider = clearedDocument.namespaces["model-providers"].providers.grok;
  const clearedModel = clearedProvider.models.find((model) => model.id === "grok-4.6");
  assert.equal(Object.prototype.hasOwnProperty.call(clearedModel, "contextWindow"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(clearedModel, "reasoning"), false);
  assert.equal(clearedModel.thinking, false);
  assert.deepEqual(clearedProvider.compat, updatedProvider.compat);
  assert.deepEqual(clearedProvider.transport.compat, updatedProvider.transport.compat);
  for (const field of ["description", "maxOutputTokens", "reasoningContentMode", "openaiExtraBody", "compat"]) {
    assert.deepEqual(clearedModel[field], updatedModel[field], field);
  }
});

test("Dashboard V2 accepts discovered models used only by provider agent routes", async () => {
  const fixture = await createFixture();
  const input = providerInput({ secret: fixture.secret, switchToModel: true });
  input.agentModelTiersProvided = true;
  input.model.agentModelTiers = {
    cheap: "gpt-5.6-Luna",
    default: "grok-4.6",
    strong: "gpt-5.6-SOL"
  };
  input.catalogModelIds = ["grok-4.6", "gpt-5.6-luna", "gpt-5.6-sol"];

  const saved = await saveV2ProviderModel({
    cwd: fixture.cwd,
    env: fixture.env,
    scope: "global",
    expectedRevision: "missing",
    expectedCredentialsRevision: "missing",
    input
  });

  assert.equal(saved.ok, true);
  const document = validateSettingsDocument(JSON.parse(await fs.readFile(
    path.join(fixture.home, ".ant-code", "settings.json"),
    "utf8"
  )));
  const provider = document.namespaces["model-providers"].providers[saved.providerId];
  assert.deepEqual(provider.agents.modelTiers, {
    cheap: "gpt-5.6-luna",
    default: "grok-4.6",
    strong: "gpt-5.6-sol"
  });
  assert.deepEqual(provider.models.find((model) => model.id === "gpt-5.6-luna")?.compat, { routingOnly: true });
  assert.deepEqual(provider.models.find((model) => model.id === "gpt-5.6-sol")?.compat, { routingOnly: true });
  assert.equal(provider.models.find((model) => model.id === "grok-4.6")?.compat?.routingOnly, undefined);

  const runtime = projectLegacyRuntimeConfig(resolveSettingsLayers({ global: document }));
  assert.deepEqual(runtime.agents.modelTiers, provider.agents.modelTiers);
  assert.deepEqual(runtime.models.map((model) => model.id), ["grok-4.6"]);
  assert.deepEqual(runtime.lab.gatewayProfiles[0].models.map((model) => model.id), ["grok-4.6"]);

  await assert.rejects(
    saveV2DefaultModel({
      cwd: fixture.cwd,
      env: fixture.env,
      scope: "global",
      expectedRevision: saved.revisions.global,
      providerId: saved.providerId,
      modelId: "gpt-5.6-luna"
    }),
    (error) => error.code === "CONFIG_V2_REFERENCE_ERROR" && /reserved for agent routing/.test(error.message)
  );
});

test("Dashboard V2 keeps a global routing-only model referenced by project routing", async () => {
  const fixture = await createFixture();
  const settingsPath = path.join(fixture.home, ".ant-code", "settings.json");
  const projectPath = path.join(fixture.cwd, ".lab-agent", "settings.json");
  const globalDocument = existingProviderSettings();
  globalDocument.namespaces["default-model"] = {
    selection: { provider: "grok", model: "grok-4.6" }
  };
  globalDocument.namespaces["model-providers"].providers.grok.models.push({
    id: "project-worker",
    displayName: "Project Worker",
    compat: { routingOnly: true }
  });
  await fs.writeFile(settingsPath, `${JSON.stringify(globalDocument, null, 2)}\n`, "utf8");
  await fs.writeFile(projectPath, `${JSON.stringify({
    settingsVersion: 2,
    namespaces: {
      "agent-routing": {
        modelTiers: {
          cheap: { provider: "grok", model: "project-worker" }
        }
      }
    }
  }, null, 2)}\n`, "utf8");
  const initial = await createFileRepository({ filePath: settingsPath }).read();

  const saved = await saveV2ProviderModel({
    cwd: fixture.cwd,
    env: fixture.env,
    scope: "global",
    expectedRevision: initial.revision,
    expectedCredentialsRevision: "missing",
    input: existingProviderInput()
  });

  assert.equal(saved.ok, true);
  const document = validateSettingsDocument(JSON.parse(await fs.readFile(settingsPath, "utf8")));
  assert.equal(
    document.namespaces["model-providers"].providers.grok.models.find((model) => model.id === "project-worker")?.compat?.routingOnly,
    true
  );
});

test("Dashboard V2 blocks a global rename that would strand a project model reference", async () => {
  const fixture = await createFixture();
  const settingsPath = path.join(fixture.home, ".ant-code", "settings.json");
  const projectPath = path.join(fixture.cwd, ".lab-agent", "settings.json");
  await fs.writeFile(settingsPath, `${JSON.stringify(existingProviderSettings(), null, 2)}\n`, "utf8");
  await fs.writeFile(projectPath, `${JSON.stringify({
    settingsVersion: 2,
    namespaces: {
      "default-model": { selection: { provider: "grok", model: "grok-4.6" } }
    }
  }, null, 2)}\n`, "utf8");
  const repository = createFileRepository({ filePath: settingsPath });
  const initial = await repository.read();
  const input = existingProviderInput({ id: "grok-4.7", label: "Grok 4.7" });
  input.previousModelId = "grok-4.6";

  await assert.rejects(
    saveV2ProviderModel({
      cwd: fixture.cwd,
      env: fixture.env,
      scope: "global",
      expectedRevision: initial.revision,
      input
    }),
    (error) => error.code === "CONFIG_V2_PROJECT_REFERENCE_CONFLICT" && error.status === 409
  );
  assert.equal((await repository.read()).revision, initial.revision);
});

async function createCredentialProvider(fixture) {
  return saveV2ProviderModel({
    cwd: fixture.cwd,
    env: fixture.env,
    scope: "global",
    expectedRevision: "missing",
    expectedCredentialsRevision: "missing",
    input: providerInput({ secret: fixture.secret })
  });
}

function replacementProviderInput(providerId, secret) {
  const input = providerInput({ providerId, secret });
  input.gatewayUrl = "https://replacement.example/v1/responses";
  input.catalogModelIds = ["grok-4.6"];
  return input;
}

async function readCredentialFixture(fixture, providerId) {
  const settingsPath = path.join(fixture.home, ".ant-code", "settings.json");
  const credentialsPath = path.join(fixture.home, ".ant-code", "credentials.json");
  const settings = validateSettingsDocument(JSON.parse(await fs.readFile(settingsPath, "utf8")));
  const credentials = JSON.parse(await fs.readFile(credentialsPath, "utf8")).credentials;
  return {
    provider: settings.namespaces["model-providers"]?.providers?.[providerId] ?? null,
    credentials
  };
}

async function runCredentialCrashChild(operation, options, stage) {
  const modelSettingsUrl = new URL("../../src/dashboard/model-settings-v2.js", import.meta.url).href;
  const child = spawn(process.execPath, [
    "--input-type=module",
    "-e",
    `
      import { deleteV2Provider, saveV2ProviderModel } from ${JSON.stringify(modelSettingsUrl)};
      const payload = JSON.parse(process.argv.at(-3));
      const operation = process.argv.at(-2);
      const crashStage = process.argv.at(-1);
      const mutate = operation === "delete" ? deleteV2Provider : saveV2ProviderModel;
      await mutate({
        ...payload,
        credentialTransactionStage(currentStage) {
          if (currentStage === crashStage) process.exit(86);
        }
      });
    `,
    JSON.stringify(options),
    operation,
    stage
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const [exitCode, signal] = await once(child, "exit");
  assert.equal(signal, null, stderr);
  assert.equal(exitCode, 86, stderr || `child did not reach credential stage ${stage}`);
}

async function writeSharedCredentialLayers(fixture) {
  const globalProviderId = "global-grok";
  const projectProviderId = "project-grok";
  const credentialRef = "ANTCODE_SHARED_GATEWAY_KEY";
  const globalPath = path.join(fixture.home, ".ant-code", "settings.json");
  const projectPath = path.join(fixture.cwd, ".lab-agent", "settings.json");
  const credentialsPath = path.join(fixture.home, ".ant-code", "credentials.json");
  await Promise.all([
    fs.writeFile(globalPath, `${JSON.stringify(sharedCredentialSettings(globalProviderId, credentialRef), null, 2)}\n`, "utf8"),
    fs.writeFile(projectPath, `${JSON.stringify(sharedCredentialSettings(projectProviderId, credentialRef), null, 2)}\n`, "utf8"),
    fs.writeFile(credentialsPath, `${JSON.stringify({
      version: 1,
      credentials: { [credentialRef]: fixture.secret }
    }, null, 2)}\n`, "utf8")
  ]);
  const [globalSnapshot, projectSnapshot, credentialsSnapshot] = await Promise.all([
    createFileRepository({ filePath: globalPath }).read(),
    createFileRepository({ filePath: projectPath }).read(),
    createFileRepository({ filePath: credentialsPath }).read()
  ]);
  return {
    globalProviderId,
    projectProviderId,
    credentialRef,
    globalPath,
    projectPath,
    credentialsPath,
    globalRevision: globalSnapshot.revision,
    projectRevision: projectSnapshot.revision,
    credentialsRevision: credentialsSnapshot.revision
  };
}

function sharedCredentialSettings(providerId, credentialRef) {
  return {
    settingsVersion: 2,
    namespaces: {
      "model-providers": {
        providers: {
          [providerId]: {
            displayName: providerId,
            transport: {
              protocol: "openai-responses",
              baseURL: "https://grok.example/v1/responses"
            },
            auth: { mode: "credential", ref: credentialRef },
            models: [{
              id: "grok-4.6",
              displayName: "Grok 4.6",
              thinking: true,
              inputModalities: ["text", "image"],
              reasoning: {
                efforts: [
                  { id: "low" },
                  { id: "medium" },
                  { id: "high" },
                  { id: "xhigh" }
                ],
                default: "high"
              }
            }]
          }
        }
      }
    }
  };
}

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-model-settings-v2-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "project");
  await fs.mkdir(path.join(home, ".ant-code"), { recursive: true });
  await fs.mkdir(path.join(cwd, ".lab-agent"), { recursive: true });
  return {
    cwd,
    home,
    env: { USERPROFILE: home },
    secret: "dashboard-v2-secret"
  };
}

function providerInput(options = {}) {
  return {
    profileId: options.providerId ?? "",
    gatewayUrl: "https://grok.example/v1/responses",
    gatewayProtocol: "openai-responses",
    gatewayHealthUrl: "",
    gatewayApiKey: options.secret ?? "",
    credentialAction: "replace",
    switchToModel: options.switchToModel === true,
    model: {
      id: "grok-4.6",
      label: "Grok 4.6",
      thinking: true,
      modalities: ["text", "image"],
      reasoningEfforts: ["low", "medium", "high", "xhigh"],
      defaultReasoningEffort: "high"
    }
  };
}

function existingProviderSettings() {
  return {
    settingsVersion: 2,
    namespaces: {
      "model-providers": {
        providers: {
          grok: {
            displayName: "Grok",
            transport: {
              protocol: "openai-responses",
              baseURL: "https://grok.example/v1/responses",
              compat: { dialect: "responses-proxy", tenantAware: true }
            },
            auth: { mode: "none" },
            models: [{
              id: "grok-4.6",
              displayName: "Grok 4.6",
              description: "Preserve this curated description.",
              thinking: true,
              inputModalities: ["text"],
              contextWindow: 131_072,
              maxOutputTokens: 16_384,
              reasoningContentMode: "visible-when-no-content",
              reasoning: {
                efforts: [{ id: "low" }, { id: "high" }],
                default: "high"
              },
              openaiExtraBody: { store: false, metadata: { channel: "lab" } },
              compat: {
                capabilityDiscovery: { source: "catalog", observedBy: "fixture" },
                vendorFlag: true
              }
            }],
            compat: { vendor: "xai", dashboard: { color: "black" } }
          }
        }
      }
    }
  };
}

function existingProviderInput(modelOverrides = {}) {
  return {
    profileId: "grok",
    gatewayUrl: "https://grok.example/v1/responses",
    gatewayProtocol: "openai-responses",
    gatewayHealthUrl: "",
    credentialAction: "keep",
    switchToModel: false,
    model: {
      id: "grok-4.6",
      label: "Grok 4.6 Dashboard",
      thinking: true,
      modalities: ["text"],
      ...modelOverrides
    }
  };
}

/** @param {"active" | "legacy"} activeProvider */
function crossScopeDeletionSettings(activeProvider) {
  return {
    settingsVersion: 2,
    namespaces: {
      "model-providers": {
        providers: {
          legacy: {
            displayName: "Legacy",
            transport: { protocol: "openai-chat", baseURL: "https://legacy.example/v1/chat/completions" },
            auth: { mode: "none" },
            models: [
              { id: "legacy-main", displayName: "Legacy Main" },
              { id: "legacy-worker", displayName: "Legacy Worker", compat: { routingOnly: true } }
            ]
          },
          active: {
            displayName: "Active",
            transport: { protocol: "openai-responses", baseURL: "https://active.example/v1/responses" },
            auth: { mode: "none" },
            models: [{ id: "active-main", displayName: "Active Main" }]
          }
        }
      },
      "default-model": {
        selection: activeProvider === "legacy"
          ? { provider: "legacy", model: "legacy-main" }
          : { provider: "active", model: "active-main" }
      }
    }
  };
}

/** @param {import("node:child_process").ChildProcessWithoutNullStreams} child @param {string} expected */
function waitForChildOutput(child, expected) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for child output ${expected}; stderr: ${stderr}`));
    }, 5_000);
    const onStdout = (chunk) => {
      stdout += String(chunk);
      if (!stdout.includes(expected)) return;
      cleanup();
      resolve();
    };
    const onStderr = (chunk) => {
      stderr += String(chunk);
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`Lock holder exited with ${code}; stderr: ${stderr}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
    };
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("exit", onExit);
  });
}
