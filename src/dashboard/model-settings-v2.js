import path from "node:path";
import { createFileRepository, ConfigRevisionConflictError } from "../config-v2/file-repository.js";
import {
  defaultSelection,
  deleteProvider,
  deleteProviderModel,
  updateDefaultModelSelection,
  upsertProviderModel
} from "../config-v2/model-mutations.js";
import { credentialsPath, globalSettingsPath, projectSettingsPath } from "../config-v2/paths.js";
import { resolveSettingsLayers } from "../config-v2/resolver.js";
import { validateSettingsDocument } from "../config-v2/schema.js";
import { createCredentialStore } from "../credentials/store.js";
import { withConfigMutationLock } from "./config-store.js";

const EMPTY_SETTINGS_DOCUMENT = Object.freeze({ settingsVersion: 2, namespaces: Object.freeze({}) });
const MODEL_SETTINGS_TRANSACTION_TARGET = "model-settings-v2.transaction";

/** @param {{ cwd: string; env?: NodeJS.ProcessEnv; scope: unknown; expectedRevision: unknown; expectedCredentialsRevision: unknown; input: Record<string, any>; prepareInput?: () => Promise<Record<string, any>>; credentialTransactionStage?: (stage: string, details: Record<string, any>) => unknown }} options */
export async function saveV2ProviderModel(options) {
  return withModelSettingsMutationLock(options, async () => {
    const input = typeof options.prepareInput === "function"
      ? await options.prepareInput()
      : options.input;
    return saveV2ProviderModelLocked({ ...options, input });
  });
}

/** @param {{ cwd: string; env?: NodeJS.ProcessEnv; scope: unknown; expectedRevision: unknown; expectedCredentialsRevision: unknown; providerId: unknown; modelId: unknown; credentialTransactionStage?: (stage: string, details: Record<string, any>) => unknown }} options */
export async function deleteV2ProviderModel(options) {
  return withModelSettingsMutationLock(options, () => deleteV2ProviderModelLocked(options));
}

/** @param {{ cwd: string; env?: NodeJS.ProcessEnv; scope: unknown; expectedRevision: unknown; expectedCredentialsRevision: unknown; providerId: unknown; credentialTransactionStage?: (stage: string, details: Record<string, any>) => unknown }} options */
export async function deleteV2Provider(options) {
  return withModelSettingsMutationLock(options, () => deleteV2ProviderLocked(options));
}

/** @param {{ cwd: string; env?: NodeJS.ProcessEnv; scope: unknown; expectedRevision: unknown; providerId: unknown; modelId: unknown; reasoningEffort?: unknown }} options */
export async function saveV2DefaultModel(options) {
  return withModelSettingsMutationLock(options, () => saveV2DefaultModelLocked(options));
}

/**
 * Persist a normalized Dashboard model form into one explicitly selected V2
 * scope. Replacement credentials use a fresh reference and are staged before
 * the settings CAS; removal first detaches settings and then garbage-collects
 * the old secret. A crash can therefore leave only an unreferenced credential,
 * never a live configuration bound to the wrong or missing secret.
 *
 * @param {{ cwd: string; env?: NodeJS.ProcessEnv; scope: unknown; expectedRevision: unknown; expectedCredentialsRevision: unknown; input: Record<string, any>; credentialTransactionStage?: (stage: string, details: Record<string, any>) => unknown }} options
 */
async function saveV2ProviderModelLocked(options) {
  const context = await mutationContext(options);
  const credentialReferences = await credentialReferencesAcrossLayers(context);
  const protectedRoutingModelIds = context.scope === "global" && options.input?.profileId
    ? await projectReferencedModelIds(options.cwd, String(options.input.profileId), context.snapshot.data)
    : [];
  const mutation = /** @type {any} */ (upsertProviderModel(context.snapshot.data, {
    ...options.input,
    protectedRoutingModelIds,
    credentialReferences
  }));
  assertMutationResult(mutation);
  if (context.scope === "global") {
    await assertProjectDoesNotReferenceRemovedModels({
      cwd: options.cwd,
      providerId: mutation.providerId,
      before: context.snapshot.data,
      after: mutation.document
    });
  }
  const document = validateSettingsDocument(mutation.document);
  await validateResolvedMutation(context, document);
  const written = await writeSettingsWithCredential({
    ...context,
    document,
    credentialMutation: mutation.credentialMutation,
    expectedCredentialsRevision: options.expectedCredentialsRevision,
    credentialTransactionStage: options.credentialTransactionStage
  });
  return {
    ok: true,
    scope: context.scope,
    providerId: mutation.providerId,
    modelId: mutation.modelId,
    configPath: context.repository.path,
    configRevision: written.settings.revision,
    revisions: revisionResult(context.scope, written.settings.revision, written.credentials.revision),
    credentialConfigured: mutation.credentialConfigured,
    ...(written.credentialCleanupPending ? { credentialCleanupPending: true } : {})
  };
}

