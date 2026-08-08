import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { TierPreferenceHandoff } from '../src/app/tier-preference-handoff';

describe('tier preference account handoff', () => {
  it('defers only the signing-in account until its cloud completion signal', () => {
    const handoff = new TierPreferenceHandoff();
    handoff.begin('account-b');

    assert.equal(handoff.shouldDefer('account-b'), true);
    assert.equal(handoff.shouldDefer('account-a'), false);
    assert.equal(handoff.complete('account-b', 'account-b'), true);
    assert.equal(handoff.shouldDefer('account-b'), false);
  });

  it('does not let a stale completion clear a newer account handoff', () => {
    const handoff = new TierPreferenceHandoff();
    handoff.begin('account-a');
    handoff.begin('account-b');

    assert.equal(handoff.complete('account-a', 'account-b'), false);
    assert.equal(handoff.shouldDefer('account-b'), true);
    assert.equal(handoff.complete('account-b', null), false);
    assert.equal(handoff.shouldDefer('account-b'), false);
  });
});
