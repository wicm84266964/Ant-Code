import { renderMarkdown } from "./markdown.ts";
import { hydrateRichContent } from "./rich-renderers.ts";
import { visibleTranscriptRole } from "./transcript.ts";
import { MANUAL_AGENT_MODEL_VALUE, state, els, MODE_DESCRIPTIONS, LOCAL_FILE_EXTENSIONS, FILE_REFERENCE_PATTERN, TRANSCRIPT_DOM_LIMIT, EVENT_STALE_AFTER_MS, EVENT_CONNECT_TIMEOUT_MS, EVENT_RECONNECT_MAX_ATTEMPTS, DASHBOARD_REQUEST_TIMEOUT_MS, DASHBOARD_API_VERSION, DASHBOARD_LIFECYCLE_TIMEOUT_MS, DASHBOARD_SHUTDOWN_TIMEOUT_MS, DASHBOARD_INTERRUPT_TIMEOUT_MS, MAX_IMAGE_ATTACHMENTS, MAX_IMAGE_ATTACHMENT_BYTES, CURRENT_SESSION_STORAGE_KEY, DASHBOARD_CLIENT_STORAGE_KEY, PREVIEW_WIDTH_STORAGE_KEY, PREVIEW_WIDTH_DEFAULT, PREVIEW_WIDTH_MIN, PREVIEW_WIDTH_MAX, PREVIEW_WORKSPACE_MIN , emptySessionStatus, emptyBackgroundSubagent } from "./app-core.ts";
import type { DashboardConfigSource, DashboardReasoningEffort, DashboardTurnChangeStats, DashboardScopedDefaultSelection, DashboardVisionAgent, DashboardReasoningDiscovery, DashboardReasoningCapabilityCandidate, DashboardGatewayProbeModel, DashboardGatewayProbeResult, DashboardLifecycleActivity, DashboardSettings, DashboardFile, DashboardTableSheet, DashboardTablePreview, DashboardLightboxItem, DashboardQuestionChoice, DashboardPendingQuestion, DashboardApproval, DashboardGatewayTransport, DashboardScopedRequest, DashboardFetchOptions, DashboardModelSource, DashboardSessionStatus, DashboardApiResult, DashboardActivity, DashboardModelOption, DashboardGatewayProfile, DashboardGatewayConfig, DashboardModelSelection, DashboardPendingGuide, DashboardStreamEvent, DashboardUiState , DashboardSessionSummary } from "./app-core.ts";
import { eventTargetOf, eventElement, isPlainObject, modelSourceOf, errorMessageOf, init, bootstrapDashboard, observeRunStatus, updateRunStatusTone, bindEvents, normalizedResponsiveView, composerHeightFor, previewWidthBounds, clampedPreviewWidth, permissionIndexForKey, focusTrapTarget, shouldFollowTranscript, scheduleAnimationFrameOnce, cancelScheduledAnimationFrame, appendPlainDraftDelta, renderFinalAssistantBody, selectTranscriptNodesToRemove, responsiveLayoutMode, restorePreviewWidth, setPreviewWidth, syncPreviewResizeHandle, beginPreviewResize, updatePreviewResize, finishPreviewResize, handlePreviewResizeKeydown, setResponsiveView, syncResponsiveNavigation, setResponsiveSurfaceInert, handleResponsiveFileNavigation, syncVisualViewport, resizePromptInput, handlePermissionModeKeydown, requestPermissionMode, defaultGoalMaxAutoContinues, emptyGoalSnapshot, applyGoalSnapshot, renderGoalControls, renderGoalStatusBar, requestGoalMode, showGoalConfirm, hideGoalConfirm, showGoalTextPanel, hideGoalTextPanel, enableGoalWithObjective, submitGoalAction, adoptGoalRunResult, showPermissionConfirm, hidePermissionConfirm, updateContextActions, announceStatus, modalFocusableElements, activateModal, collectModalBackground, focusModalInitialTarget, deactivateModal, restoreModalAttribute, handleGlobalKeydown, closeActiveModal, loadTrust, loadSessions, restoreInitialSession, latestBackgroundSessionId, initialSessionId, rememberCurrentSession, renderSessions, sessionMeta, sessionStatusView, toggleSidebar, setSidebarCollapsed, sessionsNeedRefresh, scheduleSessionsRefresh, handleSessionAction, openSession, restoreBackgroundSnapshot, deleteSession, setSessionsRefreshState, copySessionId, newTask, rememberNewTaskModelState, restoreNewTaskModelState, refreshNewTaskModelState, addAttachmentFiles, readImageAttachment, renderAttachmentStrip, attachmentPayload, clearAttachments, sendPrompt, stableTurnRequest, dashboardRequestId, dashboardClientId, statusUrl, interruptTurn, guideTurn, cancelQueuedTurn, cancelBackgroundSubagent, backgroundCancelKey, connectEvents, ensureEventsConnected, disconnectEvents, closeEventSource, markEventConnectionAlive, armEventConnectTimer, armEventStaleTimer, scheduleEventReconnect, reconnectEventsManually, clearEventReconnectTimer, clearEventConnectTimer, clearEventStaleTimer, setConnectionState, resetEventReplayState, rememberEventCursor, handleDashboardEvent, shouldSkipDashboardEvent, beginEventTurn, renderTranscriptMessages, renderSessionFailure, setTranscriptPaging, renderTranscriptHistoryStatus, removeTranscriptHistoryStatus, transcriptFirstContentNode, handleTranscriptScroll, loadOlderTranscript, renderWorkflowPanel, renderWorkflowStrip, currentWorkflowItem, workflowSection, workflowItem, normalizeWorkflowStatus, summarizeWorkflow, appendMessage, createMessageNode, appendTranscriptNode, trimTranscriptWindow, isProtectedTranscriptNode, renderTranscriptWindowMarker, captureTranscriptViewportAnchor, restoreTranscriptViewportAnchor, transcriptNodeTop, restoreTranscriptNodeAnchor, resetTranscriptWindow, appendAssistantDraft, scheduleDraftRender, renderAssistantDraft, appendActivity, appendContextBoundary, contextBoundaryText, handleActivity, isBackgroundSubagentActivity, handleBackgroundSubagentActivity, clearBackgroundSubagentStatus, reconcileBackgroundSubagentSnapshot, backgroundSubagentDisplayStatus, backgroundSubagentVisible, updateLiveActivity, removeLiveActivity, setLiveTitle, toggleLiveStatusDetails, updateLiveStatus, liveStatusTitle, primaryLiveActivity, gatewayRetryChipText, renderBackgroundSubagentStatus, backgroundSubagentCompactLabel, backgroundSubagentTitle, backgroundSubagentMeta, backgroundSubagentCancellable, resetLiveStatus, backgroundSubagentCounts, idleRunStatus, applyIdleRunStatus, updateRunStatusForBackground, updateSessionStatus, updateTurnChangeStats, resetTurnChangeStats, normalizeChangeStats, renderComposerStatus, modelStatusHtml, unresolvedModelStatusHtml, handleModelStatusActivate, handleModelStatusKeydown, toggleModelPanel, hideModelPanel, showSettingsWorkspace, refreshSettingsConfiguration, hideSettingsWorkspace, showModelConfigPanel, hideModelConfigPanel, renderModelPanel, modelCapabilityLabels, handleModelPanelClick, handleModelPanelChange, renderSettingsView, syncSettingsRail, modelSettingsHtml, transcriptSettingsHtml, transcriptRetentionOptionsHtml, networkSettingsHtml, networkModeOptionHtml, agentSettingsHtml, reliabilitySettingsHtml, settingsSectionHeading, settingsToggleHtml, managedFieldHtml, settingsDisabled, settingsFormActions, settingsFeedbackHtml, settingsGatewayProfileHtml, gatewayProfileReadonlyLabel, providerModelKey, scopedDefaultModelLabel, settingsModelHtml, handleSettingsRailClick, initializeSettingsFormTracking, handleSettingsFormChange, settingsControlValue, changedSettingsFields, canonicalSettingsField, setSettingsFormSaving, renderSettingsFeedbackInPlace, saveSettingsConfig, handleSettingsClick, protocolDisplayName, agentModelPickerHtml, renderModelConfigPanel, handleModelConfigPanelClick, handleModelConfigInput, handleModelConfigChange, markModelConfigCredentialChanged, markModelConfigEndpointChanged, handleModelConfigModelIdChanged, markReasoningCapabilityManual, clearReasoningCapabilityControls, syncGatewayUrlHint, gatewayUrlPlaceholder, gatewayUrlHint, syncReasoningDefaultOptions, probeGateway, isCurrentModelConfigRequest, currentGatewayProbeResult, currentGatewayCatalogModels, modelConfigGatewayProfile, modelConfigEndpointChanged, modelConfigAgentModelsSnapshot, initializeAgentModelPickerSnapshot, syncAgentModelPickersForEndpoint, uniqueAgentModelCandidates, appendAgentModelOptions, renderAgentModelPickers, updateAgentModelPickerManualStatus, handleAgentModelSelection, renderGatewayProbeResult, applyProbedModel, applyGatewayDiscoveredModel, applySuggestedGatewayUrl, gatewayCredentialAction, normalizeGatewayProbeModels, normalizeReasoningDiscovery, reasoningCapabilityCandidate, applyReasoningCapabilityCandidate, ensureReasoningEffortOptions, applyPendingReasoningCapabilities, reasoningCapabilityIsActionable, renderReasoningCapabilityStatus, reasoningCapabilityStatusText, reasoningDiscoveryStatusText, probeModelCapabilities, setFormControlsSaving, setModelConfigFormSaving, renderModelConfigFailure, clearModelConfigFailure, manualAgentModelIds, saveModelConfig, saveDefaultModelSelection, switchModel, handleReasoningEffortChange, switchReasoningEffort, deleteGatewayProfile, deleteModel, updateConfigRevisions, normalizeScopedDefaultSelection, configScope, configMutationMetadata, isConfigRevisionConflict, configRevisionConflictMessage, refreshConfigRevisionsAfterConflict, normalizeGatewayConfig, normalizeDashboardSettings, mergeGatewayConfig, normalizeGatewayProfiles, normalizeConfigSource, normalizeModels, normalizeModelSource, normalizeReasoningEfforts, normalizedReasoningEffort, isDisabledReasoningEffort, configuredReasoningEffort, reasoningEffortFallbackLabel, localizedReasoningEffortLabel, reasoningEffortCatalog, reasoningEffortLabel, resolveAtomicModelSelection, currentModelSelection, currentSessionNeedsModelSelection, currentGatewayProfile, gatewayProfileById, settingsInspectedGatewayProfile, modelSourceLabel, markCurrentModel, currentModelInfo, modelDisplayName, normalizeAgentModelTiers, normalizeVisionAgent, firstVisionModelId, hasAgentModelTiers, agentModelTiersSummary, gatewaySummary, modelSaveTargetLabel, gatewaySourceNote, environmentGatewayDefaultNote, sourceBadge, sourceLabel, formatContextUsage, firstFiniteNumber, formatTokenCount, trimNumber, nonNegativeInteger, collapseCompletedActivities, clearAssistantDrafts, collapseAssistantDrafts, isMeaningfulCompletedActivity, isDuplicateDraftText, normalizeComparableText, showApproval, resolveApproval, hideApproval, showQuestion, revealInteractionPanel, renderQuestionPanel, reviewQuestionConversation, returnToQuestion, activateQuestionReviewBackground, deactivateQuestionReviewBackground, questionChoiceButton, toggleQuestionChoice, submitQuestion, cancelQuestion, finishQuestionSubmission, hideQuestion, showTrustPanel, renderTrustPanel, confirmTrust, renderQueuePanel, renderQueueItem, setPendingGuide, clearPendingGuide, syncPendingGuideFromQueue, renderGuideFeedback, guideCopy, guideSource, guideTurnFromQueue, guideButtonText, guideButtonDisabled, guideButtonVisible, syncGuideButton, shouldKeepGuideFeedback, isInterruptError, updateSendButton, showContextConfirm, hideContextConfirm, runContextAction, contextActionRequestOptions, contextSummaryLine, compactResultLine, rememberQuestionDraft, questionResolutionText, showShutdownPanel, hideShutdownPanel, shutdownDashboard, lockClosedDashboard, normalizeLifecycleActivity, shutdownRequestBody, shutdownResultIsClosed, lifecycleActivitySummary, renderShutdownActivity, renderFiles, currentImageFiles, openFile, renderOfficePreview, officePreviewMeta, officePreviewBodyHtml, renderTablePreview, normalizeTablePreview, tablePreviewMeta, renderCompactTableHtml, renderExpandedTableHtml, renderTableHtml, tableTruncationNote, maxVisibleColumns, columnLabel, renderSheetPreviewHtml, renderSheetCellHtml, resetPreview, fencedDataForFile, dataLanguageForExtension, showImageLightbox, showTableLightbox, renderLightboxImage, bindTableLightboxControls, moveLightbox, hideLightbox, setPermissionMode, clearTranscript, cancelTranscriptAnimationFrames, clearAssistantDraftTimers, hideEmptyState, showError, showNotice, renderBootstrapLoading, renderBootstrapFailure, dashboardPayloadError, bootstrapFailurePresentation, clearBootstrapStatus, scrollTranscript, isTranscriptNearBottom, syncTranscriptFollowState, followTranscript, updateTranscriptJump, beginScopedRequest, isCurrentScopedRequest, finishScopedRequest, cancelScopedRequest, isAbortError, getJson, postJson, deleteJson, dashboardFetch, responseJson, dashboardJsonHeaders, dashboardCsrfToken, messageText, messageDisplayText, userMessageDisplayText, normalizeAttachmentMetadata, imageAttachmentLine, renderMessageText, renderLinkedText } from "./app-barrel.ts";
export function bindRichContent(node: ParentNode, options: { lightweight?: boolean } = {}) {
  node.querySelectorAll("[data-file]").forEach((link) => {
    if (!(link instanceof HTMLElement)) {
      return;
    }
    link.addEventListener("click", () => openFile(link.dataset.file ?? ""));
  });
  node.querySelectorAll("[data-image-src]").forEach((button) => {
    const rawUrl = imagePreviewUrl(button.dataset.imageSrc ?? "");
    if (rawUrl) {
      button.dataset.imageRawUrl = rawUrl;
      const image = button.querySelector("img");
      if (image) {
        image.src = rawUrl;
      }
    }
    button.addEventListener("click", () => {
      const imageButtons = Array.from(node.querySelectorAll("[data-image-src]"));
      const items = imageButtons.map((item) => ({
        name: item.dataset.imageAlt || "图片预览",
        rawUrl: item.dataset.imageRawUrl || imagePreviewUrl(item.dataset.imageSrc ?? "")
      })).filter((item) => item.rawUrl);
      const index = Math.max(0, imageButtons.indexOf(button));
      showImageLightbox({
        name: button.dataset.imageAlt || "图片预览",
        rawUrl: button.dataset.imageRawUrl || imagePreviewUrl(button.dataset.imageSrc ?? "")
      }, items, index);
    });
  });
  node.querySelectorAll(".md-copy-code").forEach((button) => {
    button.addEventListener("click", () => copyCodeBlock(button));
  });
  if (!options.lightweight) {
    hydrateRichContent(node);
  }
}

