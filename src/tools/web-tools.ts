import http from "node:http";
import tls from "node:tls";
import { resolveProxyForUrl } from "../net/proxy.ts";

const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
export const WEB_FETCH_DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_SEARCH_MAX_BYTES = 1024 * 1024;
const DEFAULT_FETCH_USER_AGENT = "ant-code/1.1 local-lab-agent";
const SEARCH_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const SEARCH_HEADERS = Object.freeze({
  "user-agent": SEARCH_USER_AGENT,
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9"
});
const WIKIMEDIA_USER_AGENT = "Ant-Code/2.0.5 (https://github.com/wicm84266964/Ant-Code; local research agent)";
const WIKIMEDIA_HEADERS = Object.freeze({
  "user-agent": WIKIMEDIA_USER_AGENT,
  accept: "application/json"
});
const WIKIPEDIA_TIMEOUT_MS = 8_000;
const RAW_HTTP_HEADER_MAX_BYTES = 64 * 1024;
const MAX_SEARCH_RESULTS = 10;
const MAX_REDIRECTS = 5;
const RAW_TRUNCATED_RESPONSES = new WeakSet<Response>();

type FetchedBody = {
  text: string;
  bytes: number;
  truncated: boolean;
};

type WebFetchOptions = {
  timeoutMs: number;
  maxBytes: number;
  truncateOnLimit?: boolean;
  headers?: Record<string, string>;
  config?: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
};

type SearchResult = {
  title: string;
  url: string;
  snippet: string;
  engine?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

function asProcessEnv(value: unknown): NodeJS.ProcessEnv | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as NodeJS.ProcessEnv;
}

function asAbortSignal(value: unknown): AbortSignal | undefined {
  return value instanceof AbortSignal ? value : undefined;
}

export async function webFetchTool(input: Record<string, unknown>) {
  const url = normalizeUrl(input.url);
  const format = normalizeFetchFormat(input.format);
  const timeoutMs = clampNumber(input.timeoutMs ?? input.timeout ?? DEFAULT_FETCH_TIMEOUT_MS, 1000, 120_000);
  const requestedMaxBytes = positiveIntegerOrNull(input.maxBytes);
  const maxBytes = requestedMaxBytes ?? WEB_FETCH_DEFAULT_MAX_BYTES;

  const { response, body } = await fetchTextWithTimeout(url, {
    timeoutMs,
    maxBytes,
    truncateOnLimit: requestedMaxBytes !== null,
    config: asRecord(input.config),
    env: asProcessEnv(input.env),
    signal: asAbortSignal(input.signal)
  });
  const contentType = response.headers.get("content-type") ?? "";
  const htmlLike = contentType.includes("html") || looksLikeHtml(body.text);
  const content = formatFetchedContent(body.text, format, htmlLike, response.url);

  return {
    url,
    finalUrl: response.url,
    status: response.status,
    ok: response.ok,
    contentType,
    format,
    bytes: body.bytes,
    truncated: body.truncated,
    content
  };
}

