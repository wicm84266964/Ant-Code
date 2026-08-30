import { renderMarkdown } from "./markdown.ts";
import { hydrateRichContent } from "./rich-renderers.ts";
import { visibleTranscriptRole } from "./transcript.ts";
import { MANUAL_AGENT_MODEL_VALUE, state, els, MODE_DESCRIPTIONS, LOCAL_FILE_EXTENSIONS, FILE_REFERENCE_PATTERN, TRANSCRIPT_DOM_LIMIT, EVENT_STALE_AFTER_MS, EVENT_CONNECT_TIMEOUT_MS, EVENT_RECONNECT_MAX_ATTEMPTS, DASHBOARD_REQUEST_TIMEOUT_MS, DASHBOARD_API_VERSION, DASHBOARD_LIFECYCLE_TIMEOUT_MS, DASHBOARD_SHUTDOWN_TIMEOUT_MS, DASHBOARD_INTERRUPT_TIMEOUT_MS, MAX_IMAGE_ATTACHMENTS, MAX_IMAGE_ATTACHMENT_BYTES, CURRENT_SESSION_STORAGE_KEY, DASHBOARD_CLIENT_STORAGE_KEY, PREVIEW_WIDTH_STORAGE_KEY, PREVIEW_WIDTH_DEFAULT, PREVIEW_WIDTH_MIN, PREVIEW_WIDTH_MAX, PREVIEW_WORKSPACE_MIN , emptySessionStatus, emptyBackgroundSubagent } from "./app-core.ts";
import type { DashboardConfigSource, DashboardReasoningEffort, DashboardTurnChangeStats, DashboardScopedDefaultSelection, DashboardVisionAgent, DashboardReasoningDiscovery, DashboardReasoningCapabilityCandidate, DashboardGatewayProbeModel, DashboardGatewayProbeResult, DashboardLifecycleActivity, DashboardSettings, DashboardFile, DashboardTableSheet, DashboardTablePreview, DashboardLightboxItem, DashboardQuestionChoice, DashboardPendingQuestion, DashboardApproval, DashboardGatewayTransport, DashboardScopedRequest, DashboardFetchOptions, DashboardModelSource, DashboardSessionStatus, DashboardApiResult, DashboardActivity, DashboardModelOption, DashboardGatewayProfile, DashboardGatewayConfig, DashboardModelSelection, DashboardPendingGuide, DashboardStreamEvent, DashboardUiState , DashboardSessionSummary } from "./app-core.ts";
import { eventTargetOf, eventElement, isPlainObject, modelSourceOf, errorMessageOf, init, bootstrapDashboard, observeRunStatus, updateRunStatusTone, bindEvents, normalizedResponsiveView, composerHeightFor, previewWidthBounds, clampedPreviewWidth, permissionIndexForKey, focusTrapTarget, shouldFollowTranscript, scheduleAnimationFrameOnce, cancelScheduledAnimationFrame, appendPlainDraftDelta, renderFinalAssistantBody, selectTranscriptNodesToRemove, responsiveLayoutMode, restorePreviewWidth, setPreviewWidth, syncPreviewResizeHandle, beginPreviewResize, updatePreviewResize, finishPreviewResize, handlePreviewResizeKeydown, setResponsiveView, syncResponsiveNavigation, setResponsiveSurfaceInert, handleResponsiveFileNavigation, syncVisualViewport, resizePromptInput, handlePermissionModeKeydown, requestPermissionMode, defaultGoalMaxAutoContinues, emptyGoalSnapshot, applyGoalSnapshot, renderGoalControls, renderGoalStatusBar, requestGoalMode, showGoalConfirm, hideGoalConfirm, showGoalTextPanel, hideGoalTextPanel, enableGoalWithObjective, submitGoalAction, adoptGoalRunResult, showPermissionConfirm, hidePermissionConfirm, updateContextActions, announceStatus, modalFocusableElements, activateModal, collectModalBackground, focusModalInitialTarget, deactivateModal, restoreModalAttribute, handleGlobalKeydown, closeActiveModal, loadTrust, loadSessions, restoreInitialSession, latestBackgroundSessionId, initialSessionId, rememberCurrentSession, renderSessions, sessionMeta, sessionStatusView, toggleSidebar, setSidebarCollapsed, sessionsNeedRefresh, scheduleSessionsRefresh, handleSessionAction, openSession, restoreBackgroundSnapshot, deleteSession, setSessionsRefreshState, copySessionId, newTask, rememberNewTaskModelState, restoreNewTaskModelState, refreshNewTaskModelState, addAttachmentFiles, readImageAttachment, renderAttachmentStrip, attachmentPayload, clearAttachments, sendPrompt, stableTurnRequest, dashboardRequestId, dashboardClientId, statusUrl, interruptTurn, guideTurn, cancelQueuedTurn, cancelBackgroundSubagent, backgroundCancelKey, connectEvents, ensureEventsConnected, disconnectEvents, closeEventSource, markEventConnectionAlive, armEventConnectTimer, armEventStaleTimer, scheduleEventReconnect, reconnectEventsManually, clearEventReconnectTimer, clearEventConnectTimer, clearEventStaleTimer, setConnectionState, resetEventReplayState, rememberEventCursor, handleDashboardEvent, shouldSkipDashboardEvent, beginEventTurn, renderTranscriptMessages, renderSessionFailure, setTranscriptPaging, renderTranscriptHistoryStatus, removeTranscriptHistoryStatus, transcriptFirstContentNode, handleTranscriptScroll, loadOlderTranscript, renderWorkflowPanel, renderWorkflowStrip, currentWorkflowItem, workflowSection, workflowItem, normalizeWorkflowStatus, summarizeWorkflow, appendMessage, createMessageNode, appendTranscriptNode, trimTranscriptWindow, isProtectedTranscriptNode, renderTranscriptWindowMarker, captureTranscriptViewportAnchor, restoreTranscriptViewportAnchor, transcriptNodeTop, restoreTranscriptNodeAnchor, resetTranscriptWindow, appendAssistantDraft, scheduleDraftRender, renderAssistantDraft, appendActivity, appendContextBoundary, contextBoundaryText, handleActivity, isBackgroundSubagentActivity, handleBackgroundSubagentActivity, clearBackgroundSubagentStatus, reconcileBackgroundSubagentSnapshot, backgroundSubagentDisplayStatus, backgroundSubagentVisible, updateLiveActivity, removeLiveActivity, setLiveTitle, toggleLiveStatusDetails, updateLiveStatus, liveStatusTitle, primaryLiveActivity, gatewayRetryChipText, renderBackgroundSubagentStatus, backgroundSubagentCompactLabel, backgroundSubagentTitle, backgroundSubagentMeta, backgroundSubagentCancellable, resetLiveStatus, backgroundSubagentCounts, idleRunStatus, applyIdleRunStatus, updateRunStatusForBackground, updateSessionStatus, updateTurnChangeStats, resetTurnChangeStats, normalizeChangeStats, renderComposerStatus, modelStatusHtml, unresolvedModelStatusHtml, handleModelStatusActivate, handleModelStatusKeydown, toggleModelPanel, hideModelPanel, showSettingsWorkspace, refreshSettingsConfiguration, hideSettingsWorkspace, showModelConfigPanel, hideModelConfigPanel, renderModelPanel, modelCapabilityLabels, handleModelPanelClick, handleModelPanelChange, renderSettingsView, syncSettingsRail, modelSettingsHtml, transcriptSettingsHtml, transcriptRetentionOptionsHtml, networkSettingsHtml, networkModeOptionHtml, agentSettingsHtml, reliabilitySettingsHtml, settingsSectionHeading, settingsToggleHtml, managedFieldHtml, settingsDisabled, settingsFormActions, settingsFeedbackHtml, settingsGatewayProfileHtml, gatewayProfileReadonlyLabel, providerModelKey, scopedDefaultModelLabel, settingsModelHtml, handleSettingsRailClick, initializeSettingsFormTracking, handleSettingsFormChange, settingsControlValue, changedSettingsFields, canonicalSettingsField, setSettingsFormSaving, renderSettingsFeedbackInPlace, saveSettingsConfig, handleSettingsClick, protocolDisplayName, agentModelPickerHtml, renderModelConfigPanel, handleModelConfigPanelClick, handleModelConfigInput, handleModelConfigChange, markModelConfigCredentialChanged, saveModelConfig, saveDefaultModelSelection, switchModel, handleReasoningEffortChange, switchReasoningEffort, deleteGatewayProfile, deleteModel, updateConfigRevisions, normalizeScopedDefaultSelection, configScope, configMutationMetadata, isConfigRevisionConflict, configRevisionConflictMessage, refreshConfigRevisionsAfterConflict, normalizeGatewayConfig, normalizeDashboardSettings, mergeGatewayConfig, normalizeGatewayProfiles, normalizeConfigSource, normalizeModels, normalizeModelSource, normalizeReasoningEfforts, normalizedReasoningEffort, isDisabledReasoningEffort, configuredReasoningEffort, reasoningEffortFallbackLabel, localizedReasoningEffortLabel, reasoningEffortCatalog, reasoningEffortLabel, resolveAtomicModelSelection, currentModelSelection, currentSessionNeedsModelSelection, currentGatewayProfile, gatewayProfileById, settingsInspectedGatewayProfile, modelSourceLabel, markCurrentModel, currentModelInfo, modelDisplayName, normalizeAgentModelTiers, normalizeVisionAgent, firstVisionModelId, hasAgentModelTiers, agentModelTiersSummary, gatewaySummary, modelSaveTargetLabel, gatewaySourceNote, environmentGatewayDefaultNote, sourceBadge, sourceLabel, formatContextUsage, firstFiniteNumber, formatTokenCount, trimNumber, nonNegativeInteger, collapseCompletedActivities, clearAssistantDrafts, collapseAssistantDrafts, isMeaningfulCompletedActivity, isDuplicateDraftText, normalizeComparableText, showApproval, resolveApproval, hideApproval, showQuestion, revealInteractionPanel, renderQuestionPanel, reviewQuestionConversation, returnToQuestion, activateQuestionReviewBackground, deactivateQuestionReviewBackground, questionChoiceButton, toggleQuestionChoice, submitQuestion, cancelQuestion, finishQuestionSubmission, hideQuestion, showTrustPanel, renderTrustPanel, confirmTrust, renderQueuePanel, renderQueueItem, setPendingGuide, clearPendingGuide, syncPendingGuideFromQueue, renderGuideFeedback, guideCopy, guideSource, guideTurnFromQueue, guideButtonText, guideButtonDisabled, guideButtonVisible, syncGuideButton, shouldKeepGuideFeedback, isInterruptError, updateSendButton, showContextConfirm, hideContextConfirm, runContextAction, contextActionRequestOptions, contextSummaryLine, compactResultLine, rememberQuestionDraft, questionResolutionText, showShutdownPanel, hideShutdownPanel, shutdownDashboard, lockClosedDashboard, normalizeLifecycleActivity, shutdownRequestBody, shutdownResultIsClosed, lifecycleActivitySummary, renderShutdownActivity, renderFiles, currentImageFiles, openFile, renderOfficePreview, officePreviewMeta, officePreviewBodyHtml, renderTablePreview, normalizeTablePreview, tablePreviewMeta, renderCompactTableHtml, renderExpandedTableHtml, renderTableHtml, tableTruncationNote, maxVisibleColumns, columnLabel, renderSheetPreviewHtml, renderSheetCellHtml, resetPreview, fencedDataForFile, dataLanguageForExtension, showImageLightbox, showTableLightbox, renderLightboxImage, bindTableLightboxControls, moveLightbox, hideLightbox, setPermissionMode, clearTranscript, cancelTranscriptAnimationFrames, clearAssistantDraftTimers, hideEmptyState, showError, showNotice, renderBootstrapLoading, renderBootstrapFailure, dashboardPayloadError, bootstrapFailurePresentation, clearBootstrapStatus, scrollTranscript, isTranscriptNearBottom, syncTranscriptFollowState, followTranscript, updateTranscriptJump, beginScopedRequest, isCurrentScopedRequest, finishScopedRequest, cancelScopedRequest, isAbortError, getJson, postJson, deleteJson, dashboardFetch, responseJson, dashboardJsonHeaders, dashboardCsrfToken, messageText, messageDisplayText, userMessageDisplayText, normalizeAttachmentMetadata, imageAttachmentLine, renderMessageText, renderLinkedText, bindRichContent, linkifyFileTextNodes, replaceFileReferences, isLikelyLocalFileReference, resolveDisplayFilePath, normalizeFileReferencePath, parentDirectory, filePreviewUrl, rawFileUrl, apiFileUrl, imagePreviewUrl, isSafeInlineBitmapUrl, normalizeRelativePath, isWorkspaceRelativeToBase, copyCodeBlock, previewText, formatNumber, formatBytes, escapeHtml, escapeAttribute, formatTime, formatRelativeTime } from "./app-barrel.ts";
export function markModelConfigEndpointChanged(form: HTMLElement | null, options: {
  preserveGatewayResult?: boolean,
  preserveReasoning?: boolean,
  retainedAgentModelIds?: string[]
} = {}) {
  state.modelConfigEndpointRevision += 1;
  syncAgentModelPickersForEndpoint(form, {
    retainedCatalogModelIds: options.retainedAgentModelIds
  });
  cancelScopedRequest("gateway-probe");
  cancelScopedRequest("model-capabilities-probe");
  state.gatewayProbeRunning = false;
  state.modelCapabilityProbeRunning = false;
  state.modelCapabilityProbeError = "";
  state.modelCapabilityDiscoveryToken = "";
  if (options.preserveGatewayResult !== true) {
    state.gatewayProbeResult = null;
    state.gatewayProbeError = "";
  }
  if (options.preserveReasoning !== true) {
    state.modelConfigReasoningCandidate = null;
    if (!state.modelConfigReasoningLocked) {
      state.modelConfigReasoningSource = "unknown";
      state.modelConfigReasoningDiscovery = null;
      clearReasoningCapabilityControls(form);
    }
  }
  renderGatewayProbeResult();
  renderReasoningCapabilityStatus();
}

