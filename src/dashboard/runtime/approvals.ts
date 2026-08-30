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

import {
  DEFAULT_INTERRUPT_FORCE_SETTLE_MS
} from "./types.ts";
import type {
  DashboardActiveSessionState
} from "./types.ts";
import {
  appendBackgroundSubagentSnapshot
} from "./background.ts";
import {
  sessionStatusSummary
} from "./session-model.ts";
import {
  queueSnapshot
} from "./turn-queue.ts";
import {
  appendDashboardEvent,
  asRecord,
  eventId,
  isPlainObject
} from "./util.ts";


export function requestTurnInterrupt(state: DashboardActiveSessionState, reason: string) {
  if (state.disposed || !state.running) {
    return false;
  }
  state.interrupting = true;
  state.status = "interrupting";
  appendDashboardEvent(state, {
    type: "turn_interrupt_requested",
    id: eventId("interrupt"),
    reason,
    queue: queueSnapshot(state),
    interrupting: true,
    at: new Date().toISOString()
  });
  cancelPendingInteractions(state, reason);
  if (state.controller && !state.controller.signal.aborted) {
    state.controller.abort(reason);
  }
  scheduleForceSettleInterruptedTurn(state, reason);
  return true;
}


export function scheduleForceSettleInterruptedTurn(state: DashboardActiveSessionState, reason: string) {
  clearForceSettleTimer(state);
  const turnId = state.currentTurnId;
  if (!state.running || !turnId) {
    return;
  }
  const delayMs = interruptForceSettleMs(state.turnEnv);
  state.forceSettleTimer = setTimeout(() => {
    if (!state.running || state.currentTurnId !== turnId) {
      return;
    }
    forceSettleInterruptedTurn(state, reason, turnId);
  }, delayMs);
  state.forceSettleTimer.unref?.();
}


export function interruptForceSettleMs(env: NodeJS.ProcessEnv | null | undefined = process.env) {
  const value = Number(env?.ANT_CODE_INTERRUPT_FORCE_SETTLE_MS ?? DEFAULT_INTERRUPT_FORCE_SETTLE_MS);
  if (!Number.isFinite(value)) {
    return DEFAULT_INTERRUPT_FORCE_SETTLE_MS;
  }
  return Math.max(50, Math.min(30000, Math.trunc(value)));
}


export function clearForceSettleTimer(state: DashboardActiveSessionState) {
  if (state.forceSettleTimer) {
    clearTimeout(state.forceSettleTimer);
    state.forceSettleTimer = null;
  }
}


export function forceSettleInterruptedTurn(state: DashboardActiveSessionState, reason: string, turnId: unknown) {
  state.forceSettleTimer = null;
  if (!state.running || state.currentTurnId !== turnId || state.disposed) {
    return;
  }
  state.quarantinedTurnId = turnId;
  state.interrupting = false;
  state.status = "quarantined";
  if (state.controller && !state.controller.signal.aborted) {
    state.controller.abort(reason);
  }
  cancelPendingInteractions(state, reason);
  appendDashboardEvent(state, {
    type: "error",
    id: eventId("error"),
    message: "中断请求已发出，但底层执行未及时结束；会话已隔离，不会启动排队任务。",
    turnId,
    interrupted: true,
    quarantined: true,
    at: new Date().toISOString()
  });
  void appendBackgroundSubagentSnapshot(state);
  appendDashboardEvent(state, {
    type: "run_state",
    id: eventId("run-state"),
    running: true,
    interrupting: false,
    quarantined: true,
    turnId,
    queue: queueSnapshot(state),
    sessionStatus: sessionStatusSummary(state.session),
    changeStats: { ...state.turnChangeStats },
    forced: true,
    at: new Date().toISOString()
  });
}


export function cancelPendingInteractions(state: DashboardActiveSessionState, reason: string) {
  for (const [approvalId, pending] of Array.from(state.pendingApprovals.entries())) {
    state.pendingApprovals.delete(approvalId);
    appendDashboardEvent(state, {
      type: "approval_resolved",
      id: eventId("approval-resolved"),
      approvalId,
      action: reason,
      allowed: false,
      interrupted: true,
      at: new Date().toISOString()
    });
    pending.resolve(false);
  }
  for (const [questionId, pending] of Array.from(state.pendingQuestions.entries())) {
    state.pendingQuestions.delete(questionId);
    const result = normalizeQuestionAnswer({ cancelled: true }, pending.question);
    appendDashboardEvent(state, {
      type: "question_resolved",
      id: eventId("question-resolved"),
      questionId,
      answer: result.answer,
      selectedChoice: result.selectedChoice,
      selectedChoices: result.selectedChoices,
      cancelled: true,
      interrupted: true,
      at: new Date().toISOString()
    });
    pending.resolve(result);
  }
}


export function askQuestion(state: DashboardActiveSessionState, request: Record<string, unknown>) {
  if (state.session?.goal?.enabled) {
    const skipped = goalUnattendedQuestionResult();
    appendDashboardEvent(state, {
      type: "goal_question_skipped",
      id: eventId("goal-question-skipped"),
      reason: skipped.reason,
      question: {
        prompt: String(request?.question ?? request?.prompt ?? "").slice(0, 240)
      },
      at: new Date().toISOString()
    });
    return skipped;
  }
  const questionId = eventId("question");
  const payload = normalizeQuestionRequest(request, questionId);
  const promise = new Promise((resolve: (result: unknown) => void) => {
    state.pendingQuestions.set(questionId, { resolve, question: payload });
  });
  appendDashboardEvent(state, {
    type: "question_required",
    id: questionId,
    question: payload,
    at: payload.at
  });
  return promise;
}


