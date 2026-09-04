import crypto from "node:crypto";
import { loadConfig, type LabAgentConfig } from "../config/load-config.ts";
import { runHooks } from "../hooks/runner.ts";
import { createLabModelGateway } from "../model-gateway/client.ts";
import { limitThinkingPreview } from "../model-gateway/thinking-budget.ts";
import { createMcpRuntime } from "../mcp/runtime.ts";
import { formatSkillContextLines } from "../skills/registry.ts";
import { getToolDefinitions } from "../tools/definitions.ts";

import { createToolRuntime } from "../tools/runtime.ts";
import { type ToolResultValue } from "../tools/result.ts";
import { formatToolResultForModel } from "../tools/result-view.ts";
import { estimatePromptPayload } from "../core/context-window.ts";
import { buildValidationMemory, formatValidationMemory } from "../core/validation-memory.ts";
import { suggestValidationCommands } from "../core/validation-suggestions.ts";
import { accumulateProviderUsage } from "../core/provider-usage.ts";
import { createBudgetTracker, checkBudget, recordBudgetToolResult, resolveAgentBudget, resolveAgentModel } from "./budget.ts";
import { buildContextPack, formatContextPack, hasWriteScope } from "./context-pack.ts";
import { createPartialSubagentResult } from "./continuation.ts";
import { formatOutputContract, summarizeContractResult } from "./contracts.ts";
import { createPlanPackageStore, extractPlanPackage } from "./plan-package-store.ts";
import { getAgentProfile, listAgentProfileLabels, type AgentProfile } from "./profiles.ts";
import { createAgentTaskStore } from "./task-store.ts";
import { visualEvidenceImageBlocks } from "../core/visual-evidence.ts";

const SUMMARY_PATTERNS = Object.freeze(["src/**/*.js", "tests/**/*.js", "docs/**/*.md"]);
const MAX_AGENT_OUTPUT_CHARS = 32_000;
const TASK_HEARTBEAT_INTERVAL_MS = 10_000;
const EMPTY_RECORD: Record<string, unknown> = {};

type AgentChatMessage = {
  role: string;
  content: unknown;
  toolCalls?: unknown;
  thinking?: unknown;
  responseItems?: unknown;
  toolCallId?: string;
  name?: string;
};

type AgentTaskRecord = {
  id: string;
  parentSessionId?: string | null;
  parentTaskId?: string | null;
  childSessionId?: string | null;
  profile?: string;
  title?: string;
  status?: string;
  mode?: unknown;
  model?: unknown;
  prompt?: unknown;
  [key: string]: unknown;
};

type BudgetTracker = ReturnType<typeof createBudgetTracker>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asBudgetRecord(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : EMPTY_RECORD;
}

/**
 * @param {{
 *   cwd: string;
 *   profileName: string;
 *   query: string;
 *   config?: Record<string, any>;
 *   env?: NodeJS.ProcessEnv;
 *   readonly?: boolean;
 *   allowWrite?: boolean;
 *   allowCommand?: boolean;
 *   fullAccess?: boolean;
 *   workflowState?: Parameters<typeof createToolRuntime>[0]["workflowState"];
 *   approvalCallback?: Parameters<typeof createToolRuntime>[0]["approve"];
 *   onBackgroundTerminalEvent?: Parameters<typeof createToolRuntime>[0]["onBackgroundTerminalEvent"];
 *   signal?: AbortSignal;
 *   groupId?: string;
 *   backgroundParentSessionId?: string;
 *   routeDecision?: Record<string, any>;
 *   contextPack?: Record<string, any>;
 *   writeScope?: unknown;
 *   acceptance?: unknown;
 *   allowHiddenProfile?: boolean;
 * }} options
 */
export type SubagentResult = {
  ok: boolean;
  partial?: boolean;
  interrupted?: boolean;
  blocked?: boolean;
  status?: string;
  profile?: unknown;
  mode?: unknown;
  modelDriven?: boolean;
  model?: string;
  query?: string;
  error?: unknown;
  contract?: unknown;
  continuationPrompt?: unknown;
  budgetExceeded?: unknown;
  metadata?: Record<string, unknown>;
  summary?: unknown;
  taskId?: string;
  childSessionId?: string;
  fallback?: string;
  toolsUsed?: string[];
  [key: string]: unknown;
};

