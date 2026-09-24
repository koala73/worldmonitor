#!/usr/bin/env node

// Publishes the video each catalog YouTube channel has live right now (#8545), so the Live News and Live Webcams
// players can try a fresh `watch?v=` id immediately before the channel entry that produced it.
//
// Each run reads every channel's public /live page through the Decodo proxy (scripts/lib/live-video-channel-live.mjs,
// the resolver the daily audit also uses), validates the result (channel id matches, live, embeddable, 11-char id) and
// publishes only `{ channelId -> { videoId, resolvedAt } }` plus counts. The channel list comes from
// scripts/shared/live-video-refresh-channels.generated.json (npm run sync:live-video-channels), because this service
// is packaged from scripts/ alone and cannot read src/.
//
// Merge rules against the last published map:
//   - live            -> published with resolvedAt = now
//   - not live        -> dropped (an ended video must not play ahead of the catalog)
//   - unreadable page -> the previous id is kept while it is at most LAST_GOOD_MAX_AGE_MS old
//   - channel no longer in the generated list -> dropped
// A run where every page was unreadable publishes nothing: runSeed keeps last-good and exits 75.
// The first successful publish also SETs seed-activated:live-video:resolved, which ends /api/health's
// pre-provisioning softening for liveVideoResolved; from then on an absent or stale key alarms.
//
// The payload is public (?keys=liveVideoResolved&public=1 and the get-bootstrap-data RPC), so it never carries titles
// or slot names; those go to this log only.
//
// Railway service config (set up manually via the Railway dashboard or `railway service`):
//   - Service name: seed-live-video-resolved
//   - Root directory: scripts
//   - Start command: node seed-live-video-resolved.mjs
//   - Cron: 0 */6 * * *
//   - Variables: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, LIVE_VIDEO_PROXY_URL or PROXY_URL
//
// Dry run (resolves and merges against the live last-good, prints counts and channel -> id, writes nothing):
//   node scripts/seed-live-video-resolved.mjs --dry-run

import { readFileSync } from 'node:fs';
import { fetchChannelLivePage, proxyForAttempt, resolveChannelsLive } from './lib/live-video-channel-live.mjs';
import { isMainModule } from './lib/main-module.mjs';
import { loadEnvFile, readCanonicalValue, runSeed } from './_seed-utils.mjs';
import { getOptionalUpstashCreds, upstashCommand } from './_upstash-rest.mjs';

export const CANONICAL_KEY = 'live-video:resolved:v1';
/**
 * Durable marker /api/health reads (ACTIVATION_MARKERS.liveVideoResolved): until it exists the probe softens to
 * EMPTY_ON_DEMAND, so registering the probe before the Railway service is provisioned does not page anyone.
 */
export const LIVE_VIDEO_ACTIVATION_KEY = 'seed-activated:live-video:resolved';
/** An unreadable channel keeps its previous id this long. The player ignores entries older than the same limit. */
export const LAST_GOOD_MAX_AGE_MS = 36 * 60 * 60 * 1000;
/** Same cap as MAX_REFRESH_CHANNELS in scripts/lib/live-video-refresh.mjs (TypeScript-importing, so not imported here). */
export const MAX_CHANNELS = 60;
/** No channel page fetch starts after this; one pass takes at most this plus one page's worst case (2 x 15 s). */
export const RESOLVE_BUDGET_MS = 3 * 60_000;
export const RESOLVE_CONCURRENCY = 4;
const TTL_SECONDS = 7 * 24 * 60 * 60;
const CHANNELS_FILE = new URL('./shared/live-video-refresh-channels.generated.json', import.meta.url);

const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const STAT_FIELDS = ['attempted', 'live', 'notLive', 'unreadable', 'keptLastGood', 'dropped'];

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const timeOf = (value) => (typeof value === 'string' ? Date.parse(value) : Number.NaN);

/** The channel list from the generated file: `[{ channelId, slots }]`. Throws on a malformed or oversized list. */
export function loadRefreshChannels(text = readFileSync(CHANNELS_FILE, 'utf8')) {
  const channels = JSON.parse(text)?.channels;
  if (!Array.isArray(channels)) throw new Error('live-video-refresh-channels.generated.json has no channels array');
  if (channels.length > MAX_CHANNELS) throw new Error(`${channels.length} channels listed, more than ${MAX_CHANNELS}`);
  for (const entry of channels) {
    if (!CHANNEL_ID.test(entry?.channelId ?? '')) throw new Error(`not a channel id: ${JSON.stringify(entry?.channelId)}`);
  }
  return channels.map(({ channelId, slots }) => ({ channelId, slots: Array.isArray(slots) ? slots : [] }));
}

/**
 * Pure: the next published map from the previous one and this run's resolver results.
 * `previous` is the last published `channels` object (or anything else, read as empty); `results` is the
 * Map resolveChannelsLive returns; `listedIds` are the channels the generated list names today.
 */
