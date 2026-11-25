import type { NewsItem } from '@/types';
import { NewsServiceClient } from '@/services/generated-rpc-clients';
import { getRpcBaseUrl } from '@/services/rpc-client';
import { protoItemToNewsItem } from '@/services/news-digest-items';
import { effectivePubDateMs } from '@/services/feed-date';
import { createRequestTimeoutSignal } from '@/services/timeout-signal';

// A digest category keeps its top items across every feed it carries, so a
// panel whose user turned sources off can be left with enabled sources that
// have no item in it (#9796). These helpers find those sources and fill the
// panel's free slots from their cached feed rows (ListSourceItems), which the
// server reads from cache only.

/** The server's per-request cap (list_source_items.proto). */
export const SOURCE_FILL_MAX_SOURCES = 24;
const SOURCE_FILL_TIMEOUT_MS = 5_000;

/**
 * Enabled, digest-served sources with no item among the items the digest
 * delivered for the category, in panel order, at most the server's cap.
 */
export function sourcesBelowCap(delivered: readonly NewsItem[], servedSources: readonly string[]): string[] {
  const present = new Set(delivered.map(item => item.source));
  return [...new Set(servedSources)].filter(source => !present.has(source)).slice(0, SOURCE_FILL_MAX_SOURCES);
}

/**
 * Keeps every item in `base`, then fills up to `limit` from `extra`, one item
 * per source per round, newest first within each source. The result is newest
 * first, like the digest.
 */
export function fillFreeSlots(base: readonly NewsItem[], extra: readonly NewsItem[], limit: number): NewsItem[] {
  const seen = new Set(base.map(item => item.link || `${item.source}|${item.title}`));
  const bySource = new Map<string, NewsItem[]>();
  for (const item of extra) {
    const key = item.link || `${item.source}|${item.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const bucket = bySource.get(item.source);
    if (bucket) bucket.push(item);
    else bySource.set(item.source, [item]);
  }
  const newestFirst = (a: NewsItem, b: NewsItem) => effectivePubDateMs(b) - effectivePubDateMs(a);
  const buckets = [...bySource.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, items]) => items.sort(newestFirst));
  const selected = [...base];
  for (let depth = 0; selected.length < limit && buckets.some(bucket => depth < bucket.length); depth += 1) {
    for (const bucket of buckets) {
      if (selected.length >= limit) break;
      const item = bucket[depth];
      if (item) selected.push(item);
    }
  }
  return selected.sort(newestFirst);
}

export type SourceItemsClient = Pick<InstanceType<typeof NewsServiceClient>, 'listSourceItems'>;

let client: SourceItemsClient | null = null;

/**
 * The deadline starts when the request is sent, not when the fill is asked
 * for: the client's code loads on first use, and on a throttled phone that
 * load plus the main-thread work before the send took 4s of a 5s budget set
 * at the call, so every fill timed out just before its response arrived.
 */
export function createSourceItemsClient(Client: typeof NewsServiceClient = NewsServiceClient): SourceItemsClient {
  return new Client(getRpcBaseUrl(), {
    fetch: (input, init) => globalThis.fetch(input, {
      ...init,
      signal: createRequestTimeoutSignal(input, init, SOURCE_FILL_TIMEOUT_MS),
    }),
  });
}

/**
 * Cached items of `sources` in `category`, read from the first of `editions`
 * whose `language` digest fetches each one. An error yields no items: the
 * panel keeps what the digest gave it.
 */
export async function fetchSourceItems(
  editions: readonly string[],
  category: string,
  sources: readonly string[],
  language: string,
  sourceClient: SourceItemsClient = (client ??= createSourceItemsClient()),
): Promise<NewsItem[]> {
  if (sources.length === 0) return [];
  try {
    const response = await sourceClient.listSourceItems(
      { editions: [...editions], category, sources: [...sources].sort(), lang: language },
    );
    return response.items.map(protoItemToNewsItem);
  } catch (error) {
    // String(): a DOMException serializes to {} in console captures.
    console.warn(`[News] source rows for ${category} unavailable:`, String(error));
    return [];
  }
}
