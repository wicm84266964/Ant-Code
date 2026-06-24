import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { visibleTranscriptRole } from "../../src/dashboard/public/transcript.js";

test("dashboard transcript hides internal prompt roles", () => {
  assert.equal(visibleTranscriptRole("user"), "user");
  assert.equal(visibleTranscriptRole("assistant"), "assistant");
  assert.equal(visibleTranscriptRole("system"), null);
  assert.equal(visibleTranscriptRole("developer"), null);
  assert.equal(visibleTranscriptRole("tool"), null);
});

test("dashboard context status prefers active model messages over latest gateway prompt", async () => {
  const appPath = path.resolve("src/dashboard/public/app.js");
  const source = await fs.readFile(appPath, "utf8");
  const harness = `
    const document = {
      querySelector() {
        return {
          addEventListener() {},
          classList: { add() {}, remove() {}, toggle() {} },
          dataset: {},
          textContent: "",
          innerHTML: "",
          append() {},
          replaceChildren() {},
          querySelectorAll() { return []; },
          querySelector() { return null; }
        };
      },
      addEventListener() {}
    };
    const window = {};
    const navigator = { clipboard: { writeText() {} } };
    const requestAnimationFrame = () => {};
    class EventSource {}
    function renderMarkdown() { return ""; }
    function hydrateRichContent() {}
    function visibleTranscriptRole(role) { return role; }
  `;
  const code = source
    .replace(/import[^\n]+\n/g, "")
    .replace("await init();", "")
    .replace(/export\s+/g, "");
  const module = await import(`data:text/javascript,${encodeURIComponent(`${harness}\n${code}\nexport { formatContextUsage };`)}`);

  const text = module.formatContextUsage({
    messageTokens: 20000,
    promptMessageTokens: 21000,
    promptTokens: 40000,
    providerPromptTokens: 39000,
    maxTokens: 200000
  });

  assert.equal(text, "20k / 200k · 10% · 输入 40k");
});

test("dashboard running send button exposes interrupt action", async () => {
  const appPath = path.resolve("src/dashboard/public/app.js");
  const source = await fs.readFile(appPath, "utf8");

  assert.match(source, /els\.sendButton\.textContent = "中断"/);
  assert.match(source, /els\.sendButton\.title = "点击中断当前任务"/);
});

test("dashboard app keeps directory paths when linkifying file references", async () => {
  const appPath = path.resolve("src/dashboard/public/app.js");
  const source = await fs.readFile(appPath, "utf8");
  const harness = `
    const document = {
      querySelector() {
        return {
          addEventListener() {},
          classList: { add() {}, remove() {}, toggle() {} },
          dataset: {},
          textContent: "",
          innerHTML: "",
          append() {},
          replaceChildren() {},
          querySelectorAll() { return []; },
          querySelector() { return null; }
        };
      },
      addEventListener() {},
      createTreeWalker(root) {
        const nodes = root.nodes;
        let index = -1;
        return {
          get currentNode() { return nodes[index]; },
          nextNode() {
            index += 1;
            return index < nodes.length;
          }
        };
      },
      createDocumentFragment() {
        return { children: [], append(value) { this.children.push(value); } };
      },
      createElement(tag) {
        return {
          tag,
          className: "",
          type: "",
          dataset: {},
          textContent: "",
          children: [],
          append(value) { this.children.push(value); }
        };
      },
      createTextNode(text) {
        return { nodeType: 3, textContent: text };
      }
    };
    const NodeFilter = { SHOW_TEXT: 4, FILTER_REJECT: 0, FILTER_ACCEPT: 1 };
    const window = {};
    const navigator = { clipboard: { writeText() {} } };
    const requestAnimationFrame = () => {};
    class EventSource {}
  `;
  const code = source
    .replace(/import[^\n]+\n/g, "")
    .replace("await init();", "")
    .replace(/export\s+/g, "");
  const module = await import(`data:text/javascript,${encodeURIComponent(`${harness}\n${code}\nexport { replaceFileReferences };`)}`);
  const textNode = {
    nodeValue: "请看 reports/round-1/final.md、images/chart.png 和 example.com",
    parentElement: { closest: () => null },
    replaced: null,
    replaceWith(value) { this.replaced = value; }
  };

  module.replaceFileReferences(textNode, "reports/round-1");

  const buttons = textNode.replaced.children.filter((item) => item.tag === "button");
  assert.deepEqual(buttons.map((button) => button.dataset.file), [
    "reports/round-1/final.md",
    "reports/round-1/images/chart.png"
  ]);
});

