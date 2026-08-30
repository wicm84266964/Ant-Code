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
import {
  executeTuiGoalCommand,
  finishTuiGoalTurn
} from "./goal.ts";
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
import { useTuiAppActions } from "./app-actions.ts";

export function useTuiAppTurn(s: ReturnType<typeof useTuiAppActions>) {
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
    onAntEvent
  } = s;
  const handlePrompt = useCallback(async (prompt: string, signal?: AbortSignal, turn: { kind?: string; displayPrompt?: string } = {}) => {
    const runSessionTurnWithGoal = async (turnPrompt: string, turnOptions: { displayPrompt?: string } = {}) => {
      lastTurnStatusRef.current = "completed";
      const result = await runSessionTurn(sessionRef.current, {
        prompt: turnPrompt,
        displayPrompt: turnOptions.displayPrompt,
        env: props.env,
        signal,
        approvalCallback: askApproval,
        userInputCallback: async (request) => {
          const answer = await askUser(request);
          return answer as Record<string, unknown>;
        },
        onEvent: onSessionEvent,
        onAntEvent,
        hooksTrusted: trusted
      });
      const terminalStatus = signal?.aborted || lastTurnStatusRef.current === "interrupted"
        ? "interrupted"
        : lastTurnStatusRef.current;
      const goalResult = await finishTuiGoalTurn({
        session: sessionRef.current,
        terminalStatus,
        output: result?.output,
        env: props.env,
        hasQueuedWork: queuedPromptsRef.current.length > 0,
        pendingQuestion: Boolean(stateRef.current.pendingQuestion),
        pendingApproval: Boolean(stateRef.current.pendingApproval)
      });
      if (goalResult.recap) {
        const recap = goalResult.recap;
        addEntry("goal", recap.title, recap.body);
        setActivity((value) => ({ ...value, status: recap.title }));
      }
      if (goalResult.continue) {
        pendingGoalContinueRef.current = {
          prompt: goalResult.prompt,
          displayPrompt: goalResult.displayPrompt,
          kind: "goal-continue"
        };
      }
      return result;
    };

    if (turn.kind === "goal-continue") {
      addEntry("goal", "Goal 续跑", turn.displayPrompt || "继续");
      await runSessionTurnWithGoal(prompt, { displayPrompt: turn.displayPrompt });
      return;
    }

    if (prompt.trimStart().startsWith("!")) {
      const shellText = prompt.trimStart().slice(1).trim();
      if (!shellText) {
        addEntry("output", "! shell", "用法：!<本地命令>");
        return;
      }
      const shellCommand = parseSlashCommand(`/run ${shellText}`);
      if (!shellCommand) {
        return;
      }
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
        sessionInfo: summarizeInfo() as unknown as AgentSession,
        approvalCallback: askApproval,
        signal,
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
        const filter = (INSPECTOR_FILTERS as readonly string[]).includes(requestedFilter)
          ? requestedFilter as (typeof INSPECTOR_FILTERS)[number]
          : "all";
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
      if (lowerName === "goal") {
        const modelBusy = Boolean(currentTurnAbortRef.current) && currentTurnPromptRef.current !== String(prompt ?? "");
        const result = await executeTuiGoalCommand({
          session: sessionRef.current,
          args: slashCommand.args,
          env: props.env,
          busy: modelBusy
        });
        addEntry(result.ok ? "goal" : "error", "/goal", result.message);
        if (result.permissionMode) {
          setPermissionMode(result.permissionMode);
        }
        setActivity((value) => ({ ...value, status: result.ok ? "Goal" : "Goal 未执行" }));
        if (result.interrupt) {
          interruptCurrentTurn("goal-command");
        }
        if (result.startTurn) {
          addEntry("user", "你", result.startTurn, {
            checkpointMessagesLength: sessionRef.current.messages.length,
            turnIndex: sessionRef.current.turnCount + 1
          });
          await runSessionTurnWithGoal(result.startTurn);
        } else if (result.continueTurn?.prompt) {
          addEntry("goal", "Goal 续跑", result.continueTurn.displayPrompt || "继续");
          await runSessionTurnWithGoal(result.continueTurn.prompt, {
            displayPrompt: result.continueTurn.displayPrompt
          });
        }
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
        sessionInfo: summarizeInfo() as unknown as AgentSession,
        approvalCallback: askApproval,
        setModelCallback: switchModel,
        signal,
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
    await runSessionTurnWithGoal(prompt);
  }, [activity, addEntry, askApproval, askUser, cancelBackgroundSubagent, clearContextNow, guideActiveTurn, interruptCurrentTurn, loadTaskRecords, modelOptions, onAntEvent, onSessionEvent, openCommandPanel, openLogsPanel, openQueuePanel, openResumeChunkPanel, openResumePanel, openSessionsPanel, props.cwd, props.env, pushInspector, replaceSession, startBackgroundSubagent, summarizeInfo, switchModel, trusted]);

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

  const queuePrompt = useCallback((prompt: string) => {
    const nextPrompts = [...queuedPromptsRef.current, prompt].slice(-20);
    setQueueState(nextPrompts, nextPrompts.length - 1);
    addEntry("queue", "提示已排队", prompt);
  }, [addEntry, setQueueState]);

  const runPromptDirect = useCallback(async function runPromptDirect(prompt: TuiRunPromptInput) {
    const item = prompt && typeof prompt === "object"
      ? prompt
      : { prompt: String(prompt ?? ""), kind: "prompt" };
    setBusy(true);
    const controller = new AbortController();
    currentTurnAbortRef.current = controller;
    currentTurnPromptRef.current = String(item.prompt ?? "");
    try {
      await handlePrompt(item.prompt ?? "", controller.signal, item);
    } catch (error) {
      addEntry("error", "运行时错误", error instanceof Error ? error.message : String(error));
      const code = (error as { code?: string } | null)?.code;
      const persistMissing = code === "SESSION_NOT_FOUND" || code === "SESSION_METADATA_NOT_FOUND";
      lastTurnStatusRef.current = persistMissing ? lastTurnStatusRef.current : "failed";
      if (sessionRef.current.goal?.enabled && !persistMissing) {
        try {
          await finishTuiGoalTurn({
            session: sessionRef.current,
            terminalStatus: "failed",
            output: error instanceof Error ? error.message : String(error),
            env: props.env,
            hasQueuedWork: queuedPromptsRef.current.length > 0
          });
        } catch {
          // Goal persist must not take down the TUI.
        }
      }
    } finally {
      if (currentTurnAbortRef.current === controller) {
        currentTurnAbortRef.current = null;
        currentTurnPromptRef.current = "";
        pendingGuideInterruptRef.current = null;
      }
      const [nextPrompt, ...rest] = queuedPromptsRef.current;
      setQueueState(rest, 0);
      if (nextPrompt) {
        pendingGoalContinueRef.current = null;
        addEntry("queue", "正在运行排队提示", nextPrompt);
        void runPromptDirect(nextPrompt);
      } else {
        const goalNext = pendingGoalContinueRef.current;
        pendingGoalContinueRef.current = null;
        if (goalNext?.prompt) {
          void runPromptDirect(goalNext);
        } else {
          setBusy(false);
        }
      }
    }
  }, [addEntry, handlePrompt, props.env, setQueueState]);

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

  const setBackgroundExitPendingValue = useCallback((value: unknown) => {
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

  const forceExitTui = useCallback((reason: string) => {
    const current = stateRef.current;
    current.pendingApproval?.resolve?.(false);
    current.pendingQuestion?.resolve?.({ answer: "", selectedChoice: null });
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
    stateRef.current.pendingApproval?.resolve?.(false);
    stateRef.current.pendingQuestion?.resolve?.({ answer: "", selectedChoice: null });
    interruptCurrentTurn("exit");
    exit();
  }, [exit, forceExitTui, interruptCurrentTurn, requestBackgroundExit, runningBackgroundCount]);

  const submitInput = useCallback(async (overridePrompt: unknown = null) => {
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

  const closeTopPopover = useCallback((current: TuiUiState, reason: string = "closed") => {
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

  const requestTurnInterrupt = useCallback((reason: string) => {
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

  const handleCtrlCExit = useCallback((current: TuiUiState) => {
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
      current.pendingApproval?.resolve?.(false);
      current.pendingQuestion?.resolve?.({ answer: "", selectedChoice: null });
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

  return {
    ...s,
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
  };
}
