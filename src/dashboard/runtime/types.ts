import fs from "node:fs/promises";
import path from "node:path";
import { createHash, createHmac, randomBytes, type Hash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  createSession,
  persistSessionSnapshot,
  runSessionTurn,
  SessionModelSelectionUnresolvedError,
  type AgentSession
} from "../../core/session.ts";
import {
  GOAL_ABS_MAX_AUTO_CONTINUES,
  GOAL_CONTINUE_KIND,
  GOAL_MIN_AUTO_CONTINUES,
  applyGoalEndedAt,
  bumpGoalRoundCount,
  clearGoalEndedAt,
  resolveGoalMaxAutoContinues,
  buildGoalContinuePrompt,
  disableGoalState,
  enableGoalState,
  resolveGoalPreviousPermissionMode,
  evaluateGoalCompletion,
  goalUnattendedQuestionResult,
  publicGoalSnapshot,
  shouldSkipGoalContinue,
  stripGoalStatusMarkers
} from "../../core/goal.ts";
import {
  applyRuntimeModelSelection,
  currentRuntimeModelSelection,
  patchSessionModelSelectionMetadata,
  resolveSessionModelSelection,
  type SessionModelSelectionResolution,
  type RuntimeModelSelection
} from "../../config-v2/runtime-selection.ts";
import { clearSessionContext, compactSessionContextWithModel, createContextWindow, summarizeContextWindow } from "../../core/context-window.ts";
import { createLabModelGateway } from "../../model-gateway/client.ts";
import { redactGatewayText } from "../../model-gateway/errors.ts";
import { listConfiguredModels, normalizeAgentModelTiers, normalizeReasoningEfforts, resolveModelSelection, type LabModel } from "../../model-gateway/models.ts";
import {
  inferCatalogReasoning,
  normalizeCapabilityEfforts,
  reasoningProbeEffortIds
} from "../../model-gateway/reasoning-capabilities.ts";
import { resolveWorkspaceTrust, trustWorkspace as saveWorkspaceTrust } from "../../permissions/workspace-trust.ts";
import { createSessionStore } from "../../storage/session-store.ts";
import { GATEWAY_PROTOCOLS, NETWORK_MODES, globalConfigPath, loadConfig, localProjectConfigPath, type LabAgentConfig } from "../../config/load-config.ts";
import { cancelBackgroundAgentTasks, listBackgroundAgentTasks } from "../../agents/background-registry.ts";
import { cancelBackgroundTerminalTasks, listBackgroundTerminalTasks } from "../../agents/background-terminal-registry.ts";
import { createAgentTaskStore } from "../../agents/task-store.ts";
import { createAgentTaskGroupStore, summarizeGroupStatus } from "../../agents/task-group-store.ts";
import { cloneWorkflowState } from "../../tools/workflow-tools.ts";
import { mapSessionEventToDashboard, permissionRequestToActivity } from "../events.ts";
import { applyPermissionMode, approvalKeyFor, buildApprovalPreview, normalizePermissionMode, permissionModeSummary, sanitizeSensitiveValue } from "../permissions.ts";
import { collectSessionFiles } from "../files.ts";
import { getAntCodeVersion } from "../../version.ts";
import { mutateJsonConfig } from "../config-store.ts";
import {
  dashboardV2ErrorResult,
  deleteV2Provider,
  deleteV2ProviderModel,
  publicV2ConfigState,
  saveV2DefaultModel,
  saveV2ProviderModel
} from "../model-settings-v2.ts";

