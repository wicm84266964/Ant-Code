import { loadConfig } from "../../config/load-config.ts";
import { createSessionStore } from "../../storage/session-store.ts";
import type { DashboardFactoryState } from "./factory-state.ts";
import {
  activeTranscriptMessages,
  messageContentText,
  readStoredTranscriptPage
} from "./session-records.ts";
import { isPlainObject } from "./util.ts";

export const CONTENT_SEARCH_MAX_QUERY = 200;
export const CONTENT_SEARCH_MAX_HITS = 30;
export const CONTENT_SEARCH_MAX_HITS_PER_SESSION = 3;
export const CONTENT_SEARCH_MAX_PAGES = 40;
export const CONTENT_SEARCH_PAGE_LIMIT = 200;

export type ContentSearchHit = {
  sessionId: string;
  title: string;
  role: "user" | "assistant";
  excerpt: string;
  position: number;
};

export type ContentSearchResult = {
  ok: true;
  query: string;
  hits: ContentSearchHit[];
  unreadable: number;
  truncated: boolean;
};

export function normalizeContentSearchQuery(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function contentSearchExcerpt(text: string, query: string, radius = 42) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  const needle = normalizeContentSearchQuery(query).toLowerCase();
  const at = clean.toLowerCase().indexOf(needle);
  if (!needle || at < 0) {
    return clean.slice(0, radius * 2);
  }
  const start = Math.max(0, at - radius);
  const end = Math.min(clean.length, at + needle.length + radius);
  return `${start > 0 ? "…" : ""}${clean.slice(start, end)}${end < clean.length ? "…" : ""}`;
}

export function collectContentSearchHits(messages: unknown, query: string, options: { sessionId: string; title: string; limit?: number; positionOffset?: number; positions?: number[] }) {
  const needle = normalizeContentSearchQuery(query).toLowerCase();
  const hits: ContentSearchHit[] = [];
  const limit = options.limit ?? CONTENT_SEARCH_MAX_HITS_PER_SESSION;
  const list = Array.isArray(messages) ? messages : [];
  for (let index = 0; index < list.length && hits.length < limit; index += 1) {
    const message = list[index];
    if (!isPlainObject(message) || message.thinkingProcess === true || message.interruptedDraft === true) {
      continue;
    }
    const role = message.role === "assistant" ? "assistant" : message.role === "user" ? "user" : null;
    if (!role) {
      continue;
    }
    const text = messageContentText(message.content);
    if (!text.toLowerCase().includes(needle)) {
      continue;
    }
    hits.push({
      sessionId: options.sessionId,
      title: options.title,
      role,
      excerpt: contentSearchExcerpt(text, query),
      position: Number.isInteger(options.positions?.[index])
        ? Number(options.positions?.[index])
        : (options.positionOffset ?? 0) + index
    });
  }
  return hits;
}

function pageCursor(page: { summary?: { cursor?: unknown; nextCursor?: unknown; hasMore?: unknown } }) {
  const cursor = page.summary?.cursor ?? page.summary?.nextCursor;
  return page.summary?.hasMore === true && cursor !== undefined && cursor !== null && String(cursor) !== ""
    ? String(cursor)
    : null;
}

async function searchStoredSession(store: ReturnType<typeof createSessionStore>, record: { id?: unknown; title?: unknown; prompt?: unknown }, query: string, budget: { pages: number }) {
  const id = String(record.id ?? "");
  const title = String(record.title || record.prompt || "未命名任务");
  const metadata = await store.readMetadata(id);
  if (!metadata.ok || !metadata.metadata) {
    return { hits: [] as ContentSearchHit[], unreadable: true, truncated: false };
  }
  const hits: ContentSearchHit[] = [];
  let before: string | null = null;
  const seen = new Set<string>();
  let truncated = false;
  for (let pageIndex = 0; pageIndex < 12 && hits.length < CONTENT_SEARCH_MAX_HITS_PER_SESSION; pageIndex += 1) {
    if (budget.pages >= CONTENT_SEARCH_MAX_PAGES) {
      truncated = true;
      break;
    }
    budget.pages += 1;
    const page = await readStoredTranscriptPage(store, metadata.metadata, {
      before,
      limit: CONTENT_SEARCH_PAGE_LIMIT
    });
    if (!page.ok) {
      return { hits, unreadable: true, truncated };
    }
    const positions = Array.isArray(page.positions) ? page.positions : [];
    const summary = isPlainObject(page.summary) ? page.summary : {};
    const offset = Number.isInteger(positions[0]) ? Number(positions[0]) : Number(summary.start ?? 0);
    hits.push(...collectContentSearchHits(page.messages, query, {
      sessionId: id,
      title,
      limit: CONTENT_SEARCH_MAX_HITS_PER_SESSION - hits.length,
      positionOffset: Number.isFinite(offset) ? offset : 0,
      positions: positions.map((value) => Number(value)).filter((value) => Number.isInteger(value))
    }));
    const next = pageCursor(page);
    if (!next || seen.has(next)) {
      break;
    }
    seen.add(next);
    before = next;
  }
  return { hits, unreadable: false, truncated };
}

export async function runtimeSearchSessionContent(ctx: DashboardFactoryState, queryValue: unknown): Promise<ContentSearchResult | { ok: false; status: number; error: string }> {
  const query = normalizeContentSearchQuery(queryValue);
  if (!query) {
    return { ok: true, query: "", hits: [], unreadable: 0, truncated: false };
  }
  if (query.length > CONTENT_SEARCH_MAX_QUERY) {
    return { ok: false, status: 400, error: "搜索词过长" };
  }
  const configEnv = await ctx.resolveConfigEnv();
  const config = await loadConfig({ cwd: ctx.cwd, env: configEnv });
  const store = createSessionStore({ cwd: ctx.cwd, transcript: config.transcript, env: ctx.runtimeEnv });
  const records = await store.listSessionRecords();
  const hits: ContentSearchHit[] = [];
  let unreadable = 0;
  let truncated = records.length > 120;
  const budget = { pages: 0 };
  for (const record of records.slice(0, 120)) {
    if (hits.length >= CONTENT_SEARCH_MAX_HITS) {
      truncated = true;
      break;
    }
    const id = String(record.id ?? "");
    if (!id || record.readable === false) {
      unreadable += 1;
      continue;
    }
    const active = ctx.active.get(id);
    if (active) {
      hits.push(...collectContentSearchHits(activeTranscriptMessages(active), query, {
        sessionId: id,
        title: String(record.title || record.prompt || "未命名任务"),
        limit: Math.min(CONTENT_SEARCH_MAX_HITS_PER_SESSION, CONTENT_SEARCH_MAX_HITS - hits.length)
      }));
      continue;
    }
    const found = await searchStoredSession(store, record, query, budget);
    if (found.unreadable) {
      unreadable += 1;
    }
    truncated = truncated || found.truncated;
    hits.push(...found.hits.slice(0, CONTENT_SEARCH_MAX_HITS - hits.length));
  }
  return {
    ok: true,
    query,
    hits: hits.slice(0, CONTENT_SEARCH_MAX_HITS),
    unreadable,
    truncated
  };
}
