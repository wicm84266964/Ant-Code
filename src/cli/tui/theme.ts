export const THEME_NAMES = ["gold-black", "sky-blue", "ant-code", "terminal-default", "no-color"] as const;

export type ThemeName = typeof THEME_NAMES[number];

export type ThemeColors = Readonly<Record<string, string | undefined>>;

export type Theme = {
  readonly name: string;
  readonly label: string;
  readonly colors: ThemeColors;
};

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

const GOLD_BLACK: Theme = Object.freeze({
  name: "gold-black",
  label: "Gold Black",
  colors: Object.freeze({
    identity: "#e8c547",
    text: "#f5f5f5",
    dim: "#c8c8c8",
    panel: "#161616",
    border: "#c9a227",
    success: "#e8c547",
    warning: "#f6c86f",
    danger: "#ff8585",
    info: "#e8c547",
    accent: "#e8c547",
    selection: "#e8c547",
    cursor: "#e8c547",
    diffAdd: "#e8c547",
    diffRemove: "#ff8585",
    diffContext: "#c8c8c8",
    conversation: "#f5f5f5",
    assistant: "#e8c547",
    user: "#f5f5f5",
    tool: "#c9a227",
    gateway: "#e8c547",
    approval: "#f6c86f",
    command: "#e8c547",
    code: "#d8d8d8",
    file: "#e8c547",
    model: "#e8c547",
    shell: "#c9a227",
    inspector: "#e8c547",
    history: "#f6c86f",
    status: "#e8c547"
  })
});

const SKY_BLUE: Theme = Object.freeze({
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

const ANT_CODE: Theme = Object.freeze({
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

const TERMINAL_DEFAULT: Theme = Object.freeze({
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

const NO_COLOR: Theme = Object.freeze({
  name: "no-color",
  label: "No Color",
  colors: Object.freeze(Object.fromEntries(SEMANTIC_KEYS.map((key: string) => [key, undefined])))
});

const THEMES: Readonly<Record<string, Theme>> = Object.freeze({
  "gold-black": GOLD_BLACK,
  "sky-blue": SKY_BLUE,
  "ant-code": ANT_CODE,
  "terminal-default": TERMINAL_DEFAULT,
  "no-color": NO_COLOR
});

export const DEFAULT_THEME_NAME = "gold-black";
export const DEFAULT_TUI_THEME = THEMES[DEFAULT_THEME_NAME];

export function resolveTheme(name: string, options: Record<string, unknown> = {}): Theme {
  if (options.noColor) {
    return NO_COLOR;
  }
  const requested = String(name ?? DEFAULT_THEME_NAME).trim().toLowerCase();
  return THEMES[requested] ?? DEFAULT_TUI_THEME;
}

export function themeColor(theme: Theme | null | undefined, key: string, fallback?: string) {
  if (theme?.name === "no-color") {
    return undefined;
  }
  return theme?.colors?.[key] ?? fallback;
}

export function themeNames(): ThemeName[] {
  return [...THEME_NAMES];
}
