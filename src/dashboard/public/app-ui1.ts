import { renderMarkdown } from "./markdown.ts";
import { hydrateRichContent } from "./rich-renderers.ts";
import { visibleTranscriptRole } from "./transcript.ts";
import { MANUAL_AGENT_MODEL_VALUE, state, els, MODE_DESCRIPTIONS, LOCAL_FILE_EXTENSIONS, FILE_REFERENCE_PATTERN, TRANSCRIPT_DOM_LIMIT, EVENT_STALE_AFTER_MS, EVENT_CONNECT_TIMEOUT_MS, EVENT_RECONNECT_MAX_ATTEMPTS, DASHBOARD_REQUEST_TIMEOUT_MS, DASHBOARD_API_VERSION, DASHBOARD_LIFECYCLE_TIMEOUT_MS, DASHBOARD_SHUTDOWN_TIMEOUT_MS, DASHBOARD_INTERRUPT_TIMEOUT_MS, MAX_IMAGE_ATTACHMENTS, MAX_IMAGE_ATTACHMENT_BYTES, CURRENT_SESSION_STORAGE_KEY, DASHBOARD_CLIENT_STORAGE_KEY, PREVIEW_WIDTH_STORAGE_KEY, PREVIEW_WIDTH_DEFAULT, PREVIEW_WIDTH_MIN, PREVIEW_WIDTH_MAX, PREVIEW_WORKSPACE_MIN , emptySessionStatus, emptyBackgroundSubagent } from "./app-core.ts";
import type { DashboardConfigSource, DashboardReasoningEffort, DashboardTurnChangeStats, DashboardScopedDefaultSelection, DashboardVisionAgent, DashboardReasoningDiscovery, DashboardReasoningCapabilityCandidate, DashboardGatewayProbeModel, DashboardGatewayProbeResult, DashboardLifecycleActivity, DashboardSettings, DashboardFile, DashboardTableSheet, DashboardTablePreview, DashboardLightboxItem, DashboardQuestionChoice, DashboardPendingQuestion, DashboardApproval, DashboardGatewayTransport, DashboardScopedRequest, DashboardFetchOptions, DashboardModelSource, DashboardSessionStatus, DashboardApiResult, DashboardActivity, DashboardModelOption, DashboardGatewayProfile, DashboardGatewayConfig, DashboardModelSelection, DashboardPendingGuide, DashboardStreamEvent, DashboardUiState , DashboardSessionSummary } from "./app-core.ts";
import { eventTargetOf, eventElement, isPlainObject, modelSourceOf, errorMessageOf, activateModal, collectModalBackground, focusModalInitialTarget, deactivateModal, restoreModalAttribute, handleGlobalKeydown, closeActiveModal, loadTrust, loadSessions, restoreInitialSession, latestBackgroundSessionId, initialSessionId, rememberCurrentSession, renderSessions, sessionMeta, sessionStatusView, toggleSidebar, setSidebarCollapsed, sessionsNeedRefresh, scheduleSessionsRefresh, handleSessionAction, openSession, restoreBackgroundSnapshot, deleteSession, setSessionsRefreshState, copySessionId, newTask, rememberNewTaskModelState, restoreNewTaskModelState, refreshNewTaskModelState, addAttachmentFiles, readImageAttachment, renderAttachmentStrip, attachmentPayload, clearAttachments, sendPrompt, stableTurnRequest, dashboardRequestId, dashboardClientId, statusUrl, interruptTurn, guideTurn, cancelQueuedTurn, cancelBackgroundSubagent, backgroundCancelKey, connectEvents, ensureEventsConnected, disconnectEvents, closeEventSource, markEventConnectionAlive, armEventConnectTimer, armEventStaleTimer, scheduleEventReconnect, reconnectEventsManually, clearEventReconnectTimer, clearEventConnectTimer, clearEventStaleTimer, setConnectionState, resetEventReplayState, rememberEventCursor, handleDashboardEvent, shouldSkipDashboardEvent, beginEventTurn, renderTranscriptMessages, renderSessionFailure, setTranscriptPaging, renderTranscriptHistoryStatus, removeTranscriptHistoryStatus, transcriptFirstContentNode, handleTranscriptScroll, loadOlderTranscript, renderWorkflowPanel, renderWorkflowStrip, currentWorkflowItem, workflowSection, workflowItem, normalizeWorkflowStatus, summarizeWorkflow, appendMessage, createMessageNode, appendTranscriptNode, trimTranscriptWindow, isProtectedTranscriptNode, renderTranscriptWindowMarker, captureTranscriptViewportAnchor, restoreTranscriptViewportAnchor, transcriptNodeTop, restoreTranscriptNodeAnchor, resetTranscriptWindow, appendAssistantDraft, scheduleDraftRender, renderAssistantDraft, appendActivity, appendContextBoundary, contextBoundaryText, handleActivity, isBackgroundSubagentActivity, handleBackgroundSubagentActivity, clearBackgroundSubagentStatus, reconcileBackgroundSubagentSnapshot, backgroundSubagentDisplayStatus, backgroundSubagentVisible, updateLiveActivity, removeLiveActivity, setLiveTitle, toggleLiveStatusDetails, updateLiveStatus, liveStatusTitle, primaryLiveActivity, gatewayRetryChipText, renderBackgroundSubagentStatus, backgroundSubagentCompactLabel, backgroundSubagentTitle, backgroundSubagentMeta, backgroundSubagentCancellable, resetLiveStatus, backgroundSubagentCounts, idleRunStatus, applyIdleRunStatus, updateRunStatusForBackground, updateSessionStatus, updateTurnChangeStats, resetTurnChangeStats, normalizeChangeStats, renderComposerStatus, modelStatusHtml, unresolvedModelStatusHtml, handleModelStatusActivate, handleModelStatusKeydown, toggleModelPanel, hideModelPanel, showSettingsWorkspace, refreshSettingsConfiguration, hideSettingsWorkspace, showModelConfigPanel, hideModelConfigPanel, renderModelPanel, modelCapabilityLabels, handleModelPanelClick, handleModelPanelChange, renderSettingsView, syncSettingsRail, modelSettingsHtml, transcriptSettingsHtml, transcriptRetentionOptionsHtml, networkSettingsHtml, networkModeOptionHtml, agentSettingsHtml, reliabilitySettingsHtml, settingsSectionHeading, settingsToggleHtml, managedFieldHtml, settingsDisabled, settingsFormActions, settingsFeedbackHtml, settingsGatewayProfileHtml, gatewayProfileReadonlyLabel, providerModelKey, scopedDefaultModelLabel, settingsModelHtml, handleSettingsRailClick, initializeSettingsFormTracking, handleSettingsFormChange, settingsControlValue, changedSettingsFields, canonicalSettingsField, setSettingsFormSaving, renderSettingsFeedbackInPlace, saveSettingsConfig, handleSettingsClick, protocolDisplayName, agentModelPickerHtml, renderModelConfigPanel, handleModelConfigPanelClick, handleModelConfigInput, handleModelConfigChange, markModelConfigCredentialChanged, markModelConfigEndpointChanged, handleModelConfigModelIdChanged, markReasoningCapabilityManual, clearReasoningCapabilityControls, syncGatewayUrlHint, gatewayUrlPlaceholder, gatewayUrlHint, syncReasoningDefaultOptions, probeGateway, isCurrentModelConfigRequest, currentGatewayProbeResult, currentGatewayCatalogModels, modelConfigGatewayProfile, modelConfigEndpointChanged, modelConfigAgentModelsSnapshot, initializeAgentModelPickerSnapshot, syncAgentModelPickersForEndpoint, uniqueAgentModelCandidates, appendAgentModelOptions, renderAgentModelPickers, updateAgentModelPickerManualStatus, handleAgentModelSelection, renderGatewayProbeResult, applyProbedModel, applyGatewayDiscoveredModel, applySuggestedGatewayUrl, gatewayCredentialAction, normalizeGatewayProbeModels, normalizeReasoningDiscovery, reasoningCapabilityCandidate, applyReasoningCapabilityCandidate, ensureReasoningEffortOptions, applyPendingReasoningCapabilities, reasoningCapabilityIsActionable, renderReasoningCapabilityStatus, reasoningCapabilityStatusText, reasoningDiscoveryStatusText, probeModelCapabilities, setFormControlsSaving, setModelConfigFormSaving, renderModelConfigFailure, clearModelConfigFailure, manualAgentModelIds, saveModelConfig, saveDefaultModelSelection, switchModel, handleReasoningEffortChange, switchReasoningEffort, deleteGatewayProfile, deleteModel, updateConfigRevisions, normalizeScopedDefaultSelection, configScope, configMutationMetadata, isConfigRevisionConflict, configRevisionConflictMessage, refreshConfigRevisionsAfterConflict, normalizeGatewayConfig, normalizeDashboardSettings, mergeGatewayConfig, normalizeGatewayProfiles, normalizeConfigSource, normalizeModels, normalizeModelSource, normalizeReasoningEfforts, normalizedReasoningEffort, isDisabledReasoningEffort, configuredReasoningEffort, reasoningEffortFallbackLabel, localizedReasoningEffortLabel, reasoningEffortCatalog, reasoningEffortLabel, resolveAtomicModelSelection, currentModelSelection, currentSessionNeedsModelSelection, currentGatewayProfile, gatewayProfileById, settingsInspectedGatewayProfile, modelSourceLabel, markCurrentModel, currentModelInfo, modelDisplayName, normalizeAgentModelTiers, normalizeVisionAgent, firstVisionModelId, hasAgentModelTiers, agentModelTiersSummary, gatewaySummary, modelSaveTargetLabel, gatewaySourceNote, environmentGatewayDefaultNote, sourceBadge, sourceLabel, formatContextUsage, firstFiniteNumber, formatTokenCount, trimNumber, nonNegativeInteger, collapseCompletedActivities, clearAssistantDrafts, collapseAssistantDrafts, isMeaningfulCompletedActivity, isDuplicateDraftText, normalizeComparableText, showApproval, resolveApproval, hideApproval, showQuestion, revealInteractionPanel, renderQuestionPanel, reviewQuestionConversation, returnToQuestion, activateQuestionReviewBackground, deactivateQuestionReviewBackground, questionChoiceButton, toggleQuestionChoice, submitQuestion, cancelQuestion, finishQuestionSubmission, hideQuestion, showTrustPanel, renderTrustPanel, confirmTrust, renderQueuePanel, renderQueueItem, setPendingGuide, clearPendingGuide, syncPendingGuideFromQueue, renderGuideFeedback, guideCopy, guideSource, guideTurnFromQueue, guideButtonText, guideButtonDisabled, guideButtonVisible, syncGuideButton, shouldKeepGuideFeedback, isInterruptError, updateSendButton, showContextConfirm, hideContextConfirm, runContextAction, contextActionRequestOptions, contextSummaryLine, compactResultLine, rememberQuestionDraft, questionResolutionText, showShutdownPanel, hideShutdownPanel, shutdownDashboard, lockClosedDashboard, normalizeLifecycleActivity, shutdownRequestBody, shutdownResultIsClosed, lifecycleActivitySummary, renderShutdownActivity, renderFiles, currentImageFiles, openFile, handleLocalFileOpenClick, renderOfficePreview, officePreviewMeta, officePreviewBodyHtml, renderTablePreview, normalizeTablePreview, tablePreviewMeta, renderCompactTableHtml, renderExpandedTableHtml, renderTableHtml, tableTruncationNote, maxVisibleColumns, columnLabel, renderSheetPreviewHtml, renderSheetCellHtml, resetPreview, fencedDataForFile, dataLanguageForExtension, showImageLightbox, showTableLightbox, renderLightboxImage, bindTableLightboxControls, moveLightbox, hideLightbox, setPermissionMode, clearTranscript, cancelTranscriptAnimationFrames, clearAssistantDraftTimers, hideEmptyState, showError, showNotice, renderBootstrapLoading, renderBootstrapFailure, dashboardPayloadError, bootstrapFailurePresentation, clearBootstrapStatus, scrollTranscript, isTranscriptNearBottom, syncTranscriptFollowState, followTranscript, updateTranscriptJump, beginScopedRequest, isCurrentScopedRequest, finishScopedRequest, cancelScopedRequest, isAbortError, getJson, postJson, deleteJson, dashboardFetch, responseJson, dashboardJsonHeaders, dashboardCsrfToken, messageText, messageDisplayText, userMessageDisplayText, normalizeAttachmentMetadata, imageAttachmentLine, renderMessageText, renderLinkedText, bindRichContent, linkifyFileTextNodes, replaceFileReferences, isLikelyLocalFileReference, resolveDisplayFilePath, normalizeFileReferencePath, parentDirectory, filePreviewUrl, rawFileUrl, apiFileUrl, imagePreviewUrl, isSafeInlineBitmapUrl, normalizeRelativePath, isWorkspaceRelativeToBase, copyCodeBlock, previewText, formatNumber, formatBytes, escapeHtml, escapeAttribute, formatTime, formatRelativeTime } from "./app-barrel.ts";
export async function init() {
  restorePreviewWidth();
  bindEvents();
  observeRunStatus();
  await bootstrapDashboard();
}

