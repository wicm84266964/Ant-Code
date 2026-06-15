import { loadConfig } from "../config/load-config.js";
import { decideNetworkAccess } from "../permissions/network-policy.js";
import { gatewayTroubleshootingHints, normalizeGatewayError } from "./errors.js";

/**
 * @param {{ cwd?: string; env?: NodeJS.ProcessEnv; live?: boolean; timeoutMs?: number }} options
 */
export async function runGatewayHealth(options = {}) {
  const config = await loadConfig({ cwd: options.cwd, env: options.env });
  const live = Boolean(options.live);
  const checks = [];

  if (!config.lab.gatewayUrl) {
    checks.push({
      name: "gateway url",
      status: "error",
      message: "LAB_MODEL_GATEWAY_URL is not configured"
    });
    return result(config, checks, live);
  }

  const gatewayUrl = parseUrl(config.lab.gatewayUrl);
  checks.push(gatewayUrl
    ? { name: "gateway url", status: "ok", message: redactUrl(gatewayUrl) }
    : { name: "gateway url", status: "error", message: "LAB_MODEL_GATEWAY_URL is not a valid URL" });

  if (gatewayUrl) {
    const decision = decideNetworkAccess({
      url: gatewayUrl.toString(),
      networkMode: config.networkMode,
      allowedHosts: config.allowedHosts
    });
    checks.push({
      name: "gateway network policy",
      status: decision.decision === "allow" ? "ok" : decision.decision === "ask" ? "warn" : "error",
      message: decision.reason
    });
  }

  const healthUrl = config.lab.gatewayHealthUrl ? parseUrl(config.lab.gatewayHealthUrl) : null;
  if (!config.lab.gatewayHealthUrl) {
    checks.push({
      name: "gateway health url",
      status: live ? "warn" : "ok",
      message: "LAB_MODEL_GATEWAY_HEALTH_URL is not configured; live health request skipped"
    });
    return result(config, checks, live);
  }

  checks.push(healthUrl
    ? { name: "gateway health url", status: "ok", message: redactUrl(healthUrl) }
    : { name: "gateway health url", status: "error", message: "LAB_MODEL_GATEWAY_HEALTH_URL is not a valid URL" });

  if (!live || !healthUrl) {
    return result(config, checks, live);
  }

  const decision = decideNetworkAccess({
    url: healthUrl.toString(),
    networkMode: config.networkMode,
    allowedHosts: config.allowedHosts
  });
  if (decision.decision !== "allow") {
    checks.push({
      name: "gateway live health",
      status: "error",
      message: decision.reason
    });
    return result(config, checks, live);
  }

  checks.push(await fetchHealth(healthUrl, options.timeoutMs ?? 5000));
  return result(config, checks, live);
}

/**
 * @param {Awaited<ReturnType<typeof runGatewayHealth>>} report
 */
export function formatGatewayHealthReport(report) {
  const lines = [
    "Ant Code gateway health",
    `model: ${report.config.modelAlias}`,
    `protocol: ${report.config.gatewayProtocol}`,
    `fetch retries: ${report.config.gatewayMaxRetries}`,
    `network: ${report.config.networkMode}`,
    `live: ${report.live}`,
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

/**
 * @param {import("../config/load-config.js").LabAgentConfig} config
 * @param {Array<{ name: string; status: string; message: string }>} checks
 * @param {boolean} live
 */
function result(config, checks, live) {
  const hints = buildHealthHints(checks);
  return {
    ok: checks.every((check) => check.status !== "error"),
    live,
    config: {
      modelAlias: config.modelAlias,
      gatewayProtocol: config.lab.gatewayProtocol ?? "lab-agent-gateway",
      gatewayMaxRetries: config.lab.gatewayMaxRetries ?? 0,
      networkMode: config.networkMode,
      gatewayConfigured: Boolean(config.lab.gatewayUrl),
      healthConfigured: Boolean(config.lab.gatewayHealthUrl)
    },
    checks,
    hints
  };
}

/**
 * @param {URL} healthUrl
 * @param {number} timeoutMs
 */
async function fetchHealth(healthUrl, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(healthUrl, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal
    });
    return {
      name: "gateway live health",
      status: response.ok ? "ok" : "error",
      message: `HTTP ${response.status}`
    };
  } catch (error) {
    const normalized = normalizeGatewayError(error);
    return {
      name: "gateway live health",
      status: "error",
      message: `${normalized.code}: ${normalized.message}`,
      code: normalized.code
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * @param {Array<{ name: string; status: string; message: string; code?: string }>} checks
 */
function buildHealthHints(checks) {
  const hints = [];
  for (const check of checks) {
    if (check.status === "ok") {
      continue;
    }
    if (check.name === "gateway url") {
      hints.push(...gatewayTroubleshootingHints("GATEWAY_NOT_CONFIGURED"));
    } else if (check.name.includes("network policy")) {
      hints.push(...gatewayTroubleshootingHints("GATEWAY_NETWORK_BLOCKED"));
    } else if (check.name.includes("live health") && check.code) {
      hints.push(...gatewayTroubleshootingHints(check.code));
    } else if (check.name.includes("health url")) {
      hints.push("Set LAB_MODEL_GATEWAY_HEALTH_URL to the lab gateway health endpoint for live rollout checks.");
    }
  }
  return Array.from(new Set(hints));
}

/**
 * @param {string} value
 */
function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * @param {URL} url
 */
function redactUrl(url) {
  const copy = new URL(url.toString());
  copy.username = "";
  copy.password = "";
  copy.search = "";
  copy.hash = "";
  return copy.toString();
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
