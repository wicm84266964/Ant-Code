export * from "./session-types.ts";
export * from "./session-print.ts";
export * from "./session-turn.ts";
export * from "./session-messages.ts";
export * from "./session-health.ts";
export * from "./session-tools.ts";
export * from "./session-persist.ts";
export * from "./session-error.ts";
export * from "./session-resume.ts";

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
import { applyModelContextBudget, contextTokensForConfig } from "../config/context-budget.ts";
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
  TurnChangeTracker
} from "./session-types.ts";

import {
  isPlainObject
} from "./session-health.ts";
import {
  resolveResumeMetadata
} from "./session-tools.ts";
import {
  resolvePermissionModeFromFlags,
  normalizePermissionModeValue,
  normalizeClientSurfaceValue,
  limitTranscriptMemory,
  normalizeTranscriptArchiveState
} from "./session-persist.ts";
import { createVisualEvidenceStore } from "./visual-evidence.ts";

export async function createSession(options: CreateSessionOptions): Promise<AgentSession> {
  let config = await loadConfig({ cwd: options.cwd, env: options.env });
  const clientSurface = normalizeClientSurfaceValue(options.clientSurface ?? (options.mode === "print" ? "print" : "tui"));
  let context = await buildInitialContext({ cwd: options.cwd, config, env: options.env, clientSurface });
  const workspaceDiagnostic = await diagnoseWorkspace(options.cwd);
  const resumeResult = options.resume
    ? await resolveResumeMetadata({
      cwd: options.cwd,
      config,
      tools: context.tools,
      env: options.env,
      resume: options.resume,
      preferFullContext: options.resumeFullContext === true
    })
    : null;
  const resumed = resumeResult?.metadata ?? null;
  if (resumeResult?.config && resumeResult.config !== config) {
    config = resumeResult.config;
    context = await buildInitialContext({ cwd: options.cwd, config, env: options.env, clientSurface });
  }
  applyModelContextBudget(config, config, contextTokensForConfig(config));
  const contextWindow = createContextWindow(config);
  const resumedWindow = isPlainObject(resumed?.contextWindow) ? resumed.contextWindow : null;
  if (resumedWindow) {
    contextWindow.summary = typeof resumedWindow.summary === "string" ? resumedWindow.summary : "";
    contextWindow.compactionCount = Number.isFinite(Number(resumedWindow.compactionCount)) ? Number(resumedWindow.compactionCount) : 0;
    contextWindow.compactedMessages = Number.isFinite(Number(resumedWindow.compactedMessages)) ? Number(resumedWindow.compactedMessages) : 0;
    contextWindow.lastCompactedAt = resumedWindow.lastCompactedAt ?? null;
    contextWindow.lastReason = resumedWindow.lastReason ?? null;
    contextWindow.lastStrategy = resumedWindow.lastStrategy ?? null;
    contextWindow.lastFallbackReason = resumedWindow.lastFallbackReason ?? null;
    contextWindow.lastInternalAgent = resumedWindow.lastInternalAgent ?? null;
  }
  const permissionMode = normalizePermissionModeValue(
    typeof resumed?.permissionMode === "string"
      ? resumed.permissionMode
      : resolvePermissionModeFromFlags({
    readonly: resumed?.readonly ?? options.readonly,
    allowWrite: resumed?.allowWrite ?? options.allowWrite,
    allowCommand: resumed?.allowCommand ?? options.allowCommand,
    fullAccess: resumed?.fullAccess ?? options.fullAccess
    })
  );
  const usage = normalizeProviderUsageAggregate(resumed?.usage);
  const fullAccess = permissionMode === "fullAccess";
  const permissionReadonlyLocked = permissionMode === "plan" && Boolean(resumed?.permissionReadonlyLocked ?? options.readonly);

  const resumedMessages = Array.isArray(resumed?.messages) ? resumed.messages : [];
  const resumedTranscriptMessages = limitTranscriptMemory(
    Array.isArray(resumed?.transcriptMessages) ? resumed.transcriptMessages : resumedMessages
  );
  const session = {
    id: String(resumed?.id ?? crypto.randomUUID()),
    cwd: options.cwd,
    startedAt: String(resumed?.startedAt ?? new Date().toISOString()),
    mode: options.mode,
    clientSurface,
    permissionMode,
    fullAccess,
    permissionReadonlyLocked,
    readonly: permissionReadonlyLocked,
    allowWrite: permissionMode === "workspace" || fullAccess,
    allowCommand: permissionMode === "workspace" || fullAccess,
    networkMode: config.networkMode,
    sensitivity: config.security?.sensitivity ?? "standard",
    model: config.modelAlias,
    modelSelection: currentRuntimeModelSelection(config, {
      model: config.modelAlias,
      reasoningEffort: config.reasoningEffort
    }),
    config,
    context,
    workspaceDiagnostic,
    contextWindow,
    workflow: createWorkflowState(),
    messages: resumedMessages.slice(),
    transcriptMessages: resumedTranscriptMessages.slice(),
    transcriptArchive: normalizeTranscriptArchiveState(resumed?.transcriptArchive),
    modelContextArchive: normalizeTranscriptArchiveState(resumed?.modelContextArchive),
    usage,
    lastProviderUsage: usage.last ?? null,
    title: resumed?.title ?? null,
    turnCount: resumed?.turnCount ?? 0,
    goal: normalizeSessionGoal(resumed?.goal),
    resumedFrom: resumed,
    visualEvidence: createVisualEvidenceStore()
  };
  await runHooks({
    config,
    cwd: options.cwd,
    env: options.env,
    hooksTrusted: options.hooksTrusted,
    event: "session.start",
    sessionId: session.id,
    payload: {
      sessionId: session.id,
      mode: session.mode,
      clientSurface: session.clientSurface,
      resumed: Boolean(resumed),
      model: session.model,
      networkMode: session.networkMode,
      sensitivity: session.sensitivity,
      messageCount: session.messages.length,
      turnCount: session.turnCount
    }
  });
  return session as unknown as AgentSession;
}

/**
 * @typedef {{ type: string; [key: string]: any }} SessionEvent
 *
 * @param {{ prompt: string; attachments?: Array<Record<string, any>>; cwd: string; env?: NodeJS.ProcessEnv; readonly?: boolean; allowWrite?: boolean; allowCommand?: boolean; fullAccess?: boolean; stream?: boolean; signal?: AbortSignal; approvalCallback?: Parameters<typeof createToolRuntime>[0]["approve"]; onEvent?: (event: SessionEvent) => void | Promise<void>; onAntEvent?: (event: Record<string, any>) => void | Promise<void> }} options
 */
