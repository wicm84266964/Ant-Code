import React from "react";
import { Box, Text } from "ink";
import { listKeybindings } from "../../commands/registry.js";
import { buildTaskTree } from "../../agents/orchestrator.js";
import { summarizeContextWindow } from "../../core/context-window.js";
import { DEFAULT_TUI_THEME, themeColor } from "./theme.js";
import {
  colorForKind,
  detailModeLabel,
  exitConfirmLines,
  interruptConfirmLines,
  line,
  panelTitle,
  permissionModalLines,
  permissionModeDescription,
  permissionModeLabel,
  promptColor,
  promptLines,
  SIDE_VIEWS,
  splitLines,
  spinnerFrame,
  streamingViewport,
  startupBannerLines,
  startupConfirmLines,
  transcriptEntriesWithThinkingVisibility,
  transcriptViewport,
  transcriptBlockLines,
  truncate,
  truncateMiddle,
  trustDialogLines
} from "./format.js";

const h = React.createElement;
const WORKFLOW_FILTERS = Object.freeze(["incomplete", "completed", "all"]);
const WORKFLOW_FILTER_LABELS = Object.freeze({
  incomplete: "未完成",
  completed: "已完成",
  all: "全部"
});
const TASK_FILTERS = Object.freeze(["active", "issues", "completed", "all"]);
const TASK_FILTER_LABELS = Object.freeze({
  active: "活跃",
  issues: "暂停/失败",
  completed: "已完成",
  all: "全部"
});
const ACTIVE_TASK_STATUSES = new Set(["queued", "running"]);
const ISSUE_TASK_STATUSES = new Set(["partial", "failed", "blocked", "interrupted"]);
const COMPLETED_TASK_STATUSES = new Set(["completed"]);
const COMPLETED_WORKFLOW_STATUSES = new Set(["completed"]);

export function StatusBar({ session, cwd, activity, pulse = 0, detailMode = "compact", antState, width = 100, theme = DEFAULT_TUI_THEME }) {
  const gateway = session.config.lab.gatewayUrl
    ? `${session.config.lab.gatewayProtocol ?? "lab-agent-gateway"} configured`
    : "gateway missing";
  const context = summarizeContextWindow(session);
  const inputBrief = Number.isFinite(context.promptTokens)
    ? ` input ${formatTokenCount(context.promptTokens)}`
    : "";
  const providerBrief = Number.isFinite(context.providerPromptTokens)
    ? ` provider ${formatTokenCount(context.providerPromptTokens)}`
    : "";
  const contextBrief = `ctx≈${formatTokenCount(context.messageTokens)}/${formatTokenCount(primaryTokenLimit(context))}${inputBrief}${providerBrief} tok c${context.compacted}`;
  const activityPrefix = isStaticActivityStatus(activity.status)
    ? ""
    : `${spinnerFrame(pulse)} `;
  const cwdWidth = Math.min(44, Math.max(18, Math.floor(width * 0.35)));
  const statusWidth = Math.max(24, width - cwdWidth - 12);
  const statusText = truncateMiddle(` v1.1 - ${activityPrefix}${activity.status} - ${session.model} - ${contextBrief} - ${gateway} - ${permissionModeLabel(session)} - ${session.networkMode} - ${detailModeLabel(detailMode)} - events=${activity.eventCount ?? 0}`, statusWidth);
  return h(Box, { paddingX: 1, justifyContent: "space-between" },
    h(Text, null,
      h(Text, { color: themeColor(theme, "identity", "cyan"), bold: true }, "Ant Code"),
      h(Text, { dimColor: true }, statusText)
    ),
    h(Text, { dimColor: true }, truncateMiddle(cwd, cwdWidth))
  );
}

function isStaticActivityStatus(status) {
  const value = String(status ?? "idle");
  return value === "idle"
    || value === "ready"
    || value === "就绪"
    || value === "已中断"
    || value === "正在中断"
    || value === "已请求中断"
    || value === "已停止当前轮次"
    || value === "静默待机"
    || value === "已唤醒"
    || value.startsWith("再次按");
}

export function LogPane({ entries, width, height, stream, pulse = 0, detailMode = "compact", thinkingVisible = false, scrollOffset = 0, streamScrollOffset = 0, scrollbackMode = false, selectedEntryId = null, theme = DEFAULT_TUI_THEME }) {
  const initialLayout = resolveLogPaneLayout({
    height,
    streamActive: Boolean(stream?.active),
    scrollbackMode
  });
  const liveRows = initialLayout.liveRows;
  const viewportRows = initialLayout.viewportRows;
  const displayEntries = transcriptEntriesWithThinkingVisibility(entries, thinkingVisible);
  const viewportProbe = transcriptViewport(displayEntries, viewportRows, width, scrollOffset, detailMode);
  const { displayRows } = resolveLogPaneLayout({
    height,
    streamActive: Boolean(stream?.active),
    scrollbackMode,
    transcriptTotalRows: viewportProbe.totalRows
  });
  const viewport = transcriptViewport(displayEntries, displayRows, width, scrollOffset, detailMode);
  const paddedLines = [
    ...viewport.lines,
    ...Array.from({ length: scrollbackMode ? 0 : Math.max(0, viewportRows - viewport.lines.length) }, () => line(""))
  ];
  const counter = viewport.totalRows === 0
    ? "0 rows"
    : `${viewport.firstRow}-${viewport.lastRow}/${viewport.totalRows}${viewport.offset > 0 ? ` +${viewport.offset}` : scrollbackMode ? " scrollback" : " bottom"}`;
  const readingHistory = viewport.offset > 0;
  const boxProps = {
    flexDirection: "column",
    width,
    borderStyle: "round",
    borderColor: themeColor(theme, "border", "gray"),
    paddingX: 1
  };
  if (!scrollbackMode) {
    boxProps.height = height;
  }
  return h(Box, {
    ...boxProps
  },
    h(Box, { justifyContent: "space-between" },
      h(Text, { color: themeColor(theme, "conversation", "white") }, "会话"),
      h(Text, { dimColor: true }, counter)
    ),
    readingHistory ? h(Text, { color: themeColor(theme, "warning", "yellow"), wrap: "truncate" }, "正在查看历史；新输出不会强制拉回底部。PgDn/滚轮向下可回到最新。") : null,
    viewport.totalRows === 0
      ? h(Text, { dimColor: true }, "暂无会话内容。输入 /help 或直接输入提示开始。")
      : h(Box, { flexDirection: "row", flexShrink: 0 },
        h(Box, { flexDirection: "column", width: Math.max(1, width - 6), flexShrink: 1 },
          paddedLines.map((item, index) => {
            const selected = selectedEntryId && item.entryId === selectedEntryId;
            return h(Text, {
              key: `${viewport.firstRow}-${index}`,
              wrap: "truncate",
              color: selected ? themeColor(theme, "selection", "cyan") : themedLineColor(theme, item.color),
              dimColor: selected ? false : item.dim,
              inverse: Boolean(selected)
            }, item.text || " ");
          })
        ),
        h(Box, { flexDirection: "column", width: 1, marginLeft: 1, flexShrink: 0 },
          transcriptScrollBar(viewport, paddedLines.length).map((item, index) => h(Text, {
            key: `scroll-${index}`,
            color: item.active ? themeColor(theme, "accent", "cyan") : themeColor(theme, "border", "gray"),
            dimColor: !item.active
          }, item.char))
        )
      ),
    stream?.active ? h(LiveStreamEntry, {
      stream: { ...stream, thinkingVisible },
      pulse,
      detailMode,
      width,
      visibleRows: liveRows,
      scrollOffset: streamScrollOffset,
      scrollbackMode,
      theme
    }) : null
  );
}

