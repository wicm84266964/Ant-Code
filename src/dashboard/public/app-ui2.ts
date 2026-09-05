import { renderMarkdown } from "./markdown.ts";
import { hydrateRichContent } from "./rich-renderers.ts";
import { visibleTranscriptRole } from "./transcript.ts";
import { MANUAL_AGENT_MODEL_VALUE, state, els, MODE_DESCRIPTIONS, LOCAL_FILE_EXTENSIONS, FILE_REFERENCE_PATTERN, TRANSCRIPT_DOM_LIMIT, EVENT_STALE_AFTER_MS, EVENT_CONNECT_TIMEOUT_MS, EVENT_RECONNECT_MAX_ATTEMPTS, DASHBOARD_REQUEST_TIMEOUT_MS, DASHBOARD_API_VERSION, DASHBOARD_LIFECYCLE_TIMEOUT_MS, DASHBOARD_SHUTDOWN_TIMEOUT_MS, DASHBOARD_INTERRUPT_TIMEOUT_MS, MAX_IMAGE_ATTACHMENTS, MAX_IMAGE_ATTACHMENT_BYTES, MAX_DOCUMENT_ATTACHMENTS, MAX_DOCUMENT_ATTACHMENT_BYTES, DOCUMENT_EXTENSIONS, IMAGE_EXTENSIONS, CURRENT_SESSION_STORAGE_KEY, DASHBOARD_CLIENT_STORAGE_KEY, PREVIEW_WIDTH_STORAGE_KEY, PREVIEW_WIDTH_DEFAULT, PREVIEW_WIDTH_MIN, PREVIEW_WIDTH_MAX, PREVIEW_WORKSPACE_MIN , emptySessionStatus, emptyBackgroundSubagent } from "./app-core.ts";
import type { DashboardConfigSource, DashboardReasoningEffort, DashboardTurnChangeStats, DashboardScopedDefaultSelection, DashboardVisionAgent, DashboardReasoningDiscovery, DashboardReasoningCapabilityCandidate, DashboardGatewayProbeModel, DashboardGatewayProbeResult, DashboardLifecycleActivity, DashboardSettings, DashboardFile, DashboardTableSheet, DashboardTablePreview, DashboardLightboxItem, DashboardQuestionChoice, DashboardPendingQuestion, DashboardApproval, DashboardGatewayTransport, DashboardScopedRequest, DashboardFetchOptions, DashboardModelSource, DashboardSessionStatus, DashboardApiResult, DashboardActivity, DashboardModelOption, DashboardGatewayProfile, DashboardGatewayConfig, DashboardModelSelection, DashboardPendingGuide, DashboardStreamEvent, DashboardUiState , DashboardSessionSummary } from "./app-core.ts";
import { eventTargetOf, eventElement, isPlainObject, modelSourceOf, errorMessageOf, init, bootstrapDashboard, observeRunStatus, updateRunStatusTone, bindEvents, normalizedResponsiveView, composerHeightFor, previewWidthBounds, clampedPreviewWidth, permissionIndexForKey, focusTrapTarget, shouldFollowTranscript, scheduleAnimationFrameOnce, cancelScheduledAnimationFrame, appendPlainDraftDelta, renderFinalAssistantBody, selectTranscriptNodesToRemove, responsiveLayoutMode, restorePreviewWidth, setPreviewWidth, syncPreviewResizeHandle, beginPreviewResize, updatePreviewResize, finishPreviewResize, handlePreviewResizeKeydown, setResponsiveView, syncResponsiveNavigation, setResponsiveSurfaceInert, handleResponsiveFileNavigation, syncVisualViewport, resizePromptInput, handlePermissionModeKeydown, requestPermissionMode, defaultGoalMaxAutoContinues, emptyGoalSnapshot, applyGoalSnapshot, renderGoalControls, renderGoalStatusBar, requestGoalMode, showGoalConfirm, hideGoalConfirm, showGoalTextPanel, hideGoalTextPanel, enableGoalWithObjective, submitGoalAction, adoptGoalRunResult, showPermissionConfirm, hidePermissionConfirm, updateContextActions, announceStatus, modalFocusableElements, cancelBackgroundSubagent, backgroundCancelKey, connectEvents, ensureEventsConnected, disconnectEvents, closeEventSource, markEventConnectionAlive, armEventConnectTimer, armEventStaleTimer, scheduleEventReconnect, reconnectEventsManually, clearEventReconnectTimer, clearEventConnectTimer, clearEventStaleTimer, setConnectionState, resetEventReplayState, rememberEventCursor, handleDashboardEvent, shouldSkipDashboardEvent, beginEventTurn, renderTranscriptMessages, renderSessionFailure, setTranscriptPaging, renderTranscriptHistoryStatus, removeTranscriptHistoryStatus, transcriptFirstContentNode, handleTranscriptScroll, loadOlderTranscript, renderWorkflowPanel, renderWorkflowStrip, currentWorkflowItem, workflowSection, workflowItem, normalizeWorkflowStatus, summarizeWorkflow, appendMessage, createMessageNode, appendTranscriptNode, trimTranscriptWindow, isProtectedTranscriptNode, renderTranscriptWindowMarker, captureTranscriptViewportAnchor, restoreTranscriptViewportAnchor, transcriptNodeTop, restoreTranscriptNodeAnchor, resetTranscriptWindow, appendAssistantDraft, scheduleDraftRender, renderAssistantDraft, appendActivity, appendContextBoundary, contextBoundaryText, handleActivity, isBackgroundSubagentActivity, handleBackgroundSubagentActivity, clearBackgroundSubagentStatus, reconcileBackgroundSubagentSnapshot, backgroundSubagentDisplayStatus, backgroundSubagentVisible, updateLiveActivity, removeLiveActivity, setLiveTitle, toggleLiveStatusDetails, updateLiveStatus, liveStatusTitle, primaryLiveActivity, gatewayRetryChipText, renderBackgroundSubagentStatus, backgroundSubagentCompactLabel, backgroundSubagentTitle, backgroundSubagentMeta, backgroundSubagentCancellable, resetLiveStatus, backgroundSubagentCounts, idleRunStatus, applyIdleRunStatus, updateRunStatusForBackground, updateSessionStatus, updateTurnChangeStats, resetTurnChangeStats, normalizeChangeStats, renderComposerStatus, modelStatusHtml, unresolvedModelStatusHtml, handleModelStatusActivate, handleModelStatusKeydown, toggleModelPanel, hideModelPanel, showSettingsWorkspace, refreshSettingsConfiguration, hideSettingsWorkspace, showModelConfigPanel, hideModelConfigPanel, renderModelPanel, modelCapabilityLabels, handleModelPanelClick, handleModelPanelChange, renderSettingsView, syncSettingsRail, modelSettingsHtml, transcriptSettingsHtml, transcriptRetentionOptionsHtml, networkSettingsHtml, networkModeOptionHtml, agentSettingsHtml, reliabilitySettingsHtml, settingsSectionHeading, settingsToggleHtml, managedFieldHtml, settingsDisabled, settingsFormActions, settingsFeedbackHtml, settingsGatewayProfileHtml, gatewayProfileReadonlyLabel, providerModelKey, scopedDefaultModelLabel, settingsModelHtml, handleSettingsRailClick, initializeSettingsFormTracking, handleSettingsFormChange, settingsControlValue, changedSettingsFields, canonicalSettingsField, setSettingsFormSaving, renderSettingsFeedbackInPlace, saveSettingsConfig, handleSettingsClick, protocolDisplayName, agentModelPickerHtml, renderModelConfigPanel, handleModelConfigPanelClick, handleModelConfigInput, handleModelConfigChange, markModelConfigCredentialChanged, markModelConfigEndpointChanged, handleModelConfigModelIdChanged, markReasoningCapabilityManual, clearReasoningCapabilityControls, syncGatewayUrlHint, gatewayUrlPlaceholder, gatewayUrlHint, syncReasoningDefaultOptions, probeGateway, isCurrentModelConfigRequest, currentGatewayProbeResult, currentGatewayCatalogModels, modelConfigGatewayProfile, modelConfigEndpointChanged, modelConfigAgentModelsSnapshot, initializeAgentModelPickerSnapshot, syncAgentModelPickersForEndpoint, uniqueAgentModelCandidates, appendAgentModelOptions, renderAgentModelPickers, updateAgentModelPickerManualStatus, handleAgentModelSelection, renderGatewayProbeResult, applyProbedModel, applyGatewayDiscoveredModel, applySuggestedGatewayUrl, gatewayCredentialAction, normalizeGatewayProbeModels, normalizeReasoningDiscovery, reasoningCapabilityCandidate, applyReasoningCapabilityCandidate, ensureReasoningEffortOptions, applyPendingReasoningCapabilities, reasoningCapabilityIsActionable, renderReasoningCapabilityStatus, reasoningCapabilityStatusText, reasoningDiscoveryStatusText, probeModelCapabilities, setFormControlsSaving, setModelConfigFormSaving, renderModelConfigFailure, clearModelConfigFailure, manualAgentModelIds, saveModelConfig, saveDefaultModelSelection, switchModel, handleReasoningEffortChange, switchReasoningEffort, deleteGatewayProfile, deleteModel, updateConfigRevisions, normalizeScopedDefaultSelection, configScope, configMutationMetadata, isConfigRevisionConflict, configRevisionConflictMessage, refreshConfigRevisionsAfterConflict, normalizeGatewayConfig, normalizeDashboardSettings, mergeGatewayConfig, normalizeGatewayProfiles, normalizeConfigSource, normalizeModels, normalizeModelSource, normalizeReasoningEfforts, normalizedReasoningEffort, isDisabledReasoningEffort, configuredReasoningEffort, reasoningEffortFallbackLabel, localizedReasoningEffortLabel, reasoningEffortCatalog, reasoningEffortLabel, resolveAtomicModelSelection, currentModelSelection, currentSessionNeedsModelSelection, currentGatewayProfile, gatewayProfileById, settingsInspectedGatewayProfile, modelSourceLabel, markCurrentModel, currentModelInfo, modelDisplayName, normalizeAgentModelTiers, normalizeVisionAgent, firstVisionModelId, hasAgentModelTiers, agentModelTiersSummary, gatewaySummary, modelSaveTargetLabel, gatewaySourceNote, environmentGatewayDefaultNote, sourceBadge, sourceLabel, formatContextUsage, firstFiniteNumber, formatTokenCount, trimNumber, nonNegativeInteger, collapseCompletedActivities, clearAssistantDrafts, collapseAssistantDrafts, isMeaningfulCompletedActivity, isDuplicateDraftText, normalizeComparableText, showApproval, resolveApproval, hideApproval, showQuestion, revealInteractionPanel, renderQuestionPanel, reviewQuestionConversation, returnToQuestion, activateQuestionReviewBackground, deactivateQuestionReviewBackground, questionChoiceButton, toggleQuestionChoice, submitQuestion, cancelQuestion, finishQuestionSubmission, hideQuestion, showTrustPanel, renderTrustPanel, confirmTrust, renderQueuePanel, renderQueueItem, setPendingGuide, clearPendingGuide, syncPendingGuideFromQueue, renderGuideFeedback, guideCopy, guideSource, guideTurnFromQueue, guideButtonText, guideButtonDisabled, guideButtonVisible, syncGuideButton, shouldKeepGuideFeedback, isInterruptError, updateSendButton, showContextConfirm, hideContextConfirm, runContextAction, contextActionRequestOptions, contextSummaryLine, compactResultLine, rememberQuestionDraft, questionResolutionText, showShutdownPanel, hideShutdownPanel, shutdownDashboard, lockClosedDashboard, normalizeLifecycleActivity, shutdownRequestBody, shutdownResultIsClosed, lifecycleActivitySummary, renderShutdownActivity, renderFiles, currentImageFiles, openFile, renderOfficePreview, officePreviewMeta, officePreviewBodyHtml, renderTablePreview, normalizeTablePreview, tablePreviewMeta, renderCompactTableHtml, renderExpandedTableHtml, renderTableHtml, tableTruncationNote, maxVisibleColumns, columnLabel, renderSheetPreviewHtml, renderSheetCellHtml, resetPreview, fencedDataForFile, dataLanguageForExtension, showImageLightbox, showTableLightbox, renderLightboxImage, bindTableLightboxControls, moveLightbox, hideLightbox, setPermissionMode, clearTranscript, cancelTranscriptAnimationFrames, clearAssistantDraftTimers, hideEmptyState, showError, showNotice, renderBootstrapLoading, renderBootstrapFailure, dashboardPayloadError, bootstrapFailurePresentation, clearBootstrapStatus, scrollTranscript, isTranscriptNearBottom, syncTranscriptFollowState, followTranscript, updateTranscriptJump, beginScopedRequest, isCurrentScopedRequest, finishScopedRequest, cancelScopedRequest, isAbortError, getJson, postJson, deleteJson, dashboardFetch, responseJson, dashboardJsonHeaders, dashboardCsrfToken, messageText, messageDisplayText, userMessageDisplayText, normalizeAttachmentMetadata, imageAttachmentLine, renderMessageText, renderLinkedText, bindRichContent, linkifyFileTextNodes, replaceFileReferences, isLikelyLocalFileReference, resolveDisplayFilePath, normalizeFileReferencePath, parentDirectory, filePreviewUrl, rawFileUrl, apiFileUrl, imagePreviewUrl, isSafeInlineBitmapUrl, normalizeRelativePath, isWorkspaceRelativeToBase, copyCodeBlock, previewText, formatNumber, formatBytes, escapeHtml, escapeAttribute, formatTime, formatRelativeTime } from "./app-barrel.ts";
export function activateModal(modal: HTMLElement | null | undefined, options: { initialFocus?: string; returnFocus?: Element | null } = {}) {
  if (!modal) return;
  if (state.modalContext?.modal === modal) {
    focusModalInitialTarget(modal, options.initialFocus);
    return;
  }
  if (state.modalContext) {
    deactivateModal(state.modalContext.modal, { restoreFocus: false });
  }
  const inertEntries = collectModalBackground(modal);
  const returnFocus = options.returnFocus ?? document.activeElement;
  state.modalContext = {
    modal,
    returnFocus,
    inertEntries,
    previousRole: modal.getAttribute("role"),
    previousAriaModal: modal.getAttribute("aria-modal"),
    previousTabIndex: modal.getAttribute("tabindex")
  };
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  if (!modal.hasAttribute("tabindex")) modal.setAttribute("tabindex", "-1");
  if (modal !== els.modelConfigPanel && modal !== els.imageLightbox) {
    modal.classList.add("modal-interaction");
  }
  for (const entry of inertEntries) entry.node.inert = true;
  focusModalInitialTarget(modal, options.initialFocus);
}

