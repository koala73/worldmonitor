#!/usr/bin/env node
/**
 * Market-alert ledger seeder (#8867). Runs the dashboard's four market-alert
 * detectors server-side over the seeded quotes (stocks, commodities, crypto)
 * and the English digest, keeps every emission in a persistent six-hour-window
 * ledger, resolves closed windows against the digest archive under the
 * pre-registered rule, and publishes a rolling 30-day scorecard. Section of
 * scripts/seed-bundle-derived-signals.mjs (5-minute cron).
 *
 * `--dry-run` reads the same inputs and archive, prints the tick summary and
 * the would-be scorecard, and writes nothing.
 */

import { createRequire } from 'node:module';

import { getRedisCredentials, loadEnvFile, redisCommand, runSeed } from './_seed-utils.mjs';
import { unwrapEnvelope } from './_seed-envelope-source.mjs';
import { defaultRedisPipeline } from './lib/_upstash-pipeline.mjs';
import { readStoryTracksChunked } from './lib/story-track-batch-reader.mjs';
import { CORRELATION_RUNTIME_MODE_KEY, resolveCorrelationRuntimeMode } from './shared/correlation-runtime-mode.js';
import { detectMarketAlerts, detectPipelineFlowDrops, extractTopics, predictionChangesSnapshot } from './shared/market-alert-core.js';
import { extractEntityContexts } from './shared/entity-extraction-core.js';
import { clusterNewsCore } from './shared/news-clustering-core.js';
import {
  MARKET_ALERT_ACTIVATION_KEY,
  MARKET_ALERT_LEDGER_KEY,
  MARKET_ALERT_LEDGER_SCHEMA_VERSION,
  MARKET_ALERT_LEDGER_SOURCE_VERSION,
  MARKET_ALERT_SCORECARD_KEY,
  MARKET_ALERT_SCORECARD_META_KEY,
  MARKET_ALERT_SNAPSHOT_KEY,
  MARKET_ALERT_SNAPSHOT_META_KEY,
  MARKET_ALERT_WINDOW_MS,
  buildScorecard,
  ingestSignals,
  pruneLedger,
  resolveDueEntries,
} from './_market-alert-ledger.mjs';

loadEnvFile(import.meta.url);

const require = createRequire(import.meta.url);
const SOURCE_TIERS = require('./shared/source-tiers.json');

export { MARKET_ALERT_LEDGER_KEY, MARKET_ALERT_WINDOW_MS };
export const SNAPSHOT_KEY = MARKET_ALERT_SNAPSHOT_KEY;
export const STOCKS_KEY = 'market:stocks-bootstrap:v1';
export const COMMODITIES_KEY = 'market:commodities-bootstrap:v1';
export const CRYPTO_KEY = 'market:crypto:v1';
export const PREDICTIONS_KEY = 'prediction:markets-bootstrap:v1';
export const DIGEST_KEY = 'news:digest:v1:full:en';
export const ACCUMULATOR_KEY = 'digest:accumulator:v1:full:en';
export const READ_KEYS = [
  STOCKS_KEY, COMMODITIES_KEY, CRYPTO_KEY, PREDICTIONS_KEY, DIGEST_KEY,
  CORRELATION_RUNTIME_MODE_KEY, MARKET_ALERT_LEDGER_KEY, MARKET_ALERT_SNAPSHOT_KEY, MARKET_ALERT_SCORECARD_KEY,
];