export async function runSubagent(options: {
  cwd: string;
  profileName: string;
  query: string;
  config?: LabAgentConfig;
  env?: NodeJS.ProcessEnv;
  readonly?: boolean;
  allowWrite?: boolean;
  allowCommand?: boolean;
  fullAccess?: boolean;
  workflowState?: Parameters<typeof createToolRuntime>[0]["workflowState"];
  approvalCallback?: Parameters<typeof createToolRuntime>[0]["approve"];
  onBackgroundTerminalEvent?: Parameters<typeof createToolRuntime>[0]["onBackgroundTerminalEvent"];
  signal?: AbortSignal;
  groupId?: string;
  backgroundParentSessionId?: string;
  routeDecision?: Record<string, unknown>;
  contextPack?: Record<string, unknown>;
  writeScope?: unknown;
  acceptance?: unknown;
  allowHiddenProfile?: boolean;
  taskStore?: ReturnType<typeof createAgentTaskStore>;
  childSessionId?: string;
  taskId?: string;
  parentSessionId?: string;
  parentTaskId?: string;
  title?: string;
  hooksTrusted?: boolean;
  visualEvidence?: import("../core/visual-evidence.ts").VisualEvidence[];
}): Promise<SubagentResult> {
  const config = options.config ?? await loadConfig({ cwd: options.cwd, env: options.env });
  const profile = getAgentProfile(options.profileName, config, {
    cwd: options.cwd,
    includeHidden: options.allowHiddenProfile === true
  });
  if (!profile) {
    const available = listAgentProfileLabels(config, { cwd: options.cwd }).join(", ");
    return {
      ok: false,
      error: {
        code: "AGENT_PROFILE_NOT_FOUND",
        message: `Unknown agent profile: ${options.profileName}. Available profiles: ${available || "none"}`
      }
    };
  }

  const query = String(options.query ?? "").trim();
  if (!query) {
    return {
      ok: false,
      profile: profile.name,
      error: { code: "AGENT_QUERY_REQUIRED", message: "Subagent query is required." }
    };
  }

  const taskStore = options.taskStore ?? createAgentTaskStore({ cwd: options.cwd });
  const childSessionId = options.childSessionId ?? `agent-${profile.name}-${crypto.randomUUID()}`;
  const contextPack = buildContextPack({
    query,
    profile,
    routeDecision: options.routeDecision,
    contextPack: options.contextPack,
    writeScope: options.writeScope,
    acceptance: options.acceptance,
    validationMemory: await buildAgentValidationMemoryContext({
      cwd: options.cwd,
      profile,
      workflowState: options.workflowState
    }),
    cwd: options.cwd
  });
  const budget = resolveAgentBudget({
    config,
    profile,
    routeDecision: options.routeDecision
  });
  const model = resolveAgentModel(config, options.routeDecision, profile);
  const task = await taskStore.createTask({
    id: options.taskId ?? `task-${crypto.randomUUID()}`,
    parentSessionId: options.parentSessionId ?? null,
    parentTaskId: options.parentTaskId ?? null,
    groupId: options.groupId ?? null,
    childSessionId,
    profile: profile.name,
    purpose: options.routeDecision?.purpose ?? profile.purpose ?? null,
    difficulty: options.routeDecision?.difficulty ?? null,
    risk: options.routeDecision?.risk ?? null,
    title: options.title ?? profile.description,
    prompt: query,
    contextPack,
    budget,
    routeDecision: options.routeDecision ?? null,
    status: "running",
    mode: profile.mode,
    model,
    modelTier: options.routeDecision?.modelTier ?? profile.modelTier ?? null,
    startedAt: new Date().toISOString(),
    latestProgress: "子智能体已启动"
  });
  await emitSubagentHook(options, config, "subagent.started", task, {
    status: "running",
    profile: profile.name,
    model,
    mode: profile.mode,
    queryBytes: Buffer.byteLength(query, "utf8")
  });

  const gatewayConfig = model ? { ...config, modelAlias: String(model) } : config;
  const gateway = createLabModelGateway(gatewayConfig);
  if (!gateway.configured) {
    if (profile.mode === "readonly") {
      const result = await runReadonlyFallback(options.cwd, query, profile);
      await taskStore.updateTask(task.id, {
        status: result.ok ? "completed" : "failed",
        finishedAt: new Date().toISOString(),
        latestProgress: result.ok ? "只读 fallback 已完成" : "只读 fallback 失败",
        outputSummary: summarizeAgentOutput(result),
        output: JSON.stringify(result.summary ?? result, null, 2),
        error: result.error ?? null
      });
      await emitSubagentHook(options, config, result.ok ? "subagent.completed" : "subagent.failed", task, {
        status: result.ok ? "completed" : "failed",
        result
      });
      return { ...result, taskId: task.id, childSessionId };
    }
    const result = {
      ok: false,
      profile: profile.name,
      mode: profile.mode,
      error: {
        code: "AGENT_GATEWAY_NOT_CONFIGURED",
        message: "Write-capable and verifier subagents require LAB_MODEL_GATEWAY_URL so they can run as model-driven agents."
      }
    };
    await taskStore.updateTask(task.id, {
      status: "failed",
      finishedAt: new Date().toISOString(),
      latestProgress: result.error.message,
      outputSummary: result.error.message,
      error: result.error
    });
    await emitSubagentHook(options, config, "subagent.failed", task, {
      status: "failed",
      result
    });
    return { ...result, taskId: task.id, childSessionId };
  }

  const stopHeartbeat = startTaskHeartbeat(taskStore, task.id);
  let result;
  try {
    result = await runModelSubagent({
      cwd: options.cwd,
      env: options.env,
      readonly: options.readonly,
      allowWrite: options.allowWrite,
      allowCommand: options.allowCommand,
      fullAccess: options.fullAccess,
      workflowState: options.workflowState,
      approvalCallback: options.approvalCallback,
      onBackgroundTerminalEvent: options.onBackgroundTerminalEvent,
      signal: options.signal,
      backgroundParentSessionId: options.backgroundParentSessionId,
      parentSessionId: options.parentSessionId,
      hooksTrusted: options.hooksTrusted,
      config: gatewayConfig,
      profile,
      query,
      contextPack,
      budget: isPlainObject(budget) ? budget : EMPTY_RECORD,
      routeDecision: options.routeDecision,
      gateway,
      taskStore,
      taskId: task.id,
      childSessionId,
      visualEvidence: options.visualEvidence
    });
  } catch (error) {
    result = {
      ok: false,
      profile: profile.name,
      mode: profile.mode,
      error: {
        code: "AGENT_RUNTIME_ERROR",
        message: error instanceof Error ? error.message : String(error)
      }
    };
  } finally {
    stopHeartbeat();
  }
  if (!isPlainObject(result)) {
    result = {
      ok: false,
      profile: profile.name,
      mode: profile.mode,
      error: {
        code: "AGENT_RUNTIME_ERROR",
        message: "子智能体没有返回结果"
      }
    };
  }
  const finalStatus = result.partial ? "partial" : result.ok ? "completed" : result.interrupted ? "interrupted" : result.blocked ? "blocked" : "failed";
  const persistedOutput = await persistResultOutput(taskStore, task.id, result);
  const persistedPlanPackage = await persistPlannerPlanPackage({
    cwd: options.cwd,
    profile,
    result,
    task,
    parentSessionId: options.parentSessionId ?? null,
    parentTaskId: options.parentTaskId ?? null,
    childSessionId,
    routeDecision: options.routeDecision ?? null,
    model,
    modelTier: options.routeDecision?.modelTier ?? profile.modelTier ?? null
  });
  await taskStore.updateTask(task.id, {
    status: finalStatus,
    finishedAt: new Date().toISOString(),
    latestProgress: persistedPlanPackage?.ok
      ? `子智能体已完成；计划包已保存到 ${persistedPlanPackage.path}`
      : result.partial ? "子智能体阶段性暂停，可继续" : result.ok ? "子智能体已完成" : (isPlainObject(result.error) ? String(result.error.message ?? "子智能体失败") : "子智能体失败"),
    toolCalls: result.tools ?? [],
    outputSummary: summarizeAgentOutput(result),
    output: persistedOutput?.preview ?? result.output ?? "",
    outputContract: result.contract ?? null,
    continuationPrompt: result.continuationPrompt ?? null,
    budgetExceeded: result.budgetExceeded ?? null,
    error: result.error ?? null,
    metadata: {
      ...(result.metadata ?? {}),
      ...(persistedOutput ? {
        outputPath: persistedOutput.path,
        outputBytes: persistedOutput.bytes,
        outputTruncated: persistedOutput.truncated
      } : {}),
      ...(persistedPlanPackage ? {
        planPackage: persistedPlanPackage.ok === true,
        ...(persistedPlanPackage.ok ? {
          planId: persistedPlanPackage.planId,
          planPackagePath: persistedPlanPackage.path,
          planPackageFiles: persistedPlanPackage.files
        } : {
          planPackageError: persistedPlanPackage.error
        })
      } : {})
    }
  });
  await emitSubagentHook(options, config, result.partial ? "subagent.paused" : result.ok ? "subagent.completed" : "subagent.failed", task, {
    status: finalStatus,
    result,
    toolCalls: Array.isArray(result.tools) ? result.tools.length : 0,
    budgetExceeded: result.budgetExceeded ?? null
  });
  return {
    ...result,
    taskId: task.id,
    childSessionId,
    ...(persistedPlanPackage ? { planPackage: persistedPlanPackage } : {})
  };
}

async function buildAgentValidationMemoryContext(options: {
  cwd: string;
  profile?: AgentProfile;
  workflowState?: Parameters<typeof createToolRuntime>[0]["workflowState"];
}) {
  if (options.profile?.name !== "reviewer" || !options.workflowState) {
    return [];
  }
  const suggestions = await suggestValidationCommands(options.cwd);
  const memory = buildValidationMemory({
    workflow: options.workflowState ?? undefined,
    suggestions
  });
  return [
    formatValidationMemory(memory, { includeHistory: false, maxItems: 4 }),
    "Reviewer instruction: use this as validation evidence only. Do not trigger verifier or run validation automatically; report missing, stale, or failed checks as review findings or residual risk."
  ];
}

