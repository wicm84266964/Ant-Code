import { renderMarkdown } from "./markdown.js";
import { hydrateRichContent } from "./rich-renderers.js";
import { visibleTranscriptRole } from "./transcript.js";

const state = {
  cwd: "",
  sessions: [],
  currentSessionId: null,
  eventSource: null,
  eventSourceSessionId: null,
  lastEventSequence: 0,
  permissionMode: "plan",
  pendingApproval: null,
  pendingQuestion: null,
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
  activeTurnId: "",
  processedEventIds: new Set(),
  lastAssistantFinalSignature: "",
  sessionStatus: null,
  turnChangeStats: { additions: 0, deletions: 0, files: 0, redacted: false, truncated: false, approximate: false },
  lightboxItems: [],
  lightboxIndex: 0,
  tableLightboxSheetIndex: 0,
  editingModelId: ""
};

const els = {
  projectPath: document.querySelector("#project-path"),
  threadList: document.querySelector("#thread-list"),
  refreshSessions: document.querySelector("#refresh-sessions"),
  collapseSidebar: document.querySelector("#collapse-sidebar"),
  sessionsStatus: document.querySelector("#sessions-status"),
  newTask: document.querySelector("#new-task"),
  runStatus: document.querySelector("#run-status"),
  workflowStrip: document.querySelector("#workflow-strip"),
  transcript: document.querySelector("#transcript"),
  emptyState: document.querySelector("#empty-state"),
  promptInput: document.querySelector("#prompt-input"),
  attachmentInput: document.querySelector("#attachment-input"),
  attachmentStrip: document.querySelector("#attachment-strip"),
  attachButton: document.querySelector("#attach-button"),
  sendButton: document.querySelector("#send-button"),
  permissionMode: document.querySelector("#permission-mode"),
  modeDescription: document.querySelector("#mode-description"),
  liveStatus: document.querySelector("#live-status"),
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
  shutdownCancel: document.querySelector("#shutdown-cancel"),
  shutdownConfirm: document.querySelector("#shutdown-confirm"),
  trustPanel: document.querySelector("#trust-panel"),
  queuePanel: document.querySelector("#queue-panel"),
  contextPanel: document.querySelector("#context-panel"),
  contextClear: document.querySelector("#context-clear"),
  contextCompact: document.querySelector("#context-compact"),
  modelPanel: document.querySelector("#model-panel"),
  modelConfigPanel: document.querySelector("#model-config-panel"),
  modelStatus: document.querySelector("#model-status"),
  contextStatus: document.querySelector("#context-status"),
  changeStatus: document.querySelector("#change-status")
};

const MODE_DESCRIPTIONS = {
  plan: "写入和命令需确认",
  workspace: "工作区常规操作自动同意",
  fullAccess: "本机工具和网络自动同意"
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
const DRAFT_RENDER_INTERVAL_MS = 180;
const MAX_IMAGE_ATTACHMENTS = 6;
const MAX_IMAGE_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const CURRENT_SESSION_STORAGE_KEY = "ant-code-dashboard-current-session";

await init();

async function init() {
  bindEvents();
  observeRunStatus();
  const status = await getJson("/api/status");
  state.cwd = status.cwd;
  state.models = normalizeModels(status.models);
  state.gatewayConfig = normalizeGatewayConfig(status.gatewayConfig);
  state.gatewayProfiles = normalizeGatewayProfiles(status.gatewayProfiles);
  state.agentModelTiers = normalizeAgentModelTiers(status.agentModelTiers);
  state.visionAgent = normalizeVisionAgent(status.visionAgent);
  updateSessionStatus(status.sessionStatus);
  els.projectPath.textContent = status.cwd;
  await loadTrust();
  await loadSessions();
  await restoreInitialSession();
  updateSendButton();
  renderComposerStatus();
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
  els.collapseSidebar.addEventListener("click", toggleSidebar);
  els.newTask.addEventListener("click", newTask);
  els.sendButton.addEventListener("click", () => {
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
  els.promptInput.addEventListener("input", syncGuideButton);
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
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (state.modelConfigOpen) {
        hideModelConfigPanel();
      } else if (state.modelPanelOpen) {
        hideModelPanel();
      } else {
        hideLightbox();
      }
    } else if (event.key === "ArrowLeft") {
      moveLightbox(-1);
    } else if (event.key === "ArrowRight") {
      moveLightbox(1);
    }
  });
  els.permissionMode.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-mode]");
    if (!button) return;
    setPermissionMode(button.dataset.mode);
  });
  els.collapsePreview.addEventListener("click", () => {
    document.body.classList.toggle("preview-collapsed");
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
  els.liveStatus.addEventListener("click", () => toggleLiveStatusDetails());
  els.liveStatus.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    toggleLiveStatusDetails();
  });
}

