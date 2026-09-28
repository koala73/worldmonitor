#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { loadEnvFile, getRedisCredentials, redisCommand } from './_seed-utils.mjs';

const require = createRequire(import.meta.url);
const { PREFIX, PROVIDERS, RETENTION_DAYS, decodePizzintHistoryRecord, evaluatePizzintHistory } = require('./shared/pizzint-history.cjs');
const MAX_REPORT_RECORDS = 4000 * (RETENTION_DAYS + 1) * PROVIDERS.length;
const MAX_REPORT_BYTES = MAX_REPORT_RECORDS * 1024;

function parseArgs(argv) {
  const options = { input: null, asOf: new Date().toISOString(), days: RETENTION_DAYS, includeSuspectZeros: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--input') options.input = argv[++i];
    else if (arg === '--as-of') options.asOf = argv[++i];
    else if (arg === '--days') options.days = Number(argv[++i]);
    // A zero reading that contradicts the provider's forecast is withheld from
    // the baseline by default, matching the live index. Pass this to fold those
    // readings in and see what the retained observations say on their own.
    else if (arg === '--include-suspect-zeros') options.includeSuspectZeros = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (options.input === undefined || options.asOf === undefined || !Number.isInteger(options.days) || options.days < 1 || options.days > 90) throw new Error('usage: evaluate-pizzint-history [--input fixture.json] [--as-of ISO] [--days 1..90] [--include-suspect-zeros]');
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(options.asOf) || !Number.isFinite(Date.parse(options.asOf))) throw new Error('--as-of must be an ISO timestamp with an explicit timezone');
  return options;
}

function utcDates(asOf, days) {
  const end = Date.parse(asOf);
  const dates = [];
  for (let offset = 0; offset <= days; offset++) dates.push(new Date(end - offset * 86400000).toISOString().slice(0, 10));
  return dates;
}

function appendHash(records, result, counters, key) {
  if (!Array.isArray(result) || result.length % 2 !== 0) throw new Error(`Redis HGETALL returned an invalid result for ${key}`);
  for (let i = 0; i < result.length; i += 2) {
    const value = result[i + 1];
    counters.records++;
    counters.bytes += Buffer.byteLength(String(value));
    if (counters.records > MAX_REPORT_RECORDS) throw new Error(`history read exceeds ${MAX_REPORT_RECORDS} records`);
    if (counters.bytes > MAX_REPORT_BYTES) throw new Error(`history read exceeds ${MAX_REPORT_BYTES} bytes`);
    records.push(decodePizzintHistoryRecord(value));
  }
}

async function readLive(options) {
  loadEnvFile(import.meta.url, { only: ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'] });
  const { url, token } = getRedisCredentials();
  if (!url || !token) throw new Error('Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN');
  const keys = utcDates(options.asOf, options.days).flatMap((date) => PROVIDERS.map((provider) => `${PREFIX}:${provider}:${date}`));
  const records = [];
  const counters = { records: 0, bytes: 0 };
  for (let i = 0; i < keys.length; i += 4) {
    const batch = keys.slice(i, i + 4);
    let results;
    try {
      results = await Promise.all(batch.map((key) => redisCommand(url, token, ['HGETALL', key], { label: 'PizzINT history read' })));
    } catch {
      throw new Error('Redis history read failed');
    }
    results.forEach((result, index) => appendHash(records, result.result, counters, batch[index]));
  }
  return records;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let records;
  if (options.input) {
    if ((await stat(options.input)).size > MAX_REPORT_BYTES) throw new Error(`fixture exceeds ${MAX_REPORT_BYTES} bytes`);
    const raw = await readFile(options.input, 'utf8');
    if (Buffer.byteLength(raw) > MAX_REPORT_BYTES) throw new Error(`fixture exceeds ${MAX_REPORT_BYTES} bytes`);
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('fixture must be an array of observation records');
    if (parsed.length > MAX_REPORT_RECORDS) throw new Error(`fixture exceeds ${MAX_REPORT_RECORDS} records`);
    records = parsed;
  } else {
    records = await readLive(options);
  }
  const report = evaluatePizzintHistory(records, options);
  if (report.exclusions.invalid > 0) throw new Error('input contains invalid observation records');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`PizzINT history report failed: ${error.message}\n`);
  process.exitCode = 1;
});
