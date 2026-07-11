import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import { createDashboardServer } from "../../src/dashboard/server.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const EDGE_PATH = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const require = createRequire(import.meta.url);
const dependencyRoot = path.resolve(process.env.ANT_CODE_BROWSER_DEPENDENCY_ROOT ?? ROOT);
const { chromium } = require(resolveDependency("playwright-core"));
const axeSource = await fs.readFile(resolveDependency("axe-core"), "utf8");

let browser;
let dashboardServer;
let dashboardUrl;
let embedServer;
let embedUrl;
let mediaServer;
let mediaUrl;
let mediaRequests = 0;
let runtime;

before(async () => {
  await fs.access(EDGE_PATH);

  mediaServer = await listen(http.createServer((req, res) => {
    if (req.url?.startsWith("/pixel.png")) {
      mediaRequests += 1;
    }
    res.writeHead(200, {
      "content-type": "image/png",
      "cache-control": "no-store"
    });
    res.end(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
  }));
  mediaUrl = serverUrl(mediaServer);

  runtime = createBrowserRuntime(`${mediaUrl}/pixel.png`);
  dashboardServer = createDashboardServer({
    cwd: ROOT,
    host: "127.0.0.1",
    runtime,
    onShutdown() {}
  });
  await listen(dashboardServer);
  dashboardUrl = serverUrl(dashboardServer);

  embedServer = await listen(http.createServer((req, res) => {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    });
    res.end(`<!doctype html><html><body><iframe id="dashboard-frame" src="${dashboardUrl}/"></iframe></body></html>`);
  }));
  embedUrl = serverUrl(embedServer);

  browser = await chromium.launch({
    executablePath: EDGE_PATH,
    headless: true,
    args: [
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--no-first-run"
    ]
  });
});

after(async () => {
  await browser?.close().catch(() => null);
  await Promise.all([
    closeServer(dashboardServer),
    closeServer(embedServer),
    closeServer(mediaServer)
  ]);
});

test("dashboard has no page overflow and keeps core navigation reachable from 320 to 1440", async () => {
  for (const width of [320, 390, 768, 1024, 1280, 1440]) {
    await withDashboardPage({ width, height: width < 768 ? 844 : 900 }, async (page) => {
      await assertNoPageOverflow(page, `initial ${width}px`);

      if (width < 1200) {
        const navigation = page.locator("#responsive-navigation");
        assert.equal(await navigation.isVisible(), true, `responsive navigation hidden at ${width}px`);
        for (const [view, selector] of [
          ["sessions", "#session-panel"],
          ["conversation", ".workspace"],
          ["files", "#file-panel"]
        ]) {
          const button = navigation.locator(`button[data-dashboard-view='${view}']`);
          assert.equal(await button.isVisible(), true, `${view} navigation hidden at ${width}px`);
          await button.click();
          await page.waitForFunction((expected) => document.body.dataset.dashboardView === expected, view);
          assert.equal(await page.locator(selector).evaluate((node) => node.inert), false);
          assert.equal(await page.locator(selector).isVisible(), true, `${view} surface hidden at ${width}px`);
          await assertNoPageOverflow(page, `${view} ${width}px`);
        }
      } else {
        assert.equal(await page.locator("#responsive-navigation").isVisible(), false);
        for (const selector of ["#session-panel", ".workspace", "#file-panel"]) {
          assert.equal(await page.locator(selector).isVisible(), true, `${selector} hidden at ${width}px`);
          assert.equal(await page.locator(selector).evaluate((node) => node.inert), false);
        }
      }
    });
  }
});

