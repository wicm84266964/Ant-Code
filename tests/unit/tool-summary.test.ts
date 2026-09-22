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
import { createWorkflowState } from "../../src/tools/workflow-tools.ts";

async function fixture(t: test.TestContext, enabled = true) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ant-tool-summary-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const session = { id: "summary-test", cwd, config: { transcript: { enabled, retentionDays: 7, encryption: "off" } }, contextWindow: { maxBytes: 2000000, maxTokens: 500000 }, model: "mock", usage: {}, workflow: createWorkflowState() } as AgentSession;
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

function hugeToolMessages(count: number, chars = 12000): SessionMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    role: "tool",
    name: "read_file",
    toolCallId: `overflow-${index}`,
    content: `file-${index}.json\n${"layout-contract ".repeat(Math.ceil(chars / 16))}`
  }));
}

test("prompt budget falls back to in-flight tool compaction instead of overflowing", async (t) => {
  const input = await fixture(t);
  input.session.contextWindow.maxBytes = 24000;
  input.session.contextWindow.maxTokens = 6000;
  input.session.contextWindow.keepRecentMessages = 4;
  input.session.context = { tools: [] } as unknown as AgentSession["context"];
  input.session.messages = [];
  input.session.config.context = {} as AgentSession["config"]["context"];
  input.session.turnCount = 5;
  const events: Array<Record<string, unknown>> = [];
  const live = [
    { role: "user", content: "continue the deck" },
    ...hugeToolMessages(8)
  ];
  const toolResults = live.filter((message) => message.role === "tool").map((message) => ({
    toolCallId: message.toolCallId,
    content: message.content
  }));
  const result = await preparePromptBudgetForGateway({
    ...input,
    messages: live,
    toolResults,
    prompt: "continue the deck",
    round: 48,
    eventOptions: { onEvent: (event) => events.push(event) }
  } as unknown as Parameters<typeof preparePromptBudgetForGateway>[0]);
  assert.equal(result.blocked, false);
  assert.ok(result.estimate.tokens < 6000);
  assert.equal(events.some((event) => event.strategy === "inflight-tools"), true);
  assert.equal(events.some((event) => event.type === "context_overflow"), false);
  assert.ok(result.messages.filter((message) => message.role === "tool").some((message) => (
    JSON.stringify(message.content).includes("[compacted tool result]")
  )));
});

test("later rounds still shrink live tools after history fingerprint would skip", async (t) => {
  const input = await fixture(t);
  input.session.contextWindow.maxBytes = 24000;
  input.session.contextWindow.maxTokens = 6000;
  input.session.contextWindow.keepRecentMessages = 4;
  input.session.context = { tools: [] } as unknown as AgentSession["context"];
  input.session.messages = [
    { role: "user", content: "start" },
    { role: "assistant", content: "ok" }
  ];
  input.session.config.context = {} as AgentSession["config"]["context"];
  const events: Array<Record<string, unknown>> = [];
  const budgetInput = {
    ...input,
    prompt: "continue the deck",
    eventOptions: { onEvent: (event) => events.push(event) }
  };

  const firstLive = [
    { role: "user", content: "continue the deck" },
    ...hugeToolMessages(6)
  ];
  const first = await preparePromptBudgetForGateway({
    ...budgetInput,
    messages: firstLive,
    toolResults: firstLive.filter((message) => message.role === "tool").map((message) => ({
      toolCallId: message.toolCallId,
      content: message.content
    })),
    round: 40
  } as unknown as Parameters<typeof preparePromptBudgetForGateway>[0]);
  assert.equal(first.blocked, false);
  assert.deepEqual(input.session.messages, [
    { role: "user", content: "start" },
    { role: "assistant", content: "ok" }
  ]);

  const grown = [
    ...first.messages,
    ...hugeToolMessages(4, 16000).map((message, index) => ({
      ...message,
      toolCallId: `grown-${index}`
    }))
  ];
  const second = await preparePromptBudgetForGateway({
    ...budgetInput,
    messages: grown,
    toolResults: grown.filter((message) => message.role === "tool").map((message) => ({
      toolCallId: message.toolCallId,
      content: message.content
    })),
    round: 41
  } as unknown as Parameters<typeof preparePromptBudgetForGateway>[0]);
  assert.equal(second.blocked, false);
  assert.ok(second.estimate.tokens < 6000);
  assert.equal(events.some((event) => event.strategy === "inflight-tools"), true);
});

