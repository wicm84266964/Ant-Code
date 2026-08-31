import { renderMarkdown } from "./markdown.ts";
import { hydrateRichContent } from "./rich-renderers.ts";
import { visibleTranscriptRole } from "./transcript.ts";
import { MANUAL_AGENT_MODEL_VALUE, state, els, MODE_DESCRIPTIONS, LOCAL_FILE_EXTENSIONS, FILE_REFERENCE_PATTERN, TRANSCRIPT_DOM_LIMIT, EVENT_STALE_AFTER_MS, EVENT_CONNECT_TIMEOUT_MS, EVENT_RECONNECT_MAX_ATTEMPTS, DASHBOARD_REQUEST_TIMEOUT_MS, DASHBOARD_API_VERSION, DASHBOARD_LIFECYCLE_TIMEOUT_MS, DASHBOARD_SHUTDOWN_TIMEOUT_MS, DASHBOARD_INTERRUPT_TIMEOUT_MS, MAX_IMAGE_ATTACHMENTS, MAX_IMAGE_ATTACHMENT_BYTES, CURRENT_SESSION_STORAGE_KEY, DASHBOARD_CLIENT_STORAGE_KEY, PREVIEW_WIDTH_STORAGE_KEY, PREVIEW_WIDTH_DEFAULT, PREVIEW_WIDTH_MIN, PREVIEW_WIDTH_MAX, PREVIEW_WORKSPACE_MIN , emptySessionStatus, emptyBackgroundSubagent } from "./app-core.ts";
import type { DashboardConfigSource, DashboardReasoningEffort, DashboardTurnChangeStats, DashboardScopedDefaultSelection, DashboardVisionAgent, DashboardReasoningDiscovery, DashboardReasoningCapabilityCandidate, DashboardGatewayProbeModel, DashboardGatewayProbeResult, DashboardLifecycleActivity, DashboardSettings, DashboardFile, DashboardTableSheet, DashboardTablePreview, DashboardLightboxItem, DashboardQuestionChoice, DashboardPendingQuestion, DashboardApproval, DashboardGatewayTransport, DashboardScopedRequest, DashboardFetchOptions, DashboardModelSource, DashboardSessionStatus, DashboardApiResult, DashboardActivity, DashboardModelOption, DashboardGatewayProfile, DashboardGatewayConfig, DashboardModelSelection, DashboardPendingGuide, DashboardStreamEvent, DashboardUiState , DashboardSessionSummary } from "./app-core.ts";
import { eventTargetOf, eventElement, isPlainObject, modelSourceOf, errorMessageOf, init, bootstrapDashboard, observeRunStatus, updateRunStatusTone, bindEvents, normalizedResponsiveView, composerHeightFor, previewWidthBounds, clampedPreviewWidth, permissionIndexForKey, focusTrapTarget, shouldFollowTranscript, scheduleAnimationFrameOnce, cancelScheduledAnimationFrame, appendPlainDraftDelta, renderFinalAssistantBody, selectTranscriptNodesToRemove, responsiveLayoutMode, restorePreviewWidth, setPreviewWidth, syncPreviewResizeHandle, beginPreviewResize, updatePreviewResize, finishPreviewResize, handlePreviewResizeKeydown, setResponsiveView, syncResponsiveNavigation, setResponsiveSurfaceInert, handleResponsiveFileNavigation, syncVisualViewport, resizePromptInput, handlePermissionModeKeydown, requestPermissionMode, defaultGoalMaxAutoContinues, emptyGoalSnapshot, applyGoalSnapshot, renderGoalControls, renderGoalStatusBar, requestGoalMode, showGoalConfirm, hideGoalConfirm, showGoalTextPanel, hideGoalTextPanel, enableGoalWithObjective, submitGoalAction, adoptGoalRunResult, showPermissionConfirm, hidePermissionConfirm, updateContextActions, announceStatus, modalFocusableElements, activateModal, collectModalBackground, focusModalInitialTarget, deactivateModal, restoreModalAttribute, handleGlobalKeydown, closeActiveModal, loadTrust, loadSessions, restoreInitialSession, latestBackgroundSessionId, initialSessionId, rememberCurrentSession, renderSessions, sessionMeta, sessionStatusView, toggleSidebar, setSidebarCollapsed, sessionsNeedRefresh, scheduleSessionsRefresh, handleSessionAction, openSession, restoreBackgroundSnapshot, deleteSession, setSessionsRefreshState, copySessionId, newTask, rememberNewTaskModelState, restoreNewTaskModelState, refreshNewTaskModelState, addAttachmentFiles, readImageAttachment, renderAttachmentStrip, attachmentPayload, clearAttachments, sendPrompt, stableTurnRequest, dashboardRequestId, dashboardClientId, statusUrl, interruptTurn, guideTurn, cancelQueuedTurn, cancelBackgroundSubagent, backgroundCancelKey, connectEvents, ensureEventsConnected, disconnectEvents, closeEventSource, markEventConnectionAlive, armEventConnectTimer, armEventStaleTimer, scheduleEventReconnect, reconnectEventsManually, clearEventReconnectTimer, clearEventConnectTimer, clearEventStaleTimer, setConnectionState, resetEventReplayState, rememberEventCursor, handleDashboardEvent, shouldSkipDashboardEvent, beginEventTurn, renderTranscriptMessages, renderSessionFailure, setTranscriptPaging, renderTranscriptHistoryStatus, removeTranscriptHistoryStatus, transcriptFirstContentNode, handleTranscriptScroll, loadOlderTranscript, renderWorkflowPanel, renderWorkflowStrip, currentWorkflowItem, workflowSection, workflowItem, normalizeWorkflowStatus, summarizeWorkflow, appendMessage, createMessageNode, appendTranscriptNode, trimTranscriptWindow, isProtectedTranscriptNode, modelCapabilityLabels, handleModelPanelClick, handleModelPanelChange, renderSettingsView, syncSettingsRail, modelSettingsHtml, transcriptSettingsHtml, transcriptRetentionOptionsHtml, networkSettingsHtml, networkModeOptionHtml, agentSettingsHtml, reliabilitySettingsHtml, settingsSectionHeading, settingsToggleHtml, managedFieldHtml, settingsDisabled, settingsFormActions, settingsFeedbackHtml, settingsGatewayProfileHtml, gatewayProfileReadonlyLabel, providerModelKey, scopedDefaultModelLabel, settingsModelHtml, handleSettingsRailClick, initializeSettingsFormTracking, handleSettingsFormChange, settingsControlValue, changedSettingsFields, canonicalSettingsField, setSettingsFormSaving, renderSettingsFeedbackInPlace, saveSettingsConfig, handleSettingsClick, protocolDisplayName, agentModelPickerHtml, renderModelConfigPanel, handleModelConfigPanelClick, handleModelConfigInput, handleModelConfigChange, markModelConfigCredentialChanged, markModelConfigEndpointChanged, handleModelConfigModelIdChanged, markReasoningCapabilityManual, clearReasoningCapabilityControls, syncGatewayUrlHint, gatewayUrlPlaceholder, gatewayUrlHint, syncReasoningDefaultOptions, probeGateway, isCurrentModelConfigRequest, currentGatewayProbeResult, currentGatewayCatalogModels, modelConfigGatewayProfile, modelConfigEndpointChanged, modelConfigAgentModelsSnapshot, initializeAgentModelPickerSnapshot, syncAgentModelPickersForEndpoint, uniqueAgentModelCandidates, appendAgentModelOptions, renderAgentModelPickers, updateAgentModelPickerManualStatus, handleAgentModelSelection, renderGatewayProbeResult, applyProbedModel, applyGatewayDiscoveredModel, applySuggestedGatewayUrl, gatewayCredentialAction, normalizeGatewayProbeModels, normalizeReasoningDiscovery, reasoningCapabilityCandidate, applyReasoningCapabilityCandidate, ensureReasoningEffortOptions, applyPendingReasoningCapabilities, reasoningCapabilityIsActionable, renderReasoningCapabilityStatus, reasoningCapabilityStatusText, reasoningDiscoveryStatusText, probeModelCapabilities, setFormControlsSaving, setModelConfigFormSaving, renderModelConfigFailure, clearModelConfigFailure, manualAgentModelIds, saveModelConfig, saveDefaultModelSelection, switchModel, handleReasoningEffortChange, switchReasoningEffort, deleteGatewayProfile, deleteModel, updateConfigRevisions, normalizeScopedDefaultSelection, configScope, configMutationMetadata, isConfigRevisionConflict, configRevisionConflictMessage, refreshConfigRevisionsAfterConflict, normalizeGatewayConfig, normalizeDashboardSettings, mergeGatewayConfig, normalizeGatewayProfiles, normalizeConfigSource, normalizeModels, normalizeModelSource, normalizeReasoningEfforts, normalizedReasoningEffort, isDisabledReasoningEffort, configuredReasoningEffort, reasoningEffortFallbackLabel, localizedReasoningEffortLabel, reasoningEffortCatalog, reasoningEffortLabel, resolveAtomicModelSelection, currentModelSelection, currentSessionNeedsModelSelection, currentGatewayProfile, gatewayProfileById, settingsInspectedGatewayProfile, modelSourceLabel, markCurrentModel, currentModelInfo, modelDisplayName, normalizeAgentModelTiers, normalizeVisionAgent, firstVisionModelId, hasAgentModelTiers, agentModelTiersSummary, gatewaySummary, modelSaveTargetLabel, gatewaySourceNote, environmentGatewayDefaultNote, sourceBadge, sourceLabel, formatContextUsage, firstFiniteNumber, formatTokenCount, trimNumber, nonNegativeInteger, collapseCompletedActivities, clearAssistantDrafts, collapseAssistantDrafts, isMeaningfulCompletedActivity, isDuplicateDraftText, normalizeComparableText, showApproval, resolveApproval, hideApproval, showQuestion, revealInteractionPanel, renderQuestionPanel, reviewQuestionConversation, returnToQuestion, activateQuestionReviewBackground, deactivateQuestionReviewBackground, questionChoiceButton, toggleQuestionChoice, submitQuestion, cancelQuestion, finishQuestionSubmission, hideQuestion, showTrustPanel, renderTrustPanel, confirmTrust, renderQueuePanel, renderQueueItem, setPendingGuide, clearPendingGuide, syncPendingGuideFromQueue, renderGuideFeedback, guideCopy, guideSource, guideTurnFromQueue, guideButtonText, guideButtonDisabled, guideButtonVisible, syncGuideButton, shouldKeepGuideFeedback, isInterruptError, updateSendButton, showContextConfirm, hideContextConfirm, runContextAction, contextActionRequestOptions, contextSummaryLine, compactResultLine, rememberQuestionDraft, questionResolutionText, showShutdownPanel, hideShutdownPanel, shutdownDashboard, lockClosedDashboard, normalizeLifecycleActivity, shutdownRequestBody, shutdownResultIsClosed, lifecycleActivitySummary, renderShutdownActivity, renderFiles, currentImageFiles, openFile, renderOfficePreview, officePreviewMeta, officePreviewBodyHtml, renderTablePreview, normalizeTablePreview, tablePreviewMeta, renderCompactTableHtml, renderExpandedTableHtml, renderTableHtml, tableTruncationNote, maxVisibleColumns, columnLabel, renderSheetPreviewHtml, renderSheetCellHtml, resetPreview, fencedDataForFile, dataLanguageForExtension, showImageLightbox, showTableLightbox, renderLightboxImage, bindTableLightboxControls, moveLightbox, hideLightbox, setPermissionMode, clearTranscript, cancelTranscriptAnimationFrames, clearAssistantDraftTimers, hideEmptyState, showError, showNotice, renderBootstrapLoading, renderBootstrapFailure, dashboardPayloadError, bootstrapFailurePresentation, clearBootstrapStatus, scrollTranscript, isTranscriptNearBottom, syncTranscriptFollowState, followTranscript, updateTranscriptJump, beginScopedRequest, isCurrentScopedRequest, finishScopedRequest, cancelScopedRequest, isAbortError, getJson, postJson, deleteJson, dashboardFetch, responseJson, dashboardJsonHeaders, dashboardCsrfToken, messageText, messageDisplayText, userMessageDisplayText, normalizeAttachmentMetadata, imageAttachmentLine, renderMessageText, renderLinkedText, bindRichContent, linkifyFileTextNodes, replaceFileReferences, isLikelyLocalFileReference, resolveDisplayFilePath, normalizeFileReferencePath, parentDirectory, filePreviewUrl, rawFileUrl, apiFileUrl, imagePreviewUrl, isSafeInlineBitmapUrl, normalizeRelativePath, isWorkspaceRelativeToBase, copyCodeBlock, previewText, formatNumber, formatBytes, escapeHtml, escapeAttribute, formatTime, formatRelativeTime } from "./app-barrel.ts";
export function renderTranscriptWindowMarker(side: unknown) {
  const countKey = side === "newer" ? "unloadedNewer" : "unloadedOlder";
  const nodeKey = side === "newer" ? "newerNode" : "olderNode";
  let node = state.transcriptWindow[nodeKey];
  if (!node) {
    node = document.createElement("div");
    node.className = `transcript-unloaded ${side}`;
    node.setAttribute("role", "note");
    node.setAttribute("aria-live", "off");
    node.innerHTML = `<span></span><button type="button">恢复最近消息</button>`;
    node.querySelector("button").addEventListener("click", () => {
      if (state.currentSessionId) openSession(state.currentSessionId);
    });
    state.transcriptWindow[nodeKey] = node;
  }
  const count = state.transcriptWindow[countKey];
  node.querySelector("span").textContent = side === "newer"
    ? `较新的 ${count} 项已从页面卸载`
    : `较早的 ${count} 项已从页面卸载`;
  if (side === "newer") {
    els.transcript.append(node);
    return;
  }
  const before = state.transcriptHistoryNode?.parentElement === els.transcript
    ? state.transcriptHistoryNode.nextSibling
    : els.transcript.firstChild;
  els.transcript.insertBefore(node, before);
}

