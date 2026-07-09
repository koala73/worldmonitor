#!/usr/bin/env node

// Daily forecast resolution seeder for Bet 2 (#5007).
//
// The exported helpers are pure/testable; the direct-run block is the Railway
// worker shell that reads the forecast history intake, persists the working
// ledger, writes the scorecard, and appends terminal receipts to R2.
//
// Railway service config (set up manually via Railway dashboard or
// `railway service`):
//   - Service name: seed-forecast-resolutions
//   - Start command: node scripts/seed-forecast-resolutions.mjs
//   - Cron: daily

import { CHROME_UA, loadEnvFile, runSeed } from './_seed-utils.mjs';
import { unwrapEnvelope } from './_seed-envelope-source.mjs';
import { resolveR2StorageConfig, putR2JsonObject } from './_r2-storage.mjs';
import { parseMetricKey, resolveHardSpec, extractMetricValue } from './_forecast-resolution-eval.mjs';
import { computeScorecard, DEFAULT_ROLLING_WINDOW_DAYS } from './_forecast-scorecard.mjs';

export const HISTORY_KEY = 'forecast:predictions:history:v1';
export const RESOLUTIONS_KEY = 'forecast:resolutions:v1';
export const SCORECARD_KEY = 'forecast:scorecard:v1';
export const SCORECARD_META_KEY = 'seed-meta:forecast:scorecard';
export const SCORECARD_TTL_SECONDS = 7 * 24 * 60 * 60;
export const RESOLUTION_SOURCE_VERSION = 'forecast-resolution-engine-v1';
export const RESOLUTION_SCHEMA_VERSION = 1;
export const MAX_RECENT_SAMPLES = 40;
const DAY_MS = 24 * 60 * 60 * 1000;

// Retention for the persistent working ledger (#5067). A resolved entry only
// leaves the hot `forecast:resolutions:v1` value once it is (a) durably archived
// to R2 as a receipt AND (b) older than this window — by which point it no longer
// contributes to the rolling scorecard math, so pruning it is scorecard-neutral.
// Aligned to the scorecard's rolling window so the two never diverge: any pruned
// entry is exactly one the scorecard already excludes. The window (180d) dwarfs
// the forecast-history intake reach (LRANGE 200 at hourly cadence ~8.3 days), so
// a pruned window can never be re-ingested from a stale snapshot.
export const LEDGER_RETENTION_WINDOW_DAYS = DEFAULT_ROLLING_WINDOW_DAYS;

const DIRECT_RUN = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (DIRECT_RUN) loadEnvFile(import.meta.url);

export function declareRecords(ledger) {
  return Object.keys(normalizeLedger(ledger)).length;
}

export function declareScorecardRecords(scorecard) {
  return Number.isInteger(scorecard?.totals?.entries) ? scorecard.totals.entries : 0;
}

export function processResolutionCycle(existingLedger, historySnapshots, feedsByKey, nowMs) {
  const ingested = ingestHistory(existingLedger, historySnapshots, nowMs);
  samplePendingEntries(ingested, feedsByKey, nowMs);
  const receipts = resolveDueEntries(ingested, feedsByKey, nowMs);
  // Drop terminal entries that are already receipted to R2 and outside the
  // rolling scorecard window, keeping the persistent ledger bounded (#5067). Runs after
  // resolveDueEntries so entries resolved this cycle (resolvedAt === nowMs, not
  // yet archived) are always retained and still emit a receipt above.
  const ledger = pruneArchivedTerminalEntries(ingested, nowMs);
  const scorecard = computeScorecard(ledger, nowMs);
  return { ledger, receipts, scorecard };
}

// Terminal entries whose receipt is safely in R2 and that have aged past the
// retention window are removed from the hot working ledger; everything else
// (pending, pending-judge, within-window resolved, un-archived resolved, or
// resolved-without-a-timestamp) is retained. Pure: returns a new object and
// never mutates the input.
export function pruneArchivedTerminalEntries(ledger, nowMs, options = {}) {
  const retentionDays = options.retentionWindowDays ?? LEDGER_RETENTION_WINDOW_DAYS;
  const minResolvedAt = nowMs - retentionDays * DAY_MS;
  const kept = {};
  for (const [key, entry] of Object.entries(normalizeLedger(ledger))) {
    if (isPrunableTerminalEntry(entry, minResolvedAt)) continue;
    kept[key] = entry;
  }
  return kept;
}

