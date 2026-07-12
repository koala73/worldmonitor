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

  it('honors custom thresholds and synthetic-origin sets', () => {
    const predictions = [pred('market'), pred('energy', 'bet_engine')];
    // default synthetic set excludes bet_engine → 0% synthetic, 2 domains
    const withDefault = assessFunnelDiversity(predictions, { minDistinctDomains: 2 });
    assert.equal(withDefault.collapsed, false);
    assert.equal(withDefault.syntheticShare, 0);
    // treat bet_engine as synthetic → 50% synthetic, still <= 0.5 so not collapsed
    const strict = assessFunnelDiversity(predictions, {
      minDistinctDomains: 2,
      syntheticOrigins: ['state_derived', 'bet_engine'],
    });
    assert.equal(strict.syntheticShare, 0.5);
    assert.equal(strict.collapsed, false);
  });
});
