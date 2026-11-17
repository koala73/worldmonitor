/**
 * Headline history: every headline an edition's digest served, kept for a
 * week so Cmd+K can find one after it has left the dashboard.
 *
 * The dashboard holds only the current digest (20 items per category), and
 * the alert relay titles a news alert with the served digest item's title,
 * verbatim (scripts/lib/digest-stale-gate.cjs). A headline that alerted a few
 * hours ago has usually aged out, so searching the loaded items cannot find
 * it. Not covered here: alerts the relay raises from X accounts, which are
 * not digest items, and items whose link the publisher gate blanked.
 *
 * Storage: one Redis hash per (edition, language, UTC day served).
 *   news:headline-history:v1:<edition>:<lang>:<YYYY-MM-DD>
 *   field = article URL, value = {t,s,l,p,a} (title, source, link,
 *   publishedAt, last served at).
 * Each digest build sends its served items in one HSET, so the write is one
 * command however many items there are, and a rebuild overwrites the same
 * fields. A headline served on three days is in three buckets; the reader
 * keeps its newest copy.
 *
 * Buckets are keyed by the day the headline was SERVED, not published: an
 * alert sent two hours ago can be for an article published thirty hours ago,
 * and the window must still cover it.
 *
 * Size, measured on production 2026-11-17 from the digest accumulators: an
 * edition serves about 1,600 distinct headlines per day in one language
 * (tech/en 1,900), at about 300 bytes each (78 title, 166 link, 12 source,
 * plus JSON). One cell is about 0.5 MB per day, 4.5 MB for the nine days a
 * bucket lives. All 60 cells together serve about 50,000 per day: about
 * 135 MB retained. A 24-hour search reads two buckets (about 1 MB); a 7-day
 * search reads eight (about 4 MB), which is why the read is memoized per
 * isolate and why the window stops at seven days.
 *
 * Revocations: an article an operator revoked (_shared/digest-revocations.ts)
 * is left out of every answer. Only the headlines are memoized. The revoked
 * set is read on every request, and a request whose check fails answers
 * `unavailable`, which the handler marks uncacheable.
 */
import { headlineTitleKey } from '../../../../src/shared/headline-title-key';
import { readRevokedUrlSet } from '../../../_shared/digest-revocations';
import { isRedisConfigured, runRedisPipeline } from '../../../_shared/redis';

export const HEADLINE_HISTORY_FREE_HOURS = 24;
export const HEADLINE_HISTORY_PRO_HOURS = 7 * 24;
export const HEADLINE_SEARCH_MAX_RESULTS = 20;
export const HEADLINE_SEARCH_MIN_QUERY_CHARS = 2;

const DAY_MS = 24 * 60 * 60 * 1000;
/** A bucket outlives the 7-day window by one day for the partial first day, and one more of slack. */
const BUCKET_RETENTION_DAYS = 9;
/** A digest serves at most 20 items in each of about 20 categories. */
const MAX_ITEMS_PER_WRITE = 1000;
const MAX_TITLE_CHARS = 500;
const MAX_SOURCE_CHARS = 200;
const MAX_LINK_CHARS = 2048;
const MAX_QUERY_WORDS = 12;
const INDEX_TTL_MS = 60_000;
const MAX_INDEXES = 6;

type RedisCommand = Array<string | number>;

/** What the digest build hands over for each item it served. */
export interface ServedHeadline {
  title: string;
  source: string;
  /** Already passed the publisher-link gate; an empty link is not indexed. */
  link: string;
  publishedAt: number;
}

