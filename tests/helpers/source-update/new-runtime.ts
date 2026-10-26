// Fixture-only CLI. Implements the strict-port contract not yet wired into product CLI.
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
// This file is copied to fixture/src/cli/index.ts before it is committed.
// @ts-ignore fixture-relative imports
import { captureBootSnapshot, acknowledgeSourceUpdate } from "../update/boot.ts";
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log(`ant-code ${JSON.parse(await fs.readFile(path.join(sourceRoot, "package.json"), "utf8")).version}`);
  process.exit(0);
}
const port = Number(args[args.indexOf("--port") + 1]);
const host = args[args.indexOf("--host") + 1];
if (!args.includes("--strict-port") || !args.includes("--no-open") || !path.isAbsolute(args[args.indexOf("--project") + 1])) process.exit(8);
// Fixture-only owner-controlled shutdown, including a test failing before ACK.
const stopFile = path.join(sourceRoot, ".git", "ant-source-update", process.env.ANT_SOURCE_UPDATE_JOB!, "stop-fixture");
setInterval(async () => { if (await fs.stat(stopFile).then(() => true, () => false)) process.exit(0); }, 50);
const boot = await captureBootSnapshot(sourceRoot);
const server = http.createServer((_request, response) => response.end("fixture"));
server.once("error", () => process.exit(9)); // strictly no port fallback
server.listen(port, host, async () => {
  try {
    await acknowledgeSourceUpdate({ sourceRoot, boot, host, actualPort: (server.address() as { port: number }).port, strictPort: true });
    await fs.writeFile(path.join(sourceRoot, ".git", "new-runtime.json"), JSON.stringify({ pid: process.pid, boot, args }));
  } catch { process.exit(10); }
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
