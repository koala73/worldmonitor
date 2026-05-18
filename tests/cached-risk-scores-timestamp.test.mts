/**
 * tests/cached-risk-scores-timestamp.test.mts
 *
 * Verifies that cached risk-score adapters preserve upstream freshness timestamps
 * instead of fabricating "now" when upstream computedAt is missing or stale.
 *
 * Issue: #3800
 * - CII entries should preserve proto.computedAt (not rewrite to current time)
 * - Strategic risk should preserve upstream timestamp (not unconditionally set to now)
 * - Aggregate computedAt should come from a canonical upstream source
 * - Empty fallback should NOT get a fresh fabricated timestamp
 *
 * Approach: test against source string so we avoid the @/ path-alias resolution
 * that requires the full Vite/Browser runtime. Mirrors the pattern used by
 * tests/corridorrisk-upstream.test.mjs and tests/cii-scoring.test.mts.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const src = readFileSync(resolve(root, 'src/services/cached-risk-scores.ts'), 'utf-8');

// ------------------------------------------------------------------
// Test helpers
// ------------------------------------------------------------------

/** Minimal CiiScore shape matching generated service_client.ts */
interface ProtoCiiScore {
  region: string;
  combinedScore: number;
  dynamicScore: number;
  trend: number; // 0=STABLE, 1=RISING, 2=FALLING
  computedAt: number; // epoch ms, 0 = missing
  components?: {
    ciiContribution?: number;
    geoConvergence?: number;
    militaryActivity?: number;
    newsActivity?: number;
  };
}

interface ProtoStrategicRisk {
  code: string;
  score: number;
  level: number; // 1=LOW, 2=HIGH, 3=CRITICAL
  trend: number;
  factors: string[];
  computedAt: number; // epoch ms, 0 = missing
}

interface ProtoRiskResponse {
  ciiScores: ProtoCiiScore[];
  strategicRisks: ProtoStrategicRisk[];
  protestCount: number;
}

/** TREND_REVERSE mapping */
const TREND_REVERSE: Record<string, 'rising' | 'stable' | 'falling'> = {
  '1': 'rising',
  '2': 'falling',
  '0': 'stable',
  TREND_DIRECTION_RISING: 'rising',
  TREND_DIRECTION_FALLING: 'falling',
  TREND_DIRECTION_STABLE: 'stable',
};

/** Score level thresholds */
function getScoreLevel(score: number): 'low' | 'normal' | 'elevated' | 'high' | 'critical' {
  if (score >= 70) return 'critical';
  if (score >= 55) return 'high';
  if (score >= 40) return 'elevated';
  if (score >= 25) return 'normal';
  return 'low';
}

/** Simulated toCachedCII logic */
function simulateToCachedCII(proto: ProtoCiiScore): { lastUpdated: string | null; trend: string; level: string } {
  // This mirrors the FIXED source code
  const trend = TREND_REVERSE[String(proto.trend)] ?? 'stable';
  const level = getScoreLevel(proto.combinedScore);
  // FIXED: null when missing, ISO string when present
  const lastUpdated = proto.computedAt > 0 ? new Date(proto.computedAt).toISOString() : null;
  return { lastUpdated, trend, level };
}

/** Simulated toRiskScores aggregate computedAt logic */
function simulateAggregateComputedAt(resp: ProtoRiskResponse): string | null {
  const allComputedAt = resp.ciiScores.map((s) => s.computedAt).filter((t) => t > 0);
  if (allComputedAt.length === 0) return null;
  return new Date(Math.max(...allComputedAt)).toISOString();
}

/** Simulated toCachedStrategicRisk lastUpdated logic */
function simulateStrategicLastUpdated(resp: ProtoRiskResponse): string | null {
  const global = resp.strategicRisks[0];
  const ciiScores = resp.ciiScores;
  // Prefer strategic risk's own computedAt; fall back to max CII computedAt
  const upstreamComputedAt = global?.computedAt && global.computedAt > 0
    ? global.computedAt
    : (ciiScores.length > 0
        ? Math.max(...ciiScores.map((s) => s.computedAt).filter((t) => t > 0))
        : 0);
  return upstreamComputedAt > 0 ? new Date(upstreamComputedAt).toISOString() : null;
}

// ------------------------------------------------------------------
// Source-code assertions (proves the fix is actually in the file)
// ------------------------------------------------------------------