export function captureTranscriptViewportAnchor(excluded: Set<Element> = new Set()) {
  const transcriptTop = els.transcript.getBoundingClientRect?.().top ?? 0;
  for (const node of Array.from(els.transcript.children ?? [])) {
    if (excluded.has(node)) continue;
    const rect = node.getBoundingClientRect?.();
    if (rect && rect.height > 0 && rect.bottom >= transcriptTop) {
      return { node, offset: rect.top - transcriptTop };
    }
  }
  return null;
}

export function restoreTranscriptViewportAnchor(anchor: { node?: Element; offset?: number } | null | undefined) {
  if (!anchor?.node || anchor.node.parentElement !== els.transcript) return false;
  const transcriptTop = els.transcript.getBoundingClientRect?.().top ?? 0;
  const nextTop = anchor.node.getBoundingClientRect?.().top;
  if (!Number.isFinite(nextTop)) return false;
  els.transcript.scrollTop += nextTop - transcriptTop - Number(anchor.offset ?? 0);
  return true;
}

export function transcriptNodeTop(node: Node | Element | null | undefined) {
  if (!(node instanceof Element) || node.parentElement !== els.transcript) {
    return null;
  }
  return node.getBoundingClientRect().top;
}

export function restoreTranscriptNodeAnchor(node: Node | Element | null | undefined, previousTop: unknown) {
  if (!Number.isFinite(Number(previousTop)) || !(node instanceof Element) || node.parentElement !== els.transcript) return false;
  const nextTop = node.getBoundingClientRect().top;
  if (!Number.isFinite(nextTop)) return false;
  els.transcript.scrollTop += nextTop - Number(previousTop);
  return true;
}

