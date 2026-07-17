import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ConfigRevisionConflictError,
  atomicWriteJsonConfig,
  mutateJsonConfig,
  readJsonConfigSnapshot
} from "../../src/dashboard/config-store.js";

test("dashboard config mutations serialize concurrent read-modify-write updates", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-config-store-"));
  const filePath = path.join(root, "config.json");

  const writes = await Promise.all(Array.from({ length: 24 }, (_, index) => (
    mutateJsonConfig(filePath, async (config) => {
      await new Promise((resolve) => setTimeout(resolve, index % 3));
      return {
        ...config,
        models: [...(config.models ?? []), `model-${index}`]
      };
    })
  )));

  const saved = JSON.parse(await fs.readFile(filePath, "utf8"));
  assert.equal(saved.models.length, 24);
  assert.deepEqual(new Set(saved.models), new Set(Array.from({ length: 24 }, (_, index) => `model-${index}`)));
  assert.equal(new Set(writes.map((write) => write.revision)).size, 24);
  assert.deepEqual(
    (await fs.readdir(root)).filter((name) => name.endsWith(".tmp") || name.endsWith(".lock")),
    []
  );
});

test("dashboard config atomic writes reject stale revisions without replacing the winner", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-config-store-"));
  const filePath = path.join(root, "config.json");
  await atomicWriteJsonConfig(filePath, { value: "first" });
  const stale = await readJsonConfigSnapshot(filePath);
  await atomicWriteJsonConfig(filePath, { value: "winner" }, { expectedRevision: stale.revision });

  await assert.rejects(
    atomicWriteJsonConfig(filePath, { value: "stale" }, { expectedRevision: stale.revision }),
    (error) => error instanceof ConfigRevisionConflictError && error.code === "CONFIG_REVISION_CONFLICT"
  );

  assert.deepEqual(JSON.parse(await fs.readFile(filePath, "utf8")), { value: "winner" });
  assert.deepEqual((await fs.readdir(root)).filter((name) => name.endsWith(".tmp")), []);
});

test("dashboard config updater failures preserve the original file and release its lock", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-config-store-"));
  const filePath = path.join(root, "config.json");
  await atomicWriteJsonConfig(filePath, { value: "stable" });

  await assert.rejects(mutateJsonConfig(filePath, () => {
    throw new Error("fault injection");
  }), /fault injection/);

  assert.deepEqual(JSON.parse(await fs.readFile(filePath, "utf8")), { value: "stable" });
  assert.deepEqual(
    (await fs.readdir(root)).filter((name) => name.endsWith(".tmp") || name.endsWith(".lock")),
    []
  );
});

test("dashboard config release does not delete a replacement lock owner", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-config-lock-owner-"));
  const file = path.join(cwd, "config.json");
  const lock = path.join(cwd, ".config.json.ant-code.lock");
  const displaced = path.join(cwd, ".config.json.displaced.lock");
  await fs.writeFile(file, `${JSON.stringify({ value: 1 })}\n`, "utf8");

  await mutateJsonConfig(file, async (data) => {
    await fs.rename(lock, displaced);
    await fs.writeFile(lock, `${JSON.stringify({ token: "replacement-owner", pid: process.pid })}\n`, "utf8");
    return { ...data, value: 2 };
  });

  const replacement = JSON.parse(await fs.readFile(lock, "utf8"));
  assert.equal(replacement.token, "replacement-owner");
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { value: 2 });
  await fs.rm(lock, { force: true });
  await fs.rm(displaced, { force: true });
});

test("dashboard config stale reclaim restores a lock replaced before quarantine", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-config-stale-race-"));
  const file = path.join(cwd, "config.json");
  const lock = path.join(cwd, ".config.json.ant-code.lock");
  await fs.writeFile(file, `${JSON.stringify({ value: 1 })}\n`, "utf8");
  await fs.writeFile(lock, `${JSON.stringify({
    token: "stale-owner",
    pid: 2_147_483_647,
    createdAt: "2000-01-01T00:00:00.000Z"
  })}\n`, "utf8");
  const staleAt = new Date(Date.now() - 60_000);
  await fs.utimes(lock, staleAt, staleAt);

  const originalRename = fs.rename;
  let injected = false;
  let replacementRestored = false;
  let replacementMonitor = Promise.resolve();
  fs.rename = async (source, destination) => {
    if (!injected && path.resolve(source) === path.resolve(lock) && String(destination).includes(".stale.")) {
      injected = true;
      await fs.rm(lock, { force: true });
      await fs.writeFile(lock, `${JSON.stringify({
        token: "replacement-owner",
        pid: process.pid,
        createdAt: new Date().toISOString()
      })}\n`, "utf8");
      const result = await originalRename(source, destination);
      replacementMonitor = (async () => {
        const deadline = Date.now() + 1_000;
        while (Date.now() < deadline) {
          const owner = await fs.readFile(lock, "utf8").then(JSON.parse).catch(() => null);
          if (owner?.token === "replacement-owner") {
            replacementRestored = true;
            await fs.rm(lock, { force: true });
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      })();
      return result;
    }
    return originalRename(source, destination);
  };

  try {
    await mutateJsonConfig(file, (data) => ({ ...data, value: 2 }));
  } finally {
    fs.rename = originalRename;
    await replacementMonitor;
  }

  assert.equal(injected, true);
  assert.equal(replacementRestored, true);
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { value: 2 });
  assert.deepEqual((await fs.readdir(cwd)).filter((name) => name.includes(".stale.")), []);
});
