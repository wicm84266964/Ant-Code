import { renderMarkdown } from "./markdown.ts";
import { hydrateRichContent } from "./rich-renderers.ts";
import { visibleTranscriptRole } from "./transcript.ts";
import { MANUAL_AGENT_MODEL_VALUE, state, els, MODE_DESCRIPTIONS, LOCAL_FILE_EXTENSIONS, FILE_REFERENCE_PATTERN, TRANSCRIPT_DOM_LIMIT, EVENT_STALE_AFTER_MS, EVENT_CONNECT_TIMEOUT_MS, EVENT_RECONNECT_MAX_ATTEMPTS, DASHBOARD_REQUEST_TIMEOUT_MS, DASHBOARD_API_VERSION, DASHBOARD_LIFECYCLE_TIMEOUT_MS, DASHBOARD_SHUTDOWN_TIMEOUT_MS, DASHBOARD_INTERRUPT_TIMEOUT_MS, MAX_IMAGE_ATTACHMENTS, MAX_IMAGE_ATTACHMENT_BYTES, CURRENT_SESSION_STORAGE_KEY, DASHBOARD_CLIENT_STORAGE_KEY, PREVIEW_WIDTH_STORAGE_KEY, PREVIEW_WIDTH_DEFAULT, PREVIEW_WIDTH_MIN, PREVIEW_WIDTH_MAX, PREVIEW_WORKSPACE_MIN , emptySessionStatus, emptyBackgroundSubagent } from "./app-core.ts";
import type { DashboardConfigSource, DashboardReasoningEffort, DashboardTurnChangeStats, DashboardScopedDefaultSelection, DashboardVisionAgent, DashboardReasoningDiscovery, DashboardReasoningCapabilityCandidate, DashboardGatewayProbeModel, DashboardGatewayProbeResult, DashboardLifecycleActivity, DashboardSettings, DashboardFile, DashboardTableSheet, DashboardTablePreview, DashboardLightboxItem, DashboardQuestionChoice, DashboardPendingQuestion, DashboardApproval, DashboardGatewayTransport, DashboardScopedRequest, DashboardFetchOptions, DashboardModelSource, DashboardSessionStatus, DashboardApiResult, DashboardActivity, DashboardModelOption, DashboardGatewayProfile, DashboardGatewayConfig, DashboardModelSelection, DashboardPendingGuide, DashboardStreamEvent, DashboardUiState , DashboardSessionSummary } from "./app-core.ts";
import { eventTargetOf, eventElement, isPlainObject, modelSourceOf, errorMessageOf, init, bootstrapDashboard, observeRunStatus, updateRunStatusTone, bindEvents, normalizedResponsiveView, composerHeightFor, previewWidthBounds, clampedPreviewWidth, permissionIndexForKey, focusTrapTarget, shouldFollowTranscript, scheduleAnimationFrameOnce, cancelScheduledAnimationFrame, appendPlainDraftDelta, renderFinalAssistantBody, selectTranscriptNodesToRemove, responsiveLayoutMode, restorePreviewWidth, setPreviewWidth, syncPreviewResizeHandle, beginPreviewResize, updatePreviewResize, finishPreviewResize, handlePreviewResizeKeydown, setResponsiveView, syncResponsiveNavigation, setResponsiveSurfaceInert, handleResponsiveFileNavigation, syncVisualViewport, resizePromptInput, handlePermissionModeKeydown, requestPermissionMode, defaultGoalMaxAutoContinues, emptyGoalSnapshot, applyGoalSnapshot, renderGoalControls, renderGoalStatusBar, requestGoalMode, showGoalConfirm, hideGoalConfirm, showGoalTextPanel, hideGoalTextPanel, enableGoalWithObjective, submitGoalAction, adoptGoalRunResult, showPermissionConfirm, hidePermissionConfirm, updateContextActions, announceStatus, modalFocusableElements, activateModal, collectModalBackground, focusModalInitialTarget, deactivateModal, restoreModalAttribute, handleGlobalKeydown, closeActiveModal, loadTrust, loadSessions, restoreInitialSession, latestBackgroundSessionId, initialSessionId, rememberCurrentSession, renderSessions, sessionMeta, sessionStatusView, toggleSidebar, setSidebarCollapsed, sessionsNeedRefresh, scheduleSessionsRefresh, handleSessionAction, openSession, restoreBackgroundSnapshot, deleteSession, setSessionsRefreshState, copySessionId, newTask, rememberNewTaskModelState, restoreNewTaskModelState, refreshNewTaskModelState, addAttachmentFiles, readImageAttachment, renderAttachmentStrip, attachmentPayload, clearAttachments, sendPrompt, stableTurnRequest, dashboardRequestId, dashboardClientId, statusUrl, interruptTurn, guideTurn, cancelQueuedTurn, cancelBackgroundSubagent, backgroundCancelKey, connectEvents, ensureEventsConnected, disconnectEvents, closeEventSource, markEventConnectionAlive, armEventConnectTimer, armEventStaleTimer, scheduleEventReconnect, reconnectEventsManually, clearEventReconnectTimer, clearEventConnectTimer, clearEventStaleTimer, setConnectionState, resetEventReplayState, rememberEventCursor, handleDashboardEvent, shouldSkipDashboardEvent, beginEventTurn, renderTranscriptMessages, renderSessionFailure, setTranscriptPaging, renderTranscriptHistoryStatus, removeTranscriptHistoryStatus, transcriptFirstContentNode, handleTranscriptScroll, loadOlderTranscript, renderWorkflowPanel, renderWorkflowStrip, currentWorkflowItem, workflowSection, workflowItem, normalizeWorkflowStatus, summarizeWorkflow, appendMessage, createMessageNode, appendTranscriptNode, trimTranscriptWindow, isProtectedTranscriptNode, renderTranscriptWindowMarker, captureTranscriptViewportAnchor, restoreTranscriptViewportAnchor, transcriptNodeTop, restoreTranscriptNodeAnchor, resetTranscriptWindow, appendAssistantDraft, scheduleDraftRender, renderAssistantDraft, appendActivity, appendContextBoundary, contextBoundaryText, handleActivity, isBackgroundSubagentActivity, handleBackgroundSubagentActivity, clearBackgroundSubagentStatus, reconcileBackgroundSubagentSnapshot, backgroundSubagentDisplayStatus, backgroundSubagentVisible, updateLiveActivity, removeLiveActivity, setLiveTitle, toggleLiveStatusDetails, updateLiveStatus, liveStatusTitle, primaryLiveActivity, gatewayRetryChipText, renderBackgroundSubagentStatus, backgroundSubagentCompactLabel, backgroundSubagentTitle, backgroundSubagentMeta, backgroundSubagentCancellable, resetLiveStatus, backgroundSubagentCounts, idleRunStatus, applyIdleRunStatus, updateRunStatusForBackground, updateSessionStatus, updateTurnChangeStats, resetTurnChangeStats, normalizeChangeStats, renderComposerStatus, modelStatusHtml, unresolvedModelStatusHtml, handleModelStatusActivate, handleModelStatusKeydown, toggleModelPanel, hideModelPanel, showSettingsWorkspace, refreshSettingsConfiguration, hideSettingsWorkspace, showModelConfigPanel, hideModelConfigPanel, renderModelPanel, modelCapabilityLabels, handleModelPanelClick, handleModelPanelChange, renderSettingsView, syncSettingsRail, modelSettingsHtml, transcriptSettingsHtml, transcriptRetentionOptionsHtml, networkSettingsHtml, networkModeOptionHtml, agentSettingsHtml, reliabilitySettingsHtml, settingsSectionHeading, settingsToggleHtml, managedFieldHtml, settingsDisabled, settingsFormActions, settingsFeedbackHtml, settingsGatewayProfileHtml, gatewayProfileReadonlyLabel, providerModelKey, scopedDefaultModelLabel, settingsModelHtml, handleSettingsRailClick, initializeSettingsFormTracking, handleSettingsFormChange, settingsControlValue, changedSettingsFields, canonicalSettingsField, setSettingsFormSaving, renderSettingsFeedbackInPlace, saveSettingsConfig, handleSettingsClick, protocolDisplayName, agentModelPickerHtml, renderModelConfigPanel, handleModelConfigPanelClick, handleModelConfigInput, handleModelConfigChange, markModelConfigCredentialChanged, markModelConfigEndpointChanged, handleModelConfigModelIdChanged, markReasoningCapabilityManual, clearReasoningCapabilityControls, syncGatewayUrlHint, gatewayUrlPlaceholder, gatewayUrlHint, syncReasoningDefaultOptions, probeGateway, isCurrentModelConfigRequest, currentGatewayProbeResult, currentGatewayCatalogModels, modelConfigGatewayProfile, modelConfigEndpointChanged, modelConfigAgentModelsSnapshot, initializeAgentModelPickerSnapshot, syncAgentModelPickersForEndpoint, uniqueAgentModelCandidates, appendAgentModelOptions, renderAgentModelPickers, updateAgentModelPickerManualStatus, handleAgentModelSelection, renderGatewayProbeResult, applyProbedModel, applyGatewayDiscoveredModel, applySuggestedGatewayUrl, gatewayCredentialAction, normalizeGatewayProbeModels, normalizeReasoningDiscovery, reasoningCapabilityCandidate, applyReasoningCapabilityCandidate, ensureReasoningEffortOptions, applyPendingReasoningCapabilities, reasoningCapabilityIsActionable, renderReasoningCapabilityStatus, reasoningCapabilityStatusText, reasoningDiscoveryStatusText, probeModelCapabilities, setFormControlsSaving, setModelConfigFormSaving, renderModelConfigFailure, clearModelConfigFailure, manualAgentModelIds, sourceLabel, formatContextUsage, firstFiniteNumber, formatTokenCount, trimNumber, nonNegativeInteger, collapseCompletedActivities, clearAssistantDrafts, collapseAssistantDrafts, isMeaningfulCompletedActivity, isDuplicateDraftText, normalizeComparableText, showApproval, resolveApproval, hideApproval, showQuestion, revealInteractionPanel, renderQuestionPanel, reviewQuestionConversation, returnToQuestion, activateQuestionReviewBackground, deactivateQuestionReviewBackground, questionChoiceButton, toggleQuestionChoice, submitQuestion, cancelQuestion, finishQuestionSubmission, hideQuestion, showTrustPanel, renderTrustPanel, confirmTrust, renderQueuePanel, renderQueueItem, setPendingGuide, clearPendingGuide, syncPendingGuideFromQueue, renderGuideFeedback, guideCopy, guideSource, guideTurnFromQueue, guideButtonText, guideButtonDisabled, guideButtonVisible, syncGuideButton, shouldKeepGuideFeedback, isInterruptError, updateSendButton, showContextConfirm, hideContextConfirm, runContextAction, contextActionRequestOptions, contextSummaryLine, compactResultLine, rememberQuestionDraft, questionResolutionText, showShutdownPanel, hideShutdownPanel, shutdownDashboard, lockClosedDashboard, normalizeLifecycleActivity, shutdownRequestBody, shutdownResultIsClosed, lifecycleActivitySummary, renderShutdownActivity, renderFiles, currentImageFiles, openFile, renderOfficePreview, officePreviewMeta, officePreviewBodyHtml, renderTablePreview, normalizeTablePreview, tablePreviewMeta, renderCompactTableHtml, renderExpandedTableHtml, renderTableHtml, tableTruncationNote, maxVisibleColumns, columnLabel, renderSheetPreviewHtml, renderSheetCellHtml, resetPreview, fencedDataForFile, dataLanguageForExtension, showImageLightbox, showTableLightbox, renderLightboxImage, bindTableLightboxControls, moveLightbox, hideLightbox, setPermissionMode, clearTranscript, cancelTranscriptAnimationFrames, clearAssistantDraftTimers, hideEmptyState, showError, showNotice, renderBootstrapLoading, renderBootstrapFailure, dashboardPayloadError, bootstrapFailurePresentation, clearBootstrapStatus, scrollTranscript, isTranscriptNearBottom, syncTranscriptFollowState, followTranscript, updateTranscriptJump, beginScopedRequest, isCurrentScopedRequest, finishScopedRequest, cancelScopedRequest, isAbortError, getJson, postJson, deleteJson, dashboardFetch, responseJson, dashboardJsonHeaders, dashboardCsrfToken, messageText, messageDisplayText, userMessageDisplayText, normalizeAttachmentMetadata, imageAttachmentLine, renderMessageText, renderLinkedText, bindRichContent, linkifyFileTextNodes, replaceFileReferences, isLikelyLocalFileReference, resolveDisplayFilePath, normalizeFileReferencePath, parentDirectory, filePreviewUrl, rawFileUrl, apiFileUrl, imagePreviewUrl, isSafeInlineBitmapUrl, normalizeRelativePath, isWorkspaceRelativeToBase, copyCodeBlock, previewText, formatNumber, formatBytes, escapeHtml, escapeAttribute, formatTime, formatRelativeTime } from "./app-barrel.ts";
export async function saveModelConfig(event: Event) {
  event.preventDefault();
  if (state.modelConfigSaving) {
    return;
  }
  const form = eventTargetOf(event).closest("form");
  if (!(form instanceof HTMLFormElement)) {
    return;
  }
  const data = new FormData(form);
  const editingProfile = gatewayProfileById(state.editingGatewayProfileId);
  const profile = editingProfile ?? currentGatewayProfile();
  const credentialAction = gatewayCredentialAction(data, profile ?? state.gatewayConfig);
  const scope = configScope(data.get("saveTarget"), "global") || "global";
  const discoveryToken = state.modelCapabilityDiscoveryToken
    || currentGatewayProbeResult(form)?.discoveryToken
    || "";
  const payload = {
    saveTarget: scope,
    ...configMutationMetadata(scope),
    profileId: editingProfile?.id || "",
    providerId: editingProfile?.id || "",
    clientId: dashboardClientId(),
    gatewayUrl: data.get("gatewayUrl"),
    gatewayProtocol: data.get("gatewayProtocol"),
    gatewayApiKey: data.get("gatewayApiKey"),
    credentialAction,
    gatewayHealthUrl: data.get("gatewayHealthUrl"),
    previousModelId: state.editingModelId,
    previousGatewayUrl: state.gatewayConfig?.gatewayUrl,
    previousGatewayProtocol: state.gatewayConfig?.gatewayProtocol || "openai-chat",
    modelId: data.get("modelId"),
    label: data.get("label"),
    contextTokens: data.get("contextTokens"),
    agentCheapModel: data.get("agentCheapModel"),
    agentDefaultModel: data.get("agentDefaultModel"),
    agentStrongModel: data.get("agentStrongModel"),
    visionAgentModel: data.get("visionAgentModel"),
    gatewayDiscoveryToken: discoveryToken,
    manualAgentModelIds: manualAgentModelIds(form),
    modalities: data.get("vision") ? ["text", "image"] : ["text"],
    thinking: data.get("thinking") === "on",
    reasoningEfforts: data.getAll("reasoningEfforts").map(String),
    defaultReasoningEffort: data.get("defaultReasoningEffort") || null,
    switchToModel: data.get("switchToModel") === "on",
    applyAgentDefaults: data.get("applyAgentDefaults") === "on",
    sessionId: state.currentSessionId
  };
  if (profile) {
    payload.previousGatewayUrl = profile.gatewayUrl || payload.previousGatewayUrl;
    payload.previousGatewayProtocol = profile.gatewayProtocol || payload.previousGatewayProtocol;
  }
  state.modelConfigSaving = true;
  clearModelConfigFailure(form);
  setModelConfigFormSaving(form, true);
  try {
    const result = await postJson("/api/model-config", payload);
    if (!result.ok) {
      updateConfigRevisions({ ...result, scope });
      throw Object.assign(new Error(isConfigRevisionConflict(result) ? configRevisionConflictMessage() : result.error ?? "保存模型配置失败"), {
        configConflict: isConfigRevisionConflict(result)
      });
    }
    updateConfigRevisions({ ...result, scope });
    state.models = normalizeModels(result.models);
    mergeGatewayConfig(result.gatewayConfig);
    state.gatewayProfiles = normalizeGatewayProfiles(result.gatewayProfiles);
    state.agentModelTiers = normalizeAgentModelTiers(result.agentModelTiers);
    state.visionAgent = normalizeVisionAgent(result.visionAgent);
    updateSessionStatus(result.sessionStatus);
    if (!state.currentSessionId) rememberNewTaskModelState();
    state.modelConfigSaving = false;
    hideModelConfigPanel();
    hideModelPanel();
    renderSettingsView();
    renderComposerStatus();
    if (payload.switchToModel) {
      const defaultModelId = String(result.modelId ?? payload.modelId ?? "").trim();
      showNotice("模型配置已保存", `${modelSaveTargetLabel(payload.saveTarget)}，默认模型已设为 ${modelDisplayName(defaultModelId, String(payload.label || payload.modelId || ""))}`);
    } else {
      showNotice("模型配置已保存", `${modelSaveTargetLabel(payload.saveTarget)}已更新`);
    }
  } catch (error) {
    if (isPlainObject(error) && error.configConflict) await refreshConfigRevisionsAfterConflict();
    state.modelConfigSaving = false;
    setModelConfigFormSaving(form, false);
    const message = error instanceof Error ? error.message : "保存模型配置失败";
    renderModelConfigFailure(form, message);
    announceStatus(message);
    renderComposerStatus();
  }
}