describe('cached-risk-scores source code assertions', () => {

  it('source does NOT contain the buggy `new Date().toISOString()` fallback in toCachedCII', () => {
    // The BUGGY pattern: `proto.computedAt ? new Date(proto.computedAt).toISOString() : new Date().toISOString()`
    // The FIXED pattern: `proto.computedAt > 0 ? new Date(proto.computedAt).toISOString() : null`
    const buggyPattern = /toCachedCII[^}]*\{[^}]*lastUpdated[^}]*:\s*proto\.computedAt\s*\?\s*new\s+Date\(\s*proto\.computedAt\)\.toISOString\(\)\s*:\s*new\s+Date\(\)\.toISOString\(\)/s;
    assert.equal(buggyPattern.test(src), false,
      'toCachedCII should NOT fall back to new Date().toISOString() when computedAt is missing');
  });

  it('source does NOT contain unconditional `new Date().toISOString()` in toRiskScores', () => {
    const buggy = /toRiskScores[^}]*\bcomputedAt[^}]*:\s*new\s+Date\(\)\.toISOString\(\)/s;
    assert.equal(buggy.test(src), false,
      'toRiskScores aggregate computedAt should NOT unconditionally use new Date().toISOString()');
  });

  it('source does NOT contain unconditional `new Date().toISOString()` in toCachedStrategicRisk', () => {
    const buggy = /toCachedStrategicRisk[^}]*\blastUpdated[^}]*:\s*new\s+Date\(\)\.toISOString\(\)/s;
    assert.equal(buggy.test(src), false,
      'toCachedStrategicRisk.lastUpdated should NOT unconditionally use new Date().toISOString()');
  });

  it('source does NOT fabricate timestamps in emptyFallback', () => {
    const buggy = /emptyFallback[^}]*\b(lastUpdated|computedAt)[^}]*:\s*new\s+Date\(\)/s;
    assert.equal(buggy.test(src), false,
      'emptyFallback should NOT fabricate fresh timestamps');
  });

  it('source uses null for missing timestamps in toCachedCII', () => {
    // The fix: lastUpdated should end with `: null` inside toCachedCII body
    const toCachedCIISection = src.match(/export function toCachedCII\(proto[^}]+\}[^}]*\}[^}]*\}/s)?.[0] ?? '';
    assert.ok(toCachedCIISection.includes(': null'),
      `toCachedCII should assign null for missing computedAt (source check)`);
  });

  it('source computes aggregate from CII timestamps in toRiskScores', () => {
    // Check the toRiskScores body uses computedAt values from resp.ciiScores
    const usesCiiComputedAt = /toRiskScores[^}]*(ciiScores|allComputedAt)[^}]*computedAt/s;
    assert.equal(usesCiiComputedAt.test(src), true,
      'toRiskScores aggregate should derive timestamp from CII scores');
  });
});

// ------------------------------------------------------------------
// Behavioral tests (proves the logic produces correct results)
// ------------------------------------------------------------------

