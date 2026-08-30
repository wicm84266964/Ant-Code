import process, { stdin as input, stdout as output } from "node:process";
import React from "react";
import { render } from "ink";
import { createSession } from "../core/session.ts";
import { resolveWorkspaceTrust } from "../permissions/workspace-trust.ts";
import { TuiApp } from "./tui/app.ts";
import {
  clearTerminalForFullRedraw,
  enterTerminalAppMode,
  exitTerminalAppMode,
  snapshotWindowsConsoleCodePage,
  snapshotWindowsConsoleInputMode
} from "./tui/terminal-mode.ts";
import type { RunTuiOptions } from "./tui/types.ts";

export type { RunTuiOptions } from "./tui/types.ts";
export { limitTranscriptEntries } from "./tui/transcript.ts";
export { resolveIdleSilentAfterMs, shouldEnterIdleSilent } from "./tui/idle.ts";
export { createSynchronousDraftMirror } from "./tui/draft.ts";
export {
  appendStreamDelta,
  applyStreamDeltaBuffer,
  createStreamDeltaBuffer,
  resolveStreamDeltaActivityStatus
} from "./tui/stream.ts";
export { resolveTuiLayoutRows } from "./tui/layout-frame.ts";
export {
  isCtrlKey,
  isInkKeyRelease,
  readBracketedPaste,
  splitTrailingSubmitInput
} from "./tui/terminal-mode.ts";

const h = React.createElement;

export async function runTui(options: RunTuiOptions) {
  if (!input.isTTY || !output.isTTY) {
    output.write("Ant Code TUI requires an interactive terminal. Use `ant-code chat` or `ant-code -p` in non-TTY contexts.\n");
    return;
  }

  const session = await createSession({
    cwd: options.cwd,
    mode: "interactive",
    env: options.env,
    readonly: options.readonly,
    allowWrite: options.allowWrite,
    allowCommand: options.allowCommand,
    fullAccess: options.fullAccess,
    resume: options.resume,
    resumeFullContext: Boolean(options.resume)
  });
  const trust = await resolveWorkspaceTrust({
    cwd: options.cwd,
    env: options.env,
    sensitivity: session.sensitivity
  });

  const initialWindowsConsoleInputMode = snapshotWindowsConsoleInputMode();
  const initialWindowsConsoleCodePage = snapshotWindowsConsoleCodePage();
  enterTerminalAppMode(output, { env: options.env });
  let instance: ReturnType<typeof render> | null = null;
  let forceExitCode: number | null = null;
  try {
    clearTerminalForFullRedraw(output);
    instance = render(h(TuiApp, {
      cwd: options.cwd,
      env: options.env,
      session,
      initialTrusted: trust.trusted,
      initialWindowsConsoleInputMode,
      onForceExit: (code: number) => {
        forceExitCode = Number.isInteger(code) ? code : 130;
      }
    }), {
      exitOnCtrlC: false,
      incrementalRendering: true,
      maxFps: 60
    });
    await instance.waitUntilExit();
  } finally {
    instance?.unmount?.();
    exitTerminalAppMode(output, { env: options.env, initialWindowsConsoleInputMode, initialWindowsConsoleCodePage });
  }
  if (forceExitCode !== null) {
    (options.forceExitProcess ?? process.exit)(forceExitCode);
  }
}