test("mobile navigation exposes exactly one reachable sessions, conversation, or files view", async () => {
  await withDashboardPage({ width: 390, height: 844 }, async (page) => {
    const surfaces = {
      sessions: "#session-panel",
      conversation: ".workspace",
      files: "#file-panel"
    };
    for (const [view, selector] of Object.entries(surfaces)) {
      await page.locator(`#responsive-navigation button[data-dashboard-view='${view}']`).click();
      await page.waitForFunction((expected) => document.body.dataset.dashboardView === expected, view);
      const state = await page.evaluate(({ activeView, activeSelector }) => ({
        active: document.querySelector(activeSelector)?.inert === false,
        inactive: Object.entries({
          sessions: "#session-panel",
          conversation: ".workspace",
          files: "#file-panel"
        }).filter(([name]) => name !== activeView).every(([, item]) => document.querySelector(item)?.inert === true),
        current: document.querySelector(`#responsive-navigation button[data-dashboard-view='${activeView}']`)?.getAttribute("aria-current")
      }), { activeView: view, activeSelector: selector });
      assert.deepEqual(state, { active: true, inactive: true, current: "page" });
    }
  });
});

test("desktop file preview width is adjustable, bounded, and persisted", async () => {
  await withDashboardPage({ width: 1440, height: 900 }, async (page) => {
    const preview = page.locator("#file-panel");
    const workspace = page.locator(".workspace");
    const handle = page.locator("#preview-resize-handle");
    assert.equal(await handle.isVisible(), true);
    assert.equal(await handle.getAttribute("role"), "separator");
    assert.equal(await handle.getAttribute("aria-valuemax"), "600");

    const initialWidth = (await preview.boundingBox()).width;
    assert.ok(Math.abs(initialWidth - 360) <= 1);
    const handleBounds = await handle.boundingBox();
    await page.mouse.move(handleBounds.x + 4, handleBounds.y + 120);
    await page.mouse.down();
    await page.mouse.move(handleBounds.x - 116, handleBounds.y + 120, { steps: 6 });
    await page.mouse.up();
    const draggedWidth = (await preview.boundingBox()).width;
    assert.ok(Math.abs(draggedWidth - 480) <= 2, `unexpected dragged width ${draggedWidth}`);

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelectorAll("#thread-list .thread-item").length === 2);
    assert.ok(Math.abs((await preview.boundingBox()).width - draggedWidth) <= 2);

    await handle.focus();
    await page.keyboard.press("End");
    await page.waitForFunction(() => document.querySelector("#preview-resize-handle")?.getAttribute("aria-valuenow") === "600");
    const maximumWidth = (await preview.boundingBox()).width;
    assert.ok(Math.abs(maximumWidth - 600) <= 1, `expected maximum width 600, got ${maximumWidth}`);
    assert.ok((await workspace.boundingBox()).width >= 520);
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(() => document.querySelector("#preview-resize-handle")?.getAttribute("aria-valuenow") === "584");
    assert.ok(Math.abs((await preview.boundingBox()).width - 584) <= 1);

    await page.setViewportSize({ width: 1024, height: 900 });
    assert.equal(await handle.isVisible(), false);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForFunction(() => document.querySelector("#preview-resize-handle")?.getAttribute("aria-valuenow") === "584");
    assert.ok(Math.abs((await preview.boundingBox()).width - 584) <= 1);

    await handle.dblclick();
    await page.waitForFunction(() => document.querySelector("#preview-resize-handle")?.getAttribute("aria-valuenow") === "360");
    assert.ok(Math.abs((await preview.boundingBox()).width - 360) <= 1);
    await page.locator("#collapse-preview").click();
    assert.equal(await handle.isVisible(), false);
    await assertNoPageOverflow(page, "resized preview");
  });
});

test("session activity uses one quiet status treatment per sidebar mode", async () => {
  Object.assign(runtime.sessions[0], { active: true, running: true, status: "running" });
  try {
    await withDashboardPage({ width: 1280, height: 900 }, async (page) => {
      const runningItem = page.locator(".thread-item[data-tone='running']");
      const badge = runningItem.locator(".thread-status-badge");
      const dot = runningItem.locator(".thread-status-dot");
      await badge.waitFor();
      assert.equal(await badge.textContent(), "运行中");
      assert.equal(await dot.evaluate((node) => getComputedStyle(node).display), "none");
      assert.equal(await badge.evaluate((node) => getComputedStyle(node).animationName), "none");
      assert.equal(await page.locator(".thread-item[data-tone='done'] .thread-status-badge").count(), 0);

      await page.locator("#collapse-sidebar").click();
      assert.notEqual(await dot.evaluate((node) => getComputedStyle(node).display), "none");
      assert.equal(await badge.isVisible(), false);
    });
  } finally {
    Object.assign(runtime.sessions[0], { active: false, running: false, status: "completed" });
  }
});

