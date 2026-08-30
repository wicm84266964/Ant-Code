import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import type { BracketedPasteState, InkKey, WindowsConsoleScriptResult, WritableStreamLike } from "./types.ts";

export function clearTerminalForFullRedraw(stream: WritableStreamLike | null | undefined) {
  stream?.write?.("\u001b[3J\u001b[2J\u001b[H");
}

export function readBracketedPaste(chunkText: unknown, state: BracketedPasteState) {
  const start = "\u001b[200~";
  const end = "\u001b[201~";
  const text = String(chunkText ?? "");
  if (!state.active) {
    const combined = `${state.prefix ?? ""}${text}`;
    state.prefix = "";
    const startIndex = combined.indexOf(start);
    if (startIndex === -1) {
      const prefix = trailingMarkerPrefix(combined, start);
      if (prefix) {
        state.prefix = prefix;
        return "";
      }
      return null;
    }
    state.active = true;
    state.buffer = combined.slice(0, startIndex);
    const rest = combined.slice(startIndex + start.length);
    const endIndex = rest.indexOf(end);
    if (endIndex === -1) {
      state.buffer += rest;
      return "";
    }
    const pasted = `${state.buffer}${rest.slice(0, endIndex)}${rest.slice(endIndex + end.length)}`;
    state.active = false;
    state.buffer = "";
    return pasted;
  }

  const combined = `${state.buffer}${text}`;
  const endIndex = combined.indexOf(end);
  if (endIndex === -1) {
    state.buffer = combined;
    return "";
  }
  const pasted = `${combined.slice(0, endIndex)}${combined.slice(endIndex + end.length)}`;
  state.active = false;
  state.buffer = "";
  return pasted;
}

export function trailingMarkerPrefix(value: unknown, marker: string) {
  const text = String(value ?? "");
  for (let length = Math.min(text.length, marker.length - 1); length >= 3; length -= 1) {
    if (text.endsWith(marker.slice(0, length))) {
      return marker.slice(0, length);
    }
  }
  return "";
}

export function looksLikePastedText(value: unknown) {
  const text = String(value ?? "");
  return text.length > 1 && /[\r\n]/.test(text);
}

export function isCtrlKey(inputValue: unknown, key: InkKey | undefined, name: string) {
  return Boolean(key?.ctrl)
    && String(inputValue ?? "").toLowerCase() === String(name ?? "").toLowerCase();
}

export function isInkKeyRelease(key: InkKey | undefined) {
  return key?.eventType === "release";
}

export function splitTrailingSubmitInput(inputValue: unknown, key: InkKey = {}) {
  const value = String(inputValue ?? "");
  if (key.return || key.ctrl || key.meta || value.length < 2 || !value.endsWith("\r") || value.endsWith("\r\n")) {
    return null;
  }
  const text = value.slice(0, -1);
  return /[\u0000-\u001F\u007F]/.test(text) ? null : text;
}

