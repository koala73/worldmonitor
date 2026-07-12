import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { assessFunnelDiversity } from '../scripts/_forecast-funnel.mjs';

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
