/**
 * Locks the 200-response contract on POST /api/create-checkout.
 *
 * Regression scope: WORLDMONITOR-XV — a Safari client got HTTP 200 whose
 * body was not valid JSON. The success path ran a bare `await resp.json()`,
 * so the parse threw a raw browser DOMException
 * (`SyntaxError: The string did not match the expected pattern.`, code 12)
 * that escaped past the deliberately-built "200 without a usable
 * checkout_url" contract-violation reporter into the generic catch. Three
 * consequences, all of which these tests pin shut:
 *
 *   1. No upstream snapshot was captured, so there is zero evidence of what
 *      the 200 body actually was (HTML interstitial? empty? truncated?) —
 *      the exact blindness the `!resp.ok` branch already fixed for 403s
 *      (WORLDMONITOR-RN).
 *   2. The reported message is engine-specific, so one bug fragments across
 *      a Sentry fingerprint per browser (Safari / Chrome / Firefox each
 *      phrase a JSON parse failure differently).
 *   3. Extending the snapshot to the 200 path introduces exposure the error
 *      path never had: a success body carries `anonymous_claim_token`, a
 *      credential persisted to localStorage as claim proof for migrating
 *      protected payment rows. It must never reach Sentry.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  parseCheckoutSuccessBody,
  snapshotUpstreamBodyKeys,
  snapshotUpstreamResponse,
} from '../src/services/checkout-errors.ts';

function makeResp(headers: Record<string, string> = {}): { headers: Headers } {
  return { headers: new Headers(headers) };
}

describe('parseCheckoutSuccessBody', () => {
  it('returns the parsed object for a well-formed success body', () => {
    const outcome = parseCheckoutSuccessBody('{"checkout_url":"https://checkout.dodopayments.com/s/abc"}');
    assert.equal(outcome.kind, 'object');
    assert.equal(
      outcome.kind === 'object' ? outcome.body.checkout_url : undefined,
      'https://checkout.dodopayments.com/s/abc',
    );
  });

  it('reports an empty 200 body as empty, not as malformed JSON', () => {
    // A bare resp.json() on this input is what produced the Safari
    // DOMException (WORLDMONITOR-XV). The arm matters because "sent zero
    // bytes" and "sent something unparseable" are different upstream faults.
    assert.equal(parseCheckoutSuccessBody('').kind, 'empty');
  });

  it('reports an HTML body served with 200 as invalid JSON (edge interstitial)', () => {
    assert.equal(
      parseCheckoutSuccessBody('<!DOCTYPE html><html>Attention Required</html>').kind,
      'invalid-json',
    );
  });

  it('reports truncated JSON as invalid JSON (mid-transit cut)', () => {
    assert.equal(parseCheckoutSuccessBody('{"checkout_url":"https://checkout.dod').kind, 'invalid-json');
    assert.equal(parseCheckoutSuccessBody('{').kind, 'invalid-json');
  });

  it('reports valid-but-non-object JSON as non-object, never as non-JSON', () => {
    // Same structural-lie reasoning as parseCheckoutErrorBody: null, arrays
    // and primitives are valid JSON but cannot carry checkout_url. Calling
    // them a "non-JSON body" in Sentry would claim more than was observed.
    for (const raw of ['null', '[]', '[{"checkout_url":"https://x"}]', '42', '"https://checkout.example/s/abc"']) {
      assert.equal(parseCheckoutSuccessBody(raw).kind, 'non-object', `for ${raw}`);
    }
  });

  it('distinguishes an unusable body from parsed-but-missing-checkout_url', () => {
    // Both are contract violations, but they have different upstream
    // causes (transport corruption vs. a relay payload bug) and must not
    // collapse into one disposition.
    assert.equal(parseCheckoutSuccessBody('not json').kind, 'invalid-json');
    const empty = parseCheckoutSuccessBody('{}');
    assert.equal(empty.kind, 'object');
    assert.deepEqual(empty.kind === 'object' ? empty.body : null, {});
  });

  it('preserves anonymous_claim_token so the caller can still persist claim proof', () => {
    const outcome = parseCheckoutSuccessBody(
      '{"checkout_url":"https://checkout.dodopayments.com/s/a","anonymous_claim_token":"tok_live_123"}',
    );
    assert.equal(outcome.kind === 'object' ? outcome.body.anonymous_claim_token : undefined, 'tok_live_123');
  });
});

describe('snapshotUpstreamBodyKeys', () => {
  // The 200 payload is `{ ...dodoSdkResponse, anonymous_claim_token }` — a
  // field set owned by a third party. Capturing values there would be a
  // standing bet that no future SDK field is sensitive, policed only by a
  // deny-list that a schema change outruns silently. Key names carry the
  // whole diagnostic for this path, so values are withheld outright.
  it('captures key names and no values', () => {
    const snap = snapshotUpstreamBodyKeys(makeResp({ 'cf-ray': 'ray-1' }), {
      session_id: 'cks_live_9f2b7c1d4e',
      anonymous_claim_token: 'tok_live_SECRET123',
    });
    assert.deepEqual(snap.bodyKeys, ['anonymous_claim_token', 'session_id']);
    assert.equal(snap.bodySnippet, undefined, 'must never carry a value snippet');
    const serialized = JSON.stringify(snap);
    assert.ok(!serialized.includes('tok_live_SECRET123'));
    assert.ok(!serialized.includes('cks_live_9f2b7c1d4e'), 'session_id value must not ship either');
  });

  it('still names the upstream emitter', () => {
    const snap = snapshotUpstreamBodyKeys(makeResp({ 'cf-ray': 'ray-1', server: 'Vercel' }), {});
    assert.equal(snap.cfRay, 'ray-1');
    assert.equal(snap.server, 'Vercel');
    assert.deepEqual(snap.bodyKeys, []);
  });

  it('sorts keys so the Sentry signature is stable across payload orderings', () => {
    const a = snapshotUpstreamBodyKeys(makeResp(), { b: 1, a: 2 });
    const b = snapshotUpstreamBodyKeys(makeResp(), { a: 2, b: 1 });
    assert.deepEqual(a.bodyKeys, b.bodyKeys);
  });
});

describe('snapshotUpstreamResponse — credential redaction', () => {
  it('redacts anonymous_claim_token so claim proof never reaches Sentry', () => {
    const snap = snapshotUpstreamResponse(
      makeResp(),
      '{"checkout_url":null,"anonymous_claim_token":"tok_live_SECRET123"}',
    );
    assert.ok(snap.bodySnippet, 'expected a body snippet');
    assert.ok(!snap.bodySnippet?.includes('tok_live_SECRET123'), 'token value leaked into snippet');
    assert.ok(snap.bodySnippet?.includes('[redacted]'), 'expected an explicit redaction marker');
    // The key must survive: knowing the field was present is diagnostic.
    assert.ok(snap.bodySnippet?.includes('anonymous_claim_token'));
  });

  it('redacts before truncating, so a token past the 200-char cap cannot leak', () => {
    // Order matters: truncate-then-redact would emit the first 200 chars
    // verbatim, and a token sitting at offset 40 would ship in full.
    const body = `{"anonymous_claim_token":"tok_live_SECRET123","pad":"${'x'.repeat(500)}"}`;
    const snap = snapshotUpstreamResponse(makeResp(), body);
    assert.ok(!snap.bodySnippet?.includes('tok_live_SECRET123'));
    assert.equal(snap.bodySnippet?.length, 200);
  });

  it('redacts a truncated (unterminated) token string', () => {
    // A body cut mid-token still exposes the prefix, which is enough to
    // matter for a bearer-like credential.
    const snap = snapshotUpstreamResponse(makeResp(), '{"anonymous_claim_token":"tok_live_SECRET');
    assert.ok(!snap.bodySnippet?.includes('tok_live_SECRET'));
    assert.ok(snap.bodySnippet?.includes('[redacted]'));
  });

  it('tolerates whitespace around the JSON separator', () => {
    const snap = snapshotUpstreamResponse(makeResp(), '{"anonymous_claim_token"  :  "tok_live_SECRET"}');
    assert.ok(!snap.bodySnippet?.includes('tok_live_SECRET'));
  });

  it('leaves ordinary error bodies untouched (no regression to the RN diagnostic)', () => {
    // The !resp.ok path relies on seeing the real body; redaction must be
    // a no-op for anything that carries no claim token.
    const snap = snapshotUpstreamResponse(makeResp(), '{"error":"PRO_REQUIRED"}');
    assert.equal(snap.bodySnippet, '{"error":"PRO_REQUIRED"}');
    const html = snapshotUpstreamResponse(makeResp(), '<!DOCTYPE html><html>blocked</html>');
    assert.equal(html.bodySnippet, '<!DOCTYPE html><html>blocked</html>');
  });
});

describe('checkout.ts call-site pin', () => {
  // Count pin ONLY — the behavioural contract lives in the pure helpers
  // above. This exists solely to catch a future refactor reintroducing an
  // unguarded body read on this response, which no unit test of the
  // helpers can see.
  //
  // Deliberately anchored on `await resp.json(` rather than `resp.json(`:
  // both this file and the !ok branch discuss `resp.json()` in prose, and
  // a bare pattern counts those comments as violations. The awaited form
  // is the exact shape of the defect and does not appear in any comment.
  const source = readFileSync(
    fileURLToPath(new URL('../src/services/checkout.ts', import.meta.url)),
    'utf8',
  );

  it('never awaits resp.json() on the create-checkout response', () => {
    const matches = source.match(/await\s+resp\.json\s*\(/g) ?? [];
    assert.equal(
      matches.length,
      0,
      'awaiting resp.json() throws an engine-specific DOMException on a non-JSON 200 (WORLDMONITOR-XV) — read text() and parse defensively',
    );
  });

  it('reads both response bodies as text so upstream snapshots can be captured', () => {
    const matches = source.match(/await\s+resp\.text\s*\(/g) ?? [];
    assert.equal(matches.length, 2, 'expected one resp.text() on the !ok path and one on the success path');
  });
});
