import process from "node:process";
import { spawnSync } from "node:child_process";
import { formatMessageBodyForDisplayClipboard } from "./command-panels.ts";
import { MESSAGE_ACTIONS, type TuiEntry } from "./types.ts";

export function messageActionsForEntry(entry: TuiEntry | null | undefined) {
  const actions = ["copy", "copy-forward"];
  if (entry?.kind === "user" && Number.isInteger(entry.checkpointMessagesLength)) {
    actions.push("rewind-edit", "regenerate");
  } else if (entry?.kind === "user") {
    actions.push("rewind-disabled");
  }
  return actions.filter((action) => (MESSAGE_ACTIONS as readonly string[]).includes(action) || action === "rewind-disabled");
}

export function entriesFromSelected(entries: TuiEntry[] = [], entryId: unknown) {
  const start = entries.findIndex((entry) => entry.id === entryId);
  const selected = start >= 0 ? entries.slice(start) : [];
  return selected.filter((entry) => ["user", "assistant", "tool", "tools", "trace", "error", "approval", "output", "command", "context", "agent", "session"].includes(entry?.kind ?? ""));
}

export function formatEntriesForClipboard(entries: TuiEntry[] = []) {
  return entries.map((entry) => formatEntryForClipboard(entry)).filter(Boolean).join("\n\n");
}

export function formatEntryForClipboard(entry: TuiEntry = {}) {
  const label = entry.kind === "user"
    ? "你"
    : entry.kind === "assistant"
      ? "Ant Code"
      : entry.kind === "agent"
        ? `子智能体${entry.title ? ` - ${entry.title}` : ""}`
      : entry.title
        ? `${entry.kind ?? "message"} - ${entry.title}`
      : entry.kind ?? "message";
  const body = String(entry.excerptBody ?? entry.body ?? "");
  const thinkingBytes = Number(entry.thinkingBytes ?? Buffer.byteLength(String(entry.thinking ?? ""), "utf8"));
  const thinkingNotice = entry.kind === "assistant" && thinkingBytes > 0
    ? `\n[thinking 已隐藏：${thinkingBytes} 字节，不复制]`
    : "";
  const displayBody = entry.kind === "assistant"
    ? formatMessageBodyForDisplayClipboard({ ...entry, body })
    : body;
  return `${label}${thinkingNotice}\n${displayBody}`.trim();
}

export function writeClipboardText(text: string, env?: NodeJS.ProcessEnv) {
  const value = String(text ?? "");
  if (!value) {
    return { ok: false, error: "没有可复制的文本。" };
  }
  const command = process.platform === "win32"
    ? [
      "$stream = [Console]::OpenStandardInput()",
      "$buffer = [byte[]]::new(8192)",
      "$memory = [System.IO.MemoryStream]::new()",
      "while (($read = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) { $memory.Write($buffer, 0, $read) }",
      "$text = [System.Text.UTF8Encoding]::new($false).GetString($memory.ToArray())",
      "Set-Clipboard -Value $text"
    ].join("; ")
    : process.platform === "darwin"
      ? "pbcopy"
      : "xclip -selection clipboard";
  const executable = process.platform === "win32" ? "powershell.exe" : process.platform === "darwin" ? "sh" : "sh";
  const args = process.platform === "win32"
    ? ["-NoProfile", "-NonInteractive", "-Command", command]
    : ["-c", command];
  const result = spawnSync(executable, args, {
    input: value,
    encoding: "utf8",
    env: env ?? process.env,
    windowsHide: true,
    timeout: 3000
  });
  if (result.error) {
    return { ok: false, error: result.error.message };
  }
  if (result.status !== 0) {
    return { ok: false, error: String(result.stderr || result.stdout || `clipboard exited ${result.status}`).trim() };
  }
  return { ok: true };
}
