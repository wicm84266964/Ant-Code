type AgentContract = {
  type: string;
  required: string[];
  optional?: string[];
};

export const AGENT_CONTRACTS: Readonly<Record<string, AgentContract>> = Object.freeze({
  findings: {
    type: "findings",
    required: ["summary", "evidence", "confidence", "openQuestions", "nextAction"]
  },
  research: {
    type: "research",
    required: ["answer", "sources", "confidence", "caveats"]
  },
  plan: {
    type: "plan",
    required: ["goal", "assumptions", "stages", "handoff"]
  },
  "plan-package": {
    type: "plan-package",
    required: ["requirementsDoc", "taskPlanDoc", "executionChecklist", "traceabilityMap", "handoffPrompt"],
    optional: ["confirmationRequired", "clarificationQuestions", "reviewGates"]
  },
  patch: {
    type: "patch",
    required: ["summary", "changedFiles", "validation", "remainingRisks", "needsParentAction"]
  },
  verification: {
    type: "verification",
    required: ["commands", "result", "failureAnalysis", "recommendedNextFix"]
  },
  review: {
    type: "review",
    required: ["verdict", "findings", "missingTests", "residualRisks"]
  },
  partial: {
    type: "partial",
    required: ["status", "completed", "evidence", "remaining", "recommendedContinuationPrompt", "stateHints"]
  },
  summary: {
    type: "summary",
    required: ["summary", "evidence", "risks", "nextSteps"]
  }
});

/**
 * @param {unknown} value
 */
export function normalizeOutputContract(value: unknown) {
  if (!value) {
    return null;
  }
  if (typeof value === "string") {
    return cloneContract(AGENT_CONTRACTS[value] ?? { type: value, required: ["summary"] });
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const item = value as Record<string, unknown>;
    const type = String(item.type ?? "summary");
    return {
      type,
      required: normalizeStringArray(item.required, AGENT_CONTRACTS[type]?.required ?? ["summary"]),
      optional: normalizeStringArray(item.optional, [])
    };
  }
  return null;
}

/**
 * @param {Record<string, any> | null | undefined} profile
 */
export function resolveProfileContract(profile: Record<string, unknown> | null | undefined) {
  return normalizeOutputContract(profile?.outputContract)
    ?? normalizeOutputContract(profile?.purpose)
    ?? AGENT_CONTRACTS.summary;
}

/**
 * @param {unknown} value
 */
export function formatOutputContract(value: unknown) {
  const contract = normalizeOutputContract(value) ?? AGENT_CONTRACTS.summary;
  const required = contract.required.length > 0 ? contract.required.join(", ") : "summary";
  const optional = contract.optional?.length ? ` optional=${contract.optional.join(", ")}` : "";
  return `- type=${contract.type} required=${required}${optional}. Use concise section headings and stable field names.`;
}

/**
 * @param {unknown} text
 * @param {unknown} contractValue
 */
export function summarizeContractResult(text: string, contractValue: unknown) {
  const contract = normalizeOutputContract(contractValue) ?? AGENT_CONTRACTS.summary;
  const value = String(text ?? "").trim();
  if (!value) {
    return {
      type: contract.type,
      summary: "",
      parsed: null
    };
  }
  const parsed = parseJsonObject(value);
  if (parsed) {
    return {
      type: contract.type,
      summary: summarizeObject(parsed, contract.required),
      parsed
    };
  }
  return {
    type: contract.type,
    summary: value.split(/\r?\n/).filter(Boolean).slice(0, 8).join("\n"),
    parsed: null
  };
}

function cloneContract(contract: AgentContract): AgentContract {
  return {
    type: contract.type,
    required: [...(contract.required ?? ["summary"])],
    optional: [...(contract.optional ?? [])]
  };
}

function normalizeStringArray(value: unknown, fallback: string[]): string[] {
  if (Array.isArray(value)) {
    const result = value.map(String).map((item) => item.trim()).filter(Boolean);
    return result.length > 0 ? result : [...fallback];
  }
  if (typeof value === "string") {
    const result = value.split(",").map((item) => item.trim()).filter(Boolean);
    return result.length > 0 ? result : [...fallback];
  }
  return [...fallback];
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  const trimmed = String(value ?? "").trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function summarizeObject(value: Record<string, unknown>, keys: string[]): string {
  const lines: string[] = [];
  for (const key of keys) {
    if (value[key] === undefined || value[key] === null) {
      continue;
    }
    lines.push(`${key}: ${truncate(JSON.stringify(value[key]), 240)}`);
  }
  return lines.join("\n") || truncate(JSON.stringify(value), 1000);
}

function truncate(value: unknown, max: number): string {
  const text = String(value ?? "");
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3))}...`;
}