test("dashboard app folds assistant drafts after the final answer", async () => {
  const source = await fs.readFile(path.resolve("src/dashboard/public/app.js"), "utf8");

  assert.match(source, /if \(event\.type === "assistant_final"\) \{/);
  assert.match(source, /collapseAssistantDrafts\(event\.text\)/);
  assert.match(source, /<span>思考过程<\/span>/);
  assert.match(source, /已收起 · \$\{visibleDrafts\.length\} 轮/);
  assert.match(source, /已收起 · 已汇入最终回复/);
  assert.match(source, /draft-summary-note/);
  assert.match(source, /本轮流式草稿已合并到最终回复，没有额外过程内容。/);
  assert.match(source, /renderMessageText\(body, draft\.text, \{ markdown: true, lightweight: true \}\)/);
  assert.match(source, /isDuplicateDraftText\(draft\.text, finalText\)/);
  assert.doesNotMatch(source, /draft-summary\.js/);
});

test("dashboard app guards replayed events from appending duplicate final messages", async () => {
  const source = await fs.readFile(path.resolve("src/dashboard/public/app.js"), "utf8");

  assert.match(source, /processedEventIds: new Set\(\)/);
  assert.match(source, /shouldSkipDashboardEvent\(payload\)/);
  assert.match(source, /state\.processedEventIds\.has\(id\)/);
  assert.match(source, /lastAssistantFinalSignature/);
  assert.match(source, /state\.lastAssistantFinalSignature === finalSignature/);
});

test("dashboard app keeps event streams and drafts scoped to the active turn", async () => {
  const source = await fs.readFile(path.resolve("src/dashboard/public/app.js"), "utf8");

  assert.match(source, /eventSourceSessionId/);
  assert.match(source, /lastEventSequence/);
  assert.match(source, /ensureEventsConnected\(result\.sessionId\)/);
  assert.match(source, /params\.set\("after", String\(state\.lastEventSequence\)\)/);
  assert.match(source, /function beginEventTurn\(event\)/);
  assert.match(source, /collapseAssistantDrafts\(\)/);
  assert.match(source, /const roundKey = `\$\{turnKey\}:\$\{Number\.isFinite\(event\.round\)/);
});

test("dashboard app exposes session actions and reconnects active sessions", async () => {
  const source = await fs.readFile(path.resolve("src/dashboard/public/app.js"), "utf8");
  const html = await fs.readFile(path.resolve("src/dashboard/public/index.html"), "utf8");
  const css = await fs.readFile(path.resolve("src/dashboard/public/styles.css"), "utf8");

  assert.match(source, /data-action="delete"/);
  assert.match(source, /data-action="copy-id"/);
  assert.match(html, /id="collapse-sidebar"/);
  assert.match(source, /sidebarCollapsed: false/);
  assert.match(source, /function toggleSidebar\(\)/);
  assert.match(source, /document\.body\.classList\.toggle\("sidebar-collapsed"/);
  assert.match(source, /function sessionStatusView\(session\)/);
  assert.match(source, /thread-status-dot/);
  assert.match(source, /thread-status-badge/);
  assert.match(source, /function scheduleSessionsRefresh\(delayMs = 800\)/);
  assert.match(source, /sessionsNeedRefresh\(\)/);
  assert.match(source, /session\.backgroundVisible/);
  assert.match(source, /终端后台/);
  assert.match(source, /子智能体后台/);
  assert.match(css, /\.sidebar-collapsed \.app-shell\s*\{/);
  assert.match(css, /\.thread-status-badge\[data-tone="running"\]/);
  assert.match(css, /@keyframes threadPulse/);
  assert.match(source, /thread-delete-confirm/);
  assert.match(source, /确认删除这个会话/);
  assert.match(source, /setSessionsRefreshState\("loading", "刷新中"\)/);
  assert.match(source, /已刷新 \$\{state\.sessions\.length\} 个会话/);
  assert.match(source, /handleTranscriptScroll/);
  assert.match(source, /loadOlderTranscript/);
  assert.match(source, /\/transcript\?\$\{new URLSearchParams/);
  assert.match(source, /previousTop \+ delta/);
  assert.match(source, /加载更早记录/);
  assert.match(source, /CURRENT_SESSION_STORAGE_KEY/);
  assert.match(source, /await restoreInitialSession\(\)/);
  assert.match(source, /initialSessionId\(\) \|\| latestBackgroundSessionId\(\)/);
  assert.match(source, /function latestBackgroundSessionId\(\)/);
  assert.match(source, /window\.localStorage\?\.setItem\(CURRENT_SESSION_STORAGE_KEY, id\)/);
  assert.match(source, /function copySessionId\(sessionId\)/);
  assert.match(source, /function deleteSession\(sessionId\)/);
  assert.match(source, /method: "DELETE"/);
  assert.match(source, /const hasBackground = restoreBackgroundSnapshot\(result\.session\.backgroundSnapshot\)/);
  assert.match(source, /result\.session\.active && result\.session\.running/);
  assert.match(source, /result\.session\.active && hasBackground/);
  assert.match(source, /rememberEventCursor\(result\.session\.eventCursor\)/);
  assert.match(source, /ensureEventsConnected\(id\)/);
});

test("dashboard app enters running state immediately after turn start response", async () => {
  const source = await fs.readFile(path.resolve("src/dashboard/public/app.js"), "utf8");

  assert.match(source, /state\.running = result\.running === true \|\| state\.running/);
  assert.match(source, /if \(result\.running === true\) \{/);
  assert.match(source, /els\.runStatus\.textContent = "运行中"/);
  assert.match(source, /setLiveTitle\("正在处理你的任务"\)/);
});

test("dashboard app labels approximate change stats when present", async () => {
  const source = await fs.readFile(path.resolve("src/dashboard/public/app.js"), "utf8");

  assert.match(source, /approximate: false/);
  assert.match(source, /stats\.approximate \? "近似" : null/);
});

test("dashboard message surfaces constrain long draft and final content", async () => {
  const css = await fs.readFile(path.resolve("src/dashboard/public/styles.css"), "utf8");

  assert.match(css, /\.transcript\s*\{[^}]*overflow-x: hidden;/s);
  assert.match(css, /\.message,\s*\.activity-card,\s*\.context-boundary,\s*\.workflow-panel\s*\{[^}]*width: min\(100%, 860px\);/s);
  assert.match(css, /\.message\s*\{[^}]*overflow: hidden;/s);
  assert.match(css, /\.message-body\s*\{[^}]*overflow-wrap: anywhere;/s);
  assert.match(css, /\.message-body\.markdown-body,\s*\.markdown-body\s*\{[^}]*overflow-wrap: anywhere;/s);
  assert.match(css, /\.markdown-body > \*\s*\{[^}]*max-width: 100%;[^}]*min-width: 0;/s);
  assert.match(css, /\.md-code-frame\s*\{[^}]*max-width: 100%;[^}]*min-width: 0;[^}]*overflow: auto;/s);
  assert.match(css, /\.md-draft-plain\s*\{[^}]*max-width: 100%;[^}]*min-width: 0;[^}]*overflow: auto;/s);
  assert.match(css, /\.md-table-wrap\s*\{[^}]*max-width: 100%;[^}]*min-width: 0;[^}]*overflow: auto;/s);
  assert.match(css, /\.draft-summary\s*\{[^}]*width: min\(100%, 860px\);/s);
  assert.match(css, /\.draft-summary-item\s*\{[^}]*min-width: 0;[^}]*overflow: hidden;/s);
});

test("dashboard renders context compaction as a transcript divider", async () => {
  const app = await fs.readFile(path.resolve("src/dashboard/public/app.js"), "utf8");
  const events = await fs.readFile(path.resolve("src/dashboard/events.js"), "utf8");
  const css = await fs.readFile(path.resolve("src/dashboard/public/styles.css"), "utf8");

  assert.match(app, /event\.type === "context_boundary"/);
  assert.match(app, /appendContextBoundary\(event\)/);
  assert.match(app, /role", "separator"/);
  assert.match(app, /聊天内容已压缩，以下回复基于压缩后的上下文继续/);
  assert.match(events, /正在压缩上下文/);
  assert.match(css, /\.context-boundary\s*\{/);
  assert.match(css, /\.context-boundary-line\s*\{/);
  assert.match(css, /\.context-boundary-label\s*\{/);
});

test("dashboard keeps background subagent status visible after the main turn ends", async () => {
  const app = await fs.readFile(path.resolve("src/dashboard/public/app.js"), "utf8");
  const events = await fs.readFile(path.resolve("src/dashboard/events.js"), "utf8");
  const css = await fs.readFile(path.resolve("src/dashboard/public/styles.css"), "utf8");

  assert.match(events, /subagent_group_started/);
  assert.match(events, /subagent_group_progress/);
  assert.match(events, /subagent_group_wakeup/);
  assert.match(events, /background_terminal_registered/);
  assert.match(events, /backgroundSubagent: true/);
  const sessions = await fs.readFile(path.resolve("src/dashboard/sessions.js"), "utf8");
  assert.match(sessions, /startsWith\("background_terminal_"\)/);
  assert.match(app, /backgroundSubagents: new Map\(\)/);
  assert.match(app, /liveStatusExpanded: false/);
  assert.match(app, /isBackgroundSubagentActivity\(event\)/);
  assert.match(app, /handleBackgroundSubagentActivity\(event\)/);
  assert.match(app, /function restoreBackgroundSnapshot\(snapshot\)/);
  assert.match(app, /reconcileBackgroundSubagentSnapshot\(snapshot\.groups\)/);
  assert.match(app, /event\.type === "wakeup_queued"/);
  assert.match(app, /clearBackgroundSubagentStatus\(event\.groupId\)/);
  assert.match(app, /resetLiveStatus\(\{ keepBackgroundSubagents: true \}\)/);
  assert.match(app, /applyIdleRunStatus\("空闲"\)/);
  assert.match(app, /applyIdleRunStatus\("完成"\)/);
  assert.match(app, /const subagents = items\.filter\(\(item\) => item\.kind !== "terminal"\)/);
  assert.match(app, /terminalStarting: terminals\.filter\(\(item\) => item\.status === "starting"\)\.length/);
  assert.match(app, /terminals: terminals\.filter\(\(item\) => item\.status === "running"\)\.length/);
  assert.match(app, /return "终端后台任务启动中"/);
  assert.match(app, /return "终端后台任务运行中"/);
  assert.match(app, /return "终端后台任务回收中"/);
  assert.match(app, /return "子智能体运行中"/);
  assert.match(app, /return "等待子智能体唤醒"/);
  assert.match(app, /return "子智能体疑似失联"/);
  assert.match(app, /return "子智能体无进展"/);
  assert.match(app, /toggleLiveStatusDetails/);
  assert.match(app, /live-subagent-row/);
  assert.match(app, /cancelBackgroundSubagent/);
  assert.match(app, /\/api\/background-subagents\/cancel/);
  assert.match(app, /data-background-cancel="true"/);
  assert.match(css, /\.live-status\.has-background-subagents/);
  assert.match(css, /\.live-status\.expanded \.live-subtasks/);
  assert.match(css, /\.live-subagent-row\s*\{/);
  assert.match(css, /\.background-subagent-chip\.stale \.chip-pulse/);
  assert.match(css, /\.background-subagent-chip\.lost \.chip-pulse/);
  assert.match(css, /\.live-subagent-cancel\s*\{/);
});

test("dashboard composer controls keep confirmations compact and critical status visible", async () => {
  const app = await fs.readFile(path.resolve("src/dashboard/public/app.js"), "utf8");
  const html = await fs.readFile(path.resolve("src/dashboard/public/index.html"), "utf8");
  const css = await fs.readFile(path.resolve("src/dashboard/public/styles.css"), "utf8");
  const questionRender = app.slice(app.indexOf("function renderQuestionPanel()"), app.indexOf("function questionChoiceButton"));
  const questionReadPane = questionRender.slice(
    questionRender.indexOf('<div class="question-read-pane">'),
    questionRender.indexOf('<div class="question-actions">')
  );
  const queueRender = app.slice(app.indexOf("function renderQueuePanel()"), app.indexOf("function renderQueueItem"));

  assert.match(app, /<span class="model-status-caret" aria-hidden="true">▾<\/span>/);
  assert.ok(html.indexOf('id="question-panel"') < html.indexOf('id="live-status"'));
  assert.ok(html.indexOf('id="approval-panel"') < html.indexOf('id="live-status"'));
  assert.match(app, /function revealInteractionPanel\(panel, focusSelector\)/);
  assert.match(app, /showApproval[\s\S]*revealInteractionPanel\(els\.approvalPanel, "button\[data-action\]"\)/);
  assert.match(app, /showQuestion[\s\S]*revealInteractionPanel\(els\.questionPanel, "\.question-input, button\[data-choice\], button\[data-action='submit'\]"\)/);
  assert.match(app, /scrollIntoView\?\.\(\{ block: "nearest", inline: "nearest" \}\)/);
  assert.match(app, /focus\(\{ preventScroll: true \}\)/);
  assert.match(questionRender, /<div class="question-read-pane">[\s\S]*question-copy[\s\S]*question-input[\s\S]*<div class="question-actions">/);
  assert.match(questionReadPane, /question-title/);
  assert.match(questionReadPane, /question-copy/);
  assert.match(questionReadPane, /question-input/);
  assert.doesNotMatch(css, /\.question-layout\s*\{/);
  assert.match(css, /\.question-read-pane\s*\{[^}]*max-height: 96px;[^}]*overflow-y: auto;/s);
  assert.doesNotMatch(css, /\.question-copy-window\s*\{/);
  assert.doesNotMatch(css, /\.question-scroll\s*\{/);
  assert.match(css, /\.question-actions\s*\{[^}]*justify-content: space-between;/s);
  assert.match(css, /\.question-prompt-summary\s*\{[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/s);
  assert.match(css, /\.question-input\s*\{[^}]*min-height: 58px;/s);
  assert.match(css, /\.question-action-buttons\s*\{/);
  assert.doesNotMatch(css, /\.question-panel\s*\{[^}]*overflow: auto;/s);
  assert.doesNotMatch(css, /\.question-choices\s*\{[^}]*overflow-y: auto;/s);
  assert.match(css, /\.context-actions #context-clear\s*\{[^}]*border-color: rgba\(255, 133, 133, 0\.42\);[^}]*color: var\(--danger\);/s);
  assert.match(css, /\.model-status-caret-button\s*\{[^}]*background: rgba\(255, 255, 255, 0\.08\) !important;[^}]*border-color: rgba\(213, 215, 212, 0\.2\) !important;/s);
  assert.match(css, /\.model-status-caret-button\[aria-expanded="true"\]\s*\{/);
  assert.match(css, /\.composer-footer \.change-status \.change-add\s*\{[^}]*color: #8fce9c !important;/s);
  assert.match(css, /\.composer-footer \.change-status \.change-del\s*\{[^}]*color: #ff9b9b !important;/s);
  assert.match(html, /<div class="mode-row">[\s\S]*<div class="mode-description" id="mode-description">[\s\S]*<div class="context-actions">/);
  assert.match(html, /<textarea id="prompt-input" rows="2"/);
  assert.match(css, /\.mode-row\s*\{[^}]*margin: 0 auto 8px;/s);
  assert.match(css, /\.mode-description\s*\{[^}]*flex: 1 1 220px;[^}]*text-align: right;[^}]*white-space: nowrap;/s);
  assert.match(css, /#prompt-input\s*\{[^}]*height: 52px;[^}]*min-height: 52px;/s);
  assert.match(css, /\.attach-button\s*\{[^}]*height: 52px;/s);
  assert.match(css, /#send-button\s*\{[^}]*height: 52px;/s);
  assert.match(queueRender, /<div class="queue-summary">[\s\S]*<div class="queue-title">[\s\S]*<div class="queue-copy">/);
  assert.match(css, /\.queue-summary\s*\{[^}]*display: flex;[^}]*gap: 10px;/s);
  assert.match(css, /\.queue-copy\s*\{[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/s);
  assert.doesNotMatch(app, /引导队首/);
  assert.match(app, /function guideButtonVisible\(\)/);
  assert.match(app, /class="\$\{guideButtonVisible\(\) \? "" : "hidden"\}"/);
  assert.match(app, /return "引导对话"/);
  assert.doesNotMatch(app, /state\.queue\.find\(\(item\) => item\.kind !== "guide" && !state\.queueCancelling\.has\(item\.id\)\)/);
  assert.match(app, /gatewayProfiles: \[\]/);
  assert.match(app, /normalizeGatewayProfiles\(status\.gatewayProfiles\)/);
  assert.match(app, /data-profile-id/);
  assert.match(app, /postJson\("\/api\/gateway-profile"/);
  assert.match(app, /data-action="delete-model"/);
  assert.match(app, /data-action="edit-current-model"/);
  assert.match(app, /data-action="edit-model"/);
  assert.match(app, /previousModelId: state\.editingModelId/);
  assert.match(app, /showNotice\(result\.clearedGateway \? "当前网关配置已清空" : "模型配置已删除"\)/);
  assert.match(app, /这是当前网关最后一个模型，会清空当前网关配置/);
  assert.match(app, /deleteJson\(`\/api\/model-config\/\$\{encodeURIComponent\(modelId\)\}`/);
  assert.match(app, /event\.stopPropagation\(\);[\s\S]*const action = event\.target\.closest\("button\[data-action\]"\);/);
  assert.match(app, /model-delete-confirm-copy/);
  assert.match(css, /\.gateway-profile-list\s*\{/);
  assert.match(css, /\.model-panel-actions\s*\{/);
  assert.match(css, /\.model-option-row\s*\{[^}]*grid-template-areas: "model edit delete";[^}]*grid-template-columns: minmax\(0, 1fr\) auto auto;/s);
  assert.match(css, /\.model-option-row\.confirming-delete\s*\{[^}]*grid-template-areas:/s);
  assert.match(css, /\.model-edit-button,\s*\.model-delete-button\s*\{/);
  assert.match(css, /\.model-edit-button\s*\{[^}]*grid-area: edit;/s);
  assert.match(css, /\.model-delete-button\s*\{[^}]*min-width: 62px;[^}]*white-space: nowrap;/s);
  assert.match(css, /\.model-delete-button\.confirm\s*\{/);
  assert.match(css, /\.model-delete-confirm-copy\s*\{/);
});

test("dashboard renders lightweight office previews in the side panel", async () => {
  const app = await fs.readFile(path.resolve("src/dashboard/public/app.js"), "utf8");
  const css = await fs.readFile(path.resolve("src/dashboard/public/styles.css"), "utf8");

  assert.match(app, /file\.kind === "office-preview"/);
  assert.match(app, /file\.kind === "table-preview"/);
  assert.match(app, /function renderOfficePreview\(file\)/);
  assert.match(app, /function renderTablePreview\(file\)/);
  assert.match(app, /function showTableLightbox\(file\)/);
  assert.match(app, /function renderExpandedTableHtml\(table, activeIndex = 0\)/);
  assert.match(app, /tableLightboxSheetIndex/);
  assert.match(app, /data-sheet-index/);
  assert.match(app, /table-sheet-rail/);
  assert.doesNotMatch(app, /expanded-sheet-tabs/);
  assert.doesNotMatch(app, /table-sheet-tabs/);
  assert.match(app, /Excel 轻量预览/);
  assert.match(app, /data-mode.*table/s);
  assert.match(css, /\.office-preview\s*\{[^}]*grid-template-rows: auto minmax\(0, 1fr\) auto;/s);
  assert.match(css, /\.table-preview-button\s*\{[^}]*cursor: zoom-in;/s);
  assert.match(css, /\.table-viewer\.has-sheets\s*\{[^}]*grid-template-columns: minmax\(88px, 128px\) minmax\(0, 1fr\);/s);
  assert.match(css, /\.table-sheet-rail\s*\{/);
  assert.match(css, /\.lightbox-table\s*\{[^}]*overflow: auto;/s);
  assert.match(css, /\.expanded-table-scroll\s*\{[^}]*overflow: auto;/s);
  assert.doesNotMatch(css, /\.expanded-sheet-tabs\s*\{/);
  assert.doesNotMatch(css, /\.table-sheet-tabs\s*\{/);
});
