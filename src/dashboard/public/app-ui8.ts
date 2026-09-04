import { renderMarkdown } from "./markdown.ts";
import { hydrateRichContent } from "./rich-renderers.ts";
import { visibleTranscriptRole } from "./transcript.ts";
import { MANUAL_AGENT_MODEL_VALUE, state, els, MODE_DESCRIPTIONS, LOCAL_FILE_EXTENSIONS, FILE_REFERENCE_PATTERN, TRANSCRIPT_DOM_LIMIT, EVENT_STALE_AFTER_MS, EVENT_CONNECT_TIMEOUT_MS, EVENT_RECONNECT_MAX_ATTEMPTS, DASHBOARD_REQUEST_TIMEOUT_MS, DASHBOARD_API_VERSION, DASHBOARD_LIFECYCLE_TIMEOUT_MS, DASHBOARD_SHUTDOWN_TIMEOUT_MS, DASHBOARD_INTERRUPT_TIMEOUT_MS, MAX_IMAGE_ATTACHMENTS, MAX_IMAGE_ATTACHMENT_BYTES, CURRENT_SESSION_STORAGE_KEY, DASHBOARD_CLIENT_STORAGE_KEY, PREVIEW_WIDTH_STORAGE_KEY, PREVIEW_WIDTH_DEFAULT, PREVIEW_WIDTH_MIN, PREVIEW_WIDTH_MAX, PREVIEW_WORKSPACE_MIN , emptySessionStatus, emptyBackgroundSubagent } from "./app-core.ts";
import type { DashboardConfigSource, DashboardReasoningEffort, DashboardTurnChangeStats, DashboardScopedDefaultSelection, DashboardVisionAgent, DashboardReasoningDiscovery, DashboardReasoningCapabilityCandidate, DashboardGatewayProbeModel, DashboardGatewayProbeResult, DashboardLifecycleActivity, DashboardSettings, DashboardFile, DashboardTableSheet, DashboardTablePreview, DashboardLightboxItem, DashboardQuestionChoice, DashboardPendingQuestion, DashboardApproval, DashboardGatewayTransport, DashboardScopedRequest, DashboardFetchOptions, DashboardModelSource, DashboardSessionStatus, DashboardApiResult, DashboardActivity, DashboardModelOption, DashboardGatewayProfile, DashboardGatewayConfig, DashboardModelSelection, DashboardPendingGuide, DashboardStreamEvent, DashboardUiState , DashboardSessionSummary } from "./app-core.ts";
import { eventTargetOf, eventElement, isPlainObject, modelSourceOf, errorMessageOf, init, bootstrapDashboard, observeRunStatus, updateRunStatusTone, bindEvents, normalizedResponsiveView, composerHeightFor, previewWidthBounds, clampedPreviewWidth, permissionIndexForKey, focusTrapTarget, shouldFollowTranscript, scheduleAnimationFrameOnce, cancelScheduledAnimationFrame, appendPlainDraftDelta, renderFinalAssistantBody, selectTranscriptNodesToRemove, responsiveLayoutMode, restorePreviewWidth, setPreviewWidth, syncPreviewResizeHandle, beginPreviewResize, updatePreviewResize, finishPreviewResize, handlePreviewResizeKeydown, setResponsiveView, syncResponsiveNavigation, setResponsiveSurfaceInert, handleResponsiveFileNavigation, syncVisualViewport, resizePromptInput, handlePermissionModeKeydown, requestPermissionMode, defaultGoalMaxAutoContinues, emptyGoalSnapshot, applyGoalSnapshot, renderGoalControls, renderGoalStatusBar, requestGoalMode, showGoalConfirm, hideGoalConfirm, showGoalTextPanel, hideGoalTextPanel, enableGoalWithObjective, submitGoalAction, adoptGoalRunResult, showPermissionConfirm, hidePermissionConfirm, updateContextActions, announceStatus, modalFocusableElements, activateModal, collectModalBackground, focusModalInitialTarget, deactivateModal, restoreModalAttribute, handleGlobalKeydown, closeActiveModal, loadTrust, loadSessions, restoreInitialSession, latestBackgroundSessionId, initialSessionId, rememberCurrentSession, renderSessions, sessionMeta, sessionStatusView, toggleSidebar, setSidebarCollapsed, sessionsNeedRefresh, scheduleSessionsRefresh, handleSessionAction, openSession, restoreBackgroundSnapshot, deleteSession, setSessionsRefreshState, copySessionId, newTask, rememberNewTaskModelState, restoreNewTaskModelState, refreshNewTaskModelState, addAttachmentFiles, readImageAttachment, renderAttachmentStrip, attachmentPayload, clearAttachments, sendPrompt, stableTurnRequest, dashboardRequestId, dashboardClientId, statusUrl, interruptTurn, guideTurn, cancelQueuedTurn, cancelBackgroundSubagent, backgroundCancelKey, connectEvents, ensureEventsConnected, disconnectEvents, closeEventSource, markEventConnectionAlive, armEventConnectTimer, armEventStaleTimer, scheduleEventReconnect, reconnectEventsManually, clearEventReconnectTimer, clearEventConnectTimer, clearEventStaleTimer, setConnectionState, resetEventReplayState, rememberEventCursor, handleDashboardEvent, shouldSkipDashboardEvent, beginEventTurn, renderTranscriptMessages, renderSessionFailure, setTranscriptPaging, renderTranscriptHistoryStatus, removeTranscriptHistoryStatus, transcriptFirstContentNode, handleTranscriptScroll, loadOlderTranscript, renderWorkflowPanel, renderWorkflowStrip, currentWorkflowItem, workflowSection, workflowItem, normalizeWorkflowStatus, summarizeWorkflow, appendMessage, createMessageNode, appendTranscriptNode, trimTranscriptWindow, isProtectedTranscriptNode, renderTranscriptWindowMarker, captureTranscriptViewportAnchor, restoreTranscriptViewportAnchor, transcriptNodeTop, restoreTranscriptNodeAnchor, resetTranscriptWindow, appendAssistantDraft, scheduleDraftRender, renderAssistantDraft, appendActivity, appendContextBoundary, contextBoundaryText, handleActivity, isBackgroundSubagentActivity, handleBackgroundSubagentActivity, clearBackgroundSubagentStatus, reconcileBackgroundSubagentSnapshot, backgroundSubagentDisplayStatus, backgroundSubagentVisible, updateLiveActivity, removeLiveActivity, setLiveTitle, toggleLiveStatusDetails, updateLiveStatus, liveStatusTitle, primaryLiveActivity, gatewayRetryChipText, renderBackgroundSubagentStatus, backgroundSubagentCompactLabel, backgroundSubagentTitle, backgroundSubagentMeta, backgroundSubagentCancellable, resetLiveStatus, backgroundSubagentCounts, idleRunStatus, applyIdleRunStatus, updateRunStatusForBackground, updateSessionStatus, updateTurnChangeStats, resetTurnChangeStats, normalizeChangeStats, renderComposerStatus, modelStatusHtml, unresolvedModelStatusHtml, handleModelStatusActivate, handleModelStatusKeydown, toggleModelPanel, hideModelPanel, showSettingsWorkspace, refreshSettingsConfiguration, hideSettingsWorkspace, showModelConfigPanel, hideModelConfigPanel, renderModelPanel, modelCapabilityLabels, handleModelPanelClick, handleModelPanelChange, renderSettingsView, syncSettingsRail, modelSettingsHtml, transcriptSettingsHtml, transcriptRetentionOptionsHtml, networkSettingsHtml, networkModeOptionHtml, agentSettingsHtml, reliabilitySettingsHtml, settingsSectionHeading, settingsToggleHtml, managedFieldHtml, settingsDisabled, settingsFormActions, settingsFeedbackHtml, settingsGatewayProfileHtml, gatewayProfileReadonlyLabel, providerModelKey, scopedDefaultModelLabel, settingsModelHtml, handleSettingsRailClick, initializeSettingsFormTracking, handleSettingsFormChange, settingsControlValue, changedSettingsFields, canonicalSettingsField, setSettingsFormSaving, renderSettingsFeedbackInPlace, saveSettingsConfig, handleSettingsClick, protocolDisplayName, agentModelPickerHtml, renderModelConfigPanel, handleModelConfigPanelClick, handleModelConfigInput, handleModelConfigChange, markModelConfigCredentialChanged, markModelConfigEndpointChanged, handleModelConfigModelIdChanged, markReasoningCapabilityManual, clearReasoningCapabilityControls, syncGatewayUrlHint, gatewayUrlPlaceholder, gatewayUrlHint, syncReasoningDefaultOptions, probeGateway, isCurrentModelConfigRequest, currentGatewayProbeResult, currentGatewayCatalogModels, modelConfigGatewayProfile, modelConfigEndpointChanged, modelConfigAgentModelsSnapshot, initializeAgentModelPickerSnapshot, syncAgentModelPickersForEndpoint, uniqueAgentModelCandidates, appendAgentModelOptions, renderAgentModelPickers, updateAgentModelPickerManualStatus, handleAgentModelSelection, renderGatewayProbeResult, applyProbedModel, applyGatewayDiscoveredModel, applySuggestedGatewayUrl, gatewayCredentialAction, normalizeGatewayProbeModels, normalizeReasoningDiscovery, reasoningCapabilityCandidate, applyReasoningCapabilityCandidate, ensureReasoningEffortOptions, applyPendingReasoningCapabilities, reasoningCapabilityIsActionable, renderReasoningCapabilityStatus, reasoningCapabilityStatusText, reasoningDiscoveryStatusText, probeModelCapabilities, setFormControlsSaving, setModelConfigFormSaving, renderModelConfigFailure, clearModelConfigFailure, manualAgentModelIds, saveModelConfig, saveDefaultModelSelection, switchModel, handleReasoningEffortChange, switchReasoningEffort, deleteGatewayProfile, deleteModel, updateConfigRevisions, normalizeScopedDefaultSelection, configScope, configMutationMetadata, isConfigRevisionConflict, configRevisionConflictMessage, refreshConfigRevisionsAfterConflict, normalizeGatewayConfig, normalizeDashboardSettings, mergeGatewayConfig, normalizeGatewayProfiles, normalizeConfigSource, normalizeModels, normalizeModelSource, normalizeReasoningEfforts, normalizedReasoningEffort, isDisabledReasoningEffort, configuredReasoningEffort, reasoningEffortFallbackLabel, localizedReasoningEffortLabel, reasoningEffortCatalog, reasoningEffortLabel, resolveAtomicModelSelection, currentModelSelection, currentSessionNeedsModelSelection, currentGatewayProfile, gatewayProfileById, settingsInspectedGatewayProfile, modelSourceLabel, markCurrentModel, currentModelInfo, modelDisplayName, normalizeAgentModelTiers, normalizeVisionAgent, firstVisionModelId, hasAgentModelTiers, agentModelTiersSummary, gatewaySummary, modelSaveTargetLabel, gatewaySourceNote, environmentGatewayDefaultNote, sourceBadge, lockClosedDashboard, normalizeLifecycleActivity, shutdownRequestBody, shutdownResultIsClosed, lifecycleActivitySummary, renderShutdownActivity, renderFiles, currentImageFiles, openFile, renderOfficePreview, officePreviewMeta, officePreviewBodyHtml, renderTablePreview, normalizeTablePreview, tablePreviewMeta, renderCompactTableHtml, renderExpandedTableHtml, renderTableHtml, tableTruncationNote, maxVisibleColumns, columnLabel, renderSheetPreviewHtml, renderSheetCellHtml, resetPreview, fencedDataForFile, dataLanguageForExtension, showImageLightbox, showTableLightbox, renderLightboxImage, bindTableLightboxControls, moveLightbox, hideLightbox, setPermissionMode, clearTranscript, cancelTranscriptAnimationFrames, clearAssistantDraftTimers, hideEmptyState, showError, showNotice, renderBootstrapLoading, renderBootstrapFailure, dashboardPayloadError, bootstrapFailurePresentation, clearBootstrapStatus, scrollTranscript, isTranscriptNearBottom, syncTranscriptFollowState, followTranscript, updateTranscriptJump, beginScopedRequest, isCurrentScopedRequest, finishScopedRequest, cancelScopedRequest, isAbortError, getJson, postJson, deleteJson, dashboardFetch, responseJson, dashboardJsonHeaders, dashboardCsrfToken, messageText, messageDisplayText, userMessageDisplayText, normalizeAttachmentMetadata, imageAttachmentLine, renderMessageText, renderLinkedText, bindRichContent, linkifyFileTextNodes, replaceFileReferences, isLikelyLocalFileReference, resolveDisplayFilePath, normalizeFileReferencePath, parentDirectory, filePreviewUrl, rawFileUrl, apiFileUrl, imagePreviewUrl, isSafeInlineBitmapUrl, normalizeRelativePath, isWorkspaceRelativeToBase, copyCodeBlock, previewText, formatNumber, formatBytes, escapeHtml, escapeAttribute, formatTime, formatRelativeTime } from "./app-barrel.ts";
export function sourceLabel(source: DashboardConfigSource | string | null | undefined) {
  const type = typeof source === "string" ? source : String(source?.type ?? "");
  if (type === "project") return "当前项目";
  if (type === "environment") return "全局默认（环境变量）";
  if (type === "global") return "LAB_AGENT_CONFIG";
  if (type === "bundled") return "内置配置";
  return "默认配置";
}

