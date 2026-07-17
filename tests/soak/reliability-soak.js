#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cancelBackgroundTerminalTasks,
  listBackgroundTerminalTasks,
  registerBackgroundTerminalTask
} from "../../src/agents/background-terminal-registry.js";
import { createDashboardRuntime } from "../../src/dashboard/sessions.js";
import { parseOpenAIChatCompletionStream } from "../../src/model-gateway/openai-chat.js";
import { parseGatewayStream } from "../../src/model-gateway/streaming.js";
import { createSessionStore } from "../../src/storage/session-store.js";

const DEFAULT_SHORT_DURATION_MS = 90_000;
const DEFAULT_LONG_DURATION_MS = 30 * 60_000;
const DEFAULT_SCENARIO_TIMEOUT_MS = 2_000;
const DEFAULT_SAMPLE_INTERVAL_MS = 1_000;
const MIB = 1024 * 1024;

/**
 * @param {Record<string, any>} [input]
 */
export async function runReliabilitySoak(input = {}) {
  const options = normalizeOptions(input);
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ant-code-reliability-soak-"));
  const runId = path.basename(cwd).replace(/[^A-Za-z0-9_-]/g, "-");
  const unhandledRejections = [];
  const scenarioStats = createScenarioStats();
  const samples = [];
  let removed = false;
  const onUnhandledRejection = (reason) => {
    unhandledRejections.push(errorSummary(reason));
  };
  process.on("unhandledRejection", onUnhandledRejection);

  try {
    const context = {
      cwd,
      runId,
      options,
      scenarioStats,
      env: { ...process.env, LAB_AGENT_HOME: path.join(cwd, ".ant-code-home") }
    };
    const work = async () => {
      for (let warmup = 0; warmup < 3; warmup += 1) {
        await runRound(context, warmup, false);
      }
      await settleRuntime();
      collectSample(samples, "baseline");

      const startedAt = Date.now();
      const deadline = options.iterations === null ? startedAt + options.durationMs : Number.POSITIVE_INFINITY;
      let nextSampleAt = startedAt + options.sampleIntervalMs;
      let rounds = 0;
      while (
        options.iterations === null
          ? Date.now() < deadline
          : rounds < options.iterations
      ) {
        await runRound(context, rounds, true);
        rounds += 1;
        if (Date.now() >= nextSampleAt) {
          collectSample(samples, `round-${rounds}`);
          nextSampleAt = Date.now() + options.sampleIntervalMs;
        }
      }
      return rounds;
    };

    const globalTimeoutMs = options.iterations === null
      ? options.durationMs + Math.max(10_000, options.scenarioTimeoutMs * 2)
      : Math.max(10_000, options.iterations * 4 * options.scenarioTimeoutMs + 5_000);
    const rounds = await withDeadline(work(), globalTimeoutMs, "global soak deadline");
    await withDeadline(fs.rm(cwd, { recursive: true, force: true }), 5_000, "soak workspace cleanup");
    removed = true;
    await settleRuntime();
    collectSample(samples, "final");

    const summary = buildSummary({
      options,
      rounds,
      samples,
      scenarioStats,
      unhandledRejections
    });
    assertReliabilityGates(summary);
    return summary;
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
    if (!removed) {
      await fs.rm(cwd, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function runRound(context, iteration, count) {
  const scenarios = [
    ["storage", () => runStorageScenario(context, iteration)],
    ["terminal", () => runTerminalScenario(context, iteration)],
    ["dashboard", () => runDashboardScenario(context, iteration)],
    ["gateway", () => runGatewayScenario(iteration)]
  ];
  for (const [name, scenario] of scenarios) {
    const startedAt = Date.now();
    await withDeadline(Promise.resolve().then(scenario), context.options.scenarioTimeoutMs, `${name} scenario`);
    if (count) {
      const stats = context.scenarioStats[name];
      stats.runs += 1;
      stats.totalMs += Date.now() - startedAt;
      stats.maxMs = Math.max(stats.maxMs, Date.now() - startedAt);
    }
  }
}

async function runStorageScenario(context, iteration) {
  const store = createSessionStore({ cwd: context.cwd });
  const sessionId = `soak-session-${Math.abs(iteration) % 4}`;
  await store.deleteSession(sessionId).catch(() => {});
  const messages = Array.from({ length: 6 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `round ${iteration} message ${index + 1}`
  }));
  const archive = await store.writeTranscriptChunks(sessionId, messages);
  await store.writeMetadata({
    id: sessionId,
    status: "completed",
    marker: "committed",
    transcript: { archive, messages }
  });

  const orphan = path.join(store.root, `.${sessionId}.interrupted.tmp`);
  await fs.writeFile(orphan, "{partial", "utf8");
  const committed = await store.readMetadataExact(sessionId);
  invariant(committed.ok === true && committed.metadata.marker === "committed", "committed session snapshot was not recoverable");

  const staleLock = path.join(store.root, `.${sessionId}.metadata.ant-code.lock`);
  await fs.mkdir(staleLock, { recursive: true });
  await fs.writeFile(path.join(staleLock, "owner.json"), `${JSON.stringify({
    token: "abandoned-soak-lock",
    pid: 99_999_999,
    hostname: os.hostname(),
    createdAt: new Date(0).toISOString()
  })}\n`, "utf8");
  const staleAt = new Date(Date.now() - 60_000);
  await fs.utimes(staleLock, staleAt, staleAt);
  await store.writeMetadata({
    id: sessionId,
    status: "completed",
    marker: "recovered",
    transcript: { archive, messages }
  });
  const recovered = await store.readMetadataExact(sessionId);
  invariant(recovered.ok === true && recovered.metadata.marker === "recovered", "stale storage lock was not recovered");
  await fs.rm(orphan, { force: true });
  const deleted = await store.deleteSession(sessionId);
  invariant(deleted.ok === true, "soak session cleanup failed");
}

async function runTerminalScenario(context, iteration) {
  const suffix = Math.abs(iteration) % 8;
  const taskId = `${context.runId}-cancel-${suffix}`;
  const instanceId = `instance-${iteration}-${Date.now()}`;
  const identity = `identity-${suffix}`;
  registerBackgroundTerminalTask({
    taskId,
    instanceId,
    cwd: context.cwd,
    pid: 424_242,
    processIdentity: identity,
    status: "running"
  });
  let kills = 0;
  const mismatch = iteration % 2 !== 0;
  const [cancelled] = await cancelBackgroundTerminalTasks({
    cwd: context.cwd,
    taskId,
    refresh: false,
    inspectProcess: async () => ({ alive: true, identity: mismatch ? `${identity}-reused` : identity }),
    terminateProcess: async () => {
      kills += 1;
      return { exited: true };
    }
  });
  invariant(cancelled?.status === (mismatch ? "stale" : "cancelled"), "terminal cancellation identity result was unstable");
  invariant(kills === (mismatch ? 0 : 1), "terminal cancellation invoked an unsafe process kill");

  const reconcileId = `${context.runId}-reconcile-${suffix}`;
  const unregister = registerBackgroundTerminalTask({
    taskId: reconcileId,
    instanceId: `reconcile-${iteration}-${Date.now()}`,
    cwd: context.cwd,
    pid: null,
    status: "running"
  });
  const [reconciled] = listBackgroundTerminalTasks({ cwd: context.cwd, taskId: reconcileId });
  invariant(reconciled?.status === "completed", "terminal liveness reconciliation did not settle a missing pid");
  unregister();
}

async function runDashboardScenario(context, iteration) {
  if (iteration % 2 === 0) {
    const never = new Promise(() => {});
    const runtime = createDashboardRuntime({
      cwd: context.cwd,
      env: { ...context.env, ANT_CODE_DASHBOARD_LIFECYCLE_WAIT_MS: "50" },
      lifecycleActivity: () => never
    });
    try {
      const status = await runtime.lifecycleStatus();
      invariant(status.code === "LIFECYCLE_STATUS_TIMEOUT", "dashboard lifecycle probe did not time out");
      const shutdown = await runtime.shutdown({ timeoutMs: 50 });
      invariant(shutdown.code === "SHUTDOWN_ACTIVITY_TIMEOUT", "dashboard shutdown probe did not time out");
    } finally {
      const forced = await runtime.shutdown({ force: true, timeoutMs: 50 });
      invariant(forced.ok === true, "dashboard force shutdown failed after lifecycle timeout");
    }
    return;
  }

  const gate = deferred();
  const runtime = createDashboardRuntime({
    cwd: context.cwd,
    env: { ...context.env, ANT_CODE_INTERRUPT_FORCE_SETTLE_MS: "60000" },
    lifecycleActivity: async () => ({ total: 1 }),
    runTurn: async () => {
      await gate.promise;
      return { output: "late" };
    }
  });
  try {
    await runtime.trustWorkspace();
    const started = await runtime.startTurn({ prompt: `soak turn ${iteration}`, permissionMode: "plan" });
    invariant(started.ok === true, "dashboard soak turn did not start");
    const timedOut = await runtime.shutdown({ cancelActive: true, timeoutMs: 75 });
    invariant(timedOut.code === "SHUTDOWN_TIMEOUT", "dashboard active cancellation did not hit its bounded timeout");
    const forced = await runtime.shutdown({ force: true, timeoutMs: 75 });
    invariant(forced.ok === true && runtime.active.size === 0, "dashboard force shutdown did not release active state");
  } finally {
    gate.resolve();
    if (runtime.active.size > 0) {
      await runtime.shutdown({ force: true, timeoutMs: 75 }).catch(() => {});
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function runGatewayScenario(iteration) {
  if (iteration % 3 === 0) {
    let cancelled = false;
    const controller = new AbortController();
    const body = new ReadableStream({ cancel() { cancelled = true; } });
    const pending = parseGatewayStream(body, "text/event-stream", { signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    await expectError(pending, (error) => error?.name === "AbortError", "gateway stalled body did not abort");
    invariant(cancelled && !body.locked, "gateway stalled body retained its reader lock");
    return;
  }
  if (iteration % 3 === 1) {
    let cancelled = false;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'data: {"id":"chatcmpl-soak","choices":[{"delta":{"content":"blocked"}}]}\n\n'
        ));
      },
      cancel() {
        cancelled = true;
      }
    });
    const pending = parseOpenAIChatCompletionStream(body, {
      eventTimeoutMs: 10,
      onEvent: () => new Promise(() => {})
    });
    await expectError(pending, (error) => error?.code === "GATEWAY_EVENT_CALLBACK_TIMEOUT", "gateway callback deadline did not fire");
    invariant(cancelled && !body.locked, "gateway callback timeout retained its reader lock");
    return;
  }

  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(2));
    },
    cancel() {
      cancelled = true;
      return new Promise(() => {});
    }
  });
  await expectError(
    parseGatewayStream(body, "application/x-ndjson", { maxResponseBytes: 1 }),
    (error) => error?.code === "GATEWAY_RESPONSE_TOO_LARGE",
    "gateway oversize limit did not fire"
  );
  invariant(cancelled && !body.locked, "gateway oversize cancellation retained its reader lock");
}

