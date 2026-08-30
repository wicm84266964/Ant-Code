import { init, bootstrapDashboard, observeRunStatus, updateRunStatusTone, bindEvents, normalizedResponsiveView, composerHeightFor, previewWidthBounds, clampedPreviewWidth, permissionIndexForKey, focusTrapTarget, shouldFollowTranscript, scheduleAnimationFrameOnce, cancelScheduledAnimationFrame, appendPlainDraftDelta, renderFinalAssistantBody, selectTranscriptNodesToRemove, responsiveLayoutMode, restorePreviewWidth, setPreviewWidth, syncPreviewResizeHandle, beginPreviewResize, updatePreviewResize, finishPreviewResize, handlePreviewResizeKeydown, setResponsiveView, syncResponsiveNavigation, setResponsiveSurfaceInert, handleResponsiveFileNavigation, syncVisualViewport, resizePromptInput, handlePermissionModeKeydown, requestPermissionMode, defaultGoalMaxAutoContinues, emptyGoalSnapshot, applyGoalSnapshot, renderGoalControls, renderGoalStatusBar, requestGoalMode, showGoalConfirm, hideGoalConfirm, showGoalTextPanel, hideGoalTextPanel, enableGoalWithObjective, submitGoalAction, adoptGoalRunResult, showPermissionConfirm, hidePermissionConfirm, updateContextActions, announceStatus, modalFocusableElements, activateModal, collectModalBackground, focusModalInitialTarget, deactivateModal, restoreModalAttribute, handleGlobalKeydown, closeActiveModal, loadTrust, loadSessions, restoreInitialSession, latestBackgroundSessionId, initialSessionId, rememberCurrentSession, renderSessions, sessionMeta, sessionStatusView, toggleSidebar, setSidebarCollapsed, sessionsNeedRefresh, scheduleSessionsRefresh, handleSessionAction, openSession, restoreBackgroundSnapshot, deleteSession, setSessionsRefreshState, copySessionId, newTask, rememberNewTaskModelState, restoreNewTaskModelState, refreshNewTaskModelState, addAttachmentFiles, readImageAttachment, renderAttachmentStrip, attachmentPayload, clearAttachments, sendPrompt, stableTurnRequest, dashboardRequestId, dashboardClientId, statusUrl, interruptTurn, guideTurn, cancelQueuedTurn, cancelBackgroundSubagent, backgroundCancelKey, connectEvents, ensureEventsConnected, disconnectEvents, closeEventSource, markEventConnectionAlive, armEventConnectTimer, armEventStaleTimer, scheduleEventReconnect, reconnectEventsManually, clearEventReconnectTimer, clearEventConnectTimer, clearEventStaleTimer, setConnectionState, resetEventReplayState, rememberEventCursor, handleDashboardEvent, shouldSkipDashboardEvent, beginEventTurn, renderTranscriptMessages, renderSessionFailure, setTranscriptPaging, renderTranscriptHistoryStatus, removeTranscriptHistoryStatus, transcriptFirstContentNode, handleTranscriptScroll, loadOlderTranscript, renderWorkflowPanel, renderWorkflowStrip, currentWorkflowItem, workflowSection, workflowItem, normalizeWorkflowStatus, summarizeWorkflow, appendMessage, createMessageNode, appendTranscriptNode, trimTranscriptWindow, isProtectedTranscriptNode, renderTranscriptWindowMarker, captureTranscriptViewportAnchor, restoreTranscriptViewportAnchor, transcriptNodeTop, restoreTranscriptNodeAnchor, resetTranscriptWindow, appendAssistantDraft, scheduleDraftRender, renderAssistantDraft, appendActivity, appendContextBoundary, contextBoundaryText, handleActivity, isBackgroundSubagentActivity, handleBackgroundSubagentActivity, clearBackgroundSubagentStatus, reconcileBackgroundSubagentSnapshot, backgroundSubagentDisplayStatus, backgroundSubagentVisible, updateLiveActivity, removeLiveActivity, setLiveTitle, toggleLiveStatusDetails, updateLiveStatus, liveStatusTitle, primaryLiveActivity, gatewayRetryChipText, renderBackgroundSubagentStatus, backgroundSubagentCompactLabel, backgroundSubagentTitle, backgroundSubagentMeta, backgroundSubagentCancellable, resetLiveStatus, backgroundSubagentCounts, idleRunStatus, applyIdleRunStatus, updateRunStatusForBackground, updateSessionStatus, updateTurnChangeStats, resetTurnChangeStats, normalizeChangeStats, renderComposerStatus, modelStatusHtml, unresolvedModelStatusHtml, handleModelStatusActivate, handleModelStatusKeydown, toggleModelPanel, hideModelPanel, showSettingsWorkspace, refreshSettingsConfiguration, hideSettingsWorkspace, showModelConfigPanel, hideModelConfigPanel, renderModelPanel, modelCapabilityLabels, handleModelPanelClick, handleModelPanelChange, renderSettingsView, syncSettingsRail, modelSettingsHtml, transcriptSettingsHtml, transcriptRetentionOptionsHtml, networkSettingsHtml, networkModeOptionHtml, agentSettingsHtml, reliabilitySettingsHtml, settingsSectionHeading, settingsToggleHtml, managedFieldHtml, settingsDisabled, settingsFormActions, settingsFeedbackHtml, settingsGatewayProfileHtml, gatewayProfileReadonlyLabel, providerModelKey, scopedDefaultModelLabel, settingsModelHtml, handleSettingsRailClick, initializeSettingsFormTracking, handleSettingsFormChange, settingsControlValue, changedSettingsFields, canonicalSettingsField, setSettingsFormSaving, renderSettingsFeedbackInPlace, saveSettingsConfig, handleSettingsClick, protocolDisplayName, agentModelPickerHtml, renderModelConfigPanel, handleModelConfigPanelClick, handleModelConfigInput, handleModelConfigChange, markModelConfigCredentialChanged, markModelConfigEndpointChanged, handleModelConfigModelIdChanged, markReasoningCapabilityManual, clearReasoningCapabilityControls, syncGatewayUrlHint, gatewayUrlPlaceholder, gatewayUrlHint, syncReasoningDefaultOptions, probeGateway, isCurrentModelConfigRequest, currentGatewayProbeResult, currentGatewayCatalogModels, modelConfigGatewayProfile, modelConfigEndpointChanged, modelConfigAgentModelsSnapshot, initializeAgentModelPickerSnapshot, syncAgentModelPickersForEndpoint, uniqueAgentModelCandidates, appendAgentModelOptions, renderAgentModelPickers, updateAgentModelPickerManualStatus, handleAgentModelSelection, renderGatewayProbeResult, applyProbedModel, applyGatewayDiscoveredModel, applySuggestedGatewayUrl, gatewayCredentialAction, normalizeGatewayProbeModels, normalizeReasoningDiscovery, reasoningCapabilityCandidate, applyReasoningCapabilityCandidate, ensureReasoningEffortOptions, applyPendingReasoningCapabilities, reasoningCapabilityIsActionable, renderReasoningCapabilityStatus, reasoningCapabilityStatusText, reasoningDiscoveryStatusText, probeModelCapabilities, setFormControlsSaving, setModelConfigFormSaving, renderModelConfigFailure, clearModelConfigFailure, manualAgentModelIds, saveModelConfig, saveDefaultModelSelection, switchModel, handleReasoningEffortChange, switchReasoningEffort, deleteGatewayProfile, deleteModel, updateConfigRevisions, normalizeScopedDefaultSelection, configScope, configMutationMetadata, isConfigRevisionConflict, configRevisionConflictMessage, refreshConfigRevisionsAfterConflict, normalizeGatewayConfig, normalizeDashboardSettings, mergeGatewayConfig, normalizeGatewayProfiles, normalizeConfigSource, normalizeModels, normalizeModelSource, normalizeReasoningEfforts, normalizedReasoningEffort, isDisabledReasoningEffort, configuredReasoningEffort, reasoningEffortFallbackLabel, localizedReasoningEffortLabel, reasoningEffortCatalog, reasoningEffortLabel, resolveAtomicModelSelection, currentModelSelection, currentSessionNeedsModelSelection, currentGatewayProfile, gatewayProfileById, settingsInspectedGatewayProfile, modelSourceLabel, markCurrentModel, currentModelInfo, modelDisplayName, normalizeAgentModelTiers, normalizeVisionAgent, firstVisionModelId, hasAgentModelTiers, agentModelTiersSummary, gatewaySummary, modelSaveTargetLabel, gatewaySourceNote, environmentGatewayDefaultNote, sourceBadge, sourceLabel, formatContextUsage, firstFiniteNumber, formatTokenCount, trimNumber, nonNegativeInteger, collapseCompletedActivities, clearAssistantDrafts, collapseAssistantDrafts, isMeaningfulCompletedActivity, isDuplicateDraftText, normalizeComparableText, showApproval, resolveApproval, hideApproval, showQuestion, revealInteractionPanel, renderQuestionPanel, reviewQuestionConversation, returnToQuestion, activateQuestionReviewBackground, deactivateQuestionReviewBackground, questionChoiceButton, toggleQuestionChoice, submitQuestion, cancelQuestion, finishQuestionSubmission, hideQuestion, showTrustPanel, renderTrustPanel, confirmTrust, renderQueuePanel, renderQueueItem, setPendingGuide, clearPendingGuide, syncPendingGuideFromQueue, renderGuideFeedback, guideCopy, guideSource, guideTurnFromQueue, guideButtonText, guideButtonDisabled, guideButtonVisible, syncGuideButton, shouldKeepGuideFeedback, isInterruptError, updateSendButton, showContextConfirm, hideContextConfirm, runContextAction, contextActionRequestOptions, contextSummaryLine, compactResultLine, rememberQuestionDraft, questionResolutionText, showShutdownPanel, hideShutdownPanel, shutdownDashboard, lockClosedDashboard, normalizeLifecycleActivity, shutdownRequestBody, shutdownResultIsClosed, lifecycleActivitySummary, renderShutdownActivity, renderFiles, currentImageFiles, openFile, renderOfficePreview, officePreviewMeta, officePreviewBodyHtml, renderTablePreview, normalizeTablePreview, tablePreviewMeta, renderCompactTableHtml, renderExpandedTableHtml, renderTableHtml, tableTruncationNote, maxVisibleColumns, columnLabel, renderSheetPreviewHtml, renderSheetCellHtml, resetPreview, fencedDataForFile, dataLanguageForExtension, showImageLightbox, showTableLightbox, renderLightboxImage, bindTableLightboxControls, moveLightbox, hideLightbox, setPermissionMode, clearTranscript, cancelTranscriptAnimationFrames, clearAssistantDraftTimers, hideEmptyState, showError, showNotice, renderBootstrapLoading, renderBootstrapFailure, dashboardPayloadError, bootstrapFailurePresentation, clearBootstrapStatus, scrollTranscript, isTranscriptNearBottom, syncTranscriptFollowState, followTranscript, updateTranscriptJump, beginScopedRequest, isCurrentScopedRequest, finishScopedRequest, cancelScopedRequest, isAbortError, getJson, postJson, deleteJson, dashboardFetch, responseJson, dashboardJsonHeaders, dashboardCsrfToken, messageText, messageDisplayText, userMessageDisplayText, normalizeAttachmentMetadata, imageAttachmentLine, renderMessageText, renderLinkedText, bindRichContent, linkifyFileTextNodes, replaceFileReferences, isLikelyLocalFileReference, resolveDisplayFilePath, normalizeFileReferencePath, parentDirectory, filePreviewUrl, rawFileUrl, apiFileUrl, imagePreviewUrl, isSafeInlineBitmapUrl, normalizeRelativePath, isWorkspaceRelativeToBase, copyCodeBlock, previewText, formatNumber, formatBytes, escapeHtml, escapeAttribute, formatTime, formatRelativeTime } from "./app-barrel.ts";
import { renderMarkdown } from "./markdown.ts";
import { hydrateRichContent } from "./rich-renderers.ts";
import { visibleTranscriptRole } from "./transcript.ts";

