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
  it('RESILIENCE_RANKING_CACHE_KEY matches server-side key (v16)', () => {
    assert.equal(RESILIENCE_RANKING_CACHE_KEY, 'resilience:ranking:v16');
  });

  it('RESILIENCE_SCORE_CACHE_PREFIX matches server-side prefix (v16)', () => {
    assert.equal(RESILIENCE_SCORE_CACHE_PREFIX, 'resilience:score:v16:');
  });

  it('RESILIENCE_RANKING_CACHE_TTL_SECONDS is 12 hours (2x cron interval)', () => {
    // TTL must exceed cron interval (6h) so a missed/slow cron doesn't create
    // an EMPTY_ON_DEMAND gap. Seeder and handler must agree on the TTL.
    assert.equal(RESILIENCE_RANKING_CACHE_TTL_SECONDS, 12 * 60 * 60);
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

  it('extracts refreshRankingAggregate helper used by both warm and skip-warm branches', () => {
    assert.match(src, /async function refreshRankingAggregate\b/, 'helper must be defined');
    const calls = [...src.matchAll(/await\s+refreshRankingAggregate\s*\(/g)];
    assert.ok(
      calls.length >= 2,
      `refreshRankingAggregate must be called from both branches (missing>0 and missing===0); found ${calls.length} call sites`,
    );
  });

  it('always triggers the rebuild HTTP call — never short-circuits on "key still present"', () => {
    // Skipping rebuild when the key exists recreates a timing hole: the key
    // can be alive at probe time but expire a few minutes later, leaving a
    // multi-hour gap until the NEXT cron where the key happens to be gone at
    // probe time. Always rebuilding is one cheap HTTP per cron.
    assert.doesNotMatch(
      src,
      /if\s*\(\s*rankingExists\s*!=\s*null[^)]*\)\s*return\s+true/,
      'refreshRankingAggregate must not early-return when the ranking key is still present',
    );
    // The HTTP rebuild call itself must be unconditional (not gated on a probe).
    assert.match(
      src,
      /async function refreshRankingAggregate[\s\S]*?\/api\/resilience\/v1\/get-resilience-ranking/,
      'rebuild HTTP call must be in the body of refreshRankingAggregate unconditionally',
    );
  });

  it('verifies the ranking key after the rebuild attempt for observability', () => {
    assert.match(
      src,
      /\/strlen\/\$\{encodeURIComponent\(RESILIENCE_RANKING_CACHE_KEY\)\}/,
      'STRLEN verify after rebuild surfaces when handler skipped the SET (coverage gate or partial pipeline)',
    );
  });

  it('does NOT DEL the ranking before rebuild — uses ?refresh=1 instead', () => {
    // The old flow (DEL + rebuild HTTP) created a brief absence window: if
    // the rebuild request failed transiently, the ranking stayed absent
    // until the next cron. We now send ?refresh=1 so the handler bypasses
    // its cache-hit early-return and recomputes+SETs atomically. On failure,
    // the existing (possibly stale) ranking remains.
    assert.doesNotMatch(
      src,
      /\['DEL',\s*RESILIENCE_RANKING_CACHE_KEY\]/,
      'seeder must not DEL the ranking key — ?refresh=1 is the atomic replacement path',
    );
    // ALL seeder-initiated calls to get-resilience-ranking must carry
    // ?refresh=1. The bulk-warm path (inside `if (missing > 0)`) also needs
    // it — the ranking TTL (12h) exceeds the score TTL (6h), so in the 6h-12h
    // window the handler would hit its cache and skip the warm entirely,
    // leaving per-country scores absent and coverage degraded.
    const rankingEndpointCalls = [...src.matchAll(/\/api\/resilience\/v1\/get-resilience-ranking(\?[^\s'`"]*)?/g)];
    assert.ok(rankingEndpointCalls.length >= 2, `expected at least 2 ranking-endpoint calls (bulk-warm + refresh), got ${rankingEndpointCalls.length}`);
    for (const [full, query] of rankingEndpointCalls) {
      assert.ok(
        (query || '').includes('refresh=1'),
        `ranking endpoint call must include ?refresh=1 — found: ${full}`,
      );
    }
  });

  it('seeder does NOT write seed-meta:resilience:ranking (handler is sole writer)', () => {
    // A seeder-written meta can only attest to per-country score count, not
    // to whether the ranking aggregate was actually published. Handler gates
    // its SET on 75% coverage; if the gate trips, an older ranking survives
    // and seeder meta would lie about freshness. Remove the seeder write —
    // handler writes ranking + meta atomically, ensureRankingPresent()
    // triggers the handler every cron so meta stays fresh during quiet Pro
    // usage without the seeder needing to heartbeat.
    assert.doesNotMatch(
      src,
      /writeRankingSeedMeta\s*\(/,
      'seed-resilience-scores.mjs must NOT define or call writeRankingSeedMeta',
    );
    // Assert no SET command targets the meta key — comments that reference
    // the key name are fine and useful for future maintainers.
    assert.doesNotMatch(
      src,
      /\[\s*['"]SET['"]\s*,\s*['"]seed-meta:resilience:ranking['"]/,
      'seeder must not issue SET seed-meta:resilience:ranking (handler is sole writer)',
    );
  });
});

describe('seed-bundle-resilience section interval keeps refresh alive', () => {
  // The bundle runner skips a section when its seed-meta is younger than
  // intervalMs * 0.8. If intervalMs is too long (e.g. 6h), most Railway cron
  // fires hit the skip branch → refreshRankingAggregate() never runs →
  // ranking can expire between actual runs and create EMPTY_ON_DEMAND gaps.
  // 2h is the tested trade-off: frequent enough for the 12h ranking TTL to
  // stay well-refreshed, cheap enough per warm-path run (~5-10s).
  it('Resilience-Scores section has intervalMs ≤ 2 hours', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const dir = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(
      join(dir, '..', 'scripts', 'seed-bundle-resilience.mjs'),
      'utf8',
    );
    // Match the label + section line, then extract the intervalMs value.
    const m = src.match(/label:\s*'Resilience-Scores'[\s\S]{0,400}?intervalMs:\s*(\d+)\s*\*\s*HOUR/);
    assert.ok(m, 'Resilience-Scores section must set intervalMs in HOUR units');
    const hours = Number(m[1]);
    assert.ok(
      hours > 0 && hours <= 2,
      `intervalMs must be ≤ 2 hours (found ${hours}) so refreshRankingAggregate runs frequently enough to keep the ranking key alive before its 12h TTL`,
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
