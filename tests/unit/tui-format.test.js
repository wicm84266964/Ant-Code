import assert from "node:assert/strict";
import test from "node:test";
import {
  ANT_CODE_LOGO,
  applyPermissionMode,
  exitConfirmLines,
  initialPermissionMode,
  nextDetailMode,
  nextPermissionMode,
  approvalKeyFor,
  permissionModalLines,
  permissionModeDescription,
  permissionModeLabel,
  promptLines,
  startupBannerLines,
  startupConfirmLines,
  sliceEntriesForRows,
  streamPhaseLabel,
  streamingPanelLines,
  streamingViewport,
  thinkingSummaryLine,
  toolCardLines,
  transcriptEntriesWithThinkingVisibility,
  transcriptViewport,
  transcriptBlockLines,
  trustDialogLines
} from "../../src/cli/tui/format.js";
import { assertTerminalBounds } from "../helpers/terminal-snapshot.js";

test("startup banner exposes Ant Code identity and local execution boundary", () => {
  const lines = startupBannerLines({
    model: "mock-sonnet",
    networkMode: "offline",
    readonly: false,
    allowWrite: false,
    allowCommand: false,
    config: {
      lab: {
        gatewayUrl: "http://localhost:8080/v1/chat/completions",
        gatewayProtocol: "openai-chat"
      }
    }
  });

  assert.deepEqual(lines.slice(0, ANT_CODE_LOGO.length), ANT_CODE_LOGO);
  assert.equal(lines.includes("ANT CODE"), false);
  assert.ok(lines.some((line) => line.includes("模型：mock-sonnet")));
  assert.ok(lines.some((line) => line.includes("网关：openai-chat 就绪")));
  assert.ok(lines.some((line) => line.includes("本地工具只在这个终端客户端内执行")));
  assertTerminalBounds(lines.join("\n"), { columns: 80, rows: 24 });
});

test("startup confirmation lines are shown even after workspace trust", () => {
  const lines = startupConfirmLines("C:\\saveproject\\LBJ-workspace\\lab-agent", true);

  assert.equal(lines[0], "启动 Ant Code");
  assert.ok(lines.some((line) => line.includes("工作区信任：已授权")));
  assert.ok(lines.some((line) => line.includes("Enter：继续")));
  assert.ok(lines.some((line) => line.includes("Esc：退出")));
  assertTerminalBounds(lines.join("\n"), { columns: 80, rows: 24 });
});

test("startup confirmation warns about runtime-data-only workspaces", () => {
  const lines = startupConfirmLines("E:\\tmp-file", true, {
    warning: "当前 cwd 看起来只包含 Ant Code 运行数据目录；如果你原本想调查某个项目，请从那个项目目录启动 ant-code，或让模型先确认目标路径。"
  });

  assert.ok(lines.some((line) => line.includes("工作区提醒")));
  assert.ok(lines.some((line) => line.includes("要调查哪个项目")));
  assertTerminalBounds(lines.join("\n"), { columns: 100, rows: 24 });
});

test("streaming panel lines summarize thinking, answer draft, and tool drafts", () => {
  const lines = streamingPanelLines({
    active: true,
    round: 2,
    thinkingBytes: 25,
    text: "I found the issue.",
    tools: [
      {
        index: 0,
        nameDraft: "read_file",
        argumentsDraft: "{\"path\":\"README.md\"}"
      }
    ]
  }, 1);

  assert.equal(lines[0].text, "\\ 生成回答 - 第 2 轮");
  assert.ok(lines.some((line) => line.text.includes("thinking：已收到 25 字节，默认隐藏")));
  assert.ok(lines.some((line) => line.text.includes("草稿：I found the issue.")));
  assert.ok(lines.some((line) => line.text.includes("工具：read_file")));
});

test("detail mode cycles and thinking summary is hidden unless explicitly expanded", () => {
  assert.equal(nextDetailMode("compact"), "detailed");
  assert.equal(nextDetailMode("detailed"), "full");
  assert.equal(nextDetailMode("full"), "compact");
  assert.equal(thinkingSummaryLine({ thinkingBytes: 7 }, "detailed"), "thinking：已收到 7 字节，默认隐藏；输入 /thinking 展开当前可见预览");
  assert.equal(thinkingSummaryLine({ thinkingBytes: 7, thinkingVisible: true }, "detailed"), "thinking：已展开 7 字节，当前可见预览可查看");
});

