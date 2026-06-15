export const EXIT_CONFIRM_WINDOW_MS = 2200;
export const INTERRUPT_CONFIRM_WINDOW_MS = 2200;

const POPOVER_PRIORITY = Object.freeze([
  "slash",
  "file",
  "model",
  "command",
  "question",
  "approval"
]);

/**
 * @param {Record<string, any>} state
 */
export function getPopoverStack(state = {}) {
  const stack = [];
  if (state.slashPalette) {
    stack.push({ kind: "slash", label: "slash command palette" });
  }
  if (state.fileMention) {
    stack.push({ kind: "file", label: "file mention palette" });
  }
  if (state.modelPickerOpen) {
    stack.push({ kind: "model", label: "model picker" });
  }
  if (state.commandPanel) {
    stack.push({ kind: "command", label: "command panel" });
  }
  if (state.mode === "question" || state.pendingQuestion) {
    stack.push({ kind: "question", label: "question prompt" });
  }
  if (state.mode === "approval" || state.pendingApproval) {
    stack.push({ kind: "approval", label: "permission modal" });
  }
  return stack.sort((left, right) => POPOVER_PRIORITY.indexOf(left.kind) - POPOVER_PRIORITY.indexOf(right.kind));
}

/**
 * @param {Record<string, any>} state
 */
export function topPopover(state = {}) {
  const stack = getPopoverStack(state);
  return stack[stack.length - 1] ?? null;
}

/**
 * @param {Record<string, any>} state
 */
export function hasOpenPopover(state = {}) {
  return Boolean(topPopover(state));
}

/**
 * @param {{ confirmationUntil?: number; now?: number; windowMs?: number }} options
 */
export function resolveCtrlCExit(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const confirmationUntil = Number.isFinite(options.confirmationUntil) ? options.confirmationUntil : 0;
  if (confirmationUntil >= now) {
    return {
      confirmed: true,
      nextConfirmationUntil: 0,
      message: "已确认退出"
    };
  }
  return {
    confirmed: false,
    nextConfirmationUntil: now + (options.windowMs ?? EXIT_CONFIRM_WINDOW_MS),
    message: "再次按 Ctrl+C 退出"
  };
}

/**
 * @param {{ confirmationUntil?: number; now?: number; windowMs?: number }} options
 */
export function resolveEscInterrupt(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const confirmationUntil = Number.isFinite(options.confirmationUntil) ? options.confirmationUntil : 0;
  if (confirmationUntil >= now) {
    return {
      confirmed: true,
      nextConfirmationUntil: 0,
      message: "已确认中断"
    };
  }
  return {
    confirmed: false,
    nextConfirmationUntil: now + (options.windowMs ?? INTERRUPT_CONFIRM_WINDOW_MS),
    message: "再次按 Esc 中断当前轮次"
  };
}

export function mouseWheelDirection(inputValue) {
  return mouseWheelDirections(inputValue)[0] ?? 0;
}

export function mouseWheelDirections(inputValue) {
  return mouseWheelEvents(inputValue).map((event) => event.direction);
}