/** @param {string} modelId @param {string} providerId @param {"global" | "project"} scope */
export async function saveDefaultModelSelection(modelId: string | null | undefined, providerId: string | null | undefined, scope: "global" | "project") {
  if (!modelId || !providerId || state.modelSwitching || state.settingsRefreshing) return;
  const model = gatewayProfileById(providerId)?.models?.find((candidate) => candidate.id === modelId)
    ?? currentModelInfo(modelId)
    ?? null;
  const reasoningEffort = normalizedReasoningEffort(model?.defaultReasoningEffort) || null;
  state.modelSwitching = true;
  state.settingsFeedback = null;
  renderSettingsView();
  try {
    const result = await postJson("/api/default-model", {
      scope,
      providerId,
      modelId,
      reasoningEffort,
      expectedRevision: state.configRevisions[scope] || undefined
    });
    if (!result.ok) {
      updateConfigRevisions({ ...result, scope });
      throw Object.assign(new Error(isConfigRevisionConflict(result) ? configRevisionConflictMessage() : result.error ?? "保存默认模型失败"), {
        configConflict: isConfigRevisionConflict(result)
      });
    }
    updateConfigRevisions({ ...result, scope });
    if (Array.isArray(result.models)) state.models = normalizeModels(result.models);
    if (result.gatewayConfig) mergeGatewayConfig(result.gatewayConfig);
    if (Array.isArray(result.gatewayProfiles)) state.gatewayProfiles = normalizeGatewayProfiles(result.gatewayProfiles);
    state.settingsFeedback = { tone: "success", message: scope === "global" ? "全局默认模型已保存" : "当前项目默认模型已保存" };
    announceStatus(state.settingsFeedback.message);
  } catch (error) {
    if (isPlainObject(error) && error.configConflict) await refreshConfigRevisionsAfterConflict();
    state.settingsFeedback = { tone: "error", message: error instanceof Error ? error.message : "保存默认模型失败" };
    announceStatus(state.settingsFeedback.message);
  } finally {
    state.modelSwitching = false;
    renderSettingsView();
  }
}

