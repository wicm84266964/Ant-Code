import { spawn } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import { decidePermission } from "../permissions/policy-engine.js";
import { withProxyEnvironment } from "../net/proxy.js";
import { scrubEnvironment } from "../tools/env-scrubber.js";
import { getAntCodeVersion, resolvePackageRoot } from "../version.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MCP_PROTOCOL_VERSION = "2024-11-05";
const PACKAGE_ROOT = resolvePackageRoot();

/**
 * @param {{
 *   cwd: string;
 *   config?: Record<string, any>;
 *   policy?: Record<string, any>;
 *   approve?: (request: { toolName: string; input: Record<string, any>; decision: Record<string, any>; definition: Record<string, any> }) => Promise<boolean> | boolean;
 * }} options
 */
export function createMcpRuntime(options = { cwd: process.cwd() }) {
  const servers = normalizeServers(options.config?.mcp?.servers ?? []);
  const sessions = new Map();

  return {
    listServers() {
      return servers.map((server) => ({
        name: server.name,
        description: server.description,
        transport: server.transport,
        enabled: server.enabled,
        command: server.command,
        args: server.args,
        status: sessionStatus(sessions.get(server.name), server)
      }));
    },

    status(serverName = null) {
      const selected = serverName
        ? servers.filter((server) => server.name === serverName)
        : servers;
      if (serverName && selected.length === 0) {
        return { ok: false, error: { code: "MCP_SERVER_NOT_FOUND", message: `Unknown MCP server: ${serverName}` } };
      }
      return {
        ok: true,
        servers: selected.map((server) => {
          const session = sessions.get(server.name);
          return {
            name: server.name,
            enabled: server.enabled,
            transport: server.transport,
            status: sessionStatus(session, server),
            cachedTools: session?.toolsCache?.length ?? 0,
            scrubbedEnv: session?.scrubbedEnv ?? [],
            stderr: summarizeStderr(session?.stderr ?? ""),
            lastError: session?.lastError ?? null
          };
        })
      };
    },

    async reconnect(serverName) {
      const server = findServer(servers, serverName);
      if (!server.ok) {
        return server;
      }
      closeStoredSession(sessions.get(server.server.name));
      sessions.delete(server.server.name);
      const connected = await ensureSession(server.server, options.cwd, sessions, options.config);
      return connected.ok
        ? { ok: true, server: server.server.name, status: "connected" }
        : connected;
    },

    async disconnect(serverName) {
      const server = findServer(servers, serverName);
      if (!server.ok) {
        return server;
      }
      closeStoredSession(sessions.get(server.server.name));
      sessions.delete(server.server.name);
      return { ok: true, server: server.server.name, status: "disconnected" };
    },

    /**
     * @param {string} serverName
     */
    async listTools(serverName) {
      const connected = await readySession(servers, serverName, options.cwd, sessions, options.config);
      if (!connected.ok) {
        return connected;
      }
      if (connected.session.toolsCache) {
        return { ok: true, tools: connected.session.toolsCache, cached: true };
      }
      const response = await requestFromSession(connected.session, "tools/list", {});
      if (!response.ok) {
        return response;
      }
      connected.session.toolsCache = response.result.tools ?? [];
      return { ok: true, tools: connected.session.toolsCache, cached: false };
    },

    async listPrompts(serverName) {
      const connected = await readySession(servers, serverName, options.cwd, sessions, options.config);
      if (!connected.ok) {
        return connected;
      }
      const response = await requestFromSession(connected.session, "prompts/list", {});
      return response.ok ? { ok: true, prompts: response.result.prompts ?? [] } : response;
    },

    async listResources(serverName) {
      const connected = await readySession(servers, serverName, options.cwd, sessions, options.config);
      if (!connected.ok) {
        return connected;
      }
      const response = await requestFromSession(connected.session, "resources/list", {});
      return response.ok ? { ok: true, resources: response.result.resources ?? [] } : response;
    },

    async readResource(serverName, uri) {
      const connected = await readySession(servers, serverName, options.cwd, sessions, options.config);
      if (!connected.ok) {
        return connected;
      }
      const response = await requestFromSession(connected.session, "resources/read", { uri });
      return response.ok ? { ok: true, resource: response.result } : response;
    },

    /**
     * @param {string} serverName
     * @param {string} toolName
     * @param {Record<string, any>} args
     */
    async callTool(serverName, toolName, args = {}, signal = undefined) {
      const selected = findServer(servers, serverName);
      if (!selected.ok) {
        return selected;
      }
      const server = selected.server;
      const toolRisk = server.toolRisks[toolName] ?? "mcp";
      const targetPaths = extractMcpTargetPaths(server, toolName, args);
      const networkHosts = extractMcpNetworkHosts(server, toolName, args);
      const decision = decidePermission(
        {
          toolName: `mcp:${server.name}/${toolName}`,
          risk: toolRisk,
          cwd: options.cwd,
          targetPaths,
          networkHosts,
          summary: `Call MCP tool ${server.name}/${toolName}`
        },
        {
          workspace: options.cwd,
          ...(options.policy ?? {})
        }
      );

      if (decision.decision !== "allow") {
        if (decision.decision === "ask" && options.approve) {
          const approved = await options.approve({
            toolName: "mcp_call",
            input: {
              server: server.name,
              tool: toolName,
              arguments: args
            },
            decision,
            definition: {
              name: "mcp_call",
              risk: toolRisk,
              description: `Call MCP tool ${server.name}/${toolName}`
            }
          });
          if (approved) {
            const connected = await readySession(servers, serverName, options.cwd, sessions, options.config);
            if (!connected.ok) {
              return connected;
            }
            const response = await requestFromSession(connected.session, "tools/call", {
              name: toolName,
              arguments: args
            }, signal);
            return response.ok ? { ok: true, result: response.result } : response;
          }
        }
        return { ok: false, blocked: true, decision };
      }

      const connected = await readySession(servers, serverName, options.cwd, sessions, options.config);
      if (!connected.ok) {
        return connected;
      }
      const response = await requestFromSession(connected.session, "tools/call", {
        name: toolName,
        arguments: args
      }, signal);
      return response.ok ? { ok: true, result: response.result } : response;
    },

    close() {
      for (const session of sessions.values()) {
        closeStoredSession(session);
      }
      sessions.clear();
    }
  };
}

