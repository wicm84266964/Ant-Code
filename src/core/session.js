import crypto from "node:crypto";
import { buildInitialContext } from "../context/builder.js";
import { loadConfig } from "../config/load-config.js";
import { formatGatewayError } from "../model-gateway/errors.js";
import { createLabModelGateway } from "../model-gateway/client.js";
import { listConfiguredModels } from "../model-gateway/models.js";
import { runHooks } from "../hooks/runner.js";
import { createMcpRuntime } from "../mcp/runtime.js";
import { appendThinkingPreview, limitThinkingPreview } from "../model-gateway/thinking-budget.js";
import { createSessionStore } from "../storage/session-store.js";
import { serializeToolResult } from "../tools/result.js";
import { countLineChanges } from "../tools/diff.js";
import { createToolRuntime } from "../tools/runtime.js";
import { createWorkflowState, formatWorkflowContext, summarizeWorkflow, syncWorkflowCompletionOnFinal } from "../tools/workflow-tools.js";
import { getAgentProfile } from "../agents/profiles.js";
import { resolveMaxParallelReadonlyAgentRuns } from "../agents/orchestration-config.js";
import { appendDelegationReminderToExecution, createDelegationGuard } from "../agents/delegation-guard.js";
import { createReviewGate } from "../agents/review-policy.js";
import { buildCompactedContextMessage, compactSessionContextWithModel, createContextWindow, estimatePromptPayload, summarizeContextWindow } from "./context-window.js";
import { createAntEventNormalizer } from "./events.js";
import { accumulateProviderUsage, normalizeProviderUsageAggregate, sanitizeProviderUsage } from "./provider-usage.js";
import { resolveMainToolRounds } from "./tool-rounds.js";
import { diagnoseWorkspace } from "./workspace-diagnostics.js";

const DEFAULT_PROMPT_COMPACT_RATIO = 1;
const OUTPUT_HEALTH_CHECK_ENABLED = false;
const OUTPUT_HEALTH_MAX_RETRIES = 1;
const OUTPUT_HEALTH_RETRY_REQUIRED_REASONS = new Set([
  "repetitive_thinking_loop",
  "reasoning_only_length"
]);
const TRANSCRIPT_MEMORY_MESSAGES = 50;
const DEFAULT_RESUME_CONTEXT_MESSAGES = 200;
const DEFAULT_RESUME_CONTEXT_TOKENS = 200_000;
const DEFAULT_RESUME_CONTEXT_BYTES = 1_000_000;

/**
 * @param {{ cwd: string; mode: "interactive" | "print"; clientSurface?: "tui" | "dashboard" | "chat" | "print" | string; env?: NodeJS.ProcessEnv; readonly?: boolean; allowWrite?: boolean; allowCommand?: boolean; fullAccess?: boolean; resume?: string | null; resumeFullContext?: boolean }} options
 */
