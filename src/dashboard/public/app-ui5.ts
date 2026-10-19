import { inferModelSupportsImages } from "../../model-gateway/vision-capabilities.ts";
import { renderMarkdown } from "./markdown.ts";
import { preferPrefixedCatalog } from "../../model-gateway/reasoning-capabilities.ts";
import { providerRouteGroups, providerRouteLabel } from "./model-groups.ts";
import { hydrateRichContent } from "./rich-renderers.ts";
import { visibleTranscriptRole } from "./transcript.ts";
import { MANUAL_AGENT_MODEL_VALUE, state, els, MODE_DESCRIPTIONS, LOCAL_FILE_EXTENSIONS, FILE_REFERENCE_PATTERN, TRANSCRIPT_DOM_LIMIT, EVENT_STALE_AFTER_MS, EVENT_CONNECT_TIMEOUT_MS, EVENT_RECONNECT_MAX_ATTEMPTS, DASHBOARD_REQUEST_TIMEOUT_MS, DASHBOARD_API_VERSION, DASHBOARD_LIFECYCLE_TIMEOUT_MS, DASHBOARD_SHUTDOWN_TIMEOUT_MS, DASHBOARD_INTERRUPT_TIMEOUT_MS, MAX_IMAGE_ATTACHMENTS, MAX_IMAGE_ATTACHMENT_BYTES, CURRENT_SESSION_STORAGE_KEY, DASHBOARD_CLIENT_STORAGE_KEY, PREVIEW_WIDTH_STORAGE_KEY, PREVIEW_WIDTH_DEFAULT, PREVIEW_WIDTH_MIN, PREVIEW_WIDTH_MAX, PREVIEW_WORKSPACE_MIN , emptySessionStatus, emptyBackgroundSubagent } from "./app-core.ts";
import type { DashboardConfigSource, DashboardReasoningEffort, DashboardTurnChangeStats, DashboardScopedDefaultSelection, DashboardVisionAgent, DashboardReasoningDiscovery, DashboardReasoningCapabilityCandidate, DashboardGatewayProbeModel, DashboardGatewayProbeResult, DashboardLifecycleActivity, DashboardSettings, DashboardFile, DashboardTableSheet, DashboardTablePreview, DashboardLightboxItem, DashboardQuestionChoice, DashboardPendingQuestion, DashboardApproval, DashboardGatewayTransport, DashboardScopedRequest, DashboardFetchOptions, DashboardModelSource, DashboardSessionStatus, DashboardApiResult, DashboardActivity, DashboardModelOption, DashboardGatewayProfile, DashboardGatewayConfig, DashboardModelSelection, DashboardPendingGuide, DashboardStreamEvent, DashboardUiState , DashboardSessionSummary } from "./app-core.ts";
import { eventTargetOf, eventElement, isPlainObject, modelSourceOf, errorMessageOf, init, bootstrapDashboard, observeRunStatus, updateRunStatusTone, bindEvents, normalizedResponsiveView, composerHeightFor, previewWidthBounds, clampedPreviewWidth, permissionIndexForKey, focusTrapTarget, shouldFollowTranscript, scheduleAnimationFrameOnce, cancelScheduledAnimationFrame, appendPlainDraftDelta, renderFinalAssistantBody, selectTranscriptNodesToRemove, responsiveLayoutMode, restorePreviewWidth, setPreviewWidth, syncPreviewResizeHandle, beginPreviewResize, updatePreviewResize, finishPreviewResize, handlePreviewResizeKeydown, setResponsiveView, syncResponsiveNavigation, setResponsiveSurfaceInert, handleResponsiveFileNavigation, syncVisualViewport, resizePromptInput, handlePermissionModeKeydown, requestPermissionMode, defaultGoalMaxAutoContinues, emptyGoalSnapshot, applyGoalSnapshot, renderGoalControls, renderGoalStatusBar, requestGoalMode, showGoalConfirm, hideGoalConfirm, showGoalTextPanel, hideGoalTextPanel, enableGoalWithObjective, submitGoalAction, adoptGoalRunResult, showPermissionConfirm, hidePermissionConfirm, updateContextActions, announceStatus, modalFocusableElements, activateModal, collectModalBackground, focusModalInitialTarget, deactivateModal, restoreModalAttribute, handleGlobalKeydown, closeActiveModal, loadTrust, loadSessions, restoreInitialSession, latestBackgroundSessionId, initialSessionId, rememberCurrentSession, renderSessions, sessionMeta, sessionStatusView, toggleSidebar, setSidebarCollapsed, sessionsNeedRefresh, scheduleSessionsRefresh, handleSessionAction, openSession, restoreBackgroundSnapshot, deleteSession, setSessionsRefreshState, copySessionId, newTask, rememberNewTaskModelState, restoreNewTaskModelState, refreshNewTaskModelState, addAttachmentFiles, readImageAttachment, renderAttachmentStrip, attachmentPayload, clearAttachments, sendPrompt, stableTurnRequest, dashboardRequestId, dashboardClientId, statusUrl, interruptTurn, guideTurn, cancelQueuedTurn, cancelBackgroundSubagent, backgroundCancelKey, connectEvents, ensureEventsConnected, disconnectEvents, closeEventSource, markEventConnectionAlive, armEventConnectTimer, armEventStaleTimer, scheduleEventReconnect, reconnectEventsManually, clearEventReconnectTimer, clearEventConnectTimer, clearEventStaleTimer, setConnectionState, resetEventReplayState, rememberEventCursor, handleDashboardEvent, shouldSkipDashboardEvent, beginEventTurn, renderTranscriptMessages, renderSessionFailure, setTranscriptPaging, renderTranscriptHistoryStatus, removeTranscriptHistoryStatus, transcriptFirstContentNode, handleTranscriptScroll, loadOlderTranscript, renderWorkflowPanel, renderWorkflowStrip, currentWorkflowItem, workflowSection, workflowItem, normalizeWorkflowStatus, summarizeWorkflow, appendMessage, createMessageNode, appendTranscriptNode, trimTranscriptWindow, isProtectedTranscriptNode, renderTranscriptWindowMarker, captureTranscriptViewportAnchor, restoreTranscriptViewportAnchor, transcriptNodeTop, restoreTranscriptNodeAnchor, resetTranscriptWindow, appendAssistantDraft, scheduleDraftRender, renderAssistantDraft, appendActivity, appendContextBoundary, contextBoundaryText, handleActivity, isBackgroundSubagentActivity, handleBackgroundSubagentActivity, clearBackgroundSubagentStatus, reconcileBackgroundSubagentSnapshot, backgroundSubagentDisplayStatus, backgroundSubagentVisible, updateLiveActivity, removeLiveActivity, setLiveTitle, toggleLiveStatusDetails, updateLiveStatus, liveStatusTitle, primaryLiveActivity, gatewayRetryChipText, renderBackgroundSubagentStatus, backgroundSubagentCompactLabel, backgroundSubagentTitle, backgroundSubagentMeta, backgroundSubagentCancellable, resetLiveStatus, backgroundSubagentCounts, idleRunStatus, applyIdleRunStatus, updateRunStatusForBackground, updateSessionStatus, updateTurnChangeStats, resetTurnChangeStats, normalizeChangeStats, renderComposerStatus, modelStatusHtml, unresolvedModelStatusHtml, handleModelStatusActivate, handleModelStatusKeydown, toggleModelPanel, hideModelPanel, showSettingsWorkspace, refreshSettingsConfiguration, hideSettingsWorkspace, showModelConfigPanel, hideModelConfigPanel, renderModelPanel, markModelConfigEndpointChanged, handleModelConfigModelIdChanged, markReasoningCapabilityManual, clearReasoningCapabilityControls, syncGatewayUrlHint, gatewayUrlPlaceholder, gatewayUrlHint, syncReasoningDefaultOptions, probeGateway, isCurrentModelConfigRequest, currentGatewayProbeResult, currentGatewayCatalogModels, modelConfigGatewayProfile, modelConfigEndpointChanged, modelConfigAgentModelsSnapshot, initializeAgentModelPickerSnapshot, syncAgentModelPickersForEndpoint, uniqueAgentModelCandidates, appendAgentModelOptions, renderAgentModelPickers, updateAgentModelPickerManualStatus, handleAgentModelSelection, renderGatewayProbeResult, applyProbedModel, applyGatewayDiscoveredModel, applySuggestedGatewayUrl, gatewayCredentialAction, normalizeGatewayProbeModels, normalizeReasoningDiscovery, reasoningCapabilityCandidate, applyReasoningCapabilityCandidate, ensureReasoningEffortOptions, applyPendingReasoningCapabilities, reasoningCapabilityIsActionable, renderReasoningCapabilityStatus, reasoningCapabilityStatusText, reasoningDiscoveryStatusText, probeModelCapabilities, setFormControlsSaving, setModelConfigFormSaving, renderModelConfigFailure, clearModelConfigFailure, manualAgentModelIds, saveModelConfig, importModelSource, saveDefaultModelSelection, switchModel, handleReasoningEffortChange, switchReasoningEffort, deleteGatewayProfile, deleteModel, updateConfigRevisions, normalizeScopedDefaultSelection, configScope, configMutationMetadata, isConfigRevisionConflict, configRevisionConflictMessage, refreshConfigRevisionsAfterConflict, normalizeGatewayConfig, normalizeDashboardSettings, mergeGatewayConfig, normalizeGatewayProfiles, normalizeConfigSource, normalizeModels, normalizeModelSource, normalizeReasoningEfforts, normalizedReasoningEffort, isDisabledReasoningEffort, configuredReasoningEffort, reasoningEffortFallbackLabel, localizedReasoningEffortLabel, reasoningEffortCatalog, reasoningEffortLabel, resolveAtomicModelSelection, currentModelSelection, currentSessionNeedsModelSelection, currentGatewayProfile, gatewayProfileById, settingsInspectedGatewayProfile, modelSourceLabel, markCurrentModel, currentModelInfo, modelDisplayName, normalizeAgentModelTiers, normalizeAgentRouting, normalizeVisionAgent, firstVisionModelId, hasAgentModelTiers, agentModelTiersSummary, gatewaySummary, modelSaveTargetLabel, gatewaySourceNote, environmentGatewayDefaultNote, sourceBadge, sourceLabel, formatContextUsage, firstFiniteNumber, formatTokenCount, trimNumber, nonNegativeInteger, collapseCompletedActivities, clearAssistantDrafts, collapseAssistantDrafts, isMeaningfulCompletedActivity, isDuplicateDraftText, normalizeComparableText, showApproval, resolveApproval, hideApproval, showQuestion, revealInteractionPanel, renderQuestionPanel, reviewQuestionConversation, returnToQuestion, activateQuestionReviewBackground, deactivateQuestionReviewBackground, questionChoiceButton, toggleQuestionChoice, submitQuestion, cancelQuestion, finishQuestionSubmission, hideQuestion, showTrustPanel, renderTrustPanel, confirmTrust, renderQueuePanel, renderQueueItem, setPendingGuide, clearPendingGuide, syncPendingGuideFromQueue, renderGuideFeedback, guideCopy, guideSource, guideTurnFromQueue, guideButtonText, guideButtonDisabled, guideButtonVisible, syncGuideButton, shouldKeepGuideFeedback, isInterruptError, updateSendButton, showContextConfirm, hideContextConfirm, runContextAction, contextActionRequestOptions, contextSummaryLine, compactResultLine, rememberQuestionDraft, questionResolutionText, showShutdownPanel, hideShutdownPanel, shutdownDashboard, lockClosedDashboard, normalizeLifecycleActivity, shutdownRequestBody, shutdownResultIsClosed, lifecycleActivitySummary, renderShutdownActivity, renderFiles, currentImageFiles, openFile, renderOfficePreview, officePreviewMeta, officePreviewBodyHtml, renderTablePreview, normalizeTablePreview, tablePreviewMeta, renderCompactTableHtml, renderExpandedTableHtml, renderTableHtml, tableTruncationNote, maxVisibleColumns, columnLabel, renderSheetPreviewHtml, renderSheetCellHtml, resetPreview, fencedDataForFile, dataLanguageForExtension, showImageLightbox, showTableLightbox, renderLightboxImage, bindTableLightboxControls, moveLightbox, hideLightbox, setPermissionMode, clearTranscript, cancelTranscriptAnimationFrames, clearAssistantDraftTimers, hideEmptyState, showError, showNotice, renderBootstrapLoading, renderBootstrapFailure, dashboardPayloadError, bootstrapFailurePresentation, clearBootstrapStatus, scrollTranscript, isTranscriptNearBottom, syncTranscriptFollowState, followTranscript, updateTranscriptJump, beginScopedRequest, isCurrentScopedRequest, finishScopedRequest, cancelScopedRequest, isAbortError, getJson, postJson, loadSchedules, deleteJson, dashboardFetch, responseJson, dashboardJsonHeaders, dashboardCsrfToken, messageText, messageDisplayText, userMessageDisplayText, normalizeAttachmentMetadata, imageAttachmentLine, renderMessageText, renderLinkedText, bindRichContent, linkifyFileTextNodes, replaceFileReferences, isLikelyLocalFileReference, resolveDisplayFilePath, normalizeFileReferencePath, parentDirectory, filePreviewUrl, rawFileUrl, apiFileUrl, imagePreviewUrl, isSafeInlineBitmapUrl, normalizeRelativePath, isWorkspaceRelativeToBase, copyCodeBlock, previewText, formatNumber, formatBytes, escapeHtml, escapeAttribute, formatTime, formatRelativeTime } from "./app-barrel.ts";
export function modelCapabilityLabels(model: DashboardModelOption | string | null | undefined) {
  if (!model || typeof model !== "object") {
    return [];
  }
  const modalities = new Set(Array.isArray(model?.modalities) ? model.modalities : ["text"]);
  const labels = [];
  if (modalities.has("text")) labels.push("文本");
  if (modalities.has("image") || inferModelSupportsImages(model.id)) labels.push("视觉");
  if (model?.thinking) labels.push("thinking");
  return labels.length > 0 ? labels : ["文本"];
}