export const MANUAL_AGENT_MODEL_VALUE = "__manual_agent_model_id__";

export function eventTargetOf(event: Event): EventTarget {
  return event.target ?? event.currentTarget ?? document.body;
}

export function eventElement(event: Event): HTMLElement | null {
  const target = event.target;
  if (target instanceof HTMLElement) {
    return target;
  }
  const current = event.currentTarget;
  return current instanceof HTMLElement ? current : null;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export const emptyBackgroundSubagent: DashboardActivity = {};
export const emptySessionStatus: DashboardSessionStatus = {};

export function modelSourceOf(model: DashboardModelOption | null | undefined): DashboardModelSource | null {
  const source = model?.source;
  return typeof source === "object" && source ? source : null;
}

export function errorMessageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (isPlainObject(error) && error.message != null) {
    return String(error.message);
  }
  return String(error ?? "");
}

export type DashboardConfigSource = {
  type: string;
  label: string;
};

export type DashboardReasoningEffort = {
  id: string;
  label: string;
  description: string;
};

export type DashboardTurnChangeStats = {
  additions: number;
  deletions: number;
  files: number;
  redacted: boolean;
  truncated: boolean;
  approximate: boolean;
};

export type DashboardScopedDefaultSelection = {
  provider: string;
  model: string;
  reasoningEffort?: string;
};