export function collectModalBackground(modal: HTMLElement | null | undefined) {
  const entries: { node: HTMLElement; inert: boolean }[] = [];
  const seen = new Set<HTMLElement>();
  let branch: HTMLElement | null | undefined = modal;
  while (branch?.parentElement) {
    const parent = branch.parentElement;
    for (const node of Array.from(parent.children ?? [])) {
      if (node === branch || seen.has(node)) continue;
      seen.add(node);
      entries.push({ node, inert: Boolean(node.inert) });
    }
    branch = parent;
    if (parent === document.body) break;
  }
  return entries;
}

export function focusModalInitialTarget(modal: HTMLElement | null | undefined, selector: unknown) {
  requestAnimationFrame(() => {
    if (!modal || state.modalContext?.modal !== modal) return;
    const target = typeof selector === "string" ? modal.querySelector(selector) : modalFocusableElements(modal)[0];
    (target ?? modal).focus({ preventScroll: true });
  });
}

export function deactivateModal(modal: HTMLElement | null | undefined, options: { restoreFocus?: boolean; fallbackFocus?: string | Element | null } = {}) {
  const context = state.modalContext;
  if (!context || context.modal !== modal) return;
  state.modalContext = null;
  for (const entry of context.inertEntries) entry.node.inert = entry.inert;
  modal.classList.remove("modal-interaction");
  restoreModalAttribute(modal, "role", context.previousRole);
  restoreModalAttribute(modal, "aria-modal", context.previousAriaModal);
  restoreModalAttribute(modal, "tabindex", context.previousTabIndex);
  syncResponsiveNavigation();
  if (options.restoreFocus === false) return;
  const fallback = typeof options.fallbackFocus === "string"
    ? document.querySelector(options.fallbackFocus)
    : options.fallbackFocus;
  const target = context.returnFocus?.isConnected === false ? fallback : context.returnFocus ?? fallback;
  requestAnimationFrame(() => target?.focus?.({ preventScroll: true }));
}

