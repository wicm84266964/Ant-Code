import { createWorkflowState } from "../tools/workflow-tools.js";
import { flattenValidationSuggestions, summarizeValidationSuggestionTiers } from "./validation-suggestions.js";

/**
 * @param {{ workflow?: ReturnType<typeof createWorkflowState> | null; suggestions?: Array<Record<string, any>> }} input
 */
export function buildValidationMemory(input = {}) {
  const workflow = input.workflow ?? createWorkflowState();
  const suggestions = flattenValidationSuggestions(input.suggestions ?? []);
  const validations = Array.isArray(workflow.validations) ? workflow.validations : [];
  const changes = Array.isArray(workflow.changes) ? workflow.changes : [];
  const latestChangeAt = latestTimestamp(changes);
  const validationRows = validations.map((validation) => normalizeValidation(validation, latestChangeAt));
  const freshRanCommands = new Set(validationRows
    .filter((validation) => !validation.stale)
    .map((validation) => validation.command));
  const pending = suggestions.filter((item) => !freshRanCommands.has(item.command));
  const failed = unresolvedFailures(validationRows);
  const passed = validationRows.filter((validation) => validation.passed);
  const stale = validationRows.filter((validation) => validation.stale);

  return {
    suggestions,
    suggestionTiers: summarizeValidationSuggestionTiers(suggestions),
    ran: validationRows,
    passed,
    failed,
    pending,
    stale,
    latestChangeAt,
    summary: {
      suggested: suggestions.length,
      ran: validationRows.length,
      passed: passed.length,
      failed: failed.length,
      pending: pending.length,
      stale: stale.length
    }
  };
}

/**
 * @param {ReturnType<typeof buildValidationMemory>} memory
 * @param {{ includeSuggestions?: boolean; includeHistory?: boolean; maxItems?: number }} options
 */
export function formatValidationMemory(memory, options = {}) {
  const maxItems = Number.isFinite(options.maxItems) ? options.maxItems : 6;
  const lines = [
    "Validation memory",
    `summary: suggested=${memory.summary.suggested}, ran=${memory.summary.ran}, passed=${memory.summary.passed}, failed=${memory.summary.failed}, pending=${memory.summary.pending}, stale=${memory.summary.stale}`,
    `tiers: minimal=${memory.suggestionTiers.minimal}, related=${memory.suggestionTiers.related}, full=${memory.suggestionTiers.full}`
  ];

  if (memory.latestChangeAt) {
    lines.push(`latest change: ${memory.latestChangeAt}`);
  }

  if (memory.failed.length > 0) {
    lines.push("failed:");
    lines.push(...memory.failed.slice(0, maxItems).map((item) => `- ${formatValidationState(item)}`));
  }

  if (memory.stale.length > 0) {
    lines.push("stale:");
    lines.push(...memory.stale.slice(0, maxItems).map((item) => `- ${formatValidationState(item)}`));
  }

  if (options.includeSuggestions !== false && memory.pending.length > 0) {
    lines.push("pending suggestions:");
    lines.push(...memory.pending.slice(0, maxItems).map((item) => `- [${item.tier ?? "related"}] ${item.command} - ${item.reason}`));
  }

  if (options.includeHistory !== false) {
    if (memory.ran.length === 0) {
      lines.push("history: none");
    } else {
      lines.push("history:");
      lines.push(...memory.ran.slice(-maxItems).map((item) => `- ${formatValidationState(item)}`));
    }
  }

  return lines.join("\n");
}

function normalizeValidation(validation, latestChangeAt) {
  const command = String(validation?.command ?? "");
  const recordedAt = typeof validation?.recordedAt === "string" ? validation.recordedAt : "";
  const stale = Boolean(latestChangeAt && recordedAt && Date.parse(recordedAt) < Date.parse(latestChangeAt));
  return {
    id: String(validation?.id ?? ""),
    command,
    passed: validation?.passed === true,
    failed: validation?.passed === false,
    timedOut: Boolean(validation?.timedOut),
    exitCode: Number.isFinite(validation?.exitCode) ? validation.exitCode : null,
    durationMs: Number.isFinite(validation?.durationMs) ? validation.durationMs : null,
    recordedAt,
    stale
  };
}

function unresolvedFailures(validations) {
  let laterPassingValidation = false;
  const failures = [];
  for (let index = validations.length - 1; index >= 0; index -= 1) {
    const validation = validations[index];
    if (!validation.command) {
      continue;
    }
    if (validation.passed) {
      laterPassingValidation = true;
      continue;
    }
    if (validation.failed && !laterPassingValidation) {
      failures.unshift(validation);
    }
  }
  return failures;
}

function formatValidationState(validation) {
  const state = validation.passed ? "passed" : "failed";
  const stale = validation.stale ? ", stale" : "";
  const timeout = validation.timedOut ? ", timed out" : "";
  const exit = validation.exitCode ?? "null";
  const duration = validation.durationMs ?? "unknown";
  return `[${state}${stale}${timeout}] ${validation.command} (exit=${exit}, ${duration}ms)`;
}

function latestTimestamp(items) {
  const timestamps = items
    .map((item) => typeof item.recordedAt === "string" ? item.recordedAt : null)
    .filter(Boolean)
    .map((value) => ({ value, time: Date.parse(value) }))
    .filter((item) => Number.isFinite(item.time))
    .sort((a, b) => b.time - a.time);
  return timestamps[0]?.value ?? null;
}
