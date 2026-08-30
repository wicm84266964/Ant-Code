import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import { createDashboardServer } from "../../src/dashboard/server.ts";

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
      if (width === 390 || width === 1280) {
        const connection = await page.evaluate(() => {
          const button = document.querySelector("#connection-status");
          const actions = document.querySelector(".header-actions");
          const header = document.querySelector(".workspace-header");
          return {
            label: button?.querySelector(".connection-label")?.textContent ?? "",
            inHeader: Boolean(header?.contains(button)),
            inActions: Boolean(actions?.contains(button)),
            hasLegacy: Boolean(document.querySelector(".workspace-local"))
          };
        });
        assert.equal(connection.hasLegacy, false, `legacy local identity still present at ${width}px`);
        assert.equal(connection.inHeader, true, `connection status missing from header at ${width}px`);
        assert.equal(connection.inActions, false, `connection status still in header actions at ${width}px`);
        assert.match(connection.label, /本地网关/, `connection label missing local gateway copy at ${width}px`);
      }
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

test("mobile settings expose every category without horizontal scrolling", async () => {
  await withDashboardPage({ width: 390, height: 844 }, async (page) => {
    await page.locator("#responsive-navigation button[data-dashboard-view='settings']").click();
    await page.waitForFunction(() => document.body.dataset.dashboardView === "settings");
    const layout = await page.locator("#settings-rail").evaluate((rail) => ({
      clientWidth: rail.clientWidth,
      scrollWidth: rail.scrollWidth,
      buttons: Array.from(rail.querySelectorAll("button")).map((button) => {
        const bounds = button.getBoundingClientRect();
        return { left: bounds.left, right: bounds.right, width: bounds.width };
      })
    }));
    assert.equal(layout.scrollWidth, layout.clientWidth);
    assert.equal(layout.buttons.length, 5);
    assert.equal(layout.buttons.every((button) => button.left >= 0 && button.right <= 390 && button.width >= 44), true);
    await assertNoPageOverflow(page, "mobile settings");
  });
});

test("model controls keep switching compact while settings owns configuration", async () => {
  runtime.reasoningEffortCalls.length = 0;
  runtime.settingsConfigCalls.length = 0;
  await withDashboardPage({ width: 1280, height: 900 }, async (page) => {
    const modelStatus = page.locator("#model-status");
    await modelStatus.waitFor();
    assert.match(await modelStatus.textContent(), /Test source\s*·\s*Test model/);
    assert.deepEqual(await page.locator("#reasoning-effort-select option").allTextContents(), ["默认", "低", "中", "高", "极高"]);
    assert.equal(await page.locator("#reasoning-effort-select option[value='max']").count(), 0);
    const compactControlTypography = await page.evaluate(() => ({
      settings: getComputedStyle(document.querySelector("#settings-button")).fontSize,
      model: getComputedStyle(document.querySelector("#model-status-toggle")).fontSize,
      reasoning: getComputedStyle(document.querySelector(".reasoning-effort-control")).fontSize
    }));
    assert.deepEqual(compactControlTypography, { settings: "12px", model: "12px", reasoning: "12px" });

    await page.locator("#settings-button").click();
    await page.waitForFunction(() => document.body.classList.contains("settings-open"));
    assert.equal(await page.locator("#settings-view").isVisible(), true);
    assert.equal(await page.locator(".transcript-stage").isVisible(), false);
    assert.equal(await page.locator("#settings-add-source").isVisible(), true);
    assert.equal(await page.locator("#settings-add-model").isVisible(), true);
    assert.equal(await page.locator("[data-action='edit-model']").count(), 1);
    assert.equal(await page.locator("#settings-rail button[data-settings-section]").count(), 5);
    const backControl = await page.locator("#settings-back").evaluate((button) => {
      const icon = button.querySelector(".settings-back-icon");
      const buttonBounds = button.getBoundingClientRect();
      const iconBounds = icon?.getBoundingClientRect();
      return {
        buttonSize: [buttonBounds.width, buttonBounds.height],
        iconSize: [iconBounds?.width ?? 0, iconBounds?.height ?? 0],
        iconStrokeWidth: icon ? getComputedStyle(icon).strokeWidth : ""
      };
    });
    assert.deepEqual(backControl, {
      buttonSize: [34, 34],
      iconSize: [18, 18],
      iconStrokeWidth: "2.25px"
    });
    await page.locator("#settings-rail button[data-settings-section='transcript']").click();
    const compactSettings = await page.locator("form[data-settings-form='transcript']").evaluate((form) => {
      const select = form.querySelector("select[name='encryption']");
      const option = select?.querySelector("option");
      const content = document.querySelector("#settings-content");
      return {
        contentWidth: content?.getBoundingClientRect().width ?? 0,
        formWidth: form.getBoundingClientRect().width,
        selectColorScheme: select ? getComputedStyle(select).colorScheme : "",
        optionBackground: option ? getComputedStyle(option).backgroundColor : ""
      };
    });
    assert.ok(compactSettings.contentWidth <= 760, `settings content too wide: ${compactSettings.contentWidth}px`);
    assert.ok(compactSettings.formWidth <= 680, `settings form too wide: ${compactSettings.formWidth}px`);
    assert.equal(compactSettings.selectColorScheme, "dark");
    assert.notEqual(compactSettings.optionBackground, "rgb(255, 255, 255)");
    for (const section of ["transcript", "network", "agents", "reliability", "models"]) {
      await page.locator(`#settings-rail button[data-settings-section='${section}']`).click();
      await page.waitForFunction((active) => document.querySelector("#settings-rail button.active")?.dataset.settingsSection === active, section);
      assert.equal(await page.locator(`#settings-rail button[data-settings-section='${section}']`).getAttribute("aria-current"), "page");
    }
    await page.locator("#settings-rail button[data-settings-section='agents']").click();
    await page.locator("input[name='maxParallelReadonlyAgentRuns']").fill("4");
    await page.locator("form[data-settings-form='agents'] button[type='submit']").click();
    await waitUntil(() => runtime.settingsConfigCalls.length === 1);
    assert.deepEqual(runtime.settingsConfigCalls[0], {
      section: "agents",
      saveTarget: "project",
      sessionId: null,
      settings: {
        maxParallelReadonlyAgentRuns: 4,
        backgroundWakeupEnabled: true,
        backgroundByDefault: false,
        reviewGateEnabled: true,
        syncModelTiersOnSwitch: true,
        goalMaxAutoContinues: 12
      },
      changedFields: ["maxParallelReadonlyAgentRuns"]
    });
    await page.locator("#settings-rail button[data-settings-section='models']").click();
    await assertNoPageOverflow(page, "desktop settings");

    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.body.classList.contains("settings-open"));
    assert.equal(await page.locator("#settings-view").isVisible(), false);
    await page.waitForFunction(() => document.activeElement?.id === "settings-button");

    await page.locator("#model-status-toggle").click();
    const modelPanel = page.locator("#model-panel");
    assert.equal(await modelPanel.isVisible(), true);
    assert.equal(await modelPanel.locator("select[data-action='switch-source']").count(), 1);
    assert.equal(await modelPanel.locator("select[data-action='switch-model']").count(), 1);
    assert.equal(await modelPanel.locator("[data-action='add-model'], [data-action='edit-model'], [data-action='delete-model']").count(), 0);
    assert.deepEqual(
      await modelPanel.locator(".model-switch-fields select").evaluateAll((selects) => selects.map((select) => getComputedStyle(select).fontSize)),
      ["13px", "13px"]
    );

    await page.keyboard.press("Escape");
    await page.locator("#reasoning-effort-select").selectOption("xhigh");
    await waitUntil(() => runtime.reasoningEffortCalls.length === 1);
    assert.equal(runtime.reasoningEffortCalls[0].reasoningEffort, "xhigh");
    assert.equal(runtime.reasoningEffortCalls[0].providerId, "test-source");
    assert.equal(runtime.reasoningEffortCalls[0].modelId, "test-model");
    assert.equal(runtime.reasoningEffortCalls[0].sessionId, null);
    assert.match(runtime.reasoningEffortCalls[0].clientId, /^dashboard-/);
    await page.waitForFunction(() => document.querySelector("#reasoning-effort-select")?.value === "xhigh");
    assert.equal(await page.locator("#reasoning-effort-select").inputValue(), "xhigh");
  });

  await withDashboardPage({ width: 390, height: 844 }, async (page) => {
    await page.locator("#responsive-navigation button[data-dashboard-view='settings']").click();
    await page.waitForFunction(() => document.body.dataset.dashboardView === "settings");
    assert.equal(await page.locator("#settings-view").isVisible(), true);
    assert.equal(await page.locator("#settings-rail").isVisible(), true);
    await page.locator("#settings-rail button[data-settings-section='network']").click();
    assert.equal(await page.locator("form[data-settings-form='network']").isVisible(), true);
    const settingsTargetHeights = await page.locator("#settings-back, #settings-rail button").evaluateAll((nodes) => (
      nodes.map((node) => node.getBoundingClientRect().height)
    ));
    assert.ok(settingsTargetHeights.every((height) => height >= 44), `mobile settings targets too short: ${settingsTargetHeights.join(", ")}`);
    await assertNoPageOverflow(page, "mobile settings");
    await page.locator("#settings-back").click();
    await page.waitForFunction(() => document.body.dataset.dashboardView === "conversation");
    assert.equal(await page.locator(".transcript-stage").isVisible(), true);
  });
});

test("reasoning controls render only the configured disabled effort alias", async () => {
  const originalStatus = runtime.status;
  const model = {
    ...browserModel(),
    reasoningEfforts: [
      { id: "none", label: "Off" },
      { id: "off", label: "Off" },
      { id: "high", label: "High" }
    ],
    defaultReasoningEffort: "off"
  };
  runtime.status = async () => {
    const status = await originalStatus();
    return {
      ...status,
      sessionStatus: { ...status.sessionStatus, model: model.id, reasoningEffort: null },
      models: [model],
      gatewayProfiles: status.gatewayProfiles.map((profile) => profile.id === "test-source"
        ? { ...profile, models: [model] }
        : profile)
    };
  };

  try {
    await withDashboardPage({ width: 1280, height: 900 }, async (page) => {
      assert.deepEqual(
        await page.locator("#reasoning-effort-select option").evaluateAll((options) => options.map((option) => ({
          value: option.value,
          label: option.textContent
        }))),
        [
          { value: "", label: "默认" },
          { value: "none", label: "关闭" },
          { value: "high", label: "高" }
        ]
      );

      await page.locator("#settings-button").click();
      await page.waitForFunction(() => document.querySelector("#settings-content")?.getAttribute("aria-busy") !== "true");
      await page.locator(".settings-model-row", { hasText: "Test model" })
        .locator("button[data-action='edit-model']").click();
      const form = page.locator("#model-config-form");
      assert.equal(await form.locator("input[name='reasoningEfforts'][value='none']").count(), 1);
      assert.equal(await form.locator("input[name='reasoningEfforts'][value='off']").count(), 0);
      assert.equal(await form.locator("select[name='defaultReasoningEffort']").inputValue(), "none");
    });
  } finally {
    runtime.status = originalStatus;
  }
});