/**
 * @param {{ cwd: string; env?: NodeJS.ProcessEnv; scope: unknown; expectedRevision: unknown; expectedCredentialsRevision: unknown; providerId: unknown; modelId: unknown; credentialTransactionStage?: (stage: string, details: Record<string, any>) => unknown }} options
 */
async function deleteV2ProviderModelLocked(options) {
  const context = await mutationContext(options);
  const credentialReferences = await credentialReferencesAcrossLayers(context);
  const providerId = requiredIdentifier(options.providerId, "providerId");
  const modelId = requiredIdentifier(options.modelId, "modelId");
  const protectedRoutingModelIds = context.scope === "global"
    ? await projectReferencedModelIds(options.cwd, providerId, context.snapshot.data)
    : [];
  if (context.scope === "global") {
    await assertProjectDoesNotReference({
      cwd: options.cwd,
      globalDocument: context.snapshot.data,
      providerId,
      modelId
    });
  }
  const mutation = /** @type {any} */ (deleteProviderModel(context.snapshot.data, providerId, modelId, {
    protectedRoutingModelIds,
    credentialReferences
  }));
  assertMutationResult(mutation);
  if (context.scope === "global") {
    await assertProjectDoesNotReference({
      cwd: options.cwd,
      globalDocument: context.snapshot.data,
      providerId,
      modelId: mutation.deletedModel ?? modelId
    });
    await assertProjectDoesNotReferenceRemovedModels({
      cwd: options.cwd,
      providerId,
      before: context.snapshot.data,
      after: mutation.document
    });
  }
  const document = validateSettingsDocument(mutation.document);
  await validateResolvedMutation(context, document);
  const credentialMutation = mutation.deletedProvider && mutation.credentialRef
    ? { op: "clear", ref: mutation.credentialRef }
    : null;
  const written = await writeSettingsWithCredential({
    ...context,
    document,
    credentialMutation,
    expectedCredentialsRevision: options.expectedCredentialsRevision,
    credentialTransactionStage: options.credentialTransactionStage
  });
  return {
    ok: true,
    scope: context.scope,
    providerId,
    deletedModel: modelId,
    deletedProvider: mutation.deletedProvider || undefined,
    configPath: context.repository.path,
    configRevision: written.settings.revision,
    revisions: revisionResult(context.scope, written.settings.revision, written.credentials.revision),
    ...(written.credentialCleanupPending ? { credentialCleanupPending: true } : {})
  };
}

/**
 * @param {{ cwd: string; env?: NodeJS.ProcessEnv; scope: unknown; expectedRevision: unknown; expectedCredentialsRevision: unknown; providerId: unknown; credentialTransactionStage?: (stage: string, details: Record<string, any>) => unknown }} options
 */
async function deleteV2ProviderLocked(options) {
  const context = await mutationContext(options);
  const credentialReferences = await credentialReferencesAcrossLayers(context);
  const providerId = requiredIdentifier(options.providerId, "providerId");
  if (context.scope === "global") {
    await assertProjectDoesNotReference({
      cwd: options.cwd,
      globalDocument: context.snapshot.data,
      providerId
    });
  }
  const mutation = /** @type {any} */ (deleteProvider(context.snapshot.data, providerId, {
    credentialReferences
  }));
  assertMutationResult(mutation);
  const document = validateSettingsDocument(mutation.document);
  await validateResolvedMutation(context, document);
  const credentialMutation = mutation.credentialRef
    ? { op: "clear", ref: mutation.credentialRef }
    : null;
  const written = await writeSettingsWithCredential({
    ...context,
    document,
    credentialMutation,
    expectedCredentialsRevision: options.expectedCredentialsRevision,
    credentialTransactionStage: options.credentialTransactionStage
  });
  return {
    ok: true,
    scope: context.scope,
    deletedProvider: providerId,
    configPath: context.repository.path,
    configRevision: written.settings.revision,
    revisions: revisionResult(context.scope, written.settings.revision, written.credentials.revision),
    ...(written.credentialCleanupPending ? { credentialCleanupPending: true } : {})
  };
}

