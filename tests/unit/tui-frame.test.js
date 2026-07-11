import assert from "node:assert/strict";
import test from "node:test";
import {
  appendStreamDelta,
  applyStreamDeltaBuffer,
  createStreamDeltaBuffer,
  createSynchronousDraftMirror,
  isCtrlKey,
  isInkKeyRelease,
  limitTranscriptEntries,
  readBracketedPaste,
  splitTrailingSubmitInput,
  resolveStreamDeltaActivityStatus,
  resolveIdleSilentAfterMs,
  resolveTuiLayoutRows,
  shouldEnterIdleSilent
} from "../../src/cli/tui.js";
import { insertText } from "../../src/cli/tui/input-editor.js";
import { resolveTuiFrame } from "../../src/cli/tui/layout.js";
import { CommandPanel, PermissionFooter, SidePanel, SlashPalette, commandPanelViewport, footerHintText, resolveLogPaneLayout, sidePanelTabsText, sidePanelViewport, transcriptScrollBar } from "../../src/cli/tui/components.js";
import { DEFAULT_TUI_THEME, themeColor } from "../../src/cli/tui/theme.js";
import { assertTerminalBounds } from "../helpers/terminal-snapshot.js";
import { makeExitFrame, makePermissionFrame, makePromptFrame, makeStartupFrame, makeStreamingFrame } from "../helpers/tui-frame.js";

test("stage 1 startup frame harness enforces compact terminal bounds", () => {
  const frame = makeStartupFrame({
    cwd: "C:\\workspace\\ant-code",
    trusted: true,
    session: {
      model: "example-coding-model",
      networkMode: "restricted",
      readonly: false,
      allowWrite: false,
      allowCommand: false,
      config: {
        lab: {
          gatewayUrl: "http://localhost:8080",
          gatewayProtocol: "openai-chat"
        }
      }
    }
  });

  assertTerminalBounds(frame, { columns: 80, rows: 24 });
});

test("stage 2 prompt frame includes cursor-width-safe wide characters", () => {
  const frame = makePromptFrame({ input: "编辑 README", cursor: 2 });

  assertTerminalBounds(frame, { columns: 80, rows: 8 });
});

test("prompt layout grows for soft-wrapped long drafts", () => {
  const short = resolveTuiLayoutRows({
    width: 80,
    height: 24,
    mode: "input",
    inputBuffer: "short",
    inputCursor: 5
  });
  const long = resolveTuiLayoutRows({
    width: 40,
    height: 24,
    mode: "input",
    inputBuffer: "abcdefghijklmnopqrstuvwxyz ".repeat(4),
    inputCursor: 108
  });

  assert.ok(long.promptRows > short.promptRows);
  assert.ok(long.bodyRows >= 4);
});

test("prompt layout caps normal input box at five rows", () => {
  const layout = resolveTuiLayoutRows({
    width: 40,
    height: 24,
    mode: "input",
    inputBuffer: "abcdefghijklmnopqrstuvwxyz ".repeat(12),
    inputCursor: 324
  });

  assert.equal(layout.promptRows, 5);
});

test("long task transcript retention drops telemetry before user conversation", () => {
  const conversation = Array.from({ length: 20 }, (_, index) => ([
    { kind: "user", title: `user ${index}`, body: `prompt ${index}` },
    { kind: "assistant", title: `assistant ${index}`, body: `answer ${index}` }
  ])).flat();
  const telemetry = Array.from({ length: 260 }, (_, index) => ({
    kind: index % 2 === 0 ? "gateway" : "tool",
    title: `telemetry ${index}`,
    body: "running"
  }));
  const entries = [
    { kind: "startup", title: "startup", body: "Ant Code" },
    ...conversation,
    ...telemetry,
    { kind: "assistant", title: "assistant final", body: "done" }
  ];

  const retained = limitTranscriptEntries(entries, 200);

  assert.equal(retained.length, 200);
  assert.ok(retained.some((entry) => entry.kind === "user" && entry.body === "prompt 0"));
  assert.ok(retained.some((entry) => entry.kind === "assistant" && entry.body === "answer 0"));
  assert.ok(retained.some((entry) => entry.kind === "assistant" && entry.body === "done"));
  assert.ok(retained.filter((entry) => entry.kind === "gateway" || entry.kind === "tool").length < telemetry.length);
});