export function resolveLogPaneLayout({ height, streamActive = false, scrollbackMode = false, transcriptTotalRows = 0 } = {}) {
  const safeHeight = Math.max(1, Number(height) || 1);
  const liveRows = streamActive
    ? scrollbackMode
      ? Math.max(10, Math.min(120, safeHeight * 4))
      : Math.min(Math.max(5, Math.floor(safeHeight * 0.45)), Math.max(5, safeHeight - 5))
    : 0;
  const viewportRows = Math.max(1, safeHeight - 3 - (scrollbackMode ? 0 : liveRows));
  const totalRows = Math.max(0, Number(transcriptTotalRows) || 0);
  const displayRows = scrollbackMode
    ? Math.max(viewportRows, totalRows || viewportRows)
    : viewportRows;

  return {
    liveRows,
    viewportRows,
    displayRows,
    fixedHeight: !scrollbackMode
  };
}

export function transcriptScrollBar(viewport = {}, rows = 1) {
  const height = Math.max(1, Number(rows) || 1);
  const totalRows = Math.max(0, Number(viewport.totalRows) || 0);
  const visibleRows = Math.max(1, Math.min(height, Number(viewport.lastRow) - Number(viewport.firstRow) + 1 || height));
  if (totalRows <= height) {
    return Array.from({ length: height }, () => ({ char: " ", active: false }));
  }
  const thumbRows = Math.max(1, Math.min(height, Math.round((visibleRows / totalRows) * height)));
  const maxStart = Math.max(0, height - thumbRows);
  const scrollableRows = Math.max(1, totalRows - visibleRows);
  const topRows = Math.max(0, Number(viewport.firstRow || 1) - 1);
  const thumbStart = Math.max(0, Math.min(maxStart, Math.round((topRows / scrollableRows) * maxStart)));
  return Array.from({ length: height }, (_, index) => {
    const active = index >= thumbStart && index < thumbStart + thumbRows;
    return { char: active ? "█" : "│", active };
  });
}

export function SidePanel({ view, session, activity, sidePanelOffset = 0, taskRecords, taskGroupRecords, workflowFilter = "incomplete", taskFilter = "active", visibleRows, width, height, theme = DEFAULT_TUI_THEME }) {
  const body = view === "workflow"
      ? workflowPanelLines(session, workflowFilter)
      : view === "tasks"
        ? taskPanelLines(taskRecords, taskFilter, taskGroupRecords)
        : statusPanelLines(session, activity);
  const headerRows = 1;
  const viewportRows = Math.max(1, (Number(visibleRows) || 12) - headerRows);
  const viewport = sidePanelViewport(body, viewportRows, sidePanelOffset);

  return h(Box, {
    flexDirection: "column",
    width,
    height,
    minHeight: Math.min(8, Math.max(1, Number(height) || 8)),
    flexShrink: 0,
    borderStyle: "round",
    borderColor: themedSideColor(theme, view),
    paddingX: 1,
    marginLeft: 1
  },
    h(Text, { color: themedSideColor(theme, view), bold: true, wrap: "truncate" }, sidePanelTabsText(view)),
    ...viewport.visible.map((item, index) => h(Text, { key: index, wrap: "truncate", dimColor: item.dim, color: item.color }, item.text)),
    viewport.hiddenRows > 0
      ? h(Text, { dimColor: true }, `... 还有 ${viewport.hiddenRows} 行，滚轮查看`)
      : null
  );
}

export function sidePanelTabsText(activeView) {
  return SIDE_VIEWS.map((view) => view === activeView
    ? `[${panelTitle(view)}]`
    : panelTitle(view)).join(" ");
}

export function sidePanelViewport(lines = [], visibleRows = 12, offset = 0) {
  const all = Array.isArray(lines) ? lines : [];
  const rowBudget = Math.max(1, Number(visibleRows) || 12);
  const footerRows = all.length > rowBudget ? 1 : 0;
  const bodyRows = Math.max(1, rowBudget - footerRows);
  const maxOffset = Math.max(0, all.length - bodyRows);
  const safeOffset = Math.min(maxOffset, Math.max(0, Number(offset) || 0));
  const visible = all.slice(safeOffset, safeOffset + bodyRows);
  return {
    visible,
    hiddenRows: Math.max(0, all.length - safeOffset - visible.length),
    totalRows: all.length,
    offset: safeOffset,
    maxOffset,
    rowBudget
  };
}

export function CompactSideSummary({ session, activity }) {
  const context = summarizeContextWindow(session);
  const inputBrief = Number.isFinite(context.promptTokens)
    ? ` | 最近输入=${formatTokenCount(context.promptTokens)}`
    : "";
  const providerBrief = Number.isFinite(context.providerPromptTokens)
    ? ` | Provider=${formatProviderUsageBrief(context)}`
    : "";
  return h(Box, { paddingX: 1 },
    h(Text, { dimColor: true },
      `状态=${activity.status} | 模型上下文=${formatTokenCount(context.messageTokens)}/${formatTokenCount(primaryTokenLimit(context))} tokens（估算）${inputBrief}${providerBrief} 压缩=${context.compacted} | 轮次=${session.turnCount} | 工具=${activity.toolCount} | 审批=${activity.approvalCount}`)
  );
}

export function StartupSplash({ session, theme = DEFAULT_TUI_THEME }) {
  const lines = startupBannerLines(session);
  return h(Box, { flexDirection: "column", paddingX: 1, paddingY: 1, width: "100%" },
    ...lines.map((item, index) => h(Text, {
      key: index,
      color: index < 5 ? themeColor(theme, "identity", "cyan") : index === 6 ? themeColor(theme, "success", "green") : undefined,
      dimColor: index > 6,
      wrap: "wrap"
    }, item || " "))
  );
}

function LogEntry({ entry, theme = DEFAULT_TUI_THEME }) {
  if (entry.kind === "startup") {
    return h(StartupEntry, { entry, theme });
  }
  return h(TranscriptEntry, { entry, theme });
}

function StartupEntry({ entry, theme = DEFAULT_TUI_THEME }) {
  const body = visibleBodyLines(entry.body);
  return h(Box, { flexDirection: "column", marginBottom: 1, paddingY: 1 },
    ...body.map((item, index) => h(Text, {
      key: index,
      color: index < 5 ? themeColor(theme, "identity", "cyan") : index === 6 ? themeColor(theme, "success", "green") : undefined,
      dimColor: index > 6,
      wrap: "wrap"
    }, `  ${item}`))
  );
}

function ConversationEntry({ entry, theme = DEFAULT_TUI_THEME }) {
  const label = entry.kind === "user" ? "you" : "ant-code";
  const body = visibleBodyLines(entry.body);
  return h(Box, { flexDirection: "column", marginBottom: 1 },
    h(Text, { color: themedKindColor(theme, entry.kind) }, `${label}`),
    ...(body.length === 0
      ? [h(Text, { key: "empty", dimColor: true }, "  [empty]")]
      : body.map((item, index) => h(Text, { key: index, wrap: "wrap" }, `  ${item}`)))
  );
}