export function formatContextUsage(context: Record<string, unknown> | null | undefined) {
  if (!context || typeof context !== "object") {
    return "-- / --";
  }
  const used = firstFiniteNumber(
    context.livePromptTokens,
    context.promptTokens,
    context.promptMessageTokens,
    context.messageTokens,
    context.providerPromptTokens
  );
  const limit = firstFiniteNumber(context.maxTokens, context.modelMaxTokens);
  const percent = typeof used === "number" && typeof limit === "number" && Number.isFinite(used) && Number.isFinite(limit) && limit > 0
    ? ` · ${Math.min(999, Math.round((used / limit) * 100))}%`
    : "";
  const cached = firstFiniteNumber(
    context.providerCachedPromptTokens,
    context.cachedPromptTokens
  );
  const promptForCache = firstFiniteNumber(
    context.providerPromptTokens,
    context.promptTokens
  );
  const cacheHit = typeof cached === "number" && typeof promptForCache === "number" && promptForCache > 0
    ? ` · 缓存命中 ${Math.min(100, Math.max(0, Math.round((cached / promptForCache) * 100)))}%`
    : " · 缓存命中 --";
  return `${formatTokenCount(used)} / ${formatTokenCount(limit)}${percent}${cacheHit}`;
}

export function firstFiniteNumber(...values: unknown[]) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) {
      return number;
    }
  }
  return null;
}

