import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  RESILIENCE_RANKING_CACHE_KEY,
  RESILIENCE_RANKING_CACHE_TTL_SECONDS,
  RESILIENCE_SCORE_CACHE_PREFIX,
  RESILIENCE_STATIC_INDEX_KEY,
  computeIntervals,
} from '../scripts/seed-resilience-scores.mjs';

describe('exported constants', () => {
  it('RESILIENCE_RANKING_CACHE_KEY matches server-side key (v9)', () => {
    assert.equal(RESILIENCE_RANKING_CACHE_KEY, 'resilience:ranking:v9');
  });

  it('RESILIENCE_SCORE_CACHE_PREFIX matches server-side prefix (v9)', () => {
    assert.equal(RESILIENCE_SCORE_CACHE_PREFIX, 'resilience:score:v9:');
  });

  it('RESILIENCE_RANKING_CACHE_TTL_SECONDS is 6 hours', () => {
    assert.equal(RESILIENCE_RANKING_CACHE_TTL_SECONDS, 6 * 60 * 60);
  });

  it('RESILIENCE_STATIC_INDEX_KEY matches expected key', () => {
    assert.equal(RESILIENCE_STATIC_INDEX_KEY, 'resilience:static:index:v1');
  });
});

describe('seed script does not export tsx/esm helpers', () => {
  it('ensureResilienceScoreCached is not exported', async () => {
    const mod = await import('../scripts/seed-resilience-scores.mjs');
    assert.equal(typeof mod.ensureResilienceScoreCached, 'undefined');
  });

  it('createMemoizedSeedReader is not exported', async () => {
    const mod = await import('../scripts/seed-resilience-scores.mjs');
    assert.equal(typeof mod.createMemoizedSeedReader, 'undefined');
  });

  it('buildRankingItem is not exported (ranking write removed)', async () => {
    const mod = await import('../scripts/seed-resilience-scores.mjs');
    assert.equal(typeof mod.buildRankingItem, 'undefined');
  });

  it('sortRankingItems is not exported (ranking write removed)', async () => {
    const mod = await import('../scripts/seed-resilience-scores.mjs');
    assert.equal(typeof mod.sortRankingItems, 'undefined');
  });

  it('buildRankingPayload is not exported (ranking write removed)', async () => {
    const mod = await import('../scripts/seed-resilience-scores.mjs');
    assert.equal(typeof mod.buildRankingPayload, 'undefined');
  });
});

describe('computeIntervals', () => {
  it('returns p05 <= p95', () => {
    const domainScores = [65, 70, 55, 80, 60];
    const weights = [0.22, 0.20, 0.15, 0.25, 0.18];
    const result = computeIntervals(domainScores, weights, 200);
    assert.ok(result.p05 <= result.p95, `p05 (${result.p05}) should be <= p95 (${result.p95})`);
  });

  it('returns values within the domain score range', () => {
    const domainScores = [40, 60, 50, 70, 55];
    const weights = [0.22, 0.20, 0.15, 0.25, 0.18];
    const result = computeIntervals(domainScores, weights, 200);
    assert.ok(result.p05 >= 30, `p05 (${result.p05}) should be >= 30`);
    assert.ok(result.p95 <= 80, `p95 (${result.p95}) should be <= 80`);
  });

  it('returns identical p05/p95 for uniform domain scores', () => {
    const domainScores = [50, 50, 50, 50, 50];
    const weights = [0.22, 0.20, 0.15, 0.25, 0.18];
    const result = computeIntervals(domainScores, weights, 100);
    assert.equal(result.p05, 50);
    assert.equal(result.p95, 50);
  });

  it('produces wider interval for more diverse domain scores', () => {
    const uniform = [50, 50, 50, 50, 50];
    const diverse = [20, 90, 30, 80, 40];
    const weights = [0.22, 0.20, 0.15, 0.25, 0.18];
    const uResult = computeIntervals(uniform, weights, 500);
    const dResult = computeIntervals(diverse, weights, 500);
    const uWidth = uResult.p95 - uResult.p05;
    const dWidth = dResult.p95 - dResult.p05;
    assert.ok(dWidth > uWidth, `Diverse width (${dWidth}) should be > uniform width (${uWidth})`);
  });
});