export async function webSearchTool(input: Record<string, unknown>) {
  const query = String(input.query ?? "").trim();
  if (!query) {
    throw Object.assign(new Error("query is required"), { code: "WEB_SEARCH_QUERY_REQUIRED" });
  }
  const maxResults = clampNumber(input.maxResults ?? input.count ?? 5, 1, MAX_SEARCH_RESULTS);
  const timeoutMs = clampNumber(input.timeoutMs ?? input.timeout ?? DEFAULT_FETCH_TIMEOUT_MS, 1000, 120_000);
  const config = asRecord(input.config);
  const env = asProcessEnv(input.env);
  const signal = asAbortSignal(input.signal);
  const searxngUrl = normalizeOptionalUrl(input.searxngUrl ?? asRecord(config.web).searxngUrl ?? env?.LAB_AGENT_SEARXNG_URL);

  const errors: string[] = [];
  const batches: Array<{ provider: string; query: string; url: string; results: SearchResult[]; truncated: boolean }> = [];
  const attempts: Array<[string, () => Promise<{ provider: string; query: string; url: string; results: SearchResult[]; truncated: boolean }>]> = [
    ["wikipedia", () => searchWikipedia({ query, maxResults, timeoutMs, config, env, signal })]
  ];
  if (searxngUrl) {
    attempts.push(["searxng", () => searchSearxng({ query, maxResults, timeoutMs, searxngUrl, config, env, signal })]);
  }
  attempts.push(["bing", () => searchBing({ query, maxResults, timeoutMs, config, env, signal })]);
  attempts.push(["duckduckgo", () => searchDuckDuckGo({ query, maxResults, timeoutMs, config, env, signal })]);

  for (const [label, run] of attempts) {
    try {
      const result = await run();
      if (result.results.length > 0) {
        batches.push(result);
      } else {
        errors.push(`${label}: empty`);
      }
    } catch (error) {
      errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const merged = dedupeResults(batches.flatMap((batch) => batch.results)).slice(0, maxResults);
  if (merged.length > 0) {
    const total = batches.reduce((count, batch) => count + batch.results.length, 0);
    return {
      provider: batches.map((batch) => batch.provider).join("+"),
      query,
      url: batches[0]?.url ?? "",
      results: merged,
      truncated: batches.some((batch) => batch.truncated) || total > maxResults
    };
  }

  throw Object.assign(new Error(`Web search fetch failed (${errors.join("; ")})`), {
    code: "WEB_SEARCH_FETCH_FAILED"
  });
}

export function networkHostsForWebTool(name: string, input: Record<string, unknown> = {}, config: Record<string, unknown> = {}, env: NodeJS.ProcessEnv | Record<string, unknown> = {}) {
  if (name === "web_fetch") {
    const url = normalizeOptionalUrl(input.url);
    return url ? [url] : [];
  }
  if (name === "web_search") {
    const searxngUrl = normalizeOptionalUrl(input.searxngUrl ?? asRecord(config.web).searxngUrl ?? env.LAB_AGENT_SEARXNG_URL);
    return [
      ...(searxngUrl ? [searxngUrl] : []),
      "https://en.wikipedia.org/",
      "https://zh.wikipedia.org/",
      "https://www.bing.com/",
      "https://html.duckduckgo.com/",
      "https://lite.duckduckgo.com/",
      "https://duckduckgo.com/"
    ];
  }
  return [];
}

async function searchWikipedia({ query, maxResults, timeoutMs, config, env, signal }: { query: string; maxResults: number; timeoutMs: number; config?: Record<string, unknown>; env?: NodeJS.ProcessEnv; signal?: AbortSignal }) {
  const lang = wikipediaLanguageForQuery(query);
  const endpoint = new URL(`https://${lang}.wikipedia.org/w/api.php`);
  endpoint.searchParams.set("action", "query");
  endpoint.searchParams.set("list", "search");
  endpoint.searchParams.set("srsearch", query);
  endpoint.searchParams.set("srlimit", String(maxResults));
  endpoint.searchParams.set("srprop", "snippet");
  endpoint.searchParams.set("format", "json");
  endpoint.searchParams.set("utf8", "1");
  const { body } = await fetchTextWithTimeout(endpoint.href, {
    timeoutMs: Math.min(timeoutMs, WIKIPEDIA_TIMEOUT_MS),
    maxBytes: DEFAULT_SEARCH_MAX_BYTES,
    truncateOnLimit: true,
    headers: WIKIMEDIA_HEADERS,
    config,
    env,
    signal
  });
  let json: unknown = {};
  try {
    json = JSON.parse(body.text);
  } catch {
    json = {};
  }
  const results = parseWikipediaQueryJson(json, lang).slice(0, maxResults);
  return {
    provider: `wikipedia-${lang}`,
    query,
    url: endpoint.href,
    results,
    truncated: body.truncated || results.length >= maxResults
  };
}

export function wikipediaLanguageForQuery(query: string) {
  return /[\u3400-\u9fff]/.test(query) ? "zh" : "en";
}

export function parseWikipediaQueryJson(json: unknown, lang: string) {
  const search = asRecord(asRecord(json).query).search;
  const rows = Array.isArray(search) ? search : [];
  const results: SearchResult[] = [];
  for (const item of rows) {
    const row = asRecord(item);
    const title = cleanText(row.title);
    if (!title) {
      continue;
    }
    results.push({
      title,
      url: wikipediaArticleUrl(lang, title),
      snippet: cleanText(stripHtml(row.snippet ?? "")),
      engine: "wikipedia"
    });
  }
  return dedupeResults(results);
}

function wikipediaArticleUrl(lang: string, title: string) {
  return `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
}

function bingResultUrl(href: string, citeHtml: string) {
  const direct = decodeHtml(href);
  if (/^https?:\/\//i.test(direct) && !/\bbing\.com\b/i.test(direct)) {
    return direct;
  }
  const cite = cleanText(stripHtml(citeHtml)).split(/[›·|]/)[0].trim();
  if (/^https?:\/\//i.test(cite)) {
    return cite;
  }
  if (/^(www\.)?[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(cite)) {
    return `https://${cite.replace(/^\/\//, "")}`;
  }
  return "";
}

async function searchBing({ query, maxResults, timeoutMs, config, env, signal }: { query: string; maxResults: number; timeoutMs: number; config?: Record<string, unknown>; env?: NodeJS.ProcessEnv; signal?: AbortSignal }) {
  const endpoint = new URL("https://www.bing.com/search");
  endpoint.searchParams.set("q", query);
  if (wikipediaLanguageForQuery(query) === "zh") {
    endpoint.searchParams.set("setlang", "zh-CN");
  }
  const { body } = await fetchTextWithTimeout(endpoint.href, {
    timeoutMs,
    maxBytes: DEFAULT_SEARCH_MAX_BYTES,
    truncateOnLimit: true,
    headers: {
      ...SEARCH_HEADERS,
      "accept-language": wikipediaLanguageForQuery(query) === "zh" ? "zh-CN,zh;q=0.9,en;q=0.5" : SEARCH_HEADERS["accept-language"]
    },
    config,
    env,
    signal
  });
  const results = parseBingHtml(body.text).slice(0, maxResults);
  return {
    provider: "bing-html",
    query,
    url: endpoint.href,
    results,
    truncated: body.truncated || results.length >= maxResults
  };
}

export function parseBingHtml(html: unknown) {
  const text = String(html ?? "");
  const results: SearchResult[] = [];
  const blocks = Array.from(text.matchAll(/<li[^>]*class=["'][^"']*b_algo[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi));
  for (const block of blocks) {
    const body = block[1];
    const link = body.match(/<h2[^>]*>\s*<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!link) {
      continue;
    }
    const cite = body.match(/<cite[^>]*>([\s\S]*?)<\/cite>/i);
    const url = bingResultUrl(link[1], cite?.[1] ?? "");
    const title = cleanText(stripHtml(link[2]));
    const snippetMatch = body.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    if (!title || !url) {
      continue;
    }
    results.push({
      title,
      url,
      snippet: cleanText(stripHtml(snippetMatch?.[1] ?? "")),
      engine: "bing"
    });
  }
  return dedupeResults(results);
}

async function searchSearxng({ query, maxResults, timeoutMs, searxngUrl, config, env, signal }: { query: string; maxResults: number; timeoutMs: number; searxngUrl: string; config?: Record<string, unknown>; env?: NodeJS.ProcessEnv; signal?: AbortSignal }) {
  const endpoint = new URL("/search", searxngUrl);
  endpoint.searchParams.set("q", query);
  endpoint.searchParams.set("format", "json");
  const { body } = await fetchTextWithTimeout(endpoint.href, {
    timeoutMs,
    maxBytes: DEFAULT_SEARCH_MAX_BYTES,
    truncateOnLimit: true,
    config,
    env,
    signal
  });
  let json: Record<string, unknown> = {};
  try {
    json = asRecord(JSON.parse(body.text));
  } catch {
    json = {};
  }
  const results = Array.isArray(json.results) ? json.results : [];
  return {
    provider: "searxng",
    query,
    url: endpoint.href,
    results: results.slice(0, maxResults).map((item: unknown) => {
      const row = asRecord(item);
      return {
        title: cleanText(row.title),
        url: String(row.url ?? ""),
        snippet: cleanText(row.content ?? row.snippet ?? ""),
        engine: row.engine ?? null
      };
    }).filter((item) => item.title && item.url),
    truncated: results.length > maxResults
  };
}

async function searchDuckDuckGo({ query, maxResults, timeoutMs, config, env, signal }: { query: string; maxResults: number; timeoutMs: number; config?: Record<string, unknown>; env?: NodeJS.ProcessEnv; signal?: AbortSignal }) {
  const htmlEndpoint = new URL("https://html.duckduckgo.com/html/");
  htmlEndpoint.searchParams.set("q", query);
  try {
    const { body } = await fetchTextWithTimeout(htmlEndpoint.href, {
      timeoutMs,
      maxBytes: DEFAULT_SEARCH_MAX_BYTES,
      truncateOnLimit: true,
      headers: SEARCH_HEADERS,
      config,
      env,
      signal
    });
    const results = parseDuckDuckGoHtml(body.text).slice(0, maxResults);
    if (results.length > 0) {
      return {
        provider: "duckduckgo-html",
        query,
        url: htmlEndpoint.href,
        results,
        truncated: body.truncated
      };
    }
  } catch (error) {
    const lite = await searchDuckDuckGoLite({ query, maxResults, timeoutMs, config, env, signal }).catch(() => null);
    if (lite && lite.results.length > 0) {
      return lite;
    }
    throw Object.assign(new Error(`DuckDuckGo search fetch failed: ${error instanceof Error ? error.message : String(error)}`), {
      code: "WEB_SEARCH_FETCH_FAILED",
      cause: error
    });
  }
  const lite = await searchDuckDuckGoLite({ query, maxResults, timeoutMs, config, env, signal });
  if (lite.results.length > 0) {
    return lite;
  }
  return {
    provider: "duckduckgo-html",
    query,
    url: htmlEndpoint.href,
    results: [],
    truncated: false
  };
}

async function searchDuckDuckGoLite({ query, maxResults, timeoutMs, config, env, signal }: { query: string; maxResults: number; timeoutMs: number; config?: Record<string, unknown>; env?: NodeJS.ProcessEnv; signal?: AbortSignal }) {
  const endpoint = new URL("https://lite.duckduckgo.com/lite/");
  endpoint.searchParams.set("q", query);
  const { body } = await fetchTextWithTimeout(endpoint.href, {
    timeoutMs,
    maxBytes: DEFAULT_SEARCH_MAX_BYTES,
    truncateOnLimit: true,
    headers: SEARCH_HEADERS,
    config,
    env,
    signal
  });
  return {
    provider: "duckduckgo-lite",
    query,
    url: endpoint.href,
    results: parseDuckDuckGoLite(body.text).slice(0, maxResults),
    truncated: body.truncated
  };
}

export function parseDuckDuckGoHtml(html: unknown) {
  const text = String(html ?? "");
  const links = Array.from(text.matchAll(/<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi));
  const results: SearchResult[] = [];
  for (let index = 0; index < links.length; index += 1) {
    const link = links[index];
    const next = links[index + 1];
    const block = text.slice(link.index ?? 0, next?.index ?? text.length);
    const rawUrl = decodeHtml(link[1]);
    const url = decodeDuckDuckGoUrl(rawUrl);
    const title = cleanText(stripHtml(link[2]));
    const snippetMatch = block.match(/<a[^>]+class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/a>|<div[^>]+class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
    const snippet = cleanText(stripHtml(snippetMatch?.[1] ?? snippetMatch?.[2] ?? ""));
    if (title && url) {
      results.push({ title, url, snippet });
    }
  }
  return dedupeResults(results);
}

export function parseDuckDuckGoLite(html: unknown) {
  const text = String(html ?? "");
  const links = Array.from(text.matchAll(/<a[^>]+class=["'][^"']*result-link[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi));
  const results: SearchResult[] = [];
  for (const link of links) {
    const url = decodeHtml(link[1]);
    const title = cleanText(stripHtml(link[2]));
    if (title && url && !/duckduckgo\.com/i.test(url)) {
      results.push({ title, url, snippet: "" });
    }
  }
  return dedupeResults(results);
}

function decodeDuckDuckGoUrl(rawUrl: string) {
  try {
    const url = new URL(rawUrl, "https://duckduckgo.com");
    const uddg = url.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : url.href;
  } catch {
    return rawUrl;
  }
}

function formatFetchedContent(text: string, format: unknown, htmlLike: unknown, baseUrl: unknown) {
  if (format === "html") {
    return text;
  }
  if (!htmlLike) {
    return text;
  }
  return format === "markdown" ? htmlToMarkdown(text, baseUrl) : cleanText(stripHtml(text));
}

export function htmlToMarkdown(html: unknown, baseUrl: unknown = "") {
  let text = String(html ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n")
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n")
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n")
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "\n- $1")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|tr|table)>/gi, "\n")
    .replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_match: string, href: string, label: string) => {
      const cleanLabel = cleanText(stripHtml(label));
      const absolute = resolveUrl(decodeHtml(href), baseUrl);
      return cleanLabel && absolute ? `[${cleanLabel}](${absolute})` : cleanLabel || absolute;
    });
  text = stripHtml(text);
  return cleanMarkdown(text);
}

function stripHtml(value: unknown) {
  return decodeHtml(String(value ?? "").replace(/<[^>]+>/g, " "));
}

function cleanMarkdown(value: unknown) {
  return decodeHtml(String(value ?? ""))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function cleanText(value: unknown) {
  return decodeHtml(String(value ?? ""))
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_: unknown, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_: unknown, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}

/**
 * @param {string} url
 * @param {{ timeoutMs: number; maxBytes: number; truncateOnLimit?: boolean; config?: Record<string, unknown>; env?: NodeJS.ProcessEnv; signal?: AbortSignal }} options
 */
async function fetchTextWithTimeout(url: string, options: WebFetchOptions): Promise<{ response: Response; body: FetchedBody }> {
  const timeoutController = new AbortController();
  const linked = linkAbortSignals([timeoutController.signal, options.signal]);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    timeoutController.abort(webFetchTimeoutError(options.timeoutMs));
  }, options.timeoutMs);
  try {
    const response = await fetchResponse(url, {
      ...options,
      signal: linked.signal
    });
    const body = await readResponseText(response, options.maxBytes, {
      signal: linked.signal,
      truncateOnLimit: options.truncateOnLimit === true
    });
    return { response, body };
  } catch (error) {
    if (timedOut) {
      throw webFetchTimeoutError(options.timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    linked.cleanup();
  }
}

/**
 * @param {string} url
 * @param {{ maxBytes: number; truncateOnLimit?: boolean; config?: Record<string, unknown>; env?: NodeJS.ProcessEnv; signal?: AbortSignal }} options
 */
async function fetchResponse(url: string, options: { maxBytes: number; truncateOnLimit?: boolean; headers?: Record<string, string>; config?: Record<string, unknown>; env?: NodeJS.ProcessEnv; signal?: AbortSignal }): Promise<Response> {
  const proxyUrl = resolveProxyForUrl(url, { config: options.config, env: options.env });
  const headers = options.headers ?? { "user-agent": DEFAULT_FETCH_USER_AGENT };
  if (proxyUrl) {
    return fetchViaHttpProxy(url, {
      proxyUrl,
      signal: options.signal,
      maxRedirects: MAX_REDIRECTS,
      maxBytes: options.maxBytes,
      truncateOnLimit: options.truncateOnLimit === true,
      headers
    });
  }
  return fetch(url, {
    signal: options.signal,
    headers
  });
}

/**
 * @param {Array<AbortSignal | undefined>} signals
 */
function linkAbortSignals(signals: Array<AbortSignal | undefined>) {
  const controller = new AbortController();
  const listeners: Array<{ signal: AbortSignal; onAbort: () => void }> = [];
  /** @param {AbortSignal | undefined} signal */
  const abort = (signal: AbortSignal | undefined) => {
    if (!controller.signal.aborted) {
      controller.abort(signal?.reason);
    }
  };
  for (const signal of signals) {
    if (!signal) {
      continue;
    }
    if (signal.aborted) {
      abort(signal);
      continue;
    }
    const onAbort = () => abort(signal);
    signal.addEventListener("abort", onAbort, { once: true });
    listeners.push({ signal, onAbort });
  }
  return {
    signal: controller.signal,
    cleanup() {
      for (const listener of listeners) {
        listener.signal.removeEventListener("abort", listener.onAbort);
      }
    }
  };
}

/**
 * @param {string} url
 * @param {{ proxyUrl: string; signal?: AbortSignal; maxRedirects: number; maxBytes: number; truncateOnLimit: boolean }} options
 */
async function fetchViaHttpProxy(url: string, options: { proxyUrl: string; signal?: AbortSignal; maxRedirects: number; maxBytes: number; truncateOnLimit: boolean; headers?: Record<string, string> }): Promise<Response> {
  const response = await requestViaHttpProxy(url, options);
  const location = response.headers.get("location");
  if (isRedirect(response.status) && location && options.maxRedirects > 0) {
    await response.body?.cancel?.().catch?.(() => {});
    const nextUrl = new URL(location, url).href;
    return fetchViaHttpProxy(nextUrl, { ...options, maxRedirects: options.maxRedirects - 1 });
  }
  return response;
}

/**
 * @param {string} targetUrl
 * @param {{ proxyUrl: string; signal?: AbortSignal; maxBytes: number; truncateOnLimit: boolean }} options
 */
function requestViaHttpProxy(targetUrl: string, options: { proxyUrl: string; signal?: AbortSignal; maxBytes: number; truncateOnLimit: boolean; headers?: Record<string, string> }): Promise<Response> {
  return new Promise((resolve, reject) => {
    const target = new URL(targetUrl);
    const proxy = new URL(options.proxyUrl);
    if (target.protocol === "http:") {
      proxyHttpRequest({ target, proxy, signal: options.signal, headers: options.headers }).then(resolve, reject);
      return;
    }
    if (target.protocol === "https:") {
      proxyHttpsRequest({
        target,
        proxy,
        signal: options.signal,
        maxBytes: options.maxBytes,
        truncateOnLimit: options.truncateOnLimit,
        headers: options.headers
      }).then(resolve, reject);
      return;
    }
    reject(new Error(`Unsupported proxied protocol: ${target.protocol}`));
  });
}

/**
 * @param {{ target: URL; proxy: URL; signal?: AbortSignal }} input
 */
function proxyHttpRequest(input: { target: URL; proxy: URL; signal?: AbortSignal; headers?: Record<string, string> }): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: input.proxy.hostname,
      port: input.proxy.port || 80,
      method: "GET",
      path: input.target.href,
      headers: createProxyHeaders(input.target, input.proxy, input.headers)
    });
    wireRequest(request, input.signal, reject);
    request.on("response", (response) => resolve(toFetchLikeResponse(input.target.href, response)));
    request.end();
  });
}

