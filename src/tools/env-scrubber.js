const SECRET_ENV_PATTERNS = Object.freeze([
  /(^|_)API_KEY$/i,
  /(^|_)TOKEN$/i,
  /(^|_)SECRET$/i,
  /(^|_)PASSWORD$/i,
  /^AWS_/i,
  /^GITHUB_TOKEN$/i,
  /^SSH_AUTH_SOCK$/i,
  /^ANTHROPIC_API_KEY$/i,
  /^OPENAI_API_KEY$/i,
  /OAUTH/i
]);

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {{ allow?: string[]; allowSensitive?: boolean }} [options]
 */
export function scrubEnvironment(env = process.env, options = {}) {
  const scrubbed = {};
  const removed = [];
  const allow = new Set((options.allow ?? []).map((item) => String(item).toUpperCase()));
  const allowSensitive = options.allowSensitive === true;

  for (const [key, value] of Object.entries(env)) {
    if (!allowSensitive && !allow.has(key.toUpperCase()) && SECRET_ENV_PATTERNS.some((pattern) => pattern.test(key))) {
      removed.push(key);
      continue;
    }
    if (value !== undefined) {
      scrubbed[key] = value;
    }
  }

  return { env: scrubbed, removed };
}
