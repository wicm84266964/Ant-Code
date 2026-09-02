import type { LabModel } from "../../model-gateway/models.ts";
import type { AgentSession, SessionMessage } from "../../core/session.ts";
import type { TuiLine } from "./format.ts";
import type { InputDraft } from "./input-editor.ts";
import { fileMentionState, slashPaletteState } from "./palettes.ts";
import { resolveTuiFrame } from "./layout.ts";

export const MAX_ENTRIES = 200;
export const STREAM_FLUSH_INTERVAL_MS = 50;
export const DEFAULT_IDLE_SILENT_AFTER_MS = 30 * 60 * 1000;
export const TELEMETRY_ENTRY_KINDS = new Set(["gateway", "tool", "tools", "turn", "workflow", "trace"]);
export const HIGH_FREQUENCY_ANT_EVENTS = new Set(["assistant_text_delta", "assistant_thinking_delta"]);
export const MESSAGE_ACTIONS = Object.freeze(["copy", "copy-forward", "rewind-edit", "regenerate"]);
export const WORKFLOW_FILTERS = Object.freeze(["incomplete", "completed", "all"]);
export const TASK_FILTERS = Object.freeze(["active", "issues", "completed", "all"]);
export const WORKFLOW_FILTER_LABELS = Object.freeze({
  incomplete: "未完成",
  completed: "已完成",
  all: "全部"
});
export const TASK_FILTER_LABELS = Object.freeze({
  active: "活跃",
  issues: "暂停/失败",
  completed: "已完成",
  all: "全部"
});

export type TuiGatewayError = {
  code?: string;
  message?: string;
  details?: {
    cause?: { code?: string };
  };
};

export type TuiToolCallInfo = {
  name?: string;
  inputKeys?: string[];
};

export type TuiQuestionChoice = {
  label: string;
  value?: string;
  description?: string;
  selected?: boolean;
};

export type TuiQuestionAnswer = {
  answer: string;
  selectedChoice?: string | null;
  selectedChoices?: string[];
  cancelled?: boolean;
  customAnswer?: string | null;
  workflowReminder?: string | null;
};

export type TuiRunPromptInput = string | {
  prompt?: string;
  displayPrompt?: string;
  kind?: string;
};

export type TuiRuntimeEvent = {
  type?: string;
  kind?: string;
  turnIndex?: number;
  promptBytes?: number;
  round?: number | null;
  messageId?: string | null;
  model?: string | null;
  text?: string;
  stopReason?: string | null;
  messageCount?: number;
  toolResultCount?: number;
  promptBytesEstimate?: number;
  promptTokensEstimate?: number;
  maxTokens?: number;
  maxBytes?: number;
  promptMessageTokensEstimate?: number;
  promptToolSchemaTokensEstimate?: number;
  promptToolResultTokensEstimate?: number;
  textBytes?: number;
  toolCallCount?: number;
  usage?: Record<string, unknown>;
  toolCalls?: TuiToolCallInfo[];
  name?: string;
  toolCallId?: string;
  inputKeys?: string[];
  interrupted?: boolean;
  ok?: boolean;
  blocked?: boolean;
  resultBytes?: number;
  decision?: unknown;
  errorCode?: string;
  truncated?: boolean;
  error?: TuiGatewayError;
  stage?: string;
  attempt?: number;
  maxAttempts?: number;
  delayMs?: number;
  taskId?: string;
  profile?: string;
  taskStatus?: string;
  outputSummary?: string;
  groupId?: string;
  waitFor?: unknown;
  wakeParent?: unknown;
  status?: string;
  todosCompleted?: number;
  planStepsCompleted?: number;
  draftText?: string;
  draftThinking?: string;
  draftThinkingBytes?: number;
  reason?: string;
  strategy?: string;
  beforeMessages?: number;
  afterMessages?: number;
  summaryBytes?: number;
  fallbackReason?: string;
  level?: string;
  reasons?: string[];
  maxToolRounds?: number;
  outputBytes?: number;
  index?: number;
  id?: string;
  nameDelta?: string;
  argumentsDelta?: string;
  bytes?: number;
  x?: number;
  y?: number;
  direction?: number;
  wakePrompt?: string;
  summary?: string;
};