const MIN_MS = 60 * 1000;
const MARKET_MAX_AGE_MS = 30 * MIN_MS;
const PREDICTION_MAX_AGE_MS = 90 * MIN_MS;
// Two polls of the predictions seeder's live Railway cron (`*/10 * * * *`) plus jitter.
export const PREDICTION_POLL_GAP_MAX_MS = 25 * MIN_MS;
const DIGEST_MAX_AGE_MS = 60 * MIN_MS;
// Three ticks: an older snapshot cannot say whether an alert was absent on
// the previous tick or lost over an outage.
const SNAPSHOT_MAX_AGE_MS = 15 * MIN_MS;
// Scorecard outlives the 30-minute health gate by days; the snapshot is only
// the previous tick's prediction poll, market changes and emitted alert ids
// and is rewritten every emitting tick.
const SCORECARD_TTL_SECONDS = 7 * 24 * 60 * 60;
const SNAPSHOT_TTL_SECONDS = 24 * 60 * 60;
// A tick with nothing due reads no archive; the scorecard keeps the block of
// the last tick that did, and starts from this one when none is on record.
const UNREAD_ARCHIVE = { readFailed: false, truncated: false, unproven: 0, coveredFromMs: null, readAt: null };
export const MAX_ARCHIVE_HASHES = 20_000;
const SMEMBERS_BATCH = 500;
const PREDICTION_POOLS = ['geopolitical', 'tech', 'finance'];

