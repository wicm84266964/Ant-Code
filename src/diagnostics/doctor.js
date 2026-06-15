import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { loadConfig } from "../config/load-config.js";
import { resolvePackageRoot } from "../version.js";

const execFileAsync = promisify(execFile);
const DEFAULT_PACKAGE_ROOT = resolvePackageRoot();

/**
 * @param {{ cwd: string; packageRoot?: string; env?: NodeJS.ProcessEnv }} options
 */
export async function runDoctor(options) {
  const checks = [];
  const env = options.env ?? process.env;
  const packageRoot = options.packageRoot ?? DEFAULT_PACKAGE_ROOT;
  const config = await loadConfig({ cwd: options.cwd, env });

  checks.push(checkNodeVersion());
  checks.push(await checkPackageBin(packageRoot));
  checks.push(await checkActiveCliCommand(options.cwd, packageRoot, env));
  checks.push(await checkConfigSource(config.projectConfigPath, "project config"));
  checks.push(await checkConfigSource(config.lab.configPath, "lab managed config"));
  checks.push({
    name: "model gateway",
    status: config.lab.gatewayUrl ? "ok" : "warn",
    message: config.lab.gatewayUrl
      ? "LAB_MODEL_GATEWAY_URL is configured"
      : "LAB_MODEL_GATEWAY_URL is not configured; model turns will be disabled"
  });
  checks.push({
    name: "gateway health endpoint",
    status: config.lab.gatewayHealthUrl ? "ok" : "warn",
    message: config.lab.gatewayHealthUrl
      ? "LAB_MODEL_GATEWAY_HEALTH_URL is configured"
      : "LAB_MODEL_GATEWAY_HEALTH_URL is not configured; live rollout check will be skipped"
  });
  checks.push({
    name: "network mode",
    status: "ok",
    message: config.networkMode
  });
  checks.push(checkSensitivityMode(config));
  checks.push(checkAllowedHosts(config));
  checks.push(checkTranscriptPolicy(config, env));
  checks.push(checkMcpPolicy(config));
  checks.push(await checkPath(path.join(packageRoot, "docs", "provenance", "clean-room-provenance-policy.md"), "provenance policy"));
  checks.push(await checkPath(path.join(packageRoot, "docs", "provenance", "modules"), "module provenance directory"));
  checks.push(await checkPath(path.join(packageRoot, "docs", "audit", "clean-room-release-attestation.md"), "clean-room release attestation"));
  checks.push(await checkPath(path.join(packageRoot, "docs", "audit", "mvp-release-audit.generated.md"), "release audit report"));
  checks.push(await checkPath(path.join(packageRoot, "docs", "deployment", "local-installation.md"), "local installation guide"));
  checks.push(await checkPath(path.join(packageRoot, "docs", "deployment", "model-adapter-gateway-readiness.md"), "model adapter readiness guide"));
  checks.push(await checkPath(path.join(packageRoot, "docs", "deployment", "rc-acceptance-summary.md"), "rc acceptance summary"));
  checks.push(await checkPath(path.join(packageRoot, "docs", "deployment", "release-candidate-package.md"), "release candidate package"));
  checks.push(await checkPath(path.join(packageRoot, "docs", "deployment", "lab-user-quickstart.md"), "lab user quickstart"));

  return {
    ok: checks.every((check) => check.status !== "error"),
    cwd: options.cwd,
    config: {
      modelAlias: config.modelAlias,
      networkMode: config.networkMode,
      sensitivity: config.security?.sensitivity ?? "standard",
      projectConfigPath: config.projectConfigPath,
      labConfigPath: config.lab.configPath,
      transcript: {
        enabled: config.transcript?.enabled !== false,
        retentionDays: config.transcript?.retentionDays ?? 30,
        encryption: config.transcript?.encryption ?? "off"
      },
      mcpServers: config.mcp?.servers?.length ?? 0
    },
    checks,
    hints: buildDoctorHints(checks)
  };
}

/**
 * @param {string} cwd
 * @param {string} packageRoot
 * @param {NodeJS.ProcessEnv} env
 */
