import http from "node:http";
import tls from "node:tls";
import { resolveProxyForUrl } from "../net/proxy.js";

const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const MAX_SEARCH_RESULTS = 10;
const MAX_REDIRECTS = 5;

export async function webFetchTool(input) {
  const url = normalizeUrl(input.url);
  const format = normalizeFetchFormat(input.format);
  const timeoutMs = clampNumber(input.timeoutMs ?? input.timeout ?? DEFAULT_FETCH_TIMEOUT_MS, 1000, 120_000);
  const maxBytes = positiveIntegerOrNull(input.maxBytes);

  const response = await fetchWithTimeout(url, { timeoutMs, config: input.config, env: input.env, signal: input.signal });
  const body = await readResponseText(response, maxBytes);
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

export async function webSearchTool(input) {
  const query = String(input.query ?? "").trim();
  if (!query) {
    throw Object.assign(new Error("query is required"), { code: "WEB_SEARCH_QUERY_REQUIRED" });
  }
  const maxResults = clampNumber(input.maxResults ?? input.count ?? 5, 1, MAX_SEARCH_RESULTS);
  const timeoutMs = clampNumber(input.timeoutMs ?? input.timeout ?? DEFAULT_FETCH_TIMEOUT_MS, 1000, 120_000);
  const searxngUrl = normalizeOptionalUrl(input.searxngUrl ?? input.config?.web?.searxngUrl ?? input.env?.LAB_AGENT_SEARXNG_URL);

  if (searxngUrl) {
    const result = await searchSearxng({ query, maxResults, timeoutMs, searxngUrl, config: input.config, env: input.env, signal: input.signal });
    if (result.results.length > 0) {
      return result;
    }
  }

  return searchDuckDuckGo({ query, maxResults, timeoutMs, config: input.config, env: input.env, signal: input.signal });
}

export function networkHostsForWebTool(name, input = {}, config = {}, env = {}) {
  if (name === "web_fetch") {
    const url = normalizeOptionalUrl(input.url);
    return url ? [url] : [];
  }
  if (name === "web_search") {
    const searxngUrl = normalizeOptionalUrl(input.searxngUrl ?? config.web?.searxngUrl ?? env.LAB_AGENT_SEARXNG_URL);
    return [searxngUrl ?? "https://duckduckgo.com/"];
  }
  return [];
}

async function searchSearxng({ query, maxResults, timeoutMs, searxngUrl, config, env, signal }) {
  const endpoint = new URL("/search", searxngUrl);
  endpoint.searchParams.set("q", query);
  endpoint.searchParams.set("format", "json");
  const response = await fetchWithTimeout(endpoint.href, { timeoutMs, config, env, signal });
  const body = await readResponseText(response, DEFAULT_MAX_BYTES);
  let json;
  try {
    json = JSON.parse(body.text);
  } catch {
    json = {};
  }
  const results = Array.isArray(json.results) ? json.results : [];
  return {
    provider: "searxng",
    query,
    url: endpoint.href,
    results: results.slice(0, maxResults).map((item) => ({
      title: cleanText(item.title),
      url: String(item.url ?? ""),
      snippet: cleanText(item.content ?? item.snippet ?? ""),
      engine: item.engine ?? null
    })).filter((item) => item.title && item.url),
    truncated: results.length > maxResults
  };
}

async function searchDuckDuckGo({ query, maxResults, timeoutMs, config, env, signal }) {
  const endpoint = new URL("https://duckduckgo.com/html/");
  endpoint.searchParams.set("q", query);
  const response = await fetchWithTimeout(endpoint.href, { timeoutMs, config, env, signal });
  const body = await readResponseText(response, DEFAULT_MAX_BYTES);
  const results = parseDuckDuckGoHtml(body.text).slice(0, maxResults);
  return {
    provider: "duckduckgo-html",
    query,
    url: endpoint.href,
    results,
    truncated: body.truncated
  };
}

export function parseDuckDuckGoHtml(html) {
  const text = String(html ?? "");
  const links = Array.from(text.matchAll(/<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi));
  const results = [];
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

function decodeDuckDuckGoUrl(rawUrl) {
  try {
    const url = new URL(rawUrl, "https://duckduckgo.com");
    const uddg = url.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : url.href;
  } catch {
    return rawUrl;
  }
}

function formatFetchedContent(text, format, htmlLike, baseUrl) {
  if (format === "html") {
    return text;
  }
  if (!htmlLike) {
    return text;
  }
  return format === "markdown" ? htmlToMarkdown(text, baseUrl) : cleanText(stripHtml(text));
}

export function htmlToMarkdown(html, baseUrl = "") {
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
    .replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => {
      const cleanLabel = cleanText(stripHtml(label));
      const absolute = resolveUrl(decodeHtml(href), baseUrl);
      return cleanLabel && absolute ? `[${cleanLabel}](${absolute})` : cleanLabel || absolute;
    });
  text = stripHtml(text);
  return cleanMarkdown(text);
}

function stripHtml(value) {
  return decodeHtml(String(value ?? "").replace(/<[^>]+>/g, " "));
}

function cleanMarkdown(value) {
  return decodeHtml(String(value ?? ""))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function cleanText(value) {
  return decodeHtml(String(value ?? ""))
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(value) {
  return String(value ?? "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

async function fetchWithTimeout(url, options) {
  const timeoutController = new AbortController();
  const linked = linkAbortSignals([timeoutController.signal, options.signal]);
  const timer = setTimeout(() => timeoutController.abort(), options.timeoutMs);
  try {
    const proxyUrl = resolveProxyForUrl(url, { config: options.config, env: options.env });
    if (proxyUrl) {
      return await fetchViaHttpProxy(url, {
        proxyUrl,
        signal: linked.signal,
        maxRedirects: MAX_REDIRECTS
      });
    }
    return await fetch(url, {
      signal: linked.signal,
      headers: {
        "user-agent": "ant-code/1.1 local-lab-agent"
      }
    });
  } finally {
    clearTimeout(timer);
    linked.cleanup();
  }
}

/**
 * @param {Array<AbortSignal | undefined>} signals
 */
function linkAbortSignals(signals) {
  const controller = new AbortController();
  const listeners = [];
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };
  for (const signal of signals) {
    if (!signal) {
      continue;
    }
    if (signal.aborted) {
      abort();
      continue;
    }
    signal.addEventListener("abort", abort, { once: true });
    listeners.push(signal);
  }
  return {
    signal: controller.signal,
    cleanup() {
      for (const signal of listeners) {
        signal.removeEventListener("abort", abort);
      }
    }
  };
}

/**
 * @param {string} url
 * @param {{ proxyUrl: string; signal?: AbortSignal; maxRedirects: number }} options
 */
async function fetchViaHttpProxy(url, options) {
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
 * @param {{ proxyUrl: string; signal?: AbortSignal }} options
 */
function requestViaHttpProxy(targetUrl, options) {
  return new Promise((resolve, reject) => {
    const target = new URL(targetUrl);
    const proxy = new URL(options.proxyUrl);
    if (target.protocol === "http:") {
      proxyHttpRequest({ target, proxy, signal: options.signal }).then(resolve, reject);
      return;
    }
    if (target.protocol === "https:") {
      proxyHttpsRequest({ target, proxy, signal: options.signal }).then(resolve, reject);
      return;
    }
    reject(new Error(`Unsupported proxied protocol: ${target.protocol}`));
  });
}

/**
 * @param {{ target: URL; proxy: URL; signal?: AbortSignal }} input
 */
function proxyHttpRequest(input) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: input.proxy.hostname,
      port: input.proxy.port || 80,
      method: "GET",
      path: input.target.href,
      headers: createProxyHeaders(input.target, input.proxy)
    });
    wireRequest(request, input.signal, reject);
    request.on("response", (response) => resolve(toFetchLikeResponse(input.target.href, response)));
    request.end();
  });
}

