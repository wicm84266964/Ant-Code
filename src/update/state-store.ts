import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { UpdateError } from "./contracts.ts";
import type { UpdateJournal } from "./contracts.ts";
import { cleanEnvironment, runProcess } from "./process.ts";

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
  async registerLease(instanceId: string) {
    await atomicJson(path.join(this.root, "leases", `${instanceId}.json`), { instanceId, pid: process.pid });
  }
  async removeLease(instanceId: string) { await fs.rm(path.join(this.root, "leases", `${instanceId}.json`), { force: true }); }
  async assertOnlyLease(instanceId: string) {
    for (const file of await fs.readdir(path.join(this.root, "leases"))) {
      if (!file.endsWith(".json")) continue;
      const lease = await readJson<{ instanceId: string; pid: number }>(path.join(this.root, "leases", file));
      if (lease && lease.instanceId !== instanceId && isAlive(lease.pid)) throw new UpdateError("OTHER_DASHBOARD_RUNNING");
    }
  }
}