test("streaming viewport can expand raw thinking when the local toggle is enabled", () => {
  const hidden = streamingViewport({
    active: true,
    phase: "thinking",
    round: 1,
    thinking: "first raw thought\nsecond raw thought",
    thinkingBytes: 35
  }, 8, 100, 0, 0, "compact");
  const visible = streamingViewport({
    active: true,
    phase: "thinking",
    round: 1,
    thinking: "first raw thought\nsecond raw thought",
    thinkingBytes: 35,
    thinkingVisible: true
  }, 8, 100, 0, 0, "compact");
  const hiddenText = hidden.lines.map((item) => item.text).join("\n");
  const visibleText = visible.lines.map((item) => item.text).join("\n");

  assert.match(hiddenText, /默认隐藏/);
  assert.doesNotMatch(hiddenText, /first raw thought/);
  assert.match(visibleText, /已展开/);
  assert.match(visibleText, /first raw thought/);
  assert.match(visibleText, /second raw thought/);
});

test("transcript detail mode never folds final assistant answers", () => {
  const body = Array.from({ length: 26 }, (_, index) => `answer line ${index + 1}`).join("\n");
  const compact = transcriptBlockLines({ kind: "assistant", title: "assistant", body }, "compact");
  const full = transcriptBlockLines({ kind: "assistant", title: "assistant", body }, "full");

  assert.equal(compact.some((item) => item.text.includes("已折叠")), false);
  assert.ok(compact.some((item) => item.text.includes("answer line 26")));
  assert.ok(full.some((item) => item.text.includes("answer line 26")));
  assert.equal(full.some((item) => item.text.includes("已折叠")), false);
});

test("transcript detail mode keeps long assistant paragraphs visible", () => {
  const body = Array.from({ length: 260 }, (_, index) => `token${index}`).join(" ");
  const compact = transcriptBlockLines({ kind: "assistant", title: "assistant", body }, "compact");
  const full = transcriptBlockLines({ kind: "assistant", title: "assistant", body }, "full");

  assert.equal(compact.some((item) => item.text.includes("已折叠")), false);
  assert.ok(compact.some((item) => item.text.includes("token259")));
  assert.ok(full.some((item) => item.text.includes("token259")));
});

test("session metadata transcript blocks are not hidden behind detail mode", () => {
  const body = [
    "id: session-1",
    "metadata: C:\\workspace\\.lab-agent\\sessions\\session-1.json",
    "turn: 3",
    "status: completed",
    "title: continue the TUI",
    "model: mock-sonnet",
    "finished: 2026-04-29T00:00:00.000Z",
    "last prompt: continue the TUI",
    "restored messages: 4"
  ].join("\n");
  const compact = transcriptBlockLines({ kind: "session", title: "resumed metadata", body }, "compact");

  assert.equal(compact.some((item) => item.text.includes("已折叠")), false);
  assert.ok(compact.some((item) => item.text.includes("restored messages: 4")));
});

test("trust dialog lines include cwd and keyboard decisions", () => {
  const lines = trustDialogLines("C:\\saveproject\\LBJ-workspace\\lab-agent");

  assert.equal(lines[0], "需要信任工作区");
  assert.ok(lines.some((line) => line.includes("cwd:")));
  assert.ok(lines.some((line) => line.includes("Enter：信任此工作区")));
  assert.ok(lines.some((line) => line.includes("Esc：退出")));
  assertTerminalBounds(lines.join("\n"), { columns: 80, rows: 24 });
});

