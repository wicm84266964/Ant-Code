import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createDashboardServer,
  DASHBOARD_BODY_LIMITS,
  listenOnAvailablePort,
  normalizeDashboardHost,
  normalizePort
} from "../../src/dashboard/server.js";

const dashboardAuthCache = new WeakMap();

test("dashboard host is restricted to loopback", () => {
  assert.equal(normalizeDashboardHost("127.0.0.1"), "127.0.0.1");
  assert.equal(normalizeDashboardHost("localhost"), "localhost");
  assert.equal(normalizeDashboardHost("::1"), "::1");
  assert.throws(() => normalizeDashboardHost("0.0.0.0"), /只允许绑定本机地址/);
});

test("dashboard port normalizes invalid values", () => {
  assert.equal(normalizePort(7411), 7411);
  assert.equal(normalizePort("7422"), 7422);
  assert.equal(normalizePort("bad"), 7410);
  assert.equal(normalizePort(70000), 7410);
});

test("dashboard finds next available port", async () => {
  const blocker = http.createServer((req, res) => res.end("busy"));
  await listen(blocker, "127.0.0.1", 0);
  const used = blocker.address().port;
  const server = http.createServer((req, res) => res.end("ok"));

  try {
    const bound = await listenOnAvailablePort(server, { host: "127.0.0.1", port: used });

    assert.ok(bound.port > used);
    assert.equal(server.listening, true);
  } finally {
    await close(server);
    await close(blocker);
  }
});

test("dashboard shutdown route responds before invoking shutdown callback", async () => {
  let shutdownCalled = false;
  const server = createDashboardServer({
    cwd: process.cwd(),
    runtime: createRuntimeStub(),
    onShutdown: () => {
      shutdownCalled = true;
    }
  });
  await listen(server, "127.0.0.1", 0);

  try {
    const response = await fetchJson(server, "/api/shutdown", { method: "POST" });

    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    await waitFor(() => shutdownCalled);
    assert.equal(shutdownCalled, true);
  } finally {
    await close(server);
  }
});

test("dashboard shutdown route requires an explicit decision when runtime reports active work", async () => {
  let shutdownCalled = false;
  const calls = [];
  const server = createDashboardServer({
    cwd: process.cwd(),
    runtime: {
      ...createRuntimeStub(),
      shutdown: async (body) => {
        calls.push(body);
        return body.force === true
          ? { ok: true, forced: true, activity: { activeTurns: 1, total: 1 } }
          : { ok: false, status: 409, code: "ACTIVE_WORK_REQUIRES_DECISION", activity: { activeTurns: 1, total: 1 } };
      }
    },
    onShutdown: () => {
      shutdownCalled = true;
    }
  });
  await listen(server, "127.0.0.1", 0);

  try {
    const blocked = await fetchJson(server, "/api/shutdown", { method: "POST", body: {} });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.activity.activeTurns, 1);
    assert.equal(shutdownCalled, false);

    const forced = await fetchJson(server, "/api/shutdown", { method: "POST", body: { force: true } });
    assert.equal(forced.status, 200);
    assert.equal(forced.body.forced, true);
    await waitFor(() => shutdownCalled);
    assert.deepEqual(calls, [{}, { force: true }]);
  } finally {
    await close(server);
  }
});

test("dashboard status route includes runtime session status", async () => {
  const server = createDashboardServer({
    cwd: process.cwd(),
    runtime: {
      ...createRuntimeStub(),
      status: async () => ({
        ok: true,
        sessionStatus: {
          model: "mock-model",
          context: { promptTokens: 1200, maxTokens: 200000 }
        },
        models: [{ id: "mock-model", label: "Mock", current: true, modalities: ["text"] }],
        agentModelTiers: { default: "mock-flash" },
        visionAgent: { enabled: true, model: "vision-model", autoUseWhenMainModelTextOnly: true },
        gatewayConfig: { gatewayUrl: "https://gateway.example/v1/chat/completions", apiKeyConfigured: true }
      })
    }
  });
  await listen(server, "127.0.0.1", 0);

  try {
    const response = await fetchJson(server, "/api/status");

    assert.equal(response.status, 200);
    assert.equal(response.body.cwd, process.cwd());
    assert.equal(response.body.sessionStatus.model, "mock-model");
    assert.equal(response.body.sessionStatus.context.maxTokens, 200000);
    assert.deepEqual(response.body.models, [{ id: "mock-model", label: "Mock", current: true, modalities: ["text"] }]);
    assert.deepEqual(response.body.agentModelTiers, { default: "mock-flash" });
    assert.deepEqual(response.body.visionAgent, { enabled: true, model: "vision-model", autoUseWhenMainModelTextOnly: true });
    assert.deepEqual(response.body.gatewayConfig, { gatewayUrl: "https://gateway.example/v1/chat/completions", apiKeyConfigured: true });
  } finally {
    await close(server);
  }
});

