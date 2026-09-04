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
  SessionTurnMetadata
} from "./session-types.ts";
import {
  buildTurnMessages,
  prepareVisionAttachmentsForTurn,
  buildUserTurnMessage,
  persistableUserTurnMessage,
  normalizeInputAttachments,
  attachmentMetadataList
} from "./session-messages.ts";
import {
  formatAssistantOutput,
  analyzeAssistantOutputHealth,
  assistantResponseText,
  finishIncompleteAssistantResponse,
  shouldRetryOutputHealth,
  buildOutputHealthRepairPrompt,
  gatewayThinkingBytes,
  toolRoundLimitMessage,
  mainToolRoundLimitReached,
  contextOverflowMessage,
  preparePromptBudgetForGateway,
  sessionGatewayProtocol,
  executeToolCalls
} from "./session-health.ts";
import {
  createVisualEvidenceStore,
  distillLiveImageBlocks,
  registerVisualEvidence
} from "./visual-evidence.ts";
import {
  createTurnChangeTracker,
  createTurnMetadata,
  recordGatewayRoundRequest,
  recordGatewayRoundResponse,
  recordGatewayRoundError,
  recordOutputHealth,
  recordSessionProviderUsage
} from "./session-tools.ts";
import {
  appendSessionMessages,
  persistSessionMetadata
} from "./session-persist.ts";
import {
  finishInterruptedTurn,
  createInterruptedDraftCapture,
  captureInterruptedDraftEvent,
  appendFailedGatewayDraft,
  summarizeToolCalls,
  summarizeToolCallRequests,
  withAntEventOptions,
  emitEvent,
  emitGatewayStreamEvent,
  createThinkingCapture,
  captureThinkingEvent,
  thinkingForRound
} from "./session-resume.ts";


export async function runSessionTurn(session: AgentSession, options: RunSessionTurnOptions) {
  const displayPrompt = typeof options.displayPrompt === "string" ? options.displayPrompt : options.prompt;
  const attachments = normalizeInputAttachments(options.attachments);
  const thinkingCapture = createThinkingCapture();
  const interruptedDraft = createInterruptedDraftCapture();
  const eventOptions = withAntEventOptions(session, {
    ...options,
    onEvent: async (event: SessionEvent) => {
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
  session.visualEvidence ??= createVisualEvidenceStore();
  const toolRuntime = createToolRuntime({
    cwd: session.cwd,
    config: session.config,
    env: options.env,
    signal: options.signal,
    mcpRuntime,
    workflowState: session.workflow,
    visualEvidence: session.visualEvidence,
    approve: options.approvalCallback,
    askUser: options.userInputCallback,
    parentSessionId: session.id,
    backgroundParentSessionId: session.id,
    hooksTrusted: options.hooksTrusted,
    onBackgroundAgentEvent: (event: Record<string, unknown>) => emitEvent(eventOptions, event),
    onBackgroundTerminalEvent: (event: Record<string, unknown>) => emitEvent(eventOptions, event),
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
      "Set LAB_MODEL_GATEWAY_URL to enable model turns through the lab gateway.",
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
    finalOutput = String(visionPreparation.output ?? "");
    await persistSessionMetadata(sessionStore, metadata, finalOutput, String(visionPreparation.status ?? "vision_error"), session, options);
    await emitEvent(eventOptions, {
      type: "turn_complete",
      status: visionPreparation.status,
      outputBytes: Buffer.byteLength(finalOutput, "utf8")
    });
    return { session, output: finalOutput };
  }

  for (const attachment of normalizeInputAttachments(attachments)) {
    registerVisualEvidence(session.visualEvidence, {
      source: "user",
      name: attachment.name,
      mimeType: attachment.mimeType,
      data: attachment.data,
      bytes: attachment.size
    });
  }

  const userMessage = buildUserTurnMessage(options.prompt, session.workflow, visionPreparation.attachments, visionPreparation.analysisText);
  let messages: SessionMessage[] = buildTurnMessages(session, userMessage);
  let toolResults: SessionToolResult[] = [];
  const turnMessages: SessionMessage[] = [persistableUserTurnMessage(options.prompt, attachments)];
  const transcriptTurnMessages: SessionMessage[] = [persistableUserTurnMessage(displayPrompt, attachments)];
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
    if (round > 0) {
      messages = distillLiveImageBlocks(messages, session.visualEvidence);
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
      eventOptions,
      attachments: round === 0 ? visionPreparation.attachments : [],
      visionAnalysisText: visionPreparation.analysisText
    });
    messages = budgetPreparation.messages;
    if (budgetPreparation.blocked) {
      finalOutput = contextOverflowMessage(budgetPreparation.estimate, session.contextWindow);
      await persistSessionMetadata(sessionStore, metadata, finalOutput, "context_overflow", session, options);
      await emitEvent(eventOptions, {
        type: "turn_complete",
        status: "context_overflow",
        outputBytes: Buffer.byteLength(finalOutput, "utf8")
      });
      return { session, output: finalOutput };
    }

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
      onEvent: (event: Record<string, unknown>) => emitGatewayStreamEvent(eventOptions, event, round + 1)
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
          const retryAssistantMessage: SessionMessage = {
            role: "assistant",
            content: response.data.content.length > 0
              ? response.data.content
              : []
          };
          if (thinking) {
            retryAssistantMessage.thinking = thinking;
          }
          const retryPromptMessage = {
            role: "user",
            content: buildOutputHealthRepairPrompt(
              outputHealth,
              outputHealth.reasons.includes("missing_terminal_signal")
                ? assistantResponseText(
                  /** @type {{ data: import("../model-gateway/protocol.ts").NormalizedGatewayResponse }} */ (response).data
                )
                : finalOutput
            )
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
        if (!outputHealth.ok && outputHealth.mustRetry) {
          return finishIncompleteAssistantResponse({
            session,
            sessionStore,
            metadata,
            eventOptions,
            round: round + 1,
            outputHealth,
            options
          });
        }
      }
      if (!session.goal?.enabled) {
        const workflowSync = syncWorkflowCompletionOnFinal(session.workflow, finalOutput);
        if (workflowSync.changed) {
          await emitEvent(eventOptions, {
            type: "workflow_updated",
            reason: "assistant_final_sync",
            todosCompleted: workflowSync.todosCompleted,
            planStepsCompleted: workflowSync.planStepsCompleted
          });
        }
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
      thinking: thinkingForRound(thinkingCapture, round + 1, response.data),
      ...(Array.isArray(response.data.responseItems) && response.data.responseItems.length > 0
        ? { responseItems: response.data.responseItems }
        : {})
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
        reason: "after_tool_execution"
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
 * @param {AgentSession} session
 * @param {string} prompt
 */
