#!/usr/bin/env node
/**
 * Calibration runner for the embedding dedup threshold.
 *
 * Takes a labelled pairs fixture, calls the LIVE embedder (OpenRouter
 * /api/v1/embeddings, openai/text-embedding-3-small, 512 dims), and
 * prints per-pair cosine + a histogram + the recommended threshold
 * (midpoint of the largest bimodal gap between same-event and
 * different-event distributions).
 *
 * Usage:
 *   OPENROUTER_API_KEY=... node scripts/tools/calibrate-dedup-threshold.mjs \
 *     --input docs/calibration/brief-dedup-embedding-2026-04.pairs.json \
 *     [--output docs/calibration/brief-dedup-embedding-2026-04.histogram.json]
 *
 * Fixture shape:
 *   [
 *     { "a": "Iran closes Hormuz",
 *       "b": "Tehran moves to shut Strait of Hormuz",
 *       "label": "same" },
 *     { "a": "Iran nuclear talks resume",
 *       "b": "Oil prices rise on Iran nuclear talks optimism",
 *       "label": "different" }
 *   ]
 *
 * Not a cron. Operator-run before flipping DIGEST_DEDUP_COSINE_THRESHOLD.
 * Commits: the fixture file, the histogram output, and the chosen
 * threshold, all under docs/calibration/.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { embedBatch, cosineSimilarity, normalizeForEmbedding } from '../lib/brief-embedding.mjs';

function parseArgs(argv) {
  const args = { input: null, output: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--input') args.input = argv[++i];
    else if (argv[i] === '--output') args.output = argv[++i];
  }
  return args;
}

function buildHistogram(pairs, buckets = 20) {
  const step = 1 / buckets;
  const bins = { same: new Array(buckets).fill(0), different: new Array(buckets).fill(0) };
  for (const p of pairs) {
    const b = Math.min(buckets - 1, Math.max(0, Math.floor(p.cosine / step)));
    if (p.label === 'same') bins.same[b] += 1;
    else bins.different[b] += 1;
  }
  const edges = Array.from({ length: buckets + 1 }, (_, i) => Number((i * step).toFixed(3)));
  return { edges, bins };
}

/**
 * Midpoint-of-gap heuristic: find the widest cosine range where
 * `same` stops and `different` hasn't started yet (or vice versa),
 * return its midpoint. Falls back to 0.60 if no clean gap exists.
 */
function recommendThreshold(pairs) {
  const sames = pairs.filter((p) => p.label === 'same').map((p) => p.cosine).sort((a, b) => a - b);
  const diffs = pairs.filter((p) => p.label === 'different').map((p) => p.cosine).sort((a, b) => a - b);
  if (sames.length === 0 || diffs.length === 0) return 0.60;
  const minSame = sames[0];
  const maxDiff = diffs[diffs.length - 1];
  if (minSame > maxDiff) {
    return Number(((minSame + maxDiff) / 2).toFixed(3));
  }
  // Overlap region — fall back to median between the distributions.
  const medianSame = sames[Math.floor(sames.length / 2)];
  const medianDiff = diffs[Math.floor(diffs.length / 2)];
  return Number(((medianSame + medianDiff) / 2).toFixed(3));
}

async function main() {
  const { input, output } = parseArgs(process.argv.slice(2));
  if (!input) {
    console.error('usage: calibrate-dedup-threshold.mjs --input <pairs.json> [--output <histogram.json>]');
    process.exit(2);
  }
  if (!process.env.OPENROUTER_API_KEY) {
    console.error('OPENROUTER_API_KEY not set');
    process.exit(2);
  }

  const fixture = JSON.parse(readFileSync(resolve(input), 'utf-8'));
  if (!Array.isArray(fixture)) {
    console.error('fixture must be a JSON array of { a, b, label } entries');
    process.exit(2);
  }

  // Unique titles across all pairs; single batched embedding call
  // (the cache has 14-day TTL so re-runs are free).
  const titleSet = new Set();
  for (const p of fixture) {
    titleSet.add(normalizeForEmbedding(p.a));
    titleSet.add(normalizeForEmbedding(p.b));
  }
  const titles = [...titleSet];
  console.log(`[calibrate] embedding ${titles.length} unique titles from ${fixture.length} pairs`);
  const vectors = await embedBatch(titles);
  const vectorByTitle = new Map();
  for (let i = 0; i < titles.length; i++) vectorByTitle.set(titles[i], vectors[i]);

  const scored = fixture.map((p) => {
    const aNorm = normalizeForEmbedding(p.a);
    const bNorm = normalizeForEmbedding(p.b);
    const cos = cosineSimilarity(vectorByTitle.get(aNorm), vectorByTitle.get(bNorm));
    return { ...p, cosine: Number(cos.toFixed(4)) };
  });

  scored.sort((a, b) => a.cosine - b.cosine);
  console.log('\n─── pair-by-pair ─────────────────────────────────────────────');
  for (const p of scored) {
    console.log(
      `${p.cosine.toFixed(4)}  ${p.label.padEnd(10)}  ${p.a.slice(0, 60).padEnd(60)} | ${p.b.slice(0, 60)}`,
    );
  }

  const histogram = buildHistogram(scored);
  const threshold = recommendThreshold(scored);
  console.log('\n─── histogram (per bucket same | different) ─────────────────');
  for (let i = 0; i < histogram.bins.same.length; i++) {
    const lo = histogram.edges[i].toFixed(2);
    const hi = histogram.edges[i + 1].toFixed(2);
    const s = histogram.bins.same[i];
    const d = histogram.bins.different[i];
    const bar = '#'.repeat(s) + '.'.repeat(d);
    console.log(`[${lo}, ${hi})  ${String(s).padStart(3)} | ${String(d).padStart(3)}  ${bar}`);
  }
  console.log(`\n─── recommended threshold: ${threshold} (set DIGEST_DEDUP_COSINE_THRESHOLD)`);

  if (output) {
    const payload = {
      model: 'openai/text-embedding-3-small',
      dimensions: 512,
      pairs: scored,
      histogram,
      recommendedThreshold: threshold,
      generatedAt: new Date().toISOString(),
    };
    writeFileSync(resolve(output), JSON.stringify(payload, null, 2) + '\n');
    console.log(`wrote ${output}`);
  }
}

main().catch((err) => {
  console.error('[calibrate] failed:', err?.stack ?? err);
  process.exit(1);
});