export async function createSession(options) {
  const config = await loadConfig({ cwd: options.cwd, env: options.env });
  const clientSurface = normalizeClientSurfaceValue(options.clientSurface ?? (options.mode === "print" ? "print" : "tui"));
  const context = await buildInitialContext({ cwd: options.cwd, config, env: options.env, clientSurface });
  const workspaceDiagnostic = await diagnoseWorkspace(options.cwd);
  const resumed = options.resume
    ? await resolveResumeMetadata({
      cwd: options.cwd,
      config,
      tools: context.tools,
      env: options.env,
      resume: options.resume,
      preferFullContext: options.resumeFullContext === true
    })
    : null;
  const contextWindow = createContextWindow(config);
  if (resumed?.contextWindow) {
    contextWindow.summary = typeof resumed.contextWindow.summary === "string" ? resumed.contextWindow.summary : "";
    contextWindow.compactionCount = Number.isFinite(resumed.contextWindow.compactionCount) ? resumed.contextWindow.compactionCount : 0;
    contextWindow.compactedMessages = Number.isFinite(resumed.contextWindow.compactedMessages) ? resumed.contextWindow.compactedMessages : 0;
    contextWindow.lastCompactedAt = resumed.contextWindow.lastCompactedAt ?? null;
    contextWindow.lastReason = resumed.contextWindow.lastReason ?? null;
    contextWindow.lastStrategy = resumed.contextWindow.lastStrategy ?? null;
    contextWindow.lastFallbackReason = resumed.contextWindow.lastFallbackReason ?? null;
    contextWindow.lastInternalAgent = resumed.contextWindow.lastInternalAgent ?? null;
  }
  const permissionMode = normalizePermissionModeValue(resumed?.permissionMode ?? resolvePermissionModeFromFlags({
    readonly: resumed?.readonly ?? options.readonly,
    allowWrite: resumed?.allowWrite ?? options.allowWrite,
    allowCommand: resumed?.allowCommand ?? options.allowCommand,
    fullAccess: resumed?.fullAccess ?? options.fullAccess
  }));
  const usage = normalizeProviderUsageAggregate(resumed?.usage);
  const fullAccess = permissionMode === "fullAccess";
  const permissionReadonlyLocked = permissionMode === "plan" && Boolean(resumed?.permissionReadonlyLocked ?? options.readonly);

  const resumedMessages = Array.isArray(resumed?.messages) ? resumed.messages : [];
  const resumedTranscriptMessages = limitTranscriptMemory(
    Array.isArray(resumed?.transcriptMessages) ? resumed.transcriptMessages : resumedMessages
  );
  const session = {
    id: resumed?.id ?? crypto.randomUUID(),
    cwd: options.cwd,
    startedAt: resumed?.startedAt ?? new Date().toISOString(),
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
    resumedFrom: resumed
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
  return session;
}

/**
 * @typedef {{ type: string; [key: string]: any }} SessionEvent
 *
 * @param {{ prompt: string; attachments?: Array<Record<string, any>>; cwd: string; env?: NodeJS.ProcessEnv; readonly?: boolean; allowWrite?: boolean; allowCommand?: boolean; fullAccess?: boolean; stream?: boolean; signal?: AbortSignal; approvalCallback?: Parameters<typeof createToolRuntime>[0]["approve"]; onEvent?: (event: SessionEvent) => void | Promise<void>; onAntEvent?: (event: Record<string, any>) => void | Promise<void> }} options
 */
export async function runPrintTurn(options) {
  const session = await createSession({
    cwd: options.cwd,
    mode: "print",
    clientSurface: "print",
    env: options.env,
    readonly: options.readonly,
    allowWrite: options.allowWrite,
    allowCommand: options.allowCommand,
    fullAccess: options.fullAccess
  });
  return runSessionTurn(session, {
    prompt: options.prompt,
    attachments: options.attachments,
    env: options.env,
    stream: options.stream,
    signal: options.signal,
    approvalCallback: options.approvalCallback,
    onEvent: options.onEvent,
    onAntEvent: options.onAntEvent
  });
}

/**
 * @param {Awaited<ReturnType<typeof createSession>>} session
 * @param {{ prompt: string; displayPrompt?: string; attachments?: Array<Record<string, any>>; env?: NodeJS.ProcessEnv; stream?: boolean; signal?: AbortSignal; approvalCallback?: Parameters<typeof createToolRuntime>[0]["approve"]; userInputCallback?: Parameters<typeof createToolRuntime>[0]["askUser"]; onEvent?: (event: SessionEvent) => void | Promise<void>; onAntEvent?: (event: Record<string, any>) => void | Promise<void> }} options
 */
export async function runSessionTurn(session, options) {
  const displayPrompt = typeof options.displayPrompt === "string" ? options.displayPrompt : options.prompt;
  const attachments = normalizeInputAttachments(options.attachments);
  const thinkingCapture = createThinkingCapture();
  const interruptedDraft = createInterruptedDraftCapture();
  const eventOptions = withAntEventOptions(session, {
    ...options,
    onEvent: async (event) => {
      captureThinkingEvent(thinkingCapture, event);
      captureInterruptedDraftEvent(interruptedDraft, event);
      if (options.onEvent) {
        await options.onEvent(event);
      }
    }
  });

  await emitEvent(eventOptions, {
    type: "turn_start",
    sessionId: session.id,
    turnIndex: session.turnCount + 1,
    promptBytes: Buffer.byteLength(options.prompt, "utf8"),
    attachmentCount: attachments.length,
    attachments: attachmentMetadataList(attachments)
  });
  await runHooks({
    config: session.config,
    cwd: session.cwd,
    env: options.env,
    hooksTrusted: options.hooksTrusted,
    event: "user.prompt",
    sessionId: session.id,
    payload: {
      sessionId: session.id,
      turnIndex: session.turnCount + 1,
      promptBytes: Buffer.byteLength(options.prompt, "utf8"),
      promptPreview: displayPrompt,
      attachmentCount: attachments.length,
      attachments: attachmentMetadataList(attachments)
    }
  });

  const gateway = createLabModelGateway(session.config);
  const mcpRuntime = createMcpRuntime({
    cwd: session.cwd,
    config: session.config,
    policy: {
      networkMode: session.config.networkMode,
      allowedHosts: session.config.allowedHosts,
      readonly: session.readonly,
      fullAccess: session.fullAccess,
      approvals: {
        workspaceWrites: session.allowWrite,
        workspaceCommands: session.allowCommand
      }
    },
    approve: options.approvalCallback
  });
  const toolRuntime = createToolRuntime({
    cwd: session.cwd,
    config: session.config,
    env: options.env,
    signal: options.signal,
    mcpRuntime,
    workflowState: session.workflow,
    approve: options.approvalCallback,
    askUser: options.userInputCallback,
    parentSessionId: session.id,
    backgroundParentSessionId: session.id,
    hooksTrusted: options.hooksTrusted,
    onBackgroundAgentEvent: (event) => emitEvent(eventOptions, event),
    onBackgroundTerminalEvent: (event) => emitEvent(eventOptions, event),
    policy: {
      networkMode: session.config.networkMode,
      allowedHosts: session.config.allowedHosts,
      readonly: session.readonly,
      fullAccess: session.fullAccess,
      approvals: {
        workspaceWrites: session.allowWrite,
        workspaceCommands: session.allowCommand
      }
    }
  });
  const delegationGuard = createDelegationGuard({
    config: session.config,
    cwd: session.cwd,
    sessionId: session.id,
    prompt: options.prompt
  });
  const reviewGate = createReviewGate({
    config: session.config,
    prompt: options.prompt
  });
  session.turnCount += 1;
  const metadata = createTurnMetadata(session, displayPrompt);
  const sessionStore = createSessionStore({
    cwd: session.cwd,
    transcript: session.config.transcript,
    env: options.env ?? process.env
  });
  sessionStore.assertReady();
  let finalOutput = "";
  let outputHealthRetries = 0;

  try {
  if (options.signal?.aborted) {
      return finishInterruptedTurn({
        session,
        sessionStore,
        metadata,
        eventOptions,
        prompt: options.prompt,
        displayPrompt,
        env: options.env,
        hooksTrusted: options.hooksTrusted,
        draft: interruptedDraft,
        reason: "preflight"
      });
  }

  if (!gateway.configured) {
    finalOutput = [
      "Print mode is scaffolded.",
      "Set LAB_MODEL_GATEWAY_URL to enable model turns through the configured gateway.",
      `Received prompt bytes: ${Buffer.byteLength(options.prompt, "utf8")}`
    ].join("\n");
    await emitEvent(eventOptions, {
      type: "gateway_not_configured",
      outputBytes: Buffer.byteLength(finalOutput, "utf8")
    });
    await persistSessionMetadata(sessionStore, metadata, finalOutput, "gateway_not_configured", session, options);
    await emitEvent(eventOptions, {
      type: "turn_complete",
      status: "gateway_not_configured",
      outputBytes: Buffer.byteLength(finalOutput, "utf8")
    });
    return {
      session,
      output: finalOutput
    };
  }

  const visionPreparation = await prepareVisionAttachmentsForTurn({
    session,
    prompt: options.prompt,
    attachments,
    gateway,
    signal: options.signal,
    eventOptions,
    metadata
  });
  if (!visionPreparation.ok) {
    finalOutput = visionPreparation.output;
    await persistSessionMetadata(sessionStore, metadata, finalOutput, visionPreparation.status, session, options);
    await emitEvent(eventOptions, {
      type: "turn_complete",
      status: visionPreparation.status,
      outputBytes: Buffer.byteLength(finalOutput, "utf8")
    });
    return { session, output: finalOutput };
  }

  const userMessage = buildUserTurnMessage(options.prompt, session.workflow, visionPreparation.attachments, visionPreparation.analysisText);
  let messages = buildTurnMessages(session, userMessage);
  let toolResults = [];
  const turnMessages = [persistableUserTurnMessage(options.prompt, attachments)];
  const transcriptTurnMessages = [persistableUserTurnMessage(displayPrompt, attachments)];
  const maxToolRounds = resolveMainToolRounds(session.config);
  const turnChangeTracker = createTurnChangeTracker();

  for (let round = 0; ; round += 1) {
    if (options.signal?.aborted) {
      return finishInterruptedTurn({
        session,
        sessionStore,
        metadata,
        eventOptions,
        prompt: options.prompt,
        displayPrompt,
        env: options.env,
        hooksTrusted: options.hooksTrusted,
        draft: interruptedDraft,
        reason: "before_gateway_request"
      });
    }
    const budgetPreparation = await preparePromptBudgetForGateway({
      session,
      prompt: options.prompt,
      messages,
      toolResults,
      round,
      gateway,
      signal: options.signal,
      env: options.env,
      hooksTrusted: options.hooksTrusted,
      eventOptions
    });
    messages = budgetPreparation.messages;

    const promptEstimate = estimatePromptPayload({
      model: session.model,
      messages,
      tools: session.context.tools,
      toolResults,
      gatewayProtocol: sessionGatewayProtocol(session)
    });
    session.lastPromptEstimate = {
      ...promptEstimate,
      round: round + 1,
      source: "local-estimate"
    };
    recordGatewayRoundRequest(metadata, {
      round: round + 1,
      messageCount: messages.length,
      toolResultCount: toolResults.length,
      toolSchemaCount: session.context.tools.length,
      promptEstimate
    });
    await emitEvent(eventOptions, {
      type: "gateway_request_start",
      round: round + 1,
      messageCount: messages.length,
      toolResultCount: toolResults.length,
      toolSchemaCount: session.context.tools.length,
      promptBytesEstimate: promptEstimate.bytes,
      promptTokensEstimate: promptEstimate.tokens,
      promptMessageTokensEstimate: promptEstimate.messageTokens,
      promptToolSchemaTokensEstimate: promptEstimate.toolSchemaTokens,
      promptToolResultTokensEstimate: promptEstimate.toolResultTokens
    });
    const response = await gateway.sendChat({
      messages,
      tools: session.context.tools,
      toolResults,
      sessionId: session.id,
      stream: session.mode === "interactive" || options.stream === true,
      signal: options.signal,
      onEvent: (event) => emitGatewayStreamEvent(eventOptions, event, round + 1)
    });

    if (options.signal?.aborted) {
      return finishInterruptedTurn({
        session,
        sessionStore,
        metadata,
        eventOptions,
        prompt: options.prompt,
        displayPrompt,
        env: options.env,
        hooksTrusted: options.hooksTrusted,
        draft: interruptedDraft,
        reason: "gateway_aborted"
      });
    }

    if (!response.ok) {
      metadata.gatewayErrors.push(response.error?.code ?? "GATEWAY_ERROR");
      recordGatewayRoundError(metadata, {
        round: round + 1,
        error: response.error
      });
      finalOutput = formatGatewayError(response.error ?? {
        code: "GATEWAY_ERROR",
        message: "request failed"
      });
      const failedDraft = appendFailedGatewayDraft({
        session,
        metadata,
        prompt: options.prompt,
        displayPrompt,
        draft: interruptedDraft,
        reason: `gateway_error:${response.error?.code ?? "GATEWAY_ERROR"}`
      });
      if (failedDraft) {
        await emitEvent(eventOptions, {
          type: "assistant_interrupted_draft",
          reason: failedDraft.reason,
          text: failedDraft.text,
          outputBytes: failedDraft.bytes,
          thinking: failedDraft.thinking,
          thinkingBytes: failedDraft.thinkingBytes
        });
      }
      await emitEvent(eventOptions, {
        type: "gateway_error",
        error: response.error,
        draftText: failedDraft?.text ?? "",
        draftBytes: failedDraft?.bytes ?? 0,
        draftThinkingBytes: failedDraft?.thinkingBytes ?? 0,
        outputBytes: Buffer.byteLength(finalOutput, "utf8")
      });
      await persistSessionMetadata(sessionStore, metadata, finalOutput, "gateway_error", session, options);
      await emitEvent(eventOptions, {
        type: "turn_complete",
        status: "gateway_error",
        outputBytes: Buffer.byteLength(finalOutput, "utf8")
      });
      return { session, output: finalOutput };
    }

    const providerUsage = recordSessionProviderUsage(session, response.data.usage, {
      round: round + 1,
      model: response.data.model ?? session.model
    });

    await emitEvent(eventOptions, {
      type: "gateway_response",
      round: round + 1,
      messageId: response.data.id,
      model: response.data.model,
      textBytes: Buffer.byteLength(response.data.text ?? "", "utf8"),
      thinkingBytes: gatewayThinkingBytes(response.data),
      toolCallCount: response.data.toolCalls.length,
      usage: response.data.usage ?? null,
      usageTotals: providerUsage ?? session.usage ?? null,
      stopReason: response.data.stopReason
    });
    recordGatewayRoundResponse(metadata, {
      round: round + 1,
      response: response.data
    });

    if (options.signal?.aborted) {
      return finishInterruptedTurn({
        session,
        sessionStore,
        metadata,
        eventOptions,
        prompt: options.prompt,
        displayPrompt,
        env: options.env,
        hooksTrusted: options.hooksTrusted,
        draft: interruptedDraft,
        reason: "after_gateway_response"
      });
    }

    if (response.data.toolCalls.length === 0) {
      const reviewReminder = reviewGate.beforeFinal();
      if (reviewReminder) {
        const reminderMessage = {
          role: "user",
          content: reviewReminder.text
        };
        messages.push(reminderMessage);
        turnMessages.push(reminderMessage);
        await emitEvent(eventOptions, {
          type: "review_gate",
          level: reviewReminder.level,
          reasons: reviewReminder.reasons,
          text: reviewReminder.text
        });
        await runHooks({
          config: session.config,
          cwd: session.cwd,
          env: options.env,
          hooksTrusted: options.hooksTrusted,
          event: "review.gate",
          sessionId: session.id,
          payload: {
            level: reviewReminder.level,
            reasons: reviewReminder.reasons
          }
        });
        continue;
      }
      metadata.rounds = round + 1;
      finalOutput = formatAssistantOutput(response.data);
      const thinking = thinkingForRound(thinkingCapture, round + 1, response.data);
      const outputHealth = analyzeAssistantOutputHealth(response.data, finalOutput, thinking);
      if (OUTPUT_HEALTH_CHECK_ENABLED || outputHealth.mustRetry) {
        recordOutputHealth(metadata, {
          round: round + 1,
          ...outputHealth,
          retry: outputHealth.ok ? false : shouldRetryOutputHealth(outputHealth, outputHealthRetries)
        });
        if (!outputHealth.ok && shouldRetryOutputHealth(outputHealth, outputHealthRetries)) {
          outputHealthRetries += 1;
          const retryAssistantMessage = {
            role: "assistant",
            content: response.data.content.length > 0
              ? response.data.content
              : [{ type: "text", text: finalOutput }]
          };
          const retryPromptMessage = {
            role: "user",
            content: buildOutputHealthRepairPrompt(outputHealth, finalOutput)
          };
          messages.push(retryAssistantMessage);
          messages.push(retryPromptMessage);
          turnMessages.push(retryAssistantMessage, retryPromptMessage);
          await emitEvent(eventOptions, {
            type: "output_health_retry",
            round: round + 1,
            reasons: outputHealth.reasons,
            stopReason: response.data.stopReason ?? null,
            textBytes: Buffer.byteLength(finalOutput, "utf8"),
            thinkingBytes: thinking?.bytes ?? gatewayThinkingBytes(response.data),
            retry: outputHealthRetries
          });
          continue;
        }
      }
      const workflowSync = syncWorkflowCompletionOnFinal(session.workflow, finalOutput);
      if (workflowSync.changed) {
        await emitEvent(eventOptions, {
          type: "workflow_updated",
          reason: "assistant_final_sync",
          todosCompleted: workflowSync.todosCompleted,
          planStepsCompleted: workflowSync.planStepsCompleted
        });
      }
      const compaction = await appendSessionMessages(session, response.data, finalOutput, {
        gateway,
        signal: options.signal,
        env: options.env,
        hooksTrusted: options.hooksTrusted,
        eventOptions,
        thinking,
        turnMessages,
        transcriptMessages: transcriptTurnMessages
      });
      await emitEvent(eventOptions, {
        type: "assistant_final",
        text: finalOutput,
        outputBytes: Buffer.byteLength(finalOutput, "utf8")
      });
      if (compaction.compacted) {
        await emitEvent(eventOptions, {
          type: "context_compacted",
          beforeMessages: compaction.beforeMessages,
          afterMessages: compaction.afterMessages,
          beforeTokens: compaction.beforeTokens,
          afterTokens: compaction.afterTokens,
          summaryBytes: compaction.summaryBytes,
          strategy: compaction.strategy,
          internalAgent: compaction.internalAgent ?? null,
          fallbackReason: compaction.fallbackReason ?? null,
          reason: compaction.reason ?? "automatic"
        });
      }
      await persistSessionMetadata(sessionStore, metadata, finalOutput, "completed", session, options);
      await emitEvent(eventOptions, {
        type: "turn_complete",
        status: "completed",
        outputBytes: Buffer.byteLength(finalOutput, "utf8")
      });
      return { session, output: finalOutput };
    }

    if (mainToolRoundLimitReached(maxToolRounds, round)) {
      finalOutput = toolRoundLimitMessage(maxToolRounds, response.data.toolCalls);
      await emitEvent(eventOptions, {
        type: "tool_limit",
        toolCallCount: response.data.toolCalls.length,
        maxToolRounds,
        outputBytes: Buffer.byteLength(finalOutput, "utf8")
      });
      await persistSessionMetadata(sessionStore, metadata, finalOutput, "tool_limit", session, options);
      await emitEvent(eventOptions, {
        type: "turn_complete",
        status: "tool_limit",
        outputBytes: Buffer.byteLength(finalOutput, "utf8")
      });
      return {
        session,
        output: finalOutput
      };
    }

    const assistantToolMessage = {
      role: "assistant",
      content: response.data.content,
      toolCalls: response.data.toolCalls,
      thinking: thinkingForRound(thinkingCapture, round + 1, response.data)
    };
    messages.push(assistantToolMessage);
    turnMessages.push(assistantToolMessage);

    await emitEvent(eventOptions, {
      type: "tool_calls_requested",
      round: round + 1,
      toolCalls: summarizeToolCallRequests(response.data.toolCalls)
    });

    toolResults = await executeToolCalls(response.data.toolCalls, toolRuntime, {
      ...eventOptions,
      delegationGuard,
      reviewGate,
      turnChangeTracker
    });
    metadata.toolCalls.push(...summarizeToolCalls(response.data.toolCalls, toolResults));
    if (options.signal?.aborted || toolResults.some((result) => result.interrupted)) {
      return finishInterruptedTurn({
        session,
        sessionStore,
        metadata,
        eventOptions,
        prompt: options.prompt,
        displayPrompt,
        env: options.env,
        hooksTrusted: options.hooksTrusted,
        draft: interruptedDraft,
        reason: options.signal?.aborted ? "after_tool_execution" : "tool_interrupted"
      });
    }
    for (const result of toolResults) {
      const toolMessage = {
        role: "tool",
        toolCallId: result.toolCallId,
        name: result.name,
        content: [{ type: "text", text: result.content }]
      };
      messages.push(toolMessage);
      turnMessages.push(toolMessage);
      transcriptTurnMessages.push(toolMessage);
    }
  }

  finalOutput = "Tool call loop ended unexpectedly.";
  await emitEvent(eventOptions, {
    type: "turn_unexpected_end",
    outputBytes: Buffer.byteLength(finalOutput, "utf8")
  });
  await persistSessionMetadata(sessionStore, metadata, finalOutput, "unexpected_loop_end", session, options);
  await emitEvent(eventOptions, {
    type: "turn_complete",
    status: "unexpected_loop_end",
    outputBytes: Buffer.byteLength(finalOutput, "utf8")
  });
  return { session, output: finalOutput };
  } finally {
    mcpRuntime.close();
  }
}

/**
 * @param {Awaited<ReturnType<typeof createSession>>} session
 * @param {string} prompt
 */
function buildTurnMessages(session, userMessage) {
  const systemMessages = buildSystemMessages(session);
  const compactedContext = buildCompactedContextMessage(session);
  const retainedMessages = messagesForModelContext(session.messages);
  return [
    ...systemMessages,
    ...(compactedContext ? [compactedContext] : []),
    ...retainedMessages,
    normalizeUserTurnMessage(userMessage)
  ];
}

async function prepareVisionAttachmentsForTurn(options) {
  const attachments = normalizeInputAttachments(options.attachments);
  if (attachments.length === 0) {
    return { ok: true, attachments, analysisText: "" };
  }
  if (modelSupportsImages(options.session.config, options.session.model)) {
    return { ok: true, attachments, analysisText: "" };
  }

  const visionModel = resolveVisionAgentModel(options.session.config);
  if (!visionModel) {
    const output = [
      "当前主模型不支持图片输入，且当前网关配置里没有可用的视觉模型。",
      "请切换到带“视觉”标签的模型，或在同一个网关/Key 下配置一个视觉子智能体模型后重试。",
      "当前架构只允许一个网关/Key 生效，因此不会跨网关调用其他厂商模型做图片分析。"
    ].join("\n");
    await emitEvent(options.eventOptions, {
      type: "vision_unavailable",
      model: options.session.model,
      attachmentCount: attachments.length,
      outputBytes: Buffer.byteLength(output, "utf8")
    });
    if (options.metadata) {
      options.metadata.gatewayErrors.push("VISION_MODEL_NOT_CONFIGURED");
    }
    return { ok: false, status: "vision_unavailable", output };
  }

  await emitEvent(options.eventOptions, {
    type: "vision_analysis_start",
    model: visionModel.id,
    mainModel: options.session.model,
    attachmentCount: attachments.length
  });

  const visionGateway = createLabModelGateway({
    ...options.session.config,
    modelAlias: visionModel.id
  });
  const response = await visionGateway.sendChat({
    messages: [buildVisionAnalysisMessage(options.prompt, attachments)],
    tools: [],
    toolResults: [],
    sessionId: `${options.session.id}:vision`,
    stream: false,
    signal: options.signal
  });

  if (!response.ok) {
    const output = formatGatewayError(response.error ?? {
      code: "VISION_ANALYSIS_FAILED",
      message: "vision model request failed"
    });
    await emitEvent(options.eventOptions, {
      type: "vision_analysis_error",
      model: visionModel.id,
      error: response.error,
      outputBytes: Buffer.byteLength(output, "utf8")
    });
    if (options.metadata) {
      options.metadata.gatewayErrors.push(response.error?.code ?? "VISION_ANALYSIS_FAILED");
    }
    return { ok: false, status: "vision_error", output };
  }

  const analysisText = formatAssistantOutput(response.data).trim();
  await emitEvent(options.eventOptions, {
    type: "vision_analysis_complete",
    model: response.data.model ?? visionModel.id,
    outputBytes: Buffer.byteLength(analysisText, "utf8")
  });
  return {
    ok: true,
    attachments: [],
    analysisText: formatVisionAnalysisContext(visionModel.id, attachments, analysisText)
  };
}

function buildVisionAnalysisMessage(prompt, attachments = []) {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: [
          "你是 Ant Code visual-verifier 视觉复核子智能体。当前主模型不支持图片输入，请你先处理用户上传的图片，输出可供另一个文本模型继续工作的中文视觉证据报告。",
          "职责：把截图/图片当作证据，识别任务类型（UI/前端截图、代码或错误截图、表格/图表、文档、前后对比等），提取可见事实、OCR 文字、界面元素、布局状态、异常现象和不确定点。",
          "前端/UI 任务需重点复核：布局完整性、响应式视口、重叠/遮挡/裁切、对齐/间距、可读性/对比度、加载/错误/空状态、交互线索与用户验收目标是否一致。",
          "输出结构：target、visualEvidence、findings、result、residualRisks、recommendedFollowup。发现问题时 findings 优先；没有问题时明确 pass/uncertain。",
          "只陈述看得见或能从视觉证据直接推断的信息；不要编造未显示的 DOM、业务逻辑或屏幕外内容。",
          String(prompt ?? "").trim() ? `用户原始需求：${String(prompt ?? "").trim()}` : ""
        ].filter(Boolean).join("\n")
      },
      ...attachments.map((attachment) => ({
        type: "image",
        data: attachment.data,
        mimeType: attachment.mimeType,
        name: attachment.name,
        size: attachment.size
      }))
    ]
  };
}

