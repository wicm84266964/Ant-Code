import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
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
const SESSION_COOKIE_PREFIX = "antcode_dashboard_session_";
const CSRF_COOKIE_PREFIX = "antcode_dashboard_csrf_";
const CSRF_HEADER = "x-antcode-csrf-token";
const MAX_SSE_CONNECTIONS = 50;
const MAX_SSE_CONNECTIONS_PER_SESSION = 5;
const MAX_SSE_BUFFER_BYTES = 1024 * 1024;
const sseConnectionsByRuntime = new WeakMap();

export const DASHBOARD_BODY_LIMITS = Object.freeze({
  json: 1024 * 1024,
  turn: 40 * 1024 * 1024
});

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'"
].join("; ");

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
    host,
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
 * @param {{ runtime: ReturnType<typeof createDashboardRuntime>; cwd: string; host?: string; publicDir?: string; onShutdown?: () => void }} options
 */
export function createDashboardServer(options) {
  const sockets = new Set();
  const auth = {
    sessionToken: randomBytes(32).toString("base64url"),
    csrfToken: randomBytes(32).toString("base64url")
  };
  let shutdownRequested = false;
  let shutdownFinished = false;
  const configuredHost = normalizeDashboardHost(options.host ?? DEFAULT_HOST);
  const server = http.createServer(async (req, res) => {
    applySecurityHeaders(res);
    try {
      const request = authorizeRequest(req, server, auth, configuredHost);
      if (request.bootstrap) {
        setBootstrapCookies(res, auth, request.port);
      }
      const body = request.apiMutation
        ? await readJson(req, { maxBytes: request.bodyLimit })
        : null;
      await routeRequest(req, res, {
        ...options,
        requestShutdown
      }, request.url, body);
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const status = error instanceof RequestError ? error.status : 500;
      const code = error instanceof RequestError ? error.code : "INTERNAL_ERROR";
      const message = error instanceof RequestError ? error.message : "Internal server error";
      sendJson(res, status, { ok: false, error: message, code });
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

    setImmediate(() => {
      if (server.listening) {
        server.close(finishShutdown);
      } else {
        finishShutdown();
      }

      const socketTimer = setTimeout(() => {
        for (const socket of sockets) {
          socket.destroy();
        }
      }, 1000);
      socketTimer.unref?.();

      const finishTimer = setTimeout(finishShutdown, 1500);
      finishTimer.unref?.();
    });
  }

  function finishShutdown() {
    if (shutdownFinished) {
      return;
    }
    shutdownFinished = true;
    options.onShutdown?.();
  }
}

function authorizeRequest(req, server, auth, configuredHost) {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const { origin, port } = validatedRequestOrigin(req, server, configuredHost);
  const suppliedOrigin = headerValue(req.headers.origin);
  if (suppliedOrigin) {
    let normalizedOrigin;
    try {
      normalizedOrigin = new URL(suppliedOrigin).origin;
    } catch {
      throw new RequestError(403, "ORIGIN_FORBIDDEN", "Request origin is not allowed");
    }
    if (normalizedOrigin !== origin) {
      throw new RequestError(403, "ORIGIN_FORBIDDEN", "Request origin is not allowed");
    }
  }

  if (headerValue(req.headers["sec-fetch-site"])?.toLowerCase() === "cross-site") {
    throw new RequestError(403, "CROSS_SITE_FORBIDDEN", "Cross-site requests are not allowed");
  }

  const apiRequest = url.pathname.startsWith("/api/");
  const apiMutation = apiRequest && isMutationMethod(req.method);
  if (apiRequest) {
    const cookieNames = dashboardCookieNames(port);
    const sessionToken = readCookie(req.headers.cookie, cookieNames.session);
    if (!tokensEqual(sessionToken, auth.sessionToken)) {
      throw new RequestError(401, "AUTH_REQUIRED", "Dashboard authentication is required");
    }

    if (apiMutation) {
      const csrfCookie = readCookie(req.headers.cookie, cookieNames.csrf);
      const csrfHeader = headerValue(req.headers[CSRF_HEADER]);
      if (!tokensEqual(csrfCookie, auth.csrfToken) || !tokensEqual(csrfHeader, auth.csrfToken)) {
        throw new RequestError(403, "CSRF_INVALID", "CSRF validation failed");
      }
      if (contentType(req.headers["content-type"]) !== "application/json") {
        throw new RequestError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json");
      }
    }
  }

  return {
    url,
    port,
    bootstrap: req.method === "GET" && url.pathname === "/",
    apiMutation,
    bodyLimit: url.pathname === "/api/turns" ? DASHBOARD_BODY_LIMITS.turn : DASHBOARD_BODY_LIMITS.json
  };
}

function validatedRequestOrigin(req, server, configuredHost) {
  const host = headerValue(req.headers.host);
  const address = server.address();
  if (!host || !address || typeof address === "string") {
    throw new RequestError(403, "HOST_FORBIDDEN", "Request host is not allowed");
  }

  let parsed;
  try {
    parsed = new URL(`http://${host}`);
  } catch {
    throw new RequestError(403, "HOST_FORBIDDEN", "Request host is not allowed");
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const port = parsed.port ? Number(parsed.port) : 80;
  const expectedHostname = String(configuredHost ?? DEFAULT_HOST).toLowerCase().replace(/^\[|\]$/g, "");
  if (
    hostname !== expectedHostname
    || port !== address.port
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
  ) {
    throw new RequestError(403, "HOST_FORBIDDEN", "Request host is not allowed");
  }
  return { origin: parsed.origin, port: address.port };
}

function setBootstrapCookies(res, auth, port) {
  const names = dashboardCookieNames(port);
  res.setHeader("set-cookie", [
    `${names.session}=${auth.sessionToken}; Path=/; HttpOnly; SameSite=Strict`,
    `${names.csrf}=${auth.csrfToken}; Path=/; SameSite=Strict`
  ]);
}

function dashboardCookieNames(port) {
  return {
    session: `${SESSION_COOKIE_PREFIX}${port}`,
    csrf: `${CSRF_COOKIE_PREFIX}${port}`
  };
}

function readCookie(header, name) {
  const source = headerValue(header);
  if (!source) {
    return "";
  }
  for (const part of source.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) {
      continue;
    }
    const value = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return "";
    }
  }
  return "";
}

function tokensEqual(supplied, expected) {
  if (typeof supplied !== "string" || typeof expected !== "string") {
    return false;
  }
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function headerValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function contentType(value) {
  return headerValue(value).split(";", 1)[0].trim().toLowerCase();
}

function isMutationMethod(method) {
  return ["POST", "PUT", "PATCH", "DELETE"].includes(String(method ?? "").toUpperCase());
}

function applySecurityHeaders(res) {
  res.setHeader("content-security-policy", CONTENT_SECURITY_POLICY);
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
}

class RequestError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "RequestError";
    this.status = status;
    this.code = code;
  }
}

