import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import {
  cheapModelForSessionTitle,
  generateSessionTitle,
  normalizeGeneratedSessionTitle,
  shouldGenerateDashboardSessionTitle,
  sessionTitlePrompt
} from "../../src/dashboard/runtime/session-title.ts";

test("session title helper keeps short names and strips quotes", () => {
  assert.equal(normalizeGeneratedSessionTitle("  “修复登录超时”  "), "修复登录超时");
  assert.equal(normalizeGeneratedSessionTitle("标题：导出报表\n第二行"), "导出报表");
  assert.equal(normalizeGeneratedSessionTitle("只输出标题本身"), null);
  assert.equal(normalizeGeneratedSessionTitle("不要解释这次任务"), null);
  assert.equal(normalizeGeneratedSessionTitle(""), null);
  const long = "这是一段明显超过侧栏可用长度所以必须被截断处理的会话名称文本";
  const normalized = normalizeGeneratedSessionTitle(long);
  assert.ok(normalized.endsWith("…"));
  assert.ok([...normalized].length <= 28);
});

test("session title generation requires a cheap model and the first user prompt", () => {
  const config = {
    modelAlias: "main-model",
    agents: { modelTiers: { cheap: "cheap-model", default: "main-model" } }
  };
  assert.equal(cheapModelForSessionTitle(config), "cheap-model");
  assert.equal(cheapModelForSessionTitle({ modelAlias: "main-model" }), "");
  assert.equal(shouldGenerateDashboardSessionTitle({
    turnCount: 0,
    config
  }, { kind: "prompt", prompt: "整理实验记录" }), true);
  assert.equal(shouldGenerateDashboardSessionTitle({
    turnCount: 1,
    config
  }, { kind: "prompt", prompt: "整理实验记录" }), false);
  assert.equal(shouldGenerateDashboardSessionTitle({
    turnCount: 0,
    titleSource: "model",
    config
  }, { kind: "prompt", prompt: "整理实验记录" }), false);
  assert.equal(shouldGenerateDashboardSessionTitle({
    turnCount: 0,
    config
  }, { kind: "guide", prompt: "继续" }), false);
  assert.equal(shouldGenerateDashboardSessionTitle({
    turnCount: 0,
    config: { modelAlias: "main-model" }
  }, { kind: "prompt", prompt: "整理实验记录" }), false);
  assert.match(sessionTitlePrompt("整理实验记录"), /整理实验记录/);
});

test("session title generation reads a cheap-model completion", async () => {
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) {
      // Drain request body.
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "title-response",
      model: "cheap-model",
      content: [{ type: "text", text: "实验记录整理" }]
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    const title = await generateSessionTitle({
      config: {
        modelAlias: "main-model",
        networkMode: "full",
        allowedHosts: ["127.0.0.1"],
        agents: { modelTiers: { cheap: "cheap-model" } },
        lab: {
          gatewayUrl: `http://127.0.0.1:${address.port}`,
          gatewayProtocol: "lab-agent-gateway",
          gatewayMaxRetries: 0
        }
      },
      prompt: "请帮我整理今天的实验记录"
    });
    assert.equal(title, "实验记录整理");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
