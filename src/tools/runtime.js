import crypto from "node:crypto";
import path from "node:path";
import { registerBackgroundAgentTask } from "../agents/background-registry.js";
import { createAgentTaskStore } from "../agents/task-store.js";
import { createAgentTaskGroupStore, safeGroupId, summarizeGroupStatus } from "../agents/task-group-store.js";
import { buildSubagentGroupWakePrompt } from "../agents/wakeup.js";
import { decidePermission } from "../permissions/policy-engine.js";
import { getAgentProfile, listAgentProfileLabels } from "../agents/profiles.js";
import { loadConfig } from "../config/load-config.js";
import { collectHookTargetPaths } from "../hooks/events.js";
import { runHooks } from "../hooks/runner.js";
import { loadSkills, readSkill, runSkill } from "../skills/registry.js";
import { BUILT_IN_TOOLS } from "./definitions.js";
import { documentIntakeTool } from "./document-tools.js";
import { editFileTool, globTool, grepTool, listFilesTool, readFileTool, writeFileTool } from "./file-tools.js";
import {
  gitAddTool,
  gitBranchListTool,
  gitBranchTool,
  gitCommitTool,
  gitDiffTool,
  gitLogTool,
  gitShowTool,
  gitStashListTool,
  gitStashTool,
  gitStatusTool,
  gitTagListTool,
  gitTagTool
} from "./git-tools.js";
import { rgCountTool, rgFilesTool, rgFilesWithMatchesTool, rgSearchTool } from "./rg-tools.js";
import { tsDiagnosticsTool, tsFindDefinitionTool, tsFindReferencesTool, tsSymbolsTool } from "./semantic-tools.js";
import { backgroundShellTool, bashTool, powershellTool } from "./shell-tools.js";
import { networkHostsForWebTool, webFetchTool, webSearchTool } from "./web-tools.js";
import { createWorkflowState, planUpdateTool, recordFileChange, recordValidation, todoReadTool, todoWriteTool } from "./workflow-tools.js";

const HANDLERS = Object.freeze({
  read_file: readFileTool,
  list_files: listFilesTool,
  glob: globTool,
  grep: grepTool,
  rg_search: rgSearchTool,
  rg_files: rgFilesTool,
  rg_files_with_matches: rgFilesWithMatchesTool,
  rg_count: rgCountTool,
  ts_symbols: tsSymbolsTool,
  ts_diagnostics: tsDiagnosticsTool,
  ts_find_definition: tsFindDefinitionTool,
  ts_find_references: tsFindReferencesTool,
  git_status: gitStatusTool,
  git_diff: gitDiffTool,
  git_log: gitLogTool,
  git_show: gitShowTool,
  git_branch_list: gitBranchListTool,
  git_stash_list: gitStashListTool,
  git_tag_list: gitTagListTool,
  git_add: gitAddTool,
  git_commit: gitCommitTool,
  git_branch: gitBranchTool,
  git_stash: gitStashTool,
  git_tag: gitTagTool,
  web_fetch: webFetchTool,
  web_search: webSearchTool,
  document_intake: documentIntakeTool,
  write_file: writeFileTool,
  edit_file: editFileTool,
  powershell: powershellTool,
  bash: bashTool,
  background_shell: backgroundShellTool
});

/**
 * @param {{ cwd: string; config?: Record<string, any>; env?: NodeJS.ProcessEnv; policy?: Record<string, any>; workflowState?: ReturnType<typeof createWorkflowState>; parentSessionId?: string; backgroundParentSessionId?: string; hooksTrusted?: boolean; allowedSkills?: string[]; allowedMcpServers?: string[]; signal?: AbortSignal; mcpRuntime?: { callTool: (serverName: string, toolName: string, args?: Record<string, any>, signal?: AbortSignal) => Promise<Record<string, any>> }; approve?: (request: { toolName: string; input: Record<string, any>; decision: Record<string, any>; definition: Record<string, any> }) => Promise<boolean>; askUser?: (input: Record<string, any>) => Promise<Record<string, any>>; onBackgroundAgentEvent?: (event: Record<string, any>) => void | Promise<void>; onBackgroundTerminalEvent?: (event: Record<string, any>) => void | Promise<void> }} options
 */
