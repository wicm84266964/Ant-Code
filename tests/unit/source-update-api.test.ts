import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createDashboardServer } from "../../src/dashboard/server.ts";
import { UpdateError } from "../../src/update/contracts.ts";

const boot = { productVersion: "8.7.6", bootCommit: "a".repeat(40), instanceId: "boot-one" };
const runtime = { status: async () => ({ ok: true }), shutdown: async () => ({ ok: true }) };

async function fixture(manager?: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const server = createDashboardServer({ cwd: process.cwd(), runtime, boot, sourceUpdateManager: manager, ...extra });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const bootstrap = await fetch(url);
  await bootstrap.text();
  const cookies = bootstrap.headers.getSetCookie().map((cookie) => cookie.split(";", 1)[0]);
  const csrf = cookies.find((cookie) => cookie.startsWith("antcode_dashboard_csrf_"))!.split("=")[1];
  const headers = { cookie: cookies.join("; "), "x-antcode-csrf-token": csrf, "content-type": "application/json" };
  return { server, url, headers, close: async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await server.disposeSourceUpdate();
  } };
}

function managerStub(overrides: Record<string, unknown> = {}) {
  return { snapshot: async () => ({ boot, phase: "idle", limitations: [], strictRestartSupported: false }),
    check: () => ({ accepted: true }), start: () => ({ accepted: true, jobId: "job-one" }), dispose: async () => {}, ...overrides };
}

async function post(f: Awaited<ReturnType<typeof fixture>>, route: string, body: unknown, headers = f.headers) {
  const response = await fetch(`${f.url}/api/source-update/${route}`, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

test("source update GET is an injected local snapshot; status keeps API version and immutable boot", async () => {
  let snapshots = 0;
  let actions = 0;
  const suppliedBoot = { ...boot };
  const f = await fixture(managerStub({
    snapshot: async () => { snapshots++; return { phase: "ready", boot, strictRestartSupported: false }; },
    check: () => { actions++; }, start: () => { actions++; }
  }), { boot: suppliedBoot });
  try {
    suppliedBoot.productVersion = "mutated";
    for (let index = 0; index < 2; index++) {
      const response = await fetch(`${f.url}/api/source-update`, { headers: f.headers });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).phase, "ready");
    }
    const response = await fetch(`${f.url}/api/status`, { headers: f.headers });
    const status = await response.json();
    assert.equal(status.version, "dashboard.v2");
    assert.equal(status.productVersion, boot.productVersion);
    assert.equal(status.bootCommit, boot.bootCommit);
    assert.equal(status.instanceId, boot.instanceId);
    assert.equal(snapshots, 2);
    assert.equal(actions, 0);
  } finally { await f.close(); }
});

test("source update factory defaults unavailable, never initializes a real updater", async () => {
  const f = await fixture();
  try {
    const response = await fetch(`${f.url}/api/source-update`, { headers: f.headers });
    assert.equal((await response.json()).message, "SOURCE_UPDATE_UNAVAILABLE");
    assert.equal((await post(f, "check", { allowDirect: true })).status, 503);
    assert.equal((await post(f, "start", { planId: "x" })).status, 503);
  } finally { await f.close(); }
});

test("check and start return 202 without waiting for background jobs", async () => {
  const calls = [];
  let settled = false;
  let finish!: () => void;
  const background = new Promise<void>((resolve) => { finish = resolve; }).then(() => { settled = true; });
  const f = await fixture(managerStub({
    check: (input) => { calls.push(input); void background; return { accepted: true }; },
    start: (input) => { calls.push(input); return { accepted: true, jobId: "j" }; },
    settled: () => { throw new Error("HTTP must not await this"); }
  }));
  try {
    const checked = await post(f, "check", { proxyUrl: "http://localhost:12345", allowDirect: false });
    assert.equal(checked.status, 202);
    assert.equal(checked.body.accepted, true);
    assert.equal(settled, false);
    const started = await post(f, "start", { planId: "server-owned" });
    assert.equal(started.status, 202);
    assert.equal(started.body.jobId, "j");
    assert.deepEqual(calls, [{ proxyUrl: "http://localhost:12345", allowDirect: false }, { planId: "server-owned" }]);
  } finally { finish(); await background; await f.close(); }
});

// Native HTTP preserves Host verbatim; Node fetch may replace a supplied Host.
async function nativePost(f: Awaited<ReturnType<typeof fixture>>, headers: Record<string, string>) {
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const request = http.request(`${f.url}/api/source-update/check`, { method: "POST", headers }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("error", reject);
      response.on("end", () => {
        try { resolve({ status: response.statusCode!, body: JSON.parse(body) }); } catch (error) { reject(error); }
      });
    });
    request.on("error", reject);
    request.end("{}");
  });
}