export type TuiPendingApproval = {
  toolName?: string;
  approvalKey?: string;
  resolve?: (allowed: boolean) => void;
  request?: {
    toolName?: string;
    input?: Record<string, unknown>;
    decision?: Record<string, unknown>;
    definition?: Record<string, unknown>;
  };
};

export type TuiPendingQuestion = {
  focusedIndex?: number;
  choices?: TuiQuestionChoice[];
  allowCustom?: boolean;
  multiple?: boolean;
  selectedIndices?: number[];
  resolve?: (result: TuiQuestionAnswer) => void;
  prompt?: string;
  question?: string;
  header?: string;
  confirmLabel?: string;
  selectionMode?: string;
};

export type TuiSessionRecord = {
  id?: string;
  path?: string;
  encrypted?: boolean;
  modifiedAt?: string;
  bytes?: number;
  title?: string;
  model?: string;
  status?: string;
};

export type TuiTaskRecord = {
  id?: string | null;
  title?: string | null;
  status?: string | null;
  profile?: string | null;
  purpose?: string | null;
  difficulty?: string | null;
  risk?: string | null;
  model?: string | null;
  modelTier?: string | null;
  prompt?: string | null;
  latestProgress?: string | null;
  groupId?: string | null;
  outputSummary?: string | null;
  metadata?: unknown;
};

export type TuiTaskGroupRecord = {
  id?: string;
  status?: string;
  wakePromptQueuedAt?: string | number | boolean | null;
  wakeParent?: unknown;
  latestProgress?: string;
  summary?: string;
  taskIds?: string[];
};

export type TuiInspectorItem = Record<string, unknown>;

export type AntEventState = {
  session: { id: string | null; status: string };
  transcript: unknown[];
  activeTurn: Record<string, unknown> | null;
  activeAssistant: Record<string, unknown> | null;
  tools: unknown[];
  errors: unknown[];
};

export type WritableStreamLike = {
  write?: (chunk: string) => unknown;
};

export type WindowsConsoleScriptResult = {
  status: number | null;
  stdout?: string;
  stderr?: string;
  error?: Error;
  executable?: string;
};

export type FileMentionCandidate = {
  path: string;
  type?: string;
  label?: string;
  recent?: boolean;
  match?: string;
};

export type TuiFrame = ReturnType<typeof resolveTuiFrame>;

export type GitStatusSummary = {
  gitAvailable: boolean;
  gitStatus: string;
};

export type BracketedPasteState = {
  active: boolean;
  buffer: string;
  prefix: string;
};

export type InkKey = {
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  pageDown?: boolean;
  pageUp?: boolean;
  return?: boolean;
  escape?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  tab?: boolean;
  backspace?: boolean;
  delete?: boolean;
  meta?: boolean;
  home?: boolean;
  end?: boolean;
  eventType?: string;
};

export type TuiActivity = {
  status: string;
  gateway: string;
  lastGateway: string;
  lastTool: string;
  lastTurn: string;
  toolCount: number;
  blockedTools: number;
  failedTools: number;
  approvalCount: number;
  questionCount: number;
  assistantBytes: number;
  streamBytes: number;
  thinkingBytes: number;
  eventCount: number;
  promptTokens?: number;
  promptBytes?: number;
  promptMessageTokens?: number;
  promptToolSchemaTokens?: number;
  promptToolResultTokens?: number;
};

export type TuiStreamTool = {
  index?: number;
  id?: string | null;
  name?: string;
  nameDraft?: string;
  argumentsDraft?: string;
  status?: string;
};