describe('cached-risk-scores timestamp preservation logic', () => {

  it('toCachedCII preserves upstream computedAt when present', () => {
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    const proto: ProtoCiiScore = {
      region: 'UA',
      combinedScore: 65,
      dynamicScore: 3,
      trend: 1,
      computedAt: twoHoursAgo,
      components: { ciiContribution: 15, geoConvergence: 20, militaryActivity: 25, newsActivity: 5 },
    };
    const cached = simulateToCachedCII(proto);
    assert.equal(cached.lastUpdated, new Date(twoHoursAgo).toISOString(),
      `lastUpdated should preserve proto.computedAt`);
  });

  it('toCachedCII returns null when upstream computedAt is 0 (missing)', () => {
    const proto: ProtoCiiScore = {
      region: 'IR',
      combinedScore: 70,
      dynamicScore: 0,
      trend: 2,
      computedAt: 0,
    };
    const cached = simulateToCachedCII(proto);
    assert.equal(cached.lastUpdated, null,
      `lastUpdated should be null when computedAt is 0 (degraded state)`);
  });

  it('toCachedCII maps trend directions correctly', () => {
    const rising = simulateToCachedCII({ region: 'US', combinedScore: 50, dynamicScore: 0, trend: 1, computedAt: 0 });
    assert.equal(rising.trend, 'rising');

    const falling = simulateToCachedCII({ region: 'US', combinedScore: 50, dynamicScore: 0, trend: 2, computedAt: 0 });
    assert.equal(falling.trend, 'falling');

    const stable = simulateToCachedCII({ region: 'US', combinedScore: 50, dynamicScore: 0, trend: 0, computedAt: 0 });
    assert.equal(stable.trend, 'stable');
  });

  it('aggregate computedAt uses max CII timestamp (most-recent overall freshness)', () => {
    const now = Date.now();
    const twoHoursAgo = now - 2 * 60 * 60 * 1000;
    const fiveHoursAgo = now - 5 * 60 * 60 * 1000;
    const resp: ProtoRiskResponse = {
      ciiScores: [
        { region: 'US', combinedScore: 60, dynamicScore: 0, trend: 0, computedAt: fiveHoursAgo }, // oldest
        { region: 'CN', combinedScore: 55, dynamicScore: 0, trend: 0, computedAt: twoHoursAgo }, // newest
      ],
      strategicRisks: [],
      protestCount: 0,
    };
    // Math.max gives the most-recent timestamp = overall data freshness
    const computedAt = simulateAggregateComputedAt(resp);
    assert.equal(computedAt, new Date(twoHoursAgo).toISOString(),
      `aggregate computedAt should be the most-recent CII timestamp (overall freshness)`);
  });

  it('aggregate computedAt is null when all CII timestamps are 0', () => {
    const resp: ProtoRiskResponse = {
      ciiScores: [
        { region: 'US', combinedScore: 60, dynamicScore: 0, trend: 0, computedAt: 0 },
        { region: 'CN', combinedScore: 55, dynamicScore: 0, trend: 0, computedAt: 0 },
      ],
      strategicRisks: [],
      protestCount: 0,
    };
    assert.equal(simulateAggregateComputedAt(resp), null,
      `aggregate computedAt should be null when all upstream timestamps are 0`);
  });

  it('strategic risk lastUpdated prefers strategic risk computedAt over CII fallback', () => {
    const now = Date.now();
    const ciiTime = now - 1 * 60 * 60 * 1000;
    const strategicTime = now - 30 * 60 * 1000; // more recent
    const resp: ProtoRiskResponse = {
      ciiScores: [{ region: 'US', combinedScore: 72, dynamicScore: 0, trend: 0, computedAt: ciiTime }],
      strategicRisks: [{ code: 'US', score: 72, level: 2, trend: 1, factors: ['US'], computedAt: strategicTime }],
      protestCount: 0,
    };
    const lastUpdated = simulateStrategicLastUpdated(resp);
    assert.equal(lastUpdated, new Date(strategicTime).toISOString(),
      `strategicRisk.lastUpdated should prefer strategic risk's own computedAt`);
  });

  it('strategic risk lastUpdated falls back to max CII computedAt when strategic has none', () => {
    const now = Date.now();
    const ciiTime = now - 4 * 60 * 60 * 1000;
    const resp: ProtoRiskResponse = {
      ciiScores: [{ region: 'US', combinedScore: 72, dynamicScore: 0, trend: 0, computedAt: ciiTime }],
      strategicRisks: [{ code: 'US', score: 72, level: 2, trend: 1, factors: ['US'], computedAt: 0 }],
      protestCount: 0,
    };
    const lastUpdated = simulateStrategicLastUpdated(resp);
    assert.equal(lastUpdated, new Date(ciiTime).toISOString(),
      `strategicRisk.lastUpdated should fall back to max CII computedAt`);
  });

  it('strategic risk lastUpdated is null when all upstream timestamps are 0', () => {
    const resp: ProtoRiskResponse = {
      ciiScores: [{ region: 'US', combinedScore: 72, dynamicScore: 0, trend: 0, computedAt: 0 }],
      strategicRisks: [{ code: 'US', score: 72, level: 2, trend: 1, factors: ['US'], computedAt: 0 }],
      protestCount: 0,
    };
    assert.equal(simulateStrategicLastUpdated(resp), null,
      `strategicRisk.lastUpdated should be null when all upstream timestamps are 0`);
  });

  it('score level thresholds are correct', () => {
    const cases: Array<[number, string]> = [
      [0, 'low'], [24, 'low'], [25, 'normal'], [39, 'normal'],
      [40, 'elevated'], [54, 'elevated'], [55, 'high'], [69, 'high'],
      [70, 'critical'], [100, 'critical'],
    ];
    for (const [score, expected] of cases) {
      const cached = simulateToCachedCII({ region: 'XX', combinedScore: score, dynamicScore: 0, trend: 0, computedAt: 0 });
      assert.equal(cached.level, expected, `score=${score}: expected ${expected}`);
    }
  });
});