describe('script is self-contained .mjs', () => {
  it('does not import from ../server/', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const dir = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(dir, '..', 'scripts', 'seed-resilience-scores.mjs'), 'utf8');
    assert.equal(src.includes('../server/'), false, 'Must not import from ../server/');
    assert.equal(src.includes('tsx/esm'), false, 'Must not reference tsx/esm');
  });

  it('all imports are local ./ relative paths', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const dir = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(dir, '..', 'scripts', 'seed-resilience-scores.mjs'), 'utf8');
    const imports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    for (const imp of imports) {
      assert.ok(imp.startsWith('./'), `Import "${imp}" must be a local ./ relative path`);
    }
  });
});

describe('ensures ranking aggregate is present every cron, with truthful meta', () => {
  // The ranking aggregate has the same 6h TTL as the per-country scores. If we
  // only check + rebuild it inside the missing-scores branch, a cron tick that
  // finds all scores still warm will skip the probe entirely — and the ranking
  // can expire mid-cycle without anyone noticing until the NEXT cold-start
  // cron. The probe + rebuild path must run on every cron, regardless of
  // whether per-country warm was needed. The seed-meta write must be gated on
  // post-rebuild verification so it never claims freshness over a missing key.
  let src;
  before(async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const dir = dirname(fileURLToPath(import.meta.url));
    src = readFileSync(join(dir, '..', 'scripts', 'seed-resilience-scores.mjs'), 'utf8');
  });

  it('extracts ensureRankingPresent helper used by both warm and skip-warm branches', () => {
    assert.match(src, /async function ensureRankingPresent\b/, 'helper must be defined');
    const calls = [...src.matchAll(/await\s+ensureRankingPresent\s*\(/g)];
    assert.ok(
      calls.length >= 2,
      `ensureRankingPresent must be called from both branches (missing>0 and missing===0); found ${calls.length} call sites`,
    );
  });

  it('probes the ranking key after rebuild attempt to verify it actually landed', () => {
    assert.match(
      src,
      /\/strlen\/\$\{encodeURIComponent\(RESILIENCE_RANKING_CACHE_KEY\)\}/,
      'must STRLEN-verify resilience:ranking:v9 after rebuild — rebuild HTTP can return 200 without writing',
    );
  });

  it('only DELs ranking when laggards were warmed (not on race-condition retry)', () => {
    assert.match(
      src,
      /if\s*\(laggardsWarmed\s*>\s*0\)\s*{\s*await\s+redisPipeline\([^)]+\['DEL',\s*RESILIENCE_RANKING_CACHE_KEY\]\]/,
      'DEL must be guarded by laggardsWarmed > 0',
    );
  });

  it('seed-meta write is gated on post-rebuild ranking verification (no lying meta)', () => {
    assert.match(
      src,
      /result\.rankingPresent[\s\S]{0,200}writeRankingSeedMeta/,
      'writeRankingSeedMeta must only fire when result.rankingPresent === true',
    );
  });
});

describe('handler warm pipeline is chunked', () => {
  // The 222-country pipeline SET payload (~600KB) exceeds the 5s pipeline
  // timeout on Vercel Edge → handler reports 0 persisted, ranking skipped.
  // The fix is to chunk into smaller pipelines that comfortably fit. Static
  // assertion because behavioral tests can't easily synthesize 222 countries
  // through the full scoring pipeline.
  it('warmMissingResilienceScores splits SETs into batches', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const dir = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(
      join(dir, '..', 'server', 'worldmonitor', 'resilience', 'v1', '_shared.ts'),
      'utf8',
    );
    assert.match(
      src,
      /const\s+SET_BATCH\s*=\s*\d+/,
      'SET_BATCH constant must be defined',
    );
    assert.match(
      src,
      /for\s*\([^)]*i\s*\+=\s*SET_BATCH/,
      'pipeline SETs must be issued in SET_BATCH-sized chunks',
    );
  });
});
