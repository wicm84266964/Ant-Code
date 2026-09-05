import { renderMarkdown } from "./markdown.ts";
import { hydrateRichContent } from "./rich-renderers.ts";
import { visibleTranscriptRole } from "./transcript.ts";
import { MANUAL_AGENT_MODEL_VALUE, state, els, MODE_DESCRIPTIONS, LOCAL_FILE_EXTENSIONS, FILE_REFERENCE_PATTERN, TRANSCRIPT_DOM_LIMIT, EVENT_STALE_AFTER_MS, EVENT_CONNECT_TIMEOUT_MS, EVENT_RECONNECT_MAX_ATTEMPTS, DASHBOARD_REQUEST_TIMEOUT_MS, DASHBOARD_API_VERSION, DASHBOARD_LIFECYCLE_TIMEOUT_MS, DASHBOARD_SHUTDOWN_TIMEOUT_MS, DASHBOARD_INTERRUPT_TIMEOUT_MS, MAX_IMAGE_ATTACHMENTS, MAX_IMAGE_ATTACHMENT_BYTES, CURRENT_SESSION_STORAGE_KEY, DASHBOARD_CLIENT_STORAGE_KEY, PREVIEW_WIDTH_STORAGE_KEY, PREVIEW_WIDTH_DEFAULT, PREVIEW_WIDTH_MIN, PREVIEW_WIDTH_MAX, PREVIEW_WORKSPACE_MIN , emptySessionStatus, emptyBackgroundSubagent } from "./app-core.ts";
import type { DashboardConfigSource, DashboardReasoningEffort, DashboardTurnChangeStats, DashboardScopedDefaultSelection, DashboardVisionAgent, DashboardReasoningDiscovery, DashboardReasoningCapabilityCandidate, DashboardGatewayProbeModel, DashboardGatewayProbeResult, DashboardLifecycleActivity, DashboardSettings, DashboardFile, DashboardTableSheet, DashboardTablePreview, DashboardLightboxItem, DashboardQuestionChoice, DashboardPendingQuestion, DashboardApproval, DashboardGatewayTransport, DashboardScopedRequest, DashboardFetchOptions, DashboardModelSource, DashboardSessionStatus, DashboardApiResult, DashboardActivity, DashboardModelOption, DashboardGatewayProfile, DashboardGatewayConfig, DashboardModelSelection, DashboardPendingGuide, DashboardStreamEvent, DashboardUiState , DashboardSessionSummary } from "./app-core.ts";
import { eventTargetOf, eventElement, isPlainObject, modelSourceOf, errorMessageOf, init, bootstrapDashboard, observeRunStatus, updateRunStatusTone, bindEvents, normalizedResponsiveView, composerHeightFor, previewWidthBounds, clampedPreviewWidth, permissionIndexForKey, focusTrapTarget, shouldFollowTranscript, scheduleAnimationFrameOnce, cancelScheduledAnimationFrame, appendPlainDraftDelta, renderFinalAssistantBody, selectTranscriptNodesToRemove, responsiveLayoutMode, restorePreviewWidth, setPreviewWidth, syncPreviewResizeHandle, beginPreviewResize, updatePreviewResize, finishPreviewResize, handlePreviewResizeKeydown, setResponsiveView, syncResponsiveNavigation, setResponsiveSurfaceInert, handleResponsiveFileNavigation, syncVisualViewport, resizePromptInput, handlePermissionModeKeydown, requestPermissionMode, defaultGoalMaxAutoContinues, emptyGoalSnapshot, applyGoalSnapshot, renderGoalControls, renderGoalStatusBar, requestGoalMode, showGoalConfirm, hideGoalConfirm, showGoalTextPanel, hideGoalTextPanel, enableGoalWithObjective, submitGoalAction, adoptGoalRunResult, showPermissionConfirm, hidePermissionConfirm, updateContextActions, announceStatus, modalFocusableElements, activateModal, collectModalBackground, focusModalInitialTarget, deactivateModal, restoreModalAttribute, handleGlobalKeydown, closeActiveModal, loadTrust, loadSessions, restoreInitialSession, latestBackgroundSessionId, initialSessionId, rememberCurrentSession, renderSessions, sessionMeta, sessionStatusView, toggleSidebar, setSidebarCollapsed, sessionsNeedRefresh, scheduleSessionsRefresh, handleSessionAction, openSession, restoreBackgroundSnapshot, deleteSession, setSessionsRefreshState, copySessionId, newTask, rememberNewTaskModelState, restoreNewTaskModelState, refreshNewTaskModelState, addAttachmentFiles, readImageAttachment, renderAttachmentStrip, attachmentPayload, clearAttachments, sendPrompt, stableTurnRequest, dashboardRequestId, dashboardClientId, statusUrl, interruptTurn, guideTurn, cancelQueuedTurn, cancelBackgroundSubagent, backgroundCancelKey, connectEvents, ensureEventsConnected, disconnectEvents, closeEventSource, markEventConnectionAlive, armEventConnectTimer, armEventStaleTimer, scheduleEventReconnect, reconnectEventsManually, clearEventReconnectTimer, clearEventConnectTimer, clearEventStaleTimer, setConnectionState, resetEventReplayState, rememberEventCursor, handleDashboardEvent, shouldSkipDashboardEvent, beginEventTurn, renderTranscriptMessages, renderSessionFailure, setTranscriptPaging, renderTranscriptHistoryStatus, removeTranscriptHistoryStatus, transcriptFirstContentNode, handleTranscriptScroll, loadOlderTranscript, renderWorkflowPanel, renderWorkflowStrip, currentWorkflowItem, workflowSection, workflowItem, normalizeWorkflowStatus, summarizeWorkflow, appendMessage, createMessageNode, appendTranscriptNode, trimTranscriptWindow, isProtectedTranscriptNode, renderTranscriptWindowMarker, captureTranscriptViewportAnchor, restoreTranscriptViewportAnchor, transcriptNodeTop, restoreTranscriptNodeAnchor, resetTranscriptWindow, appendAssistantDraft, scheduleDraftRender, renderAssistantDraft, appendActivity, appendContextBoundary, contextBoundaryText, handleActivity, isBackgroundSubagentActivity, handleBackgroundSubagentActivity, clearBackgroundSubagentStatus, reconcileBackgroundSubagentSnapshot, backgroundSubagentDisplayStatus, backgroundSubagentVisible, updateLiveActivity, removeLiveActivity, setLiveTitle, toggleLiveStatusDetails, updateLiveStatus, liveStatusTitle, primaryLiveActivity, gatewayRetryChipText, renderBackgroundSubagentStatus, backgroundSubagentCompactLabel, backgroundSubagentTitle, backgroundSubagentMeta, backgroundSubagentCancellable, resetLiveStatus, backgroundSubagentCounts, idleRunStatus, applyIdleRunStatus, updateRunStatusForBackground, updateSessionStatus, updateTurnChangeStats, resetTurnChangeStats, normalizeChangeStats, renderComposerStatus, modelStatusHtml, unresolvedModelStatusHtml, handleModelStatusActivate, handleModelStatusKeydown, toggleModelPanel, hideModelPanel, showSettingsWorkspace, refreshSettingsConfiguration, hideSettingsWorkspace, showModelConfigPanel, hideModelConfigPanel, renderModelPanel, modelCapabilityLabels, handleModelPanelClick, handleModelPanelChange, renderSettingsView, syncSettingsRail, modelSettingsHtml, transcriptSettingsHtml, transcriptRetentionOptionsHtml, networkSettingsHtml, networkModeOptionHtml, agentSettingsHtml, reliabilitySettingsHtml, settingsSectionHeading, settingsToggleHtml, managedFieldHtml, settingsDisabled, settingsFormActions, settingsFeedbackHtml, settingsGatewayProfileHtml, gatewayProfileReadonlyLabel, providerModelKey, scopedDefaultModelLabel, settingsModelHtml, handleSettingsRailClick, initializeSettingsFormTracking, handleSettingsFormChange, settingsControlValue, changedSettingsFields, canonicalSettingsField, setSettingsFormSaving, renderSettingsFeedbackInPlace, saveSettingsConfig, handleSettingsClick, protocolDisplayName, agentModelPickerHtml, renderModelConfigPanel, handleModelConfigPanelClick, handleModelConfigInput, handleModelConfigChange, markModelConfigCredentialChanged, markModelConfigEndpointChanged, handleModelConfigModelIdChanged, markReasoningCapabilityManual, clearReasoningCapabilityControls, syncGatewayUrlHint, gatewayUrlPlaceholder, gatewayUrlHint, syncReasoningDefaultOptions, probeGateway, isCurrentModelConfigRequest, currentGatewayProbeResult, currentGatewayCatalogModels, modelConfigGatewayProfile, modelConfigEndpointChanged, modelConfigAgentModelsSnapshot, initializeAgentModelPickerSnapshot, syncAgentModelPickersForEndpoint, uniqueAgentModelCandidates, appendAgentModelOptions, renderAgentModelPickers, updateAgentModelPickerManualStatus, handleAgentModelSelection, renderGatewayProbeResult, applyProbedModel, applyGatewayDiscoveredModel, applySuggestedGatewayUrl, gatewayCredentialAction, normalizeGatewayProbeModels, normalizeReasoningDiscovery, reasoningCapabilityCandidate, applyReasoningCapabilityCandidate, ensureReasoningEffortOptions, applyPendingReasoningCapabilities, reasoningCapabilityIsActionable, renderReasoningCapabilityStatus, reasoningCapabilityStatusText, reasoningDiscoveryStatusText, probeModelCapabilities, setFormControlsSaving, setModelConfigFormSaving, renderModelConfigFailure, clearModelConfigFailure, manualAgentModelIds, saveModelConfig, saveDefaultModelSelection, switchModel, handleReasoningEffortChange, switchReasoningEffort, deleteGatewayProfile, deleteModel, updateConfigRevisions, normalizeScopedDefaultSelection, configScope, configMutationMetadata, isConfigRevisionConflict, configRevisionConflictMessage, refreshConfigRevisionsAfterConflict, normalizeGatewayConfig, normalizeDashboardSettings, mergeGatewayConfig, normalizeGatewayProfiles, normalizeConfigSource, normalizeModels, normalizeModelSource, normalizeReasoningEfforts, normalizedReasoningEffort, isDisabledReasoningEffort, configuredReasoningEffort, reasoningEffortFallbackLabel, localizedReasoningEffortLabel, reasoningEffortCatalog, reasoningEffortLabel, resolveAtomicModelSelection, currentModelSelection, currentSessionNeedsModelSelection, currentGatewayProfile, gatewayProfileById, settingsInspectedGatewayProfile, modelSourceLabel, markCurrentModel, currentModelInfo, modelDisplayName, normalizeAgentModelTiers, normalizeVisionAgent, firstVisionModelId, hasAgentModelTiers, agentModelTiersSummary, gatewaySummary, modelSaveTargetLabel, gatewaySourceNote, environmentGatewayDefaultNote, sourceBadge, sourceLabel, formatContextUsage, firstFiniteNumber, formatTokenCount, trimNumber, nonNegativeInteger, collapseCompletedActivities, clearAssistantDrafts, collapseAssistantDrafts, isMeaningfulCompletedActivity, isDuplicateDraftText, normalizeComparableText, showApproval, resolveApproval, hideApproval, showQuestion, revealInteractionPanel, renderQuestionPanel, reviewQuestionConversation, returnToQuestion, activateQuestionReviewBackground, deactivateQuestionReviewBackground, questionChoiceButton, toggleQuestionChoice, submitQuestion, cancelQuestion, finishQuestionSubmission, hideQuestion, showTrustPanel, renderTrustPanel, confirmTrust, renderQueuePanel, renderQueueItem, setPendingGuide, clearPendingGuide, syncPendingGuideFromQueue, renderGuideFeedback, guideCopy, guideSource, guideTurnFromQueue, guideButtonText, guideButtonDisabled, guideButtonVisible, syncGuideButton, shouldKeepGuideFeedback, isInterruptError, updateSendButton, showContextConfirm, hideContextConfirm, runContextAction, contextActionRequestOptions, contextSummaryLine, compactResultLine, rememberQuestionDraft, questionResolutionText, showShutdownPanel, hideShutdownPanel, shutdownDashboard, bindRichContent, linkifyFileTextNodes, replaceFileReferences, isLikelyLocalFileReference, resolveDisplayFilePath, normalizeFileReferencePath, parentDirectory, filePreviewUrl, rawFileUrl, apiFileUrl, imagePreviewUrl, isSafeInlineBitmapUrl, normalizeRelativePath, isWorkspaceRelativeToBase, copyCodeBlock, previewText, formatNumber, formatBytes, escapeHtml, escapeAttribute, formatTime, formatRelativeTime } from "./app-barrel.ts";
export function lockClosedDashboard() {
  for (const surface of [
    els.sidebar,
    els.preview,
    els.responsiveNavigation,
    document.querySelector(".workspace-header"),
    els.workflowStrip,
    document.querySelector(".composer-shell")
  ]) {
    if (surface) surface.inert = true;
  }
}