export function linkifyFileTextNodes(root: Node, basePath: unknown = "") {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || parent.closest("a, button, code, pre")) {
        return NodeFilter.FILTER_REJECT;
      }
      FILE_REFERENCE_PATTERN.lastIndex = 0;
      return FILE_REFERENCE_PATTERN.test(node.nodeValue ?? "")
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    }
  });
  const nodes: CharacterData[] = [];
  while (walker.nextNode()) {
    if (walker.currentNode instanceof CharacterData) nodes.push(walker.currentNode);
  }
  for (const textNode of nodes) {
    replaceFileReferences(textNode, basePath);
  }
}

export function replaceFileReferences(textNode: CharacterData, basePath: unknown = "") {
  const text = textNode.nodeValue ?? "";
  const fragment = document.createDocumentFragment();
  let lastIndex = 0;
  FILE_REFERENCE_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(FILE_REFERENCE_PATTERN)) {
    const value = match[0];
    const index = match.index ?? 0;
    if (!isLikelyLocalFileReference(value)) {
      continue;
    }
    if (index > lastIndex) {
      fragment.append(document.createTextNode(text.slice(lastIndex, index)));
    }
    const button = document.createElement("button");
    button.className = "file-link";
    button.type = "button";
    button.dataset.file = resolveDisplayFilePath(value, basePath);
    button.textContent = value;
    fragment.append(button);
    lastIndex = index + value.length;
  }
  if (lastIndex < text.length) {
    fragment.append(document.createTextNode(text.slice(lastIndex)));
  }
  textNode.replaceWith(fragment);
}

