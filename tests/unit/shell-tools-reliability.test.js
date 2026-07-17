import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { PassThrough } from "node:stream";
import { createOutputCollector, runShellCommand } from "../../src/tools/shell-tools.js";

test("shell output collector bounds retained bytes while preserving head and tail", () => {
  const collector = createOutputCollector(256);
  collector.append(Buffer.from("HEAD\n"));
  collector.append(Buffer.alloc(4_096, "x"));
  collector.append(Buffer.from("\nTAIL"));

  const output = collector.toString();
  assert.equal(collector.bytes, 4_106);
  assert.equal(collector.truncated, true);
  assert.ok(Buffer.byteLength(output, "utf8") <= 256);
  assert.match(output, /^HEAD/);
  assert.match(output, /shell output truncated/);
  assert.match(output, /TAIL$/);
});

test("shell timeout settles even when the child never emits close", async () => {
  const child = new NeverClosingChild();
  const startedAt = Date.now();
  const result = await runShellCommand({
    executable: "never-close",
    args: ["never-close"],
    cwd: process.cwd(),
    env: {},
    timeoutMs: 5,
    terminationSettleMs: 15,
    spawnProcess: () => child
  });

  assert.equal(result.timedOut, true);
  assert.equal(result.terminationUnconfirmed, true);
  assert.equal(result.error.code, "SHELL_TIMEOUT");
  assert.ok(child.killCalls >= 1);
  assert.ok(Date.now() - startedAt < 1_000);
});

test("shell abort settles even when the child never emits close", async () => {
  const child = new NeverClosingChild();
  const controller = new AbortController();
  const pending = runShellCommand({
    executable: "never-close",
    args: ["never-close"],
    cwd: process.cwd(),
    env: {},
    signal: controller.signal,
    timeoutMs: 60_000,
    terminationSettleMs: 15,
    spawnProcess: () => child
  });
  controller.abort();
  child.emit("spawn");

  const result = await pending;
  assert.equal(result.interrupted, true);
  assert.equal(result.terminationUnconfirmed, true);
  assert.equal(result.error.code, "SHELL_INTERRUPTED");
  assert.ok(child.killCalls >= 1);
});

class NeverClosingChild extends EventEmitter {
  constructor() {
    super();
    this.pid = null;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.killCalls = 0;
    this.unrefCalls = 0;
  }

  kill() {
    this.killCalls += 1;
    return true;
  }

  unref() {
    this.unrefCalls += 1;
  }
}