function startTaskHeartbeat(taskStore: ReturnType<typeof createAgentTaskStore> | null | undefined, taskId: string | null | undefined) {
  if (!taskStore || typeof taskStore.updateTask !== "function" || !taskId) {
    return () => {};
  }
  let stopped = false;
  const beat = async () => {
    if (stopped) {
      return;
    }
    try {
      await taskStore.updateTask(taskId, {
        heartbeatAt: new Date().toISOString()
      });
    } catch {
      // Heartbeat is observability only; task execution must not fail because the marker write failed.
    }
  };
  const timer = setInterval(beat, TASK_HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/**
 * @param {{
 *   cwd: string;
 *   profile: NonNullable<ReturnType<typeof getAgentProfile>>;
 *   query: string;
 *   config: Record<string, any>;
 *   env?: NodeJS.ProcessEnv;
 *   readonly?: boolean;
 *   allowWrite?: boolean;
 *   allowCommand?: boolean;
 *   workflowState?: Parameters<typeof createToolRuntime>[0]["workflowState"];
 *   approvalCallback?: Parameters<typeof createToolRuntime>[0]["approve"];
 *   signal?: AbortSignal;
 *   gateway: ReturnType<typeof createLabModelGateway>;
 * }} options
 */
async function runModelSubagent(options: {
  cwd: string;
  profile: AgentProfile;
  query: string;
  config: LabAgentConfig;
  env?: NodeJS.ProcessEnv;
  readonly?: boolean;
  allowWrite?: boolean;
  allowCommand?: boolean;
  fullAccess?: boolean;
  workflowState?: Parameters<typeof createToolRuntime>[0]["workflowState"];
  approvalCallback?: Parameters<typeof createToolRuntime>[0]["approve"];
  onBackgroundTerminalEvent?: Parameters<typeof createToolRuntime>[0]["onBackgroundTerminalEvent"];
  signal?: AbortSignal;
  gateway: ReturnType<typeof createLabModelGateway>;
  contextPack?: Record<string, unknown>;
  budget?: Record<string, unknown>;
  routeDecision?: Record<string, unknown>;
  taskStore?: ReturnType<typeof createAgentTaskStore>;
  taskId?: string;
  childSessionId?: string;
  backgroundParentSessionId?: string;
  parentSessionId?: string;
  hooksTrusted?: boolean;
  visualEvidence?: import("../core/visual-evidence.ts").VisualEvidence[];
}): Promise<SubagentResult> {
  const allowedTools = new Set(options.profile.tools ?? []);
  allowedTools.delete("agent_run");
  const writeScopeRequired = requiresWriteScope(options.profile);
  const hasScopedWrites = !writeScopeRequired || hasWriteScope(options.contextPack ?? EMPTY_RECORD);
  if (!hasScopedWrites && !options.fullAccess) {
    removeWriteCapability(allowedTools);
  }
  const toolDefinitions = getToolDefinitions().filter((tool) => allowedTools.has(tool.name));
  const scopedConfig = scopedAgentConfig(options.config, options.profile);
  const mcpRuntime = createMcpRuntime({
    cwd: options.cwd,
    config: scopedConfig,
    policy: createAgentPolicy(options),
    approve: options.approvalCallback
  });
  const toolRuntime = createToolRuntime({
    cwd: options.cwd,
    config: scopedConfig,
    env: options.env,
    signal: options.signal,
    mcpRuntime,
    workflowState: options.workflowState,
    approve: options.approvalCallback,
    parentSessionId: options.childSessionId,
    backgroundParentSessionId: options.backgroundParentSessionId ?? options.parentSessionId ?? options.childSessionId,
    hooksTrusted: options.hooksTrusted,
    policy: createAgentPolicy(options),
    allowedSkills: options.profile.skills,
    allowedMcpServers: options.profile.mcpServers,
    onBackgroundTerminalEvent: options.onBackgroundTerminalEvent
  });
  const messages: AgentChatMessage[] = [
    {
      role: "system",
      content: [{ type: "text", text: await buildAgentSystemPrompt(options) }]
    },
    formatAgentUserMessage(options)
  ];
  const budget = options.budget ?? resolveAgentBudget({
    config: options.config,
    profile: options.profile,
    routeDecision: options.routeDecision
  });
  const budgetTracker = createBudgetTracker(budget as ReturnType<typeof resolveAgentBudget>);
  const sessionId = options.childSessionId ?? `agent-${options.profile.name}-${crypto.randomUUID()}`;
  let toolResults: Array<Record<string, unknown>> = [];
  const toolExecutions: Array<Record<string, unknown>> = [];
  let finalReportReason: BudgetReason | null = null;
  let finalReportRequested = false;
  let lastPromptProgress: Record<string, unknown> = {};
  let providerUsageProgress: Record<string, unknown> = {};

  try {
  for (let round = 0; ; round += 1) {
    const beforeRequestBudget = finalReportRequested ? null : checkBudget(budgetTracker, { round });
    if (beforeRequestBudget && !finalReportRequested && shouldRequestFinalReportAfterBudgetHit(options.profile, beforeRequestBudget)) {
      finalReportReason ??= beforeRequestBudget;
      finalReportRequested = true;
      toolResults = [];
      messages.push({
        role: "user",
        content: formatFinalReportAfterBudgetPrompt(finalReportReason)
      });
      await options.taskStore?.updateTask(options.taskId, {
        latestProgress: finalReportProgressText(finalReportReason)
      });
    } else if (beforeRequestBudget) {
      return createPartialSubagentResult({
        profile: options.profile,
        query: options.query,
        reason: beforeRequestBudget,
        budget: asBudgetRecord(budget),
        tools: toolExecutions,
        contextPack: options.contextPack,
        model: options.config.modelAlias,
        mode: asString(options.profile.mode)
      });
    }
    if (options.signal?.aborted) {
      return {
        ok: false,
        profile: options.profile.name,
        interrupted: true,
        error: { code: "AGENT_INTERRUPTED", message: "Subagent was interrupted." }
      };
    }

    const promptEstimate = estimatePromptPayload({
      model: options.config.modelAlias,
      messages,
      tools: finalReportRequested ? [] : toolDefinitions,
      toolResults,
      gatewayProtocol: agentGatewayProtocol(options.config)
    });
    lastPromptProgress = agentPromptProgress(promptEstimate, {
      round: round + 1,
      maxTokens: options.config.context?.maxTokens
    });
    await options.taskStore?.updateTask(options.taskId, {
      budgetProgress: agentBudgetProgress(budgetTracker, {
        ...lastPromptProgress,
        ...providerUsageProgress
      })
    });

    const response = await options.gateway.sendChat({
      messages,
      tools: finalReportRequested ? [] : toolDefinitions,
      toolResults,
      sessionId,
      stream: false,
      signal: options.signal
    });

    if (!response.ok) {
      await options.taskStore?.updateTask(options.taskId, {
        latestProgress: response.error?.message ?? "模型请求失败",
        error: response.error ?? null
      });
      return {
        ok: false,
        profile: options.profile.name,
        mode: options.profile.mode,
        error: response.error,
        blocked: response.blocked === true,
        decision: response.decision
      };
    }

    providerUsageProgress = agentProviderUsageProgress(providerUsageProgress, response.data.usage, {
      round: round + 1,
      model: response.data.model ?? options.config.modelAlias
    });
    if (providerUsageProgress.providerUsageReports) {
      await options.taskStore?.updateTask(options.taskId, {
        budgetProgress: agentBudgetProgress(budgetTracker, {
          ...lastPromptProgress,
          ...providerUsageProgress
        })
      });
    }

    if (finalReportRequested && response.data.toolCalls.length > 0) {
      return createPartialSubagentResult({
        profile: options.profile,
        query: options.query,
        reason: {
          kind: "finalReportToolLoop",
          message: "工具预算保护阀已触发，但模型仍请求继续调用工具，因此阶段性暂停，避免空转。",
          limit: budgetTracker.toolCalls
        },
        budget: asBudgetRecord(budget),
        tools: toolExecutions,
        contextPack: options.contextPack,
        model: response.data.model ?? options.config.modelAlias,
        mode: asString(options.profile.mode)
      });
    }

    if (response.data.toolCalls.length === 0) {
      const contractSummary = summarizeContractResult(response.data.text, options.profile.outputContract);
      const output = formatSubagentOutput(response.data.text);
      return {
        ok: true,
        profile: options.profile.name,
        mode: options.profile.mode,
        modelDriven: true,
        model: response.data.model ?? options.config.modelAlias,
        query: options.query,
        output: output.preview,
        outputFull: output.full,
        outputBytes: output.bytes,
        outputTruncated: output.truncated,
        contract: {
          type: contractSummary.type,
          summary: contractSummary.summary,
          parsed: contractSummary.parsed
        },
        budget,
        rounds: round + 1,
        tools: toolExecutions
      };
    }

    const pendingBudget = checkBudget(budgetTracker, {
      round,
      pendingToolCalls: response.data.toolCalls.length
    });
    if (pendingBudget) {
      if (shouldRequestFinalReportAfterBudgetHit(options.profile, pendingBudget)) {
        finalReportReason ??= pendingBudget;
        finalReportRequested = true;
        toolResults = [];
        messages.push({
          role: "user",
          content: formatFinalReportAfterBudgetPrompt(finalReportReason)
        });
        await options.taskStore?.updateTask(options.taskId, {
          latestProgress: finalReportProgressText(finalReportReason)
        });
        continue;
      }
      return createPartialSubagentResult({
        profile: options.profile,
        query: options.query,
        reason: pendingBudget,
        budget: asBudgetRecord(budget),
        tools: toolExecutions,
        contextPack: options.contextPack,
        model: response.data.model ?? options.config.modelAlias,
        mode: asString(options.profile.mode)
      });
    }

    messages.push({
      role: "assistant",
      content: response.data.content,
      toolCalls: response.data.toolCalls,
      thinking: thinkingFromGatewayResponse(response.data),
      ...(Array.isArray(response.data.responseItems) && response.data.responseItems.length > 0
        ? { responseItems: response.data.responseItems }
        : {})
    });

    toolResults = [];
    for (const call of response.data.toolCalls) {
      const scopedInput = applyAgentToolLimits(call.name, call.input ?? {}, budget);
      const skipReason = finalReportReason && shouldRequestFinalReportAfterBudgetHit(options.profile, finalReportReason)
        ? finalReportReason
        : null;
      await options.taskStore?.updateTask(options.taskId, {
        latestProgress: skipReason ? `跳过工具 ${call.name}，准备阶段汇报` : `运行工具 ${call.name}`
      });
      const executionRaw = skipReason
        ? skippedToolExecutionAfterGuardrail(call.name, skipReason)
        : allowedTools.has(call.name)
          ? await toolRuntime.execute(call.name, scopedInput)
          : {
            ok: false,
            error: { code: "AGENT_TOOL_NOT_ALLOWED", message: `${call.name} is not available to ${options.profile.name}.` }
          };
      const execution = isPlainObject(executionRaw) ? executionRaw : EMPTY_RECORD;
      const serialized = formatToolResultForModel(call.name, execution as ToolResultValue, {
        maxBytes: typeof budget.maxToolResultBytes === "number" ? budget.maxToolResultBytes : undefined
      });
      if (!skipReason) {
        recordBudgetToolResult(budgetTracker, {
          ok: execution.ok === true,
          blocked: execution.blocked === true,
          error: isPlainObject(execution.error) ? execution.error : undefined
        }, serialized);
      }
      const executionError = isPlainObject(execution.error) ? execution.error : undefined;
      const executionDecision = isPlainObject(execution.decision) ? execution.decision : undefined;
      toolResults.push({
        toolCallId: call.id,
        name: call.name,
        content: serialized.content,
        truncated: serialized.truncated,
        interrupted: execution.interrupted === true
      });
      toolExecutions.push({
        name: call.name,
        inputSummary: summarizeToolInput(call.name, scopedInput),
        ok: execution.ok === true,
        blocked: execution.blocked === true,
        interrupted: execution.interrupted === true,
        errorCode: executionError?.code ?? null,
        decision: executionDecision?.decision ?? null,
        truncated: serialized.truncated,
        resultBytes: serialized.bytes,
        omittedBytes: null
      });
      await options.taskStore?.updateTask(options.taskId, {
        latestProgress: `${call.name} ${execution.ok === true ? "完成" : execution.blocked === true ? "被阻止" : "失败"}`,
        toolCalls: toolExecutions,
        budgetProgress: agentBudgetProgress(budgetTracker, {
          ...lastPromptProgress,
          ...providerUsageProgress
        })
      });
      if (skipReason) {
        messages.push({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: [{ type: "text", text: serialized.content }]
        });
        continue;
      }
      const earlyStop = shouldStopAfterToolFailure(options.profile, budgetTracker, call.name, execution);
      if (earlyStop) {
        if (shouldRequestFinalReportAfterBudgetHit(options.profile, earlyStop)) {
          finalReportReason ??= earlyStop;
        } else {
          return createPartialSubagentResult({
            profile: options.profile,
            query: options.query,
            reason: earlyStop,
            budget: asBudgetRecord(budget),
            tools: toolExecutions,
            contextPack: options.contextPack,
            model: response.data.model ?? options.config.modelAlias,
            mode: asString(options.profile.mode)
          });
        }
      }
      const afterToolBudget = checkBudget(budgetTracker, { round });
      if (afterToolBudget && shouldContinueAfterBudgetHit(options.profile, call.name, execution, afterToolBudget)) {
        finalReportReason ??= afterToolBudget;
      } else if (afterToolBudget) {
        return createPartialSubagentResult({
          profile: options.profile,
          query: options.query,
          reason: afterToolBudget,
          budget: asBudgetRecord(budget),
          tools: toolExecutions,
          contextPack: options.contextPack,
          model: response.data.model ?? options.config.modelAlias,
          mode: asString(options.profile.mode)
        });
      }
      messages.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: [{ type: "text", text: serialized.content }]
      });
    }
    if (options.signal?.aborted) {
      return {
        ok: false,
        profile: options.profile.name,
        mode: options.profile.mode,
        interrupted: true,
        error: { code: "AGENT_INTERRUPTED", message: "Subagent was interrupted." },
        tools: toolExecutions
      };
    }
    if (finalReportReason && !finalReportRequested && shouldRequestFinalReportAfterBudgetHit(options.profile, finalReportReason)) {
      finalReportRequested = true;
      toolResults = [];
      messages.push({
        role: "user",
        content: formatFinalReportAfterBudgetPrompt(finalReportReason)
      });
      await options.taskStore?.updateTask(options.taskId, {
        latestProgress: finalReportProgressText(finalReportReason)
      });
      continue;
    }
  }

  // Unreachable: subagents stop via final response, interruption, or non-round budget guard.
  } finally {
    mcpRuntime.close();
  }
}