/**
 * @param {{ cwd: string; env?: NodeJS.ProcessEnv; scope: unknown; expectedRevision: unknown; providerId: unknown; modelId: unknown; reasoningEffort?: unknown }} options
 */
async function saveV2DefaultModelLocked(options) {
  const context = await mutationContext(options);
  const provider = requiredIdentifier(options.providerId, "providerId");
  const model = requiredIdentifier(options.modelId, "modelId");
  const mutation = /** @type {any} */ (updateDefaultModelSelection(context.snapshot.data, {
    provider,
    model,
    reasoningEffort: String(options.reasoningEffort ?? "").trim().toLowerCase() || undefined
  }));
  assertMutationResult(mutation);
  const document = validateSettingsDocument(mutation.document);
  await validateResolvedMutation(context, document);
  const written = await context.repository.replace(
    document,
    { expectedRevision: context.expectedRevision }
  );
  const credentials = await createCredentialStore({ filePath: credentialsPath(options.env) }).describeAll();
  return {
    ok: true,
    scope: context.scope,
    selection: defaultSelection(mutation.document),
    configPath: context.repository.path,
    configRevision: written.revision,
    revisions: revisionResult(context.scope, written.revision, credentials.revision)
  };
}

/** @param {Record<string, any>} config */
export function publicV2ConfigState(config) {
  const v2 = config?.configV2;
  if (!v2?.enabled) {
    return {
      enabled: false,
      paths: null,
      revisions: { global: null, project: null, credentials: null },
      defaultSelections: { global: null, project: null },
      provenance: null
    };
  }
  return {
    enabled: true,
    paths: {
      global: String(v2.settingsPaths?.global ?? ""),
      project: String(v2.settingsPaths?.project ?? "")
    },
    revisions: {
      global: revisionValue(v2.revisions?.global),
      project: revisionValue(v2.revisions?.project),
      credentials: revisionValue(v2.revisions?.credentials)
    },
    defaultSelections: {
      global: clonePublicValue(v2.defaultSelections?.global ?? null),
      project: clonePublicValue(v2.defaultSelections?.project ?? null)
    },
    provenance: clonePublicValue(v2.provenance ?? null)
  };
}

/** @param {unknown} error */
export function dashboardV2ErrorResult(error) {
  const issue = /** @type {any} */ (error);
  if (issue?.dashboardResult) return issue.dashboardResult;
  if (issue?.code === "CONFIG_REVISION_CONFLICT" || issue instanceof ConfigRevisionConflictError) {
    return {
      ok: false,
      status: 409,
      code: "CONFIG_REVISION_CONFLICT",
      error: "配置已被其他页面或进程修改，请刷新设置后重试"
    };
  }
  if (["CONFIG_LOCK_TIMEOUT", "STORAGE_LOCK_TIMEOUT"].includes(issue?.code)) {
    return {
      ok: false,
      status: 409,
      code: "CONFIG_V2_MUTATION_BUSY",
      error: "另一个 Ant Code 进程正在修改模型配置，请稍后重试"
    };
  }
  if (Number.isInteger(issue?.status) && issue.status >= 400 && issue.status < 600) {
    return {
      ok: false,
      status: issue.status,
      code: String(issue.code ?? "CONFIG_V2_ERROR"),
      error: String(issue.message ?? "模型配置更新失败")
    };
  }
  if (String(issue?.code ?? "").startsWith("CONFIG_V2_")) {
    const conflict = issue.code === "CONFIG_V2_PROVIDER_SCOPE_CONFLICT";
    return {
      ok: false,
      status: conflict ? 409 : 400,
      code: String(issue.code),
      error: String(issue.message ?? "模型配置更新失败")
    };
  }
  if (issue instanceof TypeError) {
    return {
      ok: false,
      status: 400,
      code: String(/** @type {any} */ (issue).code ?? "CONFIG_V2_INVALID_REQUEST"),
      error: issue.message
    };
  }
  throw error;
}

