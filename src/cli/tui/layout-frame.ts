import { commandPanelViewport, resolveLogPaneLayout } from "./components.ts";
import {
  promptLines,
  streamingViewport,
  transcriptEntriesWithThinkingVisibility,
  transcriptViewport
} from "./format.ts";
import { shouldUseScrollbackMode } from "./interaction.ts";
import { resolveTuiFrame } from "./layout.ts";
import { fileMentionState, slashPaletteState } from "./palettes.ts";
import { createScrollableRegion } from "./scroll-region.ts";
import { initialStream } from "./stream.ts";
import { transcriptLineIndexForMouseY } from "./transcript-selection.ts";
import type {
  TuiCommandPanel,
  TuiFrame,
  TuiPendingApproval,
  TuiPendingQuestion,
  TuiRuntimeEvent,
  TuiTerminalSize,
  TuiUiState
} from "./types.ts";

export type TuiLayoutOptions = {
  height?: number;
  width?: number;
  minBodyRows?: number;
  mode?: string;
  busy?: boolean;
  inputBuffer?: string;
  inputCursor?: number;
  inputVisibleStart?: number;
  questionBuffer?: string;
  questionCursor?: number;
  questionVisibleStart?: number;
  pendingQuestion?: TuiPendingQuestion | null;
  queuedPrompts?: string[];
  pendingApproval?: TuiPendingApproval | null;
  exitConfirmActive?: boolean;
  interruptConfirmActive?: boolean;
  activePanel?: string | null;
  commandPanel?: TuiCommandPanel | null;
  slashPalette?: ReturnType<typeof slashPaletteState> | null;
  fileMention?: ReturnType<typeof fileMentionState> | null;
  modelCount?: number;
};

export function readTerminalSize(stdout: { columns?: number; rows?: number } | null | undefined): TuiTerminalSize {
  return {
    columns: Math.max(60, Number(stdout?.columns) || 100),
    rows: Math.max(18, Number(stdout?.rows) || 30)
  };
}

export function commandPanelVisibleRowsForSize(size: TuiTerminalSize | unknown, current: Partial<TuiUiState> = {}) {
  const rows = size && typeof size === "object" && "rows" in size ? Number(size.rows) : 30;
  if (current.commandPanel?.kind === "message-excerpt") {
    return Math.max(1, Math.max(18, rows || 30) - 4);
  }
  const layout = resolveTuiLayoutRows({
    height: Math.max(18, rows || 30),
    mode: current.mode ?? "input",
    busy: Boolean(current.busy),
    inputBuffer: current.inputBuffer ?? "",
    inputCursor: current.inputCursor ?? 0,
    inputVisibleStart: current.inputVisibleStart ?? 0,
    questionBuffer: current.questionBuffer ?? "",
    questionCursor: current.questionCursor ?? 0,
    questionVisibleStart: current.questionVisibleStart ?? 0,
    pendingQuestion: current.pendingQuestion ?? null,
    queuedPrompts: current.queuedPrompts ?? [],
    pendingApproval: current.pendingApproval ?? null,
    exitConfirmActive: Number(current.exitConfirmUntil) >= Date.now(),
    interruptConfirmActive: Number(current.interruptConfirmUntil) >= Date.now(),
    activePanel: current.commandPanel ? "command" : null,
    commandPanel: current.commandPanel ?? null
  });
  return layout.commandPanelVisibleRows;
}

export function maxCommandPanelOffset(panel: TuiCommandPanel | null | undefined, size: TuiTerminalSize | unknown, current: Partial<TuiUiState> = {}) {
  return commandPanelViewport(panel, 0, commandPanelVisibleRowsForSize(size, { ...current, commandPanel: panel })).maxOffset;
}

export function resolveTuiLayoutRows(options: TuiLayoutOptions = {}) {
  const height = Math.max(18, Number(options.height) || 30);
  const minBodyRows = Math.max(4, Number(options.minBodyRows) || 4);
  const statusRows = 1;
  const footerRows = 1;
  const permissionFooterRows = 1;
  const noticeRows = (options.exitConfirmActive ? 5 : 0) + (options.interruptConfirmActive ? 5 : 0);
  const queueRows = Array.isArray(options.queuedPrompts) && options.queuedPrompts.length > 0 ? 1 : 0;
  const promptRows = estimatePromptBoxRows(options, height);
  const baseRows = statusRows + footerRows + permissionFooterRows + noticeRows + queueRows + promptRows;
  const bodyFloor = Math.max(1, Math.min(minBodyRows, height - baseRows));
  const availableForPanel = Math.max(0, height - baseRows - bodyFloor);
  const activePanel = options.activePanel ?? null;
  const panelRows = activePanel
    ? Math.max(0, Math.min(availableForPanel, desiredPanelRows(activePanel, height, options)))
    : 0;
  const bodyRows = Math.max(bodyFloor, height - baseRows - panelRows);
  const commandPanelChromeRows = 1 + ((options.commandPanel?.tabs?.length ?? 0) > 0 ? 1 : 0) + 1 + 1 + 2;
  const commandPanelVisibleRows = activePanel === "command"
    ? Math.max(1, panelRows - commandPanelChromeRows)
    : Math.max(1, Math.min(18, height - 12));

  return {
    statusRows,
    footerRows,
    permissionFooterRows,
    noticeRows,
    queueRows,
    promptRows,
    panelRows,
    bodyRows,
    commandPanelVisibleRows
  };
}