export function restoreModalAttribute(element: HTMLElement | null | undefined, name: string, value: unknown) {
  if (!element) return;
  if (value === null || typeof value === "undefined") element.removeAttribute(name);
  else element.setAttribute(name, String(value));
}

export function handleGlobalKeydown(event: KeyboardEvent) {
  const activeModal = state.modalContext?.modal;
  if (activeModal) {
    if (event.key === "Tab") {
      const focusables = modalFocusableElements(activeModal);
      const target = focusTrapTarget(focusables, document.activeElement, event.shiftKey);
      event.preventDefault();
      (target ?? activeModal).focus?.({ preventScroll: true });
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeActiveModal(activeModal);
      return;
    }
    if (activeModal === els.imageLightbox && event.key === "ArrowLeft") {
      event.preventDefault();
      moveLightbox(-1);
    } else if (activeModal === els.imageLightbox && event.key === "ArrowRight") {
      event.preventDefault();
      moveLightbox(1);
    }
    return;
  }
  if (state.questionReviewMode && event.key === "Escape") {
    event.preventDefault();
    returnToQuestion();
    return;
  }
  if (event.key === "Escape") {
    if (state.modelPanelOpen) hideModelPanel();
    else if (state.settingsOpen) hideSettingsWorkspace();
    else if (state.responsiveView !== "conversation") setResponsiveView("conversation");
  }
}

export function closeActiveModal(modal: unknown) {
  if (modal === els.modelConfigPanel) hideModelConfigPanel();
  else if (modal === els.imageLightbox) hideLightbox();
  else if (modal === els.shutdownPanel) hideShutdownPanel();
  else if (modal === els.contextPanel) hideContextConfirm();
  else if (modal === els.permissionConfirmPanel) hidePermissionConfirm();
  else if (modal === els.goalConfirmPanel) hideGoalConfirm();
  else if (modal === els.goalTextPanel) hideGoalTextPanel();
  else if (modal === els.approvalPanel) resolveApproval("cancel");
  else if (modal === els.questionPanel) cancelQuestion();
}

