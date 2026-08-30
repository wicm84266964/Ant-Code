import fs from "node:fs/promises";
import path from "node:path";
import { createCredentialStore } from "../credentials/store.ts";
import { createFileRepository, ConfigRevisionConflictError } from "./file-repository.ts";
import { migrateV1Documents, stripLegacyModelFields } from "./migrate-v1.ts";
import {
  credentialsPath,
  globalLegacyConfigPath,
  globalMigrationMarkerPath,
  globalSettingsPath,
  projectLegacyConfigPath,
  projectMigrationMarkerPath,
  projectSettingsPath
} from "./paths.ts";
import { resolveSettingsLayers } from "./resolver.ts";
import { isV2SettingsDocument, validateSettingsDocument } from "./schema.ts";

const MIGRATION_MARKER_VERSION = 1;

type JsonObject = Record<string, unknown>;
type ScopeName = "global" | "project";
type FileRepository = ReturnType<typeof createFileRepository>;
type ConfigSnapshot = Awaited<ReturnType<FileRepository["read"]>>;
type CredentialStore = ReturnType<typeof createCredentialStore>;
type CodedError = Error & { code?: string; path?: unknown };

type MigrationRepositories = {
  globalLegacy: FileRepository;
  projectLegacy: FileRepository;
  globalSettings: FileRepository;
  projectSettings: FileRepository;
  globalMarker: FileRepository;
  projectMarker: FileRepository;
};

type MigrationSnapshots = {
  globalLegacy: ConfigSnapshot;
  projectLegacy: ConfigSnapshot;
  globalSettings: ConfigSnapshot;
  projectSettings: ConfigSnapshot;
  globalMarker: ConfigSnapshot;
  projectMarker: ConfigSnapshot;
};

type MigrationPaths = {
  globalLegacy: string;
  projectLegacy: string;
  globalSettings: string;
  projectSettings: string;
  credentials: string;
  globalMarker: string;
  projectMarker: string;
};

type CredentialPlanEntry = {
  reference: string;
  secret: string;
};

type MigrationBackup = {
  source: string;
  backup: string;
};

type ConfigV2Provider = JsonObject & {
  auth?: JsonObject & { mode?: unknown; ref?: unknown };
};

type ConfigV2Namespaces = JsonObject & {
  "model-providers"?: { providers?: Record<string, ConfigV2Provider> };
};

const EMPTY_OBJECT: JsonObject = {};
const EMPTY_PROVIDERS: Record<string, ConfigV2Provider> = {};

function asRecord(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : EMPTY_OBJECT;
}

/**
 * Move model configuration out of legacy composition documents. Every write
 * is revision checked and retryable: credentials are installed first, strict
 * settings second, legacy model fields are removed third, and a separate
 * marker is written only after the scope is complete.
 *
 * @param {{ cwd?: string; env?: NodeJS.ProcessEnv; dryRun?: boolean; backup?: boolean }} [options]
 */
