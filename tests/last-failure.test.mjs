import assert from 'node:assert/strict';
import test from 'node:test';
import { retainLastFailure } from '../scripts/_last-failure.mjs';

const failure = { checkedAt: '2026-10-25T02:45:28.446Z',
  lastSuccessAt: '2026-10-25T02:20:06.220Z', errorCode: 'TIMEOUT', requestCount: 2 };

test('retained failure is bounded and revalidates stored fields', () => {
  const polluted = { ...failure, body: 'secret', url: 'https://user:secret@host',
    fallbackReason: 'https://user:secret@host', proxyFailureReason: 'x'.repeat(1000),
    transportPath: 'secret', requestBudget: { page: 2, directRequests: 1,
      proxyRequests: -1, maxRequests: Infinity, maxDirectRequests: 1.5,
      maxProxyRequests: Number.MAX_SAFE_INTEGER + 1, token: 'secret' } };
  const receipt = retainLastFailure(polluted);
  assert.deepEqual(receipt, { ...failure, requestBudget: { page: 2, directRequests: 1 } });
  assert.doesNotMatch(JSON.stringify(receipt), /secret|https|token/);
});

test('missing and invalid receipts cannot invent a failure', () => {
  for (const value of [undefined, null, {}, { ...failure, checkedAt: 'bad' },
    { ...failure, errorCode: 'https://secret' }, { ...failure, checkedAt: -1 }]) {
    assert.equal(retainLastFailure(value), null);
  }
  assert.equal(retainLastFailure({ ...failure, lastSuccessAt: '2026-10-26T00:00:00Z' }).lastSuccessAt, null);
});

test('new failures replace older ones without mutating either input', () => {
  const newer = { ...failure, checkedAt: '2026-10-25T03:00:00.000Z', errorCode: 'HTTP_407' };
  assert.deepEqual(retainLastFailure(Object.freeze(failure), Object.freeze(newer)), newer);
  assert.deepEqual(retainLastFailure(newer, failure), newer);
  assert.deepEqual(retainLastFailure(failure), failure);
});