export type TuiStreamState = {
  active: boolean;
  phase: string;
  round: number | null;
  messageId: string | null;
  model: string | null;
  thinking: string;
  thinkingBytes: number;
  thinkingTruncated: boolean;
  thinkingVisible: boolean;
  thinkingRedacted: boolean;
  text: string;
  tools: TuiStreamTool[];
  stopReason: string | null;
};

export type TuiTerminalSize = {
  columns: number;
  rows: number;
};

export type TuiStreamDeltaBuffer = {
  text: string;
  textBytes: number;
  thinking: string;
  thinkingBytes: number;
  thinkingTruncated: boolean;
  round: number | null;
};

export type TuiEntry = {
  id?: string;
  kind?: string;
  title?: string;
  body?: string;
  at?: string;
  taskId?: string;
  excerptBody?: string;
  taskStatus?: string;
  profile?: string;
  task?: TuiTaskRecord;
  checkpointMessagesLength?: number;
  turnIndex?: number;
  thinking?: string;
  thinkingBytes?: number;
  thinkingTruncated?: boolean;
  thinkingVisible?: boolean;
};

export type TuiCommandPanel = {
  kind?: string;
  title?: string;
  subtitle?: string;
  footer?: string;
  wrap?: string;
  borderless?: boolean;
  tabs?: string[];
  tabIndex?: number;
  selectedIndex?: number;
  sessionId?: string | null;
  taskId?: string;
  task?: TuiTaskRecord;
  lines?: TuiLine[];
};

export type TuiUiState = {
  entries: TuiEntry[];
  inputBuffer: string;
  inputCursor: number;
  inputVisibleStart: number;
  questionBuffer: string;
  questionCursor: number;
  questionVisibleStart: number;
  busy: boolean;
  mode: string;
  stream: TuiStreamState;
  startupConfirmed: boolean;
  trusted: boolean;
  trustStatus: string;
  pendingApproval: TuiPendingApproval | null;
  pendingQuestion: TuiPendingQuestion | null;
  slashPalette: ReturnType<typeof slashPaletteState> | null;
  fileMention: ReturnType<typeof fileMentionState> | null;
  history: string[];
  historyIndex: number | null;
  sideView: string;
  workflowFilter: string;
  taskFilter: string;
  inspectorIndex: number;
  inspectorOffset: number;
  inspectorFilter: string;
  inspectorItems: TuiInspectorItem[];
  inspectorPatchFileIndex: number;
  sidePanelOffset: number;
  detailMode: string;
  thinkingVisible: boolean;
  permissionMode: string;
  slashPaletteIndex: number;
  fileMentionCandidates: FileMentionCandidate[];
  fileMentionIndex: number;
  recentFiles: string[];
  queuedPrompts: string[];
  queuePanelIndex: number;
  sessionRecords: TuiSessionRecord[];
  sessionPickerIndex: number;
  taskRecords: TuiTaskRecord[];
  taskGroupRecords: TuiTaskGroupRecord[];
  modelPickerOpen: boolean;
  modelPickerIndex: number;
  commandPanel: TuiCommandPanel | null;
  commandPanelOffset: number;
  approvalChoiceIndex: number;
  exitConfirmUntil: number;
  interruptConfirmUntil: number;
  backgroundExitPending: boolean;
  idleSilent: boolean;
  transcriptScrollOffset: number;
  streamScrollOffset: number;
  selectedEntryId: string | null;
  selectedEntryHighlightUntil: number;
  transcriptSelection: { startIndex: number; endIndex: number } | null;
  messageActionIndex: number;
  terminalSize: TuiTerminalSize;
  modelOptions: LabModel[];
};

export type RunTuiOptions = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  readonly?: boolean;
  allowWrite?: boolean;
  allowCommand?: boolean;
  fullAccess?: boolean;
  resume?: string | null;
  forceExitProcess?: (code: number) => void;
};

export type TuiAppProps = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  session: AgentSession;
  onForceExit?: (code: number) => void;
  initialTrusted?: boolean;
  initialWindowsConsoleInputMode?: number | null;
};