function LiveStreamEntry({ stream, pulse, detailMode, width = 80, visibleRows = 5, scrollOffset = 0, scrollbackMode = false, theme = DEFAULT_TUI_THEME }) {
  const rowBudget = Math.max(1, visibleRows - 2);
  const viewport = streamingViewport(stream, rowBudget, width, scrollOffset, pulse, detailMode);
  const lines = viewport.lines;
  const counter = viewport.totalRows === 0
    ? "0 rows"
    : `${viewport.firstRow}-${viewport.lastRow}/${viewport.totalRows}${viewport.offset > 0 ? ` +${viewport.offset}` : scrollbackMode ? " scrollback" : " live"}`;
  return h(Box, { flexDirection: "column", marginBottom: 1 },
    h(Box, { justifyContent: "space-between" },
      h(Text, { color: themeColor(theme, "assistant", "green") }, `ant-code ${spinnerFrame(pulse)}`),
      h(Text, { dimColor: true }, counter)
    ),
    ...(lines.length === 0
      ? [h(Text, { key: "draft-empty", dimColor: true }, "  正在接收响应...")]
      : lines.map((item, index) => h(Text, {
        key: index,
        wrap: "wrap",
        color: themedLineColor(theme, item.color),
        dimColor: item.dim
      }, `  ${item.text}`)))
  );
}

function TranscriptEntry({ entry, theme = DEFAULT_TUI_THEME }) {
  const lines = transcriptBlockLines(entry);
  return h(Box, { flexDirection: "column", marginBottom: 1 },
    ...lines.map((item, index) => h(Text, {
      key: index,
      wrap: "wrap",
      color: themedLineColor(theme, item.color),
      dimColor: item.dim
    }, index === 0 ? item.text : item.text))
  );
}

function OutputEntry({ entry, theme = DEFAULT_TUI_THEME }) {
  const body = visibleBodyLines(entry.body);
  return h(Box, { flexDirection: "column", marginBottom: 1 },
    h(Text, { color: themeColor(theme, "command", "cyan") }, entry.title),
    ...body.map((item, index) => h(Text, {
      key: index,
      wrap: "wrap",
      dimColor: index > 8
    }, `  ${item}`))
  );
}

function MetaEntry({ entry, theme = DEFAULT_TUI_THEME }) {
  const summary = metaSummary(entry);
  const color = themedKindColor(theme, entry.kind);
  return h(Box, { marginBottom: 0 },
    h(Text, { color, dimColor: entry.kind !== "error" && entry.kind !== "approval" },
      `[${entry.at}] ${entry.kind}: ${summary}`)
  );
}

export function SlashPalette({ palette, index = 0, width, height, visibleRows, theme = DEFAULT_TUI_THEME }) {
  if (!palette || !Array.isArray(palette.commands) || palette.commands.length === 0) {
    return null;
  }
  const rowBudget = Math.max(5, Number(visibleRows ?? height) || 11);
  const itemBudget = Math.max(1, rowBudget - 4);
  const start = Math.min(Math.max(0, index - Math.max(0, itemBudget - 2)), Math.max(0, palette.commands.length - itemBudget));
  const visible = palette.commands.slice(start, start + itemBudget);
  return h(Box, { flexDirection: "column", width, height: rowBudget, flexShrink: 0, borderStyle: "round", borderColor: themeColor(theme, "command", "cyan"), paddingX: 1 },
    h(Box, { justifyContent: "space-between" },
      h(Text, { color: themeColor(theme, "command", "cyan"), bold: true, wrap: "truncate" }, `斜杠命令${palette.query ? `: ${palette.query}` : ""}`),
      h(EscapeAction, { theme, label: "Esc 关闭" })
    ),
    h(Text, { color: themeColor(theme, "warning", "yellow"), wrap: "truncate" }, "↑/↓ 选择，Enter 执行；继续输入可过滤命令。"),
    ...visible.map((command, itemIndex) => {
      const absoluteIndex = start + itemIndex;
      const focused = absoluteIndex === index;
      const marker = focused ? ">" : " ";
      const disabled = Boolean(command.disabledReason);
      return h(Text, {
        key: command.name,
        wrap: "truncate",
        color: focused ? themeColor(theme, "selection", "cyan") : disabled ? themeColor(theme, "warning", "yellow") : undefined,
        dimColor: !focused && disabled
      }, `${marker} /${command.name} - ${command.description}${disabled ? ` (${command.disabledReason})` : ""}`);
    }),
    palette.commands.length > visible.length
      ? h(Text, { dimColor: true }, `  ${start + 1}-${start + visible.length} / ${palette.commands.length}`)
      : null
  );
}

export function FileMentionPalette({ state, candidates, index = 0, width, height, visibleRows, theme = DEFAULT_TUI_THEME }) {
  if (!state) {
    return null;
  }
  const list = candidates ?? [];
  const rowBudget = Math.max(5, Number(visibleRows ?? height) || 11);
  const itemBudget = Math.max(1, rowBudget - 4);
  const start = Math.min(Math.max(0, index - Math.max(0, itemBudget - 2)), Math.max(0, list.length - itemBudget));
  const visible = list.slice(start, start + itemBudget);
  return h(Box, { flexDirection: "column", width, height: rowBudget, flexShrink: 0, borderStyle: "round", borderColor: themeColor(theme, "file", "yellow"), paddingX: 1 },
    h(Text, { color: themeColor(theme, "file", "yellow"), wrap: "truncate" }, `文件${state.fragment ? `: ${state.fragment}` : ""}`),
    visible.length === 0
      ? h(Text, { dimColor: true }, "  暂无匹配的工作区文件。")
      : visible.map((candidate, itemIndex) => {
        const absoluteIndex = start + itemIndex;
        const focused = absoluteIndex === index;
        const marker = focused ? ">" : " ";
        const suffix = candidate.type === "directory" ? "/" : "";
        const label = candidate.label ?? candidate.type ?? "file";
        const match = candidate.recent ? " recent" : candidate.match && candidate.match !== "workspace" ? ` ${candidate.match}` : "";
        return h(Text, {
          key: candidate.path,
          wrap: "truncate",
          color: focused ? themeColor(theme, "selection", "yellow") : undefined,
          dimColor: candidate.type !== "file" && !focused
        }, `${marker} [${label}] ${candidate.path}${suffix}${match}`);
      }),
    h(Text, { dimColor: true }, "  已跳过 .git、node_modules、dist 和 .lab-agent")
  );
}

export function QueuedPromptLine({ queuedPrompts, theme = DEFAULT_TUI_THEME }) {
  const queued = queuedPrompts ?? [];
  if (queued.length === 0) {
    return null;
  }
  return h(Box, { paddingX: 1 },
    h(Text, { color: themeColor(theme, "accent", "magenta") },
      `已排队 ${queued.length}：${truncate(queued[0], 90)}${queued.length > 1 ? ` (+${queued.length - 1})` : ""}`)
  );
}