function formatVisionAnalysisContext(modelId, attachments = [], analysisText = "") {
  const names = attachments.map((attachment) => attachment.name).filter(Boolean).join(", ");
  return [
    "图片已由同一网关下的 visual-verifier 视觉子智能体预分析，当前主模型收到的是视觉证据报告。",
    `视觉模型：${modelId}`,
    names ? `图片：${names}` : "",
    "视觉证据报告：",
    analysisText || "视觉模型未返回可用视觉证据报告。"
  ].filter(Boolean).join("\n");
}

function resolveVisionAgentModel(config) {
  const vision = config.agents?.vision ?? {};
  if (vision.enabled === false || vision.autoUseWhenMainModelTextOnly === false) {
    return null;
  }
  const models = listConfiguredModels(config);
  const configured = String(vision.model ?? "").trim();
  if (configured) {
    const model = models.find((item) => item.id === configured || item.label?.toLowerCase() === configured.toLowerCase());
    return model && modelSupportsImages(config, model.id) ? model : null;
  }
  return models.find((model) => modelSupportsImages(config, model.id)) ?? null;
}

function modelSupportsImages(config, modelId) {
  const id = String(modelId ?? "").trim();
  if (!id) {
    return false;
  }
  const model = listConfiguredModels(config).find((item) => item.id === id);
  return Array.isArray(model?.modalities) && model.modalities.includes("image");
}

function buildUserTurnMessage(prompt, workflow, attachments = [], visionAnalysisText = "") {
  const workflowContext = formatWorkflowContext(workflow);
  const imageBlocks = normalizeInputAttachments(attachments).map((attachment) => ({
    type: "image",
    data: attachment.data,
    mimeType: attachment.mimeType,
    name: attachment.name,
    size: attachment.size
  }));
  if (!workflowContext && imageBlocks.length === 0 && !visionAnalysisText) {
    return { role: "user", content: prompt };
  }
  const content = [
    ...(workflowContext ? [{ type: "text", text: workflowContext }] : []),
    ...(visionAnalysisText ? [{ type: "text", text: visionAnalysisText }] : []),
    ...(String(prompt ?? "").trim() ? [{ type: "text", text: String(prompt ?? "") }] : []),
    ...imageBlocks
  ];
  return { role: "user", content };
}

function normalizeUserTurnMessage(message) {
  if (message && typeof message === "object" && message.role === "user") {
    return message;
  }
  return { role: "user", content: String(message ?? "") };
}

function persistableUserTurnMessage(prompt, attachments = []) {
  const normalized = normalizeInputAttachments(attachments);
  if (normalized.length === 0) {
    return { role: "user", content: prompt };
  }
  return {
    role: "user",
    content: [
      ...(String(prompt ?? "").trim() ? [{ type: "text", text: String(prompt ?? "") }] : []),
      ...normalized.map(imageAttachmentSummaryBlock)
    ]
  };
}

function normalizeInputAttachments(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map(normalizeInputAttachment)
    .filter(Boolean)
    .slice(0, 6);
}

function normalizeInputAttachment(item) {
  if (!item || typeof item !== "object" || item.type !== "image") {
    return null;
  }
  const data = String(item.data ?? "").replace(/\s+/g, "");
  const mimeType = String(item.mimeType ?? item.mime_type ?? "").trim().toLowerCase();
  if (!data || !/^image\/[a-z0-9.+-]+$/i.test(mimeType)) {
    return null;
  }
  return {
    type: "image",
    data,
    mimeType,
    name: String(item.name ?? "image").trim().slice(0, 160),
    size: nonNegativeInteger(item.size ?? item.bytes ?? item.sizeBytes, 0)
  };
}

function imageAttachmentSummaryBlock(attachment) {
  return {
    type: "image",
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.size,
    redacted: true
  };
}

function attachmentMetadataList(attachments = []) {
  return normalizeInputAttachments(attachments).map((attachment) => ({
    type: "image",
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.size
  }));
}

function messagesForModelContext(messages = []) {
  if (!Array.isArray(messages)) {
    return [];
  }
  return repairDanglingToolCallMessages(messages).map((message) => {
    if (!message || typeof message !== "object") {
      return message;
    }
    const { interruptedDraft, ...rest } = message;
    return rest;
  });
}

/**
 * @param {Awaited<ReturnType<typeof createSession>>} session
 */
function buildSystemMessages(session) {
  const text = Array.isArray(session.context?.system)
    ? session.context.system.filter((line) => typeof line === "string").join("\n")
    : "";
  return text.trim()
    ? [{ role: "system", content: [{ type: "text", text }] }]
    : [];
}

/**
 * @param {import("../model-gateway/protocol.js").NormalizedGatewayResponse} data
 */
function formatAssistantOutput(data) {
  if (data.text.trim().length > 0) {
    return data.text;
  }

  if (data.toolCalls.length > 0) {
    const names = data.toolCalls.map((call) => call.name).filter(Boolean);
    return [
      "模型本轮只返回了工具调用，没有返回正文。",
      names.length > 0 ? `工具：${names.join(", ")}` : ""
    ].filter(Boolean).join("\n");
  }

  const thinkingBytes = Number(data.raw?.thinkingBytes ?? 0);
  if (thinkingBytes > 0) {
    return [
      "模型本轮没有返回可展示正文。",
      `已收到 ${thinkingBytes} 字节 reasoning/thinking 流，按隐私策略未展示。`,
      "如这是网关把正文误放入 reasoning_content，请切换非 thinking 模型或修正网关映射。"
    ].join("\n");
  }

  return "模型本轮没有返回可展示正文。";
}

