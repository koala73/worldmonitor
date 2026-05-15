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

export async function listUsHeadlinesV6(): Promise<ListUsHeadlinesV6Response> {
  const items = ((await getCachedJson(DIGEST_KEY)) as ClusteredItem[] | null) ?? [];

  const pendingEnrichment = items.filter((it) => it.location === null).length;

  return {
    items,
    feedStatuses: {},
    generatedAt: new Date().toISOString(),
    pendingEnrichment,
    pendingParaphrase: 0,
  };
}
