import assert from "node:assert/strict";
import test from "node:test";
import { renderStructuredData } from "../../src/dashboard/public/structured-data.js";

test("dashboard structured data renders json trees", () => {
  const result = renderStructuredData("json", JSON.stringify({
    ok: true,
    count: 2,
    items: [{ name: "样本" }]
  }));

  assert.equal(result.ok, true);
  assert.match(result.summary, /对象 · 3 字段/);
  assert.match(result.html, /class="data-node"/);
  assert.match(result.html, /class="data-key">items/);
});

test("dashboard structured data renders yaml through provided vendor parser", () => {
  const result = renderStructuredData("yaml", "ok: true\ncount: 2\n", {
    parseYaml: (value) => Object.fromEntries(value.trim().split(/\n/).map((line) => {
      const [key, raw] = line.split(/:\s*/);
      return [key, raw === "true" ? true : Number(raw)];
    }))
  });

  assert.equal(result.ok, true);
  assert.match(result.summary, /YAML/);
  assert.match(result.html, /class="data-key">ok/);
});

test("dashboard structured data renders csv and tsv tables", () => {
  const csv = renderStructuredData("csv", "name,value\n\"sample, A\",12\n");
  const tsv = renderStructuredData("tsv", "name\tvalue\nsample\t12\n");

  assert.equal(csv.ok, true);
  assert.match(csv.html, /class="data-table"/);
  assert.match(csv.html, /sample, A/);
  assert.match(csv.tsv, /sample, A\t12/);
  assert.equal(tsv.ok, true);
  assert.match(tsv.summary, /TSV/);
});

test("dashboard structured data fails safely", () => {
  const result = renderStructuredData("json", "{bad");

  assert.equal(result.ok, false);
  assert.match(result.html, /data-error/);
  assert.doesNotMatch(result.html, /<script>/);
});