export function resetTranscriptWindow() {
  state.transcriptWindow.olderNode?.remove();
  state.transcriptWindow.newerNode?.remove();
  state.transcriptWindow = {
    unloadedOlder: 0,
    unloadedNewer: 0,
    olderNode: null,
    newerNode: null
  };
}

export function appendAssistantDraft(event: DashboardStreamEvent) {
  const wasAtBottom = isTranscriptNearBottom();
  hideEmptyState();
  const turnKey = typeof event.turnId === "string" && event.turnId ? event.turnId : state.activeTurnId || "turn";
  const roundKey = `${turnKey}:${Number.isFinite(event.round) ? String(event.round) : "current"}`;
  let draft = state.assistantDrafts.get(roundKey);
  if (!draft) {
    const node = document.createElement("article");
    node.className = "message assistant draft-message";
    node.setAttribute("aria-live", "off");
    const label = Number.isFinite(event.round) ? `思考 · 第 ${event.round} 轮` : "思考";
    node.innerHTML = `
      <div class="message-label">${escapeHtml(label)}</div>
      <div class="message-body draft-plain-text"></div>
    `;
    draft = {
      round: Number.isFinite(event.round) ? event.round : null,
      text: "",
      node,
      body: node.querySelector(".message-body"),
      renderFrame: null,
      renderedLength: 0
    };
    state.assistantDrafts.set(roundKey, draft);
    appendTranscriptNode(node);
  }
  draft.text += String(event.text ?? "");
  scheduleDraftRender(draft);
  scrollTranscript({ onlyIfNearBottom: true, wasAtBottom });
  setLiveTitle("正在生成回复");
}

export type DashboardAssistantDraft = {
  text?: string;
  renderedLength?: number;
  body?: HTMLElement | null;
  renderFrame?: number;
  [key: string]: unknown;
};

export function scheduleDraftRender(draft: DashboardAssistantDraft) {
  scheduleAnimationFrameOnce(draft, "renderFrame", () => renderAssistantDraft(draft));
}

export function renderAssistantDraft(draft: DashboardAssistantDraft, options: Record<string, unknown> = {}) {
  const wasAtBottom = isTranscriptNearBottom();
  if (options.force) cancelScheduledAnimationFrame(draft, "renderFrame");
  if (draft.renderedLength === String(draft.text ?? "").length) {
    return;
  }
  draft.renderedLength = appendPlainDraftDelta(draft.body, draft.text, draft.renderedLength);
  scrollTranscript({ onlyIfNearBottom: true, wasAtBottom });
}

export function appendActivity(activity: DashboardActivity) {
  const wasAtBottom = isTranscriptNearBottom();
  const node = document.createElement("div");
  node.className = `activity-card ${activity.severity ?? "info"}${activity.collapsed ? "" : " open"}`;
  node.innerHTML = `
    <button class="activity-head" type="button" aria-expanded="${activity.collapsed ? "false" : "true"}">
      <span class="status-dot"></span>
      <div class="activity-title">${escapeHtml(activity.title)}</div>
      <span class="chevron">⌄</span>
    </button>
    <div class="activity-detail">${escapeHtml(activity.detail ?? "")}</div>
  `;
  const toggle = node.querySelector(".activity-head");
  toggle.addEventListener("click", () => {
    node.classList.toggle("open");
    toggle.setAttribute("aria-expanded", String(node.classList.contains("open")));
  });
  appendTranscriptNode(node);
  scrollTranscript({ onlyIfNearBottom: true, wasAtBottom });
  if (activity.severity === "danger" || activity.severity === "warning") announceStatus(activity.title);
}

export function appendContextBoundary(event: Record<string, unknown> = {}) {
  const wasAtBottom = isTranscriptNearBottom();
  hideEmptyState();
  const node = document.createElement("div");
  node.className = "context-boundary";
  node.setAttribute("role", "separator");
  node.innerHTML = `
    <span class="context-boundary-line" aria-hidden="true"></span>
    <span class="context-boundary-label">${escapeHtml(contextBoundaryText(event))}</span>
    <span class="context-boundary-line" aria-hidden="true"></span>
  `;
  appendTranscriptNode(node);
  scrollTranscript({ onlyIfNearBottom: true, wasAtBottom });
}

export function contextBoundaryText(event: Record<string, unknown> = {}) {
  const detail = String(event.detail ?? "").trim();
  if (detail) {
    return `${event.title ?? "聊天内容已压缩"}，${detail}`;
  }
  return "聊天内容已压缩，以下回复基于压缩后的上下文继续";
}

export function handleActivity(activity: DashboardActivity) {
  if (activity.status === "running" || activity.status === "waiting") {
    updateLiveActivity(activity);
    return;
  }
  const shouldKeep = activity.status === "failed" || activity.status === "blocked" || isMeaningfulCompletedActivity(activity);
  removeLiveActivity(activity);
  if (shouldKeep) {
    state.completedActivities.push(activity);
  }
}

export function isBackgroundSubagentActivity(activity: DashboardActivity | DashboardStreamEvent | null | undefined) {
  const rawType = String(activity?.rawType ?? "");
  return activity?.backgroundSubagent === true
    || activity?.kind === "terminal"
    || rawType.startsWith("subagent_group_")
    || rawType.startsWith("background_terminal_");
}

