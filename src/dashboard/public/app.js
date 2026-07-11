import { renderMarkdown } from "./markdown.js";
import { hydrateRichContent } from "./rich-renderers.js";
import { visibleTranscriptRole } from "./transcript.js";

/**
 * @typedef {object} DashboardSessionSummary
 * @property {string} id
 * @property {string} [title]
 * @property {string} [status]
 * @property {string} [model]
 * @property {string | number | Date} [modifiedAt]
 * @property {boolean} [active]
 * @property {boolean} [running]
 * @property {number} [queueLength]
 * @property {boolean} [backgroundVisible]
 * @property {string[]} [backgroundKinds]
 * @property {number} [backgroundCount]
 */

const state = {
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
  eventStaleTimer: null,
  lastEventAt: 0,
  permissionMode: "plan",
  pendingApproval: null,
  pendingQuestion: null,
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
  liveActivities: new Map(),
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
  models: [],
  gatewayConfig: null,
  gatewayProfiles: [],
  agentModelTiers: {},
  visionAgent: null,
  modelPanelOpen: false,
  applyAgentDefaultsOnSwitch: true,
  modelConfigOpen: false,
  modelConfigSaving: false,
  modelSwitching: false,
  deletingModelId: "",
  deleteConfirmModelId: "",
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
  sessionStatus: null,
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
  shutdownStatusVersion: 0
};

const els = {
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

const MODE_DESCRIPTIONS = {
  plan: "写入和命令需确认",
  workspace: "工作区常规操作自动同意",
  fullAccess: "高风险：本机工具和网络自动同意"
};
const LOCAL_FILE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg",
  "pdf",
  "md", "markdown", "txt", "log",
  "json", "csv", "tsv", "yaml", "yml",
  "js", "mjs", "cjs", "ts", "tsx", "jsx", "css", "html", "xml",
  "py", "ps1", "cmd", "sh", "java", "c", "cpp", "h", "hpp", "cs", "go", "rs", "php", "rb", "sql", "toml", "ini",
  "doc", "docx", "xls", "xlsx", "ppt", "pptx"
]);
const FILE_REFERENCE_PATTERN = /(?:[A-Za-z0-9_.-]+[\\/])*[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8}(?::\d+)?/g;
const TRANSCRIPT_DOM_LIMIT = 300;
const EVENT_STALE_AFTER_MS = 35_000;
const EVENT_RECONNECT_MAX_ATTEMPTS = 6;
const MAX_IMAGE_ATTACHMENTS = 6;
const MAX_IMAGE_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const CURRENT_SESSION_STORAGE_KEY = "ant-code-dashboard-current-session";
const PREVIEW_WIDTH_STORAGE_KEY = "ant-code-dashboard-preview-width";
const PREVIEW_WIDTH_DEFAULT = 360;
const PREVIEW_WIDTH_MIN = 300;
const PREVIEW_WIDTH_MAX = 640;
const PREVIEW_WORKSPACE_MIN = 520;

await init();

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
    const status = await getJson("/api/status", { signal: request.signal });
    if (!isCurrentScopedRequest(request)) return;
    if (!status.ok) {
      throw new Error(status.error ?? "Dashboard 初始化失败");
    }
    state.cwd = status.cwd;
    state.models = normalizeModels(status.models);
    state.gatewayConfig = normalizeGatewayConfig(status.gatewayConfig);
    state.gatewayProfiles = normalizeGatewayProfiles(status.gatewayProfiles);
    state.agentModelTiers = normalizeAgentModelTiers(status.agentModelTiers);
    state.visionAgent = normalizeVisionAgent(status.visionAgent);
    updateSessionStatus(status.sessionStatus);
    els.projectPath.textContent = status.cwd;
    const trust = await loadTrust({ signal: request.signal, silent: true });
    if (!trust?.ok) {
      throw new Error(trust?.error ?? "无法读取工作区信任状态");
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
    const button = event.target.closest("button[data-mode]");
    if (!button) return;
    requestPermissionMode(button.dataset.mode, button);
  });
  els.permissionMode.addEventListener("keydown", handlePermissionModeKeydown);
  els.collapsePreview.addEventListener("click", () => {
    if (responsiveLayoutMode() === "desktop") {
      document.body.classList.toggle("preview-collapsed");
      syncPreviewResizeHandle();
    } else {
      setResponsiveView("conversation");
    }
  });
  els.previewResizeHandle?.addEventListener("pointerdown", (event) => beginPreviewResize(/** @type {PointerEvent} */ (event)));
  els.previewResizeHandle?.addEventListener("pointermove", (event) => updatePreviewResize(/** @type {PointerEvent} */ (event)));
  els.previewResizeHandle?.addEventListener("pointerup", (event) => finishPreviewResize(/** @type {PointerEvent} */ (event)));
  els.previewResizeHandle?.addEventListener("pointercancel", (event) => finishPreviewResize(/** @type {PointerEvent} */ (event)));
  els.previewResizeHandle?.addEventListener("keydown", (event) => handlePreviewResizeKeydown(/** @type {KeyboardEvent} */ (event)));
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
  els.modelPanel.addEventListener("click", handleModelPanelClick);
  els.modelConfigPanel.addEventListener("click", handleModelConfigPanelClick);
  els.modelConfigPanel.addEventListener("submit", saveModelConfig);
  els.liveSubtasks.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-background-cancel]");
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
    if (event.target.closest("#model-panel") || event.target.closest("#model-config-panel") || event.target.closest("#model-status-toggle")) {
      return;
    }
    hideModelPanel();
  });
  els.transcript.addEventListener("scroll", handleTranscriptScroll);
  els.workflowStrip.addEventListener("click", (event) => {
    if (!event.target.closest("button[data-action='toggle-workflow']")) {
      return;
    }
    state.workflowExpanded = !state.workflowExpanded;
    renderWorkflowStrip();
  });
  els.activityToggle.addEventListener("click", toggleLiveStatusDetails);
  els.transcriptJump.addEventListener("click", followTranscript);
  els.responsiveNavigation.querySelectorAll("button[data-dashboard-view]").forEach((button) => {
    button.addEventListener("click", () => setResponsiveView(button.dataset.dashboardView));
  });
  els.responsiveScrim.addEventListener("click", () => setResponsiveView("conversation"));
  els.threadList.addEventListener("click", (event) => {
    if (event.target.closest(".thread-open")) {
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

export function normalizedResponsiveView(width, requestedView) {
  if (Number(width) >= 1200) return "conversation";
  return ["sessions", "conversation", "files"].includes(requestedView) ? requestedView : "conversation";
}

export function composerHeightFor(scrollHeight, minimum = 52, maximum = 160) {
  const measured = Number(scrollHeight);
  const safeMinimum = Math.max(1, Number(minimum) || 52);
  const safeMaximum = Math.max(safeMinimum, Number(maximum) || 160);
  return Math.min(safeMaximum, Math.max(safeMinimum, Number.isFinite(measured) ? measured : safeMinimum));
}

/**
 * @param {number} viewportWidth
 * @param {boolean} [sidebarCollapsed]
 * @returns {{ min: number; max: number }}
 */
export function previewWidthBounds(viewportWidth, sidebarCollapsed = false) {
  const viewport = Math.max(0, Number(viewportWidth) || 0);
  const sidebarWidth = sidebarCollapsed ? 56 : 280;
  const available = viewport - 20 - 20 - sidebarWidth - PREVIEW_WORKSPACE_MIN;
  return {
    min: PREVIEW_WIDTH_MIN,
    max: Math.max(PREVIEW_WIDTH_MIN, Math.min(PREVIEW_WIDTH_MAX, available))
  };
}

/**
 * @param {number} width
 * @param {{ min?: number; max?: number }} bounds
 * @returns {number}
 */
export function clampedPreviewWidth(width, bounds) {
  const minimum = Math.max(0, Number(bounds?.min) || PREVIEW_WIDTH_MIN);
  const maximum = Math.max(minimum, Number(bounds?.max) || PREVIEW_WIDTH_MAX);
  const value = Number(width);
  return Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : PREVIEW_WIDTH_DEFAULT));
}

export function permissionIndexForKey(currentIndex, key, length) {
  const count = Math.max(0, Number(length) || 0);
  if (count === 0) return -1;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "ArrowRight" || key === "ArrowDown") return (Math.max(0, currentIndex) + 1) % count;
  if (key === "ArrowLeft" || key === "ArrowUp") return (Math.max(0, currentIndex) - 1 + count) % count;
  return currentIndex;
}

export function focusTrapTarget(focusables, activeElement, shiftKey = false) {
  const items = Array.from(focusables ?? []);
  if (items.length === 0) return null;
  const current = items.indexOf(activeElement);
  if (current < 0) return shiftKey ? items.at(-1) : items[0];
  return items[(current + (shiftKey ? -1 : 1) + items.length) % items.length];
}

export function shouldFollowTranscript({ force = false, following = true, onlyIfNearBottom = false, wasAtBottom = true } = {}) {
  if (force) return true;
  if (!following) return false;
  return !onlyIfNearBottom || wasAtBottom !== false;
}

export function scheduleAnimationFrameOnce(holder, key, callback, scheduler = requestAnimationFrame) {
  if (holder?.[key] != null) return false;
  const frame = scheduler(() => {
    holder[key] = null;
    callback();
  });
  holder[key] = frame ?? true;
  return true;
}

export function cancelScheduledAnimationFrame(holder, key, cancel = cancelAnimationFrame) {
  const frame = holder?.[key];
  if (frame == null) return false;
  holder[key] = null;
  if (frame !== true) cancel(frame);
  return true;
}

export function appendPlainDraftDelta(body, text, renderedLength = 0, createTextNode = (value) => document.createTextNode(value)) {
  const value = String(text ?? "");
  const start = Math.min(value.length, Math.max(0, Number(renderedLength) || 0));
  const pending = value.slice(start);
  if (pending) {
    if (typeof body?.append === "function") body.append(createTextNode(pending));
    else if (body) body.textContent = `${body.textContent ?? ""}${pending}`;
  }
  return value.length;
}

export function renderFinalAssistantBody(body, text, renderer = renderMessageText) {
  renderer(body, text ?? "", { markdown: true });
}

export function selectTranscriptNodesToRemove(nodes, limit, direction = "append", isProtected = () => false) {
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
    // Local storage can be unavailable in hardened browser contexts.
  }
  setPreviewWidth(saved);
}

/**
 * @param {number} width
 * @param {{ persist?: boolean; announce?: boolean; updatePreference?: boolean }} [options]
 * @returns {number}
 */
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
      // Local storage can be unavailable in hardened browser contexts.
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

/** @param {PointerEvent} event */
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

/** @param {PointerEvent} event */
function updatePreviewResize(event) {
  if (state.previewResizeStartX === null || state.previewResizeStartWidth === null) return;
  const delta = Number(event.clientX) - state.previewResizeStartX;
  setPreviewWidth(state.previewResizeStartWidth - delta);
}

/** @param {PointerEvent} event */
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

/** @param {KeyboardEvent} event */
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
    const active = button.dataset.dashboardView === view;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  if (state.modalContext) return;
  const desktop = width >= 1200;
  setResponsiveSurfaceInert(els.sidebar, !desktop && view !== "sessions");
  setResponsiveSurfaceInert(els.workspace, !desktop && view !== "conversation");
  setResponsiveSurfaceInert(els.preview, !desktop && view !== "files");
}

function setResponsiveSurfaceInert(element, inert) {
  if (!element) return;
  element.inert = Boolean(inert);
}

