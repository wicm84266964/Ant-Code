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
import { DEFAULT_TOOL_RESULT_MAX_BYTES } from "../tools/result.ts";
import { formatToolResultForModel } from "../tools/result-view.ts";
import { extractImagePayloads, registerVisualEvidence } from "./visual-evidence.ts";
import { countLineChanges, previewUnifiedDiff } from "../tools/diff.ts";
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
import {
  DEFAULT_PROMPT_COMPACT_RATIO,
  OUTPUT_HEALTH_CHECK_ENABLED,
  OUTPUT_HEALTH_MAX_RETRIES,
  OUTPUT_HEALTH_RETRY_REQUIRED_REASONS,
  TRANSCRIPT_MEMORY_MESSAGES,
  DEFAULT_RESUME_CONTEXT_MESSAGES,
  DEFAULT_RESUME_CONTEXT_TOKENS,
  DEFAULT_RESUME_CONTEXT_BYTES
} from "./session-types.ts";
import type {
  CreateSessionOptions,
  SessionMessage,
  AgentSession,
  SessionEvent,
  TranscriptArchiveChunk,
  RestoredContextMessages,
  TranscriptArchiveState,
  TurnChangeTracker,
  RunSessionTurnOptions,
  SessionToolResult,
  SessionTurnMetadata,
  GatewayRoundRecord
} from "./session-types.ts";
import {
  isPlainObject,
  gatewayThinkingBytes
} from "./session-health.ts";
import {
  configForLegacySessionResume,
  sessionModelMetadata,
  normalizeTranscriptArchiveState,
  sanitizePersistedValue
} from "./session-persist.ts";
import {
  SessionModelSelectionUnresolvedError
} from "./session-error.ts";
import {
  restoreRecentTranscriptMessages,
  restoreResumeContextMessages,
  limitRestoredContextToPromptBudget,
  clearPersistedContextSummary,
  hasPersistedCompaction,
  redactPersistedText,
  makeSessionTitle,
  nonNegativeInteger,
  emitEvent
} from "./session-resume.ts";


/**
 * @param {import("../model-gateway/protocol.ts").GatewayToolCall} call
 */
export function skippedInterruptedToolResult(call: import("../model-gateway/protocol.ts").GatewayToolCall) {
  return {
    toolCallId: call.id,
    name: call.name,
    content: JSON.stringify({
      ok: false,
      interrupted: true,
      error: { code: "TOOL_INTERRUPTED", message: `${call.name} was skipped because the turn was interrupted.` }
    }, null, 2),
    truncated: false,
    interrupted: true
  };
}

/**
 * @param {import("../model-gateway/protocol.ts").GatewayToolCall[]} toolCalls
 * @param {ReturnType<typeof createToolRuntime>} toolRuntime
 */


/**
 * @param {import("../model-gateway/protocol.ts").GatewayToolCall[]} toolCalls
 * @param {ReturnType<typeof createToolRuntime>} toolRuntime
 */
export function createToolExecutionBatches(toolCalls: import("../model-gateway/protocol.ts").GatewayToolCall[], toolRuntime: ReturnType<typeof createToolRuntime>) {
  const batches = [];
  let parallel: import("../model-gateway/protocol.ts").GatewayToolCall[] = [];
  const maxParallelAgentRuns = resolveMaxParallelReadonlyAgentRuns(toolRuntime.config);
  const flushParallel = () => {
    if (parallel.length > 0) {
      batches.push({ parallel: true, calls: parallel });
      parallel = [];
    }
  };

  for (const call of toolCalls) {
    if (isParallelAgentRun(call, toolRuntime)) {
      parallel.push(call);
      if (parallel.length >= maxParallelAgentRuns) {
        flushParallel();
      }
      continue;
    }
    flushParallel();
    batches.push({ parallel: false, calls: [call] });
  }
  flushParallel();
  return batches;
}

/**
 * @param {import("../model-gateway/protocol.ts").GatewayToolCall} call
 * @param {ReturnType<typeof createToolRuntime>} toolRuntime
 */