export async function bootstrapDashboard() {
  const request = beginScopedRequest("bootstrap");
  renderBootstrapLoading();
  try {
    const status = await getJson(statusUrl(), { signal: request.signal });
    if (!isCurrentScopedRequest(request)) return;
    if (!status.ok) {
      throw dashboardPayloadError(status, "Dashboard 初始化失败");
    }
    if (status.version !== DASHBOARD_API_VERSION) {
      throw new Error("Dashboard 前后端版本不一致，请重启 Dashboard 服务后刷新页面");
    }
    state.cwd = String(status.cwd ?? "");
    state.models = normalizeModels(status.models);
    state.gatewayConfig = normalizeGatewayConfig(status.gatewayConfig);
    state.gatewayProfiles = normalizeGatewayProfiles(status.gatewayProfiles);
    state.agentModelTiers = normalizeAgentModelTiers(status.agentModelTiers);
    state.visionAgent = normalizeVisionAgent(status.visionAgent);
    state.settings = normalizeDashboardSettings(status.settings);
    updateConfigRevisions(status);
    state.applyAgentDefaultsOnSwitch = Boolean(state.settings?.agents?.syncModelTiersOnSwitch);
    updateSessionStatus({
      ...status.sessionStatus,
      providerId: status.sessionStatus?.providerId ?? state.gatewayConfig?.activeProfileId ?? ""
    });
    rememberNewTaskModelState();
    if (els.projectPath) {
      els.projectPath.textContent = String(status.cwd ?? "");
    }
    const trust = await loadTrust({ signal: request.signal, silent: true });
    if (!trust?.ok) {
      throw dashboardPayloadError(trust, "无法读取工作区信任状态");
    }
    if (!isCurrentScopedRequest(request)) return;
    await loadSessions();
    if (!isCurrentScopedRequest(request)) return;
    await restoreInitialSession();
    if (!isCurrentScopedRequest(request)) return;
    updateSendButton();
    renderComposerStatus();
    clearBootstrapStatus();
  } catch (error) {
    if (!isAbortError(error) && isCurrentScopedRequest(request)) {
      renderBootstrapFailure(error);
    }
  } finally {
    finishScopedRequest(request);
  }
}

