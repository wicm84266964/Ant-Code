import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const CONFIG_LOCK_TIMEOUT_MS = 5_000;
const CONFIG_LOCK_RETRY_MS = 20;
const CONFIG_LOCK_STALE_MS = 30_000;
/** @type {Map<string, Promise<any>>} */
const inProcessLocks = new Map();

export class ConfigRevisionConflictError extends Error {
  constructor() {
    super("Configuration changed while it was being saved");
    this.name = "ConfigRevisionConflictError";
    this.code = "CONFIG_REVISION_CONFLICT";
    this.status = 409;
  }
}

/**
 * Serialize a read-modify-write cycle in this process and across cooperating
 * Ant Code processes, then replace the JSON file atomically.
 *
 * @param {string} filePath
 * @param {(data: Record<string, any>, context: { revision: string }) => Record<string, any> | Promise<Record<string, any>>} update
 */
export async function mutateJsonConfig(filePath, update) {
  const target = path.resolve(filePath);
  return withInProcessConfigLock(target, async () => {
    const releaseFileLock = await acquireConfigFileLock(target);
    try {
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
    } finally {
      await releaseFileLock();
    }
  });
}

/**
 * @param {string} filePath
 */
export async function readJsonConfigSnapshot(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(text);
    return {
      data: isPlainObject(parsed) ? parsed : {},
      revision: configRevision(text),
      exists: true
    };
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error)?.code === "ENOENT") {
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
export async function atomicWriteJsonConfig(filePath, data, options = {}) {
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
function withInProcessConfigLock(key, operation) {
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
async function acquireConfigFileLock(filePath) {
  const lockPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.ant-code.lock`);
  const deadline = Date.now() + CONFIG_LOCK_TIMEOUT_MS;
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  for (;;) {
    try {
      const handle = await fs.open(lockPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, "utf8");
      await handle.sync();
      return async () => {
        await handle.close().catch(() => {});
        await fs.rm(lockPath, { force: true }).catch(() => {});
      };
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error)?.code !== "EEXIST") {
        throw error;
      }
      const stat = await fs.stat(lockPath).catch(() => null);
      if (stat && await isAbandonedConfigLock(lockPath, stat)) {
        await fs.rm(lockPath, { force: true }).catch(() => {});
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
 */
async function isAbandonedConfigLock(lockPath, stat) {
  if (Date.now() - stat.mtimeMs <= CONFIG_LOCK_STALE_MS) {
    return false;
  }
  const owner = await fs.readFile(lockPath, "utf8")
    .then((text) => JSON.parse(text))
    .catch(() => null);
  const pid = Number(owner?.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    return true;
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error)?.code === "ESRCH";
  }
}

/** @param {string} directory */
async function syncDirectory(directory) {
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
function isUnsupportedDirectorySync(error) {
  return ["EACCES", "EBADF", "EINVAL", "ENOTSUP", "EPERM"].includes(
    /** @type {NodeJS.ErrnoException} */ (error)?.code ?? ""
  );
}

/** @param {string} text */
function configRevision(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** @param {Record<string, any>} value */
function cloneConfig(value) {
  return JSON.parse(JSON.stringify(value ?? {}));
}

/** @param {unknown} value */
function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** @param {number} ms */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