/** @param {{ cwd: string; env?: NodeJS.ProcessEnv; scope: unknown; expectedRevision: unknown }} options */
async function mutationContext(options) {
  const scope = explicitScope(options.scope);
  const expectedRevision = requiredRevision(options.expectedRevision, "expectedRevision");
  const repository = createFileRepository({
    filePath: scope === "global" ? globalSettingsPath(options.env) : projectSettingsPath(options.cwd)
  });
  const snapshot = await repository.read();
  if (snapshot.revision !== expectedRevision) {
    throw new ConfigRevisionConflictError();
  }
  return {
    scope,
    expectedRevision,
    repository,
    snapshot: {
      ...snapshot,
      data: snapshot.exists ? validateSettingsDocument(snapshot.data) : clonePublicValue(EMPTY_SETTINGS_DOCUMENT)
    },
    cwd: options.cwd,
    env: options.env
  };
}

/**
 * Serialize every Dashboard model mutation on one user-level lock. Project
 * defaults may reference global providers, so locking only the target file
 * permits a global delete and a project selection to both validate stale
 * snapshots and commit an invalid merged configuration.
 *
 * @template T
 * @param {{ env?: NodeJS.ProcessEnv }} options
 * @param {() => Promise<T>} operation
 */
function withModelSettingsMutationLock(options, operation) {
  const lockTarget = path.join(
    path.dirname(globalSettingsPath(options.env)),
    MODEL_SETTINGS_TRANSACTION_TARGET
  );
  return withConfigMutationLock(lockTarget, operation);
}

/** @param {Record<string, any>} context */
async function credentialReferencesAcrossLayers(context) {
  const otherPath = context.scope === "global"
    ? projectSettingsPath(context.cwd)
    : globalSettingsPath(context.env);
  const other = await createFileRepository({ filePath: otherPath }).read();
  const otherDocument = other.exists
    ? validateSettingsDocument(other.data)
    : clonePublicValue(EMPTY_SETTINGS_DOCUMENT);
  return [context.snapshot.data, otherDocument].flatMap(collectCredentialReferences);
}

/** @param {Record<string, any>} document */
function collectCredentialReferences(document) {
  return Object.values(document.namespaces?.["model-providers"]?.providers ?? {})
    .filter((provider) => provider?.auth?.mode === "credential")
    .map((provider) => String(provider.auth.ref ?? "").trim())
    .filter(Boolean);
}

/** @param {Record<string, any>} context @param {Record<string, any>} document */
async function validateResolvedMutation(context, document) {
  const otherPath = context.scope === "global"
    ? projectSettingsPath(context.cwd)
    : globalSettingsPath(context.env);
  const other = await createFileRepository({ filePath: otherPath }).read();
  const otherDocument = other.exists
    ? validateSettingsDocument(other.data)
    : clonePublicValue(EMPTY_SETTINGS_DOCUMENT);
  resolveSettingsLayers(context.scope === "global"
    ? { global: document, project: otherDocument }
    : { global: otherDocument, project: document });
}

/**
 * @param {Record<string, any>} options
 */
async function writeSettingsWithCredential(options) {
  const store = createCredentialStore({ filePath: credentialsPath(options.env) });
  if (!options.credentialMutation) {
    const expectedCredentialsRevision = requiredRevision(
      options.expectedCredentialsRevision,
      "expectedCredentialsRevision"
    );
    return withConfigMutationLock(store.path, async () => {
      const credentials = await store.describeAll();
      if (credentials.revision !== expectedCredentialsRevision) {
        throw new ConfigRevisionConflictError();
      }
      const settings = await options.repository.replace(options.document, {
        expectedRevision: options.expectedRevision
      });
      return { settings, credentials, credentialCleanupPending: false };
    });
  }

  const expectedCredentialsRevision = requiredRevision(
    options.expectedCredentialsRevision,
    "expectedCredentialsRevision"
  );
  const descriptor = await store.describeAll();
  if (descriptor.revision !== expectedCredentialsRevision) {
    throw new ConfigRevisionConflictError();
  }

  if (options.credentialMutation.op === "set") {
    return writeSettingsWithReplacementCredential(
      options,
      store,
      expectedCredentialsRevision
    );
  }
  if (options.credentialMutation.op === "clear") {
    return writeSettingsBeforeCredentialClear(
      options,
      store,
      expectedCredentialsRevision
    );
  }
  throw new TypeError(`Unsupported credential mutation: ${options.credentialMutation.op}`);
}