function handleResponsiveFileNavigation(event) {
  if (responsiveLayoutMode() === "desktop") return;
  if (event.target.closest(".file-item, .file-link, [data-file]")) {
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
  const current = Math.max(0, buttons.indexOf(event.target.closest("button[data-mode]")));
  const next = permissionIndexForKey(current, event.key, buttons.length);
  const button = buttons[next];
  if (!button) return;
  event.preventDefault();
  event.stopPropagation();
  button.focus();
  requestPermissionMode(button.dataset.mode, button);
}

function requestPermissionMode(mode, trigger = document.activeElement) {
  if (mode === "fullAccess" && state.permissionMode !== "fullAccess") {
    showPermissionConfirm(trigger);
    return;
  }
  hidePermissionConfirm({ restoreFocus: false });
  setPermissionMode(mode);
}

function showPermissionConfirm(trigger) {
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
  panel.querySelector("button[data-action='cancel']")?.addEventListener("click", hidePermissionConfirm);
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
  const hint = noSession
    ? "请先打开一个空闲会话"
    : busy
      ? "任务运行期间不能清空或压缩上下文"
      : "可管理当前会话上下文";
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

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

function modalFocusableElements(modal) {
  return Array.from(modal?.querySelectorAll?.(FOCUSABLE_SELECTOR) ?? []).filter((node) => (
    node.getAttribute?.("aria-hidden") !== "true" && !node.closest?.("[inert]")
  ));
}

function activateModal(modal, options = {}) {
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

function collectModalBackground(modal) {
  const entries = [];
  const seen = new Set();
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

function focusModalInitialTarget(modal, selector) {
  requestAnimationFrame(() => {
    if (state.modalContext?.modal !== modal) return;
    const target = selector ? modal.querySelector(selector) : modalFocusableElements(modal)[0];
    (target ?? modal).focus?.({ preventScroll: true });
  });
}

function deactivateModal(modal, options = {}) {
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

function restoreModalAttribute(element, name, value) {
  if (value === null || typeof value === "undefined") element.removeAttribute(name);
  else element.setAttribute(name, value);
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
    else if (state.responsiveView !== "conversation") setResponsiveView("conversation");
  }
}

function closeActiveModal(modal) {
  if (modal === els.modelConfigPanel) hideModelConfigPanel();
  else if (modal === els.imageLightbox) hideLightbox();
  else if (modal === els.shutdownPanel) hideShutdownPanel();
  else if (modal === els.contextPanel) hideContextConfirm();
  else if (modal === els.permissionConfirmPanel) hidePermissionConfirm();
  else if (modal === els.approvalPanel) resolveApproval("cancel");
  else if (modal === els.questionPanel) cancelQuestion();
}

async function loadTrust(options = {}) {
  const result = await getJson("/api/trust", { signal: options.signal })
    .catch((error) => ({ ok: false, error: error.message, aborted: isAbortError(error) }));
  if (!result.ok) {
    if (!options.silent && !result.aborted) {
      showError(result.error ?? "无法读取工作区信任状态");
    }
    return result;
  }
  state.trust = result.trust;
  renderTrustPanel();
  return result;
}

async function loadSessions(options = {}) {
  const feedback = options.feedback === true;
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
    showError(error.message ?? "刷新会话失败");
    return { ok: false, error: error.message };
  } finally {
    finishScopedRequest(request);
  }
}

async function restoreInitialSession() {
  if (state.currentSessionId) {
    return;
  }
  const sessionId = initialSessionId() || latestBackgroundSessionId();
  if (!sessionId || !state.sessions.some((session) => session.id === sessionId)) {
    return;
  }
  await openSession(sessionId);
}

function latestBackgroundSessionId() {
  return state.sessions.find((session) => session.backgroundVisible === true)?.id ?? "";
}

function initialSessionId() {
  try {
    const params = new URLSearchParams(window.location?.search ?? "");
    return params.get("sessionId") || window.localStorage?.getItem(CURRENT_SESSION_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

/** @param {string | null | undefined} sessionId */
function rememberCurrentSession(sessionId) {
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

function renderSessions() {
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
    const showStatusBadge = ["running", "waiting", "warning", "error"].includes(status.tone);
    const title = session.title || "未命名任务";
    const meta = sessionMeta(session, status);
    const item = document.createElement("div");
    item.className = `thread-item${session.id === state.currentSessionId ? " active" : ""}`;
    item.dataset.tone = status.tone;
    item.innerHTML = `
      <button type="button" class="thread-open" title="${escapeAttribute(title)}" aria-label="${escapeAttribute(`${title}，${status.label}${meta ? `，${meta}` : ""}`)}">
        <span class="thread-status-dot" aria-hidden="true"></span>
        <div class="thread-main">
          <div class="thread-title">${escapeHtml(title)}</div>
          <div class="thread-meta">${escapeHtml(meta)}</div>
        </div>
        ${showStatusBadge ? `<span class="thread-status-badge" data-tone="${escapeAttribute(status.tone)}">${escapeHtml(status.label)}</span>` : ""}
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
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        handleSessionAction(button.dataset.action, button.dataset.sessionId);
      });
    });
    threadList.append(item);
  }
}

function sessionMeta(session, status = sessionStatusView(session)) {
  const parts = [
    session.queueLength > 0 ? `${session.queueLength} 排队` : null,
    status.detail,
    session.model || null,
    formatTime(session.modifiedAt)
  ].filter(Boolean);
  return parts.join(" · ");
}

function sessionStatusView(session) {
  const raw = String(session.status ?? "").toLowerCase();
  if (session.running || raw === "running") {
    return { label: "运行中", tone: "running", detail: session.queueLength > 0 ? "有排队" : "" };
  }
  if (session.backgroundVisible) {
    const kinds = Array.isArray(session.backgroundKinds) ? session.backgroundKinds : [];
    if (kinds.includes("terminal") && !kinds.includes("subagent")) {
      return { label: "终端后台", tone: "running", detail: session.backgroundCount > 1 ? `${session.backgroundCount} 个任务` : "" };
    }
    if (kinds.includes("terminal")) {
      return { label: "后台运行", tone: "running", detail: session.backgroundCount > 1 ? `${session.backgroundCount} 个任务` : "" };
    }
    return { label: "子智能体后台", tone: "running", detail: session.backgroundCount > 1 ? `${session.backgroundCount} 个任务` : "" };
  }
  if (raw.includes("引导")) {
    return { label: "引导中", tone: "running", detail: "" };
  }
  if (session.queueLength > 0) {
    return { label: "排队中", tone: "waiting", detail: "" };
  }
  if (["failed", "error"].includes(raw) || raw.includes("失败")) {
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
  setSidebarCollapsed(!state.sidebarCollapsed);
}

function setSidebarCollapsed(collapsed) {
  state.sidebarCollapsed = Boolean(collapsed);
  document.body.classList.toggle("sidebar-collapsed", state.sidebarCollapsed);
  els.collapseSidebar.textContent = state.sidebarCollapsed ? "›" : "‹";
  els.collapseSidebar.title = state.sidebarCollapsed ? "展开会话栏" : "收起会话栏";
  els.collapseSidebar.setAttribute("aria-label", els.collapseSidebar.title);
  setPreviewWidth(state.previewPreferredWidth, { updatePreference: false });
}

function sessionsNeedRefresh() {
  return state.sessions.some((session) =>
    session.running
    || session.backgroundVisible
    || Number(session.queueLength) > 0
    || String(session.status ?? "").toLowerCase() === "running"
  );
}

function scheduleSessionsRefresh(delayMs = 800) {
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

function handleSessionAction(action, sessionId) {
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

async function openSession(id) {
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
      showError(error.message ?? "无法读取会话");
    }
    finishScopedRequest(request);
    return;
  }
  if (!isCurrentScopedRequest(request)) return;
  finishScopedRequest(request);
  if (!result.ok) {
    showError(result.error?.message ?? result.error ?? "无法读取会话");
    return;
  }
  state.currentSessionId = id;
  setPermissionMode(result.session.permission?.mode ?? "plan");
  state.running = result.session.active === true && result.session.running === true;
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
  state.models = markCurrentModel(state.models, result.session.sessionStatus?.model ?? result.session.model);
  updateSessionStatus(result.session.sessionStatus ?? { model: result.session.model, context: result.session.context });
  resetTurnChangeStats();
  state.files = result.session.files ?? [];
  renderFiles();
  resetPreview();
  els.runStatus.textContent = result.session.status || "历史";
  setTranscriptPaging(result.session.transcriptPage);
  renderTranscriptMessages(result.session.transcript ?? []);
  scrollTranscript({ force: true });
  const hasBackground = restoreBackgroundSnapshot(result.session.backgroundSnapshot);
  if (result.session.active && result.session.running) {
    rememberEventCursor(result.session.eventCursor);
    ensureEventsConnected(id);
    els.runStatus.textContent = result.session.status === "引导中" ? "引导中" : "运行中";
    setLiveTitle(result.session.status === "引导中" ? "正在按引导继续" : "正在恢复运行中的任务");
    state.running = true;
    updateSendButton();
  } else if (result.session.active && hasBackground) {
    rememberEventCursor(result.session.eventCursor);
    ensureEventsConnected(id);
    applyIdleRunStatus("完成");
    updateSendButton();
  }
  renderSessions();
}

function restoreBackgroundSnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.groups)) {
    return false;
  }
  reconcileBackgroundSubagentSnapshot(snapshot.groups);
  return state.backgroundSubagents.size > 0;
}

async function deleteSession(sessionId) {
  if (!sessionId || state.deletingSessions.has(sessionId)) {
    return;
  }
  state.deletingSessions.add(sessionId);
  renderSessions();
  const result = await deleteJson(`/api/sessions/${encodeURIComponent(sessionId)}`)
    .catch((error) => ({ ok: false, error: error.message }));
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

function setSessionsRefreshState(tone, message = "") {
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

async function copySessionId(sessionId) {
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

function newTask() {
  cancelScopedRequest("session");
  cancelScopedRequest("transcript");
  cancelScopedRequest("file");
  state.turnRequest = null;
  state.currentSessionId = null;
  setPermissionMode("plan");
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
  clearAttachments();
  renderQueuePanel();
  renderFiles();
  resetPreview();
  els.runStatus.textContent = "空闲";
  updateSendButton();
  resizePromptInput();
  els.promptInput.focus();
}

async function addAttachmentFiles(files) {
  const images = files.filter((file) => file?.type?.startsWith("image/"));
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
      state.attachments.push(await readImageAttachment(file));
    } catch (error) {
      showError(error?.message ?? "读取图片失败");
    }
  }
  if (images.length > slots) {
    showError(`最多可附加 ${MAX_IMAGE_ATTACHMENTS} 张图片，已忽略多余图片`);
  }
  renderAttachmentStrip();
  updateSendButton();
}

function readImageAttachment(file) {
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

function renderAttachmentStrip() {
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
      renderAttachmentStrip();
      updateSendButton();
    });
    els.attachmentStrip.append(item);
  }
}

function attachmentPayload(attachment) {
  return {
    type: "image",
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.size,
    data: attachment.data
  };
}

function clearAttachments() {
  state.attachments = [];
  if (els.attachmentInput) {
    els.attachmentInput.value = "";
  }
  renderAttachmentStrip();
}

async function sendPrompt() {
  if (state.turnSubmitting) {
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
      permissionMode: state.permissionMode
    });
  } catch (error) {
    result = { ok: false, error: error.message };
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
  setPermissionMode(result.permission?.mode ?? state.permissionMode);
  updateSessionStatus(result.sessionStatus);
  updateTurnChangeStats(result.changeStats, { replace: true });
  renderQueuePanel();
  if (result.running === true) {
    els.runStatus.textContent = "运行中";
    setLiveTitle("正在处理你的任务");
  }
  updateSendButton();
  const previousSessionId = state.currentSessionId;
  state.currentSessionId = result.sessionId;
  rememberCurrentSession(result.sessionId);
  if (previousSessionId !== result.sessionId) {
    resetEventReplayState();
  }
  rememberEventCursor(result.eventCursor);
  ensureEventsConnected(result.sessionId);
  await loadSessions();
}

function stableTurnRequest(prompt, attachments) {
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

async function interruptTurn() {
  if (!state.currentSessionId) {
    return;
  }
  els.sendButton.disabled = true;
  els.sendButton.textContent = "中断中";
  const result = await postJson("/api/turns/interrupt", {
    sessionId: state.currentSessionId,
    reason: "user"
  }).catch((error) => ({ ok: false, error: error.message }));
  els.sendButton.disabled = false;
  if (!result.ok) {
    showError(result.error ?? "中断失败");
  }
  updateSessionStatus(result.sessionStatus);
  updateSendButton();
}

async function guideTurn(queueItemId = "") {
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
  }).catch((error) => ({ ok: false, error: error.message }));
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

async function cancelQueuedTurn(queueItemId) {
  if (!queueItemId || !state.currentSessionId || state.queueCancelling.has(queueItemId)) {
    return;
  }
  state.queueCancelling.add(queueItemId);
  renderQueuePanel();
  const result = await postJson("/api/turns/queue/cancel", {
    sessionId: state.currentSessionId,
    queueItemId
  }).catch((error) => ({ ok: false, error: error.message }));
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

async function cancelBackgroundSubagent(groupId, taskId) {
  const key = backgroundCancelKey(groupId, taskId);
  if (!state.currentSessionId || !key || state.backgroundCancelling.has(key)) {
    return;
  }
  state.backgroundCancelling.add(key);
  updateLiveStatus();
  const item = Array.from(state.backgroundSubagents.values()).find((value) => (
    (groupId && value.groupId === groupId) || (taskId && value.taskId === taskId)
  ));
  const endpoint = item?.kind === "terminal" ? "/api/background-terminals/cancel" : "/api/background-subagents/cancel";
  const result = await postJson(endpoint, {
    sessionId: state.currentSessionId,
    groupId,
    taskId
  }).catch((error) => ({ ok: false, error: error.message }));
  state.backgroundCancelling.delete(key);
  if (!result.ok) {
    showError(result.error ?? "回收子智能体失败");
    updateLiveStatus();
    return;
  }
  updateSessionStatus(result.sessionStatus);
  for (const [itemKey, item] of state.backgroundSubagents.entries()) {
    if ((groupId && item.groupId === groupId) || (taskId && item.taskId === taskId)) {
      state.backgroundSubagents.set(itemKey, {
        ...item,
        summary: item.kind === "terminal" ? "已请求回收后台终端任务，等待状态刷新" : "已请求回收后台子智能体，等待状态刷新",
        status: "stale"
      });
    }
  }
  updateLiveStatus();
  applyIdleRunStatus("空闲");
}

function backgroundCancelKey(groupId, taskId) {
  const group = String(groupId ?? "").trim();
  const task = String(taskId ?? "").trim();
  return group || task ? `${group || "-"}:${task || "-"}` : "";
}

function connectEvents(sessionId) {
  clearEventReconnectTimer();
  closeEventSource();
  state.eventSourceSessionId = sessionId;
  setConnectionState(state.eventReconnectAttempt > 0 ? "reconnecting" : "connecting");
  const params = new URLSearchParams({ sessionId });
  if (state.lastEventSequence > 0) {
    params.set("after", String(state.lastEventSequence));
  }
  const source = new EventSource(`/api/events?${params.toString()}`, { withCredentials: true });
  state.eventSource = source;
  source.addEventListener("open", () => {
    if (state.eventSource !== source) return;
    state.eventReconnectAttempt = 0;
    markEventConnectionAlive();
    setConnectionState("connected");
  });
  source.addEventListener("heartbeat", () => {
    if (state.eventSource === source) {
      markEventConnectionAlive();
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
    markEventConnectionAlive();
    if (shouldSkipDashboardEvent(payload)) {
      return;
    }
    rememberEventCursor(payload.sequence);
    handleDashboardEvent(payload);
  });
  source.addEventListener("error", () => {
    if (state.eventSource !== source) return;
    source.close();
    state.eventSource = null;
    clearEventStaleTimer();
    if (navigator.onLine === false) {
      setConnectionState("offline");
      return;
    }
    scheduleEventReconnect(sessionId);
  });
}

function ensureEventsConnected(sessionId) {
  if (state.eventSource && state.eventSourceSessionId === sessionId) {
    return;
  }
  connectEvents(sessionId);
}

function disconnectEvents() {
  clearEventReconnectTimer();
  clearEventStaleTimer();
  closeEventSource();
  state.eventSourceSessionId = null;
  state.eventReconnectAttempt = 0;
  state.lastEventAt = 0;
  setConnectionState("idle");
}

function closeEventSource() {
  state.eventSource?.close();
  state.eventSource = null;
}

function markEventConnectionAlive() {
  state.lastEventAt = Date.now();
  if (state.connectionState === "stale" || state.connectionState === "reconnecting") {
    setConnectionState("connected");
  }
  clearEventStaleTimer();
  const sessionId = state.eventSourceSessionId;
  armEventStaleTimer(sessionId, EVENT_STALE_AFTER_MS);
}

function armEventStaleTimer(sessionId, delay) {
  state.eventStaleTimer = setTimeout(() => {
    if (!sessionId || state.eventSourceSessionId !== sessionId) return;
    const remaining = EVENT_STALE_AFTER_MS - (Date.now() - state.lastEventAt);
    if (remaining > 0) {
      armEventStaleTimer(sessionId, remaining);
      return;
    }
    setConnectionState("stale");
    closeEventSource();
    scheduleEventReconnect(sessionId);
  }, Math.max(1, delay));
}

function scheduleEventReconnect(sessionId) {
  if (!sessionId || state.currentSessionId !== sessionId) return;
  clearEventReconnectTimer();
  state.eventReconnectAttempt += 1;
  if (state.eventReconnectAttempt > EVENT_RECONNECT_MAX_ATTEMPTS) {
    setConnectionState("offline");
    return;
  }
  setConnectionState("reconnecting");
  const delay = Math.min(15_000, 500 * (2 ** (state.eventReconnectAttempt - 1)));
  state.eventReconnectTimer = setTimeout(() => {
    state.eventReconnectTimer = null;
    if (state.currentSessionId === sessionId && navigator.onLine !== false) {
      connectEvents(sessionId);
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
  connectEvents(state.currentSessionId);
}

function clearEventReconnectTimer() {
  if (state.eventReconnectTimer) {
    clearTimeout(state.eventReconnectTimer);
    state.eventReconnectTimer = null;
  }
}

function clearEventStaleTimer() {
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
    idle: "未连接",
    connecting: "连接中",
    connected: "已连接",
    reconnecting: `重连 ${Math.max(1, state.eventReconnectAttempt)}/${EVENT_RECONNECT_MAX_ATTEMPTS}`,
    offline: "离线",
    stale: "连接过期"
  };
  const label = labels[next] ?? labels.idle;
  els.connectionStatus.dataset.state = next;
  els.connectionStatus.title = `连接状态：${label}。点击重新连接`;
  const text = els.connectionStatus.querySelector(".connection-label");
  if (text) text.textContent = label;
  if (next !== previous && ["offline", "reconnecting", "stale"].includes(next)) {
    announceStatus(`Dashboard ${label}`);
  } else if (next === "connected" && ["offline", "reconnecting", "stale"].includes(previous)) {
    announceStatus("Dashboard 已重新连接");
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

function handleDashboardEvent(event) {
  hideEmptyState();
  updateSessionStatus(event.sessionStatus);
  updateTurnChangeStats(event.turnChangeStats ?? event.changeStats, {
    replace: event.type === "run_state" || event.type === "files_updated" || Boolean(event.turnChangeStats)
  });
  if (event.type === "user_message") {
    beginEventTurn(event);
    updateTurnChangeStats(null, { reset: true });
    state.lastAssistantFinalSignature = "";
    appendMessage("user", event.queuedKind === "guide" ? "引导" : event.queuedKind === "wakeup" ? "子智能体" : "你", userMessageDisplayText(event.text, event.attachments));
    state.running = true;
    scheduleSessionsRefresh();
    if (event.queuedKind === "guide") {
      els.runStatus.textContent = "引导中";
      setPendingGuide({
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
  if (event.type === "run_state") {
    if (event.permission?.mode) {
      setPermissionMode(event.permission.mode);
    }
    if (event.running === true) {
      beginEventTurn(event);
    } else if (event.running === false && event.turnId === state.activeTurnId) {
      state.activeTurnId = "";
    }
    state.running = event.running === true;
    state.queue = event.queue ?? [];
    scheduleSessionsRefresh();
    if (state.running && event.current?.kind === "guide") {
      setPendingGuide({
        sessionId: state.currentSessionId,
        phase: "continuing",
        preview: event.current.preview ?? state.pendingGuide?.preview ?? ""
      });
      els.runStatus.textContent = "引导中";
      setLiveTitle("正在按引导继续");
    } else if (!state.running) {
      clearPendingGuide();
      resetLiveStatus({ keepBackgroundSubagents: true });
      applyIdleRunStatus("空闲");
    } else {
      els.runStatus.textContent = "运行中";
      renderQueuePanel();
    }
    updateSendButton();
    return;
  }
  if (event.type === "guide_queued") {
    state.queue = event.queue ?? [];
    scheduleSessionsRefresh();
    setPendingGuide({
      sessionId: state.currentSessionId,
      phase: "registered",
      preview: event.guidance ?? event.item?.preview ?? state.pendingGuide?.preview ?? ""
    });
    els.runStatus.textContent = "引导中";
    return;
  }
  if (event.type === "prompt_queued" || event.type === "queue_updated") {
    state.queue = event.queue ?? [];
    scheduleSessionsRefresh();
    syncPendingGuideFromQueue();
    els.runStatus.textContent = state.pendingGuide ? "引导中" : state.running ? "运行中" : "已排队";
    return;
  }
  if (event.type === "queue_item_cancelled") {
    state.queue = event.queue ?? [];
    state.queueCancelling.delete(event.item?.id);
    updateSessionStatus(event.sessionStatus);
    if (event.item?.kind === "guide" && state.pendingGuide?.phase !== "continuing") {
      clearPendingGuide();
    } else {
      renderQueuePanel();
    }
    els.runStatus.textContent = state.queue.length > 0 ? `${state.queue.length} 条排队中` : state.running ? "运行中" : "空闲";
    return;
  }
  if (event.type === "wakeup_queued") {
    state.queue = event.queue ?? state.queue;
    scheduleSessionsRefresh();
    clearBackgroundSubagentStatus(event.groupId);
    renderQueuePanel();
    els.runStatus.textContent = event.running ? "主控续跑已排队" : "主控接续中";
    setLiveTitle("子智能体已唤醒主控");
    updateSendButton();
    return;
  }
  if (event.type === "background_subagent_snapshot") {
    reconcileBackgroundSubagentSnapshot(event.groups);
    return;
  }
  if (event.type === "background_subagent_cancelled") {
    clearBackgroundSubagentStatus(event.groupId || event.taskId);
    applyIdleRunStatus("空闲");
    return;
  }
  if (event.type === "background_terminal_cancelled") {
    clearBackgroundSubagentStatus(event.taskId);
    applyIdleRunStatus("空闲");
    return;
  }
  if (event.type === "turn_interrupt_requested") {
    if (event.reason === "guided") {
      hideApproval();
      hideQuestion();
      setPendingGuide({
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
    setPendingGuide({
      sessionId: state.currentSessionId,
      phase: "stopped",
      preview: event.guidance ?? ""
    });
    els.runStatus.textContent = "停止中";
    setLiveTitle("正在停止当前任务");
    return;
  }
  if (event.type === "context_cleared") {
    hideContextConfirm();
    appendActivity({
      title: "上下文已清空",
      detail: contextSummaryLine(event.after),
      severity: "success",
      collapsed: true
    });
    return;
  }
  if (event.type === "context_boundary") {
    appendContextBoundary(event);
    return;
  }
  if (event.type === "context_compacted") {
    appendContextBoundary(event);
    return;
  }
  if (event.type === "activity") {
    if (event.rawType === "turn_interrupted") {
      collapseAssistantDrafts();
    }
    if (isBackgroundSubagentActivity(event)) {
      handleBackgroundSubagentActivity(event);
      return;
    }
    handleActivity(event);
    if (event.status === "waiting") els.runStatus.textContent = "等待确认";
    else if (event.status === "running") els.runStatus.textContent = state.pendingGuide ? "引导中" : "运行中";
    else if (event.status === "failed") els.runStatus.textContent = "失败";
    else if (event.rawType === "context_compacted") els.runStatus.textContent = state.running ? "运行中" : "完成";
    return;
  }
  if (event.type === "workflow_snapshot") {
    renderWorkflowPanel(event.workflow, event.summary);
    return;
  }
  if (event.type === "assistant_draft") {
    beginEventTurn(event);
    appendAssistantDraft(event);
    els.runStatus.textContent = state.pendingGuide ? "引导中" : "运行中";
    state.running = true;
    scheduleSessionsRefresh();
    updateSendButton();
    return;
  }
  if (event.type === "approval_required") {
    if (event.activity) handleActivity(event.activity);
    showApproval(event.approval);
    els.runStatus.textContent = "等待确认";
    setLiveTitle("等待权限确认");
    return;
  }
  if (event.type === "question_required") {
    showQuestion(event.question);
    els.runStatus.textContent = "等待核对";
    setLiveTitle("等待需求核对");
    return;
  }
  if (event.type === "question_resolved") {
    hideQuestion();
    if (event.interrupted && state.pendingGuide) {
      els.runStatus.textContent = "引导中";
      setLiveTitle("引导已接管，等待当前轮次收束");
      updateSendButton();
      return;
    }
    appendMessage("user", "你", questionResolutionText(event));
    els.runStatus.textContent = "运行中";
    state.running = true;
    scheduleSessionsRefresh();
    updateSendButton();
    setLiveTitle(event.cancelled ? "继续处理需求核对结果" : "继续处理你的确认");
    return;
  }
  if (event.type === "approval_resolved") {
    hideApproval();
    if (event.interrupted && state.pendingGuide) {
      els.runStatus.textContent = "引导中";
      setLiveTitle("引导已接管，等待当前轮次收束");
      updateSendButton();
      return;
    }
    els.runStatus.textContent = event.allowed ? "运行中" : "已拒绝";
    if (!event.allowed) {
      resetLiveStatus({ keepBackgroundSubagents: true });
    }
    return;
  }
  if (event.type === "assistant_final") {
    beginEventTurn(event);
    const finalSignature = normalizeComparableText(event.text);
    if (finalSignature && state.lastAssistantFinalSignature === finalSignature) {
      clearAssistantDrafts();
      return;
    }
    state.lastAssistantFinalSignature = finalSignature;
    collapseAssistantDrafts(event.text);
    collapseCompletedActivities();
    resetLiveStatus({ keepBackgroundSubagents: true });
    clearPendingGuide();
    appendMessage("assistant", "Ant Code", event.text);
    state.activeTurnId = "";
    els.runStatus.textContent = state.backgroundSubagents.size > 0 ? idleRunStatus("收尾中") : "收尾中";
    updateSendButton();
    scheduleSessionsRefresh();
    return;
  }
  if (event.type === "files_updated") {
    state.files = event.files ?? [];
    renderFiles();
    if (shouldKeepGuideFeedback()) {
      els.runStatus.textContent = "引导中";
      updateLiveStatus();
    } else {
      resetLiveStatus({ keepBackgroundSubagents: true });
      applyIdleRunStatus("完成");
      clearPendingGuide();
    }
    updateSendButton();
    scheduleSessionsRefresh();
    loadSessions();
    return;
  }
  if (event.type === "error") {
    if (state.pendingGuide && isInterruptError(event.message)) {
      els.runStatus.textContent = "引导中";
      updateLiveStatus();
      updateSendButton();
      return;
    }
    resetLiveStatus({ keepBackgroundSubagents: true });
    clearPendingGuide();
    showError(event.message ?? "任务失败");
    applyIdleRunStatus("失败");
    updateSendButton();
    scheduleSessionsRefresh();
  }
}

function shouldSkipDashboardEvent(event) {
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

function beginEventTurn(event) {
  const turnId = typeof event.turnId === "string" ? event.turnId : "";
  if (!turnId) {
    return;
  }
  if (state.activeTurnId && state.activeTurnId !== turnId) {
    collapseAssistantDrafts();
  }
  state.activeTurnId = turnId;
}

function renderTranscriptMessages(messages, options = {}) {
  const nodes = [];
  for (const message of messages) {
    const role = visibleTranscriptRole(message.role);
    if (!role) {
      continue;
    }
    const node = createMessageNode(role, role === "assistant" ? "Ant Code" : "你", messageDisplayText(message.content));
    node.setAttribute("aria-live", "off");
    nodes.push(node);
  }
  if (options.prepend) {
    hideEmptyState();
    const anchor = transcriptFirstContentNode();
    for (const node of nodes) {
      els.transcript.insertBefore(node, anchor);
    }
    trimTranscriptWindow({ direction: "prepend", preserveAnchor: false });
    return nodes;
  }
  for (const node of nodes) {
    appendTranscriptNode(node, { deferTrim: true });
  }
  trimTranscriptWindow({ direction: "append", preserveAnchor: !state.transcriptFollowing });
  return nodes;
}

function setTranscriptPaging(page = null) {
  state.transcriptPaging = {
    cursor: page?.cursor ?? page?.nextCursor ?? null,
    hasMore: page?.hasMore === true,
    loading: false,
    error: "",
    total: Number.isFinite(page?.total) ? page.total : 0
  };
  renderTranscriptHistoryStatus();
}

function renderTranscriptHistoryStatus() {
  if (!state.currentSessionId) {
    removeTranscriptHistoryStatus();
    return;
  }
  const paging = state.transcriptPaging;
  if (!paging.hasMore && !paging.loading && !paging.error) {
    removeTranscriptHistoryStatus();
    return;
  }
  if (!state.transcriptHistoryNode) {
    state.transcriptHistoryNode = document.createElement("button");
    state.transcriptHistoryNode.type = "button";
    state.transcriptHistoryNode.className = "history-loader";
    state.transcriptHistoryNode.addEventListener("click", () => loadOlderTranscript());
  }
  state.transcriptHistoryNode.disabled = paging.loading;
  state.transcriptHistoryNode.dataset.state = paging.error ? "error" : paging.loading ? "loading" : "idle";
  state.transcriptHistoryNode.textContent = paging.error
    ? "加载失败，点击重试"
    : paging.loading
      ? "正在加载更早记录"
      : "加载更早记录";
  if (els.transcript.firstChild !== state.transcriptHistoryNode) {
    els.transcript.insertBefore(state.transcriptHistoryNode, els.transcript.firstChild);
  }
}

function removeTranscriptHistoryStatus() {
  state.transcriptHistoryNode?.remove();
  state.transcriptHistoryNode = null;
}

function transcriptFirstContentNode() {
  let node = state.transcriptHistoryNode?.parentElement === els.transcript
    ? state.transcriptHistoryNode.nextSibling
    : els.transcript.firstChild;
  if (node === els.emptyState) node = node.nextSibling;
  return node;
}

function handleTranscriptScroll() {
  syncTranscriptFollowState();
  if (els.transcript.scrollTop > 180) {
    return;
  }
  if (!state.transcriptPaging.hasMore || state.transcriptPaging.loading) {
    return;
  }
  loadOlderTranscript();
}

async function loadOlderTranscript() {
  if (!state.currentSessionId || !state.transcriptPaging.hasMore || state.transcriptPaging.loading) {
    return;
  }
  const sessionId = state.currentSessionId;
  const request = beginScopedRequest("transcript", sessionId);
  const before = state.transcriptPaging.cursor;
  state.transcriptPaging.loading = true;
  state.transcriptPaging.error = "";
  renderTranscriptHistoryStatus();
  const previousHeight = els.transcript.scrollHeight;
  const previousTop = els.transcript.scrollTop;
  const anchor = transcriptFirstContentNode();
  const anchorTop = transcriptNodeTop(anchor);
  const result = await getJson(`/api/sessions/${encodeURIComponent(sessionId)}/transcript?${new URLSearchParams({
    before: before ?? "",
    limit: "100"
  }).toString()}`, { signal: request.signal })
    .catch((error) => ({ ok: false, error: error.message, aborted: isAbortError(error) }));
  if (!isCurrentScopedRequest(request) || state.currentSessionId !== sessionId) return;
  finishScopedRequest(request);
  state.transcriptPaging.loading = false;
  if (result.aborted) return;
  if (!result.ok) {
    state.transcriptPaging.error = result.error ?? "加载失败";
    renderTranscriptHistoryStatus();
    return;
  }
  state.transcriptPaging.cursor = result.transcriptPage?.cursor ?? result.transcriptPage?.nextCursor ?? null;
  state.transcriptPaging.hasMore = result.transcriptPage?.hasMore === true;
  state.transcriptPaging.total = Number.isFinite(result.transcriptPage?.total) ? result.transcriptPage.total : state.transcriptPaging.total;
  renderTranscriptMessages(result.transcript ?? [], { prepend: true });
  state.transcriptPaging.error = "";
  renderTranscriptHistoryStatus();
  if (!restoreTranscriptNodeAnchor(anchor, anchorTop)) {
    const delta = els.transcript.scrollHeight - previousHeight;
    els.transcript.scrollTop = previousTop + delta;
  }
}

function renderWorkflowPanel(workflow, summary = null) {
  if (!workflow || (!workflow.todos?.length && !workflow.plan?.steps?.length)) {
    state.workflow = null;
    state.workflowExpanded = false;
    renderWorkflowStrip();
    return;
  }
  hideEmptyState();
  state.workflow = workflow;
  if (!state.workflowNode) {
    state.workflowNode = document.createElement("section");
    state.workflowNode.className = "workflow-panel";
    appendTranscriptNode(state.workflowNode);
  }
  const totals = summary ?? summarizeWorkflow(workflow);
  const percent = totals.total > 0 ? Math.round((totals.completed / totals.total) * 100) : 0;
  state.workflowNode.innerHTML = `
    <div class="workflow-head">
      <div>
        <div class="workflow-kicker">任务进度</div>
        <div class="workflow-title">${totals.completed}/${totals.total} 已完成</div>
      </div>
      <div class="workflow-percent">${percent}%</div>
    </div>
    <div class="workflow-meter"><span style="width: ${percent}%"></span></div>
    ${workflow.todos?.length ? workflowSection("Todo", workflow.todos) : ""}
    ${workflow.plan?.steps?.length ? workflowSection("Plan", workflow.plan.steps) : ""}
  `;
  renderWorkflowStrip();
  scrollTranscript();
}

function renderWorkflowStrip() {
  if (!state.workflow || (!state.workflow.todos?.length && !state.workflow.plan?.steps?.length)) {
    els.workflowStrip.classList.add("hidden");
    els.workflowStrip.innerHTML = "";
    return;
  }
  const totals = summarizeWorkflow(state.workflow);
  const percent = totals.total > 0 ? Math.round((totals.completed / totals.total) * 100) : 0;
  const activeItem = currentWorkflowItem(state.workflow);
  const title = activeItem
    ? `正在：${activeItem.content ?? activeItem.title ?? ""}`
    : totals.completed === totals.total && totals.total > 0
      ? "任务已完成"
      : "等待下一步";
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
      ${state.workflow.todos?.length ? workflowSection("Todo", state.workflow.todos, Number.POSITIVE_INFINITY) : ""}
      ${state.workflow.plan?.steps?.length ? workflowSection("Plan", state.workflow.plan.steps, Number.POSITIVE_INFINITY) : ""}
    </div>` : ""}
  `;
}

function currentWorkflowItem(workflow) {
  const items = [...(workflow.todos ?? []), ...(workflow.plan?.steps ?? [])];
  return items.find((item) => normalizeWorkflowStatus(item.status) === "in_progress")
    ?? items.find((item) => normalizeWorkflowStatus(item.status) === "pending")
    ?? null;
}

function workflowSection(label, items, limit = 8) {
  return `
    <div class="workflow-section">
      <div class="workflow-section-title">${label}</div>
      <div class="workflow-list">
        ${items.slice(0, limit).map((item) => workflowItem(item)).join("")}
      </div>
    </div>
  `;
}

function workflowItem(item) {
  const status = normalizeWorkflowStatus(item.status);
  return `
    <div class="workflow-item ${status}">
      <span class="workflow-mark"></span>
      <span class="workflow-text">${escapeHtml(item.content ?? item.title ?? "")}</span>
    </div>
  `;
}

function normalizeWorkflowStatus(status) {
  if (status === "completed" || status === "in_progress" || status === "cancelled") {
    return status;
  }
  return "pending";
}

function summarizeWorkflow(workflow) {
  const items = [...(workflow.todos ?? []), ...(workflow.plan?.steps ?? [])];
  return {
    total: items.length,
    pending: items.filter((item) => item.status === "pending").length,
    in_progress: items.filter((item) => item.status === "in_progress").length,
    completed: items.filter((item) => item.status === "completed").length,
    cancelled: items.filter((item) => item.status === "cancelled").length
  };
}

function appendMessage(kind, label, text) {
  const wasAtBottom = isTranscriptNearBottom();
  const node = createMessageNode(kind, label, text);
  appendTranscriptNode(node);
  scrollTranscript({ onlyIfNearBottom: true, wasAtBottom });
  if (kind === "assistant") announceStatus("收到新的助手回复");
}

function createMessageNode(kind, label, text) {
  hideEmptyState();
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

function appendTranscriptNode(node, options = {}) {
  hideEmptyState();
  els.transcript.append(node);
  if (!options.deferTrim) {
    trimTranscriptWindow({ direction: "append", preserveAnchor: !state.transcriptFollowing });
  }
}

function trimTranscriptWindow(options = {}) {
  const direction = options.direction === "prepend" ? "prepend" : "append";
  const windowSide = direction === "prepend" ? "newer" : "older";
  const markerKey = `${windowSide}Node`;
  const willAddMarker = !state.transcriptWindow[markerKey];
  const limit = Math.max(1, TRANSCRIPT_DOM_LIMIT - (willAddMarker ? 1 : 0));
  const nodes = Array.from(els.transcript.children ?? []);
  const toRemove = selectTranscriptNodesToRemove(nodes, limit, direction, isProtectedTranscriptNode);
  if (toRemove.length === 0) return 0;
  const anchor = options.preserveAnchor ? captureTranscriptViewportAnchor(new Set(toRemove)) : null;
  for (const node of toRemove) node.remove();
  const countKey = windowSide === "newer" ? "unloadedNewer" : "unloadedOlder";
  state.transcriptWindow[countKey] += toRemove.length;
  renderTranscriptWindowMarker(windowSide);
  restoreTranscriptViewportAnchor(anchor);
  return toRemove.length;
}

function isProtectedTranscriptNode(node) {
  return node === els.emptyState
    || node === state.transcriptHistoryNode
    || node === state.workflowNode
    || node === state.transcriptWindow.olderNode
    || node === state.transcriptWindow.newerNode
    || node?.classList?.contains("draft-message");
}

function renderTranscriptWindowMarker(side) {
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

function captureTranscriptViewportAnchor(excluded = new Set()) {
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

function restoreTranscriptViewportAnchor(anchor) {
  if (!anchor || anchor.node?.parentElement !== els.transcript) return false;
  const transcriptTop = els.transcript.getBoundingClientRect?.().top ?? 0;
  const nextTop = anchor.node.getBoundingClientRect?.().top;
  if (!Number.isFinite(nextTop)) return false;
  els.transcript.scrollTop += nextTop - transcriptTop - anchor.offset;
  return true;
}

function transcriptNodeTop(node) {
  return node?.parentElement === els.transcript ? node.getBoundingClientRect?.().top : null;
}

function restoreTranscriptNodeAnchor(node, previousTop) {
  if (!Number.isFinite(previousTop) || node?.parentElement !== els.transcript) return false;
  const nextTop = node.getBoundingClientRect?.().top;
  if (!Number.isFinite(nextTop)) return false;
  els.transcript.scrollTop += nextTop - previousTop;
  return true;
}

function resetTranscriptWindow() {
  state.transcriptWindow.olderNode?.remove();
  state.transcriptWindow.newerNode?.remove();
  state.transcriptWindow = {
    unloadedOlder: 0,
    unloadedNewer: 0,
    olderNode: null,
    newerNode: null
  };
}

function appendAssistantDraft(event) {
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

function scheduleDraftRender(draft) {
  scheduleAnimationFrameOnce(draft, "renderFrame", () => renderAssistantDraft(draft));
}

function renderAssistantDraft(draft, options = {}) {
  const wasAtBottom = isTranscriptNearBottom();
  if (options.force) cancelScheduledAnimationFrame(draft, "renderFrame");
  if (draft.renderedLength === draft.text.length) {
    return;
  }
  draft.renderedLength = appendPlainDraftDelta(draft.body, draft.text, draft.renderedLength);
  scrollTranscript({ onlyIfNearBottom: true, wasAtBottom });
}

function appendActivity(activity) {
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
  if (["danger", "warning"].includes(activity.severity)) announceStatus(activity.title);
}

function appendContextBoundary(event = {}) {
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

function contextBoundaryText(event = {}) {
  const detail = String(event.detail ?? "").trim();
  if (detail) {
    return `${event.title ?? "聊天内容已压缩"}，${detail}`;
  }
  return "聊天内容已压缩，以下回复基于压缩后的上下文继续";
}

function handleActivity(activity) {
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

function isBackgroundSubagentActivity(activity) {
  return activity?.backgroundSubagent === true || String(activity?.rawType ?? "").startsWith("subagent_group_");
}

function handleBackgroundSubagentActivity(activity) {
  const key = activity.coalesceKey || activity.groupId || activity.taskId || activity.id;
  const previous = state.backgroundSubagents.get(key) ?? {};
  const merged = {
    ...previous,
    ...activity,
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

function clearBackgroundSubagentStatus(groupId) {
  const id = String(groupId ?? "").trim();
  if (id) {
    state.backgroundSubagents.delete(`subagent-group:${id}`);
    for (const [key, item] of state.backgroundSubagents.entries()) {
      if (item.groupId === id) {
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

function reconcileBackgroundSubagentSnapshot(groups) {
  const visibleGroups = Array.isArray(groups) ? groups.filter(backgroundSubagentVisible) : [];
  const nextKeys = new Set();
  for (const group of visibleGroups) {
    const id = String(group.groupId ?? group.taskId ?? "").trim();
    if (!id) {
      continue;
    }
    const key = `subagent-group:${id}`;
    nextKeys.add(key);
    const previous = state.backgroundSubagents.get(key) ?? {};
    state.backgroundSubagents.set(key, {
      ...previous,
      backgroundSubagent: true,
      coalesceKey: key,
      rawType: "background_subagent_snapshot",
      title: group.kind === "terminal" ? "终端后台运行中" : group.status === "waiting" ? "等待子智能体唤醒主控" : "子智能体后台运行中",
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
    if ((item.groupId || String(key).startsWith("subagent-group:")) && !nextKeys.has(key)) {
      state.backgroundSubagents.delete(key);
    }
  }
  if (state.backgroundSubagents.size === 0) {
    state.liveStatusExpanded = false;
  }
  updateLiveStatus();
  applyIdleRunStatus("完成");
}

function backgroundSubagentDisplayStatus(activity, previous) {
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

function backgroundSubagentVisible(activity) {
  return activity.status === "starting" || activity.status === "running" || activity.status === "waiting" || activity.status === "stale" || activity.status === "lost";
}

function updateLiveActivity(activity) {
  const key = activity.coalesceKey || activity.toolUseId || activity.id;
  state.liveActivities.set(key, activity);
  setLiveTitle(activity.title || "正在处理");
}

function removeLiveActivity(activity) {
  const key = activity.coalesceKey || activity.toolUseId || activity.id;
  state.liveActivities.delete(key);
  updateLiveStatus();
}

function setLiveTitle(title) {
  state.liveTitle = title;
  updateLiveStatus();
}

function toggleLiveStatusDetails() {
  if (state.backgroundSubagents.size === 0) {
    return;
  }
  state.liveStatusExpanded = !state.liveStatusExpanded;
  updateLiveStatus();
}

function updateLiveStatus() {
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
  const primary = active.find((activity) => activity.toolName !== "agent_run") || active[0];
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

function liveStatusTitle(primary, subtasks, background) {
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

function gatewayRetryChipText(activity) {
  const attempt = Number.isFinite(activity.retryAttempt) && Number.isFinite(activity.retryMaxAttempts)
    ? `${activity.retryAttempt}/${activity.retryMaxAttempts}`
    : "";
  const code = activity.retryCode ? String(activity.retryCode) : "gateway";
  const delay = Number.isFinite(activity.retryDelayMs) ? `${activity.retryDelayMs}ms` : "";
  return ["重试", attempt, code, delay].filter(Boolean).join(" · ");
}

function renderBackgroundSubagentStatus(background) {
  if (background.length === 0) {
    return;
  }
  const ordered = background.sort((left, right) => String(right.at ?? "").localeCompare(String(left.at ?? "")));
  if (!state.liveStatusExpanded) {
    for (const item of ordered.slice(0, 3)) {
      const chip = document.createElement("div");
      chip.className = `live-chip background-subagent-chip ${item.status}`;
      chip.innerHTML = `
        <span class="chip-pulse" aria-hidden="true"></span>
        ${escapeHtml(backgroundSubagentCompactLabel(item))}
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

function backgroundSubagentCompactLabel(item) {
  if (item.kind === "terminal") {
    if (item.status === "starting") return "终端任务启动中";
    if (item.status === "stale") return "终端任务回收中";
    return "终端后台运行";
  }
  const profile = item.profile ? `${item.profile} ` : "";
  if (item.status === "waiting") return `${profile}等待唤醒`;
  if (item.status === "lost") return `${profile}疑似失联`;
  if (item.status === "stale") return `${profile}无进展`;
  return `${profile}后台运行`;
}

function backgroundSubagentTitle(item) {
  if (item.kind === "terminal") {
    if (item.status === "starting") return "终端后台任务启动中";
    if (item.status === "stale") return "终端后台任务回收中";
    return "终端后台任务运行中";
  }
  const profile = item.profile ? `${item.profile} ` : "";
  if (item.status === "waiting") return `${profile}等待主控接续`;
  if (item.status === "lost") return `${profile}子智能体疑似失联`;
  if (item.status === "stale") return `${profile}子智能体长时间无进展`;
  return `${profile}子智能体运行中`;
}

function backgroundSubagentMeta(item) {
  if (item.kind === "terminal") {
    return [
      item.taskId ? `task=${item.taskId}` : null,
      item.status === "starting" ? "启动中" : null,
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

function backgroundSubagentCancellable(item) {
  return item.cancellable !== false && (item.status === "starting" || item.status === "running" || item.status === "stale" || item.status === "lost");
}

function resetLiveStatus(options = {}) {
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

function backgroundSubagentCounts() {
  const items = Array.from(state.backgroundSubagents.values()).filter(backgroundSubagentVisible);
  const subagents = items.filter((item) => item.kind !== "terminal");
  const terminals = items.filter((item) => item.kind === "terminal");
  return {
    running: subagents.filter((item) => item.status === "running").length,
    terminalStarting: terminals.filter((item) => item.status === "starting").length,
    terminals: terminals.filter((item) => item.status === "running").length,
    terminalStale: terminals.filter((item) => item.status === "stale").length,
    stale: subagents.filter((item) => item.status === "stale").length,
    lost: subagents.filter((item) => item.status === "lost").length,
    waiting: subagents.filter((item) => item.status === "waiting").length
  };
}

function idleRunStatus(fallback) {
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

function applyIdleRunStatus(fallback = "空闲") {
  if (state.running) {
    return;
  }
  els.runStatus.textContent = idleRunStatus(fallback);
}

function updateRunStatusForBackground(fallback = "空闲") {
  if (state.running) {
    return;
  }
  const current = els.runStatus.textContent.trim();
  const base = /子智能体|终端后台任务|唤醒/.test(current) ? fallback : current || fallback;
  els.runStatus.textContent = idleRunStatus(base);
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
  state.models = markCurrentModel(state.models, state.sessionStatus.model);
  renderComposerStatus();
}

function updateTurnChangeStats(stats, options = {}) {
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

function resetTurnChangeStats() {
  state.turnChangeStats = { additions: 0, deletions: 0, files: 0, redacted: false, truncated: false, approximate: false };
  renderComposerStatus();
}

function normalizeChangeStats(stats) {
  return {
    additions: nonNegativeInteger(stats.additions),
    deletions: nonNegativeInteger(stats.deletions),
    files: nonNegativeInteger(stats.files),
    redacted: stats.redacted === true,
    truncated: stats.truncated === true,
    approximate: stats.approximate === true
  };
}

function renderComposerStatus() {
  if (!els.modelStatus || !els.contextStatus || !els.changeStatus) {
    return;
  }
  const model = state.sessionStatus?.model || "";
  const modelInfo = currentModelInfo(model);
  const context = state.sessionStatus?.context ?? null;
  els.modelStatus.innerHTML = modelStatusHtml(modelInfo, model);
  const toggle = els.modelStatus.querySelector("#model-status-toggle");
  if (toggle) {
    toggle.disabled = state.running || state.modelSwitching;
  }
  els.contextStatus.textContent = `上下文 ${formatContextUsage(context)}`;

  const stats = state.turnChangeStats ?? {};
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

function modelStatusHtml(modelInfo, fallbackModel) {
  const label = modelInfo?.label || fallbackModel || "未配置";
  const tags = modelCapabilityLabels(modelInfo).slice(0, 2);
  return `
    <span class="model-status-main">模型 ${escapeHtml(label)}</span>
    ${tags.map((tag) => `<span class="model-status-tag">${escapeHtml(tag)}</span>`).join("")}
    <button class="model-status-caret-button" id="model-status-toggle" type="button" aria-haspopup="dialog" aria-expanded="${state.modelPanelOpen ? "true" : "false"}" aria-label="切换模型">
      <span class="model-status-caret" aria-hidden="true">▾</span>
    </button>
  `;
}

function handleModelStatusActivate(event) {
  const toggle = event.target.closest("#model-status-toggle");
  if (!toggle || toggle.disabled || (event.type === "click" && event.detail === 0)) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  toggleModelPanel();
}

function handleModelStatusKeydown(event) {
  const toggle = event.target.closest("#model-status-toggle");
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

function toggleModelPanel() {
  const toggle = els.modelStatus.querySelector("#model-status-toggle");
  if (toggle?.disabled) {
    return;
  }
  state.modelPanelOpen = !state.modelPanelOpen;
  renderModelPanel();
  renderComposerStatus();
}

function hideModelPanel() {
  state.modelPanelOpen = false;
  state.deleteConfirmModelId = "";
  renderModelPanel();
  renderComposerStatus();
}

function showModelConfigPanel(modelId = "") {
  const returnFocus = document.activeElement;
  state.editingModelId = String(modelId ?? "").trim();
  state.modelConfigOpen = true;
  renderModelConfigPanel();
  activateModal(els.modelConfigPanel, {
    initialFocus: "input[name='gatewayUrl']",
    returnFocus
  });
}

function hideModelConfigPanel() {
  if (state.modelConfigSaving) {
    return;
  }
  deactivateModal(els.modelConfigPanel, { fallbackFocus: "#model-status-toggle" });
  state.modelConfigOpen = false;
  state.editingModelId = "";
  renderModelConfigPanel();
}

function renderModelPanel() {
  if (!els.modelPanel) {
    return;
  }
  els.modelPanel.classList.toggle("hidden", !state.modelPanelOpen);
  if (!state.modelPanelOpen) {
    els.modelPanel.replaceChildren();
    return;
  }
  const models = state.models ?? [];
  const syncable = models.some((model) => hasAgentModelTiers(model));
  const profiles = state.gatewayProfiles ?? [];
  els.modelPanel.innerHTML = `
    <div class="model-panel-head">
      <div>
        <div class="model-panel-title">切换模型</div>
        <div class="model-panel-subtitle">${escapeHtml(gatewaySummary())}</div>
      </div>
      <div class="model-panel-actions">
        ${models.some((model) => model.current) ? `<button type="button" class="model-manage-button" data-action="edit-current-model">编辑当前</button>` : ""}
        <button type="button" class="model-manage-button" data-action="open-model-config">添加模型</button>
      </div>
    </div>
    <label class="model-agent-sync">
      <input type="checkbox" data-action="toggle-agent-defaults"${state.applyAgentDefaultsOnSwitch ? " checked" : ""}${syncable ? "" : " disabled"} />
      <span>切换时同步子智能体默认模型</span>
    </label>
    ${profiles.length > 1 ? `
      <div class="gateway-profile-list" aria-label="切换网关">
        ${profiles.map((profile) => gatewayProfileOptionHtml(profile)).join("")}
      </div>
    ` : ""}
    <div class="model-panel-list">
      ${models.map((model) => modelOptionHtml(model)).join("") || `<div class="model-panel-empty">没有已注册模型</div>`}
    </div>
  `;
}

function gatewayProfileOptionHtml(profile) {
  const keyLabel = profile.apiKeyConfigured ? "Key" : "无 Key";
  const count = Number.isFinite(profile.modelCount) ? `${profile.modelCount} 模型` : "";
  return `
    <button type="button" class="gateway-profile-option${profile.current ? " active" : ""}" data-profile-id="${escapeAttribute(profile.id)}">
      <span class="gateway-profile-main">${escapeHtml(profile.label || profile.gatewayUrl || profile.id)}</span>
      <span class="gateway-profile-meta">${escapeHtml([profile.gatewayProtocol, keyLabel, count].filter(Boolean).join(" · "))}</span>
    </button>
  `;
}

function modelOptionHtml(model) {
  const tags = modelCapabilityLabels(model);
  const context = Number.isFinite(model.contextTokens) ? `${formatTokenCount(model.contextTokens)} 上下文` : "";
  const defaultSource = model.default ? sourceBadge(model.sources?.modelAlias) : "";
  const agentDefaults = agentModelTiersSummary(model.agentModelTiers);
  const confirmingDelete = state.deleteConfirmModelId === model.id;
  const deleting = state.deletingModelId === model.id;
  const deleteLabel = deleting ? "删除中" : confirmingDelete ? "确认删除" : "删除";
  const isLastModel = (state.models ?? []).length <= 1;
  const confirmCopy = isLastModel
    ? "再次点击确认删除；这是当前网关最后一个模型，会清空当前网关配置。"
    : "再次点击确认删除；如删除当前模型，会自动切到同一网关的下一个模型。";
  return `
    <div class="model-option-row${model.current ? " active" : ""}${confirmingDelete ? " confirming-delete" : ""}" data-model-row-id="${escapeAttribute(model.id)}">
      <button type="button" class="model-option" data-model-id="${escapeAttribute(model.id)}" ${state.modelSwitching || state.deletingModelId ? "disabled" : ""}>
        <span class="model-option-head">
          <span class="model-option-name">${escapeHtml(model.label || model.id)}</span>
          ${model.current ? `<span class="model-option-current">当前</span>` : ""}
        </span>
        <span class="model-option-id">${escapeHtml(model.id)}</span>
        <span class="model-option-tags">
          ${tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}
          ${context ? `<span>${escapeHtml(context)}</span>` : ""}
          ${defaultSource ? `<span>默认：${escapeHtml(defaultSource)}</span>` : ""}
        </span>
        ${agentDefaults ? `<span class="model-option-agent">子智能体 ${escapeHtml(agentDefaults)}</span>` : ""}
      </button>
      <button type="button" class="model-edit-button" data-action="edit-model" data-model-id="${escapeAttribute(model.id)}" ${state.running || Boolean(state.deletingModelId) ? "disabled" : ""} title="编辑这个模型配置">编辑</button>
      <button type="button" class="model-delete-button${confirmingDelete ? " confirm" : ""}" data-action="delete-model" data-model-id="${escapeAttribute(model.id)}" ${state.running || Boolean(state.deletingModelId) ? "disabled" : ""} title="${confirmingDelete ? "再次点击确认删除" : "删除这个已注册模型"}">${deleteLabel}</button>
      ${confirmingDelete ? `<div class="model-delete-confirm-copy">${escapeHtml(confirmCopy)}</div>` : ""}
    </div>
  `;
}

function modelCapabilityLabels(model) {
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

async function handleModelPanelClick(event) {
  event.stopPropagation();
  const action = event.target.closest("button[data-action]");
  if (action?.dataset.action === "open-model-config") {
    showModelConfigPanel();
    return;
  }
  if (action?.dataset.action === "edit-current-model") {
    const current = (state.models ?? []).find((model) => model.current);
    showModelConfigPanel(current?.id ?? state.sessionStatus?.model ?? "");
    return;
  }
  if (action?.dataset.action === "edit-model") {
    showModelConfigPanel(action.dataset.modelId);
    return;
  }
  if (action?.dataset.action === "delete-model") {
    await deleteModel(action.dataset.modelId);
    return;
  }
  const toggle = event.target.closest("input[data-action='toggle-agent-defaults']");
  if (toggle) {
    state.applyAgentDefaultsOnSwitch = toggle.checked;
    return;
  }
  const profileButton = event.target.closest("button[data-profile-id]");
  if (profileButton) {
    await switchGatewayProfile(profileButton.dataset.profileId);
    return;
  }
  const button = event.target.closest("button[data-model-id]");
  if (!button) {
    return;
  }
  state.deleteConfirmModelId = "";
  await switchModel(button.dataset.modelId);
}

function renderModelConfigPanel() {
  if (!els.modelConfigPanel) {
    return;
  }
  els.modelConfigPanel.classList.toggle("hidden", !state.modelConfigOpen);
  if (!state.modelConfigOpen) {
    els.modelConfigPanel.replaceChildren();
    return;
  }
  const editing = state.editingModelId ? currentModelInfo(state.editingModelId) : null;
  const current = editing ?? currentModelInfo(state.sessionStatus?.model) ?? state.models.find((model) => model.current) ?? {};
  const gateway = state.gatewayConfig ?? {};
  const sourceNote = gatewaySourceNote(gateway);
  const keySource = sourceLabel(gateway.sources?.apiKey);
  const gatewayDefaultNote = environmentGatewayDefaultNote(gateway);
  const currentAgentTiers = {
    cheap: current.agentModelTiers?.cheap ?? state.agentModelTiers?.cheap ?? "",
    default: current.agentModelTiers?.default ?? state.agentModelTiers?.default ?? "",
    strong: current.agentModelTiers?.strong ?? state.agentModelTiers?.strong ?? ""
  };
  const visionAgentModel = state.visionAgent?.model ?? firstVisionModelId() ?? "";
  els.modelConfigPanel.innerHTML = `
    <button class="model-config-backdrop" type="button" data-action="close-model-config" aria-label="关闭模型配置"></button>
    <form class="model-config-card" id="model-config-form">
      <div class="model-config-head">
        <div>
          <div class="model-config-kicker">${editing ? "当前项目配置" : "保存到当前项目"}</div>
          <h2 id="model-config-title">${editing ? "编辑模型网关" : "添加模型网关"}</h2>
        </div>
        <button class="icon-button" type="button" data-action="close-model-config" title="关闭">×</button>
      </div>
      <div class="model-config-grid">
        <label>
          <span>网关 URL</span>
          <input name="gatewayUrl" type="url" required spellcheck="false" value="${escapeAttribute(gateway.gatewayUrl || "")}" placeholder="https://example.com/v1/chat/completions" />
        </label>
        <label>
          <span>协议</span>
          <select name="gatewayProtocol">
            <option value="openai-chat"${gateway.gatewayProtocol === "openai-chat" ? " selected" : ""}>OpenAI Chat Completions</option>
            <option value="lab-agent-gateway"${gateway.gatewayProtocol === "lab-agent-gateway" ? " selected" : ""}>Ant Code Gateway</option>
          </select>
        </label>
        <label>
          <span>API Key</span>
          <input name="gatewayApiKey" type="password" autocomplete="new-password" spellcheck="false" placeholder="${gateway.apiKeyConfigured ? `已配置，来自${keySource}，留空则保留` : "可选"}" />
        </label>
        <label>
          <span>健康检查 URL</span>
          <input name="gatewayHealthUrl" type="url" spellcheck="false" value="${escapeAttribute(gateway.gatewayHealthUrl || "")}" placeholder="可选" />
        </label>
        <label>
          <span>模型 ID</span>
          <input name="modelId" required spellcheck="false" value="${escapeAttribute(current.id || "")}" placeholder="example-coding-model" />
        </label>
        <label>
          <span>显示名称</span>
          <input name="label" spellcheck="false" value="${escapeAttribute(current.label || "")}" placeholder="Example Coding Model" />
        </label>
        <label>
          <span>上下文窗口</span>
          <input name="contextTokens" inputmode="numeric" pattern="[0-9]*" value="${escapeAttribute(current.contextTokens || "")}" placeholder="例如 400000" />
        </label>
        <label>
          <span>子智能体 cheap</span>
          <input name="agentCheapModel" spellcheck="false" value="${escapeAttribute(currentAgentTiers.cheap)}" placeholder="例如 v4-flash" />
        </label>
        <label>
          <span>子智能体 default</span>
          <input name="agentDefaultModel" spellcheck="false" value="${escapeAttribute(currentAgentTiers.default)}" placeholder="例如 example-coding-model" />
        </label>
        <label>
          <span>子智能体 strong</span>
          <input name="agentStrongModel" spellcheck="false" value="${escapeAttribute(currentAgentTiers.strong)}" placeholder="例如 example-strong-model" />
        </label>
        <label>
          <span>视觉子智能体</span>
          <input name="visionAgentModel" spellcheck="false" value="${escapeAttribute(visionAgentModel)}" placeholder="例如 example-vision-model" />
        </label>
      </div>
      <div class="model-config-toggles">
        <label><input name="text" type="checkbox" checked disabled /> 文本</label>
        <label><input name="vision" type="checkbox"${Array.isArray(current.modalities) && current.modalities.includes("image") ? " checked" : ""} /> 视觉</label>
        <label><input name="thinking" type="checkbox"${current.thinking ? " checked" : ""} /> thinking</label>
        <label><input name="switchToModel" type="checkbox"${editing && !current.current ? "" : " checked"} /> 保存后切换到这个模型</label>
        <label><input name="applyAgentDefaults" type="checkbox" /> 保存后同步子智能体</label>
      </div>
      <div class="model-config-note">
        <div>${escapeHtml(sourceNote)}</div>
        ${gatewayDefaultNote ? `<div>${escapeHtml(gatewayDefaultNote)}</div>` : ""}
        <div>保存后写入 .lab-agent/config.json，作为这个项目的默认配置。Key 不会在这里回显。</div>
      </div>
      <div class="model-config-actions">
        <button type="button" data-action="close-model-config">取消</button>
        <button type="submit" ${state.modelConfigSaving ? "disabled" : ""}>${state.modelConfigSaving ? "保存中" : "保存并使用"}</button>
      </div>
    </form>
  `;
}

function handleModelConfigPanelClick(event) {
  const action = event.target.closest("button[data-action]");
  if (action?.dataset.action === "close-model-config") {
    hideModelConfigPanel();
  }
}

async function saveModelConfig(event) {
  event.preventDefault();
  if (state.modelConfigSaving) {
    return;
  }
  const form = event.target.closest("form");
  if (!form) {
    return;
  }
  const data = new FormData(form);
  const payload = {
    gatewayUrl: data.get("gatewayUrl"),
    gatewayProtocol: data.get("gatewayProtocol"),
    gatewayApiKey: data.get("gatewayApiKey"),
    gatewayHealthUrl: data.get("gatewayHealthUrl"),
    previousModelId: state.editingModelId,
    modelId: data.get("modelId"),
    label: data.get("label"),
    contextTokens: data.get("contextTokens"),
    agentCheapModel: data.get("agentCheapModel"),
    agentDefaultModel: data.get("agentDefaultModel"),
    agentStrongModel: data.get("agentStrongModel"),
    visionAgentModel: data.get("visionAgentModel"),
    modalities: data.get("vision") ? ["text", "image"] : ["text"],
    thinking: data.get("thinking") === "on",
    switchToModel: data.get("switchToModel") === "on",
    applyAgentDefaults: data.get("applyAgentDefaults") === "on",
    sessionId: state.currentSessionId
  };
  state.modelConfigSaving = true;
  renderModelConfigPanel();
  try {
    const result = await postJson("/api/model-config", payload);
    if (!result.ok) {
      throw new Error(result.error ?? "保存模型配置失败");
    }
    state.models = normalizeModels(result.models);
    mergeGatewayConfig(result.gatewayConfig);
    state.gatewayProfiles = normalizeGatewayProfiles(result.gatewayProfiles);
    state.agentModelTiers = normalizeAgentModelTiers(result.agentModelTiers);
    state.visionAgent = normalizeVisionAgent(result.visionAgent);
    updateSessionStatus(result.sessionStatus);
    state.modelConfigSaving = false;
    hideModelConfigPanel();
    hideModelPanel();
    if (payload.switchToModel) {
      const activeModelId = String(result.sessionStatus?.model ?? payload.modelId ?? "").trim();
      showNotice("模型配置已保存", `模型已切换为 ${modelDisplayName(activeModelId, payload.label || payload.modelId)}`);
    } else {
      showNotice("模型配置已保存", "本地配置已更新");
    }
  } catch (error) {
    showError(error.message ?? "保存模型配置失败");
  } finally {
    state.modelConfigSaving = false;
    if (state.modelConfigOpen) {
      renderModelConfigPanel();
    }
    renderComposerStatus();
  }
}

async function switchModel(modelId) {
  if (!modelId || state.modelSwitching) {
    return;
  }
  state.modelSwitching = true;
  renderComposerStatus();
  try {
    const result = await postJson("/api/model", {
      modelId,
      sessionId: state.currentSessionId,
      applyAgentDefaults: state.applyAgentDefaultsOnSwitch
    });
    if (!result.ok) {
      throw new Error(result.error ?? "切换模型失败");
    }
    state.models = normalizeModels(result.models);
    mergeGatewayConfig(result.gatewayConfig);
    state.gatewayProfiles = normalizeGatewayProfiles(result.gatewayProfiles);
    state.agentModelTiers = normalizeAgentModelTiers(result.agentModelTiers);
    state.visionAgent = normalizeVisionAgent(result.visionAgent);
    updateSessionStatus(result.sessionStatus);
    hideModelPanel();
    showNotice("模型已切换", `当前会话将使用 ${modelDisplayName(modelId)}`);
  } catch (error) {
    showError(error.message ?? "切换模型失败");
  } finally {
    state.modelSwitching = false;
    renderComposerStatus();
  }
}

async function switchGatewayProfile(profileId) {
  if (!profileId || state.modelSwitching) {
    return;
  }
  state.modelSwitching = true;
  renderComposerStatus();
  try {
    const result = await postJson("/api/gateway-profile", {
      profileId,
      sessionId: state.currentSessionId
    });
    if (!result.ok) {
      throw new Error(result.error ?? "切换网关失败");
    }
    state.models = normalizeModels(result.models);
    mergeGatewayConfig(result.gatewayConfig);
    state.gatewayProfiles = normalizeGatewayProfiles(result.gatewayProfiles);
    state.agentModelTiers = normalizeAgentModelTiers(result.agentModelTiers);
    state.visionAgent = normalizeVisionAgent(result.visionAgent);
    updateSessionStatus(result.sessionStatus);
    hideModelPanel();
    showNotice("网关已切换");
  } catch (error) {
    showError(error.message ?? "切换网关失败");
  } finally {
    state.modelSwitching = false;
    renderComposerStatus();
  }
}

async function deleteModel(modelId) {
  if (!modelId || state.deletingModelId || state.modelSwitching) {
    return;
  }
  if (state.deleteConfirmModelId !== modelId) {
    state.deleteConfirmModelId = modelId;
    renderModelPanel();
    return;
  }
  state.deletingModelId = modelId;
  renderModelPanel();
  renderComposerStatus();
  try {
    const result = await deleteJson(`/api/model-config/${encodeURIComponent(modelId)}`, {
      sessionId: state.currentSessionId
    });
    if (!result.ok) {
      throw new Error(result.error ?? "删除模型失败");
    }
    state.models = normalizeModels(result.models);
    mergeGatewayConfig(result.gatewayConfig);
    state.gatewayProfiles = normalizeGatewayProfiles(result.gatewayProfiles);
    state.agentModelTiers = normalizeAgentModelTiers(result.agentModelTiers);
    state.visionAgent = normalizeVisionAgent(result.visionAgent);
    state.deleteConfirmModelId = "";
    updateSessionStatus(result.sessionStatus);
    renderModelPanel();
    showNotice(result.clearedGateway ? "当前网关配置已清空" : "模型配置已删除");
  } catch (error) {
    showError(error.message ?? "删除模型失败");
  } finally {
    state.deletingModelId = "";
    renderModelPanel();
    renderComposerStatus();
  }
}

function normalizeGatewayConfig(value) {
  return {
    gatewayUrl: String(value?.gatewayUrl ?? ""),
    gatewayHealthUrl: String(value?.gatewayHealthUrl ?? ""),
    gatewayProtocol: String(value?.gatewayProtocol ?? "openai-chat"),
    apiKeyConfigured: value?.apiKeyConfigured === true,
    activeProfileId: String(value?.activeProfileId ?? ""),
    sources: {
      gatewayUrl: normalizeConfigSource(value?.sources?.gatewayUrl),
      gatewayHealthUrl: normalizeConfigSource(value?.sources?.gatewayHealthUrl),
      gatewayProtocol: normalizeConfigSource(value?.sources?.gatewayProtocol),
      apiKey: normalizeConfigSource(value?.sources?.apiKey)
    }
  };
}

function mergeGatewayConfig(value) {
  if (!value || typeof value !== "object") {
    return;
  }
  state.gatewayConfig = normalizeGatewayConfig(value);
}

function normalizeGatewayProfiles(value) {
  return Array.isArray(value) ? value.map((profile) => ({
    id: String(profile.id ?? ""),
    label: String(profile.label ?? profile.id ?? ""),
    gatewayUrl: String(profile.gatewayUrl ?? ""),
    gatewayProtocol: String(profile.gatewayProtocol ?? "openai-chat"),
    apiKeyConfigured: profile.apiKeyConfigured === true,
    modelAlias: String(profile.modelAlias ?? ""),
    modelCount: Number.isFinite(Number(profile.modelCount)) ? Number(profile.modelCount) : 0,
    current: profile.current === true
  })).filter((profile) => profile.id) : [];
}

function normalizeConfigSource(value) {
  return {
    type: String(value?.type ?? "default"),
    label: String(value?.label ?? value?.type ?? "default")
  };
}

function normalizeModels(models) {
  return Array.isArray(models) ? models.map((model) => ({
    id: String(model.id ?? ""),
    label: String(model.label ?? model.id ?? ""),
    description: String(model.description ?? ""),
    thinking: model.thinking === true,
    modalities: Array.isArray(model.modalities) ? model.modalities.map(String) : ["text"],
    contextTokens: Number.isFinite(Number(model.contextTokens)) ? Number(model.contextTokens) : null,
    agentModelTiers: normalizeAgentModelTiers(model.agentModelTiers),
    sources: {
      modelAlias: normalizeConfigSource(model.sources?.modelAlias),
      models: normalizeConfigSource(model.sources?.models)
    },
    current: model.current === true,
    default: model.default === true
  })).filter((model) => model.id) : [];
}

function markCurrentModel(models, currentModel) {
  const current = String(currentModel ?? "");
  return normalizeModels(models).map((model) => ({
    ...model,
    current: model.id === current
  }));
}

function currentModelInfo(modelId) {
  return (state.models ?? []).find((model) => model.id === modelId) ?? null;
}

function modelDisplayName(modelId, fallback = "") {
  const id = String(modelId ?? "").trim();
  const fallbackLabel = String(fallback ?? "").trim();
  const model = currentModelInfo(id);
  return model?.label || fallbackLabel || id || "当前模型";
}

function normalizeAgentModelTiers(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(Object.entries(value)
    .map(([tier, model]) => [String(tier ?? "").trim(), String(model ?? "").trim()])
    .filter(([tier, model]) => tier && model));
}

function normalizeVisionAgent(value) {
  if (!value || typeof value !== "object") {
    return { enabled: true, model: "", autoUseWhenMainModelTextOnly: true };
  }
  return {
    enabled: value.enabled !== false,
    model: String(value.model ?? "").trim(),
    autoUseWhenMainModelTextOnly: value.autoUseWhenMainModelTextOnly !== false
  };
}

function firstVisionModelId() {
  return (state.models ?? []).find((model) => Array.isArray(model.modalities) && model.modalities.includes("image"))?.id ?? "";
}

function hasAgentModelTiers(model) {
  return Object.keys(normalizeAgentModelTiers(model?.agentModelTiers)).length > 0;
}

function agentModelTiersSummary(value) {
  const tiers = normalizeAgentModelTiers(value);
  const ordered = ["cheap", "default", "strong"]
    .filter((tier) => tiers[tier])
    .map((tier) => `${tier}: ${tiers[tier]}`);
  return ordered.join(" · ");
}

function gatewaySummary() {
  const gateway = state.gatewayConfig ?? {};
  const url = gateway.gatewayUrl || "未配置网关";
  const key = gateway.apiKeyConfigured ? `Key ${sourceBadge(gateway.sources?.apiKey)}` : "未配置 Key";
  const source = sourceBadge(gateway.sources?.gatewayUrl || gateway.sources?.gatewayProtocol);
  return `${url} · ${key} · ${source}`;
}

function gatewaySourceNote(gateway) {
  const urlSource = sourceLabel(gateway.sources?.gatewayUrl);
  const protocolSource = sourceLabel(gateway.sources?.gatewayProtocol);
  const keySource = gateway.apiKeyConfigured ? sourceLabel(gateway.sources?.apiKey) : "未配置";
  return `当前生效：网关来自${urlSource}，协议来自${protocolSource}，API Key 来自${keySource}。`;
}

function environmentGatewayDefaultNote(gateway) {
  const sources = gateway.sources ?? {};
  const envFields = [];
  if (sources.gatewayUrl?.type === "environment") envFields.push("网关 URL");
  if (sources.gatewayProtocol?.type === "environment") envFields.push("协议");
  if (sources.apiKey?.type === "environment") envFields.push("API Key");
  if (envFields.length === 0) {
    return "";
  }
  return `全局默认（环境变量）正在提供：${envFields.join("、")}。在这里保存后，当前项目配置会优先生效。`;
}

function sourceBadge(source) {
  const type = String(source?.type ?? "");
  if (type === "project") return "项目";
  if (type === "environment") return "全局默认（环境变量）";
  if (type === "global") return "全局配置";
  if (type === "bundled") return "内置";
  return "默认";
}

function sourceLabel(source) {
  const type = String(source?.type ?? "");
  if (type === "project") return "当前项目";
  if (type === "environment") return "全局默认（环境变量）";
  if (type === "global") return "LAB_AGENT_CONFIG";
  if (type === "bundled") return "内置配置";
  return "默认配置";
}

function formatContextUsage(context) {
  if (!context || typeof context !== "object") {
    return "-- / --";
  }
  const used = firstFiniteNumber(
    context.messageTokens,
    context.promptMessageTokens,
    context.promptTokens,
    context.providerPromptTokens
  );
  const latestInput = firstFiniteNumber(
    context.promptTokens,
    context.providerPromptTokens
  );
  const limit = firstFiniteNumber(context.maxTokens, context.modelMaxTokens);
  const percent = Number.isFinite(used) && Number.isFinite(limit) && limit > 0
    ? ` · ${Math.min(999, Math.round((used / limit) * 100))}%`
    : "";
  const input = Number.isFinite(latestInput)
    ? ` · 输入 ${formatTokenCount(latestInput)}`
    : "";
  return `${formatTokenCount(used)} / ${formatTokenCount(limit)}${percent}${input}`;
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) {
      return number;
    }
  }
  return null;
}

function formatTokenCount(value) {
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

function trimNumber(value) {
  return value >= 10 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

function collapseCompletedActivities() {
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
  for (const activity of state.completedActivities.slice(-12)) {
    const item = document.createElement("div");
    item.className = `summary-row ${activity.severity ?? "info"}`;
    item.innerHTML = `
      <span class="status-dot"></span>
      <span>${escapeHtml(activity.title)}</span>
    `;
    list.append(item);
  }
  appendTranscriptNode(node);
  state.completedActivities = [];
  scrollTranscript({ onlyIfNearBottom: true });
}

function clearAssistantDrafts() {
  for (const draft of state.assistantDrafts.values()) {
    cancelScheduledAnimationFrame(draft, "renderFrame");
    draft.node.remove();
  }
  state.assistantDrafts.clear();
}

function collapseAssistantDrafts(finalText = "") {
  const capturedDrafts = Array.from(state.assistantDrafts.values()).filter((draft) => draft.text.trim().length > 0);
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
    body.textContent = draft.text;
    item.append(title, body);
    list.append(item);
  }
  appendTranscriptNode(node);
  scrollTranscript({ onlyIfNearBottom: true });
}

function isMeaningfulCompletedActivity(activity) {
  if (activity.toolName === "agent_run") {
    return true;
  }
  return ["write_file", "edit_file", "powershell", "bash", "web_fetch", "web_search", "document_intake"].includes(activity.toolName);
}

function isDuplicateDraftText(draftText, finalText) {
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

function normalizeComparableText(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function showApproval(approval) {
  state.pendingApproval = approval;
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
      ...(approval.preview ?? [])
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

async function resolveApproval(action) {
  if (!state.pendingApproval) return;
  const approvalId = state.pendingApproval.id;
  await postJson(`/api/approvals/${encodeURIComponent(approvalId)}`, { action });
}

function hideApproval() {
  deactivateModal(els.approvalPanel);
  state.pendingApproval = null;
  els.approvalPanel.classList.add("hidden");
  els.approvalPanel.innerHTML = "";
}

function showQuestion(question) {
  deactivateQuestionReviewBackground();
  state.questionReviewMode = false;
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

function revealInteractionPanel(panel, focusSelector) {
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

function renderQuestionPanel() {
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

function reviewQuestionConversation() {
  if (!state.pendingQuestion || state.questionReviewMode) return;
  rememberQuestionDraft();
  deactivateModal(els.questionPanel, { restoreFocus: false });
  state.questionReviewMode = true;
  renderQuestionPanel();
  activateQuestionReviewBackground();
  els.transcript?.focus?.({ preventScroll: true });
  announceStatus("需求确认已收起，可以查看对话；按 Esc 返回确认");
}

function returnToQuestion() {
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

function activateQuestionReviewBackground() {
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

function deactivateQuestionReviewBackground() {
  for (const entry of state.questionReviewInertEntries) entry.node.inert = entry.inert;
  state.questionReviewInertEntries = [];
}

function questionChoiceButton(choice, question) {
  const value = String(choice.value ?? choice.label);
  const selected = question.selectedChoices.has(value);
  return `
    <button type="button" class="question-choice${selected ? " selected" : ""}" data-choice="${escapeHtml(value)}" aria-pressed="${selected ? "true" : "false"}">
      <span>${escapeHtml(choice.label ?? value)}</span>
      ${choice.description ? `<small>${escapeHtml(choice.description)}</small>` : ""}
    </button>
  `;
}

function toggleQuestionChoice(value) {
  const question = state.pendingQuestion;
  if (!question) return;
  rememberQuestionDraft();
  if (question.multiple) {
    if (question.selectedChoices.has(value)) {
      question.selectedChoices.delete(value);
    } else {
      question.selectedChoices.add(value);
    }
  } else {
    question.selectedChoices = new Set([value]);
  }
  renderQuestionPanel();
  Array.from(els.questionPanel.querySelectorAll("button[data-choice]"))
    .find((button) => button.dataset.choice === value)
    ?.focus({ preventScroll: true });
}

async function submitQuestion() {
  const question = state.pendingQuestion;
  if (!question) return;
  rememberQuestionDraft();
  const selectedChoices = Array.from(question.selectedChoices);
  const customAnswer = (question.customDraft ?? "").trim();
  await postJson(`/api/questions/${encodeURIComponent(question.id)}`, {
    selectedChoices,
    customAnswer,
    answer: customAnswer,
    cancelled: false
  });
}

async function cancelQuestion() {
  const question = state.pendingQuestion;
  if (!question) return;
  await postJson(`/api/questions/${encodeURIComponent(question.id)}`, {
    cancelled: true,
    answer: "",
    selectedChoices: []
  });
}

function hideQuestion() {
  deactivateModal(els.questionPanel);
  deactivateQuestionReviewBackground();
  state.questionReviewMode = false;
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

async function confirmTrust() {
  const button = els.trustPanel.querySelector("button[data-action='trust']");
  if (button) {
    button.disabled = true;
    button.textContent = "保存中";
  }
  const result = await postJson("/api/trust", {}).catch((error) => ({ ok: false, error: error.message }));
  if (!result.ok) {
    showError(result.error ?? "工作区信任保存失败");
    renderTrustPanel();
    return;
  }
  state.trust = result.trust;
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
  const guideFeedback = state.pendingGuide ? renderGuideFeedback(state.pendingGuide) : "";
  const queueItems = state.queue.slice(0, 6).map((item, index) => renderQueueItem(item, index)).join("");
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

function renderQueueItem(item, index) {
  const isCancelling = state.queueCancelling.has(item.id);
  return `
    <div class="queue-item${item.kind === "guide" ? " guide" : ""}">
      <span>${index + 1}</span>
      <strong>${item.kind === "guide" ? "引导" : item.kind === "wakeup" ? "接续" : "排队"}</strong>
      <em>${escapeHtml(item.preview ?? "")}</em>
      <div class="queue-actions">
        ${item.kind === "guide" || item.kind === "wakeup" ? "" : `<button type="button" class="queue-guide-button" data-guide-queue-id="${escapeHtml(item.id)}" ${isCancelling ? "disabled" : ""}>引导</button>`}
        <button type="button" class="queue-cancel-button" data-cancel-queue-id="${escapeHtml(item.id)}" ${isCancelling ? "disabled" : ""}>${isCancelling ? "取消中" : "取消"}</button>
      </div>
    </div>
  `;
}

function setPendingGuide(guide) {
  state.pendingGuide = {
    ...state.pendingGuide,
    ...guide,
    preview: previewText(guide.preview ?? state.pendingGuide?.preview ?? "")
  };
  renderQueuePanel();
  updateLiveStatus();
}

function clearPendingGuide() {
  state.pendingGuide = null;
  renderQueuePanel();
}

function syncPendingGuideFromQueue() {
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

function renderGuideFeedback(guide) {
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

function guideCopy(phase) {
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

function guideSource(queueItemId = "") {
  const queuedItem = queueItemId
    ? state.queue.find((item) => item.id === queueItemId && item.kind === "prompt" && !state.queueCancelling.has(item.id))
    : null;
  if (queueItemId && !queuedItem) {
    return null;
  }
  if (queueItemId) {
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

function guideTurnFromQueue(queueItemId) {
  if (!queueItemId || state.guideSubmitting) {
    return;
  }
  guideTurn(queueItemId);
}

function guideButtonText() {
  if (state.guideSubmitting || state.pendingGuide?.phase === "registering") return "登记中";
  if (els.promptInput.value.trim()) return "引导对话";
  if (state.pendingGuide?.phase === "interrupting") return "接管中";
  if (state.pendingGuide?.phase === "continuing") return "引导中";
  return "引导对话";
}

function guideButtonDisabled() {
  return !state.running || state.guideSubmitting || !guideSource();
}

function guideButtonVisible() {
  return state.running && (Boolean(els.promptInput.value.trim()) || state.guideSubmitting || state.pendingGuide?.phase === "registering");
}

function syncGuideButton() {
  const button = els.queuePanel.querySelector("#guide-button");
  if (!button) return;
  button.classList.toggle("hidden", !guideButtonVisible());
  button.disabled = guideButtonDisabled();
  button.textContent = guideButtonText();
}

function shouldKeepGuideFeedback() {
  return ["registering", "registered", "interrupting"].includes(state.pendingGuide?.phase);
}

function isInterruptError(message) {
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
  panel.querySelector("button[data-action='cancel']")?.addEventListener("click", hideContextConfirm);
  panel.querySelector(`button[data-action='${action}']`)?.addEventListener("click", () => runContextAction(action));
  activateModal(panel, { initialFocus: "button[data-action='cancel']" });
}

function hideContextConfirm() {
  const panel = els.contextPanel;
  if (!panel) return;
  deactivateModal(panel);
  panel.classList.add("hidden");
  panel.innerHTML = "";
}

async function runContextAction(action) {
  const endpoint = action === "clear" ? "/api/context/clear" : "/api/context/compact";
  const button = els.contextPanel.querySelector(`button[data-action='${action}']`);
  if (button) {
    button.disabled = true;
    button.textContent = action === "clear" ? "清空中" : "压缩中";
  }
  const result = await postJson(endpoint, {
    sessionId: state.currentSessionId,
    permissionMode: state.permissionMode
  }).catch((error) => ({ ok: false, error: error.message }));
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

function contextSummaryLine(summary) {
  return summary ? `${summary.messages ?? 0} 条上下文消息，摘要 ${summary.summaryBytes ?? 0} 字节` : "";
}

function compactResultLine(result) {
  if (!result) return "";
  return result.compacted
    ? `${result.beforeMessages ?? "-"} -> ${result.afterMessages ?? "-"}，摘要 ${result.summaryBytes ?? 0} 字节`
    : `未压缩：${result.reason ?? "无需压缩"}`;
}

function rememberQuestionDraft() {
  const question = state.pendingQuestion;
  if (!question) return;
  const input = els.questionPanel.querySelector(".question-input");
  if (input) {
    question.customDraft = input.value;
  }
}

function questionResolutionText(event) {
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
  state.shutdownActivity = null;
  els.shutdownCopy.textContent = "正在检查主任务、队列和后台任务，请稍候。";
  els.shutdownConfirm.disabled = true;
  els.shutdownConfirm.textContent = "检查中";
  els.shutdownPanel.classList.remove("hidden");
  activateModal(els.shutdownPanel, { initialFocus: "#shutdown-cancel" });
  announceStatus("需要确认是否关闭 Dashboard");
  const result = await getJson("/api/lifecycle/status")
    .catch((error) => ({ ok: false, error: error.message }));
  if (version !== state.shutdownStatusVersion || els.shutdownPanel.classList.contains("hidden")) return;
  if (!result.ok) {
    els.shutdownCopy.textContent = `无法读取当前活动状态：${result.error?.message ?? result.error ?? "未知错误"}。请返回后重试。`;
    els.shutdownConfirm.textContent = "无法检查";
    announceStatus("无法检查 Dashboard 活动状态");
    return;
  }
  state.shutdownActivity = normalizeLifecycleActivity(result.activity);
  renderShutdownActivity();
}

function hideShutdownPanel() {
  state.shutdownStatusVersion += 1;
  deactivateModal(els.shutdownPanel);
  els.shutdownPanel.classList.add("hidden");
  els.shutdownConfirm.disabled = false;
  els.shutdownConfirm.textContent = "确认关闭";
}

async function shutdownDashboard() {
  if (!state.shutdownActivity) return;
  els.shutdownConfirm.disabled = true;
  els.shutdownConfirm.textContent = "正在关闭";
  const result = await postJson("/api/shutdown", shutdownRequestBody(state.shutdownActivity))
    .catch((error) => ({ ok: false, error: error.message }));
  if (!shutdownResultIsClosed(result)) {
    state.shutdownActivity = normalizeLifecycleActivity(result?.activity ?? state.shutdownActivity);
    els.shutdownCopy.textContent = `${result?.error?.message ?? result?.error ?? "关闭失败"} ${lifecycleActivitySummary(state.shutdownActivity)}。你可以返回继续处理，或重试取消任务并关闭。`;
    els.shutdownConfirm.disabled = false;
    els.shutdownConfirm.textContent = state.shutdownActivity.total > 0 ? "重试取消并关闭" : "重试关闭";
    els.runStatus.textContent = "关闭失败";
    announceStatus("Dashboard 关闭失败，页面仍可继续使用");
    els.shutdownConfirm.focus({ preventScroll: true });
    return;
  }
  disconnectEvents();
  deactivateModal(els.shutdownPanel, { restoreFocus: false });
  els.shutdownPanel.classList.add("hidden");
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

function lockClosedDashboard() {
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

export function normalizeLifecycleActivity(activity = {}) {
  const count = (value) => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
  };
  const normalized = {
    sessions: count(activity.sessions),
    activeTurns: count(activity.activeTurns),
    quarantinedTurns: count(activity.quarantinedTurns),
    queuedTurns: count(activity.queuedTurns),
    backgroundTasks: count(activity.backgroundTasks),
    pendingInteractions: count(activity.pendingInteractions)
  };
  normalized.total = count(activity.total) || normalized.activeTurns + normalized.quarantinedTurns
    + normalized.queuedTurns + normalized.backgroundTasks + normalized.pendingInteractions;
  return normalized;
}

export function shutdownRequestBody(activity) {
  return normalizeLifecycleActivity(activity).total > 0 ? { cancel: true } : {};
}

export function shutdownResultIsClosed(result) {
  return result?.ok === true;
}

function lifecycleActivitySummary(activity) {
  return `活动会话 ${activity.sessions} 个，主任务 ${activity.activeTurns} 个，隔离任务 ${activity.quarantinedTurns} 个，队列 ${activity.queuedTurns} 项，后台任务 ${activity.backgroundTasks} 个，待确认 ${activity.pendingInteractions} 项`;
}

function renderShutdownActivity() {
  const activity = state.shutdownActivity;
  if (!activity) return;
  const summary = lifecycleActivitySummary(activity);
  els.shutdownCopy.textContent = activity.total > 0
    ? `${summary}。关闭会取消这些未完成工作并等待收束；也可以返回继续处理。`
    : `${summary}。当前没有未完成工作，确认后会停止本机 WebUI。`;
  els.shutdownConfirm.disabled = false;
  els.shutdownConfirm.textContent = activity.total > 0 ? "取消任务并关闭" : "确认关闭";
}

function renderFiles() {
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

function currentImageFiles() {
  return state.files
    .filter((file) => file.kind === "image")
    .map((file) => ({
      name: file.name,
      rawUrl: rawFileUrl(file.relativePath),
      relativePath: file.relativePath
    }));
}

async function openFile(filePath) {
  if (!filePath) return;
  const sessionId = state.currentSessionId;
  const request = beginScopedRequest("file", `${sessionId ?? "new"}:${filePath}`);
  els.previewBody.className = "preview-body";
  els.previewBody.innerHTML = `<div class="preview-placeholder">正在加载文件预览</div>`;
  const result = await getJson(filePreviewUrl(filePath), { signal: request.signal })
    .catch((error) => ({ ok: false, error: error.message, aborted: isAbortError(error) }));
  if (!isCurrentScopedRequest(request) || state.currentSessionId !== sessionId) return;
  finishScopedRequest(request);
  if (result.aborted) return;
  els.previewBody.className = "preview-body";
  if (!result.ok) {
    els.previewBody.innerHTML = `<div class="office-card">${escapeHtml(result.error ?? "无法预览文件")}</div>`;
    return;
  }
  const file = result.file;
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
    els.previewBody.innerHTML = `<iframe class="preview-frame" title="${escapeHtml(file.name)}" src="${file.rawUrl}"></iframe>`;
  } else if (file.kind === "office-preview") {
    els.previewBody.classList.add("document-preview-body");
    els.previewBody.replaceChildren(renderOfficePreview(file));
  } else if (file.kind === "table-preview") {
    els.previewBody.classList.add("document-preview-body");
    els.previewBody.replaceChildren(renderTablePreview(file));
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

function renderOfficePreview(file) {
  if (file.table) {
    return renderTablePreview(file);
  }
  const article = document.createElement("article");
  article.className = `office-preview office-preview-${escapeHtml(file.officeKind ?? "document")}`;
  article.tabIndex = 0;
  article.setAttribute("aria-label", `${file.name} 轻量预览`);
  const meta = officePreviewMeta(file);
  const openHref = file.rawUrl ?? rawFileUrl(file.relativePath);
  article.innerHTML = `
    <header class="office-preview-header">
      <div>
        <strong>${escapeHtml(file.name)}</strong>
        <span>${escapeHtml(meta)}</span>
      </div>
      <a class="open-file" href="${openHref}" target="_blank" rel="noreferrer">打开</a>
    </header>
    ${officePreviewBodyHtml(file)}
    ${file.truncated ? `<div class="office-preview-note">仅显示前 ${formatNumber(file.content?.length ?? 0)} 字符，完整内容请打开文件。</div>` : ""}
  `;
  return article;
}

function officePreviewMeta(file) {
  const kind = String(file.officeKind ?? "").toLowerCase();
  if (kind === "xlsx") return "Excel 轻量预览";
  if (kind === "pptx") return "PPT 文本预览";
  return "DOCX 文本预览";
}

function officePreviewBodyHtml(file) {
  const kind = String(file.officeKind ?? "").toLowerCase();
  if (kind === "xlsx") {
    return `<div class="office-sheet-list">${renderSheetPreviewHtml(file.content ?? "")}</div>`;
  }
  return `<pre class="office-text-preview">${escapeHtml(file.content ?? "")}</pre>`;
}

function renderTablePreview(file) {
  const article = document.createElement("article");
  article.className = "office-preview table-preview";
  article.tabIndex = 0;
  article.setAttribute("aria-label", `${file.name} 表格预览`);
  const table = normalizeTablePreview(file.table);
  const openHref = file.rawUrl ?? rawFileUrl(file.relativePath);
  const meta = tablePreviewMeta(file, table);
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
      ${renderCompactTableHtml(table)}
    </div>
    ${tableTruncationNote(table)}
  `;
  const previewButton = article.querySelector(".table-preview-button");
  previewButton?.addEventListener("click", () => showTableLightbox(file));
  previewButton?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      showTableLightbox(file);
    }
  });
  article.querySelector(".table-expand-button")?.addEventListener("click", () => showTableLightbox(file));
  return article;
}

function normalizeTablePreview(table) {
  const sheets = Array.isArray(table?.sheets) ? table.sheets : [];
  return {
    kind: table?.kind ?? "table",
    totalSheets: table?.totalSheets ?? sheets.length,
    sheets: sheets.map((sheet, index) => ({
      name: sheet.name || `Sheet ${index + 1}`,
      source: sheet.source ?? "",
      rows: Array.isArray(sheet.rows) ? sheet.rows.map((row) => Array.isArray(row) ? row.map((cell) => String(cell ?? "")) : []) : [],
      truncatedRows: Boolean(sheet.truncatedRows),
      truncatedColumns: Boolean(sheet.truncatedColumns)
    })).filter((sheet) => sheet.rows.length > 0)
  };
}

function tablePreviewMeta(file, table) {
  const kind = String(file.officeKind ?? file.tableKind ?? table.kind ?? "table").toUpperCase();
  const sheetCount = table.totalSheets > 1 ? `${table.totalSheets} 个 Sheet` : "1 个表";
  const first = table.sheets[0];
  const size = first ? `${first.rows.length} 行 · ${maxVisibleColumns(first.rows)} 列` : "空表";
  return `${kind} 表格预览 · ${sheetCount} · ${size}`;
}

function renderCompactTableHtml(table) {
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

function renderExpandedTableHtml(table, activeIndex = 0) {
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

function renderTableHtml(rows, columns, options = {}) {
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
          ${Array.from({ length: count }, (_, index) => `<th scope="col">${escapeHtml(columnLabel(index))}</th>`).join("")}
        </tr>
      </thead>
      <tbody>${bodyRows}</tbody>
    </table>
  `;
}

function tableTruncationNote(table) {
  const truncated = table.sheets.some((sheet) => sheet.truncatedRows || sheet.truncatedColumns);
  return truncated ? `<div class="office-preview-note">表格较大，右侧栏和放大预览会限制最多显示的行列。</div>` : "";
}

function maxVisibleColumns(rows) {
  return rows.reduce((max, row) => Math.max(max, row.length), 0);
}

function columnLabel(index) {
  let value = Number(index) + 1;
  let out = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    out = String.fromCharCode(65 + remainder) + out;
    value = Math.floor((value - 1) / 26);
  }
  return out;
}

function renderSheetPreviewHtml(content) {
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

function renderSheetCellHtml(line) {
  const match = String(line).match(/^([^:]{1,12}):\s*([\s\S]*)$/);
  if (!match) {
    return `<div class="office-cell"><dt></dt><dd>${escapeHtml(line)}</dd></div>`;
  }
  return `<div class="office-cell"><dt>${escapeHtml(match[1])}</dt><dd>${escapeHtml(match[2])}</dd></div>`;
}

function resetPreview(message = "任务产物会显示在这里") {
  els.previewBody.className = "preview-body";
  els.previewBody.innerHTML = `<div class="preview-placeholder">${escapeHtml(message)}</div>`;
}

function fencedDataForFile(file) {
  const language = dataLanguageForExtension(file.extension);
  return `\`\`\`${language}\n${file.content ?? ""}\n\`\`\``;
}

function dataLanguageForExtension(extension) {
  const ext = String(extension ?? "").toLowerCase();
  if (ext === ".yaml" || ext === ".yml") return "yaml";
  if (ext === ".csv") return "csv";
  if (ext === ".tsv") return "tsv";
  return "json";
}

function showImageLightbox(file, items = null, index = 0) {
  const returnFocus = document.activeElement;
  const gallery = Array.isArray(items) && items.length > 0 ? items : [file];
  state.lightboxItems = gallery;
  state.lightboxIndex = Math.max(0, Math.min(index, gallery.length - 1));
  renderLightboxImage();
  els.imageLightbox.classList.remove("hidden");
  document.body.classList.add("lightbox-opened");
  activateModal(els.imageLightbox, { initialFocus: "#lightbox-close", returnFocus });
}

function showTableLightbox(file) {
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

function renderLightboxImage() {
  const file = state.lightboxItems[state.lightboxIndex] ?? {};
  const isTable = file.type === "table";
  els.imageLightbox.dataset.mode = isTable ? "table" : "image";
  els.lightboxTitle.textContent = file.name || (isTable ? "表格预览" : "图片预览");
  els.lightboxOpen.href = file.rawUrl ?? "#";
  els.lightboxImage.classList.toggle("hidden", isTable);
  els.lightboxTable.classList.toggle("hidden", !isTable);
  if (isTable) {
    els.lightboxImage.removeAttribute("src");
    els.lightboxImage.alt = "";
    els.lightboxTable.innerHTML = renderExpandedTableHtml(file.table ?? normalizeTablePreview(null), state.tableLightboxSheetIndex);
    bindTableLightboxControls();
  } else {
    els.lightboxTable.innerHTML = "";
    els.lightboxImage.alt = file.name || "图片预览";
    els.lightboxImage.src = file.rawUrl;
  }
  const total = state.lightboxItems.length;
  els.lightboxCounter.textContent = total > 1 ? `${state.lightboxIndex + 1} / ${total}` : "";
  els.lightboxPrevious.classList.toggle("hidden", total <= 1);
  els.lightboxNext.classList.toggle("hidden", total <= 1);
}

function bindTableLightboxControls() {
  els.lightboxTable.querySelectorAll("[data-sheet-index]").forEach((button) => {
    button.addEventListener("click", () => {
      state.tableLightboxSheetIndex = Number(button.dataset.sheetIndex) || 0;
      renderLightboxImage();
    });
  });
}

function moveLightbox(delta) {
  if (els.imageLightbox.classList.contains("hidden") || state.lightboxItems.length <= 1) {
    return;
  }
  const total = state.lightboxItems.length;
  state.lightboxIndex = (state.lightboxIndex + delta + total) % total;
  renderLightboxImage();
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
  state.permissionMode = mode;
  els.permissionMode.querySelectorAll("button").forEach((button) => {
    const active = button.dataset.mode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-checked", String(active));
    button.tabIndex = active ? 0 : -1;
  });
  document.body.classList.toggle("full-access-active", mode === "fullAccess");
  els.modeDescription.textContent = MODE_DESCRIPTIONS[mode] ?? MODE_DESCRIPTIONS.plan;
  updateContextActions();
}

function clearTranscript() {
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

function cancelTranscriptAnimationFrames() {
  clearAssistantDraftTimers();
  cancelScheduledAnimationFrame(state, "transcriptScrollFrame");
  state.transcriptScrollForce = false;
}

function clearAssistantDraftTimers() {
  for (const draft of state.assistantDrafts.values()) {
    cancelScheduledAnimationFrame(draft, "renderFrame");
  }
}

function hideEmptyState() {
  els.emptyState.classList.add("hidden");
}

function showError(message) {
  hideEmptyState();
  appendActivity({
    title: "发生错误",
    detail: message,
    severity: "danger",
    collapsed: false
  });
}

function showNotice(message, detail = "本地配置已更新") {
  hideEmptyState();
  appendActivity({
    title: message,
    detail,
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
  const message = error instanceof Error ? error.message : String(error ?? "Dashboard 初始化失败");
  setConnectionState(navigator.onLine === false ? "offline" : "stale");
  els.projectPath.textContent = "连接失败";
  els.runStatus.textContent = "初始化失败";
  els.sendButton.disabled = true;
  cancelTranscriptAnimationFrames();
  resetTranscriptWindow();
  els.transcript.innerHTML = `
    <div class="empty-state bootstrap-error">
      <div class="empty-kicker">Ant Code Dashboard</div>
      <div class="empty-title">无法连接本地服务</div>
      <div class="empty-copy">${escapeHtml(message)}</div>
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

function clearBootstrapStatus() {
  if (state.connectionState === "connecting" && !state.currentSessionId) {
    setConnectionState("idle");
  }
}

function scrollTranscript(options = {}) {
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

function isTranscriptNearBottom(threshold = 96) {
  return els.transcript.scrollHeight - els.transcript.scrollTop - els.transcript.clientHeight <= threshold;
}

function syncTranscriptFollowState() {
  const nearBottom = isTranscriptNearBottom();
  state.transcriptFollowing = nearBottom;
  if (nearBottom) state.newReplyAvailable = false;
  updateTranscriptJump();
}

function followTranscript() {
  state.transcriptFollowing = true;
  state.newReplyAvailable = false;
  scrollTranscript({ force: true });
}

function updateTranscriptJump() {
  if (!els.transcriptJump) return;
  const visible = !state.transcriptFollowing;
  els.transcriptJump.classList.toggle("hidden", !visible);
  els.transcriptJump.textContent = state.newReplyAvailable ? "有新回复" : "回到底部";
  els.transcriptJump.setAttribute("aria-label", state.newReplyAvailable ? "有新回复，回到底部" : "回到底部");
}

function beginScopedRequest(scope, key = "") {
  cancelScopedRequest(scope);
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

function cancelScopedRequest(scope) {
  const request = state.requestScopes.get(scope);
  if (!request) return;
  state.requestScopes.delete(scope);
  if (!request.signal.aborted) {
    request.controller.abort();
  }
}

function isAbortError(error) {
  return error?.name === "AbortError" || error?.code === "ABORT_ERR";
}

async function getJson(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    signal: options.signal
  });
  return responseJson(response);
}

async function postJson(url, body, options = {}) {
  const response = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: dashboardJsonHeaders(),
    body: JSON.stringify(body),
    signal: options.signal
  });
  return responseJson(response);
}

async function deleteJson(url, body = {}, options = {}) {
  const response = await fetch(url, {
    method: "DELETE",
    credentials: "same-origin",
    headers: dashboardJsonHeaders(),
    body: JSON.stringify(body),
    signal: options.signal
  });
  return responseJson(response);
}

async function responseJson(response) {
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

function dashboardJsonHeaders() {
  return {
    "content-type": "application/json",
    "x-antcode-csrf-token": dashboardCsrfToken()
  };
}

function dashboardCsrfToken() {
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

function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((item) => {
    if (typeof item === "string") return item;
    if (item && typeof item === "object" && "text" in item) return item.text ?? "";
    return "";
  }).join("");
}

function messageDisplayText(content) {
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

function userMessageDisplayText(text, attachments = []) {
  const lines = [String(text ?? "").trim()].filter(Boolean);
  const imageLines = normalizeAttachmentMetadata(attachments).map(imageAttachmentLine);
  return [...lines, ...imageLines].join("\n");
}

function normalizeAttachmentMetadata(attachments) {
  if (!Array.isArray(attachments)) {
    return [];
  }
  return attachments
    .filter((item) => item && typeof item === "object" && item.type === "image")
    .map((item) => ({
      type: "image",
      name: String(item.name ?? "image"),
      mimeType: String(item.mimeType ?? item.mime_type ?? "image"),
      size: Number.isFinite(item.size) ? item.size : Number(item.bytes ?? item.sizeBytes ?? 0)
    }));
}

function imageAttachmentLine(item) {
  const parts = [
    item.name ? String(item.name) : "image",
    item.mimeType ? String(item.mimeType) : "",
    Number.isFinite(item.size) && item.size > 0 ? formatBytes(item.size) : ""
  ].filter(Boolean);
  return `[图片附件：${parts.join(" · ")}]`;
}

function renderMessageText(node, text, options = {}) {
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

function renderLinkedText(node, text) {
  node.textContent = text ?? "";
  linkifyFileTextNodes(node);
  bindRichContent(node);
}

function bindRichContent(node, options = {}) {
  node.querySelectorAll("[data-file]").forEach((link) => {
    link.addEventListener("click", () => openFile(link.dataset.file));
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

function linkifyFileTextNodes(root, basePath = "") {
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
  const nodes = [];
  while (walker.nextNode()) {
    nodes.push(walker.currentNode);
  }
  for (const textNode of nodes) {
    replaceFileReferences(textNode, basePath);
  }
}

function replaceFileReferences(textNode, basePath = "") {
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

function isLikelyLocalFileReference(value) {
  const withoutLine = normalizeFileReferencePath(value);
  const extension = withoutLine.split(".").pop()?.toLowerCase() ?? "";
  return LOCAL_FILE_EXTENSIONS.has(extension);
}

function resolveDisplayFilePath(value, basePath = "") {
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

function normalizeFileReferencePath(value) {
  return String(value ?? "").replace(/:\d+$/, "");
}

function parentDirectory(filePath) {
  const normalized = String(filePath ?? "").replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  if (index <= 0) {
    return "";
  }
  return normalized.slice(0, index);
}

function filePreviewUrl(filePath) {
  return apiFileUrl("/api/files", filePath);
}

function rawFileUrl(filePath) {
  return apiFileUrl("/api/files/raw", filePath);
}

function apiFileUrl(endpoint, filePath) {
  const params = new URLSearchParams();
  params.set("path", normalizeFileReferencePath(filePath));
  if (state.currentSessionId) {
    params.set("sessionId", state.currentSessionId);
  }
  return `${endpoint}?${params.toString()}`;
}

function imagePreviewUrl(src) {
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

function isSafeInlineBitmapUrl(value) {
  const match = String(value ?? "").match(/^data:image\/(png|jpeg|gif|webp);base64,([a-z0-9+/]+={0,2})$/i);
  if (!match || match[2].length % 4 !== 0) {
    return false;
  }
  const padding = match[2].endsWith("==") ? 2 : match[2].endsWith("=") ? 1 : 0;
  const decodedBytes = (match[2].length / 4) * 3 - padding;
  return decodedBytes > 0 && decodedBytes <= 2 * 1024 * 1024;
}

function normalizeRelativePath(value) {
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

function isWorkspaceRelativeToBase(value, basePath = "") {
  const firstBaseSegment = String(basePath ?? "").split("/").filter(Boolean)[0];
  return Boolean(firstBaseSegment) && String(value ?? "").startsWith(`${firstBaseSegment}/`);
}

async function copyCodeBlock(button) {
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

function previewText(value, max = 120) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

function formatNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0";
  return number.toLocaleString();
}

function formatBytes(value) {
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
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

function formatTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString();
}

function formatRelativeTime(value) {
  if (!value) {
    return "";
  }
  const time = new Date(value).getTime();
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
