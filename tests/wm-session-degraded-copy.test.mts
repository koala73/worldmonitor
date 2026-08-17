// The toast shown when the anonymous session goes dead tells the user what to
// do about it. Before #6120 it said the same thing for all three causes:
// "Check your cookie settings, then reload." For `mint_failed` — the mint
// request never completed, so the browser is offline, behind a content blocker,
// or hit the 10s timeout — cookie settings are not the problem, and by the time
// WORLDMONITOR-WG had decayed to its steady state that wrong advice was going
// to roughly two thirds of the users who saw the toast.
//
// Copy is exactly the kind of defect no type, wiring guard, or source grep can
// catch, which is why the mapping is a pure exported function and why this
// file asserts the STRINGS rather than that a switch exists.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  WM_SESSION_DEGRADED_FALLBACK_COPY,
  describeWmSessionDegradation,
} from '../src/services/wm-session-copy.ts';

const ALL_REASONS = ['mint_failed', 'retry_401', 'cookie_not_persisted'] as const;

describe('wm-session degraded copy', () => {
  it('only mentions cookie settings when the cookie was actually dropped', () => {
    for (const reason of ALL_REASONS) {
      const copy = describeWmSessionDegradation(reason);
      const mentionsCookies = /cookie/i.test(copy);
      assert.equal(
        mentionsCookies,
        reason === 'cookie_not_persisted',
        `"${reason}" copy ${mentionsCookies ? 'mentions' : 'omits'} cookies, which is wrong: ` +
          'cookie settings are the remedy for cookie_not_persisted and nothing else. ' +
          `Got: ${copy}`,
      );
    }
  });

  it('points a failed mint at the connection or a content blocker', () => {
    const copy = describeWmSessionDegradation('mint_failed');
    assert.match(copy, /connection|blocker/i,
      'mint_failed means the request never landed — name a cause the user can act on');
  });

  it('tells a stale session to reload rather than to change a setting', () => {
    const copy = describeWmSessionDegradation('retry_401');
    assert.match(copy, /reload/i, 'a rejected cookie is fixed by minting a new session');
    assert.doesNotMatch(copy, /setting/i,
      'the cookie WAS delivered, so no browser setting is at fault');
  });

  it('gives every reason distinct, non-empty, actionable copy', () => {
    const messages = ALL_REASONS.map(describeWmSessionDegradation);
    for (const copy of messages) {
      assert.ok(copy.length > 0, 'every reason needs a message');
      assert.match(copy, /reload/i, 'every remedy ends in a reload');
    }
    assert.equal(new Set(messages).size, messages.length,
      'two reasons sharing one message is the bug this fixes');
  });

  it('keeps the pre-#6120 wording as the no-detail fallback', () => {
    // Long-lived tabs on an older bundle still dispatch a plain Event, and the
    // handler falls back to this. It must stay the message those users used to
    // get, not silently become one of the new ones.
    assert.match(WM_SESSION_DEGRADED_FALLBACK_COPY, /cookie settings/i);
    assert.equal(
      describeWmSessionDegradation('cookie_not_persisted'),
      WM_SESSION_DEGRADED_FALLBACK_COPY,
      'the fallback is the cookie-cause message by construction',
    );
  });
});
