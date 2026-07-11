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
