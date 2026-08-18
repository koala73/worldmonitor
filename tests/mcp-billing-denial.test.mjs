// Unit tests for api/mcp/billing-denial.ts — the typed propagation layer that
// keeps gateway billing denials from flattening into generic -32603 errors.
// Locks the allowlist boundary (unknown marker values must NOT become typed
// denials) and the structural-Response tolerances the module documents.
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  assertToolFetchOk,
  BillingDenialError,
  RpcValidationError,
  throwIfBillingDenial,
} from '../api/mcp/billing-denial.ts';

function response(status, headerMap = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headerMap[name] ?? null },
  };
}

describe('billing-denial propagation helpers', () => {
  it('does nothing on an OK response, even with a billing header present', async () => {
    const res = response(200, { 'X-Billing-Verification': 'subscription_lapsed' });
    throwIfBillingDenial(res, 'tool');
    await assertToolFetchOk(res, 'tool');
  });

  it('throws a typed denial carrying status, code, and Retry-After', () => {
    const res = response(503, {
      'X-Billing-Verification': 'renewal_verification_pending',
      'Retry-After': '21',
    });
    assert.throws(
      () => throwIfBillingDenial(res, 'tool'),
      (err) =>
        err instanceof BillingDenialError &&
        err.status === 503 &&
        err.billingCode === 'renewal_verification_pending' &&
        err.retryAfterSeconds === 21 &&
        /tool HTTP 503/.test(err.message),
    );
  });

  it('an UNKNOWN marker value falls through to the generic Error, never a typed denial', async () => {
    const res = response(503, { 'X-Billing-Verification': 'grant_everything' });
    throwIfBillingDenial(res, 'tool');
    await assert.rejects(
      () => assertToolFetchOk(res, 'tool'),
      (err) => !(err instanceof BillingDenialError) && err.message === 'tool HTTP 503',
    );
  });

  it('entitlement_verification_unavailable throws a typed retryable denial', () => {
    // env_key/user_key tool fetches sign with X-WorldMonitor-Key (api/mcp/auth.ts
    // buildAuthHeaders), so the gateway's backend-unreachable 503 reaches this
    // layer and must keep its billing contract instead of flattening into the
    // generic -32603 at HTTP 200.
    const res = response(503, {
      'X-Billing-Verification': 'entitlement_verification_unavailable',
      'Retry-After': '5',
    });
    assert.throws(
      () => throwIfBillingDenial(res, 'tool'),
      (err) =>
        err instanceof BillingDenialError &&
        err.status === 503 &&
        err.billingCode === 'entitlement_verification_unavailable' &&
        err.retryAfterSeconds === 5,
    );
  });

  it('tolerates test doubles without a headers object', async () => {
    const bare = { ok: false, status: 503 };
    throwIfBillingDenial(bare, 'tool');
    await assert.rejects(
      () => assertToolFetchOk(bare, 'tool'),
      (err) => !(err instanceof BillingDenialError) && err.message === 'tool HTTP 503',
    );
  });

  it('missing Retry-After yields undefined, not 0', () => {
    const res = response(403, { 'X-Billing-Verification': 'subscription_lapsed' });
    assert.throws(
      () => throwIfBillingDenial(res, 'tool'),
      (err) => err instanceof BillingDenialError && err.retryAfterSeconds === undefined,
    );
  });

  it('a non-numeric Retry-After yields undefined', () => {
    const res = response(503, {
      'X-Billing-Verification': 'renewal_verification_failed',
      'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT',
    });
    assert.throws(
      () => throwIfBillingDenial(res, 'tool'),
      (err) => err instanceof BillingDenialError && err.retryAfterSeconds === undefined,
    );
  });
});

function jsonResponse(status, body, headers = { 'Content-Type': 'application/json' }) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers,
  });
}