export type DashboardVisionAgent = {
  enabled: boolean;
  model: string;
  autoUseWhenMainModelTextOnly: boolean;
};

export type DashboardReasoningDiscovery = {
  source: string;
  confidence: string;
  path: string | null;
  presetId: string | null;
  supportsReasoning: boolean | null;
  probeAvailable: boolean;
  warnings: string[];
};

export type DashboardReasoningCapabilityCandidate = {
  modelId: string;
  reasoningEfforts: DashboardReasoningEffort[];
  defaultReasoningEffort: string | null;
  reasoningDiscovery: DashboardReasoningDiscovery;
};

export type DashboardGatewayProbeModel = {
  id: string;
  label: string;
  contextTokens: number | null;
  modalities: string[];
  thinking: boolean;
  reasoningEfforts: DashboardReasoningEffort[];
  defaultReasoningEffort: string | null;
  reasoningDiscovery: DashboardReasoningDiscovery;
};

export type DashboardGatewayProbeResult = {
  message?: string;
  models?: DashboardGatewayProbeModel[];
  modelsUrl?: string;
  suggestedGatewayUrl?: string;
  discoveryToken?: string;
  dialogGeneration?: number;
  endpointRevision?: number;
  credentialRevision?: number;
  gatewayUrl?: string;
  gatewayProtocol?: string;
  saveTarget?: string;
};

export type DashboardLifecycleActivity = {
  sessions: number;
  activeTurns: number;
  quarantinedTurns: number;
  queuedTurns: number;
  backgroundTasks: number;
  pendingInteractions: number;
  uncertain: boolean;
  total: number;
};

export type DashboardSettings = {
  transcript: {
    enabled: boolean;
    retentionDays: number | null;
    encryption: string;
    encryptionKeyConfigured: boolean;
  };
  network: {
    mode: string;
    allowedModes: string[];
    allowedHosts: string[];
    managedAllowedHosts: string[];
  };
  agents: {
    maxParallelReadonlyAgentRuns: number;
    backgroundWakeupEnabled: boolean;
    backgroundByDefault: boolean;
    reviewGateEnabled: boolean;
    syncModelTiersOnSwitch: boolean;
    goalMaxAutoContinues: number;
  };
  reliability: {
    maxRetries: number;
    timeoutMs: number;
    idleTimeoutMs: number;
  };
  managed: {
    transcriptEnabled: boolean;
    transcriptRetentionDays: boolean;
    transcriptEncryption: boolean;
    networkMode: boolean;
    gatewayMaxRetries: boolean;
    gatewayTimeoutMs: boolean;
    gatewayIdleTimeoutMs: boolean;
  };
};

export type DashboardFile = {
  name?: string;
  kind?: string;
  source?: string;
  relativePath?: string;
  rawUrl?: string;
  downloadOnly?: boolean;
  message?: string;
  officeKind?: string;
  tableKind?: string;
  table?: unknown;
  content?: string;
  truncated?: boolean;
  extension?: string;
  [key: string]: unknown;
};

export type DashboardTableSheet = {
  name: string;
  source: string;
  rows: string[][];
  truncatedRows: boolean;
  truncatedColumns: boolean;
};

export type DashboardTablePreview = {
  kind?: string;
  totalSheets: number;
  sheets: DashboardTableSheet[];
};

export type DashboardLightboxItem = {
  type?: string;
  name?: string;
  rawUrl?: string;
  relativePath?: string;
  table?: DashboardTablePreview;
  [key: string]: unknown;
};

export type DashboardQuestionChoice = {
  value?: string;
  label?: string;
  description?: string;
  selected?: boolean;
  [key: string]: unknown;
};