export function isLikelyLocalFileReference(value: unknown) {
  const withoutLine = normalizeFileReferencePath(value);
  const extension = withoutLine.split(".").pop()?.toLowerCase() ?? "";
  return LOCAL_FILE_EXTENSIONS.has(extension);
}

export function resolveDisplayFilePath(value: unknown, basePath: unknown = "") {
  const path = String(value ?? "").trim().replace(/\\/g, "/");
  const base = String(basePath ?? "").trim().replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (!path || !base || path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("../")) {
    return path;
  }
  const normalizedPath = path.replace(/^\.\/+/, "");
  if (isWorkspaceRelativeToBase(normalizedPath, base)) {
    return normalizeRelativePath(normalizedPath);
  }
  return normalizeRelativePath(`${base}/${normalizedPath}`);
}

export function normalizeFileReferencePath(value: unknown) {
  return String(value ?? "").replace(/:\d+$/, "");
}

export function parentDirectory(filePath: string | null | undefined) {
  const normalized = String(filePath ?? "").replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  if (index <= 0) {
    return "";
  }
  return normalized.slice(0, index);
}

export function filePreviewUrl(filePath: string | null | undefined) {
  return apiFileUrl("/api/files", filePath);
}

export function rawFileUrl(filePath: string | null | undefined) {
  return apiFileUrl("/api/files/raw", filePath);
}

