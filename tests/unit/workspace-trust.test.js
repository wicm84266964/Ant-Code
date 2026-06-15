import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  listTrustedWorkspaces,
  resolveWorkspaceTrust,
  revokeWorkspaceTrust,
  trustStorePath,
  trustWorkspace,
  userConfigDir
} from "../../src/permissions/workspace-trust.js";

test("workspace trust is stored outside the repository", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-workspace-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-home-"));
  const env = { LAB_AGENT_HOME: home };

  const before = await resolveWorkspaceTrust({ cwd, env });
  assert.equal(before.trusted, false);
  assert.equal(userConfigDir(env), home);
  assert.equal(trustStorePath(env), path.join(home, "workspace-trust.json"));

  const record = await trustWorkspace({
    cwd,
    env,
    version: "test-version",
    now: () => "2026-04-28T00:00:00.000Z"
  });
  const after = await resolveWorkspaceTrust({ cwd, env });

  assert.equal(after.trusted, true);
  assert.equal(after.workspaceId, record.workspaceId);
  assert.equal(record.antCodeVersion, "test-version");
  assert.equal(record.displayPath, await fs.realpath(cwd));

  await assert.rejects(fs.access(path.join(cwd, "workspace-trust.json")), /ENOENT/);
  const storeText = await fs.readFile(path.join(home, "workspace-trust.json"), "utf8");
  assert.doesNotMatch(storeText, /prompt|output|apiKey|sk-/i);
});

test("workspace trust can be listed and revoked", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-workspace-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-home-"));
  const env = { LAB_AGENT_HOME: home };

  await trustWorkspace({ cwd, env });
  const list = await listTrustedWorkspaces({ env });
  assert.equal(list.length, 1);
  assert.equal(list[0].displayPath, await fs.realpath(cwd));

  const revoked = await revokeWorkspaceTrust({ cwd, env });
  assert.equal(revoked.revoked, true);
  const after = await resolveWorkspaceTrust({ cwd, env });
  assert.equal(after.trusted, false);
});

test("high sensitivity sessions require per-process trust confirmation", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-workspace-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-home-"));
  const env = { LAB_AGENT_HOME: home };

  await trustWorkspace({ cwd, env });
  const trust = await resolveWorkspaceTrust({ cwd, env, sensitivity: "high" });

  assert.equal(trust.record !== null, true);
  assert.equal(trust.trusted, false);
  assert.equal(trust.requiresPerProcessConfirmation, true);
});