export function normalizeLifecycleActivity(activity: unknown = {}): DashboardLifecycleActivity {
  const record = isPlainObject(activity) ? activity : {};
  const count = (value: unknown) => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
  };
  const sessions = count(record.sessions);
  const activeTurns = count(record.activeTurns);
  const quarantinedTurns = count(record.quarantinedTurns);
  const queuedTurns = count(record.queuedTurns);
  const backgroundTasks = count(record.backgroundTasks);
  const pendingInteractions = count(record.pendingInteractions);
  return {
    sessions,
    activeTurns,
    quarantinedTurns,
    queuedTurns,
    backgroundTasks,
    pendingInteractions,
    uncertain: record.uncertain === true,
    total: count(record.total) || activeTurns + quarantinedTurns + queuedTurns + backgroundTasks + pendingInteractions
  };
}

export function shutdownRequestBody(activity: DashboardLifecycleActivity | Record<string, unknown>) {
  const normalized = normalizeLifecycleActivity(activity);
  if (normalized.uncertain) {
    return { cancel: true, force: true, timeoutMs: DASHBOARD_SHUTDOWN_TIMEOUT_MS };
  }
  return normalized.total > 0 ? { cancel: true } : {};
}

export function shutdownResultIsClosed(result: DashboardApiResult | Record<string, unknown> | null | undefined) {
  return result?.ok === true;
}