export async function loadTrust(options: DashboardFetchOptions & { silent?: boolean } = {}) {
  const result = await getJson("/api/trust", { signal: options.signal })
    .catch((error: unknown): DashboardApiResult => ({ ok: false, error: error instanceof Error ? error.message : String(error), aborted: isAbortError(error) }));
  if (!result.ok) {
    if (!options.silent && !result.aborted) {
      showError(result.error ?? "无法读取工作区信任状态");
    }
    return result;
  }
  state.trust = result.trust ?? null;
  renderTrustPanel();
  return result;
}

export async function loadSessions(options: Record<string, unknown> = {}) {
  const feedback = options.feedback === true;
  // Event-driven background refreshes must not cancel a user-visible refresh;
  // otherwise the cancelled request leaves the refresh control in "loading".
  if (!feedback && state.sessionsLoading) {
    return null;
  }
  const request = beginScopedRequest("sessions");
  if (feedback) {
    setSessionsRefreshState("loading", "刷新中");
  }
  try {
    const result = await getJson("/api/sessions", { signal: request.signal });
    if (!isCurrentScopedRequest(request)) return result;
    if (!result.ok) {
      throw new Error(result.error ?? "刷新会话失败");
    }
    state.sessions = result.sessions ?? [];
    renderSessions();
    if (sessionsNeedRefresh()) {
      scheduleSessionsRefresh(4000);
    }
    if (feedback) {
      setSessionsRefreshState("success", `已刷新 ${state.sessions.length} 个会话`);
    }
    return result;
  } catch (error) {
    if (isAbortError(error) || !isCurrentScopedRequest(request)) return null;
    if (feedback) {
      setSessionsRefreshState("error", "刷新失败");
    }
    showError(errorMessageOf(error) || "刷新会话失败");
    return { ok: false, error: errorMessageOf(error) };
  } finally {
    finishScopedRequest(request);
  }
}

export async function restoreInitialSession() {
  if (state.currentSessionId) {
    return;
  }
  const sessionId = initialSessionId() || latestBackgroundSessionId();
  if (!sessionId || !state.sessions.some((session) => session.id === sessionId)) {
    return;
  }
  await openSession(sessionId);
}

export function latestBackgroundSessionId() {
  return state.sessions.find((session) => session.backgroundVisible === true)?.id ?? "";
}

