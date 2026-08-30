import type { AgentSession } from "../../core/session.ts";
import { line, permissionModeLabel, splitLines, truncate } from "./format.ts";

export const MAX_INSPECTOR_ITEMS = 30;
export const INSPECTOR_FILTERS = ["all", "command", "diff", "tool", "approval", "gateway", "context"] as const;
export const INSPECTOR_FILTER_LABELS = Object.freeze({
  all: "全部",
  command: "命令",
  diff: "Diff",
  tool: "工具",
  approval: "审批",
  gateway: "网关",
  context: "上下文"
});
export const INSPECTOR_OUTPUT_COMMANDS = new Set([
  "agents",
  "context",
  "cost",
  "diff",
  "files",
  "gateway",
  "help",
  "hooks",
  "keybindings",
  "map",
  "mcp",
  "memory",
  "model",
  "next",
  "permissions",
  "report",
  "review",
  "sessions",
  "status",
  "usage",
  "verify"
]);

type InspectorFilter = (typeof INSPECTOR_FILTERS)[number];

export type InspectorItem = {
  category?: string;
  title?: string;
  source?: string;
  text?: string;
  at?: string;
};

type InspectorInput = InspectorItem | Record<string, unknown>;

type InspectorTextOptions = {
  diff?: boolean;
};

type PatchHunk = {
  header: string;
  oldStart: number | null;
  oldLines: number | null;
  newStart: number | null;
  newLines: number | null;
  additions: number;
  deletions: number;
  lines: string[];
};

type PatchFile = {
  oldPath: string;
  newPath: string;
  displayPath?: string;
  lines: string[];
  hunks: PatchHunk[];
  additions: number;
  deletions: number;
};

type ParsedPatch = {
  files: PatchFile[];
  totalAdditions: number;
  totalDeletions: number;
  totalHunks: number;
  lineCount: number;
};

const EMPTY_INSPECTOR: InspectorItem = {};
const EMPTY_TEXT_OPTIONS: InspectorTextOptions = {};

export function initialInspector(session: AgentSession): InspectorItem {
  return makeInspector("欢迎", "Ant Code TUI v1.0", [
    `模型：${session.model}`,
    `模式：${permissionModeLabel(session)}`,
    `网络：${session.networkMode}`,
    "",
    "可运行 /status、/files、/diff --stat、/review、/verify suggest、/next 或 /report，在这里查看本地状态。",
    "Inspector 会保留当前进程内最近的命令和工具详情，支持类型过滤，并为 diff 输出提供本地 patch 浏览；这些内容不会作为 transcript 持久化。"
  ].join("\n"), "context");
}

export function makeInspector(title: string, source: string, text: string, category: string = "command"): InspectorItem {
  return {
    category,
    title,
    source,
    text: text ?? "",
    at: new Date().toLocaleTimeString()
  };
}

export function inspectorCategoryForCommand(commandName: string, outputText: string): string {
  if (commandName === "diff") {
    return "diff";
  }
  if (commandName === "review" && looksDiffLike(outputText)) {
    return "diff";
  }
  if (commandName === "status" || commandName === "report" || commandName === "next") {
    return "context";
  }
  return "command";
}

export function nextInspectorFilter(value: string, direction: number = 1): string {
  const index = (INSPECTOR_FILTERS as readonly string[]).indexOf(value);
  const current = index >= 0 ? index : 0;
  const next = (current + direction + INSPECTOR_FILTERS.length) % INSPECTOR_FILTERS.length;
  return INSPECTOR_FILTERS[next] ?? INSPECTOR_FILTERS[0];
}

export function inspectorFilterLabel(value: string): string {
  if (isInspectorFilter(value)) {
    return INSPECTOR_FILTER_LABELS[value];
  }
  return value || "全部";
}