/**
 * @param {{ target: URL; proxy: URL; signal?: AbortSignal }} input
 */
function proxyHttpsRequest(input) {
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
          "User-Agent: ant-code/1.1 local-lab-agent",
          "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Encoding: identity",
          "Connection: close",
          "",
          ""
        ].join("\r\n"));
      });
      collectRawHttpResponse(input.target.href, tlsSocket).then(resolve, reject);
    });
    request.end();
  });
}

/**
 * @param {import("node:http").ClientRequest} request
 * @param {AbortSignal | undefined} signal
 * @param {(error: Error) => void} reject
 */
function wireRequest(request, signal, reject) {
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
function wireSocketAbort(socket, signal) {
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
 */
function collectRawHttpResponse(url, socket) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    socket.on("data", (chunk) => {
      const buffer = Buffer.from(chunk);
      chunks.push(buffer);
      total += buffer.length;
    });
    socket.once("error", reject);
    socket.once("end", () => {
      try {
        resolve(parseRawHttpResponse(url, Buffer.concat(chunks, total)));
      } catch (error) {
        reject(error);
      }
    });
  });
}

/**
 * @param {string} url
 * @param {Buffer} raw
 */
function parseRawHttpResponse(url, raw) {
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
  const result = new Response(body, {
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
function decodeChunkedBody(raw) {
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
function toFetchLikeResponse(url, response) {
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
function toWebStream(response) {
  return new ReadableStream({
    start(controller) {
      response.on("data", (chunk) => controller.enqueue(Buffer.from(chunk)));
      response.on("end", () => controller.close());
      response.on("error", (error) => controller.error(error));
    },
    cancel() {
      response.destroy();
    }
  });
}

/**
 * @param {import("node:http").IncomingHttpHeaders} headers
 */
function normalizeHeaders(headers) {
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
function createProxyHeaders(target, proxy) {
  return {
    ...createProxyAuthHeader(proxy),
    host: target.host,
    "user-agent": "ant-code/1.1 local-lab-agent",
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-encoding": "identity",
    connection: "close"
  };
}

/**
 * @param {URL} target
 * @param {URL} proxy
 */
function createProxyConnectHeaders(target, proxy) {
  return {
    ...createProxyAuthHeader(proxy),
    host: `${target.hostname}:${target.port || 443}`,
    "user-agent": "ant-code/1.1 local-lab-agent"
  };
}

/**
 * @param {URL} proxy
 */
function createProxyAuthHeader(proxy) {
  if (!proxy.username && !proxy.password) {
    return {};
  }
  const credentials = Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64");
  return { "proxy-authorization": `Basic ${credentials}` };
}

function isRedirect(status) {
  return [301, 302, 303, 307, 308].includes(status);
}

async function readResponseText(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (!maxBytes) {
      return {
        text,
        bytes: Buffer.byteLength(text, "utf8"),
        truncated: false
      };
    }
    return {
      text: text.slice(0, maxBytes),
      bytes: Buffer.byteLength(text, "utf8"),
      truncated: Buffer.byteLength(text, "utf8") > maxBytes
    };
  }

  const chunks = [];
  let bytes = 0;
  let keptBytes = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    const chunk = Buffer.from(value);
    bytes += chunk.length;
    if (!maxBytes) {
      chunks.push(chunk);
      keptBytes += chunk.length;
      continue;
    }
    if (keptBytes < maxBytes) {
      const remaining = maxBytes - keptBytes;
      const kept = chunk.subarray(0, Math.max(0, remaining));
      chunks.push(kept);
      keptBytes += kept.length;
    }
    if (bytes > maxBytes) {
      truncated = true;
      await reader.cancel();
      break;
    }
  }
  return {
    text: Buffer.concat(chunks).toString("utf8"),
    bytes,
    truncated
  };
}

function normalizeUrl(value) {
  const url = normalizeOptionalUrl(value);
  if (!url) {
    throw Object.assign(new Error("url must be an http(s) URL"), { code: "WEB_URL_REQUIRED" });
  }
  return url;
}

function normalizeOptionalUrl(value) {
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

function normalizeFetchFormat(value) {
  const format = String(value ?? "markdown").trim().toLowerCase();
  if (["text", "markdown", "html"].includes(format)) {
    return format;
  }
  return "markdown";
}

function looksLikeHtml(value) {
  return /<\/?[a-z][\s\S]*>/i.test(String(value ?? "").slice(0, 2048));
}

function resolveUrl(href, baseUrl) {
  try {
    return new URL(href, baseUrl || "https://example.invalid").href;
  } catch {
    return href;
  }
}

function dedupeResults(results) {
  const seen = new Set();
  return results.filter((item) => {
    const key = item.url.toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function positiveIntegerOrNull(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}
