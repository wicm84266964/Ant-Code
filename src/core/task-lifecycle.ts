import { createWorkflowState, summarizeWorkflow } from "../tools/workflow-tools.ts";

/**
 * @param {{ workflow?: ReturnType<typeof createWorkflowState> | null; latestValidation?: Record<string, any> | null; unresolvedFailures?: number }} input
 */
export function buildTaskLifecycle(input: { workflow?: ReturnType<typeof createWorkflowState> | null; latestValidation?: Record<string, unknown> | null; unresolvedFailures?: number } = {}) {
  const workflow = input.workflow ?? createWorkflowState();
  const summary = summarizeWorkflow(workflow);
  const changes = Array.isArray(workflow.changes) ? workflow.changes : [];
  const validations = Array.isArray(workflow.validations) ? workflow.validations : [];
  const latestValidation = input.latestValidation ?? validations.at(-1) ?? null;
  const unresolvedFailures = typeof input.unresolvedFailures === "number" && Number.isFinite(input.unresolvedFailures)
    ? input.unresolvedFailures
    : countUnresolvedFailures(validations);
  const latestChangeAt = latestTimestamp(changes);
  const latestValidationAt = latestTimestamp(validations);
  const validationFresh = isValidationFresh({
    changes,
    latestChangeAt,
    latestValidation,
    latestValidationAt
  });
  const stage = determineStage({
    summary,
    latestValidation,
    unresolvedFailures,
    validationFresh
  });

  return {
    stage,
    state: stateForStage(stage),
    validationFresh,
    latestChangeAt,
    latestValidationAt,
    hasChanges: summary.changes.total > 0,
    hasPlan: summary.planSteps.total > 0 || summary.todos.total > 0,
    activeItems: summary.planSteps.pending + summary.planSteps.in_progress + summary.todos.pending + summary.todos.in_progress,
    summary
  };
}

/**
 * @param {string} stage
 */
export function stateForStage(stage: string) {
  if (stage === "repair") {
    return "blocked";
  }
  if (stage === "validate") {
    return "needs_validation";
  }
  if (stage === "ready") {
    return "verified";
  }
  if (stage === "plan" || stage === "edit") {
    return "in_progress";
  }
  return "idle";
}

/**
 * @param {ReturnType<typeof buildTaskLifecycle>} lifecycle
 */
export function formatLifecycleLine(lifecycle: ReturnType<typeof buildTaskLifecycle>) {
  const freshness = lifecycle.latestValidationAt
    ? `validationFresh=${lifecycle.validationFresh}`
    : "validationFresh=unknown";
  return `stage: ${lifecycle.stage} (${freshness})`;
}

/**
 * @param {{ summary: Record<string, any>; latestValidation: Record<string, any> | null; unresolvedFailures: number; validationFresh: boolean }} input
 */
function determineStage(input: {
  summary: ReturnType<typeof summarizeWorkflow>;
  latestValidation: Record<string, unknown> | null;
  unresolvedFailures: number;
  validationFresh: boolean;
}) {
  if (input.unresolvedFailures > 0) {
    return "repair";
  }
  if (input.summary.changes.total > 0) {
    if (input.latestValidation?.passed === true && input.validationFresh) {
      return "ready";
    }
    return "validate";
  }
  if (input.latestValidation?.passed === true) {
    return "ready";
  }
  if (input.summary.planSteps.in_progress > 0 || input.summary.todos.in_progress > 0) {
    return "edit";
  }
  if (input.summary.planSteps.total > 0 || input.summary.todos.total > 0) {
    return "plan";
  }
  return "inspect";
}

/**
 * @param {{ changes: Array<Record<string, any>>; latestChangeAt: string | null; latestValidation: Record<string, any> | null; latestValidationAt: string | null }} input
 */
function isValidationFresh(input: { changes: Array<Record<string, unknown>>; latestChangeAt: string | null; latestValidation: Record<string, unknown> | null; latestValidationAt: string | null }) {
  if (input.latestValidation?.passed !== true) {
    return false;
  }
  if (input.changes.length === 0) {
    return true;
  }
  if (!input.latestChangeAt || !input.latestValidationAt) {
    return true;
  }
  return Date.parse(input.latestValidationAt) >= Date.parse(input.latestChangeAt);
}

/**
 * @param {Array<Record<string, any>>} items
 */
function latestTimestamp(items: Array<Record<string, unknown>>) {
  const timestamps = items
    .map((item) => typeof item.recordedAt === "string" ? item.recordedAt : null)
    .filter((value): value is string => typeof value === "string")
    .map((value) => ({ value, time: Date.parse(value) }))
    .filter((item) => Number.isFinite(item.time))
    .sort((left, right) => right.time - left.time);
  return timestamps[0]?.value ?? null;
}

/**
 * @param {Array<Record<string, any>>} validations
 */
function countUnresolvedFailures(validations: Array<Record<string, unknown>>) {
  let count = 0;
  for (let index = validations.length - 1; index >= 0; index -= 1) {
    const validation = validations[index];
    if (validation?.passed === true) {
      break;
    }
    count += 1;
  }
  return count;
}