function createScenarioStats() {
  return Object.fromEntries(["storage", "terminal", "dashboard", "gateway"].map((name) => [
    name,
    { runs: 0, totalMs: 0, maxMs: 0 }
  ]));
}

function collectSample(samples, label) {
  globalThis.gc?.();
  const memory = process.memoryUsage();
  const handles = activeHandleSummary();
  samples.push({
    label,
    at: Date.now(),
    heapUsed: memory.heapUsed,
    rss: memory.rss,
    handleCount: Object.values(handles).reduce((sum, count) => sum + count, 0),
    handles
  });
}

function activeHandleSummary() {
  const standard = new Set([process.stdin, process.stdout, process.stderr]);
  const handles = typeof process._getActiveHandles === "function" ? process._getActiveHandles() : [];
  const summary = {};
  for (const handle of handles) {
    if (standard.has(handle)) continue;
    const name = handle?.constructor?.name ?? "Unknown";
    summary[name] = (summary[name] ?? 0) + 1;
  }
  return summary;
}

function buildSummary(input) {
  const baseline = input.samples[0];
  const final = input.samples.at(-1);
  const recent = input.samples.slice(Math.max(0, Math.floor(input.samples.length / 2)));
  return {
    ok: true,
    rounds: input.rounds,
    durationMs: final.at - baseline.at,
    gcAvailable: typeof globalThis.gc === "function",
    scenarios: Object.fromEntries(Object.entries(input.scenarioStats).map(([name, stats]) => [name, {
      ...stats,
      averageMs: stats.runs > 0 ? Math.round(stats.totalMs / stats.runs) : 0
    }])),
    unhandledRejections: input.unhandledRejections,
    handles: {
      baseline: baseline.handles,
      final: final.handles,
      net: final.handleCount - baseline.handleCount,
      byTypeNet: handleTypeDelta(baseline.handles, final.handles),
      maxObserved: Math.max(...input.samples.map((sample) => sample.handleCount))
    },
    memory: {
      samples: input.samples.length,
      heapNetBytes: final.heapUsed - baseline.heapUsed,
      heapSlopeBytesPerMinute: Math.round(linearSlope(input.samples, "heapUsed")),
      recentHeapSlopeBytesPerMinute: Math.round(linearSlope(recent, "heapUsed")),
      rssNetBytes: final.rss - baseline.rss,
      rssSlopeBytesPerMinute: Math.round(linearSlope(input.samples, "rss")),
      recentRssSlopeBytesPerMinute: Math.round(linearSlope(recent, "rss"))
    },
    thresholds: {
      maxHandleDelta: input.options.maxHandleDelta,
      maxHeapGrowthBytes: input.options.maxHeapGrowthBytes,
      maxHeapSlopeBytesPerMinute: input.options.maxHeapSlopeBytesPerMinute,
      maxRssGrowthBytes: input.options.maxRssGrowthBytes,
      maxRssSlopeBytesPerMinute: input.options.maxRssSlopeBytesPerMinute
    }
  };
}