/**
 * @param {unknown[]} servers
 */
function normalizeServers(servers) {
  return servers
    .filter((server) => server && typeof server === "object")
    .map((server) => {
      const value = /** @type {Record<string, any>} */ (server);
      const enabled = value.enabled !== false && value.disabled !== true;
      const command = String(value.command ?? "");
      const args = Array.isArray(value.args) ? value.args.map(String) : [];
      const launch = normalizeLaunch(command, args);
      return {
        name: String(value.name ?? ""),
        description: typeof value.description === "string" ? value.description : "",
        enabled,
        transport: value.transport ?? "stdio",
        command: launch.command,
        args: launch.args,
        cwd: typeof value.cwd === "string" ? value.cwd : null,
        env: value.env && typeof value.env === "object" ? value.env : {},
        envAllowlist: Array.isArray(value.envAllowlist ?? value.envAllow)
          ? (value.envAllowlist ?? value.envAllow).map(String)
          : [],
        requestTimeoutMs: Number.isInteger(value.requestTimeoutMs) && value.requestTimeoutMs > 0
          ? value.requestTimeoutMs
          : DEFAULT_REQUEST_TIMEOUT_MS,
        toolRisks: value.toolRisks && typeof value.toolRisks === "object" ? value.toolRisks : {},
        category: typeof value.category === "string" ? value.category : ""
      };
    })
    .filter((server) => server.name && (server.command || !server.enabled));
}

const MCP_PATH_ARGUMENT_KEYS = new Set([
  "path",
  "paths",
  "filepath",
  "filePath",
  "file",
  "files",
  "directory",
  "directories",
  "dir",
  "root",
  "target",
  "destination",
  "source"
]);

const MCP_URL_ARGUMENT_KEYS = new Set([
  "url",
  "urls",
  "uri",
  "uris",
  "href",
  "link",
  "links",
  "endpoint",
  "target"
]);

/**
 * @param {ReturnType<typeof normalizeServers>[number]} server
 * @param {string} toolName
 * @param {Record<string, any>} args
 */
function extractMcpTargetPaths(server, toolName, args = {}) {
  if (!isFilesystemMcpTool(server, toolName)) {
    return [];
  }
  const paths = [];
  collectPathArguments(args, paths);
  return [...new Set(paths.map(String).filter((item) => item.trim()))];
}

/**
 * @param {ReturnType<typeof normalizeServers>[number]} server
 * @param {string} toolName
 * @param {Record<string, any>} args
 */