/** @param {HTMLFormElement | null} form */
export function handleModelConfigModelIdChanged(form: HTMLElement | null) {
  cancelScopedRequest("model-capabilities-probe");
  state.modelCapabilityProbeRunning = false;
  state.modelCapabilityProbeError = "";
  state.modelCapabilityDiscoveryToken = "";
  state.modelConfigReasoningCandidate = null;
  if (!state.modelConfigReasoningLocked) {
    state.modelConfigReasoningSource = "unknown";
    state.modelConfigReasoningDiscovery = null;
    clearReasoningCapabilityControls(form);
  }
  const modelInput = /** @type {HTMLInputElement | null} */ (form?.querySelector("input[name='modelId']") ?? null);
  const modelId = String(modelInput?.value ?? "").trim();
  const discoveredModel = state.gatewayProbeResult?.models?.find((model) => model.id === modelId) ?? null;
  if (discoveredModel && applyGatewayDiscoveredModel(form, discoveredModel)) return;
  renderReasoningCapabilityStatus();
}

export function markReasoningCapabilityManual() {
  state.modelConfigReasoningEditRevision += 1;
  state.modelConfigReasoningLocked = true;
  state.modelConfigReasoningSource = "manual";
}

/** @param {HTMLFormElement | null} form */
export function clearReasoningCapabilityControls(form: HTMLElement | null) {
  if (!form) return;
  for (const input of /** @type {NodeListOf<HTMLInputElement>} */ (form.querySelectorAll("input[name='reasoningEfforts']"))) {
    input.checked = false;
  }
  syncReasoningDefaultOptions(form);
}