function isPrunableTerminalEntry(entry, minResolvedAt) {
  if (!entry || entry.status !== 'resolved') return false;
  if (!entry.receiptArchivedAt) return false;
  const resolvedAt = Number(entry.resolvedAt);
  if (!Number.isFinite(resolvedAt)) return false;
  return resolvedAt < minResolvedAt;
}

export function ingestHistory(existingLedger, historySnapshots, nowMs = Date.now()) {
  const ledger = cloneJson(normalizeLedger(existingLedger));
  const snapshots = [...(historySnapshots || [])]
    .filter(Boolean)
    .sort((a, b) => Number(a.generatedAt || 0) - Number(b.generatedAt || 0));

  for (const snapshot of snapshots) {
    const snapshotAt = Number(snapshot.generatedAt || nowMs);
    for (const forecast of snapshot.predictions || []) {
      const spec = forecast.resolution;
      if (!spec || typeof spec !== 'object') continue;
      const id = forecast.id;
      const deadline = Number(spec.deadline);
      const generatedAt = Number(forecast.generatedAt || forecast.createdAt || snapshotAt);
      if (!id || !Number.isFinite(deadline) || !Number.isFinite(generatedAt)) continue;

      const openKey = findOpenWindowKey(ledger, id, generatedAt);
      if (openKey) {
        updateOpenWindow(ledger[openKey], forecast, generatedAt, snapshotAt);
        continue;
      }

      const key = `${id}@${deadline}`;
      if (ledger[key]) {
        updateOpenWindow(ledger[key], forecast, generatedAt, snapshotAt);
        continue;
      }
      ledger[key] = createEntry(id, forecast, spec, generatedAt, snapshotAt, deadline);
    }
  }

  return sortLedger(ledger);
}

export function samplePendingEntries(ledger, feedsByKey, nowMs) {
  for (const entry of Object.values(ledger)) {
    if (entry.status !== 'pending') continue;
    const parsed = parseMetricKey(entry.spec?.metricKey);
    if (!parsed || parsed.fn === 'count') continue;
    const deadline = Number(entry.deadline ?? entry.spec?.deadline);
    const isPointWindow = entry.spec?.window === 'at-deadline' || entry.spec?.window === 'at-endDate';
    if (!isPointWindow && nowMs > deadline) continue;
    if (isPointWindow && nowMs > deadline && hasSampleAtOrAfterDeadline(entry.samples, deadline)) continue;
    const feedData = feedsByKey?.[entry.spec.sourceFeed] ?? feedsByKey?.[parsed.feedKey];
    if (feedData == null) {
      entry.samples = appendSample(entry.samples, { ts: nowMs, error: `missing_feed:${entry.spec.sourceFeed || parsed.feedKey}` });
      continue;
    }
    const value = extractMetricValue(parsed, feedData);
    entry.samples = Number.isFinite(value)
      ? appendSample(entry.samples, { ts: nowMs, value })
      : appendSample(entry.samples, { ts: nowMs, error: 'metric_not_found' });
  }
}

export function resolveDueEntries(ledger, feedsByKey, nowMs) {
  const receipts = [];
  for (const [key, entry] of Object.entries(ledger)) {
    if (entry.status !== 'pending') continue;
    const parsed = parseMetricKey(entry.spec?.metricKey);
    const feedData = feedsByKey?.[entry.spec?.sourceFeed] ?? feedsByKey?.[parsed?.feedKey];
    const result = resolveHardSpec(entry, feedData, entry.samples, nowMs);
    if (result.status !== 'resolved') continue;

    entry.status = 'resolved';
    entry.outcome = result.outcome;
    entry.resolvedAt = nowMs;
    entry.sealedAt = nowMs;
    entry.evidence = result.evidence;
    receipts.push({ key, entry: cloneJson(entry), resolvedAt: nowMs });
  }
  return receipts;
}

export function collectUnarchivedReceipts(ledger) {
  return Object.entries(normalizeLedger(ledger))
    .filter(([, entry]) => entry?.status === 'resolved')
    .filter(([, entry]) => !entry.receiptArchivedAt)
    .map(([key, entry]) => ({
      key,
      entry: cloneJson(entry),
      resolvedAt: Number(entry.resolvedAt || entry.sealedAt || Date.now()),
    }));
}

export function markReceiptsArchived(ledger, archivedReceipts, archivedAt) {
  for (const archived of archivedReceipts || []) {
    const entry = ledger?.[archived.key];
    if (!entry || entry.status !== 'resolved') continue;
    entry.receiptArchivedAt = archivedAt;
    if (archived.objectKey) entry.receiptArchiveKey = archived.objectKey;
  }
  return ledger;
}