function analyzeAssistantOutputHealth(data, finalOutput, thinking) {
  const reasons = [];
  const text = String(finalOutput ?? "").trim();
  const stopReason = String(data?.stopReason ?? "").toLowerCase();
  const thinkingText = String(thinking?.text ?? "");
  const thinkingBytes = Number.isFinite(thinking?.bytes) ? thinking.bytes : gatewayThinkingBytes(data);

  if (["length", "max_tokens", "token_limit", "context_length_exceeded"].includes(stopReason)) {
    reasons.push(`stop_reason:${stopReason}`);
  }
  if (text.length > 0 && data?.toolCalls?.length === 0 && thinkingBytes >= 1024 && dataTextBytes(data) === 0 && ["length", "max_tokens", "token_limit"].includes(stopReason)) {
    reasons.push("reasoning_only_length");
  }
  if (data?.toolCalls?.length === 0 && dataTextBytes(data) === 0 && thinkingBytes >= 4096 && looksLikeRepetitiveThinkingLoop(thinkingText)) {
    reasons.push("repetitive_thinking_loop");
  }
  if (text.length > 0 && text.length <= 8 && thinkingBytes >= 64) {
    reasons.push("too_short_visible_text_after_reasoning");
  }
  if (looksLikeInternalDraft(text)) {
    reasons.push("internal_draft_visible");
  }
  if (looksLikeThinkingLeak(text, thinkingText)) {
    reasons.push("thinking_leak_visible");
  }
  if (looksLikeTruncatedSentence(text)) {
    reasons.push("truncated_visible_text");
  }

  return {
    ok: reasons.length === 0,
    reasons,
    mustRetry: reasons.some((reason) => OUTPUT_HEALTH_RETRY_REQUIRED_REASONS.has(reason))
  };
}

function shouldRetryOutputHealth(health, retries) {
  if (!health || health.ok) {
    return false;
  }
  if (health.mustRetry) {
    return retries < OUTPUT_HEALTH_MAX_RETRIES;
  }
  return OUTPUT_HEALTH_CHECK_ENABLED && retries < OUTPUT_HEALTH_MAX_RETRIES;
}

function buildOutputHealthRepairPrompt(health, finalOutput) {
  const excerpt = truncateForRepairPrompt(finalOutput, 1200);
  const reasoningOnlyLength = Array.isArray(health.reasons) && health.reasons.includes("reasoning_only_length");
  const repetitiveThinking = Array.isArray(health.reasons) && health.reasons.includes("repetitive_thinking_loop");
  return [
    "Ant Code local output health check caught a likely malformed final response.",
    `Reasons: ${(health.reasons ?? []).join(", ") || "unknown"}.`,
    reasoningOnlyLength
      ? "The previous model call exhausted its completion budget in reasoning/thinking without producing visible user-facing text."
      : "",
    repetitiveThinking
      ? "The previous model call repeated internal planning text in a thinking loop. Break the loop and answer directly."
      : "",
    "",
    "Rewrite the final answer for the user now.",
    "Requirements:",
    "- Return only user-facing answer text.",
    "- Produce the answer immediately and keep it concise enough to finish.",
    "- Do not expose internal planning, hidden reasoning, scratch notes, or JSON/debug dumps.",
    "- If the prior answer was cut off, continue from the available task context and produce a complete answer.",
    "- Prefer the user's language unless the user explicitly requested otherwise.",
    "- Do not call tools unless a factual answer is impossible without one.",
    "",
    "Malformed visible response excerpt:",
    excerpt || "[empty]"
  ].join("\n");
}

function gatewayThinkingBytes(data = {}) {
  const raw = data?.raw && typeof data.raw === "object" ? data.raw : {};
  const reported = Number(raw.thinkingBytes ?? raw.labAgentReasoningContentBytes ?? 0);
  if (Number.isFinite(reported) && reported > 0) {
    return reported;
  }
  const text = extractThinkingFromGatewayRaw(raw);
  return Buffer.byteLength(String(text ?? ""), "utf8");
}

function dataTextBytes(data = {}) {
  const raw = data?.raw && typeof data.raw === "object" ? data.raw : {};
  const reported = Number(raw.textBytes ?? 0);
  if (Number.isFinite(reported) && reported >= 0) {
    return reported;
  }
  return Buffer.byteLength(String(data?.text ?? ""), "utf8");
}