for (const security of [
  { name: "missing authentication", headers: () => ({ "content-type": "application/json" }), status: 401, code: "AUTH_REQUIRED" },
  { name: "foreign Origin", headers: (headers) => ({ ...headers, origin: "http://evil.example" }), status: 403, code: "ORIGIN_FORBIDDEN" },
  { name: "invalid CSRF", headers: (headers) => ({ ...headers, "x-antcode-csrf-token": "wrong" }), status: 403, code: "CSRF_INVALID" },
  { name: "non-JSON content type", headers: (headers) => ({ ...headers, "content-type": "text/plain" }), status: 415, code: "UNSUPPORTED_MEDIA_TYPE" }
]) {
  test(`source update security rejects ${security.name} before manager admission`, async () => {
    let calls = 0;
    const f = await fixture(managerStub({ check: () => { calls++; return { accepted: true }; } }));
    try {
      const response = await post(f, "check", {}, security.headers(f.headers));
      assert.equal(response.status, security.status);
      assert.equal(response.body.code, security.code);
      assert.equal(calls, 0);
    } finally { await f.close(); }
  });
}

for (const host of ["evil.example", "127.0.0.1:1"]) {
  test(`source update security rejects native HTTP Host ${host} with valid credentials`, async () => {
    let calls = 0;
    const f = await fixture(managerStub({ check: () => { calls++; return { accepted: true }; } }));
    try {
      const rejected = await nativePost(f, { ...f.headers, host });
      assert.equal(rejected.status, 403);
      assert.equal(rejected.body.code, "HOST_FORBIDDEN");
      assert.equal(calls, 0);
      const allowed = await nativePost(f, { ...f.headers, host: new URL(f.url).host });
      assert.equal(allowed.status, 202);
      assert.equal(calls, 1);
    } finally { await f.close(); }
  });
}

test("source update security rejects malformed JSON before manager admission", async () => {
  let calls = 0;
  const f = await fixture(managerStub({ check: () => { calls++; } }));
  try {
    const response = await fetch(`${f.url}/api/source-update/check`, { method: "POST", headers: f.headers, body: "{" });
    assert.equal(response.status, 400);
    assert.equal(calls, 0);
  } finally { await f.close(); }
});

test("source update snapshot requires authentication", async () => {
  let snapshots = 0;
  const f = await fixture(managerStub({ snapshot: () => { snapshots++; return { boot }; } }));
  try {
    assert.equal((await fetch(`${f.url}/api/source-update`)).status, 401);
    assert.equal(snapshots, 0);
  } finally { await f.close(); }
});

test("source update inputs reject unknown fields and invalid shapes before manager calls", async () => {
  let calls = 0;
  const f = await fixture(managerStub({ check: () => { calls++; }, start: () => { calls++; } }));
  try {
    for (const [route, inputs] of [
      ["check", [null, [], { command: "git fetch" }, { proxyUrl: 1 }, { allowDirect: "true" }, { sourceRoot: "other" }]],
      ["start", [null, [], {}, { planId: "" }, { planId: 1 }, { planId: "x", target: "forged" }]]
    ]) {
      for (const input of inputs) assert.equal((await post(f, route, input)).status, 400);
    }
    assert.equal(calls, 0);
  } finally { await f.close(); }
});

test("update failures expose only safe codes, never raw errors or secrets", async () => {
  const secret = "http://user:private-password@proxy.invalid:8888";
  let failure: Error = new UpdateError("PLAN_STALE", secret);
  const f = await fixture(managerStub({ check: () => { throw failure; }, snapshot: () => { throw failure; } }));
  try {
    const known = await post(f, "check", {});
    assert.equal(known.status, 409);
    assert.equal(known.body.code, "PLAN_STALE");
    assert.doesNotMatch(JSON.stringify(known), /private-password|stack/);
    failure = new Error(secret);
    const unknown = await post(f, "check", {});
    assert.equal(unknown.status, 500);
    assert.equal(unknown.body.code, "SOURCE_UPDATE_FAILED");
    assert.doesNotMatch(JSON.stringify(unknown), /private-password|stack/);
    const snapshot = await fetch(`${f.url}/api/source-update`, { headers: f.headers });
    assert.equal(snapshot.status, 500);
    assert.doesNotMatch(await snapshot.text(), /private-password|stack/);
  } finally { await f.close(); }
});

test("maintenance rejects mutations only after request security and keeps snapshot polling", async () => {
  const f = await fixture(managerStub(), { sourceUpdateMaintenance: () => true });
  try {
    assert.equal((await post(f, "start", { planId: "x" })).body.code, "SOURCE_UPDATE_MAINTENANCE");
    assert.equal((await post(f, "check", {}, {})).body.code, "AUTH_REQUIRED");
    const snapshot = await fetch(`${f.url}/api/source-update`, { headers: f.headers });
    assert.equal(snapshot.status, 200);
  } finally { await f.close(); }
});