function agentBudgetProgress(tracker: BudgetTracker, extra: {
  promptRound?: number;
  maxTokens?: number;
  promptBytes?: number;
  promptTokens?: number;
  promptMessageTokens?: number;
  promptToolSchemaTokens?: number;
  promptToolResultTokens?: number;
  providerUsageReports?: number;
  providerRound?: number;
  providerPromptTokens?: number;
  providerCachedPromptTokens?: number;
  providerCompletionTokens?: number;
  providerTotalTokens?: number;
  providerPromptTokensTotal?: number;
  providerCachedPromptTokensTotal?: number;
  providerCompletionTokensTotal?: number;
  providerTotalTokensTotal?: number;
  providerModel?: unknown;
  providerUsage?: unknown;
  contextTokensBefore?: number;
  contextTokensAfter?: number;
} = {}) {
  return {
    toolCalls: tracker.toolCalls,
    outputBytes: tracker.outputBytes,
    consecutiveFailures: tracker.consecutiveFailures,
    permissionDenials: tracker.permissionDenials,
    ...(Number.isFinite(extra.promptRound) ? { promptRound: extra.promptRound } : {}),
    ...(Number.isFinite(extra.maxTokens) ? { maxTokens: extra.maxTokens } : {}),
    ...(Number.isFinite(extra.promptBytes) ? { promptBytes: extra.promptBytes } : {}),
    ...(Number.isFinite(extra.promptTokens) ? { promptTokens: extra.promptTokens } : {}),
    ...(Number.isFinite(extra.promptMessageTokens) ? { promptMessageTokens: extra.promptMessageTokens } : {}),
    ...(Number.isFinite(extra.promptToolSchemaTokens) ? { promptToolSchemaTokens: extra.promptToolSchemaTokens } : {}),
    ...(Number.isFinite(extra.promptToolResultTokens) ? { promptToolResultTokens: extra.promptToolResultTokens } : {}),
    ...(Number.isFinite(extra.providerUsageReports) ? { providerUsageReports: extra.providerUsageReports } : {}),
    ...(Number.isFinite(extra.providerRound) ? { providerRound: extra.providerRound } : {}),
    ...(Number.isFinite(extra.providerPromptTokens) ? { providerPromptTokens: extra.providerPromptTokens } : {}),
    ...(Number.isFinite(extra.providerCachedPromptTokens) ? { providerCachedPromptTokens: extra.providerCachedPromptTokens } : {}),
    ...(Number.isFinite(extra.providerCompletionTokens) ? { providerCompletionTokens: extra.providerCompletionTokens } : {}),
    ...(Number.isFinite(extra.providerTotalTokens) ? { providerTotalTokens: extra.providerTotalTokens } : {}),
    ...(Number.isFinite(extra.providerPromptTokensTotal) ? { providerPromptTokensTotal: extra.providerPromptTokensTotal } : {}),
    ...(Number.isFinite(extra.providerCachedPromptTokensTotal) ? { providerCachedPromptTokensTotal: extra.providerCachedPromptTokensTotal } : {}),
    ...(Number.isFinite(extra.providerCompletionTokensTotal) ? { providerCompletionTokensTotal: extra.providerCompletionTokensTotal } : {}),
    ...(Number.isFinite(extra.providerTotalTokensTotal) ? { providerTotalTokensTotal: extra.providerTotalTokensTotal } : {}),
    ...(extra.providerModel ? { providerModel: extra.providerModel } : {}),
    ...(extra.providerUsage ? { providerUsage: extra.providerUsage } : {}),
    ...(Number.isFinite(extra.contextTokensBefore) ? { contextTokensBefore: extra.contextTokensBefore } : {}),
    ...(Number.isFinite(extra.contextTokensAfter) ? { contextTokensAfter: extra.contextTokensAfter } : {})
  };
}

