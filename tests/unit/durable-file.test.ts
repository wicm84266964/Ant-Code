import assert from "node:assert/strict";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { atomicWriteFileSync, withFileMutationLock } from "../../src/storage/durable-file.ts";

test("lock release retries sharing violations and permits the next mutation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "durable-lock-release-"));
  const file = path.join(root, "state.json");
  const rename = fs.rename;
  let failures = 0;
  fs.rename = async (source, target) => {
    if (String(target).includes(".released.") && failures++ < 2) {
      throw Object.assign(new Error("sharing violation"), { code: "EPERM" });
    }
    return rename(source, target);
  };
  try {
    await withFileMutationLock(file, async () => {});
    await withFileMutationLock(file, async () => {});
    assert.equal(failures, 4);
    assert.deepEqual(await fs.readdir(root), []);
  } finally {
    fs.rename = rename;
    await fs.rm(root, { recursive: true, force: true });
  }
});

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