export function moveInspectorIndex(
  items: InspectorInput[],
  currentIndex: number,
  filter: string,
  direction: number
): number {
  const list = asInspectorItems(items);
  const indices = matchingInspectorIndices(list, filter);
  if (indices.length === 0) {
    return Math.max(0, Math.min(list.length - 1, currentIndex));
  }
  const currentPosition = indices.includes(currentIndex)
    ? indices.indexOf(currentIndex)
    : direction > 0 ? -1 : indices.length;
  const nextPosition = Math.max(0, Math.min(indices.length - 1, currentPosition + direction));
  return indices[nextPosition] ?? currentIndex;
}

export function resolveInspectorIndex(items: InspectorInput[], currentIndex: number, filter: string): number {
  const list = asInspectorItems(items);
  const indices = matchingInspectorIndices(list, filter);
  if (indices.length === 0) {
    return Math.max(0, Math.min(list.length - 1, currentIndex));
  }
  if (indices.includes(currentIndex)) {
    return currentIndex;
  }
  return indices[indices.length - 1] ?? currentIndex;
}

export function matchingInspectorIndices(items: InspectorInput[], filter: string): number[] {
  return asInspectorItems(items)
    .map((item, index) => itemMatchesInspectorFilter(item, filter) ? index : null)
    .filter((index): index is number => index !== null);
}

export function itemMatchesInspectorFilter(item: InspectorItem, filter: string): boolean {
  return filter === "all" || item?.category === filter;
}

export function inspectorPanelLines(
  inspector: InspectorInput | null | undefined,
  items: InspectorInput[],
  index: number,
  offset: number,
  filter: string,
  visibleRows: number,
  patchFileIndex: number = 0
) {
  const view = asInspectorItem(inspector);
  const list = asInspectorItems(items);
  if (view.category === "diff") {
    const patchLines = patchPanelLines(view, list, index, offset, filter, visibleRows, patchFileIndex);
    if (patchLines) {
      return patchLines;
    }
  }

  const matchingIndices = matchingInspectorIndices(list, filter);
  if (matchingIndices.length === 0) {
    return [
      line(`没有 ${inspectorFilterLabel(filter)} 类型的日志项`, true),
      line(`过滤：${inspectorFilterLabel(filter)} 0/${list.length}`),
      line("在 /logs 面板顶部用 Tab 或 Left/Right 切换类型。"),
      line("运行 /diff、/review、/status、/verify 或一次模型轮次后，会添加运行日志。")
    ];
  }

  const allLines = splitLines(view.text);
  const safeOffset = Math.min(Math.max(0, offset), Math.max(0, allLines.length - 1));
  const lineBudget = Math.max(4, visibleRows - 8);
  const excerpt = allLines.slice(safeOffset, safeOffset + lineBudget);
  const filteredPosition = Math.max(0, matchingIndices.indexOf(index));
  const filterLabel = `${inspectorFilterLabel(filter)} ${matchingIndices.length}/${list.length}`;
  return [
    line(`${view.title} (${filteredPosition + 1}/${Math.max(1, matchingIndices.length)})`, true),
    line(`过滤：${filterLabel}`),
    line(`类型：${view.category ?? "command"}`),
    line(`来源：${view.source}`),
    line(`更新：${view.at}`),
    line(`字节：${Buffer.byteLength(view.text ?? "", "utf8")}`),
    line(`行数：${allLines.length}，偏移：${allLines.length === 0 ? 0 : safeOffset + 1}`),
    line("/logs 顶部切换类型，Up/Down 或滚轮滚动内容。", true),
    line(""),
    ...(excerpt.length === 0
      ? [line("暂无日志内容。", true)]
      : excerpt.map((text) => inspectorTextLine(text, { diff: view.category === "diff" }))),
    ...(allLines.length > safeOffset + excerpt.length
      ? [line(""), line(`... 还有 ${allLines.length - safeOffset - excerpt.length} 行`, true)]
      : [])
  ];
}

