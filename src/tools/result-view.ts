import { capToolResultText, DEFAULT_TOOL_RESULT_MAX_BYTES, type SerializedToolResult, type ToolResultValue } from "./result.ts";

const READ_FILE_VIEW_CHARS = 12_000;
const SEARCH_VIEW_MATCHES = 40;
const SEARCH_LINE_CHARS = 200;
const LIST_VIEW_ENTRIES = 40;
const SHELL_HEAD_CHARS = 4_000;
const SHELL_TAIL_CHARS = 4_000;
const FETCH_EXCERPT_CHARS = 8_000;
const GIT_EXCERPT_CHARS = 8_000;
const GENERIC_EXCERPT_CHARS = 8_000;
const AGENT_OUTPUT_CHARS = 8_000;
const WEB_SEARCH_RESULTS = 8;
const DIFF_PREVIEW_LINES = 24;

type ViewDraft = {
  text: string;
  truncated: boolean;
};

export function formatToolResultForModel(
  name: string,
  execution: ToolResultValue,
  options: { maxBytes?: number; evidence?: Array<{ id?: string; name?: string; bytes?: number }> } = {}
): SerializedToolResult {
  const view = renderToolResultView(String(name ?? "unknown"), execution, options.evidence);
  return capToolResultText(view.text, {
    maxBytes: options.maxBytes ?? DEFAULT_TOOL_RESULT_MAX_BYTES,
    truncated: view.truncated
  });
}

export function renderToolResultView(
  name: string,
  execution: ToolResultValue,
  evidence: Array<{ id?: string; name?: string; bytes?: number }> = []
): ViewDraft {
  const result = asRecord(execution?.result);
  const lines = [
    ...statusLines(name, execution),
    ...locatorLines(name, execution, result),
    ...evidenceLines(evidence)
  ];
  const body = bodyForTool(name, execution, result);
  if (body.text) {
    lines.push(body.text);
  }
  if (body.truncated) {
    lines.push("需要更多内容时再调用同一工具并缩小范围。");
  }
  const reminder = stringField(result.systemReminder);
  if (reminder) {
    lines.push("", reminder);
  }
  return {
    text: lines.filter(Boolean).join("\n"),
    truncated: body.truncated
  };
}

function bodyForTool(name: string, execution: ToolResultValue, result: Record<string, unknown>): ViewDraft {
  if (name === "read_file") {
    return formatReadFile(result);
  }
  if (name === "grep" || name === "rg_search" || name === "rg_files_with_matches" || name === "rg_count") {
    return formatSearch(result);
  }
  if (name === "glob" || name === "rg_files") {
    return formatPathList(result, "matches", SEARCH_VIEW_MATCHES);
  }
  if (name === "list_files") {
    return formatListFiles(result);
  }
  if (name === "powershell" || name === "bash") {
    return formatShell(result);
  }
  if (name === "web_fetch") {
    return formatFetch(result);
  }
  if (name === "web_search") {
    return formatWebSearch(result);
  }
  if (name.startsWith("git_")) {
    return formatGit(result);
  }
  if (name === "write_file" || name === "edit_file") {
    return formatWrite(result);
  }
  if (name === "agent_run") {
    return formatAgent(execution, result);
  }
  if (name === "mcp_call" || name === "mcp_list") {
    return formatMcp(result);
  }
  if (name === "document_intake" || name === "skill_read") {
    return formatDocument(result);
  }
  return formatGeneric(result);
}

function statusLines(name: string, execution: ToolResultValue): string[] {
  const error = asRecord(execution.error);
  const decision = asRecord(execution.decision);
  const parts = [
    `ok=${execution.ok === true}`,
    `tool=${name}`
  ];
  if (execution.blocked === true) {
    parts.push("blocked=true");
  }
  if (execution.interrupted === true) {
    parts.push("interrupted=true");
  }
  if (decision.decision) {
    parts.push(`decision=${cleanInline(decision.decision)}`);
  }
  const lines = [parts.join(" ")];
  if (error.code || error.message) {
    lines.push(`error=${[error.code, error.message].filter(Boolean).join(": ")}`);
  } else if (decision.reason) {
    lines.push(`error=${cleanInline(decision.reason)}`);
  }
  return lines;
}

