import { spawn } from "node:child_process";
import path from "node:path";
import { listAgentProfiles } from "../agents/profiles.js";
import { runSubagent } from "../agents/runner.js";
import { createAgentTaskStore } from "../agents/task-store.js";
import { createAgentTaskGroupStore } from "../agents/task-group-store.js";
import { cancelBackgroundAgentTasks } from "../agents/background-registry.js";
import { buildSubagentGroupWakePrompt } from "../agents/wakeup.js";
import { formatTaskTree, orchestrateAgentTasks } from "../agents/orchestrator.js";
import { formatAgentRoute, routeAgentTask } from "../agents/router.js";
import { createTaskWorktree, removeTaskWorktree } from "../agents/worktree.js";
import { formatCapabilities, listCapabilities } from "../capabilities/registry.js";
import { loadConfig } from "../config/load-config.js";
import { buildDeliveryStatus, formatDeliveryStatus } from "../core/delivery.js";
import { buildRepoMap, formatRepoMap } from "../core/repo-map.js";
import { buildValidationMemory, formatValidationMemory } from "../core/validation-memory.js";
import { formatValidationSuggestions, selectValidationSuggestion, suggestValidationCommands } from "../core/validation-suggestions.js";
import { runDoctor, formatDoctorReport } from "../diagnostics/doctor.js";
import { formatHooksReport } from "../hooks/report.js";
import { loadProjectMemoryManifest } from "../memory/loader.js";
import { appendProjectMemory } from "../memory/store.js";
import { createMcpRuntime } from "../mcp/runtime.js";
import { runGatewayHealth, formatGatewayHealthReport } from "../model-gateway/health.js";
import { formatModelOptions, listConfiguredModels, resolveModelSelection } from "../model-gateway/models.js";
import { decidePermission, isInside } from "../permissions/policy-engine.js";
import { listTrustedWorkspaces, revokeWorkspaceTrust } from "../permissions/workspace-trust.js";
import { formatSkillDetail, formatSkillsList, runSkill } from "../skills/registry.js";
import { getToolDefinitions } from "../tools/definitions.js";
import { createSessionStore } from "../storage/session-store.js";
import { createToolRuntime } from "../tools/runtime.js";
import { addTodo, clearPlan, clearTodos, setPlanSteps, updateTodoStatus } from "../tools/workflow-tools.js";
import { listKeybindingGroups, listSlashCommandGroups } from "./registry.js";

const MAX_SLASH_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_SLASH_PROCESS_TIMEOUT_MS = 30_000;

/**
 * @param {{
 *   command: { name: string; args: string[]; raw: string };
 *   cwd: string;
 *   env?: NodeJS.ProcessEnv;
 *   readonly?: boolean;
 *   allowWrite?: boolean;
 *   allowCommand?: boolean;
 *   fullAccess?: boolean;
 *   workflowState?: ReturnType<typeof import("../tools/workflow-tools.js").createWorkflowState>;
 *   sessionInfo?: Record<string, any>;
 *   approvalCallback?: Parameters<typeof createToolRuntime>[0]["approve"];
 *   setModelCallback?: (model: Record<string, any>) => void | Promise<void>;
 *   signal?: AbortSignal;
 *   trusted?: boolean;
 * }} options
 */
export async function runSlashCommand(options) {
  const config = await loadConfig({ cwd: options.cwd, env: options.env });
  const lowerName = options.command.name.toLowerCase();

  if (lowerName === "help") {
    return formatCommandList();
  }

  if (lowerName === "status") {
    const json = options.command.args.includes("--json");
    const validationSuggestions = await suggestValidationCommands(options.cwd);
    const repoMap = await buildRepoMap(options.cwd);
    const permission = resolvePermissionState(options);
    const delivery = buildDeliveryStatus({
      workflow: options.workflowState,
      sessionInfo: options.sessionInfo,
      validationSuggestions
    });
    const status = {
      cwd: options.cwd,
      sessionId: options.sessionInfo?.id ?? null,
      turns: options.sessionInfo?.turnCount ?? null,
      readonly: permission.readonly,
      allowWrite: permission.allowWrite,
      allowCommand: permission.allowCommand,
      fullAccess: permission.fullAccess,
      permissionMode: permission.permissionMode,
      permissionReadonlyLocked: permission.permissionReadonlyLocked,
      model: config.modelAlias,
      networkMode: config.networkMode,
      sensitivity: config.security?.sensitivity ?? "standard",
      gatewayConfigured: Boolean(config.lab.gatewayUrl),
      mcpServers: config.mcp?.servers?.length ?? 0,
      context: options.sessionInfo?.context ?? null,
      repoMap,
      validationSuggestions,
      delivery
    };
    return json ? formatObject(status) : formatStatusReport(status);
  }

  if (lowerName === "model") {
    return runModelCommand(options, config);
  }

  if (lowerName === "cost" || lowerName === "usage") {
    return runUsageCommand(options, config, lowerName);
  }

  if (lowerName === "context") {
    return formatObject({
      context: options.sessionInfo?.context ?? null,
      note: options.sessionInfo?.context ? "Context state is local session metadata." : "No interactive session context is attached."
    });
  }

  if (lowerName === "keybindings") {
    return formatKeybindings();
  }

  if (lowerName === "hooks") {
    return formatHooksReport(config, { trusted: options.trusted === true });
  }

  if (["theme", "feedback", "fast", "rewind", "branch", "stash"].includes(lowerName)) {
    return formatDisabledLocalCommand(lowerName);
  }

  if (lowerName === "config") {
    return formatObject(redactConfig(config));
  }

  if (lowerName === "capabilities") {
    const json = options.command.args.includes("--json");
    const capabilities = await listCapabilities({
      cwd: options.cwd,
      config,
      env: options.env
    });
    return json ? formatObject(capabilities) : formatCapabilities(capabilities);
  }

  if (lowerName === "permissions") {
    return runPermissionsCommand(options, config);
  }

  if (lowerName === "files") {
    return runFilesCommand(options, config);
  }

  if (lowerName === "map") {
    return formatRepoMap(await buildRepoMap(options.cwd));
  }

  if (lowerName === "diff") {
    return runDiffCommand(options, config);
  }

  if (lowerName === "run") {
    return runShellSlashCommand(options, config);
  }

  if (lowerName === "edit") {
    return runEditCommand(options, config);
  }

  if (lowerName === "review") {
    return runReviewCommand(options, config);
  }

  if (lowerName === "verify") {
    return runVerifyCommand(options, config);
  }

  if (lowerName === "report") {
    return runReportCommand(options, config);
  }

  if (lowerName === "next") {
    return runNextCommand(options);
  }

  if (lowerName === "todo") {
    return runTodoCommand(options);
  }

  if (lowerName === "plan") {
    return runPlanCommand(options);
  }

  if (lowerName === "tasks") {
    const store = createAgentTaskStore({ cwd: options.cwd });
    return formatTaskTree(await store.listTasks());
  }

  if (lowerName === "background") {
    return runBackgroundCommand(options);
  }

  if (lowerName === "memory") {
    return runMemoryCommand(options, config);
  }

  if (lowerName === "doctor") {
    return formatDoctorReport(await runDoctor({ cwd: options.cwd, env: options.env }));
  }

  if (lowerName === "gateway") {
    return formatGatewayHealthReport(await runGatewayHealth({
      cwd: options.cwd,
      env: options.env,
      live: options.command.args.includes("--live") || options.command.args.includes("live")
    }));
  }

  if (lowerName === "mcp") {
    return runMcpCommand(options, config);
  }

  if (lowerName === "agents") {
    return runAgentsCommand(options, config);
  }

  if (lowerName === "skills") {
    return runSkillsCommand(options, config);
  }

  if (lowerName === "sessions") {
    return runSessionsCommand(options, config);
  }

  if (lowerName === "logs") {
    return "/logs is reserved for the interactive TUI. It shows current-process runtime logs that are not persisted in session metadata.";
  }

  if (lowerName === "clear" || lowerName === "compact" || lowerName === "resume" || lowerName === "queue" || lowerName === "guide" || lowerName === "new") {
    return `/${lowerName} is reserved for interactive sessions.`;
  }

  return `Unknown slash command: /${options.command.name}`;
}

function formatCommandList() {
  const lines = [
    "Ant Code 命令帮助",
    "",
    "不确定状态时用 /status，改动后用 /next，交接前用 /report。"
  ];

  for (const group of listSlashCommandGroups()) {
    lines.push("", group.category);
    lines.push(...group.commands.map((command) => `- /${command.name} - ${command.description}`));
  }

  lines.push(
    "",
    "常用流程",
    "- /status - 查看会话、策略、仓库和交付状态",
    "- /status --json - 输出机器可读状态",
    "- /next - 查看下一步本地动作和建议验证",
    "- /report - 准备交付摘要"
  );

  return lines.join("\n");
}

/**
 * @param {Parameters<typeof runSlashCommand>[0]} options
 * @param {Record<string, any>} config
 */
async function runFilesCommand(options, config) {
  const execution = await executeBuiltInTool(options, config, "list_files", {
    path: options.command.args[0] ?? "."
  });

  if (!execution.ok) {
    return formatObject(execution);
  }

  const entries = [...execution.result].sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === "directory" ? -1 : b.type === "directory" ? 1 : a.type.localeCompare(b.type);
    }
    return a.name.localeCompare(b.name);
  });

  return entries.length === 0 ? "No files." : entries.map(formatFileEntry).join("\n");
}