export function parsePatch(text: string): ParsedPatch | null {
  const allLines = (text ?? "").split(/\r?\n/);
  const patchLines = allLines.length > 1 && allLines[allLines.length - 1] === ""
    ? allLines.slice(0, -1)
    : allLines;
  const files: PatchFile[] = [];
  let current: PatchFile | null = null;

  for (let index = 0; index < patchLines.length; index += 1) {
    const textLine = patchLines[index];
    if (/^diff --git\s+/.test(textLine)) {
      current = createPatchFileFromDiffLine(textLine);
      files.push(current);
      addPatchLine(current, textLine);
      continue;
    }

    if (!current && /^---\s+/.test(textLine) && /^\+\+\+\s+/.test(patchLines[index + 1] ?? "")) {
      current = createPatchFile(
        cleanPatchPath(textLine.replace(/^---\s+/, "")),
        cleanPatchPath((patchLines[index + 1] ?? "").replace(/^\+\+\+\s+/, ""))
      );
      files.push(current);
      addPatchLine(current, textLine);
      continue;
    }

    if (!current) {
      continue;
    }

    if (/^---\s+/.test(textLine)) {
      current.oldPath = cleanPatchPath(textLine.replace(/^---\s+/, ""));
    } else if (/^\+\+\+\s+/.test(textLine)) {
      current.newPath = cleanPatchPath(textLine.replace(/^\+\+\+\s+/, ""));
    }
    addPatchLine(current, textLine);
  }

  const patchFiles = files
    .filter((file) => file.lines.length > 0 && (file.hunks.length > 0 || file.lines.some((textLine) => /^diff --git\s+/.test(textLine))))
    .map((file) => ({
      oldPath: file.oldPath,
      newPath: file.newPath,
      displayPath: displayPatchPath(file),
      lines: file.lines,
      hunks: file.hunks,
      additions: file.additions,
      deletions: file.deletions
    }));

  if (patchFiles.length === 0) {
    return null;
  }

  return {
    files: patchFiles,
    totalAdditions: patchFiles.reduce((sum, file) => sum + file.additions, 0),
    totalDeletions: patchFiles.reduce((sum, file) => sum + file.deletions, 0),
    totalHunks: patchFiles.reduce((sum, file) => sum + file.hunks.length, 0),
    lineCount: patchLines.length
  };
}

export function patchSummaryLines(patch: ParsedPatch | null | undefined, maxFiles: number = 8) {
  if (!patch) {
    return [];
  }
  const shownFiles = patch.files.slice(0, maxFiles);
  return [
    line(`文件：${patch.files.length}，hunks：${patch.totalHunks}，+${patch.totalAdditions} -${patch.totalDeletions}`),
    ...shownFiles.map((file, index) => line(`${index + 1}. ${truncate(file.displayPath ?? displayPatchPath(file), 72)} +${file.additions} -${file.deletions} h=${file.hunks.length}`)),
    ...(patch.files.length > shownFiles.length ? [line(`... 还有 ${patch.files.length - shownFiles.length} 个文件`, true)] : [])
  ];
}