test("settings separates new sources from adding a model to the inspected source", async () => {
  runtime.modelConfigCalls.length = 0;
  runtime.modelConfigResponses.length = 0;
  runtime.modelConfigResponses.push({
    result: { ok: false, status: 422, error: "stop after payload capture" }
  });
  try {
    await withDashboardPage({ width: 1280, height: 900 }, async (page) => {
      await page.locator("#settings-button").click();
      await page.waitForFunction(() => document.querySelector("#settings-content")?.getAttribute("aria-busy") !== "true");

      await page.locator("#settings-add-model").click();
      const modelForm = page.locator("#model-config-form");
      await modelForm.waitFor();
      assert.equal(await modelForm.locator("#model-config-title").textContent(), "添加模型");
      const modelFormTypography = await modelForm.evaluate((form) => {
        const protocol = form.querySelector("select[name='gatewayProtocol']");
        const agentModel = form.querySelector("select[data-agent-model-select]");
        const reasoningLabel = form.querySelector(".model-reasoning-options label");
        const reasoningDefault = form.querySelector("select[name='defaultReasoningEffort']");
        return {
          protocol: protocol ? getComputedStyle(protocol).fontSize : "",
          agentModel: agentModel ? getComputedStyle(agentModel).fontSize : "",
          reasoningLabel: reasoningLabel ? getComputedStyle(reasoningLabel).fontSize : "",
          reasoningDefault: reasoningDefault ? getComputedStyle(reasoningDefault).fontSize : "",
          protocolColorScheme: protocol ? getComputedStyle(protocol).colorScheme : "",
          protocolBackground: protocol ? getComputedStyle(protocol).backgroundColor : ""
        };
      });
      assert.deepEqual(modelFormTypography, {
        protocol: "13px",
        agentModel: "13px",
        reasoningLabel: "13px",
        reasoningDefault: "13px",
        protocolColorScheme: "dark",
        protocolBackground: "rgba(255, 255, 255, 0.055)"
      });
      assert.equal(await modelForm.locator("input[name='gatewayUrl']").inputValue(), "https://models.test/v1/responses");
      assert.equal(await modelForm.locator("input[name='modelId']").inputValue(), "");
      await modelForm.locator("input[name='modelId']").fill("test-model-2");
      await modelForm.locator("input[name='label']").fill("Test model 2");
      await modelForm.locator("button[type='submit']").click();
      await waitUntil(() => runtime.modelConfigCalls.length === 1);
      await modelForm.locator(".model-config-feedback").waitFor({ state: "visible" });
      assert.equal(runtime.modelConfigCalls[0].providerId, "test-source");
      assert.equal(runtime.modelConfigCalls[0].profileId, "test-source");
      assert.equal(runtime.modelConfigCalls[0].previousModelId, "");
      assert.equal(runtime.modelConfigCalls[0].modelId, "test-model-2");
      assert.equal(runtime.modelConfigCalls[0].credentialAction, "keep");

      await modelForm.locator("button[data-action='close-model-config']").first().click();
      await page.locator("#settings-add-source").click();
      const sourceForm = page.locator("#model-config-form");
      await sourceForm.waitFor();
      assert.equal(await sourceForm.locator("#model-config-title").textContent(), "添加模型来源");
      assert.equal(await sourceForm.locator("input[name='gatewayUrl']").inputValue(), "");
      assert.equal(await sourceForm.locator("input[name='modelId']").inputValue(), "");
      assert.equal(await sourceForm.locator("input[name='agentCheapModel']").inputValue(), "");
      assert.equal(await sourceForm.locator("input[name='visionAgentModel']").inputValue(), "");
    });
  } finally {
    runtime.modelConfigResponses.length = 0;
  }
});

test("successful model saves refresh settings and the new-task model snapshot immediately", async () => {
  const originalStatus = runtime.status;
  runtime.modelConfigCalls.length = 0;
  runtime.modelConfigResponses.length = 0;
  const previousModel = { ...browserModel(), current: false };
  const savedModel = {
    ...browserModel(),
    id: "test-model-2",
    label: "Test model 2",
    current: true
  };
  const savedResponse = {
    ...browserModelRuntimeResponse({ reasoningEffort: "high", model: savedModel }),
    modelId: savedModel.id,
    models: [previousModel, savedModel],
    gatewayProfiles: [{
      id: "test-source",
      label: "Test source",
      gatewayUrl: "https://models.test/v1/responses",
      gatewayProtocol: "openai-responses",
      apiKeyConfigured: true,
      modelAlias: savedModel.id,
      modelCount: 2,
      saveTarget: "project",
      current: true,
      models: [previousModel, savedModel]
    }]
  };
  runtime.modelConfigResponses.push({ result: savedResponse });

  try {
    await withDashboardPage({ width: 1280, height: 900 }, async (page) => {
      await page.locator("#settings-button").click();
      await page.waitForFunction(() => document.querySelector("#settings-content")?.getAttribute("aria-busy") !== "true");
      await page.locator("#settings-add-model").click();
      const form = page.locator("#model-config-form");
      await form.locator("input[name='modelId']").fill(savedModel.id);
      await form.locator("input[name='label']").fill(savedModel.label);
      await form.locator("button[type='submit']").click();
      await waitUntil(() => runtime.modelConfigCalls.length === 1);
      await form.waitFor({ state: "detached" });

      const savedRow = page.locator(".settings-model-row", { hasText: savedModel.label });
      await savedRow.waitFor({ state: "visible" });
      assert.match(await savedRow.textContent(), /test-model-2/);

      runtime.status = async () => {
        await delay(250);
        return {
          ...savedResponse,
          configV2: {
            enabled: true,
            paths: { global: "C:\\settings\\global.json", project: "C:\\project\\.lab-agent\\settings.json" },
            revisions: { global: "global-r1", project: "project-r2", credentials: "credentials-r1" }
          },
          settings: browserSettings()
        };
      };
      await page.locator("#settings-back").click();
      await page.locator("#new-task").click();
      assert.match(await page.locator("#model-status-toggle").textContent(), /Test model 2/);
    });
  } finally {
    runtime.status = originalStatus;
    runtime.modelConfigCalls.length = 0;
    runtime.modelConfigResponses.length = 0;
  }
});

test("gateway discovery offers exact agent model ids and passes only its opaque proof in the save payload", async () => {
  runtime.gatewayProbeCalls.length = 0;
  runtime.gatewayProbeResponses.length = 0;
  runtime.gatewayProbeSettledCalls.length = 0;
  runtime.modelConfigCalls.length = 0;
  runtime.modelConfigResponses.length = 0;
  runtime.gatewayProbeResponses.push({
    result: {
      ok: true,
      message: "discovered models",
      discoveryToken: "discovery-proof-exact",
      models: [{
        id: "grok-4.6",
        displayName: "Grok 4.6",
        contextWindow: 131072,
        inputModalities: ["text", "image"],
        reasoning: {
          efforts: ["low", "medium", "high", "xhigh"],
          default: "high"
        }
      }, {
        id: "gpt-5.6-luna",
        displayName: "GPT-5.6 Luna"
      }, {
        id: "deepseek-v4-pro",
        displayName: "DeepSeek V4 Pro"
      }, {
        id: "claude-opus-4-1",
        displayName: "Claude Opus 4.1"
      }, {
        id: "gemini-2.5-pro-vision",
        displayName: "Gemini 2.5 Pro Vision",
        inputModalities: ["text", "image"]
      }]
    }
  });
  runtime.modelConfigResponses.push({
    result: { ok: false, status: 422, error: "stop after payload capture" }
  });
  try {
    await withDashboardPage({ width: 1280, height: 900 }, async (page) => {
      await page.locator("#settings-button").click();
      await page.locator("#settings-add-model").click();
      const form = page.locator("#model-config-form");
      await form.locator("input[name='modelId']").fill("grok-4.6");
      await form.locator("button[data-action='probe-gateway']").click();
      await waitUntil(() => runtime.gatewayProbeCalls.length === 1);

      const cheapSelect = form.locator("select[data-agent-model-select='agentCheapModel']");
      const defaultSelect = form.locator("select[data-agent-model-select='agentDefaultModel']");
      const strongSelect = form.locator("select[data-agent-model-select='agentStrongModel']");
      const visionSelect = form.locator("select[data-agent-model-select='visionAgentModel']");
      const lunaOption = cheapSelect.locator("option[value='gpt-5.6-luna']");
      await lunaOption.waitFor({ state: "attached" });
      assert.equal(await lunaOption.count(), 1);
      assert.match(await lunaOption.textContent(), /^gpt-5\.6-luna\s*·\s*GPT-5\.6 Luna$/);
      assert.equal(await defaultSelect.locator("option[value='deepseek-v4-pro']").count(), 1);
      assert.equal(await strongSelect.locator("option[value='claude-opus-4-1']").count(), 1);
      assert.equal(await visionSelect.locator("option[value='gemini-2.5-pro-vision']").count(), 1);

      assert.equal(await form.locator("input[name='modelId']").inputValue(), "grok-4.6");
      assert.equal(await form.locator("input[name='contextTokens']").inputValue(), "131072");
      assert.equal(await form.locator("input[name='vision']").isChecked(), true);
      assert.equal(await form.locator("input[name='reasoningEfforts'][value='xhigh']").isChecked(), true);
      assert.equal(await form.locator("select[name='defaultReasoningEffort']").inputValue(), "high");

      await cheapSelect.selectOption("gpt-5.6-luna");
      await defaultSelect.selectOption("deepseek-v4-pro");
      await strongSelect.selectOption("claude-opus-4-1");
      await visionSelect.selectOption("gemini-2.5-pro-vision");
      assert.equal(await form.locator("input[name='agentCheapModel']").inputValue(), "gpt-5.6-luna");
      assert.equal(await form.locator("input[name='agentDefaultModel']").inputValue(), "deepseek-v4-pro");
      assert.equal(await form.locator("input[name='agentStrongModel']").inputValue(), "claude-opus-4-1");
      assert.equal(await form.locator("input[name='visionAgentModel']").inputValue(), "gemini-2.5-pro-vision");
      await form.locator("button[type='submit']").click();
      await waitUntil(() => runtime.modelConfigCalls.length === 1);
      await form.locator(".model-config-feedback").waitFor({ state: "visible" });
      assert.equal(runtime.modelConfigCalls[0].modelId, "grok-4.6");
      assert.equal(runtime.modelConfigCalls[0].agentCheapModel, "gpt-5.6-luna");
      assert.equal(runtime.modelConfigCalls[0].agentDefaultModel, "deepseek-v4-pro");
      assert.equal(runtime.modelConfigCalls[0].agentStrongModel, "claude-opus-4-1");
      assert.equal(runtime.modelConfigCalls[0].visionAgentModel, "gemini-2.5-pro-vision");
      assert.equal(runtime.modelConfigCalls[0].gatewayDiscoveryToken, "discovery-proof-exact");
      assert.deepEqual(runtime.modelConfigCalls[0].manualAgentModelIds, []);
      assert.equal(Object.prototype.hasOwnProperty.call(runtime.modelConfigCalls[0], "catalogModelIds"), false);
      assert.equal(Object.prototype.hasOwnProperty.call(runtime.modelConfigCalls[0], "catalogModels"), false);
      assert.deepEqual(runtime.modelConfigCalls[0].reasoningEfforts, ["low", "medium", "high", "xhigh"]);
    });
  } finally {
    runtime.gatewayProbeCalls.length = 0;
    runtime.gatewayProbeResponses.length = 0;
    runtime.gatewayProbeSettledCalls.length = 0;
    runtime.modelConfigCalls.length = 0;
    runtime.modelConfigResponses.length = 0;
  }
});

