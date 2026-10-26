import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { bindSourceUpdateUI, createSourceUpdateController, sourceUpdateBoot, sourceUpdateCheckBody, sourceUpdateReason, sourceUpdateSucceeded } from "../../src/dashboard/public/source-update.ts";
import type { SourceUpdateDependencies, SourceUpdateViewState } from "../../src/dashboard/public/source-update.ts";
import type { UpdateSnapshot } from "../../src/update/contracts.ts";

const head = "a".repeat(40), target = "b".repeat(40);
const oldBoot = { productVersion: "test-product-version", bootCommit: head, instanceId: "old-instance" };
const newBoot = { productVersion: "next-product-version", bootCommit: target, instanceId: "new-instance" };
function snapshot(overrides: Partial<UpdateSnapshot> = {}): UpdateSnapshot {
  return {
    boot: oldBoot, phase: "ready", strictRestartSupported: true, limitations: [],
    plan: { id: "server-owned-plan", head, target, branch: "feature/update", remote: "origin", mergeRef: "refs/heads/feature/update", createdAt: Date.now(), expiresAt: Date.now() + 60_000 },
    ...overrides
  };
}
function harness(overrides: Partial<SourceUpdateDependencies> = {}) {
  const calls: Array<{ path: string; body?: Record<string, unknown> }> = [];
  const views: SourceUpdateViewState[] = [];
  let reloads = 0, remembers = 0;
  const deps: SourceUpdateDependencies = {
    get: async (path) => { calls.push({ path }); return { ...snapshot() }; },
    post: async (path, body) => { calls.push({ path, body: { ...body } }); return { accepted: true, jobId: "job-1" }; },
    bootstrap: async () => { calls.push({ path: "/" }); },
    unsentReason: () => null,
    rememberSession: () => { remembers += 1; }, reload: () => { reloads += 1; }, sleep: async () => {},
    ...overrides
  };
  const controller = createSourceUpdateController(deps, (view) => views.push(view));
  return { controller, calls, views, deps, latest: () => views.at(-1)!, reloads: () => reloads, remembers: () => remembers };
}

test("boot identity is a startup snapshot, not dashboard API version or hardcoded product version", () => {
  assert.deepEqual(sourceUpdateBoot(oldBoot), oldBoot);
  assert.equal(sourceUpdateBoot({ version: "dashboard.v2" }), null);
  assert.equal(sourceUpdateBoot({ ...oldBoot, bootCommit: "not-a-commit" }), null);
  assert.deepEqual(sourceUpdateBoot({ ...oldBoot, bootCommit: null }), { ...oldBoot, bootCommit: null });
});

test("proxy body defaults to automatic discovery, uses one-shot consent and rejects unsupported/ambiguous routes", () => {
  assert.deepEqual(sourceUpdateCheckBody("", false), {});
  assert.deepEqual(sourceUpdateCheckBody("", true), { allowDirect: true });
  const proxyUrl = "http://user:test-secret@localhost:19283";
  assert.deepEqual(sourceUpdateCheckBody(proxyUrl, false), { proxyUrl });
  for (const value of ["socks5://localhost:19283", "file:///secret", "pac://localhost"]) {
    assert.throws(() => sourceUpdateCheckBody(value, false), { code: "UNSUPPORTED_PROXY" });
  }
  assert.throws(() => sourceUpdateCheckBody(proxyUrl, true), { code: "AMBIGUOUS_ROUTE" });
  assert.throws(() => sourceUpdateCheckBody("http://localhost:19283/private", false), { code: "INVALID_PROXY" });
});

test("check polls a 202 result and never retries failed proxy as direct or leaks credentials/errors", async () => {
  let bodyRef: Record<string, unknown> | undefined;
  const app = harness({
    post: async (_path, body) => { bodyRef = body; return { accepted: true }; },
    get: async () => ({ ...snapshot({ phase: "blocked", message: "GIT_FAILED" }) })
  });
  await app.controller.check("http://user:test-secret@localhost:19283", false);
  assert.deepEqual(bodyRef, {});
  assert.match(app.latest().message, /不会自动改为直连/);
  assert.doesNotMatch(JSON.stringify(app.views), /test-secret/);
  const failed = harness({ post: async () => { throw new Error("C:\\private\\file test-secret stack"); } });
  await failed.controller.check("http://localhost:19283", false);
  assert.doesNotMatch(JSON.stringify(failed.views), /private|test-secret|stack/);
  assert.match(sourceUpdateReason("NO_UPSTREAM"), /上游/);
  assert.match(sourceUpdateReason("DIRTY"), /未提交/);
  assert.match(sourceUpdateReason("UNSUPPORTED_PROXY"), /SOCKS/);
  assert.doesNotMatch(sourceUpdateReason("UNKNOWN_SAFE_CODE C:\\private"), /UNKNOWN|private/);
});