/** @param {string} modelId @param {{ profileId?: string, reasoningEffort?: string | null, keepPanelOpen?: boolean }} [options] */
export async function switchModel(modelId: string, options: { profileId?: string, reasoningEffort?: string | null, keepPanelOpen?: boolean } = {}) {
  if (!modelId || state.modelSwitching) {
    return;
  }
  const requestSessionId = state.currentSessionId;
  const requestClientId = requestSessionId ? undefined : dashboardClientId();
  state.modelSwitching = true;
  renderComposerStatus();
  renderModelPanel();
  renderSettingsView();
  try {
    const providerId = options.profileId || currentGatewayProfile()?.id || "";
    const reasoningEffort = options.reasoningEffort ?? null;
    const result = await postJson("/api/model", {
      modelId,
      profileId: providerId || undefined,
      providerId: providerId || undefined,
      reasoningEffort,
      sessionId: requestSessionId,
      clientId: requestClientId,
      applyAgentDefaults: state.applyAgentDefaultsOnSwitch
    });
    if (!result.ok) {
      throw new Error(result.error ?? "切换模型失败");
    }
    if (state.currentSessionId !== requestSessionId) return;
    state.models = normalizeModels(result.models);
    mergeGatewayConfig(result.gatewayConfig);
    state.gatewayProfiles = normalizeGatewayProfiles(result.gatewayProfiles);
    state.agentModelTiers = normalizeAgentModelTiers(result.agentModelTiers);
    state.visionAgent = normalizeVisionAgent(result.visionAgent);
    updateSessionStatus({
      ...result.sessionStatus,
      providerId: result.sessionStatus?.providerId ?? providerId,
      selectionResolved: result.sessionStatus?.selectionResolved ?? true,
      selectionIssue: result.sessionStatus?.selectionIssue ?? null
    });
    if (!state.currentSessionId) rememberNewTaskModelState();
    if (options.keepPanelOpen) renderModelPanel();
    else hideModelPanel();
    announceStatus(`模型已切换为 ${modelDisplayName(modelId)}`);
  } catch (error) {
    if (state.currentSessionId === requestSessionId) {
      showError(errorMessageOf(error) || "切换模型失败");
    }
  } finally {
    state.modelSwitching = false;
    renderComposerStatus();
    renderModelPanel();
    renderSettingsView();
    updateSendButton();
  }
}