export function formatTokenCount(value: unknown) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return "--";
  }
  if (number >= 1000000) {
    return `${trimNumber(number / 1000000)}M`;
  }
  if (number >= 1000) {
    return `${trimNumber(number / 1000)}k`;
  }
  return String(Math.round(number));
}

export function trimNumber(value: number) {
  return value >= 10 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
}

export function nonNegativeInteger(value: unknown) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

export function collapseCompletedActivities() {
  if (state.completedActivities.length === 0) {
    return;
  }
  const node = document.createElement("details");
  node.className = "activity-summary";
  node.setAttribute("aria-live", "off");
  node.innerHTML = `
    <summary>过程记录 · ${state.completedActivities.length} 项</summary>
    <div class="activity-summary-list"></div>
  `;
  const list = node.querySelector(".activity-summary-list");
  if (list) {
    for (const activity of state.completedActivities.slice(-12)) {
      const item = document.createElement("div");
      item.className = `summary-row ${activity.severity ?? "info"}`;
      item.innerHTML = `
        <span class="status-dot"></span>
        <span>${escapeHtml(activity.title)}</span>
      `;
      list.append(item);
    }
  }
  appendTranscriptNode(node);
  state.completedActivities = [];
  scrollTranscript({ onlyIfNearBottom: true });
}

export function clearAssistantDrafts() {
  for (const draft of state.assistantDrafts.values()) {
    cancelScheduledAnimationFrame(draft, "renderFrame");
    draft.node?.remove();
  }
  state.assistantDrafts.clear();
}

export function collapseAssistantDrafts(finalText: unknown = "") {
  const capturedDrafts = Array.from(state.assistantDrafts.values()).filter((draft) => String(draft.text ?? "").trim().length > 0);
  clearAssistantDrafts();
  if (capturedDrafts.length === 0) {
    return;
  }
  const visibleDrafts = capturedDrafts.filter((draft) => !isDuplicateDraftText(draft.text, finalText));
  const node = document.createElement("details");
  node.className = `draft-summary${visibleDrafts.length === 0 ? " compact" : ""}`;
  node.setAttribute("aria-live", "off");
  const meta = visibleDrafts.length > 0 ? `已收起 · ${visibleDrafts.length} 轮` : "已收起 · 已汇入最终回复";
  node.innerHTML = `
    <summary>
      <span class="status-dot"></span>
      <span>思考过程</span>
      <span class="draft-summary-meta">${meta}</span>
    </summary>
    <div class="draft-summary-list">
      ${visibleDrafts.length === 0 ? `<div class="draft-summary-note">本轮流式草稿已合并到最终回复，没有额外过程内容。</div>` : ""}
    </div>
  `;
  const list = node.querySelector(".draft-summary-list");
  for (const draft of visibleDrafts) {
    const item = document.createElement("section");
    item.className = "draft-summary-item";
    const title = document.createElement("div");
    title.className = "draft-summary-title";
    title.textContent = Number.isFinite(draft.round) ? `第 ${draft.round} 轮` : "思考";
    const body = document.createElement("div");
    body.className = "message-body draft-plain-text";
    body.textContent = draft.text ?? "";
    item.append(title, body);
    list?.append(item);
  }
  appendTranscriptNode(node);
  scrollTranscript({ onlyIfNearBottom: true });
}

export function isMeaningfulCompletedActivity(activity: DashboardActivity) {
  if (activity.toolName === "agent_run") {
    return true;
  }
  return activity.toolName === "write_file" || activity.toolName === "edit_file" || activity.toolName === "powershell" || activity.toolName === "bash" || activity.toolName === "web_fetch" || activity.toolName === "web_search" || activity.toolName === "document_intake";
}

export function isDuplicateDraftText(draftText: unknown, finalText: unknown) {
  const draft = normalizeComparableText(draftText);
  const final = normalizeComparableText(finalText);
  if (!draft || !final) {
    return false;
  }
  if (draft === final) {
    return true;
  }
  const minLength = Math.min(draft.length, final.length);
  const maxLength = Math.max(draft.length, final.length);
  if (minLength < 120 || minLength / maxLength < 0.82) {
    return false;
  }
  return draft.includes(final) || final.includes(draft);
}

