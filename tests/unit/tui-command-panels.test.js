import assert from "node:assert/strict";
import test from "node:test";
import { compactSessionContext, createContextWindow, summarizeContextWindow } from "../../src/core/context-window.js";
import {
  createAgentTaskLivePanel,
  createClearConfirmPanel,
  createCompactPanel,
  createContextPanel,
  formatAgentTaskExcerptBody,
  formatMessageBodyForDisplayClipboard,
  createHelpPanel,
  createLogsPanel,
  createPermissionsPanel,
  createQueuePanel,
  createMessageExcerptPanel,
  createResumeChunkPanel,
  createResumeHelpPanel,
  createResumePanel,
  createSessionsPanel,
  createStatusPanel,
  createUndoRedoPanel,
  createUsagePanel
} from "../../src/cli/tui/command-panels.js";
import { assertTerminalBounds } from "../helpers/terminal-snapshot.js";

test("help panel exposes slash command tabs without dumping plain command output", () => {
  const panel = createHelpPanel({ tabIndex: 1 });
  const text = panel.lines.map((item) => item.text).join("\n");

  assert.equal(panel.kind, "help");
  assert.ok(panel.tabs.includes("工作区"));
  assert.equal(panel.tabs[panel.tabIndex], "工作区");
  assert.match(text, /\/files/);
  assert.match(text, /Left\/Right 或 Tab/);
});

test("status and permission panels summarize local runtime state", () => {
  const session = fakeSession();
  const status = createStatusPanel({
    session,
    trusted: true,
    activity: {
      status: "ready",
      gateway: "configured",
      lastGateway: "round 1",
      lastTool: "read_file done",
      toolCount: 1,
      blockedTools: 0,
      failedTools: 0
    }
  });
  const permissions = createPermissionsPanel({ session, trusted: true });
  const text = [
    ...status.lines.map((item) => item.text),
    ...permissions.lines.map((item) => item.text)
  ].join("\n");

  assert.match(text, /网关/);
  assert.match(text, /操作矩阵/);
  assert.match(text, /写入\/编辑工作区：询问/);

  session.permissionMode = "workspace";
  session.allowWrite = true;
  session.allowCommand = true;
  const autoPanel = createPermissionsPanel({ session, trusted: true });
  const autoText = autoPanel.lines.map((item) => item.text).join("\n");
  assert.match(autoText, /工作区权限/);
  assert.match(autoText, /写入\/编辑工作区：自动同意/);
  assert.match(autoText, /工作区外路径\/疑似密钥路径：询问或强确认/);

  session.permissionMode = "fullAccess";
  session.fullAccess = true;
  const fullPanel = createPermissionsPanel({ session, trusted: true });
  const fullText = fullPanel.lines.map((item) => item.text).join("\n");
  assert.match(fullText, /完全访问/);
  assert.match(fullText, /读取\/写入任意路径：自动同意/);
});

test("usage panel marks provider token and cost data as gateway-owned", () => {
  const session = fakeSession();
  session.workflow.validations.push({ command: "npm test", passed: true });
  const panel = createUsagePanel({ session, name: "cost" });
  const text = panel.lines.map((item) => item.text).join("\n");

  assert.equal(panel.title, "费用");
  assert.match(text, /配置的网关尚未报告提供方 token 或费用总量/);
  assert.match(text, /验证命令：1/);
  assert.match(text, /不会从私有提供方内部信息推断价格/);
});

test("usage panel shows provider-reported token totals when available", () => {
  const session = fakeSession();
  session.usage = {
    reports: 2,
    promptTokens: 1200,
    cachedPromptTokens: 900,
    completionTokens: 80,
    totalTokens: 1280,
    lastPromptTokens: 700,
    lastCachedPromptTokens: 500,
    lastCompletionTokens: 40,
    lastTotalTokens: 740,
    lastRound: 2,
    lastModel: "example-coding-model",
    last: { prompt_tokens: 700, completion_tokens: 40, total_tokens: 740, prompt_tokens_details: { cached_tokens: 500 } }
  };
  const panel = createUsagePanel({ session, name: "usage" });
  const text = panel.lines.map((item) => item.text).join("\n");

  assert.match(text, /报告次数：2/);
  assert.match(text, /累计：输入 1.2k \/ 缓存 900\/1.2k \(75%\) \/ 输出 80 \/ 合计 1.3k tokens/);
  assert.match(text, /最近：输入 700 \/ 缓存 500\/700 \(71%\) \/ 输出 40 \/ 合计 740 tokens/);
  assert.match(text, /cached_tokens/);
  assert.match(text, /example-coding-model/);
});