export async function handleModelPanelClick(event: Event) {
  event.stopPropagation();
  const button = eventElement(event)?.closest("button[data-action='pick-model']");
  if (!(button instanceof HTMLButtonElement) || button.disabled) return;
  await switchModel(button.dataset.modelId || "", { profileId: button.dataset.profileId || "" });
}

export async function handleModelPanelChange(event: Event) {
  event.stopPropagation();
  const select = eventElement(event)?.closest("select[data-action]");
  if (!(select instanceof HTMLSelectElement) || select.disabled) return;
  if (select.dataset.action === "switch-source") {
    const profile = (state.gatewayProfiles ?? []).find((item) => item.id === select.value);
    const modelId = profile?.modelAlias || profile?.models?.[0]?.id || "";
    await switchModel(modelId, { profileId: profile?.id || "", keepPanelOpen: true });
  } else if (select.dataset.action === "switch-model") {
    await switchModel(select.value, { profileId: select.selectedOptions[0]?.dataset.profileId || currentModelSelection().profile?.id || "" });
  }
}

export function renderSettingsView() {
  if (!els.settingsContent || !state.settingsOpen) return;
  els.settingsContent.toggleAttribute("aria-busy", state.settingsRefreshing);
  syncSettingsRail();
  const sectionHtml = state.settingsSection === "transcript"
    ? transcriptSettingsHtml()
    : state.settingsSection === "network"
      ? networkSettingsHtml()
      : state.settingsSection === "agents"
        ? agentSettingsHtml()
        : state.settingsSection === "schedules"
          ? scheduleSettingsHtml()
          : state.settingsSection === "reliability"
            ? reliabilitySettingsHtml()
            : modelSettingsHtml();
  els.settingsContent.innerHTML = `${settingsFeedbackHtml()}${sectionHtml}`;
  els.settingsContent.querySelectorAll("form[data-settings-form]").forEach((form) => {
    initializeSettingsFormTracking(/** @type {HTMLFormElement} */ (form));
  });
  const scheduleForm = els.settingsContent.querySelector("form[data-settings-form='schedule-create']");
  if (scheduleForm instanceof HTMLFormElement) {
    scheduleForm.querySelector("select[name='cadence']")?.addEventListener("change", () => syncScheduleCadenceFields(scheduleForm));
    syncScheduleCadenceFields(scheduleForm);
  }
}

