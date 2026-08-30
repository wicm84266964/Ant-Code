import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ConfigRevisionConflictError,
  createFileRepository
} from "../../src/config-v2/file-repository.ts";

test("file repository patches owned paths without dropping unknown siblings", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "config-v2-repository-"));
  const filePath = path.join(root, "config.json");
  await fs.writeFile(filePath, `${JSON.stringify({
    unknown: { retained: true },
    lab: {
      gatewayUrl: "https://old.example/v1",
      gatewayApiKey: "old-secret",
      models: [{ id: "one", label: "Original" }]
    }
  }, null, 2)}\n`, "utf8");
  const repository = createFileRepository({ filePath });
  const before = await repository.read();

  const result = await repository.patch({
    expectedRevision: before.revision,
    set: [
      { path: "lab.gatewayUrl", value: "https://new.example/v1" },
      { path: ["lab", "models", "0", "label"], value: "Updated" },
      { path: "lab.activeGatewayProfile", value: "grok" }
    ],
    unset: ["lab.gatewayApiKey"]
  });
  const after = await repository.read();

  assert.equal(result.previousRevision, before.revision);
  assert.equal(result.revision, after.revision);
  assert.deepEqual(after.data, {
    unknown: { retained: true },
    lab: {
      gatewayUrl: "https://new.example/v1",
      models: [{ id: "one", label: "Updated" }],
      activeGatewayProfile: "grok"
    }
  });
});

test("file repository rejects stale revisions without replacing the winner", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "config-v2-conflict-"));
  const repository = createFileRepository({ filePath: path.join(root, "config.json") });
  const initial = await repository.read();
  await repository.patch({ expectedRevision: initial.revision, set: { modelAlias: "winner" } });

  await assert.rejects(
    repository.patch({ expectedRevision: initial.revision, set: { modelAlias: "stale" } }),
    (error) => error instanceof ConfigRevisionConflictError && error.code === "CONFIG_REVISION_CONFLICT"
  );

  assert.equal((await repository.read()).data.modelAlias, "winner");
  assert.deepEqual(temporaryArtifacts(await fs.readdir(root)), []);
});

test("file repository serializes concurrent patches to different paths", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "config-v2-concurrent-"));
  const repository = createFileRepository({ filePath: path.join(root, "config.json") });

  await Promise.all(Array.from({ length: 24 }, (_, index) => repository.patch({
    set: { [`settings.field${index}`]: index }
  })));

  const saved = (await repository.read()).data;
  assert.deepEqual(
    Object.keys(saved.settings).sort(),
    Array.from({ length: 24 }, (_, index) => `field${index}`).sort()
  );
  assert.deepEqual(temporaryArtifacts(await fs.readdir(root)), []);
});

test("file repository blocks prototype-polluting paths", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "config-v2-paths-"));
  const repository = createFileRepository({ filePath: path.join(root, "config.json") });

  await assert.rejects(
    repository.patch({ set: JSON.parse('{"__proto__.polluted":true}') }),
    /invalid segment/
  );
  await assert.rejects(
    repository.patch({ set: [{ path: ["lab", "constructor", "prototype", "polluted"], value: true }] }),
    /invalid segment/
  );
  assert.equal({}.polluted, undefined);
});

test("file repository descriptors expose no document by default and redact credentials", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "config-v2-descriptor-"));
  const sentinel = "sentinel-secret-must-not-leak";
  const repository = createFileRepository({ filePath: path.join(root, "config.json") });
  await repository.patch({
    set: {
      "lab.gatewayUrl": "https://gateway.example/v1",
      "lab.gatewayApiKey": sentinel,
      "lab.nested.accessToken": sentinel
    }
  });

  const metadata = await repository.describe();
  const selected = await repository.describe({
    select: { lab: "lab", explicitSecret: "lab.gatewayApiKey" }
  });

  assert.equal(Object.hasOwn(metadata, "data"), false);
  assert.equal(Object.hasOwn(metadata, "fields"), false);
  assert.equal(selected.fields.lab.value.gatewayUrl, "https://gateway.example/v1");
  assert.equal(selected.fields.lab.value.gatewayApiKey, "[REDACTED]");
  assert.equal(selected.fields.explicitSecret.value, "[REDACTED]");
  assert.equal(JSON.stringify(selected).includes(sentinel), false);
});

/** @param {string[]} names */
function temporaryArtifacts(names: string[]) {
  return names.filter((name) => name.endsWith(".tmp") || name.endsWith(".lock") || name.includes(".stale."));
}
