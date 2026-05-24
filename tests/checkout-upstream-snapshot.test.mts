/**
 * Locks the upstream-emitter snapshot used to identify whether a failed
 * /api/create-checkout response came from Cloudflare, Vercel, our own
 * function, or a client-side middlebox. Regression scope:
 * WORLDMONITOR-RN — the old failure path discarded both the response
 * body (CF 403 pages are HTML, silently became `{}`) and headers
 * (cf-ray / server / x-vercel-id would have named the emitter).
 *
 * The snapshot is what makes the next 403 self-diagnosing in Sentry.
 * If a future refactor drops one of these fields, the corresponding
 * test fails and the diagnostic capability silently regresses.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { snapshotUpstreamResponse } from '../src/services/checkout-errors.ts';

function makeResp(headers: Record<string, string>): { headers: Headers } {
  return { headers: new Headers(headers) };
}

describe('snapshotUpstreamResponse', () => {
  it('captures Cloudflare cf-ray and server when present (definitive CF signal)', () => {
    const snap = snapshotUpstreamResponse(
      makeResp({ 'cf-ray': 'a00d6f7b7b9bfb0a-FRA', server: 'cloudflare' }),
      '<!DOCTYPE html><html>Cloudflare blocked you</html>',
    );
    assert.equal(snap.cfRay, 'a00d6f7b7b9bfb0a-FRA');
    assert.equal(snap.server, 'cloudflare');
    assert.equal(snap.vercelId, undefined);
    assert.ok(snap.bodySnippet?.includes('Cloudflare'));
  });

  it('captures Vercel x-vercel-id and x-vercel-cache when present', () => {
    const snap = snapshotUpstreamResponse(
      makeResp({
        'x-vercel-id': 'fra1::abc123',
        'x-vercel-cache': 'MISS',
        server: 'Vercel',
      }),
      '{"error":"Unauthorized"}',
    );
    assert.equal(snap.vercelId, 'fra1::abc123');
    assert.equal(snap.vercelCache, 'MISS');
    assert.equal(snap.server, 'Vercel');
    assert.equal(snap.cfRay, undefined);
  });

  it('truncates body snippet to 200 chars to stay well under Sentry payload caps', () => {
    const longBody = 'x'.repeat(5000);
    const snap = snapshotUpstreamResponse(makeResp({}), longBody);
    assert.equal(snap.bodySnippet?.length, 200);
    assert.equal(snap.bodySnippet, 'x'.repeat(200));
  });

  it('omits bodySnippet when body is empty (signal vs noise — undefined is filterable)', () => {
    const snap = snapshotUpstreamResponse(makeResp({}), '');
    assert.equal(snap.bodySnippet, undefined);
  });

  it('returns all-undefined header fields when no upstream identifiers present (client middlebox case)', () => {
    // An ad blocker or VPN-side interception layer that synthesizes a
    // 403 typically strips standard upstream headers. Empty snapshot +
    // empty body is itself the signal: "neither CF nor Vercel saw this."
    const snap = snapshotUpstreamResponse(makeResp({}), '');
    assert.equal(snap.cfRay, undefined);
    assert.equal(snap.server, undefined);
    assert.equal(snap.vercelId, undefined);
    assert.equal(snap.vercelCache, undefined);
    assert.equal(snap.bodySnippet, undefined);
  });

  it('preserves the full snippet when body is shorter than the cap', () => {
    const snap = snapshotUpstreamResponse(makeResp({}), '{"error":"PRO_REQUIRED"}');
    assert.equal(snap.bodySnippet, '{"error":"PRO_REQUIRED"}');
  });

  it('header lookups are case-insensitive (Headers normalizes — guard against future regression)', () => {
    // Browser fetch returns Headers that are case-insensitive on get();
    // some test doubles aren't. This pin makes a regression on the test
    // double (or a stricter implementation) fail loudly.
    const snap = snapshotUpstreamResponse(
      makeResp({ 'CF-RAY': 'mixed-case-id', Server: 'Cloudflare' }),
      '',
    );
    assert.equal(snap.cfRay, 'mixed-case-id');
    assert.equal(snap.server, 'Cloudflare');
  });
});
