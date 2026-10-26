import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { StateStore, releaseIdlePeerDashboards } from "../../src/update/state-store.ts";

test("an idle sibling dashboard is closed instead of blocking the update", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "peer-idle-"));
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const token = "peer-token-idle-dashboard-000000000001";
  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as { action?: string };
      calls.push(String(body.action));
      if (body.action === "shutdown") child.kill();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, busy: false, accepted: body.action === "shutdown" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  try {
    await fs.mkdir(path.join(cwd, ".git", "ant-source-update", "leases"), { recursive: true });
    await fs.writeFile(path.join(cwd, ".git", "ant-source-update", "leases", "other.json"), JSON.stringify({
      instanceId: "other-dashboard", pid: child.pid, host: "127.0.0.1", port, peerToken: token
    }));
    await releaseIdlePeerDashboards(cwd, "current-dashboard");
    assert.deepEqual(calls, ["status", "shutdown"]);
    assert.equal((await new StateStore(cwd).listOtherLiveLeases("current-dashboard")).length, 0);
  } finally {
    child.kill();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("a sibling dashboard with active work still blocks the update", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "peer-busy-"));
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, busy: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  try {
    await fs.mkdir(path.join(cwd, ".git", "ant-source-update", "leases"), { recursive: true });
    await fs.writeFile(path.join(cwd, ".git", "ant-source-update", "leases", "other.json"), JSON.stringify({
      instanceId: "busy-dashboard", pid: child.pid, host: "127.0.0.1", port, peerToken: "peer-token-busy-dashboard-000000000001"
    }));
    await assert.rejects(releaseIdlePeerDashboards(cwd, "current-dashboard"), { code: "OTHER_DASHBOARD_BUSY" });
  } finally {
    child.kill();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