export function patchPanelLines(
  inspector: InspectorInput | null | undefined,
  items: InspectorInput[],
  index: number,
  offset: number,
  filter: string,
  visibleRows: number,
  patchFileIndex: number = 0
) {
  const view = asInspectorItem(inspector);
  const list = asInspectorItems(items);
  const patch = parsePatch(view.text ?? "");
  if (!patch) {
    return null;
  }

  const matchingIndices = matchingInspectorIndices(list, filter);
  const fileIndex = resolvePatchFileIndex(patch, patchFileIndex);
  const file = patch.files[fileIndex];
  const safeOffset = Math.min(Math.max(0, offset), Math.max(0, file.lines.length - 1));
  const lineBudget = Math.max(4, visibleRows - 12);
  const excerpt = file.lines.slice(safeOffset, safeOffset + lineBudget);
  const filteredPosition = Math.max(0, matchingIndices.indexOf(index));
  const filterLabel = `${inspectorFilterLabel(filter)} ${matchingIndices.length}/${list.length}`;
  const hunkSummary = file.hunks.length === 0
    ? "none"
    : file.hunks.slice(0, 2).map((hunk) => hunkRangeLabel(hunk)).join("; ");

  return [
    line(`${view.title} (${filteredPosition + 1}/${Math.max(1, matchingIndices.length)})`, true),
    line(`过滤：${filterLabel}`),
    line(`类型：${view.category ?? "diff"}`),
    line(`来源：${view.source}`),
    line(`更新：${view.at}`),
    line(`patch：${patch.files.length} 个文件，${patch.totalHunks} 个 hunk，+${patch.totalAdditions} -${patch.totalDeletions}`),
    line(`文件：${fileIndex + 1}/${patch.files.length} ${truncate(file.displayPath ?? displayPatchPath(file), 72)}`),
    line(`改动：+${file.additions} -${file.deletions}，hunks：${file.hunks.length}`),
    line(`hunk 范围：${truncate(hunkSummary, 80)}`, file.hunks.length === 0),
    line(`行数：${file.lines.length}，偏移：${file.lines.length === 0 ? 0 : safeOffset + 1}`),
    line("/logs 顶部切换类型；需要完整 diff 可用 /diff。", true),
    line(""),
    ...(excerpt.length === 0
      ? [line("此文件暂无 patch 内容。", true)]
      : excerpt.map((textLine) => inspectorTextLine(textLine, { diff: true }))),
    ...(file.lines.length > safeOffset + excerpt.length
      ? [line(""), line(`... 文件内还有 ${file.lines.length - safeOffset - excerpt.length} 行`, true)]
      : [])
  ];
}

export function resolvePatchFileIndex(patch: ParsedPatch | null | undefined, currentIndex: number): number {
  const count = patch?.files?.length ?? 0;
  if (count === 0) {
    return 0;
  }
  return Math.max(0, Math.min(count - 1, Number.isInteger(currentIndex) ? currentIndex : 0));
}

export function movePatchFileIndex(inspector: InspectorInput | null | undefined, currentIndex: number, direction: number): number {
  const patch = parsePatch(asInspectorItem(inspector).text ?? "");
  const count = patch?.files?.length ?? 0;
  if (count === 0) {
    return 0;
  }
  const safeIndex = resolvePatchFileIndex(patch, currentIndex);
  return (safeIndex + direction + count) % count;
}

export function inspectorTextLine(text: string, options: InspectorTextOptions = EMPTY_TEXT_OPTIONS) {
  const value = truncate(text, 96);
  const diff = options.diff === true;
  if (diff) {
    if (/^(diff --git|index [0-9a-f]+\.\.|--- |\+\+\+ )/.test(text)) {
      return line(value, false, "magenta");
    }
    if (/^@@ /.test(text)) {
      return line(value, false, "cyan");
    }
    if (/^\+/.test(text) && !/^\+\+\+/.test(text)) {
      return line(value, false, "green");
    }
    if (/^-/.test(text) && !/^---/.test(text)) {
      return line(value, false, "red");
    }
  }
  if (/^(exit:|stdout|stderr|error:|Git |Ant Code )/.test(text)) {
    return line(value, true);
  }
  return line(value);
}

function asInspectorItem(value: InspectorInput | null | undefined): InspectorItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return EMPTY_INSPECTOR;
  }
  return {
    category: typeof value.category === "string" ? value.category : undefined,
    title: typeof value.title === "string" ? value.title : undefined,
    source: typeof value.source === "string" ? value.source : undefined,
    text: typeof value.text === "string" ? value.text : undefined,
    at: typeof value.at === "string" ? value.at : undefined
  };
}

function asInspectorItems(items: InspectorInput[] | null | undefined): InspectorItem[] {
  return Array.isArray(items) ? items.map((item) => asInspectorItem(item)) : [];
}

