// Truth table for the two decisions that keep an expected Pro denial out of
// wm-session recovery (#5674):
//
//   1. `hasPremiumIntent(init)` — does this request carry premiumFetch's
//      per-request premium marker?
//   2. The recovery-skip decision at the interceptor's 401 branch, which reads
//      that same marker.
//
// Both are pure and exported specifically so this file can pin their shape
// without a DOM. That matters more than usual here: the previous guard for
// this bug class was a source-level wiring check, and a source check goes
// GREEN with the bug restored verbatim — every token it greps for is still
// present when the decision itself is wrong. Assert the decision, not its
// spelling.
//
// The regression these lock: `/api/news/v1/summarize-article` is premium per
// REQUEST, not per path. The gateway charges Pro auth for spend-bearing
// summarize calls (server/gateway.ts `shouldReserveGatewayDirectLlmQuota`)
// while `mode: 'translate'` stays free — and translate REQUIRES the anonymous
// wms_ cookie (verified against prod: no cookie ⇒ 401 "API key required").
// So the path can be in neither PREMIUM_RPC_PATHS (breaks translate) nor
// outside the bypass (each denial cost a mint, a replay, and a 15-minute
// blackout of every anonymous API call).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PREMIUM_INTENT_INIT_KEY,
  hasPremiumIntent,
  withPremiumIntent,
} from '../src/services/premium-intent.ts';
import { PREMIUM_RPC_PATHS } from '../src/shared/premium-paths.ts';

const SUMMARIZE = '/api/news/v1/summarize-article';

describe('premium-intent marker', () => {
  it('round-trips through withPremiumIntent', () => {
    assert.equal(hasPremiumIntent(withPremiumIntent()), true);
    assert.equal(hasPremiumIntent(withPremiumIntent({ method: 'POST' })), true);
  });

  it('preserves the caller init it wraps', () => {
    const marked = withPremiumIntent({ method: 'POST', body: '{"mode":"summarize"}' });
    assert.equal(marked.method, 'POST');
    assert.equal(marked.body, '{"mode":"summarize"}');
  });

  it('does not mutate the caller init', () => {
    // premiumFetch hands this object on to globalThis.fetch. Mutating in place
    // would stamp the marker onto an init the caller may reuse for a
    // non-premium request, silently opting THAT one out of session recovery.
    const original: RequestInit = { method: 'POST' };
    withPremiumIntent(original);
    assert.equal(hasPremiumIntent(original), false);
    assert.equal(Object.prototype.hasOwnProperty.call(original, PREMIUM_INTENT_INIT_KEY), false);
  });

  it('is false for every shape that did not opt in', () => {
    for (const init of [
      undefined,
      null,
      {},
      { method: 'POST' },
      { credentials: 'include' } as RequestInit,
    ]) {
      assert.equal(hasPremiumIntent(init as RequestInit | null | undefined), false);
    }
  });

  it('requires exactly true — a truthy value does not opt out of recovery', () => {
    // Strictness is the point: an unrelated spread or a deserialized init that
    // happens to carry a truthy key must not disable session recovery.
    for (const value of [1, 'true', {}, [], 'yes']) {
      const init = { [PREMIUM_INTENT_INIT_KEY]: value } as unknown as RequestInit;
      assert.equal(hasPremiumIntent(init), false, `truthy ${JSON.stringify(value)} must not count`);
    }
    assert.equal(hasPremiumIntent({ [PREMIUM_INTENT_INIT_KEY]: false } as unknown as RequestInit), false);
  });
});

describe('recovery-skip truth table', () => {
  // The interceptor's 401 branch skips recovery on exactly `hasPremiumIntent`.
  // Path-listed premium routes never reach that branch — they step aside far
  // earlier, before any session work — so the decision here is marker-only.
  const cases: Array<{ name: string; init?: RequestInit; expected: boolean }> = [
    {
      name: 'ordinary anonymous request, unmarked — must keep full recovery',
      init: undefined,
      expected: false,
    },
    {
      name: 'summarize WITH premium intent — the #5674 fix',
      init: withPremiumIntent({ method: 'POST' }),
      expected: true,
    },
    {
      name: 'summarize WITHOUT premium intent (free translate) — must keep recovery',
      init: { method: 'POST' },
      expected: false,
    },
    {
      name: 'pro-fresh market read stays unmarked — a 401 there IS a dead cookie',
      init: { credentials: 'include' },
      expected: false,
    },
  ];

  for (const { name, init, expected } of cases) {
    it(name, () => {
      assert.equal(hasPremiumIntent(init), expected);
    });
  }

  it('summarize-article stays OUT of PREMIUM_RPC_PATHS', () => {
    // If someone "fixes" #5674 by listing the path instead, the marker becomes
    // dead code AND free translate loses its wms_ cookie for every anonymous
    // visitor — a silent downgrade this assertion catches.
    assert.equal(
      PREMIUM_RPC_PATHS.has(SUMMARIZE),
      false,
      `${SUMMARIZE} must stay out of PREMIUM_RPC_PATHS: its free translate mode `
      + 'requires the anonymous wms_ cookie, which the interceptor stops attaching '
      + 'once the path is listed. Premium-ness here is per-request — use the marker.',
    );
  });
});
