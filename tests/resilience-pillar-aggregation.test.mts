import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PENALTY_ALPHA,
  RESILIENCE_SCORE_CACHE_PREFIX,
  penalizedPillarScore,
} from '../server/worldmonitor/resilience/v1/_shared.ts';
import {
  PILLAR_DOMAINS,
  PILLAR_ORDER,
  PILLAR_WEIGHTS,
  buildPillarList,
  type ResiliencePillarId,
} from '../server/worldmonitor/resilience/v1/_pillar-membership.ts';
import type { ResilienceDomain } from '../src/generated/server/worldmonitor/resilience/v1/service_server.ts';

function makeDomain(id: string, score: number, coverage: number): ResilienceDomain {
  return {
    id,
    score,
    weight: 0.17,
    dimensions: [
      { id: `${id}-d1`, score, coverage, observedWeight: coverage, imputedWeight: 1 - coverage, imputationClass: '', freshness: { lastObservedAtMs: '0', staleness: '' } },
    ],
  };
}

describe('penalizedPillarScore', () => {
  it('returns 0 for empty pillars', () => {
    assert.equal(penalizedPillarScore([]), 0);
  });

  it('equal pillar scores produce minimal penalty (penalty factor approaches 1)', () => {
    const pillars = [
      { score: 60, weight: 0.40 },
      { score: 60, weight: 0.35 },
      { score: 60, weight: 0.25 },
    ];
    const result = penalizedPillarScore(pillars);
    const weighted = 60 * 0.40 + 60 * 0.35 + 60 * 0.25;
    const penalty = 1 - 0.5 * (1 - 60 / 100);
    assert.equal(result, Math.round(weighted * penalty * 100) / 100);
  });

  it('one pillar at 0 applies maximum penalty (factor = 0.5 at alpha=0.5)', () => {
    const pillars = [
      { score: 80, weight: 0.40 },
      { score: 70, weight: 0.35 },
      { score: 0, weight: 0.25 },
    ];
    const result = penalizedPillarScore(pillars);
    const weighted = 80 * 0.40 + 70 * 0.35 + 0 * 0.25;
    const penalty = 1 - 0.5 * (1 - 0 / 100);
    assert.equal(result, Math.round(weighted * penalty * 100) / 100);
    assert.equal(penalty, 0.5);
  });

  it('realistic scores (S=70, L=45, R=60) produce expected value', () => {
    const pillars = [
      { score: 70, weight: 0.40 },
      { score: 45, weight: 0.35 },
      { score: 60, weight: 0.25 },
    ];
    const result = penalizedPillarScore(pillars);
    const weighted = 70 * 0.40 + 45 * 0.35 + 60 * 0.25;
    const minScore = 45;
    const penalty = 1 - 0.5 * (1 - minScore / 100);
    const expected = Math.round(weighted * penalty * 100) / 100;
    assert.equal(result, expected);
    assert.ok(result > 0 && result < 100, `result=${result} should be in (0,100)`);
  });

  it('all pillars at 100 produce no penalty (factor = 1.0)', () => {
    const pillars = [
      { score: 100, weight: 0.40 },
      { score: 100, weight: 0.35 },
      { score: 100, weight: 0.25 },
    ];
    const result = penalizedPillarScore(pillars);
    assert.equal(result, 100);
  });
});

describe('buildPillarList', () => {
  it('returns empty array when schemaV2Enabled is false', () => {
    const domains: ResilienceDomain[] = [makeDomain('economic', 75, 0.9)];
    assert.deepEqual(buildPillarList(domains, false), []);
  });

  it('produces 3 pillars with non-zero scores from real domain data', () => {
    const domains: ResilienceDomain[] = [
      makeDomain('economic', 75, 0.9),
      makeDomain('social-governance', 65, 0.85),
      makeDomain('infrastructure', 70, 0.8),
      makeDomain('energy', 60, 0.7),
      makeDomain('health-food', 55, 0.75),
      makeDomain('recovery', 50, 0.6),
    ];
    const pillars = buildPillarList(domains, true);
    assert.equal(pillars.length, 3);
    for (const pillar of pillars) {
      assert.ok(pillar.score > 0, `pillar ${pillar.id} score should be > 0, got ${pillar.score}`);
      assert.ok(pillar.coverage > 0, `pillar ${pillar.id} coverage should be > 0, got ${pillar.coverage}`);
    }
  });

  it('recovery-capacity pillar contains the recovery domain', () => {
    const domains: ResilienceDomain[] = [
      makeDomain('economic', 75, 0.9),
      makeDomain('social-governance', 65, 0.85),
      makeDomain('infrastructure', 70, 0.8),
      makeDomain('energy', 60, 0.7),
      makeDomain('health-food', 55, 0.75),
      makeDomain('recovery', 50, 0.6),
    ];
    const pillars = buildPillarList(domains, true);
    const recovery = pillars.find((p) => p.id === 'recovery-capacity');
    assert.ok(recovery, 'recovery-capacity pillar should exist');
    assert.equal(recovery!.domains.length, 1, 'recovery-capacity pillar should have 1 domain');
    assert.equal(recovery!.domains[0]!.id, 'recovery');
  });

  it('pillar weights match PILLAR_WEIGHTS', () => {
    const domains: ResilienceDomain[] = [
      makeDomain('economic', 75, 0.9),
      makeDomain('social-governance', 65, 0.85),
      makeDomain('infrastructure', 70, 0.8),
      makeDomain('energy', 60, 0.7),
      makeDomain('health-food', 55, 0.75),
      makeDomain('recovery', 50, 0.6),
    ];
    const pillars = buildPillarList(domains, true);
    for (const pillar of pillars) {
      assert.equal(pillar.weight, PILLAR_WEIGHTS[pillar.id as ResiliencePillarId]);
    }
  });

  it('structural-readiness contains economic + social-governance', () => {
    const domains: ResilienceDomain[] = [
      makeDomain('economic', 75, 0.9),
      makeDomain('social-governance', 65, 0.85),
      makeDomain('infrastructure', 70, 0.8),
      makeDomain('energy', 60, 0.7),
      makeDomain('health-food', 55, 0.75),
      makeDomain('recovery', 50, 0.6),
    ];
    const pillars = buildPillarList(domains, true);
    const sr = pillars.find((p) => p.id === 'structural-readiness')!;
    const domainIds = sr.domains.map((d) => d.id).sort();
    assert.deepEqual(domainIds, ['economic', 'social-governance']);
  });
});

describe('pillar constants', () => {
  it('PENALTY_ALPHA equals 0.50', () => {
    assert.equal(PENALTY_ALPHA, 0.50);
  });

  it('RESILIENCE_SCORE_CACHE_PREFIX is v13', () => {
    assert.equal(RESILIENCE_SCORE_CACHE_PREFIX, 'resilience:score:v13:');
  });

  it('PILLAR_ORDER has 3 entries', () => {
    assert.equal(PILLAR_ORDER.length, 3);
  });

  it('pillar weights sum to 1.0', () => {
    const sum = PILLAR_ORDER.reduce((s, id) => s + PILLAR_WEIGHTS[id], 0);
    assert.ok(Math.abs(sum - 1.0) < 0.001, `pillar weights sum to ${sum}, expected 1.0`);
  });

  it('every domain appears in exactly one pillar', () => {
    const allDomains = PILLAR_ORDER.flatMap((id) => PILLAR_DOMAINS[id]);
    const unique = new Set(allDomains);
    assert.equal(allDomains.length, unique.size, 'no domain should appear in multiple pillars');
    assert.equal(unique.size, 6, 'all 6 domains should be covered');
  });
});