export function ModelPicker({ models, currentModel, index = 0, width, height, visibleRows, theme = DEFAULT_TUI_THEME }) {
  const list = models ?? [];
  if (list.length === 0) {
    return null;
  }
  const rowBudget = Math.max(6, Number(visibleRows ?? height) || 12);
  const itemBudget = Math.max(1, rowBudget - 4);
  const start = Math.min(Math.max(0, index - Math.max(0, itemBudget - 2)), Math.max(0, list.length - itemBudget));
  const visible = list.slice(start, start + itemBudget);
  return h(Box, { flexDirection: "column", width, height: rowBudget, flexShrink: 0, borderStyle: "round", borderColor: themeColor(theme, "model", "green"), paddingX: 1 },
    h(Box, { justifyContent: "space-between" },
      h(Text, { color: themeColor(theme, "model", "green"), wrap: "truncate" }, "选择模型"),
      h(Text, { dimColor: true, wrap: "truncate" }, "Enter 切换 | Esc 关闭")
    ),
    ...visible.map((model, itemIndex) => {
      const absoluteIndex = start + itemIndex;
      const focused = absoluteIndex === index;
      const active = model.id === currentModel;
      const marker = focused ? ">" : active ? "*" : " ";
      const thinking = model.thinking ? " thinking" : "";
      const context = Number.isFinite(model.contextTokens) ? ` context=${formatTokenCount(model.contextTokens)}` : "";
      return h(Text, {
        key: model.id,
        wrap: "truncate",
        color: focused ? themeColor(theme, "selection", "green") : active ? themeColor(theme, "identity", "cyan") : undefined,
        dimColor: !focused && !active
      }, `${marker} ${model.id}${thinking}${context} - ${model.description}`);
    }),
    h(Text, { dimColor: true }, "  模型是本地网关别名；原始 thinking 默认隐藏，可用 /thinking 展开，随本地 transcript 保存。")
  );
}

export function CommandPanel({ panel, offset = 0, visibleRows = 12, width, height, theme = DEFAULT_TUI_THEME }) {
  if (!panel) {
    return null;
  }
  const { lines, visible, boundedOffset, firstRow, lastRow, totalRows } = commandPanelViewport(panel, offset, visibleRows);
  if (panel.borderless) {
    return BorderlessCommandPanel({
      panel,
      visible,
      lines,
      firstRow,
      lastRow,
      totalRows,
      width,
      height,
      theme
    });
  }
  const tabs = panel.tabs ?? [];
  const rowBudget = Number(height) || undefined;
  const escLabel = commandPanelEscLabel(panel.footer);
  const footerText = commandPanelFooterText(panel.footer);
  const titleText = panel.subtitle ? `${panel.title ?? "命令"} - ${panel.subtitle}` : panel.title ?? "命令";
  const bodyWrap = panel.wrap ?? "truncate";
  return h(Box, {
    flexDirection: "column",
    width,
    height: rowBudget,
    flexShrink: 0,
    borderStyle: "round",
    borderColor: themedPanelKindColor(theme, panel.kind),
    paddingX: 1
  },
    h(Box, { justifyContent: "space-between" },
      h(Text, { color: themedPanelKindColor(theme, panel.kind), bold: true, wrap: "truncate" }, truncate(titleText, 92)),
      h(EscapeAction, { theme, label: escLabel })
    ),
    tabs.length > 0 ? h(Text, { dimColor: true, wrap: "truncate" },
      tabs.map((tab, index) => index === panel.tabIndex ? `[${tab}]` : ` ${tab} `).join("  ")
    ) : null,
    ...visible.map((item, index) => h(Text, {
      key: `${boundedOffset}-${index}`,
      wrap: bodyWrap,
      color: themedLineColor(theme, item.color),
      dimColor: item.dim
    }, item.text || " ")),
    lines.length > visible.length ? h(Text, { dimColor: true, wrap: "truncate" },
      `  显示第 ${firstRow}-${lastRow} 行，共 ${totalRows} 行`
    ) : null,
    h(Box, { justifyContent: "space-between" },
      h(Text, { dimColor: true, wrap: "truncate" }, footerText || " "),
      h(EscapeAction, { theme, label: escLabel })
    )
  );
}

function BorderlessCommandPanel({ panel, visible, lines, firstRow, lastRow, totalRows, width, height, theme = DEFAULT_TUI_THEME }) {
  const rowBudget = Number(height) || undefined;
  const footerText = commandPanelFooterText(panel.footer);
  const paddingX = panel.kind === "message-excerpt" ? 0 : 1;
  return h(Box, {
    flexDirection: "column",
    width,
    height: rowBudget,
    flexShrink: 0,
    paddingX
  },
    ...visible.map((item, index) => h(Text, {
      key: `${firstRow}-${index}`,
      wrap: "truncate",
      color: themedLineColor(theme, item.color),
      dimColor: item.dim
    }, item.text || " ")),
    lines.length > visible.length ? h(Text, { dimColor: true, wrap: "truncate" },
      `显示第 ${firstRow}-${lastRow} 行，共 ${totalRows} 行`
    ) : null,
    h(Text, { dimColor: true, wrap: "truncate" }, footerText || " ")
  );
}

export function commandPanelViewport(panel, offset = 0, visibleRows = 12) {
  const lines = panel?.lines ?? [];
  const rowBudget = Math.max(4, Number(visibleRows) || 12);
  const maxOffset = Math.max(0, lines.length - rowBudget);
  const boundedOffset = Math.min(Math.max(0, Number(offset) || 0), maxOffset);
  const visible = lines.slice(boundedOffset, boundedOffset + rowBudget);
  return {
    lines,
    visible,
    boundedOffset,
    maxOffset,
    totalRows: lines.length,
    firstRow: lines.length === 0 ? 0 : boundedOffset + 1,
    lastRow: boundedOffset + visible.length
  };
}

export function PromptBox({ mode, busy, inputBuffer, inputCursor, questionBuffer, questionCursor, queuedPrompts, pendingApproval, pendingQuestion, pulse = 0, width, height, theme = DEFAULT_TUI_THEME }) {
  const colorToken = promptColor(mode, busy);
  const color = themedPromptColor(theme, colorToken);
  const showCursor = Math.floor(pulse / 2) % 2 === 0;
  const draftColumns = Math.max(8, Number(width) - 4);
  const maxPromptLines = Math.max(1, Number(height) - 2);
  const lines = promptLines(mode, busy, inputBuffer, questionBuffer, { queuedPrompts, pendingApproval, pendingQuestion, inputCursor, questionCursor, showCursor, draftColumns, maxPromptLines });
  return h(Box, { flexDirection: "column", width, height, flexShrink: 0, borderStyle: "round", borderColor: color, paddingX: 1 },
    ...lines.map((item, index) => h(Text, {
      key: index,
      wrap: "truncate",
      color: item.color ? themedLineColor(theme, item.color) : index === 0 ? color : undefined,
      dimColor: index > 0 && item.dim
    }, item.segments ? renderSegments(item.segments, theme, color) : item.text))
  );
}

export function PermissionModal({ pendingApproval, focusedIndex = 0, width, height, theme = DEFAULT_TUI_THEME }) {
  if (!pendingApproval) {
    return null;
  }
  const lines = permissionModalLines(pendingApproval, focusedIndex);
  return h(Box, {
    flexDirection: "column",
    width,
    height,
    flexShrink: 0,
    borderStyle: "round",
    borderColor: themeColor(theme, "approval", "yellow"),
    paddingX: 1
  },
    ...lines.map((item, index) => h(Text, {
      key: index,
      wrap: "truncate",
      color: themedLineColor(theme, item.color),
      dimColor: item.dim
    }, item.text || " "))
  );
}

export function ExitConfirmNotice({ active, busy = false, theme = DEFAULT_TUI_THEME }) {
  if (!active) {
    return null;
  }
  const lines = exitConfirmLines({ busy });
  return h(Box, {
    flexDirection: "column",
    borderStyle: "round",
    borderColor: themeColor(theme, "danger", "red"),
    paddingX: 1
  },
    ...lines.map((item, index) => h(Text, {
      key: index,
      color: index === 0 ? themeColor(theme, "danger", "red") : undefined,
      dimColor: index > 0
    }, item))
  );
}