export function lifecycleActivitySummary(activity: DashboardLifecycleActivity) {
  return `活动会话 ${activity.sessions} 个，主任务 ${activity.activeTurns} 个，隔离任务 ${activity.quarantinedTurns} 个，队列 ${activity.queuedTurns} 项，后台任务 ${activity.backgroundTasks} 个，待确认 ${activity.pendingInteractions} 项`;
}

export function renderShutdownActivity() {
  const activity = state.shutdownActivity;
  if (!activity) return;
  const summary = lifecycleActivitySummary(activity);
  els.shutdownCopy.textContent = activity.total > 0
    ? `${summary}。关闭会取消这些未完成工作并等待收束；也可以返回继续处理。`
    : `${summary}。当前没有未完成工作，确认后会停止本机 WebUI。`;
  els.shutdownConfirm.disabled = false;
  els.shutdownConfirm.textContent = activity.total > 0 ? "取消任务并关闭" : "确认关闭";
}

export function renderFiles() {
  els.fileList.innerHTML = "";
  if (state.files.length === 0) {
    const empty = document.createElement("div");
    empty.className = "thread-meta";
    empty.textContent = "暂无产物";
    els.fileList.append(empty);
    return;
  }
  for (const file of state.files) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "file-item";
    item.innerHTML = `
      <div class="file-name">${escapeHtml(file.name)}</div>
      <div class="file-meta">${escapeHtml(file.kind)} · ${escapeHtml(file.source ?? "file")}</div>
    `;
    item.addEventListener("click", () => openFile(file.relativePath));
    els.fileList.append(item);
  }
}

export function currentImageFiles() {
  return state.files
    .filter((file) => file.kind === "image")
    .map((file) => ({
      name: file.name,
      rawUrl: rawFileUrl(file.relativePath),
      relativePath: file.relativePath
    }));
}

export async function openFile(filePath: string | null | undefined) {
  if (!filePath) return;
  const sessionId = state.currentSessionId;
  const request = beginScopedRequest("file", `${sessionId ?? "new"}:${filePath}`);
  els.previewBody.className = "preview-body";
  els.previewBody.innerHTML = `<div class="preview-placeholder">正在加载文件预览</div>`;
  const result = await getJson(filePreviewUrl(filePath), { signal: request.signal })
    .catch((error: unknown): DashboardApiResult => ({ ok: false, error: error instanceof Error ? error.message : String(error), aborted: isAbortError(error) }));
  if (!isCurrentScopedRequest(request) || state.currentSessionId !== sessionId) return;
  finishScopedRequest(request);
  if (result.aborted) return;
  els.previewBody.className = "preview-body";
  if (!result.ok) {
    els.previewBody.innerHTML = `<div class="office-card">${escapeHtml(result.error ?? "无法预览文件")}</div>`;
    return;
  }
  const file = result.file;
  if (!file) {
    els.previewBody.innerHTML = `<div class="office-card">无法预览文件</div>`;
    return;
  }
  if (file.kind === "image") {
    els.previewBody.innerHTML = `
      <button class="preview-image-button" type="button" aria-label="打开 ${escapeHtml(file.name)} 大图">
        <img class="preview-image" alt="${escapeHtml(file.name)}" src="${file.rawUrl}" />
      </button>
    `;
    els.previewBody.querySelector(".preview-image-button")?.addEventListener("click", () => {
      const images = currentImageFiles();
      const index = Math.max(0, images.findIndex((item) => item.relativePath === file.relativePath));
      showImageLightbox(file, images.length ? images : [file], index);
    });
  } else if (file.kind === "pdf") {
    els.previewBody.classList.add("document-preview-body");
    els.previewBody.innerHTML = `
      <div class="pdf-preview">
        <header class="office-preview-header">
          <div>
            <strong>${escapeHtml(file.name)}</strong>
            <span>PDF 预览</span>
          </div>
          ${localOpenButtonHtml(file.relativePath)}
        </header>
        <iframe class="preview-frame" title="${escapeHtml(file.name)}" src="${file.rawUrl}"></iframe>
      </div>
    `;
  } else if (file.kind === "office-preview") {
    els.previewBody.classList.add("document-preview-body");
    els.previewBody.replaceChildren(renderOfficePreview(file));
  } else if (file.kind === "table-preview") {
    els.previewBody.classList.add("document-preview-body");
    els.previewBody.replaceChildren(renderTablePreview(file));
  } else if (file.kind === "office") {
    els.previewBody.innerHTML = `<div class="office-card"><strong>${escapeHtml(file.name)}</strong><p>${escapeHtml(file.message ?? "此文件第一版不直接预览。")}</p><p>${escapeHtml(file.relativePath)}</p>${localOpenButtonHtml(file.relativePath)}</div>`;
  } else if (file.kind === "binary" || file.kind === "download") {
    const download = file.downloadOnly ? ` download="${escapeHtml(file.name)}"` : "";
    const target = file.downloadOnly ? "" : ` target="_blank"`;
    els.previewBody.innerHTML = `<div class="office-card"><strong>${escapeHtml(file.name)}</strong><p>${escapeHtml(file.message ?? "此文件第一版不直接预览。")}</p><p>${escapeHtml(file.relativePath)}</p><a class="open-file" href="${file.rawUrl}"${download}${target} rel="noopener noreferrer">${file.downloadOnly ? "下载文件" : "打开文件"}</a></div>`;
  } else if (file.kind === "markdown") {
    els.previewBody.classList.add("document-preview-body");
    const article = document.createElement("article");
    article.className = "markdown-document markdown-body";
    article.tabIndex = 0;
    article.setAttribute("aria-label", `${file.name} Markdown 内容`);
    renderMessageText(article, file.content ?? "", { markdown: true, basePath: parentDirectory(file.relativePath) });
    els.previewBody.replaceChildren(article);
  } else if (file.kind === "data") {
    els.previewBody.classList.add("document-preview-body");
    const article = document.createElement("article");
    article.className = "markdown-document markdown-body";
    article.tabIndex = 0;
    article.setAttribute("aria-label", `${file.name} 数据预览`);
    renderMessageText(article, fencedDataForFile(file), { markdown: true });
    els.previewBody.replaceChildren(article);
  } else {
    els.previewBody.classList.add("document-preview-body");
    els.previewBody.innerHTML = `<pre class="preview-code" tabindex="0" aria-label="${escapeHtml(file.name)} 文档内容">${escapeHtml(file.content ?? "")}</pre>`;
  }
}

