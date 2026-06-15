#!/usr/bin/env node
import crypto from "node:crypto";
import { parseArgs } from "./args.js";
import { runInteractiveChat } from "./interactive.js";
import { createPrintEventCollector } from "./print-output.js";
import { runTui } from "./tui.js";
import { parseSlashCommand } from "../commands/parser.js";
import { runSlashCommand } from "../commands/runtime.js";
import { runPrintTurn } from "../core/session.js";
import { startDashboard } from "../dashboard/server.js";
import { ANT_EVENT_SCHEMA_VERSION, createAntJsonOutput, redactText } from "../core/events.js";
import { runDoctor, formatDoctorReport } from "../diagnostics/doctor.js";
import { runGatewayHealth, formatGatewayHealthReport } from "../model-gateway/health.js";
import { helpText } from "../ui/output.js";
import { getAntCodeVersion, resolvePackageRoot } from "../version.js";

const ROOT_DIR = resolvePackageRoot();

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(helpText());
    return;
  }

  if (args.version) {
    console.log(`ant-code ${await getAntCodeVersion(ROOT_DIR)}`);
    return;
  }

  if (args.command === "doctor") {
    const report = await runDoctor({ cwd: process.cwd(), packageRoot: ROOT_DIR, env: process.env });
    console.log(formatDoctorReport(report));
    process.exitCode = report.ok ? 0 : 1;
    return;
  }

  if (args.command === "gateway") {
    const report = await runGatewayHealth({
      cwd: process.cwd(),
      env: process.env,
      live: args.live
    });
    console.log(formatGatewayHealthReport(report));
    process.exitCode = report.ok ? 0 : 1;
    return;
  }

  if (args.command === "chat" || args.command === "interactive") {
    await runInteractiveChat({
      cwd: process.cwd(),
      env: process.env,
      readonly: args.readonly,
      allowWrite: args.allowWrite,
      allowCommand: args.allowCommand,
      fullAccess: args.fullAccess,
      resume: args.resume
    });
    return;
  }

  if (args.command === "tui") {
    await runTui({
      cwd: process.cwd(),
      env: process.env,
      readonly: args.readonly,
      allowWrite: args.allowWrite,
      allowCommand: args.allowCommand,
      fullAccess: args.fullAccess,
      resume: args.resume
    });
    return;
  }

  if (args.command === "dashboard") {
    const result = await startDashboard({
      cwd: process.cwd(),
      env: process.env,
      packageRoot: ROOT_DIR,
      host: args.dashboard.host,
      port: args.dashboard.port,
      open: args.dashboard.open,
      project: args.dashboard.project
    });
    console.log(`Ant Code Dashboard running at ${result.url}`);
    console.log(`Project: ${result.cwd}`);
    console.log("Close it from the Dashboard sidebar, or press Ctrl+C in this terminal.");
    return;
  }

  if (args.print) {
    const prompt = args.prompt || await readStdinIfAvailable();
    const slashCommand = parseSlashCommand(prompt);
    if (slashCommand) {
      const text = await runSlashCommand({
        command: slashCommand,
        cwd: process.cwd(),
        env: process.env,
        readonly: args.readonly,
        allowWrite: args.allowWrite,
        allowCommand: args.allowCommand,
        fullAccess: args.fullAccess,
        trusted: false
      });
      writeCommandPrintOutput({ args, slashCommand, text });
      return;
    }

    const collector = createPrintEventCollector({
      format: args.outputFormat,
      includePartialMessages: args.includePartialMessages
    });
    const result = await runPrintTurn({
      prompt,
      cwd: process.cwd(),
      env: process.env,
      readonly: args.readonly,
      allowWrite: args.allowWrite,
      allowCommand: args.allowCommand,
      fullAccess: args.fullAccess,
      stream: args.outputFormat === "stream-json",
      onAntEvent: collector.onAntEvent
    });
    writeTurnPrintOutput({ args, collector, result });
    return;
  }

  const stdinText = await readStdinIfAvailable();
  if (stdinText.trim().length > 0) {
    const result = await runPrintTurn({
      prompt: stdinText,
      cwd: process.cwd(),
      env: process.env,
      readonly: args.readonly,
      allowWrite: args.allowWrite,
      allowCommand: args.allowCommand,
      fullAccess: args.fullAccess
    });
    console.log(result.output);
    return;
  }

  await runTui({
    cwd: process.cwd(),
    env: process.env,
    readonly: args.readonly,
    allowWrite: args.allowWrite,
    allowCommand: args.allowCommand,
    fullAccess: args.fullAccess,
    resume: args.resume
  });
}

/**
 * @param {{ args: ReturnType<typeof parseArgs>; collector: ReturnType<typeof createPrintEventCollector>; result: Awaited<ReturnType<typeof runPrintTurn>> }} input
 */
function writeTurnPrintOutput(input) {
  if (input.args.outputFormat === "text") {
    console.log(input.result.output);
    return;
  }
  if (input.args.outputFormat === "json") {
    console.log(input.collector.formatJson({
      sessionId: input.result.session.id,
      output: input.result.output
    }));
  }
}

/**
 * @param {{ args: ReturnType<typeof parseArgs>; slashCommand: ReturnType<typeof parseSlashCommand>; text: string }} input
 */
function writeCommandPrintOutput(input) {
  if (input.args.outputFormat === "text") {
    console.log(input.text);
    return;
  }

  const sessionId = crypto.randomUUID();
  const event = {
    schemaVersion: ANT_EVENT_SCHEMA_VERSION,
    id: `${sessionId}:000001:command_result`,
    sequence: 1,
    type: "command_result",
    at: new Date().toISOString(),
    sessionId,
    turnId: null,
    round: null,
    parentId: null,
    parentToolUseId: null,
    source: "command",
    visibility: "default",
    persistence: "persist",
    redaction: "partial",
    payload: {
      command: input.slashCommand?.name ?? null,
      text: redactText(input.text),
      bytes: Buffer.byteLength(input.text, "utf8")
    }
  };

  if (input.args.outputFormat === "stream-json") {
    console.log(JSON.stringify(event));
    return;
  }

  console.log(JSON.stringify(createAntJsonOutput({
    sessionId,
    events: [event],
    result: {
      status: "completed",
      output: input.text,
      outputBytes: Buffer.byteLength(input.text, "utf8")
    }
  }), null, 2));
}

async function readStdinIfAvailable() {
  if (process.stdin.isTTY) {
    return "";
  }

  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
