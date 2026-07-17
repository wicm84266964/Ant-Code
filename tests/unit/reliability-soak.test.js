import assert from "node:assert/strict";
import test from "node:test";
import { runReliabilitySoak } from "../soak/reliability-soak.js";

test("reliability soak harness completes three fault-injection rounds", { timeout: 30_000 }, async () => {
  const summary = await runReliabilitySoak({
    iterations: 3,
    sampleIntervalMs: 10,
    maxHandleDelta: 8,
    maxHeapGrowthBytes: 512 * 1024 * 1024,
    maxHeapSlopeBytesPerMinute: 512 * 1024 * 1024,
    maxRssGrowthBytes: 1024 * 1024 * 1024,
    maxRssSlopeBytesPerMinute: 1024 * 1024 * 1024
  });

  assert.equal(summary.ok, true);
  assert.equal(summary.rounds, 3);
  assert.equal(summary.unhandledRejections.length, 0);
  for (const scenario of ["storage", "terminal", "dashboard", "gateway"]) {
    assert.equal(summary.scenarios[scenario].runs, 3);
  }
  assert.ok(summary.memory.samples >= 2);
});
