import assert from "node:assert/strict";
import test from "node:test";
import {
  createVisualEvidenceStore,
  distillLiveImageBlocks,
  extractImagePayloads,
  pendingVisualEvidence,
  registerVisualEvidence,
  resolveVisualEvidence
} from "../../src/core/visual-evidence.ts";
import { formatToolResultForModel } from "../../src/tools/result-view.ts";

test("registerVisualEvidence de-duplicates by digest and keeps pixels in memory", () => {
  const store = createVisualEvidenceStore();
  const first = registerVisualEvidence(store, {
    source: "user",
    name: "shot.png",
    mimeType: "image/png",
    data: "aGVsbG8="
  });
  const second = registerVisualEvidence(store, {
    source: "user",
    name: "shot-copy.png",
    mimeType: "image/png",
    data: "aGVsbG8="
  });

  assert.equal(store.items.length, 1);
  assert.equal(first?.id, "vis-1");
  assert.equal(second?.id, "vis-1");
  assert.equal(first?.data, "aGVsbG8=");
});

test("distillLiveImageBlocks replaces pixel blocks with evidence stubs", () => {
  const store = createVisualEvidenceStore();
  const messages = [{
    role: "user",
    content: [
      { type: "text", text: "what is this?" },
      { type: "image", name: "tiny.png", mimeType: "image/png", data: "aGVsbG8=", size: 5 }
    ]
  }];

  distillLiveImageBlocks(messages, store);

  assert.equal(store.items[0].status, "distilled");
  assert.equal(messages[0].content[1].type, "text");
  assert.match(String(messages[0].content[1].text), /visual evidence vis-1/);
  assert.doesNotMatch(JSON.stringify(messages), /aGVsbG8=/);
  assert.equal(pendingVisualEvidence(store)[0].data, "aGVsbG8=");
});

test("extractImagePayloads lifts MCP image content", () => {
  const images = extractImagePayloads({
    ok: true,
    result: {
      content: [
        { type: "text", text: "captured" },
        { type: "image", mimeType: "image/png", data: "QQ==", name: "page.png" }
      ]
    }
  });

  assert.equal(images.length, 1);
  assert.equal(images[0].name, "page.png");
  assert.equal(images[0].data, "QQ==");
});

test("tool result view can name registered visual evidence without pixels", () => {
  const serialized = formatToolResultForModel("mcp_call", {
    ok: true,
    result: {
      content: [{ type: "image", mimeType: "image/png", data: "A".repeat(80) }]
    }
  }, {
    evidence: [{ id: "vis-3", name: "page.png", bytes: 80 }]
  });

  assert.match(serialized.content, /evidence=vis-3/);
  assert.doesNotMatch(serialized.content, /AAAA/);
});

test("resolveVisualEvidence returns the requested ids", () => {
  const store = createVisualEvidenceStore();
  registerVisualEvidence(store, { source: "user", name: "a.png", mimeType: "image/png", data: "YQ==" });
  registerVisualEvidence(store, { source: "mcp", name: "b.png", mimeType: "image/png", data: "Yg==" });

  const resolved = resolveVisualEvidence(store, ["vis-2"]);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].name, "b.png");
});
