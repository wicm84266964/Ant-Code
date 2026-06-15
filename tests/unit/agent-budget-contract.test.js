import assert from "node:assert/strict";
import test from "node:test";
import { checkBudget, createBudgetTracker, recordBudgetToolResult, resolveAgentBudget, resolveAgentModel } from "../../src/agents/budget.js";
import { buildContextPack, hasWriteScope } from "../../src/agents/context-pack.js";
import { normalizeOutputContract, summarizeContractResult } from "../../src/agents/contracts.js";

test("agent budget defaults to no model-tool round limit and resolves overrides", () => {
  const budget = resolveAgentBudget({
    config: {
      agents: {
        budgets: {
          defaults: { maxRounds: null },
          "junior.deep": { maxDurationMs: 2_700_000 }
        }
      }
    },
    profile: { name: "junior" },
    routeDecision: { difficulty: "deep", risk: "medium" }
  });

  assert.equal(budget.maxRounds, null);
  assert.equal(budget.maxToolCalls, null);
  assert.equal(budget.maxDurationMs, 2_700_000);
  assert.equal(budget.maxReadFileBytes, 12_288);
  assert.equal(budget.maxToolResultBytes, 16_000);
});

test("agent budget still honors explicit model-tool round limits", () => {
  const budget = resolveAgentBudget({
    config: {
      agents: {
        budgets: {
          "explorer.deep": { maxRounds: 12 }
        }
      }
    },
    profile: { name: "explorer" },
    routeDecision: { difficulty: "deep", risk: "medium" }
  });

  assert.equal(budget.maxRounds, 12);
});

test("subagent model tiers can all route to the same configured model", () => {
  const config = {
    modelAlias: "example-vision-model",
    agents: {
      modelTiers: {
        cheap: "example-vision-model",
        default: "example-vision-model",
        strong: "example-vision-model"
      }
    }
  };

  assert.equal(resolveAgentModel(config, { modelTier: "cheap" }, {}), "example-vision-model");
  assert.equal(resolveAgentModel(config, { modelTier: "default" }, {}), "example-vision-model");
  assert.equal(resolveAgentModel(config, { modelTier: "strong" }, {}), "example-vision-model");
  assert.equal(config.modelAlias, "example-vision-model");
});

test("visual verifier resolves to the configured vision agent model", () => {
  const config = {
    modelAlias: "text-main",
    agents: {
      vision: {
        enabled: true,
        model: "example-vision-model"
      },
      modelTiers: {
        default: "text-default",
        strong: "text-strong"
      }
    }
  };

  assert.equal(resolveAgentModel(config, { modelTier: "vision" }, { name: "visual-verifier", purpose: "visual" }), "example-vision-model");
  assert.equal(resolveAgentModel(config, {}, { name: "visual-verifier", purpose: "visual", modelTier: "vision" }), "example-vision-model");
});

test("visual verifier falls back to model tiers when vision agent is disabled", () => {
  const config = {
    modelAlias: "text-main",
    agents: {
      vision: {
        enabled: false,
        model: "example-vision-model"
      },
      modelTiers: {
        vision: "configured-vision-tier",
        default: "text-default"
      }
    }
  };

  assert.equal(resolveAgentModel(config, { modelTier: "vision" }, { name: "visual-verifier", purpose: "visual" }), "configured-vision-tier");
});

test("agent budget tracker does not stop on tool call count", () => {
  const tracker = createBudgetTracker({
    maxRounds: 10,
    maxToolCalls: null,
    maxDurationMs: 100000,
    maxOutputBytes: 100000,
    maxConsecutiveFailures: 2,
    maxPermissionDenials: 2
  });
  recordBudgetToolResult(tracker, { ok: true }, { content: "ok" });
  recordBudgetToolResult(tracker, { ok: false }, { content: "fail" });

  const exceeded = checkBudget(tracker, { pendingToolCalls: 1 });
  assert.equal(exceeded, null);
});

test("context pack normalizes write scope and acceptance", () => {
  const pack = buildContextPack({
    query: "fix bug",
    writeScope: ["src/a.js"],
    acceptance: "npm test",
    routeDecision: { purpose: "execute", difficulty: "quick", risk: "medium" }
  });

  assert.equal(pack.task, "fix bug");
  assert.equal(pack.writeScope[0], "src/a.js");
  assert.equal(pack.acceptance[0], "npm test");
  assert.equal(hasWriteScope(pack), true);
});

test("contracts summarize json and text outputs", () => {
  const contract = normalizeOutputContract("review");
  const json = summarizeContractResult(JSON.stringify({
    verdict: "approve",
    findings: [],
    missingTests: [],
    residualRisks: ["manual UI not checked"]
  }), contract);
  const text = summarizeContractResult("plain summary\nsecond line", "findings");

  assert.equal(contract.type, "review");
  assert.equal(json.parsed.verdict, "approve");
  assert.match(json.summary, /verdict/);
  assert.match(text.summary, /plain summary/);
});