/** @param {any} form @param {string} protocol */
export function syncGatewayUrlHint(form: HTMLElement | null | undefined, protocol: string) {
  const input = form?.querySelector("input[name='gatewayUrl']");
  const hint = form?.querySelector(".gateway-url-hint");
  if (input) input.placeholder = gatewayUrlPlaceholder(protocol);
  if (hint) hint.textContent = gatewayUrlHint(protocol);
}

/** @param {string} protocol */
export function gatewayUrlPlaceholder(protocol: string) {
  if (protocol === "openai-responses") return "https://api.x.ai/v1/responses";
  if (protocol === "anthropic-messages") return "https://api.anthropic.com/v1/messages";
  return "https://example.com/v1/chat/completions";
}

/** @param {string} protocol */
export function gatewayUrlHint(protocol: string) {
  if (protocol === "openai-responses") return "填写完整请求地址，例如 /v1/responses";
  if (protocol === "anthropic-messages") return "填写完整请求地址，例如 /v1/messages";
  return "填写完整请求地址，例如 /v1/chat/completions";
}

/** @param {any} form */
export function syncReasoningDefaultOptions(form: HTMLElement | null | undefined) {
  const select = form?.querySelector("select[name='defaultReasoningEffort']");
  if (!form || !select) return;
  const previous = select.value;
  const efforts = Array.from(form.querySelectorAll("input[name='reasoningEfforts']:checked")).map((input) => ({
    id: input.value,
    label: input.dataset.effortLabel || input.value
  }));
  select.innerHTML = `<option value="">未指定</option>${efforts.map((effort) => `<option value="${escapeAttribute(effort.id)}">${escapeHtml(effort.label)}</option>`).join("")}`;
  select.disabled = efforts.length === 0;
  select.value = efforts.some((effort) => effort.id === previous) ? previous : "";
}

/** @param {any} form */
export async function probeGateway(form: HTMLElement | null | undefined) {
  if (!(form instanceof HTMLFormElement) || state.gatewayProbeRunning) return;
  const data = new FormData(form);
  const profile = gatewayProfileById(state.editingGatewayProfileId) ?? currentGatewayProfile();
  const credentialAction = gatewayCredentialAction(data, profile ?? state.gatewayConfig);
  const dialogGeneration = state.modelConfigDialogGeneration;
  const endpointRevision = state.modelConfigEndpointRevision;
  const credentialRevision = state.modelConfigCredentialRevision;
  const gatewayUrl = String(data.get("gatewayUrl") ?? "").trim();
  const gatewayProtocol = String(data.get("gatewayProtocol") ?? "").trim();
  const saveTarget = configScope(data.get("saveTarget"), "global") || "global";
  const request = beginScopedRequest("gateway-probe", `${dialogGeneration}:${endpointRevision}:${credentialRevision}`);
  state.gatewayProbeRunning = true;
  state.gatewayProbeResult = null;
  state.gatewayProbeError = "";
  state.modelCapabilityDiscoveryToken = "";
  renderGatewayProbeResult();
  try {
    const result = await postJson("/api/gateway-probe", {
      gatewayUrl: data.get("gatewayUrl"),
      gatewayProtocol: data.get("gatewayProtocol"),
      gatewayApiKey: data.get("gatewayApiKey"),
      credentialAction,
      clientId: dashboardClientId(),
      saveTarget,
      profileId: state.editingGatewayProfileId || "",
      previousGatewayUrl: profile?.gatewayUrl || state.gatewayConfig?.gatewayUrl || "",
      previousGatewayProtocol: profile?.gatewayProtocol || state.gatewayConfig?.gatewayProtocol || "openai-chat"
    }, { signal: request.signal });
    if (!isCurrentModelConfigRequest(request, form, dialogGeneration, endpointRevision, credentialRevision)) return;
    if (!result.ok) throw new Error(result.error ?? "连接测试失败");
    state.gatewayProbeResult = {
      message: String(result.message ?? result.probe?.message ?? "连接成功"),
      models: normalizeGatewayProbeModels(result.models ?? result.probe?.models),
      modelsUrl: String(result.modelsUrl ?? result.probe?.modelsUrl ?? ""),
      suggestedGatewayUrl: String(result.suggestedGatewayUrl ?? result.probe?.suggestedGatewayUrl ?? ""),
      discoveryToken: String(result.discoveryToken ?? result.probe?.discoveryToken ?? ""),
      dialogGeneration,
      endpointRevision,
      credentialRevision,
      gatewayUrl,
      gatewayProtocol,
      saveTarget
    };
    const currentModelId = String(form.querySelector("input[name='modelId']")?.value ?? "").trim();
    const discoveredModel = state.gatewayProbeResult.models?.find((model) => model.id === currentModelId) ?? null;
    if (discoveredModel) applyGatewayDiscoveredModel(form, discoveredModel);
  } catch (error) {
    if (!isAbortError(error) && isCurrentModelConfigRequest(request, form, dialogGeneration, endpointRevision, credentialRevision)) {
      state.gatewayProbeError = error instanceof Error ? error.message : "连接测试失败";
    }
  } finally {
    const current = isCurrentModelConfigRequest(request, form, dialogGeneration, endpointRevision, credentialRevision);
    if (current) state.gatewayProbeRunning = false;
    finishScopedRequest(request);
    if (current) renderGatewayProbeResult();
  }
}

/**
 * @param {any} request
 * @param {HTMLFormElement} form
 * @param {number} dialogGeneration
 * @param {number} endpointRevision
 * @param {number} credentialRevision
 */
export function isCurrentModelConfigRequest(request: DashboardScopedRequest, form: HTMLElement, dialogGeneration: number, endpointRevision: number, credentialRevision: number) {
  return isCurrentScopedRequest(request)
    && state.modelConfigOpen
    && state.modelConfigDialogGeneration === dialogGeneration
    && state.modelConfigEndpointRevision === endpointRevision
    && state.modelConfigCredentialRevision === credentialRevision
    && form.isConnected
    && form === els.modelConfigPanel?.querySelector("#model-config-form");
}

/** @param {HTMLFormElement | null} form */
export function currentGatewayProbeResult(form: HTMLElement | null) {
  const result = state.gatewayProbeResult;
  if (!(form instanceof HTMLFormElement) || !result) return null;
  const gatewayUrlInput = /** @type {HTMLInputElement | null} */ (form.querySelector("input[name='gatewayUrl']"));
  const gatewayProtocolSelect = /** @type {HTMLSelectElement | null} */ (form.querySelector("select[name='gatewayProtocol']"));
  const gatewayUrl = String(gatewayUrlInput?.value ?? "").trim();
  const gatewayProtocol = String(gatewayProtocolSelect?.value ?? "").trim();
  const saveTarget = configScope(new FormData(form).get("saveTarget"), "global") || "global";
  return result.dialogGeneration === state.modelConfigDialogGeneration
    && result.endpointRevision === state.modelConfigEndpointRevision
    && result.credentialRevision === state.modelConfigCredentialRevision
    && result.gatewayUrl === gatewayUrl
    && result.gatewayProtocol === gatewayProtocol
    && result.saveTarget === saveTarget
    ? result
    : null;
}