test("permission mode helpers cycle policy modes and update session flags", () => {
  const session = {
    readonly: false,
    allowWrite: false,
    allowCommand: false,
    sensitivity: "standard"
  };

  assert.equal(initialPermissionMode(session), "plan");
  assert.equal(nextPermissionMode(session, "plan"), "workspace");
  applyPermissionMode(session, "workspace");
  assert.equal(session.allowWrite, true);
  assert.equal(session.allowCommand, true);
  assert.equal(permissionModeLabel(session), "工作区权限");
  assert.match(permissionModeDescription("workspace"), /工作区权限/);
  assert.equal(nextPermissionMode(session, "workspace"), "fullAccess");
  applyPermissionMode(session, "fullAccess");
  assert.equal(session.allowWrite, true);
  assert.equal(session.allowCommand, true);
  assert.equal(session.fullAccess, true);
  assert.equal(permissionModeLabel(session), "完全访问");
  assert.match(permissionModeDescription("fullAccess"), /完全访问/);
});

test("approval keys isolate path and risk boundaries", () => {
  const outsideRead = approvalKeyFor({
    toolName: "read_file",
    input: { path: "C:\\tmp\\a.txt" },
    decision: { outsideWorkspace: true },
    definition: { risk: "read" }
  });
  const otherOutsideRead = approvalKeyFor({
    toolName: "read_file",
    input: { path: "C:\\tmp\\b.txt" },
    decision: { outsideWorkspace: true },
    definition: { risk: "read" }
  });
  const workspaceRead = approvalKeyFor({
    toolName: "read_file",
    input: { path: "C:\\tmp\\a.txt" },
    decision: {},
    definition: { risk: "read" }
  });
  const sensitiveWrite = approvalKeyFor({
    toolName: "write_file",
    input: { path: ".env" },
    decision: { sensitive: true },
    definition: { risk: "write" }
  });
  const normalWrite = approvalKeyFor({
    toolName: "write_file",
    input: { path: ".env" },
    decision: {},
    definition: { risk: "write" }
  });
  const firstMcpPath = approvalKeyFor({
    toolName: "mcp_call",
    input: { server: "filesystem", tool: "read_file", arguments: { path: "C:\\tmp\\a.txt" } },
    decision: { outsideWorkspace: true, targetPath: "C:\\tmp\\a.txt" },
    definition: { risk: "read" }
  });
  const secondMcpPath = approvalKeyFor({
    toolName: "mcp_call",
    input: { server: "filesystem", tool: "read_file", arguments: { path: "C:\\tmp\\b.txt" } },
    decision: { outsideWorkspace: true, targetPath: "C:\\tmp\\b.txt" },
    definition: { risk: "read" }
  });

  assert.notEqual(outsideRead, otherOutsideRead);
  assert.notEqual(outsideRead, workspaceRead);
  assert.notEqual(sensitiveWrite, normalWrite);
  assert.notEqual(firstMcpPath, secondMcpPath);
  assert.match(outsideRead, /outside/);
  assert.match(sensitiveWrite, /sensitive/);
});

test("prompt lines expose queue and permission modal states", () => {
  const busy = promptLines("input", true, "next prompt", "", { queuedPrompts: ["already queued"] });
  const approval = promptLines("approval", false, "", "", {
    pendingApproval: {
      toolName: "edit_file",
      request: {
        toolName: "edit_file",
        input: { path: "README.md", oldText: "a", newText: "b" },
        decision: { reason: "workspace writes require approval" },
        definition: { risk: "write" }
      }
    }
  });

  assert.ok(busy[0].text.startsWith("队列> next prompt"));
  assert.ok(busy.some((line) => line.text.includes("已排队：1 条提示")));
  assert.equal(approval[0].text, "权限弹窗已打开");
  assert.ok(approval.some((line) => line.text.includes("Y 允许一次")));
});

test("question prompt renders selectable choices and custom answer guidance", () => {
  const lines = promptLines("question", false, "", "补充约束", {
    pendingQuestion: {
      question: "请选择需要保留的需求",
      choices: [
        { label: "保留中文界面", description: "常用 UI 文案中文化" },
        { label: "保持滚轮稳定" }
      ],
      multiple: true,
      selectedIndices: [0],
      focusedIndex: 1,
      allowCustom: true
    },
    questionCursor: 4
  });
  const text = lines.map((item) => item.text).join("\n");

  assert.match(text, /请选择需要保留的需求/);
  assert.match(text, /\[x\] 保留中文界面/);
  assert.match(text, /> \[ \] 保持滚轮稳定/);
  assert.match(text, /自定义>/);
  assert.match(text, /Space 勾选/);
  assert.match(text, /Esc 取消/);
});

