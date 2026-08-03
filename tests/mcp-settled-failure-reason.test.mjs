import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { summarizeSettledFailure } from '../api/mcp/settled-failure-reason.ts';

describe('summarizeSettledFailure', () => {
  it('returns ok for fulfilled results', () => {
    assert.equal(summarizeSettledFailure({ status: 'fulfilled', value: null }), 'ok');
  });

  it('names TimeoutError and AbortError without the message', () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), {
      name: 'TimeoutError',
    });
    const abort = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    assert.equal(summarizeSettledFailure({ status: 'rejected', reason: timeout }), 'TimeoutError');
    assert.equal(summarizeSettledFailure({ status: 'rejected', reason: abort }), 'AbortError');
  });

  it('keeps HTTP status messages short', () => {
    assert.equal(
      summarizeSettledFailure({ status: 'rejected', reason: new Error('HTTP 502') }),
      'HTTP 502',
    );
  });

  it('includes Error name and message for other failures', () => {
    const err = Object.assign(new Error('auth failed'), { name: 'TypeError' });
    assert.equal(
      summarizeSettledFailure({ status: 'rejected', reason: err }),
      'TypeError: auth failed',
    );
  });

  it('handles null and non-Error rejections', () => {
    assert.equal(summarizeSettledFailure({ status: 'rejected', reason: null }), 'unknown');
    assert.equal(summarizeSettledFailure({ status: 'rejected', reason: 'boom' }), 'boom');
  });
});
