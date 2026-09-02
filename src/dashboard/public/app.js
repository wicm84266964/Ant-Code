// src/dashboard/public/app-core.ts
var MANUAL_AGENT_MODEL_VALUE = "__manual_agent_model_id__";
function eventTargetOf(event) {
  return event.target ?? event.currentTarget ?? document.body;
}
function eventElement(event) {
  const target = event.target;
  if (target instanceof HTMLElement) {
    return target;
  }
  const current = event.currentTarget;
  return current instanceof HTMLElement ? current : null;
}
function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
var emptyBackgroundSubagent = {};
var emptySessionStatus = {};
function modelSourceOf(model) {
  const source = model?.source;
  return typeof source === "object" && source ? source : null;
}
function errorMessageOf(error) {
  if (error instanceof Error) {
    return error.message;
  }
  if (isPlainObject(error) && error.message != null) {
    return String(error.message);
  }
  return String(error ?? "");
}
var state = {
  cwd: "",
  sessions: (
    /** @type {DashboardSessionSummary[]} */
    []
  ),
  currentSessionId: null,
  eventSource: null,
  eventSourceSessionId: null,
  lastEventSequence: 0,
  requestScopes: /* @__PURE__ */ new Map(),
  connectionState: "idle",
  eventReconnectAttempt: 0,
  eventReconnectTimer: null,
  eventConnectTimer: (
    /** @type {ReturnType<typeof setTimeout> | null} */
    null
  ),
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
  questionReviewInertEntries: (
    /** @type {{ node: any; inert: boolean }[]} */
    []
  ),
  trust: null,
  queue: [],
  queueCancelling: /* @__PURE__ */ new Set(),
  backgroundCancelling: /* @__PURE__ */ new Set(),
  sessionsLoading: false,
  sessionsStatusTimer: null,
  sessionsRefreshTimer: null,
  sessionsRefreshDueAt: 0,
  sidebarCollapsed: false,
  deletingSessions: /* @__PURE__ */ new Set(),
  deleteConfirmSessionId: "",
  files: [],
  liveTitle: "",
  liveActivities: /* @__PURE__ */ new Map(),
  backgroundSubagents: /* @__PURE__ */ new Map(),
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
  models: (
    /** @type {any[]} */
    []
  ),
  gatewayConfig: (
    /** @type {any} */
    null
  ),
  gatewayProfiles: (
    /** @type {any[]} */
    []
  ),
  agentModelTiers: {},
  visionAgent: (
    /** @type {any} */
    null
  ),
  modelPanelOpen: false,
  applyAgentDefaultsOnSwitch: true,
  settingsOpen: false,
  settingsSection: "models",
  settings: (
    /** @type {any} */
    null
  ),
  settingsSaving: false,
  settingsRefreshing: false,
  settingsSaveTarget: "project",
  modelDefaultScope: (
    /** @type {"global" | "project"} */
    "project"
  ),
  modelDefaultSelections: (
    /** @type {Record<"global" | "project", any>} */
    { global: null, project: null }
  ),
  settingsProviderId: "",
  configRevisions: { global: "", project: "", credentials: "" },
  configPaths: { global: "", project: "" },
  settingsFeedback: (
    /** @type {{ tone: string, message: string } | null} */
    null
  ),
  settingsReturnFocus: (
    /** @type {HTMLElement | null} */
    null
  ),
  modelConfigOpen: false,
  modelConfigSaving: false,
  modelConfigIntent: "",
  modelConfigDialogGeneration: 0,
  modelConfigEndpointRevision: 0,
  modelConfigCredentialRevision: 0,
  modelConfigReasoningEditRevision: 0,
  modelConfigReasoningLocked: false,
  modelConfigReasoningSource: "unknown",
  modelConfigReasoningDiscovery: (
    /** @type {any} */
    null
  ),
  modelConfigReasoningCandidate: (
    /** @type {any} */
    null
  ),
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
  assistantDrafts: /* @__PURE__ */ new Map(),
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
  processedEventIds: /* @__PURE__ */ new Set(),
  lastAssistantFinalSignature: "",
  sessionStatus: (
    /** @type {any} */
    null
  ),
  newTaskModelState: (
    /** @type {any} */
    null
  ),
  turnChangeStats: { additions: 0, deletions: 0, files: 0, redacted: false, truncated: false, approximate: false },
  lightboxItems: [],
  lightboxIndex: 0,
  tableLightboxSheetIndex: 0,
  editingModelId: "",
  responsiveView: "conversation",
  previewWidth: 360,
  previewPreferredWidth: 360,
  previewResizeStartX: (
    /** @type {number | null} */
    null
  ),
  previewResizeStartWidth: (
    /** @type {number | null} */
    null
  ),
  transcriptFollowing: true,
  newReplyAvailable: false,
  modalContext: null,
  shutdownActivity: null,
  shutdownStatusVersion: 0,
  dashboardClientId: ""
};
var els = {
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
var MODE_DESCRIPTIONS = {
  plan: "写入和命令需确认",
  workspace: "工作区常规操作自动同意",
  fullAccess: "高风险：本机工具和网络自动同意",
  goal: "Goal 模式：无人值守，本机工具与网络自动同意"
};
var LOCAL_FILE_EXTENSIONS = /* @__PURE__ */ new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "pdf",
  "md",
  "markdown",
  "txt",
  "log",
  "json",
  "csv",
  "tsv",
  "yaml",
  "yml",
  "js",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "jsx",
  "css",
  "html",
  "xml",
  "py",
  "ps1",
  "cmd",
  "sh",
  "java",
  "c",
  "cpp",
  "h",
  "hpp",
  "cs",
  "go",
  "rs",
  "php",
  "rb",
  "sql",
  "toml",
  "ini",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx"
]);
var FILE_REFERENCE_PATTERN = /(?:[A-Za-z0-9_.-]+[\\/])*[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8}(?::\d+)?/g;
var TRANSCRIPT_DOM_LIMIT = 300;
var EVENT_STALE_AFTER_MS = 35e3;
var EVENT_CONNECT_TIMEOUT_MS = 1e4;
var EVENT_RECONNECT_MAX_ATTEMPTS = 6;
var DASHBOARD_REQUEST_TIMEOUT_MS = 15e3;
var DASHBOARD_API_VERSION = "dashboard.v2";
var DASHBOARD_LIFECYCLE_TIMEOUT_MS = 5e3;
var DASHBOARD_SHUTDOWN_TIMEOUT_MS = 15e3;
var DASHBOARD_INTERRUPT_TIMEOUT_MS = 5e3;
var MAX_IMAGE_ATTACHMENTS = 6;
var MAX_IMAGE_ATTACHMENT_BYTES = 8 * 1024 * 1024;
var CURRENT_SESSION_STORAGE_KEY = "ant-code-dashboard-current-session";
var DASHBOARD_CLIENT_STORAGE_KEY = "ant-code-dashboard-client-id";
var PREVIEW_WIDTH_STORAGE_KEY = "ant-code-dashboard-preview-width";
var PREVIEW_WIDTH_DEFAULT = 360;
var PREVIEW_WIDTH_MIN = 300;
var PREVIEW_WIDTH_MAX = 640;
var PREVIEW_WORKSPACE_MIN = 520;

// src/dashboard/public/app-ui1.ts
async function init() {
  restorePreviewWidth();
  bindEvents();
  observeRunStatus();
  await bootstrapDashboard();
}
async function bootstrapDashboard() {
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
function observeRunStatus() {
  updateRunStatusTone();
  new MutationObserver(updateRunStatusTone).observe(els.runStatus, { childList: true, characterData: true, subtree: true });
}
function updateRunStatusTone() {
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
function bindEvents() {
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
  els.promptInput.addEventListener("keydown", (event) => {
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
  els.promptInput.addEventListener("paste", async (event) => {
    const files = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith("image/"));
    if (files.length === 0) {
      return;
    }
    event.preventDefault();
    await addAttachmentFiles(files);
  });
  document.addEventListener("keydown", handleGlobalKeydown);
  els.permissionMode.addEventListener("click", (event) => {
    const button = eventElement(event)?.closest("button[data-mode]");
    if (!(button instanceof HTMLButtonElement)) return;
    requestPermissionMode(button.dataset.mode, button);
  });
  els.permissionMode.addEventListener("keydown", handlePermissionModeKeydown);
  els.goalMode?.addEventListener("click", () => requestGoalMode());
  els.collapsePreview.addEventListener("click", () => {
    if (responsiveLayoutMode() === "desktop") {
      document.body.classList.toggle("preview-collapsed");
      syncPreviewResizeHandle();
    } else {
      setResponsiveView("conversation");
    }
  });
  els.previewResizeHandle?.addEventListener("pointerdown", (event) => beginPreviewResize(event));
  els.previewResizeHandle?.addEventListener("pointermove", (event) => updatePreviewResize(event));
  els.previewResizeHandle?.addEventListener("pointerup", (event) => finishPreviewResize(event));
  els.previewResizeHandle?.addEventListener("pointercancel", (event) => finishPreviewResize(event));
  els.previewResizeHandle?.addEventListener("keydown", (event) => handlePreviewResizeKeydown(event));
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
  els.liveSubtasks.addEventListener("click", (event) => {
    const button = eventTargetOf(event).closest("button[data-background-cancel]");
    if (!button) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    cancelBackgroundSubagent(button.dataset.groupId, button.dataset.taskId);
  });
  document.addEventListener("click", (event) => {
    if (!state.modelPanelOpen) {
      return;
    }
    if (eventTargetOf(event).closest("#model-panel") || eventTargetOf(event).closest("#model-config-panel") || eventTargetOf(event).closest("#model-status-toggle")) {
      return;
    }
    hideModelPanel();
  });
  els.transcript.addEventListener("scroll", handleTranscriptScroll);
  els.workflowStrip.addEventListener("click", (event) => {
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
  els.threadList.addEventListener("click", (event) => {
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
function normalizedResponsiveView(width, requestedView) {
  if (requestedView === "settings") return "settings";
  if (Number(width) >= 1200) return "conversation";
  return typeof requestedView === "string" && ["sessions", "conversation", "files"].includes(requestedView) ? requestedView : "conversation";
}
function composerHeightFor(scrollHeight, minimum = 52, maximum = 160) {
  const measured = Number(scrollHeight);
  const safeMinimum = Math.max(1, Number(minimum) || 52);
  const safeMaximum = Math.max(safeMinimum, Number(maximum) || 160);
  return Math.min(safeMaximum, Math.max(safeMinimum, Number.isFinite(measured) ? measured : safeMinimum));
}
function previewWidthBounds(viewportWidth, sidebarCollapsed = false) {
  const viewport = Math.max(0, Number(viewportWidth) || 0);
  const sidebarWidth = sidebarCollapsed ? 56 : 280;
  const available = viewport - 20 - 20 - sidebarWidth - PREVIEW_WORKSPACE_MIN;
  return {
    min: PREVIEW_WIDTH_MIN,
    max: Math.max(PREVIEW_WIDTH_MIN, Math.min(PREVIEW_WIDTH_MAX, available))
  };
}
function clampedPreviewWidth(width, bounds) {
  const minimum = Math.max(0, Number(bounds?.min) || PREVIEW_WIDTH_MIN);
  const maximum = Math.max(minimum, Number(bounds?.max) || PREVIEW_WIDTH_MAX);
  const value = Number(width);
  return Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : PREVIEW_WIDTH_DEFAULT));
}
function permissionIndexForKey(currentIndex, key, length) {
  const count = Math.max(0, Number(length) || 0);
  if (count === 0) return -1;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "ArrowRight" || key === "ArrowDown") return (Math.max(0, currentIndex) + 1) % count;
  if (key === "ArrowLeft" || key === "ArrowUp") return (Math.max(0, currentIndex) - 1 + count) % count;
  return currentIndex;
}
function focusTrapTarget(focusables, activeElement, shiftKey = false) {
  const items = Array.from(focusables ?? []);
  if (items.length === 0) return null;
  const current = activeElement ? items.indexOf(activeElement) : -1;
  if (current < 0) return shiftKey ? items.at(-1) : items[0];
  return items[(current + (shiftKey ? -1 : 1) + items.length) % items.length];
}
function shouldFollowTranscript({ force = false, following = true, onlyIfNearBottom = false, wasAtBottom = true } = {}) {
  if (force) return true;
  if (!following) return false;
  return !onlyIfNearBottom || wasAtBottom !== false;
}
function scheduleAnimationFrameOnce(holder, key, callback, scheduler = requestAnimationFrame) {
  if (holder[key] != null) return false;
  const frame = scheduler(() => {
    holder[key] = null;
    callback();
  });
  holder[key] = frame ?? true;
  return true;
}
function cancelScheduledAnimationFrame(holder, key, cancel = cancelAnimationFrame) {
  const frame = holder[key];
  if (frame == null) return false;
  holder[key] = null;
  if (frame !== true) cancel(Number(frame));
  return true;
}
function appendPlainDraftDelta(body, text, renderedLength = 0, createTextNode = (value) => document.createTextNode(value)) {
  const value = String(text ?? "");
  const start = Math.min(value.length, Math.max(0, Number(renderedLength) || 0));
  const pending = value.slice(start);
  if (pending) {
    if (typeof body?.append === "function") body.append(createTextNode(pending));
    else if (body) body.textContent = `${body.textContent ?? ""}${pending}`;
  }
  return value.length;
}
function renderFinalAssistantBody(body, text, renderer = renderMessageText) {
  renderer(body, text ?? "", { markdown: true });
}
function selectTranscriptNodesToRemove(nodes, limit, direction = "append", isProtected = () => false) {
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
function responsiveLayoutMode() {
  const width = Number(window.innerWidth) || Number(document.documentElement?.clientWidth) || 1200;
  if (width >= 1200) return "desktop";
  return width >= 768 ? "tablet" : "mobile";
}
function restorePreviewWidth() {
  let saved = PREVIEW_WIDTH_DEFAULT;
  try {
    saved = Number(window.localStorage?.getItem(PREVIEW_WIDTH_STORAGE_KEY)) || PREVIEW_WIDTH_DEFAULT;
  } catch {
  }
  setPreviewWidth(saved);
}
function setPreviewWidth(width, options = {}) {
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
    }
  }
  if (options.announce) announceStatus(`文件栏宽度 ${state.previewWidth} 像素`);
  return state.previewWidth;
}
function syncPreviewResizeHandle(bounds = previewWidthBounds(Number(window.innerWidth) || 1200, state.sidebarCollapsed)) {
  const handle = els.previewResizeHandle;
  if (!handle) return;
  handle.setAttribute("aria-valuemin", String(bounds.min));
  handle.setAttribute("aria-valuemax", String(bounds.max));
  handle.setAttribute("aria-valuenow", String(state.previewWidth));
  handle.setAttribute("aria-valuetext", `${state.previewWidth} 像素`);
  handle.setAttribute("aria-disabled", responsiveLayoutMode() !== "desktop" || document.body.classList.contains("preview-collapsed") ? "true" : "false");
}
function beginPreviewResize(event) {
  const handle = els.previewResizeHandle;
  if (!handle) return;
  if (responsiveLayoutMode() !== "desktop" || document.body.classList.contains("preview-collapsed")) return;
  event.preventDefault();
  state.previewResizeStartX = Number(event.clientX);
  state.previewResizeStartWidth = state.previewWidth;
  handle.setPointerCapture?.(event.pointerId);
  document.body.classList.add("preview-resizing");
}
function updatePreviewResize(event) {
  if (state.previewResizeStartX === null || state.previewResizeStartWidth === null) return;
  const delta = Number(event.clientX) - state.previewResizeStartX;
  setPreviewWidth(state.previewResizeStartWidth - delta);
}
function finishPreviewResize(event) {
  const handle = els.previewResizeHandle;
  if (!handle) return;
  if (state.previewResizeStartX === null) return;
  handle.releasePointerCapture?.(event.pointerId);
  state.previewResizeStartX = null;
  state.previewResizeStartWidth = null;
  document.body.classList.remove("preview-resizing");
  setPreviewWidth(state.previewWidth, { persist: true, announce: true });
}
function handlePreviewResizeKeydown(event) {
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
function setResponsiveView(view) {
  if (view !== "settings" && state.settingsOpen) {
    hideSettingsWorkspace({ restoreFocus: false });
  }
  state.responsiveView = normalizedResponsiveView(Number(window.innerWidth) || 1200, view);
  syncResponsiveNavigation();
}
function syncResponsiveNavigation() {
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
function setResponsiveSurfaceInert(element, inert) {
  if (!element) return;
  element.inert = Boolean(inert);
}
function handleResponsiveFileNavigation(event) {
  if (responsiveLayoutMode() === "desktop") return;
  if (eventTargetOf(event).closest(".file-item, .file-link, [data-file]")) {
    setResponsiveView("files");
  }
}
function syncVisualViewport() {
  const viewportHeight = Number(window.visualViewport?.height) || Number(window.innerHeight) || 0;
  if (viewportHeight > 0) {
    document.documentElement?.style?.setProperty("--dashboard-viewport-height", `${Math.round(viewportHeight)}px`);
  }
  const keyboardVisible = Boolean(window.visualViewport) && Number(window.innerHeight) - viewportHeight > 120;
  document.body.classList.toggle("keyboard-visible", keyboardVisible);
}
function resizePromptInput() {
  if (!els.promptInput) return;
  els.promptInput.style.height = "auto";
  const height = composerHeightFor(els.promptInput.scrollHeight);
  els.promptInput.style.height = `${height}px`;
  els.promptInput.style.overflowY = Number(els.promptInput.scrollHeight) > height ? "auto" : "hidden";
}
function handlePermissionModeKeydown(event) {
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
function requestPermissionMode(mode, trigger = document.activeElement) {
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
function defaultGoalMaxAutoContinues() {
  const value = Number(state.settings?.agents?.goalMaxAutoContinues);
  return Number.isInteger(value) && value >= 1 && value <= 100 ? value : 12;
}
function emptyGoalSnapshot() {
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
function applyGoalSnapshot(goal, options = {}) {
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
var DEFAULT_PROMPT_PLACEHOLDER = "输入任务需求，例如：整理这批实验数据并生成一份简洁报告";
function syncPromptPlaceholder() {
  if (!els.promptInput) return;
  els.promptInput.placeholder = DEFAULT_PROMPT_PLACEHOLDER;
}
function renderGoalControls() {
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
function renderGoalStatusBar() {
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
      ${showRecap ? `<div class="goal-recap">${escapeHtml(recapLine)}</div>` : `<div class="goal-continue-meta">${Number(state.goal.continueCount) || 0} / ${Number(state.goal.maxAutoContinues) || defaultGoalMaxAutoContinues()} 次续跑${continueReason ? ` · ${escapeHtml(continueReason)}` : ""}</div>`}
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
function requestGoalMode() {
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
function showGoalConfirm(trigger) {
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
function hideGoalConfirm(options = {}) {
  const panel = els.goalConfirmPanel;
  if (!panel || panel.classList.contains("hidden")) return;
  deactivateModal(panel, options);
  panel.classList.add("hidden");
  panel.replaceChildren();
}
function showGoalTextPanel(trigger) {
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
function hideGoalTextPanel(options = {}) {
  const panel = els.goalTextPanel;
  if (!panel || panel.classList.contains("hidden")) return;
  deactivateModal(panel, options);
  panel.classList.add("hidden");
  panel.replaceChildren();
}
async function enableGoalWithObjective(text) {
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
async function submitGoalAction(action, extra = {}) {
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
    clientPreviousPermissionMode: state.goal.enabled ? state.goal.previousPermissionMode : state.permissionMode,
    permissionMode: state.permissionMode
  }).catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
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
function adoptGoalRunResult(result) {
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
function showPermissionConfirm(trigger = document.activeElement) {
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
function hidePermissionConfirm(options = {}) {
  const panel = els.permissionConfirmPanel;
  if (!panel || panel.classList.contains("hidden")) return;
  deactivateModal(panel, options);
  panel.classList.add("hidden");
  panel.replaceChildren();
}
function updateContextActions() {
  const noSession = !state.currentSessionId;
  const busy = state.running || state.turnSubmitting;
  const disabled = noSession || busy;
  const hint = noSession ? "请先打开一个空闲会话" : busy ? "任务运行期间不能清空或压缩上下文" : "可管理当前会话上下文";
  for (const button of [els.contextClear, els.contextCompact]) {
    if (!button) continue;
    button.disabled = disabled;
    button.title = hint;
  }
  if (els.contextActionHint) els.contextActionHint.textContent = hint;
}
function announceStatus(message) {
  if (!els.dashboardLiveRegion || !message) return;
  els.dashboardLiveRegion.textContent = "";
  requestAnimationFrame(() => {
    els.dashboardLiveRegion.textContent = String(message);
  });
}
var FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])"
].join(",");
function modalFocusableElements(modal) {
  if (!modal) return [];
  return Array.from(modal.querySelectorAll(FOCUSABLE_SELECTOR)).filter((node) => node.getAttribute("aria-hidden") !== "true" && !node.closest("[inert]"));
}

// src/dashboard/public/app-ui2.ts
function activateModal(modal, options = {}) {
  if (!modal) return;
  if (state.modalContext?.modal === modal) {
    focusModalInitialTarget2(modal, options.initialFocus);
    return;
  }
  if (state.modalContext) {
    deactivateModal(state.modalContext.modal, { restoreFocus: false });
  }
  const inertEntries = collectModalBackground2(modal);
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
  focusModalInitialTarget2(modal, options.initialFocus);
}
function collectModalBackground2(modal) {
  const entries = [];
  const seen = /* @__PURE__ */ new Set();
  let branch = modal;
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
function focusModalInitialTarget2(modal, selector) {
  requestAnimationFrame(() => {
    if (!modal || state.modalContext?.modal !== modal) return;
    const target = typeof selector === "string" ? modal.querySelector(selector) : modalFocusableElements(modal)[0];
    (target ?? modal).focus({ preventScroll: true });
  });
}
function deactivateModal(modal, options = {}) {
  const context = state.modalContext;
  if (!context || context.modal !== modal) return;
  state.modalContext = null;
  for (const entry of context.inertEntries) entry.node.inert = entry.inert;
  modal.classList.remove("modal-interaction");
  restoreModalAttribute2(modal, "role", context.previousRole);
  restoreModalAttribute2(modal, "aria-modal", context.previousAriaModal);
  restoreModalAttribute2(modal, "tabindex", context.previousTabIndex);
  syncResponsiveNavigation();
  if (options.restoreFocus === false) return;
  const fallback = typeof options.fallbackFocus === "string" ? document.querySelector(options.fallbackFocus) : options.fallbackFocus;
  const target = context.returnFocus?.isConnected === false ? fallback : context.returnFocus ?? fallback;
  requestAnimationFrame(() => target?.focus?.({ preventScroll: true }));
}
function restoreModalAttribute2(element, name, value) {
  if (!element) return;
  if (value === null || typeof value === "undefined") element.removeAttribute(name);
  else element.setAttribute(name, String(value));
}
function handleGlobalKeydown(event) {
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
      closeActiveModal2(activeModal);
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
    returnToQuestion2();
    return;
  }
  if (event.key === "Escape") {
    if (state.modelPanelOpen) hideModelPanel();
    else if (state.settingsOpen) hideSettingsWorkspace();
    else if (state.responsiveView !== "conversation") setResponsiveView("conversation");
  }
}
function closeActiveModal2(modal) {
  if (modal === els.modelConfigPanel) hideModelConfigPanel2();
  else if (modal === els.imageLightbox) hideLightbox();
  else if (modal === els.shutdownPanel) hideShutdownPanel();
  else if (modal === els.contextPanel) hideContextConfirm2();
  else if (modal === els.permissionConfirmPanel) hidePermissionConfirm();
  else if (modal === els.goalConfirmPanel) hideGoalConfirm();
  else if (modal === els.goalTextPanel) hideGoalTextPanel();
  else if (modal === els.approvalPanel) resolveApproval2("cancel");
  else if (modal === els.questionPanel) cancelQuestion2();
}
async function loadTrust(options = {}) {
  const result = await getJson("/api/trust", { signal: options.signal }).catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error), aborted: isAbortError(error) }));
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
async function loadSessions(options = {}) {
  const feedback = options.feedback === true;
  if (!feedback && state.sessionsLoading) {
    return null;
  }
  const request = beginScopedRequest("sessions");
  if (feedback) {
    setSessionsRefreshState2("loading", "刷新中");
  }
  try {
    const result = await getJson("/api/sessions", { signal: request.signal });
    if (!isCurrentScopedRequest(request)) return result;
    if (!result.ok) {
      throw new Error(result.error ?? "刷新会话失败");
    }
    state.sessions = result.sessions ?? [];
    renderSessions2();
    if (sessionsNeedRefresh2()) {
      scheduleSessionsRefresh2(4e3);
    }
    if (feedback) {
      setSessionsRefreshState2("success", `已刷新 ${state.sessions.length} 个会话`);
    }
    return result;
  } catch (error) {
    if (isAbortError(error) || !isCurrentScopedRequest(request)) return null;
    if (feedback) {
      setSessionsRefreshState2("error", "刷新失败");
    }
    showError(errorMessageOf(error) || "刷新会话失败");
    return { ok: false, error: errorMessageOf(error) };
  } finally {
    finishScopedRequest(request);
  }
}
async function restoreInitialSession() {
  if (state.currentSessionId) {
    return;
  }
  const sessionId = initialSessionId2() || latestBackgroundSessionId2();
  if (!sessionId || !state.sessions.some((session) => session.id === sessionId)) {
    return;
  }
  await openSession2(sessionId);
}
function latestBackgroundSessionId2() {
  return state.sessions.find((session) => session.backgroundVisible === true)?.id ?? "";
}
function initialSessionId2() {
  try {
    const params = new URLSearchParams(window.location?.search ?? "");
    return params.get("sessionId") || window.localStorage?.getItem(CURRENT_SESSION_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}
function rememberCurrentSession(sessionId) {
  try {
    const id = String(sessionId ?? "").trim();
    if (id) {
      window.localStorage?.setItem(CURRENT_SESSION_STORAGE_KEY, id);
    } else {
      window.localStorage?.removeItem(CURRENT_SESSION_STORAGE_KEY);
    }
  } catch {
  }
}
function renderSessions2() {
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
    const status = sessionStatusView2(session);
    const title = session.title || "未命名任务";
    const meta = sessionMeta2(session, status);
    const item = document.createElement("div");
    item.className = `thread-item${session.id === state.currentSessionId ? " active" : ""}`;
    item.dataset.tone = status.tone;
    item.innerHTML = `
      <button type="button" class="thread-open" title="${escapeAttribute2(`${title} · ${status.label}`)}" aria-label="${escapeAttribute2(`${title}，${status.label}${meta ? `，${meta}` : ""}`)}">
        <span class="thread-status-dot" aria-hidden="true"></span>
        <div class="thread-main">
          <div class="thread-title">${escapeHtml(title)}</div>
          <div class="thread-meta">${escapeHtml(meta)}</div>
        </div>
      </button>
      ${state.deleteConfirmSessionId === session.id ? `
          <div class="thread-delete-confirm">
            <div class="thread-delete-title">确认删除这个会话？</div>
            <div class="thread-delete-copy">历史记录和 transcript 分片会被删除，操作不可撤销。</div>
            <div class="thread-actions">
              <button type="button" class="thread-action" data-action="cancel-delete" data-session-id="${escapeHtml(session.id)}">保留</button>
              <button type="button" class="thread-action danger strong" data-action="confirm-delete" data-session-id="${escapeHtml(session.id)}" ${state.deletingSessions.has(session.id) ? "disabled" : ""}>确认删除</button>
            </div>
          </div>
        ` : `
          <div class="thread-actions">
            <button type="button" class="thread-action" data-action="copy-id" data-session-id="${escapeHtml(session.id)}" title="复制会话 ID">复制 ID</button>
            <button type="button" class="thread-action danger" data-action="delete" data-session-id="${escapeHtml(session.id)}" ${session.running ? "disabled" : ""} title="${session.running ? "会话运行中，结束后可删除" : "删除会话"}">删除</button>
          </div>
        `}
    `;
    item.querySelector(".thread-open")?.addEventListener("click", () => openSession2(session.id));
    item.querySelectorAll("button[data-action]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        handleSessionAction2(String(button.dataset.action ?? ""), String(button.dataset.sessionId ?? ""));
      });
    });
    threadList.append(item);
  }
}
function sessionMeta2(session, status = sessionStatusView2(session)) {
  const parts = [
    Number(session.queueLength ?? 0) > 0 ? `${session.queueLength} 排队` : null,
    status.detail,
    session.model || null,
    formatTime2(session.modifiedAt)
  ].filter(Boolean);
  return parts.join(" · ");
}
function sessionStatusView2(session) {
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
function toggleSidebar() {
  setSidebarCollapsed2(!state.sidebarCollapsed);
}
function setSidebarCollapsed2(collapsed) {
  state.sidebarCollapsed = Boolean(collapsed);
  document.body.classList.toggle("sidebar-collapsed", state.sidebarCollapsed);
  els.collapseSidebar.textContent = state.sidebarCollapsed ? "›" : "‹";
  els.collapseSidebar.title = state.sidebarCollapsed ? "展开会话栏" : "收起会话栏";
  els.collapseSidebar.setAttribute("aria-label", els.collapseSidebar.title);
  setPreviewWidth(state.previewPreferredWidth, { updatePreference: false });
}
function sessionsNeedRefresh2() {
  return state.sessions.some(
    (session) => session.running || session.backgroundVisible || Number(session.queueLength) > 0 || String(session.status ?? "").toLowerCase() === "running"
  );
}
function scheduleSessionsRefresh2(delayMs = 800) {
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
function handleSessionAction2(action, sessionId) {
  if (!sessionId) {
    return;
  }
  if (action === "delete") {
    state.deleteConfirmSessionId = sessionId;
    renderSessions2();
    return;
  }
  if (action === "cancel-delete") {
    state.deleteConfirmSessionId = "";
    renderSessions2();
    return;
  }
  if (action === "confirm-delete") {
    deleteSession2(sessionId);
    return;
  }
  if (action === "copy-id") {
    copySessionId2(sessionId);
  }
}
async function openSession2(id) {
  state.turnRequest = null;
  const request = beginScopedRequest("session", id);
  cancelScopedRequest2("transcript");
  cancelScopedRequest2("file");
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
  disconnectEvents2();
  hideApproval2();
  hideQuestion2();
  hideContextConfirm2();
  clearTranscript2();
  resetLiveStatus2();
  state.queue = [];
  state.queueCancelling.clear();
  state.backgroundCancelling.clear();
  clearPendingGuide2();
  state.activeTurnId = "";
  resetEventReplayState();
  state.deleteConfirmSessionId = "";
  renderQueuePanel();
  state.models = markCurrentModel2(state.models, loadedSession.sessionStatus?.model ?? loadedSession.model);
  state.sessionStatus = null;
  updateSessionStatus(loadedSession.sessionStatus ?? {
    model: loadedSession.model,
    context: isPlainObject(loadedSession.context) ? loadedSession.context : null
  });
  updateSendButton();
  resetTurnChangeStats2();
  state.files = Array.isArray(loadedSession.files) ? loadedSession.files : [];
  renderFiles2();
  resetPreview2();
  els.runStatus.textContent = loadedSession.status || "历史";
  setTranscriptPaging2(loadedSession.transcriptPage);
  renderTranscriptMessages2(loadedSession.transcript ?? []);
  renderSessionFailure2(loadedSession.failure);
  scrollTranscript2({ force: true });
  const hasBackground = restoreBackgroundSnapshot2(loadedSession.backgroundSnapshot);
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
    applyIdleRunStatus2("完成");
    updateSendButton();
  }
  renderSessions2();
}
function restoreBackgroundSnapshot2(snapshot) {
  if (!isPlainObject(snapshot) || !Array.isArray(snapshot.groups)) {
    return false;
  }
  reconcileBackgroundSubagentSnapshot2(snapshot.groups);
  return state.backgroundSubagents.size > 0;
}
async function deleteSession2(sessionId) {
  if (!sessionId || state.deletingSessions.has(sessionId)) {
    return;
  }
  state.deletingSessions.add(sessionId);
  renderSessions2();
  const result = await deleteJson2(`/api/sessions/${encodeURIComponent(sessionId)}`).catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  state.deletingSessions.delete(sessionId);
  state.deleteConfirmSessionId = "";
  if (!result.ok) {
    showError(result.error ?? "删除会话失败");
    renderSessions2();
    return;
  }
  if (state.currentSessionId === sessionId) {
    newTask();
    rememberCurrentSession(null);
  }
  await loadSessions();
}
function setSessionsRefreshState2(tone, message = "") {
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
async function copySessionId2(sessionId) {
  try {
    await navigator.clipboard.writeText(sessionId);
    appendActivity2({
      title: "会话 ID 已复制",
      detail: sessionId,
      severity: "success",
      collapsed: true
    });
  } catch {
    showError("复制会话 ID 失败");
  }
}
function newTask() {
  cancelScopedRequest2("session");
  cancelScopedRequest2("transcript");
  cancelScopedRequest2("file");
  state.turnRequest = null;
  state.currentSessionId = null;
  applyGoalSnapshot(null, { permissionMode: "plan" });
  state.running = false;
  rememberCurrentSession(null);
  disconnectEvents2();
  hideApproval2();
  hideQuestion2();
  hideContextConfirm2();
  clearTranscript2();
  state.files = [];
  state.queue = [];
  state.queueCancelling.clear();
  state.backgroundCancelling.clear();
  state.completedActivities = [];
  clearPendingGuide2();
  state.activeTurnId = "";
  resetEventReplayState();
  state.deleteConfirmSessionId = "";
  resetLiveStatus2();
  resetTurnChangeStats2();
  restoreNewTaskModelState2();
  clearAttachments2();
  renderQueuePanel();
  renderFiles2();
  resetPreview2();
  els.runStatus.textContent = "空闲";
  updateSendButton();
  resizePromptInput();
  els.promptInput.focus();
  refreshNewTaskModelState2().catch(() => null);
}
function rememberNewTaskModelState() {
  state.newTaskModelState = {
    models: normalizeModels(state.models),
    gatewayConfig: normalizeGatewayConfig(state.gatewayConfig),
    gatewayProfiles: normalizeGatewayProfiles(state.gatewayProfiles),
    agentModelTiers: normalizeAgentModelTiers(state.agentModelTiers),
    visionAgent: normalizeVisionAgent(state.visionAgent),
    sessionStatus: {
      ...state.sessionStatus ?? emptySessionStatus,
      context: state.sessionStatus?.context ? { ...state.sessionStatus.context } : null
    }
  };
}
function restoreNewTaskModelState2() {
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
async function refreshNewTaskModelState2() {
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
async function addAttachmentFiles(files) {
  const list = Array.from(files ?? []);
  const images = list.filter((file) => file instanceof File && String(file.type ?? "").startsWith("image/"));
  if (images.length === 0) {
    return;
  }
  const slots = Math.max(0, MAX_IMAGE_ATTACHMENTS - state.attachments.length);
  if (slots <= 0) {
    showError(`最多可附加 ${MAX_IMAGE_ATTACHMENTS} 张图片`);
    return;
  }
  for (const file of images.slice(0, slots)) {
    if (file.size > MAX_IMAGE_ATTACHMENT_BYTES) {
      showError(`${file.name || "图片"} 超过 8MB，暂不发送`);
      continue;
    }
    try {
      state.attachments.push(await readImageAttachment2(file));
    } catch (error) {
      showError(errorMessageOf(error) || "读取图片失败");
    }
  }
  if (images.length > slots) {
    showError(`最多可附加 ${MAX_IMAGE_ATTACHMENTS} 张图片，已忽略多余图片`);
  }
  renderAttachmentStrip2();
  updateSendButton();
}
function readImageAttachment2(file) {
  return new Promise((resolve, reject) => {
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
function renderAttachmentStrip2() {
  if (!els.attachmentStrip) {
    return;
  }
  els.attachmentStrip.innerHTML = "";
  els.attachmentStrip.classList.toggle("hidden", state.attachments.length === 0);
  for (const attachment of state.attachments) {
    const item = document.createElement("div");
    item.className = "attachment-chip";
    item.innerHTML = `
      <img alt="" src="${attachment.previewUrl}" />
      <span>${escapeHtml(attachment.name || "图片")}</span>
      <button type="button" aria-label="移除 ${escapeHtml(attachment.name || "图片")}">×</button>
    `;
    item.querySelector("button").addEventListener("click", () => {
      state.attachments = state.attachments.filter((candidate) => candidate.id !== attachment.id);
      renderAttachmentStrip2();
      updateSendButton();
    });
    els.attachmentStrip.append(item);
  }
}
function attachmentPayload2(attachment) {
  return {
    type: "image",
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.size,
    data: attachment.data
  };
}
function clearAttachments2() {
  state.attachments = [];
  if (els.attachmentInput) {
    els.attachmentInput.value = "";
  }
  renderAttachmentStrip2();
}
async function sendPrompt() {
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
  const turnRequest = stableTurnRequest2(prompt, attachments);
  let result;
  try {
    result = await postJson("/api/turns", {
      requestId: turnRequest.id,
      prompt,
      attachments: attachments.map(attachmentPayload2),
      sessionId: state.currentSessionId,
      clientId: state.currentSessionId ? void 0 : dashboardClientId(),
      permissionMode: state.permissionMode,
      goalMode: state.goal.enabled === true,
      goalText: state.goal.enabled ? state.goal.text : void 0,
      clientPreviousPermissionMode: state.goal.enabled ? state.goal.previousPermissionMode : void 0
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
  clearAttachments2();
  state.queue = result.queue ?? state.queue;
  state.running = result.running === true || state.running;
  applyGoalSnapshot(result.goal ?? state.goal, { permissionMode: result.permission?.mode ?? state.permissionMode });
  updateSessionStatus(result.sessionStatus);
  updateTurnChangeStats2(result.changeStats, { replace: true });
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
function stableTurnRequest2(prompt, attachments) {
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
function dashboardRequestId() {
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
function dashboardClientId() {
  if (state.dashboardClientId) return state.dashboardClientId;
  try {
    const stored = sessionStorage.getItem(DASHBOARD_CLIENT_STORAGE_KEY);
    if (stored) {
      state.dashboardClientId = stored;
      return stored;
    }
  } catch {
  }
  const clientId = `dashboard-${dashboardRequestId()}`;
  state.dashboardClientId = clientId;
  try {
    sessionStorage.setItem(DASHBOARD_CLIENT_STORAGE_KEY, clientId);
  } catch {
  }
  return clientId;
}
function statusUrl() {
  return `/api/status?clientId=${encodeURIComponent(dashboardClientId())}`;
}
async function interruptTurn() {
  if (!state.currentSessionId) {
    return;
  }
  els.sendButton.disabled = true;
  els.sendButton.textContent = "中断中";
  const result = await postJson("/api/turns/interrupt", {
    sessionId: state.currentSessionId,
    reason: "user"
  }, { timeoutMs: DASHBOARD_INTERRUPT_TIMEOUT_MS }).catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  els.sendButton.disabled = false;
  if (!result.ok) {
    showError(result.error ?? "中断失败");
  }
  updateSessionStatus(result.sessionStatus);
  updateSendButton();
}
async function guideTurn2(queueItemId = "") {
  const source = guideSource2(queueItemId);
  if (!source || !state.currentSessionId || !state.running || state.guideSubmitting) {
    return;
  }
  const clientId = `guide-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  state.guideSubmitting = true;
  setPendingGuide2({
    clientId,
    sessionId: state.currentSessionId,
    phase: "registering",
    preview: source.preview
  });
  hideApproval2();
  hideQuestion2();
  els.runStatus.textContent = "引导中";
  setLiveTitle("正在登记引导");
  const result = await postJson("/api/turns/guide", {
    sessionId: state.currentSessionId,
    guidance: source.guidance,
    queueItemId: source.queueItemId,
    permissionMode: state.permissionMode
  }).catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  state.guideSubmitting = false;
  if (!result.ok) {
    if (state.pendingGuide?.clientId === clientId) {
      clearPendingGuide2();
    } else {
      renderQueuePanel();
    }
    showError(result.error ?? "引导失败");
    return;
  }
  els.promptInput.value = "";
  state.queue = result.queue ?? state.queue;
  updateSessionStatus(result.sessionStatus);
  hideApproval2();
  hideQuestion2();
  setPendingGuide2({
    clientId,
    sessionId: state.currentSessionId,
    phase: result.stopped ? "stopped" : "registered",
    preview: source.preview
  });
  syncGuideButton();
}
async function cancelQueuedTurn2(queueItemId) {
  if (!queueItemId || !state.currentSessionId || state.queueCancelling.has(queueItemId)) {
    return;
  }
  state.queueCancelling.add(queueItemId);
  renderQueuePanel();
  const result = await postJson("/api/turns/queue/cancel", {
    sessionId: state.currentSessionId,
    queueItemId
  }).catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  state.queueCancelling.delete(queueItemId);
  if (!result.ok) {
    showError(result.error ?? "取消排队失败");
    renderQueuePanel();
    return;
  }
  state.queue = result.queue ?? state.queue.filter((item) => item.id !== queueItemId);
  updateSessionStatus(result.sessionStatus);
  if (result.item?.kind === "guide" && state.pendingGuide?.phase !== "continuing") {
    clearPendingGuide2();
  } else {
    renderQueuePanel();
  }
  syncGuideButton();
}

// src/dashboard/public/transcript.ts
function visibleTranscriptRole(role) {
  if (role === "assistant") return "assistant";
  if (role === "user") return "user";
  return null;
}

// src/dashboard/public/app-ui3.ts
async function cancelBackgroundSubagent(groupId, taskId) {
  const key = backgroundCancelKey3(groupId, taskId);
  if (!state.currentSessionId || !key || state.backgroundCancelling.has(key)) {
    return;
  }
  state.backgroundCancelling.add(key);
  updateLiveStatus3();
  const item = Array.from(state.backgroundSubagents.values()).find((value) => groupId && value.groupId === groupId || taskId && value.taskId === taskId);
  const endpoint = item?.kind === "terminal" ? "/api/background-terminals/cancel" : "/api/background-subagents/cancel";
  const result = await postJson(endpoint, {
    sessionId: state.currentSessionId,
    groupId,
    taskId
  }).catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  state.backgroundCancelling.delete(key);
  if (!result.ok) {
    showError(result.error ?? "回收子智能体失败");
    updateLiveStatus3();
    return;
  }
  updateSessionStatus(result.sessionStatus);
  for (const [itemKey, item2] of state.backgroundSubagents.entries()) {
    if (groupId && item2.groupId === groupId || taskId && item2.taskId === taskId) {
      state.backgroundSubagents.set(itemKey, {
        ...item2,
        summary: item2.kind === "terminal" ? "已请求回收后台终端任务，等待状态刷新" : "已请求回收后台子智能体，等待状态刷新",
        status: "stale"
      });
    }
  }
  updateLiveStatus3();
  applyIdleRunStatus2("空闲");
}
function backgroundCancelKey3(groupId, taskId) {
  const group = String(groupId ?? "").trim();
  const task = String(taskId ?? "").trim();
  return group || task ? `${group || "-"}:${task || "-"}` : "";
}
function connectEvents3(sessionId) {
  clearEventReconnectTimer();
  closeEventSource();
  state.eventSourceSessionId = sessionId;
  setConnectionState(state.eventReconnectAttempt > 0 ? "reconnecting" : "connecting");
  const params = new URLSearchParams({ sessionId });
  if (state.lastEventSequence > 0) {
    params.set("after", String(state.lastEventSequence));
  }
  let source;
  try {
    source = new EventSource(`/api/events?${params.toString()}`, { withCredentials: true });
  } catch {
    scheduleEventReconnect3(sessionId);
    return;
  }
  state.eventSource = source;
  armEventConnectTimer3(source, sessionId);
  source.addEventListener("open", () => {
    if (state.eventSource !== source) return;
    clearEventConnectTimer3();
    markEventConnectionAlive3(false);
    setConnectionState("connected");
  });
  source.addEventListener("heartbeat", () => {
    if (state.eventSource === source) {
      markEventConnectionAlive3(true);
    }
  });
  source.addEventListener("dashboard", (event) => {
    if (state.eventSource !== source || state.eventSourceSessionId !== sessionId) return;
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      setConnectionState("stale");
      return;
    }
    markEventConnectionAlive3(true);
    if (shouldSkipDashboardEvent3(payload)) {
      return;
    }
    rememberEventCursor(payload.sequence);
    handleDashboardEvent3(payload);
  });
  source.addEventListener("error", () => {
    if (state.eventSource !== source) return;
    clearEventConnectTimer3();
    source.close();
    state.eventSource = null;
    clearEventStaleTimer3();
    if (navigator.onLine === false) {
      setConnectionState("offline");
      return;
    }
    scheduleEventReconnect3(sessionId);
  });
}
function ensureEventsConnected(sessionId) {
  if (state.eventSource && state.eventSourceSessionId === sessionId) {
    return;
  }
  connectEvents3(sessionId);
}
function disconnectEvents2() {
  clearEventReconnectTimer();
  clearEventConnectTimer3();
  clearEventStaleTimer3();
  closeEventSource();
  state.eventSourceSessionId = null;
  state.eventReconnectAttempt = 0;
  state.lastEventAt = 0;
  setConnectionState("idle");
}
function closeEventSource() {
  clearEventConnectTimer3();
  clearEventStaleTimer3();
  state.eventSource?.close();
  state.eventSource = null;
}
function markEventConnectionAlive3(stable = true) {
  if (stable) {
    state.eventReconnectAttempt = 0;
  }
  state.lastEventAt = Date.now();
  clearEventConnectTimer3();
  if (["connecting", "stale", "reconnecting"].includes(state.connectionState)) {
    setConnectionState("connected");
  }
  clearEventStaleTimer3();
  const sessionId = state.eventSourceSessionId;
  armEventStaleTimer3(sessionId, EVENT_STALE_AFTER_MS);
}
function armEventConnectTimer3(source, sessionId) {
  clearEventConnectTimer3();
  state.eventConnectTimer = setTimeout(() => {
    state.eventConnectTimer = null;
    if (state.eventSource !== source || state.eventSourceSessionId !== sessionId) return;
    source.close();
    state.eventSource = null;
    clearEventStaleTimer3();
    if (navigator.onLine === false) {
      setConnectionState("offline");
      return;
    }
    setConnectionState("stale");
    scheduleEventReconnect3(sessionId);
  }, EVENT_CONNECT_TIMEOUT_MS);
}
function armEventStaleTimer3(sessionId, delay) {
  state.eventStaleTimer = setTimeout(() => {
    if (!sessionId || state.eventSourceSessionId !== sessionId) return;
    const remaining = EVENT_STALE_AFTER_MS - (Date.now() - state.lastEventAt);
    if (remaining > 0) {
      armEventStaleTimer3(sessionId, remaining);
      return;
    }
    setConnectionState("stale");
    closeEventSource();
    scheduleEventReconnect3(sessionId);
  }, Math.max(1, Number(delay) || 1));
}
function scheduleEventReconnect3(sessionId) {
  if (!sessionId || state.currentSessionId !== sessionId) return;
  clearEventReconnectTimer();
  state.eventReconnectAttempt += 1;
  if (state.eventReconnectAttempt > EVENT_RECONNECT_MAX_ATTEMPTS) {
    setConnectionState("offline");
    return;
  }
  setConnectionState("reconnecting");
  const delay = Math.min(15e3, 500 * 2 ** (state.eventReconnectAttempt - 1));
  state.eventReconnectTimer = setTimeout(() => {
    state.eventReconnectTimer = null;
    if (state.currentSessionId === sessionId && navigator.onLine !== false) {
      connectEvents3(sessionId);
    }
  }, delay);
}
function reconnectEventsManually() {
  clearEventReconnectTimer();
  state.eventReconnectAttempt = 0;
  if (!state.currentSessionId) {
    bootstrapDashboard();
    return;
  }
  connectEvents3(state.currentSessionId);
}
function clearEventReconnectTimer() {
  if (state.eventReconnectTimer) {
    clearTimeout(state.eventReconnectTimer);
    state.eventReconnectTimer = null;
  }
}
function clearEventConnectTimer3() {
  if (state.eventConnectTimer) {
    clearTimeout(state.eventConnectTimer);
    state.eventConnectTimer = null;
  }
}
function clearEventStaleTimer3() {
  if (state.eventStaleTimer) {
    clearTimeout(state.eventStaleTimer);
    state.eventStaleTimer = null;
  }
}
function setConnectionState(next) {
  const previous = state.connectionState;
  state.connectionState = next;
  if (!els.connectionStatus) return;
  const labels = {
    idle: "本地网关未连接",
    connecting: "本地网关连接中",
    connected: "本地网关已连接",
    reconnecting: `本地网关重连 ${Math.max(1, state.eventReconnectAttempt)}/${EVENT_RECONNECT_MAX_ATTEMPTS}`,
    offline: "本地网关离线",
    unavailable: "本地网关未连接",
    error: "本地网关异常",
    stale: "本地网关连接过期"
  };
  const label = labels[next] ?? labels.idle;
  els.connectionStatus.dataset.state = next;
  els.connectionStatus.title = `仅此电脑可打开，文件访问按当前权限执行。${label}。点击重新连接`;
  els.connectionStatus.setAttribute("aria-label", `${label}，点击重新连接`);
  const text = els.connectionStatus.querySelector(".connection-label");
  if (text) text.textContent = label;
  if (next !== previous && ["offline", "unavailable", "error", "reconnecting", "stale"].includes(next)) {
    announceStatus(label);
  } else if (next === "connected" && ["offline", "unavailable", "error", "reconnecting", "stale"].includes(previous)) {
    announceStatus("本地网关已重新连接");
  }
}
function resetEventReplayState() {
  state.lastEventSequence = 0;
  state.processedEventIds.clear();
}
function rememberEventCursor(value) {
  const sequence = Number(value);
  if (Number.isInteger(sequence) && sequence > state.lastEventSequence) {
    state.lastEventSequence = sequence;
  }
}
function handleDashboardEvent3(event) {
  if (event.type === "session_disposed" || event.type === "error" && /会话不存在/.test(String(event.message ?? ""))) {
    state.running = false;
    state.queue = [];
    hideApproval2();
    hideQuestion2();
    clearPendingGuide2();
    resetLiveStatus2();
    disconnectEvents2();
    els.runStatus.textContent = "会话已结束";
    renderQueuePanel();
    updateSendButton();
    scheduleSessionsRefresh2(0);
    return;
  }
  hideEmptyState3();
  updateSessionStatus(event.sessionStatus);
  updateTurnChangeStats2(event.turnChangeStats ?? event.changeStats, {
    replace: event.type === "run_state" || event.type === "files_updated" || Boolean(event.turnChangeStats)
  });
  if (event.type === "user_message") {
    beginEventTurn3(event);
    updateTurnChangeStats2(null, { reset: true });
    state.lastAssistantFinalSignature = "";
    appendMessage3("user", event.queuedKind === "guide" ? "引导" : event.queuedKind === "wakeup" ? "子智能体" : event.queuedKind === "goal-continue" ? "Goal" : "你", userMessageDisplayText3(event.text, event.attachments));
    state.running = true;
    scheduleSessionsRefresh2();
    if (event.queuedKind === "guide") {
      els.runStatus.textContent = "引导中";
      setPendingGuide2({
        sessionId: state.currentSessionId,
        phase: "continuing",
        preview: event.text
      });
      setLiveTitle("正在按引导继续");
    } else {
      els.runStatus.textContent = "运行中";
      setLiveTitle("正在处理你的任务");
    }
    updateSendButton();
    return;
  }
  if (event.type === "goal_state" || event.type === "goal_continued") {
    applyGoalSnapshot(event.goal ?? state.goal, { permissionMode: event.permission?.mode });
    if (event.type === "goal_continued") {
      setLiveTitle(event.reason ? `Goal 续跑：${event.reason}` : "Goal 续跑中");
    }
    return;
  }
  if (event.type === "goal_question_skipped") {
    appendActivity2({
      title: "已跳过需求核对",
      detail: "Goal 无人值守，未打开核对面板",
      severity: "info",
      collapsed: true
    });
    return;
  }
  if (event.type === "run_state") {
    if (event.goal) {
      applyGoalSnapshot(event.goal, { permissionMode: event.permission?.mode });
    } else if (event.permission?.mode) {
      if (!(state.goal.enabled && event.permission.mode !== "fullAccess")) {
        setPermissionMode(event.permission.mode);
      }
    }
    if (event.running === true) {
      beginEventTurn3(event);
    } else if (event.running === false && event.turnId === state.activeTurnId) {
      state.activeTurnId = "";
    }
    state.running = event.running === true;
    state.queue = event.queue ?? [];
    scheduleSessionsRefresh2();
    if (state.running && event.current?.kind === "guide") {
      setPendingGuide2({
        sessionId: state.currentSessionId,
        phase: "continuing",
        preview: event.current.preview ?? state.pendingGuide?.preview ?? ""
      });
      els.runStatus.textContent = "引导中";
      setLiveTitle("正在按引导继续");
    } else if (!state.running) {
      clearPendingGuide2();
      resetLiveStatus2({ keepBackgroundSubagents: true });
      applyIdleRunStatus2("空闲");
    } else {
      els.runStatus.textContent = "运行中";
      renderQueuePanel();
    }
    updateSendButton();
    return;
  }
  if (event.type === "guide_queued") {
    state.queue = event.queue ?? [];
    scheduleSessionsRefresh2();
    setPendingGuide2({
      sessionId: state.currentSessionId,
      phase: "registered",
      preview: event.guidance ?? event.item?.preview ?? state.pendingGuide?.preview ?? ""
    });
    els.runStatus.textContent = "引导中";
    return;
  }
  if (event.type === "prompt_queued" || event.type === "queue_updated") {
    state.queue = event.queue ?? [];
    scheduleSessionsRefresh2();
    syncPendingGuideFromQueue3();
    els.runStatus.textContent = state.pendingGuide ? "引导中" : state.running ? "运行中" : "已排队";
    return;
  }
  if (event.type === "queue_item_cancelled") {
    state.queue = event.queue ?? [];
    state.queueCancelling.delete(event.item?.id);
    updateSessionStatus(event.sessionStatus);
    if (event.item?.kind === "guide" && state.pendingGuide?.phase !== "continuing") {
      clearPendingGuide2();
    } else {
      renderQueuePanel();
    }
    els.runStatus.textContent = state.queue.length > 0 ? `${state.queue.length} 条排队中` : state.running ? "运行中" : "空闲";
    return;
  }
  if (event.type === "wakeup_queued") {
    state.queue = event.queue ?? state.queue;
    scheduleSessionsRefresh2();
    clearBackgroundSubagentStatus3(event.groupId);
    renderQueuePanel();
    els.runStatus.textContent = event.running ? "主控续跑已排队" : "主控接续中";
    setLiveTitle("子智能体已唤醒主控");
    updateSendButton();
    return;
  }
  if (event.type === "background_subagent_snapshot") {
    reconcileBackgroundSubagentSnapshot2(event.groups, event.at);
    return;
  }
  if (event.type === "background_subagent_cancelled") {
    clearBackgroundSubagentStatus3(event.groupId || event.taskId);
    applyIdleRunStatus2("空闲");
    return;
  }
  if (event.type === "background_terminal_cancelled") {
    clearBackgroundSubagentStatus3(event.taskId);
    applyIdleRunStatus2("空闲");
    return;
  }
  if (event.type === "turn_interrupt_requested") {
    if (event.reason === "guided") {
      hideApproval2();
      hideQuestion2();
      setPendingGuide2({
        sessionId: state.currentSessionId,
        phase: "interrupting",
        preview: state.pendingGuide?.preview ?? state.queue.find((item) => item.kind === "guide")?.preview ?? ""
      });
      els.runStatus.textContent = "引导中";
      setLiveTitle("引导已接管，等待当前轮次收束");
    } else {
      els.runStatus.textContent = "中断中";
      setLiveTitle("正在中断当前任务");
    }
    return;
  }
  if (event.type === "guide_stopped") {
    state.queue = event.queue ?? [];
    setPendingGuide2({
      sessionId: state.currentSessionId,
      phase: "stopped",
      preview: event.guidance ?? ""
    });
    els.runStatus.textContent = "停止中";
    setLiveTitle("正在停止当前任务");
    return;
  }
  if (event.type === "context_cleared") {
    hideContextConfirm2();
    appendActivity2({
      title: "上下文已清空",
      detail: contextSummaryLine3(event.after),
      severity: "success",
      collapsed: true
    });
    return;
  }
  if (event.type === "context_boundary") {
    appendContextBoundary3(event);
    return;
  }
  if (event.type === "context_compacted") {
    appendContextBoundary3(event);
    return;
  }
  if (event.type === "activity") {
    if (event.rawType === "turn_interrupted") {
      collapseAssistantDrafts3();
    }
    if (isBackgroundSubagentActivity3(event)) {
      handleBackgroundSubagentActivity3(event);
      return;
    }
    handleActivity3(event);
    if (event.status === "waiting") els.runStatus.textContent = "等待确认";
    else if (event.status === "running") els.runStatus.textContent = state.pendingGuide ? "引导中" : "运行中";
    else if (event.status === "failed") els.runStatus.textContent = "失败";
    else if (event.rawType === "context_compacted") els.runStatus.textContent = state.running ? "运行中" : "完成";
    return;
  }
  if (event.type === "workflow_snapshot") {
    renderWorkflowPanel3(event.workflow, event.summary);
    return;
  }
  if (event.type === "assistant_draft") {
    beginEventTurn3(event);
    appendAssistantDraft3(event);
    els.runStatus.textContent = state.pendingGuide ? "引导中" : "运行中";
    state.running = true;
    scheduleSessionsRefresh2();
    updateSendButton();
    return;
  }
  if (event.type === "approval_required") {
    if (event.activity) handleActivity3(event.activity);
    showApproval3(event.approval);
    els.runStatus.textContent = "等待确认";
    setLiveTitle("等待权限确认");
    return;
  }
  if (event.type === "question_required") {
    showQuestion3(event.question);
    els.runStatus.textContent = "等待核对";
    setLiveTitle("等待需求核对");
    return;
  }
  if (event.type === "question_resolved") {
    hideQuestion2();
    if (event.interrupted && state.pendingGuide) {
      els.runStatus.textContent = "引导中";
      setLiveTitle("引导已接管，等待当前轮次收束");
      updateSendButton();
      return;
    }
    appendMessage3("user", "你", questionResolutionText3(event));
    els.runStatus.textContent = "运行中";
    state.running = true;
    scheduleSessionsRefresh2();
    updateSendButton();
    setLiveTitle(event.cancelled ? "继续处理需求核对结果" : "继续处理你的确认");
    return;
  }
  if (event.type === "approval_resolved") {
    hideApproval2();
    if (event.interrupted && state.pendingGuide) {
      els.runStatus.textContent = "引导中";
      setLiveTitle("引导已接管，等待当前轮次收束");
      updateSendButton();
      return;
    }
    els.runStatus.textContent = event.allowed ? "运行中" : "已拒绝";
    if (!event.allowed) {
      resetLiveStatus2({ keepBackgroundSubagents: true });
    }
    return;
  }
  if (event.type === "assistant_final") {
    beginEventTurn3(event);
    const finalSignature = normalizeComparableText3(event.text);
    if (finalSignature && state.lastAssistantFinalSignature === finalSignature) {
      clearAssistantDrafts3();
      return;
    }
    state.lastAssistantFinalSignature = finalSignature;
    collapseAssistantDrafts3(event.text);
    collapseCompletedActivities3();
    resetLiveStatus2({ keepBackgroundSubagents: true });
    clearPendingGuide2();
    appendMessage3("assistant", "Ant Code", event.text);
    state.activeTurnId = "";
    els.runStatus.textContent = state.backgroundSubagents.size > 0 ? idleRunStatus3("收尾中") : "收尾中";
    updateSendButton();
    scheduleSessionsRefresh2();
    return;
  }
  if (event.type === "files_updated") {
    state.files = event.files ?? [];
    renderFiles2();
    if (shouldKeepGuideFeedback3()) {
      els.runStatus.textContent = "引导中";
      updateLiveStatus3();
    } else {
      resetLiveStatus2({ keepBackgroundSubagents: true });
      applyIdleRunStatus2("完成");
      clearPendingGuide2();
    }
    updateSendButton();
    scheduleSessionsRefresh2();
    loadSessions();
    return;
  }
  if (event.type === "error") {
    if (state.pendingGuide && isInterruptError3(event.message)) {
      els.runStatus.textContent = "引导中";
      updateLiveStatus3();
      updateSendButton();
      return;
    }
    resetLiveStatus2({ keepBackgroundSubagents: true });
    clearPendingGuide2();
    showError(event.message ?? "任务失败");
    applyIdleRunStatus2("失败");
    updateSendButton();
    scheduleSessionsRefresh2();
  }
}
function shouldSkipDashboardEvent3(event) {
  if (!event || typeof event !== "object" || !event.id) {
    return false;
  }
  const id = String(event.id);
  if (state.processedEventIds.has(id)) {
    return true;
  }
  state.processedEventIds.add(id);
  if (state.processedEventIds.size > 1200) {
    state.processedEventIds = new Set(Array.from(state.processedEventIds).slice(-800));
  }
  return false;
}
function beginEventTurn3(event) {
  const turnId = typeof event.turnId === "string" ? event.turnId : "";
  if (!turnId) {
    return;
  }
  if (state.activeTurnId && state.activeTurnId !== turnId) {
    collapseAssistantDrafts3();
  }
  state.activeTurnId = turnId;
}
function renderTranscriptMessages2(messages, options = {}) {
  const nodes = [];
  const list = Array.isArray(messages) ? messages : [];
  for (const message of list) {
    const role = visibleTranscriptRole(isPlainObject(message) ? message.role : message);
    if (!role) {
      continue;
    }
    const node = createMessageNode3(role, role === "assistant" ? "Ant Code" : "你", messageDisplayText3(message.content));
    node.setAttribute("aria-live", "off");
    nodes.push(node);
  }
  if (options.prepend) {
    hideEmptyState3();
    const anchor = transcriptFirstContentNode3();
    for (const node of nodes) {
      els.transcript.insertBefore(node, anchor);
    }
    trimTranscriptWindow3({ direction: "prepend", preserveAnchor: false });
    return nodes;
  }
  for (const node of nodes) {
    appendTranscriptNode3(node, { deferTrim: true });
  }
  trimTranscriptWindow3({ direction: "append", preserveAnchor: !state.transcriptFollowing });
  return nodes;
}
function renderSessionFailure2(failure2) {
  if (!isPlainObject(failure2) || failure2.kind !== "gateway") {
    return;
  }
  const primary = String(failure2.upstreamMessage ?? failure2.message ?? "").trim() || "模型网关请求失败";
  const details = [
    primary,
    Number.isInteger(failure2.httpStatus) ? `HTTP ${failure2.httpStatus}` : null,
    Number.isInteger(failure2.attempts) && Number(failure2.attempts) > 1 ? `已尝试 ${failure2.attempts} 次` : null,
    failure2.code ? String(failure2.code) : null
  ].filter(Boolean);
  appendActivity2({
    title: "模型请求失败",
    detail: details.join(" · "),
    severity: "danger",
    collapsed: false
  });
}
function setTranscriptPaging2(page = null) {
  const record = isPlainObject(page) ? page : {};
  state.transcriptPaging = {
    cursor: record.cursor ?? record.nextCursor ?? null,
    hasMore: record.hasMore === true,
    loading: false,
    error: "",
    total: Number.isFinite(Number(record.total)) ? Number(record.total) : 0
  };
  renderTranscriptHistoryStatus3();
}
function renderTranscriptHistoryStatus3() {
  if (!state.currentSessionId) {
    removeTranscriptHistoryStatus3();
    return;
  }
  const paging = state.transcriptPaging;
  if (!paging.hasMore && !paging.loading && !paging.error) {
    removeTranscriptHistoryStatus3();
    return;
  }
  if (!state.transcriptHistoryNode) {
    state.transcriptHistoryNode = document.createElement("button");
    state.transcriptHistoryNode.type = "button";
    state.transcriptHistoryNode.className = "history-loader";
    state.transcriptHistoryNode.addEventListener("click", () => loadOlderTranscript3());
  }
  state.transcriptHistoryNode.disabled = paging.loading;
  state.transcriptHistoryNode.dataset.state = paging.error ? "error" : paging.loading ? "loading" : "idle";
  state.transcriptHistoryNode.textContent = paging.error ? "加载失败，点击重试" : paging.loading ? "正在加载更早记录" : "加载更早记录";
  if (els.transcript.firstChild !== state.transcriptHistoryNode) {
    els.transcript.insertBefore(state.transcriptHistoryNode, els.transcript.firstChild);
  }
}
function removeTranscriptHistoryStatus3() {
  state.transcriptHistoryNode?.remove();
  state.transcriptHistoryNode = null;
}
function transcriptFirstContentNode3() {
  let node = state.transcriptHistoryNode?.parentElement === els.transcript ? state.transcriptHistoryNode.nextSibling : els.transcript.firstChild;
  if (node === els.emptyState) node = node.nextSibling;
  return node;
}
function handleTranscriptScroll() {
  syncTranscriptFollowState3();
  if (els.transcript.scrollTop > 180) {
    return;
  }
  if (!state.transcriptPaging.hasMore || state.transcriptPaging.loading) {
    return;
  }
  loadOlderTranscript3();
}
async function loadOlderTranscript3() {
  if (!state.currentSessionId || !state.transcriptPaging.hasMore || state.transcriptPaging.loading) {
    return;
  }
  const sessionId = state.currentSessionId;
  const request = beginScopedRequest("transcript", sessionId);
  const before = state.transcriptPaging.cursor;
  state.transcriptPaging.loading = true;
  state.transcriptPaging.error = "";
  renderTranscriptHistoryStatus3();
  const previousHeight = els.transcript.scrollHeight;
  const previousTop = els.transcript.scrollTop;
  const anchor = transcriptFirstContentNode3();
  const anchorTop = transcriptNodeTop3(anchor);
  const result = await getJson(`/api/sessions/${encodeURIComponent(sessionId)}/transcript?${new URLSearchParams({
    before: String(before ?? ""),
    limit: "100"
  }).toString()}`, { signal: request.signal }).catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error), aborted: isAbortError(error) }));
  if (!isCurrentScopedRequest(request) || state.currentSessionId !== sessionId) return;
  finishScopedRequest(request);
  state.transcriptPaging.loading = false;
  if (result.aborted) return;
  if (!result.ok) {
    state.transcriptPaging.error = result.error ?? "加载失败";
    renderTranscriptHistoryStatus3();
    return;
  }
  const page = result.transcriptPage;
  state.transcriptPaging.cursor = page?.cursor ?? page?.nextCursor ?? null;
  state.transcriptPaging.hasMore = page?.hasMore === true;
  const pageTotal = Number(page?.total);
  state.transcriptPaging.total = Number.isFinite(pageTotal) ? pageTotal : state.transcriptPaging.total;
  renderTranscriptMessages2(result.transcript ?? [], { prepend: true });
  state.transcriptPaging.error = "";
  renderTranscriptHistoryStatus3();
  if (!restoreTranscriptNodeAnchor3(anchor, anchorTop)) {
    const delta = els.transcript.scrollHeight - previousHeight;
    els.transcript.scrollTop = previousTop + delta;
  }
}
function renderWorkflowPanel3(workflow, summary = null) {
  const record = isPlainObject(workflow) ? workflow : null;
  const todos = Array.isArray(record?.todos) ? record.todos : [];
  const plan = isPlainObject(record?.plan) ? record.plan : null;
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  if (!record || !todos.length && !steps.length) {
    state.workflow = null;
    state.workflowExpanded = false;
    renderWorkflowStrip();
    return;
  }
  hideEmptyState3();
  state.workflow = {
    ...record,
    todos,
    plan: plan ? { ...plan, steps } : void 0
  };
  if (!state.workflowNode) {
    state.workflowNode = document.createElement("section");
    state.workflowNode.className = "workflow-panel";
    appendTranscriptNode3(state.workflowNode);
  }
  const totals = isPlainObject(summary) ? {
    total: Number(summary.total ?? 0),
    completed: Number(summary.completed ?? 0),
    pending: Number(summary.pending ?? 0),
    in_progress: Number(summary.in_progress ?? 0),
    cancelled: Number(summary.cancelled ?? 0)
  } : summarizeWorkflow3({ todos, plan: plan ? { steps } : void 0 });
  const percent = Number(totals.total) > 0 ? Math.round(Number(totals.completed) / Number(totals.total) * 100) : 0;
  state.workflowNode.innerHTML = `
    <div class="workflow-head">
      <div>
        <div class="workflow-kicker">任务进度</div>
        <div class="workflow-title">${totals.completed}/${totals.total} 已完成</div>
      </div>
      <div class="workflow-percent">${percent}%</div>
    </div>
    <div class="workflow-meter"><span style="width: ${percent}%"></span></div>
    ${todos.length ? workflowSection3("Todo", todos) : ""}
    ${steps.length ? workflowSection3("Plan", steps) : ""}
  `;
  renderWorkflowStrip();
  scrollTranscript2();
}
function renderWorkflowStrip() {
  if (!state.workflow || !state.workflow.todos?.length && !state.workflow.plan?.steps?.length) {
    els.workflowStrip.classList.add("hidden");
    els.workflowStrip.innerHTML = "";
    return;
  }
  const totals = summarizeWorkflow3(state.workflow);
  const percent = totals.total > 0 ? Math.round(totals.completed / totals.total * 100) : 0;
  const activeItem = currentWorkflowItem3(state.workflow);
  const title = activeItem ? `正在：${activeItem.content ?? activeItem.title ?? ""}` : totals.completed === totals.total && totals.total > 0 ? "任务已完成" : "等待下一步";
  els.workflowStrip.classList.remove("hidden");
  els.workflowStrip.innerHTML = `
    <button class="workflow-strip-toggle" type="button" data-action="toggle-workflow" aria-expanded="${state.workflowExpanded ? "true" : "false"}">
      <span class="workflow-strip-label">任务进度</span>
      <strong>${totals.completed}/${totals.total}</strong>
      <span class="workflow-strip-current">${escapeHtml(title)}</span>
      <span class="workflow-strip-percent">${percent}%</span>
      <span class="workflow-strip-chevron">${state.workflowExpanded ? "收起" : "展开"}</span>
    </button>
    <div class="workflow-strip-meter"><span style="width: ${percent}%"></span></div>
    ${state.workflowExpanded ? `<div class="workflow-strip-detail">
      ${state.workflow.todos?.length ? workflowSection3("Todo", state.workflow.todos, Number.POSITIVE_INFINITY) : ""}
      ${state.workflow.plan?.steps?.length ? workflowSection3("Plan", state.workflow.plan.steps, Number.POSITIVE_INFINITY) : ""}
    </div>` : ""}
  `;
}
function currentWorkflowItem3(workflow) {
  const record = isPlainObject(workflow) ? workflow : {};
  const todos = Array.isArray(record.todos) ? record.todos : [];
  const plan = isPlainObject(record.plan) ? record.plan : {};
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  const items = [...todos, ...steps];
  return items.find((item) => normalizeWorkflowStatus3(item.status) === "in_progress") ?? items.find((item) => normalizeWorkflowStatus3(item.status) === "pending") ?? null;
}
function workflowSection3(label, items = [], limit = 8) {
  return `
    <div class="workflow-section">
      <div class="workflow-section-title">${label}</div>
      <div class="workflow-list">
        ${items.slice(0, limit).map((item) => workflowItem3(item)).join("")}
      </div>
    </div>
  `;
}
function workflowItem3(item = {}) {
  const status = normalizeWorkflowStatus3(item.status);
  return `
    <div class="workflow-item ${status}">
      <span class="workflow-mark"></span>
      <span class="workflow-text">${escapeHtml(item.content ?? item.title ?? "")}</span>
    </div>
  `;
}
function normalizeWorkflowStatus3(status) {
  if (status === "completed" || status === "in_progress" || status === "cancelled") {
    return status;
  }
  return "pending";
}
function summarizeWorkflow3(workflow) {
  const items = [...workflow?.todos ?? [], ...workflow?.plan?.steps ?? []];
  return {
    total: items.length,
    pending: items.filter((item) => item.status === "pending").length,
    in_progress: items.filter((item) => item.status === "in_progress").length,
    completed: items.filter((item) => item.status === "completed").length,
    cancelled: items.filter((item) => item.status === "cancelled").length
  };
}
function appendMessage3(kind, label, text) {
  const wasAtBottom = isTranscriptNearBottom3();
  const node = createMessageNode3(kind, label, text);
  appendTranscriptNode3(node);
  scrollTranscript2({ onlyIfNearBottom: true, wasAtBottom });
  if (kind === "assistant") announceStatus("收到新的助手回复");
}
function createMessageNode3(kind, label, text) {
  hideEmptyState3();
  const node = document.createElement("article");
  node.className = `message ${kind}`;
  node.setAttribute("aria-live", "off");
  node.innerHTML = `
    <div class="message-label">${escapeHtml(label)}</div>
    <div class="message-body"></div>
  `;
  const body = node.querySelector(".message-body");
  if (kind === "assistant") renderFinalAssistantBody(body, text);
  else renderMessageText(body, text ?? "", { markdown: false });
  return node;
}
function appendTranscriptNode3(node, options = {}) {
  hideEmptyState3();
  els.transcript.append(node);
  if (!options.deferTrim) {
    trimTranscriptWindow3({ direction: "append", preserveAnchor: !state.transcriptFollowing });
  }
}
function trimTranscriptWindow3(options = {}) {
  const direction = options.direction === "prepend" ? "prepend" : "append";
  const windowSide = direction === "prepend" ? "newer" : "older";
  const markerKey = windowSide === "newer" ? "newerNode" : "olderNode";
  const willAddMarker = !state.transcriptWindow[markerKey];
  const limit = Math.max(1, TRANSCRIPT_DOM_LIMIT - (willAddMarker ? 1 : 0));
  const nodes = Array.from(els.transcript.children ?? []);
  const toRemove = selectTranscriptNodesToRemove(nodes, limit, direction, isProtectedTranscriptNode3);
  if (toRemove.length === 0) return 0;
  const anchor = options.preserveAnchor ? captureTranscriptViewportAnchor3(new Set(toRemove)) : null;
  for (const node of toRemove) node.remove();
  const countKey = windowSide === "newer" ? "unloadedNewer" : "unloadedOlder";
  state.transcriptWindow[countKey] += toRemove.length;
  renderTranscriptWindowMarker3(windowSide);
  restoreTranscriptViewportAnchor3(anchor);
  return toRemove.length;
}
function isProtectedTranscriptNode3(node) {
  return node === els.emptyState || node === state.transcriptHistoryNode || node === state.workflowNode || node === state.transcriptWindow.olderNode || node === state.transcriptWindow.newerNode || node.classList.contains("draft-message");
}

// src/dashboard/public/app-ui4.ts
function renderTranscriptWindowMarker3(side) {
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
      if (state.currentSessionId) openSession2(state.currentSessionId);
    });
    state.transcriptWindow[nodeKey] = node;
  }
  const count = state.transcriptWindow[countKey];
  node.querySelector("span").textContent = side === "newer" ? `较新的 ${count} 项已从页面卸载` : `较早的 ${count} 项已从页面卸载`;
  if (side === "newer") {
    els.transcript.append(node);
    return;
  }
  const before = state.transcriptHistoryNode?.parentElement === els.transcript ? state.transcriptHistoryNode.nextSibling : els.transcript.firstChild;
  els.transcript.insertBefore(node, before);
}
function captureTranscriptViewportAnchor3(excluded = /* @__PURE__ */ new Set()) {
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
function restoreTranscriptViewportAnchor3(anchor) {
  if (!anchor?.node || anchor.node.parentElement !== els.transcript) return false;
  const transcriptTop = els.transcript.getBoundingClientRect?.().top ?? 0;
  const nextTop = anchor.node.getBoundingClientRect?.().top;
  if (!Number.isFinite(nextTop)) return false;
  els.transcript.scrollTop += nextTop - transcriptTop - Number(anchor.offset ?? 0);
  return true;
}
function transcriptNodeTop3(node) {
  if (!(node instanceof Element) || node.parentElement !== els.transcript) {
    return null;
  }
  return node.getBoundingClientRect().top;
}
function restoreTranscriptNodeAnchor3(node, previousTop) {
  if (!Number.isFinite(Number(previousTop)) || !(node instanceof Element) || node.parentElement !== els.transcript) return false;
  const nextTop = node.getBoundingClientRect().top;
  if (!Number.isFinite(nextTop)) return false;
  els.transcript.scrollTop += nextTop - Number(previousTop);
  return true;
}
function resetTranscriptWindow4() {
  state.transcriptWindow.olderNode?.remove();
  state.transcriptWindow.newerNode?.remove();
  state.transcriptWindow = {
    unloadedOlder: 0,
    unloadedNewer: 0,
    olderNode: null,
    newerNode: null
  };
}
function appendAssistantDraft3(event) {
  const wasAtBottom = isTranscriptNearBottom3();
  hideEmptyState3();
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
    appendTranscriptNode3(node);
  }
  draft.text += String(event.text ?? "");
  scheduleDraftRender4(draft);
  scrollTranscript2({ onlyIfNearBottom: true, wasAtBottom });
  setLiveTitle("正在生成回复");
}
function scheduleDraftRender4(draft) {
  scheduleAnimationFrameOnce(draft, "renderFrame", () => renderAssistantDraft4(draft));
}
function renderAssistantDraft4(draft, options = {}) {
  const wasAtBottom = isTranscriptNearBottom3();
  if (options.force) cancelScheduledAnimationFrame(draft, "renderFrame");
  if (draft.renderedLength === String(draft.text ?? "").length) {
    return;
  }
  draft.renderedLength = appendPlainDraftDelta(draft.body, draft.text, draft.renderedLength);
  scrollTranscript2({ onlyIfNearBottom: true, wasAtBottom });
}
function appendActivity2(activity) {
  const wasAtBottom = isTranscriptNearBottom3();
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
  appendTranscriptNode3(node);
  scrollTranscript2({ onlyIfNearBottom: true, wasAtBottom });
  if (activity.severity === "danger" || activity.severity === "warning") announceStatus(activity.title);
}
function appendContextBoundary3(event = {}) {
  const wasAtBottom = isTranscriptNearBottom3();
  hideEmptyState3();
  const node = document.createElement("div");
  node.className = "context-boundary";
  node.setAttribute("role", "separator");
  node.innerHTML = `
    <span class="context-boundary-line" aria-hidden="true"></span>
    <span class="context-boundary-label">${escapeHtml(contextBoundaryText4(event))}</span>
    <span class="context-boundary-line" aria-hidden="true"></span>
  `;
  appendTranscriptNode3(node);
  scrollTranscript2({ onlyIfNearBottom: true, wasAtBottom });
}
function contextBoundaryText4(event = {}) {
  const detail = String(event.detail ?? "").trim();
  if (detail) {
    return `${event.title ?? "聊天内容已压缩"}，${detail}`;
  }
  return "聊天内容已压缩，以下回复基于压缩后的上下文继续";
}
function handleActivity3(activity) {
  if (activity.status === "running" || activity.status === "waiting") {
    updateLiveActivity4(activity);
    return;
  }
  const shouldKeep = activity.status === "failed" || activity.status === "blocked" || isMeaningfulCompletedActivity4(activity);
  removeLiveActivity4(activity);
  if (shouldKeep) {
    state.completedActivities.push(activity);
  }
}
function isBackgroundSubagentActivity3(activity) {
  const rawType = String(activity?.rawType ?? "");
  return activity?.backgroundSubagent === true || activity?.kind === "terminal" || rawType.startsWith("subagent_group_") || rawType.startsWith("background_terminal_");
}
function handleBackgroundSubagentActivity3(activity) {
  const key = activity.coalesceKey || activity.groupId || activity.taskId || activity.id;
  const previous = state.backgroundSubagents.get(key) ?? emptyBackgroundSubagent;
  const rawType = String(activity.rawType ?? "");
  const kind = typeof activity.kind === "string" ? activity.kind : typeof previous.kind === "string" ? previous.kind : rawType.startsWith("background_terminal_") ? "terminal" : void 0;
  const merged = {
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
    status: backgroundSubagentDisplayStatus4(activity, previous)
  };
  if (backgroundSubagentVisible4(merged)) {
    state.backgroundSubagents.set(key, merged);
  } else {
    state.backgroundSubagents.delete(key);
  }
  updateLiveStatus3();
  updateRunStatusForBackground4(backgroundSubagentVisible4(merged) ? "空闲" : "完成");
}
function clearBackgroundSubagentStatus3(groupId) {
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
  updateLiveStatus3();
}
function reconcileBackgroundSubagentSnapshot2(groups, snapshotAt) {
  const visibleGroups = Array.isArray(groups) ? groups.filter(backgroundSubagentVisible4) : [];
  const nextKeys = /* @__PURE__ */ new Set();
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
      title: group.kind === "terminal" ? group.status === "cancelling" ? "终端后台任务正在确认退出" : "终端后台运行中" : group.status === "waiting" ? "等待子智能体唤醒主控" : "子智能体后台运行中",
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
      at: group.updatedAt ?? previous.at ?? (/* @__PURE__ */ new Date()).toISOString()
    });
  }
  for (const [key, item] of state.backgroundSubagents.entries()) {
    const tracked = item.kind === "terminal" || item.groupId || String(key).startsWith("subagent-group:") || String(key).startsWith("background-terminal:");
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
  updateLiveStatus3();
  applyIdleRunStatus2("完成");
}
function backgroundSubagentDisplayStatus4(activity, previous = {}) {
  if (activity.rawType === "subagent_group_wakeup" || activity.wakePromptQueued === true) {
    return "waiting";
  }
  if (activity.rawType === "subagent_group_started") {
    return "running";
  }
  if (activity.completed === true) {
    const wakeParent = typeof activity.wakeParent === "boolean" ? activity.wakeParent : previous.wakeParent;
    const waitFor = activity.waitFor ?? previous.waitFor;
    return wakeParent !== false && waitFor !== "none" ? "waiting" : activity.status ?? "completed";
  }
  return activity.status ?? previous.status ?? "running";
}
function backgroundSubagentVisible4(activity) {
  return activity.status === "starting" || activity.status === "running" || activity.status === "cancelling" || activity.status === "waiting" || activity.status === "stale" || activity.status === "lost";
}
function updateLiveActivity4(activity) {
  const key = activity.coalesceKey || activity.toolUseId || activity.id;
  state.liveActivities.set(key, activity);
  setLiveTitle(activity.title || "正在处理");
}
function removeLiveActivity4(activity) {
  const key = activity.coalesceKey || activity.toolUseId || activity.id;
  state.liveActivities.delete(key);
  updateLiveStatus3();
}
function setLiveTitle(title) {
  state.liveTitle = title;
  updateLiveStatus3();
}
function toggleLiveStatusDetails() {
  if (state.backgroundSubagents.size === 0) {
    return;
  }
  state.liveStatusExpanded = !state.liveStatusExpanded;
  updateLiveStatus3();
}
function updateLiveStatus3() {
  const active = Array.from(state.liveActivities.values()).filter((activity) => activity.status === "running" || activity.status === "waiting");
  const background = Array.from(state.backgroundSubagents.values()).filter(backgroundSubagentVisible4);
  if (background.length === 0) {
    state.liveStatusExpanded = false;
  }
  const visible = state.running || active.length > 0 || background.length > 0 || state.liveTitle;
  els.liveStatus.classList.toggle("hidden", !visible);
  els.liveStatus.classList.toggle("has-background-subagents", background.length > 0);
  els.liveStatus.classList.toggle("expanded", state.liveStatusExpanded && background.length > 0);
  els.activityToggle.disabled = background.length === 0;
  els.activityToggle.setAttribute("aria-expanded", String(state.liveStatusExpanded && background.length > 0));
  els.activityToggle.setAttribute("aria-label", background.length > 0 ? `${state.liveStatusExpanded ? "收起" : "展开"}后台活动详情` : "当前活动");
  if (!visible) {
    els.liveTitle.textContent = "";
    els.liveSubtasks.innerHTML = "";
    return;
  }
  const primary = primaryLiveActivity4(active);
  const subtasks = active.filter((activity) => activity.toolName === "agent_run");
  els.liveTitle.textContent = liveStatusTitle4(primary, subtasks, background);
  els.liveSubtasks.innerHTML = "";
  if (primary?.rawType === "gateway_retry") {
    const chip = document.createElement("div");
    chip.className = "live-chip retry";
    chip.innerHTML = `<span class="chip-pulse" aria-hidden="true"></span>${escapeHtml(gatewayRetryChipText4(primary))}`;
    els.liveSubtasks.append(chip);
  }
  for (const task of subtasks.slice(0, 4)) {
    const chip = document.createElement("div");
    chip.className = "live-chip";
    chip.innerHTML = `<span class="chip-pulse" aria-hidden="true"></span>${escapeHtml(task.profile ? `${task.profile} 子任务运行中` : "子智能体运行中")}`;
    els.liveSubtasks.append(chip);
  }
  renderBackgroundSubagentStatus4(background);
}
function liveStatusTitle4(primary, subtasks, background) {
  if (primary?.rawType === "gateway_retry") {
    return "网关响应异常，正在自动重试";
  }
  if (background.length > 0 && (!primary || primary.title === "开始任务")) {
    const counts = backgroundSubagentCounts4();
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
  return primary?.title === "开始任务" && subtasks.length > 0 ? "子智能体运行中" : primary?.title || state.liveTitle || "正在处理";
}
function primaryLiveActivity4(active) {
  return active.find((activity) => activity.rawType === "gateway_retry") || active.find((activity) => activity.toolName !== "agent_run") || active[0];
}
function gatewayRetryChipText4(activity) {
  const attempt = Number.isFinite(activity.retryAttempt) && Number.isFinite(activity.retryMaxAttempts) ? `${activity.retryAttempt}/${activity.retryMaxAttempts}` : "";
  const code = activity.retryCode ? String(activity.retryCode) : "gateway";
  const delay = Number.isFinite(activity.retryDelayMs) ? `${activity.retryDelayMs}ms` : "";
  return ["重试", attempt, code, delay].filter(Boolean).join(" · ");
}
function renderBackgroundSubagentStatus4(background) {
  if (background.length === 0) {
    return;
  }
  const ordered = background.sort((left, right) => String(right.at ?? "").localeCompare(String(left.at ?? "")));
  if (!state.liveStatusExpanded) {
    for (const item of ordered.slice(0, 3)) {
      const chip = document.createElement("div");
      chip.className = `live-chip background-subagent-chip ${item.status}`;
      const cancelKey = backgroundCancelKey3(item.groupId, item.taskId);
      const cancelling = state.backgroundCancelling.has(cancelKey);
      chip.innerHTML = `
        <span class="chip-pulse" aria-hidden="true"></span>
        ${escapeHtml(backgroundSubagentCompactLabel4(item))}
        ${backgroundSubagentCancellable4(item) ? `
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
    const cancelKey = backgroundCancelKey3(item.groupId, item.taskId);
    const cancelling = state.backgroundCancelling.has(cancelKey);
    row.innerHTML = `
      <div class="live-subagent-head">
        <div class="live-subagent-title">
          <span class="chip-pulse" aria-hidden="true"></span>
          <span>${escapeHtml(backgroundSubagentTitle4(item))}</span>
        </div>
        ${backgroundSubagentCancellable4(item) ? `
          <button type="button" class="live-subagent-cancel" data-background-cancel="true" data-group-id="${escapeHtml(item.groupId ?? "")}" data-task-id="${escapeHtml(item.taskId ?? "")}" ${cancelling ? "disabled" : ""}>${cancelling ? "回收中" : "回收"}</button>
        ` : ""}
      </div>
      <div class="live-subagent-meta">${escapeHtml(backgroundSubagentMeta4(item))}</div>
      ${item.staleReason ? `<div class="live-subagent-warning">${escapeHtml(item.staleReason)}</div>` : ""}
      ${item.summary ? `<div class="live-subagent-summary">${escapeHtml(item.summary)}</div>` : ""}
    `;
    els.liveSubtasks.append(row);
  }
}
function backgroundSubagentCompactLabel4(item) {
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
function backgroundSubagentTitle4(item) {
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
function backgroundSubagentMeta4(item) {
  if (item.kind === "terminal") {
    return [
      item.taskId ? `task=${item.taskId}` : null,
      item.status === "starting" ? "启动中" : null,
      item.status === "cancelling" ? "退出确认中" : null,
      item.runningCount === 1 ? "运行中" : null,
      item.lastProgressAt ? `更新 ${formatRelativeTime4(item.lastProgressAt)}` : null
    ].filter(Boolean).join(" · ");
  }
  return [
    item.groupId ? `group=${item.groupId}` : null,
    item.taskId ? `task=${item.taskId}` : null,
    item.waitFor ? `waitFor=${item.waitFor}` : null,
    Number.isFinite(item.runningCount) && Number.isFinite(item.taskCount) ? `${item.runningCount}/${item.taskCount} 运行中` : null,
    item.lastProgressAt ? `进展 ${formatRelativeTime4(item.lastProgressAt)}` : null,
    item.heartbeatAt ? `心跳 ${formatRelativeTime4(item.heartbeatAt)}` : null,
    item.wakeParent === false ? "仅记录" : "自动唤醒"
  ].filter(Boolean).join(" · ");
}
function backgroundSubagentCancellable4(item) {
  return item.cancellable !== false && (item.status === "starting" || item.status === "running" || item.status === "stale" || item.status === "lost");
}
function resetLiveStatus2(options = {}) {
  state.running = false;
  state.liveTitle = "";
  state.liveActivities.clear();
  if (!options.keepBackgroundSubagents) {
    state.backgroundSubagents.clear();
    state.liveStatusExpanded = false;
  }
  updateLiveStatus3();
  updateSendButton();
}
function backgroundSubagentCounts4() {
  const items = Array.from(state.backgroundSubagents.values()).filter(backgroundSubagentVisible4);
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
function idleRunStatus3(fallback) {
  const counts = backgroundSubagentCounts4();
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
function applyIdleRunStatus2(fallback = "空闲") {
  if (state.running) {
    return;
  }
  els.runStatus.textContent = idleRunStatus3(fallback);
}
function updateRunStatusForBackground4(fallback = "空闲") {
  if (state.running) {
    return;
  }
  const current = els.runStatus.textContent.trim();
  const base = /子智能体|终端后台任务|唤醒/.test(current) ? fallback : current || fallback;
  els.runStatus.textContent = idleRunStatus3(base);
}
function updateSessionStatus(status) {
  if (!status || typeof status !== "object") {
    renderComposerStatus();
    return;
  }
  state.sessionStatus = {
    ...state.sessionStatus,
    ...status,
    context: status.context ?? state.sessionStatus?.context ?? null
  };
  state.models = markCurrentModel2(state.models, state.sessionStatus.model);
  renderComposerStatus();
  renderSettingsView4();
}
function updateTurnChangeStats2(stats, options = {}) {
  if (options.reset) {
    resetTurnChangeStats2();
    return;
  }
  if (!stats || typeof stats !== "object") {
    renderComposerStatus();
    return;
  }
  const normalized = normalizeChangeStats4(stats);
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
function resetTurnChangeStats2() {
  state.turnChangeStats = { additions: 0, deletions: 0, files: 0, redacted: false, truncated: false, approximate: false };
  renderComposerStatus();
}
function normalizeChangeStats4(stats) {
  return {
    additions: nonNegativeInteger4(stats.additions),
    deletions: nonNegativeInteger4(stats.deletions),
    files: nonNegativeInteger4(stats.files),
    redacted: stats.redacted === true,
    truncated: stats.truncated === true,
    approximate: stats.approximate === true
  };
}
function renderComposerStatus() {
  if (!els.modelStatus || !els.contextStatus || !els.changeStatus) {
    return;
  }
  const selection = currentModelSelection4();
  const model = selection.model?.id || state.sessionStatus?.model || "";
  const modelInfo = selection.model ?? currentModelInfo4(model);
  const context = state.sessionStatus?.context ?? null;
  els.modelStatus.innerHTML = selection.resolved === false ? unresolvedModelStatusHtml4() : modelStatusHtml4(modelInfo, model);
  const toggle = els.modelStatus.querySelector("#model-status-toggle");
  if (toggle) {
    toggle.disabled = state.running || state.modelSwitching;
  }
  els.contextStatus.textContent = `上下文 ${formatContextUsage4(context)}`;
  const stats = state.turnChangeStats;
  const hasChanges = nonNegativeInteger4(stats.additions) > 0 || nonNegativeInteger4(stats.deletions) > 0 || stats.redacted === true;
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
      <span class="change-add">+${nonNegativeInteger4(stats.additions)}</span>
      <span class="change-del">-${nonNegativeInteger4(stats.deletions)}</span>
      ${suffix ? `<span class="change-meta">· ${escapeHtml(suffix)}</span>` : ""}
    `;
  } else {
    els.changeStatus.replaceChildren();
  }
}
function modelStatusHtml4(modelInfo, fallbackModel) {
  const label = modelInfo?.label || fallbackModel || "未配置";
  const source = modelSourceLabel4(modelInfo);
  const efforts = normalizeReasoningEfforts4(modelInfo?.reasoningEfforts);
  const sessionDefinesEffort = Object.prototype.hasOwnProperty.call(state.sessionStatus ?? emptySessionStatus, "reasoningEffort");
  const selectedEffort = configuredReasoningEffort4(
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
        ${efforts.map((effort) => `<option value="${escapeAttribute2(effort.id)}"${selectedEffort === effort.id ? " selected" : ""}${effort.description ? ` title="${escapeAttribute2(effort.description)}"` : ""}>${escapeHtml(effort.label)}</option>`).join("")}
      </select>
    </label>
  `;
}
function unresolvedModelStatusHtml4() {
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
function handleModelStatusActivate(event) {
  const toggle = eventTargetOf(event).closest("#model-status-toggle");
  if (!toggle || toggle.disabled || event.type === "click" && event.detail === 0) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  toggleModelPanel4();
}
function handleModelStatusKeydown(event) {
  const toggle = eventTargetOf(event).closest("#model-status-toggle");
  if (!toggle || toggle.disabled) {
    return;
  }
  if (event.key !== "Enter" && event.key !== " ") {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  toggleModelPanel4();
}
function toggleModelPanel4() {
  const toggle = els.modelStatus.querySelector("#model-status-toggle");
  if (toggle?.disabled) {
    return;
  }
  state.modelPanelOpen = !state.modelPanelOpen;
  renderModelPanel4();
  renderComposerStatus();
}
function hideModelPanel() {
  state.modelPanelOpen = false;
  renderModelPanel4();
  renderComposerStatus();
}
function showSettingsWorkspace() {
  const opening = !state.settingsOpen;
  if (opening) {
    state.settingsReturnFocus = document.activeElement;
    if (!gatewayProfileById4(state.settingsProviderId)) {
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
  renderSettingsView4();
  syncResponsiveNavigation();
  requestAnimationFrame(() => els.settingsBack?.focus?.({ preventScroll: true }));
  if (opening) refreshSettingsConfiguration4();
}
async function refreshSettingsConfiguration4() {
  if (state.settingsRefreshing || state.settingsSaving || state.modelConfigSaving) return;
  const request = beginScopedRequest("settings-refresh");
  state.settingsRefreshing = true;
  renderSettingsView4();
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
    renderSettingsView4();
    renderComposerStatus();
  } catch (error) {
    if (!isAbortError(error) && isCurrentScopedRequest(request) && state.settingsOpen) {
      state.settingsFeedback = { tone: "error", message: error instanceof Error ? error.message : "读取设置失败" };
      renderSettingsView4();
    }
  } finally {
    const current = isCurrentScopedRequest(request);
    if (current) state.settingsRefreshing = false;
    finishScopedRequest(request);
    if (current && state.settingsOpen) renderSettingsView4();
  }
}
function hideSettingsWorkspace(options = {}) {
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
function showModelConfigPanel4(modelId = "", profileId = "", intent = "") {
  cancelScopedRequest2("gateway-probe");
  cancelScopedRequest2("model-capabilities-probe");
  const returnFocus = document.activeElement;
  const requestedProfileId = String(profileId ?? "").trim();
  const requestedModelId = String(modelId ?? "").trim();
  const requestedProfile = gatewayProfileById4(requestedProfileId);
  const requestedModel = requestedModelId ? requestedProfile?.models?.find((model) => model.id === requestedModelId) ?? currentModelInfo4(requestedModelId) : null;
  const requestedSource = modelSourceOf(requestedModel);
  const modelProfileId = String(requestedSource?.profileId ?? requestedSource?.id ?? "").trim();
  state.modelConfigIntent = intent === "add-source" || intent === "add-model" || intent === "edit-model" || intent === "edit-profile" ? intent : requestedModelId ? "edit-model" : requestedProfileId ? "edit-profile" : "add-source";
  state.editingGatewayProfileId = state.modelConfigIntent === "add-source" ? "" : requestedProfileId || modelProfileId || "";
  const profile = gatewayProfileById4(state.editingGatewayProfileId);
  state.editingModelId = state.modelConfigIntent === "edit-model" ? requestedModelId : state.modelConfigIntent === "edit-profile" ? String(profile?.modelAlias ?? profile?.models?.[0]?.id ?? "").trim() : "";
  const editingModel = state.editingModelId ? profile?.models?.find((model) => model.id === state.editingModelId) ?? requestedModel : null;
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
  renderModelConfigPanel4();
  activateModal(els.modelConfigPanel, {
    initialFocus: "input[name='gatewayUrl']",
    returnFocus
  });
}
function hideModelConfigPanel2() {
  if (state.modelConfigSaving) {
    return;
  }
  cancelScopedRequest2("gateway-probe");
  cancelScopedRequest2("model-capabilities-probe");
  state.modelConfigDialogGeneration += 1;
  state.gatewayProbeRunning = false;
  state.modelCapabilityProbeRunning = false;
  state.modelCapabilityDiscoveryToken = "";
  deactivateModal(els.modelConfigPanel, { fallbackFocus: "#settings-add-model, #settings-add-source" });
  state.modelConfigOpen = false;
  state.modelConfigIntent = "";
  state.editingModelId = "";
  state.editingGatewayProfileId = "";
  renderModelConfigPanel4();
}
function renderModelPanel4() {
  if (!els.modelPanel) {
    return;
  }
  els.modelPanel.classList.toggle("hidden", !state.modelPanelOpen);
  if (!state.modelPanelOpen) {
    els.modelPanel.replaceChildren();
    return;
  }
  const profiles = state.gatewayProfiles ?? [];
  const selection = currentModelSelection4();
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
          ${profiles.length > 0 ? `${unresolved ? `<option value="" selected disabled>请选择模型来源</option>` : ""}${profiles.map((profile) => `<option value="${escapeAttribute2(profile.id)}"${!unresolved && profile.id === activeProfileId ? " selected" : ""}${profile.ready === false ? " disabled" : ""}>${escapeHtml(profile.label || profile.gatewayUrl || profile.id)}${profile.ready === false ? "（需配置）" : ""}</option>`).join("")}` : `<option value="">${unresolved ? "没有可用模型来源" : escapeHtml(modelSourceLabel4(selection.model))}</option>`}
        </select>
      </label>
      <label>
        <span>模型名称</span>
        <select data-action="switch-model" ${state.running || state.modelSwitching || unresolved || models.length === 0 ? "disabled" : ""}>
          ${unresolved ? `<option value="" selected>请先选择模型来源</option>` : models.map((model) => `<option value="${escapeAttribute2(model.id)}"${model.id === activeModelId ? " selected" : ""}>${escapeHtml(model.label || model.id)}</option>`).join("") || `<option value="">未配置模型</option>`}
        </select>
      </label>
    </div>
  `;
}

// src/dashboard/public/app-ui5.ts
function modelCapabilityLabels5(model) {
  if (!model || typeof model !== "object") {
    return [];
  }
  const modalities = new Set(Array.isArray(model?.modalities) ? model.modalities : ["text"]);
  const labels = [];
  if (modalities.has("text")) labels.push("文本");
  if (modalities.has("image")) labels.push("视觉");
  if (model?.thinking) labels.push("thinking");
  return labels.length > 0 ? labels : ["文本"];
}
function handleModelPanelClick(event) {
  event.stopPropagation();
}
async function handleModelPanelChange(event) {
  event.stopPropagation();
  const select = eventElement(event)?.closest("select[data-action]");
  if (!(select instanceof HTMLSelectElement) || select.disabled) return;
  if (select.dataset.action === "switch-source") {
    const profile = (state.gatewayProfiles ?? []).find((item) => item.id === select.value);
    const modelId = profile?.modelAlias || profile?.models?.[0]?.id || "";
    await switchModel5(modelId, { profileId: profile?.id || "", keepPanelOpen: true });
  } else if (select.dataset.action === "switch-model") {
    await switchModel5(select.value, { profileId: currentModelSelection4().profile?.id || "" });
  }
}
function renderSettingsView4() {
  if (!els.settingsContent || !state.settingsOpen) return;
  els.settingsContent.toggleAttribute("aria-busy", state.settingsRefreshing);
  syncSettingsRail5();
  const sectionHtml = state.settingsSection === "transcript" ? transcriptSettingsHtml5() : state.settingsSection === "network" ? networkSettingsHtml5() : state.settingsSection === "agents" ? agentSettingsHtml5() : state.settingsSection === "reliability" ? reliabilitySettingsHtml5() : modelSettingsHtml5();
  els.settingsContent.innerHTML = `${settingsFeedbackHtml5()}${sectionHtml}`;
  els.settingsContent.querySelectorAll("form[data-settings-form]").forEach((form) => {
    initializeSettingsFormTracking5(
      /** @type {HTMLFormElement} */
      form
    );
  });
}
function syncSettingsRail5() {
  els.settingsRail?.querySelectorAll("button[data-settings-section]").forEach((button) => {
    const active = button.dataset.settingsSection === state.settingsSection;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
}
function modelSettingsHtml5() {
  const profiles = state.gatewayProfiles ?? [];
  const inspectedProfile = settingsInspectedGatewayProfile5();
  const models = inspectedProfile?.models ?? [];
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
          <strong>${escapeHtml(scopedDefaultModelLabel5(scopedDefault))}</strong>
        </div>
      </div>
      <div class="settings-current-source">
        <span class="settings-current-label">查看来源</span>
        <strong>${escapeHtml(inspectedProfile?.label || "未选择来源")}</strong>
        <span>${escapeHtml(inspectedProfile?.gatewayUrl || "未配置网关")}</span>
      </div>
      <div class="settings-profile-list">
        ${profiles.map((profile) => settingsGatewayProfileHtml5(profile)).join("") || `<div class="settings-empty">尚未保存模型来源</div>`}
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
          <button class="settings-primary-action" id="settings-add-model" type="button" data-action="add-model" data-profile-id="${escapeAttribute2(inspectedProfile?.id || "")}"${!inspectedProfile || inspectedProfile.editable === false || state.settingsRefreshing || state.running ? " disabled" : ""}>添加模型</button>
        </div>
      </div>
      <div class="settings-model-list">
        ${models.map((model) => settingsModelHtml5(model, inspectedProfile, models.length)).join("") || `<div class="settings-empty">该来源没有已注册模型</div>`}
      </div>
    </section>
  `;
}
function transcriptSettingsHtml5() {
  const settings = state.settings ?? normalizeDashboardSettings(null);
  const transcript = settings.transcript;
  const managed = settings.managed;
  return `
    <form class="settings-form" data-settings-form="transcript">
      <section class="settings-section" aria-labelledby="settings-transcript-title">
        ${settingsSectionHeading5("隐私与历史", "会话记录", "settings-transcript-title")}
        <div class="settings-control-list">
          <label class="settings-toggle-row">
            <span><strong>保存会话历史</strong>${managedFieldHtml5(managed.transcriptEnabled)}</span>
            <input name="enabled" type="checkbox"${transcript.enabled ? " checked" : ""}${settingsDisabled5(managed.transcriptEnabled)} />
          </label>
          <label class="settings-field-row">
            <span><strong>保留期限</strong>${managedFieldHtml5(managed.transcriptRetentionDays)}</span>
            <select name="retentionDays" required${settingsDisabled5(managed.transcriptRetentionDays)}>
              ${transcriptRetentionOptionsHtml5(transcript.retentionDays)}
            </select>
          </label>
          <label class="settings-field-row">
            <span><strong>本地记录加密</strong>${managedFieldHtml5(managed.transcriptEncryption)}</span>
            <select name="encryption"${settingsDisabled5(managed.transcriptEncryption)}>
              <option value="off"${transcript.encryption === "off" ? " selected" : ""}>关闭</option>
              <option value="optional"${transcript.encryption === "optional" ? " selected" : ""}>有密钥时加密</option>
              <option value="required"${transcript.encryption === "required" ? " selected" : ""}${!transcript.encryptionKeyConfigured && transcript.encryption !== "required" ? " disabled" : ""}>强制加密</option>
            </select>
          </label>
        </div>
      </section>
      ${settingsFormActions5()}
    </form>
  `;
}
function transcriptRetentionOptionsHtml5(current) {
  const options = [
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
  return options.map(([value, label]) => `<option value="${escapeAttribute2(value)}"${value === currentValue ? " selected" : ""}>${escapeHtml(label)}</option>`).join("");
}
function networkSettingsHtml5() {
  const settings = state.settings ?? normalizeDashboardSettings(null);
  const network = settings.network;
  return `
    <form class="settings-form" data-settings-form="network">
      <section class="settings-section" aria-labelledby="settings-network-title">
        ${settingsSectionHeading5("网络边界", "出站访问", "settings-network-title")}
        <div class="settings-control-list">
          <label class="settings-field-row">
            <span><strong>网络模式</strong>${managedFieldHtml5(settings.managed.networkMode)}</span>
            <select name="mode"${settingsDisabled5(settings.managed.networkMode)}>
              ${networkModeOptionHtml5("offline", "离线", network)}
              ${networkModeOptionHtml5("lab-only", "仅实验室", network)}
              ${networkModeOptionHtml5("approved-web", "仅允许列表", network)}
              ${networkModeOptionHtml5("open-dev", "开放开发网络", network)}
            </select>
          </label>
          <label class="settings-field-stack">
            <span><strong>允许的主机</strong>${network.managedAllowedHosts.length > 0 ? `<small>环境追加 ${network.managedAllowedHosts.length} 个</small>` : ""}</span>
            <textarea name="allowedHosts" rows="10" spellcheck="false"${settingsDisabled5(false)}>${escapeHtml(network.allowedHosts.join("\n"))}</textarea>
          </label>
        </div>
      </section>
      ${settingsFormActions5()}
    </form>
  `;
}
function networkModeOptionHtml5(value, label, network) {
  const allowed = Array.isArray(network.allowedModes) && network.allowedModes.includes(value);
  return `<option value="${escapeAttribute2(value)}"${network.mode === value ? " selected" : ""}${allowed ? "" : " disabled"}>${escapeHtml(label)}</option>`;
}
function agentSettingsHtml5() {
  const settings = state.settings ?? normalizeDashboardSettings(null);
  const agents = settings.agents;
  return `
    <form class="settings-form" data-settings-form="agents">
      <section class="settings-section" aria-labelledby="settings-agents-title">
        ${settingsSectionHeading5("子智能体", "默认行为", "settings-agents-title")}
        <div class="settings-control-list">
          <label class="settings-field-row">
            <span><strong>只读任务并行数</strong></span>
            <span class="settings-number-control"><input name="maxParallelReadonlyAgentRuns" type="number" min="1" max="8" step="1" required value="${escapeAttribute2(agents.maxParallelReadonlyAgentRuns)}"${settingsDisabled5(false)} /><span>个</span></span>
          </label>
          ${settingsToggleHtml5("backgroundWakeupEnabled", "允许后台子智能体", agents.backgroundWakeupEnabled)}
          ${settingsToggleHtml5("backgroundByDefault", "模型子任务默认后台运行", agents.backgroundByDefault)}
          ${settingsToggleHtml5("reviewGateEnabled", "交付前审查提醒", agents.reviewGateEnabled)}
          ${settingsToggleHtml5("syncModelTiersOnSwitch", "切换主模型时同步子智能体", agents.syncModelTiersOnSwitch, agentModelTiersSummary5(state.agentModelTiers))}
        </div>
      </section>
      <section class="settings-section" aria-labelledby="settings-goal-title">
        ${settingsSectionHeading5("Goal 模式", "自动续跑", "settings-goal-title")}
        <div class="settings-control-list">
          <label class="settings-field-row">
            <span><strong>自动续跑上限</strong></span>
            <span class="settings-number-control"><input name="goalMaxAutoContinues" type="number" min="1" max="100" step="1" required value="${escapeAttribute2(agents.goalMaxAutoContinues)}"${settingsDisabled5(false)} /><span>次</span></span>
          </label>
        </div>
      </section>
      ${settingsFormActions5()}
    </form>
  `;
}
function reliabilitySettingsHtml5() {
  const settings = state.settings ?? normalizeDashboardSettings(null);
  const reliability = settings.reliability;
  const managed = settings.managed;
  return `
    <form class="settings-form" data-settings-form="reliability">
      <section class="settings-section" aria-labelledby="settings-reliability-title">
        ${settingsSectionHeading5("网关可靠性", "请求策略", "settings-reliability-title")}
        <div class="settings-control-list">
          <label class="settings-field-row">
            <span><strong>失败重试</strong>${managedFieldHtml5(managed.gatewayMaxRetries)}</span>
            <span class="settings-number-control"><input name="maxRetries" type="number" min="0" max="5" step="1" required value="${escapeAttribute2(reliability.maxRetries)}"${settingsDisabled5(managed.gatewayMaxRetries)} /><span>次</span></span>
          </label>
          <label class="settings-field-row">
            <span><strong>总超时</strong>${managedFieldHtml5(managed.gatewayTimeoutMs)}</span>
            <span class="settings-number-control"><input name="timeoutSeconds" type="number" min="1" max="900" step="1" required value="${escapeAttribute2(Math.round(reliability.timeoutMs / 1e3))}"${settingsDisabled5(managed.gatewayTimeoutMs)} /><span>秒</span></span>
          </label>
          <label class="settings-field-row">
            <span><strong>流空闲超时</strong>${managedFieldHtml5(managed.gatewayIdleTimeoutMs)}</span>
            <span class="settings-number-control"><input name="idleTimeoutSeconds" type="number" min="1" max="300" step="1" required value="${escapeAttribute2(Math.round(reliability.idleTimeoutMs / 1e3))}"${settingsDisabled5(managed.gatewayIdleTimeoutMs)} /><span>秒</span></span>
          </label>
        </div>
      </section>
      ${settingsFormActions5()}
    </form>
  `;
}
function settingsSectionHeading5(kicker, title, id) {
  return `<div class="settings-section-head"><div><div class="settings-section-kicker">${escapeHtml(kicker)}</div><h2 id="${escapeAttribute2(id)}">${escapeHtml(title)}</h2></div></div>`;
}
function settingsToggleHtml5(name, label, checked, detail = "") {
  return `<label class="settings-toggle-row"><span><strong>${escapeHtml(label)}</strong>${detail ? `<small>${escapeHtml(detail)}</small>` : ""}</span><input name="${escapeAttribute2(name)}" type="checkbox"${checked ? " checked" : ""}${settingsDisabled5(false)} /></label>`;
}
function managedFieldHtml5(managed) {
  return managed ? `<small>环境变量管理</small>` : "";
}
function settingsDisabled5(managed) {
  return state.settingsSaving || state.settingsRefreshing || state.running || managed ? " disabled" : "";
}
function settingsFormActions5() {
  return `
    <footer class="settings-form-actions">
      <label><span>保存到</span><select name="saveTarget"${settingsDisabled5(false)}><option value="project"${state.settingsSaveTarget === "project" ? " selected" : ""}>当前项目</option><option value="global"${state.settingsSaveTarget === "global" ? " selected" : ""}>全局默认</option></select></label>
      <button type="submit"${settingsDisabled5(false)}>${state.settingsSaving ? "保存中" : "保存"}</button>
    </footer>
  `;
}
function settingsFeedbackHtml5() {
  if (!state.settingsFeedback?.message) return "";
  return `<div class="settings-feedback ${escapeAttribute2(state.settingsFeedback.tone)}" role="status">${escapeHtml(state.settingsFeedback.message)}</div>`;
}
function settingsGatewayProfileHtml5(profile) {
  const confirmingDelete = state.deleteConfirmGatewayProfileId === profile.id;
  const deleting = state.deletingGatewayProfileId === profile.id;
  const inspected = settingsInspectedGatewayProfile5()?.id === profile.id;
  const count = Number.isFinite(profile.modelCount) ? profile.modelCount : profile.models?.length ?? 0;
  return `
    <div class="settings-profile-row${inspected ? " active" : ""}${confirmingDelete ? " confirming-delete" : ""}">
      <span class="settings-source-indicator" aria-hidden="true"></span>
      <div class="settings-row-main">
        <strong>${escapeHtml(profile.label || profile.gatewayUrl || profile.id)}</strong>
        <span>${escapeHtml(profile.gatewayUrl || profile.id)}</span>
        <small>${escapeHtml(profile.ready === false ? `${protocolDisplayName5(profile.gatewayProtocol)} · 配置不完整` : `${protocolDisplayName5(profile.gatewayProtocol)} · ${profile.apiKeyConfigured ? "Key 已配置" : "无 Key"} · ${count} 模型`)}</small>
      </div>
      <div class="settings-row-actions">
        <button type="button" data-action="inspect-profile" data-profile-id="${escapeAttribute2(profile.id)}" aria-pressed="${inspected}" ${state.settingsRefreshing ? "disabled" : ""}>${inspected ? "正在查看" : "查看模型"}</button>
        <button type="button" data-action="use-profile" data-profile-id="${escapeAttribute2(profile.id)}" ${profile.ready === false || state.settingsRefreshing || state.running || state.modelSwitching ? "disabled" : ""}>设为默认</button>
        <button type="button" data-action="edit-gateway-profile" data-profile-id="${escapeAttribute2(profile.id)}"${profile.editable === false ? ` title="${escapeAttribute2(gatewayProfileReadonlyLabel5(profile))}"` : ""} ${profile.editable === false || state.settingsRefreshing || state.running || Boolean(state.deletingGatewayProfileId) ? "disabled" : ""}>${profile.editable === false ? "只读" : "编辑"}</button>
        <button class="danger" type="button" data-action="delete-gateway-profile" data-profile-id="${escapeAttribute2(profile.id)}" ${profile.editable === false || state.settingsRefreshing || state.running || Boolean(state.deletingGatewayProfileId) ? "disabled" : ""}>${deleting ? "删除中" : confirmingDelete ? "确认删除" : "删除"}</button>
      </div>
      ${confirmingDelete ? `<div class="settings-delete-confirm">再次点击确认删除；删除当前来源后不会自动切换到其他来源。</div>` : ""}
    </div>
  `;
}
function gatewayProfileReadonlyLabel5(profile) {
  if (profile.ownerScope === "environment") return "该来源由环境变量管理";
  if (profile.ownerScope === "bundled") return "该来源由内置配置管理";
  return "该来源不能在这里直接编辑";
}
function providerModelKey5(providerId, modelId) {
  return JSON.stringify([String(providerId ?? ""), String(modelId ?? "")]);
}
function scopedDefaultModelLabel5(selection) {
  if (!selection?.provider || !selection?.model) return "未单独设置（使用上级默认）";
  const profile = gatewayProfileById4(selection.provider);
  const model = profile?.models?.find((candidate) => candidate.id === selection.model);
  const sourceLabel9 = profile?.label || selection.provider;
  const modelLabel = model?.label || selection.model;
  return modelLabel === selection.model ? `${sourceLabel9} · ${selection.model}` : `${sourceLabel9} · ${modelLabel} (${selection.model})`;
}
function settingsModelHtml5(model, profile, modelCount) {
  const source = modelSourceOf(model);
  const modelEditable = source?.editable !== false && profile?.editable !== false;
  const tags = modelCapabilityLabels5(model);
  const efforts = normalizeReasoningEfforts4(model.reasoningEfforts);
  const context = Number.isFinite(model.contextTokens) ? `${formatTokenCount5(model.contextTokens)} 上下文` : "";
  const modelKey = providerModelKey5(profile?.id || source?.profileId || source?.id, model.id);
  const scopedDefault = state.modelDefaultSelections[state.modelDefaultScope];
  const isScopedDefault = scopedDefault?.provider === (profile?.id || source?.profileId || source?.id) && scopedDefault?.model === model.id;
  const confirmingDelete = state.deleteConfirmModelKey === modelKey;
  const deleting = state.deletingModelKey === modelKey;
  const isLastModel = modelCount <= 1;
  const confirmCopy = isLastModel ? "再次点击确认删除；这是当前来源最后一个模型，会清空当前网关配置。" : "再次点击确认删除；删除当前模型后会切换到同一来源的下一个模型。";
  return `
    <div class="settings-model-row${model.current ? " active" : ""}${isScopedDefault ? " scope-default" : ""}${confirmingDelete ? " confirming-delete" : ""}">
      <div class="settings-row-main">
        <div class="settings-row-title">
          <strong>${escapeHtml(model.label || model.id)}</strong>
          ${model.current ? `<span>当前</span>` : ""}
          ${isScopedDefault ? `<span>此范围默认</span>` : ""}
        </div>
        <span>${escapeHtml(model.id)}</span>
        <div class="settings-model-tags">
          ${tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}
          ${context ? `<span>${escapeHtml(context)}</span>` : ""}
          ${efforts.length > 0 ? `<span>思考 ${escapeHtml(efforts.map((effort) => effort.label).join(" / "))}</span>` : ""}
        </div>
      </div>
      <div class="settings-row-actions">
        <button type="button" data-action="use-model" data-model-id="${escapeAttribute2(model.id)}" data-profile-id="${escapeAttribute2(profile?.id || "")}" ${isScopedDefault || state.settingsRefreshing || state.running || state.modelSwitching ? "disabled" : ""}>${isScopedDefault ? "已设为默认" : "设为默认"}</button>
        <button type="button" data-action="edit-model" data-model-id="${escapeAttribute2(model.id)}" data-profile-id="${escapeAttribute2(profile?.id || "")}" ${!modelEditable || state.settingsRefreshing || state.running || Boolean(state.deletingModelKey) ? "disabled" : ""}>${modelEditable ? "编辑" : "只读"}</button>
        <button class="danger" type="button" data-action="delete-model" data-model-id="${escapeAttribute2(model.id)}" data-profile-id="${escapeAttribute2(profile?.id || "")}" data-save-target="${escapeAttribute2(source?.saveTarget || profile?.saveTarget || "")}" ${!modelEditable || state.settingsRefreshing || state.running || Boolean(state.deletingModelKey) ? "disabled" : ""}>${deleting ? "删除中" : confirmingDelete ? "确认删除" : "删除"}</button>
      </div>
      ${confirmingDelete ? `<div class="settings-delete-confirm">${escapeHtml(confirmCopy)}</div>` : ""}
    </div>
  `;
}
function handleSettingsRailClick(event) {
  const button = eventTargetOf(event).closest("button[data-settings-section]");
  if (!button || state.settingsSaving) return;
  state.settingsSection = button.dataset.settingsSection || "models";
  state.settingsFeedback = null;
  renderSettingsView4();
}
function initializeSettingsFormTracking5(form) {
  for (const control of form.querySelectorAll("[name]")) {
    if (control.name === "saveTarget") continue;
    control.dataset.initialValue = settingsControlValue5(control);
  }
  form.dataset.changedFields = "[]";
}
function handleSettingsFormChange(event) {
  const form = eventTargetOf(event).closest?.("form[data-settings-form]");
  if (!form || state.settingsSaving) return;
  form.dataset.changedFields = JSON.stringify(changedSettingsFields5(form));
}
function settingsControlValue5(control) {
  if (control instanceof HTMLInputElement && control.type === "checkbox") {
    return String(control.checked);
  }
  return "value" in control ? String(control.value ?? "") : "";
}
function changedSettingsFields5(form) {
  const section = String(form.dataset.settingsForm ?? "");
  const changed = [];
  for (const control of form.querySelectorAll("[name]")) {
    if (control.name === "saveTarget" || control.disabled && control.dataset.saveDisabledBefore === void 0) continue;
    if (settingsControlValue5(control) === String(control.dataset.initialValue ?? "")) continue;
    const field = canonicalSettingsField5(section, control.name);
    if (field && !changed.includes(field)) changed.push(field);
  }
  return changed;
}
function canonicalSettingsField5(section, name) {
  if (section === "reliability" && name === "timeoutSeconds") return "timeoutMs";
  if (section === "reliability" && name === "idleTimeoutSeconds") return "idleTimeoutMs";
  return name;
}
function setSettingsFormSaving5(form, saving) {
  setFormControlsSaving5(form, saving, "保存中");
  if (els.settingsBack) els.settingsBack.disabled = saving;
}
function renderSettingsFeedbackInPlace5() {
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
async function saveSettingsConfig(event) {
  const form = eventTargetOf(event).closest("form[data-settings-form]");
  if (!(form instanceof HTMLFormElement)) return;
  event.preventDefault();
  if (state.settingsSaving || state.running) return;
  const section = form.dataset.settingsForm;
  const field = (name) => (
    /** @type {HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null} */
    form.elements.namedItem(name)
  );
  const checked = (name) => {
    const control = field(name);
    return Boolean(control instanceof HTMLInputElement && control.checked);
  };
  const value = (name) => String(field(name)?.value ?? "");
  const settings = section === "transcript" ? {
    enabled: checked("enabled"),
    retentionDays: value("retentionDays") === "forever" ? null : Number(value("retentionDays")),
    encryption: value("encryption")
  } : section === "network" ? { mode: value("mode"), allowedHosts: value("allowedHosts") } : section === "agents" ? {
    maxParallelReadonlyAgentRuns: Number(value("maxParallelReadonlyAgentRuns")),
    backgroundWakeupEnabled: checked("backgroundWakeupEnabled"),
    backgroundByDefault: checked("backgroundByDefault"),
    reviewGateEnabled: checked("reviewGateEnabled"),
    syncModelTiersOnSwitch: checked("syncModelTiersOnSwitch"),
    goalMaxAutoContinues: Number(value("goalMaxAutoContinues"))
  } : {
    maxRetries: Number(value("maxRetries")),
    timeoutMs: Number(value("timeoutSeconds")) * 1e3,
    idleTimeoutMs: Number(value("idleTimeoutSeconds")) * 1e3
  };
  const changedFields = changedSettingsFields5(form);
  state.settingsSaveTarget = value("saveTarget") === "global" ? "global" : "project";
  state.settingsSaving = true;
  state.settingsFeedback = null;
  renderSettingsFeedbackInPlace5();
  setSettingsFormSaving5(form, true);
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
    else renderSettingsView4();
    announceStatus("设置已保存");
  } catch (error) {
    state.settingsFeedback = { tone: "error", message: error instanceof Error ? error.message : "设置保存失败" };
    state.settingsSaving = false;
    setSettingsFormSaving5(form, false);
    renderSettingsFeedbackInPlace5();
    announceStatus(state.settingsFeedback.message);
  }
}
async function handleSettingsClick(event) {
  const action = eventTargetOf(event).closest("[data-action]");
  if (!action) return;
  if (action.dataset.action === "select-default-scope") {
    state.modelDefaultScope = configScope5(action.dataset.scope, "project");
    state.settingsFeedback = null;
    renderSettingsView4();
  } else if (action.dataset.action === "inspect-profile") {
    state.settingsProviderId = action.dataset.profileId || "";
    state.deleteConfirmModelKey = "";
    state.settingsFeedback = null;
    renderSettingsView4();
  } else if (action.dataset.action === "add-source") {
    showModelConfigPanel4("", "", "add-source");
  } else if (action.dataset.action === "add-model") {
    showModelConfigPanel4("", action.dataset.profileId || settingsInspectedGatewayProfile5()?.id || "", "add-model");
  } else if (action.dataset.action === "edit-model") {
    showModelConfigPanel4(action.dataset.modelId, action.dataset.profileId, "edit-model");
  } else if (action.dataset.action === "edit-gateway-profile") {
    showModelConfigPanel4("", action.dataset.profileId, "edit-profile");
  } else if (action.dataset.action === "use-model") {
    await saveDefaultModelSelection5(
      action.dataset.modelId,
      action.dataset.profileId || currentGatewayProfile5()?.id || "",
      state.modelDefaultScope
    );
  } else if (action.dataset.action === "use-profile") {
    const profile = (state.gatewayProfiles ?? []).find((item) => item.id === action.dataset.profileId);
    await saveDefaultModelSelection5(
      profile?.modelAlias || profile?.models?.[0]?.id || "",
      profile?.id || "",
      state.modelDefaultScope
    );
  } else if (action.dataset.action === "delete-model") {
    await deleteModel5(action.dataset.modelId, {
      profileId: action.dataset.profileId,
      saveTarget: action.dataset.saveTarget
    });
  } else if (action.dataset.action === "delete-gateway-profile") {
    await deleteGatewayProfile5(action.dataset.profileId);
  }
}
function protocolDisplayName5(protocol) {
  if (protocol === "openai-responses") return "OpenAI Responses";
  if (protocol === "anthropic-messages") return "Anthropic Messages";
  return "OpenAI Chat Completions";
}
function agentModelPickerHtml5(name, label, value) {
  const modelId = String(value ?? "").trim();
  const inputId = `agent-model-${name}`;
  const selectId = `${inputId}-select`;
  return `
    <div class="agent-model-picker" data-agent-model-picker data-saved-model-id="${escapeAttribute2(modelId)}">
      <label for="${escapeAttribute2(selectId)}">${escapeHtml(label)}</label>
      <select id="${escapeAttribute2(selectId)}" data-agent-model-select="${escapeAttribute2(name)}" aria-controls="${escapeAttribute2(inputId)}">
        <option value=""${modelId ? "" : " selected"}>未指定</option>
        ${modelId ? `<option value="${escapeAttribute2(modelId)}" selected>${escapeHtml(modelId)}（已保存 · 等待目录核对）</option>` : ""}
        <option value="${MANUAL_AGENT_MODEL_VALUE}">手工输入 ID...</option>
      </select>
      <input class="agent-model-manual-input hidden" id="${escapeAttribute2(inputId)}" name="${escapeAttribute2(name)}" aria-label="${escapeAttribute2(`${label} 手工模型 ID`)}" spellcheck="false" value="${escapeAttribute2(modelId)}" placeholder="输入精确模型 ID" />
      <small class="agent-model-picker-status">${modelId ? "已保存，等待目录核对" : "未指定"}</small>
    </div>
  `;
}
function renderModelConfigPanel4() {
  if (!els.modelConfigPanel) {
    return;
  }
  els.modelConfigPanel.classList.toggle("hidden", !state.modelConfigOpen);
  if (!state.modelConfigOpen) {
    els.modelConfigPanel.replaceChildren();
    return;
  }
  const editingProfile = gatewayProfileById4(state.editingGatewayProfileId);
  const editing = state.editingModelId ? editingProfile?.models?.find((model) => model.id === state.editingModelId) ?? currentModelInfo4(state.editingModelId) : null;
  const addingSource = state.modelConfigIntent === "add-source";
  const addingModel = state.modelConfigIntent === "add-model";
  const current = editing ?? { id: "" };
  const gateway = editingProfile ? {
    ...state.gatewayConfig ?? {
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
    },
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
  const sourceNote = gatewaySourceNote5(gateway);
  const keySource = editingProfile ? "该网关档案" : sourceLabel5(gateway.sources?.apiKey);
  const gatewayDefaultNote = environmentGatewayDefaultNote5(gateway);
  const modelSaveTarget = modelSourceOf(editing)?.saveTarget;
  const saveTarget = modelSaveTarget ? modelSaveTarget : editingProfile ? editingProfile.saveTarget === "global" ? "global" : "project" : gateway.sources?.gatewayUrl?.type === "project" ? "project" : "global";
  const lockedSaveTarget = modelSaveTarget === "project" || modelSaveTarget === "global" ? modelSaveTarget : editingProfile?.saveTarget === "project" || editingProfile?.saveTarget === "global" ? editingProfile.saveTarget : "";
  const profileAgentTiers = addingSource ? {} : editingProfile?.agentModelTiers ?? state.agentModelTiers ?? {};
  const currentAgentTiers = {
    cheap: current.agentModelTiers?.cheap ?? profileAgentTiers.cheap ?? "",
    default: current.agentModelTiers?.default ?? profileAgentTiers.default ?? "",
    strong: current.agentModelTiers?.strong ?? profileAgentTiers.strong ?? ""
  };
  const visionAgentModel = editingProfile ? editingProfile.visionAgent?.model ?? "" : addingSource ? "" : state.visionAgent?.model ?? firstVisionModelId5() ?? "";
  const currentEfforts = normalizeReasoningEfforts4(current.reasoningEfforts);
  const selectedEffortIds = new Set(currentEfforts.map((effort) => effort.id));
  const effortChoices = reasoningEffortCatalog5(currentEfforts);
  const defaultReasoningEffort = configuredReasoningEffort4(current.defaultReasoningEffort, currentEfforts);
  const panelKicker = addingSource ? "模型来源" : addingModel ? editingProfile?.label || "当前来源" : "模型配置";
  const panelTitle = addingSource ? "添加模型来源" : addingModel ? "添加模型" : state.modelConfigIntent === "edit-profile" ? "编辑模型来源" : "编辑模型";
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
        <label>
          <span>网关 URL</span>
          <input name="gatewayUrl" type="url" required spellcheck="false" value="${escapeAttribute2(gateway.gatewayUrl || "")}" placeholder="${escapeAttribute2(gatewayUrlPlaceholder5(gatewayProtocol))}" />
          <small class="gateway-url-hint">${escapeHtml(gatewayUrlHint5(gatewayProtocol))}</small>
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
          <input name="gatewayApiKey" type="password" autocomplete="new-password" spellcheck="false" data-key-configured="${gateway.apiKeyConfigured ? "true" : "false"}" data-keep-placeholder="${escapeAttribute2(gateway.apiKeyConfigured ? `已配置，来自${keySource}，留空则保留` : "可选")}" placeholder="${escapeAttribute2(gateway.apiKeyConfigured ? `已配置，来自${keySource}，留空则保留` : "可选")}" />
        </label>
        <label>
          <span>健康检查 URL</span>
          <input name="gatewayHealthUrl" type="url" spellcheck="false" value="${escapeAttribute2(gateway.gatewayHealthUrl || "")}" placeholder="可选" />
        </label>
        <div class="gateway-probe-row">
          <button type="button" data-action="probe-gateway" ${state.gatewayProbeRunning ? "disabled" : ""}>${state.gatewayProbeRunning ? "连接中" : "测试连接 / 发现模型"}</button>
          <div class="gateway-probe-result" id="gateway-probe-result" aria-live="polite"></div>
        </div>
        <label>
          <span>模型 ID</span>
          <input name="modelId" required spellcheck="false" value="${escapeAttribute2(current.id || "")}" placeholder="example-coding-model" />
        </label>
        <label>
          <span>显示名称</span>
          <input name="label" spellcheck="false" value="${escapeAttribute2(current.label || "")}" placeholder="Example Coding Model" />
        </label>
        <label>
          <span>上下文窗口</span>
          <input name="contextTokens" inputmode="numeric" pattern="[0-9]*" value="${escapeAttribute2(current.contextTokens || "")}" placeholder="例如 400000" />
        </label>
      </div>
      <fieldset class="agent-model-config">
        <legend>子智能体模型</legend>
        <span class="agent-model-catalog-status" id="agent-model-catalog-status" aria-live="polite">目录未读取</span>
        <div class="agent-model-picker-grid">
          ${agentModelPickerHtml5("agentCheapModel", "cheap", currentAgentTiers.cheap)}
          ${agentModelPickerHtml5("agentDefaultModel", "default", currentAgentTiers.default)}
          ${agentModelPickerHtml5("agentStrongModel", "strong", currentAgentTiers.strong)}
          ${agentModelPickerHtml5("visionAgentModel", "vision", visionAgentModel)}
        </div>
      </fieldset>
      <fieldset class="model-reasoning-config" data-reasoning-mode="${state.modelConfigReasoningLocked ? "manual" : "auto"}" data-reasoning-source="${escapeAttribute2(state.modelConfigReasoningSource)}">
        <legend>思考强度</legend>
        <div class="model-reasoning-discovery">
          <span class="model-reasoning-status" id="reasoning-capability-status" role="status" aria-live="polite"></span>
          <div class="model-reasoning-discovery-actions">
            <button class="hidden" type="button" data-action="apply-reasoning-capabilities">使用发现值</button>
            <button type="button" data-action="detect-reasoning-capabilities" title="发送最小模型请求检测可用档位，可能产生少量用量"${!current.id || state.modelCapabilityProbeRunning ? " disabled" : ""}>${state.modelCapabilityProbeRunning ? "检测中" : "检测档位"}</button>
          </div>
        </div>
        <div class="model-reasoning-options">
          ${effortChoices.map((effort) => `
            <label>
              <input name="reasoningEfforts" type="checkbox" value="${escapeAttribute2(effort.id)}" data-effort-label="${escapeAttribute2(effort.label)}"${selectedEffortIds.has(effort.id) ? " checked" : ""} />
              <span>${escapeHtml(effort.label)}</span>
            </label>
          `).join("")}
        </div>
        <label class="model-reasoning-default">
          <span>模型默认强度</span>
          <select name="defaultReasoningEffort" ${selectedEffortIds.size === 0 ? "disabled" : ""}>
            <option value="">未指定</option>
            ${effortChoices.filter((effort) => selectedEffortIds.has(effort.id)).map((effort) => `<option value="${escapeAttribute2(effort.id)}"${defaultReasoningEffort === effort.id ? " selected" : ""}>${escapeHtml(effort.label)}</option>`).join("")}
          </select>
        </label>
      </fieldset>
      <div class="model-config-toggles">
        <label><input name="text" type="checkbox" checked disabled /> 文本</label>
        <label><input name="vision" type="checkbox"${Array.isArray(current.modalities) && current.modalities.includes("image") ? " checked" : ""} /> 视觉</label>
        <label><input name="thinking" type="checkbox"${current.thinking ? " checked" : ""} /> thinking</label>
        <label><input name="clearGatewayApiKey" type="checkbox"${gateway.apiKeyConfigured ? "" : " disabled"} /> 清除已保存 Key</label>
        <label><input name="switchToModel" type="checkbox"${editing && !current.default ? "" : " checked"} /> 保存为该范围默认模型</label>
        <label><input name="applyAgentDefaults" type="checkbox" /> 保存后同步子智能体</label>
      </div>
      <div class="model-config-note">
        <div>${escapeHtml(sourceNote)}</div>
        ${gatewayDefaultNote ? `<div>${escapeHtml(gatewayDefaultNote)}</div>` : ""}
        <div>保存为当前项目默认会覆盖本文件夹；保存为全局默认会作为新项目兜底。Key 不会在这里回显。</div>
      </div>
      <div class="model-config-feedback hidden" role="alert" aria-live="assertive"></div>
      <div class="model-config-actions">
        <button type="button" data-action="close-model-config">取消</button>
        <button type="submit" ${state.modelConfigSaving ? "disabled" : ""}>${state.modelConfigSaving ? "保存中" : "保存"}</button>
      </div>
    </form>
  `;
  initializeAgentModelPickerSnapshot5(els.modelConfigPanel.querySelector("#model-config-form"));
  renderGatewayProbeResult5();
  renderReasoningCapabilityStatus5();
}
async function handleModelConfigPanelClick(event) {
  const action = eventTargetOf(event).closest("button[data-action]");
  if (action?.dataset.action === "close-model-config") {
    hideModelConfigPanel2();
  } else if (action?.dataset.action === "probe-gateway") {
    await probeGateway5(action.closest("form"));
  } else if (action?.dataset.action === "select-probed-model") {
    applyProbedModel5(action);
  } else if (action?.dataset.action === "use-suggested-gateway-url") {
    applySuggestedGatewayUrl5(action);
  } else if (action?.dataset.action === "detect-reasoning-capabilities") {
    await probeModelCapabilities5(action.closest("form"));
  } else if (action?.dataset.action === "apply-reasoning-capabilities") {
    applyPendingReasoningCapabilities5(action.closest("form"));
  }
}
function handleModelConfigInput(event) {
  const target = event.target;
  const form = target?.closest?.("form");
  if (!target || !form) return;
  if (target.matches("input[name='gatewayUrl']")) {
    markModelConfigEndpointChanged5(form);
    return;
  }
  if (target.matches("input[name='gatewayApiKey']")) {
    markModelConfigCredentialChanged5(form);
    return;
  }
  if (target.matches("input[name='modelId']")) {
    handleModelConfigModelIdChanged5(form);
    return;
  }
  if (target.matches(".agent-model-manual-input")) {
    const picker = target.closest(".agent-model-picker");
    if (picker) {
      picker.dataset.manualActive = "true";
      picker.dataset.modelSnapshot = modelConfigAgentModelsSnapshot5(form);
      updateAgentModelPickerManualStatus5(picker, target.value);
    }
  }
}
function handleModelConfigChange(event) {
  if (eventTargetOf(event).matches("select[data-agent-model-select]")) {
    handleAgentModelSelection5(event.target);
  } else if (eventTargetOf(event).matches(".agent-model-manual-input")) {
    renderAgentModelPickers5(eventTargetOf(event).closest("form"));
  } else if (eventTargetOf(event).matches("input[name='reasoningEfforts']")) {
    markReasoningCapabilityManual5();
    syncReasoningDefaultOptions5(eventTargetOf(event).closest("form"));
    renderReasoningCapabilityStatus5();
  } else if (eventTargetOf(event).matches("select[name='defaultReasoningEffort'], input[name='thinking']")) {
    markReasoningCapabilityManual5();
    renderReasoningCapabilityStatus5();
  } else if (eventTargetOf(event).matches("select[name='gatewayProtocol']")) {
    markModelConfigEndpointChanged5(eventTargetOf(event).closest("form"));
    syncGatewayUrlHint5(eventTargetOf(event).closest("form"), eventTargetOf(event).value);
  } else if (eventTargetOf(event).matches("input[name='saveTarget']")) {
    state.modelCapabilityDiscoveryToken = "";
  } else if (eventTargetOf(event).matches("input[name='gatewayApiKey']") && eventTargetOf(event).value.trim()) {
    const keyInput = eventTargetOf(event);
    const clear = (keyInput instanceof HTMLInputElement ? keyInput.form : keyInput.closest("form"))?.querySelector("input[name='clearGatewayApiKey']");
    if (clear) clear.checked = false;
  } else if (eventTargetOf(event).matches("input[name='clearGatewayApiKey']")) {
    markModelConfigCredentialChanged5(eventTargetOf(event).closest("form"));
    const clearInput = eventTargetOf(event);
    const key = (clearInput instanceof HTMLInputElement ? clearInput.form : clearInput.closest("form"))?.querySelector("input[name='gatewayApiKey']");
    if (key) {
      if (eventTargetOf(event).checked) key.value = "";
      key.disabled = eventTargetOf(event).checked;
    }
  }
}
function markModelConfigCredentialChanged5(form) {
  state.modelConfigCredentialRevision += 1;
  cancelScopedRequest2("gateway-probe");
  cancelScopedRequest2("model-capabilities-probe");
  state.gatewayProbeRunning = false;
  state.modelCapabilityProbeRunning = false;
  state.modelCapabilityProbeError = "";
  state.modelCapabilityDiscoveryToken = "";
  state.gatewayProbeResult = null;
  state.gatewayProbeError = "";
  state.modelConfigReasoningCandidate = null;
  renderGatewayProbeResult5({ preserveAgentModels: true });
  renderReasoningCapabilityStatus5();
}

// src/dashboard/public/app-ui6.ts
function markModelConfigEndpointChanged5(form, options = {}) {
  state.modelConfigEndpointRevision += 1;
  syncAgentModelPickersForEndpoint6(form, {
    retainedCatalogModelIds: options.retainedAgentModelIds
  });
  cancelScopedRequest2("gateway-probe");
  cancelScopedRequest2("model-capabilities-probe");
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
      clearReasoningCapabilityControls6(form);
    }
  }
  renderGatewayProbeResult5();
  renderReasoningCapabilityStatus5();
}
function handleModelConfigModelIdChanged5(form) {
  cancelScopedRequest2("model-capabilities-probe");
  state.modelCapabilityProbeRunning = false;
  state.modelCapabilityProbeError = "";
  state.modelCapabilityDiscoveryToken = "";
  state.modelConfigReasoningCandidate = null;
  if (!state.modelConfigReasoningLocked) {
    state.modelConfigReasoningSource = "unknown";
    state.modelConfigReasoningDiscovery = null;
    clearReasoningCapabilityControls6(form);
  }
  const modelInput = (
    /** @type {HTMLInputElement | null} */
    form?.querySelector("input[name='modelId']") ?? null
  );
  const modelId = String(modelInput?.value ?? "").trim();
  const discoveredModel = state.gatewayProbeResult?.models?.find((model) => model.id === modelId) ?? null;
  if (discoveredModel && applyGatewayDiscoveredModel6(form, discoveredModel)) return;
  renderReasoningCapabilityStatus5();
}
function markReasoningCapabilityManual5() {
  state.modelConfigReasoningEditRevision += 1;
  state.modelConfigReasoningLocked = true;
  state.modelConfigReasoningSource = "manual";
}
function clearReasoningCapabilityControls6(form) {
  if (!form) return;
  for (
    const input of
    /** @type {NodeListOf<HTMLInputElement>} */
    form.querySelectorAll("input[name='reasoningEfforts']")
  ) {
    input.checked = false;
  }
  syncReasoningDefaultOptions5(form);
}
function syncGatewayUrlHint5(form, protocol) {
  const input = form?.querySelector("input[name='gatewayUrl']");
  const hint = form?.querySelector(".gateway-url-hint");
  if (input) input.placeholder = gatewayUrlPlaceholder5(protocol);
  if (hint) hint.textContent = gatewayUrlHint5(protocol);
}
function gatewayUrlPlaceholder5(protocol) {
  if (protocol === "openai-responses") return "https://api.x.ai/v1/responses";
  if (protocol === "anthropic-messages") return "https://api.anthropic.com/v1/messages";
  return "https://example.com/v1/chat/completions";
}
function gatewayUrlHint5(protocol) {
  if (protocol === "openai-responses") return "填写完整请求地址，例如 /v1/responses";
  if (protocol === "anthropic-messages") return "填写完整请求地址，例如 /v1/messages";
  return "填写完整请求地址，例如 /v1/chat/completions";
}
function syncReasoningDefaultOptions5(form) {
  const select = form?.querySelector("select[name='defaultReasoningEffort']");
  if (!form || !select) return;
  const previous = select.value;
  const efforts = Array.from(form.querySelectorAll("input[name='reasoningEfforts']:checked")).map((input) => ({
    id: input.value,
    label: input.dataset.effortLabel || input.value
  }));
  select.innerHTML = `<option value="">未指定</option>${efforts.map((effort) => `<option value="${escapeAttribute2(effort.id)}">${escapeHtml(effort.label)}</option>`).join("")}`;
  select.disabled = efforts.length === 0;
  select.value = efforts.some((effort) => effort.id === previous) ? previous : "";
}
async function probeGateway5(form) {
  if (!(form instanceof HTMLFormElement) || state.gatewayProbeRunning) return;
  const data = new FormData(form);
  const profile = gatewayProfileById4(state.editingGatewayProfileId) ?? currentGatewayProfile5();
  const credentialAction = gatewayCredentialAction6(data, profile ?? state.gatewayConfig);
  const dialogGeneration = state.modelConfigDialogGeneration;
  const endpointRevision = state.modelConfigEndpointRevision;
  const credentialRevision = state.modelConfigCredentialRevision;
  const gatewayUrl = String(data.get("gatewayUrl") ?? "").trim();
  const gatewayProtocol = String(data.get("gatewayProtocol") ?? "").trim();
  const saveTarget = configScope5(data.get("saveTarget"), "global") || "global";
  const request = beginScopedRequest("gateway-probe", `${dialogGeneration}:${endpointRevision}:${credentialRevision}`);
  state.gatewayProbeRunning = true;
  state.gatewayProbeResult = null;
  state.gatewayProbeError = "";
  state.modelCapabilityDiscoveryToken = "";
  renderGatewayProbeResult5();
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
    if (!isCurrentModelConfigRequest6(request, form, dialogGeneration, endpointRevision, credentialRevision)) return;
    if (!result.ok) throw new Error(result.error ?? "连接测试失败");
    state.gatewayProbeResult = {
      message: String(result.message ?? result.probe?.message ?? "连接成功"),
      models: normalizeGatewayProbeModels6(result.models ?? result.probe?.models),
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
    if (discoveredModel) applyGatewayDiscoveredModel6(form, discoveredModel);
  } catch (error) {
    if (!isAbortError(error) && isCurrentModelConfigRequest6(request, form, dialogGeneration, endpointRevision, credentialRevision)) {
      state.gatewayProbeError = error instanceof Error ? error.message : "连接测试失败";
    }
  } finally {
    const current = isCurrentModelConfigRequest6(request, form, dialogGeneration, endpointRevision, credentialRevision);
    if (current) state.gatewayProbeRunning = false;
    finishScopedRequest(request);
    if (current) renderGatewayProbeResult5();
  }
}
function isCurrentModelConfigRequest6(request, form, dialogGeneration, endpointRevision, credentialRevision) {
  return isCurrentScopedRequest(request) && state.modelConfigOpen && state.modelConfigDialogGeneration === dialogGeneration && state.modelConfigEndpointRevision === endpointRevision && state.modelConfigCredentialRevision === credentialRevision && form.isConnected && form === els.modelConfigPanel?.querySelector("#model-config-form");
}
function currentGatewayProbeResult6(form) {
  const result = state.gatewayProbeResult;
  if (!(form instanceof HTMLFormElement) || !result) return null;
  const gatewayUrlInput = (
    /** @type {HTMLInputElement | null} */
    form.querySelector("input[name='gatewayUrl']")
  );
  const gatewayProtocolSelect = (
    /** @type {HTMLSelectElement | null} */
    form.querySelector("select[name='gatewayProtocol']")
  );
  const gatewayUrl = String(gatewayUrlInput?.value ?? "").trim();
  const gatewayProtocol = String(gatewayProtocolSelect?.value ?? "").trim();
  const saveTarget = configScope5(new FormData(form).get("saveTarget"), "global") || "global";
  return result.dialogGeneration === state.modelConfigDialogGeneration && result.endpointRevision === state.modelConfigEndpointRevision && result.credentialRevision === state.modelConfigCredentialRevision && result.gatewayUrl === gatewayUrl && result.gatewayProtocol === gatewayProtocol && result.saveTarget === saveTarget ? result : null;
}
function currentGatewayCatalogModels6(form) {
  return currentGatewayProbeResult6(form)?.models ?? [];
}
function modelConfigGatewayProfile6() {
  return state.editingGatewayProfileId ? gatewayProfileById4(state.editingGatewayProfileId) : state.modelConfigIntent === "add-source" ? null : currentGatewayProfile5();
}
function modelConfigEndpointChanged6(form) {
  if (!form) return false;
  const previous = modelConfigGatewayProfile6() ?? (state.modelConfigIntent === "add-source" ? null : state.gatewayConfig);
  const previousUrl = String(previous?.gatewayUrl ?? previous?.transport?.baseURL ?? "").trim();
  if (!previousUrl) return false;
  const previousProtocol = String(
    previous?.gatewayProtocol ?? previous?.transport?.protocol ?? "openai-chat"
  ).trim();
  const gatewayUrl = String(form.querySelector("input[name='gatewayUrl']")?.value ?? "").trim();
  const gatewayProtocol = String(form.querySelector("select[name='gatewayProtocol']")?.value ?? "openai-chat").trim();
  return gatewayUrl !== previousUrl || gatewayProtocol !== previousProtocol;
}
function modelConfigAgentModelsSnapshot5(form) {
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
function initializeAgentModelPickerSnapshot5(form) {
  if (!form || form.dataset.agentModelsSnapshot) return;
  const snapshot = modelConfigAgentModelsSnapshot5(form);
  form.dataset.agentModelsSnapshot = snapshot;
  form.dataset.agentModelsEndpointChanged = String(modelConfigEndpointChanged6(form));
  for (const pickerElement of form.querySelectorAll("[data-agent-model-picker]")) {
    const picker = (
      /** @type {HTMLElement} */
      pickerElement
    );
    picker.dataset.modelSnapshot = snapshot;
  }
}
function syncAgentModelPickersForEndpoint6(form, options = {}) {
  if (!form) return;
  const changed = modelConfigEndpointChanged6(form);
  const keyInput = (
    /** @type {HTMLInputElement | null} */
    form.querySelector("input[name='gatewayApiKey']")
  );
  if (keyInput) {
    keyInput.placeholder = changed && keyInput.dataset.keyConfigured === "true" ? "地址或协议已变化，请重新输入 Key" : keyInput.dataset.keepPlaceholder || "可选";
  }
  const snapshot = modelConfigAgentModelsSnapshot5(form);
  const previousSnapshot = String(form.dataset.agentModelsSnapshot ?? "");
  if (!previousSnapshot) {
    initializeAgentModelPickerSnapshot5(form);
    return;
  }
  if (snapshot === previousSnapshot) return;
  const retainedCatalogModelIds = new Set(options.retainedCatalogModelIds ?? []);
  form.dataset.agentModelsEndpointChanged = String(changed);
  form.dataset.agentModelsSnapshot = snapshot;
  for (const pickerElement of form.querySelectorAll("[data-agent-model-picker]")) {
    const picker = (
      /** @type {HTMLElement} */
      pickerElement
    );
    const input = (
      /** @type {HTMLInputElement | null} */
      picker.querySelector(".agent-model-manual-input")
    );
    if (!input) continue;
    const currentValue = input.value.trim();
    const belongsToPreviousSnapshot = picker.dataset.modelSnapshot === previousSnapshot;
    const retainCatalogValue = changed && belongsToPreviousSnapshot && retainedCatalogModelIds.has(currentValue);
    input.value = changed ? retainCatalogValue ? currentValue : "" : String(picker.dataset.savedModelId ?? "").trim();
    picker.dataset.manualActive = "false";
    picker.dataset.modelSnapshot = snapshot;
  }
  renderAgentModelPickers5(form);
}
function uniqueAgentModelCandidates6(models) {
  const seen = /* @__PURE__ */ new Set();
  return (Array.isArray(models) ? models : []).map((model) => {
    const record = isPlainObject(model) ? model : {};
    return {
      id: String(record.id ?? "").trim(),
      label: String(record.label ?? record.id ?? "").trim()
    };
  }).filter((model) => model.id && !seen.has(model.id) && seen.add(model.id));
}
function appendAgentModelOptions6(select, label, models, suffix = "") {
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
function renderAgentModelPickers5(form) {
  if (!form) return;
  initializeAgentModelPickerSnapshot5(form);
  const snapshot = modelConfigAgentModelsSnapshot5(form);
  const catalogModels = uniqueAgentModelCandidates6(currentGatewayCatalogModels6(form));
  const catalogIds = new Set(catalogModels.map((model) => model.id));
  const registeredModels = form.dataset.agentModelsEndpointChanged === "true" ? [] : uniqueAgentModelCandidates6(modelConfigGatewayProfile6()?.models ?? []);
  const registeredOnly = registeredModels.filter((model) => !catalogIds.has(model.id));
  const registeredIds = new Set(registeredModels.map((model) => model.id));
  const catalogAvailable = catalogModels.length > 0;
  for (const pickerElement of form.querySelectorAll("[data-agent-model-picker]")) {
    const picker = (
      /** @type {HTMLElement} */
      pickerElement
    );
    const select = (
      /** @type {HTMLSelectElement | null} */
      picker.querySelector("select[data-agent-model-select]")
    );
    const input = (
      /** @type {HTMLInputElement | null} */
      picker.querySelector(".agent-model-manual-input")
    );
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
    appendAgentModelOptions6(select, "当前来源已发现", catalogModels);
    appendAgentModelOptions6(
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
      saved.textContent = catalogAvailable ? `${currentValue}（已保存 · 目录未发现）` : `${currentValue}（已保存 · 等待目录核对）`;
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
      updateAgentModelPickerManualStatus5(picker, currentValue);
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
    summary.textContent = state.gatewayProbeRunning ? "正在读取目录" : state.gatewayProbeError ? "目录读取失败" : catalogAvailable ? `已发现 ${catalogModels.length} 个` : "目录未读取";
  }
}
function updateAgentModelPickerManualStatus5(picker, value) {
  const status = picker.querySelector(".agent-model-picker-status");
  picker.dataset.modelState = "manual";
  if (status) status.textContent = String(value ?? "").trim() ? "手工模型 ID" : "等待输入模型 ID";
}
function handleAgentModelSelection5(select) {
  if (!(select instanceof HTMLSelectElement)) return;
  const picker = (
    /** @type {HTMLElement | null} */
    select.closest("[data-agent-model-picker]")
  );
  const form = (
    /** @type {HTMLFormElement | null} */
    select.closest("form")
  );
  const input = (
    /** @type {HTMLInputElement | null} */
    picker?.querySelector(".agent-model-manual-input") ?? null
  );
  if (!picker || !form || !input) return;
  picker.dataset.modelSnapshot = modelConfigAgentModelsSnapshot5(form);
  if (select.value === MANUAL_AGENT_MODEL_VALUE) {
    picker.dataset.manualActive = "true";
    input.classList.remove("hidden");
    updateAgentModelPickerManualStatus5(picker, input.value);
    requestAnimationFrame(() => input.focus({ preventScroll: true }));
    return;
  }
  picker.dataset.manualActive = "false";
  input.value = select.value;
  renderAgentModelPickers5(form);
}
function renderGatewayProbeResult5(options = {}) {
  const target = els.modelConfigPanel?.querySelector("#gateway-probe-result");
  if (!target) return;
  const form = target.closest("form");
  if (options.preserveAgentModels !== true) renderAgentModelPickers5(form);
  const button = (
    /** @type {HTMLButtonElement | null} */
    els.modelConfigPanel?.querySelector("button[data-action='probe-gateway']") ?? null
  );
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
  const result = currentGatewayProbeResult6(form);
  if (!result) {
    target.className = "gateway-probe-result";
    target.replaceChildren();
    return;
  }
  target.className = "gateway-probe-result success";
  const gatewayUrlInput = (
    /** @type {HTMLInputElement | null} */
    els.modelConfigPanel?.querySelector("input[name='gatewayUrl']") ?? null
  );
  const currentGatewayUrl = gatewayUrlInput?.value.trim() || "";
  const suggestedGatewayUrl = String(result.suggestedGatewayUrl ?? "").trim();
  target.innerHTML = `
    <strong>${escapeHtml(result.message || "连接成功")}</strong>
    ${result.modelsUrl ? `<span>模型列表 ${escapeHtml(result.modelsUrl)}</span>` : ""}
    ${suggestedGatewayUrl && suggestedGatewayUrl !== currentGatewayUrl ? `<button class="gateway-probe-suggestion" type="button" data-action="use-suggested-gateway-url" data-gateway-url="${escapeAttribute2(suggestedGatewayUrl)}">使用建议地址</button>` : ""}
    ${(result.models ?? []).length > 0 ? `
      <div class="gateway-probe-models" aria-label="发现的模型">
        ${(result.models ?? []).map((model) => `<button type="button" data-action="select-probed-model" data-model-id="${escapeAttribute2(model.id)}" data-model-label="${escapeAttribute2(model.label)}">${escapeHtml(model.label || model.id)}</button>`).join("")}
      </div>
    ` : `<span>未返回模型列表</span>`}
  `;
}
function applyProbedModel5(button) {
  const form = button.closest("form");
  const modelInput = form?.querySelector("input[name='modelId']");
  const modelId = button.dataset.modelId || "";
  const discoveredModel = currentGatewayCatalogModels6(form).find((model) => model.id === modelId) ?? null;
  if (modelInput) modelInput.value = modelId;
  if (discoveredModel) {
    applyGatewayDiscoveredModel6(form, discoveredModel);
  } else {
    const labelInput = form?.querySelector("input[name='label']");
    if (labelInput && !labelInput.value.trim()) labelInput.value = button.dataset.modelLabel || modelId;
    handleModelConfigModelIdChanged5(form);
  }
  modelInput?.focus?.({ preventScroll: true });
}
function applyGatewayDiscoveredModel6(form, discoveredModel) {
  if (!form || !discoveredModel) return false;
  const modelInput = (
    /** @type {HTMLInputElement | null} */
    form.querySelector("input[name='modelId']")
  );
  const modelId = String(modelInput?.value ?? "").trim();
  if (!modelId || discoveredModel.id !== modelId) return false;
  const labelInput = (
    /** @type {HTMLInputElement | null} */
    form.querySelector("input[name='label']")
  );
  const contextInput = (
    /** @type {HTMLInputElement | null} */
    form.querySelector("input[name='contextTokens']")
  );
  const visionInput = (
    /** @type {HTMLInputElement | null} */
    form.querySelector("input[name='vision']")
  );
  if (labelInput && !labelInput.value.trim()) labelInput.value = discoveredModel.label || modelId;
  if (!state.editingModelId && contextInput && !contextInput.value.trim() && discoveredModel.contextTokens) {
    contextInput.value = String(discoveredModel.contextTokens);
  }
  if (!state.editingModelId && visionInput && discoveredModel.modalities?.includes("image")) {
    visionInput.checked = true;
  }
  applyReasoningCapabilityCandidate6(form, reasoningCapabilityCandidate6(discoveredModel));
  return true;
}
function applySuggestedGatewayUrl5(button) {
  const form = button.closest("form");
  const input = form?.querySelector("input[name='gatewayUrl']");
  if (!input) return;
  const result = currentGatewayProbeResult6(form);
  const retainedAgentModelIds = result?.models?.map((model) => model.id) ?? [];
  input.value = button.dataset.gatewayUrl || "";
  markModelConfigEndpointChanged5(form, {
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
  renderGatewayProbeResult5();
}
function gatewayCredentialAction6(data, previousGateway) {
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
function normalizeGatewayProbeModels6(value) {
  return Array.isArray(value) ? value.map((modelValue) => {
    const model = typeof modelValue === "string" ? { id: modelValue, label: modelValue } : isPlainObject(modelValue) ? modelValue : {};
    const reasoning = isPlainObject(model.reasoning) ? model.reasoning : {};
    const id = String(model.id ?? model.model ?? "").trim();
    const reasoningEfforts = normalizeReasoningEfforts4(model.reasoningEfforts ?? reasoning.efforts);
    const requestedDefault = normalizedReasoningEffort6(model.defaultReasoningEffort ?? reasoning.default);
    const configuredDefault = configuredReasoningEffort4(requestedDefault, reasoningEfforts);
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
      reasoningDiscovery: normalizeReasoningDiscovery6(
        model.reasoningDiscovery ?? reasoning.discovery,
        reasoningEfforts,
        model.thinking === true ? true : null
      )
    };
  }).filter((model) => model.id) : [];
}
function normalizeReasoningDiscovery6(value, efforts = [], fallbackSupport = null) {
  const record = isPlainObject(value) ? value : {};
  const source = String(record.source ?? (efforts.length > 0 ? "upstream-metadata" : "unknown")).trim() || "unknown";
  const supportsReasoning = record.supportsReasoning === true ? true : record.supportsReasoning === false ? false : efforts.length > 0 ? true : fallbackSupport;
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
function reasoningCapabilityCandidate6(model) {
  const normalized = normalizeGatewayProbeModels6([model])[0] ?? {
    id: String(isPlainObject(model) ? model.id ?? "" : ""),
    reasoningEfforts: [],
    defaultReasoningEffort: null,
    reasoningDiscovery: normalizeReasoningDiscovery6(null, [])
  };
  return {
    modelId: normalized.id,
    reasoningEfforts: normalized.reasoningEfforts,
    defaultReasoningEffort: normalized.defaultReasoningEffort,
    reasoningDiscovery: normalized.reasoningDiscovery
  };
}
function applyReasoningCapabilityCandidate6(form, candidate, options = {}) {
  if (!form || !candidate) return false;
  const modelInput = (
    /** @type {HTMLInputElement | null} */
    form.querySelector("input[name='modelId']")
  );
  const modelId = String(modelInput?.value ?? "").trim();
  if (candidate.modelId && candidate.modelId !== modelId) return false;
  const normalized = reasoningCapabilityCandidate6({
    id: modelId,
    reasoningEfforts: candidate.reasoningEfforts,
    defaultReasoningEffort: candidate.defaultReasoningEffort,
    reasoningDiscovery: candidate.reasoningDiscovery
  });
  if (!reasoningCapabilityIsActionable6(normalized) && state.editingModelId && options.force !== true) {
    state.modelConfigReasoningDiscovery = normalized.reasoningDiscovery;
    state.modelConfigReasoningCandidate = null;
    state.modelCapabilityProbeError = "";
    renderReasoningCapabilityStatus5();
    return false;
  }
  if (state.modelConfigReasoningLocked && options.force !== true) {
    state.modelConfigReasoningCandidate = normalized;
    renderReasoningCapabilityStatus5();
    return false;
  }
  ensureReasoningEffortOptions6(form, normalized.reasoningEfforts);
  const selected = new Set(normalized.reasoningEfforts.map((effort) => effort.id));
  for (
    const input of
    /** @type {NodeListOf<HTMLInputElement>} */
    form.querySelectorAll("input[name='reasoningEfforts']")
  ) {
    input.checked = selected.has(input.value);
  }
  syncReasoningDefaultOptions5(form);
  const defaultSelect = (
    /** @type {HTMLSelectElement | null} */
    form.querySelector("select[name='defaultReasoningEffort']")
  );
  if (defaultSelect) defaultSelect.value = normalized.defaultReasoningEffort || "";
  const thinking = (
    /** @type {HTMLInputElement | null} */
    form.querySelector("input[name='thinking']")
  );
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
  renderReasoningCapabilityStatus5();
  return true;
}
function ensureReasoningEffortOptions6(form, efforts) {
  const container = form.querySelector(".model-reasoning-options");
  if (!container) return;
  const normalizedEfforts = normalizeReasoningEfforts4(efforts);
  const configuredDisabled = normalizedEfforts.find((effort) => isDisabledReasoningEffort6(effort.id))?.id ?? "";
  if (configuredDisabled) {
    for (
      const input of
      /** @type {NodeListOf<HTMLInputElement>} */
      container.querySelectorAll("input[name='reasoningEfforts']")
    ) {
      if (isDisabledReasoningEffort6(input.value) && input.value !== configuredDisabled) {
        input.closest("label")?.remove();
      }
    }
  }
  for (const effort of normalizedEfforts) {
    const existing = Array.from(container.querySelectorAll("input[name='reasoningEfforts']")).find((candidate) => candidate.value === effort.id);
    if (existing) {
      existing.dataset.effortLabel = effort.label;
      const text = existing.parentElement?.querySelector("span");
      if (text) text.textContent = effort.label;
      continue;
    }
    const label = document.createElement("label");
    label.innerHTML = `<input name="reasoningEfforts" type="checkbox" value="${escapeAttribute2(effort.id)}"><span></span>`;
    const created = label.querySelector("input");
    if (created) created.dataset.effortLabel = effort.label;
    const span = label.querySelector("span");
    if (span) span.textContent = effort.label;
    container.append(label);
  }
}
function applyPendingReasoningCapabilities5(form) {
  const candidate = state.modelConfigReasoningCandidate;
  if (!candidate) return;
  applyReasoningCapabilityCandidate6(form, candidate, { force: true });
}
function reasoningCapabilityIsActionable6(candidate) {
  if (!candidate) return false;
  return normalizeReasoningEfforts4(candidate.reasoningEfforts).length > 0 || candidate.reasoningDiscovery?.supportsReasoning === false;
}
function renderReasoningCapabilityStatus5() {
  const form = (
    /** @type {HTMLFormElement | null} */
    els.modelConfigPanel?.querySelector("#model-config-form") ?? null
  );
  const fieldset = (
    /** @type {HTMLElement | null} */
    form?.querySelector(".model-reasoning-config") ?? null
  );
  const status = (
    /** @type {HTMLElement | null} */
    form?.querySelector("#reasoning-capability-status") ?? null
  );
  const detect = (
    /** @type {HTMLButtonElement | null} */
    form?.querySelector("button[data-action='detect-reasoning-capabilities']") ?? null
  );
  const apply = (
    /** @type {HTMLButtonElement | null} */
    form?.querySelector("button[data-action='apply-reasoning-capabilities']") ?? null
  );
  if (!form || !fieldset || !status || !detect || !apply) return;
  const modelInput = (
    /** @type {HTMLInputElement | null} */
    form.querySelector("input[name='modelId']")
  );
  const modelId = String(modelInput?.value ?? "").trim();
  const candidate = state.modelConfigReasoningCandidate;
  const candidateActionable = reasoningCapabilityIsActionable6(candidate);
  fieldset.dataset.reasoningMode = state.modelConfigReasoningLocked ? "manual" : "auto";
  fieldset.dataset.reasoningSource = state.modelConfigReasoningSource;
  status.classList.toggle("error", Boolean(state.modelCapabilityProbeError));
  if (state.modelCapabilityProbeRunning) {
    status.textContent = "正在检测档位";
  } else if (state.modelCapabilityProbeError) {
    status.textContent = `检测失败：${state.modelCapabilityProbeError}`;
  } else {
    status.textContent = reasoningCapabilityStatusText6(candidateActionable ? candidate : null);
  }
  apply.classList.toggle("hidden", !candidateActionable);
  apply.disabled = state.modelCapabilityProbeRunning;
  detect.textContent = state.modelCapabilityProbeRunning ? "检测中" : "检测档位";
  detect.disabled = !modelId || state.modelCapabilityProbeRunning;
  const discovery = state.modelConfigReasoningDiscovery;
  detect.classList.toggle("hidden", discovery?.probeAvailable === false && !candidateActionable);
}
function reasoningCapabilityStatusText6(candidate) {
  const base = state.modelConfigReasoningSource === "manual" ? "手动设置" : state.modelConfigReasoningSource === "stored" ? "已保存配置" : reasoningDiscoveryStatusText6({
    reasoningEfforts: Array.from(
      /** @type {NodeListOf<HTMLInputElement>} */
      els.modelConfigPanel?.querySelectorAll("input[name='reasoningEfforts']:checked") ?? []
    ).map((input) => ({ id: input.value })),
    reasoningDiscovery: state.modelConfigReasoningDiscovery
  });
  if (!candidate) return base;
  return `${base}，${reasoningDiscoveryStatusText6(candidate, true)}`;
}
function reasoningDiscoveryStatusText6(candidate, pending = false) {
  const efforts = normalizeReasoningEfforts4(candidate?.reasoningEfforts);
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
async function probeModelCapabilities5(form) {
  if (!(form instanceof HTMLFormElement) || state.modelCapabilityProbeRunning) return;
  if (!form.reportValidity()) return;
  const data = new FormData(form);
  const modelId = String(data.get("modelId") ?? "").trim();
  if (!modelId) return;
  const profile = gatewayProfileById4(state.editingGatewayProfileId) ?? currentGatewayProfile5();
  const dialogGeneration = state.modelConfigDialogGeneration;
  const endpointRevision = state.modelConfigEndpointRevision;
  const credentialRevision = state.modelConfigCredentialRevision;
  const reasoningEditRevision = state.modelConfigReasoningEditRevision;
  const saveTarget = configScope5(data.get("saveTarget"), "global") || "global";
  const gatewayDiscoveryToken = currentGatewayProbeResult6(form)?.discoveryToken || "";
  const request = beginScopedRequest("model-capabilities-probe", `${dialogGeneration}:${endpointRevision}:${credentialRevision}:${modelId}`);
  state.modelCapabilityProbeRunning = true;
  state.modelCapabilityProbeError = "";
  state.modelConfigReasoningCandidate = null;
  renderReasoningCapabilityStatus5();
  try {
    const result = await postJson("/api/model-capabilities/probe", {
      modelId,
      gatewayUrl: data.get("gatewayUrl"),
      gatewayProtocol: data.get("gatewayProtocol"),
      gatewayApiKey: data.get("gatewayApiKey"),
      credentialAction: gatewayCredentialAction6(data, profile ?? state.gatewayConfig),
      clientId: dashboardClientId(),
      saveTarget,
      ...configMutationMetadata6(saveTarget),
      gatewayDiscoveryToken,
      profileId: profile?.id || state.gatewayConfig?.activeProfileId || "",
      previousGatewayUrl: profile?.gatewayUrl || state.gatewayConfig?.gatewayUrl || "",
      previousGatewayProtocol: profile?.gatewayProtocol || state.gatewayConfig?.gatewayProtocol || "openai-chat"
    }, { signal: request.signal, timeoutMs: 25e3 });
    if (!isCurrentModelConfigRequest6(request, form, dialogGeneration, endpointRevision, credentialRevision)) return;
    const currentModelInput = (
      /** @type {HTMLInputElement | null} */
      form.querySelector("input[name='modelId']")
    );
    if (String(currentModelInput?.value ?? "").trim() !== modelId) return;
    if (!result.ok) throw new Error(result.error ?? "档位检测失败");
    state.modelCapabilityDiscoveryToken = String(result.discoveryToken ?? "");
    const raw = result.model && typeof result.model === "object" ? { ...result.model, id: result.model.id || modelId } : result.capability && typeof result.capability === "object" ? { ...result.capability, id: result.capability.id || modelId } : { ...result, id: result.modelId || modelId };
    const candidate = reasoningCapabilityCandidate6(raw);
    if (candidate.reasoningDiscovery.source === "unknown") {
      candidate.reasoningDiscovery = {
        ...candidate.reasoningDiscovery,
        source: "active-probe",
        confidence: "probed"
      };
    }
    if (state.modelConfigReasoningEditRevision !== reasoningEditRevision) {
      state.modelConfigReasoningCandidate = candidate;
      renderReasoningCapabilityStatus5();
    } else {
      applyReasoningCapabilityCandidate6(form, candidate);
    }
  } catch (error) {
    if (!isAbortError(error) && isCurrentModelConfigRequest6(request, form, dialogGeneration, endpointRevision, credentialRevision)) {
      state.modelCapabilityProbeError = error instanceof Error ? error.message : "档位检测失败";
    }
  } finally {
    const current = isCurrentModelConfigRequest6(request, form, dialogGeneration, endpointRevision, credentialRevision);
    if (current) state.modelCapabilityProbeRunning = false;
    finishScopedRequest(request);
    if (current) renderReasoningCapabilityStatus5();
  }
}
function setFormControlsSaving5(form, saving, pendingLabel) {
  for (const control of form.querySelectorAll("input, select, textarea, button")) {
    if (saving) {
      control.dataset.saveDisabledBefore = control.disabled ? "true" : "false";
      control.disabled = true;
    } else if (control.dataset.saveDisabledBefore !== void 0) {
      control.disabled = control.dataset.saveDisabledBefore === "true";
      delete control.dataset.saveDisabledBefore;
    }
  }
  const submit = form.querySelector("button[type='submit']");
  if (submit) {
    if (saving) {
      submit.dataset.saveLabelBefore = submit.textContent ?? "";
      submit.textContent = pendingLabel;
    } else if (submit.dataset.saveLabelBefore !== void 0) {
      submit.textContent = submit.dataset.saveLabelBefore;
      delete submit.dataset.saveLabelBefore;
    }
  }
  if (saving) form.setAttribute("aria-busy", "true");
  else form.removeAttribute("aria-busy");
}
function setModelConfigFormSaving6(form, saving) {
  setFormControlsSaving5(form, saving, "保存中");
  const backdrop = els.modelConfigPanel?.querySelector(".model-config-backdrop");
  if (backdrop) backdrop.disabled = saving;
}
function renderModelConfigFailure6(form, message) {
  const feedback = form.querySelector(".model-config-feedback");
  if (!feedback) return;
  feedback.classList.remove("hidden");
  feedback.textContent = message;
}
function clearModelConfigFailure6(form) {
  const feedback = form.querySelector(".model-config-feedback");
  if (!feedback) return;
  feedback.classList.add("hidden");
  feedback.textContent = "";
}
function manualAgentModelIds6(form) {
  const ids = [];
  const seen = /* @__PURE__ */ new Set();
  for (const pickerElement of form.querySelectorAll("[data-agent-model-picker]")) {
    const picker = (
      /** @type {HTMLElement} */
      pickerElement
    );
    if (picker.dataset.manualActive !== "true") continue;
    const input = (
      /** @type {HTMLInputElement | null} */
      picker.querySelector(".agent-model-manual-input")
    );
    const id = String(input?.value ?? "").trim();
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

// src/dashboard/public/app-ui7.ts
async function saveModelConfig(event) {
  event.preventDefault();
  if (state.modelConfigSaving) {
    return;
  }
  const form = eventTargetOf(event).closest("form");
  if (!(form instanceof HTMLFormElement)) {
    return;
  }
  const data = new FormData(form);
  const editingProfile = gatewayProfileById4(state.editingGatewayProfileId);
  const profile = editingProfile ?? currentGatewayProfile5();
  const credentialAction = gatewayCredentialAction6(data, profile ?? state.gatewayConfig);
  const scope = configScope5(data.get("saveTarget"), "global") || "global";
  const discoveryToken = state.modelCapabilityDiscoveryToken || currentGatewayProbeResult6(form)?.discoveryToken || "";
  const payload = {
    saveTarget: scope,
    ...configMutationMetadata6(scope),
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
    manualAgentModelIds: manualAgentModelIds6(form),
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
  clearModelConfigFailure6(form);
  setModelConfigFormSaving6(form, true);
  try {
    const result = await postJson("/api/model-config", payload);
    if (!result.ok) {
      updateConfigRevisions({ ...result, scope });
      throw Object.assign(new Error(isConfigRevisionConflict7(result) ? configRevisionConflictMessage7() : result.error ?? "保存模型配置失败"), {
        configConflict: isConfigRevisionConflict7(result)
      });
    }
    updateConfigRevisions({ ...result, scope });
    state.models = normalizeModels(result.models);
    mergeGatewayConfig7(result.gatewayConfig);
    state.gatewayProfiles = normalizeGatewayProfiles(result.gatewayProfiles);
    state.agentModelTiers = normalizeAgentModelTiers(result.agentModelTiers);
    state.visionAgent = normalizeVisionAgent(result.visionAgent);
    updateSessionStatus(result.sessionStatus);
    if (!state.currentSessionId) rememberNewTaskModelState();
    state.modelConfigSaving = false;
    hideModelConfigPanel2();
    hideModelPanel();
    renderSettingsView4();
    renderComposerStatus();
    if (payload.switchToModel) {
      const defaultModelId = String(result.modelId ?? payload.modelId ?? "").trim();
      showNotice7("模型配置已保存", `${modelSaveTargetLabel7(payload.saveTarget)}，默认模型已设为 ${modelDisplayName7(defaultModelId, String(payload.label || payload.modelId || ""))}`);
    } else {
      showNotice7("模型配置已保存", `${modelSaveTargetLabel7(payload.saveTarget)}已更新`);
    }
  } catch (error) {
    if (isPlainObject(error) && error.configConflict) await refreshConfigRevisionsAfterConflict7();
    state.modelConfigSaving = false;
    setModelConfigFormSaving6(form, false);
    const message = error instanceof Error ? error.message : "保存模型配置失败";
    renderModelConfigFailure6(form, message);
    announceStatus(message);
    renderComposerStatus();
  }
}
async function saveDefaultModelSelection5(modelId, providerId, scope) {
  if (!modelId || !providerId || state.modelSwitching || state.settingsRefreshing) return;
  const model = gatewayProfileById4(providerId)?.models?.find((candidate) => candidate.id === modelId) ?? currentModelInfo4(modelId) ?? null;
  const reasoningEffort = normalizedReasoningEffort6(model?.defaultReasoningEffort) || null;
  state.modelSwitching = true;
  state.settingsFeedback = null;
  renderSettingsView4();
  try {
    const result = await postJson("/api/default-model", {
      scope,
      providerId,
      modelId,
      reasoningEffort,
      expectedRevision: state.configRevisions[scope] || void 0
    });
    if (!result.ok) {
      updateConfigRevisions({ ...result, scope });
      throw Object.assign(new Error(isConfigRevisionConflict7(result) ? configRevisionConflictMessage7() : result.error ?? "保存默认模型失败"), {
        configConflict: isConfigRevisionConflict7(result)
      });
    }
    updateConfigRevisions({ ...result, scope });
    if (Array.isArray(result.models)) state.models = normalizeModels(result.models);
    if (result.gatewayConfig) mergeGatewayConfig7(result.gatewayConfig);
    if (Array.isArray(result.gatewayProfiles)) state.gatewayProfiles = normalizeGatewayProfiles(result.gatewayProfiles);
    state.settingsFeedback = { tone: "success", message: scope === "global" ? "全局默认模型已保存" : "当前项目默认模型已保存" };
    announceStatus(state.settingsFeedback.message);
  } catch (error) {
    if (isPlainObject(error) && error.configConflict) await refreshConfigRevisionsAfterConflict7();
    state.settingsFeedback = { tone: "error", message: error instanceof Error ? error.message : "保存默认模型失败" };
    announceStatus(state.settingsFeedback.message);
  } finally {
    state.modelSwitching = false;
    renderSettingsView4();
  }
}
async function switchModel5(modelId, options = {}) {
  if (!modelId || state.modelSwitching) {
    return;
  }
  const requestSessionId = state.currentSessionId;
  const requestClientId = requestSessionId ? void 0 : dashboardClientId();
  state.modelSwitching = true;
  renderComposerStatus();
  renderModelPanel4();
  renderSettingsView4();
  try {
    const providerId = options.profileId || currentGatewayProfile5()?.id || "";
    const reasoningEffort = options.reasoningEffort ?? null;
    const result = await postJson("/api/model", {
      modelId,
      profileId: providerId || void 0,
      providerId: providerId || void 0,
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
    mergeGatewayConfig7(result.gatewayConfig);
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
    if (options.keepPanelOpen) renderModelPanel4();
    else hideModelPanel();
    announceStatus(`模型已切换为 ${modelDisplayName7(modelId)}`);
  } catch (error) {
    if (state.currentSessionId === requestSessionId) {
      showError(errorMessageOf(error) || "切换模型失败");
    }
  } finally {
    state.modelSwitching = false;
    renderComposerStatus();
    renderModelPanel4();
    renderSettingsView4();
    updateSendButton();
  }
}
async function handleReasoningEffortChange(event) {
  const select = eventTargetOf(event).closest("#reasoning-effort-select");
  if (!select || select.disabled) return;
  await switchReasoningEffort7(select.value);
}
async function switchReasoningEffort7(reasoningEffort) {
  if (state.reasoningEffortSwitching || state.running || state.modelSwitching) {
    return;
  }
  const selection = currentModelSelection4();
  if (selection.resolved === false || !selection.profile || !selection.model) {
    showError("请先重新选择模型来源和模型");
    return;
  }
  const requestSessionId = state.currentSessionId;
  const requestClientId = requestSessionId ? void 0 : dashboardClientId();
  state.reasoningEffortSwitching = true;
  renderComposerStatus();
  try {
    const normalized = normalizedReasoningEffort6(reasoningEffort);
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
    if (result.gatewayConfig) mergeGatewayConfig7(result.gatewayConfig);
    if (Array.isArray(result.gatewayProfiles)) state.gatewayProfiles = normalizeGatewayProfiles(result.gatewayProfiles);
    updateSessionStatus(result.sessionStatus ?? { reasoningEffort: normalized || null });
    if (!state.currentSessionId) rememberNewTaskModelState();
    announceStatus(`思考强度已设为 ${normalized ? reasoningEffortLabel7(normalized) : "默认"}`);
  } catch (error) {
    if (state.currentSessionId === requestSessionId) {
      showError(errorMessageOf(error) || "调整思考强度失败");
    }
  } finally {
    state.reasoningEffortSwitching = false;
    renderComposerStatus();
    renderSettingsView4();
  }
}
async function deleteGatewayProfile5(profileId) {
  if (!profileId || state.deletingGatewayProfileId || state.modelSwitching) {
    return;
  }
  if (state.deleteConfirmGatewayProfileId !== profileId) {
    state.deleteConfirmGatewayProfileId = profileId;
    renderSettingsView4();
    return;
  }
  state.deletingGatewayProfileId = profileId;
  renderSettingsView4();
  const requestSessionId = state.currentSessionId;
  const profile = gatewayProfileById4(profileId);
  const scope = configScope5(profile?.saveTarget) || "project";
  try {
    const result = await deleteJson2(`/api/gateway-profile/${encodeURIComponent(profileId)}`, {
      sessionId: requestSessionId,
      providerId: profileId,
      saveTarget: scope,
      ...configMutationMetadata6(scope)
    });
    if (state.currentSessionId !== requestSessionId) return;
    if (!result.ok) {
      updateConfigRevisions({ ...result, scope });
      throw Object.assign(new Error(isConfigRevisionConflict7(result) ? configRevisionConflictMessage7() : result.error ?? "删除网关失败"), {
        configConflict: isConfigRevisionConflict7(result)
      });
    }
    updateConfigRevisions({ ...result, scope });
    state.models = normalizeModels(result.models);
    mergeGatewayConfig7(result.gatewayConfig);
    state.gatewayProfiles = normalizeGatewayProfiles(result.gatewayProfiles);
    state.agentModelTiers = normalizeAgentModelTiers(result.agentModelTiers);
    state.visionAgent = normalizeVisionAgent(result.visionAgent);
    updateSessionStatus(result.sessionStatus);
    state.deleteConfirmGatewayProfileId = "";
    renderSettingsView4();
    showNotice7(result.clearedGateway ? "当前网关已删除" : "网关档案已删除");
  } catch (error) {
    if (state.currentSessionId !== requestSessionId) return;
    if (isPlainObject(error) && error.configConflict) {
      await refreshConfigRevisionsAfterConflict7();
      state.settingsFeedback = { tone: "error", message: errorMessageOf(error) };
    }
    showError(error instanceof Error ? error.message : "删除网关失败");
  } finally {
    state.deletingGatewayProfileId = "";
    renderSettingsView4();
    renderComposerStatus();
  }
}
async function deleteModel5(modelId, options = {}) {
  const providerId = options.profileId || currentGatewayProfile5()?.id || "";
  const modelKey = providerModelKey5(providerId, modelId);
  if (!modelId || !providerId || state.deletingModelKey || state.modelSwitching) {
    return;
  }
  if (state.deleteConfirmModelKey !== modelKey) {
    state.deleteConfirmModelKey = modelKey;
    renderSettingsView4();
    return;
  }
  state.deletingModelKey = modelKey;
  renderSettingsView4();
  renderComposerStatus();
  const requestSessionId = state.currentSessionId;
  const scope = configScope5(options.saveTarget || currentGatewayProfile5()?.saveTarget) || "project";
  try {
    const result = await deleteJson2(`/api/model-config/${encodeURIComponent(modelId)}`, {
      sessionId: requestSessionId,
      profileId: providerId,
      providerId,
      saveTarget: scope,
      ...configMutationMetadata6(scope)
    });
    if (state.currentSessionId !== requestSessionId) return;
    if (!result.ok) {
      updateConfigRevisions({ ...result, scope });
      throw Object.assign(new Error(isConfigRevisionConflict7(result) ? configRevisionConflictMessage7() : result.error ?? "删除模型失败"), {
        configConflict: isConfigRevisionConflict7(result)
      });
    }
    updateConfigRevisions({ ...result, scope });
    state.models = normalizeModels(result.models);
    mergeGatewayConfig7(result.gatewayConfig);
    state.gatewayProfiles = normalizeGatewayProfiles(result.gatewayProfiles);
    state.agentModelTiers = normalizeAgentModelTiers(result.agentModelTiers);
    state.visionAgent = normalizeVisionAgent(result.visionAgent);
    state.deleteConfirmModelKey = "";
    updateSessionStatus(result.sessionStatus);
    renderSettingsView4();
    showNotice7(result.clearedGateway ? "当前网关配置已清空" : "模型配置已删除");
  } catch (error) {
    if (state.currentSessionId !== requestSessionId) return;
    if (isPlainObject(error) && error.configConflict) {
      await refreshConfigRevisionsAfterConflict7();
      state.settingsFeedback = { tone: "error", message: errorMessageOf(error) };
    }
    showError(errorMessageOf(error) || "删除模型失败");
  } finally {
    state.deletingModelKey = "";
    renderSettingsView4();
    renderComposerStatus();
  }
}
function updateConfigRevisions(payload) {
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
  for (const scope of ["global", "project", "credentials"]) {
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
      global: normalizeScopedDefaultSelection7(defaultSelections.global),
      project: normalizeScopedDefaultSelection7(defaultSelections.project)
    };
  }
  const mutationScope = configScope5(record.scope ?? record.saveTarget, "");
  const mutationRevision = String(record.revision ?? record.currentRevision ?? "").trim();
  if ((mutationScope === "global" || mutationScope === "project") && mutationRevision) {
    state.configRevisions[mutationScope] = mutationRevision;
  }
}
function normalizeScopedDefaultSelection7(value) {
  const record = isPlainObject(value) ? value : {};
  const provider = String(record.provider ?? "").trim();
  const model = String(record.model ?? "").trim();
  if (!provider || !model) return null;
  const reasoningEffort = normalizedReasoningEffort6(record.reasoningEffort);
  return { provider, model, ...reasoningEffort ? { reasoningEffort } : {} };
}
function configScope5(value, fallback = "project") {
  return value === "global" ? "global" : value === "project" ? "project" : fallback;
}
function configMutationMetadata6(scope) {
  return {
    scope,
    expectedRevision: state.configRevisions[scope] || void 0,
    expectedCredentialsRevision: state.configRevisions.credentials || void 0
  };
}
function isConfigRevisionConflict7(result) {
  return result?.code === "CONFIG_REVISION_CONFLICT";
}
function configRevisionConflictMessage7() {
  return "配置已在另一个窗口更新。当前草稿已保留，再次保存会基于最新版本应用这份草稿。";
}
async function refreshConfigRevisionsAfterConflict7() {
  const result = await getJson(statusUrl()).catch(() => null);
  if (result?.ok) updateConfigRevisions(result);
}
function normalizeGatewayConfig(value) {
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
      gatewayUrl: normalizeConfigSource7(sources.gatewayUrl),
      gatewayHealthUrl: normalizeConfigSource7(sources.gatewayHealthUrl),
      gatewayProtocol: normalizeConfigSource7(sources.gatewayProtocol),
      apiKey: normalizeConfigSource7(sources.apiKey)
    }
  };
}
function normalizeDashboardSettings(value) {
  const record = isPlainObject(value) ? value : {};
  const transcript = isPlainObject(record.transcript) ? record.transcript : {};
  const network = isPlainObject(record.network) ? record.network : {};
  const agents = isPlainObject(record.agents) ? record.agents : {};
  const reliability = isPlainObject(record.reliability) ? record.reliability : {};
  const managed = isPlainObject(record.managed) ? record.managed : {};
  return {
    transcript: {
      enabled: transcript.enabled !== false,
      retentionDays: transcript.retentionDays === null ? null : Number.isInteger(Number(transcript.retentionDays)) ? Number(transcript.retentionDays) : 30,
      encryption: transcript.encryption === "off" || transcript.encryption === "optional" || transcript.encryption === "required" ? transcript.encryption : "off",
      encryptionKeyConfigured: transcript.encryptionKeyConfigured === true
    },
    network: {
      mode: network.mode === "offline" || network.mode === "lab-only" || network.mode === "approved-web" || network.mode === "open-dev" ? network.mode : "approved-web",
      allowedModes: Array.isArray(network.allowedModes) ? network.allowedModes.map(String).filter((mode) => mode === "offline" || mode === "lab-only" || mode === "approved-web" || mode === "open-dev") : ["offline", "lab-only", "approved-web", "open-dev"],
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
      timeoutMs: Math.min(9e5, Math.max(1e3, Number(reliability.timeoutMs) || 9e5)),
      idleTimeoutMs: Math.min(3e5, Math.max(1e3, Number(reliability.idleTimeoutMs) || 3e5))
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
function mergeGatewayConfig7(value) {
  if (!value || typeof value !== "object") {
    return;
  }
  state.gatewayConfig = normalizeGatewayConfig(value);
}
function normalizeGatewayProfiles(value) {
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
      saveTarget: configScope5(profile.saveTarget ?? profile.scope, ""),
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
function normalizeConfigSource7(value) {
  const record = isPlainObject(value) ? value : {};
  return {
    type: String(record.type ?? "default"),
    label: String(record.label ?? record.type ?? "default")
  };
}
function normalizeModels(models) {
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
      reasoningEfforts: normalizeReasoningEfforts4(model.reasoningEfforts ?? reasoning.efforts),
      defaultReasoningEffort: normalizedReasoningEffort6(model.defaultReasoningEffort ?? reasoning.default),
      reasoningEffort: normalizedReasoningEffort6(model.reasoningEffort),
      agentModelTiers: normalizeAgentModelTiers(model.agentModelTiers),
      source: normalizeModelSource7(model.source),
      sources: {
        modelAlias: normalizeConfigSource7(sources.modelAlias),
        models: normalizeConfigSource7(sources.models)
      },
      current: model.current === true,
      default: model.default === true
    };
  }).filter((model) => model.id) : [];
}
function normalizeModelSource7(value) {
  if (typeof value === "string") {
    return { id: value, label: value, profileId: "", ownerScope: "", saveTarget: "", editable: true };
  }
  const record = isPlainObject(value) ? value : {};
  return {
    id: String(record.id ?? record.profileId ?? record.providerId ?? ""),
    label: String(record.label ?? record.name ?? record.displayName ?? record.id ?? record.providerId ?? ""),
    profileId: String(record.profileId ?? record.providerId ?? record.id ?? ""),
    ownerScope: String(record.ownerScope ?? record.scope ?? ""),
    saveTarget: configScope5(record.saveTarget ?? record.scope, ""),
    editable: record.editable !== false
  };
}
function normalizeReasoningEfforts4(value) {
  if (!Array.isArray(value)) return [];
  const seen = /* @__PURE__ */ new Set();
  return value.map((effort) => {
    if (typeof effort === "string") {
      return { id: effort, label: reasoningEffortFallbackLabel7(effort), description: "" };
    }
    const record = isPlainObject(effort) ? effort : {};
    const id = String(record.id ?? record.value ?? "").trim().toLowerCase();
    const label = String(record.label ?? record.name ?? "").trim();
    return {
      id,
      label: localizedReasoningEffortLabel7(id, label),
      description: String(record.description ?? "")
    };
  }).filter((effort) => {
    if (!effort.id) return false;
    const key = isDisabledReasoningEffort6(effort.id) ? "disabled" : effort.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function normalizedReasoningEffort6(value) {
  const effort = String(value ?? "").trim().toLowerCase();
  return effort === "default" ? "" : effort;
}
function isDisabledReasoningEffort6(value) {
  return ["none", "off"].includes(normalizedReasoningEffort6(value));
}
function configuredReasoningEffort4(value, efforts) {
  const requested = normalizedReasoningEffort6(value);
  if (!isDisabledReasoningEffort6(requested)) return requested;
  return normalizeReasoningEfforts4(efforts).find((effort) => isDisabledReasoningEffort6(effort.id))?.id ?? requested;
}
function reasoningEffortFallbackLabel7(effort) {
  const labels = {
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
function localizedReasoningEffortLabel7(id, label) {
  const defaultEnglishLabels = {
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
    return reasoningEffortFallbackLabel7(id);
  }
  return normalizedLabel;
}
function reasoningEffortCatalog5(configured = []) {
  const normalizedConfigured = normalizeReasoningEfforts4(configured);
  const disabledId = normalizedConfigured.find((effort) => isDisabledReasoningEffort6(effort.id))?.id ?? "off";
  const catalog = [disabledId, "low", "medium", "high", "xhigh", "max", "ultra"].map((id) => ({ id, label: reasoningEffortFallbackLabel7(id), description: "" }));
  for (const effort of normalizedConfigured) {
    const index = catalog.findIndex((item) => item.id === effort.id);
    if (index >= 0) catalog[index] = effort;
    else catalog.push(effort);
  }
  return catalog;
}
function reasoningEffortLabel7(value) {
  const id = normalizedReasoningEffort6(value);
  return normalizeReasoningEfforts4(currentModelInfo4(state.sessionStatus?.model)?.reasoningEfforts).find((effort) => effort.id === id)?.label || reasoningEffortFallbackLabel7(id);
}
function resolveAtomicModelSelection7(options = {}) {
  const profiles = Array.isArray(options.profiles) ? options.profiles : [];
  const providerId = String(options.providerId ?? "").trim();
  const modelId = String(options.modelId ?? "").trim();
  const authoritativeUnresolved = options.selectionResolved === false;
  if (!authoritativeUnresolved && providerId) {
    const profile = profiles.find((candidate) => candidate.id === providerId) ?? null;
    const model = Array.isArray(profile?.models) ? profile.models.find((candidate) => candidate.id === modelId) ?? null : null;
    if (profile && model) return { profile, model, resolved: true, issue: null };
  }
  if (!authoritativeUnresolved && !providerId && modelId) {
    const matches = profiles.flatMap((profile) => {
      const model = Array.isArray(profile.models) ? profile.models.find((candidate) => candidate.id === modelId) ?? null : null;
      return model ? [{ profile, model }] : [];
    });
    if (matches.length === 1) return { ...matches[0], resolved: true, issue: null };
  }
  return options.allowFallback === true ? fallbackSelection() : unresolvedSelection();
  function fallbackSelection() {
    const fallbackProviderId = String(options.fallbackProviderId ?? "").trim();
    const fallbackModelId = String(options.fallbackModelId ?? "").trim();
    const profile = profiles.find((candidate) => candidate.id === fallbackProviderId) ?? profiles.find((candidate) => candidate.current === true) ?? (profiles.length === 1 ? profiles[0] : null);
    if (!profile || !Array.isArray(profile.models)) return unresolvedSelection();
    const model = profile.models.find((candidate) => candidate.id === fallbackModelId) ?? profile.models.find((candidate) => candidate.id === profile.modelAlias) ?? profile.models.find((candidate) => candidate.current === true) ?? profile.models[0] ?? null;
    return model ? { profile, model, resolved: true, issue: null } : unresolvedSelection();
  }
  function unresolvedSelection() {
    return {
      profile: null,
      model: null,
      resolved: false,
      issue: typeof options.selectionIssue === "string" ? options.selectionIssue : authoritativeUnresolved ? "unresolved" : "model-not-uniquely-resolved"
    };
  }
}
function currentModelSelection4() {
  const status = state.sessionStatus ?? emptySessionStatus;
  const fallback = state.newTaskModelState;
  return resolveAtomicModelSelection7({
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
function currentSessionNeedsModelSelection() {
  return Boolean(state.currentSessionId) && currentModelSelection4().resolved === false;
}
function currentGatewayProfile5() {
  return currentModelSelection4().profile;
}
function gatewayProfileById4(profileId) {
  const id = String(profileId ?? "").trim();
  return id ? (state.gatewayProfiles ?? []).find((profile) => profile.id === id) ?? null : null;
}
function settingsInspectedGatewayProfile5() {
  const profiles = state.gatewayProfiles ?? [];
  return gatewayProfileById4(state.settingsProviderId) ?? gatewayProfileById4(state.gatewayConfig?.activeProfileId) ?? profiles.find((profile) => profile.current) ?? profiles[0] ?? null;
}
function modelSourceLabel4(model) {
  const source = typeof model === "object" && model && typeof model.source === "object" ? model.source : null;
  const explicit = String(source?.label ?? "").trim();
  if (explicit) return explicit;
  const profile = currentGatewayProfile5();
  if (profile?.label) return profile.label;
  const gatewayUrl = String(state.gatewayConfig?.gatewayUrl ?? "");
  try {
    return new URL(gatewayUrl).hostname || "未配置来源";
  } catch {
    return gatewayUrl || "未配置来源";
  }
}
function markCurrentModel2(models, currentModel) {
  const current = String(currentModel ?? "");
  return normalizeModels(models).map((model) => ({
    ...model,
    current: model.id === current
  }));
}
function currentModelInfo4(modelId) {
  const id = String(modelId ?? "").trim();
  if (!id) return null;
  const selected = currentModelSelection4();
  if (selected.model?.id === id) return selected.model;
  const matches = (state.gatewayProfiles ?? []).flatMap((profile) => {
    const model = Array.isArray(profile.models) ? profile.models.find((candidate) => candidate.id === id) ?? null : null;
    return model ? [model] : [];
  });
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) return null;
  return (state.models ?? []).find((model) => model.id === id) ?? null;
}
function modelDisplayName7(modelId, fallback = "") {
  const id = String(modelId ?? "").trim();
  const fallbackLabel = String(fallback ?? "").trim();
  const model = currentModelInfo4(id);
  return model?.label || fallbackLabel || id || "当前模型";
}
function normalizeAgentModelTiers(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(Object.entries(value).map(([tier, model]) => [String(tier ?? "").trim(), String(model ?? "").trim()]).filter(([tier, model]) => tier && model));
}
function normalizeVisionAgent(value) {
  if (!isPlainObject(value)) {
    return { enabled: true, model: "", autoUseWhenMainModelTextOnly: true };
  }
  return {
    enabled: value.enabled !== false,
    model: String(value.model ?? "").trim(),
    autoUseWhenMainModelTextOnly: value.autoUseWhenMainModelTextOnly !== false
  };
}
function firstVisionModelId5() {
  return (state.models ?? []).find((model) => Array.isArray(model.modalities) && model.modalities.includes("image"))?.id ?? "";
}
function hasAgentModelTiers7(model) {
  return Object.keys(normalizeAgentModelTiers(model?.agentModelTiers)).length > 0;
}
function agentModelTiersSummary5(value) {
  const tiers = normalizeAgentModelTiers(value);
  const ordered = ["cheap", "default", "strong"].filter((tier) => tiers[tier]).map((tier) => `${tier}: ${tiers[tier]}`);
  return ordered.join(" · ");
}
function gatewaySummary7() {
  const gateway = state.gatewayConfig;
  const url = gateway?.gatewayUrl || "未配置网关";
  const key = gateway?.apiKeyConfigured ? `Key ${sourceBadge7(gateway.sources?.apiKey)}` : "未配置 Key";
  const source = sourceBadge7(gateway?.sources?.gatewayUrl || gateway?.sources?.gatewayProtocol);
  return `${url} · ${key} · ${source}`;
}
function modelSaveTargetLabel7(target) {
  return String(target) === "global" ? "全局默认" : "当前项目默认";
}
function gatewaySourceNote5(gateway) {
  const urlSource = sourceLabel5(gateway?.sources?.gatewayUrl);
  const protocolSource = sourceLabel5(gateway?.sources?.gatewayProtocol);
  const keySource = gateway?.apiKeyConfigured ? sourceLabel5(gateway.sources?.apiKey) : "未配置";
  return `当前生效：网关来自${urlSource}，协议来自${protocolSource}，API Key 来自${keySource}。`;
}
function environmentGatewayDefaultNote5(gateway) {
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
function sourceBadge7(source) {
  const type = typeof source === "string" ? source : String(source?.type ?? "");
  if (type === "project") return "项目";
  if (type === "environment") return "全局默认（环境变量）";
  if (type === "global") return "全局配置";
  if (type === "bundled") return "内置";
  return "默认";
}

// src/dashboard/public/app-ui8.ts
function sourceLabel5(source) {
  const type = typeof source === "string" ? source : String(source?.type ?? "");
  if (type === "project") return "当前项目";
  if (type === "environment") return "全局默认（环境变量）";
  if (type === "global") return "LAB_AGENT_CONFIG";
  if (type === "bundled") return "内置配置";
  return "默认配置";
}
function formatContextUsage4(context) {
  if (!context || typeof context !== "object") {
    return "-- / --";
  }
  const used = firstFiniteNumber8(
    context.messageTokens,
    context.promptMessageTokens,
    context.promptTokens,
    context.providerPromptTokens
  );
  const limit = firstFiniteNumber8(context.maxTokens, context.modelMaxTokens);
  const percent = typeof used === "number" && typeof limit === "number" && Number.isFinite(used) && Number.isFinite(limit) && limit > 0 ? ` · ${Math.min(999, Math.round(used / limit * 100))}%` : "";
  const cached = firstFiniteNumber8(
    context.providerCachedPromptTokens,
    context.cachedPromptTokens
  );
  const promptForCache = firstFiniteNumber8(
    context.providerPromptTokens,
    context.promptTokens
  );
  const cacheHit = typeof cached === "number" && typeof promptForCache === "number" && promptForCache > 0 ? ` · 缓存命中 ${Math.min(100, Math.max(0, Math.round(cached / promptForCache * 100)))}%` : " · 缓存命中 --";
  return `${formatTokenCount5(used)} / ${formatTokenCount5(limit)}${percent}${cacheHit}`;
}
function firstFiniteNumber8(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) {
      return number;
    }
  }
  return null;
}
function formatTokenCount5(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return "--";
  }
  if (number >= 1e6) {
    return `${trimNumber8(number / 1e6)}M`;
  }
  if (number >= 1e3) {
    return `${trimNumber8(number / 1e3)}k`;
  }
  return String(Math.round(number));
}
function trimNumber8(value) {
  return value >= 10 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
}
function nonNegativeInteger4(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}
function collapseCompletedActivities3() {
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
  appendTranscriptNode3(node);
  state.completedActivities = [];
  scrollTranscript2({ onlyIfNearBottom: true });
}
function clearAssistantDrafts3() {
  for (const draft of state.assistantDrafts.values()) {
    cancelScheduledAnimationFrame(draft, "renderFrame");
    draft.node?.remove();
  }
  state.assistantDrafts.clear();
}
function collapseAssistantDrafts3(finalText = "") {
  const capturedDrafts = Array.from(state.assistantDrafts.values()).filter((draft) => String(draft.text ?? "").trim().length > 0);
  clearAssistantDrafts3();
  if (capturedDrafts.length === 0) {
    return;
  }
  const visibleDrafts = capturedDrafts.filter((draft) => !isDuplicateDraftText8(draft.text, finalText));
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
  appendTranscriptNode3(node);
  scrollTranscript2({ onlyIfNearBottom: true });
}
function isMeaningfulCompletedActivity4(activity) {
  if (activity.toolName === "agent_run") {
    return true;
  }
  return activity.toolName === "write_file" || activity.toolName === "edit_file" || activity.toolName === "powershell" || activity.toolName === "bash" || activity.toolName === "web_fetch" || activity.toolName === "web_search" || activity.toolName === "document_intake";
}
function isDuplicateDraftText8(draftText, finalText) {
  const draft = normalizeComparableText3(draftText);
  const final = normalizeComparableText3(finalText);
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
function normalizeComparableText3(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}
function showApproval3(approval) {
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
    ...Array.isArray(approval.preview) ? approval.preview : []
  ].filter(Boolean).join("\n"))}</div>
    <div class="approval-actions">
      <button type="button" data-action="allow-once">允许一次</button>
      <button type="button" data-action="allow-session">本会话允许</button>
      <button type="button" data-action="deny" class="danger">拒绝</button>
      <button type="button" data-action="cancel">取消</button>
    </div>
  `;
  els.approvalPanel.querySelectorAll("button[data-action]").forEach((button) => {
    button.addEventListener("click", () => resolveApproval2(button.dataset.action));
  });
  activateModal(els.approvalPanel, { initialFocus: "button[data-action='allow-once']" });
  revealInteractionPanel8(els.approvalPanel, "button[data-action]");
  announceStatus(`需要确认 ${approval.toolName ?? "工具"} 权限`);
}
async function resolveApproval2(action) {
  const approval = state.pendingApproval;
  if (!approval || state.approvalSubmitting) return;
  state.approvalSubmitting = true;
  const buttons = (
    /** @type {HTMLButtonElement[]} */
    Array.from(els.approvalPanel.querySelectorAll("button[data-action]"))
  );
  for (const button of buttons) button.disabled = true;
  const result = await postJson(`/api/approvals/${encodeURIComponent(approval.id ?? "")}`, { action }).catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  if (state.pendingApproval?.id !== approval.id) return;
  if (!result.ok) {
    state.approvalSubmitting = false;
    for (const button of buttons) button.disabled = false;
    showError(result.error ?? "权限确认提交失败");
    return;
  }
  hideApproval2();
  els.runStatus.textContent = state.running ? "运行中" : "处理中";
}
function hideApproval2() {
  deactivateModal(els.approvalPanel);
  state.pendingApproval = null;
  state.approvalSubmitting = false;
  els.approvalPanel.classList.add("hidden");
  els.approvalPanel.innerHTML = "";
}
function showQuestion3(question) {
  if (!question) return;
  deactivateQuestionReviewBackground8();
  state.questionReviewMode = false;
  state.questionSubmitting = false;
  state.pendingQuestion = {
    ...question,
    selectedChoices: new Set((question.choices ?? []).filter((choice) => choice.selected).map((choice) => choice.value ?? choice.label)),
    customDraft: ""
  };
  renderQuestionPanel8();
  activateModal(els.questionPanel, {
    initialFocus: ".question-input, button[data-choice], button[data-action='submit']"
  });
  revealInteractionPanel8(els.questionPanel, ".question-input, button[data-choice], button[data-action='submit']");
  announceStatus("需要核对任务需求");
}
function revealInteractionPanel8(panel, focusSelector) {
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
function renderQuestionPanel8() {
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
    panel.querySelector("button[data-action='return-to-question']")?.addEventListener("click", returnToQuestion2);
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
      ${choices.length ? `<div class="question-choices">${choices.map((choice) => questionChoiceButton8(choice, question)).join("")}</div>` : ""}
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
  panel.querySelectorAll("button[data-choice]").forEach((button) => {
    button.addEventListener("click", () => toggleQuestionChoice8(button.dataset.choice));
  });
  panel.querySelector("button[data-action='review-conversation']")?.addEventListener("click", reviewQuestionConversation8);
  panel.querySelector("button[data-action='submit']")?.addEventListener("click", submitQuestion8);
  panel.querySelector("button[data-action='cancel']")?.addEventListener("click", cancelQuestion2);
  const input = (
    /** @type {HTMLTextAreaElement | null} */
    panel.querySelector(".question-input")
  );
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
function reviewQuestionConversation8() {
  if (!state.pendingQuestion || state.questionReviewMode) return;
  rememberQuestionDraft8();
  deactivateModal(els.questionPanel, { restoreFocus: false });
  state.questionReviewMode = true;
  renderQuestionPanel8();
  activateQuestionReviewBackground8();
  els.transcript?.focus?.({ preventScroll: true });
  announceStatus("需求确认已收起，可以查看对话；按 Esc 返回确认");
}
function returnToQuestion2() {
  if (!state.pendingQuestion || !state.questionReviewMode) return;
  deactivateQuestionReviewBackground8();
  state.questionReviewMode = false;
  renderQuestionPanel8();
  activateModal(els.questionPanel, {
    initialFocus: ".question-input, button[data-choice], button[data-action='submit']"
  });
  revealInteractionPanel8(els.questionPanel, ".question-input, button[data-choice], button[data-action='submit']");
  announceStatus("已返回需求确认");
}
function activateQuestionReviewBackground8() {
  deactivateQuestionReviewBackground8();
  const transcript = els.transcript;
  const panel = els.questionPanel;
  if (!transcript || !panel) return;
  const transcriptStage = transcript.closest?.(".transcript-stage") ?? transcript;
  const entries = collectModalBackground2(panel).filter((entry) => entry.node !== transcriptStage && !entry.node.contains?.(transcriptStage));
  state.questionReviewInertEntries = entries;
  for (const entry of entries) entry.node.inert = true;
}
function deactivateQuestionReviewBackground8() {
  for (const entry of state.questionReviewInertEntries) entry.node.inert = entry.inert;
  state.questionReviewInertEntries = [];
}
function questionChoiceButton8(choice, question) {
  const value = String(choice.value ?? choice.label);
  const selected = question.selectedChoices?.has(value) === true;
  return `
    <button type="button" class="question-choice${selected ? " selected" : ""}" data-choice="${escapeHtml(value)}" aria-pressed="${selected ? "true" : "false"}">
      <span>${escapeHtml(choice.label ?? value)}</span>
      ${choice.description ? `<small>${escapeHtml(choice.description)}</small>` : ""}
    </button>
  `;
}
function toggleQuestionChoice8(value) {
  const question = state.pendingQuestion;
  if (!question) return;
  rememberQuestionDraft8();
  const selectedChoices = question.selectedChoices ?? /* @__PURE__ */ new Set();
  if (question.multiple) {
    if (selectedChoices.has(value)) {
      selectedChoices.delete(value);
    } else {
      selectedChoices.add(value);
    }
    question.selectedChoices = selectedChoices;
  } else {
    question.selectedChoices = /* @__PURE__ */ new Set([value]);
  }
  renderQuestionPanel8();
  Array.from(els.questionPanel.querySelectorAll("button[data-choice]")).find((button) => button.dataset.choice === value)?.focus({ preventScroll: true });
}
async function submitQuestion8() {
  const question = state.pendingQuestion;
  if (!question || state.questionSubmitting) return;
  rememberQuestionDraft8();
  const selectedChoices = Array.from(question.selectedChoices ?? []);
  const customAnswer = (question.customDraft ?? "").trim();
  state.questionSubmitting = true;
  const buttons = (
    /** @type {HTMLButtonElement[]} */
    Array.from(els.questionPanel.querySelectorAll("button[data-action]"))
  );
  for (const button of buttons) button.disabled = true;
  const result = await postJson(`/api/questions/${encodeURIComponent(question.id ?? "")}`, {
    selectedChoices,
    customAnswer,
    answer: customAnswer,
    cancelled: false
  }).catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  finishQuestionSubmission8(question, buttons, result);
}
async function cancelQuestion2() {
  const question = state.pendingQuestion;
  if (!question || state.questionSubmitting) return;
  state.questionSubmitting = true;
  const buttons = (
    /** @type {HTMLButtonElement[]} */
    Array.from(els.questionPanel.querySelectorAll("button[data-action]"))
  );
  for (const button of buttons) button.disabled = true;
  const result = await postJson(`/api/questions/${encodeURIComponent(question.id ?? "")}`, {
    cancelled: true,
    answer: "",
    selectedChoices: []
  }).catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  finishQuestionSubmission8(question, buttons, result);
}
function finishQuestionSubmission8(question, buttons, result) {
  if (state.pendingQuestion?.id !== question.id) return;
  if (!result.ok) {
    state.questionSubmitting = false;
    for (const button of buttons) button.disabled = false;
    showError(result.error ?? "需求确认提交失败");
    return;
  }
  hideQuestion2();
  els.runStatus.textContent = state.running ? "运行中" : "处理中";
}
function hideQuestion2() {
  deactivateModal(els.questionPanel);
  deactivateQuestionReviewBackground8();
  state.questionReviewMode = false;
  state.questionSubmitting = false;
  state.pendingQuestion = null;
  els.questionPanel.classList.remove("question-reviewing");
  els.questionPanel.classList.add("hidden");
  els.questionPanel.innerHTML = "";
}
function showTrustPanel() {
  renderTrustPanel();
}
function renderTrustPanel() {
  if (!state.trust || state.trust.trusted) {
    els.trustPanel.classList.add("hidden");
    els.trustPanel.innerHTML = "";
    return;
  }
  els.trustPanel.classList.remove("hidden");
  const perProcess = state.trust.requiresPerProcessConfirmation ? "当前为高敏模式，本次确认只授权当前 Dashboard 进程。" : "确认后会记录这个工作区，下次从同一路径启动可继续使用。";
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
  els.trustPanel.querySelector("button[data-action='trust']").addEventListener("click", confirmTrust8);
}
async function confirmTrust8() {
  const button = els.trustPanel.querySelector("button[data-action='trust']");
  if (button) {
    button.disabled = true;
    button.textContent = "保存中";
  }
  const result = await postJson("/api/trust", {}).catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
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
function renderQueuePanel() {
  const visible = state.running || state.queue.length > 0 || state.pendingGuide;
  els.queuePanel.classList.toggle("hidden", !visible);
  if (!visible) {
    els.queuePanel.innerHTML = "";
    return;
  }
  const guideFeedback = state.pendingGuide ? renderGuideFeedback8(state.pendingGuide) : "";
  const queueItems = state.queue.slice(0, 6).map((item, index) => renderQueueItem8(item, index)).join("");
  const hiddenQueueCount = Math.max(0, state.queue.length - 6);
  els.queuePanel.innerHTML = `
    <div class="queue-head">
      <div class="queue-summary">
        <div class="queue-title">${state.queue.length > 0 ? `${state.queue.length} 条排队中` : "当前任务运行中"}</div>
        <div class="queue-copy">输入新内容回车会进入队列，未开始的队列可以取消。</div>
      </div>
      <button type="button" id="guide-button" class="${guideButtonVisible8() ? "" : "hidden"}" ${guideButtonDisabled8() ? "disabled" : ""}>${guideButtonText8()}</button>
    </div>
    ${guideFeedback}
    ${queueItems ? `<div class="queue-list">${queueItems}${hiddenQueueCount ? `<div class="queue-more">还有 ${hiddenQueueCount} 条排队内容未展开</div>` : ""}</div>` : ""}
  `;
  els.queuePanel.querySelector("#guide-button")?.addEventListener("click", () => guideTurn2());
  els.queuePanel.querySelectorAll("[data-guide-queue-id]").forEach((button) => {
    button.addEventListener("click", () => guideTurnFromQueue8(button.dataset.guideQueueId));
  });
  els.queuePanel.querySelectorAll("[data-cancel-queue-id]").forEach((button) => {
    button.addEventListener("click", () => cancelQueuedTurn2(button.dataset.cancelQueueId));
  });
  syncGuideButton();
}
function renderQueueItem8(item, index) {
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
function setPendingGuide2(guide) {
  state.pendingGuide = {
    ...state.pendingGuide ?? {},
    ...guide,
    preview: previewText8(guide.preview ?? state.pendingGuide?.preview ?? "")
  };
  renderQueuePanel();
  updateLiveStatus3();
}
function clearPendingGuide2() {
  state.pendingGuide = null;
  renderQueuePanel();
}
function syncPendingGuideFromQueue3() {
  if (state.pendingGuide) {
    const stillQueued = state.queue.some((item) => item.kind === "guide");
    if (!stillQueued && !state.running && state.pendingGuide.phase === "registered") {
      clearPendingGuide2();
      return;
    }
    renderQueuePanel();
    return;
  }
  const queuedGuide = state.queue.find((item) => item.kind === "guide");
  if (queuedGuide) {
    setPendingGuide2({
      sessionId: state.currentSessionId,
      phase: "registered",
      preview: queuedGuide.preview ?? ""
    });
    return;
  }
  renderQueuePanel();
}
function renderGuideFeedback8(guide) {
  const copy = guideCopy8(guide.phase);
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
function guideCopy8(phase) {
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
function guideSource2(queueItemId = "") {
  const queuedItem = queueItemId ? state.queue.find((item) => item.id === queueItemId && item.kind === "prompt" && !state.queueCancelling.has(item.id)) : null;
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
function guideTurnFromQueue8(queueItemId) {
  if (!queueItemId || state.guideSubmitting) {
    return;
  }
  guideTurn2(queueItemId);
}
function guideButtonText8() {
  if (state.guideSubmitting || state.pendingGuide?.phase === "registering") return "登记中";
  if (els.promptInput.value.trim()) return "引导对话";
  if (state.pendingGuide?.phase === "interrupting") return "接管中";
  if (state.pendingGuide?.phase === "continuing") return "引导中";
  return "引导对话";
}
function guideButtonDisabled8() {
  return !state.running || state.guideSubmitting || !guideSource2();
}
function guideButtonVisible8() {
  return state.running && (Boolean(els.promptInput.value.trim()) || state.guideSubmitting || state.pendingGuide?.phase === "registering");
}
function syncGuideButton() {
  const button = els.queuePanel.querySelector("#guide-button");
  if (!button) return;
  button.classList.toggle("hidden", !guideButtonVisible8());
  button.disabled = guideButtonDisabled8();
  button.textContent = guideButtonText8();
}
function shouldKeepGuideFeedback3() {
  return state.pendingGuide?.phase === "registering" || state.pendingGuide?.phase === "registered" || state.pendingGuide?.phase === "interrupting";
}
function isInterruptError3(message) {
  return /aborted|abort|interrupted|中断|取消/i.test(String(message ?? ""));
}
function updateSendButton() {
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
function showContextConfirm(action) {
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
  panel.querySelector("button[data-action='cancel']")?.addEventListener("click", () => hideContextConfirm2());
  panel.querySelector(`button[data-action='${action}']`)?.addEventListener("click", () => runContextAction8(action));
  activateModal(panel, { initialFocus: "button[data-action='cancel']" });
}
function hideContextConfirm2() {
  const panel = els.contextPanel;
  if (!panel) return;
  deactivateModal(panel);
  panel.classList.add("hidden");
  panel.innerHTML = "";
}
async function runContextAction8(action) {
  const endpoint = action === "clear" ? "/api/context/clear" : "/api/context/compact";
  const button = els.contextPanel.querySelector(`button[data-action='${action}']`);
  if (button) {
    button.disabled = true;
    button.textContent = action === "clear" ? "清空中" : "压缩中";
  }
  const result = await postJson(endpoint, {
    sessionId: state.currentSessionId,
    permissionMode: state.permissionMode
  }, contextActionRequestOptions8(action)).catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  if (!result.ok) {
    showError(result.error ?? "上下文操作失败");
    hideContextConfirm2();
    return;
  }
  state.currentSessionId = result.sessionId ?? state.currentSessionId;
  hideContextConfirm2();
  appendActivity2({
    title: action === "clear" ? "上下文已清空" : "上下文已压缩",
    detail: action === "clear" ? contextSummaryLine3(result.after) : compactResultLine8(result.result),
    severity: "success",
    collapsed: true
  });
  updateSessionStatus(result.sessionStatus);
}
function contextActionRequestOptions8(action) {
  return action === "compact" ? { timeoutMs: null } : {};
}
function contextSummaryLine3(summary) {
  const record = isPlainObject(summary) ? summary : null;
  return record ? `${record.messages ?? 0} 条上下文消息，摘要 ${record.summaryBytes ?? 0} 字节` : "";
}
function compactResultLine8(result) {
  const record = isPlainObject(result) ? result : null;
  if (!record) return "";
  return record.compacted ? `${record.beforeMessages ?? "-"} -> ${record.afterMessages ?? "-"}，摘要 ${record.summaryBytes ?? 0} 字节` : `未压缩：${record.reason ?? "无需压缩"}`;
}
function rememberQuestionDraft8() {
  const question = state.pendingQuestion;
  if (!question) return;
  const input = els.questionPanel.querySelector(".question-input");
  if (input) {
    question.customDraft = input.value;
  }
}
function questionResolutionText3(event) {
  if (event.cancelled) {
    return "已取消需求核对";
  }
  const parts = [];
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
async function showShutdownPanel() {
  const version = ++state.shutdownStatusVersion;
  cancelScopedRequest2("shutdown");
  const request = beginScopedRequest("shutdown");
  state.shutdownActivity = null;
  els.shutdownCopy.textContent = "正在检查主任务、队列和后台任务，请稍候。";
  els.shutdownConfirm.disabled = true;
  els.shutdownConfirm.textContent = "检查中";
  els.shutdownPanel.classList.remove("hidden");
  activateModal(els.shutdownPanel, { initialFocus: "#shutdown-cancel" });
  announceStatus("需要确认是否关闭 Dashboard");
  const result = await getJson("/api/lifecycle/status", {
    signal: request.signal,
    timeoutMs: DASHBOARD_LIFECYCLE_TIMEOUT_MS
  }).catch((error) => ({
    ok: false,
    error: errorMessageOf(error),
    code: isPlainObject(error) && typeof error.code === "string" ? error.code : void 0,
    timedOut: isPlainObject(error) && error.code === "DASHBOARD_REQUEST_TIMEOUT"
  }));
  if (!isCurrentScopedRequest(request) || version !== state.shutdownStatusVersion || els.shutdownPanel.classList.contains("hidden")) return;
  finishScopedRequest(request);
  if (!result.ok) {
    Object.assign(state, {
      shutdownActivity: normalizeLifecycleActivity8({ sessions: 1, total: 1, uncertain: true })
    });
    const detail = result.timedOut ? "活动检查超时" : errorMessageOf(result.error) || "未知错误";
    els.shutdownCopy.textContent = `无法确认当前活动状态：${detail}。可以取消任务并强制关闭，或返回继续处理。`;
    els.shutdownConfirm.disabled = false;
    els.shutdownConfirm.textContent = "强制关闭";
    announceStatus("Dashboard 活动检查超时，可强制关闭");
    return;
  }
  state.shutdownActivity = normalizeLifecycleActivity8(result.activity);
  renderShutdownActivity8();
}
function hideShutdownPanel() {
  state.shutdownStatusVersion += 1;
  cancelScopedRequest2("shutdown");
  deactivateModal(els.shutdownPanel);
  els.shutdownPanel.classList.add("hidden");
  els.shutdownConfirm.disabled = false;
  els.shutdownConfirm.textContent = "确认关闭";
}
async function shutdownDashboard() {
  if (!state.shutdownActivity) return;
  cancelScopedRequest2("shutdown");
  const request = beginScopedRequest("shutdown");
  els.shutdownConfirm.disabled = true;
  els.shutdownConfirm.textContent = "正在关闭";
  const result = await postJson("/api/shutdown", shutdownRequestBody8(state.shutdownActivity), {
    signal: request.signal,
    timeoutMs: DASHBOARD_SHUTDOWN_TIMEOUT_MS
  }).catch((error) => ({
    ok: false,
    error: errorMessageOf(error),
    code: isPlainObject(error) && typeof error.code === "string" ? error.code : void 0
  }));
  if (!isCurrentScopedRequest(request)) return;
  finishScopedRequest(request);
  if (!shutdownResultIsClosed8(result)) {
    const requestTimedOut = result?.code === "DASHBOARD_REQUEST_TIMEOUT";
    state.shutdownActivity = normalizeLifecycleActivity8({
      ...result?.activity ?? state.shutdownActivity ?? {},
      uncertain: requestTimedOut || result?.activity?.uncertain === true || state.shutdownActivity?.uncertain === true
    });
    els.shutdownCopy.textContent = `${errorMessageOf(result?.error) || "关闭失败"} ${lifecycleActivitySummary8(state.shutdownActivity)}。你可以返回继续处理，或重试取消任务并关闭。`;
    els.shutdownConfirm.disabled = false;
    els.shutdownConfirm.textContent = state.shutdownActivity.uncertain ? "强制关闭" : state.shutdownActivity.total > 0 ? "重试取消并关闭" : "重试关闭";
    els.runStatus.textContent = "关闭失败";
    announceStatus("Dashboard 关闭失败，页面仍可继续使用");
    els.shutdownConfirm.focus({ preventScroll: true });
    return;
  }
  disconnectEvents2();
  deactivateModal(els.shutdownPanel, { restoreFocus: false });
  els.shutdownPanel.classList.add("hidden");
  hideSettingsWorkspace({ restoreFocus: false });
  state.responsiveView = "conversation";
  syncResponsiveNavigation();
  document.body.classList.add("dashboard-closed");
  els.runStatus.textContent = "已关闭";
  cancelTranscriptAnimationFrames8();
  resetTranscriptWindow4();
  els.transcript.innerHTML = `
    <div class="empty-state">
      <div class="empty-kicker">Ant Code Dashboard</div>
      <div class="empty-title">Dashboard 已关闭</div>
      <div class="empty-copy">本机 WebUI 服务已经停止，可以关闭这个页面。再次使用时重新运行 ant-code dashboard。</div>
    </div>
  `;
  lockClosedDashboard8();
  announceStatus("Dashboard 已关闭");
}

// src/dashboard/public/markdown.ts
var renderInstanceCounter = 0;
var MAX_INLINE_DATA_IMAGE_BYTES = 2 * 1024 * 1024;
var LOCAL_FILE_EXTENSIONS10 = /* @__PURE__ */ new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "pdf",
  "md",
  "markdown",
  "txt",
  "log",
  "json",
  "csv",
  "tsv",
  "yaml",
  "yml",
  "js",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "jsx",
  "css",
  "html",
  "xml",
  "py",
  "ps1",
  "cmd",
  "sh",
  "java",
  "c",
  "cpp",
  "h",
  "hpp",
  "cs",
  "go",
  "rs",
  "php",
  "rb",
  "sql",
  "toml",
  "ini",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx"
]);
function renderMarkdown(value, options = {}) {
  const blocks = parseMarkdownBlocks(value);
  if (blocks.length === 0) {
    return "";
  }
  const context = createRenderContext(blocks, value, options);
  const body = blocks.map((block) => renderBlock(block, context)).join("");
  return context.includeToc ? `${renderToc(context.headings)}${body}` : body;
}
function parseMarkdownBlocks(value) {
  const lines = String(value ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let paragraph = [];
  let list = null;
  let code = null;
  let math = null;
  function flushParagraph() {
    if (paragraph.length > 0) {
      blocks.push({ type: "paragraph", text: paragraph.join("\n") });
      paragraph = [];
    }
  }
  function flushList() {
    if (list?.items?.length) {
      blocks.push(list);
    }
    list = null;
  }
  function flushOpenText() {
    flushParagraph();
    flushList();
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = line.match(/^```([^`]*)\s*$/);
    const mathFence = line.match(/^\s*\$\$\s*$/);
    if (math) {
      if (mathFence) {
        blocks.push(math);
        math = null;
      } else {
        math.text.push(line);
      }
      continue;
    }
    if (code) {
      if (fence) {
        blocks.push(code);
        code = null;
      } else {
        code.text.push(line);
      }
      continue;
    }
    if (mathFence) {
      flushOpenText();
      math = { type: "math", display: true, text: [] };
      continue;
    }
    if (fence) {
      flushOpenText();
      code = { type: "code", language: normalizeCodeLanguage(fence[1]), text: [] };
      continue;
    }
    if (/^\s*$/.test(line)) {
      flushOpenText();
      continue;
    }
    const table = readTable(lines, index);
    if (table) {
      flushOpenText();
      blocks.push(table.block);
      index = table.endIndex;
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      flushOpenText();
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2].trim() });
      continue;
    }
    const listItem = line.match(/^\s*[-*]\s+(.+)$/);
    if (listItem) {
      flushParagraph();
      if (!list || list.ordered) {
        flushList();
        list = { type: "list", ordered: false, items: [] };
      }
      list.items.push(parseListItem(listItem[1]));
      continue;
    }
    const orderedItem = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (orderedItem) {
      flushParagraph();
      if (!list || !list.ordered) {
        flushList();
        list = { type: "list", ordered: true, items: [] };
      }
      list.items.push(parseListItem(orderedItem[1]));
      continue;
    }
    const blockquote = readBlockquote(lines, index);
    if (blockquote) {
      flushOpenText();
      blocks.push(blockquote.block);
      index = blockquote.endIndex;
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  if (code) {
    blocks.push(code);
  }
  if (math) {
    blocks.push(math);
  }
  flushOpenText();
  return blocks;
}
function createRenderContext(blocks, source, options = {}) {
  const lightweight = options.lightweight === true;
  const instance = `md-${++renderInstanceCounter}`;
  const headingCounts = /* @__PURE__ */ new Map();
  const headings = [];
  for (const block of blocks) {
    if (block.type !== "heading") {
      continue;
    }
    const headingText = Array.isArray(block.text) ? block.text.join(" ") : String(block.text ?? "");
    const base = slugifyHeading(headingText) || "section";
    const count = headingCounts.get(base) ?? 0;
    headingCounts.set(base, count + 1);
    const id = `${instance}-${base}${count > 0 ? `-${count + 1}` : ""}`;
    block.id = id;
    headings.push({
      id,
      level: block.level ?? 1,
      text: headingText
    });
  }
  const includeToc = !lightweight && options.toc !== false && headings.length > 0 && (headings.length >= 3 || String(source ?? "").length > 2500 || blocks.length > 12);
  return { headings, includeToc, basePath: normalizeBasePath(options.basePath), lightweight };
}
function renderToc(headings) {
  const items = headings.filter((heading) => heading.level <= 3).map((heading) => `<a class="md-toc-item md-toc-level-${heading.level}" href="#${escapeAttribute6(heading.id)}">${renderInlineText(heading.text)}</a>`).join("");
  return `<details class="md-toc"><summary>目录 · ${headings.length} 节</summary><div class="md-toc-list">${items}</div></details>`;
}
function renderBlock(block, context) {
  if (block.type === "heading") {
    const id = block.id ? ` id="${escapeAttribute6(block.id)}"` : "";
    return `<h${block.level}${id}>${renderInline(block.text, context)}</h${block.level}>`;
  }
  if (block.type === "table") {
    if (context.lightweight) {
      return renderPlainDraftBlock(tableBlockToMarkdown(block), "表格预览");
    }
    return renderTable(block, context);
  }
  if (block.type === "code") {
    return renderCodeBlock(block, context);
  }
  if (block.type === "math") {
    if (context.lightweight) {
      return renderPlainDraftBlock(textLines(block.text).join("\n").trim(), "公式预览");
    }
    return renderMathBlock(block);
  }
  if (block.type === "list") {
    const tag = block.ordered ? "ol" : "ul";
    const items = (block.items ?? []).map((item) => renderListItem(item, context)).join("");
    return `<${tag}>${items}</${tag}>`;
  }
  if (block.type === "blockquote") {
    return `<blockquote>${renderMarkdown(typeof block.text === "string" ? block.text : textLines(block.text).join("\n"), { toc: false, basePath: context.basePath, lightweight: context.lightweight })}</blockquote>`;
  }
  return `<p>${renderInline(typeof block.text === "string" ? block.text : textLines(block.text).join("\n"), context).replace(/\n/g, "<br>")}</p>`;
}
function textLines(text) {
  if (Array.isArray(text)) return text;
  return text ? [text] : [];
}
function renderCodeBlock(block, context = {}) {
  const text = textLines(block.text).join("\n");
  if (context.lightweight) {
    const label = block.language ? `${block.language} 预览` : "代码预览";
    return renderPlainDraftBlock(text, label);
  }
  if (block.language === "mermaid") {
    return renderMermaidBlock(text);
  }
  if (isDataLanguage(block.language)) {
    return renderDataBlock(block.language, text);
  }
  const language = block.language ? `<span>${escapeHtml3(block.language)}</span>` : "";
  const diff = isDiffLanguage(block.language) ? " diff-code" : "";
  const code = isDiffLanguage(block.language) ? renderDiffCode(text) : escapeHtml3(text);
  return `<div class="md-code-frame"><div class="md-code-bar">${language}<button type="button" class="md-copy-code">复制</button></div><pre class="md-code${diff}"><code>${code}</code></pre></div>`;
}
function renderMathBlock(block) {
  const text = textLines(block.text).join("\n").trim();
  return `<div class="md-math-block" data-math-display="true" data-math-source="${escapeAttribute6(text)}"><div class="md-rich-label">公式</div><div class="md-math-output"><code>${escapeHtml3(text)}</code></div></div>`;
}
function renderMermaidBlock(text) {
  return `<div class="md-mermaid-frame"><div class="md-rich-bar"><span>流程图</span><button type="button" class="md-toggle-raw">查看原文</button></div><div class="md-mermaid-output" data-mermaid-source="${escapeAttribute6(text)}">正在渲染流程图</div><pre class="md-raw-source hidden"><code>${escapeHtml3(text)}</code></pre></div>`;
}
function renderDataBlock(language, text) {
  const label = dataLanguageLabel(language);
  return `<div class="md-data-frame" data-data-kind="${escapeAttribute6(language)}"><div class="md-rich-bar"><span>${escapeHtml3(label)}数据预览</span><button type="button" class="md-toggle-raw">查看原文</button></div><div class="md-data-output">正在整理数据预览</div><pre class="md-raw-source hidden"><code>${escapeHtml3(text)}</code></pre></div>`;
}
function renderPlainDraftBlock(text, label) {
  return `<div class="md-draft-plain"><div class="md-draft-plain-label">${escapeHtml3(label)}</div><pre><code>${escapeHtml3(text)}</code></pre></div>`;
}
function renderDiffCode(text) {
  return text.split("\n").map((line) => {
    const escaped = escapeHtml3(line);
    if (line.startsWith("+") && !line.startsWith("+++")) return `<span class="diff-add">${escaped}</span>`;
    if (line.startsWith("-") && !line.startsWith("---")) return `<span class="diff-del">${escaped}</span>`;
    if (line.startsWith("@@")) return `<span class="diff-hunk">${escaped}</span>`;
    return `<span>${escaped}</span>`;
  }).join("\n");
}
function renderListItem(item, context) {
  if (item.task) {
    return `<li class="task-list-item"><input type="checkbox" disabled${item.checked ? " checked" : ""}> <span>${renderInline(item.text, context)}</span></li>`;
  }
  return `<li>${renderInline(item.text, context)}</li>`;
}
function renderTable(block, context) {
  const headers = (block.headers ?? []).map(
    (cell, index) => `<th${alignmentAttribute((block.alignments ?? [])[index])}>${renderInline(cell, context)}</th>`
  ).join("");
  const rows = (block.rows ?? []).map((row) => {
    const cells = (block.headers ?? []).map(
      (_, index) => `<td${alignmentAttribute((block.alignments ?? [])[index])}>${renderInline(row[index] ?? "", context)}</td>`
    ).join("");
    return `<tr>${cells}</tr>`;
  }).join("");
  return `<div class="md-table-wrap"><table><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table></div>`;
}
function tableBlockToMarkdown(block) {
  const alignments = (block.alignments ?? []).map((alignment) => {
    if (alignment === "center") return ":---:";
    if (alignment === "right") return "---:";
    if (alignment === "left") return ":---";
    return "---";
  });
  return [block.headers ?? [], alignments, ...block.rows ?? []].map((row) => `| ${row.map((cell) => String(cell ?? "").replace(/\|/g, "\\|")).join(" | ")} |`).join("\n");
}
function alignmentAttribute(value) {
  return value ? ` class="align-${value}"` : "";
}
function readTable(lines, startIndex) {
  if (startIndex + 1 >= lines.length) {
    return null;
  }
  const header = parseTableRow(lines[startIndex]);
  const separator = parseTableSeparator(lines[startIndex + 1]);
  if (!header || !separator || header.length !== separator.length) {
    return null;
  }
  const rows = [];
  let index = startIndex + 2;
  for (; index < lines.length; index += 1) {
    if (/^\s*$/.test(lines[index])) {
      break;
    }
    const row = parseTableRow(lines[index]);
    if (!row || row.length !== header.length) {
      break;
    }
    rows.push(row);
  }
  return {
    block: {
      type: "table",
      headers: header,
      alignments: separator,
      rows
    },
    endIndex: index - 1
  };
}
function readBlockquote(lines, startIndex) {
  if (!/^>\s?/.test(lines[startIndex] ?? "")) {
    return null;
  }
  const quote = [];
  let index = startIndex;
  for (; index < lines.length; index += 1) {
    const match = lines[index].match(/^>\s?(.*)$/);
    if (!match) {
      break;
    }
    quote.push(match[1]);
  }
  return {
    block: { type: "blockquote", text: quote.join("\n") },
    endIndex: index - 1
  };
}
function parseListItem(value) {
  const text = String(value ?? "").trim();
  const task = text.match(/^\[([ xX])\]\s+(.+)$/);
  if (task) {
    return {
      task: true,
      checked: task[1].toLowerCase() === "x",
      text: task[2].trim()
    };
  }
  return { task: false, checked: false, text };
}
function parseTableRow(line) {
  const trimmed = String(line ?? "").trim();
  if (!trimmed.includes("|")) {
    return null;
  }
  const normalized = trimmed.startsWith("|") && trimmed.endsWith("|") ? trimmed.slice(1, -1) : trimmed;
  const cells = splitTableCells(normalized).map((cell) => cell.trim());
  return cells.length >= 2 ? cells : null;
}
function parseTableSeparator(line) {
  const cells = parseTableRow(line);
  if (!cells || !cells.every((cell) => /^:?-+:?$/.test(cell.replace(/\s+/g, "")))) {
    return null;
  }
  return cells.map((cell) => {
    const marker = cell.replace(/\s+/g, "");
    if (marker.startsWith(":") && marker.endsWith(":")) return "center";
    if (marker.endsWith(":")) return "right";
    if (marker.startsWith(":")) return "left";
    return "";
  });
}
function splitTableCells(value) {
  const cells = [];
  let current = "";
  let escaped = false;
  for (const char of value) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "|") {
      cells.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current);
  return cells;
}
function renderInline(value, context) {
  const parts = String(value ?? "").split(/(`[^`]+`)/g);
  return parts.map((part) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length >= 2) {
      return `<code>${escapeHtml3(part.slice(1, -1))}</code>`;
    }
    return renderInlineMath(part, context);
  }).join("");
}
function renderInlineMath(value, context) {
  if (context.lightweight) {
    return renderInlineMarkdown(value, context);
  }
  return String(value ?? "").split(/(\$[^$\n]+\$)/g).map((part) => {
    if (/^\$[^$\n]+\$$/.test(part)) {
      const source = part.slice(1, -1).trim();
      if (!source) {
        return escapeHtml3(part);
      }
      return `<span class="md-math-inline" data-math-source="${escapeAttribute6(source)}"><code>${escapeHtml3(source)}</code></span>`;
    }
    return renderInlineMarkdown(part, context);
  }).join("");
}
function renderInlineMarkdown(value, context) {
  return String(value ?? "").split(/(!?\[[^\]]*\]\([^)]+\))/g).map((part) => {
    const image = part.match(/^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/);
    if (image) {
      return renderImage(image[1], image[2], context);
    }
    const link = part.match(/^\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/);
    if (link) {
      return renderLink(link[1], link[2], context);
    }
    return renderInlineText(part);
  }).join("");
}
function renderInlineText(value) {
  return escapeHtml3(value).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/~~([^~]+)~~/g, "<del>$1</del>").replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, "$1<em>$2</em>");
}
function renderLink(label, href, context) {
  const safeHref = safeUrl(href);
  if (!safeHref) {
    return renderInlineText(label);
  }
  const resolvedHref = resolveRelativeUrl(safeHref, context?.basePath);
  if (isLocalWorkspaceUrl(resolvedHref)) {
    return `<button type="button" class="file-link" data-file="${escapeAttribute6(resolvedHref)}" title="${escapeAttribute6(resolvedHref)}">${renderInlineText(label)}</button>`;
  }
  return `<a href="${escapeAttribute6(resolvedHref)}" target="_blank" rel="noopener noreferrer">${renderInlineText(label)}</a>`;
}
function renderImage(alt, src, context) {
  const safeSrc = safeUrl(src, { allowDataImage: true });
  if (!safeSrc) {
    return renderInlineText(alt);
  }
  const resolvedSrc = resolveRelativeUrl(safeSrc, context?.basePath);
  if (resolvedSrc.startsWith("/") && !resolvedSrc.startsWith("/api/files/raw?")) {
    return renderInlineText(alt);
  }
  if (context?.lightweight) {
    return `<span class="md-draft-media">${renderInlineText(alt || "图片")} · ${escapeHtml3(resolvedSrc)}</span>`;
  }
  if (/^https?:\/\//i.test(resolvedSrc)) {
    const host = remoteImageHost(resolvedSrc);
    const label = alt || "远程图片";
    return `<span class="md-draft-media md-remote-media"><span>${renderInlineText(label)} · ${escapeHtml3(host)}</span> <a href="${escapeAttribute6(resolvedSrc)}" target="_blank" rel="noopener noreferrer">${escapeHtml3(resolvedSrc)}</a></span>`;
  }
  const escapedAlt = escapeAttribute6(alt);
  return `<button type="button" class="md-image-button" data-image-src="${escapeAttribute6(resolvedSrc)}" data-image-alt="${escapedAlt}" aria-label="打开 ${escapedAlt} 大图"><img src="${escapeAttribute6(resolvedSrc)}" alt="${escapedAlt}"></button>`;
}
function safeUrl(value, options = {}) {
  const text = String(value ?? "").trim();
  if (options.allowDataImage && /^data:/i.test(text)) {
    return safeDataImageUrl(text);
  }
  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      return url.protocol === "http:" || url.protocol === "https:" ? text : "";
    } catch {
      return "";
    }
  }
  if (/^(\/|\.\/|\.\.\/)/i.test(text) || isLikelyLocalFileUrl(text)) {
    return text;
  }
  return "";
}
function safeDataImageUrl(value) {
  const match = String(value ?? "").match(/^data:image\/(png|jpeg|gif|webp);base64,([a-z0-9+/]+={0,2})$/i);
  if (!match || match[2].length % 4 !== 0) {
    return "";
  }
  const padding = match[2].endsWith("==") ? 2 : match[2].endsWith("=") ? 1 : 0;
  const decodedBytes = match[2].length / 4 * 3 - padding;
  if (decodedBytes <= 0 || decodedBytes > MAX_INLINE_DATA_IMAGE_BYTES) {
    return "";
  }
  let prefix;
  try {
    prefix = atob(match[2].slice(0, 32));
  } catch {
    return "";
  }
  const bytes = Array.from(prefix, (char) => char.charCodeAt(0));
  if (!matchesBitmapSignature(match[1].toLowerCase(), bytes)) {
    return "";
  }
  return String(value);
}
function matchesBitmapSignature(kind, bytes) {
  if (kind === "png") {
    return startsWithBytes(bytes, [137, 80, 78, 71, 13, 10, 26, 10]);
  }
  if (kind === "jpeg") {
    return startsWithBytes(bytes, [255, 216, 255]);
  }
  if (kind === "gif") {
    return startsWithBytes(bytes, [71, 73, 70, 56, 55, 97]) || startsWithBytes(bytes, [71, 73, 70, 56, 57, 97]);
  }
  return startsWithBytes(bytes, [82, 73, 70, 70]) && startsWithBytes(bytes.slice(8), [87, 69, 66, 80]);
}
function startsWithBytes(value, expected) {
  return expected.every((byte, index) => value[index] === byte);
}
function remoteImageHost(value) {
  try {
    return new URL(value).host || "remote";
  } catch {
    return "remote";
  }
}
function isLikelyLocalFileUrl(value) {
  if (!/^[A-Za-z0-9_.\-\/\\]+\.[A-Za-z0-9]{1,8}$/i.test(value)) {
    return false;
  }
  const extension = value.split(".").pop()?.toLowerCase() ?? "";
  return LOCAL_FILE_EXTENSIONS10.has(extension);
}
function normalizeBasePath(value) {
  const text = String(value ?? "").trim().replace(/\\/g, "/");
  if (!text || text.startsWith("/") || text.startsWith("../") || text.includes("://")) {
    return "";
  }
  return text.replace(/^\.\/+/, "").replace(/\/+$/, "");
}
function resolveRelativeUrl(url, basePath = "") {
  const text = String(url ?? "").trim().replace(/\\/g, "/");
  if (!text || !basePath || /^(https?:|\/|data:image\/)/i.test(text)) {
    return text;
  }
  if (isWorkspaceRelativeToBase9(text, basePath)) {
    return normalizeRelativePath9(text);
  }
  return normalizeRelativePath9(`${basePath}/${text}`);
}
function isLocalWorkspaceUrl(value) {
  const text = String(value ?? "").trim();
  return Boolean(text) && !/^(https?:|\/|data:image\/|#)/i.test(text);
}
function normalizeRelativePath9(value) {
  const parts = String(value ?? "").replace(/\\/g, "/").split("/");
  const stack = [];
  for (const part of parts) {
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
function isWorkspaceRelativeToBase9(value, basePath = "") {
  const firstBaseSegment = String(basePath ?? "").split("/").filter(Boolean)[0];
  return Boolean(firstBaseSegment) && String(value ?? "").startsWith(`${firstBaseSegment}/`);
}
function normalizeCodeLanguage(value) {
  return String(value ?? "").trim().split(/\s+/)[0].toLowerCase();
}
function isDiffLanguage(value) {
  return ["diff", "patch"].includes(String(value ?? "").toLowerCase());
}
function isDataLanguage(value) {
  return ["json", "yaml", "yml", "csv", "tsv"].includes(String(value ?? "").toLowerCase());
}
function dataLanguageLabel(value) {
  const language = String(value ?? "").toLowerCase();
  if (language === "yml") return "YAML ";
  return language ? `${language.toUpperCase()} ` : "";
}
function slugifyHeading(value) {
  const ascii = String(value ?? "").trim().toLowerCase().replace(/[`*_~()[\]{}:;,.!?/\\|"'<>]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (ascii) {
    return ascii.slice(0, 64);
  }
  const encoded = Array.from(String(value ?? "").trim()).slice(0, 24).map((char) => char.codePointAt(0)?.toString(16) ?? "").filter(Boolean).join("-");
  return encoded ? `section-${encoded}` : "section";
}
function escapeHtml3(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function escapeAttribute6(value) {
  return escapeHtml3(value).replace(/`/g, "&#96;");
}

// src/dashboard/public/app-ui9.ts
function lockClosedDashboard8() {
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
function normalizeLifecycleActivity8(activity = {}) {
  const record = isPlainObject(activity) ? activity : {};
  const count = (value) => {
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
function shutdownRequestBody8(activity) {
  const normalized = normalizeLifecycleActivity8(activity);
  if (normalized.uncertain) {
    return { cancel: true, force: true, timeoutMs: DASHBOARD_SHUTDOWN_TIMEOUT_MS };
  }
  return normalized.total > 0 ? { cancel: true } : {};
}
function shutdownResultIsClosed8(result) {
  return result?.ok === true;
}
function lifecycleActivitySummary8(activity) {
  return `活动会话 ${activity.sessions} 个，主任务 ${activity.activeTurns} 个，隔离任务 ${activity.quarantinedTurns} 个，队列 ${activity.queuedTurns} 项，后台任务 ${activity.backgroundTasks} 个，待确认 ${activity.pendingInteractions} 项`;
}
function renderShutdownActivity8() {
  const activity = state.shutdownActivity;
  if (!activity) return;
  const summary = lifecycleActivitySummary8(activity);
  els.shutdownCopy.textContent = activity.total > 0 ? `${summary}。关闭会取消这些未完成工作并等待收束；也可以返回继续处理。` : `${summary}。当前没有未完成工作，确认后会停止本机 WebUI。`;
  els.shutdownConfirm.disabled = false;
  els.shutdownConfirm.textContent = activity.total > 0 ? "取消任务并关闭" : "确认关闭";
}
function renderFiles2() {
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
    item.addEventListener("click", () => openFile9(file.relativePath));
    els.fileList.append(item);
  }
}
function currentImageFiles9() {
  return state.files.filter((file) => file.kind === "image").map((file) => ({
    name: file.name,
    rawUrl: rawFileUrl9(file.relativePath),
    relativePath: file.relativePath
  }));
}
async function openFile9(filePath) {
  if (!filePath) return;
  const sessionId = state.currentSessionId;
  const request = beginScopedRequest("file", `${sessionId ?? "new"}:${filePath}`);
  els.previewBody.className = "preview-body";
  els.previewBody.innerHTML = `<div class="preview-placeholder">正在加载文件预览</div>`;
  const result = await getJson(filePreviewUrl9(filePath), { signal: request.signal }).catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error), aborted: isAbortError(error) }));
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
      const images = currentImageFiles9();
      const index = Math.max(0, images.findIndex((item) => item.relativePath === file.relativePath));
      showImageLightbox9(file, images.length ? images : [file], index);
    });
  } else if (file.kind === "pdf") {
    els.previewBody.innerHTML = `<iframe class="preview-frame" title="${escapeHtml(file.name)}" src="${file.rawUrl}"></iframe>`;
  } else if (file.kind === "office-preview") {
    els.previewBody.classList.add("document-preview-body");
    els.previewBody.replaceChildren(renderOfficePreview9(file));
  } else if (file.kind === "table-preview") {
    els.previewBody.classList.add("document-preview-body");
    els.previewBody.replaceChildren(renderTablePreview9(file));
  } else if (file.kind === "office" || file.kind === "binary" || file.kind === "download") {
    const download = file.downloadOnly ? ` download="${escapeHtml(file.name)}"` : "";
    const target = file.downloadOnly ? "" : ` target="_blank"`;
    els.previewBody.innerHTML = `<div class="office-card"><strong>${escapeHtml(file.name)}</strong><p>${escapeHtml(file.message ?? "此文件第一版不直接预览。")}</p><p>${escapeHtml(file.relativePath)}</p><a class="open-file" href="${file.rawUrl}"${download}${target} rel="noopener noreferrer">${file.downloadOnly ? "下载文件" : "打开文件"}</a></div>`;
  } else if (file.kind === "markdown") {
    els.previewBody.classList.add("document-preview-body");
    const article = document.createElement("article");
    article.className = "markdown-document markdown-body";
    article.tabIndex = 0;
    article.setAttribute("aria-label", `${file.name} Markdown 内容`);
    renderMessageText(article, file.content ?? "", { markdown: true, basePath: parentDirectory9(file.relativePath) });
    els.previewBody.replaceChildren(article);
  } else if (file.kind === "data") {
    els.previewBody.classList.add("document-preview-body");
    const article = document.createElement("article");
    article.className = "markdown-document markdown-body";
    article.tabIndex = 0;
    article.setAttribute("aria-label", `${file.name} 数据预览`);
    renderMessageText(article, fencedDataForFile9(file), { markdown: true });
    els.previewBody.replaceChildren(article);
  } else {
    els.previewBody.classList.add("document-preview-body");
    els.previewBody.innerHTML = `<pre class="preview-code" tabindex="0" aria-label="${escapeHtml(file.name)} 文档内容">${escapeHtml(file.content ?? "")}</pre>`;
  }
}
function renderOfficePreview9(file) {
  if (file.table) {
    return renderTablePreview9(file);
  }
  const article = document.createElement("article");
  article.className = `office-preview office-preview-${escapeHtml(file.officeKind ?? "document")}`;
  article.tabIndex = 0;
  article.setAttribute("aria-label", `${file.name} 轻量预览`);
  const meta = officePreviewMeta9(file);
  const openHref = file.rawUrl ?? rawFileUrl9(file.relativePath);
  article.innerHTML = `
    <header class="office-preview-header">
      <div>
        <strong>${escapeHtml(file.name)}</strong>
        <span>${escapeHtml(meta)}</span>
      </div>
      <a class="open-file" href="${openHref}" target="_blank" rel="noreferrer">打开</a>
    </header>
    ${officePreviewBodyHtml9(file)}
    ${file.truncated ? `<div class="office-preview-note">仅显示前 ${formatNumber9(file.content?.length ?? 0)} 字符，完整内容请打开文件。</div>` : ""}
  `;
  return article;
}
function officePreviewMeta9(file) {
  const kind = String(file.officeKind ?? "").toLowerCase();
  if (kind === "xlsx") return "Excel 轻量预览";
  if (kind === "pptx") return "PPT 文本预览";
  return "DOCX 文本预览";
}
function officePreviewBodyHtml9(file) {
  const kind = String(file.officeKind ?? "").toLowerCase();
  if (kind === "xlsx") {
    return `<div class="office-sheet-list">${renderSheetPreviewHtml9(file.content ?? "")}</div>`;
  }
  return `<pre class="office-text-preview">${escapeHtml(file.content ?? "")}</pre>`;
}
function renderTablePreview9(file) {
  const article = document.createElement("article");
  article.className = "office-preview table-preview";
  article.tabIndex = 0;
  article.setAttribute("aria-label", `${file.name} 表格预览`);
  const table = normalizeTablePreview9(file.table);
  const openHref = file.rawUrl ?? rawFileUrl9(file.relativePath);
  const meta = tablePreviewMeta9(file, table);
  article.innerHTML = `
    <header class="office-preview-header">
      <div>
        <strong>${escapeHtml(file.name)}</strong>
        <span>${escapeHtml(meta)}</span>
      </div>
      <div class="office-preview-actions">
        <button class="open-file table-expand-button" type="button">放大</button>
        <a class="open-file" href="${openHref}" target="_blank" rel="noreferrer">打开</a>
      </div>
    </header>
    <div class="table-preview-button" role="button" tabindex="0" aria-label="放大查看 ${escapeHtml(file.name)}">
      ${renderCompactTableHtml9(table)}
    </div>
    ${tableTruncationNote9(table)}
  `;
  const previewButton = article.querySelector(".table-preview-button");
  previewButton?.addEventListener("click", () => showTableLightbox9(file));
  previewButton?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      showTableLightbox9(file);
    }
  });
  article.querySelector(".table-expand-button")?.addEventListener("click", () => showTableLightbox9(file));
  return article;
}
function normalizeTablePreview9(table) {
  const record = isPlainObject(table) ? table : {};
  const sheets = Array.isArray(record.sheets) ? record.sheets : [];
  return {
    kind: String(record.kind ?? "table"),
    totalSheets: Number(record.totalSheets ?? sheets.length),
    sheets: sheets.map((sheetValue, index) => {
      const sheet = isPlainObject(sheetValue) ? sheetValue : {};
      return {
        name: String(sheet.name || `Sheet ${index + 1}`),
        source: String(sheet.source ?? ""),
        rows: Array.isArray(sheet.rows) ? sheet.rows.map((row) => Array.isArray(row) ? row.map((cell) => String(cell ?? "")) : []) : [],
        truncatedRows: Boolean(sheet.truncatedRows),
        truncatedColumns: Boolean(sheet.truncatedColumns)
      };
    }).filter((sheet) => sheet.rows.length > 0)
  };
}
function tablePreviewMeta9(file, table) {
  const kind = String(file.officeKind ?? file.tableKind ?? table.kind ?? "table").toUpperCase();
  const sheetCount = table.totalSheets > 1 ? `${table.totalSheets} 个 Sheet` : "1 个表";
  const first = table.sheets[0];
  const size = first ? `${first.rows.length} 行 · ${maxVisibleColumns9(first.rows)} 列` : "空表";
  return `${kind} 表格预览 · ${sheetCount} · ${size}`;
}
function renderCompactTableHtml9(table) {
  const first = table.sheets[0];
  if (!first) {
    return `<div class="preview-placeholder">没有可展示的表格内容</div>`;
  }
  const rows = first.rows.slice(0, 16);
  const columns = Math.min(maxVisibleColumns9(rows), 8);
  return `
    <div class="compact-table-wrap">
      ${renderTableHtml9(rows, columns, { compact: true })}
    </div>
  `;
}
function renderExpandedTableHtml9(table, activeIndex = 0) {
  const sheets = table.sheets ?? [];
  const sheetIndex = Math.max(0, Math.min(activeIndex, Math.max(0, sheets.length - 1)));
  const sheet = sheets[sheetIndex];
  if (!sheet) {
    return `<div class="preview-placeholder">没有可展示的表格内容</div>`;
  }
  const columns = maxVisibleColumns9(sheet.rows);
  return `
    <div class="table-viewer ${sheets.length > 1 ? "has-sheets" : "single-sheet"}">
      ${sheets.length > 1 ? `<nav class="table-sheet-rail" aria-label="Sheet 切换">${sheets.map((item, index) => `<button class="${index === sheetIndex ? "active" : ""}" type="button" aria-current="${index === sheetIndex ? "true" : "false"}" data-sheet-index="${index}" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</button>`).join("")}</nav>` : ""}
      <section class="table-viewer-main" aria-label="${escapeHtml(sheet.name)}">
        <div class="expanded-table-scroll">
          ${renderTableHtml9(sheet.rows, columns, { compact: false })}
        </div>
        ${sheet.truncatedRows || sheet.truncatedColumns ? `<div class="office-preview-note">表格较大，当前显示已限制行列数量。</div>` : ""}
      </section>
    </div>
  `;
}
function renderTableHtml9(rows, columns, options = {}) {
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
          ${Array.from({ length: count }, (_, index) => `<th scope="col">${escapeHtml(columnLabel9(index))}</th>`).join("")}
        </tr>
      </thead>
      <tbody>${bodyRows}</tbody>
    </table>
  `;
}
function tableTruncationNote9(table) {
  const truncated = table.sheets.some((sheet) => sheet.truncatedRows || sheet.truncatedColumns);
  return truncated ? `<div class="office-preview-note">表格较大，右侧栏和放大预览会限制最多显示的行列。</div>` : "";
}
function maxVisibleColumns9(rows) {
  return rows.reduce((max, row) => Math.max(max, row.length), 0);
}
function columnLabel9(index) {
  let value = Number(index) + 1;
  let out = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    out = String.fromCharCode(65 + remainder) + out;
    value = Math.floor((value - 1) / 26);
  }
  return out;
}
function renderSheetPreviewHtml9(content) {
  const lines = String(content ?? "").split(/\r?\n/);
  const sections = [];
  let current = null;
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
  return sections.filter((section) => section.rows.length > 0).slice(0, 5).map((section) => `
      <section class="office-sheet">
        <h3>${escapeHtml(section.title.replace(/\s+\([^)]+\)$/, ""))}</h3>
        <dl>
          ${section.rows.slice(0, 80).map(renderSheetCellHtml9).join("")}
        </dl>
      </section>
    `).join("") || `<pre class="office-text-preview">${escapeHtml(content)}</pre>`;
}
function renderSheetCellHtml9(line) {
  const match = String(line).match(/^([^:]{1,12}):\s*([\s\S]*)$/);
  if (!match) {
    return `<div class="office-cell"><dt></dt><dd>${escapeHtml(line)}</dd></div>`;
  }
  return `<div class="office-cell"><dt>${escapeHtml(match[1])}</dt><dd>${escapeHtml(match[2])}</dd></div>`;
}
function resetPreview2(message = "任务产物会显示在这里") {
  els.previewBody.className = "preview-body";
  els.previewBody.innerHTML = `<div class="preview-placeholder">${escapeHtml(message)}</div>`;
}
function fencedDataForFile9(file) {
  const language = dataLanguageForExtension9(file.extension);
  return `\`\`\`${language}
${file.content ?? ""}
\`\`\``;
}
function dataLanguageForExtension9(extension) {
  const ext = String(extension ?? "").toLowerCase();
  if (ext === ".yaml" || ext === ".yml") return "yaml";
  if (ext === ".csv") return "csv";
  if (ext === ".tsv") return "tsv";
  return "json";
}
function showImageLightbox9(file, items = null, index = 0) {
  const returnFocus = document.activeElement;
  const gallery = Array.isArray(items) && items.length > 0 ? items : [file];
  state.lightboxItems = gallery;
  state.lightboxIndex = Math.max(0, Math.min(index, gallery.length - 1));
  renderLightboxImage9();
  els.imageLightbox.classList.remove("hidden");
  document.body.classList.add("lightbox-opened");
  activateModal(els.imageLightbox, { initialFocus: "#lightbox-close", returnFocus });
}
function showTableLightbox9(file) {
  const returnFocus = document.activeElement;
  state.lightboxItems = [{
    type: "table",
    name: file.name,
    rawUrl: file.rawUrl ?? rawFileUrl9(file.relativePath),
    table: normalizeTablePreview9(file.table)
  }];
  state.lightboxIndex = 0;
  state.tableLightboxSheetIndex = 0;
  renderLightboxImage9();
  els.imageLightbox.classList.remove("hidden");
  document.body.classList.add("lightbox-opened");
  activateModal(els.imageLightbox, { initialFocus: "#lightbox-close", returnFocus });
}
function renderLightboxImage9() {
  const file = state.lightboxItems[state.lightboxIndex] ?? { type: "", name: "", rawUrl: "", table: void 0 };
  const isTable = file.type === "table";
  els.imageLightbox.dataset.mode = isTable ? "table" : "image";
  els.lightboxTitle.textContent = file.name || (isTable ? "表格预览" : "图片预览");
  els.lightboxOpen.href = file.rawUrl ?? "#";
  els.lightboxImage.classList.toggle("hidden", isTable);
  els.lightboxTable.classList.toggle("hidden", !isTable);
  if (isTable) {
    els.lightboxImage.removeAttribute("src");
    if (els.lightboxImage instanceof HTMLImageElement) els.lightboxImage.alt = "";
    els.lightboxTable.innerHTML = renderExpandedTableHtml9(normalizeTablePreview9(file.table), state.tableLightboxSheetIndex);
    bindTableLightboxControls9();
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
function bindTableLightboxControls9() {
  els.lightboxTable.querySelectorAll("[data-sheet-index]").forEach((button) => {
    button.addEventListener("click", () => {
      state.tableLightboxSheetIndex = Number(button.dataset.sheetIndex) || 0;
      renderLightboxImage9();
    });
  });
}
function moveLightbox(delta) {
  if (els.imageLightbox.classList.contains("hidden") || state.lightboxItems.length <= 1) {
    return;
  }
  const total = state.lightboxItems.length;
  state.lightboxIndex = (state.lightboxIndex + delta + total) % total;
  renderLightboxImage9();
}
function hideLightbox() {
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
function setPermissionMode(mode) {
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
  els.modeDescription.textContent = state.goal?.enabled ? MODE_DESCRIPTIONS.goal : MODE_DESCRIPTIONS[mode] ?? MODE_DESCRIPTIONS.plan;
  updateContextActions();
  renderGoalControls();
}
function clearTranscript2() {
  cancelTranscriptAnimationFrames8();
  resetTranscriptWindow4();
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
  updateTranscriptJump9();
}
function cancelTranscriptAnimationFrames8() {
  clearAssistantDraftTimers9();
  cancelScheduledAnimationFrame(state, "transcriptScrollFrame");
  state.transcriptScrollForce = false;
}
function clearAssistantDraftTimers9() {
  for (const draft of state.assistantDrafts.values()) {
    cancelScheduledAnimationFrame(draft, "renderFrame");
  }
}
function hideEmptyState3() {
  els.emptyState.classList.add("hidden");
}
function showError(message) {
  hideEmptyState3();
  appendActivity2({
    title: "发生错误",
    detail: message ?? "",
    severity: "danger",
    collapsed: false
  });
}
function showNotice7(message, detail = "本地配置已更新") {
  hideEmptyState3();
  appendActivity2({
    title: message,
    detail: detail == null ? "本地配置已更新" : String(detail),
    severity: "info",
    collapsed: false
  });
}
function renderBootstrapLoading() {
  els.projectPath.textContent = "正在连接";
  els.runStatus.textContent = "连接中";
  els.sendButton.disabled = true;
  setConnectionState("connecting");
}
function renderBootstrapFailure(error) {
  const failure2 = bootstrapFailurePresentation9(error, navigator.onLine !== false);
  setConnectionState(failure2.connectionState);
  els.projectPath.textContent = failure2.projectLabel;
  els.runStatus.textContent = "初始化失败";
  els.sendButton.disabled = true;
  cancelTranscriptAnimationFrames8();
  resetTranscriptWindow4();
  els.transcript.innerHTML = `
      <div class="empty-state bootstrap-error">
        <div class="empty-kicker">Ant Code Dashboard</div>
      <div class="empty-title">${escapeHtml(failure2.title)}</div>
      <div class="empty-copy">${escapeHtml(failure2.message)}</div>
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
function dashboardPayloadError(payload, fallback) {
  const error = new Error(String(payload?.error ?? fallback));
  for (const key of ["code", "status", "requestId", "configPath"]) {
    if (payload?.[key] !== void 0) Object.defineProperty(error, key, { value: payload[key] });
  }
  return error;
}
function bootstrapFailurePresentation9(error, online = true) {
  const issue = isPlainObject(error) ? error : {};
  const message = error instanceof Error ? error.message : String(error ?? "Dashboard 初始化失败");
  const code = String(issue.code ?? "").trim();
  const status = Number(issue.status);
  const serverResponded = Boolean(code) || Number.isInteger(status) && status >= 400;
  const requestId = /^[A-Za-z0-9_-]{8,128}$/.test(String(issue.requestId ?? "")) ? String(issue.requestId) : "";
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
function clearBootstrapStatus() {
  if (state.connectionState === "connecting" && !state.currentSessionId) {
    setConnectionState("idle");
  }
}
function scrollTranscript2(options = {}) {
  if (!shouldFollowTranscript({
    force: options.force,
    following: state.transcriptFollowing,
    onlyIfNearBottom: options.onlyIfNearBottom,
    wasAtBottom: options.wasAtBottom
  })) {
    state.transcriptFollowing = false;
    state.newReplyAvailable = true;
    updateTranscriptJump9();
    return;
  }
  state.transcriptFollowing = true;
  state.newReplyAvailable = false;
  state.transcriptScrollForce = state.transcriptScrollForce || options.force === true;
  updateTranscriptJump9();
  scheduleAnimationFrameOnce(state, "transcriptScrollFrame", () => {
    const force = state.transcriptScrollForce;
    state.transcriptScrollForce = false;
    if (!force && !state.transcriptFollowing) {
      updateTranscriptJump9();
      return;
    }
    els.transcript.scrollTop = els.transcript.scrollHeight;
    updateTranscriptJump9();
  });
}
function isTranscriptNearBottom3(threshold = 96) {
  const limit = Number(threshold);
  return els.transcript.scrollHeight - els.transcript.scrollTop - els.transcript.clientHeight <= (Number.isFinite(limit) ? limit : 96);
}
function syncTranscriptFollowState3() {
  const nearBottom = isTranscriptNearBottom3();
  state.transcriptFollowing = nearBottom;
  if (nearBottom) state.newReplyAvailable = false;
  updateTranscriptJump9();
}
function followTranscript() {
  state.transcriptFollowing = true;
  state.newReplyAvailable = false;
  scrollTranscript2({ force: true });
}
function updateTranscriptJump9() {
  if (!els.transcriptJump) return;
  const visible = !state.transcriptFollowing;
  els.transcriptJump.classList.toggle("hidden", !visible);
  els.transcriptJump.textContent = state.newReplyAvailable ? "有新回复" : "回到底部";
  els.transcriptJump.setAttribute("aria-label", state.newReplyAvailable ? "有新回复，回到底部" : "回到底部");
}
function beginScopedRequest(scope, key = "") {
  cancelScopedRequest2(scope);
  const controller = new AbortController();
  const request = { scope, key, controller, signal: controller.signal };
  state.requestScopes.set(scope, request);
  return request;
}
function isCurrentScopedRequest(request) {
  return Boolean(request) && state.requestScopes.get(request.scope) === request && !request.signal.aborted;
}
function finishScopedRequest(request) {
  if (state.requestScopes.get(request?.scope) === request) {
    state.requestScopes.delete(request.scope);
  }
}
function cancelScopedRequest2(scope) {
  const request = state.requestScopes.get(scope);
  if (!request) return;
  state.requestScopes.delete(scope);
  if (!request.signal.aborted) {
    request.controller.abort();
  }
}
function isAbortError(error) {
  if (!error || typeof error !== "object") {
    return false;
  }
  const record = error;
  return record.name === "AbortError" || record.code === "ABORT_ERR";
}
async function getJson(url, options = {}) {
  return dashboardFetch9(url, {
    credentials: "same-origin",
    signal: options.signal
  }, options);
}
async function postJson(url, body, options = {}) {
  return dashboardFetch9(url, {
    method: "POST",
    credentials: "same-origin",
    headers: dashboardJsonHeaders9(),
    body: JSON.stringify(body),
    signal: options.signal
  }, options);
}
async function deleteJson2(url, body = {}, options = {}) {
  return dashboardFetch9(url, {
    method: "DELETE",
    credentials: "same-origin",
    headers: dashboardJsonHeaders9(),
    body: JSON.stringify(body),
    signal: options.signal
  }, options);
}
async function dashboardFetch9(url, init11 = {}, options = {}) {
  const timeoutMs = options.timeoutMs === null ? null : Number.isFinite(Number(options.timeoutMs)) ? Math.max(1, Number(options.timeoutMs)) : DASHBOARD_REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  let timer = null;
  const callerSignal = options.signal instanceof AbortSignal ? options.signal : void 0;
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
    const response = await fetch(url, { ...init11, signal: controller.signal });
    return await responseJson9(response);
  } catch (error) {
    if (timedOut) {
      const timeoutError = new Error(`请求超时（${Math.ceil((typeof timeoutMs === "number" ? timeoutMs : DASHBOARD_REQUEST_TIMEOUT_MS) / 1e3)} 秒）`);
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
async function responseJson9(response) {
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { ok: false, error: `服务返回了无效响应（HTTP ${response.status}）` };
  }
  if (!response.ok) {
    return { ...payload, ok: false, status: payload.status ?? response.status, error: payload.error ?? `HTTP ${response.status}` };
  }
  return payload;
}
function dashboardJsonHeaders9() {
  return {
    "content-type": "application/json",
    "x-antcode-csrf-token": dashboardCsrfToken9()
  };
}
function dashboardCsrfToken9() {
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
function messageText9(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((item) => {
    if (typeof item === "string") return item;
    if (item && typeof item === "object" && "text" in item) return item.text ?? "";
    return "";
  }).join("");
}
function messageDisplayText3(content) {
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
      lines.push(imageAttachmentLine9(item));
    }
  }
  return lines.filter(Boolean).join("\n");
}
function userMessageDisplayText3(text, attachments = []) {
  const lines = [String(text ?? "").trim()].filter(Boolean);
  const imageLines = normalizeAttachmentMetadata9(attachments).map(imageAttachmentLine9);
  return [...lines, ...imageLines].join("\n");
}
function normalizeAttachmentMetadata9(attachments) {
  if (!Array.isArray(attachments)) {
    return [];
  }
  return attachments.filter((item) => item && typeof item === "object" && item.type === "image").map((item) => ({
    type: "image",
    name: String(item.name ?? "image"),
    mimeType: String(item.mimeType ?? item.mime_type ?? "image"),
    size: Number.isFinite(Number(item.size)) ? Number(item.size) : Number(item.bytes ?? item.sizeBytes ?? 0)
  }));
}
function imageAttachmentLine9(item) {
  const parts = [
    item.name ? String(item.name) : "image",
    item.mimeType ? String(item.mimeType) : "",
    Number.isFinite(Number(item.size)) && Number(item.size) > 0 ? formatBytes9(item.size) : ""
  ].filter(Boolean);
  return `[图片附件：${parts.join(" · ")}]`;
}
function renderMessageText(node, text, options = {}) {
  if (!node) return;
  node.classList.toggle("markdown-body", options.markdown === true);
  const html = options.markdown ? renderMarkdown(text ?? "", { basePath: options.basePath, lightweight: options.lightweight === true }) : escapeHtml(text ?? "");
  node.innerHTML = html;
  if (!options.lightweight) {
    linkifyFileTextNodes9(node, options.basePath);
  }
  bindRichContent9(node, { lightweight: options.lightweight === true });
}
function renderLinkedText9(node, text) {
  node.textContent = text ?? "";
  linkifyFileTextNodes9(node);
  bindRichContent9(node);
}

// src/dashboard/public/structured-data.ts
var INITIAL_TREE_DEPTH = 2;
var MAX_TREE_DEPTH = 12;
var MAX_TREE_ITEMS = 80;
var MAX_TREE_NODES = 400;
var MAX_TABLE_ROWS = 200;
var MAX_TABLE_COLUMNS = 50;
var MAX_CELL_CHARS = 160;
var MAX_COPY_BYTES = 256 * 1024;
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function asRecord(value) {
  return isRecord(value) ? value : {};
}
function renderStructuredData(kind, source, vendor = {}) {
  const normalized = String(kind ?? "").toLowerCase();
  if (normalized === "json") {
    return renderJson(source);
  }
  if (normalized === "yaml" || normalized === "yml") {
    return renderYaml(source, vendor);
  }
  if (normalized === "csv" || normalized === "tsv") {
    return renderDelimited(source, normalized === "tsv" ? "	" : ",", normalized.toUpperCase());
  }
  return failure("暂不支持这种数据格式");
}
function renderJson(source) {
  try {
    const value = JSON.parse(String(source ?? ""));
    const tree = createTreeRenderer(value);
    return success(`${summaryForValue(value)} · JSON`, tree.html, {
      expandTreeNode: tree.expand
    });
  } catch (error) {
    return failure(`JSON 解析失败：${errorMessage(error)}`);
  }
}
function renderYaml(source, vendor) {
  try {
    const parseYaml = vendor.parseYaml;
    if (typeof parseYaml !== "function") {
      return failure("YAML 渲染器尚未加载");
    }
    const value = parseYaml(String(source ?? ""));
    const tree = createTreeRenderer(value);
    return success(`${summaryForValue(value)} · YAML`, tree.html, {
      expandTreeNode: tree.expand
    });
  } catch (error) {
    return failure(`YAML 解析失败：${errorMessage(error)}`);
  }
}
function renderDelimited(source, delimiter, label) {
  const parsed = parseDelimited(source, delimiter);
  if (!parsed.ok) {
    return failure(`${label} 解析失败：${parsed.error}`);
  }
  const rows = parsed.rows;
  if (rows.length === 0) {
    return success(`0 行 · ${label}`, `<div class="data-empty">没有可预览的数据</div>`);
  }
  const allHeaders = rows[0].map((cell, index) => cell || `列 ${index + 1}`);
  const headers = allHeaders.slice(0, MAX_TABLE_COLUMNS);
  const bodyRows = rows.slice(1, MAX_TABLE_ROWS + 1);
  const rowsTruncated = rows.length - 1 > bodyRows.length;
  const columnsTruncated = allHeaders.length > headers.length;
  const copy = boundedTsv([headers, ...bodyRows.map((row) => row.slice(0, headers.length))]);
  const table = [
    `<div class="data-table-wrap"><table class="data-table"><thead><tr>${headers.map((header) => `<th>${escapeHtml4(truncateCell(header))}</th>`).join("")}</tr></thead><tbody>`,
    bodyRows.map((row) => `<tr>${headers.map((_, index) => `<td>${escapeHtml4(truncateCell(row[index] ?? ""))}</td>`).join("")}</tr>`).join(""),
    `</tbody></table></div>`,
    rowsTruncated ? `<div class="data-note">已显示前 ${bodyRows.length} 行，共 ${rows.length - 1} 行数据。</div>` : "",
    columnsTruncated ? `<div class="data-note">已显示前 ${headers.length} 列，共 ${allHeaders.length} 列。</div>` : "",
    copy.truncated ? `<div class="data-note">复制内容已限制为 ${formatBytes10(MAX_COPY_BYTES)}。</div>` : ""
  ].join("");
  return success(`${rows.length - 1} 行 · ${allHeaders.length} 列 · ${label}`, table, { tsv: copy.text });
}
function createTreeRenderer(root) {
  const deferred = /* @__PURE__ */ new Map();
  let nextDeferredId = 1;
  let renderedNodes = 0;
  function renderValue(value, depth, eagerUntil, ancestors = /* @__PURE__ */ new Set()) {
    if (renderedNodes >= MAX_TREE_NODES) {
      return nodeBudgetNote();
    }
    renderedNodes += 1;
    if (value === null || typeof value !== "object") {
      return `<span class="data-scalar ${scalarClass(value)}">${escapeHtml4(formatScalar(value))}</span>`;
    }
    if (ancestors.has(value)) {
      return `<span class="data-note data-cycle">检测到循环引用，已停止展开。</span>`;
    }
    if (depth >= MAX_TREE_DEPTH) {
      return `<span class="data-note data-depth-limit">已达到 ${MAX_TREE_DEPTH} 层预览上限（${escapeHtml4(summaryForValue(value))}）。</span>`;
    }
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(value);
    if (depth >= eagerUntil) {
      const id = `tree-${nextDeferredId}`;
      nextDeferredId += 1;
      deferred.set(id, { value, depth, ancestors: nextAncestors });
      return `<details class="data-node data-node-deferred" data-tree-node="${id}"><summary>${escapeHtml4(summaryForValue(value))}</summary><div class="data-tree data-tree-placeholder"><span class="data-note">展开后加载下一层。</span></div></details>`;
    }
    return renderNode(value, depth, eagerUntil, nextAncestors, true);
  }
  function renderNode(value, depth, eagerUntil, ancestors, open) {
    const isArray = Array.isArray(value);
    const entries = isArray ? value.map((item, index) => [String(index), item]) : Object.entries(asRecord(value));
    const visible = entries.slice(0, MAX_TREE_ITEMS);
    const rows = [];
    for (const [key, item] of visible) {
      if (renderedNodes >= MAX_TREE_NODES) {
        rows.push(nodeBudgetNote());
        break;
      }
      rows.push(`
        <div class="data-tree-row">
          <span class="data-key">${escapeHtml4(isArray ? `[${key}]` : key)}</span>
          <span class="data-value">${renderValue(item, depth + 1, eagerUntil, ancestors)}</span>
        </div>
      `);
    }
    const overflow = entries.length > visible.length ? `<div class="data-note">还有 ${entries.length - visible.length} 项未渲染。</div>` : "";
    return `<details class="data-node"${open ? " open" : ""}><summary>${escapeHtml4(summaryForValue(value))}</summary><div class="data-tree">${rows.join("")}${overflow}</div></details>`;
  }
  function expand(id) {
    const entry = deferred.get(String(id ?? ""));
    if (!entry) {
      return `<span class="data-note">该数据层已加载或不可用。</span>`;
    }
    deferred.delete(String(id));
    if (renderedNodes >= MAX_TREE_NODES) {
      return nodeBudgetNote();
    }
    const wrapper = renderNode(entry.value, entry.depth, entry.depth + 1, entry.ancestors, false);
    const match = wrapper.match(/<div class="data-tree">([\s\S]*)<\/div><\/details>$/);
    return match ? match[1] : nodeBudgetNote();
  }
  return {
    html: renderValue(root, 0, INITIAL_TREE_DEPTH),
    expand
  };
}
function nodeBudgetNote() {
  return `<span class="data-note data-node-limit">已达到 ${MAX_TREE_NODES} 个节点的预览上限。</span>`;
}
function summaryForValue(value) {
  if (Array.isArray(value)) {
    return `数组 · ${value.length} 项`;
  }
  if (value && typeof value === "object") {
    return `对象 · ${Object.keys(value).length} 字段`;
  }
  return `值 · ${typeof value}`;
}
function scalarClass(value) {
  if (value === null) return "is-null";
  if (typeof value === "number") return "is-number";
  if (typeof value === "boolean") return "is-boolean";
  return "is-string";
}
function formatScalar(value) {
  if (typeof value === "string") {
    return value.length > MAX_CELL_CHARS ? `${value.slice(0, MAX_CELL_CHARS)}...` : `"${value}"`;
  }
  return String(value);
}
function parseDelimited(source, delimiter) {
  const text = String(source ?? "").replace(/\r\n?/g, "\n");
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === delimiter) {
      row.push(cell);
      cell = "";
      continue;
    }
    if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += char;
  }
  if (quoted) {
    return { ok: false, error: "引号没有闭合" };
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return { ok: true, rows: rows.filter((item) => item.some((cellValue) => String(cellValue).trim())) };
}
function boundedTsv(rows) {
  const lines = [];
  let bytes = 0;
  let truncated = false;
  for (const row of rows) {
    const line = row.map((cell) => truncateCell(cell).replace(/\t/g, " ").replace(/\r?\n/g, " ")).join("	");
    const separatorBytes = lines.length > 0 ? 1 : 0;
    const lineBytes = utf8Bytes(line);
    if (bytes + separatorBytes + lineBytes > MAX_COPY_BYTES) {
      truncated = true;
      break;
    }
    lines.push(line);
    bytes += separatorBytes + lineBytes;
  }
  return { text: lines.join("\n"), truncated };
}
function utf8Bytes(value) {
  return new TextEncoder().encode(String(value ?? "")).byteLength;
}
function formatBytes10(value) {
  return `${Math.round(value / 1024)} KiB`;
}
function truncateCell(value) {
  const text = String(value ?? "");
  return text.length > MAX_CELL_CHARS ? `${text.slice(0, MAX_CELL_CHARS)}...` : text;
}
function success(summary, html, extra = {}) {
  return { ok: true, summary, html, ...extra };
}
function failure(error) {
  return { ok: false, error, html: `<div class="data-error">${escapeHtml4(error)}</div>` };
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function escapeHtml4(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// src/dashboard/public/rich-renderers.ts
var vendorPromise = null;
var mermaidCounter = 0;
async function hydrateRichContent(root) {
  hydrateRawToggles(root);
  hydrateImageGalleries(root);
  await hydrateMath(root);
  await hydrateData(root);
  await hydrateMermaid(root);
  hydrateToc(root);
}
function hydrateImageGalleries(root) {
  const parents = new Set(Array.from(root.querySelectorAll(".md-image-button")).map((button) => button.parentElement).filter(Boolean));
  for (const parent of parents) {
    const images = parent.querySelectorAll(":scope > .md-image-button");
    parent.classList.toggle("md-image-gallery", images.length > 1);
  }
}
function hydrateRawToggles(root) {
  root.querySelectorAll(".md-toggle-raw").forEach((button) => {
    if (button.dataset.bound === "true") {
      return;
    }
    button.dataset.bound = "true";
    button.addEventListener("click", () => {
      const frame = button.closest(".md-mermaid-frame, .md-data-frame");
      const raw = frame?.querySelector(".md-raw-source");
      const rendered = frame?.querySelector(".md-mermaid-output, .md-data-output");
      if (!raw || !rendered) {
        return;
      }
      const showingRaw = raw.classList.toggle("hidden");
      rendered.classList.toggle("hidden", !showingRaw);
      button.textContent = showingRaw ? "查看原文" : "查看预览";
    });
  });
}
async function hydrateMath(root) {
  const targets = Array.from(root.querySelectorAll("[data-math-source]")).filter((node) => node.dataset.rendered !== "true");
  if (targets.length === 0) {
    return;
  }
  const vendor = await loadVendor().catch(() => null);
  for (const node of targets) {
    const source = node.dataset.mathSource ?? "";
    const displayMode = node.dataset.mathDisplay === "true";
    const output = displayMode ? node.querySelector(".md-math-output") ?? node : node;
    if (!vendor?.renderMath) {
      markMathFailure(output, source);
      continue;
    }
    try {
      output.innerHTML = vendor.renderMath(source, { displayMode });
      node.dataset.rendered = "true";
    } catch {
      markMathFailure(output, source);
    }
  }
}
async function hydrateData(root) {
  const frames = Array.from(root.querySelectorAll(".md-data-frame")).filter((node) => node.dataset.rendered !== "true");
  if (frames.length === 0) {
    return;
  }
  const vendor = await loadVendor().catch(() => ({}));
  for (const frame of frames) {
    const kind = frame.dataset.dataKind ?? "";
    const raw = frame.querySelector(".md-raw-source code")?.textContent ?? "";
    const output = frame.querySelector(".md-data-output");
    if (!output) {
      continue;
    }
    const result = renderStructuredData(kind, raw, vendor);
    output.innerHTML = result.ok ? `<div class="data-summary">${escapeHtml5(result.summary)}</div>${result.html}${result.tsv ? `<button type="button" class="data-copy" data-copy-tsv="${escapeAttribute8(result.tsv)}">复制为 TSV</button>` : ""}` : result.html;
    bindDeferredTree(output, result.ok ? result.expandTreeNode : void 0);
    frame.dataset.rendered = "true";
    output.querySelectorAll(".data-copy").forEach((button) => {
      button.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(button.dataset.copyTsv ?? "");
          button.textContent = "已复制";
          setTimeout(() => {
            button.textContent = "复制为 TSV";
          }, 1200);
        } catch {
          button.textContent = "复制失败";
          setTimeout(() => {
            button.textContent = "复制为 TSV";
          }, 1400);
        }
      });
    });
  }
}
function bindDeferredTree(root, expandTreeNode) {
  if (typeof expandTreeNode !== "function") {
    return;
  }
  const expand = expandTreeNode;
  root.addEventListener("toggle", (event) => {
    const node = event.target;
    if (!node?.open || !node.classList?.contains("data-node-deferred")) {
      return;
    }
    const placeholder = node.querySelector(":scope > .data-tree-placeholder");
    if (!placeholder) {
      return;
    }
    placeholder.innerHTML = expand(node.dataset.treeNode);
    placeholder.classList.remove("data-tree-placeholder");
    node.classList.remove("data-node-deferred");
    delete node.dataset.treeNode;
  }, true);
}
async function hydrateMermaid(root) {
  const frames = Array.from(root.querySelectorAll(".md-mermaid-output")).filter((node) => node.dataset.rendered !== "true");
  if (frames.length === 0) {
    return;
  }
  const vendor = await loadVendor().catch(() => null);
  for (const output of frames) {
    const source = output.dataset.mermaidSource ?? "";
    if (!vendor?.renderMermaid) {
      markMermaidFailure(output);
      continue;
    }
    try {
      const rendered = await vendor.renderMermaid(source, `dashboard-mermaid-${++mermaidCounter}`);
      output.innerHTML = rendered.svg;
      output.dataset.rendered = "true";
    } catch {
      markMermaidFailure(output);
    }
  }
}
function hydrateToc(root) {
  root.querySelectorAll(".md-toc a").forEach((link) => {
    if (link.dataset.bound === "true") {
      return;
    }
    link.dataset.bound = "true";
    link.addEventListener("click", (event) => {
      const href = link.getAttribute("href") ?? "";
      if (!href.startsWith("#")) {
        return;
      }
      const escapeSelector = globalThis.CSS?.escape;
      const target = root.querySelector(escapeSelector ? `#${escapeSelector(href.slice(1))}` : href);
      if (!target) {
        return;
      }
      event.preventDefault();
      target.scrollIntoView({ block: "start", behavior: "smooth" });
    });
  });
}
function markMathFailure(output, source) {
  output.innerHTML = `<code>${escapeHtml5(source)}</code><span class="rich-error">公式无法渲染</span>`;
}
function markMermaidFailure(output) {
  output.textContent = "流程图无法渲染，可查看原文。";
  output.classList.add("rich-error");
  output.dataset.rendered = "true";
}
function loadVendor() {
  if (!vendorPromise) {
    vendorPromise = import("./vendor/rich-renderers.js");
  }
  return vendorPromise;
}
function escapeHtml5(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function escapeAttribute8(value) {
  return escapeHtml5(value).replace(/`/g, "&#96;");
}

// src/dashboard/public/app-ui10.ts
function bindRichContent9(node, options = {}) {
  node.querySelectorAll("[data-file]").forEach((link) => {
    if (!(link instanceof HTMLElement)) {
      return;
    }
    link.addEventListener("click", () => openFile9(link.dataset.file ?? ""));
  });
  node.querySelectorAll("[data-image-src]").forEach((button) => {
    const rawUrl = imagePreviewUrl10(button.dataset.imageSrc ?? "");
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
        rawUrl: item.dataset.imageRawUrl || imagePreviewUrl10(item.dataset.imageSrc ?? "")
      })).filter((item) => item.rawUrl);
      const index = Math.max(0, imageButtons.indexOf(button));
      showImageLightbox9({
        name: button.dataset.imageAlt || "图片预览",
        rawUrl: button.dataset.imageRawUrl || imagePreviewUrl10(button.dataset.imageSrc ?? "")
      }, items, index);
    });
  });
  node.querySelectorAll(".md-copy-code").forEach((button) => {
    button.addEventListener("click", () => copyCodeBlock10(button));
  });
  if (!options.lightweight) {
    hydrateRichContent(node);
  }
}
function linkifyFileTextNodes9(root, basePath = "") {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || parent.closest("a, button, code, pre")) {
        return NodeFilter.FILTER_REJECT;
      }
      FILE_REFERENCE_PATTERN.lastIndex = 0;
      return FILE_REFERENCE_PATTERN.test(node.nodeValue ?? "") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    }
  });
  const nodes = [];
  while (walker.nextNode()) {
    if (walker.currentNode instanceof CharacterData) nodes.push(walker.currentNode);
  }
  for (const textNode of nodes) {
    replaceFileReferences10(textNode, basePath);
  }
}
function replaceFileReferences10(textNode, basePath = "") {
  const text = textNode.nodeValue ?? "";
  const fragment = document.createDocumentFragment();
  let lastIndex = 0;
  FILE_REFERENCE_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(FILE_REFERENCE_PATTERN)) {
    const value = match[0];
    const index = match.index ?? 0;
    if (!isLikelyLocalFileReference10(value)) {
      continue;
    }
    if (index > lastIndex) {
      fragment.append(document.createTextNode(text.slice(lastIndex, index)));
    }
    const button = document.createElement("button");
    button.className = "file-link";
    button.type = "button";
    button.dataset.file = resolveDisplayFilePath10(value, basePath);
    button.textContent = value;
    fragment.append(button);
    lastIndex = index + value.length;
  }
  if (lastIndex < text.length) {
    fragment.append(document.createTextNode(text.slice(lastIndex)));
  }
  textNode.replaceWith(fragment);
}
function isLikelyLocalFileReference10(value) {
  const withoutLine = normalizeFileReferencePath10(value);
  const extension = withoutLine.split(".").pop()?.toLowerCase() ?? "";
  return LOCAL_FILE_EXTENSIONS.has(extension);
}
function resolveDisplayFilePath10(value, basePath = "") {
  const path = String(value ?? "").trim().replace(/\\/g, "/");
  const base = String(basePath ?? "").trim().replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (!path || !base || path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("../")) {
    return path;
  }
  const normalizedPath = path.replace(/^\.\/+/, "");
  if (isWorkspaceRelativeToBase11(normalizedPath, base)) {
    return normalizeRelativePath11(normalizedPath);
  }
  return normalizeRelativePath11(`${base}/${normalizedPath}`);
}
function normalizeFileReferencePath10(value) {
  return String(value ?? "").replace(/:\d+$/, "");
}
function parentDirectory9(filePath) {
  const normalized = String(filePath ?? "").replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  if (index <= 0) {
    return "";
  }
  return normalized.slice(0, index);
}
function filePreviewUrl9(filePath) {
  return apiFileUrl10("/api/files", filePath);
}
function rawFileUrl9(filePath) {
  return apiFileUrl10("/api/files/raw", filePath);
}
function apiFileUrl10(endpoint, filePath) {
  const params = new URLSearchParams();
  params.set("path", normalizeFileReferencePath10(filePath));
  if (state.currentSessionId) {
    params.set("sessionId", state.currentSessionId);
  }
  return `${endpoint}?${params.toString()}`;
}
function imagePreviewUrl10(src) {
  const value = String(src ?? "").trim();
  if (!value) {
    return "";
  }
  if (/^data:/i.test(value)) {
    return isSafeInlineBitmapUrl10(value) ? value : "";
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
  return rawFileUrl9(value.replace(/^\.\//, ""));
}
function isSafeInlineBitmapUrl10(value) {
  const match = String(value ?? "").match(/^data:image\/(png|jpeg|gif|webp);base64,([a-z0-9+/]+={0,2})$/i);
  if (!match || match[2].length % 4 !== 0) {
    return false;
  }
  const padding = match[2].endsWith("==") ? 2 : match[2].endsWith("=") ? 1 : 0;
  const decodedBytes = match[2].length / 4 * 3 - padding;
  return decodedBytes > 0 && decodedBytes <= 2 * 1024 * 1024;
}
function normalizeRelativePath11(value) {
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
function isWorkspaceRelativeToBase11(value, basePath = "") {
  const firstBaseSegment = String(basePath ?? "").split("/").filter(Boolean)[0];
  return Boolean(firstBaseSegment) && String(value ?? "").startsWith(`${firstBaseSegment}/`);
}
async function copyCodeBlock10(button) {
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
function previewText8(value, max = 120) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  const limit = Number(max);
  const maxLength = Number.isFinite(limit) && limit > 0 ? limit : 120;
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}
function formatNumber9(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0";
  return number.toLocaleString();
}
function formatBytes9(value) {
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
function escapeHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function escapeAttribute2(value) {
  return escapeHtml(value);
}
function formatTime2(value) {
  if (!value) return "";
  const date = new Date(typeof value === "number" || value instanceof Date ? value : String(value));
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString();
}
function formatRelativeTime4(value) {
  if (!value) {
    return "";
  }
  const time = new Date(typeof value === "number" || value instanceof Date ? value : String(value)).getTime();
  if (!Number.isFinite(time)) {
    return "";
  }
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1e3));
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

// src/dashboard/public/app.ts
await init();
export {
  CURRENT_SESSION_STORAGE_KEY,
  DASHBOARD_API_VERSION,
  DASHBOARD_CLIENT_STORAGE_KEY,
  DASHBOARD_INTERRUPT_TIMEOUT_MS,
  DASHBOARD_LIFECYCLE_TIMEOUT_MS,
  DASHBOARD_REQUEST_TIMEOUT_MS,
  DASHBOARD_SHUTDOWN_TIMEOUT_MS,
  EVENT_CONNECT_TIMEOUT_MS,
  EVENT_RECONNECT_MAX_ATTEMPTS,
  EVENT_STALE_AFTER_MS,
  FILE_REFERENCE_PATTERN,
  FOCUSABLE_SELECTOR,
  LOCAL_FILE_EXTENSIONS,
  MANUAL_AGENT_MODEL_VALUE,
  MAX_IMAGE_ATTACHMENTS,
  MAX_IMAGE_ATTACHMENT_BYTES,
  MODE_DESCRIPTIONS,
  PREVIEW_WIDTH_DEFAULT,
  PREVIEW_WIDTH_MAX,
  PREVIEW_WIDTH_MIN,
  PREVIEW_WIDTH_STORAGE_KEY,
  PREVIEW_WORKSPACE_MIN,
  TRANSCRIPT_DOM_LIMIT,
  activateModal,
  activateQuestionReviewBackground8 as activateQuestionReviewBackground,
  addAttachmentFiles,
  adoptGoalRunResult,
  agentModelPickerHtml5 as agentModelPickerHtml,
  agentModelTiersSummary5 as agentModelTiersSummary,
  agentSettingsHtml5 as agentSettingsHtml,
  announceStatus,
  apiFileUrl10 as apiFileUrl,
  appendActivity2 as appendActivity,
  appendAgentModelOptions6 as appendAgentModelOptions,
  appendAssistantDraft3 as appendAssistantDraft,
  appendContextBoundary3 as appendContextBoundary,
  appendMessage3 as appendMessage,
  appendPlainDraftDelta,
  appendTranscriptNode3 as appendTranscriptNode,
  applyGatewayDiscoveredModel6 as applyGatewayDiscoveredModel,
  applyGoalSnapshot,
  applyIdleRunStatus2 as applyIdleRunStatus,
  applyPendingReasoningCapabilities5 as applyPendingReasoningCapabilities,
  applyProbedModel5 as applyProbedModel,
  applyReasoningCapabilityCandidate6 as applyReasoningCapabilityCandidate,
  applySuggestedGatewayUrl5 as applySuggestedGatewayUrl,
  armEventConnectTimer3 as armEventConnectTimer,
  armEventStaleTimer3 as armEventStaleTimer,
  attachmentPayload2 as attachmentPayload,
  backgroundCancelKey3 as backgroundCancelKey,
  backgroundSubagentCancellable4 as backgroundSubagentCancellable,
  backgroundSubagentCompactLabel4 as backgroundSubagentCompactLabel,
  backgroundSubagentCounts4 as backgroundSubagentCounts,
  backgroundSubagentDisplayStatus4 as backgroundSubagentDisplayStatus,
  backgroundSubagentMeta4 as backgroundSubagentMeta,
  backgroundSubagentTitle4 as backgroundSubagentTitle,
  backgroundSubagentVisible4 as backgroundSubagentVisible,
  beginEventTurn3 as beginEventTurn,
  beginPreviewResize,
  beginScopedRequest,
  bindEvents,
  bindRichContent9 as bindRichContent,
  bindTableLightboxControls9 as bindTableLightboxControls,
  bootstrapDashboard,
  bootstrapFailurePresentation9 as bootstrapFailurePresentation,
  cancelBackgroundSubagent,
  cancelQuestion2 as cancelQuestion,
  cancelQueuedTurn2 as cancelQueuedTurn,
  cancelScheduledAnimationFrame,
  cancelScopedRequest2 as cancelScopedRequest,
  cancelTranscriptAnimationFrames8 as cancelTranscriptAnimationFrames,
  canonicalSettingsField5 as canonicalSettingsField,
  captureTranscriptViewportAnchor3 as captureTranscriptViewportAnchor,
  changedSettingsFields5 as changedSettingsFields,
  clampedPreviewWidth,
  clearAssistantDraftTimers9 as clearAssistantDraftTimers,
  clearAssistantDrafts3 as clearAssistantDrafts,
  clearAttachments2 as clearAttachments,
  clearBackgroundSubagentStatus3 as clearBackgroundSubagentStatus,
  clearBootstrapStatus,
  clearEventConnectTimer3 as clearEventConnectTimer,
  clearEventReconnectTimer,
  clearEventStaleTimer3 as clearEventStaleTimer,
  clearModelConfigFailure6 as clearModelConfigFailure,
  clearPendingGuide2 as clearPendingGuide,
  clearReasoningCapabilityControls6 as clearReasoningCapabilityControls,
  clearTranscript2 as clearTranscript,
  closeActiveModal2 as closeActiveModal,
  closeEventSource,
  collapseAssistantDrafts3 as collapseAssistantDrafts,
  collapseCompletedActivities3 as collapseCompletedActivities,
  collectModalBackground2 as collectModalBackground,
  columnLabel9 as columnLabel,
  compactResultLine8 as compactResultLine,
  composerHeightFor,
  configMutationMetadata6 as configMutationMetadata,
  configRevisionConflictMessage7 as configRevisionConflictMessage,
  configScope5 as configScope,
  configuredReasoningEffort4 as configuredReasoningEffort,
  confirmTrust8 as confirmTrust,
  connectEvents3 as connectEvents,
  contextActionRequestOptions8 as contextActionRequestOptions,
  contextBoundaryText4 as contextBoundaryText,
  contextSummaryLine3 as contextSummaryLine,
  copyCodeBlock10 as copyCodeBlock,
  copySessionId2 as copySessionId,
  createMessageNode3 as createMessageNode,
  currentGatewayCatalogModels6 as currentGatewayCatalogModels,
  currentGatewayProbeResult6 as currentGatewayProbeResult,
  currentGatewayProfile5 as currentGatewayProfile,
  currentImageFiles9 as currentImageFiles,
  currentModelInfo4 as currentModelInfo,
  currentModelSelection4 as currentModelSelection,
  currentSessionNeedsModelSelection,
  currentWorkflowItem3 as currentWorkflowItem,
  dashboardClientId,
  dashboardCsrfToken9 as dashboardCsrfToken,
  dashboardFetch9 as dashboardFetch,
  dashboardJsonHeaders9 as dashboardJsonHeaders,
  dashboardPayloadError,
  dashboardRequestId,
  dataLanguageForExtension9 as dataLanguageForExtension,
  deactivateModal,
  deactivateQuestionReviewBackground8 as deactivateQuestionReviewBackground,
  defaultGoalMaxAutoContinues,
  deleteGatewayProfile5 as deleteGatewayProfile,
  deleteJson2 as deleteJson,
  deleteModel5 as deleteModel,
  deleteSession2 as deleteSession,
  disconnectEvents2 as disconnectEvents,
  els,
  emptyBackgroundSubagent,
  emptyGoalSnapshot,
  emptySessionStatus,
  enableGoalWithObjective,
  ensureEventsConnected,
  ensureReasoningEffortOptions6 as ensureReasoningEffortOptions,
  environmentGatewayDefaultNote5 as environmentGatewayDefaultNote,
  errorMessageOf,
  escapeAttribute2 as escapeAttribute,
  escapeHtml,
  eventElement,
  eventTargetOf,
  fencedDataForFile9 as fencedDataForFile,
  filePreviewUrl9 as filePreviewUrl,
  finishPreviewResize,
  finishQuestionSubmission8 as finishQuestionSubmission,
  finishScopedRequest,
  firstFiniteNumber8 as firstFiniteNumber,
  firstVisionModelId5 as firstVisionModelId,
  focusModalInitialTarget2 as focusModalInitialTarget,
  focusTrapTarget,
  followTranscript,
  formatBytes9 as formatBytes,
  formatContextUsage4 as formatContextUsage,
  formatNumber9 as formatNumber,
  formatRelativeTime4 as formatRelativeTime,
  formatTime2 as formatTime,
  formatTokenCount5 as formatTokenCount,
  gatewayCredentialAction6 as gatewayCredentialAction,
  gatewayProfileById4 as gatewayProfileById,
  gatewayProfileReadonlyLabel5 as gatewayProfileReadonlyLabel,
  gatewayRetryChipText4 as gatewayRetryChipText,
  gatewaySourceNote5 as gatewaySourceNote,
  gatewaySummary7 as gatewaySummary,
  gatewayUrlHint5 as gatewayUrlHint,
  gatewayUrlPlaceholder5 as gatewayUrlPlaceholder,
  getJson,
  guideButtonDisabled8 as guideButtonDisabled,
  guideButtonText8 as guideButtonText,
  guideButtonVisible8 as guideButtonVisible,
  guideCopy8 as guideCopy,
  guideSource2 as guideSource,
  guideTurn2 as guideTurn,
  guideTurnFromQueue8 as guideTurnFromQueue,
  handleActivity3 as handleActivity,
  handleAgentModelSelection5 as handleAgentModelSelection,
  handleBackgroundSubagentActivity3 as handleBackgroundSubagentActivity,
  handleDashboardEvent3 as handleDashboardEvent,
  handleGlobalKeydown,
  handleModelConfigChange,
  handleModelConfigInput,
  handleModelConfigModelIdChanged5 as handleModelConfigModelIdChanged,
  handleModelConfigPanelClick,
  handleModelPanelChange,
  handleModelPanelClick,
  handleModelStatusActivate,
  handleModelStatusKeydown,
  handlePermissionModeKeydown,
  handlePreviewResizeKeydown,
  handleReasoningEffortChange,
  handleResponsiveFileNavigation,
  handleSessionAction2 as handleSessionAction,
  handleSettingsClick,
  handleSettingsFormChange,
  handleSettingsRailClick,
  handleTranscriptScroll,
  hasAgentModelTiers7 as hasAgentModelTiers,
  hideApproval2 as hideApproval,
  hideContextConfirm2 as hideContextConfirm,
  hideEmptyState3 as hideEmptyState,
  hideGoalConfirm,
  hideGoalTextPanel,
  hideLightbox,
  hideModelConfigPanel2 as hideModelConfigPanel,
  hideModelPanel,
  hidePermissionConfirm,
  hideQuestion2 as hideQuestion,
  hideSettingsWorkspace,
  hideShutdownPanel,
  idleRunStatus3 as idleRunStatus,
  imageAttachmentLine9 as imageAttachmentLine,
  imagePreviewUrl10 as imagePreviewUrl,
  init,
  initialSessionId2 as initialSessionId,
  initializeAgentModelPickerSnapshot5 as initializeAgentModelPickerSnapshot,
  initializeSettingsFormTracking5 as initializeSettingsFormTracking,
  interruptTurn,
  isAbortError,
  isBackgroundSubagentActivity3 as isBackgroundSubagentActivity,
  isConfigRevisionConflict7 as isConfigRevisionConflict,
  isCurrentModelConfigRequest6 as isCurrentModelConfigRequest,
  isCurrentScopedRequest,
  isDisabledReasoningEffort6 as isDisabledReasoningEffort,
  isDuplicateDraftText8 as isDuplicateDraftText,
  isInterruptError3 as isInterruptError,
  isLikelyLocalFileReference10 as isLikelyLocalFileReference,
  isMeaningfulCompletedActivity4 as isMeaningfulCompletedActivity,
  isPlainObject,
  isProtectedTranscriptNode3 as isProtectedTranscriptNode,
  isSafeInlineBitmapUrl10 as isSafeInlineBitmapUrl,
  isTranscriptNearBottom3 as isTranscriptNearBottom,
  isWorkspaceRelativeToBase11 as isWorkspaceRelativeToBase,
  latestBackgroundSessionId2 as latestBackgroundSessionId,
  lifecycleActivitySummary8 as lifecycleActivitySummary,
  linkifyFileTextNodes9 as linkifyFileTextNodes,
  liveStatusTitle4 as liveStatusTitle,
  loadOlderTranscript3 as loadOlderTranscript,
  loadSessions,
  loadTrust,
  localizedReasoningEffortLabel7 as localizedReasoningEffortLabel,
  lockClosedDashboard8 as lockClosedDashboard,
  managedFieldHtml5 as managedFieldHtml,
  manualAgentModelIds6 as manualAgentModelIds,
  markCurrentModel2 as markCurrentModel,
  markEventConnectionAlive3 as markEventConnectionAlive,
  markModelConfigCredentialChanged5 as markModelConfigCredentialChanged,
  markModelConfigEndpointChanged5 as markModelConfigEndpointChanged,
  markReasoningCapabilityManual5 as markReasoningCapabilityManual,
  maxVisibleColumns9 as maxVisibleColumns,
  mergeGatewayConfig7 as mergeGatewayConfig,
  messageDisplayText3 as messageDisplayText,
  messageText9 as messageText,
  modalFocusableElements,
  modelCapabilityLabels5 as modelCapabilityLabels,
  modelConfigAgentModelsSnapshot5 as modelConfigAgentModelsSnapshot,
  modelConfigEndpointChanged6 as modelConfigEndpointChanged,
  modelConfigGatewayProfile6 as modelConfigGatewayProfile,
  modelDisplayName7 as modelDisplayName,
  modelSaveTargetLabel7 as modelSaveTargetLabel,
  modelSettingsHtml5 as modelSettingsHtml,
  modelSourceLabel4 as modelSourceLabel,
  modelSourceOf,
  modelStatusHtml4 as modelStatusHtml,
  moveLightbox,
  networkModeOptionHtml5 as networkModeOptionHtml,
  networkSettingsHtml5 as networkSettingsHtml,
  newTask,
  nonNegativeInteger4 as nonNegativeInteger,
  normalizeAgentModelTiers,
  normalizeAttachmentMetadata9 as normalizeAttachmentMetadata,
  normalizeChangeStats4 as normalizeChangeStats,
  normalizeComparableText3 as normalizeComparableText,
  normalizeConfigSource7 as normalizeConfigSource,
  normalizeDashboardSettings,
  normalizeFileReferencePath10 as normalizeFileReferencePath,
  normalizeGatewayConfig,
  normalizeGatewayProbeModels6 as normalizeGatewayProbeModels,
  normalizeGatewayProfiles,
  normalizeLifecycleActivity8 as normalizeLifecycleActivity,
  normalizeModelSource7 as normalizeModelSource,
  normalizeModels,
  normalizeReasoningDiscovery6 as normalizeReasoningDiscovery,
  normalizeReasoningEfforts4 as normalizeReasoningEfforts,
  normalizeRelativePath11 as normalizeRelativePath,
  normalizeScopedDefaultSelection7 as normalizeScopedDefaultSelection,
  normalizeTablePreview9 as normalizeTablePreview,
  normalizeVisionAgent,
  normalizeWorkflowStatus3 as normalizeWorkflowStatus,
  normalizedReasoningEffort6 as normalizedReasoningEffort,
  normalizedResponsiveView,
  observeRunStatus,
  officePreviewBodyHtml9 as officePreviewBodyHtml,
  officePreviewMeta9 as officePreviewMeta,
  openFile9 as openFile,
  openSession2 as openSession,
  parentDirectory9 as parentDirectory,
  permissionIndexForKey,
  postJson,
  previewText8 as previewText,
  previewWidthBounds,
  primaryLiveActivity4 as primaryLiveActivity,
  probeGateway5 as probeGateway,
  probeModelCapabilities5 as probeModelCapabilities,
  protocolDisplayName5 as protocolDisplayName,
  providerModelKey5 as providerModelKey,
  questionChoiceButton8 as questionChoiceButton,
  questionResolutionText3 as questionResolutionText,
  rawFileUrl9 as rawFileUrl,
  readImageAttachment2 as readImageAttachment,
  reasoningCapabilityCandidate6 as reasoningCapabilityCandidate,
  reasoningCapabilityIsActionable6 as reasoningCapabilityIsActionable,
  reasoningCapabilityStatusText6 as reasoningCapabilityStatusText,
  reasoningDiscoveryStatusText6 as reasoningDiscoveryStatusText,
  reasoningEffortCatalog5 as reasoningEffortCatalog,
  reasoningEffortFallbackLabel7 as reasoningEffortFallbackLabel,
  reasoningEffortLabel7 as reasoningEffortLabel,
  reconcileBackgroundSubagentSnapshot2 as reconcileBackgroundSubagentSnapshot,
  reconnectEventsManually,
  refreshConfigRevisionsAfterConflict7 as refreshConfigRevisionsAfterConflict,
  refreshNewTaskModelState2 as refreshNewTaskModelState,
  refreshSettingsConfiguration4 as refreshSettingsConfiguration,
  reliabilitySettingsHtml5 as reliabilitySettingsHtml,
  rememberCurrentSession,
  rememberEventCursor,
  rememberNewTaskModelState,
  rememberQuestionDraft8 as rememberQuestionDraft,
  removeLiveActivity4 as removeLiveActivity,
  removeTranscriptHistoryStatus3 as removeTranscriptHistoryStatus,
  renderAgentModelPickers5 as renderAgentModelPickers,
  renderAssistantDraft4 as renderAssistantDraft,
  renderAttachmentStrip2 as renderAttachmentStrip,
  renderBackgroundSubagentStatus4 as renderBackgroundSubagentStatus,
  renderBootstrapFailure,
  renderBootstrapLoading,
  renderCompactTableHtml9 as renderCompactTableHtml,
  renderComposerStatus,
  renderExpandedTableHtml9 as renderExpandedTableHtml,
  renderFiles2 as renderFiles,
  renderFinalAssistantBody,
  renderGatewayProbeResult5 as renderGatewayProbeResult,
  renderGoalControls,
  renderGoalStatusBar,
  renderGuideFeedback8 as renderGuideFeedback,
  renderLightboxImage9 as renderLightboxImage,
  renderLinkedText9 as renderLinkedText,
  renderMessageText,
  renderModelConfigFailure6 as renderModelConfigFailure,
  renderModelConfigPanel4 as renderModelConfigPanel,
  renderModelPanel4 as renderModelPanel,
  renderOfficePreview9 as renderOfficePreview,
  renderQuestionPanel8 as renderQuestionPanel,
  renderQueueItem8 as renderQueueItem,
  renderQueuePanel,
  renderReasoningCapabilityStatus5 as renderReasoningCapabilityStatus,
  renderSessionFailure2 as renderSessionFailure,
  renderSessions2 as renderSessions,
  renderSettingsFeedbackInPlace5 as renderSettingsFeedbackInPlace,
  renderSettingsView4 as renderSettingsView,
  renderSheetCellHtml9 as renderSheetCellHtml,
  renderSheetPreviewHtml9 as renderSheetPreviewHtml,
  renderShutdownActivity8 as renderShutdownActivity,
  renderTableHtml9 as renderTableHtml,
  renderTablePreview9 as renderTablePreview,
  renderTranscriptHistoryStatus3 as renderTranscriptHistoryStatus,
  renderTranscriptMessages2 as renderTranscriptMessages,
  renderTranscriptWindowMarker3 as renderTranscriptWindowMarker,
  renderTrustPanel,
  renderWorkflowPanel3 as renderWorkflowPanel,
  renderWorkflowStrip,
  replaceFileReferences10 as replaceFileReferences,
  requestGoalMode,
  requestPermissionMode,
  resetEventReplayState,
  resetLiveStatus2 as resetLiveStatus,
  resetPreview2 as resetPreview,
  resetTranscriptWindow4 as resetTranscriptWindow,
  resetTurnChangeStats2 as resetTurnChangeStats,
  resizePromptInput,
  resolveApproval2 as resolveApproval,
  resolveAtomicModelSelection7 as resolveAtomicModelSelection,
  resolveDisplayFilePath10 as resolveDisplayFilePath,
  responseJson9 as responseJson,
  responsiveLayoutMode,
  restoreBackgroundSnapshot2 as restoreBackgroundSnapshot,
  restoreInitialSession,
  restoreModalAttribute2 as restoreModalAttribute,
  restoreNewTaskModelState2 as restoreNewTaskModelState,
  restorePreviewWidth,
  restoreTranscriptNodeAnchor3 as restoreTranscriptNodeAnchor,
  restoreTranscriptViewportAnchor3 as restoreTranscriptViewportAnchor,
  returnToQuestion2 as returnToQuestion,
  revealInteractionPanel8 as revealInteractionPanel,
  reviewQuestionConversation8 as reviewQuestionConversation,
  runContextAction8 as runContextAction,
  saveDefaultModelSelection5 as saveDefaultModelSelection,
  saveModelConfig,
  saveSettingsConfig,
  scheduleAnimationFrameOnce,
  scheduleDraftRender4 as scheduleDraftRender,
  scheduleEventReconnect3 as scheduleEventReconnect,
  scheduleSessionsRefresh2 as scheduleSessionsRefresh,
  scopedDefaultModelLabel5 as scopedDefaultModelLabel,
  scrollTranscript2 as scrollTranscript,
  selectTranscriptNodesToRemove,
  sendPrompt,
  sessionMeta2 as sessionMeta,
  sessionStatusView2 as sessionStatusView,
  sessionsNeedRefresh2 as sessionsNeedRefresh,
  setConnectionState,
  setFormControlsSaving5 as setFormControlsSaving,
  setLiveTitle,
  setModelConfigFormSaving6 as setModelConfigFormSaving,
  setPendingGuide2 as setPendingGuide,
  setPermissionMode,
  setPreviewWidth,
  setResponsiveSurfaceInert,
  setResponsiveView,
  setSessionsRefreshState2 as setSessionsRefreshState,
  setSettingsFormSaving5 as setSettingsFormSaving,
  setSidebarCollapsed2 as setSidebarCollapsed,
  setTranscriptPaging2 as setTranscriptPaging,
  settingsControlValue5 as settingsControlValue,
  settingsDisabled5 as settingsDisabled,
  settingsFeedbackHtml5 as settingsFeedbackHtml,
  settingsFormActions5 as settingsFormActions,
  settingsGatewayProfileHtml5 as settingsGatewayProfileHtml,
  settingsInspectedGatewayProfile5 as settingsInspectedGatewayProfile,
  settingsModelHtml5 as settingsModelHtml,
  settingsSectionHeading5 as settingsSectionHeading,
  settingsToggleHtml5 as settingsToggleHtml,
  shouldFollowTranscript,
  shouldKeepGuideFeedback3 as shouldKeepGuideFeedback,
  shouldSkipDashboardEvent3 as shouldSkipDashboardEvent,
  showApproval3 as showApproval,
  showContextConfirm,
  showError,
  showGoalConfirm,
  showGoalTextPanel,
  showImageLightbox9 as showImageLightbox,
  showModelConfigPanel4 as showModelConfigPanel,
  showNotice7 as showNotice,
  showPermissionConfirm,
  showQuestion3 as showQuestion,
  showSettingsWorkspace,
  showShutdownPanel,
  showTableLightbox9 as showTableLightbox,
  showTrustPanel,
  shutdownDashboard,
  shutdownRequestBody8 as shutdownRequestBody,
  shutdownResultIsClosed8 as shutdownResultIsClosed,
  sourceBadge7 as sourceBadge,
  sourceLabel5 as sourceLabel,
  stableTurnRequest2 as stableTurnRequest,
  state,
  statusUrl,
  submitGoalAction,
  submitQuestion8 as submitQuestion,
  summarizeWorkflow3 as summarizeWorkflow,
  switchModel5 as switchModel,
  switchReasoningEffort7 as switchReasoningEffort,
  syncAgentModelPickersForEndpoint6 as syncAgentModelPickersForEndpoint,
  syncGatewayUrlHint5 as syncGatewayUrlHint,
  syncGuideButton,
  syncPendingGuideFromQueue3 as syncPendingGuideFromQueue,
  syncPreviewResizeHandle,
  syncReasoningDefaultOptions5 as syncReasoningDefaultOptions,
  syncResponsiveNavigation,
  syncSettingsRail5 as syncSettingsRail,
  syncTranscriptFollowState3 as syncTranscriptFollowState,
  syncVisualViewport,
  tablePreviewMeta9 as tablePreviewMeta,
  tableTruncationNote9 as tableTruncationNote,
  toggleLiveStatusDetails,
  toggleModelPanel4 as toggleModelPanel,
  toggleQuestionChoice8 as toggleQuestionChoice,
  toggleSidebar,
  transcriptFirstContentNode3 as transcriptFirstContentNode,
  transcriptNodeTop3 as transcriptNodeTop,
  transcriptRetentionOptionsHtml5 as transcriptRetentionOptionsHtml,
  transcriptSettingsHtml5 as transcriptSettingsHtml,
  trimNumber8 as trimNumber,
  trimTranscriptWindow3 as trimTranscriptWindow,
  uniqueAgentModelCandidates6 as uniqueAgentModelCandidates,
  unresolvedModelStatusHtml4 as unresolvedModelStatusHtml,
  updateAgentModelPickerManualStatus5 as updateAgentModelPickerManualStatus,
  updateConfigRevisions,
  updateContextActions,
  updateLiveActivity4 as updateLiveActivity,
  updateLiveStatus3 as updateLiveStatus,
  updatePreviewResize,
  updateRunStatusForBackground4 as updateRunStatusForBackground,
  updateRunStatusTone,
  updateSendButton,
  updateSessionStatus,
  updateTranscriptJump9 as updateTranscriptJump,
  updateTurnChangeStats2 as updateTurnChangeStats,
  userMessageDisplayText3 as userMessageDisplayText,
  workflowItem3 as workflowItem,
  workflowSection3 as workflowSection
};