test("agent model pickers retain catalog-missing saved ids and keep manual input available", async () => {
  const originalStatus = runtime.status;
  runtime.gatewayProbeCalls.length = 0;
  runtime.gatewayProbeResponses.length = 0;
  runtime.gatewayProbeSettledCalls.length = 0;
  runtime.modelConfigCalls.length = 0;
  runtime.modelConfigResponses.length = 0;
  runtime.status = async () => {
    const status = await originalStatus();
    status.gatewayProfiles[0] = {
      ...status.gatewayProfiles[0],
      agentModelTiers: { cheap: "legacy-cheap-exact" },
      visionAgent: { enabled: true, model: "legacy-vision-exact", autoUseWhenMainModelTextOnly: true }
    };
    return status;
  };
  runtime.gatewayProbeResponses.push({
    result: {
      ok: true,
      message: "current catalog",
      discoveryToken: "discovery-proof-manual",
      models: [
        { id: "catalog-main-exact", displayName: "Catalog Main" },
        { id: "catalog-worker-exact", displayName: "Catalog Worker" }
      ]
    }
  }, {
    result: { ok: false, status: 502, error: "temporary catalog failure" }
  });
  runtime.modelConfigResponses.push({
    result: { ok: false, status: 422, error: "stop after payload capture" }
  });

  try {
    await withDashboardPage({ width: 1280, height: 900 }, async (page) => {
      await page.locator("#settings-button").click();
      await page.waitForFunction(() => document.querySelector("#settings-content")?.getAttribute("aria-busy") !== "true");
      await page.locator("#settings-add-model").click();
      const form = page.locator("#model-config-form");
      await form.locator("input[name='modelId']").fill("catalog-main-exact");
      await form.locator("button[data-action='probe-gateway']").click();
      await waitUntil(() => runtime.gatewayProbeSettledCalls.length === 1);
      await form.locator("select[data-agent-model-select] option[value='catalog-worker-exact']").first().waitFor({ state: "attached" });

      const cheapPicker = form.locator("[data-agent-model-picker]:has(select[data-agent-model-select='agentCheapModel'])");
      const cheapSelect = form.locator("select[data-agent-model-select='agentCheapModel']");
      const visionPicker = form.locator("[data-agent-model-picker]:has(select[data-agent-model-select='visionAgentModel'])");
      const visionSelect = form.locator("select[data-agent-model-select='visionAgentModel']");
      assert.equal(await cheapSelect.inputValue(), "legacy-cheap-exact");
      assert.match(await cheapSelect.locator("option[value='legacy-cheap-exact']").textContent(), /已保存\s*·\s*目录未发现/);
      assert.match(await cheapPicker.locator(".agent-model-picker-status").textContent(), /已保存，但当前目录未发现/);
      assert.equal(await form.locator("input[name='agentCheapModel']").inputValue(), "legacy-cheap-exact");
      assert.equal(await visionSelect.inputValue(), "legacy-vision-exact");
      assert.match(await visionSelect.locator("option[value='legacy-vision-exact']").textContent(), /已保存\s*·\s*目录未发现/);
      assert.match(await visionPicker.locator(".agent-model-picker-status").textContent(), /已保存，但当前目录未发现/);

      const defaultSelect = form.locator("select[data-agent-model-select='agentDefaultModel']");
      await defaultSelect.selectOption("__manual_agent_model_id__");
      const manualDefault = form.locator("input[name='agentDefaultModel']");
      await manualDefault.waitFor({ state: "visible" });
      await manualDefault.fill("manual/default-exact");
      await form.locator("select[data-agent-model-select='agentStrongModel']").selectOption("catalog-worker-exact");

      await form.locator("button[type='submit']").click();
      await waitUntil(() => runtime.modelConfigCalls.length === 1);
      await form.locator(".model-config-feedback").waitFor({ state: "visible" });
      assert.equal(runtime.modelConfigCalls[0].agentCheapModel, "legacy-cheap-exact");
      assert.equal(runtime.modelConfigCalls[0].agentDefaultModel, "manual/default-exact");
      assert.equal(runtime.modelConfigCalls[0].agentStrongModel, "catalog-worker-exact");
      assert.equal(runtime.modelConfigCalls[0].visionAgentModel, "legacy-vision-exact");
      assert.equal(runtime.modelConfigCalls[0].gatewayDiscoveryToken, "discovery-proof-manual");
      assert.deepEqual(runtime.modelConfigCalls[0].manualAgentModelIds, ["manual/default-exact"]);
      assert.equal(Object.prototype.hasOwnProperty.call(runtime.modelConfigCalls[0], "catalogModelIds"), false);
      assert.equal(Object.prototype.hasOwnProperty.call(runtime.modelConfigCalls[0], "catalogModels"), false);

      await form.locator("button[data-action='probe-gateway']").click();
      await waitUntil(() => runtime.gatewayProbeSettledCalls.length === 2);
      await form.locator("#gateway-probe-result.error").waitFor({ state: "visible" });
      assert.equal(await form.locator("input[name='agentCheapModel']").inputValue(), "legacy-cheap-exact");
      assert.equal(await form.locator("input[name='agentDefaultModel']").inputValue(), "manual/default-exact");
      assert.equal(await form.locator("input[name='agentStrongModel']").inputValue(), "catalog-worker-exact");
      assert.equal(await form.locator("input[name='visionAgentModel']").inputValue(), "legacy-vision-exact");
    });
  } finally {
    runtime.status = originalStatus;
    runtime.gatewayProbeCalls.length = 0;
    runtime.gatewayProbeResponses.length = 0;
    runtime.gatewayProbeSettledCalls.length = 0;
    runtime.modelConfigCalls.length = 0;
    runtime.modelConfigResponses.length = 0;
  }
});

test("changed endpoints cannot submit a stale discovered model catalog", async () => {
  const originalStatus = runtime.status;
  runtime.gatewayProbeCalls.length = 0;
  runtime.gatewayProbeResponses.length = 0;
  runtime.gatewayProbeSettledCalls.length = 0;
  runtime.modelConfigCalls.length = 0;
  runtime.modelConfigResponses.length = 0;
  runtime.gatewayProbeResponses.push({
    delayMs: 160,
    result: {
      ok: true,
      models: [{ id: "stale-catalog-model", displayName: "Stale Catalog Model" }]
    }
  });
  runtime.modelConfigResponses.push({
    result: { ok: false, status: 422, error: "stop after payload capture" }
  });
  runtime.status = async () => {
    const status = await originalStatus();
    return {
      ...status,
      agentModelTiers: {
        cheap: "old-cheap-model",
        default: "old-default-model",
        strong: "old-strong-model"
      },
      gatewayProfiles: status.gatewayProfiles.map((profile) => profile.id === "test-source" ? {
        ...profile,
        agentModelTiers: {
          cheap: "old-cheap-model",
          default: "old-default-model",
          strong: "old-strong-model"
        },
        visionAgent: {
          enabled: true,
          model: "old-vision-model",
          autoUseWhenMainModelTextOnly: true
        }
      } : profile)
    };
  };

  try {
    await withDashboardPage({ width: 1280, height: 900 }, async (page) => {
      await page.locator("#settings-button").click();
      await page.locator("#settings-add-model").click();
      const form = page.locator("#model-config-form");
      await form.locator("input[name='modelId']").fill("draft-main-model");
      assert.equal(await form.locator("input[name='agentCheapModel']").inputValue(), "old-cheap-model");
      assert.equal(await form.locator("input[name='agentDefaultModel']").inputValue(), "old-default-model");
      assert.equal(await form.locator("input[name='agentStrongModel']").inputValue(), "old-strong-model");
      assert.equal(await form.locator("input[name='visionAgentModel']").inputValue(), "old-vision-model");
      await form.locator("button[data-action='probe-gateway']").click();
      await waitUntil(() => runtime.gatewayProbeCalls.length === 1);
      await form.locator("input[name='gatewayUrl']").fill("https://new-endpoint.test/v1/responses");
      await waitUntil(() => runtime.gatewayProbeSettledCalls.length === 1);

      assert.equal(await form.locator("select[data-agent-model-select] option[value='stale-catalog-model']").count(), 0);
      assert.equal(await form.locator("select[data-agent-model-select] option[value^='old-']").count(), 0);
      assert.deepEqual(await form.locator("input[name='agentCheapModel'], input[name='agentDefaultModel'], input[name='agentStrongModel'], input[name='visionAgentModel']").evaluateAll((inputs) => inputs.map((input) => input.value)), ["", "", "", ""]);
      assert.equal(await form.locator("input[name='gatewayApiKey']").getAttribute("placeholder"), "地址或协议已变化，请重新输入 Key");

      await form.locator("input[name='gatewayUrl']").fill("https://models.test/v1/responses");
      assert.deepEqual(await form.locator("input[name='agentCheapModel'], input[name='agentDefaultModel'], input[name='agentStrongModel'], input[name='visionAgentModel']").evaluateAll((inputs) => inputs.map((input) => input.value)), [
        "old-cheap-model",
        "old-default-model",
        "old-strong-model",
        "old-vision-model"
      ]);
      assert.match(await form.locator("input[name='gatewayApiKey']").getAttribute("placeholder"), /留空则保留/);
      await form.locator("input[name='gatewayUrl']").fill("https://new-endpoint.test/v1/responses");
      const cheapSelect = form.locator("select[data-agent-model-select='agentCheapModel']");
      await cheapSelect.selectOption("__manual_agent_model_id__");
      await form.locator("input[name='agentCheapModel']").fill("manual-new-endpoint-worker");
      await form.locator("button[type='submit']").click();
      await waitUntil(() => runtime.modelConfigCalls.length === 1);
      await form.locator(".model-config-feedback").waitFor({ state: "visible" });
      assert.equal(runtime.modelConfigCalls[0].gatewayDiscoveryToken, "");
      assert.deepEqual(runtime.modelConfigCalls[0].manualAgentModelIds, ["manual-new-endpoint-worker"]);
      assert.equal(Object.prototype.hasOwnProperty.call(runtime.modelConfigCalls[0], "catalogModelIds"), false);
      assert.equal(Object.prototype.hasOwnProperty.call(runtime.modelConfigCalls[0], "catalogModels"), false);
      assert.equal(runtime.modelConfigCalls[0].gatewayUrl, "https://new-endpoint.test/v1/responses");
      assert.equal(runtime.modelConfigCalls[0].credentialAction, "clear");
      assert.equal(runtime.modelConfigCalls[0].agentCheapModel, "manual-new-endpoint-worker");
      assert.equal(runtime.modelConfigCalls[0].agentDefaultModel, "");
      assert.equal(runtime.modelConfigCalls[0].agentStrongModel, "");
      assert.equal(runtime.modelConfigCalls[0].visionAgentModel, "");
    });
  } finally {
    runtime.status = originalStatus;
    runtime.gatewayProbeCalls.length = 0;
    runtime.gatewayProbeResponses.length = 0;
    runtime.gatewayProbeSettledCalls.length = 0;
    runtime.modelConfigCalls.length = 0;
    runtime.modelConfigResponses.length = 0;
  }
});