export function apiFileUrl(endpoint: unknown, filePath: string | null | undefined) {
  const params = new URLSearchParams();
  params.set("path", normalizeFileReferencePath(filePath));
  if (state.currentSessionId) {
    params.set("sessionId", state.currentSessionId);
  }
  return `${endpoint}?${params.toString()}`;
}

export function imagePreviewUrl(src: unknown) {
  const value = String(src ?? "").trim();
  if (!value) {
    return "";
  }
  if (/^data:/i.test(value)) {
    return isSafeInlineBitmapUrl(value) ? value : "";
  }
  if (/^https?:\/\//i.test(value)) {
    return "";
  }
  if (value.startsWith("/api/files/raw?")) {
    return value;
  }
  if (value.startsWith("/")) {
    return "";
  }
  return rawFileUrl(value.replace(/^\.\//, ""));
}

export function isSafeInlineBitmapUrl(value: unknown) {
  const match = String(value ?? "").match(/^data:image\/(png|jpeg|gif|webp);base64,([a-z0-9+/]+={0,2})$/i);
  if (!match || match[2].length % 4 !== 0) {
    return false;
  }
  const padding = match[2].endsWith("==") ? 2 : match[2].endsWith("=") ? 1 : 0;
  const decodedBytes = (match[2].length / 4) * 3 - padding;
  return decodedBytes > 0 && decodedBytes <= 2 * 1024 * 1024;
}

export function normalizeRelativePath(value: unknown) {
  const stack = [];
  for (const part of String(value ?? "").split("/")) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      if (stack.length > 0 && stack[stack.length - 1] !== "..") {
        stack.pop();
      } else {
        stack.push(part);
      }
      continue;
    }
    stack.push(part);
  }
  return stack.join("/");
}