export function syncSettingsRail() {
  els.settingsRail?.querySelectorAll("button[data-settings-section]").forEach((button) => {
    const active = button.dataset.settingsSection === state.settingsSection;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
}

export function modelSettingsHtml() {
  const profiles = state.gatewayProfiles ?? [];
  const inspectedProfile = settingsInspectedGatewayProfile();
  const models = preferPrefixedCatalog(inspectedProfile?.models ?? []);
  const scopedDefault = state.modelDefaultSelections[state.modelDefaultScope];
  return `
    <section class="settings-section" aria-labelledby="settings-sources-title">
      <div class="settings-section-head">
        <div>
          <div class="settings-section-kicker">模型来源</div>
          <h2 id="settings-sources-title">网关档案</h2>
        </div>
        <button class="settings-primary-action" id="settings-add-source" type="button" data-action="add-source"${state.settingsRefreshing ? " disabled" : ""}>添加来源</button>
      </div>
      <div class="settings-default-scope">
        <div class="settings-default-scope-picker" role="group" aria-label="设为默认时保存到">
          <span>设为默认时保存到</span>
          <button type="button" data-action="select-default-scope" data-scope="project" aria-pressed="${state.modelDefaultScope === "project"}"${state.settingsRefreshing ? " disabled" : ""}>当前项目</button>
          <button type="button" data-action="select-default-scope" data-scope="global" aria-pressed="${state.modelDefaultScope === "global"}"${state.settingsRefreshing ? " disabled" : ""}>全局</button>
        </div>
        <div class="settings-default-summary" aria-live="polite">
          <span>${state.modelDefaultScope === "global" ? "全局默认" : "当前项目默认"}</span>
          <strong>${escapeHtml(scopedDefaultModelLabel(scopedDefault))}</strong>
        </div>
      </div>
      <div class="settings-current-source">
        <span class="settings-current-label">查看来源</span>
        <strong>${escapeHtml(inspectedProfile?.label || "未选择来源")}</strong>
        <span>${escapeHtml(inspectedProfile?.gatewayUrl || "未配置网关")}</span>
      </div>
      ${settingsFeedbackHtml()}
      <div class="settings-profile-list">
        ${providerRouteGroups(profiles).map((group) => `<div class="settings-source-group"><h3>${escapeHtml(group.label)}</h3>${group.profiles.map((profile) => settingsGatewayProfileHtml(profile)).join("")}</div>`).join("") || `<div class="settings-empty">尚未保存模型来源</div>`}
      </div>
    </section>
    <section class="settings-section" aria-labelledby="settings-models-title">
      <div class="settings-section-head">
        <div>
          <div class="settings-section-kicker">${escapeHtml(inspectedProfile?.label || "当前来源")}</div>
          <h2 id="settings-models-title">模型</h2>
        </div>
        <div class="settings-section-tools">
          <span class="settings-section-count">${models.length} 个</span>
          <button class="settings-primary-action" type="button" data-action="refresh-source" data-profile-id="${escapeAttribute(inspectedProfile?.id || "")}"${!inspectedProfile || state.settingsRefreshing || state.running ? " disabled" : ""}>刷新目录</button>
        </div>
      </div>
      <div class="settings-model-list">
        ${models.map((model) => settingsModelHtml(model, inspectedProfile, models.length)).join("") || `<div class="settings-empty">该来源还没有模型。添加来源时会一次读入目录。</div>`}
      </div>
    </section>
  `;
}

export function transcriptSettingsHtml() {
  const settings = state.settings ?? normalizeDashboardSettings(null);
  const transcript = settings.transcript;
  const managed = settings.managed;
  return `
    <form class="settings-form" data-settings-form="transcript">
      <section class="settings-section" aria-labelledby="settings-transcript-title">
        ${settingsSectionHeading("隐私与历史", "会话记录", "settings-transcript-title")}
        <div class="settings-control-list">
          <label class="settings-toggle-row">
            <span><strong>保存会话历史</strong>${managedFieldHtml(managed.transcriptEnabled)}</span>
            <input name="enabled" type="checkbox"${transcript.enabled ? " checked" : ""}${settingsDisabled(managed.transcriptEnabled)} />
          </label>
          <label class="settings-field-row">
            <span><strong>保留期限</strong>${managedFieldHtml(managed.transcriptRetentionDays)}</span>
            <select name="retentionDays" required${settingsDisabled(managed.transcriptRetentionDays)}>
              ${transcriptRetentionOptionsHtml(transcript.retentionDays)}
            </select>
          </label>
          <label class="settings-field-row">
            <span><strong>本地记录加密</strong>${managedFieldHtml(managed.transcriptEncryption)}</span>
            <select name="encryption"${settingsDisabled(managed.transcriptEncryption)}>
              <option value="off"${transcript.encryption === "off" ? " selected" : ""}>关闭</option>
              <option value="optional"${transcript.encryption === "optional" ? " selected" : ""}>有密钥时加密</option>
              <option value="required"${transcript.encryption === "required" ? " selected" : ""}${!transcript.encryptionKeyConfigured && transcript.encryption !== "required" ? " disabled" : ""}>强制加密</option>
            </select>
          </label>
        </div>
      </section>
      ${settingsFormActions()}
    </form>
  `;
}

/** @param {number | null} current */
export function transcriptRetentionOptionsHtml(current: number | null) {
  const options: Array<[string, string]> = [
    ["0", "不保留"],
    ["1", "1 天"],
    ["7", "7 天"],
    ["30", "30 天"],
    ["90", "90 天"],
    ["180", "180 天"],
    ["365", "1 年"],
    ["730", "2 年"],
    ["1825", "5 年"],
    ["3650", "10 年（期限上限）"],
    ["forever", "永久保留"]
  ];
  const currentValue = current === null ? "forever" : String(current);
  if (current !== null && Number.isInteger(current) && !options.some(([value]) => value === currentValue)) {
    options.splice(options.length - 1, 0, [currentValue, `${current} 天（当前）`]);
  }
  return options.map(([value, label]) => (
    `<option value="${escapeAttribute(value)}"${value === currentValue ? " selected" : ""}>${escapeHtml(label)}</option>`
  )).join("");
}

export function networkSettingsHtml() {
  const settings = state.settings ?? normalizeDashboardSettings(null);
  const network = settings.network;
  return `
    <form class="settings-form" data-settings-form="network">
      <section class="settings-section" aria-labelledby="settings-network-title">
        ${settingsSectionHeading("网络边界", "出站访问", "settings-network-title")}
        <div class="settings-control-list">
          <label class="settings-field-row">
            <span><strong>网络模式</strong>${managedFieldHtml(settings.managed.networkMode)}</span>
            <select name="mode"${settingsDisabled(settings.managed.networkMode)}>
              ${networkModeOptionHtml("offline", "离线", network)}
              ${networkModeOptionHtml("lab-only", "仅实验室", network)}
              ${networkModeOptionHtml("approved-web", "仅允许列表", network)}
              ${networkModeOptionHtml("open-dev", "开放开发网络", network)}
            </select>
          </label>
          <label class="settings-field-stack">
            <span><strong>允许的主机</strong>${network.managedAllowedHosts.length > 0 ? `<small>环境追加 ${network.managedAllowedHosts.length} 个</small>` : ""}</span>
            <textarea name="allowedHosts" rows="10" spellcheck="false"${settingsDisabled(false)}>${escapeHtml(network.allowedHosts.join("\n"))}</textarea>
          </label>
        </div>
      </section>
      ${settingsFormActions()}
    </form>
  `;
}

/** @param {string} value @param {string} label @param {any} network */
export function networkModeOptionHtml(value: string, label: string, network: DashboardSettings["network"]) {
  const allowed = Array.isArray(network.allowedModes) && network.allowedModes.includes(value);
  return `<option value="${escapeAttribute(value)}"${network.mode === value ? " selected" : ""}${allowed ? "" : " disabled"}>${escapeHtml(label)}</option>`;
}

export function agentSettingsHtml() {
  const settings = state.settings ?? normalizeDashboardSettings(null);
  const agents = settings.agents;
  return `
    <form class="settings-form" data-settings-form="agents">
      <section class="settings-section" aria-labelledby="settings-agents-title">
        ${settingsSectionHeading("子智能体", "默认行为", "settings-agents-title")}
        <div class="settings-control-list">
          <label class="settings-field-row">
            <span><strong>只读任务并行数</strong></span>
            <span class="settings-number-control"><input name="maxParallelReadonlyAgentRuns" type="number" min="1" max="8" step="1" required value="${escapeAttribute(agents.maxParallelReadonlyAgentRuns)}"${settingsDisabled(false)} /><span>个</span></span>
          </label>
          ${settingsToggleHtml("backgroundWakeupEnabled", "允许后台子智能体", agents.backgroundWakeupEnabled)}
          ${settingsToggleHtml("backgroundByDefault", "模型子任务默认后台运行", agents.backgroundByDefault)}
          ${settingsToggleHtml("reviewGateEnabled", "交付前审查提醒", agents.reviewGateEnabled)}
        </div>
      </section>
      <section class="settings-section" aria-labelledby="settings-goal-title">
        ${settingsSectionHeading("Goal 模式", "自动续跑", "settings-goal-title")}
        <div class="settings-control-list">
          <label class="settings-field-row">
            <span><strong>自动续跑上限</strong></span>
            <span class="settings-number-control"><input name="goalMaxAutoContinues" type="number" min="1" max="100" step="1" required value="${escapeAttribute(agents.goalMaxAutoContinues)}"${settingsDisabled(false)} /><span>次</span></span>
          </label>
        </div>
      </section>
      ${settingsFormActions()}
    </form>
  `;
}

export function scheduleSettingsHtml() {
  const schedules = state.schedules ?? [];
  return `
    <section class="settings-section" aria-labelledby="settings-schedules-title">
      ${settingsSectionHeading("定时任务", "查看与管理", "settings-schedules-title")}
      <p class="settings-source-note">到点由本机 Dashboard 把保存的提示词再发一轮，使用完全访问，不再弹出放权。手动添加即视为确认。</p>
      <form class="settings-form schedule-settings-form" data-settings-form="schedule-create">
        <label class="settings-field-row"><span><strong>标题</strong></span><input name="title" maxlength="80" required placeholder="例如：早间检查" /></label>
        <label class="settings-field-row"><span><strong>提示词</strong></span><textarea name="prompt" required maxlength="4000" rows="4" placeholder="到点要让模型做什么"></textarea></label>
        <label class="settings-field-row"><span><strong>周期</strong></span>
          <select name="cadence" data-action="schedule-cadence">
            <option value="once">只跑一次</option>
            <option value="daily">每天</option>
            <option value="weekly">每周</option>
            <option value="interval">固定间隔</option>
          </select>
        </label>
        <label class="settings-field-row" data-schedule-field="once"><span><strong>几分钟后</strong></span><input name="delayMinutes" inputmode="numeric" value="5" /></label>
        <label class="settings-field-row" data-schedule-field="daily"><span><strong>每天时间</strong></span><input name="dailyTime" value="09:00" /></label>
        <label class="settings-field-row" data-schedule-field="weekly"><span><strong>星期</strong></span>
          <select name="weekday">
            <option value="1" selected>周一</option>
            <option value="2">周二</option>
            <option value="3">周三</option>
            <option value="4">周四</option>
            <option value="5">周五</option>
            <option value="6">周六</option>
            <option value="0">周日</option>
          </select>
        </label>
        <label class="settings-field-row" data-schedule-field="weekly"><span><strong>时间</strong></span><input name="weeklyTime" value="09:00" /></label>
        <label class="settings-field-row" data-schedule-field="interval"><span><strong>间隔分钟</strong></span><input name="everyMinutes" inputmode="numeric" value="60" /></label>
        <footer class="settings-form-actions">
          <button type="submit"${settingsDisabled(false)}>添加定时任务</button>
        </footer>
      </form>
      <div class="schedule-settings-list">
        ${schedules.map((schedule) => scheduleSettingsCard(schedule)).join("") || `<div class="settings-empty">还没有定时任务</div>`}
      </div>
    </section>
  `;
}

function scheduleSettingsCard(schedule: Record<string, unknown>) {
  const id = escapeAttribute(String(schedule.id ?? ""));
  const enabled = schedule.enabled !== false;
  return `
    <article class="source-card">
      <div>
        <strong>${escapeHtml(String(schedule.title ?? "定时任务"))}</strong>
        <span>${escapeHtml(String(schedule.cadenceLabel ?? ""))} · ${escapeHtml(String(schedule.permissionLabel ?? "完全访问"))}</span>
        <small>${enabled ? `下次 ${escapeHtml(formatTime(schedule.nextRunAt))}` : "已暂停"} · ${escapeHtml(String(schedule.lastStatus ?? "尚未运行"))}</small>
      </div>
      <div class="source-card-actions">
        <button type="button" data-schedule-action="${enabled ? "pause" : "resume"}" data-schedule-id="${id}">${enabled ? "暂停" : "恢复"}</button>
        <button type="button" data-schedule-action="delete" data-schedule-id="${id}">删除</button>
      </div>
    </article>
  `;
}

export function reliabilitySettingsHtml() {
  const settings = state.settings ?? normalizeDashboardSettings(null);
  const reliability = settings.reliability;
  const managed = settings.managed;
  return `
    <form class="settings-form" data-settings-form="reliability">
      <section class="settings-section" aria-labelledby="settings-reliability-title">
        ${settingsSectionHeading("网关可靠性", "请求策略", "settings-reliability-title")}
        <div class="settings-control-list">
          <label class="settings-field-row">
            <span><strong>失败重试</strong>${managedFieldHtml(managed.gatewayMaxRetries)}</span>
            <span class="settings-number-control"><input name="maxRetries" type="number" min="0" max="5" step="1" required value="${escapeAttribute(reliability.maxRetries)}"${settingsDisabled(managed.gatewayMaxRetries)} /><span>次</span></span>
          </label>
          <label class="settings-field-row">
            <span><strong>总超时</strong>${managedFieldHtml(managed.gatewayTimeoutMs)}</span>
            <span class="settings-number-control"><input name="timeoutSeconds" type="number" min="1" max="900" step="1" required value="${escapeAttribute(Math.round(reliability.timeoutMs / 1000))}"${settingsDisabled(managed.gatewayTimeoutMs)} /><span>秒</span></span>
          </label>
          <label class="settings-field-row">
            <span><strong>流空闲超时</strong>${managedFieldHtml(managed.gatewayIdleTimeoutMs)}</span>
            <span class="settings-number-control"><input name="idleTimeoutSeconds" type="number" min="1" max="300" step="1" required value="${escapeAttribute(Math.round(reliability.idleTimeoutMs / 1000))}"${settingsDisabled(managed.gatewayIdleTimeoutMs)} /><span>秒</span></span>
          </label>
        </div>
      </section>
      ${settingsFormActions()}
    </form>
  `;
}

/** @param {string} kicker @param {string} title @param {string} id */
export function settingsSectionHeading(kicker: string, title: string, id: string) {
  return `<div class="settings-section-head"><div><div class="settings-section-kicker">${escapeHtml(kicker)}</div><h2 id="${escapeAttribute(id)}">${escapeHtml(title)}</h2></div></div>`;
}

/** @param {string} name @param {string} label @param {boolean} checked @param {string} [detail] */
export function settingsToggleHtml(name: string, label: string, checked: boolean, detail: string = "") {
  return `<label class="settings-toggle-row"><span><strong>${escapeHtml(label)}</strong>${detail ? `<small>${escapeHtml(detail)}</small>` : ""}</span><input name="${escapeAttribute(name)}" type="checkbox"${checked ? " checked" : ""}${settingsDisabled(false)} /></label>`;
}

/** @param {boolean} managed */
export function managedFieldHtml(managed: boolean) {
  return managed ? `<small>环境变量管理</small>` : "";
}

/** @param {boolean} managed */
export function settingsDisabled(managed: boolean) {
  return state.settingsSaving || state.settingsRefreshing || state.running || managed ? " disabled" : "";
}

export function settingsFormActions() {
  return `
    <footer class="settings-form-actions">
      <label><span>保存到</span><select name="saveTarget"${settingsDisabled(false)}><option value="project"${state.settingsSaveTarget === "project" ? " selected" : ""}>当前项目</option><option value="global"${state.settingsSaveTarget === "global" ? " selected" : ""}>全局默认</option></select></label>
      <button type="submit"${settingsDisabled(false)}>${state.settingsSaving ? "保存中" : "保存"}</button>
    </footer>
  `;
}

export function settingsFeedbackHtml() {
  if (!state.settingsFeedback?.message) return "";
  return `<div class="settings-feedback ${escapeAttribute(state.settingsFeedback.tone)}" role="status">${escapeHtml(state.settingsFeedback.message)}</div>`;
}

/** @param {any} profile */
export function settingsGatewayProfileHtml(profile: DashboardGatewayProfile) {
  const confirmingDelete = state.deleteConfirmGatewayProfileId === profile.id;
  const deleting = state.deletingGatewayProfileId === profile.id;
  const inspected = settingsInspectedGatewayProfile()?.id === profile.id;
  const count = Number.isFinite(profile.modelCount) ? profile.modelCount : profile.models?.length ?? 0;
  return `
    <div class="settings-profile-row${inspected ? " active" : ""}${confirmingDelete ? " confirming-delete" : ""}">
      <span class="settings-source-indicator" aria-hidden="true"></span>
      <div class="settings-row-main">
        <strong>${escapeHtml(providerRouteLabel(profile))}</strong>
        <span>${escapeHtml(profile.gatewayUrl || profile.id)}</span>
        <small>${escapeHtml(profile.ready === false
          ? `${protocolDisplayName(profile.gatewayProtocol)} · 配置不完整`
          : `${protocolDisplayName(profile.gatewayProtocol)} · ${profile.apiKeyConfigured ? "Key 已配置" : "无 Key"} · ${count} 模型`)}</small>
      </div>
      <div class="settings-row-actions">
        <button type="button" data-action="inspect-profile" data-profile-id="${escapeAttribute(profile.id)}" aria-pressed="${inspected}" ${state.settingsRefreshing ? "disabled" : ""}>${inspected ? "正在查看" : "查看模型"}</button>
        <button type="button" data-action="use-profile" data-profile-id="${escapeAttribute(profile.id)}" ${profile.ready === false || state.settingsRefreshing || state.running || state.modelSwitching ? "disabled" : ""}>设为默认</button>
        <button type="button" data-action="edit-gateway-profile" data-profile-id="${escapeAttribute(profile.id)}"${profile.editable === false ? ` title="${escapeAttribute(gatewayProfileReadonlyLabel(profile))}"` : ""} ${profile.editable === false || state.settingsRefreshing || state.running || Boolean(state.deletingGatewayProfileId) ? "disabled" : ""}>${profile.editable === false ? "只读" : "编辑"}</button>
        <button class="danger" type="button" data-action="delete-gateway-profile" data-profile-id="${escapeAttribute(profile.id)}" ${profile.editable === false || state.settingsRefreshing || state.running || Boolean(state.deletingGatewayProfileId) ? "disabled" : ""}>${deleting ? "删除中" : confirmingDelete ? "确认删除" : "删除"}</button>
      </div>
      ${confirmingDelete ? `<div class="settings-delete-confirm">再次点击确认删除；删除当前来源后不会自动切换到其他来源。</div>` : ""}
    </div>
  `;
}

/** @param {any} profile */
export function gatewayProfileReadonlyLabel(profile: DashboardGatewayProfile) {
  if (profile.ownerScope === "environment") return "该来源由环境变量管理";
  if (profile.ownerScope === "bundled") return "该来源由内置配置管理";
  return "该来源不能在这里直接编辑";
}

/** @param {unknown} providerId @param {unknown} modelId */
export function providerModelKey(providerId: unknown, modelId: unknown) {
  return JSON.stringify([String(providerId ?? ""), String(modelId ?? "")]);
}

/** @param {any} selection */
export function scopedDefaultModelLabel(selection: DashboardScopedDefaultSelection | null | undefined) {
  if (!selection?.provider || !selection?.model) return "未单独设置（使用上级默认）";
  const profile = gatewayProfileById(selection.provider);
  const model = profile?.models?.find((candidate: { id?: string }) => candidate.id === selection.model);
  const sourceLabel = profile?.label || selection.provider;
  const modelLabel = model?.label || selection.model;
  return modelLabel === selection.model
    ? `${sourceLabel} · ${selection.model}`
    : `${sourceLabel} · ${modelLabel} (${selection.model})`;
}

/** @param {any} model @param {any} profile @param {number} modelCount */
export function settingsModelHtml(model: DashboardModelOption, profile: DashboardGatewayProfile | null | undefined, modelCount: number) {
  const tags = modelCapabilityLabels(model);
  const efforts = normalizeReasoningEfforts(model.reasoningEfforts);
  const context = Number.isFinite(model.contextTokens) ? `${formatTokenCount(model.contextTokens)} 上下文` : "";
  const scopedDefault = state.modelDefaultSelections[state.modelDefaultScope];
  const isScopedDefault = scopedDefault?.provider === (profile?.id || "")
    && scopedDefault?.model === model.id;
  return `
    <div class="settings-model-row${isScopedDefault ? " scope-default" : ""}">
      <div class="settings-row-main">
        <div class="settings-row-title">
          <strong>${escapeHtml(model.label || model.id)}</strong>
          ${isScopedDefault ? `<span>此范围默认</span>` : ""}
        </div>
        <span>${escapeHtml(model.id)}</span>
        <div class="settings-model-tags">
          ${tags.map((tag: unknown) => `<span>${escapeHtml(tag)}</span>`).join("")}
          ${context ? `<span>${escapeHtml(context)}</span>` : ""}
          ${efforts.length > 0 ? `<span>思考 ${escapeHtml(efforts.map((effort) => effort.label).join(" / "))}</span>` : ""}
        </div>
      </div>
      <div class="settings-row-actions">
        <button type="button" data-action="use-model" data-model-id="${escapeAttribute(model.id)}" data-profile-id="${escapeAttribute(profile?.id || "")}" ${isScopedDefault || state.settingsRefreshing || state.running || state.modelSwitching ? "disabled" : ""}>${isScopedDefault ? "已设为默认" : "设为默认"}</button>
      </div>
    </div>
  `;
}

/** @param {any} event */
export function handleSettingsRailClick(event: Event) {
  const button = eventTargetOf(event).closest("button[data-settings-section]");
  if (!button || state.settingsSaving) return;
  state.settingsSection = button.dataset.settingsSection || "models";
  if (state.settingsSection === "schedules") void loadSchedules();
  state.settingsFeedback = null;
  renderSettingsView();
}

/** @param {HTMLFormElement} form */
export function initializeSettingsFormTracking(form: HTMLElement) {
  for (const control of form.querySelectorAll("[name]")) {
    if (control.name === "saveTarget") continue;
    control.dataset.initialValue = settingsControlValue(control);
  }
  form.dataset.changedFields = "[]";
}

/** @param {any} event */
export function handleSettingsFormChange(event: Event) {
  const form = eventTargetOf(event).closest?.("form[data-settings-form]");
  if (!form || state.settingsSaving) return;
  form.dataset.changedFields = JSON.stringify(changedSettingsFields(form));
}

/** @param {any} control */
export function settingsControlValue(control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | Element) {
  if (control instanceof HTMLInputElement && control.type === "checkbox") {
    return String(control.checked);
  }
  return "value" in control ? String(control.value ?? "") : "";
}

/** @param {HTMLFormElement} form */
export function changedSettingsFields(form: HTMLElement) {
  const section = String(form.dataset.settingsForm ?? "");
  const changed: string[] = [];
  for (const control of form.querySelectorAll("[name]")) {
    if (control.name === "saveTarget" || control.disabled && control.dataset.saveDisabledBefore === undefined) continue;
    if (settingsControlValue(control) === String(control.dataset.initialValue ?? "")) continue;
    const field = canonicalSettingsField(section, control.name);
    if (field && !changed.includes(field)) changed.push(field);
  }
  return changed;
}

/** @param {string} section @param {string} name */
export function canonicalSettingsField(section: string, name: string) {
  if (section === "reliability" && name === "timeoutSeconds") return "timeoutMs";
  if (section === "reliability" && name === "idleTimeoutSeconds") return "idleTimeoutMs";
  return name;
}

/** @param {HTMLFormElement} form @param {boolean} saving */
export function setSettingsFormSaving(form: HTMLElement, saving: boolean) {
  setFormControlsSaving(form, saving, "保存中");
  if (els.settingsBack) els.settingsBack.disabled = saving;
}

export function renderSettingsFeedbackInPlace() {
  if (!els.settingsContent) return;
  let feedback = els.settingsContent.querySelector(".settings-feedback");
  if (!state.settingsFeedback?.message) {
    feedback?.remove();
    return;
  }
  if (!feedback) {
    feedback = document.createElement("div");
    els.settingsContent.insertBefore(feedback, els.settingsContent.firstChild);
  }
  feedback.className = `settings-feedback ${state.settingsFeedback.tone}`;
  feedback.setAttribute("role", state.settingsFeedback.tone === "error" ? "alert" : "status");
  feedback.textContent = state.settingsFeedback.message;
}

/** @param {any} event */
function routeFromSelect(value: string) {
  const [provider, model] = value.split("::");
  return provider && model ? { provider, model } : null;
}

function syncScheduleCadenceFields(form: HTMLFormElement | null) {
  if (!(form instanceof HTMLFormElement)) return;
  const cadence = String(new FormData(form).get("cadence") ?? "once");
  form.querySelectorAll<HTMLElement>("[data-schedule-field]").forEach((field) => {
    const active = field.dataset.scheduleField === cadence;
    field.classList.toggle("is-inactive", !active);
    field.querySelectorAll("input, select").forEach((input) => {
      if (input instanceof HTMLInputElement || input instanceof HTMLSelectElement) input.disabled = !active;
    });
  });
}

export async function saveScheduleForm(form: HTMLFormElement) {
  const data = new FormData(form);
  const cadence = String(data.get("cadence") ?? "once");
  const body: Record<string, unknown> = {
    title: String(data.get("title") ?? ""),
    prompt: String(data.get("prompt") ?? ""),
    cadence,
    sessionId: state.currentSessionId
  };
  if (cadence === "once") body.delayMinutes = Number(data.get("delayMinutes"));
  if (cadence === "daily") body.time = String(data.get("dailyTime") ?? "").trim();
  if (cadence === "weekly") {
    body.time = String(data.get("weeklyTime") ?? "").trim();
    body.weekday = String(data.get("weekday") ?? "");
  }
  if (cadence === "interval") body.everyMinutes = Number(data.get("everyMinutes"));
  state.settingsSaving = true;
  try {
    const result = await postJson("/api/schedules", body);
    if (!result.ok) throw new Error(result.error || "添加定时任务失败");
    showNotice("定时任务已添加", "到点会用完全访问自动发送");
    await loadSchedules();
  } catch (error) {
    state.settingsFeedback = { tone: "error", message: errorMessageOf(error) || "添加定时任务失败" };
    renderSettingsView();
  } finally {
    state.settingsSaving = false;
  }
}

export async function saveSourceAgentForm(form: HTMLFormElement) {
  const data = new FormData(form);
  const scope = state.modelDefaultScope === "project" ? "project" : "global";
  state.settingsSaving = true;
  try {
    const result = await postJson("/api/sources/agents", {
      saveTarget: scope,
      ...configMutationMetadata(scope),
      providerId: form.dataset.profileId,
      cheap: String(data.get("cheap") ?? ""),
      defaultModel: String(data.get("defaultModel") ?? ""),
      strong: String(data.get("strong") ?? ""),
      visionModel: String(data.get("visionModel") ?? "")
    });
    if (!result.ok) throw new Error(result.error || "保存子智能体模型失败");
    updateConfigRevisions({ ...result, scope });
    state.gatewayProfiles = normalizeGatewayProfiles(result.gatewayProfiles);
    showNotice("子智能体模型已保存", "只作用于这个渠道");
  } catch (error) {
    state.settingsFeedback = { tone: "error", message: errorMessageOf(error) || "保存子智能体模型失败" };
  } finally {
    state.settingsSaving = false;
    renderSettingsView();
  }
}

export async function saveAgentRoutingForm(form: HTMLFormElement) {
  const data = new FormData(form);
  const scope = state.modelDefaultScope === "project" ? "project" : "global";
  state.settingsSaving = true;
  try {
    const result = await postJson("/api/agent-routing", {
      saveTarget: scope,
      ...configMutationMetadata(scope),
      tiers: {
        cheap: routeFromSelect(String(data.get("cheap") ?? "")),
        default: routeFromSelect(String(data.get("default") ?? "")),
        strong: routeFromSelect(String(data.get("strong") ?? ""))
      },
      visionModel: routeFromSelect(String(data.get("vision") ?? ""))
    });
    if (!result.ok) throw new Error(result.error || "保存子智能体模型失败");
    updateConfigRevisions({ ...result, scope });
    state.agentModelTiers = normalizeAgentModelTiers(result.agentModelTiers);
    state.agentRouting = normalizeAgentRouting(result.agentRouting ?? {
      cheap: routeFromSelect(String(data.get("cheap") ?? "")),
      default: routeFromSelect(String(data.get("default") ?? "")),
      strong: routeFromSelect(String(data.get("strong") ?? "")),
      vision: routeFromSelect(String(data.get("vision") ?? ""))
    });
    state.visionAgent = normalizeVisionAgent(result.visionAgent);
    showNotice("子智能体模型已保存", "聊天切换不会改写这些档位");
  } catch (error) {
    state.settingsFeedback = { tone: "error", message: errorMessageOf(error) || "保存子智能体模型失败" };
  } finally {
    state.settingsSaving = false;
    renderSettingsView();
  }
}

export async function saveSettingsConfig(event: Event) {
  const form = eventTargetOf(event).closest("form[data-settings-form]");
  if (!(form instanceof HTMLFormElement)) return;
  event.preventDefault();
  if (state.settingsSaving || state.running) return;
  if (form.dataset.settingsForm === "schedule-create") {
    await saveScheduleForm(form);
    return;
  }
  if (form.dataset.settingsForm === "source-agents") {
    await saveSourceAgentForm(form);
    return;
  }
  const section = form.dataset.settingsForm;
  /** @param {string} name */
  const field = (name: string) => /** @type {HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null} */ (form.elements.namedItem(name));
  /** @param {string} name */
  const checked = (name: string) => {
    const control = field(name);
    return Boolean(control instanceof HTMLInputElement && control.checked);
  };
  /** @param {string} name */
  const value = (name: string) => String(field(name)?.value ?? "");
  const settings = section === "transcript"
    ? {
        enabled: checked("enabled"),
        retentionDays: value("retentionDays") === "forever" ? null : Number(value("retentionDays")),
        encryption: value("encryption")
      }
    : section === "network"
      ? { mode: value("mode"), allowedHosts: value("allowedHosts") }
      : section === "agents"
        ? {
            maxParallelReadonlyAgentRuns: Number(value("maxParallelReadonlyAgentRuns")),
            backgroundWakeupEnabled: checked("backgroundWakeupEnabled"),
            backgroundByDefault: checked("backgroundByDefault"),
            reviewGateEnabled: checked("reviewGateEnabled"),
            syncModelTiersOnSwitch: checked("syncModelTiersOnSwitch"),
            goalMaxAutoContinues: Number(value("goalMaxAutoContinues"))
          }
        : {
            maxRetries: Number(value("maxRetries")),
            timeoutMs: Number(value("timeoutSeconds")) * 1000,
            idleTimeoutMs: Number(value("idleTimeoutSeconds")) * 1000
          };
  const changedFields = changedSettingsFields(form);
  state.settingsSaveTarget = value("saveTarget") === "global" ? "global" : "project";
  state.settingsSaving = true;
  state.settingsFeedback = null;
  renderSettingsFeedbackInPlace();
  setSettingsFormSaving(form, true);
  try {
    const result = await postJson("/api/settings-config", {
      section,
      saveTarget: state.settingsSaveTarget,
      sessionId: state.currentSessionId || null,
      settings,
      changedFields
    });
    if (!result.ok) throw new Error(result.error ?? "设置保存失败");
    state.settings = normalizeDashboardSettings(result.settings);
    state.applyAgentDefaultsOnSwitch = state.settings.agents.syncModelTiersOnSwitch;
    state.goal.maxAutoContinues = state.settings.agents.goalMaxAutoContinues;
    state.settingsFeedback = { tone: "success", message: "设置已保存" };
    state.settingsSaving = false;
    if (els.settingsBack) els.settingsBack.disabled = false;
    if (result.sessionStatus) updateSessionStatus(result.sessionStatus);
    else renderSettingsView();
    announceStatus("设置已保存");
  } catch (error) {
    state.settingsFeedback = { tone: "error", message: error instanceof Error ? error.message : "设置保存失败" };
    state.settingsSaving = false;
    setSettingsFormSaving(form, false);
    renderSettingsFeedbackInPlace();
    announceStatus(state.settingsFeedback.message);
  }
}

/** @param {any} event */
export async function handleSettingsClick(event: Event) {
  const scheduleButton = eventTargetOf(event).closest("button[data-schedule-action]");
  if (scheduleButton instanceof HTMLButtonElement && state.settingsSection === "schedules") {
    const id = scheduleButton.dataset.scheduleId ?? "";
    const scheduleAction = scheduleButton.dataset.scheduleAction ?? "";
    if (scheduleAction === "delete") await deleteJson(`/api/schedules/${encodeURIComponent(id)}`);
    else await postJson(`/api/schedules/${encodeURIComponent(id)}/${scheduleAction}`, {});
    await loadSchedules();
    return;
  }
  const action = eventTargetOf(event).closest("[data-action]");
  if (!action) return;
  if (action.dataset.action === "select-default-scope") {
    state.modelDefaultScope = configScope(action.dataset.scope, "project");
    state.settingsFeedback = null;
    renderSettingsView();
  } else if (action.dataset.action === "select-source-credential") {
    state.settingsRefreshing = true;
    try {
      const result = await postJson("/api/settings-config", { section: "source-credential", settings: { profileId: action.dataset.profileId }, saveTarget: state.modelDefaultScope, sessionId: state.currentSessionId || undefined });
      if (!result.ok) throw new Error(result.error || "切换凭据失败");
      state.settingsRefreshing = false;
      await refreshSettingsConfiguration();
    } catch (error) {
      state.settingsFeedback = { tone: "error", message: errorMessageOf(error) };
    } finally {
      state.settingsRefreshing = false;
      renderSettingsView();
    }
  } else if (action.dataset.action === "inspect-profile") {
    state.settingsProviderId = action.dataset.profileId || "";
    state.deleteConfirmModelKey = "";
    state.settingsFeedback = null;
    renderSettingsView();
  } else if (action.dataset.action === "import-custom-source") {
    const url = (document.querySelector("#custom-source-url") as HTMLInputElement | null)?.value.trim() ?? "";
    const protocol = (document.querySelector("#custom-source-protocol") as HTMLSelectElement | null)?.value ?? "openai-chat";
    const apiKey = (document.querySelector("#custom-source-key") as HTMLInputElement | null)?.value.trim() ?? "";
    await importModelSource({ kind: "custom", gatewayUrl: url, gatewayProtocol: protocol, gatewayApiKey: apiKey, activateFirst: false });
  } else if (action.dataset.action === "refresh-source") {
    const profile = (state.gatewayProfiles ?? []).find((item) => item.id === action.dataset.profileId);
    await importModelSource({
      kind: "refresh",
      providerId: action.dataset.profileId,
      profileId: action.dataset.profileId,
      saveTarget: profile?.saveTarget === "project" ? "project" : profile?.saveTarget === "global" ? "global" : undefined,
      activateFirst: false
    });
  } else if (action.dataset.action === "add-source") {
    showModelConfigPanel("", "", "add-source");
  } else if (action.dataset.action === "add-model") {
    showModelConfigPanel("", action.dataset.profileId || settingsInspectedGatewayProfile()?.id || "", "add-model");
  } else if (action.dataset.action === "edit-model") {
    showModelConfigPanel(action.dataset.modelId, action.dataset.profileId, "edit-model");
  } else if (action.dataset.action === "edit-gateway-profile") {
    showModelConfigPanel("", action.dataset.profileId, "edit-profile");
  } else if (action.dataset.action === "use-model") {
    await saveDefaultModelSelection(
      action.dataset.modelId,
      action.dataset.profileId || currentGatewayProfile()?.id || "",
      state.modelDefaultScope
    );
  } else if (action.dataset.action === "use-profile") {
    const profile = (state.gatewayProfiles ?? []).find((item) => item.id === action.dataset.profileId);
    await saveDefaultModelSelection(
      profile?.modelAlias || profile?.models?.[0]?.id || "",
      profile?.id || "",
      state.modelDefaultScope
    );
  } else if (action.dataset.action === "delete-model") {
    await deleteModel(action.dataset.modelId, {
      profileId: action.dataset.profileId,
      saveTarget: action.dataset.saveTarget
    });
  } else if (action.dataset.action === "delete-gateway-profile") {
    await deleteGatewayProfile(action.dataset.profileId);
  }
}

/** @param {string} protocol */
export function protocolDisplayName(protocol: string | null | undefined) {
  if (protocol === "openai-responses") return "OpenAI Responses";
  if (protocol === "anthropic-messages") return "Anthropic Messages";
  return "OpenAI Chat Completions";
}

/** @param {string} name @param {string} label @param {unknown} value */
export function agentModelPickerHtml(name: string, label: string, value: unknown) {
  const modelId = String(value ?? "").trim();
  const inputId = `agent-model-${name}`;
  const selectId = `${inputId}-select`;
  return `
    <div class="agent-model-picker" data-agent-model-picker data-saved-model-id="${escapeAttribute(modelId)}">
      <label for="${escapeAttribute(selectId)}">${escapeHtml(label)}</label>
      <select id="${escapeAttribute(selectId)}" data-agent-model-select="${escapeAttribute(name)}" aria-controls="${escapeAttribute(inputId)}">
        <option value=""${modelId ? "" : " selected"}>未指定</option>
        ${modelId ? `<option value="${escapeAttribute(modelId)}" selected>${escapeHtml(modelId)}（已保存 · 等待目录核对）</option>` : ""}
        <option value="${MANUAL_AGENT_MODEL_VALUE}">手工输入 ID...</option>
      </select>
      <input class="agent-model-manual-input hidden" id="${escapeAttribute(inputId)}" name="${escapeAttribute(name)}" aria-label="${escapeAttribute(`${label} 手工模型 ID`)}" spellcheck="false" value="${escapeAttribute(modelId)}" placeholder="输入精确模型 ID" />
      <small class="agent-model-picker-status">${modelId ? "已保存，等待目录核对" : "未指定"}</small>
    </div>
  `;
}

export function renderModelConfigPanel() {
  if (!els.modelConfigPanel) {
    return;
  }
  els.modelConfigPanel.classList.toggle("hidden", !state.modelConfigOpen);
  if (!state.modelConfigOpen) {
    els.modelConfigPanel.replaceChildren();
    return;
  }
  const editingProfile = gatewayProfileById(state.editingGatewayProfileId);
  const editing = state.editingModelId
    ? editingProfile?.models?.find((model) => model.id === state.editingModelId) ?? currentModelInfo(state.editingModelId)
    : null;
  const addingSource = state.modelConfigIntent === "add-source";
  const editingChannel = state.modelConfigIntent === "edit-profile";
  const channelForm = addingSource || editingChannel;
  const addingModel = state.modelConfigIntent === "add-model";
  const current: DashboardModelOption = editing ?? { id: "" };
  const gateway: DashboardGatewayConfig = editingProfile ? {
    ...(state.gatewayConfig ?? {
      gatewayUrl: "",
      gatewayHealthUrl: "",
      gatewayProtocol: "openai-chat",
      apiKeyConfigured: false,
      activeProfileId: "",
      globalSettingsPath: "",
      projectSettingsPath: "",
      globalConfigPath: "",
      projectConfigPath: "",
      sources: {
        gatewayUrl: { type: "", label: "" },
        gatewayHealthUrl: { type: "", label: "" },
        gatewayProtocol: { type: "", label: "" },
        apiKey: { type: "", label: "" }
      }
    }),
    gatewayUrl: String(editingProfile.gatewayUrl ?? ""),
    gatewayHealthUrl: String(editingProfile.gatewayHealthUrl ?? ""),
    gatewayProtocol: String(editingProfile.gatewayProtocol ?? "openai-chat"),
    apiKeyConfigured: Boolean(editingProfile.apiKeyConfigured)
  } : addingSource || !state.gatewayConfig ? {
    gatewayUrl: "",
    gatewayHealthUrl: "",
    gatewayProtocol: "openai-chat",
    apiKeyConfigured: false,
    activeProfileId: "",
    globalSettingsPath: "",
    projectSettingsPath: "",
    globalConfigPath: "",
    projectConfigPath: "",
    sources: {
      gatewayUrl: { type: "", label: "" },
      gatewayHealthUrl: { type: "", label: "" },
      gatewayProtocol: { type: "", label: "" },
      apiKey: { type: "", label: "" }
    }
  } : state.gatewayConfig;
  const gatewayProtocol = gateway.gatewayUrl ? gateway.gatewayProtocol : "openai-chat";
  const sourceNote = gatewaySourceNote(gateway);
  const keySource = editingProfile ? "该网关档案" : sourceLabel(gateway.sources?.apiKey);
  const gatewayDefaultNote = environmentGatewayDefaultNote(gateway);
  const modelSaveTarget = modelSourceOf(editing)?.saveTarget;
  const saveTarget = modelSaveTarget
    ? modelSaveTarget
    : editingProfile
      ? editingProfile.saveTarget === "global" ? "global" : "project"
    : gateway.sources?.gatewayUrl?.type === "project" ? "project" : "global";
  const lockedSaveTarget = modelSaveTarget === "project" || modelSaveTarget === "global"
    ? modelSaveTarget
    : editingProfile?.saveTarget === "project" || editingProfile?.saveTarget === "global"
      ? editingProfile.saveTarget
      : "";
  const profileAgentTiers = addingSource ? {} : editingProfile?.agentModelTiers ?? state.agentModelTiers ?? {};
  const currentAgentTiers = {
    cheap: current.agentModelTiers?.cheap ?? profileAgentTiers.cheap ?? "",
    default: current.agentModelTiers?.default ?? profileAgentTiers.default ?? "",
    strong: current.agentModelTiers?.strong ?? profileAgentTiers.strong ?? ""
  };
  const visionAgentModel = editingProfile
    ? editingProfile.visionAgent?.model ?? ""
    : addingSource
      ? ""
      : state.visionAgent?.model ?? firstVisionModelId() ?? "";
  const currentEfforts = normalizeReasoningEfforts(current.reasoningEfforts);
  const selectedEffortIds = new Set(currentEfforts.map((effort: DashboardReasoningEffort) => effort.id));
  const effortChoices = reasoningEffortCatalog(currentEfforts);
  const defaultReasoningEffort = configuredReasoningEffort(current.defaultReasoningEffort, currentEfforts);
  const panelKicker = addingSource
    ? "模型来源"
    : addingModel
      ? editingProfile?.label || "当前来源"
      : "模型配置";
  const panelTitle = addingSource
    ? "添加模型来源"
    : editingChannel
      ? "编辑模型来源"
      : addingModel
        ? "添加模型"
        : "编辑模型";
  els.modelConfigPanel.innerHTML = `
    <button class="model-config-backdrop" type="button" data-action="close-model-config" aria-label="关闭模型配置"></button>
    <form class="model-config-card" id="model-config-form">
      <div class="model-config-head">
        <div>
          <div class="model-config-kicker">${escapeHtml(panelKicker)}</div>
          <h2 id="model-config-title">${escapeHtml(panelTitle)}</h2>
        </div>
        <button class="icon-button" type="button" data-action="close-model-config" title="关闭">×</button>
      </div>
      <fieldset class="model-config-scope" aria-label="保存范围">
        <legend>保存范围</legend>
        <label>
          <input name="saveTarget" type="radio" value="project"${saveTarget === "project" ? " checked" : ""}${lockedSaveTarget === "global" ? " disabled" : ""} />
          <span>
            <strong>当前项目默认</strong>
            <small>${escapeHtml(state.configPaths.project || ".lab-agent/settings.json")}，优先于全局默认</small>
          </span>
        </label>
        <label>
          <input name="saveTarget" type="radio" value="global"${saveTarget === "global" ? " checked" : ""}${lockedSaveTarget === "project" ? " disabled" : ""} />
          <span>
            <strong>全局默认</strong>
            <small>${escapeHtml(state.configPaths.global || gateway.globalSettingsPath || gateway.globalConfigPath || "用户级 settings.json")}，新项目自动使用</small>
          </span>
        </label>
        ${lockedSaveTarget ? `<p class="model-config-scope-note">已有档案需保存回所属的${lockedSaveTarget === "global" ? "全局" : "项目"}配置。</p>` : ""}
      </fieldset>
      <div class="model-config-grid">
        ${channelForm ? `<label>
          <span>路线名</span>
          <input name="routeName" required maxlength="64" spellcheck="false" placeholder="例如 work、personal" />
          <small class="gateway-url-hint">同一地址的不同密钥请用不同路线名，例如 work、personal。聊天里按这个名字切换。</small>
        </label>` : ""}
        <label>
          <span>网关 URL</span>
          <input name="gatewayUrl" type="url" required spellcheck="false" value="${escapeAttribute(gateway.gatewayUrl || "")}" placeholder="${escapeAttribute(gatewayUrlPlaceholder(gatewayProtocol))}" />
          <small class="gateway-url-hint">${escapeHtml(gatewayUrlHint(gatewayProtocol))}</small>
        </label>
        <label>
          <span>协议</span>
          <select name="gatewayProtocol">
            <option value="openai-chat"${gatewayProtocol === "openai-chat" ? " selected" : ""}>OpenAI Chat Completions</option>
            <option value="openai-responses"${gatewayProtocol === "openai-responses" ? " selected" : ""}>OpenAI Responses</option>
            <option value="anthropic-messages"${gatewayProtocol === "anthropic-messages" ? " selected" : ""}>Anthropic Messages (Claude)</option>
          </select>
        </label>
        <label>
          <span>API Key</span>
          <input name="gatewayApiKey" type="password" autocomplete="new-password" spellcheck="false" data-key-configured="${gateway.apiKeyConfigured ? "true" : "false"}" data-keep-placeholder="${escapeAttribute(gateway.apiKeyConfigured ? `已配置，来自${keySource}，留空则保留` : "可选")}" placeholder="${escapeAttribute(gateway.apiKeyConfigured ? `已配置，来自${keySource}，留空则保留` : "可选")}" />
        </label>
        <label>
          <span>健康检查 URL</span>
          <input name="gatewayHealthUrl" type="url" spellcheck="false" value="${escapeAttribute(gateway.gatewayHealthUrl || "")}" placeholder="可选" />
        </label>
        <div class="gateway-probe-row">
          <button type="button" data-action="probe-gateway" ${state.gatewayProbeRunning ? "disabled" : ""}>${state.gatewayProbeRunning ? "连接中" : channelForm ? "读取全部模型" : "测试连接 / 发现模型"}</button>
          <div class="gateway-probe-result" id="gateway-probe-result" aria-live="polite"></div>
        </div>
        ${channelForm ? `<p class="model-config-scope-note">保存时会写入这次读到的全部模型。子智能体只从这些模型里选，不需要再指定渠道。</p>` : `<label>
          <span>模型 ID</span>
          <input name="modelId" required spellcheck="false" value="${escapeAttribute(current.id || "")}" placeholder="example-coding-model" />
        </label>`}
        ${channelForm ? "" : `<label>
          <span>模型备注</span>
          <input name="label" maxlength="160" spellcheck="false" value="${escapeAttribute(current.label === current.id ? "" : current.label || "")}" placeholder="例如：科研分析、代码开发" />
        </label>
        <div class="model-capability-status" id="model-id-capability-status" aria-live="polite"></div>
        <label>
          <span>上下文窗口</span>
          <input name="contextTokens" inputmode="numeric" pattern="[0-9]*" value="${escapeAttribute(current.contextTokens || "")}" placeholder="例如 400000" />
        </label>`}
      </div>
      <fieldset class="agent-model-config">
        <legend>子智能体模型</legend>
        <span class="agent-model-catalog-status" id="agent-model-catalog-status" aria-live="polite">目录未读取</span>
        <div class="agent-model-picker-grid">
          ${agentModelPickerHtml("agentCheapModel", "cheap", currentAgentTiers.cheap)}
          ${agentModelPickerHtml("agentDefaultModel", "default", currentAgentTiers.default)}
          ${agentModelPickerHtml("agentStrongModel", "strong", currentAgentTiers.strong)}
          ${agentModelPickerHtml("visionAgentModel", "vision", visionAgentModel)}
        </div>
      </fieldset>
      ${channelForm ? "" : `<fieldset class="model-reasoning-config" data-reasoning-mode="${state.modelConfigReasoningLocked ? "manual" : "auto"}" data-reasoning-source="${escapeAttribute(state.modelConfigReasoningSource)}">
        <legend>思考强度</legend>
        <div class="model-reasoning-discovery">
          <span class="model-reasoning-status" id="reasoning-capability-status" role="status" aria-live="polite"></span>
          <div class="model-reasoning-discovery-actions">
            <button class="hidden" type="button" data-action="apply-reasoning-capabilities">使用发现值</button>
            <button type="button" data-action="detect-reasoning-capabilities" title="发送最小模型请求检测可用档位，可能产生少量用量"${!current.id || state.modelCapabilityProbeRunning ? " disabled" : ""}>${state.modelCapabilityProbeRunning ? "检测中" : "检测档位"}</button>
          </div>
        </div>
        <div class="model-reasoning-options">
          ${effortChoices.map((effort: DashboardReasoningEffort) => `
            <label>
              <input name="reasoningEfforts" type="checkbox" value="${escapeAttribute(effort.id)}" data-effort-label="${escapeAttribute(effort.label)}"${selectedEffortIds.has(effort.id) ? " checked" : ""} />
              <span>${escapeHtml(effort.label)}</span>
            </label>
          `).join("")}
        </div>
        <label class="model-reasoning-default">
          <span>模型默认强度</span>
          <select name="defaultReasoningEffort" ${selectedEffortIds.size === 0 ? "disabled" : ""}>
            <option value="">未指定</option>
            ${effortChoices.filter((effort: DashboardReasoningEffort) => selectedEffortIds.has(effort.id)).map((effort: DashboardReasoningEffort) => `<option value="${escapeAttribute(effort.id)}"${defaultReasoningEffort === effort.id ? " selected" : ""}>${escapeHtml(effort.label)}</option>`).join("")}
          </select>
        </label>
      </fieldset>`}
      <div class="model-config-toggles">
        ${channelForm ? "" : `<label><input name="text" type="checkbox" checked disabled /> 文本</label>
        <label class="model-vision-toggle"><input name="vision" type="checkbox"${Array.isArray(current.modalities) && current.modalities.includes("image") || inferModelSupportsImages(current.id) ? " checked" : ""} /> 视觉<span class="model-capability-status" aria-live="polite"></span></label>
        <label><input name="thinking" type="checkbox"${current.thinking ? " checked" : ""} /> thinking</label>`}
        <label><input name="clearGatewayApiKey" type="checkbox"${gateway.apiKeyConfigured ? "" : " disabled"} /> 清除已保存 Key</label>
        ${channelForm ? "" : `<label><input name="switchToModel" type="checkbox"${editing && !current.default ? "" : " checked"} /> 保存为该范围默认模型</label>
        <label><input name="applyAgentDefaults" type="checkbox" /> 保存后同步子智能体</label>`}
      </div>
      <div class="model-config-note">
        <div>${escapeHtml(sourceNote)}</div>
        ${gatewayDefaultNote ? `<div>${escapeHtml(gatewayDefaultNote)}</div>` : ""}
        <div>保存为当前项目默认会覆盖本文件夹；保存为全局默认会作为新项目兜底。Key 不会在这里回显。</div>
      </div>
      <div class="model-config-feedback hidden" role="alert" aria-live="assertive"></div>
      <div class="model-config-actions">
        <button type="button" data-action="close-model-config">取消</button>
        <button type="submit" ${state.modelConfigSaving ? "disabled" : ""}>${state.modelConfigSaving ? "保存中" : channelForm ? "保存来源" : "保存"}</button>
      </div>
    </form>
  `;
  initializeAgentModelPickerSnapshot(els.modelConfigPanel.querySelector("#model-config-form"));
  renderGatewayProbeResult();
  renderReasoningCapabilityStatus();
}

/** @param {any} event */
export async function handleModelConfigPanelClick(event: Event) {
  const action = eventTargetOf(event).closest("button[data-action]");
  if (action?.dataset.action === "close-model-config") {
    hideModelConfigPanel();
  } else if (action?.dataset.action === "probe-gateway") {
    await probeGateway(action.closest("form"));
  } else if (action?.dataset.action === "select-probed-model") {
    applyProbedModel(action);
  } else if (action?.dataset.action === "use-suggested-gateway-url") {
    applySuggestedGatewayUrl(action);
  } else if (action?.dataset.action === "detect-reasoning-capabilities") {
    await probeModelCapabilities(action.closest("form"));
  } else if (action?.dataset.action === "apply-reasoning-capabilities") {
    applyPendingReasoningCapabilities(action.closest("form"));
  }
}

/** @param {any} event */
export function handleModelConfigInput(event: Event) {
  const target = event.target;
  const form = target?.closest?.("form");
  if (!target || !form) return;
  if (target.matches("input[name='gatewayUrl']")) {
    markModelConfigEndpointChanged(form);
    return;
  }
  if (target.matches("input[name='gatewayApiKey']")) {
    markModelConfigCredentialChanged(form);
    return;
  }
  if (target.matches("input[name='modelId']")) {
    handleModelConfigModelIdChanged(form);
    return;
  }
  if (target.matches(".agent-model-manual-input")) {
    const picker = target.closest(".agent-model-picker");
    if (picker) {
      picker.dataset.manualActive = "true";
      picker.dataset.modelSnapshot = modelConfigAgentModelsSnapshot(form);
      updateAgentModelPickerManualStatus(picker, target.value);
    }
  }
}

/** @param {any} event */
export function handleModelConfigChange(event: Event) {
  if (eventTargetOf(event).matches("select[data-agent-model-select]")) {
    handleAgentModelSelection(event.target);
  } else if (eventTargetOf(event).matches(".agent-model-manual-input")) {
    renderAgentModelPickers(eventTargetOf(event).closest("form"));
  } else if (eventTargetOf(event).matches("input[name='reasoningEfforts']")) {
    markReasoningCapabilityManual();
    syncReasoningDefaultOptions(eventTargetOf(event).closest("form"));
    renderReasoningCapabilityStatus();
  } else if (eventTargetOf(event).matches("select[name='defaultReasoningEffort'], input[name='thinking']")) {
    markReasoningCapabilityManual();
    renderReasoningCapabilityStatus();
  } else if (eventTargetOf(event).matches("select[name='gatewayProtocol']")) {
    markModelConfigEndpointChanged(eventTargetOf(event).closest("form"));
    syncGatewayUrlHint(eventTargetOf(event).closest("form"), eventTargetOf(event).value);
  } else if (eventTargetOf(event).matches("input[name='saveTarget']")) {
    state.modelCapabilityDiscoveryToken = "";
  } else if (eventTargetOf(event).matches("input[name='gatewayApiKey']") && eventTargetOf(event).value.trim()) {
    const keyInput = eventTargetOf(event);
    const clear = (keyInput instanceof HTMLInputElement ? keyInput.form : keyInput.closest("form"))?.querySelector("input[name='clearGatewayApiKey']");
    if (clear) clear.checked = false;
  } else if (eventTargetOf(event).matches("input[name='clearGatewayApiKey']")) {
    markModelConfigCredentialChanged(eventTargetOf(event).closest("form"));
    const clearInput = eventTargetOf(event);
    const key = (clearInput instanceof HTMLInputElement ? clearInput.form : clearInput.closest("form"))?.querySelector("input[name='gatewayApiKey']");
    if (key) {
      if (eventTargetOf(event).checked) key.value = "";
      key.disabled = eventTargetOf(event).checked;
    }
  }
}

/** @param {HTMLFormElement | null} form */
export function markModelConfigCredentialChanged(form: HTMLElement | null) {
  state.modelConfigCredentialRevision += 1;
  cancelScopedRequest("gateway-probe");
  cancelScopedRequest("model-capabilities-probe");
  state.gatewayProbeRunning = false;
  state.modelCapabilityProbeRunning = false;
  state.modelCapabilityProbeError = "";
  state.modelCapabilityDiscoveryToken = "";
  state.gatewayProbeResult = null;
  state.gatewayProbeError = "";
  state.modelConfigReasoningCandidate = null;
  renderGatewayProbeResult({ preserveAgentModels: true });
  renderReasoningCapabilityStatus();
}

/**
 * @param {HTMLFormElement | null} form
 * @param {{
 *   preserveGatewayResult?: boolean,
 *   preserveReasoning?: boolean,
 *   retainedAgentModelIds?: string[]
 * }} [options]
 */