function assertReliabilityGates(summary) {
  invariant(summary.rounds > 0, "soak completed no measured rounds");
  invariant(summary.unhandledRejections.length === 0, `unhandled rejections: ${JSON.stringify(summary.unhandledRejections)}`);
  invariant(summary.handles.net <= summary.thresholds.maxHandleDelta, `active handle net growth ${summary.handles.net} exceeded ${summary.thresholds.maxHandleDelta}`);
  const heapTrendExceeded = summary.memory.samples >= 5
    && summary.memory.heapSlopeBytesPerMinute > summary.thresholds.maxHeapSlopeBytesPerMinute
    && summary.memory.recentHeapSlopeBytesPerMinute > summary.thresholds.maxHeapSlopeBytesPerMinute;
  invariant(!(heapTrendExceeded && summary.memory.heapNetBytes > summary.thresholds.maxHeapGrowthBytes), "heap growth and multi-window trend both exceeded reliability thresholds");
  const rssTrendExceeded = summary.memory.samples >= 5
    && summary.memory.rssSlopeBytesPerMinute > summary.thresholds.maxRssSlopeBytesPerMinute
    && summary.memory.recentRssSlopeBytesPerMinute > summary.thresholds.maxRssSlopeBytesPerMinute;
  invariant(!(rssTrendExceeded && summary.memory.rssNetBytes > summary.thresholds.maxRssGrowthBytes), "RSS growth and multi-window trend both exceeded reliability thresholds");
}