export function handleBackgroundSubagentActivity(activity: DashboardActivity | DashboardStreamEvent) {
  const key = activity.coalesceKey || activity.groupId || activity.taskId || activity.id;
  const previous = state.backgroundSubagents.get(key) ?? emptyBackgroundSubagent;
  const rawType = String(activity.rawType ?? "");
  const kind = typeof activity.kind === "string"
    ? activity.kind
    : typeof previous.kind === "string"
      ? previous.kind
      : rawType.startsWith("background_terminal_")
        ? "terminal"
        : undefined;
  const merged: DashboardActivity = {
    ...previous,
    ...activity,
    kind,
    groupId: activity.groupId ?? previous.groupId ?? null,
    taskId: activity.taskId ?? previous.taskId ?? null,
    profile: activity.profile ?? previous.profile ?? null,
    waitFor: activity.waitFor ?? previous.waitFor ?? null,
    wakeParent: typeof activity.wakeParent === "boolean" ? activity.wakeParent : previous.wakeParent ?? null,
    summary: activity.summary || activity.detail || previous.summary || "",
    wakePromptQueued: activity.wakePromptQueued === true || previous.wakePromptQueued === true,
    status: backgroundSubagentDisplayStatus(activity, previous)
  };
  if (backgroundSubagentVisible(merged)) {
    state.backgroundSubagents.set(key, merged);
  } else {
    state.backgroundSubagents.delete(key);
  }
  updateLiveStatus();
  updateRunStatusForBackground(backgroundSubagentVisible(merged) ? "空闲" : "完成");
}

export function clearBackgroundSubagentStatus(groupId: unknown) {
  const id = String(groupId ?? "").trim();
  if (id) {
    state.backgroundSubagents.delete(`subagent-group:${id}`);
    state.backgroundSubagents.delete(`background-terminal:${id}`);
    for (const [key, item] of state.backgroundSubagents.entries()) {
      if (item.groupId === id || item.taskId === id) {
        state.backgroundSubagents.delete(key);
      }
    }
  } else {
    for (const [key, item] of state.backgroundSubagents.entries()) {
      if (item.status === "waiting" || item.wakePromptQueued === true) {
        state.backgroundSubagents.delete(key);
      }
    }
  }
  if (state.backgroundSubagents.size === 0) {
    state.liveStatusExpanded = false;
  }
  updateLiveStatus();
}

export function reconcileBackgroundSubagentSnapshot(groups: unknown, snapshotAt?: unknown) {
  const visibleGroups = Array.isArray(groups) ? groups.filter(backgroundSubagentVisible) : [];
  const nextKeys = new Set();
  const snapshotTime = Date.parse(String(snapshotAt ?? "")) || Date.now();
  for (const group of visibleGroups) {
    const id = String(group.groupId ?? group.taskId ?? "").trim();
    if (!id) {
      continue;
    }
    const key = group.kind === "terminal" ? `background-terminal:${id}` : `subagent-group:${id}`;
    nextKeys.add(key);
    const previous = state.backgroundSubagents.get(key) ?? emptyBackgroundSubagent;
    state.backgroundSubagents.set(key, {
      ...previous,
      backgroundSubagent: true,
      coalesceKey: key,
      rawType: "background_subagent_snapshot",
      title: group.kind === "terminal"
        ? group.status === "cancelling" ? "终端后台任务正在确认退出" : "终端后台运行中"
        : group.status === "waiting" ? "等待子智能体唤醒主控" : "子智能体后台运行中",
      kind: group.kind ?? previous.kind ?? "subagent",
      groupId: group.groupId ?? previous.groupId ?? null,
      taskId: group.taskId ?? previous.taskId ?? null,
      profile: group.profile ?? previous.profile ?? null,
      waitFor: group.waitFor ?? previous.waitFor ?? null,
      wakeParent: typeof group.wakeParent === "boolean" ? group.wakeParent : previous.wakeParent ?? null,
      summary: group.summary || previous.summary || "",
      wakePromptQueued: group.wakePromptQueued === true,
      stale: group.stale === true,
      staleKind: group.staleKind ?? null,
      staleReason: group.staleReason ?? "",
      lastProgressAt: group.lastProgressAt ?? null,
      heartbeatAt: group.heartbeatAt ?? null,
      staleSeconds: Number.isFinite(group.staleSeconds) ? group.staleSeconds : null,
      heartbeatAgeSeconds: Number.isFinite(group.heartbeatAgeSeconds) ? group.heartbeatAgeSeconds : null,
      cancellable: group.cancellable !== false,
      runningCount: Number.isFinite(group.runningCount) ? group.runningCount : previous.runningCount ?? null,
      taskCount: Number.isFinite(group.taskCount) ? group.taskCount : previous.taskCount ?? null,
      status: group.status,
      at: group.updatedAt ?? previous.at ?? new Date().toISOString()
    });
  }
  for (const [key, item] of state.backgroundSubagents.entries()) {
    const tracked = item.kind === "terminal"
      || item.groupId
      || String(key).startsWith("subagent-group:")
      || String(key).startsWith("background-terminal:");
    if (!tracked || nextKeys.has(key)) {
      continue;
    }
    const itemTime = Date.parse(String(item.at ?? ""));
    if (Number.isFinite(itemTime) && itemTime > snapshotTime) {
      continue;
    }
    state.backgroundSubagents.delete(key);
  }
  if (state.backgroundSubagents.size === 0) {
    state.liveStatusExpanded = false;
  }
  updateLiveStatus();
  applyIdleRunStatus("完成");
}

export function backgroundSubagentDisplayStatus(activity: DashboardActivity, previous: DashboardActivity = {}) {
  if (activity.rawType === "subagent_group_wakeup" || activity.wakePromptQueued === true) {
    return "waiting";
  }
  if (activity.rawType === "subagent_group_started") {
    return "running";
  }
  if (activity.completed === true) {
    const wakeParent = typeof activity.wakeParent === "boolean" ? activity.wakeParent : previous.wakeParent;
    const waitFor = activity.waitFor ?? previous.waitFor;
    return wakeParent !== false && waitFor !== "none" ? "waiting" : (activity.status ?? "completed");
  }
  return activity.status ?? previous.status ?? "running";
}

export function backgroundSubagentVisible(activity: DashboardActivity) {
  return activity.status === "starting" || activity.status === "running" || activity.status === "cancelling" || activity.status === "waiting" || activity.status === "stale" || activity.status === "lost";
}

export function updateLiveActivity(activity: DashboardActivity) {
  const key = activity.coalesceKey || activity.toolUseId || activity.id;
  state.liveActivities.set(key, activity);
  setLiveTitle(activity.title || "正在处理");
}

export function removeLiveActivity(activity: DashboardActivity) {
  const key = activity.coalesceKey || activity.toolUseId || activity.id;
  state.liveActivities.delete(key);
  updateLiveStatus();
}

export function setLiveTitle(title: string) {
  state.liveTitle = title;
  updateLiveStatus();
}

