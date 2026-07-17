import { randomBytes } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_RETRY_MS = 20;
const DEFAULT_LOCK_STALE_MS = 30_000;
const inProcessLocks = new Map();

/**
 * Replace one file only after its complete contents are durable.
 *
 * @param {string} filePath
 * @param {string | Uint8Array} data
 * @param {{ encoding?: BufferEncoding; mode?: number; directoryMode?: number }} [options]
 */
export async function atomicWriteFile(filePath, data, options = {}) {
  const target = path.resolve(filePath);
  const directory = path.dirname(target);
  const mode = options.mode ?? 0o600;
  await fs.mkdir(directory, { recursive: true, mode: options.directoryMode ?? 0o700 });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(target)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  );
  let handle = null;
  try {
    handle = await fs.open(temporaryPath, "wx", mode);
    await handle.writeFile(data, typeof data === "string" ? options.encoding ?? "utf8" : undefined);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporaryPath, target);
    await fs.chmod(target, mode).catch(() => {});
    await syncDirectory(directory);
    return target;
  } finally {
    await handle?.close().catch(() => {});
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

/**
 * Synchronous atomic replacement for state registries whose public API is
 * intentionally synchronous.
 *
 * @param {string} filePath
 * @param {string | Uint8Array} data
 * @param {{ encoding?: BufferEncoding; mode?: number; directoryMode?: number }} [options]
 */
export function atomicWriteFileSync(filePath, data, options = {}) {
  const target = path.resolve(filePath);
  const directory = path.dirname(target);
  const mode = options.mode ?? 0o600;
  fsSync.mkdirSync(directory, { recursive: true, mode: options.directoryMode ?? 0o700 });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(target)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  );
  let handle = null;
  try {
    handle = fsSync.openSync(temporaryPath, "wx", mode);
    fsSync.writeFileSync(
      handle,
      data,
      typeof data === "string" ? { encoding: options.encoding ?? "utf8" } : undefined
    );
    fsSync.fsyncSync(handle);
    fsSync.closeSync(handle);
    handle = null;
    fsSync.renameSync(temporaryPath, target);
    try {
      fsSync.chmodSync(target, mode);
    } catch {
      // Windows and restricted filesystems may not support chmod semantics.
    }
    syncDirectorySync(directory);
    return target;
  } finally {
    if (handle !== null) {
      try {
        fsSync.closeSync(handle);
      } catch {
        // The descriptor may already be closed after a partial failure.
      }
    }
    try {
      fsSync.rmSync(temporaryPath, { force: true });
    } catch {
      // Preserve the original write error.
    }
  }
}

/**
 * Serialize a mutation in this process and across cooperating processes.
 *
 * @template T
 * @param {string} filePath
 * @param {() => Promise<T>} operation
 * @param {{ timeoutMs?: number; retryMs?: number; staleMs?: number }} [options]
 * @returns {Promise<T>}
 */
export function withFileMutationLock(filePath, operation, options = {}) {
  const key = path.resolve(filePath).toLowerCase();
  const previous = inProcessLocks.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(async () => {
    const release = await acquireFileMutationLock(filePath, options);
    try {
      return await operation();
    } finally {
      await release();
    }
  });
  inProcessLocks.set(key, current);
  return current.finally(() => {
    if (inProcessLocks.get(key) === current) {
      inProcessLocks.delete(key);
    }
  });
}

/**
 * Resolve a store directory and reject junction/symlink escapes from its workspace.
 *
 * @param {string} workspace
 * @param {string} directory
 * @param {{ mode?: number }} [options]
 */
export async function ensureContainedDirectory(workspace, directory, options = {}) {
  const workspacePath = path.resolve(workspace);
  const target = path.resolve(directory);
  if (!isPathInside(workspacePath, target)) {
    throw storagePathError(target);
  }
  const workspaceReal = await fs.realpath(workspacePath);
  await fs.mkdir(target, { recursive: true, mode: options.mode ?? 0o700 });
  const targetReal = await fs.realpath(target);
  if (!isPathInside(workspaceReal, targetReal)) {
    throw storagePathError(targetReal);
  }
  return targetReal;
}

/**
 * Resolve an existing path and keep it below a canonical store directory.
 *
 * @param {string} storeDirectory
 * @param {string} candidate
 */