test("late session A response cannot replace the last selected session B", async () => {
  runtime.readCalls.length = 0;
  await withDashboardPage({ width: 1280, height: 900 }, async (page) => {
    await page.locator(".thread-open", { hasText: "Session A" }).click();
    await waitUntil(() => runtime.readCalls.includes("session-a"));
    await page.locator(".thread-open", { hasText: "Session B" }).click();

    await page.locator(".message.assistant .message-body").filter({ hasText: "SESSION_B_FINAL" }).waitFor();
    await page.waitForTimeout(260);

    assert.deepEqual(runtime.readCalls.slice(0, 2), ["session-a", "session-b"]);
    assert.equal(await page.locator(".message.assistant .message-body", { hasText: "SESSION_A_STALE" }).count(), 0);
    assert.match(await page.locator(".thread-item.active .thread-title").textContent(), /Session B/);
  });
});

test("shutdown dialog traps focus, closes on Escape, and restores its trigger", async () => {
  await withDashboardPage({ width: 1280, height: 900 }, async (page) => {
    const trigger = page.locator("#shutdown-button:visible, #header-shutdown-button:visible").first();
    const triggerId = await trigger.getAttribute("id");
    await trigger.focus();
    await trigger.click();
    await page.locator("#shutdown-confirm:not([disabled])").waitFor();

    assert.equal(await page.locator("#shutdown-panel").getAttribute("aria-modal"), "true");
    assert.equal(await page.locator("#session-panel").evaluate((node) => node.inert), true);
    assert.equal(await page.evaluate(() => document.activeElement?.id), "shutdown-cancel");

    await page.keyboard.press("Shift+Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.id), "shutdown-confirm");
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.id), "shutdown-cancel");

    await page.keyboard.press("Escape");
    await page.locator("#shutdown-panel").waitFor({ state: "hidden" });
    await page.waitForFunction((expected) => document.activeElement?.id === expected, triggerId);
    assert.equal(await page.locator("#session-panel").evaluate((node) => node.inert), false);
  });
});

test("permission radiogroup supports arrow, Home, and End keyboard behavior", async () => {
  await withDashboardPage({ width: 1280, height: 900 }, async (page) => {
    const plan = page.locator("#permission-mode button[data-mode='plan']");
    const workspace = page.locator("#permission-mode button[data-mode='workspace']");
    const fullAccess = page.locator("#permission-mode button[data-mode='fullAccess']");

    await plan.focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(await workspace.getAttribute("aria-checked"), "true");
    assert.equal(await workspace.getAttribute("tabindex"), "0");
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.mode), "workspace");

    await page.keyboard.press("Home");
    assert.equal(await plan.getAttribute("aria-checked"), "true");
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.mode), "plan");

    await page.keyboard.press("End");
    await page.locator("#permission-confirm-panel:not(.hidden)").waitFor();
    await page.waitForFunction(() => document.activeElement?.dataset.action === "cancel");
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.action), "cancel");
    assert.equal(await fullAccess.getAttribute("aria-checked"), "false");
    await page.keyboard.press("Escape");
    await page.locator("#permission-confirm-panel").waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.activeElement?.dataset.mode === "fullAccess");
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.mode), "fullAccess");
  });
});