export function appendSample(samples, sample) {
  const current = samples && typeof samples === 'object'
    ? { ...samples, recent: [...(samples.recent || [])] }
    : { count: 0, recent: [] };
  if (current.recent.at(-1)?.ts === sample.ts) return current;

  current.count = Number(current.count || 0) + 1;
  current.last = sample;
  if (!current.first) current.first = sample;
  if (Number.isFinite(sample.value)) {
    current.min = Number.isFinite(current.min) ? Math.min(current.min, sample.value) : sample.value;
    current.max = Number.isFinite(current.max) ? Math.max(current.max, sample.value) : sample.value;
  }
  current.recent.push(sample);
  if (current.recent.length > MAX_RECENT_SAMPLES) {
    current.recent = current.recent.slice(-MAX_RECENT_SAMPLES);
  }
  return current;
}

function hasSampleAtOrAfterDeadline(samples, deadline) {
  if (!Number.isFinite(deadline)) return false;
  return Array.isArray(samples?.recent)
    && samples.recent.some((sample) => Number(sample?.ts) >= deadline && Number.isFinite(Number(sample?.value)));
}

function createEntry(id, forecast, spec, generatedAt, snapshotAt, deadline) {
  const status = spec.kind === 'judged' ? 'pending-judge' : 'pending';
  return pruneUndefined({
    id,
    key: `${id}@${deadline}`,
    domain: forecast.domain || 'unknown',
    region: forecast.region || '',
    title: forecast.title || '',
    timeHorizon: forecast.timeHorizon || '',
    generationOrigin: forecast.generationOrigin || forecast.origin || 'unknown',
    spec: cloneJson(spec),
    probability: Number(forecast.probability),
    firstSeenProbability: Number(forecast.probability),
    calibration: forecast.calibration ? cloneJson(forecast.calibration) : undefined,
    generatedAt,
    deadline,
    firstSeenAt: snapshotAt,
    lastSeenAt: snapshotAt,
    status,
    samples: { count: 0, recent: [] },
  });
}

function updateOpenWindow(entry, forecast, generatedAt, snapshotAt) {
  if (entry.status !== 'pending' && entry.status !== 'pending-judge') return;
  if (generatedAt >= entry.deadline) return;
  const probability = Number(forecast.probability);
  if (Number.isFinite(probability)) entry.probability = probability;
  entry.lastSeenAt = Math.max(Number(entry.lastSeenAt || 0), snapshotAt);
}

function findOpenWindowKey(ledger, id, generatedAt) {
  return Object.keys(ledger)
    .filter((key) => ledger[key]?.id === id)
    .filter((key) => ledger[key].status === 'pending' || ledger[key].status === 'pending-judge')
    .filter((key) => generatedAt < Number(ledger[key].deadline))
    .sort((a, b) => Number(ledger[a].deadline) - Number(ledger[b].deadline))[0] || null;
}

function normalizeLedger(ledger) {
  const data = unwrapEnvelope(ledger).data;
  if (!data) return {};
  if (Array.isArray(data)) return Object.fromEntries(data.filter(Boolean).map((entry) => [entry.key || `${entry.id}@${entry.deadline}`, entry]));
  if (typeof data === 'object') return data;
  return {};
}

function sortLedger(ledger) {
  return Object.fromEntries(Object.entries(ledger).sort(([a], [b]) => a.localeCompare(b)));
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value ?? {}));
}

function pruneUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined));
}

