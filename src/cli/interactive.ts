import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { parseSlashCommand } from "../commands/parser.ts";
import { runSlashCommand } from "../commands/runtime.ts";
import { clearSessionContext, compactSessionContextWithModel, formatContextWindowStatus, summarizeContextWindow } from "../core/context-window.ts";
import { buildDeliveryStatus, formatDeliveryStatus, formatTurnFooter } from "../core/delivery.ts";
import { createSession, runSessionTurn, type AgentSession } from "../core/session.ts";
import { suggestValidationCommands } from "../core/validation-suggestions.ts";
import { createLabModelGateway } from "../model-gateway/client.ts";
import { approvalKeyFor } from "../permissions/approval-keys.ts";

/**
 * @param {{ cwd: string; env?: NodeJS.ProcessEnv; readonly?: boolean; allowWrite?: boolean; allowCommand?: boolean; fullAccess?: boolean; resume?: string | null }} options
 */
export async function runInteractiveChat(options: { cwd: string; env?: NodeJS.ProcessEnv; readonly?: boolean; allowWrite?: boolean; allowCommand?: boolean; fullAccess?: boolean; resume?: string | null }) {
  const rl = createInterface({ input, output });
  let session = await createSession({
    cwd: options.cwd,
    mode: "interactive",
    clientSurface: "chat",
    env: options.env,
    readonly: options.readonly,
    allowWrite: options.allowWrite,
    allowCommand: options.allowCommand,
    fullAccess: options.fullAccess,
    resume: options.resume
  });
  const sessionApprovals = new Set<string>();
  output.write(formatStartupBanner(session));

  try {
    while (true) {
      const prompt = (await rl.question("ant-code> ")).trim();
      if (!prompt) {
        continue;
      }
      if (prompt === "/exit" || prompt === "/quit") {
        output.write("bye\n");
        return;
      }

      const slashCommand = parseSlashCommand(prompt);
      if (slashCommand) {
        const lowerName = slashCommand.name.toLowerCase();
        if (lowerName === "status") {
          output.write(`${formatSessionStatus(session)}\n`);
          continue;
        }
        if (lowerName === "clear") {
          clearSessionContext(session);
          output.write("Conversation context cleared.\n");
          continue;
        }
        if (lowerName === "compact") {
          const result = await compactSessionContextWithModel(session, {
            force: true,
            reason: "manual",
            gateway: createLabModelGateway(session.config),
            env: options.env
          });
          const strategy = result.strategy === "agent:compaction" ? "agent:compaction" : result.strategy === "model" ? "model" : result.strategy === "local" ? "local" : "none";
          output.write(result.compacted
            ? `Compacted context messages (${strategy}): ${result.beforeMessages} -> ${result.afterMessages}; summary bytes=${result.summaryBytes}${result.fallbackReason ? `; fallback=${result.fallbackReason}` : ""}\n`
            : `Context was not compacted: ${result.reason}\n`);
          continue;
        }
        if (lowerName === "resume") {
          const selector = slashCommand.args[0] ?? "latest";
          try {
            session = await createSession({
              cwd: options.cwd,
              mode: "interactive",
              clientSurface: "chat",
              env: options.env,
              readonly: options.readonly,
              allowWrite: options.allowWrite,
              allowCommand: options.allowCommand,
              fullAccess: options.fullAccess,
              resume: selector
            });
            sessionApprovals.clear();
            output.write(`Resumed session ${session.id} with ${session.messages.length} restored message(s).\n`);
          } catch (error) {
            output.write(`Resume failed: ${error instanceof Error ? error.message : String(error)}\n`);
          }
          continue;
        }
        const text = await runSlashCommand({
          command: slashCommand,
          cwd: options.cwd,
          env: options.env,
          readonly: session.readonly,
          allowWrite: session.allowWrite,
          allowCommand: session.allowCommand,
          fullAccess: session.fullAccess,
          workflowState: session.workflow,
          sessionInfo: slashCommandSessionInfo(session),
          approvalCallback: (request) => askApproval(rl, request, sessionApprovals),
          trusted: false
        });
        output.write(`${text}\n`);
        continue;
      }

      const result = await runSessionTurn(session, {
        prompt,
        env: options.env,
        approvalCallback: (request) => askApproval(rl, request, sessionApprovals),
        userInputCallback: (request) => askUser(rl, request),
        hooksTrusted: false
      });
      const validationSuggestions = await suggestValidationCommands(options.cwd);
      const footer = formatTurnFooter(buildDeliveryStatus({
        workflow: session.workflow,
        sessionInfo: summarizeSessionInfo(session),
        validationSuggestions
      }));
      output.write(`${result.output}${footer ? `\n${footer}` : ""}\n`);
    }
  } finally {
    rl.close();
  }
}