export function createToolRuntime(options) {
  const tools = new Map(BUILT_IN_TOOLS.map((tool) => [tool.name, tool]));
  const workflowState = options.workflowState ?? createWorkflowState();

  return {
    cwd: options.cwd,
    config: options.config,
    parentSessionId: options.parentSessionId,
    hooksTrusted: options.hooksTrusted === true,
    definitions: BUILT_IN_TOOLS,
    /**
     * @param {string} name
     * @param {Record<string, any>} input
     */
    async execute(name, input) {
      const definition = tools.get(name);
      if (!definition) {
        return { ok: false, error: { code: "TOOL_NOT_FOUND", message: `Unknown tool: ${name}` } };
      }

      input = normalizeToolInput(name, input);
      const validation = validateInput(definition.inputSchema, input);
      if (!validation.ok) {
        if (name === "agent_run") {
          await writeInvalidAgentTaskRecord(options, input, validation.error);
        }
        return { ok: false, error: validation.error };
      }

      const beforeHook = await emitToolHook(options, "tool.before", name, input, definition);
      if (beforeHook.blocked) {
        return {
          ok: false,
          blocked: true,
          error: beforeHook.blockingError ?? { code: "HOOK_BLOCKED", message: "Tool blocked by hook" },
          hook: summarizeHookBlock(beforeHook)
        };
      }
      if (options.signal?.aborted) {
        return finishTool(options, name, input, definition, interruptedToolExecution(name, input, definition));
      }

      if (name === "mcp_list") {
        if (!options.mcpRuntime) {
          return finishTool(options, name, input, definition, { ok: false, error: { code: "MCP_NOT_CONFIGURED", message: "MCP runtime is not available" } });
        }
        if (input.server && !isAllowedMcpServer(options, input.server)) {
          return finishTool(options, name, input, definition, blockedScope("MCP_SERVER_NOT_ALLOWED", `MCP server is not allowed for this agent profile: ${input.server}`));
        }
        if (input.server) {
          if (input.kind === "prompts") {
            return finishTool(options, name, input, definition, await options.mcpRuntime.listPrompts(input.server));
          }
          if (input.kind === "resources") {
            return finishTool(options, name, input, definition, await options.mcpRuntime.listResources(input.server));
          }
          if (input.kind === "resource") {
            return finishTool(options, name, input, definition, await options.mcpRuntime.readResource(input.server, input.uri));
          }
          return finishTool(options, name, input, definition, await options.mcpRuntime.listTools(input.server));
        }
        return finishTool(options, name, input, definition, { ok: true, result: options.mcpRuntime.listServers() });
      }

      if (name === "mcp_call") {
        if (!options.mcpRuntime) {
          return finishTool(options, name, input, definition, { ok: false, error: { code: "MCP_NOT_CONFIGURED", message: "MCP runtime is not available" } });
        }
        if (!isAllowedMcpServer(options, input.server)) {
          return finishTool(options, name, input, definition, blockedScope("MCP_SERVER_NOT_ALLOWED", `MCP server is not allowed for this agent profile: ${input.server}`));
        }
        const execution = await options.mcpRuntime.callTool(input.server, input.tool, input.arguments ?? {}, options.signal);
        return finishTool(options, name, input, definition, options.signal?.aborted
          ? interruptedToolExecution(name, input, definition, execution)
          : execution);
      }

      if (name === "skill_list") {
        return finishTool(options, name, input, definition, await listSkillsForTool(options, input));
      }

      if (name === "skill_read") {
        return finishTool(options, name, input, definition, await readSkillForTool(options, input));
      }

      if (name === "skill_run") {
        return finishTool(options, name, input, definition, await runSkillForTool(options, input));
      }

      if (name === "ask_user") {
        if (!options.askUser) {
          return finishTool(options, name, input, definition, {
            ok: false,
            blocked: true,
            error: { code: "USER_INPUT_UNAVAILABLE", message: "ask_user requires an interactive session" }
          });
        }
        return finishTool(options, name, input, definition, { ok: true, result: await options.askUser(input) });
      }

      if (name === "agent_run") {
        const execution = await runAgentTool(options, input, definition);
        return finishTool(options, name, input, definition, options.signal?.aborted && execution.interrupted !== true
          ? interruptedToolExecution(name, input, definition, execution)
          : execution);
      }

      if (name === "web_fetch") {
        const execution = await executeWebFetchTool(options, input, definition);
        if (execution.ok === true) {
          recordToolEffect(workflowState, name, input, execution.result);
        }
        return finishTool(options, name, input, definition, options.signal?.aborted && execution.interrupted !== true
          ? interruptedToolExecution(name, input, definition, execution)
          : execution);
      }

      const decision = decidePermission(
        {
          toolName: name,
          risk: definition.risk,
          cwd: options.cwd,
          targetPaths: input.path ? [input.path] : [],
          networkHosts: networkHostsForWebTool(name, input, options.config, options.env),
          command: input.command,
          summary: definition.description
        },
        { workspace: options.cwd, ...(options.policy ?? {}) }
      );

      let approvedByUser = false;
      if (decision.decision === "ask" && options.approve) {
        const approved = await options.approve({
          toolName: name,
          input,
          decision,
          definition
        });
        if (!approved) {
          await emitPermissionDeniedHook(options, name, input, definition, decision);
          return finishTool(options, name, input, definition, { ok: false, blocked: true, decision });
        }
        approvedByUser = true;
      } else if (decision.decision !== "allow") {
        await emitPermissionDeniedHook(options, name, input, definition, decision);
        return finishTool(options, name, input, definition, { ok: false, blocked: true, decision });
      }

      const handler = HANDLERS[name];
      if (name === "todo_read") {
        return finishTool(options, name, input, definition, { ok: true, result: todoReadTool({ workflow: workflowState }) });
      }
      if (name === "todo_write") {
        const execution = { ok: true, result: todoWriteTool({ workflow: workflowState, items: input.items ?? input.todos ?? input.tasks ?? input.list }) };
        await emitTodoUpdatedHook(options, input, execution.result);
        return finishTool(options, name, input, definition, execution);
      }
      if (name === "plan_update") {
        return finishTool(options, name, input, definition, {
          ok: true,
          result: planUpdateTool({
            workflow: workflowState,
            explanation: input.explanation,
            steps: input.steps ?? input.plan ?? input.items
          })
        });
      }

      if (!handler) {
        return finishTool(options, name, input, definition, { ok: false, error: { code: "TOOL_NOT_IMPLEMENTED", message: `${name} is scaffolded but not implemented yet` } });
      }
      if ((name === "powershell" || name === "bash") && isKnownLongTerminalCommand(input.command)) {
        return finishTool(options, name, input, definition, {
          ok: false,
          blocked: true,
          error: {
            code: "BACKGROUND_SHELL_REQUIRED",
            message: "This discover command is a known long-running terminal task. Use background_shell with the same command, a stable taskId, and report the log paths instead of running it in the foreground shell."
          }
        });
      }

      try {
        const result = await handler({
          ...input,
          cwd: options.cwd,
          config: options.config,
          env: options.env,
          parentSessionId: name === "background_shell"
            ? options.backgroundParentSessionId ?? options.parentSessionId
            : options.parentSessionId,
          onBackgroundTerminalEvent: name === "background_shell"
            ? options.onBackgroundTerminalEvent
            : undefined,
          signal: options.signal,
          policy: {
            ...(options.policy ?? {}),
            approved: approvedByUser,
            approvedOutsideWorkspace: approvedByUser && decision.outsideWorkspace === true
          }
        });
        if (name === "background_shell" && result?.started === true) {
          await notifyBackgroundTerminalEvent(options, {
            type: "background_terminal_started",
            taskId: result.taskId,
            pid: result.pid,
            stdoutPath: result.stdoutPath,
            stderrPath: result.stderrPath,
            command: result.command
          });
        }
        if (options.signal?.aborted || result?.interrupted === true) {
          recordToolEffect(workflowState, name, input, result);
          if (name === "write_file" || (name === "edit_file" && result.edited !== false)) {
            await emitFileChangedHook(options, name, input, result);
          }
          return finishTool(options, name, input, definition, interruptedToolExecution(name, input, definition, result));
        }
        recordToolEffect(workflowState, name, input, result);
        if (name === "write_file" || (name === "edit_file" && result.edited !== false)) {
          await emitFileChangedHook(options, name, input, result);
        }
        return finishTool(options, name, input, definition, { ok: true, result });
      } catch (error) {
        const execution = {
          ok: false,
          error: {
            code: error && typeof error === "object" && "code" in error ? String(error.code) : "TOOL_RUNTIME_ERROR",
            message: error instanceof Error ? error.message : String(error)
          }
        };
        return finishTool(options, name, input, definition, options.signal?.aborted
          ? interruptedToolExecution(name, input, definition, execution)
          : execution);
      }
    }
  };
}

