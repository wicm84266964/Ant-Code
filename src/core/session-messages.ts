import crypto from "node:crypto";
import { buildInitialContext } from "../context/builder.ts";
import { loadConfig, type LabAgentConfig } from "../config/load-config.ts";
import {
  applyRuntimeModelSelection,
  currentRuntimeModelSelection,
  patchSessionModelSelectionMetadata,
  resolveSessionModelSelection
} from "../config-v2/runtime-selection.ts";
import { formatGatewayError, normalizeGatewayError } from "../model-gateway/errors.ts";
import { createLabModelGateway } from "../model-gateway/client.ts";
import { listConfiguredModels, listRoutingModels } from "../model-gateway/models.ts";
import { runHooks } from "../hooks/runner.ts";
import { createMcpRuntime } from "../mcp/runtime.ts";
import { appendThinkingPreview, limitThinkingPreview } from "../model-gateway/thinking-budget.ts";
import { createSessionStore } from "../storage/session-store.ts";
import { serializeToolResult } from "../tools/result.ts";
import { countLineChanges } from "../tools/diff.ts";
import { createToolRuntime } from "../tools/runtime.ts";
import { createWorkflowState, formatWorkflowContext, summarizeWorkflow, syncWorkflowCompletionOnFinal, type WorkflowState } from "../tools/workflow-tools.ts";
import { getAgentProfile } from "../agents/profiles.ts";
import { resolveMaxParallelReadonlyAgentRuns } from "../agents/orchestration-config.ts";
import { appendDelegationReminderToExecution, createDelegationGuard } from "../agents/delegation-guard.ts";
import { createReviewGate } from "../agents/review-policy.ts";
import { buildCompactedContextMessage, compactSessionContextWithModel, createContextWindow, estimatePromptPayload, summarizeContextWindow } from "./context-window.ts";
import { buildGoalSystemPromptAppendix, normalizeSessionGoal, serializeSessionGoal, stripGoalStatusFromContent, stripGoalStatusMarkers } from "./goal.ts";
import { createAntEventNormalizer } from "./events.ts";
import { accumulateProviderUsage, normalizeProviderUsageAggregate, sanitizeProviderUsage, type ProviderUsageAggregate } from "./provider-usage.ts";
import { resolveMainToolRounds } from "./tool-rounds.ts";
import { diagnoseWorkspace } from "./workspace-diagnostics.ts";
import {
  DEFAULT_PROMPT_COMPACT_RATIO,
  OUTPUT_HEALTH_CHECK_ENABLED,
  OUTPUT_HEALTH_MAX_RETRIES,
  OUTPUT_HEALTH_RETRY_REQUIRED_REASONS,
  TRANSCRIPT_MEMORY_MESSAGES,
  DEFAULT_RESUME_CONTEXT_MESSAGES,
  DEFAULT_RESUME_CONTEXT_TOKENS,
  DEFAULT_RESUME_CONTEXT_BYTES
} from "./session-types.ts";
import type {
  CreateSessionOptions,
  SessionMessage,
  AgentSession,
  SessionEvent,
  TranscriptArchiveChunk,
  RestoredContextMessages,
  TranscriptArchiveState,
  TurnChangeTracker,
  RunSessionTurnOptions,
  SessionToolResult,
  SessionTurnMetadata
} from "./session-types.ts";
import {
  buildSystemMessages,
  formatAssistantOutput
} from "./session-health.ts";
import {
  repairDanglingToolCallMessages
} from "./session-persist.ts";
import {
  nonNegativeInteger,
  emitEvent
} from "./session-resume.ts";


/**
 * @param {AgentSession} session
 * @param {string} prompt
 */
export function buildTurnMessages(session: AgentSession, userMessage: SessionMessage | string | Record<string, unknown>): SessionMessage[] {
  const systemMessages = buildSystemMessages(session);
  const compactedContext = buildCompactedContextMessage(session);
  const retainedMessages = messagesForModelContext(session.messages);
  return [
    ...systemMessages,
    ...(compactedContext ? [compactedContext] : []),
    ...retainedMessages,
    normalizeUserTurnMessage(userMessage)
  ];
}


