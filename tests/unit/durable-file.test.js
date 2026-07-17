import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { atomicWriteFileSync, withFileMutationLock } from "../../src/storage/durable-file.js";

test("synchronous atomic writes preserve the committed file after a partial write failure", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "durable-file-sync-"));
  const file = path.join(root, "registry.json");
  atomicWriteFileSync(file, "committed\n");

  const originalWriteFileSync = fsSync.writeFileSync;
  fsSync.writeFileSync = (handle, _data, options) => {
    originalWriteFileSync(handle, "partial", options);
    throw new Error("fault injection after partial write");
  };
  try {
    assert.throws(
      () => atomicWriteFileSync(file, "replacement\n"),
      /fault injection after partial write/
    );
  } finally {
    fsSync.writeFileSync = originalWriteFileSync;
  }

  assert.equal(await fs.readFile(file, "utf8"), "committed\n");
  assert.deepEqual((await fs.readdir(root)).filter((name) => name.endsWith(".tmp")), []);
});
test("fresh same-host lock from an exited process is reclaimed without the stale delay", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "durable-file-dead-lock-"));
  const file = path.join(root, "registry.json");
  const lockDirectory = path.join(root, ".registry.json.ant-code.lock");
  const child = spawn(process.execPath, ["-e", ""], { windowsHide: true });
  const childPid = child.pid;
  await once(child, "exit");
  assert.equal(Number.isInteger(childPid), true);

  await fs.mkdir(lockDirectory);
  await fs.writeFile(path.join(lockDirectory, "owner.json"), JSON.stringify({
    token: "exited-owner",
    pid: childPid,
    hostname: os.hostname(),
    createdAt: new Date().toISOString()
  }) + "\n");

  const startedAt = Date.now();
  const result = await withFileMutationLock(file, async () => "recovered");

  assert.equal(result, "recovered");
  assert.ok(Date.now() - startedAt < 2_000);
  await assert.rejects(fs.stat(lockDirectory), { code: "ENOENT" });
});

test("owner initialization failure removes the newly created lock directory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "durable-file-owner-failure-"));
  const file = path.join(root, "registry.json");
  const lockDirectory = path.join(root, ".registry.json.ant-code.lock");
  const originalOpen = fs.open;
  let injected = false;
  let operationCalled = false;
  fs.open = async (target, ...args) => {
    if (!injected && path.basename(String(target)) === "owner.json") {
      injected = true;
      const error = new Error("fault injection during owner initialization");
      error.code = "EIO";
      throw error;
    }
    return originalOpen(target, ...args);
  };
  try {
    await assert.rejects(
      withFileMutationLock(file, async () => {
        operationCalled = true;
      }),
      /fault injection during owner initialization/
    );
  } finally {
    fs.open = originalOpen;
  }

  assert.equal(injected, true);
  assert.equal(operationCalled, false);
  await assert.rejects(fs.stat(lockDirectory), { code: "ENOENT" });
  assert.equal(await withFileMutationLock(file, async () => "recovered"), "recovered");
});
