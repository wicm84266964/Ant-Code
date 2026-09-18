import { persistSessionSnapshot, type AgentSession } from "../../core/session.ts";
import { redactPersistedText } from "../../core/session-resume.ts";
import { createLabModelGateway } from "../../model-gateway/client.ts";
import type { LabAgentConfig } from "../../config/load-config.ts";
import { appendDashboardEvent, eventId } from "./util.ts";
import type { DashboardActiveSessionState, DashboardQueueItem } from "./types.ts";

export const SESSION_TITLE_MAX_CHARS = 28;
export const SESSION_TITLE_TIMEOUT_MS = 12_000;

type JsonObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function agentsRecord(config: LabAgentConfig | JsonObject | null | undefined) {
  return isPlainObject(config?.agents) ? config.agents : {};
}

export function cheapModelForSessionTitle(config: LabAgentConfig | JsonObject | null | undefined) {
  const tiers = isPlainObject(agentsRecord(config).modelTiers) ? agentsRecord(config).modelTiers : {};
  const cheap = String(isPlainObject(tiers) ? tiers.cheap ?? "" : "").trim();
  const main = String(config?.modelAlias ?? "").trim();
  if (!cheap || cheap === main) {
    return "";
  }
  return cheap;
}

export function shouldGenerateDashboardSessionTitle(
  session: AgentSession | JsonObject | null | undefined,
  item: DashboardQueueItem | JsonObject | null | undefined
) {
  const kind = String(item?.kind ?? "prompt");
  if (kind !== "prompt") {
    return false;
  }
  if (Number(session?.turnCount ?? 0) > 0) {
    return false;
  }
  if (String(session?.titleSource ?? "") === "model") {
    return false;
  }
  if (!String(item?.prompt ?? "").trim()) {
    return false;
  }
  return Boolean(cheapModelForSessionTitle(session?.config as LabAgentConfig | JsonObject | undefined));
}

export function normalizeGeneratedSessionTitle(value: unknown) {
  const firstLine = redactPersistedText(value)
    .replace(/```[\s\S]*?```/g, " ")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? "";
  const stripped = firstLine
    .replace(/^["“'`]+|["”'`]+$/g, "")
    .replace(/^标题[:：]\s*/u, "")
    .replace(/[。！？.!?]+$/u, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!stripped) {
    return null;
  }
  if (/只输出标题|不要引号|不要解释|不要句号/.test(stripped)) {
    return null;
  }
  const chars = [...stripped];
  if (chars.length > SESSION_TITLE_MAX_CHARS) {
    return `${chars.slice(0, SESSION_TITLE_MAX_CHARS - 1).join("")}…`;
  }
  return stripped;
}

export function sessionTitlePrompt(userPrompt: unknown) {
  const task = redactPersistedText(userPrompt).replace(/\s+/g, " ").trim().slice(0, 500);
  return [
    "为下面这次用户任务起一个简短会话标题。",
    "只输出标题本身，不要引号、不要句号、不要解释。",
    `最多 ${SESSION_TITLE_MAX_CHARS} 个汉字或字符。`,
    "",
    "任务：",
    task
  ].join("\n");
}

export async function generateSessionTitle(options: {
  config: LabAgentConfig | JsonObject;
  prompt: string;
  signal?: AbortSignal;
}) {
  const model = cheapModelForSessionTitle(options.config);
  if (!model || !options.prompt.trim()) {
    return null;
  }
  const lab = isPlainObject(options.config.lab) ? options.config.lab : {};
  const titleConfig = {
    ...options.config,
    modelAlias: model,
    lab: {
      ...lab,
      gatewayMaxRetries: 0
    }
  };
  const gateway = createLabModelGateway(titleConfig as LabAgentConfig);
  if (!gateway.configured) {
    return null;
  }
  const result = await gateway.sendChat({
    messages: [{ role: "user", content: sessionTitlePrompt(options.prompt) }],
    tools: [],
    stream: false,
    signal: options.signal
  });
  if (!result.ok) {
    return null;
  }
  return normalizeGeneratedSessionTitle(result.data.text);
}

export async function applyGeneratedSessionTitle(
  state: DashboardActiveSessionState,
  title: string
) {
  if (state.disposed || !title) {
    return false;
  }
  if (String(state.session.titleSource ?? "") === "model" && state.session.title === title) {
    return false;
  }
  state.session.title = title;
  state.session.titleSource = "model";
  appendDashboardEvent(state, {
    type: "session_title_updated",
    id: eventId("session-title"),
    sessionId: state.session.id,
    title,
    at: new Date().toISOString()
  });
  if (!state.running) {
    try {
      await persistSessionSnapshot(state.session, {
        env: state.turnEnv ?? process.env,
        requireExisting: true
      });
    } catch {
      // The next turn persist still writes session.title.
    }
  }
  return true;
}

export function scheduleDashboardSessionTitle(
  state: DashboardActiveSessionState,
  item: DashboardQueueItem
) {
  if (!shouldGenerateDashboardSessionTitle(state.session, item)) {
    return;
  }
  if (state.sessionTitleGeneration) {
    return;
  }
  const prompt = String(item.prompt ?? "").trim();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SESSION_TITLE_TIMEOUT_MS);
  state.sessionTitleGeneration = controller;
  void generateSessionTitle({
    config: state.session.config,
    prompt,
    signal: controller.signal
  }).then(async (title) => {
    if (!title || state.disposed) {
      return;
    }
    await applyGeneratedSessionTitle(state, title);
  }).catch(() => {
    // Keep the first-prompt fallback title.
  }).finally(() => {
    clearTimeout(timer);
    if (state.sessionTitleGeneration === controller) {
      state.sessionTitleGeneration = undefined;
    }
  });
}