/** @param {Record<string, any>} options @param {ReturnType<typeof createCredentialStore>} store @param {string} expectedCredentialsRevision */
async function writeSettingsWithReplacementCredential(options, store, expectedCredentialsRevision) {
  const mutation = options.credentialMutation;
  const credentialWrite = await store.set(mutation.ref, mutation.value, {
    expectedRevision: expectedCredentialsRevision
  });
  await reportCredentialTransactionStage(options, "credential-staged", {
    op: "set",
    ref: mutation.ref,
    cleanupRef: mutation.cleanupRef ?? null,
    credentialsRevision: credentialWrite.revision
  });

  // A replace error can be post-rename (for example, a directory fsync
  // failure). Rolling back the staged ref could then break committed settings;
  // retaining an unreferenced credential is the only safe ambiguous outcome.
  const settings = await options.repository.replace(options.document, {
    expectedRevision: options.expectedRevision
  });
  await reportCredentialTransactionStage(options, "settings-committed", {
    op: "set",
    ref: mutation.ref,
    cleanupRef: mutation.cleanupRef ?? null,
    settingsRevision: settings.revision,
    credentialsRevision: credentialWrite.revision
  });

  const cleanup = mutation.cleanupRef
    ? await clearCredentialAfterSettingsCommit(store, mutation.cleanupRef, credentialWrite.revision)
    : { credentials: credentialWrite, pending: false };
  await reportCredentialTransactionStage(options, "credential-cleanup-complete", {
    op: "set",
    ref: mutation.ref,
    cleanupRef: mutation.cleanupRef ?? null,
    settingsRevision: settings.revision,
    credentialsRevision: cleanup.credentials.revision,
    cleanupPending: cleanup.pending
  });
  return {
    settings,
    credentials: cleanup.credentials,
    credentialCleanupPending: cleanup.pending
  };
}

/** @param {Record<string, any>} options @param {ReturnType<typeof createCredentialStore>} store @param {string} expectedCredentialsRevision */
async function writeSettingsBeforeCredentialClear(options, store, expectedCredentialsRevision) {
  const mutation = options.credentialMutation;
  const settings = await options.repository.replace(options.document, {
    expectedRevision: options.expectedRevision
  });
  await reportCredentialTransactionStage(options, "settings-committed", {
    op: "clear",
    ref: mutation.ref,
    settingsRevision: settings.revision,
    credentialsRevision: expectedCredentialsRevision
  });

  const cleanup = await clearCredentialAfterSettingsCommit(
    store,
    mutation.ref,
    expectedCredentialsRevision
  );
  await reportCredentialTransactionStage(options, "credential-cleanup-complete", {
    op: "clear",
    ref: mutation.ref,
    settingsRevision: settings.revision,
    credentialsRevision: cleanup.credentials.revision,
    cleanupPending: cleanup.pending
  });
  return {
    settings,
    credentials: cleanup.credentials,
    credentialCleanupPending: cleanup.pending
  };
}

/** @param {ReturnType<typeof createCredentialStore>} store @param {string} ref @param {string} expectedRevision */
async function clearCredentialAfterSettingsCommit(store, ref, expectedRevision) {
  try {
    return {
      credentials: await store.clear(ref, { expectedRevision }),
      pending: false
    };
  } catch {
    const credentials = await store.describeAll().catch(() => ({
      revision: expectedRevision,
      credentials: []
    }));
    return { credentials, pending: true };
  }
}

/** @param {Record<string, any>} options @param {string} stage @param {Record<string, any>} details */
async function reportCredentialTransactionStage(options, stage, details) {
  if (typeof options.credentialTransactionStage !== "function") return;
  await options.credentialTransactionStage(stage, clonePublicValue(details));
}

/** @param {{ cwd: string; globalDocument: Record<string, any>; providerId: string; modelId?: string }} options */
async function assertProjectDoesNotReference(options) {
  const snapshot = await createFileRepository({ filePath: projectSettingsPath(options.cwd) }).read();
  if (!snapshot.exists) return;
  const project = validateSettingsDocument(snapshot.data);
  const references = collectEffectiveProjectReferences(project, options.globalDocument);
  const conflict = references.some((reference) => (
    reference.provider === options.providerId
    && (!options.modelId || reference.model === options.modelId)
  ));
  if (!conflict) return;
  throw Object.assign(new Error(options.modelId
    ? "当前项目仍引用这个全局模型，请先修改项目默认模型或路由"
    : "当前项目仍引用这个全局模型来源，请先修改项目默认模型或路由"), {
    status: 409,
    code: "CONFIG_V2_PROJECT_REFERENCE_CONFLICT"
  });
}