export function normalizeComparableText(text: unknown) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

export function showApproval(approval: DashboardApproval | null | undefined) {
  if (!approval) return;
  state.pendingApproval = approval;
  state.approvalSubmitting = false;
  els.approvalPanel.classList.remove("hidden");
  els.approvalPanel.setAttribute("tabindex", "-1");
  els.approvalPanel.setAttribute("role", "dialog");
  els.approvalPanel.setAttribute("aria-modal", "true");
  els.approvalPanel.setAttribute("aria-labelledby", "approval-title");
  els.approvalPanel.innerHTML = `
    <div class="approval-title" id="approval-title">需要权限确认 · ${escapeHtml(approval.toolName)}</div>
    <div class="approval-preview">${escapeHtml([
      approval.reason,
      approval.sensitive ? "敏感信息强确认：批准后相关内容可能进入模型上下文。" : "",
      approval.outsideWorkspace ? "目标位于工作区外，需要明确确认。" : "",
      ...(Array.isArray(approval.preview) ? approval.preview : [])
    ].filter(Boolean).join("\n"))}</div>
    <div class="approval-actions">
      <button type="button" data-action="allow-once">允许一次</button>
      <button type="button" data-action="allow-session">本会话允许</button>
      <button type="button" data-action="deny" class="danger">拒绝</button>
      <button type="button" data-action="cancel">取消</button>
    </div>
  `;
  els.approvalPanel.querySelectorAll("button[data-action]").forEach((button) => {
    button.addEventListener("click", () => resolveApproval(button.dataset.action));
  });
  activateModal(els.approvalPanel, { initialFocus: "button[data-action='allow-once']" });
  revealInteractionPanel(els.approvalPanel, "button[data-action]");
  announceStatus(`需要确认 ${approval.toolName ?? "工具"} 权限`);
}