/**
 * @param {{ target: URL; proxy: URL; signal?: AbortSignal; maxBytes: number; truncateOnLimit: boolean }} input
 */
function proxyHttpsRequest(input: { target: URL; proxy: URL; signal?: AbortSignal; maxBytes: number; truncateOnLimit: boolean; headers?: Record<string, string> }): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: input.proxy.hostname,
      port: input.proxy.port || 80,
      method: "CONNECT",
      path: `${input.target.hostname}:${input.target.port || 443}`,
      headers: createProxyConnectHeaders(input.target, input.proxy)
    });
    wireRequest(request, input.signal, reject);
    request.on("connect", (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`Proxy CONNECT failed with HTTP ${response.statusCode}`));
        return;
      }
      const tlsSocket = tls.connect({ socket, servername: input.target.hostname });
      wireSocketAbort(tlsSocket, input.signal);
      tlsSocket.once("secureConnect", () => {
        tlsSocket.write([
          `GET ${input.target.pathname}${input.target.search} HTTP/1.1`,
          `Host: ${input.target.host}`,
          `User-Agent: ${input.headers?.["user-agent"] ?? DEFAULT_FETCH_USER_AGENT}`,
          `Accept: ${input.headers?.accept ?? "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"}`,
          "Accept-Encoding: identity",
          "Connection: close",
          "",
          ""
        ].join("\r\n"));
      });
      collectRawHttpResponse(input.target.href, tlsSocket, {
        maxBytes: input.maxBytes,
        truncateOnLimit: input.truncateOnLimit
      }).then(resolve, reject);
    });
    request.end();
  });
}

