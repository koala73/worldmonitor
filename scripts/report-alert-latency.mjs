#!/usr/bin/env node
/**
 * How long realtime news alerts take to reach the queue, by stage. Read-only.
 *
 *   node scripts/report-alert-latency.mjs              # last 24 hours
 *   node scripts/report-alert-latency.mjs --hours 168  # last 7 days
 *   node scripts/report-alert-latency.mjs --strict     # exit 1 if build-to-queue p90 is over budget,
 *                                                      # or if nothing measured that stage
 *
 * Two sources:
 *   shadow:score-log:v5     written by the notification relay for every
 *                           rss_alert it dequeues. Gives publisher timestamp to
 *                           queue, the end-to-end figure.
 *   relay:alert-latency:v1  written by the ais-relay classify pass for every
 *                           alert it sends to the queue. Adds the stages:
 *                           story tracking's first sight to queue, and digest
 *                           build to queue (the stage the relay owns).
 *
 * Build to queue should sit well under the budget in
 * scripts/lib/classify-digest-request.cjs. If its p90 climbs back toward
 * 15 minutes, the build watch has stopped firing and alerts are waiting for
 * the timed cycle again.
 */
import { createRequire } from 'node:module';

import { loadEnvFile } from './_env-file.mjs';
import { getRedisCredentials } from './_seed-utils.mjs';

const require = createRequire(import.meta.url);
const { BUILD_TO_QUEUE_BUDGET_MS, summarizeAlertLatency, strictLatencyVerdict } = require('./lib/classify-digest-request.cjs');

const SCORE_LOG_KEY = 'shadow:score-log:v5';
const LATENCY_KEY = 'relay:alert-latency:v1';
const DELIVERABLE_SCORE = 82;

function parseArgs(argv) {
  const hoursAt = argv.indexOf('--hours');
  const hours = hoursAt === -1 ? 24 : Number(argv[hoursAt + 1]);
  if (!Number.isFinite(hours) || hours <= 0) throw new Error('--hours needs a positive number');
  return { hours, strict: argv.includes('--strict') };
}

async function readRange(url, token, key, fromMs) {
  const res = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'worldmonitor-alert-latency-report/1.0' },
    body: JSON.stringify([['ZRANGEBYSCORE', key, String(fromMs), '+inf']]),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${key}: HTTP ${res.status}`);
  const [row] = await res.json();
  if (row?.error) throw new Error(`${key}: ${row.error}`);
  return (row?.result ?? []).flatMap((member) => {
    try { return [JSON.parse(member)]; } catch { return []; }
  });
}

const minutes = (ms) => (ms === null ? 'n/a' : (ms / 60_000).toFixed(1));

function printStage(label, stage) {
  console.log(`  ${label.padEnd(34)} n=${String(stage.n).padStart(5)}  p50=${minutes(stage.p50).padStart(6)}  p90=${minutes(stage.p90).padStart(6)}  max=${minutes(stage.max).padStart(6)}  (minutes)`);
}

const SLICES = [
  ['all alerts', () => true],
  ['critical', (r) => r.severity === 'critical'],
  [`critical, score >= ${DELIVERABLE_SCORE}`, (r) => r.severity === 'critical' && r.importanceScore >= DELIVERABLE_SCORE],
];

async function main() {
  const { hours, strict } = parseArgs(process.argv.slice(2));
  loadEnvFile(import.meta.url);
  const { url, token } = getRedisCredentials();
  const fromMs = Date.now() - hours * 60 * 60 * 1000;

  const scoreLog = (await readRange(url, token, SCORE_LOG_KEY, fromMs))
    .filter((r) => r.eventType === 'rss_alert' && r.publishedAt > 0)
    .map((r) => ({ ...r, publishToQueueMs: r.ts - r.publishedAt }));
  console.log(`Publisher timestamp to queue, last ${hours}h (${SCORE_LOG_KEY})`);
  for (const [label, keep] of SLICES) printStage(label, summarizeAlertLatency(scoreLog.filter(keep)).publishToQueue);

  const samples = await readRange(url, token, LATENCY_KEY, fromMs);
  console.log(`\nBy stage, last ${hours}h (${LATENCY_KEY})`);
  if (samples.length === 0) {
    console.log('  no samples: the relay build with the latency record has not queued an alert in this window');
  }
  for (const [label, keep] of samples.length === 0 ? [] : SLICES) {
    const summary = summarizeAlertLatency(samples.filter(keep));
    console.log(` ${label} (${summary.count}, ${summary.overBudget} over the ${minutes(BUILD_TO_QUEUE_BUDGET_MS)}-minute build-to-queue budget)`);
    printStage('publisher timestamp -> queue', summary.publishToQueue);
    printStage('story tracking first sight -> queue', summary.seenToQueue);
    printStage('digest build -> queue', summary.buildToQueue);
  }
  if (strict) {
    const verdict = strictLatencyVerdict(summarizeAlertLatency(samples));
    if (!verdict.ok) {
      console.error(`\n${verdict.reason}`);
      process.exitCode = 1;
    }
  }
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