/** @param {any} event */
export async function handleReasoningEffortChange(event: Event) {
  const select = eventTargetOf(event).closest("#reasoning-effort-select");
  if (!select || select.disabled) return;
  await switchReasoningEffort(select.value);
}

/** @param {string} reasoningEffort */
export async function switchReasoningEffort(reasoningEffort: string) {
  if (state.reasoningEffortSwitching || state.running || state.modelSwitching) {
    return;
  }
  const selection = currentModelSelection();
  if (selection.resolved === false || !selection.profile || !selection.model) {
    showError("请先重新选择模型来源和模型");
    return;
  }
  const requestSessionId = state.currentSessionId;
  const requestClientId = requestSessionId ? undefined : dashboardClientId();
  state.reasoningEffortSwitching = true;
  renderComposerStatus();
  try {
    const normalized = normalizedReasoningEffort(reasoningEffort);
    const result = await postJson("/api/reasoning-effort", {
      providerId: selection.profile.id,
      modelId: selection.model.id,
      reasoningEffort: normalized || null,
      sessionId: requestSessionId,
      clientId: requestClientId
    });
    if (!result.ok) {
      throw new Error(result.error ?? "调整思考强度失败");
    }
    if (state.currentSessionId !== requestSessionId) return;
    if (Array.isArray(result.models)) state.models = normalizeModels(result.models);
    if (result.gatewayConfig) mergeGatewayConfig(result.gatewayConfig);
    if (Array.isArray(result.gatewayProfiles)) state.gatewayProfiles = normalizeGatewayProfiles(result.gatewayProfiles);
    updateSessionStatus(result.sessionStatus ?? { reasoningEffort: normalized || null });
    if (!state.currentSessionId) rememberNewTaskModelState();
    announceStatus(`思考强度已设为 ${normalized ? reasoningEffortLabel(normalized) : "默认"}`);
  } catch (error) {
    if (state.currentSessionId === requestSessionId) {
      showError(errorMessageOf(error) || "调整思考强度失败");
    }
  } finally {
    state.reasoningEffortSwitching = false;
    renderComposerStatus();
    renderSettingsView();
  }
}

/** @param {string} profileId */
export async function deleteGatewayProfile(profileId: string | null | undefined) {
  if (!profileId || state.deletingGatewayProfileId || state.modelSwitching) {
    return;
  }
  if (state.deleteConfirmGatewayProfileId !== profileId) {
    state.deleteConfirmGatewayProfileId = profileId;
    renderSettingsView();
    return;
  }
  state.deletingGatewayProfileId = profileId;
  renderSettingsView();
  const requestSessionId = state.currentSessionId;
  const profile = gatewayProfileById(profileId);
  const scope = configScope(profile?.saveTarget) || "project";
  try {
    const result = await deleteJson(`/api/gateway-profile/${encodeURIComponent(profileId)}`, {
      sessionId: requestSessionId,
      providerId: profileId,
      saveTarget: scope,
      ...configMutationMetadata(scope)
    });
    if (state.currentSessionId !== requestSessionId) return;
    if (!result.ok) {
      updateConfigRevisions({ ...result, scope });
      throw Object.assign(new Error(isConfigRevisionConflict(result) ? configRevisionConflictMessage() : result.error ?? "删除网关失败"), {
        configConflict: isConfigRevisionConflict(result)
      });
    }
    updateConfigRevisions({ ...result, scope });
    // @ts-ignore Historical Dashboard state inference treats initialized arrays as never[].
    state.models = normalizeModels(result.models);
    mergeGatewayConfig(result.gatewayConfig);
    // @ts-ignore Historical Dashboard state inference treats initialized arrays as never[].
    state.gatewayProfiles = normalizeGatewayProfiles(result.gatewayProfiles);
    state.agentModelTiers = normalizeAgentModelTiers(result.agentModelTiers);
    // @ts-ignore Historical Dashboard state inference treats the initial null as permanent.
    state.visionAgent = normalizeVisionAgent(result.visionAgent);
    updateSessionStatus(result.sessionStatus);
    state.deleteConfirmGatewayProfileId = "";
    renderSettingsView();
    showNotice(result.clearedGateway ? "当前网关已删除" : "网关档案已删除");
  } catch (error) {
    if (state.currentSessionId !== requestSessionId) return;
    if (isPlainObject(error) && error.configConflict) {
      await refreshConfigRevisionsAfterConflict();
      state.settingsFeedback = { tone: "error", message: errorMessageOf(error) };
    }
    showError(error instanceof Error ? error.message : "删除网关失败");
  } finally {
    state.deletingGatewayProfileId = "";
    renderSettingsView();
    renderComposerStatus();
  }
}

