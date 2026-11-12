import assert from "node:assert/strict";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { atomicWriteFile, atomicWriteFileSync, withFileMutationLock } from "../../src/storage/durable-file.ts";

test("atomic replacement survives transient sharing violations without removing committed data", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "durable-replace-"));
  const file = path.join(root, "session.json");
  const rename = fs.rename;
  await fs.writeFile(file, "old");
  let attempts = 0;
  const sources = new Set<string>();
  fs.rename = async (source, target) => {
    sources.add(String(source));
    assert.equal(await fs.readFile(file, "utf8"), "old");
    assert.equal(await fs.readFile(source, "utf8"), "new");
    const code = ["EPERM", "EACCES", "EBUSY"][attempts++];
    if (code) throw Object.assign(new Error("sharing violation"), { code });
    return rename(source, target);
  };
  try {
    await atomicWriteFile(file, "new");
    assert.equal(attempts, 4);
    assert.equal(sources.size, 1);
    assert.equal(await fs.readFile(file, "utf8"), "new");
    assert.deepEqual(await fs.readdir(root), ["session.json"]);
  } finally {
    fs.rename = rename;
    await fs.rm(root, { recursive: true, force: true });
  }
});

for (const code of ["EPERM", "EIO"]) {
  test(`atomic replacement bounds retries and preserves old data on ${code}`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "durable-replace-fail-"));
    const file = path.join(root, "session.json");
    const rename = fs.rename;
    const error = Object.assign(new Error("injected replacement failure"), { code });
    await fs.writeFile(file, "old");
    let attempts = 0;
    fs.rename = async () => { attempts++; throw error; };
    try {
      await assert.rejects(atomicWriteFile(file, "new"), (actual) => actual === error);
      assert.equal(attempts, code === "EPERM" ? 6 : 1);
      assert.equal(await fs.readFile(file, "utf8"), "old");
      assert.deepEqual(await fs.readdir(root), ["session.json"]);
    } finally {
      fs.rename = rename;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}

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
    assert.ok(failures >= 4 && failures <= 12);
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