function locatorLines(name: string, execution: ToolResultValue, result: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const pathValue = stringField(result.path);
  if (pathValue) {
    lines.push(`path=${pathValue}`);
  }
  const url = stringField(result.finalUrl) || stringField(result.url);
  if (url) {
    lines.push(`url=${url}`);
  }
  if (name === "web_search" && stringField(result.query)) {
    lines.push(`query=${stringField(result.query)}`);
  }
  if (name === "agent_run") {
    const profile = stringField(result.profile) || stringField(execution.profile);
    if (profile) {
      lines.push(`profile=${profile}`);
    }
    const status = stringField(result.status);
    if (status) {
      lines.push(`status=${status}`);
    }
  }
  if (name === "mcp_call") {
    const server = stringField(result.server);
    const tool = stringField(result.tool);
    if (server || tool) {
      lines.push(`mcp=${[server, tool].filter(Boolean).join("/")}`);
    }
  }
  if (Number.isFinite(Number(result.exitCode))) {
    lines.push(`exitCode=${Number(result.exitCode)}`);
  }
  if (result.timedOut === true) {
    lines.push("timedOut=true");
  }
  if (result.truncated === true || result.diffTruncated === true || result.contentTruncated === true) {
    lines.push("sourceTruncated=true");
  }
  if (result.cancelled === true) {
    lines.push("cancelled=true");
  }
  return lines;
}

function evidenceLines(evidence: Array<{ id?: string; name?: string; bytes?: number }> = []): string[] {
  if (!Array.isArray(evidence) || evidence.length === 0) {
    return [];
  }
  return evidence.map((item) => (
    `evidence=${item.id ?? "vis"} name=${item.name ?? "image"} bytes=${item.bytes ?? 0} omitted=true`
  ));
}

function formatReadFile(result: Record<string, unknown>): ViewDraft {
  const content = String(result.content ?? "");
  const bytes = Number.isFinite(Number(result.bytesRead))
    ? Number(result.bytesRead)
    : Buffer.byteLength(content, "utf8");
  const excerpt = headTail(numberLines(content), READ_FILE_VIEW_CHARS / 2, READ_FILE_VIEW_CHARS / 2);
  return {
    text: [
      `bytes=${bytes}${result.truncated === true || excerpt.truncated ? " truncated=true" : ""}`,
      excerpt.text
    ].filter(Boolean).join("\n"),
    truncated: excerpt.truncated || result.truncated === true
  };
}

function formatSearch(result: Record<string, unknown>): ViewDraft {
  const matches = asArray(result.matches);
  const shown = matches.slice(0, SEARCH_VIEW_MATCHES);
  const truncated = result.truncated === true || matches.length > shown.length;
  const lines = [
    `matches=${matches.length}${truncated ? " truncated=true" : ""}`,
    ...shown.map((item) => formatSearchMatch(item))
  ];
  return { text: lines.join("\n"), truncated };
}

function formatSearchMatch(item: unknown): string {
  if (typeof item === "string") {
    return `- ${truncateClean(item, SEARCH_LINE_CHARS)}`;
  }
  const record = asRecord(item);
  const pathValue = stringField(record.path) || stringField(record.file);
  const line = Number.isFinite(Number(record.line)) ? Number(record.line) : null;
  const text = stringField(record.text) || stringField(record.content) || stringField(record.lineText);
  return `- ${pathValue || "?"}${line != null ? `:${line}` : ""}${text ? ` ${truncateClean(text, SEARCH_LINE_CHARS)}` : ""}`;
}

function formatPathList(result: Record<string, unknown>, key: string, limit: number): ViewDraft {
  const matches = asArray(result[key] ?? result.files ?? result.matches).map((item) => (
    typeof item === "string" ? item : stringField(asRecord(item).path) || JSON.stringify(item)
  ));
  const shown = matches.slice(0, limit);
  const truncated = result.truncated === true || matches.length > shown.length;
  return {
    text: [
      `${key}=${matches.length}${truncated ? " truncated=true" : ""}`,
      ...shown.map((item) => `- ${truncateClean(item, SEARCH_LINE_CHARS)}`)
    ].join("\n"),
    truncated
  };
}