export function localOpenButtonHtml(relativePath: string | null | undefined) {
  return `<button type="button" class="open-file" data-open-local="${escapeAttribute(relativePath ?? "")}" title="用系统应用打开">打开</button>`;
}

export function handleLocalFileOpenClick(event: Event) {
  const button = eventTargetOf(event).closest("[data-open-local]");
  if (!(button instanceof HTMLElement)) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  void openLocalFile(button.getAttribute("data-open-local") ?? "", button);
}

export async function openLocalFile(filePath: string, button: HTMLElement | null = null) {
  const relativePath = String(filePath ?? "").trim();
  if (!relativePath) {
    showError("没有可打开的本地文件路径");
    return;
  }
  const label = button?.textContent ?? "打开";
  if (button) {
    button.setAttribute("disabled", "true");
    button.textContent = "正在打开…";
  }
  try {
    const result = await postJson("/api/files/open", {
      path: relativePath,
      sessionId: state.currentSessionId ?? ""
    }).catch((error: unknown): DashboardApiResult => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }));
    if (!result.ok) {
      showError(result.error ?? "无法打开本地文件");
    }
  } finally {
    if (button) {
      button.removeAttribute("disabled");
      button.textContent = label;
    }
  }
}

export function renderOfficePreview(file: DashboardFile) {
  if (file.table) {
    return renderTablePreview(file);
  }
  const article = document.createElement("article");
  article.className = `office-preview office-preview-${escapeHtml(file.officeKind ?? "document")}`;
  article.tabIndex = 0;
  article.setAttribute("aria-label", `${file.name} 轻量预览`);
  const meta = officePreviewMeta(file);
  article.innerHTML = `
    <header class="office-preview-header">
      <div>
        <strong>${escapeHtml(file.name)}</strong>
        <span>${escapeHtml(meta)}</span>
      </div>
      ${localOpenButtonHtml(file.relativePath)}
    </header>
    ${officePreviewBodyHtml(file)}
    ${file.truncated ? `<div class="office-preview-note">仅显示前 ${formatNumber(file.content?.length ?? 0)} 字符，完整内容请打开文件。</div>` : ""}
  `;
  return article;
}

export function officePreviewMeta(file: DashboardFile) {
  const kind = String(file.officeKind ?? "").toLowerCase();
  if (kind === "xlsx") return "Excel 轻量预览";
  if (kind === "pptx") return "PPT 文本预览";
  return "DOCX 文本预览";
}

export function officePreviewBodyHtml(file: DashboardFile) {
  const kind = String(file.officeKind ?? "").toLowerCase();
  if (kind === "xlsx") {
    return `<div class="office-sheet-list">${renderSheetPreviewHtml(file.content ?? "")}</div>`;
  }
  return `<pre class="office-text-preview">${escapeHtml(file.content ?? "")}</pre>`;
}

export function renderTablePreview(file: DashboardFile) {
  const article = document.createElement("article");
  article.className = "office-preview table-preview";
  article.tabIndex = 0;
  article.setAttribute("aria-label", `${file.name} 表格预览`);
  const table = normalizeTablePreview(file.table);
  const meta = tablePreviewMeta(file, table);
  article.innerHTML = `
    <header class="office-preview-header">
      <div>
        <strong>${escapeHtml(file.name)}</strong>
        <span>${escapeHtml(meta)}</span>
      </div>
      <div class="office-preview-actions">
        <button class="open-file table-expand-button" type="button">放大</button>
        ${localOpenButtonHtml(file.relativePath)}
      </div>
    </header>
    <div class="table-preview-button" role="button" tabindex="0" aria-label="放大查看 ${escapeHtml(file.name)}">
      ${renderCompactTableHtml(table)}
    </div>
    ${tableTruncationNote(table)}
  `;
  const previewButton = article.querySelector(".table-preview-button");
  previewButton?.addEventListener("click", () => showTableLightbox(file));
  previewButton?.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      showTableLightbox(file);
    }
  });
  article.querySelector(".table-expand-button")?.addEventListener("click", () => showTableLightbox(file));
  return article;
}

export function normalizeTablePreview(table: unknown): DashboardTablePreview {
  const record = isPlainObject(table) ? table : {};
  const sheets = Array.isArray(record.sheets) ? record.sheets : [];
  return {
    kind: String(record.kind ?? "table"),
    totalSheets: Number(record.totalSheets ?? sheets.length),
    sheets: sheets.map((sheetValue: unknown, index: number) => {
      const sheet = isPlainObject(sheetValue) ? sheetValue : {};
      return {
        name: String(sheet.name || `Sheet ${index + 1}`),
        source: String(sheet.source ?? ""),
        rows: Array.isArray(sheet.rows) ? sheet.rows.map((row: unknown) => Array.isArray(row) ? row.map((cell: unknown) => String(cell ?? "")) : []) : [],
        truncatedRows: Boolean(sheet.truncatedRows),
        truncatedColumns: Boolean(sheet.truncatedColumns)
      };
    }).filter((sheet) => sheet.rows.length > 0)
  };
}

export function tablePreviewMeta(file: DashboardFile, table: DashboardTablePreview) {
  const kind = String(file.officeKind ?? file.tableKind ?? table.kind ?? "table").toUpperCase();
  const sheetCount = table.totalSheets > 1 ? `${table.totalSheets} 个 Sheet` : "1 个表";
  const first = table.sheets[0];
  const size = first ? `${first.rows.length} 行 · ${maxVisibleColumns(first.rows)} 列` : "空表";
  return `${kind} 表格预览 · ${sheetCount} · ${size}`;
}