export type DashboardPendingQuestion = {
  id?: string;
  prompt?: string;
  header?: string;
  question?: string;
  confirmLabel?: string;
  choices?: DashboardQuestionChoice[];
  selectedChoices?: Set<unknown>;
  allowCustom?: boolean;
  multiple?: boolean;
  customDraft?: string;
  [key: string]: unknown;
};

export type DashboardApproval = {
  id?: string;
  toolName?: string;
  reason?: string;
  sensitive?: boolean;
  outsideWorkspace?: boolean;
  preview?: unknown;
  [key: string]: unknown;
};

export type DashboardGatewayTransport = {
  baseURL?: string;
  healthURL?: string;
  protocol?: string;
  [key: string]: unknown;
};

export type DashboardScopedRequest = {
  scope: unknown;
  key: string;
  controller: AbortController;
  signal: AbortSignal;
};

export type DashboardFetchOptions = {
  signal?: AbortSignal;
  timeoutMs?: number | null;
  silent?: boolean;
};

export type DashboardModelSource = {
  id: string;
  label: string;
  profileId: string;
  ownerScope: string;
  saveTarget: string;
  editable: boolean;
};

export type DashboardSessionStatus = {
  readonlyLocked?: boolean;
  providerId?: string;
  provider?: string;
  profileId?: string;
  gatewayProfileId?: string;
  model?: string;
  selectionResolved?: boolean;
  selectionIssue?: string | null;
  reasoningEffort?: string | null;
  context?: Record<string, unknown> | null;
  [key: string]: unknown;
};

export type DashboardApiResult = {
  ok?: boolean;
  error?: string;
  status?: number;
  code?: string;
  cwd?: string;
  version?: string;
  queue?: Array<{ id?: string; kind?: string; [key: string]: unknown }>;
  item?: { id?: string; kind?: string; [key: string]: unknown };
  sessionStatus?: DashboardSessionStatus;
  sessions?: DashboardSessionSummary[];
  models?: DashboardModelOption[];
  gatewayConfig?: DashboardGatewayConfig;
  gatewayProfiles?: DashboardGatewayProfile[];
  agentModelTiers?: unknown;
  visionAgent?: unknown;
  settings?: Record<string, unknown>;
  session?: {
    id?: string;
    goal?: Record<string, unknown>;
    active?: boolean;
    running?: boolean;
    permission?: { mode?: string };
    sessionStatus?: DashboardSessionStatus;
    model?: string;
    context?: unknown;
    files?: DashboardFile[];
    status?: string;
    transcriptPage?: unknown;
    transcript?: unknown[];
    failure?: unknown;
    backgroundSnapshot?: unknown;
    eventCursor?: unknown;
  };
  sessionId?: string;
  running?: boolean;
  permission?: { mode?: string };
  files?: DashboardFile[];
  transcript?: unknown[];
  transcriptPage?: {
    cursor?: unknown;
    nextCursor?: unknown;
    hasMore?: boolean;
    total?: number;
    messages?: unknown[];
  };
  workflow?: DashboardUiState["workflow"];
  changeStats?: DashboardTurnChangeStats;
  goal?: Record<string, unknown>;
  trust?: { trusted?: boolean; readonlyLocked?: boolean; [key: string]: unknown };
  eventCursor?: unknown;
  aborted?: boolean;
  timedOut?: boolean;
  activity?: DashboardLifecycleActivity;
  probe?: DashboardGatewayProbeResult;
  discoveryToken?: string;
  modelsUrl?: string;
  suggestedGatewayUrl?: string;
  message?: string;
  model?: Record<string, unknown>;
  capability?: Record<string, unknown>;
  modelId?: string;
  file?: DashboardFile;
  after?: unknown;
  result?: Record<string, unknown>;
  configRevisions?: Record<string, unknown>;
  settingsRevisions?: Record<string, unknown>;
  revisions?: Record<string, unknown>;
  configV2?: {
    revisions?: Record<string, unknown>;
    paths?: { global?: string; project?: string };
    defaultSelections?: { global?: unknown; project?: unknown };
    [key: string]: unknown;
  };
  modelSettings?: {
    revisions?: Record<string, unknown>;
    paths?: { global?: string; project?: string };
    [key: string]: unknown;
  };
  configuration?: { revisions?: Record<string, unknown>; [key: string]: unknown };
  settingsDocuments?: Record<string, unknown>;
  scope?: unknown;
  saveTarget?: unknown;
  revision?: unknown;
  currentRevision?: unknown;
  clearedGateway?: boolean;
  [key: string]: unknown;
};

export type DashboardActivity = {
  status?: string;
  id?: string;
  title?: string;
  detail?: string;
  severity?: string;
  collapsed?: boolean;
  backgroundSubagent?: boolean;
  rawType?: string;
  coalesceKey?: string;
  groupId?: string | null;
  taskId?: string | null;
  profile?: string | null;
  kind?: string;
  summary?: string;
  toolName?: string;
  waitFor?: unknown;
  wakeParent?: boolean | null;
  wakePromptQueued?: boolean;
  retryAttempt?: number;
  retryMaxAttempts?: number;
  retryCode?: string;
  retryDelayMs?: number;
  at?: string;
  completed?: boolean;
  toolUseId?: string;
  stale?: boolean;
  staleKind?: unknown;
  staleReason?: string;
  lastProgressAt?: unknown;
  heartbeatAt?: unknown;
  staleSeconds?: number | null;
  heartbeatAgeSeconds?: number | null;
  cancellable?: boolean;
  runningCount?: number | null;
  taskCount?: number | null;
  [key: string]: unknown;
};