test("agent model selections follow endpoint changes while key rotation preserves them", async () => {
  const originalStatus = runtime.status;
  runtime.gatewayProbeCalls.length = 0;
  runtime.gatewayProbeResponses.length = 0;
  runtime.gatewayProbeSettledCalls.length = 0;
  const discoveredModels = [
    { id: "snapshot-cheap", displayName: "Snapshot Cheap" },
    { id: "snapshot-default", displayName: "Snapshot Default" },
    { id: "snapshot-strong", displayName: "Snapshot Strong" },
    { id: "snapshot-vision", displayName: "Snapshot Vision", inputModalities: ["text", "image"] }
  ];
  runtime.gatewayProbeResponses.push(
    { result: { ok: true, models: discoveredModels } },
    { result: { ok: true, models: discoveredModels } }
  );
  runtime.status = async () => {
    const status = await originalStatus();
    return {
      ...status,
      agentModelTiers: {
        cheap: "saved-cheap",
        default: "saved-default",
        strong: "saved-strong"
      },
      gatewayProfiles: status.gatewayProfiles.map((profile) => profile.id === "test-source" ? {
        ...profile,
        agentModelTiers: {
          cheap: "saved-cheap",
          default: "saved-default",
          strong: "saved-strong"
        },
        visionAgent: {
          enabled: true,
          model: "saved-vision",
          autoUseWhenMainModelTextOnly: true
        }
      } : profile)
    };
  };

  try {
    await withDashboardPage({ width: 1280, height: 900 }, async (page) => {
      await page.locator("#settings-button").click();
      await page.locator("#settings-add-model").click();
      const form = page.locator("#model-config-form");
      const gatewayUrl = form.locator("input[name='gatewayUrl']");
      const pickerInputs = form.locator("input[name='agentCheapModel'], input[name='agentDefaultModel'], input[name='agentStrongModel'], input[name='visionAgentModel']");
      const pickerSelects = form.locator("select[data-agent-model-select]");
      const savedValues = ["saved-cheap", "saved-default", "saved-strong", "saved-vision"];
      const discoveredValues = ["snapshot-cheap", "snapshot-default", "snapshot-strong", "snapshot-vision"];

      assert.deepEqual(await pickerInputs.evaluateAll((inputs) => inputs.map((input) => input.value)), savedValues);
      await gatewayUrl.fill("https://snapshot-b.test/v1/responses");
      assert.deepEqual(await pickerInputs.evaluateAll((inputs) => inputs.map((input) => input.value)), ["", "", "", ""]);

      await form.locator("button[data-action='probe-gateway']").click();
      await waitUntil(() => runtime.gatewayProbeSettledCalls.length === 1);
      await pickerSelects.first().locator("option[value='snapshot-cheap']").waitFor({ state: "attached" });
      for (let index = 0; index < discoveredValues.length; index += 1) {
        await pickerSelects.nth(index).selectOption(discoveredValues[index]);
      }
      assert.deepEqual(await pickerInputs.evaluateAll((inputs) => inputs.map((input) => input.value)), discoveredValues);

      await form.locator("input[name='gatewayApiKey']").fill("replacement-key");
      assert.deepEqual(await pickerInputs.evaluateAll((inputs) => inputs.map((input) => input.value)), discoveredValues);
      assert.deepEqual(await pickerSelects.evaluateAll((selects) => selects.map((select) => select.value)), discoveredValues);
      assert.equal(await form.locator(".agent-model-manual-input:not(.hidden)").count(), 0);

      await form.locator("button[data-action='probe-gateway']").click();
      await waitUntil(() => runtime.gatewayProbeSettledCalls.length === 2);
      await pickerSelects.first().locator("option[value='snapshot-cheap']").waitFor({ state: "attached" });
      for (let index = 0; index < discoveredValues.length; index += 1) {
        await pickerSelects.nth(index).selectOption(discoveredValues[index]);
      }
      assert.deepEqual(await pickerInputs.evaluateAll((inputs) => inputs.map((input) => input.value)), discoveredValues);

      await gatewayUrl.fill("https://snapshot-c.test/v1/responses");
      assert.deepEqual(await pickerInputs.evaluateAll((inputs) => inputs.map((input) => input.value)), ["", "", "", ""]);
      assert.deepEqual(await pickerSelects.evaluateAll((selects) => selects.map((select) => select.value)), ["", "", "", ""]);
      assert.equal(await form.locator(".agent-model-manual-input:not(.hidden)").count(), 0);

      await gatewayUrl.fill("https://models.test/v1/responses");
      assert.deepEqual(await pickerInputs.evaluateAll((inputs) => inputs.map((input) => input.value)), savedValues);
    });
  } finally {
    runtime.status = originalStatus;
    runtime.gatewayProbeCalls.length = 0;
    runtime.gatewayProbeResponses.length = 0;
    runtime.gatewayProbeSettledCalls.length = 0;
  }
});

test("changed gateway protocols clear an unchanged endpoint credential in the save payload", async () => {
  runtime.modelConfigCalls.length = 0;
  runtime.modelConfigResponses.length = 0;
  runtime.modelConfigResponses.push({
    result: { ok: false, status: 422, error: "stop after payload capture" }
  });

  try {
    await withDashboardPage({ width: 1280, height: 900 }, async (page) => {
      await page.locator("#settings-button").click();
      await page.locator("#settings-add-model").click();
      const form = page.locator("#model-config-form");
      await form.locator("input[name='modelId']").fill("protocol-change-model");
      await form.locator("select[name='gatewayProtocol']").selectOption("openai-chat");
      await form.locator("button[type='submit']").click();
      await waitUntil(() => runtime.modelConfigCalls.length === 1);
      await form.locator(".model-config-feedback").waitFor({ state: "visible" });

      assert.equal(runtime.modelConfigCalls[0].gatewayUrl, "https://models.test/v1/responses");
      assert.equal(runtime.modelConfigCalls[0].previousGatewayProtocol, "openai-responses");
      assert.equal(runtime.modelConfigCalls[0].credentialAction, "clear");
    });
  } finally {
    runtime.modelConfigCalls.length = 0;
    runtime.modelConfigResponses.length = 0;
  }
});

test("API key rotation preserves stored reasoning while endpoint and protocol changes invalidate it", async () => {
  runtime.modelConfigCalls.length = 0;
  runtime.modelConfigResponses.length = 0;
  runtime.modelConfigResponses.push({
    result: { ok: false, status: 422, error: "stop after key-only payload capture" }
  });

  try {
    await withDashboardPage({ width: 1280, height: 900 }, async (page) => {
      await page.locator("#settings-button").click();
      await page.waitForFunction(() => document.querySelector("#settings-content")?.getAttribute("aria-busy") !== "true");
      const openStoredModel = async () => {
        await page.locator(".settings-model-row", { hasText: "Test model" })
          .locator("button[data-action='edit-model']").click();
        return page.locator("#model-config-form");
      };

      let form = await openStoredModel();
      assert.equal(await form.locator("input[name='reasoningEfforts']:checked").count(), 4);
      assert.equal(await form.locator("select[name='defaultReasoningEffort']").inputValue(), "medium");

      await form.locator("input[name='gatewayApiKey']").fill("rotated-key-only");
      assert.equal(await form.locator("input[name='reasoningEfforts']:checked").count(), 4);
      assert.equal(await form.locator("select[name='defaultReasoningEffort']").inputValue(), "medium");
      await form.locator("button[type='submit']").click();
      await waitUntil(() => runtime.modelConfigCalls.length === 1);
      await form.locator(".model-config-feedback").waitFor({ state: "visible" });
      assert.equal(runtime.modelConfigCalls[0].credentialAction, "replace");
      assert.deepEqual(runtime.modelConfigCalls[0].reasoningEfforts, ["low", "medium", "high", "xhigh"]);
      assert.equal(runtime.modelConfigCalls[0].defaultReasoningEffort, "medium");

      await form.locator("button[data-action='close-model-config']").first().click();
      form = await openStoredModel();
      await form.locator("input[name='gatewayUrl']").fill("https://changed-reasoning-endpoint.test/v1/responses");
      assert.equal(await form.locator("input[name='reasoningEfforts']:checked").count(), 0);
      assert.equal(await form.locator("select[name='defaultReasoningEffort']").inputValue(), "");

      await form.locator("button[data-action='close-model-config']").first().click();
      form = await openStoredModel();
      await form.locator("select[name='gatewayProtocol']").selectOption("openai-chat");
      assert.equal(await form.locator("input[name='reasoningEfforts']:checked").count(), 0);
      assert.equal(await form.locator("select[name='defaultReasoningEffort']").inputValue(), "");
    });
  } finally {
    runtime.modelConfigCalls.length = 0;
    runtime.modelConfigResponses.length = 0;
  }
});

test("manual reasoning edits win over a delayed capability probe until discovery is applied", async () => {
  runtime.modelCapabilityProbeCalls.length = 0;
  runtime.modelCapabilityProbeResponses.length = 0;
  runtime.modelCapabilityProbeSettledCalls.length = 0;
  runtime.modelConfigCalls.length = 0;
  runtime.modelConfigResponses.length = 0;
  runtime.modelCapabilityProbeResponses.push({
    delayMs: 180,
    result: {
      ok: true,
      modelId: "probe-model",
      discoveryToken: "active-capability-proof",
      reasoningEfforts: [{ id: "minimal", label: "Minimal" }, { id: "high", label: "High" }],
      defaultReasoningEffort: "minimal",
      reasoningDiscovery: {
        source: "explicit-probe",
        confidence: "probed",
        supportsReasoning: true,
        probeAvailable: true,
        warnings: []
      }
    }
  });
  try {
    await withDashboardPage({ width: 1280, height: 900 }, async (page) => {
      await page.locator("#settings-button").click();
      await page.locator("#settings-add-model").click();
      const form = page.locator("#model-config-form");
      await form.locator("input[name='modelId']").fill("probe-model");
      await form.locator("button[data-action='detect-reasoning-capabilities']").click();
      await waitUntil(() => runtime.modelCapabilityProbeCalls.length === 1);
      await form.locator("input[name='reasoningEfforts'][value='max']").check();
      await waitUntil(() => runtime.modelCapabilityProbeSettledCalls.length === 1);

      const apply = form.locator("button[data-action='apply-reasoning-capabilities']");
      await apply.waitFor({ state: "visible" });
      assert.equal(await form.locator("input[name='reasoningEfforts'][value='max']").isChecked(), true);
      assert.equal(await form.locator("input[name='reasoningEfforts'][value='minimal']").count(), 0);
      assert.match(await form.locator("#reasoning-capability-status").textContent(), /手动设置.*发现 2 档/);

      await apply.click();
      assert.equal(await form.locator("input[name='reasoningEfforts'][value='minimal']").isChecked(), true);
      assert.equal(await form.locator("input[name='reasoningEfforts'][value='high']").isChecked(), true);
      assert.equal(await form.locator("input[name='reasoningEfforts'][value='max']").isChecked(), false);
      assert.equal(await form.locator("select[name='defaultReasoningEffort']").inputValue(), "minimal");

      assert.match(runtime.modelCapabilityProbeCalls[0].clientId, /^dashboard-/);
      assert.equal(["global", "project"].includes(runtime.modelCapabilityProbeCalls[0].saveTarget), true);
      runtime.modelConfigResponses.push({
        result: { ok: false, status: 422, error: "stop after active proof payload capture" }
      });
      await form.locator("button[type='submit']").click();
      await waitUntil(() => runtime.modelConfigCalls.length === 1);
      await form.locator(".model-config-feedback").waitFor({ state: "visible" });
      assert.equal(runtime.modelConfigCalls[0].gatewayDiscoveryToken, "active-capability-proof");
    });
  } finally {
    runtime.modelCapabilityProbeCalls.length = 0;
    runtime.modelCapabilityProbeResponses.length = 0;
    runtime.modelCapabilityProbeSettledCalls.length = 0;
    runtime.modelConfigCalls.length = 0;
    runtime.modelConfigResponses.length = 0;
  }
});

test("editing a stored model prefers actionable discovery and keeps stored efforts when discovery is unknown", async () => {
  runtime.gatewayProbeCalls.length = 0;
  runtime.gatewayProbeResponses.length = 0;
  runtime.gatewayProbeSettledCalls.length = 0;
  runtime.gatewayProbeResponses.push({
    result: {
      ok: true,
      message: "catalog without capabilities",
      discoveryToken: "stored-model-unknown",
      models: [{ id: "test-model", displayName: "Test model" }]
    }
  }, {
    result: {
      ok: true,
      message: "catalog with capabilities",
      discoveryToken: "stored-model-actionable",
      models: [{
        id: "test-model",
        displayName: "Test model",
        reasoningEfforts: [{ id: "max", label: "Max" }, { id: "ultra", label: "Ultra" }]
      }]
    }
  });

  try {
    await withDashboardPage({ width: 1280, height: 900 }, async (page) => {
      await page.locator("#settings-button").click();
      await page.waitForFunction(() => document.querySelector("#settings-content")?.getAttribute("aria-busy") !== "true");
      await page.locator(".settings-model-row", { hasText: "Test model" })
        .locator("button[data-action='edit-model']").click();
      const form = page.locator("#model-config-form");

      assert.equal(await form.locator("input[name='reasoningEfforts'][value='medium']").isChecked(), true);
      await form.locator("button[data-action='probe-gateway']").click();
      await waitUntil(() => runtime.gatewayProbeSettledCalls.length === 1);
      assert.equal(await form.locator("input[name='reasoningEfforts'][value='medium']").isChecked(), true);
      assert.equal(await form.locator("select[name='defaultReasoningEffort']").inputValue(), "medium");

      await form.locator("button[data-action='probe-gateway']").click();
      await waitUntil(() => runtime.gatewayProbeSettledCalls.length === 2);
      await page.waitForFunction(() => document.querySelector("input[name='reasoningEfforts'][value='ultra']")?.checked === true);
      assert.equal(await form.locator("input[name='reasoningEfforts'][value='low']").isChecked(), false);
      assert.equal(await form.locator("input[name='reasoningEfforts'][value='medium']").isChecked(), false);
      assert.equal(await form.locator("input[name='reasoningEfforts'][value='max']").isChecked(), true);
      assert.equal(await form.locator("input[name='reasoningEfforts'][value='ultra']").isChecked(), true);
      assert.equal(await form.locator("select[name='defaultReasoningEffort']").inputValue(), "");
      assert.equal(await form.locator("button[data-action='apply-reasoning-capabilities']").isVisible(), false);
      assert.match(await form.locator("#reasoning-capability-status").textContent(), /上游已提供 2 档/);
    });
  } finally {
    runtime.gatewayProbeCalls.length = 0;
    runtime.gatewayProbeResponses.length = 0;
    runtime.gatewayProbeSettledCalls.length = 0;
  }
});