function extractMcpNetworkHosts(server, toolName, args = {}) {
  const risk = server.toolRisks[toolName] ?? "mcp";
  if (risk !== "network") {
    return [];
  }
  const urls = [];
  collectUrlArguments(args, urls);
  if (urls.length > 0) {
    return [...new Set(urls)];
  }

  const name = String(server.name ?? "").toLowerCase();
  if (name.includes("duckduckgo")) {
    return ["https://duckduckgo.com/"];
  }
  if (name.includes("searxng")) {
    return [String(server.env?.SEARXNG_URL ?? "http://localhost:8080")];
  }
  if (name.includes("github")) {
    return ["https://api.github.com/"];
  }
  return [];
}

function isFilesystemMcpTool(server, toolName) {
  const name = String(server.name ?? "").toLowerCase();
  const category = String(server.category ?? "").toLowerCase();
  const command = [server.command, ...(server.args ?? [])].join(" ").toLowerCase();
  if (category === "filesystem" || name.includes("filesystem") || command.includes("server-filesystem")) {
    return true;
  }
  return false;
}

function collectPathArguments(value, paths, key = "") {
  if (typeof value === "string") {
    if (MCP_PATH_ARGUMENT_KEYS.has(key)) {
      paths.push(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectPathArguments(item, paths, key);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  for (const [entryKey, entryValue] of Object.entries(value)) {
    collectPathArguments(entryValue, paths, entryKey);
  }
}

function collectUrlArguments(value, urls, key = "") {
  if (typeof value === "string") {
    if (MCP_URL_ARGUMENT_KEYS.has(key)) {
      const url = normalizeNetworkUrl(value);
      if (url) {
        urls.push(url);
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectUrlArguments(item, urls, key);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  for (const [entryKey, entryValue] of Object.entries(value)) {
    collectUrlArguments(entryValue, urls, entryKey);
  }
}

function normalizeNetworkUrl(value) {
  const text = String(value ?? "").trim();
  if (!text) {
    return null;
  }
  try {
    const url = new URL(text);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function normalizeLaunch(command, args) {
  const normalizedArgs = args.map(resolvePackageArg);
  if (process.platform === "win32" && /^npx(?:\.cmd)?$/i.test(command)) {
    return { command: "cmd", args: ["/c", "npx", ...normalizedArgs] };
  }
  return { command, args: normalizedArgs };
}

function resolvePackageArg(value) {
  const text = String(value ?? "");
  if (!text.startsWith("package:")) {
    return text;
  }
  const relative = text.slice("package:".length).replace(/^[/\\]+/, "");
  return path.join(PACKAGE_ROOT, relative);
}

async function readySession(servers, serverName, cwd, sessions, config) {
  const selected = findServer(servers, serverName);
  if (!selected.ok) {
    return selected;
  }
  return ensureSession(selected.server, cwd, sessions, config);
}

function findServer(servers, serverName) {
  const server = servers.find((item) => item.name === serverName);
  if (!server) {
    return { ok: false, error: { code: "MCP_SERVER_NOT_FOUND", message: `Unknown MCP server: ${serverName}` } };
  }
  if (!server.enabled) {
    return { ok: false, error: { code: "MCP_SERVER_DISABLED", message: `MCP server is disabled: ${serverName}` } };
  }
  if (server.transport !== "stdio") {
    return { ok: false, error: { code: "MCP_TRANSPORT_UNSUPPORTED", message: "Only explicit stdio MCP servers are supported." } };
  }
  if (!server.command) {
    return { ok: false, error: { code: "MCP_COMMAND_MISSING", message: `MCP server command is missing: ${serverName}` } };
  }
  return { ok: true, server };
}

async function ensureSession(server, cwd, sessions, config) {
  const existing = sessions.get(server.name);
  if (existing && existing.status === "connected") {
    return { ok: true, session: existing };
  }
  closeStoredSession(existing);
  const session = await createStdioSession(server, cwd, config);
  sessions.set(server.name, session);
  const initialized = await requestFromSession(session, "initialize", {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "lab-agent", version: await getAntCodeVersion(PACKAGE_ROOT) }
  });
  if (!initialized.ok) {
    session.status = "failed";
    session.lastError = initialized.error;
    return initialized;
  }
  session.notify("notifications/initialized", {});
  session.status = "connected";
  session.serverInfo = initialized.result.serverInfo ?? null;
  return { ok: true, session };
}

async function requestFromSession(session, method, params, signal = undefined) {
  try {
    const result = await session.request(method, params, signal);
    return { ok: true, result };
  } catch (error) {
    if (isAbortError(error)) {
      return {
        ok: false,
        interrupted: true,
        error: { code: "MCP_INTERRUPTED", message: "MCP request was interrupted by the local user." }
      };
    }
    session.status = "failed";
    session.lastError = {
      code: "MCP_REQUEST_FAILED",
      message: error instanceof Error ? error.message : String(error)
    };
    return { ok: false, error: session.lastError };
  }
}

function isAbortError(error) {
  return error instanceof Error && /aborted/i.test(error.message);
}

/**
 * @param {ReturnType<typeof normalizeServers>[number]} server
 * @param {string} cwd
 */
async function createStdioSession(server, cwd, config) {
  const envWithProxy = withProxyEnvironment({ ...process.env, ...server.env }, { config });
  const scrubbed = scrubEnvironment(envWithProxy, { allow: server.envAllowlist });
  const child = spawn(server.command, server.args, {
    cwd: server.cwd ? path.resolve(cwd, server.cwd) : cwd,
    env: scrubbed.env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"]
  });

  const pending = new Map();
  let nextId = 1;
  const session = {
    name: server.name,
    status: "starting",
    child,
    lines: null,
    stderr: "",
    scrubbedEnv: scrubbed.removed,
    toolsCache: null,
    lastError: null,
    serverInfo: null,
    /**
     * @param {string} method
     * @param {Record<string, any>} params
     */
    request(method, params, signal = undefined) {
      const id = nextId;
      nextId += 1;
      const message = { jsonrpc: "2.0", id, method, params };

      return new Promise((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
          clearTimeout(timeout);
          if (signal) {
            signal.removeEventListener("abort", onAbort);
          }
          pending.delete(id);
        };
        const finish = (fn, value) => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          fn(value);
        };
        const timeout = setTimeout(() => {
          finish(reject, new Error(`MCP request timed out: ${method}${session.stderr ? `; stderr: ${summarizeStderr(session.stderr)}` : ""}`));
        }, server.requestTimeoutMs);
        const onAbort = () => {
          finish(reject, new Error("The operation was aborted"));
        };
        if (signal) {
          if (signal.aborted) {
            finish(reject, new Error("The operation was aborted"));
            return;
          }
          signal.addEventListener("abort", onAbort, { once: true });
        }
        pending.set(id, {
          resolve: (value) => finish(resolve, value),
          reject: (error) => finish(reject, error),
          timeout
        });
        child.stdin.write(`${JSON.stringify(message)}\n`);
      });
    },
    /**
     * @param {string} method
     * @param {Record<string, any>} params
     */
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    },
    close() {
      closePending(pending, new Error("MCP session closed"));
      session.lines?.close();
      child.stdin.end();
      child.kill("SIGTERM");
      session.status = "closed";
    }
  };

  child.stderr.on("data", (chunk) => {
    session.stderr += Buffer.from(chunk).toString("utf8");
    if (session.stderr.length > 4000) {
      session.stderr = session.stderr.slice(-4000);
    }
  });

  child.on("error", (error) => {
    session.status = "failed";
    session.lastError = { code: "MCP_PROCESS_ERROR", message: error.message };
    closePending(pending, error);
  });

  child.on("exit", (code, signal) => {
    if (session.status !== "closed") {
      session.status = "failed";
      session.lastError = { code: "MCP_PROCESS_EXITED", message: `MCP server exited code=${code} signal=${signal}` };
    }
    closePending(pending, new Error(session.lastError?.message ?? "MCP server exited"));
  });

  const lines = readline.createInterface({ input: child.stdout });
  session.lines = lines;
  lines.on("line", (line) => {
    if (!line.trim()) {
      return;
    }
    handleMessage(line, pending);
  });

  return session;
}

function closeStoredSession(session) {
  if (session && session.status !== "closed") {
    session.close();
  }
}

function sessionStatus(session, server) {
  if (!server.enabled) {
    return "disabled";
  }
  return session?.status ?? "not_connected";
}

function summarizeStderr(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= 500 ? text : `${text.slice(0, 500)}...`;
}

function closePending(pending, error) {
  for (const entry of pending.values()) {
    entry.reject(error);
  }
  pending.clear();
}

/**
 * @param {string} line
 * @param {Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }>} pending
 */
function handleMessage(line, pending) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (typeof message.id !== "number") {
    return;
  }

  const entry = pending.get(message.id);
  if (!entry) {
    return;
  }

  if (message.error) {
    entry.reject(new Error(message.error.message ?? "MCP server returned an error"));
  } else {
    entry.resolve(message.result ?? {});
  }
}