export async function deleteModel(modelId: string | null | undefined, options: { profileId?: string; saveTarget?: unknown } = {}) {
  const providerId = options.profileId || currentGatewayProfile()?.id || "";
  const modelKey = providerModelKey(providerId, modelId);
  if (!modelId || !providerId || state.deletingModelKey || state.modelSwitching) {
    return;
  }
  if (state.deleteConfirmModelKey !== modelKey) {
    state.deleteConfirmModelKey = modelKey;
    renderSettingsView();
    return;
  }
  state.deletingModelKey = modelKey;
  renderSettingsView();
  renderComposerStatus();
  const requestSessionId = state.currentSessionId;
  const scope = configScope(options.saveTarget || currentGatewayProfile()?.saveTarget) || "project";
  try {
    const result = await deleteJson(`/api/model-config/${encodeURIComponent(modelId)}`, {
      sessionId: requestSessionId,
      profileId: providerId,
      providerId,
      saveTarget: scope,
      ...configMutationMetadata(scope)
    });
    if (state.currentSessionId !== requestSessionId) return;
    if (!result.ok) {
      updateConfigRevisions({ ...result, scope });
      throw Object.assign(new Error(isConfigRevisionConflict(result) ? configRevisionConflictMessage() : result.error ?? "删除模型失败"), {
        configConflict: isConfigRevisionConflict(result)
      });
    }
    updateConfigRevisions({ ...result, scope });
    state.models = normalizeModels(result.models);
    mergeGatewayConfig(result.gatewayConfig);
    state.gatewayProfiles = normalizeGatewayProfiles(result.gatewayProfiles);
    state.agentModelTiers = normalizeAgentModelTiers(result.agentModelTiers);
    state.visionAgent = normalizeVisionAgent(result.visionAgent);
    state.deleteConfirmModelKey = "";
    updateSessionStatus(result.sessionStatus);
    renderSettingsView();
    showNotice(result.clearedGateway ? "当前网关配置已清空" : "模型配置已删除");
  } catch (error) {
    if (state.currentSessionId !== requestSessionId) return;
    if (isPlainObject(error) && error.configConflict) {
      await refreshConfigRevisionsAfterConflict();
      state.settingsFeedback = { tone: "error", message: errorMessageOf(error) };
    }
    showError(errorMessageOf(error) || "删除模型失败");
  } finally {
    state.deletingModelKey = "";
    renderSettingsView();
    renderComposerStatus();
  }
}

/** @param {any} payload */
export function updateConfigRevisions(payload: {
  settings?: unknown;
  configV2?: { revisions?: unknown; paths?: unknown; defaultSelections?: unknown };
  modelSettings?: unknown;
  configuration?: unknown;
  configRevisions?: unknown;
  settingsRevisions?: unknown;
  revisions?: unknown;
  settingsDocuments?: unknown;
  [key: string]: unknown;
} | null | undefined) {
  const record = isPlainObject(payload) ? payload : {};
  const settings = isPlainObject(record.settings) ? record.settings : {};
  const configV2 = isPlainObject(record.configV2) ? record.configV2 : {};
  const modelSettings = isPlainObject(record.modelSettings) ? record.modelSettings : {};
  const configuration = isPlainObject(record.configuration) ? record.configuration : {};
  const containers = [
    record.configRevisions,
    record.settingsRevisions,
    record.revisions,
    settings.configRevisions,
    payload?.configV2?.revisions,
    configV2.revisions,
    modelSettings.revisions,
    configuration.revisions,
    record.settingsDocuments
  ];
  for (const scope of ["global", "project", "credentials"] as const) {
    for (const container of containers) {
      const containerRecord = isPlainObject(container) ? container : null;
      const entry = containerRecord?.[scope];
      const revision = typeof entry === "string" ? entry : isPlainObject(entry) ? String(entry.revision ?? "").trim() : "";
      if (revision) {
        state.configRevisions[scope] = revision;
        break;
      }
    }
  }
  const pathsValue = configV2.paths ?? modelSettings.paths;
  const paths = isPlainObject(pathsValue) ? pathsValue : null;
  if (paths) {
    state.configPaths.global = String(paths.global ?? state.configPaths.global);
    state.configPaths.project = String(paths.project ?? state.configPaths.project);
  }
  const defaultSelections = isPlainObject(configV2.defaultSelections) ? configV2.defaultSelections : null;
  if (defaultSelections) {
    state.modelDefaultSelections = {
      global: normalizeScopedDefaultSelection(defaultSelections.global),
      project: normalizeScopedDefaultSelection(defaultSelections.project)
    };
  }
  const mutationScope = configScope(record.scope ?? record.saveTarget, "");
  const mutationRevision = String(record.revision ?? record.currentRevision ?? "").trim();
  if ((mutationScope === "global" || mutationScope === "project") && mutationRevision) {
    state.configRevisions[mutationScope] = mutationRevision;
  }
}

/** @param {any} value */
export function normalizeScopedDefaultSelection(value: unknown): DashboardScopedDefaultSelection | null {
  const record = isPlainObject(value) ? value : {};
  const provider = String(record.provider ?? "").trim();
  const model = String(record.model ?? "").trim();
  if (!provider || !model) return null;
  const reasoningEffort = normalizedReasoningEffort(record.reasoningEffort);
  return { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) };
}

/** @param {any} value @param {"global" | "project" | ""} [fallback] */
export function configScope(value: unknown, fallback?: "global" | "project"): "global" | "project";
export function configScope(value: unknown, fallback: "global" | "project" | ""): "global" | "project" | "";
export function configScope(value: unknown, fallback: "global" | "project" | "" = "project") {
  return value === "global" ? "global" : value === "project" ? "project" : fallback;
}

/** @param {"global" | "project"} scope */
export function configMutationMetadata(scope: "global" | "project") {
  return {
    scope,
    expectedRevision: state.configRevisions[scope] || undefined,
    expectedCredentialsRevision: state.configRevisions.credentials || undefined
  };
}

/** @param {any} result */
export function isConfigRevisionConflict(result: DashboardApiResult | Record<string, unknown> | null | undefined) {
  return result?.code === "CONFIG_REVISION_CONFLICT";
}

export function configRevisionConflictMessage() {
  return "配置已在另一个窗口更新。当前草稿已保留，再次保存会基于最新版本应用这份草稿。";
}

export async function refreshConfigRevisionsAfterConflict() {
  const result = await getJson(statusUrl()).catch(() => null);
  if (result?.ok) updateConfigRevisions(result);
}

export function normalizeGatewayConfig(value: unknown): DashboardGatewayConfig {
  const record = isPlainObject(value) ? value : {};
  const transport = isPlainObject(record.transport) ? record.transport : {};
  const sources = isPlainObject(record.sources) ? record.sources : {};
  return {
    gatewayUrl: String(record.gatewayUrl ?? transport.baseURL ?? ""),
    gatewayHealthUrl: String(record.gatewayHealthUrl ?? transport.healthURL ?? ""),
    gatewayProtocol: String(record.gatewayProtocol ?? transport.protocol ?? "openai-chat"),
    apiKeyConfigured: record.apiKeyConfigured === true,
    activeProfileId: String(record.activeProfileId ?? record.providerId ?? ""),
    globalSettingsPath: String(record.globalSettingsPath ?? ""),
    projectSettingsPath: String(record.projectSettingsPath ?? ""),
    globalConfigPath: String(record.globalConfigPath ?? ""),
    projectConfigPath: String(record.projectConfigPath ?? ""),
    sources: {
      gatewayUrl: normalizeConfigSource(sources.gatewayUrl),
      gatewayHealthUrl: normalizeConfigSource(sources.gatewayHealthUrl),
      gatewayProtocol: normalizeConfigSource(sources.gatewayProtocol),
      apiKey: normalizeConfigSource(sources.apiKey)
    }
  };
}

