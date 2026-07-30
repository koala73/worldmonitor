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

import {
  parseCheckoutErrorBody,
  snapshotUpstreamResponse,
} from '../src/services/checkout-errors.ts';

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

// parseCheckoutErrorBody hardens the implicit "body is a CheckoutErrorBody"
// contract at runtime: only plain-object JSON is accepted. Returning {}
// for null / arrays / primitives / malformed JSON means a future consumer
// writing e.g. `body.message.toLowerCase()` can't crash because the server
// returned `null` or `[]`. Greptile P2 review of PR #3894.
describe('parseCheckoutErrorBody', () => {
  it('returns the parsed object for valid object JSON', () => {
    const body = parseCheckoutErrorBody('{"error":"ACTIVE_SUBSCRIPTION_EXISTS","message":"x"}');
    assert.deepEqual(body, { error: 'ACTIVE_SUBSCRIPTION_EXISTS', message: 'x' });
  });

  it('returns {} for empty string (avoids JSON.parse SyntaxError on no-body responses)', () => {
    assert.deepEqual(parseCheckoutErrorBody(''), {});
  });

  it('returns {} for HTML body (CF / Vercel 403 page — JSON.parse throws)', () => {
    assert.deepEqual(parseCheckoutErrorBody('<!DOCTYPE html><html>blocked</html>'), {});
  });

  it('returns {} for JSON literal null (would otherwise null-poison the cast)', () => {
    // Critical: JSON.parse("null") returns null, which IS a valid JSON
    // value but is NOT a plain object. Without the guard, body=null
    // would crash any consumer not using optional chaining.
    assert.deepEqual(parseCheckoutErrorBody('null'), {});
  });

  it('returns {} for JSON array (structurally not a CheckoutErrorBody)', () => {
    // Arrays are typeof 'object' AND non-null, so the typeof+null check
    // alone wouldn't reject them. Array.isArray() is the discriminator.
    assert.deepEqual(parseCheckoutErrorBody('[]'), {});
    assert.deepEqual(parseCheckoutErrorBody('[{"error":"X"}]'), {});
  });

  it('returns {} for JSON primitives (numbers, booleans, strings)', () => {
    assert.deepEqual(parseCheckoutErrorBody('42'), {});
    assert.deepEqual(parseCheckoutErrorBody('true'), {});
    assert.deepEqual(parseCheckoutErrorBody('"plain string"'), {});
  });

  it('returns {} for malformed JSON (incomplete brace, trailing garbage)', () => {
    assert.deepEqual(parseCheckoutErrorBody('{not valid'), {});
    assert.deepEqual(parseCheckoutErrorBody('{"error":"x"} trailing'), {});
  });

  it('preserves nested fields downstream callers use (e.g. duplicate_subscription path)', () => {
    // The 409 duplicate-subscription branch in checkout.ts reads
    // body.subscription.planKey via optional chaining. Lock in that a
    // realistic body shape passes through unchanged.
    const body = parseCheckoutErrorBody(
      '{"error":"ACTIVE_SUBSCRIPTION_EXISTS","subscription":{"planKey":"pro_monthly"}}',
    );
    assert.equal(body.error, 'ACTIVE_SUBSCRIPTION_EXISTS');
    assert.equal(
      (body as { subscription?: { planKey?: string } }).subscription?.planKey,
      'pro_monthly',
    );
  });
});
