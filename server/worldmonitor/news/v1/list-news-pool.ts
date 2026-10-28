/**
 * ListNewsPool: the warmed digests for several editions and content
 * languages, merged into one list with one item per article URL.
 *
 * It reads `news:digest:v1:<edition>:<lang>` cells the relay's warm cycle
 * keeps fresh and never builds one, so a widened read costs cache reads, not
 * feed fetches. A cell with no fresh body falls back to its last-good snapshot
 * inside the same six-hour window the digest serves; a cell with neither is
 * reported missing, and the response is partial rather than quietly short.
 *
 * Each item's language is its outlet's content language, not the cell's: a
 * feed with no `lang` is fetched by every language cell, so a cell's copy of
 * those feeds is dropped unless their language was requested. The layout
 * records which content languages each cell is the only source of, and only
 * those cells are read. Titles are publisher text, untranslated.
 */
import type {
  ListFeedDigestResponse,
  ListNewsPoolRequest,
  ListNewsPoolResponse,
  NewsItem,
  NewsPoolCell,
  NewsPoolItem,
  ServerContext,
} from '../../../../src/generated/server/worldmonitor/news/v1/service_server';
import { ValidationError } from '../../../../src/generated/server/worldmonitor/news/v1/service_server';
import { readCachedJson } from '../../../_shared/redis';
import { getOutletProfile } from '../../../_shared/outlet-profile';
import { NEWS_POOL_LAYOUT } from '../../../../shared/news-pool-layout.generated';
import { classifyStaleSnapshot, isAcceptableDigest } from './_lastgood';
import { readAcceptedSnapshot, readRevokedUrlSet } from './_lastgood-store';
import { INTEL_SOURCES, VARIANT_FEEDS } from './_feeds';
import { suppressRevoked } from './list-feed-digest';

export const NEWS_POOL_MAX_LANGUAGES = 8;

/** Feed language by source name: the language a feed is fetched for (none = English). */
const FEED_LANGUAGE: ReadonlyMap<string, string> = new Map(
  [...Object.values(VARIANT_FEEDS).flatMap((byCategory) => Object.values(byCategory).flat()), ...INTEL_SOURCES]
    .map((feed) => [feed.name, feed.lang ?? 'en'] as const),
);

/** Content language of a source: its reviewed outlet profile, else its feed's. */
export function sourceLanguage(source: string): string {
  return getOutletProfile(source)?.language ?? FEED_LANGUAGE.get(source) ?? 'en';
}

interface PoolQuery {
  languages: string[];
  editions: string[];
  category: string;
}

function canonicalQuery(req: ListNewsPoolRequest): PoolQuery {
  const languages = [...new Set(req.languages.map((lang) => lang.trim().toLowerCase()).filter(Boolean))];
  if (languages.length > NEWS_POOL_MAX_LANGUAGES || languages.some((lang) => !NEWS_POOL_LAYOUT.languages.includes(lang))) {
    throw new ValidationError([{
      field: 'languages',
      description: `Use at most ${NEWS_POOL_MAX_LANGUAGES} of: ${NEWS_POOL_LAYOUT.languages.join(', ')}`,
    }]);
  }
  const editionOrder = Object.keys(NEWS_POOL_LAYOUT.editions);
  const requested = new Set(req.editions.map((edition) => edition.trim().toLowerCase()).filter(Boolean));
  if ([...requested].some((edition) => !editionOrder.includes(edition))) {
    throw new ValidationError([{ field: 'editions', description: `Use editions from: ${editionOrder.join(', ')}` }]);
  }
  const editions = requested.size > 0 ? editionOrder.filter((edition) => requested.has(edition)) : ['full'];
  const category = req.category.trim();
  if (category && !editions.some((edition) => NEWS_POOL_LAYOUT.editions[edition]!.includes(category))) {
    throw new ValidationError([{ field: 'category', description: `Not a category of ${editions.join(', ')}` }]);
  }
  return { languages: languages.length > 0 ? languages.sort() : ['en'], editions, category };
}

type CellRead =
  | { state: 'complete' | 'partial' | 'stale'; data: ListFeedDigestResponse; staleAgeSeconds: number }
  | { state: 'missing' };