/**
 * @param {import("node:http").ClientRequest} request
 * @param {AbortSignal | undefined} signal
 * @param {(error: Error) => void} reject
 */
function wireRequest(request: import("node:http").ClientRequest, signal: AbortSignal | undefined, reject: (error: Error) => void) {
  request.once("error", reject);
  if (!signal) {
    return;
  }
  if (signal.aborted) {
    request.destroy(new Error("The operation was aborted"));
    return;
  }
  signal.addEventListener("abort", () => request.destroy(new Error("The operation was aborted")), { once: true });
}

/**
 * @param {import("node:net").Socket} socket
 * @param {AbortSignal | undefined} signal
 */
function wireSocketAbort(socket: import("node:net").Socket, signal: AbortSignal | undefined) {
  if (!signal) {
    return;
  }
  if (signal.aborted) {
    socket.destroy(new Error("The operation was aborted"));
    return;
  }
  signal.addEventListener("abort", () => socket.destroy(new Error("The operation was aborted")), { once: true });
}

/**
 * @param {string} url
 * @param {import("node:net").Socket} socket
 * @param {{ maxBytes?: number; truncateOnLimit?: boolean }} [options]
 */
export function collectRawHttpResponse(url: string, socket: import("node:net").Socket, options: { maxBytes?: number; truncateOnLimit?: boolean } = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const maxBytes = positiveIntegerOrNull(options.maxBytes) ?? WEB_FETCH_DEFAULT_MAX_BYTES;
    const rawLimit = maxBytes + RAW_HTTP_HEADER_MAX_BYTES;
    const truncateOnLimit = options.truncateOnLimit === true;
    const chunks: Buffer[] = [];
    let retainedBytes = 0;
    let receivedBytes = 0;
    let headerEnd: number | null = null;
    let declaredOversize = false;
    let settled = false;
    const cleanup = () => {
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("end", onEnd);
      socket.removeListener("close", onClose);
    };
    const finishResolve = (value: Response) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const finishReject = (value: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(value);
    };
    const destroySocket = () => {
      try {
        socket.destroy();
      } catch {
        // The response has already settled; socket teardown is best-effort.
      }
    };
    /** @param {number} limit */
    const trimRetained = (limit: number) => {
      if (retainedBytes <= limit) return;
      const prefix = Buffer.concat(chunks, retainedBytes).subarray(0, limit);
      chunks.splice(0, chunks.length, prefix);
      retainedBytes = prefix.length;
    };
    /** @param {number} observedBytes */
    const rejectTooLarge = (observedBytes: number) => {
      const error = webFetchResponseTooLargeError(maxBytes, observedBytes);
      finishReject(error);
      destroySocket();
    };
    const resolvePartial = () => {
      try {
        trimRetained((headerEnd ?? 0) + maxBytes);
        const response = parseRawHttpResponse(url, Buffer.concat(chunks, retainedBytes));
        RAW_TRUNCATED_RESPONSES.add(response);
        finishResolve(response);
        destroySocket();
      } catch (error) {
        finishReject(error);
        destroySocket();
      }
    };
    /** @param {Buffer | Uint8Array} chunk */
    const onData = (chunk: Buffer | Uint8Array) => {
      if (settled) return;
      const buffer = Buffer.from(chunk);
      receivedBytes += buffer.length;
      const retentionLimit = headerEnd === null ? rawLimit : headerEnd + maxBytes;
      const remaining = Math.max(0, retentionLimit - retainedBytes);
      if (remaining > 0) {
        const kept = buffer.subarray(0, remaining);
        chunks.push(kept);
        retainedBytes += kept.length;
      }

      if (headerEnd === null) {
        const raw = Buffer.concat(chunks, retainedBytes);
        const separator = raw.indexOf("\r\n\r\n");
        if (separator >= 0) {
          headerEnd = separator + 4;
          if (headerEnd > RAW_HTTP_HEADER_MAX_BYTES) {
            rejectTooLarge(receivedBytes);
            return;
          }
          const declared = raw.subarray(0, separator).toString("latin1").match(/\r\ncontent-length:\s*(\d+)/i);
          const declaredBytes = declared ? Number(declared[1]) : null;
          if (declaredBytes !== null && Number.isSafeInteger(declaredBytes) && declaredBytes > maxBytes) {
            if (!truncateOnLimit) {
              rejectTooLarge(declaredBytes);
              return;
            }
            declaredOversize = true;
          }
          trimRetained(headerEnd + maxBytes);
        } else if (retainedBytes >= RAW_HTTP_HEADER_MAX_BYTES) {
          rejectTooLarge(receivedBytes);
          return;
        }
      }

      const receivedBodyBytes = headerEnd === null ? 0 : receivedBytes - headerEnd;
      if (headerEnd !== null && (receivedBodyBytes > maxBytes || (declaredOversize && receivedBodyBytes >= maxBytes))) {
        if (truncateOnLimit) resolvePartial();
        else rejectTooLarge(receivedBodyBytes);
      }
    };
    /** @param {Error} error */
    const onError = (error: Error) => finishReject(error);
    const onEnd = () => {
      try {
        finishResolve(parseRawHttpResponse(url, Buffer.concat(chunks, retainedBytes)));
      } catch (error) {
        finishReject(error);
      }
    };
    const onClose = () => finishReject(new Error("Proxy HTTPS response socket closed before the response ended"));
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("end", onEnd);
    socket.once("close", onClose);
  });
}