function agentPromptProgress(promptEstimate: {
  bytes?: unknown;
  tokens?: unknown;
  messageTokens?: unknown;
  toolSchemaTokens?: unknown;
  toolResultTokens?: unknown;
}, details: { round?: unknown; maxTokens?: unknown } = {}) {
  return {
    ...(Number.isFinite(details.round) ? { promptRound: details.round } : {}),
    ...(Number.isFinite(details.maxTokens) ? { maxTokens: details.maxTokens } : {}),
    promptBytes: promptEstimate.bytes,
    promptTokens: promptEstimate.tokens,
    promptMessageTokens: promptEstimate.messageTokens,
    promptToolSchemaTokens: promptEstimate.toolSchemaTokens,
    promptToolResultTokens: promptEstimate.toolResultTokens
  };
}

function agentProviderUsageProgress(current: Record<string, unknown> = EMPTY_RECORD, usage: unknown, details: { round?: number; model?: string | null } = {}) {
  const aggregate = accumulateProviderUsage(
    isPlainObject(current.providerUsageAggregate) ? current.providerUsageAggregate : undefined,
    usage,
    details
  );
  if (!aggregate.reports) {
    return current ?? {};
  }
  return {
    providerUsageAggregate: aggregate,
    providerUsageReports: aggregate.reports,
    providerRound: aggregate.lastRound,
    providerModel: aggregate.lastModel,
    providerUsage: aggregate.last,
    providerPromptTokens: aggregate.lastPromptTokens,
    providerCachedPromptTokens: aggregate.lastCachedPromptTokens,
    providerCompletionTokens: aggregate.lastCompletionTokens,
    providerTotalTokens: aggregate.lastTotalTokens,
    providerPromptTokensTotal: aggregate.promptTokens,
    providerCachedPromptTokensTotal: aggregate.cachedPromptTokens,
    providerCompletionTokensTotal: aggregate.completionTokens,
    providerTotalTokensTotal: aggregate.totalTokens
  };
}

function thinkingFromGatewayResponse(data: Record<string, unknown> = EMPTY_RECORD) {
  const raw = isPlainObject(data.raw) ? data.raw : EMPTY_RECORD;
  const text = typeof data.thinkingText === "string" ? data.thinkingText : extractThinkingFromGatewayRaw(raw);
  const reportedBytes = Number(raw.thinkingBytes ?? raw.labAgentReasoningContentBytes ?? 0);
  const preview = limitThinkingPreview(text);
  const bytes = Math.max(preview.bytes, reportedBytes);
  if (!preview.text && bytes <= 0) {
    return null;
  }
  return {
    text: preview.text,
    bytes,
    truncated: preview.truncated || Boolean(raw.thinkingTruncated),
    source: "gateway",
    persistedAt: new Date().toISOString()
  };
}

function extractThinkingFromGatewayRaw(raw: unknown) {
  if (!raw || typeof raw !== "object") {
    return "";
  }
  const value = raw as Record<string, unknown>;
  if (typeof value.thinking === "string" && value.thinking.length > 0) {
    return value.thinking;
  }
  const choice = Array.isArray(value.choices) ? value.choices[0] : null;
  const message = choice && typeof choice === "object" ? choice.message : null;
  return firstThinkingText(message && typeof message === "object" ? message : value);
}