/**
 * @param {import("../model-gateway/protocol.ts").GatewayToolCall} call
 * @param {ReturnType<typeof createToolRuntime>} toolRuntime
 */
export function isParallelAgentRun(call: import("../model-gateway/protocol.ts").GatewayToolCall, toolRuntime: ReturnType<typeof createToolRuntime>) {
  if (call?.name !== "agent_run") {
    return false;
  }
  const input = call.input && typeof call.input === "object" ? call.input : {};
  const profileName = String(input.profile ?? input.profileName ?? "");
  const profile = getAgentProfile(profileName, toolRuntime.config, { cwd: toolRuntime.cwd });
  if (!profile) {
    return false;
  }
  return profile.mode === "readonly" && input.parallel !== false;
}

/**
 * @param {import("../model-gateway/protocol.ts").GatewayToolCall} call
 * @param {ReturnType<typeof createToolRuntime>} toolRuntime
 * @param {{ onEvent?: (event: SessionEvent) => void | Promise<void>; signal?: AbortSignal; delegationGuard?: ReturnType<typeof createDelegationGuard>; reviewGate?: ReturnType<typeof createReviewGate> }} options
 */


/**
 * @param {import("../model-gateway/protocol.ts").GatewayToolCall} call
 * @param {ReturnType<typeof createToolRuntime>} toolRuntime
 * @param {{ onEvent?: (event: SessionEvent) => void | Promise<void>; signal?: AbortSignal; delegationGuard?: ReturnType<typeof createDelegationGuard>; reviewGate?: ReturnType<typeof createReviewGate> }} options
 */
export async function executeOneToolCall(call: import("../model-gateway/protocol.ts").GatewayToolCall, toolRuntime: ReturnType<typeof createToolRuntime>, options: { onEvent?: (event: SessionEvent) => void | Promise<void>; signal?: AbortSignal; delegationGuard?: ReturnType<typeof createDelegationGuard>; reviewGate?: ReturnType<typeof createReviewGate>; turnChangeTracker?: TurnChangeTracker } = {}, agentTaskIds: Set<string> = new Set()) {
  const input: Record<string, unknown> = call.input && typeof call.input === "object" ? call.input : {};
  const taskId = call.name === "agent_run"
    ? uniqueAgentTaskId(input.taskId, agentTaskIds)
    : null;
  const effectiveInput = taskId ? { ...input, taskId } : call.input;
  await emitEvent(options, {
    type: "tool_start",
    toolCallId: call.id,
    name: call.name,
    taskId,
    profile: call.name === "agent_run" ? effectiveInput?.profile ?? effectiveInput?.profileName ?? null : null,
    inputKeys: Object.keys(effectiveInput ?? {}).sort()
  });
  let execution: import("../tools/runtime.ts").ToolExecutionResult = await toolRuntime.execute(call.name, effectiveInput) as import("../tools/runtime.ts").ToolExecutionResult;
  options.reviewGate?.observeToolResult(call.name, effectiveInput, execution);
  const reminder = options.delegationGuard?.observeToolResult(call.name, effectiveInput, execution);
  if (reminder) {
    execution = appendDelegationReminderToExecution(execution, reminder);
    await emitEvent(options, {
      type: "delegation_guard",
      toolCallId: call.id,
      name: call.name,
      level: reminder.level,
      reason: reminder.reason,
      broadActions: reminder.broadActions,
      suggestedProfiles: reminder.suggestedProfiles
    });
    await runHooks({
      config: toolRuntime.config,
      cwd: toolRuntime.cwd,
      hooksTrusted: toolRuntime.hooksTrusted,
      event: "delegation.guard",
      sessionId: toolRuntime.parentSessionId,
      payload: {
        toolName: call.name,
        level: reminder.level,
        reason: reminder.reason,
        broadActions: reminder.broadActions,
        suggestedProfiles: reminder.suggestedProfiles
      }
    });
  }
  const changeSummary = summarizeToolChangeStats(
    call.name,
    execution.result && typeof execution.result === "object" && !Array.isArray(execution.result)
      ? execution.result as Record<string, unknown>
      : {},
    {
      turnChangeTracker: options.turnChangeTracker
    }
  );
  const executionForModel = omitInternalToolResultFields(execution);
  const harvested = extractImagePayloads(executionForModel);
  const evidence = [];
  for (const image of harvested) {
    const registered = registerVisualEvidence(toolRuntime.visualEvidence, {
      source: "mcp",
      name: image.name,
      mimeType: image.mimeType,
      data: image.data,
      bytes: image.size,
      toolCallId: call.id
    });
    if (registered) {
      evidence.push(registered);
    }
  }
  const serialized = formatToolResultForModel(call.name, executionForModel, {
    maxBytes: resolveParentToolResultMaxBytes(toolRuntime.config),
    evidence
  });
  await emitEvent(options, {
    type: "tool_finish",
    toolCallId: call.id,
    name: call.name,
    taskId: taskId ?? execution.taskId ?? null,
    profile: call.name === "agent_run" ? execution.profile ?? effectiveInput?.profile ?? effectiveInput?.profileName ?? null : null,
    taskStatus: call.name === "agent_run"
      ? normalizeAgentTaskStatus(execution)
      : null,
    outputSummary: call.name === "agent_run" ? execution.outputSummary ?? execution.output ?? (typeof execution.error === "object" && execution.error ? execution.error.message : execution.error) ?? "" : null,
    ok: execution.ok === true,
    blocked: execution.blocked === true,
    interrupted: execution.interrupted === true,
    errorCode: typeof execution.error === "object" && execution.error ? execution.error.code ?? null : null,
    decision: execution.decision && typeof execution.decision === "object" ? execution.decision.decision ?? null : null,
    changeStats: changeSummary?.changeStats ?? null,
    turnChangeStats: changeSummary?.turnChangeStats ?? null,
    path: typeof execution.result === "object" && execution.result && "path" in execution.result
      ? String((execution.result as { path?: unknown }).path ?? "") || null
      : null,
    diffPreview: typeof execution.result === "object" && execution.result && "diff" in execution.result
      ? previewUnifiedDiff((execution.result as { diff?: unknown }).diff, 40)
      : null,
    resultBytes: serialized.bytes,
    truncated: serialized.truncated
  });
  return {
    toolCallId: call.id,
    name: call.name,
    content: serialized.content,
    truncated: serialized.truncated,
    interrupted: execution.interrupted === true
  };
}

