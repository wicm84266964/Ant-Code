import os from "node:os";
import path from "node:path";

/** @param {NodeJS.ProcessEnv} [env] */
export function globalLegacyConfigPath(env = process.env) {
  const explicit = String(env.LAB_AGENT_CONFIG ?? "").trim();
  if (explicit) return path.resolve(explicit);
  if (env.LAB_AGENT_HOME) {
    return path.join(path.resolve(env.LAB_AGENT_HOME), "lab-agent.config.json");
  }
  const userHome = env.USERPROFILE || env.HOME || os.homedir();
  return path.join(userHome, ".ant-code", "lab-agent.config.json");
}

/** @param {string} cwd */
export function projectLegacyConfigPath(cwd) {
  return path.join(path.resolve(cwd), ".lab-agent", "config.json");
}

/** @param {NodeJS.ProcessEnv} [env] */
export function globalSettingsPath(env = process.env) {
  return path.join(path.dirname(globalLegacyConfigPath(env)), "settings.json");
}

/** @param {string} cwd */
export function projectSettingsPath(cwd) {
  return path.join(path.resolve(cwd), ".lab-agent", "settings.json");
}

/** @param {NodeJS.ProcessEnv} [env] */
export function credentialsPath(env = process.env) {
  return path.join(path.dirname(globalSettingsPath(env)), "credentials.json");
}

/** @param {NodeJS.ProcessEnv} [env] */
export function globalMigrationMarkerPath(env = process.env) {
  return path.join(path.dirname(globalSettingsPath(env)), "settings.migration.json");
}

/** @param {string} cwd */
export function projectMigrationMarkerPath(cwd) {
  return path.join(path.dirname(projectSettingsPath(cwd)), "settings.migration.json");
}