export function sanitizeComposerText(value: unknown) {
  return String(value ?? "")
    .replace(/\u001b\[200~/g, "")
    .replace(/\u001b\[201~/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

export function countLogicalLines(value: unknown) {
  const text = String(value ?? "");
  if (!text) {
    return 0;
  }
  return text.split(/\n/).length;
}

export function debugRawInput(env: NodeJS.ProcessEnv | undefined, text: string, source: string = "stdin") {
  if (!isTuiInputDebugEnabled(env)) {
    return;
  }
  const visible = Array.from(String(text ?? "")).map((char) => {
    const code = char.charCodeAt(0);
    if (code === 27) {
      return "\\x1b";
    }
    if (code < 32 || code === 127) {
      return `\\x${code.toString(16).padStart(2, "0")}`;
    }
    return char;
  }).join("");
  try {
    appendFileSync(path.join(os.tmpdir(), "lab-agent-tui-input.log"), `${Date.now()} ${source} ${visible}\n`, "utf8");
  } catch {
    // Debug logging must never affect TUI input.
  }
}

export function debugTuiInput(env: NodeJS.ProcessEnv | undefined, message: string) {
  if (!isTuiInputDebugEnabled(env)) {
    return;
  }
  try {
    appendFileSync(path.join(os.tmpdir(), "lab-agent-tui-input.log"), `${Date.now()} event ${String(message ?? "")}\n`, "utf8");
  } catch {
    // Debug logging must never affect TUI input.
  }
}

export function isTuiInputDebugEnabled(env: NodeJS.ProcessEnv | unknown) {
  const record = env && typeof env === "object" ? env as NodeJS.ProcessEnv : process.env;
  return record.LAB_AGENT_TUI_DEBUG_INPUT === "1" || process.env.LAB_AGENT_TUI_DEBUG_INPUT === "1";
}

export function trailingRawShiftTabInput(value: unknown) {
  const text = String(value ?? "");
  if (!text) {
    return "";
  }
  if (text.endsWith("\u001b") || text.endsWith("\u001b[") || text.endsWith("\u001b[1;") || text.endsWith("\u001b[1;2") || text.endsWith("\u001b[9;") || text.endsWith("\u001b[9;2")) {
    return text.slice(Math.max(0, text.lastIndexOf("\u001b")));
  }
  return "";
}

export type TerminalModeOptions = {
  env?: NodeJS.ProcessEnv;
  reason?: string;
  forceConsoleMode?: boolean;
  initialWindowsConsoleInputMode?: number | null;
  initialWindowsConsoleCodePage?: number | null;
};

export function enterTerminalAppMode(stream: WritableStreamLike | null | undefined, options: TerminalModeOptions = {}) {
  debugTuiInput(options.env, `terminal_app_mode enter pid=${process.pid} cwd=${process.cwd()} mouse=click-drag`);
  setWindowsConsoleCodePage(65001, options);
  stream?.write?.("\u001b[?1049h\u001b[?2004h\u001b[?25l\u001b[2J\u001b[H");
}

export function exitTerminalAppMode(stream: WritableStreamLike | null | undefined, options: TerminalModeOptions = {}) {
  debugTuiInput(options.env, "terminal_app_mode exit");
  disableTerminalMouse(stream, { env: options.env, reason: "terminal-exit" });
  restoreWindowsConsoleInputMode(options.initialWindowsConsoleInputMode, options);
  restoreWindowsConsoleCodePage(options.initialWindowsConsoleCodePage, options);
  stream?.write?.("\u001b[?2004l\u001b[?25h\u001b[?1049l\u001b[0m\u001b[2K\r\n");
}

export function enableTerminalMouse(stream: WritableStreamLike | null | undefined, options: TerminalModeOptions = {}) {
  debugTuiInput(options.env, `terminal_mouse enable reason=${options.reason ?? "unknown"} force=${options.forceConsoleMode ? "1" : "0"}`);
  enableWindowsConsoleMouseInput(options);
  stream?.write?.("\u001b[?1000h\u001b[?1002h\u001b[?1006h\u001b[?1015h\u001b[?1007h");
}

export function enterTerminalSelectionMode(stream: WritableStreamLike | null | undefined, options: TerminalModeOptions = {}) {
  debugTuiInput(options.env, `terminal_selection enter reason=${options.reason ?? "unknown"}`);
  disableTerminalMouse(stream, { env: options.env, reason: `selection:${options.reason ?? "unknown"}` });
  restoreWindowsConsoleSelectionInput(options.initialWindowsConsoleInputMode, options);
}

export function disableTerminalMouse(stream: WritableStreamLike | null | undefined, options: TerminalModeOptions = {}) {
  debugTuiInput(options.env, `terminal_mouse disable reason=${options.reason ?? "unknown"}`);
  stream?.write?.("\u001b[?1007l\u001b[?1015l\u001b[?1006l\u001b[?1002l\u001b[?1000l");
}

let windowsConsoleInputEnabled = false;

export function snapshotWindowsConsoleCodePage() {
  if (process.platform !== "win32") {
    return null;
  }
  const result = runWindowsConsoleModeScript(`
[Console]::Out.Write([Console]::OutputEncoding.CodePage)
`, { output: true });
  const codePage = Number.parseInt(String(result?.stdout ?? "").trim(), 10);
  return Number.isFinite(codePage) ? codePage : null;
}

export function setWindowsConsoleCodePage(codePage: number, options: TerminalModeOptions = {}) {
  if (process.platform !== "win32" || !Number.isFinite(codePage)) {
    return;
  }
  const debugEnabled = isTuiInputDebugEnabled(options.env);
  const beforeCodePage = debugEnabled ? snapshotWindowsConsoleCodePage() : null;
  const result = runWindowsConsoleModeScript(`
$encoding = [System.Text.Encoding]::GetEncoding(${Number(codePage)})
[Console]::InputEncoding = $encoding
[Console]::OutputEncoding = $encoding
chcp.com ${Number(codePage)} | Out-Null
`);
  if (debugEnabled) {
    const afterCodePage = snapshotWindowsConsoleCodePage();
    debugTuiInput(options.env, `windows_console_codepage set before=${beforeCodePage ?? "?"} after=${afterCodePage ?? "?"} target=${Number(codePage)} status=${result?.status ?? "?"} exe=${result?.executable ?? "?"}`);
  }
}

export function restoreWindowsConsoleCodePage(codePage: number | null | undefined, options: TerminalModeOptions = {}) {
  if (process.platform !== "win32" || !Number.isFinite(codePage) || Number(codePage) === 65001) {
    return;
  }
  setWindowsConsoleCodePage(Number(codePage), options);
}

export function snapshotWindowsConsoleInputMode() {
  if (process.platform !== "win32") {
    return null;
  }
  const result = runWindowsConsoleModeScript(`
${windowsConsoleModeNativeScript()}
[int]$mode = 0
if ([LabAgentTui.ConsoleMode]::GetConsoleMode([LabAgentTui.ConsoleMode]::GetStdHandle(-10), [ref]$mode)) {
  [Console]::Out.Write($mode)
}
`, { output: true });
  const mode = Number.parseInt(String(result?.stdout ?? "").trim(), 10);
  return Number.isFinite(mode) ? mode : null;
}

export function enableWindowsConsoleMouseInput(options: TerminalModeOptions = {}) {
  if (process.platform !== "win32") {
    debugTuiInput(options.env, "windows_console_mouse skip platform");
    return;
  }
  const shouldCalibrate = options.forceConsoleMode === true || !windowsConsoleInputEnabled;
  if (!shouldCalibrate) {
    debugTuiInput(options.env, "windows_console_mouse skip already-enabled");
    return;
  }
  const debugEnabled = isTuiInputDebugEnabled(options.env);
  const beforeMode = debugEnabled ? snapshotWindowsConsoleInputMode() : null;
  const result = runWindowsConsoleModeScript(`
${windowsConsoleModeNativeScript()}
[int]$mode = 0
$handle = [LabAgentTui.ConsoleMode]::GetStdHandle(-10)
if ([LabAgentTui.ConsoleMode]::GetConsoleMode($handle, [ref]$mode)) {
  $next = ($mode -bor 0x0010 -bor 0x0080 -bor 0x0200) -band (-bnot 0x0040)
  [void][LabAgentTui.ConsoleMode]::SetConsoleMode($handle, $next)
}
`);
  const succeeded = result?.status === 0;
  windowsConsoleInputEnabled = succeeded;
  if (debugEnabled) {
    const afterMode = snapshotWindowsConsoleInputMode();
    debugTuiInput(options.env, `windows_console_mouse enable before=${formatConsoleMode(beforeMode)} after=${formatConsoleMode(afterMode)} force=${options.forceConsoleMode ? "1" : "0"} status=${result?.status ?? "?"} exe=${result?.executable ?? "?"}`);
  }
}

export function restoreWindowsConsoleSelectionInput(initialMode: number | null | undefined, options: TerminalModeOptions = {}) {
  windowsConsoleInputEnabled = false;
  if (process.platform !== "win32") {
    debugTuiInput(options.env, "windows_console_selection skip platform");
    return;
  }
  const fallbackMode = 0x0080 | 0x0200 | 0x0040;
  const baseMode = Number.isFinite(initialMode) ? Number(initialMode) : fallbackMode;
  const debugEnabled = isTuiInputDebugEnabled(options.env);
  const beforeMode = debugEnabled ? snapshotWindowsConsoleInputMode() : null;
  const result = runWindowsConsoleModeScript(`
${windowsConsoleModeNativeScript()}
$handle = [LabAgentTui.ConsoleMode]::GetStdHandle(-10)
[int]$mode = ${Number(baseMode)}
[void][LabAgentTui.ConsoleMode]::GetConsoleMode($handle, [ref]$mode)
$next = ($mode -bor 0x0080 -bor 0x0200 -bor 0x0040) -band (-bnot 0x0010)
[void][LabAgentTui.ConsoleMode]::SetConsoleMode($handle, $next)
`);
  if (debugEnabled) {
    const afterMode = snapshotWindowsConsoleInputMode();
    debugTuiInput(options.env, `windows_console_selection restore before=${formatConsoleMode(beforeMode)} after=${formatConsoleMode(afterMode)} base=${formatConsoleMode(baseMode)} status=${result?.status ?? "?"} exe=${result?.executable ?? "?"}`);
  }
}

export function restoreWindowsConsoleInputMode(mode: number | null | undefined, options: TerminalModeOptions = {}) {
  windowsConsoleInputEnabled = false;
  if (process.platform !== "win32" || !Number.isFinite(mode)) {
    debugTuiInput(options.env, `windows_console_input restore skipped target=${formatConsoleMode(mode)}`);
    return;
  }
  const debugEnabled = isTuiInputDebugEnabled(options.env);
  const beforeMode = debugEnabled ? snapshotWindowsConsoleInputMode() : null;
  const result = runWindowsConsoleModeScript(`
${windowsConsoleModeNativeScript()}
[void][LabAgentTui.ConsoleMode]::SetConsoleMode([LabAgentTui.ConsoleMode]::GetStdHandle(-10), ${Number(mode)})
`);
  if (debugEnabled) {
    const afterMode = snapshotWindowsConsoleInputMode();
    debugTuiInput(options.env, `windows_console_input restore before=${formatConsoleMode(beforeMode)} after=${formatConsoleMode(afterMode)} target=${formatConsoleMode(mode)} status=${result?.status ?? "?"} exe=${result?.executable ?? "?"}`);
  }
}

export function formatConsoleMode(mode: number | null | undefined) {
  if (!Number.isFinite(mode)) {
    return "?";
  }
  const value = Number(mode);
  return `${value}/0x${value.toString(16)}`;
}

export function runWindowsConsoleModeScript(script: string, options: { output?: boolean } = {}): WindowsConsoleScriptResult | null {
  let firstResult: WindowsConsoleScriptResult | null = null;
  for (const executable of ["powershell.exe", "pwsh.exe", "pwsh", "powershell"]) {
    const spawned = spawnSync(executable, ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      stdio: options.output ? ["inherit", "pipe", "ignore"] : ["inherit", "ignore", "ignore"],
      timeout: 3000,
      windowsHide: true
    });
    const result: WindowsConsoleScriptResult = {
      status: spawned.status,
      stdout: spawned.stdout,
      stderr: spawned.stderr,
      error: spawned.error ?? undefined,
      executable
    };
    if (!firstResult) {
      firstResult = result;
    }
    if (!result.error && result.status === 0) {
      return result;
    }
  }
  return firstResult;
}

export function windowsConsoleModeNativeScript() {
  return `
$definition = @"
using System;
using System.Runtime.InteropServices;
namespace LabAgentTui {
  public static class ConsoleMode {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr GetStdHandle(int nStdHandle);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetConsoleMode(IntPtr hConsoleHandle, out int lpMode);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetConsoleMode(IntPtr hConsoleHandle, int dwMode);
  }
}
"@
Add-Type -TypeDefinition $definition -ErrorAction Stop
`;
}
