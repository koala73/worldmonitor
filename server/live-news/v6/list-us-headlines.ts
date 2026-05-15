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
 * Default 3 — every visible story must have at least 3 distinct outlets
 * covering it. Override at runtime via `WM_V6_MIN_SOURCES` (e.g. set to
 * `1` to disable the filter, `2` to relax, or `4`+ to tighten).
 *
 * Applied at READ time, not at digest write — the cron's digest keeps
 * every cluster so a 2-source story can promote to 3 on a later refresh
 * as more outlets cover it. Without that, breaking-then-corroborated
 * stories would be permanently dropped on their first appearance.
 *
 * Conflict archive (list.ts under conflict-archive/v5) intentionally
 * does NOT apply this filter — conflict events often start with one
 * AP wire and a 3-source minimum would hide real incidents.
 */
const DEFAULT_MIN_SOURCES = 3;
function minSources(): number {
  const raw = process.env.WM_V6_MIN_SOURCES;
  if (!raw) return DEFAULT_MIN_SOURCES;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_MIN_SOURCES;
}

export async function listUsHeadlinesV6(): Promise<ListUsHeadlinesV6Response> {
  const stored = ((await getCachedJson(DIGEST_KEY)) as ClusteredItem[] | null) ?? [];

  const min = minSources();
  const items = min <= 1
    ? stored
    : stored.filter((it) => (it.sources?.length ?? 0) >= min);

  const pendingEnrichment = items.filter((it) => it.location === null).length;

  return {
    items,
    feedStatuses: {},
    generatedAt: new Date().toISOString(),
    pendingEnrichment,
    pendingParaphrase: 0,
  };
}
