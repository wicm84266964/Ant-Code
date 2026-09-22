import { createContextWindow } from "../core/context-window.ts";
import { normalizeSessionGoal } from "../core/goal.ts";
import type { AgentSession, SessionMessage } from "../core/session-types.ts";
import type { LabAgentConfig } from "../config/load-config.ts";
import { createWorkflowState } from "../tools/workflow-tools.ts";

const EMPTY_ARCHIVE = {
  version: 1,
  chunkSize: 50,
  totalMessages: 0,
  totalVisibleMessages: 0,
  chunks: [] as [],
  pendingMessages: [] as unknown[]
};

export function createSubagentBudgetSession(options: {
  id: string;
  cwd: string;
  config: LabAgentConfig;
  model: string;
  tools: unknown[];
  systemPrompt: string;
}): AgentSession {
  return {
    id: options.id,
    cwd: options.cwd,
    startedAt: new Date().toISOString(),
    mode: "print",
    clientSurface: "print",
    permissionMode: "plan",
    fullAccess: false,
    permissionReadonlyLocked: true,
    readonly: true,
    allowWrite: false,
    allowCommand: false,
    networkMode: options.config.networkMode,
    sensitivity: options.config.security?.sensitivity ?? "standard",
    model: options.model,
    modelSelection: null,
    config: options.config,
    context: {
      system: options.systemPrompt ? [options.systemPrompt] : [],
      tools: options.tools
    },
    workspaceDiagnostic: null,
    contextWindow: createContextWindow(options.config),
    workflow: createWorkflowState(),
    messages: [],
    transcriptMessages: [],
    transcriptArchive: { ...EMPTY_ARCHIVE },
    modelContextArchive: { ...EMPTY_ARCHIVE },
    usage: {},
    lastProviderUsage: null,
    title: null,
    titleSource: null,
    turnCount: 0,
    goal: normalizeSessionGoal(null),
    resumedFrom: null
  } as unknown as AgentSession;
}

export function extractSystemPromptText(message: { role?: string; content?: unknown } | undefined) {
  if (!message || message.role !== "system") {
    return "";
  }
  if (typeof message.content === "string") {
    return message.content;
  }
  if (!Array.isArray(message.content)) {
    return "";
  }
  return message.content.map((block) => {
    if (typeof block === "string") {
      return block;
    }
    if (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string") {
      return (block as { text: string }).text;
    }
    return "";
  }).filter(Boolean).join("\n");
}

export function asSessionMessages(messages: Array<Record<string, unknown>>): SessionMessage[] {
  return messages as SessionMessage[];
}
