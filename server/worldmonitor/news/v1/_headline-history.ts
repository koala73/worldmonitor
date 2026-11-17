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
const POOL_TTL_MS = 60_000;
const MAX_POOLS = 6;

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

interface HeadlinePool {
  readable: boolean;
  entries: PoolEntry[];
  newestServedAt: number;
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

const UNREADABLE: HeadlinePool = { readable: false, entries: [], newestServedAt: 0 };

async function readPool(variant: string, lang: string, windowHours: number, nowMs: number): Promise<HeadlinePool> {
  const cutoff = nowMs - windowHours * 60 * 60 * 1000;
  const keys: string[] = [];
  for (let day = Math.floor(cutoff / DAY_MS); day <= Math.floor(nowMs / DAY_MS); day += 1) {
    keys.push(headlineHistoryBucketKey(variant, lang, day * DAY_MS));
  }
  const [results, revoked] = await Promise.all([
    runRedisPipeline(keys.map((key) => ['HVALS', key]), false),
    readRevokedUrlSet(),
  ]);
  // Fail closed: nothing goes out unchecked against operator revocations, and
  // a short or errored read is not an empty index.
  if (!revoked.readable || results.length !== keys.length) return UNREADABLE;
  if (results.some((result) => result?.error || !Array.isArray(result?.result))) return UNREADABLE;

  // A headline served on several days is in several buckets: keep the copy
  // served last. Then one row per title, so a wire story syndicated under two
  // URLs is listed once.
  const byLink = new Map<string, PoolEntry>();
  for (const result of results) {
    for (const raw of result.result as unknown[]) {
      const entry = parseEntry(raw);
      if (!entry || entry.lastServedAt < cutoff || revoked.urls.has(entry.link)) continue;
      const seen = byLink.get(entry.link);
      if (!seen || entry.lastServedAt > seen.lastServedAt) byLink.set(entry.link, entry);
    }
  }
  const byTitle = new Map<string, PoolEntry>();
  let newestServedAt = 0;
  for (const entry of byLink.values()) {
    if (entry.lastServedAt > newestServedAt) newestServedAt = entry.lastServedAt;
    const seen = byTitle.get(entry.key);
    if (
      !seen
      || entry.lastServedAt > seen.lastServedAt
      || (entry.lastServedAt === seen.lastServedAt && entry.publishedAt > seen.publishedAt)
    ) byTitle.set(entry.key, entry);
  }
  return { readable: true, entries: [...byTitle.values()], newestServedAt };
}

/** One read per (edition, language, window) serves every query this isolate gets for a minute. */
const pools = new Map<string, { at: number; promise: Promise<HeadlinePool> }>();

function loadPool(variant: string, lang: string, windowHours: number, nowMs: number): Promise<HeadlinePool> {
  const id = `${variant}:${lang}:${windowHours}`;
  const cached = pools.get(id);
  if (cached && nowMs - cached.at >= 0 && nowMs - cached.at < POOL_TTL_MS) return cached.promise;
  const promise = readPool(variant, lang, windowHours, nowMs).catch(() => UNREADABLE);
  pools.delete(id);
  pools.set(id, { at: nowMs, promise });
  while (pools.size > MAX_POOLS) pools.delete(pools.keys().next().value as string);
  // A failed read is not reused: the next query reads again.
  void promise.then((pool) => {
    if (!pool.readable && pools.get(id)?.promise === promise) pools.delete(id);
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
  const pool = await loadPool(variant, lang, windowHours, nowMs);
  if (!pool.readable) {
    return { headlines: [], searchedHeadlines: 0, windowHours, state: 'unavailable', newestServedAt: 0 };
  }
  const phrase = words.join(' ');
  const matches: Array<{ entry: PoolEntry; phrase: boolean }> = [];
  for (const entry of pool.entries) {
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
    searchedHeadlines: pool.entries.length,
    windowHours,
    state: 'complete',
    newestServedAt: pool.newestServedAt,
  };
}

export const __testing__ = {
  resetPools(): void { pools.clear(); },
};
