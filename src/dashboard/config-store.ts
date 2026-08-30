import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const CONFIG_LOCK_TIMEOUT_MS = 5_000;
const CONFIG_LOCK_RETRY_MS = 20;
const CONFIG_LOCK_STALE_MS = 30_000;
const inProcessLocks = new Map<string, Promise<unknown>>();

export class ConfigRevisionConflictError extends Error {
  code = "CONFIG_REVISION_CONFLICT";
  status = 409;
  constructor() {
    super("Configuration changed while it was being saved");
    this.name = "ConfigRevisionConflictError";
  }
}

/**
 * Serialize a read-modify-write cycle in this process and across cooperating
 * Ant Code processes, then replace the JSON file atomically.
 *
 * @param {string} filePath
 * @param {(data: Record<string, any>, context: { revision: string }) => Record<string, any> | Promise<Record<string, any>>} update
 */
export async function mutateJsonConfig(filePath: string, update: (data: Record<string, unknown>, context: { revision: string }) => Record<string, unknown> | Promise<Record<string, unknown>>) {
  const target = path.resolve(filePath);
  return withConfigMutationLock(target, async () => {
    const snapshot = await readJsonConfigSnapshot(target);
    const next = await update(cloneConfig(snapshot.data), { revision: snapshot.revision });
    if (!isPlainObject(next)) {
      throw new TypeError("Configuration update must return a JSON object");
    }
    const written = await atomicWriteJsonConfig(target, next, {
      expectedRevision: snapshot.revision
    });
    return {
      data: next,
      previousRevision: snapshot.revision,
      revision: written.revision,
      path: target
    };
  });
}

/**
 * Serialize a configuration transaction in this process and across
 * cooperating Ant Code processes. The target names the lock domain and does
 * not need to be a file that is itself written by the operation.
 *
 * @template T
 * @param {string} filePath
 * @param {() => Promise<T>} operation
 * @returns {Promise<T>}
 */
export function withConfigMutationLock<T>(filePath: string, operation: () => Promise<T>) {
  const target = path.resolve(filePath);
  return withInProcessConfigLock(target, async () => {
    const releaseFileLock = await acquireConfigFileLock(target);
    try {
      return await operation();
    } finally {
      await releaseFileLock();
    }
  });
}

/**
 * @param {string} filePath
 */
export async function readJsonConfigSnapshot(filePath: string) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(text);
    return {
      data: isPlainObject(parsed) ? parsed : {},
      revision: configRevision(text),
      exists: true
    };
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return { data: {}, revision: "missing", exists: false };
    }
    throw error;
  }
}

/**
 * @param {string} filePath
 * @param {Record<string, any>} data
 * @param {{ expectedRevision?: string }} [options]
 */