export async function resolveContainedPath(storeDirectory, candidate) {
  const rootReal = await fs.realpath(storeDirectory);
  const candidateReal = await fs.realpath(path.resolve(candidate));
  if (!isPathInside(rootReal, candidateReal) || candidateReal === rootReal) {
    throw storagePathError(candidateReal);
  }
  return candidateReal;
}

async function acquireFileMutationLock(filePath, options) {
  const target = path.resolve(filePath);
  const lockPath = path.join(path.dirname(target), `.${path.basename(target)}.ant-code.lock`);
  const timeoutMs = positiveNumber(options.timeoutMs, DEFAULT_LOCK_TIMEOUT_MS);
  const retryMs = positiveNumber(options.retryMs, DEFAULT_LOCK_RETRY_MS);
  const staleMs = positiveNumber(options.staleMs, DEFAULT_LOCK_STALE_MS);
  const deadline = Date.now() + timeoutMs;
  const token = `${process.pid}-${randomBytes(12).toString("hex")}`;
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });

  for (;;) {
    try {
      await fs.mkdir(lockPath, { mode: 0o700 });
      try {
        const owner = {
          token,
          pid: process.pid,
          hostname: os.hostname(),
          createdAt: new Date().toISOString()
        };
        const ownerHandle = await fs.open(path.join(lockPath, "owner.json"), "wx", 0o600);
        try {
          await ownerHandle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
          await ownerHandle.sync();
        } finally {
          await ownerHandle.close().catch(() => {});
        }
      } catch (error) {
        await fs.rm(lockPath, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      return () => releaseOwnedLock(lockPath, token);
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      if (await isAbandonedLock(lockPath, staleMs)) {
        const quarantine = `${lockPath}.stale.${process.pid}.${randomBytes(8).toString("hex")}`;
        try {
          await fs.rename(lockPath, quarantine);
          await fs.rm(quarantine, { recursive: true, force: true });
          continue;
        } catch (reclaimError) {
          if (!["ENOENT", "EEXIST"].includes(reclaimError?.code ?? "")) {
            throw reclaimError;
          }
        }
      }
      if (Date.now() >= deadline) {
        const timeout = new Error(`Timed out waiting for storage lock: ${target}`);
        timeout.code = "STORAGE_LOCK_TIMEOUT";
        throw timeout;
      }
      await delay(retryMs);
    }
  }
}

async function releaseOwnedLock(lockPath, token) {
  const owner = await readLockOwner(lockPath);
  if (owner?.token !== token) {
    return;
  }
  const released = `${lockPath}.released.${process.pid}.${randomBytes(8).toString("hex")}`;
  try {
    await fs.rename(lockPath, released);
    await fs.rm(released, { recursive: true, force: true });
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

async function isAbandonedLock(lockPath, staleMs) {
  const stat = await fs.stat(lockPath).catch(() => null);
  if (!stat) {
    return false;
  }
  const owner = await readLockOwner(lockPath);
  const pid = Number(owner?.pid);
  const validPid = Number.isInteger(pid) && pid > 0;
  const hostname = String(owner?.hostname ?? os.hostname());
  if (validPid && hostname === os.hostname()) {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      if (error?.code === "ESRCH") {
        return true;
      }
      return false;
    }
  }
  if (Date.now() - stat.mtimeMs <= staleMs) {
    return false;
  }
  if (!validPid) {
    return true;
  }
  return false;
}

async function readLockOwner(lockPath) {
  return fs.readFile(path.join(lockPath, "owner.json"), "utf8")
    .then((text) => JSON.parse(text))
    .catch(() => null);
}

async function syncDirectory(directory) {
  let handle = null;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (!["EACCES", "EBADF", "EINVAL", "ENOTSUP", "EPERM"].includes(error?.code ?? "")) {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => {});
  }
}

function syncDirectorySync(directory) {
  let handle = null;
  try {
    handle = fsSync.openSync(directory, "r");
    fsSync.fsyncSync(handle);
  } catch (error) {
    if (!["EACCES", "EBADF", "EINVAL", "ENOTSUP", "EPERM"].includes(error?.code ?? "")) {
      throw error;
    }
  } finally {
    if (handle !== null) {
      try {
        fsSync.closeSync(handle);
      } catch {
        // The directory descriptor may not be closeable on this platform.
      }
    }
  }
}

function isPathInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function storagePathError(filePath) {
  const error = new Error(`Storage path escapes the workspace: ${filePath}`);
  error.code = "STORAGE_PATH_OUTSIDE_WORKSPACE";
  return error;
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