test("confirmation, strict restart, expiry and unsent content block start without mutation", async () => {
  const app = harness();
  await app.controller.open();
  await app.controller.start(false);
  assert.equal(app.calls.filter((call) => call.body).length, 0);
  app.deps.unsentReason = () => "仍有未发送的输入或附件。";
  await app.controller.start(true);
  assert.equal(app.calls.filter((call) => call.body).length, 0);
  assert.match(app.latest().message, /不会保存或丢弃/);
  const unsupported = harness({ get: async () => ({ ...snapshot({ strictRestartSupported: false }) }) });
  await unsupported.controller.open(); await unsupported.controller.start(true);
  assert.match(unsupported.latest().message, /严格同端口/);
  const expired = snapshot(); expired.plan!.expiresAt = 0;
  const stale = harness({ get: async () => ({ ...expired }) });
  await stale.controller.open(); await stale.controller.start(true);
  assert.match(stale.latest().message, /过期/);
});

test("success requires same job succeeded, exact target SHA and a consistent distinct boot instance", () => {
  const expected = { jobId: "job-1", target, oldInstanceId: oldBoot.instanceId };
  const current = snapshot({ boot: newBoot, phase: "succeeded", jobId: "job-1" });
  assert.equal(sourceUpdateSucceeded(expected, current, newBoot), true);
  for (const change of [{ jobId: "other-job" }, { phase: "restarting" as const }, { boot: oldBoot }]) {
    assert.equal(sourceUpdateSucceeded(expected, { ...current, ...change }, newBoot), false);
  }
  for (const status of [{ ...newBoot, instanceId: oldBoot.instanceId }, { ...newBoot, bootCommit: head }, { ...newBoot, instanceId: "stranger" }, { ...newBoot, productVersion: "inconsistent" }, {}]) {
    assert.equal(sourceUpdateSucceeded(expected, current, status), false);
  }
});

test("restart bootstraps cookies before status/snapshot and ignores old/foreign responses before verified reload", async () => {
  const app = harness();
  await app.controller.open();
  app.calls.length = 0;
  let round = 0;
  app.deps.bootstrap = async () => { app.calls.push({ path: "/" }); round += 1; if (round === 1) throw new Error("offline"); };
  app.deps.get = async (path) => {
    app.calls.push({ path });
    if (path === "/api/status") return round < 4 ? oldBoot : newBoot;
    return { ...snapshot({ phase: "succeeded", boot: round < 4 ? oldBoot : newBoot, jobId: round === 3 ? "foreign-job" : "job-1" }) };
  };
  await app.controller.start(true);
  assert.equal(app.reloads(), 1);
  assert.equal(app.latest().verified, true);
  assert.ok(app.remembers() >= 2);
  assert.deepEqual(app.calls[0], { path: "/api/source-update/start", body: { planId: "server-owned-plan" } });
  assert.deepEqual(app.calls.slice(1).map((call) => call.path), ["/", "/", "/api/status", "/api/source-update", "/", "/api/status", "/api/source-update", "/", "/api/status", "/api/source-update"]);
});

test("port recovery alone has bounded polling and recovery guidance, never an automatic second start", async () => {
  const app = harness();
  await app.controller.open();
  let reads = 0;
  app.deps.get = async (path) => { reads += 1; return path === "/api/status" ? oldBoot : { ...snapshot({ phase: "succeeded", jobId: "job-1" }) }; };
  await app.controller.start(true);
  assert.equal(reads, 360);
  assert.equal(app.reloads(), 0);
  assert.equal(app.latest().recovery, true);
  assert.match(app.latest().message, /尚未核验更新成功/);
  assert.equal(app.calls.filter((call) => call.path.endsWith("/start")).length, 1);
});

test("manual recovery and ambiguous start failure fail closed", async () => {
  const app = harness();
  await app.controller.open();
  app.deps.get = async (path) => path === "/api/status" ? oldBoot : { ...snapshot({ phase: "manualRecovery", jobId: "job-1", message: "C:\\secret\\stack" }) };
  await app.controller.start(true);
  assert.equal(app.reloads(), 0); assert.equal(app.latest().recovery, true);
  assert.doesNotMatch(app.latest().message, /secret|stack/);
  const ambiguous = harness({ post: async () => { throw new Error("lost response"); } });
  await ambiguous.controller.open(); await ambiguous.controller.start(true); await ambiguous.controller.start(true);
  assert.equal(ambiguous.latest().recovery, true);
  assert.match(ambiguous.latest().message, /尚未确认任务是否被接受/);
});

