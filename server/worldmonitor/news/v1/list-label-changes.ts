import type {
  LabelChange,
  ListLabelChangesRequest,
  ListLabelChangesResponse,
  ServerContext,
} from '../../../../src/generated/server/worldmonitor/news/v1/service_server';
import { runRedisPipeline } from '../../../_shared/redis';
import { readRevokedUrlSet } from '../../../_shared/digest-revocations';
import { markNoCacheResponse } from '../../../_shared/response-headers';
import {
  LABEL_CHANGES_KEY,
  LABEL_COUNTS_KEY,
  LABEL_HISTORY_RETENTION_MS,
  STORY_LABEL_HISTORY_KEY,
  parseLabelChange,
  parseLabelCounts,
} from '../../../_shared/label-history';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const RETENTION_DAYS = LABEL_HISTORY_RETENTION_MS / (24 * 60 * 60 * 1000);

/**
 * #9093: recent corroboration label changes, newest first. An unreadable log is
 * `unavailable` with no changes and is not cached, so a Redis blip is never
 * served as "nothing changed".
 */
export async function listLabelChanges(
  ctx: ServerContext,
  req: ListLabelChangesRequest,
): Promise<ListLabelChangesResponse> {
  const storyId = req.storyId.trim().toLowerCase();
  const response: ListLabelChangesResponse = { changes: [], state: 'unavailable', retentionDays: RETENTION_DAYS };
  if (storyId !== '' && !/^[0-9a-f]{64}$/.test(storyId)) {
    response.state = 'ok';
    return response;
  }
  const limit = req.limit > 0 ? Math.min(Math.floor(req.limit), MAX_LIMIT) : DEFAULT_LIMIT;
  const key = storyId ? STORY_LABEL_HISTORY_KEY(storyId) : LABEL_CHANGES_KEY;
  const [results, revoked] = await Promise.all([
    runRedisPipeline([['LRANGE', key, 0, limit - 1], ['GET', LABEL_COUNTS_KEY]]),
    readRevokedUrlSet(),
  ]);
  const rows = results[0]?.result;
  if (results.length === 0 || results[0]?.error || (rows !== null && !Array.isArray(rows))) {
    markNoCacheResponse(ctx.request);
    return response;
  }
  const now = Date.now();
  const counts = parseLabelCounts(results[1]?.result, now);
  if (counts) response.counts = counts;
  for (const raw of Array.isArray(rows) ? rows : []) {
    const entry = parseLabelChange(raw, now);
    if (!entry) continue;
    // A link revoked after the change was recorded is not served (#7084);
    // the entry stays, because the label change itself still happened.
    const link = revoked.readable && !revoked.urls.has(entry.link) ? entry.link : '';
    const change: LabelChange = {
      storyId: entry.storyId,
      field: entry.field,
      previous: entry.previous,
      next: entry.next,
      previousPublishers: entry.previousPublishers,
      nextPublishers: entry.nextPublishers,
      at: entry.at,
      trigger: entry.trigger,
      reason: entry.reason,
      sources: entry.sources.map((source) => ({ name: source.name, tier: source.tier ?? 0 })),
      title: entry.title,
      link,
      credibilityScore: entry.credibilityScore ?? -1,
    };
    response.changes.push(change);
  }
  response.state = 'ok';
  if (!revoked.readable) markNoCacheResponse(ctx.request);
  return response;
}