function resolveParentToolResultMaxBytes(config: LabAgentConfig | undefined) {
  const configured = Number(config?.context && typeof config.context === "object"
    ? (config.context as { maxToolResultBytes?: unknown }).maxToolResultBytes
    : undefined);
  if (Number.isInteger(configured) && configured > 0) {
    return configured;
  }
  return DEFAULT_TOOL_RESULT_MAX_BYTES;
}


export function uniqueAgentTaskId(value: unknown, seen: Set<string>) {
  const base = String(value ?? `task-${crypto.randomUUID()}`).trim() || `task-${crypto.randomUUID()}`;
  if (!seen.has(base)) {
    seen.add(base);
    return base;
  }
  for (let index = 2; ; index += 1) {
    const candidate = `${base}-${index}`;
    if (!seen.has(candidate)) {
      seen.add(candidate);
      return candidate;
    }
  }
}


export function normalizeAgentTaskStatus(execution: {
  taskStatus?: unknown;
  result?: unknown;
  partial?: boolean;
  interrupted?: boolean;
  ok?: boolean;
  blocked?: boolean;
} = {}) {
  if (execution.taskStatus) {
    return String(execution.taskStatus);
  }
  if (execution.result && typeof execution.result === "object" && "status" in execution.result && execution.result.status) {
    return String(execution.result.status);
  }
  return execution.partial ? "partial" : execution.interrupted ? "interrupted" : execution.ok ? "completed" : execution.blocked ? "blocked" : "failed";
}


export function omitInternalToolResultFields(execution: import("../tools/runtime.ts").ToolExecutionResult) {
  if (!execution?.result || typeof execution.result !== "object" || Array.isArray(execution.result)) {
    return execution;
  }
  const { __changeSnapshot: _snapshot, ...result } = execution.result as Record<string, unknown>;
  return {
    ...execution,
    result
  };
}


