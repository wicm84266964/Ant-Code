import { renderMarkdown } from "./markdown.ts";
import { hydrateRichContent } from "./rich-renderers.ts";
import { visibleTranscriptRole } from "./transcript.ts";
import { MANUAL_AGENT_MODEL_VALUE, state, els, MODE_DESCRIPTIONS, LOCAL_FILE_EXTENSIONS, FILE_REFERENCE_PATTERN, TRANSCRIPT_DOM_LIMIT, EVENT_STALE_AFTER_MS, EVENT_CONNECT_TIMEOUT_MS, EVENT_RECONNECT_MAX_ATTEMPTS, DASHBOARD_REQUEST_TIMEOUT_MS, DASHBOARD_API_VERSION, DASHBOARD_LIFECYCLE_TIMEOUT_MS, DASHBOARD_SHUTDOWN_TIMEOUT_MS, DASHBOARD_INTERRUPT_TIMEOUT_MS, MAX_IMAGE_ATTACHMENTS, MAX_IMAGE_ATTACHMENT_BYTES, CURRENT_SESSION_STORAGE_KEY, DASHBOARD_CLIENT_STORAGE_KEY, PREVIEW_WIDTH_STORAGE_KEY, PREVIEW_WIDTH_DEFAULT, PREVIEW_WIDTH_MIN, PREVIEW_WIDTH_MAX, PREVIEW_WORKSPACE_MIN , emptySessionStatus, emptyBackgroundSubagent } from "./app-core.ts";
import type { DashboardConfigSource, DashboardReasoningEffort, DashboardTurnChangeStats, DashboardScopedDefaultSelection, DashboardVisionAgent, DashboardReasoningDiscovery, DashboardReasoningCapabilityCandidate, DashboardGatewayProbeModel, DashboardGatewayProbeResult, DashboardLifecycleActivity, DashboardSettings, DashboardFile, DashboardTableSheet, DashboardTablePreview, DashboardLightboxItem, DashboardQuestionChoice, DashboardPendingQuestion, DashboardApproval, DashboardGatewayTransport, DashboardScopedRequest, DashboardFetchOptions, DashboardModelSource, DashboardSessionStatus, DashboardApiResult, DashboardActivity, DashboardModelOption, DashboardGatewayProfile, DashboardGatewayConfig, DashboardModelSelection, DashboardPendingGuide, DashboardStreamEvent, DashboardUiState , DashboardSessionSummary } from "./app-core.ts";
import { eventTargetOf, eventElement, isPlainObject, modelSourceOf, errorMessageOf, init, bootstrapDashboard, observeRunStatus, updateRunStatusTone, bindEvents, normalizedResponsiveView, composerHeightFor, previewWidthBounds, clampedPreviewWidth, permissionIndexForKey, focusTrapTarget, shouldFollowTranscript, scheduleAnimationFrameOnce, cancelScheduledAnimationFrame, appendPlainDraftDelta, renderFinalAssistantBody, selectTranscriptNodesToRemove, responsiveLayoutMode, restorePreviewWidth, setPreviewWidth, syncPreviewResizeHandle, beginPreviewResize, updatePreviewResize, finishPreviewResize, handlePreviewResizeKeydown, setResponsiveView, syncResponsiveNavigation, setResponsiveSurfaceInert, handleResponsiveFileNavigation, syncVisualViewport, resizePromptInput, handlePermissionModeKeydown, requestPermissionMode, defaultGoalMaxAutoContinues, emptyGoalSnapshot, applyGoalSnapshot, renderGoalControls, renderGoalStatusBar, requestGoalMode, showGoalConfirm, hideGoalConfirm, showGoalTextPanel, hideGoalTextPanel, enableGoalWithObjective, submitGoalAction, adoptGoalRunResult, showPermissionConfirm, hidePermissionConfirm, updateContextActions, announceStatus, modalFocusableElements, activateModal, collectModalBackground, focusModalInitialTarget, deactivateModal, restoreModalAttribute, handleGlobalKeydown, closeActiveModal, loadTrust, loadSessions, restoreInitialSession, latestBackgroundSessionId, initialSessionId, rememberCurrentSession, renderSessions, sessionMeta, sessionStatusView, toggleSidebar, setSidebarCollapsed, sessionsNeedRefresh, scheduleSessionsRefresh, handleSessionAction, openSession, restoreBackgroundSnapshot, deleteSession, setSessionsRefreshState, copySessionId, newTask, rememberNewTaskModelState, restoreNewTaskModelState, refreshNewTaskModelState, addAttachmentFiles, readImageAttachment, renderAttachmentStrip, attachmentPayload, clearAttachments, sendPrompt, stableTurnRequest, dashboardRequestId, dashboardClientId, statusUrl, interruptTurn, guideTurn, cancelQueuedTurn, renderTranscriptWindowMarker, captureTranscriptViewportAnchor, restoreTranscriptViewportAnchor, transcriptNodeTop, restoreTranscriptNodeAnchor, resetTranscriptWindow, appendAssistantDraft, scheduleDraftRender, renderAssistantDraft, appendActivity, appendContextBoundary, contextBoundaryText, handleActivity, isBackgroundSubagentActivity, handleBackgroundSubagentActivity, clearBackgroundSubagentStatus, reconcileBackgroundSubagentSnapshot, backgroundSubagentDisplayStatus, backgroundSubagentVisible, updateLiveActivity, removeLiveActivity, setLiveTitle, toggleLiveStatusDetails, updateLiveStatus, liveStatusTitle, primaryLiveActivity, gatewayRetryChipText, renderBackgroundSubagentStatus, backgroundSubagentCompactLabel, backgroundSubagentTitle, backgroundSubagentMeta, backgroundSubagentCancellable, resetLiveStatus, backgroundSubagentCounts, idleRunStatus, applyIdleRunStatus, updateRunStatusForBackground, updateSessionStatus, updateTurnChangeStats, resetTurnChangeStats, normalizeChangeStats, renderComposerStatus, modelStatusHtml, unresolvedModelStatusHtml, handleModelStatusActivate, handleModelStatusKeydown, toggleModelPanel, hideModelPanel, showSettingsWorkspace, refreshSettingsConfiguration, hideSettingsWorkspace, showModelConfigPanel, hideModelConfigPanel, renderModelPanel, modelCapabilityLabels, handleModelPanelClick, handleModelPanelChange, renderSettingsView, syncSettingsRail, modelSettingsHtml, transcriptSettingsHtml, transcriptRetentionOptionsHtml, networkSettingsHtml, networkModeOptionHtml, agentSettingsHtml, reliabilitySettingsHtml, settingsSectionHeading, settingsToggleHtml, managedFieldHtml, settingsDisabled, settingsFormActions, settingsFeedbackHtml, settingsGatewayProfileHtml, gatewayProfileReadonlyLabel, providerModelKey, scopedDefaultModelLabel, settingsModelHtml, handleSettingsRailClick, initializeSettingsFormTracking, handleSettingsFormChange, settingsControlValue, changedSettingsFields, canonicalSettingsField, setSettingsFormSaving, renderSettingsFeedbackInPlace, saveSettingsConfig, handleSettingsClick, protocolDisplayName, agentModelPickerHtml, renderModelConfigPanel, handleModelConfigPanelClick, handleModelConfigInput, handleModelConfigChange, markModelConfigCredentialChanged, markModelConfigEndpointChanged, handleModelConfigModelIdChanged, markReasoningCapabilityManual, clearReasoningCapabilityControls, syncGatewayUrlHint, gatewayUrlPlaceholder, gatewayUrlHint, syncReasoningDefaultOptions, probeGateway, isCurrentModelConfigRequest, currentGatewayProbeResult, currentGatewayCatalogModels, modelConfigGatewayProfile, modelConfigEndpointChanged, modelConfigAgentModelsSnapshot, initializeAgentModelPickerSnapshot, syncAgentModelPickersForEndpoint, uniqueAgentModelCandidates, appendAgentModelOptions, renderAgentModelPickers, updateAgentModelPickerManualStatus, handleAgentModelSelection, renderGatewayProbeResult, applyProbedModel, applyGatewayDiscoveredModel, applySuggestedGatewayUrl, gatewayCredentialAction, normalizeGatewayProbeModels, normalizeReasoningDiscovery, reasoningCapabilityCandidate, applyReasoningCapabilityCandidate, ensureReasoningEffortOptions, applyPendingReasoningCapabilities, reasoningCapabilityIsActionable, renderReasoningCapabilityStatus, reasoningCapabilityStatusText, reasoningDiscoveryStatusText, probeModelCapabilities, setFormControlsSaving, setModelConfigFormSaving, renderModelConfigFailure, clearModelConfigFailure, manualAgentModelIds, saveModelConfig, saveDefaultModelSelection, switchModel, handleReasoningEffortChange, switchReasoningEffort, deleteGatewayProfile, deleteModel, updateConfigRevisions, normalizeScopedDefaultSelection, configScope, configMutationMetadata, isConfigRevisionConflict, configRevisionConflictMessage, refreshConfigRevisionsAfterConflict, normalizeGatewayConfig, normalizeDashboardSettings, mergeGatewayConfig, normalizeGatewayProfiles, normalizeConfigSource, normalizeModels, normalizeModelSource, normalizeReasoningEfforts, normalizedReasoningEffort, isDisabledReasoningEffort, configuredReasoningEffort, reasoningEffortFallbackLabel, localizedReasoningEffortLabel, reasoningEffortCatalog, reasoningEffortLabel, resolveAtomicModelSelection, currentModelSelection, currentSessionNeedsModelSelection, currentGatewayProfile, gatewayProfileById, settingsInspectedGatewayProfile, modelSourceLabel, markCurrentModel, currentModelInfo, modelDisplayName, normalizeAgentModelTiers, normalizeVisionAgent, firstVisionModelId, hasAgentModelTiers, agentModelTiersSummary, gatewaySummary, modelSaveTargetLabel, gatewaySourceNote, environmentGatewayDefaultNote, sourceBadge, sourceLabel, formatContextUsage, firstFiniteNumber, formatTokenCount, trimNumber, nonNegativeInteger, collapseCompletedActivities, clearAssistantDrafts, collapseAssistantDrafts, isMeaningfulCompletedActivity, isDuplicateDraftText, normalizeComparableText, showApproval, resolveApproval, hideApproval, showQuestion, revealInteractionPanel, renderQuestionPanel, reviewQuestionConversation, returnToQuestion, activateQuestionReviewBackground, deactivateQuestionReviewBackground, questionChoiceButton, toggleQuestionChoice, submitQuestion, cancelQuestion, finishQuestionSubmission, hideQuestion, showTrustPanel, renderTrustPanel, confirmTrust, renderQueuePanel, renderQueueItem, setPendingGuide, clearPendingGuide, syncPendingGuideFromQueue, renderGuideFeedback, guideCopy, guideSource, guideTurnFromQueue, guideButtonText, guideButtonDisabled, guideButtonVisible, syncGuideButton, shouldKeepGuideFeedback, isInterruptError, updateSendButton, showContextConfirm, hideContextConfirm, runContextAction, contextActionRequestOptions, contextSummaryLine, compactResultLine, rememberQuestionDraft, questionResolutionText, showShutdownPanel, hideShutdownPanel, shutdownDashboard, lockClosedDashboard, normalizeLifecycleActivity, shutdownRequestBody, shutdownResultIsClosed, lifecycleActivitySummary, renderShutdownActivity, renderFiles, currentImageFiles, openFile, renderOfficePreview, officePreviewMeta, officePreviewBodyHtml, renderTablePreview, normalizeTablePreview, tablePreviewMeta, renderCompactTableHtml, renderExpandedTableHtml, renderTableHtml, tableTruncationNote, maxVisibleColumns, columnLabel, renderSheetPreviewHtml, renderSheetCellHtml, resetPreview, fencedDataForFile, dataLanguageForExtension, showImageLightbox, showTableLightbox, renderLightboxImage, bindTableLightboxControls, moveLightbox, hideLightbox, setPermissionMode, clearTranscript, cancelTranscriptAnimationFrames, clearAssistantDraftTimers, hideEmptyState, showError, showNotice, renderBootstrapLoading, renderBootstrapFailure, dashboardPayloadError, bootstrapFailurePresentation, clearBootstrapStatus, scrollTranscript, isTranscriptNearBottom, syncTranscriptFollowState, followTranscript, updateTranscriptJump, beginScopedRequest, isCurrentScopedRequest, finishScopedRequest, cancelScopedRequest, isAbortError, getJson, postJson, deleteJson, dashboardFetch, responseJson, dashboardJsonHeaders, dashboardCsrfToken, messageText, messageDisplayText, userMessageDisplayText, userTranscriptDisplayText, transcriptMessageAttachments, normalizeAttachmentMetadata, imageAttachmentLine, renderMessageText, renderLinkedText, bindRichContent, linkifyFileTextNodes, replaceFileReferences, isLikelyLocalFileReference, resolveDisplayFilePath, normalizeFileReferencePath, parentDirectory, filePreviewUrl, rawFileUrl, apiFileUrl, imagePreviewUrl, isSafeInlineBitmapUrl, normalizeRelativePath, isWorkspaceRelativeToBase, copyCodeBlock, previewText, formatNumber, formatBytes, escapeHtml, escapeAttribute, formatTime, formatRelativeTime } from "./app-barrel.ts";
export async function cancelBackgroundSubagent(groupId: unknown, taskId: unknown) {
  const key = backgroundCancelKey(groupId, taskId);
  if (!state.currentSessionId || !key || state.backgroundCancelling.has(key)) {
    return;
  }
  state.backgroundCancelling.add(key);
  updateLiveStatus();
  const item = Array.from(state.backgroundSubagents.values()).find((value) => (
    (groupId && value.groupId === groupId) || (taskId && value.taskId === taskId)
  ));
  const endpoint = item?.kind === "terminal" ? "/api/background-terminals/cancel" : "/api/background-subagents/cancel";
  const result = await postJson(endpoint, {
    sessionId: state.currentSessionId,
    groupId,
    taskId
  }).catch((error: unknown): DashboardApiResult => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  state.backgroundCancelling.delete(key);
  if (!result.ok) {
    showError(result.error ?? "回收子智能体失败");
    updateLiveStatus();
    return;
  }
  updateSessionStatus(result.sessionStatus);
  for (const [itemKey, item] of state.backgroundSubagents.entries()) {
    if ((groupId && item.groupId === groupId) || (taskId && item.taskId === taskId)) {
      state.backgroundSubagents.set(itemKey, {
        ...item,
        summary: item.kind === "terminal" ? "已请求回收后台终端任务，等待状态刷新" : "已请求回收后台子智能体，等待状态刷新",
        status: "stale"
      });
    }
  }
  updateLiveStatus();
  applyIdleRunStatus("空闲");
}

export function backgroundCancelKey(groupId: unknown, taskId: unknown) {
  const group = String(groupId ?? "").trim();
  const task = String(taskId ?? "").trim();
  return group || task ? `${group || "-"}:${task || "-"}` : "";
}

export function connectEvents(sessionId: string) {
  clearEventReconnectTimer();
  closeEventSource();
  state.eventSourceSessionId = sessionId;
  setConnectionState(state.eventReconnectAttempt > 0 ? "reconnecting" : "connecting");
  const params = new URLSearchParams({ sessionId });
  if (state.lastEventSequence > 0) {
    params.set("after", String(state.lastEventSequence));
  }
  let source;
  try {
    source = new EventSource(`/api/events?${params.toString()}`, { withCredentials: true });
  } catch {
    scheduleEventReconnect(sessionId);
    return;
  }
  state.eventSource = source;
  armEventConnectTimer(source, sessionId);
  source.addEventListener("open", () => {
    if (state.eventSource !== source) return;
    clearEventConnectTimer();
    markEventConnectionAlive(false);
    setConnectionState("connected");
  });
  source.addEventListener("heartbeat", () => {
    if (state.eventSource === source) {
      markEventConnectionAlive(true);
    }
  });
  source.addEventListener("dashboard", (event: MessageEvent<string>) => {
    if (state.eventSource !== source || state.eventSourceSessionId !== sessionId) return;
    let payload: DashboardStreamEvent;
    try {
      payload = JSON.parse(event.data) as DashboardStreamEvent;
    } catch {
      setConnectionState("stale");
      return;
    }
    markEventConnectionAlive(true);
    if (shouldSkipDashboardEvent(payload)) {
      return;
    }
    rememberEventCursor(payload.sequence);
    handleDashboardEvent(payload);
  });
  source.addEventListener("error", () => {
    if (state.eventSource !== source) return;
    clearEventConnectTimer();
    source.close();
    state.eventSource = null;
    clearEventStaleTimer();
    if (navigator.onLine === false) {
      setConnectionState("offline");
      return;
    }
    scheduleEventReconnect(sessionId);
  });
}

export function ensureEventsConnected(sessionId: string) {
  if (state.eventSource && state.eventSourceSessionId === sessionId) {
    return;
  }
  connectEvents(sessionId);
}

export function disconnectEvents() {
  clearEventReconnectTimer();
  clearEventConnectTimer();
  clearEventStaleTimer();
  closeEventSource();
  state.eventSourceSessionId = null;
  state.eventReconnectAttempt = 0;
  state.lastEventAt = 0;
  setConnectionState("idle");
}

export function closeEventSource() {
  clearEventConnectTimer();
  clearEventStaleTimer();
  state.eventSource?.close();
  state.eventSource = null;
}

export function markEventConnectionAlive(stable: unknown = true) {
  if (stable) {
    state.eventReconnectAttempt = 0;
  }
  state.lastEventAt = Date.now();
  clearEventConnectTimer();
  if (["connecting", "stale", "reconnecting"].includes(state.connectionState)) {
    setConnectionState("connected");
  }
  clearEventStaleTimer();
  const sessionId = state.eventSourceSessionId;
  armEventStaleTimer(sessionId, EVENT_STALE_AFTER_MS);
}

/** @param {EventSource} source @param {string} sessionId */
export function armEventConnectTimer(source: EventSource, sessionId: string) {
  clearEventConnectTimer();
  state.eventConnectTimer = setTimeout(() => {
    state.eventConnectTimer = null;
    if (state.eventSource !== source || state.eventSourceSessionId !== sessionId) return;
    source.close();
    state.eventSource = null;
    clearEventStaleTimer();
    if (navigator.onLine === false) {
      setConnectionState("offline");
      return;
    }
    setConnectionState("stale");
    scheduleEventReconnect(sessionId);
  }, EVENT_CONNECT_TIMEOUT_MS);
}

export function armEventStaleTimer(sessionId: string | null, delay: unknown) {
  state.eventStaleTimer = setTimeout(() => {
    if (!sessionId || state.eventSourceSessionId !== sessionId) return;
    const remaining = EVENT_STALE_AFTER_MS - (Date.now() - state.lastEventAt);
    if (remaining > 0) {
      armEventStaleTimer(sessionId, remaining);
      return;
    }
    setConnectionState("stale");
    closeEventSource();
    scheduleEventReconnect(sessionId);
  }, Math.max(1, Number(delay) || 1));
}

export function scheduleEventReconnect(sessionId: string) {
  if (!sessionId || state.currentSessionId !== sessionId) return;
  clearEventReconnectTimer();
  state.eventReconnectAttempt += 1;
  if (state.eventReconnectAttempt > EVENT_RECONNECT_MAX_ATTEMPTS) {
    setConnectionState("offline");
    return;
  }
  setConnectionState("reconnecting");
  const delay = Math.min(15_000, 500 * (2 ** (state.eventReconnectAttempt - 1)));
  state.eventReconnectTimer = setTimeout(() => {
    state.eventReconnectTimer = null;
    if (state.currentSessionId === sessionId && navigator.onLine !== false) {
      connectEvents(sessionId);
    }
  }, delay);
}

export function reconnectEventsManually() {
  clearEventReconnectTimer();
  state.eventReconnectAttempt = 0;
  if (!state.currentSessionId) {
    bootstrapDashboard();
    return;
  }
  connectEvents(state.currentSessionId);
}

export function clearEventReconnectTimer() {
  if (state.eventReconnectTimer) {
    clearTimeout(state.eventReconnectTimer);
    state.eventReconnectTimer = null;
  }
}

export function clearEventConnectTimer() {
  if (state.eventConnectTimer) {
    clearTimeout(state.eventConnectTimer);
    state.eventConnectTimer = null;
  }
}

export function clearEventStaleTimer() {
  if (state.eventStaleTimer) {
    clearTimeout(state.eventStaleTimer);
    state.eventStaleTimer = null;
  }
}

export function setConnectionState(next: string) {
  const previous = state.connectionState;
  state.connectionState = next;
  if (!els.connectionStatus) return;
  const labels: Record<string, string> = {
    idle: "本地网关未连接",
    connecting: "本地网关连接中",
    connected: "本地网关已连接",
    reconnecting: `本地网关重连 ${Math.max(1, state.eventReconnectAttempt)}/${EVENT_RECONNECT_MAX_ATTEMPTS}`,
    offline: "本地网关离线",
    unavailable: "本地网关未连接",
    error: "本地网关异常",
    stale: "本地网关连接过期"
  };
  const label = labels[next] ?? labels.idle;
  els.connectionStatus.dataset.state = next;
  els.connectionStatus.title = `仅此电脑可打开，文件访问按当前权限执行。${label}。点击重新连接`;
  els.connectionStatus.setAttribute("aria-label", `${label}，点击重新连接`);
  const text = els.connectionStatus.querySelector(".connection-label");
  if (text) text.textContent = label;
  if (next !== previous && ["offline", "unavailable", "error", "reconnecting", "stale"].includes(next)) {
    announceStatus(label);
  } else if (next === "connected" && ["offline", "unavailable", "error", "reconnecting", "stale"].includes(previous)) {
    announceStatus("本地网关已重新连接");
  }
}

export function resetEventReplayState() {
  state.lastEventSequence = 0;
  state.processedEventIds.clear();
}

export function rememberEventCursor(value: unknown) {
  const sequence = Number(value);
  if (Number.isInteger(sequence) && sequence > state.lastEventSequence) {
    state.lastEventSequence = sequence;
  }
}

export function handleDashboardEvent(event: DashboardStreamEvent) {
  if (event.type === "session_disposed" || (event.type === "error" && /会话不存在/.test(String(event.message ?? "")))) {
    state.running = false;
    state.queue = [];
    hideApproval();
    hideQuestion();
    clearPendingGuide();
    resetLiveStatus();
    disconnectEvents();
    els.runStatus.textContent = "会话已结束";
    renderQueuePanel();
    updateSendButton();
    scheduleSessionsRefresh(0);
    return;
  }
  hideEmptyState();
  updateSessionStatus(event.sessionStatus);
  updateTurnChangeStats(event.turnChangeStats ?? event.changeStats, {
    replace: event.type === "run_state" || event.type === "files_updated" || Boolean(event.turnChangeStats)
  });
  if (event.type === "user_message") {
    beginEventTurn(event);
    updateTurnChangeStats(null, { reset: true });
    state.lastAssistantFinalSignature = "";
    appendMessage(
      "user",
      event.queuedKind === "guide" ? "引导" : event.queuedKind === "wakeup" ? "子智能体" : event.queuedKind === "goal-continue" ? "Goal" : "你",
      event.text,
      event.attachments
    );
    state.running = true;
    scheduleSessionsRefresh();
    if (event.queuedKind === "guide") {
      els.runStatus.textContent = "引导中";
      setPendingGuide({
        sessionId: state.currentSessionId,
        phase: "continuing",
        preview: event.text
      });
      setLiveTitle("正在按引导继续");
    } else {
      els.runStatus.textContent = "运行中";
      setLiveTitle("正在处理你的任务");
    }
    updateSendButton();
    return;
  }
  if (event.type === "goal_state" || event.type === "goal_continued") {
    applyGoalSnapshot(event.goal ?? state.goal, { permissionMode: event.permission?.mode });
    if (event.type === "goal_continued") {
      setLiveTitle(event.reason ? `Goal 续跑：${event.reason}` : "Goal 续跑中");
    }
    return;
  }
  if (event.type === "goal_question_skipped") {
    appendActivity({
      title: "已跳过需求核对",
      detail: "Goal 无人值守，未打开核对面板",
      severity: "info",
      collapsed: true
    });
    return;
  }
  if (event.type === "run_state") {
    if (event.goal) {
      applyGoalSnapshot(event.goal, { permissionMode: event.permission?.mode });
    } else if (event.permission?.mode) {
      if (!(state.goal.enabled && event.permission.mode !== "fullAccess")) {
        setPermissionMode(event.permission.mode);
      }
    }
    if (event.running === true) {
      beginEventTurn(event);
    } else if (event.running === false && event.turnId === state.activeTurnId) {
      state.activeTurnId = "";
    }
    state.running = event.running === true;
    state.queue = event.queue ?? [];
    scheduleSessionsRefresh();
    if (state.running && event.current?.kind === "guide") {
      setPendingGuide({
        sessionId: state.currentSessionId,
        phase: "continuing",
        preview: event.current.preview ?? state.pendingGuide?.preview ?? ""
      });
      els.runStatus.textContent = "引导中";
      setLiveTitle("正在按引导继续");
    } else if (!state.running) {
      clearPendingGuide();
      resetLiveStatus({ keepBackgroundSubagents: true });
      applyIdleRunStatus("空闲");
    } else {
      els.runStatus.textContent = "运行中";
      renderQueuePanel();
    }
    updateSendButton();
    return;
  }
  if (event.type === "guide_queued") {
    state.queue = event.queue ?? [];
    scheduleSessionsRefresh();
    setPendingGuide({
      sessionId: state.currentSessionId,
      phase: "registered",
      preview: event.guidance ?? event.item?.preview ?? state.pendingGuide?.preview ?? ""
    });
    els.runStatus.textContent = "引导中";
    return;
  }
  if (event.type === "prompt_queued" || event.type === "queue_updated") {
    state.queue = event.queue ?? [];
    scheduleSessionsRefresh();
    syncPendingGuideFromQueue();
    els.runStatus.textContent = state.pendingGuide ? "引导中" : state.running ? "运行中" : "已排队";
    return;
  }
  if (event.type === "queue_item_cancelled") {
    state.queue = event.queue ?? [];
    state.queueCancelling.delete(event.item?.id);
    updateSessionStatus(event.sessionStatus);
    if (event.item?.kind === "guide" && state.pendingGuide?.phase !== "continuing") {
      clearPendingGuide();
    } else {
      renderQueuePanel();
    }
    els.runStatus.textContent = state.queue.length > 0 ? `${state.queue.length} 条排队中` : state.running ? "运行中" : "空闲";
    return;
  }
  if (event.type === "wakeup_queued") {
    state.queue = event.queue ?? state.queue;
    scheduleSessionsRefresh();
    clearBackgroundSubagentStatus(event.groupId);
    renderQueuePanel();
    els.runStatus.textContent = event.running ? "主控续跑已排队" : "主控接续中";
    setLiveTitle("子智能体已唤醒主控");
    updateSendButton();
    return;
  }
  if (event.type === "background_subagent_snapshot") {
    reconcileBackgroundSubagentSnapshot(event.groups, event.at);
    return;
  }
  if (event.type === "background_subagent_cancelled") {
    clearBackgroundSubagentStatus(event.groupId || event.taskId);
    applyIdleRunStatus("空闲");
    return;
  }
  if (event.type === "background_terminal_cancelled") {
    clearBackgroundSubagentStatus(event.taskId);
    applyIdleRunStatus("空闲");
    return;
  }
  if (event.type === "turn_interrupt_requested") {
    if (event.reason === "guided") {
      hideApproval();
      hideQuestion();
      setPendingGuide({
        sessionId: state.currentSessionId,
        phase: "interrupting",
        preview: state.pendingGuide?.preview ?? state.queue.find((item) => item.kind === "guide")?.preview ?? ""
      });
      els.runStatus.textContent = "引导中";
      setLiveTitle("引导已接管，等待当前轮次收束");
    } else {
      els.runStatus.textContent = "中断中";
      setLiveTitle("正在中断当前任务");
    }
    return;
  }
  if (event.type === "guide_stopped") {
    state.queue = event.queue ?? [];
    setPendingGuide({
      sessionId: state.currentSessionId,
      phase: "stopped",
      preview: event.guidance ?? ""
    });
    els.runStatus.textContent = "停止中";
    setLiveTitle("正在停止当前任务");
    return;
  }
  if (event.type === "context_cleared") {
    hideContextConfirm();
    appendActivity({
      title: "上下文已清空",
      detail: contextSummaryLine(event.after),
      severity: "success",
      collapsed: true
    });
    return;
  }
  if (event.type === "context_boundary") {
    appendContextBoundary(event);
    return;
  }
  if (event.type === "context_compacted") {
    appendContextBoundary(event);
    return;
  }
  if (event.type === "activity") {
    if (event.rawType === "turn_interrupted") {
      collapseAssistantDrafts();
    }
    if (isBackgroundSubagentActivity(event)) {
      handleBackgroundSubagentActivity(event);
      return;
    }
    handleActivity(event);
    if (event.status === "waiting") els.runStatus.textContent = "等待确认";
    else if (event.status === "running") els.runStatus.textContent = state.pendingGuide ? "引导中" : "运行中";
    else if (event.status === "failed") els.runStatus.textContent = "失败";
    else if (event.rawType === "context_compacted") els.runStatus.textContent = state.running ? "运行中" : "完成";
    return;
  }
  if (event.type === "workflow_snapshot") {
    renderWorkflowPanel(event.workflow, event.summary);
    return;
  }
  if (event.type === "assistant_draft") {
    beginEventTurn(event);
    appendAssistantDraft(event);
    els.runStatus.textContent = state.pendingGuide ? "引导中" : "运行中";
    state.running = true;
    scheduleSessionsRefresh();
    updateSendButton();
    return;
  }
  if (event.type === "approval_required") {
    if (event.activity) handleActivity(event.activity);
    showApproval(event.approval);
    els.runStatus.textContent = "等待确认";
    setLiveTitle("等待权限确认");
    return;
  }
  if (event.type === "question_required") {
    showQuestion(event.question);
    els.runStatus.textContent = "等待核对";
    setLiveTitle("等待需求核对");
    return;
  }
  if (event.type === "question_resolved") {
    hideQuestion();
    if (event.interrupted && state.pendingGuide) {
      els.runStatus.textContent = "引导中";
      setLiveTitle("引导已接管，等待当前轮次收束");
      updateSendButton();
      return;
    }
    appendMessage("user", "你", questionResolutionText(event));
    els.runStatus.textContent = "运行中";
    state.running = true;
    scheduleSessionsRefresh();
    updateSendButton();
    setLiveTitle(event.cancelled ? "继续处理需求核对结果" : "继续处理你的确认");
    return;
  }
  if (event.type === "approval_resolved") {
    hideApproval();
    if (event.interrupted && state.pendingGuide) {
      els.runStatus.textContent = "引导中";
      setLiveTitle("引导已接管，等待当前轮次收束");
      updateSendButton();
      return;
    }
    els.runStatus.textContent = event.allowed ? "运行中" : "已拒绝";
    if (!event.allowed) {
      resetLiveStatus({ keepBackgroundSubagents: true });
    }
    return;
  }
  if (event.type === "assistant_final") {
    beginEventTurn(event);
    const finalSignature = normalizeComparableText(event.text);
    if (finalSignature && state.lastAssistantFinalSignature === finalSignature) {
      clearAssistantDrafts();
      return;
    }
    state.lastAssistantFinalSignature = finalSignature;
    collapseAssistantDrafts(event.text);
    collapseCompletedActivities();
    resetLiveStatus({ keepBackgroundSubagents: true });
    clearPendingGuide();
    appendMessage("assistant", "Ant Code", event.text);
    state.activeTurnId = "";
    els.runStatus.textContent = state.backgroundSubagents.size > 0 ? idleRunStatus("收尾中") : "收尾中";
    updateSendButton();
    scheduleSessionsRefresh();
    return;
  }
  if (event.type === "files_updated") {
    state.files = event.files ?? [];
    renderFiles();
    if (shouldKeepGuideFeedback()) {
      els.runStatus.textContent = "引导中";
      updateLiveStatus();
    } else {
      resetLiveStatus({ keepBackgroundSubagents: true });
      applyIdleRunStatus("完成");
      clearPendingGuide();
    }
    updateSendButton();
    scheduleSessionsRefresh();
    loadSessions();
    return;
  }
  if (event.type === "error") {
    if (state.pendingGuide && isInterruptError(event.message)) {
      els.runStatus.textContent = "引导中";
      updateLiveStatus();
      updateSendButton();
      return;
    }
    resetLiveStatus({ keepBackgroundSubagents: true });
    clearPendingGuide();
    showError(event.message ?? "任务失败");
    applyIdleRunStatus("失败");
    updateSendButton();
    scheduleSessionsRefresh();
  }
}

export function shouldSkipDashboardEvent(event: DashboardStreamEvent) {
  if (!event || typeof event !== "object" || !event.id) {
    return false;
  }
  const id = String(event.id);
  if (state.processedEventIds.has(id)) {
    return true;
  }
  state.processedEventIds.add(id);
  if (state.processedEventIds.size > 1200) {
    state.processedEventIds = new Set(Array.from(state.processedEventIds).slice(-800));
  }
  return false;
}

export function beginEventTurn(event: DashboardStreamEvent) {
  const turnId = typeof event.turnId === "string" ? event.turnId : "";
  if (!turnId) {
    return;
  }
  if (state.activeTurnId && state.activeTurnId !== turnId) {
    collapseAssistantDrafts();
  }
  state.activeTurnId = turnId;
}

export function renderTranscriptMessages(messages: unknown, options: Record<string, unknown> = {}) {
  const nodes = [];
  const list = Array.isArray(messages) ? messages : [];
  for (const message of list) {
    const role = visibleTranscriptRole(isPlainObject(message) ? message.role : message);
    if (!role) {
      continue;
    }
    const attachments = role === "user" ? transcriptMessageAttachments(message) : [];
    const text = role === "assistant"
      ? messageDisplayText(message.content)
      : userTranscriptDisplayText(message.content, attachments);
    const node = createMessageNode(role, role === "assistant" ? "Ant Code" : "你", text, attachments);
    node.setAttribute("aria-live", "off");
    nodes.push(node);
  }
  if (options.prepend) {
    hideEmptyState();
    const anchor = transcriptFirstContentNode();
    for (const node of nodes) {
      els.transcript.insertBefore(node, anchor);
    }
    trimTranscriptWindow({ direction: "prepend", preserveAnchor: false });
    return nodes;
  }
  for (const node of nodes) {
    appendTranscriptNode(node, { deferTrim: true });
  }
  trimTranscriptWindow({ direction: "append", preserveAnchor: !state.transcriptFollowing });
  return nodes;
}

export function renderSessionFailure(failure: unknown) {
  if (!isPlainObject(failure) || failure.kind !== "gateway") {
    return;
  }
  const primary = String(failure.upstreamMessage ?? failure.message ?? "").trim() || "模型网关请求失败";
  const details = [
    primary,
    Number.isInteger(failure.httpStatus) ? `HTTP ${failure.httpStatus}` : null,
    Number.isInteger(failure.attempts) && Number(failure.attempts) > 1 ? `已尝试 ${failure.attempts} 次` : null,
    failure.code ? String(failure.code) : null
  ].filter(Boolean);
  appendActivity({
    title: "模型请求失败",
    detail: details.join(" · "),
    severity: "danger",
    collapsed: false
  });
}

export function setTranscriptPaging(page: unknown = null) {
  const record = isPlainObject(page) ? page : {};
  state.transcriptPaging = {
    cursor: record.cursor ?? record.nextCursor ?? null,
    hasMore: record.hasMore === true,
    loading: false,
    error: "",
    total: Number.isFinite(Number(record.total)) ? Number(record.total) : 0
  };
  renderTranscriptHistoryStatus();
}

export function renderTranscriptHistoryStatus() {
  if (!state.currentSessionId) {
    removeTranscriptHistoryStatus();
    return;
  }
  const paging = state.transcriptPaging;
  if (!paging.hasMore && !paging.loading && !paging.error) {
    removeTranscriptHistoryStatus();
    return;
  }
  if (!state.transcriptHistoryNode) {
    state.transcriptHistoryNode = document.createElement("button");
    state.transcriptHistoryNode.type = "button";
    state.transcriptHistoryNode.className = "history-loader";
    state.transcriptHistoryNode.addEventListener("click", () => loadOlderTranscript());
  }
  state.transcriptHistoryNode.disabled = paging.loading;
  state.transcriptHistoryNode.dataset.state = paging.error ? "error" : paging.loading ? "loading" : "idle";
  state.transcriptHistoryNode.textContent = paging.error
    ? "加载失败，点击重试"
    : paging.loading
      ? "正在加载更早记录"
      : "加载更早记录";
  if (els.transcript.firstChild !== state.transcriptHistoryNode) {
    els.transcript.insertBefore(state.transcriptHistoryNode, els.transcript.firstChild);
  }
}

export function removeTranscriptHistoryStatus() {
  state.transcriptHistoryNode?.remove();
  state.transcriptHistoryNode = null;
}

export function transcriptFirstContentNode() {
  let node = state.transcriptHistoryNode?.parentElement === els.transcript
    ? state.transcriptHistoryNode.nextSibling
    : els.transcript.firstChild;
  if (node === els.emptyState) node = node.nextSibling;
  return node;
}

export function handleTranscriptScroll() {
  syncTranscriptFollowState();
  if (els.transcript.scrollTop > 180) {
    return;
  }
  if (!state.transcriptPaging.hasMore || state.transcriptPaging.loading) {
    return;
  }
  loadOlderTranscript();
}

export async function loadOlderTranscript() {
  if (!state.currentSessionId || !state.transcriptPaging.hasMore || state.transcriptPaging.loading) {
    return;
  }
  const sessionId = state.currentSessionId;
  const request = beginScopedRequest("transcript", sessionId);
  const before = state.transcriptPaging.cursor;
  state.transcriptPaging.loading = true;
  state.transcriptPaging.error = "";
  renderTranscriptHistoryStatus();
  const previousHeight = els.transcript.scrollHeight;
  const previousTop = els.transcript.scrollTop;
  const anchor = transcriptFirstContentNode();
  const anchorTop = transcriptNodeTop(anchor);
  const result = await getJson(`/api/sessions/${encodeURIComponent(sessionId)}/transcript?${new URLSearchParams({
    before: String(before ?? ""),
    limit: "100"
  }).toString()}`, { signal: request.signal })
    .catch((error: unknown): DashboardApiResult => ({ ok: false, error: error instanceof Error ? error.message : String(error), aborted: isAbortError(error) }));
  if (!isCurrentScopedRequest(request) || state.currentSessionId !== sessionId) return;
  finishScopedRequest(request);
  state.transcriptPaging.loading = false;
  if (result.aborted) return;
  if (!result.ok) {
    state.transcriptPaging.error = result.error ?? "加载失败";
    renderTranscriptHistoryStatus();
    return;
  }
  const page = result.transcriptPage;
  state.transcriptPaging.cursor = page?.cursor ?? page?.nextCursor ?? null;
  state.transcriptPaging.hasMore = page?.hasMore === true;
  const pageTotal = Number(page?.total);
  state.transcriptPaging.total = Number.isFinite(pageTotal) ? pageTotal : state.transcriptPaging.total;
  renderTranscriptMessages(result.transcript ?? [], { prepend: true });
  state.transcriptPaging.error = "";
  renderTranscriptHistoryStatus();
  if (!restoreTranscriptNodeAnchor(anchor, anchorTop)) {
    const delta = els.transcript.scrollHeight - previousHeight;
    els.transcript.scrollTop = previousTop + delta;
  }
}

export function renderWorkflowPanel(workflow: unknown, summary: unknown = null) {
  const record = isPlainObject(workflow) ? workflow : null;
  const todos = Array.isArray(record?.todos) ? record.todos : [];
  const plan = isPlainObject(record?.plan) ? record.plan : null;
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  if (!record || (!todos.length && !steps.length)) {
    state.workflow = null;
    state.workflowExpanded = false;
    renderWorkflowStrip();
    return;
  }
  hideEmptyState();
  state.workflow = {
    ...record,
    todos,
    plan: plan ? { ...plan, steps } : undefined
  };
  if (!state.workflowNode) {
    state.workflowNode = document.createElement("section");
    state.workflowNode.className = "workflow-panel";
    appendTranscriptNode(state.workflowNode);
  }
  const totals = isPlainObject(summary)
    ? {
      total: Number(summary.total ?? 0),
      completed: Number(summary.completed ?? 0),
      pending: Number(summary.pending ?? 0),
      in_progress: Number(summary.in_progress ?? 0),
      cancelled: Number(summary.cancelled ?? 0)
    }
    : summarizeWorkflow({ todos, plan: plan ? { steps } : undefined });
  const percent = Number(totals.total) > 0 ? Math.round((Number(totals.completed) / Number(totals.total)) * 100) : 0;
  state.workflowNode.innerHTML = `
    <div class="workflow-head">
      <div>
        <div class="workflow-kicker">任务进度</div>
        <div class="workflow-title">${totals.completed}/${totals.total} 已完成</div>
      </div>
      <div class="workflow-percent">${percent}%</div>
    </div>
    <div class="workflow-meter"><span style="width: ${percent}%"></span></div>
    ${todos.length ? workflowSection("Todo", todos) : ""}
    ${steps.length ? workflowSection("Plan", steps) : ""}
  `;
  renderWorkflowStrip();
  scrollTranscript();
}

export function renderWorkflowStrip() {
  if (!state.workflow || (!state.workflow.todos?.length && !state.workflow.plan?.steps?.length)) {
    els.workflowStrip.classList.add("hidden");
    els.workflowStrip.innerHTML = "";
    return;
  }
  const totals = summarizeWorkflow(state.workflow);
  const percent = totals.total > 0 ? Math.round((totals.completed / totals.total) * 100) : 0;
  const activeItem = currentWorkflowItem(state.workflow);
  const title = activeItem
    ? `正在：${activeItem.content ?? activeItem.title ?? ""}`
    : totals.completed === totals.total && totals.total > 0
      ? "任务已完成"
      : "等待下一步";
  els.workflowStrip.classList.remove("hidden");
  els.workflowStrip.innerHTML = `
    <button class="workflow-strip-toggle" type="button" data-action="toggle-workflow" aria-expanded="${state.workflowExpanded ? "true" : "false"}">
      <span class="workflow-strip-label">任务进度</span>
      <strong>${totals.completed}/${totals.total}</strong>
      <span class="workflow-strip-current">${escapeHtml(title)}</span>
      <span class="workflow-strip-percent">${percent}%</span>
      <span class="workflow-strip-chevron">${state.workflowExpanded ? "收起" : "展开"}</span>
    </button>
    <div class="workflow-strip-meter"><span style="width: ${percent}%"></span></div>
    ${state.workflowExpanded ? `<div class="workflow-strip-detail">
      ${state.workflow.todos?.length ? workflowSection("Todo", state.workflow.todos, Number.POSITIVE_INFINITY) : ""}
      ${state.workflow.plan?.steps?.length ? workflowSection("Plan", state.workflow.plan.steps, Number.POSITIVE_INFINITY) : ""}
    </div>` : ""}
  `;
}

export function currentWorkflowItem(workflow: unknown) {
  const record = isPlainObject(workflow) ? workflow : {};
  const todos = Array.isArray(record.todos) ? record.todos as Array<{ status?: string; content?: string; title?: string }> : [];
  const plan = isPlainObject(record.plan) ? record.plan : {};
  const steps = Array.isArray(plan.steps) ? plan.steps as Array<{ status?: string; content?: string; title?: string }> : [];
  const items = [...todos, ...steps];
  return items.find((item) => normalizeWorkflowStatus(item.status) === "in_progress")
    ?? items.find((item) => normalizeWorkflowStatus(item.status) === "pending")
    ?? null;
}

export function workflowSection(label: string, items: Array<{ status?: string; content?: string; title?: string }> = [], limit: number = 8) {
  return `
    <div class="workflow-section">
      <div class="workflow-section-title">${label}</div>
      <div class="workflow-list">
        ${items.slice(0, limit).map((item) => workflowItem(item)).join("")}
      </div>
    </div>
  `;
}

export function workflowItem(item: { status?: string; content?: string; title?: string } = {}) {
  const status = normalizeWorkflowStatus(item.status);
  return `
    <div class="workflow-item ${status}">
      <span class="workflow-mark"></span>
      <span class="workflow-text">${escapeHtml(item.content ?? item.title ?? "")}</span>
    </div>
  `;
}

export function normalizeWorkflowStatus(status: string | null | undefined) {
  if (status === "completed" || status === "in_progress" || status === "cancelled") {
    return status;
  }
  return "pending";
}

export function summarizeWorkflow(workflow: { todos?: Array<{ status?: string }>; plan?: { steps?: Array<{ status?: string }> } } | null | undefined) {
  const items = [...(workflow?.todos ?? []), ...(workflow?.plan?.steps ?? [])];
  return {
    total: items.length,
    pending: items.filter((item) => item.status === "pending").length,
    in_progress: items.filter((item) => item.status === "in_progress").length,
    completed: items.filter((item) => item.status === "completed").length,
    cancelled: items.filter((item) => item.status === "cancelled").length
  };
}

export function appendMessage(kind: string, label: string, text: string | null | undefined, attachments: unknown = []) {
  const wasAtBottom = isTranscriptNearBottom();
  const node = createMessageNode(kind, label, text, attachments);
  appendTranscriptNode(node);
  scrollTranscript({ onlyIfNearBottom: true, wasAtBottom });
  if (kind === "assistant") announceStatus("收到新的助手回复");
}

export function createMessageNode(kind: string, label: string, text: string | null | undefined, attachments: unknown = []) {
  hideEmptyState();
  const node = document.createElement("article");
  node.className = `message ${kind}`;
  node.setAttribute("aria-live", "off");
  node.innerHTML = `
    <div class="message-label">${escapeHtml(label)}</div>
    <div class="message-body"></div>
  `;
  const body = node.querySelector(".message-body");
  if (kind === "assistant") renderFinalAssistantBody(body, text);
  else {
    renderMessageText(body, text ?? "", { markdown: false });
    appendMessageAttachmentChips(body, attachments);
  }
  return node;
}

export function appendMessageAttachmentChips(body: Element | null, attachments: unknown) {
  if (!body) {
    return;
  }
  const items = normalizeAttachmentMetadata(attachments);
  if (items.length === 0) {
    return;
  }
  const row = document.createElement("div");
  row.className = "message-attachments";
  for (const item of items) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "file-link attachment-chip";
    button.dataset.file = resolveAttachedFilePath(item);
    const name = String(item.name ?? "file");
    button.textContent = name;
    button.title = name;
    row.append(button);
  }
  body.append(row);
  bindRichContent(row);
}