/**
 * @param {Parameters<typeof createToolRuntime>[0]} options
 * @param {Record<string, any>} input
 */
async function listSkillsForTool(options, input) {
  const skills = await loadSkills({
    cwd: options.cwd,
    config: options.config,
    env: options.env
  });
  const query = String(input.query ?? "").trim().toLowerCase();
  const includeDisabled = Boolean(input.includeDisabled);
  return {
    ok: true,
    result: skills
      .filter((skill) => isAllowedSkill(options, skill.name))
      .filter((skill) => includeDisabled || !skill.disabled)
      .filter((skill) => !query || [skill.name, skill.description, skill.whenToUse].some((value) => String(value ?? "").toLowerCase().includes(query)))
      .map((skill) => ({
        name: skill.name,
        description: skill.description,
        whenToUse: skill.whenToUse,
        allowedTools: skill.allowedTools,
        model: skill.model,
        disabled: skill.disabled,
        source: skill.source,
        contentBytes: skill.contentBytes
      }))
  };
}

/**
 * @param {Parameters<typeof createToolRuntime>[0]} options
 * @param {Record<string, any>} input
 */
async function readSkillForTool(options, input) {
  if (!isAllowedSkill(options, input.name)) {
    return blockedScope("SKILL_NOT_ALLOWED", `Skill is not allowed for this agent profile: ${input.name}`);
  }
  const result = await readSkill({
    cwd: options.cwd,
    config: options.config,
    env: options.env,
    name: input.name
  });
  return result.ok ? { ok: true, result: relativizeSkill(options.cwd, result.skill) } : result;
}

/**
 * @param {Parameters<typeof createToolRuntime>[0]} options
 * @param {Record<string, any>} input
 */
async function runSkillForTool(options, input) {
  if (!isAllowedSkill(options, input.name)) {
    return blockedScope("SKILL_NOT_ALLOWED", `Skill is not allowed for this agent profile: ${input.name}`);
  }
  const result = await runSkill({
    cwd: options.cwd,
    config: options.config,
    env: options.env,
    name: input.name,
    message: input.message
  });
  if (!result.ok) {
    return result;
  }
  if (result.execution === "fork-ready") {
    const subagent = await runSkillSubagent(options, result.skill, String(input.message ?? ""));
    return {
      ok: subagent.ok === true,
      result: {
        ...result,
        execution: "fork",
        skill: relativizeSkill(options.cwd, result.skill),
        task: subagent
      },
      error: subagent.ok ? undefined : subagent.error,
      interrupted: subagent.interrupted === true,
      blocked: subagent.blocked === true,
      decision: subagent.decision
    };
  }
  return { ok: true, result: { ...result, skill: relativizeSkill(options.cwd, result.skill) } };
}

function isAllowedSkill(options, name) {
  if (options.policy?.fullAccess) {
    return true;
  }
  const allowed = Array.isArray(options.allowedSkills) ? options.allowedSkills : [];
  if (allowed.length === 0) {
    return true;
  }
  const requested = String(name ?? "").toLowerCase();
  return allowed.some((item) => String(item).toLowerCase() === requested);
}

function isAllowedMcpServer(options, name) {
  if (options.policy?.fullAccess) {
    return true;
  }
  const allowed = Array.isArray(options.allowedMcpServers) ? options.allowedMcpServers : [];
  if (allowed.length === 0) {
    return true;
  }
  const requested = String(name ?? "").toLowerCase();
  return allowed.some((item) => String(item).toLowerCase() === requested);
}

function blockedScope(code, message) {
  return {
    ok: false,
    blocked: true,
    error: { code, message },
    decision: { decision: "deny", reason: message }
  };
}

async function executeWebFetchTool(options, input, definition) {
  const provider = normalizeWebFetchProvider(options.config);
  if (provider !== "builtin" && options.mcpRuntime && isAllowedMcpServer(options, "fetch")) {
    const mcpExecution = await executeMcpFetchTool(options, input);
    if (mcpExecution.ok === true || provider === "mcp-only" || isTerminalFetchMcpResult(mcpExecution)) {
      return mcpExecution;
    }
  }
  return executeBuiltinWebFetchTool(options, input, definition);
}

async function executeMcpFetchTool(options, input) {
  const execution = await options.mcpRuntime.callTool("fetch", "fetch", buildMcpFetchArguments(input), options.signal);
  if (!execution.ok) {
    return execution;
  }
  return {
    ok: true,
    result: normalizeMcpFetchResult(input, execution.result)
  };
}

