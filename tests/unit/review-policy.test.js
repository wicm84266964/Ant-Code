import assert from "node:assert/strict";
import test from "node:test";
import { createReviewGate, shouldRequestReview } from "../../src/agents/review-policy.js";

test("review gate ignores prompt-only token examples without tool activity", () => {
  const gate = createReviewGate({
    config: { agents: { reviewGate: { enabled: true, mode: "remind" } } },
    prompt: "first turn token=super-secret path=C:\\secret-project\\paper.txt"
  });

  assert.equal(gate.beforeFinal(), null);
});

test("review gate ignores low-risk prompt after ordinary workflow activity", () => {
  const gate = createReviewGate({
    config: { agents: { reviewGate: { enabled: true, mode: "remind" } } },
    prompt: "first turn token=super-secret path=C:\\secret-project\\paper.txt"
  });

  gate.observeToolResult("todo_write", { items: ["note"] }, { ok: true });

  assert.equal(gate.beforeFinal(), null);
});

test("review gate reminds at the planning stage after a large todo list is created", () => {
  const gate = createReviewGate({
    config: { agents: { reviewGate: { enabled: true, mode: "remind" } } },
    prompt: "制定一个重构计划"
  });

  gate.observeToolResult("todo_write", {
    items: ["map", "design", "implement", "verify"]
  }, {
    ok: true,
    result: {
      todos: [
        { content: "map", status: "pending" },
        { content: "design", status: "pending" },
        { content: "implement", status: "pending" },
        { content: "verify", status: "pending" }
      ]
    }
  });
  const reminder = gate.beforeFinal();

  assert.equal(reminder.level, "remind");
  assert.match(reminder.text, /计划复核节点/);
  assert.match(reminder.reasons[0], /计划复核/);
});

test("review gate does not remind merely because files were edited", () => {
  const gate = createReviewGate({
    config: { agents: { reviewGate: { enabled: true } } },
    prompt: "修复这个小问题"
  });

  gate.observeToolResult("edit_file", { path: "src/index.js" }, { ok: true, result: { path: "src/index.js" } });

  assert.equal(gate.beforeFinal(), null);
});

test("review gate reminds at delivery stage after many workflow items are completed", () => {
  const gate = createReviewGate({
    config: { agents: { reviewGate: { enabled: true, todoThreshold: 4 } } },
    prompt: "完成这批任务"
  });

  gate.observeToolResult("todo_write", {}, {
    ok: true,
    result: {
      todos: [
        { content: "a", status: "completed" },
        { content: "b", status: "completed" },
        { content: "c", status: "completed" },
        { content: "d", status: "completed" }
      ]
    }
  });
  const reminder = gate.beforeFinal();

  assert.match(reminder.text, /交付复核节点/);
  assert.match(reminder.reasons[0], /交付复核/);
});

test("review gate reminds on exception stage for failed subagent work in a complex workflow", () => {
  const gate = createReviewGate({
    config: { agents: { reviewGate: { enabled: true, todoThreshold: 4 } } },
    prompt: "长任务执行"
  });

  gate.observeToolResult("todo_write", {}, {
    ok: true,
    result: {
      todos: [
        { content: "a", status: "completed" },
        { content: "b", status: "pending" },
        { content: "c", status: "pending" },
        { content: "d", status: "pending" }
      ]
    }
  });
  gate.observeToolResult("agent_run", { profile: "junior" }, { ok: false, profile: "junior", blocked: true });
  const reminder = gate.beforeFinal();

  assert.match(reminder.text, /异常复核节点/);
  assert.match(reminder.reasons[0], /异常复核/);
});

test("review gate ignores a single blocked web fetch in a diagnostic turn", () => {
  const gate = createReviewGate({
    config: { agents: { reviewGate: { enabled: true } } },
    prompt: "测试一下 fetch 是否可用"
  });

  gate.observeToolResult("web_fetch", { url: "https://example.com" }, { ok: false, blocked: true });

  assert.equal(gate.beforeFinal(), null);
});

test("review gate is satisfied by reviewer or verifier subagent results", () => {
  const gate = createReviewGate({
    config: { agents: { reviewGate: { enabled: true } } },
    prompt: "全面安全审计"
  });

  gate.observeToolResult("agent_run", { profile: "reviewer" }, { ok: true, profile: "reviewer" });
  gate.observeToolResult("todo_write", { items: ["audit"] }, { ok: true });

  assert.equal(gate.beforeFinal(), null);
});

test("review request helper still flags explicit high-risk tasks", () => {
  const result = shouldRequestReview({
    prompt: "发布前复核",
    routeDecision: { risk: "high" },
    config: { agents: { orchestration: { autoReview: true } } }
  });

  assert.equal(result.required, true);
  assert.ok(result.reasons.includes("route risk is high"));
});
