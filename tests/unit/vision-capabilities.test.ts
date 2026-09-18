import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import {
  classifyModelVisionEvidence,
  inferModelSupportsImages,
  interpretVisionProbeError,
  needsVisionCapabilityProbe,
  resolveModelSupportsImages
} from "../../src/model-gateway/vision-capabilities.ts";
import { modelSupportsImages } from "../../src/core/session-messages.ts";

test("DeepSeek V4.1 Flash is uncertain until catalog or a vision probe says so", () => {
  assert.equal(classifyModelVisionEvidence("deepseek-v4.1-flash"), "uncertain");
  assert.equal(needsVisionCapabilityProbe("deepseek-v4.1-flash"), true);
  assert.equal(inferModelSupportsImages("deepseek-v4.1-flash"), false);
  assert.equal(classifyModelVisionEvidence("deepseek-v4.1-flash", ["text", "image"]), "catalog");
  assert.equal(needsVisionCapabilityProbe("deepseek-v4.1-flash", ["text", "image"]), false);
  assert.equal(interpretVisionProbeError({
    status: 400,
    message: "This model does not support image input"
  }), "unsupported");
  assert.equal(interpretVisionProbeError({ status: 401, message: "unauthorized" }), "inconclusive");
  assert.equal(interpretVisionProbeError({
    status: 400,
    message: "Gateway returned HTTP 400",
    providerMessage: "this model does not support image input"
  }), "unsupported");
});

test("vision inference uses catalog and explicit hints, otherwise it must probe", () => {
  assert.equal(inferModelSupportsImages("grok-4.6"), false);
  assert.equal(inferModelSupportsImages("qwen3-vl"), true);
  assert.equal(inferModelSupportsImages("gemini-2.5-pro-vision"), true);
  assert.equal(inferModelSupportsImages("gpt-5.6-luna"), false);
  assert.equal(needsVisionCapabilityProbe("grok-4.6"), true);
  assert.equal(needsVisionCapabilityProbe("qwen3-vl"), true);
  assert.equal(needsVisionCapabilityProbe("gpt-5.6-luna"), false);
  assert.equal(needsVisionCapabilityProbe("deepseek-v4.1-flash"), true);
  assert.equal(needsVisionCapabilityProbe("mimo-v2.5-pro"), true);
  assert.equal(resolveModelSupportsImages({
    id: "hy3",
    modalities: ["text", "image"]
  }), true);
  assert.equal(resolveModelSupportsImages({
    id: "grok-4.6",
    modalities: ["text"]
  }), false);
});

test("uncertain vision probe treats accepted image requests as native multimodal", async () => {
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) {}
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "probe",
      model: "deepseek-v4.1-flash",
      content: [{ type: "text", text: "ok" }]
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    const { probeVisionCapability } = await import("../../src/model-gateway/vision-probe.ts");
    const result = await probeVisionCapability({
      config: {
        modelAlias: "deepseek-v4.1-flash",
        networkMode: "full",
        allowedHosts: ["127.0.0.1"],
        lab: {
          gatewayUrl: `http://127.0.0.1:${address.port}`,
          gatewayProtocol: "lab-agent-gateway",
          gatewayMaxRetries: 0
        }
      },
      modelId: "deepseek-v4.1-flash"
    });
    assert.equal(result.supported, true);
    assert.equal(result.reason, "accepted");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("runtime image support follows catalog, not model-family names", () => {
  assert.equal(modelSupportsImages({
    modelAlias: "grok-4.6",
    models: [{ id: "grok-4.6", label: "Grok 4.6", modalities: ["text"] }]
  }, "grok-4.6"), false);
  assert.equal(modelSupportsImages({
    modelAlias: "grok-4.6",
    models: [{ id: "grok-4.6", label: "Grok 4.6", modalities: ["text", "image"] }]
  }, "grok-4.6"), true);
});
