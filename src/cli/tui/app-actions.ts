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
  GOAL_WRITE_TOOLS,
  shouldSkipTuiGoalQuestion,
  tuiGoalQuestionResult
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
import { useTuiAppPanels } from "./app-panels.ts";

export function useTuiAppActions(s: ReturnType<typeof useTuiAppPanels>) {
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
    handleTranscriptPointerEvent,
    applyRawDraftOperations
  } = s;
  useEffect(() => {
    const onRawInput = (chunk: unknown) => {
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
      const clickEvents = mouseClickEvents(chunkText);
      if (clickEvents.length > 0) {
        claimedInkInputRef.current = true;
        for (const clickEvent of clickEvents) {
          handleTranscriptPointerEvent(clickEvent, current);
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
  }, [applyMouseWheelScroll, applyRawDraftOperations, applyVisibleScroll, cyclePermissionMode, handleTranscriptPointerEvent, inputEvents, insertPastedText, markUserActivity, props.env]);

  const askApproval = useCallback((request: {
    toolName: string;
    input?: Record<string, unknown>;
    decision?: Record<string, unknown>;
    definition?: Record<string, unknown>;
  }) => {
    const approvalKey = approvalKeyFor(request);
    if (sessionApprovals.current.has(approvalKey)) {
      return true;
    }
    const definition = request.definition ?? {};
    const decision = request.decision ?? {};

    addEntry("approval", `${request.toolName} 审批`, [
      `risk=${definition.risk}`,
      `reason=${decision.reason ?? "需要审批"}`,
      decision.sensitive === true ? "sensitive=强确认；批准后相关内容可能进入模型上下文" : null,
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
      `risk: ${definition.risk}`,
      `reason: ${decision.reason ?? "需要审批"}`,
      decision.sensitive === true ? "sensitive: 强确认；批准后相关内容可能进入模型上下文" : null,
      "boundary: 本地客户端执行；没有远程工具服务器",
      `input: ${summarizeInput(request.toolName, request.input)}`
    ].filter(Boolean).join("\n"), "approval"), { focus: true });
    setMode("approval");
    setApprovalChoiceIndex(0);
    return new Promise((resolve: (allowed: boolean) => void) => {
      setPendingApproval({ resolve, approvalKey, toolName: request.toolName, request });
    });
  }, [addEntry, pushInspector]);

  const askUser = useCallback((request: Record<string, unknown>) => {
    if (shouldSkipTuiGoalQuestion(sessionRef.current)) {
      addEntry("goal", "已跳过需求核对", "Goal 模式无人值守，已跳过 ask_user。");
      return Promise.resolve(tuiGoalQuestionResult() as TuiQuestionAnswer);
    }
    const prompt = normalizeQuestionPrompt(request);
    const body = [
      prompt.question,
      prompt.choices.length > 0 ? `选项：${prompt.choices.map((choice) => choice?.label ?? "").filter(Boolean).join(" / ")}` : null,
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
    return new Promise<TuiQuestionAnswer>((resolve) => {
      setPendingQuestion({
        ...prompt,
        choices: prompt.choices.flatMap((choice) => choice ? [{
          label: choice.label,
          value: choice.value,
          description: choice.description,
          selected: choice.selected
        }] : []),
        resolve
      });
    });
  }, [addEntry, pushInspector, replaceQuestionDraft]);

  const interruptCurrentTurn = useCallback((stopReason: string) => {
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

  const guideActiveTurn = useCallback((guidance: string) => {
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

  const startBackgroundSubagent = useCallback((profileName: string, query: string) => {
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
      let result: SubagentResult | null = null;
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
          String(result?.outputSummary ?? result?.output ?? (result?.error instanceof Error ? result.error.message : result?.error && typeof result.error === "object" && "message" in result.error ? String(result.error.message) : "") ?? JSON.stringify(result, null, 2))
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

  const cancelBackgroundSubagent = useCallback(async (taskId: string) => {
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

  const addAgentTaskStartEntry = useCallback((event: TuiRuntimeEvent) => {
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

  const finishAgentTaskEntry = useCallback((event: TuiRuntimeEvent) => {
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

  const syncAgentTaskEntryFromRecord = useCallback((task: TuiTaskRecord, options: { status?: string; profile?: string; allowCreate?: boolean } = {}) => {
    const id = String(task?.id ?? "").trim();
    if (!id) {
      return;
    }
    const status = String(task.status ?? options.status ?? "unknown");
    const profile = String(task.profile ?? options.profile ?? "unknown");
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

  const refreshAgentTaskEntryFromRecord = useCallback(async (taskId: string, fallback: { status?: string; profile?: string } = {}) => {
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

  const handleBackgroundWakeup = useCallback((event: TuiRuntimeEvent) => {
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

  const onSessionEvent = useCallback((event: TuiRuntimeEvent) => {
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
        round: event.round ?? current.round,
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
        round: event.round ?? current.round,
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
        stopReason: event.stopReason ?? current.stopReason ?? null
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
      const names = (event.toolCalls ?? []).map((call) => `${call.name}(${(call.inputKeys ?? []).join(",") || "no input"})`).join("\n");
      addEntry("tools", "requested", names || "no tools");
    } else if (event.type === "tool_start") {
      flushStreamDeltasNow();
      setStream((current) => updateRuntimeTool(current, event, "running"));
      if (event.name === "agent_run") {
        addAgentTaskStartEntry(event);
      } else {
        addEntry("tool", event.name ?? "tool", `running id=${event.toolCallId}, inputKeys=${(event.inputKeys ?? []).join(",") || "none"}`);
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
      if (sessionRef.current.goal?.enabled && GOAL_WRITE_TOOLS.has(String(event.name ?? ""))) {
        sessionRef.current.goal.hasWrites = true;
      }
      pushInspector(makeInspector(`Tool ${state}`, event.name ?? "tool", body, "tool"), {
        focus: Boolean(event.blocked || !event.ok)
      });
      if (event.ok && (event.name === "todo_write" || event.name === "plan_update")) {
        setSideView("workflow");
        setSideOffset(0);
        setActivity((current) => ({
          ...current,
          status: event.name === "todo_write" ? "待办已更新" : "计划已更新",
          lastTool: event.name ?? current.lastTool
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
      addEntry("assistant", "assistant", event.text ?? "", thinking
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
      lastTurnStatusRef.current = "interrupted";
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
        ...(Array.isArray(event.reasons) ? event.reasons.map((reason: string) => `- ${reason}`) : [])
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
    } else if (event.type === "context_overflow") {
      flushStreamDeltasNow();
      setStreamOffset(0);
      setStream(initialStream());
      const body = `压缩历史和工具结果后仍超过上下文窗口（约 ${event.promptTokensEstimate ?? "未知"} tokens，上限 ${event.maxTokens ?? "未知"}）。已取消本轮请求，避免网关返回 400。`;
      addEntry("error", "上下文超出窗口", body);
      pushInspector(makeInspector("上下文超出窗口", "session", body, "context"), { focus: true });
    } else if (event.type === "turn_complete") {
      lastTurnStatusRef.current = String(event.status ?? "completed");
      flushStreamDeltasNow();
      if (event.status !== "completed") {
        setStreamOffset(0);
        setStream(initialStream());
        addEntry("turn", event.status ?? "turn", `outputBytes=${event.outputBytes}`);
      }
    }
  }, [addAgentTaskStartEntry, addEntry, finishAgentTaskEntry, flushStreamDeltasNow, handleBackgroundWakeup, loadTaskRecords, pushInspector, refreshAgentTaskEntryFromRecord, scheduleStreamFlush, setStreamOffset, setTranscriptOffset]);

  const onAntEvent = useCallback((event: TuiRuntimeEvent) => {
    activityEventCountRef.current += 1;
    if (HIGH_FREQUENCY_ANT_EVENTS.has(event?.type ?? "")) {
      return;
    }
    setAntState((current) => reduceAntEvent(current as Record<string, unknown>, event as Record<string, unknown>) as AntEventState);
    const eventCount = activityEventCountRef.current;
    setActivity((current) => ({
      ...current,
      eventCount
    }));
  }, []);

  return {
    ...s,
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
  };
}