async function routeRequest(req, res, options, url, requestBody) {
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
  if (req.method === "GET" && url.pathname === "/api/lifecycle/status") {
    const result = typeof options.runtime.lifecycleStatus === "function"
      ? await options.runtime.lifecycleStatus()
      : { ok: true, activity: { total: 0 } };
    return sendJson(res, result.ok ? 200 : result.status ?? 400, result);
  }
  if (req.method === "POST" && url.pathname === "/api/model") {
    const body = requestBody ?? {};
    const result = await options.runtime.switchModel(body);
    return sendJson(res, result.ok ? 200 : result.status ?? 400, result);
  }
  if (req.method === "POST" && url.pathname === "/api/gateway-profile") {
    const body = requestBody ?? {};
    const result = await options.runtime.switchGatewayProfile(body);
    return sendJson(res, result.ok ? 200 : result.status ?? 400, result);
  }
  if (req.method === "POST" && url.pathname === "/api/model-config") {
    const body = requestBody ?? {};
    const result = await options.runtime.saveModelConfig(body);
    return sendJson(res, result.ok ? 200 : result.status ?? 400, result);
  }
  if (req.method === "DELETE" && url.pathname.startsWith("/api/model-config/")) {
    const modelId = decodeURIComponent(url.pathname.slice("/api/model-config/".length));
    const body = requestBody ?? {};
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
    const body = requestBody ?? {};
    const result = typeof options.runtime.shutdown === "function"
      ? await options.runtime.shutdown(body)
      : { ok: true, activity: { total: 0 } };
    if (!result.ok) {
      return sendJson(res, result.status ?? 409, result);
    }
    sendJson(res, 200, { ...result, ok: true, message: "Dashboard 正在关闭" });
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
    const body = requestBody ?? {};
    const result = await options.runtime.deleteSession({ ...body, sessionId: id });
    return sendJson(res, result.ok ? 200 : result.status ?? 400, result);
  }
  if (req.method === "POST" && url.pathname === "/api/turns") {
    const body = requestBody ?? {};
    const result = await options.runtime.startTurn(body);
    return sendJson(res, result.ok ? 202 : result.status ?? 400, result);
  }
  if (req.method === "POST" && url.pathname === "/api/turns/interrupt") {
    const body = requestBody ?? {};
    const result = await options.runtime.interruptTurn(body.sessionId, body.reason);
    return sendJson(res, result.ok ? 200 : result.status ?? 400, result);
  }
  if (req.method === "POST" && url.pathname === "/api/turns/queue/cancel") {
    const body = requestBody ?? {};
    const result = options.runtime.cancelQueuedTurn(body);
    return sendJson(res, result.ok ? 200 : result.status ?? 400, result);
  }
  if (req.method === "POST" && url.pathname === "/api/background-subagents/cancel") {
    const body = requestBody ?? {};
    const result = await options.runtime.cancelBackgroundSubagent(body);
    return sendJson(res, result.ok ? 200 : result.status ?? 400, result);
  }
  if (req.method === "POST" && url.pathname === "/api/background-terminals/cancel") {
    const body = requestBody ?? {};
    const result = await options.runtime.cancelBackgroundTerminal(body);
    return sendJson(res, result.ok ? 200 : result.status ?? 400, result);
  }
  if (req.method === "POST" && url.pathname === "/api/turns/guide") {
    const body = requestBody ?? {};
    const result = await options.runtime.guideTurn(body);
    return sendJson(res, result.ok ? 202 : result.status ?? 400, result);
  }
  if (req.method === "POST" && url.pathname === "/api/context/clear") {
    const body = requestBody ?? {};
    const result = await options.runtime.clearContext(body);
    return sendJson(res, result.ok ? 200 : result.status ?? 400, result);
  }
  if (req.method === "POST" && url.pathname === "/api/context/compact") {
    const body = requestBody ?? {};
    const result = await options.runtime.compactContext(body);
    return sendJson(res, result.ok ? 200 : result.status ?? 400, result);
  }
  if (req.method === "GET" && url.pathname === "/api/events") {
    return serveEvents(req, res, options.runtime, url.searchParams.get("sessionId"), url.searchParams.get("after"));
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/approvals/")) {
    const approvalId = decodeURIComponent(url.pathname.slice("/api/approvals/".length));
    const body = requestBody ?? {};
    const result = options.runtime.resolveApproval(approvalId, body.action);
    return sendJson(res, result.ok ? 200 : result.status ?? 400, result);
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/questions/")) {
    const questionId = decodeURIComponent(url.pathname.slice("/api/questions/".length));
    const body = requestBody ?? {};
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
      "content-disposition": contentDispositionHeader(
        result.downloadOnly ? "attachment" : result.contentDisposition,
        result.downloadName
      ),
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
    return boundedFileRequestCwd(options.cwd, options.cwd);
  }
  const result = await options.runtime.sessionCwd(id);
  if (!result.ok) {
    return result;
  }
  return boundedFileRequestCwd(options.cwd, result.cwd ?? options.cwd);
}