export function mouseWheelEvents(inputValue) {
  const value = String(inputValue ?? "");
  const events = [];

  for (const match of value.matchAll(/\u001b?\[<(\d+);(\d+);(\d+)[mM]/g)) {
    const direction = wheelButtonDirection(Number(match[1]));
    if (direction !== 0) {
      events.push({
        direction,
        x: Number(match[2]),
        y: Number(match[3]),
        encoding: "sgr"
      });
    }
  }

  for (const match of value.matchAll(/\u001b\[M([\s\S])([\s\S])([\s\S])/g)) {
    const direction = wheelButtonDirection(match[1].charCodeAt(0) - 32);
    if (direction !== 0) {
      events.push({
        direction,
        x: Math.max(1, match[2].charCodeAt(0) - 32),
        y: Math.max(1, match[3].charCodeAt(0) - 32),
        encoding: "x10"
      });
    }
  }

  for (const match of value.matchAll(/\u001b?\[(\d+);(\d+);(\d+)M/g)) {
    const direction = wheelButtonDirection(Number(match[1]));
    if (direction !== 0) {
      events.push({
        direction,
        x: Number(match[2]),
        y: Number(match[3]),
        encoding: "urxvt"
      });
    }
  }

  return events;
}

export function mouseClickEvents(inputValue) {
  const value = String(inputValue ?? "");
  const events = [];

  for (const match of value.matchAll(/\u001b?\[<(\d+);(\d+);(\d+)([mM])/g)) {
    const code = Number(match[1]);
    const kind = mouseButtonKind(code, match[4]);
    if (kind) {
      events.push({
        kind,
        button: code & 3,
        x: Number(match[2]),
        y: Number(match[3]),
        encoding: "sgr"
      });
    }
  }

  for (const match of value.matchAll(/\u001b\[M([\s\S])([\s\S])([\s\S])/g)) {
    const code = match[1].charCodeAt(0) - 32;
    const kind = mouseButtonKind(code, "M");
    if (kind) {
      events.push({
        kind,
        button: code & 3,
        x: Math.max(1, match[2].charCodeAt(0) - 32),
        y: Math.max(1, match[3].charCodeAt(0) - 32),
        encoding: "x10"
      });
    }
  }

  for (const match of value.matchAll(/\u001b?\[(\d+);(\d+);(\d+)M/g)) {
    const code = Number(match[1]);
    const kind = mouseButtonKind(code, "M");
    if (kind) {
      events.push({
        kind,
        button: code & 3,
        x: Number(match[2]),
        y: Number(match[3]),
        encoding: "urxvt"
      });
    }
  }

  return events;
}

export function rawScrollEvents(inputValue) {
  const value = String(inputValue ?? "");
  const wheelEvents = mouseWheelEvents(value);
  return {
    wheelEvents,
    wheelDirections: wheelEvents.map((event) => event.direction),
    pageDirections: pageScrollDirections(value),
    remainder: trailingIncompleteScrollInput(value)
  };
}

export function hasMouseSequence(inputValue) {
  const value = String(inputValue ?? "");
  return /\u001b?\[<\d+;\d+;\d+[mM]/.test(value)
    || /\u001b?\[\d+;\d+;\d+M/.test(value)
    || /\u001b\[M[\s\S]{3}/.test(value);
}

export function pageScrollDirections(inputValue) {
  const value = String(inputValue ?? "");
  const directions = [];

  for (const match of value.matchAll(/\u001b?\[(5|6)(?:;[\d:]+)?~/g)) {
    directions.push(match[1] === "5" ? 1 : -1);
  }

  return directions;
}

export function rawCtrlCPresses(inputValue) {
  return Array.from(String(inputValue ?? "").matchAll(/\x03/g)).length;
}

export function rawCtrlOPresses(inputValue) {
  return Array.from(String(inputValue ?? "").matchAll(/\x0f/g)).length;
}

export function rawShiftTabPresses(inputValue) {
  const value = String(inputValue ?? "");
  return Array.from(value.matchAll(/\u001b\[Z/g)).length
    + Array.from(value.matchAll(/\u001b\[1;2Z/g)).length
    + Array.from(value.matchAll(/\u001b\[1;2\t/g)).length
    + Array.from(value.matchAll(/\u001b\[9;2u/g)).length
    + Array.from(value.matchAll(/\u001b\[9;2~/g)).length
    + Array.from(value.matchAll(/\u001b\[\t/g)).length;
}

export function rawBackspacePresses(inputValue) {
  const value = String(inputValue ?? "");
  return Array.from(value.matchAll(/[\x08\x7f]/g)).length
    + Array.from(value.matchAll(/\u001b\[(?:8|127)(?:;[\d:]+)?u/g)).length;
}

export function rawDeletePresses(inputValue) {
  return Array.from(String(inputValue ?? "").matchAll(/\u001b\[3(?:;[\d:]+)?~/g)).length;
}

export function shouldUseScrollbackMode(rows, options = {}) {
  if (options.nativeScrollback !== true || options.pinnedSidePanel || options.streamActive) {
    return false;
  }
  return Number(rows) > 0;
}

function wheelButtonDirection(code) {
  if (code >= 64) {
    const button = code & 3;
    if (button === 0) {
      return 1;
    }
    if (button === 1) {
      return -1;
    }
    return 0;
  }
  const base = code & ~28;
  if (base === 64) {
    return 1;
  }
  if (base === 65) {
    return -1;
  }
  return 0;
}

function mouseButtonKind(code, finalByte) {
  if (!Number.isFinite(code)) {
    return null;
  }
  if (code >= 64) {
    return null;
  }
  if ((code & 32) !== 0) {
    return null;
  }
  const button = code & 3;
  if (button !== 0) {
    return null;
  }
  return finalByte === "m" ? "release" : "press";
}

function trailingIncompleteScrollInput(value) {
  const text = String(value ?? "");
  const maxTailLength = 48;
  for (let index = Math.max(0, text.length - maxTailLength); index < text.length; index += 1) {
    const tail = text.slice(index);
    if (isIncompleteScrollSequence(tail)) {
      return tail;
    }
  }
  return "";
}

function isIncompleteScrollSequence(value) {
  if (!value) {
    return false;
  }
  if (value === "\u001b" || value === "\u001b[" || value === "[") {
    return true;
  }
  if (/^\u001b?\[<\d*(?:;\d*){0,2}$/.test(value)) {
    return true;
  }
  if (/^\u001b?\[\d*(?:;\d*){0,2}$/.test(value) && !/^\u001b?\[\d+;\d+;\d+M$/.test(value)) {
    return true;
  }
  if (/^\u001b?\[M[\s\S]{0,2}$/.test(value) && value.length < (value.startsWith("\u001b") ? 6 : 5)) {
    return true;
  }
  if (/^\u001b?\[(5|6)(?:;[\d:]+)?$/.test(value)) {
    return true;
  }
  return false;
}