export function normalizeDashboardSettings(value: unknown): DashboardSettings {
  const record = isPlainObject(value) ? value : {};
  const transcript = isPlainObject(record.transcript) ? record.transcript : {};
  const network = isPlainObject(record.network) ? record.network : {};
  const agents = isPlainObject(record.agents) ? record.agents : {};
  const reliability = isPlainObject(record.reliability) ? record.reliability : {};
  const managed = isPlainObject(record.managed) ? record.managed : {};
  return {
    transcript: {
      enabled: transcript.enabled !== false,
      retentionDays: transcript.retentionDays === null
        ? null
        : Number.isInteger(Number(transcript.retentionDays)) ? Number(transcript.retentionDays) : 30,
      encryption: transcript.encryption === "off" || transcript.encryption === "optional" || transcript.encryption === "required" ? transcript.encryption : "off",
      encryptionKeyConfigured: transcript.encryptionKeyConfigured === true
    },
    network: {
      mode: network.mode === "offline" || network.mode === "lab-only" || network.mode === "approved-web" || network.mode === "open-dev" ? network.mode : "approved-web",
      allowedModes: Array.isArray(network.allowedModes)
        ? network.allowedModes.map(String).filter((mode) => mode === "offline" || mode === "lab-only" || mode === "approved-web" || mode === "open-dev")
        : ["offline", "lab-only", "approved-web", "open-dev"],
      allowedHosts: Array.isArray(network.allowedHosts) ? network.allowedHosts.map(String) : [],
      managedAllowedHosts: Array.isArray(network.managedAllowedHosts) ? network.managedAllowedHosts.map(String) : []
    },
    agents: {
      maxParallelReadonlyAgentRuns: Math.min(8, Math.max(1, Number(agents.maxParallelReadonlyAgentRuns) || 3)),
      backgroundWakeupEnabled: agents.backgroundWakeupEnabled !== false,
      backgroundByDefault: agents.backgroundByDefault === true,
      reviewGateEnabled: agents.reviewGateEnabled !== false,
      syncModelTiersOnSwitch: agents.syncModelTiersOnSwitch !== false,
      goalMaxAutoContinues: Math.min(100, Math.max(1, Number(agents.goalMaxAutoContinues) || 12))
    },
    reliability: {
      maxRetries: Math.min(5, Math.max(0, Number(reliability.maxRetries) || 0)),
      timeoutMs: Math.min(900000, Math.max(1000, Number(reliability.timeoutMs) || 900000)),
      idleTimeoutMs: Math.min(300000, Math.max(1000, Number(reliability.idleTimeoutMs) || 300000))
    },
    managed: {
      transcriptEnabled: managed.transcriptEnabled === true,
      transcriptRetentionDays: managed.transcriptRetentionDays === true,
      transcriptEncryption: managed.transcriptEncryption === true,
      networkMode: managed.networkMode === true,
      gatewayMaxRetries: managed.gatewayMaxRetries === true,
      gatewayTimeoutMs: managed.gatewayTimeoutMs === true,
      gatewayIdleTimeoutMs: managed.gatewayIdleTimeoutMs === true
    }
  };
}

export function mergeGatewayConfig(value: unknown) {
  if (!value || typeof value !== "object") {
    return;
  }
  state.gatewayConfig = normalizeGatewayConfig(value);
}

export function normalizeGatewayProfiles(value: unknown): DashboardGatewayProfile[] {
  return Array.isArray(value) ? value.map((profileValue) => {
    const profile = isPlainObject(profileValue) ? profileValue : {};
    const transport = isPlainObject(profile.transport) ? profile.transport : {};
    return {
    id: String(profile.id ?? profile.providerId ?? ""),
    label: String(profile.label ?? profile.displayName ?? profile.id ?? profile.providerId ?? ""),
    gatewayUrl: String(profile.gatewayUrl ?? transport.baseURL ?? ""),
    gatewayHealthUrl: String(profile.gatewayHealthUrl ?? transport.healthURL ?? ""),
    gatewayProtocol: String(profile.gatewayProtocol ?? transport.protocol ?? "openai-chat"),
    apiKeyConfigured: profile.apiKeyConfigured === true || profile.credentialConfigured === true,
    modelAlias: String(profile.modelAlias ?? ""),
    modelCount: Number.isFinite(Number(profile.modelCount)) ? Number(profile.modelCount) : 0,
    ready: profile.ready !== false,
    ownerScope: String(profile.ownerScope ?? profile.scope ?? ""),
    editable: profile.editable !== false,
    saveTarget: configScope(profile.saveTarget ?? profile.scope, ""),
    agentModelTiers: normalizeAgentModelTiers(profile.agentModelTiers),
    visionAgent: normalizeVisionAgent(profile.visionAgent),
    models: normalizeModels(profile.models).map((model) => ({
      ...model,
      source: typeof model.source === "object" && model.source?.profileId ? model.source : {
        id: String(profile.id ?? profile.providerId ?? ""),
        label: String(profile.label ?? profile.displayName ?? profile.id ?? profile.providerId ?? ""),
        profileId: String(profile.id ?? profile.providerId ?? ""),
        ownerScope: "",
        saveTarget: "",
        editable: true
      }
    })),
    current: profile.current === true
  };
  }).filter((profile) => profile.id) : [];
}

export function normalizeConfigSource(value: unknown): DashboardConfigSource {
  const record = isPlainObject(value) ? value : {};
  return {
    type: String(record.type ?? "default"),
    label: String(record.label ?? record.type ?? "default")
  };
}

export function normalizeModels(models: unknown): DashboardModelOption[] {
  return Array.isArray(models) ? models.map((modelValue) => {
    const model = isPlainObject(modelValue) ? modelValue : {};
    const reasoning = isPlainObject(model.reasoning) ? model.reasoning : {};
    const sources = isPlainObject(model.sources) ? model.sources : {};
    const modalities = model.modalities ?? model.inputModalities;
    return {
    id: String(model.id ?? ""),
    label: String(model.label ?? model.displayName ?? model.id ?? ""),
    description: String(model.description ?? ""),
    thinking: model.thinking === true,
    modalities: Array.isArray(modalities) ? modalities.map(String) : ["text"],
    contextTokens: Number.isFinite(Number(model.contextTokens ?? model.contextWindow)) ? Number(model.contextTokens ?? model.contextWindow) : null,
    reasoningEfforts: normalizeReasoningEfforts(model.reasoningEfforts ?? reasoning.efforts),
    defaultReasoningEffort: normalizedReasoningEffort(model.defaultReasoningEffort ?? reasoning.default),
    reasoningEffort: normalizedReasoningEffort(model.reasoningEffort),
    agentModelTiers: normalizeAgentModelTiers(model.agentModelTiers),
    source: normalizeModelSource(model.source),
    sources: {
      modelAlias: normalizeConfigSource(sources.modelAlias),
      models: normalizeConfigSource(sources.models)
    },
    current: model.current === true,
    default: model.default === true
  };
  }).filter((model) => model.id) : [];
}

