import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const PLAN_PACKAGE_VERSION = 1;
const PLAN_ROOT = path.join(".lab-agent", "plans");
const DOCUMENT_FILES = Object.freeze({
  requirementsDoc: "requirements.md",
  taskPlanDoc: "task-plan.md",
  executionChecklist: "execution-checklist.md"
});

/**
 * @param {{ cwd: string }} options
 */
export function createPlanPackageStore(options) {
  const root = path.join(options.cwd, PLAN_ROOT);
  return {
    root,
    async writePlanPackage(input = {}) {
      const planPackage = normalizePlanPackage(input.package ?? input);
      if (!planPackage) {
        return {
          ok: false,
          error: {
            code: "PLAN_PACKAGE_INVALID",
            message: "Planner output did not contain requirementsDoc, taskPlanDoc, and executionChecklist."
          }
        };
      }

      const now = new Date().toISOString();
      const planId = safePlanId(input.planId ?? generatePlanId(now));
      const planDir = path.join(root, planId);
      await fs.mkdir(root, { recursive: true });
      await fs.mkdir(planDir, { recursive: false });

      const files = {
        requirements: relativePath(options.cwd, path.join(planDir, DOCUMENT_FILES.requirementsDoc)),
        taskPlan: relativePath(options.cwd, path.join(planDir, DOCUMENT_FILES.taskPlanDoc)),
        executionChecklist: relativePath(options.cwd, path.join(planDir, DOCUMENT_FILES.executionChecklist)),
        manifest: relativePath(options.cwd, path.join(planDir, "manifest.json"))
      };

      await fs.writeFile(path.join(planDir, DOCUMENT_FILES.requirementsDoc), ensureMarkdown("Requirements", planPackage.requirementsDoc), "utf8");
      await fs.writeFile(path.join(planDir, DOCUMENT_FILES.taskPlanDoc), ensureMarkdown("Task Plan", planPackage.taskPlanDoc), "utf8");
      await fs.writeFile(path.join(planDir, DOCUMENT_FILES.executionChecklist), ensureMarkdown("Execution Checklist", planPackage.executionChecklist), "utf8");

      const manifest = {
        version: PLAN_PACKAGE_VERSION,
        planId,
        status: "planned",
        createdAt: now,
        updatedAt: now,
        parentSessionId: input.parentSessionId ?? null,
        parentTaskId: input.parentTaskId ?? null,
        plannerTaskId: input.plannerTaskId ?? input.taskId ?? null,
        childSessionId: input.childSessionId ?? null,
        title: typeof input.title === "string" ? input.title : null,
        model: input.model ?? null,
        modelTier: input.modelTier ?? null,
        routeDecision: objectOrNull(input.routeDecision),
        currentStage: null,
        documents: {
          requirements: files.requirements,
          taskPlan: files.taskPlan,
          executionChecklist: files.executionChecklist
        },
        confirmationRequired: arrayOrNull(planPackage.confirmationRequired),
        clarificationQuestions: arrayOrNull(planPackage.clarificationQuestions),
        traceabilityMap: planPackage.traceabilityMap ?? null,
        reviewGates: planPackage.reviewGates ?? null
      };

      await fs.writeFile(path.join(planDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

      return {
        ok: true,
        planId,
        path: relativePath(options.cwd, planDir),
        files,
        manifest
      };
    }
  };
}

/**
 * @param {unknown} output
 * @param {{ parsed?: unknown }} [options]
 */
export function extractPlanPackage(output, options = {}) {
  const parsedPackage = normalizePlanPackage(options.parsed);
  if (parsedPackage) {
    return parsedPackage;
  }
  const parsedTextPackage = normalizePlanPackage(parseJsonFromText(output));
  if (parsedTextPackage) {
    return parsedTextPackage;
  }
  return parseMarkdownPlanPackage(output);
}

/**
 * @param {unknown} value
 */
export function normalizePlanPackage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const item = /** @type {Record<string, any>} */ (value);
  const source = item.planPackage && typeof item.planPackage === "object" && !Array.isArray(item.planPackage)
    ? /** @type {Record<string, any>} */ (item.planPackage)
    : item;
  const documents = source.documents && typeof source.documents === "object" && !Array.isArray(source.documents)
    ? /** @type {Record<string, any>} */ (source.documents)
    : {};
  const requirementsDoc = firstMarkdown(source, documents, [
    "requirementsDoc",
    "requirements",
    "requirementsMarkdown",
    "requirementDoc"
  ]);
  const taskPlanDoc = firstMarkdown(source, documents, [
    "taskPlanDoc",
    "taskPlan",
    "planDoc",
    "taskPlanMarkdown",
    "implementationPlan"
  ]);
  const executionChecklist = firstMarkdown(source, documents, [
    "executionChecklist",
    "executionChecklistDoc",
    "executionPlan",
    "executionChecklistMarkdown",
    "checklist"
  ]);

  if (!requirementsDoc || !taskPlanDoc || !executionChecklist) {
    return null;
  }

  return {
    requirementsDoc,
    taskPlanDoc,
    executionChecklist,
    confirmationRequired: normalizeArray(source.confirmationRequired),
    clarificationQuestions: normalizeArray(source.clarificationQuestions ?? source.questionsForUser),
    traceabilityMap: source.traceabilityMap ?? null,
    reviewGates: source.reviewGates ?? null
  };
}

function parseJsonFromText(output) {
  const text = String(output ?? "").trim();
  if (!text) {
    return null;
  }
  if (text.startsWith("{") && text.endsWith("}")) {
    const parsed = parseJson(text);
    if (parsed) {
      return parsed;
    }
  }
  for (const candidate of balancedJsonCandidates(text)) {
    const parsed = parseJson(candidate);
    if (parsed && normalizePlanPackage(parsed)) {
      return parsed;
    }
  }
  return null;
}

function balancedJsonCandidates(text) {
  const candidates = [];
  const value = String(text ?? "");
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "{") {
      continue;
    }
    const candidate = readBalancedJsonObject(value, index);
    if (candidate) {
      candidates.push(candidate);
      index += candidate.length - 1;
    }
  }
  return candidates;
}