export async function resolveApproval(action: unknown) {
  const approval = state.pendingApproval;
  if (!approval || state.approvalSubmitting) return;
  state.approvalSubmitting = true;
  const buttons = /** @type {HTMLButtonElement[]} */ (Array.from(els.approvalPanel.querySelectorAll("button[data-action]")));
  for (const button of buttons) button.disabled = true;
  const result = await postJson(`/api/approvals/${encodeURIComponent(approval.id ?? "")}`, { action })
    .catch((error: unknown): DashboardApiResult => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  if (state.pendingApproval?.id !== approval.id) return;
  if (!result.ok) {
    state.approvalSubmitting = false;
    for (const button of buttons) button.disabled = false;
    showError(result.error ?? "权限确认提交失败");
    return;
  }
  hideApproval();
  els.runStatus.textContent = state.running ? "运行中" : "处理中";
}

export function hideApproval() {
  deactivateModal(els.approvalPanel);
  state.pendingApproval = null;
  state.approvalSubmitting = false;
  els.approvalPanel.classList.add("hidden");
  els.approvalPanel.innerHTML = "";
}

export function showQuestion(question: DashboardPendingQuestion | null | undefined) {
  if (!question) return;
  deactivateQuestionReviewBackground();
  state.questionReviewMode = false;
  state.questionSubmitting = false;
  state.pendingQuestion = {
    ...question,
    selectedChoices: new Set((question.choices ?? []).filter((choice) => choice.selected).map((choice) => choice.value ?? choice.label)),
    customDraft: ""
  };
  renderQuestionPanel();
  activateModal(els.questionPanel, {
    initialFocus: ".question-input, button[data-choice], button[data-action='submit']"
  });
  revealInteractionPanel(els.questionPanel, ".question-input, button[data-choice], button[data-action='submit']");
  announceStatus("需要核对任务需求");
}

export function revealInteractionPanel(panel: HTMLElement | null | undefined, focusSelector: string | null | undefined) {
  if (!panel || panel.classList.contains("hidden")) {
    return;
  }
  panel.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  const target = focusSelector ? panel.querySelector(focusSelector) : null;
  const focusTarget = target ?? panel;
  if (typeof focusTarget.focus === "function") {
    focusTarget.focus({ preventScroll: true });
  }
}

export function renderQuestionPanel() {
  const question = state.pendingQuestion;
  const panel = els.questionPanel;
  if (!question || !panel) return;
  panel.classList.remove("hidden");
  panel.classList.toggle("question-reviewing", state.questionReviewMode);
  if (state.questionReviewMode) {
    panel.setAttribute("role", "region");
    panel.setAttribute("aria-label", "需求确认待处理");
    panel.removeAttribute("aria-modal");
    panel.removeAttribute("aria-labelledby");
    panel.removeAttribute("aria-describedby");
    panel.setAttribute("tabindex", "-1");
    panel.innerHTML = `
      <div class="question-review-bar">
        <div class="question-review-copy">
          <div class="question-review-title">需求确认待处理</div>
          <div class="question-review-summary">${escapeHtml(question.header ?? question.question ?? "返回后继续确认")}</div>
        </div>
        <button type="button" data-action="return-to-question">返回确认</button>
      </div>
    `;
    panel.querySelector("button[data-action='return-to-question']")?.addEventListener("click", returnToQuestion);
    return;
  }
  panel.removeAttribute("aria-label");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-labelledby", "question-title");
  panel.setAttribute("aria-describedby", "question-copy");
  panel.setAttribute("tabindex", "-1");
  const choices = question.choices ?? [];
  panel.innerHTML = `
    <div class="question-read-pane">
      <div class="question-title" id="question-title">${escapeHtml(question.header ?? "需求核对")}</div>
      <div class="question-copy" id="question-copy">${escapeHtml(question.question ?? "请确认需求")}</div>
      ${choices.length ? `<div class="question-choices">${choices.map((choice) => questionChoiceButton(choice, question)).join("")}</div>` : ""}
      ${question.allowCustom ? `<label class="visually-hidden" for="question-response">补充回答</label><textarea class="question-input" id="question-response" rows="2" aria-describedby="question-copy" placeholder="${choices.length ? "补充其他要求，可留空" : "输入你的回答"}"></textarea>` : ""}
    </div>
    <div class="question-actions">
      <div class="question-prompt-summary">${escapeHtml(question.header ?? "需求核对")}</div>
      <div class="question-action-buttons">
        <button type="button" data-action="review-conversation">查看对话</button>
        <button type="button" data-action="submit">${escapeHtml(question.confirmLabel ?? "确认")}</button>
        <button type="button" data-action="cancel">取消</button>
      </div>
    </div>
  `;
  /** @type {NodeListOf<HTMLButtonElement>} */ (panel.querySelectorAll("button[data-choice]")).forEach((button) => {
    button.addEventListener("click", () => toggleQuestionChoice(button.dataset.choice));
  });
  panel.querySelector("button[data-action='review-conversation']")?.addEventListener("click", reviewQuestionConversation);
  panel.querySelector("button[data-action='submit']")?.addEventListener("click", submitQuestion);
  panel.querySelector("button[data-action='cancel']")?.addEventListener("click", cancelQuestion);
  const input = /** @type {HTMLTextAreaElement | null} */ (panel.querySelector(".question-input"));
  if (input) {
    input.value = question.customDraft ?? "";
    input.addEventListener("input", () => {
      question.customDraft = input.value;
    });
    if (choices.length === 0) {
      input.focus();
    }
  }
}

export function reviewQuestionConversation() {
  if (!state.pendingQuestion || state.questionReviewMode) return;
  rememberQuestionDraft();
  deactivateModal(els.questionPanel, { restoreFocus: false });
  state.questionReviewMode = true;
  renderQuestionPanel();
  activateQuestionReviewBackground();
  els.transcript?.focus?.({ preventScroll: true });
  announceStatus("需求确认已收起，可以查看对话；按 Esc 返回确认");
}

export function returnToQuestion() {
  if (!state.pendingQuestion || !state.questionReviewMode) return;
  deactivateQuestionReviewBackground();
  state.questionReviewMode = false;
  renderQuestionPanel();
  activateModal(els.questionPanel, {
    initialFocus: ".question-input, button[data-choice], button[data-action='submit']"
  });
  revealInteractionPanel(els.questionPanel, ".question-input, button[data-choice], button[data-action='submit']");
  announceStatus("已返回需求确认");
}

export function activateQuestionReviewBackground() {
  deactivateQuestionReviewBackground();
  const transcript = els.transcript;
  const panel = els.questionPanel;
  if (!transcript || !panel) return;
  const transcriptStage = transcript.closest?.(".transcript-stage") ?? transcript;
  const entries = collectModalBackground(panel).filter((entry) => (
    entry.node !== transcriptStage && !entry.node.contains?.(transcriptStage)
  ));
  state.questionReviewInertEntries = entries;
  for (const entry of entries) entry.node.inert = true;
}

export function deactivateQuestionReviewBackground() {
  for (const entry of state.questionReviewInertEntries) entry.node.inert = entry.inert;
  state.questionReviewInertEntries = [];
}

export function questionChoiceButton(choice: DashboardQuestionChoice, question: DashboardPendingQuestion) {
  const value = String(choice.value ?? choice.label);
  const selected = question.selectedChoices?.has(value) === true;
  return `
    <button type="button" class="question-choice${selected ? " selected" : ""}" data-choice="${escapeHtml(value)}" aria-pressed="${selected ? "true" : "false"}">
      <span>${escapeHtml(choice.label ?? value)}</span>
      ${choice.description ? `<small>${escapeHtml(choice.description)}</small>` : ""}
    </button>
  `;
}

export function toggleQuestionChoice(value: unknown) {
  const question = state.pendingQuestion;
  if (!question) return;
  rememberQuestionDraft();
  const selectedChoices = question.selectedChoices ?? new Set();
  if (question.multiple) {
    if (selectedChoices.has(value)) {
      selectedChoices.delete(value);
    } else {
      selectedChoices.add(value);
    }
    question.selectedChoices = selectedChoices;
  } else {
    question.selectedChoices = new Set([value]);
  }
  renderQuestionPanel();
  Array.from(els.questionPanel.querySelectorAll("button[data-choice]"))
    .find((button) => button.dataset.choice === value)
    ?.focus({ preventScroll: true });
}

export async function submitQuestion() {
  const question = state.pendingQuestion;
  if (!question || state.questionSubmitting) return;
  rememberQuestionDraft();
  const selectedChoices = Array.from(question.selectedChoices ?? []);
  const customAnswer = (question.customDraft ?? "").trim();
  state.questionSubmitting = true;
  const buttons = /** @type {HTMLButtonElement[]} */ (Array.from(els.questionPanel.querySelectorAll("button[data-action]")));
  for (const button of buttons) button.disabled = true;
  const result = await postJson(`/api/questions/${encodeURIComponent(question.id ?? "")}`, {
    selectedChoices,
    customAnswer,
    answer: customAnswer,
    cancelled: false
  }).catch((error: unknown): DashboardApiResult => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  finishQuestionSubmission(question, buttons, result);
}

export async function cancelQuestion() {
  const question = state.pendingQuestion;
  if (!question || state.questionSubmitting) return;
  state.questionSubmitting = true;
  const buttons = /** @type {HTMLButtonElement[]} */ (Array.from(els.questionPanel.querySelectorAll("button[data-action]")));
  for (const button of buttons) button.disabled = true;
  const result = await postJson(`/api/questions/${encodeURIComponent(question.id ?? "")}`, {
    cancelled: true,
    answer: "",
    selectedChoices: []
  }).catch((error: unknown): DashboardApiResult => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  finishQuestionSubmission(question, buttons, result);
}

/** @param {any} question @param {HTMLButtonElement[]} buttons @param {any} result */
export function finishQuestionSubmission(question: DashboardPendingQuestion, buttons: HTMLElement[], result: DashboardApiResult) {
  if (state.pendingQuestion?.id !== question.id) return;
  if (!result.ok) {
    state.questionSubmitting = false;
    for (const button of buttons) button.disabled = false;
    showError(result.error ?? "需求确认提交失败");
    return;
  }
  hideQuestion();
  els.runStatus.textContent = state.running ? "运行中" : "处理中";
}

export function hideQuestion() {
  deactivateModal(els.questionPanel);
  deactivateQuestionReviewBackground();
  state.questionReviewMode = false;
  state.questionSubmitting = false;
  state.pendingQuestion = null;
  els.questionPanel.classList.remove("question-reviewing");
  els.questionPanel.classList.add("hidden");
  els.questionPanel.innerHTML = "";
}

export function showTrustPanel() {
  renderTrustPanel();
}

export function renderTrustPanel() {
  if (!state.trust || state.trust.trusted) {
    els.trustPanel.classList.add("hidden");
    els.trustPanel.innerHTML = "";
    return;
  }
  els.trustPanel.classList.remove("hidden");
  const perProcess = state.trust.requiresPerProcessConfirmation
    ? "当前为高敏模式，本次确认只授权当前 Dashboard 进程。"
    : "确认后会记录这个工作区，下次从同一路径启动可继续使用。";
  els.trustPanel.innerHTML = `
    <div>
      <div class="trust-title">信任此工作区？</div>
      <div class="trust-copy">${escapeHtml(state.trust.displayPath ?? state.cwd)}</div>
      <div class="trust-copy">${escapeHtml(perProcess)}</div>
    </div>
    <div class="trust-actions">
      <button type="button" data-action="trust">信任并继续</button>
    </div>
  `;
  els.trustPanel.querySelector("button[data-action='trust']").addEventListener("click", confirmTrust);
}

export async function confirmTrust() {
  const button = els.trustPanel.querySelector("button[data-action='trust']");
  if (button) {
    button.disabled = true;
    button.textContent = "保存中";
  }
  const result = await postJson("/api/trust", {}).catch((error: unknown): DashboardApiResult => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  if (!result.ok) {
    showError(result.error ?? "工作区信任保存失败");
    renderTrustPanel();
    return;
  }
  state.trust = result.trust ?? null;
  renderTrustPanel();
  updateSendButton();
  els.promptInput.focus();
}

export function renderQueuePanel() {
  const visible = state.running || state.queue.length > 0 || state.pendingGuide;
  els.queuePanel.classList.toggle("hidden", !visible);
  if (!visible) {
    els.queuePanel.innerHTML = "";
    return;
  }
  const guideFeedback = state.pendingGuide ? renderGuideFeedback(state.pendingGuide) : "";
  const queueItems = state.queue.slice(0, 6).map((item: Record<string, unknown>, index: number) => renderQueueItem(item, index)).join("");
  const hiddenQueueCount = Math.max(0, state.queue.length - 6);
  els.queuePanel.innerHTML = `
    <div class="queue-head">
      <div class="queue-summary">
        <div class="queue-title">${state.queue.length > 0 ? `${state.queue.length} 条排队中` : "当前任务运行中"}</div>
        <div class="queue-copy">输入新内容回车会进入队列，未开始的队列可以取消。</div>
      </div>
      <button type="button" id="guide-button" class="${guideButtonVisible() ? "" : "hidden"}" ${guideButtonDisabled() ? "disabled" : ""}>${guideButtonText()}</button>
    </div>
    ${guideFeedback}
    ${queueItems ? `<div class="queue-list">${queueItems}${hiddenQueueCount ? `<div class="queue-more">还有 ${hiddenQueueCount} 条排队内容未展开</div>` : ""}</div>` : ""}
  `;
  els.queuePanel.querySelector("#guide-button")?.addEventListener("click", () => guideTurn());
  els.queuePanel.querySelectorAll("[data-guide-queue-id]").forEach((button) => {
    button.addEventListener("click", () => guideTurnFromQueue(button.dataset.guideQueueId));
  });
  els.queuePanel.querySelectorAll("[data-cancel-queue-id]").forEach((button) => {
    button.addEventListener("click", () => cancelQueuedTurn(button.dataset.cancelQueueId));
  });
  syncGuideButton();
}

export function renderQueueItem(item: Record<string, unknown>, index: number) {
  const isCancelling = state.queueCancelling.has(item.id);
  return `
    <div class="queue-item${item.kind === "guide" ? " guide" : ""}">
      <span>${index + 1}</span>
      <strong>${item.kind === "guide" ? "引导" : item.kind === "wakeup" ? "接续" : item.kind === "goal-continue" ? "Goal 续跑" : "排队"}</strong>
      <em>${escapeHtml(item.preview ?? "")}</em>
      <div class="queue-actions">
        ${item.kind === "guide" || item.kind === "wakeup" || item.kind === "goal-continue" ? "" : `<button type="button" class="queue-guide-button" data-guide-queue-id="${escapeHtml(item.id)}" ${isCancelling ? "disabled" : ""}>引导</button>`}
        <button type="button" class="queue-cancel-button" data-cancel-queue-id="${escapeHtml(item.id)}" ${isCancelling ? "disabled" : ""}>${isCancelling ? "取消中" : "取消"}</button>
      </div>
    </div>
  `;
}

export function setPendingGuide(guide: DashboardPendingGuide) {
  state.pendingGuide = {
    ...state.pendingGuide ?? {},
    ...guide,
    preview: previewText(guide.preview ?? state.pendingGuide?.preview ?? "")
  };
  renderQueuePanel();
  updateLiveStatus();
}

export function clearPendingGuide() {
  state.pendingGuide = null;
  renderQueuePanel();
}

export function syncPendingGuideFromQueue() {
  if (state.pendingGuide) {
    const stillQueued = state.queue.some((item) => item.kind === "guide");
    if (!stillQueued && !state.running && state.pendingGuide.phase === "registered") {
      clearPendingGuide();
      return;
    }
    renderQueuePanel();
    return;
  }
  const queuedGuide = state.queue.find((item) => item.kind === "guide");
  if (queuedGuide) {
    setPendingGuide({
      sessionId: state.currentSessionId,
      phase: "registered",
      preview: queuedGuide.preview ?? ""
    });
    return;
  }
  renderQueuePanel();
}

export function renderGuideFeedback(guide: DashboardPendingGuide) {
  const copy = guideCopy(guide.phase);
  const preview = guide.preview ? `<div class="guide-preview">${escapeHtml(guide.preview)}</div>` : "";
  return `
    <div class="guide-feedback ${escapeHtml(guide.phase ?? "registered")}">
      <span class="chip-pulse" aria-hidden="true"></span>
      <div class="guide-feedback-body">
        <strong>${escapeHtml(copy.title)}</strong>
        <small>${escapeHtml(copy.detail)}</small>
        ${preview}
      </div>
    </div>
  `;
}

export function guideCopy(phase: unknown) {
  if (phase === "registering") {
    return {
      title: "正在登记引导",
      detail: "点击已生效，正在把这条要求放到下一轮优先处理。"
    };
  }
  if (phase === "interrupting") {
    return {
      title: "引导已接管",
      detail: "正在等待当前轮次收束，随后会优先按这条引导继续。"
    };
  }
  if (phase === "continuing") {
    return {
      title: "正在按引导继续",
      detail: "当前回复已经切到引导后的续跑。"
    };
  }
  if (phase === "stopped") {
    return {
      title: "已收到停止引导",
      detail: "正在停止当前轮次，不会再创建新的引导续跑。"
    };
  }
  return {
    title: "引导已登记",
    detail: "下一轮会优先按这条引导继续。"
  };
}

export function guideSource(queueItemId: unknown = "") {
  const queuedItem = queueItemId
    ? state.queue.find((item) => item.id === queueItemId && item.kind === "prompt" && !state.queueCancelling.has(item.id))
    : null;
  if (queueItemId && !queuedItem) {
    return null;
  }
  if (queuedItem) {
    return {
      guidance: queuedItem.preview ?? "",
      queueItemId: queuedItem.id,
      preview: queuedItem.preview ?? ""
    };
  }
  const guidance = els.promptInput.value.trim();
  if (guidance) {
    return { guidance, queueItemId: "", preview: guidance };
  }
  return null;
}

export function guideTurnFromQueue(queueItemId: unknown) {
  if (!queueItemId || state.guideSubmitting) {
    return;
  }
  guideTurn(queueItemId);
}

export function guideButtonText() {
  if (state.guideSubmitting || state.pendingGuide?.phase === "registering") return "登记中";
  if (els.promptInput.value.trim()) return "引导对话";
  if (state.pendingGuide?.phase === "interrupting") return "接管中";
  if (state.pendingGuide?.phase === "continuing") return "引导中";
  return "引导对话";
}

export function guideButtonDisabled() {
  return !state.running || state.guideSubmitting || !guideSource();
}

export function guideButtonVisible() {
  return state.running && (Boolean(els.promptInput.value.trim()) || state.guideSubmitting || state.pendingGuide?.phase === "registering");
}

export function syncGuideButton() {
  const button = els.queuePanel.querySelector("#guide-button");
  if (!button) return;
  button.classList.toggle("hidden", !guideButtonVisible());
  button.disabled = guideButtonDisabled();
  button.textContent = guideButtonText();
}

export function shouldKeepGuideFeedback() {
  return state.pendingGuide?.phase === "registering" || state.pendingGuide?.phase === "registered" || state.pendingGuide?.phase === "interrupting";
}

export function isInterruptError(message: string | null | undefined) {
  return /aborted|abort|interrupted|中断|取消/i.test(String(message ?? ""));
}

export function updateSendButton() {
  updateContextActions();
  els.sendButton.setAttribute("aria-busy", String(state.turnSubmitting));
  if (state.turnSubmitting) {
    els.sendButton.textContent = "提交中";
    els.sendButton.title = "正在提交任务";
    els.sendButton.disabled = true;
    return;
  }
  if (!state.trust?.trusted) {
    els.sendButton.textContent = "待信任";
    els.sendButton.disabled = false;
    return;
  }
  if (!state.running && currentSessionNeedsModelSelection()) {
    els.sendButton.textContent = "选择模型";
    els.sendButton.title = "请先重新选择模型来源和模型";
    els.sendButton.disabled = true;
    return;
  }
  if (state.running) {
    els.sendButton.textContent = "中断";
    els.sendButton.title = "点击中断当前任务";
  } else {
    els.sendButton.textContent = "发送";
    els.sendButton.title = "发送";
  }
  els.sendButton.disabled = false;
}

export function showContextConfirm(action: unknown) {
  const isClear = action === "clear";
  const panel = els.contextPanel;
  if (!panel) return;
  if (els.contextClear.disabled || els.contextCompact.disabled) return;
  panel.classList.remove("hidden");
  panel.innerHTML = `
    <div>
      <div class="context-title" id="context-confirm-title">${isClear ? "清空上下文？" : "压缩上下文？"}</div>
      <div class="context-copy">${isClear ? "这会清除当前会话的模型上下文，历史记录仍可在左侧查看。" : "这会整理较早上下文，保留近期对话并写入压缩摘要。"}</div>
    </div>
    <div class="context-confirm-actions">
      <button type="button" data-action="cancel">取消</button>
      <button type="button" data-action="${action}" class="${isClear ? "danger" : ""}">${isClear ? "确认清空" : "确认压缩"}</button>
    </div>
  `;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-labelledby", "context-confirm-title");
  panel.setAttribute("tabindex", "-1");
  panel.querySelector("button[data-action='cancel']")?.addEventListener("click", () => hideContextConfirm());
  panel.querySelector(`button[data-action='${action}']`)?.addEventListener("click", () => runContextAction(action));
  activateModal(panel, { initialFocus: "button[data-action='cancel']" });
}

export function hideContextConfirm() {
  const panel = els.contextPanel;
  if (!panel) return;
  deactivateModal(panel);
  panel.classList.add("hidden");
  panel.innerHTML = "";
}

export async function runContextAction(action: unknown) {
  const endpoint = action === "clear" ? "/api/context/clear" : "/api/context/compact";
  const button = els.contextPanel.querySelector(`button[data-action='${action}']`);
  if (button) {
    button.disabled = true;
    button.textContent = action === "clear" ? "清空中" : "压缩中";
  }
  const result = await postJson(endpoint, {
    sessionId: state.currentSessionId,
    permissionMode: state.permissionMode
  }, contextActionRequestOptions(action)).catch((error: unknown): DashboardApiResult => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  if (!result.ok) {
    showError(result.error ?? "上下文操作失败");
    hideContextConfirm();
    return;
  }
  state.currentSessionId = result.sessionId ?? state.currentSessionId;
  hideContextConfirm();
  appendActivity({
    title: action === "clear" ? "上下文已清空" : "上下文已压缩",
    detail: action === "clear" ? contextSummaryLine(result.after) : compactResultLine(result.result),
    severity: "success",
    collapsed: true
  });
  updateSessionStatus(result.sessionStatus);
}

/** @param {string} action */
export function contextActionRequestOptions(action: unknown) {
  return action === "compact" ? { timeoutMs: null } : {};
}

export function contextSummaryLine(summary: unknown) {
  const record = isPlainObject(summary) ? summary : null;
  return record ? `${record.messages ?? 0} 条上下文消息，摘要 ${record.summaryBytes ?? 0} 字节` : "";
}

export function compactResultLine(result: unknown) {
  const record = isPlainObject(result) ? result : null;
  if (!record) return "";
  return record.compacted
    ? `${record.beforeMessages ?? "-"} -> ${record.afterMessages ?? "-"}，摘要 ${record.summaryBytes ?? 0} 字节`
    : `未压缩：${record.reason ?? "无需压缩"}`;
}

export function rememberQuestionDraft() {
  const question = state.pendingQuestion;
  if (!question) return;
  const input = els.questionPanel.querySelector(".question-input");
  if (input) {
    question.customDraft = input.value;
  }
}

export function questionResolutionText(event: { cancelled?: boolean; selectedChoices?: unknown[]; answer?: unknown }) {
  if (event.cancelled) {
    return "已取消需求核对";
  }
  const parts: unknown[] = [];
  for (const choice of event.selectedChoices ?? []) {
    if (choice && !parts.includes(choice)) {
      parts.push(choice);
    }
  }
  if (event.answer && !parts.includes(event.answer)) {
    parts.push(event.answer);
  }
  return parts.length > 0 ? `需求核对：${parts.join("；")}` : "已确认需求核对";
}

export async function showShutdownPanel() {
  const version = ++state.shutdownStatusVersion;
  cancelScopedRequest("shutdown");
  const request = beginScopedRequest("shutdown");
  state.shutdownActivity = null;
  els.shutdownCopy.textContent = "正在检查主任务、队列和后台任务，请稍候。";
  els.shutdownConfirm.disabled = true;
  els.shutdownConfirm.textContent = "检查中";
  els.shutdownPanel.classList.remove("hidden");
  activateModal(els.shutdownPanel, { initialFocus: "#shutdown-cancel" });
  announceStatus("需要确认是否关闭 Dashboard");
  // This is the getJson("/api/lifecycle/status") probe; keep it scoped and bounded.
  const result = await getJson("/api/lifecycle/status", {
    signal: request.signal,
    timeoutMs: DASHBOARD_LIFECYCLE_TIMEOUT_MS
  }).catch((error: unknown): DashboardApiResult => ({
    ok: false,
    error: errorMessageOf(error),
    code: isPlainObject(error) && typeof error.code === "string" ? error.code : undefined,
    timedOut: isPlainObject(error) && error.code === "DASHBOARD_REQUEST_TIMEOUT"
  }));
  if (!isCurrentScopedRequest(request) || version !== state.shutdownStatusVersion || els.shutdownPanel.classList.contains("hidden")) return;
  finishScopedRequest(request);
  if (!result.ok) {
    // If the activity probe is stuck, keep a safe escape hatch: explicit
    // cancellation/force shutdown is still available and the request itself
    // cannot hold the modal in a permanent checking state.
    Object.assign(state, {
      shutdownActivity: normalizeLifecycleActivity({ sessions: 1, total: 1, uncertain: true })
    });
    const detail = result.timedOut ? "活动检查超时" : (errorMessageOf(result.error) || "未知错误");
    els.shutdownCopy.textContent = `无法确认当前活动状态：${detail}。可以取消任务并强制关闭，或返回继续处理。`;
    els.shutdownConfirm.disabled = false;
    els.shutdownConfirm.textContent = "强制关闭";
    announceStatus("Dashboard 活动检查超时，可强制关闭");
    return;
  }
  state.shutdownActivity = normalizeLifecycleActivity(result.activity);
  renderShutdownActivity();
}

export function hideShutdownPanel() {
  state.shutdownStatusVersion += 1;
  cancelScopedRequest("shutdown");
  deactivateModal(els.shutdownPanel);
  els.shutdownPanel.classList.add("hidden");
  els.shutdownConfirm.disabled = false;
  els.shutdownConfirm.textContent = "确认关闭";
}

export async function shutdownDashboard() {
  if (!state.shutdownActivity) return;
  cancelScopedRequest("shutdown");
  const request = beginScopedRequest("shutdown");
  els.shutdownConfirm.disabled = true;
  els.shutdownConfirm.textContent = "正在关闭";
  const result = await postJson("/api/shutdown", shutdownRequestBody(state.shutdownActivity), {
    signal: request.signal,
    timeoutMs: DASHBOARD_SHUTDOWN_TIMEOUT_MS
  }).catch((error: unknown): DashboardApiResult => ({
    ok: false,
    error: errorMessageOf(error),
    code: isPlainObject(error) && typeof error.code === "string" ? error.code : undefined
  }));
  if (!isCurrentScopedRequest(request)) return;
  finishScopedRequest(request);
  if (!shutdownResultIsClosed(result)) {
    const requestTimedOut = result?.code === "DASHBOARD_REQUEST_TIMEOUT";
    state.shutdownActivity = normalizeLifecycleActivity({
      ...(result?.activity ?? state.shutdownActivity ?? {}),
      uncertain: requestTimedOut || result?.activity?.uncertain === true || state.shutdownActivity?.uncertain === true
    });
    els.shutdownCopy.textContent = `${errorMessageOf(result?.error) || "关闭失败"} ${lifecycleActivitySummary(state.shutdownActivity)}。你可以返回继续处理，或重试取消任务并关闭。`;
    els.shutdownConfirm.disabled = false;
    els.shutdownConfirm.textContent = state.shutdownActivity.uncertain
      ? "强制关闭"
      : state.shutdownActivity.total > 0 ? "重试取消并关闭" : "重试关闭";
    els.runStatus.textContent = "关闭失败";
    announceStatus("Dashboard 关闭失败，页面仍可继续使用");
    els.shutdownConfirm.focus({ preventScroll: true });
    return;
  }
  disconnectEvents();
  deactivateModal(els.shutdownPanel, { restoreFocus: false });
  els.shutdownPanel.classList.add("hidden");
  hideSettingsWorkspace({ restoreFocus: false });
  state.responsiveView = "conversation";
  syncResponsiveNavigation();
  document.body.classList.add("dashboard-closed");
  els.runStatus.textContent = "已关闭";
  cancelTranscriptAnimationFrames();
  resetTranscriptWindow();
  els.transcript.innerHTML = `
    <div class="empty-state">
      <div class="empty-kicker">Ant Code Dashboard</div>
      <div class="empty-title">Dashboard 已关闭</div>
      <div class="empty-copy">本机 WebUI 服务已经停止，可以关闭这个页面。再次使用时重新运行 ant-code dashboard。</div>
    </div>
  `;
  lockClosedDashboard();
  announceStatus("Dashboard 已关闭");
}