export function toggleLiveStatusDetails() {
  if (state.backgroundSubagents.size === 0) {
    return;
  }
  state.liveStatusExpanded = !state.liveStatusExpanded;
  updateLiveStatus();
}

export function updateLiveStatus() {
  const active = Array.from(state.liveActivities.values()).filter((activity) => activity.status === "running" || activity.status === "waiting");
  const background = Array.from(state.backgroundSubagents.values()).filter(backgroundSubagentVisible);
  if (background.length === 0) {
    state.liveStatusExpanded = false;
  }
  const visible = state.running || active.length > 0 || background.length > 0 || state.liveTitle;
  els.liveStatus.classList.toggle("hidden", !visible);
  els.liveStatus.classList.toggle("has-background-subagents", background.length > 0);
  els.liveStatus.classList.toggle("expanded", state.liveStatusExpanded && background.length > 0);
  els.activityToggle.disabled = background.length === 0;
  els.activityToggle.setAttribute("aria-expanded", String(state.liveStatusExpanded && background.length > 0));
  els.activityToggle.setAttribute("aria-label", background.length > 0
    ? `${state.liveStatusExpanded ? "收起" : "展开"}后台活动详情`
    : "当前活动");
  if (!visible) {
    els.liveTitle.textContent = "";
    els.liveSubtasks.innerHTML = "";
    return;
  }
  const primary = primaryLiveActivity(active);
  const subtasks = active.filter((activity) => activity.toolName === "agent_run");
  els.liveTitle.textContent = liveStatusTitle(primary, subtasks, background);
  els.liveSubtasks.innerHTML = "";
  if (primary?.rawType === "gateway_retry") {
    const chip = document.createElement("div");
    chip.className = "live-chip retry";
    chip.innerHTML = `<span class="chip-pulse" aria-hidden="true"></span>${escapeHtml(gatewayRetryChipText(primary))}`;
    els.liveSubtasks.append(chip);
  }
  for (const task of subtasks.slice(0, 4)) {
    const chip = document.createElement("div");
    chip.className = "live-chip";
    chip.innerHTML = `<span class="chip-pulse" aria-hidden="true"></span>${escapeHtml(task.profile ? `${task.profile} 子任务运行中` : "子智能体运行中")}`;
    els.liveSubtasks.append(chip);
  }
  renderBackgroundSubagentStatus(background);
}

export function liveStatusTitle(primary: DashboardActivity | undefined, subtasks: DashboardActivity[], background: DashboardActivity[]) {
  if (primary?.rawType === "gateway_retry") {
    return "网关响应异常，正在自动重试";
  }
  if (background.length > 0 && (!primary || primary.title === "开始任务")) {
    const counts = backgroundSubagentCounts();
    if (counts.terminalStarting > 0) {
      return `${counts.terminalStarting} 个终端后台任务启动中`;
    }
    if (counts.terminals > 0) {
      return `${counts.terminals} 个终端后台任务运行中`;
    }
    if (counts.running > 0) {
      return `${counts.running} 个子智能体后台运行中`;
    }
    if (counts.lost > 0) {
      return `${counts.lost} 个子智能体疑似失联`;
    }
    if (counts.stale > 0) {
      return `${counts.stale} 个子智能体长时间无进展`;
    }
    if (counts.waiting > 0) {
      return "等待子智能体唤醒主控";
    }
  }
  return primary?.title === "开始任务" && subtasks.length > 0
    ? "子智能体运行中"
    : primary?.title || state.liveTitle || "正在处理";
}

export function primaryLiveActivity(active: DashboardActivity[]) {
  return active.find((activity) => activity.rawType === "gateway_retry")
    || active.find((activity) => activity.toolName !== "agent_run")
    || active[0];
}

export function gatewayRetryChipText(activity: DashboardActivity) {
  const attempt = Number.isFinite(activity.retryAttempt) && Number.isFinite(activity.retryMaxAttempts)
    ? `${activity.retryAttempt}/${activity.retryMaxAttempts}`
    : "";
  const code = activity.retryCode ? String(activity.retryCode) : "gateway";
  const delay = Number.isFinite(activity.retryDelayMs) ? `${activity.retryDelayMs}ms` : "";
  return ["重试", attempt, code, delay].filter(Boolean).join(" · ");
}

export function renderBackgroundSubagentStatus(background: DashboardActivity[]) {
  if (background.length === 0) {
    return;
  }
  const ordered = background.sort((left, right) => String(right.at ?? "").localeCompare(String(left.at ?? "")));
  if (!state.liveStatusExpanded) {
    for (const item of ordered.slice(0, 3)) {
      const chip = document.createElement("div");
      chip.className = `live-chip background-subagent-chip ${item.status}`;
      const cancelKey = backgroundCancelKey(item.groupId, item.taskId);
      const cancelling = state.backgroundCancelling.has(cancelKey);
      chip.innerHTML = `
        <span class="chip-pulse" aria-hidden="true"></span>
        ${escapeHtml(backgroundSubagentCompactLabel(item))}
        ${backgroundSubagentCancellable(item) ? `
          <button type="button" class="live-chip-cancel" data-background-cancel="true" data-group-id="${escapeHtml(item.groupId ?? "")}" data-task-id="${escapeHtml(item.taskId ?? "")}" ${cancelling ? "disabled" : ""}>${cancelling ? "回收中" : "回收"}</button>
        ` : ""}
      `;
      els.liveSubtasks.append(chip);
    }
    if (ordered.length > 3) {
      const more = document.createElement("div");
      more.className = "live-chip background-subagent-chip";
      more.textContent = `+${ordered.length - 3}`;
      els.liveSubtasks.append(more);
    }
    return;
  }
  for (const item of ordered) {
    const row = document.createElement("div");
    row.className = `live-subagent-row ${item.status}`;
    const cancelKey = backgroundCancelKey(item.groupId, item.taskId);
    const cancelling = state.backgroundCancelling.has(cancelKey);
    row.innerHTML = `
      <div class="live-subagent-head">
        <div class="live-subagent-title">
          <span class="chip-pulse" aria-hidden="true"></span>
          <span>${escapeHtml(backgroundSubagentTitle(item))}</span>
        </div>
        ${backgroundSubagentCancellable(item) ? `
          <button type="button" class="live-subagent-cancel" data-background-cancel="true" data-group-id="${escapeHtml(item.groupId ?? "")}" data-task-id="${escapeHtml(item.taskId ?? "")}" ${cancelling ? "disabled" : ""}>${cancelling ? "回收中" : "回收"}</button>
        ` : ""}
      </div>
      <div class="live-subagent-meta">${escapeHtml(backgroundSubagentMeta(item))}</div>
      ${item.staleReason ? `<div class="live-subagent-warning">${escapeHtml(item.staleReason)}</div>` : ""}
      ${item.summary ? `<div class="live-subagent-summary">${escapeHtml(item.summary)}</div>` : ""}
    `;
    els.liveSubtasks.append(row);
  }
}

