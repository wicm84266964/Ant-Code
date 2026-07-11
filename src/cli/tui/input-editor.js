const GRAPHEME_SEGMENTER = typeof Intl?.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : null;
const GRAPHEME_CACHE_LIMIT = 4;
const graphemeCache = new Map();
const GRAPHEME_WIDTH_CACHE_LIMIT = 512;
const graphemeWidthCache = new Map();

export function createDraft(text = "", cursor = null) {
  const chars = toChars(text);
  const resolvedCursor = cursor === null ? chars.length : clampCursor(cursor, chars.length);
  return { text: chars.join(""), cursor: resolvedCursor };
}

export function insertText(draft, value) {
  const chars = toChars(draft?.text);
  const insert = toChars(value);
  const cursor = clampCursor(draft?.cursor, chars.length);
  chars.splice(cursor, 0, ...insert);
  return editedDraft(draft, chars.join(""), cursor + insert.length, chars);
}

export function deleteBackward(draft) {
  const chars = toChars(draft?.text);
  const cursor = clampCursor(draft?.cursor, chars.length);
  if (cursor === 0) {
    return editedDraft(draft, chars.join(""), cursor, chars);
  }
  chars.splice(cursor - 1, 1);
  return editedDraft(draft, chars.join(""), cursor - 1, chars);
}

export function deleteForward(draft) {
  const chars = toChars(draft?.text);
  const cursor = clampCursor(draft?.cursor, chars.length);
  if (cursor >= chars.length) {
    return editedDraft(draft, chars.join(""), cursor, chars);
  }
  chars.splice(cursor, 1);
  return editedDraft(draft, chars.join(""), cursor, chars);
}

export function deleteToStart(draft) {
  const chars = toChars(draft?.text);
  const cursor = clampCursor(draft?.cursor, chars.length);
  const nextChars = chars.slice(cursor);
  return editedDraft(draft, nextChars.join(""), 0, nextChars);
}

export function deleteToEnd(draft) {
  const chars = toChars(draft?.text);
  const cursor = clampCursor(draft?.cursor, chars.length);
  const nextChars = chars.slice(0, cursor);
  return editedDraft(draft, nextChars.join(""), cursor, nextChars);
}

export function deleteWordBackward(draft) {
  const chars = toChars(draft?.text);
  const cursor = clampCursor(draft?.cursor, chars.length);
  const start = previousWordBoundary(chars, cursor);
  chars.splice(start, cursor - start);
  return editedDraft(draft, chars.join(""), start, chars);
}

export function deleteWordForward(draft) {
  const chars = toChars(draft?.text);
  const cursor = clampCursor(draft?.cursor, chars.length);
  const end = nextWordBoundary(chars, cursor);
  chars.splice(cursor, end - cursor);
  return editedDraft(draft, chars.join(""), cursor, chars);
}

