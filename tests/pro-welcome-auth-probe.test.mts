import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { hasLiveSessionJwt } from '../pro-test/src/services/clerk-session.ts';

// Build a minimal Clerk-style session JWT (header.payload.signature). Only the
// payload's `exp` is read by hasLiveSessionJwt — the signature is never checked.
function jwt(payload: Record<string, unknown>): string {
  const seg = (o: Record<string, unknown>) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${seg({ alg: 'HS256', typ: 'JWT' })}.${seg(payload)}.sig`;
}

const nowSec = Math.floor(Date.now() / 1000);

describe('welcome auth probe — hasLiveSessionJwt (live __session token only)', () => {
  it('is true for an unexpired __session JWT', () => {
    assert.equal(hasLiveSessionJwt(`__session=${jwt({ exp: nowSec + 3600 })}`), true);
    assert.equal(hasLiveSessionJwt(`foo=bar; __session=${jwt({ exp: nowSec + 60 })}; baz=qux`), true);
  });

  it('is false for an expired __session JWT', () => {
    assert.equal(hasLiveSessionJwt(`__session=${jwt({ exp: nowSec - 1 })}`), false);
    assert.equal(hasLiveSessionJwt(`__session=${jwt({ exp: nowSec - 3600 })}`), false);
  });

  it('is false for a __session JWT with no exp claim', () => {
    assert.equal(hasLiveSessionJwt(`__session=${jwt({ sub: 'user_123' })}`), false);
  });

  it('is false when __session is present but not a JWT', () => {
    assert.equal(hasLiveSessionJwt('__session=sess_123'), false);
    assert.equal(hasLiveSessionJwt('__session=not.a.jwt'), false);
    assert.equal(hasLiveSessionJwt('__session='), false);
  });

  it('ignores __client_uat entirely (a stale cookie must not divert anon visitors)', () => {
    assert.equal(hasLiveSessionJwt('__client_uat=1718210123'), false);
    assert.equal(hasLiveSessionJwt('__client_uat=0'), false);
  });

  it('is false when there is no __session cookie', () => {
    assert.equal(hasLiveSessionJwt(''), false);
    assert.equal(hasLiveSessionJwt('foo=bar; baz=qux'), false);
  });

  it('decodes a URL-encoded __session value before parsing', () => {
    assert.equal(hasLiveSessionJwt(`__session=${encodeURIComponent(jwt({ exp: nowSec + 3600 }))}`), true);
  });
});