export function observeRunStatus() {
  updateRunStatusTone();
  new MutationObserver(updateRunStatusTone).observe(els.runStatus, { childList: true, characterData: true, subtree: true });
}

export function updateRunStatusTone() {
  const status = els.runStatus.textContent.trim();
  let tone = "idle";
  if (/失败|拒绝/.test(status)) {
    tone = "error";
  } else if (/等待|待/.test(status)) {
    tone = "waiting";
  } else if (/运行|启动|引导|中断|停止|收尾|排队|压缩/.test(status)) {
    tone = "running";
  } else if (/完成/.test(status)) {
    tone = "done";
  }
  els.runStatus.dataset.tone = tone;
}

export function bindEvents() {
  els.refreshSessions.addEventListener("click", () => loadSessions({ feedback: true }));
  els.collapseSidebar.addEventListener("click", () => {
    if (responsiveLayoutMode() === "desktop") {
      toggleSidebar();
    } else {
      setResponsiveView("conversation");
    }
  });
  els.newTask.addEventListener("click", () => {
    newTask();
    setResponsiveView("conversation");
  });
  els.sendButton.addEventListener("click", () => {
    if (state.turnSubmitting) {
      return;
    }
    if (state.running) {
      interruptTurn();
      return;
    }
    sendPrompt();
  });
  els.promptInput.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendPrompt();
    }
  });
  els.promptInput.addEventListener("input", () => {
    syncGuideButton();
    resizePromptInput();
  });
  els.attachButton.addEventListener("click", () => els.attachmentInput.click());
  els.attachmentInput.addEventListener("change", async () => {
    await addAttachmentFiles(Array.from(els.attachmentInput.files ?? []));
    els.attachmentInput.value = "";
  });
  els.promptInput.addEventListener("paste", async (event: ClipboardEvent) => {
    const files = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith("image/"));
    if (files.length === 0) {
      return;
    }
    event.preventDefault();
    await addAttachmentFiles(files);
  });
  document.addEventListener("keydown", handleGlobalKeydown);
  els.permissionMode.addEventListener("click", (event: Event) => {
    const button = eventElement(event)?.closest("button[data-mode]");
    if (!(button instanceof HTMLButtonElement)) return;
    requestPermissionMode(button.dataset.mode, button);
  });
  els.permissionMode.addEventListener("keydown", handlePermissionModeKeydown);
  els.goalMode?.addEventListener("click", () => requestGoalMode());
  els.preview.addEventListener("click", handleLocalFileOpenClick);
  els.collapsePreview.addEventListener("click", () => {
    if (responsiveLayoutMode() === "desktop") {
      document.body.classList.toggle("preview-collapsed");
      syncPreviewResizeHandle();
    } else {
      setResponsiveView("conversation");
    }
  });
  els.previewResizeHandle?.addEventListener("pointerdown", (event: PointerEvent) => beginPreviewResize(event));
  els.previewResizeHandle?.addEventListener("pointermove", (event: PointerEvent) => updatePreviewResize(event));
  els.previewResizeHandle?.addEventListener("pointerup", (event: PointerEvent) => finishPreviewResize(event));
  els.previewResizeHandle?.addEventListener("pointercancel", (event: PointerEvent) => finishPreviewResize(event));
  els.previewResizeHandle?.addEventListener("keydown", (event: KeyboardEvent) => handlePreviewResizeKeydown(event));
  els.previewResizeHandle?.addEventListener("dblclick", () => {
    setPreviewWidth(PREVIEW_WIDTH_DEFAULT, { persist: true, announce: true });
  });
  els.shutdownButton.addEventListener("click", showShutdownPanel);
  els.headerShutdownButton.addEventListener("click", showShutdownPanel);
  els.shutdownCancel.addEventListener("click", hideShutdownPanel);
  els.shutdownConfirm.addEventListener("click", shutdownDashboard);
  els.lightboxBackdrop.addEventListener("click", hideLightbox);
  els.lightboxClose.addEventListener("click", hideLightbox);
  els.lightboxPrevious.addEventListener("click", () => moveLightbox(-1));
  els.lightboxNext.addEventListener("click", () => moveLightbox(1));
  els.contextClear.addEventListener("click", () => showContextConfirm("clear"));
  els.contextCompact.addEventListener("click", () => showContextConfirm("compact"));
  els.modelStatus.addEventListener("click", handleModelStatusActivate);
  els.modelStatus.addEventListener("keydown", handleModelStatusKeydown);
  els.modelStatus.addEventListener("change", handleReasoningEffortChange);
  els.modelPanel.addEventListener("click", handleModelPanelClick);
  els.modelPanel.addEventListener("change", handleModelPanelChange);
  els.modelConfigPanel.addEventListener("click", handleModelConfigPanelClick);
  els.modelConfigPanel.addEventListener("input", handleModelConfigInput);
  els.modelConfigPanel.addEventListener("change", handleModelConfigChange);
  els.modelConfigPanel.addEventListener("submit", saveModelConfig);
  els.settingsButton?.addEventListener("click", () => {
    if (state.settingsOpen) hideSettingsWorkspace();
    else showSettingsWorkspace();
  });
  els.settingsBack?.addEventListener("click", () => hideSettingsWorkspace());
  els.settingsRail?.addEventListener("click", handleSettingsRailClick);
  els.settingsContent?.addEventListener("click", handleSettingsClick);
  els.settingsContent?.addEventListener("input", handleSettingsFormChange);
  els.settingsContent?.addEventListener("change", handleSettingsFormChange);
  els.settingsContent?.addEventListener("submit", saveSettingsConfig);
  els.liveSubtasks.addEventListener("click", (event: Event) => {
    const button = eventTargetOf(event).closest("button[data-background-cancel]");
    if (!button) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    cancelBackgroundSubagent(button.dataset.groupId, button.dataset.taskId);
  });
  document.addEventListener("click", (event: Event) => {
    if (!state.modelPanelOpen) {
      return;
    }
    if (eventTargetOf(event).closest("#model-panel") || eventTargetOf(event).closest("#model-config-panel") || eventTargetOf(event).closest("#model-status-toggle")) {
      return;
    }
    hideModelPanel();
  });
  els.transcript.addEventListener("scroll", handleTranscriptScroll);
  els.workflowStrip.addEventListener("click", (event: Event) => {
    if (!eventTargetOf(event).closest("button[data-action='toggle-workflow']")) {
      return;
    }
    state.workflowExpanded = !state.workflowExpanded;
    renderWorkflowStrip();
  });
  els.activityToggle.addEventListener("click", toggleLiveStatusDetails);
  els.transcriptJump.addEventListener("click", followTranscript);
  els.responsiveNavigation.querySelectorAll("button[data-dashboard-view]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.dashboardView === "settings") {
        showSettingsWorkspace();
        return;
      }
      if (state.settingsOpen) hideSettingsWorkspace({ restoreFocus: false });
      setResponsiveView(button.dataset.dashboardView);
    });
  });
  els.responsiveScrim.addEventListener("click", () => setResponsiveView("conversation"));
  els.threadList.addEventListener("click", (event: Event) => {
    if (eventTargetOf(event).closest(".thread-open")) {
      setResponsiveView("conversation");
    }
  });
  document.addEventListener("click", handleResponsiveFileNavigation);
  els.connectionStatus?.addEventListener("click", reconnectEventsManually);
  window.addEventListener?.("online", () => {
    if (state.currentSessionId && state.connectionState !== "connected") {
      reconnectEventsManually();
    }
  });
  window.addEventListener?.("offline", () => {
    clearEventReconnectTimer();
    closeEventSource();
    setConnectionState("offline");
  });
  window.addEventListener?.("resize", () => {
    syncResponsiveNavigation();
    setPreviewWidth(state.previewPreferredWidth, { updatePreference: false });
  });
  window.visualViewport?.addEventListener?.("resize", syncVisualViewport);
  window.visualViewport?.addEventListener?.("scroll", syncVisualViewport);
  resizePromptInput();
  syncVisualViewport();
  syncResponsiveNavigation();
}