export function initialSessionId() {
  try {
    const params = new URLSearchParams(window.location?.search ?? "");
    return params.get("sessionId") || window.localStorage?.getItem(CURRENT_SESSION_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

/** @param {string | null | undefined} sessionId */
export function rememberCurrentSession(sessionId: string | null | undefined) {
  try {
    const id = String(sessionId ?? "").trim();
    if (id) {
      window.localStorage?.setItem(CURRENT_SESSION_STORAGE_KEY, id);
    } else {
      window.localStorage?.removeItem(CURRENT_SESSION_STORAGE_KEY);
    }
  } catch {
    // Local storage can be unavailable in hardened browser contexts.
  }
}

export function renderSessions() {
  const threadList = els.threadList;
  if (!threadList) return;
  threadList.innerHTML = "";
  if (state.sessions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "thread-meta";
    empty.textContent = "暂无历史任务";
    threadList.append(empty);
    return;
  }
  for (const session of state.sessions) {
    const status = sessionStatusView(session);
    const title = session.title || "未命名任务";
    const meta = sessionMeta(session, status);
    const item = document.createElement("div");
    item.className = `thread-item${session.id === state.currentSessionId ? " active" : ""}`;
    item.dataset.tone = status.tone;
    item.innerHTML = `
      <button type="button" class="thread-open" title="${escapeAttribute(`${title} · ${status.label}`)}" aria-label="${escapeAttribute(`${title}，${status.label}${meta ? `，${meta}` : ""}`)}">
        <span class="thread-status-dot" aria-hidden="true"></span>
        <div class="thread-main">
          <div class="thread-title">${escapeHtml(title)}</div>
          <div class="thread-meta">${escapeHtml(meta)}</div>
        </div>
      </button>
      ${state.deleteConfirmSessionId === session.id
        ? `
          <div class="thread-delete-confirm">
            <div class="thread-delete-title">确认删除这个会话？</div>
            <div class="thread-delete-copy">历史记录和 transcript 分片会被删除，操作不可撤销。</div>
            <div class="thread-actions">
              <button type="button" class="thread-action" data-action="cancel-delete" data-session-id="${escapeHtml(session.id)}">保留</button>
              <button type="button" class="thread-action danger strong" data-action="confirm-delete" data-session-id="${escapeHtml(session.id)}" ${state.deletingSessions.has(session.id) ? "disabled" : ""}>确认删除</button>
            </div>
          </div>
        `
        : `
          <div class="thread-actions">
            <button type="button" class="thread-action" data-action="copy-id" data-session-id="${escapeHtml(session.id)}" title="复制会话 ID">复制 ID</button>
            <button type="button" class="thread-action danger" data-action="delete" data-session-id="${escapeHtml(session.id)}" ${session.running ? "disabled" : ""} title="${session.running ? "会话运行中，结束后可删除" : "删除会话"}">删除</button>
          </div>
        `}
    `;
    item.querySelector(".thread-open")?.addEventListener("click", () => openSession(session.id));
    item.querySelectorAll("button[data-action]").forEach((button) => {
      button.addEventListener("click", (event: Event) => {
        event.stopPropagation();
        handleSessionAction(String(button.dataset.action ?? ""), String(button.dataset.sessionId ?? ""));
      });
    });
    threadList.append(item);
  }
}

export function sessionMeta(session: DashboardSessionSummary, status: { label: string; tone: string; detail?: string } = sessionStatusView(session)) {
  const parts = [
    Number(session.queueLength ?? 0) > 0 ? `${session.queueLength} 排队` : null,
    status.detail,
    session.model || null,
    formatTime(session.modifiedAt)
  ].filter(Boolean);
  return parts.join(" · ");
}

export function sessionStatusView(session: DashboardSessionSummary) {
  const raw = String(session.status ?? "").toLowerCase();
  if (session.running || raw === "running") {
    return { label: "运行中", tone: "running", detail: Number(session.queueLength ?? 0) > 0 ? "有排队" : "" };
  }
  if (session.backgroundVisible) {
    const kinds = Array.isArray(session.backgroundKinds) ? session.backgroundKinds : [];
    if (kinds.includes("terminal") && !kinds.includes("subagent")) {
      return { label: "终端后台", tone: "background", detail: Number(session.backgroundCount ?? 0) > 1 ? `${session.backgroundCount} 个任务` : "" };
    }
    if (kinds.includes("terminal")) {
      return { label: "后台运行", tone: "background", detail: Number(session.backgroundCount ?? 0) > 1 ? `${session.backgroundCount} 个任务` : "" };
    }
    return { label: "子智能体后台", tone: "background", detail: Number(session.backgroundCount ?? 0) > 1 ? `${session.backgroundCount} 个任务` : "" };
  }
  if (raw.includes("引导")) {
    return { label: "引导中", tone: "running", detail: "" };
  }
  if (Number(session.queueLength ?? 0) > 0) {
    return { label: "排队中", tone: "waiting", detail: "" };
  }
  if (["failed", "error"].includes(raw) || raw.endsWith("_error") || raw.includes("失败")) {
    return { label: "失败", tone: "error", detail: "" };
  }
  if (["interrupted", "cancelled"].includes(raw) || raw.includes("中断")) {
    return { label: "已中断", tone: "warning", detail: "" };
  }
  if (["completed", "done"].includes(raw) || raw.includes("完成")) {
    return { label: "完成", tone: "done", detail: "" };
  }
  if (session.active) {
    return { label: "已打开", tone: "active", detail: "" };
  }
  return { label: "历史", tone: "idle", detail: raw && raw !== "unknown" ? session.status : "" };
}

export function toggleSidebar() {
  setSidebarCollapsed(!state.sidebarCollapsed);
}

export function setSidebarCollapsed(collapsed: unknown) {
  state.sidebarCollapsed = Boolean(collapsed);
  document.body.classList.toggle("sidebar-collapsed", state.sidebarCollapsed);
  els.collapseSidebar.textContent = state.sidebarCollapsed ? "›" : "‹";
  els.collapseSidebar.title = state.sidebarCollapsed ? "展开会话栏" : "收起会话栏";
  els.collapseSidebar.setAttribute("aria-label", els.collapseSidebar.title);
  setPreviewWidth(state.previewPreferredWidth, { updatePreference: false });
}

export function sessionsNeedRefresh() {
  return state.sessions.some((session) =>
    session.running
    || session.backgroundVisible
    || Number(session.queueLength) > 0
    || String(session.status ?? "").toLowerCase() === "running"
  );
}

export function scheduleSessionsRefresh(delayMs: unknown = 800) {
  const normalizedDelay = Math.max(0, Number(delayMs) || 0);
  const dueAt = Date.now() + normalizedDelay;
  if (state.sessionsRefreshTimer && state.sessionsRefreshDueAt <= dueAt) {
    return;
  }
  if (state.sessionsRefreshTimer) {
    clearTimeout(state.sessionsRefreshTimer);
  }
  state.sessionsRefreshDueAt = dueAt;
  state.sessionsRefreshTimer = setTimeout(() => {
    state.sessionsRefreshTimer = null;
    state.sessionsRefreshDueAt = 0;
    loadSessions().catch(() => null);
  }, normalizedDelay);
}

export function handleSessionAction(action: unknown, sessionId: string) {
  if (!sessionId) {
    return;
  }
  if (action === "delete") {
    state.deleteConfirmSessionId = sessionId;
    renderSessions();
    return;
  }
  if (action === "cancel-delete") {
    state.deleteConfirmSessionId = "";
    renderSessions();
    return;
  }
  if (action === "confirm-delete") {
    deleteSession(sessionId);
    return;
  }
  if (action === "copy-id") {
    copySessionId(sessionId);
  }
}

export async function openSession(id: string) {
  state.turnRequest = null;
  const request = beginScopedRequest("session", id);
  cancelScopedRequest("transcript");
  cancelScopedRequest("file");
  els.runStatus.textContent = "加载会话";
  let result;
  try {
    result = await getJson(`/api/sessions/${encodeURIComponent(id)}`, { signal: request.signal });
  } catch (error) {
    if (!isAbortError(error) && isCurrentScopedRequest(request)) {
      showError(errorMessageOf(error) || "无法读取会话");
    }
    finishScopedRequest(request);
    return;
  }
  if (!isCurrentScopedRequest(request)) return;
  finishScopedRequest(request);
  if (!result.ok) {
    showError(typeof result.error === "string" ? result.error : result.error ?? "无法读取会话");
    return;
  }
  const loadedSession = result.session;
  if (!loadedSession) {
    showError("无法读取会话");
    return;
  }
  state.currentSessionId = id;
  applyGoalSnapshot(loadedSession.goal, { permissionMode: loadedSession.permission?.mode ?? "plan" });
  state.running = loadedSession.active === true && loadedSession.running === true;
  rememberCurrentSession(id);
  disconnectEvents();
  hideApproval();
  hideQuestion();
  hideContextConfirm();
  clearTranscript();
  resetLiveStatus();
  state.queue = [];
  state.queueCancelling.clear();
  state.backgroundCancelling.clear();
  clearPendingGuide();
  state.activeTurnId = "";
  resetEventReplayState();
  state.deleteConfirmSessionId = "";
  renderQueuePanel();
  state.models = markCurrentModel(state.models, loadedSession.sessionStatus?.model ?? loadedSession.model);
  state.sessionStatus = null;
  updateSessionStatus(loadedSession.sessionStatus ?? {
    model: loadedSession.model,
    context: isPlainObject(loadedSession.context) ? loadedSession.context : null
  });
  updateSendButton();
  resetTurnChangeStats();
  state.files = Array.isArray(loadedSession.files) ? loadedSession.files : [];
  renderFiles();
  resetPreview();
  els.runStatus.textContent = loadedSession.status || "历史";
  setTranscriptPaging(loadedSession.transcriptPage);
  renderTranscriptMessages(loadedSession.transcript ?? []);
  renderSessionFailure(loadedSession.failure);
  scrollTranscript({ force: true });
  const hasBackground = restoreBackgroundSnapshot(loadedSession.backgroundSnapshot);
  if (loadedSession.active && loadedSession.running) {
    rememberEventCursor(loadedSession.eventCursor);
    ensureEventsConnected(id);
    els.runStatus.textContent = loadedSession.status === "引导中" ? "引导中" : "运行中";
    setLiveTitle(loadedSession.status === "引导中" ? "正在按引导继续" : "正在恢复运行中的任务");
    state.running = true;
    updateSendButton();
  } else if (loadedSession.active && hasBackground) {
    rememberEventCursor(loadedSession.eventCursor);
    ensureEventsConnected(id);
    applyIdleRunStatus("完成");
    updateSendButton();
  }
  renderSessions();
}

export function restoreBackgroundSnapshot(snapshot: unknown) {
  if (!isPlainObject(snapshot) || !Array.isArray(snapshot.groups)) {
    return false;
  }
  reconcileBackgroundSubagentSnapshot(snapshot.groups);
  return state.backgroundSubagents.size > 0;
}

export async function deleteSession(sessionId: string) {
  if (!sessionId || state.deletingSessions.has(sessionId)) {
    return;
  }
  state.deletingSessions.add(sessionId);
  renderSessions();
  const result = await deleteJson(`/api/sessions/${encodeURIComponent(sessionId)}`)
    .catch((error: unknown): DashboardApiResult => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  state.deletingSessions.delete(sessionId);
  state.deleteConfirmSessionId = "";
  if (!result.ok) {
    showError(result.error ?? "删除会话失败");
    renderSessions();
    return;
  }
  if (state.currentSessionId === sessionId) {
    newTask();
    rememberCurrentSession(null);
  }
  await loadSessions();
}

export function setSessionsRefreshState(tone: string, message: string = "") {
  if (state.sessionsStatusTimer) {
    clearTimeout(state.sessionsStatusTimer);
    state.sessionsStatusTimer = null;
  }
  state.sessionsLoading = tone === "loading";
  els.refreshSessions.disabled = state.sessionsLoading;
  els.refreshSessions.dataset.state = tone;
  els.refreshSessions.textContent = tone === "success" ? "✓" : tone === "error" ? "!" : "↻";
  els.refreshSessions.title = message || "刷新";
  if (els.sessionsStatus) {
    els.sessionsStatus.textContent = message;
    els.sessionsStatus.dataset.tone = tone;
  }
  if (tone === "success" || tone === "error") {
    state.sessionsStatusTimer = setTimeout(() => {
      els.refreshSessions.dataset.state = "idle";
      els.refreshSessions.textContent = "↻";
      els.refreshSessions.title = "刷新";
      if (els.sessionsStatus) {
        els.sessionsStatus.textContent = "";
        els.sessionsStatus.dataset.tone = "idle";
      }
      state.sessionsStatusTimer = null;
    }, 1800);
  }
}

export async function copySessionId(sessionId: string) {
  try {
    await navigator.clipboard.writeText(sessionId);
    appendActivity({
      title: "会话 ID 已复制",
      detail: sessionId,
      severity: "success",
      collapsed: true
    });
  } catch {
    showError("复制会话 ID 失败");
  }
}

export function newTask() {
  cancelScopedRequest("session");
  cancelScopedRequest("transcript");
  cancelScopedRequest("file");
  state.turnRequest = null;
  state.currentSessionId = null;
  applyGoalSnapshot(null, { permissionMode: "plan" });
  state.running = false;
  rememberCurrentSession(null);
  disconnectEvents();
  hideApproval();
  hideQuestion();
  hideContextConfirm();
  clearTranscript();
  state.files = [];
  state.queue = [];
  state.queueCancelling.clear();
  state.backgroundCancelling.clear();
  state.completedActivities = [];
  clearPendingGuide();
  state.activeTurnId = "";
  resetEventReplayState();
  state.deleteConfirmSessionId = "";
  resetLiveStatus();
  resetTurnChangeStats();
  restoreNewTaskModelState();
  clearAttachments();
  renderQueuePanel();
  renderFiles();
  resetPreview();
  els.runStatus.textContent = "空闲";
  updateSendButton();
  resizePromptInput();
  els.promptInput.focus();
  refreshNewTaskModelState().catch(() => null);
}

export function rememberNewTaskModelState() {
  state.newTaskModelState = {
    models: normalizeModels(state.models),
    gatewayConfig: normalizeGatewayConfig(state.gatewayConfig),
    gatewayProfiles: normalizeGatewayProfiles(state.gatewayProfiles),
    agentModelTiers: normalizeAgentModelTiers(state.agentModelTiers),
    visionAgent: normalizeVisionAgent(state.visionAgent),
    sessionStatus: {
      ...(state.sessionStatus ?? emptySessionStatus),
      context: state.sessionStatus?.context ? { ...state.sessionStatus.context } : null
    }
  };
}

export function restoreNewTaskModelState() {
  const snapshot = state.newTaskModelState;
  if (!snapshot) {
    return;
  }
  state.models = normalizeModels(snapshot.models);
  state.gatewayConfig = normalizeGatewayConfig(snapshot.gatewayConfig);
  state.gatewayProfiles = normalizeGatewayProfiles(snapshot.gatewayProfiles);
  state.agentModelTiers = normalizeAgentModelTiers(snapshot.agentModelTiers);
  state.visionAgent = normalizeVisionAgent(snapshot.visionAgent);
  state.sessionStatus = null;
  updateSessionStatus(snapshot.sessionStatus);
}

export async function refreshNewTaskModelState() {
  const result = await getJson(statusUrl());
  if (!result.ok || state.currentSessionId) {
    return;
  }
  state.models = normalizeModels(result.models);
  state.gatewayConfig = normalizeGatewayConfig(result.gatewayConfig);
  state.gatewayProfiles = normalizeGatewayProfiles(result.gatewayProfiles);
  state.agentModelTiers = normalizeAgentModelTiers(result.agentModelTiers);
  state.visionAgent = normalizeVisionAgent(result.visionAgent);
  updateConfigRevisions(result);
  state.sessionStatus = null;
  updateSessionStatus({
    ...result.sessionStatus,
    providerId: result.sessionStatus?.providerId ?? result.gatewayConfig?.activeProfileId ?? ""
  });
  rememberNewTaskModelState();
}

export async function addAttachmentFiles(files: ArrayLike<unknown> | unknown[] | FileList | null | undefined) {
  const list = Array.from(files ?? []).filter((file): file is File => file instanceof File);
  if (list.length === 0) {
    return;
  }
  let ignoredUnknown = 0;
  for (const file of list) {
    const kind = classifyComposerFile(file);
    if (kind === "image") {
      const imageCount = state.attachments.filter((item: { type?: string }) => item.type !== "document").length;
      if (imageCount >= MAX_IMAGE_ATTACHMENTS) {
        showError(`最多可附加 ${MAX_IMAGE_ATTACHMENTS} 张图片`);
        continue;
      }
      if (file.size > MAX_IMAGE_ATTACHMENT_BYTES) {
        showError(`${file.name || "图片"} 超过 8MB，暂不发送`);
        continue;
      }
      try {
        state.attachments.push(await readImageAttachment(file));
      } catch (error) {
        showError(errorMessageOf(error) || "读取图片失败");
      }
      continue;
    }
    if (kind === "document") {
      const documentCount = state.attachments.filter((item: { type?: string }) => item.type === "document").length;
      if (documentCount >= MAX_DOCUMENT_ATTACHMENTS) {
        showError(`最多可附加 ${MAX_DOCUMENT_ATTACHMENTS} 个文档`);
        continue;
      }
      if (file.size > MAX_DOCUMENT_ATTACHMENT_BYTES) {
        showError(`${file.name || "文档"} 超过 40MB，暂不发送`);
        continue;
      }
      try {
        state.attachments.push(await readDocumentAttachment(file));
      } catch (error) {
        showError(errorMessageOf(error) || "读取文档失败");
      }
      continue;
    }
    ignoredUnknown += 1;
  }
  if (ignoredUnknown > 0) {
    showError("回形针只接收图片和 PDF / Word / Excel / PPT / 文本，不支持旧版 .doc .xls .ppt");
  }
  renderAttachmentStrip();
  updateSendButton();
}

export function classifyComposerFile(file: File) {
  const name = String(file.name ?? "");
  const ext = name.includes(".") ? `.${name.split(".").pop()?.toLowerCase() ?? ""}` : "";
  const mime = String(file.type ?? "").toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext) || mime === "image/png" || mime === "image/jpeg" || mime === "image/gif" || mime === "image/webp") {
    return "image";
  }
  if (DOCUMENT_EXTENSIONS.has(ext) || mime === "application/pdf") {
    return "document";
  }
  return "unsupported";
}

export function readImageAttachment(file: File) {
  return new Promise<{
    id: string;
    type: "image";
    name: string;
    mimeType: string;
    size: number;
    data: string;
    previewUrl: string;
  }>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("error", () => reject(new Error("读取图片失败")));
    reader.addEventListener("load", () => {
      const dataUrl = String(reader.result ?? "");
      const match = dataUrl.match(/^data:([^;,]+);base64,([\s\S]+)$/);
      if (!match) {
        reject(new Error("图片格式无法作为附件发送"));
        return;
      }
      resolve({
        id: `attachment-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        type: "image",
        name: file.name || "image",
        mimeType: match[1] || file.type || "image/png",
        size: file.size,
        data: match[2],
        previewUrl: dataUrl
      });
    });
    reader.readAsDataURL(file);
  });
}

export function readDocumentAttachment(file: File) {
  return new Promise<{
    id: string;
    type: "document";
    name: string;
    mimeType: string;
    size: number;
    data: string;
    previewUrl: string;
  }>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("error", () => reject(new Error("读取文档失败")));
    reader.addEventListener("load", () => {
      const dataUrl = String(reader.result ?? "");
      const match = dataUrl.match(/^data:([^;,]+);base64,([\s\S]+)$/);
      if (!match) {
        reject(new Error("文档格式无法作为附件发送"));
        return;
      }
      resolve({
        id: `attachment-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        type: "document",
        name: file.name || "document",
        mimeType: match[1] || file.type || "application/octet-stream",
        size: file.size,
        data: match[2],
        previewUrl: ""
      });
    });
    reader.readAsDataURL(file);
  });
}

