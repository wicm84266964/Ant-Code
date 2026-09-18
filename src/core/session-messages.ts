import crypto from "node:crypto";
import { renderPdfBatches, type PdfVisionDocument } from "../tools/pdf-render.ts";
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
import { inferModelSupportsImages, resolveModelSupportsImages } from "../model-gateway/vision-capabilities.ts";
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
  pdfDocuments?: PdfVisionDocument[];
  forceVisionAnalysis?: boolean;
  prompt?: string;
  gateway?: unknown;
  signal?: AbortSignal;
  eventOptions: {
    onEvent?: (event: SessionEvent) => void | Promise<void>;
    onAntEvent?: (event: Record<string, unknown>) => void | Promise<void>;
    antEventNormalizer?: ReturnType<typeof createAntEventNormalizer>;
  };
  metadata?: SessionTurnMetadata;
}): Promise<{ ok: boolean; attachments?: InputImageAttachment[]; analysisText?: string; status?: string; output?: string }> {
  const attachments = normalizeInputAttachments(options.attachments);
  if (options.pdfDocuments?.length) {
    const reports: string[] = [];
    let reportChars = 0;
    try {
      // Check routing before rendering potentially large documents.
      if (!modelSupportsImages(options.session.config, options.session.model) && !resolveVisionAgentModel(options.session.config)) {
        return { ok: false, status: "vision_unavailable", output: "PDF 按页识别需要视觉模型。请切换到支持图片的主模型，或启用同网关的视觉模型后重试。" };
      }
      for (const document of options.pdfDocuments) {
        await emitEvent(options.eventOptions, { type: "pdf_vision_progress", name: document.name, stage: "rendering" });
        for await (const batch of renderPdfBatches(document, { signal: options.signal })) {
          await emitEvent(options.eventOptions, { type: "pdf_vision_progress", name: document.name, pageStart: batch.pageStart, pageEnd: batch.pageEnd, totalPages: batch.totalPages, stage: "analyzing" });
          const prepared = await prepareVisionAttachmentsForTurn({
            ...options, pdfDocuments: undefined, forceVisionAnalysis: true, attachments: batch.images,
            prompt: `${options.prompt ?? ""}\nPDF: ${document.name}; pages ${batch.pageStart}-${batch.pageEnd} of ${batch.totalPages}. Analyze only these supplied pages, cite page numbers, preserve table/figure values relevant to the request, and mark unreadable details. These may be the first pages of a scan and are not necessarily the abstract. Do not claim to have read other pages.`
          });
          if (!prepared.ok) return prepared;
          const report = `PDF ${document.name}, pages ${batch.pageStart}-${batch.pageEnd} of ${batch.totalPages}:\n${prepared.analysisText}`;
          reportChars += report.length;
          if (reportChars > 240_000) throw new Error("PDF visual reports exceed the context budget; select a smaller page range and retry.");
          reports.push(report);
          await emitEvent(options.eventOptions, { type: "pdf_vision_progress", name: document.name, pageStart: batch.pageStart, pageEnd: batch.pageEnd, totalPages: batch.totalPages, stage: "completed" });
        }
      }
      const images = await prepareVisionAttachmentsForTurn({ ...options, pdfDocuments: undefined });
      if (!images.ok) return images;
      return { ...images, analysisText: [...reports, images.analysisText].filter(Boolean).join("\n\n") };
    } catch (error) {
      const interrupted = options.signal?.aborted;
      const output = interrupted ? "PDF 视觉识别已取消，未完成的页面没有被当作已识别。" : `PDF 视觉识别失败，未生成完整报告：${error instanceof Error ? error.message : String(error)}`;
      await emitEvent(options.eventOptions, { type: "pdf_vision_error", interrupted, output });
      return { ok: false, status: interrupted ? "interrupted" : "vision_error", output };
    }
  }
  if (attachments.length === 0) {
    return { ok: true, attachments, analysisText: "" };
  }
  if (!options.forceVisionAnalysis && modelSupportsImages(options.session.config, options.session.model)) {
    return { ok: true, attachments, analysisText: "" };
  }

  const visionModel = options.forceVisionAnalysis && modelSupportsImages(options.session.config, options.session.model)
    ? { id: options.session.model }
    : resolveVisionAgentModel(options.session.config);
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

  const analysisText = response.data.text.trim();
  if (!analysisText) {
    return { ok: false, status: "vision_error", output: "视觉模型未返回有效识别内容，请重试或检查视觉模型配置。" };
  }
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
          "你是 Ant Code visual-verifier 视觉复核子智能体。请先处理用户上传的图片或 PDF 渲染页面，输出可供主智能体继续工作的中文视觉证据报告。",
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
  const model = listConfiguredModels(config).find((item) => item.id === id)
    ?? listRoutingModels(config).find((item) => item.id === id);
  if (modelSupportsImagesEntry(model)) {
    return true;
  }
  return inferModelSupportsImages(id);
}

export function modelSupportsImagesEntry(model: { id?: unknown; modalities?: unknown } | null | undefined) {
  return resolveModelSupportsImages({
    id: model?.id,
    modalities: model?.modalities
  });
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
  const documents = Array.isArray(attachments)
    ? attachments.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && item.type === "document")
    : [];
  const documentBlocks = documents.map((item) => ({
    type: "text",
    text: `[文档附件：${String(item.name ?? "document")}]`
  }));
  const chips = persistableAttachmentChips(attachments);
  const message: SessionMessage = normalized.length === 0 && documentBlocks.length === 0
    ? { role: "user", content: prompt }
    : {
        role: "user",
        content: [
          ...(String(prompt ?? "").trim() ? [{ type: "text", text: String(prompt ?? "") }] : []),
          ...documentBlocks,
          ...normalized.map(imageAttachmentSummaryBlock)
        ]
      };
  if (chips.length > 0) {
    message.attachments = chips;
  }
  return message;
}

export function persistableAttachmentChips(attachments: unknown = []): NonNullable<SessionMessage["attachments"]> {
  if (!Array.isArray(attachments)) {
    return [];
  }
  const chips: NonNullable<SessionMessage["attachments"]> = [];
  for (const item of attachments) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    const type = record.type === "document" ? "document" : record.type === "image" ? "image" : null;
    if (!type) {
      continue;
    }
    const storedPath = String(record.path ?? "").trim().replace(/\\/g, "/");
    chips.push({
      type,
      name: String(record.name ?? type).trim().slice(0, 160) || type,
      mimeType: String(record.mimeType ?? record.mime_type ?? "").trim(),
      size: nonNegativeInteger(record.size ?? record.bytes ?? record.sizeBytes, 0) ?? 0,
      ...(storedPath ? { path: storedPath } : {})
    });
    if (chips.length >= 10) {
      break;
    }
  }
  return chips;
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
    const { interruptedDraft: _interruptedDraft, attachments: _attachments, ...rest } = message;
    return [rest];
  });
}

/**
 * @param {AgentSession} session
 */
