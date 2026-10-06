import assert from "node:assert/strict";
import test from "node:test";

const stub = {
  addEventListener() {},
  classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  dataset: {},
  textContent: "",
  innerHTML: "",
  hidden: false,
  style: {},
  append() {},
  replaceChildren() {},
  querySelectorAll() { return []; },
  querySelector() { return null; },
  setAttribute() {},
  removeAttribute() {},
  closest() { return null; }
};
if (typeof globalThis.document === "undefined") {
  globalThis.document = {
    querySelector() { return stub; },
    addEventListener() {},
    body: stub,
    documentElement: stub
  };
}

const {
  pairPromptRailTurns,
  promptRailWidth,
  promptTextFromEntry,
  shouldShowPromptRail
} = await import("../../src/dashboard/public/prompt-rail.ts");

test("prompt rail stays hidden until two sent prompts exist", () => {
  assert.equal(shouldShowPromptRail(0), false);
  assert.equal(shouldShowPromptRail(1), false);
  assert.equal(shouldShowPromptRail(2), true);
});

test("prompt rail ticks stay short until the hovered area grows", () => {
  assert.equal(promptRailWidth(0, -1, -1), 12);
  assert.equal(promptRailWidth(1, -1, 1), 16);
  assert.equal(promptRailWidth(3, -1, 1), 12);
  assert.equal(promptRailWidth(2, 2, 0), 40);
  assert.equal(promptRailWidth(1, 2, 0), 30);
  assert.equal(promptRailWidth(0, 2, 0), 20);
  assert.equal(promptRailWidth(4, 2, 4), 20);
  assert.equal(promptRailWidth(6, 2, 6), 16);
  assert.equal(promptRailWidth(5, 2, 4), 12);
});

test("prompt rail pairs each user prompt with the latest following reply", () => {
  const first = element();
  const second = element(["附图.png"]);
  const turns = pairPromptRailTurns([
    { role: "user", text: "  先整理实验记录 \n", node: first },
    { role: "assistant", text: "第一版", node: element() },
    { role: "assistant", text: "已整理第一批记录。", node: element() },
    { role: "user", text: "", node: second }
  ], (index) => `id-${index}`);

  assert.equal(turns.length, 2);
  assert.equal(turns[0].prompt, "先整理实验记录");
  assert.equal(turns[0].response, "已整理第一批记录。");
  assert.equal(turns[0].node, first);
  assert.equal(first.dataset.promptTurn, "true");
  assert.equal(first.dataset.promptId, "id-0");
  assert.equal(turns[1].prompt, "附图.png");
  assert.equal(turns[1].response, "");
});

test("prompt rail uses attachment names when the prompt text is empty", () => {
  const node = element([" 附图.png "]);
  assert.equal(promptTextFromEntry({ role: "user", text: " \n ", node }), "附图.png");
});

function element(chips: string[] = []) {
  return {
    dataset: {},
    classList: { contains() { return false; } },
    querySelectorAll() {
      return chips.map((textContent) => ({ textContent }));
    },
    querySelector() { return null; }
  };
}
