import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const TRUST_FILE = "workspace-trust.json";
const SALT_FILE = "workspace-trust.salt";

type TrustRecord = {
  workspaceId: string;
  displayPath: string;
  createdAt: unknown;
  lastUsedAt: unknown;
  antCodeVersion: unknown;
  profile: unknown;
};

type TrustStore = {
  version: number;
  records: Record<string, TrustRecord>;
};

/**
 * @param {{ cwd: string; env?: NodeJS.ProcessEnv; sensitivity?: string }} options
 */
export async function resolveWorkspaceTrust(options: { cwd: string; env?: NodeJS.ProcessEnv; sensitivity?: string }) {
  const workspacePath = await resolveWorkspacePath(options.cwd);
  const store = await readTrustStore(options.env);
  const workspaceId = await workspaceIdFor(workspacePath, options.env);
  const record = store.records[workspaceId] ?? null;
  const requiresPerProcessConfirmation = options.sensitivity === "high";

  return {
    trusted: Boolean(record) && !requiresPerProcessConfirmation,
    requiresPerProcessConfirmation,
    workspaceId,
    displayPath: workspacePath,
    storePath: trustStorePath(options.env),
    record
  };
}

/**
 * @param {{ cwd: string; env?: NodeJS.ProcessEnv; version?: string; profile?: string; now?: () => string }} options
 */
export async function trustWorkspace(options: { cwd: string; env?: NodeJS.ProcessEnv; version?: string; profile?: string; now?: () => string }) {
  const now = options.now ?? (() => new Date().toISOString());
  const workspacePath = await resolveWorkspacePath(options.cwd);
  const workspaceId = await workspaceIdFor(workspacePath, options.env);
  const store = await readTrustStore(options.env);
  const existing = store.records[workspaceId];
  const timestamp = now();
  store.records[workspaceId] = {
    workspaceId,
    displayPath: workspacePath,
    createdAt: existing?.createdAt ?? timestamp,
    lastUsedAt: timestamp,
    antCodeVersion: options.version ?? existing?.antCodeVersion ?? "unknown",
    profile: options.profile ?? existing?.profile ?? "default"
  };
  await writeTrustStore(store, options.env);
  return store.records[workspaceId];
}

/**
 * @param {{ cwd: string; env?: NodeJS.ProcessEnv }} options
 */
export async function revokeWorkspaceTrust(options: { cwd: string; env?: NodeJS.ProcessEnv }) {
  const workspacePath = await resolveWorkspacePath(options.cwd);
  const workspaceId = await workspaceIdFor(workspacePath, options.env);
  const store = await readTrustStore(options.env);
  const existed = Boolean(store.records[workspaceId]);
  delete store.records[workspaceId];
  await writeTrustStore(store, options.env);
  return { workspaceId, revoked: existed };
}

/**
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 */
export async function listTrustedWorkspaces(options: { env?: NodeJS.ProcessEnv } = {}) {
  const store = await readTrustStore(options.env);
  return Object.values(store.records)
    .sort((left, right) => String(right.lastUsedAt).localeCompare(String(left.lastUsedAt)))
    .map((record) => ({ ...record }));
}

/**
 * @param {NodeJS.ProcessEnv | undefined} env
 */
export function trustStorePath(env: NodeJS.ProcessEnv | undefined = process.env) {
  return path.join(userConfigDir(env), TRUST_FILE);
}

/**
 * @param {NodeJS.ProcessEnv | undefined} env
 */
export function userConfigDir(env: NodeJS.ProcessEnv | undefined = process.env) {
  if (env.LAB_AGENT_HOME) {
    return path.resolve(env.LAB_AGENT_HOME);
  }
  if (process.platform === "win32") {
    return path.join(env.APPDATA || path.join(env.USERPROFILE || os.homedir(), "AppData", "Roaming"), "ant-code");
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), ".config"), "ant-code");
}

/**
 * @param {string} workspacePath
 * @param {NodeJS.ProcessEnv | undefined} env
 */
async function workspaceIdFor(workspacePath: string, env: NodeJS.ProcessEnv | undefined) {
  const salt = await readOrCreateSalt(env);
  return crypto.createHash("sha256").update(`${workspacePath}\0${salt}`).digest("hex");
}

/**
 * @param {string} cwd
 */
async function resolveWorkspacePath(cwd: string) {
  return fs.realpath(path.resolve(cwd)).catch(() => path.resolve(cwd));
}

/**
 * @param {NodeJS.ProcessEnv | undefined} env
 */
async function readTrustStore(env: NodeJS.ProcessEnv | undefined): Promise<TrustStore> {
  try {
    const text = await fs.readFile(trustStorePath(env), "utf8");
    const parsed = JSON.parse(text);
    return {
      version: 1,
      records: isPlainObject(parsed.records) ? parsed.records as Record<string, TrustRecord> : {}
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { version: 1, records: {} };
    }
    if (error instanceof SyntaxError) {
      return { version: 1, records: {} };
    }
    throw error;
  }
}

/**
 * @param {{ version: number; records: Record<string, any> }} store
 * @param {NodeJS.ProcessEnv | undefined} env
 */
async function writeTrustStore(store: TrustStore, env: NodeJS.ProcessEnv | undefined) {
  const filePath = trustStorePath(env);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, filePath);
}

/**
 * @param {NodeJS.ProcessEnv | undefined} env
 */
async function readOrCreateSalt(env: NodeJS.ProcessEnv | undefined) {
  const configDir = userConfigDir(env);
  const filePath = path.join(configDir, SALT_FILE);
  try {
    return (await fs.readFile(filePath, "utf8")).trim();
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
    await fs.mkdir(configDir, { recursive: true });
    const salt = crypto.randomBytes(16).toString("hex");
    await fs.writeFile(filePath, `${salt}\n`, "utf8");
    return salt;
  }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