test("duplicate submits are suppressed and late unsent content blocks even a verified automatic refresh", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const app = harness({ post: async () => { await gate; return { accepted: true, jobId: "job-1" }; } });
  await app.controller.open();
  let posts = 0;
  const post = app.deps.post;
  app.deps.post = async (...args) => { posts += 1; return post(...args); };
  const running = app.controller.start(true);
  await app.controller.start(true); await app.controller.check("", true);
  assert.equal(posts, 1);
  app.deps.unsentReason = () => "仍有未发送的附件。";
  app.deps.get = async (path) => path === "/api/status" ? newBoot : { ...snapshot({ boot: newBoot, phase: "succeeded", jobId: "job-1" }) };
  release!(); await running;
  assert.equal(app.latest().verified, true); assert.equal(app.reloads(), 0);
  assert.match(app.latest().message, /尚未刷新/);
  app.deps.unsentReason = () => null; app.controller.refresh();
  assert.equal(app.reloads(), 1);
});

class FakeNode {
  value = ""; checked = false; disabled = false; hidden = false; textContent = ""; open = false;
  dataset: Record<string, string> = {};
  handlers = new Map<string, (event: any) => void>();
  private nodes: Map<string, FakeNode>;
  constructor(nodes: Map<string, FakeNode>) { this.nodes = nodes; }
  querySelector(selector: string) { return this.nodes.get(selector); }
  addEventListener(name: string, handler: (event: any) => void) { this.handlers.set(name, handler); }
  showModal() { this.open = true; }
  close() { this.open = false; this.fire("close"); }
  focus() {}
  fire(name: string, event = {}) { this.handlers.get(name)?.(event); }
}

test("dialog masks/clears one-shot proxy, never renders endpoint, and guards cancellation while busy", async () => {
  const html = await fs.readFile("src/dashboard/public/index.html", "utf8");
  const nodes = new Map<string, FakeNode>();
  for (const match of html.matchAll(/id="((?:source-update-[^"]+)|product-version)"/g)) nodes.set(`#${match[1]}`, new FakeNode(nodes));
  const root = { querySelector: (selector: string) => nodes.get(selector) };
  const get = (id: string) => nodes.get(`#source-update-${id}`)!;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const app = harness({
    get: async () => ({ ...snapshot({ phase: "upToDate", route: { mode: "proxy", source: "manual", endpoint: "http://secret:password@host" } }) }),
    post: async () => { await gate; return { accepted: true }; }
  });
  const ui = bindSourceUpdateUI(root as unknown as Document, app.deps);
  ui.setBoot(oldBoot);
  assert.equal(nodes.get("#product-version")!.textContent, "vtest-product-version");
  get("button").fire("click"); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(get("dialog").open, true);
  get("proxy").value = "http://user:password@localhost:19283";
  get("check").fire("click");
  assert.equal(get("proxy").value, ""); assert.equal(get("direct").checked, false);
  assert.equal(get("check").disabled, true);
  let prevented = false;
  get("dialog").fire("cancel", { preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  release!(); await new Promise((resolve) => setImmediate(resolve));
  assert.doesNotMatch(get("route").textContent, /secret|password|@host/);
  get("close").fire("click");
  assert.equal(get("dialog").open, false);
});

test("markup and wiring preserve same-origin helpers, accessibility, privacy and narrow-screen wrapping", async () => {
  const html = await fs.readFile("src/dashboard/public/index.html", "utf8");
  const ui = await fs.readFile("src/dashboard/public/app-ui1.ts", "utf8");
  const module = await fs.readFile("src/dashboard/public/source-update.ts", "utf8");
  const css = await fs.readFile("src/dashboard/public/styles.css", "utf8");
  assert.doesNotMatch(html, /本机工作台/);
  assert.match(html, /<dialog[^>]+aria-labelledby="source-update-title"/);
  assert.match(html, /id="source-update-proxy" type="password" autocomplete="off"/);
  assert.match(html, /id="source-update-direct" type="checkbox" \/>/);
  assert.match(html, /id="source-update-progress" role="status" aria-live="polite"/);
  assert.match(html, /关闭其他 CLI\/TUI/);
  assert.match(ui, /post:.*postJson\(path, body/);
  assert.match(ui, /fetch\("\/", \{ method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error", signal: AbortSignal.timeout\(3000\)/);
  assert.match(ui, /rememberSession: \(\) => rememberCurrentSession\(state.currentSessionId\)/);
  assert.match(ui, /els\.promptInput\.value\.length > 0 \|\| state\.attachments\.length > 0/);
  assert.doesNotMatch(module, /localStorage|sessionStorage|console\.|app-barrel/);
  assert.match(css, /\.source-update-dialog\s*\{[^}]*max-width: calc\(100vw - 32px\);[^}]*overflow: auto;/s);
  assert.match(css, /\.source-update-plan dd\s*\{[^}]*overflow-wrap: anywhere;/s);
});