function handleTypeDelta(baseline, final) {
  const names = new Set([...Object.keys(baseline), ...Object.keys(final)]);
  return Object.fromEntries([...names].sort().map((name) => [name, (final[name] ?? 0) - (baseline[name] ?? 0)]));
}

function linearSlope(samples, field) {
  if (samples.length < 2) return 0;
  const startedAt = samples[0].at;
  const points = samples.map((sample) => ({
    x: (sample.at - startedAt) / 60_000,
    y: sample[field]
  }));
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  const denominator = points.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0);
  if (denominator === 0) return 0;
  return points.reduce((sum, point) => sum + (point.x - meanX) * (point.y - meanY), 0) / denominator;
}

function normalizeOptions(input) {
  const iterations = Number.isInteger(input.iterations) && input.iterations > 0 ? input.iterations : null;
  return {
    iterations,
    durationMs: positiveInteger(input.durationMs, DEFAULT_SHORT_DURATION_MS),
    scenarioTimeoutMs: positiveInteger(input.scenarioTimeoutMs, DEFAULT_SCENARIO_TIMEOUT_MS),
    sampleIntervalMs: positiveInteger(input.sampleIntervalMs, DEFAULT_SAMPLE_INTERVAL_MS),
    maxHandleDelta: nonNegativeNumber(input.maxHandleDelta, 2),
    maxHeapGrowthBytes: positiveNumber(input.maxHeapGrowthBytes, 32 * MIB),
    maxHeapSlopeBytesPerMinute: positiveNumber(input.maxHeapSlopeBytesPerMinute, 16 * MIB),
    maxRssGrowthBytes: positiveNumber(input.maxRssGrowthBytes, 256 * MIB),
    maxRssSlopeBytesPerMinute: positiveNumber(input.maxRssSlopeBytesPerMinute, 128 * MIB)
  };
}