function firstThinkingText(value: unknown) {
  if (!isPlainObject(value)) {
    return "";
  }
  for (const key of ["reasoning_content", "thinking", "thought", "reasoning"]) {
    const text = value[key];
    if (typeof text === "string" && text.length > 0) {
      return text;
    }
  }
  return "";
}

function agentGatewayProtocol(config: LabAgentConfig | Record<string, unknown> = EMPTY_RECORD): string {
  const lab = isPlainObject(config.lab) ? config.lab : EMPTY_RECORD;
  return typeof lab.gatewayProtocol === "string" ? lab.gatewayProtocol : "openai-chat";
}

function summarizeAgentOutput(result: Record<string, unknown> | SubagentResult) {
  if (!result) {
    return "";
  }
  if (result.ok && result.output) {
    return truncateText(String(result.output)).split(/\r?\n/).slice(0, 8).join("\n");
  }
  if (result.summary) {
    return truncateText(JSON.stringify(result.summary, null, 2)).split(/\r?\n/).slice(0, 8).join("\n");
  }
  const error = isPlainObject(result.error) ? result.error : undefined;
  return asString(error?.message) ?? "";
}

async function emitSubagentHook(
  options: { cwd: string; env?: NodeJS.ProcessEnv; hooksTrusted?: boolean; parentSessionId?: string },
  config: unknown,
  event: string,
  task: AgentTaskRecord,
  extra: Record<string, unknown> = EMPTY_RECORD
) {
  const extraResult = isPlainObject(extra.result) ? extra.result : EMPTY_RECORD;
  return runHooks({
    config,
    cwd: options.cwd,
    env: options.env,
    hooksTrusted: options.hooksTrusted,
    event,
    sessionId: options.parentSessionId ?? null,
    taskId: task.id,
    payload: {
      taskId: task.id,
      parentSessionId: task.parentSessionId ?? null,
      parentTaskId: task.parentTaskId ?? null,
      childSessionId: task.childSessionId ?? null,
      profile: task.profile,
      title: task.title,
      status: extra.status ?? task.status,
      mode: task.mode,
      model: extra.model ?? task.model ?? null,
      promptBytes: Buffer.byteLength(String(task.prompt ?? ""), "utf8"),
      outputBytes: Buffer.byteLength(String(extraResult.output ?? ""), "utf8"),
      error: extraResult.error ?? null,
      toolCalls: extra.toolCalls ?? null,
      budgetExceeded: extra.budgetExceeded ?? null
    }
  });
}

/**
 * @param {{ cwd: string; profile: Record<string, any>; query: string; config: Record<string, any>; env?: NodeJS.ProcessEnv }} options
 */
async function buildAgentSystemPrompt(options: { cwd: string; profile: AgentProfile; query: string; config: LabAgentConfig; env?: NodeJS.ProcessEnv }) {
  const scopedConfig = scopedAgentConfig(options.config, options.profile);
  const skills = await formatSkillContextLines({
    cwd: options.cwd,
    config: scopedConfig,
    env: options.env
  });
  const profileSkills = Array.isArray(options.profile.skills) && options.profile.skills.length ? options.profile.skills.join(", ") : "not restricted";
  const profileMcp = Array.isArray(options.profile.mcpServers) && options.profile.mcpServers.length ? options.profile.mcpServers.join(", ") : "not restricted";
  return [
    `You are Ant Code subagent '${options.profile.name}'.`,
    `Mode: ${options.profile.mode}.`,
    `Workspace: ${options.cwd}.`,
    `Profile skills: ${profileSkills}.`,
    `Profile MCP servers: ${profileMcp}.`,
    "",
    options.profile.system,
    "",
    "Boundary:",
    "- You run inside the local lab-agent client. Model traffic goes only through the configured lab gateway.",
    "- Use only the tools provided in this subagent request.",
    "- Keep the parent session in control: ask for approvals through normal tool calls and do not assume broad write access.",
    "- Do not reveal secrets, raw credentials, or unnecessary large data excerpts.",
    "- If your profile declares specific skills or MCP servers, do not use unrelated skills or MCP servers.",
    "",
    "Delegated operating doctrine:",
    "- Treat the delegated prompt and context pack as your whole mission. Do not take over the parent user's entire task unless the coordinator explicitly assigned it.",
    "- Start by identifying the output the parent needs, the evidence required, the allowed tools, and any writeScope or doNotTouch boundary.",
    "- Work checkpoint-first: map -> inspect/fetch/run -> conclude. Prefer useful staged progress over raw collection loops.",
    "- When you have enough evidence, stop calling tools and write the report. The parent can launch a follow-up if more depth is needed.",
    "- For write-capable profiles, edit only the assigned slice and keep changes reversible and easy for the parent to review.",
    "- For readonly/research profiles, deliver evidence and next action, not implementation.",
    "",
    "Tool discipline:",
    "- First map the target with list_files, glob, grep, git_status, or git_diff. Read the needed files or snippets directly once you know which file matters.",
    "- Prefer full tool evidence by default. Only pass maxBytes or maxMatches when the parent task explicitly asks for a bounded excerpt.",
    "- Preserve tool output in the parent context unless a hard guardrail or explicit user instruction says to summarize it.",
    "- If a tool result is genuinely blocked or a hard output/time/permission guard appears, stop expanding raw evidence and produce a partial result.",
    "",
    "Local skills:",
    ...skills,
    "",
    "Output contract:",
    formatOutputContract(options.profile.outputContract),
    "",
    "One-shot task boundary:",
    "- Complete this delegated task in one bounded episode when possible.",
    "- If the task is too large for the active time/output/permission guards, return a partial result with completed work, evidence, remaining work, and a continuation prompt.",
    "- Do not call another subagent.",
    "- Do not output raw JSON unless the requested contract explicitly asks for JSON. Use stable headings and concise fields the parent can summarize.",
    "",
    "Response:",
    "- Start with the direct result.",
    "- Include changed files, commands run, or files inspected when relevant.",
    "- Call out blockers and validation gaps plainly."
  ].filter(Boolean).join("\n");
}

function formatAgentUserPrompt(options: {
  query: string;
  contextPack?: Record<string, unknown>;
  profile: AgentProfile;
  fullAccess?: boolean;
  visualEvidence?: import("../core/visual-evidence.ts").VisualEvidence[];
}) {
  const evidence = Array.isArray(options.visualEvidence) ? options.visualEvidence : [];
  return [
    "Delegated task:",
    options.query,
    "",
    "Context pack:",
    formatContextPack(options.contextPack ?? EMPTY_RECORD),
    "",
    evidence.length > 0
      ? `Visual evidence: ${evidence.map((item) => item.id).join(", ")}. Treat attached image blocks as primary evidence and return the visual-verification contract.`
      : null,
    requiresWriteScope(options.profile) && !hasWriteScope(options.contextPack ?? EMPTY_RECORD) && !options.fullAccess
      ? "Write boundary: no writeScope was supplied. This write-capable profile is running with write and command tools disabled; do not write files or run mutating commands. Report the needed writeScope to the coordinator."
      : null
  ].filter(Boolean).join("\n");
}