export function InterruptConfirmNotice({ active, theme = DEFAULT_TUI_THEME }) {
  if (!active) {
    return null;
  }
  const lines = interruptConfirmLines();
  return h(Box, {
    flexDirection: "column",
    borderStyle: "round",
    borderColor: themeColor(theme, "warning", "yellow"),
    paddingX: 1
  },
    ...lines.map((item, index) => h(Text, {
      key: index,
      color: index === 0 ? themeColor(theme, "warning", "yellow") : undefined,
      dimColor: index > 0
    }, item))
  );
}

export function FooterBar({ sideView, wide, detailMode = "compact", thinkingVisible = false }) {
  return h(Box, { paddingX: 1, height: 1, flexShrink: 0 },
    h(Text, { dimColor: true, wrap: "truncate" }, footerHintText({ sideView, wide, detailMode, thinkingVisible }))
  );
}

export function PermissionFooter({ session, width = 100, theme = DEFAULT_TUI_THEME }) {
  const mode = session?.permissionMode ?? (session?.fullAccess ? "fullAccess" : session?.allowWrite || session?.allowCommand ? "workspace" : "plan");
  const color = permissionFooterColor(mode, theme);
  const readonlyLocked = session?.permissionReadonlyLocked || session?.readonly;
  const switchHint = "Shift+Tab 切换";
  const label = `权限：${permissionModeLabel(session)}`;
  const detail = readonlyLocked ? " / 只读锁定" : ` / ${permissionModeDescription(mode)}`;
  const safeWidth = Math.max(20, Number(width) || 100);
  const compact = safeWidth < 54;
  const renderedHint = compact ? "S+Tab" : switchHint;
  const detailWidth = compact ? 0 : Math.max(0, safeWidth - label.length - renderedHint.length - 8);
  return h(Box, { paddingX: 1, height: 1, flexShrink: 0, justifyContent: "space-between" },
    h(Text, null,
      h(Text, { color, bold: true }, label),
      compact ? null : h(Text, { dimColor: true }, truncateSingleLine(detail, detailWidth))
    ),
    h(Text, { dimColor: true }, renderedHint)
  );
}

function truncateSingleLine(value, max) {
  const text = String(value ?? "");
  const width = Math.max(0, Number(max) || 0);
  if (width <= 0) {
    return "";
  }
  if (text.length <= width) {
    return text;
  }
  if (width <= 3) {
    return ".".repeat(width);
  }
  return `${text.slice(0, width - 3)}...`;
}

function permissionFooterColor(mode, theme) {
  if (mode === "fullAccess") {
    return themeColor(theme, "danger", "red");
  }
  if (mode === "workspace") {
    return themeColor(theme, "warning", "yellow");
  }
  return themeColor(theme, "success", "green");
}

export function footerHintText({ sideView, wide, detailMode = "compact", thinkingVisible = false } = {}) {
  const sideHint = wide ? sideFooterHint(sideView) : "宽终端会显示侧边栏";
  const byId = keybindingMap();
  return `${sideHint} | 单击消息提示，双击进入摘录面板 | ${byId.wheel.key}/PageUp/PageDown 滚动 | /logs 运行日志 | /guide 响应后引导，/guide 停止只中断 | /thinking=${thinkingVisible ? "显示" : "隐藏"} | ${byId.close.key} 两次/${byId.interrupt.key} 中断 | ${byId["permission-mode"].key} 权限 | ${byId["transcript-detail"].key}=${detailModeLabel(detailMode)} | ${byId.exit.key} 两次退出`;
}

function sideFooterHint(sideView) {
  const base = `侧栏：Tab 切换栏，←/→ 分类，当前 ${panelTitle(sideView)}`;
  if (sideView === "status") {
    return `${base}，/context 或 /usage 查看完整用量`;
  }
  return base;
}

function keybindingMap() {
  return Object.fromEntries(listKeybindings().map((item) => [item.id, item]));
}

export function StartupConfirmDialog({ cwd, trusted, workspaceDiagnostic = null, theme = DEFAULT_TUI_THEME }) {
  const lines = startupConfirmLines(cwd, trusted, workspaceDiagnostic);
  return h(Box, {
    flexDirection: "column",
    borderStyle: "round",
    borderColor: themeColor(theme, "identity", "cyan"),
    paddingX: 2,
    paddingY: 1,
    width: "100%"
  },
    ...lines.map((item, index) => h(Text, {
      key: index,
      color: index === 0 ? themeColor(theme, "identity", "cyan") : undefined,
      dimColor: index > 0 && item.length === 0 ? true : undefined,
      wrap: "wrap"
    }, item || " "))
  );
}

export function TrustDialog({ cwd, status, theme = DEFAULT_TUI_THEME }) {
  const lines = trustDialogLines(cwd, status);
  return h(Box, {
    flexDirection: "column",
    borderStyle: "round",
    borderColor: status === "error" ? themeColor(theme, "danger", "red") : themeColor(theme, "warning", "yellow"),
    paddingX: 2,
    paddingY: 1,
    width: "100%"
  },
    ...lines.map((item, index) => h(Text, {
      key: index,
      color: index === 0 ? themeColor(theme, "warning", "yellow") : undefined,
      dimColor: index > 0 && item.length === 0 ? true : undefined,
      wrap: "wrap"
    }, item || " "))
  );
}

function statusPanelLines(session, activity) {
  const context = summarizeContextWindow(session);
  const workflow = session.workflow ?? {};
  return [
    line("会话", true),
    line(`id: ${truncate(session.id, 18)}`),
    line(`轮次：${session.turnCount}`),
    line(`模型：${session.model}`),
    line(`网络：${session.networkMode}`),
    line(`敏感级别：${session.sensitivity}`),
    line(`权限：${permissionModeLabel(session)}`),
    line(permissionModeDescription(session.permissionMode ?? "plan"), true),
    line(""),
    line("上下文", true),
    line(`模型上下文：${formatTokenCount(context.messageTokens)}/${formatTokenCount(primaryTokenLimit(context))} tokens（本地估算）`),
    ...(Number.isFinite(context.promptTokens)
      ? [line(`最近模型输入：${formatTokenCount(context.promptTokens)}/${formatTokenCount(primaryTokenLimit(context))} tokens（本地估算）`, true)]
      : []),
    ...providerStatusLines(context),
    line(`模型消息链：${formatTokenCount(context.messageTokens)} tokens`, true),
    ...(context.promptTokens
      ? [
          line(`拆分：消息 ${formatTokenCount(context.promptMessageTokens)} / 工具定义 ${formatTokenCount(context.promptToolSchemaTokens)} / 工具结果 ${formatTokenCount(context.promptToolResultTokens)}`, true)
        ]
      : []),
    line(`模型窗口：${context.modelMaxTokens ? `${formatTokenCount(context.modelMaxTokens)} tokens` : "未配置"}`),
    line(`本地压缩阈值：${formatTokenCount(context.maxTokens)} tokens`),
    line(`压缩：${context.compacted}`),
    line(`摘要：${formatTokenCount(context.summaryTokens)} tokens`),
    line(""),
    line("活动", true),
    line(`网关：${activity.gateway}`),
    line(`最近网关：${activity.lastGateway}`),
    line(`最近工具：${activity.lastTool}`),
    line(`流式字节：${activity.streamBytes ?? 0}`),
    line(`thinking 字节：${activity.thinkingBytes ?? 0}`),
    line(`工具：${activity.toolCount}`),
    line(`阻止：${activity.blockedTools}`),
    line(`失败：${activity.failedTools}`),
    line(`审批：${activity.approvalCount}`),
    line(""),
    line("工作流", true),
    line(`待办：${workflow.todos?.length ?? 0}`),
    line(`计划步骤：${workflow.plan?.steps?.length ?? 0}`),
    line(`改动：${workflow.changes?.length ?? 0}`),
    line(`验证：${workflow.validations?.length ?? 0}`),
    line("")
  ];
}

