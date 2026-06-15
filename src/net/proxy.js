import { execFileSync } from "node:child_process";

const LOOPBACK_NO_PROXY = "localhost,127.0.0.1,::1";
const WINDOWS_PROXY_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

let cachedWindowsProxy = undefined;

/**
 * @param {string} targetUrl
 * @param {{ env?: NodeJS.ProcessEnv; config?: Record<string, any> }} [options]
 */
export function resolveProxyForUrl(targetUrl, options = {}) {
  let target;
  try {
    target = new URL(targetUrl);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(target.protocol)) {
    return null;
  }

  const env = options.env ?? process.env;
  if (LOOPBACK_HOSTS.has(target.hostname)) {
    return null;
  }
  if (matchesNoProxy(target.hostname, env.NO_PROXY ?? env.no_proxy)) {
    return null;
  }

  const configProxy = normalizeProxyUrl(options.config?.web?.proxyUrl ?? options.config?.proxyUrl);
  if (configProxy) {
    return configProxy;
  }

  const envProxy = proxyFromEnv(target.protocol, env);
  if (envProxy) {
    return envProxy;
  }

  const systemProxy = getWindowsSystemProxy();
  return selectProxyForProtocol(target.protocol, systemProxy);
}

/**
 * Add proxy environment variables for child tools that understand HTTP_PROXY /
 * HTTPS_PROXY. Existing env values win, so explicit process settings remain
 * more important than Windows system proxy discovery.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {{ config?: Record<string, any> }} [options]
 */
export function withProxyEnvironment(env = process.env, options = {}) {
  const next = { ...env };
  const httpProxy = resolveProxyForUrl("http://example.invalid/", { env: next, config: options.config });
  const httpsProxy = resolveProxyForUrl("https://example.invalid/", { env: next, config: options.config });

  if (httpProxy && !next.HTTP_PROXY && !next.http_proxy) {
    next.HTTP_PROXY = httpProxy;
    next.http_proxy = httpProxy;
  }
  if (httpsProxy && !next.HTTPS_PROXY && !next.https_proxy) {
    next.HTTPS_PROXY = httpsProxy;
    next.https_proxy = httpsProxy;
  }
  if (!next.NO_PROXY && !next.no_proxy) {
    next.NO_PROXY = LOOPBACK_NO_PROXY;
    next.no_proxy = LOOPBACK_NO_PROXY;
  }
  return next;
}

/**
 * @param {string} protocol
 * @param {NodeJS.ProcessEnv} env
 */
function proxyFromEnv(protocol, env) {
  const value = protocol === "https:"
    ? env.HTTPS_PROXY ?? env.https_proxy ?? env.ALL_PROXY ?? env.all_proxy
    : env.HTTP_PROXY ?? env.http_proxy ?? env.ALL_PROXY ?? env.all_proxy;
  return normalizeProxyUrl(value);
}

/**
 * @param {string} protocol
 * @param {{ http?: string | null; https?: string | null } | null} proxy
 */
function selectProxyForProtocol(protocol, proxy) {
  if (!proxy) {
    return null;
  }
  return normalizeProxyUrl(protocol === "https:" ? proxy.https ?? proxy.http : proxy.http ?? proxy.https);
}

function getWindowsSystemProxy() {
  if (process.platform !== "win32") {
    return null;
  }
  if (cachedWindowsProxy !== undefined) {
    return cachedWindowsProxy;
  }

  try {
    const output = execFileSync("reg", ["query", WINDOWS_PROXY_KEY], {
      encoding: "utf8",
      timeout: 1500,
      windowsHide: true
    });
    const enableMatch = output.match(/ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/i);
    const enabled = enableMatch ? Number.parseInt(enableMatch[1], 16) === 1 : false;
    if (!enabled) {
      cachedWindowsProxy = null;
      return cachedWindowsProxy;
    }
    const serverMatch = output.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i);
    cachedWindowsProxy = parseWindowsProxyServer(serverMatch?.[1]?.trim() ?? "");
    return cachedWindowsProxy;
  } catch {
    cachedWindowsProxy = null;
    return cachedWindowsProxy;
  }
}

/**
 * @param {string} value
 */
function parseWindowsProxyServer(value) {
  if (!value) {
    return null;
  }
  if (!value.includes("=")) {
    const proxy = normalizeProxyUrl(value);
    return proxy ? { http: proxy, https: proxy } : null;
  }

  const entries = new Map();
  for (const part of value.split(";")) {
    const [rawKey, ...rest] = part.split("=");
    const key = rawKey.trim().toLowerCase();
    const item = rest.join("=").trim();
    if (key && item) {
      entries.set(key, normalizeProxyUrl(item));
    }
  }
  return {
    http: entries.get("http") ?? entries.get("https") ?? entries.get("socks") ?? null,
    https: entries.get("https") ?? entries.get("http") ?? entries.get("socks") ?? null
  };
}

/**
 * @param {unknown} value
 */
function normalizeProxyUrl(value) {
  const text = String(value ?? "").trim();
  if (!text) {
    return null;
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
  try {
    const url = new URL(withScheme);
    if (!["http:", "https:"].includes(url.protocol)) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

/**
 * @param {string} hostname
 * @param {unknown} value
 */
function matchesNoProxy(hostname, value) {
  const text = String(value ?? "").trim();
  if (!text) {
    return false;
  }
  const host = hostname.toLowerCase();
  return text.split(",").map((item) => item.trim().toLowerCase()).some((pattern) => {
    if (!pattern) {
      return false;
    }
    if (pattern === "*") {
      return true;
    }
    if (pattern === "<local>") {
      return !host.includes(".");
    }
    if (pattern.startsWith(".")) {
      return host.endsWith(pattern);
    }
    return host === pattern || host.endsWith(`.${pattern}`);
  });
}
