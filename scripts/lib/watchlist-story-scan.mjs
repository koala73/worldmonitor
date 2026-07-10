import { createHash } from 'node:crypto';

import { buildDedupMaterial } from '../shared/notification-dedup.cjs';
import { buildWatchlistStoryEvents, resolveWatchlistScoreMin, WATCHLIST_STORY_EVENT_TYPE } from './watchlist-story-events.mjs';

export const WATCHLIST_SCAN_DEDUP_TTL_SECONDS = 24 * 60 * 60;
const WATCHLIST_SCAN_WINDOW_MS = 24 * 60 * 60 * 1000;
const WATCHLIST_SCAN_ACCUMULATORS = [
  'digest:accumulator:v1:full:en',
  'digest:accumulator:v1:finance:en',
];

function flatArrayToObject(flat) {
  const obj = Object.create(null);
  if (!Array.isArray(flat)) return obj;
  for (let i = 0; i + 1 < flat.length; i += 2) {
    obj[flat[i]] = flat[i + 1];
  }
  return obj;
}

export async function publishWatchlistNotificationEvent(
  { eventType, payload, severity, dedupTtl = WATCHLIST_SCAN_DEDUP_TTL_SECONDS },
  { upstashRest, nowMs = () => Date.now(), logger = console } = {},
) {
  if (typeof upstashRest !== 'function') throw new Error('upstashRest dependency is required');
  const dedupMaterial = buildDedupMaterial(eventType, payload?.title, payload?.coalesceKey);
  const dedupHash = createHash('sha256').update(dedupMaterial).digest('hex').slice(0, 16);
  const dedupKey = `wm:notif:scan-dedup:${eventType}:${dedupHash}`;
  const isNew = (await upstashRest('SET', dedupKey, '1', 'NX', 'EX', String(dedupTtl))) === 'OK';
  if (!isNew) return false;
  const msg = JSON.stringify({ eventType, payload, severity, publishedAt: nowMs() });
  let pushed;
  try {
    pushed = await upstashRest('LPUSH', 'wm:events:queue', msg);
  } catch (err) {
    logger.warn?.(`[digest] watchlist LPUSH failed for ${eventType} - rolling back dedup key: ${err?.message ?? err}`);
    try { await upstashRest('DEL', dedupKey); } catch {}
    return false;
  }
  if (typeof pushed !== 'number') {
    logger.warn?.(`[digest] watchlist LPUSH failed for ${eventType} - rolling back dedup key`);
    try { await upstashRest('DEL', dedupKey); } catch {}
    return false;
  }
  logger.log?.(
    `[digest] watchlist queued ${severity} ${eventType}: ` +
      `${String(payload?.title ?? '').slice(0, 60)} tickers=${(payload?.tickers ?? []).join(',')}`,
  );
  return true;
}

export async function scanAndEnqueueWatchlistStoryEvents(nowMs, {
  env = process.env,
  upstashRest,
  upstashPipeline,
  readStoryTracksChunked,
  tickerDictionary,
  publishNotificationEvent,
  logger = console,
  accumulators = WATCHLIST_SCAN_ACCUMULATORS,
  scanWindowMs = WATCHLIST_SCAN_WINDOW_MS,
} = {}) {
  try {
    if (typeof upstashRest !== 'function') throw new Error('upstashRest dependency is required');
    if (typeof upstashPipeline !== 'function') throw new Error('upstashPipeline dependency is required');
    if (typeof readStoryTracksChunked !== 'function') throw new Error('readStoryTracksChunked dependency is required');

    const scoreMin = resolveWatchlistScoreMin(env);
    const windowStart = String(nowMs - scanWindowMs);
    const seenHashes = new Set();
    const hashes = [];
    const memberLists = await Promise.all(
      accumulators.map((accKey) =>
        upstashRest('ZRANGEBYSCORE', accKey, windowStart, String(nowMs)),
      ),
    );
    for (const members of memberLists) {
      if (!Array.isArray(members)) continue;
      for (const h of members) {
        if (typeof h === 'string' && h.length > 0 && !seenHashes.has(h)) {
          seenHashes.add(h);
          hashes.push(h);
        }
      }
    }
    if (hashes.length === 0) return { hashes: 0, candidates: 0, events: 0, enqueued: 0, scoreMin };

    const trackResults = await readStoryTracksChunked(hashes, upstashPipeline);
    if (trackResults === null) {
      logger.warn?.('[digest] watchlist scan: story-track read failed - skipping this tick');
      return { hashes: hashes.length, candidates: 0, events: 0, enqueued: 0, scoreMin, skipped: 'track_read_failed' };
    }

    const candidates = [];
    for (let i = 0; i < hashes.length; i++) {
      const raw = trackResults[i]?.result;
      if (!Array.isArray(raw) || raw.length === 0) continue;
      const track = flatArrayToObject(raw);
      if (!track.title) continue;
      const currentScore = parseInt(track.currentScore ?? '0', 10);
      if (!Number.isFinite(currentScore) || currentScore < scoreMin) continue;
      candidates.push({
        hash: hashes[i],
        title: track.title,
        description: typeof track.description === 'string' ? track.description : '',
        link: track.link ?? '',
        source: '',
        currentScore,
      });
    }
    if (candidates.length === 0) return { hashes: hashes.length, candidates: 0, events: 0, enqueued: 0, scoreMin };

    const eventEntries = [];
    for (const candidate of candidates) {
      for (const event of buildWatchlistStoryEvents([candidate], tickerDictionary, scoreMin)) {
        eventEntries.push({ event, sourceKey: `story:sources:v1:${candidate.hash}` });
      }
    }

    if (eventEntries.length > 0) {
      try {
        const srcResults = await upstashPipeline(
          eventEntries.map(({ sourceKey }) => ['SMEMBERS', sourceKey]),
        );
        for (let i = 0; i < eventEntries.length; i++) {
          const arr = srcResults[i]?.result;
          if (Array.isArray(arr) && typeof arr[0] === 'string') eventEntries[i].event.payload.source = arr[0];
        }
      } catch { /* best-effort */ }
    }

    const events = eventEntries.map(({ event }) => event);
    const publish = publishNotificationEvent ??
      ((event) => publishWatchlistNotificationEvent(event, { upstashRest, logger }));
    let enqueued = 0;
    for (const ev of events) {
      if (await publish(ev)) enqueued++;
    }
    logger.log?.(
      `[digest] watchlist scan: hashes=${hashes.length} candidates=${candidates.length} ` +
        `events=${events.length} enqueued=${enqueued} score_min=${scoreMin} ` +
        `event_type=${WATCHLIST_STORY_EVENT_TYPE}`,
    );
    return { hashes: hashes.length, candidates: candidates.length, events: events.length, enqueued, scoreMin };
  } catch (err) {
    logger.warn?.(`[digest] watchlist scan failed (non-fatal): ${err?.message ?? err}`);
    return { hashes: 0, candidates: 0, events: 0, enqueued: 0, error: err?.message ?? String(err) };
  }
}