async function executeBuiltinWebFetchTool(options, input, definition) {
  const decision = decidePermission(
    {
      toolName: "web_fetch",
      risk: definition.risk,
      cwd: options.cwd,
      networkHosts: networkHostsForWebTool("web_fetch", input, options.config, options.env),
      summary: definition.description
    },
    { workspace: options.cwd, ...(options.policy ?? {}) }
  );

  let approvedByUser = false;
  if (decision.decision === "ask" && options.approve) {
    const approved = await options.approve({
      toolName: "web_fetch",
      input,
      decision,
      definition
    });
    if (!approved) {
      await emitPermissionDeniedHook(options, "web_fetch", input, definition, decision);
      return { ok: false, blocked: true, decision };
    }
    approvedByUser = true;
  } else if (decision.decision !== "allow") {
    await emitPermissionDeniedHook(options, "web_fetch", input, definition, decision);
    return { ok: false, blocked: true, decision };
  }

  try {
    const result = await webFetchTool({
      ...input,
      cwd: options.cwd,
      config: options.config,
      env: options.env,
      signal: options.signal,
      policy: {
        ...(options.policy ?? {}),
        approved: approvedByUser
      }
    });
    return { ok: true, result: { ...result, provider: "builtin" } };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: error && typeof error === "object" && "code" in error ? String(error.code) : "TOOL_RUNTIME_ERROR",
        message: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

function normalizeWebFetchProvider(config = {}) {
  const value = String(config?.web?.fetchProvider ?? config?.web?.fetch?.provider ?? "mcp-first").trim().toLowerCase();
  if (["builtin", "mcp-only", "mcp-first"].includes(value)) {
    return value;
  }
  return "mcp-first";
}

function buildMcpFetchArguments(input) {
  const args = { url: input.url };
  const maxLength = Number(input.maxBytes ?? input.maxLength);
  if (Number.isFinite(maxLength) && maxLength > 0) {
    args.max_length = Math.max(1024, Math.floor(maxLength));
  }
  if (String(input.format ?? "").toLowerCase() === "html") {
    args.raw = true;
  }
  return args;
}

function normalizeMcpFetchResult(input, result) {
  const bounded = normalizeMcpFetchContent(extractMcpText(result), input);
  return {
    url: input.url,
    finalUrl: input.url,
    status: null,
    ok: true,
    contentType: "text/markdown",
    format: input.format ?? "markdown",
    bytes: bounded.bytes,
    truncated: bounded.truncated,
    provider: "mcp-fetch",
    content: bounded.text,
    mcp: {
      server: "fetch",
      tool: "fetch"
    }
  };
}

function extractMcpText(result) {
  if (typeof result?.text === "string") {
    return result.text;
  }
  if (Array.isArray(result?.content)) {
    return result.content
      .map((item) => {
        if (typeof item?.text === "string") {
          return item.text;
        }
        if (typeof item?.data === "string") {
          return item.data;
        }
        return JSON.stringify(item);
      })
      .filter(Boolean)
      .join("\n");
  }
  return JSON.stringify(result ?? {});
}

function normalizeMcpFetchContent(content, input) {
  const maxBytes = positiveIntegerOrNull(input.maxBytes ?? input.maxLength);
  const buffer = Buffer.from(String(content ?? ""), "utf8");
  if (!maxBytes || buffer.length <= maxBytes) {
    return { text: buffer.toString("utf8"), bytes: buffer.length, truncated: false };
  }
  return {
    text: buffer.subarray(0, maxBytes).toString("utf8"),
    bytes: buffer.length,
    truncated: true
  };
}

function positiveIntegerOrNull(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function isTerminalFetchMcpResult(execution) {
  if (execution?.blocked || execution?.interrupted) {
    return true;
  }
  const code = execution?.error?.code;
  if (!code) {
    return false;
  }
  return ![
    "MCP_NOT_CONFIGURED",
    "MCP_SERVER_NOT_FOUND",
    "MCP_SERVER_DISABLED",
    "MCP_COMMAND_MISSING",
    "MCP_TRANSPORT_UNSUPPORTED",
    "MCP_REQUEST_FAILED"
  ].includes(code);
}

/**
 * @param {string} name
 * @param {Record<string, any>} input
 * @param {Record<string, any>} _definition
 * @param {Record<string, any> | null} result
 */
function interruptedToolExecution(name, input, _definition = {}, result = null) {
  return {
    ok: false,
    interrupted: true,
    error: result?.error ?? { code: "TOOL_INTERRUPTED", message: `${name} was interrupted by the local user.` },
    result: result ?? undefined,
    input
  };
}

async function emitToolHook(options, event, name, input, definition, execution = null) {
  return runHooks({
    config: options.config,
    cwd: options.cwd,
    env: options.env,
    hooksTrusted: options.hooksTrusted,
    event,
    sessionId: options.parentSessionId,
    payload: {
      toolName: name,
      risk: definition.risk,
      input,
      targetPaths: collectHookTargetPaths(input, execution?.result ?? {}),
      ok: execution?.ok,
      blocked: execution?.blocked,
      decision: execution?.decision,
      error: execution?.error,
      result: summarizeToolResultForHook(execution?.result)
    }
  });
}

async function emitPermissionDeniedHook(options, name, input, definition, decision) {
  return runHooks({
    config: options.config,
    cwd: options.cwd,
    env: options.env,
    hooksTrusted: options.hooksTrusted,
    event: "permission.denied",
    sessionId: options.parentSessionId,
    payload: {
      toolName: name,
      risk: definition.risk,
      input,
      targetPaths: collectHookTargetPaths(input, {}),
      decision
    }
  });
}

async function emitFileChangedHook(options, name, input, result) {
  return runHooks({
    config: options.config,
    cwd: options.cwd,
    env: options.env,
    hooksTrusted: options.hooksTrusted,
    event: "file.changed",
    sessionId: options.parentSessionId,
    payload: {
      toolName: name,
      path: result.path ?? input.path ?? null,
      targetPaths: collectHookTargetPaths(input, result),
      created: result.created === true,
      edited: result.edited === true,
      diffBytes: Buffer.byteLength(String(result.diff ?? ""), "utf8"),
      diffTruncated: result.diffTruncated === true
    }
  });
}

async function emitTodoUpdatedHook(options, input, result) {
  return runHooks({
    config: options.config,
    cwd: options.cwd,
    env: options.env,
    hooksTrusted: options.hooksTrusted,
    event: "todo.updated",
    sessionId: options.parentSessionId,
    payload: {
      input,
      count: Array.isArray(result?.todos) ? result.todos.length : 0,
      todos: Array.isArray(result?.todos)
        ? result.todos.map((todo) => ({ id: todo.id, status: todo.status, content: todo.content }))
        : []
    }
  });
}

async function finishTool(options, name, input, definition, execution) {
  const event = execution?.ok === true ? "tool.after" : "tool.failed";
  await emitToolHook(options, event, name, input, definition, execution);
  return execution;
}

function summarizeHookBlock(hookResult) {
  const blocking = hookResult?.results?.find((result) => result.blocked);
  return {
    event: blocking?.event ?? "tool.before",
    name: blocking?.hook ?? null,
    message: blocking?.message ?? hookResult?.blockingError?.message ?? "blocked by hook"
  };
}

function summarizeToolResultForHook(result) {
  if (!result || typeof result !== "object") {
    return result;
  }
  return {
    path: result.path,
    created: result.created,
    edited: result.edited,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    interrupted: result.interrupted,
    bytesRead: result.bytesRead,
    bytesWritten: result.bytesWritten,
    truncated: result.truncated,
    diffBytes: result.diff ? Buffer.byteLength(String(result.diff), "utf8") : undefined,
    stdoutBytes: result.stdout ? Buffer.byteLength(String(result.stdout), "utf8") : undefined,
    stderrBytes: result.stderr ? Buffer.byteLength(String(result.stderr), "utf8") : undefined,
    contentBytes: result.content ? Buffer.byteLength(String(result.content), "utf8") : undefined
  };
}

async function runSkillSubagent(options, skill, message) {
  const baseConfig = options.config ?? await loadConfig({ cwd: options.cwd, env: options.env });
  const baseProfileName = skill.agent || "explorer";
  const baseProfile = getAgentProfile(baseProfileName, baseConfig, { cwd: options.cwd });
  if (!baseProfile) {
    return {
      ok: false,
      error: { code: "SKILL_AGENT_NOT_FOUND", message: `Skill agent is not configured: ${baseProfileName}` }
    };
  }
  const profileName = `skill-${skill.name}`.replace(/[^A-Za-z0-9._-]+/g, "-");
  const fullAccess = Boolean(options.policy?.fullAccess);
  const tools = !fullAccess && skill.allowedTools.length > 0
    ? baseProfile.tools.filter((tool) => skill.allowedTools.includes(tool))
    : baseProfile.tools;
  const config = {
    ...baseConfig,
    agents: {
      ...(baseConfig.agents ?? {}),
      profiles: [
        ...(baseConfig.agents?.profiles ?? []),
        {
          name: profileName,
          mode: baseProfile.mode,
          tools,
          hidden: true,
          model: skill.model ?? baseProfile.model ?? null,
          description: `Skill fork agent for ${skill.name}`,
          system: [
            `Apply the local skill '${skill.name}' as a bounded workflow.`,
            fullAccess
              ? "Full access mode is active: the parent session explicitly allows this skill fork to use the base profile's full toolset."
              : `Declared allowed tools: ${tools.length > 0 ? tools.join(", ") : "none"}.`,
            "",
            "Skill instructions:",
            skill.content
          ].join("\n")
        }
      ]
    }
  };
  const { runSubagent } = await import("../agents/runner.js");
  return runSubagent({
    cwd: options.cwd,
    config,
    env: options.env,
    signal: options.signal,
    readonly: Boolean(options.policy?.readonly),
    allowWrite: Boolean(options.policy?.approvals?.workspaceWrites),
    allowCommand: Boolean(options.policy?.approvals?.workspaceCommands),
    fullAccess: Boolean(options.policy?.fullAccess),
    workflowState: options.workflowState,
    approvalCallback: options.approve,
    onBackgroundTerminalEvent: options.onBackgroundTerminalEvent,
    parentSessionId: options.parentSessionId,
    backgroundParentSessionId: options.backgroundParentSessionId ?? options.parentSessionId,
    hooksTrusted: options.hooksTrusted,
    profileName,
    allowHiddenProfile: true,
    query: message || `Run skill ${skill.name}.`
  });
}

/**
 * @param {string} cwd
 * @param {Record<string, any>} skill
 */
function relativizeSkill(cwd, skill) {
  return {
    ...skill,
    path: skill.path ? path.relative(cwd, skill.path) || path.basename(skill.path) : skill.path,
    root: skill.root ? path.relative(cwd, skill.root) || path.basename(skill.root) : skill.root
  };
}

/**
 * @param {Parameters<typeof createToolRuntime>[0]} options
 * @param {Record<string, any>} input
 * @param {Record<string, any>} definition
 */
async function runAgentTool(options, input, definition) {
  const profileName = String(input.profile ?? input.profileName ?? "");
  const profile = getAgentProfile(profileName, options.config, { cwd: options.cwd });
  if (!profile) {
    const available = listAgentProfileLabels(options.config, { cwd: options.cwd }).join(", ");
    return {
      ok: false,
      error: {
        code: "AGENT_PROFILE_NOT_FOUND",
        message: `Unknown agent profile: ${profileName}. Available profiles: ${available || "none"}`
      }
    };
  }

  const agentRisk = agentRunRisk(profile);
  const decision = decidePermission(
    {
      toolName: "agent_run",
      risk: agentRisk,
      cwd: options.cwd,
      summary: `Run local subagent ${profile.name}${profile.purpose ? ` (${profile.purpose})` : ""}`
    },
    { workspace: options.cwd, ...(options.policy ?? {}) }
  );

  if (decision.decision === "ask" && options.approve) {
    const approved = await options.approve({
      toolName: "agent_run",
      input,
      decision,
      definition
    });
    if (!approved) {
      await emitPermissionDeniedHook(options, "agent_run", input, definition, decision);
      await writeBlockedAgentTaskRecord(options, input, profile, decision);
      return { ok: false, blocked: true, decision };
    }
  } else if (decision.decision !== "allow") {
    await emitPermissionDeniedHook(options, "agent_run", input, definition, decision);
    await writeBlockedAgentTaskRecord(options, input, profile, decision);
    return { ok: false, blocked: true, decision };
  }

  const { runSubagent } = await import("../agents/runner.js");
  if (shouldRunAgentInBackground(options, input)) {
    return startBackgroundAgentTool(options, input, definition, profile, runSubagent);
  }
  return runSubagent({
    cwd: options.cwd,
    config: options.config,
    env: options.env,
    signal: options.signal,
    readonly: Boolean(options.policy?.readonly),
    allowWrite: Boolean(options.policy?.approvals?.workspaceWrites),
    allowCommand: Boolean(options.policy?.approvals?.workspaceCommands),
    fullAccess: Boolean(options.policy?.fullAccess),
    workflowState: options.workflowState,
    approvalCallback: options.approve,
    onBackgroundTerminalEvent: options.onBackgroundTerminalEvent,
    parentSessionId: options.parentSessionId,
    backgroundParentSessionId: options.backgroundParentSessionId ?? options.parentSessionId,
    hooksTrusted: options.hooksTrusted,
    taskId: typeof input.taskId === "string" && input.taskId.trim() ? input.taskId.trim() : undefined,
    profileName: profile.name,
    title: typeof input.title === "string" && input.title.trim() ? input.title.trim() : undefined,
    routeDecision: buildAgentRouteDecision(input, profile),
    writeScope: input.writeScope,
    acceptance: input.acceptance,
    contextPack: input.contextPack,
    query: String(input.query ?? "")
  });
}

function shouldRunAgentInBackground(options, input) {
  const config = options.config?.agents?.backgroundWakeup ?? {};
  if (config.enabled === false) {
    return false;
  }
  if (input.background === true) {
    return true;
  }
  return config.defaultForModelAgentRun === true && input.background !== false;
}

async function startBackgroundAgentTool(options, input, definition, profile, runSubagent) {
  const taskId = typeof input.taskId === "string" && input.taskId.trim()
    ? input.taskId.trim()
    : `task-${crypto.randomUUID()}`;
  const groupId = normalizeGroupId(input.groupId) ?? `group-${crypto.randomUUID()}`;
  const waitFor = pickEnum(input.waitForGroup, ["all", "any", "none"], options.config?.agents?.backgroundWakeup?.defaultWaitFor ?? "all");
  const wakeParent = input.wakeParent !== false && options.config?.agents?.backgroundWakeup?.autoQueueParentPrompt !== false;
  const wakeReason = typeof input.wakeReason === "string" && input.wakeReason.trim()
    ? input.wakeReason.trim()
    : "后台子任务完成后继续主控编排";
  const groupStore = createAgentTaskGroupStore({ cwd: options.cwd });
  await groupStore.ensureGroup({
    id: groupId,
    parentSessionId: options.parentSessionId ?? null,
    status: "running",
    waitFor,
    wakeParent,
    wakeReason,
    taskIds: [taskId],
    latestProgress: `后台子任务 ${profile.name} 已启动`,
    metadata: {
      source: "agent_run",
      background: true
    }
  });
  await runHooks({
    config: options.config,
    cwd: options.cwd,
    env: options.env,
    hooksTrusted: options.hooksTrusted,
    event: "subagent.group.started",
    sessionId: options.parentSessionId,
    taskId,
    payload: {
      groupId,
      taskId,
      profile: profile.name,
      waitFor,
      wakeParent,
      status: "running"
    }
  });
  void notifyBackgroundAgentEvent(options, {
    type: "subagent_group_started",
    groupId,
    taskId,
    profile: profile.name,
    waitFor,
    wakeParent
  });

  const controller = new AbortController();
  const unregister = registerBackgroundAgentTask({
    taskId,
    groupId,
    parentSessionId: options.parentSessionId,
    profile: profile.name,
    controller
  });
  const runPromise = runSubagent({
    cwd: options.cwd,
    config: options.config,
    env: options.env,
    signal: controller.signal,
    readonly: Boolean(options.policy?.readonly),
    allowWrite: Boolean(options.policy?.approvals?.workspaceWrites),
    allowCommand: Boolean(options.policy?.approvals?.workspaceCommands),
    fullAccess: Boolean(options.policy?.fullAccess),
    workflowState: options.workflowState,
    approvalCallback: options.approve,
    onBackgroundTerminalEvent: options.onBackgroundTerminalEvent,
    parentSessionId: options.parentSessionId,
    backgroundParentSessionId: options.backgroundParentSessionId ?? options.parentSessionId,
    groupId,
    hooksTrusted: options.hooksTrusted,
    taskId,
    profileName: profile.name,
    title: typeof input.title === "string" && input.title.trim() ? input.title.trim() : undefined,
    routeDecision: buildAgentRouteDecision(input, profile),
    writeScope: input.writeScope,
    acceptance: input.acceptance,
    contextPack: input.contextPack,
    query: String(input.query ?? "")
  });

  runPromise
    .then((result) => finalizeBackgroundAgentTool(options, {
      groupId,
      taskId,
      profile,
      result,
      waitFor,
      wakeParent,
      wakeReason
    }))
    .catch((error) => finalizeBackgroundAgentTool(options, {
      groupId,
      taskId,
      profile,
      result: {
        ok: false,
        profile: profile.name,
        error: {
          code: "BACKGROUND_AGENT_ERROR",
          message: error instanceof Error ? error.message : String(error)
        }
      },
      waitFor,
      wakeParent,
      wakeReason
    }))
    .finally(() => {
      unregister();
    });

  return {
    ok: true,
    background: true,
    profile: profile.name,
    taskId,
    groupId,
    taskStatus: "running",
    outputSummary: `后台子智能体 ${profile.name} 已启动；group=${groupId}，完成后将${wakeParent ? "自动唤醒主控" : "记录结果" }。`,
    result: {
      taskId,
      groupId,
      profile: profile.name,
      status: "running",
      background: true,
      waitForGroup: waitFor,
      wakeParent
    }
  };
}

async function finalizeBackgroundAgentTool(options, state) {
  const groupStore = createAgentTaskGroupStore({ cwd: options.cwd });
  const taskStore = createAgentTaskStore({ cwd: options.cwd });
  let groupResult = await groupStore.readGroup(state.groupId);
  if (!groupResult.ok) {
    return;
  }
  let group = groupResult.group;
  const tasks = await readGroupTasks(groupStore, taskStore, state.groupId);
  const summary = summarizeGroupStatus(tasks, { waitFor: group.waitFor });
  const completedAt = summary.completed ? new Date().toISOString() : null;
  const patch = {
    status: summary.status,
    completedAt,
    latestProgress: summary.summary,
    summary: summary.summary
  };
  groupResult = await groupStore.updateGroup(state.groupId, patch);
  if (!groupResult.ok) {
    return;
  }
  group = groupResult.group;
  if (summary.completed) {
    await runHooks({
      config: options.config,
      cwd: options.cwd,
      env: options.env,
      hooksTrusted: options.hooksTrusted,
      event: "subagent.group.completed",
      sessionId: options.parentSessionId,
      taskId: state.taskId,
      payload: {
        groupId: state.groupId,
        taskIds: group.taskIds,
        status: group.status,
        summary: group.summary
      }
    });
  }
  await notifyBackgroundAgentEvent(options, {
    type: "subagent_group_progress",
    groupId: state.groupId,
    taskId: state.taskId,
    profile: state.profile.name,
    status: group.status,
    waitFor: state.waitFor,
    wakeParent: state.wakeParent,
    completed: summary.completed,
    summary: summary.summary
  });
  if (!shouldQueueWakePrompt(group, summary)) {
    return;
  }
  const maxBytes = options.config?.agents?.backgroundWakeup?.maxWakeSummaryBytes;
  const wakePrompt = buildSubagentGroupWakePrompt({ group, tasks, maxBytes });
  groupResult = await groupStore.updateGroup(state.groupId, {
    wakePrompt,
    wakePromptQueuedAt: new Date().toISOString(),
    latestProgress: "后台子任务组已完成，已生成主控续跑提示"
  });
  group = groupResult.ok ? groupResult.group : group;
  await runHooks({
    config: options.config,
    cwd: options.cwd,
    env: options.env,
    hooksTrusted: options.hooksTrusted,
    event: "subagent.group.wakeup_queued",
    sessionId: options.parentSessionId,
    taskId: state.taskId,
    payload: {
      groupId: state.groupId,
      taskIds: group.taskIds,
      status: group.status,
      wakePromptBytes: Buffer.byteLength(wakePrompt, "utf8")
    }
  });
  await notifyBackgroundAgentEvent(options, {
    type: "subagent_group_wakeup",
    groupId: state.groupId,
    taskId: state.taskId,
    profile: state.profile.name,
    status: group.status,
    waitFor: state.waitFor,
    wakeParent: state.wakeParent,
    wakePrompt,
    summary: group.summary
  });
}

async function readGroupTasks(groupStore, taskStore, groupId) {
  const groupResult = await groupStore.readGroup(groupId);
  const taskIds = groupResult.ok ? groupResult.group.taskIds : [];
  const tasks = [];
  for (const id of taskIds) {
    const result = await taskStore.readTask(id);
    if (result.ok) {
      tasks.push(result.task);
    }
  }
  return tasks;
}

function shouldQueueWakePrompt(group, summary) {
  if (!summary.completed || group.wakeParent === false || group.waitFor === "none" || group.wakePromptQueuedAt) {
    return false;
  }
  return true;
}

async function notifyBackgroundAgentEvent(options, event) {
  if (typeof options.onBackgroundAgentEvent !== "function") {
    return;
  }
  try {
    await options.onBackgroundAgentEvent(event);
  } catch {
    // UI notifications must not break background agent completion.
  }
}

async function notifyBackgroundTerminalEvent(options, event) {
  if (typeof options.onBackgroundTerminalEvent !== "function") {
    return;
  }
  try {
    await options.onBackgroundTerminalEvent(event);
  } catch {
    // UI notifications must not break tool execution.
  }
}

function normalizeGroupId(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    return null;
  }
  return safeGroupId(text);
}

function buildAgentRouteDecision(input, profile) {
  const difficulty = pickEnum(input.difficulty, ["quick", "standard", "deep"], null);
  const risk = pickEnum(input.risk, ["low", "medium", "high"], null);
  const routeDecision = {
    profile: profile.name,
    purpose: pickEnum(input.purpose, ["explore", "research", "plan", "execute", "verify", "review", "browser", "visual"], profile.purpose ?? null),
    difficulty,
    risk,
    modelTier: typeof input.modelTier === "string" && input.modelTier.trim()
      ? input.modelTier.trim()
      : inferAgentModelTier({ profile, difficulty, risk })
  };
  return Object.fromEntries(Object.entries(routeDecision).filter(([, value]) => value !== null && value !== undefined && value !== ""));
}

function agentRunRisk(profile) {
  if (profile.purpose === "browser" || profile.purpose === "visual" || profile.name === "browser-verifier" || profile.name === "visual-verifier") {
    return "browser";
  }
  if (profile.mode === "write-capable") {
    return "write";
  }
  if (profile.mode === "execute") {
    return "execute";
  }
  return "read";
}

async function writeBlockedAgentTaskRecord(options, input, profile, decision) {
  const taskId = typeof input.taskId === "string" && input.taskId.trim() ? input.taskId.trim() : null;
  if (!taskId) {
    return null;
  }
  try {
    const store = createAgentTaskStore({ cwd: options.cwd });
    const now = new Date().toISOString();
    return await store.createTask({
      id: taskId,
      parentSessionId: options.parentSessionId ?? null,
      childSessionId: `agent-${profile.name}-blocked`,
      profile: profile.name,
      purpose: profile.purpose ?? null,
      title: `Blocked ${profile.name} subagent`,
      prompt: String(input.query ?? ""),
      contextPack: input.contextPack && typeof input.contextPack === "object" ? input.contextPack : null,
      routeDecision: buildAgentRouteDecision(input, profile),
      status: "blocked",
      mode: profile.mode,
      startedAt: now,
      finishedAt: now,
      latestProgress: decision.reason ?? "子智能体被权限策略阻止",
      outputSummary: decision.reason ?? "子智能体被权限策略阻止",
      output: [
        "子智能体未启动。",
        "",
        `profile: ${profile.name}`,
        `status: blocked`,
        `reason: ${decision.reason ?? "permission denied"}`,
        "",
        "这是启动 agent_run 时的权限阻止记录，子智能体模型请求尚未发出。"
      ].join("\n"),
      error: {
        code: "AGENT_RUN_BLOCKED",
        message: decision.reason ?? "Subagent launch was blocked by permission policy.",
        decision
      }
    });
  } catch {
    return null;
  }
}

async function writeInvalidAgentTaskRecord(options, input, error) {
  const taskId = typeof input.taskId === "string" && input.taskId.trim() ? input.taskId.trim() : null;
  if (!taskId) {
    return null;
  }
  try {
    const store = createAgentTaskStore({ cwd: options.cwd });
    const profileName = typeof input.profile === "string" && input.profile.trim() ? input.profile.trim() : "agent";
    const now = new Date().toISOString();
    return await store.createTask({
      id: taskId,
      parentSessionId: options.parentSessionId ?? null,
      childSessionId: `agent-${profileName}-invalid`,
      profile: profileName,
      purpose: typeof input.purpose === "string" ? input.purpose : null,
      title: `Invalid ${profileName} subagent request`,
      prompt: typeof input.query === "string" ? input.query : "",
      contextPack: input.contextPack && typeof input.contextPack === "object" ? input.contextPack : null,
      routeDecision: {
        profile: profileName,
        ...(typeof input.modelTier === "string" ? { modelTier: input.modelTier } : {})
      },
      status: "failed",
      mode: "invalid",
      startedAt: now,
      finishedAt: now,
      latestProgress: error?.message ?? "agent_run input validation failed",
      outputSummary: error?.message ?? "agent_run input validation failed",
      output: [
        "子智能体未启动。",
        "",
        `profile: ${profileName}`,
        "status: failed",
        `reason: ${error?.message ?? "invalid agent_run input"}`,
        "",
        "这是 agent_run 输入校验失败记录；子智能体模型请求尚未发出。"
      ].join("\n"),
      error: {
        code: error?.code ?? "TOOL_INPUT_INVALID",
        message: error?.message ?? "Invalid agent_run input"
      }
    });
  } catch {
    return null;
  }
}

function inferAgentModelTier({ profile, difficulty, risk }) {
  if (risk === "high" || difficulty === "deep") {
    return "strong";
  }
  return profile.modelTier ?? null;
}

function pickEnum(value, allowed, fallback) {
  const text = typeof value === "string" ? value.trim() : "";
  return allowed.includes(text) ? text : fallback;
}

/**
 * @param {ReturnType<typeof createWorkflowState>} workflowState
 * @param {string} name
 * @param {Record<string, any>} input
 * @param {Record<string, any>} result
 */
function recordToolEffect(workflowState, name, input, result) {
  if (name === "write_file") {
    recordFileChange(workflowState, {
      toolName: name,
      path: result.path,
      created: result.created,
      diffBytes: Buffer.byteLength(String(result.diff ?? ""), "utf8"),
      diffTruncated: result.diffTruncated
    });
  } else if (name === "edit_file" && result.edited !== false) {
    recordFileChange(workflowState, {
      toolName: name,
      path: result.path,
      edited: true,
      diffBytes: Buffer.byteLength(String(result.diff ?? ""), "utf8"),
      diffTruncated: result.diffTruncated
    });
  } else if (name === "powershell" || name === "bash") {
    recordValidation(workflowState, {
      toolName: name,
      command: input.command,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      interrupted: result.interrupted,
      durationMs: result.durationMs,
      stdout: result.stdout,
      stderr: result.stderr,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
      error: result.error
    });
  }
}

/**
 * @param {{ required?: string[] }} schema
 * @param {Record<string, any>} input
 */
function validateInput(schema, input) {
  for (const key of schema.required ?? []) {
    if (!(key in input)) {
      return {
        ok: false,
        error: { code: "TOOL_INPUT_INVALID", message: `Missing required input field: ${key}` }
      };
    }
  }
  return { ok: true };
}

function normalizeToolInput(name, input = {}) {
  if (name === "agent_run") {
    const next = { ...input };
    if (!("query" in next)) {
      for (const key of ["message", "prompt", "task", "instruction", "instructions"]) {
        if (typeof next[key] === "string" && next[key].trim()) {
          next.query = next[key];
          break;
        }
      }
    }
    return next;
  }
  if (name === "web_fetch") {
    const next = { ...input };
    if (!("url" in next)) {
      for (const key of ["target", "uri", "href", "link"]) {
        if (typeof next[key] === "string") {
          next.url = next[key];
          break;
        }
      }
    }
    if (typeof next.url === "string") {
      next.url = normalizeLooseHttpUrl(next.url);
    }
    return next;
  }
  if ((name === "powershell" || name === "bash") && !("command" in input)) {
    for (const key of ["cmd", "script", "commandText"]) {
      if (typeof input[key] === "string") {
        return { ...input, command: input[key] };
      }
    }
  }
  return input;
}

function isKnownLongTerminalCommand(command) {
  const text = String(command ?? "").toLowerCase();
  return text.includes("antscan_downloader.cli") && /\bdiscover\b/.test(text);
}

function normalizeLooseHttpUrl(value) {
  const text = String(value ?? "").trim();
  if (!text) {
    return text;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    return text;
  }
  if (/^(?:localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)(?::\d+)?(?:[/?#]|$)/i.test(text)) {
    return `http://${text}`;
  }
  if (/^[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?(?:[/?#]|$)/i.test(text)) {
    return `https://${text}`;
  }
  return text;
}
