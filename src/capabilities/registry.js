import { listAgentProfiles } from "../agents/profiles.js";
import { loadSkills } from "../skills/registry.js";
import { BUILT_IN_TOOLS } from "../tools/definitions.js";
import { RECOMMENDED_MCP_SERVERS } from "../mcp/recommended.js";

/**
 * @param {{ cwd: string; config: Record<string, any>; env?: NodeJS.ProcessEnv }} options
 */
export async function listCapabilities(options) {
  const skills = await loadSkills(options);
  const configuredMcp = options.config.mcp?.servers ?? [];
  const configuredNames = new Set(configuredMcp.map((server) => String(server.name ?? "").toLowerCase()));
  const recommendedOnly = RECOMMENDED_MCP_SERVERS
    .filter((server) => !configuredNames.has(server.name.toLowerCase()))
    .map((server) => ({
      ...server,
      configured: false
    }));

  return {
    builtInTools: BUILT_IN_TOOLS.map((tool) => ({
      name: tool.name,
      risk: tool.risk,
      description: tool.description,
      enabled: true
    })),
    mcpServers: [
      ...configuredMcp.map((server) => ({
        name: server.name,
        description: server.description ?? "",
        enabled: server.enabled !== false && server.disabled !== true,
        transport: server.transport ?? "stdio",
        command: server.command ?? "",
        args: Array.isArray(server.args) ? server.args : [],
        recommended: server.recommended === true || RECOMMENDED_MCP_SERVERS.some((item) => item.name === server.name),
        configured: true,
        category: server.category ?? RECOMMENDED_MCP_SERVERS.find((item) => item.name === server.name)?.category ?? "custom"
      })),
      ...recommendedOnly
    ],
    skills: skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      whenToUse: skill.whenToUse,
      enabled: !skill.disabled,
      allowedTools: skill.allowedTools,
      source: skill.source
    })),
    agents: listAgentProfiles(options.config, { cwd: options.cwd, includeHidden: false }).map((profile) => ({
      name: profile.name,
      mode: profile.mode,
      aliases: profile.aliases ?? [],
      tools: profile.tools ?? [],
      description: profile.description,
      source: profile.source
    }))
  };
}

/**
 * @param {Awaited<ReturnType<typeof listCapabilities>>} capabilities
 */
export function formatCapabilities(capabilities) {
  const lines = [
    "Ant Code 能力清单",
    "",
    "内置工具",
    ...capabilities.builtInTools.map((tool) => `- ${tool.name} [${tool.risk}] - ${tool.description}`),
    "",
    "MCP",
    ...formatMcp(capabilities.mcpServers),
    "",
    "Skills",
    ...formatSkills(capabilities.skills),
    "",
    "子智能体",
    ...capabilities.agents.map((agent) => {
      const aliases = agent.aliases.length ? ` aliases=${agent.aliases.join(",")}` : "";
      return `- ${agent.name} [${agent.mode}]${aliases} - ${agent.description}`;
    }),
    "",
    "提示",
    "- /mcp doctor 检查 MCP 可用性。",
    "- /skills doctor 检查本地 skill pack。",
    "- 网络、浏览器、MCP、写文件和命令执行仍受权限策略控制。"
  ];
  return lines.join("\n");
}

function formatMcp(servers) {
  if (servers.length === 0) {
    return ["- 未配置 MCP；内置工具仍可用。"];
  }
  return servers.map((server) => {
    const state = server.enabled ? "enabled" : "disabled";
    const configured = server.configured ? "configured" : "recommended";
    const command = server.command ? ` command=${server.command}` : "";
    return `- ${server.name} [${state}, ${configured}, ${server.category}] - ${server.description}${command}`;
  });
}

function formatSkills(skills) {
  if (skills.length === 0) {
    return ["- 未发现本地 skills；请检查 config/skills 或项目 .lab-agent/skills。"];
  }
  return skills.map((skill) => {
    const state = skill.enabled ? "enabled" : "disabled";
    const tools = skill.allowedTools.length ? ` tools=${skill.allowedTools.join(",")}` : "";
    return `- ${skill.name} [${state}] - ${skill.description}${tools}`;
  });
}