export function mergeResolved(previous, results, { now, listedIds }) {
  const prior = isPlainObject(previous) ? previous : {};
  const resolvedAt = new Date(now).toISOString();
  const channels = {};
  const stats = { attempted: 0, live: 0, notLive: 0, unreadable: 0, keptLastGood: 0, dropped: 0 };
  for (const id of listedIds) {
    const result = results.get(id);
    stats.attempted++;
    if (result?.status === 'live' && result.channelId === id && VIDEO_ID.test(result.videoId ?? '')) {
      stats.live++;
      channels[id] = { videoId: result.videoId, resolvedAt };
      continue;
    }
    if (result?.status === 'not-live') {
      stats.notLive++;
      continue;
    }
    stats.unreadable++;
    const last = prior[id];
    const lastAt = timeOf(last?.resolvedAt);
    if (VIDEO_ID.test(last?.videoId ?? '') && Number.isFinite(lastAt) && now - lastAt <= LAST_GOOD_MAX_AGE_MS) {
      stats.keptLastGood++;
      channels[id] = { videoId: last.videoId, resolvedAt: new Date(lastAt).toISOString() };
    }
  }
  stats.dropped = Object.keys(prior).filter((id) => !Object.hasOwn(channels, id)).length;
  return { resolvedAt, channels, stats };
}

/**
 * runSeed's validateFn. Keeps the public payload minimal: exactly `{ resolvedAt, channels, stats }`, each channel
 * exactly `{ videoId, resolvedAt }`. An empty map is valid only when no channel was attempted, so a pass that read
 * every channel as not live (a page-shape change) keeps last-good through runSeed's validation skip.
 */
export function validateResolvedPayload(data) {
  if (!isPlainObject(data)) return false;
  if (Object.keys(data).sort().join() !== 'channels,resolvedAt,stats') return false;
  if (!Number.isFinite(timeOf(data.resolvedAt))) return false;
  const { channels, stats } = data;
  if (!isPlainObject(channels) || !isPlainObject(stats)) return false;
  if (Object.keys(stats).sort().join() !== [...STAT_FIELDS].sort().join()) return false;
  if (!STAT_FIELDS.every((field) => Number.isInteger(stats[field]) && stats[field] >= 0)) return false;
  const entries = Object.entries(channels);
  if (entries.length === 0 && stats.attempted > 0) return false;
  if (entries.length > MAX_CHANNELS) return false;
  return entries.every(([id, entry]) => CHANNEL_ID.test(id)
    && isPlainObject(entry)
    && Object.keys(entry).sort().join() === 'resolvedAt,videoId'
    && typeof entry.videoId === 'string' && VIDEO_ID.test(entry.videoId)
    && Number.isFinite(timeOf(entry.resolvedAt)));
}

export function declareRecords(data) {
  return isPlainObject(data?.channels) ? Object.keys(data.channels).length : 0;
}

/**
 * The proxy for this run from the raw value (`LIVE_VIDEO_PROXY_URL || PROXY_URL`), kept raw so the resolver can move
 * a Decodo sticky port to the next session per retry. `route` is attempt 0's parseProxyConfig object, null when the
 * value is unset or unparseable.
 */
export function resolveRunProxy(raw) {
  const proxyUrl = typeof raw === 'string' && raw.trim() ? raw.trim() : null;
  return { proxyUrl, route: proxyForAttempt(proxyUrl, 0) };
}

const nonRetryable = (error) => Object.assign(error instanceof Error ? error : new Error(String(error)), { nonRetryable: true });

/**
 * The runSeed fetch function. Reads last-good first (strict, so a Redis HTTP failure throws and retries instead of
 * reading as "nothing published"), then makes ONE resolution pass. Every throw after the pass is `nonRetryable`, so
 * withRetry never repeats a pass that already spent its budget.
 */
export function makeFetchAll({
  channels,
  fetchPage,
  readPrevious = () => readCanonicalValue(CANONICAL_KEY, { strict: true }),
  now = Date.now,
  budgetMs = RESOLVE_BUDGET_MS,
  concurrency = RESOLVE_CONCURRENCY,
  session = { current: 0 },
  log = console.log,
}) {
  return async function fetchAll() {
    const previous = (await readPrevious())?.channels ?? {};
    const ids = channels.map((entry) => entry.channelId);
    const startedAt = now();
    const results = await resolveChannelsLive(ids, { fetchPage, concurrency, budgetMs, now, session });
    try {
      const payload = mergeResolved(previous, results, { now: now(), listedIds: ids });
      const slotsById = new Map(channels.map((entry) => [entry.channelId, entry.slots]));
      for (const id of ids) {
        const result = results.get(id);
        const kept = result?.status === 'unreadable' && payload.channels[id] ? ` (kept ${payload.channels[id].videoId})` : '';
        const title = result?.title ? ` "${result.title}"` : '';
        log(`  ${id} [${(slotsById.get(id) ?? []).join(', ')}] ${result?.status ?? 'missing'}${result?.reason ? `/${result.reason}` : ''}${result?.videoId ? ` -> ${result.videoId}` : ''}${title}${kept}`);
      }
      const { stats } = payload;
      log(`  stats: ${STAT_FIELDS.map((field) => `${field}=${stats[field]}`).join(' ')} proxySession=${session.current} durationMs=${now() - startedAt}`);
      if (stats.attempted > 0 && stats.unreadable === stats.attempted) {
        throw new Error(`every channel page was unreadable (${stats.attempted}); last-good kept`);
      }
      return payload;
    } catch (error) {
      throw nonRetryable(error);
    }
  };
}

