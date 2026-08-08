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
import ts from 'typescript';

import { TIER1_COUNTRIES } from '../src/config/countries.ts';
import { CII_COUNTRY_WEIGHTS } from '../shared/cii-weights.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const sourcePath = resolve(root, 'src/services/cached-risk-scores.ts');
const source = readFileSync(sourcePath, 'utf-8');
const sourceFile = ts.createSourceFile(
  sourcePath,
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);

function findFunctionDeclaration(name: string): ts.FunctionDeclaration {
  let found: ts.FunctionDeclaration | undefined;

  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  assert.ok(found, `${name} must exist in cached-risk-scores.ts`);
  return found;
}

function functionBodyText(name: string): string {
  const fn = findFunctionDeclaration(name);
  assert.ok(fn.body, `${name} must have a function body`);
  return fn.body.getText(sourceFile).replace(/\s+/g, ' ').trim();
}

function topLevelConstNamesMatching(pattern: RegExp): string[] {
  const matches: string[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && pattern.test(declaration.name.text)) {
        matches.push(declaration.name.text);
      }
    }
  }
  return matches;
}

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

  it('localStorage Tier-1 validation uses the canonical country table, not a second hardcoded list', () => {
    assert.deepEqual(
      Object.keys(TIER1_COUNTRIES).sort(),
      Object.keys(CII_COUNTRY_WEIGHTS).sort(),
      'frontend Tier-1 country names must stay in parity with shared CII weights',
    );
    assert.match(
      functionBodyText('isKnownTier1Code'),
      /hasOwnProperty\.call\(TIER1_COUNTRIES,\s*value\)/,
      'localStorage validator must validate ISO2 codes against TIER1_COUNTRIES',
    );
    assert.match(
      functionBodyText('canonicalizeCachedCiiEntry'),
      /name:\s*TIER1_COUNTRIES\[entry\.code\]\s*\?\?\s*entry\.code/,
      'localStorage canonicalizer must rewrite display names from TIER1_COUNTRIES',
    );
    assert.deepEqual(
      topLevelConstNamesMatching(/^(?:TIER1_(?!COUNTRIES$)\w+|(?:KNOWN_|VALID_)?TIER1_\w+|(?:KNOWN_|VALID_)?COUNTRY_(?:CODES|LIST|NAMES))$/),
      [],
      'cached-risk-scores.ts must not reintroduce a second Tier-1 name/code list',
    );
  });
});

// ============================================================
// 2. Functional: exercise toRiskScores with stubbed imports
// ============================================================