test("long task transcript retention keeps conversation spine even beyond display limit", () => {
  const conversation = Array.from({ length: 130 }, (_, index) => ([
    { kind: "user", title: `user ${index}`, body: `prompt ${index}` },
    { kind: "assistant", title: `assistant ${index}`, body: `answer ${index}` }
  ])).flat();
  const telemetry = Array.from({ length: 260 }, (_, index) => ({
    kind: index % 2 === 0 ? "gateway" : "tool",
    title: `telemetry ${index}`,
    body: "running"
  }));

  const retained = limitTranscriptEntries([...conversation, ...telemetry], 200);

  assert.equal(retained.length, conversation.length);
  assert.ok(retained.some((entry) => entry.kind === "user" && entry.body === "prompt 0"));
  assert.ok(retained.some((entry) => entry.kind === "assistant" && entry.body === "answer 129"));
  assert.equal(retained.filter((entry) => entry.kind === "gateway" || entry.kind === "tool").length, 0);
});

test("stream delta buffer batches high-frequency text and thinking updates", () => {
  let buffer = createStreamDeltaBuffer();
  buffer = appendStreamDelta(buffer, { type: "assistant_thinking_delta", round: 2, text: "思考", bytes: 6 });
  buffer = appendStreamDelta(buffer, { type: "assistant_delta", round: 2, text: "hello ", bytes: 6 });
  buffer = appendStreamDelta(buffer, { type: "assistant_delta", round: 2, text: "world", bytes: 5 });

  const stream = applyStreamDeltaBuffer({
    active: true,
    round: 2,
    phase: "streaming",
    thinking: "",
    thinkingBytes: 0,
    thinkingTruncated: false,
    text: ""
  }, buffer, { thinkingVisible: false });

  assert.equal(stream.text, "hello world");
  assert.equal(stream.thinking, "思考");
  assert.equal(stream.thinkingBytes, 6);
  assert.equal(stream.thinkingRedacted, true);
  assert.equal(stream.phase, "answering");
});

test("stream activity status does not flicker back to thinking after answer starts", () => {
  const buffer = appendStreamDelta(createStreamDeltaBuffer(), { type: "assistant_thinking_delta", round: 3, text: "more thinking", bytes: 13 });
  const stream = applyStreamDeltaBuffer({
    active: true,
    round: 3,
    phase: "answering",
    thinking: "old",
    thinkingBytes: 3,
    text: "visible answer"
  }, buffer, { thinkingVisible: false });

  assert.equal(stream.phase, "answering");
  assert.equal(
    resolveStreamDeltaActivityStatus("生成回答", { phase: "answering", text: "hello" }, { thinking: "more", text: "" }),
    "生成回答"
  );
  assert.equal(
    resolveStreamDeltaActivityStatus("等待", { phase: "thinking", text: "" }, { thinking: "first", text: "" }),
    "思考中"
  );
});

test("idle watchdog enters silent mode only after safe inactivity", () => {
  const base = {
    startupConfirmed: true,
    trusted: true,
    busy: false,
    stream: { active: false },
    mode: "input",
    taskRecords: []
  };

  assert.equal(shouldEnterIdleSilent(base, {
    now: 30 * 60 * 1000 + 1,
    lastActivityAt: 0,
    timeoutMs: 30 * 60 * 1000,
    runningBackgroundCount: 0
  }), true);
  assert.equal(shouldEnterIdleSilent({ ...base, busy: true }, {
    now: 30 * 60 * 1000 + 1,
    lastActivityAt: 0,
    timeoutMs: 30 * 60 * 1000,
    runningBackgroundCount: 0
  }), false);
  assert.equal(shouldEnterIdleSilent({ ...base, taskRecords: [{ status: "running" }] }, {
    now: 30 * 60 * 1000 + 1,
    lastActivityAt: 0,
    timeoutMs: 30 * 60 * 1000,
    runningBackgroundCount: 0
  }), false);
  assert.equal(shouldEnterIdleSilent(base, {
    now: 30 * 60 * 1000 + 1,
    lastActivityAt: 0,
    timeoutMs: 30 * 60 * 1000,
    runningBackgroundCount: 1
  }), false);
});