/**
 * @param {Parameters<typeof runSlashCommand>[0]} options
 * @param {Record<string, any>} config
 */
async function runDiffCommand(options, config) {
  const parsed = parseDiffArgs(options.command.args, options.cwd);
  if (!parsed.ok) {
    return parsed.message;
  }

  const decision = decidePermission(
    {
      toolName: "git_diff",
      risk: "execute",
      cwd: options.cwd,
      command: "git diff --",
      summary: "Show local git diff"
    },
    createPolicy(options, config)
  );

  if (decision.decision !== "allow") {
    return formatObject({ ok: false, blocked: true, decision });
  }

  const args = ["diff"];
  if (parsed.stat) {
    args.push("--stat");
  }
  args.push("--", ...parsed.pathspecs);

  const result = await runProcess("git", args, options.cwd, options.env, options.signal);
  return formatProcessResult(result, "No git diff output.");
}

/**
 * @param {Parameters<typeof runSlashCommand>[0]} options
 * @param {Record<string, any>} config
 */
async function runShellSlashCommand(options, config) {
  const parsed = parseRunArgs(options.command);
  if (!parsed.command) {
    return "Usage: /run [--powershell|--bash] <command>";
  }

  const execution = await executeBuiltInTool(options, config, parsed.toolName, {
    command: parsed.command,
    env: options.env
  });

  return formatShellExecution(execution);
}

/**
 * @param {Parameters<typeof runSlashCommand>[0]} options
 * @param {Record<string, any>} config
 */
async function runEditCommand(options, config) {
  const parsed = parseEditArgs(options.command.args);
  if (!parsed.ok) {
    return "Usage: /edit <path> <old text> => <new text>";
  }

  const execution = await executeBuiltInTool(options, config, "edit_file", {
    path: parsed.path,
    oldText: parsed.oldText,
    newText: parsed.newText,
    expectedReplacements: 1,
    dryRun: parsed.dryRun
  });

  if (execution.ok && execution.result?.dryRun && execution.result?.wouldEdit) {
    return execution.result.diff || `Edit preview for ${execution.result.path}`;
  }
  if (!execution.ok || execution.result?.edited === false) {
    return formatObject(execution);
  }

  return execution.result.diff || `Edited ${execution.result.path}`;
}

/**
 * @param {Parameters<typeof runSlashCommand>[0]} options
 * @param {Record<string, any>} config
 */
async function runReviewCommand(options, config) {
  const mode = options.command.args[0] ?? "summary";
  const parsed = parseDiffArgs(options.command.args.filter((arg) => !["summary", "--summary", "patch", "--patch", "stat", "--stat", "files", "--files"].includes(arg)), options.cwd);
  if (!parsed.ok) {
    return parsed.message;
  }
  const decision = readonlyGitDecision(options, config, "git diff --");
  if (decision.decision !== "allow") {
    return formatObject({ ok: false, blocked: true, decision });
  }

  if (mode === "patch" || mode === "--patch") {
    const result = await runProcess("git", ["diff", "--", ...parsed.pathspecs], options.cwd, options.env, options.signal);
    return formatProcessResult(result, "No git diff output.");
  }
  if (mode === "stat" || mode === "--stat") {
    const result = await runProcess("git", ["diff", "--stat", "--", ...parsed.pathspecs], options.cwd, options.env, options.signal);
    return formatProcessResult(result, "No git diff output.");
  }
  if (mode === "files" || mode === "--files") {
    const status = await runProcess("git", ["status", "--short", "--", ...parsed.pathspecs], options.cwd, options.env, options.signal);
    const names = await runProcess("git", ["diff", "--name-only", "--", ...parsed.pathspecs], options.cwd, options.env, options.signal);
    return [
      "Git status",
      formatProcessResult(status, "No git status output."),
      "",
      "Changed paths",
      formatProcessResult(names, "No changed paths.")
    ].join("\n");
  }

  const status = await runProcess("git", ["status", "--short", "--", ...parsed.pathspecs], options.cwd, options.env, options.signal);
  const stat = await runProcess("git", ["diff", "--stat", "--", ...parsed.pathspecs], options.cwd, options.env, options.signal);
  const validationSuggestions = await suggestValidationCommands(options.cwd);
  const validationMemory = buildValidationMemory({ workflow: options.workflowState, suggestions: validationSuggestions });
  return [
    "Ant Code review summary",
    "",
    "Recorded changes",
    formatRecordedChanges(options.workflowState?.changes ?? []),
    "",
    "Validation evidence",
    formatValidationMemory(validationMemory),
    "",
    "Validation history",
    formatValidations(options.workflowState?.validations ?? []),
    "",
    "Git status",
    formatProcessResult(status, "No git status output."),
    "",
    "Git diff stat",
    formatProcessResult(stat, "No git diff output.")
  ].join("\n");
}

/**
 * @param {Parameters<typeof runSlashCommand>[0]} options
 * @param {Record<string, any>} config
 */