async function loadAdapter(options: { storageValue?: string | null } = {}) {
  // Replace side-effecting imports with inert stubs so the module evaluates
  // without an RPC client, bootstrap, or circuit breaker.
  const patched = source
    .replace(
      "import { getRpcBaseUrl } from '@/services/rpc-client';",
      'const getRpcBaseUrl = () => "stub://";',
    )
    .replace(
      "import { setHasCachedScores } from './country-instability';",
      'const setHasCachedScores = (value: boolean) => { (globalThis as any).__wmCachedRiskScoresHasCached = value; };',
    )
    .replace(
      "import { TIER1_COUNTRIES } from '@/config/countries';",
      'const TIER1_COUNTRIES: Record<string, string> = { US: "United States", CN: "China", RU: "Russia", LB: "Lebanon", IQ: "Iraq", AF: "Afghanistan", KR: "South Korea", EG: "Egypt", JP: "Japan", QA: "Qatar" };',
    )
    .replace(
      /import\s*\{[^}]*IntelligenceServiceClient[^}]*\}\s*from\s*'@\/generated\/client\/worldmonitor\/intelligence\/v1\/service_client';/,
      'class IntelligenceServiceClient { constructor(..._args: any[]) {} async getRiskScores(_: any) { return { ciiScores: [], strategicRisks: [] }; } }',
    )
    .replace(
      "import { createCircuitBreaker } from '@/utils';",
      'const createCircuitBreaker = <T,>(_opts: any) => ({ getCached: () => (globalThis as any).__wmCachedRiskScoresRecorded as T | null, recordSuccess: (value: T) => { (globalThis as any).__wmCachedRiskScoresRecorded = value; }, execute: async (fn: () => Promise<T>, _fb: T, _o: any) => fn() });',
    )
    .replace(
      "import { getHydratedData } from '@/services/bootstrap';",
      'const getHydratedData = (_: string): any => undefined;',
    )
    .replace(
      "import type { CountryScore, ComponentScores } from './country-instability';",
      'type ComponentScores = { unrest: number; conflict: number; security: number; information: number }; type CountryScore = any;',
    );

  const removedKeys: string[] = [];
  const storageValue = options.storageValue ?? null;
  (globalThis as any).__wmCachedRiskScoresRecorded = null;
  (globalThis as any).__wmCachedRiskScoresHasCached = false;

  // Stub localStorage so module-level loadFromStorage() doesn't throw under Node.
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: () => storageValue,
    setItem: () => {},
    removeItem: (key: string) => { removedKeys.push(key); },
    clear: () => {},
    key: () => null,
    length: 0,
  };

  const transformed = transformSync(patched, {
    loader: 'ts',
    format: 'esm',
    target: 'es2022',
  });

  const dataUrl = `data:text/javascript;base64,${Buffer.from(transformed.code).toString('base64')}#${Date.now()}-${Math.random()}`;
  const mod = await import(dataUrl) as {
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
      degraded?: boolean;
      stale?: boolean;
    }) => {
      cii: Array<{ code: string; change24h: number; lastUpdated: string | null }>;
      strategicRisk: { lastUpdated: string | null };
      computedAt: string | null;
      degraded: boolean;
      stale: boolean;
    };
    toCountryScore: (cached: { lastUpdated: string | null; [k: string]: unknown }) => {
      lastUpdated: Date | null;
      [k: string]: unknown;
    };
    getCachedScores: () => {
      cii: Array<{
        code: string;
        name: string;
        score: number;
        change24h: number;
        components: { unrest: number; conflict: number; security: number; information: number };
      }>;
    } | null;
  };
  return { ...mod, removedKeys };
}

function makeCii(region: string, computedAt: number, dynamicScore = 5, staticBaseline = 10, combinedScore = 30): {
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
    staticBaseline,
    dynamicScore,
    combinedScore,
    trend: 'TREND_DIRECTION_STABLE',
    components: { newsActivity: 1, ciiContribution: 2, geoConvergence: 3, militaryActivity: 4 },
    computedAt,
    methodologyVersion: 'v1',
    eventMultiplier: 1,
  };
}

function makeCachedCii(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    code: 'US',
    name: 'United States',
    score: 42,
    level: 'normal',
    trend: 'stable',
    change24h: 3,
    components: { unrest: 10, conflict: 20, security: 30, information: 40 },
    lastUpdated: new Date(1_700_000_000_000).toISOString(),
    ...overrides,
  };
}