function formatListFiles(result: Record<string, unknown>): ViewDraft {
  const entries = asArray(result.entries);
  const shown = entries.slice(0, LIST_VIEW_ENTRIES);
  const truncated = result.truncated === true || entries.length > shown.length;
  const total = Number.isFinite(Number(result.total)) ? Number(result.total) : entries.length;
  return {
    text: [
      `entries=${shown.length}/${total}${truncated ? " truncated=true" : ""}`,
      ...shown.map((item) => {
        const record = asRecord(item);
        return `- ${record.type ?? "file"} ${stringField(record.name) || "?"}`;
      })
    ].join("\n"),
    truncated
  };
}

function formatShell(result: Record<string, unknown>): ViewDraft {
  const stdout = headTail(String(result.stdout ?? ""), SHELL_HEAD_CHARS, SHELL_TAIL_CHARS);
  const stderr = headTail(String(result.stderr ?? ""), SHELL_HEAD_CHARS, SHELL_TAIL_CHARS);
  const truncated = stdout.truncated || stderr.truncated
    || result.stdoutTruncated === true || result.stderrTruncated === true;
  const lines = [];
  if (stdout.text) {
    lines.push("stdout:", stdout.text);
  }
  if (stderr.text) {
    lines.push("stderr:", stderr.text);
  }
  return { text: lines.join("\n"), truncated };
}

function formatFetch(result: Record<string, unknown>): ViewDraft {
  const excerpt = headTail(String(result.content ?? ""), FETCH_EXCERPT_CHARS / 2, FETCH_EXCERPT_CHARS / 2);
  const bytes = Number.isFinite(Number(result.bytes)) ? Number(result.bytes) : Buffer.byteLength(String(result.content ?? ""), "utf8");
  return {
    text: [
      `status=${result.status ?? ""} bytes=${bytes}${result.truncated === true || excerpt.truncated ? " truncated=true" : ""}`,
      excerpt.text
    ].filter((item) => item.trim()).join("\n"),
    truncated: excerpt.truncated || result.truncated === true
  };
}

function formatWebSearch(result: Record<string, unknown>): ViewDraft {
  const results = asArray(result.results);
  const shown = results.slice(0, WEB_SEARCH_RESULTS);
  const truncated = result.truncated === true || results.length > shown.length;
  return {
    text: [
      `results=${results.length}${truncated ? " truncated=true" : ""}`,
      ...shown.map((item) => {
        const record = asRecord(item);
        return `- ${truncateClean(record.title, 120)}${record.url ? ` <${record.url}>` : ""}${record.snippet ? ` — ${truncateClean(record.snippet, 180)}` : ""}`;
      })
    ].join("\n"),
    truncated
  };
}

function formatGit(result: Record<string, unknown>): ViewDraft {
  const stdout = headTail(String(result.stdout ?? ""), GIT_EXCERPT_CHARS / 2, GIT_EXCERPT_CHARS / 2);
  const truncated = stdout.truncated || result.stdoutTruncated === true;
  const extra = [];
  if (Array.isArray(result.status)) {
    extra.push(`files=${result.status.length}`);
  }
  if (Array.isArray(result.commits)) {
    extra.push(`commits=${result.commits.length}`);
  }
  return {
    text: [...extra, stdout.text].filter(Boolean).join("\n"),
    truncated
  };
}

function formatWrite(result: Record<string, unknown>): ViewDraft {
  const stats = asRecord(result.changeStats);
  const lines = [
    result.created === true ? "created=true" : result.edited === false ? "edited=false" : "edited=true",
    Number.isFinite(Number(result.bytesWritten)) ? `bytesWritten=${Number(result.bytesWritten)}` : "",
    Number.isFinite(Number(stats.additions)) ? `additions=${Number(stats.additions)} deletions=${Number(stats.deletions ?? 0)}` : ""
  ].filter(Boolean);
  const diff = String(result.diff ?? "").trim();
  if (diff) {
    const preview = diff.split(/\r?\n/).slice(0, DIFF_PREVIEW_LINES).join("\n");
    const truncated = diff.split(/\r?\n/).length > DIFF_PREVIEW_LINES || result.diffTruncated === true;
    lines.push(preview);
    return { text: lines.join("\n"), truncated };
  }
  return { text: lines.join("\n"), truncated: result.diffTruncated === true };
}

