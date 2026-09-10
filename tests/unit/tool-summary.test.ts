import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readToolEvidence, reserveRatio, summarizeToolBatch, toolSummaryState } from "../../src/core/tool-summary.ts";
import { createSessionStore } from "../../src/storage/session-store.ts";
import { mapSessionEventToDashboard } from "../../src/dashboard/events.ts";
import type { AgentSession, SessionMessage } from "../../src/core/session-types.ts";
import { preparePromptBudgetForGateway } from "../../src/core/session-health.ts";
import { formatToolResultForModel } from "../../src/tools/result-view.ts";

async function fixture(t: test.TestContext, enabled = true) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ant-tool-summary-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const session = { id: "summary-test", cwd, config: { transcript: { enabled, retentionDays: 7, encryption: "off" } }, contextWindow: { maxBytes: 2000000, maxTokens: 500000 }, model: "mock", usage: {} } as AgentSession;
  const messages: SessionMessage[] = Array.from({ length: 10 }, (_, i) => ({ role: "tool", name: "read_file", toolCallId: `call-${i}`, content: `file-${i}: value=3.14159 units=mg\n` + "source data\n".repeat(1000) }));
  const gateway = { configured: true, sendChat: async () => ({ ok: true, data: { text: "Files contain measured value 3.14159 mg. Original records remain authoritative.", usage: { input_tokens: 100, output_tokens: 20 } } }) };
  return { session, messages, gateway, neededBytes: 30000 };
}

test("reserve adapts to recent growth with 10-20 percent bounds", () => {
  assert.equal(reserveRatio([], 500000), 0.1);
  assert.equal(reserveRatio([80000, 80000, 80000], 500000, 10000), 0.14);
  assert.equal(reserveRatio([1000000], 500000), 0.2);
});

test("batch summary preserves recent results and restores exact evidence after restart", async (t) => {
  const input = await fixture(t);
  const originals = structuredClone(input.messages);
  const result = await summarizeToolBatch(input);
  assert.ok(result && result.afterBytes < result.beforeBytes);
  assert.deepEqual(input.messages.slice(-4), originals.slice(-4));
  const state = await toolSummaryState(input.session);
  const id = Object.keys(state.evidence)[0];
  const store = createSessionStore({ cwd: input.session.cwd, transcript: input.session.config.transcript });
  await store.writeMetadata({ id: input.session.id, transcript: { toolSummaries: state } });
  const resumed = { ...input.session };
  let offset = 0;
  let restored = "";
  for (;;) {
    const page = await readToolEvidence(resumed, { evidenceId: id, item: 0, offset, maxChars: 777 });
    assert.ok(page.ok);
    if (!page.ok || !("result" in page)) throw new Error("missing evidence");
    restored += page.result.content;
    if (page.result.nextOffset === null) break;
    offset = page.result.nextOffset;
  }
  assert.equal(restored, originals[0].content);
  assert.equal((await readToolEvidence(resumed, { evidenceId: "../../other-session" })).ok, false);
  await store.deleteSession(input.session.id);
  assert.equal(await fs.stat(path.join(store.root, `${input.session.id}.tool-evidence`)).then(() => true, () => false), false);
});

test("failed, oversized and cancelled summaries never replace tool text", async (t) => {
  for (const mode of ["failed", "oversized", "cancelled"] as const) {
    const input = await fixture(t);
    const original = structuredClone(input.messages);
    const controller = new AbortController();
    input.gateway.sendChat = async () => {
      if (mode === "cancelled") controller.abort();
      return { ok: mode !== "failed", data: { text: mode === "oversized" ? "x".repeat(100000) : "summary", usage: { input_tokens: 1, output_tokens: 1 } } };
    };
    assert.equal(await summarizeToolBatch({ ...input, signal: controller.signal }), null);
    assert.deepEqual(input.messages, original);
  }
});

test("errors remain original and disabled retention does not silently discard evidence", async (t) => {
  const input = await fixture(t, false);
  input.messages[0].content = "ok=false error=validation failed\n" + "diagnostic".repeat(2000);
  const original = structuredClone(input.messages);
  assert.equal(await summarizeToolBatch(input), null);
  assert.deepEqual(input.messages, original);
});

test("tool summaries do not create a conversation compaction boundary", () => {
  const events = mapSessionEventToDashboard({ type: "tool_results_summarized", beforeTokens: 500000, afterTokens: 440000 });
  assert.ok(events.length);
  assert.equal(events.some((e) => e.type === "context_boundary"), false);
  assert.match(JSON.stringify(events), /工具结果已摘要/);
});

test("prompt budget batches to reserve space and does not summarize again without growth", async (t) => {
  const input = await fixture(t);
  input.session.contextWindow.maxBytes = 100000;
  input.session.contextWindow.maxTokens = 25000;
  input.session.context = { tools: [] } as unknown as AgentSession["context"];
  input.session.messages = [];
  input.session.config.context = {} as AgentSession["config"]["context"];
  let calls = 0;
  const send = input.gateway.sendChat;
  input.gateway.sendChat = async () => { calls++; return send(); };
  const toolResults = input.messages.map((m) => ({ toolCallId: m.toolCallId, content: m.content }));
  const budgetInput = { ...input, toolResults, prompt: "continue", round: 1, eventOptions: {} } as unknown as Parameters<typeof preparePromptBudgetForGateway>[0];
  const first = await preparePromptBudgetForGateway(budgetInput);
  assert.equal(first.blocked, false);
  assert.ok(first.estimate.bytes < 90000);
  assert.ok(calls > 0);
  const previousCalls = calls;
  await preparePromptBudgetForGateway({ ...budgetInput, messages: first.messages, round: 2 });
  assert.equal(calls, previousCalls);
  assert.match(String(toolResults[0].content), /tool results summary/);
});

test("evidence uses required encryption and follows the model-visible page boundary", async (t) => {
  const input = await fixture(t);
  input.session.config.transcript.encryption = "required";
  const env = { LAB_AGENT_TRANSCRIPT_KEY: "test-only-evidence-key" };
  assert.ok(await summarizeToolBatch({ ...input, env }));
  const state = await toolSummaryState(input.session, env);
  const id = Object.keys(state.evidence)[0];
  const files = await fs.readdir(path.join(input.session.cwd, ".lab-agent/sessions/summary-test.tool-evidence"));
  assert.ok(files.every((f) => f.endsWith(".enc")));
  const page = await readToolEvidence(input.session, { evidenceId: id }, env);
  const view = formatToolResultForModel("tool_result_read", page, { maxBytes: 1200 });
  const next = Number(/nextOffset=(\d+)/.exec(view.content)?.[1]);
  assert.ok(next > 0 && next < 4000);
  assert.doesNotMatch(view.content, /\ufffd/);
});