function makeStoredScores(
  cii: Array<Record<string, unknown>>,
  dataOverrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    savedAt: Date.now(),
    data: {
      cii,
      strategicRisk: { score: 0, level: 'low', trend: 'stable', lastUpdated: null, contributors: [] },
      protestCount: 0,
      computedAt: null,
      cached: true,
      degraded: false,
      stale: false,
      ...dataOverrides,
    },
  });
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

  it('maps proto.dynamicScore as change24h without recomputing the baseline delta', async () => {
    const { toRiskScores } = await loadAdapter();
    const out = toRiskScores({
      // staticBaseline -> combinedScore is +2, but the server has no prior
      // snapshot on cold start, so dynamicScore/change24h must stay 0.
      ciiScores: [makeCii('US', 1_700_000_000_000, 0, 80, 82)],
      strategicRisks: [],
    });

    assert.equal(out.cii[0]!.change24h, 0);
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

  it('preserves degraded and stale proto flags on the cached model', async () => {
    const { toRiskScores } = await loadAdapter();
    const out = toRiskScores({
      ciiScores: [makeCii('US', 1_700_000_000_000)],
      strategicRisks: [],
      degraded: true,
      stale: true,
    });
    assert.equal(out.degraded, true);
    assert.equal(out.stale, true);
  });

  it('defaults absent legacy degraded and stale flags to false', async () => {
    const { toRiskScores } = await loadAdapter();
    const out = toRiskScores({
      ciiScores: [makeCii('US', 1_700_000_000_000)],
      strategicRisks: [],
    });
    assert.equal(out.degraded, false);
    assert.equal(out.stale, false);
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

  it('uses the shared Tier-1 country table for newer cached CII country names', async () => {
    const { toRiskScores } = await loadAdapter();
    const out = toRiskScores({
      ciiScores: [makeCii('LB', 1_700_000_000_000)],
      strategicRisks: [{ region: 'GLOBAL', level: 'SEVERITY_LEVEL_LOW', score: 12, factors: ['LB'], trend: 'TREND_DIRECTION_STABLE' }],
    }) as unknown as {
      cii: Array<{ code: string; name: string }>;
      strategicRisk: { contributors: Array<{ code: string; country: string }> };
    };

    assert.equal(out.cii[0]!.name, 'Lebanon');
    assert.equal(out.strategicRisk.contributors[0]!.country, 'Lebanon');
  });

  it('primes the circuit breaker from valid localStorage CII scores', async () => {
    const { getCachedScores, removedKeys } = await loadAdapter({
      storageValue: makeStoredScores([makeCachedCii()]),
    });

    const cached = getCachedScores();
    assert.ok(cached);
    const row = cached.cii[0];
    assert.ok(row);
    assert.equal(row.code, 'US');
    assert.equal(row.name, 'United States');
    assert.equal(row.score, 42);
    assert.deepEqual(row.components, { unrest: 10, conflict: 20, security: 30, information: 40 });
    assert.deepEqual(removedKeys, []);
  });

  it('normalizes localStorage CII names from the known Tier-1 country table', async () => {
    const { getCachedScores, removedKeys } = await loadAdapter({
      storageValue: makeStoredScores([makeCachedCii({ name: 'Poisoned United States Display Name' })]),
    });

    const cached = getCachedScores();
    assert.ok(cached);
    const row = cached.cii[0];
    assert.ok(row);
    assert.equal(row.name, 'United States');
    assert.deepEqual(removedKeys, []);
  });

  it('does not coerce non-boolean localStorage degraded and stale flags to true', async () => {
    const { getCachedScores, removedKeys } = await loadAdapter({
      storageValue: makeStoredScores([makeCachedCii()], { degraded: 'false', stale: 'false' }),
    });

    const cached = getCachedScores();
    assert.ok(cached);
    assert.equal(cached.degraded, false);
    assert.equal(cached.stale, false);
    assert.deepEqual(removedKeys, []);
  });

  it('accepts null localStorage CII lastUpdated values', async () => {
    const { getCachedScores, removedKeys } = await loadAdapter({
      storageValue: makeStoredScores([makeCachedCii({ lastUpdated: null })]),
    });

    const cached = getCachedScores();
    assert.ok(cached);
    assert.equal(cached.cii[0]?.lastUpdated, null);
    assert.deepEqual(removedKeys, []);
  });

  it('rejects localStorage CII scores outside the safe render ranges', async () => {
    const invalidEntries = [
      makeCachedCii({ score: 10_000 }),
      makeCachedCii({ score: -1 }),
      makeCachedCii({ change24h: 250 }),
      makeCachedCii({ change24h: -250 }),
      makeCachedCii({ components: { unrest: 10, conflict: 20, security: 30, information: 101 } }),
      makeCachedCii({ components: { unrest: -1, conflict: 20, security: 30, information: 40 } }),
    ];

    for (const entry of invalidEntries) {
      const { getCachedScores, removedKeys } = await loadAdapter({
        storageValue: makeStoredScores([entry]),
      });
      assert.equal(getCachedScores(), null);
      assert.deepEqual(removedKeys, ['wm:risk-scores']);
    }
  });

  it('rejects localStorage CII entries with unparseable or unreasonable lastUpdated values', async () => {
    const invalidEntries = [
      makeCachedCii({ lastUpdated: 'not-a-date' }),
      makeCachedCii({ lastUpdated: '1999-12-31T23:59:59.999Z' }),
      makeCachedCii({ lastUpdated: new Date(Date.now() + 10 * 60 * 1000).toISOString() }),
    ];

    for (const entry of invalidEntries) {
      const { getCachedScores, removedKeys } = await loadAdapter({
        storageValue: makeStoredScores([entry]),
      });
      assert.equal(getCachedScores(), null);
      assert.deepEqual(removedKeys, ['wm:risk-scores']);
    }
  });

  it('rejects localStorage CII entries with malformed or unknown ISO2 codes', async () => {
    const invalidEntries = [
      makeCachedCii({ code: 'us' }),
      makeCachedCii({ code: 'USA' }),
      makeCachedCii({ code: 'ZZ' }),
    ];

    for (const entry of invalidEntries) {
      const { getCachedScores, removedKeys } = await loadAdapter({
        storageValue: makeStoredScores([entry]),
      });
      assert.equal(getCachedScores(), null);
      assert.deepEqual(removedKeys, ['wm:risk-scores']);
    }
  });

  it('rejects localStorage entries without a valid strategic-risk payload', async () => {
    const invalidStrategicRisks = [
      undefined,
      { score: 101, level: 'high', trend: 'stable', lastUpdated: null, contributors: [] },
      { score: 50, level: 'normal', trend: 'stable', lastUpdated: null, contributors: [{ country: 'Unknown', code: 'ZZ', score: 50, level: 'normal' }] },
    ];

    for (const strategicRisk of invalidStrategicRisks) {
      const { getCachedScores, removedKeys } = await loadAdapter({
        storageValue: makeStoredScores([makeCachedCii()], { strategicRisk }),
      });
      assert.equal(getCachedScores(), null);
      assert.deepEqual(removedKeys, ['wm:risk-scores']);
    }
  });

  it('accepts every strategic-risk enum emitted by the adapter', async () => {
    const strategicRiskLevels = ['low', 'medium', 'high'];
    const trends = ['rising', 'stable', 'falling'];
    const contributorLevels = ['low', 'normal', 'elevated', 'high', 'critical'];

    for (const level of strategicRiskLevels) {
      for (const trend of trends) {
        for (const contributorLevel of contributorLevels) {
          const strategicRisk = {
            score: 50,
            level,
            trend,
            lastUpdated: null,
            contributors: [{
              country: 'United States',
              code: 'US',
              score: 50,
              level: contributorLevel,
            }],
          };
          const { getCachedScores, removedKeys } = await loadAdapter({
            storageValue: makeStoredScores([makeCachedCii()], { strategicRisk }),
          });

          assert.ok(getCachedScores(), `${level}/${trend}/${contributorLevel} must remain loadable`);
          assert.deepEqual(removedKeys, []);
        }
      }
    }
  });

  it('rejects malformed persisted strategic-risk enums', async () => {
    const validStrategicRisk = {
      score: 50,
      level: 'medium',
      trend: 'stable',
      lastUpdated: null,
      contributors: [{ country: 'United States', code: 'US', score: 50, level: 'elevated' }],
    };
    const invalidStrategicRisks = [
      { ...validStrategicRisk, level: 'critical' },
      { ...validStrategicRisk, trend: 'escalating' },
      {
        ...validStrategicRisk,
        contributors: [{ ...validStrategicRisk.contributors[0], level: 'medium' }],
      },
    ];

    for (const strategicRisk of invalidStrategicRisks) {
      const { getCachedScores, removedKeys } = await loadAdapter({
        storageValue: makeStoredScores([makeCachedCii()], { strategicRisk }),
      });
      assert.equal(getCachedScores(), null);
      assert.deepEqual(removedKeys, ['wm:risk-scores']);
    }
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
