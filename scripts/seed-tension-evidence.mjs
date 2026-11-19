#!/usr/bin/env node
/**
 * Tension evidence seeder. Reads the strike, airport, military flight, Taiwan
 * Strait and sanctions keys other seeders publish, records one value per
 * tension pair, channel and UTC day for 90 days, and publishes each pair's
 * live readings (scripts/_tension-evidence.mjs). Section of
 * scripts/seed-bundle-derived-signals.mjs (15-minute interval).
 *
 * `--dry-run` reads the same keys, prints each pair's readings, and writes
 * nothing.
 */

import { pathToFileURL } from 'node:url';

import { getRedisCredentials, loadEnvFile, readSeedSnapshot, redisCommand, runSeed } from './_seed-utils.mjs';
import {
  SOURCES,
  TENSION_EVIDENCE_ACTIVATION_KEY,
  TENSION_EVIDENCE_KEY,
  buildEvidencePayload,
  countReadings,
} from './_tension-evidence.mjs';

loadEnvFile(import.meta.url);

// The history is the only copy of up to 90 days of readings, so the key
// outlives the retention window like sanctions:changes:v1.
const TTL_SECONDS = 100 * 86_400;
const READ_TIMEOUT_MS = 15_000;

const readSource = key => readSeedSnapshot(key, { timeoutMs: READ_TIMEOUT_MS });

/** Read every source and its seed-meta clock. A failed read leaves that source unusable. */
export async function readEvidenceSources(read = readSource) {
  const entries = await Promise.all(Object.entries(SOURCES).map(async ([name, { key, metaKey }]) => {
    const [data, meta] = await Promise.all([read(key), read(metaKey)]);
    return [name, { data, fetchedAt: meta?.fetchedAt }];
  }));
  return Object.fromEntries(entries);
}

export function isEvidencePayload(payload) {
  const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  return isRecord(payload) && Number.isFinite(payload.updatedAt) && isRecord(payload.live) && isRecord(payload.days);
}

async function buildTick(nowMs = Date.now()) {
  const [sources, previous] = await Promise.all([
    readEvidenceSources(),
    // Strict: a failed read must not publish over the stored history.
    readSeedSnapshot(TENSION_EVIDENCE_KEY, { strict: true, timeoutMs: READ_TIMEOUT_MS }),
  ]);
  return buildEvidencePayload(sources, previous, nowMs);
}

export function describeReadings(payload) {
  return Object.entries(payload.live).flatMap(([pairId, items]) => [
    pairId,
    ...(items.length ? items : [{ channel: '(no readings)' }]).map(item => {
      if (!('value' in item)) return `    ${item.channel}`;
      const usual = item.baseline == null ? 'no usual yet' : `usual ${item.baseline}`;
      const named = [...item.countries, ...item.airports.map(a => `${a.name} ${a.status}`)].join(', ');
      return `  ${item.notable ? '*' : ' '} ${item.channel}: ${item.value} (${usual})${named ? ` ${named}` : ''}`;
    }),
  ]);
}

export async function dryRun(nowMs = Date.now()) {
  getRedisCredentials();
  const payload = await buildTick(nowMs);
  console.log(`Tension evidence at ${new Date(nowMs).toISOString()} (* = shown in the popup)`);
  for (const line of describeReadings(payload)) console.log(line);
  console.log(`History: ${Object.keys(payload.days).length} days, ${countReadings(payload)} live readings`);
  return payload;
}

async function main() {
  getRedisCredentials();
  await runSeed('intelligence', 'tension-evidence', TENSION_EVIDENCE_KEY, () => buildTick(), {
    ttlSeconds: TTL_SECONDS,
    validateFn: isEvidencePayload,
    // Zero readings means every source was unusable: keep the last payload.
    declareRecords: countReadings,
    sourceVersion: 'tension-evidence-v1',
    schemaVersion: 1,
    maxStaleMin: 45,
    afterPublish: async () => {
      const { url, token } = getRedisCredentials();
      await redisCommand(url, token, ['SET', TENSION_EVIDENCE_ACTIVATION_KEY, '1']);
    },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  (process.argv.includes('--dry-run') ? dryRun : main)().catch(err => {
    console.error('FATAL:', err.message || err);
    process.exit(1);
  });
}