test("history compact shrinks the current-turn tool chain instead of reattaching it raw", async (t) => {
  const input = await fixture(t);
  input.session.contextWindow.maxBytes = 32000;
  input.session.contextWindow.maxTokens = 8000;
  input.session.contextWindow.keepRecentMessages = 8;
  input.session.contextWindow.tailTurns = 1;
  input.session.contextWindow.preserveRecentTokens = 200;
  input.session.context = { tools: [] } as unknown as AgentSession["context"];
  input.session.messages = Array.from({ length: 16 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `history-${index} ${"note ".repeat(40)}`
  }));
  input.session.config.context = {} as AgentSession["config"]["context"];
  const events: Array<Record<string, unknown>> = [];
  const live: SessionMessage[] = [
    ...input.session.messages,
    { role: "user", content: "continue the deck" },
    ...Array.from({ length: 6 }, (_, index) => ([
      {
        role: "assistant",
        content: [],
        toolCalls: [{ id: `overflow-${index}`, name: "read_file", input: {} }]
      },
      ...hugeToolMessages(1, 14000).map((message) => ({ ...message, toolCallId: `overflow-${index}` }))
    ])).flat()
  ];
  const result = await preparePromptBudgetForGateway({
    ...input,
    messages: live,
    toolResults: live.filter((message) => message.role === "tool").map((message) => ({
      toolCallId: message.toolCallId,
      content: message.content
    })),
    prompt: "continue the deck",
    round: 12,
    eventOptions: { onEvent: (event) => events.push(event) }
  } as unknown as Parameters<typeof preparePromptBudgetForGateway>[0]);
  assert.equal(result.blocked, false);
  assert.ok(result.estimate.tokens < 8000);
  const continuationTools = result.messages.filter((message) => message.role === "tool");
  assert.ok(continuationTools.length >= 1);
  assert.ok(continuationTools.length < 6);
  assert.ok(String(input.session.contextWindow.summary ?? "").length > 0);
});

test("prompt budget strips older thinking when compacted tools still overflow", async (t) => {
  const input = await fixture(t);
  input.session.contextWindow.maxBytes = 32000;
  input.session.contextWindow.maxTokens = 8000;
  input.session.context = { tools: [] } as unknown as AgentSession["context"];
  input.session.messages = [];
  input.session.config.context = {} as AgentSession["config"]["context"];
  const events: Array<Record<string, unknown>> = [];
  const live: SessionMessage[] = [{ role: "user", content: "continue the deck" }];
  for (let index = 0; index < 18; index += 1) {
    live.push({
      role: "assistant",
      content: [],
      toolCalls: [{ id: `think-${index}`, name: "bash", input: { command: "true" } }],
      thinking: { text: "internal plan ".repeat(800), bytes: 11200 }
    });
    live.push({
      role: "tool",
      toolCallId: `think-${index}`,
      name: "bash",
      content: "[compacted tool result]\ntool=bash\nok=true"
    });
  }
  const result = await preparePromptBudgetForGateway({
    ...input,
    messages: live,
    toolResults: live.filter((message) => message.role === "tool").map((message) => ({
      toolCallId: message.toolCallId,
      content: message.content
    })),
    prompt: "continue the deck",
    round: 38,
    eventOptions: { onEvent: (event) => events.push(event) }
  } as unknown as Parameters<typeof preparePromptBudgetForGateway>[0]);
  assert.equal(result.blocked, false);
  assert.ok(result.estimate.tokens < 8000);
  assert.ok(result.messages.filter((message) => message.role === "assistant" && message.thinking).length <= 1);
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