export function summarizeToolChangeStats(name: string, result: Record<string, unknown>, options: { turnChangeTracker?: TurnChangeTracker } = {}) {
  if (!result || typeof result !== "object") {
    return null;
  }
  if (name !== "write_file" && name !== "edit_file") {
    return null;
  }
  if (name === "edit_file" && result.edited === false) {
    return null;
  }
  const stats = normalizeResultChangeStats(result.changeStats) ?? countUnifiedDiffChanges(result.diff);
  const changeStats = {
    path: typeof result.path === "string" ? result.path : stats.path ?? null,
    additions: stats.additions,
    deletions: stats.deletions,
    files: 1,
    redacted: result.diffRedacted === true,
    truncated: result.diffTruncated === true,
    approximate: stats.approximate === true
  };
  const turnChangeStats = updateTurnChangeTrackerForTool(options.turnChangeTracker, {
    result,
    changeStats
  });
  if (stats.additions === 0 && stats.deletions === 0 && result.diffRedacted !== true) {
    return turnChangeStats ? { changeStats: null, turnChangeStats } : null;
  }
  return { changeStats, turnChangeStats };
}


export function normalizeResultChangeStats(value: unknown) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  return {
    path: typeof record.path === "string" ? record.path : null,
    additions: nonNegativeInteger(record.additions, 0),
    deletions: nonNegativeInteger(record.deletions, 0),
    approximate: record.approximate === true
  };
}


export function createTurnChangeTracker() {
  return {
    files: new Map()
  };
}


export function updateTurnChangeTrackerForTool(tracker: TurnChangeTracker | undefined, options: {
  result?: Record<string, unknown>;
  changeStats?: { redacted?: boolean; truncated?: boolean; approximate?: boolean };
}) {
  const snapshotValue = options.result?.__changeSnapshot;
  const snapshot = snapshotValue && typeof snapshotValue === "object" ? snapshotValue as Record<string, unknown> : null;
  if (!tracker || !options?.changeStats || !snapshot || typeof snapshot.path !== "string") {
    return null;
  }
  const before = typeof snapshot.before === "string" ? snapshot.before : "";
  const existing = tracker.files.get(snapshot.path) ?? {
    before,
    after: before,
    redacted: false,
    truncated: false,
    approximate: false
  };
  if (typeof snapshot.after === "string") {
    existing.after = snapshot.after;
  }
  existing.redacted ||= options.changeStats.redacted === true || snapshot.redacted === true;
  existing.truncated ||= options.changeStats.truncated === true;
  existing.approximate ||= options.changeStats.approximate === true;
  tracker.files.set(snapshot.path, existing);
  return summarizeTurnChangeTracker(tracker);
}


export function summarizeTurnChangeTracker(tracker: TurnChangeTracker | null | undefined) {
  const summary = {
    additions: 0,
    deletions: 0,
    files: 0,
    redacted: false,
    truncated: false,
    approximate: false
  };
  if (!tracker?.files) {
    return summary;
  }
  for (const item of tracker.files.values()) {
    summary.redacted ||= item.redacted === true;
    summary.truncated ||= item.truncated === true;
    summary.approximate ||= item.approximate === true;
    if (item.redacted === true) {
      summary.files += 1;
      continue;
    }
    const stats = countLineChanges(item.before, item.after);
    summary.additions += stats.additions;
    summary.deletions += stats.deletions;
    summary.approximate ||= stats.approximate === true;
    if (stats.additions > 0 || stats.deletions > 0) {
      summary.files += 1;
    }
  }
  return summary;
}


export function countUnifiedDiffChanges(diff: unknown): { path?: string | null; additions: number; deletions: number; approximate?: boolean } {
  const stats = { path: null as string | null, additions: 0, deletions: 0 };
  if (typeof diff !== "string" || !diff) {
    return stats;
  }
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+++") || line.startsWith("---")) {
      continue;
    }
    if (line.startsWith("+")) {
      stats.additions += 1;
    } else if (line.startsWith("-")) {
      stats.deletions += 1;
    }
  }
  return stats;
}

