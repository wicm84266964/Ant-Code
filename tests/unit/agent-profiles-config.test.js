import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getAgentProfile, listAgentProfileLabels, listAgentProfiles } from "../../src/agents/profiles.js";

test("builtin agent profile aliases include research compatibility names", () => {
  const research = getAgentProfile("research", { agents: { profiles: [] } }, { cwd: process.cwd() });
  const researcher = getAgentProfile("researcher", { agents: { profiles: [] } }, { cwd: process.cwd() });
  const labels = listAgentProfileLabels({ agents: { profiles: [] } }, { cwd: process.cwd() });

  assert.equal(research?.name, "readonly-researcher");
  assert.equal(researcher?.name, "readonly-researcher");
  assert.ok(labels.some((label) => label.includes("readonly-researcher") && label.includes("research")));
});

test("builtin agent profiles expose v2 routing metadata and specialized agents", () => {
  const config = { agents: { profiles: [] } };
  const web = getAgentProfile("web-researcher", config, { cwd: process.cwd() });
  const browser = getAgentProfile("browser", config, { cwd: process.cwd() });
  const visual = getAgentProfile("vision", config, { cwd: process.cwd() });
  const explorer = getAgentProfile("explorer", config, { cwd: process.cwd() });
  const visibleProfiles = listAgentProfiles(config, { cwd: process.cwd(), includeHidden: false });

  assert.equal(web?.name, "web-researcher");
  assert.deepEqual(web.mcpServers, ["github", "fetch", "duckduckgo-search", "searxng"]);
  assert.ok(web.skills.includes("web-research"));
  assert.equal(web.outputContract.type, "web-research");
  assert.equal(browser?.name, "browser-verifier");
  assert.ok(browser.mcpServers.includes("playwright"));
  assert.equal(visual?.name, "visual-verifier");
  assert.equal(visual.modelTier, "vision");
  assert.equal(visual.outputContract.type, "visual-verification");
  assert.ok(visual.mcpServers.includes("playwright"));
  assert.ok(explorer.triggerHints.includes("调查"));
  assert.equal(Number.isInteger(explorer.maxRounds), false);
  assert.equal(Number.isInteger(web.maxRounds), false);
  assert.equal(Number.isInteger(browser.maxRounds), false);
  assert.equal(explorer.outputContract.type, "findings");
  assert.ok(explorer.outputContract.required.includes("confidence"));
  assert.equal(visibleProfiles.some((profile) => profile.name === "build"), false);
});

test("builtin agent prompts include complex-task operating contracts", () => {
  const config = { agents: { profiles: [] } };
  const build = getAgentProfile("build", config, { cwd: process.cwd(), includeHidden: true });
  const explorer = getAgentProfile("explorer", config, { cwd: process.cwd() });
  const planner = getAgentProfile("planner", config, { cwd: process.cwd() });
  const junior = getAgentProfile("junior", config, { cwd: process.cwd() });
  const reviewer = getAgentProfile("reviewer", config, { cwd: process.cwd() });
  const web = getAgentProfile("web-researcher", config, { cwd: process.cwd() });
  const browser = getAgentProfile("browser-verifier", config, { cwd: process.cwd() });
  const visual = getAgentProfile("visual-verifier", config, { cwd: process.cwd() });

  assert.match(build.system, /parent coordinator/);
  assert.match(build.system, /Default to delegation/);
  assert.match(build.system, /bulk repository reading/);
  assert.match(build.system, /control loop: intake -> visible task state -> parallel readonly discovery -> synthesis -> scoped implementation -> validation -> strict review -> final report/);
  assert.match(build.system, /three-document planning protocol/);
  assert.match(build.system, /\.lab-agent\/plans\/<plan-id>/);
  assert.match(build.system, /lower-cost models handle bulk context/);
  assert.match(build.system, /Never dump raw child JSON/);
  assert.match(explorer.system, /compact evidence map/);
  assert.match(planner.system, /requirementsDoc/);
  assert.match(planner.system, /Do not edit files, do not ask the user directly/);
  assert.match(junior.system, /checkpointed slice/);
  assert.match(reviewer.system, /findings first, ordered by severity/);
  assert.match(getAgentProfile("readonly-researcher", config, { cwd: process.cwd() }).system, /github MCP/);
  assert.match(getAgentProfile("readonly-researcher", config, { cwd: process.cwd() }).system, /raw\.githubusercontent\.com/);
  assert.match(getAgentProfile("readonly-researcher", config, { cwd: process.cwd() }).system, /blocked URLs under caveats/);
  assert.match(web.system, /sourceQuality/);
  assert.match(web.system, /api\.github\.com contents endpoints/);
  assert.match(web.system, /produce the final report from already successful evidence/);
  assert.match(browser.system, /layout integrity/);
  assert.match(visual.system, /multimodal specialist/);
  assert.match(visual.system, /visual regression/);
  assert.match(visual.system, /Separate directly observed facts from inference/);
});