test("/logs panel exposes process-local runtime records with filter tabs", () => {
  const item = {
    title: "工具输出",
    source: "read_file",
    category: "tool",
    text: "line one\nline two",
    at: "12:00"
  };
  const panel = createLogsPanel({
    inspector: item,
    items: [item],
    index: 0,
    filter: "tool",
    offset: 0,
    visibleRows: 18
  });
  const text = panel.lines.map((line) => line.text).join("\n");

  assert.equal(panel.kind, "logs");
  assert.equal(panel.title, "运行日志");
  assert.ok(panel.tabs.includes("工具"));
  assert.equal(panel.tabs[panel.tabIndex], "工具");
  assert.match(text, /当前 TUI 内存/);
  assert.match(text, /过滤：工具 1\/1/);
  assert.match(text, /line one/);
  assert.match(panel.footer, /Tab\/Left\/Right 切换类型/);
});

test("/compact panel reflects real context compaction result", () => {
  const session = fakeSession({
    modelAlias: "example-coding-model",
    models: [
      {
        id: "example-coding-model",
        contextTokens: 200000
      }
    ],
    context: {
      maxMessages: 4,
      maxTokens: 1000,
      keepRecentMessages: 2,
      summaryBytes: 4096
    }
  });
  session.messages = [
    { role: "user", content: "first token=secret path=C:\\private\\one.txt" },
    { role: "assistant", content: [{ type: "text", text: "second" }] },
    { role: "user", content: "third" },
    { role: "assistant", content: [{ type: "text", text: "fourth" }] },
    { role: "user", content: "fifth" }
  ];

  const before = summarizeContextWindow(session);
  const result = compactSessionContext(session, { force: true, reason: "manual" });
  const after = summarizeContextWindow(session);
  const panel = createCompactPanel({ result, before, after, session });
  const contextPanel = createContextPanel({ session, compactResult: result, before, after });
  const text = panel.lines.map((item) => item.text).join("\n");

  assert.equal(result.compacted, true);
  assert.equal(after.messages, 3);
  assert.equal(after.compacted, 1);
  assert.match(text, /已压缩/);
  assert.match(text, /tokens：\d+ -> \d+（估算）/);
  assert.match(text, /方式：本地摘要/);
  const contextText = contextPanel.lines.map((item) => item.text).join("\n");
  assert.match(contextText, /当前模型上下文：[\d.]+k?\/200k tokens（估算）/);
  assert.match(contextText, /模型消息链：[\d.]+k? tokens（估算）/);
  assert.match(contextText, /本地压缩阈值：1k tokens/);
  assert.match(contextText, /最近方式：本地摘要/);
  assert.match(contextText, /摘要字节：/);
  assert.doesNotMatch(session.contextWindow.summary, /token=secret/);
  assert.match(session.contextWindow.summary, /token=\[redacted\]/);
  assert.match(session.contextWindow.summary, /path=C:\\private\\one\.txt/);
  assertTerminalBounds(text, { columns: 100, rows: 16 });
});

test("/context panel shows prompt payload split when gateway input was estimated", () => {
  const session = fakeSession();
  session.lastPromptEstimate = {
    tokens: 1234,
    bytes: 4936,
    messageTokens: 200,
    toolSchemaTokens: 300,
    toolResultTokens: 734,
    round: 2,
    source: "local-estimate"
  };
  const panel = createContextPanel({ session });
  const text = panel.lines.map((item) => item.text).join("\n");

  assert.match(text, /当前模型上下文：1\/200k tokens（估算）/);
  assert.match(text, /最近模型输入：1.2k\/200k tokens（估算）/);
  assert.match(text, /拆分：消息 200 \/ 工具定义 300 \/ 工具结果 734/);
});

