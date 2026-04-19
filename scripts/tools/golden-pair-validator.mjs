#!/usr/bin/env node
/**
 * Golden-pair validator — live-embedder drift detector.
 *
 * Reads a small canary fixture of titled pairs with expected "merge"/
 * "split" classifications, calls the LIVE OpenRouter embedder, and
 * asserts each pair's classification under the production cosine
 * threshold + entity veto matches expectation.
 *
 * Runs in the dedicated nightly CI workflow (NOT in the brief cron
 * or the default test suite — those stay deterministic and fast).
 *
 * Exit codes:
 *   0 — all pairs classified as expected
 *   1 — at least one pair mis-classified (model drift, threshold
 *        drift, or fixture out of date; inspect the diff and act)
 *   2 — configuration error (missing key, unreadable fixture)
 *
 * Usage:
 *   OPENROUTER_API_KEY=... node scripts/tools/golden-pair-validator.mjs \
 *     [--fixture tests/fixtures/brief-dedup-golden-pairs.json] \
 *     [--threshold 0.60]
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { embedBatch, cosineSimilarity, normalizeForEmbedding } from '../lib/brief-embedding.mjs';
import { shouldVeto } from '../lib/brief-dedup-embed.mjs';
import { stripSourceSuffix } from '../lib/brief-dedup-jaccard.mjs';

function parseArgs(argv) {
  const args = { fixture: null, threshold: 0.60 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--fixture') args.fixture = argv[++i];
    else if (argv[i] === '--threshold') args.threshold = Number.parseFloat(argv[++i]);
  }
  return args;
}

const DEFAULT_FIXTURE_PATH = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', 'tests', 'fixtures', 'brief-dedup-golden-pairs.json');
})();

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const fixturePath = args.fixture ? resolve(args.fixture) : DEFAULT_FIXTURE_PATH;
  const threshold = args.threshold;

  if (!process.env.OPENROUTER_API_KEY) {
    console.error('[golden] OPENROUTER_API_KEY not set');
    process.exit(2);
  }
  let fixture;
  try {
    fixture = JSON.parse(readFileSync(fixturePath, 'utf-8'));
  } catch (err) {
    console.error(`[golden] could not read fixture at ${fixturePath}: ${err.message}`);
    process.exit(2);
  }
  if (!Array.isArray(fixture) || fixture.length === 0) {
    console.error('[golden] fixture must be a non-empty JSON array of { a, b, expect }');
    process.exit(2);
  }

  const titleSet = new Set();
  for (const p of fixture) {
    titleSet.add(normalizeForEmbedding(p.a));
    titleSet.add(normalizeForEmbedding(p.b));
  }
  const titles = [...titleSet];
  console.log(
    `[golden] embedding ${titles.length} unique titles from ${fixture.length} pairs (threshold=${threshold})`,
  );
  const vectors = await embedBatch(titles);
  const vecByTitle = new Map();
  for (let i = 0; i < titles.length; i++) vecByTitle.set(titles[i], vectors[i]);

  const results = fixture.map((pair) => {
    const aNorm = normalizeForEmbedding(pair.a);
    const bNorm = normalizeForEmbedding(pair.b);
    const cos = cosineSimilarity(vecByTitle.get(aNorm), vecByTitle.get(bNorm));
    const veto = shouldVeto(stripSourceSuffix(pair.a), stripSourceSuffix(pair.b));
    const actual = cos >= threshold && !veto ? 'merge' : 'split';
    return { ...pair, cosine: Number(cos.toFixed(4)), veto, actual };
  });

  console.log('\n─── pair-by-pair ─────────────────────────────────────────────');
  for (const r of results) {
    const ok = r.actual === r.expect ? '✓' : '✗';
    console.log(
      `${ok}  cos=${r.cosine.toFixed(4)} veto=${r.veto ? '1' : '0'} ` +
        `expect=${r.expect.padEnd(5)} got=${r.actual.padEnd(5)}  ${r.tag ?? ''}`,
    );
    if (r.actual !== r.expect) {
      console.log(`     a: ${r.a}`);
      console.log(`     b: ${r.b}`);
    }
  }

  const failures = results.filter((r) => r.actual !== r.expect);
  console.log(
    `\n[golden] ${results.length - failures.length}/${results.length} pairs matched expectation`,
  );
  if (failures.length > 0) {
    console.error(
      `[golden] ${failures.length} mis-classification(s) — embedding model may have drifted, ` +
        'threshold may need recalibration, or the canary fixture is out of date.',
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[golden] validator threw:', err?.stack ?? err);
  process.exit(1);
});
