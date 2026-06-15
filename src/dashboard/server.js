import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDashboardRuntime } from "./sessions.js";
import { previewFile, readRawFile } from "./files.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 7410;
const DASHBOARD_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(DASHBOARD_DIR, "public");

/**
 * @param {{ cwd: string; env?: NodeJS.ProcessEnv; packageRoot?: string; host?: string; port?: number; open?: boolean; project?: string | null }} options
 */
export async function startDashboard(options) {
  const host = normalizeDashboardHost(options.host ?? DEFAULT_HOST);
  const port = normalizePort(options.port ?? DEFAULT_PORT);
  const cwd = path.resolve(options.cwd, options.project ?? ".");
  const runtime = createDashboardRuntime({ cwd, env: options.env ?? process.env });
  const server = createDashboardServer({
    runtime,
    cwd,
    publicDir: await resolveDashboardPublicDir(options.packageRoot),
    onShutdown: () => process.exit(0)
  });
  const bound = await listenOnAvailablePort(server, { host, port });
  const url = `http://${hostForUrl(host)}:${bound.port}`;
  if (options.open !== false) {
    openBrowser(url);
  }
  return { server, url, host, port: bound.port, cwd };
}

/**
 * @param {string} value
 */
export function normalizeDashboardHost(value) {
  const host = String(value ?? DEFAULT_HOST).trim() || DEFAULT_HOST;
  if (host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]") {
    return host === "[::1]" ? "::1" : host;
  }
  throw new Error("Dashboard 第一版只允许绑定本机地址：127.0.0.1、localhost 或 ::1");
}

/**
 * @param {unknown} value
 */
export function normalizePort(value) {
  const port = Number(value);
  if (Number.isInteger(port) && port > 0 && port <= 65535) {
    return port;
  }
  return DEFAULT_PORT;
}

/**
 * @param {http.Server} server
 * @param {{ host: string; port: number }} options
 */
export async function listenOnAvailablePort(server, options) {
  let port = options.port;
  for (;;) {
    try {
      await listen(server, options.host, port);
      return { port };
    } catch (error) {
      if (error?.code !== "EADDRINUSE" && error?.code !== "EACCES") {
        throw error;
      }
      port += 1;
      if (port > 65535) {
        throw new Error("No available dashboard port found");
      }
    }
  }
}

/**
 * @param {{ runtime: ReturnType<typeof createDashboardRuntime>; cwd: string; publicDir?: string; onShutdown?: () => void }} options
 */
