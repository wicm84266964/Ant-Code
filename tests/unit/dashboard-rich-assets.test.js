import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

test("dashboard mermaid vendor suppresses global error rendering", async () => {
  const source = await fs.readFile("src/dashboard/vendor/rich-entry.js", "utf8");
  const bundle = await fs.readFile("src/dashboard/public/vendor/rich-renderers.js", "utf8");
  const hydrator = await fs.readFile("src/dashboard/public/rich-renderers.js", "utf8");

  assert.match(source, /suppressErrorRendering:\s*true/);
  assert.match(bundle, /suppressErrorRendering:!0|suppressErrorRendering:\s*true/);
  assert.match(hydrator, /output\.dataset\.rendered\s*=\s*"true"/);
});