export function createTurnMetadata(session: AgentSession, prompt: string): SessionTurnMetadata {
  session.title ??= makeSessionTitle(prompt);
  const metadata: SessionTurnMetadata = {
    ...sessionModelMetadata(session),
    id: session.id,
    title: session.title,
    turnIndex: session.turnCount,
    cwd: session.cwd,
    startedAt: session.startedAt,
    mode: session.mode,
    clientSurface: session.clientSurface,
    permissionMode: session.permissionMode,
    fullAccess: session.fullAccess,
    permissionReadonlyLocked: session.permissionReadonlyLocked,
    readonly: session.readonly,
    allowWrite: session.allowWrite,
    allowCommand: session.allowCommand,
    networkMode: session.networkMode,
    sensitivity: session.sensitivity,
    prompt: redactPersistedText(prompt),
    promptBytes: Buffer.byteLength(prompt, "utf8"),
    outputBytes: 0,
    status: "started",
    rounds: 0,
    gatewayRounds: [] as SessionTurnMetadata["gatewayRounds"],
    outputHealth: [] as unknown[],
    interruptedDraft: null,
    toolCalls: [] as unknown[],
    gatewayErrors: [] as unknown[],
    usage: normalizeProviderUsageAggregate(session.usage),
    workflow: summarizeWorkflow(session.workflow),
    context: summarizeContextWindow(session),
    goal: serializeSessionGoal(session.goal)
  };
  if (session.resumedFrom) {
    metadata.resumedFrom = {
      id: session.resumedFrom.id,
      metadataPath: session.resumedFrom.metadataPath
    };
  }
  return metadata;
}


export function recordGatewayRoundRequest(metadata: SessionTurnMetadata | null | undefined, details: {
  round?: unknown;
  messageCount?: unknown;
  toolResultCount?: unknown;
  toolSchemaCount?: unknown;
  promptEstimate?: {
    bytes?: unknown;
    tokens?: unknown;
    messageTokens?: unknown;
    toolSchemaTokens?: unknown;
    toolResultTokens?: unknown;
  };
  [key: string]: unknown;
}) {
  if (!metadata || !Array.isArray(metadata.gatewayRounds)) {
    return;
  }
  const round = Number.isFinite(Number(details.round)) ? Number(details.round) : metadata.gatewayRounds.length + 1;
  const existing = metadata.gatewayRounds.find((item) => item.round === round);
  const target: GatewayRoundRecord = existing ?? { round };
  const estimate = details.promptEstimate;
  target.request = {
    messageCount: details.messageCount ?? null,
    toolResultCount: details.toolResultCount ?? null,
    toolSchemaCount: details.toolSchemaCount ?? null,
    promptBytesEstimate: estimate?.bytes ?? null,
    promptTokensEstimate: estimate?.tokens ?? null,
    promptMessageTokensEstimate: estimate?.messageTokens ?? null,
    promptToolSchemaTokensEstimate: estimate?.toolSchemaTokens ?? null,
    promptToolResultTokensEstimate: estimate?.toolResultTokens ?? null
  };
  if (!existing) {
    metadata.gatewayRounds.push(target);
  }
}


export function recordGatewayRoundResponse(metadata: SessionTurnMetadata | null | undefined, details: {
  round?: unknown;
  response?: {
    id?: unknown;
    model?: unknown;
    text?: unknown;
    toolCalls?: unknown;
    stopReason?: unknown;
    usage?: unknown;
  };
  [key: string]: unknown;
}) {
  if (!metadata || !Array.isArray(metadata.gatewayRounds)) {
    return;
  }
  const round = Number.isFinite(Number(details.round)) ? Number(details.round) : metadata.gatewayRounds.length + 1;
  const existing = metadata.gatewayRounds.find((item) => item.round === round);
  const target: GatewayRoundRecord = existing ?? { round };
  const response = details.response;
  target.response = {
    messageId: response?.id ?? null,
    model: response?.model ?? null,
    textBytes: Buffer.byteLength(String(response?.text ?? ""), "utf8"),
    thinkingBytes: gatewayThinkingBytes(response),
    toolCallCount: Array.isArray(response?.toolCalls) ? response.toolCalls.length : 0,
    stopReason: response?.stopReason ?? null,
    usage: sanitizeProviderUsage(response?.usage)
  };
  if (!existing) {
    metadata.gatewayRounds.push(target);
  }
}