/** @param {string} cwd @param {string} providerId @param {Record<string, any>} globalDocument */
async function projectReferencedModelIds(cwd, providerId, globalDocument) {
  const snapshot = await createFileRepository({ filePath: projectSettingsPath(cwd) }).read();
  if (!snapshot.exists) return [];
  const project = validateSettingsDocument(snapshot.data);
  return [...new Set(collectEffectiveProjectReferences(project, globalDocument)
    .filter((reference) => reference.provider === providerId)
    .map((reference) => reference.model))];
}

/**
 * @param {{ cwd: string; providerId: string; before: Record<string, any>; after: Record<string, any> }} options
 */
async function assertProjectDoesNotReferenceRemovedModels(options) {
  const beforeModels = providerModelIds(options.before, options.providerId);
  const afterModels = new Set(providerModelIds(options.after, options.providerId));
  for (const modelId of beforeModels) {
    if (!afterModels.has(modelId)) {
      await assertProjectDoesNotReference({
        cwd: options.cwd,
        globalDocument: options.before,
        providerId: options.providerId,
        modelId
      });
    }
  }
}

/** @param {Record<string, any>} document @param {string} providerId */
function providerModelIds(document, providerId) {
  const models = document.namespaces?.["model-providers"]?.providers?.[providerId]?.models;
  return Array.isArray(models) ? models.map((model) => String(model?.id ?? "").trim()).filter(Boolean) : [];
}

/**
 * Project agent routes are transport-bound to the final active provider. A
 * route left behind by an earlier provider selection is inert and must not
 * keep that old global provider or model alive. The project default selection
 * itself remains an authoritative cross-scope reference.
 *
 * @param {Record<string, any>} project
 * @param {Record<string, any>} globalDocument
 */
function collectEffectiveProjectReferences(project, globalDocument) {
  const references = [];
  const selection = project.namespaces?.["default-model"]?.selection;
  if (selection) references.push(selection);
  const activeProvider = String(
    selection?.provider
      ?? globalDocument.namespaces?.["default-model"]?.selection?.provider
      ?? ""
  ).trim();
  const routing = project.namespaces?.["agent-routing"];
  for (const reference of Object.values(routing?.modelTiers ?? {})) {
    if (reference?.provider === activeProvider) references.push(reference);
  }
  if (routing?.vision?.model?.provider === activeProvider) references.push(routing.vision.model);
  return references;
}

/** @param {Record<string, any>} result */
function assertMutationResult(result) {
  if (result?.ok !== false) return;
  throw Object.assign(new Error(result.error ?? "模型配置更新失败"), {
    status: result.status ?? 400,
    code: result.code ?? "CONFIG_V2_MUTATION_FAILED"
  });
}

/** @param {unknown} value */
function explicitScope(value) {
  const scope = String(value ?? "").trim().toLowerCase();
  if (scope !== "global" && scope !== "project") {
    throw Object.assign(new TypeError("scope 必须明确指定为 global 或 project"), {
      code: "CONFIG_V2_SCOPE_REQUIRED"
    });
  }
  return scope;
}

/** @param {unknown} value @param {string} name */
function requiredRevision(value, name) {
  const revision = String(value ?? "").trim();
  if (!revision) {
    throw Object.assign(new TypeError(`${name} 是必填项`), {
      code: "CONFIG_V2_REVISION_REQUIRED"
    });
  }
  return revision;
}

/** @param {unknown} value @param {string} name */
function requiredIdentifier(value, name) {
  const identifier = String(value ?? "").trim();
  if (!identifier) {
    throw Object.assign(new TypeError(`${name} 是必填项`), {
      code: "CONFIG_V2_IDENTIFIER_REQUIRED"
    });
  }
  return identifier;
}

/** @param {unknown} value */
function revisionValue(value) {
  const revision = String(value ?? "").trim();
  return revision || null;
}

/** @param {string} scope @param {string} settingsRevision @param {string} credentialsRevision */
function revisionResult(scope, settingsRevision, credentialsRevision) {
  return {
    [scope]: settingsRevision,
    credentials: credentialsRevision
  };
}

/** @param {any} value */
function clonePublicValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}