test("idle watchdog timeout has a thirty minute default and env override", () => {
  assert.equal(resolveIdleSilentAfterMs({}), 30 * 60 * 1000);
  assert.equal(resolveIdleSilentAfterMs({ LAB_AGENT_TUI_IDLE_SILENT_MS: "1000" }), 1000);
  assert.equal(resolveIdleSilentAfterMs({ LAB_AGENT_TUI_IDLE_SILENT_MS: "-1" }), 0);
});

test("synchronous draft mirror preserves rapid chunked text input", () => {
  const mirror = createSynchronousDraftMirror({ text: "", cursor: 0 });
  const staleSnapshot = { ...mirror.ref.current };

  mirror.update((draft) => insertText(draft, "前半段语音转文字，"));
  mirror.update((draft) => insertText(draft, "后半段继续进入输入栏。"));

  assert.equal(mirror.ref.current.text, "前半段语音转文字，后半段继续进入输入栏。");

  const oldSnapshotResult = insertText(staleSnapshot, "后半段继续进入输入栏。");
  assert.equal(oldSnapshotResult.text, "后半段继续进入输入栏。");
});

test("bracketed paste parser owns split markers without duplicating adjacent text", () => {
  const state = { active: false, buffer: "", prefix: "" };

  assert.equal(readBracketedPaste("\u001b", state), null);
  assert.equal(readBracketedPaste("\u001b[A", state), null);
  assert.equal(readBracketedPaste("\u001b[20", state), "");
  assert.equal(readBracketedPaste("0~hello\n", state), "");
  assert.equal(readBracketedPaste("world\u001b[20", state), "");
  assert.equal(readBracketedPaste("1~!", state), "hello\nworld!");
  assert.deepEqual(state, { active: false, buffer: "", prefix: "" });
});

test("Ink control shortcuts use the emitted input value instead of a missing key name", () => {
  assert.equal(isCtrlKey("a", { ctrl: true }, "a"), true);
  assert.equal(isCtrlKey("A", { ctrl: true }, "a"), true);
  assert.equal(isCtrlKey("a", { ctrl: false }, "a"), false);
});

test("Ink key releases never repeat editor actions", () => {
  assert.equal(isInkKeyRelease({ eventType: "release" }), true);
  assert.equal(isInkKeyRelease({ eventType: "repeat" }), false);
  assert.equal(isInkKeyRelease({}), false);
});

test("coalesced printable text and Return still submit instead of inserting a newline", () => {
  assert.equal(splitTrailingSubmitInput("hello\r", {}), "hello");
  assert.equal(splitTrailingSubmitInput("hello\r\n", {}), null);
  assert.equal(splitTrailingSubmitInput("\r", { return: true }), null);
  assert.equal(splitTrailingSubmitInput("hello\r", { meta: true }), null);
});

test("prompt layout falls back safely when width is missing", () => {
  const withWidth = resolveTuiLayoutRows({
    width: 40,
    height: 24,
    mode: "input",
    inputBuffer: "abcdefghijklmnopqrstuvwxyz ".repeat(4),
    inputCursor: 108
  });
  const withoutWidth = resolveTuiLayoutRows({
    height: 24,
    mode: "input",
    inputBuffer: "abcdefghijklmnopqrstuvwxyz ".repeat(4),
    inputCursor: 108
  });

  assert.ok(withWidth.promptRows > withoutWidth.promptRows);
});

test("stage 1 and 2 acceptance frames fit compact and wide resize targets", () => {
  const startup = makeStartupFrame({
    cwd: "C:\\workspace\\ant-code",
    trusted: false,
    session: {
      model: "example-fast-model",
      networkMode: "restricted",
      readonly: true,
      allowWrite: false,
      allowCommand: false,
      config: { lab: { gatewayUrl: "http://localhost:8080", gatewayProtocol: "openai-chat" } }
    }
  });
  const prompt = makePromptFrame({ input: "第一行\n第二行 @src", cursor: 9 });

  assertTerminalBounds(startup, { columns: 80, rows: 24 });
  assertTerminalBounds(startup, { columns: 120, rows: 40 });
  assertTerminalBounds(prompt, { columns: 80, rows: 8 });
  assertTerminalBounds(prompt, { columns: 120, rows: 8 });
});