/**
 * @param {import("node:readline/promises").Interface} rl
 * @param {{ toolName: string; input: Record<string, any>; decision: Record<string, any>; definition: Record<string, any> }} request
 * @param {Set<string>} sessionApprovals
 */
type ApprovalRequest = {
  toolName: string;
  input: Record<string, unknown>;
  decision: Record<string, unknown>;
  definition: Record<string, unknown>;
};

async function askApproval(rl: import("node:readline/promises").Interface, request: ApprovalRequest, sessionApprovals: Set<string>) {
  const approvalKey = approvalKeyFor(request);
  if (sessionApprovals.has(approvalKey)) {
    return true;
  }

  output.write("\nTool approval requested\n");
  output.write(`tool: ${request.toolName}\n`);
  output.write(`risk: ${request.definition.risk}\n`);
  output.write("boundary: local client execution; no remote tool server\n");
  output.write(`reason: ${request.decision.reason ?? "approval required"}\n`);
  if (request.decision.sensitive === true) {
    output.write("sensitive: strong confirmation; approved content or changes may enter model context\n");
  }
  output.write(`input: ${summarizeInput(request.toolName, request.input)}\n`);
  const answer = (await rl.question("Approve? [y]es / [n]o / [a]lways for matching requests this session: ")).trim().toLowerCase();
  output.write("\n");
  if (answer === "a" || answer === "always") {
    sessionApprovals.add(approvalKey);
    return true;
  }
  return answer === "y" || answer === "yes";
}

/**
 * @param {Awaited<ReturnType<typeof createSession>>} session
 */
function formatStartupBanner(session: AgentSession) {
  const lines = [
    "Ant Code interactive chat",
    `cwd: ${session.cwd}`,
    `model: ${session.model}`,
    `network: ${session.networkMode}`,
    `sensitivity: ${session.sensitivity}`,
    `permission: ${session.permissionMode ?? "plan"} (writes=${session.allowWrite}, commands=${session.allowCommand}, fullAccess=${session.fullAccess})`,
    `readonly locked: ${session.permissionReadonlyLocked}`,
    `workflow: todos=${session.workflow.todos.length}, plan=${session.workflow.plan.steps.length}`,
    `context: messages=${session.messages.length}/${session.contextWindow.maxMessages}, compactions=${session.contextWindow.compactionCount}`,
    `metadata: ${formatMetadataPolicy(session.config.transcript)}`,
    `gateway: ${session.config.lab.gatewayUrl ? "configured" : "not configured"}`,
    "",
    "Type /help for commands, /status for session state, /exit to leave."
  ];

  if (!session.config.lab.gatewayUrl) {
    lines.push("Set LAB_MODEL_GATEWAY_URL to enable model turns through the lab gateway.");
  }
  if (session.resumedFrom) {
    lines.push(`Resumed from ${session.resumedFrom.metadataPath}; restored messages=${session.messages.length}.`);
  }

  return `${lines.join("\n")}\n`;
}

/**
 * @param {Awaited<ReturnType<typeof createSession>>} session
 */
