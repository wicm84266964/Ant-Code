export type InputDraft = {
  text: string;
  cursor: number;
  visibleStart?: number;
  preferredColumn?: number;
};

type DraftLine = {
  text: string;
  start: number;
  end: number;
};

type DraftViewOptions = {
  columns?: number | null;
  maxLines?: number | null;
  visibleStart?: number | null;
  showCursor?: boolean;
};

type ComposerSegment = {
  text?: string;
  cursor?: boolean;
  hidden?: boolean;
};

const EMPTY_DRAFT_OPTIONS: DraftViewOptions = {};
const GRAPHEME_SEGMENTER = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : null;
const GRAPHEME_CACHE_LIMIT = 4;
const graphemeCache = new Map<string, string[]>();
const GRAPHEME_WIDTH_CACHE_LIMIT = 512;
const graphemeWidthCache = new Map<string, number>();

export function createDraft(text: string = "", cursor: number | null = null): InputDraft {
  const chars = toChars(text);
  const resolvedCursor = cursor === null ? chars.length : clampCursor(cursor, chars.length);
  return { text: chars.join(""), cursor: resolvedCursor };
}

export function insertText(draft: InputDraft, value: string): InputDraft {
  const chars = toChars(draft?.text);
  const insert = toChars(value);
  const cursor = clampCursor(draft?.cursor, chars.length);
  chars.splice(cursor, 0, ...insert);
  return editedDraft(draft, chars.join(""), cursor + insert.length, chars);
}

export function deleteBackward(draft: InputDraft): InputDraft {
  const chars = toChars(draft?.text);
  const cursor = clampCursor(draft?.cursor, chars.length);
  if (cursor === 0) {
    return editedDraft(draft, chars.join(""), cursor, chars);
  }
  chars.splice(cursor - 1, 1);
  return editedDraft(draft, chars.join(""), cursor - 1, chars);
}

export function deleteForward(draft: InputDraft): InputDraft {
  const chars = toChars(draft?.text);
  const cursor = clampCursor(draft?.cursor, chars.length);
  if (cursor >= chars.length) {
    return editedDraft(draft, chars.join(""), cursor, chars);
  }
  chars.splice(cursor, 1);
  return editedDraft(draft, chars.join(""), cursor, chars);
}

export function deleteToStart(draft: InputDraft): InputDraft {
  const chars = toChars(draft?.text);
  const cursor = clampCursor(draft?.cursor, chars.length);
  const nextChars = chars.slice(cursor);
  return editedDraft(draft, nextChars.join(""), 0, nextChars);
}

export function deleteToEnd(draft: InputDraft): InputDraft {
  const chars = toChars(draft?.text);
  const cursor = clampCursor(draft?.cursor, chars.length);
  const nextChars = chars.slice(0, cursor);
  return editedDraft(draft, nextChars.join(""), cursor, nextChars);
}

export function deleteWordBackward(draft: InputDraft): InputDraft {
  const chars = toChars(draft?.text);
  const cursor = clampCursor(draft?.cursor, chars.length);
  const start = previousWordBoundary(chars, cursor);
  chars.splice(start, cursor - start);
  return editedDraft(draft, chars.join(""), start, chars);
}

export function deleteWordForward(draft: InputDraft): InputDraft {
  const chars = toChars(draft?.text);
  const cursor = clampCursor(draft?.cursor, chars.length);
  const end = nextWordBoundary(chars, cursor);
  chars.splice(cursor, end - cursor);
  return editedDraft(draft, chars.join(""), cursor, chars);
}

export function moveCursor(draft: InputDraft, direction: string): InputDraft {
  const chars = toChars(draft?.text);
  const cursor = clampCursor(draft?.cursor, chars.length);
  if (direction === "start") {
    return movedDraft(draft, chars.join(""), 0, chars);
  }
  if (direction === "end") {
    return movedDraft(draft, chars.join(""), chars.length, chars);
  }
  if (direction === "left") {
    return movedDraft(draft, chars.join(""), Math.max(0, cursor - 1), chars);
  }
  if (direction === "right") {
    return movedDraft(draft, chars.join(""), Math.min(chars.length, cursor + 1), chars);
  }
  if (direction === "word-left") {
    return movedDraft(draft, chars.join(""), previousWordBoundary(chars, cursor), chars);
  }
  if (direction === "word-right") {
    return movedDraft(draft, chars.join(""), nextWordBoundary(chars, cursor), chars);
  }
  return movedDraft(draft, chars.join(""), cursor, chars);
}

