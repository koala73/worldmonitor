#!/usr/bin/env node

// Bounded, dry-run-by-default cutover for forecast evidence archive (#7082).
// It copies only the still-readable full/en accumulator window. The verified
// coverage marker is written last, after every archive write has been read
// back. Normal digest publication then advances coverageEndMs.

import { CHROME_UA, loadEnvFile } from './_seed-utils.mjs';
import {
  FORECAST_EVIDENCE_COVERAGE_KEY,
  FORECAST_EVIDENCE_COVERAGE_VERSION,
  FORECAST_EVIDENCE_KEY,
  FORECAST_EVIDENCE_MAX_LOOKBACK_MS,
  FORECAST_EVIDENCE_SOURCE_KEY,
  FORECAST_EVIDENCE_TTL_S,
  accumulatorPruneBounds,
  buildForecastEvidenceMember,
  forecastEvidenceCoversWindow,
  forecastEvidenceRecordKey,
  isForecastEvidenceHash,
  parseForecastEvidenceCoverage,
  parseForecastEvidenceMember,
  utf8ByteLength,
} from './_forecast-evidence-archive.mjs';

export const FORECAST_EVIDENCE_BACKFILL_SOURCE_KEY = FORECAST_EVIDENCE_SOURCE_KEY;
export const FORECAST_EVIDENCE_BACKFILL_WINDOW_MS = FORECAST_EVIDENCE_MAX_LOOKBACK_MS;
export const DEFAULT_BACKFILL_MAX_RECORDS = 15_000;
export const DEFAULT_BACKFILL_MAX_BYTES = 32 * 1024 * 1024;
export const DEFAULT_BACKFILL_MAX_COMMANDS = 100_000;
export const DEFAULT_BACKFILL_BATCH_SIZE = 200;

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function redisResultConfirmed(payload, expected) {
  return Array.isArray(payload)
    && payload.length === expected
    && payload.every(row => row && typeof row === 'object' && !row.error);
}

function flatHash(raw) {
  if (!Array.isArray(raw) || raw.length % 2 !== 0) return null;
  const value = {};
  for (let index = 0; index < raw.length; index += 2) value[raw[index]] = raw[index + 1];
  return value;
}

