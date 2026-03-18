import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isTransientRedisError } from '../scripts/_seed-utils.mjs';

describe('seed utils redis error handling', () => {
  it('treats undici connect timeout as transient', () => {
    const err = new TypeError('fetch failed');
    err.cause = new Error('Connect Timeout Error');
    err.cause.code = 'UND_ERR_CONNECT_TIMEOUT';

    assert.equal(isTransientRedisError(err), true);
  });

  it('treats ECONNRESET as transient', () => {
    const err = new Error('fetch failed');
    err.cause = new Error('read ECONNRESET');
    err.cause.code = 'ECONNRESET';
    assert.equal(isTransientRedisError(err), true);
  });

  it('treats DNS lookup failure as transient', () => {
    const err = new Error('fetch failed');
    err.cause = new Error('getaddrinfo EAI_AGAIN redis-host');
    err.cause.code = 'EAI_AGAIN';
    assert.equal(isTransientRedisError(err), true);
  });

  it('treats ETIMEDOUT as transient', () => {
    const err = new Error('fetch failed');
    err.cause = new Error('connect ETIMEDOUT');
    err.cause.code = 'ETIMEDOUT';
    assert.equal(isTransientRedisError(err), true);
  });

  it('does not treat Redis HTTP 403 as transient', () => {
    const err = new Error('Redis command failed: HTTP 403');
    assert.equal(isTransientRedisError(err), false);
  });

  it('does not treat generic validation errors as transient', () => {
    const err = new Error('validation failed');
    assert.equal(isTransientRedisError(err), false);
  });

  it('does not treat payload size errors as transient', () => {
    const err = new Error('Payload too large: 6.2MB > 5MB limit');
    assert.equal(isTransientRedisError(err), false);
  });
});
