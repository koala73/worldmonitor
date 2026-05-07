/**
 * Locks the user-facing copy + retryability + code mapping for the
 * client-side checkout error taxonomy. A change to any user-facing
 * message should fail this test — the copy lives in one place for a
 * reason and must not drift.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyHttpCheckoutError,
  classifySyntheticCheckoutError,
  classifyThrownCheckoutError,
} from '../src/services/checkout-errors.ts';

describe('classifyHttpCheckoutError', () => {
  it('maps 401 to unauthorized', () => {
    const err = classifyHttpCheckoutError(401);
    assert.equal(err.code, 'unauthorized');
    assert.equal(err.retryable, true);
    assert.equal(err.httpStatus, 401);
  });

  it('maps 409 with ACTIVE_SUBSCRIPTION_EXISTS to duplicate_subscription', () => {
    const err = classifyHttpCheckoutError(409, {
      error: 'ACTIVE_SUBSCRIPTION_EXISTS',
      message: 'Active Pro Monthly sub exists for user X',
    });
    assert.equal(err.code, 'duplicate_subscription');
    assert.equal(err.retryable, false);
  });

  it('maps 409 without known error code to invalid_product (4xx)', () => {
    const err = classifyHttpCheckoutError(409, { error: 'SOMETHING_ELSE' });
    assert.equal(err.code, 'invalid_product');
  });

  it('maps 400 to invalid_product', () => {
    const err = classifyHttpCheckoutError(400);
    assert.equal(err.code, 'invalid_product');
    assert.equal(err.retryable, false);
  });

  it('maps 404 to invalid_product', () => {
    const err = classifyHttpCheckoutError(404);
    assert.equal(err.code, 'invalid_product');
  });

  it('maps 500 to service_unavailable', () => {
    const err = classifyHttpCheckoutError(500);
    assert.equal(err.code, 'service_unavailable');
    assert.equal(err.retryable, true);
  });

  it('maps 503 to service_unavailable', () => {
    const err = classifyHttpCheckoutError(503);
    assert.equal(err.code, 'service_unavailable');
  });

  it('maps 502 to service_unavailable', () => {
    const err = classifyHttpCheckoutError(502);
    assert.equal(err.code, 'service_unavailable');
  });

  it('maps unexpected status (e.g. 302) to unknown', () => {
    const err = classifyHttpCheckoutError(302);
    assert.equal(err.code, 'unknown');
  });

  it('preserves serverMessage from body.message when present', () => {
    const err = classifyHttpCheckoutError(500, {
      message: 'Internal relay failure: convex action timeout at node-3',
    });
    assert.equal(err.serverMessage, 'Internal relay failure: convex action timeout at node-3');
    // User never sees the server string.
    assert.notEqual(err.userMessage, err.serverMessage);
    assert.equal(err.userMessage, 'Checkout is temporarily unavailable. Please try again in a moment.');
  });

  it('falls back to body.error when body.message is absent', () => {
    const err = classifyHttpCheckoutError(400, { error: 'INVALID_PRODUCT_ID' });
    assert.equal(err.serverMessage, 'INVALID_PRODUCT_ID');
  });

  it('leaves serverMessage undefined when body is empty', () => {
    const err = classifyHttpCheckoutError(500);
    assert.equal(err.serverMessage, undefined);
  });

  it('never exposes raw server text in userMessage', () => {
    const err = classifyHttpCheckoutError(500, {
      message: 'leaked-internal-id-42: db.prod-us-east-1 connection refused',
    });
    assert.ok(!err.userMessage.includes('leaked'));
    assert.ok(!err.userMessage.includes('db.prod'));
  });
});

describe('classifyThrownCheckoutError', () => {
  it('classifies network errors as service_unavailable', () => {
    const err = classifyThrownCheckoutError(new TypeError('Failed to fetch'));
    assert.equal(err.code, 'service_unavailable');
    assert.equal(err.retryable, true);
    assert.equal(err.serverMessage, 'Failed to fetch');
  });

  it('classifies AbortError (timeout) as service_unavailable', () => {
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    const err = classifyThrownCheckoutError(abort);
    assert.equal(err.code, 'service_unavailable');
  });

  it('handles non-Error throws by coercing to string', () => {
    const err = classifyThrownCheckoutError('string thrown directly');
    assert.equal(err.code, 'service_unavailable');
    assert.equal(err.serverMessage, 'string thrown directly');
  });

  it('handles null/undefined caught values', () => {
    const err = classifyThrownCheckoutError(undefined);
    assert.equal(err.code, 'service_unavailable');
  });
});

describe('classifySyntheticCheckoutError', () => {
  it('maps unauthorized to retryable unauthorized code', () => {
    const err = classifySyntheticCheckoutError('unauthorized');
    assert.equal(err.code, 'unauthorized');
    assert.equal(err.retryable, true);
    assert.equal(err.userMessage, 'Please sign in to continue your purchase.');
  });

  it('maps session_expired to retryable session_expired code', () => {
    const err = classifySyntheticCheckoutError('session_expired');
    assert.equal(err.code, 'session_expired');
    assert.equal(err.retryable, true);
  });

  it('does not include serverMessage for synthetic errors (no server involved)', () => {
    const err = classifySyntheticCheckoutError('unauthorized');
    assert.equal(err.serverMessage, undefined);
  });
});

describe('user copy invariants', () => {
  it('user copy is non-empty for every code', () => {
    const codes = [401, 409, 400, 500, 503, 302] as const;
    for (const status of codes) {
      const err = classifyHttpCheckoutError(status);
      assert.ok(err.userMessage.length > 0, `user message should not be empty for ${status}`);
    }
  });

  it('user copy never contains raw server-generated artifacts', () => {
    // Pass a server message laden with artifacts we'd never want the
    // user to see; assert the userMessage stays clean regardless.
    const hostile = 'Error: stack trace\n    at foo.js:10\n    at bar.js:42\n  at DB.query(prod-us-east-1)';
    const codes = [401, 409, 400, 500, 503] as const;
    for (const status of codes) {
      const err = classifyHttpCheckoutError(status, { message: hostile });
      // Node/Chrome stack-frame pattern (4 spaces + "at " + identifier).
      assert.ok(!/\s{2,}at\s/.test(err.userMessage), `user copy must not include stack frames`);
      assert.ok(!err.userMessage.includes('Error:'), `user copy must not include raw Error: prefix`);
      assert.ok(!err.userMessage.includes('prod-us-east-1'), `user copy must not include infra identifiers`);
      assert.ok(!err.userMessage.includes(hostile), `user copy must not include the raw server message`);
    }
  });
});