function workflowPanelLines(session, filter = "incomplete") {
  const workflow = session.workflow ?? {};
  const todos = Array.isArray(workflow.todos) ? workflow.todos : [];
  const steps = Array.isArray(workflow.plan?.steps) ? workflow.plan.steps : [];
  const changes = Array.isArray(workflow.changes) ? workflow.changes : [];
  const validations = Array.isArray(workflow.validations) ? workflow.validations : [];
  const latestChanges = changes.slice(-5).reverse();
  const latestValidations = validations.slice(-5).reverse();
  const selectedFilter = normalizeWorkflowFilter(filter);
  const visibleTodos = filterWorkflowItems(todos, selectedFilter);
  const visibleSteps = filterWorkflowItems(steps, selectedFilter);
  return [
    line(sideSubtabsText(WORKFLOW_FILTERS, WORKFLOW_FILTER_LABELS, selectedFilter), true, "green"),
    line("待办", true),
    ...(visibleTodos.length === 0
      ? [line(selectedFilter === "all" ? "暂无待办。" : "此分类暂无待办。", true)]
      : visibleTodos.map((todo, index) => line(`${index + 1}. ${statusMark(todo.status)} ${truncate(workflowItemText(todo), 72)}`))),
    line(""),
    line("计划", true),
    ...(workflow.plan?.explanation ? [line(truncate(workflow.plan.explanation, 82), true)] : []),
    ...(visibleSteps.length === 0
      ? [line(selectedFilter === "all" ? "暂无计划步骤。" : "此分类暂无计划步骤。", true)]
      : visibleSteps.map((step, index) => line(`${index + 1}. ${statusMark(step.status)} ${truncate(workflowItemText(step), 72)}`))),
    line(""),
    line("改动", true),
    ...(latestChanges.length === 0
      ? [line("暂无文件改动记录。", true)]
      : latestChanges.map((change) => {
        const flags = [
          change.created ? "新建" : null,
          change.edited ? "编辑" : null,
          change.diffTruncated ? "diff截断" : null
        ].filter(Boolean).join(",");
        return line(`${flags || "改动"} ${truncate(change.path ?? "", 76)}`);
      })),
    line(""),
    line("验证", true),
    ...(latestValidations.length === 0
      ? [line("暂无验证记录。", true)]
      : latestValidations.map((validation) => line(`${validation.passed ? "[ok]" : "[fail]"} ${truncate(validation.command ?? validation.toolName ?? "", 76)}`)))
  ];
}

function workflowItemText(item) {
  return String(item?.content ?? item?.title ?? item?.text ?? "");
}

function sideSubtabsText(filters, labels, active) {
  return filters.map((filter) => filter === active
    ? `[${labels[filter] ?? filter}]`
    : labels[filter] ?? filter).join(" ");
}

function normalizeWorkflowFilter(value) {
  return WORKFLOW_FILTERS.includes(value) ? value : WORKFLOW_FILTERS[0];
}

function filterWorkflowItems(items, filter) {
  const list = Array.isArray(items) ? items : [];
  if (filter === "all") {
    return list;
  }
  if (filter === "completed") {
    return list.filter((item) => COMPLETED_WORKFLOW_STATUSES.has(normalizeWorkflowStatus(item?.status)));
  }
  return list.filter((item) => !COMPLETED_WORKFLOW_STATUSES.has(normalizeWorkflowStatus(item?.status)));
}

function normalizeWorkflowStatus(status) {
  const value = String(status ?? "pending").toLowerCase();
  if (value === "done" || value === "complete") {
    return "completed";
  }
  if (value === "doing" || value === "active") {
    return "in_progress";
  }
  if (value === "cancelled" || value === "canceled") {
    return "cancelled";
  }
  return value || "pending";
}

function statusMark(status) {
  if (status === "completed") {
    return "[✓]";
  }
  if (status === "in_progress") {
    return "[>]";
  }
  if (status === "cancelled") {
    return "[-]";
  }
  return "[ ]";
}

export function startupEntry(session) {
  return {
    kind: "startup",
    title: "Ant Code TUI v1.1",
    body: startupBannerLines(session).join("\n"),
    at: new Date().toLocaleTimeString()
  };
}

function taskPanelLines(taskRecords = [], filter = "active", taskGroupRecords = []) {
  const tasks = Array.isArray(taskRecords) ? taskRecords : [];
  const groups = Array.isArray(taskGroupRecords) ? taskGroupRecords : [];
  if (tasks.length === 0 && groups.length === 0) {
    return [
      line("本会话暂无子智能体任务。", true),
      line("模型调用 agent_run 或运行 /agents run 后会显示在这里。"),
      line("工作区历史任务可用 /agents tasks 查看。", true)
    ];
  }
  const selectedFilter = normalizeTaskFilter(filter);
  const visibleTasks = sortTasksForPanel(filterTasks(tasks, selectedFilter));
  const tree = buildTaskTree(visibleTasks);
  const rows = [
    line(sideSubtabsText(TASK_FILTERS, TASK_FILTER_LABELS, selectedFilter), true, "cyan"),
    line(`本会话任务：${visibleTasks.length}/${tasks.length}`, true)
  ];
  const visibleGroups = filterGroups(groups, selectedFilter);
  if (visibleGroups.length > 0) {
    rows.push(line(""));
    rows.push(line(`任务组：${visibleGroups.length}/${groups.length}`, true, "cyan"));
    for (const group of visibleGroups.slice(0, 5)) {
      pushTaskGroupPanelNode(rows, group);
    }
    if (visibleGroups.length > 5) {
      rows.push(line(`... 还有 ${visibleGroups.length - 5} 个任务组`, true));
    }
    rows.push(line(""));
  }
  if (visibleTasks.length === 0) {
    rows.push(line("此分类暂无子智能体任务。", true));
  }
  for (const root of tree) {
    pushTaskPanelNode(rows, root, 0);
  }
  rows.push(line(""));
  rows.push(line("/agents route <任务> 预览调度", true));
  rows.push(line("/agents orchestrate <任务> 并行只读调查", true));
  rows.push(line("/agents task <task-id> 查看详情", true));
  rows.push(line("/background run <profile> <任务> 后台运行", true));
  return rows;
}

function pushTaskGroupPanelNode(rows, group) {
  const status = taskStatusMark(group.status);
  const wake = group.wakePromptQueuedAt ? "已唤醒" : group.wakeParent ? "自动唤醒" : "仅记录";
  rows.push(line(`${status} 组 ${truncate(group.id, 28)} ${wake}`));
  const progress = group.latestProgress || group.summary || `${group.taskIds?.length ?? 0} 个子任务`;
  rows.push(line(`  ${truncate(progress, 64)}`, true));
  rows.push(line(`  /agents group ${truncate(group.id, 30)}`, true));
}