export function moveCursorLineBoundary(draft: InputDraft, direction: string, options: DraftViewOptions = EMPTY_DRAFT_OPTIONS): InputDraft {
  const chars = toChars(draft?.text);
  const text = chars.join("");
  const cursor = clampCursor(draft?.cursor, chars.length);
  const lines = wrapDraftLines(splitDraftLines(text), options.columns);
  const lineIndex = lines.findIndex((_line, index) => lineContainsCursor(lines, index, cursor));
  const line = lines[lineIndex === -1 ? lines.length - 1 : lineIndex];
  const nextCursor = direction === "end" ? line?.end ?? chars.length : line?.start ?? 0;
  return movedDraft(draft, text, nextCursor, chars);
}

export function moveCursorVertical(draft: InputDraft, direction: string | number, options: DraftViewOptions = EMPTY_DRAFT_OPTIONS): InputDraft {
  const chars = toChars(draft?.text);
  const text = chars.join("");
  const cursor = clampCursor(draft?.cursor, chars.length);
  const lines = wrapDraftLines(splitDraftLines(text), options.columns);
  if (lines.length <= 1) {
    return { text, cursor };
  }
  const currentIndex = lines.findIndex((_line, index) => lineContainsCursor(lines, index, cursor));
  const resolvedIndex = currentIndex === -1 ? lines.length - 1 : currentIndex;
  const delta = direction === "up" || direction === -1 ? -1 : 1;
  const targetIndex = resolvedIndex + delta;
  if (targetIndex < 0 || targetIndex >= lines.length) {
    return { text, cursor };
  }
  const currentLine = lines[resolvedIndex];
  const targetLine = lines[targetIndex];
  const preferredColumn = typeof draft?.preferredColumn === "number" && Number.isFinite(draft.preferredColumn)
    ? draft.preferredColumn
    : displayWidth(chars.slice(currentLine.start, cursor).join(""));
  return {
    ...movedDraft(draft, text, cursorAtVisualColumn(chars, targetLine, preferredColumn), chars),
    preferredColumn
  };
}

export function cursorVisualPosition(text: string, cursor: number | null | undefined, options: DraftViewOptions = EMPTY_DRAFT_OPTIONS) {
  const chars = toChars(text);
  const resolvedCursor = clampCursor(cursor, chars.length);
  const lines = wrapDraftLines(splitDraftLines(chars.join("")), options.columns);
  const maxLines = Math.max(1, typeof options.maxLines === "number" && Number.isFinite(options.maxLines) ? options.maxLines : 5);
  if (lines.length === 0 || (lines.length === 1 && lines[0].text === "")) {
    return { lineIndex: 0, column: 0, totalLines: 1, visibleStart: 0 };
  }
  const cursorLineIndex = lines.findIndex((_line, index) => lineContainsCursor(lines, index, resolvedCursor));
  const resolvedLineIndex = cursorLineIndex === -1 ? lines.length - 1 : cursorLineIndex;
  const visibleStart = stableVisibleStart(lines.length, resolvedLineIndex, maxLines, options.visibleStart);
  const line = lines[resolvedLineIndex] ?? lines[lines.length - 1];
  return {
    lineIndex: Math.max(0, resolvedLineIndex - visibleStart),
    column: displayWidth(chars.slice(line.start, resolvedCursor).join("")),
    totalLines: lines.length,
    visibleStart
  };
}

export function cursorToEnd(text: string) {
  return toChars(text).length;
}