function formatAgentUserMessage(options: {
  query: string;
  contextPack?: Record<string, unknown>;
  profile: AgentProfile;
  fullAccess?: boolean;
  visualEvidence?: import("../core/visual-evidence.ts").VisualEvidence[];
}): AgentChatMessage {
  const text = formatAgentUserPrompt(options);
  const evidence = Array.isArray(options.visualEvidence) ? options.visualEvidence : [];
  const imageBlocks = visualEvidenceImageBlocks(evidence);
  if (imageBlocks.length === 0) {
    return { role: "user", content: text };
  }
  return {
    role: "user",
    content: [
      { type: "text", text },
      ...imageBlocks
    ]
  };
}

function scopedAgentConfig(config: LabAgentConfig, profile: AgentProfile): LabAgentConfig {
  const allowedMcp = new Set(profile.mcpServers ?? []);
  const servers = Array.isArray(config.mcp?.servers) ? config.mcp.servers : [];
  const scopedMcpServers = allowedMcp.size === 0
    ? servers
    : servers.filter((server: unknown) => allowedMcp.has(String(isPlainObject(server) ? server.name : "")));
  return {
    ...config,
    mcp: {
      ...(config.mcp ?? {}),
      servers: scopedMcpServers ?? []
    }
  };
}

function applyAgentToolLimits(name: string, input: Record<string, unknown> = EMPTY_RECORD, budget: Record<string, unknown> = EMPTY_RECORD) {
  const next = { ...input };
  if (name === "web_search") {
    next.maxResults = boundedPositive(next.maxResults ?? next.count, budget.maxSearchResults);
  }
  if (name === "glob" || name === "grep") {
    next.maxMatches = boundedPositive(next.maxMatches, budget.maxFileMatches);
  }
  if (name === "list_files") {
    next.maxEntries = boundedPositive(next.maxEntries, budget.maxFileMatches);
  }
  if (name === "rg_search" || name === "rg_files" || name === "rg_files_with_matches") {
    next.maxResults = boundedPositive(next.maxResults, budget.maxFileMatches);
  }
  return next;
}

function boundedPositive(value: unknown, limit: unknown) {
  const max = typeof limit === "number" && Number.isInteger(limit) && limit > 0 ? limit : null;
  const current = Number(value);
  if (!max) {
    return Number.isInteger(current) && current > 0 ? current : undefined;
  }
  if (Number.isInteger(current) && current > 0) {
    return Math.min(current, max);
  }
  return max;
}

function summarizeToolInput(name: string, input: Record<string, unknown> = {}) {
  if (name === "read_file") {
    return `path=${input.path ?? "?"}, maxBytes=${input.maxBytes ?? "default"}`;
  }
  if (name === "grep") {
    return `pattern=${String(input.pattern ?? "").slice(0, 80)}, path=${input.path ?? "."}, maxMatches=${input.maxMatches ?? "default"}`;
  }
  if (name === "glob") {
    return `pattern=${input.pattern ?? "?"}, maxMatches=${input.maxMatches ?? "default"}`;
  }
  if (name === "web_search") {
    return `query=${String(input.query ?? "").slice(0, 80)}, maxResults=${input.maxResults ?? input.count ?? "default"}`;
  }
  if (name === "web_fetch" || name === "document_intake") {
    return `target=${input.url ?? input.path ?? "?"}, maxBytes=${input.maxBytes ?? "default"}`;
  }
  return "";
}

function shouldStopAfterToolFailure(profile: AgentProfile, tracker: BudgetTracker, toolName: unknown, execution: Record<string, unknown>) {
  if (execution.ok === true) {
    return null;
  }
  const profileName = String(profile.name ?? "");
  const error = isPlainObject(execution.error) ? execution.error : undefined;
  const errorCode = error?.code ?? null;
  if (isWebResearchProfile(profileName) && toolName === "web_search") {
    if (tracker.consecutiveFailures < 2) {
      return null;
    }
    return {
      kind: "webSearchUnavailable",
      message: `web_search 未成功（${errorCode ?? "unknown"}）。搜索后端不可用时停止重试，避免空转工具预算。`,
      limit: tracker.consecutiveFailures
    };
  }
  return null;
}

function shouldContinueAfterBudgetHit(profile: AgentProfile, toolName: unknown, execution: Record<string, unknown>, budgetHit: BudgetReason | null | undefined) {
  if (canSoftLandBudgetHit(budgetHit)) {
    return true;
  }
  const profileName = String(profile.name ?? "");
  if (!isWebResearchProfile(profileName)) {
    return false;
  }
  if (budgetHit?.kind !== "maxPermissionDenials" && budgetHit?.kind !== "maxConsecutiveFailures") {
    return false;
  }
  if (budgetHit.kind === "maxPermissionDenials") {
    return true;
  }
  if (toolName !== "web_fetch" && toolName !== "mcp_call") {
    return false;
  }
  const decision = isPlainObject(execution.decision) ? execution.decision : undefined;
  return execution.blocked === true || decision?.decision === "deny" || execution.ok !== true;
}

function shouldRequestFinalReportAfterBudgetHit(profile: AgentProfile, budgetHit: BudgetReason | null | undefined) {
  if (canSoftLandBudgetHit(budgetHit)) {
    return true;
  }
  const profileName = String(profile.name ?? "");
  if (!isWebResearchProfile(profileName)) {
    return false;
  }
  return budgetHit?.kind === "maxPermissionDenials" || budgetHit?.kind === "maxConsecutiveFailures";
}

function isWebResearchProfile(profileName: unknown) {
  return profileName === "web-researcher" || profileName === "readonly-researcher";
}

type BudgetReason = {
  kind?: string;
  message?: string;
  limit?: unknown;
  [key: string]: unknown;
};

function formatFinalReportAfterBudgetPrompt(reason: BudgetReason) {
  if (canSoftLandBudgetHit(reason)) {
    return [
      "The delegated task has reached a local guardrail. This is a soft landing request, not a failure.",
      `Budget reason: ${reason.message}`,
      "",
      "Do not call more tools.",
      "Write a staged report now using only the successful tool results already in context.",
      "Include: completed findings, concrete evidence inspected, remaining gaps, and a concise continuation plan that splits any remaining work into smaller batches.",
      "If more inspection is needed, say exactly which focused searches or file snippets the parent should delegate next."
    ].join("\n");
  }
  return [
    "A web-source-level failure budget has been reached, but this should not erase the useful research already gathered.",
    `Budget reason: ${reason.message}`,
    "",
    "Do not call more tools.",
    "Write the final report now using the successful search/fetch/tool results already in context.",
    "List blocked or failed sources under caveats, distinguish source-specific failure from total research failure, and include any remaining uncertainty."
  ].join("\n");
}

function finalReportProgressText(reason: BudgetReason) {
  if (canSoftLandBudgetHit(reason)) {
    return "子任务已触发保护阀，正在停止工具并生成阶段汇报";
  }
  return "网页来源失败已达到保护阀，正在基于已有结果生成最终汇报";
}

function skippedToolExecutionAfterGuardrail(name: string, reason: BudgetReason) {
  return {
    ok: false,
    error: {
      code: "AGENT_TOOL_SKIPPED_AFTER_GUARDRAIL",
      message: `${name} was skipped because the subagent already reached a soft guardrail: ${reason?.message ?? reason?.kind ?? "guardrail"}.`
    }
  };
}