async function readRedisJson(key) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN');
  const resp = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}`, 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`Redis GET ${key} failed: HTTP ${resp.status}`);
  const payload = await resp.json();
  if (payload.result == null) return null;
  return JSON.parse(payload.result);
}

async function readForecastHistory(limit = 200) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN');
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': CHROME_UA },
    body: JSON.stringify(['LRANGE', HISTORY_KEY, 0, Math.max(0, limit - 1)]),
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`Redis LRANGE ${HISTORY_KEY} failed: HTTP ${resp.status}`);
  const payload = await resp.json();
  return (Array.isArray(payload.result) ? payload.result : [])
    .map((row) => {
      try { return JSON.parse(row); } catch { return null; }
    })
    .filter(Boolean);
}

async function readResolutionFeeds(ledger) {
  const keys = [...new Set(Object.values(ledger)
    .filter((entry) => entry.status === 'pending')
    .map((entry) => entry.spec?.sourceFeed)
    .filter(Boolean))];
  const results = await Promise.allSettled(keys.map(async (key) => [key, await readRedisJson(key)]));
  const pairs = [];
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    if (result.status === 'fulfilled') {
      pairs.push(result.value);
    } else {
      console.warn(`  [forecast-resolutions] feed ${keys[index]} unavailable: ${result.reason?.message || result.reason}`);
    }
  }
  return Object.fromEntries(pairs);
}

async function buildLedgerForRun() {
  const nowMs = Date.now();
  const [existingLedger, history] = await Promise.all([
    readRedisJson(RESOLUTIONS_KEY),
    readForecastHistory(200),
  ]);
  const preLedger = ingestHistory(existingLedger || {}, history, nowMs);
  const feeds = await readResolutionFeeds(preLedger);
  const result = processResolutionCycle(preLedger, [], feeds, nowMs);
  const receiptsForArchive = collectUnarchivedReceipts(result.ledger);
  const archivedReceipts = await appendR2Receipts(receiptsForArchive);
  markReceiptsArchived(result.ledger, archivedReceipts, Date.now());
  console.log(`  Resolution ledger entries: ${Object.keys(result.ledger).length}`);
  console.log(`  Terminal receipts resolved this cycle: ${result.receipts.length}`);
  console.log(`  Terminal receipts queued for R2: ${receiptsForArchive.length}`);
  console.log(`  R2 receipts archived: ${archivedReceipts.length}`);
  return result.ledger;
}

async function dryRun() {
  const nowMs = Date.now();
  const [existingLedger, history] = await Promise.all([
    readRedisJson(RESOLUTIONS_KEY).catch(() => null),
    readForecastHistory(200),
  ]);
  const preLedger = ingestHistory(existingLedger || {}, history, nowMs);
  const feeds = await readResolutionFeeds(preLedger);
  const result = processResolutionCycle(preLedger, [], feeds, nowMs);
  const entries = Object.values(result.ledger);
  const summary = {
    dryRun: true,
    historySnapshots: history.length,
    ledgerEntries: entries.length,
    pending: entries.filter((entry) => entry.status === 'pending').length,
    pendingJudge: entries.filter((entry) => entry.status === 'pending-judge').length,
    resolved: entries.filter((entry) => entry.status === 'resolved').length,
    newReceipts: result.receipts.length,
    scorecardTotals: result.scorecard.totals,
  };
  console.log(JSON.stringify(summary, null, 2));
}

export async function appendR2Receipts(receipts, options = {}) {
  if (!receipts.length) return [];
  const putObject = options.putObject || putR2JsonObject;
  const config = resolveR2StorageConfig(options.env || process.env, { prefixEnv: 'CLOUDFLARE_R2_FORECAST_RESOLUTION_PREFIX' });
  if (!config) {
    console.warn(`  [forecast-resolutions] R2 not configured; skipped ${receipts.length} receipt append(s)`);
    return [];
  }
  const archived = [];
  for (const receipt of receipts) {
    try {
      const day = new Date(receipt.resolvedAt).toISOString().slice(0, 10);
      const safeKey = receipt.key.replace(/[^a-zA-Z0-9@._-]+/g, '_');
      const key = `${config.basePrefix}/forecast-resolutions/${day}/${safeKey}-${receipt.resolvedAt}.json`;
      await putObject(config, key, receipt, {
        kind: 'forecast-resolution',
        outcome: receipt.entry?.outcome || 'unknown',
      });
      archived.push({ key: receipt.key, objectKey: key });
      console.log(`  [forecast-resolutions] R2 receipt: ${key}`);
    } catch (err) {
      console.warn(`  [forecast-resolutions] R2 receipt failed for ${receipt.key}: ${err?.message || err}`);
    }
  }
  return archived;
}

if (DIRECT_RUN && process.argv.includes('--dry-run')) {
  await dryRun();
} else if (DIRECT_RUN) {
  await runSeed('forecast', 'resolutions', RESOLUTIONS_KEY, buildLedgerForRun, {
    // Persistent working ledger: no ttlSeconds by design (#5007 R11).
    validateFn: (ledger) => ledger && typeof ledger === 'object' && !Array.isArray(ledger),
    declareRecords,
    sourceVersion: RESOLUTION_SOURCE_VERSION,
    schemaVersion: RESOLUTION_SCHEMA_VERSION,
    zeroIsValid: true,
    maxStaleMin: 2160,
    fetchPhaseTimeoutMs: 90_000,
    extraKeys: [{
      key: SCORECARD_KEY,
      ttl: SCORECARD_TTL_SECONDS,
      transform: (ledger) => computeScorecard(ledger, Date.now()),
      declareRecords: declareScorecardRecords,
      metaKey: SCORECARD_META_KEY,
      metaCritical: true,
    }],
  });
}