export type DashboardModelOption = {
  id: string;
  label?: string;
  name?: string;
  description?: string;
  thinking?: boolean;
  modalities?: string[];
  contextTokens?: number | null;
  reasoningEfforts?: DashboardReasoningEffort[];
  defaultReasoningEffort?: string;
  reasoningEffort?: string;
  agentModelTiers?: Record<string, string>;
  source?: DashboardModelSource | string;
  sources?: {
    modelAlias?: DashboardConfigSource;
    models?: DashboardConfigSource;
  };
  current?: boolean;
  default?: boolean;
  gatewayUrl?: string;
  gatewayProtocol?: string;
  [key: string]: unknown;
};

export type DashboardGatewayProfile = {
  id: string;
  label?: string;
  gatewayUrl?: string;
  gatewayHealthUrl?: string;
  gatewayProtocol?: string;
  apiKeyConfigured?: boolean;
  modelAlias?: string;
  modelCount?: number;
  ready?: boolean;
  ownerScope?: string;
  editable?: boolean;
  saveTarget?: string;
  agentModelTiers?: Record<string, string>;
  visionAgent?: DashboardVisionAgent;
  models?: DashboardModelOption[];
  current?: boolean;
  transport?: DashboardGatewayTransport;
  [key: string]: unknown;
};

export type DashboardGatewayConfig = {
  gatewayUrl: string;
  gatewayHealthUrl: string;
  gatewayProtocol: string;
  apiKeyConfigured: boolean;
  activeProfileId: string;
  globalSettingsPath: string;
  projectSettingsPath: string;
  globalConfigPath: string;
  projectConfigPath: string;
  modelAlias?: string;
  transport?: DashboardGatewayTransport;
  sources: {
    gatewayUrl: DashboardConfigSource;
    gatewayHealthUrl: DashboardConfigSource;
    gatewayProtocol: DashboardConfigSource;
    apiKey: DashboardConfigSource;
  };
};

export type DashboardModelSelection = {
  profile: DashboardGatewayProfile | null;
  model: DashboardModelOption | null;
  resolved: boolean;
  issue: string | null;
};

export type DashboardPendingGuide = {
  clientId?: string;
  sessionId?: string | null;
  phase?: string;
  preview?: string;
  guidance?: string;
  queueItemId?: string;
};

export type DashboardStreamEvent = {
  type?: string;
  message?: string;
  data?: string;
  sessionStatus?: DashboardSessionStatus;
  turnChangeStats?: DashboardTurnChangeStats;
  changeStats?: DashboardTurnChangeStats;
  queuedKind?: string;
  text?: string;
  attachments?: unknown[];
  goal?: DashboardUiState["goal"] | Record<string, unknown>;
  permission?: { mode?: string; [key: string]: unknown };
  reason?: string;
  groups?: unknown[];
  groupId?: string;
  taskId?: string;
  turnId?: string;
  queue?: DashboardUiState["queue"];
  round?: number;
  running?: boolean;
  key?: string;
  status?: string;
  item?: { id?: string; kind?: string; preview?: string; [key: string]: unknown };
  id?: string;
  allowed?: boolean;
  interrupted?: boolean;
  current?: { preview?: string; [key: string]: unknown };
  guidance?: string;
  files?: DashboardFile[];
  detail?: string;
  cancelled?: boolean;
  summary?: string;
  approval?: DashboardApproval;
  after?: unknown;
  question?: DashboardPendingQuestion;
  workflow?: DashboardUiState["workflow"];
  activity?: DashboardActivity;
  rawType?: string;
  sequence?: number;
  coalesceKey?: string;
  toolName?: string;
  backgroundSubagent?: boolean;
  profile?: string;
  waitFor?: unknown;
  wakeParent?: boolean;
  wakePromptQueued?: boolean;
  [key: string]: unknown;
};

export interface DashboardSessionSummary {
  id: string;
  title?: string;
  status?: string;
  model?: string;
  modifiedAt?: string | number | Date;
  active?: boolean;
  running?: boolean;
  queueLength?: number;
  backgroundVisible?: boolean;
  backgroundKinds?: string[];
  backgroundCount?: number;
}

