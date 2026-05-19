/**
 * Regression tests for koala73/worldmonitor#3800.
 *
 * Root cause: src/services/cached-risk-scores.ts fabricated `lastUpdated` /
 * `computedAt` as `new Date().toISOString()` in four places, making cached or
 * undated risk data look freshly computed in the UI ("Updated today" for
 * stale or absent intelligence).
 *
 * Fix: the adapter MUST
 *   1. preserve proto.computedAt verbatim on CII entries,
 *   2. surface `null` when no upstream timestamp exists,
 *   3. derive strategic-risk + aggregate timestamps from the freshest CII
 *      computedAt (since the proto carries no dedicated timestamp on
 *      StrategicRisk or GetRiskScoresResponse), and
 *   4. return `null` timestamps on emptyFallback (no data → no "now").
 *
 * The test loads the adapter module with esbuild after stubbing out side-
 * effecting imports (RPC client, bootstrap hydration, circuit breaker,
 * country-instability) so we can exercise the pure transform `toRiskScores`
 * and the exported `toCountryScore` without standing up the full app.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const sourcePath = resolve(root, 'src/services/cached-risk-scores.ts');
const source = readFileSync(sourcePath, 'utf-8');

// ============================================================
// 1. Static analysis: source guarantees no fabrication
// ============================================================

describe('cached-risk-scores — no fabricated timestamps in source', () => {
  it('CII adapter does not fall back to new Date() for missing computedAt', () => {
    // Hard guarantee: no `new Date().toISOString()` literal anywhere in source.
    // (If a future edit reintroduces fabrication, this test catches it.)
    assert.doesNotMatch(
      source,
      /new\s+Date\(\)\.toISOString\(\)/,
      'cached-risk-scores.ts must NOT contain `new Date().toISOString()` — adapter must surface null when upstream has no timestamp (see #3800)',
    );
  });

  it('CachedCIIScore.lastUpdated is typed as string | null', () => {
    assert.match(
      source,
      /interface\s+CachedCIIScore\b[\s\S]*?lastUpdated:\s*string\s*\|\s*null/,
      'CachedCIIScore.lastUpdated must be `string | null`',
    );
  });

  it('CachedStrategicRisk.lastUpdated is typed as string | null', () => {
    assert.match(
      source,
      /interface\s+CachedStrategicRisk\b[\s\S]*?lastUpdated:\s*string\s*\|\s*null/,
      'CachedStrategicRisk.lastUpdated must be `string | null`',
    );
  });

  it('CachedRiskScores.computedAt is typed as string | null', () => {
    assert.match(
      source,
      /interface\s+CachedRiskScores\b[\s\S]*?computedAt:\s*string\s*\|\s*null/,
      'CachedRiskScores.computedAt must be `string | null`',
    );
  });
});

// ============================================================
// 2. Functional: exercise toRiskScores with stubbed imports
// ============================================================

async function loadAdapter() {
  // Replace side-effecting imports with inert stubs so the module evaluates
  // without an RPC client, bootstrap, or circuit breaker.
  const patched = source
    .replace(
      "import { getRpcBaseUrl } from '@/services/rpc-client';",
      'const getRpcBaseUrl = () => "stub://";',
    )
    .replace(
      "import { setHasCachedScores } from './country-instability';",
      'const setHasCachedScores = (_: boolean) => {};',
    )
    .replace(
      /import\s*\{[^}]*IntelligenceServiceClient[^}]*\}\s*from\s*'@\/generated\/client\/worldmonitor\/intelligence\/v1\/service_client';/,
      'class IntelligenceServiceClient { constructor(..._args: any[]) {} async getRiskScores(_: any) { return { ciiScores: [], strategicRisks: [] }; } }',
    )
    .replace(
      "import { createCircuitBreaker } from '@/utils';",
      'const createCircuitBreaker = <T,>(_opts: any) => ({ getCached: () => null as T | null, recordSuccess: (_: T) => {}, execute: async (fn: () => Promise<T>, _fb: T, _o: any) => fn() });',
    )
    .replace(
      "import { getHydratedData } from '@/services/bootstrap';",
      'const getHydratedData = (_: string): any => undefined;',
    )
    .replace(
      "import type { CountryScore, ComponentScores } from './country-instability';",
      'type ComponentScores = { unrest: number; conflict: number; security: number; information: number }; type CountryScore = any;',
    );

  // Stub localStorage so module-level loadFromStorage() doesn't throw under Node.
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
    key: () => null,
    length: 0,
  };

  const transformed = transformSync(patched, {
    loader: 'ts',
    format: 'esm',
    target: 'es2022',
  });

  const dataUrl = `data:text/javascript;base64,${Buffer.from(transformed.code).toString('base64')}`;
  return (await import(dataUrl)) as {
    toRiskScores: (resp: {
      ciiScores: Array<{
        region: string;
        staticBaseline: number;
        dynamicScore: number;
        combinedScore: number;
        trend: string;
        components?: { newsActivity: number; ciiContribution: number; geoConvergence: number; militaryActivity: number };
        computedAt: number;
        methodologyVersion: string;
        eventMultiplier: number;
      }>;
      strategicRisks: Array<{ region: string; level: string; score: number; factors: string[]; trend: string }>;
    }) => {
      cii: Array<{ code: string; lastUpdated: string | null }>;
      strategicRisk: { lastUpdated: string | null };
      computedAt: string | null;
    };
    toCountryScore: (cached: { lastUpdated: string | null; [k: string]: unknown }) => {
      lastUpdated: Date | null;
      [k: string]: unknown;
    };
  };
}

function makeCii(region: string, computedAt: number): {
  region: string;
  staticBaseline: number;
  dynamicScore: number;
  combinedScore: number;
  trend: string;
  components: { newsActivity: number; ciiContribution: number; geoConvergence: number; militaryActivity: number };
  computedAt: number;
  methodologyVersion: string;
  eventMultiplier: number;
} {
  return {
    region,
    staticBaseline: 10,
    dynamicScore: 5,
    combinedScore: 30,
    trend: 'TREND_DIRECTION_STABLE',
    components: { newsActivity: 1, ciiContribution: 2, geoConvergence: 3, militaryActivity: 4 },
    computedAt,
    methodologyVersion: 'v1',
    eventMultiplier: 1,
  };
}

describe('cached-risk-scores — functional adapter behavior', () => {
  it('preserves proto.computedAt verbatim on CII entries', async () => {
    const { toRiskScores } = await loadAdapter();
    const ts = 1_700_000_000_000;
    const out = toRiskScores({
      ciiScores: [makeCii('US', ts)],
      strategicRisks: [],
    });
    assert.equal(out.cii[0]!.lastUpdated, new Date(ts).toISOString());
  });

  it('surfaces null on CII when proto.computedAt is missing (no more fabricated "now")', async () => {
    const { toRiskScores } = await loadAdapter();
    const out = toRiskScores({
      ciiScores: [makeCii('US', 0)], // 0 == falsy == "no upstream timestamp"
      strategicRisks: [],
    });
    assert.equal(out.cii[0]!.lastUpdated, null);
  });

  it('strategicRisk.lastUpdated derives from the MAX CII computedAt', async () => {
    const { toRiskScores } = await loadAdapter();
    const t1 = 1_700_000_000_000;
    const t2 = 1_700_000_000_000 + 60_000;
    const t3 = 1_700_000_000_000 + 30_000;
    const out = toRiskScores({
      ciiScores: [makeCii('US', t1), makeCii('CN', t2), makeCii('RU', t3)],
      strategicRisks: [{ region: 'GLOBAL', level: 'SEVERITY_LEVEL_LOW', score: 12, factors: [], trend: 'TREND_DIRECTION_STABLE' }],
    });
    assert.equal(out.strategicRisk.lastUpdated, new Date(t2).toISOString());
  });

  it('aggregate computedAt derives from the MAX CII computedAt', async () => {
    const { toRiskScores } = await loadAdapter();
    const t1 = 1_700_000_000_000;
    const t2 = 1_700_000_000_000 + 60_000;
    const out = toRiskScores({
      ciiScores: [makeCii('US', t1), makeCii('CN', t2)],
      strategicRisks: [],
    });
    assert.equal(out.computedAt, new Date(t2).toISOString());
  });

  it('strategicRisk.lastUpdated and aggregate.computedAt are null when no CII carries a timestamp', async () => {
    const { toRiskScores } = await loadAdapter();
    const out = toRiskScores({
      ciiScores: [makeCii('US', 0), makeCii('CN', 0)],
      strategicRisks: [{ region: 'GLOBAL', level: 'SEVERITY_LEVEL_LOW', score: 12, factors: [], trend: 'TREND_DIRECTION_STABLE' }],
    });
    assert.equal(out.strategicRisk.lastUpdated, null);
    assert.equal(out.computedAt, null);
  });

  it('toCountryScore returns Date for non-null cached lastUpdated', async () => {
    const { toCountryScore } = await loadAdapter();
    const iso = new Date(1_700_000_000_000).toISOString();
    const out = toCountryScore({
      code: 'US',
      name: 'United States',
      score: 30,
      level: 'normal',
      trend: 'stable',
      change24h: 0,
      components: { unrest: 0, conflict: 0, security: 0, information: 0 },
      lastUpdated: iso,
    });
    assert.ok(out.lastUpdated instanceof Date);
    assert.equal((out.lastUpdated as Date).toISOString(), iso);
  });

  it('toCountryScore returns null when cached lastUpdated is null (no more fabricated Date)', async () => {
    const { toCountryScore } = await loadAdapter();
    const out = toCountryScore({
      code: 'US',
      name: 'United States',
      score: 30,
      level: 'normal',
      trend: 'stable',
      change24h: 0,
      components: { unrest: 0, conflict: 0, security: 0, information: 0 },
      lastUpdated: null,
    });
    assert.equal(out.lastUpdated, null);
  });
});

// ============================================================
// 3. Source-level guarantee: emptyFallback uses null, not now
// ============================================================

describe('cached-risk-scores — emptyFallback surfaces null timestamps', () => {
  it('emptyFallback function body assigns lastUpdated and computedAt to null', () => {
    const fnStart = source.indexOf('function emptyFallback');
    assert.ok(fnStart > 0, 'emptyFallback function must exist');
    // Read until the next top-level function declaration or end of file.
    const tail = source.slice(fnStart);
    const fnEnd = tail.search(/\n(function|export\s+function|export\s+async\s+function|const\s+breaker)/);
    const body = fnEnd > 0 ? tail.slice(0, fnEnd) : tail;
    assert.match(body, /lastUpdated:\s*null/, 'emptyFallback strategicRisk.lastUpdated must be null');
    assert.match(body, /computedAt:\s*null/, 'emptyFallback aggregate computedAt must be null');
    assert.doesNotMatch(body, /new\s+Date\(/, 'emptyFallback must not construct any Date');
  });
});

// ============================================================
// 4. UI guarantee: CountryDeepDivePanel does not fabricate Date on null
// ============================================================

describe('CountryDeepDivePanel — handles null lastUpdated without fabricating', () => {
  const panelSrc = readFileSync(resolve(root, 'src/components/CountryDeepDivePanel.ts'), 'utf-8');

  it('no `?? new Date()` fallback on score.lastUpdated render sites', () => {
    assert.doesNotMatch(
      panelSrc,
      /score\?\.lastUpdated\s*\?\?\s*new\s+Date\(\)/,
      'panel must not fall back to `new Date()` when score.lastUpdated is null — render "—" instead (see #3800)',
    );
  });

  it('renders "—" placeholder when score.lastUpdated is null', () => {
    // Two render sites at L2207 and L2389. Both should use the null-aware ternary.
    const matches = panelSrc.match(/score\?\.lastUpdated\s*\?\s*this\.shortDate\(score\.lastUpdated\)\s*:\s*'—'/g);
    assert.ok(matches, 'expected null-aware render pattern with "—" placeholder');
    assert.ok(matches.length >= 2, `expected ≥2 null-aware render sites, found ${matches.length}`);
  });
});
