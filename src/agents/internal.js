import { getAgentProfile } from "./profiles.js";

/**
 * Build a gateway request for hidden internal agents such as compaction, title,
 * and summary. These agents never receive tools; they only transform bounded
 * text already selected by the caller.
 *
 * @param {{ profileName: string; config?: Record<string, any>; cwd?: string; task: string; input: string; rules?: string[] }} options
 */
export function createInternalAgentRequest(options) {
  const profile = getAgentProfile(options.profileName, options.config, {
    cwd: options.cwd,
    includeHidden: true
  });
  if (!profile?.hidden) {
    return {
      ok: false,
      error: {
        code: "INTERNAL_AGENT_NOT_FOUND",
        message: `Hidden internal agent is not configured: ${options.profileName}`
      }
    };
  }

  const rules = Array.isArray(options.rules) ? options.rules : [];
  return {
    ok: true,
    profile,
    request: {
      messages: [
        {
          role: "system",
          content: [{
            type: "text",
            text: [
              `You are Ant Code internal agent '${profile.name}'.`,
              `Mode: ${profile.mode}.`,
              "",
              profile.system,
              "",
              "Internal agent boundary:",
              profile.name === "compaction" ? "Internal role: context compactor." : null,
              "- Do not call tools.",
              "- Do not reveal secrets, API keys, credentials, Bearer tokens, or password/token values.",
              "- Preserve concrete file names, command names, model ids, config keys, and user decisions when they matter.",
              "- Return only the requested output text.",
              ...rules.map((rule) => `- ${rule}`)
            ].filter(Boolean).join("\n")
          }]
        },
        {
          role: "user",
          content: [
            `Task: ${options.task}`,
            "",
            "Input:",
            truncateInternalInput(options.input)
          ].join("\n")
        }
      ],
      tools: [],
      toolResults: []
    }
  };
}

/**
 * @param {unknown} value
 * @param {number | null} max
 */
export function truncateInternalInput(value, max = null) {
  const text = String(value ?? "");
  if (!Number.isInteger(max) || max <= 0) {
    return text;
  }
  return text.length <= max ? text : `${text.slice(0, max)}\n...[internal input truncated]`;
}