function readBalancedJsonObject(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
      if (depth < 0) {
        return null;
      }
    }
  }
  return null;
}

function parseMarkdownPlanPackage(output) {
  const text = String(output ?? "").trim();
  if (!text) {
    return null;
  }
  const sections = extractMarkdownSections(text);
  if (!sections.requirementsDoc || !sections.taskPlanDoc || !sections.executionChecklist) {
    return null;
  }
  return {
    requirementsDoc: sections.requirementsDoc,
    taskPlanDoc: sections.taskPlanDoc,
    executionChecklist: sections.executionChecklist,
    confirmationRequired: null,
    clarificationQuestions: null,
    traceabilityMap: null,
    reviewGates: null
  };
}

function extractMarkdownSections(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const headings = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(#{1,4})\s+(.+?)\s*#*\s*$/);
    if (!match) {
      continue;
    }
    const key = classifyHeading(match[2]);
    if (key) {
      headings.push({ key, index });
    }
  }

  const result = {};
  for (let i = 0; i < headings.length; i += 1) {
    const current = headings[i];
    const next = headings[i + 1];
    if (result[current.key]) {
      continue;
    }
    const body = lines.slice(current.index + 1, next ? next.index : lines.length).join("\n").trim();
    if (body) {
      result[current.key] = body;
    }
  }
  return result;
}

function classifyHeading(value) {
  const title = String(value ?? "").toLowerCase().replace(/[`*_:[\](){}]/g, " ").replace(/\s+/g, " ").trim();
  if (title.includes("requirements") || title.includes("requirement doc") || /[\u9700\u6c42].*[\u6e05\u5355\u6587\u6863]/.test(title)) {
    return "requirementsDoc";
  }
  if ((title.includes("task") && title.includes("plan")) || title.includes("implementation plan") || /[\u4efb\u52a1].*[\u89c4\u5212\u8ba1\u5212]/.test(title)) {
    return "taskPlanDoc";
  }
  if ((title.includes("execution") && (title.includes("checklist") || title.includes("plan"))) || title.includes("stage checklist") || /[\u6267\u884c].*[\u6e05\u5355\u8ba1\u5212]/.test(title)) {
    return "executionChecklist";
  }
  return null;
}

function firstMarkdown(source, documents, keys) {
  for (const key of keys) {
    const value = markdownValue(source[key] ?? documents[key]);
    if (value) {
      return value;
    }
  }
  return "";
}

function markdownValue(value) {
  if (typeof value === "string") {
    return value.trim();
  }
  if (Array.isArray(value)) {
    const lines = value.map((item) => `- ${String(item ?? "").trim()}`).filter((line) => line !== "- ");
    return lines.join("\n").trim();
  }
  if (value && typeof value === "object") {
    return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
  }
  return "";
}

function ensureMarkdown(title, value) {
  const text = String(value ?? "").trim();
  if (!text) {
    return `# ${title}\n\nNo content was provided.\n`;
  }
  return text.startsWith("#") ? `${text}\n` : `# ${title}\n\n${text}\n`;
}

function generatePlanId(now) {
  const stamp = String(now).replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-").replace(/[^0-9-]/g, "");
  return `plan-${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

function safePlanId(value) {
  const text = String(value ?? "").trim();
  if (!/^[A-Za-z0-9._-]+$/.test(text)) {
    throw new Error(`Invalid plan id: ${text}`);
  }
  return text;
}

function relativePath(cwd, target) {
  return path.relative(cwd, target).replace(/\\/g, "/");
}

function parseJson(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function objectOrNull(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function normalizeArray(value) {
  if (!Array.isArray(value)) {
    return null;
  }
  const result = value.map((item) => typeof item === "string" ? item.trim() : item).filter((item) => item !== "");
  return result.length > 0 ? result : null;
}

function arrayOrNull(value) {
  return Array.isArray(value) && value.length > 0 ? value : null;
}