export function resolveAttachedFilePath(item: { path?: unknown; name?: unknown }) {
  const stored = String(item.path ?? "").trim().replace(/\\/g, "/");
  if (stored) {
    return stored;
  }
  const base = String(item.name ?? "").split(/[/\\]/).pop() ?? "";
  const files = Array.isArray(state.files) ? state.files : [];
  const match = [...files].reverse().find((file) => {
    const relative = String(file.relativePath ?? "").replace(/\\/g, "/");
    const name = String(file.name ?? "");
    return name === base || relative.endsWith(`/${base}`) || relative.endsWith(base);
  });
  return match?.relativePath ?? base;
}

export function appendTranscriptNode(node: Node, options: { deferTrim?: boolean } = {}) {
  hideEmptyState();
  els.transcript.append(node);
  if (!options.deferTrim) {
    trimTranscriptWindow({ direction: "append", preserveAnchor: !state.transcriptFollowing });
  }
}

export function trimTranscriptWindow(options: Record<string, unknown> = {}) {
  const direction = options.direction === "prepend" ? "prepend" : "append";
  const windowSide = direction === "prepend" ? "newer" : "older";
  const markerKey = windowSide === "newer" ? "newerNode" : "olderNode";
  const willAddMarker = !state.transcriptWindow[markerKey];
  const limit = Math.max(1, TRANSCRIPT_DOM_LIMIT - (willAddMarker ? 1 : 0));
  const nodes = Array.from(els.transcript.children ?? []);
  const toRemove = selectTranscriptNodesToRemove(nodes, limit, direction, isProtectedTranscriptNode);
  if (toRemove.length === 0) return 0;
  const anchor = options.preserveAnchor ? captureTranscriptViewportAnchor(new Set(toRemove)) : null;
  for (const node of toRemove) node.remove();
  const countKey = windowSide === "newer" ? "unloadedNewer" : "unloadedOlder";
  state.transcriptWindow[countKey] += toRemove.length;
  renderTranscriptWindowMarker(windowSide);
  restoreTranscriptViewportAnchor(anchor);
  return toRemove.length;
}

export function isProtectedTranscriptNode(node: Element) {
  return node === els.emptyState
    || node === state.transcriptHistoryNode
    || node === state.workflowNode
    || node === state.transcriptWindow.olderNode
    || node === state.transcriptWindow.newerNode
    || node.classList.contains("draft-message");
}

