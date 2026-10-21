import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { assessFunnelDiversity, buildFunnelHealthMeta, DEFAULT_MIN_DISTINCT_DOMAINS } from '../scripts/_forecast-funnel.mjs';

function pred(domain, generationOrigin = 'legacy_detector') {
  return { domain, generationOrigin };
}

describe('assessFunnelDiversity', () => {
  it('flags a single-domain, all-synthetic funnel as collapsed', () => {
    const result = assessFunnelDiversity([
      pred('market', 'state_derived'),
      pred('market', 'state_derived'),
      pred('market', 'state_derived'),
    ]);

    assert.equal(result.collapsed, true);
    assert.equal(result.domainCount, 1);
    assert.equal(result.syntheticShare, 1);
    // both failure modes fire: too few domains AND too much synthetic
    assert.equal(result.reasons.length, 2);
  });

  it('passes a balanced, real six-domain funnel', () => {
    const result = assessFunnelDiversity([
      pred('market'), pred('energy'), pred('conflict'),
      pred('macro'), pred('health'), pred('cyber'),
    ]);

    assert.equal(result.collapsed, false);
    assert.equal(result.domainCount, 6);
    assert.equal(result.syntheticCount, 0);
    assert.equal(result.syntheticShare, 0);
    assert.deepEqual(result.reasons, []);
  });

  it('accepts the 3 real domains left while cyber and prediction-market forecasts are withheld (#8990)', () => {
    // On 2026-10-08, 61% of the last 200 runs published exactly these 3 domains
    // once the withheld families were removed, and none published fewer.
    const result = assessFunnelDiversity([pred('conflict'), pred('market'), pred('supply_chain')]);
    assert.equal(DEFAULT_MIN_DISTINCT_DOMAINS, 3);
    assert.equal(result.collapsed, false);
    assert.deepEqual(result.reasons, []);
    const narrower = assessFunnelDiversity([pred('market'), pred('supply_chain')]);
    assert.equal(narrower.collapsed, true);
    assert.deepEqual(narrower.reasons, ['only 2 distinct domain(s) (min 3)']);
  });

  it('flags a broad funnel that is still majority-synthetic', () => {
    // 5 distinct domains (passes domain gate) but 3/5 synthetic (fails share gate)
    const result = assessFunnelDiversity([
      pred('market', 'state_derived'),
      pred('supply', 'state_derived'),
      pred('cyber', 'state_derived'),
      pred('infra'),
      pred('conflict'),
    ]);

    assert.equal(result.domainCount, 5);
    assert.equal(result.syntheticShare, 0.6);
    assert.equal(result.collapsed, true);
    assert.equal(result.reasons.length, 1);
    assert.match(result.reasons[0], /synthetic share/);
  });

  it('treats an empty run as not collapsed (that is a freshness failure, not a funnel one)', () => {
    const result = assessFunnelDiversity([]);
    assert.equal(result.total, 0);
    assert.equal(result.collapsed, false);
    assert.deepEqual(result.reasons, []);
  });

  it('counts bet_engine shadow bets as non-real coverage by default (matches skill-Brier exclusion)', () => {
    const predictions = [pred('market'), pred('energy', 'bet_engine')];
    // default non-real set = state_derived + bet_engine → shadow bet counted, 50% synthetic
    const withDefault = assessFunnelDiversity(predictions, { minDistinctDomains: 2 });
    assert.equal(withDefault.syntheticShare, 0.5);
    assert.equal(withDefault.collapsed, false); // 0.5 is not > 0.5

    // a bet_engine-heavy funnel now trips the guardrail instead of reading healthy
    const shadowHeavy = assessFunnelDiversity(
      [pred('energy', 'bet_engine'), pred('energy', 'bet_engine'), pred('market', 'bet_engine'), pred('market')],
      { minDistinctDomains: 2 },
    );
    assert.equal(shadowHeavy.syntheticShare, 0.75);
    assert.equal(shadowHeavy.collapsed, true);
  });

  it('honors an explicit custom synthetic-origin override', () => {
    const predictions = [pred('market'), pred('energy', 'bet_engine')];
    // override to state_derived only → bet_engine no longer counted
    const custom = assessFunnelDiversity(predictions, {
      minDistinctDomains: 2,
      syntheticOrigins: ['state_derived'],
    });
    assert.equal(custom.syntheticShare, 0);
    assert.equal(custom.collapsed, false);
  });
});

describe('buildFunnelHealthMeta', () => {
  const NOW = 1_700_000_000_000;

  // Health degrades only when the generator does not run. A narrow funnel is an
  // output-quality reading.
  it('reports a run that published a collapsed funnel as ok, with the collapse as information', () => {
    const assessment = assessFunnelDiversity([pred('market'), pred('supply_chain')]);
    assert.equal(assessment.collapsed, true);
    const meta = buildFunnelHealthMeta(assessment, NOW);
    assert.equal(meta.status, 'ok');
    assert.equal(meta.collapsed, true);
    assert.deepEqual(meta.reasons, ['only 2 distinct domain(s) (min 3)']);
    assert.equal(meta.recordCount, 2);
    assert.equal(meta.fetchedAt, NOW);
  });

  it('reports a diverse funnel as ok and not collapsed', () => {
    const meta = buildFunnelHealthMeta(assessFunnelDiversity(['conflict', 'market', 'political', 'supply_chain'].map((d) => pred(d))), NOW);
    assert.equal(meta.status, 'ok');
    assert.equal(meta.collapsed, false);
    assert.deepEqual(meta.reasons, []);
  });
});