test("question review preserves the draft while allowing transcript-only inspection", async () => {
  runtime.activeSessionIds.add("session-b");
  try {
    await withDashboardPage({ width: 1280, height: 900 }, async (page) => {
    await page.locator(".thread-open", { hasText: "Session B" }).click();
    await page.waitForFunction(() => globalThis.__dashboardEventSources?.length > 0);
    await page.evaluate(() => {
      const transcript = document.querySelector("#transcript");
      for (let index = 0; index < 80; index += 1) {
        const message = document.createElement("div");
        message.className = "message assistant";
        message.textContent = `用于回看滚动的历史消息 ${index + 1}`;
        transcript.append(message);
      }
      globalThis.__dashboardEventSources.at(-1).emit("dashboard", {
        sequence: 1,
        type: "question_required",
        question: {
          id: "question-review-test",
          header: "确认实现范围",
          question: "请结合上方长对话核对实现边界、验收标准和风险说明，再决定是否继续。",
          allowCustom: true,
          confirmLabel: "确认继续",
          choices: [
            { value: "complete", label: "范围完整", description: "按当前方案继续执行" },
            { value: "adjust", label: "需要调整", description: "补充修改意见后再继续" }
          ]
        }
      });
    });

    const panel = page.locator("#question-panel");
    await panel.locator("button[data-action='review-conversation']").waitFor();
    const bounds = await panel.boundingBox();
    assert.ok(bounds.width >= 780, `question panel is too narrow: ${JSON.stringify(bounds)}`);
    assert.ok(bounds.height >= 560, `question panel is too short: ${JSON.stringify(bounds)}`);
    assert.equal(await page.locator(".transcript-stage").evaluate((node) => node.inert), true);

    await panel.locator(".question-input").fill("先回看前文，再保留这段补充说明");
    await panel.locator("button[data-choice='adjust']").click();
    await panel.locator("button[data-action='review-conversation']").click();

    assert.equal(await panel.evaluate((node) => node.classList.contains("question-reviewing")), true);
    assert.equal(await page.locator(".transcript-stage").evaluate((node) => node.inert), false);
    assert.equal(await page.locator("#session-panel").evaluate((node) => node.inert), true);
    assert.equal(await page.locator(".composer").evaluate((node) => node.inert), true);
    const scrollResult = await page.locator("#transcript").evaluate((node) => {
      node.scrollTop = Math.max(1, Math.floor(node.scrollHeight / 2));
      return { scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight };
    });
    assert.ok(scrollResult.scrollHeight > scrollResult.clientHeight);
    assert.ok(scrollResult.scrollTop > 0);

    await panel.locator("button[data-action='return-to-question']").click();
    assert.equal(await panel.getAttribute("aria-modal"), "true");
    assert.equal(await panel.locator(".question-input").inputValue(), "先回看前文，再保留这段补充说明");
    assert.equal(await panel.locator("button[data-choice='adjust']").getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator(".transcript-stage").evaluate((node) => node.inert), true);

    await panel.locator("button[data-action='review-conversation']").click();
    await page.keyboard.press("Escape");
    assert.equal(await panel.getAttribute("aria-modal"), "true");

    await page.evaluate(() => {
      const source = globalThis.__dashboardEventSources.at(-1);
      source.emit("dashboard", {
        sequence: 2,
        type: "question_resolved",
        answer: "测试完成",
        selectedChoices: ["adjust"]
      });
    });
    await panel.waitFor({ state: "hidden" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => document.body.dataset.dashboardView === "conversation");
    await page.evaluate(() => {
      globalThis.__dashboardEventSources.at(-1).emit("dashboard", {
        sequence: 3,
        type: "question_required",
        question: {
          id: "question-review-mobile-test",
          header: "手机端确认",
          question: "在手机尺寸下核对需求信息，并确认可以回看聊天记录。",
          allowCustom: true,
          choices: [{ value: "ok", label: "确认", description: "移动端布局正确" }]
        }
      });
    });
    await panel.locator("button[data-action='review-conversation']").waitFor();
    const mobileBounds = await panel.boundingBox();
    assert.ok(mobileBounds.x >= 0 && mobileBounds.y >= 0);
    assert.ok(mobileBounds.x + mobileBounds.width <= 390);
    assert.ok(mobileBounds.y + mobileBounds.height <= 844);
    await assertNoPageOverflow(page, "mobile question modal");

    await panel.locator("button[data-action='review-conversation']").click();
    const mobileReviewBounds = await panel.boundingBox();
    assert.ok(mobileReviewBounds.y + mobileReviewBounds.height < 844 - 48, "review bar overlaps mobile navigation");
    assert.equal(await page.locator(".transcript-stage").evaluate((node) => node.inert), false);
    await assertNoPageOverflow(page, "mobile question review");
    }, { fakeEventSource: true });
  } finally {
    runtime.activeSessionIds.delete("session-b");
  }
});

test("dashboard has no serious or critical axe violations", async () => {
  await withDashboardPage({ width: 1280, height: 900 }, async (page) => {
    await page.evaluate(axeSource);
    const results = await page.evaluate(async () => globalThis.axe.run(document, {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]
      },
      resultTypes: ["violations"]
    }));
    const blocking = results.violations.filter((violation) => ["serious", "critical"].includes(violation.impact));
    assert.deepEqual(blocking.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      targets: violation.nodes.map((node) => node.target)
    })), []);
  });
});

