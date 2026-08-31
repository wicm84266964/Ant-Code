export type TranscriptSelectionRange = {
  startIndex: number;
  endIndex: number;
};

export type TranscriptPointer = {
  x?: number;
  y?: number;
};

export type TranscriptSelectableLine = {
  text?: string;
  wrapContinue?: boolean;
};

export function normalizeTranscriptSelection(startIndex: number, endIndex: number): TranscriptSelectionRange {
  return {
    startIndex: Math.min(startIndex, endIndex),
    endIndex: Math.max(startIndex, endIndex)
  };
}

export function isMeaningfulTranscriptDrag(
  start: TranscriptPointer,
  end: TranscriptPointer,
  startIndex: number,
  endIndex: number
) {
  if (startIndex !== endIndex) {
    return true;
  }
  return Math.abs(Number(end.x) - Number(start.x)) >= 3
    || Math.abs(Number(end.y) - Number(start.y)) >= 1;
}

export function transcriptChromeRows(historyWarning = false) {
  return 2 + (historyWarning ? 1 : 0);
}

export function transcriptLineIndexForMouseY(
  y: number,
  transcriptTop: number,
  lineCount: number,
  options: { historyWarning?: boolean; clamp?: boolean } = {}
) {
  if (!Number.isFinite(y) || !Number.isFinite(transcriptTop) || lineCount <= 0) {
    return null;
  }
  let lineIndex = Number(y) - Number(transcriptTop) - transcriptChromeRows(Boolean(options.historyWarning));
  if (options.clamp) {
    lineIndex = Math.max(0, Math.min(lineCount - 1, lineIndex));
  }
  if (lineIndex < 0 || lineIndex >= lineCount) {
    return null;
  }
  return lineIndex;
}

export function formatVisibleTranscriptSelection(
  lines: TranscriptSelectableLine[] = [],
  startIndex: number,
  endIndex: number
) {
  if (!Array.isArray(lines) || lines.length === 0) {
    return "";
  }
  const range = normalizeTranscriptSelection(startIndex, endIndex);
  const start = Math.max(0, range.startIndex);
  const end = Math.min(lines.length - 1, range.endIndex);
  if (start > end) {
    return "";
  }
  let text = "";
  for (let index = start; index <= end; index += 1) {
    const line = lines[index];
    const piece = String(line?.text ?? "");
    if (index > start && line?.wrapContinue) {
      text += piece;
    } else {
      if (text.length > 0) {
        text += "\n";
      }
      text += piece;
    }
  }
  return text.replace(/\s+$/g, "");
}
