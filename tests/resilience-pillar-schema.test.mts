// Phase 2 T2.1 + T2.3 of the country-resilience reference-grade upgrade plan
// (docs/internal/country-resilience-upgrade-plan.md).
//
// Pins the three-pillar membership shape and the buildPillarList helper
// behaviour. Real coverage-weighted aggregation is live (see
// tests/resilience-pillar-aggregation.test.mts for the arithmetic tests);
// this file focuses on structural invariants: membership disjointness,
// pillar ordering, weight sum, and the degenerate-input semantics
// (empty-dimension domains ⇒ score=0 / coverage=0).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  RESILIENCE_DOMAIN_ORDER,
  type ResilienceDomainId,
} from '../server/worldmonitor/resilience/v1/_dimension-scorers.ts';
import {
  PILLAR_DOMAINS,
  PILLAR_ORDER,
  PILLAR_WEIGHTS,
  buildPillarList,
  type ResiliencePillarId,
} from '../server/worldmonitor/resilience/v1/_pillar-membership.ts';
import type { ResilienceDomain } from '../src/generated/server/worldmonitor/resilience/v1/service_server.ts';

const ALL_DOMAIN_IDS = new Set<ResilienceDomainId>(RESILIENCE_DOMAIN_ORDER);

function makeDomain(id: ResilienceDomainId, weight = 0.2): ResilienceDomain {
  return {
    id,
    score: 50,
    weight,
    dimensions: [],
  };
}

describe('PILLAR_DOMAINS membership', () => {
  it('lists only valid ResilienceDomainId values', () => {
    for (const pillarId of PILLAR_ORDER) {
      const memberDomains = PILLAR_DOMAINS[pillarId];
      for (const domainId of memberDomains) {
        assert.ok(
          ALL_DOMAIN_IDS.has(domainId),
          `pillar ${pillarId} references unknown domain id "${domainId}". Valid ids: ${[...ALL_DOMAIN_IDS].join(', ')}`,
        );
      }
    }
  });

  it('keeps the pillar domain sets pairwise disjoint', () => {
    const seen = new Map<string, ResiliencePillarId>();
    for (const pillarId of PILLAR_ORDER) {
      for (const domainId of PILLAR_DOMAINS[pillarId]) {
        const previous = seen.get(domainId);
        assert.equal(
          previous,
          undefined,
          `domain "${domainId}" appears in both ${previous} and ${pillarId}; pillar membership must be disjoint`,
        );
        seen.set(domainId, pillarId);
      }
    }
  });

  it('recovery-capacity contains the recovery domain (wired by T2.2b)', () => {
    assert.deepEqual(
      [...PILLAR_DOMAINS['recovery-capacity']],
      ['recovery'],
      'recovery-capacity must contain the recovery domain wired by PR 3 (T2.2b)',
    );
  });

  it('union of structural-readiness + live-shock-exposure is a subset of RESILIENCE_DOMAIN_ORDER', () => {
    const union = new Set<string>([
      ...PILLAR_DOMAINS['structural-readiness'],
      ...PILLAR_DOMAINS['live-shock-exposure'],
      ...PILLAR_DOMAINS['recovery-capacity'],
    ]);
    for (const domainId of union) {
      assert.ok(
        ALL_DOMAIN_IDS.has(domainId as ResilienceDomainId),
        `union references unknown domain id "${domainId}"`,
      );
    }
  });
});

describe('PILLAR_WEIGHTS', () => {
  it('matches the plan defaults (0.40 / 0.35 / 0.25)', () => {
    assert.equal(PILLAR_WEIGHTS['structural-readiness'], 0.40);
    assert.equal(PILLAR_WEIGHTS['live-shock-exposure'], 0.35);
    assert.equal(PILLAR_WEIGHTS['recovery-capacity'], 0.25);
  });

  it('sums to exactly 1.0', () => {
    const sum =
      PILLAR_WEIGHTS['structural-readiness'] +
      PILLAR_WEIGHTS['live-shock-exposure'] +
      PILLAR_WEIGHTS['recovery-capacity'];
    // Floating point: assert within an epsilon to be safe even though the
    // current values sum exactly when rounded to two decimal places.
    assert.ok(
      Math.abs(sum - 1.0) < 1e-9,
      `pillar weights must sum to 1.0, got ${sum}`,
    );
  });
});