export function renderAttachmentStrip() {
  if (!els.attachmentStrip) {
    return;
  }
  els.attachmentStrip.innerHTML = "";
  els.attachmentStrip.classList.toggle("hidden", state.attachments.length === 0);
  for (const attachment of state.attachments) {
    const item = document.createElement("div");
    item.className = "attachment-chip";
    const isDocument = attachment.type === "document";
    const label = attachment.name || (isDocument ? "文档" : "图片");
    const preview = isDocument || !attachment.previewUrl
      ? `<span class="attachment-chip-file">${escapeHtml(documentChipLabel(attachment.name))}</span>`
      : `<img alt="" src="${attachment.previewUrl}" />`;
    item.innerHTML = `
      ${preview}
      <span>${escapeHtml(label)}</span>
      <button type="button" aria-label="移除 ${escapeHtml(label)}">×</button>
    `;
    item.querySelector("button").addEventListener("click", () => {
      state.attachments = state.attachments.filter((candidate: { id?: string }) => candidate.id !== attachment.id);
      renderAttachmentStrip();
      updateSendButton();
    });
    els.attachmentStrip.append(item);
  }
}

export function documentChipLabel(name: unknown) {
  const ext = String(name ?? "").split(".").pop()?.toUpperCase() ?? "FILE";
  return ext.slice(0, 4);
}

