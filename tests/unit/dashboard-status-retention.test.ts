import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDashboardRuntime } from "../../src/dashboard/sessions.ts";
import { runtimeListSessionRecords } from "../../src/dashboard/runtime/api-sessions.ts";
import { runtimeStatus } from "../../src/dashboard/runtime/api-settings.ts";
import { createSessionStore } from "../../src/storage/session-store.ts";
import {
  close,
  createGateway,
  listen,
  mockGatewayEnv
} from "./dashboard-runtime/helpers.ts";

test("dashboard status and session list do not wait for session retention cleanup", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-status-retention-"));
  let retentionStarted = false;
  let retentionFinished = false;
  const hang = () => new Promise((resolve) => {
    retentionStarted = true;
    setTimeout(() => {
      retentionFinished = true;
      resolve({ ok: true, deleted: [] });
    }, 5000);
  });
  const ctx = {
    cwd,
    runtimeEnv: process.env,
    clientModelSelections: new Map(),
    selectedProviderId: "",
    selectedModelId: "",
    selectedReasoningEffort: "",
    active: new Map(),
    resolveConfigEnv: async () => process.env,
    maintainSessionRetention: hang
  };

  const started = Date.now();
  const status = await runtimeStatus(ctx, {});
  const listed = await runtimeListSessionRecords(ctx);
  const elapsed = Date.now() - started;

  assert.equal(status.ok, true);
  assert.ok(Array.isArray(listed));
  assert.equal(retentionStarted, true);
  assert.equal(retentionFinished, false);
  assert.ok(elapsed < 1000, `interactive status waited ${elapsed}ms for retention`);
});

test("new dashboard turn does not wait for background session retention", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-turn-retention-"));
  const store = createSessionStore({ cwd });
  const expiredPath = await store.writeMetadata({ id: "expired-session" });
  const oldTime = new Date("2020-01-01T00:00:00.000Z");
  await fs.utimes(expiredPath, oldTime, oldTime);

  const originalStat = fs.stat;
  let releaseHold = () => {};
  const held = new Promise((resolve) => {
    releaseHold = resolve;
  });
  let cleanupEnteredResolve = () => {};
  const cleanupEntered = new Promise((resolve) => {
    cleanupEnteredResolve = resolve;
  });
  let intercepted = false;
  fs.stat = async (...args) => {
    const result = await originalStat(...args);
    if (!intercepted && path.resolve(String(args[0])) === path.resolve(expiredPath)) {
      intercepted = true;
      cleanupEnteredResolve();
      await held;
    }
    return result;
  };

  const server = await listen(createGateway("dashboard answer"), "127.0.0.1", 0);
  const runtime = createDashboardRuntime({ cwd, env: mockGatewayEnv(server) });
  try {
    await runtime.trustWorkspace();
    await runtime.status();
    await cleanupEntered;

    const started = runtime.startTurn({
      prompt: "hello dashboard",
      permissionMode: "plan"
    });
    /** @type {{ result?: { ok?: boolean; sessionId?: string }; timeout?: boolean }} */
    const raced = await Promise.race([
      started.then((result) => ({ result })),
      new Promise((resolve) => {
        setTimeout(() => resolve({ timeout: true }), 3000);
      })
    ]);

    assert.notEqual(raced.timeout, true, "new turn waited for session retention");
    assert.equal(raced.result?.ok, true);
    assert.ok(raced.result?.sessionId);
  } finally {
    releaseHold();
    fs.stat = originalStat;
    await runtime.shutdown({ force: true, cancel: true }).catch(() => {});
    await close(server);
  }
});

test("session retention maintenance does not take the active-capacity lock", async () => {
  const source = await fs.readFile(new URL("../../src/dashboard/sessions.ts", import.meta.url), "utf8");
  const maintain = source.slice(source.indexOf("const maintainSessionRetention"), source.indexOf("const activeSweepTimer"));
  assert.match(maintain, /excludeSessionIds:\s*\(\)\s*=>\s*\[\.\.\.active\.keys\(\)\]/);
  assert.doesNotMatch(maintain, /withKeyedMutation\(\s*activeCapacityLocks/);
});