async function runVerifyCommand(options, config) {
  const [subcommand] = options.command.args;
  if (subcommand === "suggest") {
    const suggestions = await suggestValidationCommands(options.cwd);
    const memory = buildValidationMemory({ workflow: options.workflowState, suggestions });
    return [
      formatValidationSuggestions(suggestions),
      "",
      formatValidationMemory(memory, { includeHistory: false })
    ].join("\n");
  }
  if (!subcommand || subcommand === "list") {
    const suggestions = await suggestValidationCommands(options.cwd);
    const memory = buildValidationMemory({ workflow: options.workflowState, suggestions });
    return [
      formatValidationMemory(memory),
      "",
      "Validation history",
      formatValidations(options.workflowState?.validations ?? [])
    ].join("\n");
  }
  if (subcommand !== "run") {
    return "Usage: /verify | /verify suggest | /verify run <command>";
  }

  let rawCommand = options.command.raw.replace(/^\/verify\s+run\s*/i, "").trim();
  if (!rawCommand) {
    return "Usage: /verify run <command>";
  }
  const suggestions = await suggestValidationCommands(options.cwd);
  const selected = selectValidationSuggestion(suggestions, rawCommand);
  if (selected) {
    rawCommand = selected.command;
  } else if (/^(suggested|first|#?\d+)$/i.test(rawCommand) && suggestions.length === 0) {
    return "No validation command suggestions found.";
  } else if (/^#?\d+$/i.test(rawCommand)) {
    return `Validation suggestion ${rawCommand} was not found.`;
  }

  const toolName = process.platform === "win32" ? "powershell" : "bash";
  const execution = await executeBuiltInTool(options, config, toolName, {
    command: rawCommand,
    env: options.env
  });
  return formatShellExecution(execution);
}

/**
 * @param {Parameters<typeof runSlashCommand>[0]} options
 * @param {Record<string, any>} config
 */
async function runReportCommand(options, config) {
  const decision = readonlyGitDecision(options, config, "git status --short");
  const status = decision.decision === "allow"
    ? await runProcess("git", ["status", "--short"], options.cwd, options.env, options.signal)
    : null;
  const stat = decision.decision === "allow"
    ? await runProcess("git", ["diff", "--stat"], options.cwd, options.env, options.signal)
    : null;
  const workflow = options.workflowState;
  const session = options.sessionInfo ?? {};
  const validationSuggestions = await suggestValidationCommands(options.cwd);
  const validationMemory = buildValidationMemory({ workflow, suggestions: validationSuggestions });
  const repoMap = await buildRepoMap(options.cwd);
  const delivery = buildDeliveryStatus({ workflow, sessionInfo: session, validationSuggestions });

  return [
    "Ant Code delivery report",
    "",
    `session: ${session.id ?? "not-attached"}`,
    `turns: ${session.turnCount ?? "unknown"}`,
    `model: ${session.model ?? config.modelAlias}`,
    `network: ${session.networkMode ?? config.networkMode}`,
    `sensitivity: ${session.sensitivity ?? config.security?.sensitivity ?? "standard"}`,
    `context: ${formatContextSummary(session.context)}`,
    "",
    "Delivery status",
    formatDeliveryStatus(delivery, { includeHeader: false, includeCommands: true, includeSuggestions: false }),
    "",
    "Repository map",
    formatRepoMap(repoMap, { includeHeader: false }),
    "",
    "Plan",
    formatPlan(workflow?.plan),
    "",
    "Todos",
    formatTodos(workflow?.todos ?? []),
    "",
    "Recorded changes",
    formatRecordedChanges(workflow?.changes ?? []),
    "",
    "Validation",
    formatValidationMemory(validationMemory),
    "",
    "Validation history",
    formatValidations(workflow?.validations ?? []),
    "",
    "Suggested validation",
    formatValidationSuggestions(validationSuggestions),
    "",
    "Git status",
    status ? formatProcessResult(status, "No git status output.") : formatObject({ ok: false, blocked: true, decision }),
    "",
    "Git diff stat",
    stat ? formatProcessResult(stat, "No git diff output.") : formatObject({ ok: false, blocked: true, decision })
  ].join("\n");
}

/**
 * @param {Parameters<typeof runSlashCommand>[0]} options
 */
async function runNextCommand(options) {
  const validationSuggestions = await suggestValidationCommands(options.cwd);
  const validationMemory = buildValidationMemory({ workflow: options.workflowState, suggestions: validationSuggestions });
  const repoMap = await buildRepoMap(options.cwd);
  const delivery = buildDeliveryStatus({
    workflow: options.workflowState,
    sessionInfo: options.sessionInfo,
    validationSuggestions
  });

  return [
    "Ant Code next actions",
    "",
    formatDeliveryStatus(delivery, { includeHeader: false, includeCommands: true, includeSuggestions: false }),
    "",
    "Repository map",
    formatRepoMap(repoMap, { includeHeader: false }),
    "",
    "Suggested validation",
    formatValidationSuggestions(validationSuggestions),
    "",
    formatValidationMemory(validationMemory, { includeHistory: false }),
    "",
    "Useful commands",
    "- /verify suggest",
    "- /verify run suggested",
    "- /review",
    "- /report"
  ].join("\n");
}

/**
 * @param {Record<string, any>} status
 */
function formatStatusReport(status) {
  return [
    "Ant Code status",
    "",
    "Session",
    formatKeyValues([
      ["cwd", status.cwd],
      ["session", status.sessionId ?? "not-attached"],
      ["turns", status.turns ?? "unknown"],
      ["permission mode", status.permissionMode],
      ["readonly locked", status.permissionReadonlyLocked],
      ["readonly", status.readonly],
      ["allow write", status.allowWrite],
      ["allow command", status.allowCommand],
      ["full access", status.fullAccess],
      ["model", status.model],
      ["network", status.networkMode],
      ["sensitivity", status.sensitivity],
      ["gateway", status.gatewayConfigured ? "configured" : "not configured"],
      ["mcp servers", status.mcpServers],
      ["context", formatContextSummary(status.context)]
    ]),
    "",
    "Repository map",
    formatRepoMap(status.repoMap, { includeHeader: false }),
    "",
    "Delivery status",
    formatDeliveryStatus(status.delivery, { includeHeader: false, includeCommands: true, includeSuggestions: false }),
    "",
    "Suggested validation",
    formatValidationSuggestions(status.validationSuggestions)
  ].join("\n");
}

/**
 * @param {Parameters<typeof runSlashCommand>[0]} options
 * @param {Record<string, any>} config
 * @param {string} name
 */
function runUsageCommand(options, config, name) {
  const workflow = options.workflowState;
  const session = options.sessionInfo ?? {};
  const usage = session.usage ?? {};
  const hasProviderUsage = Number.isFinite(usage.reports) && usage.reports > 0;
  const changes = Array.isArray(workflow?.changes) ? workflow.changes : [];
  const validations = Array.isArray(workflow?.validations) ? workflow.validations : [];
  const validationsPassed = validations.filter((validation) => validation.passed).length;
  const validationsFailed = validations.filter((validation) => validation.passed === false).length;

  return [
    name === "cost" ? "Ant Code cost" : "Ant Code usage",
    "",
    "Provider usage",
    hasProviderUsage
      ? formatProviderUsageCommandLines(usage)
      : "No provider token or cost totals have been reported by the configured gateway yet.",
    "",
    "Local session",
    formatKeyValues([
      ["session", session.id ?? "not-attached"],
      ["turns", session.turnCount ?? "unknown"],
      ["model", session.model ?? config.modelAlias],
      ["network", session.networkMode ?? config.networkMode],
      ["context", formatContextSummary(session.context)]
    ]),
    "",
    "Local work counters",
    formatKeyValues([
      ["recorded changes", changes.length],
      ["validation commands", validations.length],
      ["validations passed", validationsPassed],
      ["validations failed", validationsFailed]
    ]),
    "",
    "Note",
    "Cost estimates depend on gateway-provided token accounting. Ant Code does not infer pricing from private provider internals."
  ].join("\n");
}

/**
 * @param {Parameters<typeof runSlashCommand>[0]} options
 * @param {Record<string, any>} config
 */
async function runModelCommand(options, config) {
  const [subcommand, ...rest] = options.command.args;
  if (subcommand === "use" || subcommand === "select" || subcommand === "set") {
    const selection = resolveModelSelection(config, rest.join(" "));
    if (!selection.ok) {
      return [
        "Ant Code model",
        "",
        selection.error.message,
        "",
        "Available models",
        formatModelOptions(config),
        "",
        "Usage: /model use <model-id>"
      ].join("\n");
    }
    if (!options.setModelCallback) {
      return [
        "Ant Code model",
        "",
        `Selected model: ${selection.model.id}`,
        "This command can switch the active model inside the TUI session.",
        "In print/non-interactive mode, set LAB_AGENT_MODEL or lab-agent.config.json modelAlias before starting.",
        "",
        "Available models",
        formatModelOptions({ ...config, modelAlias: selection.model.id })
      ].join("\n");
    }
    await options.setModelCallback(selection.model);
    return formatModelCommand({ ...config, modelAlias: selection.model.id }, {
      note: `Switched current TUI session model to ${selection.model.id}.`
    });
  }

  if (subcommand && subcommand !== "list") {
    return "Usage: /model | /model list | /model use <model-id>";
  }

  return formatModelCommand(config);
}

/**
 * @param {Record<string, any>} config
 * @param {{ note?: string }} options
 */
function formatModelCommand(config, options = {}) {
  const models = listConfiguredModels(config);
  const current = models.find((model) => model.id === config.modelAlias);
  return [
    "Ant Code model",
    "",
    formatKeyValues([
      ["current", config.modelAlias],
      ["current label", current?.label ?? config.modelAlias],
      ["current context window", Number.isFinite(current?.contextTokens) ? `${formatTokenCount(current.contextTokens)} tokens` : "unknown"],
      ["thinking support", current?.thinking ? "provider-exposed thinking when streamed by gateway" : "summary/status only"],
      ["gateway protocol", config.lab?.gatewayProtocol ?? "lab-agent-gateway"],
      ["gateway", config.lab?.gatewayUrl ? "configured" : "not configured"],
      ["health url", config.lab?.gatewayHealthUrl ? "configured" : "not configured"],
      ["network", config.networkMode],
      ["sensitivity", config.security?.sensitivity ?? "standard"]
    ]),
    "",
    "Available models",
    formatModelOptions(config),
    "",
    "Model selection",
    "Use /model use <model-id> in the TUI to switch this session.",
    "Set LAB_AGENT_MODEL or lab-agent.config.json modelAlias to change the startup default.",
    "The configured gateway is responsible for mapping aliases to provider models and reporting token usage.",
    "Ant Code does not call provider account/model-list endpoints directly.",
    ...(options.note ? ["", options.note] : [])
  ].join("\n");
}

function formatKeybindings() {
  const lines = ["Ant Code 快捷键", "", "这些条目来自同一个本地快捷键注册表；带条件的条目会说明何时有可见效果。"];
  for (const group of listKeybindingGroups()) {
    lines.push("", group.category);
    for (const item of group.keybindings) {
      lines.push(`- ${item.key}：${item.description}${item.condition ? `（${item.condition}）` : ""}`);
    }
  }
  return lines.join("\n");
}

/**
 * @param {string} name
 */
function formatDisabledLocalCommand(name) {
  const details = {
    theme: ["实验室本地版本的主题暂时固定。", "主题注册表评审完成前，请先使用终端配色设置。"],
    feedback: ["云端反馈上传已禁用。", "请通过实验室 issue 跟踪或本地维护者反馈。"],
    fast: ["快速模型切换还不是自动模式。", "网关暴露评审后的别名后，可设置 LAB_AGENT_MODEL 或使用 /model。"],
    tasks: ["高级任务面板目前由 todo/plan 状态替代。", "更完整的任务 UI 稳定前，请使用 /todo、/plan、/agents 和 Inspector。"],
    rewind: ["本地回退/分叉元数据尚未启用。", "目前请使用 /sessions show 和常规源码版本控制检查点。"],
    branch: ["会话分支元数据尚未启用。", "需要代码分支时，请在 Ant Code 外使用源码版本控制创建分支。"],
    stash: ["提示暂存尚未启用。", "本地暂存评审完成前，请把草稿保留在输入区或项目笔记中。"],
    background: ["后台子任务已在 TUI 中启用。", "使用 /background run <profile> <任务> 启动，/background list 查看记录。"],
    skills: ["实验室技能/自定义命令不会从 marketplace 加载。", "可通过 /help 和 /agents 查看本地命令和代理注册表。"],
    themeDefault: ["实验室本地版本暂不提供此命令。", "启用前还需要后续安全和产品评审。"]
  };
  const [reason, replacement] = details[name] ?? details.themeDefault;
  return [
    `/${name} 在实验室本地版本中不可用`,
    "",
    `原因：${reason}`,
    `本地替代方式：${replacement}`,
    "状态：有意禁用；不会触发云端或远程 marketplace 行为。"
  ].join("\n");
}

/**
 * @param {Array<[string, unknown]>} entries
 */
function formatKeyValues(entries) {
  return entries.map(([key, value]) => `${key}: ${formatScalar(value)}`).join("\n");
}

/**
 * @param {unknown} value
 */
function formatScalar(value) {
  if (value === null || value === undefined || value === "") {
    return "none";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  return String(value);
}

/**
 * @param {Parameters<typeof runSlashCommand>[0]} options
 * @param {Record<string, any>} config
 * @param {string} toolName
 * @param {Record<string, any>} input
 */
async function executeBuiltInTool(options, config, toolName, input) {
  const runtime = createToolRuntime({
    cwd: options.cwd,
    config,
    env: options.env,
    approve: options.approvalCallback,
    workflowState: options.workflowState,
    policy: createPolicy(options, config),
    signal: options.signal,
    hooksTrusted: options.trusted === true
  });

  return runtime.execute(toolName, input);
}

/**
 * @param {Parameters<typeof runSlashCommand>[0]} options
 * @param {Record<string, any>} config
 * @param {string} command
 */
function readonlyGitDecision(options, config, command) {
  return decidePermission(
    {
      toolName: "git_review",
      risk: "execute",
      cwd: options.cwd,
      command,
      summary: "Review local git worktree state"
    },
    createPolicy(options, config)
  );
}

/**
 * @param {Parameters<typeof runSlashCommand>[0]} options
 */
function runTodoCommand(options) {
  const workflow = options.workflowState;
  if (!workflow) {
    return "/todo is reserved for interactive sessions.";
  }

  const [subcommand, ...rest] = options.command.args;
  if (!subcommand || subcommand === "list") {
    return formatTodos(workflow.todos);
  }
  if (subcommand === "add") {
    return formatTodos(addTodo(workflow, rest.join(" ")));
  }
  if (subcommand === "clear") {
    return formatTodos(clearTodos(workflow));
  }

  const status = subcommand === "done" ? "completed" : subcommand === "start" ? "in_progress" : subcommand;
  const number = Number(rest[0]);
  const result = updateTodoStatus(workflow, number, status);
  return result.ok ? formatTodos(result.todos) : formatObject(result);
}

/**
 * @param {Parameters<typeof runSlashCommand>[0]} options
 */
function runPlanCommand(options) {
  const workflow = options.workflowState;
  if (!workflow) {
    return "/plan is reserved for interactive sessions.";
  }

  const [subcommand, ...rest] = options.command.args;
  if (!subcommand || subcommand === "show") {
    return formatPlan(workflow.plan);
  }
  if (subcommand === "clear") {
    return formatPlan(clearPlan(workflow));
  }
  if (subcommand === "set") {
    const steps = splitPlanSteps(rest);
    if (steps.length === 0) {
      return "Usage: /plan set <step one> | <step two>";
    }
    return formatPlan(setPlanSteps(workflow, steps));
  }

  return "Usage: /plan | /plan set <step one> | <step two> | /plan clear";
}

/**
 * @param {Array<Record<string, any>>} todos
 */
function formatTodos(todos) {
  if (!Array.isArray(todos) || todos.length === 0) {
    return "No todos.";
  }
  return todos.map((todo, index) => `${index + 1}. [${todo.status}] ${todo.content}`).join("\n");
}

/**
 * @param {{ explanation?: string; steps?: Array<Record<string, any>> }} plan
 */
function formatPlan(plan) {
  const lines = [];
  if (plan?.explanation) {
    lines.push(plan.explanation);
  }
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  if (steps.length === 0) {
    lines.push("No plan steps.");
  } else {
    lines.push(...steps.map((step, index) => `${index + 1}. [${step.status}] ${step.content}`));
  }
  return lines.join("\n");
}

/**
 * @param {Array<Record<string, any>>} changes
 */
function formatRecordedChanges(changes) {
  if (!Array.isArray(changes) || changes.length === 0) {
    return "No recorded file edits in this session.";
  }
  return changes.map((change, index) => {
    const flags = [
      change.created ? "created" : null,
      change.edited ? "edited" : null,
      change.diffTruncated ? "diff-truncated" : null
    ].filter(Boolean).join(", ") || "changed";
    return `${index + 1}. ${change.path} (${change.toolName}, ${flags}, ${change.diffBytes ?? 0} diff bytes)`;
  }).join("\n");
}

/**
 * @param {Array<Record<string, any>>} validations
 */
function formatValidations(validations) {
  if (!Array.isArray(validations) || validations.length === 0) {
    return "No validation commands recorded.";
  }
  return validations.map((validation, index) => {
    const state = validation.passed ? "passed" : "failed";
    const timeout = validation.timedOut ? ", timed out" : "";
    return `${index + 1}. [${state}] ${validation.command} (exit=${validation.exitCode ?? "null"}${timeout}, ${validation.durationMs ?? "unknown"}ms)`;
  }).join("\n");
}

/**
 * @param {Record<string, any> | undefined} context
 */
function formatContextSummary(context) {
  if (!context) {
    return "not-attached";
  }
  const messages = Number.isFinite(context.messages) ? context.messages : 0;
  const maxMessages = Number.isFinite(context.maxMessages) ? context.maxMessages : "?";
  const tokens = Number.isFinite(context.promptTokens)
    ? context.promptTokens
    : Number.isFinite(context.messageTokens) ? context.messageTokens : 0;
  const transcriptTokens = Number.isFinite(context.messageTokens) ? context.messageTokens : 0;
  const maxTokens = Number.isFinite(context.maxTokens) ? context.maxTokens : "?";
  const modelMaxTokens = Number.isFinite(context.modelMaxTokens) ? context.modelMaxTokens : null;
  const primaryMaxTokens = modelMaxTokens ?? maxTokens;
  const compacted = Number.isFinite(context.compacted) ? context.compacted : 0;
  const summaryTokens = Number.isFinite(context.summaryTokens) ? context.summaryTokens : 0;
  const localLimit = modelMaxTokens ? `, localLimit=${formatTokenCount(maxTokens)}` : "";
  const provider = Number.isFinite(context.providerPromptTokens)
    ? `, provider=${formatProviderUsageBrief({
        promptTokens: context.providerPromptTokens,
        completionTokens: context.providerCompletionTokens,
        totalTokens: context.providerTotalTokens
      })}`
    : "";
  return `modelInput=${formatTokenCount(tokens)}/${formatTokenCount(primaryMaxTokens)} estimated${localLimit}${provider}, transcript=${formatTokenCount(transcriptTokens)}, messages=${messages}/${maxMessages}, compactions=${compacted}, summaryTokens=${formatTokenCount(summaryTokens)}`;
}

function formatProviderUsageCommandLines(usage = {}) {
  return [
    ...formatKeyValues([
      ["reports", usage.reports],
      ["total", formatProviderUsageBrief({
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens
      })],
      ["last", formatProviderUsageBrief({
        promptTokens: usage.lastPromptTokens,
        completionTokens: usage.lastCompletionTokens,
        totalTokens: usage.lastTotalTokens
      })],
      ["last round", usage.lastRound ?? "unknown"],
      ["last model", usage.lastModel ?? "unknown"]
    ]).split("\n"),
    usage.last ? `last raw usage: ${truncatePlain(JSON.stringify(usage.last), 220)}` : null
  ].filter(Boolean).join("\n");
}

function formatProviderUsageBrief(usage = {}) {
  const parts = [
    Number.isFinite(usage.promptTokens) ? `input ${formatTokenCount(usage.promptTokens)}` : null,
    Number.isFinite(usage.completionTokens) ? `output ${formatTokenCount(usage.completionTokens)}` : null,
    Number.isFinite(usage.totalTokens) ? `total ${formatTokenCount(usage.totalTokens)}` : null
  ].filter(Boolean);
  return parts.length > 0 ? `${parts.join(" / ")} tokens` : "provider did not report token fields";
}

function formatTokenCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return "?";
  }
  if (number >= 1000000) {
    return `${Math.round(number / 100000) / 10}M`;
  }
  if (number >= 1000) {
    return `${Math.round(number / 100) / 10}k`;
  }
  return String(number);
}