function withDeadline(promise, timeoutMs, label) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function expectError(promise, predicate, message) {
  try {
    await promise;
  } catch (error) {
    invariant(predicate(error), `${message}: ${errorSummary(error).message}`);
    return error;
  }
  throw new Error(message);
}

function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function settleRuntime() {
  return new Promise((resolve) => setTimeout(resolve, 50));
}

function invariant(condition, message) {
  if (!condition) {
    throw Object.assign(new Error(message), { code: "RELIABILITY_SOAK_FAILED" });
  }
}

function errorSummary(error) {
  return {
    name: error instanceof Error ? error.name : typeof error,
    code: error && typeof error === "object" && "code" in error ? String(error.code ?? "") : "",
    message: error instanceof Error ? error.message : String(error)
  };
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function nonNegativeNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function cliOptions(args, env) {
  const long = args.includes("--long");
  const duration = optionValue(args, "--duration-ms") ?? env.ANT_CODE_RELIABILITY_SOAK_DURATION_MS;
  const iterations = optionValue(args, "--iterations");
  return {
    durationMs: positiveInteger(duration, long ? DEFAULT_LONG_DURATION_MS : DEFAULT_SHORT_DURATION_MS),
    iterations: iterations === undefined ? undefined : positiveInteger(iterations, null),
    scenarioTimeoutMs: positiveInteger(env.ANT_CODE_RELIABILITY_SCENARIO_TIMEOUT_MS, DEFAULT_SCENARIO_TIMEOUT_MS),
    sampleIntervalMs: positiveInteger(env.ANT_CODE_RELIABILITY_SAMPLE_INTERVAL_MS, DEFAULT_SAMPLE_INTERVAL_MS),
    maxHandleDelta: nonNegativeNumber(env.ANT_CODE_RELIABILITY_MAX_HANDLE_DELTA, 2),
    maxHeapGrowthBytes: positiveNumber(env.ANT_CODE_RELIABILITY_MAX_HEAP_GROWTH_MIB, 32) * MIB,
    maxHeapSlopeBytesPerMinute: positiveNumber(env.ANT_CODE_RELIABILITY_MAX_HEAP_SLOPE_MIB_MIN, 16) * MIB,
    maxRssGrowthBytes: positiveNumber(env.ANT_CODE_RELIABILITY_MAX_RSS_GROWTH_MIB, 256) * MIB,
    maxRssSlopeBytesPerMinute: positiveNumber(env.ANT_CODE_RELIABILITY_MAX_RSS_SLOPE_MIB_MIN, 128) * MIB
  };
}

function optionValue(args, name) {
  const direct = args.find((argument) => argument.startsWith(`${name}=`));
  if (direct) return direct.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log([
      "Usage: node --expose-gc tests/soak/reliability-soak.js [--duration-ms 90000] [--iterations 3] [--long]",
      "Short default: 90 seconds. --long default: 30 minutes.",
      "Duration and thresholds can also be set with ANT_CODE_RELIABILITY_* environment variables."
    ].join("\n"));
    return;
  }
  const summary = await runReliabilitySoak(cliOptions(process.argv.slice(2), process.env));
  console.log(JSON.stringify(summary, null, 2));
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await main();
}