export async function ensureConfigV2(options: { cwd?: string; env?: NodeJS.ProcessEnv; dryRun?: boolean; backup?: boolean } = {}) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  const paths = migrationPaths(cwd, env);
  assertDistinctScopePaths(paths);

  const repositories: MigrationRepositories = {
    globalLegacy: createFileRepository({ filePath: paths.globalLegacy }),
    projectLegacy: createFileRepository({ filePath: paths.projectLegacy }),
    globalSettings: createFileRepository({ filePath: paths.globalSettings }),
    projectSettings: createFileRepository({ filePath: paths.projectSettings }),
    globalMarker: createFileRepository({ filePath: paths.globalMarker }),
    projectMarker: createFileRepository({ filePath: paths.projectMarker })
  };
  const snapshots = await readMigrationSnapshots(repositories);
  assertSettingsSnapshot(snapshots.globalSettings, "global");
  assertSettingsSnapshot(snapshots.projectSettings, "project");

  const globalExists = snapshots.globalSettings.exists;
  const projectExists = snapshots.projectSettings.exists;
  const migrated = migrateV1Documents({
    globalDocument: globalExists ? snapshots.globalSettings.data : snapshots.globalLegacy.data,
    projectDocument: projectExists ? snapshots.projectSettings.data : snapshots.projectLegacy.data
  });
  const globalDocument = validateSettingsDocument(
    globalExists ? snapshots.globalSettings.data : migrated.globalDocument,
    { label: "global" }
  );
  const projectDocument = validateSettingsDocument(
    projectExists ? snapshots.projectSettings.data : migrated.projectDocument,
    { label: "project" }
  );
  resolveSettingsLayers({ global: globalDocument, project: projectDocument });

  const remainders = {
    global: stripLegacyModelFields(snapshots.globalLegacy.data),
    project: stripLegacyModelFields(snapshots.projectLegacy.data)
  };
  const legacyChanges = {
    global: snapshots.globalLegacy.exists
      && !sameJson(snapshots.globalLegacy.data, remainders.global),
    project: snapshots.projectLegacy.exists
      && !sameJson(snapshots.projectLegacy.data, remainders.project)
  };
  const changed = !globalExists || !projectExists || legacyChanges.global || legacyChanges.project;
  const credentialPath = paths.credentials;
  const credentialStore = createCredentialStore({ filePath: credentialPath });
  const credentialPlan = await planCredentialWrites(credentialStore, migrated.credentials);

  if (options.dryRun === true) {
    return migrationResult({
      changed,
      dryRun: true,
      paths,
      revisions: snapshotRevisions(snapshots, (await credentialStore.describeAll()).revision),
      backups: [],
      diagnostics: migrated.diagnostics,
      mapping: migrated.mapping,
      credentialRefs: Object.keys(migrated.credentials).sort(),
      credentialRefsCreated: credentialPlan.map((entry) => entry.reference),
      createdSettings: [
        ...(!globalExists ? [paths.globalSettings] : []),
        ...(!projectExists ? [paths.projectSettings] : [])
      ],
      createdMarkers: []
    });
  }

  if (!changed && credentialPlan.length === 0) {
    const credentials = await credentialStore.describeAll();
    return migrationResult({
      changed: false,
      dryRun: false,
      paths,
      revisions: snapshotRevisions(snapshots, credentials.revision),
      backups: [],
      diagnostics: [],
      mapping: { global: {}, project: {} },
      credentialRefs: [],
      credentialRefsCreated: [],
      createdSettings: [],
      createdMarkers: []
    });
  }

  const backups = options.backup === false
    ? []
    : await createMigrationBackups(snapshots, legacyChanges);

  for (const entry of credentialPlan) {
    await credentialStore.set(entry.reference, entry.secret);
  }

  const settingsWrites = {
    global: globalExists
      ? { revision: snapshots.globalSettings.revision }
      : await repositories.globalSettings.replace(asRecord(globalDocument), {
          expectedRevision: snapshots.globalSettings.revision
        }),
    project: projectExists
      ? { revision: snapshots.projectSettings.revision }
      : await repositories.projectSettings.replace(asRecord(projectDocument), {
          expectedRevision: snapshots.projectSettings.revision
        })
  };
  const legacyWrites = {
    global: legacyChanges.global
      ? await repositories.globalLegacy.replace(remainders.global, {
          expectedRevision: snapshots.globalLegacy.revision
        })
      : { revision: snapshots.globalLegacy.revision },
    project: legacyChanges.project
      ? await repositories.projectLegacy.replace(remainders.project, {
          expectedRevision: snapshots.projectLegacy.revision
        })
      : { revision: snapshots.projectLegacy.revision }
  };

  const migrationId = migrationIdentifier(
    snapshots.globalLegacy.revision,
    snapshots.projectLegacy.revision,
    settingsWrites.global.revision,
    settingsWrites.project.revision
  );
  const createdMarkers: string[] = [];
  for (const scope of ["global", "project"] as const) {
    const scopeSettingsExisted = scope === "global" ? globalExists : projectExists;
    if (scopeSettingsExisted && !legacyChanges[scope]) continue;
    const markerRepository = scope === "global" ? repositories.globalMarker : repositories.projectMarker;
    const markerSnapshot = scope === "global" ? snapshots.globalMarker : snapshots.projectMarker;
    const settingsPath = scope === "global" ? paths.globalSettings : paths.projectSettings;
    const legacyPath = scope === "global" ? paths.globalLegacy : paths.projectLegacy;
    const markerPath = scope === "global" ? paths.globalMarker : paths.projectMarker;
    await markerRepository.replace({
      markerVersion: MIGRATION_MARKER_VERSION,
      migrationId,
      scope,
      source: { path: legacyPath, revision: snapshots[`${scope}Legacy`].revision },
      settings: { path: settingsPath, revision: settingsWrites[scope].revision },
      remainderRevision: legacyWrites[scope].revision,
      mapping: migrated.mapping[scope],
      credentialRefs: ownedCredentialReferences(asRecord(scope === "global" ? globalDocument : projectDocument))
    }, { expectedRevision: markerSnapshot.revision });
    if (!markerSnapshot.exists) createdMarkers.push(markerPath);
  }

  const credentialDescriptor = await credentialStore.describeAll();
  return migrationResult({
    changed: true,
    dryRun: false,
    paths,
    revisions: {
      global: settingsWrites.global.revision,
      project: settingsWrites.project.revision,
      credentials: credentialDescriptor.revision
    },
    backups,
    diagnostics: migrated.diagnostics,
    mapping: migrated.mapping,
    credentialRefs: Object.keys(migrated.credentials).sort(),
    credentialRefsCreated: credentialPlan.map((entry) => entry.reference),
    createdSettings: [
      ...(!globalExists ? [paths.globalSettings] : []),
      ...(!projectExists ? [paths.projectSettings] : [])
    ],
    createdMarkers
  });
}

