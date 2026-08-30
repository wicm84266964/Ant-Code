import { createWorkflowState } from "../tools/workflow-tools.ts";
import { flattenValidationSuggestions, summarizeValidationSuggestionTiers, type ValidationSuggestion } from "./validation-suggestions.ts";

export type ValidationMemoryRow = {
  id: string;
  command: string;
  passed: boolean;
  failed: boolean;
  timedOut: boolean;
  exitCode: number | null;
  durationMs: number | null;
  recordedAt: string;
  stale: boolean;
};

export type ValidationMemory = {
  suggestions: ValidationSuggestion[];
  suggestionTiers: { minimal: number; related: number; full: number };
  ran: ValidationMemoryRow[];
  passed: ValidationMemoryRow[];
  failed: ValidationMemoryRow[];
  pending: ValidationSuggestion[];
  stale: ValidationMemoryRow[];
  latestChangeAt: string | null;
  summary: {
    suggested: number;
    ran: number;
    passed: number;
    failed: number;
    pending: number;
    stale: number;
  };
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * @param {{ workflow?: ReturnType<typeof createWorkflowState> | null; suggestions?: Array<Record<string, any>> }} input
 */
export function buildValidationMemory(input: { workflow?: ReturnType<typeof createWorkflowState> | null; suggestions?: unknown } = {}): ValidationMemory {
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
export function formatValidationMemory(memory: ValidationMemory, options: { includeSuggestions?: boolean; includeHistory?: boolean; maxItems?: number } = {}) {
  const maxItems = typeof options.maxItems === "number" && Number.isFinite(options.maxItems) ? options.maxItems : 6;
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

function normalizeValidation(validation: unknown, latestChangeAt: string | null): ValidationMemoryRow {
  const record = asRecord(validation);
  const command = String(record.command ?? "");
  const recordedAt = typeof record.recordedAt === "string" ? record.recordedAt : "";
  const stale = Boolean(latestChangeAt && recordedAt && Date.parse(recordedAt) < Date.parse(latestChangeAt));
  return {
    id: String(record.id ?? ""),
    command,
    passed: record.passed === true,
    failed: record.passed === false,
    timedOut: Boolean(record.timedOut),
    exitCode: finiteNumber(record.exitCode),
    durationMs: finiteNumber(record.durationMs),
    recordedAt,
    stale
  };
}

function unresolvedFailures(validations: ValidationMemoryRow[]): ValidationMemoryRow[] {
  let laterPassingValidation = false;
  const failures: ValidationMemoryRow[] = [];
  for (let index = validations.length - 1; index >= 0; index -= 1) {
    const validation = validations[index];
    if (!validation || !validation.command) {
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

function formatValidationState(validation: ValidationMemoryRow) {
  const state = validation.passed ? "passed" : "failed";
  const stale = validation.stale ? ", stale" : "";
  const timeout = validation.timedOut ? ", timed out" : "";
  const exit = validation.exitCode ?? "null";
  const duration = validation.durationMs ?? "unknown";
  return `[${state}${stale}${timeout}] ${validation.command} (exit=${exit}, ${duration}ms)`;
}

function latestTimestamp(items: unknown): string | null {
  const list = Array.isArray(items) ? items : [];
  const timestamps = list
    .map((item) => {
      const recordedAt = asRecord(item).recordedAt;
      return typeof recordedAt === "string" ? recordedAt : null;
    })
    .filter((value): value is string => Boolean(value))
    .map((value) => ({ value, time: Date.parse(value) }))
    .filter((item) => Number.isFinite(item.time))
    .sort((a, b) => b.time - a.time);
  return timestamps[0]?.value ?? null;
}
