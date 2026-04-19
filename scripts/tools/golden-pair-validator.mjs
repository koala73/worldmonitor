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
import { ACTIVE_CONFIG_KEY } from '../lib/brief-dedup-consts.mjs';

/**
 * Read the active dedup config that the Railway cron published to
 * Upstash on its last tick. Returns null on missing key or any
 * fetch failure — caller treats that as "skip" rather than running
 * against hardcoded defaults that might diverge from production.
 */
async function fetchActiveConfigFromUpstash() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const resp = await fetch(`${url}/get/${encodeURIComponent(ACTIVE_CONFIG_KEY)}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': 'worldmonitor-golden-pair-validator/1.0',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return null;
    const body = await resp.json();
    if (typeof body?.result !== 'string') return null;
    const parsed = JSON.parse(body.result);
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed;
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const args = { fixture: null, thresholdOverride: null, force: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--fixture') args.fixture = argv[++i];
    else if (argv[i] === '--threshold') args.thresholdOverride = Number.parseFloat(argv[++i]);
    else if (argv[i] === '--force') args.force = true;
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

  // The Railway cron publishes its resolved classifier config to
  // Upstash on every tick. Reading from there — instead of
  // duplicating env vars into GitHub repo variables — keeps
  // Railway as the single source of truth for DIGEST_DEDUP_MODE,
  // DIGEST_DEDUP_REMOTE_EMBED_ENABLED, DIGEST_DEDUP_COSINE_THRESHOLD,
  // and DIGEST_DEDUP_ENTITY_VETO_ENABLED.
  const cfg = await fetchActiveConfigFromUpstash();
  if (!cfg) {
    console.log(
      '[golden] no active dedup config found at ' +
        `${ACTIVE_CONFIG_KEY} — either the digest cron has not ` +
        'run yet, Upstash is unreachable, or the TTL expired. ' +
        'Skipping canary rather than validating against hardcoded ' +
        'defaults that might diverge from production. Pass --force ' +
        'to run against CLI / hardcoded defaults anyway.',
    );
    if (!args.force) process.exit(0);
    console.log('[golden] --force set; using CLI + hardcoded defaults');
  }

  const threshold = args.thresholdOverride ?? cfg?.cosineThreshold ?? 0.60;
  const entityVetoEnabled = cfg?.entityVetoEnabled ?? true;
  const mode = cfg?.mode ?? 'jaccard';
  const remoteEmbedEnabled = cfg?.remoteEmbedEnabled ?? true;

  // If production cannot actually reach the embedding path (hard kill
  // switch off, or mode=jaccard), the canary can't meaningfully
  // detect drift — running embeddings here would only flag OpenRouter
  // issues prod never sees. Exit 0 with an explicit "inactive" line;
  // the workflow still renders green, which is the correct signal
  // ("production is not on the embed path, so there is nothing
  // to drift against"). A `--force` override stays available for
  // manual dispatch during staged rollouts.
  if (!remoteEmbedEnabled || mode === 'jaccard') {
    console.log(
      `[golden] embed path inactive in production ` +
        `(mode=${mode} remoteEmbedEnabled=${remoteEmbedEnabled}) — ` +
        'skipping live-embedder canary. Flip DIGEST_DEDUP_MODE=shadow|embed ' +
        'and DIGEST_DEDUP_REMOTE_EMBED_ENABLED=1 on Railway to re-enable, ' +
        'or pass --force to run the drift check anyway.',
    );
    if (!args.force) process.exit(0);
    console.log('[golden] --force set; running drift check despite inactive prod config');
  }

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
    `[golden] embedding ${titles.length} unique titles from ${fixture.length} pairs ` +
      `(mode=${mode} remoteEmbedEnabled=${remoteEmbedEnabled} ` +
      `threshold=${threshold} veto=${entityVetoEnabled ? '1' : '0'} ` +
      `source=${args.thresholdOverride !== null ? 'cli' : cfg ? 'upstash' : 'defaults'})`,
  );
  const vectors = await embedBatch(titles);
  const vecByTitle = new Map();
  for (let i = 0; i < titles.length; i++) vecByTitle.set(titles[i], vectors[i]);

  const results = fixture.map((pair) => {
    const aNorm = normalizeForEmbedding(pair.a);
    const bNorm = normalizeForEmbedding(pair.b);
    const cos = cosineSimilarity(vecByTitle.get(aNorm), vecByTitle.get(bNorm));
    // Veto only fires when prod has the entity veto enabled; mirroring
    // DIGEST_DEDUP_ENTITY_VETO_ENABLED keeps the canary in lockstep.
    const veto = entityVetoEnabled
      ? shouldVeto(stripSourceSuffix(pair.a), stripSourceSuffix(pair.b))
      : false;
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