function pushTaskPanelNode(rows, task, depth) {
  const indent = "  ".repeat(depth);
  const title = task.title || task.profile;
  const status = taskStatusMark(task.status);
  rows.push(line(`${indent}${status} ${truncate(title, Math.max(32, 72 - depth * 2))}`));
  const route = [task.profile, task.purpose, task.difficulty, task.risk].filter(Boolean).join("/");
  rows.push(line(`${indent}  ${truncate(route || task.profile, 34)} ${truncate(task.id, 24)}`, true));
  if (task.model || task.modelTier || task.budget) {
    const model = task.modelTier ? `${task.modelTier}:${task.model ?? "model"}` : task.model;
    const budget = task.budget
      ? ` r${Number.isFinite(task.budget.maxRounds) ? task.budget.maxRounds : "∞"}`
      : "";
    rows.push(line(`${indent}  ${truncate(`${model ?? ""}${budget}`, Math.max(34, 72 - depth * 2))}`, true));
  }
  if (task.budgetProgress || task.toolCalls?.length) {
    const toolProgress = task.budgetProgress?.toolCalls ?? task.toolCalls?.length ?? 0;
    const bytes = task.budgetProgress?.outputBytes;
    rows.push(line(`${indent}  工具 ${toolProgress}${Number.isFinite(bytes) ? ` 输出 ${bytes}B` : ""}`, true));
    pushTaskTokenPanelRows(rows, task.budgetProgress, indent);
    const latestTool = latestTaskTool(task);
    if (latestTool) {
      rows.push(line(`${indent}  最近工具：${truncate(latestTool, Math.max(28, 64 - depth * 2))}`, true));
    }
  }
  if (task.status === "partial" && task.budgetExceeded) {
    rows.push(line(`${indent}  阶段暂停：${truncate(task.budgetExceeded.kind ?? "budget", 26)}`, true));
  }
  if (task.latestProgress) {
    rows.push(line(`${indent}  ${truncate(task.latestProgress, Math.max(34, 72 - depth * 2))}`, true));
  } else if (task.prompt) {
    rows.push(line(`${indent}  ${truncate(task.prompt, Math.max(34, 72 - depth * 2))}`, true));
  }
  for (const child of (task.children ?? []).slice(0, 6)) {
    pushTaskPanelNode(rows, child, depth + 1);
  }
  if ((task.children ?? []).length > 6) {
    rows.push(line(`${indent}  ... 还有 ${task.children.length - 6} 个子任务`, true));
  }
}

function pushTaskTokenPanelRows(rows, progress = {}, indent = "") {
  if (!progress || typeof progress !== "object") {
    return;
  }
  const tokens = progress.promptTokens;
  const maxTokens = progress.maxTokens;
  if (Number.isFinite(tokens)) {
    rows.push(line(`${indent}  模型输入（估算）`, true));
    rows.push(line(`${indent}    输入：${formatTokenCount(tokens)}${Number.isFinite(maxTokens) ? `/${formatTokenCount(maxTokens)}` : ""} tokens`, true));
    if (Number.isFinite(progress.promptRound)) {
      rows.push(line(`${indent}    轮次：${progress.promptRound}`, true));
    }
  }
  const providerRows = taskProviderUsageLines(progress, indent);
  rows.push(...providerRows);
}

function taskProviderUsageLines(progress = {}, indent = "") {
  if (!progress || typeof progress !== "object") {
    return [];
  }
  const hasProviderUsage = Number.isFinite(progress.providerPromptTokens) ||
    Number.isFinite(progress.providerCachedPromptTokens) ||
    Number.isFinite(progress.providerCompletionTokens) ||
    Number.isFinite(progress.providerTotalTokens);
  if (!hasProviderUsage) {
    return [];
  }
  return [
    line(`${indent}  Provider 实报`, true, "green"),
    Number.isFinite(progress.providerPromptTokens)
      ? line(`${indent}    输入：${formatTokenCount(progress.providerPromptTokens)} tokens`, true, "green")
      : null,
    Number.isFinite(progress.providerCachedPromptTokens)
      ? line(`${indent}    缓存命中：${formatCachedPromptUsage(progress.providerCachedPromptTokens, progress.providerPromptTokens)}`, true, "green")
      : null,
    Number.isFinite(progress.providerCompletionTokens)
      ? line(`${indent}    输出：${formatTokenCount(progress.providerCompletionTokens)} tokens`, true, "green")
      : null,
    Number.isFinite(progress.providerTotalTokens)
      ? line(`${indent}    合计：${formatTokenCount(progress.providerTotalTokens)} tokens`, true, "green")
      : null
  ].filter(Boolean);
}

function latestTaskTool(task) {
  const calls = Array.isArray(task.toolCalls) ? task.toolCalls : [];
  const latest = calls[calls.length - 1];
  if (!latest) {
    return "";
  }
  const state = latest.ok ? "完成" : latest.blocked ? "被阻止" : latest.errorCode ? `失败 ${latest.errorCode}` : "运行过";
  return `${latest.name} ${state}`;
}

function normalizeTaskFilter(value) {
  return TASK_FILTERS.includes(value) ? value : TASK_FILTERS[0];
}

function filterTasks(tasks, filter) {
  const list = Array.isArray(tasks) ? tasks : [];
  if (filter === "all") {
    return list;
  }
  if (filter === "completed") {
    return list.filter((task) => COMPLETED_TASK_STATUSES.has(normalizeTaskStatus(task?.status)));
  }
  if (filter === "issues") {
    return list.filter((task) => isIssueTask(task));
  }
  return list.filter((task) => ACTIVE_TASK_STATUSES.has(normalizeTaskStatus(task?.status)));
}

function filterGroups(groups, filter) {
  const list = Array.isArray(groups) ? groups : [];
  if (filter === "all") {
    return list;
  }
  if (filter === "completed") {
    return list.filter((group) => COMPLETED_TASK_STATUSES.has(normalizeTaskStatus(group?.status)));
  }
  if (filter === "issues") {
    return list.filter((group) => ISSUE_TASK_STATUSES.has(normalizeTaskStatus(group?.status)));
  }
  return list.filter((group) => ACTIVE_TASK_STATUSES.has(normalizeTaskStatus(group?.status)));
}

function sortTasksForPanel(tasks) {
  return [...tasks].sort((left, right) => {
    const status = taskStatusPriority(left) - taskStatusPriority(right);
    if (status !== 0) {
      return status;
    }
    return String(right.updatedAt ?? right.finishedAt ?? right.startedAt ?? right.createdAt ?? "")
      .localeCompare(String(left.updatedAt ?? left.finishedAt ?? left.startedAt ?? left.createdAt ?? ""));
  });
}

function taskStatusPriority(task) {
  const status = normalizeTaskStatus(task?.status);
  if (ACTIVE_TASK_STATUSES.has(status)) {
    return 0;
  }
  if (isIssueTask(task)) {
    return 1;
  }
  if (status === "completed") {
    return 2;
  }
  if (status === "cancelled") {
    return 3;
  }
  return 4;
}

function isIssueTask(task) {
  const status = normalizeTaskStatus(task?.status);
  return ISSUE_TASK_STATUSES.has(status) || (status === "partial" && Boolean(task?.budgetExceeded));
}

function normalizeTaskStatus(status) {
  return String(status ?? "queued").toLowerCase();
}

function taskStatusMark(status) {
  if (status === "completed") {
    return "[✓]";
  }
  if (status === "partial") {
    return "[..]";
  }
  if (status === "running") {
    return "[>]";
  }
  if (status === "failed") {
    return "[!]";
  }
  if (status === "blocked") {
    return "[?]";
  }
  if (status === "cancelled" || status === "interrupted") {
    return "[-]";
  }
  return "[ ]";
}