export function askApproval(state: DashboardActiveSessionState, request: Record<string, unknown>) {
  const approvalKey = approvalKeyFor({
    toolName: String(request.toolName ?? ""),
    input: asRecord(request.input),
    decision: asRecord(request.decision),
    definition: asRecord(request.definition)
  });
  if (state.sessionApprovals.has(approvalKey)) {
    appendDashboardEvent(state, {
      type: "approval_auto_allowed",
      id: eventId("approval-auto"),
      title: "已按本会话批准继续",
      approvalKey,
      at: new Date().toISOString()
    });
    return true;
  }
  const approvalId = eventId("approval");
  const payload = {
    id: approvalId,
    toolName: request.toolName,
    risk: asRecord(request.definition).risk ?? "unknown",
    reason: asRecord(request.decision).reason ?? "需要确认后继续",
    sensitive: asRecord(request.decision).sensitive === true,
    outsideWorkspace: asRecord(request.decision).outsideWorkspace === true,
    preview: buildApprovalPreview(request),
    input: sanitizeApprovalInput(request.input ?? {}),
    decision: request.decision ?? {},
    approvalKey,
    at: new Date().toISOString()
  };
  appendDashboardEvent(state, {
    type: "approval_required",
    id: approvalId,
    approval: payload,
    activity: permissionRequestToActivity(request),
    at: payload.at
  });
  return new Promise((resolve: (allowed: boolean) => void) => {
    state.pendingApprovals.set(approvalId, { resolve, approvalKey });
  });
}


export function appendWorkflowSnapshot(state: DashboardActiveSessionState, reason: string) {
  const workflow = cloneWorkflowState(state.session.workflow);
  const hasItems = workflow.todos.length > 0 || workflow.plan.steps.length > 0;
  if (!hasItems) {
    return;
  }
  appendDashboardEvent(state, {
    type: "workflow_snapshot",
    id: eventId("workflow"),
    reason,
    workflow,
    summary: summarizeWorkflowSnapshot(workflow),
    at: new Date().toISOString()
  });
}


export function summarizeWorkflowSnapshot(workflow: { todos?: Array<{ status?: string }>; plan?: { steps?: Array<{ status?: string }> } } | null | undefined) {
  const items = [...(workflow?.todos ?? []), ...(workflow?.plan?.steps ?? [])];
  return {
    total: items.length,
    pending: items.filter((item) => item.status === "pending").length,
    in_progress: items.filter((item) => item.status === "in_progress").length,
    completed: items.filter((item) => item.status === "completed").length,
    cancelled: items.filter((item) => item.status === "cancelled").length
  };
}


export function sanitizeApprovalInput(input: unknown) {
  return sanitizeSensitiveValue(asRecord(input), { maxStringLength: 500 });
}


export function normalizeQuestionRequest(request: Record<string, unknown>, id: string) {
  const choices = Array.isArray(request?.choices)
    ? request.choices.map(normalizeQuestionChoice).filter((choice): choice is NonNullable<typeof choice> => Boolean(choice))
    : [];
  return {
    id,
    header: String(request?.header ?? "需求核对"),
    question: String(request?.question ?? request?.prompt ?? "请确认需求"),
    choices,
    multiple: Boolean(request?.multiple || request?.selectionMode === "multi"),
    allowCustom: choices.length === 0 || request?.allowCustom !== false,
    confirmLabel: String(request?.confirmLabel ?? "确认"),
    at: new Date().toISOString()
  };
}


export function normalizeQuestionChoice(choice: unknown): { label: string; value: string; description?: string; selected: boolean } | null {
  if (typeof choice === "string") {
    const label = choice.trim();
    return label ? { label, value: label, selected: false } : null;
  }
  if (!isPlainObject(choice)) {
    return null;
  }
  const label = String(choice.label ?? choice.text ?? choice.value ?? "").trim();
  if (!label) {
    return null;
  }
  return {
    label,
    value: String(choice.value ?? label),
    description: typeof choice.description === "string" ? choice.description : "",
    selected: choice.selected === true
  };
}


export function normalizeQuestionAnswer(answer: unknown, question: unknown) {
  const questionRecord = isPlainObject(question) ? question : {};
  const answerRecord = isPlainObject(answer) ? answer : {};
  const choices = Array.isArray(questionRecord.choices) ? questionRecord.choices : [];
  const cancelled = answerRecord.cancelled === true;
  if (cancelled) {
    return {
      answer: "",
      selectedChoice: null,
      selectedChoices: [],
      customAnswer: null,
      cancelled: true,
      workflowReminder: null
    };
  }
  const selectedValues = Array.isArray(answerRecord.selectedChoices)
    ? answerRecord.selectedChoices.map(String)
    : typeof answerRecord.selectedChoice === "string"
      ? [answerRecord.selectedChoice]
      : [];
  const selectedChoices = selectedValues
    .map((value) => {
      const match = choices.find((choice) => isPlainObject(choice) && (choice.value === value || choice.label === value));
      return isPlainObject(match) ? String(match.label ?? value) : value;
    })
    .filter(Boolean);
  const customAnswer = String(answerRecord.customAnswer ?? answerRecord.answer ?? "").trim();
  const resolvedAnswer = customAnswer || selectedChoices.join(", ");
  return {
    answer: resolvedAnswer,
    selectedChoice: selectedChoices[0] ?? null,
    selectedChoices,
    customAnswer: customAnswer || null,
    cancelled: false,
    workflowReminder: choices.length > 0
      ? "If this confirmation starts multi-step work, update the visible workflow state with todo_write and/or plan_update. Before the final response, mark completed visible items as completed."
      : null
  };
}