export function normalizedResponsiveView(width: unknown, requestedView: unknown) {
  if (requestedView === "settings") return "settings";
  if (Number(width) >= 1200) return "conversation";
  return typeof requestedView === "string" && ["sessions", "conversation", "files"].includes(requestedView)
    ? requestedView
    : "conversation";
}

export function composerHeightFor(scrollHeight: unknown, minimum: unknown = 52, maximum: unknown = 160) {
  const measured = Number(scrollHeight);
  const safeMinimum = Math.max(1, Number(minimum) || 52);
  const safeMaximum = Math.max(safeMinimum, Number(maximum) || 160);
  return Math.min(safeMaximum, Math.max(safeMinimum, Number.isFinite(measured) ? measured : safeMinimum));
}

/**
 * @param {number} viewportWidth
 * @param {boolean} [sidebarCollapsed]
 * @returns {{ min: number; max: number }}
 */
export function previewWidthBounds(viewportWidth: number, sidebarCollapsed: boolean = false) {
  const viewport = Math.max(0, Number(viewportWidth) || 0);
  const sidebarWidth = sidebarCollapsed ? 56 : 280;
  const available = viewport - 20 - 20 - sidebarWidth - PREVIEW_WORKSPACE_MIN;
  return {
    min: PREVIEW_WIDTH_MIN,
    max: Math.max(PREVIEW_WIDTH_MIN, Math.min(PREVIEW_WIDTH_MAX, available))
  };
}

/**
 * @param {number} width
 * @param {{ min?: number; max?: number }} bounds
 * @returns {number}
 */
export function clampedPreviewWidth(width: number, bounds: { min?: number; max?: number }) {
  const minimum = Math.max(0, Number(bounds?.min) || PREVIEW_WIDTH_MIN);
  const maximum = Math.max(minimum, Number(bounds?.max) || PREVIEW_WIDTH_MAX);
  const value = Number(width);
  return Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : PREVIEW_WIDTH_DEFAULT));
}

export function permissionIndexForKey(currentIndex: number, key: string, length: unknown) {
  const count = Math.max(0, Number(length) || 0);
  if (count === 0) return -1;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "ArrowRight" || key === "ArrowDown") return (Math.max(0, currentIndex) + 1) % count;
  if (key === "ArrowLeft" || key === "ArrowUp") return (Math.max(0, currentIndex) - 1 + count) % count;
  return currentIndex;
}

export function focusTrapTarget(focusables: ArrayLike<Element> | Iterable<Element> | null | undefined, activeElement: Element | null | undefined, shiftKey: unknown = false) {
  const items = Array.from(focusables ?? []);
  if (items.length === 0) return null;
  const current = activeElement ? items.indexOf(activeElement) : -1;
  if (current < 0) return shiftKey ? items.at(-1) : items[0];
  return items[(current + (shiftKey ? -1 : 1) + items.length) % items.length];
}