export const MAX_EVENTS = 500;
export const MAX_QUEUE = 20;
export const DEFAULT_TRANSCRIPT_PAGE_LIMIT = 100;
export const MAX_TRANSCRIPT_PAGE_LIMIT = 200;
export const BACKGROUND_SNAPSHOT_INTERVAL_MS = 15_000;
export const BACKGROUND_STALE_PROGRESS_MS = 10 * 60 * 1000;
export const BACKGROUND_DEAD_HEARTBEAT_MS = 5 * 60 * 1000;
export const DEFAULT_INTERRUPT_FORCE_SETTLE_MS = 5_000;
export const DEFAULT_LIFECYCLE_WAIT_MS = 5_000;
export const MAX_LIFECYCLE_WAIT_MS = 30_000;
export const LIFECYCLE_STATUS_WAIT_MS = 3_000;
export const LIFECYCLE_POLL_INTERVAL_MS = 250;
export const FORCE_SHUTDOWN_GRACE_MS = 2_000;
export const TURN_REQUEST_TTL_MS = 5 * 60 * 1000;
export const MAX_TURN_REQUESTS = 1_000;
export const MAX_PROMPT_BYTES = 256 * 1024;
export const MAX_TURN_IMAGES = 6;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_BYTES = 24 * 1024 * 1024;
export const RETENTION_MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const SENSITIVE_GATEWAY_QUERY_KEYS = new Set(["access_token", "api_key", "key", "token", "authorization"]);
export const INVALID_REASONING_EFFORT_PROBE = "antcode_invalid_effort_probe";
export const MODEL_CAPABILITY_PROBE_REQUEST_TIMEOUT_MS = 10_000;
export const MODEL_CAPABILITY_PROBE_TOTAL_TIMEOUT_MS = 20_000;
export const MODEL_CAPABILITY_PROBE_MAX_RESPONSE_BYTES = 256 * 1024;
export const GATEWAY_DISCOVERY_TOKEN_TTL_MS = 5 * 60 * 1000;
export const MAX_GATEWAY_DISCOVERY_TOKENS = 256;

/** @typedef {{ ok: false; status: number; error: string; code?: string }} GatewayDiscoveryFailure */
/** @typedef {{ ids: string[]; models: Array<Record<string, any>> }} GatewayDiscoveryCatalog */
/** @typedef {{ ok: true; token: string | null; entry: Record<string, any> | null; catalog: GatewayDiscoveryCatalog }} GatewayDiscoveryResolution */
/** @typedef {{ ok: true; token: string; expiresAt: number; catalog: GatewayDiscoveryCatalog }} GatewayDiscoveryReceipt */
export const DASHBOARD_SETTINGS_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  transcript: Object.freeze(["enabled", "retentionDays", "encryption"]),
  network: Object.freeze(["mode", "allowedHosts"]),
  agents: Object.freeze([
    "maxParallelReadonlyAgentRuns",
    "backgroundWakeupEnabled",
    "backgroundByDefault",
    "reviewGateEnabled",
    "syncModelTiersOnSwitch",
    "goalMaxAutoContinues"
  ]),
  reliability: Object.freeze(["maxRetries", "timeoutMs", "idleTimeoutMs"])
});
export const DASHBOARD_SETTINGS_MANAGED_ENV: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  transcript: Object.freeze({
    enabled: "LAB_AGENT_TRANSCRIPT_ENABLED",
    retentionDays: "LAB_AGENT_TRANSCRIPT_RETENTION_DAYS",
    encryption: "LAB_AGENT_TRANSCRIPT_ENCRYPTION"
  }),
  network: Object.freeze({ mode: "LAB_AGENT_NETWORK_MODE" }),
  agents: Object.freeze({}),
  reliability: Object.freeze({
    maxRetries: "LAB_MODEL_GATEWAY_MAX_RETRIES",
    timeoutMs: "LAB_MODEL_GATEWAY_TIMEOUT_MS",
    idleTimeoutMs: "LAB_MODEL_GATEWAY_IDLE_TIMEOUT_MS"
  })
});
export const DASHBOARD_ACTIVE_SESSION_DEFAULTS = Object.freeze({
  max: 50,
  idleTtlMs: 30 * 60 * 1000,
  sweepIntervalMs: 60 * 1000
});
export const ALLOWED_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const VISIBLE_TRANSCRIPT_ROLES = new Set(["user", "assistant"]);
export const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "partial", "blocked", "cancelled", "interrupted"]);
export const TERMINAL_GROUP_STATUSES = new Set(["completed", "failed", "partial", "blocked", "cancelled", "interrupted"]);

export type DashboardTurnAttachment = {
  type?: string;
  name?: string;
  mimeType?: string;
  mime_type?: string;
  size?: number;
  data?: string;
  [key: string]: unknown;
};

export type DashboardQueueItem = {
  id: string;
  prompt?: string;
  kind?: string;
  permissionMode?: string;
  attachments?: DashboardTurnAttachment[];
  [key: string]: unknown;
};

export type DashboardChangeStats = {
  additions: number;
  deletions: number;
  files: number;
  redacted: boolean;
  truncated: boolean;
  approximate: boolean;
};

export type DashboardSessionEvent = {
  type?: string;
  sequence?: number;
  status?: string;
  coalesceKey?: unknown;
  id?: unknown;
  [key: string]: unknown;
};

export type DashboardEventListener = (event: DashboardSessionEvent) => void;