export function renderCompactTableHtml(table: DashboardTablePreview) {
  const first = table.sheets[0];
  if (!first) {
    return `<div class="preview-placeholder">没有可展示的表格内容</div>`;
  }
  const rows = first.rows.slice(0, 16);
  const columns = Math.min(maxVisibleColumns(rows), 8);
  return `
    <div class="compact-table-wrap">
      ${renderTableHtml(rows, columns, { compact: true })}
    </div>
  `;
}

export function renderExpandedTableHtml(table: DashboardTablePreview, activeIndex: number = 0) {
  const sheets = table.sheets ?? [];
  const sheetIndex = Math.max(0, Math.min(activeIndex, Math.max(0, sheets.length - 1)));
  const sheet = sheets[sheetIndex];
  if (!sheet) {
    return `<div class="preview-placeholder">没有可展示的表格内容</div>`;
  }
  const columns = maxVisibleColumns(sheet.rows);
  return `
    <div class="table-viewer ${sheets.length > 1 ? "has-sheets" : "single-sheet"}">
      ${sheets.length > 1 ? `<nav class="table-sheet-rail" aria-label="Sheet 切换">${sheets.map((item, index) => `<button class="${index === sheetIndex ? "active" : ""}" type="button" aria-current="${index === sheetIndex ? "true" : "false"}" data-sheet-index="${index}" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</button>`).join("")}</nav>` : ""}
      <section class="table-viewer-main" aria-label="${escapeHtml(sheet.name)}">
        <div class="expanded-table-scroll">
          ${renderTableHtml(sheet.rows, columns, { compact: false })}
        </div>
        ${sheet.truncatedRows || sheet.truncatedColumns ? `<div class="office-preview-note">表格较大，当前显示已限制行列数量。</div>` : ""}
      </section>
    </div>
  `;
}

export function renderTableHtml(rows: string[][], columns: number, options: { compact?: boolean } = {}) {
  const visibleRows = Array.isArray(rows) ? rows : [];
  const count = Math.max(1, columns);
  const bodyRows = visibleRows.map((row, rowIndex) => `
    <tr>
      <th scope="row">${rowIndex + 1}</th>
      ${Array.from({ length: count }, (_, columnIndex) => `<td>${escapeHtml(row[columnIndex] ?? "")}</td>`).join("")}
    </tr>
  `).join("");
  return `
    <table class="${options.compact ? "compact-table" : "expanded-table"}">
      <thead>
        <tr>
          <th scope="col"></th>
          ${Array.from({ length: count }, (_: unknown, index: number) => `<th scope="col">${escapeHtml(columnLabel(index))}</th>`).join("")}
        </tr>
      </thead>
      <tbody>${bodyRows}</tbody>
    </table>
  `;
}

export function tableTruncationNote(table: DashboardTablePreview) {
  const truncated = table.sheets.some((sheet) => sheet.truncatedRows || sheet.truncatedColumns);
  return truncated ? `<div class="office-preview-note">表格较大，右侧栏和放大预览会限制最多显示的行列。</div>` : "";
}

export function maxVisibleColumns(rows: unknown[][]) {
  return rows.reduce((max, row) => Math.max(max, row.length), 0);
}

export function columnLabel(index: number) {
  let value = Number(index) + 1;
  let out = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    out = String.fromCharCode(65 + remainder) + out;
    value = Math.floor((value - 1) / 26);
  }
  return out;
}

export function renderSheetPreviewHtml(content: unknown) {
  const lines = String(content ?? "").split(/\r?\n/);
  const sections: Array<{ title: string; rows: string[] }> = [];
  let current: { title: string; rows: string[] } | null = null;
  for (const line of lines) {
    const sheet = line.match(/^Sheet\s+\d+\s+\(([^)]+)\)$/i);
    if (sheet) {
      current = { title: line, rows: [] };
      sections.push(current);
      continue;
    }
    if (!current) {
      current = { title: "Sheet", rows: [] };
      sections.push(current);
    }
    if (line.trim()) {
      current.rows.push(line);
    }
  }
  return sections
    .filter((section) => section.rows.length > 0)
    .slice(0, 5)
    .map((section) => `
      <section class="office-sheet">
        <h3>${escapeHtml(section.title.replace(/\s+\([^)]+\)$/, ""))}</h3>
        <dl>
          ${section.rows.slice(0, 80).map(renderSheetCellHtml).join("")}
        </dl>
      </section>
    `).join("") || `<pre class="office-text-preview">${escapeHtml(content)}</pre>`;
}

export function renderSheetCellHtml(line: unknown) {
  const match = String(line).match(/^([^:]{1,12}):\s*([\s\S]*)$/);
  if (!match) {
    return `<div class="office-cell"><dt></dt><dd>${escapeHtml(line)}</dd></div>`;
  }
  return `<div class="office-cell"><dt>${escapeHtml(match[1])}</dt><dd>${escapeHtml(match[2])}</dd></div>`;
}

export function resetPreview(message: string = "任务产物会显示在这里") {
  els.previewBody.className = "preview-body";
  els.previewBody.innerHTML = `<div class="preview-placeholder">${escapeHtml(message)}</div>`;
}

export function fencedDataForFile(file: DashboardFile) {
  const language = dataLanguageForExtension(file.extension);
  return `\`\`\`${language}\n${file.content ?? ""}\n\`\`\``;
}

export function dataLanguageForExtension(extension: unknown) {
  const ext = String(extension ?? "").toLowerCase();
  if (ext === ".yaml" || ext === ".yml") return "yaml";
  if (ext === ".csv") return "csv";
  if (ext === ".tsv") return "tsv";
  return "json";
}

export function showImageLightbox(file: DashboardFile | DashboardLightboxItem, items: Array<DashboardFile | DashboardLightboxItem> | null | undefined = null, index: number = 0) {
  const returnFocus = document.activeElement;
  const gallery = Array.isArray(items) && items.length > 0 ? items : [file];
  state.lightboxItems = gallery;
  state.lightboxIndex = Math.max(0, Math.min(index, gallery.length - 1));
  renderLightboxImage();
  els.imageLightbox.classList.remove("hidden");
  document.body.classList.add("lightbox-opened");
  activateModal(els.imageLightbox, { initialFocus: "#lightbox-close", returnFocus });
}

export function showTableLightbox(file: DashboardFile) {
  const returnFocus = document.activeElement;
  state.lightboxItems = [{
    type: "table",
    name: file.name,
    rawUrl: file.rawUrl ?? rawFileUrl(file.relativePath),
    table: normalizeTablePreview(file.table)
  }];
  state.lightboxIndex = 0;
  state.tableLightboxSheetIndex = 0;
  renderLightboxImage();
  els.imageLightbox.classList.remove("hidden");
  document.body.classList.add("lightbox-opened");
  activateModal(els.imageLightbox, { initialFocus: "#lightbox-close", returnFocus });
}