export function shouldFollowTranscript({ force = false, following = true, onlyIfNearBottom = false, wasAtBottom = true }: { force?: boolean; following?: boolean; onlyIfNearBottom?: boolean; wasAtBottom?: boolean } = {}) {
  if (force) return true;
  if (!following) return false;
  return !onlyIfNearBottom || wasAtBottom !== false;
}

export function scheduleAnimationFrameOnce(holder: Record<string, unknown>, key: string, callback: () => void, scheduler: (cb: FrameRequestCallback) => number = requestAnimationFrame) {
  if (holder[key] != null) return false;
  const frame = scheduler(() => {
    holder[key] = null;
    callback();
  });
  holder[key] = frame ?? true;
  return true;
}

export function cancelScheduledAnimationFrame(holder: Record<string, unknown>, key: string, cancel: (handle: number) => void = cancelAnimationFrame) {
  const frame = holder[key];
  if (frame == null) return false;
  holder[key] = null;
  if (frame !== true) cancel(Number(frame));
  return true;
}

export function appendPlainDraftDelta(body: HTMLElement | null | undefined, text: unknown, renderedLength: unknown = 0, createTextNode: (value: string) => Text = (value) => document.createTextNode(value)) {
  const value = String(text ?? "");
  const start = Math.min(value.length, Math.max(0, Number(renderedLength) || 0));
  const pending = value.slice(start);
  if (pending) {
    if (typeof body?.append === "function") body.append(createTextNode(pending));
    else if (body) body.textContent = `${body.textContent ?? ""}${pending}`;
  }
  return value.length;
}

export function renderFinalAssistantBody(body: HTMLElement | null | undefined, text: string | null | undefined, renderer: (body: HTMLElement | null | undefined, text: string, options?: { markdown?: boolean }) => unknown = renderMessageText) {
  renderer(body, text ?? "", { markdown: true });
}

export function selectTranscriptNodesToRemove(nodes: ArrayLike<Element> | Iterable<Element> | null | undefined, limit: unknown, direction: unknown = "append", isProtected: (node: Element) => boolean = () => false) {
  const values = Array.from(nodes ?? []);
  let overflow = Math.max(0, values.length - Math.max(0, Number(limit) || 0));
  if (overflow === 0) return [];
  const ordered = direction === "prepend" ? values.slice().reverse() : values;
  const selected = [];
  for (const node of ordered) {
    if (overflow === 0) break;
    if (isProtected(node)) continue;
    selected.push(node);
    overflow -= 1;
  }
  return selected;
}

export function responsiveLayoutMode() {
  const width = Number(window.innerWidth) || Number(document.documentElement?.clientWidth) || 1200;
  if (width >= 1200) return "desktop";
  return width >= 768 ? "tablet" : "mobile";
}

export function restorePreviewWidth() {
  let saved = PREVIEW_WIDTH_DEFAULT;
  try {
    saved = Number(window.localStorage?.getItem(PREVIEW_WIDTH_STORAGE_KEY)) || PREVIEW_WIDTH_DEFAULT;
  } catch {
    // Local storage can be unavailable in hardened browser contexts.
  }
  setPreviewWidth(saved);
}

/**
 * @param {number} width
 * @param {{ persist?: boolean; announce?: boolean; updatePreference?: boolean }} [options]
 * @returns {number}
 */
export function setPreviewWidth(width: number, options: { persist?: boolean; announce?: boolean; updatePreference?: boolean } = {}) {
  const bounds = previewWidthBounds(Number(window.innerWidth) || 1200, state.sidebarCollapsed);
  if (options.updatePreference !== false) {
    state.previewPreferredWidth = clampedPreviewWidth(width, { min: PREVIEW_WIDTH_MIN, max: PREVIEW_WIDTH_MAX });
  }
  state.previewWidth = clampedPreviewWidth(state.previewPreferredWidth, bounds);
  document.documentElement?.style?.setProperty("--preview-width", `${state.previewWidth}px`);
  syncPreviewResizeHandle(bounds);
  if (options.persist) {
    try {
      window.localStorage?.setItem(PREVIEW_WIDTH_STORAGE_KEY, String(state.previewPreferredWidth));
    } catch {
      // Local storage can be unavailable in hardened browser contexts.
    }
  }
  if (options.announce) announceStatus(`文件栏宽度 ${state.previewWidth} 像素`);
  return state.previewWidth;
}

export function syncPreviewResizeHandle(bounds: { min?: number; max?: number } = previewWidthBounds(Number(window.innerWidth) || 1200, state.sidebarCollapsed)) {
  const handle = els.previewResizeHandle;
  if (!handle) return;
  handle.setAttribute("aria-valuemin", String(bounds.min));
  handle.setAttribute("aria-valuemax", String(bounds.max));
  handle.setAttribute("aria-valuenow", String(state.previewWidth));
  handle.setAttribute("aria-valuetext", `${state.previewWidth} 像素`);
  handle.setAttribute("aria-disabled", responsiveLayoutMode() !== "desktop" || document.body.classList.contains("preview-collapsed") ? "true" : "false");
}

/** @param {PointerEvent} event */
export function beginPreviewResize(event: PointerEvent) {
  const handle = els.previewResizeHandle;
  if (!handle) return;
  if (responsiveLayoutMode() !== "desktop" || document.body.classList.contains("preview-collapsed")) return;
  event.preventDefault();
  state.previewResizeStartX = Number(event.clientX);
  state.previewResizeStartWidth = state.previewWidth;
  handle.setPointerCapture?.(event.pointerId);
  document.body.classList.add("preview-resizing");
}

/** @param {PointerEvent} event */
export function updatePreviewResize(event: PointerEvent) {
  if (state.previewResizeStartX === null || state.previewResizeStartWidth === null) return;
  const delta = Number(event.clientX) - state.previewResizeStartX;
  setPreviewWidth(state.previewResizeStartWidth - delta);
}

/** @param {PointerEvent} event */
export function finishPreviewResize(event: PointerEvent) {
  const handle = els.previewResizeHandle;
  if (!handle) return;
  if (state.previewResizeStartX === null) return;
  handle.releasePointerCapture?.(event.pointerId);
  state.previewResizeStartX = null;
  state.previewResizeStartWidth = null;
  document.body.classList.remove("preview-resizing");
  setPreviewWidth(state.previewWidth, { persist: true, announce: true });
}