test("closed dialogs and changed endpoints reject delayed capability results", async () => {
  runtime.modelCapabilityProbeCalls.length = 0;
  runtime.modelCapabilityProbeResponses.length = 0;
  runtime.modelCapabilityProbeSettledCalls.length = 0;
  runtime.modelCapabilityProbeResponses.push({
    delayMs: 160,
    result: {
      ok: true,
      modelId: "old-dialog-model",
      reasoningEfforts: [{ id: "stale-close", label: "Stale close" }],
      reasoningDiscovery: { source: "explicit-probe", supportsReasoning: true, probeAvailable: true }
    }
  }, {
    delayMs: 160,
    result: {
      ok: true,
      modelId: "old-endpoint-model",
      reasoningEfforts: [{ id: "stale-endpoint", label: "Stale endpoint" }],
      reasoningDiscovery: { source: "explicit-probe", supportsReasoning: true, probeAvailable: true }
    }
  });
  try {
    await withDashboardPage({ width: 1280, height: 900 }, async (page) => {
      await page.locator("#settings-button").click();
      await page.locator("#settings-add-model").click();
      let form = page.locator("#model-config-form");
      await form.locator("input[name='modelId']").fill("old-dialog-model");
      await form.locator("button[data-action='detect-reasoning-capabilities']").click();
      await waitUntil(() => runtime.modelCapabilityProbeCalls.length === 1);
      await form.locator("button[data-action='close-model-config']").first().click();

      await page.locator("#settings-add-model").click();
      form = page.locator("#model-config-form");
      await form.locator("input[name='modelId']").fill("new-dialog-model");
      await waitUntil(() => runtime.modelCapabilityProbeSettledCalls.length === 1);
      assert.equal(await form.locator("input[name='reasoningEfforts'][value='stale-close']").count(), 0);
      assert.match(await form.locator("#reasoning-capability-status").textContent(), /未自动发现档位/);

      await form.locator("input[name='modelId']").fill("old-endpoint-model");
      await form.locator("button[data-action='detect-reasoning-capabilities']").click();
      await waitUntil(() => runtime.modelCapabilityProbeCalls.length === 2);
      await form.locator("input[name='gatewayUrl']").fill("https://changed-endpoint.test/v1/responses");
      await waitUntil(() => runtime.modelCapabilityProbeSettledCalls.length === 2);
      assert.equal(await form.locator("input[name='gatewayUrl']").inputValue(), "https://changed-endpoint.test/v1/responses");
      assert.equal(await form.locator("input[name='reasoningEfforts'][value='stale-endpoint']").count(), 0);
      assert.match(await form.locator("#reasoning-capability-status").textContent(), /未自动发现档位/);
    });
  } finally {
    runtime.modelCapabilityProbeCalls.length = 0;
    runtime.modelCapabilityProbeResponses.length = 0;
    runtime.modelCapabilityProbeSettledCalls.length = 0;
  }
});

test("max reasoning effort is selectable only when the current model declares it", async () => {
  const originalStatus = runtime.status;
  const originalSwitchReasoningEffort = runtime.switchReasoningEffort;
  const maxModel = {
    ...browserModel(),
    reasoningEfforts: [...browserModel().reasoningEfforts, { id: "max", label: "Max" }]
  };
  runtime.reasoningEffortCalls.length = 0;
  runtime.status = async () => {
    const status = await originalStatus();
    status.models = [maxModel];
    status.gatewayProfiles[0].models = [maxModel];
    return status;
  };
  runtime.switchReasoningEffort = async (body) => {
    runtime.reasoningEffortCalls.push(body);
    return browserModelRuntimeResponse({ reasoningEffort: body.reasoningEffort ?? null, model: maxModel });
  };

  try {
    await withDashboardPage({ width: 1280, height: 900 }, async (page) => {
      const select = page.locator("#reasoning-effort-select");
      await select.waitFor();
      assert.equal(await select.isEnabled(), true);
      assert.deepEqual(await select.locator("option").allTextContents(), ["默认", "低", "中", "高", "极高", "最高"]);
      assert.equal(await select.locator("option[value='max']").count(), 1);

      await select.selectOption("max");
      await waitUntil(() => runtime.reasoningEffortCalls.length === 1);
      assert.equal(runtime.reasoningEffortCalls[0].reasoningEffort, "max");
      assert.equal(runtime.reasoningEffortCalls[0].providerId, "test-source");
      assert.equal(runtime.reasoningEffortCalls[0].modelId, "test-model");
      assert.equal(runtime.reasoningEffortCalls[0].sessionId, null);
      assert.match(runtime.reasoningEffortCalls[0].clientId, /^dashboard-/);
      await page.waitForFunction(() => document.querySelector("#reasoning-effort-select")?.value === "max");

      await select.selectOption("");
      await waitUntil(() => runtime.reasoningEffortCalls.length === 2);
      assert.equal(runtime.reasoningEffortCalls[1].reasoningEffort, null);
      assert.equal(runtime.reasoningEffortCalls[1].providerId, "test-source");
      assert.equal(runtime.reasoningEffortCalls[1].modelId, "test-model");
      assert.equal(runtime.reasoningEffortCalls[1].sessionId, null);
      assert.match(runtime.reasoningEffortCalls[1].clientId, /^dashboard-/);
      await page.waitForFunction(() => document.querySelector("#reasoning-effort-select")?.value === "");
      assert.equal(await select.inputValue(), "");
    });
  } finally {
    runtime.status = originalStatus;
    runtime.switchReasoningEffort = originalSwitchReasoningEffort;
    runtime.reasoningEffortCalls.length = 0;
  }
});

test("settings saves only changed fields and preserves a failed draft in place", async () => {
  runtime.settingsConfigCalls.length = 0;
  runtime.settingsConfigResponses.length = 0;
  runtime.settingsConfigResponses.push({
    delayMs: 500,
    result: { ok: false, status: 409, error: "测试设置保存失败" }
  });
  try {
    await withDashboardPage({ width: 1280, height: 900 }, async (page) => {
      await page.locator("#settings-button").click();

      for (const [section, names] of [
        ["agents", ["maxParallelReadonlyAgentRuns", "goalMaxAutoContinues"]],
        ["reliability", ["maxRetries", "timeoutSeconds", "idleTimeoutSeconds"]]
      ]) {
        await page.locator(`#settings-rail button[data-settings-section='${section}']`).click();
        for (const name of names) {
          assert.equal(await page.locator(`input[name='${name}']`).getAttribute("required"), "");
        }
      }

      await page.locator("#settings-rail button[data-settings-section='transcript']").click();
      const retention = page.locator("select[name='retentionDays']");
      assert.equal(await retention.getAttribute("required"), "");
      assert.equal(await retention.locator("option[value='3650']").textContent(), "10 年（期限上限）");
      assert.equal(await retention.locator("option[value='forever']").textContent(), "永久保留");

      await page.locator("#settings-rail button[data-settings-section='network']").click();
      const form = page.locator("form[data-settings-form='network']");
      assert.equal(await form.locator("option[value='open-dev']").getAttribute("disabled"), "");
      assert.equal(await form.locator("option[value='lab-only']").getAttribute("disabled"), null);
      await form.locator("select[name='mode']").selectOption("lab-only");
      await form.locator("textarea[name='allowedHosts']").fill("models.test\nrepair.test");
      await form.locator("select[name='saveTarget']").selectOption("global");
      await form.locator("button[type='submit']").click();

      await page.waitForFunction(() => document.querySelector("form[data-settings-form='network']")?.getAttribute("aria-busy") === "true");
      assert.equal(await form.locator("select[name='mode']").isDisabled(), true);
      assert.equal(await form.locator("textarea[name='allowedHosts']").isDisabled(), true);
      assert.equal(await form.locator("button[type='submit']").textContent(), "保存中");

      const feedback = page.locator("#settings-content > .settings-feedback.error");
      await feedback.waitFor();
      assert.match(await feedback.textContent(), /测试设置保存失败/);
      assert.equal(await form.locator("select[name='mode']").inputValue(), "lab-only");
      assert.equal(await form.locator("textarea[name='allowedHosts']").inputValue(), "models.test\nrepair.test");
      assert.equal(await form.locator("select[name='saveTarget']").inputValue(), "global");
      assert.equal(await form.locator("select[name='mode']").isEnabled(), true);
      assert.deepEqual(runtime.settingsConfigCalls[0], {
        section: "network",
        saveTarget: "global",
        sessionId: null,
        settings: { mode: "lab-only", allowedHosts: "models.test\nrepair.test" },
        changedFields: ["mode", "allowedHosts"]
      });

      await page.locator("#settings-rail button[data-settings-section='reliability']").click();
      const reliability = page.locator("form[data-settings-form='reliability']");
      await reliability.locator("input[name='timeoutSeconds']").fill("120");
      await reliability.locator("input[name='idleTimeoutSeconds']").fill("90");
      await reliability.locator("button[type='submit']").click();
      await waitUntil(() => runtime.settingsConfigCalls.length === 2);
      await page.locator("#settings-content > .settings-feedback.success").waitFor();
      assert.deepEqual(runtime.settingsConfigCalls[1].changedFields, ["timeoutMs", "idleTimeoutMs"]);
    });
  } finally {
    runtime.settingsConfigResponses.length = 0;
  }
});

test("transcript settings save permanent retention as an explicit null policy", async () => {
  runtime.settingsConfigCalls.length = 0;
  await withDashboardPage({ width: 1280, height: 900 }, async (page) => {
    await page.locator("#settings-button").click();
    await page.locator("#settings-rail button[data-settings-section='transcript']").click();
    const form = page.locator("form[data-settings-form='transcript']");
    await form.locator("select[name='retentionDays']").selectOption("forever");
    await form.locator("button[type='submit']").click();
    await waitUntil(() => runtime.settingsConfigCalls.length === 1);
    await page.locator("#settings-content > .settings-feedback.success").waitFor();

    assert.deepEqual(runtime.settingsConfigCalls[0], {
      section: "transcript",
      saveTarget: "project",
      sessionId: null,
      settings: { enabled: true, retentionDays: null, encryption: "off" },
      changedFields: ["retentionDays"]
    });
    assert.equal(await form.locator("select[name='retentionDays']").inputValue(), "forever");
  });
});