export async function atomicWriteJsonConfig(filePath: string, data: Record<string, unknown>, options: { expectedRevision?: string } = {}) {
  const target = path.resolve(filePath);
  const directory = path.dirname(target);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const serialized = `${JSON.stringify(data, null, 2)}\n`;
  const temporaryPath = path.join(
    directory,
    `.${path.basename(target)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  );
  let handle;
  try {
    handle = await fs.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;

    if (options.expectedRevision !== undefined) {
      const current = await readJsonConfigSnapshot(target);
      if (current.revision !== options.expectedRevision) {
        throw new ConfigRevisionConflictError();
      }
    }

    await fs.rename(temporaryPath, target);
    await fs.chmod(target, 0o600).catch(() => {});
    await syncDirectory(directory);
    return { revision: configRevision(serialized), path: target };
  } finally {
    await handle?.close().catch(() => {});
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

/**
 * @template T
 * @param {string} key
 * @param {() => Promise<T>} operation
 * @returns {Promise<T>}
 */
function withInProcessConfigLock<T>(key: string, operation: () => Promise<T>) {
  const previous = inProcessLocks.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  inProcessLocks.set(key, current);
  return current.finally(() => {
    if (inProcessLocks.get(key) === current) {
      inProcessLocks.delete(key);
    }
  });
}

/**
 * @param {string} filePath
 * @returns {Promise<() => Promise<void>>}
 */
async function acquireConfigFileLock(filePath: string) {
  const lockPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.ant-code.lock`);
  const deadline = Date.now() + CONFIG_LOCK_TIMEOUT_MS;
  const token = `${process.pid}-${randomBytes(12).toString("hex")}`;
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  for (;;) {
    try {
      const handle = await fs.open(lockPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() })}\n`, "utf8");
      await handle.sync();
      return async () => {
        await handle.close().catch(() => {});
        const owner = await readConfigLockOwner(lockPath);
        if (owner?.token === token) {
          await fs.rm(lockPath, { force: true }).catch(() => {});
        }
      };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        throw error;
      }
      const stat = await fs.stat(lockPath).catch(() => null);
      const observedOwner = stat ? await readConfigLockOwner(lockPath) : null;
      if (stat && await isAbandonedConfigLock(lockPath, stat, observedOwner)) {
        const observedFingerprint = configLockFingerprint(observedOwner, stat);
        const quarantinePath = `${lockPath}.stale.${process.pid}.${randomBytes(8).toString("hex")}`;
        try {
          await fs.rename(lockPath, quarantinePath);
          const [quarantinedOwner, quarantinedStat] = await Promise.all([
            readConfigLockOwner(quarantinePath),
            fs.stat(quarantinePath)
          ]);
          if (configLockFingerprint(quarantinedOwner, quarantinedStat) !== observedFingerprint) {
            await restoreQuarantinedConfigLock(lockPath, quarantinePath);
            continue;
          }
          await fs.rm(quarantinePath, { force: true });
        } catch (reclaimError) {
          const reclaimCode = errorCode(reclaimError);
          if (reclaimCode !== "ENOENT" && reclaimCode !== "EEXIST") {
            throw reclaimError;
          }
        }
        continue;
      }
      if (Date.now() >= deadline) {
        const timeout = Object.assign(new Error("Timed out waiting for the configuration lock"), {
          code: "CONFIG_LOCK_TIMEOUT",
          status: 409
        });
        throw timeout;
      }
      await delay(CONFIG_LOCK_RETRY_MS);
    }
  }
}

/**
 * @param {string} lockPath
 * @param {import("node:fs").Stats} stat
 * @param {Record<string, any> | null} owner
 */
async function isAbandonedConfigLock(lockPath: string, stat: import("node:fs").Stats, owner: Record<string, unknown> | null) {
  if (Date.now() - stat.mtimeMs <= CONFIG_LOCK_STALE_MS) {
    return false;
  }
  const pid = Number(owner?.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    return true;
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return errorCode(error) === "ESRCH";
  }
}

/**
 * @param {Record<string, any> | null} owner
 * @param {import("node:fs").Stats} stat
 */
function configLockFingerprint(owner: Record<string, unknown> | null, stat: import("node:fs").Stats) {
  const token = String(owner?.token ?? "").trim();
  if (token) {
    return `token:${token}`;
  }
  return [
    "legacy",
    Number(owner?.pid) || 0,
    String(owner?.createdAt ?? ""),
    Number(stat.dev) || 0,
    Number(stat.ino) || 0,
    stat.size,
    stat.mtimeMs
  ].join(":");
}

/** @param {string} lockPath @param {string} quarantinePath */
async function restoreQuarantinedConfigLock(lockPath: string, quarantinePath: string) {
  try {
    await fs.rename(quarantinePath, lockPath);
  } catch (error) {
    const conflict = Object.assign(new Error("Configuration lock changed during stale-lock reclamation"), {
      code: "CONFIG_LOCK_RECLAIM_RACE",
      status: 409,
      cause: error
    });
    throw conflict;
  }
}

/** @param {string} lockPath */
async function readConfigLockOwner(lockPath: string) {
  return fs.readFile(lockPath, "utf8")
    .then((text: string) => JSON.parse(text))
    .catch(() => null);
}

/** @param {string} directory */
async function syncDirectory(directory: string) {
  let handle;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (!isUnsupportedDirectorySync(error)) {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** @param {unknown} error */
function isUnsupportedDirectorySync(error: unknown) {
  const code = errorCode(error);
  return code === "EACCES"
    || code === "EBADF"
    || code === "EINVAL"
    || code === "ENOTSUP"
    || code === "EPERM";
}

/** @param {string} text */
function configRevision(text: string) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** @param {Record<string, any>} value */
function cloneConfig(value: unknown) {
  return JSON.parse(JSON.stringify(value ?? {}));
}

/** @param {unknown} value */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function errorCode(error: unknown): unknown {
  return error && typeof error === "object" && "code" in error ? error.code : undefined;
}

/** @param {number} ms */
function delay(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