test("dashboard lifecycle status route exposes activity counts", async () => {
  const activity = {
    sessions: 2,
    activeTurns: 1,
    quarantinedTurns: 0,
    queuedTurns: 3,
    backgroundTasks: 2,
    pendingInteractions: 1,
    total: 7
  };
  const server = createDashboardServer({
    cwd: process.cwd(),
    runtime: {
      ...createRuntimeStub(),
      lifecycleStatus: async () => ({ ok: true, activity })
    }
  });
  await listen(server, "127.0.0.1", 0);

  try {
    const response = await fetchJson(server, "/api/lifecycle/status");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.activity, activity);
  } finally {
    await close(server);
  }
});

test("dashboard model route forwards model switch requests", async () => {
  const calls = [];
  const server = createDashboardServer({
    cwd: process.cwd(),
    runtime: {
      ...createRuntimeStub(),
      switchModel: async (body) => {
        calls.push(body);
        return {
          ok: true,
          sessionStatus: { model: body.modelId, context: { maxTokens: 128000 } },
          models: [{ id: body.modelId, current: true, modalities: ["text", "image"] }]
        };
      }
    }
  });
  await listen(server, "127.0.0.1", 0);

  try {
    const response = await fetchJson(server, "/api/model", {
      method: "POST",
      body: { modelId: "vision-model", sessionId: "s1" }
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.sessionStatus.model, "vision-model");
    assert.deepEqual(calls, [{ modelId: "vision-model", sessionId: "s1" }]);
  } finally {
    await close(server);
  }
});

test("dashboard model config route forwards save requests", async () => {
  const calls = [];
  const server = createDashboardServer({
    cwd: process.cwd(),
    runtime: {
      ...createRuntimeStub(),
      saveModelConfig: async (body) => {
        calls.push(body);
        return {
          ok: true,
          gatewayConfig: { gatewayUrl: body.gatewayUrl, apiKeyConfigured: Boolean(body.gatewayApiKey) },
          sessionStatus: { model: body.modelId, context: { maxTokens: 128000 } },
          models: [{ id: body.modelId, current: true, modalities: ["text", "image"] }]
        };
      }
    }
  });
  await listen(server, "127.0.0.1", 0);

  try {
    const response = await fetchJson(server, "/api/model-config", {
      method: "POST",
      body: {
        gatewayUrl: "https://gateway.example/v1/chat/completions",
        gatewayApiKey: "secret",
        modelId: "vision-model"
      }
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.sessionStatus.model, "vision-model");
    assert.equal(response.body.gatewayConfig.apiKeyConfigured, true);
    assert.deepEqual(calls, [{
      gatewayUrl: "https://gateway.example/v1/chat/completions",
      gatewayApiKey: "secret",
      modelId: "vision-model"
    }]);
  } finally {
    await close(server);
  }
});

test("dashboard model config route forwards delete requests", async () => {
  const calls = [];
  const server = createDashboardServer({
    cwd: process.cwd(),
    runtime: {
      ...createRuntimeStub(),
      deleteModelConfig: async (body) => {
        calls.push(body);
        return {
          ok: true,
          deletedModel: body.modelId,
          sessionStatus: { model: "fallback-model", context: { maxTokens: 128000 } },
          models: [{ id: "fallback-model", current: true, modalities: ["text"] }]
        };
      }
    }
  });
  await listen(server, "127.0.0.1", 0);

  try {
    const response = await fetchJson(server, "/api/model-config/bad-model", {
      method: "DELETE",
      body: { sessionId: "s1" }
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.deletedModel, "bad-model");
    assert.deepEqual(calls, [{ sessionId: "s1", modelId: "bad-model" }]);
  } finally {
    await close(server);
  }
});

test("dashboard gateway profile route forwards switch requests", async () => {
  const calls = [];
  const server = createDashboardServer({
    cwd: process.cwd(),
    runtime: {
      ...createRuntimeStub(),
      switchGatewayProfile: async (body) => {
        calls.push(body);
        return {
          ok: true,
          gatewayConfig: { gatewayUrl: "https://alpha-gateway.example/v1/chat/completions", activeProfileId: body.profileId },
          gatewayProfiles: [{ id: body.profileId, current: true }],
          sessionStatus: { model: "alpha-pro", context: { maxTokens: 400000 } },
          models: [{ id: "alpha-pro", current: true, modalities: ["text"] }]
        };
      }
    }
  });
  await listen(server, "127.0.0.1", 0);

  try {
    const response = await fetchJson(server, "/api/gateway-profile", {
      method: "POST",
      body: { profileId: "gw-alpha", sessionId: "s1" }
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.gatewayConfig.activeProfileId, "gw-alpha");
    assert.deepEqual(calls, [{ profileId: "gw-alpha", sessionId: "s1" }]);
  } finally {
    await close(server);
  }
});

test("dashboard server serves static assets from configured public dir", async () => {
  const publicDir = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-public-"));
  await fs.mkdir(path.join(publicDir, "vendor"), { recursive: true });
  await fs.writeFile(path.join(publicDir, "index.html"), "<!doctype html><script src=\"/assets/app.js\"></script>");
  await fs.writeFile(path.join(publicDir, "app.js"), "console.log('dashboard');");
  await fs.writeFile(path.join(publicDir, "vendor", "rich-renderers.js"), "export {};");
  const server = createDashboardServer({
    cwd: process.cwd(),
    publicDir,
    runtime: createRuntimeStub()
  });
  await listen(server, "127.0.0.1", 0);

  try {
    const index = await fetchBuffer(server, "/");
    const app = await fetchBuffer(server, "/assets/app.js");
    const vendor = await fetchBuffer(server, "/assets/vendor/rich-renderers.js");

    assert.equal(index.status, 200);
    assert.equal(index.contentType, "text/html; charset=utf-8");
    assert.match(index.body.toString("utf8"), /doctype html/);
    assert.equal(app.status, 200);
    assert.equal(app.contentType, "text/javascript; charset=utf-8");
    assert.equal(vendor.status, 200);
  } finally {
    await close(server);
  }
});

test("dashboard question route forwards answers to runtime", async () => {
  let forwarded = null;
  const server = createDashboardServer({
    cwd: process.cwd(),
    runtime: {
      ...createRuntimeStub(),
      resolveQuestion: (id, answer) => {
        forwarded = { id, answer };
        return { ok: true };
      }
    }
  });
  await listen(server, "127.0.0.1", 0);

  try {
    const response = await fetchJson(server, "/api/questions/question-1", {
      method: "POST",
      body: {
        selectedChoices: ["Markdown"],
        customAnswer: "保留图表说明"
      }
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.deepEqual(forwarded, {
      id: "question-1",
      answer: {
        selectedChoices: ["Markdown"],
        customAnswer: "保留图表说明"
      }
    });
  } finally {
    await close(server);
  }
});

test("dashboard trust routes forward to runtime", async () => {
  const calls = [];
  const server = createDashboardServer({
    cwd: process.cwd(),
    runtime: {
      ...createRuntimeStub(),
      trustStatus: async () => {
        calls.push("status");
        return { ok: true, trust: { trusted: false, displayPath: process.cwd() } };
      },
      trustWorkspace: async () => {
        calls.push("trust");
        return { ok: true, trust: { trusted: true, displayPath: process.cwd() } };
      }
    }
  });
  await listen(server, "127.0.0.1", 0);

  try {
    const status = await fetchJson(server, "/api/trust");
    const trusted = await fetchJson(server, "/api/trust", { method: "POST" });

    assert.equal(status.status, 200);
    assert.equal(status.body.trust.trusted, false);
    assert.equal(trusted.status, 200);
    assert.equal(trusted.body.trust.trusted, true);
    assert.deepEqual(calls, ["status", "trust"]);
  } finally {
    await close(server);
  }
});

test("dashboard turn control and context routes forward to runtime", async () => {
  const calls = [];
  const server = createDashboardServer({
    cwd: process.cwd(),
    runtime: {
      ...createRuntimeStub(),
      startTurn: async (body) => {
        calls.push(["start", body.sessionId, body.requestId, body.prompt]);
        return { ok: true };
      },
      interruptTurn: (sessionId, reason) => {
        calls.push(["interrupt", sessionId, reason]);
        return { ok: true };
      },
      cancelQueuedTurn: (body) => {
        calls.push(["cancel-queue", body.sessionId, body.queueItemId]);
        return { ok: true };
      },
      cancelBackgroundSubagent: async (body) => {
        calls.push(["cancel-background", body.sessionId, body.groupId, body.taskId]);
        return { ok: true };
      },
      guideTurn: (body) => {
        calls.push(["guide", body.sessionId, body.guidance, body.queueItemId]);
        return { ok: true };
      },
      deleteSession: async (body) => {
        calls.push(["delete", body.sessionId, body.cancelActive, body.cancelBackground]);
        return { ok: true };
      },
      clearContext: async (body) => {
        calls.push(["clear", body.sessionId]);
        return { ok: true };
      },
      compactContext: async (body) => {
        calls.push(["compact", body.sessionId]);
        return { ok: true };
      }
    }
  });
  await listen(server, "127.0.0.1", 0);

  try {
    assert.equal((await fetchJson(server, "/api/turns", {
      method: "POST",
      body: { sessionId: "s1", requestId: "request-1", prompt: "run once" }
    })).status, 202);
    assert.equal((await fetchJson(server, "/api/turns/interrupt", {
      method: "POST",
      body: { sessionId: "s1", reason: "user" }
    })).status, 200);
    assert.equal((await fetchJson(server, "/api/turns/guide", {
      method: "POST",
      body: { sessionId: "s1", guidance: "focus tests", queueItemId: "q1" }
    })).status, 202);
    assert.equal((await fetchJson(server, "/api/turns/queue/cancel", {
      method: "POST",
      body: { sessionId: "s1", queueItemId: "q2" }
    })).status, 200);
    assert.equal((await fetchJson(server, "/api/background-subagents/cancel", {
      method: "POST",
      body: { sessionId: "s1", groupId: "g1", taskId: "t1" }
    })).status, 200);
    assert.equal((await fetchJson(server, "/api/sessions/s1", {
      method: "DELETE",
      body: { cancelActive: true, cancelBackground: true }
    })).status, 200);
    assert.equal((await fetchJson(server, "/api/context/clear", {
      method: "POST",
      body: { sessionId: "s1" }
    })).status, 200);
    assert.equal((await fetchJson(server, "/api/context/compact", {
      method: "POST",
      body: { sessionId: "s1" }
    })).status, 200);

    assert.deepEqual(calls, [
      ["start", "s1", "request-1", "run once"],
      ["interrupt", "s1", "user"],
      ["guide", "s1", "focus tests", "q1"],
      ["cancel-queue", "s1", "q2"],
      ["cancel-background", "s1", "g1", "t1"],
      ["delete", "s1", true, true],
      ["clear", "s1"],
      ["compact", "s1"]
    ]);
  } finally {
    await close(server);
  }
});

test("dashboard transcript route forwards paging options to runtime", async () => {
  const calls = [];
  const server = createDashboardServer({
    cwd: process.cwd(),
    runtime: {
      ...createRuntimeStub(),
      readTranscriptPage: async (body) => {
        calls.push(body);
        return {
          ok: true,
          sessionId: body.sessionId,
          transcript: [{ role: "user", content: "older" }],
          transcriptPage: { cursor: null, hasMore: false, total: 1 }
        };
      }
    }
  });
  await listen(server, "127.0.0.1", 0);

  try {
    const response = await fetchJson(server, "/api/sessions/s1/transcript?before=55&limit=100");

    assert.equal(response.status, 200);
    assert.deepEqual(calls, [{ sessionId: "s1", before: "55", limit: "100" }]);
    assert.deepEqual(response.body.transcript, [{ role: "user", content: "older" }]);
  } finally {
    await close(server);
  }
});

test("dashboard events route uses sequence cursor for replay", async () => {
  const calls = [];
  const server = createDashboardServer({
    cwd: process.cwd(),
    runtime: {
      ...createRuntimeStub(),
      subscribe: (sessionId, send, options) => {
        calls.push({ sessionId, options });
        send({ type: "user_message", id: "event-3", sequence: 3, text: "new" });
        return () => {};
      }
    }
  });
  await listen(server, "127.0.0.1", 0);

  try {
    const response = await fetchFirstStreamChunk(server, "/api/events?sessionId=s1&after=2");

    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].sessionId, "s1");
    assert.equal(calls[0].options.afterSequence, 2);
    assert.equal(typeof calls[0].options.onDispose, "function");
    assert.match(response.text, /id: 3/);
    assert.match(response.text, /"text":"new"/);
  } finally {
    await close(server);
  }
});

test("dashboard events expose heartbeat events to clients", async () => {
  const originalSetInterval = globalThis.setInterval;
  const server = createDashboardServer({
    cwd: process.cwd(),
    runtime: {
      ...createRuntimeStub(),
      subscribe: () => () => {}
    }
  });
  await listen(server, "127.0.0.1", 0);
  globalThis.setInterval = (callback, _delay, ...args) => originalSetInterval(callback, 5, ...args);

  try {
    const response = await fetchFirstStreamChunk(server, "/api/events?sessionId=heartbeat-session");
    assert.equal(response.status, 200);
    assert.match(response.text, /: heartbeat/);
    assert.match(response.text, /event: heartbeat/);
    assert.match(response.text, /"at":"/);
  } finally {
    globalThis.setInterval = originalSetInterval;
    await close(server);
  }
});

test("dashboard events cap duplicate connections per session", async () => {
  let subscriptions = 0;
  let unsubscriptions = 0;
  const server = createDashboardServer({
    cwd: process.cwd(),
    runtime: {
      ...createRuntimeStub(),
      subscribe: () => {
        subscriptions += 1;
        return () => {
          unsubscriptions += 1;
        };
      }
    }
  });
  await listen(server, "127.0.0.1", 0);
  const streams = [];

  try {
    for (let index = 0; index < 5; index += 1) {
      streams.push(await openEventStream(server, "/api/events?sessionId=connection-limited"));
    }
    const limited = await fetchJson(server, "/api/events?sessionId=connection-limited");
    assert.equal(limited.status, 429);
    assert.equal(limited.body.code, "SSE_CONNECTION_LIMIT");
    assert.equal(subscriptions, 5);
  } finally {
    for (const stream of streams) {
      stream.request.destroy();
    }
    await waitFor(() => unsubscriptions === streams.length);
    await close(server);
  }
});

test("dashboard file routes resolve paths through the selected session cwd", async () => {
  const dashboardCwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-root-"));
  const sessionCwd = path.join(dashboardCwd, "session");
  await fs.mkdir(sessionCwd);
  await fs.writeFile(path.join(sessionCwd, "chart.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await fs.writeFile(path.join(sessionCwd, "unsafe.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const server = createDashboardServer({
    cwd: dashboardCwd,
    runtime: {
      ...createRuntimeStub(),
      sessionCwd: async (sessionId) => (
        sessionId === "session-with-image"
          ? { ok: true, cwd: sessionCwd }
          : { ok: false, status: 404, error: "会话不存在" }
      )
    }
  });
  await listen(server, "127.0.0.1", 0);

  try {
    const preview = await fetchJson(server, "/api/files?path=chart.png&sessionId=session-with-image");
    const raw = await fetchBuffer(server, "/api/files/raw?path=chart.png&sessionId=session-with-image");
    const svg = await fetchBuffer(server, "/api/files/raw?path=unsafe.svg&sessionId=session-with-image");
    const missing = await fetchJson(server, "/api/files?path=chart.png");

    assert.equal(preview.status, 200);
    assert.equal(preview.body.file.kind, "image");
    assert.equal(preview.body.file.rawUrl, "/api/files/raw?path=chart.png&sessionId=session-with-image");
    assert.equal(raw.status, 200);
    assert.equal(raw.contentType, "image/png");
    assert.match(raw.headers["content-disposition"], /^inline; filename="chart\.png";/);
    assert.equal(raw.headers["x-content-type-options"], "nosniff");
    assert.deepEqual(Array.from(raw.body.subarray(0, 4)), [0x89, 0x50, 0x4e, 0x47]);
    assert.equal(svg.status, 200);
    assert.equal(svg.contentType, "application/octet-stream");
    assert.match(svg.headers["content-disposition"], /^attachment; filename="unsafe\.svg";/);
    assert.equal(svg.headers["x-content-type-options"], "nosniff");
    assert.notEqual(svg.contentType, "image/svg+xml");
    assert.equal(missing.status, 404);
  } finally {
    await close(server);
  }
});

test("dashboard file routes reject a session cwd outside the startup workspace", async () => {
  const dashboardCwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-root-"));
  const outsideCwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-outside-"));
  await fs.writeFile(path.join(outsideCwd, "secret.txt"), "outside");
  const server = createDashboardServer({
    cwd: dashboardCwd,
    runtime: {
      ...createRuntimeStub(),
      sessionCwd: async () => ({ ok: true, cwd: outsideCwd })
    }
  });
  await listen(server, "127.0.0.1", 0);

  try {
    const response = await fetchJson(server, "/api/files?path=secret.txt&sessionId=escaped-session");
    assert.equal(response.status, 403);
    assert.equal(response.body.code, "SESSION_CWD_OUTSIDE_WORKSPACE");
  } finally {
    await close(server);
  }
});

test("dashboard bootstrap issues isolated session and csrf cookies with security headers", async () => {
  const first = createDashboardServer({ cwd: process.cwd(), runtime: createRuntimeStub() });
  const second = createDashboardServer({ cwd: process.cwd(), runtime: createRuntimeStub() });
  await listen(first, "127.0.0.1", 0);
  await listen(second, "127.0.0.1", 0);

  try {
    const firstPage = await requestDashboard(first, "/");
    const secondPage = await requestDashboard(second, "/");
    const firstCookies = firstPage.headers["set-cookie"] ?? [];
    const secondCookies = secondPage.headers["set-cookie"] ?? [];
    const sessionCookie = firstCookies.find((cookie) => cookie.startsWith("antcode_dashboard_session_"));
    const csrfCookie = firstCookies.find((cookie) => cookie.startsWith("antcode_dashboard_csrf_"));

    assert.equal(firstPage.status, 200);
    assert.equal(firstCookies.length, 2);
    assert.match(sessionCookie, /; Path=\/; HttpOnly; SameSite=Strict$/);
    assert.match(csrfCookie, /; Path=\/; SameSite=Strict$/);
    assert.doesNotMatch(csrfCookie, /HttpOnly/);
    assert.ok(sessionCookie.split("=", 2)[1].split(";", 1)[0].length >= 22);
    assert.notDeepEqual(
      firstCookies.map((cookie) => cookie.split(";", 1)[0].replace(/_\d+=/, "=")),
      secondCookies.map((cookie) => cookie.split(";", 1)[0].replace(/_\d+=/, "="))
    );
    assert.match(firstPage.headers["content-security-policy"], /default-src 'self'/);
    assert.match(firstPage.headers["content-security-policy"], /frame-ancestors 'none'/);
    assert.match(firstPage.headers["content-security-policy"], /object-src 'none'/);
    assert.match(firstPage.headers["content-security-policy"], /base-uri 'none'/);
    assert.equal(firstPage.headers["x-frame-options"], "DENY");
    assert.equal(firstPage.headers["x-content-type-options"], "nosniff");
    assert.equal(firstPage.headers["referrer-policy"], "no-referrer");
  } finally {
    await close(first);
    await close(second);
  }
});

test("dashboard api requires its per-process session cookie", async () => {
  let statusCalls = 0;
  const server = createDashboardServer({
    cwd: process.cwd(),
    runtime: {
      ...createRuntimeStub(),
      status: async () => {
        statusCalls += 1;
        return { ok: true };
      }
    }
  });
  await listen(server, "127.0.0.1", 0);

  try {
    const port = server.address().port;
    const missing = await fetchJson(server, "/api/status", { authenticate: false });
    const incorrect = await fetchJson(server, "/api/status", {
      authenticate: false,
      headers: { cookie: `antcode_dashboard_session_${port}=incorrect` }
    });
    const valid = await fetchJson(server, "/api/status");

    assert.equal(missing.status, 401);
    assert.equal(missing.body.code, "AUTH_REQUIRED");
    assert.equal(incorrect.status, 401);
    assert.equal(valid.status, 200);
    assert.equal(statusCalls, 1);
  } finally {
    await close(server);
  }
});

test("dashboard rejects forged host, foreign origin, and cross-site requests", async () => {
  let statusCalls = 0;
  const server = createDashboardServer({
    cwd: process.cwd(),
    runtime: {
      ...createRuntimeStub(),
      status: async () => {
        statusCalls += 1;
        return { ok: true };
      }
    }
  });
  await listen(server, "127.0.0.1", 0);

  try {
    const port = server.address().port;
    const forgedHost = await fetchJson(server, "/api/status", {
      headers: { host: `dashboard.attacker.test:${port}` }
    });
    const wrongPort = await fetchJson(server, "/api/status", {
      headers: { host: `127.0.0.1:${port + 1}` }
    });
    const foreignOrigin = await fetchJson(server, "/api/status", {
      headers: { origin: "https://attacker.test" }
    });
    const crossSite = await fetchJson(server, "/api/status", {
      headers: { "sec-fetch-site": "cross-site" }
    });
    const localhost = await fetchJson(server, "/api/status", {
      headers: {
        host: `localhost:${port}`,
        origin: `http://localhost:${port}`
      }
    });
    const valid = await fetchJson(server, "/api/status");

    assert.equal(forgedHost.status, 403);
    assert.equal(forgedHost.body.code, "HOST_FORBIDDEN");
    assert.equal(wrongPort.status, 403);
    assert.equal(foreignOrigin.status, 403);
    assert.equal(foreignOrigin.body.code, "ORIGIN_FORBIDDEN");
    assert.equal(crossSite.status, 403);
    assert.equal(crossSite.body.code, "CROSS_SITE_FORBIDDEN");
    assert.equal(localhost.status, 403);
    assert.equal(valid.status, 200);
    assert.equal(statusCalls, 1);
  } finally {
    await close(server);
  }
});

test("dashboard cross-site requests cannot trigger critical write routes", async () => {
  const calls = [];
  let shutdownCalled = false;
  const server = createDashboardServer({
    cwd: process.cwd(),
    runtime: {
      ...createRuntimeStub(),
      trustWorkspace: async () => {
        calls.push("trust");
        return { ok: true };
      },
      startTurn: async () => {
        calls.push("turn");
        return { ok: true };
      }
    },
    onShutdown: () => {
      shutdownCalled = true;
    }
  });
  await listen(server, "127.0.0.1", 0);

  try {
    for (const pathName of ["/api/trust", "/api/turns", "/api/shutdown"]) {
      const response = await fetchJson(server, pathName, {
        method: "POST",
        body: {},
        headers: { origin: "https://attacker.test" }
      });
      assert.equal(response.status, 403);
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(calls, []);
    assert.equal(shutdownCalled, false);
  } finally {
    await close(server);
  }
});

test("dashboard write routes require csrf and application/json", async () => {
  let trustCalls = 0;
  const server = createDashboardServer({
    cwd: process.cwd(),
    runtime: {
      ...createRuntimeStub(),
      trustWorkspace: async () => {
        trustCalls += 1;
        return { ok: true };
      }
    }
  });
  await listen(server, "127.0.0.1", 0);

  try {
    const missingCsrf = await fetchJson(server, "/api/trust", {
      method: "POST",
      body: {},
      csrf: false
    });
    const wrongCsrf = await fetchJson(server, "/api/trust", {
      method: "POST",
      body: {},
      headers: { "x-antcode-csrf-token": "incorrect" }
    });
    const plainText = await fetchJson(server, "/api/trust", {
      method: "POST",
      rawBody: "{}",
      contentType: "text/plain"
    });
    const form = await fetchJson(server, "/api/trust", {
      method: "POST",
      rawBody: "value=true",
      contentType: "application/x-www-form-urlencoded"
    });
    const malformed = await fetchJson(server, "/api/trust", {
      method: "POST",
      rawBody: "{not-json"
    });
    const valid = await fetchJson(server, "/api/trust", { method: "POST", body: {} });

    assert.equal(missingCsrf.status, 403);
    assert.equal(missingCsrf.body.code, "CSRF_INVALID");
    assert.equal(wrongCsrf.status, 403);
    assert.equal(plainText.status, 415);
    assert.equal(plainText.body.code, "UNSUPPORTED_MEDIA_TYPE");
    assert.equal(form.status, 415);
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.code, "INVALID_JSON");
    assert.equal(valid.status, 200);
    assert.equal(trustCalls, 1);
  } finally {
    await close(server);
  }
});

test("dashboard enforces streaming json limits and a larger turn body limit", async () => {
  let modelCalls = 0;
  let turnCalls = 0;
  const server = createDashboardServer({
    cwd: process.cwd(),
    runtime: {
      ...createRuntimeStub(),
      switchModel: async () => {
        modelCalls += 1;
        return { ok: true };
      },
      startTurn: async () => {
        turnCalls += 1;
        return { ok: true };
      }
    }
  });
  await listen(server, "127.0.0.1", 0);

  try {
    const oversizedJson = Buffer.from(JSON.stringify({ value: "x".repeat(DASHBOARD_BODY_LIMITS.json) }));
    const contentLength = await fetchJson(server, "/api/model", {
      method: "POST",
      declaredContentLength: DASHBOARD_BODY_LIMITS.json + 1
    });
    const chunked = await fetchJson(server, "/api/model", {
      method: "POST",
      chunks: [oversizedJson.subarray(0, 600000), oversizedJson.subarray(600000)]
    });
    const largerTurn = await fetchJson(server, "/api/turns", {
      method: "POST",
      body: { prompt: "x".repeat(DASHBOARD_BODY_LIMITS.json + 1024) }
    });

    assert.equal(contentLength.status, 413);
    assert.equal(contentLength.body.code, "BODY_TOO_LARGE");
    assert.equal(chunked.status, 413);
    assert.equal(chunked.body.code, "BODY_TOO_LARGE");
    assert.equal(largerTurn.status, 202);
    assert.equal(modelCalls, 0);
    assert.equal(turnCalls, 1);
  } finally {
    await close(server);
  }
});

function listen(server, host, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
}

function close(server) {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(resolve);
  });
}

function createRuntimeStub() {
  return {
    trustStatus: async () => ({ ok: true, trust: { trusted: true } }),
    trustWorkspace: async () => ({ ok: true, trust: { trusted: true } }),
    listSessionRecords: async () => [],
    readSession: async () => ({ ok: false }),
    readTranscriptPage: async () => ({ ok: false }),
    startTurn: async () => ({ ok: false }),
    interruptTurn: () => ({ ok: false }),
    cancelQueuedTurn: () => ({ ok: false }),
    cancelBackgroundSubagent: async () => ({ ok: false }),
    guideTurn: () => ({ ok: false }),
    deleteSession: async () => ({ ok: false }),
    deleteModelConfig: async () => ({ ok: false }),
    clearContext: async () => ({ ok: false }),
    compactContext: async () => ({ ok: false }),
    sessionCwd: async () => ({ ok: false }),
    resolveApproval: () => ({ ok: false }),
    resolveQuestion: () => ({ ok: false }),
    subscribe: () => null
  };
}

async function fetchJson(server, pathName, options = {}) {
  const response = await requestDashboard(server, pathName, options);
  return {
    status: response.status,
    headers: response.headers,
    body: JSON.parse(response.body.toString("utf8"))
  };
}

async function fetchBuffer(server, pathName, options = {}) {
  const response = await requestDashboard(server, pathName, options);
  return {
    status: response.status,
    headers: response.headers,
    contentType: response.headers["content-type"],
    body: response.body
  };
}

async function requestDashboard(server, pathName, options = {}) {
  const { port } = server.address();
  const method = String(options.method ?? "GET").toUpperCase();
  const hasBody = Object.prototype.hasOwnProperty.call(options, "body");
  const payload = Object.prototype.hasOwnProperty.call(options, "rawBody")
    ? Buffer.from(options.rawBody)
    : hasBody
      ? Buffer.from(JSON.stringify(options.body))
      : Buffer.alloc(0);
  const headers = {
    connection: "close"
  };
  if (options.contentType !== null) {
    headers["content-type"] = options.contentType ?? "application/json";
  }
  if (pathName.startsWith("/api/") && options.authenticate !== false) {
    const auth = await dashboardAuth(server);
    headers.cookie = auth.cookie;
    if (["POST", "PUT", "PATCH", "DELETE"].includes(method) && options.csrf !== false) {
      headers["x-antcode-csrf-token"] = auth.csrfToken;
    }
  }
  if (!options.chunks && (payload.length > 0 || options.declaredContentLength !== undefined)) {
    headers["content-length"] = options.declaredContentLength ?? payload.length;
  }
  Object.assign(headers, options.headers ?? {});

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: pathName,
      method,
      headers
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks)
        });
      });
    });
    req.on("error", reject);
    if (options.chunks) {
      for (const chunk of options.chunks) {
        req.write(chunk);
      }
    } else if (payload.length > 0) {
      req.write(payload);
    }
    req.end();
  });
}