function canSoftLandBudgetHit(reason: BudgetReason | null | undefined) {
  return [
    "maxOutputBytes",
    "maxDurationMs",
    "maxRounds",
    "maxToolCalls",
    "maxConsecutiveFailures",
    "maxPermissionDenials",
    "webSearchUnavailable"
  ].includes(String(reason?.kind ?? ""));
}

/**
 * @param {{ profile: Record<string, any>; config: Record<string, any>; readonly?: boolean; allowWrite?: boolean; allowCommand?: boolean; fullAccess?: boolean; contextPack?: Record<string, any> }} options
 */
function createAgentPolicy(options: { profile: AgentProfile; config: LabAgentConfig; readonly?: boolean; allowWrite?: boolean; allowCommand?: boolean; fullAccess?: boolean; contextPack?: Record<string, unknown> }) {
  const fullAccess = Boolean(options.fullAccess);
  const writeScopeMissing = requiresWriteScope(options.profile) && !hasWriteScope(options.contextPack ?? EMPTY_RECORD) && !fullAccess;
  const readonly = options.profile.mode === "readonly"
    || writeScopeMissing
    || Boolean(options.readonly);
  const scopedWriteAllowed = requiresWriteScope(options.profile) ? hasWriteScope(options.contextPack ?? EMPTY_RECORD) : true;
  const commandAllowed = options.profile.mode === "write-capable" || options.profile.mode === "execute";
  return {
    networkMode: options.config.networkMode,
    allowedHosts: options.config.allowedHosts,
    readonly,
    fullAccess,
    approvals: {
      workspaceWrites: fullAccess || (scopedWriteAllowed && options.profile.mode === "write-capable" && Boolean(options.allowWrite)),
      workspaceCommands: fullAccess || (commandAllowed && Boolean(options.allowCommand))
    }
  };
}

function requiresWriteScope(profile: AgentProfile | Record<string, unknown> = EMPTY_RECORD) {
  return profile.mode === "write-capable";
}

/**
 * @param {Set<string>} allowedTools
 */
function removeWriteCapability(allowedTools: Set<string>) {
  for (const tool of ["write_file", "edit_file", "powershell", "bash", "mcp_call", "skill_run", "todo_write", "plan_update"]) {
    allowedTools.delete(tool);
  }
}

/**
 * @param {string} cwd
 * @param {string} query
 * @param {{ name: string; mode: string; tools: string[] }} profile
 */
async function runReadonlyFallback(cwd: string, query: string, profile: AgentProfile): Promise<SubagentResult> {
  const runtime = createToolRuntime({
    cwd,
    policy: { readonly: true, networkMode: "offline" }
  });

  const fileSummaries = [];
  for (const pattern of SUMMARY_PATTERNS) {
    const globRaw = await runtime.execute("glob", { pattern, maxMatches: 20 });
    const globResult = isPlainObject(globRaw) ? globRaw : EMPTY_RECORD;
    const globPayload = isPlainObject(globResult.result) ? globResult.result : EMPTY_RECORD;
    fileSummaries.push({
      pattern,
      ok: globResult.ok,
      matches: globResult.ok ? globPayload.matches : [],
      truncated: globResult.ok ? globPayload.truncated : false
    });
  }

  const searchTerm = extractSearchTerm(query);
  const grepRaw = searchTerm
    ? await runtime.execute("grep", { pattern: searchTerm, path: ".", maxMatches: 20 })
    : null;
  const grepResult = isPlainObject(grepRaw) ? grepRaw : null;
  const grepPayload = grepResult && isPlainObject(grepResult.result) ? grepResult.result : EMPTY_RECORD;

  return {
    ok: true,
    profile: profile.name,
    mode: "readonly",
    modelDriven: false,
    fallback: "gateway_not_configured",
    query,
    toolsUsed: searchTerm ? ["glob", "grep"] : ["glob"],
    summary: {
      files: fileSummaries,
      searchTerm,
      matches: grepResult?.ok ? grepPayload.matches : []
    }
  };
}

/**
 * @param {string} query
 */
function extractSearchTerm(query: string) {
  const quoted = query.match(/"([^"]+)"/) ?? query.match(/'([^']+)'/);
  if (quoted) {
    return quoted[1];
  }

  const grep = query.match(/\b(?:grep|find|search|查找|搜索)\s+([^\s]+)/i);
  if (grep) {
    return grep[1];
  }

  return null;
}

function truncateText(value: unknown) {
  return formatSubagentOutput(value).preview;
}

function formatSubagentOutput(value: unknown) {
  const text = String(value ?? "");
  const bytes = Buffer.byteLength(text, "utf8");
  if (text.length <= MAX_AGENT_OUTPUT_CHARS) {
    return { preview: text, full: null, bytes, truncated: false };
  }
  const marker = "\n...[full subagent output saved to task sidecar]...\n";
  const headChars = Math.floor((MAX_AGENT_OUTPUT_CHARS - marker.length) / 2);
  const tailChars = MAX_AGENT_OUTPUT_CHARS - marker.length - headChars;
  return {
    preview: `${text.slice(0, headChars)}${marker}${text.slice(Math.max(0, text.length - tailChars))}`,
    full: text,
    bytes,
    truncated: true
  };
}

async function persistResultOutput(taskStore: ReturnType<typeof createAgentTaskStore> | undefined, taskId: string, result: SubagentResult) {
  if (!result || typeof result.outputFull !== "string" || result.outputFull.length === 0) {
    return null;
  }
  if (typeof taskStore?.writeTaskOutput !== "function") {
    return null;
  }
  return taskStore.writeTaskOutput(taskId, result.outputFull);
}

async function persistPlannerPlanPackage(options: {
  cwd: string;
  profile: AgentProfile;
  result: SubagentResult;
  task: AgentTaskRecord;
  parentSessionId: string | null;
  parentTaskId: string | null;
  childSessionId: string;
  routeDecision: Record<string, unknown> | null;
  model: unknown;
  modelTier: unknown;
}) {
  if (options.profile.name !== "planner" || options.result.ok !== true || options.result.partial === true) {
    return null;
  }
  const output = options.result.outputFull ?? options.result.output ?? "";
  const contract = isPlainObject(options.result.contract) ? options.result.contract : EMPTY_RECORD;
  const planPackage = extractPlanPackage(output, {
    parsed: contract.parsed
  });
  if (!planPackage) {
    return {
      ok: false,
      error: {
        code: "PLAN_PACKAGE_NOT_FOUND",
        message: "Planner completed without a parseable plan package."
      }
    };
  }
  try {
    const store = createPlanPackageStore({ cwd: options.cwd });
    return await store.writePlanPackage({
      package: planPackage,
      parentSessionId: options.parentSessionId,
      parentTaskId: options.parentTaskId,
      plannerTaskId: options.task.id,
      childSessionId: options.childSessionId,
      title: options.task.title,
      routeDecision: options.routeDecision,
      model: options.model,
      modelTier: options.modelTier
    });
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "PLAN_PACKAGE_WRITE_FAILED",
        message: error instanceof Error ? error.message : String(error)
      }
    };
  }
}
