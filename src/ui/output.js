import { listAgentProfiles } from "../agents/profiles.js";
import { listSlashCommandGroups } from "../commands/registry.js";

export function helpText() {
  return [
    "Ant Code clean-room MVP",
    "",
    "Usage:",
    "  ant-code                    # 启动默认 TUI",
    "  ant-code --version",
    "  ant-code doctor",
    "  ant-code gateway [--live]",
    "  ant-code tui                # 显式启动 TUI",
    "  ant-code dashboard          # 启动本机 WebUI Dashboard",
    "  ant-code dashboard --port 7410 --no-open",
    "  ant-code chat               # 启动行式交互模式",
    "  ant-code --resume latest",
    "  ant-code -p \"question\"",
    "  ant-code --readonly -p \"question\"",
    "  ant-code --auto-approve -p \"long workspace task\"",
    "  ant-code --full-access -p \"trusted test-machine task\"",
    "  ant-code --allow-write -p \"approved edit request\"",
    "  ant-code --allow-command -p \"approved shell request\"",
    "  ant-code -p \"question\" --output-format=json",
    "  ant-code -p \"question\" --output-format=stream-json --include-partial-messages",
    "",
    "Commands:",
    ...formatCommandGroups(),
    "",
    "Agent profiles:",
    ...listAgentProfiles().map((profile) => `  ${profile.name} - ${profile.description}`)
  ].join("\n");
}

function formatCommandGroups() {
  const lines = [];
  for (const group of listSlashCommandGroups()) {
    lines.push(`  ${group.category}`);
    lines.push(...group.commands.map((command) => `    /${command.name} - ${command.description}`));
  }
  return lines;
}

/**
 * @param {Record<string, any>} session
 */
export function statusText(session) {
  return [
    "Ant Code session",
    `id: ${session.id}`,
    `cwd: ${session.cwd}`,
    `mode: ${session.mode}`,
    `permission: ${session.permissionMode ?? (session.fullAccess ? "fullAccess" : session.allowWrite || session.allowCommand ? "workspace" : "plan")}`,
    `readonly: ${session.readonly}`,
    `full access: ${session.fullAccess}`,
    `model: ${session.model}`,
    `network: ${session.networkMode}`
  ].join("\n");
}