function looksDiffLike(text: string): boolean {
  return /(^diff --git|^@@ |^\+\+\+ |^--- )/m.test(text ?? "");
}

function isInspectorFilter(value: string): value is InspectorFilter {
  return Object.hasOwn(INSPECTOR_FILTER_LABELS, value);
}

function createPatchFileFromDiffLine(textLine: string): PatchFile {
  const paths = parseDiffGitPaths(textLine);
  return createPatchFile(paths.oldPath, paths.newPath);
}

function createPatchFile(oldPath: string = "unknown", newPath: string = oldPath): PatchFile {
  return {
    oldPath,
    newPath,
    lines: [],
    hunks: [],
    additions: 0,
    deletions: 0
  };
}

function addPatchLine(file: PatchFile, textLine: string) {
  file.lines.push(textLine);
  if (/^@@ /.test(textLine)) {
    file.hunks.push(parseHunk(textLine));
    return;
  }

  const currentHunk = file.hunks[file.hunks.length - 1];
  if (currentHunk) {
    currentHunk.lines.push(textLine);
  }

  if (/^\+/.test(textLine) && !/^\+\+\+/.test(textLine)) {
    file.additions += 1;
    if (currentHunk) {
      currentHunk.additions += 1;
    }
  } else if (/^-/.test(textLine) && !/^---/.test(textLine)) {
    file.deletions += 1;
    if (currentHunk) {
      currentHunk.deletions += 1;
    }
  }
}

function parseHunk(textLine: string): PatchHunk {
  const match = textLine.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
  return {
    header: textLine,
    oldStart: match ? Number(match[1]) : null,
    oldLines: match ? Number(match[2] ?? "1") : null,
    newStart: match ? Number(match[3]) : null,
    newLines: match ? Number(match[4] ?? "1") : null,
    additions: 0,
    deletions: 0,
    lines: [textLine]
  };
}

function hunkRangeLabel(hunk: PatchHunk): string {
  if (hunk.oldStart === null || hunk.newStart === null) {
    return truncate(hunk.header, 28);
  }
  return `-${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines}`;
}

function parseDiffGitPaths(textLine: string): { oldPath: string; newPath: string } {
  const body = textLine.replace(/^diff --git\s+/, "");
  const quoted = [...body.matchAll(/"((?:\\"|[^"])*)"/g)].map((match) => unquoteGitPath(match[1]));
  if (quoted.length >= 2) {
    return {
      oldPath: cleanPatchPath(quoted[0]),
      newPath: cleanPatchPath(quoted[1])
    };
  }

  const parts = body.trim().split(/\s+/);
  return {
    oldPath: cleanPatchPath(parts[0] ?? "unknown"),
    newPath: cleanPatchPath(parts[1] ?? parts[0] ?? "unknown")
  };
}

function cleanPatchPath(value: string): string {
  let text = (value ?? "").trim();
  if (text.startsWith("\"")) {
    const closingQuote = text.lastIndexOf("\"");
    if (closingQuote > 0) {
      text = unquoteGitPath(text.slice(1, closingQuote));
    }
  } else {
    text = text.split("\t")[0];
  }
  if (text === "/dev/null") {
    return text;
  }
  return text.replace(/^[ab]\//, "") || "unknown";
}

function unquoteGitPath(value: string): string {
  return (value ?? "")
    .replace(/\\"/g, "\"")
    .replace(/\\t/g, "\t")
    .replace(/\\n/g, "\n");
}

function displayPatchPath(file: PatchFile): string {
  if (file.newPath && file.newPath !== "/dev/null" && file.oldPath && file.oldPath !== file.newPath && file.oldPath !== "/dev/null") {
    return `${file.oldPath} -> ${file.newPath}`;
  }
  if (file.newPath && file.newPath !== "/dev/null") {
    return file.newPath;
  }
  return file.oldPath || "unknown";
}