/**
 * runSeed's afterPublish hook: runs only after a validated map was published. Best-effort, like the other
 * activation markers (seed-cbr-rates): a failed write costs one more run of health softening, never the run.
 */
export async function markLiveVideoActivated() {
  try {
    const creds = getOptionalUpstashCreds();
    if (!creds) return;
    await upstashCommand(creds, ['SET', LIVE_VIDEO_ACTIVATION_KEY, '1']);
  } catch (error) {
    console.warn(`  WARN: activation marker write failed: ${error?.message || error}`);
  }
}

/** Refuses any Upstash request that is not a GET of a key, so --dry-run provably writes nothing. */
export function guardRedisReadOnly(redisUrl, counts) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = String(input?.url ?? input);
    if (redisUrl && url.startsWith(redisUrl)) {
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (method !== 'GET' || !new URL(url).pathname.startsWith('/get/')) {
        counts.blocked++;
        return Promise.reject(new Error(`dry run: refused a Redis write (${method} ${new URL(url).pathname.split('/')[1]})`));
      }
      counts.reads++;
    }
    return realFetch(input, init);
  };
}

async function main() {
  loadEnvFile(import.meta.url);
  const dryRun = process.argv.includes('--dry-run');
  const { proxyUrl, route } = resolveRunProxy(process.env.LIVE_VIDEO_PROXY_URL || process.env.PROXY_URL);
  if (!route && process.env.RAILWAY_ENVIRONMENT) {
    // #5256: no later tick can fix a missing variable, so a crash every 6 h would only train the team to ignore the
    // crash channel. /api/health reports liveVideoResolved EMPTY, then STALE_SEED, which is where the alarm belongs.
    console.log('NO SOURCE: LIVE_VIDEO_PROXY_URL/PROXY_URL unset or unparseable; published nothing, /api/health carries the alarm');
    process.exit(0);
  }
  const channels = loadRefreshChannels();
  const session = { current: 0 };
  const fetchPage = (id, { attempt }) => fetchChannelLivePage(id, { proxyUrl, attempt });
  console.log(`live-video resolved: ${channels.length} channels, ${route ? 'through the proxy' : 'direct (no proxy configured)'}${dryRun ? ', dry run' : ''}`);

  if (dryRun) {
    const hasRedis = Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
    const counts = { reads: 0, blocked: 0 };
    guardRedisReadOnly(process.env.UPSTASH_REDIS_REST_URL, counts);
    const fetchAll = makeFetchAll({
      channels,
      fetchPage,
      session,
      readPrevious: hasRedis ? undefined : async () => {
        console.log('  no Redis credentials: last-good not read');
        return null;
      },
    });
    try {
      const payload = await fetchAll();
      console.log(`  valid payload: ${validateResolvedPayload(payload)}; records: ${declareRecords(payload)}`);
      for (const [id, entry] of Object.entries(payload.channels)) console.log(`  publish ${id} -> ${entry.videoId} (${entry.resolvedAt})`);
    } catch (error) {
      console.log(`  would exit 75 and keep last-good: ${error.message}`);
    }
    console.log(`  dry run: Redis reads=${counts.reads} writes=0 refused=${counts.blocked}; nothing published`);
    return;
  }

  await runSeed('live-video', 'resolved', CANONICAL_KEY, makeFetchAll({ channels, fetchPage, session }), {
    validateFn: validateResolvedPayload,
    afterPublish: markLiveVideoActivated,
    ttlSeconds: TTL_SECONDS,
    declareRecords,
    schemaVersion: 1,
    sourceVersion: 'youtube-channel-live-page-v1',
    maxStaleMin: 1080, // 3 x the 0 */6 * * * cron
    fetchPhaseTimeoutMs: 6 * 60_000, // one worst-case pass (3.5 min) plus the last-good read
    lockTtlMs: 8 * 60_000,
  });
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main().catch((error) => {
    console.error('FATAL:', error?.message || error);
    process.exit(1);
  });
}