/**
 * @param {string} url
 * @param {Buffer} raw
 */
function parseRawHttpResponse(url: string, raw: Buffer) {
  const separator = raw.indexOf("\r\n\r\n");
  if (separator < 0) {
    throw new Error("Proxy HTTPS response ended before headers were complete");
  }
  const headerText = raw.subarray(0, separator).toString("latin1");
  const bodyRaw = raw.subarray(separator + 4);
  const [statusLine, ...headerLines] = headerText.split("\r\n");
  const statusMatch = statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})\s*(.*)$/i);
  if (!statusMatch) {
    throw new Error("Proxy HTTPS response status line is invalid");
  }
  const headers = new Headers();
  for (const line of headerLines) {
    const index = line.indexOf(":");
    if (index <= 0) {
      continue;
    }
    headers.append(line.slice(0, index).trim(), line.slice(index + 1).trim());
  }
  const body = /chunked/i.test(headers.get("transfer-encoding") ?? "")
    ? decodeChunkedBody(bodyRaw)
    : bodyRaw;
  headers.delete("transfer-encoding");
  const result = new Response(new Uint8Array(body), {
    status: Number(statusMatch[1]),
    statusText: statusMatch[2] ?? "",
    headers
  });
  Object.defineProperty(result, "url", {
    value: url,
    configurable: true
  });
  return result;
}