export function backgroundSubagentCompactLabel(item: DashboardActivity) {
  if (item.kind === "terminal") {
    if (item.status === "starting") return "终端任务启动中";
    if (item.status === "cancelling") return "终端任务退出确认中";
    if (item.status === "stale") return "终端任务回收中";
    return "终端后台运行";
  }
  const profile = item.profile ? `${item.profile} ` : "";
  if (item.status === "waiting") return `${profile}等待唤醒`;
  if (item.status === "lost") return `${profile}疑似失联`;
  if (item.status === "stale") return `${profile}无进展`;
  return `${profile}后台运行`;
}

export function backgroundSubagentTitle(item: DashboardActivity) {
  if (item.kind === "terminal") {
    if (item.status === "starting") return "终端后台任务启动中";
    if (item.status === "cancelling") return "终端后台任务退出确认中";
    if (item.status === "stale") return "终端后台任务回收中";
    return "终端后台任务运行中";
  }
  const profile = item.profile ? `${item.profile} ` : "";
  if (item.status === "waiting") return `${profile}等待主控接续`;
  if (item.status === "lost") return `${profile}子智能体疑似失联`;
  if (item.status === "stale") return `${profile}子智能体长时间无进展`;
  return `${profile}子智能体运行中`;
}

export function backgroundSubagentMeta(item: DashboardActivity) {
  if (item.kind === "terminal") {
    return [
      item.taskId ? `task=${item.taskId}` : null,
      item.status === "starting" ? "启动中" : null,
      item.status === "cancelling" ? "退出确认中" : null,
      item.runningCount === 1 ? "运行中" : null,
      item.lastProgressAt ? `更新 ${formatRelativeTime(item.lastProgressAt)}` : null
    ].filter(Boolean).join(" · ");
  }
  return [
    item.groupId ? `group=${item.groupId}` : null,
    item.taskId ? `task=${item.taskId}` : null,
    item.waitFor ? `waitFor=${item.waitFor}` : null,
    Number.isFinite(item.runningCount) && Number.isFinite(item.taskCount) ? `${item.runningCount}/${item.taskCount} 运行中` : null,
    item.lastProgressAt ? `进展 ${formatRelativeTime(item.lastProgressAt)}` : null,
    item.heartbeatAt ? `心跳 ${formatRelativeTime(item.heartbeatAt)}` : null,
    item.wakeParent === false ? "仅记录" : "自动唤醒"
  ].filter(Boolean).join(" · ");
}

export function backgroundSubagentCancellable(item: DashboardActivity) {
  return item.cancellable !== false && (item.status === "starting" || item.status === "running" || item.status === "stale" || item.status === "lost");
}

export function resetLiveStatus(options: Record<string, unknown> = {}) {
  state.running = false;
  state.liveTitle = "";
  state.liveActivities.clear();
  if (!options.keepBackgroundSubagents) {
    state.backgroundSubagents.clear();
    state.liveStatusExpanded = false;
  }
  updateLiveStatus();
  updateSendButton();
}

export function backgroundSubagentCounts() {
  const items = Array.from(state.backgroundSubagents.values()).filter(backgroundSubagentVisible);
  const subagents = items.filter((item) => item.kind !== "terminal");
  const terminals = items.filter((item) => item.kind === "terminal");
  return {
    running: subagents.filter((item) => item.status === "running").length,
    terminalStarting: terminals.filter((item) => item.status === "starting").length,
    terminals: terminals.filter((item) => item.status === "running" || item.status === "cancelling").length,
    terminalStale: terminals.filter((item) => item.status === "stale").length,
    stale: subagents.filter((item) => item.status === "stale").length,
    lost: subagents.filter((item) => item.status === "lost").length,
    waiting: subagents.filter((item) => item.status === "waiting").length
  };
}

export function idleRunStatus(fallback: string) {
  const counts = backgroundSubagentCounts();
  if (counts.terminalStarting > 0) {
    return "终端后台任务启动中";
  }
  if (counts.terminals > 0) {
    return "终端后台任务运行中";
  }
  if (counts.terminalStale > 0) {
    return "终端后台任务回收中";
  }
  if (counts.running > 0) {
    return "子智能体运行中";
  }
  if (counts.lost > 0) {
    return "子智能体疑似失联";
  }
  if (counts.stale > 0) {
    return "子智能体无进展";
  }
  if (counts.waiting > 0) {
    return "等待子智能体唤醒";
  }
  return fallback;
}

export function applyIdleRunStatus(fallback: string = "空闲") {
  if (state.running) {
    return;
  }
  els.runStatus.textContent = idleRunStatus(fallback);
}

export function updateRunStatusForBackground(fallback: string = "空闲") {
  if (state.running) {
    return;
  }
  const current = els.runStatus.textContent.trim();
  const base = /子智能体|终端后台任务|唤醒/.test(current) ? fallback : current || fallback;
  els.runStatus.textContent = idleRunStatus(base);
}

export function updateSessionStatus(status: DashboardSessionStatus | string | null | undefined) {
  if (!status || typeof status !== "object") {
    renderComposerStatus();
    return;
  }
  state.sessionStatus = {
    ...state.sessionStatus,
    ...status,
    context: status.context ?? state.sessionStatus?.context ?? null
  };
  state.models = markCurrentModel(state.models, state.sessionStatus.model);
  renderComposerStatus();
  renderSettingsView();
}

export function updateTurnChangeStats(stats: DashboardTurnChangeStats | null | undefined, options: { replace?: boolean; reset?: boolean } = {}) {
  if (options.reset) {
    resetTurnChangeStats();
    return;
  }
  if (!stats || typeof stats !== "object") {
    renderComposerStatus();
    return;
  }
  const normalized = normalizeChangeStats(stats);
  if (options.replace) {
    state.turnChangeStats = normalized;
  } else {
    state.turnChangeStats = {
      additions: state.turnChangeStats.additions + normalized.additions,
      deletions: state.turnChangeStats.deletions + normalized.deletions,
      files: state.turnChangeStats.files + normalized.files,
      redacted: state.turnChangeStats.redacted || normalized.redacted,
      truncated: state.turnChangeStats.truncated || normalized.truncated,
      approximate: state.turnChangeStats.approximate || normalized.approximate
    };
  }
  renderComposerStatus();
}

export function resetTurnChangeStats() {
  state.turnChangeStats = { additions: 0, deletions: 0, files: 0, redacted: false, truncated: false, approximate: false };
  renderComposerStatus();
}

export function normalizeChangeStats(stats: DashboardTurnChangeStats | Record<string, unknown>): DashboardTurnChangeStats {
  return {
    additions: nonNegativeInteger(stats.additions),
    deletions: nonNegativeInteger(stats.deletions),
    files: nonNegativeInteger(stats.files),
    redacted: stats.redacted === true,
    truncated: stats.truncated === true,
    approximate: stats.approximate === true
  };
}