export async function prepareVisionAttachmentsForTurn(options: {
  session: AgentSession;
  attachments?: unknown;
  prompt?: string;
  gateway?: unknown;
  signal?: AbortSignal;
  eventOptions: {
    onEvent?: (event: SessionEvent) => void | Promise<void>;
    onAntEvent?: (event: Record<string, unknown>) => void | Promise<void>;
    antEventNormalizer?: ReturnType<typeof createAntEventNormalizer>;
  };
  metadata?: SessionTurnMetadata;
}) {
  const attachments = normalizeInputAttachments(options.attachments);
  if (attachments.length === 0) {
    return { ok: true, attachments, analysisText: "" };
  }
  if (modelSupportsImages(options.session.config, options.session.model)) {
    return { ok: true, attachments, analysisText: "" };
  }

  const visionModel = resolveVisionAgentModel(options.session.config);
  if (!visionModel) {
    const output = [
      "当前主模型不支持图片输入，且当前网关配置里没有可用的视觉模型。",
      "请切换到带“视觉”标签的模型，或在同一个网关/Key 下配置一个视觉子智能体模型后重试。",
      "当前架构只允许一个网关/Key 生效，因此不会跨网关调用其他厂商模型做图片分析。"
    ].join("\n");
    await emitEvent(options.eventOptions, {
      type: "vision_unavailable",
      model: options.session.model,
      attachmentCount: attachments.length,
      outputBytes: Buffer.byteLength(output, "utf8")
    });
    if (options.metadata) {
      options.metadata.gatewayErrors.push("VISION_MODEL_NOT_CONFIGURED");
    }
    return { ok: false, status: "vision_unavailable", output };
  }

  await emitEvent(options.eventOptions, {
    type: "vision_analysis_start",
    model: visionModel.id,
    mainModel: options.session.model,
    attachmentCount: attachments.length
  });

  const visionGateway = createLabModelGateway({
    ...options.session.config,
    modelAlias: visionModel.id
  });
  const response = await visionGateway.sendChat({
    messages: [buildVisionAnalysisMessage(String(options.prompt ?? ""), attachments)],
    tools: [],
    toolResults: [],
    sessionId: `${options.session.id}:vision`,
    stream: false,
    signal: options.signal
  });

  if (!response.ok) {
    const output = formatGatewayError(response.error ?? {
      code: "VISION_ANALYSIS_FAILED",
      message: "vision model request failed"
    });
    await emitEvent(options.eventOptions, {
      type: "vision_analysis_error",
      model: visionModel.id,
      error: response.error,
      outputBytes: Buffer.byteLength(output, "utf8")
    });
    if (options.metadata) {
      options.metadata.gatewayErrors.push(response.error?.code ?? "VISION_ANALYSIS_FAILED");
    }
    return { ok: false, status: "vision_error", output };
  }

  const analysisText = formatAssistantOutput(response.data).trim();
  await emitEvent(options.eventOptions, {
    type: "vision_analysis_complete",
    model: response.data.model ?? visionModel.id,
    outputBytes: Buffer.byteLength(analysisText, "utf8")
  });
  return {
    ok: true,
    attachments: [],
    analysisText: formatVisionAnalysisContext(visionModel.id, attachments, analysisText)
  };
}


export function buildVisionAnalysisMessage(prompt: string, attachments: InputImageAttachment[] = []) {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: [
          "你是 Ant Code visual-verifier 视觉复核子智能体。当前主模型不支持图片输入，请你先处理用户上传的图片，输出可供另一个文本模型继续工作的中文视觉证据报告。",
          "职责：把截图/图片当作证据，识别任务类型（UI/前端截图、代码或错误截图、表格/图表、文档、前后对比等），提取可见事实、OCR 文字、界面元素、布局状态、异常现象和不确定点。",
          "前端/UI 任务需重点复核：布局完整性、响应式视口、重叠/遮挡/裁切、对齐/间距、可读性/对比度、加载/错误/空状态、交互线索与用户验收目标是否一致。",
          "输出结构：target、visualEvidence、findings、result、residualRisks、recommendedFollowup。发现问题时 findings 优先；没有问题时明确 pass/uncertain。",
          "只陈述看得见或能从视觉证据直接推断的信息；不要编造未显示的 DOM、业务逻辑或屏幕外内容。",
          String(prompt ?? "").trim() ? `用户原始需求：${String(prompt ?? "").trim()}` : ""
        ].filter(Boolean).join("\n")
      },
      ...attachments.map((attachment) => ({
        type: "image",
        data: attachment.data,
        mimeType: attachment.mimeType,
        name: attachment.name,
        size: attachment.size
      }))
    ]
  };
}


export function formatVisionAnalysisContext(modelId: unknown, attachments: InputImageAttachment[] = [], analysisText: unknown = "") {
  const names = attachments.map((attachment) => attachment.name).filter(Boolean).join(", ");
  return [
    "图片已由同一网关下的 visual-verifier 视觉子智能体预分析，当前主模型收到的是视觉证据报告。",
    `视觉模型：${modelId}`,
    names ? `图片：${names}` : "",
    "视觉证据报告：",
    analysisText || "视觉模型未返回可用视觉证据报告。"
  ].filter(Boolean).join("\n");
}


