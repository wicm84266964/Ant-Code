import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPlanPackageStore, extractPlanPackage } from "../../src/agents/plan-package-store.js";

test("plan package store writes traceable markdown documents under .lab-agent/plans", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-plan-package-"));
  const store = createPlanPackageStore({ cwd });

  const result = await store.writePlanPackage({
    planId: "plan-test-1",
    parentSessionId: "session-1",
    plannerTaskId: "task-planner",
    package: {
      requirementsDoc: "Confirmed requirements",
      taskPlanDoc: "Detailed task plan",
      executionChecklist: "Stage checklist",
      traceabilityMap: { req1: ["stage-1"] },
      clarificationQuestions: ["Which release channel?"]
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.path, ".lab-agent/plans/plan-test-1");
  assert.deepEqual(result.files, {
    requirements: ".lab-agent/plans/plan-test-1/requirements.md",
    taskPlan: ".lab-agent/plans/plan-test-1/task-plan.md",
    executionChecklist: ".lab-agent/plans/plan-test-1/execution-checklist.md",
    manifest: ".lab-agent/plans/plan-test-1/manifest.json"
  });
  assert.match(await fs.readFile(path.join(cwd, result.files.requirements), "utf8"), /Confirmed requirements/);
  assert.match(await fs.readFile(path.join(cwd, result.files.taskPlan), "utf8"), /Detailed task plan/);
  assert.match(await fs.readFile(path.join(cwd, result.files.executionChecklist), "utf8"), /Stage checklist/);
  const manifest = JSON.parse(await fs.readFile(path.join(cwd, result.files.manifest), "utf8"));
  assert.equal(manifest.parentSessionId, "session-1");
  assert.equal(manifest.plannerTaskId, "task-planner");
  assert.equal(manifest.documents.requirements, result.files.requirements);
});

test("plan package extractor accepts structured json and markdown sections", () => {
  const structured = extractPlanPackage(JSON.stringify({
    requirementsDoc: "Req",
    taskPlanDoc: "Plan",
    executionChecklist: "Checklist",
    traceabilityMap: {}
  }));

  assert.equal(structured.requirementsDoc, "Req");
  assert.equal(structured.taskPlanDoc, "Plan");
  assert.equal(structured.executionChecklist, "Checklist");

  const markdown = extractPlanPackage([
    "# Requirements",
    "Req body",
    "# Task Plan",
    "Plan body",
    "# Execution Checklist",
    "Checklist body"
  ].join("\n"));

  assert.equal(markdown.requirementsDoc, "Req body");
  assert.equal(markdown.taskPlanDoc, "Plan body");
  assert.equal(markdown.executionChecklist, "Checklist body");
});

test("plan package extractor tolerates fenced json with markdown code fences inside document fields", () => {
  const output = [
    "Here is the plan package:",
    "```json",
    JSON.stringify({
      planPackage: {
        requirementsDoc: "# Requirements\n\n- Keep generated plans under `.lab-agent/plans/`.",
        taskPlanDoc: "# Task Plan\n\n```js\nconsole.log(\"planner\");\n```\n\nContinue planning.",
        executionChecklist: "# Execution Checklist\n\n```powershell\nnode --test tests/unit/plan-package-store.test.js\n```\n\n- Review gate required.",
        traceabilityMap: { req1: ["stage-1"] },
        handoffPrompt: "Use the execution checklist."
      }
    }, null, 2),
    "```"
  ].join("\n");

  const extracted = extractPlanPackage(output);

  assert.match(extracted.requirementsDoc, /\.lab-agent\/plans/);
  assert.match(extracted.taskPlanDoc, /console\.log/);
  assert.match(extracted.executionChecklist, /node --test/);
  assert.deepEqual(extracted.traceabilityMap, { req1: ["stage-1"] });
});