export type DashboardPendingApproval = {
  approvalKey?: string;
  resolve: (allowed: boolean) => void;
  [key: string]: unknown;
};

export type DashboardPendingQuestion = {
  question?: unknown;
  resolve: (result: unknown) => void;
  [key: string]: unknown;
};

export type DashboardActiveSessionState = {
  lastAccessedAt: number;
  accessVersion: number;
  session: Awaited<ReturnType<typeof createSession>>;
  runTurn: typeof runSessionTurn;
  persisted: boolean;
  status: string;
  running: boolean;
  interrupting: boolean;
  quarantinedTurnId: string;
  forceSettleTimer: ReturnType<typeof setTimeout> | NodeJS.Timeout | null;
  disposed: boolean;
  controller: AbortController | null;
  currentPrompt: string;
  currentTurnId: string;
  currentAttachmentBytes: number;
  currentTranscriptStart: number;
  currentPermissionMode: string;
  turnEnv: NodeJS.ProcessEnv | null;
  turnChangeStats: DashboardChangeStats;
  queuedPrompts: DashboardQueueItem[];
  events: DashboardSessionEvent[];
  eventSequence: number;
  listeners: Set<DashboardEventListener>;
  listenerDisposers: Map<DashboardEventListener, (reason?: unknown) => void>;
  sessionApprovals: Set<unknown>;
  pendingApprovals: Map<unknown, DashboardPendingApproval>;
  pendingQuestions: Map<unknown, DashboardPendingQuestion>;
  finalOutput: string;
  backgroundSnapshotTimer: ReturnType<typeof setInterval> | NodeJS.Timeout | null;
  backgroundSnapshotDirty: boolean;
  backgroundSnapshotPromise: Promise<unknown> | null;
  hooksTrusted: boolean;
};

export class ActiveSessionMap extends Map<string, DashboardActiveSessionState> {
  get(key: string): DashboardActiveSessionState | undefined {
    const state = super.get(key);
    if (state) {
      state.lastAccessedAt = Date.now();
      state.accessVersion = Number(state.accessVersion ?? 0) + 1;
    }
    return state;
  }

  peek(key: string): DashboardActiveSessionState | undefined {
    return super.get(key);
  }

  set(key: string, state: DashboardActiveSessionState): this {
    state.lastAccessedAt = Date.now();
    state.accessVersion = Number(state.accessVersion ?? 0) + 1;
    return super.set(key, state);
  }
}

export class ActiveSessionCapacityError extends Error {
  constructor() {
    super("No reclaimable Dashboard active session capacity is available");
    this.name = "ActiveSessionCapacityError";
  }
}

export type DashboardRequestInput = {
  sessionId?: string;
  clientId?: string;
  saveTarget?: string;
  section?: string;
  modelId?: string;
  model?: string;
  providerId?: string;
  profileId?: string;
  gatewayProfileId?: string;
  applyAgentDefaults?: boolean;
  requestId?: string;
  prompt?: string;
  values?: unknown;
  permissionMode?: string;
  reasoningEffort?: string;
  effort?: string;
  goalMode?: boolean;
  goalText?: string;
  id?: string;
  queueItemId?: string;
  groupId?: string;
  taskId?: string;
  guidance?: string;
  scope?: string;
  force?: boolean;
  before?: unknown;
  limit?: unknown;
  clientPreviousPermissionMode?: string | null;
  attachments?: unknown;
  [key: string]: unknown;
};

export type DashboardRuntimeSelection = {
  providerId?: string;
  modelId?: string;
  reasoningEffort?: string;
  provider?: string;
  model?: string;
};

export type GatewayDiscoveryCatalog = {
  ids: string[];
  models: Array<Record<string, unknown>>;
};

export type GatewayDiscoveryFailure = {
  ok: false;
  status: number;
  error: string;
  code?: string;
};

export type GatewayDiscoverySuccess = {
  ok: true;
  token: string | null;
  entry: Record<string, unknown> | null;
  catalog: GatewayDiscoveryCatalog;
};

export type GatewayDiscoveryReceipt = {
  ok: true;
  token: string;
  expiresAt: number;
  catalog: GatewayDiscoveryCatalog;
};

export type GatewayDiscoveryEntry = {
  expiresAt: number;
  identity: unknown;
  catalog: GatewayDiscoveryCatalog;
  [key: string]: unknown;
};

