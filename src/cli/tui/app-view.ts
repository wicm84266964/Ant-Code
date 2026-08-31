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

const h = React.createElement;
import { useTuiAppKeys } from "./app-keys.ts";

export function renderTuiAppView(s: ReturnType<typeof useTuiAppKeys>) {
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
    transcriptSelection,
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
    modelOptions,
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
    applyRawDraftOperations,
    askApproval,
    askUser,
    interruptCurrentTurn,
    interruptPendingGuideAtGatewayBoundary,
    guideActiveTurn,
    startBackgroundSubagent,
    cancelBackgroundSubagent,
    addAgentTaskStartEntry,
    finishAgentTaskEntry,
    syncAgentTaskEntryFromRecord,
    refreshAgentTaskEntryFromRecord,
    handleBackgroundWakeup,
    onSessionEvent,
    onAntEvent,
    handlePrompt,
    confirmTrust,
    queuePrompt,
    runPromptDirect,
    runningBackgroundCount,
    setBackgroundExitPendingValue,
    requestBackgroundExit,
    forceExitTui,
    requestExit,
    submitInput,
    closeTopPopover,
    requestTurnInterrupt,
    handleEscInterrupt,
    handleCtrlCExit,
    toggleTranscriptDetail
  } = s;
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
        transcriptSelection,
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