async function loadTrust() {
  const result = await getJson("/api/trust").catch((error) => ({ ok: false, error: error.message }));
  if (!result.ok) {
    showError(result.error ?? "无法读取工作区信任状态");
    return;
  }
  state.trust = result.trust;
  renderTrustPanel();
}

async function loadSessions(options = {}) {
  const feedback = options.feedback === true;
  if (feedback) {
    setSessionsRefreshState("loading", "刷新中");
  }
  try {
    const result = await getJson("/api/sessions");
    state.sessions = result.sessions ?? [];
    renderSessions();
    if (sessionsNeedRefresh()) {
      scheduleSessionsRefresh(4000);
    }
    if (feedback) {
      setSessionsRefreshState("success", `已刷新 ${state.sessions.length} 个会话`);
    }
  } catch (error) {
    if (feedback) {
      setSessionsRefreshState("error", "刷新失败");
    }
    showError(error.message ?? "刷新会话失败");
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
  els.threadList.innerHTML = "";
  if (state.sessions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "thread-meta";
    empty.textContent = "暂无历史任务";
    els.threadList.append(empty);
    return;
  }
  for (const session of state.sessions) {
    const status = sessionStatusView(session);
    const item = document.createElement("div");
    item.className = `thread-item${session.id === state.currentSessionId ? " active" : ""}`;
    item.dataset.tone = status.tone;
    item.innerHTML = `
      <button type="button" class="thread-open" title="${escapeAttribute(session.title || "未命名任务")}">
        <span class="thread-status-dot" aria-hidden="true"></span>
        <div class="thread-main">
          <div class="thread-title">${escapeHtml(session.title || "未命名任务")}</div>
          <div class="thread-meta">${escapeHtml(sessionMeta(session, status))}</div>
        </div>
        <span class="thread-status-badge" data-tone="${escapeAttribute(status.tone)}">${escapeHtml(status.label)}</span>
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
    item.querySelector(".thread-open").addEventListener("click", () => openSession(session.id));
    item.querySelectorAll("button[data-action]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        handleSessionAction(button.dataset.action, button.dataset.sessionId);
      });
    });
    els.threadList.append(item);
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
}

function sessionsNeedRefresh() {
  return state.sessions.some((session) =>
    session.running
    || session.backgroundVisible
    || session.queueLength > 0
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
  const result = await getJson(`/api/sessions/${encodeURIComponent(id)}`);
  if (!result.ok) {
    showError(result.error?.message ?? result.error ?? "无法读取会话");
    return;
  }
  state.currentSessionId = id;
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
  const result = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE"
  }).then((response) => response.json()).catch((error) => ({ ok: false, error: error.message }));
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
  state.currentSessionId = null;
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
  const prompt = els.promptInput.value.trim();
  const attachments = state.attachments.slice();
  if (!prompt && attachments.length === 0) {
    return;
  }
  if (!state.trust?.trusted) {
    showTrustPanel();
    return;
  }
  els.sendButton.disabled = true;
  els.runStatus.textContent = state.running ? "已排队" : "启动中";
  const result = await postJson("/api/turns", {
    prompt,
    attachments: attachments.map(attachmentPayload),
    sessionId: state.currentSessionId,
    permissionMode: state.permissionMode
  }).catch((error) => ({ ok: false, error: error.message }));
  els.sendButton.disabled = false;
  if (!result.ok) {
    if (result.trust) {
      state.trust = result.trust;
      renderTrustPanel();
    }
    showError(result.error ?? "任务启动失败");
    els.runStatus.textContent = result.status === 403 ? "待信任" : "失败";
    updateSendButton();
    return;
  }
  els.promptInput.value = "";
  clearAttachments();
  state.queue = result.queue ?? state.queue;
  state.running = result.running === true || state.running;
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
  disconnectEvents();
  state.eventSourceSessionId = sessionId;
  const params = new URLSearchParams({ sessionId });
  if (state.lastEventSequence > 0) {
    params.set("after", String(state.lastEventSequence));
  }
  state.eventSource = new EventSource(`/api/events?${params.toString()}`);
  state.eventSource.addEventListener("dashboard", (event) => {
    const payload = JSON.parse(event.data);
    if (shouldSkipDashboardEvent(payload)) {
      return;
    }
    rememberEventCursor(payload.sequence);
    handleDashboardEvent(payload);
  });
}

function ensureEventsConnected(sessionId) {
  if (state.eventSource && state.eventSourceSessionId === sessionId) {
    return;
  }
  connectEvents(sessionId);
}

function disconnectEvents() {
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
  state.eventSourceSessionId = null;
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
    nodes.push(createMessageNode(role, role === "assistant" ? "Ant Code" : "你", messageDisplayText(message.content)));
  }
  if (options.prepend) {
    hideEmptyState();
    const anchor = transcriptFirstContentNode();
    for (const node of nodes) {
      els.transcript.insertBefore(node, anchor);
    }
    return nodes;
  }
  for (const node of nodes) {
    appendTranscriptNode(node);
  }
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
  if (state.transcriptHistoryNode?.parentElement === els.transcript) {
    return state.transcriptHistoryNode.nextSibling;
  }
  return els.emptyState?.parentElement === els.transcript ? els.emptyState.nextSibling : els.transcript.firstChild;
}

function handleTranscriptScroll() {
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
  const before = state.transcriptPaging.cursor;
  state.transcriptPaging.loading = true;
  state.transcriptPaging.error = "";
  renderTranscriptHistoryStatus();
  const previousHeight = els.transcript.scrollHeight;
  const previousTop = els.transcript.scrollTop;
  const result = await getJson(`/api/sessions/${encodeURIComponent(state.currentSessionId)}/transcript?${new URLSearchParams({
    before: before ?? "",
    limit: "100"
  }).toString()}`).catch((error) => ({ ok: false, error: error.message }));
  state.transcriptPaging.loading = false;
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
  const delta = els.transcript.scrollHeight - previousHeight;
  els.transcript.scrollTop = previousTop + delta;
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
    els.transcript.append(state.workflowNode);
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
}

function createMessageNode(kind, label, text) {
  hideEmptyState();
  const node = document.createElement("article");
  node.className = `message ${kind}`;
  node.innerHTML = `
    <div class="message-label">${escapeHtml(label)}</div>
    <div class="message-body"></div>
  `;
  renderMessageText(node.querySelector(".message-body"), text ?? "", { markdown: kind === "assistant" });
  return node;
}

function appendTranscriptNode(node) {
  hideEmptyState();
  els.transcript.append(node);
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
    const label = Number.isFinite(event.round) ? `思考 · 第 ${event.round} 轮` : "思考";
    node.innerHTML = `
      <div class="message-label">${escapeHtml(label)}</div>
      <div class="message-body"></div>
    `;
    draft = {
      round: Number.isFinite(event.round) ? event.round : null,
      text: "",
      node,
      body: node.querySelector(".message-body"),
      renderTimer: null,
      lastRenderAt: 0,
      renderedText: ""
    };
    state.assistantDrafts.set(roundKey, draft);
    els.transcript.append(node);
  }
  draft.text += String(event.text ?? "");
  scheduleDraftRender(draft);
  scrollTranscript({ onlyIfNearBottom: true, wasAtBottom });
  setLiveTitle("正在生成回复");
}

function scheduleDraftRender(draft) {
  const elapsed = Date.now() - draft.lastRenderAt;
  if (elapsed >= DRAFT_RENDER_INTERVAL_MS) {
    renderAssistantDraft(draft);
    return;
  }
  if (draft.renderTimer) {
    return;
  }
  draft.renderTimer = setTimeout(() => {
    draft.renderTimer = null;
    renderAssistantDraft(draft);
  }, DRAFT_RENDER_INTERVAL_MS - elapsed);
}

function renderAssistantDraft(draft, options = {}) {
  const wasAtBottom = isTranscriptNearBottom();
  if (draft.renderTimer) {
    clearTimeout(draft.renderTimer);
    draft.renderTimer = null;
  }
  if (!options.force && draft.renderedText === draft.text) {
    return;
  }
  draft.renderedText = draft.text;
  draft.lastRenderAt = Date.now();
  renderMessageText(draft.body, draft.text, { markdown: true, lightweight: true });
  scrollTranscript({ onlyIfNearBottom: true, wasAtBottom });
}

function appendActivity(activity) {
  const wasAtBottom = isTranscriptNearBottom();
  const node = document.createElement("div");
  node.className = `activity-card ${activity.severity ?? "info"}${activity.collapsed ? "" : " open"}`;
  node.innerHTML = `
    <div class="activity-head">
      <span class="status-dot"></span>
      <div class="activity-title">${escapeHtml(activity.title)}</div>
      <span class="chevron">⌄</span>
    </div>
    <div class="activity-detail">${escapeHtml(activity.detail ?? "")}</div>
  `;
  node.querySelector(".activity-head").addEventListener("click", () => {
    node.classList.toggle("open");
  });
  els.transcript.append(node);
  scrollTranscript({ onlyIfNearBottom: true, wasAtBottom });
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
  els.liveStatus.tabIndex = background.length > 0 ? 0 : -1;
  els.liveStatus.setAttribute("role", background.length > 0 ? "button" : "status");
  els.liveStatus.setAttribute("aria-expanded", background.length > 0 ? String(state.liveStatusExpanded) : "false");
  if (!visible) {
    els.liveTitle.textContent = "";
    els.liveSubtasks.innerHTML = "";
    return;
  }
  const primary = active.find((activity) => activity.toolName !== "agent_run") || active[0];
  const subtasks = active.filter((activity) => activity.toolName === "agent_run");
  els.liveTitle.textContent = liveStatusTitle(primary, subtasks, background);
  els.liveSubtasks.innerHTML = "";
  for (const task of subtasks.slice(0, 4)) {
    const chip = document.createElement("div");
    chip.className = "live-chip";
    chip.innerHTML = `<span class="chip-pulse" aria-hidden="true"></span>${escapeHtml(task.profile ? `${task.profile} 子任务运行中` : "子智能体运行中")}`;
    els.liveSubtasks.append(chip);
  }
  renderBackgroundSubagentStatus(background);
}

function liveStatusTitle(primary, subtasks, background) {
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
  els.modelStatus.setAttribute("aria-expanded", state.modelPanelOpen ? "true" : "false");
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
  state.editingModelId = String(modelId ?? "").trim();
  state.modelConfigOpen = true;
  renderModelConfigPanel();
}

function hideModelConfigPanel() {
  if (state.modelConfigSaving) {
    return;
  }
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
          <div class="model-config-kicker">本地配置</div>
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
          <input name="gatewayApiKey" type="password" autocomplete="new-password" spellcheck="false" placeholder="${gateway.apiKeyConfigured ? "已配置，留空则保留" : "可选"}" />
        </label>
        <label>
          <span>健康检查 URL</span>
          <input name="gatewayHealthUrl" type="url" spellcheck="false" value="${escapeAttribute(gateway.gatewayHealthUrl || "")}" placeholder="可选" />
        </label>
        <label>
          <span>模型 ID</span>
          <input name="modelId" required spellcheck="false" value="${escapeAttribute(current.id || "")}" placeholder="mimo-v2.5" />
        </label>
        <label>
          <span>显示名称</span>
          <input name="label" spellcheck="false" value="${escapeAttribute(current.label || "")}" placeholder="Mimo v2.5" />
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
          <input name="agentDefaultModel" spellcheck="false" value="${escapeAttribute(currentAgentTiers.default)}" placeholder="例如 mimo-v2.5" />
        </label>
        <label>
          <span>子智能体 strong</span>
          <input name="agentStrongModel" spellcheck="false" value="${escapeAttribute(currentAgentTiers.strong)}" placeholder="例如 mimo-v2.5" />
        </label>
        <label>
          <span>视觉子智能体</span>
          <input name="visionAgentModel" spellcheck="false" value="${escapeAttribute(visionAgentModel)}" placeholder="例如 mimo-v2.5" />
        </label>
      </div>
      <div class="model-config-toggles">
        <label><input name="text" type="checkbox" checked disabled /> 文本</label>
        <label><input name="vision" type="checkbox"${Array.isArray(current.modalities) && current.modalities.includes("image") ? " checked" : ""} /> 视觉</label>
        <label><input name="thinking" type="checkbox"${current.thinking ? " checked" : ""} /> thinking</label>
        <label><input name="switchToModel" type="checkbox"${editing && !current.current ? "" : " checked"} /> 保存后切换到这个模型</label>
        <label><input name="applyAgentDefaults" type="checkbox" /> 保存后同步子智能体</label>
      </div>
      <div class="model-config-note">配置会写入 .lab-agent/config.json；该目录默认不进 Git。Key 不会在这里回显。</div>
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
    showNotice("模型配置已保存");
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
    activeProfileId: String(value?.activeProfileId ?? "")
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

function normalizeModels(models) {
  return Array.isArray(models) ? models.map((model) => ({
    id: String(model.id ?? ""),
    label: String(model.label ?? model.id ?? ""),
    description: String(model.description ?? ""),
    thinking: model.thinking === true,
    modalities: Array.isArray(model.modalities) ? model.modalities.map(String) : ["text"],
    contextTokens: Number.isFinite(Number(model.contextTokens)) ? Number(model.contextTokens) : null,
    agentModelTiers: normalizeAgentModelTiers(model.agentModelTiers),
    current: model.current === true
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
  const key = gateway.apiKeyConfigured ? "Key 已配置" : "未配置 Key";
  return `${url} · ${key}`;
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
  const limit = firstFiniteNumber(context.maxTokens, context.modelMaxTokens);
  const percent = Number.isFinite(used) && Number.isFinite(limit) && limit > 0
    ? ` · ${Math.min(999, Math.round((used / limit) * 100))}%`
    : "";
  const promptTokens = firstFiniteNumber(context.promptTokens);
  const latestInput = Number.isFinite(promptTokens) && Number.isFinite(used) && promptTokens !== used
    ? ` · 输入 ${formatTokenCount(promptTokens)}`
    : "";
  return `${formatTokenCount(used)} / ${formatTokenCount(limit)}${percent}${latestInput}`;
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
  els.transcript.append(node);
  state.completedActivities = [];
  scrollTranscript({ onlyIfNearBottom: true });
}

function clearAssistantDrafts() {
  for (const draft of state.assistantDrafts.values()) {
    if (draft.renderTimer) {
      clearTimeout(draft.renderTimer);
      draft.renderTimer = null;
    }
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
    body.className = "message-body";
    renderMessageText(body, draft.text, { markdown: true, lightweight: true });
    item.append(title, body);
    list.append(item);
  }
  els.transcript.append(node);
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
  els.approvalPanel.innerHTML = `
    <div class="approval-title">需要权限确认 · ${escapeHtml(approval.toolName)}</div>
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
  revealInteractionPanel(els.approvalPanel, "button[data-action]");
}

async function resolveApproval(action) {
  if (!state.pendingApproval) return;
  const approvalId = state.pendingApproval.id;
  await postJson(`/api/approvals/${encodeURIComponent(approvalId)}`, { action });
}

function hideApproval() {
  state.pendingApproval = null;
  els.approvalPanel.classList.add("hidden");
  els.approvalPanel.innerHTML = "";
}

function showQuestion(question) {
  state.pendingQuestion = {
    ...question,
    selectedChoices: new Set((question.choices ?? []).filter((choice) => choice.selected).map((choice) => choice.value ?? choice.label)),
    customDraft: ""
  };
  renderQuestionPanel();
  revealInteractionPanel(els.questionPanel, ".question-input, button[data-choice], button[data-action='submit']");
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
  if (!question) return;
  els.questionPanel.classList.remove("hidden");
  const choices = question.choices ?? [];
  els.questionPanel.innerHTML = `
    <div class="question-read-pane">
      <div class="question-title">${escapeHtml(question.header ?? "需求核对")}</div>
      <div class="question-copy">${escapeHtml(question.question ?? "请确认需求")}</div>
      ${choices.length ? `<div class="question-choices">${choices.map((choice) => questionChoiceButton(choice, question)).join("")}</div>` : ""}
      ${question.allowCustom ? `<textarea class="question-input" rows="2" placeholder="${choices.length ? "补充其他要求，可留空" : "输入你的回答"}"></textarea>` : ""}
    </div>
    <div class="question-actions">
      <div class="question-prompt-summary">${escapeHtml(question.header ?? "需求核对")}</div>
      <div class="question-action-buttons">
        <button type="button" data-action="submit">${escapeHtml(question.confirmLabel ?? "确认")}</button>
        <button type="button" data-action="cancel">取消</button>
      </div>
    </div>
  `;
  els.questionPanel.querySelectorAll("button[data-choice]").forEach((button) => {
    button.addEventListener("click", () => toggleQuestionChoice(button.dataset.choice));
  });
  els.questionPanel.querySelector("button[data-action='submit']").addEventListener("click", submitQuestion);
  els.questionPanel.querySelector("button[data-action='cancel']").addEventListener("click", cancelQuestion);
  const input = els.questionPanel.querySelector(".question-input");
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
  state.pendingQuestion = null;
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
  els.contextPanel.classList.remove("hidden");
  els.contextPanel.innerHTML = `
    <div>
      <div class="context-title">${isClear ? "清空上下文？" : "压缩上下文？"}</div>
      <div class="context-copy">${isClear ? "这会清除当前会话的模型上下文，历史记录仍可在左侧查看。" : "这会整理较早上下文，保留近期对话并写入压缩摘要。"}</div>
    </div>
    <div class="context-confirm-actions">
      <button type="button" data-action="cancel">取消</button>
      <button type="button" data-action="${action}" class="${isClear ? "danger" : ""}">${isClear ? "确认清空" : "确认压缩"}</button>
    </div>
  `;
  els.contextPanel.querySelector("button[data-action='cancel']").addEventListener("click", hideContextConfirm);
  els.contextPanel.querySelector(`button[data-action='${action}']`).addEventListener("click", () => runContextAction(action));
}

function hideContextConfirm() {
  els.contextPanel.classList.add("hidden");
  els.contextPanel.innerHTML = "";
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

function showShutdownPanel() {
  els.shutdownPanel.classList.remove("hidden");
}

function hideShutdownPanel() {
  els.shutdownPanel.classList.add("hidden");
}

async function shutdownDashboard() {
  els.shutdownConfirm.disabled = true;
  els.shutdownConfirm.textContent = "正在关闭";
  disconnectEvents();
  await postJson("/api/shutdown", {}).catch(() => null);
  document.body.classList.add("dashboard-closed");
  els.runStatus.textContent = "已关闭";
  els.transcript.innerHTML = `
    <div class="empty-state">
      <div class="empty-kicker">Ant Code Dashboard</div>
      <div class="empty-title">Dashboard 已关闭</div>
      <div class="empty-copy">本机 WebUI 服务已经停止，可以关闭这个页面。再次使用时重新运行 ant-code dashboard。</div>
    </div>
  `;
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
  const result = await getJson(filePreviewUrl(filePath));
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
  } else if (file.kind === "office" || file.kind === "binary") {
    els.previewBody.innerHTML = `<div class="office-card"><strong>${escapeHtml(file.name)}</strong><p>${escapeHtml(file.message ?? "此文件第一版不直接预览。")}</p><p>${escapeHtml(file.relativePath)}</p><a class="open-file" href="${file.rawUrl}" target="_blank" rel="noreferrer">打开文件</a></div>`;
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
  const gallery = Array.isArray(items) && items.length > 0 ? items : [file];
  state.lightboxItems = gallery;
  state.lightboxIndex = Math.max(0, Math.min(index, gallery.length - 1));
  renderLightboxImage();
  els.imageLightbox.classList.remove("hidden");
  document.body.classList.add("lightbox-opened");
  els.lightboxClose.focus();
}

function showTableLightbox(file) {
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
  els.lightboxClose.focus();
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
    button.classList.toggle("active", button.dataset.mode === mode);
  });
  els.modeDescription.textContent = MODE_DESCRIPTIONS[mode] ?? MODE_DESCRIPTIONS.plan;
}

function clearTranscript() {
  clearAssistantDraftTimers();
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
}

function clearAssistantDraftTimers() {
  for (const draft of state.assistantDrafts.values()) {
    if (draft.renderTimer) {
      clearTimeout(draft.renderTimer);
      draft.renderTimer = null;
    }
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

function showNotice(message) {
  hideEmptyState();
  appendActivity({
    title: message,
    detail: ".lab-agent/config.json 已更新",
    severity: "info",
    collapsed: false
  });
}

function scrollTranscript(options = {}) {
  if (options.onlyIfNearBottom && options.wasAtBottom === false) {
    return;
  }
  const scrollToBottom = () => {
    els.transcript.scrollTop = els.transcript.scrollHeight;
  };
  scrollToBottom();
  requestAnimationFrame(() => {
    scrollToBottom();
    setTimeout(scrollToBottom, 0);
  });
}

function isTranscriptNearBottom(threshold = 96) {
  return els.transcript.scrollHeight - els.transcript.scrollTop - els.transcript.clientHeight <= threshold;
}

async function getJson(url) {
  const response = await fetch(url);
  return response.json();
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return response.json();
}

async function deleteJson(url, body = {}) {
  const response = await fetch(url, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return response.json();
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
  if (!value || /^data:image\//i.test(value) || /^https?:\/\//i.test(value) || value.startsWith("/api/files/raw?")) {
    return value;
  }
  if (value.startsWith("/")) {
    return value;
  }
  return rawFileUrl(value.replace(/^\.\//, ""));
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