export function renderLightboxImage() {
  const file = state.lightboxItems[state.lightboxIndex] ?? { type: "", name: "", rawUrl: "", table: undefined };
  const isTable = file.type === "table";
  els.imageLightbox.dataset.mode = isTable ? "table" : "image";
  els.lightboxTitle.textContent = file.name || (isTable ? "表格预览" : "图片预览");
  els.lightboxOpen.href = file.rawUrl ?? "#";
  els.lightboxImage.classList.toggle("hidden", isTable);
  els.lightboxTable.classList.toggle("hidden", !isTable);
  if (isTable) {
    els.lightboxImage.removeAttribute("src");
    if (els.lightboxImage instanceof HTMLImageElement) els.lightboxImage.alt = "";
    els.lightboxTable.innerHTML = renderExpandedTableHtml(normalizeTablePreview(file.table), state.tableLightboxSheetIndex);
    bindTableLightboxControls();
  } else {
    els.lightboxTable.innerHTML = "";
    if (els.lightboxImage instanceof HTMLImageElement) {
      els.lightboxImage.alt = file.name || "图片预览";
      els.lightboxImage.src = file.rawUrl ?? "";
    }
  }
  const total = state.lightboxItems.length;
  els.lightboxCounter.textContent = total > 1 ? `${state.lightboxIndex + 1} / ${total}` : "";
  els.lightboxPrevious.classList.toggle("hidden", total <= 1);
  els.lightboxNext.classList.toggle("hidden", total <= 1);
}

export function bindTableLightboxControls() {
  els.lightboxTable.querySelectorAll("[data-sheet-index]").forEach((button) => {
    button.addEventListener("click", () => {
      state.tableLightboxSheetIndex = Number(button.dataset.sheetIndex) || 0;
      renderLightboxImage();
    });
  });
}

export function moveLightbox(delta: number) {
  if (els.imageLightbox.classList.contains("hidden") || state.lightboxItems.length <= 1) {
    return;
  }
  const total = state.lightboxItems.length;
  state.lightboxIndex = (state.lightboxIndex + delta + total) % total;
  renderLightboxImage();
}

export function hideLightbox() {
  if (els.imageLightbox.classList.contains("hidden")) {
    return;
  }
  deactivateModal(els.imageLightbox);
  els.imageLightbox.classList.add("hidden");
  document.body.classList.remove("lightbox-opened");
  els.lightboxImage.removeAttribute("src");
  els.lightboxImage.classList.remove("hidden");
  els.lightboxTable.classList.add("hidden");
  els.lightboxTable.innerHTML = "";
  delete els.imageLightbox.dataset.mode;
  state.lightboxItems = [];
  state.lightboxIndex = 0;
  state.tableLightboxSheetIndex = 0;
}

export function setPermissionMode(mode: string | undefined) {
  if (!mode) return;
  if (state.goal?.enabled && mode !== "fullAccess") {
    mode = "fullAccess";
  }
  state.permissionMode = mode;
  els.permissionMode.querySelectorAll("button").forEach((button) => {
    const active = button.dataset.mode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-checked", String(active));
    button.tabIndex = active ? 0 : -1;
  });
  document.body.classList.toggle("full-access-active", mode === "fullAccess");
  els.modeDescription.textContent = state.goal?.enabled ? MODE_DESCRIPTIONS.goal : (MODE_DESCRIPTIONS[mode] ?? MODE_DESCRIPTIONS.plan);
  updateContextActions();
  renderGoalControls();
}

export function clearTranscript() {
  cancelTranscriptAnimationFrames();
  resetTranscriptWindow();
  els.transcript.innerHTML = "";
  state.transcriptHistoryNode = null;
  els.transcript.append(els.emptyState);
  els.emptyState.classList.remove("hidden");
  state.workflow = null;
  state.workflowNode = null;
  state.workflowExpanded = false;
  renderWorkflowStrip();
  state.assistantDrafts.clear();
  state.transcriptPaging = {
    cursor: null,
    hasMore: false,
    loading: false,
    error: "",
    total: 0
  };
  state.activeTurnId = "";
  resetEventReplayState();
  state.lastAssistantFinalSignature = "";
  state.transcriptFollowing = true;
  state.newReplyAvailable = false;
  updateTranscriptJump();
}

export function cancelTranscriptAnimationFrames() {
  clearAssistantDraftTimers();
  cancelScheduledAnimationFrame(state, "transcriptScrollFrame");
  state.transcriptScrollForce = false;
}

export function clearAssistantDraftTimers() {
  for (const draft of state.assistantDrafts.values()) {
    cancelScheduledAnimationFrame(draft, "renderFrame");
  }
}

export function hideEmptyState() {
  els.emptyState.classList.add("hidden");
}

export function showError(message: string | null | undefined) {
  hideEmptyState();
  appendActivity({
    title: "发生错误",
    detail: message ?? "",
    severity: "danger",
    collapsed: false
  });
}

export function showNotice(message: string, detail: unknown = "本地配置已更新") {
  hideEmptyState();
  appendActivity({
    title: message,
    detail: detail == null ? "本地配置已更新" : String(detail),
    severity: "info",
    collapsed: false
  });
}

export function renderBootstrapLoading() {
  els.projectPath.textContent = "正在连接";
  els.runStatus.textContent = "连接中";
  els.sendButton.disabled = true;
  setConnectionState("connecting");
}

export function renderBootstrapFailure(error: unknown) {
  const failure = bootstrapFailurePresentation(error, navigator.onLine !== false);
  setConnectionState(failure.connectionState);
  els.projectPath.textContent = failure.projectLabel;
  els.runStatus.textContent = "初始化失败";
  els.sendButton.disabled = true;
  cancelTranscriptAnimationFrames();
  resetTranscriptWindow();
  els.transcript.innerHTML = `
      <div class="empty-state bootstrap-error">
        <div class="empty-kicker">Ant Code Dashboard</div>
      <div class="empty-title">${escapeHtml(failure.title)}</div>
      <div class="empty-copy">${escapeHtml(failure.message)}</div>
      <button type="button" class="bootstrap-retry">重新连接</button>
    </div>
  `;
  els.transcript.querySelector(".bootstrap-retry")?.addEventListener("click", () => {
    if (typeof window.location?.reload === "function") {
      window.location.reload();
    } else {
      bootstrapDashboard();
    }
  });
}