test("gateway profile edit prefills its own endpoint and keeps model credentials after failure", async () => {
  runtime.modelConfigCalls.length = 0;
  runtime.modelConfigResponses.length = 0;
  runtime.modelConfigResponses.push({
    delayMs: 500,
    result: { ok: false, status: 409, code: "SESSION_RUNNING", error: "测试模型保存失败" }
  });
  try {
    await withDashboardPage({ width: 1280, height: 900 }, async (page) => {
      await page.locator("#settings-button").click();
      const managedProfile = page.locator(".settings-profile-row", { hasText: "Managed source" });
      assert.equal(await managedProfile.locator("button[data-action='edit-gateway-profile']").isDisabled(), true);
      assert.equal(await managedProfile.locator("button[data-action='edit-gateway-profile']").textContent(), "只读");
      assert.equal(await managedProfile.locator("button[data-action='delete-gateway-profile']").isDisabled(), true);
      const profile = page.locator(".settings-profile-row", { hasText: "Repair source" });
      await profile.locator("button[data-action='edit-gateway-profile']").click();
      const form = page.locator("#model-config-form");
      await form.waitFor();

      assert.equal(await form.locator("input[name='gatewayUrl']").inputValue(), "https://repair.test/v1/responses");
      assert.equal(await form.locator("select[name='gatewayProtocol']").inputValue(), "openai-responses");
      assert.equal(await form.locator("input[name='modelId']").inputValue(), "");
      assert.equal(await form.locator("input[name='saveTarget'][value='global']").isChecked(), true);
      assert.equal(await form.locator("input[name='saveTarget'][value='global']").isEnabled(), true);
      assert.equal(await form.locator("input[name='saveTarget'][value='project']").isDisabled(), true);
      assert.match(await form.locator(".model-config-scope-note").textContent(), /全局配置/);
      assert.equal(await form.locator("input[name='reasoningEfforts'][value='xhigh']").count(), 1);
      assert.equal(await form.locator("input[name='reasoningEfforts'][value='xhigh']").isChecked(), false);
      const offEffort = form.locator("input[name='reasoningEfforts'][value='off']");
      assert.equal(await offEffort.count(), 1);
      assert.equal(await offEffort.isChecked(), false);
      const maxEffort = form.locator("input[name='reasoningEfforts'][value='max']");
      assert.equal(await maxEffort.count(), 1);
      assert.equal(await maxEffort.isChecked(), false);
      await maxEffort.check();
      await form.locator("select[name='defaultReasoningEffort']").selectOption("max");

      await form.locator("input[name='gatewayUrl']").fill("https://repaired.test/v1/responses");
      await form.locator("input[name='modelId']").fill("grok-repaired");
      await form.locator("input[name='gatewayApiKey']").fill("sk-browser-draft-only");
      await form.locator("button[type='submit']").click();

      await waitUntil(() => runtime.modelConfigCalls.length === 1);
      await page.waitForFunction(() => document.querySelector("#model-config-form")?.getAttribute("aria-busy") === "true");
      assert.equal(await form.locator("input[name='gatewayUrl']").isDisabled(), true);
      assert.equal(await form.locator("input[name='gatewayApiKey']").isDisabled(), true);
      await form.locator(".model-config-feedback").waitFor({ state: "visible" });
      assert.match(await form.locator(".model-config-feedback").textContent(), /测试模型保存失败/);
      assert.doesNotMatch(await form.locator(".model-config-feedback").textContent(), /另一个窗口更新/);
      assert.equal(await form.locator("input[name='gatewayUrl']").inputValue(), "https://repaired.test/v1/responses");
      assert.equal(await form.locator("input[name='modelId']").inputValue(), "grok-repaired");
      assert.equal(await form.locator("input[name='gatewayApiKey']").inputValue(), "sk-browser-draft-only");
      assert.equal(await form.locator("input[name='gatewayApiKey']").isEnabled(), true);
      assert.equal(runtime.modelConfigCalls[0].profileId, "repair-source");
      assert.equal(runtime.modelConfigCalls[0].saveTarget, "global");
      assert.equal(runtime.modelConfigCalls[0].previousGatewayUrl, "https://repair.test/v1/responses");
      assert.equal(runtime.modelConfigCalls[0].credentialAction, "replace");
      assert.deepEqual(runtime.modelConfigCalls[0].reasoningEfforts, ["max"]);
      assert.equal(runtime.modelConfigCalls[0].defaultReasoningEffort, "max");
    });
  } finally {
    runtime.modelConfigResponses.length = 0;
  }
});

test("stale model settings keep the draft and send scoped config revisions", async () => {
  runtime.modelConfigCalls.length = 0;
  runtime.modelConfigResponses.length = 0;
  runtime.modelConfigResponses.push({
    result: {
      ok: false,
      status: 409,
      code: "CONFIG_REVISION_CONFLICT",
      error: "stale settings"
    }
  });
  try {
    await withDashboardPage({ width: 1280, height: 900 }, async (page) => {
      await page.locator("#settings-button").click();
      await page.waitForFunction(() => document.querySelector("#settings-content")?.getAttribute("aria-busy") !== "true");
      await page.locator(".settings-profile-row", { hasText: "Repair source" })
        .locator("button[data-action='edit-gateway-profile']").click();
      const form = page.locator("#model-config-form");
      await form.locator("input[name='gatewayUrl']").fill("https://draft.test/v1/responses");
      await form.locator("input[name='modelId']").fill("draft-model");
      await form.locator("input[name='gatewayApiKey']").fill("sk-draft-only");
      await form.locator("input[name='reasoningEfforts'][value='max']").check();
      await form.locator("button[type='submit']").click();

      await form.locator(".model-config-feedback").waitFor({ state: "visible" });
      assert.match(await form.locator(".model-config-feedback").textContent(), /另一个窗口更新/);
      assert.equal(await form.locator("input[name='gatewayUrl']").inputValue(), "https://draft.test/v1/responses");
      assert.equal(await form.locator("input[name='modelId']").inputValue(), "draft-model");
      assert.equal(await form.locator("input[name='gatewayApiKey']").inputValue(), "sk-draft-only");
      assert.equal(await form.locator("input[name='reasoningEfforts'][value='max']").isChecked(), true);

      const call = runtime.modelConfigCalls[0];
      assert.equal(call.scope, "global");
      assert.equal(call.providerId, "repair-source");
      assert.equal(call.expectedRevision, "global-r1");
      assert.equal(call.expectedCredentialsRevision, "credentials-r1");
    });
  } finally {
    runtime.modelConfigResponses.length = 0;
  }
});

test("settings saves a scoped default while the bottom selector stays tab-local", async () => {
  runtime.defaultModelCalls.length = 0;
  runtime.modelSwitchCalls.length = 0;
  await withDashboardPage({ width: 1280, height: 900 }, async (page) => {
    await page.locator("#settings-button").click();
    await page.waitForFunction(() => document.querySelector("#settings-content")?.getAttribute("aria-busy") !== "true");
    await page.locator(".settings-model-row button[data-action='use-model']").click();
    await waitUntil(() => runtime.defaultModelCalls.length === 1);

    assert.deepEqual(runtime.defaultModelCalls[0], {
      scope: "project",
      providerId: "test-source",
      modelId: "test-model",
      reasoningEffort: "medium",
      expectedRevision: "project-r1"
    });
    assert.equal(runtime.modelSwitchCalls.length, 0);
    await page.locator("#settings-content > .settings-feedback.success").waitFor();
  });
});

test("model settings show each scope default and switch scope without saving", async () => {
  runtime.defaultModelCalls.length = 0;
  const originalStatus = runtime.status;
  const globalModel = {
    ...browserModel(),
    id: "global-model",
    label: "Global model",
    current: false,
    source: { id: "global-source", profileId: "global-source", label: "Global source" }
  };
  runtime.status = async () => {
    const status = await originalStatus();
    return {
      ...status,
      gatewayProfiles: [
        status.gatewayProfiles[0],
        {
          id: "global-source",
          label: "Global source",
          gatewayUrl: "https://global.test/v1/responses",
          gatewayProtocol: "openai-responses",
          apiKeyConfigured: true,
          modelAlias: globalModel.id,
          modelCount: 1,
          saveTarget: "global",
          current: false,
          models: [globalModel]
        }
      ],
      models: [browserModel(), globalModel],
      configV2: {
        ...status.configV2,
        defaultSelections: {
          project: { provider: "test-source", model: "test-model", reasoningEffort: "medium" },
          global: { provider: "global-source", model: "global-model", reasoningEffort: "high" }
        }
      }
    };
  };

  try {
    await withDashboardPage({ width: 1280, height: 900 }, async (page) => {
      await page.locator("#settings-button").click();
      await page.waitForFunction(() => document.querySelector("#settings-content")?.getAttribute("aria-busy") !== "true");

      const summary = page.locator(".settings-default-summary");
      assert.match((await summary.textContent()).replace(/\s+/g, " "), /当前项目默认.*Test source.*Test model.*test-model/);
      assert.match((await page.locator(".settings-model-row.scope-default").textContent()).replace(/\s+/g, " "), /Test model.*此范围默认/);

      await page.locator("button[data-action='select-default-scope'][data-scope='global']").click();
      assert.equal(runtime.defaultModelCalls.length, 0);
      assert.match((await summary.textContent()).replace(/\s+/g, " "), /全局默认.*Global source.*Global model.*global-model/);

      await page.locator(".settings-profile-row", { hasText: "Global source" })
        .locator("button[data-action='inspect-profile']").click();
      assert.match((await page.locator(".settings-model-row.scope-default").textContent()).replace(/\s+/g, " "), /Global model.*此范围默认/);

      await page.locator(".settings-profile-row", { hasText: "Test source" })
        .locator("button[data-action='inspect-profile']").click();
      await page.locator(".settings-model-row button[data-action='use-model']").click();
      await waitUntil(() => runtime.defaultModelCalls.length === 1);
      assert.equal(runtime.defaultModelCalls[0].scope, "global");
      assert.equal(runtime.defaultModelCalls[0].providerId, "test-source");
      assert.equal(runtime.defaultModelCalls[0].modelId, "test-model");
    });
  } finally {
    runtime.status = originalStatus;
    runtime.defaultModelCalls.length = 0;
  }
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
    await waitForPreviewWidth(page, 480);
    const draggedWidth = (await preview.boundingBox()).width;
    assert.ok(Math.abs(draggedWidth - 480) <= 2, `unexpected dragged width ${draggedWidth}`);

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelectorAll("#thread-list .thread-item").length === 2);
    await waitForPreviewWidth(page, draggedWidth);
    const reloadedWidth = (await preview.boundingBox()).width;
    const storedWidth = await page.evaluate(() => window.localStorage.getItem("ant-code-dashboard-preview-width"));
    assert.ok(
      Math.abs(reloadedWidth - draggedWidth) <= 2,
      `preview width was not persisted: dragged=${draggedWidth}, reloaded=${reloadedWidth}, stored=${storedWidth}`
    );

    await handle.focus();
    await page.keyboard.press("End");
    await waitForPreviewWidth(page, 600);
    const maximumWidth = (await preview.boundingBox()).width;
    assert.ok(Math.abs(maximumWidth - 600) <= 1, `expected maximum width 600, got ${maximumWidth}`);
    assert.ok((await workspace.boundingBox()).width >= 520);
    await page.keyboard.press("ArrowRight");
    await waitForPreviewWidth(page, 584);
    assert.ok(Math.abs((await preview.boundingBox()).width - 584) <= 1);

    await page.setViewportSize({ width: 1024, height: 900 });
    assert.equal(await handle.isVisible(), false);
    await page.setViewportSize({ width: 1440, height: 900 });
    await waitForPreviewWidth(page, 584);
    assert.ok(Math.abs((await preview.boundingBox()).width - 584) <= 1);

    await handle.dblclick();
    await waitForPreviewWidth(page, 360);
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
      const dot = runningItem.locator(".thread-status-dot");
      await runningItem.waitFor();
      assert.equal(await runningItem.locator(".thread-status-badge").count(), 0);
      assert.notEqual(await dot.evaluate((node) => getComputedStyle(node).display), "none");
      assert.match(await runningItem.locator(".thread-open").getAttribute("aria-label"), /运行中/);
      assert.equal(await page.locator(".thread-item[data-tone='done'] .thread-status-badge").count(), 0);

      await page.locator("#collapse-sidebar").click();
      assert.notEqual(await dot.evaluate((node) => getComputedStyle(node).display), "none");
      assert.equal(await runningItem.locator(".thread-main").evaluate((node) => getComputedStyle(node).display), "none");
    });
  } finally {
    Object.assign(runtime.sessions[0], { active: false, running: false, status: "completed" });
  }
});

