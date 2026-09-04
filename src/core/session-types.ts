import crypto from "node:crypto";
import { buildInitialContext } from "../context/builder.ts";
import { loadConfig, type LabAgentConfig } from "../config/load-config.ts";
import {
  applyRuntimeModelSelection,
  currentRuntimeModelSelection,
  patchSessionModelSelectionMetadata,
  resolveSessionModelSelection
} from "../config-v2/runtime-selection.ts";
import { formatGatewayError, normalizeGatewayError } from "../model-gateway/errors.ts";
import { createLabModelGateway } from "../model-gateway/client.ts";
import { listConfiguredModels, listRoutingModels } from "../model-gateway/models.ts";
import { runHooks } from "../hooks/runner.ts";
import { createMcpRuntime } from "../mcp/runtime.ts";
import { appendThinkingPreview, limitThinkingPreview } from "../model-gateway/thinking-budget.ts";
import { createSessionStore } from "../storage/session-store.ts";
import { serializeToolResult } from "../tools/result.ts";
import { countLineChanges } from "../tools/diff.ts";
import { createToolRuntime } from "../tools/runtime.ts";
import { createWorkflowState, formatWorkflowContext, summarizeWorkflow, syncWorkflowCompletionOnFinal, type WorkflowState } from "../tools/workflow-tools.ts";
import { getAgentProfile } from "../agents/profiles.ts";
import { resolveMaxParallelReadonlyAgentRuns } from "../agents/orchestration-config.ts";
import { appendDelegationReminderToExecution, createDelegationGuard } from "../agents/delegation-guard.ts";
import { createReviewGate } from "../agents/review-policy.ts";
import { buildCompactedContextMessage, compactSessionContextWithModel, createContextWindow, estimatePromptPayload, summarizeContextWindow } from "./context-window.ts";
import { buildGoalSystemPromptAppendix, normalizeSessionGoal, serializeSessionGoal, stripGoalStatusFromContent, stripGoalStatusMarkers } from "./goal.ts";
import { createAntEventNormalizer } from "./events.ts";
import { accumulateProviderUsage, normalizeProviderUsageAggregate, sanitizeProviderUsage, type ProviderUsageAggregate } from "./provider-usage.ts";
import { resolveMainToolRounds } from "./tool-rounds.ts";
import { diagnoseWorkspace } from "./workspace-diagnostics.ts";

export const DEFAULT_PROMPT_COMPACT_RATIO = 1;
export const OUTPUT_HEALTH_CHECK_ENABLED = false;
export const OUTPUT_HEALTH_MAX_RETRIES = 1;
export const OUTPUT_HEALTH_RETRY_REQUIRED_REASONS = new Set([
  "missing_terminal_signal",
  "repetitive_thinking_loop",
  "reasoning_only_length"
]);
export const TRANSCRIPT_MEMORY_MESSAGES = 50;
export const DEFAULT_RESUME_CONTEXT_MESSAGES = 200;
export const DEFAULT_RESUME_CONTEXT_TOKENS = 200_000;
export const DEFAULT_RESUME_CONTEXT_BYTES = 1_000_000;

export type CreateSessionOptions = {
  cwd: string;
  mode: "interactive" | "print";
  clientSurface?: "tui" | "dashboard" | "chat" | "print" | string;
  env?: NodeJS.ProcessEnv;
  readonly?: boolean;
  allowWrite?: boolean;
  allowCommand?: boolean;
  fullAccess?: boolean;
  resume?: string | null;
  resumeFullContext?: boolean;
  hooksTrusted?: boolean;
};

export type SessionMessage = {
  role: string;
  content?: unknown;
  thinking?: unknown;
  name?: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
  toolCalls?: Array<{ id?: string; name?: string; input?: unknown }>;
  toolCallId?: string;
  interruptedDraft?: boolean;
};