export function renderComposerStatus() {
  if (!els.modelStatus || !els.contextStatus || !els.changeStatus) {
    return;
  }
  const selection = currentModelSelection();
  const model = selection.model?.id || state.sessionStatus?.model || "";
  const modelInfo = selection.model ?? currentModelInfo(model);
  const context = state.sessionStatus?.context ?? null;
  els.modelStatus.innerHTML = selection.resolved === false
    ? unresolvedModelStatusHtml()
    : modelStatusHtml(modelInfo, model);
  const toggle = els.modelStatus.querySelector("#model-status-toggle");
  if (toggle) {
    toggle.disabled = state.running || state.modelSwitching;
  }
  els.contextStatus.textContent = `上下文 ${formatContextUsage(context)}`;

  const stats = state.turnChangeStats;
  const hasChanges = nonNegativeInteger(stats.additions) > 0 || nonNegativeInteger(stats.deletions) > 0 || stats.redacted === true;
  els.changeStatus.classList.toggle("hidden", !hasChanges);
  if (hasChanges) {
    const suffix = [
      stats.files ? `${stats.files} 文件` : null,
      stats.redacted ? "敏感差异已隐藏" : null,
      stats.truncated ? "已截断" : null,
      stats.approximate ? "近似" : null
    ].filter(Boolean).join(" · ");
    els.changeStatus.innerHTML = `
      <span class="change-label">本轮</span>
      <span class="change-add">+${nonNegativeInteger(stats.additions)}</span>
      <span class="change-del">-${nonNegativeInteger(stats.deletions)}</span>
      ${suffix ? `<span class="change-meta">· ${escapeHtml(suffix)}</span>` : ""}
    `;
  } else {
    els.changeStatus.replaceChildren();
  }
}

export function modelStatusHtml(modelInfo: DashboardModelOption | null | undefined, fallbackModel: string | null | undefined) {
  const label = modelInfo?.label || fallbackModel || "未配置";
  const source = modelSourceLabel(modelInfo);
  const efforts = normalizeReasoningEfforts(modelInfo?.reasoningEfforts);
  const sessionDefinesEffort = Object.prototype.hasOwnProperty.call(state.sessionStatus ?? emptySessionStatus, "reasoningEffort");
  const selectedEffort = configuredReasoningEffort(
    sessionDefinesEffort ? state.sessionStatus?.reasoningEffort : modelInfo?.reasoningEffort,
    efforts
  );
  const reasoningDisabled = state.running || state.modelSwitching || state.reasoningEffortSwitching || efforts.length === 0;
  return `
    <button class="model-status-summary" id="model-status-toggle" type="button" aria-haspopup="dialog" aria-controls="model-panel" aria-expanded="${state.modelPanelOpen ? "true" : "false"}" aria-label="切换模型来源和模型">
      <span class="model-status-source">${escapeHtml(source)}</span>
      <span class="model-status-separator" aria-hidden="true">&middot;</span>
      <span class="model-status-main">${escapeHtml(label)}</span>
      <span class="model-status-caret" aria-hidden="true">▾</span>
    </button>
    <label class="reasoning-effort-control${reasoningDisabled ? " disabled" : ""}" title="${efforts.length === 0 ? "当前模型未声明可调节的思考强度" : "调整当前会话的思考强度"}">
      <span>思考</span>
      <select id="reasoning-effort-select" aria-label="思考强度" ${reasoningDisabled ? "disabled" : ""}>
        <option value=""${selectedEffort ? "" : " selected"}>默认</option>
        ${efforts.map((effort: { id?: string; label?: string; description?: string }) => `<option value="${escapeAttribute(effort.id)}"${selectedEffort === effort.id ? " selected" : ""}${effort.description ? ` title="${escapeAttribute(effort.description)}"` : ""}>${escapeHtml(effort.label)}</option>`).join("")}
      </select>
    </label>
  `;
}

export function unresolvedModelStatusHtml() {
  return `
    <button class="model-status-summary unresolved" id="model-status-toggle" type="button" aria-haspopup="dialog" aria-controls="model-panel" aria-expanded="${state.modelPanelOpen ? "true" : "false"}" aria-label="重新选择模型来源和模型">
      <span class="model-status-main">需要重新选择模型</span>
      <span class="model-status-caret" aria-hidden="true">▾</span>
    </button>
    <label class="reasoning-effort-control disabled" title="请先重新选择模型">
      <span>思考</span>
      <select id="reasoning-effort-select" aria-label="思考强度" disabled>
        <option value="" selected>不可用</option>
      </select>
    </label>
  `;
}

export function handleModelStatusActivate(event: MouseEvent) {
  const toggle = eventTargetOf(event).closest("#model-status-toggle");
  if (!toggle || toggle.disabled || (event.type === "click" && event.detail === 0)) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  toggleModelPanel();
}