function looksLikeInternalDraft(text) {
  if (!text) {
    return false;
  }
  return /^(now i need to|i need to|let me|the user wants|we need to|i should|i'll now|next i need to|my plan is)\b/i.test(text)
    || /\b(let me (?:check|inspect|read|fix|synthesize)|now i need to|the user asked me to)\b/i.test(text.slice(0, 600));
}

function looksLikeThinkingLeak(text, thinkingText) {
  if (!text || !thinkingText) {
    return false;
  }
  const visible = normalizeForHealthCompare(text).slice(0, 800);
  const hidden = normalizeForHealthCompare(thinkingText).slice(0, 800);
  if (visible.length < 80 || hidden.length < 80) {
    return false;
  }
  return hidden.startsWith(visible.slice(0, 120)) || visible.startsWith(hidden.slice(0, 120));
}

function looksLikeTruncatedSentence(text) {
  if (text.length < 80) {
    return false;
  }
  const lastLine = text.trim().split(/\r?\n/).pop()?.trim() ?? "";
  if (!lastLine || /[.!?。！？)`'"）\]]$/.test(lastLine)) {
    return false;
  }
  return lastLine.length <= 16 && /^[\d.\-\sA-Za-z|:，,;、（(]+$/.test(lastLine);
}

function looksLikeRepetitiveThinkingLoop(text) {
  const segments = thinkingRepetitionSegments(text);
  if (segments.length < 12) {
    return false;
  }
  const counts = new Map();
  for (const segment of segments) {
    counts.set(segment, (counts.get(segment) ?? 0) + 1);
  }
  for (const count of counts.values()) {
    if (count >= 8) {
      return true;
    }
  }
  return false;
}

function thinkingRepetitionSegments(text) {
  return String(text ?? "")
    .split(/\r?\n|(?<=[.!?。！？])\s+/)
    .map((part) => normalizeForHealthCompare(part).replace(/^\d+[.)、-]\s*/, ""))
    .filter((part) => part.length >= 30 && part.length <= 260);
}

function normalizeForHealthCompare(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function truncateForRepairPrompt(value, maxChars) {
  const text = String(value ?? "").trim();
  return text.length <= maxChars ? text : `${text.slice(0, maxChars).trimEnd()}\n...[truncated by output health check]`;
}

/**
 * @param {number} maxToolRounds
 * @param {Array<Record<string, any>>} pendingToolCalls
 */
function toolRoundLimitMessage(maxToolRounds, pendingToolCalls = []) {
  const names = pendingToolCalls
    .map((call) => call?.name)
    .filter((name) => typeof name === "string" && name.length > 0);
  return [
    `工具轮次已达到当前上限（${maxToolRounds} 轮），本轮已暂停，避免模型继续无限调用工具。`,
    names.length > 0 ? `尚未执行的下一批工具：${names.join(", ")}` : "",
    "如这是预期的超长任务，可以提高 LAB_AGENT_MAX_TOOL_ROUNDS 或在 lab-agent.config.json 的 limits.maxToolRounds 中配置更大的值，然后继续要求我接着执行。"
  ].filter(Boolean).join("\n");
}

function mainToolRoundLimitReached(maxToolRounds, round) {
  return Number.isInteger(maxToolRounds) && maxToolRounds > 0 && round === maxToolRounds;
}

/**
 * @param {{ session: Awaited<ReturnType<typeof createSession>>; prompt: string; messages: Array<Record<string, any>>; toolResults: Array<Record<string, any>>; round: number; gateway: ReturnType<typeof createLabModelGateway>; signal?: AbortSignal; env?: NodeJS.ProcessEnv; hooksTrusted?: boolean; eventOptions: Record<string, any> }} input
 */
async function preparePromptBudgetForGateway(input) {
  let messages = input.messages;
  const estimate = estimatePromptPayload({
    model: input.session.model,
    messages,
    tools: input.session.context.tools,
    toolResults: input.toolResults,
    gatewayProtocol: sessionGatewayProtocol(input.session)
  });
  if (!promptEstimateNeedsCompaction(estimate, input.session.contextWindow, input.session.config.context?.promptCompactRatio)) {
    return { messages, estimate };
  }

  if (input.round === 0) {
    const compaction = await compactSessionContextWithModel(input.session, {
      reason: "automatic_prompt_budget",
      force: true,
      gateway: input.gateway,
      signal: input.signal,
      env: input.env,
      hooksTrusted: input.hooksTrusted,
      onBeforeCompact: (payload) => emitEvent(input.eventOptions, {
        type: "context_compacting",
        reason: "automatic_prompt_budget",
        beforeMessages: payload.beforeMessages,
        beforeTokens: estimate.tokens,
        beforeBytes: payload.beforeBytes,
        maxTokens: payload.maxTokens,
        maxBytes: payload.maxBytes,
        maxMessages: payload.maxMessages
      })
    });
    if (compaction.compacted) {
      messages = buildTurnMessages(input.session, buildUserTurnMessage(input.prompt, input.session.workflow));
      await emitEvent(input.eventOptions, {
        type: "context_compacted",
        beforeMessages: compaction.beforeMessages,
        afterMessages: compaction.afterMessages,
        beforeTokens: estimate.tokens,
        afterTokens: estimatePromptPayload({
          model: input.session.model,
          messages,
          tools: input.session.context.tools,
          toolResults: input.toolResults,
          gatewayProtocol: sessionGatewayProtocol(input.session)
        }).tokens,
        summaryBytes: compaction.summaryBytes,
        strategy: compaction.strategy,
        internalAgent: compaction.internalAgent ?? null,
        fallbackReason: compaction.fallbackReason ?? null,
        reason: "automatic_prompt_budget"
      });
    }
  }

  const afterEstimate = estimatePromptPayload({
    model: input.session.model,
    messages,
    tools: input.session.context.tools,
    toolResults: input.toolResults,
    gatewayProtocol: sessionGatewayProtocol(input.session)
  });
  if (promptEstimateOverBudget(afterEstimate, input.session.contextWindow)) {
    await emitEvent(input.eventOptions, {
      type: "context_budget_warning",
      round: input.round + 1,
      promptBytesEstimate: afterEstimate.bytes,
      promptTokensEstimate: afterEstimate.tokens,
      maxBytes: input.session.contextWindow?.maxBytes ?? null,
      maxTokens: input.session.contextWindow?.maxTokens ?? null
    });
  }

  return { messages, estimate: afterEstimate };
}

function promptEstimateNeedsCompaction(estimate, contextWindow, ratioValue) {
  const ratio = boundedContextRatio(ratioValue, DEFAULT_PROMPT_COMPACT_RATIO);
  const maxTokens = Number.isFinite(contextWindow?.maxTokens) ? Math.floor(contextWindow.maxTokens * ratio) : null;
  const maxBytes = Number.isFinite(contextWindow?.maxBytes) ? Math.floor(contextWindow.maxBytes * ratio) : null;
  return Boolean(
    (maxTokens && estimate.tokens >= maxTokens) ||
    (maxBytes && estimate.bytes >= maxBytes)
  );
}

function promptEstimateOverBudget(estimate, contextWindow) {
  const maxTokens = Number.isFinite(contextWindow?.maxTokens) ? contextWindow.maxTokens : null;
  const maxBytes = Number.isFinite(contextWindow?.maxBytes) ? contextWindow.maxBytes : null;
  return Boolean(
    (maxTokens && estimate.tokens >= maxTokens) ||
    (maxBytes && estimate.bytes >= maxBytes)
  );
}

function boundedContextRatio(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number <= 1 ? number : fallback;
}

function sessionGatewayProtocol(session) {
  return session?.config?.lab?.gatewayProtocol ?? "lab-agent-gateway";
}

/**
 * @param {import("../model-gateway/protocol.js").GatewayToolCall[]} toolCalls
 * @param {ReturnType<typeof createToolRuntime>} toolRuntime
 * @param {{ onEvent?: (event: SessionEvent) => void | Promise<void>; signal?: AbortSignal; delegationGuard?: ReturnType<typeof createDelegationGuard>; reviewGate?: ReturnType<typeof createReviewGate> }} options
 */
async function executeToolCalls(toolCalls, toolRuntime, options = {}) {
  const results = [];
  const batches = createToolExecutionBatches(toolCalls, toolRuntime);
  const agentTaskIds = new Set();

  for (const batch of batches) {
    if (options.signal?.aborted) {
      results.push(...batch.calls.map((call) => skippedInterruptedToolResult(call)));
      return results;
    }
    if (batch.parallel) {
      const batchResults = await Promise.all(batch.calls.map((call) => executeOneToolCall(call, toolRuntime, options, agentTaskIds)));
      results.push(...batchResults);
      if (options.signal?.aborted || batchResults.some((result) => result.interrupted)) {
        return results;
      }
      continue;
    }
    for (const call of batch.calls) {
      if (options.signal?.aborted) {
        results.push(skippedInterruptedToolResult(call));
        return results;
      }
      const result = await executeOneToolCall(call, toolRuntime, options, agentTaskIds);
      results.push(result);
      if (options.signal?.aborted || result.interrupted) {
        return results;
      }
    }
  }

  return results;
}

/**
 * @param {import("../model-gateway/protocol.js").GatewayToolCall} call
 */
function skippedInterruptedToolResult(call) {
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
 * @param {import("../model-gateway/protocol.js").GatewayToolCall[]} toolCalls
 * @param {ReturnType<typeof createToolRuntime>} toolRuntime
 */
function createToolExecutionBatches(toolCalls, toolRuntime) {
  const batches = [];
  let parallel = [];
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
 * @param {import("../model-gateway/protocol.js").GatewayToolCall} call
 * @param {ReturnType<typeof createToolRuntime>} toolRuntime
 */
function isParallelAgentRun(call, toolRuntime) {
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
 * @param {import("../model-gateway/protocol.js").GatewayToolCall} call
 * @param {ReturnType<typeof createToolRuntime>} toolRuntime
 * @param {{ onEvent?: (event: SessionEvent) => void | Promise<void>; signal?: AbortSignal; delegationGuard?: ReturnType<typeof createDelegationGuard>; reviewGate?: ReturnType<typeof createReviewGate> }} options
 */
async function executeOneToolCall(call, toolRuntime, options = {}, agentTaskIds = new Set()) {
  const input = call.input && typeof call.input === "object" ? call.input : {};
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
  let execution = await toolRuntime.execute(call.name, effectiveInput);
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
  const changeSummary = summarizeToolChangeStats(call.name, execution.result, {
    turnChangeTracker: options.turnChangeTracker
  });
  const executionForModel = omitInternalToolResultFields(execution);
  const serialized = serializeToolResult(executionForModel);
  await emitEvent(options, {
    type: "tool_finish",
    toolCallId: call.id,
    name: call.name,
    taskId: taskId ?? execution.taskId ?? null,
    profile: call.name === "agent_run" ? execution.profile ?? effectiveInput?.profile ?? effectiveInput?.profileName ?? null : null,
    taskStatus: call.name === "agent_run"
      ? normalizeAgentTaskStatus(execution)
      : null,
    outputSummary: call.name === "agent_run" ? execution.outputSummary ?? execution.output ?? execution.error?.message ?? "" : null,
    ok: execution.ok === true,
    blocked: execution.blocked === true,
    interrupted: execution.interrupted === true,
    errorCode: execution.error?.code ?? null,
    decision: execution.decision?.decision ?? null,
    changeStats: changeSummary?.changeStats ?? null,
    turnChangeStats: changeSummary?.turnChangeStats ?? null,
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

function uniqueAgentTaskId(value, seen) {
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

function normalizeAgentTaskStatus(execution = {}) {
  if (execution.taskStatus) {
    return String(execution.taskStatus);
  }
  if (execution.result?.status) {
    return String(execution.result.status);
  }
  return execution.partial ? "partial" : execution.interrupted ? "interrupted" : execution.ok ? "completed" : execution.blocked ? "blocked" : "failed";
}

function omitInternalToolResultFields(execution) {
  if (!execution?.result || typeof execution.result !== "object") {
    return execution;
  }
  const { __changeSnapshot: _snapshot, ...result } = execution.result;
  return {
    ...execution,
    result
  };
}

function summarizeToolChangeStats(name, result, options = {}) {
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

function normalizeResultChangeStats(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  return {
    path: typeof value.path === "string" ? value.path : null,
    additions: nonNegativeInteger(value.additions, 0),
    deletions: nonNegativeInteger(value.deletions, 0),
    approximate: value.approximate === true
  };
}

function createTurnChangeTracker() {
  return {
    files: new Map()
  };
}

function updateTurnChangeTrackerForTool(tracker, options) {
  const snapshot = options?.result?.__changeSnapshot;
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

function summarizeTurnChangeTracker(tracker) {
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

function countUnifiedDiffChanges(diff) {
  const stats = { additions: 0, deletions: 0 };
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

/**
 * @param {Awaited<ReturnType<typeof createSession>>} session
 * @param {string} prompt
 */
function createTurnMetadata(session, prompt) {
  session.title ??= makeSessionTitle(prompt);
  const metadata = {
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
    model: session.model,
    prompt: redactPersistedText(prompt),
    promptBytes: Buffer.byteLength(prompt, "utf8"),
    outputBytes: 0,
    status: "started",
    rounds: 0,
    gatewayRounds: [],
    outputHealth: [],
    interruptedDraft: null,
    toolCalls: [],
    gatewayErrors: []
  };
  metadata.usage = normalizeProviderUsageAggregate(session.usage);
  metadata.workflow = summarizeWorkflow(session.workflow);
  metadata.context = summarizeContextWindow(session);
  if (session.resumedFrom) {
    metadata.resumedFrom = {
      id: session.resumedFrom.id,
      metadataPath: session.resumedFrom.metadataPath
    };
  }
  return metadata;
}

function recordGatewayRoundRequest(metadata, details) {
  if (!metadata || !Array.isArray(metadata.gatewayRounds)) {
    return;
  }
  const round = Number.isFinite(details.round) ? details.round : metadata.gatewayRounds.length + 1;
  const existing = metadata.gatewayRounds.find((item) => item.round === round);
  const target = existing ?? { round };
  target.request = {
    messageCount: details.messageCount ?? null,
    toolResultCount: details.toolResultCount ?? null,
    toolSchemaCount: details.toolSchemaCount ?? null,
    promptBytesEstimate: details.promptEstimate?.bytes ?? null,
    promptTokensEstimate: details.promptEstimate?.tokens ?? null,
    promptMessageTokensEstimate: details.promptEstimate?.messageTokens ?? null,
    promptToolSchemaTokensEstimate: details.promptEstimate?.toolSchemaTokens ?? null,
    promptToolResultTokensEstimate: details.promptEstimate?.toolResultTokens ?? null
  };
  if (!existing) {
    metadata.gatewayRounds.push(target);
  }
}

function recordGatewayRoundResponse(metadata, details) {
  if (!metadata || !Array.isArray(metadata.gatewayRounds)) {
    return;
  }
  const round = Number.isFinite(details.round) ? details.round : metadata.gatewayRounds.length + 1;
  const existing = metadata.gatewayRounds.find((item) => item.round === round);
  const target = existing ?? { round };
  const response = details.response ?? {};
  target.response = {
    messageId: response.id ?? null,
    model: response.model ?? null,
    textBytes: Buffer.byteLength(response.text ?? "", "utf8"),
    thinkingBytes: gatewayThinkingBytes(response),
    toolCallCount: Array.isArray(response.toolCalls) ? response.toolCalls.length : 0,
    stopReason: response.stopReason ?? null,
    usage: sanitizeProviderUsage(response.usage)
  };
  if (!existing) {
    metadata.gatewayRounds.push(target);
  }
}

function recordGatewayRoundError(metadata, details) {
  if (!metadata || !Array.isArray(metadata.gatewayRounds)) {
    return;
  }
  const round = Number.isFinite(details.round) ? details.round : metadata.gatewayRounds.length + 1;
  const existing = metadata.gatewayRounds.find((item) => item.round === round);
  const target = existing ?? { round };
  const error = details.error ?? {};
  target.error = {
    code: error.code ?? "GATEWAY_ERROR",
    message: redactPersistedText(error.message ?? "request failed"),
    status: error.status ?? null,
    details: sanitizeGatewayErrorDetails(error.details)
  };
  if (!existing) {
    metadata.gatewayRounds.push(target);
  }
}

function sanitizeGatewayErrorDetails(details) {
  if (!details || typeof details !== "object") {
    return {};
  }
  return sanitizePersistedValue(details);
}

function recordOutputHealth(metadata, details) {
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

function recordSessionProviderUsage(session, usage, details = {}) {
  const sanitized = sanitizeProviderUsage(usage);
  if (!sanitized) {
    return null;
  }
  session.usage = accumulateProviderUsage(session.usage, sanitized, details);
  session.lastProviderUsage = session.usage.last ?? sanitized;
  return session.usage;
}

/**
 * @param {{ cwd: string; config: Record<string, any>; tools?: Array<Record<string, any>>; env?: NodeJS.ProcessEnv; resume: string; preferFullContext?: boolean }} options
 */
async function resolveResumeMetadata(options) {
  const store = createSessionStore({
    cwd: options.cwd,
    transcript: options.config.transcript,
    env: options.env ?? process.env
  });
  const result = await store.readMetadata(options.resume);
  if (!result.ok) {
    throw new Error(`Unable to resume session '${options.resume}': ${result.error.message}`);
  }

  const restoredTranscriptMessages = restoreRecentTranscriptMessages(result.metadata.transcript?.messages);
  const transcriptArchive = normalizeTranscriptArchiveState(result.metadata.transcript?.archive);
  const modelContextArchive = normalizeTranscriptArchiveState(result.metadata.transcript?.modelArchive);
  const persistedContextWindow = result.metadata.transcript?.contextWindow ?? null;
  let restoredContext = await restoreResumeContextMessages({
    store,
    archive: transcriptArchive,
    modelArchive: modelContextArchive,
    metadataMessages: result.metadata.transcript?.contextMessages ?? result.metadata.transcript?.messages,
    context: options.config.context,
    allowArchive: options.preferFullContext === true || !hasPersistedCompaction(persistedContextWindow),
    preferArchive: options.preferFullContext === true
  });
  restoredContext = limitRestoredContextToPromptBudget(restoredContext, {
    config: options.config,
    model: result.metadata.model ?? options.config.modelAlias,
    tools: options.tools,
    clearPersistedSummary: options.preferFullContext === true,
    contextWindow: persistedContextWindow
  });
  const restoredContextMessages = restoredContext.messages;
  const contextWindow = restoredContext.fromArchive && restoredContext.clearPersistedSummary === true
    ? clearPersistedContextSummary(persistedContextWindow)
    : persistedContextWindow;

  return {
    id: result.metadata.id,
    startedAt: result.metadata.startedAt,
    turnCount: Number.isFinite(result.metadata.turnIndex) ? result.metadata.turnIndex : 0,
    metadataPath: result.path,
    status: result.metadata.status ?? "metadata",
    title: result.metadata.title ?? makeSessionTitle(result.metadata.prompt ?? ""),
    prompt: result.metadata.prompt ?? "",
    model: result.metadata.model ?? "",
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
  };
}

/**
 * @param {{ readonly?: boolean; allowWrite?: boolean; allowCommand?: boolean; fullAccess?: boolean }} flags
 */
function resolvePermissionModeFromFlags(flags) {
  if (flags.fullAccess) {
    return "fullAccess";
  }
  if (flags.allowWrite || flags.allowCommand) {
    return "workspace";
  }
  return "plan";
}

/**
 * @param {string | null | undefined} value
 */
function normalizePermissionModeValue(value) {
  const mode = String(value ?? "").trim();
  if (mode === "fullAccess" || mode === "full-access" || mode === "完全访问") {
    return "fullAccess";
  }
  if (mode === "workspace" || mode === "workspacePermissions" || mode === "bypassPermissions" || mode === "acceptEdits" || mode === "工作区权限") {
    return "workspace";
  }
  return "plan";
}

function normalizeClientSurfaceValue(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (["dashboard", "web", "webui", "web-ui"].includes(text)) {
    return "dashboard";
  }
  if (["tui", "terminal"].includes(text)) {
    return "tui";
  }
  if (["chat", "interactive-chat", "line"].includes(text)) {
    return "chat";
  }
  if (["print", "headless"].includes(text)) {
    return "print";
  }
  return "generic";
}

/**
 * @param {Awaited<ReturnType<typeof createSession>>} session
 * @param {string} prompt
 * @param {import("../model-gateway/protocol.js").NormalizedGatewayResponse} data
 * @param {string} fallbackText
 */
async function appendSessionMessages(session, data, fallbackText, options = {}) {
  const assistantContent = data.content.length > 0
    ? data.content
    : [{ type: "text", text: fallbackText }];
  const assistantMessage = {
    role: "assistant",
    content: assistantContent
  };
  const thinking = normalizeAssistantThinking(options.thinking);
  if (thinking) {
    assistantMessage.thinking = thinking;
  }

  const turnMessages = Array.isArray(options.turnMessages) ? options.turnMessages : [];
  const transcriptMessages = Array.isArray(options.transcriptMessages) ? options.transcriptMessages : turnMessages;
  session.messages.push(...turnMessages, assistantMessage);
  appendTranscriptMessages(session, [...transcriptMessages, assistantMessage]);
  appendModelContextArchiveMessages(session, [...turnMessages, assistantMessage]);

  return compactSessionContextWithModel(session, {
    reason: "automatic",
    gateway: options.gateway,
    signal: options.signal,
    env: options.env,
    hooksTrusted: options.hooksTrusted,
    onBeforeCompact: (payload) => emitEvent(options.eventOptions, {
      type: "context_compacting",
      reason: "automatic",
      beforeMessages: payload.beforeMessages,
      beforeTokens: payload.beforeTokens,
      beforeBytes: payload.beforeBytes,
      maxTokens: payload.maxTokens,
      maxBytes: payload.maxBytes,
      maxMessages: payload.maxMessages
    })
  });
}

/**
 * @param {ReturnType<typeof createSessionStore>} store
 * @param {Record<string, any>} metadata
 * @param {string} output
 * @param {string} status
 * @param {Awaited<ReturnType<typeof createSession>>} session
 */
async function persistSessionMetadata(store, metadata, output, status, session, options = {}) {
  metadata.status = status;
  metadata.finishedAt = new Date().toISOString();
  metadata.outputBytes = Buffer.byteLength(output, "utf8");
  metadata.usage = normalizeProviderUsageAggregate(session.usage);
  metadata.lastProviderUsage = metadata.usage.last ?? null;
  metadata.workflow = summarizeWorkflow(session.workflow);
  metadata.context = summarizeContextWindow(session);
  const transcriptArchive = await persistTranscriptArchive(store, session);
  const modelArchive = await persistModelContextArchive(store, session);
  metadata.transcript = {
    version: 2,
    messages: persistableTranscriptMessages(transcriptMessagesForPersistence(session)),
    contextMessages: persistableContextMessages(limitResumeContextMessages(session.messages, session.config.context)),
    contextWindow: persistableContextWindow(session.contextWindow),
    archive: persistableTranscriptArchive(transcriptArchive),
    modelArchive: persistableTranscriptArchive(modelArchive)
  };

  const path = await store.writeMetadata(metadata);
  metadata.metadataPath = path;
  await runHooks({
    config: session.config,
    cwd: session.cwd,
    env: options.env,
    hooksTrusted: options.hooksTrusted,
    event: "session.end",
    sessionId: session.id,
    payload: {
      sessionId: session.id,
      status,
      turnIndex: metadata.turnIndex,
      outputBytes: metadata.outputBytes,
      metadataPath: path,
      context: metadata.context
    }
  });
}

function persistableMessages(messages) {
  return persistableMessagesWithOptions(messages);
}

function persistableTranscriptMessages(messages) {
  return persistableMessagesWithOptions(messages, {
    includeThinking: true,
    includeToolCalls: false
  });
}

function persistableContextMessages(messages) {
  return persistableMessagesWithOptions(repairDanglingToolCallMessages(messages), {
    includeThinking: true,
    includeToolCalls: true
  });
}

function persistableMessagesWithOptions(messages, options = {}) {
  if (!Array.isArray(messages)) {
    return [];
  }
  return messages
    .map((message) => persistableMessage(message, options))
    .filter(Boolean);
}

function repairDanglingToolCallMessages(messages = []) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return [];
  }
  const source = messages.map((message) => cloneTranscriptMessage(message));
  const repaired = [];
  for (let index = 0; index < source.length; index += 1) {
    const message = source[index];
    if (message?.role === "tool") {
      continue;
    }
    const calls = assistantToolCalls(message);
    if (calls.length === 0) {
      repaired.push(message);
      continue;
    }
    const expected = new Set(calls.map((call) => String(call.id ?? "")).filter(Boolean));
    const seen = new Set();
    const toolMessages = [];
    let nextIndex = index + 1;
    for (; nextIndex < source.length; nextIndex += 1) {
      const next = source[nextIndex];
      if (!next || next.role !== "tool") {
        break;
      }
      const toolCallId = String(next.toolCallId ?? next.tool_call_id ?? "");
      if (expected.has(toolCallId) && !seen.has(toolCallId)) {
        seen.add(toolCallId);
        toolMessages.push(next);
      }
    }
    if (seen.size === expected.size && expected.size > 0) {
      repaired.push(message, ...toolMessages);
      index = nextIndex - 1;
      continue;
    }
    delete message.toolCalls;
    delete message.tool_calls;
    repaired.push(message);
    index = nextIndex - 1;
  }
  return repaired;
}

function assistantToolCalls(message) {
  if (!message || message.role !== "assistant") {
    return [];
  }
  if (Array.isArray(message.toolCalls)) {
    return message.toolCalls;
  }
  if (Array.isArray(message.tool_calls)) {
    return message.tool_calls.map((call) => ({
      id: call?.id,
      name: call?.function?.name ?? call?.name,
      input: call?.function?.arguments ?? call?.input
    }));
  }
  return [];
}

function transcriptMessagesForPersistence(session) {
  return Array.isArray(session.transcriptMessages) && session.transcriptMessages.length > 0
    ? session.transcriptMessages
    : session.messages;
}

async function persistTranscriptArchive(store, session) {
  session.transcriptArchive = normalizeTranscriptArchiveState(session.transcriptArchive);
  const pending = session.transcriptArchive.pendingMessages;
  const archive = await store.writeTranscriptChunks(session.id, pending, session.transcriptArchive);
  session.transcriptArchive = normalizeTranscriptArchiveState(archive);
  session.transcriptArchive.pendingMessages = [];
  return session.transcriptArchive;
}

async function persistModelContextArchive(store, session) {
  session.modelContextArchive = normalizeTranscriptArchiveState(session.modelContextArchive);
  const pending = session.modelContextArchive.pendingMessages;
  const archive = await store.writeTranscriptChunks(session.id, pending, session.modelContextArchive, {
    suffix: "model-context"
  });
  session.modelContextArchive = normalizeTranscriptArchiveState(archive);
  session.modelContextArchive.pendingMessages = [];
  return session.modelContextArchive;
}

function appendTranscriptMessages(session, messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return;
  }
  const cloned = messages.map((message) => cloneTranscriptMessage(message));
  if (!Array.isArray(session.transcriptMessages)) {
    session.transcriptMessages = Array.isArray(session.messages) ? session.messages.slice() : [];
  }
  session.transcriptMessages.push(...cloned);
  session.transcriptMessages = limitTranscriptMemory(session.transcriptMessages);
  session.transcriptArchive = normalizeTranscriptArchiveState(session.transcriptArchive);
  session.transcriptArchive.pendingMessages.push(...persistableContextMessages(cloned));
}

function appendModelContextArchiveMessages(session, messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return;
  }
  const cloned = messages.map((message) => cloneTranscriptMessage(message));
  session.modelContextArchive = normalizeTranscriptArchiveState(session.modelContextArchive);
  session.modelContextArchive.pendingMessages.push(...persistableContextMessages(cloned));
}

function limitTranscriptMemory(messages) {
  if (!Array.isArray(messages)) {
    return [];
  }
  return messages.slice(-TRANSCRIPT_MEMORY_MESSAGES);
}

function normalizeTranscriptArchiveState(archive = {}) {
  const chunkSize = positiveInteger(archive?.chunkSize, TRANSCRIPT_MEMORY_MESSAGES);
  const chunks = Array.isArray(archive?.chunks)
    ? archive.chunks.map(normalizeTranscriptArchiveChunk).filter(Boolean)
    : [];
  const totalFromChunks = chunks.reduce((sum, chunk) => sum + chunk.messages, 0);
  return {
    version: 1,
    chunkSize,
    totalMessages: nonNegativeInteger(archive?.totalMessages, totalFromChunks),
    chunks,
    pendingMessages: Array.isArray(archive?.pendingMessages) ? archive.pendingMessages.filter(Boolean) : []
  };
}

function normalizeTranscriptArchiveChunk(chunk) {
  if (!chunk || typeof chunk !== "object") {
    return null;
  }
  const index = positiveInteger(chunk.index, null);
  const file = typeof chunk.file === "string" ? chunk.file : "";
  if (!index || !file) {
    return null;
  }
  return {
    index,
    file,
    messages: nonNegativeInteger(chunk.messages, 0),
    bytes: nonNegativeInteger(chunk.bytes, 0),
    encrypted: chunk.encrypted === true || file.endsWith(".json.enc")
  };
}

function persistableTranscriptArchive(archive = {}) {
  const normalized = normalizeTranscriptArchiveState(archive);
  return {
    version: normalized.version,
    chunkSize: normalized.chunkSize,
    totalMessages: normalized.totalMessages,
    chunks: normalized.chunks
  };
}

function cloneTranscriptMessage(message) {
  if (!message || typeof message !== "object") {
    return message;
  }
  return {
    ...message,
    content: cloneTranscriptContent(message.content),
    ...(message.thinking ? { thinking: { ...message.thinking } } : {})
  };
}

function cloneTranscriptContent(content) {
  if (Array.isArray(content)) {
    return content.map((item) => (item && typeof item === "object" ? { ...item } : item));
  }
  return content;
}

function persistableMessage(message, options = {}) {
  if (!message || typeof message !== "object") {
    return null;
  }
  const role = typeof message.role === "string" ? message.role : "";
  if (!["user", "assistant", "tool"].includes(role)) {
    return null;
  }
  const persisted = {
    role,
    content: persistableContent(message.content, {
      sanitizeAssistantText: role === "assistant"
    })
  };
  if (message.interruptedDraft === true) {
    persisted.interruptedDraft = true;
  }
  const thinking = options.includeThinking === false ? null : role === "assistant" ? persistableThinking(message.thinking) : null;
  if (thinking) {
    persisted.thinking = thinking;
  }
  if (options.includeToolCalls !== false && Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
    persisted.toolCalls = message.toolCalls.map((call) => ({
      id: typeof call.id === "string" ? call.id : "",
      name: typeof call.name === "string" ? call.name : "",
      input: sanitizePersistedValue(call.input ?? {})
    }));
  }
  if (role === "tool") {
    if (typeof message.toolCallId === "string" && message.toolCallId) {
      persisted.toolCallId = message.toolCallId;
    }
    if (typeof message.name === "string" && message.name) {
      persisted.name = message.name;
    }
  }
  return persisted;
}

function persistableThinking(thinking) {
  const normalized = normalizeAssistantThinking(thinking);
  if (!normalized) {
    return null;
  }
  const text = redactPersistedText(normalized.text);
  const bytes = Buffer.byteLength(text, "utf8") || normalized.bytes;
  return {
    text,
    bytes,
    truncated: normalized.truncated === true,
    source: normalized.source,
    persistedAt: normalized.persistedAt
  };
}

function persistableContent(content, options = {}) {
  const sanitizeAssistantText = options.sanitizeAssistantText === true;
  if (typeof content === "string") {
    const text = redactPersistedText(content);
    return sanitizeAssistantText ? sanitizeRestoredAssistantText(text) : text;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content.map((item) => {
    if (typeof item === "string") {
      const text = redactPersistedText(item);
      return sanitizeAssistantText ? sanitizeRestoredAssistantText(text) : text;
    }
    if (!item || typeof item !== "object") {
      return item;
    }
    if (item.type === "image") {
      return imageAttachmentSummaryBlock({
        name: String(item.name ?? "image"),
        mimeType: String(item.mimeType ?? item.mime_type ?? "image"),
        size: nonNegativeInteger(item.size ?? item.bytes ?? item.sizeBytes, 0)
      });
    }
    if ("text" in item) {
      const text = redactPersistedText(String(item.text ?? ""));
      return {
        ...item,
        text: sanitizeAssistantText ? sanitizeRestoredAssistantText(text) : text
      };
    }
    return sanitizePersistedValue(item);
  });
}

function sanitizePersistedValue(value) {
  if (typeof value === "string") {
    return redactPersistedText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizePersistedValue(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    /token|secret|password|api_key/i.test(key) ? "[redacted]" : sanitizePersistedValue(item)
  ]));
}

function restorePersistedMessages(messages) {
  if (!Array.isArray(messages)) {
    return [];
  }
  return messages
    .map((message) => sanitizeRestoredMessage(persistableMessage(message)))
    .filter(Boolean);
}

function restoreRecentTranscriptMessages(messages) {
  if (!Array.isArray(messages)) {
    return [];
  }
  return restorePersistedMessages(messages.slice(-TRANSCRIPT_MEMORY_MESSAGES));
}

function restorePersistedContextMessages(messages, context = {}) {
  if (!Array.isArray(messages)) {
    return [];
  }
  return repairDanglingToolCallMessages(restorePersistedMessages(limitResumeContextMessages(messages, context)));
}

async function restoreResumeContextMessages(input) {
  const persisted = restorePersistedContextMessages(input.metadataMessages, input.context);
  if (input.allowArchive === false) {
    return { messages: persisted, persistedMessages: persisted, fromArchive: false };
  }
  const archived = await restoreArchivedContextMessages(input.store, input.archive, input.context);
  const modelArchived = await restoreArchivedContextMessages(input.store, input.modelArchive, input.context);
  const bestArchived = mergeModelArchiveIntoBase(archived, modelArchived, input.context);
  if (input.preferArchive === true && archived.length > 0) {
    return { messages: bestArchived.length > 0 ? bestArchived : archived, persistedMessages: persisted, fromArchive: true };
  }
  if (input.preferArchive === true && modelArchived.length > 0) {
    return { messages: modelArchived, persistedMessages: persisted, fromArchive: true };
  }
  const archiveCandidate = bestArchived.length > 0 ? bestArchived : archived.length > 0 ? archived : modelArchived;
  return archiveCandidate.length > persisted.length
    ? { messages: archiveCandidate, persistedMessages: persisted, fromArchive: true }
    : { messages: persisted, persistedMessages: persisted, fromArchive: false };
}

function limitRestoredContextToPromptBudget(restoredContext, options = {}) {
  if (!restoredContext?.fromArchive) {
    return restoredContext;
  }
  const fallbackMessages = Array.isArray(restoredContext.persistedMessages)
    ? restoredContext.persistedMessages
    : [];
  if (!hasPersistedCompaction(options.contextWindow) || fallbackMessages.length === 0) {
    return {
      ...restoredContext,
      clearPersistedSummary: options.clearPersistedSummary === true
    };
  }
  const contextWindow = createContextWindow(options.config ?? {});
  const estimate = estimatePromptPayload({
    model: String(options.model ?? options.config?.modelAlias ?? ""),
    messages: restoredContext.messages,
    tools: options.tools,
    toolResults: [],
    gatewayProtocol: options.config?.lab?.gatewayProtocol
  });
  if (!promptEstimateNeedsCompaction(estimate, contextWindow, options.config?.context?.promptCompactRatio)) {
    return {
      ...restoredContext,
      clearPersistedSummary: options.clearPersistedSummary === true
    };
  }
  return {
    ...restoredContext,
    messages: fallbackMessages,
    fromArchive: false,
    limited: true,
    limitReason: "restored_full_context_over_budget",
    clearPersistedSummary: false
  };
}

function mergeModelArchiveIntoBase(baseMessages, modelMessages, context = {}) {
  const base = Array.isArray(baseMessages) ? baseMessages.filter(Boolean) : [];
  const model = Array.isArray(modelMessages) ? modelMessages.filter(Boolean) : [];
  if (model.length === 0) {
    return base;
  }
  if (base.length === 0) {
    return model;
  }
  const first = model[0];
  if (first?.role === "user") {
    const index = findLastMessageIndex(base, first);
    if (index >= 0) {
      return restorePersistedContextMessages(base.slice(0, index).concat(model), context);
    }
  }
  const overlap = largestMessageOverlap(base, model);
  return restorePersistedContextMessages(base.concat(model.slice(overlap)), context);
}

function findLastMessageIndex(messages, target) {
  const key = stableMessageKey(target);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (stableMessageKey(messages[index]) === key) {
      return index;
    }
  }
  return -1;
}

function largestMessageOverlap(left, right) {
  const max = Math.min(left.length, right.length);
  for (let size = max; size > 0; size -= 1) {
    let same = true;
    for (let offset = 0; offset < size; offset += 1) {
      if (stableMessageKey(left[left.length - size + offset]) !== stableMessageKey(right[offset])) {
        same = false;
        break;
      }
    }
    if (same) {
      return size;
    }
  }
  return 0;
}

function stableMessageKey(message) {
  return JSON.stringify(message ?? null);
}

function clearPersistedContextSummary(contextWindow) {
  if (!contextWindow || typeof contextWindow !== "object") {
    return contextWindow;
  }
  return {
    ...contextWindow,
    summary: "",
    compactionCount: 0,
    compactedMessages: 0,
    lastCompactedAt: null,
    lastReason: "dashboard_full_context_resume",
    lastStrategy: null,
    lastFallbackReason: null,
    lastInternalAgent: null
  };
}

function hasPersistedCompaction(contextWindow) {
  return Boolean(
    contextWindow &&
    (
      Number(contextWindow.compactionCount) > 0 ||
      Number(contextWindow.compactedMessages) > 0 ||
      String(contextWindow.summary ?? "").trim()
    )
  );
}

async function restoreArchivedContextMessages(store, archive = {}, context = {}) {
  const normalized = normalizeTranscriptArchiveState(archive);
  if (!store || normalized.chunks.length === 0) {
    return [];
  }
  const maxMessages = positiveInteger(context?.resumeMaxMessages, DEFAULT_RESUME_CONTEXT_MESSAGES);
  const chunkCount = Math.max(1, Math.ceil(maxMessages / normalized.chunkSize));
  const chunks = normalized.chunks.slice(-chunkCount);
  const messages = [];
  for (const chunk of chunks) {
    const result = await store.readTranscriptChunk(normalized, chunk.index);
    if (result.ok && Array.isArray(result.messages)) {
      messages.push(...result.messages);
    }
  }
  return repairDanglingToolCallMessages(restorePersistedMessages(limitResumeContextMessages(messages, context)));
}

function limitResumeContextMessages(messages, context = {}) {
  if (!Array.isArray(messages)) {
    return [];
  }
  const maxMessages = positiveInteger(context?.resumeMaxMessages, DEFAULT_RESUME_CONTEXT_MESSAGES);
  const maxTokens = positiveInteger(context?.resumeMaxTokens, DEFAULT_RESUME_CONTEXT_TOKENS);
  const maxBytes = positiveInteger(context?.resumeMaxBytes, DEFAULT_RESUME_CONTEXT_BYTES);
  let kept = messages.filter(Boolean).slice(-maxMessages);
  while (kept.length > 1) {
    const bytes = estimatePersistedMessagesBytes(kept);
    if (bytes <= maxBytes && estimateTokensFromBytesLocal(bytes) <= maxTokens) {
      break;
    }
    kept = kept.slice(1);
  }
  return alignContextStartToUser(kept);
}

function alignContextStartToUser(messages) {
  if (!Array.isArray(messages) || messages.length <= 1 || messages[0]?.role === "user") {
    return messages;
  }
  const firstUser = messages.findIndex((message) => message?.role === "user");
  return firstUser > 0 ? messages.slice(firstUser) : messages;
}

function estimatePersistedMessagesBytes(messages) {
  return Buffer.byteLength(JSON.stringify(messages ?? []), "utf8");
}

function estimateTokensFromBytesLocal(bytes) {
  const number = Number(bytes);
  if (!Number.isFinite(number) || number <= 0) {
    return 0;
  }
  return Math.max(1, Math.ceil(number / 4));
}

function sanitizeRestoredMessage(message) {
  if (!message || message.role !== "assistant") {
    return message;
  }
  const restored = {
    ...message,
    content: sanitizeRestoredContent(message.content)
  };
  const thinking = persistableThinking(message.thinking);
  if (thinking) {
    restored.thinking = thinking;
  }
  return restored;
}

function sanitizeRestoredContent(content) {
  if (typeof content === "string") {
    return sanitizeRestoredAssistantText(content);
  }
  if (!Array.isArray(content)) {
    return content;
  }
  return content.map((item) => {
    if (typeof item === "string") {
      return sanitizeRestoredAssistantText(item);
    }
    if (item && typeof item === "object" && "text" in item) {
      return {
        ...item,
        text: sanitizeRestoredAssistantText(String(item.text ?? ""))
      };
    }
    return item;
  });
}

function sanitizeRestoredAssistantText(value) {
  const text = String(value ?? "");
  if (!looksLikeRawOpenAIResponseDump(text)) {
    return text;
  }
  const summary = summarizeRawOpenAIResponseDump(text);
  return [
    "这条历史回复是旧版本保存的 OpenAI 兼容网关原始响应，已在恢复时折叠清理。",
    "原因：模型没有返回 content 正文，旧版本把 raw SSE JSON 当作助手正文保存。",
    summary ? `摘要：${summary}` : "",
    "建议：重新发送上一条需求，新版本会使用当前网关映射和安全 fallback。"
  ].filter(Boolean).join("\n");
}

function looksLikeRawOpenAIResponseDump(value) {
  if (value.length < 5000) {
    return false;
  }
  return value.includes("\"object\":\"chat.completion.chunk\"")
    || value.includes('"object": "chat.completion.chunk"')
    || (value.includes('"raw": "data:') && value.includes("reasoning_content"));
}

function summarizeRawOpenAIResponseDump(value) {
  try {
    const parsed = JSON.parse(value);
    const bytes = Buffer.byteLength(String(parsed.raw ?? ""), "utf8");
    const model = typeof parsed.model === "string" ? parsed.model : "";
    return [model ? `model=${model}` : "", bytes ? `rawBytes=${bytes}` : ""].filter(Boolean).join(", ");
  } catch {
    return "";
  }
}

function persistableContextWindow(contextWindow = {}) {
  return {
    summary: redactPersistedText(contextWindow.summary ?? ""),
    compactionCount: Number.isFinite(contextWindow.compactionCount) ? contextWindow.compactionCount : 0,
    compactedMessages: Number.isFinite(contextWindow.compactedMessages) ? contextWindow.compactedMessages : 0,
    lastCompactedAt: contextWindow.lastCompactedAt ?? null,
    lastReason: contextWindow.lastReason ?? null,
    lastStrategy: contextWindow.lastStrategy ?? null,
    lastFallbackReason: contextWindow.lastFallbackReason ?? null,
    lastInternalAgent: contextWindow.lastInternalAgent ?? null
  };
}

function redactPersistedText(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]")
    .replace(/(^|[\s"'`])(--?(?:api-?key|token|secret|password|credential|authorization)(?:=|\s+))\S+/gi, "$1$2[redacted]")
    .replace(/\b([A-Za-z0-9_.-]*(?:api[-_]?key|token|secret|password|credential|authorization)[A-Za-z0-9_.-]*\s*(?:=|:|\bis\b)\s*)\S+/gi, "$1[redacted]")
    .replace(/([?&](?:api[-_]?key|token|secret|password|credential|authorization)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]");
}