/**
 * @param {Buffer} raw
 */
function decodeChunkedBody(raw: Buffer) {
  const chunks = [];
  let offset = 0;
  while (offset < raw.length) {
    const lineEnd = raw.indexOf("\r\n", offset);
    if (lineEnd < 0) {
      break;
    }
    const sizeText = raw.subarray(offset, lineEnd).toString("ascii").split(";", 1)[0].trim();
    const size = Number.parseInt(sizeText, 16);
    if (!Number.isFinite(size)) {
      break;
    }
    offset = lineEnd + 2;
    if (size === 0) {
      break;
    }
    chunks.push(raw.subarray(offset, offset + size));
    offset += size + 2;
  }
  return Buffer.concat(chunks);
}

/**
 * @param {string} url
 * @param {import("node:http").IncomingMessage} response
 */
function toFetchLikeResponse(url: string, response: import("node:http").IncomingMessage) {
  const result = new Response(toWebStream(response), {
    status: response.statusCode ?? 0,
    statusText: response.statusMessage ?? "",
    headers: normalizeHeaders(response.headers)
  });
  Object.defineProperty(result, "url", {
    value: url,
    configurable: true
  });
  return result;
}

/**
 * @param {import("node:http").IncomingMessage} response
 */
function toWebStream(response: import("node:http").IncomingMessage) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      response.on("data", (chunk: Buffer | string) => controller.enqueue(chunk instanceof Uint8Array ? chunk : Buffer.from(chunk)));
      response.on("end", () => controller.close());
      response.on("error", (error: Error) => controller.error(error));
    },
    cancel() {
      response.destroy();
    }
  });
}