/** @param {HTMLFormElement | null} form */
export function currentGatewayCatalogModels(form: HTMLElement | null) {
  return currentGatewayProbeResult(form)?.models ?? [];
}

export function modelConfigGatewayProfile() {
  return state.editingGatewayProfileId
    ? gatewayProfileById(state.editingGatewayProfileId)
    : state.modelConfigIntent === "add-source" ? null : currentGatewayProfile();
}

/** @param {HTMLFormElement | null} form */
export function modelConfigEndpointChanged(form: HTMLElement | null) {
  if (!form) return false;
  const previous = modelConfigGatewayProfile()
    ?? (state.modelConfigIntent === "add-source" ? null : state.gatewayConfig);
  const previousUrl = String(previous?.gatewayUrl ?? previous?.transport?.baseURL ?? "").trim();
  if (!previousUrl) return false;
  const previousProtocol = String(
    previous?.gatewayProtocol ?? previous?.transport?.protocol ?? "openai-chat"
  ).trim();
  const gatewayUrl = String(form.querySelector("input[name='gatewayUrl']")?.value ?? "").trim();
  const gatewayProtocol = String(form.querySelector("select[name='gatewayProtocol']")?.value ?? "openai-chat").trim();
  return gatewayUrl !== previousUrl || gatewayProtocol !== previousProtocol;
}

/** @param {HTMLFormElement | null} form */
export function modelConfigAgentModelsSnapshot(form: HTMLElement | null) {
  if (!form) return "";
  const gatewayUrl = String(form.querySelector("input[name='gatewayUrl']")?.value ?? "").trim();
  const gatewayProtocol = String(form.querySelector("select[name='gatewayProtocol']")?.value ?? "openai-chat").trim();
  return JSON.stringify([
    state.modelConfigEndpointRevision,
    state.modelConfigCredentialRevision,
    gatewayUrl,
    gatewayProtocol
  ]);
}

/** @param {HTMLFormElement | null} form */
export function initializeAgentModelPickerSnapshot(form: HTMLElement | null) {
  if (!form || form.dataset.agentModelsSnapshot) return;
  const snapshot = modelConfigAgentModelsSnapshot(form);
  form.dataset.agentModelsSnapshot = snapshot;
  form.dataset.agentModelsEndpointChanged = String(modelConfigEndpointChanged(form));
  for (const pickerElement of form.querySelectorAll("[data-agent-model-picker]")) {
    const picker = /** @type {HTMLElement} */ (pickerElement);
    picker.dataset.modelSnapshot = snapshot;
  }
}

/**
 * @param {HTMLFormElement | null} form
 * @param {{ retainedCatalogModelIds?: string[] }} [options]
 */
export function syncAgentModelPickersForEndpoint(form: HTMLElement | null, options: { retainedCatalogModelIds?: string[] } = {}) {
  if (!form) return;
  const changed = modelConfigEndpointChanged(form);
  const keyInput = /** @type {HTMLInputElement | null} */ (form.querySelector("input[name='gatewayApiKey']"));
  if (keyInput) {
    keyInput.placeholder = changed && keyInput.dataset.keyConfigured === "true"
      ? "地址或协议已变化，请重新输入 Key"
      : keyInput.dataset.keepPlaceholder || "可选";
  }
  const snapshot = modelConfigAgentModelsSnapshot(form);
  const previousSnapshot = String(form.dataset.agentModelsSnapshot ?? "");
  if (!previousSnapshot) {
    initializeAgentModelPickerSnapshot(form);
    return;
  }
  if (snapshot === previousSnapshot) return;
  const retainedCatalogModelIds = new Set(options.retainedCatalogModelIds ?? []);
  form.dataset.agentModelsEndpointChanged = String(changed);
  form.dataset.agentModelsSnapshot = snapshot;
  for (const pickerElement of form.querySelectorAll("[data-agent-model-picker]")) {
    const picker = /** @type {HTMLElement} */ (pickerElement);
    const input = /** @type {HTMLInputElement | null} */ (picker.querySelector(".agent-model-manual-input"));
    if (!input) continue;
    const currentValue = input.value.trim();
    const belongsToPreviousSnapshot = picker.dataset.modelSnapshot === previousSnapshot;
    const retainCatalogValue = changed
      && belongsToPreviousSnapshot
      && retainedCatalogModelIds.has(currentValue);
    input.value = changed
      ? retainCatalogValue ? currentValue : ""
      : String(picker.dataset.savedModelId ?? "").trim();
    picker.dataset.manualActive = "false";
    picker.dataset.modelSnapshot = snapshot;
  }
  renderAgentModelPickers(form);
}

/** @param {any[]} models */
export function uniqueAgentModelCandidates(models: unknown[]): Array<{ id: string; label: string }> {
  const seen = new Set<string>();
  return (Array.isArray(models) ? models : []).map((model) => {
    const record = isPlainObject(model) ? model : {};
    return {
      id: String(record.id ?? "").trim(),
      label: String(record.label ?? record.id ?? "").trim()
    };
  }).filter((model) => model.id && !seen.has(model.id) && seen.add(model.id));
}

/** @param {HTMLSelectElement} select @param {string} label @param {any[]} models @param {string} [suffix] */
export function appendAgentModelOptions(select: HTMLElement, label: string, models: Array<{ id: string; label: string }>, suffix: string = "") {
  if (!(select instanceof HTMLSelectElement) || models.length === 0) return;
  const group = document.createElement("optgroup");
  group.label = label;
  for (const model of models) {
    const option = document.createElement("option");
    option.value = model.id;
    const displayName = model.label && model.label !== model.id ? ` · ${model.label}` : "";
    option.textContent = `${model.id}${displayName}${suffix}`;
    group.append(option);
  }
  select.append(group);
}