export function resolveVisionAgentModel(config: LabAgentConfig) {
  const vision = config.agents?.vision ?? {};
  if (vision.enabled === false || vision.autoUseWhenMainModelTextOnly === false) {
    return null;
  }
  const models = listConfiguredModels(config);
  const routingModels = listRoutingModels(config);
  const configured = String(vision.model ?? "").trim();
  if (configured) {
    const folded = configured.toLowerCase();
    const model = [...models, ...routingModels].find((item) => (
      item.id === configured || item.label?.toLowerCase() === folded
    ));
    return modelSupportsImagesEntry(model) ? model : null;
  }
  return models.find(modelSupportsImagesEntry) ?? null;
}


export function modelSupportsImages(config: LabAgentConfig, modelId: unknown) {
  const id = String(modelId ?? "").trim();
  if (!id) {
    return false;
  }
  const model = listConfiguredModels(config).find((item) => item.id === id);
  return modelSupportsImagesEntry(model);
}

/** @param {Record<string, any> | null | undefined} model */


/** @param {Record<string, any> | null | undefined} model */
export function modelSupportsImagesEntry(model: { modalities?: unknown } | null | undefined) {
  return Array.isArray(model?.modalities) && model.modalities.includes("image");
}


export function buildUserTurnMessage(prompt: string, workflow: WorkflowState, attachments: InputImageAttachment[] = [], visionAnalysisText: unknown = "") {
  const workflowContext = formatWorkflowContext(workflow);
  const imageBlocks = attachments.map((attachment) => ({
    type: "image",
    data: attachment.data,
    mimeType: attachment.mimeType,
    name: attachment.name,
    size: attachment.size
  }));
  if (!workflowContext && imageBlocks.length === 0 && !visionAnalysisText) {
    return { role: "user", content: prompt };
  }
  const content = [
    ...(workflowContext ? [{ type: "text", text: workflowContext }] : []),
    ...(visionAnalysisText ? [{ type: "text", text: visionAnalysisText }] : []),
    ...(String(prompt ?? "").trim() ? [{ type: "text", text: String(prompt ?? "") }] : []),
    ...imageBlocks
  ];
  return { role: "user", content };
}


export function normalizeUserTurnMessage(message: SessionMessage | string | Record<string, unknown>): SessionMessage {
  if (message && typeof message === "object" && "role" in message && message.role === "user") {
    return {
      role: "user",
      content: "content" in message ? message.content : String(message),
      thinking: "thinking" in message ? message.thinking : undefined,
      name: "name" in message && typeof message.name === "string" ? message.name : undefined
    };
  }
  return { role: "user", content: String(message ?? "") };
}


export function persistableUserTurnMessage(prompt: string, attachments: unknown = []): SessionMessage {
  const normalized = normalizeInputAttachments(attachments);
  if (normalized.length === 0) {
    return { role: "user", content: prompt };
  }
  return {
    role: "user",
    content: [
      ...(String(prompt ?? "").trim() ? [{ type: "text", text: String(prompt ?? "") }] : []),
      ...normalized.map(imageAttachmentSummaryBlock)
    ]
  };
}


export function normalizeInputAttachments(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map(normalizeInputAttachment)
    .filter((item): item is InputImageAttachment => Boolean(item))
    .slice(0, 6);
}

type InputImageAttachment = {
  type?: "image";
  data?: string;
  mimeType?: string;
  name?: string;
  size?: number;
};


export function normalizeInputAttachment(item: unknown): InputImageAttachment | null {
  if (!item || typeof item !== "object" || !("type" in item) || item.type !== "image") {
    return null;
  }
  const record = item as Record<string, unknown>;
  const data = String(record.data ?? "").replace(/\s+/g, "");
  const mimeType = String(record.mimeType ?? record.mime_type ?? "").trim().toLowerCase();
  if (!data || !/^image\/[a-z0-9.+-]+$/i.test(mimeType)) {
    return null;
  }
  return {
    type: "image",
    data,
    mimeType,
    name: String(record.name ?? "image").trim().slice(0, 160),
    size: nonNegativeInteger(record.size ?? record.bytes ?? record.sizeBytes, 0) ?? 0
  };
}


export function imageAttachmentSummaryBlock(attachment: InputImageAttachment) {
  return {
    type: "image",
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.size,
    redacted: true
  };
}


export function attachmentMetadataList(attachments: unknown = []) {
  return normalizeInputAttachments(attachments).map((attachment) => ({
    type: "image",
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.size
  }));
}


export function messagesForModelContext(messages: unknown = []): SessionMessage[] {
  if (!Array.isArray(messages)) {
    return [];
  }
  return repairDanglingToolCallMessages(messages).flatMap((message): SessionMessage[] => {
    if (!message || typeof message !== "object") {
      return [];
    }
    const { interruptedDraft: _interruptedDraft, ...rest } = message;
    return [rest];
  });
}

/**
 * @param {AgentSession} session
 */