test("archived gateway failures show the upstream reason after reopening", async () => {
  const failure = {
    kind: "gateway",
    code: "GATEWAY_HTTP_ERROR",
    message: "Gateway returned HTTP 502",
    httpStatus: 502,
    upstreamMessage: "Upstream service temporarily unavailable",
    attempts: 6
  };
  runtime.sessionFailures.set("session-b", failure);
  Object.assign(runtime.sessions[1], { status: "gateway_error" });
  try {
    await withDashboardPage({ width: 1280, height: 900 }, async (page) => {
      const failedThread = page.locator(".thread-item[data-tone='error']", { hasText: "Session B" });
      await failedThread.waitFor();
      assert.equal(await failedThread.locator(".thread-status-badge").count(), 0);
      assert.match(await failedThread.locator(".thread-open").getAttribute("aria-label"), /失败/);
      await page.locator(".thread-open", { hasText: "Session B" }).click();
      const card = page.locator(".activity-card.danger", { hasText: "模型请求失败" });
      await card.waitFor();
      assert.match(await card.textContent(), /Upstream service temporarily unavailable/);
      assert.match(await card.textContent(), /HTTP 502/);
      assert.match(await card.textContent(), /已尝试 6 次/);
      assert.match(await card.textContent(), /GATEWAY_HTTP_ERROR/);
      assert.equal(await card.locator(".activity-head").getAttribute("aria-expanded"), "true");
    });
  } finally {
    runtime.sessionFailures.delete("session-b");
    Object.assign(runtime.sessions[1], { status: "completed" });
  }
});