function makeSessionTitle(value) {
  const text = redactPersistedText(value).replace(/\s+/g, " ").trim();
  if (!text) {
    return null;
  }
  return text.length <= 80 ? text : `${text.slice(0, 77)}...`;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function nonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

/**
 * @param {{ session: Awaited<ReturnType<typeof createSession>>; sessionStore: ReturnType<typeof createSessionStore>; metadata: Record<string, any>; eventOptions: Record<string, any>; prompt?: string; env?: NodeJS.ProcessEnv; hooksTrusted?: boolean; reason: string; draft?: ReturnType<typeof createInterruptedDraftCapture> }} options
 */
async function finishInterruptedTurn(options) {
  const draft = normalizeInterruptedDraft(options.draft);
  const finalOutput = draft
    ? [
      "Turn interrupted by the local user.",
      "",
      "Interrupted assistant draft saved:",
      draft.text
    ].join("\n")
    : "Turn interrupted by the local user.";
  if (draft) {
    options.metadata.interruptedDraft = {
      textBytes: draft.bytes,
      thinkingBytes: draft.thinkingBytes,
      reason: options.reason
    };
    appendInterruptedDraftMessages(options.session, options.prompt, options.displayPrompt ?? options.prompt, draft, options.reason);
    await emitEvent(options.eventOptions, {
      type: "assistant_interrupted_draft",
      reason: options.reason,
      text: draft.text,
      outputBytes: draft.bytes,
      thinking: draft.thinking,
      thinkingBytes: draft.thinkingBytes
    });
  }
  await emitEvent(options.eventOptions, {
    type: "turn_interrupted",
    reason: options.reason,
    draftText: draft?.text ?? "",
    draftBytes: draft?.bytes ?? 0,
    draftThinking: draft?.thinking ?? "",
    draftThinkingBytes: draft?.thinkingBytes ?? 0,
    outputBytes: Buffer.byteLength(finalOutput, "utf8")
  });
  await persistSessionMetadata(options.sessionStore, options.metadata, finalOutput, "interrupted", options.session, {
    env: options.env,
    hooksTrusted: options.hooksTrusted
  });
  await emitEvent(options.eventOptions, {
    type: "turn_complete",
    status: "interrupted",
    outputBytes: Buffer.byteLength(finalOutput, "utf8")
  });
  return {
    session: options.session,
    output: finalOutput,
    interrupted: true
  };
}

function createInterruptedDraftCapture() {
  return {
    text: "",
    thinking: "",
    thinkingBytes: 0
  };
}

function captureInterruptedDraftEvent(capture, event) {
  if (!capture || !event || typeof event !== "object") {
    return;
  }
  if (event.type === "assistant_delta") {
    capture.text += String(event.text ?? "");
    return;
  }
  if (event.type === "assistant_thinking_delta") {
    const text = String(event.text ?? "");
    capture.thinking += text;
    capture.thinkingBytes += event.bytes ?? Buffer.byteLength(text, "utf8");
  }
}

function normalizeInterruptedDraft(draft) {
  const text = String(draft?.text ?? "");
  const thinkingPreview = limitThinkingPreview(String(draft?.thinking ?? ""));
  const bytes = Buffer.byteLength(text, "utf8");
  const thinkingBytes = Number.isFinite(draft?.thinkingBytes)
    ? draft.thinkingBytes
    : thinkingPreview.bytes;
  if (!text.trim()) {
    return null;
  }
  return {
    text,
    bytes,
    thinking: thinkingPreview.text,
    thinkingBytes
  };
}

function appendFailedGatewayDraft(options) {
  const draft = normalizeInterruptedDraft(options.draft);
  if (!draft) {
    return null;
  }
  options.metadata.interruptedDraft = {
    textBytes: draft.bytes,
    thinkingBytes: draft.thinkingBytes,
    reason: options.reason
  };
  appendInterruptedDraftMessages(options.session, options.prompt, options.displayPrompt ?? options.prompt, draft, options.reason);
  return {
    ...draft,
    reason: options.reason
  };
}

function appendInterruptedDraftMessages(session, prompt, displayPrompt, draft, reason) {
  const note = [
    "[中断草稿，非最终回复]",
    `原因：${reason}`,
    "",
    draft.text
  ].join("\n");
  const assistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: note }],
    interruptedDraft: true
  };
  const thinking = normalizeAssistantThinking({
    text: draft.thinking,
    bytes: draft.thinkingBytes,
    source: "gateway-interrupted"
  });
  if (thinking) {
    assistantMessage.thinking = thinking;
  }
  if (typeof prompt === "string" && prompt.trim()) {
    session.messages.push(persistableUserTurnMessage(prompt));
  }
  session.messages.push(assistantMessage);
  appendTranscriptMessages(session, [
    ...(typeof displayPrompt === "string" && displayPrompt.trim() ? [{ role: "user", content: displayPrompt }] : []),
    assistantMessage
  ]);
}

