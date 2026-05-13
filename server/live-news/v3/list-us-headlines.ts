/**
 * `GET /api/live-news/v3/list-us-headlines` — handler core.
 *
 * v3 reads the accumulator written by the World News API cron at
 * `/api/live-news/v3/refresh-worldnews`. Pure Redis read — no upstream
 * call on the user-traffic path. Sub-100 ms typical.
 *
 * # Response shape
 *
 * Wire-compatible with v2 (`ListUsHeadlinesV2Response`) — same field
 * names and types so the iOS NewsItem decoder works against both
 * endpoints. The only meaningful difference: v3 ships real `source`
 * and `link` values (paid licensed feed, no need to shadow outlet
 * identity).
 *
 * # Caching
 *
 *   Top-level digest:  live-news:wn:v1:digest  (written by the cron)
 *   Edge cache:        s-maxage=30, swr=60, sie=300  — same as v2.
 *
 * # Failure mode
 *
 *   Empty accumulator returns `{ items: [], ... }` with status 200 so
 *   the iOS feed renders an empty state rather than an error. This
 *   matches v2's behavior.
 */

import { getCachedJson } from '../../_shared/redis';
import type { LiveNewsV3Item } from './refresh';

const DIGEST_KEY = 'live-news:wn:v1:digest';

export interface ListUsHeadlinesV3Response {
  items: LiveNewsV3Item[];
  /** Empty on v3 — kept for wire-shape parity with v2. */
  feedStatuses: Record<string, 'ok' | 'empty' | 'timeout'>;
  generatedAt: string;
  /** Diagnostic — how many items lacked a cached location at read time. */
  pendingEnrichment: number;
  /** Diagnostic — mirrored for iOS Codable compatibility (combined enrichment). */
  pendingParaphrase: number;
}

export async function listUsHeadlinesV3(): Promise<ListUsHeadlinesV3Response> {
  const items = ((await getCachedJson(DIGEST_KEY)) as LiveNewsV3Item[] | null) ?? [];

  // Count items still missing enrichment so iOS can show "pending" diagnostics
  // (same field semantics as v2 — gives the client a heads-up that more
  // location/summary data is on the way).
  const pendingEnrichment = items.filter((it) => it.location === null).length;
  const pendingParaphrase = items.filter((it) => it.summary === null).length;

  return {
    items,
    feedStatuses: {},
    generatedAt: new Date().toISOString(),
    pendingEnrichment,
    pendingParaphrase,
  };
}
