import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { probeCatalogReasoningLevels } from "../../src/dashboard/runtime/gateway-probe.ts";
import { highestListedReasoningEffort, supportedEffortIdsFromRejection } from "../../src/model-gateway/reasoning-capabilities.ts";
import { savedRouteDisplayName } from "../../src/dashboard/runtime/source-import.ts";

test("saved route display name keeps the existing name when the edit form is blank", () => {
  assert.equal(savedRouteDisplayName("  work  ", "old", "provider"), "work");
  assert.equal(savedRouteDisplayName("   ", "GPT", "provider-1"), "GPT");
  assert.equal(savedRouteDisplayName(undefined, "", "provider-1"), "provider-1");
});

test("rejection text can name the thinking levels a route accepts", () => {
  const ids = supportedEffortIdsFromRejection({
    error: { message: "Invalid value. Supported values are: 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', and 'max'." }
  });
  assert.deepEqual(ids, ["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
  assert.equal(highestListedReasoningEffort(ids, "max"), "xhigh");
});

test("catalog reasoning probe returns accepted levels and ignores generated text", async () => {
  const generated = "generated text that must never leave the catalog probe";
  const server = await listen(http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const effort = String(body.reasoning_effort ?? "");
    if (effort === "antcode_invalid_effort_probe" || effort === "ultra" || effort === "none" || effort === "off") {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { param: "reasoning_effort", message: "unsupported" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      choices: [{ message: { role: "assistant", content: generated, reasoning_content: effort === "max" ? "step" : "" } }]
    }));
  }));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const result = await probeCatalogReasoningLevels({
      gatewayUrl: `${origin}/v1/chat/completions`,
      gatewayProtocol: "openai-chat",
      modelId: "gpt-5.6"
    }, { lab: {} }, undefined);
    assert.equal(result.ok, true);
    assert.deepEqual(
      (result.reasoningEfforts ?? []).map((effort) => effort.id),
      ["low", "medium", "high", "xhigh", "max"]
    );
    assert.equal(result.reasoningDiscovery.supportsReasoning, true);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(generated, "i"));
  } finally {
    await close(server);
  }
});

function listen(server: http.Server) {
  return new Promise<http.Server>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function close(server: http.Server) {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