export function clampDraftCursor(draft: InputDraft): InputDraft {
  const chars = toChars(draft?.text);
  return withDraftMetadata(draft, { text: chars.join(""), cursor: clampCursor(draft?.cursor, chars.length) }, true);
}

export function stabilizeDraftViewport(draft: InputDraft, options: DraftViewOptions = EMPTY_DRAFT_OPTIONS): InputDraft {
  const next = clampDraftCursor(draft);
  const position = cursorVisualPosition(next.text, next.cursor, {
    columns: options.columns,
    maxLines: options.maxLines,
    visibleStart: next.visibleStart
  });
  return { ...next, visibleStart: position.visibleStart };
}

export function splitDraftLines(text: string): DraftLine[] {
  const chars = toChars(text);
  const lines: DraftLine[] = [];
  let start = 0;
  let current: string[] = [];
  for (let index = 0; index < chars.length; index += 1) {
    if (chars[index] === "\n") {
      lines.push({ text: current.join(""), start, end: index });
      start = index + 1;
      current = [];
    } else {
      current.push(chars[index]);
    }
  }
  lines.push({ text: current.join(""), start, end: chars.length });
  return lines;
}

export function visibleDraftLineEntries(
  text: string,
  cursor: number | null | undefined,
  maxLines: number = 5,
  columns: number | null = null,
  visibleStart: number | null = null
): DraftLine[] {
  const lines = wrapDraftLines(splitDraftLines(text), columns);
  if (lines.length === 1 && lines[0].text === "") {
    return [];
  }
  const cursorLine = lines.findIndex((_line, index) => lineContainsCursor(lines, index, clampCursor(cursor, toChars(text).length)));
  const resolvedLine = cursorLine === -1 ? lines.length - 1 : cursorLine;
  const start = stableVisibleStart(lines.length, resolvedLine, maxLines, visibleStart);
  return lines.slice(start, start + maxLines);
}

export function composerSegments(text: string, cursor: number | null | undefined, options: DraftViewOptions = EMPTY_DRAFT_OPTIONS) {
  const chars = toChars(text);
  const resolvedCursor = clampCursor(cursor, chars.length);
  const lineEntries = visibleDraftLineEntries(
    text,
    resolvedCursor,
    typeof options.maxLines === "number" && Number.isFinite(options.maxLines) ? options.maxLines : 5,
    options.columns ?? null,
    options.visibleStart ?? null
  );
  const showCursor = options.showCursor !== false;
  return lineEntries.map((line, index) => {
    if (!lineContainsCursor(lineEntries, index, resolvedCursor)) {
      return { text: line.text, segments: [{ text: line.text || " " }] };
    }
    const before = chars.slice(line.start, resolvedCursor).join("");
    const cursorChar = chars[resolvedCursor] === "\n" || chars[resolvedCursor] === undefined
      ? " "
      : chars[resolvedCursor];
    const afterStart = chars[resolvedCursor] === "\n" || chars[resolvedCursor] === undefined
      ? resolvedCursor
      : resolvedCursor + 1;
    const after = chars.slice(afterStart, line.end).join("");
    const segments: ComposerSegment[] = [];
    if (before) {
      segments.push({ text: before });
    }
    segments.push({ text: cursorChar, cursor: true, hidden: !showCursor });
    if (after) {
      segments.push({ text: after });
    }
    return {
      text: `${before}${cursorChar}${after}`,
      segments
    };
  });
}

export function displayWidth(value: string): number {
  return toChars(value).reduce((sum, char) => sum + graphemeWidth(char, sum), 0);
}

export function cursorColumn(text: string, cursor: number | null | undefined): number {
  const chars = toChars(text);
  const resolvedCursor = clampCursor(cursor, chars.length);
  let lineStart = 0;
  for (let index = 0; index < resolvedCursor; index += 1) {
    if (chars[index] === "\n") {
      lineStart = index + 1;
    }
  }
  return displayWidth(chars.slice(lineStart, resolvedCursor).join(""));
}