/**
 * Explicitly undo one ensureConfigV2 result. Only exact paths returned by the
 * migration are accepted; unrelated credentials and settings are untouched.
 *
 * @param {Record<string, any>} input
 */
export async function rollbackConfigV2(input: Record<string, unknown>) {
  const backups = Array.isArray(input?.backups) ? input.backups : [];
  if (backups.length === 0 && !Array.isArray(input?.createdSettings)) {
    throw new Error("Config V2 rollback requires an explicit migration result");
  }
  for (const entry of backups) {
    const item = asRecord(entry);
    const source = path.resolve(String(item.source ?? ""));
    const backup = path.resolve(String(item.backup ?? ""));
    if (!source || !backup || path.dirname(source) !== path.dirname(backup)) {
      throw new Error("Config V2 backup must be beside its source document");
    }
    const data: unknown = JSON.parse(await fs.readFile(backup, "utf8"));
    await createFileRepository({ filePath: source }).replace(data as JsonObject);
  }

  const credentialPath = String(asRecord(input.paths).credentials ?? "").trim();
  const credentialRefs = Array.isArray(input?.credentialRefsCreated)
    ? input.credentialRefsCreated
    : [];
  if (credentialRefs.length > 0) {
    if (!credentialPath) throw new Error("Config V2 rollback is missing the credential path");
    const store = createCredentialStore({ filePath: credentialPath });
    for (const reference of credentialRefs) await store.clear(reference as string);
  }
  for (const filePath of [
    ...(Array.isArray(input?.createdSettings) ? input.createdSettings : []),
    ...(Array.isArray(input?.createdMarkers) ? input.createdMarkers : [])
  ]) {
    await fs.rm(path.resolve(String(filePath)), { force: true });
  }
  return {
    ok: true,
    restored: backups.map((entry) => asRecord(entry).source),
    removedSettings: input.createdSettings ?? [],
    removedCredentialRefs: credentialRefs
  };
}

/** @param {string} cwd @param {NodeJS.ProcessEnv} env */
function migrationPaths(cwd: string, env: NodeJS.ProcessEnv): MigrationPaths {
  return {
    globalLegacy: globalLegacyConfigPath(env),
    projectLegacy: projectLegacyConfigPath(cwd),
    globalSettings: globalSettingsPath(env),
    projectSettings: projectSettingsPath(cwd),
    credentials: credentialsPath(env),
    globalMarker: globalMigrationMarkerPath(env),
    projectMarker: projectMigrationMarkerPath(cwd)
  };
}