export function attachmentPayload(attachment: { type?: string; name?: string; mimeType?: string; size?: number; data?: string }) {
  return {
    type: attachment.type === "document" ? "document" : "image",
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.size,
    data: attachment.data
  };
}

export function clearAttachments() {
  state.attachments = [];
  if (els.attachmentInput) {
    els.attachmentInput.value = "";
  }
  renderAttachmentStrip();
}

export async function sendPrompt() {
  if (state.turnSubmitting) {
    return;
  }
  if (currentSessionNeedsModelSelection()) {
    showError("请先重新选择模型来源和模型");
    return;
  }
  const prompt = els.promptInput.value.trim();
  const attachments = state.attachments.slice();
  if (!prompt && attachments.length === 0) {
    return;
  }
  if (!state.trust?.trusted) {
    showTrustPanel();
    return;
  }
  state.turnSubmitting = true;
  updateSendButton();
  els.runStatus.textContent = state.running ? "已排队" : "启动中";
  const turnRequest = stableTurnRequest(prompt, attachments);
  let result;
  try {
    result = await postJson("/api/turns", {
      requestId: turnRequest.id,
      prompt,
      attachments: attachments.map(attachmentPayload),
      sessionId: state.currentSessionId,
      clientId: state.currentSessionId ? undefined : dashboardClientId(),
      permissionMode: state.permissionMode,
      goalMode: state.goal.enabled === true,
      goalText: state.goal.enabled ? state.goal.text : undefined,
      clientPreviousPermissionMode: state.goal.enabled ? state.goal.previousPermissionMode : undefined
    });
  } catch (error) {
    result = { ok: false, error: errorMessageOf(error) };
  } finally {
    state.turnSubmitting = false;
    updateSendButton();
  }
  if (!result.ok) {
    if (Number.isFinite(Number(result.status))) {
      state.turnRequest = null;
    }
    if (result.trust) {
      state.trust = result.trust;
      renderTrustPanel();
    }
    showError(result.error ?? "任务启动失败");
    els.runStatus.textContent = result.status === 403 ? "待信任" : "失败";
    updateSendButton();
    return;
  }
  state.turnRequest = null;
  els.promptInput.value = "";
  resizePromptInput();
  clearAttachments();
  state.queue = result.queue ?? state.queue;
  state.running = result.running === true || state.running;
  applyGoalSnapshot(result.goal ?? state.goal, { permissionMode: result.permission?.mode ?? state.permissionMode });
  updateSessionStatus(result.sessionStatus);
  updateTurnChangeStats(result.changeStats, { replace: true });
  renderQueuePanel();
  if (result.running === true) {
    els.runStatus.textContent = "运行中";
    setLiveTitle("正在处理你的任务");
  }
  updateSendButton();
  const previousSessionId = state.currentSessionId;
  state.currentSessionId = result.sessionId ?? null;
  rememberCurrentSession(result.sessionId ?? null);
  if (previousSessionId !== result.sessionId) {
    resetEventReplayState();
  }
  rememberEventCursor(result.eventCursor);
  if (result.sessionId) {
    ensureEventsConnected(result.sessionId);
  }
  await loadSessions();
}