export function recordGatewayRoundError(metadata: SessionTurnMetadata | null | undefined, details: {
  round?: unknown;
  error?: { code?: unknown; message?: unknown; status?: unknown; details?: unknown };
  [key: string]: unknown;
}) {
  if (!metadata || !Array.isArray(metadata.gatewayRounds)) {
    return;
  }
  const round = Number.isFinite(Number(details.round)) ? Number(details.round) : metadata.gatewayRounds.length + 1;
  const existing = metadata.gatewayRounds.find((item) => item.round === round);
  const target: GatewayRoundRecord = existing ?? { round };
  const error = details.error;
  target.error = {
    code: error?.code ?? "GATEWAY_ERROR",
    message: redactPersistedText(error?.message ?? "request failed"),
    status: error?.status ?? null,
    details: sanitizeGatewayErrorDetails(error?.details)
  };
  if (!existing) {
    metadata.gatewayRounds.push(target);
  }
}


export function sanitizeGatewayErrorDetails(details: unknown) {
  if (!details || typeof details !== "object") {
    return {};
  }
  return sanitizePersistedValue(details);
}


export function recordOutputHealth(metadata: SessionTurnMetadata | null | undefined, details: {
  round?: unknown;
  ok?: unknown;
  reasons?: unknown;
  retry?: unknown;
} = {}) {
  if (!metadata || !Array.isArray(metadata.outputHealth)) {
    return;
  }
  metadata.outputHealth.push({
    round: details.round ?? null,
    ok: details.ok === true,
    reasons: Array.isArray(details.reasons) ? details.reasons : [],
    retry: details.retry === true
  });
}


export function recordSessionProviderUsage(session: AgentSession, usage: unknown, details: { round?: number; model?: string | null } | unknown = {}) {
  const sanitized = sanitizeProviderUsage(usage);
  if (!sanitized) {
    return null;
  }
  const extra = details && typeof details === "object" && !Array.isArray(details)
    ? details as { round?: number; model?: string | null }
    : {};
  session.usage = accumulateProviderUsage(session.usage, sanitized, extra);
  session.lastProviderUsage = session.usage.last ?? sanitized;
  return session.usage;
}

/**
 * @param {{ cwd: string; config: Record<string, any>; tools?: Array<Record<string, any>>; env?: NodeJS.ProcessEnv; resume: string; preferFullContext?: boolean }} options
 */


/**
 * @param {{ cwd: string; config: Record<string, any>; tools?: Array<Record<string, any>>; env?: NodeJS.ProcessEnv; resume: string; preferFullContext?: boolean }} options
 */
