import assert from "node:assert/strict";
import test from "node:test";
import { buildSubagentGroupWakePrompt, summarizeTaskForWake } from "../../src/agents/wakeup.ts";

test("wake prompt includes the full child handoff report without tool traces", () => {
  const findings = Array.from({ length: 8 }, (_, index) => (
    `### F-${index + 1}【编造】图 ${index + 1} 原句与正文对照，行号 ch2 L${20 + index}`
  )).join("\n");
  const report = [
    "# 逐字引用复核报告",
    "",
    "**verdict**: 发现 8 条实质差异，其中 1 条编造。",
    "",
    findings
  ].join("\n");
  const prompt = buildSubagentGroupWakePrompt({
    group: { id: "workpack-review", parentSessionId: "session-1", wakeReason: "复核完成" },
    tasks: [{
      id: "verify-verbatim-quotes",
      profile: "reviewer",
      status: "completed",
      outputSummary: "I have sufficient evidence. Writing the report now.\n\n**verdict**: 发现 8 条差异",
      output: report,
      toolCalls: Array.from({ length: 34 }, (_, index) => ({
        name: "read_file",
        content: "secret-tool-trace-" + index,
        resultBytes: 8000
      }))
    }]
  });

  assert.match(prompt, /### verify-verbatim-quotes reviewer completed/);
  assert.match(prompt, /F-1【编造】/);
  assert.match(prompt, /F-8【编造】/);
  assert.match(prompt, /行号 ch2 L27/);
  assert.doesNotMatch(prompt, /secret-tool-trace/);
  assert.doesNotMatch(prompt, /I have sufficient evidence/);
});

test("wake prompt prefers the full output over the eight-line summary", () => {
  const text = summarizeTaskForWake({
    outputSummary: "short summary only",
    output: "complete findings list with line numbers"
  });
  assert.equal(text, "complete findings list with line numbers");
});

test("wake prompt keeps a 12k-character completed report intact", () => {
  const report = `verdict: 8 findings\n${"条目详情与正文对照。".repeat(1200)}`;
  const prompt = buildSubagentGroupWakePrompt({
    group: { id: "g1", parentSessionId: "s1" },
    tasks: [{ id: "review-1", profile: "reviewer", status: "completed", output: report }]
  });
  assert.ok(prompt.includes(report));
  assert.doesNotMatch(prompt, /handoff truncated/);
});