function visibleBodyLines(value) {
  return String(value ?? "").split(/\r?\n/).filter((item) => item.length > 0);
}

function metaSummary(entry) {
  const body = splitLines(entry.body);
  const firstBodyLine = body[0] ? ` - ${body[0]}` : "";
  if (entry.kind === "gateway" || entry.kind === "turn" || entry.kind === "tool" || entry.kind === "tools") {
    return truncate(`${entry.title}${firstBodyLine}`, 110);
  }
  if (entry.kind === "system") {
    return truncate(entry.title, 90);
  }
  return truncate(`${entry.title}${firstBodyLine}`, 120);
}

function renderSegments(segments, theme, promptLineColor) {
  return segments.map((segment, index) => {
    if (segment.cursor) {
      return h(Text, {
        key: index,
        color: segment.hidden ? undefined : themeColor(theme, "cursor", promptLineColor),
        inverse: !segment.hidden
      }, segment.text);
    }
    return h(Text, {
      key: index,
      color: promptLineColor
    }, segment.text);
  });
}

function themedSideColor(theme, view) {
  if (view === "tasks") {
    return themeColor(theme, "tool", "cyan");
  }
  return themeColor(theme, "status", "green");
}

function themedPanelKindColor(theme, kind) {
  if (kind === "logs") {
    return themeColor(theme, "inspector", "magenta");
  }
  if (kind === "permissions" || kind === "compact" || kind === "context") {
    return themeColor(theme, "warning", "yellow");
  }
  if (kind === "usage" || kind === "cost" || kind === "status") {
    return themeColor(theme, "status", "green");
  }
  if (kind === "gateway") {
    return themeColor(theme, "gateway", "magenta");
  }
  if (kind === "model") {
    return themeColor(theme, "model", "green");
  }
  return themeColor(theme, "command", "cyan");
}

function themedPromptColor(theme, colorToken) {
  if (colorToken === "yellow") {
    return themeColor(theme, "warning", "yellow");
  }
  if (colorToken === "cyan") {
    return themeColor(theme, "identity", "cyan");
  }
  if (colorToken === "magenta") {
    return themeColor(theme, "accent", "magenta");
  }
  if (colorToken === "green") {
    return themeColor(theme, "success", "green");
  }
  return colorToken;
}

function themedKindColor(theme, kind) {
  if (kind === "error") {
    return themeColor(theme, "danger", "red");
  }
  if (kind === "approval") {
    return themeColor(theme, "approval", "yellow");
  }
  if (kind === "assistant") {
    return themeColor(theme, "assistant", "green");
  }
  if (kind === "user") {
    return themeColor(theme, "user", "cyan");
  }
  if (kind === "tool" || kind === "tools") {
    return themeColor(theme, "tool", "cyan");
  }
  if (kind === "gateway") {
    return themeColor(theme, "gateway", "magenta");
  }
  return colorForKind(kind);
}

function themedLineColor(theme, color) {
  if (color === "cyan") {
    return themeColor(theme, "identity", "cyan");
  }
  if (color === "green") {
    return themeColor(theme, "success", "green");
  }
  if (color === "yellow") {
    return themeColor(theme, "warning", "yellow");
  }
  if (color === "red") {
    return themeColor(theme, "danger", "red");
  }
  if (color === "magenta") {
    return themeColor(theme, "accent", "magenta");
  }
  if (color === "white") {
    return themeColor(theme, "text", "white");
  }
  if (color === "code") {
    return themeColor(theme, "code", "#cbd5e1");
  }
  return color;
}

function EscapeAction({ theme = DEFAULT_TUI_THEME, label = "Esc 关闭" }) {
  return h(Text, {
    color: themeColor(theme, "warning", "yellow"),
    bold: true,
    inverse: true,
    wrap: "truncate"
  }, ` ${label} `);
}

function commandPanelEscLabel(footer) {
  return /Esc\s*取消/i.test(String(footer ?? "")) ? "Esc 取消" : "Esc 关闭";
}

function commandPanelFooterText(footer) {
  return String(footer ?? "")
    .replace(/(^|\s*\|\s*)Esc\s*(?:关闭|取消)(?=\s*\||$)/gi, "$1")
    .replace(/\s*\|\s*\|/g, " | ")
    .replace(/^\s*\|\s*|\s*\|\s*$/g, "")
    .trim();
}

function formatTokenCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return "?";
  }
  if (number >= 1000000) {
    return `${Math.round(number / 100000) / 10}M`;
  }
  if (number >= 1000) {
    return `${Math.round(number / 100) / 10}k`;
  }
  return String(number);
}

function providerStatusLines(context = {}) {
  if (!Number.isFinite(context.providerPromptTokens) &&
      !Number.isFinite(context.providerCompletionTokens) &&
      !Number.isFinite(context.providerTotalTokens)) {
    return [];
  }
  const lines = [
    line("Provider 实报", true, "green"),
    Number.isFinite(context.providerPromptTokens)
      ? line(`输入：${formatTokenCount(context.providerPromptTokens)} tokens`, false, "green")
      : null,
    Number.isFinite(context.providerCachedPromptTokens)
      ? line(`缓存命中：${formatCachedPromptUsage(context.providerCachedPromptTokens, context.providerPromptTokens)}`, false, "green")
      : null,
    Number.isFinite(context.providerCompletionTokens)
      ? line(`输出：${formatTokenCount(context.providerCompletionTokens)} tokens`, false, "green")
      : null,
    Number.isFinite(context.providerTotalTokens)
      ? line(`合计：${formatTokenCount(context.providerTotalTokens)} tokens`, false, "green")
      : null
  ].filter(Boolean);
  if (Number.isFinite(context.providerPromptTokensTotal) &&
      context.providerPromptTokensTotal !== context.providerPromptTokens) {
    lines.push(line(`累计输入：${formatTokenCount(context.providerPromptTokensTotal)} tokens`, true, "green"));
  }
  if (Number.isFinite(context.providerUsageReports) && context.providerUsageReports > 1) {
    lines.push(line(`报告次数：${context.providerUsageReports}`, true, "green"));
  }
  lines.push(line("完整：/context 或 /usage", true));
  return lines;
}

function formatProviderUsageBrief(context = {}) {
  const parts = [
    Number.isFinite(context.providerPromptTokens) ? `输入 ${formatTokenCount(context.providerPromptTokens)}` : null,
    Number.isFinite(context.providerCachedPromptTokens) ? `缓存 ${formatTokenCount(context.providerCachedPromptTokens)}` : null,
    Number.isFinite(context.providerCompletionTokens) ? `输出 ${formatTokenCount(context.providerCompletionTokens)}` : null,
    Number.isFinite(context.providerTotalTokens) ? `合计 ${formatTokenCount(context.providerTotalTokens)}` : null
  ].filter(Boolean);
  return parts.length > 0 ? `${parts.join(" / ")} tokens` : "未报告 token 细分";
}

function formatCachedPromptUsage(cachedTokens, promptTokens) {
  const cached = formatTokenCount(cachedTokens);
  if (!Number.isFinite(promptTokens) || promptTokens <= 0) {
    return `${cached} tokens`;
  }
  const percent = Math.round((cachedTokens / promptTokens) * 100);
  return `${cached}/${formatTokenCount(promptTokens)} tokens (${percent}%)`;
}

function primaryTokenLimit(context) {
  return context.modelMaxTokens ?? context.maxTokens;
}
