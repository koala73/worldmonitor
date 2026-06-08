/**
 * `GET /api/intel-news/v6/list` — handler core for the v6 GDELT-category
 * feeds (cyber, military, nuclear, sanctions, intelligence, maritime,
 * business, scitech, entertainment).
 *
 * Reads `live-news:v6:digest` and returns the clusters the enrich LLM
 * multi-label-classified into ≥1 category (`ClusteredItem.topics`), gated
 * by the category corroboration rule (default: ≥2 outlets + ≥1 RSS, with
 * sparse-category single-RSS exceptions in `isCategoryCorroborated`).
 * Optional `?category=X` pre-filters to one category server-side.
 *
 * The live-news + conflict feeds keep their own endpoints + the ≥3-RSS
 * gate; this endpoint is purely additive.
 */

import { getCachedJson } from '../../_shared/redis';
import { isCategoryCorroborated, type ClusteredItem } from '../../live-news/v6/_cluster';
import { categoryMaxPerTopicForVersion } from '../../_shared/feed-limits';

const DIGEST_KEY = 'live-news:v6:digest';

export interface IntelNewsV6Item {
  id: string;
  source: string;
  title: string;
  link: string;
  publishedAt: number;
  summary: string | null;
  imageUrl: string | null;
  /** Feed membership — multi-label intel-topic tags from the enrich LLM. */
  topics: string[];
  /** GDELT-keyword recall hint (not membership) — kept for debugging. */
  categories: string[];
  isAlert: boolean;
  /** GDELT-supplied incident location — kept for a future map layer. */
  location: { latitude: number; longitude: number } | null;
  locationName: string | null;
  country: string | null;
  region: string | null;
  sources: ClusteredItem['sources'];
}

export interface ListIntelNewsV6Response {
  /** The category filter applied, or null when every category is returned. */
  category: string | null;
  items: IntelNewsV6Item[];
  generatedAt: string;
}

function toItem(c: ClusteredItem): IntelNewsV6Item {
  return {
    id: c.id,
    source: c.source,
    title: c.title,
    link: c.link,
    publishedAt: c.publishedAt,
    summary: c.summary,
    imageUrl: c.imageUrl,
    topics: Array.isArray(c.topics) ? c.topics : [],
    categories: Array.isArray(c.categories) ? c.categories : [],
    isAlert: c.isAlert,
    location: c.location,
    locationName: c.locationName,
    country: c.country,
    region: c.region ?? null,
    sources: c.sources,
  };
}

/**
 * @param category  optional intel-topic id to filter to; null returns
 *                   every category-tagged cluster (each carries its own
 *                   `topics[]` so the client can filter per chip).
 * @param av        optional app version (CFBundleShortVersionString) from the
 *                   `?av=` query — selects the per-version per-topic cap.
 */
export async function listIntelNewsV6(category: string | null, av?: string | null): Promise<ListIntelNewsV6Response> {
  const digest = (await getCachedJson(DIGEST_KEY, false, 3_000)) as ClusteredItem[] | null;
  const all = Array.isArray(digest) ? digest : [];

  const filtered = all
    .filter(
      (c) =>
        c &&
        Array.isArray(c.topics) &&
        c.topics.length > 0 &&
        (!category || c.topics.includes(category)) &&
        isCategoryCorroborated(c),
    )
    .sort((a, b) => b.publishedAt - a.publishedAt);

  // Per-topic cap (newest-first). For each topic keep at most N clusters; the
  // response is the union, so a cluster tagged with several topics is counted
  // toward each. Thin topics (cyber/nuclear/…) keep all their items.
  const perTopic = categoryMaxPerTopicForVersion(av);
  let capped = filtered;
  if (Number.isFinite(perTopic)) {
    const topics = category ? [category] : [...new Set(filtered.flatMap((c) => c.topics ?? []))];
    const keep = new Set<string>();
    for (const t of topics) {
      let n = 0;
      for (const c of filtered) {
        if (n >= perTopic) break;
        if ((c.topics ?? []).includes(t)) { keep.add(c.id); n++; }
      }
    }
    capped = filtered.filter((c) => keep.has(c.id));
  }

  const items = capped.map(toItem);

  console.log(
    `[intel-news:v6:list] category=${category ?? 'all'} digest=${all.length} → ${items.length} items (perTopicCap=${perTopic})`,
  );

  return { category, items, generatedAt: new Date().toISOString() };
}