function toChars(value: string | null | undefined): string[] {
  const text = value ?? "";
  if (!text) {
    return [];
  }
  const cached = graphemeCache.get(text);
  if (cached) {
    graphemeCache.delete(text);
    graphemeCache.set(text, cached);
    return cached.slice();
  }
  const chars = GRAPHEME_SEGMENTER
    ? Array.from(GRAPHEME_SEGMENTER.segment(text), (entry) => entry.segment)
    : Array.from(text);
  rememberGraphemes(text, chars);
  return chars.slice();
}

function rememberGraphemes(text: string, chars: string[]) {
  graphemeCache.delete(text);
  graphemeCache.set(text, chars.slice());
  while (graphemeCache.size > GRAPHEME_CACHE_LIMIT) {
    const oldest = graphemeCache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    graphemeCache.delete(oldest);
  }
}

function clampCursor(value: number | null | undefined, length: number): number {
  const numeric = typeof value === "number" && Number.isFinite(value) ? value : length;
  return Math.min(Math.max(0, numeric), length);
}

function wrapDraftLines(lines: DraftLine[], columns: number | null | undefined): DraftLine[] {
  const maxColumns = typeof columns === "number" && Number.isFinite(columns) && columns > 0
    ? Math.max(1, Math.floor(columns))
    : null;
  if (!maxColumns) {
    return lines;
  }
  const wrapped: DraftLine[] = [];
  for (const line of lines) {
    if (!line.text) {
      wrapped.push(line);
      continue;
    }
    const chars = toChars(line.text);
    let rowStartOffset = 0;
    let rowWidth = 0;
    for (let offset = 0; offset < chars.length; offset += 1) {
      const width = Math.max(1, graphemeWidth(chars[offset], rowWidth));
      if (rowWidth > 0 && rowWidth + width > maxColumns) {
        wrapped.push(lineSlice(line, chars, rowStartOffset, offset));
        rowStartOffset = offset;
        rowWidth = 0;
      }
      rowWidth += width;
    }
    wrapped.push(lineSlice(line, chars, rowStartOffset, chars.length));
  }
  return wrapped;
}

function lineSlice(line: DraftLine, chars: string[], startOffset: number, endOffset: number): DraftLine {
  return {
    text: chars.slice(startOffset, endOffset).join(""),
    start: line.start + startOffset,
    end: line.start + endOffset
  };
}

function lineContainsCursor(lines: DraftLine[], index: number, cursor: number): boolean {
  const line = lines[index];
  if (!line || cursor < line.start || cursor > line.end) {
    return false;
  }
  if (line.start === line.end) {
    return cursor === line.start;
  }
  const next = lines[index + 1];
  if (cursor === line.end && next && next.start === line.end) {
    return false;
  }
  return true;
}

function cursorAtVisualColumn(chars: string[], line: DraftLine, column: number): number {
  const targetColumn = Math.max(0, Number.isFinite(column) ? column : 0);
  let width = 0;
  for (let index = line.start; index < line.end; index += 1) {
    const charWidthValue = Math.max(1, graphemeWidth(chars[index], width));
    if (targetColumn <= width + Math.floor(charWidthValue / 2)) {
      return index;
    }
    if (targetColumn <= width + charWidthValue) {
      return index + 1;
    }
    width += charWidthValue;
  }
  return line.end;
}

function previousWordBoundary(chars: string[], cursor: number): number {
  let index = Math.max(0, cursor);
  while (index > 0 && isWhitespace(chars[index - 1])) {
    index -= 1;
  }
  while (index > 0 && !isWhitespace(chars[index - 1])) {
    index -= 1;
  }
  return index;
}

function nextWordBoundary(chars: string[], cursor: number): number {
  let index = Math.min(chars.length, Math.max(0, cursor));
  while (index < chars.length && !isWhitespace(chars[index])) {
    index += 1;
  }
  while (index < chars.length && isWhitespace(chars[index])) {
    index += 1;
  }
  return index;
}

function isWhitespace(char: string | undefined): boolean {
  return /\s/u.test(char ?? "");
}

