export type OfficialModelSource = {
  id: string;
  label: string;
  protocol: "openai-chat";
  gatewayUrl: string;
  envKey: string;
  models: Array<{ id: string; displayName: string }>;
};

export const OFFICIAL_MODEL_SOURCES: readonly OfficialModelSource[] = Object.freeze([
  {
    id: "deepseek-official",
    label: "DeepSeek 官方",
    protocol: "openai-chat",
    gatewayUrl: "https://api.deepseek.com/chat/completions",
    envKey: "DEEPSEEK_API_KEY",
    models: [
      { id: "deepseek-v4-flash", displayName: "DeepSeek V4 Flash" },
      { id: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro" }
    ]
  }
]);

export function officialModelSource(id: string) {
  return OFFICIAL_MODEL_SOURCES.find((source) => source.id === id) ?? null;
}

export function officialSourceStatus(env: NodeJS.ProcessEnv = process.env) {
  return OFFICIAL_MODEL_SOURCES.map((source) => ({
    id: source.id,
    label: source.label,
    protocol: source.protocol,
    gatewayUrl: source.gatewayUrl,
    envKey: source.envKey,
    keyConfigured: Boolean(String(env[source.envKey] ?? "").trim()),
    models: source.models
  }));
}

export function officialSourceApiKey(id: string, env: NodeJS.ProcessEnv = process.env) {
  const source = officialModelSource(id);
  if (!source) return "";
  return String(env[source.envKey] ?? "").trim();
}