test("stage 3 through 5 modal frames have bounded acceptance snapshots", () => {
  const permission = makePermissionFrame({
    request: {
      toolName: "powershell",
      input: { command: "npm run check", timeoutMs: 120000 },
      decision: { reason: "mutating shell commands require approval" },
      definition: { risk: "execute" }
    }
  }, 0);
  const streaming = makeStreamingFrame({
    active: true,
    phase: "tool-call",
    round: 1,
    thinkingBytes: 12,
    text: "I will inspect the failing test.",
    tools: [{ index: 0, nameDraft: "grep", argumentsDraft: "{\"pattern\":\"TODO\"}" }]
  });
  const exit = makeExitFrame({ busy: true });

  assertTerminalBounds(permission, { columns: 100, rows: 12 });
  assertTerminalBounds(streaming, { columns: 100, rows: 8 });
  assertTerminalBounds(exit, { columns: 100, rows: 6 });
});

test("footer hints match real interrupt and logs shortcuts", () => {
  const compact = footerHintText({ sideView: "status", wide: false, detailMode: "compact" });
  const wide = footerHintText({ sideView: "tasks", wide: true, detailMode: "detailed" });
  const statusWide = footerHintText({ sideView: "status", wide: true, detailMode: "compact" });

  assert.match(compact, /\/guide 响应后引导/);
  assert.match(compact, /\/guide 停止只中断/);
  assert.match(compact, /\/thinking=隐藏/);
  assert.match(compact, /双击进入摘录面板/);
  assert.match(compact, /Esc 两次\/Ctrl\+G 中断/);
  assert.match(wide, /侧栏：Tab 切换栏，←\/→ 分类，当前 子智能体/);
  assert.match(wide, /\/logs 运行日志/);
  assert.match(wide, /Ctrl\+O=详细/);
  assert.doesNotMatch(wide, /检查过滤|Ctrl\+T|Ctrl\+R\/E|当前 检查/);
  assert.match(statusWide, /侧栏：Tab 切换栏，←\/→ 分类，当前 状态/);
  assert.match(statusWide, /\/context 或 \/usage 查看完整用量/);
});

test("footer reflects the local thinking visibility toggle", () => {
  const visible = footerHintText({ sideView: "status", wide: true, detailMode: "compact", thinkingVisible: true });

  assert.match(visible, /\/thinking=显示/);
});

test("permission footer exposes the current permission mode near the composer", () => {
  const plan = elementText(PermissionFooter({
    session: { permissionMode: "plan", fullAccess: false, allowWrite: false, allowCommand: false },
    width: 80
  }));
  const workspace = elementText(PermissionFooter({
    session: { permissionMode: "workspace", fullAccess: false, allowWrite: true, allowCommand: true },
    width: 80
  }));
  const full = elementText(PermissionFooter({
    session: { permissionMode: "fullAccess", fullAccess: true, allowWrite: true, allowCommand: true },
    width: 80
  }));
  const narrow = elementText(PermissionFooter({
    session: { permissionMode: "fullAccess", fullAccess: true, allowWrite: true, allowCommand: true },
    width: 34
  }));

  assert.match(plan, /权限：计划确认/);
  assert.match(workspace, /权限：工作区权限/);
  assert.match(full, /权限：完全访问/);
  assert.match(full, /Shift\+Tab 切换/);
  assert.ok(narrow.length <= 34);
  assert.match(narrow, /权限：完全访问/);
  assert.match(narrow, /S\+Tab/);
  assert.doesNotMatch(narrow, /完全访问 /);
  assert.equal(permissionFooterLabelColor("plan"), themeColor(DEFAULT_TUI_THEME, "success", "green"));
  assert.equal(permissionFooterLabelColor("workspace"), themeColor(DEFAULT_TUI_THEME, "warning", "yellow"));
  assert.equal(permissionFooterLabelColor("fullAccess"), themeColor(DEFAULT_TUI_THEME, "danger", "red"));
});