export type GatewayDiscoveryIdentity =
  | { ok: true; value: Record<string, unknown>; status?: undefined; error?: undefined }
  | { ok: false; status: number; error: string; code?: string; value?: undefined };

export type ModelConfigNormalized = {
  ok: true;
  saveTarget: string;
  profileId: string;
  gatewayUrl: string;
  gatewayHealthUrl: string;
  gatewayProtocol: string;
  gatewayApiKey: string;
  credentialAction?: string;
  previousModelId: string;
  previousGatewayUrl: string;
  previousGatewayProtocol: string;
  replaceModels: boolean;
  switchToModel: boolean;
  applyAgentDefaults: boolean;
  agentModelTiersProvided: boolean;
  visionAgentModelProvided: boolean;
  visionAgentModel: string;
  catalogModelIds: string[];
  catalogModels: Array<Record<string, unknown>>;
  manualAgentModelIds: string[];
  model: {
    id: string;
    label: string;
    description?: string;
    thinking?: boolean;
    reasoningEfforts?: Array<{ id: string; label?: string; description?: string }>;
    defaultReasoningEffort?: string | null;
    modalities?: string[];
    agentModelTiers?: Record<string, string>;
    contextTokens?: number | null;
  };
};

export type ModelConfigInputResult = ModelConfigNormalized | { ok: false; status: number; error: string; code?: string };

export type DashboardRuntimeContext = {
  active: ActiveSessionMap;
  sessionMutationLocks: Map<string, Promise<unknown>>;
  activeCapacityLocks: Map<string, Promise<unknown>>;
  activePolicy: DashboardActiveSessionPolicy;
  cwd: string;
  runtimeEnv: NodeJS.ProcessEnv;
  resolveConfigEnv: () => NodeJS.ProcessEnv | Promise<NodeJS.ProcessEnv | undefined> | undefined;
  processTrusted?: boolean;
  runtimeSelection?: DashboardRuntimeSelection;
  runTurn?: typeof runSessionTurn;
};

export type DashboardActiveSessionPolicy = {
  max: number;
  idleTtlMs: number;
  sweepIntervalMs: number;
};

export type TurnRequestRecord = {
  fingerprint: string;
  expiresAt: number;
  settled: boolean;
  promise: Promise<unknown> | null;
};

export type DashboardRuntimeActivity = {
  sessions: number;
  activeTurns: number;
  quarantinedTurns: number;
  queuedTurns: number;
  backgroundTasks: number;
  pendingInteractions: number;
  total: number;
  uncertain?: boolean;
};

export type DashboardSessionStatusView = {
  model: string;
  reasoningEffort: string | null;
  context?: Record<string, unknown> | null;
  providerId?: string;
  selectionResolved?: boolean;
  selectionIssue?: unknown;
  [key: string]: unknown;
};

export type DashboardContextSnapshot = {
  messages: AgentSession["messages"];
  contextWindow: AgentSession["contextWindow"];
  transcriptArchive: AgentSession["transcriptArchive"];
  modelContextArchive: AgentSession["modelContextArchive"];
};

export type EnsureTurnStateOptions = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  sessionId?: string;
  mode?: string;
  modelId?: string;
  reasoningEffort?: string;
  config?: LabAgentConfig;
  runTurn?: DashboardActiveSessionState["runTurn"];
  sessionMutationLocks: Map<string, Promise<unknown>>;
  activeCapacityLocks: Map<string, Promise<unknown>>;
  activePolicy?: DashboardActiveSessionPolicy;
};

export type RequireExactSessionIdOptions = {
  sessionId: string;
  cwd: string;
  config: LabAgentConfig;
  env?: NodeJS.ProcessEnv;
};

export type CatalogOk = { ok: true; ids: string[]; models?: Array<Record<string, unknown>>; error?: undefined; status?: undefined; code?: undefined };
export type CatalogErr = { ok: false; status: number; code?: string; error: string; ids?: undefined; models?: undefined };
export type CatalogResult = CatalogOk | CatalogErr;

export type ConfigSourceView = {
  type: string;
  label: string;
  id?: string;
  modelScopes?: Record<string, string>;
};

export type CreateDashboardRuntimeOptions = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  runTurn?: typeof runSessionTurn;
  lifecycleActivity?: (active: ActiveSessionMap, cwd: string, extra?: unknown) => Promise<unknown>;
  cancelBackgroundWork?: (state: DashboardActiveSessionState, options?: Record<string, unknown>) => Promise<unknown>;
  gatewayDiscoveryTtlMs?: number;
  gatewayDiscoveryNow?: () => number;
};