/** @param {Record<string, string>} paths */
function assertDistinctScopePaths(paths: MigrationPaths) {
  if (samePath(paths.globalSettings, paths.projectSettings)) {
    const error: CodedError = new Error("Global and project Config V2 settings paths must be distinct");
    error.code = "CONFIG_V2_SCOPE_PATH_CONFLICT";
    throw error;
  }
}

/** @param {Record<string, any>} repositories */
async function readMigrationSnapshots(repositories: MigrationRepositories): Promise<MigrationSnapshots> {
  const entries = await Promise.all(Object.entries(repositories).map(async ([name, repository]) => (
    [name, await repository.read()] as const
  )));
  return Object.fromEntries(entries) as MigrationSnapshots;
}

/** @param {Record<string, any>} snapshot @param {string} scope */
function assertSettingsSnapshot(snapshot: ConfigSnapshot, scope: string) {
  if (snapshot.exists && !isV2SettingsDocument(snapshot.data)) {
    const error: CodedError = new Error(`${scope} settings.json is not a valid Config V2 document`);
    error.code = "CONFIG_V2_INVALID_SETTINGS_FILE";
    error.path = snapshot.path;
    throw error;
  }
}

/** @param {ReturnType<typeof createCredentialStore>} store @param {Record<string, string>} credentials */
async function planCredentialWrites(store: CredentialStore, credentials: Record<string, string>) {
  const plan: CredentialPlanEntry[] = [];
  for (const [reference, secret] of Object.entries(credentials)) {
    const current = await store.resolve(reference);
    if (current === undefined) {
      plan.push({ reference, secret });
      continue;
    }
    if (current !== secret) {
      const error: CodedError = new Error(`Credential reference ${reference} already contains a different value`);
      error.code = "CONFIG_V2_CREDENTIAL_CONFLICT";
      throw error;
    }
  }
  return plan;
}

/** @param {Record<string, any>} snapshots @param {Record<string, boolean>} changes */
async function createMigrationBackups(snapshots: MigrationSnapshots, changes: Record<ScopeName, boolean>) {
  const backups: MigrationBackup[] = [];
  for (const scope of ["global", "project"] as const) {
    if (!changes[scope]) continue;
    const snapshot = snapshots[`${scope}Legacy`];
    const backup = `${snapshot.path}.v1-backup-${snapshot.revision.slice(0, 12)}`;
    try {
      await fs.copyFile(snapshot.path, backup, fs.constants.COPYFILE_EXCL);
      await fs.chmod(backup, 0o600).catch(() => {});
    } catch (error) {
      if (asRecord(error).code !== "EEXIST") throw error;
    }
    backups.push({ source: snapshot.path, backup });
  }
  return backups;
}

/** @param {Record<string, any>} document */
function ownedCredentialReferences(document: JsonObject) {
  const namespaces = asRecord(document.namespaces) as ConfigV2Namespaces;
  const providers = namespaces["model-providers"]?.providers ?? EMPTY_PROVIDERS;
  return Object.values(providers)
    .filter((provider) => provider?.auth?.mode === "credential")
    .map((provider) => provider.auth!.ref)
    .sort();
}

/** @param {Record<string, any>} snapshots @param {string} credentialRevision */
function snapshotRevisions(snapshots: MigrationSnapshots, credentialRevision: string) {
  return {
    global: snapshots.globalSettings.revision,
    project: snapshots.projectSettings.revision,
    credentials: credentialRevision
  };
}

/** @param {...string} revisions */
function migrationIdentifier(...revisions: string[]) {
  return `v1-${revisions.map((revision) => revision.slice(0, 12)).join("-")}`;
}

/** @param {unknown} left @param {unknown} right */
function sameJson(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** @param {string} left @param {string} right */
function samePath(left: string, right: string) {
  const normalize = (value: string) => path.resolve(value).replace(/\\/g, "/").toLowerCase();
  return normalize(left) === normalize(right);
}

/** @param {Record<string, any>} value */
function migrationResult(value: JsonObject) {
  return { ok: true, ...value };
}

export { ConfigRevisionConflictError };