/** @param {HTMLFormElement | null} form */
export function renderAgentModelPickers(form: HTMLElement | null) {
  if (!form) return;
  initializeAgentModelPickerSnapshot(form);
  const snapshot = modelConfigAgentModelsSnapshot(form);
  const catalogModels = uniqueAgentModelCandidates(currentGatewayCatalogModels(form));
  const catalogIds = new Set(catalogModels.map((model) => model.id));
  const registeredModels = form.dataset.agentModelsEndpointChanged === "true"
    ? []
    : uniqueAgentModelCandidates(modelConfigGatewayProfile()?.models ?? []);
  const registeredOnly = registeredModels.filter((model) => !catalogIds.has(model.id));
  const registeredIds = new Set(registeredModels.map((model) => model.id));
  const catalogAvailable = catalogModels.length > 0;

  for (const pickerElement of form.querySelectorAll("[data-agent-model-picker]")) {
    const picker = /** @type {HTMLElement} */ (pickerElement);
    const select = /** @type {HTMLSelectElement | null} */ (picker.querySelector("select[data-agent-model-select]"));
    const input = /** @type {HTMLInputElement | null} */ (picker.querySelector(".agent-model-manual-input"));
    const status = picker.querySelector(".agent-model-picker-status");
    if (!(select instanceof HTMLSelectElement) || !input || !status) continue;
    if (picker.dataset.modelSnapshot !== snapshot) {
      input.value = "";
      picker.dataset.manualActive = "false";
      picker.dataset.modelSnapshot = snapshot;
    }
    const currentValue = input.value.trim();
    const savedValue = String(picker.dataset.savedModelId ?? "").trim();
    let manualActive = picker.dataset.manualActive === "true" || select.value === MANUAL_AGENT_MODEL_VALUE;

    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "未指定";
    select.replaceChildren(empty);
    appendAgentModelOptions(select, "当前来源已发现", catalogModels);
    appendAgentModelOptions(
      select,
      catalogAvailable ? "已注册 · 目录未返回" : "已注册模型",
      registeredOnly,
      catalogAvailable ? "（目录未返回）" : ""
    );

    const knownValue = catalogIds.has(currentValue) || registeredIds.has(currentValue);
    const savedMissing = Boolean(currentValue) && currentValue === savedValue && !knownValue;
    if (knownValue) {
      manualActive = false;
    } else if (savedMissing) {
      const saved = document.createElement("option");
      saved.value = currentValue;
      saved.textContent = catalogAvailable
        ? `${currentValue}（已保存 · 目录未发现）`
        : `${currentValue}（已保存 · 等待目录核对）`;
      select.append(saved);
      manualActive = false;
    } else if (currentValue && !knownValue) {
      manualActive = true;
    }

    const manual = document.createElement("option");
    manual.value = MANUAL_AGENT_MODEL_VALUE;
    manual.textContent = "手工输入 ID...";
    select.append(manual);

    if (manualActive) {
      select.value = MANUAL_AGENT_MODEL_VALUE;
    } else if (currentValue && Array.from(select.options).some((option) => option.value === currentValue)) {
      select.value = currentValue;
    } else {
      select.value = "";
      if (!currentValue) input.value = "";
    }
    picker.dataset.manualActive = String(manualActive);
    input.classList.toggle("hidden", !manualActive);

    if (manualActive) {
      updateAgentModelPickerManualStatus(picker, currentValue);
    } else if (!currentValue) {
      picker.dataset.modelState = "empty";
      status.textContent = catalogAvailable ? `${catalogModels.length} 个已发现模型可选` : "未指定";
    } else if (catalogIds.has(currentValue)) {
      picker.dataset.modelState = "catalog";
      status.textContent = "当前来源已发现";
    } else if (registeredIds.has(currentValue)) {
      picker.dataset.modelState = catalogAvailable ? "missing" : "registered";
      status.textContent = catalogAvailable ? "已注册，但当前目录未返回" : "已注册模型";
    } else {
      picker.dataset.modelState = "missing";
      status.textContent = catalogAvailable ? "已保存，但当前目录未发现" : "已保存，等待目录核对";
    }
  }

  const summary = form.querySelector("#agent-model-catalog-status");
  if (summary) {
    summary.textContent = state.gatewayProbeRunning
      ? "正在读取目录"
      : state.gatewayProbeError
        ? "目录读取失败"
        : catalogAvailable ? `已发现 ${catalogModels.length} 个` : "目录未读取";
  }
}

/** @param {HTMLElement} picker @param {unknown} value */
export function updateAgentModelPickerManualStatus(picker: HTMLElement, value: unknown) {
  const status = picker.querySelector(".agent-model-picker-status");
  picker.dataset.modelState = "manual";
  if (status) status.textContent = String(value ?? "").trim() ? "手工模型 ID" : "等待输入模型 ID";
}

/** @param {HTMLSelectElement} select */
export function handleAgentModelSelection(select: EventTarget | null) {
  if (!(select instanceof HTMLSelectElement)) return;
  const picker = /** @type {HTMLElement | null} */ (select.closest("[data-agent-model-picker]"));
  const form = /** @type {HTMLFormElement | null} */ (select.closest("form"));
  const input = /** @type {HTMLInputElement | null} */ (picker?.querySelector(".agent-model-manual-input") ?? null);
  if (!picker || !form || !input) return;
  picker.dataset.modelSnapshot = modelConfigAgentModelsSnapshot(form);
  if (select.value === MANUAL_AGENT_MODEL_VALUE) {
    picker.dataset.manualActive = "true";
    input.classList.remove("hidden");
    updateAgentModelPickerManualStatus(picker, input.value);
    requestAnimationFrame(() => input.focus({ preventScroll: true }));
    return;
  }
  picker.dataset.manualActive = "false";
  input.value = select.value;
  renderAgentModelPickers(form);
}

/** @param {{ preserveAgentModels?: boolean }} [options] */
export function renderGatewayProbeResult(options: { preserveAgentModels?: boolean } = {}) {
  const target = els.modelConfigPanel?.querySelector("#gateway-probe-result");
  if (!target) return;
  const form = target.closest("form");
  if (options.preserveAgentModels !== true) renderAgentModelPickers(form);
  const button = /** @type {HTMLButtonElement | null} */ (els.modelConfigPanel?.querySelector("button[data-action='probe-gateway']") ?? null);
  if (button) {
    button.disabled = state.gatewayProbeRunning;
    button.textContent = state.gatewayProbeRunning ? "连接中" : "测试连接 / 发现模型";
  }
  if (state.gatewayProbeRunning) {
    target.className = "gateway-probe-result loading";
    target.textContent = "正在验证网关";
    return;
  }
  if (state.gatewayProbeError) {
    target.className = "gateway-probe-result error";
    target.innerHTML = `<strong>连接失败</strong><span>${escapeHtml(state.gatewayProbeError)}</span>`;
    return;
  }
  const result = currentGatewayProbeResult(form);
  if (!result) {
    target.className = "gateway-probe-result";
    target.replaceChildren();
    return;
  }
  target.className = "gateway-probe-result success";
  const gatewayUrlInput = /** @type {HTMLInputElement | null} */ (els.modelConfigPanel?.querySelector("input[name='gatewayUrl']") ?? null);
  const currentGatewayUrl = gatewayUrlInput?.value.trim() || "";
  const suggestedGatewayUrl = String(result.suggestedGatewayUrl ?? "").trim();
  target.innerHTML = `
    <strong>${escapeHtml(result.message || "连接成功")}</strong>
    ${result.modelsUrl ? `<span>模型列表 ${escapeHtml(result.modelsUrl)}</span>` : ""}
    ${suggestedGatewayUrl && suggestedGatewayUrl !== currentGatewayUrl ? `<button class="gateway-probe-suggestion" type="button" data-action="use-suggested-gateway-url" data-gateway-url="${escapeAttribute(suggestedGatewayUrl)}">使用建议地址</button>` : ""}
    ${(result.models ?? []).length > 0 ? `
      <div class="gateway-probe-models" aria-label="发现的模型">
        ${(result.models ?? []).map((model) => `<button type="button" data-action="select-probed-model" data-model-id="${escapeAttribute(model.id)}" data-model-label="${escapeAttribute(model.label)}">${escapeHtml(model.label || model.id)}</button>`).join("")}
      </div>
    ` : `<span>未返回模型列表</span>`}
  `;
}

/** @param {any} button */
export function applyProbedModel(button: HTMLElement) {
  const form = button.closest("form");
  const modelInput = form?.querySelector("input[name='modelId']");
  const modelId = button.dataset.modelId || "";
  const discoveredModel = currentGatewayCatalogModels(form).find((model) => model.id === modelId) ?? null;
  if (modelInput) modelInput.value = modelId;
  if (discoveredModel) {
    applyGatewayDiscoveredModel(form, discoveredModel);
  } else {
    const labelInput = form?.querySelector("input[name='label']");
    if (labelInput && !labelInput.value.trim()) labelInput.value = button.dataset.modelLabel || modelId;
    handleModelConfigModelIdChanged(form);
  }
  modelInput?.focus?.({ preventScroll: true });
}

