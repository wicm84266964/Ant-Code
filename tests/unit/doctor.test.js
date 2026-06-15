import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { formatDoctorReport, runDoctor } from "../../src/diagnostics/doctor.js";

test("doctor reports deployment readiness checks and next steps", async () => {
  const cwd = process.cwd();
  const labConfig = path.join(await makeTempWorkspace(), "lab-agent.config.json");
  await fs.writeFile(labConfig, JSON.stringify({ lab: { gatewayUrl: null } }), "utf8");
  const report = await runDoctor({ cwd, env: { LAB_AGENT_CONFIG: labConfig } });
  const text = formatDoctorReport(report);

  assert.equal(report.ok, true);
  assert.ok(report.checks.some((check) => check.name === "cli bins" && check.status === "ok"));
  assert.ok(report.checks.some((check) => check.name === "local installation guide" && check.status === "ok"));
  assert.ok(report.checks.some((check) => check.name === "model adapter readiness guide" && check.status === "ok"));
  assert.ok(report.checks.some((check) => check.name === "quickstart guide" && check.status === "ok"));
  assert.ok(report.checks.some((check) => check.name === "data boundary guide" && check.status === "ok"));
  assert.ok(report.checks.some((check) => check.name === "lab managed config" && check.status === "ok"));
  assert.ok(report.checks.some((check) => check.name === "model gateway" && check.status === "warn"));
  assert.ok(report.hints.some((hint) => /LAB_MODEL_GATEWAY_URL/.test(hint)));
  assert.match(text, /Ant Code doctor/);
  assert.match(text, /metadata: enabled=true, retention=30d, encryption=optional/);
  assert.match(text, /Next steps/);
});

test("doctor checks public docs from package root when run outside checkout", async () => {
  const projectCwd = await makeTempWorkspace();
  const report = await runDoctor({
    cwd: projectCwd,
    packageRoot: process.cwd(),
    env: {
      LAB_AGENT_NETWORK_MODE: "offline"
    }
  });

  assert.equal(report.ok, true);
  assert.equal(report.config.projectConfigPath, null);
  assert.ok(report.checks.some((check) => check.name === "cli bins" && check.status === "ok"));
  assert.ok(report.checks.some((check) => check.name === "quickstart guide" && check.status === "ok"));
  assert.ok(report.checks.some((check) => check.name === "data boundary guide" && check.status === "ok"));
});

test("doctor errors when required metadata encryption lacks key material", async () => {
  const report = await runDoctor({
    cwd: process.cwd(),
    env: {
      LAB_AGENT_TRANSCRIPT_ENCRYPTION: "required"
    }
  });

  assert.equal(report.ok, false);
  const check = report.checks.find((item) => item.name === "metadata encryption");
  assert.equal(check.status, "error");
  assert.match(check.message, /LAB_AGENT_TRANSCRIPT_KEY/);
});

test("doctor accepts configured gateway and transcript key", async () => {
  const report = await runDoctor({
    cwd: process.cwd(),
    env: {
      LAB_MODEL_GATEWAY_URL: "https://gateway.lab.example/v1/chat",
      LAB_MODEL_GATEWAY_HEALTH_URL: "https://gateway.lab.example/health",
      LAB_AGENT_NETWORK_MODE: "lab-only",
      LAB_AGENT_TRANSCRIPT_ENCRYPTION: "required",
      LAB_AGENT_TRANSCRIPT_KEY: "local-test-key"
    }
  });

  assert.equal(report.ok, true);
  assert.ok(report.checks.some((check) => check.name === "model gateway" && check.status === "ok"));
  assert.ok(report.checks.some((check) => check.name === "gateway health endpoint" && check.status === "ok"));
  assert.ok(report.checks.some((check) => check.name === "allowed hosts" && check.status === "ok"));
});

test("doctor reports high-sensitivity mode", async () => {
  const report = await runDoctor({
    cwd: process.cwd(),
    env: {
      LAB_AGENT_SENSITIVITY: "high",
      LAB_AGENT_NETWORK_MODE: "lab-only"
    }
  });
  const text = formatDoctorReport(report);

  assert.equal(report.config.sensitivity, "high");
  assert.equal(report.config.transcript.enabled, false);
  assert.equal(report.config.transcript.retentionDays, 0);
  assert.ok(report.checks.some((check) => check.name === "sensitivity mode" && check.status === "ok"));
  assert.match(text, /sensitivity: high/);
  assert.match(text, /zero-retention/);
});

async function makeTempWorkspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), "lab-agent-test-"));
}
