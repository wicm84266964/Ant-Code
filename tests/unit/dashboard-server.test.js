import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createDashboardServer,
  listenOnAvailablePort,
  normalizeDashboardHost,
  normalizePort
} from "../../src/dashboard/server.js";

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
        calls.push(["delete", body.sessionId]);
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
      method: "DELETE"
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
      ["interrupt", "s1", "user"],
      ["guide", "s1", "focus tests", "q1"],
      ["cancel-queue", "s1", "q2"],
      ["cancel-background", "s1", "g1", "t1"],
      ["delete", "s1"],
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
    assert.deepEqual(calls, [{ sessionId: "s1", options: { afterSequence: 2 } }]);
    assert.match(response.text, /id: 3/);
    assert.match(response.text, /"text":"new"/);
  } finally {
    await close(server);
  }
});

test("dashboard file routes resolve paths through the selected session cwd", async () => {
  const dashboardCwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-root-"));
  const sessionCwd = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-session-"));
  await fs.writeFile(path.join(sessionCwd, "chart.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
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
    const missing = await fetchJson(server, "/api/files?path=chart.png");

    assert.equal(preview.status, 200);
    assert.equal(preview.body.file.kind, "image");
    assert.equal(preview.body.file.rawUrl, "/api/files/raw?path=chart.png&sessionId=session-with-image");
    assert.equal(raw.status, 200);
    assert.equal(raw.contentType, "image/png");
    assert.deepEqual(Array.from(raw.body.subarray(0, 4)), [0x89, 0x50, 0x4e, 0x47]);
    assert.equal(missing.status, 404);
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

function fetchJson(server, pathName, options = {}) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const payload = options.body ? JSON.stringify(options.body) : "";
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: pathName,
      method: options.method ?? "GET",
      headers: {
        "content-type": "application/json",
        ...(payload ? { "content-length": Buffer.byteLength(payload) } : {}),
        "connection": "close"
      }
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: res.statusCode,
          body: JSON.parse(text)
        });
      });
    });
    req.on("error", reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

function fetchBuffer(server, pathName) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: pathName,
      method: "GET"
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        resolve({
          status: res.statusCode,
          contentType: res.headers["content-type"],
          body: Buffer.concat(chunks)
        });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function fetchFirstStreamChunk(server, pathName) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: pathName,
      method: "GET"
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

async function waitFor(predicate) {
  const started = Date.now();
  while (Date.now() - started < 1000) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