/**
 * @param {import("node:http").IncomingHttpHeaders} headers
 */
function normalizeHeaders(headers: import("node:http").IncomingHttpHeaders) {
  const result = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        result.append(key, item);
      }
    } else if (value !== undefined) {
      result.set(key, String(value));
    }
  }
  return result;
}

/**
 * @param {URL} target
 * @param {URL} proxy
 */
function createProxyHeaders(target: URL, proxy: URL, headers: Record<string, string> = {}) {
  return {
    ...createProxyAuthHeader(proxy),
    host: target.host,
    "user-agent": headers["user-agent"] ?? DEFAULT_FETCH_USER_AGENT,
    accept: headers.accept ?? "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-encoding": "identity",
    connection: "close"
  };
}

/**
 * @param {URL} target
 * @param {URL} proxy
 */
function createProxyConnectHeaders(target: URL, proxy: URL) {
  return {
    ...createProxyAuthHeader(proxy),
    host: `${target.hostname}:${target.port || 443}`,
    "user-agent": "ant-code/1.1 local-lab-agent"
  };
}

/**
 * @param {URL} proxy
 */
function createProxyAuthHeader(proxy: URL) {
  if (!proxy.username && !proxy.password) {
    return {};
  }
  const credentials = Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64");
  return { "proxy-authorization": `Basic ${credentials}` };
}

function isRedirect(status: number) {
  return [301, 302, 303, 307, 308].includes(status);
}

/**
 * @param {Response} response
 * @param {number | null | undefined} maxBytes
 * @param {{ signal?: AbortSignal; truncateOnLimit?: boolean }} [options]
 */
export async function readResponseText(response: Response, maxBytes: number | null | undefined, options: { signal?: AbortSignal; truncateOnLimit?: boolean } = {}) {
  const limit = positiveIntegerOrNull(maxBytes);
  const contentLength = responseContentLength(response);
  const truncateOnLimit = options.truncateOnLimit === true;
  const knownOversize = limit !== null && contentLength !== null && contentLength > limit;
  if (knownOversize && !truncateOnLimit) {
    const error = webFetchResponseTooLargeError(limit, contentLength);
    try {
      await response.body?.cancel(error);
    } catch {
      // The response can already be closed or locked by an alternate fetch implementation.
    }
    throw error;
  }
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await awaitWithAbort(response.text(), options.signal);
    const bytes = Buffer.byteLength(text, "utf8");
    if (limit === null) {
      return {
        text,
        bytes,
        truncated: false
      };
    }
    if (bytes > limit && !truncateOnLimit) {
      throw webFetchResponseTooLargeError(limit, bytes);
    }
    return {
      text: utf8Prefix(Buffer.from(text, "utf8"), limit),
      bytes,
      truncated: bytes > limit
    };
  }

  const chunks: Buffer[] = [];
  let bytes = 0;
  let keptBytes = 0;
  let truncated = RAW_TRUNCATED_RESPONSES.has(response) || knownOversize;
  let completed = false;
  try {
    while (true) {
      const { done, value } = await readResponseChunk(reader, options.signal);
      if (done) {
        completed = true;
        break;
      }
      const chunk = Buffer.from(value);
      bytes += chunk.length;
      if (limit === null) {
        chunks.push(chunk);
        keptBytes += chunk.length;
        continue;
      }
      if (keptBytes < limit) {
        const remaining = limit - keptBytes;
        const kept = chunk.subarray(0, Math.max(0, remaining));
        chunks.push(kept);
        keptBytes += kept.length;
      }
      if (bytes > limit || (knownOversize && keptBytes >= limit)) {
        truncated = true;
        completed = true;
        cancelResponseReader(reader, new Error("Web response exceeded maxBytes"));
        if (!truncateOnLimit) {
          throw webFetchResponseTooLargeError(limit, Math.max(bytes, contentLength ?? 0));
        }
        break;
      }
    }
  } finally {
    if (!completed) {
      cancelResponseReader(reader, options.signal?.reason);
    }
    try {
      reader.releaseLock();
    } catch {
      // The underlying stream may still be settling after cancellation.
    }
  }
  return {
    text: utf8Prefix(Buffer.concat(chunks), limit),
    bytes: Math.max(bytes, contentLength ?? 0),
    truncated
  };
}

