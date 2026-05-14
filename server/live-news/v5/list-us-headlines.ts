/**
 * `GET /api/live-news/v5/list-us-headlines` — handler core.
 *
 * Reads the Newscatcher-fed accumulator at `live-news:nc:v1:digest`. Wire
 * shape is compatible with v2/v3/v4 so iOS decodes via the existing
 * `NewsItem` model.
 *
 * Source/link are real (Newscatcher licenses the content) — no scrub.
 */

import { getCachedJson } from '../../_shared/redis';
import type { LiveNewsV5Item } from './refresh';

const DIGEST_KEY = 'live-news:nc:v1:digest';

export interface ListUsHeadlinesV5Response {
  items: LiveNewsV5Item[];
  /** Empty on v5 — kept for wire-shape parity with v2/v3/v4. */
  feedStatuses: Record<string, 'ok' | 'empty' | 'timeout'>;
  generatedAt: string;
  pendingEnrichment: number;
  pendingParaphrase: number;
}

export async function listUsHeadlinesV5(): Promise<ListUsHeadlinesV5Response> {
  const items = ((await getCachedJson(DIGEST_KEY)) as LiveNewsV5Item[] | null) ?? [];

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