test("remote Markdown images never load as Dashboard subresources", async () => {
  mediaRequests = 0;
  await withDashboardPage({ width: 1280, height: 900 }, async (page) => {
    await page.locator(".thread-open", { hasText: "Session B" }).click();
    const remoteMedia = page.locator(".md-remote-media");
    await remoteMedia.waitFor();
    await page.waitForTimeout(120);

    assert.equal(mediaRequests, 0);
    assert.equal(await remoteMedia.locator("img").count(), 0);
    const link = remoteMedia.locator("a");
    assert.equal(await link.getAttribute("href"), `${mediaUrl}/pixel.png`);
    assert.equal(await link.getAttribute("target"), "_blank");

    // Keep the explicit external navigation in this context, then probe the CSP boundary.
    await link.evaluate((node) => node.addEventListener("click", (event) => event.preventDefault(), { once: true }));
    await link.click();
    await page.evaluate((url) => {
      const probe = new Image();
      probe.alt = "remote CSP probe";
      probe.src = url;
      document.body.append(probe);
    }, `${mediaUrl}/pixel.png`);
    await page.waitForTimeout(180);

    assert.equal(mediaRequests, 0);
    assert.equal(await page.locator("img[alt='remote CSP probe']").evaluate((node) => node.complete && node.naturalWidth > 0), false);
  });
});

test("third-party iframe cannot embed the Dashboard", async () => {
  const context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  const page = await context.newPage();
  try {
    const iframeResponse = page.waitForResponse((response) => (
      response.url() === `${dashboardUrl}/` && response.request().resourceType() === "document"
    ));
    await page.goto(embedUrl, { waitUntil: "domcontentloaded" });
    const response = await iframeResponse;
    const headers = await response.allHeaders();

    assert.equal(response.status(), 200);
    assert.equal(headers["x-frame-options"], "DENY");
    assert.match(headers["content-security-policy"], /frame-ancestors 'none'/);
    await page.waitForTimeout(150);
    assert.equal(await page.locator("#dashboard-frame").contentFrame().locator(".brand-name").count(), 0);
  } finally {
    await context.close();
  }
});