test("side panel renders product tabs without persistent logs or command tabs", () => {
  const panel = SidePanel({
    view: "workflow",
    session: { id: "s", workflow: {} },
    activity: {},
    sidePanelOffset: 0,
    taskRecords: [],
    visibleRows: 12,
    width: 38,
    height: 16
  });

  assert.match(sidePanelTabsText("workflow"), /\[任务\]/);
  assert.match(sidePanelTabsText("workflow"), /状态/);
  assert.match(sidePanelTabsText("workflow"), /子智能体/);
  assert.doesNotMatch(sidePanelTabsText("workflow"), /历史|检查|命令/);
  assert.match(elementText(panel), /\[任务\]/);
  assert.doesNotMatch(elementText(panel), /\[检查\]|\[命令\]/);
});

test("status side panel splits provider usage into readable rows", () => {
  const panel = SidePanel({
    view: "status",
    session: {
      id: "session-provider",
      turnCount: 3,
      model: "example-coding-model",
      networkMode: "online",
      sensitivity: "standard",
      permissionMode: "workspace",
      messages: [],
      workflow: {},
      usage: {
        source: "provider-reported",
        reports: 2,
        promptTokens: 128000,
        cachedPromptTokens: 96000,
        completionTokens: 6400,
        totalTokens: 134400,
        lastPromptTokens: 64000,
        lastCachedPromptTokens: 48000,
        lastCompletionTokens: 3200,
        lastTotalTokens: 67200
      },
      config: { modelMaxTokens: 400000, contextWindow: { maxTokens: 256000 } }
    },
    activity: {},
    sidePanelOffset: 0,
    taskRecords: [],
    visibleRows: 28,
    width: 38,
    height: 30
  });
  const text = elementText(panel);

  assert.match(text, /Provider 实报/);
  assert.match(text, /输入：64k tokens/);
  assert.match(text, /缓存命中：48k\/64k tokens \(75%\)/);
  assert.match(text, /输出：3.2k tokens/);
  assert.match(text, /合计：67.2k tokens/);
  assert.match(text, /累计输入：128k tokens/);
  assert.match(text, /报告次数：2/);
  assert.match(text, /完整：\/context 或 \/usage/);
  assert.doesNotMatch(text, /Provider 实报：输入 64k \/ 输出 3.2k \/ 合计 67.2k tokens/);
});

test("workflow side panel filters incomplete, completed, and all work", () => {
  const session = {
    id: "s",
    workflow: {
      todos: [
        { content: "正在修复", status: "in_progress" },
        { content: "等待验证", status: "pending" },
        { content: "已经完成", status: "completed" }
      ],
      plan: {
        steps: [
          { content: "当前步骤", status: "in_progress" },
          { content: "完成步骤", status: "completed" }
        ]
      },
      changes: [],
      validations: []
    }
  };

  const incomplete = elementText(SidePanel({ view: "workflow", session, activity: {}, workflowFilter: "incomplete", visibleRows: 40, width: 58, height: 42 }));
  const completed = elementText(SidePanel({ view: "workflow", session, activity: {}, workflowFilter: "completed", visibleRows: 40, width: 58, height: 42 }));
  const all = elementText(SidePanel({ view: "workflow", session, activity: {}, workflowFilter: "all", visibleRows: 40, width: 58, height: 42 }));

  assert.match(incomplete, /\[未完成\] 已完成 全部/);
  assert.match(incomplete, /正在修复/);
  assert.match(incomplete, /等待验证/);
  assert.doesNotMatch(incomplete, /已经完成/);
  assert.match(completed, /\[已完成\]/);
  assert.match(completed, /已经完成/);
  assert.match(completed, /完成步骤/);
  assert.match(all, /\[全部\]/);
  assert.match(all, /正在修复/);
  assert.match(all, /等待验证/);
  assert.match(all, /已经完成/);
});