export function handleModelStatusKeydown(event: KeyboardEvent) {
  const toggle = eventTargetOf(event).closest("#model-status-toggle");
  if (!toggle || toggle.disabled) {
    return;
  }
  if (event.key !== "Enter" && event.key !== " ") {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  toggleModelPanel();
}

export function toggleModelPanel() {
  const toggle = els.modelStatus.querySelector("#model-status-toggle");
  if (toggle?.disabled) {
    return;
  }
  state.modelPanelOpen = !state.modelPanelOpen;
  renderModelPanel();
  renderComposerStatus();
}

export function hideModelPanel() {
  state.modelPanelOpen = false;
  renderModelPanel();
  renderComposerStatus();
}

export function showSettingsWorkspace() {
  const opening = !state.settingsOpen;
  if (opening) {
    state.settingsReturnFocus = document.activeElement;
    if (!gatewayProfileById(state.settingsProviderId)) {
      state.settingsProviderId = state.gatewayConfig?.activeProfileId || "";
    }
  }
  state.settingsOpen = true;
  state.responsiveView = "settings";
  document.body.classList.add("settings-open");
  els.settingsView?.classList.remove("hidden");
  els.settingsButton?.setAttribute("aria-pressed", "true");
  els.settingsButton?.setAttribute("aria-label", "设置已打开");
  hideModelPanel();
  renderSettingsView();
  syncResponsiveNavigation();
  requestAnimationFrame(() => els.settingsBack?.focus?.({ preventScroll: true }));
  if (opening) refreshSettingsConfiguration();
}

export async function refreshSettingsConfiguration() {
  if (state.settingsRefreshing || state.settingsSaving || state.modelConfigSaving) return;
  const request = beginScopedRequest("settings-refresh");
  state.settingsRefreshing = true;
  renderSettingsView();
  try {
    const result = await getJson(statusUrl(), { signal: request.signal });
    if (!isCurrentScopedRequest(request) || !state.settingsOpen) return;
    if (!result.ok) throw new Error(result.error ?? "读取设置失败");
    state.models = normalizeModels(result.models);
    state.gatewayConfig = normalizeGatewayConfig(result.gatewayConfig);
    state.gatewayProfiles = normalizeGatewayProfiles(result.gatewayProfiles);
    state.agentModelTiers = normalizeAgentModelTiers(result.agentModelTiers);
    state.visionAgent = normalizeVisionAgent(result.visionAgent);
    state.settings = normalizeDashboardSettings(result.settings);
    state.applyAgentDefaultsOnSwitch = state.settings.agents.syncModelTiersOnSwitch;
    updateConfigRevisions(result);
    state.settingsFeedback = null;
    renderSettingsView();
    renderComposerStatus();
  } catch (error) {
    if (!isAbortError(error) && isCurrentScopedRequest(request) && state.settingsOpen) {
      state.settingsFeedback = { tone: "error", message: error instanceof Error ? error.message : "读取设置失败" };
      renderSettingsView();
    }
  } finally {
    const current = isCurrentScopedRequest(request);
    if (current) state.settingsRefreshing = false;
    finishScopedRequest(request);
    if (current && state.settingsOpen) renderSettingsView();
  }
}

/** @param {{ restoreFocus?: boolean }} [options] */
export function hideSettingsWorkspace(options: { restoreFocus?: boolean } = {}) {
  if (!state.settingsOpen || state.modelConfigSaving || state.settingsSaving) return;
  state.settingsOpen = false;
  state.responsiveView = "conversation";
  document.body.classList.remove("settings-open");
  els.settingsView?.classList.add("hidden");
  els.settingsButton?.setAttribute("aria-pressed", "false");
  els.settingsButton?.setAttribute("aria-label", "打开设置");
  syncResponsiveNavigation();
  if (options.restoreFocus === false) return;
  const returnFocus = state.settingsReturnFocus?.isConnected ? state.settingsReturnFocus : els.settingsButton;
  requestAnimationFrame(() => returnFocus?.focus?.({ preventScroll: true }));
}

export function showModelConfigPanel(modelId: unknown = "", profileId: unknown = "", intent: unknown = "") {
  cancelScopedRequest("gateway-probe");
  cancelScopedRequest("model-capabilities-probe");
  const returnFocus = document.activeElement;
  const requestedProfileId = String(profileId ?? "").trim();
  const requestedModelId = String(modelId ?? "").trim();
  const requestedProfile = gatewayProfileById(requestedProfileId);
  const requestedModel = requestedModelId
    ? requestedProfile?.models?.find((model) => model.id === requestedModelId) ?? currentModelInfo(requestedModelId)
    : null;
  const requestedSource = modelSourceOf(requestedModel);
  const modelProfileId = String(requestedSource?.profileId ?? requestedSource?.id ?? "").trim();
  state.modelConfigIntent = intent === "add-source" || intent === "add-model" || intent === "edit-model" || intent === "edit-profile"
    ? intent
    : requestedModelId
      ? "edit-model"
      : requestedProfileId
        ? "edit-profile"
        : "add-source";
  state.editingGatewayProfileId = state.modelConfigIntent === "add-source"
    ? ""
    : requestedProfileId || modelProfileId || "";
  const profile = gatewayProfileById(state.editingGatewayProfileId);
  state.editingModelId = state.modelConfigIntent === "edit-model"
    ? requestedModelId
    : state.modelConfigIntent === "edit-profile"
      ? String(profile?.modelAlias ?? profile?.models?.[0]?.id ?? "").trim()
      : "";
  const editingModel = state.editingModelId
    ? profile?.models?.find((model) => model.id === state.editingModelId) ?? requestedModel
    : null;
  const hasStoredReasoningConfiguration = Boolean(editingModel);
  state.modelConfigDialogGeneration += 1;
  state.modelConfigEndpointRevision = 0;
  state.modelConfigCredentialRevision = 0;
  state.modelConfigReasoningEditRevision = 0;
  state.modelConfigReasoningLocked = false;
  state.modelConfigReasoningSource = hasStoredReasoningConfiguration ? "stored" : "unknown";
  state.modelConfigReasoningDiscovery = null;
  state.modelConfigReasoningCandidate = null;
  state.modelCapabilityProbeRunning = false;
  state.modelCapabilityProbeError = "";
  state.modelCapabilityDiscoveryToken = "";
  state.gatewayProbeRunning = false;
  state.gatewayProbeResult = null;
  state.gatewayProbeError = "";
  state.modelConfigOpen = true;
  renderModelConfigPanel();
  activateModal(els.modelConfigPanel, {
    initialFocus: "input[name='gatewayUrl']",
    returnFocus
  });
}

export function hideModelConfigPanel() {
  if (state.modelConfigSaving) {
    return;
  }
  cancelScopedRequest("gateway-probe");
  cancelScopedRequest("model-capabilities-probe");
  state.modelConfigDialogGeneration += 1;
  state.gatewayProbeRunning = false;
  state.modelCapabilityProbeRunning = false;
  state.modelCapabilityDiscoveryToken = "";
  deactivateModal(els.modelConfigPanel, { fallbackFocus: "#settings-add-model, #settings-add-source" });
  state.modelConfigOpen = false;
  state.modelConfigIntent = "";
  state.editingModelId = "";
  state.editingGatewayProfileId = "";
  renderModelConfigPanel();
}

export function renderModelPanel() {
  if (!els.modelPanel) {
    return;
  }
  els.modelPanel.classList.toggle("hidden", !state.modelPanelOpen);
  if (!state.modelPanelOpen) {
    els.modelPanel.replaceChildren();
    return;
  }
  const profiles = state.gatewayProfiles ?? [];
  const selection = currentModelSelection();
  const unresolved = selection.resolved === false;
  const activeProfileId = selection.profile?.id || "";
  const activeModelId = selection.model?.id || "";
  const models = selection.profile?.models ?? (profiles.length === 0 ? state.models ?? [] : []);
  els.modelPanel.innerHTML = `
    <div class="model-panel-head">
      <div class="model-panel-title">模型</div>
      <div class="model-panel-subtitle">当前会话</div>
    </div>
    <div class="model-switch-fields">
      <label>
        <span>模型来源</span>
        <select data-action="switch-source" ${state.running || state.modelSwitching || profiles.length === 0 ? "disabled" : ""}>
          ${profiles.length > 0
            ? `${unresolved ? `<option value="" selected disabled>请选择模型来源</option>` : ""}${profiles.map((profile) => `<option value="${escapeAttribute(profile.id)}"${!unresolved && profile.id === activeProfileId ? " selected" : ""}${profile.ready === false ? " disabled" : ""}>${escapeHtml(profile.label || profile.gatewayUrl || profile.id)}${profile.ready === false ? "（需配置）" : ""}</option>`).join("")}`
            : `<option value="">${unresolved ? "没有可用模型来源" : escapeHtml(modelSourceLabel(selection.model))}</option>`}
        </select>
      </label>
      <label>
        <span>模型名称</span>
        <select data-action="switch-model" ${state.running || state.modelSwitching || unresolved || models.length === 0 ? "disabled" : ""}>
          ${unresolved ? `<option value="" selected>请先选择模型来源</option>` : models.map((model) => `<option value="${escapeAttribute(model.id)}"${model.id === activeModelId ? " selected" : ""}>${escapeHtml(model.label || model.id)}</option>`).join("") || `<option value="">未配置模型</option>`}
        </select>
      </label>
    </div>
  `;
}

/** @param {any} model */