/** @param {HTMLFormElement | null} form @param {any} discoveredModel */
export function applyGatewayDiscoveredModel(form: HTMLElement | null, discoveredModel: DashboardGatewayProbeModel | null | undefined) {
  if (!form || !discoveredModel) return false;
  const modelInput = /** @type {HTMLInputElement | null} */ (form.querySelector("input[name='modelId']"));
  const modelId = String(modelInput?.value ?? "").trim();
  if (!modelId || discoveredModel.id !== modelId) return false;
  const labelInput = /** @type {HTMLInputElement | null} */ (form.querySelector("input[name='label']"));
  const contextInput = /** @type {HTMLInputElement | null} */ (form.querySelector("input[name='contextTokens']"));
  const visionInput = /** @type {HTMLInputElement | null} */ (form.querySelector("input[name='vision']"));
  if (labelInput && !labelInput.value.trim()) labelInput.value = discoveredModel.label || modelId;
  if (!state.editingModelId && contextInput && !contextInput.value.trim() && discoveredModel.contextTokens) {
    contextInput.value = String(discoveredModel.contextTokens);
  }
  if (!state.editingModelId && visionInput && discoveredModel.modalities?.includes("image")) {
    visionInput.checked = true;
  }
  applyReasoningCapabilityCandidate(form, reasoningCapabilityCandidate(discoveredModel));
  return true;
}

/** @param {any} button */
export function applySuggestedGatewayUrl(button: HTMLElement) {
  const form = button.closest("form");
  const input = form?.querySelector("input[name='gatewayUrl']");
  if (!input) return;
  const result = currentGatewayProbeResult(form);
  const retainedAgentModelIds = result?.models?.map((model) => model.id) ?? [];
  input.value = button.dataset.gatewayUrl || "";
  markModelConfigEndpointChanged(form, {
    preserveGatewayResult: true,
    preserveReasoning: true,
    retainedAgentModelIds
  });
  if (result && state.gatewayProbeResult === result) {
    result.dialogGeneration = state.modelConfigDialogGeneration;
    result.endpointRevision = state.modelConfigEndpointRevision;
    result.credentialRevision = state.modelConfigCredentialRevision;
    result.gatewayUrl = input.value.trim();
    result.gatewayProtocol = String(form.querySelector("select[name='gatewayProtocol']")?.value ?? "").trim();
  }
  input.focus({ preventScroll: true });
  renderGatewayProbeResult();
}

/** @param {FormData} data @param {any} previousGateway */
export function gatewayCredentialAction(data: FormData, previousGateway: DashboardGatewayConfig | DashboardGatewayProfile | null | undefined) {
  if (data.get("clearGatewayApiKey") === "on") return "clear";
  if (String(data.get("gatewayApiKey") ?? "").trim()) return "replace";
  const previousUrl = String(previousGateway?.gatewayUrl ?? previousGateway?.transport?.baseURL ?? "").trim();
  if (!previousUrl) return "keep";
  const gatewayUrl = String(data.get("gatewayUrl") ?? "").trim();
  const gatewayProtocol = String(data.get("gatewayProtocol") ?? "openai-chat").trim();
  const previousProtocol = String(
    previousGateway?.gatewayProtocol ?? previousGateway?.transport?.protocol ?? "openai-chat"
  ).trim();
  return gatewayUrl !== previousUrl || gatewayProtocol !== previousProtocol ? "clear" : "keep";
}

/** @param {any} value */
export function normalizeGatewayProbeModels(value: unknown): DashboardGatewayProbeModel[] {
  return Array.isArray(value) ? value.map((modelValue) => {
    const model = typeof modelValue === "string"
      ? { id: modelValue, label: modelValue }
      : isPlainObject(modelValue) ? modelValue : {};
    const reasoning = isPlainObject(model.reasoning) ? model.reasoning : {};
    const id = String(model.id ?? model.model ?? "").trim();
    const reasoningEfforts = normalizeReasoningEfforts(model.reasoningEfforts ?? reasoning.efforts);
    const requestedDefault = normalizedReasoningEffort(model.defaultReasoningEffort ?? reasoning.default);
    const configuredDefault = configuredReasoningEffort(requestedDefault, reasoningEfforts);
    const rawModalities = model.modalities ?? model.inputModalities;
    const contextTokens = Number(model.contextTokens ?? model.contextWindow);
    return {
      id,
      label: String(model.label ?? model.name ?? model.displayName ?? id),
      contextTokens: Number.isFinite(contextTokens) && contextTokens > 0 ? contextTokens : null,
      modalities: Array.isArray(rawModalities) ? rawModalities.map(String) : [],
      thinking: model.thinking === true,
      reasoningEfforts,
      defaultReasoningEffort: reasoningEfforts.some((effort) => effort.id === configuredDefault) ? configuredDefault : null,
      reasoningDiscovery: normalizeReasoningDiscovery(
        model.reasoningDiscovery ?? reasoning.discovery,
        reasoningEfforts,
        model.thinking === true ? true : null
      )
    };
  }).filter((model) => model.id) : [];
}

/** @param {any} value @param {any[]} efforts @param {boolean | null} [fallbackSupport] */
export function normalizeReasoningDiscovery(value: unknown, efforts: unknown[] = [], fallbackSupport: boolean | null = null): DashboardReasoningDiscovery {
  const record = isPlainObject(value) ? value : {};
  const source = String(record.source ?? (efforts.length > 0 ? "upstream-metadata" : "unknown")).trim() || "unknown";
  const supportsReasoning = record.supportsReasoning === true
    ? true
    : record.supportsReasoning === false ? false : efforts.length > 0 ? true : fallbackSupport;
  return {
    source,
    confidence: String(record.confidence ?? "unknown"),
    path: record.path == null ? null : String(record.path),
    presetId: record.presetId == null ? null : String(record.presetId),
    supportsReasoning,
    probeAvailable: record.probeAvailable === false ? false : true,
    warnings: Array.isArray(record.warnings) ? record.warnings.map(String).filter(Boolean) : []
  };
}

/** @param {any} model */
export function reasoningCapabilityCandidate(model: unknown): DashboardReasoningCapabilityCandidate {
  const normalized = normalizeGatewayProbeModels([model])[0] ?? {
    id: String(isPlainObject(model) ? model.id ?? "" : ""),
    reasoningEfforts: [],
    defaultReasoningEffort: null,
    reasoningDiscovery: normalizeReasoningDiscovery(null, [])
  };
  return {
    modelId: normalized.id,
    reasoningEfforts: normalized.reasoningEfforts,
    defaultReasoningEffort: normalized.defaultReasoningEffort,
    reasoningDiscovery: normalized.reasoningDiscovery
  };
}