function formatSessionStatus(session: AgentSession) {
  const delivery = buildDeliveryStatus({
    workflow: session.workflow,
    sessionInfo: summarizeSessionInfo(session)
  });
  return [
    "Ant Code session",
    `id: ${session.id}`,
    `cwd: ${session.cwd}`,
    `mode: ${session.mode}`,
    `turns: ${session.turnCount}`,
    formatContextWindowStatus(session),
    `todos: ${session.workflow.todos.length}`,
    `plan steps: ${session.workflow.plan.steps.length}`,
    `recorded changes: ${session.workflow.changes.length}`,
    `validations: ${session.workflow.validations.length}`,
    `permission mode: ${session.permissionMode ?? "plan"}`,
    `readonly locked: ${session.permissionReadonlyLocked}`,
    `readonly: ${session.readonly}`,
    `allow write: ${session.allowWrite}`,
    `allow command: ${session.allowCommand}`,
    `full access: ${session.fullAccess}`,
    `model: ${session.model}`,
    `network: ${session.networkMode}`,
    `sensitivity: ${session.sensitivity}`,
    `gateway: ${session.config.lab.gatewayUrl ? "configured" : "not configured"}`,
    `metadata: ${formatMetadataPolicy(session.config.transcript)}`,
    "",
    formatDeliveryStatus(delivery, { includeHeader: true, includeCommands: true })
  ].join("\n");
}

/**
 * @param {Awaited<ReturnType<typeof createSession>>} session
 */
type InteractiveSessionInfo = {
  id: string;
  turnCount: number;
  model: string;
  permissionMode: string;
  fullAccess: boolean;
  readonly: boolean;
  permissionReadonlyLocked: boolean;
  allowWrite: boolean;
  allowCommand: boolean;
  networkMode: string;
  sensitivity: string;
  cwd: string;
  usage: AgentSession["usage"];
  lastProviderUsage: unknown;
  context: ReturnType<typeof summarizeContextWindow>;
};

function summarizeSessionInfo(session: AgentSession): InteractiveSessionInfo {
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

function slashCommandSessionInfo(session: AgentSession): AgentSession {
  return summarizeSessionInfo(session) as unknown as AgentSession;
}

/**
 * @param {import("node:readline/promises").Interface} rl
 * @param {{ question?: string; choices?: Array<string> }} request
 */
async function askUser(rl: import("node:readline/promises").Interface, request: Record<string, unknown>) {
  const question = String(request.question ?? "Clarification requested");
  const choices = Array.isArray(request.choices) ? request.choices.filter((choice: unknown) => typeof choice === "string") : [];
  output.write("\nQuestion from model\n");
  output.write(`${question}\n`);
  if (choices.length > 0) {
    output.write(`choices: ${choices.join(" / ")}\n`);
  }
  const answer = await rl.question("Answer: ");
  output.write("\n");
  return {
    answer: answer.trim(),
    selectedChoice: choices.includes(answer.trim()) ? answer.trim() : null
  };
}

/**
 * @param {Record<string, any>} transcript
 */
function formatMetadataPolicy(transcript: Record<string, unknown> = {}) {
  if (transcript.enabled === false) {
    return "disabled";
  }
  if (transcript.retentionDays === 0) {
    return "zero-retention";
  }
  if (transcript.retentionDays === null) {
    return `forever, encryption=${transcript.encryption ?? "off"}`;
  }
  return `${transcript.retentionDays ?? 30}d, encryption=${transcript.encryption ?? "off"}`;
}

/**
 * @param {string} toolName
 * @param {Record<string, any>} value
 */
function summarizeInput(toolName: string, value: Record<string, unknown>) {
  if (toolName === "write_file") {
    return JSON.stringify({
      path: value.path,
      contentBytes: Buffer.byteLength(String(value.content ?? ""), "utf8")
    });
  }
  if (toolName === "edit_file") {
    return JSON.stringify({
      path: value.path,
      oldTextBytes: Buffer.byteLength(String(value.oldText ?? ""), "utf8"),
      newTextBytes: Buffer.byteLength(String(value.newText ?? ""), "utf8"),
      expectedReplacements: value.expectedReplacements,
      dryRun: Boolean(value.dryRun),
      writesFile: !value.dryRun
    });
  }
  if (toolName === "powershell" || toolName === "bash") {
    return JSON.stringify({
      command: truncate(String(value.command ?? ""), 300),
      timeoutMs: value.timeoutMs
    });
  }
  if (toolName === "mcp_call") {
    return JSON.stringify({
      server: value.server,
      tool: value.tool,
      argumentBytes: Buffer.byteLength(JSON.stringify(value.arguments ?? {}), "utf8")
    });
  }
  return truncate(JSON.stringify(value), 500);
}

/**
 * @param {string} value
 * @param {number} max
 */
function truncate(value: string, max: number) {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}