test("prompt and transcript compact large pasted text", () => {
  const pasted = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n");
  const prompt = promptLines("input", false, pasted, "", { inputCursor: pasted.length });
  const transcript = transcriptBlockLines({ kind: "user", title: "user", body: pasted }, "compact");
  const promptText = prompt.map((item) => item.text).join("\n");
  const transcriptText = transcript.map((item) => item.text).join("\n");

  assert.match(promptText, /\{12 lines, .*粘贴文本\}/);
  assert.match(promptText, /Enter 发送/);
  assert.equal(prompt.some((item) => item.segments?.some((segment) => segment.cursor)), true);
  assert.match(transcriptText, /\{12 lines, .*粘贴文本\}/);
  assert.match(transcriptText, /Ctrl\+O/);
  assert.equal(transcriptText.includes("line 12"), false);
});

test("prompt lines soft-wrap long single-line drafts", () => {
  const draft = "abcdefghijklmnopqrstuvwxyz";
  const prompt = promptLines("input", false, draft, "", {
    inputCursor: draft.length,
    draftColumns: 12
  });
  const text = prompt.map((item) => item.text).join("\n");

  assert.match(text, /> abcdefghij/);
  assert.match(text, /  klmnopqrst/);
  assert.match(text, /  uvwxyz/);
});

test("prompt lines can clamp visible draft rows around the cursor", () => {
  const draft = "abcdefghijklmnopqrstuvwxyz";
  const prompt = promptLines("input", false, draft, "", {
    inputCursor: draft.length,
    draftColumns: 12,
    maxPromptLines: 2
  });

  assert.deepEqual(prompt.map((item) => item.text), ["> klmnopqrst", "  uvwxyz "]);
});

test("exit confirmation and permission modal lines are bounded and decision-focused", () => {
  const exitLines = exitConfirmLines({ busy: true });
  const permission = permissionModalLines({
    request: {
      toolName: "edit_file",
      input: { path: "README.md", oldText: "old", newText: "new text" },
      decision: { reason: "workspace writes require approval" },
      definition: { risk: "write" }
    }
  }, 1).map((item) => item.text).join("\n");

  assert.ok(exitLines.some((line) => line.includes("再次按 Ctrl+C")));
  assert.match(permission, /需要权限/);
  assert.match(permission, /\[write\] edit_file/);
  assert.match(permission, /> 本会话允许/);
  assertTerminalBounds(permission, { columns: 100, rows: 12 });
});

test("transcript and tool card lines expose block semantics", () => {
  const assistant = transcriptBlockLines({ kind: "assistant", title: "assistant", body: "done" });
  const tool = toolCardLines({ title: "powershell blocked", body: "decision=deny" });
  const agent = transcriptBlockLines({
    kind: "agent",
    title: "子任务完成",
    taskStatus: "completed",
    body: "task=task-1\nprofile=explorer\n状态=已完成\n详情：/agents task task-1"
  });

  assert.equal(assistant[0].text, "Ant Code");
  assert.match(tool[0].text, /\[blocked\] shell/);
  assert.match(agent[0].text, /\[✓\] 子智能体 - 子任务完成/);
  assert.ok(agent.some((item) => item.text.includes("/agents task task-1")));
});

test("assistant transcript thinking is opt-in and locally recoverable", () => {
  const hidden = transcriptBlockLines({
    kind: "assistant",
    title: "assistant",
    body: "final answer",
    thinking: "private chain",
    thinkingBytes: 13,
    thinkingVisible: false
  }, "compact");
  const visible = transcriptBlockLines({
    kind: "assistant",
    title: "assistant",
    body: "final answer",
    thinking: "private chain",
    thinkingBytes: 13,
    thinkingVisible: true
  }, "compact");
  const hiddenText = hidden.map((item) => item.text).join("\n");
  const visibleText = visible.map((item) => item.text).join("\n");

  assert.match(hiddenText, /默认隐藏/);
  assert.doesNotMatch(hiddenText, /private chain/);
  assert.match(visibleText, /private chain/);
  assert.match(visibleText, /当前可见预览可查看/);
});