export type DashboardUiState = {
  cwd: string;
  sessions: DashboardSessionSummary[];
  currentSessionId: string | null;
  eventSource: EventSource | null;
  eventSourceSessionId: string | null;
  lastEventSequence: number;
  requestScopes: Map<unknown, DashboardScopedRequest>;
  connectionState: string;
  eventReconnectAttempt: number;
  eventReconnectTimer: ReturnType<typeof setTimeout> | null;
  eventConnectTimer: ReturnType<typeof setTimeout> | null;
  eventStaleTimer: ReturnType<typeof setTimeout> | null;
  lastEventAt: number;
  permissionMode: string;
  goal: {
    enabled: boolean;
    status: string;
    text: string;
    previousPermissionMode: string;
    roundCount: number;
    continueCount: number;
    maxAutoContinues: number;
    lastContinueReason: string;
    lastBlockReason: string;
    lastEvidence: unknown;
    hasWrites: boolean;
    recap: { line?: string; [key: string]: unknown } | null;
  };
  goalSubmitting: boolean;
  pendingApproval: DashboardApproval | null;
  approvalSubmitting: boolean;
  pendingQuestion: DashboardPendingQuestion | null;
  questionSubmitting: boolean;
  questionReviewMode: boolean;
  questionReviewInertEntries: { node: HTMLElement; inert: boolean }[];
  trust: { trusted?: boolean; readonlyLocked?: boolean; [key: string]: unknown } | null;
  queue: Array<{ id?: string; kind?: string; preview?: string; [key: string]: unknown }>;
  queueCancelling: Set<unknown>;
  backgroundCancelling: Set<unknown>;
  sessionsLoading: boolean;
  sessionsStatusTimer: ReturnType<typeof setTimeout> | null;
  sessionsRefreshTimer: ReturnType<typeof setTimeout> | null;
  sessionsRefreshDueAt: number;
  sidebarCollapsed: boolean;
  deletingSessions: Set<unknown>;
  deleteConfirmSessionId: string;
  files: DashboardFile[];
  liveTitle: string;
  liveActivities: Map<string | undefined, DashboardActivity>;
  backgroundSubagents: Map<string | undefined, DashboardActivity>;
  liveStatusExpanded: boolean;
  completedActivities: DashboardActivity[];
  running: boolean;
  turnSubmitting: boolean;
  turnRequest: { id?: string; signature?: string } | null;
  pendingGuide: DashboardPendingGuide | null;
  guideSubmitting: boolean;
  attachments: Array<{
    id?: string;
    name?: string;
    mimeType?: string;
    size?: number;
    type?: string;
    data?: string;
    previewUrl?: string;
  }>;
  workflow: {
    todos?: Array<{ status?: string; content?: string; title?: string }>;
    plan?: { steps?: Array<{ status?: string; content?: string; title?: string }> };
    [key: string]: unknown;
  } | null;
  workflowNode: HTMLElement | null;
  workflowExpanded: boolean;
  models: DashboardModelOption[];
  gatewayConfig: DashboardGatewayConfig | null;
  gatewayProfiles: DashboardGatewayProfile[];
  agentModelTiers: Record<string, string>;
  visionAgent: DashboardVisionAgent | null;
  modelPanelOpen: boolean;
  applyAgentDefaultsOnSwitch: boolean;
  settingsOpen: boolean;
  settingsSection: string;
  settings: DashboardSettings | null;
  settingsSaving: boolean;
  settingsRefreshing: boolean;
  settingsSaveTarget: string;
  modelDefaultScope: "global" | "project";
  modelDefaultSelections: Record<"global" | "project", DashboardScopedDefaultSelection | null>;
  settingsProviderId: string;
  configRevisions: { global: string; project: string; credentials: string };
  configPaths: { global: string; project: string };
  settingsFeedback: { tone: string; message: string } | null;
  settingsReturnFocus: Element | null;
  modelConfigOpen: boolean;
  modelConfigSaving: boolean;
  modelConfigIntent: string;
  modelConfigDialogGeneration: number;
  modelConfigEndpointRevision: number;
  modelConfigCredentialRevision: number;
  modelConfigReasoningEditRevision: number;
  modelConfigReasoningLocked: boolean;
  modelConfigReasoningSource: string;
  modelConfigReasoningDiscovery: DashboardReasoningDiscovery | null;
  modelConfigReasoningCandidate: DashboardReasoningCapabilityCandidate | null;
  editingGatewayProfileId: string;
  gatewayProbeRunning: boolean;
  gatewayProbeResult: DashboardGatewayProbeResult | null;
  gatewayProbeError: string;
  modelCapabilityProbeRunning: boolean;
  modelCapabilityProbeError: string;
  modelCapabilityDiscoveryToken: string;
  modelSwitching: boolean;
  reasoningEffortSwitching: boolean;
  deletingModelKey: string;
  deleteConfirmModelKey: string;
  deletingGatewayProfileId: string;
  deleteConfirmGatewayProfileId: string;
  assistantDrafts: Map<string, {
    round?: number | null;
    text?: string;
    node?: HTMLElement;
    body?: HTMLElement | null;
    renderedLength?: number;
    [key: string]: unknown;
  }>;
  transcriptPaging: { cursor: unknown; hasMore: boolean; loading: boolean; error: string; total: number };
  transcriptHistoryNode: HTMLElement | null;
  transcriptWindow: { unloadedOlder: number; unloadedNewer: number; olderNode: HTMLElement | null; newerNode: HTMLElement | null };
  transcriptScrollFrame: unknown;
  transcriptScrollForce: boolean;
  activeTurnId: string;
  processedEventIds: Set<unknown>;
  lastAssistantFinalSignature: string;
  sessionStatus: DashboardSessionStatus | null;
  newTaskModelState: {
    models?: DashboardModelOption[];
    gatewayConfig?: DashboardGatewayConfig | null;
    gatewayProfiles?: DashboardGatewayProfile[];
    agentModelTiers?: Record<string, string>;
    visionAgent?: DashboardVisionAgent | null;
    sessionStatus?: DashboardSessionStatus | null;
  } | null;
  turnChangeStats: DashboardTurnChangeStats;
  lightboxItems: Array<DashboardFile | DashboardLightboxItem>;
  lightboxIndex: number;
  tableLightboxSheetIndex: number;
  editingModelId: string;
  responsiveView: string;
  previewWidth: number;
  previewPreferredWidth: number;
  previewResizeStartX: number | null;
  previewResizeStartWidth: number | null;
  transcriptFollowing: boolean;
  newReplyAvailable: boolean;
  modalContext: {
    modal: HTMLElement;
    returnFocus?: Element | null;
    inertEntries: { node: HTMLElement; inert: boolean }[];
    previousRole: string | null;
    previousAriaModal: string | null;
    previousTabIndex: string | null;
  } | null;
  shutdownActivity: DashboardLifecycleActivity | null;
  shutdownStatusVersion: number;
  dashboardClientId: string;
};