/** @param {any} payload @param {string} fallback */
export function dashboardPayloadError(payload: Record<string, unknown>, fallback: string) {
  const error = new Error(String(payload?.error ?? fallback));
  for (const key of ["code", "status", "requestId", "configPath"]) {
    if (payload?.[key] !== undefined) Object.defineProperty(error, key, { value: payload[key] });
  }
  return error;
}

/** @param {unknown} error @param {boolean} online */
export function bootstrapFailurePresentation(error: unknown, online: boolean = true) {
  const issue = isPlainObject(error) ? error : {};
  const message = error instanceof Error ? error.message : String(error ?? "Dashboard 初始化失败");
  const code = String(issue.code ?? "").trim();
  const status = Number(issue.status);
  const serverResponded = Boolean(code) || (Number.isInteger(status) && status >= 400);
  const requestId = /^[A-Za-z0-9_-]{8,128}$/.test(String(issue.requestId ?? ""))
    ? String(issue.requestId)
    : "";
  const diagnosticMessage = requestId ? `${message}（请求编号：${requestId}）` : message;

  if (code.startsWith("CONFIG_V2_")) {
    return {
      connectionState: "error",
      projectLabel: "配置错误",
      title: "模型配置加载失败",
      message: diagnosticMessage
    };
  }
  if (serverResponded) {
    return {
      connectionState: "error",
      projectLabel: "服务异常",
      title: "本地服务响应异常",
      message: diagnosticMessage
    };
  }
  return {
    connectionState: online ? "unavailable" : "offline",
    projectLabel: "连接失败",
    title: "无法连接本地服务",
    message: diagnosticMessage
  };
}

export function clearBootstrapStatus() {
  if (state.connectionState === "connecting" && !state.currentSessionId) {
    setConnectionState("idle");
  }
}

export function scrollTranscript(options: { force?: boolean; following?: boolean; onlyIfNearBottom?: boolean; wasAtBottom?: boolean } = {}) {
  if (!shouldFollowTranscript({
    force: options.force,
    following: state.transcriptFollowing,
    onlyIfNearBottom: options.onlyIfNearBottom,
    wasAtBottom: options.wasAtBottom
  })) {
    state.transcriptFollowing = false;
    state.newReplyAvailable = true;
    updateTranscriptJump();
    return;
  }
  state.transcriptFollowing = true;
  state.newReplyAvailable = false;
  state.transcriptScrollForce = state.transcriptScrollForce || options.force === true;
  updateTranscriptJump();
  scheduleAnimationFrameOnce(state, "transcriptScrollFrame", () => {
    const force = state.transcriptScrollForce;
    state.transcriptScrollForce = false;
    if (!force && !state.transcriptFollowing) {
      updateTranscriptJump();
      return;
    }
    els.transcript.scrollTop = els.transcript.scrollHeight;
    updateTranscriptJump();
  });
}

export function isTranscriptNearBottom(threshold: unknown = 96) {
  const limit = Number(threshold);
  return els.transcript.scrollHeight - els.transcript.scrollTop - els.transcript.clientHeight <= (Number.isFinite(limit) ? limit : 96);
}

export function syncTranscriptFollowState() {
  const nearBottom = isTranscriptNearBottom();
  state.transcriptFollowing = nearBottom;
  if (nearBottom) state.newReplyAvailable = false;
  updateTranscriptJump();
}

export function followTranscript() {
  state.transcriptFollowing = true;
  state.newReplyAvailable = false;
  scrollTranscript({ force: true });
}

export function updateTranscriptJump() {
  if (!els.transcriptJump) return;
  const visible = !state.transcriptFollowing;
  els.transcriptJump.classList.toggle("hidden", !visible);
  els.transcriptJump.textContent = state.newReplyAvailable ? "有新回复" : "回到底部";
  els.transcriptJump.setAttribute("aria-label", state.newReplyAvailable ? "有新回复，回到底部" : "回到底部");
}

export function beginScopedRequest(scope: unknown, key: string = ""): DashboardScopedRequest {
  cancelScopedRequest(scope);
  const controller = new AbortController();
  const request = { scope, key, controller, signal: controller.signal };
  state.requestScopes.set(scope, request);
  return request;
}

export function isCurrentScopedRequest(request: DashboardScopedRequest) {
  return Boolean(request) && state.requestScopes.get(request.scope) === request && !request.signal.aborted;
}

export function finishScopedRequest(request: DashboardScopedRequest) {
  if (state.requestScopes.get(request?.scope) === request) {
    state.requestScopes.delete(request.scope);
  }
}

export function cancelScopedRequest(scope: unknown) {
  const request = state.requestScopes.get(scope);
  if (!request) return;
  state.requestScopes.delete(scope);
  if (!request.signal.aborted) {
    request.controller.abort();
  }
}

export function isAbortError(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }
  const record = error as { name?: unknown; code?: unknown };
  return record.name === "AbortError" || record.code === "ABORT_ERR";
}

export async function getJson(url: string, options: DashboardFetchOptions = {}): Promise<DashboardApiResult> {
  return dashboardFetch(url, {
    credentials: "same-origin",
    signal: options.signal
  }, options);
}

export async function postJson(url: string, body: Record<string, unknown>, options: DashboardFetchOptions = {}): Promise<DashboardApiResult> {
  return dashboardFetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: dashboardJsonHeaders(),
    body: JSON.stringify(body),
    signal: options.signal
  }, options);
}

export async function deleteJson(url: string, body: Record<string, unknown> = {}, options: DashboardFetchOptions = {}): Promise<DashboardApiResult> {
  return dashboardFetch(url, {
    method: "DELETE",
    credentials: "same-origin",
    headers: dashboardJsonHeaders(),
    body: JSON.stringify(body),
    signal: options.signal
  }, options);
}

/**
 * Fetch and decode Dashboard APIs within one bounded lifetime by default.
 * Server-bounded long operations can pass timeoutMs: null while retaining a
 * caller-provided cancellation signal.
 * @param {string} url
 * @param {RequestInit} [init]
 * @param {{ timeoutMs?: number | null; signal?: AbortSignal }} [options]
 */
export async function dashboardFetch(url: string, init: RequestInit = {}, options: DashboardFetchOptions = {}): Promise<DashboardApiResult> {
  const timeoutMs = options.timeoutMs === null
    ? null
    : Number.isFinite(Number(options.timeoutMs))
      ? Math.max(1, Number(options.timeoutMs))
      : DASHBOARD_REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  let timer = null;
  const callerSignal = options.signal instanceof AbortSignal ? options.signal : undefined;
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) {
    abortFromCaller();
  } else {
    callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  }
  if (typeof timeoutMs === "number") {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  }
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return await responseJson(response);
  } catch (error) {
    if (timedOut) {
      const timeoutError = new Error(`请求超时（${Math.ceil((typeof timeoutMs === "number" ? timeoutMs : DASHBOARD_REQUEST_TIMEOUT_MS) / 1000)} 秒）`);
      timeoutError.name = "TimeoutError";
      Object.defineProperty(timeoutError, "code", { value: "DASHBOARD_REQUEST_TIMEOUT" });
      throw timeoutError;
    }
    throw error;
  } finally {
    if (timer !== null) clearTimeout(timer);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}