/** @param {HTMLFormElement | null} form @param {any} candidate @param {{ force?: boolean }} [options] */
export function applyReasoningCapabilityCandidate(form: HTMLElement | null, candidate: DashboardReasoningCapabilityCandidate | {
  modelId?: string;
  reasoningEfforts?: unknown;
  defaultReasoningEffort?: unknown;
  reasoningDiscovery?: unknown;
} | null | undefined, options: { force?: boolean } = {}) {
  if (!form || !candidate) return false;
  const modelInput = /** @type {HTMLInputElement | null} */ (form.querySelector("input[name='modelId']"));
  const modelId = String(modelInput?.value ?? "").trim();
  if (candidate.modelId && candidate.modelId !== modelId) return false;
  const normalized = reasoningCapabilityCandidate({
    id: modelId,
    reasoningEfforts: candidate.reasoningEfforts,
    defaultReasoningEffort: candidate.defaultReasoningEffort,
    reasoningDiscovery: candidate.reasoningDiscovery
  });
  if (!reasoningCapabilityIsActionable(normalized) && state.editingModelId && options.force !== true) {
    state.modelConfigReasoningDiscovery = normalized.reasoningDiscovery;
    state.modelConfigReasoningCandidate = null;
    state.modelCapabilityProbeError = "";
    renderReasoningCapabilityStatus();
    return false;
  }
  if (state.modelConfigReasoningLocked && options.force !== true) {
    state.modelConfigReasoningCandidate = normalized;
    renderReasoningCapabilityStatus();
    return false;
  }

  ensureReasoningEffortOptions(form, normalized.reasoningEfforts);
  const selected = new Set(normalized.reasoningEfforts.map((effort: DashboardReasoningEffort) => effort.id));
  for (const input of /** @type {NodeListOf<HTMLInputElement>} */ (form.querySelectorAll("input[name='reasoningEfforts']"))) {
    input.checked = selected.has(input.value);
  }
  syncReasoningDefaultOptions(form);
  const defaultSelect = /** @type {HTMLSelectElement | null} */ (form.querySelector("select[name='defaultReasoningEffort']"));
  if (defaultSelect) defaultSelect.value = normalized.defaultReasoningEffort || "";
  const thinking = /** @type {HTMLInputElement | null} */ (form.querySelector("input[name='thinking']"));
  if (thinking) {
    thinking.checked = normalized.reasoningDiscovery.supportsReasoning === true || normalized.reasoningEfforts.length > 0;
  }
  state.modelConfigReasoningSource = normalized.reasoningDiscovery.source;
  state.modelConfigReasoningDiscovery = normalized.reasoningDiscovery;
  state.modelConfigReasoningCandidate = null;
  state.modelCapabilityProbeError = "";
  if (options.force === true) {
    state.modelConfigReasoningLocked = true;
    state.modelConfigReasoningEditRevision += 1;
  }
  renderReasoningCapabilityStatus();
  return true;
}

/** @param {HTMLFormElement} form @param {any[]} efforts */
export function ensureReasoningEffortOptions(form: HTMLElement, efforts: unknown[]) {
  const container = form.querySelector(".model-reasoning-options");
  if (!container) return;
  const normalizedEfforts = normalizeReasoningEfforts(efforts);
  const configuredDisabled = normalizedEfforts.find((effort: DashboardReasoningEffort) => isDisabledReasoningEffort(effort.id))?.id ?? "";
  if (configuredDisabled) {
    for (const input of /** @type {NodeListOf<HTMLInputElement>} */ (container.querySelectorAll("input[name='reasoningEfforts']"))) {
      if (isDisabledReasoningEffort(input.value) && input.value !== configuredDisabled) {
        input.closest("label")?.remove();
      }
    }
  }
  for (const effort of normalizedEfforts) {
    const existing = Array.from(container.querySelectorAll("input[name='reasoningEfforts']"))
      .find((candidate) => candidate.value === effort.id);
    if (existing) {
      existing.dataset.effortLabel = effort.label;
      const text = existing.parentElement?.querySelector("span");
      if (text) text.textContent = effort.label;
      continue;
    }
    const label = document.createElement("label");
    label.innerHTML = `<input name="reasoningEfforts" type="checkbox" value="${escapeAttribute(effort.id)}"><span></span>`;
    const created = label.querySelector("input");
    if (created) created.dataset.effortLabel = effort.label;
    const span = label.querySelector("span");
    if (span) span.textContent = effort.label;
    container.append(label);
  }
}

/** @param {HTMLFormElement | null} form */
export function applyPendingReasoningCapabilities(form: HTMLElement | null) {
  const candidate = state.modelConfigReasoningCandidate;
  if (!candidate) return;
  applyReasoningCapabilityCandidate(form, candidate, { force: true });
}

/** @param {any} candidate */
export function reasoningCapabilityIsActionable(candidate: DashboardReasoningCapabilityCandidate | null | undefined) {
  if (!candidate) return false;
  return normalizeReasoningEfforts(candidate.reasoningEfforts).length > 0
    || candidate.reasoningDiscovery?.supportsReasoning === false;
}

export function renderReasoningCapabilityStatus() {
  const form = /** @type {HTMLFormElement | null} */ (els.modelConfigPanel?.querySelector("#model-config-form") ?? null);
  const fieldset = /** @type {HTMLElement | null} */ (form?.querySelector(".model-reasoning-config") ?? null);
  const status = /** @type {HTMLElement | null} */ (form?.querySelector("#reasoning-capability-status") ?? null);
  const detect = /** @type {HTMLButtonElement | null} */ (form?.querySelector("button[data-action='detect-reasoning-capabilities']") ?? null);
  const apply = /** @type {HTMLButtonElement | null} */ (form?.querySelector("button[data-action='apply-reasoning-capabilities']") ?? null);
  if (!form || !fieldset || !status || !detect || !apply) return;

  const modelInput = /** @type {HTMLInputElement | null} */ (form.querySelector("input[name='modelId']"));
  const modelId = String(modelInput?.value ?? "").trim();
  const candidate = state.modelConfigReasoningCandidate;
  const candidateActionable = reasoningCapabilityIsActionable(candidate);
  fieldset.dataset.reasoningMode = state.modelConfigReasoningLocked ? "manual" : "auto";
  fieldset.dataset.reasoningSource = state.modelConfigReasoningSource;
  status.classList.toggle("error", Boolean(state.modelCapabilityProbeError));
  if (state.modelCapabilityProbeRunning) {
    status.textContent = "正在检测档位";
  } else if (state.modelCapabilityProbeError) {
    status.textContent = `检测失败：${state.modelCapabilityProbeError}`;
  } else {
    status.textContent = reasoningCapabilityStatusText(candidateActionable ? candidate : null);
  }

  apply.classList.toggle("hidden", !candidateActionable);
  apply.disabled = state.modelCapabilityProbeRunning;
  detect.textContent = state.modelCapabilityProbeRunning ? "检测中" : "检测档位";
  detect.disabled = !modelId || state.modelCapabilityProbeRunning;
  const discovery = state.modelConfigReasoningDiscovery;
  detect.classList.toggle("hidden", discovery?.probeAvailable === false && !candidateActionable);
}

/** @param {any} candidate */
export function reasoningCapabilityStatusText(candidate: unknown) {
  const base = state.modelConfigReasoningSource === "manual"
    ? "手动设置"
    : state.modelConfigReasoningSource === "stored"
      ? "已保存配置"
      : reasoningDiscoveryStatusText({
          reasoningEfforts: Array.from(/** @type {NodeListOf<HTMLInputElement>} */ (els.modelConfigPanel?.querySelectorAll("input[name='reasoningEfforts']:checked") ?? [])).map((input) => ({ id: input.value })),
          reasoningDiscovery: state.modelConfigReasoningDiscovery
        });
  if (!candidate) return base;
  return `${base}，${reasoningDiscoveryStatusText(candidate, true)}`;
}