function sourceTierFor(source) {
  const tier = SOURCE_TIERS[source];
  return Number.isFinite(tier) ? tier : 4;
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function toMs(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Date.parse(value);
  return NaN;
}

function freshPayload(raw, key, maxAgeMs, nowMs, discarded, timestampOf = (seed) => seed?.fetchedAt) {
  const value = raw[key];
  if (value == null) {
    discarded.push({ key, reason: 'missing' });
    return null;
  }
  const { _seed, data } = unwrapEnvelope(value);
  if (!isPlainObject(data)) {
    discarded.push({ key, reason: 'invalid_shape' });
    return null;
  }
  const at = toMs(timestampOf(_seed, data));
  if (!Number.isFinite(at)) {
    discarded.push({ key, reason: 'no_timestamp' });
    return null;
  }
  if (nowMs - at > maxAgeMs) {
    discarded.push({ key, reason: 'stale' });
    return null;
  }
  return { data, fetchedAt: at };
}

export function mapMarkets(payloads) {
  const bySymbol = new Map();
  for (const payload of payloads) {
    for (const quote of Array.isArray(payload?.quotes) ? payload.quotes : []) {
      if (typeof quote?.symbol !== 'string' || !Number.isFinite(quote.change) || bySymbol.has(quote.symbol)) continue;
      bySymbol.set(quote.symbol, {
        symbol: quote.symbol,
        name: typeof quote.name === 'string' && quote.name ? quote.name : quote.symbol,
        display: typeof quote.display === 'string' && quote.display ? quote.display : quote.symbol,
        price: Number.isFinite(quote.price) ? quote.price : null,
        change: quote.change,
      });
    }
  }
  return [...bySymbol.values()];
}

export function mapPredictions(payload) {
  return PREDICTION_POOLS
    .flatMap((pool) => (Array.isArray(payload?.[pool]) ? payload[pool] : []))
    .filter((market) => typeof market?.title === 'string' && market.title && Number.isFinite(market.yesPrice))
    .map((market) => ({
      title: market.title,
      yesPrice: market.yesPrice,
      volume: Number.isFinite(market.volume) ? market.volume : 0,
      ...(typeof market.url === 'string' && market.url ? { url: market.url } : {}),
    }));
}

export function digestNewsItems(digest) {
  return Object.values(isPlainObject(digest.categories) ? digest.categories : {})
    .flatMap((bucket) => (Array.isArray(bucket?.items) ? bucket.items : []))
    .filter((item) => typeof item?.title === 'string' && item.title)
    .map((item) => {
      const pubDateMs = toMs(item.published_at ?? item.publishedAt ?? item.pubDate);
      const source = typeof item.source === 'string' ? item.source : '';
      return {
        source,
        title: item.title,
        link: typeof item.link === 'string' ? item.link : (typeof item.url === 'string' ? item.url : ''),
        pubDate: new Date(Number.isFinite(pubDateMs) ? pubDateMs : 0),
        pubDateMissing: !Number.isFinite(pubDateMs),
        isAlert: Boolean(item.isAlert),
        tier: Number.isFinite(item.tier) ? item.tier : sourceTierFor(source),
      };
    });
}

export function buildNewsContext(items) {
  const clusters = clusterNewsCore(items, sourceTierFor);
  return {
    newsTopics: extractTopics(clusters),
    newsEntityContexts: extractEntityContexts(clusters),
    pipelineFlowMentions: detectPipelineFlowDrops(clusters, () => false, () => {}).length,
    clusters: clusters.length,
  };
}

function parseLedger(value) {
  if (value == null) return {};
  const { data } = unwrapEnvelope(value);
  if (!isPlainObject(data)) throw new Error(`${MARKET_ALERT_LEDGER_KEY} holds a malformed ledger; refusing to overwrite it`);
  return data;
}

function parsePreviousArchive(value) {
  const { data } = unwrapEnvelope(value);
  return isPlainObject(data) && isPlainObject(data.archive) ? data.archive : null;
}

export function parseSnapshot(value) {
  const { data } = unwrapEnvelope(value);
  if (!isPlainObject(data) || !isPlainObject(data.predictionChanges) || !isPlainObject(data.marketChanges) || !Array.isArray(data.emitted)) return null;
  if (!isPlainObject(data.activity) || !Object.values(data.activity).every(Array.isArray)) return null;
  if (data.predictionsFetchedAt !== null && typeof data.predictionsFetchedAt !== 'number') return null;
  return {
    timestamp: Number(data.timestamp),
    predictionChanges: data.predictionChanges,
    predictionsFetchedAt: data.predictionsFetchedAt,
    marketChanges: data.marketChanges,
    emitted: data.emitted,
    activity: data.activity,
  };
}

const isRun = (run) => isPlainObject(run) && Number.isFinite(run.since) && Number.isFinite(run.until) && Array.isArray(run.types) && run.types.every((type) => typeof type === 'string');

/**
 * What the stored snapshot says about the past, salvaged from any shape: when
 * it was observed and the runs of held activity it carried. A snapshot that
 * parseSnapshot rejects for a missing field still supplies both; the
 * object-valued activity of the previous snapshot shape supplies no runs.
 */
export function snapshotHistory(value) {
  const { data } = unwrapEnvelope(value);
  if (!isPlainObject(data)) return { observedAt: null, activity: {} };
  const runs = isPlainObject(data.activity) && Object.values(data.activity).every((symbolRuns) => Array.isArray(symbolRuns) && symbolRuns.every(isRun));
  return {
    observedAt: Number.isFinite(data.timestamp) ? data.timestamp : null,
    activity: runs ? data.activity : {},
  };
}

// A re-read of the same poll (equal fetchedAt) or a gap wider than two polls
// cannot say the move happened since the previous tick.
function predictionBaseline(baseline, predictionsFetchedAt) {
  if (!baseline || predictionsFetchedAt === null || typeof baseline.predictionsFetchedAt !== 'number') return null;
  const gap = predictionsFetchedAt - baseline.predictionsFetchedAt;
  if (gap <= 0 || gap > PREDICTION_POLL_GAP_MAX_MS) return null;
  return new Map(Object.entries(baseline.predictionChanges));
}

export function liveBaseline(previousSnapshot, nowMs) {
  return previousSnapshot && nowMs - previousSnapshot.timestamp <= SNAPSHOT_MAX_AGE_MS ? previousSnapshot : null;
}

export function snapshotOf({ nowMs, predictions, predictionsFetchedAt, markets, emitted, activity }) {
  return {
    timestamp: nowMs,
    predictionChanges: Object.fromEntries(predictionChangesSnapshot(predictions)),
    predictionsFetchedAt,
    marketChanges: Object.fromEntries(markets.map((market) => [market.symbol, market.change])),
    emitted,
    activity,
  };
}

function snapshotRecords(snapshot) {
  return Object.keys(snapshot.predictionChanges).length + Object.keys(snapshot.marketChanges).length;
}

function digestTimestamp(seed, data) {
  const generatedAt = toMs(data.generatedAt);
  return Number.isFinite(generatedAt) ? generatedAt : seed?.fetchedAt;
}

export async function buildTick(raw, { nowMs = Date.now(), archive }) {
  const discarded = [];
  const stocks = freshPayload(raw, STOCKS_KEY, MARKET_MAX_AGE_MS, nowMs, discarded);
  const commodities = freshPayload(raw, COMMODITIES_KEY, MARKET_MAX_AGE_MS, nowMs, discarded);
  const crypto = freshPayload(raw, CRYPTO_KEY, MARKET_MAX_AGE_MS, nowMs, discarded);
  const predictionsPayload = freshPayload(raw, PREDICTIONS_KEY, PREDICTION_MAX_AGE_MS, nowMs, discarded);
  const digest = freshPayload(raw, DIGEST_KEY, DIGEST_MAX_AGE_MS, nowMs, discarded, digestTimestamp);
  const runtimeMode = resolveCorrelationRuntimeMode(raw[CORRELATION_RUNTIME_MODE_KEY]);
  const previousSnapshot = parseSnapshot(raw[SNAPSHOT_KEY]);
  const baseline = liveBaseline(previousSnapshot, nowMs);
  const predictionsFetchedAt = predictionsPayload?.fetchedAt ?? null;

  const markets = mapMarkets([stocks?.data, commodities?.data, crypto?.data]);
  const predictions = predictionsPayload ? mapPredictions(predictionsPayload.data) : [];
  const items = digest ? digestNewsItems(digest.data) : [];
  const observed = (emitted, activity) => snapshotOf({ nowMs, predictions, predictionsFetchedAt, markets, emitted, activity });

  let signals = [];
  if (digest) {
    const news = buildNewsContext(items);
    signals = detectMarketAlerts({
      markets,
      predictions,
      previousPredictionChanges: predictionBaseline(baseline, predictionsFetchedAt),
      newsTopics: news.newsTopics,
      newsEntityContexts: news.newsEntityContexts,
      pipelineFlowMentions: news.pipelineFlowMentions,
      isRecentDuplicate: () => false,
      markSignalSeen: () => {},
    });
  }

  // Runs are facts about the past, so they come from the stored snapshot even
  // when it is no baseline; the resolver reads the snapshot's map rather than
  // this tick's because ingest prunes against nowMs.
  const { observedAt, activity: previousActivity } = snapshotHistory(raw[SNAPSHOT_KEY]);
  const ingested = ingestSignals(parseLedger(raw[MARKET_ALERT_LEDGER_KEY]), signals, { nowMs, runtimeMode, markets, predictions, baseline, activity: previousActivity, observedAt });
  const resolved = await resolveDueEntries(ingested.ledger, { nowMs, archive, activity: previousActivity });
  const ledger = pruneLedger(resolved.ledger, nowMs);
  const byType = {};
  for (const signal of signals) byType[signal.type] = (byType[signal.type] ?? 0) + 1;
  const archiveStatus = resolved.read ? resolved : (parsePreviousArchive(raw[MARKET_ALERT_SCORECARD_KEY]) ?? UNREAD_ARCHIVE);

  return {
    ledger,
    scorecard: buildScorecard(ledger, nowMs, { archive: archiveStatus }),
    snapshot: digest ? observed(ingested.emitted, ingested.activity) : (previousSnapshot ?? observed(null, {})),
    summary: {
      inputs: {
        stocks: stocks?.data.quotes?.length ?? 0,
        commodities: commodities?.data.quotes?.length ?? 0,
        crypto: crypto?.data.quotes?.length ?? 0,
        predictions: predictions.length,
        digestItems: items.length,
        runtimeMode,
      },
      discarded,
      emitted: { total: signals.length, byType, gated: ingested.gated, held: ingested.held },
      created: ingested.created,
      updated: ingested.updated,
      resolved: { hit: resolved.hit, miss: resolved.miss, void: resolved.void, unproven: resolved.unproven },
      readFailed: resolved.readFailed,
      truncated: resolved.truncated,
      pending: resolved.pending,
      entries: Object.keys(ledger).length,
    },
  };
}

export function formatSummary(summary) {
  const { inputs, emitted, resolved } = summary;
  const byType = Object.entries(emitted.byType).map(([type, count]) => `${type}:${count}`).join(',') || 'none';
  const discarded = summary.discarded.map(({ key, reason }) => `${key}=${reason}`).join(',') || 'none';
  return `  [market-alert-ledger] inputs stocks=${inputs.stocks} commodities=${inputs.commodities} crypto=${inputs.crypto} `
    + `predictions=${inputs.predictions} digestItems=${inputs.digestItems} mode=${inputs.runtimeMode} discarded=${discarded} | `
    + `emitted=${emitted.total} (${byType}) gated=${emitted.gated} held=${emitted.held} new=${summary.created} re-emitted=${summary.updated} | `
    + `resolved hit=${resolved.hit} miss=${resolved.miss} void=${resolved.void} unproven=${resolved.unproven}`
    + `${summary.readFailed ? ' archive-read-failed' : ''}${summary.truncated ? ' archive-truncated' : ''} | `
    + `pending=${summary.pending} entries=${summary.entries}`;
}

function flatToObject(flat) {
  const object = {};
  for (let i = 0; i + 1 < flat.length; i += 2) object[flat[i]] = flat[i + 1];
  return object;
}

function bestSource(sources) {
  let best = { tier: 4, source: sources[0] ?? '' };
  for (const source of sources) {
    const tier = sourceTierFor(source);
    if (tier < best.tier) best = { tier, source };
  }
  return best;
}

function arrayResult(row) {
  return row != null && row.error == null && Array.isArray(row.result) ? row.result : null;
}

function stayPending(what) {
  console.warn(`  [market-alert-ledger] ${what}; due entries stay pending this tick`);
  return null;
}

export function createRedisArchive(pipeline = defaultRedisPipeline) {
  return {
    // Newest first: when the window overflows, the kept stories are the
    // newest MAX_ARCHIVE_HASHES and coveredFromMs rises to one past the oldest
    // kept lastSeen, since the LIMIT can split members tied at that score, so
    // the newest due rows still resolve. A story's lastSeen is never below its
    // firstSeen, so every story first seen at or after coveredFromMs is in the
    // kept set.
    async readStories(sinceMs) {
      const rows = await pipeline([
        ['ZRANGE', ACCUMULATOR_KEY, '0', '0', 'WITHSCORES'],
        ['ZREVRANGEBYSCORE', ACCUMULATOR_KEY, '+inf', String(sinceMs), 'WITHSCORES', 'LIMIT', '0', String(MAX_ARCHIVE_HASHES + 1)],
      ]);
      const oldest = arrayResult(rows?.[0]);
      const newestFirst = arrayResult(rows?.[1]);
      if (!oldest || !newestFirst) return stayPending(`${ACCUMULATOR_KEY} read failed`);
      const truncated = newestFirst.length > 2 * MAX_ARCHIVE_HASHES;
      const kept = truncated ? newestFirst.slice(0, 2 * MAX_ARCHIVE_HASHES) : newestFirst;
      const members = kept.filter((_, i) => i % 2 === 0);
      const scoreAt = (flat, i) => (flat.length > i && Number.isFinite(Number(flat[i])) ? Number(flat[i]) : null);
      const oldestKept = scoreAt(kept, kept.length - 1);
      const coveredFromMs = truncated ? (oldestKept == null ? null : oldestKept + 1) : scoreAt(oldest, 1);
      const tracks = await readStoryTracksChunked(members, pipeline, { context: 'market-alert-ledger' });
      if (!tracks) return null;
      const stories = [];
      for (let i = 0; i < members.length; i += 1) {
        if (tracks[i]?.error != null) return stayPending('story:track read failed');
        const result = tracks[i]?.result;
        const flat = Array.isArray(result) ? result : (isPlainObject(result) ? Object.entries(result).flat() : []);
        const track = flatToObject(flat);
        const firstSeen = Number(track.firstSeen);
        if (typeof track.title !== 'string' || !Number.isFinite(firstSeen)) continue;
        stories.push({ hash: members[i], title: track.title, firstSeen });
      }
      return { coveredFromMs, truncated, stories };
    },
    async readSourceTiers(hashes) {
      const tiers = new Map();
      for (let i = 0; i < hashes.length; i += SMEMBERS_BATCH) {
        const chunk = hashes.slice(i, i + SMEMBERS_BATCH);
        const rows = await pipeline(chunk.map((hash) => ['SMEMBERS', `story:sources:v1:${hash}`]));
        if (!Array.isArray(rows) || rows.length !== chunk.length) return stayPending('story:sources read failed');
        for (let j = 0; j < chunk.length; j += 1) {
          const sources = arrayResult(rows[j]);
          if (!sources) return stayPending('story:sources read failed');
          tiers.set(chunk[j], bestSource(sources));
        }
      }
      return tiers;
    },
  };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function readRawInputs(pipeline = defaultRedisPipeline) {
  const rows = await pipeline(READ_KEYS.map((key) => ['GET', key]));
  if (!Array.isArray(rows) || rows.length !== READ_KEYS.length) {
    throw new Error('Redis pipeline GET of the market-alert inputs failed');
  }
  const raw = {};
  READ_KEYS.forEach((key, i) => {
    const row = rows[i];
    if (row?.error != null) throw new Error(`Redis GET ${key} failed: ${row.error}`);
    raw[key] = typeof row?.result === 'string' ? parseJson(row.result) : null;
  });
  return raw;
}

async function runTick() {
  const tick = await buildTick(await readRawInputs(), { nowMs: Date.now(), archive: createRedisArchive() });
  console.log(formatSummary(tick.summary));
  return tick;
}

async function dryRun() {
  getRedisCredentials();
  const tick = await runTick();
  console.log(JSON.stringify({ scorecard: tick.scorecard, snapshotEntries: snapshotRecords(tick.snapshot) }, null, 2));
}

async function main() {
  getRedisCredentials();
  const latest = { scorecard: null, snapshot: null };
  await runSeed('correlation', 'market-alerts', MARKET_ALERT_LEDGER_KEY, async () => {
    const tick = await runTick();
    latest.scorecard = tick.scorecard;
    latest.snapshot = tick.snapshot;
    return tick.ledger;
  }, {
    // Persistent working ledger: no ttlSeconds, like forecast:resolutions:v1.
    validateFn: isPlainObject,
    declareRecords: (ledger) => Object.keys(ledger).length,
    zeroIsValid: true,
    sourceVersion: MARKET_ALERT_LEDGER_SOURCE_VERSION,
    schemaVersion: MARKET_ALERT_LEDGER_SCHEMA_VERSION,
    maxStaleMin: 30,
    lockTtlMs: 180_000,
    fetchPhaseTimeoutMs: 80_000,
    extraKeys: [{
      key: MARKET_ALERT_SCORECARD_KEY,
      ttl: SCORECARD_TTL_SECONDS,
      transform: () => latest.scorecard,
      declareRecords: (scorecard) => scorecard.byType.length,
      metaKey: MARKET_ALERT_SCORECARD_META_KEY,
      metaCritical: true,
    }, {
      key: MARKET_ALERT_SNAPSHOT_KEY,
      ttl: SNAPSHOT_TTL_SECONDS,
      transform: () => latest.snapshot,
      declareRecords: snapshotRecords,
      metaKey: MARKET_ALERT_SNAPSHOT_META_KEY,
    }],
    afterPublish: async () => {
      const { url, token } = getRedisCredentials();
      await redisCommand(url, token, ['SET', MARKET_ALERT_ACTIVATION_KEY, '1']);
    },
  });
}

if (process.argv[1]?.endsWith('seed-market-alert-ledger.mjs')) {
  (process.argv.includes('--dry-run') ? dryRun : main)().catch((err) => {
    console.error('FATAL:', err.message || err);
    process.exit(1);
  });
}