export function stableTurnRequest(prompt: string, attachments: Array<{ id?: string; name?: string; mimeType?: string; size?: number }>) {
  const signature = JSON.stringify({
    prompt,
    sessionId: state.currentSessionId,
    permissionMode: state.permissionMode,
    attachments: attachments.map((item) => [item.id, item.name, item.mimeType, item.size])
  });
  if (state.turnRequest?.signature === signature) {
    return state.turnRequest;
  }
  const request = { id: dashboardRequestId(), signature };
  state.turnRequest = request;
  return request;
}

export function dashboardRequestId() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  }
  return `turn-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function dashboardClientId() {
  if (state.dashboardClientId) return state.dashboardClientId;
  try {
    const stored = sessionStorage.getItem(DASHBOARD_CLIENT_STORAGE_KEY);
    if (stored) {
      state.dashboardClientId = stored;
      return stored;
    }
  } catch {
    // Session storage can be disabled; an in-memory id still isolates this tab.
  }
  const clientId = `dashboard-${dashboardRequestId()}`;
  state.dashboardClientId = clientId;
  try {
    sessionStorage.setItem(DASHBOARD_CLIENT_STORAGE_KEY, clientId);
  } catch {
    // Keep the in-memory id for this page lifetime.
  }
  return clientId;
}

export function statusUrl() {
  return `/api/status?clientId=${encodeURIComponent(dashboardClientId())}`;
}

export async function interruptTurn() {
  if (!state.currentSessionId) {
    return;
  }
  els.sendButton.disabled = true;
  els.sendButton.textContent = "中断中";
  const result = await postJson("/api/turns/interrupt", {
    sessionId: state.currentSessionId,
    reason: "user"
  }, { timeoutMs: DASHBOARD_INTERRUPT_TIMEOUT_MS }).catch((error: unknown): DashboardApiResult => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  els.sendButton.disabled = false;
  if (!result.ok) {
    showError(result.error ?? "中断失败");
  }
  updateSessionStatus(result.sessionStatus);
  updateSendButton();
}

export async function guideTurn(queueItemId: unknown = "") {
  const source = guideSource(queueItemId);
  if (!source || !state.currentSessionId || !state.running || state.guideSubmitting) {
    return;
  }
  const clientId = `guide-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  state.guideSubmitting = true;
  setPendingGuide({
    clientId,
    sessionId: state.currentSessionId,
    phase: "registering",
    preview: source.preview
  });
  hideApproval();
  hideQuestion();
  els.runStatus.textContent = "引导中";
  setLiveTitle("正在登记引导");
  const result = await postJson("/api/turns/guide", {
    sessionId: state.currentSessionId,
    guidance: source.guidance,
    queueItemId: source.queueItemId,
    permissionMode: state.permissionMode
  }).catch((error: unknown): DashboardApiResult => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  state.guideSubmitting = false;
  if (!result.ok) {
    if (state.pendingGuide?.clientId === clientId) {
      clearPendingGuide();
    } else {
      renderQueuePanel();
    }
    showError(result.error ?? "引导失败");
    return;
  }
  els.promptInput.value = "";
  state.queue = result.queue ?? state.queue;
  updateSessionStatus(result.sessionStatus);
  hideApproval();
  hideQuestion();
  setPendingGuide({
    clientId,
    sessionId: state.currentSessionId,
    phase: result.stopped ? "stopped" : "registered",
    preview: source.preview
  });
  syncGuideButton();
}

export async function cancelQueuedTurn(queueItemId: unknown) {
  if (!queueItemId || !state.currentSessionId || state.queueCancelling.has(queueItemId)) {
    return;
  }
  state.queueCancelling.add(queueItemId);
  renderQueuePanel();
  const result = await postJson("/api/turns/queue/cancel", {
    sessionId: state.currentSessionId,
    queueItemId
  }).catch((error: unknown): DashboardApiResult => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  state.queueCancelling.delete(queueItemId);
  if (!result.ok) {
    showError(result.error ?? "取消排队失败");
    renderQueuePanel();
    return;
  }
  state.queue = result.queue ?? state.queue.filter((item) => item.id !== queueItemId);
  updateSessionStatus(result.sessionStatus);
  if (result.item?.kind === "guide" && state.pendingGuide?.phase !== "continuing") {
    clearPendingGuide();
  } else {
    renderQueuePanel();
  }
  syncGuideButton();
}