test("legacy sessions keep provider, model list, and reasoning effort atomic", async () => {
  const originalStatus = runtime.status;
  const originalSwitchModel = runtime.switchModel;
  const originalSwitchReasoningEffort = runtime.switchReasoningEffort;
  const baseStatus = await originalStatus();
  const grokModel = {
    ...browserModel(),
    id: "grok-4.6",
    label: "Grok 4.6",
    source: { id: "grok", profileId: "grok", label: "Grok" }
  };
  const sharedGrokModel = {
    ...grokModel,
    id: "shared-model",
    label: "Shared model"
  };
  const deepseekPro = {
    ...browserModel(),
    id: "deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    source: { id: "deepseek", profileId: "deepseek", label: "DeepSeek" },
    reasoningEfforts: [{ id: "off", label: "Off" }, { id: "high", label: "High" }, { id: "max", label: "Max" }]
  };
  const glmModel = {
    ...deepseekPro,
    id: "glm-5.2",
    label: "GLM 5.2"
  };
  const sharedDeepSeekModel = {
    ...deepseekPro,
    id: "shared-model",
    label: "Shared model"
  };
  const gatewayProfiles = [{
    id: "grok",
    label: "Grok",
    gatewayUrl: "https://grok.test/v1/responses",
    gatewayProtocol: "openai-responses",
    apiKeyConfigured: true,
    modelAlias: grokModel.id,
    modelCount: 2,
    current: true,
    models: [grokModel, sharedGrokModel]
  }, {
    id: "deepseek",
    label: "DeepSeek",
    gatewayUrl: "https://deepseek.test/v1/chat/completions",
    gatewayProtocol: "openai-chat",
    apiKeyConfigured: true,
    modelAlias: deepseekPro.id,
    modelCount: 3,
    current: false,
    models: [deepseekPro, glmModel, sharedDeepSeekModel]
  }];
  runtime.status = async () => ({
    ...baseStatus,
    sessionStatus: { ...baseStatus.sessionStatus, model: grokModel.id },
    gatewayConfig: { ...baseStatus.gatewayConfig, activeProfileId: "grok" },
    gatewayProfiles,
    models: [grokModel]
  });
  runtime.switchModel = async (body) => {
    runtime.modelSwitchCalls.push(body);
    const profile = gatewayProfiles.find((candidate) => candidate.id === body.providerId);
    const model = profile?.models.find((candidate) => candidate.id === body.modelId);
    assert.ok(profile && model, "browser model switch must use one configured provider/model pair");
    return {
      ok: true,
      sessionStatus: {
        model: model.id,
        providerId: profile.id,
        reasoningEffort: null,
        selectionResolved: true,
        selectionIssue: null,
        context: { usedTokens: 0, totalTokens: 200000, inputTokens: 0 }
      },
      gatewayConfig: { ...baseStatus.gatewayConfig, activeProfileId: profile.id },
      gatewayProfiles: gatewayProfiles.map((candidate) => ({ ...candidate, current: candidate.id === profile.id })),
      models: profile.models,
      agentModelTiers: {},
      visionAgent: { enabled: true, model: "", autoUseWhenMainModelTextOnly: true }
    };
  };
  runtime.switchReasoningEffort = async (body) => {
    runtime.reasoningEffortCalls.push(body);
    const profile = gatewayProfiles.find((candidate) => candidate.id === body.providerId);
    const model = profile?.models.find((candidate) => candidate.id === body.modelId);
    assert.ok(profile && model, "reasoning switch must keep the configured provider/model pair");
    return {
      ok: true,
      sessionStatus: {
        model: model.id,
        providerId: profile.id,
        reasoningEffort: body.reasoningEffort,
        selectionResolved: true,
        selectionIssue: null,
        context: { usedTokens: 0, totalTokens: 200000, inputTokens: 0 }
      },
      gatewayConfig: { ...baseStatus.gatewayConfig, activeProfileId: profile.id },
      gatewayProfiles: gatewayProfiles.map((candidate) => ({ ...candidate, current: candidate.id === profile.id })),
      models: profile.models
    };
  };
  runtime.modelSwitchCalls.length = 0;
  try {
    await withDashboardPage({ width: 1280, height: 900 }, async (page) => {
      await page.waitForFunction(() => /Grok\s*·\s*Grok 4\.6/.test(document.querySelector("#model-status")?.textContent ?? ""));
      await page.locator("#settings-button").click();
      await page.waitForFunction(() => document.querySelector("#settings-content")?.getAttribute("aria-busy") !== "true");
      assert.equal(await page.locator(".settings-profile-row", { hasText: "Grok" }).count(), 1);
      assert.equal(await page.locator(".settings-profile-row", { hasText: "DeepSeek" }).count(), 1);
      await page.locator("#settings-back").click();

      await page.locator("#model-status-toggle").click();
      const panel = page.locator("#model-panel");
      const sourceSelect = panel.locator("select[data-action='switch-source']");
      assert.deepEqual(await sourceSelect.locator("option").allTextContents(), ["Grok", "DeepSeek"]);
      await sourceSelect.selectOption("deepseek");
      await page.waitForFunction(() => /DeepSeek\s*·\s*DeepSeek V4 Pro/.test(document.querySelector("#model-status")?.textContent ?? ""));
      assert.equal(await page.locator("#reasoning-effort-select option[value='max']").count(), 1);
      assert.deepEqual(await sourceSelect.locator("option").allTextContents(), ["Grok", "DeepSeek"]);

      await page.locator("#settings-button").click();
      await page.waitForFunction(() => document.querySelector("#settings-content")?.getAttribute("aria-busy") !== "true");
      assert.equal(await page.locator(".settings-profile-row", { hasText: "Grok" }).count(), 1);
      assert.equal(await page.locator(".settings-profile-row", { hasText: "DeepSeek" }).count(), 1);
    });

    runtime.sessionModelOverrides.set("session-b", "glm-5.2");
    await withDashboardPage({ width: 1280, height: 900 }, async (page) => {
      await page.locator(".thread-open", { hasText: "Session B" }).click();
      await page.waitForFunction(() => /DeepSeek\s*·\s*GLM 5\.2/.test(document.querySelector("#model-status")?.textContent ?? ""));
      assert.match(await page.locator("#model-status").textContent(), /DeepSeek\s*·\s*GLM 5\.2/);
      assert.deepEqual(await page.locator("#reasoning-effort-select option").allTextContents(), ["默认", "关闭", "高", "最高"]);

      await page.locator("#model-status-toggle").click();
      const panel = page.locator("#model-panel");
      assert.equal(await panel.locator("select[data-action='switch-source']").inputValue(), "deepseek");
      assert.equal(await panel.locator("select[data-action='switch-model']").inputValue(), "glm-5.2");
      assert.deepEqual(
        await panel.locator("select[data-action='switch-model'] option").allTextContents(),
        ["DeepSeek V4 Pro", "GLM 5.2", "Shared model"]
      );

      runtime.reasoningEffortCalls.length = 0;
      await page.keyboard.press("Escape");
      await page.locator("#reasoning-effort-select").selectOption("max");
      await waitUntil(() => runtime.reasoningEffortCalls.length === 1);
      assert.deepEqual(
        {
          providerId: runtime.reasoningEffortCalls[0].providerId,
          modelId: runtime.reasoningEffortCalls[0].modelId,
          reasoningEffort: runtime.reasoningEffortCalls[0].reasoningEffort,
          sessionId: runtime.reasoningEffortCalls[0].sessionId,
          clientId: runtime.reasoningEffortCalls[0].clientId
        },
        {
          providerId: "deepseek",
          modelId: "glm-5.2",
          reasoningEffort: "max",
          sessionId: "session-b",
          clientId: undefined
        }
      );

      const modelSwitchCount = runtime.modelSwitchCalls.length;
      await page.locator("#settings-button").click();
      const inspectedSource = page.locator(".settings-current-source");
      await page.locator("button[data-action='inspect-profile'][data-profile-id='grok']").click();
      await page.waitForFunction(() => (
        document.querySelector(".settings-current-source")?.textContent?.includes("Grok")
        && document.querySelectorAll(".settings-model-list .settings-model-row strong").length === 2
      ));
      assert.match(await inspectedSource.textContent(), /Grok/);
      assert.match(await inspectedSource.textContent(), /grok\.test/);
      assert.deepEqual(
        await page.locator(".settings-model-list .settings-model-row strong").allTextContents(),
        ["Grok 4.6", "Shared model"]
      );
      await page.locator("button[data-action='inspect-profile'][data-profile-id='deepseek']").click();
      await page.waitForFunction(() => (
        document.querySelector(".settings-current-source")?.textContent?.includes("DeepSeek")
        && document.querySelectorAll(".settings-model-list .settings-model-row strong").length === 3
      ));
      assert.match(await inspectedSource.textContent(), /DeepSeek/);
      assert.match(await inspectedSource.textContent(), /deepseek\.test/);
      assert.deepEqual(
        await page.locator(".settings-model-list .settings-model-row strong").allTextContents(),
        ["DeepSeek V4 Pro", "GLM 5.2", "Shared model"]
      );
      assert.equal(runtime.modelSwitchCalls.length, modelSwitchCount);
      assert.match(await page.locator("#model-status").textContent(), /DeepSeek\s*·\s*GLM 5\.2/);
      await page.locator("#settings-back").click();

      await page.locator("#new-task").click();
      await page.waitForFunction(() => /Grok\s*·\s*Grok 4\.6/.test(document.querySelector("#model-status")?.textContent ?? ""));
      assert.match(await page.locator("#model-status").textContent(), /Grok\s*·\s*Grok 4\.6/);
    });

    runtime.sessionModelOverrides.set("session-b", "shared-model");
    await withDashboardPage({ width: 1280, height: 900 }, async (page) => {
      await page.locator(".thread-open", { hasText: "Session B" }).click();
      await page.waitForFunction(() => document.querySelector("#model-status")?.textContent?.includes("需要重新选择模型"));
      assert.match(await page.locator("#model-status").textContent(), /需要重新选择模型/);
      assert.doesNotMatch(await page.locator("#model-status").textContent(), /Grok|DeepSeek|shared-model/i);
      assert.equal(await page.locator("#send-button").textContent(), "选择模型");
      assert.equal(await page.locator("#send-button").isDisabled(), true);
      assert.deepEqual(await page.locator("#reasoning-effort-select option").allTextContents(), ["不可用"]);

      await page.locator("#model-status-toggle").click();
      const panel = page.locator("#model-panel");
      const sourceSelect = panel.locator("select[data-action='switch-source']");
      const modelSelect = panel.locator("select[data-action='switch-model']");
      assert.equal(await sourceSelect.inputValue(), "");
      assert.deepEqual(await sourceSelect.locator("option").allTextContents(), ["请选择模型来源", "Grok", "DeepSeek"]);
      assert.equal(await modelSelect.isDisabled(), true);
      assert.deepEqual(await modelSelect.locator("option").allTextContents(), ["请先选择模型来源"]);

      await sourceSelect.selectOption("grok");
      await page.waitForFunction(() => /Grok\s*·\s*Grok 4\.6/.test(document.querySelector("#model-status")?.textContent ?? ""));
      assert.deepEqual(
        { providerId: runtime.modelSwitchCalls.at(-1).providerId, modelId: runtime.modelSwitchCalls.at(-1).modelId },
        { providerId: "grok", modelId: "grok-4.6" }
      );
      assert.equal(await page.locator("#send-button").isEnabled(), true);
    });
  } finally {
    runtime.status = originalStatus;
    runtime.switchModel = originalSwitchModel;
    runtime.switchReasoningEffort = originalSwitchReasoningEffort;
    runtime.sessionModelOverrides.delete("session-b");
    runtime.reasoningEffortCalls.length = 0;
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

test("shutdown dialog recovers when lifecycle inspection never responds", async () => {
  runtime.stallLifecycleStatus = true;
  try {
    await withDashboardPage({ width: 1280, height: 900 }, async (page) => {
      const trigger = page.locator("#shutdown-button:visible, #header-shutdown-button:visible").first();
      await trigger.click();
      const confirm = page.locator("#shutdown-confirm");
      assert.equal(await confirm.isDisabled(), true);
      assert.equal(await confirm.textContent(), "检查中");

      await page.locator("#shutdown-cancel").click();
      await page.locator("#shutdown-panel").waitFor({ state: "hidden" });
      assert.equal(await trigger.isEnabled(), true);

      await trigger.click();
      assert.equal(await confirm.textContent(), "检查中");
      await page.reload({ waitUntil: "domcontentloaded", timeout: 5000 });
      await page.waitForFunction(() => document.querySelectorAll("#thread-list .thread-item").length === 2);
      assert.equal(await page.locator("#shutdown-panel").isHidden(), true);

      const refreshedTrigger = page.locator("#shutdown-button:visible, #header-shutdown-button:visible").first();
      await refreshedTrigger.click();

      await page.waitForFunction(() => {
        const button = document.querySelector("#shutdown-confirm");
        return button && !button.disabled && button.textContent === "强制关闭";
      }, null, { timeout: 8000 });
      assert.match(await page.locator("#shutdown-copy").textContent(), /活动检查超时/);
      await page.locator("#shutdown-cancel").click();
      await page.locator("#shutdown-panel").waitFor({ state: "hidden" });
      assert.equal(await refreshedTrigger.isEnabled(), true);
    });
  } finally {
    runtime.stallLifecycleStatus = false;
  }
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
    sessionFailures: new Map(),
    sessionModelOverrides: new Map(),
    reasoningEffortCalls: [],
    settingsConfigCalls: [],
    settingsConfigResponses: [],
    modelConfigCalls: [],
    modelConfigResponses: [],
    gatewayProbeCalls: [],
    gatewayProbeResponses: [],
    gatewayProbeSettledCalls: [],
    modelCapabilityProbeCalls: [],
    modelCapabilityProbeResponses: [],
    modelCapabilityProbeSettledCalls: [],
    modelSwitchCalls: [],
    defaultModelCalls: [],
    activeSessionIds: new Set(),
    stallLifecycleStatus: false,
    status: async () => ({
      ok: true,
      sessionStatus: {
        model: "test-model",
        reasoningEffort: null,
        context: { usedTokens: 0, totalTokens: 200000, inputTokens: 0 }
      },
      gatewayConfig: {
        gatewayUrl: "https://models.test/v1/responses",
        gatewayProtocol: "openai-responses",
        apiKeyConfigured: true,
        activeProfileId: "test-source"
      },
      gatewayProfiles: [{
        id: "test-source",
        label: "Test source",
        gatewayUrl: "https://models.test/v1/responses",
        gatewayProtocol: "openai-responses",
        apiKeyConfigured: true,
        modelAlias: "test-model",
        modelCount: 1,
        saveTarget: "project",
        current: true,
        models: [browserModel()]
      }, {
        id: "repair-source",
        label: "Repair source",
        gatewayUrl: "https://repair.test/v1/responses",
        gatewayHealthUrl: "",
        gatewayProtocol: "openai-responses",
        apiKeyConfigured: true,
        modelAlias: "",
        modelCount: 0,
        saveTarget: "global",
        ready: false,
        current: false,
        models: []
      }, {
        id: "managed-source",
        label: "Managed source",
        gatewayUrl: "https://managed.test/v1/chat/completions",
        gatewayHealthUrl: "",
        gatewayProtocol: "openai-chat",
        apiKeyConfigured: true,
        modelAlias: "",
        modelCount: 0,
        ownerScope: "environment",
        editable: false,
        ready: false,
        current: false,
        models: []
      }],
      models: [browserModel()],
      configV2: {
        enabled: true,
        paths: { global: "C:\\settings\\global.json", project: "C:\\project\\.lab-agent\\settings.json" },
        revisions: { global: "global-r1", project: "project-r1", credentials: "credentials-r1" }
      },
      settings: browserSettings()
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
        const response = sessionResponse(id, `SESSION_B_FINAL\n\n![remote pixel](${remoteImageUrl})`, this.activeSessionIds.has(id));
        const failure = this.sessionFailures.get(id);
        if (failure) {
          response.session.status = "gateway_error";
          response.session.transcript = [];
          response.session.transcriptPage = { cursor: null, hasMore: false, total: 0 };
          response.session.failure = failure;
        }
        const model = this.sessionModelOverrides.get(id);
        if (model) {
          response.session.model = model;
          response.session.sessionStatus.model = model;
        }
        return response;
      }
      return { ok: false, status: 404, error: "not found" };
    },
    readTranscriptPage: async () => ({ ok: true, transcript: [], transcriptPage: { cursor: null, hasMore: false, total: 0 } }),
    async lifecycleStatus() {
      if (this.stallLifecycleStatus) {
        await new Promise(() => {});
      }
      return {
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
      };
    },
    startTurn: async () => ({ ok: false }),
    interruptTurn: async () => ({ ok: false }),
    cancelQueuedTurn: () => ({ ok: false }),
    cancelBackgroundSubagent: async () => ({ ok: false }),
    cancelBackgroundTerminal: async () => ({ ok: false }),
    guideTurn: async () => ({ ok: false }),
    async switchModel(body) {
      this.modelSwitchCalls.push(body);
      return browserModelRuntimeResponse({ reasoningEffort: body.reasoningEffort ?? null });
    },
    async switchReasoningEffort(body) {
      this.reasoningEffortCalls.push(body);
      return browserModelRuntimeResponse({ reasoningEffort: body.reasoningEffort ?? null });
    },
    async saveDefaultModelSelection(body) {
      this.defaultModelCalls.push(body);
      return {
        ...browserModelRuntimeResponse(),
        configV2: {
          enabled: true,
          paths: { global: "C:\\settings\\global.json", project: "C:\\project\\.lab-agent\\settings.json" },
          revisions: { global: "global-r1", project: "project-r2", credentials: "credentials-r1" }
        }
      };
    },
    async saveSettingsConfig(body) {
      this.settingsConfigCalls.push(body);
      const queued = this.settingsConfigResponses.shift();
      if (queued?.delayMs) await delay(queued.delayMs);
      if (queued?.result) return queued.result;
      const settings = browserSettings();
      if (body.section === "transcript") settings.transcript = { ...settings.transcript, ...body.settings };
      if (body.section === "network") settings.network = {
        ...settings.network,
        ...body.settings,
        allowedHosts: String(body.settings.allowedHosts ?? "").split(/\r?\n/).map((host) => host.trim()).filter(Boolean)
      };
      if (body.section === "agents") settings.agents = { ...settings.agents, ...body.settings };
      if (body.section === "reliability") settings.reliability = { ...settings.reliability, ...body.settings };
      return { ok: true, settings };
    },
    async probeGateway(body) {
      this.gatewayProbeCalls.push(body);
      const queued = this.gatewayProbeResponses.shift();
      if (queued?.delayMs) await delay(queued.delayMs);
      this.gatewayProbeSettledCalls.push(body);
      return queued?.result ?? {
        ok: true,
        models: [browserModel()],
        suggestedGatewayUrl: "https://models.test/v1/responses"
      };
    },
    async probeModelCapabilities(body) {
      this.modelCapabilityProbeCalls.push(body);
      const queued = this.modelCapabilityProbeResponses.shift();
      if (queued?.delayMs) await delay(queued.delayMs);
      this.modelCapabilityProbeSettledCalls.push(body);
      return queued?.result ?? {
        ok: true,
        modelId: body.modelId,
        reasoningEfforts: [],
        defaultReasoningEffort: null,
        reasoningDiscovery: {
          source: "explicit-probe",
          supportsReasoning: null,
          probeAvailable: true,
          warnings: []
        }
      };
    },
    async saveModelConfig(body) {
      this.modelConfigCalls.push(body);
      const queued = this.modelConfigResponses.shift();
      if (queued?.delayMs) await delay(queued.delayMs);
      return queued?.result ?? { ok: false, status: 422, error: "mock model save failure" };
    },
    deleteSession: async () => ({ ok: false }),
    deleteGatewayProfile: async () => ({ ok: false }),
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
        reasoningEffort: null,
        context: { usedTokens: 100, totalTokens: 200000, inputTokens: 40 }
      },
      files: [],
      transcript: [{ role: "assistant", content: assistantText }],
      transcriptPage: { cursor: null, hasMore: false, total: 1 },
      backgroundSnapshot: { groups: [] }
    }
  };
}

function browserModel() {
  return {
    id: "test-model",
    label: "Test model",
    contextTokens: 200000,
    source: { id: "test-source", profileId: "test-source", label: "Test source" },
    reasoningEfforts: [
      { id: "low", label: "Low" },
      { id: "medium", label: "Medium" },
      { id: "high", label: "High" },
      { id: "xhigh", label: "Extra high" }
    ],
    defaultReasoningEffort: "medium",
    current: true
  };
}

function browserSettings() {
  return {
    transcript: { enabled: true, retentionDays: 30, encryption: "off", encryptionKeyConfigured: false },
    network: {
      mode: "approved-web",
      allowedModes: ["offline", "lab-only", "approved-web"],
      allowedHosts: ["models.test"],
      managedAllowedHosts: []
    },
    agents: {
      maxParallelReadonlyAgentRuns: 3,
      backgroundWakeupEnabled: true,
      backgroundByDefault: false,
      reviewGateEnabled: true,
      syncModelTiersOnSwitch: true,
      goalMaxAutoContinues: 12
    },
    reliability: { maxRetries: 5, timeoutMs: 900000, idleTimeoutMs: 300000 },
    managed: {}
  };
}

function browserModelRuntimeResponse({ reasoningEffort = null, model = browserModel() } = {}) {
  return {
    ok: true,
    sessionStatus: {
      model: model.id,
      reasoningEffort,
      context: { usedTokens: 0, totalTokens: 200000, inputTokens: 0 }
    },
    gatewayConfig: {
      gatewayUrl: "https://models.test/v1/responses",
      gatewayProtocol: "openai-responses",
      apiKeyConfigured: true,
      activeProfileId: "test-source"
    },
    gatewayProfiles: [{
      id: "test-source",
      label: "Test source",
      gatewayUrl: "https://models.test/v1/responses",
      gatewayProtocol: "openai-responses",
      apiKeyConfigured: true,
      modelAlias: model.id,
      modelCount: 1,
      current: true,
      models: [model]
    }],
    models: [model],
    agentModelTiers: {},
    visionAgent: { enabled: true, model: "", autoUseWhenMainModelTextOnly: true }
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

async function waitForPreviewWidth(page, expectedWidth) {
  await page.waitForFunction((width) => {
    const panel = document.querySelector("#file-panel");
    const separator = document.querySelector("#preview-resize-handle");
    return panel && separator
      && Number(separator.getAttribute("aria-valuenow")) === width
      && Math.abs(panel.getBoundingClientRect().width - width) <= 2;
  }, expectedWidth);
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