describe('assertToolFetchOk RPC validation 400s', () => {
  it('throws RpcValidationError with bounded field/detail pairs from a proto 400', async () => {
    const res = jsonResponse(400, {
      violations: [{ field: 'countryCode', description: 'countryCode is required' }],
      password: 'should-not-leak',
    });
    await assert.rejects(
      () => assertToolFetchOk(res, 'get-food-stocks'),
      (err) =>
        err instanceof RpcValidationError
        && err.status === 400
        && err.operation === 'get-food-stocks'
        && err.message === 'get-food-stocks HTTP 400'
        && err.violations.length === 1
        && err.violations[0].field === 'countryCode'
        && err.violations[0].description === 'countryCode is required'
        && !JSON.stringify(err).includes('should-not-leak')
        && !('password' in err),
    );
  });

  it('caps the violation list and description length', async () => {
    const res = jsonResponse(400, {
      violations: Array.from({ length: 12 }, (_, i) => ({
        field: `field${i}`,
        description: 'x'.repeat(250),
      })),
    });
    try {
      await assertToolFetchOk(res, 'tool');
      assert.fail('expected RpcValidationError');
    } catch (err) {
      assert.ok(err instanceof RpcValidationError);
      assert.equal(err.violations.length, 8);
      assert.equal(err.violations[0].description.length, 200);
    }
  });

  it('an oversized 400 body does not leak the unread tail', async () => {
    const secret = 'wm_live_oversize_secret';
    const prefix = '{"violations":[';
    const tail = `{"field":"tail_field","description":"${secret}"}]}`;
    // Secret must start after the 16 KB read budget so a full-body parse
    // would surface it as a sanitized violation, while truncation cannot.
    const pad = 16384 - prefix.length + 1;
    const res = jsonResponse(400, `${prefix}${' '.repeat(pad)}${tail}`);
    await assert.rejects(
      () => assertToolFetchOk(res, 'tool'),
      (err) =>
        !(err instanceof RpcValidationError)
        && err.message === 'tool HTTP 400'
        && !String(err).includes(secret)
        && !String(err).includes('tail_field'),
    );
  });

  it('does not leak malformed, HTML, or credential-like 400 bodies', async () => {
    const cases = [
      jsonResponse(400, '{not json', { 'Content-Type': 'application/json' }),
      jsonResponse(400, '<html><body>password=supersecret</body></html>', { 'Content-Type': 'text/html' }),
      jsonResponse(400, {
        violations: [{ field: 'countryCode', description: 'Authorization: Bearer leaked-token' }],
      }),
      jsonResponse(400, {
        violations: [{ field: '<script>', description: 'countryCode is required' }],
      }),
    ];
    for (const res of cases) {
      await assert.rejects(
        () => assertToolFetchOk(res, 'tool'),
        (err) =>
          !(err instanceof RpcValidationError)
          && err.message === 'tool HTTP 400'
          && !String(err).includes('supersecret')
          && !String(err).includes('leaked-token')
          && !String(err).includes('<script>')
          && !String(err).includes('<html>'),
      );
    }
  });

  it('non-validation HTTP errors stay generic Errors', async () => {
    await assert.rejects(
      () => assertToolFetchOk(jsonResponse(500, { message: 'boom' }), 'tool'),
      (err) => !(err instanceof RpcValidationError) && err.message === 'tool HTTP 500',
    );
    await assert.rejects(
      () => assertToolFetchOk(jsonResponse(404, { violations: [{ field: 'x', description: 'no' }] }), 'tool'),
      (err) => !(err instanceof RpcValidationError) && err.message === 'tool HTTP 404',
    );
  });

  it('billing denials still win over a 400 body', async () => {
    const res = new Response(
      JSON.stringify({ violations: [{ field: 'countryCode', description: 'countryCode is required' }] }),
      {
        status: 400,
        headers: {
          'Content-Type': 'application/json',
          'X-Billing-Verification': 'subscription_lapsed',
        },
      },
    );
    await assert.rejects(
      () => assertToolFetchOk(res, 'tool'),
      (err) => err instanceof BillingDenialError && err.billingCode === 'subscription_lapsed',
    );
  });
});