/** @param {Response} response */
function responseContentLength(response: Response) {
  const raw = response.headers?.get?.("content-length");
  if (raw === null || raw === undefined || String(raw).trim() === "") {
    return null;
  }
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * @param {Buffer} buffer
 * @param {number | null | undefined} maxBytes
 */
export function utf8Prefix(buffer: Buffer, maxBytes: number | null | undefined) {
  if (maxBytes === null || maxBytes === undefined) {
    return buffer.toString("utf8");
  }
  const decoder = new TextDecoder("utf-8");
  const text = decoder.decode(buffer.subarray(0, Math.max(0, maxBytes)), { stream: true });
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return text;
  }
  let bytes = 0;
  let end = 0;
  for (const point of text) {
    const pointBytes = Buffer.byteLength(point, "utf8");
    if (bytes + pointBytes > maxBytes) break;
    bytes += pointBytes;
    end += point.length;
  }
  return text.slice(0, end);
}

/**
 * @param {ReadableStreamDefaultReader<Uint8Array>} reader
 * @param {AbortSignal | undefined} signal
 */
function readResponseChunk(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal | undefined) {
  if (!signal) {
    return reader.read();
  }
  if (signal.aborted) {
    cancelResponseReader(reader, signal.reason);
    return Promise.reject(webFetchAbortError(signal.reason));
  }
  return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    let settled = false;
    const finishResolve = (value: ReadableStreamReadResult<Uint8Array>) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const finishReject = (value: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(value);
    };
    const onAbort = () => {
      cancelResponseReader(reader, signal.reason);
      finishReject(webFetchAbortError(signal.reason));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve().then(() => reader.read()).then(finishResolve, finishReject);
  });
}

/**
 * @param {Promise<unknown>} promise
 * @param {AbortSignal | undefined} signal
 */
function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    return Promise.reject(webFetchAbortError(signal.reason));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finishResolve = (value: T) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const finishReject = (value: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(value);
    };
    const onAbort = () => finishReject(webFetchAbortError(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(finishResolve, finishReject);
  });
}

/**
 * @param {ReadableStreamDefaultReader<Uint8Array>} reader
 * @param {unknown} reason
 */
function cancelResponseReader(reader: ReadableStreamDefaultReader<Uint8Array>, reason: unknown) {
  try {
    Promise.resolve(reader.cancel(reason)).catch(() => {});
  } catch {
    // Cancellation is best-effort; the linked fetch signal is also aborted.
  }
}

/** @param {unknown} reason */
function webFetchAbortError(reason: unknown) {
  if (reason instanceof Error) {
    return reason;
  }
  return Object.assign(new Error(reason ? String(reason) : "The web request was aborted"), {
    name: "AbortError",
    code: "ABORT_ERR"
  });
}

/** @param {number} timeoutMs */
function webFetchTimeoutError(timeoutMs: number) {
  return Object.assign(new Error(`Web request timed out after ${timeoutMs}ms`), {
    name: "TimeoutError",
    code: "WEB_FETCH_TIMEOUT"
  });
}

/**
 * @param {number} maxBytes
 * @param {number} observedBytes
 */
export function webFetchResponseTooLargeError(maxBytes: number, observedBytes: number) {
  return Object.assign(new Error(`Web response exceeds the ${maxBytes}-byte safety limit`), {
    name: "RangeError",
    code: "WEB_FETCH_RESPONSE_TOO_LARGE",
    maxBytes,
    observedBytes
  });
}

function normalizeUrl(value: unknown) {
  const url = normalizeOptionalUrl(value);
  if (!url) {
    throw Object.assign(new Error("url must be an http(s) URL"), { code: "WEB_URL_REQUIRED" });
  }
  return url;
}

function normalizeOptionalUrl(value: unknown) {
  const text = String(value ?? "").trim();
  if (!text) {
    return null;
  }
  try {
    const url = new URL(text);
    if (!["http:", "https:"].includes(url.protocol)) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

function normalizeFetchFormat(value: unknown) {
  const format = String(value ?? "markdown").trim().toLowerCase();
  if (["text", "markdown", "html"].includes(format)) {
    return format;
  }
  return "markdown";
}

function looksLikeHtml(value: unknown) {
  return /<\/?[a-z][\s\S]*>/i.test(String(value ?? "").slice(0, 2048));
}

function resolveUrl(href: unknown, baseUrl: unknown) {
  try {
    return new URL(String(href ?? ""), String(baseUrl || "https://example.invalid")).href;
  } catch {
    return String(href ?? "");
  }
}

function dedupeResults<T extends { url: string }>(results: T[]) {
  const seen = new Set<string>();
  return results.filter((item) => {
    const key = item.url.toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function clampNumber(value: unknown, min: number, max: number) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function positiveIntegerOrNull(value: unknown) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}