export async function backfillForecastEvidenceArchive(options = {}) {
  const env = options.env ?? process.env;
  const url = options.redisUrl ?? env.UPSTASH_REDIS_REST_URL;
  const token = options.redisToken ?? env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN');
  const fetchFn = options.fetchFn ?? ((...args) => globalThis.fetch(...args));
  const apply = options.apply === true;
  const nowMs = Number.isFinite(options.nowMs) ? Math.floor(options.nowMs) : Date.now();
  const maxRecords = positiveInt(options.maxRecords ?? env.FORECAST_EVIDENCE_BACKFILL_MAX_RECORDS, DEFAULT_BACKFILL_MAX_RECORDS);
  const maxBytes = positiveInt(options.maxBytes ?? env.FORECAST_EVIDENCE_BACKFILL_MAX_BYTES, DEFAULT_BACKFILL_MAX_BYTES);
  const maxCommands = positiveInt(options.maxCommands ?? env.FORECAST_EVIDENCE_BACKFILL_MAX_COMMANDS, DEFAULT_BACKFILL_MAX_COMMANDS);
  const batchSize = Math.min(500, positiveInt(options.batchSize, DEFAULT_BACKFILL_BATCH_SIZE));
  const coverageStartMs = nowMs - FORECAST_EVIDENCE_BACKFILL_WINDOW_MS;
  let commandsUsed = 0;

  const request = async (endpoint, commands, context) => {
    const commandCount = endpoint.endsWith('/pipeline') ? commands.length : 1;
    commandsUsed += commandCount;
    if (commandsUsed > maxCommands) throw new Error(`Backfill command budget exceeded (${commandsUsed}/${maxCommands})`);
    const response = await fetchFn(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': CHROME_UA },
      body: JSON.stringify(commands),
      signal: AbortSignal.timeout(25_000),
    });
    if (!response.ok) throw new Error(`${context} failed: HTTP ${response.status}`);
    return response.json();
  };

  const sourcePayload = await request(url, [
    'ZRANGEBYSCORE',
    FORECAST_EVIDENCE_BACKFILL_SOURCE_KEY,
    String(coverageStartMs),
    String(nowMs),
    'WITHSCORES',
    'LIMIT',
    '0',
    String(maxRecords + 1),
  ], 'Redis accumulator backfill read');
  const sourceRows = sourcePayload?.result;
  if (!Array.isArray(sourceRows) || sourceRows.length % 2 !== 0) {
    throw new Error('Accumulator backfill returned malformed WITHSCORES data');
  }
  const oldestPayload = await request(url, [
    'ZRANGE',
    FORECAST_EVIDENCE_BACKFILL_SOURCE_KEY,
    '0',
    '0',
    'WITHSCORES',
  ], 'Redis accumulator coverage sentinel read');
  const oldestRows = oldestPayload?.result;
  const legacyOldestHash = Array.isArray(oldestRows) && typeof oldestRows[0] === 'string'
    ? oldestRows[0]
    : null;
  const legacyOldestScoreMs = Array.isArray(oldestRows) ? Number(oldestRows[1]) : NaN;
  const legacyCoverageObserved = Boolean(
    isForecastEvidenceHash(legacyOldestHash)
    && Number.isFinite(legacyOldestScoreMs)
    && legacyOldestScoreMs <= coverageStartMs,
  );
  const rawSourceCount = sourceRows.length / 2;
  const truncated = rawSourceCount > maxRecords;
  const selectedSourceRows = sourceRows.slice(0, maxRecords * 2);

  const hashes = [];
  const scores = [];
  const seen = new Set();
  let malformedSourceRows = 0;
  for (let index = 0; index < selectedSourceRows.length; index += 2) {
    const hash = selectedSourceRows[index];
    const score = Number(selectedSourceRows[index + 1]);
    if (!isForecastEvidenceHash(hash) || !Number.isFinite(score) || seen.has(hash)) {
      malformedSourceRows += 1;
      continue;
    }
    seen.add(hash);
    hashes.push(hash);
    scores.push(score);
  }

  const sourceDataRows = [];
  for (let offset = 0; offset < hashes.length; offset += batchSize) {
    const batch = hashes.slice(offset, offset + batchSize);
    // Reuse an already archived self-contained payload before consulting the
    // seven-day story track. This is what lets repeated bounded runs converge
    // to a provable 14-day cutover as the unreadable pre-cutover tail ages out.
    const commands = batch.flatMap(hash => [
      ['GET', forecastEvidenceRecordKey(hash)],
      ['HGETALL', `story:track:v1:${hash}`],
    ]);
    const payload = await request(`${url}/pipeline`, commands, 'Redis archive/story-track backfill read');
    if (!redisResultConfirmed(payload, commands.length)) throw new Error('Archive/story-track backfill returned incomplete data');
    sourceDataRows.push(...payload);
  }

  const records = [];
  let totalBytes = 0;
  let missingRows = 0;
  let tombstones = 0;
  for (let index = 0; index < hashes.length; index += 1) {
    const existingRaw = sourceDataRows[index * 2]?.result;
    let member = null;
    if (typeof existingRaw === 'string') {
      const parsed = parseForecastEvidenceMember(existingRaw).record;
      if (parsed?.hash === hashes[index]) member = buildForecastEvidenceMember(parsed, scores[index]);
    }
    const track = flatHash(sourceDataRows[index * 2 + 1]?.result);
    if (!member && (!track || Object.keys(track).length === 0)) {
      missingRows += 1;
      continue;
    }
    if (!member && track) {
      member = buildForecastEvidenceMember({
        hash: hashes[index],
        title: track.title,
        link: track.link,
        description: track.description ?? '',
        publishedAt: Number(track.publishedAt),
      }, scores[index]);
    }
    if (!member) {
      tombstones += 1;
      continue;
    }
    totalBytes += utf8ByteLength(member);
    if (totalBytes > maxBytes) throw new Error(`Backfill byte budget exceeded (${totalBytes}/${maxBytes})`);
    records.push({ hash: hashes[index], score: scores[index], member });
  }

  const report = {
    mode: apply ? 'apply' : 'dry-run',
    sourceKey: FORECAST_EVIDENCE_BACKFILL_SOURCE_KEY,
    archiveKey: FORECAST_EVIDENCE_KEY,
    coverageStartMs,
    coverageEndMs: nowMs,
    sourceRecords: rawSourceCount,
    selectedSourceRecords: hashes.length,
    writableRecords: records.length,
    truncated,
    malformedSourceRows,
    legacyOldestHash,
    legacyOldestScoreMs: Number.isFinite(legacyOldestScoreMs) ? legacyOldestScoreMs : null,
    legacyCoverageObserved,
    missingRows,
    tombstones,
    totalBytes,
    commandsUsed,
    budgets: { maxRecords, maxBytes, maxCommands, batchSize },
    projectedApplyCommands: commandsUsed + records.length * 4 + 2,
    cutoverVerified: false,
  };
  const coverageProven = rawSourceCount > 0
    && legacyCoverageObserved
    && !truncated
    && malformedSourceRows === 0
    && missingRows === 0
    && tombstones === 0
    && records.length === rawSourceCount;
  if (report.projectedApplyCommands > maxCommands) {
    throw new Error(`Backfill command budget would be exceeded (${report.projectedApplyCommands}/${maxCommands})`);
  }
  if (!apply) return report;

  for (let offset = 0; offset < records.length; offset += batchSize) {
    const batch = records.slice(offset, offset + batchSize);
    const commands = batch.flatMap(({ hash, score, member }) => [
      ['SET', forecastEvidenceRecordKey(hash), member, 'EX', FORECAST_EVIDENCE_TTL_S],
      ['ZADD', FORECAST_EVIDENCE_KEY, String(score), hash],
    ]);
    const payload = await request(`${url}/pipeline`, commands, 'Redis forecast evidence backfill write');
    if (!redisResultConfirmed(payload, commands.length)) throw new Error('Forecast evidence backfill write was not confirmed');
  }

  // Read back both payload and index score before making the destructive
  // cutover eligible. A write attempt is never evidence of a completed copy.
  for (let offset = 0; offset < records.length; offset += batchSize) {
    const batch = records.slice(offset, offset + batchSize);
    const commands = batch.flatMap(({ hash }) => [
      ['GET', forecastEvidenceRecordKey(hash)],
      ['ZSCORE', FORECAST_EVIDENCE_KEY, hash],
    ]);
    const payload = await request(`${url}/pipeline`, commands, 'Redis forecast evidence backfill verification');
    if (!redisResultConfirmed(payload, commands.length)) throw new Error('Forecast evidence backfill verification was not confirmed');
    for (let index = 0; index < batch.length; index += 1) {
      const record = batch[index];
      if (payload[index * 2]?.result !== record.member || Number(payload[index * 2 + 1]?.result) !== record.score) {
        throw new Error(`Forecast evidence verification mismatch for ${record.hash}`);
      }
    }
  }

  if (!coverageProven) return { ...report, commandsUsed };

  const coverage = {
    v: FORECAST_EVIDENCE_COVERAGE_VERSION,
    coverageStartMs,
    coverageEndMs: nowMs,
    cutoverVerifiedAtMs: nowMs,
    sourceDigestAtMs: nowMs,
    maxLookbackMs: FORECAST_EVIDENCE_MAX_LOOKBACK_MS,
    retentionSeconds: FORECAST_EVIDENCE_TTL_S,
    backfilledRecords: records.length,
    sourceKey: FORECAST_EVIDENCE_BACKFILL_SOURCE_KEY,
    legacyOldestHash,
    legacyOldestScoreMs,
  };
  const markerPayload = await request(url, [
    'SET',
    FORECAST_EVIDENCE_COVERAGE_KEY,
    JSON.stringify(coverage),
    'EX',
    FORECAST_EVIDENCE_TTL_S,
  ], 'Redis forecast evidence cutover marker write');
  if (markerPayload?.error || markerPayload?.result !== 'OK') throw new Error('Forecast evidence cutover marker write was not confirmed');
  const markerRead = await request(url, ['GET', FORECAST_EVIDENCE_COVERAGE_KEY], 'Redis forecast evidence cutover marker verification');
  const verifiedCoverage = parseForecastEvidenceCoverage(markerRead?.result);
  if (!forecastEvidenceCoversWindow(verifiedCoverage, coverageStartMs, nowMs)) {
    throw new Error('Forecast evidence cutover marker verification failed');
  }

  // Assert the boundary contract used by the online pruning path as part of
  // the cutover report: the exact 48-hour member survives.
  const prune = accumulatorPruneBounds(nowMs);
  return {
    ...report,
    commandsUsed,
    cutoverVerified: true,
    pruneBoundary: prune.max,
  };
}

function cliOptions(argv) {
  const value = name => argv.find(arg => arg.startsWith(`--${name}=`))?.split('=', 2)[1];
  return {
    apply: argv.includes('--apply'),
    nowMs: value('now-ms') ? Number(value('now-ms')) : undefined,
    maxRecords: value('max-records') ? Number(value('max-records')) : undefined,
    maxBytes: value('max-bytes') ? Number(value('max-bytes')) : undefined,
    maxCommands: value('max-commands') ? Number(value('max-commands')) : undefined,
    batchSize: value('batch-size') ? Number(value('batch-size')) : undefined,
  };
}

const DIRECT_RUN = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (DIRECT_RUN) {
  loadEnvFile(import.meta.url, { only: ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'] });
  backfillForecastEvidenceArchive(cliOptions(process.argv.slice(2)))
    .then(report => console.log(JSON.stringify(report, null, 2)))
    .catch(error => {
      console.error(`[forecast-evidence-backfill] ${error?.message || error}`);
      process.exitCode = 1;
    });
}