/** @param {KeyboardEvent} event */
export function handlePreviewResizeKeydown(event: KeyboardEvent) {
  if (responsiveLayoutMode() !== "desktop" || document.body.classList.contains("preview-collapsed")) return;
  let next = state.previewWidth;
  const step = event.shiftKey ? 48 : 16;
  if (event.key === "ArrowLeft") next += step;
  else if (event.key === "ArrowRight") next -= step;
  else if (event.key === "Home") next = previewWidthBounds(Number(window.innerWidth) || 1200, state.sidebarCollapsed).min;
  else if (event.key === "End") next = previewWidthBounds(Number(window.innerWidth) || 1200, state.sidebarCollapsed).max;
  else return;
  event.preventDefault();
  setPreviewWidth(next, { persist: true, announce: true });
}

export function setResponsiveView(view: unknown) {
  if (view !== "settings" && state.settingsOpen) {
    hideSettingsWorkspace({ restoreFocus: false });
  }
  state.responsiveView = normalizedResponsiveView(Number(window.innerWidth) || 1200, view);
  syncResponsiveNavigation();
}

export function syncResponsiveNavigation() {
  const width = Number(window.innerWidth) || Number(document.documentElement?.clientWidth) || 1200;
  const view = normalizedResponsiveView(width, state.responsiveView);
  state.responsiveView = view;
  if (width < 1200) {
    state.sidebarCollapsed = false;
    document.body.classList.remove("sidebar-collapsed", "preview-collapsed");
  }
  document.body.dataset.dashboardView = view;
  els.responsiveNavigation?.querySelectorAll("button[data-dashboard-view]").forEach((button) => {
    const active = button.dataset.dashboardView === (state.settingsOpen ? "settings" : view);
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  if (state.modalContext) return;
  const desktop = width >= 1200;
  setResponsiveSurfaceInert(els.sidebar, !desktop && view !== "sessions");
  setResponsiveSurfaceInert(els.workspace, !desktop && !["conversation", "settings"].includes(view));
  setResponsiveSurfaceInert(els.preview, !desktop && view !== "files");
}

export function setResponsiveSurfaceInert(element: HTMLElement | null | undefined, inert: unknown) {
  if (!element) return;
  element.inert = Boolean(inert);
}

export function handleResponsiveFileNavigation(event: Event) {
  if (responsiveLayoutMode() === "desktop") return;
  if (eventTargetOf(event).closest(".file-item, .file-link, [data-file]")) {
    setResponsiveView("files");
  }
}

export function syncVisualViewport() {
  const viewportHeight = Number(window.visualViewport?.height) || Number(window.innerHeight) || 0;
  if (viewportHeight > 0) {
    document.documentElement?.style?.setProperty("--dashboard-viewport-height", `${Math.round(viewportHeight)}px`);
  }
  const keyboardVisible = Boolean(window.visualViewport) && Number(window.innerHeight) - viewportHeight > 120;
  document.body.classList.toggle("keyboard-visible", keyboardVisible);
}

export function resizePromptInput() {
  if (!els.promptInput) return;
  els.promptInput.style.height = "auto";
  const height = composerHeightFor(els.promptInput.scrollHeight);
  els.promptInput.style.height = `${height}px`;
  els.promptInput.style.overflowY = Number(els.promptInput.scrollHeight) > height ? "auto" : "hidden";
}

export function handlePermissionModeKeydown(event: KeyboardEvent) {
  const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];
  if (!keys.includes(event.key)) return;
  const buttons = Array.from(els.permissionMode.querySelectorAll("button[data-mode]"));
  const current = Math.max(0, buttons.indexOf(eventTargetOf(event).closest("button[data-mode]")));
  const next = permissionIndexForKey(current, event.key, buttons.length);
  const button = buttons[next];
  if (!button) return;
  event.preventDefault();
  event.stopPropagation();
  button.focus();
  requestPermissionMode(button.dataset.mode, button);
}

/** @param {string} mode @param {Element | null} [trigger] */
export function requestPermissionMode(mode: string | undefined, trigger: Element | null = document.activeElement) {
  if (state.goal.enabled && mode !== "fullAccess") {
    showError("Goal 开启时不能降低权限。请先退出 Goal。");
    return;
  }
  if (mode === "fullAccess" && state.permissionMode !== "fullAccess") {
    showPermissionConfirm(trigger);
    return;
  }
  hidePermissionConfirm({ restoreFocus: false });
  setPermissionMode(mode);
}

export function defaultGoalMaxAutoContinues() {
  const value = Number(state.settings?.agents?.goalMaxAutoContinues);
  return Number.isInteger(value) && value >= 1 && value <= 100 ? value : 12;
}

export function emptyGoalSnapshot() {
  return {
    enabled: false,
    status: "off",
    text: "",
    previousPermissionMode: "plan",
    roundCount: 0,
    continueCount: 0,
    maxAutoContinues: defaultGoalMaxAutoContinues(),
    lastContinueReason: "",
    lastBlockReason: "",
    lastEvidence: null,
    hasWrites: false,
    recap: null
  };
}

/** @param {Record<string, any> | null | undefined} goal @param {{ permissionMode?: string }} [options] */
export function applyGoalSnapshot(goal: Record<string, unknown> | null | undefined, options: { permissionMode?: string } = {}) {
  const snapshot = isPlainObject(goal) ? goal : {};
  const enabled = snapshot.enabled === true;
  state.goal = {
    ...emptyGoalSnapshot(),
    enabled,
    text: String(snapshot.text ?? ""),
    status: enabled ? String(snapshot.status || "active") : "off",
    previousPermissionMode: String(snapshot.previousPermissionMode ?? state.goal.previousPermissionMode ?? "plan"),
    roundCount: Number(snapshot.roundCount) || 0,
    continueCount: Number(snapshot.continueCount) || 0,
    maxAutoContinues: Number(snapshot.maxAutoContinues) || defaultGoalMaxAutoContinues(),
    lastContinueReason: String(snapshot.lastContinueReason ?? ""),
    lastBlockReason: String(snapshot.lastBlockReason ?? ""),
    lastEvidence: snapshot.lastEvidence ?? null,
    hasWrites: snapshot.hasWrites === true,
    recap: isPlainObject(snapshot.recap) ? snapshot.recap : null
  };
  const permissionSource = options.permissionMode || (state.goal.enabled ? "fullAccess" : state.permissionMode);
  if (state.goal.enabled) {
    setPermissionMode("fullAccess");
  } else if (options.permissionMode) {
    setPermissionMode(options.permissionMode);
  } else {
    setPermissionMode(permissionSource);
  }
  renderGoalControls();
  syncPromptPlaceholder();
}

const DEFAULT_PROMPT_PLACEHOLDER = "输入任务需求，例如：整理这批实验数据并生成一份简洁报告";

function syncPromptPlaceholder() {
  if (!els.promptInput) return;
  els.promptInput.placeholder = DEFAULT_PROMPT_PLACEHOLDER;
}

export function renderGoalControls() {
  const enabled = state.goal.enabled === true;
  const readonlyLocked = state.sessionStatus?.readonlyLocked === true || state.trust?.readonlyLocked === true;
  if (els.goalMode) {
    els.goalMode.setAttribute("aria-pressed", String(enabled));
    els.goalMode.classList.toggle("active", enabled);
    els.goalMode.disabled = readonlyLocked && !enabled;
    els.goalMode.title = readonlyLocked && !enabled ? "只读锁定会话不能启用 Goal" : "Goal 模式";
  }
  document.body.classList.toggle("goal-mode-active", enabled);
  els.permissionMode?.querySelectorAll("button[data-mode]").forEach((button) => {
    button.disabled = enabled && button.dataset.mode !== "fullAccess";
  });
  if (enabled) {
    els.modeDescription.textContent = MODE_DESCRIPTIONS.goal;
  }
  renderGoalStatusBar();
}

export function renderGoalStatusBar() {
  const bar = els.goalStatusBar;
  if (!bar) return;
  if (!state.goal.enabled) {
    bar.classList.add("hidden");
    bar.replaceChildren();
    return;
  }
  bar.classList.remove("hidden");
  const statusLabel = {
    active: "进行中",
    running: "进行中",
    paused: "已暂停",
    verifying: "核验中",
    complete: "已完成",
    failed: "失败",
    off: "关闭"
  }[state.goal.status] ?? state.goal.status;
  const recapLine = String(state.goal.recap?.line ?? "").trim();
  const showRecap = recapLine.length > 0;
  const canResume = state.goal.status === "paused" || state.goal.status === "failed";
  const showPause = !canResume && state.goal.status !== "complete";
  const objectiveClass = ["goal-objective", showRecap ? "goal-objective-ellipsis" : ""].filter(Boolean).join(" ");
  const continueReason = String(state.goal.lastContinueReason ?? "").trim();
  bar.innerHTML = `
    <div class="goal-copy">
      <div class="goal-title">Goal · ${escapeHtml(statusLabel)}</div>
      <div class="${objectiveClass}" title="${escapeHtml(state.goal.text || "")}">${escapeHtml(state.goal.text || "")}</div>
      ${showRecap
    ? `<div class="goal-recap">${escapeHtml(recapLine)}</div>`
    : `<div class="goal-continue-meta">${Number(state.goal.continueCount) || 0} / ${Number(state.goal.maxAutoContinues) || defaultGoalMaxAutoContinues()} 次续跑${continueReason ? ` · ${escapeHtml(continueReason)}` : ""}</div>`}
    </div>
    <div class="goal-status-actions">
      ${canResume ? `<button type="button" data-goal-action="resume">继续</button>` : ""}
      ${showPause ? `<button type="button" data-goal-action="pause">暂停</button>` : ""}
      <button type="button" data-goal-action="disable">退出 Goal</button>
    </div>
  `;
  bar.querySelectorAll("[data-goal-action]").forEach((button) => {
    button.addEventListener("click", () => submitGoalAction(String(button.dataset.goalAction ?? "")));
  });
}

export function requestGoalMode() {
  if (state.goal.enabled) {
    submitGoalAction("disable");
    return;
  }
  if (!state.trust?.trusted) {
    showTrustPanel();
    return;
  }
  showGoalConfirm(els.goalMode);
}

/** @param {HTMLElement | null} [trigger] */
export function showGoalConfirm(trigger: HTMLElement | null) {
  const panel = els.goalConfirmPanel;
  if (!panel) return;
  panel.classList.remove("hidden");
  panel.innerHTML = `
    <div>
      <div class="context-title" id="goal-confirm-title">启用 Goal 模式？</div>
      <div class="context-copy">Goal 模式会在本会话朝着你给出的目标自动连续执行，直到完成、暂停、失败或预算用尽。<br><br>开启后当前会话将使用「完全访问」：本机工具、工作区外文件和网络操作将自动获准，并且不会在每个工具调用时停下等你批准。<br><br>这是无人值守自动执行，不是普通聊天。请确认本机工作区可被连续修改。你随时可以暂停、中断或退出 Goal。</div>
    </div>
    <div class="context-confirm-actions">
      <button type="button" data-action="cancel">取消</button>
      <button type="button" data-action="confirm" class="danger">确认 Goal 并完全访问</button>
    </div>
  `;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-labelledby", "goal-confirm-title");
  panel.setAttribute("tabindex", "-1");
  panel.querySelector("button[data-action='cancel']")?.addEventListener("click", () => hideGoalConfirm());
  panel.querySelector("button[data-action='confirm']")?.addEventListener("click", () => {
    hideGoalConfirm({ restoreFocus: false });
    showGoalTextPanel(trigger);
  });
  activateModal(panel, { initialFocus: "button[data-action='cancel']", returnFocus: trigger });
}

/** @param {Record<string, any>} [options] */
export function hideGoalConfirm(options: Record<string, unknown> = {}) {
  const panel = els.goalConfirmPanel;
  if (!panel || panel.classList.contains("hidden")) return;
  deactivateModal(panel, options);
  panel.classList.add("hidden");
  panel.replaceChildren();
}

/** @param {HTMLElement | null} [trigger] */
export function showGoalTextPanel(trigger: HTMLElement | null) {
  const panel = els.goalTextPanel;
  if (!panel) return;
  panel.classList.remove("hidden");
  panel.innerHTML = `
    <div>
      <div class="context-title" id="goal-text-title">输入 Goal 目标</div>
      <div class="context-copy">用一句话写清要完成的目标。提交后才会进入无人值守执行。</div>
      <label class="visually-hidden" for="goal-objective-input">目标</label>
      <textarea id="goal-objective-input" rows="3" placeholder="例如：给会话列表加上运行态筛选并补测试"></textarea>
      <div class="context-copy" id="goal-text-error" hidden>请输入目标</div>
    </div>
    <div class="context-confirm-actions">
      <button type="button" data-action="cancel">取消</button>
      <button type="button" data-action="confirm" class="danger">开始 Goal</button>
    </div>
  `;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-labelledby", "goal-text-title");
  const input = panel.querySelector("#goal-objective-input");
  panel.querySelector("button[data-action='cancel']")?.addEventListener("click", () => hideGoalTextPanel());
  panel.querySelector("button[data-action='confirm']")?.addEventListener("click", () => {
    const text = String(input?.value ?? "").trim();
    if (!text) {
      const error = panel.querySelector("#goal-text-error");
      if (error) error.hidden = false;
      input?.focus();
      return;
    }
    hideGoalTextPanel({ restoreFocus: false });
    enableGoalWithObjective(text);
  });
  activateModal(panel, { initialFocus: "#goal-objective-input", returnFocus: trigger });
}

/** @param {Record<string, any>} [options] */
export function hideGoalTextPanel(options: Record<string, unknown> = {}) {
  const panel = els.goalTextPanel;
  if (!panel || panel.classList.contains("hidden")) return;
  deactivateModal(panel, options);
  panel.classList.add("hidden");
  panel.replaceChildren();
}

/** @param {string} text */
export async function enableGoalWithObjective(text: string) {
  const previous = state.permissionMode;
  applyGoalSnapshot({
    enabled: true,
    status: "active",
    text,
    previousPermissionMode: previous
  });
  if (!state.currentSessionId) {
    if (currentSessionNeedsModelSelection()) {
      applyGoalSnapshot(null, { permissionMode: previous });
      showError("请先重新选择模型来源和模型");
      return;
    }
    state.turnSubmitting = true;
    updateSendButton();
    els.runStatus.textContent = "启动中";
    let result;
    try {
      result = await postJson("/api/turns", {
        requestId: dashboardRequestId(),
        prompt: text,
        permissionMode: "fullAccess",
        goalMode: true,
        goalText: text,
        clientPreviousPermissionMode: previous,
        clientId: dashboardClientId()
      });
    } catch (error) {
      result = { ok: false, error: errorMessageOf(error) };
    } finally {
      state.turnSubmitting = false;
      updateSendButton();
    }
    if (!result.ok) {
      applyGoalSnapshot(null, { permissionMode: previous });
      if (result.trust) {
        state.trust = result.trust;
        renderTrustPanel();
      }
      showError(result.error ?? "Goal 启动失败");
      els.runStatus.textContent = result.status === 403 ? "待信任" : "失败";
      updateSendButton();
      return;
    }
    adoptGoalRunResult(result);
    await loadSessions();
    return;
  }
  await submitGoalAction("enable", { objective: text });
}

/** @param {string} action @param {Record<string, any>} [extra] */
export async function submitGoalAction(action: string, extra: Record<string, unknown> = {}) {
  if (state.goalSubmitting) return;
  if (!state.currentSessionId) {
    if (action === "disable" || action === "clear") {
      applyGoalSnapshot(null, { permissionMode: state.goal.previousPermissionMode || "plan" });
    }
    return;
  }
  state.goalSubmitting = true;
  const result = await postJson("/api/goal", {
    sessionId: state.currentSessionId,
    action,
    objective: extra.objective,
    clientPreviousPermissionMode: state.goal.enabled
      ? state.goal.previousPermissionMode
      : state.permissionMode,
    permissionMode: state.permissionMode
  }).catch((error: unknown): DashboardApiResult => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  state.goalSubmitting = false;
  if (!result.ok) {
    showError(result.error ?? "Goal 操作失败");
    return;
  }
  adoptGoalRunResult(result);
  if (result.running === true) {
    await loadSessions();
  }
}

/** @param {Record<string, any>} result */
export function adoptGoalRunResult(result: DashboardApiResult) {
  applyGoalSnapshot(result.goal ?? state.goal, { permissionMode: result.permission?.mode ?? state.permissionMode });
  if (result.sessionStatus) {
    updateSessionStatus(result.sessionStatus);
  }
  state.queue = result.queue ?? state.queue;
  renderQueuePanel();
  const previousSessionId = state.currentSessionId;
  if (result.sessionId) {
    state.currentSessionId = result.sessionId;
    rememberCurrentSession(result.sessionId);
    if (previousSessionId !== result.sessionId) {
      resetEventReplayState();
    }
    rememberEventCursor(result.eventCursor);
    ensureEventsConnected(result.sessionId);
  }
  if (result.running === true) {
    state.running = true;
    els.runStatus.textContent = "运行中";
    setLiveTitle("正在推进 Goal");
  }
  updateSendButton();
}

export function showPermissionConfirm(trigger: Element | null = document.activeElement) {
  const panel = els.permissionConfirmPanel;
  if (!panel) return;
  panel.classList.remove("hidden");
  panel.innerHTML = `
    <div>
      <div class="context-title" id="permission-confirm-title">启用完全访问？</div>
      <div class="context-copy">当前会话的本机工具、工作区外文件和网络操作将自动获准，直到你切换权限或离开该会话。</div>
    </div>
    <div class="context-confirm-actions">
      <button type="button" data-action="cancel">取消</button>
      <button type="button" data-action="confirm" class="danger">确认完全访问</button>
    </div>
  `;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-labelledby", "permission-confirm-title");
  panel.setAttribute("tabindex", "-1");
  panel.querySelector("button[data-action='cancel']")?.addEventListener("click", () => hidePermissionConfirm());
  panel.querySelector("button[data-action='confirm']")?.addEventListener("click", () => {
    hidePermissionConfirm({ restoreFocus: false });
    setPermissionMode("fullAccess");
    els.permissionMode.querySelector("button[data-mode='fullAccess']")?.focus();
  });
  activateModal(panel, { initialFocus: "button[data-action='cancel']", returnFocus: trigger });
}

export function hidePermissionConfirm(options: Record<string, unknown> = {}) {
  const panel = els.permissionConfirmPanel;
  if (!panel || panel.classList.contains("hidden")) return;
  deactivateModal(panel, options);
  panel.classList.add("hidden");
  panel.replaceChildren();
}

export function updateContextActions() {
  const noSession = !state.currentSessionId;
  const busy = state.running || state.turnSubmitting;
  const disabled = noSession || busy;
  const hint = noSession
    ? "请先打开一个空闲会话"
    : busy
      ? "任务运行期间不能清空或压缩上下文"
      : "可管理当前会话上下文";
  for (const button of [els.contextClear, els.contextCompact]) {
    if (!button) continue;
    button.disabled = disabled;
    button.title = hint;
  }
  if (els.contextActionHint) els.contextActionHint.textContent = hint;
}

export function announceStatus(message: string | null | undefined) {
  if (!els.dashboardLiveRegion || !message) return;
  els.dashboardLiveRegion.textContent = "";
  requestAnimationFrame(() => {
    els.dashboardLiveRegion.textContent = String(message);
  });
}

export const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

export function modalFocusableElements(modal: HTMLElement | null | undefined): HTMLElement[] {
  if (!modal) return [];
  return Array.from(modal.querySelectorAll(FOCUSABLE_SELECTOR)).filter((node) => (
    node.getAttribute("aria-hidden") !== "true" && !node.closest("[inert]")
  ));
}

