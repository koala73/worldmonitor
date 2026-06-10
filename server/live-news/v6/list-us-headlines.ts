/**
 * v6 read endpoint — reads the digest populated by the v6 refresh cron.
 *
 * Wire shape: backward-compatible with v3/v4/v5 so iOS NewsItem decodes
 * unchanged. Adds `imageUrl` (new field — old iOS builds ignore it).
 *
 * No source/link scrub — RSS feeds are publish-meant-for-republishing.
 */

import { getCachedJson } from '../../_shared/redis';
import { liveNewsMaxItemsForVersion } from '../../_shared/feed-limits';
import { DIGEST_KEY } from './refresh';
import type { ClusteredItem } from './_cluster';

export interface ListUsHeadlinesV6Response {
  items: ClusteredItem[];
  feedStatuses: Record<string, 'ok' | 'empty' | 'timeout'>;
  generatedAt: string;
  pendingEnrichment: number;
  /** Always 0 on v6 — no LLM summary path. Kept for wire parity. */
  pendingParaphrase: number;
}

/**
 * Minimum cross-outlet corroboration before a story is shown to iOS.
 * Default 2 — a story shows once ≥2 distinct RSS publishers carry it.
 * Looser than the old ≥3 gate (more volume) but still keeps single-source
 * singletons out of the firehose. Override via `WM_V6_MIN_SOURCES`
 * (`1` shows everything, `3`+ tightens) — see the env caveat below.
 *
 * GDELT sources do NOT count toward this threshold — they're corroboration
 * depth, not trusted publishers. The feed shows the RSS lede only (never an
 * AI summary), so even a lightly-corroborated story is safe to surface.
 *
 * The world-brief live-news section keeps its OWN ≥3 floor (it AI-writes
 * summaries, so it stays corroborated per the copyright rule) — DON'T set
 * `WM_V6_MIN_SOURCES` in the env, as the brief reads the same var and it
 * would lower the AI gate too. Change this code default instead.
 *
 * Applied at READ time, not at digest write — the cron's digest keeps
 * every cluster so a 2-source story can promote on a later refresh as more
 * outlets cover it.
 */
const DEFAULT_MIN_SOURCES = 2;
function minSources(): number {
  const raw = process.env.WM_V6_MIN_SOURCES;
  if (!raw) return DEFAULT_MIN_SOURCES;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_MIN_SOURCES;
}

/** Count distinct RSS publishers in a cluster's sources[]. A source
 *  counts as RSS unless explicitly tagged `origin: 'gdelt'` — so digest
 *  items written before the GDELT layer existed (sources without an
 *  `origin` field) still pass the gate during the post-deploy rollover. */
export function rssSourceCount(item: ClusteredItem): number {
  return (item.sources ?? []).filter((s) => s.origin !== 'gdelt').length;
}

export async function listUsHeadlinesV6(av?: string | null): Promise<ListUsHeadlinesV6Response> {
  // strict=true: a Redis read FAILURE (timeout / network / non-2xx) THROWS
  // instead of masquerading as an empty digest. A genuine key-miss still
  // returns null. This lets the HTTP handler tell "Redis is laggy" apart
  // from "the digest is legitimately empty" — critical because a swallowed
  // timeout would return items:[] with a 200, which the CDN then caches
  // (s-maxage=30, stale-if-error=300) and serves a BLANK feed to an entire
  // edge region. On a throw the handler returns 503 so stale-if-error keeps
  // serving the last good feed instead.
  const stored = ((await getCachedJson(DIGEST_KEY, false, 8_000, true)) as ClusteredItem[] | null) ?? [];

  const min = minSources();
  const filtered = min <= 1
    ? stored
    : stored.filter((it) => rssSourceCount(it) >= min);
  const items = filtered.slice(0, liveNewsMaxItemsForVersion(av));

  const pendingEnrichment = items.filter((it) => it.location === null).length;

  return {
    items,
    feedStatuses: {},
    generatedAt: new Date().toISOString(),
    pendingEnrichment,
    pendingParaphrase: 0,
  };
}
