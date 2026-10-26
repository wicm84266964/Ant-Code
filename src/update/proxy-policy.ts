import { UpdateError } from "./contracts.ts";
import type { Route, RouteSummary } from "./contracts.ts";
import { cleanEnvironment, findNpmCli, runProcess } from "./process.ts";
import type { Runner } from "./process.ts";

export function normalizeUpdateProxy(value: string): string {
  if (value.length > 2048 || /[\r\n\0]/.test(value)) throw new UpdateError("INVALID_PROXY");
  let url: URL;
  try { url = new URL(value.includes("://") ? value : `http://${value}`); }
  catch { throw new UpdateError("INVALID_PROXY"); }
  if (!["http:", "https:"].includes(url.protocol)) throw new UpdateError("UNSUPPORTED_PROXY", "Only HTTP/HTTPS proxies are supported; SOCKS/PAC are not executed.");
  if (!url.hostname || url.pathname !== "/" || url.search || url.hash) throw new UpdateError("INVALID_PROXY");
  return url.href;
}
export function summarizeRoute(route: Route): RouteSummary {
  if (route.mode === "direct") return { mode: "direct", source: route.source };
  const url = new URL(route.url);
  return { mode: "proxy", source: route.source, endpoint: `${url.protocol}//${url.host}` };
}
export function redactUpdateText(text: string): string {
  return text.replace(/(?:https?|socks\d*):\/\/[^\s"'<>]+/gi, (value) => {
    try { const u = new URL(value); return `${u.protocol}//${u.host}/[redacted]`; } catch { return "[redacted-url]"; }
  }).slice(0, 2048);
}
export function parseWindowsStaticProxy(output: string): string | undefined {
  const pac = output.match(/AutoConfigURL\s+REG_SZ\s+([^\r\n]+)/i)?.[1]?.trim();
  const enabled = /ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(output);
  const server = output.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i)?.[1]?.trim();
  if (!enabled || !server) {
    if (pac) throw new UpdateError("PAC_UNSUPPORTED", "System PAC cannot be executed. Enter an HTTP proxy or explicitly choose direct.");
    return undefined;
  }
  if (!server.includes("=")) return server;
  const parts = new Map(server.split(";").map((part) => {
    const at = part.indexOf("="); return [part.slice(0, at).trim().toLowerCase(), part.slice(at + 1).trim()];
  }));
  const value = parts.get("https") ?? parts.get("http");
  if (!value && parts.has("socks")) throw new UpdateError("UNSUPPORTED_PROXY");
  return value;
}
export type DiscoverRouteOptions = {
  root: string; env: NodeJS.ProcessEnv; config?: Record<string, unknown>; proxyUrl?: string;
  allowDirect?: boolean; runner?: Runner; platform?: NodeJS.Platform;
};
export async function discoverRoute(options: DiscoverRouteOptions): Promise<Route> {
  // Explicit consent is one-shot and may override unusable auto-discovery. Never fallback on failure.
  if (options.proxyUrl !== undefined && options.allowDirect) throw new UpdateError("AMBIGUOUS_ROUTE");
  if (options.proxyUrl !== undefined) return { mode: "proxy", source: "manual", url: normalizeUpdateProxy(options.proxyUrl) };
  if (options.allowDirect === true) return { mode: "direct", source: "explicit" };
  const select = (value: unknown, source: string): Route | undefined => {
    if (value === undefined || value === null || value === "" || value === "null") return undefined;
    if (typeof value !== "string") throw new UpdateError("INVALID_PROXY");
    return { mode: "proxy", source, url: normalizeUpdateProxy(value.trim()) };
  };
  const web = options.config?.web as Record<string, unknown> | undefined;
  let route = select(web?.proxyUrl ?? options.config?.proxyUrl, "config");
  if (route) return route;
  for (const key of ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "HTTP_PROXY", "http_proxy"]) {
    route = select(options.env[key], `env:${key}`); if (route) return route;
  }
  const run = options.runner ?? runProcess;
  const local = { cwd: options.root, env: cleanEnvironment(options.env), timeoutMs: 5000 };
  // Only inspect config. Do not ask Git to contact a URL (rewrite/credential helpers must not run).
  const git = await run("git", ["config", "--null", "--list"], local);
  if (git.code !== 0) throw new UpdateError("GIT_CONFIG_UNREADABLE");
  let generic: string | undefined, scoped: string | undefined;
  for (const item of git.stdout.split("\0")) {
    const at = item.indexOf("\n"); if (at < 0) continue;
    const key = item.slice(0, at).toLowerCase(), value = item.slice(at + 1);
    if (key === "http.proxy") generic = value;
    if (/^http\.https:\/\/github\.com(?:\/[^.]*)?\.proxy$/.test(key)) scoped = value;
  }
  route = select(scoped ?? generic, "git"); if (route) return route;
  const npm = await findNpmCli();
  // Discovery only reads the original config paths. Installation uses the worker's
  // private empty files instead; never rewrite a user's real npmrc to select a route.
  // Even `npm config get` can run npm's update notifier. Discovery must be local-only.
  const npmEnv: NodeJS.ProcessEnv = { ...local.env, npm_config_update_notifier: "false" };
  for (const [key, value] of Object.entries(options.env)) {
    if (/^npm_config_(userconfig|globalconfig)$/i.test(key)) npmEnv[key.toLowerCase()] = value;
  }
  const npmLocal = { ...local, env: npmEnv };
  const npmConfig = await run(process.execPath, [npm, "config", "get", "https-proxy"], npmLocal);
  if (npmConfig.code !== 0) throw new UpdateError("NPM_CONFIG_UNREADABLE");
  route = select(npmConfig.stdout.trim(), "npm:https-proxy"); if (route) return route;
  const npmProxy = await run(process.execPath, [npm, "config", "get", "proxy"], npmLocal);
  if (npmProxy.code !== 0) throw new UpdateError("NPM_CONFIG_UNREADABLE");
  route = select(npmProxy.stdout.trim(), "npm:proxy"); if (route) return route;
  if ((options.platform ?? process.platform) === "win32") {
    const windows = await run("reg.exe", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"], local);
    if (windows.code === 0) { route = select(parseWindowsStaticProxy(windows.stdout), "windows"); if (route) return route; }
  }
  throw new UpdateError("ROUTE_REQUIRED", "No supported proxy was discovered. Enter a proxy or explicitly authorize direct for this check.");
}