export async function resolveResumeMetadata(options: { cwd: string; config: LabAgentConfig; tools?: Array<Record<string, unknown>>; env?: NodeJS.ProcessEnv; resume: string; preferFullContext?: boolean }) {
  const store = createSessionStore({
    cwd: options.cwd,
    transcript: options.config.transcript,
    env: options.env ?? process.env
  });
  const result = await store.readMetadata(options.resume);
  if (!result.ok) {
    throw new Error(`Unable to resume session '${options.resume}': ${result.error.message}`);
  }

  const selectionResolution = resolveSessionModelSelection(options.config, result.metadata);
  if (selectionResolution.status === "unresolved") {
    throw new SessionModelSelectionUnresolvedError(selectionResolution);
  }
  const appliedSelection = selectionResolution.status === "resolved"
    ? applyRuntimeModelSelection(options.config, selectionResolution.selection)
    : {
        status: "legacy" as const,
        config: configForLegacySessionResume(options.config, result.metadata),
        selection: null
      };
  if (appliedSelection.status === "unresolved") {
    throw new SessionModelSelectionUnresolvedError(appliedSelection);
  }
  const runtimeConfig: LabAgentConfig = "config" in appliedSelection && appliedSelection.config
    ? appliedSelection.config as LabAgentConfig
    : options.config;

  const transcriptMeta = isPlainObject(result.metadata.transcript) ? result.metadata.transcript : {};
  const restoredTranscriptMessages = restoreRecentTranscriptMessages(transcriptMeta.messages);
  const transcriptArchive = normalizeTranscriptArchiveState(transcriptMeta.archive);
  const modelContextArchive = normalizeTranscriptArchiveState(transcriptMeta.modelArchive);
  const persistedContextWindow = isPlainObject(transcriptMeta.contextWindow)
    ? transcriptMeta.contextWindow as ReturnType<typeof createContextWindow>
    : null;
  let restoredContext = await restoreResumeContextMessages({
    store,
    archive: transcriptArchive,
    modelArchive: modelContextArchive,
    metadataMessages: transcriptMeta.contextMessages ?? transcriptMeta.messages,
    context: runtimeConfig.context,
    allowArchive: options.preferFullContext === true || !hasPersistedCompaction(persistedContextWindow),
    preferArchive: options.preferFullContext === true
  });
  restoredContext = limitRestoredContextToPromptBudget(restoredContext, {
    config: runtimeConfig,
    model: appliedSelection.selection?.model ?? result.metadata.model ?? runtimeConfig.modelAlias,
    tools: options.tools,
    clearPersistedSummary: options.preferFullContext === true,
    contextWindow: persistedContextWindow
  });
  const restoredContextMessages = restoredContext.messages;
  const contextWindow = restoredContext.fromArchive && restoredContext.clearPersistedSummary === true
    ? clearPersistedContextSummary(persistedContextWindow)
    : persistedContextWindow;

  return {
    config: runtimeConfig,
    metadata: {
      id: result.metadata.id,
      startedAt: result.metadata.startedAt,
      turnCount: Number.isFinite(result.metadata.turnIndex) ? result.metadata.turnIndex : 0,
      metadataPath: result.path,
      status: result.metadata.status ?? "metadata",
      title: result.metadata.title ?? makeSessionTitle(result.metadata.prompt ?? ""),
      prompt: result.metadata.prompt ?? "",
      model: result.metadata.model ?? "",
      modelSelection: appliedSelection.selection ?? null,
      modelSelectionSource: selectionResolution.source ?? null,
      clientSurface: result.metadata.clientSurface ?? null,
      finishedAt: result.metadata.finishedAt,
      promptBytes: result.metadata.promptBytes,
      outputBytes: result.metadata.outputBytes,
      permissionMode: result.metadata.permissionMode ?? null,
      permissionReadonlyLocked: typeof result.metadata.permissionReadonlyLocked === "boolean" ? result.metadata.permissionReadonlyLocked : undefined,
      readonly: typeof result.metadata.readonly === "boolean" ? result.metadata.readonly : undefined,
      allowWrite: typeof result.metadata.allowWrite === "boolean" ? result.metadata.allowWrite : undefined,
      allowCommand: typeof result.metadata.allowCommand === "boolean" ? result.metadata.allowCommand : undefined,
      fullAccess: typeof result.metadata.fullAccess === "boolean" ? result.metadata.fullAccess : undefined,
      goal: result.metadata.goal ?? null,
      context: result.metadata.context,
      usage: result.metadata.usage,
      messages: restoredContextMessages,
      transcriptMessages: restoredTranscriptMessages,
      transcriptArchive,
      modelContextArchive,
      contextWindow,
      fullContextRestored: restoredContext.fromArchive,
      fullContextRestoreLimited: restoredContext.limited === true,
      fullContextRestoreLimitReason: restoredContext.limitReason ?? null
    }
  };
}

/**
 * Legacy metadata stores the model and effort as separate fields. A missing or
 * undefined effort inherits the current config, while an explicit null keeps
 * the session-level override cleared across process restarts.
 *
 * @param {Record<string, any>} config
 * @param {Record<string, any>} metadata
 */