export const state: DashboardUiState = {
  cwd: "",
  sessions: /** @type {DashboardSessionSummary[]} */ ([]),
  currentSessionId: null,
  eventSource: null,
  eventSourceSessionId: null,
  lastEventSequence: 0,
  requestScopes: new Map(),
  connectionState: "idle",
  eventReconnectAttempt: 0,
  eventReconnectTimer: null,
  eventConnectTimer: /** @type {ReturnType<typeof setTimeout> | null} */ (null),
  eventStaleTimer: null,
  lastEventAt: 0,
  permissionMode: "plan",
  goal: {
    enabled: false,
    status: "off",
    text: "",
    previousPermissionMode: "plan",
    roundCount: 0,
    continueCount: 0,
    maxAutoContinues: 12,
    lastContinueReason: "",
    lastBlockReason: "",
    lastEvidence: null,
    hasWrites: false,
    recap: null
  },
  goalSubmitting: false,
  pendingApproval: null,
  approvalSubmitting: false,
  pendingQuestion: null,
  questionSubmitting: false,
  questionReviewMode: false,
  questionReviewInertEntries: /** @type {{ node: any; inert: boolean }[]} */ ([]),
  trust: null,
  queue: [],
  queueCancelling: new Set(),
  backgroundCancelling: new Set(),
  sessionsLoading: false,
  sessionsStatusTimer: null,
  sessionsRefreshTimer: null,
  sessionsRefreshDueAt: 0,
  sidebarCollapsed: false,
  deletingSessions: new Set(),
  deleteConfirmSessionId: "",
  files: [],
  liveTitle: "",
  liveActivities: new Map<string, DashboardActivity>(),
  backgroundSubagents: new Map(),
  liveStatusExpanded: false,
  completedActivities: [],
  running: false,
  turnSubmitting: false,
  turnRequest: null,
  pendingGuide: null,
  guideSubmitting: false,
  attachments: [],
  workflow: null,
  workflowNode: null,
  workflowExpanded: false,
  models: /** @type {any[]} */ ([]),
  gatewayConfig: /** @type {any} */ (null),
  gatewayProfiles: /** @type {any[]} */ ([]),
  agentModelTiers: {},
  visionAgent: /** @type {any} */ (null),
  modelPanelOpen: false,
  applyAgentDefaultsOnSwitch: true,
  settingsOpen: false,
  settingsSection: "models",
  settings: /** @type {any} */ (null),
  settingsSaving: false,
  settingsRefreshing: false,
  settingsSaveTarget: "project",
  modelDefaultScope: /** @type {"global" | "project"} */ ("project"),
  modelDefaultSelections: /** @type {Record<"global" | "project", any>} */ ({ global: null, project: null }),
  settingsProviderId: "",
  configRevisions: { global: "", project: "", credentials: "" },
  configPaths: { global: "", project: "" },
  settingsFeedback: /** @type {{ tone: string, message: string } | null} */ (null),
  settingsReturnFocus: /** @type {HTMLElement | null} */ (null),
  modelConfigOpen: false,
  modelConfigSaving: false,
  modelConfigIntent: "",
  modelConfigDialogGeneration: 0,
  modelConfigEndpointRevision: 0,
  modelConfigCredentialRevision: 0,
  modelConfigReasoningEditRevision: 0,
  modelConfigReasoningLocked: false,
  modelConfigReasoningSource: "unknown",
  modelConfigReasoningDiscovery: /** @type {any} */ (null),
  modelConfigReasoningCandidate: /** @type {any} */ (null),
  editingGatewayProfileId: "",
  gatewayProbeRunning: false,
  gatewayProbeResult: null,
  gatewayProbeError: "",
  modelCapabilityProbeRunning: false,
  modelCapabilityProbeError: "",
  modelCapabilityDiscoveryToken: "",
  modelSwitching: false,
  reasoningEffortSwitching: false,
  deletingModelKey: "",
  deleteConfirmModelKey: "",
  deletingGatewayProfileId: "",
  deleteConfirmGatewayProfileId: "",
  assistantDrafts: new Map(),
  transcriptPaging: {
    cursor: null,
    hasMore: false,
    loading: false,
    error: "",
    total: 0
  },
  transcriptHistoryNode: null,
  transcriptWindow: {
    unloadedOlder: 0,
    unloadedNewer: 0,
    olderNode: null,
    newerNode: null
  },
  transcriptScrollFrame: null,
  transcriptScrollForce: false,
  activeTurnId: "",
  processedEventIds: new Set(),
  lastAssistantFinalSignature: "",
  sessionStatus: /** @type {any} */ (null),
  newTaskModelState: /** @type {any} */ (null),
  turnChangeStats: { additions: 0, deletions: 0, files: 0, redacted: false, truncated: false, approximate: false },
  lightboxItems: [],
  lightboxIndex: 0,
  tableLightboxSheetIndex: 0,
  editingModelId: "",
  responsiveView: "conversation",
  previewWidth: 360,
  previewPreferredWidth: 360,
  previewResizeStartX: /** @type {number | null} */ (null),
  previewResizeStartWidth: /** @type {number | null} */ (null),
  transcriptFollowing: true,
  newReplyAvailable: false,
  modalContext: null,
  shutdownActivity: null,
  shutdownStatusVersion: 0,
  dashboardClientId: ""
};

