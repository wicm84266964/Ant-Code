import assert from "node:assert/strict";
import test from "node:test";
import { resolveTheme, themeColor, themeNames } from "../../src/cli/tui/theme.ts";

test("theme registry exposes built-in stage 1 themes", () => {
  assert.deepEqual(themeNames(), ["gold-black", "sky-blue", "ant-code", "terminal-default", "no-color"]);

  const gold = resolveTheme("gold-black");
  assert.equal(gold.label, "Gold Black");
  assert.equal(themeColor(gold, "identity"), "#e8c547");
  assert.equal(themeColor(gold, "success"), "#e8c547");
  assert.equal(themeColor(gold, "status"), "#e8c547");

  const sky = resolveTheme("sky-blue");
  assert.equal(sky.label, "Sky Blue");
  assert.equal(themeColor(sky, "identity"), "#38bdf8");
  assert.equal(themeColor(sky, "danger"), "#ef4444");
});

test("theme resolver falls back safely and supports no-color mode", () => {
  assert.equal(resolveTheme("missing").name, "gold-black");
  assert.equal(resolveTheme("ant-code").colors.identity, "cyan");
  assert.equal(resolveTheme("sky-blue", { noColor: true }).name, "no-color");
  assert.equal(themeColor(resolveTheme("no-color"), "identity", "cyan"), undefined);
});