async function boundedFileRequestCwd(workspaceCwd, candidateCwd) {
  const [workspaceReal, candidateReal] = await Promise.all([
    fs.realpath(workspaceCwd).catch(() => null),
    fs.realpath(candidateCwd).catch(() => null)
  ]);
  if (!workspaceReal || !candidateReal) {
    return { ok: false, status: 404, code: "SESSION_CWD_NOT_FOUND", error: "会话工作目录不存在" };
  }
  if (!isPathInside(workspaceReal, candidateReal)) {
    return { ok: false, status: 403, code: "SESSION_CWD_OUTSIDE_WORKSPACE", error: "会话工作目录不在 Dashboard 工作区内" };
  }
  return { ok: true, cwd: candidateReal };
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

function contentDispositionHeader(disposition, filename) {
  const type = disposition === "attachment" ? "attachment" : "inline";
  const source = String(filename ?? "download").replace(/[\r\n]/g, "");
  const fallback = source.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "download";
  const encoded = encodeURIComponent(source || "download").replace(/['()*]/g, (character) => (
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  ));
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function serveEvents(req, res, runtime, sessionId, after = null) {
  if (!sessionId) {
    return sendJson(res, 400, { ok: false, error: "sessionId is required" });
  }
  const connections = runtimeSseConnections(runtime);
  const sessionConnections = connections.sessions.get(sessionId) ?? new Set();
  if (connections.all.size >= MAX_SSE_CONNECTIONS || sessionConnections.size >= MAX_SSE_CONNECTIONS_PER_SESSION) {
    return sendJson(res, 429, {
      ok: false,
      code: "SSE_CONNECTION_LIMIT",
      error: "事件连接数已达到上限，请关闭重复页面后重试"
    });
  }
  const connection = { sessionId, response: res };
  connections.all.add(connection);
  sessionConnections.add(connection);
  connections.sessions.set(sessionId, sessionConnections);

  let unsubscribe = null;
  let heartbeat = null;
  let cleaned = false;
  const cleanup = (destroy = false) => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    unsubscribe?.();
    unsubscribe = null;
    connections.all.delete(connection);
    sessionConnections.delete(connection);
    if (sessionConnections.size === 0) {
      connections.sessions.delete(sessionId);
    }
    writer.close();
    if (destroy && !res.destroyed) {
      res.destroy();
    }
  };
  const writer = createSseWriter(res, () => cleanup(true));
  req.once("close", () => cleanup());
  req.once("aborted", () => cleanup(true));
  res.once("close", () => cleanup());
  res.once("error", () => cleanup(true));
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });
  res.flushHeaders?.();
  const send = (event) => {
    const id = Number.isFinite(event?.sequence) ? `id: ${event.sequence}\n` : "";
    writer.write(`event: dashboard\n${id}data: ${JSON.stringify(event)}\n\n`);
  };
  unsubscribe = runtime.subscribe(sessionId, send, {
    afterSequence: eventReplayCursor(after, req.headers["last-event-id"]),
    onDispose: (reason) => {
      writer.write(`event: dashboard\ndata: ${JSON.stringify({ type: "session_disposed", reason })}\n\n`);
      res.end();
      cleanup();
    }
  });
  if (cleaned) {
    unsubscribe?.();
    unsubscribe = null;
    return;
  }
  if (!unsubscribe) {
    writer.write(`event: dashboard\ndata: ${JSON.stringify({ type: "error", message: "会话不存在" })}\n\n`);
    res.end();
    cleanup();
    return;
  }
  heartbeat = setInterval(() => {
    writer.write(`: heartbeat\nevent: heartbeat\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
  }, 15000);
  heartbeat.unref?.();
}

function runtimeSseConnections(runtime) {
  let connections = sseConnectionsByRuntime.get(runtime);
  if (!connections) {
    connections = { all: new Set(), sessions: new Map() };
    sseConnectionsByRuntime.set(runtime, connections);
  }
  return connections;
}

function createSseWriter(res, onFailure) {
  let blocked = false;
  let closed = false;
  let queuedBytes = 0;
  const queue = [];
  const fail = () => {
    if (closed) {
      return;
    }
    closed = true;
    queue.length = 0;
    queuedBytes = 0;
    onFailure();
  };
  const flush = () => {
    if (closed) {
      return;
    }
    blocked = false;
    while (queue.length > 0) {
      const chunk = queue.shift();
      queuedBytes -= Buffer.byteLength(chunk);
      try {
        if (!res.write(chunk)) {
          blocked = true;
          return;
        }
      } catch {
        fail();
        return;
      }
    }
  };
  res.on("drain", flush);
  return {
    write(chunk) {
      if (closed || res.destroyed || res.writableEnded) {
        return false;
      }
      if (blocked) {
        const bytes = Buffer.byteLength(chunk);
        if (queuedBytes + bytes > MAX_SSE_BUFFER_BYTES) {
          fail();
          return false;
        }
        queue.push(chunk);
        queuedBytes += bytes;
        return true;
      }
      try {
        blocked = !res.write(chunk);
        return true;
      } catch {
        fail();
        return false;
      }
    },
    close() {
      closed = true;
      queue.length = 0;
      queuedBytes = 0;
      res.off("drain", flush);
    }
  };
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
  if (!isPathInside(root, resolved)) {
    return sendJson(res, 403, { ok: false, error: "Forbidden" });
  }
  const [rootReal, resolvedReal] = await Promise.all([
    fs.realpath(root).catch(() => null),
    fs.realpath(resolved).catch(() => null)
  ]);
  if (!rootReal || !resolvedReal) {
    return sendJson(res, 404, { ok: false, error: "Not found" });
  }
  if (!isPathInside(rootReal, resolvedReal)) {
    return sendJson(res, 403, { ok: false, error: "Forbidden" });
  }
  const bytes = await fs.readFile(resolvedReal).catch(() => null);
  if (!bytes) {
    return sendJson(res, 404, { ok: false, error: "Not found" });
  }
  res.writeHead(200, {
    "content-type": staticContentType(resolvedReal),
    "cache-control": "no-store"
  });
  res.end(bytes);
}

function isPathInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
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

async function readJson(req, options = {}) {
  const maxBytes = options.maxBytes ?? DASHBOARD_BODY_LIMITS.json;
  const declaredLength = Number(headerValue(req.headers["content-length"]));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    req.resume();
    throw new RequestError(413, "BODY_TOO_LARGE", "Request body is too large");
  }

  const bytes = await readRequestBytes(req, maxBytes);
  if (bytes.length === 0) {
    return {};
  }

  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new RequestError(400, "INVALID_JSON", "Request body must be valid UTF-8 JSON");
  }
  if (!text.trim()) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new RequestError(400, "INVALID_JSON", "Request body must be valid JSON");
  }
}

function readRequestBytes(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;

    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAborted);
    };
    const fail = (error, drain = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (drain) req.resume();
      reject(error);
    };
    const onData = (chunk) => {
      const bytes = Buffer.from(chunk);
      total += bytes.length;
      if (total > maxBytes) {
        fail(new RequestError(413, "BODY_TOO_LARGE", "Request body is too large"), true);
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks, total));
    };
    const onError = () => fail(new RequestError(400, "REQUEST_BODY_ERROR", "Request body could not be read"));
    const onAborted = () => fail(new RequestError(400, "REQUEST_ABORTED", "Request body was aborted"));

    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
    req.once("aborted", onAborted);
  });
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