test("/thinking visibility applies to completed transcript messages in memory", () => {
  const entries = [
    {
      id: "assistant-1",
      kind: "assistant",
      title: "assistant",
      body: "final answer",
      thinking: "already finished raw thinking",
      thinkingBytes: 28,
      thinkingVisible: false
    }
  ];
  const hiddenText = transcriptViewport(
    transcriptEntriesWithThinkingVisibility(entries, false),
    20,
    100,
    0,
    "compact"
  ).lines.map((item) => item.text).join("\n");
  const visibleText = transcriptViewport(
    transcriptEntriesWithThinkingVisibility(entries, true),
    20,
    100,
    0,
    "compact"
  ).lines.map((item) => item.text).join("\n");

  assert.match(hiddenText, /默认隐藏/);
  assert.doesNotMatch(hiddenText, /already finished raw thinking/);
  assert.match(visibleText, /already finished raw thinking/);
});

test("transcript slicing keeps the latest assistant answer ahead of completed turn metadata", () => {
  const longAnswer = [
    "Ant Code can read files, inspect project structure, propose edits, and run local verification commands.",
    "It keeps model traffic on the configured local gateway and executes tools only from this terminal client.",
    "Permission prompts protect writes, shell commands, and other high-risk local actions."
  ].join("\n");
  const visible = sliceEntriesForRows([
    { kind: "user", title: "user", body: "What tools and abilities do you have?" },
    { kind: "assistant", title: "assistant", body: longAnswer },
    { kind: "turn", title: "completed", body: "outputBytes=894" }
  ], 5, 72);

  assert.equal(visible.at(-1).kind, "assistant");
  assert.ok(visible.some((entry) => entry.body.includes("configured local gateway")));
  assert.equal(visible.some((entry) => entry.body.includes("outputBytes=894")), false);
});

test("transcript viewport scrolls long assistant output without terminal scrollback", () => {
  const body = Array.from({ length: 24 }, (_, index) => `capability line ${index + 1}`).join("\n");
  const entries = [
    { kind: "user", title: "user", body: "List your capabilities." },
    { kind: "assistant", title: "assistant", body },
    { kind: "turn", title: "completed", body: "outputBytes=894" }
  ];
  const bottom = transcriptViewport(entries, 6, 80, 0, "full");
  const review = transcriptViewport(entries, 6, 80, 5, "full");

  assert.equal(bottom.lines.length, 6);
  assert.ok(bottom.lines.some((item) => item.text.includes("capability line 24")));
  assert.equal(bottom.lines.some((item) => item.text.includes("outputBytes=894")), false);
  assert.ok(review.lines.some((item) => item.text.includes("capability line 19")));
  assert.ok(review.offset > 0);
});

test("transcript viewport annotates rows with entry metadata for message actions", () => {
  const entries = [
    { id: "u1", kind: "user", title: "user", body: "copy this" },
    { id: "a1", kind: "assistant", title: "assistant", body: "copied" }
  ];
  const viewport = transcriptViewport(entries, 10, 80, 0, "full");

  assert.ok(viewport.lines.some((item) => item.text.includes("copy this") && item.entryId === "u1"));
  assert.ok(viewport.lines.some((item) => item.text.includes("copied") && item.entryId === "a1"));
  assert.ok(viewport.lines.filter((item) => item.entryId === "u1").every((item) => item.selectable === true));
});

test("transcript viewport keeps resumed assistant content visible in compact mode", () => {
  const body = Array.from({ length: 20 }, (_, index) => `resumed line ${index + 1}`).join("\n");
  const entries = [
    { kind: "assistant", title: "assistant", body }
  ];
  const compact = transcriptViewport(entries, 60, 80, 0, "compact");
  const detailed = transcriptViewport(entries, 60, 80, 0, "detailed");

  assert.equal(compact.lines.some((item) => item.text.includes("已折叠")), false);
  assert.ok(compact.lines.some((item) => item.text.includes("resumed line 20")));
  assert.equal(detailed.lines.some((item) => item.text.includes("已折叠")), false);
  assert.ok(detailed.lines.some((item) => item.text.includes("resumed line 20")));
});

