import { execFile, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { appendFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process, { stdin as input, stdout as output } from "node:process";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, render, useApp, useInput, useStdin, useStdout } from "ink";
import { parseSlashCommand } from "../../commands/parser.ts";
import { cancelBackgroundAgentTasks, listBackgroundAgentTasks } from "../../agents/background-registry.ts";
import { createAgentTaskGroupStore } from "../../agents/task-group-store.ts";
import { createAgentTaskStore } from "../../agents/task-store.ts";
import { runSubagent } from "../../agents/runner.ts";
import { runSlashCommand } from "../../commands/runtime.ts";
import { clearSessionContext, compactSessionContextWithModel, summarizeContextWindow } from "../../core/context-window.ts";
import { createInitialEventState, reduceAntEvent } from "../../core/event-reducer.ts";
import { createSession, runSessionTurn, type AgentSession, type SessionMessage } from "../../core/session.ts";
import type { SubagentResult } from "../../agents/runner.ts";
import type { TuiLine } from "./format.ts";
import { persistTuiPermissionCycle } from "./permission-cycle.ts";
import { createLabModelGateway } from "../../model-gateway/client.ts";
import { listConfiguredModels, type LabModel } from "../../model-gateway/models.ts";
import { appendThinkingPreview, limitThinkingPreview } from "../../model-gateway/thinking-budget.ts";
import { resolveWorkspaceTrust, trustWorkspace } from "../../permissions/workspace-trust.ts";
import { createSessionStore } from "../../storage/session-store.ts";
import { getAntCodeVersion } from "../../version.ts";
import {
  clampDraftCursor,
  createDraft,
  type InputDraft,
  cursorToEnd,
  deleteBackward,
  deleteForward,
  deleteToEnd,
  deleteToStart,
  deleteWordBackward,
  deleteWordForward,
  displayWidth,
  insertText,
  moveCursor,
  moveCursorLineBoundary,
  moveCursorVertical,
  stabilizeDraftViewport
} from "./input-editor.ts";
import {
  CompactSideSummary,
  CommandPanel,
  ExitConfirmNotice,
  FileMentionPalette,
  FooterBar,
  InterruptConfirmNotice,
  LogPane,
  ModelPicker,
  PermissionFooter,
  PermissionModal,
  PromptBox,
  QueuedPromptLine,
  resolveLogPaneLayout,
  SidePanel,
  SlashPalette,
  StartupConfirmDialog,
  StartupSplash,
  StatusBar,
  TrustDialog,
  commandPanelViewport,
  startupEntry
} from "./components.ts";
import {
  APPROVAL_CHOICES,
  applyPermissionMode,
  approvalKeyFor,
  detailModeLabel,
  initialPermissionMode,
  nextDetailMode,
  nextPermissionMode,
  nextSideView,
  normalizeQuestionPrompt,
  permissionModeDescription,
  permissionModeLabel,
  promptLines,
  streamingViewport,
  summarizeInput,
  transcriptEntriesWithThinkingVisibility,
  transcriptViewport
} from "./format.ts";
import {
  INSPECTOR_FILTERS,
  INSPECTOR_OUTPUT_COMMANDS,
  MAX_INSPECTOR_ITEMS,
  initialInspector,
  inspectorCategoryForCommand,
  makeInspector,
  resolveInspectorIndex
} from "./inspector.ts";
import {
  hasMouseSequence,
  mouseClickEvents,
  rawDraftEditOperations,
  rawScrollEvents,
  rawShiftTabPresses,
  resolveCtrlCExit,
  resolveEscInterrupt,
  shouldUseScrollbackMode,
  topPopover
} from "./interaction.ts";
import { resolveScrollTarget, resolveTuiFrame } from "./layout.ts";
import {
  createCompactPanel,
  createContextPanel,
  createAgentTaskLivePanel,
  createClearConfirmPanel,
  formatAgentTaskExcerptBody,
  formatMessageBodyForDisplayClipboard,
  createHelpPanel,
  createLogsPanel,
  createMessageActionsPanel,
  createMessageExcerptPanel,
  createPermissionsPanel,
  createQueuePanel,
  createResumeChunkPanel,
  createResumeHelpPanel,
  createResumePanel,
  createSessionsPanel,
  createStatusPanel,
  createTextOutputPanel,
  createUndoRedoPanel,
  createUsagePanel
} from "./command-panels.ts";
import {
  fileMentionState,
  insertFileMention,
  listFileMentionCandidates,
  movePaletteIndex,
  slashPaletteState
} from "./palettes.ts";
import { resolveTheme } from "./theme.ts";
import { createScrollableRegion } from "./scroll-region.ts";
import {
  boundedIndex,
  buildGuidePrompt,
  createCoalescedAsyncRunner,
  isImmediateTuiCommand,
  isStopGuidance,
  prependQueuedPrompt,
  promoteQueuedPrompt,
  rememberRecentFile,
  removeQueuedPrompt,
  resolveTuiExitAction,
  takeQueuedPrompt
} from "./workflows.ts";
import {
  HIGH_FREQUENCY_ANT_EVENTS,
  MAX_ENTRIES,
  MESSAGE_ACTIONS,
  STREAM_FLUSH_INTERVAL_MS,
  TASK_FILTERS,
  TASK_FILTER_LABELS,
  WORKFLOW_FILTERS,
  WORKFLOW_FILTER_LABELS,
  type AntEventState,
  type FileMentionCandidate,
  type TuiAppProps,
  type TuiCommandPanel,
  type TuiEntry,
  type TuiInspectorItem,
  type TuiQuestionAnswer,
  type TuiRunPromptInput,
  type TuiRuntimeEvent,
  type TuiSessionRecord,
  type TuiStreamState,
  type TuiTaskGroupRecord,
  type TuiTaskRecord,
  type TuiTerminalSize,
  type TuiUiState
} from "./types.ts";
import { updateDraftRef } from "./draft.ts";
import { limitTranscriptEntries } from "./transcript.ts";
import { resolveIdleSilentAfterMs, shouldEnterIdleSilent } from "./idle.ts";
import {
  agentTaskStatusLabel,
  agentTaskTitle,
  formatGatewayUsageBrief,
  initialActivity,
  truncatePlainText,
  updateActivity
} from "./activity.ts";
import {
  appendStreamDelta,
  appendToolCallDraft,
  applyStreamDeltaBuffer,
  createStreamDeltaBuffer,
  initialStream,
  isModelResponseInFlight,
  resolveStreamDeltaActivityStatus,
  updateRuntimeTool
} from "./stream.ts";
import { hydrateTaskOutput, initialEntries, summarizeSessionInfo, withEntryIdentity } from "./entries.ts";
import { composerContentColumns, handleApprovalInput, handleQuestionInput, nextFilter, recallHistory } from "./input-handlers.ts";
import {
  activeOverlayKind,
  commandPanelVisibleRowsForSize,
  entryAtTranscriptMouseEvent,
  frameForState,
  isMessageExcerptPanelActive,
  isNativeScrollbackMode,
  maxCommandPanelOffset,
  readTerminalSize,
  resolveTuiLayoutRows,
  streamRegionForState,
  transcriptRegionForState,
  transcriptSubtargetForMouse
} from "./layout-frame.ts";
import { entriesFromSelected, formatEntriesForClipboard, formatEntryForClipboard, messageActionsForEntry, writeClipboardText } from "./clipboard.ts";
import { readGitStatusSummary } from "./git-status.ts";
import {
  clearTerminalForFullRedraw,
  debugRawInput,
  debugTuiInput,
  disableTerminalMouse,
  enableTerminalMouse,
  enterTerminalSelectionMode,
  isCtrlKey,
  isInkKeyRelease,
  looksLikePastedText,
  readBracketedPaste,
  countLogicalLines,
  sanitizeComposerText,
  splitTrailingSubmitInput,
  trailingRawShiftTabInput
} from "./terminal-mode.ts";

export function useTuiAppCore(props: TuiAppProps) {
  if (props.session.permissionReadonlyLocked === undefined) {
    props.session.permissionReadonlyLocked = Boolean(props.session.readonly);
  }
  const { exit } = useApp();
  const { internal_eventEmitter: inputEvents } = useStdin();
  const { stdout } = useStdout();
  const theme = useMemo(() => resolveTheme(props.env?.LAB_AGENT_TUI_THEME ?? "", {
    noColor: props.env?.NO_COLOR === "1" || props.env?.LAB_AGENT_NO_COLOR === "1"
  }), [props.env]);
  const [terminalSize, setTerminalSize] = useState(() => readTerminalSize(stdout));
  const [entries, setEntries] = useState(() => initialEntries(props.session));
  const [activeModel, setActiveModel] = useState(props.session.model);
  const [inputBuffer, setInputBuffer] = useState("");
  const [inputCursor, setInputCursor] = useState(0);
  const [questionBuffer, setQuestionBuffer] = useState("");
  const [questionCursor, setQuestionCursor] = useState(0);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState("input");
  const [startupConfirmed, setStartupConfirmed] = useState(false);
  const [trusted, setTrusted] = useState(Boolean(props.initialTrusted));
  const [trustStatus, setTrustStatus] = useState(props.initialTrusted ? "trusted" : "needed");
  const [detailMode, setDetailMode] = useState("compact");
  const [thinkingVisible, setThinkingVisible] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<TuiUiState["pendingApproval"]>(null);
  const [pendingQuestion, setPendingQuestion] = useState<TuiUiState["pendingQuestion"]>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [sideView, setSideView] = useState("status");
  const [workflowFilter, setWorkflowFilter] = useState("incomplete");
  const [taskFilter, setTaskFilter] = useState("active");
  const [activity, setActivity] = useState(() => initialActivity(props.session));
  const [stream, setStream] = useState(() => initialStream());
  const [antState, setAntState] = useState<AntEventState>(() => createInitialEventState() as AntEventState);
  const [pulse, setPulse] = useState(0);
  const [idleSilent, setIdleSilent] = useState(false);
  const [inspectorItems, setInspectorItems] = useState<TuiInspectorItem[]>(() => [initialInspector(props.session)]);
  const [inspectorIndex, setInspectorIndex] = useState(0);
  const [inspectorOffset, setInspectorOffset] = useState(0);
  const [inspectorFilter, setInspectorFilter] = useState("all");
  const [inspectorPatchFileIndex, setInspectorPatchFileIndex] = useState(0);
  const [sidePanelOffset, setSidePanelOffset] = useState(0);
  const [permissionMode, setPermissionMode] = useState(() => initialPermissionMode(props.session));
  const [slashPaletteDismissed, setSlashPaletteDismissed] = useState(false);
  const [slashPaletteIndex, setSlashPaletteIndex] = useState(0);
  const [fileMentionDismissed, setFileMentionDismissed] = useState(false);
  const [fileMentionCandidates, setFileMentionCandidates] = useState<FileMentionCandidate[]>([]);
  const [fileMentionIndex, setFileMentionIndex] = useState(0);
  const [recentFiles, setRecentFiles] = useState<string[]>([]);
  const [queuedPrompts, setQueuedPrompts] = useState<string[]>([]);
  const [queuePanelIndex, setQueuePanelIndex] = useState(0);
  const [sessionRecords, setSessionRecords] = useState<TuiSessionRecord[]>([]);
  const [sessionPickerIndex, setSessionPickerIndex] = useState(0);
  const [taskRecords, setTaskRecords] = useState<TuiTaskRecord[]>([]);
  const [taskGroupRecords, setTaskGroupRecords] = useState<TuiTaskGroupRecord[]>([]);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modelPickerIndex, setModelPickerIndex] = useState(0);
  const [commandPanel, setCommandPanel] = useState<TuiCommandPanel | null>(null);
  const [commandPanelOffset, setCommandPanelOffset] = useState(0);
  const [approvalChoiceIndex, setApprovalChoiceIndex] = useState(0);
  const [exitConfirmUntil, setExitConfirmUntil] = useState(0);
  const [interruptConfirmUntil, setInterruptConfirmUntil] = useState(0);
  const [backgroundExitPending, setBackgroundExitPending] = useState(false);
  const [transcriptScrollOffset, setTranscriptScrollOffset] = useState(0);
  const [streamScrollOffset, setStreamScrollOffset] = useState(0);
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const [selectedEntryHighlightUntil, setSelectedEntryHighlightUntil] = useState(0);
  const [transcriptSelection, setTranscriptSelection] = useState<{ startIndex: number; endIndex: number } | null>(null);
  const [messageActionIndex, setMessageActionIndex] = useState(0);
  const commandPanelKindRef = useRef<string | null>(null);
  const entryIdCounterRef = useRef(0);
  const sessionApprovals = useRef(new Set<string>());
  const queuedPromptsRef = useRef<string[]>([]);
  const runPromptDirectRef = useRef<((prompt: TuiRunPromptInput) => unknown) | null>(null);
  const currentTurnAbortRef = useRef<AbortController | null>(null);
  const currentTurnPromptRef = useRef("");
  const pendingGuideInterruptRef = useRef<{ kind: "stop" | "guide"; guidance?: string } | null>(null);
  const pendingGoalContinueRef = useRef<{ prompt?: string; displayPrompt?: string; kind?: string } | null>(null);
  const lastTurnStatusRef = useRef("completed");
  const agentTaskEntriesRef = useRef(new Map<string, string>());
  const sessionRef = useRef(props.session);
  const stateRef = useRef<TuiUiState>({} as TuiUiState);
  const inputDraftRef = useRef<InputDraft>({ text: "", cursor: 0, visibleStart: 0 });
  const questionDraftRef = useRef<InputDraft>({ text: "", cursor: 0, visibleStart: 0 });
  const rawScrollInputTailRef = useRef("");
  const claimedInkInputRef = useRef(false);
  const rawShiftTabInputTailRef = useRef("");
  const lastTranscriptClickRef = useRef<{ entryId: string | null; at: number }>({ entryId: null, at: 0 });
  const transcriptDragRef = useRef<{ x: number; y: number; lineIndex: number } | null>(null);
  const bracketedPasteRef = useRef({ active: false, buffer: "", prefix: "" });
  const lastActivityAtRef = useRef(Date.now());
  const idleSilentRef = useRef(false);
  const exitConfirmUntilRef = useRef(0);
  const interruptConfirmUntilRef = useRef(0);
  const lastCtrlCHandledAtRef = useRef(0);
  const transcriptScrollOffsetRef = useRef(0);
  const streamScrollOffsetRef = useRef(0);
  const sidePanelOffsetRef = useRef(0);
  const backgroundControllersRef = useRef(new Map<string, AbortController>());
  const backgroundExitPendingRef = useRef(false);
  const taskRecordsLoaderRef = useRef<ReturnType<typeof createCoalescedAsyncRunner> | null>(null);
  const streamDeltaBufferRef = useRef(createStreamDeltaBuffer());
  const streamFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activityEventCountRef = useRef(0);
  commandPanelKindRef.current = commandPanel?.kind ?? null;

  const markUserActivity = useCallback((source: string = "input") => {
    lastActivityAtRef.current = Date.now();
    if (!idleSilentRef.current) {
      return;
    }
    idleSilentRef.current = false;
    setIdleSilent(false);
    setActivity((value) => ({ ...value, status: "已唤醒", lastTurn: source }));
  }, []);

  const replaceInputDraft = useCallback((text: string, cursor: number | null = null) => {
    const next = stabilizeDraftViewport({
      ...clampDraftCursor(createDraft(text, cursor === null ? cursorToEnd(text) : cursor)),
      visibleStart: 0
    }, {
      columns: composerContentColumns(stateRef.current),
      maxLines: 3
    });
    inputDraftRef.current = next;
    stateRef.current.inputBuffer = next.text;
    stateRef.current.inputCursor = next.cursor;
    stateRef.current.inputVisibleStart = next.visibleStart ?? 0;
    setInputBuffer(next.text);
    setInputCursor(next.cursor);
    return next;
  }, []);

  const replaceQuestionDraft = useCallback((text: string, cursor: number | null = null) => {
    const next = stabilizeDraftViewport({
      ...clampDraftCursor(createDraft(text, cursor === null ? cursorToEnd(text) : cursor)),
      visibleStart: 0
    }, {
      columns: composerContentColumns({ ...stateRef.current, mode: "question" }),
      maxLines: 10
    });
    questionDraftRef.current = next;
    stateRef.current.questionBuffer = next.text;
    stateRef.current.questionCursor = next.cursor;
    stateRef.current.questionVisibleStart = next.visibleStart ?? 0;
    setQuestionBuffer(next.text);
    setQuestionCursor(next.cursor);
    return next;
  }, []);

  const updateInputDraft = useCallback((updater: (draft: InputDraft) => InputDraft) => {
    const next = stabilizeDraftViewport(updateDraftRef(inputDraftRef, updater), {
      columns: composerContentColumns(stateRef.current),
      maxLines: 3
    });
    inputDraftRef.current = next;
    stateRef.current.inputBuffer = next.text;
    stateRef.current.inputCursor = next.cursor;
    stateRef.current.inputVisibleStart = next.visibleStart ?? 0;
    setInputBuffer(next.text);
    setInputCursor(next.cursor);
    return next;
  }, []);

  const updateQuestionDraft = useCallback((updater: (draft: InputDraft) => InputDraft) => {
    const next = stabilizeDraftViewport(updateDraftRef(questionDraftRef, updater), {
      columns: composerContentColumns({ ...stateRef.current, mode: "question" }),
      maxLines: 10
    });
    questionDraftRef.current = next;
    stateRef.current.questionBuffer = next.text;
    stateRef.current.questionCursor = next.cursor;
    stateRef.current.questionVisibleStart = next.visibleStart ?? 0;
    setQuestionBuffer(next.text);
    setQuestionCursor(next.cursor);
    return next;
  }, []);

  const setExitConfirmUntilValue = useCallback((value: number) => {
    exitConfirmUntilRef.current = Math.max(0, Number(value) || 0);
    setExitConfirmUntil(exitConfirmUntilRef.current);
  }, []);

  const setInterruptConfirmUntilValue = useCallback((value: number) => {
    interruptConfirmUntilRef.current = Math.max(0, Number(value) || 0);
    setInterruptConfirmUntil(interruptConfirmUntilRef.current);
  }, []);

  const flushStreamDeltas = useCallback((baseStream: TuiStreamState | null = null) => {
    const buffered = streamDeltaBufferRef.current;
    if (!buffered.text && !buffered.thinking && buffered.textBytes <= 0 && buffered.thinkingBytes <= 0) {
      return baseStream ?? stateRef.current.stream ?? initialStream();
    }
    streamDeltaBufferRef.current = createStreamDeltaBuffer();
    const nextStream = applyStreamDeltaBuffer(baseStream ?? stateRef.current.stream ?? initialStream(), buffered, {
      thinkingVisible: stateRef.current.thinkingVisible
    });
    stateRef.current.stream = nextStream;
    setStream(nextStream);
    setActivity((current) => ({
      ...current,
      status: resolveStreamDeltaActivityStatus(current.status, stateRef.current.stream, buffered),
      streamBytes: current.streamBytes + buffered.textBytes,
      thinkingBytes: current.thinkingBytes + buffered.thinkingBytes
    }));
    return nextStream;
  }, []);

  const scheduleStreamFlush = useCallback(() => {
    if (streamFlushTimerRef.current) {
      return;
    }
    streamFlushTimerRef.current = setTimeout(() => {
      streamFlushTimerRef.current = null;
      flushStreamDeltas();
    }, STREAM_FLUSH_INTERVAL_MS);
  }, [flushStreamDeltas]);

  const flushStreamDeltasNow = useCallback(() => {
    if (streamFlushTimerRef.current) {
      clearTimeout(streamFlushTimerRef.current);
      streamFlushTimerRef.current = null;
    }
    return flushStreamDeltas();
  }, [flushStreamDeltas]);

  useEffect(() => () => {
    if (streamFlushTimerRef.current) {
      clearTimeout(streamFlushTimerRef.current);
      streamFlushTimerRef.current = null;
    }
  }, []);

  const setTranscriptOffset = useCallback((valueOrUpdater: number | ((current: number) => number)) => {
    const next = typeof valueOrUpdater === "function"
      ? valueOrUpdater(transcriptScrollOffsetRef.current)
      : valueOrUpdater;
    transcriptScrollOffsetRef.current = Math.max(0, Number(next) || 0);
    setTranscriptScrollOffset(transcriptScrollOffsetRef.current);
  }, []);

  const setStreamOffset = useCallback((valueOrUpdater: number | ((current: number) => number)) => {
    const next = typeof valueOrUpdater === "function"
      ? valueOrUpdater(streamScrollOffsetRef.current)
      : valueOrUpdater;
    streamScrollOffsetRef.current = Math.max(0, Number(next) || 0);
    setStreamScrollOffset(streamScrollOffsetRef.current);
  }, []);

  const setSideOffset = useCallback((valueOrUpdater: number | ((current: number) => number)) => {
    const next = typeof valueOrUpdater === "function"
      ? valueOrUpdater(sidePanelOffsetRef.current)
      : valueOrUpdater;
    sidePanelOffsetRef.current = Math.max(0, Number(next) || 0);
    setSidePanelOffset(sidePanelOffsetRef.current);
  }, []);

  const scrollTranscriptBy = useCallback((rows: number, current: TuiUiState = stateRef.current) => {
    setTranscriptOffset((value) => {
      const region = transcriptRegionForState({
        ...current,
        transcriptScrollOffset: value
      });
      return region.scrollBy(rows);
    });
  }, [setTranscriptOffset]);

  const scrollStreamBy = useCallback((rows: number, current: TuiUiState = stateRef.current) => {
    setStreamOffset((value) => {
      const region = streamRegionForState({
        ...current,
        streamScrollOffset: value
      });
      return region.scrollBy(rows);
    });
  }, [setStreamOffset]);

  const scrollSidePanelBy = useCallback((rows: number, current: TuiUiState = stateRef.current) => {
    setSideOffset((value) => value + rows);
  }, [setSideOffset]);

  const scrollOverlayBy = useCallback((rows: number, current: TuiUiState = stateRef.current) => {
    if (current.commandPanel) {
      setCommandPanelOffset((value) => Math.min(
        maxCommandPanelOffset(current.commandPanel, current.terminalSize, current),
        Math.max(0, value + rows)
      ));
      return true;
    }
    const direction = rows > 0 ? 1 : -1;
    const steps = Math.max(1, Math.ceil(Math.abs(rows) / 4));
    if (current.slashPalette) {
      const commands = current.slashPalette.commands ?? [];
      for (let index = 0; index < steps; index += 1) {
        setSlashPaletteIndex((value) => movePaletteIndex(commands, value, direction));
      }
      return true;
    }
    if (current.fileMention) {
      for (let index = 0; index < steps; index += 1) {
        setFileMentionIndex((value) => movePaletteIndex(current.fileMentionCandidates, value, direction));
      }
      return true;
    }
    if (current.modelPickerOpen) {
      for (let index = 0; index < steps; index += 1) {
        setModelPickerIndex((value) => movePaletteIndex(current.modelOptions, value, direction));
      }
      return true;
    }
    return false;
  }, []);

  const applyTargetScroll = useCallback((target: string | null | undefined, direction: number, current: TuiUiState = stateRef.current, rows: number = 4) => {
    if (direction === 0) {
      return false;
    }
    const delta = Number(direction) * Number(rows);
    if (target === "overlay") {
      return scrollOverlayBy(-delta, current);
    }
    if (target === "side") {
      scrollSidePanelBy(-delta, current);
      return true;
    }
    if (target === "stream") {
      scrollStreamBy(delta, current);
      return true;
    }
    scrollTranscriptBy(delta, current);
    return true;
  }, [scrollOverlayBy, scrollSidePanelBy, scrollStreamBy, scrollTranscriptBy]);

  const applyVisibleScroll = useCallback((direction: number, current: TuiUiState = stateRef.current, rows: number = 4, target: string = "transcript") => (
    applyTargetScroll(target, direction, current, rows)
  ), [applyTargetScroll]);

  const applyMouseWheelScroll = useCallback((event: TuiRuntimeEvent, current: TuiUiState = stateRef.current, rows: number = 4) => {
    const frame = frameForState(current);
    let target = resolveScrollTarget(event, frame, {
      activeOverlay: Boolean(activeOverlayKind(current)),
      defaultTarget: "transcript"
    });
    if (target === "transcript") {
      target = transcriptSubtargetForMouse(event, current, frame);
    }
    return applyTargetScroll(target, Number(event.direction) || 0, current, rows);
  }, [applyTargetScroll]);

  const insertPastedText = useCallback((value: string, current: TuiUiState = stateRef.current) => {
    const text = sanitizeComposerText(value);
    if (!text || !current.startupConfirmed || !current.trusted) {
      return false;
    }
    if (current.commandPanel || current.modelPickerOpen || current.pendingApproval) {
      return false;
    }
    if (current.mode === "question" && current.pendingQuestion) {
      updateQuestionDraft((draft) => insertText(draft, text));
    } else if (current.mode === "input") {
      updateInputDraft((draft) => insertText(draft, text));
      setSlashPaletteDismissed(false);
      setFileMentionDismissed(false);
      setHistoryIndex(null);
    } else {
      return false;
    }
    const lineCount = countLogicalLines(text);
    setActivity((value) => ({
      ...value,
      status: lineCount > 1 ? `已粘贴 ${lineCount} 行文本` : "已粘贴文本"
    }));
    return true;
  }, [updateInputDraft, updateQuestionDraft]);

  useEffect(() => {
    applyPermissionMode(sessionRef.current, permissionMode);
  }, [permissionMode]);

  useEffect(() => {
    const resizeTimers = new Set<ReturnType<typeof setTimeout>>();
    let initialized = false;
    let lastSize = readTerminalSize(stdout);
    const clearResizeTimers = () => {
      for (const timer of resizeTimers) {
        clearTimeout(timer);
      }
      resizeTimers.clear();
    };
    const scheduleMouseRefresh = (size: TuiTerminalSize) => {
      clearResizeTimers();
      if (commandPanelKindRef.current === "message-excerpt") {
        enterTerminalSelectionMode(stdout, {
          env: props.env,
          reason: "resize-message-excerpt",
          initialWindowsConsoleInputMode: props.initialWindowsConsoleInputMode
        });
        return;
      }
      if (shouldUseScrollbackMode(size.rows, {
        pinnedSidePanel: size.columns >= 108,
        streamActive: Boolean(stateRef.current.stream?.active)
      })) {
        enterTerminalSelectionMode(stdout, {
          env: props.env,
          reason: "resize-native-scrollback",
          initialWindowsConsoleInputMode: props.initialWindowsConsoleInputMode
        });
        return;
      }
      enableTerminalMouse(stdout, { env: props.env, reason: "resize" });
      for (const [delay, forceConsoleMode] of [[40, false], [160, false], [320, true], [520, false]] as Array<[number, boolean]>) {
        const timer = setTimeout(() => {
          resizeTimers.delete(timer);
          enableTerminalMouse(stdout, { env: props.env, forceConsoleMode, reason: `resize-refresh-${delay}` });
        }, delay);
        resizeTimers.add(timer);
      }
    };
    const onResize = () => {
      rawScrollInputTailRef.current = "";
      const nextSize = readTerminalSize(stdout);
      const sizeChanged = nextSize.columns !== lastSize.columns || nextSize.rows !== lastSize.rows;
      if (initialized && sizeChanged) {
        clearTerminalForFullRedraw(stdout);
      }
      initialized = true;
      lastSize = nextSize;
      setTerminalSize(nextSize);
      scheduleMouseRefresh(nextSize);
      debugTuiInput(props.env, `terminal_resize cols=${nextSize.columns} rows=${nextSize.rows}`);
    };
    stdout.on?.("resize", onResize);
    onResize();
    return () => {
      clearResizeTimers();
      stdout.off?.("resize", onResize);
      stdout.removeListener?.("resize", onResize);
    };
  }, [stdout]);

  useEffect(() => {
    const excerptMode = commandPanel?.kind === "message-excerpt";
    if (excerptMode) {
      enterTerminalSelectionMode(stdout, {
        env: props.env,
        reason: "message-excerpt",
        initialWindowsConsoleInputMode: props.initialWindowsConsoleInputMode
      });
      return undefined;
    }
    const nativeScrollback = shouldUseScrollbackMode(terminalSize.rows, {
      pinnedSidePanel: terminalSize.columns >= 108,
      streamActive: Boolean(stream?.active)
    });
    if (nativeScrollback) {
      enterTerminalSelectionMode(stdout, {
        env: props.env,
        reason: "native-scrollback",
        initialWindowsConsoleInputMode: props.initialWindowsConsoleInputMode
      });
    } else {
      enableTerminalMouse(stdout, { env: props.env, reason: "interactive" });
    }
    return undefined;
  }, [stdout, terminalSize.columns, terminalSize.rows, stream?.active, commandPanel?.kind]);

  const slashPalette = useMemo(() => slashPaletteDismissed ? null : slashPaletteState(inputBuffer), [inputBuffer, slashPaletteDismissed]);
  const fileMention = useMemo(() => fileMentionDismissed ? null : fileMentionState(inputBuffer), [inputBuffer, fileMentionDismissed]);
  const modelOptions = useMemo(() => listConfiguredModels(sessionRef.current.config), [activeModel]);

  useEffect(() => {
    if (!slashPalette) {
      setSlashPaletteIndex(0);
      return;
    }
    setSlashPaletteIndex((value) => Math.min(value, Math.max(0, slashPalette.commands.length - 1)));
  }, [slashPalette]);

  useEffect(() => {
    if (!fileMention) {
      setFileMentionCandidates([]);
      setFileMentionIndex(0);
      return undefined;
    }
    let cancelled = false;
    listFileMentionCandidates({ cwd: props.cwd, fragment: fileMention.fragment, recentFiles }).then((candidates) => {
      if (cancelled) {
        return;
      }
      setFileMentionCandidates(candidates);
      setFileMentionIndex((value) => Math.min(value, Math.max(0, candidates.length - 1)));
    });
    return () => {
      cancelled = true;
    };
  }, [fileMention?.fragment, fileMention?.start, props.cwd, recentFiles]);

  useEffect(() => {
    inputDraftRef.current = clampDraftCursor({ ...inputDraftRef.current, text: inputBuffer, cursor: inputCursor });
    questionDraftRef.current = clampDraftCursor({ ...questionDraftRef.current, text: questionBuffer, cursor: questionCursor });
    stateRef.current = {
      entries,
      inputBuffer,
      inputCursor,
      inputVisibleStart: inputDraftRef.current.visibleStart ?? 0,
      questionBuffer,
      questionCursor,
      questionVisibleStart: questionDraftRef.current.visibleStart ?? 0,
      busy,
      mode,
      stream,
      startupConfirmed,
      trusted,
      trustStatus,
      pendingApproval,
      pendingQuestion,
      history,
      historyIndex,
      sideView,
      workflowFilter,
      taskFilter,
      inspectorIndex,
      inspectorOffset,
      inspectorFilter,
      inspectorItems,
      inspectorPatchFileIndex,
      sidePanelOffset,
      detailMode,
      thinkingVisible,
      permissionMode,
      slashPalette,
      slashPaletteIndex,
      fileMention,
      fileMentionCandidates,
      fileMentionIndex,
      recentFiles,
      queuedPrompts,
      queuePanelIndex,
      sessionRecords,
      sessionPickerIndex,
      taskRecords,
      taskGroupRecords,
      modelPickerOpen,
      modelPickerIndex,
      commandPanel,
      commandPanelOffset,
      approvalChoiceIndex,
      exitConfirmUntil,
      interruptConfirmUntil,
      backgroundExitPending,
      idleSilent,
      transcriptScrollOffset,
      streamScrollOffset,
      selectedEntryId,
      selectedEntryHighlightUntil,
      transcriptSelection,
      messageActionIndex,
      terminalSize,
      modelOptions
    };
  }, [entries, inputBuffer, inputCursor, questionBuffer, questionCursor, busy, mode, stream, startupConfirmed, trusted, trustStatus, pendingApproval, pendingQuestion, history, historyIndex, sideView, workflowFilter, taskFilter, inspectorIndex, inspectorOffset, inspectorFilter, inspectorItems, inspectorPatchFileIndex, sidePanelOffset, detailMode, thinkingVisible, permissionMode, slashPalette, slashPaletteIndex, fileMention, fileMentionCandidates, fileMentionIndex, recentFiles, queuedPrompts, queuePanelIndex, sessionRecords, sessionPickerIndex, taskRecords, taskGroupRecords, modelPickerOpen, modelPickerIndex, commandPanel, commandPanelOffset, approvalChoiceIndex, exitConfirmUntil, interruptConfirmUntil, backgroundExitPending, idleSilent, transcriptScrollOffset, streamScrollOffset, selectedEntryId, selectedEntryHighlightUntil, transcriptSelection, messageActionIndex, terminalSize, modelOptions]);

  useEffect(() => {
    if (commandPanel?.kind !== "queue") {
      return;
    }
    setCommandPanel(createQueuePanel({
      queuedPrompts,
      selectedIndex: queuePanelIndex,
      busy
    }));
  }, [busy, commandPanel?.kind, queuedPrompts, queuePanelIndex]);

  useEffect(() => {
    if (commandPanel?.kind !== "sessions") {
      return;
    }
    setCommandPanel(createSessionsPanel({
      records: sessionRecords,
      selectedIndex: sessionPickerIndex,
      currentSessionId: sessionRef.current.id
    }));
  }, [commandPanel?.kind, sessionRecords, sessionPickerIndex]);

  useEffect(() => {
    idleSilentRef.current = idleSilent;
  }, [idleSilent]);

  useEffect(() => {
    if (commandPanel?.kind === "message-excerpt") {
      return undefined;
    }
    if (idleSilent) {
      return undefined;
    }
    const timer = setInterval(() => {
      setPulse((value) => value + 1);
    }, busy || stream.active ? 140 : 480);
    return () => clearInterval(timer);
  }, [busy, commandPanel?.kind, idleSilent, stream.active]);

  useEffect(() => {
    if (exitConfirmUntil <= Date.now()) {
      return undefined;
    }
    const timer = setTimeout(() => {
      setExitConfirmUntilValue(0);
    }, Math.max(1, exitConfirmUntil - Date.now()));
    return () => clearTimeout(timer);
  }, [exitConfirmUntil, setExitConfirmUntilValue]);

  useEffect(() => {
    if (interruptConfirmUntil <= Date.now()) {
      return undefined;
    }
    const timer = setTimeout(() => {
      setInterruptConfirmUntilValue(0);
    }, Math.max(1, interruptConfirmUntil - Date.now()));
    return () => clearTimeout(timer);
  }, [interruptConfirmUntil, setInterruptConfirmUntilValue]);

  return {
    props,
    exit,
    inputEvents,
    stdout,
    theme,
    terminalSize,
    setTerminalSize,
    entries,
    setEntries,
    activeModel,
    setActiveModel,
    inputBuffer,
    setInputBuffer,
    inputCursor,
    setInputCursor,
    questionBuffer,
    setQuestionBuffer,
    questionCursor,
    setQuestionCursor,
    busy,
    setBusy,
    mode,
    setMode,
    startupConfirmed,
    setStartupConfirmed,
    trusted,
    setTrusted,
    trustStatus,
    setTrustStatus,
    detailMode,
    setDetailMode,
    thinkingVisible,
    setThinkingVisible,
    pendingApproval,
    setPendingApproval,
    pendingQuestion,
    setPendingQuestion,
    history,
    setHistory,
    historyIndex,
    setHistoryIndex,
    sideView,
    setSideView,
    workflowFilter,
    setWorkflowFilter,
    taskFilter,
    setTaskFilter,
    activity,
    setActivity,
    stream,
    setStream,
    antState,
    setAntState,
    pulse,
    setPulse,
    idleSilent,
    setIdleSilent,
    inspectorItems,
    setInspectorItems,
    inspectorIndex,
    setInspectorIndex,
    inspectorOffset,
    setInspectorOffset,
    inspectorFilter,
    setInspectorFilter,
    inspectorPatchFileIndex,
    setInspectorPatchFileIndex,
    sidePanelOffset,
    setSidePanelOffset,
    permissionMode,
    setPermissionMode,
    slashPaletteDismissed,
    setSlashPaletteDismissed,
    slashPaletteIndex,
    setSlashPaletteIndex,
    fileMentionDismissed,
    setFileMentionDismissed,
    fileMentionCandidates,
    setFileMentionCandidates,
    fileMentionIndex,
    setFileMentionIndex,
    recentFiles,
    setRecentFiles,
    queuedPrompts,
    setQueuedPrompts,
    queuePanelIndex,
    setQueuePanelIndex,
    sessionRecords,
    setSessionRecords,
    sessionPickerIndex,
    setSessionPickerIndex,
    taskRecords,
    setTaskRecords,
    taskGroupRecords,
    setTaskGroupRecords,
    modelPickerOpen,
    setModelPickerOpen,
    modelPickerIndex,
    setModelPickerIndex,
    commandPanel,
    setCommandPanel,
    commandPanelOffset,
    setCommandPanelOffset,
    approvalChoiceIndex,
    setApprovalChoiceIndex,
    exitConfirmUntil,
    setExitConfirmUntil,
    interruptConfirmUntil,
    setInterruptConfirmUntil,
    backgroundExitPending,
    setBackgroundExitPending,
    transcriptScrollOffset,
    setTranscriptScrollOffset,
    streamScrollOffset,
    setStreamScrollOffset,
    selectedEntryId,
    setSelectedEntryId,
    selectedEntryHighlightUntil,
    setSelectedEntryHighlightUntil,
    transcriptSelection,
    setTranscriptSelection,
    messageActionIndex,
    setMessageActionIndex,
    commandPanelKindRef,
    entryIdCounterRef,
    sessionApprovals,
    queuedPromptsRef,
    runPromptDirectRef,
    currentTurnAbortRef,
    currentTurnPromptRef,
    pendingGuideInterruptRef,
    pendingGoalContinueRef,
    lastTurnStatusRef,
    agentTaskEntriesRef,
    sessionRef,
    stateRef,
    inputDraftRef,
    questionDraftRef,
    rawScrollInputTailRef,
    claimedInkInputRef,
    rawShiftTabInputTailRef,
    lastTranscriptClickRef,
    transcriptDragRef,
    bracketedPasteRef,
    lastActivityAtRef,
    idleSilentRef,
    exitConfirmUntilRef,
    interruptConfirmUntilRef,
    lastCtrlCHandledAtRef,
    transcriptScrollOffsetRef,
    streamScrollOffsetRef,
    sidePanelOffsetRef,
    backgroundControllersRef,
    backgroundExitPendingRef,
    taskRecordsLoaderRef,
    streamDeltaBufferRef,
    streamFlushTimerRef,
    activityEventCountRef,
    markUserActivity,
    replaceInputDraft,
    replaceQuestionDraft,
    updateInputDraft,
    updateQuestionDraft,
    setExitConfirmUntilValue,
    setInterruptConfirmUntilValue,
    flushStreamDeltas,
    scheduleStreamFlush,
    flushStreamDeltasNow,
    setTranscriptOffset,
    setStreamOffset,
    setSideOffset,
    scrollTranscriptBy,
    scrollStreamBy,
    scrollSidePanelBy,
    scrollOverlayBy,
    applyTargetScroll,
    applyVisibleScroll,
    applyMouseWheelScroll,
    insertPastedText,
    slashPalette,
    fileMention,
    modelOptions
  };
}