function formatAgent(execution: ToolResultValue, result: Record<string, unknown>): ViewDraft {
  const output = String(result.outputSummary ?? result.output ?? execution.outputSummary ?? execution.output ?? "").trim();
  const excerpt = headTail(output, AGENT_OUTPUT_CHARS / 2, AGENT_OUTPUT_CHARS / 2);
  return {
    text: excerpt.text || "no output",
    truncated: excerpt.truncated || result.outputTruncated === true
  };
}

function formatMcp(result: Record<string, unknown>): ViewDraft {
  const payload = result.content ?? result.result ?? result;
  const omitted = omitImagePayloads(payload);
  if (omitted.images > 0 && !omitted.text) {
    return {
      text: `images=${omitted.images} omitted=true; 像素未写入工具结果，需要视觉复核时使用视觉证据通道。`,
      truncated: true
    };
  }
  const excerpt = headTail(omitted.text || stringifyCompact(payload), GENERIC_EXCERPT_CHARS / 2, GENERIC_EXCERPT_CHARS / 2);
  const lines = [];
  if (omitted.images > 0) {
    lines.push(`images=${omitted.images} omitted=true`);
  }
  lines.push(excerpt.text);
  return { text: lines.join("\n"), truncated: excerpt.truncated || omitted.images > 0 };
}

function formatDocument(result: Record<string, unknown>): ViewDraft {
  const content = String(result.content ?? result.body ?? result.text ?? result.instructions ?? "");
  const excerpt = headTail(content, GENERIC_EXCERPT_CHARS / 2, GENERIC_EXCERPT_CHARS / 2);
  const name = stringField(result.name);
  return {
    text: [name ? `name=${name}` : "", excerpt.text].filter(Boolean).join("\n"),
    truncated: excerpt.truncated || result.contentTruncated === true
  };
}

function formatGeneric(result: Record<string, unknown>): ViewDraft {
  const omitted = omitImagePayloads(result);
  const excerpt = headTail(omitted.text || stringifyCompact(result), GENERIC_EXCERPT_CHARS / 2, GENERIC_EXCERPT_CHARS / 2);
  const lines = [];
  if (omitted.images > 0) {
    lines.push(`images=${omitted.images} omitted=true`);
  }
  lines.push(excerpt.text);
  return { text: lines.filter(Boolean).join("\n"), truncated: excerpt.truncated || omitted.images > 0 };
}

function omitImagePayloads(value: unknown): { text: string; images: number } {
  let images = 0;
  const cleaned = rewrite(value);
  return {
    text: typeof cleaned === "string" ? cleaned : stringifyCompact(cleaned),
    images
  };

  function rewrite(input: unknown): unknown {
    if (Array.isArray(input)) {
      return input.map((item) => rewrite(item));
    }
    if (!isPlainObject(input)) {
      return input;
    }
    if (input.type === "image" || isImageLike(input)) {
      images += 1;
      const size = Number(input.size ?? input.bytes) || Buffer.byteLength(String(input.data ?? ""), "utf8");
      return {
        type: "image",
        name: input.name ?? "image",
        mimeType: input.mimeType ?? input.mime_type,
        bytes: size,
        omitted: true
      };
    }
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(input)) {
      next[key] = rewrite(entry);
    }
    return next;
  }
}

function isImageLike(value: Record<string, unknown>): boolean {
  const mime = String(value.mimeType ?? value.mime_type ?? "").toLowerCase();
  if (mime.startsWith("image/")) {
    return Boolean(value.data);
  }
  const data = String(value.data ?? "");
  return data.length > 200 && /^[A-Za-z0-9+/=\s]+$/.test(data) && Boolean(value.width || value.height || value.mimeType);
}

function numberLines(content: string): string {
  if (!content) {
    return "";
  }
  return content.split(/\r?\n/).map((line, index) => `${index + 1}: ${line}`).join("\n");
}

function headTail(text: string, headChars: number, tailChars: number): ViewDraft {
  const value = String(text ?? "");
  if (!value) {
    return { text: "", truncated: false };
  }
  if (value.length <= headChars + tailChars + 48) {
    return { text: value, truncated: false };
  }
  const omitted = value.length - headChars - tailChars;
  return {
    text: `${value.slice(0, headChars)}\n...[${omitted} chars omitted]...\n${value.slice(-tailChars)}`,
    truncated: true
  };
}

function stringifyCompact(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return String(value ?? "");
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function truncateClean(value: unknown, maxChars: number): string {
  const text = cleanInline(value);
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function cleanInline(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}