export function isWorkspaceRelativeToBase(value: unknown, basePath: unknown = "") {
  const firstBaseSegment = String(basePath ?? "").split("/").filter(Boolean)[0];
  return Boolean(firstBaseSegment) && String(value ?? "").startsWith(`${firstBaseSegment}/`);
}

export async function copyCodeBlock(button: HTMLElement) {
  const frame = button.closest(".md-code-frame");
  const text = frame?.querySelector("code")?.textContent ?? "";
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = "已复制";
    setTimeout(() => {
      button.textContent = "复制";
    }, 1200);
  } catch {
    button.textContent = "复制失败";
    setTimeout(() => {
      button.textContent = "复制";
    }, 1400);
  }
}

export function previewText(value: unknown, max: unknown = 120) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  const limit = Number(max);
  const maxLength = Number.isFinite(limit) && limit > 0 ? limit : 120;
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}

export function formatNumber(value: unknown) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0";
  return number.toLocaleString();
}

export function formatBytes(value: unknown) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function escapeAttribute(value: unknown) {
  return escapeHtml(value);
}

export function formatTime(value: unknown) {
  if (!value) return "";
  const date = new Date(typeof value === "number" || value instanceof Date ? value : String(value));
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString();
}

export function formatRelativeTime(value: unknown) {
  if (!value) {
    return "";
  }
  const time = new Date(typeof value === "number" || value instanceof Date ? value : String(value)).getTime();
  if (!Number.isFinite(time)) {
    return "";
  }
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 60) {
    return `${seconds}s 前`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m 前`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h 前`;
}

