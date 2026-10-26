import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { UpdateError } from "./contracts.ts";
import type { BootSnapshot } from "./contracts.ts";
import { Repository } from "./repository.ts";
import { StateStore, atomicJson, isAlive } from "./state-store.ts";

export async function captureBootSnapshot(sourceRoot: string, env: NodeJS.ProcessEnv = process.env): Promise<BootSnapshot> {
  const pkg = JSON.parse(await fs.readFile(path.join(sourceRoot, "package.json"), "utf8"));
  let bootCommit: string | null = null;
  try { bootCommit = (await new Repository(sourceRoot, env).git(["rev-parse", "--verify", "HEAD^{commit}"])).trim(); } catch { /* packaged install */ }
  return Object.freeze({ productVersion: String(pkg.version), bootCommit, instanceId: randomUUID() });
}

/** Invoke once, only AFTER the new server successfully listens on the requested port.
 * No HTTP nonce: the private journal + inherited environment authenticates the child.
 * A normal start returns false. A malformed update start MUST fail closed, not ACK.
 */
export async function acknowledgeSourceUpdate(options: {
  sourceRoot: string; boot: BootSnapshot; host: string; actualPort: number;
  strictPort: boolean; env?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  const env = options.env ?? process.env;
  if (!env.ANT_SOURCE_UPDATE_JOB) return false;
  const root = await fs.realpath(options.sourceRoot);
  if (env.ANT_SOURCE_UPDATE_ROOT !== root || !env.ANT_SOURCE_UPDATE_NONCE || !options.strictPort) throw new UpdateError("INVALID_UPDATE_BOOT");
  const store = new StateStore(root);
  await store.initialize();
  const journal = await store.journal(env.ANT_SOURCE_UPDATE_JOB);
  if (!journal || journal.nonce !== env.ANT_SOURCE_UPDATE_NONCE || journal.sourceRoot !== root ||
      !["restartIntent", "spawned"].includes(journal.step) || journal.phase !== "restarting" ||
      journal.plan.target !== options.boot.bootCommit || journal.boot.instanceId === options.boot.instanceId ||
      journal.restart.host !== options.host || journal.restart.port !== options.actualPort ||
      isAlive(journal.oldPid) || !isAlive(journal.workerPid) ||
      (journal.childPid !== undefined && journal.childPid !== process.pid)) throw new UpdateError("INVALID_UPDATE_BOOT");
  const repo = new Repository(root, env);
  const head = (await repo.git(["rev-parse", "HEAD"])).trim();
  if (head !== options.boot.bootCommit) throw new UpdateError("INVALID_UPDATE_BOOT");
  // A matching SHA is insufficient if files/index changed during restart.
  await repo.assertClean();
  await atomicJson(path.join(store.jobDirectory(journal.jobId), "ack.json"), {
    nonce: journal.nonce, instanceId: options.boot.instanceId, commit: options.boot.bootCommit,
    pid: process.pid, host: options.host, port: options.actualPort
  });
  return true;
}