export type TurnSubmissionResult =
  | { ok: true; prompt: string; attachments: DashboardTurnAttachment[] }
  | { ok: false; status: number; code?: string; error: string };


export type RuntimeActivityReader = (
  active: ActiveSessionMap,
  cwd: string,
  extra?: unknown
) => unknown;


/**
 * @param {(signal: AbortSignal) => any} operation
 * @param {number} deadline
 */
export type LifecycleProbe<T = unknown> =
  | { settled: true; value?: T; error?: unknown }
  | { settled: false; value?: T; error?: unknown };


/**
 * Persist one complete provider/model/effort selection without touching the
 * Config V2 default. Active and archived sessions share this commit path so a
 * process restart cannot change the provider behind a historical model name.
 *
 * @param {{
 *   active: Map<string, Record<string, any>>;
 *   sessionMutationLocks: Map<string, Promise<any>>;
 *   cwd: string;
 *   env: NodeJS.ProcessEnv;
 *   sessionId: string;
 *   config: Record<string, any>;
 *   expectedSelection?: Record<string, any> | null;
 *   lockHeld?: boolean;
 * }} options
 */
export type PersistDashboardSessionModelConfigResult = {
  ok: boolean;
  status?: number;
  code?: string;
  error?: string;
  sessionId?: string;
  state?: DashboardActiveSessionState | null;
  sessionStatus?: unknown;
  metadata?: Record<string, unknown>;
};


/** @param {Record<string, any>} session @param {Record<string, any>} config */
export type DashboardV2MutationView = {
  previousSelection: unknown;
  resolution: SessionModelSelectionResolution;
  config: LabAgentConfig;
};


/** @param {Record<string, any>} options @param {string} effort */
export type ReasoningProbeRequestOptions = {
  protocol: string;
  modelId: string;
  inferenceUrl: string;
  headers: Record<string, string>;
  signal?: AbortSignal;
  deadlineAt: number;
  maxResponseBytes: number;
};


/** @param {Record<string, any>} input */
export type ReasoningProbeInput = {
  protocol?: unknown;
  modelId?: unknown;
  inferenceUrl?: unknown;
  apiKeyUsed?: unknown;
  outcome?: unknown;
  acceptedEfforts?: unknown;
  reasoningField?: unknown;
  warnings?: unknown;
  negativeControl?: unknown;
  efforts?: unknown;
  failure?: { message?: string; kind?: string };
};


export type ReasoningProbeResult = {
  ok: boolean;
  status?: number;
  error?: string;
  outcome?: string;
  protocol?: unknown;
  modelId?: string;
  inferenceUrl?: unknown;
  apiKeyUsed?: unknown;
  acceptedEfforts?: unknown[];
  reasoningEfforts?: unknown;
  defaultReasoningEffort?: unknown;
  reasoningDiscovery?: unknown;
  negativeControl?: unknown;
  efforts?: unknown;
  diagnostic?: unknown;
};


/** @param {Record<string, any>} input @param {Record<string, any>} config @param {NodeJS.ProcessEnv} [env] */
export type DashboardSettingsInputResult =
  | { ok: false; status: number; error: string; code?: string }
  | { ok: true; section: string; saveTarget: string; changedFields?: unknown; values: Record<string, unknown>; hosts?: string[] };


export type DashboardGatewayProfileRecord = {
  id: string;
  label: string;
  gatewayUrl: string;
  gatewayHealthUrl: string;
  gatewayProtocol: string;
  gatewayApiKey: string;
  gatewayApiKeyDisabled: boolean;
  modelAlias: string;
  models: DashboardModelConfigEntry[];
  agents?: Record<string, unknown>;
};


export type DashboardModelConfigEntry = {
  id: string;
  label?: string;
  description?: string;
  thinking?: boolean;
  modalities?: string[];
  contextTokens?: number;
  reasoningContentMode?: unknown;
  reasoningEfforts?: unknown;
  defaultReasoningEffort?: unknown;
  agentModelTiers?: Record<string, string>;
  [key: string]: unknown;
};


export type TranscriptPageView = {
  ok?: boolean;
  messages?: unknown[];
  positions?: unknown[];
  chunksRead?: number;
  summary?: {
    start?: number;
    end?: number;
    total?: number;
    cursor?: unknown;
    nextCursor?: unknown;
    hasMore?: boolean;
    returned?: number;
  };
};