test("builtin output contracts align with profile return fields", () => {
  const config = { agents: { profiles: [] } };
  const verifier = getAgentProfile("verifier", config, { cwd: process.cwd() });
  const codeWorker = getAgentProfile("code-worker", config, { cwd: process.cwd() });
  const planner = getAgentProfile("planner", config, { cwd: process.cwd() });
  const visual = getAgentProfile("visual-verifier", config, { cwd: process.cwd() });

  assert.ok(verifier.outputContract.required.includes("recommendedNextFix"));
  assert.ok(verifier.outputContract.required.includes("residualValidationGaps"));
  assert.ok(codeWorker.outputContract.required.includes("needsParentAction"));
  assert.equal(planner.outputContract.type, "plan-package");
  assert.ok(planner.outputContract.required.includes("requirementsDoc"));
  assert.ok(planner.outputContract.required.includes("taskPlanDoc"));
  assert.ok(planner.outputContract.required.includes("executionChecklist"));
  assert.ok(planner.outputContract.required.includes("handoffPrompt"));
  assert.equal(planner.tools.includes("ask_user"), false);
  assert.equal(planner.tools.includes("plan_update"), false);
  assert.ok(visual.outputContract.required.includes("visualEvidence"));
  assert.ok(visual.outputContract.required.includes("recommendedFollowup"));
});

test("agent profiles load markdown frontmatter from local agent directories", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-agents-"));
  await fs.mkdir(path.join(cwd, ".lab-agent", "agents"), { recursive: true });
  await fs.writeFile(path.join(cwd, ".lab-agent", "agents", "reader.md"), [
    "---",
    "name: reader",
    "description: Reads docs",
    "mode: readonly",
    "tools: read_file, grep",
    "hidden: false",
    "color: cyan",
    "---",
    "You read documentation and cite files."
  ].join("\n"), "utf8");

  const profiles = listAgentProfiles({ agents: { profiles: [] } }, { cwd });
  const profile = getAgentProfile("reader", { agents: { profiles: [] } }, { cwd });

  assert.ok(profiles.some((item) => item.name === "reader"));
  assert.equal(profile.description, "Reads docs");
  assert.deepEqual(profile.tools, ["read_file", "grep"]);
  assert.match(profile.source, /\.lab-agent\/agents\/reader\.md$/);
  assert.match(profile.system, /read documentation/);
});

test("config agent profiles override local markdown and can hide profiles", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-agents-"));
  await fs.mkdir(path.join(cwd, ".lab-agent", "agents"), { recursive: true });
  await fs.writeFile(path.join(cwd, ".lab-agent", "agents", "reader.md"), "---\nname: reader\ndescription: local\n---\nlocal", "utf8");
  const config = {
    agents: {
      profiles: [
        {
          name: "reader",
          description: "config",
          hidden: true,
          tools: ["read_file", "write_file"],
          disallowedTools: ["write_file"]
        }
      ]
    }
  };

  const all = listAgentProfiles(config, { cwd });
  const visible = listAgentProfiles(config, { cwd, includeHidden: false });
  const profile = getAgentProfile("reader", config, { cwd, includeHidden: true });
  const publicProfile = getAgentProfile("reader", config, { cwd });

  assert.equal(profile.description, "config");
  assert.equal(profile.hidden, true);
  assert.deepEqual(profile.tools, ["read_file"]);
  assert.equal(all.some((item) => item.name === "reader"), false);
  assert.equal(visible.some((item) => item.name === "reader"), false);
  assert.equal(publicProfile, null);
});

test("hidden build profile is internal-only by default", () => {
  const config = { agents: { profiles: [] } };

  assert.equal(getAgentProfile("build", config, { cwd: process.cwd() }), null);
  assert.equal(getAgentProfile("default", config, { cwd: process.cwd() }), null);
  assert.equal(listAgentProfiles(config, { cwd: process.cwd() }).some((profile) => profile.name === "build"), false);
  assert.equal(listAgentProfileLabels(config, { cwd: process.cwd() }).some((label) => label.includes("build")), false);

  const internal = getAgentProfile("build", config, { cwd: process.cwd(), includeHidden: true });
  const internalAlias = getAgentProfile("default", config, { cwd: process.cwd(), includeHidden: true });
  assert.equal(internal?.hidden, true);
  assert.equal(internalAlias?.name, "build");
});