test("tasks side panel exposes live tool and budget progress", () => {
  const panel = SidePanel({
    view: "tasks",
    session: { id: "s", workflow: {} },
    activity: {},
    inspector: null,
    inspectorItems: [],
    inspectorIndex: 0,
    inspectorOffset: 0,
    inspectorFilter: "all",
    inspectorPatchFileIndex: 0,
    sidePanelOffset: 0,
    taskRecords: [
      {
        id: "task-live",
        profile: "explorer",
        title: "调查当前项目",
        status: "running",
        purpose: "explore",
        difficulty: "quick",
        risk: "low",
        modelTier: "cheap",
        model: "example-vision-model",
        budget: { maxRounds: 16 },
        budgetProgress: {
          toolCalls: 2,
          outputBytes: 128,
          promptTokens: 61364,
          maxTokens: 200000,
          providerPromptTokens: 59000,
          providerCachedPromptTokens: 43000,
          providerCompletionTokens: 1200,
          providerTotalTokens: 60200
        },
        latestProgress: "grep 完成",
        toolCalls: [{ name: "grep", ok: true }]
      }
    ],
    taskGroupRecords: [
      {
        id: "group-live",
        status: "running",
        wakeParent: true,
        taskIds: ["task-live"],
        latestProgress: "后台子任务 explorer 已启动"
      }
    ],
    visibleRows: 32,
    width: 58,
    height: 34
  });
  const text = elementText(panel);

  assert.match(text, /\[活跃\] 暂停\/失败 已完成 全部/);
  assert.match(text, /本会话任务：1\/1/);
  assert.match(text, /任务组：1\/1/);
  assert.match(text, /组 group-live 自动唤醒/);
  assert.match(text, /cheap:example-vision-model/);
  assert.match(text, /工具 2 输出 128B/);
  assert.match(text, /模型输入（估算）/);
  assert.match(text, /输入：61.4k\/200k tokens/);
  assert.match(text, /Provider 实报/);
  assert.match(text, /输入：59k tokens/);
  assert.match(text, /缓存命中：43k\/59k tokens \(73%\)/);
  assert.match(text, /输出：1.2k tokens/);
  assert.match(text, /合计：60.2k tokens/);
  assert.match(text, /最近工具：grep 完成/);
  assert.match(text, /\/agents task <task-id> 查看详情/);
});

test("tasks side panel shows background groups even before task records arrive", () => {
  const panel = SidePanel({
    view: "tasks",
    session: { id: "s", workflow: {} },
    activity: {},
    sidePanelOffset: 0,
    taskRecords: [],
    taskGroupRecords: [
      {
        id: "group-starting",
        status: "running",
        wakeParent: true,
        taskIds: ["task-starting"],
        latestProgress: "后台子任务 explorer 已启动"
      }
    ],
    visibleRows: 24,
    width: 58,
    height: 26
  });
  const text = elementText(panel);

  assert.doesNotMatch(text, /本会话暂无子智能体任务/);
  assert.match(text, /本会话任务：0\/0/);
  assert.match(text, /任务组：1\/1/);
  assert.match(text, /组 group-starting 自动唤醒/);
});

test("tasks side panel is session-scoped and does not hide extra root tasks", () => {
  const taskRecords = Array.from({ length: 12 }, (_, index) => ({
    id: `task-${index + 1}`,
    profile: "explorer",
    title: `任务 ${index + 1}`,
    status: "completed",
    updatedAt: `2026-05-02T00:${String(index).padStart(2, "0")}:00.000Z`
  }));
  const panel = SidePanel({
    view: "tasks",
    session: { id: "s", workflow: {} },
    activity: {},
    sidePanelOffset: 0,
    taskRecords,
    taskFilter: "all",
    visibleRows: 80,
    width: 58,
    height: 82
  });
  const text = elementText(panel);

  assert.match(text, /\[全部\]/);
  assert.match(text, /本会话任务：12\/12/);
  assert.match(text, /任务 12/);
  assert.doesNotMatch(text, /还有 \d+ 个根任务/);
  assert.match(text, /\/agents task <task-id> 查看详情/);
});

