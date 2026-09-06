#!/usr/bin/env node
/**
 * Issue #7782 measurement harness: time the synchronous Jaccard stage of
 * clusterNewsHybrid (clusterNewsCore before the first await) against a
 * representative digest fixture and a deterministic high-diversity case.
 *
 * Usage:
 *   node scripts/profile-news-hybrid-clustering-7782.mjs <digest.json>
 *   node scripts/profile-news-hybrid-clustering-7782.mjs --synthetic-only
 *
 * Does not move clustering onto a worker. Prints a JSON report.
 */
import { readFileSync } from 'node:fs';
import { cpus, hostname, platform, arch, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { bundleProfileInput, budgetEvidence } from './news-clustering-profile-input.mjs';
const { clusterNewsCore, protoItemToNewsItem, getSourceTier } = runInNewContext(bundleProfileInput() + '; NewsClustering');

export const FRAME_BUDGET_MS = 16.7;
export const LONG_TASK_MS = 50;
const SAMPLES = 9;
const WARMUP = 1;

export function isGateCase(name) {
  return name === 'representative-digest' || name.startsWith('high-diversity-');
}

function flattenDigest(digest) {
  const categories = digest?.categories ?? {};
  const items = [];
  const byCategory = {};
  for (const [key, bucket] of Object.entries(categories)) {
    const mapped = (bucket?.items ?? []).map(protoItemToNewsItem);
    byCategory[key] = mapped.length;
    items.push(...mapped);
  }
  const uniqueLinks = new Set(items.map((item) => item.link));
  return { items, byCategory, uniqueLinkCount: uniqueLinks.size };
}

function makeHighDiversity(count) {
  return Array.from({ length: count }, (_, i) => ({
    source: `Outlet${String(i % 47).padStart(2, '0')}`,
    title: `UniqueTopic${i} DistinctEvent${i} Country${i % 173} Marker${i}`,
    link: `https://fixture.test/high-diversity/${i}`,
    pubDate: new Date(Date.UTC(2026, 8, 6, 12, 0, 0) - i * 60_000),
    isAlert: i % 17 === 0,
  }));
}

function makeSharedTokenStress(count) {
  return Array.from({ length: count }, (_, i) => ({
    source: `Outlet${String(i % 31).padStart(2, '0')}`,
    title: `Ukraine Russia China unique${i} extra${i} more${i} token${i}`,
    link: `https://fixture.test/shared-token/${i}`,
    pubDate: new Date(Date.UTC(2026, 8, 6, 12, 0, 0) - i * 60_000),
    isAlert: false,
  }));
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, n) => acc + n, 0);
  return {
    n: sorted.length,
    min: round(sorted[0]),
    median: round(percentile(sorted, 50)),
    p90: round(percentile(sorted, 90)),
    max: round(sorted[sorted.length - 1]),
    mean: round(sum / sorted.length),
  };
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}