function truncatePlain(value, max = 80) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3))}...`;
}

/**
 * @param {{ readonly?: boolean; allowWrite?: boolean; allowCommand?: boolean; fullAccess?: boolean }} options
 */
function inferPermissionMode(options) {
  const session = options.sessionInfo ?? {};
  if (session.permissionMode) {
    return normalizePermissionModeValue(session.permissionMode);
  }
  if (session.fullAccess ?? options.fullAccess) {
    return "fullAccess";
  }
  if (Boolean(session.allowWrite ?? options.allowWrite) || Boolean(session.allowCommand ?? options.allowCommand)) {
    return "workspace";
  }
  return "plan";
}

/**
 * @param {Parameters<typeof runSlashCommand>[0]} options
 */
function resolvePermissionState(options) {
  const session = options.sessionInfo ?? {};
  const permissionMode = inferPermissionMode(options);
  const permissionReadonlyLocked = Boolean(session.permissionReadonlyLocked ?? session.readonly ?? options.readonly);
  const fullAccess = permissionMode === "fullAccess";
  const workspace = permissionMode === "workspace";
  const readonly = permissionReadonlyLocked && permissionMode === "plan";
  return {
    permissionMode,
    permissionReadonlyLocked,
    readonly,
    allowWrite: workspace || fullAccess,
    allowCommand: workspace || fullAccess,
    fullAccess
  };
}

function normalizePermissionModeValue(value) {
  const mode = String(value ?? "").trim();
  if (mode === "fullAccess" || mode === "full-access" || mode === "完全访问") {
    return "fullAccess";
  }
  if (mode === "workspace" || mode === "workspacePermissions" || mode === "bypassPermissions" || mode === "acceptEdits" || mode === "工作区权限") {
    return "workspace";
  }
  return "plan";
}

/**
 * @param {string[]} parts
 */
function splitPlanSteps(parts) {
  return parts.join(" ")
    .split("|")
    .map((step) => step.trim())
    .filter(Boolean);
}

/**
 * @param {Parameters<typeof runSlashCommand>[0]} options
 * @param {Record<string, any>} config
 */
function createPolicy(options, config) {
  const permission = resolvePermissionState(options);
  return {
    workspace: options.cwd,
    permissionMode: permission.permissionMode,
    networkMode: config.networkMode,
    allowedHosts: config.allowedHosts,
    readonly: permission.readonly,
    fullAccess: permission.fullAccess,
    approvals: {
      workspaceWrites: permission.allowWrite,
      workspaceCommands: permission.allowCommand
    }
  };
}

function createPermissionOptions(options) {
  return resolvePermissionState(options);
}

/**
 * @param {Record<string, string>} entry
 */
function formatFileEntry(entry) {
  const prefix = entry.type === "directory" ? "[dir] " : entry.type === "file" ? "      " : "[oth] ";
  return `${prefix}${entry.name}`;
}

/**
 * @param {string[]} args
 * @param {string} cwd
 */
function parseDiffArgs(args, cwd) {
  const pathspecs = [];
  let stat = false;
  const workspace = path.resolve(cwd);

  for (const arg of args) {
    if (!arg) {
      continue;
    }
    if (arg === "--stat") {
      stat = true;
      continue;
    }
    if (arg.startsWith("-")) {
      return { ok: false, message: "Usage: /diff [--stat] [path ...]" };
    }

    const resolved = path.resolve(workspace, arg);
    if (!isInside(workspace, resolved)) {
      return { ok: false, message: "Diff path resolves outside the workspace." };
    }
    pathspecs.push(arg);
  }

  return { ok: true, stat, pathspecs };
}

/**
 * @param {{ name: string; args: string[]; raw: string }} command
 */
function parseRunArgs(command) {
  let raw = command.raw.slice(command.name.length + 1).trim();
  let toolName = process.platform === "win32" ? "powershell" : "bash";

  if (raw.startsWith("--powershell ")) {
    toolName = "powershell";
    raw = raw.slice("--powershell ".length).trim();
  } else if (raw.startsWith("--bash ")) {
    toolName = "bash";
    raw = raw.slice("--bash ".length).trim();
  }

  return { toolName, command: raw };
}

/**
 * @param {string[]} args
 */
function parseEditArgs(args) {
  const dryRun = args[0] === "--dry-run";
  const parts = dryRun ? args.slice(1) : args;
  const separator = parts.indexOf("=>");
  if (parts.length < 4 || separator <= 1 || separator === parts.length - 1) {
    return { ok: false };
  }

  const [filePath, ...oldParts] = parts.slice(0, separator);
  return {
    ok: true,
    dryRun,
    path: filePath,
    oldText: oldParts.join(" "),
    newText: parts.slice(separator + 1).join(" ")
  };
}

/**
 * @param {Record<string, any>} execution
 */
function formatShellExecution(execution) {
  if (!execution.ok) {
    return formatObject(execution);
  }

  return formatProcessResult(execution.result, "Command completed without output.");
}

/**
 * @param {{ exitCode: number | null; signal?: string | null; timedOut?: boolean; durationMs?: number; stdout?: string; stderr?: string; stdoutTruncated?: boolean; stderrTruncated?: boolean; error?: Record<string, any> }} result
 * @param {string} emptyMessage
 */
function formatProcessResult(result, emptyMessage) {
  const lines = [
    `exit: ${result.exitCode ?? "null"}${result.signal ? ` signal=${result.signal}` : ""}${result.timedOut ? " timed-out" : ""}`
  ];

  if (result.error) {
    lines.push("error:", formatObject(result.error));
  }
  if (result.stdout) {
    lines.push(`stdout${result.stdoutTruncated ? " (truncated)" : ""}:`, result.stdout.trimEnd());
  }
  if (result.stderr) {
    lines.push(`stderr${result.stderrTruncated ? " (truncated)" : ""}:`, result.stderr.trimEnd());
  }
  if (!result.error && !result.stdout && !result.stderr) {
    lines.push(emptyMessage);
  }

  return lines.join("\n");
}

/**
 * @param {string} executable
 * @param {string[]} args
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv | undefined} env
 * @param {AbortSignal | undefined} signal
 */
function runProcess(executable, args, cwd, env, signal = undefined) {
  const startedAt = Date.now();

  if (signal?.aborted) {
    return Promise.resolve(interruptedProcessResult(startedAt, "Process was interrupted before it started."));
  }

  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(executable, args, {
      cwd,
      env: env ?? process.env,
      windowsHide: true,
      detached: process.platform !== "win32"
    });

    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    let interrupted = false;
    let escalationTimer = null;

    const timeout = setTimeout(() => {
      timedOut = true;
      requestProcessTermination(child);
    }, DEFAULT_SLASH_PROCESS_TIMEOUT_MS);

    const onAbort = () => {
      interrupted = true;
      requestProcessTermination(child);
    };

    function requestProcessTermination(target) {
      if (!target.pid) {
        target.kill("SIGTERM");
        return;
      }
      if (process.platform === "win32") {
        killWindowsProcessTree(target.pid);
        target.kill("SIGTERM");
        return;
      }
      try {
        process.kill(-target.pid, "SIGTERM");
      } catch {
        target.kill("SIGTERM");
      }
      if (!escalationTimer) {
        escalationTimer = setTimeout(() => {
          try {
            process.kill(-target.pid, "SIGKILL");
          } catch {
            target.kill("SIGKILL");
          }
        }, 750);
      }
    }

    /**
     * @param {Record<string, any>} result
     */
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (escalationTimer) {
        clearTimeout(escalationTimer);
        escalationTimer = null;
      }
      signal?.removeEventListener?.("abort", onAbort);
      resolve(result);
    };

    signal?.addEventListener?.("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk) => {
      stdout = appendBounded(stdout, Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendBounded(stderr, Buffer.from(chunk));
    });
    child.on("error", (error) => {
      finish({
        exitCode: null,
        signal: null,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        error: {
          code: error && typeof error === "object" && "code" in error ? String(error.code) : "PROCESS_SPAWN_ERROR",
          message: error instanceof Error ? error.message : String(error)
        },
        ...(interrupted ? interruptedProcessFields("Process was interrupted by the local user.") : {})
      });
    });

    child.on("spawn", () => {
      if (signal?.aborted) {
        onAbort();
      }
    });

    child.on("close", (exitCode, signal) => {
      finish({
        exitCode,
        signal,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        stdoutTruncated: stdout.length >= MAX_SLASH_OUTPUT_BYTES,
        stderrTruncated: stderr.length >= MAX_SLASH_OUTPUT_BYTES,
        ...(interrupted ? interruptedProcessFields("Process was interrupted by the local user.") : {})
      });
    });
  });
}

function interruptedProcessResult(startedAt, message) {
  return {
    exitCode: null,
    signal: null,
    timedOut: false,
    durationMs: Date.now() - startedAt,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    ...interruptedProcessFields(message)
  };
}

function interruptedProcessFields(message) {
  return {
    interrupted: true,
    error: { code: "PROCESS_INTERRUPTED", message }
  };
}

/**
 * @param {number} pid
 */
function killWindowsProcessTree(pid) {
  try {
    const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
      windowsHide: true,
      stdio: "ignore"
    });
    killer.unref?.();
  } catch {
    // child.kill fallback is attempted by the caller.
  }
}

/**
 * @param {Buffer} current
 * @param {Buffer} chunk
 */
function appendBounded(current, chunk) {
  if (current.length >= MAX_SLASH_OUTPUT_BYTES) {
    return current;
  }
  const remaining = MAX_SLASH_OUTPUT_BYTES - current.length;
  return Buffer.concat([current, chunk.subarray(0, remaining)]);
}

/**
 * @param {Parameters<typeof runSlashCommand>[0]} options
 * @param {Record<string, any>} config
 */
async function runMcpCommand(options, config) {
  const runtime = createMcpRuntime({
    cwd: options.cwd,
    config,
    policy: createPolicy(options, config),
    approve: options.approvalCallback
  });

  const [subcommand, serverName, toolName, rawArgs] = options.command.args;
  try {
  if (!subcommand) {
    const servers = runtime.listServers();
    return servers.length === 0
      ? [
        "Ant Code MCP",
        "",
        "当前没有配置 MCP 服务器。",
        "",
        "配置入口：lab-agent.config.json 的 mcp.servers。",
        "边界：只支持显式配置的本地/受控 stdio MCP；不会自动发现第三方托管或 marketplace 后台。"
      ].join("\n")
      : [
        "Ant Code MCP",
        "",
        ...servers.map((server) => `- ${server.name} (${server.transport}, ${server.status})${server.description ? ` - ${server.description}` : ""}`),
        "",
        "用法",
        "- /mcp doctor",
        "- /mcp status [server]",
        "- /mcp tools <server>",
        "- /mcp prompts <server>",
        "- /mcp resources <server>",
        "- /mcp read-resource <server> <uri>",
        "- /mcp call <server> <tool> '{\"key\":\"value\"}'",
        "- /mcp reconnect <server>"
      ].join("\n");
  }

  if (subcommand === "status") {
    return formatObject(runtime.status(serverName ?? null));
  }

  if (subcommand === "doctor") {
    return formatMcpDoctor(await runMcpDoctor(config, runtime, { live: options.command.args.includes("--live") }));
  }

  if (subcommand === "prompts" && serverName) {
    const result = await runtime.listPrompts(serverName);
    return formatObject(result);
  }

  if (subcommand === "resources" && serverName) {
    const result = await runtime.listResources(serverName);
    return formatObject(result);
  }

  if (subcommand === "read-resource" && serverName && toolName) {
    const result = await runtime.readResource(serverName, toolName);
    return formatObject(result);
  }

  if (subcommand === "tools" && serverName) {
    const result = await runtime.listTools(serverName);
    return result.ok ? formatObject(result.tools) : formatObject(result);
  }

  if (subcommand === "reconnect" && serverName) {
    return formatObject(await runtime.reconnect(serverName));
  }

  if (subcommand === "disconnect" && serverName) {
    return formatObject(await runtime.disconnect(serverName));
  }

  if (subcommand === "call" && serverName && toolName) {
    const args = rawArgs ? JSON.parse(rawArgs) : {};
    const result = await runtime.callTool(serverName, toolName, args);
    return formatObject(result);
  }

  return "Usage: /mcp | /mcp doctor [--live] | /mcp status [server] | /mcp tools <server> | /mcp prompts <server> | /mcp resources <server> | /mcp read-resource <server> <uri> | /mcp call <server> <tool> '{\"key\":\"value\"}' | /mcp reconnect <server>";
  } finally {
    runtime.close();
  }
}

async function runMcpDoctor(config, runtime, options = {}) {
  const rawServers = Array.isArray(config.mcp?.servers) ? config.mcp.servers : [];
  const visible = runtime.listServers();
  const checks = [];
  for (const server of visible) {
    const raw = rawServers.find((item) => item.name === server.name) ?? server;
    const enabled = raw.enabled !== false && raw.disabled !== true;
    if (!enabled) {
      checks.push({
        name: server.name,
        status: "disabled",
        command: raw.command ?? "",
        message: raw.description ?? "MCP server is disabled",
        tools: []
      });
      continue;
    }
    const commandCheck = await checkCommandAvailable(raw.command);
    if (!commandCheck.ok) {
      checks.push({
        name: server.name,
        status: "missing",
        command: raw.command ?? "",
        message: commandCheck.message,
        tools: []
      });
      continue;
    }
    if (!options.live) {
      checks.push({
        name: server.name,
        status: "ready",
        command: raw.command ?? "",
        message: `${commandCheck.message}; not launched`,
        tools: []
      });
      continue;
    }
    const tools = await runtime.listTools(server.name);
    checks.push({
      name: server.name,
      status: tools.ok ? "ok" : "error",
      command: raw.command ?? "",
      message: tools.ok ? `${tools.tools.length} tool(s) discovered` : tools.error?.message ?? "failed to list tools",
      tools: tools.ok ? tools.tools.map((tool) => tool.name).slice(0, options.live ? 80 : 12) : []
    });
  }
  return {
    ok: checks.every((check) => check.status !== "error" && check.status !== "missing"),
    servers: checks,
    note: options.live
      ? "Live MCP doctor launched enabled servers and discovered tools where possible."
      : "普通 /mcp doctor 只检查配置和启动命令，不拉起 MCP 进程；需要工具发现时运行 /mcp doctor --live。"
  };
}

function formatMcpDoctor(report) {
  return [
    "Ant Code MCP doctor",
    "",
    ...report.servers.map((server) => {
      const tools = server.tools.length ? ` tools=${server.tools.join(",")}` : "";
      return `- [${server.status}] ${server.name}: ${server.message}${tools}`;
    }),
    "",
    report.note
  ].join("\n");
}

async function checkCommandAvailable(command) {
  const name = String(command ?? "").trim();
  if (!name) {
    return { ok: false, message: "MCP command is missing" };
  }
  const candidates = process.platform === "win32" && !/\.(exe|cmd|bat)$/i.test(name)
    ? [name, `${name}.cmd`, `${name}.exe`]
    : [name];
  for (const candidate of candidates) {
    const result = process.platform === "win32"
      ? await runProcess("where.exe", [candidate], process.cwd(), process.env)
      : await runProcess("sh", ["-c", `command -v ${shellQuote(candidate)}`], process.cwd(), process.env);
    if (result.exitCode === 0) {
      return { ok: true, message: `${candidate} found` };
    }
  }
  const result = process.platform === "win32"
    ? await runProcess("where.exe", [name], process.cwd(), process.env)
    : await runProcess("sh", ["-c", `command -v ${shellQuote(name)}`], process.cwd(), process.env);
  return result.exitCode === 0
    ? { ok: true, message: `${name} found` }
    : { ok: false, message: `${name} was not found on PATH` };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * @param {Parameters<typeof runSlashCommand>[0]} options
 */
async function runMemoryCommand(options, config) {
  const [subcommand, ...rest] = options.command.args;
  if (subcommand === "add") {
    const input = { text: rest.join(" ") };
    const definition = {
      name: "add_project_memory",
      risk: "memory",
      description: "Append a project memory entry to .lab-agent/memory.md"
    };
    const decision = decidePermission(
      {
        toolName: definition.name,
        risk: definition.risk,
        cwd: options.cwd,
        targetPaths: [path.join(".lab-agent", "memory.md")],
        summary: definition.description
      },
      createPolicy(options, config)
    );
    if (decision.decision === "ask" && options.approvalCallback) {
      const approved = await options.approvalCallback({
        toolName: definition.name,
        input,
        decision,
        definition
      });
      if (!approved) {
        return formatObject({ ok: false, blocked: true, decision });
      }
    } else if (decision.decision !== "allow") {
      return formatObject({ ok: false, blocked: true, decision });
    }
    return formatObject(await appendProjectMemory({
      cwd: options.cwd,
      text: input.text
    }));
  }

  const manifest = await loadProjectMemoryManifest({ cwd: options.cwd });
  const lines = ["Ant Code memory"];
  if (manifest.activeRule) {
    lines.push(`主项目规则：${manifest.activeRule.name} (${Buffer.byteLength(manifest.activeRule.content, "utf8")} bytes)`);
  } else {
    lines.push("主项目规则：未找到");
  }
  if (manifest.skippedRules.length > 0) {
    lines.push(`已跳过兼容文件：${manifest.skippedRules.map((item) => item.name).join(", ")}`);
  }
  if (manifest.localMemory) {
    lines.push(`本地记忆：${manifest.localMemory.name} (${Buffer.byteLength(manifest.localMemory.content, "utf8")} bytes)`);
  } else {
    lines.push("本地记忆：未找到");
  }
  if (!manifest.activeRule && !manifest.localMemory) {
    lines.push("提示：可创建 ANTCODE.md 存放项目稳定规则，或使用 /memory add <内容> 追加本地记忆。");
  }
  return lines.join("\n");
}

/**
 * @param {Parameters<typeof runSlashCommand>[0]} options
 * @param {Record<string, any>} config
 */
async function runPermissionsCommand(options, config) {
  const [subcommand, action] = options.command.args;
  if (subcommand === "trust" && action === "reset") {
    return formatObject(await revokeWorkspaceTrust({
      cwd: options.cwd,
      env: options.env
    }));
  }
  if (subcommand === "trust" && (!action || action === "list")) {
    return formatObject({
      workspaces: await listTrustedWorkspaces({ env: options.env })
    });
  }
  if (subcommand === "trust") {
    return "Usage: /permissions trust list | /permissions trust reset";
  }

  const permission = resolvePermissionState(options);
  return formatObject({
    mode: permission.permissionMode,
    permissionReadonlyLocked: permission.permissionReadonlyLocked,
    readonly: permission.readonly,
    workspaceWrites: permission.allowWrite,
    workspaceCommands: permission.allowCommand,
    fullAccess: permission.fullAccess,
    networkMode: config.networkMode,
    allowedHosts: config.allowedHosts,
    modes: [
      "plan: 写入、命令、MCP、浏览器和联网能力需要确认",
      "workspace: 工作区内非敏感写入和常规本地命令自动同意",
      "fullAccess: 测试机模式，所有本地工具、MCP、浏览器、网络和任意路径操作自动同意"
    ],
    trustCommands: [
      "/permissions trust list",
      "/permissions trust reset"
    ]
  });
}

/**
 * @param {Parameters<typeof runSlashCommand>[0]} options
 */
async function runAgentsCommand(options, config) {
  const [subcommand, profileName, ...queryParts] = options.command.args;
  if (!subcommand) {
    return [
      "Ant Code 子智能体",
      "",
      ...listAgentProfiles(config, { cwd: options.cwd }).map((profile) => {
        const aliases = profile.aliases?.length ? ` aliases=${profile.aliases.join(",")}` : "";
        const hidden = profile.hidden ? " hidden" : "";
        const source = profile.source ? ` source=${profile.source}` : "";
        return `- ${profile.name} [${profile.mode}]${aliases}${hidden}${source} - ${profile.description}`;
      }),
      "",
      "用法",
      "- /agents run explorer <问题>",
      "- /agents run planner <任务>",
      "- /agents run verifier <验证目标>",
      "- /agents run visual-verifier <截图或视觉复核目标>",
      "- /agents run code-worker <局部修改任务>",
      "- /agents route <任务>",
      "- /agents orchestrate <任务>",
      "- /agents tasks",
      "- /agents groups",
      "- /agents group <group-id>",
      "- /agents wake <group-id>",
      "- /agents task <task-id>",
      "- /agents resume <task-id>",
      "- /agents continue <task-id>",
      "- /agents review <task-id>",
      "- /agents cancel <task-id>",
      "",
      "边界：子智能体使用同一个本地模型网关和本地权限引擎；写文件、执行命令、MCP 调用仍受父会话策略约束。"
    ].join("\n");
  }

  if (subcommand === "tasks") {
    const store = createAgentTaskStore({ cwd: options.cwd });
    const tasks = await store.listTasks();
    return formatTaskTree(tasks);
  }

  if (subcommand === "groups") {
    const store = createAgentTaskGroupStore({ cwd: options.cwd });
    return formatAgentGroups(await store.listGroups());
  }

  if ((subcommand === "group" || subcommand === "show-group") && profileName) {
    const store = createAgentTaskGroupStore({ cwd: options.cwd });
    const result = await store.readGroup(profileName);
    return result.ok ? formatObject(result.group) : formatObject(result);
  }

  if ((subcommand === "wake" || subcommand === "wake-group") && profileName) {
    const groupStore = createAgentTaskGroupStore({ cwd: options.cwd });
    const taskStore = createAgentTaskStore({ cwd: options.cwd });
    const read = await groupStore.readGroup(profileName);
    if (!read.ok) {
      return formatObject(read);
    }
    const tasks = [];
    for (const taskId of read.group.taskIds) {
      const task = await taskStore.readTask(taskId);
      if (task.ok) {
        tasks.push(task.task);
      }
    }
    const wakePrompt = buildSubagentGroupWakePrompt({
      group: read.group,
      tasks,
      maxBytes: config.agents?.backgroundWakeup?.maxWakeSummaryBytes
    });
    await groupStore.updateGroup(profileName, {
      wakePrompt,
      wakePromptQueuedAt: new Date().toISOString(),
      latestProgress: "用户手动生成主控续跑提示"
    });
    return wakePrompt;
  }

  if ((subcommand === "cancel-group" || subcommand === "cancelgroup") && profileName) {
    const groupStore = createAgentTaskGroupStore({ cwd: options.cwd });
    const taskStore = createAgentTaskStore({ cwd: options.cwd });
    const read = await groupStore.readGroup(profileName);
    if (!read.ok) {
      return formatObject(read);
    }
    const aborted = cancelBackgroundAgentTasks({
      parentSessionId: options.sessionInfo?.id ?? read.group.parentSessionId ?? null,
      groupId: profileName
    });
    for (const taskId of read.group.taskIds) {
      await taskStore.updateTask(taskId, {
        status: "cancelled",
        cancelRequestedAt: new Date().toISOString(),
        latestProgress: aborted.some((task) => task.taskId === taskId)
          ? "用户已请求取消任务组；当前进程内后台 controller 已中止。"
          : "用户已请求取消任务组。"
      });
    }
    const result = await groupStore.updateGroup(profileName, {
      status: "cancelled",
      completedAt: new Date().toISOString(),
      latestProgress: aborted.length > 0
        ? `用户已请求取消任务组；已中止 ${aborted.length} 个当前进程后台任务。`
        : "用户已请求取消任务组。"
    });
    return formatObject({
      ...result,
      abortedBackgroundTasks: aborted.map((task) => task.taskId)
    });
  }

  if ((subcommand === "task" || subcommand === "resume" || subcommand === "show") && profileName) {
    const store = createAgentTaskStore({ cwd: options.cwd });
    const result = await store.readTask(profileName);
    return result.ok ? formatObject(result.task) : formatObject(result);
  }

  if ((subcommand === "continue" || subcommand === "续跑") && profileName) {
    const store = createAgentTaskStore({ cwd: options.cwd });
    const read = await store.readTask(profileName);
    if (!read.ok) {
      return formatObject(read);
    }
    const task = read.task;
    if (!task.continuationPrompt) {
      return `任务 ${profileName} 没有可续跑的 continuationPrompt。`;
    }
    const permission = createPermissionOptions(options);
    const result = await runSubagent({
      cwd: options.cwd,
      config,
      env: options.env,
      readonly: permission.readonly,
      allowWrite: permission.allowWrite,
      allowCommand: permission.allowCommand,
      fullAccess: permission.fullAccess,
      workflowState: options.workflowState,
      approvalCallback: options.approvalCallback,
      parentSessionId: options.sessionInfo?.id ?? task.parentSessionId ?? null,
      hooksTrusted: options.trusted === true,
      parentTaskId: task.parentTaskId ?? task.id,
      profileName: task.profile,
      title: `${task.title || task.profile} - 续跑`,
      routeDecision: task.routeDecision ?? undefined,
      contextPack: task.contextPack ?? undefined,
      query: task.continuationPrompt
    });
    return formatObject(result);
  }

  if (subcommand === "review" && profileName) {
    const store = createAgentTaskStore({ cwd: options.cwd });
    const read = await store.readTask(profileName);
    if (!read.ok) {
      return formatObject(read);
    }
    const task = read.task;
    const result = await runSubagent({
      cwd: options.cwd,
      config,
      env: options.env,
      readonly: true,
      allowWrite: false,
      allowCommand: false,
      fullAccess: false,
      workflowState: options.workflowState,
      approvalCallback: options.approvalCallback,
      parentSessionId: options.sessionInfo?.id ?? task.parentSessionId ?? null,
      hooksTrusted: options.trusted === true,
      parentTaskId: task.id,
      profileName: "reviewer",
      title: `严格复核 ${task.title || task.profile}`,
      routeDecision: {
        profile: "reviewer",
        purpose: "review",
        difficulty: "standard",
        risk: task.risk === "high" ? "high" : "medium",
        modelTier: "strong"
      },
      contextPack: {
        task: `严格复核任务 ${task.id}`,
        knownFacts: [
          `profile=${task.profile}`,
          `status=${task.status}`,
          `model=${task.model ?? "unknown"}`,
          task.outputSummary ? `summary=${task.outputSummary}` : ""
        ].filter(Boolean),
        acceptance: ["优先找 bug、权限风险、测试缺口；不要修改文件。"]
      },
      query: [
        `请严格复核子任务 ${task.id} 的结果，不要修改文件。`,
        "",
        "任务记录：",
        JSON.stringify({
          id: task.id,
          profile: task.profile,
          status: task.status,
          prompt: task.prompt,
          latestProgress: task.latestProgress,
          outputSummary: task.outputSummary,
          error: task.error,
          toolCalls: task.toolCalls
        }, null, 2)
      ].join("\n")
    });
    return formatObject(result);
  }

  if (subcommand === "cancel" && profileName) {
    const store = createAgentTaskStore({ cwd: options.cwd });
    const result = await store.updateTask(profileName, {
      status: "cancelled",
      cancelRequestedAt: new Date().toISOString(),
      latestProgress: "用户已请求取消；同步任务会在下一次可中断边界停止。"
    });
    return formatObject(result);
  }

  if (subcommand === "run" && profileName) {
    const parsed = parseAgentRunQuery(queryParts);
    const permission = createPermissionOptions(options);
    const result = await runSubagent({
      cwd: options.cwd,
      config,
      env: options.env,
      readonly: permission.readonly,
      allowWrite: permission.allowWrite,
      allowCommand: permission.allowCommand,
      fullAccess: permission.fullAccess,
      workflowState: options.workflowState,
      approvalCallback: options.approvalCallback,
      parentSessionId: options.sessionInfo?.id ?? null,
      hooksTrusted: options.trusted === true,
      profileName,
      writeScope: parsed.writeScope,
      acceptance: parsed.acceptance,
      query: parsed.query
    });
    return formatObject(result);
  }

  if ((subcommand === "route" || subcommand === "plan-route") && profileName) {
    const prompt = [profileName, ...queryParts].join(" ");
    return formatAgentRoute(routeAgentTask({
      cwd: options.cwd,
      config,
      prompt
    }));
  }

  if ((subcommand === "orchestrate" || subcommand === "dispatch") && profileName) {
    const prompt = [profileName, ...queryParts].join(" ");
    const permission = createPermissionOptions(options);
    const result = await orchestrateAgentTasks({
      cwd: options.cwd,
      config,
      env: options.env,
      prompt,
      readonly: permission.readonly,
      allowWrite: permission.allowWrite,
      allowCommand: permission.allowCommand,
      fullAccess: permission.fullAccess,
      workflowState: options.workflowState,
      approvalCallback: options.approvalCallback,
      parentSessionId: options.sessionInfo?.id ?? null,
      hooksTrusted: options.trusted === true
    });
    return formatObject(result);
  }

  return "Usage: /agents | /agents tasks | /agents groups | /agents group <group-id> | /agents wake <group-id> | /agents task <task-id> | /agents resume <task-id> | /agents continue <task-id> | /agents review <task-id> | /agents cancel <task-id> | /agents cancel-group <group-id> | /agents route <query> | /agents orchestrate <query> | /agents run <profile> <query>";
}

function parseAgentRunQuery(parts) {
  const raw = parts.join(" ").trim();
  const writeScope = [];
  const acceptance = [];
  const cleaned = raw.replace(/--write-scope\s+([^\s]+)/g, (_, value) => {
    writeScope.push(value);
    return "";
  }).replace(/--accept\s+("[^"]+"|'[^']+'|[^\s]+)/g, (_, value) => {
    acceptance.push(String(value).replace(/^['"]|['"]$/g, ""));
    return "";
  }).trim();
  return {
    query: cleaned,
    writeScope,
    acceptance
  };
}

function formatAgentTasks(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return "暂无本地子智能体任务记录。";
  }
  return [
    "Ant Code 子任务",
    "",
    ...tasks.slice(0, 40).map((task) => {
      const tools = task.toolCalls?.length ? ` tools=${task.toolCalls.length}` : "";
      const parent = task.parentSessionId ? ` parent=${task.parentSessionId.slice(0, 8)}` : "";
      return `- ${task.id} [${formatAgentRecordStatus(task.status)}] ${task.profile}${parent}${tools} - ${truncatePlain(task.prompt, 80)} (${task.updatedAt ?? "unknown"})`;
    }),
    "",
    "使用 /agents task <task-id> 查看完整任务记录；/agents continue <task-id> 续跑阶段暂停任务。"
  ].join("\n");
}

function formatAgentGroups(groups) {
  if (!Array.isArray(groups) || groups.length === 0) {
    return "暂无本地子智能体任务组记录。";
  }
  return [
    "Ant Code 子任务组",
    "",
    ...groups.slice(0, 40).map((group) => {
      const wake = group.wakePromptQueuedAt ? "唤醒=已排队" : group.wakeParent ? "唤醒=自动" : "唤醒=关闭";
      return `- ${group.id} [${formatAgentRecordStatus(group.status)}] tasks=${group.taskIds.length} ${wake} - ${truncatePlain(group.latestProgress || group.summary, 100)}`;
    }),
    "",
    "使用 /agents group <group-id> 查看完整任务组记录；/agents wake <group-id> 手动生成主控续跑提示。"
  ].join("\n");
}

function formatAgentRecordStatus(status) {
  const value = String(status ?? "unknown");
  if (value === "queued") {
    return "排队中";
  }
  if (value === "running") {
    return "运行中";
  }
  if (value === "partial") {
    return "阶段暂停";
  }
  if (value === "completed") {
    return "已完成";
  }
  if (value === "failed") {
    return "失败";
  }
  if (value === "blocked") {
    return "被阻止";
  }
  if (value === "cancelled") {
    return "已取消";
  }
  if (value === "interrupted") {
    return "已中断";
  }
  return value;
}

/**
 * @param {Parameters<typeof runSlashCommand>[0]} options
 */
async function runBackgroundCommand(options) {
  const [subcommand, taskId] = options.command.args;
  const store = createAgentTaskStore({ cwd: options.cwd });
  if (!subcommand || subcommand === "tasks" || subcommand === "list") {
    return formatTaskTree(await store.listTasks());
  }
  if ((subcommand === "show" || subcommand === "resume") && taskId) {
    const result = await store.readTask(taskId);
    return formatObject(result.ok ? result.task : result);
  }
  if (subcommand === "task" && taskId) {
    const result = await store.readTask(taskId);
    return formatObject(result.ok ? result.task : result);
  }
  if (subcommand === "cancel" && taskId) {
    return formatObject(await store.updateTask(taskId, {
      status: "cancelled",
      cancelRequestedAt: new Date().toISOString(),
      latestProgress: "用户已请求取消；若任务仍在当前 TUI 进程内运行，会在下一次可中断边界停止。"
    }));
  }
  if (subcommand === "worktree" && taskId) {
    const decision = decidePermission(
      {
        toolName: "background_worktree",
        risk: "execute",
        cwd: options.cwd,
        command: "git worktree add --detach .lab-agent/worktrees/<task-id> HEAD",
        summary: "Create a local git worktree for a background task"
      },
      createPolicy(options, await loadConfig({ cwd: options.cwd, env: options.env }))
    );
    if (decision.decision === "ask" && options.approvalCallback) {
      const approved = await options.approvalCallback({
        toolName: "background_worktree",
        input: { taskId },
        decision,
        definition: { name: "background_worktree", risk: "execute", description: "Create a local git worktree for a background task" }
      });
      if (!approved) {
        return formatObject({ ok: false, blocked: true, decision });
      }
    } else if (decision.decision !== "allow") {
      return formatObject({ ok: false, blocked: true, decision });
    }
    const result = createTaskWorktree({ cwd: options.cwd, taskId });
    if (result.ok) {
      await store.updateTask(taskId, {
        metadata: { worktreePath: result.relativePath },
        latestProgress: `已创建隔离 worktree：${result.relativePath}`
      });
    }
    return formatObject(result);
  }
  if (subcommand === "cleanup-worktree" && taskId) {
    const decision = decidePermission(
      {
        toolName: "background_cleanup_worktree",
        risk: "execute",
        cwd: options.cwd,
        command: "git worktree remove --force .lab-agent/worktrees/<task-id>",
        summary: "Remove a local git worktree for a background task"
      },
      createPolicy(options, await loadConfig({ cwd: options.cwd, env: options.env }))
    );
    if (decision.decision === "ask" && options.approvalCallback) {
      const approved = await options.approvalCallback({
        toolName: "background_cleanup_worktree",
        input: { taskId },
        decision,
        definition: { name: "background_cleanup_worktree", risk: "execute", description: "Remove a local git worktree for a background task" }
      });
      if (!approved) {
        return formatObject({ ok: false, blocked: true, decision });
      }
    } else if (decision.decision !== "allow") {
      return formatObject({ ok: false, blocked: true, decision });
    }
    return formatObject(removeTaskWorktree({ cwd: options.cwd, taskId }));
  }
  return [
    "Ant Code 后台任务",
    "",
    "TUI 内可用：/background run <profile> <任务>",
    "通用命令：",
    "- /background list",
    "- /background show <task-id>",
    "- /background cancel <task-id>",
    "- /background worktree <task-id>",
    "- /background cleanup-worktree <task-id>",
    "",
    "说明：后台 run 需要 TUI 进程管理 AbortController；非 TUI 模式只查看和管理记录。"
  ].join("\n");
}

/**
 * @param {Parameters<typeof runSlashCommand>[0]} options
 * @param {Record<string, any>} config
 */
async function runSkillsCommand(options, config) {
  const [subcommand, name, ...messageParts] = options.command.args;
  if (!subcommand || subcommand === "list") {
    return formatSkillsList({
      cwd: options.cwd,
      config,
      env: options.env
    });
  }

  if (subcommand === "doctor") {
    return formatSkillsDoctor(await runSkillsDoctor(options, config));
  }

  if ((subcommand === "show" || subcommand === "read") && name) {
    return formatSkillDetail({
      cwd: options.cwd,
      config,
      env: options.env,
      name
    });
  }

  if (subcommand === "run" && name) {
    const result = await runSkill({
      cwd: options.cwd,
      config,
      env: options.env,
      name,
      message: messageParts.join(" ")
    });
    return result.ok
      ? [
        `Skill: ${result.skill.name}`,
        "",
        `模式：${result.execution}`,
        `说明：${result.note}`,
        result.userMessage ? `任务：${result.userMessage}` : null,
        "",
        result.skill.content
      ].filter(Boolean).join("\n")
      : formatObject(result);
  }

  return "Usage: /skills | /skills list | /skills doctor | /skills show <name> | /skills run <name> <message>";
}

async function runSkillsDoctor(options, config) {
  const capabilities = await listCapabilities({
    cwd: options.cwd,
    config,
    env: options.env
  });
  const toolNames = new Set(getToolDefinitions().map((tool) => tool.name));
  const expected = ["web-research", "browser-automation", "document-intake", "project-intake", "bug-repro", "frontend-verifier", "release-review"];
  const skills = capabilities.skills;
  const checks = [];
  for (const name of expected) {
    const skill = skills.find((item) => item.name === name);
    checks.push({
      name,
      status: skill ? "ok" : "missing",
      message: skill ? skill.description : "expected bundled skill was not found"
    });
  }
  for (const skill of skills) {
    const unknownTools = skill.allowedTools.filter((tool) => !toolNames.has(tool));
    if (unknownTools.length > 0) {
      checks.push({
        name: skill.name,
        status: "warn",
        message: `unknown allowed tool(s): ${unknownTools.join(", ")}`
      });
    }
  }
  return {
    ok: checks.every((check) => check.status !== "missing"),
    skills: skills.length,
    checks
  };
}

function formatSkillsDoctor(report) {
  return [
    "Ant Code skills doctor",
    `skills: ${report.skills}`,
    "",
    ...report.checks.map((check) => `- [${check.status}] ${check.name}: ${check.message}`)
  ].join("\n");
}

/**
 * @param {Parameters<typeof runSlashCommand>[0]} options
 * @param {Record<string, any>} config
 */
async function runSessionsCommand(options, config) {
  const store = createSessionStore({
    cwd: options.cwd,
    transcript: config.transcript,
    env: options.env
  });
  const [subcommand, selector] = options.command.args;

  if (subcommand === "cleanup") {
    const result = await store.cleanupExpiredSessions(config.transcript?.retentionDays ?? 30);
    return formatObject(result);
  }

  if (subcommand === "show") {
    const result = await store.readMetadata(selector ?? "latest");
    return formatObject(result);
  }

  const sessions = await store.listSessionRecords();
  if (sessions.length === 0) {
    return "No local session metadata stored.";
  }
  return sessions.map((session) => (
    `${session.id} ${session.modifiedAt} ${session.encrypted ? "encrypted" : "plain"} ${session.path}`
  )).join("\n");
}

/**
 * @param {Record<string, any>} config
 */
function redactConfig(config) {
  return JSON.parse(JSON.stringify(config, (key, value) => {
    if (/token|secret|password|api_?key|apikey|credential|authorization/i.test(key) && value) {
      return "[redacted]";
    }
    return value;
  }));
}

/**
 * @param {unknown} value
 */
function formatObject(value) {
  return JSON.stringify(value, null, 2);
}