export const els = {
  projectPath: document.querySelector("#project-path"),
  threadList: document.querySelector("#thread-list"),
  refreshSessions: document.querySelector("#refresh-sessions"),
  collapseSidebar: document.querySelector("#collapse-sidebar"),
  sessionsStatus: document.querySelector("#sessions-status"),
  newTask: document.querySelector("#new-task"),
  runStatus: document.querySelector("#run-status"),
  connectionStatus: document.querySelector("#connection-status"),
  workflowStrip: document.querySelector("#workflow-strip"),
  transcript: document.querySelector("#transcript"),
  transcriptJump: document.querySelector("#transcript-jump"),
  emptyState: document.querySelector("#empty-state"),
  promptInput: document.querySelector("#prompt-input"),
  attachmentInput: document.querySelector("#attachment-input"),
  attachmentStrip: document.querySelector("#attachment-strip"),
  attachButton: document.querySelector("#attach-button"),
  sendButton: document.querySelector("#send-button"),
  permissionMode: document.querySelector("#permission-mode"),
  goalMode: document.querySelector("#goal-mode"),
  goalConfirmPanel: document.querySelector("#goal-confirm-panel"),
  goalTextPanel: document.querySelector("#goal-text-panel"),
  goalStatusBar: document.querySelector("#goal-status-bar"),
  modeDescription: document.querySelector("#mode-description"),
  liveStatus: document.querySelector("#live-status"),
  activityToggle: document.querySelector("#activity-toggle"),
  liveTitle: document.querySelector("#live-title"),
  liveSubtasks: document.querySelector("#live-subtasks"),
  approvalPanel: document.querySelector("#approval-panel"),
  questionPanel: document.querySelector("#question-panel"),
  fileList: document.querySelector("#file-list"),
  previewBody: document.querySelector("#preview-body"),
  imageLightbox: document.querySelector("#image-lightbox"),
  lightboxBackdrop: document.querySelector("#lightbox-backdrop"),
  lightboxClose: document.querySelector("#lightbox-close"),
  lightboxPrevious: document.querySelector("#lightbox-previous"),
  lightboxNext: document.querySelector("#lightbox-next"),
  lightboxImage: document.querySelector("#lightbox-image"),
  lightboxTitle: document.querySelector("#lightbox-title"),
  lightboxCounter: document.querySelector("#lightbox-counter"),
  lightboxOpen: document.querySelector("#lightbox-open"),
  lightboxCanvas: document.querySelector("#lightbox-canvas"),
  lightboxTable: document.querySelector("#lightbox-table"),
  collapsePreview: document.querySelector("#collapse-preview"),
  shutdownButton: document.querySelector("#shutdown-button"),
  headerShutdownButton: document.querySelector("#header-shutdown-button"),
  shutdownPanel: document.querySelector("#shutdown-panel"),
  shutdownCopy: document.querySelector("#shutdown-copy"),
  shutdownCancel: document.querySelector("#shutdown-cancel"),
  shutdownConfirm: document.querySelector("#shutdown-confirm"),
  trustPanel: document.querySelector("#trust-panel"),
  permissionConfirmPanel: document.querySelector("#permission-confirm-panel"),
  queuePanel: document.querySelector("#queue-panel"),
  contextPanel: document.querySelector("#context-panel"),
  contextClear: document.querySelector("#context-clear"),
  contextCompact: document.querySelector("#context-compact"),
  modelPanel: document.querySelector("#model-panel"),
  modelConfigPanel: document.querySelector("#model-config-panel"),
  modelStatus: document.querySelector("#model-status"),
  settingsButton: document.querySelector("#settings-button"),
  settingsBack: document.querySelector("#settings-back"),
  settingsView: document.querySelector("#settings-view"),
  settingsRail: document.querySelector("#settings-rail"),
  settingsContent: document.querySelector("#settings-content"),
  contextStatus: document.querySelector("#context-status"),
  changeStatus: document.querySelector("#change-status"),
  contextActionHint: document.querySelector("#context-action-hint"),
  sidebar: document.querySelector("#session-panel"),
  workspace: document.querySelector(".workspace"),
  preview: document.querySelector("#file-panel"),
  previewResizeHandle: document.querySelector("#preview-resize-handle"),
  responsiveNavigation: document.querySelector("#responsive-navigation"),
  responsiveScrim: document.querySelector("#responsive-scrim"),
  dashboardLiveRegion: document.querySelector("#dashboard-live-region")
};

export const MODE_DESCRIPTIONS: Record<string, string> = {
  plan: "写入和命令需确认",
  workspace: "工作区常规操作自动同意",
  fullAccess: "高风险：本机工具和网络自动同意",
  goal: "Goal 模式：无人值守，本机工具与网络自动同意"
};
export const LOCAL_FILE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg",
  "pdf",
  "md", "markdown", "txt", "log",
  "json", "csv", "tsv", "yaml", "yml",
  "js", "mjs", "cjs", "ts", "tsx", "jsx", "css", "html", "xml",
  "py", "ps1", "cmd", "sh", "java", "c", "cpp", "h", "hpp", "cs", "go", "rs", "php", "rb", "sql", "toml", "ini",
  "doc", "docx", "xls", "xlsx", "ppt", "pptx"
]);
export const FILE_REFERENCE_PATTERN = /(?:[A-Za-z0-9_.-]+[\\/])*[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8}(?::\d+)?/g;
export const TRANSCRIPT_DOM_LIMIT = 300;
export const EVENT_STALE_AFTER_MS = 35_000;
export const EVENT_CONNECT_TIMEOUT_MS = 10_000;
export const EVENT_RECONNECT_MAX_ATTEMPTS = 6;
export const DASHBOARD_REQUEST_TIMEOUT_MS = 15_000;
export const DASHBOARD_API_VERSION = "dashboard.v2";
export const DASHBOARD_LIFECYCLE_TIMEOUT_MS = 5_000;
export const DASHBOARD_SHUTDOWN_TIMEOUT_MS = 15_000;
export const DASHBOARD_INTERRUPT_TIMEOUT_MS = 5_000;
export const MAX_IMAGE_ATTACHMENTS = 6;
export const MAX_IMAGE_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const CURRENT_SESSION_STORAGE_KEY = "ant-code-dashboard-current-session";
export const DASHBOARD_CLIENT_STORAGE_KEY = "ant-code-dashboard-client-id";
export const PREVIEW_WIDTH_STORAGE_KEY = "ant-code-dashboard-preview-width";
export const PREVIEW_WIDTH_DEFAULT = 360;
export const PREVIEW_WIDTH_MIN = 300;
export const PREVIEW_WIDTH_MAX = 640;
export const PREVIEW_WORKSPACE_MIN = 520;


