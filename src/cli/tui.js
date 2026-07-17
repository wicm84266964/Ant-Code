import { execFile, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { appendFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process, { stdin as input, stdout as output } from "node:process";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, render, useApp, useInput, useStdin, useStdout } from "ink";
import { parseSlashCommand } from "../commands/parser.js";
import { cancelBackgroundAgentTasks, listBackgroundAgentTasks } from "../agents/background-registry.js";
import { createAgentTaskGroupStore } from "../agents/task-group-store.js";
import { createAgentTaskStore } from "../agents/task-store.js";
import { runSubagent } from "../agents/runner.js";
import { runSlashCommand } from "../commands/runtime.js";
import { clearSessionContext, compactSessionContextWithModel, summarizeContextWindow } from "../core/context-window.js";
import { createInitialEventState, reduceAntEvent } from "../core/event-reducer.js";
import { createSession, runSessionTurn } from "../core/session.js";
import { createLabModelGateway } from "../model-gateway/client.js";
import { listConfiguredModels } from "../model-gateway/models.js";
import { appendThinkingPreview, limitThinkingPreview } from "../model-gateway/thinking-budget.js";
import { resolveWorkspaceTrust, trustWorkspace } from "../permissions/workspace-trust.js";
import { createSessionStore } from "../storage/session-store.js";
import { getAntCodeVersion } from "../version.js";
import {
  clampDraftCursor,
  createDraft,
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
} from "./tui/input-editor.js";
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
} from "./tui/components.js";
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
} from "./tui/format.js";
import {
  INSPECTOR_FILTERS,
  INSPECTOR_OUTPUT_COMMANDS,
  MAX_INSPECTOR_ITEMS,
  initialInspector,
  inspectorCategoryForCommand,
  makeInspector,
  resolveInspectorIndex
} from "./tui/inspector.js";
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
} from "./tui/interaction.js";
import { resolveScrollTarget, resolveTuiFrame } from "./tui/layout.js";
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
} from "./tui/command-panels.js";
import {
  fileMentionState,
  insertFileMention,
  listFileMentionCandidates,
  movePaletteIndex,
  slashPaletteState
} from "./tui/palettes.js";
import { resolveTheme } from "./tui/theme.js";
import { createScrollableRegion } from "./tui/scroll-region.js";
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
} from "./tui/workflows.js";

const h = React.createElement;
const MAX_ENTRIES = 200;
const STREAM_FLUSH_INTERVAL_MS = 50;
const DEFAULT_IDLE_SILENT_AFTER_MS = 30 * 60 * 1000;
const TELEMETRY_ENTRY_KINDS = new Set(["gateway", "tool", "tools", "turn", "workflow", "trace"]);
const HIGH_FREQUENCY_ANT_EVENTS = new Set(["assistant_text_delta", "assistant_thinking_delta"]);
const MESSAGE_ACTIONS = Object.freeze(["copy", "copy-forward", "rewind-edit", "regenerate"]);
const WORKFLOW_FILTERS = Object.freeze(["incomplete", "completed", "all"]);
const TASK_FILTERS = Object.freeze(["active", "issues", "completed", "all"]);
const WORKFLOW_FILTER_LABELS = Object.freeze({
  incomplete: "未完成",
  completed: "已完成",
  all: "全部"
});
const TASK_FILTER_LABELS = Object.freeze({
  active: "活跃",
  issues: "暂停/失败",
  completed: "已完成",
  all: "全部"
});

/**
 * @param {{ cwd: string; env?: NodeJS.ProcessEnv; readonly?: boolean; allowWrite?: boolean; allowCommand?: boolean; fullAccess?: boolean; resume?: string | null; forceExitProcess?: (code: number) => void }} options
 */
export async function runTui(options) {
  if (!input.isTTY || !output.isTTY) {
    output.write("Ant Code TUI requires an interactive terminal. Use `ant-code chat` or `ant-code -p` in non-TTY contexts.\n");
    return;
  }

  const session = await createSession({
    cwd: options.cwd,
    mode: "interactive",
    env: options.env,
    readonly: options.readonly,
    allowWrite: options.allowWrite,
    allowCommand: options.allowCommand,
    fullAccess: options.fullAccess,
    resume: options.resume,
    resumeFullContext: Boolean(options.resume)
  });
  const trust = await resolveWorkspaceTrust({
    cwd: options.cwd,
    env: options.env,
    sensitivity: session.sensitivity
  });

  const initialWindowsConsoleInputMode = snapshotWindowsConsoleInputMode();
  const initialWindowsConsoleCodePage = snapshotWindowsConsoleCodePage();
  enterTerminalAppMode(output, { env: options.env });
  let instance = null;
  let forceExitCode = /** @type {number | null} */ (null);
  try {
    clearTerminalForFullRedraw(output);
    instance = render(h(TuiApp, {
      cwd: options.cwd,
      env: options.env,
      session,
      initialTrusted: trust.trusted,
      initialWindowsConsoleInputMode,
      onForceExit: (code) => {
        forceExitCode = Number.isInteger(code) ? code : 130;
      }
    }), {
      exitOnCtrlC: false,
      incrementalRendering: true,
      maxFps: 60
    });
    await instance.waitUntilExit();
  } finally {
    instance?.unmount?.();
    exitTerminalAppMode(output, { env: options.env, initialWindowsConsoleInputMode, initialWindowsConsoleCodePage });
  }
  if (forceExitCode !== null) {
    (options.forceExitProcess ?? process.exit)(forceExitCode);
  }
}

export function limitTranscriptEntries(entries = [], maxEntries = MAX_ENTRIES) {
  const limit = Math.max(1, Number(maxEntries) || MAX_ENTRIES);
  if (!Array.isArray(entries) || entries.length <= limit) {
    return Array.isArray(entries) ? entries : [];
  }

  const protectedEntries = entries.filter((entry) => isProtectedConversationEntry(entry));
  if (protectedEntries.length >= limit) {
    return protectedEntries;
  }

  const keepTelemetryCount = limit - protectedEntries.length;
  const telemetryEntries = entries
    .filter((entry) => !isProtectedConversationEntry(entry))
    .slice(-keepTelemetryCount);
  const retained = new Set([
    ...protectedEntries,
    ...telemetryEntries
  ]);
  return entries.filter((entry) => retained.has(entry));
}

export function resolveIdleSilentAfterMs(env = process.env) {
  const value = Number(env?.LAB_AGENT_TUI_IDLE_SILENT_MS);
  if (Number.isFinite(value)) {
    return Math.max(0, Math.trunc(value));
  }
  return DEFAULT_IDLE_SILENT_AFTER_MS;
}

export function shouldEnterIdleSilent(current = {}, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || 0);
  if (timeoutMs <= 0) {
    return false;
  }
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const lastActivityAt = Number.isFinite(options.lastActivityAt) ? options.lastActivityAt : now;
  if (now - lastActivityAt < timeoutMs) {
    return false;
  }
  if (!current.startupConfirmed || !current.trusted) {
    return false;
  }
  if (current.busy || current.stream?.active) {
    return false;
  }
  if (current.pendingApproval || current.pendingQuestion || current.modelPickerOpen || current.slashPalette || current.fileMention) {
    return false;
  }
  if (current.mode && current.mode !== "input") {
    return false;
  }
  if (Number(options.runningBackgroundCount ?? 0) > 0) {
    return false;
  }
  const hasRunningTask = Array.isArray(current.taskRecords)
    && current.taskRecords.some((task) => task?.status === "running" || task?.status === "queued");
  return !hasRunningTask;
}

export function createSynchronousDraftMirror(initial = {}) {
  const ref = {
    current: clampDraftCursor(createDraft(initial.text ?? "", initial.cursor ?? null))
  };
  return {
    ref,
    replace(text, cursor = null) {
      const next = clampDraftCursor(createDraft(text, cursor === null ? cursorToEnd(text) : cursor));
      ref.current = next;
      return next;
    },
    update(updater) {
      return updateDraftRef(ref, updater);
    }
  };
}

function isDiscardableTelemetryEntry(entry = {}) {
  if (!TELEMETRY_ENTRY_KINDS.has(entry.kind)) {
    return false;
  }
  return entry.kind !== "turn" || !/已中断|中断确认|工具轮次上限/i.test(String(entry.title ?? ""));
}

function isProtectedConversationEntry(entry = {}) {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  if (entry.kind === "user" || entry.kind === "assistant") {
    return true;
  }
  return !isDiscardableTelemetryEntry(entry);
}

/**
 * @param {{ cwd: string; env?: NodeJS.ProcessEnv; session: Awaited<ReturnType<typeof createSession>>; onForceExit?: (code: number) => void }} props
 */
