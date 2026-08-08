/**
 * Regression for PR #5009 review P1 — the consent POST origin gate.
 *
 * The OAuth discovery metadata (PRM/AS) and the /agent/auth challenge are all
 * host-derived, so an agent can be pointed at the apex OR www OR api consent
 * page. Previously the POST handler accepted only Origin=https://api.worldmonitor.app
 * and 403'd every other first-party host, dead-ending the www/apex flow. The gate
 * now accepts any worldmonitor.app apex/subdomain origin (foreign origins still
 * 403). The CSRF nonce remains the real protection.
 *
 * The origin check is the FIRST statement in the POST branch (before rate-limit
 * and Redis), so an allowed origin with no `_nonce` falls straight through to the
 * "Missing session token" 400 — a clean, Redis-free signal that the gate passed.
 */

import { strict as assert } from 'node:assert';
import { before, describe, it } from 'node:test';

// Force the rate limiter to no-op (getRatelimit returns null without env) so the
// handler never makes a network call — the origin gate runs before it anyway.
before(() => {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
});

const { default: handler } = await import('../api/oauth/authorize.js');

const postWithOrigin = (origin) => {
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (origin !== undefined) headers.origin = origin;
  return handler(new Request('https://www.worldmonitor.app/oauth/authorize', {
    method: 'POST',
    headers,
    body: '', // no _nonce → 400 "Missing session token" once the origin gate passes
  }));
};

describe('OAuth authorize — consent POST origin gate (P1)', () => {
  const firstPartyOrigins = [
    'https://worldmonitor.app',          // apex — the scanned host, previously 403'd
    'https://www.worldmonitor.app',      // canonical Vercel host
    'https://api.worldmonitor.app',      // the only host that worked before
    'https://tech.worldmonitor.app',     // variant subdomain
    'https://finance.worldmonitor.app',
  ];

  for (const origin of firstPartyOrigins) {
    it(`accepts first-party Origin ${origin} (passes gate → 400, not 403)`, async () => {
      const res = await postWithOrigin(origin);
      assert.notEqual(res.status, 403, `${origin} must not be rejected as cross-origin`);
      assert.equal(res.status, 400, 'should fall through to the missing-nonce 400');
    });
  }

  it('accepts an absent Origin (server/CLI clients)', async () => {
    const res = await postWithOrigin(undefined);
    assert.notEqual(res.status, 403);
    assert.equal(res.status, 400);
  });

  it("accepts the opaque 'null' Origin (sandboxed WebViews)", async () => {
    const res = await postWithOrigin('null');
    assert.notEqual(res.status, 403);
    assert.equal(res.status, 400);
  });

  const foreignOrigins = [
    'https://evil.example',
    'https://worldmonitor.app.evil.example', // suffix attack — must stay anchored
    'https://evilworldmonitor.app',          // prefix attack — no subdomain dot
    'http://worldmonitor.app',               // non-https
    'https://worldmonitor.app:8443',         // port smuggling
  ];

  for (const origin of foreignOrigins) {
    it(`rejects foreign/spoofed Origin ${origin} with 403`, async () => {
      const res = await postWithOrigin(origin);
      assert.equal(res.status, 403, `${origin} must be rejected`);
    });
  }
});