function sourceDistribution(items) {
  const counts = new Map();
  for (const item of items) {
    counts.set(item.source, (counts.get(item.source) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return {
    uniqueSources: counts.size,
    top10: ranked.slice(0, 10).map(([source, count]) => ({ source, count })),
  };
}

function dateDistribution(items) {
  const times = items.map((item) => item.pubDate.getTime()).filter(Number.isFinite).sort((a, b) => a - b);
  if (times.length === 0) return { count: 0 };
  const newest = times[times.length - 1];
  const oldest = times[0];
  const hourBuckets = new Map();
  for (const t of times) {
    const hour = Math.floor((newest - t) / 3_600_000);
    const key = hour <= 1 ? '0-1h' : hour <= 6 ? '1-6h' : hour <= 24 ? '6-24h' : hour <= 72 ? '1-3d' : '>3d';
    hourBuckets.set(key, (hourBuckets.get(key) ?? 0) + 1);
  }
  return {
    count: times.length,
    oldest: new Date(oldest).toISOString(),
    newest: new Date(newest).toISOString(),
    spanHours: round((newest - oldest) / 3_600_000),
    recency: Object.fromEntries(hourBuckets),
  };
}

function timeSync(items, samples = SAMPLES, warmup = WARMUP) {
  const timings = [];
  let lastClusters = [];
  for (let i = 0; i < warmup + samples; i++) {
    const start = performance.now();
    lastClusters = clusterNewsCore(items, getSourceTier);
    const elapsed = performance.now() - start;
    if (i >= warmup) timings.push(elapsed);
  }
  return { clusters: lastClusters, timings };
}

function timeSerialization(items, clusters) {
  const timings = [];
  let itemBytes = 0;
  let clusterBytes = 0;
  for (let i = 0; i < WARMUP + SAMPLES; i++) {
    const start = performance.now();
    const itemJson = JSON.stringify(items);
    JSON.parse(itemJson);
    const clusterJson = JSON.stringify(clusters);
    JSON.parse(clusterJson);
    const elapsed = performance.now() - start;
    itemBytes = Buffer.byteLength(itemJson);
    clusterBytes = Buffer.byteLength(clusterJson);
    if (i >= WARMUP) timings.push(elapsed);
  }
  return { timings, itemBytes, clusterBytes };
}

async function profileCase(name, items) {
  const sync = timeSync(items);
  const serialization = timeSerialization(items, sync.clusters);
  const syncStats = summarize(sync.timings);
  return {
    name,
    itemCount: items.length,
    clusterCount: sync.clusters.length,
    singletonClusters: sync.clusters.filter((c) => c.sourceCount === 1).length,
    multiSourceClusters: sync.clusters.filter((c) => c.sourceCount > 1).length,
    sources: sourceDistribution(items),
    dates: dateDistribution(items),
    syncMainThreadMs: syncStats,
    serializationMs: summarize(serialization.timings),
    serializationBytes: {
      items: serialization.itemBytes,
      clusters: serialization.clusterBytes,
    },
    ...budgetEvidence(sync.timings),
  };
}

function hostInfo() {
  const cpu = cpus()[0];
  return {
    hostname: hostname(),
    platform: platform(),
    arch: arch(),
    node: process.version,
    cpuModel: cpu?.model ?? 'unknown',
    cpuCount: cpus().length,
    totalMemGb: round(totalmem() / 1024 ** 3),
    capturedAt: new Date().toISOString(),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const syntheticOnly = args.includes('--synthetic-only');
  const digestPath = args.find((arg) => !arg.startsWith('--'));
  const cases = [];

  if (!syntheticOnly) {
    if (!digestPath) {
      console.error('usage: node scripts/profile-news-hybrid-clustering-7782.mjs <digest.json>');
      process.exit(2);
    }
    const digest = JSON.parse(readFileSync(digestPath, 'utf8'));
    const flattened = flattenDigest(digest);
    const representative = {
      ...(await profileCase('representative-digest', flattened.items)),
      categoryCounts: flattened.byCategory,
      uniqueLinkCount: flattened.uniqueLinkCount,
      generatedAt: digest.generatedAt ?? null,
      digestPath,
    };
    cases.push(representative);
  }

  cases.push(await profileCase('high-diversity-1500', makeHighDiversity(1500)));
  cases.push(await profileCase('shared-token-stress-1500', makeSharedTokenStress(1500)));
  cases.push(await profileCase('high-diversity-1000', makeHighDiversity(1000)));

  const gateCases = cases.filter((row) => isGateCase(row.name));
  const justified = gateCases.some((row) => row.repeatableBudgetExceedance);
  const report = {
    issue: 7782,
    host: hostInfo(),
    budgets: { frameMs: FRAME_BUDGET_MS, longTaskMs: LONG_TASK_MS },
    samplesPerCase: SAMPLES,
    warmup: WARMUP,
    cases,
    gate: {
      isolatedStageHasRepeatableBudgetExceedance: justified,
      recommendation: justified
        ? 'requires-dashboard-attribution'
        : 'stop-without-moving-work',
    },
  };
  console.log(JSON.stringify(report, null, 2));
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