test("subagent side panel separates active, failed, and completed task categories", () => {
  const taskRecords = [
    { id: "task-running", profile: "explorer", title: "运行中任务", status: "running", updatedAt: "2026-05-02T00:03:00.000Z" },
    { id: "task-failed", profile: "reviewer", title: "失败任务", status: "failed", updatedAt: "2026-05-02T00:02:00.000Z" },
    { id: "task-paused", profile: "explorer", title: "暂停任务", status: "partial", budgetExceeded: { kind: "outputBytes" }, updatedAt: "2026-05-02T00:01:00.000Z" },
    { id: "task-done", profile: "explorer", title: "完成任务", status: "completed", updatedAt: "2026-05-02T00:00:00.000Z" }
  ];

  const active = elementText(SidePanel({ view: "tasks", session: { id: "s", workflow: {} }, activity: {}, taskRecords, taskFilter: "active", visibleRows: 40, width: 58, height: 42 }));
  const issues = elementText(SidePanel({ view: "tasks", session: { id: "s", workflow: {} }, activity: {}, taskRecords, taskFilter: "issues", visibleRows: 40, width: 58, height: 42 }));
  const completed = elementText(SidePanel({ view: "tasks", session: { id: "s", workflow: {} }, activity: {}, taskRecords, taskFilter: "completed", visibleRows: 40, width: 58, height: 42 }));

  assert.match(active, /\[活跃\]/);
  assert.match(active, /运行中任务/);
  assert.doesNotMatch(active, /失败任务|暂停任务|完成任务/);
  assert.match(issues, /\[暂停\/失败\]/);
  assert.match(issues, /\[\.\.\] 暂停任务/);
  assert.match(issues, /失败任务/);
  assert.match(issues, /暂停任务/);
  assert.doesNotMatch(issues, /运行中任务|完成任务/);
  assert.match(completed, /\[已完成\]/);
  assert.match(completed, /完成任务/);
});

test("command panel viewport clamps to the last full page", () => {
  const panel = {
    lines: Array.from({ length: 7 }, (_, index) => ({ text: `line ${index + 1}` }))
  };
  const viewport = commandPanelViewport(panel, 6, 6);

  assert.equal(viewport.boundedOffset, 1);
  assert.equal(viewport.firstRow, 2);
  assert.equal(viewport.lastRow, 7);
  assert.equal(viewport.maxOffset, 1);
});

test("message excerpt command panel renders without box borders for clean selection", () => {
  const panel = CommandPanel({
    panel: {
      kind: "message-excerpt",
      title: "消息摘录",
      borderless: true,
      lines: [
        { text: "消息摘录：鼠标拖选下方文字即可复制片段。" },
        { text: "  partial text" }
      ],
      footer: "Esc 返回"
    },
    width: 80,
    height: 6,
    visibleRows: 4
  });
  const text = elementText(panel);

  assert.match(text, /partial text/);
  assert.doesNotMatch(text, /│|╭|╮|╰|╯/);
});

test("side panel viewport keeps wide layout from expanding terminal height", () => {
  const lines = Array.from({ length: 30 }, (_, index) => ({ text: `line ${index + 1}` }));
  const viewport = sidePanelViewport(lines, 12);

  assert.equal(viewport.visible.length, 11);
  assert.equal(viewport.hiddenRows, 19);
  assert.equal(viewport.totalRows, 30);
});

test("bottom palettes are docked rows above the composer", () => {
  const layout = resolveTuiLayoutRows({
    height: 24,
    mode: "input",
    inputBuffer: "/res",
    activePanel: "slash",
    slashPalette: {
      commands: Array.from({ length: 12 }, (_, index) => ({ name: `cmd${index}`, description: "command" }))
    }
  });

  assert.equal(layout.permissionFooterRows, 1);
  assert.equal(layout.statusRows + layout.footerRows + layout.permissionFooterRows + layout.promptRows + layout.bodyRows + layout.panelRows, 24);
  assert.ok(layout.panelRows >= 8);
  assert.ok(layout.bodyRows >= 4);
  assert.ok(layout.promptRows >= 3);
});

test("permission footer sits below the composer without overlapping question prompts", () => {
  const layout = resolveTuiLayoutRows({
    width: 80,
    height: 24,
    mode: "question",
    questionBuffer: "补充约束",
    questionCursor: 4,
    pendingQuestion: {
      question: "请选择需要保留的需求",
      choices: ["A. 保留中文界面", "B. 保持滚轮稳定"],
      allowCustom: true
    }
  });
  const frame = resolveTuiFrame({
    width: 80,
    height: 24,
    wide: false,
    rows: layout
  });

  assert.equal(frame.regions.permissionFooter.top, frame.regions.prompt.bottom + 1);
  assert.equal(frame.regions.footer.top, frame.regions.permissionFooter.bottom + 1);
  assert.ok(frame.regions.prompt.bottom < frame.regions.footer.top - 1);
});