export async function responseJson(response: Response): Promise<DashboardApiResult> {
  const text = await response.text();
  let payload: DashboardApiResult;
  try {
    payload = text ? JSON.parse(text) as DashboardApiResult : {};
  } catch {
    payload = { ok: false, error: `服务返回了无效响应（HTTP ${response.status}）` };
  }
  if (!response.ok) {
    return { ...payload, ok: false, status: payload.status ?? response.status, error: payload.error ?? `HTTP ${response.status}` };
  }
  return payload;
}

export function dashboardJsonHeaders() {
  return {
    "content-type": "application/json",
    "x-antcode-csrf-token": dashboardCsrfToken()
  };
}

export function dashboardCsrfToken() {
  const port = window.location.port || (window.location.protocol === "https:" ? "443" : "80");
  const cookieName = `antcode_dashboard_csrf_${port}`;
  for (const cookie of document.cookie.split(";")) {
    const separator = cookie.indexOf("=");
    if (separator < 0 || cookie.slice(0, separator).trim() !== cookieName) {
      continue;
    }
    try {
      return decodeURIComponent(cookie.slice(separator + 1).trim());
    } catch {
      return "";
    }
  }
  return "";
}

export function messageText(content: unknown) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((item) => {
    if (typeof item === "string") return item;
    if (item && typeof item === "object" && "text" in item) return item.text ?? "";
    return "";
  }).join("");
}

export function messageDisplayText(content: unknown) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const lines = [];
  for (const item of content) {
    if (typeof item === "string") {
      lines.push(item);
    } else if (item && typeof item === "object" && "text" in item) {
      lines.push(item.text ?? "");
    } else if (item && typeof item === "object" && item.type === "image") {
      lines.push(imageAttachmentLine(item));
    }
  }
  return lines.filter(Boolean).join("\n");
}

export function userMessageDisplayText(text: string | null | undefined, attachments: unknown = []) {
  const lines = [String(text ?? "").trim()].filter(Boolean);
  const meta = normalizeAttachmentMetadata(attachments);
  const imageLines = meta.filter((item) => item.type === "image").map(imageAttachmentLine);
  const documentLines = meta.filter((item) => item.type === "document").map(documentAttachmentLine);
  return [...lines, ...documentLines, ...imageLines].join("\n");
}

export function normalizeAttachmentMetadata(attachments: unknown) {
  if (!Array.isArray(attachments)) {
    return [];
  }
  return attachments
    .filter((item) => item && typeof item === "object" && (item.type === "image" || item.type === "document"))
    .map((item) => ({
      type: item.type === "document" ? "document" : "image",
      name: String(item.name ?? (item.type === "document" ? "document" : "image")),
      mimeType: String(item.mimeType ?? item.mime_type ?? (item.type === "document" ? "document" : "image")),
      size: Number.isFinite(Number(item.size)) ? Number(item.size) : Number(item.bytes ?? item.sizeBytes ?? 0),
      path: String(item.path ?? "").trim()
    }));
}

export function transcriptMessageAttachments(message: unknown) {
  const record = isPlainObject(message) ? message : {};
  const stored = normalizeAttachmentMetadata(record.attachments);
  if (stored.length > 0) {
    return stored;
  }
  return attachmentsFromPlaceholderText(messageDisplayText(record.content));
}

export function userTranscriptDisplayText(content: unknown, attachments: unknown = []) {
  const chips = normalizeAttachmentMetadata(attachments);
  if (chips.length === 0) {
    return messageDisplayText(content);
  }
  if (typeof content === "string") {
    return stripAttachmentPlaceholders(content);
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content.map((item) => {
    if (typeof item === "string") {
      return stripAttachmentPlaceholders(item);
    }
    if (item && typeof item === "object" && "text" in item) {
      return stripAttachmentPlaceholders(String(item.text ?? ""));
    }
    return "";
  }).filter(Boolean).join("\n");
}

function attachmentsFromPlaceholderText(text: string) {
  const items: Array<{ type: string; name: string; mimeType: string; size: number; path: string }> = [];
  const pattern = /\[(文档附件|图片附件)：([^\]]+)\]/g;
  let match = pattern.exec(text);
  while (match) {
    const name = String(match[2] ?? "").split(" · ")[0].trim();
    if (name) {
      items.push({
        type: match[1] === "图片附件" ? "image" : "document",
        name,
        mimeType: "",
        size: 0,
        path: ""
      });
    }
    match = pattern.exec(text);
  }
  return items;
}

function stripAttachmentPlaceholders(text: string) {
  return String(text ?? "")
    .split(/\n/)
    .filter((line) => {
      const value = line.trim();
      return !value.startsWith("[文档附件：") && !value.startsWith("[图片附件：");
    })
    .join("\n")
    .trim();
}

export function documentAttachmentLine(item: Record<string, unknown>) {
  const parts = [
    item.name ? String(item.name) : "document",
    Number.isFinite(Number(item.size)) && Number(item.size) > 0 ? formatBytes(item.size) : ""
  ].filter(Boolean);
  return `[文档附件：${parts.join(" · ")}]`;
}

export function imageAttachmentLine(item: Record<string, unknown>) {
  const parts = [
    item.name ? String(item.name) : "image",
    item.mimeType ? String(item.mimeType) : "",
    Number.isFinite(Number(item.size)) && Number(item.size) > 0 ? formatBytes(item.size) : ""
  ].filter(Boolean);
  return `[图片附件：${parts.join(" · ")}]`;
}

export function renderMessageText(node: HTMLElement | Element | null | undefined, text: string, options: { markdown?: boolean; basePath?: string; lightweight?: boolean } = {}) {
  if (!node) return;
  node.classList.toggle("markdown-body", options.markdown === true);
  const html = options.markdown
    ? renderMarkdown(text ?? "", { basePath: options.basePath, lightweight: options.lightweight === true })
    : escapeHtml(text ?? "");
  node.innerHTML = html;
  if (!options.lightweight) {
    linkifyFileTextNodes(node, options.basePath);
  }
  bindRichContent(node, { lightweight: options.lightweight === true });
}

export function renderLinkedText(node: HTMLElement, text: string) {
  node.textContent = text ?? "";
  linkifyFileTextNodes(node);
  bindRichContent(node);
}