/** @param {any} value */
export function normalizeModelSource(value: unknown): DashboardModelSource {
  if (typeof value === "string") {
    return { id: value, label: value, profileId: "", ownerScope: "", saveTarget: "", editable: true };
  }
  const record = isPlainObject(value) ? value : {};
  return {
    id: String(record.id ?? record.profileId ?? record.providerId ?? ""),
    label: String(record.label ?? record.name ?? record.displayName ?? record.id ?? record.providerId ?? ""),
    profileId: String(record.profileId ?? record.providerId ?? record.id ?? ""),
    ownerScope: String(record.ownerScope ?? record.scope ?? ""),
    saveTarget: configScope(record.saveTarget ?? record.scope, ""),
    editable: record.editable !== false
  };
}

/** @param {any} value */
export function normalizeReasoningEfforts(value: unknown): DashboardReasoningEffort[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.map((effort) => {
    if (typeof effort === "string") {
      return { id: effort, label: reasoningEffortFallbackLabel(effort), description: "" };
    }
    const record = isPlainObject(effort) ? effort : {};
    const id = String(record.id ?? record.value ?? "").trim().toLowerCase();
    const label = String(record.label ?? record.name ?? "").trim();
    return {
      id,
      label: localizedReasoningEffortLabel(id, label),
      description: String(record.description ?? "")
    };
  }).filter((effort) => {
    if (!effort.id) return false;
    const key = isDisabledReasoningEffort(effort.id) ? "disabled" : effort.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** @param {any} value */
export function normalizedReasoningEffort(value: unknown) {
  const effort = String(value ?? "").trim().toLowerCase();
  return effort === "default" ? "" : effort;
}

/** @param {any} value */
export function isDisabledReasoningEffort(value: unknown) {
  return ["none", "off"].includes(normalizedReasoningEffort(value));
}

/** @param {any} value @param {any[]} efforts */
export function configuredReasoningEffort(value: unknown, efforts: unknown[]) {
  const requested = normalizedReasoningEffort(value);
  if (!isDisabledReasoningEffort(requested)) return requested;
  return normalizeReasoningEfforts(efforts).find((effort: DashboardReasoningEffort) => isDisabledReasoningEffort(effort.id))?.id ?? requested;
}

/** @param {any} effort */
export function reasoningEffortFallbackLabel(effort: string | DashboardReasoningEffort) {
  const labels: Record<string, string> = {
    none: "关闭",
    off: "关闭",
    minimal: "最低",
    low: "低",
    medium: "中",
    high: "高",
    xhigh: "极高",
    max: "最高",
    ultra: "极致"
  };
  return labels[String(effort ?? "").toLowerCase()] || String(effort ?? "");
}

/** @param {string} id @param {string} label */
export function localizedReasoningEffortLabel(id: string, label: string) {
  const defaultEnglishLabels: Record<string, string> = {
    none: "off",
    off: "off",
    minimal: "minimal",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "extra high",
    max: "max",
    ultra: "ultra"
  };
  const normalizedLabel = String(label ?? "").trim();
  if (!normalizedLabel || normalizedLabel.toLowerCase() === defaultEnglishLabels[id]) {
    return reasoningEffortFallbackLabel(id);
  }
  return normalizedLabel;
}

/** @param {any[]} [configured] */
export function reasoningEffortCatalog(configured: unknown[] = []) {
  const normalizedConfigured = normalizeReasoningEfforts(configured);
  const disabledId = normalizedConfigured.find((effort: DashboardReasoningEffort) => isDisabledReasoningEffort(effort.id))?.id ?? "off";
  const catalog = [disabledId, "low", "medium", "high", "xhigh", "max", "ultra"].map((id: string) => ({ id, label: reasoningEffortFallbackLabel(id), description: "" }));
  for (const effort of normalizedConfigured) {
    const index = catalog.findIndex((item) => item.id === effort.id);
    if (index >= 0) catalog[index] = effort;
    else catalog.push(effort);
  }
  return catalog;
}

/** @param {any} value */
export function reasoningEffortLabel(value: unknown) {
  const id = normalizedReasoningEffort(value);
  return normalizeReasoningEfforts(currentModelInfo(state.sessionStatus?.model)?.reasoningEfforts).find((effort: DashboardReasoningEffort) => effort.id === id)?.label
    || reasoningEffortFallbackLabel(id);
}

/**
 * Resolve provider and model together. A model-only legacy selection may infer
 * its provider only when exactly one configured provider owns that model id.
 *
 * @param {{ profiles?: any[], providerId?: unknown, modelId?: unknown, fallbackProviderId?: unknown, fallbackModelId?: unknown, allowFallback?: boolean, selectionResolved?: unknown, selectionIssue?: unknown }} [options]
 */
export function resolveAtomicModelSelection(options: { profiles?: DashboardGatewayProfile[], providerId?: unknown, modelId?: unknown, fallbackProviderId?: unknown, fallbackModelId?: unknown, allowFallback?: boolean, selectionResolved?: unknown, selectionIssue?: unknown } = {}): DashboardModelSelection {
  const profiles = Array.isArray(options.profiles) ? options.profiles : [];
  const providerId = String(options.providerId ?? "").trim();
  const modelId = String(options.modelId ?? "").trim();
  const authoritativeUnresolved = options.selectionResolved === false;

  if (!authoritativeUnresolved && providerId) {
    const profile = profiles.find((candidate) => candidate.id === providerId) ?? null;
    const model = Array.isArray(profile?.models)
      ? profile.models.find((candidate) => candidate.id === modelId) ?? null
      : null;
    if (profile && model) return { profile, model, resolved: true, issue: null };
  }

  if (!authoritativeUnresolved && !providerId && modelId) {
    const matches = profiles.flatMap((profile) => {
      const model = Array.isArray(profile.models)
        ? profile.models.find((candidate) => candidate.id === modelId) ?? null
        : null;
      return model ? [{ profile, model }] : [];
    });
    if (matches.length === 1) return { ...matches[0], resolved: true, issue: null };
  }

  return options.allowFallback === true ? fallbackSelection() : unresolvedSelection();

  function fallbackSelection() {
    const fallbackProviderId = String(options.fallbackProviderId ?? "").trim();
    const fallbackModelId = String(options.fallbackModelId ?? "").trim();
    const profile = profiles.find((candidate) => candidate.id === fallbackProviderId)
      ?? profiles.find((candidate) => candidate.current === true)
      ?? (profiles.length === 1 ? profiles[0] : null);
    if (!profile || !Array.isArray(profile.models)) return unresolvedSelection();
    const model = profile.models.find((candidate) => candidate.id === fallbackModelId)
      ?? profile.models.find((candidate) => candidate.id === profile.modelAlias)
      ?? profile.models.find((candidate) => candidate.current === true)
      ?? profile.models[0]
      ?? null;
    return model
      ? { profile, model, resolved: true, issue: null }
      : unresolvedSelection();
  }

  function unresolvedSelection() {
    return {
      profile: null,
      model: null,
      resolved: false,
      issue: typeof options.selectionIssue === "string" ? options.selectionIssue : (authoritativeUnresolved ? "unresolved" : "model-not-uniquely-resolved")
    };
  }
}

export function currentModelSelection(): DashboardModelSelection {
  const status: DashboardSessionStatus = state.sessionStatus ?? emptySessionStatus;
  const fallback = state.newTaskModelState;
  return resolveAtomicModelSelection({
    profiles: state.gatewayProfiles,
    providerId: status.providerId ?? status.provider ?? status.profileId ?? status.gatewayProfileId,
    modelId: status.model,
    fallbackProviderId: fallback?.gatewayConfig?.activeProfileId ?? state.gatewayConfig?.activeProfileId,
    fallbackModelId: fallback?.sessionStatus?.model ?? state.gatewayConfig?.modelAlias,
    allowFallback: !state.currentSessionId,
    selectionResolved: status.selectionResolved,
    selectionIssue: status.selectionIssue
  });
}

export function currentSessionNeedsModelSelection() {
  return Boolean(state.currentSessionId) && currentModelSelection().resolved === false;
}

export function currentGatewayProfile() {
  return currentModelSelection().profile;
}

/** @param {string} profileId */
export function gatewayProfileById(profileId: string | null | undefined) {
  const id = String(profileId ?? "").trim();
  return id ? (state.gatewayProfiles ?? []).find((profile) => profile.id === id) ?? null : null;
}

export function settingsInspectedGatewayProfile() {
  const profiles = state.gatewayProfiles ?? [];
  return gatewayProfileById(state.settingsProviderId)
    ?? gatewayProfileById(state.gatewayConfig?.activeProfileId)
    ?? profiles.find((profile) => profile.current)
    ?? profiles[0]
    ?? null;
}

/** @param {any} model */
export function modelSourceLabel(model: DashboardModelOption | string | null | undefined) {
  const source = typeof model === "object" && model && typeof model.source === "object" ? model.source : null;
  const explicit = String(source?.label ?? "").trim();
  if (explicit) return explicit;
  const profile = currentGatewayProfile();
  if (profile?.label) return profile.label;
  const gatewayUrl = String(state.gatewayConfig?.gatewayUrl ?? "");
  try {
    return new URL(gatewayUrl).hostname || "未配置来源";
  } catch {
    return gatewayUrl || "未配置来源";
  }
}

/** @param {any[]} models @param {unknown} currentModel */
export function markCurrentModel(models: unknown[], currentModel: unknown) {
  const current = String(currentModel ?? "");
  return normalizeModels(models).map((model) => ({
    ...model,
    current: model.id === current
  }));
}

export function currentModelInfo(modelId: unknown) {
  const id = String(modelId ?? "").trim();
  if (!id) return null;
  const selected = currentModelSelection();
  if (selected.model?.id === id) return selected.model;
  const matches = (state.gatewayProfiles ?? []).flatMap((profile) => {
    const model = Array.isArray(profile.models)
      ? profile.models.find((candidate) => candidate.id === id) ?? null
      : null;
    return model ? [model] : [];
  });
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) return null;
  return (state.models ?? []).find((model) => model.id === id) ?? null;
}

export function modelDisplayName(modelId: unknown, fallback: unknown = "") {
  const id = String(modelId ?? "").trim();
  const fallbackLabel = String(fallback ?? "").trim();
  const model = currentModelInfo(id);
  return model?.label || fallbackLabel || id || "当前模型";
}

export function normalizeAgentModelTiers(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(Object.entries(value)
    .map(([tier, model]) => [String(tier ?? "").trim(), String(model ?? "").trim()])
    .filter(([tier, model]) => tier && model));
}

export function normalizeVisionAgent(value: unknown) {
  if (!isPlainObject(value)) {
    return { enabled: true, model: "", autoUseWhenMainModelTextOnly: true };
  }
  return {
    enabled: value.enabled !== false,
    model: String(value.model ?? "").trim(),
    autoUseWhenMainModelTextOnly: value.autoUseWhenMainModelTextOnly !== false
  };
}

export function firstVisionModelId() {
  return (state.models ?? []).find((model) => Array.isArray(model.modalities) && model.modalities.includes("image"))?.id ?? "";
}

export function hasAgentModelTiers(model: DashboardModelOption | null | undefined) {
  return Object.keys(normalizeAgentModelTiers(model?.agentModelTiers)).length > 0;
}

export function agentModelTiersSummary(value: unknown) {
  const tiers = normalizeAgentModelTiers(value);
  const ordered = ["cheap", "default", "strong"]
    .filter((tier) => tiers[tier])
    .map((tier) => `${tier}: ${tiers[tier]}`);
  return ordered.join(" · ");
}

export function gatewaySummary() {
  const gateway = state.gatewayConfig;
  const url = gateway?.gatewayUrl || "未配置网关";
  const key = gateway?.apiKeyConfigured ? `Key ${sourceBadge(gateway.sources?.apiKey)}` : "未配置 Key";
  const source = sourceBadge(gateway?.sources?.gatewayUrl || gateway?.sources?.gatewayProtocol);
  return `${url} · ${key} · ${source}`;
}

export function modelSaveTargetLabel(target: unknown) {
  return String(target) === "global" ? "全局默认" : "当前项目默认";
}

export function gatewaySourceNote(gateway: DashboardGatewayConfig | null | undefined) {
  const urlSource = sourceLabel(gateway?.sources?.gatewayUrl);
  const protocolSource = sourceLabel(gateway?.sources?.gatewayProtocol);
  const keySource = gateway?.apiKeyConfigured ? sourceLabel(gateway.sources?.apiKey) : "未配置";
  return `当前生效：网关来自${urlSource}，协议来自${protocolSource}，API Key 来自${keySource}。`;
}

export function environmentGatewayDefaultNote(gateway: DashboardGatewayConfig | null | undefined) {
  const sources = gateway?.sources;
  const envFields = [];
  if (sources?.gatewayUrl?.type === "environment") envFields.push("网关 URL");
  if (sources?.gatewayProtocol?.type === "environment") envFields.push("协议");
  if (sources?.apiKey?.type === "environment") envFields.push("API Key");
  const globalFields = [];
  if (sources?.gatewayUrl?.type === "global") globalFields.push("网关 URL");
  if (sources?.gatewayProtocol?.type === "global") globalFields.push("协议");
  if (sources?.apiKey?.type === "global") globalFields.push("API Key");
  if (envFields.length === 0 && globalFields.length === 0) {
    return "";
  }
  const parts = [];
  if (globalFields.length > 0) {
    parts.push(`全局默认配置正在提供：${globalFields.join("、")}`);
  }
  if (envFields.length > 0) {
    parts.push(`环境变量正在提供：${envFields.join("、")}`);
  }
  return `${parts.join("；")}。保存为当前项目默认后，本项目会优先生效。`;
}

export function sourceBadge(source: DashboardConfigSource | string | null | undefined) {
  const type = typeof source === "string" ? source : String(source?.type ?? "");
  if (type === "project") return "项目";
  if (type === "environment") return "全局默认（环境变量）";
  if (type === "global") return "全局配置";
  if (type === "bundled") return "内置";
  return "默认";
}