export function estimatePromptBoxRows(options: TuiLayoutOptions, height: number) {
  const lines = promptLines(
    options.mode ?? "input",
    Boolean(options.busy),
    options.inputBuffer ?? "",
    options.questionBuffer ?? "",
    {
      queuedPrompts: options.queuedPrompts ?? [],
      pendingApproval: options.pendingApproval ?? null,
      pendingQuestion: options.pendingQuestion ?? null,
      inputCursor: options.inputCursor ?? 0,
      inputVisibleStart: options.inputVisibleStart ?? 0,
      questionCursor: options.questionCursor ?? 0,
      questionVisibleStart: options.questionVisibleStart ?? 0,
      showCursor: true,
      draftColumns: Math.max(8, Number(options.width) - 4),
      maxPromptLines: promptContentRowsForMode(options.mode ?? "input")
    }
  );
  const wantedRows = Math.max(3, lines.length + 2);
  const maxRows = options.mode === "question"
    ? Math.max(7, Math.min(12, Math.floor(height * 0.5)))
    : 5;
  return Math.min(wantedRows, maxRows);
}

export function promptContentRowsForMode(mode: string) {
  return mode === "question" ? 10 : 3;
}

export function desiredPanelRows(kind: string, height: number, options: TuiLayoutOptions = {}) {
  if (kind === "command") {
    const lineCount = Math.max(0, options.commandPanel?.lines?.length ?? 0);
    const tabs = (options.commandPanel?.tabs?.length ?? 0) > 0 ? 1 : 0;
    const chrome = 1 + tabs + 1 + 1 + 2;
    return Math.min(Math.max(12, Math.floor(height * 0.52)), Math.max(12, Math.min(28, lineCount + chrome)));
  }
  if (kind === "approval") {
    return 9;
  }
  if (kind === "model") {
    const count = Math.max(1, Number(options.modelCount) || 1);
    return Math.min(12, count + 4);
  }
  if (kind === "file") {
    const count = Math.max(1, options.fileMention ? 8 : 1);
    return Math.min(12, count + 4);
  }
  if (kind === "slash") {
    const count = Math.max(1, options.slashPalette?.commands?.length ?? 1);
    return Math.min(12, count + 4);
  }
  return 0;
}

export function isNativeScrollbackMode(current: Partial<TuiUiState> = {}) {
  const size = current.terminalSize ?? { columns: 100, rows: 30 };
  return shouldUseScrollbackMode(size.rows, {
    pinnedSidePanel: Number(size.columns) >= 108,
    streamActive: Boolean(current.stream?.active)
  });
}

export function activeOverlayKind(current: Partial<TuiUiState> = {}) {
  if (current.commandPanel) {
    return "command";
  }
  if (current.modelPickerOpen) {
    return "model";
  }
  if (current.fileMention) {
    return "file";
  }
  if (current.slashPalette) {
    return "slash";
  }
  if (current.pendingApproval) {
    return "approval";
  }
  return null;
}

export function isMessageExcerptPanelActive(current: Partial<TuiUiState> = {}) {
  return current.commandPanel?.kind === "message-excerpt";
}

export function frameForState(current: Partial<TuiUiState> = {}) {
  const size = current.terminalSize ?? { columns: 100, rows: 30 };
  const width = Math.max(60, Number(size.columns) || 100);
  const height = Math.max(18, Number(size.rows) || 30);
  const overlayKind = activeOverlayKind(current);
  const rows = resolveTuiLayoutRows({
    height,
    mode: current.mode ?? "input",
    busy: Boolean(current.busy),
    inputBuffer: current.inputBuffer ?? "",
    inputCursor: current.inputCursor ?? 0,
    inputVisibleStart: current.inputVisibleStart ?? 0,
    questionBuffer: current.questionBuffer ?? "",
    questionCursor: current.questionCursor ?? 0,
    questionVisibleStart: current.questionVisibleStart ?? 0,
    pendingQuestion: current.pendingQuestion ?? null,
    queuedPrompts: current.queuedPrompts ?? [],
    pendingApproval: current.pendingApproval ?? null,
    exitConfirmActive: Number(current.exitConfirmUntil) >= Date.now(),
    interruptConfirmActive: Number(current.interruptConfirmUntil) >= Date.now(),
    activePanel: overlayKind,
    commandPanel: current.commandPanel ?? null,
    slashPalette: current.slashPalette ?? null,
    fileMention: current.fileMention ?? null,
    modelCount: current.modelOptions?.length ?? 0
  });
  return resolveTuiFrame({
    width,
    height,
    wide: width >= 108,
    rows
  });
}

