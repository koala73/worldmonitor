/**
 * v6 read endpoint — reads the digest populated by the v6 refresh cron.
 *
 * Wire shape: backward-compatible with v3/v4/v5 so iOS NewsItem decodes
 * unchanged. Adds `imageUrl` (new field — old iOS builds ignore it).
 *
 * No source/link scrub — RSS feeds are publish-meant-for-republishing.
 */

import { getCachedJson } from '../../_shared/redis';
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
 * Default 3 — every visible story must have at least 3 distinct
 * **RSS** publishers covering it. Override at runtime via
 * `WM_V6_MIN_SOURCES` (`1` disables the filter, `2` relaxes, `4`+ tightens).
 *
 * GDELT sources do NOT count toward this threshold — they're
 * corroboration depth, not trusted publishers. A cluster with 2 RSS +
 * 40 GDELT sources still fails a min-3 gate. This is what stops
 * GDELT's volume from spoiling feed quality.
 *
 * Applied at READ time, not at digest write — the cron's digest keeps
 * every cluster so a 2-source story can promote to 3 on a later refresh
 * as more outlets cover it. Without that, breaking-then-corroborated
 * stories would be permanently dropped on their first appearance.
 */
const DEFAULT_MIN_SOURCES = 3;
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

export async function listUsHeadlinesV6(): Promise<ListUsHeadlinesV6Response> {
  const stored = ((await getCachedJson(DIGEST_KEY)) as ClusteredItem[] | null) ?? [];

  const min = minSources();
  const items = min <= 1
    ? stored
    : stored.filter((it) => rssSourceCount(it) >= min);

  const pendingEnrichment = items.filter((it) => it.location === null).length;

  return {
    items,
    feedStatuses: {},
    generatedAt: new Date().toISOString(),
    pendingEnrichment,
    pendingParaphrase: 0,
  };
}