export interface HeadlineHistoryEntry {
  title: string;
  source: string;
  link: string;
  publishedAt: number;
  lastServedAt: number;
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function headlineHistoryBucketKey(variant: string, lang: string, atMs: number): string {
  return `news:headline-history:v1:${variant}:${lang}:${utcDay(atMs)}`;
}

/**
 * The Redis commands that record one digest build's served items: one HSET of
 * every indexable item into today's bucket, then the bucket's fixed expiry.
 */
export function buildHeadlineHistoryWrite(
  items: readonly ServedHeadline[],
  variant: string,
  lang: string,
  nowMs: number,
): RedisCommand[] {
  const fields = new Map<string, string>();
  for (const item of items) {
    if (fields.size >= MAX_ITEMS_PER_WRITE) break;
    const title = typeof item.title === 'string' ? item.title.replace(/\s+/g, ' ').trim() : '';
    const link = typeof item.link === 'string' ? item.link : '';
    const source = typeof item.source === 'string' ? item.source.replace(/\s+/g, ' ').trim() : '';
    if (!title || title.length > MAX_TITLE_CHARS || !source || source.length > MAX_SOURCE_CHARS) continue;
    if (!/^https?:\/\//i.test(link) || link.length > MAX_LINK_CHARS) continue;
    if (fields.has(link)) continue;
    fields.set(link, JSON.stringify({
      t: title,
      s: source,
      l: link,
      p: Number.isFinite(item.publishedAt) ? item.publishedAt : 0,
      a: nowMs,
    }));
  }
  if (fields.size === 0) return [];
  const key = headlineHistoryBucketKey(variant, lang, nowMs);
  const dayStartMs = Math.floor(nowMs / DAY_MS) * DAY_MS;
  return [
    ['HSET', key, ...[...fields].flat()],
    ['EXPIREAT', key, Math.floor((dayStartMs + BUCKET_RETENTION_DAYS * DAY_MS) / 1000)],
  ];
}

/**
 * Record one digest build's served items. Returns whether Redis confirmed the
 * write. Keys carry the deployment prefix, so a preview build never writes
 * the production index. A deployment with no Redis (local dev, the desktop
 * sidecar) has no index to fall behind, so there the answer is true.
 */
export async function writeHeadlineHistory(
  items: readonly ServedHeadline[],
  variant: string,
  lang: string,
  nowMs: number,
  timeoutMs?: number,
): Promise<boolean> {
  const commands = buildHeadlineHistoryWrite(items, variant, lang, nowMs);
  if (commands.length === 0) return true;
  if (process.env.LOCAL_API_MODE === 'tauri-sidecar' || !isRedisConfigured()) return true;
  const results = await runRedisPipeline(commands, false, timeoutMs);
  return results.length === commands.length && results.every((result) => !result?.error);
}

interface PoolEntry extends HeadlineHistoryEntry {
  /** headlineTitleKey(title): what the query is matched against. */
  key: string;
}

/**
 * What the window's buckets hold, before operator revocations are applied.
 * This is the part that is memoized; revocations are read on every request.
 */
interface HeadlineIndex {
  readable: boolean;
  /** One entry per article URL, last served first. */
  entries: PoolEntry[];
}

function parseEntry(raw: unknown): PoolEntry | null {
  if (typeof raw !== 'string') return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const { t, s, l, p, a } = value as Record<string, unknown>;
  if (typeof t !== 'string' || typeof s !== 'string' || typeof l !== 'string') return null;
  if (typeof a !== 'number' || !Number.isFinite(a)) return null;
  if (!t || !/^https?:\/\//i.test(l)) return null;
  const key = headlineTitleKey(t);
  if (!key) return null;
  return {
    title: t,
    source: s,
    link: l,
    publishedAt: typeof p === 'number' && Number.isFinite(p) ? p : 0,
    lastServedAt: a,
    key,
  };
}

const UNREADABLE: HeadlineIndex = { readable: false, entries: [] };

async function readIndex(variant: string, lang: string, windowHours: number, nowMs: number): Promise<HeadlineIndex> {
  const cutoff = nowMs - windowHours * 60 * 60 * 1000;
  const keys: string[] = [];
  for (let day = Math.floor(cutoff / DAY_MS); day <= Math.floor(nowMs / DAY_MS); day += 1) {
    keys.push(headlineHistoryBucketKey(variant, lang, day * DAY_MS));
  }
  const results = await runRedisPipeline(keys.map((key) => ['HVALS', key]), false);
  // A short or errored read is not an empty index.
  if (results.length !== keys.length) return UNREADABLE;
  if (results.some((result) => result?.error || !Array.isArray(result?.result))) return UNREADABLE;

  // A headline served on several days is in several buckets: keep the copy
  // served last.
  const byLink = new Map<string, PoolEntry>();
  for (const result of results) {
    for (const raw of result.result as unknown[]) {
      const entry = parseEntry(raw);
      if (!entry || entry.lastServedAt < cutoff) continue;
      const seen = byLink.get(entry.link);
      if (!seen || entry.lastServedAt > seen.lastServedAt) byLink.set(entry.link, entry);
    }
  }
  // Last served first, so a search that walks the entries in order meets the
  // copy to list for a title before its older copies.
  const entries = [...byLink.values()].sort(
    (a, b) => b.lastServedAt - a.lastServedAt || b.publishedAt - a.publishedAt,
  );
  return { readable: true, entries };
}

/**
 * One read per (edition, language, window) serves every query this isolate
 * gets for a minute. Only the headlines are held: which of them an operator
 * has revoked is asked again on every request (searchHeadlineHistory).
 */
const indexes = new Map<string, { at: number; promise: Promise<HeadlineIndex> }>();

function loadIndex(variant: string, lang: string, windowHours: number, nowMs: number): Promise<HeadlineIndex> {
  const id = `${variant}:${lang}:${windowHours}`;
  const cached = indexes.get(id);
  if (cached && nowMs - cached.at >= 0 && nowMs - cached.at < INDEX_TTL_MS) return cached.promise;
  const promise = readIndex(variant, lang, windowHours, nowMs).catch(() => UNREADABLE);
  indexes.delete(id);
  indexes.set(id, { at: nowMs, promise });
  while (indexes.size > MAX_INDEXES) indexes.delete(indexes.keys().next().value as string);
  // A failed read is not reused: the next query reads again.
  void promise.then((index) => {
    if (!index.readable && indexes.get(id)?.promise === promise) indexes.delete(id);
  });
  return promise;
}

/** The query as the words to match, or null when it is too short to search. */
export function headlineQueryWords(query: string): string[] | null {
  const key = headlineTitleKey(query);
  if (key.length < HEADLINE_SEARCH_MIN_QUERY_CHARS) return null;
  return key.split(' ').slice(0, MAX_QUERY_WORDS);
}

export interface HeadlineHistorySearch {
  headlines: HeadlineHistoryEntry[];
  searchedHeadlines: number;
  windowHours: number;
  /** complete | unavailable. Unavailable searched nothing. */
  state: 'complete' | 'unavailable';
  newestServedAt: number;
}

/**
 * Headlines the (edition, language) digest served in the window whose title
 * holds every query word. A title holding the words as one phrase ranks
 * first; within a rank, newest publication first.
 */
export async function searchHeadlineHistory(
  words: readonly string[],
  variant: string,
  lang: string,
  windowHours: number,
  nowMs = Date.now(),
): Promise<HeadlineHistorySearch> {
  // Revocations are read for every request and never memoized: an article an
  // operator pulled a second ago must not be answered from a minute-old view,
  // and a check that failed must fail this request closed.
  const [index, revoked] = await Promise.all([
    loadIndex(variant, lang, windowHours, nowMs),
    readRevokedUrlSet(),
  ]);
  if (!index.readable || !revoked.readable) {
    return { headlines: [], searchedHeadlines: 0, windowHours, state: 'unavailable', newestServedAt: 0 };
  }
  const phrase = words.join(' ');
  const matches: Array<{ entry: PoolEntry; phrase: boolean }> = [];
  // One row per title, so a wire story syndicated under two URLs is listed
  // once. Decided after the revoked URLs are out, so revoking one copy leaves
  // the other listed.
  const titles = new Set<string>();
  let newestServedAt = 0;
  for (const entry of index.entries) {
    if (revoked.urls.has(entry.link) || titles.has(entry.key)) continue;
    titles.add(entry.key);
    if (entry.lastServedAt > newestServedAt) newestServedAt = entry.lastServedAt;
    if (!words.every((word) => entry.key.includes(word))) continue;
    matches.push({ entry, phrase: entry.key.includes(phrase) });
  }
  matches.sort((a, b) =>
    Number(b.phrase) - Number(a.phrase)
    || (b.entry.publishedAt || b.entry.lastServedAt) - (a.entry.publishedAt || a.entry.lastServedAt));
  return {
    headlines: matches.slice(0, HEADLINE_SEARCH_MAX_RESULTS).map(({ entry }) => ({
      title: entry.title,
      source: entry.source,
      link: entry.link,
      publishedAt: entry.publishedAt,
      lastServedAt: entry.lastServedAt,
    })),
    searchedHeadlines: titles.size,
    windowHours,
    state: 'complete',
    newestServedAt,
  };
}

export const __testing__ = {
  resetPools(): void { indexes.clear(); },
};