async function dashboardAuth(server) {
  let auth = dashboardAuthCache.get(server);
  if (!auth) {
    auth = requestDashboard(server, "/").then((response) => {
      assert.equal(response.status, 200);
      const setCookies = response.headers["set-cookie"] ?? [];
      const cookiePairs = setCookies.map((cookie) => cookie.split(";", 1)[0]);
      const csrfCookie = cookiePairs.find((cookie) => cookie.startsWith("antcode_dashboard_csrf_"));
      assert.ok(cookiePairs.some((cookie) => cookie.startsWith("antcode_dashboard_session_")));
      assert.ok(csrfCookie);
      return {
        cookie: cookiePairs.join("; "),
        csrfToken: csrfCookie.slice(csrfCookie.indexOf("=") + 1)
      };
    });
    dashboardAuthCache.set(server, auth);
  }
  return auth;
}

async function fetchFirstStreamChunk(server, pathName) {
  const { port } = server.address();
  const auth = await dashboardAuth(server);
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: pathName,
      method: "GET",
      headers: { cookie: auth.cookie }
    }, (res) => {
      let text = "";
      res.on("data", (chunk) => {
        text += Buffer.from(chunk).toString("utf8");
        if (settled || !text.includes("\n\n")) {
          return;
        }
        settled = true;
        resolve({
          status: res.statusCode,
          contentType: res.headers["content-type"],
          text
        });
        req.destroy();
      });
    });
    req.on("error", (error) => {
      if (!settled) {
        reject(error);
      }
    });
    req.end();
  });
}

async function openEventStream(server, pathName) {
  const { port } = server.address();
  const auth = await dashboardAuth(server);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: "127.0.0.1",
      port,
      path: pathName,
      method: "GET",
      headers: { cookie: auth.cookie }
    }, (response) => {
      resolve({ request, response });
    });
    request.on("error", reject);
    request.end();
  });
}

async function waitFor(predicate) {
  const started = Date.now();
  while (Date.now() - started < 1000) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
