import assert from "node:assert/strict";
import test from "node:test";
import { resolveTheme, themeColor, themeNames } from "../../src/cli/tui/theme.js";

test("theme registry exposes built-in stage 1 themes", () => {
  assert.deepEqual(themeNames(), ["sky-blue", "ant-code", "terminal-default", "no-color"]);

  const sky = resolveTheme("sky-blue");
  assert.equal(sky.label, "Sky Blue");
  assert.equal(themeColor(sky, "identity"), "#38bdf8");
  assert.equal(themeColor(sky, "danger"), "#ef4444");
});

test("theme resolver falls back safely and supports no-color mode", () => {
  assert.equal(resolveTheme("missing").name, "sky-blue");
  assert.equal(resolveTheme("ant-code").colors.identity, "cyan");
  assert.equal(resolveTheme("sky-blue", { noColor: true }).name, "no-color");
  assert.equal(themeColor(resolveTheme("no-color"), "identity", "cyan"), undefined);
});
