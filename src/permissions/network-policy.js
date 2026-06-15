const LOOPBACK_HOSTS = Object.freeze(["localhost", "127.0.0.1", "::1"]);

/**
 * @param {{ url: string; networkMode: string; allowedHosts?: string[] }} request
 */
export function decideNetworkAccess(request) {
  const host = parseHost(request.url);
  if (!host) {
    return { decision: "deny", reason: "network target is not a valid URL" };
  }

  if (LOOPBACK_HOSTS.includes(host)) {
    return { decision: "allow", reason: "loopback host is allowed" };
  }

  const allowedHosts = new Set(request.allowedHosts ?? []);
  const explicitlyAllowed = allowedHosts.has(host);

  if (request.networkMode === "offline") {
    return { decision: "deny", reason: "offline mode denies non-loopback network access" };
  }

  if (request.networkMode === "lab-only") {
    return explicitlyAllowed
      ? { decision: "allow", reason: "host is listed in lab-only allowlist" }
      : { decision: "deny", reason: "lab-only mode denies unapproved host" };
  }

  if (request.networkMode === "approved-web") {
    return explicitlyAllowed
      ? { decision: "allow", reason: "host is explicitly approved" }
      : { decision: "ask", reason: "host is not in approved-web allowlist" };
  }

  if (request.networkMode === "open-dev") {
    return { decision: "ask", reason: "open-dev network access still requires visible approval" };
  }

  return { decision: "deny", reason: `unknown network mode: ${request.networkMode}` };
}

/**
 * @param {string} value
 */
function parseHost(value) {
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}
