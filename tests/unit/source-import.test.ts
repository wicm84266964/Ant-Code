import assert from "node:assert/strict";
import test from "node:test";
import { refreshProviderScope } from "../../src/dashboard/runtime/source-import.ts";

test("catalog refresh updates the layer that already owns a legacy provider", () => {
  assert.equal(refreshProviderScope({ requested: "global", owner: "project" }), "project");
  assert.equal(refreshProviderScope({ requested: "project", owner: "global" }), "global");
  assert.equal(refreshProviderScope({ requested: "project", owner: "" }), "project");
  assert.equal(refreshProviderScope({ requested: undefined, owner: undefined }), "global");
});