function TuiApp(props) {
  if (props.session.permissionReadonlyLocked === undefined) {
    props.session.permissionReadonlyLocked = Boolean(props.session.readonly);
  }
  const { exit } = useApp();
  const { internal_eventEmitter: inputEvents } = useStdin();
  const { stdout } = useStdout();
  const theme = useMemo(() => resolveTheme(props.env?.LAB_AGENT_TUI_THEME, {
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
  const [pendingApproval, setPendingApproval] = useState(null);
  const [pendingQuestion, setPendingQuestion] = useState(null);
  const [history, setHistory] = useState([]);
  const [historyIndex, setHistoryIndex] = useState(null);
  const [sideView, setSideView] = useState("status");
  const [workflowFilter, setWorkflowFilter] = useState("incomplete");
  const [taskFilter, setTaskFilter] = useState("active");
  const [activity, setActivity] = useState(() => initialActivity(props.session));
  const [stream, setStream] = useState(() => initialStream());
  const [antState, setAntState] = useState(() => createInitialEventState());
  const [pulse, setPulse] = useState(0);
  const [idleSilent, setIdleSilent] = useState(false);
  const [inspectorItems, setInspectorItems] = useState(() => [initialInspector(props.session)]);
  const [inspectorIndex, setInspectorIndex] = useState(0);
  const [inspectorOffset, setInspectorOffset] = useState(0);
  const [inspectorFilter, setInspectorFilter] = useState("all");
  const [inspectorPatchFileIndex, setInspectorPatchFileIndex] = useState(0);
  const [sidePanelOffset, setSidePanelOffset] = useState(0);
  const [permissionMode, setPermissionMode] = useState(() => initialPermissionMode(props.session));
  const [slashPaletteDismissed, setSlashPaletteDismissed] = useState(false);
  const [slashPaletteIndex, setSlashPaletteIndex] = useState(0);
  const [fileMentionDismissed, setFileMentionDismissed] = useState(false);
  const [fileMentionCandidates, setFileMentionCandidates] = useState([]);
  const [fileMentionIndex, setFileMentionIndex] = useState(0);
  const [recentFiles, setRecentFiles] = useState([]);
  const [queuedPrompts, setQueuedPrompts] = useState([]);
  const [queuePanelIndex, setQueuePanelIndex] = useState(0);
  const [sessionRecords, setSessionRecords] = useState([]);
  const [sessionPickerIndex, setSessionPickerIndex] = useState(0);
  const [taskRecords, setTaskRecords] = useState([]);
  const [taskGroupRecords, setTaskGroupRecords] = useState([]);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modelPickerIndex, setModelPickerIndex] = useState(0);
  const [commandPanel, setCommandPanel] = useState(null);
  const [commandPanelOffset, setCommandPanelOffset] = useState(0);
  const [approvalChoiceIndex, setApprovalChoiceIndex] = useState(0);
  const [exitConfirmUntil, setExitConfirmUntil] = useState(0);
  const [interruptConfirmUntil, setInterruptConfirmUntil] = useState(0);
  const [backgroundExitPending, setBackgroundExitPending] = useState(false);
  const [transcriptScrollOffset, setTranscriptScrollOffset] = useState(0);
  const [streamScrollOffset, setStreamScrollOffset] = useState(0);
  const [selectedEntryId, setSelectedEntryId] = useState(null);
  const [selectedEntryHighlightUntil, setSelectedEntryHighlightUntil] = useState(0);
  const [messageActionIndex, setMessageActionIndex] = useState(0);
  const commandPanelKindRef = useRef(null);
  const entryIdCounterRef = useRef(0);
  const sessionApprovals = useRef(new Set());
  const queuedPromptsRef = useRef([]);
  const runPromptDirectRef = useRef(null);
  const currentTurnAbortRef = useRef(null);
  const currentTurnPromptRef = useRef("");
  const pendingGuideInterruptRef = useRef(null);
  const agentTaskEntriesRef = useRef(new Map());
  const sessionRef = useRef(props.session);
  const stateRef = useRef({});
  const inputDraftRef = useRef({ text: "", cursor: 0, visibleStart: 0 });
  const questionDraftRef = useRef({ text: "", cursor: 0, visibleStart: 0 });
  const rawScrollInputTailRef = useRef("");
  const claimedInkInputRef = useRef(false);
  const rawShiftTabInputTailRef = useRef("");
  const lastTranscriptClickRef = useRef({ entryId: null, at: 0 });
  const bracketedPasteRef = useRef({ active: false, buffer: "", prefix: "" });
  const lastActivityAtRef = useRef(Date.now());
  const idleSilentRef = useRef(false);
  const exitConfirmUntilRef = useRef(0);
  const interruptConfirmUntilRef = useRef(0);
  const lastCtrlCHandledAtRef = useRef(0);
  const transcriptScrollOffsetRef = useRef(0);
  const streamScrollOffsetRef = useRef(0);
  const sidePanelOffsetRef = useRef(0);
  const backgroundControllersRef = useRef(new Map());
  const backgroundExitPendingRef = useRef(false);
  const taskRecordsLoaderRef = useRef(/** @type {ReturnType<typeof createCoalescedAsyncRunner> | null} */ (null));
  const streamDeltaBufferRef = useRef(createStreamDeltaBuffer());
  const streamFlushTimerRef = useRef(null);
  const activityEventCountRef = useRef(0);
  commandPanelKindRef.current = commandPanel?.kind ?? null;

  const markUserActivity = useCallback((source = "input") => {
    lastActivityAtRef.current = Date.now();
    if (!idleSilentRef.current) {
      return;
    }
    idleSilentRef.current = false;
    setIdleSilent(false);
    setActivity((value) => ({ ...value, status: "已唤醒", lastTurn: source }));
  }, []);

  const replaceInputDraft = useCallback((text, cursor = null) => {
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
    stateRef.current.inputVisibleStart = next.visibleStart;
    setInputBuffer(next.text);
    setInputCursor(next.cursor);
    return next;
  }, []);

  const replaceQuestionDraft = useCallback((text, cursor = null) => {
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
    stateRef.current.questionVisibleStart = next.visibleStart;
    setQuestionBuffer(next.text);
    setQuestionCursor(next.cursor);
    return next;
  }, []);

  const updateInputDraft = useCallback((updater) => {
    const next = stabilizeDraftViewport(updateDraftRef(inputDraftRef, updater), {
      columns: composerContentColumns(stateRef.current),
      maxLines: 3
    });
    inputDraftRef.current = next;
    stateRef.current.inputBuffer = next.text;
    stateRef.current.inputCursor = next.cursor;
    stateRef.current.inputVisibleStart = next.visibleStart;
    setInputBuffer(next.text);
    setInputCursor(next.cursor);
    return next;
  }, []);

  const updateQuestionDraft = useCallback((updater) => {
    const next = stabilizeDraftViewport(updateDraftRef(questionDraftRef, updater), {
      columns: composerContentColumns({ ...stateRef.current, mode: "question" }),
      maxLines: 10
    });
    questionDraftRef.current = next;
    stateRef.current.questionBuffer = next.text;
    stateRef.current.questionCursor = next.cursor;
    stateRef.current.questionVisibleStart = next.visibleStart;
    setQuestionBuffer(next.text);
    setQuestionCursor(next.cursor);
    return next;
  }, []);

  const setExitConfirmUntilValue = useCallback((value) => {
    exitConfirmUntilRef.current = Math.max(0, Number(value) || 0);
    setExitConfirmUntil(exitConfirmUntilRef.current);
  }, []);

  const setInterruptConfirmUntilValue = useCallback((value) => {
    interruptConfirmUntilRef.current = Math.max(0, Number(value) || 0);
    setInterruptConfirmUntil(interruptConfirmUntilRef.current);
  }, []);

  const flushStreamDeltas = useCallback((baseStream = null) => {
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

  const setTranscriptOffset = useCallback((valueOrUpdater) => {
    const next = typeof valueOrUpdater === "function"
      ? valueOrUpdater(transcriptScrollOffsetRef.current)
      : valueOrUpdater;
    transcriptScrollOffsetRef.current = Math.max(0, Number(next) || 0);
    setTranscriptScrollOffset(transcriptScrollOffsetRef.current);
  }, []);

  const setStreamOffset = useCallback((valueOrUpdater) => {
    const next = typeof valueOrUpdater === "function"
      ? valueOrUpdater(streamScrollOffsetRef.current)
      : valueOrUpdater;
    streamScrollOffsetRef.current = Math.max(0, Number(next) || 0);
    setStreamScrollOffset(streamScrollOffsetRef.current);
  }, []);

  const setSideOffset = useCallback((valueOrUpdater) => {
    const next = typeof valueOrUpdater === "function"
      ? valueOrUpdater(sidePanelOffsetRef.current)
      : valueOrUpdater;
    sidePanelOffsetRef.current = Math.max(0, Number(next) || 0);
    setSidePanelOffset(sidePanelOffsetRef.current);
  }, []);

  const scrollTranscriptBy = useCallback((rows, current = stateRef.current) => {
    setTranscriptOffset((value) => {
      const region = transcriptRegionForState({
        ...current,
        transcriptScrollOffset: value
      });
      return region.scrollBy(rows);
    });
  }, [setTranscriptOffset]);

  const scrollStreamBy = useCallback((rows, current = stateRef.current) => {
    setStreamOffset((value) => {
      const region = streamRegionForState({
        ...current,
        streamScrollOffset: value
      });
      return region.scrollBy(rows);
    });
  }, [setStreamOffset]);

  const scrollSidePanelBy = useCallback((rows, current = stateRef.current) => {
    setSideOffset((value) => value + rows);
  }, [setSideOffset]);

  const scrollOverlayBy = useCallback((rows, current = stateRef.current) => {
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
      for (let index = 0; index < steps; index += 1) {
        setSlashPaletteIndex((value) => movePaletteIndex(current.slashPalette.commands, value, direction));
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

  const applyTargetScroll = useCallback((target, direction, current = stateRef.current, rows = 4) => {
    if (direction === 0) {
      return false;
    }
    const delta = direction * rows;
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

  const applyVisibleScroll = useCallback((direction, current = stateRef.current, rows = 4, target = "transcript") => (
    applyTargetScroll(target, direction, current, rows)
  ), [applyTargetScroll]);

  const applyMouseWheelScroll = useCallback((event, current = stateRef.current, rows = 4) => {
    const frame = frameForState(current);
    let target = resolveScrollTarget(event, frame, {
      activeOverlay: Boolean(activeOverlayKind(current)),
      defaultTarget: "transcript"
    });
    if (target === "transcript") {
      target = transcriptSubtargetForMouse(event, current, frame);
    }
    return applyTargetScroll(target, event.direction, current, rows);
  }, [applyTargetScroll]);

  const insertPastedText = useCallback((value, current = stateRef.current) => {
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
    const resizeTimers = new Set();
    let initialized = false;
    let lastSize = readTerminalSize(stdout);
    const clearResizeTimers = () => {
      for (const timer of resizeTimers) {
        clearTimeout(timer);
      }
      resizeTimers.clear();
    };
    const scheduleMouseRefresh = (size) => {
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
      for (const [delay, forceConsoleMode] of [[40, false], [160, false], [320, true], [520, false]]) {
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
      messageActionIndex,
      terminalSize,
      modelOptions
    };
  }, [entries, inputBuffer, inputCursor, questionBuffer, questionCursor, busy, mode, stream, startupConfirmed, trusted, trustStatus, pendingApproval, pendingQuestion, history, historyIndex, sideView, workflowFilter, taskFilter, inspectorIndex, inspectorFilter, inspectorItems, inspectorPatchFileIndex, sidePanelOffset, detailMode, thinkingVisible, permissionMode, slashPalette, slashPaletteIndex, fileMention, fileMentionCandidates, fileMentionIndex, recentFiles, queuedPrompts, queuePanelIndex, sessionRecords, sessionPickerIndex, taskRecords, taskGroupRecords, modelPickerOpen, modelPickerIndex, commandPanel, commandPanelOffset, approvalChoiceIndex, exitConfirmUntil, interruptConfirmUntil, backgroundExitPending, idleSilent, transcriptScrollOffset, streamScrollOffset, selectedEntryId, selectedEntryHighlightUntil, messageActionIndex, terminalSize, modelOptions]);

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

  const addEntry = useCallback((kind, title, body, metadata = undefined) => {
    setEntries((current) => {
      const id = metadata?.id ?? `entry-${Date.now().toString(36)}-${entryIdCounterRef.current++}`;
      const existingIndex = metadata?.id
        ? current.findIndex((entry) => entry.id === metadata.id)
        : -1;
      if (existingIndex >= 0) {
        const next = current.slice();
        next[existingIndex] = {
          ...next[existingIndex],
          kind,
          title,
          body: String(body ?? ""),
          at: new Date().toLocaleTimeString(),
          ...(metadata && typeof metadata === "object" ? metadata : {})
        };
        return next;
      }
      const next = [
        ...current,
        {
          id,
          kind,
          title,
          body: String(body ?? ""),
          at: new Date().toLocaleTimeString(),
          ...(metadata && typeof metadata === "object" ? metadata : {})
        }
      ];
      return limitTranscriptEntries(next, MAX_ENTRIES);
    });
  }, []);

  const updateEntryById = useCallback((id, patch) => {
    if (!id) {
      return;
    }
    setEntries((current) => current.map((entry) => (
      entry.id === id
        ? {
          ...entry,
          ...(typeof patch === "function" ? patch(entry) : patch),
          at: new Date().toLocaleTimeString()
        }
        : entry
    )));
  }, []);

  const openCommandPanel = useCallback((panel) => {
    setModelPickerOpen(false);
    setSlashPaletteDismissed(true);
    setFileMentionDismissed(true);
    setCommandPanel(panel);
    setCommandPanelOffset(0);
  }, []);

  const clearTransientEntrySelection = useCallback(() => {
    setSelectedEntryId((value) => {
      if (!value) {
        return value;
      }
      if (commandPanelKindRef.current === "message-actions" || commandPanelKindRef.current === "message-excerpt" || commandPanelKindRef.current === "agent-live") {
        return value;
      }
      return null;
    });
    setSelectedEntryHighlightUntil(0);
    setMessageActionIndex(0);
    lastTranscriptClickRef.current = { entryId: null, at: 0 };
  }, []);

  useEffect(() => {
    if (selectedEntryHighlightUntil <= 0) {
      return undefined;
    }
    const delay = Math.max(0, selectedEntryHighlightUntil - Date.now());
    const timer = setTimeout(() => {
      clearTransientEntrySelection();
    }, delay);
    return () => clearTimeout(timer);
  }, [clearTransientEntrySelection, selectedEntryHighlightUntil]);

  useEffect(() => {
    if (selectedEntryHighlightUntil > 0) {
      clearTransientEntrySelection();
    }
  }, [clearTransientEntrySelection, inputBuffer, questionBuffer]);

  const openLogsPanel = useCallback((options = {}) => {
    const items = options.items ?? stateRef.current.inspectorItems ?? inspectorItems;
    const filter = options.filter ?? stateRef.current.inspectorFilter ?? inspectorFilter;
    const index = resolveInspectorIndex(items, options.index ?? stateRef.current.inspectorIndex ?? inspectorIndex, filter);
    const inspector = options.inspector ?? items[index] ?? items[items.length - 1] ?? initialInspector(sessionRef.current);
    const panel = createLogsPanel({
      inspector,
      items,
      index,
      offset: options.offset ?? stateRef.current.inspectorOffset ?? inspectorOffset,
      filter,
      patchFileIndex: options.patchFileIndex ?? stateRef.current.inspectorPatchFileIndex ?? inspectorPatchFileIndex
    });
    openCommandPanel(panel);
  }, [inspectorFilter, inspectorIndex, inspectorItems, inspectorOffset, inspectorPatchFileIndex, openCommandPanel]);

  const cyclePermissionMode = useCallback((current = stateRef.current, source = "key") => {
    if (!current.startupConfirmed || !current.trusted) {
      return false;
    }
    const nextMode = nextPermissionMode(sessionRef.current, current.permissionMode);
    applyPermissionMode(sessionRef.current, nextMode);
    sessionApprovals.current = new Set();
    setPermissionMode(nextMode);
    const effectNote = current.busy
      ? "当前运行中的轮次保留启动时权限；新模式从后续提示/命令生效；本会话同类批准已清空。"
      : "新模式从后续提示/命令生效；本会话同类批准已清空。";
    addEntry("permission", "模式已切换", [
      `${permissionModeLabel(sessionRef.current)}: ${permissionModeDescription(nextMode)}`,
      effectNote
    ].join("\n"));
    setActivity((value) => ({ ...value, status: `权限：${permissionModeLabel(sessionRef.current)}（后续生效）` }));
    debugTuiInput(props.env, `permission_switch source=${source} mode=${nextMode}`);
    return true;
  }, [addEntry, props.env]);

  const switchLogsPanelFilter = useCallback((filter) => {
    const current = stateRef.current;
    const items = current.inspectorItems ?? [];
    const nextIndex = resolveInspectorIndex(items, current.inspectorIndex ?? 0, filter);
    setInspectorFilter(filter);
    setInspectorIndex(nextIndex);
    setInspectorOffset(0);
    setInspectorPatchFileIndex(0);
    openLogsPanel({
      items,
      index: nextIndex,
      filter,
      offset: 0,
      patchFileIndex: 0
    });
  }, [openLogsPanel]);

  const pushInspector = useCallback((item) => {
    setInspectorItems((current) => {
      const next = [...current, item].slice(-MAX_INSPECTOR_ITEMS);
      setInspectorIndex(next.length - 1);
      return next;
    });
    setInspectorOffset(0);
    setInspectorPatchFileIndex(0);
  }, []);

  const summarizeInfo = useCallback(() => summarizeSessionInfo(sessionRef.current), []);

  const setQueueState = useCallback((prompts, nextIndex = 0) => {
    const nextPrompts = Array.isArray(prompts) ? prompts.slice(0, 20) : [];
    queuedPromptsRef.current = nextPrompts;
    setQueuedPrompts(nextPrompts);
    setQueuePanelIndex(boundedIndex(nextPrompts, nextIndex));
  }, []);

  const openQueuePanel = useCallback((selectedIndex = 0) => {
    const index = boundedIndex(queuedPromptsRef.current, selectedIndex);
    setQueuePanelIndex(index);
    openCommandPanel(createQueuePanel({
      queuedPrompts: queuedPromptsRef.current,
      selectedIndex: index,
      busy: stateRef.current.busy
    }));
  }, [openCommandPanel]);

  const loadSessionRecords = useCallback(async () => {
    const store = createSessionStore({
      cwd: props.cwd,
      transcript: sessionRef.current.config.transcript,
      env: props.env
    });
    const records = await store.listSessionRecords();
    setSessionRecords(records);
    setSessionPickerIndex((value) => boundedIndex(records, value));
    return records;
  }, [props.cwd, props.env]);

  const readTaskRecords = useCallback(async () => {
    const store = createAgentTaskStore({ cwd: props.cwd });
    const groupStore = createAgentTaskGroupStore({ cwd: props.cwd });
    const records = await store.listTasks({ parentSessionId: sessionRef.current.id });
    const groups = await groupStore.listGroups({ parentSessionId: sessionRef.current.id });
    setTaskRecords(records);
    setTaskGroupRecords(groups);
    return records;
  }, [props.cwd]);

  useEffect(() => {
    const runner = createCoalescedAsyncRunner(readTaskRecords);
    taskRecordsLoaderRef.current = runner;
    return () => {
      runner.dispose();
      if (taskRecordsLoaderRef.current === runner) {
        taskRecordsLoaderRef.current = null;
      }
    };
  }, [readTaskRecords]);

  const loadTaskRecords = useCallback(async () => {
    try {
      return await (taskRecordsLoaderRef.current?.run() ?? readTaskRecords());
    } catch (error) {
      debugTuiInput(props.env, `task_records_refresh_failed error=${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }, [props.env, readTaskRecords]);

  useEffect(() => {
    if (!startupConfirmed || !trusted) {
      return;
    }
    void loadTaskRecords();
  }, [loadTaskRecords, startupConfirmed, trusted]);

  useEffect(() => {
    if (!startupConfirmed || !trusted) {
      return undefined;
    }
    if (commandPanelKindRef.current === "message-excerpt") {
      return undefined;
    }
    const hasRunningTask = taskRecords.some((task) => task.status === "running" || task.status === "queued");
    const hasLocalBackground = backgroundControllersRef.current.size > 0;
    const showingAgentLive = commandPanel?.kind === "agent-live";
    if (idleSilent && !hasRunningTask && !hasLocalBackground) {
      return undefined;
    }
    if (!hasRunningTask && !hasLocalBackground && sideView !== "tasks" && !showingAgentLive) {
      return undefined;
    }
    const timer = setInterval(() => {
      void loadTaskRecords();
    }, hasRunningTask || hasLocalBackground || showingAgentLive ? 1000 : 2500);
    return () => clearInterval(timer);
  }, [commandPanel?.kind, idleSilent, loadTaskRecords, sideView, startupConfirmed, taskRecords, trusted]);

  const openSessionsPanel = useCallback(async () => {
    try {
      const records = await loadSessionRecords();
      const selectedIndex = boundedIndex(records, stateRef.current.sessionPickerIndex);
      setSessionPickerIndex(selectedIndex);
      openCommandPanel(createSessionsPanel({
        records,
        selectedIndex,
        currentSessionId: sessionRef.current.id
      }));
      pushInspector(makeInspector("会话", "/sessions", `${records.length} 条本地 metadata 记录。`, "context"), { focus: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      addEntry("error", "会话加载失败", message);
      openCommandPanel(createTextOutputPanel({
        title: "会话",
        command: "/sessions",
        output: message,
        kind: "sessions-output"
      }));
    }
  }, [addEntry, loadSessionRecords, openCommandPanel, pushInspector]);

  const openResumePanel = useCallback((selectedIndex = undefined) => {
    const panel = createResumePanel({
      session: sessionRef.current,
      selectedIndex
    });
    openCommandPanel(panel);
    const chunks = sessionRef.current.transcriptArchive?.chunks?.length ?? 0;
    pushInspector(makeInspector("Resume", "/resume", `当前会话 ${chunks} 个 transcript 分片；/sessions 负责恢复会话。`, "context"), { focus: false });
  }, [openCommandPanel, pushInspector]);

  const openResumeChunkPanel = useCallback(async (chunkIndex) => {
    const index = Number.parseInt(String(chunkIndex ?? ""), 10);
    if (!Number.isInteger(index) || index <= 0) {
      openCommandPanel(createResumeHelpPanel());
      pushInspector(makeInspector("Resume", "/resume", "分片序号无效；使用 /resume 查看当前会话分片列表。", "context"), { focus: false });
      return;
    }
    const store = createSessionStore({
      cwd: props.cwd,
      transcript: sessionRef.current.config.transcript,
      env: props.env
    });
    const result = await store.readTranscriptChunk(sessionRef.current.transcriptArchive, index);
    if (!result.ok) {
      const message = result.error?.message ?? `无法读取分片 ${index}`;
      openCommandPanel(createTextOutputPanel({
        title: "Resume",
        command: `/resume ${index}`,
        output: `${message}\n\n当前 /resume 只查看当前会话的历史分片；恢复/切换会话请使用 /sessions。`,
        kind: "resume-output"
      }));
      pushInspector(makeInspector("Resume", `/resume ${index}`, message, "context"), { focus: false });
      return;
    }
    openCommandPanel(createResumeChunkPanel({
      session: sessionRef.current,
      chunk: result.chunk,
      messages: result.messages
    }));
    pushInspector(makeInspector("Resume", `/resume ${index}`, `已打开当前会话分片 ${index}，${result.messages.length} 条消息。`, "context"), { focus: false });
  }, [openCommandPanel, props.cwd, props.env, pushInspector]);

  const clearContextNow = useCallback(() => {
    clearSessionContext(sessionRef.current);
    addEntry("context", "已清除", "对话上下文已清除。");
    openCommandPanel(createContextPanel({ session: sessionRef.current }));
    pushInspector(makeInspector("上下文", "/clear", "对话上下文已清除。", "context"), { focus: true });
  }, [addEntry, openCommandPanel, pushInspector]);

  const replaceSession = useCallback(async (options = {}) => {
    if (stateRef.current.busy) {
      addEntry("session", "切换被阻止", "切换会话前，请先等待当前轮次结束或中断当前轮次。");
      return;
    }
    try {
      const previousSession = sessionRef.current;
      const carriedPermissionMode = initialPermissionMode(previousSession);
      const nextSession = await createSession({
        cwd: props.cwd,
        mode: "interactive",
        env: props.env,
        readonly: carriedPermissionMode === "plan" && Boolean(previousSession.permissionReadonlyLocked ?? previousSession.readonly),
        allowWrite: carriedPermissionMode === "workspace",
        allowCommand: carriedPermissionMode === "workspace",
        fullAccess: carriedPermissionMode === "fullAccess",
        resume: options.resume ?? null,
        resumeFullContext: Boolean(options.resume)
      });
      nextSession.permissionReadonlyLocked = Boolean(nextSession.permissionReadonlyLocked);
      const nextPermissionMode = initialPermissionMode(nextSession);
      applyPermissionMode(nextSession, nextPermissionMode);
      sessionRef.current = nextSession;
      sessionApprovals.current = new Set();
      queuedPromptsRef.current = [];
      setQueuedPrompts([]);
      setQueuePanelIndex(0);
      setTaskRecords([]);
      setTaskGroupRecords([]);
      setActiveModel(nextSession.model);
      setPermissionMode(nextPermissionMode);
      const sessionSwitchEntry = withEntryIdentity({
        kind: "session",
        title: options.resume ? "会话已恢复" : "新会话",
        body: options.resume
          ? `已恢复本地会话 '${options.resume}'，恢复 ${nextSession.messages.length} 条消息。`
          : "已启动新的本地会话。之前的排队提示已清空。",
        at: new Date().toLocaleTimeString()
      });
      setEntries([
        ...initialEntries(nextSession),
        sessionSwitchEntry
      ]);
      entryIdCounterRef.current += 1;
      setActivity(initialActivity(nextSession));
      setStream(initialStream());
      setThinkingVisible(false);
      setAntState(createInitialEventState());
      setInspectorItems([initialInspector(nextSession)]);
      setInspectorIndex(0);
      setInspectorOffset(0);
      setInspectorFilter("all");
      setInspectorPatchFileIndex(0);
      replaceInputDraft("");
      replaceQuestionDraft("");
      setMode("input");
      setPendingApproval(null);
      setPendingQuestion(null);
      setModelPickerOpen(false);
      setCommandPanel(null);
      setCommandPanelOffset(0);
      setTranscriptOffset(0);
      setStreamOffset(0);
      setSideOffset(0);
      setSideView("status");
      setHistoryIndex(null);
      setRecentFiles([]);
      setSelectedEntryId(null);
      setMessageActionIndex(0);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      addEntry("error", options.resume ? "恢复失败" : "新会话失败", message);
      openCommandPanel(createTextOutputPanel({
        title: options.resume ? "恢复失败" : "新会话失败",
        command: options.resume ? `/sessions (${options.resume})` : "/new",
        output: message,
        kind: "sessions-output"
      }));
    }
  }, [addEntry, openCommandPanel, props.cwd, props.env, replaceInputDraft, replaceQuestionDraft, setSideOffset, setStreamOffset, setTranscriptOffset]);

  const switchModel = useCallback((model) => {
    sessionRef.current.model = model.id;
    sessionRef.current.config.modelAlias = model.id;
    setActiveModel(model.id);
    setActivity((current) => ({ ...current, status: `模型 ${model.id}` }));
    addEntry("model", "模型已切换", `${model.id}${model.thinking ? "\nthinking：provider 暴露的 thinking 默认隐藏，可用 /thinking 展开当前可见内容" : ""}`);
    pushInspector(makeInspector("模型", "/model", [
      `当前：${model.id}`,
      `标签：${model.label}`,
      `thinking：${model.thinking ? "网关流式返回时此别名支持；默认隐藏" : "无专用 thinking 流"}`,
      `网关：${sessionRef.current.config.lab?.gatewayProtocol ?? "lab-agent-gateway"}`
    ].join("\n"), "context"), { focus: false });
  }, [addEntry, pushInspector]);

  const selectedEntry = useMemo(() => (
    entries.find((entry) => entry.id === selectedEntryId) ?? null
  ), [entries, selectedEntryId]);

  const openMessageActions = useCallback((entry, actionIndex = 0) => {
    if (!entry) {
      return false;
    }
    setSelectedEntryId(entry.id);
    setSelectedEntryHighlightUntil(0);
    setMessageActionIndex(actionIndex);
    openCommandPanel(createMessageActionsPanel({ entry, actionIndex }));
    return true;
  }, [openCommandPanel]);

  const openMessageExcerpt = useCallback(async (entry) => {
    if (!entry) {
      return false;
    }
    setSelectedEntryId(entry.id);
    setSelectedEntryHighlightUntil(0);
    setMessageActionIndex(0);
    let excerptEntry = entry;
    if (entry.kind === "agent" && entry.taskId) {
      const taskId = String(entry.taskId ?? "").trim();
      const cachedTask = stateRef.current.taskRecords?.find((task) => task.id === taskId);
      let task = cachedTask ?? null;
      let taskError = null;
      if (!task) {
        const store = createAgentTaskStore({ cwd: props.cwd });
        const result = await store.readTask(taskId);
        if (result.ok) {
          task = result.task;
        } else {
          taskError = result.error?.message ?? "任务记录不可读。";
        }
      }
      if (task) {
        task = await hydrateTaskOutput(task, props.cwd);
        const body = formatAgentTaskExcerptBody(task, entry);
        updateEntryById(entry.id, { excerptBody: body });
        excerptEntry = {
          ...entry,
          title: task.title || entry.title,
          body,
          task
        };
      } else {
        const body = [
          String(entry.body ?? ""),
          "",
          `任务记录读取失败：${taskError ?? "未找到任务记录。"}`
        ].join("\n").trim();
        updateEntryById(entry.id, { excerptBody: body });
        excerptEntry = {
          ...entry,
          body,
          task: {
            id: taskId,
            profile: entry.profile ?? "unknown",
            status: entry.taskStatus ?? "unknown",
            title: entry.title ?? "子任务"
          }
        };
      }
    }
    openCommandPanel(createMessageExcerptPanel({ entry: excerptEntry }));
    enterTerminalSelectionMode(stdout, {
      env: props.env,
      reason: "open-message-excerpt",
      initialWindowsConsoleInputMode: props.initialWindowsConsoleInputMode
    });
    setActivity((value) => ({ ...value, status: entry.kind === "agent" ? "子智能体摘录：可拖选复制" : "摘录面板：可拖选部分文字复制" }));
    return true;
  }, [openCommandPanel, props.cwd, props.initialWindowsConsoleInputMode, stdout, updateEntryById]);

  const freezeAgentTaskExcerpt = useCallback(async (entry = selectedEntry) => {
    const target = entry ?? stateRef.current.entries?.find((item) => item.id === stateRef.current.selectedEntryId);
    if (!target || target.kind !== "agent") {
      addEntry("agent", "不能冻结摘录", "当前没有选中的子智能体任务。");
      return false;
    }
    return openMessageExcerpt(target);
  }, [addEntry, openMessageExcerpt, selectedEntry]);

  useEffect(() => {
    if (commandPanel?.kind === "message-excerpt") {
      return;
    }
    if (commandPanel?.kind !== "message-actions" && commandPanel?.kind !== "message-excerpt" && commandPanel?.kind !== "agent-live") {
      return;
    }
    if (!selectedEntry) {
      setCommandPanel(null);
      setCommandPanelOffset(0);
      return;
    }
    if (commandPanel.kind === "agent-live") {
      const task = commandPanel.taskId
        ? stateRef.current.taskRecords?.find((item) => item.id === commandPanel.taskId) ?? commandPanel.task
        : commandPanel.task;
      setCommandPanel(createAgentTaskLivePanel({ task, entry: selectedEntry }));
      return;
    }
    setCommandPanel(commandPanel.kind === "message-excerpt"
      ? createMessageExcerptPanel({ entry: selectedEntry })
      : createMessageActionsPanel({
        entry: selectedEntry,
        actionIndex: messageActionIndex
      }));
  }, [commandPanel?.kind, commandPanel?.taskId, messageActionIndex, selectedEntry?.id, selectedEntry?.body, selectedEntry?.excerptBody, selectedEntry?.taskStatus, selectedEntry?.title, taskRecords]);

  const openAgentTaskLivePanel = useCallback(async (entry) => {
    if (!entry?.taskId) {
      return false;
    }
    setSelectedEntryId(entry.id);
    setSelectedEntryHighlightUntil(0);
    setMessageActionIndex(0);
    const taskId = String(entry.taskId ?? "").trim();
    let task = stateRef.current.taskRecords?.find((item) => item.id === taskId) ?? null;
    if (!task) {
      const store = createAgentTaskStore({ cwd: props.cwd });
      const result = await store.readTask(taskId);
      if (result.ok) {
        task = result.task;
      }
    }
    if (task) {
      task = await hydrateTaskOutput(task, props.cwd);
    }
    const panelTask = task ?? {
      id: taskId,
      profile: entry.profile ?? "unknown",
      status: entry.taskStatus ?? "unknown",
      title: entry.title ?? "子任务",
      latestProgress: "任务记录暂不可读；稍后会随任务列表刷新。"
    };
    openCommandPanel(createAgentTaskLivePanel({ task: panelTask, entry }));
    setActivity((value) => ({ ...value, status: "子智能体详情：实时刷新" }));
    return true;
  }, [openCommandPanel, props.cwd]);

  const copyMessageText = useCallback((text, label) => {
    const result = writeClipboardText(text, props.env);
    if (result.ok) {
      addEntry("clipboard", "已复制", `${label} 已复制到系统剪贴板。`);
      setActivity((value) => ({ ...value, status: "就绪" }));
      return true;
    }
    addEntry("error", "复制失败", result.error ?? "系统剪贴板不可用。");
    pushInspector(makeInspector("复制失败", "clipboard", result.error ?? "系统剪贴板不可用。", "error"), { focus: true });
    return false;
  }, [addEntry, props.env, pushInspector]);

  const truncateConversationToEntry = useCallback((entry, options = {}) => {
    if (!entry || entry.kind !== "user" || !Number.isInteger(entry.checkpointMessagesLength)) {
      addEntry("session", "不能回退", "这条用户消息缺少 checkpoint，只能复制，不能回退或重生成。");
      return false;
    }
    if (stateRef.current.busy) {
      addEntry("session", "回退被阻止", "请先等待当前轮次结束或中断后再回退。");
      return false;
    }
    const checkpoint = Math.max(0, entry.checkpointMessagesLength);
    sessionRef.current.messages = sessionRef.current.messages.slice(0, checkpoint);
    const entryIndex = stateRef.current.entries.findIndex((item) => item.id === entry.id);
    if (entryIndex >= 0) {
      setEntries((current) => current.slice(0, entryIndex));
    }
    setTranscriptOffset(0);
    setStreamOffset(0);
    setStream(initialStream());
    setThinkingVisible(false);
    setPendingApproval(null);
    setPendingQuestion(null);
    setMode("input");
    setSelectedEntryId(null);
    setMessageActionIndex(0);
    setCommandPanel(null);
    setCommandPanelOffset(0);
    setActivity((value) => ({ ...value, status: options.regenerate ? "从消息重生成" : "已回退到输入栏" }));
    return true;
  }, [addEntry, setStreamOffset, setTranscriptOffset]);

  const editFromMessage = useCallback((entry) => {
    if (!truncateConversationToEntry(entry, { regenerate: false })) {
      return false;
    }
    const text = String(entry.body ?? "");
    replaceInputDraft(text);
    setSlashPaletteDismissed(false);
    setFileMentionDismissed(false);
    setHistoryIndex(null);
    addEntry("session", "已回退", "已将选中的用户消息放回输入栏。注意：不会撤销此前工具对文件系统造成的改动。");
    return true;
  }, [addEntry, replaceInputDraft, truncateConversationToEntry]);

  const regenerateFromMessage = useCallback((entry) => {
    if (!truncateConversationToEntry(entry, { regenerate: true })) {
      return false;
    }
    addEntry("session", "重新生成", "已回退对话上下文，并从选中用户消息重新生成。文件系统改动不会自动回滚。");
    void runPromptDirectRef.current?.(String(entry.body ?? ""));
    return true;
  }, [addEntry, truncateConversationToEntry]);

  const hydrateEntryFromState = useCallback((entry) => {
    if (!entry || entry.kind !== "agent" || entry.excerptBody) {
      return entry;
    }
    const task = stateRef.current.taskRecords?.find((item) => item.id === entry.taskId);
    return task
      ? { ...entry, excerptBody: formatAgentTaskExcerptBody(task, entry), task }
      : entry;
  }, []);

  const runMessageAction = useCallback((entry, actionIndex = 0) => {
    const actions = messageActionsForEntry(entry);
    const validIndex = Number.isInteger(actionIndex) && actionIndex >= 0 && actionIndex < actions.length;
    const action = validIndex ? actions[actionIndex] : null;
    if (!entry || !action || action === "rewind-disabled") {
      addEntry("message", "操作不可用", "当前消息不支持这个操作。");
      return false;
    }
    if (action === "copy") {
      return copyMessageText(formatEntryForClipboard(hydrateEntryFromState(entry)), "当前消息块");
    }
    if (action === "copy-forward") {
      const text = formatEntriesForClipboard(entriesFromSelected(entries, entry.id).map(hydrateEntryFromState));
      return copyMessageText(text, "从这里到最新的消息");
    }
    if (action === "rewind-edit") {
      return editFromMessage(entry);
    }
    if (action === "regenerate") {
      return regenerateFromMessage(entry);
    }
    return false;
  }, [addEntry, copyMessageText, editFromMessage, entries, hydrateEntryFromState, regenerateFromMessage]);

  const selectTranscriptEntryAtMouse = useCallback((event, current = stateRef.current) => {
    const entry = entryAtTranscriptMouseEvent(event, current);
    if (!entry) {
      debugTuiInput(props.env, `mouse_transcript_entry miss x=${event?.x ?? "?"} y=${event?.y ?? "?"}`);
      return false;
    }
    const now = Date.now();
    const last = lastTranscriptClickRef.current;
    const doubleClick = last.entryId === entry.id && now - last.at <= 420;
    debugTuiInput(props.env, `mouse_transcript_entry hit id=${entry.id} kind=${entry.kind} double=${doubleClick ? "1" : "0"}`);
    lastTranscriptClickRef.current = { entryId: entry.id, at: now };
    if (doubleClick) {
      if (entry.kind === "agent" && entry.taskId) {
        void openAgentTaskLivePanel(entry);
      } else {
        void openMessageExcerpt(entry);
      }
      return true;
    }
    setSelectedEntryId(entry.id);
    setSelectedEntryHighlightUntil(now + 1500);
    setMessageActionIndex(0);
    setActivity((value) => ({ ...value, status: "已指向消息块；双击进入摘录面板" }));
    return true;
  }, [openMessageExcerpt, props.env]);

  const applyRawDraftOperations = useCallback((operations, current = stateRef.current) => {
    const actionable = operations.filter((operation) => operation.type !== "ignore");
    if (actionable.length === 0) {
      return true;
    }
    const updater = (draft) => actionable.reduce((next, operation) => {
      if (operation.type === "insert") {
        const text = sanitizeComposerText(operation.text);
        return text ? insertText(next, text) : next;
      }
      if (operation.type === "backward-word") {
        return deleteWordBackward(next);
      }
      if (operation.type === "forward-word") {
        return deleteWordForward(next);
      }
      return operation.type === "forward" ? deleteForward(next) : deleteBackward(next);
    }, draft);
    if (current.mode === "question" && current.pendingQuestion) {
      updateQuestionDraft(updater);
      return true;
    }
    if (
      current.mode !== "input"
      || !current.startupConfirmed
      || !current.trusted
      || current.pendingApproval
      || current.modelPickerOpen
      || current.commandPanel
    ) {
      return false;
    }
    updateInputDraft(updater);
    setSlashPaletteDismissed(false);
    setFileMentionDismissed(false);
    setHistoryIndex(null);
    return true;
  }, [updateInputDraft, updateQuestionDraft]);

  useEffect(() => {
    const onRawInput = (chunk) => {
      const chunkText = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "");
      markUserActivity("raw-input");
      debugRawInput(props.env, chunkText);
      const current = stateRef.current;
      const pasted = readBracketedPaste(chunkText, bracketedPasteRef.current);
      if (pasted !== null) {
        claimedInkInputRef.current = true;
        insertPastedText(pasted, current);
        return;
      }
      const draftOperations = rawDraftEditOperations(chunkText);
      if (draftOperations) {
        const draftActive = (current.mode === "question" && current.pendingQuestion)
          || (current.mode === "input"
            && current.startupConfirmed
            && current.trusted
            && !current.pendingApproval
            && !current.modelPickerOpen
            && !current.commandPanel);
        if (draftActive) {
          claimedInkInputRef.current = true;
          applyRawDraftOperations(draftOperations, current);
          return;
        }
        const forwardOnly = draftOperations.length === 1
          && (draftOperations[0].type === "forward" || draftOperations[0].type === "forward-word");
        if (!forwardOnly) {
          claimedInkInputRef.current = true;
          return;
        }
      }
      const shiftTabText = `${rawShiftTabInputTailRef.current}${chunkText}`;
      rawShiftTabInputTailRef.current = trailingRawShiftTabInput(shiftTabText);
      const shiftTabs = rawShiftTabPresses(shiftTabText);
      if (shiftTabs > 0) {
        claimedInkInputRef.current = true;
        rawShiftTabInputTailRef.current = "";
        for (let index = 0; index < shiftTabs; index += 1) {
          cyclePermissionMode(stateRef.current, "raw-shift-tab");
        }
        return;
      }
      const clickEvent = mouseClickEvents(chunkText).find((event) => event.kind === "press");
      if (clickEvent) {
        claimedInkInputRef.current = true;
        const frame = frameForState(current);
        const target = resolveScrollTarget(clickEvent, frame, {
          activeOverlay: Boolean(activeOverlayKind(current)),
          defaultTarget: "transcript"
        });
        const subtarget = target === "transcript" ? transcriptSubtargetForMouse(clickEvent, current, frame) : target;
        debugTuiInput(props.env, `raw_mouse_click x=${clickEvent.x} y=${clickEvent.y} target=${target} subtarget=${subtarget} overlay=${activeOverlayKind(current) ?? "none"}`);
        if (current.startupConfirmed && current.trusted && target === "transcript" && subtarget === "transcript") {
          if (selectTranscriptEntryAtMouse(clickEvent, current)) {
            return;
          }
        }
        return;
      }
      const text = `${rawScrollInputTailRef.current}${chunkText}`;
      const { wheelEvents: events, pageDirections, remainder } = rawScrollEvents(text);
      rawScrollInputTailRef.current = remainder;
      if (events.length === 0 && pageDirections.length === 0) {
        return;
      }
      claimedInkInputRef.current = true;
      if (!isNativeScrollbackMode(stateRef.current)) {
        for (const event of events) {
          applyMouseWheelScroll(event, stateRef.current);
        }
      }
      for (const direction of pageDirections) {
        applyVisibleScroll(direction, stateRef.current, 10);
      }
    };
    inputEvents?.on?.("input", onRawInput);
    return () => {
      inputEvents?.off?.("input", onRawInput);
      inputEvents?.removeListener?.("input", onRawInput);
    };
  }, [applyMouseWheelScroll, applyRawDraftOperations, applyVisibleScroll, cyclePermissionMode, inputEvents, insertPastedText, markUserActivity, props.env, selectTranscriptEntryAtMouse]);

  const askApproval = useCallback((request) => {
    const approvalKey = approvalKeyFor(request);
    if (sessionApprovals.current.has(approvalKey)) {
      return true;
    }

    addEntry("approval", `${request.toolName} 审批`, [
      `risk=${request.definition.risk}`,
      `reason=${request.decision.reason ?? "需要审批"}`,
      request.decision.sensitive === true ? "sensitive=强确认；批准后相关内容可能进入模型上下文" : null,
      "boundary=本地客户端执行；没有远程工具服务器",
      `input=${summarizeInput(request.toolName, request.input)}`
    ].filter(Boolean).join("\n"));
    setActivity((current) => ({
      ...current,
      status: "等待审批",
      approvalCount: current.approvalCount + 1,
      lastTool: `${request.toolName} 等待中`
    }));
    pushInspector(makeInspector("审批请求", request.toolName, [
      `risk: ${request.definition.risk}`,
      `reason: ${request.decision.reason ?? "需要审批"}`,
      request.decision.sensitive === true ? "sensitive: 强确认；批准后相关内容可能进入模型上下文" : null,
      "boundary: 本地客户端执行；没有远程工具服务器",
      `input: ${summarizeInput(request.toolName, request.input)}`
    ].filter(Boolean).join("\n"), "approval"), { focus: true });
    setMode("approval");
    setApprovalChoiceIndex(0);
    return new Promise((resolve) => {
      setPendingApproval({ resolve, approvalKey, toolName: request.toolName, request });
    });
  }, [addEntry, pushInspector]);

  const askUser = useCallback((request) => {
    const prompt = normalizeQuestionPrompt(request);
    const body = [
      prompt.question,
      prompt.choices.length > 0 ? `选项：${prompt.choices.map((choice) => choice.label).join(" / ")}` : null,
      prompt.multiple ? "可多选；Space 勾选，Enter 确认。" : null
    ].filter(Boolean).join("\n");
    addEntry("question", prompt.header, body);
    pushInspector(makeInspector(prompt.header, "ask_user", body, "context"), { focus: true });
    setActivity((current) => ({
      ...current,
      status: "等待回答",
      questionCount: current.questionCount + 1
    }));
    replaceQuestionDraft("");
    setMode("question");
    return new Promise((resolve) => {
      setPendingQuestion({ ...prompt, resolve });
    });
  }, [addEntry, pushInspector, replaceQuestionDraft]);

  const interruptCurrentTurn = useCallback((stopReason) => {
    const controller = currentTurnAbortRef.current;
    if (controller && !controller.signal.aborted) {
      controller.abort();
    }
    setStream(initialStream({ phase: "interrupted", stopReason }));
  }, []);

  const interruptPendingGuideAtGatewayBoundary = useCallback(() => {
    const pending = pendingGuideInterruptRef.current;
    if (!pending) {
      return false;
    }
    pendingGuideInterruptRef.current = null;
    interruptCurrentTurn(pending.kind === "stop" ? "guide-stop" : "guided");
    if (pending.kind === "stop") {
      addEntry("guide", "已在模型响应后停止", [
        "当前模型响应已到达安全边界，正在本地中断当前轮次。",
        "不会生成新的引导提示，也不会继续原提示。"
      ].join("\n"));
      setActivity((current) => ({ ...current, status: "已停止当前轮次", lastTurn: "guide stop" }));
      return true;
    }
    addEntry("guide", "已在模型响应后引导", [
      "当前模型响应已到达安全边界，正在本地中断当前轮次。",
      "引导提示已在队首，下一条优先运行。",
      pending.guidance
    ].join("\n"));
    setActivity((current) => ({ ...current, status: "guide 已接管", lastTurn: "guide 已接管" }));
    return true;
  }, [addEntry, interruptCurrentTurn]);

  const guideActiveTurn = useCallback((guidance) => {
    const text = String(guidance ?? "").trim();
    if (!text) {
      addEntry("guide", "用法", "Ant Code 工作中可使用：/guide <message>");
      setActivity((current) => ({ ...current, status: "guide 需要文本" }));
      return;
    }

    if (!stateRef.current.busy) {
      addEntry("guide", "没有活动轮次", "当前没有可引导的模型/工具轮次。请直接发送普通提示。");
      setActivity((current) => ({ ...current, status: "没有活动轮次" }));
      return;
    }

    const deferUntilGatewayResponse = isModelResponseInFlight(stateRef.current.stream);
    if (isStopGuidance(text)) {
      if (deferUntilGatewayResponse) {
        pendingGuideInterruptRef.current = { kind: "stop" };
        addEntry("guide", "停止已登记", [
          "当前模型响应还在进行中。",
          "会等这次模型响应结束后，在工具执行或下一轮请求前中断。",
          "不会生成新的引导提示。"
        ].join("\n"));
        setActivity((current) => ({ ...current, status: "等待模型响应后停止", lastTurn: "guide stop pending" }));
        return;
      }
      pendingGuideInterruptRef.current = null;
      interruptCurrentTurn("guide-stop");
      addEntry("guide", "已停止当前轮次", [
        "正在本地中断当前轮次。",
        "不会生成新的引导提示，也不会继续原提示。"
      ].join("\n"));
      setActivity((current) => ({ ...current, status: "已停止当前轮次", lastTurn: "guide stop" }));
      return;
    }

    const guidedPrompt = buildGuidePrompt(text, currentTurnPromptRef.current);
    const nextPrompts = prependQueuedPrompt(queuedPromptsRef.current, guidedPrompt, 20);
    setQueueState(nextPrompts, 0);

    if (deferUntilGatewayResponse) {
      pendingGuideInterruptRef.current = { kind: "guide", guidance: text };
      addEntry("guide", "引导已登记", [
        "当前模型响应还在进行中。",
        "会等这次模型响应结束后，在工具执行或下一轮请求前中断。",
        "引导提示已插入队首，随后优先运行。",
        text
      ].join("\n"));
      setActivity((current) => ({ ...current, status: "等待模型响应后 guide", lastTurn: "guide pending" }));
      return;
    }
    pendingGuideInterruptRef.current = null;
    interruptCurrentTurn("guided");
    addEntry("guide", "引导当前轮次", [
      "正在本地中断当前轮次。",
      "引导提示已插入队首，下一条优先运行。",
      text
    ].join("\n"));
    setActivity((current) => ({ ...current, status: "guide 已排队", lastTurn: "guide 已排队" }));
  }, [addEntry, interruptCurrentTurn, setQueueState]);

  const startBackgroundSubagent = useCallback((profileName, query) => {
    const profile = String(profileName ?? "").trim();
    const text = String(query ?? "").trim();
    if (!profile || !text) {
      addEntry("agent", "后台任务用法", "/background run <profile> <任务>");
      setActivity((current) => ({ ...current, status: "后台任务需要 profile 和任务文本" }));
      return null;
    }

    const taskId = `bg-${crypto.randomUUID()}`;
    const childSessionId = `agent-${profile}-${crypto.randomUUID()}`;
    const controller = new AbortController();
    backgroundControllersRef.current.set(taskId, controller);
    setSideView("tasks");
    setSideOffset(0);
    addEntry("agent", "后台任务已启动", [
      `task=${taskId}`,
      `profile=${profile}`,
      text
    ].join("\n"));
    setActivity((current) => ({ ...current, status: `后台任务 ${profile} 运行中`, lastTool: "background run" }));

    void (async () => {
      let result = null;
      try {
        result = await runSubagent({
          cwd: props.cwd,
          config: sessionRef.current.config,
          env: props.env,
          readonly: sessionRef.current.readonly,
          allowWrite: sessionRef.current.allowWrite,
          allowCommand: sessionRef.current.allowCommand,
          fullAccess: sessionRef.current.fullAccess,
          workflowState: sessionRef.current.workflow,
          approvalCallback: askApproval,
          parentSessionId: sessionRef.current.id,
          hooksTrusted: trusted,
          profileName: profile,
          query: text,
          taskId,
          childSessionId,
          signal: controller.signal
        });
        const ok = result?.ok === true;
        const title = ok
          ? "后台任务完成"
          : result?.interrupted
            ? "后台任务已中断"
            : "后台任务失败";
        const body = [
          `task=${taskId}`,
          `profile=${result?.profile ?? profile}`,
          result?.outputSummary ?? result?.output ?? result?.error?.message ?? JSON.stringify(result, null, 2)
        ].filter(Boolean).join("\n");
        addEntry("agent", title, body);
        pushInspector(makeInspector(title, taskId, body, ok ? "context" : "tool"), { focus: !ok });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        addEntry("error", "后台任务异常", `${taskId}: ${message}`);
        pushInspector(makeInspector("后台任务异常", taskId, message, "tool"), { focus: true });
      } finally {
        backgroundControllersRef.current.delete(taskId);
        await loadTaskRecords();
        setSideView("tasks");
        setActivity((current) => ({
          ...current,
          status: result?.ok === true ? "后台任务完成" : result?.interrupted ? "后台任务已中断" : "后台任务已结束",
          lastTool: "background"
        }));
      }
    })();

    void loadTaskRecords();
    return taskId;
  }, [addEntry, askApproval, loadTaskRecords, props.cwd, props.env, pushInspector, setSideOffset, trusted]);

  const cancelBackgroundSubagent = useCallback(async (taskId) => {
    const id = String(taskId ?? "").trim();
    if (!id) {
      addEntry("agent", "后台取消用法", "/background cancel <task-id>");
      return;
    }
    const controller = backgroundControllersRef.current.get(id);
    if (controller && !controller.signal.aborted) {
      controller.abort();
    }
    const store = createAgentTaskStore({ cwd: props.cwd });
    const result = await store.updateTask(id, {
      status: "cancelled",
      cancelRequestedAt: new Date().toISOString(),
      latestProgress: controller
        ? "用户已从 TUI 请求取消；正在等待当前模型/工具边界停止。"
        : "用户已请求取消；未找到仍在当前 TUI 进程内运行的 controller。"
    });
    const body = result.ok
      ? `task=${id}\n${result.task.latestProgress}`
      : JSON.stringify(result, null, 2);
    addEntry("agent", controller ? "后台任务取消中" : "后台任务已标记取消", body);
    pushInspector(makeInspector("后台任务取消", id, body, "tool"), { focus: true });
    await loadTaskRecords();
    setSideView("tasks");
  }, [addEntry, loadTaskRecords, props.cwd, pushInspector]);

  const addAgentTaskStartEntry = useCallback((event) => {
    const taskId = String(event.taskId ?? "").trim();
    if (!taskId) {
      return;
    }
    const profile = String(event.profile ?? "unknown");
    const entryId = agentTaskEntriesRef.current.get(taskId) ?? `agent-${taskId}`;
    agentTaskEntriesRef.current.set(taskId, entryId);
    const body = [
      `task=${taskId}`,
      `profile=${profile}`,
      "状态=运行中（双击查看完整输出）",
      "右侧任务栏会实时显示当前工具、预算进度和最近步骤。",
      `详情：/agents task ${taskId}`
    ].join("\n");
    if (stateRef.current.entries?.some((entry) => entry.id === entryId)) {
      updateEntryById(entryId, { kind: "agent", title: "子任务已启动", body, taskId, profile, taskStatus: "running" });
    } else {
      addEntry("agent", "子任务已启动", body, { id: entryId, taskId, profile, taskStatus: "running" });
    }
    setSideView("tasks");
    setSideOffset(0);
    setActivity((current) => ({ ...current, status: `子任务 ${profile} 运行中`, lastTool: "agent_run" }));
    void loadTaskRecords();
  }, [addEntry, loadTaskRecords, setSideOffset, updateEntryById]);

  const finishAgentTaskEntry = useCallback((event) => {
    const taskId = String(event.taskId ?? "").trim();
    if (!taskId) {
      return;
    }
    const profile = String(event.profile ?? "unknown");
    const status = event.taskStatus ?? (event.ok ? "completed" : event.blocked ? "blocked" : "failed");
    const entryId = agentTaskEntriesRef.current.get(taskId) ?? `agent-${taskId}`;
    agentTaskEntriesRef.current.set(taskId, entryId);
    const title = agentTaskTitle(status);
    const summary = String(event.outputSummary ?? "").trim();
    const body = [
      `task=${taskId}`,
      `profile=${profile}`,
      `状态=${agentTaskStatusLabel(status)}（双击查看完整输出）`,
      summary ? `摘要=${truncatePlainText(summary, 900)}` : null,
      status === "partial" ? `续跑：/agents continue ${taskId}` : null,
      `详情：/agents task ${taskId}`
    ].filter(Boolean).join("\n");
    if (stateRef.current.entries?.some((entry) => entry.id === entryId)) {
      updateEntryById(entryId, { kind: "agent", title, body, taskId, profile, taskStatus: status });
    } else {
      addEntry("agent", title, body, { id: entryId, taskId, profile, taskStatus: status });
    }
    setSideView("tasks");
    void loadTaskRecords();
    setActivity((current) => ({ ...current, status: title, lastTool: `agent_run ${status}` }));
  }, [addEntry, loadTaskRecords, updateEntryById]);

  const syncAgentTaskEntryFromRecord = useCallback((task, options = {}) => {
    const id = String(task?.id ?? "").trim();
    if (!id) {
      return;
    }
    const status = task.status ?? options.status ?? "unknown";
    const profile = task.profile ?? options.profile ?? "unknown";
    const entryId = agentTaskEntriesRef.current.get(id) ?? `agent-${id}`;
    agentTaskEntriesRef.current.set(id, entryId);
    const title = agentTaskTitle(status);
    const summary = String(task.outputSummary || task.latestProgress || "").trim();
    const body = [
      `task=${id}`,
      task.groupId ? `group=${task.groupId}` : null,
      `profile=${profile}`,
      `状态=${agentTaskStatusLabel(status)}（双击查看完整输出）`,
      summary ? `摘要=${truncatePlainText(summary, 900)}` : null,
      status === "running" || status === "queued" ? "右侧任务栏会实时显示当前工具、预算进度和最近步骤。" : null,
      status === "partial" ? `续跑：/agents continue ${id}` : null,
      `详情：/agents task ${id}`
    ].filter(Boolean).join("\n");
    const existing = stateRef.current.entries?.find((entry) => entry.id === entryId);
    const patch = { kind: "agent", title, body, taskId: id, profile, taskStatus: status };
    if (existing) {
      if (existing.title !== title || existing.body !== body || existing.taskStatus !== status || existing.profile !== profile) {
        updateEntryById(entryId, patch);
      }
      return;
    }
    if (options.allowCreate !== false) {
      addEntry("agent", title, body, { id: entryId, taskId: id, profile, taskStatus: status });
    }
  }, [addEntry, updateEntryById]);

  const refreshAgentTaskEntryFromRecord = useCallback(async (taskId, fallback = {}) => {
    const id = String(taskId ?? "").trim();
    if (!id) {
      return;
    }
    const store = createAgentTaskStore({ cwd: props.cwd });
    const result = await store.readTask(id);
    if (!result.ok) {
      return;
    }
    syncAgentTaskEntryFromRecord(result.task, {
      allowCreate: true,
      status: fallback.status,
      profile: fallback.profile
    });
  }, [props.cwd, syncAgentTaskEntryFromRecord]);

  useEffect(() => {
    if (!startupConfirmed || !trusted) {
      return;
    }
    for (const task of taskRecords) {
      const status = String(task?.status ?? "");
      syncAgentTaskEntryFromRecord(task, {
        allowCreate: status === "queued" || status === "running"
      });
    }
  }, [startupConfirmed, syncAgentTaskEntryFromRecord, taskRecords, trusted]);

  const handleBackgroundWakeup = useCallback((event) => {
    const wakePrompt = String(event.wakePrompt ?? "").trim();
    if (!wakePrompt) {
      return;
    }
    const groupId = String(event.groupId ?? "unknown");
    const body = [
      `group=${groupId}`,
      event.summary ? `摘要=${truncatePlainText(String(event.summary), 500)}` : null,
      "后台子任务组已完成，主控将自动继续处理。"
    ].filter(Boolean).join("\n");
    addEntry("agent", "子任务组完成", body);
    pushInspector(makeInspector("子任务组完成", groupId, body, "context"), { focus: false });
    setSideView("tasks");
    void loadTaskRecords();
    if (stateRef.current.busy) {
      const nextPrompts = prependQueuedPrompt(queuedPromptsRef.current, wakePrompt, 20);
      setQueueState(nextPrompts, 0);
      addEntry("queue", "主控续跑已排队", `group=${groupId}`);
      setActivity((current) => ({ ...current, status: "主控续跑已排队", lastTool: "subagent wakeup" }));
      return;
    }
    addEntry("queue", "主控自动续跑", `group=${groupId}`);
    setActivity((current) => ({ ...current, status: "子任务完成，主控继续处理", lastTool: "subagent wakeup" }));
    void runPromptDirectRef.current?.(wakePrompt);
  }, [addEntry, loadTaskRecords, pushInspector, setQueueState]);

  const onSessionEvent = useCallback((event) => {
    lastActivityAtRef.current = Date.now();
    if (event.type !== "assistant_thinking_delta" && event.type !== "assistant_delta") {
      setActivity((current) => updateActivity(current, event));
    }
    if (event.type === "turn_start") {
      setTranscriptOffset(0);
      setStreamOffset(0);
      setStream(initialStream({ active: true, thinkingVisible: stateRef.current.thinkingVisible }));
      addEntry("turn", `turn ${event.turnIndex}`, `promptBytes=${event.promptBytes}`);
    } else if (event.type === "gateway_request_start") {
      flushStreamDeltasNow();
      setStream((current) => ({
        ...current,
        active: true,
        round: event.round,
        phase: "requesting"
      }));
      sessionRef.current.lastPromptEstimate = {
        bytes: event.promptBytesEstimate,
        tokens: event.promptTokensEstimate,
        messageTokens: event.promptMessageTokensEstimate,
        toolSchemaTokens: event.promptToolSchemaTokensEstimate,
        toolResultTokens: event.promptToolResultTokensEstimate,
        round: event.round,
        source: "local-estimate"
      };
      addEntry("gateway", `gateway round ${event.round}`, `messages=${event.messageCount}, toolResults=${event.toolResultCount}, inputTokens≈${event.promptTokensEstimate ?? "?"}`);
    } else if (event.type === "gateway_stream_start") {
      setStream((current) => ({
        ...current,
        active: true,
        round: event.round,
        phase: "streaming",
        messageId: event.messageId ?? current.messageId,
        model: event.model ?? current.model
      }));
    } else if (event.type === "assistant_thinking_delta") {
      streamDeltaBufferRef.current = appendStreamDelta(streamDeltaBufferRef.current, event);
      scheduleStreamFlush();
    } else if (event.type === "assistant_delta") {
      streamDeltaBufferRef.current = appendStreamDelta(streamDeltaBufferRef.current, event);
      scheduleStreamFlush();
    } else if (event.type === "tool_call_delta") {
      flushStreamDeltasNow();
      setStream((current) => appendToolCallDraft(current, event));
    } else if (event.type === "gateway_stream_stop") {
      flushStreamDeltasNow();
      setStream((current) => ({
        ...current,
        phase: "finalizing",
        stopReason: event.stopReason ?? current.stopReason
      }));
    } else if (event.type === "gateway_retry") {
      const code = event.error?.code ?? "GATEWAY_FETCH_ERROR";
      const cause = event.error?.details?.cause?.code ? `, cause=${event.error.details.cause.code}` : "";
      const stage = event.stage ? `, stage=${event.stage}` : "";
      const body = `attempt=${event.attempt}/${event.maxAttempts}${stage}, retry in ${event.delayMs ?? "?"}ms${cause}`;
      addEntry("gateway", `网关重试 ${code}`, body);
      pushInspector(makeInspector("网关重试", code, body, "gateway"), { focus: false });
    } else if (event.type === "gateway_response") {
      const usage = formatGatewayUsageBrief(event.usage);
      addEntry("gateway", `gateway response ${event.round}`, `textBytes=${event.textBytes}, toolCalls=${event.toolCallCount}, stop=${event.stopReason ?? "none"}${usage ? `, provider=${usage}` : ""}`);
      interruptPendingGuideAtGatewayBoundary();
    } else if (event.type === "tool_calls_requested") {
      const names = event.toolCalls.map((call) => `${call.name}(${call.inputKeys.join(",") || "no input"})`).join("\n");
      addEntry("tools", "requested", names || "no tools");
    } else if (event.type === "tool_start") {
      flushStreamDeltasNow();
      setStream((current) => updateRuntimeTool(current, event, "running"));
      if (event.name === "agent_run") {
        addAgentTaskStartEntry(event);
      } else {
        addEntry("tool", event.name, `running id=${event.toolCallId}, inputKeys=${event.inputKeys.join(",") || "none"}`);
      }
    } else if (event.type === "tool_finish") {
      flushStreamDeltasNow();
      setStream((current) => updateRuntimeTool(current, event, event.interrupted ? "interrupted" : event.ok ? "done" : event.blocked ? "blocked" : "failed"));
      const state = event.interrupted ? "interrupted" : event.ok ? "done" : event.blocked ? "blocked" : "failed";
      const body = [
        `id=${event.toolCallId}`,
        `bytes=${event.resultBytes}`,
        event.interrupted ? "interrupted=true" : null,
        event.decision ? `decision=${event.decision}` : null,
        event.errorCode ? `error=${event.errorCode}` : null,
        event.truncated ? "truncated=true" : null
      ].filter(Boolean).join(", ");
      if (event.name === "agent_run") {
        finishAgentTaskEntry(event);
      } else {
        addEntry("tool", `${event.name} ${state}`, body);
      }
      pushInspector(makeInspector(`Tool ${state}`, event.name, body, "tool"), {
        focus: event.blocked || !event.ok
      });
      if (event.ok && (event.name === "todo_write" || event.name === "plan_update")) {
        setSideView("workflow");
        setSideOffset(0);
        setActivity((current) => ({
          ...current,
          status: event.name === "todo_write" ? "待办已更新" : "计划已更新",
          lastTool: event.name
        }));
      }
      if (event.name === "agent_run") {
        void loadTaskRecords();
        setSideView("tasks");
      }
    } else if (event.type === "subagent_group_started") {
      const body = [
        `group=${event.groupId}`,
        `task=${event.taskId}`,
        `profile=${event.profile}`,
        `waitFor=${event.waitFor}`,
        event.wakeParent ? "后台运行中；完成后自动唤醒主控" : "后台运行中；完成后仅记录结果"
      ].filter(Boolean).join("\n");
      addEntry("agent", "子任务组后台运行中", body);
      setSideView("tasks");
      void loadTaskRecords();
    } else if (event.type === "subagent_group_progress") {
      setActivity((current) => ({ ...current, status: `子任务组 ${event.status ?? "running"}`, lastTool: "subagent group" }));
      if (event.taskId) {
        void refreshAgentTaskEntryFromRecord(event.taskId, event);
      }
      void loadTaskRecords();
    } else if (event.type === "subagent_group_wakeup") {
      handleBackgroundWakeup(event);
    } else if (event.type === "workflow_updated") {
      setSideView("workflow");
      setSideOffset(0);
      const summary = [
        event.todosCompleted ? `待办完成 ${event.todosCompleted}` : null,
        event.planStepsCompleted ? `计划完成 ${event.planStepsCompleted}` : null
      ].filter(Boolean).join("，") || "状态已同步";
      addEntry("workflow", "状态同步", summary);
      setActivity((current) => ({
        ...current,
        status: "待办已同步",
        lastTool: "workflow sync"
      }));
    } else if (event.type === "assistant_final") {
      const currentStream = flushStreamDeltasNow();
      const thinkingPreview = limitThinkingPreview(String(currentStream.thinking ?? ""));
      const thinking = thinkingPreview.text;
      addEntry("assistant", "assistant", event.text, thinking
        ? {
          thinking,
          thinkingBytes: currentStream.thinkingBytes ?? Buffer.byteLength(thinking, "utf8"),
          thinkingTruncated: currentStream.thinkingTruncated === true || thinkingPreview.truncated,
          thinkingVisible: false
        }
        : undefined);
      if (transcriptScrollOffsetRef.current === 0) {
        setTranscriptOffset(0);
      }
      setStreamOffset(0);
      setStream(initialStream());
    } else if (event.type === "turn_interrupted") {
      flushStreamDeltasNow();
      const draftText = String(event.draftText ?? "");
      const draftThinkingPreview = limitThinkingPreview(String(event.draftThinking ?? ""));
      const draftThinking = draftThinkingPreview.text;
      if (draftText.trim()) {
        addEntry("assistant", "中断草稿", draftText, draftThinking
          ? {
            thinking: draftThinking,
            thinkingBytes: event.draftThinkingBytes ?? Buffer.byteLength(draftThinking, "utf8"),
            thinkingTruncated: draftThinkingPreview.truncated,
            thinkingVisible: false
          }
          : undefined);
      }
      setStream(initialStream({ phase: "interrupted", stopReason: event.reason ?? "user" }));
      addEntry("turn", "已中断", draftText.trim()
        ? "轮次已中断，已保留上方中断草稿，可直接继续纠偏。"
        : "轮次已在本地中断。尚未收到可保存的助手草稿。");
    } else if (event.type === "gateway_error") {
      flushStreamDeltasNow();
      setStream((current) => ({ ...current, active: true, phase: "failed" }));
      const body = event.error?.message ?? "请求失败";
      addEntry("error", "网关错误", `${event.error?.code ?? "GATEWAY_ERROR"}: ${body}`);
      pushInspector(makeInspector("网关错误", event.error?.code ?? "GATEWAY_ERROR", body, "gateway"), { focus: true });
    } else if (event.type === "gateway_not_configured") {
      const body = "设置 LAB_MODEL_GATEWAY_URL 后才能启用模型轮次。";
      addEntry("gateway", "未配置", body);
      pushInspector(makeInspector("网关", "未配置", body, "gateway"), { focus: true });
    } else if (event.type === "context_compacted") {
      const strategy = event.strategy === "agent:compaction" ? "内部压缩 agent" : event.strategy === "model" ? "模型摘要" : event.strategy === "local" ? "本地摘要" : "未知方式";
      addEntry("context", "compacted", `${event.beforeMessages} -> ${event.afterMessages}; summary bytes=${event.summaryBytes}; ${strategy}${event.fallbackReason ? `; fallback=${event.fallbackReason}` : ""}`);
    } else if (event.type === "review_gate") {
      const body = [
        `level=${event.level ?? "remind"}`,
        ...(Array.isArray(event.reasons) ? event.reasons.map((reason) => `- ${reason}`) : [])
      ].join("\n");
      addEntry("agent", "复核提醒", body);
      pushInspector(makeInspector("复核提醒", "review.gate", event.text ?? body, "tool"), { focus: false });
    } else if (event.type === "tool_limit") {
      flushStreamDeltasNow();
      setStreamOffset(0);
      setStream(initialStream());
      const body = `在最终助手响应前已达到工具轮次上限（${event.maxToolRounds ?? "未知"} 轮）。待执行工具数：${event.toolCallCount ?? 0}。`;
      addEntry("error", "工具轮次上限", body);
      pushInspector(makeInspector("工具轮次上限", "session", body, "tool"), { focus: true });
    } else if (event.type === "turn_complete") {
      flushStreamDeltasNow();
      if (event.status !== "completed") {
        setStreamOffset(0);
        setStream(initialStream());
        addEntry("turn", event.status, `outputBytes=${event.outputBytes}`);
      }
    }
  }, [addAgentTaskStartEntry, addEntry, finishAgentTaskEntry, flushStreamDeltasNow, handleBackgroundWakeup, loadTaskRecords, pushInspector, refreshAgentTaskEntryFromRecord, scheduleStreamFlush, setStreamOffset, setTranscriptOffset]);

  const onAntEvent = useCallback((event) => {
    activityEventCountRef.current += 1;
    if (HIGH_FREQUENCY_ANT_EVENTS.has(event?.type)) {
      return;
    }
    setAntState((current) => reduceAntEvent(current, event));
    const eventCount = activityEventCountRef.current;
    setActivity((current) => ({
      ...current,
      eventCount
    }));
  }, []);

  const handlePrompt = useCallback(async (prompt, signal = undefined) => {
    if (prompt.trimStart().startsWith("!")) {
      const shellText = prompt.trimStart().slice(1).trim();
      if (!shellText) {
        addEntry("output", "! shell", "用法：!<本地命令>");
        return;
      }
      const shellCommand = parseSlashCommand(`/run ${shellText}`);
      addEntry("command", "! shell", shellText);
      const outputText = await runSlashCommand({
        command: shellCommand,
        cwd: props.cwd,
        env: props.env,
        readonly: sessionRef.current.readonly,
        allowWrite: sessionRef.current.allowWrite,
        allowCommand: sessionRef.current.allowCommand,
        fullAccess: sessionRef.current.fullAccess,
        workflowState: sessionRef.current.workflow,
        sessionInfo: summarizeInfo(),
        approvalCallback: askApproval,
        trusted
      });
      addEntry("output", "! 结果", outputText);
      pushInspector(makeInspector("Shell 输出", "!", outputText, inspectorCategoryForCommand("verify", outputText)), { focus: true });
      return;
    }

    const slashCommand = parseSlashCommand(prompt);
    if (slashCommand) {
      addEntry("command", `/${slashCommand.name}`, slashCommand.raw);
      const lowerName = slashCommand.name.toLowerCase();
      if (lowerName === "help" && slashCommand.args.length === 0) {
        openCommandPanel(createHelpPanel());
        pushInspector(makeInspector("帮助", "/help", "已打开命令帮助面板。", "context"), { focus: false });
        return;
      }
      if (lowerName === "logs") {
        const requestedFilter = String(slashCommand.args[0] ?? "all").toLowerCase();
        const filter = INSPECTOR_FILTERS.includes(requestedFilter) ? requestedFilter : "all";
        setInspectorFilter(filter);
        setInspectorOffset(0);
        openLogsPanel({
          filter,
          offset: 0
        });
        return;
      }
      if (lowerName === "model" && slashCommand.args.length === 0) {
        const currentIndex = modelOptions.findIndex((model) => model.id === sessionRef.current.model);
        setModelPickerIndex(Math.max(0, currentIndex));
        setCommandPanel(null);
        setCommandPanelOffset(0);
        setModelPickerOpen(true);
        pushInspector(makeInspector("模型选择器", "/model", modelOptions.map((model) => `${model.id}${model.id === sessionRef.current.model ? " *" : ""}`).join("\n"), "context"), { focus: false });
        return;
      }
      if (lowerName === "status" && slashCommand.args.length === 0) {
        openCommandPanel(createStatusPanel({
          session: sessionRef.current,
          activity,
          trusted,
          cwd: props.cwd
        }));
        pushInspector(makeInspector("状态", "/status", "已打开状态面板。", "context"), { focus: false });
        return;
      }
      if (lowerName === "permissions" && slashCommand.args.length === 0) {
        openCommandPanel(createPermissionsPanel({
          session: sessionRef.current,
          trusted
        }));
        pushInspector(makeInspector("权限", "/permissions", "已打开权限面板。", "approval"), { focus: false });
        return;
      }
      if (lowerName === "context" && slashCommand.args.length === 0) {
        openCommandPanel(createContextPanel({ session: sessionRef.current }));
        pushInspector(makeInspector("上下文", "/context", "已打开上下文面板。", "context"), { focus: false });
        return;
      }
      if ((lowerName === "usage" || lowerName === "cost") && slashCommand.args.length === 0) {
        openCommandPanel(createUsagePanel({
          session: sessionRef.current,
          name: lowerName
        }));
        pushInspector(makeInspector(lowerName === "cost" ? "费用" : "用量", `/${lowerName}`, "已打开用量面板。", "context"), { focus: false });
        return;
      }
      if (lowerName === "thinking") {
        const requested = String(slashCommand.args[0] ?? "").toLowerCase();
        const next = requested === "on" || requested === "show" || requested === "open" || requested === "展开"
          ? true
          : requested === "off" || requested === "hide" || requested === "close" || requested === "隐藏"
            ? false
            : !stateRef.current.thinkingVisible;
        setThinkingVisible(next);
        setStream((current) => ({ ...current, thinkingVisible: next, thinkingRedacted: !next }));
        addEntry("view", "thinking 显示", next
          ? "已展开 thinking/reasoning 预览。超长内容会截断前部并保留最新片段。"
          : "已隐藏 thinking/reasoning 预览。后续只显示字节数。");
        pushInspector(makeInspector("thinking", "/thinking", next
          ? "thinking 预览显示已开启；只影响当前会话可见内容。"
          : "thinking 预览显示已关闭。", "context"), { focus: false });
        return;
      }
      if (lowerName === "queue" && slashCommand.args.length === 0) {
        openQueuePanel(stateRef.current.queuePanelIndex);
        pushInspector(makeInspector("队列", "/queue", `${queuedPromptsRef.current.length} 条排队提示。`, "context"), { focus: false });
        return;
      }
      if (lowerName === "guide") {
        guideActiveTurn(slashCommand.args.join(" "));
        return;
      }
      if (lowerName === "background" && slashCommand.args[0] === "run") {
        startBackgroundSubagent(slashCommand.args[1], slashCommand.args.slice(2).join(" "));
        return;
      }
      if (lowerName === "background" && slashCommand.args[0] === "cancel") {
        await cancelBackgroundSubagent(slashCommand.args[1]);
        return;
      }
      if (lowerName === "new" && slashCommand.args.length === 0) {
        await replaceSession();
        return;
      }
      if (lowerName === "sessions" && slashCommand.args.length === 0) {
        await openSessionsPanel();
        return;
      }
      if (lowerName === "resume" && slashCommand.args.length === 0) {
        openResumePanel();
        return;
      }
      if (lowerName === "resume" && slashCommand.args[0]) {
        await openResumeChunkPanel(slashCommand.args[0]);
        return;
      }
      if (lowerName === "rewind") {
        const git = await readGitStatusSummary(props.cwd, props.env);
        openCommandPanel(createUndoRedoPanel({
          session: sessionRef.current,
          gitAvailable: git.gitAvailable,
          gitStatus: git.gitStatus
        }));
        pushInspector(makeInspector("撤销 / 回退", "/rewind", "已打开 git 感知的撤销可行性说明。", "context"), { focus: false });
        return;
      }
      if (lowerName === "clear") {
        if (slashCommand.args.includes("--yes") || slashCommand.args.includes("now")) {
          clearContextNow();
          return;
        }
        openCommandPanel(createClearConfirmPanel({ session: sessionRef.current }));
        pushInspector(makeInspector("上下文", "/clear", "已打开清除上下文确认。", "context"), { focus: false });
        return;
      }
      if (lowerName === "compact") {
        const before = summarizeContextWindow(sessionRef.current);
        setActivity((value) => ({ ...value, status: "压缩上下文", lastTool: "compact 请求模型摘要" }));
        const result = await compactSessionContextWithModel(sessionRef.current, {
          force: true,
          reason: "manual",
          gateway: createLabModelGateway(sessionRef.current.config),
          env: props.env,
          hooksTrusted: trusted
        });
        const after = summarizeContextWindow(sessionRef.current);
        const strategy = result.strategy === "agent:compaction"
          ? "内部压缩 agent"
          : result.strategy === "model"
            ? "模型摘要"
            : result.strategy === "local"
              ? "本地摘要"
              : "未压缩";
        const outputText = result.compacted
          ? `上下文已压缩（${strategy}）：${result.beforeMessages} -> ${result.afterMessages}；摘要字节=${result.summaryBytes}${result.fallbackReason ? `；降级原因=${result.fallbackReason}` : ""}`
          : `上下文未压缩：${result.reason}`;
        addEntry("context", "compact", outputText);
        openCommandPanel(createCompactPanel({
          result,
          before,
          after,
          session: sessionRef.current
        }));
        pushInspector(makeInspector("上下文", "/compact", outputText, "context"), { focus: true });
        setActivity((value) => ({ ...value, status: result.compacted ? `上下文已压缩（${strategy}）` : "上下文未压缩", lastTool: "compact" }));
        return;
      }

      const outputText = await runSlashCommand({
        command: slashCommand,
        cwd: props.cwd,
        env: props.env,
        readonly: sessionRef.current.readonly,
        allowWrite: sessionRef.current.allowWrite,
        allowCommand: sessionRef.current.allowCommand,
        fullAccess: sessionRef.current.fullAccess,
        workflowState: sessionRef.current.workflow,
        sessionInfo: summarizeInfo(),
        approvalCallback: askApproval,
        setModelCallback: switchModel,
        trusted
      });
      addEntry("output", `/${slashCommand.name} 结果`, outputText);
      if (lowerName === "agents" || lowerName === "tasks") {
        void loadTaskRecords();
        if (lowerName === "tasks" || slashCommand.args[0] === "tasks") {
          setSideView("tasks");
        }
      }
      if (lowerName === "gateway") {
        openCommandPanel(createTextOutputPanel({
          title: "网关",
          command: slashCommand.raw,
          output: outputText,
          kind: "gateway"
        }));
      }
      if (INSPECTOR_OUTPUT_COMMANDS.has(lowerName)) {
        pushInspector(makeInspector("命令输出", `/${slashCommand.name}`, outputText, inspectorCategoryForCommand(lowerName, outputText)), { focus: true });
      }
      return;
    }

    addEntry("user", "你", prompt, {
      checkpointMessagesLength: sessionRef.current.messages.length,
      turnIndex: sessionRef.current.turnCount + 1
    });
    await runSessionTurn(sessionRef.current, {
      prompt,
      env: props.env,
      signal,
      approvalCallback: askApproval,
      userInputCallback: askUser,
      onEvent: onSessionEvent,
      onAntEvent,
      hooksTrusted: trusted
    });
  }, [activity, addEntry, askApproval, askUser, cancelBackgroundSubagent, clearContextNow, guideActiveTurn, loadTaskRecords, modelOptions, onAntEvent, onSessionEvent, openCommandPanel, openLogsPanel, openQueuePanel, openResumeChunkPanel, openResumePanel, openSessionsPanel, props.cwd, props.env, pushInspector, replaceSession, startBackgroundSubagent, summarizeInfo, switchModel, trusted]);

  const confirmTrust = useCallback(async () => {
    if (trustStatus === "saving") {
      return;
    }
    setTrustStatus("saving");
    try {
      await trustWorkspace({
        cwd: props.cwd,
        env: props.env,
        version: await getAntCodeVersion()
      });
      setTrusted(true);
      setTrustStatus("trusted");
      addEntry("system", "工作区已信任", props.cwd);
    } catch (error) {
      setTrustStatus("error");
      addEntry("error", "信任保存失败", error instanceof Error ? error.message : String(error));
    }
  }, [addEntry, props.cwd, props.env, trustStatus]);

  const queuePrompt = useCallback((prompt) => {
    const nextPrompts = [...queuedPromptsRef.current, prompt].slice(-20);
    setQueueState(nextPrompts, nextPrompts.length - 1);
    addEntry("queue", "提示已排队", prompt);
  }, [addEntry, setQueueState]);

  const runPromptDirect = useCallback(async function runPromptDirect(prompt) {
    setBusy(true);
    const controller = new AbortController();
    currentTurnAbortRef.current = controller;
    currentTurnPromptRef.current = String(prompt ?? "");
    try {
      await handlePrompt(prompt, controller.signal);
    } catch (error) {
      addEntry("error", "运行时错误", error instanceof Error ? error.message : String(error));
    } finally {
      if (currentTurnAbortRef.current === controller) {
        currentTurnAbortRef.current = null;
        currentTurnPromptRef.current = "";
        pendingGuideInterruptRef.current = null;
      }
      const [nextPrompt, ...rest] = queuedPromptsRef.current;
      setQueueState(rest, 0);
      if (nextPrompt) {
        addEntry("queue", "正在运行排队提示", nextPrompt);
        void runPromptDirect(nextPrompt);
      } else {
        setBusy(false);
      }
    }
  }, [addEntry, handlePrompt, setQueueState]);

  useEffect(() => {
    runPromptDirectRef.current = runPromptDirect;
  }, [runPromptDirect]);

  const runningBackgroundCount = useCallback(() => (
    listBackgroundAgentTasks({ parentSessionId: sessionRef.current.id }).filter((task) => task.aborted !== true).length
    + backgroundControllersRef.current.size
  ), []);

  useEffect(() => {
    if (idleSilent || !startupConfirmed || !trusted) {
      return undefined;
    }
    const timeoutMs = resolveIdleSilentAfterMs(props.env);
    if (timeoutMs <= 0) {
      return undefined;
    }
    const intervalMs = Math.min(60_000, Math.max(5_000, Math.floor(timeoutMs / 6)));
    const timer = setInterval(() => {
      const current = stateRef.current;
      if (!shouldEnterIdleSilent(current, {
        now: Date.now(),
        lastActivityAt: lastActivityAtRef.current,
        timeoutMs,
        runningBackgroundCount: runningBackgroundCount()
      })) {
        return;
      }
      idleSilentRef.current = true;
      setIdleSilent(true);
      setActivity((value) => ({ ...value, status: "静默待机", lastTurn: "idle watchdog" }));
    }, intervalMs);
    return () => clearInterval(timer);
  }, [idleSilent, props.env, runningBackgroundCount, startupConfirmed, trusted]);

  const setBackgroundExitPendingValue = useCallback((value) => {
    backgroundExitPendingRef.current = Boolean(value);
    setBackgroundExitPending(Boolean(value));
  }, []);

  const requestBackgroundExit = useCallback(async () => {
    const tasks = cancelBackgroundAgentTasks({ parentSessionId: sessionRef.current.id });
    for (const controller of backgroundControllersRef.current.values()) {
      if (!controller.signal.aborted) {
        controller.abort();
      }
    }
    setBackgroundExitPendingValue(true);
    setExitConfirmUntilValue(0);
    const count = tasks.length + backgroundControllersRef.current.size;
    addEntry("system", "后台任务退出中", `已请求停止 ${count} 个后台子任务。任务未及时结束时，再次退出可强制关闭 TUI。`);
    setActivity((value) => ({ ...value, status: "后台任务退出中", lastTool: "background cancel" }));
    await loadTaskRecords();
  }, [addEntry, loadTaskRecords, setBackgroundExitPendingValue, setExitConfirmUntilValue]);

  const forceExitTui = useCallback((reason) => {
    const current = stateRef.current;
    current.pendingApproval?.resolve(false);
    current.pendingQuestion?.resolve({ answer: "", selectedChoice: null });
    interruptCurrentTurn(reason);
    for (const controller of backgroundControllersRef.current.values()) {
      if (!controller.signal.aborted) {
        controller.abort();
      }
    }
    props.onForceExit?.(130);
    exit();
  }, [exit, interruptCurrentTurn, props.onForceExit]);

  const requestExit = useCallback(() => {
    const backgroundCount = runningBackgroundCount();
    const action = resolveTuiExitAction({
      confirmed: true,
      backgroundExitPending: backgroundExitPendingRef.current,
      backgroundCount
    });
    if (action === "force") {
      forceExitTui("forced-background-exit");
      return;
    }
    if (action === "cancel-background") {
      void requestBackgroundExit();
      return;
    }
    stateRef.current.pendingApproval?.resolve(false);
    stateRef.current.pendingQuestion?.resolve({ answer: "", selectedChoice: null });
    interruptCurrentTurn("exit");
    exit();
  }, [exit, forceExitTui, interruptCurrentTurn, requestBackgroundExit, runningBackgroundCount]);

  const submitInput = useCallback(async (overridePrompt = null) => {
    const prompt = sanitizeComposerText(overridePrompt ?? stateRef.current.inputBuffer).trim();
    replaceInputDraft("");
    setSlashPaletteDismissed(false);
    setFileMentionDismissed(false);
    setHistoryIndex(null);
    clearTransientEntrySelection();
    if (!prompt) {
      return;
    }
    if (prompt === "/exit" || prompt === "/quit") {
      requestExit();
      return;
    }
    const slashCommand = parseSlashCommand(prompt);
    const historyPrompt = slashCommand?.name?.toLowerCase() === "thinking"
      ? `/thinking${slashCommand.args[0] ? ` ${slashCommand.args[0]}` : ""}`
      : prompt;

    setHistory((current) => [...current.slice(-99), historyPrompt]);
    if (stateRef.current.busy && isImmediateTuiCommand(prompt)) {
      await handlePrompt(prompt);
      return;
    }
    if (stateRef.current.busy) {
      queuePrompt(prompt);
      return;
    }
    await runPromptDirect(prompt);
  }, [clearTransientEntrySelection, handlePrompt, queuePrompt, replaceInputDraft, requestExit, runPromptDirect]);

  const closeTopPopover = useCallback((current, reason = "closed") => {
    const popover = topPopover(current);
    if (!popover) {
      return false;
    }
    if (popover.kind === "approval") {
      const pending = current.pendingApproval;
      setPendingApproval(null);
      setMode("input");
      setApprovalChoiceIndex(0);
      addEntry("approval", `${pending?.toolName ?? "tool"} 已取消`, reason);
      setActivity((value) => ({ ...value, status: "审批已取消", lastTool: `${pending?.toolName ?? "tool"} 已取消` }));
      pending?.resolve?.(false);
      return true;
    }
    if (popover.kind === "question") {
      const pending = current.pendingQuestion;
      setPendingQuestion(null);
      replaceQuestionDraft("");
      setMode("input");
      addEntry("question", "已取消", reason);
      setActivity((value) => ({ ...value, status: "问题已取消" }));
      pending?.resolve?.({ answer: "", selectedChoice: null });
      return true;
    }
    if (popover.kind === "model") {
      setModelPickerOpen(false);
      return true;
    }
    if (popover.kind === "command") {
      const wasMessageExcerpt = current.commandPanel?.kind === "message-excerpt";
      setCommandPanel(null);
      setCommandPanelOffset(0);
      if (wasMessageExcerpt) {
        enableTerminalMouse(stdout, { env: props.env, forceConsoleMode: true, reason: "close-message-excerpt" });
        setTimeout(() => {
          if (commandPanelKindRef.current !== "message-excerpt") {
            enableTerminalMouse(stdout, { env: props.env, forceConsoleMode: true, reason: "close-message-excerpt-refresh" });
          }
        }, 80);
        setActivity((value) => ({ ...value, status: "已返回正常鼠标滚动模式" }));
      }
      setSelectedEntryId(null);
      setSelectedEntryHighlightUntil(0);
      setMessageActionIndex(0);
      lastTranscriptClickRef.current = { entryId: null, at: 0 };
      return true;
    }
    if (popover.kind === "file") {
      setFileMentionDismissed(true);
      return true;
    }
    if (popover.kind === "slash") {
      setSlashPaletteDismissed(true);
      return true;
    }
    return false;
  }, [addEntry, replaceQuestionDraft, stdout]);

  const requestTurnInterrupt = useCallback((reason) => {
    setInterruptConfirmUntilValue(0);
    interruptCurrentTurn(reason);
    setActivity((value) => ({ ...value, status: "正在中断", lastTurn: "已请求中断" }));
    addEntry("turn", "已请求中断", "已请求本地中止当前轮次。Esc 需要二次确认；Ctrl+G 会直接中断。");
  }, [addEntry, interruptCurrentTurn, setInterruptConfirmUntilValue]);

  useEffect(() => {
    if (!backgroundExitPending) {
      return undefined;
    }
    const poll = createCoalescedAsyncRunner(async () => {
      const count = runningBackgroundCount();
      await loadTaskRecords();
      if (count > 0) {
        setActivity((value) => ({ ...value, status: `后台任务退出中：${count} 个仍在停止` }));
        return;
      }
      clearInterval(timer);
      setBackgroundExitPendingValue(false);
      addEntry("system", "后台任务已停止", "后台任务已停止，可以再次退出。");
      setActivity((value) => ({ ...value, status: "后台任务已停止，可以退出" }));
    });
    const timer = setInterval(() => {
      void poll.run().catch(() => {});
    }, 500);
    return () => {
      clearInterval(timer);
      poll.dispose();
    };
  }, [addEntry, backgroundExitPending, loadTaskRecords, runningBackgroundCount, setBackgroundExitPendingValue]);

  const handleEscInterrupt = useCallback(() => {
    const now = Date.now();
    const result = resolveEscInterrupt({
      confirmationUntil: interruptConfirmUntilRef.current,
      now
    });
    if (result.confirmed) {
      setInterruptConfirmUntilValue(0);
      requestTurnInterrupt("escape");
      return;
    }
    setInterruptConfirmUntilValue(result.nextConfirmationUntil);
    setActivity((value) => ({ ...value, status: "再次按 Esc 中断" }));
    addEntry("turn", "中断确认", result.message);
  }, [addEntry, requestTurnInterrupt, setInterruptConfirmUntilValue]);

  const handleCtrlCExit = useCallback((current) => {
    const now = Date.now();
    if (now - lastCtrlCHandledAtRef.current < 40) {
      return;
    }
    lastCtrlCHandledAtRef.current = now;
    const result = resolveCtrlCExit({
      confirmationUntil: exitConfirmUntilRef.current,
      now
    });
    const backgroundCount = runningBackgroundCount();
    const action = resolveTuiExitAction({
      confirmed: result.confirmed,
      backgroundExitPending: backgroundExitPendingRef.current,
      backgroundCount
    });
    if (action === "force") {
      setExitConfirmUntilValue(0);
      forceExitTui("ctrl-c-force-exit");
      return;
    }
    if (action === "cancel-background") {
      void requestBackgroundExit();
      return;
    }
    if (action === "exit") {
      setExitConfirmUntilValue(0);
      current.pendingApproval?.resolve(false);
      current.pendingQuestion?.resolve({ answer: "", selectedChoice: null });
      interruptCurrentTurn("ctrl-c-exit");
      exit();
      return;
    }
    setExitConfirmUntilValue(result.nextConfirmationUntil);
    setInterruptConfirmUntilValue(0);
    const forcePending = backgroundExitPendingRef.current;
    setActivity((value) => ({
      ...value,
      status: forcePending
        ? "再次按 Ctrl+C 强制退出"
        : backgroundCount > 0 ? "再次按 Ctrl+C 停止后台任务并退出" : "再次按 Ctrl+C 退出"
    }));
    addEntry("system", "退出确认", forcePending
      ? `${result.message}。后台任务未确认停止；确认后将强制关闭 TUI。`
      : backgroundCount > 0
        ? `${result.message}。仍有 ${backgroundCount} 个后台子任务运行；确认退出会先停止所有任务。`
      : result.message);
  }, [addEntry, exit, forceExitTui, interruptCurrentTurn, requestBackgroundExit, runningBackgroundCount, setExitConfirmUntilValue, setInterruptConfirmUntilValue]);

  const toggleTranscriptDetail = useCallback(() => {
    const current = stateRef.current;
    if (!current.startupConfirmed || !current.trusted) {
      return false;
    }
    clearTerminalForFullRedraw(stdout);
    setTranscriptOffset(0);
    setStreamOffset(0);
    setDetailMode((value) => {
      const next = nextDetailMode(value);
      addEntry("view", "详情模式", `会话详情现在是${detailModeLabel(next)}。`);
      setActivity((currentActivity) => ({ ...currentActivity, status: `detail ${detailModeLabel(next)}` }));
      return next;
    });
    return true;
  }, [addEntry, setStreamOffset, setTranscriptOffset, stdout]);

  useEffect(() => {
    const onSigint = () => {
      handleCtrlCExit(stateRef.current);
    };
    process.on("SIGINT", onSigint);
    return () => {
      process.off?.("SIGINT", onSigint);
      process.removeListener?.("SIGINT", onSigint);
    };
  }, [handleCtrlCExit]);

  useInput((inputValue, key) => {
    const current = stateRef.current;
    if (claimedInkInputRef.current) {
      claimedInkInputRef.current = false;
      return;
    }
    if (isInkKeyRelease(key)) {
      return;
    }
    markUserActivity("key");
    if (!current.startupConfirmed) {
      if (isCtrlKey(inputValue, key, "c")) {
        handleCtrlCExit(current);
        return;
      }
      if (key.escape) {
        exit();
        return;
      }
      if (key.return) {
        setStartupConfirmed(true);
      }
      return;
    }
    if (!current.trusted) {
      if (isCtrlKey(inputValue, key, "c")) {
        handleCtrlCExit(current);
        return;
      }
      if (key.escape) {
        exit();
        return;
      }
      if (key.return) {
        void confirmTrust();
      }
      return;
    }
    if (hasMouseSequence(inputValue)) {
      return;
    }
    if (isCtrlKey(inputValue, key, "c")) {
      handleCtrlCExit(current);
      return;
    }
    if (key.escape || isCtrlKey(inputValue, key, "g")) {
      if (closeTopPopover(current, key.escape ? "Closed with Esc." : "Closed with Ctrl+G.")) {
        return;
      }
      if (current.busy) {
        if (key.escape) {
          handleEscInterrupt();
        } else {
          requestTurnInterrupt("ctrl-g");
        }
        return;
      }
      if (isCtrlKey(inputValue, key, "g")) {
        return;
      }
    }
    setExitConfirmUntilValue(0);
    setInterruptConfirmUntilValue(0);
    if (isCtrlKey(inputValue, key, "o")) {
      toggleTranscriptDetail();
      return;
    }
    if (current.commandPanel) {
      const panelKind = current.commandPanel.kind;
      const lowerInput = String(inputValue ?? "").toLowerCase();
      if (panelKind === "queue") {
        if (key.upArrow) {
          setQueuePanelIndex((value) => boundedIndex(current.queuedPrompts, value - 1));
          return;
        }
        if (key.downArrow) {
          setQueuePanelIndex((value) => boundedIndex(current.queuedPrompts, value + 1));
          return;
        }
        if (key.return) {
          if (current.busy) {
            const result = promoteQueuedPrompt(queuedPromptsRef.current, current.queuePanelIndex);
            setQueueState(result.prompts, result.index);
            if (result.promoted) {
              addEntry("queue", "提示已提升", result.promoted);
            }
            return;
          }
          const result = takeQueuedPrompt(queuedPromptsRef.current, current.queuePanelIndex);
          setQueueState(result.prompts, result.index);
          if (result.prompt) {
            setCommandPanel(null);
            setCommandPanelOffset(0);
            addEntry("queue", "正在运行选中提示", result.prompt);
            void runPromptDirect(result.prompt);
          }
          return;
        }
        if (key.delete || lowerInput === "d") {
          const result = removeQueuedPrompt(queuedPromptsRef.current, current.queuePanelIndex);
          setQueueState(result.prompts, result.index);
          if (result.removed) {
            addEntry("queue", "提示已删除", result.removed);
          }
          return;
        }
        if (lowerInput === "p") {
          const result = promoteQueuedPrompt(queuedPromptsRef.current, current.queuePanelIndex);
          setQueueState(result.prompts, result.index);
          if (result.promoted) {
            addEntry("queue", "提示已提升", result.promoted);
          }
          return;
        }
        if (lowerInput === "c") {
          setQueueState([], 0);
          addEntry("queue", "队列已清空", "所有排队提示都已删除。");
          return;
        }
        return;
      }
      if (panelKind === "message-actions") {
        const entry = current.entries.find((item) => item.id === current.selectedEntryId);
        const actions = messageActionsForEntry(entry);
        if (key.upArrow) {
          setMessageActionIndex((value) => boundedIndex(actions, value - 1));
          return;
        }
        if (key.downArrow) {
          setMessageActionIndex((value) => boundedIndex(actions, value + 1));
          return;
        }
        if (key.return) {
          runMessageAction(entry, current.messageActionIndex);
          return;
        }
        const digit = Number.parseInt(String(inputValue ?? ""), 10);
        if (Number.isInteger(digit) && digit >= 1 && digit <= actions.length) {
          runMessageAction(entry, digit - 1);
          return;
        }
        return;
      }
      if (panelKind === "message-excerpt") {
        const entry = current.entries.find((item) => item.id === current.selectedEntryId);
        if (lowerInput === "c") {
          runMessageAction(entry, 0);
          return;
        }
        if (lowerInput === "f") {
          runMessageAction(entry, 1);
          return;
        }
        if (lowerInput === "r") {
          const actions = messageActionsForEntry(entry);
          runMessageAction(entry, actions.indexOf("rewind-edit"));
          return;
        }
        if (lowerInput === "g") {
          const actions = messageActionsForEntry(entry);
          runMessageAction(entry, actions.indexOf("regenerate"));
          return;
        }
      }
      if (panelKind === "agent-live") {
        const entry = current.entries.find((item) => item.id === current.selectedEntryId);
        if (key.return || lowerInput === "c" || lowerInput === "e") {
          void freezeAgentTaskExcerpt(entry);
          return;
        }
      }
      if (panelKind === "sessions") {
        if (key.upArrow) {
          setSessionPickerIndex((value) => boundedIndex(current.sessionRecords, value - 1));
          return;
        }
        if (key.downArrow) {
          setSessionPickerIndex((value) => boundedIndex(current.sessionRecords, value + 1));
          return;
        }
        if (key.return) {
          const selected = current.sessionRecords[current.sessionPickerIndex];
          if (selected) {
            void replaceSession({ resume: selected.id });
          }
          return;
        }
        if (lowerInput === "n") {
          void replaceSession();
          return;
        }
        if (lowerInput === "c") {
          void (async () => {
            const store = createSessionStore({
              cwd: props.cwd,
              transcript: sessionRef.current.config.transcript,
              env: props.env
            });
            const result = await store.cleanupExpiredSessions(sessionRef.current.config.transcript?.retentionDays ?? 30);
            addEntry("session", "metadata 清理", `已删除 ${result.deleted.length} 条过期记录。`);
            await loadSessionRecords();
          })();
          return;
        }
        return;
      }
      if (panelKind === "resume") {
        const chunks = sessionRef.current.transcriptArchive?.chunks ?? [];
        if (key.upArrow) {
          setCommandPanel((panel) => createResumePanel({
            session: sessionRef.current,
            selectedIndex: Math.max(0, (panel?.selectedIndex ?? 0) - 1)
          }));
          return;
        }
        if (key.downArrow) {
          setCommandPanel((panel) => createResumePanel({
            session: sessionRef.current,
            selectedIndex: Math.min(Math.max(0, chunks.length - 1), (panel?.selectedIndex ?? 0) + 1)
          }));
          return;
        }
        if (key.return) {
          const selected = chunks[current.commandPanel.selectedIndex ?? 0];
          if (selected) {
            void openResumeChunkPanel(selected.index);
          }
          return;
        }
        return;
      }
      if (panelKind === "clear-confirm") {
        if (key.return) {
          clearContextNow();
        }
        return;
      }
      if ((key.leftArrow || key.rightArrow || key.tab) && current.commandPanel.tabs?.length > 0) {
        const direction = key.leftArrow ? -1 : 1;
        const tabCount = current.commandPanel.tabs.length;
        const nextTabIndex = (current.commandPanel.tabIndex + tabCount + direction) % tabCount;
        if (current.commandPanel.kind === "logs") {
          switchLogsPanelFilter(INSPECTOR_FILTERS[nextTabIndex] ?? "all");
          return;
        }
        setCommandPanel(current.commandPanel.kind === "help"
          ? createHelpPanel({ tabIndex: nextTabIndex })
          : { ...current.commandPanel, tabIndex: nextTabIndex });
        setCommandPanelOffset(0);
        return;
      }
      if (key.upArrow) {
        setCommandPanelOffset((value) => Math.max(0, value - 1));
        return;
      }
      if (key.downArrow) {
        setCommandPanelOffset((value) => Math.min(maxCommandPanelOffset(current.commandPanel, current.terminalSize, current), value + 1));
        return;
      }
      if (key.pageUp) {
        setCommandPanelOffset((value) => Math.max(0, value - 8));
        return;
      }
      if (key.pageDown) {
        setCommandPanelOffset((value) => Math.min(maxCommandPanelOffset(current.commandPanel, current.terminalSize, current), value + 8));
        return;
      }
      if (isCtrlKey(inputValue, key, "f")) {
        setCommandPanelOffset((value) => Math.min(maxCommandPanelOffset(current.commandPanel, current.terminalSize, current), value + 8));
        return;
      }
      if (isCtrlKey(inputValue, key, "b")) {
        setCommandPanelOffset((value) => Math.max(0, value - 8));
        return;
      }
      return;
    }
    if (isCtrlKey(inputValue, key, "l")) {
      setEntries([]);
      setTranscriptOffset(0);
      setStreamOffset(0);
      return;
    }
    const canScrollConversation = current.mode === "input"
      && !current.modelPickerOpen
      && !current.fileMention
      && !current.slashPalette;
    if (canScrollConversation && key.pageUp) {
      applyVisibleScroll(1, current, 10);
      return;
    }
    if (canScrollConversation && key.pageDown) {
      applyVisibleScroll(-1, current, 10);
      return;
    }
    if (canScrollConversation && !key.ctrl && (key.upArrow || key.downArrow) && current.inputBuffer) {
      updateInputDraft((draft) => moveCursorVertical(draft, key.upArrow ? "up" : "down", {
        columns: composerContentColumns(current)
      }));
      return;
    }
    if (canScrollConversation && !key.ctrl && key.upArrow) {
      applyVisibleScroll(1, current, 4);
      return;
    }
    if (canScrollConversation && !key.ctrl && key.downArrow) {
      applyVisibleScroll(-1, current, 4);
      return;
    }
    if (canScrollConversation && !current.inputBuffer && current.historyIndex === null && (key.leftArrow || key.rightArrow)) {
      const direction = key.rightArrow ? 1 : -1;
      if (current.sideView === "workflow") {
        const next = nextFilter(current.workflowFilter, WORKFLOW_FILTERS, direction);
        setWorkflowFilter(next);
        setSideOffset(0);
        setActivity((value) => ({ ...value, status: `任务分类：${WORKFLOW_FILTER_LABELS[next] ?? next}` }));
        return;
      }
      if (current.sideView === "tasks") {
        const next = nextFilter(current.taskFilter, TASK_FILTERS, direction);
        setTaskFilter(next);
        setSideOffset(0);
        setActivity((value) => ({ ...value, status: `子智能体分类：${TASK_FILTER_LABELS[next] ?? next}` }));
        return;
      }
      const next = nextSideView(current.sideView, direction);
      setSideView(next);
      setSidePanelOffset(0);
      setActivity((value) => ({ ...value, status: `侧栏：${next}` }));
      return;
    }
    if (isCtrlKey(inputValue, key, "a") && current.inputBuffer) {
      updateInputDraft((draft) => moveCursor(draft, "start"));
      return;
    }
    if (isCtrlKey(inputValue, key, "e") && current.inputBuffer) {
      updateInputDraft((draft) => moveCursor(draft, "end"));
      return;
    }
    if (isCtrlKey(inputValue, key, "k") && current.inputBuffer) {
      updateInputDraft(deleteToEnd);
      return;
    }
    if (isCtrlKey(inputValue, key, "w") && current.inputBuffer) {
      updateInputDraft(deleteWordBackward);
      setSlashPaletteDismissed(false);
      setFileMentionDismissed(false);
      setHistoryIndex(null);
      return;
    }
    if (isCtrlKey(inputValue, key, "u")) {
      updateInputDraft(deleteToStart);
      replaceQuestionDraft("");
      setHistoryIndex(null);
      return;
    }
    if (key.shift && key.tab) {
      cyclePermissionMode(current, "ink-shift-tab");
      return;
    }
    if (key.tab) {
      setSideView((value) => {
        const next = nextSideView(value);
        setActivity((currentActivity) => ({ ...currentActivity, status: `panel ${next}` }));
        return next;
      });
      setSidePanelOffset(0);
      return;
    }
    if (current.mode === "approval") {
      handleApprovalInput(inputValue, key, current, sessionApprovals.current, addEntry, setActivity, setMode, setPendingApproval, setApprovalChoiceIndex);
      return;
    }
    if (current.mode === "question") {
      handleQuestionInput(inputValue, key, current, {
        addEntry,
        setActivity,
        setMode,
        setPendingQuestion,
        replaceQuestionDraft,
        updateQuestionDraft
      });
      return;
    }
    if (current.modelPickerOpen) {
      if (key.escape) {
        setModelPickerOpen(false);
        return;
      }
      if (key.upArrow) {
        setModelPickerIndex((value) => movePaletteIndex(current.modelOptions, value, -1));
        return;
      }
      if (key.downArrow) {
        setModelPickerIndex((value) => movePaletteIndex(current.modelOptions, value, 1));
        return;
      }
      if (key.return) {
        const selected = current.modelOptions[current.modelPickerIndex];
        if (selected) {
          switchModel(selected);
        }
        setModelPickerOpen(false);
        return;
      }
      return;
    }
    const trailingSubmitText = splitTrailingSubmitInput(inputValue, key);
    if (trailingSubmitText !== null) {
      const next = updateInputDraft((draft) => insertText(draft, trailingSubmitText));
      setSlashPaletteDismissed(false);
      setFileMentionDismissed(false);
      setHistoryIndex(null);
      void submitInput(next.text);
      return;
    }
    if (isCtrlKey(inputValue, key, "j")) {
      updateInputDraft((draft) => insertText(draft, "\n"));
      setSlashPaletteDismissed(false);
      setFileMentionDismissed(false);
      setHistoryIndex(null);
      return;
    }
    if (looksLikePastedText(inputValue) && insertPastedText(inputValue, current)) {
      return;
    }
    if (key.return && (key.shift || key.meta)) {
      updateInputDraft((draft) => insertText(draft, "\n"));
      setSlashPaletteDismissed(false);
      setFileMentionDismissed(false);
      setHistoryIndex(null);
      return;
    }
    if (current.fileMention) {
      if (key.escape) {
        setFileMentionDismissed(true);
        return;
      }
      if (key.upArrow) {
        setFileMentionIndex((value) => movePaletteIndex(current.fileMentionCandidates, value, -1));
        return;
      }
      if (key.downArrow) {
        setFileMentionIndex((value) => movePaletteIndex(current.fileMentionCandidates, value, 1));
        return;
      }
      if (key.return) {
        const selected = current.fileMentionCandidates[current.fileMentionIndex];
        if (selected) {
          const nextText = insertFileMention(current.inputBuffer, current.fileMention, selected.path);
          replaceInputDraft(nextText);
          setRecentFiles((items) => rememberRecentFile(items, selected.path));
          setFileMentionDismissed(false);
          setFileMentionIndex(0);
          return;
        }
      }
    }
    if (current.slashPalette) {
      if (key.escape) {
        setSlashPaletteDismissed(true);
        return;
      }
      if (key.upArrow) {
        setSlashPaletteIndex((value) => movePaletteIndex(current.slashPalette.commands, value, -1));
        return;
      }
      if (key.downArrow) {
        setSlashPaletteIndex((value) => movePaletteIndex(current.slashPalette.commands, value, 1));
        return;
      }
      if (key.return) {
        const commandText = current.inputBuffer.trim();
        const selected = current.slashPalette.commands[current.slashPaletteIndex];
        if (selected && !commandText.slice(1).includes(" ")) {
          void submitInput(`/${selected.name}`);
          return;
        }
      }
    }
    if (key.return) {
      void submitInput();
      return;
    }
    if (key.home) {
      updateInputDraft((draft) => moveCursorLineBoundary(draft, "start", { columns: composerContentColumns(current) }));
      return;
    }
    if (key.end) {
      updateInputDraft((draft) => moveCursorLineBoundary(draft, "end", { columns: composerContentColumns(current) }));
      return;
    }
    if (key.leftArrow) {
      updateInputDraft((draft) => moveCursor(draft, key.meta ? "word-left" : "left"));
      return;
    }
    if (key.rightArrow) {
      updateInputDraft((draft) => moveCursor(draft, key.meta ? "word-right" : "right"));
      return;
    }
    if (key.backspace) {
      updateInputDraft(deleteBackward);
      setSlashPaletteDismissed(false);
      setFileMentionDismissed(false);
      setHistoryIndex(null);
      return;
    }
    if (key.delete) {
      updateInputDraft(deleteForward);
      setSlashPaletteDismissed(false);
      setFileMentionDismissed(false);
      setHistoryIndex(null);
      return;
    }
    if (key.escape) {
      if (current.inputBuffer) {
        replaceInputDraft("");
        setSlashPaletteDismissed(false);
        setFileMentionDismissed(false);
      }
      return;
    }
    if (key.ctrl && key.upArrow) {
      recallHistory(-1, current.history, current.historyIndex, setHistoryIndex, replaceInputDraft);
      setSlashPaletteDismissed(false);
      setFileMentionDismissed(false);
      return;
    }
    if (key.ctrl && key.downArrow) {
      recallHistory(1, current.history, current.historyIndex, setHistoryIndex, replaceInputDraft);
      setSlashPaletteDismissed(false);
      setFileMentionDismissed(false);
      return;
    }
    const inputText = sanitizeComposerText(inputValue);
    if (!key.ctrl && !key.meta && inputText) {
      updateInputDraft((draft) => insertText(draft, inputText));
      setSlashPaletteDismissed(false);
      setFileMentionDismissed(false);
      setHistoryIndex(null);
    }
  });

  const width = terminalSize.columns;
  const height = terminalSize.rows;
  const wide = width >= 108;
  const exitConfirmActive = exitConfirmUntil >= Date.now();
  const interruptConfirmActive = interruptConfirmUntil >= Date.now();
  const sidePanelWidth = wide ? Math.min(38, Math.max(32, Math.floor(width * 0.32))) : 0;
  const mainWidth = wide ? Math.max(50, width - sidePanelWidth - 1) : width;
  const activePanel = commandPanel
    ? "command"
    : modelPickerOpen
      ? "model"
      : fileMention
        ? "file"
        : slashPalette
          ? "slash"
          : pendingApproval
            ? "approval"
            : null;
  const layout = resolveTuiLayoutRows({
    width,
    height,
    mode,
    busy,
    inputBuffer,
    inputCursor,
    inputVisibleStart: inputDraftRef.current.visibleStart ?? 0,
    questionBuffer,
    questionCursor,
    questionVisibleStart: questionDraftRef.current.visibleStart ?? 0,
    pendingQuestion,
    queuedPrompts,
    pendingApproval,
    exitConfirmActive,
    interruptConfirmActive,
    activePanel,
    commandPanel,
    slashPalette,
    fileMention,
    modelCount: modelOptions.length
  });
  const frame = resolveTuiFrame({ width, height, wide, rows: layout });
  const panelBounds = frame.regions.panel ?? frame.regions.overlay;
  const bodyRows = layout.bodyRows;
  const panelRows = layout.panelRows;
  const panelWidth = panelBounds?.width ?? width;
    const visibleSelectedEntryId = selectedEntryHighlightUntil > Date.now() || commandPanel?.kind === "message-actions" || commandPanel?.kind === "message-excerpt" || commandPanel?.kind === "agent-live"
    ? selectedEntryId
    : null;
  const scrollbackMode = shouldUseScrollbackMode(height, {
    pinnedSidePanel: wide,
    streamActive: Boolean(stream?.active)
  });
  const splashRows = Math.max(8, height - 1 - layout.noticeRows);
  const activePanelElement = activePanel && panelRows > 0
    ? activePanel === "slash"
      ? h(SlashPalette, { palette: slashPalette, index: slashPaletteIndex, width: panelWidth, height: panelRows, visibleRows: panelRows, theme })
      : activePanel === "file"
        ? h(FileMentionPalette, { state: fileMention, candidates: fileMentionCandidates, index: fileMentionIndex, width: panelWidth, height: panelRows, visibleRows: panelRows, theme })
        : activePanel === "model"
          ? h(ModelPicker, { models: modelOptions, currentModel: activeModel, index: modelPickerIndex, width: panelWidth, height: panelRows, visibleRows: panelRows, theme })
          : activePanel === "command"
            ? h(CommandPanel, { panel: commandPanel, offset: commandPanelOffset, visibleRows: layout.commandPanelVisibleRows, width: panelWidth, height: panelRows, theme })
            : activePanel === "approval"
              ? h(PermissionModal, { pendingApproval, focusedIndex: approvalChoiceIndex, width: panelWidth, height: panelRows, theme })
              : null
    : null;

  if (!startupConfirmed) {
    return h(Box, { flexDirection: "column", width, minHeight: splashRows, paddingX: 1 },
      h(StatusBar, { session: sessionRef.current, cwd: props.cwd, activity, pulse, detailMode, antState, width, theme }),
      h(StartupSplash, { session: sessionRef.current, theme }),
      h(StartupConfirmDialog, { cwd: props.cwd, trusted, workspaceDiagnostic: props.session.workspaceDiagnostic, theme }),
      h(ExitConfirmNotice, { active: exitConfirmActive, busy, theme }),
      h(InterruptConfirmNotice, { active: interruptConfirmActive, theme }),
      h(FooterBar, { sideView, wide, detailMode, thinkingVisible })
    );
  }

  if (!trusted) {
    return h(Box, { flexDirection: "column", width, minHeight: splashRows, paddingX: 1 },
      h(StatusBar, { session: sessionRef.current, cwd: props.cwd, activity, pulse, detailMode, antState, width, theme }),
      h(StartupSplash, { session: sessionRef.current, theme }),
      h(TrustDialog, { cwd: props.cwd, status: trustStatus, theme }),
      h(ExitConfirmNotice, { active: exitConfirmActive, busy, theme }),
      h(InterruptConfirmNotice, { active: interruptConfirmActive, theme }),
      h(FooterBar, { sideView, wide, detailMode, thinkingVisible })
    );
  }

  if (commandPanel?.kind === "message-excerpt") {
    const excerptRows = Math.max(4, height - 2);
    const excerptVisibleRows = Math.max(1, excerptRows - 1);
    return h(Box, { flexDirection: "column", width, height, minHeight: Math.max(8, height) },
      h(CommandPanel, {
        panel: commandPanel,
        offset: commandPanelOffset,
        visibleRows: excerptVisibleRows,
        width,
        height: excerptRows,
        theme
      })
    );
  }

  return h(Box, { flexDirection: "column", width, height, minHeight: Math.max(8, height) },
    h(StatusBar, { session: sessionRef.current, cwd: props.cwd, activity, pulse, detailMode, antState, width, theme }),
    h(Box, { flexDirection: wide ? "row" : "column", height: bodyRows, minHeight: bodyRows, flexShrink: 0 },
      h(LogPane, {
        entries,
        width: mainWidth,
        height: bodyRows,
        stream,
        pulse,
        detailMode,
        thinkingVisible,
        scrollOffset: transcriptScrollOffset,
        streamScrollOffset,
        scrollbackMode,
        selectedEntryId: visibleSelectedEntryId,
        theme
      }),
      wide ? h(SidePanel, {
        view: sideView,
        session: sessionRef.current,
        activity,
        sidePanelOffset,
        taskRecords,
        taskGroupRecords,
        workflowFilter,
        taskFilter,
        visibleRows: Math.max(6, bodyRows - 3),
        width: sidePanelWidth,
        height: bodyRows,
        theme
      }) : h(CompactSideSummary, { session: sessionRef.current, activity })
    ),
    activePanelElement,
    h(ExitConfirmNotice, { active: exitConfirmActive, busy, theme }),
    h(InterruptConfirmNotice, { active: interruptConfirmActive, theme }),
    h(QueuedPromptLine, { queuedPrompts, theme }),
    h(PromptBox, {
      mode,
      busy,
      inputBuffer,
      inputCursor,
      inputVisibleStart: inputDraftRef.current.visibleStart ?? 0,
      questionBuffer,
      questionCursor,
      questionVisibleStart: questionDraftRef.current.visibleStart ?? 0,
      queuedPrompts,
      pendingApproval,
      pendingQuestion,
      pulse,
      width,
      height: layout.promptRows,
      theme
    }),
    h(PermissionFooter, { session: sessionRef.current, width, theme }),
    h(FooterBar, { sideView, wide, detailMode, thinkingVisible })
  );
}

/**
 * @param {Awaited<ReturnType<typeof createSession>>} session
 */
function summarizeSessionInfo(session) {
  return {
    id: session.id,
    turnCount: session.turnCount,
    model: session.model,
    permissionMode: session.permissionMode,
    fullAccess: session.fullAccess,
    readonly: session.readonly,
    permissionReadonlyLocked: session.permissionReadonlyLocked,
    allowWrite: session.allowWrite,
    allowCommand: session.allowCommand,
    networkMode: session.networkMode,
    sensitivity: session.sensitivity,
    cwd: session.cwd,
    usage: session.usage ?? {},
    lastProviderUsage: session.lastProviderUsage ?? null,
    context: summarizeContextWindow(session)
  };
}

/**
 * @param {Awaited<ReturnType<typeof createSession>>} session
 */
function initialEntries(session) {
  const entries = [withEntryIdentity(startupEntry(session))];
  if (!session.config.lab.gatewayUrl) {
    entries.push(withEntryIdentity({
      kind: "gateway",
      title: "未配置",
      body: "模型轮次前请先设置 LAB_MODEL_GATEWAY_URL。",
      at: new Date().toLocaleTimeString()
    }));
  }
  if (session.resumedFrom) {
    entries.push(withEntryIdentity({
      kind: "session",
      title: "已恢复 metadata",
      body: formatResumedMetadataBody(session.resumedFrom),
      at: new Date().toLocaleTimeString()
    }));
    entries.push(...entriesFromMessages(session.transcriptMessages ?? session.messages));
  }
  return entries;
}

function formatResumedMetadataBody(resumedFrom) {
  const lines = [
    `id: ${resumedFrom.id}`,
    `metadata: ${resumedFrom.metadataPath}`,
    `轮次：${resumedFrom.turnCount ?? 0}`,
    `状态：${resumedFrom.status ?? "metadata"}`
  ];
  if (resumedFrom.title) {
    lines.push(`标题：${resumedFrom.title}`);
  }
  if (resumedFrom.model) {
    lines.push(`模型：${resumedFrom.model}`);
  }
  if (resumedFrom.finishedAt) {
    lines.push(`完成：${resumedFrom.finishedAt}`);
  }
  if (resumedFrom.prompt) {
    lines.push(`最近提示：${resumedFrom.prompt}`);
  }
  const transcriptMessages = resumedFrom.transcriptMessages?.length ?? resumedFrom.messages?.length ?? 0;
  const contextMessages = resumedFrom.messages?.length ?? 0;
  lines.push(`TUI 可见恢复：${transcriptMessages} 条`);
  if (contextMessages > transcriptMessages) {
    lines.push(`模型上下文恢复：${contextMessages} 条；较早对话已进入模型上下文，TUI 仅显示最近窗口。`);
  } else if (transcriptMessages !== contextMessages) {
    lines.push(`模型上下文恢复：${contextMessages} 条；较早对话仅用于本地回看。`);
  }
  return lines.join("\n");
}

function entriesFromMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return [];
  }
  const entries = [];
  for (const [messageIndex, message] of messages.entries()) {
    if (message?.role === "user") {
      entries.push(withEntryIdentity({
        kind: "user",
        title: "restored",
        body: messageText(message.content),
        at: "restored",
        checkpointMessagesLength: messageIndex,
        turnIndex: Math.floor(messageIndex / 2) + 1
      }));
    } else if (message?.role === "assistant") {
      const thinking = messageThinking(message);
      entries.push(withEntryIdentity({
        kind: "assistant",
        title: "restored",
        body: messageText(message.content),
        at: "restored",
        ...(thinking ? {
          thinking: thinking.text,
          thinkingBytes: thinking.bytes,
          thinkingTruncated: thinking.truncated,
          thinkingVisible: false
        } : {})
      }));
    }
  }
  return entries;
}

function messageThinking(message) {
  const thinking = message?.thinking;
  if (!thinking || typeof thinking !== "object") {
    return null;
  }
  const text = String(thinking.text ?? "");
  const bytes = Number.isFinite(thinking.bytes)
    ? thinking.bytes
    : Buffer.byteLength(text, "utf8");
  return text || bytes > 0 ? { text, bytes, truncated: thinking.truncated === true } : null;
}

function messageText(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content.map((item) => {
    if (typeof item === "string") {
      return item;
    }
    if (item && typeof item === "object" && "text" in item) {
      return String(item.text ?? "");
    }
    return "";
  }).filter(Boolean).join("\n");
}

function withEntryIdentity(entry, metadata = undefined) {
  if (!entry || typeof entry !== "object") {
    return entry;
  }
  return {
    id: entry.id ?? `entry-${crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`,
    ...entry,
    ...(metadata && typeof metadata === "object" ? metadata : {})
  };
}

async function hydrateTaskOutput(task, cwd) {
  if (!task?.metadata?.outputPath) {
    return task;
  }
  const store = createAgentTaskStore({ cwd });
  const result = await store.readTaskOutput(task);
  if (!result.ok) {
    return task;
  }
  return {
    ...task,
    output: result.output,
    metadata: {
      ...(task.metadata ?? {}),
      outputHydrated: true
    }
  };
}

function initialStream(overrides = {}) {
  return {
    active: false,
    phase: "idle",
    round: null,
    messageId: null,
    model: null,
    thinking: "",
    thinkingBytes: 0,
    thinkingTruncated: false,
    thinkingVisible: false,
    thinkingRedacted: false,
    text: "",
    tools: [],
    stopReason: null,
    ...overrides
  };
}

export function createStreamDeltaBuffer() {
  return { text: "", textBytes: 0, thinking: "", thinkingBytes: 0, thinkingTruncated: false, round: null };
}

export function appendStreamDelta(buffer = createStreamDeltaBuffer(), event = {}) {
  const next = {
    text: String(buffer.text ?? ""),
    textBytes: Number(buffer.textBytes) || 0,
    thinking: String(buffer.thinking ?? ""),
    thinkingBytes: Number(buffer.thinkingBytes) || 0,
    thinkingTruncated: buffer.thinkingTruncated === true,
    round: buffer.round ?? null
  };
  if (event.type === "assistant_delta") {
    const text = String(event.text ?? "");
    next.text += text;
    next.textBytes += event.bytes ?? Buffer.byteLength(text, "utf8");
    next.round = event.round ?? next.round;
  } else if (event.type === "assistant_thinking_delta") {
    const text = String(event.text ?? "");
    next.thinking += text;
    next.thinkingBytes += event.bytes ?? Buffer.byteLength(text, "utf8");
    next.thinkingTruncated ||= event.truncated === true;
    next.round = event.round ?? next.round;
  }
  return next;
}

export function applyStreamDeltaBuffer(current = initialStream(), buffer = createStreamDeltaBuffer(), options = {}) {
  let next = {
    ...current,
    active: true,
    round: buffer.round ?? current.round
  };
  if (buffer.thinking) {
    const preview = appendThinkingPreview(next.thinking ?? "", buffer.thinking);
    const answerStarted = next.phase === "answering" || String(next.text ?? "").length > 0;
    next = {
      ...next,
      phase: answerStarted ? "answering" : "thinking",
      thinking: preview.text,
      thinkingBytes: next.thinkingBytes + (Number(buffer.thinkingBytes) || 0),
      thinkingVisible: options.thinkingVisible === true,
      thinkingRedacted: options.thinkingVisible !== true,
      thinkingTruncated: Boolean(next.thinkingTruncated || buffer.thinkingTruncated || preview.truncated)
    };
  }
  if (buffer.text) {
    next = {
      ...next,
      phase: "answering",
      text: `${next.text}${buffer.text}`
    };
  }
  return next;
}

export function resolveStreamDeltaActivityStatus(currentStatus, stream = {}, buffer = createStreamDeltaBuffer()) {
  if (buffer.text) {
    return "生成回答";
  }
  if (!buffer.thinking) {
    return currentStatus;
  }
  if (stream.phase === "answering" || String(stream.text ?? "").length > 0 || currentStatus === "生成回答") {
    return "生成回答";
  }
  return "思考中";
}

function initialActivity(session) {
  return {
    status: "idle",
    gateway: session.config.lab.gatewayUrl ? "configured" : "missing",
    lastGateway: "无",
    lastTool: "无",
    lastTurn: "无",
    toolCount: 0,
    blockedTools: 0,
    failedTools: 0,
    approvalCount: 0,
    questionCount: 0,
    assistantBytes: 0,
    streamBytes: 0,
    thinkingBytes: 0,
    eventCount: 0
  };
}

function updateActivity(current, event) {
  if (event.type === "turn_start") {
    return {
      ...current,
      status: "工作中",
      lastTurn: `轮次 ${event.turnIndex}`,
      streamBytes: 0,
      thinkingBytes: 0
    };
  }
  if (event.type === "gateway_request_start") {
    return {
      ...current,
      status: "等待模型",
      gateway: "请求中",
      lastGateway: `第 ${event.round} 轮：约 ${formatCompactTokenCount(event.promptTokensEstimate)} tokens`,
      promptTokens: event.promptTokensEstimate,
      promptBytes: event.promptBytesEstimate,
      promptMessageTokens: event.promptMessageTokensEstimate,
      promptToolSchemaTokens: event.promptToolSchemaTokensEstimate,
      promptToolResultTokens: event.promptToolResultTokensEstimate
    };
  }
  if (event.type === "gateway_response") {
    const usage = formatGatewayUsageBrief(event.usage);
    return {
      ...current,
      gateway: "已响应",
      lastGateway: `第 ${event.round} 轮：${event.toolCallCount} 个工具调用${usage ? `，Provider ${usage}` : ""}`
    };
  }
  if (event.type === "gateway_stream_start") {
    return {
      ...current,
      gateway: "流式输出",
      lastGateway: `第 ${event.round} 轮：进行中`
    };
  }
  if (event.type === "assistant_thinking_delta") {
    return {
      ...current,
      status: current.status === "生成回答" ? "生成回答" : "思考中",
      thinkingBytes: current.thinkingBytes + (event.bytes ?? Buffer.byteLength(event.text ?? "", "utf8"))
    };
  }
  if (event.type === "assistant_delta") {
    return {
      ...current,
      status: "生成回答",
      streamBytes: current.streamBytes + (event.bytes ?? Buffer.byteLength(event.text ?? "", "utf8"))
    };
  }
  if (event.type === "tool_call_delta") {
    const label = event.nameDelta || event.id || `tool#${Number(event.index ?? 0) + 1}`;
    return { ...current, status: "准备工具", lastTool: `${label} 生成中` };
  }
  if (event.type === "gateway_stream_stop") {
    return {
      ...current,
      gateway: "流式完成",
      lastGateway: `第 ${event.round} 轮：${event.stopReason ?? "done"}`
    };
  }
  if (event.type === "gateway_retry") {
    return {
      ...current,
      status: "网关重试",
      gateway: "重试中",
      lastGateway: `第 ${event.round ?? "?"} 轮：${event.attempt ?? "?"}/${event.maxAttempts ?? "?"}`
    };
  }
  if (event.type === "tool_start") {
    return { ...current, status: "运行工具", lastTool: `${event.name} 运行中` };
  }
  if (event.type === "tool_finish") {
    return {
      ...current,
      status: event.interrupted ? "工具已中断" : event.ok ? "工具完成" : event.blocked ? "工具被阻止" : "工具失败",
      lastTool: `${event.name} ${event.interrupted ? "interrupted" : event.ok ? "done" : event.blocked ? "blocked" : "failed"}`,
      toolCount: current.toolCount + 1,
      blockedTools: current.blockedTools + (event.blocked ? 1 : 0),
      failedTools: current.failedTools + (!event.ok && !event.blocked && !event.interrupted ? 1 : 0)
    };
  }
  if (event.type === "review_gate") {
    return { ...current, status: "等待复核", lastTool: "review gate" };
  }
  if (event.type === "assistant_final") {
    return { ...current, status: "就绪", assistantBytes: event.outputBytes ?? current.assistantBytes };
  }
  if (event.type === "turn_interrupted") {
    return { ...current, status: "已中断", lastTurn: "已中断" };
  }
  if (event.type === "gateway_error") {
    return {
      ...current,
      status: "网关错误",
      gateway: "错误",
      lastGateway: event.error?.code ?? "GATEWAY_ERROR"
    };
  }
  if (event.type === "gateway_not_configured") {
    return { ...current, status: "网关缺失", gateway: "缺失", lastGateway: "未配置" };
  }
  if (event.type === "turn_complete") {
    return { ...current, status: "就绪", lastTurn: event.status };
  }
  return current;
}

function formatCompactTokenCount(value) {
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

function formatGatewayUsageBrief(usage = {}) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    return "";
  }
  const prompt = firstFiniteUsage(usage, ["prompt_tokens", "input_tokens", "promptTokens", "inputTokens"]);
  const completion = firstFiniteUsage(usage, ["completion_tokens", "output_tokens", "completionTokens", "outputTokens"]);
  const total = firstFiniteUsage(usage, ["total_tokens", "totalTokens"]);
  const parts = [
    Number.isFinite(prompt) ? `输入 ${formatCompactTokenCount(prompt)}` : null,
    Number.isFinite(completion) ? `输出 ${formatCompactTokenCount(completion)}` : null,
    Number.isFinite(total) ? `合计 ${formatCompactTokenCount(total)}` : null
  ].filter(Boolean);
  return parts.length > 0 ? `${parts.join(" / ")} tokens` : "";
}

function firstFiniteUsage(usage, keys) {
  for (const key of keys) {
    if (Number.isFinite(usage[key])) {
      return usage[key];
    }
  }
  return undefined;
}

function agentTaskTitle(status) {
  if (status === "queued") {
    return "子任务排队中";
  }
  if (status === "running") {
    return "子任务后台运行中";
  }
  if (status === "completed") {
    return "子任务完成";
  }
  if (status === "partial") {
    return "子任务阶段暂停";
  }
  if (status === "blocked") {
    return "子任务被阻止";
  }
  if (status === "interrupted" || status === "cancelled") {
    return "子任务已中断";
  }
  return "子任务失败";
}

function agentTaskStatusLabel(status) {
  if (status === "queued") {
    return "排队中";
  }
  if (status === "completed") {
    return "已完成";
  }
  if (status === "partial") {
    return "阶段暂停，可继续";
  }
  if (status === "blocked") {
    return "被权限策略阻止";
  }
  if (status === "interrupted") {
    return "已中断";
  }
  if (status === "cancelled") {
    return "已取消";
  }
  if (status === "running") {
    return "运行中";
  }
  return "失败";
}

function truncatePlainText(value, max = 240) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3))}...`;
}

function appendToolCallDraft(current, event) {
  const index = Number.isInteger(event.index) ? event.index : current.tools.length;
  const tools = [...current.tools];
  const existing = tools[index] ?? {
    index,
    id: event.id ?? null,
    nameDraft: "",
    argumentsDraft: ""
  };
  tools[index] = {
    ...existing,
    id: event.id ?? existing.id,
    nameDraft: `${existing.nameDraft ?? ""}${event.nameDelta ?? ""}`,
    argumentsDraft: `${existing.argumentsDraft ?? ""}${event.argumentsDelta ?? ""}`
  };
  return {
    ...current,
    active: true,
    phase: "tool-call",
    round: event.round,
    tools
  };
}

function updateRuntimeTool(current, event, status) {
  const index = current.tools.findIndex((tool) => tool.id === event.toolCallId);
  const resolvedIndex = index >= 0 ? index : current.tools.length;
  const tools = [...current.tools];
  const existing = tools[resolvedIndex] ?? {
    index: resolvedIndex,
    id: event.toolCallId,
    nameDraft: event.name,
    argumentsDraft: ""
  };
  tools[resolvedIndex] = {
    ...existing,
    id: event.toolCallId ?? existing.id,
    name: event.name ?? existing.name ?? existing.nameDraft,
    status
  };
  return {
    ...current,
    active: true,
    phase: status === "running" ? "tool-running" : status === "interrupted" ? "tool-interrupted" : "tool-finished",
    tools
  };
}

function handleApprovalInput(inputValue, key, current, sessionApprovals, addEntry, setActivity, setMode, setPendingApproval, setApprovalChoiceIndex) {
  let choice = inputValue?.toLowerCase();
  if (!current.pendingApproval) {
    return;
  }
  if (key.leftArrow || key.upArrow) {
    setApprovalChoiceIndex((value) => (value + APPROVAL_CHOICES.length - 1) % APPROVAL_CHOICES.length);
    return;
  }
  if (key.rightArrow || key.downArrow || key.tab) {
    setApprovalChoiceIndex((value) => (value + 1) % APPROVAL_CHOICES.length);
    return;
  }
  if (key.return) {
    choice = APPROVAL_CHOICES[current.approvalChoiceIndex]?.key ?? "y";
  }
  if (choice === "escape") {
    const pending = current.pendingApproval;
    setPendingApproval(null);
    setMode("input");
    setApprovalChoiceIndex(0);
    addEntry("approval", `${pending.toolName} 已取消`, "已取消。");
    setActivity((value) => ({ ...value, status: "审批已取消", lastTool: `${pending.toolName} 已取消` }));
    pending.resolve(false);
    return;
  }
  if (!["y", "n", "a"].includes(choice)) {
    return;
  }
  const pending = current.pendingApproval;
  setPendingApproval(null);
  setMode("input");
  setApprovalChoiceIndex(0);
  if (choice === "a") {
    sessionApprovals.add(pending.approvalKey);
    addEntry("approval", `${pending.toolName} 已批准`, "本会话中匹配的请求已批准。");
    setActivity((value) => ({ ...value, status: "审批已通过", lastTool: `${pending.toolName} 已批准` }));
    pending.resolve(true);
  } else if (choice === "y") {
    addEntry("approval", `${pending.toolName} 已批准`, "已允许一次。");
    setActivity((value) => ({ ...value, status: "审批已通过", lastTool: `${pending.toolName} 已批准` }));
    pending.resolve(true);
  } else {
    addEntry("approval", `${pending.toolName} 已拒绝`, "已拒绝。");
    setActivity((value) => ({ ...value, status: "审批已拒绝", lastTool: `${pending.toolName} 已拒绝` }));
    pending.resolve(false);
  }
}

function handleQuestionInput(inputValue, key, current, handlers) {
  const {
    addEntry,
    setActivity,
    setMode,
    setPendingQuestion,
    replaceQuestionDraft,
    updateQuestionDraft
  } = handlers;
  if (!current.pendingQuestion) {
    return;
  }
  const prompt = normalizeQuestionPrompt(current.pendingQuestion);
  const hasChoices = prompt.choices.length > 0;
  if (key.escape) {
    const pending = current.pendingQuestion;
    setPendingQuestion(null);
    replaceQuestionDraft("");
    setMode("input");
    addEntry("answer", "你已取消回答", "[取消]");
    setActivity((value) => ({ ...value, status: "回答已取消" }));
    pending.resolve({
      answer: "",
      selectedChoice: null,
      selectedChoices: [],
      cancelled: true
    });
    return;
  }
  if (hasChoices && key.upArrow) {
    const nextIndex = (prompt.focusedIndex - 1 + prompt.choices.length) % prompt.choices.length;
    setPendingQuestion((pending) => pending ? { ...pending, focusedIndex: nextIndex } : pending);
    return;
  }
  if (hasChoices && key.downArrow) {
    const nextIndex = (prompt.focusedIndex + 1) % prompt.choices.length;
    setPendingQuestion((pending) => pending ? { ...pending, focusedIndex: nextIndex } : pending);
    return;
  }
  if (hasChoices && inputValue === " " && (!prompt.allowCustom || current.questionBuffer.length === 0)) {
    if (prompt.multiple) {
      const selected = new Set(prompt.selectedIndices);
      if (selected.has(prompt.focusedIndex)) {
        selected.delete(prompt.focusedIndex);
      } else {
        selected.add(prompt.focusedIndex);
      }
      setPendingQuestion((pending) => pending ? { ...pending, selectedIndices: [...selected] } : pending);
    } else {
      setPendingQuestion((pending) => pending ? { ...pending, selectedIndices: [prompt.focusedIndex] } : pending);
    }
    return;
  }
  if (isCtrlKey(inputValue, key, "a")) {
    updateQuestionDraft((draft) => moveCursor(draft, "start"));
    return;
  }
  if (isCtrlKey(inputValue, key, "e")) {
    updateQuestionDraft((draft) => moveCursor(draft, "end"));
    return;
  }
  if (isCtrlKey(inputValue, key, "k")) {
    updateQuestionDraft(deleteToEnd);
    return;
  }
  if (isCtrlKey(inputValue, key, "u")) {
    updateQuestionDraft(deleteToStart);
    return;
  }
  const trailingSubmitText = splitTrailingSubmitInput(inputValue, key);
  if (trailingSubmitText !== null) {
    const next = updateQuestionDraft((draft) => insertText(draft, trailingSubmitText));
    handleQuestionInput("", { return: true }, {
      ...current,
      questionBuffer: next.text,
      questionCursor: next.cursor
    }, handlers);
    return;
  }
  if (isCtrlKey(inputValue, key, "j")) {
    updateQuestionDraft((draft) => insertText(draft, "\n"));
    return;
  }
  if (key.return && (key.shift || key.meta)) {
    updateQuestionDraft((draft) => insertText(draft, "\n"));
    return;
  }
  if (key.return) {
    const customAnswer = current.questionBuffer.trim();
    const pending = current.pendingQuestion;
    const refreshedPrompt = normalizeQuestionPrompt(pending);
    const selectedIndices = refreshedPrompt.multiple
      ? refreshedPrompt.selectedIndices
      : refreshedPrompt.selectedIndices.length > 0
        ? refreshedPrompt.selectedIndices
        : hasChoices && !customAnswer
          ? [refreshedPrompt.focusedIndex]
          : [];
    const selectedChoices = selectedIndices
      .map((index) => refreshedPrompt.choices[index]?.label)
      .filter(Boolean);
    const answer = customAnswer || selectedChoices.join(", ");
    setPendingQuestion(null);
    replaceQuestionDraft("");
    setMode("input");
    addEntry("answer", "你已回答", answer || "[空]");
    setActivity((value) => ({ ...value, status: "回答已提交" }));
    pending.resolve({
      answer,
      selectedChoice: selectedChoices[0] ?? null,
      selectedChoices,
      customAnswer: customAnswer || null,
      workflowReminder: refreshedPrompt.choices.length > 0
        ? "If this confirmation starts multi-step work, update the visible workflow state with todo_write and/or plan_update. Before the final response, mark completed visible items as completed."
        : null
    });
    return;
  }
  if (!hasChoices && !key.ctrl && (key.upArrow || key.downArrow) && current.questionBuffer) {
    updateQuestionDraft((draft) => moveCursorVertical(draft, key.upArrow ? "up" : "down", {
      columns: composerContentColumns({ ...current, mode: "question" })
    }));
    return;
  }
  if (key.leftArrow) {
    updateQuestionDraft((draft) => moveCursor(draft, key.meta ? "word-left" : "left"));
    return;
  }
  if (key.rightArrow) {
    updateQuestionDraft((draft) => moveCursor(draft, key.meta ? "word-right" : "right"));
    return;
  }
  if (key.home) {
    updateQuestionDraft((draft) => moveCursorLineBoundary(draft, "start", {
      columns: composerContentColumns({ ...current, mode: "question" })
    }));
    return;
  }
  if (key.end) {
    updateQuestionDraft((draft) => moveCursorLineBoundary(draft, "end", {
      columns: composerContentColumns({ ...current, mode: "question" })
    }));
    return;
  }
  if (key.backspace) {
    updateQuestionDraft(deleteBackward);
    return;
  }
  if (key.delete) {
    updateQuestionDraft(deleteForward);
    return;
  }
  const inputText = sanitizeComposerText(inputValue);
  if (!key.ctrl && !key.meta && inputText) {
    updateQuestionDraft((draft) => insertText(draft, inputText));
  }
}

function recallHistory(direction, history, historyIndex, setHistoryIndex, replaceInputDraft) {
  if (history.length === 0) {
    return;
  }
  const nextIndex = historyIndex === null
    ? direction < 0 ? history.length - 1 : 0
    : Math.min(history.length - 1, Math.max(0, historyIndex + direction));
  setHistoryIndex(nextIndex);
  const text = history[nextIndex] ?? "";
  replaceInputDraft(text);
}

function nextFilter(value, filters, direction = 1) {
  const list = Array.isArray(filters) && filters.length > 0 ? filters : ["all"];
  const index = list.indexOf(value);
  const current = index >= 0 ? index : 0;
  return list[(current + direction + list.length) % list.length] ?? list[0];
}

function updateDraftRef(ref, updater) {
  const draft = clampDraftCursor(ref.current ?? createDraft(""));
  const next = clampDraftCursor(updater(draft));
  ref.current = next;
  return next;
}

function composerContentColumns(current = {}) {
  const size = current.terminalSize ?? {};
  const width = Math.max(60, Number(size.columns) || 100);
  const prompt = current.mode === "question"
    ? (normalizeQuestionPrompt(current.pendingQuestion).choices.length > 0 ? "自定义>" : "回答>")
    : current.busy
      ? "队列>"
      : String(current.inputBuffer ?? "").trimStart().startsWith("!")
        ? "Shell>"
        : ">";
  const draftColumns = Math.max(8, width - 4);
  const promptColumns = displayWidth(prompt) + 1;
  return Math.max(8, draftColumns - Math.max(promptColumns, 2));
}

function readTerminalSize(stdout) {
  return {
    columns: Math.max(60, Number(stdout?.columns) || 100),
    rows: Math.max(18, Number(stdout?.rows) || 30)
  };
}

function commandPanelVisibleRowsForSize(size, current = {}) {
  if (current.commandPanel?.kind === "message-excerpt") {
    return Math.max(1, Math.max(18, Number(size?.rows) || 30) - 4);
  }
  const layout = resolveTuiLayoutRows({
    height: Math.max(18, Number(size?.rows) || 30),
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

function maxCommandPanelOffset(panel, size, current = {}) {
  return commandPanelViewport(panel, 0, commandPanelVisibleRowsForSize(size, { ...current, commandPanel: panel })).maxOffset;
}

export function resolveTuiLayoutRows(options = {}) {
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
  const commandPanelChromeRows = 1 + (options.commandPanel?.tabs?.length > 0 ? 1 : 0) + 1 + 1 + 2;
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

function estimatePromptBoxRows(options, height) {
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
      maxPromptLines: promptContentRowsForMode(options.mode)
    }
  );
  const wantedRows = Math.max(3, lines.length + 2);
  const maxRows = options.mode === "question"
    ? Math.max(7, Math.min(12, Math.floor(height * 0.5)))
    : 5;
  return Math.min(wantedRows, maxRows);
}

function promptContentRowsForMode(mode) {
  return mode === "question" ? 10 : 3;
}

function desiredPanelRows(kind, height, options = {}) {
  if (kind === "command") {
    const lineCount = Math.max(0, options.commandPanel?.lines?.length ?? 0);
    const tabs = options.commandPanel?.tabs?.length > 0 ? 1 : 0;
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

function isNativeScrollbackMode(current = {}) {
  const size = current.terminalSize ?? {};
  return shouldUseScrollbackMode(size.rows, {
    pinnedSidePanel: Number(size.columns) >= 108,
    streamActive: Boolean(current.stream?.active)
  });
}

function activeOverlayKind(current = {}) {
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

function isMessageExcerptPanelActive(current = {}) {
  return current.commandPanel?.kind === "message-excerpt";
}

function frameForState(current = {}) {
  const size = current.terminalSize ?? {};
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

function transcriptSubtargetForMouse(event, current = {}, frame = frameForState(current)) {
  if (!current.stream?.active || !event || !Number.isFinite(event.y)) {
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
  return event.y >= streamTop ? "stream" : "transcript";
}

function entryAtTranscriptMouseEvent(event, current = {}) {
  if (!event || !Number.isFinite(event.y)) {
    return null;
  }
  const frame = frameForState(current);
  const transcript = frame.regions.transcript;
  if (!transcript || event.x < transcript.left || event.x > transcript.right || event.y < transcript.top || event.y > transcript.bottom) {
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
  const rowInBox = event.y - transcript.top;
  const lineIndex = rowInBox - 2;
  if (lineIndex < 0 || lineIndex >= viewport.lines.length) {
    return null;
  }
  const lineEntryId = viewport.lines[lineIndex]?.entryId;
  if (!lineEntryId) {
    return null;
  }
  return (current.entries ?? []).find((entry) => entry.id === lineEntryId) ?? null;
}

function transcriptRegionForState(current = {}) {
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

function streamRegionForState(current = {}) {
  const frame = frameForState(current);
  const logLayout = resolveLogPaneLayout({
    height: frame.regions.transcript.height,
    streamActive: Boolean(current.stream?.active),
    scrollbackMode: false
  });
  const viewport = streamingViewport(
    { ...(current.stream ?? {}), thinkingVisible: Boolean(current.thinkingVisible) },
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

function messageActionsForEntry(entry) {
  const actions = ["copy", "copy-forward"];
  if (entry?.kind === "user" && Number.isInteger(entry.checkpointMessagesLength)) {
    actions.push("rewind-edit", "regenerate");
  } else if (entry?.kind === "user") {
    actions.push("rewind-disabled");
  }
  return actions.filter((action) => MESSAGE_ACTIONS.includes(action) || action === "rewind-disabled");
}

function entriesFromSelected(entries = [], entryId) {
  const start = entries.findIndex((entry) => entry.id === entryId);
  const selected = start >= 0 ? entries.slice(start) : [];
  return selected.filter((entry) => ["user", "assistant", "tool", "tools", "trace", "error", "approval", "output", "command", "context", "agent", "session"].includes(entry?.kind));
}

function formatEntriesForClipboard(entries = []) {
  return entries.map((entry) => formatEntryForClipboard(entry)).filter(Boolean).join("\n\n");
}

function formatEntryForClipboard(entry = {}) {
  const label = entry.kind === "user"
    ? "你"
    : entry.kind === "assistant"
      ? "Ant Code"
      : entry.kind === "agent"
        ? `子智能体${entry.title ? ` - ${entry.title}` : ""}`
      : entry.title
        ? `${entry.kind ?? "message"} - ${entry.title}`
      : entry.kind ?? "message";
  const body = String(entry.excerptBody ?? entry.body ?? "");
  const thinkingBytes = Number(entry.thinkingBytes ?? Buffer.byteLength(String(entry.thinking ?? ""), "utf8"));
  const thinkingNotice = entry.kind === "assistant" && thinkingBytes > 0
    ? `\n[thinking 已隐藏：${thinkingBytes} 字节，不复制]`
    : "";
  const displayBody = entry.kind === "assistant"
    ? formatMessageBodyForDisplayClipboard({ ...entry, body })
    : body;
  return `${label}${thinkingNotice}\n${displayBody}`.trim();
}

function writeClipboardText(text, env) {
  const value = String(text ?? "");
  if (!value) {
    return { ok: false, error: "没有可复制的文本。" };
  }
  const command = process.platform === "win32"
    ? [
      "$stream = [Console]::OpenStandardInput()",
      "$buffer = [byte[]]::new(8192)",
      "$memory = [System.IO.MemoryStream]::new()",
      "while (($read = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) { $memory.Write($buffer, 0, $read) }",
      "$text = [System.Text.UTF8Encoding]::new($false).GetString($memory.ToArray())",
      "Set-Clipboard -Value $text"
    ].join("; ")
    : process.platform === "darwin"
      ? "pbcopy"
      : "xclip -selection clipboard";
  const executable = process.platform === "win32" ? "powershell.exe" : process.platform === "darwin" ? "sh" : "sh";
  const args = process.platform === "win32"
    ? ["-NoProfile", "-NonInteractive", "-Command", command]
    : ["-c", command];
  const result = spawnSync(executable, args, {
    input: value,
    encoding: "utf8",
    env: env ?? process.env,
    windowsHide: true,
    timeout: 3000
  });
  if (result.error) {
    return { ok: false, error: result.error.message };
  }
  if (result.status !== 0) {
    return { ok: false, error: String(result.stderr || result.stdout || `clipboard exited ${result.status}`).trim() };
  }
  return { ok: true };
}

function isModelResponseInFlight(stream = {}) {
  if (!stream?.active) {
    return false;
  }
  return new Set(["requesting", "streaming", "thinking", "answering", "tool-call", "finalizing"]).has(stream.phase);
}

function readGitStatusSummary(cwd, env) {
  return new Promise((resolve) => {
    execFile("git", ["status", "--short"], {
      cwd,
      env: env ?? process.env,
      windowsHide: true,
      timeout: 5000
    }, (error, stdout, stderr) => {
      if (error) {
        resolve({
          gitAvailable: false,
          gitStatus: String(stderr || error.message || "git status unavailable").trim()
        });
        return;
      }
      resolve({
        gitAvailable: true,
        gitStatus: stdout.trim() || "clean"
      });
    });
  });
}

function clearTerminalForFullRedraw(stream) {
  stream?.write?.("\u001b[3J\u001b[2J\u001b[H");
}

export function readBracketedPaste(chunkText, state) {
  const start = "\u001b[200~";
  const end = "\u001b[201~";
  const text = String(chunkText ?? "");
  if (!state.active) {
    const combined = `${state.prefix ?? ""}${text}`;
    state.prefix = "";
    const startIndex = combined.indexOf(start);
    if (startIndex === -1) {
      const prefix = trailingMarkerPrefix(combined, start);
      if (prefix) {
        state.prefix = prefix;
        return "";
      }
      return null;
    }
    state.active = true;
    state.buffer = combined.slice(0, startIndex);
    const rest = combined.slice(startIndex + start.length);
    const endIndex = rest.indexOf(end);
    if (endIndex === -1) {
      state.buffer += rest;
      return "";
    }
    const pasted = `${state.buffer}${rest.slice(0, endIndex)}${rest.slice(endIndex + end.length)}`;
    state.active = false;
    state.buffer = "";
    return pasted;
  }

  const combined = `${state.buffer}${text}`;
  const endIndex = combined.indexOf(end);
  if (endIndex === -1) {
    state.buffer = combined;
    return "";
  }
  const pasted = `${combined.slice(0, endIndex)}${combined.slice(endIndex + end.length)}`;
  state.active = false;
  state.buffer = "";
  return pasted;
}

function trailingMarkerPrefix(value, marker) {
  const text = String(value ?? "");
  for (let length = Math.min(text.length, marker.length - 1); length >= 3; length -= 1) {
    if (text.endsWith(marker.slice(0, length))) {
      return marker.slice(0, length);
    }
  }
  return "";
}

function looksLikePastedText(value) {
  const text = String(value ?? "");
  return text.length > 1 && /[\r\n]/.test(text);
}

export function isCtrlKey(inputValue, key, name) {
  return Boolean(key?.ctrl)
    && String(inputValue ?? "").toLowerCase() === String(name ?? "").toLowerCase();
}

export function isInkKeyRelease(key) {
  return key?.eventType === "release";
}

export function splitTrailingSubmitInput(inputValue, key = {}) {
  const value = String(inputValue ?? "");
  if (key.return || key.ctrl || key.meta || value.length < 2 || !value.endsWith("\r") || value.endsWith("\r\n")) {
    return null;
  }
  const text = value.slice(0, -1);
  return /[\u0000-\u001F\u007F]/.test(text) ? null : text;
}

function sanitizeComposerText(value) {
  return String(value ?? "")
    .replace(/\u001b\[200~/g, "")
    .replace(/\u001b\[201~/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

function countLogicalLines(value) {
  const text = String(value ?? "");
  if (!text) {
    return 0;
  }
  return text.split(/\n/).length;
}

function debugRawInput(env, text, source = "stdin") {
  if (!isTuiInputDebugEnabled(env)) {
    return;
  }
  const visible = Array.from(String(text ?? "")).map((char) => {
    const code = char.charCodeAt(0);
    if (code === 27) {
      return "\\x1b";
    }
    if (code < 32 || code === 127) {
      return `\\x${code.toString(16).padStart(2, "0")}`;
    }
    return char;
  }).join("");
  try {
    appendFileSync(path.join(os.tmpdir(), "lab-agent-tui-input.log"), `${Date.now()} ${source} ${visible}\n`, "utf8");
  } catch {
    // Debug logging must never affect TUI input.
  }
}

function debugTuiInput(env, message) {
  if (!isTuiInputDebugEnabled(env)) {
    return;
  }
  try {
    appendFileSync(path.join(os.tmpdir(), "lab-agent-tui-input.log"), `${Date.now()} event ${String(message ?? "")}\n`, "utf8");
  } catch {
    // Debug logging must never affect TUI input.
  }
}

function isTuiInputDebugEnabled(env) {
  return env?.LAB_AGENT_TUI_DEBUG_INPUT === "1" || process.env.LAB_AGENT_TUI_DEBUG_INPUT === "1";
}

function trailingRawShiftTabInput(value) {
  const text = String(value ?? "");
  if (!text) {
    return "";
  }
  if (text.endsWith("\u001b") || text.endsWith("\u001b[") || text.endsWith("\u001b[1;") || text.endsWith("\u001b[1;2") || text.endsWith("\u001b[9;") || text.endsWith("\u001b[9;2")) {
    return text.slice(Math.max(0, text.lastIndexOf("\u001b")));
  }
  return "";
}

function enterTerminalAppMode(stream, options = {}) {
  debugTuiInput(options.env, `terminal_app_mode enter pid=${process.pid} cwd=${process.cwd()} mouse=click-drag`);
  setWindowsConsoleCodePage(65001, options);
  stream?.write?.("\u001b[?1049h\u001b[?2004h\u001b[?25l\u001b[2J\u001b[H");
}

function exitTerminalAppMode(stream, options = {}) {
  debugTuiInput(options.env, "terminal_app_mode exit");
  disableTerminalMouse(stream, { env: options.env, reason: "terminal-exit" });
  restoreWindowsConsoleInputMode(options.initialWindowsConsoleInputMode, options);
  restoreWindowsConsoleCodePage(options.initialWindowsConsoleCodePage, options);
  stream?.write?.("\u001b[?2004l\u001b[?25h\u001b[?1049l\u001b[0m\u001b[2K\r\n");
}

function enableTerminalMouse(stream, options = {}) {
  debugTuiInput(options.env, `terminal_mouse enable reason=${options.reason ?? "unknown"} force=${options.forceConsoleMode ? "1" : "0"}`);
  enableWindowsConsoleMouseInput(options);
  stream?.write?.("\u001b[?1000h\u001b[?1002h\u001b[?1006h\u001b[?1015h\u001b[?1007h");
}

function enterTerminalSelectionMode(stream, options = {}) {
  debugTuiInput(options.env, `terminal_selection enter reason=${options.reason ?? "unknown"}`);
  disableTerminalMouse(stream, { env: options.env, reason: `selection:${options.reason ?? "unknown"}` });
  restoreWindowsConsoleSelectionInput(options.initialWindowsConsoleInputMode, options);
}

function disableTerminalMouse(stream, options = {}) {
  debugTuiInput(options.env, `terminal_mouse disable reason=${options.reason ?? "unknown"}`);
  stream?.write?.("\u001b[?1007l\u001b[?1015l\u001b[?1006l\u001b[?1002l\u001b[?1000l");
}

let windowsConsoleInputEnabled = false;

function snapshotWindowsConsoleCodePage() {
  if (process.platform !== "win32") {
    return null;
  }
  const result = runWindowsConsoleModeScript(`
[Console]::Out.Write([Console]::OutputEncoding.CodePage)
`, { output: true });
  const codePage = Number.parseInt(String(result?.stdout ?? "").trim(), 10);
  return Number.isFinite(codePage) ? codePage : null;
}

function setWindowsConsoleCodePage(codePage, options = {}) {
  if (process.platform !== "win32" || !Number.isFinite(codePage)) {
    return;
  }
  const debugEnabled = isTuiInputDebugEnabled(options.env);
  const beforeCodePage = debugEnabled ? snapshotWindowsConsoleCodePage() : null;
  const result = runWindowsConsoleModeScript(`
$encoding = [System.Text.Encoding]::GetEncoding(${Number(codePage)})
[Console]::InputEncoding = $encoding
[Console]::OutputEncoding = $encoding
chcp.com ${Number(codePage)} | Out-Null
`);
  if (debugEnabled) {
    const afterCodePage = snapshotWindowsConsoleCodePage();
    debugTuiInput(options.env, `windows_console_codepage set before=${beforeCodePage ?? "?"} after=${afterCodePage ?? "?"} target=${Number(codePage)} status=${result?.status ?? "?"} exe=${result?.executable ?? "?"}`);
  }
}

function restoreWindowsConsoleCodePage(codePage, options = {}) {
  if (process.platform !== "win32" || !Number.isFinite(codePage) || Number(codePage) === 65001) {
    return;
  }
  setWindowsConsoleCodePage(Number(codePage), options);
}

function snapshotWindowsConsoleInputMode() {
  if (process.platform !== "win32") {
    return null;
  }
  const result = runWindowsConsoleModeScript(`
${windowsConsoleModeNativeScript()}
[int]$mode = 0
if ([LabAgentTui.ConsoleMode]::GetConsoleMode([LabAgentTui.ConsoleMode]::GetStdHandle(-10), [ref]$mode)) {
  [Console]::Out.Write($mode)
}
`, { output: true });
  const mode = Number.parseInt(String(result?.stdout ?? "").trim(), 10);
  return Number.isFinite(mode) ? mode : null;
}

function enableWindowsConsoleMouseInput(options = {}) {
  if (process.platform !== "win32") {
    debugTuiInput(options.env, "windows_console_mouse skip platform");
    return;
  }
  const shouldCalibrate = options.forceConsoleMode === true || !windowsConsoleInputEnabled;
  if (!shouldCalibrate) {
    debugTuiInput(options.env, "windows_console_mouse skip already-enabled");
    return;
  }
  const debugEnabled = isTuiInputDebugEnabled(options.env);
  const beforeMode = debugEnabled ? snapshotWindowsConsoleInputMode() : null;
  const result = runWindowsConsoleModeScript(`
${windowsConsoleModeNativeScript()}
[int]$mode = 0
$handle = [LabAgentTui.ConsoleMode]::GetStdHandle(-10)
if ([LabAgentTui.ConsoleMode]::GetConsoleMode($handle, [ref]$mode)) {
  $next = ($mode -bor 0x0010 -bor 0x0080 -bor 0x0200) -band (-bnot 0x0040)
  [void][LabAgentTui.ConsoleMode]::SetConsoleMode($handle, $next)
}
`);
  const succeeded = result?.status === 0;
  windowsConsoleInputEnabled = succeeded;
  if (debugEnabled) {
    const afterMode = snapshotWindowsConsoleInputMode();
    debugTuiInput(options.env, `windows_console_mouse enable before=${formatConsoleMode(beforeMode)} after=${formatConsoleMode(afterMode)} force=${options.forceConsoleMode ? "1" : "0"} status=${result?.status ?? "?"} exe=${result?.executable ?? "?"}`);
  }
}

function restoreWindowsConsoleSelectionInput(initialMode, options = {}) {
  windowsConsoleInputEnabled = false;
  if (process.platform !== "win32") {
    debugTuiInput(options.env, "windows_console_selection skip platform");
    return;
  }
  const fallbackMode = 0x0080 | 0x0200 | 0x0040;
  const baseMode = Number.isFinite(initialMode) ? Number(initialMode) : fallbackMode;
  const debugEnabled = isTuiInputDebugEnabled(options.env);
  const beforeMode = debugEnabled ? snapshotWindowsConsoleInputMode() : null;
  const result = runWindowsConsoleModeScript(`
${windowsConsoleModeNativeScript()}
$handle = [LabAgentTui.ConsoleMode]::GetStdHandle(-10)
[int]$mode = ${Number(baseMode)}
[void][LabAgentTui.ConsoleMode]::GetConsoleMode($handle, [ref]$mode)
$next = ($mode -bor 0x0080 -bor 0x0200 -bor 0x0040) -band (-bnot 0x0010)
[void][LabAgentTui.ConsoleMode]::SetConsoleMode($handle, $next)
`);
  if (debugEnabled) {
    const afterMode = snapshotWindowsConsoleInputMode();
    debugTuiInput(options.env, `windows_console_selection restore before=${formatConsoleMode(beforeMode)} after=${formatConsoleMode(afterMode)} base=${formatConsoleMode(baseMode)} status=${result?.status ?? "?"} exe=${result?.executable ?? "?"}`);
  }
}

function restoreWindowsConsoleInputMode(mode, options = {}) {
  windowsConsoleInputEnabled = false;
  if (process.platform !== "win32" || !Number.isFinite(mode)) {
    debugTuiInput(options.env, `windows_console_input restore skipped target=${formatConsoleMode(mode)}`);
    return;
  }
  const debugEnabled = isTuiInputDebugEnabled(options.env);
  const beforeMode = debugEnabled ? snapshotWindowsConsoleInputMode() : null;
  const result = runWindowsConsoleModeScript(`
${windowsConsoleModeNativeScript()}
[void][LabAgentTui.ConsoleMode]::SetConsoleMode([LabAgentTui.ConsoleMode]::GetStdHandle(-10), ${Number(mode)})
`);
  if (debugEnabled) {
    const afterMode = snapshotWindowsConsoleInputMode();
    debugTuiInput(options.env, `windows_console_input restore before=${formatConsoleMode(beforeMode)} after=${formatConsoleMode(afterMode)} target=${formatConsoleMode(mode)} status=${result?.status ?? "?"} exe=${result?.executable ?? "?"}`);
  }
}

function formatConsoleMode(mode) {
  if (!Number.isFinite(mode)) {
    return "?";
  }
  const value = Number(mode);
  return `${value}/0x${value.toString(16)}`;
}

function runWindowsConsoleModeScript(script, options = {}) {
  let firstResult = null;
  for (const executable of ["powershell.exe", "pwsh.exe", "pwsh", "powershell"]) {
    const result = spawnSync(executable, ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      stdio: options.output ? ["inherit", "pipe", "ignore"] : ["inherit", "ignore", "ignore"],
      timeout: 3000,
      windowsHide: true
    });
    result.executable = executable;
    if (!firstResult) {
      firstResult = result;
    }
    if (!result.error && result.status === 0) {
      return result;
    }
  }
  return firstResult;
}

function windowsConsoleModeNativeScript() {
  return `
$definition = @"
using System;
using System.Runtime.InteropServices;
namespace LabAgentTui {
  public static class ConsoleMode {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr GetStdHandle(int nStdHandle);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetConsoleMode(IntPtr hConsoleHandle, out int lpMode);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetConsoleMode(IntPtr hConsoleHandle, int dwMode);
  }
}
"@
Add-Type -TypeDefinition $definition -ErrorAction Stop
`;
}