/**
 * @param {import("../model-gateway/protocol.js").GatewayToolCall[]} calls
 * @param {Array<Record<string, any>>} results
 */
function summarizeToolCalls(calls, results) {
  return calls.map((call, index) => {
    const result = parseToolResult(results[index]?.content);
    return {
      id: call.id,
      name: call.name,
      inputKeys: Object.keys(call.input ?? {}).sort(),
      ok: result.ok === true,
      blocked: result.blocked === true,
      interrupted: results[index]?.interrupted === true || result.interrupted === true,
      decision: result.decision?.decision ?? null,
      truncated: Boolean(results[index]?.truncated)
    };
  });
}

/**
 * @param {import("../model-gateway/protocol.js").GatewayToolCall[]} calls
 */
function summarizeToolCallRequests(calls) {
  return calls.map((call) => ({
    id: call.id,
    name: call.name,
    inputKeys: Object.keys(call.input ?? {}).sort()
  }));
}

/**
 * @param {Awaited<ReturnType<typeof createSession>>} session
 * @param {Record<string, any>} options
 */
function withAntEventOptions(session, options) {
  if (!options.onAntEvent) {
    return options;
  }
  return {
    ...options,
    antEventNormalizer: createAntEventNormalizer({ sessionId: session.id })
  };
}