test("slash command surfaces make Esc close guidance prominent", () => {
  const slash = SlashPalette({
    palette: {
      query: "sta",
      commands: [
        { name: "status", description: "显示当前状态。" },
        { name: "stash", description: "显示提示暂存可用性。", disabledReason: "提示暂存暂缓" }
      ]
    },
    index: 0,
    width: 80,
    visibleRows: 8
  });
  const commandPanel = CommandPanel({
    panel: {
      kind: "help",
      title: "帮助",
      subtitle: "斜杠命令说明",
      lines: [{ text: "/status 显示当前状态。" }],
      footer: "Left/Right 标签 | Up/Down 滚动 | Esc 关闭"
    },
    width: 80,
    height: 8,
    visibleRows: 2
  });

  assert.match(elementText(slash), /继续输入可过滤命令/);
  assert.ok(hasProminentEscAction(slash, "Esc 关闭"));
  assert.ok(hasProminentEscAction(commandPanel, "Esc 关闭"));
});

test("sessions command panel gets a large bounded viewport", () => {
  const layout = resolveTuiLayoutRows({
    height: 40,
    mode: "input",
    activePanel: "command",
    commandPanel: {
      kind: "sessions",
      tabs: [],
      lines: Array.from({ length: 40 }, (_, index) => ({ text: `session ${index + 1}` }))
    }
  });

  assert.ok(layout.panelRows >= 20);
  assert.ok(layout.commandPanelVisibleRows >= 15);
  assert.equal(layout.permissionFooterRows, 1);
  assert.equal(layout.statusRows + layout.footerRows + layout.permissionFooterRows + layout.promptRows + layout.bodyRows + layout.panelRows, 40);
});

test("native scrollback layout expands transcript rows without fixing pane height", () => {
  const compact = resolveLogPaneLayout({
    height: 24,
    streamActive: true,
    scrollbackMode: true,
    transcriptTotalRows: 240
  });
  const large = resolveLogPaneLayout({
    height: 40,
    streamActive: true,
    scrollbackMode: true,
    transcriptTotalRows: 240
  });
  const framed = resolveLogPaneLayout({
    height: 40,
    streamActive: true,
    scrollbackMode: false,
    transcriptTotalRows: 240
  });

  assert.equal(compact.fixedHeight, false);
  assert.equal(large.fixedHeight, false);
  assert.equal(framed.fixedHeight, true);
  assert.equal(compact.displayRows, 240);
  assert.equal(large.displayRows, 240);
  assert.ok(compact.liveRows > framed.liveRows);
  assert.ok(framed.displayRows < large.displayRows);
});

test("transcript scrollbar marks top and bottom positions inside the chat pane", () => {
  const top = transcriptScrollBar({
    totalRows: 100,
    firstRow: 1,
    lastRow: 10
  }, 10);
  const bottom = transcriptScrollBar({
    totalRows: 100,
    firstRow: 91,
    lastRow: 100
  }, 10);

  assert.equal(top[0].active, true);
  assert.equal(top[9].active, false);
  assert.equal(bottom[0].active, false);
  assert.equal(bottom[9].active, true);
});

function elementText(node) {
  if (node === null || node === undefined || typeof node === "boolean") {
    return "";
  }
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(elementText).join("");
  }
  if (typeof node.type === "function" && node.type.name === "EscapeAction") {
    return elementText(node.type(node.props ?? {}));
  }
  return elementText(node.props?.children);
}

function permissionFooterLabelColor(mode) {
  const node = PermissionFooter({
    session: { permissionMode: mode },
    width: 80
  });
  return node.props.children[0].props.children[0].props.color;
}

function hasProminentEscAction(node, label) {
  if (node === null || node === undefined || typeof node !== "object") {
    return false;
  }
  if (Array.isArray(node)) {
    return node.some((item) => hasProminentEscAction(item, label));
  }
  if (typeof node.type === "function" && node.type.name === "EscapeAction") {
    return hasProminentEscAction(node.type(node.props ?? {}), label);
  }
  if (node.props?.bold && node.props?.inverse && elementText(node).includes(label)) {
    return true;
  }
  return hasProminentEscAction(node.props?.children, label);
}
