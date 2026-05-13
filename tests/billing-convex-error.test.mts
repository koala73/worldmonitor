import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractBillingErrorKind } from '../src/services/_billing-error.ts';

// ---------------------------------------------------------------------------
// extractBillingErrorKind — structured-error introspection for the
// Convex action `payments/billing:getCustomerPortalUrl`.
//
// WORLDMONITOR-R5 surfaced as `ConvexError: [Request ID: X] Server Error`
// because the action threw plain `Error("No Dodo customer found for this
// user")`. Convex's HTTP runtime only forwards `errorData` for object-typed
// throws, so the client received an opaque message with `err.data ===
// undefined` and reported the event at error level even though the action
// was just signalling an expected "free user with no Dodo customer row" state.
//
// Fix: throw `new ConvexError({ kind: 'NO_CUSTOMER' })` on the server,
// read `err.data.kind` on the client to downgrade the Sentry capture.
// ---------------------------------------------------------------------------

describe('extractBillingErrorKind — structured-data path', () => {
  it('reads NO_CUSTOMER from err.data.kind', () => {
    const err = Object.assign(new Error('any message'), {
      data: { kind: 'NO_CUSTOMER' },
    });
    assert.equal(extractBillingErrorKind(err), 'NO_CUSTOMER');
  });

  it('reads DODO_API_KEY_MISSING from err.data.kind', () => {
    const err = Object.assign(new Error('any message'), {
      data: { kind: 'DODO_API_KEY_MISSING' },
    });
    assert.equal(extractBillingErrorKind(err), 'DODO_API_KEY_MISSING');
  });

  it('reads USER_ID_REQUIRED from err.data.kind', () => {
    const err = Object.assign(new Error(''), {
      data: { kind: 'USER_ID_REQUIRED' },
    });
    assert.equal(extractBillingErrorKind(err), 'USER_ID_REQUIRED');
  });

  it('returns null when err.data.kind is non-string', () => {
    const err = Object.assign(new Error(''), { data: { kind: 42 } });
    assert.equal(extractBillingErrorKind(err), null);
  });

  it('returns null when err.data lacks a kind field', () => {
    const err = Object.assign(new Error(''), { data: { other: 'x' } });
    assert.equal(extractBillingErrorKind(err), null);
  });
});

describe('extractBillingErrorKind — legacy substring fallback', () => {
  it('classifies the pre-fix "No Dodo customer found" message as NO_CUSTOMER', () => {
    // Deploy-ordering window: if the browser is updated but the Convex
    // action still ships the plain-Error throw, the catch path should
    // still bucket the event correctly.
    const err = new Error('No Dodo customer found for this user');
    assert.equal(extractBillingErrorKind(err), 'NO_CUSTOMER');
  });

  it('does NOT classify a generic "[Request ID: X] Server Error" (the pre-fix bug)', () => {
    // This is the EXACT symptom the structured-throw fix exists to address:
    // Convex's `[Request ID: X] Server Error` wrapper used to bypass any
    // substring-classification path. Confirm null so the caller defaults
    // to error-level Sentry capture for unknown shapes.
    const err = new Error('[Request ID: 6d59ef5d8b4c46cc] Server Error');
    assert.equal(extractBillingErrorKind(err), null);
  });

  it('structured-data path wins when both data.kind and matching message exist (forward-compat)', () => {
    // If a future ConvexError both sets a structured kind AND its message
    // happens to contain the legacy substring, structured wins.
    const err = Object.assign(new Error('No Dodo customer found for this user'), {
      data: { kind: 'DODO_API_KEY_MISSING' },
    });
    assert.equal(extractBillingErrorKind(err), 'DODO_API_KEY_MISSING');
  });
});

describe('extractBillingErrorKind — null returns for shapes we never produce', () => {
  it('returns null for a plain non-Error value', () => {
    assert.equal(extractBillingErrorKind('plain string'), null);
    assert.equal(extractBillingErrorKind(undefined), null);
    assert.equal(extractBillingErrorKind(null), null);
    assert.equal(extractBillingErrorKind(42), null);
  });

  it('returns null for an Error without data and unrelated message', () => {
    assert.equal(extractBillingErrorKind(new Error('network timeout')), null);
  });
});
