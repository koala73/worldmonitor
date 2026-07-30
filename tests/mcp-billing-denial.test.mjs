// Unit tests for api/mcp/billing-denial.ts — the typed propagation layer that
// keeps gateway billing denials from flattening into generic -32603 errors.
// Locks the allowlist boundary (unknown marker values must NOT become typed
// denials) and the structural-Response tolerances the module documents.
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  assertToolFetchOk,
  BillingDenialError,
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
  it('does nothing on an OK response, even with a billing header present', () => {
    const res = response(200, { 'X-Billing-Verification': 'subscription_lapsed' });
    throwIfBillingDenial(res, 'tool');
    assertToolFetchOk(res, 'tool');
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

  it('an UNKNOWN marker value falls through to the generic Error, never a typed denial', () => {
    const res = response(503, { 'X-Billing-Verification': 'grant_everything' });
    throwIfBillingDenial(res, 'tool');
    assert.throws(
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

  it('tolerates test doubles without a headers object', () => {
    const bare = { ok: false, status: 503 };
    throwIfBillingDenial(bare, 'tool');
    assert.throws(
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