/**
 * @param {{ onEvent?: (event: SessionEvent) => void | Promise<void>; onAntEvent?: (event: Record<string, any>) => void | Promise<void>; antEventNormalizer?: ReturnType<typeof createAntEventNormalizer> }} options
 * @param {SessionEvent} event
 */
async function emitEvent(options, event) {
  const legacyEvent = {
    at: new Date().toISOString(),
    ...event
  };
  if (options.onEvent) {
    await options.onEvent(legacyEvent);
  }
  if (options.onAntEvent && options.antEventNormalizer) {
    for (const antEvent of options.antEventNormalizer.normalize(legacyEvent)) {
      await options.onAntEvent(antEvent);
    }
  }
}

/**
 * @param {{ onEvent?: (event: SessionEvent) => void | Promise<void>; onAntEvent?: (event: Record<string, any>) => void | Promise<void>; antEventNormalizer?: ReturnType<typeof createAntEventNormalizer> }} options
 * @param {Record<string, any>} event
 * @param {number} round
 */
async function emitGatewayStreamEvent(options, event, round) {
  if (event.type === "gateway_retry") {
    await emitEvent(options, {
      type: "gateway_retry",
      round,
      attempt: event.attempt ?? null,
      maxAttempts: event.maxAttempts ?? null,
      delayMs: event.delayMs ?? null,
      stage: event.stage ?? null,
      error: event.error ?? null
    });
    return;
  }
  if (event.type === "message_start") {
    await emitEvent(options, {
      type: "gateway_stream_start",
      round,
      messageId: event.id ?? null,
      model: event.model ?? null
    });
    return;
  }
  if (event.type === "text_delta" && typeof event.text === "string" && event.text.length > 0) {
    await emitEvent(options, {
      type: "assistant_delta",
      round,
      text: event.text,
      bytes: Buffer.byteLength(event.text, "utf8")
    });
    return;
  }
  if (event.type === "thinking_delta" && typeof event.text === "string" && event.text.length > 0) {
    await emitEvent(options, {
      type: "assistant_thinking_delta",
      round,
      text: event.text,
      bytes: Buffer.byteLength(event.text, "utf8")
    });
    return;
  }
  if (event.type === "tool_call_delta") {
    await emitEvent(options, {
      type: "tool_call_delta",
      round,
      index: Number.isInteger(event.index) ? event.index : null,
      id: typeof event.id === "string" ? event.id : null,
      nameDelta: typeof event.nameDelta === "string" ? event.nameDelta : "",
      argumentsDelta: typeof event.argumentsDelta === "string" ? event.argumentsDelta : ""
    });
    return;
  }
  if (event.type === "message_stop") {
    await emitEvent(options, {
      type: "gateway_stream_stop",
      round,
      stopReason: typeof event.stopReason === "string" ? event.stopReason : null
    });
  }
}

/**
 * @param {unknown} content
 */
function parseToolResult(content) {
  if (typeof content !== "string") {
    return {};
  }
  try {
    return JSON.parse(content);
  } catch {
    return {};
  }
}

function createThinkingCapture() {
  return {
    byRound: new Map()
  };
}

function captureThinkingEvent(capture, event) {
  if (!capture || event?.type !== "assistant_thinking_delta") {
    return;
  }
  const round = Number.isFinite(event.round) ? event.round : 0;
  const text = String(event.text ?? "");
  if (!text) {
    return;
  }
  const current = capture.byRound.get(round) ?? { text: "", bytes: 0, truncated: false };
  const bytes = event.bytes ?? Buffer.byteLength(text, "utf8");
  const preview = appendThinkingPreview(current.text, text);
  capture.byRound.set(round, {
    text: preview.text,
    bytes: current.bytes + bytes,
    truncated: current.truncated || preview.truncated || event.truncated === true
  });
}

function thinkingForRound(capture, round, data = {}) {
  const captured = capture?.byRound?.get(round);
  const fallback = typeof data.thinkingText === "string" ? data.thinkingText : extractThinkingFromGatewayRaw(data.raw);
  const preview = captured
    ? { text: captured.text, bytes: captured.bytes, truncated: captured.truncated }
    : limitThinkingPreview(fallback);
  const reportedBytes = Number(data.raw?.thinkingBytes ?? 0);
  const bytes = Math.max(preview.bytes, reportedBytes);
  if (!preview.text && bytes <= 0) {
    return null;
  }
  return {
    text: preview.text,
    bytes,
    source: "gateway",
    truncated: preview.truncated || Boolean(data.raw?.thinkingTruncated),
    persistedAt: new Date().toISOString()
  };
}

function normalizeAssistantThinking(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const preview = limitThinkingPreview(String(value.text ?? ""));
  const bytes = Number.isFinite(value.bytes)
    ? value.bytes
    : preview.bytes;
  if (!preview.text && bytes <= 0) {
    return null;
  }
  return {
    text: preview.text,
    bytes,
    truncated: value.truncated === true || preview.truncated,
    source: typeof value.source === "string" ? value.source : "gateway",
    persistedAt: typeof value.persistedAt === "string" ? value.persistedAt : new Date().toISOString()
  };
}

function extractThinkingFromGatewayRaw(raw) {
  if (!raw || typeof raw !== "object") {
    return "";
  }
  const value = /** @type {Record<string, any>} */ (raw);
  const choice = Array.isArray(value.choices) ? value.choices[0] : null;
  const message = choice && typeof choice === "object" ? choice.message : null;
  const direct = firstThinkingText(message && typeof message === "object" ? message : value);
  return direct;
}

function firstThinkingText(value) {
  if (!value || typeof value !== "object") {
    return "";
  }
  for (const key of ["reasoning_content", "thinking", "thought", "reasoning"]) {
    if (typeof value[key] === "string" && value[key].length > 0) {
      return value[key];
    }
  }
  return "";
}