async function checkActiveCliCommand(cwd, packageRoot, env) {
  const expected = await readExpectedVersion(packageRoot);
  if (!expected) {
    return {
      name: "active ant-code command",
      status: "warn",
      message: "could not read package version for command-path verification"
    };
  }

  const [commandPath, versionResult] = await Promise.all([
    resolveCommandPath("ant-code", cwd, env),
    readCommandVersion("ant-code", cwd, env)
  ]);

  if (!versionResult.ok) {
    return {
      name: "active ant-code command",
      status: "warn",
      message: "ant-code is not linked on PATH; use node src/cli/index.js or run npm link from this checkout"
    };
  }

  const actual = firstNonEmptyLine(versionResult.stdout);
  if (actual === expected) {
    return {
      name: "active ant-code command",
      status: "ok",
      message: commandPath ? `${actual} at ${commandPath}` : actual
    };
  }

  return {
    name: "active ant-code command",
    status: "warn",
    message: `PATH ant-code reports '${truncate(actual || "unknown", 80)}', expected '${expected}'${commandPath ? ` at ${commandPath}` : ""}; relink this checkout or run node src/cli/index.js`
  };
}

/**
 * @param {string} cwd
 */
async function readExpectedVersion(cwd) {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(cwd, "package.json"), "utf8"));
    return `ant-code ${pkg.version}`;
  } catch {
    return null;
  }
}

/**
 * @param {string} command
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} env
 */
async function resolveCommandPath(command, cwd, env) {
  try {
    const result = process.platform === "win32"
      ? await execFileAsync("where.exe", [command], { cwd, env, windowsHide: true, timeout: 3000 })
      : await execFileAsync("sh", ["-c", `command -v ${command}`], { cwd, env, timeout: 3000 });
    return firstNonEmptyLine(result.stdout);
  } catch {
    return null;
  }
}

/**
 * @param {string} command
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} env
 */
async function readCommandVersion(command, cwd, env) {
  try {
    const result = await execFileAsync(command, ["--version"], {
      cwd,
      env,
      windowsHide: true,
      timeout: 5000
    });
    return { ok: true, stdout: result.stdout };
  } catch (error) {
    return {
      ok: false,
      stdout: error?.stdout ?? "",
      error
    };
  }
}

/**
 * @param {string} value
 */
