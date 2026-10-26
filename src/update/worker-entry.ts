import path from "node:path";
import fs from "node:fs/promises";
import { StateStore } from "./state-store.ts";
import { runUpdateWorker } from "./worker.ts";
import type { Route } from "./contracts.ts";

// Detached entrypoint. Only paths arrive in argv; proxy credentials travel over the
// private inherited stdin pipe and are never persisted in job files or process args.
async function main() {
  const [root, jobId] = process.argv.slice(2);
  if (!root || !path.isAbsolute(root) || !jobId) throw new Error("Invalid worker invocation");
  const store = new StateStore(await fs.realpath(root));
  await store.initialize();
  const journal = await store.journal(jobId);
  if (!journal || journal.sourceRoot !== root || journal.step !== "created") throw new Error("Invalid worker journal");
  let text = "";
  for await (const chunk of process.stdin) {
    text += chunk.toString();
    if (text.length > 4096) throw new Error("Invalid worker input");
  }
  const route = JSON.parse(text) as Route;
  if (route.mode !== "proxy" && route.mode !== "direct") throw new Error("Invalid worker route");
  await runUpdateWorker(store, journal, route, process.env);
}
main().catch(() => { process.exitCode = 1; });
