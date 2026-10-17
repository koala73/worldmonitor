#!/usr/bin/env node
/**
 * Label calibration seeder (#9097). Section of seed-bundle-derived-signals.
 *
 * The full English digest logs, per UTC day, each new story's first coverage
 * label and every later change of it (trust:calibration-events:v1:<day>, kept
 * 21 days). Once every story first labelled on a day has passed + 7 days, this
 * seeder folds that day's events into one immutable day record
 * (trust:calibration-day:v1:<day>, kept 400 days, written once with SET NX),
 * then publishes the monthly table for the last 13 months
 * (trust:label-calibration:v1) from those records only.
 *
 * The rules are in shared/label-calibration.js; this file only moves data.
 * `--dry-run` reads the same keys, prints the table, and writes nothing.
 */

import { getRedisCredentials, loadEnvFile, redisCommand, runSeed } from './_seed-utils.mjs';
import { defaultRedisPipeline } from './lib/_upstash-pipeline.mjs';
import {
  CALIBRATION_DAY_TTL_S,
  CALIBRATION_EVENTS_MAX,
  LABEL_CALIBRATION_KEY,
  buildCalibrationTable,
  buildCohortDay,
  calibrationDayKey,
  calibrationEventsKey,
  calibrationTableDays,
  eventDaysFor,
  finalizableDays,
  parseCalibrationEvent,
  parseCalibrationTable,
  parseCohortDay,
} from './shared/label-calibration.js';

loadEnvFile(import.meta.url);

export { LABEL_CALIBRATION_KEY };
export const LABEL_CALIBRATION_SEED_META_KEY = 'seed-meta:trust:label-calibration';
export const LABEL_CALIBRATION_ACTIVATION_KEY = 'seed-activated:trust:label-calibration';
export const LABEL_CALIBRATION_SOURCE_VERSION = 'label-calibration-v1';
export const LABEL_CALIBRATION_SCHEMA_VERSION = 1;
/** Published every 6 hours; a week of TTL keeps the last table through a long seeder outage. */
const TABLE_TTL_SECONDS = 7 * 24 * 60 * 60;
const READ_CHUNK = 100;

function rowsOrThrow(rows, expected, what) {
  if (!Array.isArray(rows) || rows.length !== expected) throw new Error(`${what}: Redis pipeline failed`);
  for (const row of rows) {
    if (row?.error != null) throw new Error(`${what}: ${row.error}`);
  }
  return rows.map((row) => row?.result);
}

async function chunked(pipeline, commands, what) {
  const out = [];
  for (let i = 0; i < commands.length; i += READ_CHUNK) {
    const chunk = commands.slice(i, i + READ_CHUNK);
    out.push(...rowsOrThrow(await pipeline(chunk), chunk.length, what));
  }
  return out;
}

/**
 * Write a record for every finalizable cohort day that has none yet. A day
 * whose own list is empty (before the digest logged events, or a day it did
 * not run) gets no record. Returns the days written.
 */
export async function finalizeCohortDays(nowMs, pipeline = defaultRedisPipeline) {
  const candidates = finalizableDays(nowMs);
  if (candidates.length === 0) return [];
  const exists = await chunked(pipeline, candidates.map((day) => ['EXISTS', calibrationDayKey(day)]), 'day record check');
  const pending = candidates.filter((_, i) => Number(exists[i]) === 0);
  if (pending.length === 0) return [];

  const lists = new Map();
  async function readLists(days) {
    const missing = days.filter((day) => !lists.has(day));
    if (missing.length === 0) return;
    const lengths = await chunked(pipeline, missing.map((day) => ['LLEN', calibrationEventsKey(day)]), 'event list length');
    for (let i = 0; i < missing.length; i += 1) {
      const length = Number(lengths[i]) || 0;
      if (length === 0) {
        lists.set(missing[i], { length: 0, events: [] });
        continue;
      }
      const [members] = rowsOrThrow(await pipeline([['LRANGE', calibrationEventsKey(missing[i]), 0, -1]]), 1, 'event list read');
      const events = (Array.isArray(members) ? members : []).map(parseCalibrationEvent);
      lists.set(missing[i], { length, events });
    }
  }

  const writes = [];
  const written = [];
  for (const day of pending) {
    const days = eventDaysFor(day);
    await readLists(days);
    // Lists before this day's predecessor are not needed again (pending is oldest first).
    for (const cached of [...lists.keys()]) if (cached < days[0]) lists.delete(cached);
    if (lists.get(day).length === 0) continue;
    // The day before only resolves a first label logged twice; a capped list
    // from the day or any later checkpoint day would undercount or misstate outcomes.
    const incomplete = days.slice(1).some((d) => lists.get(d).length >= CALIBRATION_EVENTS_MAX);
    const events = days.flatMap((d) => lists.get(d).events);
    const record = buildCohortDay(day, events, { incomplete });
    writes.push(['SET', calibrationDayKey(day), JSON.stringify(record), 'EX', CALIBRATION_DAY_TTL_S, 'NX']);
    written.push(day);
  }
  if (writes.length > 0) await chunked(pipeline, writes, 'day record write');
  return written;
}

/** Every stored day record the table covers. A malformed record is skipped, never repaired. */
export async function readCohortDays(nowMs, pipeline = defaultRedisPipeline) {
  const days = calibrationTableDays(nowMs);
  const raws = await chunked(pipeline, days.map((day) => ['GET', calibrationDayKey(day)]), 'day record read');
  const records = [];
  raws.forEach((raw, i) => {
    if (raw == null) return;
    const record = parseCohortDay(raw);
    if (!record || record.day !== days[i]) {
      console.warn(`  [label-calibration] skipping malformed record for ${days[i]}`);
      return;
    }
    records.push(record);
  });
  return records;
}

export async function buildLabelCalibration(nowMs, { pipeline = defaultRedisPipeline, write = true } = {}) {
  const finalized = write ? await finalizeCohortDays(nowMs, pipeline) : [];
  const records = await readCohortDays(nowMs, pipeline);
  const table = buildCalibrationTable(records, { generatedAt: nowMs });
  console.log(`  [label-calibration] finalized ${finalized.length} day(s); ${records.length} day record(s); ${table.months.length} month(s)`);
  return table;
}

export function declareRecords(table) {
  return table.months.reduce((sum, month) => sum + month.cohortDays, 0);
}

async function dryRun() {
  getRedisCredentials();
  const table = await buildLabelCalibration(Date.now(), { write: false });
  console.log(JSON.stringify(table, null, 2));
}

async function main() {
  getRedisCredentials();
  await runSeed('trust', 'label-calibration', LABEL_CALIBRATION_KEY, () => buildLabelCalibration(Date.now()), {
    validateFn: (table) => parseCalibrationTable(table) !== null,
    ttlSeconds: TABLE_TTL_SECONDS,
    declareRecords,
    // No finalized cohort day yet (the first eight days after launch) is a valid, empty table.
    zeroIsValid: true,
    sourceVersion: LABEL_CALIBRATION_SOURCE_VERSION,
    schemaVersion: LABEL_CALIBRATION_SCHEMA_VERSION,
    maxStaleMin: 1080,
    lockTtlMs: 180_000,
    afterPublish: async () => {
      const { url, token } = getRedisCredentials();
      await redisCommand(url, token, ['SET', LABEL_CALIBRATION_ACTIVATION_KEY, '1']);
    },
  });
}

if (process.argv[1]?.endsWith('seed-label-calibration.mjs')) {
  (process.argv.includes('--dry-run') ? dryRun : main)().catch((err) => {
    console.error('FATAL:', err.message || err);
    process.exit(1);
  });
}
