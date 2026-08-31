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
  transcriptHitAtMouseEvent,
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
import { formatVisibleTranscriptSelection, isMeaningfulTranscriptDrag, normalizeTranscriptSelection } from "./transcript-selection.ts";
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
import { useTuiAppCore } from "./app-core.ts";

export function useTuiAppPanels(s: ReturnType<typeof useTuiAppCore>) {
  const {
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
  } = s;
  const addEntry = useCallback((kind: string, title: string, body?: string | number | null, metadata?: Partial<TuiEntry> | null) => {
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

  const updateEntryById = useCallback((id: string, patch: Partial<TuiEntry> | ((entry: TuiEntry) => Partial<TuiEntry>)) => {
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

  const openCommandPanel = useCallback((panel: TuiCommandPanel) => {
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

  const openLogsPanel = useCallback((options: {
    items?: TuiInspectorItem[];
    filter?: string;
    index?: number;
    inspector?: TuiInspectorItem;
    offset?: number;
    patchFileIndex?: number;
  } = {}) => {
    const items = options.items ?? stateRef.current.inspectorItems ?? inspectorItems;
    const filter = String(options.filter ?? stateRef.current.inspectorFilter ?? inspectorFilter);
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

  const cyclePermissionMode = useCallback(async (current: TuiUiState = stateRef.current, source: string = "key") => {
    if (!current.startupConfirmed || !current.trusted) {
      return false;
    }
    const session = sessionRef.current;
    if (session.goal?.enabled) {
      addEntry("permission", "Goal 锁定权限", "Goal 开启时不能切换权限。请先 /goal exit。");
      setActivity((value) => ({ ...value, status: "Goal 锁定权限" }));
      return false;
    }
    const nextMode = nextPermissionMode(session, current.permissionMode);
    try {
      await persistTuiPermissionCycle(session, nextMode, { env: props.env });
    } catch (error) {
      addEntry("permission", "权限切换未保存", error instanceof Error ? error.message : String(error));
      return false;
    }
    sessionApprovals.current = new Set();
    setPermissionMode(nextMode);
    const effectNote = current.busy
      ? "当前运行中的轮次保留启动时权限；新模式从后续提示/命令生效；本会话同类批准已清空。"
      : "新模式从后续提示/命令生效；本会话同类批准已清空。";
    addEntry("permission", "模式已切换", [
      `${permissionModeLabel(session)}: ${permissionModeDescription(nextMode)}`,
      effectNote
    ].filter(Boolean).join("\n"));
    setActivity((value) => ({ ...value, status: `权限：${permissionModeLabel(session)}（后续生效）` }));
    debugTuiInput(props.env, `permission_switch source=${source} mode=${nextMode}`);
    return true;
  }, [addEntry, props.env]);

  const switchLogsPanelFilter = useCallback((filter: string) => {
    const current = stateRef.current;
    const items = current.inspectorItems ?? [];
    const nextIndex = resolveInspectorIndex(items, current.inspectorIndex ?? 0, filter);
    setInspectorFilter(String(filter));
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

  const pushInspector = useCallback((item: Record<string, unknown>, _options: { focus?: boolean } = {}) => {
    setInspectorItems((current) => {
      const next = [...current, item].slice(-MAX_INSPECTOR_ITEMS);
      setInspectorIndex(next.length - 1);
      return next;
    });
    setInspectorOffset(0);
    setInspectorPatchFileIndex(0);
  }, []);

  const summarizeInfo = useCallback(() => summarizeSessionInfo(sessionRef.current), []);

  const setQueueState = useCallback((prompts: string[], nextIndex: number = 0) => {
    const nextPrompts = Array.isArray(prompts) ? prompts.slice(0, 20) : [];
    queuedPromptsRef.current = nextPrompts;
    setQueuedPrompts(nextPrompts);
    setQueuePanelIndex(boundedIndex(nextPrompts, Number(nextIndex) || 0));
  }, []);

  const openQueuePanel = useCallback((selectedIndex: number = 0) => {
    const index = boundedIndex(queuedPromptsRef.current, Number(selectedIndex) || 0);
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
    setTaskGroupRecords(groups as TuiTaskGroupRecord[]);
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

  const openResumePanel = useCallback((selectedIndex?: number) => {
    const panel = createResumePanel({
      session: sessionRef.current,
      selectedIndex
    });
    openCommandPanel(panel);
    const chunks = sessionRef.current.transcriptArchive?.chunks?.length ?? 0;
    pushInspector(makeInspector("Resume", "/resume", `当前会话 ${chunks} 个 transcript 分片；/sessions 负责恢复会话。`, "context"), { focus: false });
  }, [openCommandPanel, pushInspector]);

  const openResumeChunkPanel = useCallback(async (chunkIndex: number | string) => {
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
      messages: Array.isArray(result.messages)
        ? result.messages.flatMap((item) => {
            if (!item || typeof item !== "object") {
              return [];
            }
            const rec = item as { role?: string; content?: unknown };
            return [{ role: rec.role, content: rec.content }];
          })
        : []
    }));
    pushInspector(makeInspector("Resume", `/resume ${index}`, `已打开当前会话分片 ${index}，${result.messages?.length ?? 0} 条消息。`, "context"), { focus: false });
  }, [openCommandPanel, props.cwd, props.env, pushInspector]);

  const clearContextNow = useCallback(() => {
    clearSessionContext(sessionRef.current);
    addEntry("context", "已清除", "对话上下文已清除。");
    openCommandPanel(createContextPanel({ session: sessionRef.current }));
    pushInspector(makeInspector("上下文", "/clear", "对话上下文已清除。", "context"), { focus: true });
  }, [addEntry, openCommandPanel, pushInspector]);

  const replaceSession = useCallback(async (options: Record<string, unknown> = {}) => {
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
        resume: options.resume == null || options.resume === "" ? null : String(options.resume),
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
      setAntState(createInitialEventState() as AntEventState);
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
      const code = (error as { code?: string } | null)?.code;
      const raw = error instanceof Error ? error.message : String(error);
      const missing = code === "SESSION_NOT_FOUND" || /No session metadata matched/i.test(raw);
      const message = missing
        ? "没有找到该会话的落盘记录。新会话或 Goal 若在第一轮写盘前异常退出，就不会留下可恢复文件。请在同一工作目录用 /sessions 打开已保存的记录。"
        : raw;
      addEntry("error", options.resume ? "恢复失败" : "新会话失败", message);
      openCommandPanel(createTextOutputPanel({
        title: options.resume ? "恢复失败" : "新会话失败",
        command: options.resume ? `/sessions (${options.resume})` : "/new",
        output: message,
        kind: "sessions-output"
      }));
    }
  }, [addEntry, openCommandPanel, props.cwd, props.env, replaceInputDraft, replaceQuestionDraft, setSideOffset, setStreamOffset, setTranscriptOffset]);

  const switchModel = useCallback((model: LabModel) => {
    sessionRef.current.model = model.id;
    sessionRef.current.config.modelAlias = model.id;
    setActiveModel(model.id);
    setActivity((current) => ({ ...current, status: `模型 ${model.id}` }));
    addEntry("model", "模型已切换", `${model.id}${model.thinking ? "\nthinking：provider 暴露的 thinking 默认隐藏，可用 /thinking 展开当前可见内容" : ""}`);
    pushInspector(makeInspector("模型", "/model", [
      `当前：${model.id}`,
      `标签：${model.label}`,
      `thinking：${model.thinking ? "网关流式返回时此别名支持；默认隐藏" : "无专用 thinking 流"}`,
      `网关：${sessionRef.current.config.lab?.gatewayProtocol ?? "openai-chat"}`
    ].join("\n"), "context"), { focus: false });
  }, [addEntry, pushInspector]);

  const selectedEntry = useMemo(() => (
    entries.find((entry) => entry.id === selectedEntryId) ?? null
  ), [entries, selectedEntryId]);

  const openMessageActions = useCallback((entry: TuiEntry | null | undefined, actionIndex: number = 0) => {
    if (!entry) {
      return false;
    }
    setSelectedEntryId(entry.id ?? null);
    setSelectedEntryHighlightUntil(0);
    setMessageActionIndex(Number(actionIndex) || 0);
    openCommandPanel(createMessageActionsPanel({ entry, actionIndex: Number(actionIndex) || 0 }));
    return true;
  }, [openCommandPanel]);

  const openMessageExcerpt = useCallback(async (entry: TuiEntry | null | undefined) => {
    if (!entry) {
      return false;
    }
    setSelectedEntryId(entry.id ?? null);
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
        updateEntryById(entry.id ?? "", { excerptBody: body });
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
        updateEntryById(entry.id ?? "", { excerptBody: body });
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

  const freezeAgentTaskExcerpt = useCallback(async (entry: TuiEntry | null | undefined = selectedEntry) => {
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
      setCommandPanel(createAgentTaskLivePanel({ task: task && typeof task === "object" ? task as Record<string, unknown> : null, entry: selectedEntry }));
      return;
    }
    setCommandPanel(commandPanel.kind === "message-excerpt"
      ? createMessageExcerptPanel({ entry: selectedEntry })
      : createMessageActionsPanel({
        entry: selectedEntry,
        actionIndex: messageActionIndex
      }));
  }, [commandPanel?.kind, commandPanel?.taskId, messageActionIndex, selectedEntry?.id, selectedEntry?.body, selectedEntry?.excerptBody, selectedEntry?.taskStatus, selectedEntry?.title, taskRecords]);

  const openAgentTaskLivePanel = useCallback(async (entry: TuiEntry) => {
    if (!entry?.taskId) {
      return false;
    }
    setSelectedEntryId(entry.id ?? null);
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

  const copyMessageText = useCallback((text: string, label: string) => {
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

  const truncateConversationToEntry = useCallback((entry: TuiEntry, options: Record<string, unknown> = {}) => {
    if (!entry || entry.kind !== "user" || !Number.isInteger(entry.checkpointMessagesLength)) {
      addEntry("session", "不能回退", "这条用户消息缺少 checkpoint，只能复制，不能回退或重生成。");
      return false;
    }
    if (stateRef.current.busy) {
      addEntry("session", "回退被阻止", "请先等待当前轮次结束或中断后再回退。");
      return false;
    }
    const checkpoint = Math.max(0, entry.checkpointMessagesLength ?? 0);
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

  const editFromMessage = useCallback((entry: TuiEntry) => {
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

  const regenerateFromMessage = useCallback((entry: TuiEntry) => {
    if (!truncateConversationToEntry(entry, { regenerate: true })) {
      return false;
    }
    addEntry("session", "重新生成", "已回退对话上下文，并从选中用户消息重新生成。文件系统改动不会自动回滚。");
    void runPromptDirectRef.current?.(String(entry.body ?? ""));
    return true;
  }, [addEntry, truncateConversationToEntry]);

  const hydrateEntryFromState = useCallback((entry: TuiEntry) => {
    if (!entry || entry.kind !== "agent" || entry.excerptBody) {
      return entry;
    }
    const task = stateRef.current.taskRecords?.find((item) => item.id === entry.taskId);
    return task
      ? { ...entry, excerptBody: formatAgentTaskExcerptBody(task, entry), task }
      : entry;
  }, []);

  const runMessageAction = useCallback((entry: TuiEntry | null | undefined, actionIndex: number = 0) => {
    const actions = messageActionsForEntry(entry);
    const index = Number(actionIndex);
    const validIndex = Number.isInteger(index) && index >= 0 && index < actions.length;
    const action = validIndex ? actions[index] : null;
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

  const selectTranscriptEntryAtMouse = useCallback((event: TuiRuntimeEvent, current: TuiUiState = stateRef.current) => {
    const entry = entryAtTranscriptMouseEvent(event, current);
    if (!entry) {
      debugTuiInput(props.env, `mouse_transcript_entry miss x=${event?.x ?? "?"} y=${event?.y ?? "?"}`);
      return false;
    }
    const now = Date.now();
    const last = lastTranscriptClickRef.current;
    const doubleClick = last.entryId === entry.id && now - last.at <= 420;
    debugTuiInput(props.env, `mouse_transcript_entry hit id=${entry.id} kind=${entry.kind} double=${doubleClick ? "1" : "0"}`);
    lastTranscriptClickRef.current = { entryId: entry.id ?? null, at: now };
    if (doubleClick) {
      if (entry.kind === "agent" && entry.taskId) {
        void openAgentTaskLivePanel(entry);
      } else {
        void openMessageExcerpt(entry);
      }
      return true;
    }
    setSelectedEntryId(entry.id ?? null);
    setSelectedEntryHighlightUntil(now + 1500);
    setMessageActionIndex(0);
    setActivity((value) => ({ ...value, status: "已指向消息块；双击进入摘录面板" }));
    return true;
  }, [openMessageExcerpt, props.env]);

  const handleTranscriptPointerEvent = useCallback((event: TuiRuntimeEvent, current: TuiUiState = stateRef.current) => {
    const kind = String(event?.kind ?? "");
    if (kind !== "press" && kind !== "drag" && kind !== "release") {
      return false;
    }
    if (!current.startupConfirmed || !current.trusted) {
      return false;
    }
    const hit = transcriptHitAtMouseEvent(event, current, { clamp: kind !== "press" });
    if (kind === "press") {
      if (!hit) {
        s.transcriptDragRef.current = null;
        s.setTranscriptSelection(null);
        return false;
      }
      s.transcriptDragRef.current = { x: Number(event.x), y: Number(event.y), lineIndex: hit.lineIndex };
      s.setTranscriptSelection({ startIndex: hit.lineIndex, endIndex: hit.lineIndex });
      return true;
    }
    const start = s.transcriptDragRef.current;
    if (!start) {
      return false;
    }
    const lineIndex = hit?.lineIndex ?? start.lineIndex;
    s.setTranscriptSelection(normalizeTranscriptSelection(start.lineIndex, lineIndex));
    if (kind === "drag") {
      return true;
    }
    s.transcriptDragRef.current = null;
    const range = normalizeTranscriptSelection(start.lineIndex, lineIndex);
    if (isMeaningfulTranscriptDrag(start, event, start.lineIndex, lineIndex)) {
      const text = formatVisibleTranscriptSelection(hit?.viewport.lines ?? [], range.startIndex, range.endIndex);
      if (text) {
        writeClipboardText(text, props.env);
        s.setActivity((value) => ({ ...value, status: "已复制选中文字" }));
      }
      setTimeout(() => s.setTranscriptSelection(null), 120);
      return true;
    }
    s.setTranscriptSelection(null);
    return selectTranscriptEntryAtMouse(event, current);
  }, [props.env, s, selectTranscriptEntryAtMouse]);

  const applyRawDraftOperations = useCallback((operations: Array<{ type?: string; text?: string }> = [], current: TuiUiState = stateRef.current) => {
    const actionable = operations.filter((operation) => operation.type !== "ignore");
    if (actionable.length === 0) {
      return true;
    }
    const updater = (draft: InputDraft) => actionable.reduce((next: InputDraft, operation: { type?: string; text?: string }) => {
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

  return {
    ...s,
    addEntry,
    updateEntryById,
    openCommandPanel,
    clearTransientEntrySelection,
    openLogsPanel,
    cyclePermissionMode,
    switchLogsPanelFilter,
    pushInspector,
    summarizeInfo,
    setQueueState,
    openQueuePanel,
    loadSessionRecords,
    readTaskRecords,
    loadTaskRecords,
    openSessionsPanel,
    openResumePanel,
    openResumeChunkPanel,
    clearContextNow,
    replaceSession,
    switchModel,
    selectedEntry,
    openMessageActions,
    openMessageExcerpt,
    freezeAgentTaskExcerpt,
    openAgentTaskLivePanel,
    copyMessageText,
    truncateConversationToEntry,
    editFromMessage,
    regenerateFromMessage,
    hydrateEntryFromState,
    runMessageAction,
    selectTranscriptEntryAtMouse,
    handleTranscriptPointerEvent,
    applyRawDraftOperations
  };
}