function firstNonEmptyLine(value) {
  return String(value ?? "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

/**
 * @param {string} value
 * @param {number} max
 */
function truncate(value, max) {
  const text = String(value ?? "");
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3))}...`;
}

/**
 * @param {Awaited<ReturnType<typeof runDoctor>>} report
 */
export function formatDoctorReport(report) {
  const lines = [
    "Ant Code doctor",
    `cwd: ${report.cwd}`,
    `model: ${report.config.modelAlias}`,
    `network: ${report.config.networkMode}`,
    `sensitivity: ${report.config.sensitivity}`,
    `project config: ${report.config.projectConfigPath ?? "not found"}`,
    `lab config: ${report.config.labConfigPath ?? "not configured"}`,
    `metadata: enabled=${report.config.transcript.enabled}, retention=${report.config.transcript.retentionDays}d, encryption=${report.config.transcript.encryption}`,
    `mcp servers: ${report.config.mcpServers}`,
    ""
  ];

  for (const check of report.checks) {
    lines.push(`${formatStatus(check.status)} ${check.name}: ${check.message}`);
  }
  if (report.hints.length > 0) {
    lines.push("", "Next steps");
    lines.push(...report.hints.map((hint) => `- ${hint}`));
  }

  return lines.join("\n");
}

function checkNodeVersion() {
  const major = Number.parseInt(process.versions.node.split(".")[0], 10);
  return {
    name: "node",
    status: major >= 20 ? "ok" : "error",
    message: `Node ${process.versions.node} detected; Node 20+ required`
  };
}

/**
 * @param {string} cwd
 */
async function checkPackageBin(cwd) {
  try {
    const text = await fs.readFile(path.join(cwd, "package.json"), "utf8");
    const pkg = JSON.parse(text);
    const hasPublicBin = pkg.bin?.["ant-code"] === "./src/cli/index.js";
    const hasCompatBin = pkg.bin?.["lab-agent"] === "./src/cli/index.js";
    return {
      name: "cli bins",
      status: hasPublicBin && hasCompatBin ? "ok" : "error",
      message: hasPublicBin && hasCompatBin
        ? "ant-code and lab-agent bins are configured"
        : "package.json must expose ant-code and lab-agent bins"
    };
  } catch (error) {
    return {
      name: "cli bins",
      status: "error",
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * @param {string | null} configPath
 * @param {string} name
 */
async function checkConfigSource(configPath, name) {
  if (!configPath) {
    return {
      name,
      status: name === "lab managed config" ? "warn" : "ok",
      message: name === "lab managed config"
        ? "LAB_AGENT_CONFIG is not set; using defaults/project/env only"
        : "no project config found; using defaults/env"
    };
  }
  try {
    await fs.access(configPath);
    return { name, status: "ok", message: configPath };
  } catch {
    return { name, status: "error", message: `${configPath} is configured but not readable` };
  }
}

/**
 * @param {Record<string, any>} config
 */
function checkAllowedHosts(config) {
  const hosts = config.allowedHosts ?? [];
  if (config.networkMode === "offline") {
    return {
      name: "allowed hosts",
      status: "ok",
      message: "offline mode ignores non-loopback hosts"
    };
  }
  if (config.networkMode === "lab-only" && config.lab.gatewayUrl && hosts.length === 0) {
    return {
      name: "allowed hosts",
      status: "error",
      message: "lab-only mode requires the gateway host in allowedHosts"
    };
  }
  return {
    name: "allowed hosts",
    status: hosts.length > 0 ? "ok" : "warn",
    message: hosts.length > 0 ? hosts.join(", ") : "no explicit allowed hosts configured"
  };
}

/**
 * @param {Record<string, any>} config
 */
function checkSensitivityMode(config) {
  const sensitivity = config.security?.sensitivity ?? "standard";
  if (sensitivity === "high") {
    return {
      name: "sensitivity mode",
      status: "ok",
      message: "high; metadata is disabled/zero-retention and network mode is restricted"
    };
  }
  return {
    name: "sensitivity mode",
    status: "ok",
    message: "standard"
  };
}

/**
 * @param {Record<string, any>} config
 * @param {NodeJS.ProcessEnv} env
 */
function checkTranscriptPolicy(config, env) {
  const transcript = config.transcript ?? {};
  const retentionDays = transcript.retentionDays ?? 30;
  const encryption = transcript.encryption ?? "off";
  if (encryption === "required" && !env.LAB_AGENT_TRANSCRIPT_KEY) {
    return {
      name: "metadata encryption",
      status: "error",
      message: "LAB_AGENT_TRANSCRIPT_KEY is required when transcript encryption is required"
    };
  }
  if (transcript.enabled === false || retentionDays === 0) {
    return {
      name: "metadata retention",
      status: "ok",
      message: "metadata persistence is disabled or zero-retention"
    };
  }
  if (retentionDays > 30) {
    return {
      name: "metadata retention",
      status: "warn",
      message: `${retentionDays}d retention exceeds the recommended 30d deployment default`
    };
  }
  return {
    name: "metadata retention",
    status: encryption === "off" ? "warn" : "ok",
    message: `${retentionDays}d retention, encryption=${encryption}`
  };
}

/**
 * @param {Record<string, any>} config
 */
function checkMcpPolicy(config) {
  const servers = config.mcp?.servers ?? [];
  if (servers.length === 0) {
    return {
      name: "mcp servers",
      status: "ok",
      message: "no MCP servers configured"
    };
  }
  return {
    name: "mcp servers",
    status: "warn",
    message: `${servers.length} server(s) configured; confirm owner, source, checksum, and data-boundary review`
  };
}

/**
 * @param {string} targetPath
 * @param {string} name
 */
async function checkPath(targetPath, name) {
  try {
    await fs.access(targetPath);
    return { name, status: "ok", message: targetPath };
  } catch {
    return { name, status: "error", message: `${targetPath} is missing` };
  }
}

/**
 * @param {string} status
 */
function formatStatus(status) {
  if (status === "ok") {
    return "[ok]";
  }
  if (status === "warn") {
    return "[warn]";
  }
  return "[error]";
}

/**
 * @param {Array<{ name: string; status: string; message: string }>} checks
 */
function buildDoctorHints(checks) {
  const hints = [];
  for (const check of checks) {
    if (check.status === "ok") {
      continue;
    }
    if (check.name === "model gateway") {
      hints.push("Set LAB_MODEL_GATEWAY_URL or start the local mock gateway for development.");
    } else if (check.name === "gateway health endpoint") {
      hints.push("Set LAB_MODEL_GATEWAY_HEALTH_URL before a broad lab rollout.");
    } else if (check.name === "metadata encryption") {
      hints.push("Provide LAB_AGENT_TRANSCRIPT_KEY or switch encryption to optional/off for development only.");
    } else if (check.name === "metadata retention") {
      hints.push("Use 30d or less for normal rollout, or 0d for high-sensitivity projects.");
    } else if (check.name === "mcp servers") {
      hints.push("Review MCP server owner/source/checksum before enabling it for a cohort.");
    } else if (check.name === "lab managed config") {
      hints.push("Set LAB_AGENT_CONFIG on shared machines to a lab-owned config JSON.");
    } else {
      hints.push(`Review ${check.name}: ${check.message}`);
    }
  }
  return Array.from(new Set(hints));
}
