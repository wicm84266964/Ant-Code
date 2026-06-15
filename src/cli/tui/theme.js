export const THEME_NAMES = ["sky-blue", "ant-code", "terminal-default", "no-color"];

const SEMANTIC_KEYS = [
  "identity",
  "text",
  "dim",
  "panel",
  "border",
  "success",
  "warning",
  "danger",
  "info",
  "accent",
  "selection",
  "cursor",
  "diffAdd",
  "diffRemove",
  "diffContext",
  "conversation",
  "assistant",
  "user",
  "tool",
  "gateway",
  "approval",
  "command",
  "code",
  "file",
  "model",
  "shell",
  "inspector",
  "history",
  "status"
];

const SKY_BLUE = Object.freeze({
  name: "sky-blue",
  label: "Sky Blue",
  colors: Object.freeze({
    identity: "#38bdf8",
    text: "white",
    dim: "gray",
    panel: "#0f172a",
    border: "#0ea5e9",
    success: "#22c55e",
    warning: "#facc15",
    danger: "#ef4444",
    info: "#67e8f9",
    accent: "#7dd3fc",
    selection: "#7dd3fc",
    cursor: "#38bdf8",
    diffAdd: "#22c55e",
    diffRemove: "#ef4444",
    diffContext: "gray",
    conversation: "white",
    assistant: "#22c55e",
    user: "#7dd3fc",
    tool: "#67e8f9",
    gateway: "#a78bfa",
    approval: "#facc15",
    command: "#67e8f9",
    code: "#cbd5e1",
    file: "#facc15",
    model: "#22c55e",
    shell: "#d946ef",
    inspector: "#d946ef",
    history: "#facc15",
    status: "#22c55e"
  })
});

const ANT_CODE = Object.freeze({
  name: "ant-code",
  label: "Ant Code",
  colors: Object.freeze({
    ...SKY_BLUE.colors,
    identity: "cyan",
    border: "gray",
    accent: "cyan",
    selection: "cyan",
    cursor: "cyan"
  })
});

const TERMINAL_DEFAULT = Object.freeze({
  name: "terminal-default",
  label: "Terminal Default",
  colors: Object.freeze({
    ...SKY_BLUE.colors,
    identity: "cyan",
    text: undefined,
    panel: undefined,
    border: "gray",
    accent: "cyan",
    selection: "cyan",
    cursor: "cyan"
  })
});

const NO_COLOR = Object.freeze({
  name: "no-color",
  label: "No Color",
  colors: Object.freeze(Object.fromEntries(SEMANTIC_KEYS.map((key) => [key, undefined])))
});

const THEMES = Object.freeze({
  "sky-blue": SKY_BLUE,
  "ant-code": ANT_CODE,
  "terminal-default": TERMINAL_DEFAULT,
  "no-color": NO_COLOR
});

export const DEFAULT_THEME_NAME = "sky-blue";
export const DEFAULT_TUI_THEME = THEMES[DEFAULT_THEME_NAME];

export function resolveTheme(name, options = {}) {
  if (options.noColor) {
    return NO_COLOR;
  }
  const requested = String(name ?? DEFAULT_THEME_NAME).trim().toLowerCase();
  return THEMES[requested] ?? DEFAULT_TUI_THEME;
}

export function themeColor(theme, key, fallback = undefined) {
  if (theme?.name === "no-color") {
    return undefined;
  }
  return theme?.colors?.[key] ?? fallback;
}

export function themeNames() {
  return [...THEME_NAMES];
}
