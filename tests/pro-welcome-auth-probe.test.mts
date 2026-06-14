import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { hasLikelyLiveClerkSession } from '../pro-test/src/services/clerk-session.ts';

describe('welcome auth probe session cookie detection', () => {
  it('does not treat signed-out __client_uat=0 as a live Clerk session', () => {
    assert.equal(hasLikelyLiveClerkSession('__client_uat=0'), false);
    assert.equal(hasLikelyLiveClerkSession('foo=bar; __client_uat=000; baz=qux'), false);
    assert.equal(hasLikelyLiveClerkSession('__client_uat=not-a-timestamp'), false);
  });

  it('treats non-zero __client_uat and __session cookies as likely live sessions', () => {
    assert.equal(hasLikelyLiveClerkSession('__client_uat=1718210123'), true);
    assert.equal(hasLikelyLiveClerkSession('foo=bar; __session=sess_123'), true);
  });
});