export function transcriptSubtargetForMouse(event: TuiRuntimeEvent, current: Partial<TuiUiState> = {}, frame: TuiFrame = frameForState(current)) {
  const y = Number(event.y);
  if (!current.stream?.active || !event || !Number.isFinite(y)) {
    return "transcript";
  }
  const layout = resolveLogPaneLayout({
    height: frame.regions.transcript.height,
    streamActive: true,
    scrollbackMode: false
  });
  if (layout.liveRows <= 0) {
    return "transcript";
  }
  const streamTop = frame.regions.transcript.bottom - layout.liveRows + 1;
  return y >= streamTop ? "stream" : "transcript";
}

export function transcriptHitAtMouseEvent(
  event: TuiRuntimeEvent | { x?: number; y?: number } | null | undefined,
  current: Partial<TuiUiState> = {},
  options: { clamp?: boolean } = {}
) {
  const x = Number(event?.x);
  const y = Number(event?.y);
  if (!event || !Number.isFinite(y)) {
    return null;
  }
  const frame = frameForState(current);
  const transcript = frame.regions.transcript;
  if (!transcript) {
    return null;
  }
  const inBox = Number.isFinite(x) && x >= transcript.left && x <= transcript.right && y >= transcript.top && y <= transcript.bottom;
  if (!inBox && !options.clamp) {
    return null;
  }
  const logLayout = resolveLogPaneLayout({
    height: transcript.height,
    streamActive: Boolean(current.stream?.active),
    scrollbackMode: false
  });
  const viewport = transcriptViewport(
    transcriptEntriesWithThinkingVisibility(current.entries ?? [], Boolean(current.thinkingVisible)),
    logLayout.displayRows,
    frame.mainWidth,
    current.transcriptScrollOffset ?? 0,
    current.detailMode ?? "compact"
  );
  const lineIndex = transcriptLineIndexForMouseY(y, transcript.top, viewport.lines.length, {
    historyWarning: viewport.offset > 0,
    clamp: options.clamp
  });
  if (lineIndex === null) {
    return null;
  }
  return {
    lineIndex,
    line: viewport.lines[lineIndex],
    viewport
  };
}

export function entryAtTranscriptMouseEvent(event: TuiRuntimeEvent, current: Partial<TuiUiState> = {}) {
  const hit = transcriptHitAtMouseEvent(event, current);
  const lineEntryId = hit?.line?.entryId;
  if (!lineEntryId) {
    return null;
  }
  return (current.entries ?? []).find((entry) => entry.id === lineEntryId) ?? null;
}

export function transcriptRegionForState(current: Partial<TuiUiState> = {}) {
  const frame = frameForState(current);
  const logLayout = resolveLogPaneLayout({
    height: frame.regions.transcript.height,
    streamActive: Boolean(current.stream?.active),
    scrollbackMode: false
  });
  const viewport = transcriptViewport(
    transcriptEntriesWithThinkingVisibility(current.entries ?? [], Boolean(current.thinkingVisible)),
    logLayout.displayRows,
    frame.mainWidth,
    current.transcriptScrollOffset ?? 0,
    current.detailMode ?? "compact"
  );
  return createScrollableRegion({
    totalRows: viewport.totalRows,
    visibleRows: logLayout.displayRows,
    offset: current.transcriptScrollOffset ?? 0
  });
}

export function streamRegionForState(current: Partial<TuiUiState> = {}) {
  const frame = frameForState(current);
  const logLayout = resolveLogPaneLayout({
    height: frame.regions.transcript.height,
    streamActive: Boolean(current.stream?.active),
    scrollbackMode: false
  });
  const viewport = streamingViewport(
    { ...(current.stream ?? initialStream()), thinkingVisible: Boolean(current.thinkingVisible) },
    Math.max(1, logLayout.liveRows - 2),
    frame.mainWidth,
    current.streamScrollOffset ?? 0,
    0,
    current.detailMode ?? "compact"
  );
  return createScrollableRegion({
    totalRows: viewport.totalRows,
    visibleRows: Math.max(1, logLayout.liveRows - 2),
    offset: current.streamScrollOffset ?? 0
  });
}
