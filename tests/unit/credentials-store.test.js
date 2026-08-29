import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ConfigRevisionConflictError,
  createCredentialStore
} from "../../src/credentials/store.js";

test("credential store sets, resolves, describes, and clears a secret", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "credential-store-"));
  const store = createCredentialStore({ filePath: path.join(root, "credentials.json") });

  const setResult = await store.set("gateway:grok", "grok-secret");
  assert.equal(setResult.configured, true);
  assert.equal(await store.resolve("gateway:grok"), "grok-secret");
  assert.deepEqual(
    pickDescriptor(await store.describe("gateway:grok")),
    { reference: "gateway:grok", configured: true }
  );

  const clearResult = await store.clear("gateway:grok", { expectedRevision: setResult.revision });
  assert.equal(clearResult.configured, false);
  assert.equal(await store.resolve("gateway:grok"), undefined);
  assert.equal((await store.describe("gateway:grok")).configured, false);
  const secondClear = await store.clear("gateway:grok", { expectedRevision: clearResult.revision });
  assert.equal(secondClear.revision, clearResult.revision);
});

test("credential descriptors never serialize secrets and credentials do not overwrite siblings", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "credential-descriptor-"));
  const store = createCredentialStore({ filePath: path.join(root, "credentials.json") });
  const sentinel = "sentinel-secret-must-not-serialize";
  await store.set("gateway:grok", sentinel);
  await store.set("gateway:deepseek", "another-secret");

  const one = await store.describe("gateway:grok");
  const all = await store.describeAll();
  assert.equal(JSON.stringify(one).includes(sentinel), false);
  assert.equal(JSON.stringify(all).includes(sentinel), false);
  assert.deepEqual(all.credentials, [
    { reference: "gateway:deepseek", configured: true },
    { reference: "gateway:grok", configured: true }
  ]);
  assert.equal(await store.resolve("gateway:grok"), sentinel);
  assert.equal(await store.resolve("gateway:deepseek"), "another-secret");
});

test("credential store rejects stale revisions and preserves the winner", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "credential-conflict-"));
  const filePath = path.join(root, "credentials.json");
  const store = createCredentialStore({ filePath });
  const missing = await store.describe("gateway:grok");
  await store.set("gateway:grok", "winner", { expectedRevision: missing.revision });

  await assert.rejects(
    store.set("gateway:grok", "stale", { expectedRevision: missing.revision }),
    (error) => error instanceof ConfigRevisionConflictError && error.code === "CONFIG_REVISION_CONFLICT"
  );

  assert.equal(await store.resolve("gateway:grok"), "winner");
  assert.equal((await fs.readFile(filePath, "utf8")).includes("stale"), false);
  assert.deepEqual(temporaryArtifacts(await fs.readdir(root)), []);
});

test("credential store validates references and empty values", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "credential-validation-"));
  const store = createCredentialStore({ filePath: path.join(root, "credentials.json") });

  await assert.rejects(store.set("../gateway", "secret"), /unsupported characters/);
  await assert.rejects(store.set("__proto__", "secret"), /unsupported characters/);
  await assert.rejects(store.set("gateway:grok", "   "), /non-empty string/);
  assert.equal({}.polluted, undefined);
});

test("credential store uses restrictive permissions where mode bits are supported", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "credential-permissions-"));
  const directory = path.join(root, "private");
  const filePath = path.join(directory, "credentials.json");
  const store = createCredentialStore({ filePath });
  await store.set("gateway:grok", "secret");

  if (process.platform !== "win32") {
    assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600);
  } else {
    assert.equal((await fs.stat(filePath)).isFile(), true);
  }
  assert.deepEqual(temporaryArtifacts(await fs.readdir(directory)), []);
});

/** @param {{ reference: string, configured: boolean }} descriptor */
function pickDescriptor(descriptor) {
  return { reference: descriptor.reference, configured: descriptor.configured };
}

/** @param {string[]} names */
function temporaryArtifacts(names) {
  return names.filter((name) => name.endsWith(".tmp") || name.endsWith(".lock") || name.includes(".stale."));
}