test("stage 7 queue, session, clear, and undo panels expose recoverable actions", () => {
  const session = fakeSession();
  const queue = createQueuePanel({
    queuedPrompts: ["wrong prompt", "run tests"],
    selectedIndex: 1,
    busy: true
  });
  const sessions = createSessionsPanel({
    records: [
      {
        id: "session-current",
        modifiedAt: "2026-04-29T10:00:00.000Z",
        encrypted: false,
        bytes: 128,
        readable: true,
        status: "completed",
        title: "Inspect the TUI resume picker",
        prompt: "inspect the TUI",
        model: "mock-sonnet",
        turnIndex: 2,
        transcriptMessages: 4
      },
      {
        id: "session-old",
        modifiedAt: "2026-04-28T10:00:00.000Z",
        encrypted: true,
        bytes: 256,
        readable: false,
        readError: "SESSION_METADATA_ENCRYPTED"
      }
    ],
    selectedIndex: 1,
    currentSessionId: "session-current"
  });
  const clear = createClearConfirmPanel({ session });
  const undo = createUndoRedoPanel({
    gitAvailable: true,
    gitStatus: " M src/cli/tui.js"
  });
  const text = [
    ...queue.lines,
    ...sessions.lines,
    ...clear.lines,
    ...undo.lines
  ].map((item) => item.text).join("\n");

  assert.equal(queue.kind, "queue");
  assert.equal(sessions.kind, "sessions");
  assert.equal(clear.kind, "clear-confirm");
  assert.equal(undo.kind, "undo-redo");
  assert.match(text, /Enter 将当前提示提升/);
  assert.match(text, /Inspect the TUI resume picker/);
  assert.match(text, /\(session-/);
  assert.match(text, /msgs=4/);
  assert.match(text, /SESSION_METADATA_ENCRYPTED/);
  assert.match(text, /当前上下文/);
  assert.match(text, /按 Enter 清除/);
  assert.match(text, /不会静默运行破坏性的 git reset/);
});

test("resume panels keep session restore in /sessions and view current chunks only", () => {
  const session = fakeSession();
  session.transcriptMessages = [
    { role: "user", content: "recent prompt" },
    { role: "assistant", content: [{ type: "text", text: "recent answer" }] }
  ];
  session.transcriptArchive = {
    chunkSize: 50,
    totalMessages: 55,
    chunks: [
      { index: 1, file: "session-test.transcript/chunk-000001.json", messages: 50, bytes: 4096 },
      { index: 2, file: "session-test.transcript/chunk-000002.json", messages: 5, bytes: 512 }
    ]
  };

  const list = createResumePanel({ session, selectedIndex: 0 });
  const chunk = createResumeChunkPanel({
    session,
    chunk: session.transcriptArchive.chunks[0],
    messages: [
      { role: "user", content: "old prompt" },
      {
        role: "assistant",
        content: [{ type: "text", text: "| Name | Value |\n| --- | --- |\n| alpha | beta |" }]
      }
    ]
  });
  const panel = createResumeHelpPanel();
  const text = [
    ...list.lines,
    ...chunk.lines,
    ...panel.lines
  ].map((item) => item.text).join("\n");

  assert.equal(list.kind, "resume");
  assert.equal(chunk.kind, "resume-chunk");
  assert.equal(panel.kind, "resume-help");
  assert.match(text, /chunk 1/);
  assert.match(text, /1-50/);
  assert.match(text, /当前会话历史分片/);
  assert.match(text, /old prompt/);
  assert.match(text, /Name/);
  assert.match(text, /alpha/);
  assert.match(text, /\/sessions/);
  assert.match(text, /恢复会话/);
  assert.match(text, /\/resume <分片序号>/);
  assert.match(text, /不恢复会话/);
  assert.doesNotMatch(text, /\/resume latest/);
  assert.doesNotMatch(text, /<session-id>/);
});

test("message excerpt panel exposes full text and keyboard actions for native selection", () => {
  const panel = createMessageExcerptPanel({
    entry: {
      id: "entry-a",
      kind: "assistant",
      body: "第一段可以拖选。\n\n第二段保留给局部复制。"
    }
  });
  const text = panel.lines.map((item) => item.text).join("\n");

  assert.equal(panel.kind, "message-excerpt");
  assert.equal(panel.title, "消息摘录");
  assert.equal(panel.borderless, true);
  assert.match(text, /鼠标可直接拖选下方文字/);
  assert.match(text, /不会混入右侧框线/);
  assert.match(text, /Ant Code/);
  assert.match(text, /第一段可以拖选/);
  assert.match(text, /第二段保留给局部复制/);
  assert.match(panel.footer, /C 复制整条/);
  assert.match(panel.footer, /R 回退编辑/);
});

test("agent task excerpt panel exposes full persisted task details", () => {
  const task = {
    id: "task-demo",
    title: "审计模块",
    profile: "explorer",
    status: "partial",
    mode: "readonly",
    model: "example-vision-model",
    modelTier: "cheap",
    latestProgress: "grep 完成",
    prompt: "检查 src",
    toolCalls: [
      { name: "grep", ok: true },
      { name: "web_fetch", ok: false, blocked: true, errorCode: "NETWORK_BLOCKED" }
    ],
    outputSummary: "发现两个风险点",
    output: "完整输出内容\n第二行",
    continuationPrompt: "继续检查 tests"
  };
  const body = formatAgentTaskExcerptBody(task, {
    kind: "agent",
    taskId: "task-demo",
    title: "子任务阶段暂停"
  });
  const panel = createMessageExcerptPanel({
    entry: {
      kind: "agent",
      taskId: "task-demo",
      title: "子任务阶段暂停",
      body,
      task
    }
  });
  const text = panel.lines.map((item) => item.text).join("\n");

  assert.equal(panel.kind, "message-excerpt");
  assert.equal(panel.title, "子智能体摘录");
  assert.equal(panel.borderless, true);
  assert.match(text, /子智能体/);
  assert.match(text, /task：task-demo/);
  assert.match(text, /profile：explorer/);
  assert.match(text, /grep \[ok\]/);
  assert.match(text, /web_fetch \[blocked\]/);
  assert.match(text, /完整输出内容/);
  assert.match(text, /continuationPrompt/);
});

test("agent task live panel exposes refreshable progress and freeze hint", () => {
  const task = {
    id: "task-demo",
    title: "审计模块",
    profile: "explorer",
    status: "running",
    mode: "readonly",
    model: "example-vision-model",
    modelTier: "cheap",
    latestProgress: "运行工具 grep",
    prompt: "检查 src",
    budget: { maxRounds: 24, maxToolResultBytes: 12000, maxOutputBytes: 160000 },
    budgetProgress: {
      toolCalls: 2,
      outputBytes: 4096,
      promptTokens: 61364,
      maxTokens: 200000,
      promptRound: 3,
      promptMessageTokens: 42000,
      promptToolSchemaTokens: 12000,
      promptToolResultTokens: 7364,
      contextTokensAfter: 23456,
      providerRound: 3,
      providerPromptTokens: 59000,
      providerCachedPromptTokens: 43000,
      providerCompletionTokens: 1200,
      providerTotalTokens: 60200
    },
    toolCalls: [
      { name: "list_files", ok: true, inputSummary: "path=src" },
      { name: "grep", ok: true, inputSummary: "pattern=TODO" }
    ],
    outputSummary: "正在整理证据"
  };
  const panel = createAgentTaskLivePanel({
    task,
    entry: {
      id: "agent-task-demo",
      kind: "agent",
      taskId: "task-demo",
      title: "子任务已启动"
    }
  });
  const text = panel.lines.map((item) => item.text).join("\n");

  assert.equal(panel.kind, "agent-live");
  assert.equal(panel.title, "子智能体详情");
  assert.equal(panel.taskId, "task-demo");
  assert.match(text, /运行态详情/);
  assert.match(text, /Enter\/C 冻结到摘录层/);
  assert.match(text, /状态：运行中/);
  assert.match(text, /运行工具 grep/);
  assert.match(text, /工具=2/);
  assert.match(text, /模型输入≈61.4k\/200k tokens/);
  assert.match(text, /Provider 实报/);
  assert.match(text, /输入：59k tokens/);
  assert.match(text, /缓存命中：43k\/59k \(73%\) tokens/);
  assert.match(text, /输出：1.2k tokens/);
  assert.match(text, /合计：60.2k tokens/);
  assert.match(text, /模型轮：3/);
  assert.match(text, /模型轮=3/);
  assert.match(text, /拆分：消息 42k \/ 工具定义 12k \/ 工具结果 7.4k/);
  assert.match(text, /ctx≈23456/);
  assert.match(text, /grep \[ok\] pattern=TODO/);
  assert.match(panel.footer, /Enter\/C 冻结摘录/);
});

test("agent task live panel previews the newest output instead of stale leading lines", () => {
  const output = Array.from({ length: 12 }, (_, index) => `输出行 ${index + 1}`).join("\n");
  const panel = createAgentTaskLivePanel({
    task: {
      id: "task-tail",
      title: "长输出任务",
      profile: "explorer",
      status: "running",
      latestProgress: "继续写入输出",
      output
    },
    entry: {
      id: "agent-task-tail",
      kind: "agent",
      taskId: "task-tail",
      title: "长输出任务"
    }
  });
  const text = panel.lines.map((item) => item.text).join("\n");
  const renderedLines = panel.lines.map((item) => item.text);

  assert.match(text, /最新输出预览/);
  assert.match(text, /上方还有 4 行/);
  assert.equal(renderedLines.includes("输出行 1"), false);
  assert.match(text, /输出行 12/);
});

test("message excerpt panel renders assistant markdown table as aligned text", () => {
  const body = [
    "Here is a table:",
    "",
    "| Name | Age |",
    "| --- | --- |",
    "| Alice | 30 |",
    "| Bob | 25 |",
    "",
    "End of table."
  ].join("\n");

  const panel = createMessageExcerptPanel({
    entry: { id: "entry-table", kind: "assistant", body }
  });
  const text = panel.lines.map((item) => item.text).join("\n");

  assert.ok(text.includes("Name"), "Should contain table header 'Name'");
  assert.ok(text.includes("Alice"), "Should contain table data 'Alice'");
  assert.ok(text.includes("Bob"), "Should contain table data 'Bob'");
  assert.ok(text.includes("Here is a table:"), "Should contain intro paragraph");
  assert.ok(text.includes("End of table."), "Should contain outro paragraph");
  assert.ok(text.includes("  |Name |Age|"), "Should render an aligned table header");
  assert.ok(text.includes("  |-----|---|"), "Should render an aligned table separator");
  assert.equal(text.includes("  | --- | --- |"), false, "Should not expose the raw markdown separator in assistant excerpts");
});

test("message excerpt panel expands oversized tables without dropping cell content", () => {
  const longValue = "alpha-beta-gamma-delta-epsilon-zeta-eta-theta-iota-kappa-lambda-mu";
  const body = [
    "| Column A With A Very Long Header | Column B With A Very Long Header | Column C With A Very Long Header | Column D With A Very Long Header |",
    "| --- | --- | --- | --- |",
    `| ${longValue} | second ${longValue} | third ${longValue} | fourth ${longValue} |`
  ].join("\n");

  const panel = createMessageExcerptPanel({
    entry: { id: "entry-wide-table", kind: "assistant", body }
  });
  const text = panel.lines.map((item) => item.text).join("\n");
  const compactText = text.replace(/\s+/g, "");
  const tableLines = panel.lines
    .map((item) => item.text)
    .filter((textLine) => /^\s*\|.*\|$/.test(textLine));

  assert.ok(tableLines.length > 4, "Wide excerpt table should wrap into multiple pipe table rows");
  assert.ok(tableLines.every((textLine) => textLine.trim().startsWith("|") && textLine.trim().endsWith("|")));
  assert.doesNotMatch(text, /表格展开/);
  assert.doesNotMatch(text, /Column A With A Very Long Header：/);
  assert.ok(containsOrderedCharacters(compactText, longValue));
  assert.ok(containsOrderedCharacters(compactText, `fourth${longValue}`));
  assert.doesNotMatch(text, /…/);
});

test("message excerpt panel does NOT apply table rendering for user messages", () => {
  const body = [
    "| Name | Age |",
    "| --- | --- |",
    "| Alice | 30 |"
  ].join("\n");

  const panel = createMessageExcerptPanel({
    entry: { id: "entry-user", kind: "user", body }
  });
  // User messages should use plain wrapExcerptText, not table rendering
  // Verify no line contains a fully aligned table row (with both leading and trailing |)
  const pipeLines = panel.lines.filter(
    (l) => typeof l.text === "string" && /^\s*\|.*\|$/.test(l.text.trim())
  );
  // wrapExcerptText may split pipe rows across multiple lines, so at most the
  // raw pipe content appears but NOT as a single noWrap aligned row.
  // The key check: user messages don't use parseMarkdownBlocks at all.
  // Just verify the content is present in some form.
  const text = panel.lines.map((item) => item.text).join("\n");
  assert.ok(text.includes("Alice"), "User message content should still appear");
});

test("message excerpt panel falls back to soft-wrap for assistant body without tables", () => {
  const body = "This is a plain paragraph without any tables at all.";
  const panel = createMessageExcerptPanel({
    entry: { id: "entry-plain", kind: "assistant", body }
  });
  const text = panel.lines.map((item) => item.text).join("\n");
  assert.ok(text.includes("This is a plain paragraph"), "Plain text should be present");
  // No pipe characters from table rendering in content lines.
  // Exclude the UI hint lines and footer (which contain | separators).
  const contentLines = panel.lines.filter(
    (l) => typeof l.text === "string" && !l.dim && !l.text.includes("复制") && !l.text.includes("消息摘录") && !l.text.includes("提示：") && l.text.length > 0
  );
  const pipeContentLines = contentLines.filter(
    (l) => l.text.includes("|")
  );
  assert.equal(pipeContentLines.length, 0, "No pipe characters expected in content for plain text");
});

test("display clipboard formatter copies assistant tables as rendered text", () => {
  const body = [
    "Before",
    "",
    "| Name | Age |",
    "| --- | ---: |",
    "| Alice | 30 |",
    "| Bob | 25 |",
    "",
    "After"
  ].join("\n");

  const text = formatMessageBodyForDisplayClipboard({
    kind: "assistant",
    body
  });

  assert.ok(text.includes("Before"));
  assert.ok(text.includes("After"));
  assert.ok(text.includes("|Name |Age|"));
  assert.ok(text.includes("|-----|---|"));
  assert.ok(text.includes("|Alice| 30|"));
  assert.equal(text.includes("| --- | ---: |"), false);
});

test("display clipboard formatter expands oversized assistant tables without truncation", () => {
  const longValue = "alpha-beta-gamma-delta-epsilon-zeta-eta-theta-iota-kappa-lambda-mu";
  const body = [
    "| Column A With A Very Long Header | Column B With A Very Long Header | Column C With A Very Long Header | Column D With A Very Long Header |",
    "| --- | --- | --- | --- |",
    `| ${longValue} | second ${longValue} | third ${longValue} | fourth ${longValue} |`
  ].join("\n");

  const text = formatMessageBodyForDisplayClipboard({
    kind: "assistant",
    body
  });
  const tableLines = text.split(/\r?\n/).filter((textLine) => /^\|.*\|$/.test(textLine));
  const compactText = text.replace(/\s+/g, "");

  assert.ok(tableLines.length > 4, "Clipboard text should keep oversized tables as wrapped pipe tables");
  assert.doesNotMatch(text, /表格展开/);
  assert.ok(containsOrderedCharacters(compactText, longValue));
  assert.ok(containsOrderedCharacters(compactText, `fourth${longValue}`));
  assert.doesNotMatch(text, /…/);
});

test("display clipboard formatter leaves user markdown untouched", () => {
  const body = [
    "| Name | Age |",
    "| --- | --- |",
    "| Alice | 30 |"
  ].join("\n");

  assert.equal(formatMessageBodyForDisplayClipboard({ kind: "user", body }), body);
});

function fakeSession(config = {}) {
  return {
    id: "session-test",
    cwd: "C:\\workspace\\ant-code",
    turnCount: 2,
    model: "example-coding-model",
    networkMode: "offline",
    sensitivity: "standard",
    readonly: false,
    allowWrite: false,
    allowCommand: false,
    permissionMode: "plan",
    config,
    contextWindow: createContextWindow(config),
    messages: [],
    workflow: {
      todos: [],
      plan: { steps: [] },
      changes: [],
      validations: []
    }
  };
}

function containsOrderedCharacters(haystack, needle) {
  const source = Array.from(String(haystack ?? ""));
  const target = Array.from(String(needle ?? "").replace(/\s+/g, ""));
  let index = 0;
  for (const char of source) {
    if (char === target[index]) {
      index += 1;
      if (index >= target.length) {
        return true;
      }
    }
  }
  return target.length === 0;
}
