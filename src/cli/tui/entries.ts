import crypto from "node:crypto";
import { createAgentTaskStore } from "../../agents/task-store.ts";
import { summarizeContextWindow } from "../../core/context-window.ts";
import type { AgentSession, SessionMessage } from "../../core/session.ts";
import { startupEntry } from "./components.ts";
import { formatTuiGoalFooter } from "./goal.ts";
import type { TuiEntry, TuiTaskRecord } from "./types.ts";

export function summarizeSessionInfo(session: AgentSession) {
  return {
    id: session.id,
    turnCount: session.turnCount,
    model: session.model,
    permissionMode: session.permissionMode,
    fullAccess: session.fullAccess,
    readonly: session.readonly,
    permissionReadonlyLocked: session.permissionReadonlyLocked,
    allowWrite: session.allowWrite,
    allowCommand: session.allowCommand,
    networkMode: session.networkMode,
    sensitivity: session.sensitivity,
    cwd: session.cwd,
    usage: session.usage ?? {},
    lastProviderUsage: session.lastProviderUsage ?? null,
    context: summarizeContextWindow(session)
  };
}

/**
 * @param {Awaited<ReturnType<typeof createSession>>} session
 */
export function initialEntries(session: AgentSession) {
  const entries = [withEntryIdentity(startupEntry(session))];
  if (!session.config.lab.gatewayUrl) {
    entries.push(withEntryIdentity({
      kind: "gateway",
      title: "未配置",
      body: "模型轮次前请先设置 LAB_MODEL_GATEWAY_URL。",
      at: new Date().toLocaleTimeString()
    }));
  }
  if (session.resumedFrom) {
    entries.push(withEntryIdentity({
      kind: "session",
      title: "已恢复 metadata",
      body: formatResumedMetadataBody(session.resumedFrom),
      at: new Date().toLocaleTimeString()
    }));
    entries.push(...entriesFromMessages(session.transcriptMessages ?? session.messages));
  }
  if (session.goal?.enabled) {
    entries.push(withEntryIdentity({
      kind: "goal",
      title: formatTuiGoalFooter(session) || "Goal",
      body: String(session.goal.text ?? "").trim() || "使用 /goal pause、/goal resume 或 /goal exit。",
      at: new Date().toLocaleTimeString()
    }));
  }
  return entries;
}

export function formatResumedMetadataBody(resumedFrom: {
  id?: unknown;
  metadataPath?: unknown;
  turnCount?: unknown;
  status?: unknown;
  title?: unknown;
  model?: unknown;
  finishedAt?: unknown;
  prompt?: unknown;
  transcriptMessages?: SessionMessage[];
  messages?: SessionMessage[];
}) {
  const lines = [
    `id: ${resumedFrom.id}`,
    `metadata: ${resumedFrom.metadataPath}`,
    `轮次：${resumedFrom.turnCount ?? 0}`,
    `状态：${resumedFrom.status ?? "metadata"}`
  ];
  if (resumedFrom.title) {
    lines.push(`标题：${resumedFrom.title}`);
  }
  if (resumedFrom.model) {
    lines.push(`模型：${resumedFrom.model}`);
  }
  if (resumedFrom.finishedAt) {
    lines.push(`完成：${resumedFrom.finishedAt}`);
  }
  if (resumedFrom.prompt) {
    lines.push(`最近提示：${resumedFrom.prompt}`);
  }
  const transcriptMessages = resumedFrom.transcriptMessages?.length ?? resumedFrom.messages?.length ?? 0;
  const contextMessages = resumedFrom.messages?.length ?? 0;
  lines.push(`TUI 可见恢复：${transcriptMessages} 条`);
  if (contextMessages > transcriptMessages) {
    lines.push(`模型上下文恢复：${contextMessages} 条；较早对话已进入模型上下文，TUI 仅显示最近窗口。`);
  } else if (transcriptMessages !== contextMessages) {
    lines.push(`模型上下文恢复：${contextMessages} 条；较早对话仅用于本地回看。`);
  }
  return lines.join("\n");
}

export function entriesFromMessages(messages: SessionMessage[] | unknown) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return [];
  }
  const entries = [];
  for (const [messageIndex, message] of messages.entries()) {
    if (message?.role === "user") {
      entries.push(withEntryIdentity({
        kind: "user",
        title: "restored",
        body: messageText(message.content),
        at: "restored",
        checkpointMessagesLength: messageIndex,
        turnIndex: Math.floor(messageIndex / 2) + 1
      }));
    } else if (message?.role === "assistant") {
      const thinking = messageThinking(message);
      entries.push(withEntryIdentity({
        kind: "assistant",
        title: "restored",
        body: messageText(message.content),
        at: "restored",
        ...(thinking ? {
          thinking: thinking.text,
          thinkingBytes: thinking.bytes,
          thinkingTruncated: thinking.truncated,
          thinkingVisible: false
        } : {})
      }));
    }
  }
  return entries;
}

export function messageThinking(message: SessionMessage) {
  const thinking = message?.thinking;
  if (!thinking || typeof thinking !== "object") {
    return null;
  }
  const record = thinking as { text?: unknown; bytes?: unknown; truncated?: unknown };
  const text = String(record.text ?? "");
  const bytes = Number.isFinite(record.bytes)
    ? Number(record.bytes)
    : Buffer.byteLength(text, "utf8");
  return text || bytes > 0 ? { text, bytes, truncated: record.truncated === true } : null;
}

export function messageText(content: unknown) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content.map((item) => {
    if (typeof item === "string") {
      return item;
    }
    if (item && typeof item === "object" && "text" in item) {
      return String(item.text ?? "");
    }
    return "";
  }).filter(Boolean).join("\n");
}

export function withEntryIdentity(entry: TuiEntry, metadata?: Partial<TuiEntry>) {
  if (!entry || typeof entry !== "object") {
    return entry;
  }
  return {
    id: entry.id ?? `entry-${crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`,
    ...entry,
    ...(metadata && typeof metadata === "object" ? metadata : {})
  };
}

export async function hydrateTaskOutput(task: TuiTaskRecord, cwd: string) {
  const metadata = task.metadata && typeof task.metadata === "object" ? task.metadata as Record<string, unknown> : null;
  if (!metadata?.outputPath) {
    return task;
  }
  const store = createAgentTaskStore({ cwd });
  const result = await store.readTaskOutput(task as Record<string, unknown>);
  if (!result.ok) {
    return task;
  }
  return {
    ...task,
    output: result.output,
    metadata: {
      ...(metadata ?? {}),
      outputHydrated: true
    }
  };
}