/** @param {any} candidate @param {boolean} [pending] */
export function reasoningDiscoveryStatusText(candidate: { reasoningEfforts?: unknown; reasoningDiscovery?: DashboardReasoningDiscovery | null } | null | undefined, pending: boolean = false) {
  const efforts = normalizeReasoningEfforts(candidate?.reasoningEfforts);
  const discovery = candidate?.reasoningDiscovery;
  const prefix = pending ? "发现" : "";
  if (discovery?.supportsReasoning === false) return `${prefix}上游不支持档位`;
  if (discovery?.source === "known-preset") return `${pending ? "发现" : "已应用"}模型预设 ${efforts.length} 档`;
  if (discovery?.source === "active-probe" || discovery?.source === "explicit-probe" || discovery?.source === "probe" || discovery?.source === "capability-probe") {
    return efforts.length > 0 ? `${pending ? "发现" : "已检测"} ${efforts.length} 档` : "检测未确认档位";
  }
  if (discovery?.source === "upstream-metadata") {
    return efforts.length > 0 ? `${pending ? "发现" : "上游已提供"} ${efforts.length} 档` : "上游未列出档位";
  }
  if (efforts.length > 0) return `${prefix || "已发现"} ${efforts.length} 档`;
  return "未自动发现档位";
}

/** @param {HTMLFormElement | null} form */
export async function probeModelCapabilities(form: HTMLElement | null) {
  if (!(form instanceof HTMLFormElement) || state.modelCapabilityProbeRunning) return;
  if (!form.reportValidity()) return;
  const data = new FormData(form);
  const modelId = String(data.get("modelId") ?? "").trim();
  if (!modelId) return;
  const profile = gatewayProfileById(state.editingGatewayProfileId) ?? currentGatewayProfile();
  const dialogGeneration = state.modelConfigDialogGeneration;
  const endpointRevision = state.modelConfigEndpointRevision;
  const credentialRevision = state.modelConfigCredentialRevision;
  const reasoningEditRevision = state.modelConfigReasoningEditRevision;
  const saveTarget = configScope(data.get("saveTarget"), "global") || "global";
  const gatewayDiscoveryToken = currentGatewayProbeResult(form)?.discoveryToken || "";
  const request = beginScopedRequest("model-capabilities-probe", `${dialogGeneration}:${endpointRevision}:${credentialRevision}:${modelId}`);
  state.modelCapabilityProbeRunning = true;
  state.modelCapabilityProbeError = "";
  state.modelConfigReasoningCandidate = null;
  renderReasoningCapabilityStatus();
  try {
    const result = await postJson("/api/model-capabilities/probe", {
      modelId,
      gatewayUrl: data.get("gatewayUrl"),
      gatewayProtocol: data.get("gatewayProtocol"),
      gatewayApiKey: data.get("gatewayApiKey"),
      credentialAction: gatewayCredentialAction(data, profile ?? state.gatewayConfig),
      clientId: dashboardClientId(),
      saveTarget,
      ...configMutationMetadata(saveTarget),
      gatewayDiscoveryToken,
      profileId: profile?.id || state.gatewayConfig?.activeProfileId || "",
      previousGatewayUrl: profile?.gatewayUrl || state.gatewayConfig?.gatewayUrl || "",
      previousGatewayProtocol: profile?.gatewayProtocol || state.gatewayConfig?.gatewayProtocol || "openai-chat"
    }, { signal: request.signal, timeoutMs: 25_000 });
    if (!isCurrentModelConfigRequest(request, form, dialogGeneration, endpointRevision, credentialRevision)) return;
    const currentModelInput = /** @type {HTMLInputElement | null} */ (form.querySelector("input[name='modelId']"));
    if (String(currentModelInput?.value ?? "").trim() !== modelId) return;
    if (!result.ok) throw new Error(result.error ?? "档位检测失败");
    state.modelCapabilityDiscoveryToken = String(result.discoveryToken ?? "");
    const raw = result.model && typeof result.model === "object"
      ? { ...result.model, id: result.model.id || modelId }
      : result.capability && typeof result.capability === "object"
        ? { ...result.capability, id: result.capability.id || modelId }
        : { ...result, id: result.modelId || modelId };
    const candidate = reasoningCapabilityCandidate(raw);
    if (candidate.reasoningDiscovery.source === "unknown") {
      candidate.reasoningDiscovery = {
        ...candidate.reasoningDiscovery,
        source: "active-probe",
        confidence: "probed"
      };
    }
    if (state.modelConfigReasoningEditRevision !== reasoningEditRevision) {
      state.modelConfigReasoningCandidate = candidate;
      renderReasoningCapabilityStatus();
    } else {
      applyReasoningCapabilityCandidate(form, candidate);
    }
  } catch (error) {
    if (!isAbortError(error) && isCurrentModelConfigRequest(request, form, dialogGeneration, endpointRevision, credentialRevision)) {
      state.modelCapabilityProbeError = error instanceof Error ? error.message : "档位检测失败";
    }
  } finally {
    const current = isCurrentModelConfigRequest(request, form, dialogGeneration, endpointRevision, credentialRevision);
    if (current) state.modelCapabilityProbeRunning = false;
    finishScopedRequest(request);
    if (current) renderReasoningCapabilityStatus();
  }
}

/** @param {HTMLFormElement} form @param {boolean} saving @param {string} pendingLabel */
export function setFormControlsSaving(form: HTMLElement, saving: boolean, pendingLabel: string) {
  for (const control of form.querySelectorAll("input, select, textarea, button")) {
    if (saving) {
      control.dataset.saveDisabledBefore = control.disabled ? "true" : "false";
      control.disabled = true;
    } else if (control.dataset.saveDisabledBefore !== undefined) {
      control.disabled = control.dataset.saveDisabledBefore === "true";
      delete control.dataset.saveDisabledBefore;
    }
  }
  const submit = form.querySelector("button[type='submit']");
  if (submit) {
    if (saving) {
      submit.dataset.saveLabelBefore = submit.textContent ?? "";
      submit.textContent = pendingLabel;
    } else if (submit.dataset.saveLabelBefore !== undefined) {
      submit.textContent = submit.dataset.saveLabelBefore;
      delete submit.dataset.saveLabelBefore;
    }
  }
  if (saving) form.setAttribute("aria-busy", "true");
  else form.removeAttribute("aria-busy");
}

/** @param {HTMLFormElement} form @param {boolean} saving */
export function setModelConfigFormSaving(form: HTMLElement, saving: boolean) {
  setFormControlsSaving(form, saving, "保存中");
  const backdrop = els.modelConfigPanel?.querySelector(".model-config-backdrop");
  if (backdrop) backdrop.disabled = saving;
}

/** @param {HTMLFormElement} form @param {string} message */
export function renderModelConfigFailure(form: HTMLElement, message: string) {
  const feedback = form.querySelector(".model-config-feedback");
  if (!feedback) return;
  feedback.classList.remove("hidden");
  feedback.textContent = message;
}

/** @param {HTMLFormElement} form */
export function clearModelConfigFailure(form: HTMLElement) {
  const feedback = form.querySelector(".model-config-feedback");
  if (!feedback) return;
  feedback.classList.add("hidden");
  feedback.textContent = "";
}

/** @param {HTMLFormElement} form */
export function manualAgentModelIds(form: HTMLElement) {
  const ids = [];
  const seen = new Set();
  for (const pickerElement of form.querySelectorAll("[data-agent-model-picker]")) {
    const picker = /** @type {HTMLElement} */ (pickerElement);
    if (picker.dataset.manualActive !== "true") continue;
    const input = /** @type {HTMLInputElement | null} */ (picker.querySelector(".agent-model-manual-input"));
    const id = String(input?.value ?? "").trim();
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