function createBrowserRuntime(remoteImageUrl) {
  const sessions = [
    sessionRecord("session-a", "Session A"),
    sessionRecord("session-b", "Session B")
  ];
  return {
    sessions,
    readCalls: [],
    activeSessionIds: new Set(),
    status: async () => ({
      ok: true,
      sessionStatus: {
        model: "test-model",
        context: { usedTokens: 0, totalTokens: 200000, inputTokens: 0 }
      },
      models: [{ id: "test-model", label: "Test model", contextTokens: 200000 }]
    }),
    trustStatus: async () => ({ ok: true, trust: { trusted: true } }),
    trustWorkspace: async () => ({ ok: true, trust: { trusted: true } }),
    listSessionRecords: async () => sessions,
    async readSession(id) {
      this.readCalls.push(id);
      await delay(id === "session-a" ? 180 : 15);
      if (id === "session-a") {
        return sessionResponse(id, "SESSION_A_STALE", this.activeSessionIds.has(id));
      }
      if (id === "session-b") {
        return sessionResponse(id, `SESSION_B_FINAL\n\n![remote pixel](${remoteImageUrl})`, this.activeSessionIds.has(id));
      }
      return { ok: false, status: 404, error: "not found" };
    },
    readTranscriptPage: async () => ({ ok: true, transcript: [], transcriptPage: { cursor: null, hasMore: false, total: 0 } }),
    lifecycleStatus: async () => ({
      ok: true,
      activity: {
        total: 0,
        sessions: 0,
        activeTurns: 0,
        quarantinedTurns: 0,
        queuedTurns: 0,
        backgroundTasks: 0,
        pendingInteractions: 0
      }
    }),
    startTurn: async () => ({ ok: false }),
    interruptTurn: async () => ({ ok: false }),
    cancelQueuedTurn: () => ({ ok: false }),
    cancelBackgroundSubagent: async () => ({ ok: false }),
    cancelBackgroundTerminal: async () => ({ ok: false }),
    guideTurn: async () => ({ ok: false }),
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

function sessionRecord(id, title) {
  return {
    id,
    title,
    status: "completed",
    active: false,
    running: false,
    queueLength: 0,
    model: "test-model",
    modifiedAt: "2026-07-11T00:00:00.000Z"
  };
}

function sessionResponse(id, assistantText, active = false) {
  return {
    ok: true,
    session: {
      id,
      active,
      running: active,
      status: active ? "running" : "completed",
      model: "test-model",
      permission: { mode: "plan" },
      sessionStatus: {
        model: "test-model",
        context: { usedTokens: 100, totalTokens: 200000, inputTokens: 40 }
      },
      files: [],
      transcript: [{ role: "assistant", content: assistantText }],
      transcriptPage: { cursor: null, hasMore: false, total: 1 },
      backgroundSnapshot: { groups: [] }
    }
  };
}

async function withDashboardPage(viewport, callback, options = {}) {
  const context = await browser.newContext({
    viewport,
    locale: "zh-CN",
    reducedMotion: "reduce"
  });
  if (options.fakeEventSource) {
    await context.addInitScript(() => {
      globalThis.__dashboardEventSources = [];
      globalThis.EventSource = class FakeDashboardEventSource {
        constructor() {
          this.listeners = new Map();
          globalThis.__dashboardEventSources.push(this);
        }

        addEventListener(type, listener) {
          const listeners = this.listeners.get(type) ?? [];
          listeners.push(listener);
          this.listeners.set(type, listeners);
        }

        emit(type, payload = {}) {
          const event = type === "dashboard" ? { data: JSON.stringify(payload) } : payload;
          for (const listener of this.listeners.get(type) ?? []) listener(event);
        }

        close() {}
      };
    });
  }
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  try {
    const response = await page.goto(`${dashboardUrl}/`, { waitUntil: "domcontentloaded" });
    assert.equal(response?.status(), 200);
    await page.waitForFunction(() => (
      document.querySelector("#project-path")?.textContent !== "加载中"
      && document.querySelectorAll("#thread-list .thread-item").length === 2
    ));
    await callback(page);
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
}

async function assertNoPageOverflow(page, label) {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth
  }));
  assert.ok(dimensions.scrollWidth <= dimensions.clientWidth + 1, `${label}: document overflow ${JSON.stringify(dimensions)}`);
  assert.ok(dimensions.bodyScrollWidth <= dimensions.clientWidth + 1, `${label}: body overflow ${JSON.stringify(dimensions)}`);
}

function resolveDependency(name) {
  return require.resolve(name, { paths: [dependencyRoot] });
}

function listen(server) {
  if (server.listening) {
    return Promise.resolve(server);
  }
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(server);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
}

async function closeServer(server) {
  if (!server?.listening) return;
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

function serverUrl(server) {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Server is not listening on a TCP port");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function waitUntil(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error("Timed out waiting for browser runtime state");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