describe('PILLAR_ORDER', () => {
  it('lists every pillar id exactly once in canonical order', () => {
    assert.deepEqual(PILLAR_ORDER, [
      'structural-readiness',
      'live-shock-exposure',
      'recovery-capacity',
    ]);
  });
});

describe('buildPillarList', () => {
  const allDomains: ResilienceDomain[] = RESILIENCE_DOMAIN_ORDER.map((id) => makeDomain(id));

  it('returns [] when the v2 schema flag is off (default v1 shape)', () => {
    const result = buildPillarList(allDomains, false);
    assert.deepEqual(result, []);
  });

  it('returns 3 pillars with score=0 / coverage=0 when every member domain has empty dimensions (degenerate input)', () => {
    // `allDomains` uses the fixture `makeDomain` helper which sets
    // `dimensions: []`. With no dimension coverage to weight against,
    // buildPillarList must return score=0 / coverage=0 for each pillar
    // (NOT because real aggregation is unimplemented — it is — but
    // because the aggregator divides by totalCoverage=0 and the
    // fallback path short-circuits to zero). Real-score behaviour is
    // exercised in tests/resilience-pillar-aggregation.test.mts.
    const result = buildPillarList(allDomains, true);
    assert.equal(result.length, 3);
    for (const pillar of result) {
      assert.equal(pillar.score, 0, `pillar ${pillar.id} score must be 0 when member domains have no dimensions`);
      assert.equal(pillar.coverage, 0, `pillar ${pillar.id} coverage must be 0 when member domains have no dimensions`);
      assert.equal(pillar.weight, PILLAR_WEIGHTS[pillar.id]);
    }
  });

  it('emits pillars in PILLAR_ORDER', () => {
    const result = buildPillarList(allDomains, true);
    assert.deepEqual(result.map((pillar) => pillar.id), [...PILLAR_ORDER]);
  });

  it('slices pillar.domains by membership and preserves input domain order', () => {
    const result = buildPillarList(allDomains, true);
    const structural = result.find((pillar) => pillar.id === 'structural-readiness');
    assert.ok(structural, 'structural-readiness pillar must be present');
    assert.deepEqual(
      structural!.domains.map((domain) => domain.id),
      ['economic', 'social-governance'],
      'structural-readiness must contain the long-run capacity domains in input order',
    );

    const liveShock = result.find((pillar) => pillar.id === 'live-shock-exposure');
    assert.ok(liveShock, 'live-shock-exposure pillar must be present');
    assert.deepEqual(
      liveShock!.domains.map((domain) => domain.id),
      ['infrastructure', 'energy', 'health-food'],
      'live-shock-exposure must contain the shock-pressure domains in input order',
    );

    const recovery = result.find((pillar) => pillar.id === 'recovery-capacity');
    assert.ok(recovery, 'recovery-capacity pillar must be present');
    assert.deepEqual(
      recovery!.domains.map((d) => d.id),
      ['recovery'],
      'recovery-capacity contains the recovery domain from PR 3 (T2.2b)',
    );
  });

  it('preserves input domain ordering even when domains arrive shuffled', () => {
    const shuffled: ResilienceDomain[] = [
      makeDomain('infrastructure'),
      makeDomain('health-food'),
      makeDomain('economic'),
      makeDomain('energy'),
      makeDomain('social-governance'),
      makeDomain('recovery'),
    ];
    const result = buildPillarList(shuffled, true);
    const structural = result.find((pillar) => pillar.id === 'structural-readiness')!;
    assert.deepEqual(
      structural.domains.map((domain) => domain.id),
      ['economic', 'social-governance'],
      'pillar.domains must preserve the order of the source domains array, not PILLAR_DOMAINS membership order',
    );
  });

  it('drops domains the input does not provide (partial domain set)', () => {
    const partial: ResilienceDomain[] = [makeDomain('economic'), makeDomain('energy')];
    const result = buildPillarList(partial, true);
    const structural = result.find((pillar) => pillar.id === 'structural-readiness')!;
    const liveShock = result.find((pillar) => pillar.id === 'live-shock-exposure')!;
    assert.deepEqual(
      structural.domains.map((domain) => domain.id),
      ['economic'],
      'structural-readiness should only carry the domains the caller provided',
    );
    assert.deepEqual(
      liveShock.domains.map((domain) => domain.id),
      ['energy'],
      'live-shock-exposure should only carry the domains the caller provided',
    );
  });
});
