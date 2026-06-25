import { createWorkflowState, summarizeWorkflow } from "../tools/workflow-tools.js";
import { buildTaskLifecycle, formatLifecycleLine } from "./task-lifecycle.js";
import { buildValidationMemory } from "./validation-memory.js";

const MAX_HINT_COMMAND_CHARS = 180;

/**
 * @param {{ workflow?: ReturnType<typeof createWorkflowState> | null; sessionInfo?: Record<string, any>; validationSuggestions?: Array<{ command: string; reason: string }> }} input
 */
export function buildDeliveryStatus(input = {}) {
  const workflow = input.workflow ?? createWorkflowState();
  const summary = summarizeWorkflow(workflow);
  const validations = Array.isArray(workflow.validations) ? workflow.validations : [];
  const latestValidation = validations.at(-1) ?? null;
  const unresolvedFailures = getUnresolvedFailures(validations);
  const lifecycle = buildTaskLifecycle({ workflow, latestValidation, unresolvedFailures });
  const state = lifecycle.state;
  const validationSuggestions = normalizeSuggestions(input.validationSuggestions);
  const validationMemory = buildValidationMemory({ workflow, suggestions: validationSuggestions });
  const nextActions = buildNextActions(lifecycle.stage, latestValidation, summary, validationSuggestions);

  return {
    state,
    lifecycle,
    sessionId: input.sessionInfo?.id ?? null,
    turnCount: input.sessionInfo?.turnCount ?? null,
    summary,
    latestValidation: latestValidation
      ? {
          passed: latestValidation.passed === true,
          exitCode: latestValidation.exitCode ?? null,
          timedOut: Boolean(latestValidation.timedOut),
          durationMs: Number.isFinite(latestValidation.durationMs) ? latestValidation.durationMs : null,
          command: typeof latestValidation.command === "string" ? latestValidation.command : ""
        }
      : null,
    unresolvedFailures,
    validationSuggestions,
    validationMemory,
    nextActions
  };
}

/**
 * @param {ReturnType<typeof buildDeliveryStatus>} status
 * @param {{ includeHeader?: boolean; includeCommands?: boolean; includeSuggestions?: boolean }} options
 */
export function formatDeliveryStatus(status, options = {}) {
  const lines = [];
  if (options.includeHeader !== false) {
    lines.push("Ant Code delivery status");
  }

  lines.push(
    `state: ${status.state}`,
    formatLifecycleLine(status.lifecycle),
    `todos: ${formatStatusCounts(status.summary.todos)}`,
    `plan: ${formatStatusCounts(status.summary.planSteps)}`,
    `changes: total=${status.summary.changes.total}, created=${status.summary.changes.created}, edited=${status.summary.changes.edited}`,
    `validation: total=${status.summary.validations.total}, passed=${status.summary.validations.passed}, failed=${status.summary.validations.failed}, timedOut=${status.summary.validations.timedOut}`,
    `validation memory: pending=${status.validationMemory.summary.pending}, stale=${status.validationMemory.summary.stale}, unresolved=${status.validationMemory.summary.failed}`
  );

  if (status.latestValidation) {
    const command = options.includeCommands && status.latestValidation.command
      ? `, command=${truncate(status.latestValidation.command, MAX_HINT_COMMAND_CHARS)}`
      : "";
    lines.push(`latest validation: ${status.latestValidation.passed ? "passed" : "failed"} exit=${status.latestValidation.exitCode ?? "null"}${status.latestValidation.timedOut ? " timed-out" : ""}${command}`);
  }

  if (options.includeSuggestions !== false && status.validationSuggestions?.length > 0) {
    lines.push("suggested validation:");
    lines.push(...status.validationSuggestions.slice(0, 3).map((item, index) => `${index + 1}. ${item.command} - ${item.reason}`));
  }

  if (status.nextActions.length > 0) {
    lines.push("next:");
    lines.push(...status.nextActions.map((action) => `- ${action}`));
  }

  return lines.join("\n");
}

/**
 * @param {ReturnType<typeof buildDeliveryStatus>} status
 */
export function formatTurnFooter(status) {
  if (status.state === "idle") {
    return "";
  }

  const validation = status.summary.validations.total > 0
    ? `validations ${status.summary.validations.passed}/${status.summary.validations.total} passed`
    : "no validations";
  const parts = [
    `state=${status.state}`,
    `stage=${status.lifecycle.stage}`,
    `changes=${status.summary.changes.total}`,
    validation
  ];
  const next = status.nextActions[0] ? `\nnext: ${status.nextActions[0]}` : "";

  return [
    "",
    "Ant Code status",
    parts.join(" | "),
    next.trimEnd()
  ].filter(Boolean).join("\n");
}

/**
 * @param {string} stage
 * @param {Record<string, any> | null} latestValidation
 * @param {Record<string, any>} summary
 * @param {Array<{ command: string; reason: string }>} suggestions
 */
function buildNextActions(stage, latestValidation, summary, suggestions) {
  const suggested = suggestions[0]?.command;
  if (stage === "repair") {
    const actions = ["Repair the failed validation before reporting completion."];
    if (latestValidation?.command) {
      actions.push(`Rerun with /verify run ${truncate(latestValidation.command, MAX_HINT_COMMAND_CHARS)}`);
    } else if (suggested) {
      actions.push(`Rerun with /verify run ${truncate(suggested, MAX_HINT_COMMAND_CHARS)}`);
    } else {
      actions.push("Rerun the relevant check with /verify run <command>.");
    }
    return actions;
  }
  if (stage === "validate") {
    return [suggested
      ? `Run /verify run ${truncate(suggested, MAX_HINT_COMMAND_CHARS)} for the changed code, then use /report when it passes.`
      : "Run /verify suggest, then /verify run <command> for the changed code."];
  }
  if (stage === "ready" && summary.changes.total > 0) {
    return ["Use /report for a delivery summary or /review for diff details."];
  }
  if (stage === "edit") {
    return [suggested
      ? `Continue the active plan, then validate with /verify run ${truncate(suggested, MAX_HINT_COMMAND_CHARS)}.`
      : "Continue the active plan, then use /verify suggest to choose a validation command."];
  }
  if (stage === "plan") {
    return ["Confirm the plan, mark the active step in progress, then edit."];
  }
  if (stage === "inspect") {
    return ["Inspect relevant files before planning or editing."];
  }
  return [];
}

/**
 * @param {unknown} suggestions
 */
function normalizeSuggestions(suggestions) {
  if (!Array.isArray(suggestions)) {
    return [];
  }
  return suggestions.map((item) => ({
    command: typeof item?.command === "string" ? item.command : "",
    reason: typeof item?.reason === "string" ? item.reason : "",
    tier: typeof item?.tier === "string" ? item.tier : "related",
    source: typeof item?.source === "string" ? item.source : "",
    confidence: typeof item?.confidence === "string" ? item.confidence : "",
    relatedFiles: Array.isArray(item?.relatedFiles) ? item.relatedFiles.map(String) : []
  })).filter((item) => item.command.length > 0);
}

/**
 * @param {Array<Record<string, any>>} validations
 */
function getUnresolvedFailures(validations) {
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

/**
 * @param {Record<string, any>} summary
 */
function formatStatusCounts(summary) {
  return `total=${summary.total}, pending=${summary.pending}, in_progress=${summary.in_progress}, completed=${summary.completed}`;
}

/**
 * @param {string} value
 * @param {number} max
 */
function truncate(value, max) {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}