function graphemeWidth(grapheme: string | undefined, column: number = 0): number {
  if (!grapheme) {
    return 0;
  }
  if (grapheme === "\n" || grapheme === "\r") {
    return 0;
  }
  if (grapheme === "\t") {
    return 4 - (Math.max(0, column || 0) % 4);
  }
  const cached = graphemeWidthCache.get(grapheme);
  if (cached !== undefined) {
    return cached;
  }
  let width = 0;
  if (/\p{Emoji_Presentation}/u.test(grapheme) || /\uFE0F|\u200D/u.test(grapheme) || isRegionalIndicatorPair(grapheme)) {
    width = 2;
  } else {
    width = 0;
    for (const char of Array.from(grapheme)) {
      width += codePointWidth(char);
    }
  }
  rememberGraphemeWidth(grapheme, width);
  return width;
}

function rememberGraphemeWidth(grapheme: string, width: number) {
  graphemeWidthCache.delete(grapheme);
  graphemeWidthCache.set(grapheme, width);
  while (graphemeWidthCache.size > GRAPHEME_WIDTH_CACHE_LIMIT) {
    const oldest = graphemeWidthCache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    graphemeWidthCache.delete(oldest);
  }
}

function codePointWidth(char: string): number {
  if (/\p{Mark}/u.test(char) || char === "\u200D" || char === "\uFE0E" || char === "\uFE0F") {
    return 0;
  }
  const code = char.codePointAt(0);
  if (code === undefined) {
    return 0;
  }
  if (code === 0) {
    return 0;
  }
  if (code < 32 || (code >= 0x7f && code < 0xa0)) {
    return 0;
  }
  return isWideCodePoint(code) ? 2 : 1;
}

function isRegionalIndicatorPair(value: string): boolean {
  const chars = Array.from(value);
  return chars.length === 2 && chars.every((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code >= 0x1f1e6 && code <= 0x1f1ff;
  });
}

function stableVisibleStart(lineCount: number, cursorLine: number, maxLines: number, requestedStart: number | null | undefined): number {
  const maximum = Math.max(0, lineCount - maxLines);
  let start = typeof requestedStart === "number" && Number.isFinite(requestedStart)
    ? Math.min(maximum, Math.max(0, Math.floor(requestedStart)))
    : Math.min(maximum, Math.max(0, cursorLine - maxLines + 1));
  if (cursorLine < start) {
    start = cursorLine;
  } else if (cursorLine >= start + maxLines) {
    start = cursorLine - maxLines + 1;
  }
  return Math.min(maximum, Math.max(0, start));
}

function editedDraft(draft: InputDraft, text: string, cursor: number, chars: string[] | null = null): InputDraft {
  if (chars) {
    rememberGraphemes(text, chars);
  }
  return withDraftMetadata(draft, { text, cursor }, false);
}

function movedDraft(draft: InputDraft, text: string, cursor: number, chars: string[] | null = null): InputDraft {
  if (chars) {
    rememberGraphemes(text, chars);
  }
  return withDraftMetadata(draft, { text, cursor }, false);
}

function withDraftMetadata(
  draft: InputDraft | null | undefined,
  next: { text: string; cursor: number; preferredColumn?: number },
  preservePreferredColumn: boolean
): InputDraft {
  const result: InputDraft = {
    text: next.text,
    cursor: next.cursor
  };
  if (typeof draft?.visibleStart === "number" && Number.isFinite(draft.visibleStart)) {
    result.visibleStart = Math.max(0, Math.floor(draft.visibleStart));
  }
  if (preservePreferredColumn && typeof draft?.preferredColumn === "number" && Number.isFinite(draft.preferredColumn)) {
    result.preferredColumn = Math.max(0, draft.preferredColumn);
  } else if (typeof next.preferredColumn === "number" && Number.isFinite(next.preferredColumn)) {
    result.preferredColumn = next.preferredColumn;
  }
  return result;
}

function isWideCodePoint(code: number): boolean {
  return (
    code >= 0x1100 && (
      code <= 0x115f ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1f64f) ||
      (code >= 0x1f900 && code <= 0x1f9ff)
    )
  );
}
