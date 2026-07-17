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
  const collapseSource = source.slice(source.indexOf("function collapseAssistantDrafts"), source.indexOf("function isMeaningfulCompletedActivity"));

  assert.match(source, /if \(event\.type === "assistant_final"\) \{/);
  assert.match(source, /collapseAssistantDrafts\(event\.text\)/);
  assert.match(source, /<span>思考过程<\/span>/);
  assert.match(source, /已收起 · \$\{visibleDrafts\.length\} 轮/);
  assert.match(source, /已收起 · 已汇入最终回复/);
  assert.match(source, /draft-summary-note/);
  assert.match(source, /本轮流式草稿已合并到最终回复，没有额外过程内容。/);
  assert.match(collapseSource, /body\.className = "message-body draft-plain-text"/);
  assert.match(collapseSource, /body\.textContent = draft\.text/);
  assert.doesNotMatch(collapseSource, /renderMessageText\(/);
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
  assert.match(source, /const showStatusBadge = \["running", "waiting", "warning", "error"\]\.includes\(status\.tone\)/);
  assert.match(source, /function scheduleSessionsRefresh\(delayMs = 800\)/);
  assert.match(source, /sessionsNeedRefresh\(\)/);
  assert.match(source, /session\.backgroundVisible/);
  assert.match(source, /终端后台/);
  assert.match(source, /子智能体后台/);
  assert.match(css, /\.sidebar-collapsed \.app-shell\s*\{/);
  assert.match(css, /\.thread-status-dot\s*\{[^}]*display: none;/s);
  assert.match(css, /\.sidebar-collapsed \.thread-status-dot\s*\{[^}]*display: inline-block;/s);
  assert.match(css, /\.thread-status-badge\[data-tone="running"\]\s*\{[^}]*background: rgba\(120, 160, 130, 0\.09\);[^}]*color: #b8c7bc;/s);
  assert.doesNotMatch(css, /@keyframes threadPulse/);
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

test("dashboard app guards duplicate turn submission and scopes permission by session", async () => {
  const source = await fs.readFile(path.resolve("src/dashboard/public/app.js"), "utf8");
  const sendPromptSource = source.slice(source.indexOf("async function sendPrompt()"), source.indexOf("async function interruptTurn()"));
  const newTaskSource = source.slice(source.indexOf("function newTask()"), source.indexOf("async function addAttachmentFiles"));

  assert.match(source, /turnSubmitting: false/);
  assert.match(sendPromptSource, /if \(state\.turnSubmitting\) \{\s*return;\s*\}/);
  assert.match(sendPromptSource, /state\.turnSubmitting = true/);
  assert.match(sendPromptSource, /finally \{\s*state\.turnSubmitting = false;\s*updateSendButton\(\)/);
  assert.match(source, /if \(state\.turnSubmitting\) \{\s*els\.sendButton\.textContent = "提交中";[\s\S]*els\.sendButton\.disabled = true/);
  assert.match(source, /setPermissionMode\(result\.session\.permission\?\.mode \?\? "plan"\)/);
  assert.match(source, /state\.running = result\.session\.active === true && result\.session\.running === true/);
  assert.match(newTaskSource, /setPermissionMode\("plan"\)/);
  assert.match(newTaskSource, /state\.running = false/);
  assert.match(newTaskSource, /updateSendButton\(\)/);
  assert.match(source, /if \(event\.permission\?\.mode\) \{\s*setPermissionMode\(event\.permission\.mode\)/);
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
  assert.match(app, /terminals: terminals\.filter\(\(item\) => item\.status === "running" \|\| item\.status === "cancelling"\)\.length/);
  assert.match(app, /return "终端后台任务启动中"/);
  assert.match(app, /return "终端后台任务退出确认中"/);
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

test("dashboard composer controls keep confirmations reviewable and critical status visible", async () => {
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
  assert.match(css, /\.question-read-pane\s*\{[^}]*max-height: min\(58dvh, 520px\);[^}]*overflow-y: auto;/s);
  assert.match(css, /\.question-panel\.modal-interaction\s*\{[^}]*height: min\(620px, calc\(100dvh - 48px\)\);[^}]*width: min\(820px, calc\(100vw - 32px\)\);/s);
  assert.match(app, /data-action="review-conversation">查看对话<\/button>/);
  assert.match(app, /function reviewQuestionConversation\(\)[\s\S]*deactivateModal\(els\.questionPanel, \{ restoreFocus: false \}\)[\s\S]*activateQuestionReviewBackground\(\)[\s\S]*els\.transcript\?\.focus/);
  assert.match(app, /function returnToQuestion\(\)[\s\S]*deactivateQuestionReviewBackground\(\)[\s\S]*activateModal\(els\.questionPanel/);
  assert.match(app, /function activateQuestionReviewBackground\(\)[\s\S]*transcriptStage[\s\S]*entry\.node\.inert = true/);
  assert.match(css, /\.question-panel\.question-reviewing\s*\{/);
  assert.match(css, /\.question-review-bar\s*\{/);
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

test("dashboard responsive, composer, focus, and scroll helpers enforce UI behavior", async () => {
  const source = await fs.readFile(path.resolve("src/dashboard/public/app.js"), "utf8");
  const harness = `
    const fakeElement = {
      addEventListener() {},
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      dataset: {},
      style: {},
      textContent: "",
      innerHTML: "",
      append() {},
      replaceChildren() {},
      querySelectorAll() { return []; },
      querySelector() { return null; },
      setAttribute() {},
      getAttribute() { return null; },
      hasAttribute() { return false; },
      removeAttribute() {}
    };
    const document = {
      querySelector() { return { ...fakeElement }; },
      addEventListener() {},
      documentElement: { clientWidth: 1440, style: { setProperty() {} } },
      body: { ...fakeElement, children: [] },
      activeElement: null
    };
    const window = {};
    const navigator = { clipboard: { writeText() {} } };
    const requestAnimationFrame = () => {};
    class EventSource {}
  `;
  const code = source
    .replace(/import[^\n]+\n/g, "")
    .replace("await init();", "");
  const module = await import(`data:text/javascript,${encodeURIComponent(`${harness}\n${code}`)}`);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => ({
    ok: true,
    status: 200,
    text() {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const error = new Error("aborted body");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    }
  });
  try {
    await assert.rejects(
      module.dashboardFetch("/stalled-json", {}, { timeoutMs: 10 }),
      (error) => error.code === "DASHBOARD_REQUEST_TIMEOUT"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(module.normalizedResponsiveView(1440, "files"), "conversation");
  assert.equal(module.normalizedResponsiveView(1024, "sessions"), "sessions");
  assert.equal(module.normalizedResponsiveView(768, "files"), "files");
  assert.equal(module.normalizedResponsiveView(390, "conversation"), "conversation");
  assert.equal(module.normalizedResponsiveView(320, "unknown"), "conversation");

  assert.equal(module.composerHeightFor(18), 52);
  assert.equal(module.composerHeightFor(104), 104);
  assert.equal(module.composerHeightFor(420), 160);

  assert.deepEqual(module.previewWidthBounds(1200, false), { min: 300, max: 360 });
  assert.deepEqual(module.previewWidthBounds(1280, false), { min: 300, max: 440 });
  assert.deepEqual(module.previewWidthBounds(1440, false), { min: 300, max: 600 });
  assert.deepEqual(module.previewWidthBounds(1440, true), { min: 300, max: 640 });
  assert.equal(module.clampedPreviewWidth(200, { min: 300, max: 600 }), 300);
  assert.equal(module.clampedPreviewWidth(540, { min: 300, max: 600 }), 540);
  assert.equal(module.clampedPreviewWidth(900, { min: 300, max: 600 }), 600);

  assert.equal(module.permissionIndexForKey(0, "ArrowLeft", 3), 2);
  assert.equal(module.permissionIndexForKey(2, "ArrowRight", 3), 0);
  assert.equal(module.permissionIndexForKey(1, "Home", 3), 0);
  assert.equal(module.permissionIndexForKey(1, "End", 3), 2);

  const first = { id: "first" };
  const middle = { id: "middle" };
  const last = { id: "last" };
  const focusables = [first, middle, last];
  assert.equal(module.focusTrapTarget(focusables, last, false), first);
  assert.equal(module.focusTrapTarget(focusables, first, true), last);
  assert.equal(module.focusTrapTarget(focusables, {}, false), first);

  assert.equal(module.shouldFollowTranscript({ following: false, wasAtBottom: false }), false);
  assert.equal(module.shouldFollowTranscript({ following: true, onlyIfNearBottom: true, wasAtBottom: false }), false);
  assert.equal(module.shouldFollowTranscript({ following: true, onlyIfNearBottom: true, wasAtBottom: true }), true);
  assert.equal(module.shouldFollowTranscript({ force: true, following: false, wasAtBottom: false }), true);

  const activity = module.normalizeLifecycleActivity({
    sessions: 2,
    activeTurns: 1,
    queuedTurns: 3,
    backgroundTasks: 2,
    pendingInteractions: 1
  });
  assert.equal(activity.total, 7);
  assert.deepEqual(module.shutdownRequestBody(activity), { cancel: true });
  assert.deepEqual(module.shutdownRequestBody({ ...activity, uncertain: true }), {
    cancel: true,
    force: true,
    timeoutMs: 15_000
  });
  assert.deepEqual(module.shutdownRequestBody({ total: 0 }), {});
  assert.equal(module.shutdownResultIsClosed({ ok: false, status: 409 }), false);
  assert.equal(module.shutdownResultIsClosed({ ok: true }), true);

  const holder = { frame: null };
  const scheduled = [];
  let frameRuns = 0;
  const scheduler = (callback) => {
    scheduled.push(callback);
    return scheduled.length;
  };
  for (let index = 0; index < 200; index += 1) {
    module.scheduleAnimationFrameOnce(holder, "frame", () => { frameRuns += 1; }, scheduler);
  }
  assert.equal(scheduled.length, 1);
  scheduled.shift()();
  assert.equal(frameRuns, 1);
  assert.equal(holder.frame, null);

  const cancelled = [];
  holder.frame = 42;
  assert.equal(module.cancelScheduledAnimationFrame(holder, "frame", (frame) => cancelled.push(frame)), true);
  assert.deepEqual(cancelled, [42]);
  assert.equal(holder.frame, null);

  const draftBody = {
    nodes: [],
    append(node) { this.nodes.push(node); }
  };
  const fiftyThousandCharacters = "0123456789".repeat(5000);
  const renderedLength = module.appendPlainDraftDelta(
    draftBody,
    fiftyThousandCharacters,
    0,
    (text) => ({ textContent: text })
  );
  assert.equal(renderedLength, 50000);
  assert.equal(draftBody.nodes.length, 1);
  assert.equal(draftBody.nodes[0].textContent.length, 50000);

  let finalRenderCount = 0;
  let finalRenderOptions = null;
  module.renderFinalAssistantBody({}, "# 最终回复", (_body, _text, options) => {
    finalRenderCount += 1;
    finalRenderOptions = options;
  });
  assert.equal(finalRenderCount, 1);
  assert.deepEqual(finalRenderOptions, { markdown: true });

  const transcriptNodes = Array.from({ length: 503 }, (_value, index) => ({ index }));
  const protectedNodes = new Set([transcriptNodes[0], transcriptNodes[250], transcriptNodes[502]]);
  const removeFromOlderEnd = module.selectTranscriptNodesToRemove(
    transcriptNodes,
    300,
    "append",
    (node) => protectedNodes.has(node)
  );
  const removeFromNewerEnd = module.selectTranscriptNodesToRemove(
    transcriptNodes,
    300,
    "prepend",
    (node) => protectedNodes.has(node)
  );
  assert.equal(transcriptNodes.length - removeFromOlderEnd.length, 300);
  assert.equal(transcriptNodes.length - removeFromNewerEnd.length, 300);
  assert.ok(removeFromOlderEnd.every((node) => !protectedNodes.has(node)));
  assert.ok(removeFromNewerEnd.every((node) => !protectedNodes.has(node)));
  assert.ok(removeFromOlderEnd[0].index < removeFromOlderEnd.at(-1).index);
  assert.ok(removeFromNewerEnd[0].index > removeFromNewerEnd.at(-1).index);
});

test("dashboard exposes responsive navigation and accessible interaction semantics", async () => {
  const app = await fs.readFile(path.resolve("src/dashboard/public/app.js"), "utf8");
  const html = await fs.readFile(path.resolve("src/dashboard/public/index.html"), "utf8");
  const css = await fs.readFile(path.resolve("src/dashboard/public/styles.css"), "utf8");

  assert.match(html, /id="responsive-navigation"[\s\S]*data-dashboard-view="sessions"[\s\S]*data-dashboard-view="conversation"[\s\S]*data-dashboard-view="files"/);
  assert.match(html, /id="transcript" role="log" aria-live="off"/);
  assert.match(html, /id="dashboard-live-region" role="status" aria-live="polite"/);
  assert.match(html, /id="permission-mode" role="radiogroup"/);
  assert.match(html, /id="preview-resize-handle" role="separator"[^>]*aria-orientation="vertical"/);
  assert.match(html, /role="radio" aria-checked="true"/);
  assert.match(html, /<label class="visually-hidden" for="prompt-input">/);
  assert.match(html, /id="activity-toggle"[\s\S]*aria-expanded="false"/);
  assert.match(app, /function activateModal\(/);
  assert.match(app, /function deactivateModal\(/);
  assert.match(app, /function beginPreviewResize\(/);
  assert.match(app, /PREVIEW_WIDTH_STORAGE_KEY/);
  assert.match(app, /entry\.node\.inert = true/);
  assert.match(app, /event\.key === "Escape"/);
  assert.match(app, /aria-checked/);
  assert.match(app, /newReplyAvailable \? "有新回复" : "回到底部"/);
  assert.match(app, /getJson\("\/api\/lifecycle\/status"\)/);
  assert.match(app, /const requestTimedOut = result\?\.code === "DASHBOARD_REQUEST_TIMEOUT"/);
  assert.match(app, /const EVENT_CONNECT_TIMEOUT_MS = 10_000/);
  assert.match(app, /armEventConnectTimer\(source, sessionId\)/);
  assert.match(app, /markEventConnectionAlive\(false\)/);
  assert.match(app, /markEventConnectionAlive\(true\)/);
  assert.match(app, /if \(!feedback && state\.sessionsLoading\)/);
  assert.match(app, /event\.type === "session_disposed"/);
  assert.match(app, /if \(!shutdownResultIsClosed\(result\)\)/);
  assert.match(app, /state\.shutdownActivity\.total > 0 \? "重试取消并关闭" : "重试关闭"/);
  assert.doesNotMatch(app, /els\.modelStatus\.setAttribute\("aria-expanded"/);
  assert.match(app, /id="model-status-toggle"[\s\S]*aria-expanded="\$\{state\.modelPanelOpen \? "true" : "false"\}"/);
  const draftSource = app.slice(app.indexOf("function appendAssistantDraft"), app.indexOf("function appendActivity"));
  const scrollSource = app.slice(app.indexOf("function scrollTranscript"), app.indexOf("function isTranscriptNearBottom"));
  assert.match(draftSource, /scheduleAnimationFrameOnce\(draft, "renderFrame"/);
  assert.match(draftSource, /appendPlainDraftDelta\(draft\.body, draft\.text, draft\.renderedLength\)/);
  assert.doesNotMatch(draftSource, /renderMessageText\(|renderMarkdown\(|setTimeout\(/);
  assert.match(scrollSource, /scheduleAnimationFrameOnce\(state, "transcriptScrollFrame"/);
  assert.doesNotMatch(scrollSource, /setTimeout\(|scrollTop = els\.transcript\.scrollHeight;[\s\S]*scrollTop = els\.transcript\.scrollHeight;/);
  assert.match(app, /const TRANSCRIPT_DOM_LIMIT = 300/);
  assert.match(app, /trimTranscriptWindow\(\{ direction: "prepend", preserveAnchor: false \}\)/);
  assert.match(app, /restoreTranscriptNodeAnchor\(anchor, anchorTop\)/);
  assert.match(app, /if \(node === els\.emptyState\) node = node\.nextSibling/);
  assert.match(app, /cancelScheduledAnimationFrame\(draft, "renderFrame"\)/);
  assert.match(css, /\.transcript-unloaded\s*\{/);
  assert.match(css, /@media \(min-width: 768px\) and \(max-width: 1199\.98px\)/);
  assert.match(css, /@media \(max-width: 767\.98px\)/);
  assert.match(css, /var\(--dashboard-viewport-height, 100dvh\)/);
  assert.match(css, /env\(safe-area-inset-bottom\)/);
  assert.match(css, /grid-template-columns: 280px minmax\(420px, 1fr\) var\(--preview-width\)/);
  assert.match(css, /\.preview-resize-handle\s*\{/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /:where\(a, button, input, select, textarea, summary, \[tabindex\]\):focus-visible/);
});