export type AgentSession = {
  id: string;
  cwd: string;
  startedAt: string;
  mode: "interactive" | "print";
  clientSurface: string;
  permissionMode: string;
  fullAccess: boolean;
  permissionReadonlyLocked: boolean;
  readonly: boolean;
  allowWrite: boolean;
  allowCommand: boolean;
  networkMode: string;
  sensitivity: string;
  model: string;
  modelSelection: unknown;
  config: LabAgentConfig;
  context: Awaited<ReturnType<typeof buildInitialContext>>;
  workspaceDiagnostic: { warning?: string; [key: string]: unknown } | null | undefined;
  contextWindow: ReturnType<typeof createContextWindow>;
  workflow: WorkflowState;
  messages: SessionMessage[];
  transcriptMessages: SessionMessage[];
  transcriptArchive: TranscriptArchiveState;
  modelContextArchive: TranscriptArchiveState;
  usage: ProviderUsageAggregate;
  lastProviderUsage: unknown;
  title: string | null;
  turnCount: number;
  goal: ReturnType<typeof normalizeSessionGoal>;
  resumedFrom: { id?: unknown; metadataPath?: unknown; contextWindow?: ReturnType<typeof createContextWindow>; messages?: SessionMessage[]; transcriptMessages?: SessionMessage[]; [key: string]: unknown } | null | undefined;
  modelSelectionInvalidation?: unknown;
  pendingModelSelectionMutation?: unknown;
  visualEvidence?: import("./visual-evidence.ts").VisualEvidenceStore;
  [key: string]: unknown;
};

export type SessionEvent = {
  type?: string;
  [key: string]: unknown;
};

export type TranscriptArchiveChunk = {
  index: number;
  file: string;
  messages: number;
  visibleMessages: number | null;
  bytes: number;
  encrypted: boolean;
};

export type RestoredContextMessages = {
  messages: SessionMessage[];
  persistedMessages: SessionMessage[];
  fromArchive: boolean;
  clearPersistedSummary?: boolean;
  limited?: boolean;
  limitReason?: string;
};

export type TranscriptArchiveState = {
  version: number;
  chunkSize: number;
  totalMessages: number;
  totalVisibleMessages: number | null;
  chunks: TranscriptArchiveChunk[];
  pendingMessages: unknown[];
};

export type TurnChangeFileSnapshot = {
  before: string;
  after: string;
  redacted: boolean;
  truncated: boolean;
  approximate: boolean;
};

export type TurnChangeTracker = {
  files: Map<string, TurnChangeFileSnapshot>;
};

export type RunSessionTurnOptions = {
  prompt: string;
  displayPrompt?: string;
  attachments?: Array<Record<string, unknown>>;
  env?: NodeJS.ProcessEnv;
  stream?: boolean;
  signal?: AbortSignal;
  approvalCallback?: (request: {
    toolName: string;
    input: Record<string, unknown>;
    decision: Record<string, unknown>;
    definition: Record<string, unknown>;
  }) => boolean | Promise<boolean>;
  userInputCallback?: (input: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>;
  onEvent?: (event: SessionEvent) => void | Promise<void>;
  onAntEvent?: (event: Record<string, unknown>) => void | Promise<void>;
  hooksTrusted?: boolean;
};

export type SessionToolResult = {
  toolCallId?: string;
  name?: string;
  content?: string;
  interrupted?: boolean;
  truncated?: boolean;
  [key: string]: unknown;
};

export type GatewayRoundRecord = {
  round: number;
  request?: {
    messageCount?: unknown;
    toolResultCount?: unknown;
    toolSchemaCount?: unknown;
    promptBytesEstimate?: unknown;
    promptTokensEstimate?: unknown;
    promptMessageTokensEstimate?: unknown;
    promptToolSchemaTokensEstimate?: unknown;
    promptToolResultTokensEstimate?: unknown;
  };
  response?: {
    messageId?: unknown;
    model?: unknown;
    textBytes?: number;
    thinkingBytes?: unknown;
    toolCallCount?: number;
    stopReason?: unknown;
    usage?: unknown;
  };
  error?: unknown;
};

export type SessionTurnMetadata = {
  id: string;
  title: string | null;
  turnIndex: number;
  cwd: string;
  startedAt: string;
  mode: string;
  clientSurface: string;
  permissionMode: string;
  fullAccess: boolean;
  permissionReadonlyLocked: boolean;
  readonly: boolean;
  allowWrite: boolean;
  allowCommand: boolean;
  networkMode: string;
  sensitivity: string;
  prompt: string;
  promptBytes: number;
  outputBytes: number;
  status: string;
  rounds: number;
  gatewayRounds: GatewayRoundRecord[];
  outputHealth: unknown[];
  interruptedDraft: unknown;
  toolCalls: unknown[];
  gatewayErrors: unknown[];
  usage: unknown;
  workflow: unknown;
  context: unknown;
  goal: unknown;
  resumedFrom?: { id?: unknown; metadataPath?: unknown };
  [key: string]: unknown;
};
