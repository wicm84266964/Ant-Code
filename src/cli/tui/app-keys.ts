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
import { useTuiAppTurn } from "./app-turn.ts";

export function useTuiAppKeys(s: ReturnType<typeof useTuiAppTurn>) {
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
            const result = await store.cleanupExpiredSessions(
              sessionRef.current.config.transcript?.retentionDays === undefined
                ? 30
                : sessionRef.current.config.transcript.retentionDays
            );
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
          const selected = chunks[current.commandPanel?.selectedIndex ?? 0];
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
      if ((key.leftArrow || key.rightArrow || key.tab) && (current.commandPanel.tabs?.length ?? 0) > 0) {
        const direction = key.leftArrow ? -1 : 1;
        const tabCount = current.commandPanel.tabs?.length ?? 0;
        const nextTabIndex = ((current.commandPanel.tabIndex ?? 0) + tabCount + direction) % tabCount;
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
        setActivity((value) => ({ ...value, status: `任务分类：${WORKFLOW_FILTER_LABELS[next as keyof typeof WORKFLOW_FILTER_LABELS] ?? next}` }));
        return;
      }
      if (current.sideView === "tasks") {
        const next = nextFilter(current.taskFilter, TASK_FILTERS, direction);
        setTaskFilter(next);
        setSideOffset(0);
        setActivity((value) => ({ ...value, status: `子智能体分类：${TASK_FILTER_LABELS[next as keyof typeof TASK_FILTER_LABELS] ?? next}` }));
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
        setSlashPaletteIndex((value) => movePaletteIndex(current.slashPalette?.commands ?? [], value, -1));
        return;
      }
      if (key.downArrow) {
        setSlashPaletteIndex((value) => movePaletteIndex(current.slashPalette?.commands ?? [], value, 1));
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

  return s;
}