export function moveCursor(draft, direction) {
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

export function moveCursorLineBoundary(draft, direction, options = {}) {
  const chars = toChars(draft?.text);
  const text = chars.join("");
  const cursor = clampCursor(draft?.cursor, chars.length);
  const lines = wrapDraftLines(splitDraftLines(text), options.columns);
  const lineIndex = lines.findIndex((line, index) => lineContainsCursor(lines, index, cursor));
  const line = lines[lineIndex === -1 ? lines.length - 1 : lineIndex];
  const nextCursor = direction === "end" ? line?.end ?? chars.length : line?.start ?? 0;
  return movedDraft(draft, text, nextCursor, chars);
}

export function moveCursorVertical(draft, direction, options = {}) {
  const chars = toChars(draft?.text);
  const text = chars.join("");
  const cursor = clampCursor(draft?.cursor, chars.length);
  const lines = wrapDraftLines(splitDraftLines(text), options.columns);
  if (lines.length <= 1) {
    return { text, cursor };
  }
  const currentIndex = lines.findIndex((line, index) => lineContainsCursor(lines, index, cursor));
  const resolvedIndex = currentIndex === -1 ? lines.length - 1 : currentIndex;
  const delta = direction === "up" || direction === -1 ? -1 : 1;
  const targetIndex = resolvedIndex + delta;
  if (targetIndex < 0 || targetIndex >= lines.length) {
    return { text, cursor };
  }
  const currentLine = lines[resolvedIndex];
  const targetLine = lines[targetIndex];
  const preferredColumn = Number.isFinite(draft?.preferredColumn)
    ? Number(draft.preferredColumn)
    : displayWidth(chars.slice(currentLine.start, cursor).join(""));
  return {
    ...movedDraft(draft, text, cursorAtVisualColumn(chars, targetLine, preferredColumn), chars),
    preferredColumn
  };
}

export function cursorVisualPosition(text, cursor, options = {}) {
  const chars = toChars(text);
  const resolvedCursor = clampCursor(cursor, chars.length);
  const lines = wrapDraftLines(splitDraftLines(chars.join("")), options.columns);
  const maxLines = Math.max(1, Number(options.maxLines) || 5);
  if (lines.length === 0 || (lines.length === 1 && lines[0].text === "")) {
    return { lineIndex: 0, column: 0, totalLines: 1, visibleStart: 0 };
  }
  const cursorLineIndex = lines.findIndex((line, index) => lineContainsCursor(lines, index, resolvedCursor));
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

export function cursorToEnd(text) {
  return toChars(text).length;
}

export function clampDraftCursor(draft) {
  const chars = toChars(draft?.text);
  return withDraftMetadata(draft, { text: chars.join(""), cursor: clampCursor(draft?.cursor, chars.length) }, true);
}

export function stabilizeDraftViewport(draft, options = {}) {
  const next = clampDraftCursor(draft);
  const position = cursorVisualPosition(next.text, next.cursor, {
    columns: options.columns,
    maxLines: options.maxLines,
    visibleStart: next.visibleStart
  });
  return { ...next, visibleStart: position.visibleStart };
}

export function splitDraftLines(text) {
  const chars = toChars(text);
  const lines = [];
  let start = 0;
  let current = [];
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

export function visibleDraftLineEntries(text, cursor, maxLines = 5, columns = null, visibleStart = null) {
  const lines = wrapDraftLines(splitDraftLines(text), columns);
  if (lines.length === 1 && lines[0].text === "") {
    return [];
  }
  const cursorLine = lines.findIndex((line, index) => lineContainsCursor(lines, index, cursor));
  const resolvedLine = cursorLine === -1 ? lines.length - 1 : cursorLine;
  const start = stableVisibleStart(lines.length, resolvedLine, maxLines, visibleStart);
  return lines.slice(start, start + maxLines);
}

export function composerSegments(text, cursor, options = {}) {
  const chars = toChars(text);
  const resolvedCursor = clampCursor(cursor, chars.length);
  const lineEntries = visibleDraftLineEntries(text, resolvedCursor, options.maxLines ?? 5, options.columns, options.visibleStart);
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
    const segments = [
      before ? { text: before } : null,
      { text: cursorChar, cursor: true, hidden: !showCursor },
      after ? { text: after } : null
    ].filter(Boolean);
    return {
      text: `${before}${cursorChar}${after}`,
      segments
    };
  });
}

export function displayWidth(value) {
  return toChars(value).reduce((sum, char) => sum + graphemeWidth(char, sum), 0);
}

export function cursorColumn(text, cursor) {
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

function toChars(value) {
  const text = String(value ?? "");
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

function rememberGraphemes(text, chars) {
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

function clampCursor(value, length) {
  return Math.min(Math.max(0, Number.isFinite(value) ? Number(value) : length), length);
}

function wrapDraftLines(lines, columns) {
  const maxColumns = Number.isFinite(columns) && Number(columns) > 0
    ? Math.max(1, Math.floor(Number(columns)))
    : null;
  if (!maxColumns) {
    return lines;
  }
  const wrapped = [];
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

function lineSlice(line, chars, startOffset, endOffset) {
  return {
    text: chars.slice(startOffset, endOffset).join(""),
    start: line.start + startOffset,
    end: line.start + endOffset
  };
}

function lineContainsCursor(lines, index, cursor) {
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

function cursorAtVisualColumn(chars, line, column) {
  const targetColumn = Math.max(0, Number.isFinite(column) ? Number(column) : 0);
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

function previousWordBoundary(chars, cursor) {
  let index = Math.max(0, cursor);
  while (index > 0 && isWhitespace(chars[index - 1])) {
    index -= 1;
  }
  while (index > 0 && !isWhitespace(chars[index - 1])) {
    index -= 1;
  }
  return index;
}

function nextWordBoundary(chars, cursor) {
  let index = Math.min(chars.length, Math.max(0, cursor));
  while (index < chars.length && !isWhitespace(chars[index])) {
    index += 1;
  }
  while (index < chars.length && isWhitespace(chars[index])) {
    index += 1;
  }
  return index;
}

function isWhitespace(char) {
  return /\s/u.test(char ?? "");
}

function graphemeWidth(grapheme, column = 0) {
  if (!grapheme) {
    return 0;
  }
  if (grapheme === "\n" || grapheme === "\r") {
    return 0;
  }
  if (grapheme === "\t") {
    return 4 - (Math.max(0, Number(column) || 0) % 4);
  }
  const cached = graphemeWidthCache.get(grapheme);
  if (cached !== undefined) {
    return cached;
  }
  let width;
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

function rememberGraphemeWidth(grapheme, width) {
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

function codePointWidth(char) {
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

function isRegionalIndicatorPair(value) {
  const chars = Array.from(value);
  return chars.length === 2 && chars.every((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code >= 0x1f1e6 && code <= 0x1f1ff;
  });
}

function stableVisibleStart(lineCount, cursorLine, maxLines, requestedStart) {
  const maximum = Math.max(0, lineCount - maxLines);
  let start = Number.isFinite(requestedStart)
    ? Math.min(maximum, Math.max(0, Math.floor(Number(requestedStart))))
    : Math.min(maximum, Math.max(0, cursorLine - maxLines + 1));
  if (cursorLine < start) {
    start = cursorLine;
  } else if (cursorLine >= start + maxLines) {
    start = cursorLine - maxLines + 1;
  }
  return Math.min(maximum, Math.max(0, start));
}

function editedDraft(draft, text, cursor, chars = null) {
  if (chars) {
    rememberGraphemes(text, chars);
  }
  return withDraftMetadata(draft, { text, cursor }, false);
}

function movedDraft(draft, text, cursor, chars = null) {
  if (chars) {
    rememberGraphemes(text, chars);
  }
  return withDraftMetadata(draft, { text, cursor }, false);
}

function withDraftMetadata(draft, next, preservePreferredColumn) {
  const result = { ...next };
  if (Number.isFinite(draft?.visibleStart)) {
    result.visibleStart = Math.max(0, Math.floor(Number(draft.visibleStart)));
  }
  if (preservePreferredColumn && Number.isFinite(draft?.preferredColumn)) {
    result.preferredColumn = Math.max(0, Number(draft.preferredColumn));
  }
  return result;
}

function isWideCodePoint(code) {
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
