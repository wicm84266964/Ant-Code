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

test("dashboard structured data defers deep branches until explicitly expanded", () => {
  const result = renderStructuredData("json", JSON.stringify({
    first: { second: { third: { fourth: { secret: "not eager" } } } }
  }));

  assert.equal(result.ok, true);
  assert.equal(typeof result.expandTreeNode, "function");
  assert.match(result.html, /data-node-deferred/);
  assert.doesNotMatch(result.html, /secret/);

  const id = result.html.match(/data-tree-node="([^"]+)"/)?.[1];
  assert.ok(id);
  const expanded = result.expandTreeNode(id);
  assert.match(expanded, /third/);
  assert.doesNotMatch(expanded, /secret/);
});

test("dashboard structured data stops cyclic yaml graphs", () => {
  const cyclic = { value: 1 };
  cyclic.self = cyclic;
  const result = renderStructuredData("yaml", "cyclic", {
    parseYaml: () => cyclic
  });

  assert.equal(result.ok, true);
  assert.match(result.html, /data-cycle/);
});

test("dashboard structured data caps table rows, columns, and copy payload", () => {
  const headers = Array.from({ length: 70 }, (_, index) => `column-${index}`);
  const row = headers.map(() => "x".repeat(200));
  const source = [headers, ...Array.from({ length: 240 }, () => row)]
    .map((cells) => cells.join(","))
    .join("\n");
  const result = renderStructuredData("csv", source);

  assert.equal(result.ok, true);
  assert.match(result.summary, /240 .* 70/);
  assert.match(result.html, /200/);
  assert.match(result.html, /50/);
  assert.ok(new TextEncoder().encode(result.tsv).byteLength <= 256 * 1024);
});
