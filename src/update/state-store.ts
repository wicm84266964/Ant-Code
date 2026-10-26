import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { UpdateError } from "./contracts.ts";
import type { UpdateJournal } from "./contracts.ts";
import { cleanEnvironment, runProcess } from "./process.ts";

export type DashboardLease = {
  instanceId: string;
  pid: number;
  host?: string;
  port?: number;
  peerToken?: string;
};

export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
export async function atomicJson(file: string, value: unknown) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
  await fs.rename(temporary, file);
  // Directory fsync is not supported on Windows; file flush + atomic rename still avoids partial JSON.
  if (process.platform !== "win32") {
    const directory = await fs.open(path.dirname(file), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }
}
export async function readJson<T>(file: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(file, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw new UpdateError("STATE_UNREADABLE"); }
}
export class StateStore {
  root: string;
  constructor(sourceRoot: string) { this.root = path.join(sourceRoot, ".git", "ant-source-update"); }
  async initialize() {
    const created = await fs.mkdir(this.root, { mode: 0o700 }).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") return false; throw error;
    });
    const stat = await fs.lstat(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new UpdateError("UNSAFE_STATE_DIRECTORY");
    if (process.platform === "win32") {
      // No broad user/group inheritance in this private directory. Existing state is never silently trusted.
      const env = cleanEnvironment(process.env);
      if (created) {
        const who = await runProcess("whoami.exe", ["/user", "/fo", "csv", "/nh"], { cwd: this.root, env });
        const sid = who.stdout.match(/S-1-5-[\d-]+/i)?.[0];
        if (!sid) throw new UpdateError("PRIVATE_STATE_ACL_FAILED");
        const acl = await runProcess("icacls.exe", [this.root, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`], { cwd: this.root, env });
        if (acl.code !== 0) throw new UpdateError("PRIVATE_STATE_ACL_FAILED");
      }
      // Inspect ACL via a fixed script; reject any writable grant to a different identity.
      const script = "$ErrorActionPreference='Stop'; $a=Get-Acl -LiteralPath $env:ANT_UPDATE_ACL_PATH; $s=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; if($a.AreAccessRulesProtected -ne $true){exit 2}; foreach($r in $a.Access){if($r.AccessControlType -eq 'Allow' -and $r.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $s){exit 3}}";
      // No path interpolation or PowerShell argv reparsing (installation paths may contain spaces).
      const check = await runProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { cwd: this.root, env: { ...env, ANT_UPDATE_ACL_PATH: this.root } });
      if (check.code !== 0) throw new UpdateError("UNSAFE_STATE_ACL");
    } else if ((stat.mode & 0o077) !== 0 || stat.uid !== os.userInfo().uid) {
      throw new UpdateError("UNSAFE_STATE_PERMISSIONS");
    }
    await fs.mkdir(path.join(this.root, "leases"), { recursive: true, mode: 0o700 });
  }
  jobDirectory(id: string) {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new UpdateError("INVALID_JOB_ID");
    return path.join(this.root, id);
  }
  async writeJournal(journal: UpdateJournal) {
    journal.updatedAt = Date.now();
    await atomicJson(path.join(this.jobDirectory(journal.jobId), "journal.json"), journal);
  }
  async journal(id?: string): Promise<UpdateJournal | null> {
    const latest = id ?? (await readJson<{ jobId: string }>(path.join(this.root, "latest.json")))?.jobId;
    return latest ? readJson<UpdateJournal>(path.join(this.jobDirectory(latest), "journal.json")) : null;
  }
  async acquire(jobId: string): Promise<void> {
    const file = path.join(this.root, "update.lock");
    const handle = await fs.open(file, "wx", 0o600).catch(() => { throw new UpdateError("UPDATE_LOCKED", "Another update or interrupted journal needs inspection. Locks are never automatically stolen."); });
    try { await handle.writeFile(JSON.stringify({ jobId, pid: process.pid })); await handle.sync(); } finally { await handle.close(); }
  }
  async release(jobId: string) {
    const file = path.join(this.root, "update.lock");
    if ((await readJson<{ jobId: string }>(file))?.jobId === jobId) await fs.unlink(file);
  }
  async registerLease(instanceId: string, details: { host?: string; port?: number; peerToken?: string } = {}) {
    const lease: DashboardLease = { instanceId, pid: process.pid };
    if (details.host && isLoopbackHost(details.host)) lease.host = details.host === "[::1]" ? "::1" : details.host;
    if (Number.isInteger(details.port) && details.port! > 0 && details.port! < 65536) lease.port = details.port;
    if (details.peerToken && /^[A-Za-z0-9_-]{32,128}$/.test(details.peerToken)) lease.peerToken = details.peerToken;
    await atomicJson(path.join(this.root, "leases", `${instanceId}.json`), lease);
  }
  async removeLease(instanceId: string) { await fs.rm(path.join(this.root, "leases", `${instanceId}.json`), { force: true }); }
  async listOtherLiveLeases(instanceId: string) {
    const peers: DashboardLease[] = [];
    for (const file of await fs.readdir(path.join(this.root, "leases"))) {
      if (!file.endsWith(".json")) continue;
      const lease = await readJson<DashboardLease>(path.join(this.root, "leases", file));
      if (lease && lease.instanceId !== instanceId && isAlive(lease.pid)) peers.push(lease);
    }
    return peers;
  }
  async assertOnlyLease(instanceId: string) {
    if ((await this.listOtherLiveLeases(instanceId)).length > 0) throw new UpdateError("OTHER_DASHBOARD_RUNNING");
  }
}

const PEER_HEADER = "x-antcode-peer-token";

export function tokensEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function isLoopbackHost(value: string) {
  const host = value.trim().toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

export function isLoopbackAddress(value: string | undefined) {
  const address = String(value ?? "").toLowerCase().replace(/^::ffff:/, "");
  return address === "127.0.0.1" || address === "::1";
}

/** An idle sibling Dashboard is closed by the update. A busy or unreachable one still blocks. */
export async function releaseIdlePeerDashboards(sourceRoot: string, instanceId: string) {
  const peers = await new StateStore(sourceRoot).listOtherLiveLeases(instanceId);
  for (const peer of peers) {
    if (!peer.port || !peer.peerToken || !isLoopbackHost(peer.host ?? "127.0.0.1")) {
      throw new UpdateError("OTHER_DASHBOARD_RUNNING");
    }
    const status = await callPeerDashboard(peer, "status");
    if (status.busy) throw new UpdateError("OTHER_DASHBOARD_BUSY");
    if (!status.ok) throw new UpdateError("OTHER_DASHBOARD_RUNNING");
    const stopped = await callPeerDashboard(peer, "shutdown");
    if (stopped.busy) throw new UpdateError("OTHER_DASHBOARD_BUSY");
    if (!stopped.accepted) throw new UpdateError("OTHER_DASHBOARD_RUNNING");
    const deadline = Date.now() + 15_000;
    while (isAlive(peer.pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    if (isAlive(peer.pid)) throw new UpdateError("OTHER_DASHBOARD_RUNNING");
  }
}

async function callPeerDashboard(peer: DashboardLease, action: "status" | "shutdown") {
  const host = peer.host === "::1" || peer.host === "[::1]" ? "::1" : "127.0.0.1";
  const body = JSON.stringify({ action });
  return new Promise<{ ok: boolean; busy?: boolean; accepted?: boolean }>((resolve) => {
    const request = http.request({
      host, port: peer.port, method: "POST", path: "/api/source-update/peer",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), [PEER_HEADER]: peer.peerToken },
      timeout: 3_000
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { ok?: boolean; busy?: boolean; accepted?: boolean };
          resolve({ ok: parsed.ok === true && response.statusCode === 200, busy: parsed.busy === true, accepted: parsed.accepted === true });
        } catch { resolve({ ok: false }); }
      });
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve({ ok: false }));
    request.end(body);
  });
}