test("transcript detail modes collapse routine gateway and tool telemetry", () => {
  const entries = [
    { kind: "user", title: "你", body: "inspect the repo" },
    { kind: "turn", title: "turn 1", body: "promptBytes=16" },
    { kind: "gateway", title: "gateway round 1", body: "messages=2, toolResults=0" },
    { kind: "gateway", title: "gateway response 1", body: "textBytes=0, toolCalls=1, stop=tool_calls" },
    { kind: "tools", title: "requested", body: "read_file(path)" },
    { kind: "tool", title: "read_file", body: "running id=read-1, inputKeys=path" },
    { kind: "tool", title: "read_file done", body: "id=read-1, bytes=200" },
    { kind: "assistant", title: "assistant", body: "done" }
  ];

  const compact = transcriptViewport(entries, 30, 90, 0, "compact");
  const detailed = transcriptViewport(entries, 30, 90, 0, "detailed");
  const full = transcriptViewport(entries, 60, 90, 0, "full");
  const compactText = compact.lines.map((item) => item.text).join("\n");
  const detailedText = detailed.lines.map((item) => item.text).join("\n");
  const fullText = full.lines.map((item) => item.text).join("\n");

  assert.match(compactText, /inspect the repo/);
  assert.match(compactText, /done/);
  assert.doesNotMatch(compactText, /gateway round|read_file|运行过程/);
  assert.match(detailedText, /过程 - 已收起 6 条运行过程/);
  assert.match(detailedText, /Ctrl\+O 再按一次/);
  assert.doesNotMatch(detailedText, /id=read-1/);
  assert.match(fullText, /gateway round 1/);
  assert.match(fullText, /read_file done/);
});

test("failed and blocked tool telemetry remains visible in compact transcript mode", () => {
  const entries = [
    { kind: "user", title: "你", body: "write a file" },
    { kind: "tool", title: "write_file", body: "running id=write-1, inputKeys=path" },
    { kind: "tool", title: "write_file blocked", body: "id=write-1, decision=ask" },
    { kind: "assistant", title: "assistant", body: "需要权限。" }
  ];

  const compact = transcriptViewport(entries, 20, 90, 0, "compact");
  const text = compact.lines.map((item) => item.text).join("\n");

  assert.doesNotMatch(text, /running id=write-1/);
  assert.match(text, /\[blocked\] edit - write_file blocked/);
  assert.match(text, /需要权限/);
});

test("streaming viewport scrolls a long live assistant draft", () => {
  const text = Array.from({ length: 16 }, (_, index) => `live draft line ${index + 1}`).join("\n");
  const bottom = streamingViewport({
    active: true,
    phase: "answering",
    round: 3,
    text
  }, 6, 80, 0, 0, "compact");
  const review = streamingViewport({
    active: true,
    phase: "answering",
    round: 3,
    text
  }, 6, 80, 6, 0, "compact");

  assert.equal(bottom.lines.length, 6);
  assert.ok(bottom.lines.some((item) => item.text.includes("live draft line 16")));
  assert.ok(review.lines.some((item) => item.text.includes("live draft line 10")));
  assert.ok(review.offset > 0);
});

test("stream phases have user-facing labels for live turn rhythm", () => {
  assert.equal(streamPhaseLabel({ phase: "requesting" }), "等待模型");
  assert.equal(streamPhaseLabel({ phase: "streaming" }), "接收中");
  assert.equal(streamPhaseLabel({ phase: "streaming", thinkingBytes: 10 }), "思考中");
  assert.equal(streamPhaseLabel({ phase: "thinking", text: "draft" }), "生成回答");
  assert.equal(streamPhaseLabel({ phase: "tool-call" }), "准备工具");
  assert.equal(streamPhaseLabel({ phase: "interrupted" }), "已中断");
});