export function createDashboardServer(options) {
  const sockets = new Set();
  let shutdownRequested = false;
  let shutdownFinished = false;
  const server = http.createServer(async (req, res) => {
    try {
      await routeRequest(req, res, {
        ...options,
        requestShutdown
      });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  return server;

  function requestShutdown() {
    if (shutdownRequested) {
      return;
    }
    shutdownRequested = true;

    setTimeout(() => {
      if (server.listening) {
        server.close(finishShutdown);
      } else {
        finishShutdown();
      }

      setTimeout(() => {
        for (const socket of sockets) {
          socket.destroy();
        }
      }, 150).unref?.();

      setTimeout(finishShutdown, 1000).unref?.();
    }, 25).unref?.();
  }

  function finishShutdown() {
    if (shutdownFinished) {
      return;
    }
    shutdownFinished = true;
    options.onShutdown?.();
  }
}

async function routeRequest(req, res, options) {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const publicDir = options.publicDir ?? PUBLIC_DIR;
  if (req.method === "GET" && url.pathname === "/") {
    return serveStatic(res, path.join(publicDir, "index.html"), publicDir);
  }
  if (req.method === "GET" && url.pathname.startsWith("/assets/")) {
    return serveStatic(res, path.join(publicDir, url.pathname.replace(/^\/assets\//, "")), publicDir);
  }
  if (req.method === "GET" && url.pathname === "/api/status") {
    const status = typeof options.runtime.status === "function" ? await options.runtime.status() : { ok: true };
    return sendJson(res, status.ok ? 200 : status.status ?? 400, {
      ok: status.ok !== false,
      cwd: options.cwd,
      version: "dashboard.v1",
      sessionStatus: status.sessionStatus ?? null,
      models: status.models ?? [],
      agentModelTiers: status.agentModelTiers ?? {},
      visionAgent: status.visionAgent ?? null,
      gatewayConfig: status.gatewayConfig ?? null,
      gatewayProfiles: status.gatewayProfiles ?? []
    });
  }
  if (req.method === "POST" && url.pathname === "/api/model") {
    const body = await readJson(req);
    const result = await options.runtime.switchModel(body);
    return sendJson(res, result.ok ? 200 : result.status ?? 400, result);
  }
  if (req.method === "POST" && url.pathname === "/api/gateway-profile") {
    const body = await readJson(req);
    const result = await options.runtime.switchGatewayProfile(body);
    return sendJson(res, result.ok ? 200 : result.status ?? 400, result);
  }
  if (req.method === "POST" && url.pathname === "/api/model-config") {
    const body = await readJson(req);
    const result = await options.runtime.saveModelConfig(body);
    return sendJson(res, result.ok ? 200 : result.status ?? 400, result);
  }
  if (req.method === "DELETE" && url.pathname.startsWith("/api/model-config/")) {
    const modelId = decodeURIComponent(url.pathname.slice("/api/model-config/".length));
    const body = await readJson(req);
    const result = await options.runtime.deleteModelConfig({ ...body, modelId });
    return sendJson(res, result.ok ? 200 : result.status ?? 400, result);
  }
  if (req.method === "GET" && url.pathname === "/api/trust") {
    const result = await options.runtime.trustStatus();
    return sendJson(res, result.ok ? 200 : result.status ?? 400, result);
  }
  if (req.method === "POST" && url.pathname === "/api/trust") {
    const result = await options.runtime.trustWorkspace();
    return sendJson(res, result.ok ? 200 : result.status ?? 400, result);
  }
  if (req.method === "POST" && url.pathname === "/api/shutdown") {
    sendJson(res, 200, { ok: true, message: "Dashboard 正在关闭" });
    options.requestShutdown?.();
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/sessions") {
    return sendJson(res, 200, { ok: true, sessions: await options.runtime.listSessionRecords() });
  }
  if (req.method === "GET" && url.pathname.startsWith("/api/sessions/") && url.pathname.endsWith("/transcript")) {
    const id = decodeURIComponent(url.pathname.slice("/api/sessions/".length, -"/transcript".length));
    const result = await options.runtime.readTranscriptPage({
      sessionId: id,
      before: url.searchParams.get("before"),
      limit: url.searchParams.get("limit")
    });
    return sendJson(res, result.ok ? 200 : result.status ?? 404, result);
  }
  if (req.method === "GET" && url.pathname.startsWith("/api/sessions/")) {
    const id = decodeURIComponent(url.pathname.slice("/api/sessions/".length));
    const result = await options.runtime.readSession(id);
    return sendJson(res, result.ok ? 200 : 404, result);
  }
  if (req.method === "DELETE" && url.pathname.startsWith("/api/sessions/")) {
    const id = decodeURIComponent(url.pathname.slice("/api/sessions/".length));
    const result = await options.runtime.deleteSession({ sessionId: id });
    return sendJson(res, result.ok ? 200 : result.status ?? 400, result);
  }
  if (req.method === "POST" && url.pathname === "/api/turns") {
    const body = await readJson(req);
    const result = await options.runtime.startTurn(body);
    return sendJson(res, result.ok ? 202 : result.status ?? 400, result);
  }
  if (req.method === "POST" && url.pathname === "/api/turns/interrupt") {
    const body = await readJson(req);
    const result = options.runtime.interruptTurn(body.sessionId, body.reason);
    return sendJson(res, result.ok ? 200 : result.status ?? 400, result);
  }
  if (req.method === "POST" && url.pathname === "/api/turns/queue/cancel") {
    const body = await readJson(req);
    const result = options.runtime.cancelQueuedTurn(body);
    return sendJson(res, result.ok ? 200 : result.status ?? 400, result);
  }
  if (req.method === "POST" && url.pathname === "/api/background-subagents/cancel") {
    const body = await readJson(req);
    const result = await options.runtime.cancelBackgroundSubagent(body);
    return sendJson(res, result.ok ? 200 : result.status ?? 400, result);
  }
  if (req.method === "POST" && url.pathname === "/api/turns/guide") {
    const body = await readJson(req);
    const result = options.runtime.guideTurn(body);
    return sendJson(res, result.ok ? 202 : result.status ?? 400, result);
  }
  if (req.method === "POST" && url.pathname === "/api/context/clear") {
    const body = await readJson(req);
    const result = await options.runtime.clearContext(body);
    return sendJson(res, result.ok ? 200 : result.status ?? 400, result);
  }
  if (req.method === "POST" && url.pathname === "/api/context/compact") {
    const body = await readJson(req);
    const result = await options.runtime.compactContext(body);
    return sendJson(res, result.ok ? 200 : result.status ?? 400, result);
  }
  if (req.method === "GET" && url.pathname === "/api/events") {
    return serveEvents(req, res, options.runtime, url.searchParams.get("sessionId"), url.searchParams.get("after"));
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/approvals/")) {
    const approvalId = decodeURIComponent(url.pathname.slice("/api/approvals/".length));
    const body = await readJson(req);
    const result = options.runtime.resolveApproval(approvalId, body.action);
    return sendJson(res, result.ok ? 200 : result.status ?? 400, result);
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/questions/")) {
    const questionId = decodeURIComponent(url.pathname.slice("/api/questions/".length));
    const body = await readJson(req);
    const result = options.runtime.resolveQuestion(questionId, body);
    return sendJson(res, result.ok ? 200 : result.status ?? 400, result);
  }
  if (req.method === "GET" && url.pathname === "/api/files") {
    const sessionId = url.searchParams.get("sessionId") ?? "";
    const cwd = await resolveFileRequestCwd(options, sessionId);
    if (!cwd.ok) {
      return sendJson(res, cwd.status ?? 400, cwd);
    }
    const result = await previewFile(cwd.cwd, url.searchParams.get("path") ?? "");
    return sendJson(res, result.ok ? 200 : result.status ?? 400, withSessionRawUrl(result, sessionId));
  }
  if (req.method === "GET" && url.pathname === "/api/files/raw") {
    const cwd = await resolveFileRequestCwd(options, url.searchParams.get("sessionId") ?? "");
    if (!cwd.ok) {
      return sendJson(res, cwd.status ?? 400, cwd);
    }
    const result = await readRawFile(cwd.cwd, url.searchParams.get("path") ?? "");
    if (!result.ok) {
      return sendJson(res, result.status ?? 400, result);
    }
    res.writeHead(200, {
      "content-type": result.contentType,
      "cache-control": "no-store"
    });
    res.end(result.bytes);
    return;
  }
  return sendJson(res, 404, { ok: false, error: "Not found" });
}

async function resolveFileRequestCwd(options, sessionId) {
  const id = String(sessionId ?? "").trim();
  if (!id || typeof options.runtime.sessionCwd !== "function") {
    return { ok: true, cwd: options.cwd };
  }
  const result = await options.runtime.sessionCwd(id);
  if (!result.ok) {
    return result;
  }
  return { ok: true, cwd: result.cwd ?? options.cwd };
}

function withSessionRawUrl(result, sessionId) {
  const id = String(sessionId ?? "").trim();
  if (!id || !result?.file?.rawUrl) {
    return result;
  }
  return {
    ...result,
    file: {
      ...result.file,
      rawUrl: appendRawUrlSession(result.file.rawUrl, id)
    }
  };
}

function appendRawUrlSession(rawUrl, sessionId) {
  const joiner = String(rawUrl).includes("?") ? "&" : "?";
  return `${rawUrl}${joiner}sessionId=${encodeURIComponent(sessionId)}`;
}

function serveEvents(req, res, runtime, sessionId, after = null) {
  if (!sessionId) {
    return sendJson(res, 400, { ok: false, error: "sessionId is required" });
  }
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });
  const send = (event) => {
    res.write(`event: dashboard\n`);
    if (Number.isFinite(event?.sequence)) {
      res.write(`id: ${event.sequence}\n`);
    }
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const unsubscribe = runtime.subscribe(sessionId, send, {
    afterSequence: eventReplayCursor(after, req.headers["last-event-id"])
  });
  if (!unsubscribe) {
    res.write(`event: dashboard\n`);
    res.write(`data: ${JSON.stringify({ type: "error", message: "会话不存在" })}\n\n`);
    res.end();
    return;
  }
  const heartbeat = setInterval(() => {
    res.write(`: heartbeat\n\n`);
  }, 15000);
  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

function eventReplayCursor(queryValue, lastEventId) {
  const queryCursor = nonNegativeInteger(queryValue);
  if (queryCursor > 0) {
    return queryCursor;
  }
  return nonNegativeInteger(lastEventId);
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

async function serveStatic(res, filePath, rootDir = PUBLIC_DIR) {
  const resolved = path.resolve(filePath);
  const root = path.resolve(rootDir);
  if (!resolved.startsWith(root)) {
    return sendJson(res, 403, { ok: false, error: "Forbidden" });
  }
  const bytes = await fs.readFile(resolved).catch(() => null);
  if (!bytes) {
    return sendJson(res, 404, { ok: false, error: "Not found" });
  }
  res.writeHead(200, {
    "content-type": staticContentType(resolved),
    "cache-control": "no-store"
  });
  res.end(bytes);
}

async function resolveDashboardPublicDir(packageRoot) {
  const candidates = [
    packageRoot ? path.join(packageRoot, "src", "dashboard", "public") : "",
    packageRoot ? path.join(packageRoot, "dashboard", "public") : "",
    PUBLIC_DIR
  ].filter(Boolean);
  for (const candidate of candidates) {
    const stat = await fs.stat(path.join(candidate, "index.html")).catch(() => null);
    if (stat?.isFile()) {
      return candidate;
    }
  }
  return PUBLIC_DIR;
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) {
    return {};
  }
  return JSON.parse(text);
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(`${JSON.stringify(payload)}\n`);
}

function listen(server, host, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function openBrowser(url) {
  const platform = process.platform;
  let child;
  if (platform === "win32") {
    child = spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true });
  } else if (platform === "darwin") {
    child = spawn("open", [url], { detached: true, stdio: "ignore" });
  } else {
    child = spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
  }
  child.unref();
}

function hostForUrl(host) {
  return host === "::1" ? "[::1]" : host;
}

function staticContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".woff2") return "font/woff2";
  if (ext === ".woff") return "font/woff";
  if (ext === ".ttf") return "font/ttf";
  return "application/octet-stream";
}