async function readCell(edition: string, lang: string, nowMs: number): Promise<CellRead> {
  const fresh = await readCachedJson(`news:digest:v1:${edition}:${lang}`);
  if (fresh.status === 'hit' && isAcceptableDigest(fresh.value as ListFeedDigestResponse)) {
    const data = fresh.value as ListFeedDigestResponse;
    return { state: data.coverage?.state === 'partial' ? 'partial' : 'complete', data, staleAgeSeconds: 0 };
  }
  const stored = await readAcceptedSnapshot<ListFeedDigestResponse>(edition, lang);
  const verdict = classifyStaleSnapshot(stored.snapshot, nowMs);
  if (!verdict.serve || !stored.snapshot) return { state: 'missing' };
  return { state: 'stale', data: stored.snapshot.data, staleAgeSeconds: verdict.ageSeconds };
}

function unavailable(at: string, cells: NewsPoolCell[]): ListNewsPoolResponse {
  return { items: [], cells, state: 'unavailable', generatedAt: at };
}

export async function listNewsPool(
  _ctx: ServerContext,
  req: ListNewsPoolRequest,
): Promise<ListNewsPoolResponse> {
  const query = canonicalQuery(req);
  const nowMs = Date.now();
  const at = new Date(nowMs).toISOString();
  const wanted = NEWS_POOL_LAYOUT.cells.filter((cell) => query.editions.includes(cell.edition)
    && cell.contentLanguages.some((lang) => query.languages.includes(lang)));
  const [revoked, reads] = await Promise.all([
    readRevokedUrlSet(),
    Promise.all(wanted.map((cell) => readCell(cell.edition, cell.lang, nowMs))),
  ]);
  const missingCells = wanted.map((cell) => ({
    edition: cell.edition, language: cell.lang, state: 'missing', items: 0, staleAgeSeconds: 0, generatedAt: '',
  }));
  // Fail closed: no item goes out unchecked against operator revocations.
  if (!revoked.readable) return unavailable(at, missingCells);

  const editionOrder = Object.keys(NEWS_POOL_LAYOUT.editions);
  const byKey = new Map<string, { entry: NewsPoolItem; home: boolean }>();
  const cells: NewsPoolCell[] = wanted.map((cell, index) => {
    const read = reads[index]!;
    if (read.state === 'missing') return missingCells[index]!;
    const { data } = suppressRevoked(read.data, revoked.urls);
    let contributed = 0;
    for (const [category, bucket] of Object.entries(data.categories ?? {})) {
      if (query.category && category !== query.category) continue;
      for (const item of (bucket?.items ?? []) as NewsItem[]) {
        if (!item?.title || !item.source) continue;
        const language = sourceLanguage(item.source);
        if (!query.languages.includes(language)) continue;
        contributed += 1;
        const key = item.link || `${item.source}|${item.title}`;
        const home = (FEED_LANGUAGE.get(item.source) ?? 'en') === cell.lang;
        const seen = byKey.get(key);
        if (!seen) {
          byKey.set(key, { entry: { item, language, editions: [cell.edition], category }, home });
          continue;
        }
        if (!seen.entry.editions.includes(cell.edition)) seen.entry.editions.push(cell.edition);
        // Prefer the copy from the cell the feed is fetched for: a feed with
        // no `lang` rides along in every language cell, but its own (English)
        // cell is the one the dashboard shows.
        if (home && !seen.home) {
          seen.entry.item = item;
          seen.entry.category = category;
          seen.home = true;
        }
      }
    }
    return {
      edition: cell.edition,
      language: cell.lang,
      state: read.state,
      items: contributed,
      staleAgeSeconds: read.staleAgeSeconds,
      generatedAt: data.generatedAt ?? '',
    };
  });

  const items = [...byKey.values()].map(({ entry }) => {
    entry.editions.sort((a, b) => editionOrder.indexOf(a) - editionOrder.indexOf(b));
    return entry;
  }).sort((a, b) => (Number(b.item?.publishedAt) || 0) - (Number(a.item?.publishedAt) || 0));

  const served = cells.filter((cell) => cell.state !== 'missing');
  if (wanted.length > 0 && served.length === 0) return unavailable(at, cells);
  const state = cells.some((cell) => cell.state === 'missing' || cell.state === 'partial')
    ? 'partial'
    : cells.some((cell) => cell.state === 'stale') ? 'stale' : 'complete';
  return { items, cells, state, generatedAt: at };
}
