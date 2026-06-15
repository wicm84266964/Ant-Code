/**
 * @param {{ query: string; profile?: Record<string, any>; routeDecision?: Record<string, any>; contextPack?: Record<string, any>; writeScope?: unknown; acceptance?: unknown; constraints?: unknown; knownFacts?: unknown; filesOfInterest?: unknown; doNotTouch?: unknown; cwd?: string }} options
 */
export function buildContextPack(options) {
  const input = options.contextPack && typeof options.contextPack === "object" ? options.contextPack : {};
  return compactObject({
    task: stringOr(input.task, options.query),
    userIntent: stringOr(input.userIntent, options.query),
    workspace: options.cwd ? String(options.cwd) : undefined,
    profile: options.profile?.name,
    purpose: options.routeDecision?.purpose ?? options.profile?.purpose,
    difficulty: options.routeDecision?.difficulty,
    risk: options.routeDecision?.risk,
    constraints: stringList(input.constraints ?? options.constraints),
    knownFacts: stringList(input.knownFacts ?? options.knownFacts),
    filesOfInterest: stringList(input.filesOfInterest ?? options.filesOfInterest),
    doNotTouch: stringList(input.doNotTouch ?? options.doNotTouch),
    writeScope: stringList(input.writeScope ?? options.writeScope),
    acceptance: stringList(input.acceptance ?? options.acceptance),
    returnFormat: input.returnFormat ?? options.profile?.outputContract?.type ?? options.profile?.purpose
  });
}

/**
 * @param {Record<string, any>} contextPack
 */
export function formatContextPack(contextPack) {
  if (!contextPack || typeof contextPack !== "object") {
    return "- No additional context pack supplied.";
  }
  const lines = [];
  for (const [key, value] of Object.entries(contextPack)) {
    if (Array.isArray(value)) {
      lines.push(`${key}: ${value.length ? value.join("; ") : "[]"}`);
    } else {
      lines.push(`${key}: ${String(value)}`);
    }
  }
  return lines.map((item) => `- ${item}`).join("\n");
}

/**
 * @param {Record<string, any>} contextPack
 */
export function hasWriteScope(contextPack) {
  return Array.isArray(contextPack?.writeScope) && contextPack.writeScope.length > 0;
}

function stringOr(...values) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) {
      return text;
    }
  }
  return "";
}

function stringList(value) {
  if (Array.isArray(value)) {
    return value.map(String).map((item) => item.trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => {
    if (item === undefined || item === null) {
      return false;
    }
    if (Array.isArray(item)) {
      return item.length > 0;
    }
    return String(item).trim() !== "";
  }));
}
